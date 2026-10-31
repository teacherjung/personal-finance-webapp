// 真 LOCAL HTTP 與 DOM；啟動外連以有限替身隔離，不當原生版面證據。
/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';

async function runCase() {
  const source = process.env.RULES_LIFE_SOURCE, mode = process.env.RULES_LIFE_MODE;
  const additionalMode = ['payload', 'needs-confirmation', 'intent-preflight', 'intent-save', 'intent-failure', 'preview-intent', 'refresh-new-read', 'refresh-open-close', 'unknown-reopen'].includes(mode);
  assert(source);
  assert(additionalMode || ['normal', 'double', 'preflight-new', 'preflight-hash', 'save-new', 'unknown-written', 'unknown-unwritten', 'preview-nochange', 'preview-failure', 'preview-new', 'preflight-failure', 'preview-back', 'preview-x', 'preview-escape', 'preview-back-hash', 'preview-x-hash', 'preview-escape-hash', 'preview-old-back', 'confirm-cancel', 'confirm-hash', 'confirm-accept', 'unknown-400', 'preflight-root', 'preflight-nav-return', 'background', 'dirty', 'mix-save', 'preview-mix', 'entry-same', 'entry-failure', 'entry-cross', 'entry-old', 'refresh-new', 'refresh-dirty', 'refresh-hash', 'refresh-error', 'refresh-error-new'].includes(mode));
  assert.equal(dirname(process.env.STORE_FILE), fs.realpathSync(process.env.TMPDIR));
  assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(process.env.NOTEASY_HOSTED, '');
  const http = globalThis.fetch, timer = globalThis.setTimeout, timers = new Set();
  globalThis.fetch = async () => { throw Error('禁止外部請求'); };
  const repo = await import(pathToFileURL(source + '/lib/repo.js'));
  const impact = mode.startsWith('confirm-') || /^preview-(back|x|escape|old-back)/.test(mode);
  const fixture = repo.emptyDb();
  if (impact) fixture.learnedCategories = Object.fromEntries(Array.from({ length: 53 }, (_, i) => ['合成鍵' + i, { name: '合成舊店' + i }]));
  await repo.saveDb(fixture);
  const requests = [], events = [], entries = [];
  let holdEntries = false;
  let releaseRefresh, refreshReached = false, reopenFailed = false;
  let server, win, active = 0, armed = false, reads = 0;
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
      assert(method === 'GET' || ['/api/statement/rules', '/api/statement/rules/preview'].includes(path));
      active++;
      try {
        if (method === 'POST') {
          let release;
          const gate = new Promise(resolve => { release = resolve; });
          const request = { path, release, response: false, body: JSON.parse(init.body) };
          requests.push(request);
          const save = path === '/api/statement/rules';
          // 協定分支只替代保存回覆；預檢仍走真 HTTP，不把替身當落庫證據。
          const response = save && mode === 'needs-confirmation' ? json({ needsConfirmation: true })
            : save && mode === 'unknown-unwritten' ? json({}) : await http(base + path, init);
          assert.equal(response.status, save && mode === 'unknown-400' ? 400 : 200);
          request.response = true;
          await gate;
          if (!save && ['preview-failure', 'preflight-failure'].includes(mode)) throw new TypeError('本題預檢中斷');
          if (save && ['unknown-written', 'unknown-unwritten', 'unknown-reopen'].includes(mode)) throw new TypeError('本題傳輸中斷');
          return response;
        }
        if (armed) reads++;
        if (armed && mode === 'unknown-reopen' && path === '/api/statement/rules' && !reopenFailed) {
          reopenFailed = true;
          throw new TypeError('本題重開讀取失敗');
        }
        const response = await http(base + path, init);
        assert.equal(response.status, 200);
        if (armed && mode.startsWith('refresh-') && path === '/api/settings' && !refreshReached) {
          const gate = new Promise(resolve => { releaseRefresh = resolve; });
          refreshReached = true;
          await gate;
          if (mode.startsWith('refresh-error')) throw new TypeError('本題更新中斷');
        }
        if (holdEntries && ['/api/statement/rules', '/api/categories'].includes(path)) {
          let release;
          const gate = new Promise(resolve => { release = resolve; });
          const read = { path, release };
          entries.push(read);
          await gate;
          if ((mode === 'entry-failure' && read === entries[1]) || mode === 'intent-failure') throw new TypeError('最新入口失敗');
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
    const entry = () => document.getElementById('storeRulesBtn');
    await wait(() => typeof entry()?.onclick === 'function' && active === 0);
    if (mode.startsWith('entry-')) {
      if (mode === 'entry-old') {
        const old = entry();
        const { renderSettings } = await import(pathToFileURL(source + '/public/modules/settings.js'));
        await renderSettings();
        armed = true;
        await old.onclick();
        assert.equal(reads, 0);
        assert.equal(document.querySelector('#modal-root .modal'), null);
      } else {
        holdEntries = true;
        const first = entry().onclick(); events.push(first);
        await wait(() => entries.length === 1);
        const db = await repo.getDb();
        db.settings.storeRules = { canon: [], brand: [], rename: [], chains: ['本題新規則'], parkExempt: [] };
        await repo.saveDb(db);
        const second = (mode === 'entry-cross' ? document.getElementById('manageCatsBtn') : entry()).onclick(); events.push(second);
        await wait(() => entries.length === 2);
        entries[1].release(); await second;
        const accepted = document.querySelector('#modal-root .modal');
        if (mode === 'entry-failure') assert.equal(accepted, null);
        else if (mode === 'entry-cross') assert.match(accepted.textContent, /分類/);
        else assert.equal(accepted.querySelector('input[data-rk="chains"]').value, '本題新規則');
        const notices = document.getElementById('toast-root').textContent;
        entries[0].release(); await first;
        assert.equal(document.querySelector('#modal-root .modal'), accepted, '較舊入口不能復活');
        assert.equal(document.getElementById('toast-root').textContent, notices);
        assert.equal(requests.length, 0);
      }
      console.log('RULES_LIFE_CASE_PASSED', mode);
      return;
    }
    await entry().onclick();
    const modal = document.querySelector('#modal-root .modal');
    modal.querySelector('[data-ract="add"][data-rk="rename"]').click();
    const input = modal.querySelector('input[data-rk="rename"][data-rf="match"]');
    input.value = '合成舊店';
    modal.querySelector('input[data-rk="rename"][data-rf="to"]').value = mode === 'unknown-400' ? '合成舊店x' : '本題新店<&"';
    if (impact) {
      modal.querySelector('[data-ract="add"][data-rk="brand"]').click();
      modal.querySelector('input[data-rk="brand"][data-rf="match"]').value = '半填<&"';
    }
    let expectedRules;
    if (mode === 'payload') {
      const add = key => modal.querySelector(`[data-ract="add"][data-rk="${key}"]`).click();
      const field = (key, name) => modal.querySelector(`[data-rk="${key}"][data-rf="${name}"]`);
      for (const key of ['canon', 'brand', 'chains', 'parkExempt']) {
        add(key);
        field(key, 'to').value = '  新' + key + '<&"  ';
        if (['canon', 'brand'].includes(key)) field(key, 'match').value = '  舊' + key + '  ';
      }
      field('canon', 'mode').value = 'exact';
      add('chains');
      modal.querySelector('[data-ract="del"][data-rk="chains"][data-ri="1"]').click();
      assert.equal(field('canon', 'mode').value, 'exact', '結構重畫保留比對方式');
      assert.equal(field('brand', 'to').value, '  新brand<&"  ');
      assert.equal(modal.querySelectorAll('script').length, 0);
      expectedRules = {
        canon: [{ match: '舊canon', to: '新canon<&"', mode: 'exact' }],
        brand: [{ match: '舊brand', to: '新brand<&"', mode: 'contains' }],
        rename: [{ match: '合成舊店', to: '本題新店<&"', mode: 'contains' }],
        chains: ['新chains<&"'], parkExempt: ['新parkExempt<&"'],
      };
    }
    let confirms = 0;
    globalThis.confirm = message => {
      confirms++;
      assert.match(message, /有 53 項/);
      if (mode === 'confirm-hash') win.history.replaceState(null, '', '#assets');
      return mode !== 'confirm-cancel';
    };
    const save = modal.querySelector('#ruleSave');
    const preview = modal.querySelector('#rulePreview');
    const pending = mode.startsWith('preview-') ? preview.onclick() : save.onclick(); events.push(pending);
    await wait(() => requests[0]?.response);
    assert.equal(requests[0].path, '/api/statement/rules/preview');
    if (expectedRules) assert.deepEqual(requests[0].body, { rules: expectedRules });
    if (mode.startsWith('intent-') || mode === 'preview-intent') {
      if (mode === 'intent-save') {
        requests[0].release();
        await wait(() => requests[1]?.response);
        assert.equal(requests[1].path, '/api/statement/rules');
      }
      holdEntries = true;
      const nextEntry = document.getElementById('manageCatsBtn').onclick(); events.push(nextEntry);
      await wait(() => entries.length === 1);
      assert.equal(document.querySelector('#modal-root .modal'), modal);
      if (mode === 'intent-failure') { entries[0].release(); await nextEntry; }
      const notice = document.getElementById('toast-root').textContent;
      armed = true;
      const expectedCount = mode === 'intent-save' ? 2 : 1;
      let finished = false;
      pending.then(() => { finished = true; }, () => { finished = true; });
      requests.at(-1).release();
      await wait(() => finished || requests.length > expectedCount);
      assert.equal(requests.length, expectedCount, '新管理意圖使舊預檢失格，不追加保存');
      await pending;
      assert.equal(reads, 0, '過期保存不得另啟設定重讀');
      assert.equal(document.querySelector('#modal-root .modal'), modal, '等待或失敗的新入口不能讓舊回覆關窗');
      assert.equal(input.value, '合成舊店');
      assert.equal(document.getElementById('toast-root').textContent, notice);
      entries[0].release(); await nextEntry;
      console.log('RULES_LIFE_CASE_PASSED', mode);
      return;
    }
    let newer;
    const replace = async () => {
      modal.querySelector('[data-cancel]').click();
      await entry().onclick();
      newer = document.querySelector('#modal-root .modal');
      newer.querySelector('[data-ract="add"][data-rk="chains"]').click();
      newer.querySelector('input[data-rk="chains"]').value = '新窗不可清掉';
    };
    if (mode === 'double') {
      events.push(save.onclick());
      assert.equal(requests.length, 1, '在途不可重複預檢');
      assert.equal(input.readOnly, true);
      assert.equal(input.disabled, false);
    }
    if (['mix-save', 'preview-mix'].includes(mode)) {
      events.push(mode === 'mix-save' ? preview.onclick() : save.onclick());
      assert.equal(requests.length, 1, '預覽與保存共享在途鎖');
      const count = modal.querySelectorAll('.rule-row').length;
      modal.querySelector('[data-ract="add"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.equal(modal.querySelectorAll('.rule-row').length, count);
    }
    if (['preflight-new', 'preview-new'].includes(mode)) await replace();
    if (mode === 'preflight-hash') win.history.replaceState(null, '', '#assets');
    if (mode === 'preflight-root') {
      const replacement = document.createElement('div'); replacement.id = 'modal-root';
      document.getElementById('modal-root').replaceWith(replacement);
    }
    if (mode === 'preflight-nav-return') {
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
    let draft;
    if (mode === 'dirty') {
      draft = document.querySelector('#view input:not([disabled]):not([readonly]):not([type="hidden"])');
      assert(draft);
      draft.value = draft.type === 'number' ? '12345' : '本題背景輸入';
      draft.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    requests[0].release();
    if (impact && mode.startsWith('preview-')) {
      armed = true; await pending;
      assert.equal(confirms, 0);
      const previewModal = document.querySelector('#modal-root .modal');
      assert.notEqual(previewModal, modal);
      assert.equal(previewModal.querySelector('.x-close').getAttribute('aria-label'), '回去繼續編輯', '正式預覽須提供返回名稱');
      assert.match(previewModal.textContent, /有 53 個/);
      assert.equal(previewModal.querySelectorAll('script').length, 0);
      const back = previewModal.querySelector('[data-back]').onclick;
      if (mode.endsWith('-hash')) win.history.replaceState(null, '', '#assets');
      if (mode === 'preview-old-back') {
        const { openModalShell } = await import(pathToFileURL(source + '/public/modules/modal-shell.js'));
        openModalShell({ title: '本題新窗', bodyHtml: '<input id="otherDraft" value="新的草稿" />' });
        back();
        assert.equal(document.getElementById('otherDraft').value, '新的草稿');
      } else {
        if (mode.includes('-escape')) previewModal.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else if (mode.includes('-x')) previewModal.querySelector('.x-close').click();
        else back();
        if (mode.endsWith('-hash')) assert.equal(document.querySelector('#modal-root .modal'), null);
        else {
          const returned = document.querySelector('#modal-root .modal');
          assert.notEqual(returned, previewModal);
          assert.equal(returned.querySelector('input[data-rk="brand"][data-rf="match"]')?.value, '半填<&"');
          assert.equal(returned.querySelector('input[data-rk="brand"][data-rf="to"]').value, '');
          assert.equal(returned.querySelector('input[data-rk="rename"][data-rf="to"]').value, '本題新店<&"');
        }
      }
      assert.equal(reads, 0, '返回不另讀取');
      assert.equal(requests.length, 1);
    } else if (['confirm-cancel', 'confirm-hash'].includes(mode)) {
      await Promise.race([pending, new Promise(resolve => timer(resolve, 100))]);
      assert.equal(confirms, 1);
      assert.equal(requests.length, 1, '取消或確認中失格不可保存');
      assert.equal(modal.isConnected, true);
      if (mode === 'confirm-cancel') assert.equal(save.disabled, false);
    } else if (mode.startsWith('preview-') || mode === 'preflight-failure') {
      armed = true;
      await pending;
      assert.equal(requests.length, 1, '預覽及預檢失敗不得保存');
      assert.equal(reads, 0);
      if (newer) {
        assert.equal(newer.isConnected, true);
        assert.equal(newer.querySelector('input[data-rk="chains"]').value, '新窗不可清掉');
        assert.equal(document.getElementById('toast-root').textContent, '', '失格預覽不得通知');
      } else {
        assert.equal(modal.isConnected, true);
        assert.equal(input.readOnly, false);
        assert.equal(save.disabled, false);
        assert.equal(preview.disabled, false);
        assert.match(document.getElementById('toast-root').textContent, mode.endsWith('failure') ? /本題預檢中斷/ : /不會改動/);
      }
    } else if (mode.startsWith('preflight-')) {
      await Promise.race([pending, new Promise(resolve => timer(resolve, 100))]);
      assert.equal(requests.length, 1, '失格預檢不得追加保存');
      if (newer) assert.equal(newer.querySelector('input[data-rk="chains"]').value, '新窗不可清掉');
    } else {
      await wait(() => requests[1]?.response);
      assert.equal(requests[1].path, '/api/statement/rules');
      assert.deepEqual(requests[1].body, requests[0].body);
      if (mode === 'confirm-accept') {
        assert.equal(confirms, 1);
        assert.deepEqual(requests[1].body.rules.brand, [], '半填不得送進正式payload');
      }
      if (mode === 'save-new') await replace();
      armed = true;
      requests[1].release();
      if (mode.startsWith('refresh-')) {
        await wait(() => refreshReached);
        assert.equal(modal.isConnected, false);
        let page = document.getElementById('view').firstElementChild;
        const notice = document.getElementById('toast-root').textContent;
        assert.match(notice, /規則已儲存/);
        let nextModal, field;
        if (mode.endsWith('-new')) {
          await entry().onclick();
          nextModal = document.querySelector('#modal-root .modal');
          field = nextModal.querySelector('input[data-rk="rename"]');
          field.value = '重讀期間新窗草稿';
        }
        if (mode === 'refresh-hash') win.history.replaceState(null, '', '#assets');
        if (mode === 'refresh-new-read') {
          const { renderSettings } = await import(pathToFileURL(source + '/public/modules/settings.js'));
          await renderSettings();
          assert.notEqual(document.getElementById('view').firstElementChild, page);
          page = document.getElementById('view').firstElementChild;
        }
        if (mode === 'refresh-open-close') {
          const { openModalShell } = await import(pathToFileURL(source + '/public/modules/modal-shell.js'));
          const shell = openModalShell({ title: '本題新窗', bodyHtml: '<input value="暫存" />' });
          assert(document.querySelector('#modal-root .modal'));
          shell.close();
          assert.equal(document.querySelector('#modal-root .modal'), null);
        }
        if (mode === 'refresh-dirty') {
          field = document.querySelector('#view input:not([disabled]):not([readonly]):not([type="hidden"])');
          assert(field);
          field.value = field.type === 'number' ? '54321' : '重讀期間背景草稿';
          field.dispatchEvent(new win.Event('input', { bubbles: true }));
        }
        const value = field?.value;
        releaseRefresh(); await pending;
        assert.equal(document.getElementById('view').firstElementChild, page, '失格或失敗GET不重畫');
        if (nextModal) assert.equal(document.querySelector('#modal-root .modal'), nextModal);
        if (field) { assert.equal(field.isConnected, true); assert.equal(field.value, value); }
        if (mode === 'refresh-error') assert.match(document.getElementById('toast-root').textContent, /規則已儲存，畫面更新失敗：本題更新中斷/);
        else assert.equal(document.getElementById('toast-root').textContent, notice);
        assert.equal(requests.length, 2, 'GET失敗或失格不重送POST');
        console.log('RULES_LIFE_CASE_PASSED', mode);
        return;
      }
      await pending;
      if (newer) {
        assert.equal(newer.isConnected, true, '保存晚回不可關新窗');
        assert.equal(newer.querySelector('input[data-rk="chains"]').value, '新窗不可清掉');
        assert.equal(reads, 0);
      } else if (mode === 'needs-confirmation') {
        assert.equal(modal.isConnected, true);
        assert.equal(input.value, '合成舊店');
        assert.equal(input.readOnly, false);
        assert.equal(save.disabled, false);
        assert.equal(reads, 0);
        assert.equal(requests.length, 2);
        assert.match(document.getElementById('toast-root').textContent, /這次沒有儲存/);
        assert.deepEqual((await repo.getDb()).settings.storeRules, fixture.settings.storeRules);
      } else if (mode.startsWith('unknown-')) {
        assert.equal(input.value, '合成舊店', '未知保存保留本題原草稿');
        assert.equal(input.readOnly, true);
        assert.equal(input.disabled, false);
        assert.equal(save.disabled, true);
        assert.equal(reads, 0);
        assert.match(document.getElementById('toast-root').textContent, /尚未確認/);
        await save.onclick(); assert.equal(requests.length, 2);
        modal.querySelector('[data-cancel]').click(); await entry().onclick();
        assert.equal(reads, 1, '重開必須真正讀回');
        if (mode === 'unknown-reopen') {
          assert.equal(document.querySelector('#modal-root .modal'), null);
          assert.match(document.getElementById('toast-root').textContent, /本題重開讀取失敗/);
          await entry().onclick();
          assert.equal(reads, 2, '失敗後能再發新GET');
          assert.equal(requests.length, 2, '重開不重送保存');
        }
        const value = document.querySelector('input[data-rk="rename"][data-rf="to"]')?.value;
        assert.equal(value, ['unknown-written', 'unknown-reopen'].includes(mode) ? '本題新店<&"' : undefined);
      } else {
        await wait(() => active === 0);
        assert.equal(modal.isConnected, false);
        if (['background', 'dirty'].includes(mode)) {
          assert.equal(reads, 0, '較新呈現或背景草稿不得重讀');
          if (draft) {
            assert.equal(draft.isConnected, true);
            assert.equal(draft.value, draft.type === 'number' ? '12345' : '本題背景輸入');
          }
        } else assert(reads > 0);
      }
    }
    console.log('RULES_LIFE_CASE_PASSED', mode);
  } finally {
    releaseRefresh?.();
    entries.forEach(r => r.release());
    requests.forEach(r => r.release());
    // 失敗收尾也須釋放預檢之後才建立的保存，避免測試卡在自己的屏障。
    const drain = setInterval(() => {
      requests.forEach(r => r.release());
      entries.forEach(r => r.release());
      releaseRefresh?.();
    }, 5);
    await Promise.allSettled(events); clearInterval(drain);
    for (const t of timers) clearTimeout(t);
    win?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
if (Object.keys(process.env).some(key => key.startsWith('RULES_LIFE'))) await runCase();
