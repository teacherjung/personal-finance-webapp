// 完整前端模組、合成 fetch 與 DOM；不載入後端，也不提供真 HTTP 或帳本保存證據。
/* global document */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

async function runCase() {
  const source = process.env.SETTINGS_OPEN_ERROR_SOURCE;
  const entry = process.env.SETTINGS_OPEN_ERROR_ENTRY;
  const entries = {
    expense: ['manageCatsBtn', '/api/categories', '支出分類管理', '讀取分類失敗：'],
    income: ['manageIncomeCatsBtn', '/api/income-categories', '收入分類管理', '讀取收入分類失敗：'],
    recipes: ['manageParseRecipesBtn', '/api/parse-recipes', '版面規則卡', '讀取規則卡失敗：'],
    bank: ['manageBankLearnedBtn', '/api/bank-learned', '銀行收支學習', '讀取已學規則失敗：'],
    text: ['manageCashflowTextRulesBtn', '/api/settings', '摘要與備註套用', '讀取文字套用規則失敗：'],
    transfer: ['manageTransferSubsBtn', '/api/transfer-subcategories', '內轉分類管理', '讀取內轉分類失敗：'],
  };
  assert(source);
  assert(Object.hasOwn(entries, entry));
  const config = entries[entry];
  const fixture = {
    settings: { emergencyFundMonths: 3, ibIdleCashAlert: 0, netWorthTarget: null,
      cashflowTextRules: { summary: { '本題摘要': '本題新摘要' }, remark: {} } },
    transactions: [{ id: '本題保留-' + entry, date: '2026-10-01', source: 'manual', type: 'expense', amount: 7, note: '本題專屬記憶體資料' }],
    categories: { '本題支出': ['本題子類'] },
    incomeCategories: { '本題收入': ['本題子類'] },
    recipes: [], learnedBank: [], transferSubs: [{ label: '本題內轉' }],
    health: { items: [], dismissed: 0 }, rules: { rules: null }, orphans: { items: [], total: 0 },
  };
  const reads = new Map([
    ['/api/settings', fixture.settings], ['/api/transactions', fixture.transactions],
    ['/api/categories', fixture.categories], ['/api/income-categories', fixture.incomeCategories],
    ['/api/parse-recipes', fixture.recipes], ['/api/bank-learned', fixture.learnedBank],
    ['/api/transfer-subcategories', fixture.transferSubs], ['/api/statement/health', fixture.health],
    ['/api/statement/rules', fixture.rules], ['/api/statement/learned/orphans', fixture.orphans],
  ]);
  const boot = new Map([
    ['POST /api/quotes/refresh-auto', { refreshed: false }],
    ['POST /api/snapshot/auto', { recorded: false, subsRolled: [] }],
    ['POST /api/backup/daily', {}], ['POST /api/accounts/reconcile-names', { changed: 0 }],
    ['POST /api/statement/normalize-auto', { ran: false }],
  ]);
  const requests = [], unexpected = [], timers = new Set();
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout;
  let armed = false, waiting = 0, release, work, root, descriptor, intercepted = false;
  const gate = new Promise(resolve => { release = resolve; });
  const win = new JSDOM('<nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', {
    url: 'https://synthetic.invalid/#settings', pretendToBeVisual: true,
  }).window;
  try {
    for (const key of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) {
      Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
    }
    win.matchMedia = () => ({ matches: false });
    win.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
    Object.defineProperty(globalThis, 'Chart', { value: class { destroy() {} }, configurable: true });
    globalThis.setTimeout = (...args) => { const t = originalTimer(...args); timers.add(t); return t; };
    globalThis.fetch = async (url, init = {}) => {
      const request = { method: init.method || 'GET', path: String(url) };
      requests.push(request);
      const key = request.method + ' ' + request.path;
      const knownBoot = !armed && boot.has(key);
      const knownRead = request.method === 'GET' && reads.has(request.path);
      if (!knownBoot && !knownRead) {
        unexpected.push(request);
        assert.fail('合成 fetch 未登記的請求：' + key);
      }
      if (armed) {
        assert.equal(request.path, config[1], '同步開窗案例只可讀取指定管理入口');
        waiting++;
        try { await gate; } finally { waiting--; }
      }
      return new Response(JSON.stringify(knownBoot ? boot.get(key) : reads.get(request.path)), { status: 200 });
    };
    const appModule = await import(pathToFileURL(source + '/public/app.js'));
    await appModule.bootSettled;
    let ready = false;
    for (let i = 0; i < 500; i++) {
      if (Object.values(entries).every(([id]) => typeof document.getElementById(id)?.onclick === 'function')) { ready = true; break; }
      await new Promise(resolve => originalTimer(resolve, 5));
    }
    assert(ready, '設定頁須完成真入口接線：' + document.querySelector('#view').textContent);
    assert.deepEqual(unexpected, [], '初載不得吞掉未知請求');
    const start = requests.length;
    root = document.getElementById('modal-root');
    assert.equal(root.querySelector('.modal'), null);
    const unchanged = appModule.watchModalRoot(), previousGen = root.dataset.modalGen;
    const beforeNotices = new Set(document.querySelector('#toast-root').children);
    const failure = new Error('本題同步開窗失敗：' + entry);
    let calls = 0, claimedBeforeThrow = false, attemptedHtml = '', thrownError;
    armed = true;
    work = document.getElementById(config[0]).onclick();
    assert.deepEqual(requests.slice(start), [{ method: 'GET', path: config[1] }], '真入口須發出本題指定 GET');
    assert.equal(waiting, 1, '指定 GET 須實際到達本題回應屏障');
    assert.equal(unchanged(), true, '等待讀取不得先取得彈窗所有權');
    descriptor = Object.getOwnPropertyDescriptor(root, 'innerHTML');
    const readInnerHTML = Object.getOwnPropertyDescriptor(win.Element.prototype, 'innerHTML')?.get;
    assert(readInnerHTML, '合成 DOM 須提供 innerHTML 原型 getter');
    Object.defineProperty(root, 'innerHTML', {
      configurable: true,
      get() { return readInnerHTML.call(this); },
      set(value) {
        calls++;
        claimedBeforeThrow = !unchanged() && root.dataset.modalGen !== previousGen;
        attemptedHtml = String(value);
        thrownError = failure;
        throw failure;
      },
    });
    intercepted = true;
    release(); await work;
    assert.equal(calls, 1, '正式開窗須觸發本題唯一同步例外');
    assert.equal(claimedBeforeThrow, true, '正式開窗須在例外前取得自身彈窗所有權');
    assert.equal(thrownError, failure, '須拋出本題專屬 Error');
    assert(attemptedHtml.includes(config[2]), '同步例外須來自本題指定管理器開窗');
    const addedNotices = Array.from(document.querySelector('#toast-root').children).filter(node => !beforeNotices.has(node));
    assert.equal(addedNotices.length, 1, '同步開窗例外須顯示本題錯誤通知');
    assert.equal(addedNotices[0].textContent, config[3] + failure.message, '同步開窗例外須保留原錯誤前綴與本題訊息');
    assert(addedNotices[0].classList.contains('err'), '同步開窗例外須使用錯誤通知樣式');
    assert.deepEqual(requests.slice(start), [{ method: 'GET', path: config[1] }], '同步開窗例外不得另讀或送出寫入');
    assert.deepEqual(unexpected, [], '案例不得吞掉未知請求');
    console.log('SETTINGS_OPEN_ERROR_CASE_PASSED');
  } finally {
    if (intercepted) {
      if (descriptor) Object.defineProperty(root, 'innerHTML', descriptor);
      else Reflect.deleteProperty(root, 'innerHTML');
    }
    release();
    if (work) await Promise.allSettled([work]);
    for (const timer of timers) clearTimeout(timer);
    win.close();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimer;
  }
}

if (process.env.SETTINGS_OPEN_ERROR_SOURCE) await runCase();
