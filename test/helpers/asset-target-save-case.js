// 正式 app 循環模組圖＋隔離 HTTP。成功 POST 走正式保存；失敗 POST 合成 503，只驗前端續行。
// jsdom 斷言節點、輸入、焦點及圖表生命週期，不宣稱原生瀏覽器版面驗收。
/* global document, window */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';

async function runCase() {
  const spec = JSON.parse(process.env.ASSET_TARGET_CASE), source = process.env.ASSET_TARGET_SOURCE;
  const root = fs.realpathSync(process.env.TMPDIR), reportPath = process.env.ASSET_TARGET_REPORT;
  assert.equal(dirname(resolve(process.env.STORE_FILE)), root);
  assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(process.env.NOTEASY_HOSTED, '');
  assert.equal(reportPath, join(root, 'report.json')); assert.equal(fs.existsSync(reportPath), false);
  const http = globalThis.fetch, originalTimer = globalThis.setTimeout, timers = new Set();
  let server, win, postSeen = false, getSeen = false, holdNextSummary = false, failedOnce = false;
  let releasePost, releaseGet;
  const postBarrier = new Promise(r => { releasePost = r; });
  const getBarrier = new Promise(r => { releaseGet = r; });
  const calls = [], pending = new Set(), errors = [], charts = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  globalThis.fetch = async () => { throw new Error('本題不使用外部來源'); };
  const repo = await import(pathToFileURL(source + '/lib/repo.js').href);
  const db = repo.emptyDb();
  db.accounts = [{ id: 'synthetic-cash', name: '合成現金對照', type: 'cash', class: '現金', currency: 'TWD', balance: 1234 }];
  db.assetTargets = [{ class: '現金', targetPct: 40 }];
  await repo.saveDb(db);
  try {
    const { app } = await import(pathToFileURL(source + '/server.js').href);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const readTargets = async () => { const r = await http(base + '/api/assetTargets'); assert.equal(r.status, 200); return r.json(); };
    const targetValues = rows => rows.map(({ class: cls, targetPct }) => ({ class: cls, targetPct }));
    assert.deepEqual(targetValues(await readTargets()), db.assetTargets);
    win = new JSDOM('<!doctype html><nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', { url: base + '/#assets', pretendToBeVisual: true }).window;
    for (const key of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) {
      Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
    }
    win.matchMedia = () => ({ matches: false });
    win.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
    Object.defineProperty(globalThis, 'Chart', { configurable: true, value: class {
      constructor(canvas) { this.canvas = canvas; this.destroyed = 0; charts.push(this); }
      destroy() { this.destroyed++; }
    } });
    win.addEventListener('error', e => { errors.push(e.error?.message || e.message); e.preventDefault(); });
    globalThis.setTimeout = (...args) => { const timer = originalTimer(...args); timers.add(timer); return timer; };
    const bootReplies = new Map([
      ['POST /api/quotes/refresh-auto', { refreshed: false }], ['POST /api/snapshot/auto', { recorded: false, subsRolled: [] }],
      ['POST /api/backup/daily', {}], ['POST /api/accounts/reconcile-names', { changed: 0 }],
      ['POST /api/statement/normalize-auto', { ran: false }]
    ]);
    globalThis.fetch = (url, init = {}) => {
      const path = String(url), method = init.method || 'GET', key = method + ' ' + path;
      const task = (async () => {
        if (bootReplies.has(key)) return json(bootReplies.get(key));
        assert(path.startsWith('/api/'), '拒絕本題以外的來源');
        const call = { path, method, body: init.body ? JSON.parse(init.body) : null }; calls.push(call);
        if (path === '/api/assetTargets/replace' && method === 'POST') {
          const failing = spec.outcome === 'failure' || ['retry', 'retry-read'].includes(spec.mode) && !failedOnce;
          if (failing) failedOnce = true;
          const response = failing ? json({ error: '本題合成保存失敗' }, 503) : await http(base + path, init);
          call.status = response.status; postSeen = true;
          if (spec.phase === 'post' || spec.mode === 'background' || spec.mode === 'retry-read' && !failing) await postBarrier;
          if (spec.phase === 'get' || spec.mode === 'read-error' || spec.mode === 'retry-read' && failing) holdNextSummary = true;
          return response;
        }
        assert.equal(method, 'GET', '只准目標配置寫入與上方有限開機替身');
        const response = await http(base + path, init);
        if (path === '/api/summary' && holdNextSummary) {
          holdNextSummary = false; getSeen = true;
          if (spec.phase === 'get' || spec.mode === 'retry-read') await getBarrier;
          if (spec.mode === 'read-error' || spec.refreshError) return json({ error: '本題合成重讀失敗' }, 503);
        }
        return response;
      })();
      pending.add(task); task.then(() => pending.delete(task), e => { pending.delete(task); errors.push(e.message); });
      return task;
    };
    const appModule = await import(pathToFileURL(source + '/public/app.js').href); await appModule.bootSettled;
    const el = selector => document.querySelector(selector);
    const query = selector => { const node = el(selector); assert(node, selector); return node; };
    const settle = async () => {
      // 共用焦點管理使用動畫影格；先讓新窗自身的初始聚焦／關窗回焦完成，再量晚回應。
      await new Promise(r => win.requestAnimationFrame(r));
      for (let n = 0; n < 4; n++) await new Promise(r => originalTimer(r, 0));
    };
    const waitFor = async predicate => {
      for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(r => originalTimer(r, 10)); }
      assert.fail('操作未完成：' + JSON.stringify(errors));
    };
    await waitFor(() => el('#editTargets') && pending.size === 0);
    const openTargets = () => { query('#editTargets').click(); return query('#modal-root .modal'); };
    const navigate = async hash => {
      const seq = appModule.currentNavSeq();
      window.location.hash = hash;
      await waitFor(() => appModule.currentNavSeq() > seq && el('#view h1') && !el('#view .loading'));
      await settle();
    };
    const writes = () => calls.filter(c => c.method === 'POST');
    const reads = () => calls.filter(c => c.method === 'GET').length;
    const input = () => query('#tRows [data-k="targetPct"]');
    const originalDialog = openTargets(), oldClose = query('#modal-root .x-close').onclick;
    input().value = '61';
    const save = query('#saveT'), oldSave = save.onclick;
    if (spec.mode === 'close' || spec.mode === 'stale-submit') {
      if (spec.mode === 'close') { await navigate('#cards'); oldClose(); assert.equal(el('#modal-root .modal'), null); }
      else query('[data-cancel]').click();
      appModule.openForm({ title: '本題另一張表單', fields: [{ key: 'marker', label: '文字' }], onSubmit: () => {} });
      const newDialog = query('#modal-root .modal'), marker = query('#f_marker'); marker.value = '本題不可清除'; marker.focus();
      if (spec.mode === 'close') oldClose(); else await oldSave();
      assert.equal(query('#modal-root .modal'), newDialog); assert.equal(marker.value, '本題不可清除');
      assert.equal(document.activeElement, marker); assert.equal(writes().length, 0);
      assert.deepEqual(targetValues(await readTargets()), db.assetTargets);
    } else {
      const saveWork = oldSave();
      assert.equal(save.disabled, true);
      if (spec.mode === 'normal') await oldSave();
      await waitFor(() => postSeen);
      if (spec.phase === 'post' || spec.mode === 'background') {
        assert.deepEqual(targetValues(await readTargets()), spec.outcome === 'failure' ? db.assetTargets : [{ class: '現金', targetPct: 61 }]);
      }
      if (spec.mode === 'background') { await appModule.router(); releasePost(); }
      if (spec.mode === 'retry-read') {
        await waitFor(() => getSeen);
        assert.equal(save.disabled, false); input().value = '72';
        const retryWork = save.onclick();
        await waitFor(() => writes().length === 2 && writes()[1].status === 200);
        const page = query('#view').firstElementChild, toast = query('#toast-root').innerHTML;
        releaseGet(); await saveWork; await settle();
        assert.equal(query('#view').firstElementChild, page, '重試後不能提交上一輪的重讀');
        assert.equal(query('#toast-root').innerHTML, toast);
        assert.equal(query('#modal-root .modal'), originalDialog); assert.equal(input().value, '72'); assert.equal(save.disabled, true);
        releasePost(); await retryWork; await waitFor(() => pending.size === 0); await settle();
        assert.equal(el('#modal-root .modal'), null);
        assert.match(query('.asset-allocation-list').textContent, /目標 72%/);
      } else if (spec.mode === 'stale') {
        if (spec.phase === 'get') await waitFor(() => getSeen);
        const action = spec.action;
        if (['reopen', 'other', 'cancel', 'opened-closed'].includes(action)) {
          el('#modal-root [data-cancel]')?.click();
          if (action === 'reopen') { openTargets(); await settle(); input().value = '73'; input().focus(); }
          if (action === 'other' || action === 'opened-closed') {
            appModule.openForm({ title: '本題新的表單', fields: [{ key: 'marker', label: '新輸入' }], onSubmit: () => {} });
            await settle();
            query('#f_marker').value = '本題獨有未存字'; query('#f_marker').focus();
            if (action === 'opened-closed') query('[data-cancel]').click();
          }
        }
        if (action === 'navigate' || action === 'return') { await navigate('#cards'); if (action === 'return') await navigate('#assets'); }
        if (action === 'background') await appModule.router();
        if (action === 'hash-now') { window.history.replaceState(null, '', '#cards'); }
        await settle();
        const page = query('#view').firstElementChild, dialog = el('#modal-root .modal'), focused = document.activeElement;
        const values = [...document.querySelectorAll('#modal-root input')].map(e => e.value);
        const buttons = [...document.querySelectorAll('#modal-root button')].map(e => e.disabled);
        const toast = query('#toast-root').innerHTML, readCount = reads(), destruction = charts.map(c => c.destroyed);
        releasePost(); releaseGet(); await saveWork; await waitFor(() => pending.size === 0); await settle();
        assert.equal(query('#view').firstElementChild, page, '舊回應不可替換後來的頁面節點');
        assert.equal(el('#modal-root .modal'), dialog, '舊回應不可關掉新窗');
        assert.deepEqual([...document.querySelectorAll('#modal-root input')].map(e => e.value), values);
        assert.deepEqual([...document.querySelectorAll('#modal-root button')].map(e => e.disabled), buttons);
        assert.equal(document.activeElement, focused); assert.equal(query('#toast-root').innerHTML, toast);
        assert.equal(reads(), readCount, '過期回應不可另發重讀');
        assert.deepEqual(charts.map(c => c.destroyed), destruction, '舊重讀不可清理現任圖表');
      } else {
        releasePost(); releaseGet(); await saveWork; await waitFor(() => pending.size === 0); await settle();
        if (spec.mode === 'retry' || spec.mode === 'read-error' && spec.outcome === 'failure') {
          assert.equal(query('#modal-root .modal'), originalDialog); assert.equal(input().value, '61'); assert.equal(save.disabled, false);
          assert.match(query('#toast-root').textContent, /儲存目標配置時發生錯誤：本題合成保存失敗/);
          if (spec.mode === 'retry') { input().value = '72'; await save.onclick(); await waitFor(() => pending.size === 0); await settle(); }
        }
        if (spec.outcome !== 'failure') {
          assert.equal(el('#modal-root .modal'), null);
          assert.match(query('#toast-root').textContent, /目標配置已更新/);
          if (spec.mode === 'read-error') {
            assert.match(query('#toast-root').textContent, /畫面更新失敗/);
            assert.doesNotMatch(query('#toast-root').textContent, /儲存目標配置時發生錯誤/);
          } else assert.match(query('.asset-allocation-list').textContent, new RegExp('目標 ' + (spec.mode === 'retry' ? 72 : 61) + '%'));
        }
      }
      const retried = ['retry', 'retry-read'].includes(spec.mode);
      assert.equal(writes().length, retried ? 2 : 1);
      assert.deepEqual(writes()[0].body, { targets: [{ class: '現金', targetPct: 61 }] });
      assert.deepEqual(targetValues(await readTargets()), spec.outcome === 'failure' ? db.assetTargets : [{ class: '現金', targetPct: retried ? 72 : 61 }]);
    }
    assert.deepEqual((await repo.getDb()).accounts, db.accounts, '本題對照帳戶不能被配置保存改寫');
    assert.deepEqual(errors, []);
    return { nonce: process.env.ASSET_TARGET_NONCE, name: spec.name, passed: true, realHttp: true };
  } finally {
    releasePost(); releaseGet(); await Promise.allSettled([...pending]);
    win?.close(); for (const timer of timers) clearTimeout(timer);
    globalThis.setTimeout = originalTimer; globalThis.fetch = http;
    if (server) { server.closeAllConnections(); await new Promise((ok, fail) => server.close(e => e ? fail(e) : ok())); }
  }
}
if (process.env.ASSET_TARGET_CASE) {
  const report = await runCase();
  fs.writeFileSync(process.env.ASSET_TARGET_REPORT, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
}
