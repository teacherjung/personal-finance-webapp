import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  cashflowDateLabel,
  cashflowDescriptionLines,
  cashflowMonthSummary,
  cashflowPeriodLabel,
} from '../public/modules/cashflow-model.js';

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

test('銀行收支明細：日期只顯示月日，壞值保留原字避免猜錯', () => {
  assert.equal(cashflowDateLabel('2026-08-26'), '8/26');
  assert.equal(cashflowDateLabel('2026-01-03'), '1/3');
  assert.equal(cashflowDateLabel('2026-13-03'), '2026-13-03');
  assert.equal(cashflowDateLabel(''), '—');
});

test('銀行收支明細：銀行匯入顯示原始摘要與備註，舊資料與手動記帳有退路', () => {
  assert.deepEqual(cashflowDescriptionLines({
    note: '整理後說明', bankSummary: '原始摘要', bankNote: '原始備註',
  }), { summary: '原始摘要', note: '原始備註' });
  assert.deepEqual(cashflowDescriptionLines({
    note: '整理後說明', bankRef: 'bank|900100****1234|2026-08-26|out|300|9000|舊摘要|舊備註',
  }), { summary: '舊摘要', note: '舊備註' });
  assert.deepEqual(cashflowDescriptionLines({ note: '手動輸入說明' }), {
    summary: '手動輸入說明', note: '',
  });
});

test('銀行收支接線（字面釘：只掃原始碼字串；分堆結果的行為題在 test/ledger-split-behavior.test.js）：四個金流 chip、清單裡指定的元素 id、編輯／刪除屬性、摘要與空狀態文案各有一處', () => {
  const source = readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8');
  assert.match(source, /allRaw\.filter\(t => !isCardTx\(t\)\)/);
  for (const flow of ['all', 'income', 'expense', 'transfer']) {
    assert.match(source, new RegExp(`flowTab\\('${flow}'`));
  }
  for (const id of ['yearSel', 'monthSel', 'uploadBank', 'bankBatches', 'addCf']) {
    assert.match(source, new RegExp(`id="${id}"`));
  }
  const actions = source.match(/<div class="page-actions">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.ok(actions.indexOf('id="bankBatches"') < actions.indexOf('id="addCf"'));
  assert.ok(actions.indexOf('id="addCf"') < actions.indexOf('id="uploadBank"'));
  assert.match(source, /data-edit=/);
  assert.match(source, /data-del=/);
  assert.match(source, /class="cashflow-workspace"/);
  assert.match(source, /class="cashflow-summary"/);
  assert.ok(source.indexOf('class="cashflow-summary"') < source.indexOf('class="cashflow-controls"'),
    '摘要區塊要排在年／月／金流篩選上方');
  assert.match(source, /const periodLabel = cashflowPeriodLabel\(monthFilter\);/);
  assert.match(source, /收支期間/);
  assert.match(source, /cashflow-control-label">金流</);
  assert.doesNotMatch(source, /明細金流/);
  assert.match(source, /th\('date', '日期'\)/);
  assert.doesNotMatch(source, /th\('date', '收支日'\)/);
  assert.match(source, /class="muted nowrap cashflow-account-cell"/);
  assert.match(source, /class="cf-note-summary"/);
  assert.match(source, /class="cf-note-remark"/);
  assert.match(source, /<strong>\$\{esc\(periodLabel\)\}尚無銀行收支<\/strong>/);
  assert.doesNotMatch(source, /本月尚無銀行收支/);
  assert.doesNotMatch(source, /<div class="card cashflow-stat"/);
  assert.doesNotMatch(source, /到「信用卡費」上傳信用卡帳單/);
  assert.match(source, /src="assets\/guide-return-neutral\.webp"/);
});

test('銀行收支樣式：摘要共用粗框、三組篩選、帳戶單行與說明雙行都固定', () => {
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(css, /\.cashflow-workspace/);
  assert.match(css, /\.cashflow-summary-grid \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*border: 2px solid var\(--frame\)/);
  assert.match(css, /\.cashflow-stat \+ \.cashflow-stat \{ border-left: 2px solid var\(--frame\); \}/);
  assert.match(css, /\.cashflow-controls \{[\s\S]*border: 2px solid var\(--frame\)/);
  assert.match(css, /\.cashflow-controls \{[\s\S]*grid-template-columns: minmax\(130px, 180px\) minmax\(130px, 180px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.cashflow-flow-control \.chip-row \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.cashflow-flow-control \.chip:hover \{ background: var\(--card\); \}/);
  assert.match(css, /\.cashflow-account-cell \{[^}]*white-space: nowrap/);
  assert.match(css, /\.cf-note-summary, \.cf-note-remark \{[^}]*display: block/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /\.cashflow-summary-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /\.cashflow-ledger table \{ min-width: 720px; \}/);
});
