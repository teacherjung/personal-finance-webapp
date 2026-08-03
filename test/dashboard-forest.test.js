import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dashboardCashflowSeries,
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
  const result = dashboardSnapshotSeries(rows, '2026-01');
  assert.equal(result.length, 12);
  assert.equal(result[0].month, '2025-02');
  assert.deepEqual(result.at(-2), { month: '2025-12', date: '2025-12-31', netWorth: 9999 });
  assert.equal(result.at(-1)?.month, '2026-01');
});

test('森林總覽月快照：固定使用指定本月結尾的 12 個日曆月，缺月保留 null 不接線', () => {
  const result = dashboardSnapshotSeries([
    { month: '2024-01', date: '2024-01-31', netWorth: 100 },
    { month: '2025-12', date: '2025-12-20', netWorth: 200 },
    { month: '2026-01', date: '2026-01-15', netWorth: 220 },
  ], '2026-01');
  assert.equal(result.length, 12);
  assert.deepEqual(result[0], { month: '2025-02', date: '', netWorth: null });
  assert.deepEqual(result.at(-2), { month: '2025-12', date: '2025-12-20', netWorth: 200 });
  assert.deepEqual(result.at(-1), { month: '2026-01', date: '2026-01-15', netWorth: 220 });
});

test('森林總覽月快照：null、空字串與數字字串都不是淨資產 0', () => {
  const snapshots = [
    { month: '2026-02', date: '2026-02-28', netWorth: 100 },
    { month: '2026-03', date: '2026-03-01', netWorth: null },
    { month: '2026-03', date: '2026-03-02', netWorth: '' },
    { month: '2026-03', date: '2026-03-03', netWorth: '0' },
  ];
  assert.deepEqual(dashboardSnapshotSeries(snapshots, '2026-03', 2), [
    { month: '2026-02', date: '2026-02-28', netWorth: 100 },
    { month: '2026-03', date: '', netWorth: null },
  ]);
  assert.equal(dashboardNetWorthChange(snapshots, '2026-03').status, 'missing-current');
});

test('森林總覽兩張趨勢圖共用同一個日曆月視窗，記帳前缺月不用 0 冒充', () => {
  const result = dashboardCashflowSeries([
    { month: '2026-02', income: null, expense: 0, net: 0 },
    { month: '2026-03', income: 100, expense: 40, net: 60 },
    { month: '2026-04', income: 0, expense: 0, net: 0 },
    { month: '2026-05', income: 0, expense: 0, net: 0 },
    { month: '2026-06', income: 0, expense: 30, net: -30 },
  ], '2026-06', 6);
  assert.deepEqual(result, [
    { month: '2026-01', income: null, expense: null, net: null },
    { month: '2026-02', income: null, expense: null, net: null },
    { month: '2026-03', income: 100, expense: 40, net: 60 },
    { month: '2026-04', income: 0, expense: 0, net: 0 },
    { month: '2026-05', income: 0, expense: 0, net: 0 },
    { month: '2026-06', income: 0, expense: 30, net: -30 },
  ]);
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

test('理財中心總覽接線：月份以後端現金流月份為單一來源，文字舞台不被森林圖搶走', () => {
  const source = readFileSync(new URL('../public/modules/dashboard.js', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(source, /String\(cf\.month\)/);
  assert.doesNotMatch(source, /上月底/);
  assert.doesNotMatch(source, /src="\/assets\//, 'HOSTED 掛在 /finance/，森林素材不可指向網站根目錄');
  assert.doesNotMatch(source, /src="assets\/forest-return-positive\.webp"/);
  assert.match(source, /id="forestDashboardMessage">看清資產全貌，再決定今天要處理什麼。/);
  assert.match(source, /aria-live="polite"/);
  assert.match(shell, /<div class="brand-title">理財中心<\/div>/);
  assert.match(shell, /<div class="brand-subtitle">榮祥森<\/div>/);
  assert.match(styles, /\.forest-scene-summary > div \+ div \{ border-left: 2px solid var\(--frame\); \}/);
  assert.match(styles, /font-size: 15\.5px; font-weight: 600;/);
  assert.match(source, /近 12 個月尚無銀行收支紀錄/);
  assert.match(source, /近 12 個月尚無淨資產快照/);
});
