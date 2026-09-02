import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SecDataContractError,
  SEC_METRIC_CANDIDATES,
  currentDebtLabelAccessions,
  lookupSecTicker,
  normalizeSecCik,
  normalizeSecSymbol,
  parseCurrentDebtLabelHint,
  parseSecCompanyFacts
} from '../lib/stock-fundamentals.js';
import {
  FUNDAMENTAL_METRIC_DEFINITIONS,
  comparableFundamentalSeries
} from '../public/modules/stock-research-method.js';
import { sanitizeDbForWrite } from '../lib/schema.js';

const fixtureUrl = name => new URL(`./fixtures/sec/${name}`, import.meta.url);
const loadFixture = async name => JSON.parse(await readFile(fixtureUrl(name), 'utf8'));

const CURRENT_DEBT_CIK = '0000900099';
const CURRENT_DEBT_ACCESSION = '0000900099-25-000001';

/** @param {number} val @param {Partial<Record<string, any>>} [overrides] */
function currentDebtRow(val, overrides = {}) {
  return {
    end: '2025-03-31',
    form: '10-Q',
    filed: '2025-05-01',
    accn: CURRENT_DEBT_ACCESSION,
    fy: 2025,
    fp: 'Q1',
    val,
    ...overrides
  };
}

/** @param {Record<string, any[]>} concepts @param {Record<string, string>} [currentDebtLabelHints] */
function parseCurrentDebtFixture(concepts, currentDebtLabelHints = {}) {
  return parseSecCompanyFacts({
    symbol: 'DEBT',
    cik: CURRENT_DEBT_CIK,
    submissions: {
      cik: CURRENT_DEBT_CIK,
      name: 'Synthetic Current Debt Company',
      sic: '3571',
      fiscalYearEnd: '1231'
    },
    companyFacts: {
      cik: CURRENT_DEBT_CIK,
      entityName: 'Synthetic Current Debt Company',
      facts: {
        'us-gaap': Object.fromEntries(Object.entries(concepts).map(([tag, rows]) => [
          tag,
          { units: { USD: rows } }
        ]))
      }
    },
    currentDebtLabelHints
  });
}

/** @param {string} tag @param {number} value @param {Partial<Record<string, any>>} [overrides] */
function expectedCurrentDebtFact(tag, value, overrides = {}) {
  return {
    value,
    unit: 'USD',
    periodStart: null,
    periodEnd: '2025-03-31',
    form: '10-Q',
    filedAt: '2025-05-01',
    accession: CURRENT_DEBT_ACCESSION,
    taxonomy: 'us-gaap',
    tag,
    filingUrl: 'https://www.sec.gov/Archives/edgar/data/900099/000090009925000001/0000900099-25-000001-index.html',
    fiscalYear: 2025,
    fiscalPeriod: 'Q1',
    periodType: 'quarter',
    durationDays: null,
    ...overrides
  };
}

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
  assert.deepEqual(SEC_METRIC_CANDIDATES.revenue.tags, [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'SalesRevenueNet'
  ], '營收候選順序就是同期間語意優先序：總額必須在合約收入成分之前');
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
  assert.equal(result.periods.latestQuarterBasis, 'per-metric');
  assert.ok(result.warnings.some(warning => (
    warning.code === 'YTD_EXCLUDED' && warning.metric === 'revenue'
  )));
  assert.notEqual(quarter.value, 1850 - 1100, 'Q4 不可用全年減 YTD 猜');
});

test('SEC 單季期間｜保留各列最新合法值，期間不齊時 payload 明示並警告', async () => {
  const fixture = await loadFixture('fiscal-year-company.json');
  fixture.companyFacts.facts['us-gaap'].NetIncomeLoss = {
    units: {
      USD: [{
        start: '2026-03-30',
        end: '2026-06-28',
        val: 900,
        accn: '0000900001-26-000003',
        fy: 2026,
        fp: 'Q3',
        form: '10-Q',
        filed: '2026-07-30'
      }]
    }
  };
  const result = parseSecCompanyFacts({
    symbol: 'FRUIT',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  });

  assert.equal(result.metrics.revenue.latestQuarter.periodEnd, '2026-03-29');
  assert.equal(result.metrics.netIncome.latestQuarter.periodEnd, '2026-06-28');
  assert.equal(result.periods.latestQuarterBasis, 'per-metric');
  assert.ok(result.warnings.some(warning => (
    warning.code === 'QUARTER_PERIOD_MISMATCH'
      && /2026-03-29/.test(warning.message)
      && /2026-06-28/.test(warning.message)
  )));
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
  }), (e) => e instanceof SecDataContractError && /CIK/.test(e.message));
  assert.throws(() => parseSecCompanyFacts({
    symbol: 'FRUIT',
    cik: 'not-a-cik',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  }), (e) => e instanceof SecDataContractError && /CIK/.test(e.message));
  assert.throws(() => parseSecCompanyFacts({
    symbol: '__proto__',
    submissions: fixture.submissions,
    companyFacts: fixture.companyFacts
  }), (e) => e instanceof SecDataContractError && /ticker/.test(e.message));
  assert.throws(() => parseSecCompanyFacts({
    symbol: 'FRUIT',
    submissions: null,
    companyFacts: fixture.companyFacts
  }), (e) => e instanceof SecDataContractError && /格式/.test(e.message));
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

test('currentDebt 契約｜總額／短借／一年內長債只有一份定義；noncurrentDebt 釘住兩顆候選與順序', () => {
  const currentDebt = /** @type {any} */ (SEC_METRIC_CANDIDATES.currentDebt);
  assert.deepEqual(currentDebt.currentDebtSources, {
    total: ['DebtCurrent'],
    shortTerm: ['ShortTermBorrowings'],
    currentMaturity: [
      'LongTermDebtAndCapitalLeaseObligationsCurrent',
      'LongTermDebtCurrent'
    ]
  });
  assert.deepEqual(
    currentDebt.tags,
    Object.values(currentDebt.currentDebtSources).flat(),
    '所有讀取端都必須從 currentDebtSources 展開，不能另抄 tag 群'
  );
  assert.ok(!currentDebt.tags.includes('LongTermDebtAndFinanceLeaseObligationsCurrent'));
  assert.deepEqual(SEC_METRIC_CANDIDATES.noncurrentDebt.tags, [
    'LongTermDebtAndCapitalLeaseObligations',
    'LongTermDebtNoncurrent'
  ], '非流動也是「含租賃的寬口徑」先於「不含租賃的窄口徑」，與 currentMaturity 同形');
});

test('currentDebt 單一來源｜只有短借或一年內長債時，整個官方 metric 與 fact 原樣保留', () => {
  for (const [tag, value] of [
    ['ShortTermBorrowings', 123],
    ['LongTermDebtAndCapitalLeaseObligationsCurrent', 345],
    ['LongTermDebtCurrent', 456]
  ]) {
    const result = parseCurrentDebtFixture({ [tag]: [currentDebtRow(value)] });
    const fact = expectedCurrentDebtFact(tag, value);
    assert.deepEqual(result.metrics.currentDebt, {
      key: 'currentDebt',
      label: '流動債務',
      kind: 'official',
      nature: 'instant',
      taxonomy: 'us-gaap',
      tag,
      unit: 'USD',
      annual: [],
      latestQuarter: fact,
      status: 'available'
    });
  }
});

test('currentDebt 總額優先｜同期間有 DebtCurrent 時忽略兩個成分，不做第二次相加', () => {
  const result = parseCurrentDebtFixture({
    DebtCurrent: [currentDebtRow(400_262_000)],
    ShortTermBorrowings: [currentDebtRow(400_262_000)],
    LongTermDebtCurrent: [currentDebtRow(399_579_000)]
  }, {
    [CURRENT_DEBT_ACCESSION]: 'short-term-only'
  });
  assert.deepEqual(
    result.metrics.currentDebt.latestQuarter,
    expectedCurrentDebtFact('DebtCurrent', 400_262_000)
  );
});

test('currentDebt 總額逐期優先｜舊期 DebtCurrent 不可遮掉較新一期可安全相加的成分', () => {
  const result = parseCurrentDebtFixture({
    DebtCurrent: [currentDebtRow(300, {
      end: '2024-03-31',
      filed: '2024-05-01',
      accn: '0000900099-24-000001',
      fy: 2024
    })],
    ShortTermBorrowings: [currentDebtRow(600)],
    LongTermDebtCurrent: [currentDebtRow(500)]
  }, {
    [CURRENT_DEBT_ACCESSION]: 'short-term-only'
  });
  assert.equal(result.metrics.currentDebt.latestQuarter.value, 1100);
  assert.equal(result.metrics.currentDebt.latestQuarter.periodEnd, '2025-03-31');
  assert.equal(result.metrics.currentDebt.latestQuarter.taxonomy, 'derived');
});

test('currentDebt filer label｜只採申報者 terse／verbose label，標準 label 不拿來猜父子關係', () => {
  const standard = '<link:label xlink:label="lab_us-gaap_ShortTermBorrowings" xlink:role="http://www.xbrl.org/2003/role/label">Short-Term Debt</link:label>';
  const dover = '<link:label xlink:label="lab_us-gaap_ShortTermBorrowings" xlink:role="http://www.xbrl.org/2003/role/terseLabel">Short-term borrowings and current portion of long-term debt</link:label>';
  const amazon = '<link:label xlink:label="lab_us-gaap_ShortTermBorrowings" xlink:role="http://www.xbrl.org/2003/role/terseLabel">Short-term debt</link:label>';
  assert.equal(parseCurrentDebtLabelHint(standard), 'unknown');
  assert.equal(parseCurrentDebtLabelHint(dover), 'includes-current-long-term-debt');
  assert.equal(parseCurrentDebtLabelHint(amazon), 'short-term-only');
});

test('currentDebt Dover 型｜ShortTermBorrowings label 已含一年內長債，不可高報 99.8%', () => {
  const result = parseCurrentDebtFixture({
    ShortTermBorrowings: [currentDebtRow(400_262_000)],
    LongTermDebtCurrent: [currentDebtRow(399_579_000)]
  }, {
    [CURRENT_DEBT_ACCESSION]: 'includes-current-long-term-debt'
  });
  assert.deepEqual(
    result.metrics.currentDebt.latestQuarter,
    expectedCurrentDebtFact('ShortTermBorrowings', 400_262_000)
  );
  assert.notEqual(result.metrics.currentDebt.latestQuarter.value, 799_841_000);
});

test('currentDebt 分開申報型｜filer label 證明是純短債時，短債與一年內長債都不能漏報', () => {
  const result = parseCurrentDebtFixture({
    ShortTermBorrowings: [currentDebtRow(76_000_000)],
    LongTermDebtCurrent: [currentDebtRow(5_014_000_000)]
  }, {
    [CURRENT_DEBT_ACCESSION]: 'short-term-only'
  });
  const fact = result.metrics.currentDebt.latestQuarter;
  assert.equal(fact.value, 5_090_000_000);
  assert.equal(fact.taxonomy, 'derived');
  assert.equal(fact.tag, 'ShortTermBorrowings + LongTermDebtCurrent');
  assert.equal(fact.formula, fact.tag);
  assert.equal(fact.inputs.shortTerm.value, 76_000_000);
  assert.equal(fact.inputs.currentMaturity.value, 5_014_000_000);
  assert.equal(fact.accession, CURRENT_DEBT_ACCESSION);
  assert.match(fact.filingUrl, /^https:\/\/www\.sec\.gov\//);
});

test('currentDebt 無 label｜同脈絡且短借小於一年內長債才可排除父子重疊；反之保守不加', () => {
  const separate = parseCurrentDebtFixture({
    ShortTermBorrowings: [currentDebtRow(76)],
    LongTermDebtCurrent: [currentDebtRow(5_014)]
  });
  assert.equal(separate.metrics.currentDebt.latestQuarter.value, 5_090);
  assert.equal(separate.metrics.currentDebt.latestQuarter.taxonomy, 'derived');

  const ambiguous = parseCurrentDebtFixture({
    ShortTermBorrowings: [currentDebtRow(400_262)],
    LongTermDebtCurrent: [currentDebtRow(399_579)]
  });
  assert.deepEqual(
    ambiguous.metrics.currentDebt.latestQuarter,
    expectedCurrentDebtFact('ShortTermBorrowings', 400_262)
  );
  assert.ok(ambiguous.warnings.some(warning => (
    warning.code === 'CURRENT_DEBT_OVERLAP_UNRESOLVED'
      && warning.metric === 'currentDebt'
  )));
});

test('currentDebt 缺一組的年度｜每期都原樣保留，不因另一組只在別年出現就整期消失或加旗標', () => {
  const shortRow = currentDebtRow(100, {
    end: '2023-12-31',
    form: '10-K',
    filed: '2024-02-01',
    accn: '0000900099-24-000001',
    fy: 2023,
    fp: 'FY'
  });
  const maturityRow = currentDebtRow(200, {
    end: '2024-12-31',
    form: '10-K',
    filed: '2025-02-01',
    accn: '0000900099-25-000002',
    fy: 2024,
    fp: 'FY'
  });
  const result = parseCurrentDebtFixture({
    ShortTermBorrowings: [shortRow],
    LongTermDebtCurrent: [maturityRow]
  });
  assert.deepEqual(result.metrics.currentDebt.annual, [
    expectedCurrentDebtFact('ShortTermBorrowings', 100, {
      periodEnd: '2023-12-31',
      form: '10-K',
      filedAt: '2024-02-01',
      accession: '0000900099-24-000001',
      filingUrl: 'https://www.sec.gov/Archives/edgar/data/900099/000090009924000001/0000900099-24-000001-index.html',
      fiscalYear: 2023,
      fiscalPeriod: 'FY',
      periodType: 'annual'
    }),
    expectedCurrentDebtFact('LongTermDebtCurrent', 200, {
      periodEnd: '2024-12-31',
      form: '10-K',
      filedAt: '2025-02-01',
      accession: '0000900099-25-000002',
      filingUrl: 'https://www.sec.gov/Archives/edgar/data/900099/000090009925000002/0000900099-25-000002-index.html',
      fiscalYear: 2024,
      fiscalPeriod: 'FY',
      periodType: 'annual'
    })
  ]);
});

test('currentDebt 保存型｜currentMaturity 同群維持 first-hit，低順位 tag 不接力新舊期間', () => {
  const annualRow = (year, value) => currentDebtRow(value, {
    end: `${year}-12-31`,
    form: '10-K',
    filed: `${year + 1}-02-01`,
    accn: `0000900099-${String(year + 1).slice(2)}-000001`,
    fy: year,
    fp: 'FY'
  });
  const result = parseCurrentDebtFixture({
    ShortTermBorrowings: [annualRow(2023, 100), annualRow(2024, 100), annualRow(2025, 100)],
    LongTermDebtAndCapitalLeaseObligationsCurrent: [annualRow(2024, 300)],
    LongTermDebtCurrent: [annualRow(2023, 200), annualRow(2025, 500)]
  });

  assert.deepEqual(
    result.metrics.currentDebt.annual.map(fact => [fact.periodEnd, fact.value, fact.tag]),
    [
      ['2023-12-31', 100, 'ShortTermBorrowings'],
      ['2024-12-31', 400, 'ShortTermBorrowings + LongTermDebtAndCapitalLeaseObligationsCurrent'],
      ['2025-12-31', 100, 'ShortTermBorrowings']
    ],
    '破壞 currentMaturity 群的 first-hit 會把 2025 從 100 改成 600'
  );
});

test('currentDebt 衍生列｜F5 所需的 row-level taxonomy/tag 齊全，且不經 JSON 可通過正式寫入牆', () => {
  const accessions = ['0000900099-24-000001', '0000900099-25-000001'];
  const years = [2023, 2024];
  const shortRows = years.map((year, index) => currentDebtRow(10 + index, {
    end: `${year}-12-31`,
    form: '10-K',
    filed: `${year + 1}-02-01`,
    accn: accessions[index],
    fy: year,
    fp: 'FY'
  }));
  const maturityRows = years.map((year, index) => currentDebtRow(100 + index, {
    end: `${year}-12-31`,
    form: '10-K',
    filed: `${year + 1}-02-01`,
    accn: accessions[index],
    fy: year,
    fp: 'FY'
  }));
  const result = parseCurrentDebtFixture({
    ShortTermBorrowings: shortRows,
    LongTermDebtCurrent: maturityRows
  }, Object.fromEntries(accessions.map(accession => [accession, 'short-term-only'])));
  assert.equal(result.metrics.currentDebt.annual.length, 2);
  assert.ok(result.metrics.currentDebt.annual.every(fact => (
    fact.taxonomy === 'derived'
      && fact.tag === 'ShortTermBorrowings + LongTermDebtCurrent'
      && fact.formula === fact.tag
  )));
  const f5 = comparableFundamentalSeries(result.metrics.currentDebt.annual);
  assert.notEqual(f5.status, 'missing');
  assert.ok(f5.availablePoints.every(point => point.taxonomy && point.tag));

  const at = '2026-07-30T00:00:00.000Z';
  const clean = /** @type {any} */ (sanitizeDbForWrite({
    settings: {},
    stockFundamentals: [{ symbol: 'DEBT', lastAttemptAt: at, fetchedAt: at, data: result }]
  }, { mode: 'throw' }));
  assert.equal(clean.stockFundamentals[0].data.metrics.currentDebt.annual[1].value, 112);
});

test('currentDebt label accession｜只抓同一 accession 同時有兩個成分者，並以定義表為來源', () => {
  const companyFacts = {
    facts: {
      'us-gaap': {
        ShortTermBorrowings: {
          units: { USD: [currentDebtRow(10), currentDebtRow(20, { accn: '0000900099-24-000001', filed: '2024-05-01' })] }
        },
        LongTermDebtCurrent: {
          units: { USD: [currentDebtRow(100)] }
        }
      }
    }
  };
  assert.deepEqual(currentDebtLabelAccessions(companyFacts), [CURRENT_DEBT_ACCESSION]);
});

test('currentDebt source shape｜正式碼不得硬寫第二份 tag 群，兩種展示過的繞法都會被考題攔下', async () => {
  const source = await readFile(new URL('../lib/stock-fundamentals.js', import.meta.url), 'utf8');
  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const tags = Object.values(
    /** @type {any} */ (SEC_METRIC_CANDIDATES.currentDebt).currentDebtSources
  ).flat();
  for (const tag of tags) {
    const quoted = new RegExp(`(['"])${tag}\\1`, 'g');
    assert.equal(
      [...executable.matchAll(quoted)].length,
      1,
      `${tag} 只能在 currentDebtSources 定義一次；production 不可另寫 hardcoded source groups`
    );
  }
  assert.match(executable, /definition\.currentDebtSources/);
});

// ---- 五個假綠缺口（2026-07-30，#335 複審 tests 維度；每題各對應一個「刪掉整段仍全綠」的實測突變）----
// 這五題的存在理由不是「多蓋一點」，是複審實跑證明：unitPriority 整支回 0／instant 分支整段刪掉／
// per-share 判準放寬／continue→break 一字之差／periods fallback 兩段刪掉——五種破壞當時 23 題全綠。

/** @param {Record<string, Record<string, any[]>>} tagUnits tag → unit → rows */
function parseMetricsFixture(tagUnits) {
  return parseSecCompanyFacts({
    symbol: 'GAP',
    cik: '900777',
    submissions: { cik: 900777, name: 'Fake Green Gap Co', sic: '3571', fiscalYearEnd: '1231' },
    companyFacts: {
      cik: 900777,
      entityName: 'Fake Green Gap Co',
      facts: {
        'us-gaap': Object.fromEntries(Object.entries(tagUnits).map(([tag, units]) => [tag, { units }]))
      }
    }
  });
}
/** 年度 duration 列（10-K FY，一年期） */
const durAnnual = (year, val, extra = {}) => ({
  start: `${year - 1}-12-31`, end: `${year}-12-31`, val,
  form: '10-K', fy: year, fp: 'FY', filed: `${year + 1}-02-01`,
  accn: `0000900777-${String(year + 1).slice(2)}-000001`, ...extra
});
/** 單季 duration 列（10-Q） */
const durQuarter = (val, extra = {}) => ({
  start: '2025-01-01', end: '2025-03-31', val,
  form: '10-Q', fy: 2025, fp: 'Q1', filed: '2025-05-01',
  accn: '0000900777-25-000002', ...extra
});
/** instant 列（資產負債表科目） */
const instAnnual = (year, val, extra = {}) => ({
  end: `${year}-12-31`, val, form: '10-K', fy: year, fp: 'FY',
  filed: `${year + 1}-02-01`, accn: `0000900777-${String(year + 1).slice(2)}-000001`, ...extra
});

test('selectMetric｜同期間營收總額優先於合約收入成分，衍生淨利率跟著正確', () => {
  const result = parseMetricsFixture({
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durAnnual(2024, 250000), durQuarter(25000)]
    },
    Revenues: { USD: [durAnnual(2024, 400000), durQuarter(40000)] },
    NetIncomeLoss: { USD: [durAnnual(2024, 100000), durQuarter(10000)] }
  });

  const revenue = result.metrics.revenue;
  assert.equal(revenue.tag, 'Revenues', '同期間必須採總額 tag，不可被候選陣列第一個成分攔走');
  assert.equal(revenue.annual.at(-1)?.value, 400000);
  assert.equal(revenue.annual.at(-1)?.tag, 'Revenues', 'row-level tag 必須保留，供來源追溯與 F5 比較');
  assert.equal(result.metrics.netMargin.annual.at(-1)?.value, 0.25, '分母若誤採 250000 會算成 0.4');
  assert.equal(revenue.latestQuarter?.value, 40000, '單季也必須採同期總額，不可只修年度');
  assert.equal(revenue.latestQuarter?.tag, 'Revenues');
  assert.equal(result.metrics.netMargin.latestQuarter?.value, 0.25);
});

test('selectMetric｜高優先 tag 較舊時，較低優先 tag 補更新期間但不回頭改寫舊期', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [
        durAnnual(2023, 300000),
        durQuarter(30000, {
          start: '2024-01-01', end: '2024-03-31', fy: 2024,
          filed: '2024-05-01', accn: '0000900777-24-000002'
        })
      ]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durAnnual(2022, 280000), durAnnual(2024, 420000), durQuarter(42000)]
    }
  });

  const revenue = result.metrics.revenue;
  assert.deepEqual(
    revenue.annual.map(fact => [fact.periodEnd, fact.value, fact.tag]),
    [
      ['2023-12-31', 300000, 'Revenues'],
      ['2024-12-31', 420000, 'RevenueFromContractWithCustomerExcludingAssessedTax']
    ],
    '跨 tag 要逐期間合併：舊期保留總額，新期才由較低優先來源補上'
  );
  assert.equal(revenue.tag, 'RevenueFromContractWithCustomerExcludingAssessedTax', '表頭來源跟最新採用列走');
  assert.deepEqual(
    [revenue.latestQuarter?.periodEnd, revenue.latestQuarter?.value, revenue.latestQuarter?.tag],
    ['2025-03-31', 42000, 'RevenueFromContractWithCustomerExcludingAssessedTax'],
    '較低優先 tag 的更新單季也必須補上，不能只合併年度'
  );

  const f5 = comparableFundamentalSeries(revenue.annual);
  assert.equal(f5.status, 'not-comparable', '混合 tag 的歷史列不可被 F5 畫成同口徑趨勢');
  assert.match(f5.reason, /tag/);
  assert.ok(
    result.warnings.some(item => item.code === 'MIXED_TAG' && item.metric === 'revenue'),
    '官方列跨 tag 接力必須明確出聲'
  );

  const at = '2026-08-01T00:00:00.000Z';
  const clean = /** @type {any} */ (sanitizeDbForWrite({
    settings: {},
    stockFundamentals: [{ symbol: 'GAP', lastAttemptAt: at, fetchedAt: at, data: result }]
  }, { mode: 'throw' }));
  assert.equal(clean.stockFundamentals[0].data.metrics.revenue.annual.length, 2,
    '混合來源仍是合法的官方列，必須能原樣通過正式寫入櫃檯');
});

test('selectMetric 保存型｜noncurrentDebt 維持整條 first-hit，不做跨 tag 逐期接力', () => {
  const result = parseMetricsFixture({
    LongTermDebtAndCapitalLeaseObligations: {
      USD: [instAnnual(2023, 500), instAnnual(2024, 520)]
    },
    LongTermDebtNoncurrent: {
      USD: [instAnnual(2021, 400), instAnnual(2022, 450), instAnnual(2025, 540)]
    }
  });

  assert.deepEqual(
    result.metrics.noncurrentDebt.annual.map(fact => [fact.periodEnd, fact.value, fact.tag]),
    [
      ['2023-12-31', 500, 'LongTermDebtAndCapitalLeaseObligations'],
      ['2024-12-31', 520, 'LongTermDebtAndCapitalLeaseObligations']
    ],
    '近義替代是整條序列退路，不得補舊期、補新期或混合租賃口徑'
  );
});

test('selectMetric 警示｜未採用 tag 的重複 YTD 不累加計數', () => {
  const ytd = durQuarter(180000, {
    start: '2025-01-01', end: '2025-06-30', fp: 'Q2',
    filed: '2025-08-01', accn: '0000900777-25-000003'
  });
  const result = parseMetricsFixture({
    Revenues: { USD: [durAnnual(2024, 400000), ytd] },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durAnnual(2024, 250000), ytd]
    }
  });
  const warning = result.warnings.find(item => (
    item.code === 'YTD_EXCLUDED' && item.metric === 'revenue'
  ));

  assert.match(warning?.message || '', /略過 1 筆/);
});

test('selectMetric 警示｜低順位 tag 的未採用 unit 不誤報 MULTIPLE_UNITS', () => {
  const result = parseMetricsFixture({
    Revenues: { USD: [durAnnual(2024, 400000)] },
    SalesRevenueNet: { EUR: [durAnnual(2023, 300000)] }
  });

  assert.equal(result.metrics.revenue.unit, 'USD');
  assert.equal(
    result.warnings.some(item => item.code === 'MULTIPLE_UNITS' && item.metric === 'revenue'),
    false
  );
});

test('selectMetric 警示｜實際補期的低順位 tag 有多 unit 時必須出聲', () => {
  const result = parseMetricsFixture({
    Revenues: { USD: [durAnnual(2023, 300000)] },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durAnnual(2024, 420000)],
      EUR: [durAnnual(2024, 390000)]
    }
  });

  assert.equal(result.metrics.revenue.annual.at(-1)?.value, 420000);
  assert.ok(
    result.warnings.some(item => item.code === 'MULTIPLE_UNITS' && item.metric === 'revenue'),
    '真正參與補期的 tag 有替代 unit，警示不能只檢查第一個 tag'
  );
});

test('selectMetric 警示｜兩個實際採用 tag 的 YTD 是兩筆不同來源', () => {
  const ytd = durQuarter(180000, {
    start: '2025-01-01', end: '2025-06-30', fp: 'Q2',
    filed: '2025-08-01', accn: '0000900777-25-000003'
  });
  const result = parseMetricsFixture({
    Revenues: { USD: [durAnnual(2023, 300000), ytd] },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durAnnual(2024, 420000), ytd]
    }
  });
  const warning = result.warnings.find(item => (
    item.code === 'YTD_EXCLUDED' && item.metric === 'revenue'
  ));

  assert.match(warning?.message || '', /略過 2 筆/);
});

test('selectMetric 警示｜被五年輸出裁掉的舊 tag 不得造成 MIXED_TAG 誤報', () => {
  const result = parseMetricsFixture({
    Revenues: { USD: [durAnnual(2017, 170000), durAnnual(2018, 180000)] },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [
        durAnnual(2021, 210000), durAnnual(2022, 220000), durAnnual(2023, 230000),
        durAnnual(2024, 240000), durAnnual(2025, 250000)
      ]
    }
  });

  assert.deepEqual(
    result.metrics.revenue.annual.map(fact => fact.tag),
    Array(5).fill('RevenueFromContractWithCustomerExcludingAssessedTax')
  );
  assert.equal(
    result.warnings.some(item => item.code === 'MIXED_TAG' && item.metric === 'revenue'),
    false,
    'AAPL 型：實際輸出與 F5 都只有單一來源，警示不可再提已裁掉的舊列'
  );
  assert.equal(comparableFundamentalSeries(result.metrics.revenue.annual).status, 'comparable');
});

test('selectMetric 警示｜被五年輸出裁掉的舊 tag 不得造成 YTD_EXCLUDED 誤報', () => {
  const oldYtd = durQuarter(90000, {
    start: '2019-01-01', end: '2019-06-30', fp: 'Q2', fy: 2019,
    filed: '2019-08-01', accn: '0000900777-19-000003'
  });
  const result = parseMetricsFixture({
    Revenues: { USD: [durAnnual(2017, 170000), durAnnual(2018, 180000), oldYtd] },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [
        durAnnual(2021, 210000), durAnnual(2022, 220000), durAnnual(2023, 230000),
        durAnnual(2024, 240000), durAnnual(2025, 250000)
      ]
    }
  });

  assert.equal(
    result.warnings.some(item => item.code === 'YTD_EXCLUDED' && item.metric === 'revenue'),
    false,
    '裁掉的舊來源即使有 YTD，也不是最近五年／最新單季的輸出警示'
  );
});

test('selectMetric 警示｜被五年輸出裁掉的舊 tag 不得造成 MULTIPLE_UNITS 誤報', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [durAnnual(2017, 170000), durAnnual(2018, 180000)],
      EUR: [durAnnual(2017, 150000), durAnnual(2018, 160000)]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [
        durAnnual(2021, 210000), durAnnual(2022, 220000), durAnnual(2023, 230000),
        durAnnual(2024, 240000), durAnnual(2025, 250000)
      ]
    }
  });

  assert.equal(
    result.warnings.some(item => item.code === 'MULTIPLE_UNITS' && item.metric === 'revenue'),
    false,
    '實際輸出只有低順位 USD tag，不可回頭警告已裁掉舊 tag 的 EUR'
  );
});

test('selectMetric｜年度／季度各自挑第一個可用 tag，不因另一條舊軸丟掉合法資料', () => {
  const quarterFirst = parseMetricsFixture({
    Revenues: {
      USD: [durQuarter(30000, {
        start: '2014-07-01', end: '2014-09-28', fy: 2014,
        filed: '2014-11-01', accn: '0000900777-14-000002'
      })]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durAnnual(2023, 380000), durAnnual(2024, 420000)]
    }
  });
  const annualFirst = parseMetricsFixture({
    Revenues: { USD: [durAnnual(2018, 300000)] },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durAnnual(2024, 420000), durQuarter(40000)]
    }
  });

  assert.deepEqual(
    quarterFirst.metrics.revenue.annual.map(fact => fact.periodEnd),
    ['2023-12-31', '2024-12-31'],
    'JNJ 型：高順位 tag 只有舊季度時，低順位年度軸仍要進來'
  );
  assert.equal(annualFirst.metrics.revenue.latestQuarter?.value, 40000,
    'AAPL 型：高順位 tag 只有舊年度時，低順位最新季度仍要進來');
  assert.ok(annualFirst.warnings.some(item => item.code === 'MIXED_TAG' && item.metric === 'revenue'));
});

test('selectMetric 衍生值｜最新季度來源不同於最新年度時，逐期比率仍 fail-closed', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [
        durAnnual(2024, 400000),
        durQuarter(30000, {
          start: '2025-01-01', end: '2025-03-31', fy: 2025,
          filed: '2025-05-01', accn: '0000900777-25-000002'
        })
      ]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durQuarter(40000, {
        start: '2025-04-01', end: '2025-06-30', fp: 'Q2', fy: 2025,
        filed: '2025-08-01', accn: '0000900777-25-000003'
      })]
    },
    NetIncomeLoss: {
      USD: [durAnnual(2024, 100000), durQuarter(10000, {
        start: '2025-04-01', end: '2025-06-30', fp: 'Q2', fy: 2025,
        filed: '2025-08-01', accn: '0000900777-25-000003'
      })]
    }
  });

  assert.equal(result.metrics.revenue.latestQuarter?.value, 40000,
    '官方原始值保留，不用 fail-closed 刪合法 SEC fact');
  assert.equal(result.metrics.netMargin.latestQuarter, null,
    '刪掉 latestQuarterMatchesAnnualSource 守衛時，本題會錯算成 25%');
});

test('selectMetric 衍生值｜跨 tag 接力的年度營收不計算 CAGR', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [durAnnual(2021, 100000), durAnnual(2022, 105000), durAnnual(2023, 110000)]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [
        durAnnual(2021, 100000), durAnnual(2022, 105000),
        durAnnual(2023, 110000), durAnnual(2024, 120000)
      ]
    }
  });

  assert.deepEqual(result.metrics.revenueCagr3y.annual, []);
  assert.equal(result.metrics.revenueCagr3y.status, 'missing');
  assert.ok(result.warnings.some(item => item.code === 'MIXED_TAG' && item.metric === 'revenue'));
});

test('selectMetric 衍生值｜年度比率逐期保留 inputs，跨 tag 的官方輸入趨勢仍不可比較', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [
        durAnnual(2021, 100000), durAnnual(2022, 110000),
        durAnnual(2023, 120000), durAnnual(2024, 130000)
      ]
    },
    NetIncomeLoss: {
      USD: [durAnnual(2021, 10000), durAnnual(2022, 11000), durAnnual(2023, 12000)]
    },
    ProfitLoss: {
      USD: [
        durAnnual(2021, 10000), durAnnual(2022, 11000),
        durAnnual(2023, 12000), durAnnual(2024, 26000)
      ]
    }
  });

  assert.deepEqual(result.metrics.netMargin.annual.map(fact => fact.value), [0.1, 0.1, 0.1, 0.2]);
  assert.equal(result.metrics.netMargin.status, 'available');
  assert.equal(result.metrics.netMargin.annual.at(-1)?.inputs.netIncome.tag, 'ProfitLoss');
  assert.equal(comparableFundamentalSeries(result.metrics.netIncome.annual).status, 'not-comparable',
    '逐期比率可以重算，但輸入來源跨 tag 的趨勢不可冒充同口徑');
  assert.ok(result.warnings.some(item => item.code === 'MIXED_TAG' && item.metric === 'netIncome'));
});

test('selectMetric｜重疊期有實質口徑衝突時，不接低順位新期或產生混算衍生值', () => {
  const result = parseMetricsFixture({
    NetCashProvidedByUsedInOperatingActivities: {
      USD: [durAnnual(2022, 800000), durAnnual(2023, 1000000)]
    },
    NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
      USD: [
        durAnnual(2022, 740000), durAnnual(2023, 910000), durAnnual(2024, 920000)
      ]
    },
    NetIncomeLoss: {
      USD: [durAnnual(2022, 400000), durAnnual(2023, 500000), durAnnual(2024, 600000)]
    },
    PaymentsToAcquirePropertyPlantAndEquipment: {
      USD: [durAnnual(2022, 100000), durAnnual(2023, 110000), durAnnual(2024, 120000)]
    }
  });

  assert.deepEqual(
    result.metrics.operatingCashFlow.annual.map(fact => [fact.periodEnd, fact.value, fact.tag]),
    [
      ['2022-12-31', 800000, 'NetCashProvidedByUsedInOperatingActivities'],
      ['2023-12-31', 1000000, 'NetCashProvidedByUsedInOperatingActivities']
    ],
    'Dover 型：重疊期差異 7.5%／9% 已證明口徑不同，2024 continuing-only 不可接上'
  );
  assert.equal(result.metrics.cashConversion.annual.some(fact => fact.periodEnd === '2024-12-31'), false);
  assert.equal(result.metrics.freeCashFlow.annual.some(fact => fact.periodEnd === '2024-12-31'), false);
  assert.ok(result.warnings.some(item => (
    item.code === 'TAG_OVERLAP_CONFLICT' && item.metric === 'operatingCashFlow'
  )));
});

test('selectMetric｜第六年前的重疊衝突仍要封鎖，不能因每個 tag 先裁五年而漏掉', () => {
  const fixtures = [
    {
      label: '低順位 tag 有七期，自己的 2019 衝突不能被裁掉',
      tagUnits: {
        Revenues: {
          USD: [durAnnual(2019, 295841), durAnnual(2022, 322606), durAnnual(2024, 302400)]
        },
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          USD: [
            durAnnual(2019, 301900), durAnnual(2020, 300000), durAnnual(2021, 310000),
            durAnnual(2022, 322606), durAnnual(2023, 305000),
            durAnnual(2024, 302400), durAnnual(2025, 302500)
          ]
        }
      }
    },
    {
      label: '高順位 tag 有六期，自己的 2019 衝突不能被裁掉',
      tagUnits: {
        Revenues: {
          USD: [
            durAnnual(2019, 295841), durAnnual(2020, 300000), durAnnual(2021, 310000),
            durAnnual(2022, 322606), durAnnual(2023, 305000), durAnnual(2024, 302400)
          ]
        },
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          USD: [
            durAnnual(2019, 301900), durAnnual(2022, 322606),
            durAnnual(2024, 302400), durAnnual(2025, 302500)
          ]
        }
      }
    }
  ];

  for (const fixture of fixtures) {
    const result = parseMetricsFixture(fixture.tagUnits);
    assert.equal(
      result.metrics.revenue.annual.some(fact => (
        fact.tag === 'RevenueFromContractWithCustomerExcludingAssessedTax'
      )),
      false,
      fixture.label
    );
    assert.ok(
      result.warnings.some(item => item.code === 'TAG_OVERLAP_CONFLICT' && item.metric === 'revenue'),
      fixture.label
    );
  }
});

test('selectMetric｜年度證明 tag 口徑衝突時，同一 tag 的更新季度也不得漏接', () => {
  const result = parseMetricsFixture({
    NetCashProvidedByUsedInOperatingActivities: {
      USD: [durAnnual(2022, 800000), durAnnual(2023, 1000000), durQuarter(200000)]
    },
    NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
      USD: [
        durAnnual(2022, 740000), durAnnual(2023, 910000), durAnnual(2024, 920000),
        durQuarter(230000, {
          start: '2025-04-01', end: '2025-06-30', fp: 'Q2', fy: 2025,
          filed: '2025-08-01', accn: '0000900777-25-000003'
        })
      ]
    }
  });

  assert.deepEqual(
    [result.metrics.operatingCashFlow.latestQuarter?.periodEnd,
      result.metrics.operatingCashFlow.latestQuarter?.tag],
    ['2025-03-31', 'NetCashProvidedByUsedInOperatingActivities'],
    '來源已被年度重疊證據否決，季度軸不可各自為政接上同一來源'
  );
});

test('selectMetric｜重疊差異剛超過 0.1% 就必須封鎖，容忍度上界不可漂移', () => {
  const result = parseMetricsFixture({
    NetCashProvidedByUsedInOperatingActivities: {
      USD: [durAnnual(2022, 1234567), durAnnual(2023, 1500000)]
    },
    NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
      USD: [durAnnual(2022, 1236420), durAnnual(2023, 1500000), durAnnual(2024, 1600000)]
    }
  });

  assert.equal(
    result.metrics.operatingCashFlow.annual.some(fact => fact.periodEnd === '2024-12-31'),
    false,
    '0.1498% 已超過契約上界；容忍度改成 0.2% 或 1% 時本題必須紅'
  );
});

test('selectMetric｜非百萬位進位的重疊差異在 0.1% 內時，仍可接低順位新期', () => {
  const result = parseMetricsFixture({
    NetCashProvidedByUsedInOperatingActivities: {
      USD: [durAnnual(2022, 1234567), durAnnual(2023, 1500000)]
    },
    NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
      USD: [durAnnual(2022, 1235000), durAnnual(2023, 1500000), durAnnual(2024, 1600000)]
    }
  });

  assert.equal(
    result.metrics.operatingCashFlow.annual.some(fact => fact.periodEnd === '2024-12-31'),
    true,
    '0.035% 應由一般相對容忍度接受；把 0.1% 縮成零時本題必須紅'
  );
});

test('selectMetric｜同百萬位但相差超過 1% 仍是實質衝突，不可假借進位放行', () => {
  const result = parseMetricsFixture({
    NetCashProvidedByUsedInOperatingActivities: {
      USD: [durAnnual(2022, 10000000), durAnnual(2023, 15000000)]
    },
    NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
      USD: [durAnnual(2022, 10400000), durAnnual(2023, 15000000), durAnnual(2024, 16000000)]
    }
  });

  assert.equal(
    result.metrics.operatingCashFlow.annual.some(fact => fact.periodEnd === '2024-12-31'),
    false,
    '10.0M 與 10.4M 雖四捨五入到同一百萬，3.85% 差異仍不可視為申報精度'
  );
});

test('selectMetric｜任一重疊值不到百萬時，不得套用百萬位進位例外', () => {
  const result = parseMetricsFixture({
    NetCashProvidedByUsedInOperatingActivities: {
      USD: [durAnnual(2022, 1000000), durAnnual(2023, 1500000)]
    },
    NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
      USD: [durAnnual(2022, 995000), durAnnual(2023, 1500000), durAnnual(2024, 1600000)]
    }
  });

  assert.equal(
    result.metrics.operatingCashFlow.annual.some(fact => fact.periodEnd === '2024-12-31'),
    false,
    '1,000,000 與 995,000 雖同樣四捨五入為一百萬，未達量級下界仍須視為口徑衝突'
  );
});

test('selectMetric 警示｜低順位 tag 沒有缺期可補時，重疊差異不誤報衝突', () => {
  const result = parseMetricsFixture({
    NetCashProvidedByUsedInOperatingActivities: {
      USD: [durAnnual(2022, 800000), durAnnual(2023, 1000000)]
    },
    NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
      USD: [durAnnual(2022, 740000), durAnnual(2023, 910000)]
    }
  });

  assert.deepEqual(
    result.metrics.operatingCashFlow.annual.map(fact => [fact.periodEnd, fact.value, fact.tag]),
    [
      ['2022-12-31', 800000, 'NetCashProvidedByUsedInOperatingActivities'],
      ['2023-12-31', 1000000, 'NetCashProvidedByUsedInOperatingActivities']
    ]
  );
  assert.equal(
    result.warnings.some(item => (
      item.code === 'TAG_OVERLAP_CONFLICT' && item.metric === 'operatingCashFlow'
    )),
    false,
    '沒有候選缺期時不曾嘗試接續，不能把完全未採用的來源報成輸出衝突'
  );
});

test('selectMetric 警示｜低順位 tag 只補到五年輸出外的舊期時，不誤報衝突', () => {
  const result = parseMetricsFixture({
    NetCashProvidedByUsedInOperatingActivities: {
      USD: [
        durAnnual(2021, 1000000), durAnnual(2022, 1100000), durAnnual(2023, 1200000),
        durAnnual(2024, 1300000), durAnnual(2025, 1400000)
      ]
    },
    NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
      USD: [durAnnual(2019, 700000), durAnnual(2021, 900000), durAnnual(2022, 950000)]
    }
  });

  assert.deepEqual(
    result.metrics.operatingCashFlow.annual.map(fact => fact.periodEnd),
    ['2021-12-31', '2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31']
  );
  assert.equal(
    result.warnings.some(item => (
      item.code === 'TAG_OVERLAP_CONFLICT' && item.metric === 'operatingCashFlow'
    )),
    false,
    'Apple 型：被五年輸出裁掉的舊缺期，不是使用者目前會看到的來源衝突'
  );
});

test('selectMetric｜重疊期只有千位到百萬位進位差時，仍可接低順位新期', () => {
  const result = parseMetricsFixture({
    PaymentsToAcquirePropertyPlantAndEquipment: {
      USD: [
        durAnnual(2022, 209851000), durAnnual(2023, 220051000),
        durQuarter(60284000, {
          start: '2023-01-01', end: '2023-03-31', fy: 2023,
          filed: '2023-05-01', accn: '0000900777-23-000002'
        })
      ]
    },
    PaymentsToAcquireProductiveAssets: {
      USD: [
        durAnnual(2022, 210000000), durAnnual(2023, 220000000), durAnnual(2024, 230000000),
        durQuarter(60000000, {
          start: '2023-01-01', end: '2023-03-31', fy: 2023,
          filed: '2023-05-01', accn: '0000900777-23-000002'
        }),
        durQuarter(65000000, {
          start: '2023-04-01', end: '2023-06-30', fp: 'Q2', fy: 2023,
          filed: '2023-08-01', accn: '0000900777-23-000003'
        })
      ]
    }
  });

  assert.deepEqual(
    result.metrics.capitalExpenditure.annual.map(fact => [fact.periodEnd, fact.value, fact.tag]),
    [
      ['2022-12-31', 209851000, 'PaymentsToAcquirePropertyPlantAndEquipment'],
      ['2023-12-31', 220051000, 'PaymentsToAcquirePropertyPlantAndEquipment'],
      ['2024-12-31', 230000000, 'PaymentsToAcquireProductiveAssets']
    ],
    'CBRE 型：年度 0.071% 與單季百萬位進位差都屬申報精度，不應被 Dover 防線誤傷'
  );
  assert.deepEqual(
    [result.metrics.capitalExpenditure.latestQuarter?.periodEnd,
      result.metrics.capitalExpenditure.latestQuarter?.value],
    ['2023-06-30', 65000000],
    '單季 60,284,000 與百萬位申報的 60,000,000 是同一值的精度差，不應封鎖整個 tag'
  );
  assert.equal(
    result.warnings.some(item => (
      item.code === 'TAG_OVERLAP_CONFLICT' && item.metric === 'capitalExpenditure'
    )),
    false
  );
});

test('selectMetric｜兩個 tag 至少兩期完全同值時，才安全補回中間缺口', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [
        durAnnual(2020, 100000), durAnnual(2021, 110000),
        durAnnual(2023, 130000), durAnnual(2024, 140000), durAnnual(2025, 150000)
      ]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [
        durAnnual(2020, 100000), durAnnual(2021, 110000), durAnnual(2022, 120000),
        durAnnual(2023, 130000), durAnnual(2024, 140000)
      ]
    }
  });

  assert.deepEqual(
    result.metrics.revenue.annual.map(fact => [fact.periodEnd, fact.value, fact.tag]),
    [
      ['2021-12-31', 110000, 'Revenues'],
      ['2022-12-31', 120000, 'RevenueFromContractWithCustomerExcludingAssessedTax'],
      ['2023-12-31', 130000, 'Revenues'],
      ['2024-12-31', 140000, 'Revenues'],
      ['2025-12-31', 150000, 'Revenues']
    ],
    'Alphabet 型：重疊數字證明兩個 tag 同口徑後，2022 不再永久留洞'
  );
});

test('selectMetric｜只有一期完全同值不足以證明同口徑，不回填舊洞', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [durAnnual(2021, 110000), durAnnual(2023, 130000), durAnnual(2024, 140000)]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durAnnual(2021, 110000), durAnnual(2022, 120000)]
    }
  });

  assert.deepEqual(
    result.metrics.revenue.annual.map(fact => fact.periodEnd),
    ['2021-12-31', '2023-12-31', '2024-12-31']
  );
});

test('selectMetric｜重疊期只有進位近似仍不足以回填舊洞', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [durAnnual(2021, 1000000), durAnnual(2023, 1200000), durAnnual(2024, 1300000)]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [durAnnual(2021, 1000500), durAnnual(2022, 1100000), durAnnual(2023, 1199500)]
    }
  });

  assert.deepEqual(
    result.metrics.revenue.annual.map(fact => fact.periodEnd),
    ['2021-12-31', '2023-12-31', '2024-12-31'],
    '0.05% 的近似只足以容許接續新期；歷史回填仍須至少兩期完全同值'
  );
});

test('selectMetric｜兩期完全同值之外只要另有一期近似，仍不得回填舊洞', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [
        durAnnual(2020, 1000000), durAnnual(2021, 1100000),
        durAnnual(2023, 1300000), durAnnual(2024, 1400000)
      ]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [
        durAnnual(2020, 1000000), durAnnual(2021, 1100000),
        durAnnual(2022, 1200000), durAnnual(2023, 1300500)
      ]
    }
  });

  assert.equal(
    result.metrics.revenue.annual.some(fact => fact.periodEnd === '2022-12-31'),
    false,
    '兩期 exact 不能遮掉第三期 non-exact；拿掉 !nonExactOverlap 時本題必須紅'
  );
});

test('selectMetric｜重疊期曾出現衝突時，即使另有兩期同值也不回填舊洞', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [
        durAnnual(2020, 100000), durAnnual(2021, 110000),
        durAnnual(2023, 130000), durAnnual(2024, 140000)
      ]
    },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      USD: [
        durAnnual(2020, 100000), durAnnual(2021, 999000),
        durAnnual(2022, 120000), durAnnual(2023, 130000)
      ]
    }
  });

  assert.deepEqual(
    result.metrics.revenue.annual.map(fact => fact.periodEnd),
    ['2020-12-31', '2021-12-31', '2023-12-31', '2024-12-31']
  );
});

test('selectMetric｜只有一個可用 tag 時輸出值與來源形狀不變', () => {
  const result = parseMetricsFixture({
    Revenues: {
      USD: [durAnnual(2023, 133974), durAnnual(2024, 134788), durQuarter(34253)]
    }
  });
  const revenue = result.metrics.revenue;

  assert.equal(revenue.tag, 'Revenues');
  assert.equal(revenue.unit, 'USD');
  assert.deepEqual(
    revenue.annual.map(fact => [fact.periodEnd, fact.value, fact.taxonomy, fact.tag]),
    [
      ['2023-12-31', 133974, 'us-gaap', 'Revenues'],
      ['2024-12-31', 134788, 'us-gaap', 'Revenues']
    ]
  );
  assert.deepEqual(
    [revenue.latestQuarter?.periodEnd, revenue.latestQuarter?.value, revenue.latestQuarter?.tag],
    ['2025-03-31', 34253, 'Revenues']
  );
});

test('假綠①｜USD 優先是契約不是巧合：EUR 筆數更多時仍必須選 USD', () => {
  // 複審實測：unitPriority 整支回 0 → 23 題全綠——因為 fixture 裡 USD 一直是筆數最多的，
  // 「優先採 USD」從來只是靠筆數多贏。這裡讓 EUR 三筆、USD 兩筆：靠筆數 EUR 會贏。
  const result = parseMetricsFixture({
    Revenues: {
      EUR: [durAnnual(2022, 900), durAnnual(2023, 950), durAnnual(2024, 980)],
      USD: [durAnnual(2023, 1000), durAnnual(2024, 1100)]
    }
  });
  assert.equal(result.metrics.revenue.unit, 'USD', 'EUR 筆數較多——選了它就代表 priority 死了、只剩筆數');
  assert.equal(result.metrics.revenue.annual.at(-1).value, 1100);
  assert.ok(
    result.warnings.some(w => w.code === 'MULTIPLE_UNITS' && w.metric === 'revenue'),
    '多 unit 並存必須出聲'
  );
});

test('假綠②｜instant 三支指標（現金／非流動債務）年度與最新值有斷言', () => {
  // 複審實測：selectPeriods 的 instant 分支整段刪掉 → 當時 23 題全綠（三支 instant 指標零斷言）。
  const result = parseMetricsFixture({
    CashAndCashEquivalentsAtCarryingValue: {
      USD: [instAnnual(2023, 5000), instAnnual(2024, 6000), currentDebtRow(6500, { accn: '0000900777-25-000002' })]
    },
    LongTermDebtNoncurrent: { USD: [instAnnual(2024, 90000)] }
  });
  const cash = result.metrics.cashAndEquivalents;
  assert.equal(cash.status, 'available');
  assert.deepEqual(cash.annual.map(f => [f.periodEnd, f.value]), [['2023-12-31', 5000], ['2024-12-31', 6000]],
    'instant 年度序列（10-K 期末餘額）');
  assert.equal(cash.latestQuarter?.value, 6500, 'instant 的最新一季（10-Q 期末餘額）');
  assert.equal(result.metrics.noncurrentDebt.annual.at(-1)?.value, 90000);
});

test('假綠③｜per-share 判準：只有錯 unit 時必須 missing，不可含混採用', () => {
  // 複審實測：per-share 的 validUnit 判準放寬也全綠。EPS 掛在 shares（錯 unit）＝沒有可比較資料。
  const wrong = parseMetricsFixture({
    EarningsPerShareDiluted: { shares: [durAnnual(2024, 5.5)] }
  });
  assert.equal(wrong.metrics.dilutedEps.status, 'missing', '錯 unit 被採用＝per-share 判準死了');
  const right = parseMetricsFixture({
    EarningsPerShareDiluted: { 'USD/shares': [durAnnual(2024, 5.5)] }
  });
  assert.equal(right.metrics.dilutedEps.status, 'available');
  assert.equal(right.metrics.dilutedEps.annual.at(-1).value, 5.5);
  assert.equal(right.metrics.dilutedEps.unit, 'USD/shares');
});

test('假綠④｜第一個 tag「存在但零可用列」必須退到下一個 tag（continue→break 的一字之差）', () => {
  // 複審實測：既有考題只蓋「概念不存在」；「概念存在但零可用列」的退路把 continue 改 break 也全綠
  // ——而那正是資本支出→自由現金流整族靜靜變 missing 的路徑。
  const result = parseMetricsFixture({
    PaymentsToAcquirePropertyPlantAndEquipment: { USD: [] },   // 概念在、零列
    PaymentsForAdditionsToPropertyPlantAndEquipment: { USD: [durAnnual(2024, 700)] }
  });
  const capex = result.metrics.capitalExpenditure;
  assert.equal(capex.status, 'available', '第一個 tag 零可用列＝要繼續試下一個，不是放棄');
  assert.equal(capex.tag, 'PaymentsForAdditionsToPropertyPlantAndEquipment');
  assert.equal(capex.annual.at(-1).value, 700);
});

test('假綠⑤｜revenue 缺席時 periods 的 fallback：表頭期間改由其他 duration 指標補', () => {
  // 複審實測：periodSummary 的兩段 fallback 整段刪掉 → 全綠（fixture 永遠有 revenue）。
  const result = parseMetricsFixture({
    NetIncomeLoss: { USD: [durAnnual(2023, 300), durAnnual(2024, 350), durQuarter(90)] }
  });
  assert.equal(result.metrics.revenue.status, 'missing', '前置：revenue 真的缺席');
  assert.deepEqual(result.periods.annual.map(p => p.periodEnd), ['2023-12-31', '2024-12-31'],
    'revenue 缺席＝年度表頭改由其他 duration 指標補，不可整排消失');
  assert.equal(result.periods.latestQuarter?.periodEnd, '2025-03-31',
    '最新單季表頭同樣要有 fallback');
});
