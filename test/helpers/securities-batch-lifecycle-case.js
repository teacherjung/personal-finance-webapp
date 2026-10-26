// 合成 LOCAL HTTP 與正式模組；DOM 替身不提供原生版面證據。
/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';

async function runCase() {
const source = process.env.SEC_BATCH_SOURCE;
const mode = process.env.SEC_BATCH_MODE;
assert(source && fs.existsSync(source + '/public/modules/securities.js'), '案例來源必須完整');
assert(['reverse-unknown-batch', 'reverse-unknown-page', 'reverse-unknown-batch-error', 'reverse-unknown-page-error', 'unknown-no-write', 'unknown-batch-error', 'unknown-page-error', 'confirm-reentrant', 'navigate-return', 'normal', 'boot-delayed', 'parallel', 'reverse-batch', 'reverse-page', 'revision-batch', 'revision-page', 'render-race', 'render-error', 'render-entry', 'stale-button', 'initial', 'initial-double', 'initial-new-failure', 'confirm-cancel', 'other', 'opened-closed', 'x', 'escape', 'close', 'hash-now', 'background', 'unknown', 'wrong-id', 'wrong-ok', 'bad-count', 'batch-error', 'page-error'].includes(mode), '案例模式非法');
assert(['success', 'failure'].includes(process.env.SEC_BATCH_OUTCOME), '案例結果設定非法');
const revisionCase = mode.startsWith('revision');
const multiple = mode === 'parallel' || mode.startsWith('reverse') || revisionCase;
assert.equal(dirname(process.env.STORE_FILE), fs.realpathSync(process.env.TMPDIR));
assert.equal(fs.existsSync(process.env.STORE_FILE), false);
assert.equal(process.env.NOTEASY_HOSTED, '');
const http = globalThis.fetch, timer = globalThis.setTimeout, timers = new Set();
globalThis.fetch = async () => { throw new Error('禁止外部請求'); };
const repo = await import(pathToFileURL(source + '/lib/repo.js'));
const fixture = repo.emptyDb();
fixture.securityTrades = ['taishin', 'ibkr'].map((source, i) => ({
  id: 'synthetic-' + i, source, sourceRef: 'synthetic-ref-' + i, importBatch: 'synthetic-batch-' + i,
  importedAt: '2026-01-10T00:00:00Z', tradeDate: '2026-01-10', side: 'buy', cashDirection: 'out',
  quantity: 1, currency: 'TWD', symbol: 'SYNTH' + i, price: 100, grossAmount: 100, netSettlement: 101,
  sourceAccountId: 'synthetic-account', sourceAccountLabel: '合成帳戶',
}));
if (multiple) fixture.securityTrades.push({ ...fixture.securityTrades[0], id: 'synthetic-B', sourceRef: 'synthetic-ref-B', importBatch: 'synthetic-batch-B', symbol: 'SYNTHB' });
await repo.saveDb(fixture);
const before = structuredClone(await repo.getDb());
let server, win, release, releaseSecond, releaseRead, releaseBoot;
const held = new Promise(resolve => { release = resolve; });
const secondHeld = new Promise(resolve => { releaseSecond = resolve; });
const readHeld = new Promise(resolve => { releaseRead = resolve; });
const bootHeld = new Promise(resolve => { releaseBoot = resolve; });
try {
  const { app } = await import(pathToFileURL(source + '/server.js'));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  win = new JSDOM('<nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', { url: base + '/#securities', pretendToBeVisual: true }).window;
  for (const key of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) {
    Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
  }
  win.matchMedia = () => ({ matches: false });
  win.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
  Object.defineProperty(globalThis, 'Chart', { value: class { destroy() {} }, configurable: true });
  globalThis.setTimeout = (...args) => { const t = timer(...args); timers.add(t); return t; };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const boot = new Map([
    ['POST /api/quotes/refresh-auto', { refreshed: false }], ['POST /api/snapshot/auto', { recorded: false, subsRolled: [] }],
    ['POST /api/backup/daily', {}], ['POST /api/accounts/reconcile-names', { changed: 0 }], ['POST /api/statement/normalize-auto', { ran: false }],
  ]);
  let batchCalls = 0, postCalls = 0, postReached = false, pageReadsAfterPost = 0;
  let holdPage = false, pageReserved = false, pageReached = false, requestCount = 0;
  let reverseReserved = false, reverseReached = false;
  let bootReserved = false, bootReached = false, initialReads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url), method = init.method || 'GET', key = method + ' ' + path;
    requestCount++;
    if (boot.has(key)) return json(boot.get(key));
    assert(path.startsWith('/api/'));
    const isDelete = method === 'POST' && path === '/api/securities/batch/delete';
    assert(method === 'GET' || isDelete);
    if (isDelete) postCalls++;
    const isBatch = path === '/api/securities/batches';
    const targetPage = holdPage && !pageReserved && path === '/api/securities';
    if (targetPage) pageReserved = true;
    const afterPost = postReached;
    const initialRead = !afterPost && ['/api/securities', '/api/settings'].includes(path);
    if (initialRead) initialReads++;
    if (mode === 'boot-delayed' && path === '/api/securities' && !bootReserved) {
      bootReserved = true; bootReached = true; await bootHeld;
    }
    const interleavedDomain = (mode.startsWith('reverse') || revisionCase) &&
      ((mode.includes('batch') && isBatch) || (mode.includes('page') && path === '/api/securities'));
    const reverseRead = afterPost && !reverseReserved && interleavedDomain;
    if (reverseRead) reverseReserved = true;
    if (isBatch) batchCalls++;
    const batchCall = batchCalls;
    const secondDelete = isDelete && JSON.parse(init.body).batchId === 'synthetic-batch-B';
    if (secondDelete) await secondHeld;
    if (isDelete && mode === 'unknown-no-write') {
      postReached = true;
      await held;
      throw new Error('合成：寫入前傳輸失敗');
    }
    const response = await http(base + path, init);
    if (initialRead) initialReads--;
    if (reverseRead) {
      assert.equal(response.status, 200);
      assert.match(await response.clone().text(), /synthetic-batch-B|SYNTHB/, '扣住的成功快照必須仍包含尚未寫入刪除的 B');
      reverseReached = true;
      await readHeld;
    }
    if (targetPage) {
      pageReached = true;
      await held;
      if (mode === 'render-error') return json({ error: '本題較早讀取失敗' }, 503);
    }
    if (isDelete) {
      assert.equal(response.status, 200);
      postReached = true;
      await held;
      if (secondDelete && (mode.startsWith('reverse-unknown') || (revisionCase && process.env.SEC_BATCH_OUTCOME === 'failure'))) throw new Error('合成：第二批已刪，回覆遺失');
      if (mode.startsWith('unknown') || (!revisionCase && process.env.SEC_BATCH_OUTCOME === 'failure')) throw new Error('合成：後端已刪，回應遺失');
      if (mode === 'wrong-id') return json({ ok: true, batchId: 'another-batch', deleted: 1 });
      if (mode === 'wrong-ok') return json({ ok: 'true', batchId: JSON.parse(init.body).batchId, deleted: 1 });
      if (mode === 'bad-count') return json({ ok: true, batchId: JSON.parse(init.body).batchId, deleted: -1 });
    }
    if (path === '/api/securities' && afterPost) {
      pageReadsAfterPost++;
      if (['page-error', 'unknown-page-error'].includes(mode)) return json({ error: '本題主頁重讀失敗' }, 503);
    }
    if (afterPost && interleavedDomain && !reverseRead && mode.endsWith('-error')) return json({ error: '本題較新讀取失敗' }, 503);
    if (isBatch && ['batch-error', 'unknown-batch-error'].includes(mode) && afterPost) return json({ error: '本題批次重讀失敗' }, 503);
    if (isBatch && mode.startsWith('initial')) {
      assert.equal(response.status, 200);
      if (batchCall === 1) await held;
      if (mode === 'initial-new-failure' && batchCall === 2) return json({ error: '本題新開啟失敗' }, 503);
      if (process.env.SEC_BATCH_OUTCOME === 'failure') return json({ error: '本題初載失敗' }, 503);
    }
    return response;
  };
  const appModule = await import(pathToFileURL(source + '/public/app.js'));
  await appModule.bootSettled;
  if (mode === 'boot-delayed') {
    assert(bootReached);
    assert.equal(document.querySelector('#secBatches'), null, '維護落定不等於首次畫面完成');
    assert(initialReads > 0);
    releaseBoot();
  }
  const waitForInitialPage = async () => {
    for (let i = 0; i < 500; i++) {
      const entry = document.querySelector('#secBatches');
      if (entry?.isConnected && typeof entry.onclick === 'function' && initialReads === 0) return;
      await new Promise(resolve => timer(resolve, 10));
    }
    assert.fail('首次畫面未完成：' + JSON.stringify({ initialReads, requestCount, view: document.querySelector('#view').textContent }));
  };
  await waitForInitialPage();
  if (mode === 'stale-button') {
    const oldButton = document.querySelector('#secBatches');
    assert(oldButton);
    const { renderSecurities } = await import(pathToFileURL(source + '/public/modules/securities.js'));
    await renderSecurities();
    assert.equal(oldButton.isConnected, false);
    const currentButton = document.querySelector('#secBatches');
    assert(currentButton);
    const count = requestCount;
    await oldButton.onclick();
    assert.equal(requestCount, count, '已卸載入口不得啟動批次讀取');
    assert.equal(document.querySelector('#modal-root .modal'), null);
    await currentButton.onclick();
    assert.equal(batchCalls, 1, '有效入口仍可讀取批次');
    assert(document.querySelector('#modal-root .modal'));
    assert.deepEqual(await repo.getDb(), before);
  } else if (mode.startsWith('render')) {
    const { renderSecurities } = await import(pathToFileURL(source + '/public/modules/securities.js'));
    holdPage = true;
    const older = renderSecurities({ showLoading: false });
    for (let i = 0; !pageReached && i < 200; i++) await new Promise(resolve => timer(resolve, 5));
    assert(pageReached);
    const count = requestCount, original = document.querySelector('#view').firstElementChild;
    if (mode === 'render-entry') {
      await renderSecurities({ canCommit: () => false });
      assert.equal(requestCount, count); assert.equal(document.querySelector('#view').firstElementChild, original);
      release(); await older;
      assert.notEqual(document.querySelector('#view').firstElementChild, original, '失效入口不撤銷有效讀取');
    } else {
      await renderSecurities({ showLoading: false });
      const latest = document.querySelector('#view').firstElementChild;
      assert.notEqual(latest, original);
      const notice = document.querySelector('#toast-root').textContent;
      release(); await older;
      assert.equal(document.querySelector('#view').firstElementChild, latest, '較早成功或失敗不得取代最新呈現');
      assert.equal(document.querySelector('#toast-root').textContent, notice);
    }
    assert.deepEqual(await repo.getDb(), before);
  } else {
  const start = document.querySelector('#secBatches'); assert(start);
  const pending = start.onclick();
  assert.equal(batchCalls, 1);
  const newForm = () => {
    appModule.openForm({ title: '本題新窗', fields: [{ key: 'marker', label: '新輸入' }], onSubmit() {} });
    document.querySelector('#f_marker').value = '本題專屬未存值';
    return document.querySelector('#modal-root .modal');
  };
  if (['initial-double', 'initial-new-failure'].includes(mode)) {
    await start.onclick();
    assert.equal(batchCalls, 2);
    const newest = document.querySelector('#modal-root .modal');
    if (mode === 'initial-double') assert(newest);
    else assert.equal(newest, null);
    const notice = document.querySelector('#toast-root').textContent;
    if (mode === 'initial-new-failure') assert.match(notice, /本題新開啟失敗/);
    release(); await pending;
    assert.equal(document.querySelector('#modal-root .modal'), newest, '較早開啟不得復活或取代較新開啟');
    assert.equal(document.querySelector('#toast-root').textContent, notice);
    assert.deepEqual(await repo.getDb(), before);
  } else if (mode === 'initial') {
    const newer = newForm(), toastBefore = document.querySelector('#toast-root').textContent;
    release(); await pending;
    assert.equal(document.querySelector('#modal-root .modal'), newer, '舊初載不得替換新窗');
    assert.equal(document.querySelector('#f_marker').value, '本題專屬未存值');
    assert.equal(document.querySelector('#toast-root').textContent, toastBefore, '舊初載錯誤不得接管提示');
    assert.deepEqual(await repo.getDb(), before);
  } else {
    await pending;
    const dialog = document.querySelector('#modal-root .modal');
    const button = dialog.querySelector('[data-delbatch]'); assert(button);
    assert.equal(dialog.querySelectorAll('[data-delbatch]').length, multiple ? 2 : 1, 'IBKR批次不提供刪除鈕');
    win.confirm = () => true;
    const firstButton = multiple ? dialog.querySelector('[data-delbatch="synthetic-batch-0"]') : button;
    let confirms = 0, reentered;
    if (mode === 'confirm-reentrant') win.confirm = () => {
      confirms++;
      assert.equal(confirms, 1, '確認期間重入不得再次確認');
      reentered = firstButton.onclick();
      return true;
    };
    if (mode === 'confirm-cancel') {
      win.confirm = () => false;
      await firstButton.onclick();
      assert.equal(postCalls, 0);
      assert.equal(firstButton.disabled, false);
      assert.deepEqual(await repo.getDb(), before);
      win.confirm = () => true;
    }
    if (revisionCase) {
      const oldB = dialog.querySelector('[data-delbatch="synthetic-batch-B"]');
      const oldSubmit = oldB.onclick, deletingB = oldSubmit();
      assert.equal(postCalls, 1);
      assert.deepEqual(await repo.getDb(), before, 'B 在 HTTP 前扣住，不能提早刪除');
      dialog.querySelector('[data-close]').click();
      await document.querySelector('#secBatches').onclick();
      const currentDialog = document.querySelector('#modal-root .modal');
      assert.notEqual(currentDialog, dialog);
      const deletingA = currentDialog.querySelector('[data-delbatch="synthetic-batch-0"]').onclick();
      for (let i = 0; !postReached && i < 200; i++) await new Promise(resolve => timer(resolve, 5));
      assert(postReached); release();
      for (let i = 0; !reverseReached && i < 200; i++) await new Promise(resolve => timer(resolve, 5));
      assert(reverseReached);
      const otherDomainSettled = () => mode === 'revision-page'
        ? !currentDialog.querySelector('[data-delbatch="synthetic-batch-0"]')
        : !document.querySelector('#view .loading') && !document.querySelector('#view').textContent.includes('SYNTH0');
      for (let i = 0; !otherDomainSettled() && i < 200; i++) await new Promise(resolve => timer(resolve, 5));
      assert(otherDomainSettled(), '先等另一域自身呈現完成，才量失格 B 的副作用');
      const rows = [...currentDialog.querySelector('tbody').children];
      const content = currentDialog.innerHTML, toast = document.querySelector('#toast-root').textContent;
      const requests = requestCount;
      releaseSecond(); await deletingB;
      assert.equal(requestCount, requests, '失格 B 回覆不得啟動任何新請求');
      assert.equal(document.querySelector('#modal-root .modal'), currentDialog);
      assert.equal(currentDialog.innerHTML, content);
      assert.equal(document.querySelector('#toast-root').textContent, toast);
      releaseRead(); await deletingA;
      if (mode === 'revision-batch') {
        const afterRows = [...currentDialog.querySelector('tbody').children];
        assert.equal(afterRows.length, rows.length);
        rows.forEach((row, i) => assert.equal(afterRows[i], row, '修訂過期快照不得替換現存列'));
        assert.match(document.querySelector('#toast-root').textContent, /匯入紀錄更新失敗/);
      } else {
        assert(document.querySelector('#retrySecurities'));
        assert.match(document.querySelector('#view').textContent, /資料在讀取期間有變動/);
      }
      assert.equal(batchCalls, 3); assert.equal(pageReadsAfterPost, 1); assert.equal(postCalls, 2);
      await oldSubmit(); assert.equal(postCalls, 2);
      const after = await repo.getDb();
      assert.deepEqual(after.securityTrades, before.securityTrades.filter(r => r.source === 'ibkr'));
      assert.deepEqual({ ...after, securityTrades: [] }, { ...before, securityTrades: [] });
      currentDialog.querySelector('[data-close]').click();
      if (mode === 'revision-page') {
        await document.querySelector('#retrySecurities').onclick();
        assert(!document.querySelector('#retrySecurities'));
        assert(!document.querySelector('#view').textContent.includes('SYNTHB'));
      }
      await document.querySelector('#secBatches').onclick();
      assert.equal(document.querySelectorAll('[data-delbatch]').length, 0, '有效恢復入口必須真的讀到已刪結果');
      assert.equal(batchCalls, 4);
      console.log('SEC_BATCH_CASE_PASSED');
      return;
    }
    const submit = firstButton.onclick, deleting = submit();
    for (let i = 0; !postReached && i < 200; i++) await new Promise(resolve => timer(resolve, 5));
    assert(postReached);
    if (mode === 'confirm-reentrant') { await reentered; assert.equal(confirms, 1); assert.equal(postCalls, 1); }
    if (multiple) {
      const oldSecond = dialog.querySelector('[data-delbatch="synthetic-batch-B"]');
      const secondSubmit = oldSecond.onclick, secondDeleting = secondSubmit();
      assert.equal(postCalls, 2);
      release();
      if (mode.startsWith('reverse')) {
        for (let i = 0; !reverseReached && i < 200; i++) await new Promise(resolve => timer(resolve, 5));
        assert(reverseReached, '較早重讀必須實際取得舊快照');
        releaseSecond(); await secondDeleting;
        if (mode.endsWith('batch-error')) assert.match(document.querySelector('#toast-root').textContent, /本題較新讀取失敗/);
        else assert.equal(dialog.querySelector('[data-delbatch]'), null);
        if (mode.endsWith('page-error')) assert(document.querySelector('#retrySecurities'));
        const latestTable = dialog.querySelector('tbody').innerHTML;
        const latestPage = document.querySelector('#view').firstElementChild;
        const latestToast = document.querySelector('#toast-root').textContent;
        releaseRead(); await deleting;
        assert.equal(dialog.querySelector('tbody').innerHTML, latestTable, '較早批次快照不得復活已刪列');
        assert.equal(document.querySelector('#view').firstElementChild, latestPage, '較早主頁快照不得替換最新頁');
        assert.equal(document.querySelector('#toast-root').textContent, latestToast);
      } else {
      await deleting;
      const newSecond = dialog.querySelector('[data-delbatch="synthetic-batch-B"]');
      assert(newSecond); assert.notEqual(newSecond, oldSecond);
      assert.equal(newSecond.disabled, true, '另一批重畫不能解除在途鎖');
      await secondSubmit(); await newSecond.onclick(); assert.equal(postCalls, 2);
      releaseSecond(); await secondDeleting;
      }
      assert.equal(document.querySelector('#modal-root .modal'), dialog);
      if (!mode.endsWith('-error')) {
        assert.equal(dialog.querySelector('[data-delbatch]'), null);
        assert(!document.querySelector('#view').textContent.includes('SYNTHB'));
      }
      const after = await repo.getDb();
      assert.deepEqual(after.securityTrades, before.securityTrades.filter(r => r.source === 'ibkr'));
      assert.deepEqual({ ...after, securityTrades: [] }, { ...before, securityTrades: [] });
      assert.equal(batchCalls, 3); assert.equal(pageReadsAfterPost, 2); assert.equal(postCalls, 2);
      console.log('SEC_BATCH_CASE_PASSED');
    } else {
    const duplicate = submit();
    assert.equal(postCalls, 1, '同批在途不可重送');
    await duplicate;
    if (['other', 'opened-closed'].includes(mode)) newForm();
    if (mode === 'opened-closed') document.querySelector('[data-cancel]').click();
    if (mode === 'x') dialog.querySelector('.x-close').click();
    if (mode === 'close') dialog.querySelector('[data-close]').click();
    if (mode === 'escape') document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (mode === 'hash-now') win.history.replaceState(null, '', '#cards');
    if (mode === 'navigate-return') {
      win.history.replaceState(null, '', '#cards'); await appModule.router();
      win.history.replaceState(null, '', '#securities'); await appModule.router();
      assert.equal(win.location.hash, '#securities');
    }
    if (mode === 'background') await appModule.router();
    const newer = document.querySelector('#modal-root .modal');
    if (['opened-closed', 'x', 'escape', 'close'].includes(mode)) assert.equal(newer, null);
    const stale = ['other', 'opened-closed', 'x', 'escape', 'close', 'hash-now', 'navigate-return'].includes(mode);
    const readsBefore = pageReadsAfterPost;
    const toastBefore = document.querySelector('#toast-root').textContent;
    release(); await deleting;
    assert.equal(document.querySelector('#modal-root .modal'), newer, '原窗內容更新不重開外殼');
    const after = await repo.getDb();
    assert.deepEqual(after.securityTrades, mode === 'unknown-no-write' ? before.securityTrades : before.securityTrades.filter(r => r.source === 'ibkr'));
    assert.deepEqual({ ...after, securityTrades: [] }, { ...before, securityTrades: [] });
    assert.equal(postCalls, 1);
    if (stale) {
      if (mode === 'other') assert.equal(document.querySelector('#f_marker').value, '本題專屬未存值');
      assert.equal(document.querySelector('#toast-root').textContent, toastBefore);
      assert.equal(batchCalls, 1); assert.equal(pageReadsAfterPost, readsBefore);
    } else if (mode.startsWith('unknown') || ['wrong-id', 'wrong-ok'].includes(mode)) {
      assert.match(document.querySelector('#toast-root').textContent, mode === 'unknown-batch-error' ? /匯入紀錄更新失敗/ : /結果尚未確認/);
      await submit(); assert.equal(postCalls, 1, '未知結果舊快照不可重送');
      assert.equal(batchCalls, 2); assert.equal(pageReadsAfterPost, 1);
      if (mode === 'unknown-no-write') {
        assert(dialog.querySelector('[data-delbatch]'));
        assert.equal(dialog.querySelector('[data-delbatch]').disabled, false, '有效新快照允許重新確認');
        assert(document.querySelector('#view').textContent.includes('SYNTH0'));
      } else if (mode === 'unknown-batch-error') {
        assert.equal(dialog.querySelector('[data-delbatch]'), button);
        assert.equal(button.disabled, true);
      } else assert.equal(dialog.querySelector('[data-delbatch]'), null);
      if (mode === 'unknown-page-error') assert(document.querySelector('#retrySecurities'));
      else {
        if (mode !== 'unknown-no-write') assert(!document.querySelector('#view').textContent.includes('SYNTH0'), '未知回應後主頁須呈現實際讀取結果');
        assert(document.querySelector('#view').textContent.includes('SYNTH1'));
      }
      assert(!document.querySelector('.securities-notice'), '未知回應不能冒稱刪除成功');
    } else {
      if (mode === 'bad-count') {
        assert.match(document.querySelector('#toast-root').textContent, /請重新載入確認筆數/);
        assert(!document.querySelector('#toast-root').textContent.includes('-1'));
      }
      assert.equal(batchCalls, 2); assert.equal(pageReadsAfterPost, readsBefore + 1);
      if (mode === 'batch-error') {
        assert(dialog.contains(button));
        assert.equal(button.disabled, true, '未被新讀取消化的舊列不能顯示可按');
        assert.match(document.querySelector('#toast-root').textContent, /匯入紀錄更新失敗/);
        await submit(); assert.equal(postCalls, 1);
      } else assert.equal(dialog.querySelector('[data-delbatch]'), null);
      if (mode === 'page-error') assert(document.querySelector('#retrySecurities'));
      else assert(!document.querySelector('#view').textContent.includes('SYNTH0'));
    }
    }
  }
  }
  console.log('SEC_BATCH_CASE_PASSED');
} finally {
  release();
  releaseSecond();
  releaseRead();
  releaseBoot();
  for (const t of timers) clearTimeout(t);
  win?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
}

if (Object.keys(process.env).some(key => key.startsWith('SEC_BATCH_'))) await runCase();
