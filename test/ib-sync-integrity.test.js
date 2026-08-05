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

// ─────────────────────────────────────────────────────────────────────────────
// 二、Flex 取報表的錯誤處理：fail-closed 與 1019 白名單（lib/ib.js 三道）
// ─────────────────────────────────────────────────────────────────────────────

/** 假 IB 伺服器：依序回傳給定的 XML（第一份是 SendRequest 的回應）。
 * @param {string[]} xmls */
function fakeIbSequence(xmls) {
  let call = 0;
  return async () => {
    const body = xmls[Math.min(call++, xmls.length - 1)];
    const bytes = new TextEncoder().encode(body);
    return {
      ok: true,
      headers: { get: (/** @type {string} */ k) => (k === 'content-length' ? String(bytes.byteLength) : null) },
      body: (async function* () { yield bytes; })(),
    };
  };
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
    globalThis.fetch = /** @type {any} */ (fakeIbSequence([
      `<FlexStatementResponse>${statusTag}<ErrorMessage>Invalid token</ErrorMessage></FlexStatementResponse>`,
    ]));
    try {
      const err = await fetchFlex('tok', 'qid', () => 1).then(() => null, (/** @type {any} */ e) => e);
      assert.ok(err, `Status=${status}：IB 拒絕了請求，卻沒有擋下來`);
      assert.match(err.message, /Invalid token/,
        '要把 IB 給的原因原樣帶出來（不然使用者不知道是 Token 還是 Query ID 的問題）');
    } finally { globalThis.fetch = real; }
  }
});

test('IB 第二步｜非 1019 的錯誤碼立刻失敗（不可當成「還在產生中」重試到逾時）', async () => {
  // ⚠️ 1019＝報表還在產生中（唯一該重試的）。Token 過期、Query 被刪等真實錯誤若也被當成 1019，
  //    會重試 15 次共 45 秒，最後只吐「IB 報表準備逾時，請稍後再試」——
  //    把「可修的設定錯誤」講成「暫時性問題」，使用者會一直重試。
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (fakeIbSequence([
    SEND_OK,
    '<FlexStatementResponse><ErrorCode>1020</ErrorCode><ErrorMessage>Invalid request or unable to validate request.</ErrorMessage></FlexStatementResponse>',
  ]));
  try {
    const err = await fetchFlex('tok', 'qid', () => 1).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, '非 1019 的錯誤碼必須當場失敗');
    assert.match(err.message, /unable to validate request/, '要把 IB 的錯誤訊息帶出來');
    assert.doesNotMatch(err.message, /逾時/, '不可退化成「逾時」——那會把可修的錯講成暫時性問題');
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
  globalThis.fetch = /** @type {any} */ (fakeIbSequence([
    SEND_OK,
    '<FlexStatementResponse><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress.</ErrorMessage></FlexStatementResponse>',
    '<FlexQueryResponse><FlexStatements><FlexStatement accountId="U-RETRY">'
      + '<AccountInformation currency="USD"/></FlexStatement></FlexStatements></FlexQueryResponse>',
  ]));
  try {
    const parsed = await fetchFlex('tok', 'qid', () => 1);
    assert.equal(parsed.account, 'U-RETRY',
      '1019 之後的重試必須真的發生並拿到報表（拿不到＝白名單或重試上限壞了）');
  } finally { globalThis.fetch = real; }
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、同步寫回資料庫：壞值不可覆寫好值（lib/services/ib-sync.js 三道）
// ─────────────────────────────────────────────────────────────────────────────

test('IB 同步｜官方淨值的 cash/stock 是壞值 → lastEquity 丟棄走自算，不可讓「無融資」的假象藏起風險', async () => {
  // ⚠️ 這是全檔最要緊的一條：壞值存進 lastEquity 之後，computeLeverage 會用它算槓桿與斷頭距離，
  //    而失真方向剛好是最危險的那一邊——「看起來沒有融資」。AGENTS 鐵則：槓桿上限 1.3x。
  for (const badEquity of [
    { stock: 5000, cash: Number.NaN },
    { stock: 5000, cash: '一千' },
    { stock: 5000 },                     // 缺 cash 欄
    { cash: 1000 },                      // 缺 stock 欄
  ]) {
    store.save({ ...store.emptyDb() });
    await syncIb(/** @type {any} */ (fakeParsed({ equity: badEquity })));
    const saved = store.load().settings?.ib?.lastEquity ?? null;
    assert.equal(saved, null,
      `equity=${JSON.stringify(badEquity)}：壞的官方淨值必須丟棄（回 null 走 fallback 自算），`
      + '存進去會讓槓桿與斷頭距離靜默失真，而且方向是「看起來沒有融資」');
  }
  // 反面：合法的官方淨值要照存（避免整段被關掉也綠）。
  store.save({ ...store.emptyDb() });
  await syncIb(/** @type {any} */ (fakeParsed({ equity: { stock: 5000, cash: -1200 } })));
  assert.deepEqual(store.load().settings?.ib?.lastEquity, { stock: 5000, cash: -1200 },
    '合法官方淨值（含負現金＝融資）要照存，不可誤丟');
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
