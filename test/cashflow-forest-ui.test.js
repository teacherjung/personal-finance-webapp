import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyLearnedBankToDb } from '../lib/services/bank-import.js';
import { emptyDb } from '../lib/store.js';
import {
  cashflowDateLabel,
  cashflowDescriptionLines,
  cashflowMonthSummary,
  cashflowPeriodLabel,
} from '../public/modules/cashflow-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('銀行收支月摘要：0 是合法金額、內轉只計轉出且不進收入支出與結餘', () => {
  const rows = [
    { date: '2026-08-01', type: 'income', amount: 0 },
    { date: '2026-08-02', type: 'income', amount: 1000 },
    { date: '2026-08-03', type: 'expense', amount: 250 },
    { date: '2026-08-04', type: 'transfer', dir: 'out', amount: 99999 },
    { date: '2026-08-04', type: 'transfer', dir: 'in', amount: 99999 },
    { date: '2026-07-31', type: 'expense', amount: 700 },
  ];
  const out = cashflowMonthSummary(rows, '2026-08');
  assert.equal(out.monthRows.length, 5);
  assert.deepEqual({ income: out.income, expense: out.expense, transfer: out.transfer, net: out.net }, {
    income: 1000, expense: 250, transfer: 99999, net: 750,
  });
});

test('銀行收支月摘要：舊銀行方向優先於可改的子分類；手動內轉按角色，方向不明不計', () => {
  const rows = [
    { date: '2026-08-01', type: 'transfer', amount: 100, dir: 'out', bankRef: 'bank|a|2026-08-01|in|100|', subcategory: '內轉入' },
    { date: '2026-08-02', type: 'transfer', amount: 200, dir: 'in', bankRef: 'bank|a|2026-08-02|out|200|', subcategory: '內轉出' },
    { date: '2026-08-03', type: 'transfer', amount: 300, bankRef: 'bank|a|2026-08-03|out|300|', subcategory: '內轉入' },
    { date: '2026-08-04', type: 'transfer', amount: 400, bankRef: 'bank2|銀行|a|2026-08-04|in|400|', subcategory: '內轉出' },
    { date: '2026-08-05', type: 'transfer', amount: 500, subcategory: '改名轉出' },
    { date: '2026-08-06', type: 'transfer', amount: 600, subcategory: '內轉出' },
    { date: '2026-08-07', type: 'transfer', amount: 700, subcategory: '自訂內轉' },
    { date: '2026-08-08', type: 'transfer', amount: 800, subcategory: '交割' },
    { date: '2026-07-31', type: 'transfer', amount: 900, dir: 'out' },
  ];
  const subs = [{ label: '改名轉出', role: 'out' }, { label: '自訂內轉' }];
  assert.equal(cashflowMonthSummary(rows, '2026-08', subs).transfer, 1500);
});

test('舊銀行內轉方向：前端月摘要與後端同類套用對兩種識別格式的判斷一致', () => {
  const rows = [
    { id: 'old-out', date: '2026-08-01', type: 'transfer', subcategory: '內轉入', amount: 100,
      bankRef: 'bank|900100****3301|2026-08-01|out|100|', bankKey: '合成鑰匙', source: 'bank' },
    { id: 'old-in', date: '2026-08-02', type: 'transfer', subcategory: '內轉出', amount: 200,
      bankRef: 'bank|900100****3301|2026-08-02|in|200|', bankKey: '合成鑰匙', source: 'bank' },
    { id: 'other-out', date: '2026-08-03', type: 'transfer', subcategory: '內轉入', amount: 300,
      bankRef: 'bank2|合成銀行|900100****3301|2026-08-03|out|300|', bankKey: '合成鑰匙', source: 'bank' },
    { id: 'other-in', date: '2026-08-04', type: 'transfer', subcategory: '內轉出', amount: 400,
      bankRef: 'bank2|合成銀行|900100****3301|2026-08-04|in|400|', bankKey: '合成鑰匙', source: 'bank' },
  ];
  const db = emptyDb();
  db.transactions = structuredClone(rows);
  db.learnedBank = { 合成鑰匙: { type: 'income', category: '其他', subcategory: '其他收入' } };
  const front = cashflowMonthSummary(rows, '2026-08');
  const back = applyLearnedBankToDb(db, '合成鑰匙');
  assert.equal(front.transfer, 400);
  assert.equal(back.skipped, 2, '後端應拒絕將兩筆轉出當收入');
  assert.deepEqual(db.transactions.filter(t => t.type === 'transfer').map(t => t.id),
    ['old-out', 'other-out'], '前端計入的轉出集合須與後端拒絕改收入的集合相同');
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

test('銀行收支明細：銀行匯入顯示原始摘要與備註，舊資料與手動記帳只退回既有說明', () => {
  assert.deepEqual(cashflowDescriptionLines({
    note: '整理後說明', bankSummary: '原始摘要', bankNote: '原始備註',
  }), { summary: '原始摘要', note: '原始備註' });
  assert.deepEqual(cashflowDescriptionLines({
    note: '整理後說明', bankSummary: '', bankNote: '',
  }), { summary: '', note: '' }, '兩個原文欄位都是空字串仍是合法原文');
  assert.deepEqual(cashflowDescriptionLines({
    note: '整理後說明', bankRef: 'bank|900100****1234|2026-08-26|out|300|9000|舊摘要|舊備註',
  }), { summary: '整理後說明', note: '' }, '本支不讓前端依賴 bankRef 的內部格式');
  assert.deepEqual(cashflowDescriptionLines({
    note: '半份原文退路', bankSummary: '只有摘要', bankNote: null,
  }), { summary: '半份原文退路', note: '' }, '兩欄沒有同時存在時不把半份資料冒充原文');
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
  assert.match(source, /cashflowMonthSummary\(all, monthFilter, Array\.isArray\(transferRes\) \? transferRes : \[\]\)/);
  assert.match(source, /const netTone = net >= 0 \? 'pos' : 'neg';/);
  assert.match(source, /data-kind="net" data-tone="\$\{netTone\}"/);
  assert.match(source, /class="stat sm \$\{netTone\}"/);
  assert.ok(source.indexOf('class="cashflow-summary"') < source.indexOf('class="cashflow-controls"'),
    '摘要區塊要排在年／月／金流篩選上方');
  assert.match(source, /const periodLabel = cashflowPeriodLabel\(monthFilter\);/);
  assert.match(source, /以銀行對帳單為準的真實現金流：收入、支出、內轉/);
  assert.doesNotMatch(source, /以銀行對帳單為準的真實現金流：收入、支出、帳戶互轉/);
  assert.match(source, /<strong>\$\{esc\(periodLabel\)\}<\/strong>/);
  assert.match(source, />內轉不列入收入與支出<\/p>/);
  assert.match(source, /<h3>內轉 <small>只計轉出<\/small><\/h3>/);
  for (const removedCopy of ['收支期間', '以銀行對帳單為準；內轉不列入收入與支出',
    '匯入與手動記錄', '不含帳戶內轉', '收入減支出']) {
    assert.doesNotMatch(source, new RegExp(removedCopy));
  }
  assert.match(source, /cashflow-control-label">金流</);
  assert.doesNotMatch(source, /明細金流/);
  assert.match(source, /th\('date', '日期'\)/);
  assert.doesNotMatch(source, /th\('date', '收支日'\)/);
  assert.match(source, /class="muted nowrap cashflow-account-cell"/);
  assert.match(source, /th\('note', '摘要＋備註'\)/);
  assert.doesNotMatch(source, /th\('note', '收支說明'\)/);
  assert.match(source, /class="cf-note-summary"/);
  assert.match(source, /class="cf-note-remark"/);
  assert.match(source, /<th>日期<\/th><th>銀行帳戶<\/th><th>摘要＋備註<\/th><th>分類<\/th><th class="num">金額<\/th>/);
  assert.match(source, /cashflowDateLabel\(x\.date\)/);
  assert.match(source, /cashflowDescriptionLines\(x\)/);
  assert.match(source, /<strong>\$\{esc\(periodLabel\)\}尚無銀行收支<\/strong>/);
  assert.doesNotMatch(source, /本月尚無銀行收支/);
  assert.doesNotMatch(source, /<div class="card cashflow-stat"/);
  assert.doesNotMatch(source, /到「信用卡費」上傳信用卡帳單/);
  assert.match(source, /src="assets\/guide-return-neutral\.webp"/);
});

test('銀行收支樣式：摘要共用粗框、三組篩選、帳戶單行與說明雙行都固定', () => {
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(css, /\.cashflow-workspace/);
  assert.match(css, /\.cashflow-summary-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[^}]*border: 2px solid var\(--frame\)/);
  assert.match(css, /\.cashflow-stat\[data-kind="income"\]::before \{ background: var\(--pos\); \}/);
  assert.match(css, /\.cashflow-stat\[data-kind="expense"\]::before \{ background: var\(--neg\); \}/);
  assert.match(css, /--cashflow-neutral: #858585;/);
  assert.match(css, /\.cashflow-stat\[data-kind="transfer"\]::before \{ background: var\(--cashflow-neutral\); \}/);
  assert.match(css, /\.cashflow-stat\[data-kind="transfer"\] \.stat \{ color: var\(--cashflow-neutral\); \}/);
  assert.match(css, /\.cashflow-stat\[data-kind="net"\]\[data-tone="pos"\]::before \{ background: var\(--pos\); \}/);
  assert.match(css, /\.cashflow-stat\[data-kind="net"\]\[data-tone="neg"\]::before \{ background: var\(--neg\); \}/);
  assert.match(css, /\.cashflow-stat \+ \.cashflow-stat \{ border-left: 2px solid var\(--frame\); \}/);
  assert.match(css, /\.cashflow-controls \{[\s\S]*border: 2px solid var\(--frame\)/);
  assert.match(css, /\.cashflow-controls \{[\s\S]*grid-template-columns: minmax\(130px, 180px\) minmax\(130px, 180px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.cashflow-controls \{[^}]*align-items: start/,
    '年份、月份、金流三組從頂端對齊，標題才會落在同一水平線');
  assert.match(css, /@media \(min-width: 641px\) and \(max-width: 960px\) \{[\s\S]*\.cashflow-flow-control \{ grid-column: 1 \/ -1; \}/);
  assert.match(css, /\.cashflow-flow-control \.chip-row \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.cashflow-flow-control \.chip:hover \{ background: var\(--card\); \}/);
  assert.match(css, /\.cashflow-account-cell \{[^}]*white-space: nowrap/);
  assert.match(css, /\.cf-note-summary, \.cf-note-remark \{[^}]*display: block/);
  assert.match(css, /\.cf-note-summary \{[^}]*font-weight: 400/,
    '摘要與備註維持層次但不用粗體強調摘要');
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /\.cashflow-summary-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /\.cashflow-ledger table \{ min-width: 720px; \}/);
});
