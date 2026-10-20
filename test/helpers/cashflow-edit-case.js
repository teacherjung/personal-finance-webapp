// A 走真正 JSDOM 表單，B 直接使用獨立 HTTP 客戶端；兩者寫入同一個專屬 LOCAL 合成庫。
// 啟動維護與分類選項為固定邊界；不驗原生版面，失敗題的首次拒絕發生在測試伺服器。
/* global document */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { JSDOM } from 'jsdom';

async function runCase() {
  const scenario = process.env.CASHFLOW_EDIT_CASE, source = process.env.CASHFLOW_EDIT_SOURCE;
  const nonce = process.env.CASHFLOW_EDIT_NONCE, root = fs.realpathSync(process.env.TMPDIR);
  const reportPath = resolve(process.env.CASHFLOW_EDIT_REPORT);
  assert.equal(dirname(resolve(process.env.STORE_FILE)), root);
  assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  assert.equal(reportPath, join(root, 'report.json')); assert.equal(fs.existsSync(reportPath), false);
  assert.equal(process.env.NOTEASY_HOSTED, ''); assert.equal(process.env.TZ, 'UTC');
  assert(nonce && scenario);
  const http = globalThis.fetch, timer = globalThis.setTimeout;
  const timers = new Set(), errors = [], calls = [], pending = new Set();
  const aSummary = 'A摘要-' + nonce, aRemark = 'A備註-' + nonce;
  const bSummary = 'B摘要-' + nonce, bRemark = 'B備註-' + nonce;
  const subject = { id: 'subject', ledger: 'cashflow', date: '2026-10-20', type: 'expense',
    category: '居住', subcategory: '房租', amount: 137, account: '合成帳戶',
    summary: '初始摘要-' + nonce, remark: '初始備註-' + nonce };
  const bank = ['fallback', 'apply-all', 'apply-summary', 'apply-remark'].includes(scenario);
  if (bank) Object.assign(subject, { source: 'bank', bankKey: '本題銀行鍵-' + nonce,
    bankRef: '本題去重鍵-' + nonce, dir: 'out', note: '舊說明-' + nonce,
    bankSummary: '原文摘要-' + nonce, bankNote: '原文備註-' + nonce });
  if (scenario === 'fallback') { delete subject.summary; delete subject.remark; subject.category = ''; subject.subcategory = ''; }
  if (scenario === 'missing') { delete subject.summary; delete subject.remark; delete subject.account; subject.note = '舊列-' + nonce; }
  if (scenario === 'null-amount') subject.amount = null;
  const sibling = { ...subject, id: 'sibling', category: '飲食', subcategory: '超市', amount: 29 };
  const initial = structuredClone(subject), initialSibling = structuredClone(sibling);
  let server, win, parsedRows, requests = 0;
  globalThis.fetch = async () => { throw new Error('本題禁止外連'); };
  const json = data => new Response(JSON.stringify(data));
  try {
    const repo = await import(pathToFileURL(source + '/lib/repo.js').href);
    const db = repo.emptyDb(); db.transactions = bank ? [subject, sibling] : [subject];
    db.accounts = ['合成帳戶', '另一合成帳戶'].map((name, i) => ({ id: 'account-' + i, name, type: 'cash', class: '資產', currency: 'TWD', balance: 0 }));
    await repo.saveDb(db);
    const { app } = await import(pathToFileURL(source + '/server.js').href);
    server = createServer((req, res) => {
      if (req.method === 'PUT' && req.url === '/api/transactions/subject' && req.headers['x-test-client'] === 'A') {
        requests++;
        if (scenario === 'retry' && requests === 1) {
          req.resume(); res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '本題第一次明確拒絕' })); return;
        }
      }
      app(req, res);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const getRows = async () => { const r = await http(base + '/api/transactions'); assert.equal(r.status, 200); return r.json(); };
    assert.deepEqual(await getRows(), bank ? [initial, initialSibling] : [initial]);
    win = new JSDOM('<!doctype html><nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>',
      { url: base + '/#cashflow', pretendToBeVisual: true }).window;
    for (const key of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event',
      'CustomEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) {
      Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
    }
    win.addEventListener('error', e => { errors.push(e.error?.message || e.message); e.preventDefault(); });
    globalThis.setTimeout = (...args) => { const t = timer(...args); timers.add(t); return t; };
    const boot = new Map([
      ['POST /api/quotes/refresh-auto', { refreshed: false }], ['POST /api/snapshot/auto', { recorded: false, subsRolled: [] }],
      ['POST /api/backup/daily', {}], ['POST /api/accounts/reconcile-names', { changed: 0 }],
      ['POST /api/statement/normalize-auto', { ran: false }], ['GET /api/settings', {}], ['GET /api/mode', { hosted: false }],
      ['GET /api/categories', { 居住: ['房租', '房貸'], 飲食: ['超市', '餐廳'] }],
      ['GET /api/income-categories', { 工作: ['薪資', '獎金'] }],
      ['GET /api/transfer-subcategories', [{ label: '內轉出', role: 'out' }, { label: '內轉入', role: 'in' }]]
    ]);
    globalThis.fetch = (url, init = {}) => {
      const path = String(url), method = init.method || 'GET', key = method + ' ' + path;
      const task = (async () => {
        if (boot.has(key)) return json(boot.get(key));
        assert(['GET /api/transactions', 'GET /api/accounts', 'GET /api/cards', 'GET /api/bank-statement/batches',
          'PUT /api/transactions/subject', 'POST /api/transactions'].includes(key), '未登記請求：' + key);
        const call = { key, body: init.body ? JSON.parse(init.body) : null }; calls.push(call);
        const response = await http(base + path, { ...init, headers: { ...init.headers, 'x-test-client': 'A' } });
        call.status = response.status;
        if (key === 'GET /api/transactions') {
          // 暴露真 HTTP 解析所得的同一列，讓固定基準題能改動舊物件；沒有代造資料庫回應。
          const rows = await response.json(); parsedRows = rows;
          response.json = async () => rows;
        }
        return response;
      })();
      pending.add(task); task.then(() => pending.delete(task), e => { pending.delete(task); errors.push(e.message); });
      return task;
    };
    const appModule = await import(pathToFileURL(source + '/public/app.js').href); await appModule.bootSettled;
    const query = selector => { const el = document.querySelector(selector); assert(el, selector); return el; };
    const settle = () => new Promise(r => timer(r, 0));
    const waitFor = async predicate => {
      for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(r => timer(r, 10)); }
      assert.fail('表單操作未完成：' + JSON.stringify(errors));
    };
    await waitFor(() => document.querySelector('#yearSelDesktop') && pending.size === 0);
    for (const [id, value] of [['yearSelDesktop', '2026'], ['monthSelDesktop', '10']]) {
      query('#' + id).value = value; query('#' + id).dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => pending.size === 0); await settle();
    }
    query('.cashflow-stat-action[data-flow="expense"]').click();
    await waitFor(() => pending.size === 0); await settle();
    const openedRows = parsedRows;
    if (scenario === 'post') query('#addCf').click();
    else query('[data-edit="subject"]').click();
    const form = query('#modalForm');
    if (scenario === 'immutable-baseline') assert.equal(query('#f_summary').value, openedRows.find(x => x.id === 'subject').summary);
    const set = (key, value) => { const el = query('#f_' + key); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
    const writes = () => calls.filter(c => c.key.startsWith('PUT ') || c.key.startsWith('POST '));
    const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const bPatch = {};
    if (['preserve-summary', 'same-field', 'retry'].includes(scenario)) bPatch.summary = bSummary;
    if (['preserve-remark', 'immutable-baseline'].includes(scenario)) bPatch.remark = bRemark;
    if (['preserve-fields', 'no-op'].includes(scenario)) Object.assign(bPatch,
      { date: '2026-10-21', account: '另一合成帳戶', amount: 998.5, type: 'income', category: '工作', subcategory: '薪資', summary: bSummary, remark: bRemark });
    if (scenario === 'number-equivalent') bPatch.amount = 998.5;
    if (scenario.startsWith('classification-') || scenario === 'apply-all') Object.assign(bPatch,
      { type: 'expense', category: '飲食', subcategory: '超市', amount: 998.5 });
    if (scenario === 'apply-summary') bPatch.remark = bRemark;
    if (scenario === 'apply-remark') bPatch.summary = bSummary;
    let bConfirmed = initial;
    if (scenario === 'deleted' || Object.keys(bPatch).length) {
      const r = await http(base + '/api/transactions/subject', { method: scenario === 'deleted' ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' }, ...(scenario === 'deleted' ? {} : { body: JSON.stringify(bPatch) }) });
      assert.equal(r.status, 200);
      bConfirmed = (await getRows()).find(x => x.id === 'subject') || null;
      if (scenario === 'deleted') assert.equal(bConfirmed, null);
      else for (const [key, value] of Object.entries(bPatch)) assert.equal(bConfirmed[key], value, 'B 先確認 ' + key);
    }
    if (['preserve-summary', 'preserve-fields', 'deleted', 'number-equivalent', 'fallback', 'missing', 'retry'].includes(scenario)) set('remark', aRemark);
    if (['preserve-remark', 'same-field', 'immutable-baseline'].includes(scenario)) set('summary', aSummary);
    if (scenario === 'immutable-baseline') {
      const opened = openedRows.find(x => x.id === 'subject');
      assert.equal(opened.summary, initial.summary);
      opened.summary = aSummary;
    }
    if (scenario === 'clear') { set('summary', ''); set('remark', ''); set('account', ''); }
    if (['zero', 'null-amount'].includes(scenario)) set('amount', '0');
    if (scenario === 'negative') set('amount', '-17.25');
    if (scenario === 'number-equivalent') set('amount', '137.00');
    if (scenario === 'classification-sub') set('subcategory', '房貸');
    if (scenario === 'classification-parent') { set('category', '飲食'); set('subcategory', '餐廳'); }
    if (scenario === 'classification-flow') { set('flow', 'income'); set('subcategory', '獎金'); }
    if (scenario === 'classification-transfer') { set('flow', 'transfer'); set('subcategory', '內轉出'); }
    if (scenario === 'no-op') {
      set('summary', aSummary); set('summary', initial.summary);
      set('applySameSummary', 'true'); set('applySameRemark', 'true');
    }
    if (scenario === 'apply-all') set('applyAll', 'true');
    if (scenario === 'apply-summary') { set('summary', aSummary); set('applySameSummary', 'true'); }
    if (scenario === 'apply-remark') { set('remark', aRemark); set('applySameRemark', 'true'); }
    if (scenario === 'post') {
      set('date', '2026-10-22'); set('account', '合成帳戶'); set('amount', '0'); set('summary', aSummary); set('remark', aRemark);
      assert([...query('#f_subcategory').options].some(o => o.value === '薪資'));
      set('subcategory', '薪資'); assert.equal(query('#f_subcategory').value, '薪資');
    }
    if (scenario === 'cancel') {
      set('summary', aSummary); query('[data-cancel]').click(); await settle();
      assert.equal(writes().length, 0); assert.equal(document.querySelector('#modalForm'), null);
    } else {
      submit();
      if (scenario === 'retry') {
        await waitFor(() => writes().length === 1 && writes()[0].status === 503 && !query('button[type="submit"]').disabled);
        assert.equal(query('#modalForm'), form); assert.equal(query('#f_remark').value, aRemark);
        assert.match(query('#toast-root').textContent, /本題第一次明確拒絕/);
        submit();
      }
      await waitFor(() => writes().length === (scenario === 'retry' ? 2 : 1) && writes().at(-1).status
        && (scenario === 'deleted' ? !query('button[type="submit"]').disabled : !document.querySelector('#modalForm')) && pending.size === 0);
      assert.equal(writes().at(-1).status, scenario === 'deleted' ? 404 : 200);
      if (scenario === 'deleted') { assert.equal(query('#modalForm'), form); assert.equal(query('#f_remark').value, aRemark); }
    }
    const saved = await getRows(), actual = saved.find(x => x.id === 'subject') || null;
    process.stdout.write('CASHFLOW_OPERATION_COMPLETED ' + JSON.stringify({ nonce, scenario, bConfirmed, writes: writes(), actual }) + '\n');
    if (scenario === 'deleted') assert.equal(actual, null, '已刪列不復活');
    else if (scenario === 'post') {
      assert.deepEqual(actual, initial); assert.equal(saved.length, 2);
      const { id, ...added } = saved.find(x => x.id !== 'subject'); assert(id);
      assert.deepEqual(added, { date: '2026-10-22', type: 'income', category: '工作', subcategory: '薪資',
        account: '合成帳戶', amount: 0, summary: aSummary, remark: aRemark }, '新增完整 payload');
    } else {
      const expected = { ...bConfirmed };
      if (['preserve-summary', 'preserve-fields', 'number-equivalent', 'fallback', 'missing', 'retry'].includes(scenario)) expected.remark = aRemark;
      if (['preserve-remark', 'same-field', 'immutable-baseline'].includes(scenario)) expected.summary = aSummary;
      if (scenario === 'clear') Object.assign(expected, { summary: '', remark: '', account: '' });
      if (['zero', 'null-amount'].includes(scenario)) expected.amount = 0;
      if (scenario === 'negative') expected.amount = -17.25;
      if (scenario === 'classification-sub') Object.assign(expected, { type: 'expense', category: '居住', subcategory: '房貸' });
      if (scenario === 'classification-parent') Object.assign(expected, { type: 'expense', category: '飲食', subcategory: '餐廳' });
      if (scenario === 'classification-flow') Object.assign(expected, { type: 'income', category: '工作', subcategory: '獎金' });
      if (scenario === 'classification-transfer') Object.assign(expected, { type: 'transfer', category: '內轉', subcategory: '內轉出' });
      if (scenario === 'apply-all') Object.assign(expected, { type: 'expense', category: '居住', subcategory: '房租' });
      if (scenario === 'apply-summary') expected.summary = aSummary;
      if (scenario === 'apply-remark') expected.remark = aRemark;
      assert.deepEqual(actual, expected, '真寫入後保留未修改欄位，並保存本次修改');
      if (scenario === 'no-op') assert.deepEqual(writes()[0].body, {}, '未改欄位不回填');
    }
    if (bank) {
      const other = saved.find(x => x.id === 'sibling'), expected = { ...initialSibling };
      if (scenario === 'apply-all') Object.assign(expected, { category: '居住', subcategory: '房租' });
      if (scenario === 'apply-summary') expected.summary = aSummary;
      if (scenario === 'apply-remark') expected.remark = aRemark;
      assert.deepEqual(other, expected, '單次 PUT 同類套用的回讀');
      const stored = await repo.getDb();
      if (scenario === 'apply-all') assert.deepEqual(stored.learnedBank[subject.bankKey],
        { type: 'expense', category: '居住', subcategory: '房租' }, '分類學習與套用同時保存');
      for (const part of ['summary', 'remark']) if (scenario === 'apply-' + part) {
        assert.equal(stored.settings.cashflowTextRules[part][part === 'summary' ? subject.bankSummary : subject.bankNote],
          part === 'summary' ? aSummary : aRemark, '文字學習與套用同時保存');
      }
    }
    assert.deepEqual(errors, []);
    return { version: 1, nonce, scenario, passed: true };
  } finally {
    await Promise.allSettled([...pending]);
    if (win) win.close();
    for (const t of timers) clearTimeout(t);
    if (server?.listening) { server.closeAllConnections(); await new Promise((res, rej) => server.close(e => e ? rej(e) : res())); }
    globalThis.fetch = http; globalThis.setTimeout = timer;
  }
}
if (process.env.CASHFLOW_EDIT_CASE) {
  const report = await runCase();
  fs.writeFileSync(process.env.CASHFLOW_EDIT_REPORT, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
}
