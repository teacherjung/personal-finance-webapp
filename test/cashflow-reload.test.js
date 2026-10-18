// 真 DOM＋合成 fetch：驗證儲存、重讀與切頁的結果；不讀本機資料、不連外。
// 每題重種資料並明確選年月、金流與排序；共享 import 僅為載入 app 的循環模組圖。
// node --test 的檔案行程隔離承擔全域 DOM 清理；本檔不驗瀏覽器的版面尺寸。
/* global document, window, HTMLElement, Element */
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
let deleteQueue = new Map();
let deleteResponse = { ok: true };
let batchReadQueue = [];
let batchDeleteQueue = new Map();
let failBatchReads = false;
let batchReplyOverride = false;
let batchReply = null;
let batchBodies = [];
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
function removeBankBatchRows(id) {
  const before = rows.length;
  rows = rows.filter(row => !(row.source === 'bank' && row.importBatch === id) && !(row.source === 'stmt' && row.bankBatch === id));
  return before - rows.length;
}
function bankBatchFixtureList() {
  const groups = new Map();
  for (const row of rows.filter(item => item.source === 'bank' && item.importBatch)) {
    if (!groups.has(row.importBatch)) groups.set(row.importBatch, { batchId: row.importBatch, count: 0, income: 0, expense: 0, transfer: 0, minDate: row.date, maxDate: row.date });
    const group = groups.get(row.importBatch);
    group.count++;
    group[row.type] += row.amount;
  }
  for (const group of groups.values()) group.cardCount = rows.filter(row => row.source === 'stmt' && row.bankBatch === group.batchId).length;
  return [...groups.values()];
}
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
    if (path === '/api/bank-statement/batches' && method === 'GET') {
      const snapshot = bankBatchFixtureList(), action = batchReadQueue.shift();
      if (action) return action(snapshot);
      return failBatchReads ? readError() : json(snapshot);
    }
    if (path === '/api/bank-statement/batch/delete' && method === 'POST') {
      const body = JSON.parse(init.body), action = batchDeleteQueue.get(body.batchId)?.shift();
      batchBodies.push(body);
      if (action) return action();
      const removed = removeBankBatchRows(body.batchId);
      return json(batchReplyOverride ? batchReply : { ok: true, removed });
    }
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
    if (path.startsWith('/api/transactions/') && method === 'DELETE') {
      const id = path.split('/').at(-1), action = deleteQueue.get(id)?.shift();
      if (action) return action();
      if (holdBeforeWrite) await holdBeforeWrite.promise;
      if (failWrites) return json({ error: '本題刪除請求失敗' }, 503);
      rows = rows.filter(x => x.id !== id);
      if (holdWrite) await holdWrite.promise;
      return json(deleteResponse);
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
  window.confirm = () => true; deleteQueue = new Map(); deleteResponse = { ok: true };
  batchReadQueue = []; batchDeleteQueue = new Map(); failBatchReads = false; batchReplyOverride = false; batchReply = null; batchBodies = [];
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

// jsdom 沒有排版引擎；可見性以樣式及候選自己的矩形覆寫分開驗，原生停用失焦另有瀏覽器證據。
function retryFocusEnvironment(t) {
  const ownHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  t.after(() => { if (ownHidden) Object.defineProperty(document, 'hidden', ownHidden); else delete document.hidden; });
  t.mock.method(HTMLElement.prototype, 'getClientRects', function () { return this.isConnected ? [{ width: 10, height: 10 }] : []; });
}
async function retryFocusFailure(t, withoutSnapshot = false) {
  retryFocusEnvironment(t);
  if (withoutSnapshot) { await navigate('#cards'); failReads = true; await navigate('#cashflow'); }
  else { failReads = true; await renderCashflow(); }
  const button = el('#retryCashflowRead'); button.focus(); assert.equal(document.activeElement, button);
  return button;
}
function disableBlurs(button) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLButtonElement.prototype, 'disabled');
  assert.equal(typeof descriptor?.set, 'function');
  Object.defineProperty(button, 'disabled', { configurable: true, get() { return descriptor.get.call(this); },
    // jsdom 停用後的 blur() 被它略過；在同一 setter scope 先發真 blur，原生順序由瀏覽器另核。
    set(value) { if (value && document.activeElement === this) this.blur(); descriptor.set.call(this, value); } });
}
for (const withoutSnapshot of [false, true]) for (const outcome of ['success', 'failure', 'empty']) {
  test(`重試回焦｜${withoutSnapshot ? '無舊列表' : '有舊列表'}／${outcome}：實際讀取後回核定候選`, async t => {
    const button = await retryFocusFailure(t, withoutSnapshot), before = reads(), callStart = calls.length; disableBlurs(button);
    if (outcome === 'empty') rows = [];
    failReads = outcome === 'failure'; button.click(); await settle();
    assert.equal(reads(), before + 1); assert.equal(writes().length, 0);
    assert.equal(button.isConnected, false);
    assert.deepEqual(calls.slice(callStart).map(call => `${call.method} ${call.path}`).sort(), ['/api/transactions', '/api/accounts', '/api/categories', '/api/income-categories', '/api/transfer-subcategories'].map(path => `GET ${path}`).sort());
    const target = outcome === 'failure' ? el('#retryCashflowRead') : el('.cashflow-head h1');
    assert.equal(document.activeElement, target);
    if (outcome === 'failure') assert.equal(target.disabled, false);
    else {
      assert.equal(el('#cashflowReadError'), null); assert.equal(target.getAttribute('tabindex'), '-1');
      target.blur(); assert.equal(target.hasAttribute('tabindex'), false);
    }
  });
}
for (const failure of [false, true]) test(`重試回焦｜原鈕未持焦不建立工作／${failure}`, async t => {
  await retryFocusFailure(t); el('#fixture-outside')?.remove();
  const outside = document.createElement('button'); outside.id = 'fixture-outside'; document.body.append(outside);
  try { outside.focus(); const before = reads(); failReads = failure; el('#retryCashflowRead').click(); await settle();
    assert.equal(reads(), before + 1); assert.equal(writes().length, 0); assert.equal(document.activeElement, outside);
  } finally { outside.remove(); }
});
for (const kind of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'blur', 'window-blur', 'hidden', 'modal', 'modal-closed', 'focus-returned']) {
  test(`重試回焦｜等待期間${kind}撤銷，不取消讀取或搶回`, async t => {
    const button = await retryFocusFailure(t), wait = deferred(), before = reads(); disableBlurs(button);
    readQueue.push(async data => { await wait.promise; return json(data); }); button.click(); await settle();
    const outside = document.createElement('button'); document.body.append(outside);
    try {
      assert.equal(reads(), before + 1); assert.equal(button.disabled, true);
      if (kind === 'blur') button.dispatchEvent(new Event('blur'));
      else if (kind === 'window-blur') window.dispatchEvent(new Event('blur'));
      else if (kind === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); }
      else if (kind.startsWith('modal')) { app.openInfo('本題新窗', '<input id="retry-new-input" value="本題未儲存內容">'); await settle(); if (kind === 'modal-closed') { await click('#modal-root [data-close]'); outside.focus(); outside.blur(); } else el('#retry-new-input').focus(); }
      else if (kind === 'focus-returned') { outside.focus(); outside.blur(); }
      else document.dispatchEvent(new Event(kind, { bubbles: true }));
      const current = document.activeElement; wait.resolve(); await settle();
      assert.equal(reads(), before + 1); assert.equal(writes().length, 0); assert.equal(el('#cashflowReadError'), null);
      assert.equal(document.activeElement, current.isConnected ? current : document.body); assert.notEqual(document.activeElement, el('.cashflow-head h1'));
      if (kind === 'modal') assert.equal(el('#retry-new-input').value, '本題未儲存內容');
    } finally { wait.resolve(); outside.remove(); el('#modal-root').replaceChildren(); await settle(); }
  });
}
for (const oldFails of [false, true]) test(`重試回焦｜舊${oldFails ? '失敗' : '成功'}晚回不接管較新讀取`, async t => {
  const button = await retryFocusFailure(t), wait = deferred(); disableBlurs(button);
  readQueue.push(async data => { await wait.promise; return oldFails ? readError() : json(data); }); button.click(); await settle();
  failReads = false; rows.find(row => row.id === `${serial}-a`).summary = '本題較新列表'; await renderCashflow();
  const page = el('.cashflow-workspace'); const input = document.createElement('input'); page.append(input); input.value = '較新輸入'; input.focus();
  try { wait.resolve(); await settle(); assert.equal(el('.cashflow-workspace'), page); assert.equal(document.activeElement, input); assert.equal(input.value, '較新輸入'); assert.match(page.textContent, /本題較新列表/); assert.equal(writes().length, 0); }
  finally { wait.resolve(); await settle(); }
});
for (const historyOnly of [false, true]) test(`重試回焦｜離開返回${historyOnly ? '無hashchange' : '正常導航'}不復活工作`, async t => {
  const button = await retryFocusFailure(t), wait = deferred(); disableBlurs(button);
  readQueue.push(async data => { await wait.promise; return json(data); }); button.click(); await settle();
  if (historyOnly) { window.history.replaceState(null, '', '#cards'); await app.router(); window.history.replaceState(null, '', '#cashflow'); failReads = false; await app.router(); }
  else { await navigate('#cards'); failReads = false; await navigate('#cashflow'); }
  const page = el('.cashflow-workspace'), current = document.activeElement;
  wait.resolve(); await settle(); assert.equal(el('.cashflow-workspace'), page); assert.equal(document.activeElement, current); assert.equal(writes().length, 0);
});
for (const moved of ['button', 'notice', 'workspace']) test(`重試回焦｜等待期間${moved}移除再放回不得復活`, async t => {
  const button = await retryFocusFailure(t), wait = deferred(), before = reads(); disableBlurs(button);
  readQueue.push(async data => { await wait.promise; return json(data); }); button.click(); await settle();
  const node = moved === 'button' ? button : moved === 'notice' ? el('#cashflowReadError') : el('.cashflow-workspace');
  const parent = node.parentNode, next = node.nextSibling; node.remove(); parent.insertBefore(node, next);
  wait.resolve(); await settle(); assert.equal(reads(), before + 1); assert.equal(writes().length, 0); assert.equal(document.activeElement, document.body);
});

function onRetryWorkspaceReplacement(t, adjust) {
  const host = el('#view'), original = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  assert.equal(typeof original?.set, 'function');
  Object.defineProperty(host, 'innerHTML', { configurable: true, get() { return original.get.call(this); },
    set(value) { original.set.call(this, value); const node = this.querySelector('.cashflow-workspace'); if (node) adjust(node); } });
  t.after(() => { delete host.innerHTML; });
}
for (const invalid of ['hidden', 'inert', 'display', 'ancestor', 'zero', 'duplicate', 'throw', 'refuse']) {
  test(`重試回焦｜成功標題${invalid}不可用就停止，不猜導航`, async t => {
    const button = await retryFocusFailure(t), before = reads(); disableBlurs(button);
    onRetryWorkspaceReplacement(t, node => {
      const target = node.querySelector('.cashflow-head h1');
      if (invalid === 'hidden') target.hidden = true;
      else if (invalid === 'inert') target.setAttribute('inert', '');
      else if (invalid === 'display') target.style.display = 'none';
      else if (invalid === 'ancestor') target.parentElement.style.visibility = 'hidden';
      else if (invalid === 'zero') target.getClientRects = () => [];
      else if (invalid === 'duplicate') target.after(target.cloneNode(true));
      else if (invalid === 'throw') target.focus = () => { throw Error('合成拒焦'); };
      else target.focus = () => {};
    });
    failReads = false; button.click(); await settle(); assert.equal(reads(), before + 1); assert.equal(writes().length, 0);
    assert.equal(document.activeElement, document.body); assert.equal(el('.cashflow-head h1').hasAttribute('tabindex'), false);
  });
}
for (const reentry of ['modal', 'external', 'render']) test(`重試回焦｜候選focus期間${reentry}接管不追焦`, async t => {
  const button = await retryFocusFailure(t), before = reads(); disableBlurs(button);
  const outside = document.createElement('input'); outside.value = '本題外部未送出'; document.body.append(outside);
  let fired = 0;
  onRetryWorkspaceReplacement(t, node => node.querySelector('.cashflow-head h1').addEventListener('focus', () => {
    fired++;
    if (reentry === 'modal') app.openInfo('本題接管新窗', '<input id="retry-reentry-input" value="新窗未送出">');
    else if (reentry === 'external') outside.focus();
    else renderCashflow();
  }, { once: true }));
  try {
    failReads = false; button.click(); await settle(); assert.equal(fired, 1);
    assert.equal(reads(), before + (reentry === 'render' ? 2 : 1)); assert.equal(writes().length, 0);
    assert.equal(el('.cashflow-head h1').hasAttribute('tabindex'), false);
    if (reentry === 'modal') { assert.equal(el('#retry-reentry-input').value, '新窗未送出'); assert.ok(el('#modal-root').contains(document.activeElement)); }
    else if (reentry === 'external') { assert.equal(document.activeElement, outside); assert.equal(outside.value, '本題外部未送出'); }
  } finally { outside.remove(); el('#modal-root').replaceChildren(); await settle(); }
});
for (const existing of [null, '0', '-1', '3']) test(`重試回焦｜標題tabindex原值${existing}在離焦與外改後保留`, async t => {
  const button = await retryFocusFailure(t); disableBlurs(button);
  onRetryWorkspaceReplacement(t, node => { if (existing !== null) node.querySelector('h1').setAttribute('tabindex', existing); });
  failReads = false; button.click(); await settle(); const heading = el('.cashflow-head h1');
  assert.equal(document.activeElement, heading); assert.equal(heading.getAttribute('tabindex'), existing ?? '-1');
  if (existing === null) heading.setAttribute('tabindex', '4');
  heading.blur(); assert.equal(heading.getAttribute('tabindex'), existing ?? '4'); assert.equal(writes().length, 0);
});

for (const kind of ['complete', 'partial', 'import']) test(`重試回焦｜等待中${kind}確認更新提示即取消，讀取仍完成`, async t => {
  retryFocusEnvironment(t); const writeWait = deferred(), readWait = deferred(); holdWrite = writeWait;
  try {
    if (kind === 'import') { await bankPreview(); await click('#bankApply'); assert.equal(rows.find(row => row.id === `${serial}-import`).amount, 42000); await click('#modal-root [data-close]'); }
    else { legacyText = kind === 'partial'; await click(`tbody [data-edit="${serial}-a"]`); el('#f_amount').value = '35000'; el('#f_summary').value = '本題待確認的新摘要'; el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(); assert.equal(rows.find(row => row.id === `${serial}-a`).amount, 35000); await click('#modal-root [data-cancel]'); }
    // 讓原寫入的舊頁續行停止；確認本身仍須更新目前頁的必要提示。
    await navigate('#cards'); await navigate('#cashflow');
    failReads = true; await renderCashflow(); const old = el('#retryCashflowRead'); old.focus(); disableBlurs(old);
    const count = reads(), written = writes().length;
    readQueue.push(async data => { await readWait.promise; return json(data); }); old.click(); await settle();
    writeWait.resolve(); await settle(); const replacement = el('#retryCashflowRead'); assert.notEqual(replacement, old);
    assert.equal(replacement.disabled, true); replacement.click(); old.onclick(); await settle(); assert.equal(reads(), count + 1);
    assert.match(text('#cashflowReadError'), kind === 'partial' ? /部分欄位尚未確認/ : /畫面尚未更新/);
    failReads = false; readWait.resolve(); await settle();
    assert.equal(reads(), count + 1); assert.equal(writes().length, written); assert.ok(el('#cashflowReadError'));
    assert.equal(el('#retryCashflowRead').disabled, false); assert.equal(document.activeElement, document.body);
    await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null); assert.equal(writes().length, written);
  } finally { writeWait.resolve(); readWait.resolve(); holdWrite = null; await settle(); }
});
for (const invalid of ['disabled', 'hidden', 'inert', 'duplicate', 'duplicate-notice']) test(`重試回焦｜失敗重試候選${invalid}時不改選標題`, async t => {
  const button = await retryFocusFailure(t), notice = el('#cashflowReadError'), before = reads(); disableBlurs(button);
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(notice, 'innerHTML', { configurable: true, get() { return descriptor.get.call(this); }, set(value) {
    descriptor.set.call(this, value); const replacement = this.querySelector('#retryCashflowRead');
    if (invalid === 'disabled') Object.defineProperty(replacement, 'disabled', { configurable: true, get: () => true, set() {} });
    else if (invalid === 'hidden') replacement.hidden = true;
    else if (invalid === 'inert') replacement.setAttribute('inert', '');
    else if (invalid === 'duplicate') replacement.after(replacement.cloneNode(true));
    else this.after(this.cloneNode(true));
  } });
  t.after(() => { delete notice.innerHTML; });
  button.click(); await settle(); assert.equal(reads(), before + 1); assert.equal(writes().length, 0);
  assert.equal(document.activeElement, document.body); assert.equal(el('.cashflow-head h1').hasAttribute('tabindex'), false);
});
for (const cancel of [false, true]) test(`重試回焦｜${cancel ? '取消' : '完成'}後移除自己的全域與原鈕監聽`, async t => {
  const button = await retryFocusFailure(t), added = [], removed = [], proto = window.EventTarget.prototype;
  const add = proto.addEventListener, remove = proto.removeEventListener;
  t.mock.method(proto, 'addEventListener', function (type, handler, options) { if ([window, document, button].includes(this)) added.push([this, type, handler, options]); return add.call(this, type, handler, options); });
  t.mock.method(proto, 'removeEventListener', function (type, handler, options) { if ([window, document, button].includes(this)) removed.push([this, type, handler, options]); return remove.call(this, type, handler, options); });
  disableBlurs(button); const wait = deferred(), before = reads(); readQueue.push(async data => { await wait.promise; return json(data); });
  button.click(); await settle(); if (cancel) document.dispatchEvent(new Event('keydown')); wait.resolve(); await settle();
  assert.equal(reads(), before + 1); assert.equal(writes().length, 0); assert.ok(added.some(item => item[1] === 'wheel'));
  for (const [target, type, handler, options] of added) assert.ok(removed.some(item => item[0] === target && item[1] === type && item[2] === handler && item[3] === options), `cashflow重試工作須收掉${type}監聽；修正該模組後重跑本題`);
  if (!cancel) assert.equal(document.activeElement, el('.cashflow-head h1'));
});

test('重試回焦｜新窗世代即使未移焦且已撤銷仍不得復活', async t => {
  const button = await retryFocusFailure(t), wait = deferred(), before = reads(); disableBlurs(button);
  readQueue.push(async data => { await wait.promise; return json(data); }); button.click(); await settle();
  assert.equal(document.activeElement, document.body);
  const owns = app.claimModalRoot(); owns.release();
  wait.resolve(); await settle(); assert.equal(reads(), before + 1); assert.equal(writes().length, 0);
  assert.equal(document.activeElement, document.body); assert.equal(el('#modal-root').childNodes.length, 0);
});

test('重試回焦｜在途連點及舊callback不能增加讀取或重新取得資格', async t => {
  const button = await retryFocusFailure(t), wait = deferred(), before = reads(), old = button.onclick; disableBlurs(button);
  readQueue.push(async data => { await wait.promise; return json(data); }); button.click(); await settle();
  button.click(); old(); await settle(); assert.equal(reads(), before + 1);
  document.dispatchEvent(new Event('keydown')); wait.resolve(); await settle();
  assert.equal(document.activeElement, document.body); old(); await settle();
  assert.equal(reads(), before + 1); assert.equal(writes().length, 0);
});

// 受控延後事件只在 setter 進入時仍持焦才排送；原生事件時序另由隔離瀏覽器核實。
for (const failure of [false, true]) test(`重試回焦｜停用仍持焦才排延後blur／${failure}：明確釋焦後回本次候選`, async t => {
  const button = await retryFocusFailure(t), wait = deferred(), before = reads();
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLButtonElement.prototype, 'disabled');
  let queued = 0;
  Object.defineProperty(button, 'disabled', { configurable: true, get() { return descriptor.get.call(this); }, set(value) {
    const held = value && document.activeElement === this; descriptor.set.call(this, value);
    if (held) { queued++; queueMicrotask(() => this.dispatchEvent(new Event('blur'))); }
  } });
  readQueue.push(async data => { await wait.promise; return failure ? readError() : json(data); });
  button.click(); await settle();
  try {
    assert.equal(reads(), before + 1); assert.equal(button.disabled, true);
    wait.resolve(); await settle();
    assert.equal(document.activeElement, failure ? el('#retryCashflowRead') : el('.cashflow-head h1'));
    assert.equal(queued, 0); assert.equal(writes().length, 0);
  } finally { wait.resolve(); await settle(); }
});
for (const takeover of ['render', 'replace', 'hash', 'modal', 'external']) test(`重試回焦｜明確blur期間${takeover}接管：重核讀取資格且不搶焦`, async t => {
  const button = await retryFocusFailure(t), before = reads(), outside = document.createElement('input');
  outside.value = '本題未送出的外部輸入'; document.body.append(outside);
  let fired = 0;
  button.addEventListener('blur', () => {
    fired++; if (fired !== 1) return;
    if (takeover === 'render') renderCashflow();
    else if (takeover === 'replace') button.replaceWith(button.cloneNode(true));
    else if (takeover === 'hash') window.history.replaceState(null, '', '#cards');
    else if (takeover === 'modal') app.openInfo('本題釋焦新窗', '<input id="retry-preblur-modal" value="本題新窗內容">');
    else outside.focus();
  });
  try {
    failReads = false; button.click(); await settle(); assert.equal(fired, 1);
    assert.equal(reads(), before + (['replace', 'hash'].includes(takeover) ? 0 : 1)); assert.equal(writes().length, 0);
    if (takeover === 'external') { assert.equal(document.activeElement, outside); assert.equal(outside.value, '本題未送出的外部輸入'); }
    else if (takeover === 'modal') { assert.ok(el('#modal-root').contains(document.activeElement)); assert.equal(el('#retry-preblur-modal').value, '本題新窗內容'); }
    else assert.notEqual(document.activeElement, el('.cashflow-head h1'));
  } finally { outside.remove(); el('#modal-root').replaceChildren(); await settle(); }
});
for (const badBlur of ['throw', 'refuse', 'refocus']) test(`重試回焦｜明確blur${badBlur}不假造釋焦資格，合法GET仍完成`, async t => {
  const button = await retryFocusFailure(t), before = reads(), original = button.blur.bind(button); let attempted = 0;
  button.blur = () => { attempted++; if (badBlur === 'throw') throw Error('本題拒絕釋焦'); if (badBlur === 'refocus') { original(); button.focus(); } };
  failReads = false; button.click(); await settle();
  assert.equal(attempted, 1); assert.equal(reads(), before + 1); assert.equal(writes().length, 0);
  assert.equal(document.activeElement, document.body); assert.equal(el('.cashflow-head h1').hasAttribute('tabindex'), false);
});

const deleteCount = () => writes().filter(call => call.method === 'DELETE').length;
const deleteButton = (suffix = 'a') => el(`tbody [data-del="${serial}-${suffix}"]`);
const deleteRow = async (suffix = 'a') => { assert.ok(deleteButton(suffix)); deleteButton(suffix).click(); await settle(); };
function holdDeletion(suffix = 'a', beforeCommit = false) {
  const wait = deferred(), id = `${serial}-${suffix}`;
  deleteQueue.set(id, [async () => {
    if (beforeCommit) await wait.promise;
    rows = rows.filter(row => row.id !== id);
    if (!beforeCommit) await wait.promise;
    return json({ ok: true });
  }]);
  return wait;
}

test('單筆刪除｜原確認取消零請求，後續接受仍正常', async () => {
  let asked = ''; window.confirm = message => { asked = message; return false; };
  const before = snapshot(); await deleteRow();
  assert.equal(asked, '確定要刪除「支出 21,000 元」嗎？此動作無法復原。');
  assert.equal(writes().length, 0); assert.equal(reads(), 0); assert.deepEqual(snapshot(), before);
  window.confirm = () => true; await deleteRow();
  assert.equal(deleteCount(), 1); assert.equal(rows.some(row => row.id === `${serial}-a`), false);
  assert.equal(deleteButton(), null); assert.equal(el('#cashflowReadError'), null);
});

test('單筆刪除｜成功後讀取失敗保留快照，重試只讀，成功才清提示', async () => {
  const before = snapshot(), oldButton = deleteButton(), oldCallback = oldButton.onclick;
  failReads = true; await deleteRow();
  assert.equal(deleteCount(), 1); assert.equal(rows.some(row => row.id === `${serial}-a`), false);
  assert.equal(reads(), 1); assert.deepEqual(snapshot(), before);
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
  assert.equal(el('#cashflowReadError img'), null);
  document.getElementById('toast-root').replaceChildren();
  oldCallback(); await settle(); assert.equal(deleteCount(), 1);
  const start = calls.length; await click('#retryCashflowRead');
  assert.equal(reads(), 2); assert.equal(deleteCount(), 1); assert.deepEqual(snapshot(), before);
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
  failReads = false; await click('#retryCashflowRead');
  assert.equal(reads(), 3); assert.equal(deleteCount(), 1); assert.equal(deleteButton(), null);
  assert.equal(el('#cashflowReadError'), null); assert.ok(calls.slice(start).every(call => call.method === 'GET'));
  oldCallback(); await settle(); assert.equal(deleteCount(), 1, '覆蓋讀取後清理確認紀錄，斷開舊入口仍無資格');
  failReads = true; await renderCashflow();
  assert.doesNotMatch(text('#cashflowReadError'), /資料已刪除/);
});

for (const failure of ['http', 'network', 'null', 'missing', 'string']) test(`單筆刪除｜${failure}未取得嚴格確認，不報成功或自動重讀`, async () => {
  const id = `${serial}-a`, before = snapshot();
  deleteQueue.set(id, [async () => {
    if (failure === 'network') throw new Error('本題合成連線失敗');
    if (failure === 'http') return json({ error: '本題合成拒絕' }, 400);
    rows = rows.filter(row => row.id !== id);
    return json(failure === 'null' ? null : failure === 'missing' ? {} : { ok: 'true' });
  }]);
  await deleteRow();
  assert.equal(deleteCount(), 1); assert.equal(reads(), 0); assert.deepEqual(snapshot(), before);
  assert.doesNotMatch(text('#cashflowReadError'), /資料已刪除/); assert.doesNotMatch(text('#toast-root'), /已刪除/);
  assert.equal(rows.some(row => row.id === id), ['http', 'network'].includes(failure), '未知回音不等於資料必定未變');
  if (['http', 'network'].includes(failure)) { await deleteRow(); assert.equal(deleteCount(), 2); assert.equal(deleteButton(), null); }
});

test('單筆刪除｜確認同步重入、在途及已確認舊列都只送一次', async () => {
  const wait = holdDeletion(); const button = deleteButton(), callback = button.onclick;
  let confirms = 0; window.confirm = () => { confirms++; callback(); return true; };
  failReads = true; button.click(); await settle();
  button.click(); callback(); await settle();
  const inflight = deleteCount(); wait.resolve(); await settle();
  button.click(); callback(); await settle();
  assert.equal(rows.some(row => row.id === `${serial}-a`), false);
  assert.equal(inflight, 1); assert.equal(deleteCount(), 1); assert.equal(confirms, 1);
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
});

for (const takeover of ['detach', 'replace', 'navigate', 'render', 'modal']) test(`單筆刪除｜原生確認返回前${takeover}使原入口失效，不發DELETE`, async () => {
  const button = deleteButton(), before = rows.length;
  let render;
  window.confirm = () => {
    if (takeover === 'detach') button.remove();
    if (takeover === 'replace') button.replaceWith(button.cloneNode(true));
    if (takeover === 'navigate') window.location.hash = '#cards';
    if (takeover === 'render') render = renderCashflow();
    if (takeover === 'modal') app.openInfo('本題新窗', '<p>合成內容</p>');
    return true;
  };
  button.click(); await settle(); if (render) await render;
  assert.equal(deleteCount(), 0); assert.equal(rows.length, before); assert.doesNotMatch(text('#toast-root'), /已刪除/);
});

for (const olderFirst of [true, false]) test(`單筆刪除｜不同id獨立接受，確認順序${olderFirst}只准最新作業續行`, async () => {
  const a = holdDeletion('a'), b = holdDeletion('b');
  await deleteRow('a'); await deleteRow('b');
  assert.equal(deleteCount(), 2); assert.ok(!rows.some(row => [serial + '-a', serial + '-b'].includes(row.id)));
  if (olderFirst) { a.resolve(); await settle(); assert.equal(reads(), 0); b.resolve(); await settle(); }
  else {
    b.resolve(); await settle();
    const node = el('.cashflow-workspace'), count = reads(); document.getElementById('toast-root').replaceChildren();
    a.resolve(); await settle();
    assert.equal(el('.cashflow-workspace'), node); assert.equal(reads(), count); assert.doesNotMatch(text('#toast-root'), /已刪除/);
    assert.match(text('#cashflowReadError'), /資料已刪除/);
    await click('#retryCashflowRead');
  }
  assert.equal(deleteCount(), 2); assert.equal(el('#cashflowReadError'), null);
});

for (const lateFails of [false, true]) test(`單筆刪除｜確認前GET晚${lateFails ? '失敗' : '成功'}不能覆蓋確認，亦不多起GET`, async () => {
  const read = deferred();
  readQueue.push(async () => { await read.promise; return lateFails ? readError() : json(structuredClone(rows)); });
  const reading = renderCashflow(); await settle();
  await deleteRow();
  assert.equal(rows.some(row => row.id === `${serial}-a`), false); assert.equal(deleteCount(), 1); assert.equal(reads(), 1);
  assert.equal(el('#retryCashflowRead').disabled, true);
  read.resolve(); await reading; await settle();
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
  assert.equal(reads(), 1); assert.equal(el('#retryCashflowRead').disabled, false);
  await click('#retryCashflowRead'); assert.equal(deleteCount(), 1); assert.equal(el('#cashflowReadError'), null);
});

for (const path of ['/api/transactions', '/api/accounts', '/api/categories', '/api/income-categories', '/api/transfer-subcategories']) test(`單筆刪除｜${path}失敗不可清刪除確認`, async () => {
  endpointQueue.set(path, [() => readError()]); const before = snapshot();
  await deleteRow(); assert.equal(rows.some(row => row.id === `${serial}-a`), false);
  assert.deepEqual(snapshot(), before); assert.match(text('#cashflowReadError'), /資料已刪除/);
  await click('#retryCashflowRead'); assert.equal(deleteCount(), 1); assert.equal(el('#cashflowReadError'), null);
});

for (const takeover of ['other-page', 'return', 'new-modal', 'closed-modal', 'new-render']) test(`單筆刪除｜晚確認遇${takeover}只記事實不接管呈現`, async () => {
  const wait = holdDeletion(); await deleteRow();
  if (takeover === 'other-page' || takeover === 'return') await navigate('#cards');
  if (takeover === 'return') { failReads = true; await navigate('#cashflow'); }
  if (takeover === 'new-render') await renderCashflow();
  if (takeover === 'new-modal' || takeover === 'closed-modal') {
    await click('#addCf'); el('#f_summary').value = '本題新輸入';
    if (takeover === 'closed-modal') await click('#modal-root [data-cancel]');
  }
  const node = el('.cashflow-workspace'), seq = app.currentRouteSeq(), count = reads(), input = el('#f_summary');
  document.getElementById('toast-root').replaceChildren(); wait.resolve(); await settle();
  assert.equal(rows.some(row => row.id === `${serial}-a`), false); assert.equal(deleteCount(), 1);
  assert.equal(app.currentRouteSeq(), seq); assert.equal(reads(), count); assert.equal(el('.cashflow-workspace'), node);
  assert.doesNotMatch(text('#toast-root'), /已刪除/);
  if (input) { assert.equal(el('#f_summary'), input); assert.equal(input.value, '本題新輸入'); }
  if (takeover === 'return') {
    assert.match(text('#cashflowReadError'), /資料已刪除，暫時無法載入列表/);
    assert.equal(el('#cashflowReadError').classList.contains('cashflow-desktop-only'), false);
    failReads = false; await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null);
  }
});

for (const suffix of ['a', 'b']) test(`單筆刪除｜確認前已開${suffix}編輯窗不升級舊快照`, async () => {
  const wait = holdDeletion(); await deleteRow(); await click(`tbody [data-edit="${serial}-${suffix}"]`);
  el('#f_summary').value = '本題保留輸入'; wait.resolve(); await settle();
  const submitForm = async () => { el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(); };
  await submitForm(); assert.equal(writes().filter(call => call.method === 'PUT').length, 0);
  assert.equal(el('#f_summary').value, '本題保留輸入'); assert.match(text('#toast-root'), /資料已更新；請關閉編輯視窗，重新讀取後再編輯。/);
  await renderCashflow(); await submitForm(); assert.equal(writes().filter(call => call.method === 'PUT').length, 0);
  await click('#modal-root [data-cancel]'); await click(`tbody [data-edit="${serial}-b"]`);
  el('#f_summary').value = '本題新快照'; await submitForm();
  assert.equal(writes().filter(call => call.method === 'PUT').length, 1);
  assert.equal(rows.find(row => row.id === `${serial}-b`).summary, '本題新快照');
});

test('單筆刪除｜後續普通儲存不能洗掉未涵蓋的刪除確認', async () => {
  failReads = true; await deleteRow();
  await click('#addCf'); el('#f_date').value = '2025-03-18'; el('#f_summary').value = '本題新增'; el('#f_amount').value = '987';
  el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(rows.find(row => row.id === `${serial}-new`).amount, 987);
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
  failReads = false; await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null);
});

test('單筆刪除｜未確認欄位優先，刪除不冒充完整儲存', async () => {
  failReads = true; legacyText = true; await click(`tbody [data-edit="${serial}-a"]`);
  el('#f_summary').value = '本題未確認的新摘要'; el('#f_amount').value = '35000';
  el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(rows.find(row => row.id === `${serial}-a`).amount, 35000);
  await click('#modal-root [data-cancel]');
  await deleteRow('b'); assert.equal(rows.some(row => row.id === `${serial}-b`), false);
  assert.match(text('#cashflowReadError'), /部分欄位尚未確認儲存/); assert.doesNotMatch(text('#cashflowReadError'), /資料已刪除/);
  failReads = false; await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null);
});

test('單筆刪除｜最後可見列刪除後讀取成功可呈現空列表', async () => {
  rows = rows.filter(row => row.id === `${serial}-a`); await renderCashflow();
  await deleteRow(); assert.equal(rows.length, 0); assert.equal(deleteCount(), 1);
  assert.equal(el('#cashflowReadError'), null); assert.equal(document.querySelectorAll('tbody [data-del]').length, 0);
});


test('單筆刪除｜較新失敗讀取仍保留原工作區時，舊確認不自動再讀', async () => {
  const wait = holdDeletion(); const node = el('.cashflow-workspace'); await deleteRow();
  failReads = true; await renderCashflow(); assert.equal(el('.cashflow-workspace'), node);
  const count = reads(); wait.resolve(); await settle();
  assert.equal(rows.some(row => row.id === `${serial}-a`), false); assert.equal(reads(), count);
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
});

test('單筆刪除｜另一筆確認取消不奪走已接受刪除的呈現資格', async () => {
  const wait = holdDeletion(); await deleteRow(); window.confirm = () => false;
  await deleteRow('b'); wait.resolve(); await settle();
  assert.equal(deleteCount(), 1); assert.equal(reads(), 1); assert.equal(deleteButton(), null);
  assert.ok(deleteButton('b')); assert.equal(el('#cashflowReadError'), null);
});

test('單筆刪除｜在途換頁返回的新列仍不能重送同id', async () => {
  const wait = holdDeletion('a', true); await deleteRow(); await navigate('#cards'); await navigate('#cashflow');
  await select('yearSelDesktop', '2025'); await select('monthSelDesktop', '03');
  await deleteRow(); const count = deleteCount(); wait.resolve(); await settle();
  assert.equal(rows.some(row => row.id === `${serial}-a`), false); assert.equal(count, 1); assert.equal(deleteCount(), 1);
  assert.match(text('#cashflowReadError'), /資料已刪除/);
});

test('單筆刪除｜確認前GET晚生同id舊列，新的控制項也不能再刪', async () => {
  const wait = deferred(), read = deferred(); holdWrite = wait;
  const oldRows = structuredClone(rows); readQueue.push(async () => { await read.promise; return json(oldRows); });
  const reading = renderCashflow(); await settle(); await deleteRow();
  wait.resolve(); await settle(); read.resolve(); await reading; await settle(); holdWrite = null;
  assert.equal(rows.some(row => row.id === `${serial}-a`), false); assert.ok(deleteButton());
  await deleteRow(); assert.equal(deleteCount(), 1); assert.match(text('#cashflowReadError'), /資料已刪除/);
  await click('#retryCashflowRead'); assert.equal(deleteButton(), null);
});

test('單筆刪除｜後續匯入不能洗掉未涵蓋刪除', async () => {
  failReads = true; await deleteRow(); await bankPreview(); await click('#bankApply');
  assert.equal(rows.find(row => row.id === `${serial}-import`).amount, 42000);
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
  failReads = false; await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null);
});

test('單筆刪除｜重試在途確認刪除取消回焦，仍完成原GET', async t => {
  retryFocusEnvironment(t);
  const write = holdDeletion(), read = deferred(); await deleteRow();
  await navigate('#cards'); await navigate('#cashflow'); failReads = true; await renderCashflow();
  const button = el('#retryCashflowRead'); button.focus(); disableBlurs(button);
  readQueue.push(async data => { await read.promise; return json(data); });
  const count = reads(); button.click(); await settle();
  write.resolve(); await settle(); assert.equal(el('#retryCashflowRead').disabled, true);
  assert.equal(reads(), count + 1); read.resolve(); await settle();
  assert.match(text('#cashflowReadError'), /資料已刪除/); assert.equal(document.activeElement, document.body);
  assert.equal(deleteCount(), 1); failReads = false; await click('#retryCashflowRead'); assert.equal(el('#cashflowReadError'), null);
});


test('單筆刪除｜其他月份同id資料不唯一時不猜要刪哪筆', async () => {
  rows.push({ ...rows.find(row => row.id === `${serial}-a`), date: '2025-12-10' });
  await renderCashflow(); const before = rows.length;
  assert.equal(document.querySelectorAll(`tbody [data-del="${serial}-a"]`).length, 1);
  await deleteRow(); assert.equal(deleteCount(), 0); assert.equal(rows.length, before);
});

test('單筆刪除｜建立pending提示同步開新窗後不啟動舊作業GET', async t => {
  const node = el('.cashflow-workspace'), insert = node.insertBefore.bind(node);
  let fired = false;
  t.mock.method(node, 'insertBefore', function (child, anchor) {
    const result = insert(child, anchor);
    if (!fired && child.id === 'cashflowReadError') { fired = true; app.openInfo('本題接管', '<input id="delete-reentry-input" value="本題未存輸入">'); }
    return result;
  });
  await deleteRow(); assert.equal(rows.some(row => row.id === `${serial}-a`), false);
  assert.equal(fired, true); assert.equal(deleteCount(), 1); assert.equal(reads(), 0);
  assert.equal(el('#delete-reentry-input').value, '本題未存輸入');
  assert.match(text('#cashflowReadError'), /資料已刪除/);
});

const batchReads = () => calls.filter(call => call.method === 'GET' && call.path === '/api/bank-statement/batches').length;
async function seedBankBatchManager({ second = true, linked = false } = {}) {
  const id = `${serial}-batch-a`;
  Object.assign(rows[0], { source: 'bank', importBatch: id });
  if (second) Object.assign(rows[1], { source: 'bank', importBatch: `${serial}-batch-b` });
  if (linked) rows.push({ ...rows[0], id: `${serial}-linked`, source: 'stmt', ledger: 'card', bankBatch: id });
  await renderCashflow();
  await click('#bankBatches');
  return id;
}
function batchButton(id) { return [...document.querySelectorAll('#modal-root [data-delbatch]')].find(button => button.dataset.delbatch === id); }
async function clickBatch(id) { assert.ok(batchButton(id)); batchButton(id).click(); await settle(); }

for (const mainFails of [false, true]) for (const batchFails of [false, true]) {
  test(`批次刪除｜兩域分開處理 main=${mainFails} batches=${batchFails}`, async () => {
    const id = await seedBankBatchManager(), dialog = el('#modal-root .modal'), before = snapshot();
    failReads = mainFails; failBatchReads = batchFails;
    await clickBatch(id);
    assert.equal(rows.some(row => row.importBatch === id), false, '受測POST確實移除本題資料');
    assert.deepEqual(batchBodies, [{ batchId: id }]);
    if (mainFails) { assert.deepEqual(snapshot(), before); assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/); }
    else { assert.equal(el('#cashflowReadError'), null); assert.equal(el(`[data-del="${serial}-a"]`), null); }
    assert.equal(el('#modal-root .modal'), dialog, '批次更新不能重開shell');
    if (batchFails) { assert.match(text('[data-bank-batch-notice]'), /資料已刪除，匯入紀錄尚未更新/); assert.ok(batchButton(id)); }
    else { assert.equal(batchButton(id), undefined); assert.equal(el('[data-bank-batch-notice]').hidden, true); }
  });
}

test('批次刪除｜兩個重試只讀自己的領域，不互代清提示或重送POST', async () => {
  const id = await seedBankBatchManager({ second: false });
  failReads = true; failBatchReads = true; await clickBatch(id);
  const before = reads(); failBatchReads = false; await click('[data-retry-bank-batches]');
  assert.equal(reads(), before); assert.equal(el('#modal-root .modal'), null);
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
  const batchBefore = batchReads(); failReads = false; await click('#retryCashflowRead');
  assert.equal(batchReads(), batchBefore); assert.equal(el('#cashflowReadError'), null);
  assert.equal(el(`[data-del="${serial}-a"]`), null); assert.equal(batchBodies.length, 1);
});

test('批次刪除｜主列表成功不清批次窗pending，同批舊鈕不能重送或走單筆DELETE', async () => {
  const id = await seedBankBatchManager();
  failReads = true; failBatchReads = true; await clickBatch(id);
  await clickBatch(id); await deleteRow();
  assert.equal(batchBodies.length, 1); assert.equal(deleteCount(), 0);
  failReads = false; await click('#retryCashflowRead');
  assert.match(text('[data-bank-batch-notice]'), /資料已刪除，匯入紀錄尚未更新/);
  await clickBatch(id); assert.equal(batchBodies.length, 1);
  failBatchReads = false; await click('[data-retry-bank-batches]');
  assert.equal(el('[data-bank-batch-notice]').hidden, true);
});

test('批次刪除｜原生確認逐字，取消不發POST且保留資料', async () => {
  const id = await seedBankBatchManager({ linked: true });
  const before = structuredClone(rows), messages = [];
  window.confirm = message => { messages.push(message); return false; };
  await clickBatch(id);
  assert.deepEqual(messages, ['確定要刪除「整批 1 筆收支交易＋連帶記到卡片的 1 筆刷卡消費明細（2025-03-04~2025-03-04）——兩本帳一起刪」嗎？此動作無法復原。']);
  assert.equal(batchBodies.length, 0); assert.deepEqual(rows, before);
});

test('批次刪除｜連帶卡片列與銀行列真正移除，手動撞號及其他批次保持', async () => {
  const id = await seedBankBatchManager({ linked: true });
  rows.push({ ...fixture()[0], id: `${serial}-manual-collision`, source: 'manual', importBatch: id });
  await clickBatch(id);
  assert.equal(rows.some(row => row.id === `${serial}-a` || row.id === `${serial}-linked`), false);
  assert.ok(rows.some(row => row.id === `${serial}-manual-collision`));
  assert.ok(rows.some(row => row.importBatch === `${serial}-batch-b`));
  assert.match(text('#toast-root'), /已刪除 2 筆，可重新上傳/);
});

test('批次刪除｜同批同步連點只送一個POST', async () => {
  const id = await seedBankBatchManager(), button = batchButton(id);
  button.click(); button.click(); await settle();
  assert.equal(rows.some(row => row.importBatch === id), false); assert.equal(batchBodies.length, 1);
});

for (const [label, response] of [['false', { ok: false }], ['string', { ok: 'true' }], ['missing', {}], ['null', null]]) {
  test(`批次刪除｜${label}回音記未知，不自動重送或假稱成功`, async () => {
    const id = await seedBankBatchManager(), mainBefore = reads(), batchBefore = batchReads();
    batchReplyOverride = true; batchReply = response; await clickBatch(id);
    assert.equal(rows.some(row => row.importBatch === id), false, '未知回音不保證未寫入');
    assert.match(text('#cashflowReadError'), /刪除結果尚未確認，請重新讀取後確認資料/);
    assert.match(text('[data-bank-batch-notice]'), /刪除結果尚未確認，請重新讀取後確認資料/);
    assert.doesNotMatch(text('#toast-root'), /已刪除/);
    assert.equal(reads(), mainBefore); assert.equal(batchReads(), batchBefore);
    await clickBatch(id); assert.equal(batchBodies.length, 1);
    await click('#retryCashflowRead'); assert.match(text('[data-bank-batch-notice]'), /刪除結果尚未確認/);
    await click('[data-retry-bank-batches]'); assert.equal(el('[data-bank-batch-notice]').hidden, true);
    assert.equal(batchBodies.length, 1);
  });
}

for (const [label, removed] of [['missing', undefined], ['negative', -1], ['fraction', 1.5], ['string', '1'], ['null', null]]) {
  test(`批次刪除｜確認成功而${label}筆數不撤銷事實或捏造數字`, async () => {
    const id = await seedBankBatchManager(); failReads = true; failBatchReads = true;
    batchReplyOverride = true; batchReply = { ok: true, removed }; await clickBatch(id);
    assert.equal(rows.some(row => row.importBatch === id), false);
    assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
    assert.match(text('[data-bank-batch-notice]'), /資料已刪除，匯入紀錄尚未更新/);
    assert.match(text('#toast-root'), /資料已刪除，請重新讀取確認資料/);
    assert.doesNotMatch(text('#toast-root'), /undefined|NaN|已刪除 -1 筆|已刪除 1\.5 筆/);
  });
}

test('批次刪除｜ok真且removed零仍是確認，不當成失敗', async () => {
  const id = await seedBankBatchManager(); assert.equal(removeBankBatchRows(id), 1);
  failReads = true; failBatchReads = true; await clickBatch(id);
  assert.equal(batchBodies.length, 1); assert.match(text('#toast-root'), /已刪除 0 筆，可重新上傳/);
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
});

test('批次刪除｜初開慢GET不接管等待期間的新視窗', async () => {
  const id = `${serial}-initial-batch`; Object.assign(rows[0], { source: 'bank', importBatch: id }); await renderCashflow();
  const gate = deferred(); batchReadQueue.push(() => gate.promise); await click('#bankBatches');
  app.openInfo('本題較新視窗', '<input id="batch-new-input" value="未存輸入">'); const dialog = el('#modal-root .modal');
  gate.resolve(json([{ batchId: id, count: 1 }])); await settle();
  assert.equal(el('#modal-root .modal'), dialog); assert.equal(el('#batch-new-input').value, '未存輸入');
  assert.equal(batchBodies.length, 0);
});

test('批次刪除｜確認後批次GET晚回不替換或清除新窗', async () => {
  const id = await seedBankBatchManager(), gate = deferred(); batchReadQueue.push(() => gate.promise);
  await clickBatch(id); assert.equal(rows.some(row => row.importBatch === id), false);
  app.openInfo('本題較新視窗', '<input id="batch-late-input" value="保留此值">'); const dialog = el('#modal-root .modal');
  gate.resolve(json([])); await settle();
  assert.equal(el('#modal-root .modal'), dialog); assert.equal(el('#batch-late-input').value, '保留此值');
});

test('批次刪除｜關窗後重新開啟的同批控制項仍受在途鎖保護', async () => {
  const id = await seedBankBatchManager(), gate = deferred();
  batchDeleteQueue.set(id, [async () => { await gate.promise; return json({ ok: true, removed: removeBankBatchRows(id) }); }]);
  await clickBatch(id); await click('#modal-root [data-close]'); await click('#bankBatches');
  const dialog = el('#modal-root .modal'); await clickBatch(id); assert.equal(batchBodies.length, 1);
  gate.resolve(); await settle();
  assert.equal(rows.some(row => row.importBatch === id), false); assert.equal(el('#modal-root .modal'), dialog);
  assert.match(text('[data-bank-batch-notice]'), /資料已刪除，匯入紀錄尚未更新/);
});

for (const label of ['http', 'network']) test(`批次刪除｜${label}失敗可能已寫入，記未知且不自動重試`, async () => {
  const id = await seedBankBatchManager(), mainBefore = reads(), batchBefore = batchReads();
  batchDeleteQueue.set(id, [() => {
    assert.equal(removeBankBatchRows(id), 1);
    if (label === 'network') throw new Error('本題網路中斷');
    return json({ error: '本題HTTP失敗' }, 503);
  }]);
  await clickBatch(id);
  assert.equal(batchBodies.length, 1); assert.equal(rows.some(row => row.importBatch === id), false);
  assert.match(text('#cashflowReadError'), /刪除結果尚未確認/);
  assert.match(text('[data-bank-batch-notice]'), /刪除結果尚未確認/);
  assert.doesNotMatch(text('#toast-root'), /已刪除/);
  assert.equal(reads(), mainBefore); assert.equal(batchReads(), batchBefore);
});

test('批次刪除｜不同批次獨立送出，舊ACK只記確認不接管新呈現', async () => {
  const id = await seedBankBatchManager(), other = `${serial}-batch-b`, first = deferred(), second = deferred();
  batchDeleteQueue.set(id, [async () => { await first.promise; return json({ ok: true, removed: removeBankBatchRows(id) }); }]);
  batchDeleteQueue.set(other, [async () => { await second.promise; return json({ ok: true, removed: removeBankBatchRows(other) }); }]);
  await clickBatch(id); await clickBatch(other); assert.equal(batchBodies.length, 2);
  second.resolve(); await settle();
  const mainBefore = reads(), batchBefore = batchReads(), dialog = el('#modal-root .modal');
  assert.ok(batchButton(id)); first.resolve(); await settle();
  assert.equal(rows.some(row => row.importBatch === id || row.importBatch === other), false);
  assert.equal(reads(), mainBefore); assert.equal(batchReads(), batchBefore);
  assert.equal(el('#modal-root .modal'), dialog);
  assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
  assert.match(text('[data-bank-batch-notice]'), /資料已刪除，匯入紀錄尚未更新/);
});

test('批次刪除｜確認前啟動的主列表GET不能清批次事實或解除舊單筆保護', async () => {
  const id = await seedBankBatchManager(), gate = deferred(); let started;
  readQueue.push(snapshot => { started = snapshot; return gate.promise; });
  const flight = renderCashflow(); await settle(); await clickBatch(id);
  assert.equal(rows.some(row => row.importBatch === id), false);
  assert.equal(batchButton(id), undefined, '批次域可獨立完成讀取');
  gate.resolve(json(started)); await flight; await settle();
  assert.ok(el(`[data-del="${serial}-a"]`)); assert.match(text('#cashflowReadError'), /資料已刪除，畫面尚未更新/);
  await click('#modal-root [data-close]'); await deleteRow(); assert.equal(deleteCount(), 0);
  await click('#retryCashflowRead'); assert.equal(el(`[data-del="${serial}-a"]`), null);
});

test('批次刪除｜舊批次重讀晚回不復活已由較新讀取關閉的窗', async () => {
  const id = await seedBankBatchManager(), gate = deferred(); failBatchReads = true; await clickBatch(id);
  batchReadQueue.push(snapshot => gate.promise.then(() => json(snapshot)));
  await click('[data-retry-bank-batches]'); failBatchReads = false;
  await clickBatch(`${serial}-batch-b`); assert.equal(batchBodies.length, 2); assert.equal(el('#modal-root .modal'), null);
  gate.resolve(); await settle(); assert.equal(el('#modal-root .modal'), null);
});

test('批次刪除｜成功新批次清單可接受同id的新確認，不永久封鎖', async () => {
  const id = await seedBankBatchManager(); failReads = true; failBatchReads = true; await clickBatch(id);
  assert.equal(rows.some(row => row.importBatch === id), false);
  rows.push({ ...fixture()[0], id: `${serial}-new-same-batch`, source: 'bank', importBatch: id });
  failBatchReads = false; await click('[data-retry-bank-batches]');
  await clickBatch(id); assert.equal(batchBodies.length, 2);
  assert.equal(rows.some(row => row.id === `${serial}-new-same-batch`), false);
});

for (const label of ['away', 'return', 'modal-closed']) test(`批次刪除｜${label}接管後晚ACK不報舊通知或多發GET`, async () => {
  const id = await seedBankBatchManager(), gate = deferred();
  batchDeleteQueue.set(id, [async () => { await gate.promise; return json({ ok: true, removed: removeBankBatchRows(id) }); }]);
  await clickBatch(id);
  if (label === 'modal-closed') { app.openInfo('新窗', '<p>新窗已開過</p>'); await click('#modal-root [data-close]'); }
  else { await navigate('#cards'); if (label === 'return') await navigate('#cashflow'); }
  const mainBefore = reads(), batchBefore = batchReads(), rootBefore = el('#modal-root').innerHTML;
  gate.resolve(); await settle();
  assert.equal(rows.some(row => row.importBatch === id), false); assert.equal(reads(), mainBefore); assert.equal(batchReads(), batchBefore);
  assert.equal(el('#modal-root').innerHTML, rootBefore); assert.doesNotMatch(text('#toast-root'), /已刪除/);
  if (label === 'return') assert.match(text('#cashflowReadError'), /資料已刪除/);
});

test('批次刪除｜確認返回期間換窗，零POST且不覆蓋新輸入', async () => {
  const id = await seedBankBatchManager(), before = structuredClone(rows);
  window.confirm = () => { app.openInfo('確認期間接管', '<input id="batch-confirm-input" value="未存">'); return true; };
  await clickBatch(id); assert.equal(batchBodies.length, 0); assert.deepEqual(rows, before);
  assert.equal(el('#batch-confirm-input').value, '未存');
});

test('批次刪除｜重複批次控制項不猜要刪哪列', async () => {
  const id = await seedBankBatchManager(), button = batchButton(id), row = button.closest('tr');
  row.parentElement.append(row.cloneNode(true)); button.click(); await settle();
  assert.equal(batchBodies.length, 0); assert.ok(rows.some(item => item.importBatch === id));
});

for (const [label, response] of [['object', {}], ['null', null], ['null-row', [null]], ['number-id', [{ batchId: 2 }]]]) {
  test(`批次刪除｜初讀${label}不完整回應不造空批次窗`, async () => {
    Object.assign(rows[0], { source: 'bank', importBatch: `${serial}-malformed` }); await renderCashflow();
    batchReadQueue.push(() => json(response)); await click('#bankBatches');
    assert.equal(el('#modal-root .modal'), null); assert.match(text('#toast-root'), /匯入紀錄回應不完整/);
    assert.equal(batchBodies.length, 0);
  });
}

test('批次刪除｜後續批次讀取不完整保留舊表，不冒稱已清空', async () => {
  const id = await seedBankBatchManager(), dialog = el('#modal-root .modal'); batchReadQueue.push(() => json([null]));
  await clickBatch(id); assert.equal(el('#modal-root .modal'), dialog); assert.ok(batchButton(id));
  assert.match(text('[data-bank-batch-notice]'), /資料已刪除，匯入紀錄尚未更新.*匯入紀錄回應不完整/);
});

test('批次刪除｜批次錯誤文字跳脫，不注入圖片', async () => {
  const id = await seedBankBatchManager(); failBatchReads = true; await clickBatch(id);
  assert.match(text('[data-bank-batch-notice]'), /<img src=x onerror=alert\(1\)>/);
  assert.equal(el('[data-bank-batch-notice] img'), null);
});

for (const confirmed of [false, true]) test(`批次刪除｜${confirmed ? '確認' : '未知'}結果使等待期間開的編輯快照失效`, async () => {
  const id = await seedBankBatchManager(), gate = deferred();
  batchDeleteQueue.set(id, [async () => { await gate.promise; const removed = removeBankBatchRows(id); return json(confirmed ? { ok: true, removed } : { ok: 'true' }); }]);
  await clickBatch(id); await click(`tbody [data-edit="${serial}-b"]`); el('#f_summary').value = '本題保留輸入';
  gate.resolve(); await settle();
  const submitForm = async () => { el('#modal-root form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(); };
  await submitForm(); assert.equal(writes().filter(call => call.method === 'PUT').length, 0);
  assert.equal(el('#f_summary').value, '本題保留輸入'); assert.match(text('#toast-root'), /資料已更新；請關閉編輯視窗，重新讀取後再編輯。/);
  await renderCashflow(); await submitForm(); assert.equal(writes().filter(call => call.method === 'PUT').length, 0);
  await click('#modal-root [data-cancel]'); await click(`tbody [data-edit="${serial}-b"]`); el('#f_summary').value = '本題新快照';
  await submitForm(); assert.equal(writes().filter(call => call.method === 'PUT').length, 1);
  assert.equal(rows.find(row => row.id === `${serial}-b`).summary, '本題新快照');
});

test('批次刪除｜重試在途確認取消回焦，但原GET仍完成且不重送', async t => {
  retryFocusEnvironment(t);
  const id = await seedBankBatchManager(), write = deferred(), read = deferred();
  batchDeleteQueue.set(id, [async () => { await write.promise; return json({ ok: true, removed: removeBankBatchRows(id) }); }]);
  await clickBatch(id); await click('#modal-root [data-close]'); failReads = true; await renderCashflow();
  const button = el('#retryCashflowRead'); button.focus(); disableBlurs(button);
  readQueue.push(snapshot => read.promise.then(() => json(snapshot)));
  const before = reads(); button.click(); await settle(); write.resolve(); await settle();
  assert.equal(el('#retryCashflowRead').disabled, true); assert.equal(reads(), before + 1);
  read.resolve(); await settle();
  assert.match(text('#cashflowReadError'), /資料已刪除/); assert.equal(document.activeElement, document.body);
  assert.equal(batchBodies.length, 1); failReads = false; await click('#retryCashflowRead');
  assert.equal(el('#cashflowReadError'), null);
});

test('批次刪除｜另一批確認取消不淘汰已接受作業的讀取', async () => {
  const id = await seedBankBatchManager(), gate = deferred();
  batchDeleteQueue.set(id, [async () => { await gate.promise; return json({ ok: true, removed: removeBankBatchRows(id) }); }]);
  await clickBatch(id); window.confirm = () => false; await clickBatch(`${serial}-batch-b`);
  const mainBefore = reads(), batchBefore = batchReads(); gate.resolve(); await settle();
  assert.equal(batchBodies.length, 1); assert.equal(reads(), mainBefore + 1); assert.equal(batchReads(), batchBefore + 1);
  assert.equal(batchButton(id), undefined);
});

test('批次刪除｜舊callback在兩域有效重讀及確認紀錄清理後不能復活', async () => {
  const id = await seedBankBatchManager(), button = batchButton(id), callback = button.onclick;
  failReads = true; failBatchReads = true; await clickBatch(id);
  failReads = false; await click('#retryCashflowRead'); failBatchReads = false; await click('[data-retry-bank-batches]');
  callback(); await settle(); assert.equal(batchBodies.length, 1); assert.equal(button.isConnected, false);
  assert.equal(batchButton(id), undefined);
});

test('批次刪除｜失敗窗的重試鈕斷開後，保存callback不多發GET', async () => {
  const id = await seedBankBatchManager(); failBatchReads = true; await clickBatch(id);
  const button = el('[data-retry-bank-batches]'), callback = button.onclick, before = batchReads();
  button.replaceWith(button.cloneNode(true)); callback(); await settle();
  assert.equal(batchReads(), before); assert.equal(batchBodies.length, 1);
});

test('批次刪除｜pending通知同步開新窗，不啟動原作業的額外GET', async t => {
  const id = await seedBankBatchManager(), node = el('.cashflow-workspace'), insert = node.insertBefore.bind(node);
  let fired = false;
  t.mock.method(node, 'insertBefore', function (child, anchor) {
    const result = insert(child, anchor);
    if (!fired && child.id === 'cashflowReadError') { fired = true; app.openInfo('本題接管', '<input id="batch-reentry-input" value="未存">'); }
    return result;
  });
  const mainBefore = reads(), batchBefore = batchReads(); await clickBatch(id);
  assert.equal(rows.some(row => row.importBatch === id), false); assert.equal(fired, true);
  assert.equal(reads(), mainBefore); assert.equal(batchReads(), batchBefore); assert.equal(el('#batch-reentry-input').value, '未存');
});

test('批次刪除｜較新批次讀取失敗時，舊ACK仍不能多起讀取或通知', async () => {
  const id = await seedBankBatchManager(), other = `${serial}-batch-b`, first = deferred(), second = deferred();
  batchDeleteQueue.set(id, [async () => { await first.promise; return json({ ok: true, removed: removeBankBatchRows(id) }); }]);
  batchDeleteQueue.set(other, [async () => { await second.promise; return json({ ok: true, removed: removeBankBatchRows(other) }); }]);
  await clickBatch(id); await clickBatch(other); failReads = true; failBatchReads = true;
  second.resolve(); await settle();
  const mainBefore = reads(), batchBefore = batchReads(), toastBefore = text('#toast-root');
  assert.ok(batchButton(id)); first.resolve(); await settle();
  assert.equal(rows.some(row => row.importBatch === id || row.importBatch === other), false);
  assert.equal(reads(), mainBefore); assert.equal(batchReads(), batchBefore); assert.equal(text('#toast-root'), toastBefore);
});

test('批次刪除｜較新批次GET失敗後，舊成功不得替換保留的表格', async () => {
  const id = await seedBankBatchManager(), gate = deferred(); failBatchReads = true; await clickBatch(id);
  batchReadQueue.push(snapshot => gate.promise.then(() => json(snapshot)));
  await click('[data-retry-bank-batches]'); await clickBatch(`${serial}-batch-b`);
  const table = el('[data-bank-batch-content]').innerHTML;
  assert.equal(rows.some(row => row.importBatch === `${serial}-batch-b`), false);
  gate.resolve(); await settle();
  assert.equal(el('[data-bank-batch-content]').innerHTML, table);
  assert.match(text('[data-bank-batch-notice]'), /資料已刪除，匯入紀錄尚未更新/);
});

test('批次刪除｜原生確認同步重入也只確認與送出一次', async () => {
  const id = await seedBankBatchManager(), callback = batchButton(id).onclick; let confirms = 0;
  window.confirm = () => { confirms++; if (confirms === 1) callback(); return true; };
  await clickBatch(id);
  assert.equal(confirms, 1); assert.equal(batchBodies.length, 1);
  assert.equal(rows.some(row => row.importBatch === id), false);
});

test('批次刪除｜較新初開GET失敗，也不讓更舊回覆重新開窗', async () => {
  const id = `${serial}-initial-overlap`; Object.assign(rows[0], { source: 'bank', importBatch: id }); await renderCashflow();
  const gate = deferred(); batchReadQueue.push(snapshot => gate.promise.then(() => json(snapshot)), () => readError());
  await click('#bankBatches'); await click('#bankBatches'); assert.equal(el('#modal-root .modal'), null);
  gate.resolve(); await settle(); assert.equal(el('#modal-root .modal'), null); assert.equal(batchBodies.length, 0);
});

test('批次刪除｜另一批完成只解自己的鎖，不能重送仍在途的批次', async () => {
  const id = await seedBankBatchManager(), other = `${serial}-batch-b`, first = deferred(), second = deferred();
  batchDeleteQueue.set(id, [async () => { await first.promise; return json({ ok: true, removed: removeBankBatchRows(id) }); }]);
  batchDeleteQueue.set(other, [async () => { await second.promise; return json({ ok: true, removed: removeBankBatchRows(other) }); }]);
  try {
    await clickBatch(id); await clickBatch(other); second.resolve(); await settle();
    assert.ok(batchButton(id)); await clickBatch(id); assert.equal(batchBodies.length, 2);
  } finally { first.resolve(); second.resolve(); await settle(); }
});

test('批次刪除｜批次GET開始修訂不足時，主列表先完成也不能代清或解除舊批次保護', async () => {
  const id = await seedBankBatchManager(), other = `${serial}-batch-b`, first = deferred(), second = deferred(), batchRead = deferred();
  let snapshot;
  batchDeleteQueue.set(id, [async () => { await first.promise; return json({ ok: true, removed: removeBankBatchRows(id) }); }]);
  batchDeleteQueue.set(other, [async () => { await second.promise; return json({ ok: true, removed: removeBankBatchRows(other) }); }]);
  batchReadQueue.push(data => { snapshot = data; return batchRead.promise; });
  try {
    await clickBatch(id); await clickBatch(other); second.resolve(); await settle(); first.resolve(); await settle();
    assert.equal(rows.some(row => row.importBatch === id || row.importBatch === other), false);
    await renderCashflow(); assert.equal(el('#cashflowReadError'), null);
    batchRead.resolve(json(snapshot)); await settle();
    assert.ok(batchButton(id)); assert.match(text('[data-bank-batch-notice]'), /資料已刪除，匯入紀錄尚未更新/);
    await clickBatch(id); assert.equal(batchBodies.length, 2);
  } finally { first.resolve(); second.resolve(); batchRead.resolve(json([])); await settle(); }
});

for (const suffix of ['Desktop', '']) for (const order of ['年後月', '月後年']) {
  test(`年月連選｜${suffix || '另一組'} ${order}讀同組現值，舊回覆不蓋新期間`, async () => {
    const targetId = `${serial}-period-target`;
    rows.push({ ...rows[0], id: `${serial}-period-march`, date: '2026-03-03', amount: 333 },
      { ...rows[0], id: targetId, date: '2026-12-04', amount: 444, summary: '本題新期間內容' });
    await renderCashflow();
    await select('yearSelDesktop', '2025'); await select('monthSelDesktop', '03');
    const yearId = `yearSel${suffix}`, monthId = `monthSel${suffix}`;
    assert.ok([...document.getElementById(yearId).options].some(option => option.value === '2026'));
    assert.ok([...document.getElementById(monthId).options].some(option => option.value === '12'));
    calls = [];
    const pending = deferred(), completed = [];
    readQueue.push(async result => {
      await pending.promise;
      completed.push('舊');
      return json(result.map(row => row.id === targetId ? { ...row, summary: '本題舊回覆', amount: 999 } : row));
    }, result => { completed.push('新'); return json(result); });
    try {
      if (order === '年後月') { await select(yearId, '2026'); await select(monthId, '12'); }
      else { await select(monthId, '12'); await select(yearId, '2026'); }
      assert.equal(reads(), 2);
      assert.deepEqual(completed, ['新']);
      assert.deepEqual(snapshot().period, ['2026', '12', '2026', '12']);
      assert.deepEqual(snapshot().ids, [targetId]);
      assert.equal(el('.cashflow-summary').getAttribute('aria-label'), '2026 年 12 月銀行收支摘要');
      assert.match(el(`tbody [data-edit="${targetId}"]`).closest('tr').textContent, /本題新期間內容/);
      assert.match(el(`tbody [data-edit="${targetId}"]`).closest('tr').textContent, /444/);
      const accepted = snapshot();
      pending.resolve(); await settle();
      assert.deepEqual(completed, ['新', '舊']);
      assert.deepEqual(snapshot(), accepted);
      assert.match(el(`tbody [data-edit="${targetId}"]`).closest('tr').textContent, /本題新期間內容/);
      assert.doesNotMatch(text('#view'), /本題舊回覆/);
      assert.equal(reads(), 2); assert.equal(writes().length, 0);
    } finally { pending.resolve(); await settle(); }
  });
}

test('年月連選｜單次換年缺原月份時回退該年最新月', async () => {
  assert.deepEqual(snapshot().period, ['2025', '03', '2025', '03']);
  await select('yearSelDesktop', '2026');
  assert.deepEqual(snapshot().period, ['2026', '08', '2026', '08']);
  assert.deepEqual(snapshot().ids, [`${serial}-e`]);
  assert.equal(reads(), 1);
  await select('yearSelDesktop', '2025');
  assert.deepEqual(snapshot().period, ['2025', '12', '2025', '12']);
  assert.equal(el('.cashflow-summary').getAttribute('aria-label'), '2025 年 12 月銀行收支摘要');
  assert.equal(reads(), 2); assert.equal(writes().length, 0);
});

test('年月連選｜空資料只提供目前期間，既有選擇仍唯讀', async () => {
  const before = snapshot().period;
  rows = []; await renderCashflow(); calls = [];
  assert.deepEqual(snapshot().period, before);
  for (const id of ['yearSelDesktop', 'monthSelDesktop', 'yearSel', 'monthSel']) {
    const control = document.getElementById(id);
    assert.equal(control.options.length, 1);
    assert.equal(control.options[0].value, control.value);
  }
  await select('yearSelDesktop', before[0]); await select('monthSelDesktop', before[1]);
  assert.equal(reads(), 2); assert.equal(writes().length, 0);
  assert.deepEqual(snapshot().period, before); assert.deepEqual(snapshot().ids, []);
  assert.match(text('.cashflow-empty-state'), /尚無銀行收支/);
  assert.equal(el('#cashflowReadError'), null);
});
