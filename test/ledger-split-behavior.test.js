// 兩頁「錢的分堆」＝頁面接線的行為考題：銀行收支頁（cashflow.js）只能吃現金流帳本、信用卡費頁（transactions.js）只能吃信用卡帳本
// （判準單一真相＝categories.js isCardTx；分堆的語意見 docs/project-overview.md「收支三層架構」節）。分堆一掉，銀行收支會把刷卡明細算進支出、
// 下期繳卡費再算一次（同一筆錢計兩遍）；信用卡頁會把房租、薪資、繳卡費列進「本月消費」——這裡釘的是畫面上的數字，不是原始碼字串。
//
// 做法＝jsdom 給全域、fetch 假櫃檯餵固定資料、真的 import 整張 app.js 路由圖（開機序列跑完）→ 呼叫 render → 讀畫面。
// 釘的是結果層（兩頁畫面上的分堆結果）：等價的頁面實作也會過；判準呼叫的形狀由兩頁的字面釘題守、判準本身另有考題（categories）。
// 誠實劃界：期望值是畫面字串（wan／money 的格式），格式改版這裡要跟著改；jsdom 全域定在 globalThis、沒有清理，
// 靠 node --test 每檔一個行程隔離，本檔不可與別的考題合檔。
/* global document */   // boot() 把 jsdom 的 document 定到 globalThis（node --test 每檔一個行程）
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { isCardTx } from '../public/modules/categories.js';

const MONTH = '2026-08';
/** 固定資料：舊 note、帳單摘要與帳單備註三者刻意排成不同順序；哪些筆算哪本帳由下面的夾具對照題斷言。 */
const FIXTURE = [
  { id: 'c1', date: '2026-08-03', ledger: 'card', source: 'stmt', type: 'expense', category: '飲食', subcategory: '超市', amount: 1200, account: '台新卡', note: '全聯', stmtRef: 'card1|2026-08-03|1200|全聯' },
  { id: 'c2', date: '2026-08-10', ledger: 'card', source: 'stmt', type: 'expense', category: '交通', subcategory: '加油', amount: 2000, account: '台新卡', note: '加油站', stmtRef: 'card1|2026-08-10|2000|加油站' },
  { id: 'c3', date: '2026-08-15', ledger: 'card', source: 'stmt', type: 'expense', category: '購物', subcategory: '', amount: 3000, account: '台新卡', note: 'PChome', stmtRef: 'card1|2026-08-15|3000|PChome' },
  { id: 'c5', date: '2026-08-21', ledger: 'card', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 500, account: '現金', note: '手動記的刷卡（明確 card、無來源、帳戶不是卡）' },
  { id: 'c4', date: '2026-08-20', source: 'stmt', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 800, account: '台新卡', note: '舊卡消費', stmtRef: 'card1|2026-08-20|800|舊卡消費' },
  { id: 'b1', date: '2026-08-05', ledger: 'cashflow', source: 'bank', type: 'income', category: '工作', subcategory: '薪資', amount: 60000, account: '台新活存', note: 'Z-old-name', bankSummary: 'B-summary', bankNote: 'C-note' },
  { id: 'b2', date: '2026-08-06', ledger: 'cashflow', source: 'bank', type: 'expense', category: '居住', subcategory: '房租', amount: 15000, account: '台新活存', note: 'A-old-name', bankSummary: 'C-summary', bankNote: 'A-note' },
  { id: 'b3', date: '2026-08-12', ledger: 'cashflow', source: 'bank', type: 'expense', category: '', subcategory: '', amount: 6900, account: '台新活存', note: 'C-old-name', bankSummary: 'A-summary', bankNote: 'B-note' },   // 刻意不等於本月消費 7,500
  { id: 'b4', date: '2026-08-18', ledger: 'cashflow', source: 'bank', type: 'transfer', category: '內轉', subcategory: '內轉出', amount: 20000, account: '台新活存', note: 'D-existing-note' },
  { id: 'b5', date: '2026-08-22', ledger: 'cashflow', source: 'stmt', type: 'expense', category: '飲食', subcategory: '超市', amount: 4300, account: '台新卡', note: 'E-existing-note', bankSummary: 'E-summary', bankNote: 'E-note' },
  { id: 'm1', date: '2026-08-25', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 1000, account: '現金', note: 'F-existing-note' },
  { id: 'y1', date: '2025-12-04', ledger: 'cashflow', source: 'bank', type: 'income', category: '工作', subcategory: '薪資', amount: 100, account: '台新活存', note: '去年收入', bankSummary: '去年摘要', bankNote: '去年備註' },
  { id: 'y2', date: '2025-03-09', ledger: 'cashflow', source: 'bank', type: 'expense', category: '居住', subcategory: '房租', amount: 50, account: '台新活存', note: '三月舊說明', bankSummary: '三月摘要', bankNote: '三月備註' },
];
const CARD_IDS = ['c1', 'c2', 'c3', 'c4', 'c5'];
const CASH_IDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'm1', 'y1', 'y2'];
const CASH_MONTH_IDS = ['b1', 'b2', 'b3', 'b4', 'b5', 'm1'];
const CARD_SPEND = 1200 + 2000 + 3000 + 800 + 500;    // 7,500
const BANK_EXPENSE = 15000 + 6900 + 4300 + 1000;       // 27,200（房租＋繳卡費＋b5＋手動聚餐）
const BANK_INCOME = 60000;
// 金額刻意挑成：任何一筆刷卡（最小 500）混進銀行支出、或任何一筆現金流「支出」漏掉，萬元一位小數的字串都會變；
// 內轉本來就不進收支加總，它的去留由明細 id 釘。本月消費 7,500 不等於繳卡費 6,900——摘要數字單獨也有鑑別力。

const API = {
  '/api/transactions': FIXTURE,
  '/api/accounts': [], '/api/cards': [],
  '/api/categories': { 飲食: ['超市', '餐廳'], 交通: ['加油'], 購物: [], 居住: ['房租'] },
  '/api/income-categories': { 工作: ['薪資'] },
  '/api/transfer-subcategories': [],
  '/api/refund-pairs': { pairs: [], unmatchedRefunds: [], rewards: [] },
};

let app;
let lastWrite;
let legacyDropCashflowText = false;
async function boot() {
  if (app) return app;
  const dom = new JSDOM('<!doctype html><html><body><nav id="nav"></nav><button id="snapshotBtn"></button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div></body></html>', { url: 'http://localhost/#cashflow' });
  const win = dom.window;
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  for (const k of ['document', 'window', 'location', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle']) set(k, win[k]);
  set('fetch', async (url, init) => {
    const path = String(url).split('?')[0];
    if (path.startsWith('/api/transactions/') && init?.method === 'PUT') {
      lastWrite = { path, body: JSON.parse(String(init.body)) };
      const id = path.split('/').at(-1);
      const stored = legacyDropCashflowText
        ? Object.fromEntries(Object.entries(lastWrite.body).filter(([key]) => key !== 'summary' && key !== 'remark'))
        : lastWrite.body;
      const current = API['/api/transactions'].find(t => t.id === id);
      const updated = { ...current, ...stored };
      API['/api/transactions'] = API['/api/transactions'].map(t => t.id === id ? updated : t);
      const appliedText = lastWrite.body.applySameSummary || lastWrite.body.applySameRemark
        ? { summary: Number(Boolean(lastWrite.body.applySameSummary)), remark: Number(Boolean(lastWrite.body.applySameRemark)) }
        : undefined;
      return new Response(JSON.stringify({ ...updated, ...(appliedText ? { appliedText } : {}) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = Object.hasOwn(API, path) ? API[path] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  app = await import('../public/app.js');
  await app.bootSettled;
  await new Promise(r => setTimeout(r, 0));
  return app;
}
const text = (sel) => document.querySelector(sel)?.textContent ?? null;
const rowIds = () => [...document.querySelectorAll('tbody [data-edit]')].map(el => el.dataset.edit).sort();
const rowIdsInOrder = () => [...document.querySelectorAll('tbody [data-edit]')].map(el => el.dataset.edit);
const settleRender = async () => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };

test('銀行收支副標：三個詞各開說明窗，關窗歸還焦點且不切換金流', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  await renderCashflow();
  const expectedRows = rowIds();
  const expectedAmounts = [...document.querySelectorAll('.cashflow-stat .stat')].map(el => el.textContent);
  assert.equal(text('.cashflow-head .cashflow-desktop-only'), '掌握每月的真實現金流（收入、支出、內轉）');
  const cases = [
    ['income', '收入', /所選月份.*收入.*薪資/, /內轉.*不算收入/],
    ['expense', '支出', /所選月份.*支出.*房租/, /信用卡刷卡消費另列在信用卡帳本.*銀行實際扣繳卡費/],
    ['transfer', '內轉', /內轉不列入收入與支出.*不影響淨現金流/, /摘要卡只計轉出金額.*列表則同時顯示轉入與轉出/],
  ];
  try {
    for (const [flow, label, first, second] of cases) {
      const opener = document.getElementById(`cashflowInfo-${flow}`);
      assert.equal(opener?.tagName, 'BUTTON');
      assert.equal(opener.getAttribute('type'), 'button');
      assert.equal(opener.getAttribute('aria-haspopup'), 'dialog');
      assert.equal(opener.textContent, label);
      opener.focus();
      opener.click();
      await settleRender();
      assert.equal(text('#modal-root [role="dialog"] h2'), label);
      assert.ok(document.querySelector('#modal-root [role="dialog"]').classList.contains('cashflow-flow-info-modal'));
      const explanation = text('#modal-root .info-body');
      assert.match(explanation, first);
      assert.match(explanation, second);
      if (flow === 'transfer') assert.match(explanation, /無法確認是轉出.*不計入內轉摘要金額/);
      document.querySelector('#modal-root [data-close]').click();
      await settleRender();
      assert.equal(document.querySelector('#modal-root .modal'), null);
      assert.equal(document.activeElement, opener);
      assert.deepEqual(rowIds(), expectedRows);
      assert.deepEqual([...document.querySelectorAll('.cashflow-stat .stat')].map(el => el.textContent), expectedAmounts);
      assert.equal(document.querySelector('.cashflow-stat-action[aria-pressed="true"]').getAttribute('data-flow'), 'all');
    }
  } finally {
    document.querySelector('#modal-root [data-close]')?.click();
    await settleRender();
  }
});

test('銀行收支控制項重繪：卡片順序、選取與焦點保留；焦點移出頁面時不搶回', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  const original = API['/api/transactions'];
  API['/api/transactions'] = structuredClone(FIXTURE.filter(t => t.date.startsWith(MONTH)));
  try {
    await renderCashflow();
    assert.deepEqual([...document.querySelectorAll('.cashflow-stat-action')].map(el => el.dataset.flow),
      ['all', 'income', 'expense', 'transfer'], '卡片的 DOM 與桌機視覺順序相同');
    for (const selector of ['.cashflow-stat-action', '.cashflow-flow-control .chip']) {
      for (const flow of ['income', 'expense', 'transfer', 'all']) {
        const button = document.querySelector(`${selector}[data-flow="${flow}"]`);
        button.focus();
        button.click();
        await settleRender();
        const replacement = document.querySelector(`${selector}[data-flow="${flow}"]`);
        assert.notEqual(replacement, button, '確實走過會替換控制項的重繪');
        assert.equal(document.activeElement, replacement);
        assert.equal(replacement.getAttribute('aria-pressed'), 'true');
        assert.equal(document.querySelectorAll('.cashflow-stat-action[aria-pressed="true"]').length, 1);
        for (const [kind, expected] of Object.entries({ net: '+3.3 萬', income: '6.0 萬', expense: '2.7 萬', transfer: '2.0 萬' })) {
          assert.equal(text(`[data-kind="${kind}"] .stat`), expected, `${selector} ${flow} 篩選不改整月摘要金額`);
        }
      }
    }
    for (const id of ['yearSelDesktop', 'monthSelDesktop', 'yearSel', 'monthSel']) {
      const select = document.getElementById(id);
      select.focus();
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settleRender();
      assert.notEqual(document.getElementById(id), select);
      assert.equal(document.activeElement, document.getElementById(id));
    }
    document.querySelector('.cashflow-stat-action').focus();
    const pending = renderCashflow();
    document.getElementById('snapshotBtn').focus();
    await pending;
    assert.equal(document.activeElement, document.getElementById('snapshotBtn'));
  } finally {
    API['/api/transactions'] = original;
    document.querySelector('.cashflow-flow-control .chip[data-flow="all"]')?.click();
    await settleRender();
  }
});

test('銀行收支同頁重繪：晚回的舊資料不可覆蓋新資料或搶回焦點', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  const originalFetch = globalThis.fetch;
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let readCount = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).split('?')[0] !== '/api/transactions') return originalFetch(url, init);
    const first = ++readCount === 1;
    if (first) await delayed;
    return new Response(JSON.stringify([{ id: first ? 'old-response' : 'new-response',
      date: '2026-08-01', ledger: 'cashflow', type: 'income', amount: first ? 10000 : 20000,
      summary: '合成摘要', remark: '' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const older = renderCashflow();
  try {
    await renderCashflow();
    assert.equal(readCount, 2, '兩代請求都確實開始');
    assert.deepEqual(rowIds(), ['new-response']);
    document.querySelector('.cashflow-stat-action[data-flow="all"]').focus();
    const focused = document.activeElement;
    release();
    await older;
    assert.deepEqual(rowIds(), ['new-response']);
    assert.equal(text('[data-kind="income"] .stat'), '2.0 萬');
    assert.equal(document.activeElement, focused);
  } finally {
    release();
    await older;
    globalThis.fetch = originalFetch;
  }
});

test('銀行收支重疊讀取失敗：最新失敗離開載入中，較舊的失敗不蓋掉成功畫面', async () => {
  const { router } = await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  const originalFetch = globalThis.fetch;
  for (const latestFails of [true, false]) {
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    let reads = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).split('?')[0] !== '/api/transactions') return originalFetch(url, init);
      const first = ++reads === 1;
      if (first) await delayed;
      const fails = first ? !latestFails : latestFails;
      return new Response(JSON.stringify(fails ? { error: '合成失敗 <img src=x onerror=alert(1)>' }
        : [{ id: 'success-response', date: '2026-08-01', ledger: 'cashflow', type: 'income', amount: 20000, summary: '合成摘要' }]),
      { status: fails ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
    };
    const older = router();
    try {
      assert.match(text('#view'), /載入中/);
      await renderCashflow();
      assert.equal(reads, 2, '重疊的兩次讀取確實開始');
      if (latestFails) {
        assert.match(text('#view [role="alert"]'), /載入失敗：合成失敗 <img/);
        assert.equal(document.querySelector('#view img'), null, '錯誤文字不可當 HTML 執行');
      } else {
        assert.deepEqual(rowIds(), ['success-response']);
      }
      const current = document.querySelector('#view').innerHTML;
      release();
      await older;
      assert.equal(document.querySelector('#view').innerHTML, current, '較舊的成功或失敗都不覆蓋最新畫面');
    } finally {
      release();
      await older;
      globalThis.fetch = originalFetch;
      await renderCashflow();
    }
  }
});

test('夾具對照（只餵判準、不碰頁面）：固定資料兩本帳都有、兩半判準都踩到、而「用來源／帳戶名分」這種等價分法會分錯', () => {
  assert.deepEqual(FIXTURE.filter(isCardTx).map(t => t.id).sort(), CARD_IDS);
  assert.deepEqual(FIXTURE.filter(t => !isCardTx(t)).map(t => t.id).sort(), CASH_IDS);
  assert.equal(FIXTURE.find(t => t.id === 'c4').ledger, undefined, 'c4＝缺 ledger 的舊卡匯入，靠 source:stmt 判成 card');
  assert.equal(FIXTURE.find(t => t.id === 'm1').source, undefined, 'm1＝缺 ledger 缺 source 的舊手動列，排除法歸 cashflow');
  const c5 = FIXTURE.find(t => t.id === 'c5'), b5 = FIXTURE.find(t => t.id === 'b5');
  assert.ok(c5.ledger === 'card' && c5.source === undefined && c5.account !== '台新卡', 'c5＝明確 card 但無來源、帳戶不是卡');
  assert.ok(b5.ledger === 'cashflow' && b5.source === 'stmt' && b5.account === '台新卡', 'b5＝明確 cashflow 但來源是帳單、帳戶是卡');
  // 等價分法（頁面若偷換成這些，分堆看起來也「合理」）在這份夾具下會分錯——所以它們過不了後面兩題
  assert.notDeepEqual(FIXTURE.filter(t => t.source === 'stmt').map(t => t.id).sort(), CARD_IDS, '「來源是帳單匯入」不是官方判準');
  assert.notDeepEqual(FIXTURE.filter(t => t.account === '台新卡').map(t => t.id).sort(), CARD_IDS, '「帳戶名是卡」不是官方判準');
  assert.ok(FIXTURE.filter(t => !t.id.startsWith('y')).every(t => t.date.startsWith(MONTH)));
  assert.deepEqual(FIXTURE.filter(t => t.id.startsWith('y')).map(t => t.date).sort(), ['2025-03-09', '2025-12-04'], '同年兩個月份供年／月切換行為題使用');
});

test('銀行收支頁：支出只算現金流帳本（房租＋繳卡費＋手動），刷卡明細一筆都不進來', async () => {
  await boot();
  const { cashflowDescriptionLines } = await import('../public/modules/cashflow-model.js');
  const { sortRows } = await import('../public/modules/tx-sort.js');
  // 先守住夾具的辨識力，避免改資料後錯用排序欄位也得到相同列序；頁面接線仍由點擊後的固定期望值驗證。
  const sortFixture = FIXTURE.filter(t => !isCardTx(t) && t.date.startsWith(MONTH));
  const orderBy = pick => sortRows(sortFixture.map(t => ({ ...t, note: pick(t) })), { key: 'note', dir: 'asc' }).map(t => t.id);
  const summaryOrder = orderBy(t => cashflowDescriptionLines(t).summary);
  const remarkOrder = orderBy(t => cashflowDescriptionLines(t).note);
  const legacyOrder = orderBy(t => t.note);
  assert.notDeepEqual(summaryOrder, remarkOrder, '排序夾具：第一行與第二行必須不同序');
  assert.notDeepEqual(summaryOrder, legacyOrder, '排序夾具：第一行與舊 note 必須不同序');
  assert.notDeepEqual(remarkOrder, legacyOrder, '排序夾具：第二行與舊 note 必須不同序');
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  await renderCashflow();
  assert.equal(document.querySelector('#yearSel').value, MONTH.slice(0, 4));
  assert.equal(document.querySelector('#monthSel').value, MONTH.slice(5, 7));
  assert.equal(document.querySelector('#yearSelDesktop').value, MONTH.slice(0, 4));
  assert.equal(document.querySelector('#monthSelDesktop').value, MONTH.slice(5, 7));
  assert.equal(document.querySelector('.cashflow-period-desktop .chip-row'), null, '桌機不再有獨立的金流按鈕列');
  assert.equal(document.querySelector('.cashflow-controls .chip-row')?.getAttribute('aria-label'), '金流篩選', '手機保留原本的金流按鈕列');
  for (const [kind, flow] of [['income', 'income'], ['expense', 'expense'], ['transfer', 'transfer'], ['net', 'all']]) {
    assert.equal(document.querySelector(`.cashflow-stat[data-kind="${kind}"] .cashflow-stat-action`)?.getAttribute('data-flow'), flow,
      `${kind} 摘要卡應對應 ${flow} 明細`);
  }
  assert.equal(document.querySelector('.cashflow-stat[data-kind="net"] .cashflow-stat-action')?.getAttribute('aria-pressed'), 'true');
  assert.equal(text('[data-kind="expense"] .stat'), '2.7 萬', `支出＝wan(${BANK_EXPENSE})：房租＋繳卡費＋b5＋手動聚餐；任何一筆刷卡混進來就不是 2.7`);
  assert.equal(text('[data-kind="income"] .stat'), '6.0 萬', `收入＝wan(${BANK_INCOME})`);
  assert.equal(text('[data-kind="transfer"] .stat'), '2.0 萬', '月摘要的內轉卡要顯示轉出金額');
  assert.equal(text('[data-kind="net"] .stat'), '+3.3 萬', `結餘＝+wan(${BANK_INCOME - BANK_EXPENSE})`);
  assert.match(text('.cashflow-stat[data-kind="transfer"] h3'), /內轉 只計轉出/);
  assert.equal(text('.cashflow-stat[data-kind="net"] .cashflow-desktop-only'), '淨現金流');
  assert.equal(text('.cashflow-stat[data-kind="net"] .cashflow-mobile-only'), '結餘');
  assert.equal(document.querySelector('.cashflow-stat-action[data-flow="all"]').getAttribute('aria-label'), '淨現金流，顯示全部明細');
  assert.equal(text('.cashflow-summary-head p.cashflow-mobile-only'), '內轉不列入收入與支出');
  assert.equal(document.querySelector('.cashflow-stat-action[data-flow="transfer"]').getAttribute('title'),
    '內轉只計轉出；內轉不列入收入與支出。顯示全部內轉明細');
  assert.deepEqual(rowIds(), CASH_MONTH_IDS, '明細＝所選月份六筆現金流；繳卡費 b3 留在這頁、去年 y1 不混進來');
  const ledgerSection = document.querySelector('.cashflow-ledger-section');
  assert.equal(document.querySelector('.cashflow-summary').nextElementSibling, ledgerSection, '摘要 DOM 要排在明細區塊前面');
  assert.ok(ledgerSection?.firstElementChild?.classList.contains('cashflow-controls'), '篩選要在明細區塊最上方');
  assert.ok(ledgerSection?.querySelector('.cashflow-controls')?.nextElementSibling?.classList.contains('cashflow-mobile-only'));
  assert.equal(text('.cashflow-ledger-head h2'), '收支明細');
  assert.equal(text('.cashflow-ledger-head [aria-live="polite"]'), `${CASH_MONTH_IDS.length} 筆`);

  document.querySelector('.cashflow-stat[data-kind="income"] .cashflow-stat-action')?.click();
  await settleRender();
  assert.deepEqual(rowIds(), ['b1'], '點收入卡應只顯示收入明細');
  assert.equal(document.querySelector('.cashflow-stat[data-kind="income"] .cashflow-stat-action')?.getAttribute('aria-pressed'), 'true');
  document.querySelector('.cashflow-stat[data-kind="expense"] .cashflow-stat-action')?.click();
  await settleRender();
  assert.deepEqual(rowIds(), ['b2', 'b3', 'b5', 'm1'], '點支出卡應只顯示支出明細');
  document.querySelector('.cashflow-stat[data-kind="transfer"] .cashflow-stat-action')?.click();
  await settleRender();
  assert.deepEqual(rowIds(), ['b4'], '點內轉卡應只顯示內轉明細');
  document.querySelector('.cashflow-stat[data-kind="net"] .cashflow-stat-action')?.click();
  await settleRender();
  assert.deepEqual(rowIds(), CASH_MONTH_IDS, '點淨現金流卡應恢復全部明細');

  API['/api/transactions'].push({ id: 'b6', date: '2026-08-19', ledger: 'cashflow', source: 'bank',
    type: 'transfer', dir: 'in', category: '內轉', subcategory: '內轉入', amount: 30000,
    account: '台新活存', bankSummary: '合成轉入', bankNote: '' });
  await renderCashflow();
  assert.equal(text('[data-kind="transfer"] .stat'), '2.0 萬', '同月轉入不應把內轉卡加大');
  API['/api/transactions'] = API['/api/transactions'].filter(t => t.id !== 'b6');
  await renderCashflow();

  const b3 = document.querySelector('[data-edit="b3"]')?.closest('tr');
  assert.equal(b3?.querySelector('td')?.textContent, '8/12', '日期格真的接上月／日格式器');
  assert.equal(b3?.querySelector('.cf-note-summary')?.textContent, 'A-summary');
  assert.equal(b3?.querySelector('.cf-note-remark')?.textContent, 'B-note');
  assert.ok(b3?.querySelector('.cf-note')?.firstElementChild?.classList.contains('cf-note-summary'), '摘要必須是第一行');
  assert.ok(b3?.querySelector('.cf-note')?.lastElementChild?.classList.contains('cf-note-remark'), '備註必須是第二行');

  document.querySelector('th[data-sort="note"]')?.click();
  await settleRender();
  assert.deepEqual(rowIdsInOrder(), ['b3', 'b1', 'b2', 'b4', 'b5', 'm1'], '收支說明升冪要依畫面第一行，不依第二行備註或隱藏的 note');

  const year = document.querySelector('#yearSelDesktop');
  year.value = '2025';
  year.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  await settleRender();
  assert.equal(document.querySelector('#yearSel').value, '2025');
  assert.equal(document.querySelector('#yearSelDesktop').value, '2025');
  assert.equal(document.querySelector('#monthSel').value, '12', '所選年份沒有原月份時，退到該年最新月份');
  assert.equal(document.querySelector('#monthSelDesktop').value, '12');
  assert.equal(text('.cashflow-summary-head strong'), '2025 年 12 月');
  assert.deepEqual(rowIds(), ['y1']);

  const month = document.querySelector('#monthSelDesktop');
  month.value = '03';
  month.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  await settleRender();
  assert.equal(document.querySelector('#yearSel').value, '2025', '換月份不可跳回最新年份');
  assert.equal(document.querySelector('#monthSel').value, '03');
  assert.equal(document.querySelector('#monthSelDesktop').value, '03');
  assert.equal(text('.cashflow-summary-head strong'), '2025 年 3 月');
  assert.deepEqual(rowIds(), ['y2']);
});

test('銀行收支整頁：只剩一欄帳單文字時，第一行退讀舊說明、第二行顯示破折號', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  const original = API['/api/transactions'];
  const base = { date: `${MONTH}-04`, ledger: 'cashflow', source: 'bank', type: 'expense', amount: 100, account: '合成帳戶' };
  try {
    API['/api/transactions'] = [
      { ...base, id: 'half-summary', note: '只有摘要時的舊說明', bankSummary: '不完整的帳單摘要' },
      { ...base, id: 'half-note', note: '只有備註時的舊說明', bankNote: '不完整的帳單備註' },
    ];
    await renderCashflow();
    assert.deepEqual(rowIds(), ['half-note', 'half-summary'], '兩種半份資料都必須真的出現在整頁');
    for (const [id, firstLine] of [['half-summary', '只有摘要時的舊說明'], ['half-note', '只有備註時的舊說明']]) {
      const row = document.querySelector(`[data-edit="${id}"]`)?.closest('tr');
      assert.equal(row?.querySelector('.cf-note-summary')?.textContent, firstLine, `${id} 不可拿半份帳單文字充當完整原文`);
      assert.equal(row?.querySelector('.cf-note-remark')?.textContent, '—', `${id} 沒有可用第二行時須顯示破折號`);
    }
  } finally {
    API['/api/transactions'] = original;
    await renderCashflow();
  }
});

test('銀行收支整頁：第二行缺值或明確清空都顯示破折號', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  const original = API['/api/transactions'];
  const base = { date: `${MONTH}-04`, ledger: 'cashflow', type: 'expense', amount: 100, account: '合成帳戶' };
  try {
    API['/api/transactions'] = [
      { ...base, id: 'manual-empty', note: '舊手動第一行' },
      { ...base, id: 'bank-empty', source: 'bank', note: '銀行舊說明', bankSummary: '銀行摘要', bankNote: '' },
      { ...base, id: 'cleared-remark', source: 'bank', summary: '自訂摘要', remark: '', bankSummary: '原始摘要', bankNote: '不可蓋回的原始備註' },
    ];
    await renderCashflow();
    assert.deepEqual(rowIds(), ['bank-empty', 'cleared-remark', 'manual-empty']);
    for (const [id, firstLine] of [['manual-empty', '舊手動第一行'], ['bank-empty', '銀行摘要'], ['cleared-remark', '自訂摘要']]) {
      const row = document.querySelector(`[data-edit="${id}"]`)?.closest('tr');
      assert.equal(row?.querySelector('.cf-note-summary')?.textContent, firstLine);
      assert.equal(row?.querySelector('.cf-note-remark')?.textContent, '—', `${id} 的第二行不能空白，也不能蓋回原始備註`);
    }
  } finally {
    API['/api/transactions'] = original;
    await renderCashflow();
  }
});

test('銀行收支整頁：換年仍有相同月份時保留月份，不跳到該年最新月份', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  const original = API['/api/transactions'];
  const base = { ledger: 'cashflow', type: 'expense', amount: 100, account: '合成帳戶', note: '年月篩選合成資料' };
  try {
    API['/api/transactions'] = [
      { ...base, id: 'new-aug', date: '2026-08-04' },
      { ...base, id: 'old-aug', date: '2025-08-04' },
      { ...base, id: 'old-dec', date: '2025-12-04' },
    ];
    await renderCashflow();
    const year = document.querySelector('#yearSel');
    year.value = '2026';
    year.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
    await settleRender();
    assert.equal(document.querySelector('#monthSel').value, '08');
    assert.deepEqual(rowIds(), ['new-aug'], '先確定起點是 2026 年 8 月');

    const otherYear = document.querySelector('#yearSel');
    otherYear.value = '2025';
    otherYear.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
    await settleRender();
    assert.equal(document.querySelector('#yearSel').value, '2025');
    assert.deepEqual([...document.querySelector('#monthSel').options].map(option => option.value), ['12', '08'], '目標年份另有更新月份，才能辨認是否保留原月份');
    assert.equal(document.querySelector('#monthSel').value, '08', '換年保留同樣存在的 8 月，不可無條件跳到 12 月');
    assert.equal(text('.cashflow-summary-head strong'), '2025 年 8 月');
    assert.deepEqual(rowIds(), ['old-aug'], '明細也必須真的切到去年 8 月');
  } finally {
    API['/api/transactions'] = original;
    await renderCashflow();
  }
});

test('信用卡費頁：本月消費只算信用卡帳本（含缺 ledger 的舊卡匯入），薪資／房租／繳卡費／內轉都不進來', async () => {
  await boot();
  const { renderTransactions } = await import('../public/modules/transactions.js');
  await renderTransactions();
  assert.equal(document.querySelector('#monthSel').value, MONTH);
  assert.equal(text('[data-kind="spend"] .stat'), '7,500 元', `本月消費＝money(${CARD_SPEND})：五筆刷卡（含無來源的 c5）；不等於繳卡費 6,900`);
  assert.equal(text('[data-kind="count"] .stat'), String(CARD_IDS.length));
  assert.deepEqual(rowIds(), CARD_IDS, '明細＝五筆刷卡；繳卡費 b3 與來源是帳單的 b5 都不在這頁（否則同一筆錢兩頁各算一次）');
  const cats = [...document.querySelectorAll('.credit-category-label')].map(el => el.textContent.replace(/\s+/g, ''));
  assert.deepEqual(cats, ['購物3,000元', '飲食2,500元', '交通2,000元']);
});

test('編輯收支：桌機欄位成對排列，摘要與備註分開寫，舊說明只讀相容', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  await renderCashflow();
  const year = document.querySelector('#yearSel');
  year.value = '2026';
  year.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  await settleRender();

  document.querySelector('[data-edit="b2"]')?.click();
  const labels = [...document.querySelectorAll('#modalForm .form-grid > div > label')].map(el => el.textContent);
  assert.deepEqual(labels.slice(0, 7), ['金流', '日期 *', '銀行帳戶', '金額 *', '分類', '子分類', '摘要']);
  for (const id of ['f_summary', 'f_remark']) {
    assert.ok(document.querySelector('#' + id)?.parentElement?.classList.contains('cashflow-text-divider'),
      `${id} 上方要有獨立分隔線`);
  }
  assert.equal(document.querySelector('#f_applySameSummary')?.closest('.full')?.querySelector('label')?.textContent,
    '相同摘要是否一起修改（目前 0 筆）');
  assert.equal(document.querySelector('#f_applySameRemark')?.closest('.full')?.querySelector('label')?.textContent,
    '相同備註是否一起修改（目前 0 筆）');
  assert.equal(document.querySelector('#f_summary')?.value, 'C-summary');
  assert.equal(document.querySelector('#f_remark')?.value, 'A-note', '銀行備註預設帶入帳單原文');
  document.querySelector('#f_summary').value = '自己寫的摘要';
  document.querySelector('#f_remark').value = '自己補充的備註';
  document.querySelector('#modalForm').dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
  await settleRender();
  assert.equal(lastWrite?.path, '/api/transactions/b2');
  assert.equal(lastWrite?.body.summary, '自己寫的摘要');
  assert.equal(lastWrite?.body.remark, '自己補充的備註');
  assert.equal(Object.hasOwn(lastWrite.body, 'note'), false, '兩行都不可寫入舊說明');
  assert.equal(Object.hasOwn(lastWrite.body, 'bankSummary'), false, '帳單摘要原文不可回送寫入');
  assert.equal(Object.hasOwn(lastWrite.body, 'bankNote'), false, '帳單原文不可回送寫入');
  const saved = document.querySelector('[data-edit="b2"]')?.closest('tr');
  assert.equal(saved?.querySelector('.cf-note-summary')?.textContent, '自己寫的摘要');
  assert.equal(saved?.querySelector('.cf-note-remark')?.textContent, '自己補充的備註');

  document.querySelector('[data-edit="b5"]')?.click();
  assert.equal(document.querySelector('#f_summary')?.value, 'E-summary');
  assert.equal(document.querySelector('#f_remark')?.value, 'E-note');
  document.querySelector('#f_remark').value = '另存備註';
  document.querySelector('#modalForm').dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
  await settleRender();
  assert.equal(lastWrite?.path, '/api/transactions/b5');
  assert.equal(lastWrite?.body.remark, '另存備註');
  assert.equal(Object.hasOwn(lastWrite.body, 'note'), false);

  document.querySelector('[data-edit="m1"]')?.click();
  assert.equal(document.querySelector('#f_summary')?.value, 'F-existing-note', '舊手動記錄讀出第一行');
  assert.equal(document.querySelector('#f_remark')?.value, '', '舊手動記錄沒有第二行');
  document.querySelector('#f_summary').value = '新的手動摘要';
  document.querySelector('#f_remark').value = '新的手動備註';
  document.querySelector('#modalForm').dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
  await settleRender();
  assert.equal(lastWrite?.path, '/api/transactions/m1');
  assert.equal(lastWrite?.body.summary, '新的手動摘要');
  assert.equal(lastWrite?.body.remark, '新的手動備註');
  assert.equal(Object.hasOwn(lastWrite.body, 'note'), false, '舊說明不再寫入');
});

test('舊版服務忽略新欄位時不可誤報儲存成功，編輯窗須保留', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  await renderCashflow();
  legacyDropCashflowText = true;
  document.querySelector('[data-edit="b3"]')?.click();
  document.querySelector('#f_summary').value = '修改後摘要';
  document.querySelector('#f_remark').value = '修改後備註';
  document.querySelector('#modalForm').dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
  await settleRender();
  assert.ok(document.querySelector('#modal-root #modalForm'), '未儲存的新文字必須留在表單內');
  assert.match(text('#toast-root .toast:last-child'), /摘要.*備註.*未儲存/);
  const row = document.querySelector('[data-edit="b3"]')?.closest('tr');
  assert.equal(row?.querySelector('.cf-note-summary')?.textContent, 'A-summary');
  assert.equal(row?.querySelector('.cf-note-remark')?.textContent, 'B-note');
  legacyDropCashflowText = false;
});

test('勾選相同摘要與備註後，編輯請求確實帶上兩個明確選項', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  API['/api/transactions'].push({ ...FIXTURE.find(t => t.id === 'b2'), id: 'b2-sibling', date: '2026-08-07' });
  await renderCashflow();
  document.querySelector('[data-edit="b2"]')?.click();
  assert.equal(document.querySelector('#f_applySameSummary')?.closest('.full')?.querySelector('label')?.textContent,
    '相同摘要是否一起修改（目前 1 筆）');
  assert.equal(document.querySelector('#f_applySameRemark')?.closest('.full')?.querySelector('label')?.textContent,
    '相同備註是否一起修改（目前 1 筆）');
  document.querySelector('#f_summary').value = '同步後摘要';
  document.querySelector('#f_remark').value = '同步後備註';
  document.querySelector('#f_applySameSummary').value = 'true';
  document.querySelector('#f_applySameRemark').value = 'true';
  document.querySelector('#modalForm').dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
  await settleRender();
  assert.equal(lastWrite?.body.applySameSummary, true);
  assert.equal(lastWrite?.body.applySameRemark, true);
  API['/api/transactions'] = API['/api/transactions'].filter(t => t.id !== 'b2-sibling');
});

test('只有帶完整帳單原文的編輯提示才宣稱未來相同原文匯入會套用', async () => {
  await boot();
  const { renderCashflow } = await import('../public/modules/cashflow.js');
  await renderCashflow();
  document.querySelector('[data-edit="b2"]')?.click();
  document.querySelector('#f_summary').value = '再改摘要';
  document.querySelector('#f_applySameSummary').value = 'true';
  document.querySelector('#modalForm').dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
  await settleRender();
  assert.match(text('#toast-root .toast:last-child'), /未來相同帳單原文匯入也適用/);

  document.querySelector('[data-edit="m1"]')?.click();
  document.querySelector('#f_summary').value = '手動改摘要';
  document.querySelector('#f_applySameSummary').value = 'true';
  document.querySelector('#modalForm').dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
  await settleRender();
  const manualToast = text('#toast-root .toast:last-child');
  assert.match(manualToast, /摘要同步 1 筆/);
  assert.doesNotMatch(manualToast, /未來相同帳單原文匯入也適用/);
});
