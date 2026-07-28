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
