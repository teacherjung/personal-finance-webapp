// 完整前端模組與隔離 LOCAL HTTP；DOM 替身不提供原生版面證據。
/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';

async function runCase() {
  const source = process.env.SETTINGS_DELETE_SOURCE, mode = process.env.SETTINGS_DELETE_MODE;
  const bank = process.env.SETTINGS_DELETE_MANAGER === 'bank';
  assert(source && fs.existsSync(source + '/public/modules/settings.js'));
  assert(['bank', 'text'].includes(process.env.SETTINGS_DELETE_MANAGER));
  assert.equal(dirname(process.env.STORE_FILE), fs.realpathSync(process.env.TMPDIR));
  assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(process.env.NOTEASY_HOSTED, '');
  const http = globalThis.fetch, timer = globalThis.setTimeout, timers = new Set();
  globalThis.fetch = async () => { throw new Error('禁止外部請求'); };
  const repo = await import(pathToFileURL(source + '/lib/repo.js'));
  const fixture = repo.emptyDb(), key = '合成<&"原文', other = '合成其他原文';
  fixture.learnedBank = { [key]: { type: 'expense', category: '合成分類' }, [other]: { type: 'income', category: '合成收入' } };
  fixture.settings.cashflowTextRules = { summary: { [key]: '', [other]: '合成新文字' }, remark: { [key]: '合成備註' } };
  fixture.transactions = [{ id: 'synthetic-preserved', date: '2026-01-01', type: 'expense', amount: 123, currency: 'TWD', category: '合成分類', note: '本題舊交易' }];
  await repo.saveDb(fixture);
  const before = structuredClone(await repo.getDb());
  const requests = [], events = [];
  let server, win, armed = false, active = 0, reads = 0, confirms = 0, readRelease;
  const endpoint = bank ? '/api/bank-learned/delete' : '/api/cashflow-text-rules/delete';
  const readPath = bank ? '/api/bank-learned' : '/api/settings';
  const selector = bank ? '[data-del]' : '[data-rule-index]';
  try {
    const { app } = await import(pathToFileURL(source + '/server.js'));
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    win = new JSDOM('<nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', { url: base + '/#settings', pretendToBeVisual: true }).window;
    for (const name of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) {
      Object.defineProperty(globalThis, name, { value: win[name], configurable: true, writable: true });
    }
    win.matchMedia = () => ({ matches: false });
    win.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
    Object.defineProperty(globalThis, 'Chart', { value: class { destroy() {} }, configurable: true });
    globalThis.setTimeout = (...args) => { const t = timer(...args); timers.add(t); return t; };
    const json = value => new Response(JSON.stringify(value), { status: 200 });
    const boot = new Map([
      ['POST /api/quotes/refresh-auto', { refreshed: false }], ['POST /api/snapshot/auto', { recorded: false, subsRolled: [] }],
      ['POST /api/backup/daily', {}], ['POST /api/accounts/reconcile-names', { changed: 0 }], ['POST /api/statement/normalize-auto', { ran: false }],
    ]);
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = init.method || 'GET';
      if (boot.has(method + ' ' + path)) return json(boot.get(method + ' ' + path));
      assert(path.startsWith('/api/'));
      assert(method === 'GET' || path === endpoint, '只允許本題刪除寫入');
      active++;
      try {
        if (method === 'POST') {
          let release;
          const gate = new Promise(resolve => { release = resolve; });
          const request = { release, response: false, body: JSON.parse(init.body) };
          requests.push(request);
          const response = mode === 'unknown-unwritten' ? json({}) : await http(base + path, init);
          assert.equal(response.status, 200);
          request.response = true;
          await gate;
          if (['other-error', 'unknown-written', 'unknown-unwritten', 'read-failure', 'read-other', 'read-hash'].includes(mode)) throw new TypeError('本題傳輸中斷');
          return response;
        }
        if (armed && path === readPath) {
          reads++;
          if (mode === 'read-failure') throw new TypeError('本題核對中斷');
          if (['read-other', 'read-hash'].includes(mode)) await new Promise(resolve => { readRelease = resolve; });
        }
        const response = await http(base + path, init);
        assert.equal(response.status, 200, path);
        return response;
      } finally { active--; }
    };
    const appModule = await import(pathToFileURL(source + '/public/app.js'));
    await appModule.bootSettled;
    const wait = async predicate => {
      for (let i = 0; i < 500; i++) {
        if (predicate()) return;
        await new Promise(resolve => timer(resolve, 5));
      }
      assert.fail('未到合成屏障：' + JSON.stringify({ active, requests: requests.length, reads }));
    };
    const entry = bank ? 'manageBankLearnedBtn' : 'manageCashflowTextRulesBtn';
    await wait(() => typeof document.getElementById(entry)?.onclick === 'function' && active === 0);
    await document.getElementById(entry).onclick();
    const modal = () => document.querySelector('#modal-root .modal');
    const notice = () => document.getElementById('toast-root').textContent;
    const buttons = () => [...modal().querySelectorAll(selector)];
    const original = modal(), oldButtons = buttons();
    assert.equal(oldButtons.length, bank ? 2 : 3);
    assert(original.textContent.includes(key), '原文以文字呈現');
    if (!bank) assert(original.textContent.includes('（空白）'));
    const newForm = () => {
      appModule.openForm({ title: '本題新窗', fields: [{ key: 'marker', label: '新輸入' }], onSubmit() {} });
      document.querySelector('#f_marker').value = '本題專屬未存值';
    };
    win.confirm = () => {
      confirms++;
      if (mode === 'confirm-window') newForm();
      if (mode === 'confirm-hash') win.history.replaceState(null, '', '#assets');
      if (mode === 'confirm-reenter' && confirms === 1) launch(oldButtons[1]);
      return !['cancel', 'cancel-retry'].includes(mode);
    };
    const launch = button => { const promise = button.onclick(); events.push(promise); return promise; };
    const expected = structuredClone(before);
    const remove = target => {
      if (bank) delete expected.learnedBank[target];
      else delete expected.settings.cashflowTextRules.summary[target];
    };
    armed = true;
    if (mode === 'hash-before') win.history.replaceState(null, '', '#assets');
    if (mode === 'row-before') oldButtons[0].remove();
    const result = launch(oldButtons[0]);
    if (['cancel', 'cancel-retry', 'confirm-window', 'confirm-hash', 'hash-before', 'row-before'].includes(mode)) {
      assert.equal(requests.length, 0, '取消或確認後失格不得送刪除');
      await result;
      assert.equal(confirms, ['hash-before', 'row-before'].includes(mode) ? 0 : 1);
      if (mode === 'cancel-retry') {
        assert(oldButtons.every(b => !b.disabled));
        win.confirm = () => { confirms++; return true; };
        const retry = launch(oldButtons[0]);
        await wait(() => requests.length === 1 && requests[0].response);
        requests[0].release(); await retry; remove(key);
        assert.equal(confirms, 2);
      }
    } else {
      await wait(() => requests.length > 0 && requests[0].response);
      assert.deepEqual(requests[0].body, bank ? { key } : { part: 'summary', key });
      if (mode !== 'unknown-unwritten') remove(key);
      if (mode === 'double') {
        launch(oldButtons[0]); launch(oldButtons[1]);
        assert.equal(requests.length, 1, '同窗同列或不同列不得重送');
        assert.equal(confirms, 1, '在途不得再確認');
        assert(oldButtons.every(b => b.disabled));
      }
      if (['other', 'other-error', 'closed'].includes(mode)) newForm();
      if (mode === 'closed') document.querySelector('[data-cancel]').click();
      if (mode === 'hash') win.history.replaceState(null, '', '#assets');
      if (mode === 'root') {
        const root = document.getElementById('modal-root');
        root.replaceWith(root.cloneNode(true));
      }
      if (mode === 'navigate-return') {
        armed = false;
        win.history.replaceState(null, '', '#assets'); await appModule.router();
        win.history.replaceState(null, '', '#settings'); await appModule.router();
        armed = true;
      }
      if (mode === 'background') { armed = false; await appModule.router(); armed = true; }
      const newer = modal(), priorNotice = notice();
      requests[0].release();
      if (['read-other', 'read-hash'].includes(mode)) {
        await wait(() => typeof readRelease === 'function');
        if (mode === 'read-other') newForm();
        else win.history.replaceState(null, '', '#assets');
        readRelease();
      }
      await result;
      if (['other', 'other-error', 'closed', 'hash', 'root', 'navigate-return'].includes(mode)) {
        assert.equal(modal(), newer, '晚回應不重開或更換後開視窗');
        assert.equal(notice(), priorNotice, '失格續行不通知');
        assert.equal(reads, 0, '失格續行不追加核對');
        if (mode.startsWith('other')) assert.equal(document.querySelector('#f_marker').value, '本題專屬未存值');
      } else if (mode === 'read-other') {
        assert.equal(document.querySelector('#f_marker').value, '本題專屬未存值');
        assert.equal(notice(), priorNotice);
      } else if (mode === 'read-hash') {
        assert.equal(modal(), original);
        assert.equal(buttons().length, oldButtons.length, '失格核對不得更新舊表格');
        assert.equal(notice(), priorNotice);
      } else {
        assert.equal(modal(), original, '有效更新應保留原視窗外殼');
        if (mode === 'read-failure') {
          assert.match(notice(), /未同步/);
          assert(buttons().every(b => b.disabled), '未同步舊列不得再刪');
        } else {
          assert.equal(buttons().length, (bank ? 2 : 3) - (mode === 'unknown-unwritten' ? 0 : 1));
          if (mode.startsWith('unknown-')) { assert.equal(reads, 1); assert.match(notice(), /核對/); }
          if (mode === 'stale-row') { await launch(oldButtons[0]); assert.equal(requests.length, 1); }
          if (mode === 'successive') {
            const second = launch(buttons()[0]);
            await wait(() => requests.length === 2 && requests[1].response);
            assert.deepEqual(requests[1].body, bank ? { key: other } : { part: 'summary', key: other });
            requests[1].release(); await second; remove(other);
            assert.equal(buttons().length, bank ? 0 : 1, '連續刪除不得復活前列或刪掉另一欄位同鍵');
          }
        }
        if (mode === 'confirm-reenter') assert.equal(confirms, 1, '確認中重入也不得再確認或寫入');
      }
      assert.equal(requests.length, mode === 'successive' ? 2 : 1);
    }
    assert.deepEqual(await repo.getDb(), expected, '刪除只改本題目標，其他規則及舊交易保存');
    console.log('SETTINGS_DELETE_CASE_PASSED');
  } finally {
    for (const request of requests) request.release();
    readRelease?.();
    await Promise.allSettled(events);
    for (const t of timers) clearTimeout(t);
    win?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

if (Object.keys(process.env).some(key => key.startsWith('SETTINGS_DELETE'))) await runCase();
