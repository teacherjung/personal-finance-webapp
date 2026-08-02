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

function assertNineColumnHeader(html) {
  const tableHead = html.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/)?.[1] || '';
  assert.equal((tableHead.match(/<th\b/g) || []).length, 9);
  for (const heading of ['代號', '說明', '均價', '現價']) {
    assert.match(tableHead, new RegExp(`<th>${heading}<\\/th>`));
  }
  for (const [key, heading] of [['value', '市值'], ['pnl', '損益'], ['ret', '報酬率'], ['weight', '佔比']]) {
    assert.match(tableHead, new RegExp(`data-hsort="${key}"[^>]*>${heading} `));
  }
}

function dataRowsWithCells(html) {
  const tableBody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
  return [...tableBody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => ({
    cells: [...row[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(cell => ({
      attrs: cell[1],
      html: cell[2].trim()
    }))
  }));
}

function assertWorkspaceCss(css) {
  const block = css.slice(css.indexOf('/* ---------- 投資持股表森林工作面（UI3-3） ---------- */'), css.indexOf('/* ---------- 證券交易頁（S3）'));
  assert.ok(block.length > 0, '找不到持股表專屬樣式區塊');

  const ruleBodies = selector => [...block.matchAll(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`, 'g'))].map(match => match[1]);
  const hasDeclaration = (selector, pattern) => ruleBodies(selector).some(body => pattern.test(body));
  assert.ok(hasDeclaration('.portfolio-holdings-workspace .portfolio-holdings-table-wrap', /box-shadow: var\(--shadow-lg\);/));
  assert.ok(hasDeclaration('.portfolio-holdings-workspace .portfolio-layer-label', /position: sticky; left: 16px;/));
  assert.ok(hasDeclaration('.portfolio-holdings-workspace .portfolio-holdings-head', /align-items: flex-start; flex-direction: column;/));
  assert.ok(hasDeclaration('.portfolio-holdings-workspace .portfolio-holdings-empty', /position: sticky; left: 16px;/));

  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1].trim();
    if (prelude.startsWith('@media')) continue;
    for (const selector of prelude.split(',')) {
      assert.ok(selector.trim().startsWith('.portfolio-holdings-workspace'), `未鎖在持股表根節點：${selector.trim()}`);
    }
  }
}

test('投資持股表森林工作面：專業標頭、持股檔數與既有九欄完整保留', () => {
  const rows = [
    holding({ expectedCurrentPrice: '206 USD' }),
    holding({
      id: 'h2', symbol: 'BND', name: 'Bond', layer: 'bond', quoteSymbol: 'BND',
      price: 7.45, valueTwd: 1400, costTwd: 1680, pnlTwd: -280,
      expectedCurrentPrice: '7.5 USD'
    }),
    holding({
      id: 'h3', symbol: 'GLD', name: 'Gold', layer: 'gold', quoteSymbol: 'GLD',
      quantity: 10, avgCost: 50, cost: 500, price: 50,
      valueTwd: 500, costTwd: 500, pnlTwd: 0,
      expectedCurrentPrice: '50 USD'
    })
  ];
  const total = rows.reduce((sum, row) => sum + row.valueTwd, 0);
  const html = holdingsTableHtml(rows, total, { sortKey: 'value', sortDir: 'desc', formatters });

  assert.match(html, /<section class="portfolio-holdings-workspace" aria-labelledby="portfolio-holdings-title">/);
  assert.match(html, /<h2 id="portfolio-holdings-title">持股明細<\/h2>/);
  assert.match(html, /目前持有 <strong>3<\/strong> 檔/);
  assertNineColumnHeader(html);
  assert.match(html, /class="group-row portfolio-layer-row"/);
  assert.match(html, /class="portfolio-layer-label"/);
  assert.match(html, /class="subs-table portfolio-holdings-table"/);

  const dataRows = dataRowsWithCells(html);
  assert.equal(dataRows.length, rows.length);
  for (const row of dataRows) assert.equal(row.cells.length, 9);

  for (const source of rows) {
    const rendered = dataRows.find(row => row.cells[0].html.includes(`>${source.symbol}<`));
    assert.ok(rendered, `找不到 ${source.symbol} 的資料列`);
    assert.equal(rendered.cells[3].html, source.expectedCurrentPrice);
    assert.equal(rendered.cells[4].html, formatters.formatMoney(source.valueTwd));
    assert.equal(rendered.cells[5].html, `${source.pnlTwd >= 0 ? '+' : ''}${formatters.formatMoney(source.pnlTwd)}`);
    assert.equal(rendered.cells[6].html, formatters.formatPercent(source.pnlTwd / source.costTwd * 100));
    assert.equal(rendered.cells[7].html, formatters.formatPercent(source.valueTwd / total * 100));
    assert.match(rendered.cells[5].attrs, new RegExp(`\\b${source.pnlTwd >= 0 ? 'pos' : 'neg'}\\b`));
    assert.match(rendered.cells[6].attrs, new RegExp(`\\b${source.pnlTwd >= 0 ? 'pos' : 'neg'}\\b`));
  }
});

test('投資持股表森林工作面：排序、研究、編輯與刪除接線沒有被外觀改版切斷', () => {
  const html = holdingsTableHtml([holding()], 2055, { sortKey: 'ret', sortDir: 'asc', formatters });
  assert.match(html, /data-hsort="ret" aria-sort="ascending">報酬率 <span class="sort-tri active">▲<\/span>/);
  assert.match(html, /href="#stock\?symbol=AAPL" target="_blank" rel="noopener"/);
  assert.match(html, /data-edit-h="h1"/);
  assert.match(html, /data-del-h="h1"/);
  assert.match(html, /aria-label="編輯 AAPL"/);
  assert.match(html, /aria-label="刪除 AAPL"/);

  const quoted = holdingsTableHtml([
    holding({ symbol: 'AAPL" autofocus onfocus="alert(1)' })
  ], 2055, { sortKey: 'value', sortDir: 'desc', formatters });
  assert.match(quoted, /aria-label="編輯 AAPL&quot; autofocus onfocus=&quot;alert\(1\)"/);
  assert.doesNotMatch(quoted, /aria-label="編輯 AAPL" autofocus/);

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
  assertWorkspaceCss(css);
});

test('投資持股表森林工作面：刪欄、拿掉手機堆疊或混入全站 selector 都會讓考題變紅', () => {
  const html = holdingsTableHtml([holding()], 2055, { sortKey: 'value', sortDir: 'desc', formatters });
  const missingColumns = html
    .replace(/<th class="sortable" data-hsort="pnl"[\s\S]*?<\/th>/, '')
    .replace(/<th class="sortable" data-hsort="weight"[\s\S]*?<\/th>/, '');
  assert.throws(() => assertNineColumnHeader(missingColumns));

  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
  const withoutMobileStack = css.replace(
    '.portfolio-holdings-workspace .portfolio-holdings-head {\n    align-items: flex-start; flex-direction: column;',
    '.portfolio-holdings-workspace .portfolio-holdings-head {\n    align-items: flex-start;'
  );
  assert.throws(() => assertWorkspaceCss(withoutMobileStack));

  const leakedSelector = css.replace('/* ---------- 證券交易頁（S3）', '.portfolio-holdings-workspace .x, .num,\n.stat, .portfolio-holdings-workspace .y { color: red; }\n\n/* ---------- 證券交易頁（S3）');
  assert.throws(() => assertWorkspaceCss(leakedSelector));
});
