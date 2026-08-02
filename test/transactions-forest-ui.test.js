import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isCardTx } from '../public/modules/categories.js';
import { consumptionCategoryTotals, topSpendCategories } from '../public/modules/refund-attribution.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('信用卡費摘要：先排除現金流，再依原消費月抵減配對退款', () => {
  const allRaw = [
    { id: 'p1', date: '2026-01-10', ledger: 'card', type: 'expense', category: '旅遊', amount: 1000 },
    { id: 'r1', date: '2026-03-05', ledger: 'card', type: 'expense', category: '其他', amount: -400 },
    { id: 'bank1', date: '2026-01-11', ledger: 'cashflow', type: 'income', category: '工作', amount: 999999 },
  ];
  const pairs = [{ refundId: 'r1', purchaseId: 'p1', purchaseMonth: '2026-01', amount: 400 }];
  const all = allRaw.filter(isCardTx);
  const janRows = all.filter(t => t.date.slice(0, 7) === '2026-01');
  const marRows = all.filter(t => t.date.slice(0, 7) === '2026-03');
  const janByCat = consumptionCategoryTotals(janRows, all, pairs, '2026-01', true);
  const marByCat = consumptionCategoryTotals(marRows, all, pairs, '2026-03', true);

  assert.equal(all.length, 2, '銀行收支不可混進信用卡頁');
  assert.equal(janRows.length, 1, '本月筆數仍是帳單原貌，不扣掉日後退款');
  assert.equal(Object.values(janByCat).reduce((sum, value) => sum + value, 0), 600);
  assert.deepEqual(topSpendCategories(janByCat), [['旅遊', 600]]);
  assert.equal(marRows.length, 1, '退款列仍留在退款月份的明細');
  assert.deepEqual({ ...marByCat }, {}, '配對退款不算進退款月份的消費統計');
});

test('信用卡費接線：退款退路、月份、匯入、查帳與店家入口全部保留', () => {
  const source = readFileSync(join(ROOT, 'public/modules/transactions.js'), 'utf8');
  assert.match(source, /const all = allRaw\.filter\(isCardTx\)/);
  assert.match(source, /consumptionCategoryTotals\(rows, all, pairs, monthFilter, Boolean\(refundData\)\)/);
  assert.match(source, /const expense = Object\.values\(byCat\)\.reduce/);
  assert.match(source, /topSpendCategories\(byCat, 6\)/);
  assert.match(source, /退款歸屬暫時讀不到/);
  assert.match(source, /unmatchedRefundsForMonth/);
  for (const id of ['uploadStmt', 'stmtBatches', 'monthSel', 'lensInfo', 'unmatchedInfo']) {
    assert.match(source, new RegExp(`id="${id}"`));
  }
  for (const attr of ['data-edit', 'data-del', 'data-store']) {
    assert.match(source, new RegExp(attr));
  }
  assert.match(source, /bindSortClicks\(view\(\), listSort, renderTransactions\)/);
  assert.match(source, /if \(seq !== currentRouteSeq\(\)\) return/);
  assert.match(source, /class="credit-workspace"/);
  assert.match(source, /本月尚無信用卡消費/);
  assert.match(source, /src="assets\/guide-return-neutral\.webp"/);
});

test('信用卡費樣式：桌機兩摘要加寬分類，手機改成兩列摘要', () => {
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(css, /\.credit-workspace/);
  assert.match(css, /\.credit-overview-grid \{[\s\S]*grid-template-columns: minmax\(0, \.72fr\) minmax\(0, \.72fr\) minmax\(0, 2fr\)/);
  assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*\.credit-overview-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.credit-overview-grid \{ grid-template-columns: 1fr; gap: 7px; \}/);
  assert.match(css, /\.credit-stat \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.credit-empty-state img/);
});
