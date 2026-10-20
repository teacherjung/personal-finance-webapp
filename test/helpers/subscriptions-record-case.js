// 真 renderer／按鈕接專屬 LOCAL HTTP 帳本；確認窗、維護、歷史圖資料與 Chart 繪製使用合成邊界。
// 圖表只觀察實際建構與 destroy，不模擬像素；jsdom 不替代原生鍵盤、版面或本人驗收。
/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { JSDOM } from 'jsdom';

async function runCase() {
  const spec = JSON.parse(process.env.SUBSCRIPTION_RECORD_CASE);
  const source = process.env.SUBSCRIPTION_RECORD_SOURCE, nonce = process.env.SUBSCRIPTION_RECORD_NONCE;
  const root = fs.realpathSync(process.env.TMPDIR), reportPath = resolve(process.env.SUBSCRIPTION_RECORD_REPORT);
  assert.equal(dirname(resolve(process.env.STORE_FILE)), root);
  assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(process.env.NOTEASY_HOSTED, ''); assert.equal(process.env.TZ, 'UTC');
  assert.equal(reportPath, join(root, 'report.json')); assert.equal(fs.existsSync(reportPath), false);
  assert.equal(typeof nonce, 'string'); assert(nonce.length > 0);
  const http = globalThis.fetch, NativeDate = globalThis.Date, originalTimer = globalThis.setTimeout;
  const timers = new Set(), errors = [], calls = [], pending = new Set(), charts = [], confirmations = [];
  let server, win, release, httpPosts = 0;
  const barrier = new Promise(r => { release = r; });
  const failureText = '本題明確拒絕 ' + nonce;
  // 固定合成日期，讓預期日期能直接列明，不借受測 todayStr 反算答案。
  globalThis.Date = class extends NativeDate {
    constructor(...args) { if (args.length) super(...args); else super('2026-10-20T12:00:00.000Z'); }
    static now() { return NativeDate.parse('2026-10-20T12:00:00.000Z'); }
  };
  globalThis.fetch = async () => { throw new Error('本題不使用外部來源'); };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const subject = { id: 'subject', name: '本題記帳 ' + nonce, category: '工具', amount: 137, cycle: 'monthly',
    card: '合成卡', email: '', status: spec.list, active: spec.list !== 'ended', since: '2026-06',
    nextCharge: '2099-12-31', endsOn: spec.list === 'ending' ? '2099-12-31' : '',
    expiryDate: '', chargeAnchorDay: 31, considerCancel: false };
  const control = { id: 'control', name: '本題保存列 ' + nonce, category: '健康', amount: 29, cycle: 'monthly',
    card: '合成卡', status: 'active', active: true, since: '2026-06', nextCharge: '2099-12-01', considerCancel: false };
  const oldTx = { id: 'existing', date: '2026-10-01', type: 'expense', category: '生活', subcategory: '其他生活雜支',
    amount: 53, account: '合成卡', note: '本題既有記帳 ' + nonce, ledger: 'cashflow' };
  const expected = { date: '2026-10-20', type: 'expense', category: '工作', subcategory: '其他工作成本',
    amount: 137, account: '合成卡', note: '本題記帳 ' + nonce + '（訂閱月費）' };
  try {
    const repo = await import(pathToFileURL(source + '/lib/repo.js').href);
    const db = repo.emptyDb();
    db.subscriptions = [subject, control]; db.transactions = [oldTx];
    db.cards = [{ id: 'synthetic-card', name: '合成卡', type: 'credit' }];
    db.accounts = [{ id: 'synthetic-account', name: '合成卡', type: 'creditcard', class: '負債', currency: 'TWD', balance: 0 }];
    await repo.saveDb(db);
    const { app } = await import(pathToFileURL(source + '/server.js').href);
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/transactions') {
        httpPosts++;
        if (spec.outcome === 'failure') {
          // 明確拒絕發生在測試伺服器邊界；不拿未送達的替身回應充當真正落庫失敗。
          req.resume();
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: failureText }));
          return;
        }
      }
      app(req, res);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const getRows = async collection => {
      const r = await http(base + '/api/' + collection); assert.equal(r.status, 200);
      return r.json();
    };
    assert.deepEqual(await getRows('subscriptions'), [subject, control]);
    assert.deepEqual(await getRows('transactions'), [oldTx]);
    win = new JSDOM('<!doctype html><nav id="nav"></nav><button id="snapshotBtn"></button><button id="outside">本題移焦處</button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>',
      { url: base + '/#subscriptions', pretendToBeVisual: true }).window;
    for (const key of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent',
      'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) {
      Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
    }
    Object.defineProperty(globalThis, 'Chart', { configurable: true, value: class {
      constructor(canvas) { this.canvas = canvas; this.destroyed = false; charts.push(this); }
      destroy() { this.destroyed = true; }
    } });
    win.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
    win.addEventListener('error', e => { errors.push(e.error?.message || e.message); e.preventDefault(); });
    globalThis.setTimeout = (...args) => { const t = originalTimer(...args); timers.add(t); return t; };
    const confirm = message => { confirmations.push(message); return spec.outcome !== 'cancel'; };
    globalThis.confirm = confirm; win.confirm = confirm;
    const boot = new Map([
      ['POST /api/quotes/refresh-auto', { refreshed: false }], ['POST /api/snapshot/auto', { recorded: false, subsRolled: [] }],
      ['POST /api/backup/daily', {}], ['POST /api/accounts/reconcile-names', { changed: 0 }],
      ['POST /api/statement/normalize-auto', { ran: false }], ['GET /api/settings', {}], ['GET /api/mode', { hosted: false }]
    ]);
    const history = Array.from({ length: 12 }, (_, i) => ({ id: 'hist-' + i, month: `2026-${String(i + 1).padStart(2, '0')}`, amount: 1 }));
    globalThis.fetch = (url, init = {}) => {
      const path = String(url), method = init.method || 'GET', key = method + ' ' + path;
      const task = (async () => {
        if (boot.has(key)) return json(boot.get(key));
        if (key === 'GET /api/history') return json(history);
        assert(['GET /api/subscriptions', 'GET /api/cards', 'POST /api/transactions', 'GET /api/insurance'].includes(key), '未登記請求：' + key);
        const call = { key, body: init.body ? JSON.parse(init.body) : null }; calls.push(call);
        const response = await http(base + path, init); call.status = response.status;
        if (key === 'POST /api/transactions') await barrier;
        return response;
      })();
      pending.add(task);
      task.then(() => pending.delete(task), e => { pending.delete(task); errors.push(e.message); });
      return task;
    };
    const appModule = await import(pathToFileURL(source + '/public/app.js').href); await appModule.bootSettled;
    const query = selector => { const e = document.querySelector(selector); assert(e, selector); return e; };
    const settle = () => new Promise(r => originalTimer(r, 0));
    const waitFor = async predicate => {
      for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(r => originalTimer(r, 10)); }
      assert.fail('記帳操作未完成：' + JSON.stringify(errors));
    };
    await waitFor(() => document.querySelector(`[data-list-key="${spec.list}"] [data-record="subject"]`) && pending.size === 0);
    await settle();
    const page = query('.subscriptions-page'), button = query(`[data-list-key="${spec.list}"] [data-record="subject"]`), row = button.closest('tr');
    assert.equal(page.querySelectorAll('[data-record="subject"]').length, 1);
    const originalCharts = charts.filter(c => c.canvas.isConnected && page.contains(c.canvas));
    assert(originalCharts.length > 0); assert(originalCharts.every(c => !c.destroyed));
    appModule.toast('本題通知 ' + nonce);
    const notice = query('#toast-root .toast'); notice.dispatchEvent(new Event('mouseenter'));
    const noticeText = notice.textContent, beforeCalls = calls.length;
    button.focus(); assert.equal(document.activeElement, button); button.click();
    let currentPage = page, focus = button, modal = null, input = null;
    if (spec.outcome !== 'cancel') {
      await waitFor(() => calls.some(c => c.key === 'POST /api/transactions' && c.status));
      if (spec.handoff === 'focus') { focus = query('#outside'); focus.focus(); }
      if (spec.handoff === 'navigation') {
        win.location.hash = '#insurance';
        await waitFor(() => document.querySelector('.insurance-page #addIns') && pending.size === 1);
        currentPage = query('.insurance-page'); focus = query('#addIns'); focus.focus();
      }
      if (spec.handoff === 'modal') {
        query('[data-edit="control"]').click();
        await waitFor(() => document.querySelector('#modalForm'));
        modal = query('#modalForm'); input = query('#f_name'); input.value = '本題未存輸入 ' + nonce;
        input.focus(); focus = input;
      }
    }
    const chartCount = charts.length, chartState = charts.map(c => ({ chart: c, canvas: c.canvas, destroyed: c.destroyed }));
    release();
    if (spec.outcome !== 'cancel') await waitFor(() => document.querySelectorAll('#toast-root .toast').length > 1 && pending.size === 0);
    await settle();
    // 反控必須先走完真正按鈕與終態；刪掉 POST 不能以後面的保存斷言冒充有效紅。
    process.stdout.write('RECORD_OPERATION_COMPLETED ' + JSON.stringify({ nonce, spec, confirmations: confirmations.length, httpPosts,
      statuses: calls.filter(c => c.key === 'POST /api/transactions').map(c => c.status) }) + '\n');
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0], `要把這筆記入「銀行收支」嗎？\n\n本題記帳 ${nonce}（月費） 137 元\n續費卡：合成卡\n日期：2026-10-20`);
    const posts = calls.filter(c => c.key === 'POST /api/transactions');
    assert.equal(posts.length, spec.outcome === 'cancel' ? 0 : 1); assert.equal(httpPosts, posts.length);
    if (posts.length) { assert.deepEqual(posts[0].body, expected, '記帳 payload'); assert.equal(posts[0].status, spec.outcome === 'success' ? 200 : 503); }
    assert.deepEqual(calls.slice(beforeCalls).map(c => c.key),
      [...(spec.outcome === 'cancel' ? [] : ['POST /api/transactions']), ...(spec.handoff === 'navigation' ? ['GET /api/insurance'] : [])]);
    assert.equal(query(spec.handoff === 'navigation' ? '.insurance-page' : '.subscriptions-page'), currentPage, '記帳完成保存目前頁殼');
    if (spec.handoff !== 'navigation') {
      assert.equal(query(`[data-list-key="${spec.list}"] [data-record="subject"]`), button, '記帳完成保存原按鈕');
      assert.equal(button.closest('tr'), row, '記帳完成保存原列');
      assert(originalCharts.every(c => c.canvas.isConnected && page.contains(c.canvas) && !c.destroyed), '記帳完成保存連線圖表');
    } else assert.equal(page.isConnected, false);
    assert.equal(charts.length, chartCount);
    for (const state of chartState) {
      assert.equal(state.chart.canvas, state.canvas); assert.equal(state.chart.destroyed, state.destroyed, '記帳完成不得清理接管後圖表狀態');
    }
    assert.equal(notice.isConnected, true, '記帳完成保存本題通知');
    assert.equal(notice.textContent, noticeText);
    assert.equal(document.activeElement, focus, '記帳完成保存目前焦點');
    if (modal) {
      assert.equal(query('#modalForm'), modal); assert.equal(query('#f_name'), input);
      assert.equal(input.value, '本題未存輸入 ' + nonce, '記帳完成保存新窗未存值');
    }
    const notices = [...document.querySelectorAll('#toast-root .toast')].filter(e => e !== notice);
    assert.equal(notices.length, spec.outcome === 'cancel' ? 0 : 1);
    if (spec.outcome === 'success') { assert.equal(notices[0].textContent, '已記入銀行收支：137 元 ✅'); assert.equal(notices[0].classList.contains('err'), false); }
    if (spec.outcome === 'failure') { assert.equal(notices[0].textContent, failureText); assert.equal(notices[0].classList.contains('err'), true); }
    const saved = await getRows('transactions');
    assert.deepEqual(await getRows('subscriptions'), [subject, control], '記帳完成保存訂閱資料');
    assert.deepEqual(saved.find(t => t.id === 'existing'), oldTx, '記帳完成保存既有交易');
    if (spec.outcome === 'success') {
      assert.equal(saved.length, 2);
      const added = saved.find(t => t.id !== 'existing'); assert(added);
      const { id, ...fields } = added; assert.equal(typeof id, 'string'); assert(id.length > 0);
      assert.deepEqual(fields, expected, '記帳完成的實際 HTTP 回讀結果');
    } else assert.deepEqual(saved, [oldTx], '取消或明確失敗不新增交易');
    assert.deepEqual(errors, []);
    return { version: 1, nonce, spec, passed: true, confirmations: confirmations.length, posts: posts.length, httpPosts,
      rawRoundTrip: true, presentationPreserved: true };
  } finally {
    release();
    await Promise.allSettled([...pending]);
    if (win) win.close();
    for (const timer of timers) clearTimeout(timer);
    if (server?.listening) { server.closeAllConnections(); await new Promise((res, rej) => server.close(e => e ? rej(e) : res())); }
    globalThis.fetch = http; globalThis.Date = NativeDate; globalThis.setTimeout = originalTimer;
  }
}
if (process.env.SUBSCRIPTION_RECORD_CASE) {
  const report = await runCase();
  fs.writeFileSync(process.env.SUBSCRIPTION_RECORD_REPORT, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
}
