import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatement } from '../lib/ib.js';

test('IB Flex 解析：持倉、現金流與多幣別成交損益維持同一口徑', () => {
  const parsed = parseStatement({
    FlexQueryResponse: {
      FlexStatements: {
        FlexStatement: {
          accountId: 'U-SYNTHETIC',
          fromDate: '20260101',
          toDate: '20261231',
          AccountInformation: { currency: 'USD' },
          OpenPositions: {
            OpenPosition: [
              { symbol: 'CSPX', description: 'Synthetic ETF', currency: 'USD', position: '2', costBasisMoney: '1000', markPrice: '600' },
              { symbol: 'ZERO', currency: 'USD', position: '0', costBasisPrice: '99', markPrice: '100' }
            ]
          },
          CashReport: {
            CashReportCurrency: [
              { currency: 'USD', endingSettledCash: '123.45' },
              { currency: 'BASE_SUMMARY', endingCash: '456.78' }
            ]
          },
          EquitySummaryInBase: {
            EquitySummaryByReportDateInBase: [
              { reportDate: '20260101', cash: '100', stock: '1000' },
              { reportDate: '20261231', cash: '-200', stock: '1500' }
            ]
          },
          CashTransactions: {
            CashTransaction: [
              { type: 'Dividends', currency: 'USD', amount: '10' },
              { type: 'Payment In Lieu Of Dividends', currency: 'GBP', amount: '8', fxRateToBase: '1.25' },
              { type: 'Withholding Tax', currency: 'JPY', amount: '-1000' },
              { type: 'Broker Interest Paid', currency: 'EUR', amount: '-5' },
              { type: 'Broker Interest Received', currency: 'USD', amount: '2' },
              { type: 'Other Fees', currency: 'USD', amount: '-3' }
            ]
          },
          Trades: {
            Trade: [
              { symbol: 'AAPL', tradeDate: '20260701', buySell: 'SELL', quantity: '-1', tradePrice: '200', netCash: '200', fifoPnlRealized: '50', currency: 'USD' },
              { symbol: 'CSPX', tradeDate: '20260702', buySell: 'SELL', quantity: '-2', tradePrice: '600', netCash: '1200', fifoPnlRealized: '20', currency: 'GBP', fxRateToBase: '1.25' },
              { symbol: 'EWJ', tradeDate: '20260703', buySell: 'SELL', quantity: '-3', tradePrice: '80', netCash: '240', fifoPnlRealized: '100', currency: 'JPY' }
            ]
          }
        }
      }
    }
  }, (currency) => currency === 'JPY' ? 0.007 : null);

  assert.equal(parsed.account, 'U-SYNTHETIC');
  assert.equal(parsed.accountCount, 1);
  assert.deepEqual(parsed.period, { from: '20260101', to: '20261231' });
  assert.deepEqual(parsed.positions, [{
    symbol: 'CSPX', description: 'Synthetic ETF', currency: 'USD', quantity: 2, avgCost: 500, marketPrice: 600
  }], '零股數列不應成為持倉；缺均價時以總成本除股數');
  assert.deepEqual(parsed.cashByCurrency, { USD: 123.45 });
  assert.equal(parsed.baseSummaryCash, 456.78);
  assert.deepEqual(parsed.equity, { cash: -200, stock: 1500, date: '20261231' }, '淨值摘要採報表最後一日');

  assert.deepEqual(parsed.income, {
    dividends: 10,
    paymentInLieu: 10,
    withholdingTax: -7,
    interestPaid: 0,
    interestReceived: 2,
    other: -3,
    count: 5,
    skippedNoFx: 1,
    skippedNoCurrency: 0,
    estimatedNoFx: 1,
    estimatedCurrencies: ['JPY']
  }, '外幣現金流依 IBKR 匯率、設定估算、缺匯率略過的順序換算');

  assert.deepEqual(parsed.trades.map(t => ({ symbol: t.symbol, pnl: t.pnl, pnlBase: t.pnlBase })), [
    { symbol: 'AAPL', pnl: 50, pnlBase: 50 },
    { symbol: 'CSPX', pnl: 20, pnlBase: 25 },
    { symbol: 'EWJ', pnl: 100, pnlBase: null }
  ], 'USD 直通、IBKR 匯率換算；非 USD 缺匯率不可冒充 USD');
});

// ---- 缺幣別不冒充 USD（2026-07-28 修；Codex gpt-5.6-sol 重審發現）----
// `securityTrades` 早就做到「缺 Currency 不猜 USD」，但持股／現金流／ibTrades 三條舊路沒跟上：
// Flex Query 少勾一個 Currency 欄，GBP 100 的股息就被當成 USD 100 加總（少算 27%），
// 而且 skippedNoFx 是 0＝畫面一個字都不會提。這正是專案自己禁止的「默默算錯」。
test('IB 解析｜現金交易缺幣別：有 fxRateToBase 照算；連匯率也沒有＝跳過並計入 skippedNoCurrency', () => {
  const parsed = parseStatement({
    FlexQueryResponse: { FlexStatements: { FlexStatement: {
      accountId: 'U-SYNTH',
      CashTransactions: { CashTransaction: [
        { type: 'Dividends', amount: '100', fxRateToBase: '1.27' },   // 缺幣別但有匯率 → 照算（換算正確）
        { type: 'Dividends', amount: '100' },                          // 缺幣別又缺匯率 → 不猜
        { type: 'Broker Interest Received', currency: 'USD', amount: '5' },
      ] },
    } } },
  }, () => null);
  assert.equal(parsed.income.dividends, 127, '有 fxRateToBase 就照算——那條路與幣別無關');
  assert.equal(parsed.income.skippedNoCurrency, 1, '缺幣別又缺匯率＝跳過，不可以當成 USD 100 加總');
  assert.equal(parsed.income.skippedNoFx, 0, '這是「缺幣別」不是「缺匯率」，兩種病要分開計數才修得對地方');
  assert.equal(parsed.income.interestReceived, 5, '正常的列不受影響');
});

test('IB 解析｜成交紀錄缺幣別：currency 留空、pnlBase 為 null（不當 USD 直通進 XIRR）', () => {
  const parsed = parseStatement({
    FlexQueryResponse: { FlexStatements: { FlexStatement: {
      accountId: 'U-SYNTH',
      Trades: { Trade: [
        { symbol: 'VWRL', tradeDate: '20260701', buySell: 'SELL', quantity: '-1', fifoPnlRealized: '20' },
        { symbol: 'VUAA', tradeDate: '20260702', buySell: 'SELL', quantity: '-1', fifoPnlRealized: '30', fxRateToBase: '1.27' },
      ] },
    } } },
  }, () => null);
  assert.equal(parsed.trades[0].currency, '', '不知道就說不知道');
  assert.equal(parsed.trades[0].pnlBase, null, '缺幣別又缺匯率＝算不出基準損益，不可以拿原值冒充');
  assert.equal(parsed.trades[1].pnlBase, 38.1, '有匯率照算（30 × 1.27）');
});

test('IB 解析｜持股缺幣別在 parse 層就是空字串（USD 預設只發生在同步寫入，已一併修掉）', () => {
  const parsed = parseStatement({
    FlexQueryResponse: { FlexStatements: { FlexStatement: {
      accountId: 'U-SYNTH',
      OpenPositions: { OpenPosition: { symbol: 'VWRL', position: '10', costBasisPrice: '80', markPrice: '100' } },
    } } },
  }, () => null);
  assert.equal(parsed.positions[0].currency, '');
});

test('列數上限：**跨 statement 累計**（10 份各 3 萬筆＝總量 30 萬筆，以前每份都沒超標就全放行）', async () => {
  const { MAX_IB_ROWS } = await import('../lib/parse-limits.js');
  // 每份都在上限之下（六成），但十份加起來遠遠超過
  const 每份 = Math.floor(MAX_IB_ROWS * 0.6);
  const 一筆 = { type: 'Dividends', amount: '1', currency: 'USD', fxRateToBase: '1' };
  const mkStmt = () => ({
    accountId: 'U-SYNTH', AccountInformation: { currency: 'USD' },
    CashTransactions: { CashTransaction: Array.from({ length: 每份 }, () => 一筆) },
  });

  assert.doesNotThrow(() => parseStatement({
    FlexQueryResponse: { FlexStatements: { FlexStatement: mkStmt() } },
  }, () => 1), '單獨一份在上限之下，必須照常放行');

  let err = /** @type {any} */ (null);
  try {
    parseStatement({
      FlexQueryResponse: { FlexStatements: { FlexStatement: [mkStmt(), mkStmt()] } },
    }, () => 1);
  } catch (e) { err = e; }
  assert.ok(err, '兩份加起來已經超過上限，卻沒被擋——「每份各自檢查」就是這樣被繞過的');
  assert.equal(err.status, 400);
  assert.match(err.message, /現金交易/);
});

// ---- 整條路真的有用到那兩道牆嗎（不是只有「函式本身是對的」）----------------
// ⚠️ 這兩題是補上來的：原本只考 readCappedText／assertXmlRowLimits **本身**，
//    結果把 lib/ib.js 改回 `res.text()`、或把 assertXmlRowLimits 整行刪掉，考題**全綠**。
//    純函式考題證明的是「牆蓋得對」，證明不了「牆有蓋在路上」。這兩題打的是真的 fetchFlex。

/** 假的 IB 伺服器：第一次回 SendRequest 的成功回應，第二次回你給的報表。 @param {string} statementXml */
function fakeIbFetch(statementXml) {
  let call = 0;
  return async () => {
    call++;
    const body = call === 1
      ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode><Url>https://x/GetStatement</Url></FlexStatementResponse>'
      : statementXml;
    const bytes = new TextEncoder().encode(body);
    return {
      ok: true,
      headers: { get: (/** @type {string} */ k) => (k === 'content-length' ? String(bytes.byteLength) : null) },
      body: (async function* () { yield bytes; })(),
    };
  };
}

test('整條路｜IB 回應過大：在 getText 就擋掉（不是等 res.text() 把它整包吃進記憶體）', async () => {
  const { fetchFlex } = await import('../lib/ib.js');
  const { MAX_IB_XML_BYTES } = await import('../lib/parse-limits.js');
  const real = globalThis.fetch;
  // 宣告一個超大的 Content-Length：走 readCappedText 會當場 400，走 res.text() 會開始收
  globalThis.fetch = /** @type {any} */ (async () => ({
    ok: true,
    headers: { get: (/** @type {string} */ k) => (k === 'content-length' ? String(MAX_IB_XML_BYTES + 1) : null) },
    body: { cancel: async () => {}, [Symbol.asyncIterator]: async function* () { yield new Uint8Array(1); } },
    text: async () => 'x'.repeat(10),          // ← 走舊路的話會拿到這個、然後一路無事通過
  }));
  try {
    const err = await fetchFlex('tok', 'qid', () => 1).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, 'IB 回了一個宣告 40MB+ 的回應，整條路竟然沒有擋——牆沒蓋在路上');
    assert.equal(err.code, 'xml_too_large');
    assert.equal(err.status, 400);
  } finally { globalThis.fetch = real; }
});

test('整條路｜列數上限擋在 parse 之前，而且涵蓋 OpenPosition（以前完全沒數）', async () => {
  const { fetchFlex } = await import('../lib/ib.js');
  const { MAX_IB_ROWS } = await import('../lib/parse-limits.js');
  const real = globalThis.fetch;
  // 20 萬筆持倉：parseStatement 對 OpenPosition **一條上限都沒有**，
  // 所以這一題只有「parse 之前用原始 XML 數」那道牆擋得到。
  const bomb = '<FlexQueryResponse><FlexStatements><FlexStatement accountId="U1">'
    + `<OpenPositions>${'<OpenPosition symbol="X" position="1"/>'.repeat(MAX_IB_ROWS + 1)}</OpenPositions>`
    + '</FlexStatement></FlexStatements></FlexQueryResponse>';
  globalThis.fetch = /** @type {any} */ (fakeIbFetch(bomb));
  try {
    const err = await fetchFlex('tok', 'qid', () => 1).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, '20 萬筆持倉暢行無阻——列數牆沒蓋在 parse 之前那條路上');
    assert.equal(err.code, 'ib_too_many_rows');
    assert.match(err.message, /持倉/);
  } finally { globalThis.fetch = real; }
});

test('整條路｜正常份量的報表照常解析得出來（上限不可以誤殺正常同步）', async () => {
  const { fetchFlex } = await import('../lib/ib.js');
  const ok = '<FlexQueryResponse><FlexStatements><FlexStatement accountId="U1" fromDate="20260101" toDate="20261231">'
    + '<AccountInformation currency="USD"/>'
    + '<OpenPositions><OpenPosition symbol="CSPX" currency="USD" position="2" costBasisPrice="500" markPrice="600"/></OpenPositions>'
    + '</FlexStatement></FlexStatements></FlexQueryResponse>';
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (fakeIbFetch(ok));
  try {
    const parsed = await fetchFlex('tok', 'qid', () => 1);
    assert.equal(parsed.positions.length, 1, '正常報表被擋掉了＝上限訂得有問題');
    assert.equal(parsed.positions[0].symbol, 'CSPX');
  } finally { globalThis.fetch = real; }
});
