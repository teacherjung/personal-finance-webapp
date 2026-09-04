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
  }, '外幣現金流依 IBKR 匯率、設定或預設估算、估算器回 null（不支援的幣別）才略過的順序換算');

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
test('IB 解析｜現金交易缺幣別：有「正的」fxRateToBase 照算；連有效匯率也沒有＝跳過並計入 skippedNoCurrency', () => {
  const parsed = parseStatement({
    FlexQueryResponse: { FlexStatements: { FlexStatement: {
      accountId: 'U-SYNTH',
      CashTransactions: { CashTransaction: [
        { type: 'Dividends', amount: '100', fxRateToBase: '1.27' },   // 缺幣別但有「正的」匯率 → 照算（換算正確；0／負數不算數＝`test/ib-sync-integrity.test.js` 的「IB 現金流｜fxRateToBase 是 0 或負數」那題）
        { type: 'Dividends', amount: '100' },                          // 缺幣別又沒有有效匯率 → 不猜
        { type: 'Dividends', amount: '100', fxRateToBase: '0' },      // 缺幣別＋壞匯率（0）→ 計入 skippedNoCurrency、不進 skippedNoFx
        { type: 'Dividends', amount: '100', fxRateToBase: '-1' },     // 缺幣別＋壞匯率（負數）→ 計入 skippedNoCurrency、不進 skippedNoFx
        { type: 'Broker Interest Received', currency: 'USD', amount: '5' },
      ] },
    } } },
  }, () => null);
  assert.equal(parsed.income.dividends, 127, '有「正的」fxRateToBase 就照算——fxRateToBase 分支與幣別無關（0／負數＝壞值）');
  assert.equal(parsed.income.skippedNoCurrency, 3, '缺幣別且沒有有效匯率（缺、0、負數）＝三列都跳過，不可以當成 USD 100 加總');
  assert.equal(parsed.income.skippedNoFx, 0, '這是「缺幣別」不是「缺匯率」，兩種病要分開計數才修得對地方');
  assert.equal(parsed.income.interestReceived, 5, '正常的列不受影響');
});

test('IB 解析｜成交紀錄缺幣別且沒有有效匯率：currency 留空、pnlBase 為 null（不當 USD 直通進 XIRR）；有正匯率仍照算', () => {
  const parsed = parseStatement({
    FlexQueryResponse: { FlexStatements: { FlexStatement: {
      accountId: 'U-SYNTH',
      Trades: { Trade: [
        { symbol: 'VWRL', tradeDate: '20260701', buySell: 'SELL', quantity: '-1', fifoPnlRealized: '20' },
        { symbol: 'VUAA', tradeDate: '20260702', buySell: 'SELL', quantity: '-1', fifoPnlRealized: '30', fxRateToBase: '1.27' },
        { symbol: 'VEVE', tradeDate: '20260703', buySell: 'SELL', quantity: '-1', fifoPnlRealized: '40', fxRateToBase: '0' },
      ] },
    } } },
  }, () => null);
  assert.equal(parsed.trades[0].currency, '', '不知道就說不知道');
  assert.equal(parsed.trades[0].pnlBase, null, '缺幣別又沒有有效匯率＝算不出基準損益，不可以拿原值冒充');
  assert.equal(parsed.trades[1].pnlBase, 38.1, '有「正的」匯率照算（30 × 1.27）——缺幣別不擋 fxRateToBase 分支');
  assert.equal(parsed.trades[2].pnlBase, null, '缺幣別＋壞匯率（0）＝沒有有效匯率，pnlBase 要 null');
  assert.equal(parsed.trades[2].fxRateToBase, null, '壞匯率不可原樣入庫');
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

// ============================================================================
// 元素總數上限（Codex 收官審查 #1，2026-07-28）
// ============================================================================
//
// 病根不是「白名單漏了幾個標籤」，是**兩件事**：
//   ① `IB_ROW_TAGS` 是白名單，只數四種標籤——IB 官方還有 CorporateAction／Transfer／
//      InterestAccrual 等十幾種區段完全不受約束（實測 50,001 筆 `<CorporateAction/>` 通過）。
//   ② `MAX_IB_XML_CHARS = 40MB` 本身就是死亡線：實測 40MB 真實排版直接 OOM 打死行程，
//      而那是一份**完全合法、完全被列數牆數到**的報表。把更多標籤加進白名單修不好這個。

test('整條路｜白名單以外的區段也要擋（不然加幾個標籤名就被繞過）', async () => {
  const { fetchFlex } = await import('../lib/ib.js');
  const { MAX_IB_XML_ELEMENTS } = await import('../lib/parse-limits.js');
  const real = globalThis.fetch;
  // CorporateAction 不在 IB_ROW_TAGS 裡，但它是 IB 官方 Flex Query 真的會產生的區段
  const rows = '<CorporateAction/>'.repeat(MAX_IB_XML_ELEMENTS + 10);
  const xml = `<FlexQueryResponse><FlexStatements count="1"><FlexStatement><CorporateActions>${rows}</CorporateActions></FlexStatement></FlexStatements></FlexQueryResponse>`;
  globalThis.fetch = /** @type {any} */ (fakeIbFetch(xml));
  try {
    const err = await fetchFlex('tok', 'qid', () => 1).then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, '白名單以外的區段暢行無阻——總量牆沒蓋在 parse 之前那條路上');
    assert.equal(err.code, 'ib_too_many_elements');
    assert.equal(err.status, 400);
    assert.match(err.message, /縮短/, '訊息要告訴使用者「該做什麼」');
  } finally { globalThis.fetch = real; }
});

test('整條路｜連「還沒出現過的未來區段」也要擋（防止有人把牆改回白名單）', async () => {
  // ⚠️ 這一題**刻意不寫死任何真實標籤名**。寫死的話，下一個人把總量牆改回
  //    「再加四個名字進 IB_ROW_TAGS」也照樣綠——那正是 Codex #1 的原病。
  const { fetchFlex } = await import('../lib/ib.js');
  const { MAX_IB_XML_ELEMENTS } = await import('../lib/parse-limits.js');
  const real = globalThis.fetch;
  try {
    // ⚠️ 標籤名要**短**：`<FutureSectionWeHaventSeen/>` 是 28 bytes，50 萬個就是 14MB，
    //    會先撞到位元組上限（那也是對的，只是不是這一題要考的東西）。
    //    這裡要單獨考「元素數」這道牆，所以讓位元組數遠低於上限。
    //    `Zq9` 是刻意虛構的名字——**這一題的重點就是「連沒見過的區段也要擋」**，
    //    寫死真實標籤名的話，下一個人把牆改回白名單也照樣綠。
    for (const tag of ['Transfer', 'IntAcc', 'Zq9', 'Xyz']) {
      const xml = `<FlexQueryResponse><FlexStatements count="1"><FlexStatement>${`<${tag}/>`.repeat(MAX_IB_XML_ELEMENTS + 10)}</FlexStatement></FlexStatements></FlexQueryResponse>`;
      globalThis.fetch = /** @type {any} */ (fakeIbFetch(xml));
      const err = await fetchFlex('tok', 'qid', () => 1).then(() => null, (/** @type {any} */ e) => e);
      assert.equal(err?.code, 'ib_too_many_elements', `<${tag}> 沒被擋——牆退化成白名單了`);
    }
  } finally { globalThis.fetch = real; }
});

test('位元組上限是「從 512MB 這台機器推導出來」的，不是憑感覺——用子行程真的驗一次', async () => {
  // ⚠️ 這一題是整組裡最重要的：它把「40MB 是怎麼來的」從註解變成**可重跑的事實**。
  //    舊的 40MB 沒有任何量測背書，而實測它就是死亡線。這一題會在有人把上限調回去時直接紅。
  const { spawnSync } = await import('node:child_process');
  const { MAX_IB_XML_CHARS } = await import('../lib/parse-limits.js');
  // 餵一份**剛好等於上限**、且用真實 IB 排版（50 個屬性、合法巢狀）的 XML，子行程必須活著跑完。
  // 列樣板與筆數在父行程算好注入，子行程回報實際解析列數——「活著」與「解析完整」是兩件事。
  const { XMLValidator } = await import('fast-xml-parser');
  const ATTRS = Array.from({ length: 50 }, (_, i) => `a${i}="v${i}0000"`).join(' ');
  const one = `<Trade ${ATTRS}/>`;
  const n = Math.floor(MAX_IB_XML_CHARS / one.length);
  const HEAD = '<FlexQueryResponse><FlexStatements count="1"><FlexStatement><Trades>';
  const TAIL = '</Trades></FlexStatement></FlexStatements></FlexQueryResponse>';
  assert.equal(XMLValidator.validate(HEAD + one.repeat(3) + TAIL), true,
    '考題的排版必須是合法巢狀——閉合順序寫錯過一次，解析器不驗證照樣過，但那就不是真實 IB 排版了');
  const script = `
    const { XMLParser } = await import('fast-xml-parser');
    const one = ${JSON.stringify(one)};
    const xml = ${JSON.stringify(HEAD)} + one.repeat(${n}) + ${JSON.stringify(TAIL)};
    const doc = new XMLParser({ignoreAttributes:false, attributeNamePrefix:''}).parse(xml);
    const trades = doc?.FlexQueryResponse?.FlexStatements?.FlexStatement?.Trades?.Trade;
    console.log('rows=' + (Array.isArray(trades) ? trades.length : (trades ? 1 : 0)));
  `;
  const r = spawnSync(process.execPath, ['--max-old-space-size=400', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0,
    `一份剛好等於上限（${Math.round(MAX_IB_XML_CHARS / 1048576)}MB）的真實排版報表，` +
    `在模擬 Render 的 400MB heap 下必須解析得完。實際 exit=${r.status} signal=${r.signal}。\n` +
    '這一題紅了代表 MAX_IB_XML_CHARS 訂得太高——它必須從目標機器的記憶體推導，不是憑感覺。');
  assert.equal(r.stdout.trim(), `rows=${n}`,
    '子行程活著 ≠ 解析完整：解析出的 Trade 列數必須等於餵進去的筆數，解析器靜默丟列也要紅');
});

test('元素上限對真實報表要有兩個數量級以上的餘裕（別把牆訂到誤殺）', async () => {
  const { MAX_IB_XML_ELEMENTS, MAX_IB_XML_CHARS, countXmlElements } = await import('../lib/parse-limits.js');
  // 一份「塞滿到位元組上限」的真實排版報表有多少元素？
  const ATTRS = Array.from({ length: 50 }, (_, i) => `a${i}="v${i}0000"`).join(' ');
  const one = `<Trade ${ATTRS}/>`;
  const realistic = Math.floor(MAX_IB_XML_CHARS / one.length);
  assert.ok(MAX_IB_XML_ELEMENTS / realistic >= 20,
    `元素上限對「塞滿的真實報表」（${realistic} 個元素）只有 ${(MAX_IB_XML_ELEMENTS / realistic).toFixed(1)} 倍餘裕，太緊`);
  // 而且 countXmlElements 不可以把關標籤／宣告／註解算進去
  assert.equal(countXmlElements('<a/><b></b><!-- x --><?xml v?>'), 2,
    '只數開標籤：</close>、<!--註解-->、<?宣告?> 都不算');
});
