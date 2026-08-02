import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardGuideState,
  dashboardMonthLabel,
  dashboardNetWorthChange,
  dashboardSnapshotSeries,
} from '../public/modules/dashboard-forest.js';

test('森林總覽月快照：同月取最新日期、排除壞月份與非數字，只留最近 12 月', () => {
  const rows = Array.from({ length: 13 }, (_, i) => {
    const year = 2025 + Math.floor(i / 12);
    const month = i % 12 + 1;
    return {
      month: `${year}-${String(month).padStart(2, '0')}`,
      date: `${year}-${String(month).padStart(2, '0')}-01`,
      netWorth: i * 100,
    };
  });
  rows.push(
    { month: '2025-12', date: '2025-12-31', netWorth: 9999 },
    { month: '2025-12', date: '2025-12-99', netWorth: 123456 },
    { month: '2026-13', date: '2026-12-31', netWorth: 1 },
    { month: '2026-01', date: '2026-01-31', netWorth: 'not-a-number' },
  );
  const result = dashboardSnapshotSeries(rows);
  assert.equal(result.length, 12);
  assert.equal(result[0].month, '2025-02');
  assert.deepEqual(result.at(-2), { month: '2025-12', date: '2025-12-31', netWorth: 9999 });
  assert.equal(result.at(-1)?.month, '2026-01');
});

test('森林總覽月差額：只比較指定本月與緊鄰上月', () => {
  const change = dashboardNetWorthChange([
    { month: '2026-05', date: '2026-05-31', netWorth: 100 },
    { month: '2026-06', date: '2026-06-30', netWorth: 125 },
  ], '2026-06');
  assert.equal(change.status, 'ready');
  assert.equal(change.amount, 25);
  assert.equal(change.pct, 25);

  const gap = dashboardNetWorthChange([
    { month: '2026-04', netWorth: 100 },
    { month: '2026-06', netWorth: 125 },
  ], '2026-06');
  assert.equal(gap.status, 'missing-previous');
  assert.equal(gap.amount, null);
});

test('森林總覽月差額：上月為零保留金額，但不捏造百分比', () => {
  const change = dashboardNetWorthChange([
    { month: '2026-05', netWorth: 0 },
    { month: '2026-06', netWorth: 80 },
  ], '2026-06');
  assert.equal(change.status, 'zero-base');
  assert.equal(change.amount, 80);
  assert.equal(change.pct, null);
});

test('森林總覽月差額：淨資產減少保留負號與負百分比', () => {
  const change = dashboardNetWorthChange([
    { month: '2026-05', netWorth: 200 },
    { month: '2026-06', netWorth: 150 },
  ], '2026-06');
  assert.equal(change.status, 'ready');
  assert.equal(change.amount, -50);
  assert.equal(change.pct, -25);
});

test('森林總覽月差額：缺本月快照時明確回報，不拿舊月冒充本月', () => {
  const change = dashboardNetWorthChange([
    { month: '2026-04', netWorth: 100 },
    { month: '2026-05', netWorth: 120 },
  ], '2026-06');
  assert.equal(change.status, 'missing-current');
  assert.equal(change.amount, null);
});

test('森林總覽文案與小森森狀態：月份白話、情緒只跟提醒嚴重度走', () => {
  assert.equal(dashboardMonthLabel('2026-08'), '2026 年 8 月');
  assert.equal(dashboardGuideState([]).mood, 'positive');
  assert.equal(dashboardGuideState([{ level: 'warn' }]).mood, 'neutral');
  assert.equal(dashboardGuideState([{ level: 'danger' }, { level: 'warn' }]).mood, 'negative');
});
