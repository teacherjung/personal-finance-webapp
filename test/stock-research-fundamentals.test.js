import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStockFundamentalsViewModel,
  companyKindFromSic,
  shouldRefreshStockFundamentals,
  stockFundamentalsFailureState,
  stockFundamentalsHtml
} from '../public/modules/stock-research-fundamentals.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function fact(value, overrides = {}) {
  return {
    value,
    unit: 'USD',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    periodType: 'annual',
    durationDays: 365,
    form: '10-K',
    filedAt: '2026-02-01',
    accession: '0000000000-26-000001',
    taxonomy: 'us-gaap',
    tag: 'Revenues',
    filingUrl: 'https://www.sec.gov/Archives/example',
    ...overrides
  };
}

function cache(overrides = {}) {
  const revenueAnnual = [
    fact(0, { periodStart: '2022-01-01', periodEnd: '2022-12-31' }),
    fact(100_000_000_000, { periodStart: '2023-01-01', periodEnd: '2023-12-31' }),
    fact(110_000_000_000, { periodStart: '2024-01-01', periodEnd: '2024-12-31' }),
    fact(120_000_000_000)
  ];
  const quarter = fact(31_000_000_000, {
    periodStart: '2026-01-01',
    periodEnd: '2026-03-31',
    periodType: 'quarter',
    durationDays: 90,
    form: '10-Q',
    filedAt: '2026-04-20',
    accession: '0000000000-26-000002'
  });
  const cashFlow = fact(40_000_000_000, { tag: 'NetCashProvidedByUsedInOperatingActivities' });
  const capex = fact(10_000_000_000, { tag: 'PaymentsToAcquirePropertyPlantAndEquipment' });
  return {
    symbol: 'AAPL',
    freshness: 'fresh',
    fresh: true,
    stale: false,
    fetchedAt: '2026-07-28T00:05:00.000Z',
    data: {
      symbol: 'AAPL',
      market: 'US',
      company: {
        cik: '0000320193',
        name: 'Apple Inc.',
        sic: '3571',
        fiscalYearEnd: '09-26'
      },
      metrics: {
        revenue: {
          key: 'revenue',
          label: '營收',
          kind: 'official',
          taxonomy: 'us-gaap',
          tag: 'Revenues',
          unit: 'USD',
          annual: revenueAnnual,
          latestQuarter: quarter,
          status: 'available'
        },
        operatingCashFlow: {
          key: 'operatingCashFlow',
          label: '營業現金流',
          kind: 'official',
          taxonomy: 'us-gaap',
          annual: [cashFlow],
          latestQuarter: null,
          status: 'available'
        },
        capitalExpenditure: {
          key: 'capitalExpenditure',
          label: '資本支出',
          kind: 'official',
          taxonomy: 'us-gaap',
          annual: [capex],
          latestQuarter: null,
          status: 'available'
        },
        freeCashFlow: {
          key: 'freeCashFlow',
          label: '自由現金流',
          kind: 'derived',
          formula: 'operatingCashFlow - capitalExpenditure',
          annual: [{
            value: 30_000_000_000,
            unit: 'USD',
            periodStart: '2025-01-01',
            periodEnd: '2025-12-31',
            periodType: 'annual',
            formula: 'operatingCashFlow - capitalExpenditure',
            inputs: {
              operatingCashFlow: { metricKey: 'operatingCashFlow', ...cashFlow },
              capitalExpenditure: { metricKey: 'capitalExpenditure', ...capex }
            }
          }],
          latestQuarter: null,
          status: 'available'
        }
      },
      warnings: [{ code: 'YTD_EXCLUDED', message: '營收略過一筆九個月累計值。' }]
    },
    ...overrides
  };
}

test('基本面公司類型｜保守辨認銀行、保險、REIT；缺 SIC 不硬猜一般公司', () => {
  assert.equal(companyKindFromSic('6021'), 'bank');
  assert.equal(companyKindFromSic(6331), 'insurance');
  assert.equal(companyKindFromSic('6798'), 'reit');
  assert.equal(companyKindFromSic('3571'), 'general');
  assert.equal(companyKindFromSic(''), 'unknown');
  assert.equal(companyKindFromSic('__proto__'), 'unknown');
});

test('基本面更新判準｜缺資料或 stale 才背景更新，fresh 不重抓', () => {
  assert.equal(shouldRefreshStockFundamentals(null), true);
  assert.equal(shouldRefreshStockFundamentals({ freshness: 'missing', data: null }), true);
  assert.equal(shouldRefreshStockFundamentals({ freshness: 'stale', data: {} }), true);
  assert.equal(shouldRefreshStockFundamentals(cache()), false);
});

test('基本面失敗退路｜保留上次成功資料與時間，只附上本次錯誤', () => {
  const old = cache({ freshness: 'stale', fresh: false, stale: true });
  const failed = stockFundamentalsFailureState(old, new Error('SEC timeout'), 'AAPL');
  assert.equal(failed.data, old.data);
  assert.equal(failed.fetchedAt, old.fetchedAt);
  assert.equal(failed.refreshError.message, 'SEC timeout');
  assert.equal(failed.freshness, 'stale');
});

test('基本面模型｜官方與衍生值分開，0 是合法資料、缺值仍保留指標列', () => {
  const view = buildStockFundamentalsViewModel({ cache: cache() });
  assert.equal(view.method.automation, 'supported');
  assert.ok(view.officialMetrics.some(metric => metric.key === 'revenue'));
  assert.ok(view.derivedMetrics.some(metric => metric.key === 'freeCashFlow'));
  assert.equal(view.officialMetrics.find(metric => metric.key === 'revenue').annual[0].value, 0);
  assert.equal(view.officialMetrics.find(metric => metric.key === 'netIncome').status, 'missing');
  assert.match(view.warnings.join('\n'), /九個月累計值/);
});

test('基本面特殊產業｜REIT 不顯示一般公司的自由現金流衍生結論', () => {
  const value = cache();
  value.data.company.sic = '6798';
  const view = buildStockFundamentalsViewModel({ cache: value });
  assert.equal(view.method.companyKind, 'reit');
  assert.ok(!view.derivedMetrics.some(metric => metric.key === 'freeCashFlow'));
  assert.match(view.warnings.join('\n'), /FFO／AFFO/);
  const html = stockFundamentalsHtml({ cache: value }, { esc });
  assert.doesNotMatch(html, /data-fundamental-metric="freeCashFlow"/);
});

test('基本面 HTML｜每個數字可展開申報來源或公式，五年趨勢與手動指標都在', () => {
  const html = stockFundamentalsHtml({
    cache: cache(),
    watchMetrics: [{ label: '活躍裝置', value: 0, unit: '台', period: '2026 Q1', source: '公司簡報' }],
    legacyMetrics: '每季檢查毛利率'
  }, { esc });

  assert.match(html, /data-fundamental-metric="revenue"/);
  assert.match(html, /最近五筆可得年度/);
  assert.match(html, /stock-fact-disclosure/);
  assert.match(html, /2022/);
  assert.match(html, />0 USD</);
  assert.match(html, /310 億 USD/);
  assert.match(html, /2026-01-01～2026-03-31/);
  assert.match(html, /us-gaap \/ Revenues/);
  assert.match(html, /0000000000-26-000002/);
  assert.match(html, /target="_blank" rel="noopener"/);
  assert.match(html, /operatingCashFlow - capitalExpenditure/);
  assert.match(html, /營業現金流/);
  assert.match(html, /活躍裝置/);
  assert.match(html, />0 台</);
  assert.match(html, /每季檢查毛利率/);
});

test('基本面 HTML｜各列最新單季直接標自己的期間，不把不同期數字假裝成同一季', () => {
  const value = cache();
  value.data.metrics.netIncome = {
    key: 'netIncome',
    label: '淨利',
    kind: 'official',
    taxonomy: 'us-gaap',
    annual: [],
    latestQuarter: fact(112_193_000_000, {
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
      periodType: 'quarter',
      durationDays: 90,
      form: '10-Q',
      tag: 'NetIncomeLoss'
    }),
    status: 'available'
  };
  value.data.warnings.push({
    code: 'QUARTER_PERIOD_MISMATCH',
    message: '最新單季分屬不同截止日；請以每列標示期間為準。'
  });

  const html = stockFundamentalsHtml({ cache: value }, { esc });
  assert.match(html, /2026-01-01～2026-03-31/);
  assert.match(html, /2026-04-01～2026-06-30/);
  assert.match(html, /最新單季分屬不同截止日/);
});

test('基本面 HTML｜無 SEC 資料仍保留八組研究問題與手動內容；外部文字一律跳脫', () => {
  const html = stockFundamentalsHtml({
    cache: stockFundamentalsFailureState(null, new Error('<img src=x onerror=1>'), 'AAPL'),
    watchMetrics: [{ label: '<script>alert(1)</script>', value: null }],
    legacyMetrics: '<b>mine</b>'
  }, { esc });

  assert.match(html, /尚未取得 SEC 官方資料/);
  assert.match(html, /研究這家公司要問的八組問題/);
  assert.match(html, /公司靠什麼賺錢/);
  assert.match(html, /關鍵指標/);
  assert.doesNotMatch(html, /<img|<script>|<b>mine/);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('基本面來源連結｜非 http(s) 不產生可點連結', () => {
  const value = cache();
  value.data.metrics.revenue.latestQuarter.filingUrl = 'javascript:alert(1)';
  const html = stockFundamentalsHtml({ cache: value }, { esc });
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /javascript:alert/);
});
