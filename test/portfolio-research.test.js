import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchFormModel, researchSectionHtml } from '../public/modules/portfolio-research.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const formatPercent = (value, digits = 1) => `${(Number(value) || 0).toFixed(digits)}%`;
const formatters = { escapeHtml, formatPercent };

const holding = (overrides = {}) => ({
  symbol: 'AAPL', name: 'Apple', layer: 'stock', costTwd: 100, pnlTwd: 25,
  ...overrides
});

test('個股研究卡｜只顯示個股層，研究代號不分大小寫並保留原報酬口徑', () => {
  const html = researchSectionHtml([
    holding(),
    holding({ symbol: 'CSPX', name: 'Index', layer: 'core' })
  ], [{ symbol: 'aapl', thesis: '服務收入成長', metrics: '毛利率', risks: '估值過高' }], formatters);

  assert.match(html, /AAPL/);
  assert.match(html, /服務收入成長/);
  assert.match(html, /關鍵指標：.*毛利率/);
  assert.match(html, /風險：.*估值過高/);
  assert.match(html, />\+25\.0%<\/span>/);
  assert.doesNotMatch(html, /CSPX|Index/);
});

test('個股研究卡｜只列最近四筆檢查點，最新一筆排最前面且不改原陣列', () => {
  const checkpoints = Array.from({ length: 6 }, (_, index) => ({ date: `2026-0${index + 1}-01`, note: `note-${index + 1}` }));
  const before = structuredClone(checkpoints);
  const html = researchSectionHtml([holding()], [{ symbol: 'AAPL', thesis: '論點', checkpoints }], formatters);

  assert.ok(html.indexOf('note-6') < html.indexOf('note-5'));
  assert.match(html, /note-6/);
  assert.match(html, /note-3/);
  assert.doesNotMatch(html, /note-2|note-1/);
  assert.deepEqual(checkpoints, before);
});

test('個股研究卡｜空狀態與未寫論點提示維持原樣', () => {
  assert.match(researchSectionHtml([], [], formatters), /尚無個股研究卡/);
  const html = researchSectionHtml([holding({ pnlTwd: -10 })], [], formatters);
  assert.match(html, /還沒寫投資論點/);
  assert.match(html, /<span class="tag amber">-10\.0%<\/span>/);
  assert.match(html, /data-add-cp="AAPL"/);
});

test('個股研究卡｜所有使用者文字與資料屬性進 HTML 前都消毒', () => {
  const symbol = 'X" onmouseover="alert(1)';
  const html = researchSectionHtml([
    holding({ symbol, name: '<img src=x onerror=alert(1)>' })
  ], [{
    symbol,
    thesis: '<script>alert(1)</script>',
    checkpoints: [{ date: '<b>date</b>', note: '<svg onload=alert(1)>' }]
  }], formatters);

  assert.match(html, /X&quot; onmouseover=&quot;alert\(1\)/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>|<img |<svg onload/);
});

test('個股研究表單｜回傳既有資料；新代號則使用空值並保留固定欄位', () => {
  const existing = { id: 'r1', symbol: 'AAPL', thesis: '既有論點' };
  const edit = researchFormModel('aapl', [existing]);
  assert.equal(edit.existing, existing);
  assert.equal(edit.values, existing);
  assert.equal(edit.title, 'aapl 研究卡');
  assert.deepEqual(edit.fields.map(field => field.key), ['thesis', 'metrics', 'risks']);

  const fresh = researchFormModel('GOOGL', [existing]);
  assert.equal(fresh.existing, null);
  assert.deepEqual(fresh.values, {});
});
