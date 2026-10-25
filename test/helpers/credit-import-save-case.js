// 合成 XLSX 經正式上傳與 LOCAL HTTP；jsdom 不代替原生瀏覽器驗收。
/* global document, window */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import * as XLSX from 'xlsx';

async function runCase() {
  const spec = JSON.parse(process.env.CREDIT_SAVE_CASE), source = process.env.CREDIT_SAVE_SOURCE;
  const root = fs.realpathSync(process.env.TMPDIR), reportPath = process.env.CREDIT_SAVE_REPORT;
  assert.equal(dirname(resolve(process.env.STORE_FILE)), root); assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(process.env.NOTEASY_HOSTED, ''); assert.equal(reportPath, join(root, 'report.json')); assert.equal(fs.existsSync(reportPath), false);
  const http = globalThis.fetch, originalTimer = globalThis.setTimeout, timers = new Set();
  let server, win, postSeen = false, getSeen = false, holdRead = false, failedOnce = false;
  let releasePost, releaseGet, releaseNewGet, newReadSeen = false, armNewRead = false;
  const postBarrier = new Promise(r => { releasePost = r; }), getBarrier = new Promise(r => { releaseGet = r; });
  const newGetBarrier = new Promise(r => { releaseNewGet = r; });
  let holdCards = false, cardsSeen = false, releaseCards, cardsReserved;
  const cardsBarrier = new Promise(r => { releaseCards = r; });
  let backgroundCards, pickerCards, backgroundReached = false, releaseBackground, releasePicker;
  const backgroundBarrier = new Promise(r => { releaseBackground = r; });
  const pickerBarrier = new Promise(r => { releasePicker = r; });
  let reassignSeen = false, releaseReassign;
  const reassignBarrier = new Promise(r => { releaseReassign = r; });
  const calls = [], pending = new Set(), errors = [], events = [];
  const heldRequests = new Set();
  const hold = async promise => { const token = {}; heldRequests.add(token); try { await promise; } finally { heldRequests.delete(token); } };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  globalThis.fetch = async () => { throw new Error('本題禁止外部來源'); };
  const repo = await import(pathToFileURL(source + '/lib/repo.js').href);
  const db = repo.emptyDb();
  db.transactions = [];
  db.cards = [
    { id: 'card1', name: '合成卡甲', type: 'credit', issuer: '台新銀行', lastFour: '1234' },
    { id: 'card2', name: '合成卡乙', type: 'credit', issuer: '台新銀行', lastFour: '5678' }
  ];
  await repo.saveDb(db);
  try {
    const { app } = await import(pathToFileURL(source + '/server.js').href);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    win = new JSDOM('<!doctype html><nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', { url: base + '/#transactions', pretendToBeVisual: true }).window;
    for (const key of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle', 'FileReader', 'File']) {
      Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
    }
    win.matchMedia = () => ({ matches: false });
    win.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
    Object.defineProperty(globalThis, 'Chart', { configurable: true, value: class { destroy() {} } });
    win.addEventListener('error', e => { errors.push(e.error?.message || e.message); e.preventDefault(); });
    globalThis.setTimeout = (...args) => { const timer = originalTimer(...args); timers.add(timer); return timer; };
    const bootReplies = new Map([
      ['POST /api/quotes/refresh-auto', { refreshed: false }], ['POST /api/snapshot/auto', { recorded: false, subsRolled: [] }],
      ['POST /api/backup/daily', {}], ['POST /api/accounts/reconcile-names', { changed: 0 }], ['POST /api/statement/normalize-auto', { ran: false }]
    ]);
    globalThis.fetch = (url, init = {}) => {
      const path = String(url), method = init.method || 'GET', key = method + ' ' + path;
      const task = (async () => {
        if (bootReplies.has(key)) return json(bootReplies.get(key));
        assert(path.startsWith('/api/'), '拒絕外部來源');
        const call = { path, method, body: init.body ? JSON.parse(init.body) : null }; calls.push(call);
        // 回覆順序不能替換已選定的載卡請求，否則背景列表會收到別人的合成錯誤。
        const targetCards = path === '/api/cards' && holdCards && !cardsReserved;
        if (targetCards) cardsReserved = call;
        if (spec.delayedBackgroundCards && path === '/api/cards') {
          if (holdRead && !holdCards && !backgroundCards) backgroundCards = call;
          if (holdCards && !pickerCards) pickerCards = call;
        }
        const isImport = method === 'POST' && /\/cards\/[^/]+\/statement\/import$/.test(path);
        const isReparse = method === 'POST' && /\/cards\/[^/]+\/statement\/preview$/.test(path);
        const isReassign = method === 'POST' && path === '/api/statement/reassign';
        assert(method === 'GET' || isImport || isReparse || isReassign || path === '/api/statement/preview', '拒絕非本題寫入');
        const failing = isReassign && spec.reassignFailure || (isImport || isReparse) && (spec.outcome === 'failure' || !failedOnce && ['retry', 'retry-reparse'].includes(spec.mode));
        if (failing) failedOnce = true;
        const response = failing
          ? json({ error: '本題合成請求失敗' }, 503) : await http(base + path, init);
        call.status = response.status;
        if (call === backgroundCards) { await hold(backgroundBarrier); backgroundReached = true; }
        if (call === pickerCards) await hold(pickerBarrier);
        if (isReassign && spec.postAction) { reassignSeen = true; await hold(reassignBarrier); }
        if (targetCards) {
          cardsSeen = true; await hold(cardsBarrier);
          if (spec.loadFailure) return json({ error: '本題合成載卡失敗' }, 503);
        }
        if (isImport) call.response = await response.clone().json();
        if (isImport || isReparse) {
          postSeen = true; await hold(postBarrier);
          if (isImport && ['read-error', 'stale-read', 'done-read'].includes(spec.mode)) holdRead = true;
        }
        if (path === '/api/transactions' && method === 'GET' && armNewRead && !newReadSeen) {
          newReadSeen = true; await hold(newGetBarrier);
          if (spec.cancelRefreshError) return json({ error: '本題合成取消後重讀失敗' }, 503);
        } else if (path === '/api/transactions' && method === 'GET' && holdRead) {
          holdRead = false; getSeen = true; await hold(getBarrier);
          if (spec.mode === 'read-error' || spec.refreshError) return json({ error: '本題合成重讀失敗' }, 503);
        }
        return response;
      })();
      pending.add(task); task.then(() => pending.delete(task), e => { pending.delete(task); errors.push(e.message); }); return task;
    };
    const appModule = await import(pathToFileURL(source + '/public/app.js').href); await appModule.bootSettled;
    const el = s => document.querySelector(s), query = s => { const n = el(s); assert(n, s); return n; };
    const waitFor = async predicate => { for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(r => originalTimer(r, 10)); } assert.fail('操作未完成：' + JSON.stringify(errors) + document.querySelector('#modal-root')?.textContent); };
    const settle = async () => { await new Promise(r => win.requestAnimationFrame(r)); for (let n = 0; n < 4; n++) await new Promise(r => originalTimer(r, 0)); };
    const navigate = async hash => { const seq = appModule.currentNavSeq(); window.location.hash = hash; await waitFor(() => appModule.currentNavSeq() > seq && !el('#view .loading')); await waitFor(() => pending.size <= heldRequests.size); await settle(); };
    const alterContext = async action => {
      if (action === 'cancel') query('[data-cancel]').click();
      if (action === 'x') query('#modal-root .x-close').click();
      if (action === 'escape') document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (action === 'other' || action === 'opened-closed') {
        appModule.openForm({ title: '合成新表單', fields: [{ key: 'marker', label: '新輸入' }], onSubmit() {} });
        await settle(); query('#f_marker').value = '本題未存輸入'; query('#f_marker').focus();
        if (action === 'opened-closed') query('[data-cancel]').click();
      }
      if (action === 'navigate' || action === 'return') { await navigate('#cards'); if (action === 'return') await navigate('#transactions'); }
      if (action === 'background') await appModule.router();
      if (action === 'hash-now') window.history.replaceState(null, '', '#cards');
      await settle();
    };
    await waitFor(() => el('.credit-workspace') && pending.size === 0);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['台新銀行 2026/02 信用卡明細'], ['帳單結帳日：115/01/04', '', '繳款截止日：115/01/20'],
      ['本期應繳總金額', '', 'NT$450'], ['卡號末四碼 1234'], ['消費日', '入帳日', '說明', '', '金額', '', '', '外幣'],
      ['2026/01/02', '2026/01/03', '星巴克', '', '150', '', '', ''], ['2026/01/05', '2026/01/06', '全聯', '', '300', '', '', '']
    ]), '帳單');
    const file = new win.File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'synthetic.xlsx');
    const workflow = await import(pathToFileURL(source + '/public/modules/transactions-import.js').href);
    const openPreview = async () => {
      await workflow.openStatementUpload();
      const inp = query('#f_file'); Object.defineProperty(inp, 'files', { value: [file] }); inp.onchange();
      await query('#modal-root form').onsubmit({ preventDefault() {} });
      await waitFor(() => el('#doImport'));
    };
    await openPreview();
    assert.equal(query('#previewCard').value, 'card1'); assert.equal(document.querySelectorAll('input[data-row]:checked').length, 2);
    const dialog = query('#modal-root .modal'), save = query('#doImport'), submit = save.onclick;
    const select = query('#previewCard'), change = select.onchange, sort = query('#pvSortNote').onclick;
    const imports = () => calls.filter(c => /\/statement\/import$/.test(c.path));
    const reparses = () => calls.filter(c => /\/cards\/[^/]+\/statement\/preview$/.test(c.path));
    if (spec.mode === 'render-entry') {
      const { renderTransactions } = await import(pathToFileURL(source + '/public/modules/transactions.js').href);
      const rendering = renderTransactions(), count = calls.length;
      await renderTransactions(() => false); assert.equal(calls.length, count);
      const page = query('#view').firstElementChild; await rendering; assert.notEqual(query('#view').firstElementChild, page, '過期入口不能撤銷另一個有效重畫');
      return { nonce: process.env.CREDIT_SAVE_NONCE, name: spec.name, passed: true, realHttp: true };
    }
    let activeSubmit = submit;
    if (['sort', 'retry', 'retry-reparse'].includes(spec.mode)) {
      query('input[data-row="1"]').checked = false;
      const cat = query('select[data-cat="0"]');
      const option = [...cat.options].find(o => o.value !== cat.value); assert(option); cat.value = option.value;
      if (spec.mode === 'sort') {
        const category = cat.value;
        for (let n = 0; n < 3; n++) query('#pvSortNote').onclick();
        assert.equal(query('input[data-row="1"]').checked, false); assert.equal(query('select[data-cat="0"]').value, category);
        await submit(); await change({ target: select }); sort();
        assert.equal(imports().length, 0); assert.equal(reparses().length, 0);
        activeSubmit = query('#doImport').onclick;
      }
    }
    const reparse = spec.operation === 'reparse' || ['reparse', 'retry-reparse'].includes(spec.mode);
    if (reparse) select.value = 'card2';
    const work = reparse ? change({ target: select }) : activeSubmit();
    events.push(work);
    await waitFor(() => postSeen);
    if (spec.mode === 'normal' || spec.mode === 'reparse') {
      const duplicate = submit(); sort();
      events.push(duplicate);
      duplicate.catch(e => errors.push(e.message));
      assert.equal(query('#modal-root .modal'), dialog, '在途不能排序重建預覽');
      assert.equal(imports().length, reparse ? 0 : 1, '入口互斥不只靠 disabled');
      assert.equal(save.disabled, true); assert.equal(select.disabled, true);
      select.value = 'card2';
      const secondChange = change({ target: select }); secondChange.catch(e => errors.push(e.message));
      events.push(secondChange);
      assert.equal(reparses().length, reparse ? 1 : 0);
    }
    if (spec.mode === 'background') await appModule.router();
    if (spec.mode === 'independent') {
      const savedRows = await (await http(base + '/api/transactions')).json(); assert.equal(savedRows.length, 2);
      query('[data-cancel]').click(); await openPreview();
      document.querySelectorAll('input[data-row]').forEach(cb => { if (!cb.disabled) cb.checked = true; });
      const nextWork = query('#doImport').onclick(); events.push(nextWork); await waitFor(() => imports().length === 2);
      releasePost(); await Promise.all([work, nextWork]); await waitFor(() => pending.size === 0); await settle();
      assert.equal(imports().length, 2); assert.equal(imports()[1].status, 200);
      assert.equal(imports()[1].response.imported, 0); assert.equal(imports()[1].response.skipped, 2);
      assert.equal(el('#modal-root .modal'), null); assert.match(query('#toast-root').textContent, /沒有新增任何項目/);
      assert.doesNotMatch(query('#toast-root').textContent, /匯入失敗/);
      assert.deepEqual(await (await http(base + '/api/transactions')).json(), savedRows, '取消不撤回已完成保存；重送由既有去重判準略過');
      assert.deepEqual(errors, []); return { nonce: process.env.CREDIT_SAVE_NONCE, name: spec.name, passed: true, realHttp: true };
    }
    if (spec.mode === 'stale') {
      await alterContext(spec.action);
      const page = query('#view').firstElementChild, modal = el('#modal-root .modal'), text = query('#toast-root').textContent;
      const count = calls.length;
      releasePost(); await work; await waitFor(() => pending.size === 0); await settle();
      assert.equal(el('#modal-root .modal'), modal, '舊回應不可換掉目前彈窗'); assert.equal(query('#view').firstElementChild, page);
      assert.equal(query('#toast-root').textContent, text); assert.equal(calls.length, count, '過期回應不能發列表重讀');
      if (spec.action === 'other') assert.equal(query('#f_marker').value, '本題未存輸入');
    } else {
      releasePost();
      if (['read-error', 'stale-read', 'done-read'].includes(spec.mode)) {
        await waitFor(() => getSeen);
        if (spec.mode === 'done-read') {
          assert.equal(query('#modal-root h2').textContent, '匯入完成');
          let staleDismiss = query('#modal-root [data-done]').onclick;
          if (spec.beforeClose) await alterContext(spec.beforeClose);
          if (spec.action === 'done') query('#modal-root [data-done]').click();
          else if (spec.action === 'reassign') {
            if (spec.loadAction) {
              holdCards = true;
              const open = query('#modal-root [data-reassign]').onclick, loading = open(); events.push(loading);
              if (spec.delayedBackgroundCards) {
                assert(backgroundCards); assert(pickerCards); assert.notEqual(backgroundCards, pickerCards);
                assert.equal(cardsReserved, pickerCards, '入口認領只屬於稍後的改卡請求');
                releaseBackground(); await waitFor(() => backgroundReached);
                releasePicker();
              }
              await waitFor(() => cardsSeen); const count = calls.length; await open(); assert.equal(calls.length, count, '載卡在途不重送');
              const originalDialog = query('#modal-root .modal');
              await alterContext(spec.loadAction);
              const modal = el('#modal-root .modal'), text = query('#toast-root').textContent;
              if (['x', 'escape', 'opened-closed'].includes(spec.loadAction)) { assert.equal(modal, null); assert.equal(originalDialog.isConnected, false); }
              if (spec.loadAction === 'other') { assert.notEqual(modal, originalDialog); assert.equal(query('#f_marker').value, '本題未存輸入'); }
              releaseCards(); await loading; await settle();
              assert.equal(el('#modal-root .modal'), modal);
              if (spec.loadAction === 'keep') {
                assert.equal(spec.loadFailure, true);
                assert.equal(query('#toast-root').textContent, text + '本題合成載卡失敗');
              } else assert.equal(query('#toast-root').textContent, text);
              if (spec.loadAction === 'other') assert.equal(query('#f_marker').value, '本題未存輸入');
              releaseGet(); await work; await waitFor(() => pending.size === 0); await settle();
              assert.equal(el('#modal-root .modal'), modal); assert.equal(imports().length, 1);
              assert.equal(calls.filter(c => c.path === '/api/statement/reassign').length, 0);
              assert.equal((await (await http(base + '/api/transactions')).json()).length, 2);
              assert.deepEqual(errors, []);
              return { nonce: process.env.CREDIT_SAVE_NONCE, name: spec.name, passed: true, realHttp: true };
            }
            await query('#modal-root [data-reassign]').onclick();
            assert.equal(query('#modal-root h2').textContent, '整批改到其他卡片');
            staleDismiss = query('#modal-root [data-cancel]').onclick;
            if (spec.staleEntry) {
              const rows = await (await http(base + '/api/transactions')).json();
              await alterContext('hash-now');
              const modal = el('#modal-root .modal'), page = query('#view').firstElementChild, text = query('#toast-root').textContent;
              await query('#modal-root form').onsubmit({ preventDefault() {} });
              releaseGet(); await work; await waitFor(() => pending.size === 0); await settle();
              assert.equal(calls.filter(c => c.path === '/api/statement/reassign').length, 0);
              assert.equal(el('#modal-root .modal'), modal); assert.equal(query('#view').firstElementChild, page); assert.equal(query('#toast-root').textContent, text);
              assert.deepEqual(await (await http(base + '/api/transactions')).json(), rows);
              query('#modal-root [data-cancel]').click(); assert.equal(el('#modal-root .modal'), null);
              assert.deepEqual(errors, []);
              return { nonce: process.env.CREDIT_SAVE_NONCE, name: spec.name, passed: true, realHttp: true };
            }
            armNewRead = !spec.postAction || spec.postAction === 'cancel';
            if (spec.postAction) {
              const beforeReassign = await (await http(base + '/api/transactions')).json();
              const saving = query('#modal-root form').onsubmit({ preventDefault() {} }); events.push(saving);
              await waitFor(() => reassignSeen); await alterContext(spec.postAction);
              if (spec.postAction === 'cancel') { await waitFor(() => newReadSeen); releaseNewGet(); await settle(); await waitFor(() => pending.size <= heldRequests.size); }
              const modal = el('#modal-root .modal'), page = query('#view').firstElementChild, text = query('#toast-root').textContent;
              releaseReassign(); await saving; releaseGet(); await work; await waitFor(() => pending.size === 0); await settle();
              assert.equal(el('#modal-root .modal'), modal); assert.equal(query('#view').firstElementChild, page); assert.equal(query('#toast-root').textContent, text);
              const reassignCalls = calls.filter(c => c.path === '/api/statement/reassign');
              assert.equal(reassignCalls.length, 1);
              assert.deepEqual(reassignCalls[0].body, { batchId: beforeReassign[0].importBatch, toCardId: 'card2' });
              assert.equal(reassignCalls[0].status, spec.reassignFailure ? 503 : 200);
              const rows = await (await http(base + '/api/transactions')).json(); assert.equal(rows.length, 2);
              assert.deepEqual(rows, beforeReassign.map(row => spec.reassignFailure ? row : { ...row, account: '合成卡乙', stmtRef: 'card2' + row.stmtRef.slice(row.stmtRef.indexOf('|')) }), '取消不撤回已送出的改卡，其他交易內容保留');
              assert.deepEqual(errors, []);
              return { nonce: process.env.CREDIT_SAVE_NONCE, name: spec.name, passed: true, realHttp: true };
            }
            if (spec.drag) {
              const bg = query('#modal-root .modal-bg'), own = query('#modal-root .modal');
              own.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
              for (const type of ['mouseup', 'click']) bg.dispatchEvent(new win.MouseEvent(type, { bubbles: true }));
              await settle(); assert.equal(el('#modal-root .modal'), own); assert.equal(newReadSeen, false);
            }
            if (spec.closeAction === 'save') {
              const submitReassign = query('#modal-root form').onsubmit({ preventDefault() {} }); events.push(submitReassign); await submitReassign;
              assert.equal(calls.filter(c => c.path === '/api/statement/reassign').length, 1);
              if (spec.reassignFailure) { assert.equal(query('#f_toCardId').value, 'card2'); assert.equal(query('#modal-root button[type=submit]').disabled, false); query('#modal-root [data-cancel]').click(); }
            }
            else if (spec.closeAction === 'backdrop') {
              const bg = query('#modal-root .modal-bg');
              for (const type of ['mousedown', 'mouseup', 'click']) bg.dispatchEvent(new win.MouseEvent(type, { bubbles: true }));
            }
            else await alterContext(spec.closeAction);
          }
          else if (spec.action !== 'keep') await alterContext(spec.action);
          if (spec.action !== 'keep') assert.equal(el('#modal-root .modal'), null);
          if (spec.afterClose) {
            await alterContext(spec.afterClose);
            const current = el('#modal-root .modal'); staleDismiss();
            assert.equal(el('#modal-root .modal'), current, '舊完成事件不能清新窗或復活刷新');
          }
        }
        if (spec.mode === 'stale-read') await alterContext(spec.action);
        const page = query('#view').firstElementChild;
        const toast = query('#toast-root').textContent, modal = el('#modal-root .modal');
        if (spec.action === 'reassign') {
          await settle();
          assert.equal(newReadSeen, true, '有效改卡關窗必須另送列表 GET');
          assert.equal(calls.filter(c => c.path === '/api/statement/reassign').length, spec.closeAction === 'save' ? 1 : 0, '取消不發改卡 POST');
          releaseGet(); await work; await settle();
          assert.equal(query('#view').firstElementChild, page, '原匯入 GET 不得藉改卡取消復活');
          releaseNewGet();
        } else releaseGet();
        await work; await waitFor(() => pending.size === 0); await settle();
        if (spec.mode === 'stale-read' || spec.afterClose || spec.beforeClose) { assert.equal(query('#view').firstElementChild, page); assert.equal(query('#toast-root').textContent, toast); assert.equal(el('#modal-root .modal'), modal); }
        else if (spec.mode === 'done-read' && !spec.refreshError && !spec.cancelRefreshError) {
          assert.notEqual(query('#view').firstElementChild, page, '關掉本次完成窗仍須呈現已匯入的列表');
          assert.match(query('#view').textContent, /星巴克/); assert.match(query('#view').textContent, /全聯/);
          assert.equal(query('#monthSel').value, '2026-01'); assert.equal(query('#creditYearSel').value, '2026'); assert.equal(query('#creditMonthSel').value, '01');
          assert.equal(el('#modal-root .modal'), modal);
        } else { assert.match(query('#toast-root').textContent, /載入失敗|畫面更新失敗/); assert.doesNotMatch(query('#toast-root').textContent, /匯入失敗/); }
      } else { await work; await waitFor(() => pending.size === 0); await settle(); }
      if (spec.mode === 'retry') {
        assert.equal(save.disabled, false); assert.equal(query('input[data-row="1"]').checked, false);
        await submit(); await waitFor(() => pending.size === 0); await settle();
      }
      if (reparse) {
        assert.equal(query('#previewCard').value, spec.mode === 'retry-reparse' ? 'card1' : 'card2'); assert.equal(reparses().length, 1);
        if (spec.mode === 'retry-reparse') { assert.equal(save.disabled, false); assert.equal(query('input[data-row="1"]').checked, false); }
        await query('#doImport').onclick(); await waitFor(() => pending.size === 0); await settle();
      }
      await submit(); await waitFor(() => pending.size === 0);
      assert.equal(imports().length, spec.mode === 'retry' ? 2 : 1, '成功後原入口不可再次匯入');
    }
    assert.equal(reparses().length, reparse ? 1 : 0);
    assert.equal(imports().length, reparse && spec.mode === 'stale' ? 0 : spec.mode === 'retry' ? 2 : 1);
    if (imports().length) {
      assert.equal(imports()[0].path, `/api/cards/${reparse && spec.mode !== 'retry-reparse' ? 'card2' : 'card1'}/statement/import`);
      const selectedCount = ['sort', 'retry', 'retry-reparse'].includes(spec.mode) ? 1 : 2;
      assert.equal(imports()[0].body.transactions.length, selectedCount); assert.equal(imports()[0].body.statementDue, 450);
      const rows = await (await http(base + '/api/transactions')).json();
      assert.equal(rows.length, spec.outcome === 'failure' ? 0 : selectedCount);
    }
    assert.deepEqual(errors, []);
    return { nonce: process.env.CREDIT_SAVE_NONCE, name: spec.name, passed: true, realHttp: true };
  } finally {
    releaseBackground(); releasePicker(); releasePost(); releaseGet(); releaseNewGet(); releaseCards(); releaseReassign(); await Promise.allSettled(events); await Promise.allSettled([...pending]); win?.close(); for (const timer of timers) clearTimeout(timer);
    globalThis.setTimeout = originalTimer; globalThis.fetch = http;
    if (server) { server.closeAllConnections(); await new Promise((ok, fail) => server.close(e => e ? fail(e) : ok())); }
  }
}
if (process.env.CREDIT_SAVE_CASE) fs.writeFileSync(process.env.CREDIT_SAVE_REPORT, JSON.stringify(await runCase()), { flag: 'wx', mode: 0o600 });
