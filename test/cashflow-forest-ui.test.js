import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cashflowMonthSummary, cashflowPeriodLabel } from '../public/modules/cashflow-model.js';

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

test('銀行收支期間：月份鍵轉成中文年月，壞值不硬猜', () => {
  assert.equal(cashflowPeriodLabel('2026-05'), '2026 年 5 月');
  assert.equal(cashflowPeriodLabel('2026-12'), '2026 年 12 月');
  assert.equal(cashflowPeriodLabel('2026-13'), '所選月份');
  assert.equal(cashflowPeriodLabel('本月'), '所選月份');
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
  assert.match(source, /class="cashflow-summary"/);
  assert.match(source, /const periodLabel = cashflowPeriodLabel\(monthFilter\);/);
  assert.match(source, /收支期間/);
  assert.match(source, /明細金流/);
  assert.match(source, /<strong>\$\{esc\(periodLabel\)\}尚無銀行收支<\/strong>/);
  assert.doesNotMatch(source, /本月尚無銀行收支/);
  assert.doesNotMatch(source, /<div class="card cashflow-stat"/);
  assert.doesNotMatch(source, /到「信用卡費」上傳信用卡帳單/);
  assert.match(source, /src="assets\/guide-return-neutral\.webp"/);
});

test('銀行收支樣式：摘要共用粗框、篩選是分段控制，手機維持三欄且表格自捲', () => {
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(css, /\.cashflow-workspace/);
  assert.match(css, /\.cashflow-summary-grid \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*border: 2px solid var\(--frame\)/);
  assert.match(css, /\.cashflow-stat \+ \.cashflow-stat \{ border-left: 2px solid var\(--frame\); \}/);
  assert.match(css, /\.cashflow-controls \{[\s\S]*border: 2px solid var\(--frame\)/);
  assert.match(css, /\.cashflow-flow-control \.chip-row \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.cashflow-flow-control \.chip:hover \{ background: var\(--card\); \}/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /\.cashflow-summary-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /\.cashflow-ledger table \{ min-width: 720px; \}/);
});
