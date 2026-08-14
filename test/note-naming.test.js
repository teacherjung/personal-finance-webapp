// 名詞統一（William 2026-08-14 拍板；r1 事實修正後定案）：
//
// ⚠️ **r1 修正了本支的事實前提**：預覽表那一欄的內容**不是**帳單「摘要＋備註」照抄——
// `bank-import` 會把摘要翻成白話（「CD轉出」→「現金轉出」）、刪通路詞、重排備註；
// 已學列顯示的是自訂名。所以「摘要・備註」這個欄名（以及「逐字對得上」的說法）是假的。
// **誠實的統一＝兩邊都叫「收支說明」**：預覽窗與收支頁顯示的本來就是同一份「整理後說明」。
// 帳單用語（摘要／備註）與 app 說明的關係，由 ⓘ 講清楚、並明講「核對請用日期＋金額」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankPreviewFootnote, bankBlockedWarningHtml, bankSimilarWarningHtml, bankSimilarTagHtml } from '../public/modules/cashflow-model.js';
import { aiPreviewBadgeHtml } from '../public/modules/ai-consent.js';

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
    'bankPreviewFootnote', 'aiPreviewBadgeHtml',
    `${chunk}\n return body;`)(
    r, esc, String, { update: '更新餘額' }, () => '<div data-stub="gate"></div>',
    bankBlockedWarningHtml, bankSimilarWarningHtml, bankSimilarTagHtml,
    bankPreviewFootnote, aiPreviewBadgeHtml);
}

/** 合成資料：一列未學（顯示整理後摘要）、一列已學（顯示自訂名＋已學標籤）。全部假值。 */
const RESULT = Object.freeze({
  bank: '合成銀行', referenceDate: '2026-05-31', reconcile: { level: 'strong', ok: true },
  rows: [],
  transactions: {
    counts: { income: 0, expense: 2, transfer: 0 },
    rows: [
      { date: '2026-05-02', account: '合成帳戶', summary: '現金轉出・合成通路整理後', learned: false, type: 'expense', amount: 100, category: '（不分類）' },
      { date: '2026-05-03', account: '合成帳戶', summary: '轉帳支出', note: '合成鋼琴課', learned: true, type: 'expense', amount: 200, category: '教育' },
    ],
  },
});

test('統一欄名｜預覽表與收支頁同叫「收支說明」——兩邊顯示的本來就是同一份整理後說明', () => {
  assert.match(src(), /<th>日期<\/th><th>帳戶<\/th><th>收支說明<\/th><th>金流・分類<\/th>/u,
    '★預覽表欄名＝「收支說明」（與收支頁同名＝真正的統一）');
  assert.match(src(), /th\('note', '收支說明'\)/u, '★收支頁欄名不變');
  assert.doesNotMatch(src(), /摘要・備註/u,
    '★「摘要・備註」不可出現——那個名字宣稱內容是帳單照抄，r1 已證偽（摘要會被翻譯、備註會被整理）');
});

test('行為｜未學列顯示整理後摘要、已學列顯示自訂名＋「已學」標籤（欄名的內容真相）', () => {
  const html = renderPreviewBody(RESULT);
  assert.match(html, /現金轉出・合成通路整理後/u, '★未學列＝顯示（整理後的）summary');
  assert.match(html, /合成鋼琴課/u, '★已學列＝顯示自訂 note');
  assert.match(html, />已學<\/span> 合成鋼琴課/u, '★已學標籤要貼著自訂名（在預覽窗）');
  assert.doesNotMatch(html, /(?<!合成鋼琴課)轉帳支出<\/td>/u,
    '★已學列不可顯示原 summary——顯示什麼由 learned 決定，這是欄名沒說謊的前提');
});

test('就地解釋｜三種出身講清楚，而且不說 r1 證偽的那些話', () => {
  const s = src();
  assert.match(s, /byId\('noteNamingInfo'\)\.onclick = openNoteNamingInfo;/u, '按鈕要綁上');
  const start = s.indexOf('function openNoteNamingInfo()');
  assert.ok(start >= 0);
  const body = s.slice(start, s.indexOf('\n}', start));
  assert.match(body, /整理成白話/u, '★要講「整理」——這是真相：翻譯銀行代碼、刪通路詞');
  assert.match(body, /「CD轉出」→「現金轉出」/u, '★給一個真實形狀的例子，使用者才對得上他看到的');
  assert.match(body, /核對請用日期＋金額/u,
    '★字面會與帳單不同，要給使用者可靠的核對方法——不給，他會拿字面去對、對不上以為讀錯');
  assert.match(body, /同名欄位＝同一份內容/u, '★要點名預覽窗同名同內容');
  assert.match(body, /清空自訂名會回到 app 整理的預設說明/u,
    '★不可說「隨時可以改回帳單原文」——清空回到的是整理後說明，不是逐字原文');
  assert.doesNotMatch(body, /照抄|逐字對得上|帳單原文還在/u,
    '★這三種說法 r1 已證偽（bank-import 會翻譯摘要、刪通路詞、重排備註）');
});
