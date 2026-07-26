import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchSectionHtml } from '../public/modules/portfolio-research.js';
import { holdingsTableHtml } from '../public/modules/portfolio-tables.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const formatMoney = value => `${Math.round(Number(value || 0))} 元`;
const formatPercent = (value, digits = 1) => `${(Number(value) || 0).toFixed(digits)}%`;
const formatters = { escapeHtml, formatMoney, formatPercent };

const holding = (overrides = {}) => ({
  id: 'h1',
  symbol: 'AAPL',
  name: 'Apple',
  layer: 'stock',
  quoteSymbol: 'AAPL',
  currency: 'USD',
  quantity: 10,
  avgCost: 100,
  cost: 1000,
  price: 120,
  valueTwd: 1200,
  costTwd: 1000,
  pnlTwd: 200,
  ...overrides
});

test('個股研究入口｜主表只有個股代號可在新分頁開啟，ETF、債券與名稱維持原樣', () => {
  const html = holdingsTableHtml([
    holding(),
    holding({ id: 'core', symbol: 'CSPX', name: 'Index ETF', layer: 'core' }),
    holding({ id: 'bond', symbol: '00720B', name: '美債', layer: 'bond' })
  ], 3600, { sortKey: 'value', sortDir: 'desc', formatters });

  assert.match(html, /href="#stock\?symbol=AAPL" target="_blank" rel="noopener"[^>]*><b>AAPL<\/b><\/a>/);
  assert.equal((html.match(/target="_blank"/g) || []).length, 1);
  assert.match(html, /<b>CSPX<\/b>/);
  assert.match(html, /<b>00720B<\/b>/);
  assert.doesNotMatch(html, /symbol=CSPX|symbol=00720B/);
  assert.doesNotMatch(html, /href="[^"]*Index ETF|href="[^"]*美債/);
  assert.match(html, /data-edit-h="h1"/);
});

test('個股研究入口｜代號先正規化、編碼與跳脫，不可把惡意文字變成屬性或標籤', () => {
  const html = holdingsTableHtml([
    holding({ symbol: ' x" <img src=x> ', name: '<script>alert(1)</script>' })
  ], 1200, { sortKey: 'value', sortDir: 'desc', formatters });

  assert.match(html, /href="#stock\?symbol=X%22%20%3CIMG%20SRC%3DX%3E"/);
  assert.match(html, /<b> x&quot; &lt;img src=x&gt; <\/b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img |<script>/);
});

test('個股研究入口｜既有摘要卡保留同一筆研究內容並增加詳細研究連結', () => {
  const html = researchSectionHtml([
    holding({ symbol: ' aapl ' })
  ], [{
    symbol: 'AAPL',
    thesis: '服務收入仍是核心論點',
    metrics: '毛利率',
    risks: '估值'
  }], formatters);

  assert.match(html, /服務收入仍是核心論點/);
  assert.match(html, /href="#stock\?symbol=AAPL" target="_blank" rel="noopener"[^>]*>詳細研究<\/a>/);
  assert.equal((html.match(/target="_blank"/g) || []).length, 1);
  assert.match(html, /data-edit-r="AAPL"/);
  assert.match(html, /data-add-cp="AAPL"/);
});
