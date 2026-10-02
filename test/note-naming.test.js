// 名詞統一（William 2026-10-02 更新）：銀行預覽與收支明細都叫「摘要＋備註」。
// 預覽顯示帳單原文；明細的第二行可由另存的使用者備註覆蓋。
// 整理後的 `note` 仍供匯入與學習使用，不冒充帳單原文。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankPreviewFootnote, bankBlockedWarningHtml, bankSimilarWarningHtml, bankSimilarTagHtml, bankCardLedgerNote, cashflowDateLabel, cashflowDescriptionLines } from '../public/modules/cashflow-model.js';
import { aiPreviewBadgeHtml } from '../public/modules/ai-consent.js';
import { previewBankTxForDb, importBankTxToDb } from '../lib/services/bank-import.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');
const src = () => read('public/modules/cashflow.js');

/** 跑真的預覽 body 樣板（同 bank-preview-layout.test.js 的手法：不抄樣板、抄了就是在驗抄本） */
function renderPreviewBody(/** @type {any} */ r) {
  const source = src();
  const start = source.indexOf('function showBankPreview(');
  assert.ok(start >= 0, '找不到 showBankPreview');
  const bodyStart = source.indexOf('const rows = r.rows || [];', start);
  const bodyEnd = source.indexOf('\n`;\n', bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, '找不到 body 樣板起訖');
  const chunk = source.slice(bodyStart, bodyEnd + 3);
  const esc = (/** @type {any} */ v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return Function('r', 'esc', 'money', 'ACTION_LABEL', 'gateSummaryHtml',
    'bankBlockedWarningHtml', 'bankSimilarWarningHtml', 'bankSimilarTagHtml',
    'bankPreviewFootnote', 'aiPreviewBadgeHtml', 'recipePreviewBadgeHtml', 'bankCardLedgerNote',
    'cashflowDateLabel', 'cashflowDescriptionLines',
    `${chunk}\n return body;`)(
    r, esc, String, { update: '更新餘額' }, () => '<div data-stub="gate"></div>',
    bankBlockedWarningHtml, bankSimilarWarningHtml, bankSimilarTagHtml,
    bankPreviewFootnote, aiPreviewBadgeHtml, () => '', bankCardLedgerNote,
    cashflowDateLabel, cashflowDescriptionLines);
}

/** 外殼合成資料（rows 由各題自帶）。全部假值、零真實帳單內容。 */
const SHELL = Object.freeze({
  bank: '合成銀行', referenceDate: '2026-05-31', reconcile: { level: 'strong', ok: true }, rows: [],
});
const wrap = (/** @type {any[]} */ rows) =>
  ({ ...SHELL, transactions: { counts: { expense: rows.length }, rows } });

test('統一欄名｜預覽表與收支頁都叫「摘要＋備註」，預覽固定五欄', () => {
  assert.match(src(), /<th>日期<\/th><th>銀行帳戶<\/th><th>摘要＋備註<\/th><th>分類<\/th><th class="num">金額<\/th>/u,
    '★預覽表＝日期、銀行帳戶、摘要＋備註、分類、金額');
  assert.match(src(), /th\('note', '摘要＋備註'\)/u, '★收支頁欄名同步更新');
  assert.match(src(), /cashflowDescriptionLines\(t\)/u,
    '★收支明細要透過兩行顯示函式讀帳單原始摘要與備註');
});

test('跨層｜預覽同時拿到原始摘要／備註與整理後說明，畫面只用原文兩行', () => {
  const raw = { acctSuffix: '0001', acctMasked: '999900****0001', date: '2026-05-02',
    summary: 'CD轉出', direction: 'out', amount: 100, balance: null, note: '合成分行 0000123 Wei' };
  const db = { transactions: [], accounts: [], settings: {} };
  const { rows } = previewBankTxForDb(db, {
    bank: '台新', accounts: [], accountCurrency: { '999900****0001': 'TWD' }, transactions: [raw] });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row.note && row.note !== row.summary,
    `★前提自檢：整理後說明（${row.note}）必須≠原始摘要（${row.summary}）——相同的話本題什麼都證明不了`);
  assert.match(String(row.note), /現金轉出/u, '★「CD轉出」要被翻成白話（服務層既有行為）');
  assert.equal(row.bankSummary, raw.summary, '★預覽回應另帶原始摘要');
  assert.equal(row.bankNote, raw.note, '★預覽回應另帶原始備註');
  const html = renderPreviewBody(wrap([row]));
  assert.match(html, />CD轉出<\/span>/u, '★預覽第一行顯示帳單原始摘要');
  assert.match(html, />合成分行 0000123 Wei<\/span>/u, '★預覽第二行顯示帳單原始備註');
  assert.doesNotMatch(html, />現金轉出[^<]*<\/span>/u, '★整理後說明不可取代帳單原文');
  assert.match(html, />5\/2<\/td>/u, '★預覽日期只顯示月／日');
  // 整理後說明仍是正式匯入保存的 note，這次只改預覽呈現，不改帳本資料語意。
  const db2 = { transactions: [], accounts: [], settings: {} };
  importBankTxToDb(db2, {
    bank: '台新', accounts: [], accountCurrency: { '999900****0001': 'TWD' }, transactions: [raw] });
  assert.equal(db2.transactions.length, 1, '寫入端要真的落一筆');
  assert.equal(db2.transactions[0].note, row.note,
    '★既有整理後 note 的保存語意不因預覽改顯示原文而改變');
});

test('行為｜已學列保留「已學」標籤，但摘要與備註仍顯示帳單原文', () => {
  const html = renderPreviewBody(wrap([
    { date: '2026-05-03', account: '合成帳戶', summary: '轉帳支出', note: '合成鋼琴課', bankSummary: '原始支出', bankNote: '原始備註', learned: true, type: 'expense', amount: 200, category: '教育' },
    { date: '2026-05-04', account: '合成帳戶', summary: '合成無整理摘要', learned: false, type: 'expense', amount: 50, category: '（不分類）' },
  ]));
  assert.match(html, />已學<\/span> 原始支出/u, '★已學標籤保留，但後面接帳單原始摘要');
  assert.match(html, />原始備註<\/span>/u);
  assert.doesNotMatch(html, />合成鋼琴課<\/span>/u, '★自訂／整理後名稱不可蓋掉帳單原文');
  assert.match(html, /合成無整理摘要/u, '★note 缺席的列退回 summary——留白比顯示原文更糟');
});

test('收支明細標題不再開「摘要＋備註」說明窗', () => {
  const s = src();
  assert.doesNotMatch(s, /id="noteNamingInfo"|function openNoteNamingInfo\(/u);
  assert.doesNotMatch(s, /「摘要＋備註」是什麼？/u);
});

test('預覽統計只留收入、支出、內轉筆數，三種顏色各自對應', () => {
  const html = renderPreviewBody({ ...SHELL, transactions: {
    counts: { income: 9, expense: 13, transfer: 7, duplicate: 2 }, rows: [],
  } });
  const line = html.match(/<p class="bank-preview-flow-counts">([\s\S]*?)<\/p>/u)?.[1];
  assert.ok(line, '預覽統計要有獨立的三色行');
  assert.equal(line.replace(/<[^>]*>/gu, ''), '收入 9 筆・支出 13 筆・內轉 7 筆');
  assert.match(line, /class="pos">收入 <b>9<\/b> 筆<\/span>/u);
  assert.match(line, /class="neg">支出 <b>13<\/b> 筆<\/span>/u);
  assert.match(line, /class="bank-preview-transfer-count">內轉 <b>7<\/b> 筆<\/span>/u);
  assert.match(read('public/styles.css'), /\.bank-preview-transfer-count \{ color: var\(--cashflow-neutral\); \}/u);
});

test('編輯收支使用「日期」與銀行收支同款下拉箭頭', () => {
  const s = src();
  assert.match(s, /\{ key: 'date', label: '日期', type: 'date'/u);
  assert.match(s, /root\.querySelectorAll\('#modalForm select'\)/u);
  assert.match(s, /className = 'cashflow-select'/u);
  assert.match(s, /icon\('chevron-down', 14\)/u);
});

test('編輯窗的摘要與備註分隔線只套用桌機，使用現有淡色細線', () => {
  const css = read('public/styles.css');
  assert.match(css, /@media \(min-width: 901px\) \{\s*\.cashflow-text-divider \{[^}]*border-top: 1px solid var\(--line\);/u);
});

test('銀行帳單原文留底，編輯後的備註優先顯示；清空也不會復活原文', () => {
  const bank = { note: '整理後名稱', bankSummary: 'CD轉出', bankNote: '轉入帳號 1234' };
  assert.deepEqual(cashflowDescriptionLines(bank), { summary: 'CD轉出', note: '轉入帳號 1234' });
  assert.deepEqual(cashflowDescriptionLines({ ...bank, remark: '自己寫的備註' }),
    { summary: 'CD轉出', note: '自己寫的備註' });
  assert.deepEqual(cashflowDescriptionLines({ ...bank, remark: '' }),
    { summary: 'CD轉出', note: '' });
  assert.deepEqual(cashflowDescriptionLines({ note: '手動記帳說明' }),
    { summary: '手動記帳說明', note: '' });
});

test('銀行收支的摘要與備註各自可編輯，手動記帳分別顯示兩行', () => {
  const bank = { note: '舊收支說明', bankSummary: 'CD轉出', bankNote: '轉入帳號 1234' };
  assert.deepEqual(cashflowDescriptionLines({ ...bank, summary: '現金轉出', remark: '付房租' }),
    { summary: '現金轉出', note: '付房租' });
  assert.deepEqual(cashflowDescriptionLines({ summary: '房租', remark: '十月租金' }),
    { summary: '房租', note: '十月租金' });
  assert.deepEqual(cashflowDescriptionLines({ note: '舊手動說明', remark: '補充備註' }),
    { summary: '舊手動說明', note: '補充備註' }, '舊資料保留相容讀取');
});
