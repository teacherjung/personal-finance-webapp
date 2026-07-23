import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_TRACKING_INFO,
  goalTrackingHtml,
  netWorthTargetFromWan,
  netWorthTargetPreview,
  netWorthTargetWanInput,
} from '../public/modules/goal-tracking.js';

const wan = (v) => `${(Number(v) / 10000).toLocaleString('en-US')} 萬`;
const pct = (v) => `${Number(v).toFixed(1)}%`;
const money = (v) => `${Number(v).toLocaleString('en-US')} 元`;
const fmt = { wan, pct };

test('目標設定：萬元與台幣元互換，空白能清除，非法值不會送成 0', () => {
  assert.equal(netWorthTargetFromWan('5,000'), 50_000_000);
  assert.equal(netWorthTargetFromWan('5000.5'), 50_005_000);
  assert.equal(netWorthTargetFromWan(''), null);
  assert.ok(Number.isNaN(netWorthTargetFromWan('oops')));
  assert.ok(Number.isNaN(netWorthTargetFromWan('-1')));
  assert.equal(netWorthTargetWanInput(50_000_000), '5000');
  assert.equal(netWorthTargetWanInput(null), '');
  assert.equal(netWorthTargetPreview('5000', money), '換算為完整金額：50,000,000 元');
  assert.match(netWorthTargetPreview('', money), /停止顯示目標追蹤/);
});

test('目標進度：嵌入淨資產區、兩把速度並列，月份一律向上取整', () => {
  const html = goalTrackingHtml({
    target: 50_000_000,
    current: 40_000_000,
    gap: 10_000_000,
    progressPct: 80,
    reached: false,
    monthsSavings: 6.1,
    monthsNetWorth: 3.2,
    savingsSamples: 6,
    netWorthSamples: 5,
  }, fmt);
  assert.match(html, /距離 5,000 萬 還差 <b>1,000 萬<\/b>/);
  assert.match(html, /aria-valuenow="80\.0"/);
  assert.match(html, /約 7 個月/);
  assert.match(html, /約 4 個月/);
  for (const key of ['speeds', 'market', 'unavailable']) {
    assert.match(html, new RegExp(`data-goal-info="${key}"`));
  }
});

test('資料不足或沒有正成長：顯示誠實文案，永不出現負月份或 Infinity', () => {
  const accumulating = goalTrackingHtml({
    target: 2_000_000, current: 1_000_000, gap: 1_000_000, progressPct: 50,
    reached: false, monthsSavings: null, monthsNetWorth: null, savingsSamples: 2, netWorthSamples: 1,
  }, fmt);
  assert.equal((accumulating.match(/資料累積中/g) || []).length, 2);

  const slowing = goalTrackingHtml({
    target: 2_000_000, current: 1_000_000, gap: 1_000_000, progressPct: 50,
    reached: false, monthsSavings: null, monthsNetWorth: null, savingsSamples: 3, netWorthSamples: 3,
  }, fmt);
  assert.match(slowing, /最近沒有淨存入/);
  assert.match(slowing, /最近淨值在下滑/);
  assert.doesNotMatch(slowing, /Infinity|−\d+ 個月|-\d+ 個月/);
});

test('已達標與未設定：達標只顯示完成狀態，未設定不佔總覽空間', () => {
  assert.equal(goalTrackingHtml(null, fmt), '');
  assert.equal(goalTrackingHtml({ target: 0 }, fmt), '');
  const html = goalTrackingHtml({
    target: 10_000_000, current: 12_000_000, gap: 0, progressPct: 100, reached: true,
  }, fmt);
  assert.match(html, /已達成/);
  assert.match(html, /aria-valuenow="100\.0"/);
  assert.doesNotMatch(html, /個月|data-goal-info/);
  assert.equal(GOAL_TRACKING_INFO.market.title, '為什麼「含市場」會變來變去？');
});
