// Interactive Brokers Flex Query（唯讀報表服務）串接。
// 只會「讀取」你的持倉與現金，完全不涉及任何下單/轉帳權限。
//
// 設定方式（在 IB Client Portal 內）：
//   Performance & Reports → Flex Queries → 建立一個 "Activity Flex Query"，勾選六個區塊：
//   Open Positions（持倉）、Cash Report（各幣別現金）、Trades（成交，交易摘要/XIRR）、
//   Cash Transactions（股息/利息現金流）、Net Asset Value (NAV) in Base（官方淨值，槓桿/斷頭距離）、
//   Account Information（至少勾 Currency 欄＝帳戶基準幣別——報表現金只有彙總列時靠它判定入帳幣別，Codex r7#1）。
//   格式 XML、期間建議 Last 365 Calendar Days。
//   再到 Settings → 取得 Flex Web Service Token。
//   把 Token 與 Query ID 填到網頁的「設定 → IBKR Flex Query 連線」。
import { XMLParser } from 'fast-xml-parser';
import { assertXmlSize, assertRowLimit, assertXmlRowLimits, readCappedText, assertXmlElementLimit } from './parse-limits.js';

const BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

async function getText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'rxs-finance/0.1' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`IB 連線失敗 (HTTP ${res.status})`);
    // ⚠️ **不可以用 `await res.text()`**（2026-07-28 修）：那會把「任意大小」的回應先整包放進
    // 記憶體，之後 assertXmlSize 才有機會看到它——檢查得太晚（實測 1GB 回應會讓 RSS 衝到 1.8GB，
    // 而且丟出來的是 V8 的字串長度上限錯誤，沒有 status、沒有可讀原因）。細節見 readCappedText。
    // 這條路 **sendRequest 與 getStatement 共用**，所以第一步的回應也一併有了上限（以前完全沒檢查）。
    return await readCappedText(res, ctrl);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('IB 連線逾時，請稍後再試', { cause: e });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 第一步：送出請求，拿到 reference code
async function sendRequest(token, queryId) {
  const xml = await getText(`${BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`);
  const j = parser.parse(xml);
  const r = j.FlexStatementResponse || {};
  if (r.Status !== 'Success') {
    throw new Error(`IB 拒絕請求：${r.ErrorMessage || r.ErrorCode || '未知錯誤（請檢查 Token 與 Query ID）'}`);
  }
  return { code: r.ReferenceCode, url: r.Url || `${BASE}/GetStatement` };
}

// 第二步：用 reference code 取回報表（可能需要重試，IB 在準備資料）
async function getStatement(token, code, url) {
  for (let i = 0; i < 15; i++) {   // 年度報表產生較慢，最多等 ~45 秒
    const xml = await getText(`${url}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(code)}&v=3`);
    // 解析器資源上限（2026-07-28）：**擋在 parse 之前**才有意義——XML 展開成物件通常是原文的數倍大，
    // 等 parser.parse 跑完再檢查，記憶體早就吃光了。
    assertXmlSize(xml);
    // 列數也要**擋在 parse 之前**（2026-07-28 修）：fast-xml-parser 沒有串流模式，
    // 等它把整份展開成 JS object 再數陣列長度，記憶體早就吃下去了（實測 38.5MB XML → RSS 491MB）。
    // 而且原本只數 CashTransaction／Trade，**OpenPosition 完全沒數**。
    assertXmlRowLimits(xml);
    // ⚠️ **不分標籤的總量牆**（2026-07-28，Codex 收官審查 #1）：上面那道只數四種標籤，
    //    IB 官方還有 CorporateAction／Transfer／InterestAccrual 等十幾種區段完全不受約束
    //    （實測 50,001 筆 `<CorporateAction/>` 原封不動通過）。這一道數的是**元素總數**，
    //    所以任何未來新增的區段自動被涵蓋，不必再維護白名單。
    assertXmlElementLimit(xml);
    const j = parser.parse(xml);
    // 還在產生中會回 FlexStatementResponse + Warn
    if (j.FlexStatementResponse) {
      const r = j.FlexStatementResponse;
      // ⚠️ 一律先 String()：fast-xml-parser 預設會把 `<ErrorCode>1019</ErrorCode>` 解析成
      //    **數字** 1019，`1019 !== '1019'` 恆真 ⇒ 白名單失效 ⇒ 「報表還在產生中」被當成
      //    硬錯誤立刻失敗（訊息還寫著 in progress），重試整段變成打不到的死碼。
      //    2026-08-05 補考題時實地打出來的真 bug（夜班突變體檢查不出——它只驗「弄壞會不會紅」）。
      if (r.ErrorCode && String(r.ErrorCode) !== '1019') {
        throw new Error(`IB 取得報表失敗：${r.ErrorMessage || r.ErrorCode}`);
      }
      await new Promise(s => setTimeout(s, 3000)); // 等 IB 準備好
      continue;
    }
    return j; // FlexQueryResponse
  }
  throw new Error('IB 報表準備逾時，請稍後再試');
}

// fxToBase(cur) → 該幣別兌基準幣別（USD）的匯率，缺則回 null（僅估算現金流缺 IBKR 匯率時用）。
// 預設不估算（回 null），保持既有純解析行為；server.js 會依 settings 傳入估算器。
export function parseStatement(j, fxToBase = () => null) {   // export 供考題直測旗標語意（hasCashReport/hasCashDetail）
  const stmts = asArray(j?.FlexQueryResponse?.FlexStatements?.FlexStatement);
  const positions = [];
  const cashByCurrency = {};
  let hasCashReport = false;   // Cash Report 區塊有沒有出現在報表裡（區塊缺失 ≠ 現金為 0，Codex r4#3）
  let hasCashDetail = false;   // 區塊裡有沒有「真實幣別」明細列（Codex r5#2）
  let baseCurrency = '';       // 帳戶基準幣別（AccountInformation；Codex r6#1——只有彙總列時判定「彙總＝哪個幣別」用）
  let baseSummaryCash = null;  // BASE_SUMMARY 彙總列的期末現金（Codex r6#1：只有彙總列的報表也是合法的——
                               // 基準幣別總額本來就住在彙總列，全跳過會把合法現金當「沒資料」永遠不更新）
  let cashDetailIncomplete = false;   // 有幣別列、但金額讀不到（空白/非數字/只有期初）＝明細不完整（Codex r9#1）
  // 金額欄嚴格取值（Codex r9#1，高）：只認「期末」欄位（endingCash → endingSettledCash），
  // 空字串/null/非數字一律回 null＝「沒有金額」——Number('') 是 0，把空白當成零會直接清空真實現金；
  // startingCash 是期初餘額，拿來當目前現金會用上上期的數字蓋掉本期。
  const cashAmt = (/** @type {any} */ c) => {
    for (const v of [c.endingCash, c.endingSettledCash]) {
      if (v === null || v === undefined || String(v).trim() === '') continue;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const estCur = new Set();   // 以設定或預設匯率估算過的幣別（供前端/報表註記）
  let account = '';

  for (const s of stmts) {
    account = s.accountId || account;
    if (s?.AccountInformation?.currency) baseCurrency = String(s.AccountInformation.currency).toUpperCase();
    // 持倉
    for (const p of asArray(s?.OpenPositions?.OpenPosition)) {
      const qty = Number(p.position || 0);
      if (!qty) continue;
      const costMoney = Number(p.costBasisMoney ?? (Number(p.costBasisPrice || 0) * qty));
      positions.push({
        symbol: p.symbol,
        description: p.description || '',
        currency: p.currency || '',
        quantity: qty,
        avgCost: Number(p.costBasisPrice || (qty ? costMoney / qty : 0)),  // 購買均價
        marketPrice: Number(p.markPrice || 0)
      });
    }
    // 現金（負值＝融資借款）。優先序：期末現金 → 期末已交割現金 → 期初現金
    if (s?.CashReport) hasCashReport = true;
    for (const c of asArray(s?.CashReport?.CashReportCurrency)) {
      const cur = (c.currency || '').toUpperCase();
      if (cur === 'BASE_SUMMARY') {   // 彙總列＝基準幣別總額，留底供「只有彙總列」的合法報表使用（r6#1）
        const v = cashAmt(c);
        if (v !== null) baseSummaryCash = v;
        continue;
      }
      if (!cur) continue;
      const v = cashAmt(c);
      if (v === null) { cashDetailIncomplete = true; continue; }   // 列在、金額不可用：不可當 0、也不可讓它觸發歸零（r9#1）
      hasCashDetail = true;
      cashByCurrency[cur] = v;
    }
  }
  // 淨值摘要（基準幣別）：cash 負值＝融資、stock＝持股市值 → 算槓桿用
  let equity = null;
  for (const s of stmts) {
    const rows = asArray(s?.EquitySummaryInBase?.EquitySummaryByReportDateInBase);
    if (rows.length) {
      const e = rows[rows.length - 1];
      // ⚠️ **嚴格取值，缺欄／空白不可變成 0**（2026-08-05，Codex #407 r2 H① 實測打出來的真 bug）：
      //    `Number(undefined || 0)` 與 `Number('' || 0)` 都是 0 ⇒ 報表沒勾 Cash 欄時，
      //    官方淨值會被存成「現金 0」＝**看起來沒有融資**，槓桿與斷頭距離靜默失真，
      //    而失真方向剛好是最危險的那一邊。同檔 cashAmt 上方註解早就點名同型病
      //    （「Number('') 是 0，把空白當成零會直接清空真實現金」），這裡當時沒跟上。
      //    回 null ⇒ ib-sync 的守衛會丟棄整個 lastEquity、改走 fallback 自算（看得見的退化）。
      //    真正的 0（現金確實是零）照樣是合法值、照存。
      const numOrNull = (/** @type {any} */ v) => {
        if (v === null || v === undefined || String(v).trim() === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      equity = { cash: numOrNull(e.cash), stock: numOrNull(e.stock), date: String(e.reportDate || '') };
    }
  }
  // 現金交易彙總（股息／替代股息／預扣稅／融資利息，基準幣別）＋ 成交紀錄
  let income = null;
  const trades = [];
  /** @type {any[]} */
  const rawTrades = [];   // 原始 Trade 屬性（S2 正規化用；不進 ibTrades 鏡像、形狀不變）
  let period = null;
  // ⚠️ **跨 statement 累計**（2026-07-28 修）：以前是每份 statement 各自檢查，
  // 10 份 × 各 3 萬筆＝總量 30 萬筆，每一份都沒超過 5 萬 → 全部放行。
  let ctTotal = 0, tradeTotal = 0;
  for (const s of stmts) {
    if (s.fromDate) period = { from: String(s.fromDate), to: String(s.toDate || '') };
    const ct = asArray(s?.CashTransactions?.CashTransaction);
    ctTotal += ct.length;
    assertRowLimit(ctTotal, '現金交易');
    if (ct.length) {
      income = income || { dividends: 0, paymentInLieu: 0, withholdingTax: 0, interestPaid: 0, interestReceived: 0, other: 0, count: 0, skippedNoFx: 0, skippedNoCurrency: 0, estimatedNoFx: 0, estimatedCurrencies: /** @type {string[]} */ ([]) };
      for (const c of ct) {
        // 多幣別換算優先序（AGENTS.md）：fxRateToBase → USD 直通 → 設定或預設匯率估算（標註；fxToBase 走 fx-rates.js，丙-2）→ 不支援的幣別不計入（標註）。
        // 絕不把非 USD 金額默默當 USD 加總（如 GBP 股息）。
        const fxRaw = c.fxRateToBase;
        const fx = fxRaw == null || fxRaw === '' ? null : Number(fxRaw);
        // ⚠️ **缺幣別 ≠ 缺匯率**（2026-07-28 修）：原本 `c.currency || 'USD'` 會把「Flex 沒勾 Currency 欄」
        // 的列當成美元直通加總——真的是 GBP 100 的股息就少算 27%，而且 skippedNoFx 是 0＝畫面一個字都不會提。
        // securityTrades 早就改成「缺幣別不猜不入庫」（security-trades.js），這三條路當時沒跟上。
        // 有**正的** fxRateToBase 就照算（fxRateToBase 分支與幣別無關、實測正確）；沒有匯率又不知道幣別＝**跳過並回報**。
        // 匯率必為正數：0／負數＝報表壞值不是匯率——照乘的話金額歸零（或變號）卻 count++
        // ＝畫面「已計入」、skippedNoFx 是 0，一個字都不提。壞值視同沒有報表匯率：
        // 依序試 USD 直通、設定或預設匯率估算（fxToBase 走 fx-rates.js；丙-2），只有不支援的幣別才跳過並回報；估算分支的 `est > 0` 本來就是同一個判準（#407 複審記錄在案的缺口）。
        const cur = String(c.currency || '').toUpperCase();
        let amt;
        if (Number.isFinite(fx) && fx > 0) amt = Number(c.amount || 0) * fx;
        else if (cur === 'USD') amt = Number(c.amount || 0);
        else if (!cur) { income.skippedNoCurrency++; continue; }
        else {
          const est = fxToBase(cur);   // 設定或預設匯率估算（換算為 USD 基準）；只有不支援的幣別回 null
          if (est != null && est > 0) { amt = Number(c.amount || 0) * est; income.estimatedNoFx++; estCur.add(cur); }
          else { income.skippedNoFx++; continue; }
        }
        income.count++;
        const ty = String(c.type || '');
        if (ty === 'Dividends') income.dividends += amt;
        else if (ty === 'Payment In Lieu Of Dividends') income.paymentInLieu += amt;
        else if (ty === 'Withholding Tax') income.withholdingTax += amt;
        else if (ty === 'Broker Interest Paid') income.interestPaid += amt;
        else if (ty === 'Broker Interest Received') income.interestReceived += amt;
        else income.other += amt;
      }
    }
    const tradeRows = asArray(s?.Trades?.Trade);
    tradeTotal += tradeRows.length;
    assertRowLimit(tradeTotal, '成交紀錄');
    for (const t of tradeRows) {
      rawTrades.push(t.accountId ? t : { ...t, accountId: s.accountId || '' });   // 外層 statement 帳戶補給缺 Account ID 欄的 Trade（Codex S2r1#2）；原始 XML 屬性物件（S2：證券交易共同集合的正規化原料——含 transactionID/tradeID/ibExecID/settleDateTarget/ibCommission/taxes 等，精簡版 trades 沒保留）
      // 缺幣別不冒充 USD。**缺幣別不擋換算**——有「正的」fxRateToBase 仍照算（fxRateToBase 分支與幣別無關）；
      // 缺幣別「又」沒有有效匯率時 pnlBase 才落到 null；前端 tradePnlBase 收到 null 後依其具名分支處理
      //（USD 直通／設定或預設匯率估算／只有不支援的幣別才歸 `missing` 並在畫面標註；丙-2），而不是默默把 GBP 損益當美元加進 XIRR。反例＝`test/ib-parser-money.test.js` 的「成交紀錄缺幣別且沒有有效匯率」那題（缺幣別＋1.27 仍得 38.1）。
      const currency = String(t.currency || '');
      const fxRaw = t.fxRateToBase;
      const fxNum = fxRaw == null || fxRaw === '' ? null : Number(fxRaw);
      // 匯率必為正數：0／負數＝報表壞值不是匯率，照乘會把已實現損益歸零／變號。
      // （與現金交易列走同一個判準 `fx > 0`——理由重述而非互指，兩邊各自看得懂。）
      // 前端 tradePnlBase（portfolio-calculations.js）先看 pnlBase != null、才看 fxRateToBase > 0：
      // 後端若把 0 存進 pnlBase，前端的 fxRateToBase > 0 分支就不會被評估，所以判準必須在後端。
      // 壞值把 `fxRateToBase` 正規化成 null＝與空字串同路；`pnlBase` 依幣別處理——
      // **USD 仍然直通、保留原損益**，非 USD 才是 null（前端 tradePnlBase 收到 null 後依其具名分支處理：USD 直通／設定或預設匯率估算／只有不支援的幣別才歸 missing 並標註）。
      // ⚠️ 不要「順手」把這裡改成壞 fx 一律 null：那會打掉 USD 退路
      // （反面斷言＝`test/ib-sync-integrity.test.js` 的「IB 成交｜fxRateToBase 是 0 或負數」那題）。
      const fxRateToBase = Number.isFinite(fxNum) && fxNum > 0 ? fxNum : null;
      const pnl = Number(t.fifoPnlRealized || 0);
      trades.push({
        symbol: t.symbol, date: String(t.tradeDate || ''), buySell: t.buySell,
        quantity: Number(t.quantity || 0), price: Number(t.tradePrice || 0),
        netCash: Number(t.netCash || 0), pnl,
        currency, fxRateToBase,
        pnlBase: Number.isFinite(fxRateToBase) ? pnl * fxRateToBase : (currency === 'USD' ? pnl : null)
      });
    }
  }
  if (income && estCur.size) income.estimatedCurrencies = [...estCur];
  const accountCount = new Set(stmts.map(s => String(s?.accountId || '')).filter(Boolean)).size;   // 去重帳戶數（Codex r7#3：節點數≠帳戶數，模型 bundle 是同帳戶多 statement）
  return { account, positions, cashByCurrency, hasCashReport, hasCashDetail, cashDetailIncomplete, baseCurrency, baseSummaryCash, statementCount: stmts.length, accountCount, equity, income, trades, rawTrades, period };
}

export async function fetchFlex(token, queryId, fxToBase) {
  if (!token || !queryId) throw new Error('尚未設定 IB Flex Token 或 Query ID');
  const { code, url } = await sendRequest(token, queryId);
  const stmt = await getStatement(token, code, url);
  return parseStatement(stmt, fxToBase);
}
