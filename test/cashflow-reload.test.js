// 真 DOM＋合成 fetch：驗證儲存、重讀與切頁的結果；不讀本機資料、不連外。
// 每題重種資料並明確選年月、金流與排序；共享 import 僅為載入 app 的循環模組圖。
// node --test 的檔案行程隔離承擔全域 DOM 清理；本檔不驗瀏覽器的版面尺寸。
/* global document, window */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let app, renderCashflow;
let rows = [];
let calls = [];
let readQueue = [];
let failReads = false;
let holdWrite = null;
let serial = 0;
let windowErrors = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const readError = () => json({ error: '合成錯誤 <img src=x onerror=alert(1)>' }, 503);
const settle = async () => { for (let n = 0; n < 4; n++) await new Promise(r => setTimeout(r, 0)); };
const el = selector => document.querySelector(selector);
const text = selector => el(selector)?.textContent ?? '';
const reads = () => calls.filter(x => x.method === 'GET' && x.path === '/api/transactions').length;
const writes = () => calls.filter(x => x.method !== 'GET');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function select(id, value) {
  document.getElementById(id).value = value;
  document.getElementById(id).dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}
async function click(selector) { assert.ok(el(selector), selector); el(selector).click(); await settle(); }
async function navigate(hash) { window.history.replaceState(null, '', hash); await app.router(); await settle(); }
function fixture() {
  return [
    ['a', '2025-03-04', 'expense', 21000], ['b', '2025-03-11', 'expense', 1000],
    ['c', '2025-03-16', 'income', 70000], ['d', '2025-12-01', 'income', 3000],
    ['e', '2026-08-02', 'expense', 4000],
  ].map(([id, date, type, amount]) => ({ id: `${serial}-${id}`, date, type, amount, ledger: 'cashflow', account: '合成帳戶', category: type === 'income' ? '工作' : '居住', subcategory: type === 'income' ? '薪資' : '房租', summary: '本題合成 ' + id, remark: '' }));
}
async function boot() {
  if (app) return;
  const win = new JSDOM('<!doctype html><nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', { url: 'http://localhost/#cashflow' }).window;
  for (const key of ['document', 'window', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
  win.addEventListener('error', event => { windowErrors.push(event.error?.message || event.message); event.preventDefault(); });
  globalThis.fetch = async (url, init) => {
    const path = String(url).split('?')[0], method = init?.method || 'GET';
    calls.push({ path, method });
    if (path.startsWith('/api/transactions') && method !== 'GET') {
      const body = JSON.parse(init.body);
      let stored;
      if (method === 'PUT') { stored = { ...rows.find(x => x.id === path.split('/').at(-1)), ...body }; rows = rows.map(x => x.id === stored.id ? stored : x); }
      else { stored = { id: `${serial}-new`, ledger: 'cashflow', ...body }; rows.push(stored); }
      if (holdWrite) await holdWrite.promise;
      return json(stored);
    }
    if (path === '/api/transactions') {
      const snapshot = structuredClone(rows), action = readQueue.shift();
      if (action) return action(snapshot);
      return failReads ? readError() : json(snapshot);
    }
    const data = { '/api/cards': [], '/api/accounts': [], '/api/categories': { 居住: ['房租'] }, '/api/income-categories': { 工作: ['薪資'] }, '/api/transfer-subcategories': [] };
    return json(data[path] ?? {});
  };
  app = await import('../public/app.js');
  await app.bootSettled;
  ({ renderCashflow } = await import('../public/modules/cashflow.js'));
  await settle();
}
beforeEach(async () => {
  windowErrors = [];
  serial++; rows = fixture(); calls = []; readQueue = []; failReads = false; holdWrite = null;
  await boot();
  document.getElementById('modal-root').replaceChildren();
  await navigate('#cards'); await navigate('#cashflow');
  await select('yearSelDesktop', '2025'); await select('monthSelDesktop', '03');
  await click('.cashflow-stat-action[data-flow="expense"]');
  if (el('.sort-tri.active').parentElement.dataset.sort !== 'amount') await click('[data-sort="amount"]');
  if (text('.sort-tri.active') !== '▲') await click('[data-sort="amount"]');
  document.getElementById('toast-root').replaceChildren(); calls = [];
});
afterEach(() => assert.deepEqual(windowErrors, [], '頁面事件處理不得留下未捕捉錯誤'));
function snapshot() {
  return { period: ['yearSelDesktop', 'monthSelDesktop', 'yearSel', 'monthSel'].map(id => document.getElementById(id).value), amounts: [...document.querySelectorAll('.cashflow-stat .stat')].map(x => x.textContent), ids: [...document.querySelectorAll('tbody [data-edit]')].map(x => x.dataset.edit), pressed: [...document.querySelectorAll('[data-flow][aria-pressed="true"]')].map(x => x.dataset.flow), sort: el('.sort-tri.active').parentElement.dataset.sort, direction: text('.sort-tri.active') };
}
async function submit(method) {
  if (method === 'PUT') await click(`tbody [data-edit="${serial}-a"]`);
  else { await click('#addCf'); document.getElementById('f_date').value = '2025-03-18'; document.getElementById('f_summary').value = '本題新增'; }
  document.getElementById('f_amount').value = '35000';
  el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}
for (const method of ['PUT', 'POST']) test(`儲存 ${method} 後讀取失敗：持續提示，重試不重送寫入，成功才清除`, async () => {
  const before = snapshot(); failReads = true;
  await submit(method);
  assert.equal(writes().length, 1); assert.equal(writes()[0].method, method);
  const stored = rows.find(x => x.id === `${serial}-${method === 'PUT' ? 'a' : 'new'}`);
  assert.equal(stored.amount, 35000, '先證明本題確實寫入新值');
  assert.equal(el('#modal-root form'), null);
  assert.equal(reads(), 1); assert.deepEqual(snapshot(), before);
  document.getElementById('toast-root').replaceChildren();
  assert.match(text('#cashflowReadError'), /資料已儲存，畫面尚未更新/);
  assert.match(text('#cashflowReadError'), /合成錯誤 <img/);
  assert.equal(el('#cashflowReadError img'), null);
  const readStart = calls.length;
  await click('#retryCashflowRead');
  assert.equal(reads(), 2); assert.equal(writes().length, 1);
  assert.match(text('#cashflowReadError'), /資料已儲存，畫面尚未更新/);
  assert.equal(el('#retryCashflowRead').disabled, false);
  failReads = false;
  await click('#retryCashflowRead');
  assert.equal(reads(), 3); assert.equal(writes().length, 1);
  assert.ok(calls.slice(readStart).every(x => x.method === 'GET'));
  assert.equal(el('#cashflowReadError'), null);
  if (method === 'POST') { await click('.cashflow-stat-action[data-flow="income"]'); assert.ok(snapshot().ids.includes(`${serial}-new`)); }
  assert.match(el(`tbody [data-edit="${stored.id}"]`).closest('tr').textContent, /35,000/);
  failReads = true; await renderCashflow();
  assert.doesNotMatch(text('#cashflowReadError'), /資料已儲存/, '成功重讀後的一般失敗不再沿用舊寫入警示');
});

for (const beforeConfirmation of [false, true]) test(`舊快照表單在寫入確認${beforeConfirmation ? '前' : '後'}開啟：重讀後仍須重新開啟才能送出`, async () => {
  failReads = true;
  const pending = beforeConfirmation ? deferred() : null;
  holdWrite = pending;
  await submit('PUT');
  if (pending) await click('#modal-root [data-cancel]');
  await click(`tbody [data-edit="${serial}-a"]`);
  assert.equal(document.getElementById('f_amount').value, '21000');
  document.getElementById('f_summary').value = '本題只改摘要';
  if (pending) { pending.resolve(); await settle(); }
  holdWrite = null;
  assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
  assert.equal(writes().length, 1);
  assert.match(text('#cashflowReadError'), /資料已儲存/);
  const staleForm = el('#modal-root form');
  staleForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(writes().length, 1, '舊值不能再次送出到櫃檯');
  assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
  assert.equal(el('#modal-root form'), staleForm);
  assert.match(text('#toast-root'), /資料已更新.*重新讀取後再編輯/);
  failReads = false;
  await renderCashflow();
  assert.equal(el('#cashflowReadError'), null);
  staleForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(writes().length, 1, '列表重讀不能把舊表單變成新資料');
  assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
  await click('#modal-root [data-cancel]');
  await click(`tbody [data-edit="${serial}-a"]`);
  assert.equal(document.getElementById('f_amount').value, '35000');
  document.getElementById('f_summary').value = '本題重開後的摘要';
  el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(writes().length, 2);
  assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
  assert.equal(rows.find(x => x.id === `${serial}-a`).summary, '本題重開後的摘要');
});

test('舊快照在新增確認後仍不得再送出編輯', async () => {
  failReads = true;
  await submit('POST');
  assert.equal(rows.find(x => x.id === `${serial}-new`).amount, 35000);
  assert.equal(writes().length, 1);
  await click(`tbody [data-edit="${serial}-a"]`);
  document.getElementById('f_summary').value = '本題新增之後的舊表單';
  el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(writes().length, 1);
  assert.equal(rows.find(x => x.id === `${serial}-new`).amount, 35000);
  assert.notEqual(rows.find(x => x.id === `${serial}-a`).summary, '本題新增之後的舊表單');
});

test('非預設年月、金流、排序：每個失敗操作均回復成功畫面與內部狀態', async () => {
  assert.deepEqual(snapshot().period, ['2025', '03', '2025', '03']);
  assert.deepEqual(snapshot().ids, [`${serial}-b`, `${serial}-a`]);
  assert.equal(snapshot().sort, 'amount'); assert.equal(snapshot().direction, '▲');
  for (const act of [() => select('yearSelDesktop', '2026'), () => select('monthSelDesktop', '12'), () => click('.cashflow-stat-action[data-flow="income"]'), () => click('[data-sort="date"]'), () => click('[data-sort="amount"]')]) {
    const before = snapshot(), count = reads(); failReads = true;
    await act(); assert.equal(reads(), count + 1); assert.deepEqual(snapshot(), before);
    document.getElementById('toast-root').replaceChildren(); assert.match(text('#cashflowReadError'), /載入失敗/);
    assert.doesNotMatch(text('#cashflowReadError'), /資料已儲存/);
    failReads = false; await click('#retryCashflowRead');
    assert.deepEqual(snapshot(), before, '重讀成功仍採用回復後的條件'); assert.equal(el('#cashflowReadError'), null);
  }
  assert.equal(writes().length, 0);
});

for (const oldFails of [false, true]) test(`舊${oldFails ? '失敗' : '成功'}晚回：不能覆蓋較新的${oldFails ? '成功' : '失敗'}與提示`, async () => {
  const wait = deferred();
  readQueue.push(async data => { await wait.promise; return oldFails ? readError() : json(data); });
  const older = renderCashflow();
  assert.equal(reads(), 1);
  rows.find(x => x.id === `${serial}-a`).amount = 47000;
  failReads = !oldFails;
  await renderCashflow();
  const current = document.getElementById('view').innerHTML;
  const expectedToast = text('#toast-root');
  try { wait.resolve(); await older; assert.equal(document.getElementById('view').innerHTML, current); assert.equal(text('#toast-root'), expectedToast); }
  finally { wait.resolve(); await older; }
  assert.equal(reads(), 2);
  if (oldFails) assert.equal(el('#cashflowReadError'), null);
  else assert.match(text('#cashflowReadError'), /載入失敗/);
});

for (const method of ['PUT', 'POST']) for (const comeBack of [false, true]) test(`${method} 等待期間切頁${comeBack ? '再返回' : ''}：已完成的舊寫入不重畫、不讀取、不提示`, async () => {
  const wait = deferred(); holdWrite = wait;
  await submit(method); assert.equal(writes().length, 1);
  assert.equal(rows.find(x => x.id === `${serial}-${method === 'PUT' ? 'a' : 'new'}`).amount, 35000);
  await navigate('#cards'); if (comeBack) await navigate('#cashflow');
  document.getElementById('toast-root').replaceChildren();
  const before = document.getElementById('view').innerHTML, count = reads();
  try { wait.resolve(); await settle(); assert.equal(document.getElementById('view').innerHTML, before); assert.equal(reads(), count); assert.equal(text('#toast-root'), ''); }
  finally { wait.resolve(); holdWrite = null; await settle(); }
});

test('重試等待期間離開再返回：舊按鈕與舊讀取不得清除新頁錯誤', async () => {
  failReads = true; await renderCashflow();
  const oldButton = el('#retryCashflowRead');
  const wait = deferred(); readQueue.push(async data => { await wait.promise; return json(data); });
  oldButton.click(); await settle(); assert.equal(reads(), 2);
  await navigate('#cards'); failReads = false; await navigate('#cashflow');
  failReads = true; await renderCashflow();
  const before = document.getElementById('view').innerHTML, count = reads();
  try { wait.resolve(); await settle(); oldButton.click(); await settle(); assert.equal(document.getElementById('view').innerHTML, before); assert.equal(reads(), count); assert.match(text('#cashflowReadError'), /載入失敗/); }
  finally { wait.resolve(); await settle(); }
});


test('離開頁面時仍可點的舊重試按鈕：不能在新頁發起重讀', async () => {
  failReads = true; await renderCashflow();
  const oldButton = el('#retryCashflowRead'); assert.equal(oldButton.disabled, false);
  await navigate('#cards');
  const before = document.getElementById('view').innerHTML, count = reads();
  oldButton.click(); await settle();
  assert.equal(reads(), count); assert.equal(document.getElementById('view').innerHTML, before);
});


test('讀取成功前已切到別頁：較晚完成的讀取不得改動新頁', async () => {
  const wait = deferred(); readQueue.push(async data => { await wait.promise; return json(data); });
  const pending = renderCashflow(); assert.equal(reads(), 1);
  await navigate('#cards');
  const before = document.getElementById('view').innerHTML;
  try { wait.resolve(); await pending; assert.equal(document.getElementById('view').innerHTML, before); }
  finally { wait.resolve(); await pending; }
});
