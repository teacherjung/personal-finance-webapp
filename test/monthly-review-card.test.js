import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTHLY_REVIEW_INFO,
  monthlyReviewCardHtml,
  monthlyReviewChartConfig,
  monthlyReviewMonthLabel,
  monthlyReviewSummary,
  unmatchedRefundInfoHtml,
} from '../public/modules/monthly-review-card.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => `${Number(v) < 0 ? '−' : ''}${Math.abs(Number(v)).toLocaleString('en-US')} 元`;
const wan = (v) => `${(Number(v) / 10000).toFixed(1)} 萬`;
const pct = (v) => `${Number(v).toFixed(1)}%`;
const fmt = { esc, money, wan, pct };
const review = {
  months: [
    { month: '2026-04', total: 10000, hasData: true, possiblyIncomplete: false },
    { month: '2026-05', total: 0, hasData: false, possiblyIncomplete: true },
    { month: '2026-06', total: 16000, hasData: true, possiblyIncomplete: false },
  ],
  selectedMonth: '2026-06',
  selected: {
    total: 16000,
    categories: [
      { name: '<飲食>', amount: 12000, pct: 75, subcategories: [{ name: '餐廳', amount: 12000, pct: 100 }] },
      { name: '生活', amount: 4000, pct: 25, subcategories: [{ name: '（未分子類）', amount: 4000, pct: 100 }] },
    ],
    cashflow: { income: 10000, expense: 18000, net: -8000, overdraft: true, overdraftAmount: 8000 },
  },
  unmatchedRefunds: { count: 1, total: 300, items: [{ date: '2026-07-01', store: '<退款店>', amount: 300 }] },
};

test('月度回顧卡：大類先顯示、子類可展開，五個白話入口與兩把尺標示齊全', () => {
  const html = monthlyReviewCardHtml(review, fmt);
  assert.match(html, /月度回顧/);
  assert.match(html, /<details class="mr-category">/);
  assert.doesNotMatch(html, /<details class="mr-category" open/);
  assert.match(html, /&lt;飲食&gt;/, '使用者分類必須跳脫');
  for (const key of ['settled', 'lens', 'overdraft', 'refund', 'incomplete']) assert.match(html, new RegExp(`data-mr-info="${key}"`));
  assert.match(html, /本月透支/);
  assert.match(html, /另有 1 筆退款/);
  assert.match(html, /資料可能未齊/);
});

test('月度回顧摘要：跳過空月比較最近有消費月份，分類與現金流仍使用選定月', () => {
  const text = monthlyReviewSummary(review, fmt);
  assert.equal(text, '6 月花了 1.6 萬，比 4 月多 6,000 元；最大宗是 &lt;飲食&gt; 75.0%；當月透支 −8,000 元。');
  assert.equal(monthlyReviewMonthLabel('2026-06', true), '2026 年 6 月');
});

test('月度回顧摘要：沒有更早的實際消費月份時不捏造增減比較', () => {
  const firstMonth = {
    ...review,
    months: [
      { month: '2026-05', total: 0, hasData: false, possiblyIncomplete: true },
      { month: '2026-06', total: 16000, hasData: true, possiblyIncomplete: false },
    ],
  };
  const text = monthlyReviewSummary(firstMonth, fmt);
  assert.doesNotMatch(text, /比 \d+ 月/);
  assert.match(text, /^6 月花了 1\.6 萬；最大宗是/);
});

test('月度回顧圖：本月不在資料中、點長條切月，未齊月份 tooltip 會提醒', () => {
  const selected = [];
  const config = monthlyReviewChartConfig(review, { money, onSelect: month => selected.push(month) });
  assert.deepEqual(config.data.labels, ['4 月', '5 月', '6 月']);
  assert.deepEqual(config.data.datasets[0].data, [10000, 0, 16000]);
  assert.equal(config.data.datasets[0].backgroundColor[1], '#A3937C');
  config.options.onClick({}, [{ index: 0 }]);
  config.options.onClick({}, [{ index: 2 }]);
  assert.deepEqual(selected, ['2026-04'], '目前月份不可重抓，其他長條才切換');
  assert.match(config.options.plugins.tooltip.callbacks.afterLabel({ dataIndex: 1 }), /資料可能未齊/);
  assert.equal(config.options.scales.y.ticks.callback(15000), '1.5萬', '半萬刻度不可四捨五入成和整萬相同的標籤');
});

test('未對應退款說明：列出日期、店家、金額且跳脫使用者文字', () => {
  const html = unmatchedRefundInfoHtml(review, { esc, money });
  assert.match(html, /退款會自動尋找/);
  assert.match(html, /2026-07-01/);
  assert.match(html, /&lt;退款店&gt;/);
  assert.match(html, /300 元/);
});

test('月度回顧空狀態與載入失敗不讓總覽崩潰', () => {
  assert.match(monthlyReviewCardHtml(null, fmt), /暫時無法載入/);
  assert.match(monthlyReviewCardHtml({ months: [], selectedMonth: null }, fmt), /尚無已結清月份/);
  assert.equal(MONTHLY_REVIEW_INFO.lens.title, '「消費」和「現金流支出」差在哪？');
});
