import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cashflowMonthSummary } from '../public/modules/cashflow-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('銀行收支月摘要：0 是合法金額、內轉不進收入支出與結餘', () => {
  const rows = [
    { date: '2026-08-01', type: 'income', amount: 0 },
    { date: '2026-08-02', type: 'income', amount: 1000 },
    { date: '2026-08-03', type: 'expense', amount: 250 },
    { date: '2026-08-04', type: 'transfer', amount: 99999 },
    { date: '2026-07-31', type: 'expense', amount: 700 },
  ];
  const out = cashflowMonthSummary(rows, '2026-08');
  assert.equal(out.monthRows.length, 4);
  assert.deepEqual({ income: out.income, expense: out.expense, net: out.net }, {
    income: 1000, expense: 250, net: 750,
  });
});

test('銀行收支接線：帳本判準、四個篩選與所有既有操作入口仍在', () => {
  const source = readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8');
  assert.match(source, /allRaw\.filter\(t => !isCardTx\(t\)\)/);
  for (const flow of ['all', 'income', 'expense', 'transfer']) {
    assert.match(source, new RegExp(`flowTab\\('${flow}'`));
  }
  for (const id of ['monthSel', 'uploadBank', 'bankBatches', 'addCf']) {
    assert.match(source, new RegExp(`id="${id}"`));
  }
  assert.match(source, /data-edit=/);
  assert.match(source, /data-del=/);
  assert.match(source, /class="cashflow-workspace"/);
  assert.match(source, /本月尚無銀行收支/);
  assert.doesNotMatch(source, /到「信用卡費」上傳信用卡帳單/);
  assert.match(source, /src="assets\/guide-return-neutral\.webp"/);
});

test('銀行收支樣式只在頁面根節點下生效，手機摘要與篩選有固定尺寸', () => {
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(css, /\.cashflow-workspace/);
  assert.match(css, /\.cashflow-summary-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /\.cashflow-summary-grid \{ grid-template-columns: 1fr; gap: 7px; \}/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.cashflow-flow-control \.chip-row \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
});
