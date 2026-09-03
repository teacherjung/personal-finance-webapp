// IB 同步與匯率的「數字不可靜靜失真」考題（夜班稽核第二批A，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢：`lib/ib.js` 與 `lib/services/ib-sync.js` 有八處
// 「註解自己寫明理由」的規則，弄壞之後 1487 題全綠——也就是那些理由目前沒有任何考題背書。
// 本檔補的就是那八處。共同的病型是本專案最貴的一種：**數字錯了卻沒有任何註記**
//（畫面照樣說「同步完成」、旗標是 0），使用者看不到自己的淨值/收入被算錯。
//
// 隔離：`STORE_FILE` 指向 os 暫存檔（同 robustness.test.js 規矩），絕不碰真實 `data/`。
// 手法：`syncIb(fakeFetch)` 注入合成的 Flex 解析結果（不打真 IB）；解析層的題直接餵 XML 物件給
// `parseStatement`。每一題都釘住「規則被弄壞時會怎麼錯」，不是只檢查現況跑得過。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-ib-integrity-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { parseStatement, fetchFlex } = await import('../lib/ib.js');
const { syncIb } = await import('../lib/services/ib-sync.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

/** 合成一份「只有現金交易」的 Flex 回應（其餘區塊留空，避免無關旗標干擾）。
 * @param {Record<string, any>[]} cashTransactions */
function flexWithCash(cashTransactions) {
  return {
    FlexQueryResponse: {
      FlexStatements: {
        FlexStatement: {
          accountId: 'U-TEST',
          AccountInformation: { currency: 'USD' },
          CashTransactions: { CashTransaction: cashTransactions },
        },
      },
    },
  };
}

/** syncIb 用的假解析結果（欄位齊全的空殼，測哪一項就覆蓋哪一項）。
 * @param {Record<string, any>} over */
function fakeParsed(over = {}) {
  return async () => ({
    positions: [], cashByCurrency: {}, equity: null, income: null, trades: [],
    account: 'U-TEST', period: {}, ...over,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、匯率欄的空值與非正值：不可乘成 0 元收入（lib/ib.js 的 fx / est 兩道）
// ─────────────────────────────────────────────────────────────────────────────

test('IB 現金流｜fxRateToBase 是空字串／null → 走「缺匯率」路線，不可被算成 0 元收入', () => {
  // ⚠️ 病因：`Number('')` 與 `Number(null)` 都是 0、都通過 Number.isFinite ⇒ 若不先判空值，
  //    GBP 100 的股息會被乘 0 變成 0 元，而且 income.count++ ⇒ 畫面顯示「已計入」、
  //    skippedNoFx 是 0＝一個字都不提醒。同檔 cashAmt 上方註解早就點名過這個病
  //    （「Number('') 是 0，把空白當成零會直接清空真實現金」），匯率欄是同型缺口。
  for (const blank of ['', null]) {
    const parsed = parseStatement(flexWithCash([
      { type: 'Dividends', currency: 'GBP', amount: '100', fxRateToBase: blank },
    ]), () => null);
    const inc = parsed.income;
    assert.equal(inc?.dividends, 0, `fxRateToBase=${JSON.stringify(blank)}：不可有金額進股息`);
    assert.equal(inc?.count, 0, '不可計入筆數（計入＝畫面說「已計入」）');
    assert.equal(inc?.skippedNoFx, 1,
      `fxRateToBase=${JSON.stringify(blank)} 應落「缺匯率」計數——`
      + '被當成匯率 0 的話金額歸零卻標成已計入，使用者看不到股息不見了');
  }
});

test('IB 現金流｜設定的估算匯率是 0 或負數 → 落 skippedNoFx，不可標成「已用設定匯率估算」', () => {
  // ⚠️ `if (est != null && est > 0)` 的 `> 0` 是承重的：使用者手打成 0、或設定欄被清空成 0 時，
  //    金額會乘 0 變 0 並計入 estimatedNoFx ⇒ 畫面標「已用設定匯率估算」，實際上整筆消失。
  for (const bad of [0, -1.5]) {
    const parsed = parseStatement(flexWithCash([
      { type: 'Dividends', currency: 'JPY', amount: '10000' },   // 無 fxRateToBase、非 USD ⇒ 走估算路
    ]), () => bad);
    const inc = parsed.income;
    assert.equal(inc?.skippedNoFx, 1, `估算匯率=${bad}：應落「缺匯率」而不是估算`);
    assert.equal(inc?.estimatedNoFx, 0, `估算匯率=${bad}：不可標成「已用設定匯率估算」`);
    assert.equal(inc?.dividends, 0, '不可有 0 元金額混進股息');
    assert.equal(inc?.count, 0, '不可計入筆數');
  }
  // 反面（防止整段被關掉也綠）：正常估算匯率仍要照走估算路。
  const ok = parseStatement(flexWithCash([
    { type: 'Dividends', currency: 'JPY', amount: '10000' },
  ]), () => 0.0064);
  assert.equal(ok.income?.estimatedNoFx, 1, '合法估算匯率要照常估算並標註');
  assert.equal(ok.income?.skippedNoFx, 0);
  assert.ok((ok.income?.dividends ?? 0) > 0, '合法估算要真的換出金額');
});

test('IB 現金流｜fxRateToBase 是 0 或負數 → 視同沒有報表匯率（USD 直通／設定估算／不計入分支），不可乘成 0 元／負值還標「已計入」', () => {
  // ⚠️ 病因：`Number.isFinite(0)` 是 true——0 不是匯率，是報表壞值。照乘的話 GBP 100 的股息
  //    變 0 元、count++ ⇒ 畫面「已計入」、skippedNoFx=0 零提醒；負數更會把收入變成支出。
  //    同檔題名關鍵字「fxRateToBase 是空字串／null」那題釘的是空字串／null，
  //    這一題釘的是 #407 複審當時記錄在案、當時沒做的 0／負數：正值牆。
  for (const bad of ['0', '-1.3']) {
    const parsed = parseStatement(flexWithCash([
      { type: 'Dividends', currency: 'GBP', amount: '100', fxRateToBase: bad },
    ]), () => null);   // 設定也沒有估算匯率 ⇒ 唯一誠實的出路＝skippedNoFx
    const inc = parsed.income;
    assert.equal(inc?.dividends, 0, `fxRateToBase=${bad}：不可有金額進股息`);
    assert.equal(inc?.count, 0, `fxRateToBase=${bad}：不可計入筆數（計入＝畫面說「已計入」）`);
    assert.equal(inc?.skippedNoFx, 1,
      `fxRateToBase=${bad} 應落「缺匯率」計數——乘 0 歸零／乘負變號都比「少一筆」更難察覺`);
  }
  // 反面（防「一律 skip」的過度修法）：壞 fx 只是失去「報表 fxRateToBase」這個來源，USD 直通與設定估算仍照走。
  // ①壞 fx＋幣別是 USD ⇒ 走 USD 直通分支，金額照原值計入。
  const usd = parseStatement(flexWithCash([
    { type: 'Dividends', currency: 'USD', amount: '100', fxRateToBase: '0' },
  ]), () => null);
  assert.equal(usd.income?.dividends, 100, '壞 fx 的 USD 列要走直通、不可被 skip');
  assert.equal(usd.income?.skippedNoFx, 0);
  assert.equal(usd.income?.count, 1);
  // ②壞 fx＋非 USD＋設定有估算匯率 ⇒ 走設定估算分支並標註。
  const est = parseStatement(flexWithCash([
    { type: 'Dividends', currency: 'JPY', amount: '10000', fxRateToBase: '-2' },
  ]), () => 0.0064);
  assert.equal(est.income?.estimatedNoFx, 1, '壞 fx 的非 USD 列要走設定估算並標註');
  assert.equal(est.income?.skippedNoFx, 0);
  assert.ok((est.income?.dividends ?? 0) > 0, '估算要真的換出金額');
});

/** 合成一份「只有成交」的 Flex 回應（其餘區塊留空）。 @param {Record<string, any>[]} tradeRows */
function flexWithTrades(tradeRows) {
  return {
    FlexQueryResponse: {
      FlexStatements: {
        FlexStatement: {
          accountId: 'U-TEST',
          AccountInformation: { currency: 'USD' },
          Trades: { Trade: tradeRows },
        },
      },
    },
  };
}

test('IB 成交｜fxRateToBase 是 0 或負數 → 匯率欄正規化成 null，pnlBase 依幣別（USD 直通保留原損益、非 USD 才 null），不可歸零或變號', () => {
  // ⚠️ 病因鏈：後端 `pnl * 0 = 0` 寫進 pnlBase，而前端 tradePnlBase（portfolio-calculations.js）
  //    先看 pnlBase != null、才看 fxRateToBase > 0 ⇒ 後端存了 0，前端的 fxRateToBase > 0
  //    分支就不會被評估——GBP 賣出的已實現損益靜靜消失（或變號）進交易摘要與 XIRR。
  const bads = ['0', '-1.27'];
  const parsed = parseStatement(flexWithTrades(bads.map(fx => ({
    symbol: 'HSBA', tradeDate: '20260810', buySell: 'SELL', quantity: '-10',
    tradePrice: '7', netCash: '70', fifoPnlRealized: '250', currency: 'GBP', fxRateToBase: fx,
  }))), () => null);
  assert.equal(parsed.trades.length, 2);
  for (const [i, t] of parsed.trades.entries()) {
    assert.equal(t.pnlBase, null,
      `fxRateToBase=${bads[i]}：pnlBase 要 null（前端 tradePnlBase() 收到 null 才會走它自己的具名分支；0 會被當成合法損益），不可是 0／負值`);
    assert.equal(t.fxRateToBase, null,
      '壞匯率不可原樣入庫——前端 tradePnlBase() 的 fxRateToBase 分支讀它，要看到「缺」而不是 0');
  }
  // 反面：合法匯率照算；USD 列在壞 fx 下走 USD 直通分支（pnlBase＝原損益）。
  const ok = parseStatement(flexWithTrades([
    { symbol: 'HSBA', tradeDate: '20260810', buySell: 'SELL', quantity: '-10',
      tradePrice: '7', netCash: '70', fifoPnlRealized: '250', currency: 'GBP', fxRateToBase: '1.27' },
    { symbol: 'VOO', tradeDate: '20260810', buySell: 'SELL', quantity: '-1',
      tradePrice: '400', netCash: '400', fifoPnlRealized: '50', currency: 'USD', fxRateToBase: '0' },
  ]), () => null);
  assert.equal(ok.trades[0].pnlBase, 250 * 1.27, '合法匯率要真的換算，不可一律 null');
  assert.equal(ok.trades[0].fxRateToBase, 1.27);
  assert.equal(ok.trades[1].pnlBase, 50, '壞 fx 的 USD 列要走直通（pnlBase＝原損益）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、Flex 取報表的錯誤處理：fail-closed 與 1019 白名單（lib/ib.js 三道）
// ─────────────────────────────────────────────────────────────────────────────

/** 假 IB 伺服器：依序回傳給定的 XML（第一份是 SendRequest 的回應）。
 * `fetch.calls` 會記錄總共被打了幾次——**次數本身就是契約**（Codex #407 r1 H①：
 * 只驗最終錯誤訊息的話，「偷偷重試一次、第二次才丟同一個錯」照樣綠）。
 * @param {string[]} xmls */
function fakeIbSequence(xmls) {
  const fn = /** @type {any} */ (async () => {
    const body = xmls[Math.min(fn.calls++, xmls.length - 1)];
    const bytes = new TextEncoder().encode(body);
    return {
      ok: true,
      headers: { get: (/** @type {string} */ k) => (k === 'content-length' ? String(bytes.byteLength) : null) },
      body: (async function* () { yield bytes; })(),
    };
  });
  fn.calls = 0;
  return fn;
}

const SEND_OK = '<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode>'
  + '<Url>https://x/GetStatement</Url></FlexStatementResponse>';

test('IB 第一步｜Flex 拒絕請求（Status 不是 Success）→ 立刻丟出它的原因，不可帶著空 code 往下走', async () => {
  // ⚠️ 判準是 `!== 'Success'` 而不是 `=== 'Failure'`：Status 缺失或寫別的字（IB 曾回 Warn）
  //    都必須擋。放行的後果＝ReferenceCode 是 undefined 繼續打第二步，
  //    使用者看不到「請檢查 Token 與 Query ID」，只拿到後面某個難懂的錯。
  const real = globalThis.fetch;
  for (const status of ['Fail', 'Warn', undefined]) {
    const statusTag = status === undefined ? '' : `<Status>${status}</Status>`;
    const fake = fakeIbSequence([
      `<FlexStatementResponse>${statusTag}<ErrorMessage>Invalid token</ErrorMessage></FlexStatementResponse>`,
    ]);
    globalThis.fetch = /** @type {any} */ (fake);
    try {
      const err = await fetchFlex('tok', 'qid', () => 1).then(() => null, (/** @type {any} */ e) => e);
      assert.ok(err, `Status=${status}：IB 拒絕了請求，卻沒有擋下來`);
      assert.match(err.message, /Invalid token/,
        '要把 IB 給的原因原樣帶出來（不然使用者不知道是 Token 還是 Query ID 的問題）');
      // ⚠️ 次數也是契約（Codex #407 r2 M③）：第一步就該停，不可偷偷往下打第二步。
      assert.equal(fake.calls, 1,
        `第一步被拒就該停＝只有一次請求，實際 ${fake.calls} 次（往下打＝帶著空的 ReferenceCode 走）`);
    } finally { globalThis.fetch = real; }
  }
});

test('IB 第二步｜非 1019 的錯誤碼立刻失敗（不可當成「還在產生中」重試到逾時）', async () => {
  // ⚠️ 1019＝報表還在產生中（唯一該重試的）。Token 過期、Query 被刪等真實錯誤若也被當成 1019，
  //    會重試 15 次共 45 秒，最後只吐「IB 報表準備逾時，請稍後再試」——
  //    把「可修的設定錯誤」講成「暫時性問題」，使用者會一直重試。
  const real = globalThis.fetch;
  const fake = fakeIbSequence([
    SEND_OK,
    '<FlexStatementResponse><ErrorCode>1020</ErrorCode><ErrorMessage>Invalid request or unable to validate request.</ErrorMessage></FlexStatementResponse>',
  ]);
  globalThis.fetch = /** @type {any} */ (fake);
  try {
    const err = await fetchFlex('tok', 'qid', () => 1).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, '非 1019 的錯誤碼必須當場失敗');
    assert.match(err.message, /unable to validate request/, '要把 IB 的錯誤訊息帶出來');
    assert.doesNotMatch(err.message, /逾時/, '不可退化成「逾時」——那會把可修的錯講成暫時性問題');
    // ⚠️ **次數也是契約**（Codex #407 r1 H①）：只驗訊息的話，「偷偷重試一次、
    //    第二次才丟同一個錯」會照樣綠——而那正是「把可修的設定錯當成暫時性問題」的行為。
    assert.equal(fake.calls, 2,
      `非 1019 的錯誤碼必須「立刻」失敗＝總共只有兩次請求（SendRequest 1＋GetStatement 1），實際 ${fake.calls} 次`);
  } finally { globalThis.fetch = real; }
});

test('IB 第二步｜1019（還在產生中）真的會重試，下一輪成功就正常回報表', async () => {
  // 這一題釘兩件事：①1019 在白名單內（不可當硬錯誤）②重試上限不是 1
  //（改成只試一次，任何不是立刻就緒的報表都會直接「準備逾時」＝IB 同步在真實使用上基本壞掉）。
  // ⚠️ 刻意用**真實**的 3 秒等待（production 的 sleep 寫死在 getStatement 裡）：
  //    試過 node:test 的假計時器，非同步鏈太深、tick 時機難掌握會變成不穩定考題——
  //    寧可讓這一題慢 3 秒，也不要一顆偶爾紅的考題（不穩定考題會訓練人忽略紅燈）。
  // ⚠️ 這一題出生時當場抓到一個**真 bug**：fast-xml-parser 把 `<ErrorCode>1019</ErrorCode>`
  //    解析成數字 1019，原本的 `r.ErrorCode !== '1019'` 恆真 ⇒ 白名單失效、重試是死碼，
  //    IB 只要沒有立刻備妥報表就會失敗（訊息還寫著 in progress）。修法＝比較前先 String()。
  const real = globalThis.fetch;
  const fake = fakeIbSequence([
    SEND_OK,
    '<FlexStatementResponse><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress.</ErrorMessage></FlexStatementResponse>',
    '<FlexQueryResponse><FlexStatements><FlexStatement accountId="U-RETRY">'
      + '<AccountInformation currency="USD"/></FlexStatement></FlexStatements></FlexQueryResponse>',
  ]);
  globalThis.fetch = /** @type {any} */ (fake);
  try {
    const parsed = await fetchFlex('tok', 'qid', () => 1);
    assert.equal(parsed.account, 'U-RETRY',
      '1019 之後的重試必須真的發生並拿到報表（拿不到＝白名單或重試上限壞了）');
    // ⚠️ 次數也是契約（Codex #407 r2 M③）：成功之後不可再多抓一次。
    assert.equal(fake.calls, 3,
      `恰好三次請求（SendRequest→1019→成功），實際 ${fake.calls} 次`);
  } finally { globalThis.fetch = real; }
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、同步寫回資料庫：壞值不可覆寫好值（lib/services/ib-sync.js 三道）
// ─────────────────────────────────────────────────────────────────────────────

test('IB 同步｜官方淨值壞掉時：清掉上一次的舊值、走 fallback，而且其餘資料照常存進去', async () => {
  // ⚠️ 這一題被 Codex 打回兩次，兩次都對，值得完整記下來：
  //    r1 我原本寫「壞值會靜靜存進去、把融資風險藏起來」——錯：寫入櫃檯會把整次同步整批拒絕。
  //    r2 我改成「一個壞欄位不該炸掉整次同步」，但 fixture 是**直接注入** syncIb 的，
  //       沒有走真 parser；而真 parser 當時用 `Number(e.cash || 0)`，缺欄／空白會先變成
  //       **合法的 0** ⇒ 守衛放行 ⇒ 官方淨值被存成「現金 0」＝**看起來沒有融資**。
  //       那是一個真 bug，已在同一支 PR 修掉（lib/ib.js 的 numOrNull 嚴格取值）。
  //    所以這一題現在走**完整路徑**：raw Flex → parseStatement → syncIb。
  //    另外先種一筆「上一次的舊官方淨值」——否則「壞值時保留舊值」的突變會全綠（r2 H②）。
  const rawFlex = (/** @type {Record<string, any>} */ equityRow) => ({
    FlexQueryResponse: {
      FlexStatements: {
        FlexStatement: {
          accountId: 'U-TEST', AccountInformation: { currency: 'USD' },
          EquitySummaryInBase: { EquitySummaryByReportDateInBase: [equityRow] },
          OpenPositions: { OpenPosition: [{ symbol: 'CSPX', currency: 'USD', position: '10', markPrice: '500', costBasisPrice: '480' }] },
        },
      },
    },
  });
  const OLD_EQUITY = { stock: 9999, cash: -8888 };   // 上一次同步存下來的官方淨值

  for (const badRow of [
    { reportDate: '20261231', stock: '5000' },              // 缺 cash 欄（Flex 沒勾）
    { reportDate: '20261231', stock: '5000', cash: '' },    // cash 是空字串
    { reportDate: '20261231', stock: '5000', cash: 'abc' }, // cash 不是數字
    { reportDate: '20261231', cash: '1000' },               // 缺 stock 欄
  ]) {
    const db0 = store.emptyDb();
    db0.settings = { ...db0.settings, ib: { ...(db0.settings.ib || {}), lastEquity: OLD_EQUITY } };
    store.save(db0);
    const parsed = parseStatement(rawFlex(badRow), () => null);
    const r = await syncIb(/** @type {any} */ (async () => parsed));
    const db = store.load();
    assert.equal(db.settings?.ib?.lastEquity ?? null, null,
      `${JSON.stringify(badRow)}：壞的官方淨值要清成 null（走 fallback 自算）——`
      + '①存進去＝槓桿看起來沒有融資（最危險的方向）②保留上一次的舊值＝拿過期數字算風險');
    assert.equal(r.created, 1,
      `${JSON.stringify(badRow)}：其餘資料要照常同步（不丟棄的話整次同步會被寫入櫃檯整批拒絕）`);
    assert.ok((db.holdings ?? []).some((/** @type {any} */ h) => h.symbol === 'CSPX'),
      '持倉必須真的存進資料庫');
  }

  // 反面一：合法的官方淨值（含負現金＝融資）要照存。
  {
    const db0 = store.emptyDb();
    store.save(db0);
    const parsed = parseStatement(rawFlex({ reportDate: '20261231', stock: '5000', cash: '-1200' }), () => null);
    await syncIb(/** @type {any} */ (async () => parsed));
    const eq = store.load().settings?.ib?.lastEquity;
    assert.equal(eq?.stock, 5000); assert.equal(eq?.cash, -1200);
  }
  // 反面二：**真正的 0** 現金是合法值，不可被當成「壞值」丟掉。
  {
    const db0 = store.emptyDb();
    store.save(db0);
    const parsed = parseStatement(rawFlex({ reportDate: '20261231', stock: '5000', cash: '0' }), () => null);
    await syncIb(/** @type {any} */ (async () => parsed));
    assert.equal(store.load().settings?.ib?.lastEquity?.cash, 0,
      '現金確實是零＝合法，嚴格取值不可把它一起丟掉（那會變成誤殺）');
  }
});

test('IB 同步｜手動持股的代號有大小寫或空白差異 → 認得是同一檔，不可重複建立', async () => {
  // ⚠️ 行末註解的理由：「兩邊都 trim，避免夾帶空白的符號比不中→重複建立」。
  //    比不中的後果＝同一檔在 holdings 出現兩列、市值與淨資產重複計算，
  //    而且每次同步都不會自我修正（數字靜默多算，比報錯難發現）。
  store.save({
    ...store.emptyDb(),
    holdings: [{ id: 'h1', symbol: 'cspx ', name: '手動加的', layer: 'core', currency: 'USD', quantity: 1, price: 400 }],
  });
  const r = await syncIb(/** @type {any} */ (fakeParsed({
    positions: [{ symbol: 'CSPX', currency: 'USD', quantity: 10, marketPrice: 500, avgCost: 480 }],
  })));
  const rows = (store.load().holdings ?? []).filter(h => String(h.symbol).toUpperCase().trim() === 'CSPX');
  assert.equal(rows.length, 1, '同一檔標的只能有一列（大小寫／空白不同不算不同標的）');
  assert.equal(rows[0].quantity, 10, '應該更新既有那列的股數');
  assert.equal(r.updated, 1, '要算成「更新」');
  assert.equal(r.created, 0, '不可算成「新增」（那就是重複建立）');
});

test('IB 同步｜報表缺市價／均價 → 既有持股保留原值，不可覆寫成 0（市值無聲縮水）', async () => {
  // ⚠️ 上一行註解宣告的規則：「價格/均價『有值才設』（缺市價時不寫入誤導性的 0，避免靜默把市值算成 0）」。
  //    漏勾欄位或盤前跑報表都會缺 Market Price；覆寫成 0 ⇒ 該檔市值 0 ⇒ 淨資產無聲縮水、畫面零警告。
  store.save({
    ...store.emptyDb(),
    holdings: [{ id: 'h1', symbol: 'CSPX', name: 'ETF', layer: 'core', currency: 'USD', quantity: 5, price: 500, avgCost: 480 }],
  });
  await syncIb(/** @type {any} */ (fakeParsed({
    positions: [{ symbol: 'CSPX', currency: 'USD', quantity: 6 }],   // 缺 marketPrice 與 avgCost
  })));
  const h = (store.load().holdings ?? []).find(x => x.symbol === 'CSPX');
  assert.equal(h?.quantity, 6, '股數照更新（那是報表有給的）');
  assert.equal(h?.price, 500, '缺市價時要保留原價，不可寫成 0');
  assert.equal(h?.avgCost, 480, '缺均價時要保留原均價，不可寫成 0');
});
