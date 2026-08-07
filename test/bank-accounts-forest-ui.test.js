import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');

function renderBlock(source) {
  const start = source.indexOf('export async function renderBankAccounts()');
  const end = source.indexOf('\nfunction bankAccRow(', start);
  assert.ok(start >= 0 && end > start, '找不到銀行帳戶頁正式函式');
  return source.slice(start, end);
}

function rowBlock(source) {
  const start = source.indexOf('function bankAccRow(');
  const end = source.indexOf('\n\n// 再平衡計算器', start);
  assert.ok(start >= 0 && end > start, '找不到銀行帳戶列正式函式');
  return source.slice(start, end);
}

function assertBankStructure(source) {
  const render = renderBlock(source);
  const row = rowBlock(source);
  for (const marker of [
    'class="bank-accounts-page"',
    'class="bank-account-summary"',
    'class="bank-privacy-note"',
    'bank-account-table',
    'class="bank-account-empty"',
    'id="addBankAcc"',
    'href="#cashflow"',
  ]) assert.match(render, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(render, /if \(seq !== currentRouteSeq\(\)\) return;/);
  assert.match(render, /defaultType: 'cash'/);
  assert.match(row, /esc\(x\.name\)/);
  assert.match(row, /esc\(x\.id\)/);
  assert.match(row, /x\.accountNoLast4/);
  assert.doesNotMatch(row, /x\.accountNo(?!Last4|Set)/, '帳戶列不可讀取完整帳號欄位');
}

function assertBankCss(css, index) {
  assert.match(index, /<link rel="stylesheet" href="bank-accounts\.css" \/>/);
  assert.match(css, /\.bank-account-summary \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*border: 2px solid var\(--frame\);/);
  assert.match(css, /\.bank-privacy-note \{[\s\S]*border-left: 5px solid var\(--accent\);/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*\.bank-account-table thead \{ display: none; \}[\s\S]*\.bank-account-table tr \{ padding: 0 16px;/);
  assert.doesNotMatch(css, /background:\s*var\(--(?:action|pos|pos-soft)\)/, '銀行帳戶頁不可變成綠色容器');
}

test('銀行帳戶 UI：摘要、隱私說明、帳戶列表與空狀態形成單一工作面', () => {
  assertBankStructure(read('public/modules/assets.js'));
});

test('銀行帳戶 UI：獨立暖色樣式有桌機摘要與手機資訊列，不碰共用 styles.css', () => {
  assertBankCss(read('public/bank-accounts.css'), read('public/index.html'));
});

test('銀行帳戶 UI：混合幣別只列幣別、不把原幣餘額硬加總', () => {
  const render = renderBlock(read('public/modules/assets.js'));
  assert.match(render, /currencies = \[\.\.\.new Set\(accounts\.map/);
  assert.match(render, /餘額依各帳戶原幣顯示，不跨幣別加總/);
  assert.doesNotMatch(render, /reduce\([^\n]*balance|totalBalance|總餘額/);
});

test('銀行帳戶列：只顯示投影末四碼，名稱與 id 仍經過輸出消毒', () => {
  const block = rowBlock(read('public/modules/assets.js'));
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const bankAccRow = Function('esc', 'icon', 'moneyCur', `${block}; return bankAccRow;`)(esc, () => '<svg></svg>', (value, cur) => `${cur} ${value}`);
  const html = bankAccRow({
    id: 'id"><script>', name: '<img src=x onerror=alert(1)>', type: 'cash', class: '現金',
    currency: 'TWD', balance: 1234, accountNo: '90010099887766', accountNoSet: true, accountNoLast4: '7766',
  });
  assert.match(html, /•••• 7766/);
  assert.doesNotMatch(html, /90010099887766/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /data-edit="id"><script>/);
});

test('銀行帳戶 UI：拿掉路由守衛、隱私說明或手機列表時考題會紅', () => {
  const source = read('public/modules/assets.js');
  const guardedEntry = "export async function renderBankAccounts() {\n  const seq = currentRouteSeq();\n  const db = await api('/db');\n  if (seq !== currentRouteSeq()) return;";
  assert.ok(source.includes(guardedEntry), '突變目標必須存在');
  assert.throws(() => assertBankStructure(source.replace(guardedEntry, guardedEntry.replace('if (seq !== currentRouteSeq()) return;', '// route guard removed'))));
  assert.throws(() => assertBankStructure(source.replace('class="bank-privacy-note"', 'class="plain-note"')));

  const css = read('public/bank-accounts.css');
  const index = read('public/index.html');
  assert.throws(() => assertBankCss(css.replace('.bank-account-table thead { display: none; }', '.bank-account-table thead { display: table-header-group; }'), index));
  assert.throws(() => assertBankCss(css, index.replace('<link rel="stylesheet" href="bank-accounts.css" />', '')));
});
