// 每個子程序由父題給一個新帳本；真表單接真 LOCAL CRUD，開機維護與歷史圖使用有限替身。
// jsdom 只證明 DOM／請求／回讀；不代表原生鍵盤、版面或本人驗收。
/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';

async function runCase() {
  const spec = JSON.parse(process.env.SUBSCRIPTION_FORM_CASE);
  const source = process.env.SUBSCRIPTION_FORM_SOURCE;
  const ownRoot = fs.realpathSync(process.env.TMPDIR);
  assert.equal(dirname(resolve(process.env.STORE_FILE)), ownRoot);
  assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(process.env.NOTEASY_HOSTED, '');
  const reportPath = resolve(process.env.SUBSCRIPTION_FORM_REPORT), nonce = process.env.SUBSCRIPTION_FORM_NONCE;
  assert.equal(reportPath, join(ownRoot, 'report.json')); assert.notEqual(reportPath, resolve(process.env.STORE_FILE));
  assert.equal(fs.existsSync(reportPath), false); assert.equal(typeof nonce, 'string'); assert(nonce.length > 0);
  const http = globalThis.fetch, timers = new Set(), originalTimer = globalThis.setTimeout;
  let server, win;
  const errors = [], calls = [], pending = new Set();
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  globalThis.fetch = async () => { throw new Error('本題不使用外部來源'); };
  const repo = await import(pathToFileURL(source + '/lib/repo.js').href);
  const original = { id: 'subject', name: '本題原名稱', amount: 137, cycle: 'monthly', status: 'active', active: true,
    since: '2026-06', nextCharge: '2099-02-28', endsOn: '', expiryDate: '', chargeAnchorDay: 31,
    considerCancel: false, ...spec.fields };
  for (const key of spec.omit || []) delete original[key];
  const control = { id: 'control', name: '本題保存對照列', amount: 29, cycle: 'monthly', status: 'active', active: true,
    since: '2026-06', nextCharge: '2099-12-01', category: '健康', card: '富邦', email: 'EIEI' };
  const db = repo.emptyDb();
  db.subscriptions = spec.mode === 'new' ? [control] : [original, control];
  db.cards = spec.noCards ? [] : [{ id: 'card-a', name: '台新', type: 'credit' }, { id: 'card-b', name: '富邦', type: 'credit' }];
  await repo.saveDb(db);
  try {
    const { app } = await import(pathToFileURL(source + '/server.js').href);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const getRows = async () => { const r = await http(base + '/api/subscriptions'); assert.equal(r.status, 200); return r.json(); };
    const seeded = await getRows();
    assert.deepEqual(seeded.map(row => row.id).sort(), db.subscriptions.map(row => row.id).sort());
    const expectedPublicCards = db.cards.map(card => ({ ...card, pdfPasswordSet: false }));
    const cardResponse = await http(base + '/api/cards'); assert.equal(cardResponse.status, 200);
    const publicCards = await cardResponse.json();
    assert.deepEqual(publicCards, expectedPublicCards, '本題卡片公開形狀；查 lib/secret-fields.js 的 projectCard，重跑訂閱表單考題');
    for (const card of publicCards) assert.equal(Object.hasOwn(card, 'pdfPassword'), false);

    if (spec.mode !== 'new') assert.deepEqual(seeded.find(r => r.id === 'subject'), original);
    assert.deepEqual(seeded.find(r => r.id === 'control'), control);
    win = new JSDOM('<!doctype html><nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', { url: base + '/#subscriptions', pretendToBeVisual: true }).window;
    for (const key of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) {
      Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
    }
    Object.defineProperty(globalThis, 'Chart', { configurable: true, value: class { destroy() {} } });
    win.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
    win.addEventListener('error', e => { errors.push(e.error?.message || e.message); e.preventDefault(); });
    globalThis.setTimeout = (...args) => { const timer = originalTimer(...args); timers.add(timer); return timer; };
    const history = [];
    for (let y = 2026; y <= new Date().getFullYear(); y++) for (let m = 1; m <= 12; m++) history.push({ id: `hist-${y}-${m}`, month: `${y}-${String(m).padStart(2, '0')}`, amount: 1 });
    const boot = new Map([
      ['POST /api/quotes/refresh-auto', { refreshed: false }], ['POST /api/snapshot/auto', { recorded: false, subsRolled: [] }],
      ['POST /api/backup/daily', {}], ['POST /api/accounts/reconcile-names', { changed: 0 }],
      ['POST /api/statement/normalize-auto', { ran: false }], ['GET /api/settings', {}], ['GET /api/mode', { hosted: false }]
    ]);
    let failNext = spec.mode === 'retry';
    globalThis.fetch = (url, init = {}) => {
      const path = String(url), method = init.method || 'GET', key = method + ' ' + path;
      const task = (async () => {
        if (boot.has(key)) return json(boot.get(key));
        if (key === 'GET /api/history') return json(history);
        assert(path === '/api/cards' && method === 'GET' || /^\/api\/subscriptions(?:\/subject)?$/.test(path), '未登記的請求：' + key);
        const call = { path, method, body: init.body ? JSON.parse(init.body) : null }; calls.push(call);
        if (failNext && method === 'PUT') { failNext = false; call.status = 503; call.transportFailure = true; return json({ error: '本題合成傳送失敗' }, 503); }
        const response = await http(base + path, init); call.status = response.status; return response;
      })();
      pending.add(task); task.then(() => pending.delete(task), e => { pending.delete(task); errors.push(e.message); });
      return task;
    };
    const appModule = await import(pathToFileURL(source + '/public/app.js').href); await appModule.bootSettled;
    const { costForMonth } = await import(pathToFileURL(source + '/public/modules/subscriptions-model.js').href);
    const query = (s) => { const element = document.querySelector(s); assert(element, s); return element; };
    const waitFor = async predicate => {
      for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(r => originalTimer(r, 10)); }
      assert.fail('表單操作沒有完成：' + JSON.stringify(errors));
    };
    await waitFor(() => document.querySelector('.subs-table [data-edit="subject"]') || spec.mode === 'new' && document.querySelector('#addSub'));
    await waitFor(() => pending.size === 0);
    assert.equal(calls.filter(c => c.method !== 'GET').length, 0, '開窗前不可寫訂閱');
    const opener = query(spec.mode === 'new' ? '#addSub' : '.subs-table [data-edit="subject"]'); opener.focus(); opener.click();
    await waitFor(() => document.querySelector('#modalForm'));
    for (const [key, value] of Object.entries(spec.display)) {
      const select = query('#f_' + key); assert.equal(select.value, value, key + ' 初選值');
      const option = [...select.options].find(o => o.value === ''); assert(option, key + ' 空選項');
      assert.equal(option.textContent, key === 'category' ? '未分類' : '未指定');
      assert.equal(select.selectedOptions.length, 1);
    }
    if (spec.expiredCard) assert.equal(query('#f_card').selectedOptions[0].textContent, spec.expiredCard + '（已失效，請更新）');
    assert.equal(document.querySelector('#modalForm img, #modalForm script'), null);
    assert.equal(document.querySelectorAll('#modalForm select').length, 5);
    const writes = () => calls.filter(c => c.method !== 'GET');
    const select = (key, value) => { const e = query('#f_' + key); e.value = value; assert.equal(e.value, value); e.dispatchEvent(new Event('change', { bubbles: true })); };
    if (spec.mode === 'cancel') {
      query('#f_name').value = '本題取消的名稱'; query('[data-cancel]').click();
      assert.equal(writes().length, 0); assert.deepEqual(await getRows(), seeded);
    } else {
      query('#f_name').value = '本題已改名稱';
      if (spec.mode === 'new') { query('#f_amount').value = '137'; query('#f_whenDate').value = '2099-02-28'; }
      for (const [key, value] of Object.entries(spec.changes || {})) select(key, value);
      if (spec.mode === 'restored') for (const [key, value] of Object.entries(spec.display)) select(key, value);
      const form = query('#modalForm'); query('#modalForm button[type="submit"]').click();
      if (spec.mode === 'retry') {
        await waitFor(() => writes().length === 1 && !query('#modalForm button[type="submit"]').disabled);
        assert.equal(query('#modalForm'), form); assert.equal(writes()[0].status, 503);
        assert.deepEqual(await getRows(), seeded, '失敗回應不算已寫入');
        for (const [key, value] of Object.entries(spec.retryChanges)) select(key, value);
        query('#modalForm button[type="submit"]').click();
      }
      await waitFor(() => !document.querySelector('#modalForm') && pending.size === 0);
      const accepted = writes().filter(c => c.status === 200); assert.equal(accepted.length, 1);
      assert.equal(writes().length, spec.mode === 'retry' ? 2 : 1);
      const sent = accepted[0]; assert.equal(sent.method, spec.mode === 'new' ? 'POST' : 'PUT');
      assert.equal(sent.body.name, '本題已改名稱');
      const rows = await getRows(), actual = rows.find(r => r.name === '本題已改名稱'); assert(actual);
      assert.equal(rows.length, spec.mode === 'new' ? seeded.length + 1 : seeded.length);
      assert.deepEqual(rows.find(r => r.id === 'control'), control);
      for (const key of ['category', 'card', 'email']) {
        const sentExpected = Object.hasOwn(spec.sent, key); assert.equal(Object.hasOwn(sent.body, key), sentExpected, key + ' PUT／POST 欄位存在性');
        if (sentExpected) assert.equal(sent.body[key], spec.sent[key]);
        const expected = sentExpected ? spec.sent : original;
        assert.equal(Object.hasOwn(actual, key), Object.hasOwn(expected, key), key + ' 回讀欄位存在性');
        assert.equal(actual[key], expected[key], key + ' 回讀原值／新值');
      }
      if (spec.mode !== 'new') for (const month of ['2026-06', '2026-10', '2099-12', '2100-01']) {
        assert.equal(costForMonth(actual, month), costForMonth(original, month), month + ' 攤提保存對照');
      }
      if (spec.mode !== 'new') for (const key of ['amount', 'cycle', 'status', 'active', 'since', 'nextCharge', 'endsOn', 'expiryDate', 'chargeAnchorDay', 'considerCancel']) {
        assert.equal(actual[key], original[key], key + ' 保存對照');
      }
    }
    assert.deepEqual(errors, []);
    return { version: 1, nonce, passed: true, name: spec.name, writes: writes(), rawRoundTrip: true };
  } finally {
    if (win) win.close();
    for (const timer of timers) clearTimeout(timer);
    globalThis.setTimeout = originalTimer; globalThis.fetch = http;
    if (server) { server.closeAllConnections(); await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())); }
  }
}
if (process.env.SUBSCRIPTION_FORM_CASE) {
  const report = await runCase();
  fs.writeFileSync(process.env.SUBSCRIPTION_FORM_REPORT, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
}
