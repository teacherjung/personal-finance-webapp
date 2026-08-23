// 名詞統一（William 2026-08-14 拍板；r1/r2 兩輪事實修正後定案）：
//
// ⚠️ **r1 證偽了「摘要・備註」**：預覽欄內容不是帳單照抄——服務層會翻譯摘要
// （「CD轉出」→「現金轉出」）、刪通路詞、整理備註。
// ⚠️ **r2 證偽了我第一版的「同一份內容」**：預覽樣板對未學列讀的是生的 `x.summary`、
// 匯入後保存的卻是整理後 `note`＝同名欄位、內容不同。修正＝樣板改讀 `x.note`
// （服務層的 displayNote 與匯入保存的 noteText 是**同一條產生式**），預覽所見＝匯入所得。
//
// 定案＝預覽表與收支頁**統一叫「收支說明」**；帳單用語（摘要／備註）與 app 說明的關係
// 由 ⓘ 講清楚，並明講「核對請用日期＋金額」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankPreviewFootnote, bankBlockedWarningHtml, bankSimilarWarningHtml, bankSimilarTagHtml, bankCardLedgerNote } from '../public/modules/cashflow-model.js';
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
    `${chunk}\n return body;`)(
    r, esc, String, { update: '更新餘額' }, () => '<div data-stub="gate"></div>',
    bankBlockedWarningHtml, bankSimilarWarningHtml, bankSimilarTagHtml,
    bankPreviewFootnote, aiPreviewBadgeHtml, () => '', bankCardLedgerNote);
}

/** 外殼合成資料（rows 由各題自帶）。全部假值、零真實帳單內容。 */
const SHELL = Object.freeze({
  bank: '合成銀行', referenceDate: '2026-05-31', reconcile: { level: 'strong', ok: true }, rows: [],
});
const wrap = (/** @type {any[]} */ rows) =>
  ({ ...SHELL, transactions: { counts: { expense: rows.length }, rows } });

test('統一欄名｜預覽表與收支頁同叫「收支說明」', () => {
  assert.match(src(), /<th>日期<\/th><th>帳戶<\/th><th>收支說明<\/th><th>金流・分類<\/th>/u,
    '★預覽表欄名＝「收支說明」（與收支頁同名＝真正的統一）');
  assert.match(src(), /th\('note', '收支說明'\)/u, '★收支頁欄名不變');
  assert.doesNotMatch(src(), /摘要・備註/u,
    '★「摘要・備註」不可出現——那個名字宣稱內容是帳單照抄，r1 已證偽');
});

test('跨層｜預覽顯示的＝匯入後會保存的那份文字（走真的 previewBankTxForDb，不手塞想像值）', () => {
  // r2 教訓：手工把「整理後文字」塞進 summary 是在驗自己的想像——跨層差異就是這樣漏掉的。
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
  const html = renderPreviewBody(wrap([row]));
  assert.ok(html.includes(String(row.note).replaceAll('&', '&amp;')) || html.includes(String(row.note)),
    '★預覽格顯示的必須是整理後說明（row.note）');
  assert.doesNotMatch(html, />CD轉出</u,
    '★預覽格不可顯示生的摘要——預覽給人看「CD轉出」、匯入後帳本卻寫「現金轉出…」＝預覽在騙人');
  // ⚠️ r4：題名說「＝匯入後保存」就要**真的呼叫寫入端**——只走預覽是在宣稱沒驗過的等式
  //    （竄改 importBankTxToDb 的保存值，只走預覽的版本照樣綠）。
  const db2 = { transactions: [], accounts: [], settings: {} };
  importBankTxToDb(db2, {
    bank: '台新', accounts: [], accountCurrency: { '999900****0001': 'TWD' }, transactions: [raw] });
  assert.equal(db2.transactions.length, 1, '寫入端要真的落一筆');
  assert.equal(db2.transactions[0].note, row.note,
    '★匯入後保存的 note 必須逐字＝預覽顯示的那份——兩邊各自產生但同一條產生式，走散＝預覽在騙人');
});

test('行為｜已學列顯示自訂名＋「已學」標籤；沒有 note 的列退回 summary（fail-open 顯示）', () => {
  const html = renderPreviewBody(wrap([
    { date: '2026-05-03', account: '合成帳戶', summary: '轉帳支出', note: '合成鋼琴課', learned: true, type: 'expense', amount: 200, category: '教育' },
    { date: '2026-05-04', account: '合成帳戶', summary: '合成無整理摘要', learned: false, type: 'expense', amount: 50, category: '（不分類）' },
  ]));
  assert.match(html, />已學<\/span> 合成鋼琴課/u, '★已學標籤要貼著自訂名（在預覽窗）');
  assert.match(html, /合成無整理摘要/u, '★note 缺席的列退回 summary——留白比顯示原文更糟');
});

test('就地解釋｜三種出身講清楚，而且不說 r1/r2 證偽的那些話', () => {
  const s = src();
  assert.match(s, /byId\('noteNamingInfo'\)\.onclick = openNoteNamingInfo;/u, '按鈕要綁上');
  const start = s.indexOf('function openNoteNamingInfo()');
  assert.ok(start >= 0);
  const body = s.slice(start, s.indexOf('\n}', start));
  assert.match(body, /整理成白話/u, '★要講「整理」——真相：翻譯銀行代碼、刪通路詞');
  assert.match(body, /「CD轉出」→「現金轉出」/u, '★給一個真實形狀的例子');
  assert.match(body, /核對請用日期＋金額/u, '★字面與帳單不同，要給可靠的核對方法');
  assert.match(body, /同名欄位＝同一份內容/u,
    '★「同一份內容」現在成立了（r2：樣板改讀 note＝與匯入保存同一條產生式）——但它是被下面'
    + '的跨層考題撐著的宣稱，不是裝飾');
  assert.match(body, /（預覽窗會標「已學」）/u,
    '★「已學」標籤只存在於預覽窗——ⓘ 要說對地方（r4：寫成「收支明細會標」＝對著沒有標籤的畫面找標籤）');
  assert.doesNotMatch(body, /收支明細會標|明細會標「已學」/u, '★不可宣稱收支明細有已學標籤（它沒有）');
  assert.match(body, /清空自訂名會回到 app 整理的預設說明/u, '★不可說「隨時可改回帳單原文」');
  assert.doesNotMatch(body, /照抄|逐字對得上|帳單原文還在/u, '★r1 證偽的三種說法禁令');
});
