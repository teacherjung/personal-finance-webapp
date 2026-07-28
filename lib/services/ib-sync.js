// @ts-check
// IBKR Flex Query 同步（B2 服務層）：持倉合併進 holdings、現金更新到帳戶、
// 官方淨值/現金流/成交紀錄寫入 settings.ib 與 ibTrades。失敗直接 throw（路由層轉 400）。
import { getDb, saveDb, getSettings, uid } from '../repo.js';
import { fetchFlex } from '../ib.js';
import { CURRENCIES } from '../schema.js';
import { normalizeIbTrade, isOfficialRef, reconcileFingerprintRows } from './security-trades.js';

// 新代號的預設分層（找不到就歸「區域衛星」，之後可在編輯裡改）。
// ⚠️ 同步點（AGENTS.md）：新增代號時，兩份 COMPOSITION（portfolio-exposure.js/derive.js）也要有。
export const DEFAULT_LAYER = {
  CSPX: 'core', QQQM: 'core', VUAA: 'core', SPY: 'core', VOO: 'core',
  EIMI: 'satellite', XUSE: 'satellite', EXUS: 'satellite', ICHN: 'satellite',
  KWEB: 'satellite', CSKR: 'satellite', SJPA: 'satellite', SMH: 'satellite',
  GOOGL: 'stock', GOOG: 'stock', AAPL: 'stock',
  TSLA: 'stock', SPCX: 'stock',
  SGLD: 'gold', GLD: 'gold', IAU: 'gold'
};

/**
 * 執行同步；成功回傳前端要的摘要物件、失敗 throw Error。
 * @param {typeof fetchFlex=} fetchImpl 測試用注入點（考題餵合成 Flex 資料；正常執行用預設 fetchFlex）
 */
export async function syncIb(fetchImpl = fetchFlex) {
  // ⚠️ **等待網路請求之前只讀「發請求需要的設定」，整包資料庫等回應之後才讀**（Codex r3#1，高）。
  // 原本一開頭就 getDb() 拿整包、請求結束再把**那份過期快照**整包寫回——Flex Query 要跑好幾秒到幾十秒，
  // 這段期間任何寫入都會被靜默吃掉。Codex 實測：同步進行中寫入的當日日線，同步完成後整個消失。
  // D0 讓這件事變嚴重（日線每次開 app 都寫），但交易與月快照本來就會被吃掉、而且不會自己長回來。
  const pre = await getSettings();
  const { flexToken, flexQueryId } = pre.ib || {};
  // 現金流缺 IBKR 匯率時，用設定匯率估算為 USD 基準（與交易摘要同口徑，AGENTS.md 優先序）
  const fxToBase = (/** @type {string} */ cur) => {
    const c = String(cur || 'USD').toUpperCase();
    if (c === 'USD') return 1;
    const usdTwd = Number(pre.usdTwd || 32);
    const curTwd = c === 'TWD' ? 1 : Number(/** @type {any} */ (pre.fxTwd)?.[c] || 0);
    return (curTwd > 0 && usdTwd > 0) ? curTwd / usdTwd : null;
  };
  let data;
  try { data = await fetchImpl(flexToken, flexQueryId, fxToBase); }
  catch (e) {   // IB 連線/token/Query ID 類＝使用者層預期錯誤 → 標 400（路由原味回應）；其後的內部錯誤不標、交全域中介（Codex#11-2）
    throw Object.assign(new Error(String(/** @type {any} */ (e).message || 'IB 同步失敗')), { status: 400, cause: e });
  }
  // 多帳戶報表擋門（Codex r6#2）：Flex Query 可以圈多個帳戶，但現行彙整假設單帳戶——
  // 持倉會跨帳戶混疊、同代號互相覆蓋，現金與官方淨值只會留「最後一個帳戶」的值，
  // 淨值與槓桿全錯。在寫入任何東西之前整包拒絕，比默默算錯好；要支援多帳戶＝屆時再依帳戶彙總。
  if (Number(data.statementCount) > 1) {
    // 訊息依「去重帳戶數」分流（Codex r7#3）：節點數≠帳戶數——同帳戶的 Model-by-Model bundle 也是多
    // statement。兩種都整包拒絕（刻意 fail-closed：bundle 的持倉可能整體＋分模型重複列出，彙整會重複計算），
    // 但要把話說對，使用者才修得對地方。
    const msg = Number(data.accountCount) > 1
      ? `這份 Flex Query 內含 ${data.accountCount} 個帳戶的報表。目前僅支援單一帳戶——多帳戶會讓現金與淨值只剩最後一個帳戶的值、同代號持股互相覆蓋。請在 IBKR 的 Flex Query 設定裡只選一個帳戶（或替每個帳戶各建一個 Query）。`
      : `這份 Flex Query 產出了 ${data.statementCount} 份報表（可能是 Model-by-Model bundle 之類的多 statement 設定）。目前僅支援單一 statement——多份報表的持倉可能重複列出，彙整會重複計算。請把 Query 設定改為單一整體報表。`;
    throw Object.assign(new Error(msg), { status: 400 });
  }
  // 這裡才讀整包：拿到的是「請求期間別人也寫過」的最新狀態，下面只改 IB 擁有的欄位再存回
  const db = await getDb();
  db.holdings = db.holdings || [];
  const r2 = (/** @type {any} */ x) => Math.round(Number(x || 0) * 100) / 100;   // 金額統一到小數點後兩位
  // 幣別牆（Codex 第七輪，高）：IB 同步不可繞過 schema 的幣別枚舉——系統只支援 CURRENCIES 四種，
  // 未支援幣別（EUR/HKD…）寫進去會被 derive 用錯匯率計價（淨值/槓桿偏掉）。
  // 遇到就「跳過＋回報」（看得見的退化勝過默默算錯）；要支援新幣別＝同步擴充 fxRates/fxTable/schema（AGENTS 同步點）。
  /** @type {string[]} */
  const skippedCurrencies = [];
  /** 缺幣別而沒建立的**新**持股（2026-07-28 修）：既有持股不受影響——ib-sync 對它們是
   * `if (p.currency) h.currency = p.currency`，本來就保住原幣別；壞的只有「新建時 `|| 'USD'`」那一條。
   * 猜錯幣別＝市值、淨資產、投資上限全部靜默算錯，寧可不建並出聲。 @type {string[]} */
  const skippedNoCurrency = [];
  const curOk = (/** @type {any} */ c) => !c || CURRENCIES.includes(String(c).toUpperCase());
  let updated = 0, created = 0;
  for (const p of data.positions) {
    const sym = String(p.symbol || '').toUpperCase().trim();
    if (!sym) continue;
    if (!curOk(p.currency)) { skippedCurrencies.push(`${sym}(${p.currency})`); continue; }
    const h = db.holdings.find(x => String(x.symbol || '').toUpperCase().trim() === sym);   // 兩邊都 trim，避免夾帶空白的符號比不中→重複建立
    if (h) {
      h.quantity = p.quantity;
      if (p.marketPrice) h.price = r2(p.marketPrice);
      if (p.avgCost) h.avgCost = r2(p.avgCost);
      if (p.currency) h.currency = p.currency;
      h.source = 'ib';
      updated++;
    } else {
      // ⚠️ 新持股**不知道幣別就不建**（2026-07-28 修）：原本 `|| 'USD'` 會把一檔 GBP 標的存成美元，
      // 之後市值、淨資產、單一國家/個股上限全部靜默算錯。既有持股不走這條路（上面保住原幣別）。
      if (!p.currency) { skippedNoCurrency.push(sym); continue; }
      // 新持股與既有持股同口徑：價格/均價「有值才設」（缺市價時不寫入誤導性的 0，避免靜默把市值算成 0）
      /** @type {any} */
      const nh = {
        id: uid(), symbol: sym, name: p.description || sym,
        layer: /** @type {any} */ (DEFAULT_LAYER)[sym] || 'satellite',
        currency: p.currency, quantity: p.quantity, quoteSymbol: '', source: 'ib'
      };
      if (p.marketPrice) nh.price = r2(p.marketPrice);
      if (p.avgCost) nh.avgCost = r2(p.avgCost);
      db.holdings.push(nh);
      created++;
    }
  }
  // 各幣別現金 → 更新（或建立）帶 ibCashCur 標記的現金帳戶（同樣過幣別牆）
  const cashSeen = new Set();
  for (const [cur, cash] of Object.entries(data.cashByCurrency || {})) {
    if (!isFinite(cash)) continue;
    if (!curOk(cur)) { skippedCurrencies.push(`現金(${cur})`); continue; }
    cashSeen.add(cur);
    let acc = (db.accounts || []).find(a => a.ibCashCur === cur);
    if (!acc) {
      acc = { id: uid(), name: `IBKR ${cur} 現金`, type: 'cash', class: '現金', currency: cur, ibCashCur: cur, balance: 0 };
      (db.accounts = db.accounts || []).push(acc);
    }
    acc.balance = r2(cash);
    acc.currency = cur;
  }
  // 這次報表沒出現、但過去由 IB 同步建立的現金幣別 → 歸零（Codex r4#3）：
  // 原本只更新「有出現的幣別」，一旦某幣別現金全部提領/轉走、下次報表不再列它，
  // 帳上就永久殘留舊餘額，淨資產無聲虛增（實測：USD 現金 1000 提光後，同步後仍是 1000＝虛增 32000 TWD）。
  // ⚠️ 只在 Cash Report「確實有各幣別明細」時歸零（Codex r5#2 收緊，原判準＝區塊存在）——
  // 兩種「沒資料」都不可當成「現金為 0」：①整個區塊缺失（設定漏勾/查詢失敗）
  // ②區塊在、卻只有 BASE_SUMMARY 彙總列（部分報表的長相：彙總非零、明細空白），
  // 舊判準會在這種報表把真實 IB 現金全部歸零，淨值與融資數字嚴重失真。
  // 兩者都保留舊值並回報（看得見的退化勝過無聲的錯）。
  let cashZeroed = 0;
  let cashCollapsed = 0;         // 彙總入帳時被「折疊」歸零的其他幣別帳戶數（Codex r7#2：與真歸零分開，
                                 // 否則前端同時說「已合併顯示」與「可能已提領/轉走」自相矛盾）
  let cashBaseUnsupported = '';  // 基準幣別判定得出但系統不支援（如 EUR）——與「缺 Account Information」是不同的病
  let cashSummaryMissing = false;   // 基準幣別齊全、但彙總列沒有可用金額（Ending Cash 欄缺）——又是另一種病（Codex r8#1）
  let cashFromSummary = false;
  const cashReportMissing = !data.hasCashReport;
  const cashDetailIncomplete = Boolean(data.cashDetailIncomplete);
  // 「明細列存在但全部讀不到」也要排除在彙總折疊流程之外（Codex r10#4）：r9 的 `!cashDetailIncomplete`
  // 護欄只裝在「真明細歸零」那條（下面第一分支），明細全滅時 hasCashDetail=false 會落到第二分支
  // （只有彙總列）把其他幣別現金折疊歸零——與「資料不完整、沿用舊值」的回報自相矛盾。加上 && !cashDetailIncomplete
  // 後：明細全滅 → 兩分支都跳過、保留舊值；真正「只有彙總列、無任何明細」（cashDetailIncomplete=false）仍照走。
  let cashDetailMissing = Boolean(data.hasCashReport && !data.hasCashDetail && !cashDetailIncomplete);
  if (data.hasCashDetail && !cashDetailIncomplete) {
    for (const a of db.accounts || []) {
      if (a.ibCashCur && !cashSeen.has(a.ibCashCur) && Number(a.balance) !== 0) {
        a.balance = 0; cashZeroed++;
      }
    }
  } else if (cashDetailMissing) {
    // 只有 BASE_SUMMARY 的報表也是**合法**的（Codex r6#1）：基準幣別的總額本來就住在彙總列，
    // 一律當「資料不完整」會讓這種設定的現金永遠不更新（首次同步甚至連帳戶都建不出來）。
    // 基準幣別判定得了（AccountInformation）且彙總金額有效 → 以「基準幣別彙總現金」**原子取代**
    // 全部 IB 現金（把其他幣別現金帳戶歸零，避免與過去的明細餘額重複計算）；
    // 判定不了 → 維持保留舊值＋警告（r5#2 的保守路線不變，那才是「真的沒資料」）。
    const base = String(data.baseCurrency || '').toUpperCase();
    if (base && curOk(base) && Number.isFinite(data.baseSummaryCash)) {
      let acc = (db.accounts || []).find(a => a.ibCashCur === base);
      if (!acc) {
        acc = { id: uid(), name: `IBKR ${base} 現金`, type: 'cash', class: '現金', currency: base, ibCashCur: base, balance: 0 };
        (db.accounts = db.accounts || []).push(acc);
      }
      acc.balance = r2(data.baseSummaryCash);
      acc.currency = base;
      for (const a of db.accounts || []) {
        // 記在 cashCollapsed 不是 cashZeroed（Codex r7#2）：這些幣別不是「提領/轉走」，
        // 是被折疊進基準幣別彙總——兩種語意前端要說不同的話
        if (a.ibCashCur && a.ibCashCur !== base && Number(a.balance) !== 0) { a.balance = 0; cashCollapsed++; }
      }
      cashFromSummary = true;
      cashDetailMissing = false;   // 有拿到可用的現金資料，不再是「缺明細」警告，改回報 cashFromSummary
    } else if (base && !curOk(base)) {
      cashBaseUnsupported = base;  // 判定得出但不支援（EUR…）→ 保留舊值；提示「幣別不支援」而非「缺欄位」（Codex r7#2）
      cashDetailMissing = false;
    } else if (base) {
      // 基準幣別齊全、彙總金額卻無效（Cash Report 沒輸出 Ending Cash 之類的金額欄）→ 保留舊值；
      // 這不是「缺 Account Information」，提示要指向金額欄位（Codex r8#1）
      cashSummaryMissing = true;
      cashDetailMissing = false;
    }
  }
  // 曾由 IB 同步、但這次報表已找不到的持股 → 可能已出清，回報給前端確認
  const seen = new Set(data.positions.map(p => String(p.symbol || '').toUpperCase().trim()));
  const missing = db.holdings
    .filter(h => h.source === 'ib' && !seen.has(String(h.symbol || '').toUpperCase().trim()))
    .map(h => ({ id: h.id, symbol: h.symbol }));
  // 缺席的區塊要「清空」而不是留舊值：看得見的退化（fallback/卡片消失）勝過
  // 默默拿過期的官方淨值算槓桿與斷頭距離。必要的 Flex 區塊清單見設定頁說明。
  // 深層驗證 stock/cash 為數字（與 /api/import 同標準）：壞值→丟棄 lastEquity 走 fallback 自算，
  // 而不是讓 NaN cash 使 computeLeverage 誤判「無融資」、把融資風險藏起來。
  const eq = data.equity;
  db.settings.ib.lastEquity = (eq && Number.isFinite(eq.stock) && Number.isFinite(eq.cash)) ? eq : null;
  db.settings.ib.income = data.income ? {
    dividends: r2(data.income.dividends), paymentInLieu: r2(data.income.paymentInLieu),
    withholdingTax: r2(data.income.withholdingTax), interestPaid: r2(data.income.interestPaid),
    interestReceived: r2(data.income.interestReceived), other: r2(data.income.other),
    count: data.income.count, skippedNoFx: data.income.skippedNoFx || 0,
    // ⚠️ 這份是**逐欄白名單**（不是整包存）：新增的計數欄位漏在這裡＝同步當下的提示看得到、
    // 重新整理之後就消失，而金額總額已經排除了那些筆——「數字少了卻沒有任何註記」正是本專案禁止的默默算錯。
    // 同步點：schema.js 的 ib.income 數字欄清單、lib/types.js 的 IbIncome、前端活動卡與 A4 報表的註記。
    skippedNoCurrency: data.income.skippedNoCurrency || 0,
    estimatedNoFx: data.income.estimatedNoFx || 0, estimatedCurrencies: data.income.estimatedCurrencies || [],
    from: data.period?.from || '', to: data.period?.to || ''
  } : null;
  db.ibTrades = Array.isArray(data.trades) ? data.trades : [];   // 交易摘要與 XIRR 已實現損益修正使用中
  // ---- 證券交易共同集合雙寫（S2，藍圖 §五；與 ibTrades 鏡像同一次 saveDb＝原子）----
  // 語意刻意不同：ibTrades＝整包取代（既有消費者口徑不動）；securityTrades＝**重疊期間 upsert、永不刪**
  //（Flex 期間縮短時查帳歷史不消失，藍圖 §六）。一致性因此是「同步窗內 ibTrades ⊆ securityTrades」
  // 而非相等（S1 複審發現：期間縮短後兩邊筆數必然不等，考題驗 ⊆）。
  // fail-closed 分流：unknownType（BUY (Ca.) 取消列等——側 null 不可猜方向）與 missingAccount（空指紋
  // 會跨帳戶互撞去重）**跳過不入庫＋回報筆數**（IB 同步無預覽關卡，比照 skippedCurrencies 看得見的退化）。
  let secTradesAdded = 0, secTradesUpdated = 0;
  /** 分原因跳過計數（Codex S2r1#1/#2：總數以**原始列數**為基準——壞列 normalize 成 null 也要算；
   *  病因各自說對，使用者才知道去 Flex 補勾哪個欄位）。 */
  const secSkippedReasons = { badRow: 0, cancelOrUnknown: 0, missingAccount: 0, missingCurrency: 0, missingCore: 0, unsupportedCurrency: 0, unsupportedFeeCurrency: 0 };
  let secTradesSkipped;
  {
    const rawList = Array.isArray(data.rawTrades) ? data.rawTrades : [];
    const normalized = rawList.map(normalizeIbTrade);
    secSkippedReasons.badRow = normalized.filter(t => t == null).length;   // 缺成交日/代號/數量（含假日曆日）
    /** @type {NonNullable<ReturnType<typeof normalizeIbTrade>>[]} */
    const usable = [];
    for (const t of normalized) {
      if (!t) continue;
      if (t.flags.unknownType) { secSkippedReasons.cancelOrUnknown++; continue; }          // BUY (Ca.) 取消列等：不猜方向
      if (t.flags.missingAccount) { secSkippedReasons.missingAccount++; continue; }        // 空指紋會跨帳戶互撞去重
      if (t.flags.missingCurrency) { secSkippedReasons.missingCurrency++; continue; }      // 缺幣別**不猜 USD**（Codex S2r1#1）
      if (t.flags.missingCore) { secSkippedReasons.missingCore++; continue; }              // 缺價/成交額/應收付＝不可入庫
      if (!CURRENCIES.includes(String(t.currency).toUpperCase())) { secSkippedReasons.unsupportedCurrency++; continue; }   // 幣別牆
      // 手續費幣別也要過牆（Codex S3r2#1，高）：漏驗會讓這筆一路走到寫入櫃檯被枚舉檢查 throw——
      // 同步是一次原子寫入，等於一筆 EUR 手續費炸掉整次同步（持股/現金全失敗）。提早跳過＋回報。
      if (t.commissionCurrency && !CURRENCIES.includes(String(t.commissionCurrency).toUpperCase())) { secSkippedReasons.unsupportedFeeCurrency++; continue; }
      usable.push(t);
    }
    secTradesSkipped = rawList.length - usable.length;
    db.securityTrades = db.securityTrades || [];
    // 一次性鍵遷移（Codex S2r1#4）：舊官方鍵無帳戶指紋段（ib|txn|<id>）→ 用該列自帶的 sourceAccountId
    // 升級成 ib|txn|<fp>|<id>；冪等（新格式識別碼段前已有指紋段、不再重寫）。不遷移＝下次同步全被當新列＝整批重複。
    for (const r of db.securityTrades) {
      const m = String(r.sourceRef || '').match(/^ib\|(txn|trd|exe)\|([^|]+)$/);
      if (m && r.sourceAccountId) r.sourceRef = `ib|${m[1]}|${r.sourceAccountId}|${m[2]}`;
    }
    const importedAt = new Date().toISOString();
    const toRow = (/** @type {any} */ t) => {
      const { flags, ...fields } = t;
      void flags;   // 明確丟棄（lint no-unused-vars）
      /** @type {any} */
      const row = {};
      for (const [k, v] of Object.entries(fields)) if (v != null) row[k] = v;   // null 欄位不落庫（schema number/str 不收 null）
      return row;
    };
    // 官方識別碼列：ref 天生唯一 → upsert 就地更新。**整列取代資料欄**（自審 #4：只 Object.assign 非 null
    // 欄會讓「來源已消失/清空的欄位」殘留舊值——例如交割日在新報表消失仍顯示舊日期）；id/批次/時間保留首次。
    /** @type {Map<string, any>} */
    const byRef = new Map(db.securityTrades.map(r => [String(r.sourceRef || ''), r]));
    const KEEP = new Set(['id', 'importBatch', 'importedAt', 'sourceRef']);
    const official = usable.filter(t => isOfficialRef(t.sourceRef));
    for (const t of official) {
      const row = toRow(t);
      const existing = byRef.get(t.sourceRef);
      if (existing) {
        for (const k of Object.keys(existing)) if (!KEEP.has(k)) delete existing[k];
        Object.assign(existing, row);
        secTradesUpdated++;
      } else {
        db.securityTrades.push({ id: uid(), importBatch: `ib-sync-${importedAt}`, importedAt, ...row });
        byRef.set(t.sourceRef, db.securityTrades[db.securityTrades.length - 1]);
        secTradesAdded++;
      }
    }
    // 指紋列（無官方識別碼）：**內容比對＋計數對帳**（自審三 HIGH 根治）——只插入、永不就地更新既有列；
    // 序號＝庫內該 base 已用最大序＋1（視窗位移/補印插入都不會覆寫或漏記）。
    const fp = usable.filter(t => !isOfficialRef(t.sourceRef));
    if (fp.length) {
      const plan = reconcileFingerprintRows(db.securityTrades, fp);
      for (let i = 0; i < fp.length; i++) {
        if (plan.duplicate[i]) continue;
        db.securityTrades.push({ id: uid(), importBatch: `ib-sync-${importedAt}`, importedAt, ...toRow(fp[i]), sourceRef: plan.insertRefs[i] });
        secTradesAdded++;
      }
    }
  }
  db.settings.ib.lastSync = new Date().toISOString();
  await saveDb(db);
  if (skippedNoCurrency.length) console.warn(`[ib-sync] 跳過「報表沒給幣別」的新持股：${skippedNoCurrency.join(', ')}——請在 Flex Query 的 Open Positions 勾選 Currency 欄後重新同步`);
  if (skippedCurrencies.length) console.warn(`[ib-sync] 跳過未支援幣別（系統僅支援 ${CURRENCIES.join('/')}）：${skippedCurrencies.join(', ')}——要支援請擴充 fxRates/fxTable/schema（AGENTS 同步點）`);
  if (cashReportMissing) console.warn('[ib-sync] 這份報表沒有 Cash Report 區塊 → 沿用現有現金餘額（不歸零，避免誤清）。若非預期，請確認 Flex Query 有勾 Cash Report。');
  if (cashDetailMissing) console.warn('[ib-sync] Cash Report 只有彙總列、且無法判定基準幣別（報表缺 Account Information）→ 沿用現有現金餘額（不歸零，避免誤清）。請在 Flex Query 勾選 Account Information，或替 Cash Report 開啟幣別明細。');
  if (cashFromSummary) console.warn('[ib-sync] Cash Report 只有彙總列 → 以基準幣別總額入帳（各幣別明細不可得；其他幣別現金帳戶已折疊歸零避免重複計算）。');
  if (cashBaseUnsupported) console.warn(`[ib-sync] Cash Report 只有彙總列、且基準幣別 ${cashBaseUnsupported} 尚未支援（系統僅支援 ${CURRENCIES.join('/')}）→ 沿用現有現金餘額。`);
  if (cashSummaryMissing) console.warn('[ib-sync] Cash Report 只有彙總列、且彙總列沒有可用的金額欄 → 沿用現有現金餘額。請確認 Flex Query 的 Cash Report 有勾 Ending Cash。');
  if (cashDetailIncomplete) console.warn('[ib-sync] Cash Report 有幣別列但部分金額讀不到（空白/非數字/只有期初）→ 讀得到的已更新，其餘沿用舊值且不歸零。請確認 Cash Report 有勾 Ending Cash。');
  if (secTradesSkipped) {
    const parts = [];
    if (secSkippedReasons.cancelOrUnknown) parts.push(`取消列/未知買賣別 ${secSkippedReasons.cancelOrUnknown}`);
    if (secSkippedReasons.missingCurrency) parts.push(`缺幣別 ${secSkippedReasons.missingCurrency}（請在 Flex Trades 勾 Currency，不猜 USD）`);
    if (secSkippedReasons.missingCore) parts.push(`缺核心金額 ${secSkippedReasons.missingCore}（請勾 Trade Price／Trade Money／Net Cash）`);
    if (secSkippedReasons.missingAccount) parts.push(`缺帳戶識別 ${secSkippedReasons.missingAccount}（請勾 Account ID）`);
    if (secSkippedReasons.unsupportedCurrency) parts.push(`不支援幣別 ${secSkippedReasons.unsupportedCurrency}`);
    if (secSkippedReasons.badRow) parts.push(`缺日期/代號/數量 ${secSkippedReasons.badRow}`);
    console.warn(`[ib-sync] 證券交易集合跳過 ${secTradesSkipped} 筆（${parts.join('；')}）——查帳頁不顯示這些列；ibTrades 鏡像照舊保留供交易摘要/XIRR。`);
  }
  return { ok: true, updated, created, missing, skippedCurrencies, skippedNoCurrency, incomeNoCurrency: data.income?.skippedNoCurrency || 0, cashZeroed, cashCollapsed, cashReportMissing, cashDetailMissing, cashDetailIncomplete, cashFromSummary, cashBaseUnsupported, cashSummaryMissing, secTradesAdded, secTradesUpdated, secTradesSkipped, secSkippedReasons, cash: data.cashByCurrency, equity: data.equity, account: data.account };
}
