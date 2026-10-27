// 真 LOCAL HTTP 與 DOM；啟動外連以有限替身隔離，不當原生版面證據。
/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';

async function runCase() {
  const source = process.env.TRANSFER_SAVE_SOURCE, mode = process.env.TRANSFER_SAVE_MODE;
  assert(source);
  assert(['normal', 'double', 'new', 'hash', 'unknown-written', 'unknown-unwritten', 'structure', 'cancel', 'closed', 'root', 'dirty', 'unknown-400', 'validation', 'refresh-dirty', 'refresh-new', 'refresh-hash', 'refresh-error', 'refresh-error-new', 'entry-pending', 'entry-failed', 'entry-pending-error', 'entry-failed-error', 'nav-return', 'background', 'stale-handler', 'replaced-control', 'entry-pending-same', 'entry-failed-same', 'refresh-newer'].includes(mode));
  assert.equal(dirname(process.env.STORE_FILE), fs.realpathSync(process.env.TMPDIR));
  assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(process.env.NOTEASY_HOSTED, '');
  const http = globalThis.fetch, timer = globalThis.setTimeout, timers = new Set();
  globalThis.fetch = async () => { throw Error('禁止外部請求'); };
  const repo = await import(pathToFileURL(source + '/lib/repo.js'));
  const fixture = repo.emptyDb();
  fixture.transferSubs = [{ label: '合成出', role: 'out' }, { label: '合成進', role: 'in' }, { label: '合成交割', role: 'settle' }];
  if (mode === 'structure') fixture.transactions = [
    { id: 'transfer-out', type: 'transfer', category: '內轉', subcategory: '合成出', ledger: 'cashflow', date: '2026-01-02', amount: 123, currency: 'TWD', note: '保留出備註' },
    { id: 'transfer-in', type: 'transfer', category: '內轉', subcategory: '合成進', ledger: 'cashflow', date: '2026-01-03', amount: 456, currency: 'USD', note: '保留進備註' },
    { id: 'not-transfer', type: 'expense', category: '飲食', subcategory: '外食', ledger: 'cashflow', date: '2026-01-04', amount: 789, currency: 'TWD', note: '其他交易不可改' },
  ];
  await repo.saveDb(fixture);
  const before = structuredClone(await repo.getDb());
  const requests = [], events = [];
  let server, win, active = 0, armed = false, reads = 0;
  let holdRead = false, releaseRead, readReached = false, failReopenRead = false;
  let readPath = '/api/settings';
  const endpoint = '/api/transfer-subcategories', entry = 'manageTransferSubsBtn';
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
      assert(method === 'GET' || path === endpoint, '只准內轉分類保存寫入');
      active++;
      try {
        if (method === 'POST') {
          let release;
          const gate = new Promise(resolve => { release = resolve; });
          const request = { release, response: false, body: JSON.parse(init.body) };
          requests.push(request);
          const response = mode === 'unknown-unwritten' ? json({}) : await http(base + path, init);
          assert.equal(response.status, mode === 'unknown-400' ? 400 : 200);
          request.response = true;
          await gate;
          if (['unknown-written', 'unknown-unwritten', 'entry-pending-error', 'entry-failed-error'].includes(mode)) throw new TypeError('本題傳輸中斷');
          return response;
        }
        if (armed) reads++;
        const response = await http(base + path, init);
        assert.equal(response.status, 200);
        if (path === endpoint && failReopenRead) {
          failReopenRead = false;
          throw new TypeError('本題重新核對失敗');
        }
        if (path === readPath && armed && holdRead) {
          holdRead = false;
          const gate = new Promise(resolve => { releaseRead = resolve; });
          readReached = true;
          await gate;
          if (mode.startsWith('refresh-error') || mode.startsWith('entry-failed')) throw new TypeError('本題讀取中斷');
        }
        return response;
      } finally { active--; }
    };
    const appModule = await import(pathToFileURL(source + '/public/app.js'));
    await appModule.bootSettled;
    const wait = async predicate => {
      for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => timer(resolve, 5)); }
      assert.fail('未到合成屏障：' + JSON.stringify({ active, requests: requests.length, reads }));
    };
    await wait(() => typeof document.getElementById(entry)?.onclick === 'function' && active === 0);
    await document.getElementById(entry).onclick();
    const modal = document.querySelector('#modal-root .modal');
    const input = modal.querySelector('input.tsub-name');
    const name = mode === 'unknown-400' ? '__proto__' : '本題改名<&"'; input.value = name;
    const save = modal.querySelector('#tsubSave');
    const launch = () => { const promise = save.onclick(); events.push(promise); return promise; };
    if (['stale-handler', 'replaced-control'].includes(mode)) {
      if (mode === 'stale-handler') {
        modal.querySelector('[data-cancel]').click();
        await document.getElementById(entry).onclick();
      } else {
        save.replaceWith(save.cloneNode(true));
      }
      const currentModal = document.querySelector('#modal-root .modal');
      const currentInput = currentModal.querySelector('input.tsub-name');
      currentInput.value = '本題必須保留的新輸入';
      await launch();
      assert.equal(requests.length, 0, '舊 handler 實際呼叫不得寫入');
      assert.equal(currentInput.isConnected, true);
      assert.equal(currentInput.value, '本題必須保留的新輸入');
      assert.deepEqual(await repo.getDb(), before);
      console.log('TRANSFER_SAVE_CASE_PASSED', mode);
      return;
    }
    if (mode === 'validation') {
      for (const invalid of ['', '合成進']) {
        input.value = invalid; await launch();
        assert.equal(requests.length, 0);
        assert.equal(save.disabled, false, '前端拒收後仍可修正');
      }
      input.value = name;
    }
    let expectedSubs = [{ label: name, role: 'out' }, ...before.transferSubs.slice(1)];
    if (mode === 'structure') {
      input.value = '  ' + name + '  ';
      modal.querySelector('[data-act="down"][data-i="0"]').click();
      assert.equal(modal.querySelector('input[data-i="1"]').value, '  ' + name + '  ', '重排保留輸入');
      modal.querySelector('[data-act="del"][data-i="0"]').click();
      modal.querySelector('[data-act="add"]').click();
      modal.querySelector('input[data-i="2"]').value = '內轉出';
      expectedSubs = [{ label: name, role: 'out' }, { label: '合成交割', role: 'settle' }, { label: '內轉出' }];
    }
    const pending = launch();
    await wait(() => requests[0]?.response);
    assert.deepEqual(requests[0].body, { subs: expectedSubs, renames: [{ from: '合成出', to: name }] });
    let newModal, newInput;
    if (mode === 'double') {
      launch();
      assert.equal(requests.length, 1, '在途重複事件不得再次寫入');
      assert.equal(input.readOnly, true);
      assert.equal(input.disabled, false, '草稿應可選取');
      const originalRows = modal.querySelectorAll('input.tsub-name').length;
      modal.querySelector('[data-act="add"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.equal(modal.querySelectorAll('input.tsub-name').length, originalRows, '在途結構事件不能改快照');
    }
    if (['new', 'closed'].includes(mode)) {
      modal.querySelector('[data-cancel]').click();
      await document.getElementById(entry).onclick();
      newModal = document.querySelector('#modal-root .modal');
      newInput = newModal.querySelector('input.tsub-name'); newInput.value = '本題新窗未存';
      if (mode === 'closed') newModal.querySelector('[data-cancel]').click();
    }
    if (mode === 'cancel') modal.querySelector('[data-cancel]').click();
    if (mode === 'root') {
      const replacement = document.createElement('div'); replacement.id = 'modal-root';
      document.getElementById('modal-root').replaceWith(replacement);
    }
    let background;
    if (mode === 'dirty') {
      background = document.querySelector('#view input:not([disabled]):not([readonly]):not([type="hidden"])');
      assert(background);
      background.value = background.type === 'number' ? '12345' : '本題背景未存';
      background.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    if (mode === 'hash') win.history.replaceState(null, '', '#assets');
    if (mode === 'nav-return') {
      const nav = appModule.currentNavSeq();
      win.history.replaceState(null, '', '#assets'); await appModule.router();
      win.history.replaceState(null, '', '#settings'); await appModule.router();
      assert(appModule.currentNavSeq() > nav);
    }
    if (mode === 'background') {
      const { renderSettings } = await import(pathToFileURL(source + '/public/modules/settings.js'));
      await renderSettings();
      assert.equal(document.querySelector('#modal-root .modal'), modal);
    }
    let view = document.getElementById('view').firstElementChild;
    document.getElementById('toast-root').innerHTML = '';
    armed = true;
    let newerEntry, entryToast;
    if (mode.startsWith('entry-')) {
      holdRead = true; readPath = mode.endsWith('-same') ? endpoint : '/api/categories';
      newerEntry = document.getElementById(mode.endsWith('-same') ? entry : 'manageCatsBtn').onclick(); events.push(newerEntry);
      await wait(() => readReached);
      assert.equal(reads, 1, '較新管理入口確實GET');
      if (mode.startsWith('entry-failed')) { releaseRead(); await newerEntry; }
      entryToast = document.getElementById('toast-root').textContent;
    }
    holdRead = mode.startsWith('refresh-');
    requests[0].release();
    if (holdRead) {
      await wait(() => readReached);
      assert.equal(document.querySelector('#modal-root .modal'), null, '保存成功先關自己的窗');
      if (mode === 'refresh-dirty') {
        background = document.querySelector('#view input:not([disabled]):not([readonly]):not([type="hidden"])');
        assert(background);
        background.value = background.type === 'number' ? '54321' : '本題重讀中未存';
        background.dispatchEvent(new win.Event('input', { bubbles: true }));
      }
      if (['refresh-new', 'refresh-error-new'].includes(mode)) {
        await document.getElementById(entry).onclick();
        newModal = document.querySelector('#modal-root .modal');
        newInput = newModal.querySelector('input.tsub-name'); newInput.value = '本題重讀中新窗';
      }
      if (mode === 'refresh-hash') win.history.replaceState(null, '', '#assets');
      if (mode === 'refresh-newer') {
        const { renderSettings } = await import(pathToFileURL(source + '/public/modules/settings.js'));
        await renderSettings();
        const newerView = document.getElementById('view').firstElementChild;
        assert.notEqual(newerView, view, '新呈現確實完成');
        view = newerView;
      }
      document.getElementById('toast-root').innerHTML = '';
      releaseRead();
    }
    await pending;
    if (mode.startsWith('entry-')) {
      assert.equal(document.querySelector('#modal-root .modal'), modal, '新入口意圖不得被舊回覆關窗');
      assert.equal(input.value, name);
      assert.equal(document.getElementById('toast-root').textContent, entryToast, '失格保存不得通知');
      assert.equal(reads, 1, '新入口失敗不恢復舊重讀資格');
      if (!mode.startsWith('entry-failed')) { releaseRead(); await newerEntry; }
    }
    await wait(() => active === 0);
    if (mode === 'new') {
      assert.equal(document.querySelector('#modal-root .modal'), newModal);
      assert.equal(newInput.isConnected, true, '新窗輸入節點不可被重畫移除');
      assert.equal(newInput.value, '本題新窗未存');
    }
    if (mode.startsWith('entry-')) {
      assert.equal(requests.length, 1);
    } else if (mode === 'background') {
      assert.equal(reads, 0, '背景已有新呈現不需舊保存再重讀');
      assert.equal(document.getElementById('view').firstElementChild, view);
      assert.equal(document.querySelector('#modal-root .modal'), null);
      assert.match(document.getElementById('toast-root').textContent, /已儲存/);
    } else if (mode.startsWith('refresh-')) {
      assert(readReached && reads > 0, '必須實際執行後續GET');
      assert.equal(requests.length, 1);
      assert.equal(document.getElementById('view').firstElementChild, view, '晚GET不可取代新操作所在頁');
      if (mode === 'refresh-dirty') {
        assert.equal(background.isConnected, true);
        assert.equal(background.value, background.type === 'number' ? '54321' : '本題重讀中未存');
      }
      if (newModal) {
        assert.equal(document.querySelector('#modal-root .modal'), newModal);
        assert.equal(newInput.isConnected, true);
        assert.equal(newInput.value, '本題重讀中新窗');
      }
      if (mode === 'refresh-error') assert.match(document.getElementById('toast-root').textContent, /內轉分類已儲存，畫面更新失敗/);
      else assert.equal(document.getElementById('toast-root').textContent, '', '失格晚GET不能追加通知');
    } else if (['new', 'hash', 'cancel', 'closed', 'root', 'nav-return'].includes(mode)) {
      assert.equal(reads, 0, '失格保存不得重讀其他呈現');
      assert.equal(document.getElementById('view').firstElementChild, view);
      assert.equal(document.getElementById('toast-root').textContent, '', '失格結果不得通知');
    } else if (mode === 'dirty') {
      assert.equal(reads, 0);
      assert.equal(background.isConnected, true);
      assert.equal(background.value, background.type === 'number' ? '12345' : '本題背景未存');
      assert.equal(document.getElementById('view').firstElementChild, view);
      assert.equal(document.querySelector('#modal-root .modal'), null);
    } else if (mode.startsWith('unknown-')) {
      assert.equal(input.value, name);
      assert.equal(input.readOnly, true);
      assert.equal(input.disabled, false);
      assert.equal(save.disabled, true);
      assert.equal(reads, 0);
      assert.match(document.getElementById('toast-root').textContent, /尚未確認/);
      const again = launch(); assert.equal(requests.length, 1, '未知不可重送'); await again;
      modal.querySelector('[data-cancel]').click();
      if (mode === 'unknown-written') {
        failReopenRead = true;
        const beforeReads = reads;
        await document.getElementById(entry).onclick();
        assert.equal(failReopenRead, false, '核對必須真正讀取並失敗');
        assert.equal(reads, beforeReads + 1);
        assert.equal(document.querySelector('#modal-root .modal'), null);
        assert.match(document.getElementById('toast-root').textContent, /本題重新核對失敗/);
        assert.equal(requests.length, 1, '核對失敗不得再送保存');
      }
      await document.getElementById(entry).onclick();
      assert.equal(document.querySelector('input.tsub-name').value, mode === 'unknown-written' ? name : '合成出');
    } else {
      assert.equal(document.querySelector('#modal-root .modal'), null);
      assert(reads > 0, '正常成功需重讀');
    }
    const after = await repo.getDb();
    assert.deepEqual(after.transferSubs, ['unknown-unwritten', 'unknown-400'].includes(mode) ? before.transferSubs : requests[0].body.subs);
    assert.deepEqual(after.transactions, mode === 'structure' ? before.transactions.map(tx => tx.id === 'transfer-out'
      ? { ...tx, subcategory: name } : tx.id === 'transfer-in' ? { ...tx, subcategory: '' } : tx) : before.transactions);
    assert.deepEqual(after.settings.expenseTree, before.settings.expenseTree);
    assert.deepEqual(after.settings.incomeTree, before.settings.incomeTree);
    console.log('TRANSFER_SAVE_CASE_PASSED', mode);
  } finally {
    releaseRead?.();
    requests.forEach(r => r.release());
    await Promise.allSettled(events);
    for (const t of timers) clearTimeout(t);
    win?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
if (Object.keys(process.env).some(key => key.startsWith('TRANSFER_SAVE'))) await runCase();
