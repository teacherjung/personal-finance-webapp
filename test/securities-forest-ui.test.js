import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../public/modules/securities.js', import.meta.url), 'utf8');
const view = fs.readFileSync(new URL('../public/modules/securities-view.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/securities.css', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('證券交易頁載入獨立樣式，且不修改全站樣式的所有權邊界', () => {
  assert.match(index, /<link rel="stylesheet" href="securities\.css" \/>/);
  assert.match(css, /\.securities-page\s*\{/);
});

test('證券交易頁分成頁首、資料邊界、篩選與成交明細四個工作區', () => {
  for (const cls of ['securities-page-head', 'securities-boundary', 'securities-filter-section', 'securities-ledger-section']) {
    assert.match(page, new RegExp(`class="[^"]*${cls}`), cls);
  }
  assert.match(page, /這裡是成交紀錄的查帳頁/);
  assert.match(page, /不在這裡修改持股，也不把成交金額重複算進銀行收支/);
  assert.match(page, /逐筆核對成交、費稅與應收付/);
});

test('分幣別摘要與查帳表有專屬結構，不改既有數字與欄位內容', () => {
  assert.match(view, /class="securities-summary-grid"/);
  assert.match(view, /class="securities-summary-card"/);
  assert.match(view, /class="tbl-wrap securities-ledger-table"/);
  for (const label of ['買進總額', '賣出總額', '費稅合計', '淨應收付']) assert.match(view, new RegExp(label));
  for (const label of ['成交日', '交割日', '來源', '帳戶', '證券', '買賣', '數量', '成交價', '成交金額', '費稅', '淨應收付', '幣別']) {
    assert.match(view, new RegExp(`'${label}'`), label);
  }
});

test('視覺層維持米橘主色、綠色只留主要動作與正向財務語意', () => {
  assert.match(css, /\.securities-filter-section \.chip\.active[\s\S]*background: var\(--accent-soft\)/);
  assert.match(css, /box-shadow: inset 0 -3px 0 var\(--accent\)/);
  assert.doesNotMatch(css, /background:\s*var\(--pos(?:-soft)?\)/);
  assert.doesNotMatch(css, /background:\s*var\(--action\)/);
});

test('按鈕採 8px 圓角，12 欄查帳表只在表格內水平捲動', () => {
  assert.match(css, /\.securities-page-head \.page-actions \.btn,[\s\S]*border-radius: 8px/);
  assert.match(css, /\.securities-filter-section \.chip[\s\S]*border-radius: 8px/);
  assert.match(css, /\.securities-ledger-table table\s*\{\s*min-width: 1180px;/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.securities-ledger-table table\s*\{\s*min-width: 1120px;/);
});

test('手機動作、摘要、篩選都有明確單欄退化規則', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.match(mobile, /\.securities-page-head \.page-actions[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(mobile, /\.securities-summary-grid\s*\{\s*grid-template-columns: 1fr;/);
  assert.match(mobile, /\.securities-filter-section \.sec-toolbar > div,[\s\S]*width: 100%/);
});
