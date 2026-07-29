import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SEC_METRIC_CANDIDATES,
  lookupSecTicker,
  normalizeSecCik,
  normalizeSecSymbol,
  parseSecCompanyFacts
} from '../lib/stock-fundamentals.js';
import { FUNDAMENTAL_METRIC_DEFINITIONS } from '../public/modules/stock-research-method.js';
import { sanitizeDbForWrite } from '../lib/schema.js';

const fixtureUrl = name => new URL(`./fixtures/sec/${name}`, import.meta.url);
const loadFixture = async name => JSON.parse(await readFile(fixtureUrl(name), 'utf8'));

test('SEC ticker／CIK｜正規化、補零、原型名與 URL 字元 fail-closed', async () => {
  const fixture = await loadFixture('fiscal-year-company.json');
  assert.deepEqual(lookupSecTicker(fixture.tickerIndex, ' fruit '), {
    symbol: 'FRUIT',
    cik: '0000900001',
    name: 'Synthetic Fruit Systems'
  });
  assert.equal(normalizeSecCik(900001), '0000900001');
  assert.equal(normalizeSecCik('0000900001'), '0000900001');
  assert.equal(normalizeSecSymbol('brk.b'), 'BRK.B');
  for (const symbol of ['__proto__', 'toString', 'AAPL/x', 'AAPL?x=1', '', 'A'.repeat(13)]) {
    assert.equal(normalizeSecSymbol(symbol), null, symbol);
    assert.equal(lookupSecTicker(fixture.tickerIndex, symbol), null, symbol);
  }
  for (const cik of [0, -1, '', '12345678901', '12x']) assert.equal(normalizeSecCik(cik), null);

  const ambiguous = {
    0: { cik_str: 1, ticker: 'DUP', title: 'First' },
    1: { cik_str: 2, ticker: 'DUP', title: 'Second' }
  };
  assert.equal(lookupSecTicker(ambiguous, 'DUP'), null, '同 ticker 指到不同 CIK 不可任選一家公司');
});

test('SEC 候選表｜與研究方法的 14 個官方指標逐項對齊', () => {
  const methodKeys = FUNDAMENTAL_METRIC_DEFINITIONS
    .filter(metric => metric.kind === 'official')
    .map(metric => metric.key)
    .sort();
  assert.deepEqual(Object.keys(SEC_METRIC_CANDIDATES).sort(), methodKeys);
  for (const definition of Object.values(SEC_METRIC_CANDIDATES)) {
    assert.ok(definition.tags.length);
    assert.equal(new Set(definition.tags).size, definition.tags.length);
  }
});

test('SEC 財年公司｜使用真實期間尾而非曆年，10-K/A 取代同期間舊值且來源可追回', async () => {
  const fixture = await loadFixture('fiscal-year-company.json');
  const before = JSON.stringify(fixture);
  const result = parseSecCompanyFacts({
    symbol: 'FRUIT',
    cik: '900001',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });
  assert.deepEqual(result.company, {
    cik: '0000900001',
    name: 'Synthetic Fruit Systems',
    sic: '3571',
    fiscalYearEnd: '0928'
  });
  assert.deepEqual(result.periods.annual.map(period => period.periodEnd), [
    '2022-09-25',
    '2023-09-24',
    '2024-09-29',
    '2025-09-28'
  ]);
  const latest = result.metrics.revenue.annual.at(-1);
  assert.equal(latest.value, 1850);
  assert.equal(latest.form, '10-K/A');
  assert.equal(latest.filedAt, '2025-11-20');
  assert.equal(latest.accession, '0000900001-25-000002');
  assert.equal(latest.taxonomy, 'us-gaap');
  assert.equal(latest.tag, 'RevenueFromContractWithCustomerExcludingAssessedTax');
  assert.equal(latest.unit, 'USD');
  assert.equal(
    latest.filingUrl,
    'https://www.sec.gov/Archives/edgar/data/900001/000090000125000002/0000900001-25-000002-index.html'
  );
  assert.equal(JSON.stringify(fixture), before, '純解析器不可修改 SEC 原始 JSON');
});

test('SEC 修訂值｜0 是合法新值；空字串不是 0，不可洗掉上一份有效 10-K', async () => {
  const fixture = await loadFixture('fiscal-year-company.json');
  const revenueRows = fixture.companyFacts.facts['us-gaap']
    .RevenueFromContractWithCustomerExcludingAssessedTax.units.USD;
  const amended = revenueRows.find(row => row.form === '10-K/A');
  amended.val = 0;
  const zeroResult = parseSecCompanyFacts({
    symbol: 'FRUIT',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });
  assert.equal(zeroResult.metrics.revenue.annual.at(-1).value, 0);
  assert.equal(zeroResult.metrics.revenue.annual.at(-1).form, '10-K/A');

  amended.val = '';
  const blankResult = parseSecCompanyFacts({
    symbol: 'FRUIT',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });
  assert.equal(blankResult.metrics.revenue.annual.at(-1).value, 1800);
  assert.equal(blankResult.metrics.revenue.annual.at(-1).form, '10-K');
});

test('SEC 單季｜Q2 三個月值勝出，六個月 YTD 不冒充單季，也不拿 10-K 推算 Q4', async () => {
  const fixture = await loadFixture('fiscal-year-company.json');
  const result = parseSecCompanyFacts({
    symbol: 'FRUIT',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });
  const quarter = result.metrics.revenue.latestQuarter;
  assert.equal(quarter.value, 600);
  assert.equal(quarter.periodStart, '2025-12-29');
  assert.equal(quarter.periodEnd, '2026-03-29');
  assert.equal(quarter.durationDays, 90);
  assert.deepEqual(result.periods.latestQuarter, {
    periodStart: '2025-12-29',
    periodEnd: '2026-03-29'
  });
  assert.ok(result.warnings.some(warning => (
    warning.code === 'YTD_EXCLUDED' && warning.metric === 'revenue'
  )));
  assert.notEqual(quarter.value, 1850 - 1100, 'Q4 不可用全年減 YTD 猜');
});

test('SEC 候選 tag｜第一個不存在時使用下一個標準 tag，不讀公司 extension', async () => {
  const calendar = await loadFixture('calendar-year-company.json');
  const calendarResult = parseSecCompanyFacts({
    symbol: 'CAL',
    submissions: calendar.submissions,
    companyFacts: calendar.companyFacts
  });
  assert.equal(calendarResult.metrics.revenue.tag, 'Revenues');

  const fiscal = await loadFixture('fiscal-year-company.json');
  const fiscalResult = parseSecCompanyFacts({
    symbol: 'FRUIT',
    submissions: fiscal.submissions,
    companyFacts: fiscal.companyFacts
  });
  assert.equal(fiscalResult.metrics.revenue.annual.at(-1).value, 1850);
  assert.notEqual(fiscalResult.metrics.revenue.annual.at(-1).value, 999999);
});

test('SEC unit｜同 tag 的 USD／EUR／shares 不混線，優先採 USD 並明確警告', async () => {
  const fixture = await loadFixture('calendar-year-company.json');
  const result = parseSecCompanyFacts({
    symbol: 'CAL',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });
  assert.equal(result.metrics.revenue.unit, 'USD');
  assert.deepEqual(result.metrics.revenue.annual.map(fact => fact.value), [2000, 2200, 2400, 2600]);
  assert.ok(result.warnings.some(warning => (
    warning.code === 'MULTIPLE_UNITS' && warning.metric === 'revenue'
  )));
});

test('SEC 缺 tag｜官方值維持 missing，依賴它的衍生值不猜數字', async () => {
  const fixture = await loadFixture('calendar-year-company.json');
  const result = parseSecCompanyFacts({
    symbol: 'CAL',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });
  assert.deepEqual(result.metrics.grossProfit.annual, []);
  assert.equal(result.metrics.grossProfit.status, 'missing');
  assert.equal(result.metrics.grossMargin.status, 'missing');
  assert.deepEqual(result.metrics.grossMargin.annual, []);
  assert.ok(result.warnings.some(warning => (
    warning.code === 'METRIC_MISSING' && warning.metric === 'grossProfit'
  )));
});

test('SEC 衍生公式｜自由現金流、比率、CAGR 與股數變化可由 inputs 原樣重算', async () => {
  const fixture = await loadFixture('fiscal-year-company.json');
  const result = parseSecCompanyFacts({
    symbol: 'FRUIT',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });

  const fcf = result.metrics.freeCashFlow.annual.at(-1);
  assert.equal(fcf.value, 400);
  assert.equal(
    fcf.value,
    fcf.inputs.operatingCashFlow.value - fcf.inputs.capitalExpenditure.value
  );
  assert.equal(fcf.formula, 'operatingCashFlow - capitalExpenditure');

  const fcfMargin = result.metrics.freeCashFlowMargin.annual.at(-1);
  assert.equal(fcfMargin.value, 400 / 1850);
  assert.equal(fcfMargin.inputs.freeCashFlow.formula, fcf.formula);
  assert.equal(fcfMargin.inputs.freeCashFlow.inputs.operatingCashFlow.value, 500);
  assert.equal(fcfMargin.value, fcfMargin.inputs.freeCashFlow.value / fcfMargin.inputs.revenue.value);

  assert.equal(result.metrics.operatingMargin.annual.at(-1).value, 400 / 1850);
  assert.equal(result.metrics.stockCompToRevenue.annual.at(-1).value, 50 / 1850);
  assert.equal(result.metrics.dilutedSharesChange.annual.at(-1).value, 98 / 100 - 1);

  const cagr = result.metrics.revenueCagr3y.annual.at(-1);
  assert.equal(
    cagr.value,
    (cagr.inputs.latestRevenue.value / cagr.inputs.earliestRevenue.value) ** (1 / cagr.years) - 1
  );
  assert.equal(cagr.inputs.earliestRevenue.periodEnd, '2022-09-25');
  assert.equal(cagr.inputs.latestRevenue.periodEnd, '2025-09-28');
});

test('SEC 0／負值｜官方 0 與負淨利保留；淨利 <= 0 時不硬算現金轉換', async () => {
  const fixture = await loadFixture('calendar-year-company.json');
  const result = parseSecCompanyFacts({
    symbol: 'CAL',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });
  assert.equal(result.metrics.operatingCashFlow.annual.at(-1).value, 0);
  assert.equal(result.metrics.netIncome.annual.at(-1).value, -10);
  assert.equal(result.metrics.cashConversion.status, 'missing');
  assert.deepEqual(result.metrics.cashConversion.annual, []);
});

test('SEC 輸入牆｜CIK 不一致、壞 ticker 與壞 payload 直接拒絕，不回半套公司', async () => {
  const fixture = await loadFixture('fiscal-year-company.json');
  assert.throws(() => parseSecCompanyFacts({
    symbol: 'FRUIT',
    cik: '42',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  }), /CIK/);
  assert.throws(() => parseSecCompanyFacts({
    symbol: 'FRUIT',
    cik: 'not-a-cik',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  }), /CIK/);
  assert.throws(() => parseSecCompanyFacts({
    symbol: '__proto__',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  }), /ticker/);
  assert.throws(() => parseSecCompanyFacts({
    symbol: 'FRUIT',
    submissions: null,
    companyFacts: fixture.companyFacts
  }), /格式/);
});

// ── 2026-07-29：解析結果必須真的存得進去 ─────────────────────────────────────
// 起因：GOOGL／AAPL／MSFT 的官方基本面在真環境一律 502，訊息是
//「data 不是合法的 SEC 解析結果——寫入端漏了驗證」。根因＝`derivedInput()` 無條件複製
// form／filedAt／accession／taxonomy／tag／filingUrl，而「衍生指標當輸入」時這些欄位不存在，
// 於是生出 `form: undefined` 這種鍵，被寫入櫃檯的 isSafeFundamentalsJson 當成非法型別整包拒收。
//
// 為什麼原本 14 題全綠：`JSON.stringify` 會把 undefined 鍵直接丟掉（GOOGL 實測 24 → 0）。
// fixture 從 JSON 進來、斷言也比對 JSON，**唯獨「解析器直接餵給寫入櫃檯」那一段沒人走過**——
// 與 XLSX 那五次繞過同一族：牆跟被保護的東西讀的不是同一份東西。
// 所以這兩題刻意都**不經過任何 JSON 來回**。

/** 走訪整棵樹，回報所有「值是 undefined」的鍵的路徑。 @param {any} value */
function undefinedKeyPaths(value, path = 'data', found = /** @type {string[]} */ ([])) {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) found.push(path);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => undefinedKeyPaths(item, `${path}[${index}]`, found));
    return found;
  }
  for (const key of Object.keys(value)) undefinedKeyPaths(value[key], `${path}.${key}`, found);
  return found;
}

test('SEC 解析｜輸出不得有任何 undefined 值的鍵（衍生指標當輸入時最容易生出來）', async () => {
  const fixture = await loadFixture('fiscal-year-company.json');
  const result = parseSecCompanyFacts({
    symbol: 'FRUIT',
    cik: '900001',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });

  // ⚠️ 先證明「受測的那條路真的跑了」——衍生指標拿另一個衍生指標當輸入。
  // 少了這段，哪天 fixture 變得算不出 freeCashFlowMargin，這題會無聲地變成空考題。
  const margin = result.metrics.freeCashFlowMargin;
  assert.equal(margin.status, 'available', 'fixture 必須算得出自由現金流率，否則本題等於沒考');
  const nested = margin.annual.find((/** @type {any} */ fact) => fact?.inputs?.freeCashFlow);
  assert.ok(nested, '必須有「輸入本身也是衍生指標」的那一筆，否則本題等於沒考');
  assert.equal(nested.inputs.freeCashFlow.metricKey, 'freeCashFlow');

  const paths = undefinedKeyPaths(result);
  assert.deepEqual(paths, [], `解析結果有 undefined 值的鍵：${paths.slice(0, 5).join('、')}`);
});

test('SEC 解析｜結果不經 JSON 直接送進正式寫入櫃檯，必須被收下', async () => {
  const fixture = await loadFixture('fiscal-year-company.json');
  const data = parseSecCompanyFacts({
    symbol: 'FRUIT',
    cik: '900001',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });
  assert.equal(data.metrics.freeCashFlowMargin.status, 'available', 'fixture 必須算得出自由現金流率');

  const at = '2026-07-29T00:00:00.000Z';
  // 形狀比照 lib/services/stock-fundamentals.js 成功時寫回快取的那一筆。
  const row = { symbol: 'FRUIT', lastAttemptAt: at, fetchedAt: at, data };
  const clean = /** @type {any} */ (sanitizeDbForWrite(
    { settings: {}, stockFundamentals: [row] },
    { mode: 'throw' }
  ));
  assert.equal(clean.stockFundamentals.length, 1, '整包被櫃檯拒收＝正式路徑會回 502');
  assert.equal(clean.stockFundamentals[0].data.metrics.freeCashFlowMargin.status, 'available');
});

test('SEC 解析｜衍生指標的輸入值是 0 時必須保留（不可用真值判斷篩欄位）', async () => {
  // 突變測試抓到的洞：把「只複製有值的欄位」寫成 `if (fact[field])` 也能讓上面兩題全綠，
  // 但那會連 `value: 0` 一起吃掉——畫面上就變成「尚未取得」，而 0 是官方真的會申報的數字
  // （Alphabet 2022 支付股利、2026Q1 股票回購都是 0）。現有 fixture 剛好沒有這個組合，
  // 所以在記憶體裡補一筆資本支出，讓自由現金流的輸入之一（營業現金流）正好是 0。
  const fixture = await loadFixture('calendar-year-company.json');
  const facts = fixture.companyFacts.facts['us-gaap'];
  assert.equal(
    facts.NetCashProvidedByUsedInOperatingActivities.units.USD.at(-1).val, 0,
    'fixture 的營業現金流必須是 0，否則本題等於沒考'
  );
  facts.PaymentsToAcquirePropertyPlantAndEquipment = {
    units: { USD: [{ start: '2025-01-01', end: '2025-12-31', form: '10-K', filed: '2026-02-01', accn: '0000900002-26-000001', fy: 2025, fp: 'FY', val: 100 }] }
  };

  const result = parseSecCompanyFacts({
    symbol: 'CAL',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });
  const freeCashFlow = result.metrics.freeCashFlow.annual.at(-1);
  assert.ok(freeCashFlow, '必須算得出自由現金流，否則本題等於沒考');
  assert.equal(freeCashFlow.value, -100);

  const cashFlowInput = freeCashFlow.inputs.operatingCashFlow;
  assert.ok(Object.hasOwn(cashFlowInput, 'value'), '值是 0 的輸入不可以整個鍵消失');
  assert.equal(cashFlowInput.value, 0);
  assert.deepEqual(undefinedKeyPaths(result), []);
});

test('SEC 解析｜衍生指標的官方輸入必須保留全部申報來源欄位（修 undefined 不可以順手弄丟追溯）', async () => {
  // ⚠️ Codex 定向複審 #351 指出的保存型缺口：上面三題只守「不可以有 undefined」與「0 要留著」，
  //    所以「從 DERIVED_INPUT_FIELDS 拿掉 filingUrl」這種修法會全綠通過——
  //    undefined 沒了、0 也在，但**點開數字追不回原始申報**，而「每個數字都追得到來源」
  //    正是這個功能存在的理由。少一個欄位就是少一條追溯路徑，而且畫面上只會安靜地變成空白。
  const fixture = await loadFixture('fiscal-year-company.json');
  const result = parseSecCompanyFacts({
    symbol: 'FRUIT',
    cik: '900001',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });

  const latest = result.metrics.operatingMargin.annual.at(-1);
  assert.ok(latest, '前置條件：fixture 必須算得出營業利益率，否則本題等於沒考');
  const official = latest.inputs.operatingIncome;
  assert.ok(official, '前置條件：它的輸入之一必須是官方申報指標（不是另一個衍生指標）');
  assert.equal(official.metricKey, 'operatingIncome');

  // 逐欄位點名：訊息要說得出「少了哪一個」，不然壞掉時只看到一句 deepEqual 失敗
  for (const field of ['value', 'unit', 'periodStart', 'periodEnd', 'form', 'filedAt', 'accession', 'taxonomy', 'tag', 'filingUrl']) {
    assert.ok(Object.hasOwn(official, field), `官方輸入少了 ${field}——追不回原始申報了`);
    assert.notEqual(official[field], '', `官方輸入的 ${field} 是空的`);
  }
  assert.match(official.filingUrl, /^https:\/\/www\.sec\.gov\//, 'filingUrl 要是可點的 SEC 連結');
  assert.equal(official.taxonomy, 'us-gaap');
  assert.equal(official.tag, 'OperatingIncomeLoss');
});
