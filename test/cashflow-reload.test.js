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
let failWrites = false;
let legacyText = false;
let holdWrite = null;
let holdBeforeWrite = null;
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
async function navigate(hash) { window.location.hash = hash; await settle(); }
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
      if (holdBeforeWrite) await holdBeforeWrite.promise;
      if (failWrites) return json({ error: '本題寫入失敗' }, 503);
      if (legacyText) { delete body.summary; delete body.remark; }
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
  serial++; rows = fixture(); calls = []; readQueue = []; failReads = false; failWrites = false; legacyText = false; holdWrite = null; holdBeforeWrite = null;
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

function workspaceWithoutNotice() {
  const copy = document.getElementById('view').cloneNode(true);
  copy.querySelector('#cashflowReadError')?.remove();
  return copy.innerHTML;
}

for (const method of ['PUT', 'POST']) for (const comeBack of [false, true]) test(`${method} 等待期間切頁${comeBack ? '再返回：保留列表並提供唯讀重試' : '：不得操作其他頁'}`, async () => {
  const wait = deferred(); holdBeforeWrite = wait;
  await submit(method); assert.equal(writes().length, 1);
  assert.equal(rows.find(x => x.id === `${serial}-${method === 'PUT' ? 'a' : 'new'}`)?.amount, method === 'PUT' ? 21000 : undefined);
  await navigate('#cards'); if (comeBack) await navigate('#cashflow');
  document.getElementById('toast-root').replaceChildren();
  const before = workspaceWithoutNotice(), count = reads(), modal = el('#modal-root form');
  try {
    wait.resolve(); await settle();
    assert.equal(rows.find(x => x.id === `${serial}-${method === 'PUT' ? 'a' : 'new'}`).amount, 35000);
    assert.equal(workspaceWithoutNotice(), before); assert.equal(reads(), count); assert.equal(writes().length, 1); assert.equal(text('#toast-root'), '');
    assert.equal(el('#modal-root form'), modal);
    if (comeBack) {
      assert.match(text('#cashflowReadError'), /資料已儲存，畫面尚未更新/);
      assert.equal(el('#retryCashflowRead').disabled, false);
      await click('#modal-root [data-cancel]');
      await click('#retryCashflowRead');
      assert.equal(reads(), count + 1); assert.equal(writes().length, 1); assert.equal(el('#cashflowReadError'), null);
    } else assert.equal(el('#cashflowReadError'), null);
  }
  finally { wait.resolve(); holdBeforeWrite = null; await settle(); }
});

for (const method of ['PUT', 'POST']) test(`${method} 表單開著離頁返回：失效提示保留輸入，不能送出，關閉重讀重開可用`, async () => {
  if (method === 'PUT') await click(`tbody [data-edit="${serial}-a"]`);
  else { await click('#addCf'); document.getElementById('f_date').value = '2025-03-18'; }
  document.getElementById('f_amount').value = '35000';
  document.getElementById('f_summary').value = '本題未送出的輸入';
  const form = el('#modal-root form');
  await navigate('#cards');
  assert.match(text('#cashflowFormInvalid'), /換頁.*失效/);
  assert.match(text('#cashflowFormInvalid'), /關閉.*重新讀取.*重新開啟/);
  assert.equal(el('#modal-root [data-cancel]').disabled, false);
  await navigate('#cashflow');
  const before = workspaceWithoutNotice(), count = reads();
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 0); assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 21000);
  assert.equal(workspaceWithoutNotice(), before); assert.equal(reads(), count);
  assert.equal(el('#modal-root form'), form);
  assert.equal(document.getElementById('f_summary').value, '本題未送出的輸入');
  assert.equal(document.getElementById('f_amount').value, '35000');
  assert.equal(el('#modal-root button[type="submit"]').disabled, true);
  await click('#modal-root [data-cancel]');
  await renderCashflow();
  await submit(method);
  const id = `${serial}-${method === 'PUT' ? 'a' : 'new'}`;
  assert.equal(writes().length, 1); assert.equal(rows.find(x => x.id === id).amount, 35000);
  assert.equal(el('#modal-root form'), null);
});

test('返回頁在寫入確認前開始的讀取晚回：持續提示直到新重讀，舊表單仍須重開', async () => {
  const writeWait = deferred(), readWait = deferred(); holdBeforeWrite = writeWait;
  let returning;
  try {
    await submit('PUT'); await click('#modal-root [data-cancel]'); await navigate('#cards');
    readQueue.push(async data => { await readWait.promise; return json(data); });
    window.history.replaceState(null, '', '#cashflow'); returning = app.router(); await settle();
    assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 21000);
    writeWait.resolve(); await settle(); holdBeforeWrite = null;
    assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
    const count = reads();
    readWait.resolve(); await returning; await settle();
    assert.equal(reads(), count); assert.equal(writes().length, 1);
    assert.match(el(`tbody [data-edit="${serial}-a"]`).closest('tr').textContent, /21,000/);
    assert.match(text('#cashflowReadError'), /資料已儲存，畫面尚未更新/);
    await click(`tbody [data-edit="${serial}-a"]`);
    const oldForm = el('#modal-root form');
    document.getElementById('f_summary').value = '本題舊快照摘要';
    oldForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.equal(writes().length, 1); assert.match(text('#toast-root'), /資料已更新/);
    await click('#retryCashflowRead');
    assert.equal(reads(), count + 1); assert.equal(el('#cashflowReadError'), null);
    oldForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.equal(writes().length, 1); assert.equal(el('#cashflowReadError'), null);
    await click('#modal-root [data-cancel]'); await click(`tbody [data-edit="${serial}-a"]`);
    assert.equal(document.getElementById('f_amount').value, '35000');
    document.getElementById('f_summary').value = '本題新版摘要';
    el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.equal(writes().length, 2); assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
    assert.equal(rows.find(x => x.id === `${serial}-a`).summary, '本題新版摘要');
  } finally { writeWait.resolve(); readWait.resolve(); holdBeforeWrite = null; await returning; await settle(); }
});

test('離頁返回後的寫入確認：補待更新提示但保留目前讀取錯誤及新彈窗', async () => {
  const wait = deferred(); holdBeforeWrite = wait;
  try {
    await submit('PUT'); await click('#modal-root [data-cancel]');
    await navigate('#cards'); await navigate('#cashflow');
    failReads = true; await renderCashflow();
    await click(`tbody [data-edit="${serial}-b"]`);
    document.getElementById('f_summary').value = '另一張表單未送出';
    const before = workspaceWithoutNotice(), form = el('#modal-root form'), count = reads();
    wait.resolve(); await settle();
    assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
    assert.equal(writes().length, 1); assert.equal(reads(), count); assert.equal(workspaceWithoutNotice(), before);
    assert.match(text('#cashflowReadError'), /資料已儲存，畫面尚未更新.*載入失敗.*合成錯誤 <img/);
    assert.equal(el('#cashflowReadError img'), null); assert.equal(el('#retryCashflowRead').disabled, false);
    assert.equal(el('#modal-root form'), form); assert.equal(document.getElementById('f_summary').value, '另一張表單未送出');
  } finally { wait.resolve(); holdBeforeWrite = null; await settle(); }
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


test('寫入等待時換頁後失敗：換頁即提示失效，保留輸入與取消，不等舊 catch 解鎖', async () => {
  const wait = deferred(); holdBeforeWrite = wait; failWrites = true;
  try {
    await submit('PUT'); assert.equal(writes().length, 1);
    const form = el('#modal-root form');
    await navigate('#cards'); await navigate('#cashflow');
    assert.match(text('#cashflowFormInvalid'), /換頁.*失效/);
    assert.equal(document.getElementById('f_amount').value, '35000');
    wait.resolve(); await settle();
    assert.equal(writes().length, 1); assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 21000);
    assert.equal(el('#modal-root form'), form); assert.match(text('#cashflowFormInvalid'), /重讀結果/);
    assert.doesNotMatch(text('#toast-root'), /已儲存/);
    assert.equal(el('#modal-root [data-cancel]').disabled, false);
    await click('#modal-root [data-cancel]'); assert.equal(el('#modal-root form'), null);
  } finally { wait.resolve(); holdBeforeWrite = null; await settle(); }
});

test('換頁失效的舊表單事件不能停用後開的新表單', async () => {
  await click(`tbody [data-edit="${serial}-a"]`);
  const oldForm = el('#modal-root form');
  await navigate('#cards'); await navigate('#cashflow');
  await click('#modal-root [data-cancel]');
  await click(`tbody [data-edit="${serial}-b"]`);
  document.getElementById('f_summary').value = '本題新窗保留值';
  const fresh = el('#modal-root form');
  oldForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(el('#modal-root form'), fresh);
  assert.equal(document.getElementById('f_summary').value, '本題新窗保留值');
  assert.equal(el('#modal-root button[type="submit"]').disabled, false);
  assert.equal(el('#cashflowFormInvalid'), null); assert.equal(writes().length, 0);
  fresh.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 1); assert.equal(rows.find(x => x.id === `${serial}-b`).summary, '本題新窗保留值');
});

test('同頁 router 重畫不使手動表單失效，寫入失敗仍可修正再送', async () => {
  await click(`tbody [data-edit="${serial}-a"]`);
  document.getElementById('f_summary').value = '本題背景重畫輸入';
  const form = el('#modal-root form');
  await app.router(); await settle();
  assert.equal(el('#cashflowFormInvalid'), null); failWrites = true;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 1); assert.match(text('#toast-root'), /本題寫入失敗/);
  assert.equal(el('#modal-root button[type="submit"]').disabled, false);
  failWrites = false;
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 2); assert.equal(rows.find(x => x.id === `${serial}-a`).summary, '本題背景重畫輸入');
});

for (const part of ['summary', 'remark']) test(`回音缺少 ${part}：寫入金額已改，舊快照失效但不報全部儲存，唯讀重讀後重開`, async () => {
  legacyText = true;
  await click(`tbody [data-edit="${serial}-a"]`);
  document.getElementById('f_amount').value = '35000';
  document.getElementById('f_' + part).value = '本題未確認文字';
  const first = el('#modal-root form'), before = snapshot();
  first.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 1); assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
  assert.notEqual(rows.find(x => x.id === `${serial}-a`)[part], '本題未確認文字');
  assert.deepEqual(snapshot(), before); assert.equal(reads(), 0);
  assert.equal(el('#modal-root form'), first); assert.equal(document.getElementById('f_' + part).value, '本題未確認文字');
  assert.match(text('#toast-root'), /摘要或備註未儲存/); assert.doesNotMatch(text('#toast-root'), /已儲存/);
  assert.match(text('#cashflowReadError'), /尚未確認.*重新讀取/); assert.doesNotMatch(text('#cashflowReadError'), /資料已儲存/);
  first.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 1);
  await click('#modal-root [data-cancel]'); await click(`tbody [data-edit="${serial}-a"]`);
  assert.equal(document.getElementById('f_amount').value, '21000');
  document.getElementById('f_summary').value = '本題第二張舊窗';
  const stale = el('#modal-root form');
  stale.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 1); assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
  failReads = true; await click('#retryCashflowRead');
  assert.match(text('#cashflowReadError'), /尚未確認.*載入失敗/); assert.doesNotMatch(text('#cashflowReadError'), /資料已儲存/);
  failReads = false; await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null);
  stale.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 1); assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
  await click('#modal-root [data-cancel]'); legacyText = false;
  await click(`tbody [data-edit="${serial}-a"]`);
  assert.equal(document.getElementById('f_amount').value, '35000');
  document.getElementById('f_' + part).value = '本題新版確認文字';
  el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 2); assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
  assert.equal(rows.find(x => x.id === `${serial}-a`)[part], '本題新版確認文字');
  assert.equal(el('#modal-root form'), null); assert.match(text('#toast-root'), /已儲存/);
});

for (const legacy of [false, true]) test(`回傳列已新但讀取開始早於${legacy ? '不完整' : '完整'}寫入確認：仍須新讀取才清提示`, async () => {
  const wait = deferred(); holdWrite = wait; legacyText = legacy;
  try {
    await click(`tbody [data-edit="${serial}-a"]`);
    document.getElementById('f_amount').value = '35000'; document.getElementById('f_summary').value = '本題新文字';
    el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
    await click('#modal-root [data-cancel]'); await navigate('#cards'); await navigate('#cashflow');
    assert.match(el(`tbody [data-edit="${serial}-a"]`).closest('tr').textContent, /35,000/);
    const before = workspaceWithoutNotice(), count = reads();
    wait.resolve(); await settle();
    assert.equal(writes().length, 1); assert.equal(reads(), count); assert.equal(workspaceWithoutNotice(), before);
    assert.match(text('#cashflowReadError'), legacy ? /尚未確認/ : /資料已儲存/);
    if (legacy) assert.doesNotMatch(text('#cashflowReadError'), /資料已儲存/);
    await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null);
    assert.equal(writes().length, 1); assert.equal(reads(), count + 1);
  } finally { wait.resolve(); holdWrite = null; await settle(); }
});

for (const fails of [false, true]) test(`跨頁後新窗接管：舊請求${fails ? '失敗' : '成功'}不得修改新窗輸入或停用按鈕`, async () => {
  const wait = deferred(); holdBeforeWrite = wait; failWrites = fails;
  try {
    await submit('PUT'); await navigate('#cards'); await navigate('#cashflow');
    await click('#modal-root [data-cancel]'); await click(`tbody [data-edit="${serial}-b"]`);
    document.getElementById('f_summary').value = '本題新窗專屬輸入';
    const form = el('#modal-root form');
    wait.resolve(); await settle();
    assert.equal(writes().length, 1);
    assert.equal(rows.find(x => x.id === `${serial}-a`).amount, fails ? 21000 : 35000);
    assert.equal(el('#modal-root form'), form);
    assert.equal(document.getElementById('f_summary').value, '本題新窗專屬輸入');
    assert.equal(el('#modal-root button[type="submit"]').disabled, false);
    assert.equal(el('#cashflowFormInvalid'), null);
  } finally { wait.resolve(); holdBeforeWrite = null; await settle(); }
});

test('未換頁但已關閉的舊表單事件不能借新表單的欄位寫入', async () => {
  await click(`tbody [data-edit="${serial}-a"]`);
  const old = el('#modal-root form');
  await click('#modal-root [data-cancel]'); await click(`tbody [data-edit="${serial}-b"]`);
  const fresh = el('#modal-root form'); document.getElementById('f_summary').value = '本題原位新窗';
  old.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 0); assert.equal(el('#modal-root form'), fresh);
  assert.equal(document.getElementById('f_summary').value, '本題原位新窗');
  assert.equal(el('#modal-root button[type="submit"]').disabled, false);
});

test('未確認回音後另筆新增成功：仍須保留不完整提示，不能用完整成功覆蓋', async () => {
  legacyText = true;
  await click(`tbody [data-edit="${serial}-a"]`);
  document.getElementById('f_summary').value = '本題尚未確認文字';
  document.getElementById('f_amount').value = '35000';
  el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes().length, 1); assert.equal(rows.find(x => x.id === `${serial}-a`).amount, 35000);
  await click('#modal-root [data-cancel]'); legacyText = false; failReads = true;
  await submit('POST');
  assert.equal(writes().length, 2); assert.equal(rows.find(x => x.id === `${serial}-new`).amount, 35000);
  assert.match(text('#cashflowReadError'), /尚未確認.*載入失敗/);
  assert.doesNotMatch(text('#cashflowReadError'), /資料已儲存/);
  failReads = false; await click('#retryCashflowRead');
  assert.equal(writes().length, 2); assert.equal(el('#cashflowReadError'), null);
});
