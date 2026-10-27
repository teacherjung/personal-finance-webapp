// 真 DOM 與隔離 LOCAL HTTP；開機外連以有限替身隔離，不當原生版面證據。
/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';

async function runCase() {
  const source = process.env.CATEGORY_SAVE_SOURCE;
  const crossEntry = process.env.CATEGORY_SAVE_MODE?.endsWith('-cross');
  const navReturn = process.env.CATEGORY_SAVE_MODE === 'nav-return';
  const mode = navReturn ? 'hash' : crossEntry ? process.env.CATEGORY_SAVE_MODE.slice(0, -6) : process.env.CATEGORY_SAVE_MODE;
  const domain = process.env.CATEGORY_SAVE_DOMAIN;
  assert(['expense', 'income'].includes(domain));
  assert(['dirty-open', 'structure', 'root', 'normal', 'double', 'other', 'hash', 'dirty', 'cancel', 'closed', 'background', 'hash-before', 'dirty-before', 'other-error', 'unknown-written', 'unknown-unwritten', 'unknown-400', 'validation', 'entry-pending', 'entry-failed', 'entry-pending-error', 'entry-failed-error', 'unknown-reopen-failed', 'refresh-dirty', 'refresh-other', 'refresh-hash', 'refresh-failed', 'refresh-newer', 'refresh-error-other'].includes(mode));
  assert.equal(dirname(process.env.STORE_FILE), fs.realpathSync(process.env.TMPDIR));
  assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(process.env.NOTEASY_HOSTED, '');
  const http = globalThis.fetch, timer = globalThis.setTimeout, timers = new Set();
  globalThis.fetch = async () => { throw new Error('禁止外部請求'); };
  const repo = await import(pathToFileURL(source + '/lib/repo.js'));
  const fixture = repo.emptyDb();
  fixture.settings.expenseTree = { '合成支出': ['原子類'], '其他': ['未分類'] };
  fixture.settings.incomeTree = { '合成收入': ['原子類'], '其他': ['其他收入'] };
  if (mode === 'structure') {
    fixture.transactions.push(
      { id: 'category-case-expense', type: 'expense', ledger: 'cashflow', category: '合成支出', subcategory: '原子類', amount: 123, currency: 'TWD', date: '2026-01-02', note: '本題不可覆寫支出備註' },
      { id: 'category-case-income', type: 'income', ledger: 'cashflow', category: '合成收入', subcategory: '原子類', amount: 456, currency: 'USD', date: '2026-01-03', note: '本題不可覆寫收入備註' });
    fixture.learnedCategories['本題學習支出'] = { category: '合成支出', subcategory: '原子類' };
    fixture.learnedBank['本題學習收入'] = { type: 'income', category: '合成收入', subcategory: '原子類' };
  }
  await repo.saveDb(fixture);
  const before = structuredClone(await repo.getDb());
  const endpoint = domain === 'expense' ? '/api/categories' : '/api/income-categories';
  const entry = domain === 'expense' ? 'manageCatsBtn' : 'manageIncomeCatsBtn';
  const field = domain === 'expense' ? 'expenseTree' : 'incomeTree';
  const oldName = domain === 'expense' ? '合成支出' : '合成收入';
  const newName = mode === 'unknown-400' ? '__proto__' : '本題新類<&"' + domain;
  const requests = [], events = [];
  let server, win, active = 0, readsAfterSave = 0, armed = false;
  let holdRead = false, failRead = false, releaseRead, readReached = false;
  let readPath = endpoint;
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
      assert(method === 'GET' || path === endpoint, '只准本題分類保存寫入');
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
          if (['other-error', 'unknown-written', 'unknown-unwritten', 'unknown-reopen-failed', 'entry-pending-error', 'entry-failed-error'].includes(mode)) throw new TypeError('本題傳輸中斷');
          return response;
        }
        if (armed) readsAfterSave++;
        const response = await http(base + path, init);
        assert.equal(response.status, 200, path);
        if (path === readPath && holdRead) {
          holdRead = false;
          const gate = new Promise(resolve => { releaseRead = resolve; });
          readReached = true;
          await gate;
          if (failRead) throw new TypeError('本題讀取中斷');
        }
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
      assert.fail('未到合成屏障：' + JSON.stringify({ active, requests: requests.length, readsAfterSave }));
    };
    await wait(() => typeof document.getElementById(entry)?.onclick === 'function' && active === 0);
    let preserved, marker;
    const editBackground = () => {
      preserved = document.querySelector('#view input:not([type="hidden"]):not([disabled]):not([readonly])');
      assert(preserved, '需找到本題背景可編輯欄位');
      marker = preserved.type === 'number' ? '12345' : '本題背景未存';
      preserved.value = marker;
      preserved.dispatchEvent(new win.Event('input', { bubbles: true }));
    };
    if (mode === 'dirty-open') editBackground();
    await document.getElementById(entry).onclick();
    const modal = document.querySelector('#modal-root .modal');
    modal.querySelector('input.cat-name').value = newName;
    if (mode === 'structure') {
      modal.querySelector('input.cat-name').value = '  ' + newName + '  ';
      modal.querySelector('input.sub-name').value = '  子類新名  ';
      modal.querySelector('[data-act="addS"][data-p="0"]').click();
      assert.equal(modal.querySelector('input.cat-name').value, '  ' + newName + '  ', '結構重繪保留父類原輸入');
      assert.equal(modal.querySelector('input.sub-name').value, '  子類新名  ', '結構重繪保留子類原輸入');
      modal.querySelector('input.sub-name[data-p="0"][data-s="1"]').value = '本題新增子類';
      modal.querySelector('[data-act="addP"]').click();
      modal.querySelector('input.cat-name[data-p="2"]').value = '本題暫時大類';
      modal.querySelector('[data-act="delP"][data-p="2"]').click();
      modal.querySelector('[data-act="down"][data-p="0"]').click();
      assert.equal(modal.querySelector('input.cat-name[data-p="1"]').value, '  ' + newName + '  ');
      assert.equal(modal.querySelector('input.cat-name[data-p="0"]').readOnly, true, '退路名稱仍唯讀');
      assert.equal(modal.querySelector('[data-act="delP"][data-p="0"]').disabled, true, '退路不能刪');
    }
    const save = document.getElementById('catSave');
    const launch = () => { const promise = save.onclick(); events.push(promise); return promise; };
    if (mode === 'validation') {
      let input = modal.querySelector('input.cat-name');
      for (const invalid of ['', '其他']) {
        input.value = invalid;
        await launch();
        assert.equal(requests.length, 0, '空名或重名不得送出');
        assert.equal(save.disabled, false);
      }
      input.value = newName;
      modal.querySelector('[data-act="addS"][data-p="0"]').click();
      const duplicate = modal.querySelector('input.sub-name[data-p="0"][data-s="1"]');
      duplicate.value = '原子類';
      await launch();
      assert.equal(requests.length, 0, '子類重名不得送出');
      modal.querySelector('[data-act="delS"][data-p="0"][data-s="1"]').click();
      input = modal.querySelector('input.cat-name');
      assert.equal(requests.length, 0);
      assert.equal(input.disabled, false);
      assert.equal(input.readOnly, false);
      assert.equal(save.disabled, false);
      assert.equal(document.querySelector('#modal-root .modal'), modal);
      input.value = newName;
    }
    if (mode === 'dirty-before') editBackground();
    if (mode === 'hash-before') {
      win.history.replaceState(null, '', '#assets');
      const stale = launch();
      assert.equal(requests.length, 0, '換頁後原窗不能開始保存');
      await stale;
      assert.deepEqual(await repo.getDb(), before);
      console.log('CATEGORY_SAVE_CASE_PASSED', domain, mode);
      return;
    }
    armed = true;
    const pending = launch();
    await wait(() => requests.length === 1 && requests[0].response);
    assert.deepEqual(requests[0].body.parentRenames, [{ from: oldName, to: newName }]);
    const expectedSubs = mode === 'structure' ? ['子類新名', '本題新增子類'] : ['原子類'];
    assert.deepEqual(requests[0].body.subRenames, mode === 'structure' ? [{ parent: newName, from: '原子類', to: '子類新名' }] : []);
    assert.deepEqual(requests[0].body.tree[newName], expectedSubs);
    if (mode === 'structure') assert.deepEqual(Object.keys(requests[0].body.tree), ['其他', newName]);
    if (!['unknown-unwritten', 'unknown-400'].includes(mode)) assert.deepEqual((await repo.getDb()).settings[field][newName], expectedSubs);
    else assert.deepEqual(await repo.getDb(), before, '拒絕或未寫中斷不能改資料');
    if (mode === 'double') {
      launch();
      assert.equal(requests.length, 1, '保存期間不得再發 POST');
    }
    if (['other', 'other-error', 'closed'].includes(mode)) {
      appModule.openForm({ title: '本題新視窗', fields: [{ key: 'marker', label: '未存輸入' }], onSubmit() {} });
      preserved = document.getElementById('f_marker'); marker = '本題未存值'; preserved.value = marker;
      if (mode === 'closed') document.querySelector('#modal-root .x-close').click();
    }
    if (mode === 'cancel') modal.querySelector('[data-cancel]').click();
    if (mode === 'background') {
      const { renderSettings } = await import(pathToFileURL(source + '/public/modules/settings.js'));
      await renderSettings();
      readsAfterSave = 0;
      assert.equal(document.querySelector('#modal-root .modal'), modal);
    }
    if (mode === 'hash') {
      win.history.replaceState(null, '', '#assets');
      if (navReturn) {
        const oldNav = appModule.currentNavSeq();
        await appModule.router();
        assert(!document.getElementById('view').textContent.includes('載入失敗'));
        win.history.replaceState(null, '', '#settings');
        await appModule.router();
        assert(appModule.currentNavSeq() > oldNav, '實際換頁後返回須推進導航世代');
        preserved = document.getElementById(entry);
        assert(preserved && typeof preserved.onclick === 'function');
        readsAfterSave = 0;
      } else {
        document.getElementById('view').innerHTML = '<p id="new-page">本題新頁</p>';
        preserved = document.getElementById('new-page');
      }
    }
    if (mode === 'dirty') editBackground();
    if (mode === 'root') {
      const replacement = document.createElement('div'); replacement.id = 'modal-root';
      replacement.innerHTML = '<div class="modal"><input id="root-marker" value="本題根替換輸入"></div>';
      document.getElementById('modal-root').replaceWith(replacement);
      preserved = document.getElementById('root-marker'); marker = preserved.value;
    }
    let newerEntry, toastBefore;
    if (mode.startsWith('entry-')) {
      holdRead = true; failRead = mode.startsWith('entry-failed');
      const nextEntry = crossEntry ? (domain === 'expense' ? 'manageIncomeCatsBtn' : 'manageCatsBtn') : entry;
      if (crossEntry) readPath = domain === 'expense' ? '/api/income-categories' : '/api/categories';
      newerEntry = document.getElementById(nextEntry).onclick(); events.push(newerEntry);
      await wait(() => readReached);
      assert.equal(readsAfterSave, 1, '較新入口確實開始GET');
      if (failRead) { releaseRead(); await newerEntry; }
      toastBefore = document.getElementById('toast-root').textContent;
    }
    if (mode.startsWith('refresh-')) {
      readPath = '/api/settings'; holdRead = true;
      failRead = ['refresh-failed', 'refresh-error-other'].includes(mode);
      requests[0].release();
      await wait(() => readReached);
      assert.equal(document.querySelector('#modal-root .modal'), null, '成功已關原窗才開始重讀');
      assert.equal(requests.length, 1);
      if (mode === 'refresh-dirty') editBackground();
      if (['refresh-other', 'refresh-error-other'].includes(mode)) {
        appModule.openForm({ title: '重讀中新表單', fields: [{ key: 'marker', label: '未存輸入' }], onSubmit() {} });
        preserved = document.getElementById('f_marker'); marker = '重讀中本題新輸入'; preserved.value = marker;
      }
      if (mode === 'refresh-hash') {
        win.history.replaceState(null, '', '#assets');
        document.getElementById('view').innerHTML = '<p id="new-page">重讀中本題新頁</p>';
        preserved = document.getElementById('new-page');
      }
      if (mode === 'refresh-newer') {
        const { renderSettings } = await import(pathToFileURL(source + '/public/modules/settings.js'));
        await renderSettings();
        preserved = document.getElementById(entry);
      }
      toastBefore = document.getElementById('toast-root').textContent;
      releaseRead();
    } else requests[0].release();
    await pending;
    if (mode.startsWith('entry-')) {
      assert.equal(document.querySelector('#modal-root .modal'), modal, '新入口未開窗前舊回應不得關窗');
      assert.equal(modal.querySelector('input.cat-name').value, newName);
      assert.equal(document.getElementById('toast-root').textContent, toastBefore, '較新入口取得優先權後舊成功或錯誤不得通知');
      assert.equal(readsAfterSave, 1, '較新入口失敗也不恢復舊重讀資格');
      if (!failRead) {
        releaseRead(); await newerEntry;
        assert.notEqual(document.querySelector('#modal-root .modal'), modal);
        const expectedName = crossEntry ? (domain === 'expense' ? '合成收入' : '合成支出') : newName;
        assert([...document.querySelectorAll('#modal-root input.cat-name')].some(input => input.value === expectedName));
      }
    }
    await wait(() => active === 0);
    if (mode.startsWith('refresh-')) {
      if (preserved) {
        assert(preserved.isConnected, '保存後晚GET不能替換較新節點');
        if (marker) assert.equal(preserved.value, marker);
      }
      if (mode === 'refresh-failed') {
        assert(document.getElementById('toast-root').textContent.includes('分類已儲存，畫面更新失敗'));
        assert.equal(document.querySelector('#modal-root .modal'), null);
      } else assert.equal(document.getElementById('toast-root').textContent, toastBefore, '失格晚GET不能追加通知');
      assert.equal(requests.length, 1, 'GET失敗不得重送POST');
    }
    if (['normal', 'validation', 'structure'].includes(mode)) {
      assert.equal(document.querySelector('#modal-root .modal'), null);
      assert(document.getElementById('toast-root').textContent.includes('分類已儲存'));
      assert(readsAfterSave > 0, '成功應走原頁面重讀');
    }
    if (['root', 'dirty-open', 'other', 'other-error', 'hash', 'dirty', 'dirty-before'].includes(mode)) {
      assert(preserved.isConnected, '晚保存不得移除較新畫面或未存輸入節點');
      if (marker) assert.equal(preserved.value, marker);
      assert.equal(readsAfterSave, 0, '失去呈現資格不得另起舊頁重讀');
    }
    if (['cancel', 'closed', 'background'].includes(mode)) {
      assert.equal(document.querySelector('#modal-root .modal'), null);
      assert.equal(readsAfterSave, 0, '失格或較新背景呈現不得啟動舊重讀');
    }
    if (mode.startsWith('unknown-')) {
      assert.equal(document.querySelector('#modal-root .modal'), modal);
      assert.equal(modal.querySelector('input.cat-name').value, newName);
      const draftInput = modal.querySelector('input.cat-name');
      assert.equal(draftInput.disabled, false, '未知草稿文字不應停用');
      assert.equal(draftInput.readOnly, true, '未知草稿不可再改動送出快照');
      draftInput.focus(); draftInput.select();
      assert.equal(document.activeElement, draftInput);
      assert.equal(draftInput.selectionEnd - draftInput.selectionStart, newName.length);
      assert(document.getElementById('toast-root').textContent.includes('尚未確認'));
      assert.equal(readsAfterSave, 0, '未知結果不得自動重讀');
      const repeated = launch();
      assert.equal(requests.length, 1, '未知結果不得盲重送');
      await repeated;
      modal.querySelector('[data-cancel]').click();
      if (mode === 'unknown-reopen-failed') {
        holdRead = true; failRead = true;
        const reopen = document.getElementById(entry).onclick(); events.push(reopen);
        await wait(() => readReached); releaseRead(); await reopen;
        assert.equal(document.querySelector('#modal-root .modal'), null, '讀取失敗不能畫出空分類窗');
        assert(document.getElementById('toast-root').textContent.includes('讀取中斷'));
        await launch(); assert.equal(requests.length, 1, '失敗重開不能解鎖舊保存事件');
      }
      await document.getElementById(entry).onclick();
      const names = [...document.querySelectorAll('#modal-root input.cat-name')].map(input => input.value);
      assert(names.includes(['unknown-written', 'unknown-reopen-failed'].includes(mode) ? newName : oldName), '重開須以真GET核對，不猜寫入結果');
      assert.equal(requests.length, 1);
    }
    const after = await repo.getDb();
    assert.deepEqual(after.settings[domain === 'expense' ? 'incomeTree' : 'expenseTree'], before.settings[domain === 'expense' ? 'incomeTree' : 'expenseTree']);
    if (mode === 'structure') {
      const expected = before.transactions.map(tx => tx.id === 'category-case-' + domain
        ? { ...tx, category: newName, subcategory: '子類新名' } : tx);
      assert.deepEqual(after.transactions, expected, '只變指定交易分類，金額幣別備註與另一域交易保留');
      const learned = domain === 'expense' ? 'learnedCategories' : 'learnedBank';
      const key = domain === 'expense' ? '本題學習支出' : '本題學習收入';
      assert.deepEqual(after[learned][key], { ...before[learned][key], category: newName, subcategory: '子類新名' });
      const untouched = domain === 'expense' ? 'learnedBank' : 'learnedCategories';
      assert.deepEqual(after[untouched], before[untouched]);
    } else assert.deepEqual(after.transactions, before.transactions);
    console.log('CATEGORY_SAVE_CASE_PASSED', domain, mode);
  } finally {
    releaseRead?.();
    requests.forEach(r => r.release());
    await Promise.allSettled(events);
    for (const t of timers) clearTimeout(t);
    win?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
if (Object.keys(process.env).some(key => key.startsWith('CATEGORY_SAVE'))) await runCase();
