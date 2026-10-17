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
let endpointQueue = new Map();
let previewSimilar = 1;
let applyFlags = [];
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
  for (const key of ['document', 'window', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle', 'FileReader', 'File']) Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
  win.addEventListener('error', event => { windowErrors.push(event.error?.message || event.message); event.preventDefault(); });
  globalThis.fetch = async (url, init) => {
    const path = String(url).split('?')[0], method = init?.method || 'GET';
    calls.push({ path, method });
    const intercepted = method === 'GET' && endpointQueue.get(path)?.shift();
    if (intercepted) return intercepted();
    if (path === '/api/mode') return json({ hosted: false });
    if (path === '/api/bank-statement/preview') {
      const body = JSON.parse(init.body);
      assert.equal(body.data, 'c3ludGhldGljLXBkZg==');
      return new Response(JSON.stringify({ t: 'done', r: { rows: [], transactions: { rows: [{ ...fixture()[0], similar: !!previewSimilar }], counts: { expense: 1, similar: previewSimilar } } } }) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    if (path === '/api/bank-statement/apply') {
      const body = JSON.parse(init.body);
      assert.equal(body.data, 'c3ludGhldGljLXBkZg==');
      applyFlags.push({ hasSkip: Object.hasOwn(body, 'skipSimilar'), skip: body.skipSimilar });
      if (holdBeforeWrite) await holdBeforeWrite.promise;
      if (failWrites) return json({ error: '本題匯入失敗' }, 503);
      rows.push({ ...fixture()[0], id: `${serial}-import`, amount: 42000, source: 'bank', batchId: `${serial}-batch` });
      if (holdWrite) await holdWrite.promise;
      return json({ updated: 0, created: 0, transactions: { imported: 1 } });
    }
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
  serial++; rows = fixture(); calls = []; readQueue = []; endpointQueue = new Map(); previewSimilar = 1; applyFlags = []; failReads = false; failWrites = false; legacyText = false; holdWrite = null; holdBeforeWrite = null;
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

async function bankPreview() {
  await click('#uploadBank');
  const input = el('#f_file');
  Object.defineProperty(input, 'files', { value: [new File(['synthetic-pdf'], 'synthetic.pdf', { type: 'application/pdf' })], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  for (let n = 0; n < 10 && !el('#bankApply')?.onclick; n++) await settle();
  assert.equal(text('#modal-root h2'), '銀行對帳單預覽');
  assert.equal(typeof el('#bankApply').onclick, 'function');
}

test('第二階段｜真正 router 先清空工作區，失敗後恢復同次成功節點與唯讀重試', async () => {
  const before = snapshot(), node = el('.cashflow-workspace');
  const wait = deferred(); readQueue.push(async () => { await wait.promise; return readError(); });
  const pending = app.router();
  assert.equal(node.isConnected, false, '受測 router 確實先移除原工作區');
  try { wait.resolve(); await pending; await settle(); }
  finally { wait.resolve(); await pending; }
  assert.equal(el('.cashflow-workspace'), node);
  assert.deepEqual(snapshot(), before);
  assert.match(text('#cashflowReadError'), /畫面暫時無法更新，以下是上次成功載入的內容/);
  assert.equal(el('#cashflowReadError img'), null);
  assert.equal(text('#toast-root'), '', 'router 脫離後恢復只用持續提示');
  noticeWithoutDesktopLimit();
  await click('#retryCashflowRead');
  assert.equal(reads(), 2); assert.equal(writes().length, 0);
  assert.equal(el('#cashflowReadError'), null);
});

test('第二階段｜正式匯入確認後 GET 失敗保留舊列表，重讀不重新匯入', async () => {
  await bankPreview();
  const before = snapshot(); calls = []; failReads = true;
  await click('#bankApply');
  assert.equal(writes().length, 1); assert.equal(writes()[0].path, '/api/bank-statement/apply');
  assert.equal(rows.find(row => row.id === `${serial}-import`).batchId, `${serial}-batch`);
  assert.equal(el('#bankApply'), null);
  assert.deepEqual(snapshot(), before);
  assert.match(text('#cashflowReadError'), /資料已儲存，畫面尚未更新/);
  await click('#retryCashflowRead');
  assert.equal(writes().length, 1); assert.equal(reads(), 2);
  failReads = false; await click('#retryCashflowRead');
  assert.equal(writes().length, 1); assert.equal(reads(), 3);
  assert.equal(el('#cashflowReadError'), null);
  assert.ok(snapshot().ids.includes(`${serial}-import`));
  assert.match(el(`tbody [data-edit="${serial}-import"]`).closest('tr').textContent, /42,000/);
});

test('第二階段｜原工作區仍在頁內的讀取失敗保留原通知', async () => {
  const node = el('.cashflow-workspace'), before = snapshot();
  failReads = true;
  await renderCashflow(); await settle();
  assert.equal(el('.cashflow-workspace'), node);
  assert.deepEqual(snapshot(), before);
  assert.equal(reads(), 1); assert.equal(writes().length, 0);
  assert.match(text('#cashflowReadError'), /載入失敗：合成錯誤 <img/);
  assert.match(text('#toast-root'), /載入失敗：合成錯誤 <img/);
  assert.equal(el('#toast-root img'), null);
});

for (const path of ['/api/transactions', '/api/accounts', '/api/categories', '/api/income-categories', '/api/transfer-subcategories']) test(`第二階段｜${path} 失敗不提交局部結果，唯讀重試連點只讀一次`, async () => {
  const saved = el('.cashflow-workspace'), before = snapshot();
  rows.find(row => row.id === `${serial}-a`).amount = 57000;
  endpointQueue.set(path, [async () => readError()]);
  await app.router(); await settle();
  assert.equal(el('.cashflow-workspace'), saved); assert.deepEqual(snapshot(), before);
  assert.match(text('#cashflowReadError'), /上次成功載入/);
  const wait = deferred(); readQueue.push(async data => { await wait.promise; return json(data); });
  const button = el('#retryCashflowRead'), oldCallback = button.onclick, count = reads();
  button.click(); button.click(); oldCallback(); await settle();
  assert.equal(reads(), count + 1); assert.equal(button.disabled, true);
  try { wait.resolve(); await settle(); }
  finally { wait.resolve(); await settle(); }
  assert.equal(el('#cashflowReadError'), null);
  assert.match(el(`tbody [data-edit="${serial}-a"]`).closest('tr').textContent, /57,000/);
  const newer = el('.cashflow-workspace');
  oldCallback(); await settle(); assert.equal(reads(), count + 1);
  failReads = true; await app.router(); await settle();
  assert.equal(el('.cashflow-workspace'), newer, '更新成功之後只能恢復新版節點');
  assert.notEqual(newer, saved); assert.equal(writes().length, 0);
});

for (const importPending of [false, true]) test(`第二階段｜離頁返回沒有本次快照：${importPending ? '舊匯入確認' : '一般失敗'}不冒充零筆，重讀可恢復`, async () => {
  const wait = deferred();
  try {
    if (importPending) {
      await bankPreview(); holdBeforeWrite = wait;
      await click('#bankApply'); assert.equal(writes().filter(x => x.path.endsWith('/apply')).length, 1);
    }
    await navigate('#cards'); failReads = true; await navigate('#cashflow');
    assert.equal(el('.cashflow-ledger'), null);
    assert.doesNotMatch(text('#view'), /尚無銀行收支|0\.0 萬/);
    assert.match(text('#cashflowReadError'), /暫時無法載入銀行收支/);
    noticeWithoutDesktopLimit();
    const count = reads();
    if (importPending) {
      wait.resolve(); await settle();
      assert.equal(rows.find(row => row.id === `${serial}-import`).amount, 42000);
      assert.equal(reads(), count, '離頁後的確認只補事實，不自動重讀');
      assert.match(text('#cashflowReadError'), /資料已匯入，暫時無法載入列表/);
    }
    const beforeWrites = writes().length;
    await click('#retryCashflowRead'); assert.equal(reads(), count + 1); assert.equal(writes().length, beforeWrites);
    assert.match(text('#cashflowReadError'), importPending ? /資料已匯入，暫時無法載入列表/ : /暫時無法載入銀行收支/);
    failReads = false; await click('#retryCashflowRead');
    assert.equal(el('#cashflowReadError'), null); assert.ok(el('.cashflow-ledger'));
    if (importPending) {
      await click('.cashflow-stat-action[data-flow="expense"]');
      assert.ok(snapshot().ids.includes(`${serial}-import`));
    }
    assert.equal(writes().length, beforeWrites);
  } finally { wait.resolve(); holdBeforeWrite = null; await settle(); }
});

for (const lateFails of [false, true]) test(`第二階段｜同頁 router 舊${lateFails ? '失敗' : '成功'}晚回不能碰新版與錯誤`, async () => {
  const wait = deferred(); readQueue.push(async data => { await wait.promise; return lateFails ? readError() : json(data); });
  const oldNode = el('.cashflow-workspace'), pending = app.router();
  assert.equal(oldNode.isConnected, false);
  rows.find(row => row.id === `${serial}-a`).amount = 59000;
  await app.router();
  const newest = el('.cashflow-workspace'); assert.notEqual(newest, oldNode);
  failReads = true; await app.router();
  const before = document.getElementById('view').innerHTML;
  try { wait.resolve(); await pending; await settle(); assert.equal(document.getElementById('view').innerHTML, before); assert.equal(el('.cashflow-workspace'), newest); }
  finally { wait.resolve(); await pending; }
  assert.match(el(`tbody [data-edit="${serial}-a"]`).closest('tr').textContent, /59,000/);
});

for (const hostChange of [false, true]) test(`第二階段｜${hostChange ? 'host 換成同名新容器' : '成功節點被移到別處'}不借舊快照或舊重試`, async () => {
  failReads = true; await renderCashflow();
  const saved = el('.cashflow-workspace'), retry = el('#retryCashflowRead').onclick;
  const host = el('#view'); let replacement, other;
  if (hostChange) { replacement = document.createElement('main'); replacement.id = 'view'; host.replaceWith(replacement); }
  else { other = document.createElement('aside'); document.body.append(other); other.append(saved); }
  const count = reads(); retry(); await settle(); assert.equal(reads(), count);
  try {
    await app.router(); await settle();
    assert.notEqual(el('#view .cashflow-workspace'), saved);
    assert.equal(saved.parentNode, hostChange ? host : other);
    assert.match(text('#view #cashflowReadError'), /暫時無法載入銀行收支/);
  } finally { if (hostChange) replacement.replaceWith(host); else other.remove(); }
});

for (const failure of [false, true]) test(`第二階段｜hash 已變但 router 未執行，舊${failure ? '失敗' : '成功'}不能動頁面`, async () => {
  const wait = deferred(); readQueue.push(async data => { await wait.promise; return failure ? readError() : json(data); });
  const pending = renderCashflow(), before = el('#view').innerHTML;
  try {
    window.history.replaceState(null, '', '#cards');
    wait.resolve(); await pending;
    assert.equal(el('#view').innerHTML, before);
  } finally { wait.resolve(); await pending; window.history.replaceState(null, '', '#cashflow'); }
});

test('第二階段｜hash 快速離開返回，舊 DOM 與按鈕仍不得復活', async () => {
  failReads = true; await renderCashflow();
  const node = el('.cashflow-workspace'), retry = el('#retryCashflowRead').onclick;
  window.location.hash = '#cards'; window.location.hash = '#cashflow';
  await settle();
  assert.notEqual(el('.cashflow-workspace'), node);
  assert.equal(el('.cashflow-ledger'), null);
  const count = reads(); retry(); await settle(); assert.equal(reads(), count);
  assert.match(text('#cashflowReadError'), /暫時無法載入銀行收支/);
});

for (const beforeStore of [false, true]) test(`第二階段｜匯入在${beforeStore ? '寫入前' : '已寫入未確認'}暫停，較早讀取不得清確認與舊表單限制`, async () => {
  await bankPreview(); const wait = deferred();
  if (beforeStore) holdBeforeWrite = wait; else holdWrite = wait;
  try {
    await click('#bankApply'); assert.equal(writes().filter(x => x.path.endsWith('/apply')).length, 1);
    assert.equal(!!rows.find(row => row.id === `${serial}-import`), !beforeStore, '暫停點兩邊真的位於不同儲存階段');
    await click('#modal-root [data-close]');
    await navigate('#cards');
    const readWait = deferred(); readQueue.push(async data => { await readWait.promise; return json(data); });
    window.history.replaceState(null, '', '#cashflow');
    const reading = app.router();
    try {
      wait.resolve(); await settle();
      assert.equal(rows.find(row => row.id === `${serial}-import`).amount, 42000);
      readWait.resolve(); await reading; await settle();
      assert.match(text('#cashflowReadError'), /資料已儲存，畫面尚未更新/);
      await click(`tbody [data-edit="${serial}-a"]`);
      const stale = el('#modal-root form'); el('#f_summary').value = '匯入確認前快照的改動';
      const count = writes().length;
      stale.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
      assert.equal(writes().length, count); assert.match(text('#toast-root'), /資料已更新/);
      await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null);
      stale.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
      assert.equal(writes().length, count);
    } finally { readWait.resolve(); await reading; }
  } finally { wait.resolve(); holdBeforeWrite = null; holdWrite = null; await settle(); }
});

for (const fails of [false, true]) for (const closeNew of [false, true]) test(`第二階段｜原預覽${fails ? '失敗' : '成功'}續行不碰${closeNew ? '開過又關閉新窗後的焦點' : '新窗輸入與按鈕'}`, async () => {
  await bankPreview(); const wait = deferred(); holdBeforeWrite = wait; failWrites = fails;
  try {
    const original = el('#bankApply'), oldAction = original.onclick;
    await click('#bankApply');
    await click('#modal-root [data-close]'); await click('#addCf');
    el('#f_summary').value = '本題新窗保留'; const fresh = el('#modal-root form'), input = el('#f_summary'); input.focus();
    if (closeNew) { await click('#modal-root [data-cancel]'); el('#snapshotBtn').focus(); }
    const active = document.activeElement, count = reads(); el('#toast-root').replaceChildren();
    wait.resolve(); await settle();
    assert.equal(!!rows.find(row => row.id === `${serial}-import`), !fails);
    assert.equal(writes().filter(x => x.path.endsWith('/apply')).length, 1);
    assert.equal(el('#modal-root form'), closeNew ? null : fresh);
    if (!closeNew) { assert.equal(input.value, '本題新窗保留'); assert.equal(el('#modal-root button[type="submit"]').disabled, false); }
    assert.equal(document.activeElement, active); assert.equal(text('#toast-root'), '');
    assert.equal(reads(), fails ? count : count + 1, '有效同頁確認仍可背景重讀，沒有重開原預覽');
    oldAction(); await settle(); assert.equal(writes().filter(x => x.path.endsWith('/apply')).length, 1);
  } finally { wait.resolve(); holdBeforeWrite = null; await settle(); }
});

test('第二階段｜部分欄位未確認優先於後續匯入成功提示', async () => {
  legacyText = true; await click(`tbody [data-edit="${serial}-a"]`); el('#f_summary').value = '未確認摘要'; el('#f_amount').value = '35000';
  el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(rows.find(row => row.id === `${serial}-a`).amount, 35000);
  await click('#modal-root [data-cancel]'); await bankPreview(); failReads = true;
  await click('#bankApply');
  assert.equal(rows.find(row => row.id === `${serial}-import`).amount, 42000);
  assert.match(text('#cashflowReadError'), /部分欄位尚未確認儲存/); assert.doesNotMatch(text('#cashflowReadError'), /資料已儲存|資料已匯入/);
});

for (const path of ['/api/transactions', '/api/accounts', '/api/categories', '/api/income-categories', '/api/transfer-subcategories']) test(`第二階段｜${path} 慢回：五端點完成前不提交，成功快照才可恢復`, async () => {
  const wait = deferred(), beforeNode = el('.cashflow-workspace');
  const value = { '/api/transactions': structuredClone(rows), '/api/accounts': [], '/api/categories': { 居住: ['房租'] }, '/api/income-categories': { 工作: ['薪資'] }, '/api/transfer-subcategories': [] };
  endpointQueue.set(path, [async () => { await wait.promise; return json(value[path]); }]);
  const pending = app.router(); await settle();
  assert.equal(beforeNode.isConnected, false); assert.ok(el('#view .loading')); assert.equal(el('#view .cashflow-ledger'), null);
  try { wait.resolve(); await pending; await settle(); }
  finally { wait.resolve(); await pending; }
  const committed = el('.cashflow-workspace'); assert.notEqual(committed, beforeNode); assert.ok(el('.cashflow-ledger'));
  failReads = true; await app.router(); await settle();
  assert.equal(el('.cashflow-workspace'), committed); assert.equal(writes().length, 0);
});

test('第二階段｜過期提示與重試移到別處或被同名節點取代，舊 callback 不讀取', async () => {
  failReads = true; await renderCashflow();
  const notice = el('#cashflowReadError'), callback = el('#retryCashflowRead').onclick, workspace = el('.cashflow-workspace');
  const aside = document.createElement('aside'); document.body.append(aside); aside.append(notice);
  const replacement = notice.cloneNode(true); workspace.append(replacement);
  const count = reads();
  try { callback(); await settle(); assert.equal(reads(), count); assert.equal(el('#view #cashflowReadError'), replacement); }
  finally { aside.remove(); replacement.remove(); }
});

test('第二階段｜同頁換新預覽，舊成功不能清同名新鈕或挪用其勾選值', async () => {
  await bankPreview(); const original = el('#bankApply'), oldApply = original.onclick, oldSkip = el('#skipSimilarChk'), oldChange = oldSkip.onchange;
  const wait = deferred(); holdBeforeWrite = wait;
  try {
    oldSkip.checked = true;
    await click('#bankApply'); await click('#modal-root [data-close]'); await bankPreview();
    const fresh = el('#bankApply'), freshDialog = el('#modal-root .modal'), newSkip = el('#skipSimilarChk');
    assert.notEqual(fresh, original); newSkip.checked = false; newSkip.dispatchEvent(new Event('change', { bubbles: true }));
    assert.deepEqual(applyFlags, [{ hasSkip: true, skip: true }], '已送出的 body 保留按下原窗時的值');
    const footnote = text('#bankPreviewFootnote'); oldSkip.checked = true; oldChange();
    assert.equal(text('#bankPreviewFootnote'), footnote); assert.equal(newSkip.checked, false);
    const active = document.activeElement; wait.resolve(); await settle();
    assert.equal(rows.find(row => row.id === `${serial}-import`).amount, 42000);
    assert.equal(el('#modal-root .modal'), freshDialog); assert.equal(el('#bankApply'), fresh); assert.equal(fresh.disabled, false);
    assert.equal(text('#bankPreviewFootnote'), footnote); assert.equal(document.activeElement, active);
    oldApply(); await settle(); assert.equal(writes().filter(x => x.path.endsWith('/apply')).length, 1);
    assert.deepEqual(applyFlags, [{ hasSkip: true, skip: true }]);
  } finally { wait.resolve(); holdBeforeWrite = null; await settle(); }
});

test('第二階段｜延後綁定遇同名新預覽，不得把舊 callback 綁上新鈕', async () => {
  const originalTimer = globalThis.setTimeout; let binding;
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (!binding && delay === 0 && text('#modal-root h2') === '銀行對帳單預覽' && el('#bankApply')?.onclick === null) {
      binding = fn; return 0;
    }
    return originalTimer(fn, delay, ...args);
  };
  try {
    await click('#uploadBank');
    const input = el('#f_file'); Object.defineProperty(input, 'files', { value: [new File(['synthetic-pdf'], 'synthetic.pdf')], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let n = 0; n < 10 && !binding; n++) await settle();
    assert.equal(typeof binding, 'function'); assert.equal(el('#bankApply').onclick, null);
  } finally { globalThis.setTimeout = originalTimer; }
  await click('#modal-root [data-close]'); await bankPreview();
  const fresh = el('#bankApply'), handler = fresh.onclick, skip = el('#skipSimilarChk'), changed = skip.onchange;
  binding();
  assert.equal(fresh.onclick, handler); assert.equal(skip.onchange, changed);
  assert.equal(writes().filter(x => x.path.endsWith('/apply')).length, 0);
});

test('第二階段｜原窗仍有效的匯入失敗可重試，但未知結果不宣稱成功', async () => {
  await bankPreview(); failWrites = true; const button = el('#bankApply');
  await click('#bankApply'); assert.equal(button.disabled, false); assert.equal(el('#bankApply'), button);
  assert.equal(rows.find(row => row.id === `${serial}-import`), undefined);
  assert.match(text('#toast-root'), /本題匯入失敗/); assert.doesNotMatch(text('#cashflowReadError'), /已儲存|已匯入/);
  assert.equal(reads(), 0);
  failWrites = false; await click('#bankApply'); assert.equal(rows.find(row => row.id === `${serial}-import`).amount, 42000);
  assert.equal(writes().filter(x => x.path.endsWith('/apply')).length, 2);
});

test('第二階段｜在途讀取期間才確認部分欄位，當前重試仍鎖定不多讀', async () => {
  const writeWait = deferred(), readWait = deferred(); holdWrite = writeWait; legacyText = true;
  let reading;
  try {
    await click(`tbody [data-edit="${serial}-a"]`);
    el('#f_amount').value = '35000'; el('#f_summary').value = '本題等待確認的新摘要';
    el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.equal(rows.find(row => row.id === `${serial}-a`).amount, 35000);
    readQueue.push(async data => { await readWait.promise; return json(data); });
    reading = renderCashflow(); await settle();
    writeWait.resolve(); await settle();
    assert.match(text('#cashflowReadError'), /尚未確認/);
    const button = el('#retryCashflowRead'), count = reads(); assert.equal(button.disabled, true);
    button.onclick(); await settle(); assert.equal(reads(), count);
    readWait.resolve(); await reading; await settle();
    assert.match(text('#cashflowReadError'), /尚未確認/);
    await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null);
    assert.equal(writes().length, 1);
  } finally { writeWait.resolve(); readWait.resolve(); holdWrite = null; await reading; await settle(); }
});

test('第二階段｜匯入確認前開啟的新編輯窗，背景成功讀取也不能升級其送出資格', async () => {
  await bankPreview(); const wait = deferred(); holdWrite = wait;
  try {
    await click('#bankApply'); assert.equal(rows.find(row => row.id === `${serial}-import`).amount, 42000);
    await click('#modal-root [data-close]'); await click(`tbody [data-edit="${serial}-a"]`);
    el('#f_summary').value = '匯入確認前開啟的表單'; const form = el('#modal-root form');
    wait.resolve(); await settle(); assert.equal(el('#cashflowReadError'), null);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.equal(writes().filter(x => x.method === 'PUT').length, 0);
    assert.equal(el('#modal-root form'), form); assert.match(text('#toast-root'), /資料已更新/);
    assert.equal(el('#f_summary').value, '匯入確認前開啟的表單');
  } finally { wait.resolve(); holdWrite = null; await settle(); }
});

test('第二階段｜history 路由離開返回不復活前次節點，即使沒有 hashchange 事件', async () => {
  const original = el('.cashflow-workspace');
  window.history.replaceState(null, '', '#cards'); await app.router();
  failReads = true; window.history.replaceState(null, '', '#cashflow'); await app.router(); await settle();
  assert.notEqual(el('.cashflow-workspace'), original); assert.equal(original.isConnected, false);
  assert.equal(el('.cashflow-ledger'), null); assert.match(text('#cashflowReadError'), /暫時無法載入銀行收支/);
});

for (const checked of [true, false, null]) test(`第二階段｜原預覽勾選${checked === null ? '入口不存在' : checked ? '開' : '關'}：真 apply 僅嚴格 true 才帶跳過旗標`, async () => {
  previewSimilar = checked === null ? 0 : 1;
  await bankPreview();
  const checkbox = el('#skipSimilarChk');
  if (checked === null) assert.equal(checkbox, null);
  else { checkbox.checked = checked; checkbox.dispatchEvent(new Event('change', { bubbles: true })); }
  await click('#bankApply');
  assert.equal(rows.find(row => row.id === `${serial}-import`).batchId, `${serial}-batch`);
  assert.deepEqual(applyFlags, [{ hasSkip: checked === true, skip: checked === true ? true : undefined }]);
  assert.equal(writes().filter(x => x.path.endsWith('/apply')).length, 1);
});

for (const checked of [true, false]) test(`第二階段｜原預覽外同名控制項與原勾選${checked ? '開' : '關'}相反，apply 仍讀原窗`, async () => {
  await bankPreview();
  const own = el('#modal-root #skipSimilarChk'); own.checked = checked;
  // 合成身分邊界：原窗仍有效，外部同名 ID 只用來揭露全域取值的錯誤來源。
  const outside = document.createElement('input'); outside.type = 'checkbox'; outside.id = own.id; outside.checked = !checked;
  document.body.prepend(outside);
  try {
    assert.equal(document.getElementById(own.id), outside);
    await click('#bankApply');
    assert.equal(rows.find(row => row.id === `${serial}-import`).batchId, `${serial}-batch`);
    assert.deepEqual(applyFlags, [{ hasSkip: checked, skip: checked ? true : undefined }]);
    assert.equal(writes().filter(x => x.path.endsWith('/apply')).length, 1);
  } finally { outside.remove(); }
});

// 這裡驗裝置限定與流程；實際 CSS 可見性另由真瀏覽器斷點兩側的操作驗證。
function noticeWithoutDesktopLimit() {
  const notice = el('#cashflowReadError'); assert.ok(notice);
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.equal(notice.classList.contains('cashflow-desktop-only'), false);
  assert.ok(el('#retryCashflowRead'));
  return notice;
}

test('可見性｜無成功快照連續失敗保留必要提示，新成功工作區不繼承提升', async () => {
  await navigate('#cards'); failReads = true; await navigate('#cashflow');
  const first = noticeWithoutDesktopLimit(), oldRetry = el('#retryCashflowRead').onclick;
  assert.match(first.textContent, /暫時無法載入銀行收支/);
  assert.equal(el('.cashflow-ledger'), null);
  await click('#retryCashflowRead');
  const second = noticeWithoutDesktopLimit(); assert.notEqual(second, first);
  const count = reads(); oldRetry(); await settle(); assert.equal(reads(), count);
  failReads = false; await click('#retryCashflowRead');
  assert.equal(el('#cashflowReadError'), null); assert.ok(el('.cashflow-ledger'));
  failReads = true; await renderCashflow(); await settle();
  assert.equal(el('#cashflowReadError').classList.contains('cashflow-desktop-only'), true);
  assert.match(text('#toast-root'), /載入失敗/); assert.equal(writes().length, 0);
});

test('可見性｜router提升後再次頁內失敗不降級，成功後普通頁內通知沿原預設', async () => {
  const node = el('.cashflow-workspace'); failReads = true;
  const wait = deferred(); readQueue.push(async () => { await wait.promise; return readError(); });
  const reading = app.router(); assert.equal(node.isConnected, false);
  try { wait.resolve(); await reading; await settle(); }
  finally { wait.resolve(); await reading; }
  assert.equal(el('.cashflow-workspace'), node);
  const notice = noticeWithoutDesktopLimit(); assert.equal(text('#toast-root'), '');
  await click('#retryCashflowRead');
  assert.equal(noticeWithoutDesktopLimit(), notice);
  assert.equal(reads(), 2); assert.equal(writes().length, 0);
  failReads = false; await click('#retryCashflowRead');
  assert.equal(el('#cashflowReadError'), null); assert.notEqual(el('.cashflow-workspace'), node);
  el('#toast-root').replaceChildren(); failReads = true; await renderCashflow(); await settle();
  assert.equal(el('#cashflowReadError').classList.contains('cashflow-desktop-only'), true);
  assert.match(text('#toast-root'), /載入失敗/);
});

for (const kind of ['import', 'partial']) test(`可見性｜提升後重試在途才確認${kind === 'import' ? '匯入' : '部分欄位'}，提示保持且入口停用`, async () => {
  const writeWait = deferred(), readWait = deferred(); holdWrite = writeWait;
  try {
    if (kind === 'import') {
      await bankPreview(); calls = []; await click('#bankApply');
      assert.equal(rows.find(row => row.id === `${serial}-import`).amount, 42000);
      await click('#modal-root [data-close]');
    } else {
      legacyText = true; await click(`tbody [data-edit="${serial}-a"]`);
      el('#f_summary').value = '本題未確認的新摘要'; el('#f_amount').value = '35000';
      el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
      assert.equal(rows.find(row => row.id === `${serial}-a`).amount, 35000);
      await click('#modal-root [data-cancel]');
    }
    await navigate('#cards'); await navigate('#cashflow');
    failReads = true; await app.router(); await settle(); noticeWithoutDesktopLimit();
    readQueue.push(async () => { await readWait.promise; return readError(); });
    await click('#retryCashflowRead'); const count = reads(), previousButton = el('#retryCashflowRead');
    assert.equal(previousButton.disabled, true);
    writeWait.resolve(); await settle();
    noticeWithoutDesktopLimit();
    assert.match(text('#cashflowReadError'), kind === 'import' ? /資料已儲存，畫面尚未更新/ : /部分欄位尚未確認儲存/);
    assert.equal(el('#retryCashflowRead').disabled, true);
    previousButton.onclick(); el('#retryCashflowRead').onclick(); await settle();
    assert.equal(reads(), count); assert.equal(writes().length, 1);
    readWait.resolve(); await settle(); noticeWithoutDesktopLimit();
    assert.equal(el('#retryCashflowRead').disabled, false);
    assert.equal(el('#cashflowReadError img'), null);
    failReads = false; await click('#retryCashflowRead');
    assert.equal(el('#cashflowReadError'), null); assert.equal(writes().length, 1);
  } finally { writeWait.resolve(); readWait.resolve(); holdWrite = null; await settle(); }
});
