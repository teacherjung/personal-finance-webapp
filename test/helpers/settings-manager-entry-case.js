// 完整前端模組與隔離 LOCAL HTTP；DOM 替身不提供原生版面證據。
/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';

async function runCase() {
  const source = process.env.SETTINGS_ENTRY_SOURCE;
  const mode = process.env.SETTINGS_ENTRY_MODE;
  const entries = {
    expense: ['manageCatsBtn', '/categories', '支出分類管理', '讀取分類失敗：'],
    income: ['manageIncomeCatsBtn', '/income-categories', '收入分類管理', '讀取收入分類失敗：'],
    recipes: ['manageParseRecipesBtn', '/parse-recipes', '版面規則卡', '讀取規則卡失敗：'],
    bank: ['manageBankLearnedBtn', '/bank-learned', '銀行收支學習', '讀取已學規則失敗：'],
    text: ['manageCashflowTextRulesBtn', '/settings', '摘要與備註套用', '讀取文字套用規則失敗：'],
    transfer: ['manageTransferSubsBtn', '/transfer-subcategories', '內轉分類管理', '讀取內轉分類失敗：'],
  };
  assert(source && fs.existsSync(source + '/public/modules/settings.js'));
  assert(Object.hasOwn(entries, process.env.SETTINGS_ENTRY));
  assert(['normal', 'populated', 'other', 'other-error', 'closed', 'hash', 'hash-entry', 'navigate-return', 'root', 'view', 'background', 'stale-button', 'retry', 'cross-old-first', 'cross-new-first', 'cross-new-error', 'same-old-first', 'same-new-first', 'same-new-error'].includes(mode));
  assert.equal(dirname(process.env.STORE_FILE), fs.realpathSync(process.env.TMPDIR));
  assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(process.env.NOTEASY_HOSTED, '');
  const config = entries[process.env.SETTINGS_ENTRY];
  const second = mode.startsWith('same-') ? config : entries[process.env.SETTINGS_ENTRY === 'income' ? 'expense' : 'income'];
  const http = globalThis.fetch, timer = globalThis.setTimeout, timers = new Set();
  globalThis.fetch = async () => { throw new Error('禁止外部請求'); };
  const repo = await import(pathToFileURL(source + '/lib/repo.js'));
  const fixture = repo.emptyDb();
  const marker = '合成自訂<&"內容';
  if (mode === 'populated') {
    fixture.settings.expenseTree = { [marker]: ['合成支出子類'] };
    fixture.settings.incomeTree = { [marker]: ['合成收入子類'] };
    fixture.transferSubs = [{ label: marker }];
    fixture.settings.cashflowTextRules = { summary: { '合成來源': marker }, remark: {} };
    fixture.learnedBank = { '合成摘要|合成對象': { type: 'expense', category: marker, subcategory: '合成子類' } };
    const { RECIPE_FORMAT_VERSION } = await import(pathToFileURL(source + '/lib/parse-recipe.js'));
    fixture.parseRecipes = [{ id: 'synthetic-recipe', bank: marker, graduateStreak: 2, graduated: false, suspect: false, rebirths: 0,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', current: {
        formatVersion: RECIPE_FORMAT_VERSION, bank: marker, docAnchors: ['合成錨一', '合成錨二'], dateFormat: 'west-slash',
        refDate: { strategy: 'anchored-date', anchor: '合成結算日' },
        summary: { sections: [{ anchor: '合成錨一', currency: 'TWD' }], endAnchor: '合成總計', balancePick: 'dollar-tagged' },
        detail: { rowIdent: 'acct-date', headerOut: '合成提領', headerIn: '合成存入', headerBalance: '合成餘額', headerNote: '合成註記', headerIgnore: ['合成單號'] },
      } }];
  }
  await repo.saveDb(fixture);
  const before = structuredClone(await repo.getDb());
  let server, win;
  const requests = [], events = [];
  let armed = false, activeReads = 0;
  try {
    const { app } = await import(pathToFileURL(source + '/server.js'));
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    win = new JSDOM('<nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', { url: base + '/#settings', pretendToBeVisual: true }).window;
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
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url), method = init.method || 'GET';
      if (boot.has(method + ' ' + path)) return json(boot.get(method + ' ' + path));
      assert(path.startsWith('/api/')); assert.equal(method, 'GET', '管理初載不可寫入');
      const hold = armed;
      let request;
      if (hold) {
        let release;
        const ready = new Promise(resolve => { release = resolve; });
        request = { path, release, ready, response: false, error: false };
        requests.push(request);
      }
      activeReads++;
      try {
        const response = await http(base + path, init);
        assert.equal(response.status, 200, path);
        if (request) {
          request.response = true;
          await request.ready;
          if (request.error) return json({ error: '本題讀取失敗' }, 503);
        }
        return response;
      } finally { activeReads--; }
    };
    const appModule = await import(pathToFileURL(source + '/public/app.js'));
    await appModule.bootSettled;
    const wait = async predicate => {
      for (let i = 0; i < 500; i++) {
        if (predicate()) return;
        await new Promise(resolve => timer(resolve, 5));
      }
      assert.fail('未到合成屏障：' + JSON.stringify({ activeReads, requests: requests.length }));
    };
    await wait(() => typeof document.getElementById(config[0])?.onclick === 'function' && activeReads === 0);
    const original = document.getElementById(config[0]);
    const modal = () => document.querySelector('#modal-root .modal');
    const notice = () => document.querySelector('#toast-root').textContent;
    const launch = button => { const result = button.onclick(); events.push(result); return result; };
    const start = async button => {
      const count = requests.length;
      const result = launch(button);
      await wait(() => requests.length === count + 1 && requests[count].response);
      return { result, request: requests[count] };
    };
    const newForm = () => {
      appModule.openForm({ title: '本題新窗', fields: [{ key: 'marker', label: '新輸入' }], onSubmit() {} });
      document.querySelector('#f_marker').value = '本題專屬未存值';
    };
    armed = true;
    const first = await start(original);
    assert.equal(first.request.path, '/api' + config[1]);
    assert.equal(modal(), null, '初載期間不得先搶占彈窗');
    if (mode.startsWith('cross-') || mode.startsWith('same-')) {
      const next = await start(document.getElementById(second[0]));
      assert.equal(next.request.path, '/api' + second[1]);
      if (mode.endsWith('old-first')) {
        first.request.release(); await first.result;
        assert.equal(modal(), null, '舊回應先到仍須讓最新意圖完成');
      }
      if (mode.endsWith('new-error')) next.request.error = true;
      next.request.release(); await next.result;
      const newer = modal(), currentNotice = notice();
      if (mode.endsWith('new-error')) { assert.equal(newer, null); assert(notice().includes(second[3])); }
      else assert(newer.textContent.includes(second[2]));
      first.request.release(); await first.result;
      assert.equal(modal(), newer); assert.equal(notice(), currentNotice);
      assert.equal(requests.length, 2);
    } else {
      if (['other', 'other-error', 'closed'].includes(mode)) newForm();
      if (mode === 'closed') document.querySelector('[data-cancel]').click();
      if (['hash', 'hash-entry'].includes(mode)) win.history.replaceState(null, '', '#assets');
      if (mode === 'hash-entry') {
        launch(original);
        assert.equal(requests.length, 1, 'hash 已換但 router 未執行時入口不得另發 GET');
      }
      if (mode === 'navigate-return') {
        armed = false;
        win.history.replaceState(null, '', '#assets'); await appModule.router();
        win.history.replaceState(null, '', '#settings'); await appModule.router();
        armed = true;
        assert.equal(win.location.hash, '#settings');
      }
      if (['root', 'view'].includes(mode)) {
        const node = document.getElementById(mode === 'root' ? 'modal-root' : 'view');
        node.replaceWith(node.cloneNode(true));
      }
      if (['background', 'stale-button'].includes(mode)) {
        armed = false;
        await appModule.router();
        await wait(() => document.getElementById(config[0]) !== original && activeReads === 1);
        armed = true;
        if (mode === 'stale-button') {
          launch(original);
          assert.equal(requests.length, 1, '卸載入口不得讀取或撤銷已接受意圖');
        }
      }
      const newer = modal(), currentNotice = notice();
      first.request.error = ['other-error', 'retry'].includes(mode);
      first.request.release(); await first.result;
      if (['other', 'other-error', 'closed', 'hash', 'hash-entry', 'navigate-return', 'root', 'view'].includes(mode)) {
        assert.equal(modal(), newer, '過期成功不得覆蓋後開表單或重開已關視窗');
        assert.equal(notice(), currentNotice, '過期失敗不得通知');
        if (mode.startsWith('other')) assert.equal(document.querySelector('#f_marker').value, '本題專屬未存值');
      } else if (mode === 'retry') {
        assert.equal(modal(), null); assert(notice().includes(config[3]));
        const retry = await start(document.getElementById(config[0]));
        retry.request.release(); await retry.result;
        assert(modal().textContent.includes(config[2]));
      } else {
        assert(modal()?.textContent.includes(config[2]), '有效入口應開啟對應管理器');
        if (mode === 'populated') {
          const inputs = Array.from(modal().querySelectorAll('input'), input => input.value);
          assert(inputs.includes(marker) || modal().textContent.includes(marker), '正式投影應保留本題自訂內容');
        }
      }
      assert.equal(requests.length, mode === 'retry' ? 2 : 1);
    }
    assert.deepEqual(await repo.getDb(), before, '管理初載保留本題帳本');
    console.log('SETTINGS_ENTRY_CASE_PASSED');
  } finally {
    for (const request of requests) request.release();
    await Promise.allSettled(events);
    for (const t of timers) clearTimeout(t);
    win?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

if (Object.keys(process.env).some(key => key.startsWith('SETTINGS_ENTRY'))) await runCase();
