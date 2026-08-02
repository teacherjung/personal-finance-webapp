import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { holdingsTableHtml } from '../public/modules/portfolio-tables.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const formatters = {
  escapeHtml,
  formatMoney: value => `${Math.round(Number(value || 0))} 元`,
  formatPercent: (value, digits = 1) => `${(Number(value) || 0).toFixed(digits)}%`
};

const holding = (overrides = {}) => ({
  id: 'h1', symbol: 'AAPL', name: 'Apple', layer: 'stock', quoteSymbol: 'AAPL',
  currency: 'USD', quantity: 10, avgCost: 168, cost: 1680, price: 205.5,
  valueTwd: 2055, costTwd: 1680, pnlTwd: 375,
  ...overrides
});

test('投資持股表森林工作面：專業標頭、持股檔數與既有九欄完整保留', () => {
  const html = holdingsTableHtml([
    holding(),
    holding({ id: 'h2', symbol: 'BND', name: 'Bond', layer: 'bond', quoteSymbol: 'BND' })
  ], 4110, { sortKey: 'value', sortDir: 'desc', formatters });

  assert.match(html, /<section class="portfolio-holdings-workspace" aria-labelledby="portfolio-holdings-title">/);
  assert.match(html, /<h2 id="portfolio-holdings-title">持股明細<\/h2>/);
  assert.match(html, /目前持有 <strong>2<\/strong> 檔/);
  for (const heading of ['代號', '說明', '均價', '現價', '市值', '損益', '報酬率', '佔比']) {
    assert.match(html, new RegExp(heading));
  }
  assert.match(html, /class="group-row portfolio-layer-row"/);
  assert.match(html, /class="portfolio-layer-label"/);
  assert.match(html, /class="subs-table portfolio-holdings-table"/);
});

test('投資持股表森林工作面：排序、研究、編輯與刪除接線沒有被外觀改版切斷', () => {
  const html = holdingsTableHtml([holding()], 2055, { sortKey: 'ret', sortDir: 'asc', formatters });
  assert.match(html, /data-hsort="ret" aria-sort="ascending">報酬率 <span class="sort-tri active">▲<\/span>/);
  assert.match(html, /href="#stock\?symbol=AAPL" target="_blank" rel="noopener"/);
  assert.match(html, /data-edit-h="h1"/);
  assert.match(html, /data-del-h="h1"/);
  assert.match(html, /aria-label="編輯 AAPL"/);
  assert.match(html, /aria-label="刪除 AAPL"/);

  const page = readFileSync(join(ROOT, 'public/modules/portfolio.js'), 'utf8');
  assert.match(page, /querySelectorAll\('th\[data-hsort\]'\)/);
  assert.match(page, /querySelectorAll\('\[data-edit-h\]'\)/);
  assert.match(page, /querySelectorAll\('\[data-del-h\]'\)/);
});

test('投資持股表森林工作面：空狀態使用小森森，且只指向本頁既有新增入口', () => {
  const html = holdingsTableHtml([], 0, { sortKey: 'value', sortDir: 'desc', formatters });
  assert.match(html, /class="portfolio-holdings-empty"/);
  assert.match(html, /src="assets\/guide-return-neutral\.webp"/);
  assert.match(html, /<strong>尚無持股<\/strong>/);
  assert.match(html, /頁首「新增持股」/);

  const header = readFileSync(join(ROOT, 'public/modules/portfolio-overview.js'), 'utf8');
  assert.match(header, /id="addHolding"[\s\S]*新增持股/);
});

test('投資持股表森林工作面：新增樣式全數鎖在專屬根節點，手機維持表格自捲', () => {
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(css, /\.portfolio-holdings-workspace \{ width: 100%; margin: 28px 0 16px; \}/);
  assert.match(css, /\.portfolio-holdings-workspace \.portfolio-holdings-table \{ min-width: 980px; \}/);
  assert.match(css, /\.portfolio-holdings-workspace \.portfolio-holdings-table-wrap \{[\s\S]*box-shadow: var\(--shadow-lg\)/);
  assert.match(css, /\.portfolio-holdings-workspace \.portfolio-layer-label \{[\s\S]*position: sticky; left: 14px/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.portfolio-holdings-workspace \.portfolio-holdings-head \{[\s\S]*flex-direction: column/);

  const block = css.slice(css.indexOf('/* ---------- 投資持股表森林工作面（UI3-3） ---------- */'), css.indexOf('/* ---------- 證券交易頁（S3）'));
  assert.ok(block.length > 0, '找不到持股表專屬樣式區塊');
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('@media') || trimmed.startsWith('}')) continue;
    if (trimmed.includes('{')) assert.ok(trimmed.startsWith('.portfolio-holdings-workspace'), `未鎖在持股表根節點：${trimmed}`);
  }
});
