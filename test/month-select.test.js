// 月份選單共用件考題（系統優化 U4）：transactions/cashflow 兩頁歸戶後的單一真相。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMonths, fallbackMonth, monthOptionsHtml } from '../public/modules/month-select.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));

test('deriveMonths：去重、新→舊、缺日期/非字串跳過', () => {
  assert.deepEqual(deriveMonths([
    { date: '2026-06-15' }, { date: '2026-07-01' }, { date: '2026-06-02' },
    { date: null }, {}, { date: 123 },
  ]), ['2026-07', '2026-06']);
  assert.deepEqual(deriveMonths([]), []);
  assert.deepEqual(deriveMonths(null), []);
});

test('fallbackMonth：在清單保留原值；不在→回退最新月；清單空→保留原值（原兩頁行為原樣）', () => {
  assert.equal(fallbackMonth('2026-06', ['2026-07', '2026-06']), '2026-06');
  assert.equal(fallbackMonth('2025-01', ['2026-07', '2026-06']), '2026-07');
  assert.equal(fallbackMonth('2026-05', []), '2026-05');
});

test('monthOptionsHtml：selected 只掛目前月；清單空顯示目前值唯一選項；值有 esc', () => {
  const html = monthOptionsHtml(['2026-07', '2026-06'], '2026-06', esc);
  assert.match(html, /<option value="2026-06" selected>2026-06<\/option>/);
  assert.doesNotMatch(html, /value="2026-07" selected/);
  assert.equal(monthOptionsHtml([], '2026-05', esc), '<option>2026-05</option>');
  assert.match(monthOptionsHtml(['<x>'], '<x>', esc), /&lt;x&gt;/);
});
