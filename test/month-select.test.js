// 月份選單共用件考題（系統優化 U4）：transactions/cashflow 兩頁歸戶後的單一真相。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveMonths,
  deriveYears,
  fallbackMonth,
  monthNumbersForYear,
  monthNumberOptionsHtml,
  monthOptionsHtml,
  yearOptionsHtml,
} from '../public/modules/month-select.js';

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

test('年／月拆分：年份新到舊、月份只取所選年並保留兩位數', () => {
  const months = ['2026-08', '2026-03', '2025-12', '2025-01'];
  assert.deepEqual(deriveYears(months), ['2026', '2025']);
  assert.deepEqual(monthNumbersForYear(months, '2026'), ['08', '03']);
  assert.deepEqual(monthNumbersForYear(months, '2024'), []);
});

test('年／月 options：顯示中文單位、selected 唯一，空清單保留目前值', () => {
  const years = yearOptionsHtml(['2026', '2025'], '2025', esc);
  assert.match(years, /<option value="2025" selected>2025 年<\/option>/);
  assert.doesNotMatch(years, /value="2026" selected/);
  assert.equal(yearOptionsHtml([], '2026', esc), '<option value="2026" selected>2026 年</option>');

  const months = monthNumberOptionsHtml(['08', '03'], '03', esc);
  assert.match(months, /<option value="03" selected>3 月<\/option>/);
  assert.doesNotMatch(months, /value="08" selected/);
  assert.equal(monthNumberOptionsHtml([], '08', esc), '<option value="08" selected>8 月</option>');
});
