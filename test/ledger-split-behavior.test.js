// 兩頁「錢的分堆」＝頁面接線的行為考題：銀行收支頁（cashflow.js）只能吃現金流帳本、信用卡費頁（transactions.js）只能吃信用卡帳本
// （判準單一真相＝categories.js isCardTx；分堆的語意見 AGENTS「兩本帳」節）。分堆一掉，銀行收支會把刷卡明細算進支出、
// 下期繳卡費再算一次（同一筆錢計兩遍）；信用卡頁會把房租、薪資、繳卡費列進「本月消費」——這裡釘的是畫面上的數字，不是原始碼字串。
//
// 做法＝jsdom 給全域、fetch 假櫃檯餵固定資料、真的 import 整張 app.js 路由圖（開機序列跑完）→ 呼叫 render → 讀畫面。
// 釘的是結果層（兩頁畫面上的分堆結果）：等價的頁面實作也會過；判準呼叫的形狀由兩頁的字面釘題守、判準本身另有考題（categories）。
// 誠實劃界：期望值是畫面字串（wan／money 的格式），格式改版這裡要跟著改；jsdom 全域定在 globalThis、沒有清理，
// 靠 node --test 每檔一個行程隔離，本檔不可與別的考題合檔。
/* global document */   // boot() 把 jsdom 的 document 定到 globalThis（node --test 每檔一個行程）
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { isCardTx } from '../public/modules/categories.js';

const MONTH = '2026-08';
/** 固定資料：每一筆的 note 寫它是哪一種列；哪些筆算哪本帳由下面的夾具對照題斷言，這裡不另列清單（會漂） */
const FIXTURE = [
  { id: 'c1', date: '2026-08-03', ledger: 'card', source: 'stmt', type: 'expense', category: '飲食', subcategory: '超市', amount: 1200, account: '台新卡', note: '全聯', stmtRef: 'card1|2026-08-03|1200|全聯' },
  { id: 'c2', date: '2026-08-10', ledger: 'card', source: 'stmt', type: 'expense', category: '交通', subcategory: '加油', amount: 2000, account: '台新卡', note: '加油站', stmtRef: 'card1|2026-08-10|2000|加油站' },
  { id: 'c3', date: '2026-08-15', ledger: 'card', source: 'stmt', type: 'expense', category: '購物', subcategory: '', amount: 3000, account: '台新卡', note: 'PChome', stmtRef: 'card1|2026-08-15|3000|PChome' },
  { id: 'c5', date: '2026-08-21', ledger: 'card', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 500, account: '現金', note: '手動記的刷卡（明確 card、無來源、帳戶不是卡）' },
  { id: 'c4', date: '2026-08-20', source: 'stmt', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 800, account: '台新卡', note: '舊卡消費', stmtRef: 'card1|2026-08-20|800|舊卡消費' },
  { id: 'b1', date: '2026-08-05', ledger: 'cashflow', source: 'bank', type: 'income', category: '工作', subcategory: '薪資', amount: 60000, account: '台新活存', note: 'Z-old-name', bankSummary: 'B-summary', bankNote: 'B-note' },
  { id: 'b2', date: '2026-08-06', ledger: 'cashflow', source: 'bank', type: 'expense', category: '居住', subcategory: '房租', amount: 15000, account: '台新活存', note: 'A-old-name', bankSummary: 'C-summary', bankNote: 'C-note' },
  { id: 'b3', date: '2026-08-12', ledger: 'cashflow', source: 'bank', type: 'expense', category: '', subcategory: '', amount: 6900, account: '台新活存', note: 'C-old-name', bankSummary: 'A-summary', bankNote: 'A-note' },   // 刻意不等於本月消費 7,500
  { id: 'b4', date: '2026-08-18', ledger: 'cashflow', source: 'bank', type: 'transfer', category: '內轉', subcategory: '內轉出', amount: 20000, account: '台新活存', note: 'D-manual' },
  { id: 'b5', date: '2026-08-22', ledger: 'cashflow', source: 'stmt', type: 'expense', category: '飲食', subcategory: '超市', amount: 4300, account: '台新卡', note: 'E-manual' },
  { id: 'm1', date: '2026-08-25', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 1000, account: '現金', note: 'F-manual' },
  { id: 'y1', date: '2025-12-04', ledger: 'cashflow', source: 'bank', type: 'income', category: '工作', subcategory: '薪資', amount: 100, account: '台新活存', note: '去年收入', bankSummary: '去年摘要', bankNote: '去年備註' },
];
const CARD_IDS = ['c1', 'c2', 'c3', 'c4', 'c5'];
const CASH_IDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'm1', 'y1'];
const CASH_MONTH_IDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'm1'];
const CARD_SPEND = 1200 + 2000 + 3000 + 800 + 500;    // 7,500
const BANK_EXPENSE = 15000 + 6900 + 4300 + 1000;       // 27,200（房租＋繳卡費＋b5＋手動聚餐）
const BANK_INCOME = 60000;
// 金額刻意挑成：任何一筆刷卡（最小 500）混進銀行支出、或任何一筆現金流「支出」漏掉，萬元一位小數的字串都會變；
// 內轉本來就不進收支加總，它的去留由明細 id 釘。本月消費 7,500 不等於繳卡費 6,900——摘要數字單獨也有鑑別力。

const API = {
  '/api/transactions': FIXTURE,
  '/api/accounts': [], '/api/cards': [],
  '/api/categories': { 飲食: ['超市', '餐廳'], 交通: ['加油'], 購物: [], 居住: ['房租'] },
  '/api/income-categories': { 工作: ['薪資'] },
  '/api/transfer-subcategories': [],
  '/api/refund-pairs': { pairs: [], unmatchedRefunds: [], rewards: [] },
};

let app;
async function boot() {
  if (app) return app;
  const dom = new JSDOM('<!doctype html><html><body><nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div></body></html>', { url: 'http://localhost/#cashflow' });
  const win = dom.window;
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  for (const k of ['document', 'window', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) set(k, win[k]);
  set('fetch', async (url) => {
    const path = String(url).split('?')[0];
    const body = Object.hasOwn(API, path) ? API[path] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  app = await import('../public/app.js');
  await app.bootSettled;
  await new Promise(r => setTimeout(r, 0));
  return app;
}
const text = (sel) => document.querySelector(sel)?.textContent ?? null;
const rowIds = () => [...document.querySelectorAll('tbody [data-edit]')].map(el => el.dataset.edit).sort();
const rowIdsInOrder = () => [...document.querySelectorAll('tbody [data-edit]')].map(el => el.dataset.edit);
const settleRender = async () => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };

test('夾具對照（只餵判準、不碰頁面）：固定資料兩本帳都有、兩半判準都踩到、而「用來源／帳戶名分」這種等價分法會分錯', () => {
  assert.deepEqual(FIXTURE.filter(isCardTx).map(t => t.id).sort(), CARD_IDS);
  assert.deepEqual(FIXTURE.filter(t => !isCardTx(t)).map(t => t.id).sort(), CASH_IDS);
  assert.equal(FIXTURE.find(t => t.id === 'c4').ledger, undefined, 'c4＝缺 ledger 的舊卡匯入，靠 source:stmt 判成 card');
  assert.equal(FIXTURE.find(t => t.id === 'm1').source, undefined, 'm1＝缺 ledger 缺 source 的舊手動列，排除法歸 cashflow');
  const c5 = FIXTURE.find(t => t.id === 'c5'), b5 = FIXTURE.find(t => t.id === 'b5');
  assert.ok(c5.ledger === 'card' && c5.source === undefined && c5.account !== '台新卡', 'c5＝明確 card 但無來源、帳戶不是卡');
  assert.ok(b5.ledger === 'cashflow' && b5.source === 'stmt' && b5.account === '台新卡', 'b5＝明確 cashflow 但來源是帳單、帳戶是卡');
  // 等價分法（頁面若偷換成這些，分堆看起來也「合理」）在這份夾具下會分錯——所以它們過不了後面兩題
  assert.notDeepEqual(FIXTURE.filter(t => t.source === 'stmt').map(t => t.id).sort(), CARD_IDS, '「來源是帳單匯入」不是官方判準');
  assert.notDeepEqual(FIXTURE.filter(t => t.account === '台新卡').map(t => t.id).sort(), CARD_IDS, '「帳戶名是卡」不是官方判準');
  assert.ok(FIXTURE.filter(t => t.id !== 'y1').every(t => t.date.startsWith(MONTH)));
  assert.equal(FIXTURE.find(t => t.id === 'y1').date, '2025-12-04', '跨年份夾具供年份切換行為題使用');
});

test('銀行收支頁：支出只算現金流帳本（房租＋繳卡費＋手動），刷卡明細一筆都不進來', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  await renderCashflow();
  assert.equal(document.querySelector('#yearSel').value, MONTH.slice(0, 4));
  assert.equal(document.querySelector('#monthSel').value, MONTH.slice(5, 7));
  assert.equal(text('[data-kind="expense"] .stat'), '2.7 萬', `支出＝wan(${BANK_EXPENSE})：房租＋繳卡費＋b5＋手動聚餐；任何一筆刷卡混進來就不是 2.7`);
  assert.equal(text('[data-kind="income"] .stat'), '6.0 萬', `收入＝wan(${BANK_INCOME})`);
  assert.equal(text('[data-kind="net"] .stat'), '+3.3 萬', `結餘＝+wan(${BANK_INCOME - BANK_EXPENSE})`);
  assert.deepEqual(rowIds(), CASH_MONTH_IDS, '明細＝所選月份六筆現金流；繳卡費 b3 留在這頁、去年 y1 不混進來');
  assert.match(text('.cashflow-ledger-title [aria-live]'), /^6 筆$/);
  assert.ok(document.querySelector('.cashflow-summary').nextElementSibling?.classList.contains('cashflow-controls'), '摘要 DOM 要直接排在篩選前面');

  const b3 = document.querySelector('[data-edit="b3"]')?.closest('tr');
  assert.equal(b3?.querySelector('td')?.textContent, '8/12', '日期格真的接上月／日格式器');
  assert.equal(b3?.querySelector('.cf-note-summary')?.textContent, 'A-summary');
  assert.equal(b3?.querySelector('.cf-note-remark')?.textContent, 'A-note');

  document.querySelector('th[data-sort="note"]')?.click();
  await settleRender();
  assert.deepEqual(rowIdsInOrder(), ['b3', 'b1', 'b2', 'b4', 'b5', 'm1'], '收支說明升冪要依畫面第一行，不依隱藏的 note');

  const year = document.querySelector('#yearSel');
  year.value = '2025';
  year.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  await settleRender();
  assert.equal(document.querySelector('#yearSel').value, '2025');
  assert.equal(document.querySelector('#monthSel').value, '12', '所選年份沒有原月份時，退到該年最新月份');
  assert.equal(text('.cashflow-summary-head strong'), '2025 年 12 月');
  assert.deepEqual(rowIds(), ['y1']);
});

test('信用卡費頁：本月消費只算信用卡帳本（含缺 ledger 的舊卡匯入），薪資／房租／繳卡費／內轉都不進來', async () => {
  await boot();
  const { renderTransactions } = await import('../public/modules/transactions.js');
  await renderTransactions();
  assert.equal(document.querySelector('#monthSel').value, MONTH);
  assert.equal(text('[data-kind="spend"] .stat'), '7,500 元', `本月消費＝money(${CARD_SPEND})：五筆刷卡（含無來源的 c5）；不等於繳卡費 6,900`);
  assert.equal(text('[data-kind="count"] .stat'), String(CARD_IDS.length));
  assert.deepEqual(rowIds(), CARD_IDS, '明細＝五筆刷卡；繳卡費 b3 與來源是帳單的 b5 都不在這頁（否則同一筆錢兩頁各算一次）');
  const cats = [...document.querySelectorAll('.credit-category-label')].map(el => el.textContent.replace(/\s+/g, ''));
  assert.deepEqual(cats, ['購物3,000元', '飲食2,500元', '交通2,000元']);
});
