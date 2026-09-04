// 兩頁「錢的分堆」釘行為，不釘字面（第二輪稽核第 9 條，2026-09-02；批四 4A）：
// 銀行收支頁（cashflow.js）只能吃現金流帳本、信用卡費頁（transactions.js）只能吃信用卡帳本——
// 這正是 2026-07-20 三層重構（信用卡明細／收支現金流／帳戶餘額分家）要消滅的病：
// 過濾一掉，銀行收支頁會把每一筆刷卡算進支出、下期繳卡費再算一次（同一筆錢計兩遍）；信用卡頁會把房租、薪資、繳卡費列進「本月消費」。
// 稽核實測：原本守它的考題只有**字面釘**（assert.match 原始碼 `allRaw.filter(...)`）——把那行註解掉、旁邊補一行不過濾的，
// 或保留字面再旁路（`…filter(…) && allRaw`），13 支相關考卷 214 題全綠。字面釘分不出「字還在」和「碼還活著」。
//
// 做法＝jsdom 給全域、fetch 假櫃檯餵固定資料、真的 import 整張 app.js 路由圖（開機序列跑完）→ 呼叫 render → 讀畫面上的數字。
// 這樣釘得到的是「頁面真的有呼叫判準」，不是判準本身（判準 isCardTx 另有考題）。
// 逐點突變過（每一刀本檔至少一題紅）：兩頁各 ①整行刪除 ②註解掉＋補 `const all = allRaw` ③保留字面旁路 `&& allRaw` ④反轉判準；
// ⑤ categories.js 的 isCardTx 改成永遠 false。
// 誠實劃界：期望值用畫面上的字串（`wan`／`money` 的格式），格式改版這裡要跟著改；jsdom 全域定在 globalThis 沒有清理，
// 靠 node --test 每檔一個行程隔離，本檔不可與別的考題合檔。⚠️ test/debit-card-ledger.test.js 舊題名寫「transactions.js 載不進 node」——不成立，本檔就是反例。
/* global document */   // boot() 把 jsdom 的 document 定到 globalThis（node --test 每檔一個行程）
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { isCardTx } from '../public/modules/categories.js';

const MONTH = '2026-08';
/** 固定資料：刷卡明細×3、舊卡匯入（缺 ledger）×1、薪資、房租、繳卡費、內轉、舊手動記帳（缺 ledger 缺 source）×1 */
const FIXTURE = [
  { id: 'c1', date: '2026-08-03', ledger: 'card', source: 'stmt', type: 'expense', category: '飲食', subcategory: '超市', amount: 1200, account: '台新卡', note: '全聯', stmtRef: 'card1|2026-08-03|1200|全聯' },
  { id: 'c2', date: '2026-08-10', ledger: 'card', source: 'stmt', type: 'expense', category: '交通', subcategory: '加油', amount: 2000, account: '台新卡', note: '加油站', stmtRef: 'card1|2026-08-10|2000|加油站' },
  { id: 'c3', date: '2026-08-15', ledger: 'card', source: 'stmt', type: 'expense', category: '購物', subcategory: '', amount: 3000, account: '台新卡', note: 'PChome', stmtRef: 'card1|2026-08-15|3000|PChome' },
  { id: 'c4', date: '2026-08-20', source: 'stmt', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 800, account: '台新卡', note: '舊卡消費', stmtRef: 'card1|2026-08-20|800|舊卡消費' },
  { id: 'b1', date: '2026-08-05', ledger: 'cashflow', source: 'bank', type: 'income', category: '工作', subcategory: '薪資', amount: 60000, account: '台新活存', note: '薪資轉入' },
  { id: 'b2', date: '2026-08-06', ledger: 'cashflow', source: 'bank', type: 'expense', category: '居住', subcategory: '房租', amount: 15000, account: '台新活存', note: '房租' },
  { id: 'b3', date: '2026-08-12', ledger: 'cashflow', source: 'bank', type: 'expense', category: '', subcategory: '', amount: 7000, account: '台新活存', note: '信用卡款' },
  { id: 'b4', date: '2026-08-18', ledger: 'cashflow', source: 'bank', type: 'transfer', category: '內轉', subcategory: '內轉出', amount: 20000, account: '台新活存', note: '轉帳 *1234' },
  { id: 'm1', date: '2026-08-25', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 1000, account: '現金', note: '聚餐' },
];
const CARD_IDS = ['c1', 'c2', 'c3', 'c4'];
const CASH_IDS = ['b1', 'b2', 'b3', 'b4', 'm1'];
const CARD_SPEND = 1200 + 2000 + 3000 + 800;          // 7,000
const BANK_EXPENSE = 15000 + 7000 + 1000;              // 23,000（房租＋繳卡費＋手動聚餐）
const BANK_INCOME = 60000;

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

test('夾具對照：固定資料真的兩本帳都有、且兩半判準都踩到', () => {
  assert.deepEqual(FIXTURE.filter(isCardTx).map(t => t.id), CARD_IDS);
  assert.deepEqual(FIXTURE.filter(t => !isCardTx(t)).map(t => t.id), CASH_IDS);
  assert.equal(FIXTURE.find(t => t.id === 'c4').ledger, undefined, 'c4＝缺 ledger 的舊卡匯入，靠 source:stmt 判成 card');
  assert.equal(FIXTURE.find(t => t.id === 'm1').source, undefined, 'm1＝缺 ledger 缺 source 的舊手動列，排除法歸 cashflow');
  assert.ok(FIXTURE.every(t => t.date.startsWith(MONTH)));
});

test('銀行收支頁：支出只算現金流帳本（房租＋繳卡費＋手動），刷卡明細一筆都不進來', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  await renderCashflow();
  assert.equal(document.querySelector('#monthSel').value, MONTH);
  assert.equal(text('[data-kind="expense"] .stat'), '2.3 萬', `支出＝wan(${BANK_EXPENSE})：房租＋繳卡費＋手動聚餐；刷卡明細混進來會變 3.0 萬`);
  assert.equal(text('[data-kind="income"] .stat'), '6.0 萬', `收入＝wan(${BANK_INCOME})`);
  assert.equal(text('[data-kind="net"] .stat'), '+3.7 萬', `結餘＝+wan(${BANK_INCOME - BANK_EXPENSE})`);
  assert.deepEqual(rowIds(), CASH_IDS, '明細＝五筆現金流；繳卡費 b3 留在這頁（它才是刷卡的現金流出）');
  assert.match(text('.cashflow-ledger-title [aria-live]'), /^5 筆$/);
});

test('信用卡費頁：本月消費只算信用卡帳本（含缺 ledger 的舊卡匯入），薪資／房租／繳卡費／內轉都不進來', async () => {
  await boot();
  const { renderTransactions } = await import('../public/modules/transactions.js');
  await renderTransactions();
  assert.equal(document.querySelector('#monthSel').value, MONTH);
  assert.equal(text('[data-kind="spend"] .stat'), '7,000 元', `本月消費＝money(${CARD_SPEND})：四筆刷卡；現金流混進來會變 110,000 元`);
  assert.equal(text('[data-kind="count"] .stat'), String(CARD_IDS.length));
  assert.deepEqual(rowIds(), CARD_IDS, '明細＝四筆刷卡；繳卡費 b3 不在這頁（否則同一筆錢兩頁各算一次）');
  const cats = [...document.querySelectorAll('.credit-category-label')].map(el => el.textContent.replace(/\s+/g, ''));
  assert.deepEqual(cats, ['購物3,000元', '飲食2,000元', '交通2,000元']);
});
