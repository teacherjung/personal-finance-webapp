import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FUNDAMENTAL_METRIC_DEFINITIONS,
  RESEARCH_METHOD_SECTIONS,
  buildStockResearchMethod,
  comparableFundamentalSeries,
  fundamentalMetricState
} from '../public/modules/stock-research-method.js';

test('研究方法｜八組問題完整、key 不重複，所有自動證據都指向正式指標', () => {
  assert.equal(RESEARCH_METHOD_SECTIONS.length, 8);
  assert.equal(new Set(RESEARCH_METHOD_SECTIONS.map(section => section.key)).size, 8);
  const metricKeys = new Set(FUNDAMENTAL_METRIC_DEFINITIONS.map(metric => metric.key));
  for (const section of RESEARCH_METHOD_SECTIONS) {
    assert.ok(section.label);
    assert.ok(section.questions.length >= 4, section.key);
    assert.ok(section.manualEvidence, section.key);
    for (const key of section.automaticEvidence) {
      assert.ok(metricKeys.has(key), `${section.key} 引用了不存在的 ${key}`);
    }
  }
});

test('研究方法｜官方值與 Noteasy 衍生值分開，衍生值都有公式與輸入', () => {
  assert.equal(new Set(FUNDAMENTAL_METRIC_DEFINITIONS.map(metric => metric.key)).size,
    FUNDAMENTAL_METRIC_DEFINITIONS.length);
  const official = FUNDAMENTAL_METRIC_DEFINITIONS.filter(metric => metric.kind === 'official');
  const derived = FUNDAMENTAL_METRIC_DEFINITIONS.filter(metric => metric.kind === 'derived');
  const keys = new Set(FUNDAMENTAL_METRIC_DEFINITIONS.map(metric => metric.key));
  const sectionKeys = new Set(RESEARCH_METHOD_SECTIONS.map(section => section.key));
  assert.ok(official.length >= 10);
  assert.ok(derived.length >= 8);
  for (const metric of derived) {
    assert.ok(metric.formula, metric.key);
    assert.ok(metric.requires.length, metric.key);
    for (const key of metric.requires) assert.ok(keys.has(key), `${metric.key} 缺少輸入 ${key}`);
  }
  for (const metric of FUNDAMENTAL_METRIC_DEFINITIONS) {
    for (const key of metric.questionKeys) assert.ok(sectionKeys.has(key), `${metric.key} 指向不存在的 ${key}`);
  }
  assert.equal(official.some(metric => metric.formula), false);
});

test('研究方法｜一般 US-GAAP 公司可用完整自動證據，但不產生評分或買賣建議欄位', () => {
  const method = buildStockResearchMethod({ companyKind: 'general', taxonomy: 'us-gaap' });
  assert.equal(method.automation, 'supported');
  assert.equal(method.warnings.length, 0);
  assert.equal(method.excludedMetrics.length, 0);
  assert.equal(method.metrics.length, FUNDAMENTAL_METRIC_DEFINITIONS.length);
  assert.equal('score' in method, false);
  assert.equal('recommendation' in method, false);
});

test('研究方法｜銀行、保險與 REIT 不硬套一般公司的自由現金流公式', () => {
  for (const companyKind of ['bank', 'insurance', 'reit']) {
    const method = buildStockResearchMethod({ companyKind, taxonomy: 'us-gaap' });
    const keys = new Set(method.metrics.map(metric => metric.key));
    assert.equal(method.automation, 'limited', companyKind);
    assert.ok(method.warnings.length, companyKind);
    assert.equal(keys.has('freeCashFlow'), false, companyKind);
    assert.equal(keys.has('freeCashFlowMargin'), false, companyKind);
    assert.equal(keys.has('cashConversion'), false, companyKind);
    assert.equal(method.sections.length, 8, '研究問題本身不能因特殊產業消失');
  }
});

test('研究方法｜IFRS 與未知／原型名稱都 fail-closed，不冒充完整 US-GAAP 支援', () => {
  const ifrs = buildStockResearchMethod({ companyKind: 'general', taxonomy: 'ifrs-full' });
  assert.equal(ifrs.automation, 'limited');
  assert.match(ifrs.warnings.join(' '), /IFRS/);
  assert.ok(ifrs.excludedMetrics.length);
  assert.ok(ifrs.excludedMetrics.every(metric => metric.kind === 'derived'));

  for (const companyKind of ['__proto__', 'toString', 'constructor', 'not-real']) {
    const unknown = buildStockResearchMethod({ companyKind, taxonomy: 'mystery' });
    assert.equal(unknown.companyKind, 'unknown');
    assert.equal(unknown.automation, 'limited');
    assert.ok(unknown.excludedMetrics.every(metric => metric.kind === 'derived'));
    assert.match(unknown.warnings.join(' '), /尚未/);
  }
});

test('研究方法｜taxonomy 尚未取得時不先假設 US-GAAP，也不先開衍生公式', () => {
  const pending = buildStockResearchMethod({ companyKind: 'general' });
  assert.equal(pending.automation, 'limited');
  assert.ok(pending.excludedMetrics.every(metric => metric.kind === 'derived'));
  assert.match(pending.warnings.join(' '), /尚未取得 taxonomy/);
});

test('基本面證據｜0 與負值都是合法數字，缺值與非有限數不冒充 0', () => {
  assert.deepEqual(fundamentalMetricState(0), {
    status: 'available', value: 0, canCompare: true, reason: ''
  });
  assert.deepEqual(fundamentalMetricState(-25), {
    status: 'available', value: -25, canCompare: true, reason: ''
  });
  for (const value of [null, undefined, '', '0', NaN, Infinity, -Infinity]) {
    assert.deepEqual(fundamentalMetricState(value), {
      status: 'missing', value: null, canCompare: false, reason: '尚未取得'
    });
  }
});

test('基本面證據｜有值但期間不可比較時保留原值，不塞進趨勢', () => {
  assert.deepEqual(fundamentalMetricState(100, { comparable: false, reason: '六個月累計值' }), {
    status: 'not-comparable',
    value: 100,
    canCompare: false,
    reason: '六個月累計值'
  });
});

const annual = (overrides = {}) => ({
  value: 100,
  unit: 'USD',
  taxonomy: 'us-gaap',
  tag: 'RevenueFromContractWithCustomerExcludingAssessedTax',
  periodType: 'annual',
  durationDays: 365,
  periodEnd: '2025-12-31',
  ...overrides
});

test('基本面趨勢｜同 unit／taxonomy／tag 的正常年度可比較，0 與負值不被濾掉', () => {
  const points = [
    annual({ value: -10, periodEnd: '2023-12-31' }),
    annual({ value: 0, durationDays: 366, periodEnd: '2024-12-31' }),
    annual({ value: 20, durationDays: 371 })
  ];
  const before = JSON.stringify(points);
  const result = comparableFundamentalSeries(points);
  assert.equal(result.status, 'comparable');
  assert.equal(result.comparable, true);
  assert.deepEqual(result.availablePoints.map(point => point.value), [-10, 0, 20]);
  assert.equal(result.hasGaps, false);
  assert.equal(JSON.stringify(points), before, '純函式不可修改來源 facts');
});

test('基本面趨勢｜不同單位、tag 或期間類型不能混成一條趨勢', () => {
  const variants = [
    annual({ unit: 'shares' }),
    annual({ tag: 'Revenues' }),
    annual({ periodType: 'quarter', durationDays: 91 })
  ];
  for (const variant of variants) {
    const result = comparableFundamentalSeries([annual(), variant]);
    assert.equal(result.status, 'not-comparable');
    assert.equal(result.comparable, false);
  }
});

test('基本面趨勢｜兩筆都缺 unit／taxonomy／tag 也不是同口徑，要 fail-closed', () => {
  for (const key of ['unit', 'taxonomy', 'tag']) {
    const left = annual();
    const right = annual({ periodEnd: '2024-12-31' });
    delete left[key];
    delete right[key];
    const result = comparableFundamentalSeries([left, right]);
    assert.equal(result.status, 'not-comparable', key);
    assert.match(result.reason, /來源欄位不完整/, key);
  }
});

test('基本面趨勢｜缺／壞期間結束日與同期間重複列都不能冒充兩期趨勢', () => {
  for (const periodEnd of ['', '2025-02-30', 'not-a-date']) {
    const result = comparableFundamentalSeries([
      annual({ periodEnd }),
      annual({ periodEnd: '2024-12-31' })
    ]);
    assert.equal(result.status, 'not-comparable', periodEnd);
  }

  const bothMissing = comparableFundamentalSeries([
    annual({ periodEnd: '' }),
    annual({ value: 120, periodEnd: '' })
  ]);
  assert.equal(bothMissing.status, 'not-comparable');
  assert.match(bothMissing.reason, /來源欄位不完整/);

  const duplicate = comparableFundamentalSeries([
    annual({ value: 100 }),
    annual({ value: 120 })
  ]);
  assert.equal(duplicate.status, 'not-comparable');
  assert.match(duplicate.reason, /accession/);
});

test('基本面趨勢｜10-Q 的六／九個月 YTD 不冒充單季；單點與缺值分開回報', () => {
  const ytd = comparableFundamentalSeries([
    annual({ periodType: 'quarter', durationDays: 181, periodEnd: '2025-06-30' }),
    annual({ periodType: 'quarter', durationDays: 273, periodEnd: '2025-09-30' })
  ]);
  assert.equal(ytd.status, 'not-comparable');
  assert.match(ytd.reason, /期間長度/);

  const single = comparableFundamentalSeries([annual()]);
  assert.equal(single.status, 'insufficient');
  assert.match(single.reason, /兩期/);

  const missing = comparableFundamentalSeries([{ ...annual(), value: null }, null]);
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.availablePoints, []);
});

test('基本面趨勢｜中間缺一期可保留洞，不因缺值把 0 當成缺資料', () => {
  const result = comparableFundamentalSeries([
    annual({ value: 10, periodEnd: '2023-12-31' }),
    annual({ value: null, periodEnd: '2024-12-31' }),
    annual({ value: 0, periodEnd: '2025-12-31' })
  ]);
  assert.equal(result.status, 'comparable');
  assert.equal(result.hasGaps, true);
  assert.deepEqual(result.availablePoints.map(point => point.value), [10, 0]);
});
