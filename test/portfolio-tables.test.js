import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdingsTableHtml, watchlistSectionHtml } from '../public/modules/portfolio-tables.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const formatMoney = (value) => `${Math.round(Number(value || 0))} 元`;
const formatPercent = (value, digits = 1) => `${(Number(value) || 0).toFixed(digits)}%`;
const formatters = { escapeHtml, formatMoney, formatPercent };

const holding = (overrides = {}) => ({
  id: 'h1', symbol: 'AAA', name: 'Alpha', layer: 'core', quoteSymbol: 'AAA',
  currency: 'USD', quantity: 10, avgCost: 8.4, cost: 84, price: 12,
  valueTwd: 120, costTwd: 84, pnlTwd: 36,
  ...overrides
});

test('投資主表｜依層分組、組內依市值排序，價格格式與手動標記維持原樣', () => {
  const html = holdingsTableHtml([
    holding({ id: 'a', symbol: 'AAA', valueTwd: 100 }),
    holding({ id: 'b', symbol: 'BBB', valueTwd: 200, quoteSymbol: '' }),
    holding({ id: 'c', symbol: 'CCC', layer: 'stock', valueTwd: 300 })
  ], 600, { sortKey: 'value', sortDir: 'desc', formatters });

  assert.ok(html.indexOf('核心（美股）') < html.indexOf('個股'));
  assert.ok(html.indexOf('<b>BBB</b>') < html.indexOf('<b>AAA</b>'));
  assert.match(html, /<b>BBB<\/b> <span class="tag"[^>]*>手動<\/span>/);
  assert.match(html, />8\.4 USD<\/td>/);
  assert.match(html, /data-hsort="value">市值 <span class="sort-tri active">▼<\/span>/);
});

test('投資主表｜報酬率升冪正確；惡意 localStorage 排序鍵退回市值、不讀原型', () => {
  const rows = [
    holding({ id: 'gain', symbol: 'GAIN', valueTwd: 100, costTwd: 50, pnlTwd: 50 }),
    holding({ id: 'loss', symbol: 'LOSS', valueTwd: 200, costTwd: 100, pnlTwd: -50 })
  ];
  const byReturn = holdingsTableHtml(rows, 300, { sortKey: 'ret', sortDir: 'asc', formatters });
  assert.ok(byReturn.indexOf('<b>LOSS</b>') < byReturn.indexOf('<b>GAIN</b>'));

  const protoFallback = holdingsTableHtml(rows, 300, { sortKey: 'toString', sortDir: 'desc', formatters });
  assert.ok(protoFallback.indexOf('<b>LOSS</b>') < protoFallback.indexOf('<b>GAIN</b>'));
  assert.doesNotMatch(protoFallback, /sort-tri active/);
});

test('投資主表｜空資料有提示；持股文字與資料 id 進 HTML 前都消毒', () => {
  const empty = holdingsTableHtml([], 0, { sortKey: 'value', sortDir: 'desc', formatters });
  assert.match(empty, /尚無持股，點右上角新增/);

  const html = holdingsTableHtml([
    holding({ id: 'x" onmouseover="alert(1)', symbol: '<script>alert(1)</script>', name: '<img src=x onerror=alert(1)>' })
  ], 120, { sortKey: 'value', sortDir: 'desc', formatters });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-edit-h="x&quot; onmouseover=&quot;alert\(1\)"/);
  assert.doesNotMatch(html, /<script>|<img /);
});

test('投資願望清單｜到價、距離、缺報價、價格格式、空狀態與 XSS 都鎖住', () => {
  const html = watchlistSectionHtml([
    { id: 'w1', symbol: 'READY', name: 'Ready', targetPrice: 100, lastPrice: 95, currency: 'USD', note: '到價' },
    { id: 'w2', symbol: 'WAIT', name: 'Wait', targetPrice: 100, lastPrice: 120, currency: 'USD', note: '再等等' },
    { id: 'w3', symbol: '<img src=x>', name: '<script>x</script>', targetPrice: 5.4, lastPrice: 0, currency: 'USD', note: '<b>note</b>' }
  ], formatters);

  assert.match(html, /READY[\s\S]*到價！可依紀律買進/);
  assert.match(html, /WAIT[\s\S]*還差 20\.0%/);
  assert.match(html, /5\.4 USD/);
  assert.match(html, /按「更新報價」/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;note&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>|<img /);

  const empty = watchlistSectionHtml([], formatters);
  assert.match(empty, /尚無項目/);
});
