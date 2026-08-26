// @ts-check
// AI 成本護欄 C1 的專卷（William 2026-08-26 拍板：單張 6 發／單日 20 發／超限擋下＋白話說明）。
// 射程：上限讀取與消毒／每日滾動／take() 的裁決順序與序列化／CAS 重跑純度／transport 擋點
// （take 在 fetch 之前、被擋那發零 fetch＝零費用）／票匣續數（preview 發票寫 aiCalls、apply loadBill）
// ／settings 白名單與備份保留／設定頁接線（頁面模組＝去註解形狀釘）。
// 隔離：STORE_FILE 暫存檔（同 ai-parse.test.js 慣例）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-aibudget-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { AI_BUDGET_DEFAULTS, budgetCaps, rollDaily, makeAiBudget } = await import('../lib/ai-budget.js');
const { makeAnthropicBankEngine } = await import('../lib/ai-transport.js');
const { previewBankStatement, applyBankStatement, aiBankRoute } = await import('../lib/services/bank-import.js');
const { getDb, saveDb, updateAiUsage } = await import('../lib/repo.js');
const { clearAiTicketsForTest, issueAiTicket, redeemAiTicket, restoreAiTicket } = await import('../lib/ai-confirm-ticket.js');
const { sanitizeSettings } = await import('../lib/schema.js');
const { AI_BANK_MODELS, AI_ARBITER_MODEL } = await import('../lib/ai-parse.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

/** 記憶體版每日櫃檯（行為同 repo.updateAiUsage：updater 收整包 settings、回新 aiUsage）。
 * @param {any} [settings] */
function memUsage(settings = {}) {
  const box = { settings: { ...settings } };
  return {
    box,
    updateUsage: async (/** @type {(s:any)=>any} */ updater) => {
      await new Promise((r) => setImmediate(r));   // 模擬真櫃檯的 async 縫——序列化考題靠這道縫抓「並發擠位」
      box.settings = { ...box.settings, aiUsage: updater(box.settings) };
      return box.settings.aiUsage;
    },
  };
}

// ---- 純函式 ----

test('caps｜預設 6/20（拍板值）；合法取整至少 1；0/負數/NaN/字串＝回退預設', () => {
  assert.deepEqual(budgetCaps(undefined), { perBill: 6, perDay: 20 });
  assert.deepEqual({ ...AI_BUDGET_DEFAULTS }, { perBill: 6, perDay: 20 }, '★預設常數＝William 2026-08-26 拍板值');
  assert.deepEqual(budgetCaps({ aiCapPerBill: 3, aiCapPerDay: 50 }), { perBill: 3, perDay: 50 });
  assert.equal(budgetCaps({ aiCapPerBill: 7.9 }).perBill, 7, '取整');
  assert.equal(budgetCaps({ aiCapPerBill: 0.5 }).perBill, 1, '★(0,1) 夾到 1——落回預設 6 會把使用者想調低的上限靜靜調高（預審 C1#2）');
  assert.equal(budgetCaps({ aiCapPerDay: 0.5 }).perDay, 1);
  for (const bad of [0, -1, Number.NaN, 'abc', null, '']) {
    assert.equal(budgetCaps({ aiCapPerBill: bad }).perBill, 6, `壞值 ${String(bad)}＝回預設（0 不是「關掉 AI」的合法寫法）`);
    assert.equal(budgetCaps({ aiCapPerDay: bad }).perDay, 20);
  }
});

test('rollDaily｜同日沿用、換日歸零、壞資料當 0', () => {
  assert.deepEqual(rollDaily({ date: '2026-08-26', n: 5 }, '2026-08-26'), { date: '2026-08-26', n: 5 });
  assert.deepEqual(rollDaily({ date: '2026-08-25', n: 20 }, '2026-08-26'), { date: '2026-08-26', n: 0 }, '★換日＝保險絲自動恢復');
  assert.deepEqual(rollDaily(undefined, '2026-08-26'), { date: '2026-08-26', n: 0 });
  assert.deepEqual(rollDaily({ date: '2026-08-26', n: 'x' }, '2026-08-26'), { date: '2026-08-26', n: 0 });
});

// ---- take() 行為 ----

test('take｜單張上限：到頂那發 throw ai_budget_exceeded、訊息含上限與下一步；被擋那發不佔每日名額', async () => {
  const m = memUsage({ aiCapPerBill: 2, aiCapPerDay: 99 });
  const b = makeAiBudget({ updateUsage: m.updateUsage, today: '2026-08-26' });
  await b.take(); await b.take();
  assert.equal(b.used(), 2);
  await assert.rejects(b.take(), (/** @type {any} */ e) =>
    e.code === 'ai_budget_exceeded' && e.status === 400 && /單張上限/.test(e.message) && /2 發/.test(e.message) && /設定頁/.test(e.message),
    '★白話＋含數字＋含下一步');
  assert.equal(m.box.settings.aiUsage.n, 2, '★被擋那發計數值不變＝沒佔每日名額（單張先擋）');
  assert.equal(b.used(), 2, '被擋不計入單張');
});

test('take｜單日上限：跨兩份帳單合計數；到頂 throw、db 計數不動；換日自動恢復', async () => {
  const m = memUsage({ aiCapPerBill: 9, aiCapPerDay: 3 });
  const b1 = makeAiBudget({ updateUsage: m.updateUsage, today: '2026-08-26' });
  await b1.take(); await b1.take();
  const b2 = makeAiBudget({ updateUsage: m.updateUsage, today: '2026-08-26' });   // 第二份帳單（單張計數歸零）
  await b2.take();
  assert.equal(m.box.settings.aiUsage.n, 3, '兩份帳單共用同一個每日計數');
  await assert.rejects(b2.take(), (/** @type {any} */ e) =>
    e.code === 'ai_budget_exceeded' && /單日上限/.test(e.message) && /3 發/.test(e.message) && /明天/.test(e.message));
  assert.deepEqual(m.box.settings.aiUsage, { date: '2026-08-26', n: 3 }, '★被擋那發計數值不變（真櫃檯對相同值另有 skip 不落盤——見 repo.updateAiUsage 註）');
  assert.equal(b2.used(), 1, '被擋不計入單張');
  const b3 = makeAiBudget({ updateUsage: m.updateUsage, today: '2026-08-27' });   // 隔天
  await b3.take();
  assert.deepEqual(m.box.settings.aiUsage, { date: '2026-08-27', n: 1 }, '★換日歸零重數＝保險絲自動恢復');
});

test('take｜嚴格序列化（真櫃檯）：邊界上兩發並發只放行一發——LOCAL mutate 整段同步、不序列化＝兩個 updater 在增量落地前連跑＝6 變 7', async () => {
  // ⚠️ 刻意用**真的 updateAiUsage**（預審 C1#5）：假櫃檯在 updater 前多一個 await，微任務排序會讓
  //   單張增量先落地＝把「同步連跑」這個洞遮住——拔掉序列化鏈時假櫃檯全綠、真櫃檯 6 變 7。
  const db = await getDb();
  db.settings = { ...db.settings, aiCapPerBill: 6, aiCapPerDay: 99 };
  delete (/** @type {any} */ (db.settings)).aiUsage;
  await saveDb(db);
  const b = makeAiBudget({ updateUsage: updateAiUsage, today: '2026-08-26', billUsed: 5 });
  const results = await Promise.allSettled([b.take(), b.take()]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected'], '★恰一發過、恰一發被擋（拔序列化鏈＝兩發都看到「還剩 1」一起過）');
  assert.equal(b.used(), 6, '★上限 6 就是 6，不會變 7');
  assert.equal(/** @type {any} */ ((await getDb()).settings).aiUsage.n, 1, '每日只記真的放行那發');
});

test('take｜CAS 重跑純度：updater 被重跑兩次＝仍只算一發（副作用不在 updater 裡）', async () => {
  const box = { settings: { aiCapPerBill: 9, aiCapPerDay: 9 } };
  const b = makeAiBudget({
    updateUsage: async (updater) => {
      updater(box.settings);   // 第一跑＝CAS 撞掉、作廢
      box.settings = { ...box.settings, aiUsage: updater(box.settings) };   // 對 fresh 重跑才算數
      return box.settings.aiUsage;
    },
    today: '2026-08-26',
  });
  await b.take();
  assert.equal(b.used(), 1, '★重跑兩次仍只佔一個單張名額');
  assert.equal(box.settings.aiUsage.n, 1, '每日也只算一發');
});

test('loadBill｜apply 兌票續數：載入後單張剩餘跟著縮；壞值當 0', async () => {
  const m = memUsage({ aiCapPerBill: 4, aiCapPerDay: 99 });
  const b = makeAiBudget({ updateUsage: m.updateUsage, today: '2026-08-26' });
  b.loadBill(3);
  assert.equal(b.used(), 3);
  await b.take();
  await assert.rejects(b.take(), (/** @type {any} */ e) => /單張上限/.test(e.message), '3＋1＝4 到頂，第 5 發擋');
  b.loadBill('垃圾');
  assert.equal(b.used(), 0, '壞值當 0（老票沒這欄＝從頭數，寬鬆方向：不會把合法生成誤擋）');
});

// ---- transport 擋點 ----

test('transport｜組裝必帶 budget：漏接當場炸（ai_budget_missing）＝不靜靜不設防', () => {
  assert.throws(() => /** @type {any} */ (makeAnthropicBankEngine)('k'), (/** @type {any} */ e) => e.code === 'ai_budget_missing');
  assert.throws(() => /** @type {any} */ (makeAnthropicBankEngine)('k', {}), (/** @type {any} */ e) => e.code === 'ai_budget_missing');
});

test('transport｜每一發先過 take() 才 fetch；被擋那發零 fetch＝零費用（parseOnce 與 generateRecipe 兩路同款）', async () => {
  const origFetch = globalThis.fetch;
  /** @type {string[]} */ const events = [];
  globalThis.fetch = /** @type {any} */ (async () => { events.push('fetch'); return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) }; });
  try {
    const okBudget = { take: async () => { events.push('take'); } };
    const engine = makeAnthropicBankEngine('k', okBudget);
    await engine.parseOnce('文字', AI_BANK_MODELS.primary);
    assert.deepEqual(events, ['take', 'fetch'], '★順序＝先裁決再出門');
    events.length = 0;
    await engine.generateRecipe('文字', AI_BANK_MODELS.escalation);
    assert.deepEqual(events, ['take', 'fetch'], '★配方生成同一個擋點（四條路全收斂在 transport）');
    events.length = 0;
    const blocked = { take: async () => { throw Object.assign(new Error('今天已經讓 AI 讀滿'), { status: 400, code: 'ai_budget_exceeded' }); } };
    const engine2 = makeAnthropicBankEngine('k', blocked);
    await assert.rejects(engine2.parseOnce('文字', AI_BANK_MODELS.primary), (/** @type {any} */ e) => e.code === 'ai_budget_exceeded');
    assert.deepEqual(events, [], '★被擋那發完全沒打出去＝不花錢');
  } finally { globalThis.fetch = origFetch; }
});

test('transport｜真預算＋stub fetch 端到端：單日上限內照常出門、到頂那發被擋且零 fetch', async () => {
  const origFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = /** @type {any} */ (async () => { fetches++; return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) }; });
  try {
    const m = memUsage({ aiCapPerBill: 9, aiCapPerDay: 2 });
    const budget = makeAiBudget({ updateUsage: m.updateUsage, today: '2026-08-26' });
    const engine = makeAnthropicBankEngine('k', budget);
    await engine.parseOnce('文字', AI_BANK_MODELS.primary);
    await engine.parseOnce('文字', AI_BANK_MODELS.escalation);
    await assert.rejects(engine.parseOnce('文字', AI_BANK_MODELS.primary), (/** @type {any} */ e) => e.code === 'ai_budget_exceeded');
    assert.equal(fetches, 2, '★第三發零 fetch');
    assert.deepEqual(m.box.settings.aiUsage, { date: '2026-08-26', n: 2 });
  } finally { globalThis.fetch = origFetch; }
});

// ---- 票匣續數（preview → apply）----

test('票匣｜aiCalls 進票、restore 整份放回跟著回來；壞值/零＝不入欄', () => {
  clearAiTicketsForTest();
  const id = issueAiTicket({ parsed: { p: 1 }, aiModel: 'm', aiCalls: 3 });
  const t = redeemAiTicket(id);
  assert.equal(t?.aiCalls, 3);
  restoreAiTicket(id, /** @type {any} */ (t));
  assert.equal(redeemAiTicket(id)?.aiCalls, 3, '★放回（apply 失敗）＝計數跟著回來、重試不歸零');
  const id2 = issueAiTicket({ parsed: {}, aiModel: 'm', aiCalls: 0 });
  assert.ok(!('aiCalls' in /** @type {any} */ (redeemAiTicket(id2))), '0＝不入欄（形狀最小）');
  const id3 = issueAiTicket({ parsed: {}, aiModel: 'm', aiCalls: '垃圾' });
  assert.ok(!('aiCalls' in /** @type {any} */ (redeemAiTicket(id3))));
});

test('端到端｜preview 發票寫入 aiBudget.used()；apply 兌票 loadBill(票上的數)＝單張橫跨兩請求數得齊', async () => {
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  /** @type {any} */ (db.settings).aiDualRead = false;
  await saveDb(db);
  const notRecognized = async () => { throw Object.assign(new Error('認不得'), { status: 400 }); };
  const fakeExtract = async () => [{ y: 0, cells: [{ x: 0, s: '合成帳單內文 1,000 500 1,500 3 300 100 200' }] }];
  const answer = {
    bank: '合成一銀', referenceDate: '2026-06-30',
    accountCurrencies: [{ masked: '900200****3302', currency: 'TWD' }],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [{ masked: '900200****3302', balance: 1500, currency: 'TWD', label: '活存', note: '' }],
    transactions: [
      { acctMasked: '900200****3302', date: '2026-06-01', direction: 'in', amount: 1000, balance: 1000, summary: '轉帳存入', note: '' },
      { acctMasked: '900200****3302', date: '2026-06-02', direction: 'out', amount: 500, balance: 500, summary: 'CD提款', note: '' },
      { acctMasked: '900200****3302', date: '2026-06-03', direction: 'in', amount: 1000, balance: 1500, summary: '存款息', note: '' },
    ],
  };
  const engineOf = () => () => ({ models: AI_BANK_MODELS, parseOnce: async () => answer });
  // 假預算（行為核心另有專卷；這裡守的是**接線**：preview 把 used() 寫進票、apply 把票上的數 loadBill 回去）
  const mkFake = (/** @type {number} */ used) => { /** @type {any[]} */ const loads = []; return { loads, budget: { used: () => used, loadBill: (/** @type {any} */ n) => loads.push(n), take: async () => {} } }; };
  const pv = mkFake(2);
  const r = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(), aiExtract: fakeExtract, aiBudget: /** @type {any} */ (pv.budget) });
  assert.ok(r.aiTicket, '有票');
  const ap = mkFake(0);
  const done = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiTicket: r.aiTicket, aiBudget: /** @type {any} */ (ap.budget) });
  assert.equal(done.ok, true);
  assert.deepEqual(ap.loads, [2], '★apply 把 preview 用掉的 2 發載回同一份帳單的額度（各數各的＝單張上限白設）');
});

test('雙讀｜仲裁那發被預算擋下＝照實丟 ai_budget_exceeded（預審 C1#1：不入照實丟名單＝被吞成「三讀不一致」——使用者被誤指去手動記帳，看不到「明天恢復／調上限」）', async () => {
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  /** @type {any} */ (db.settings).aiDualRead = true;   // 雙讀路（預設開的那條）
  await saveDb(db);
  const mk = (/** @type {string} */ d3) => ({
    bank: '合成一銀', referenceDate: '2026-06-30',
    accountCurrencies: [{ masked: '900200****3302', currency: 'TWD' }],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [{ masked: '900200****3302', balance: 1500, currency: 'TWD', label: '活存', note: '' }],
    transactions: [
      { acctMasked: '900200****3302', date: '2026-06-01', direction: 'in', amount: 1000, balance: 1000, summary: '轉帳存入', note: '' },
      { acctMasked: '900200****3302', date: '2026-06-02', direction: 'out', amount: 500, balance: 500, summary: 'CD提款', note: '' },
      { acctMasked: '900200****3302', date: d3, direction: 'in', amount: 1000, balance: 1500, summary: '存款息', note: '' },
    ],
  });
  const budgetErr = () => Object.assign(new Error('今天已經讓 AI 讀滿 20 發（你設的單日上限）……'), { status: 400, code: 'ai_budget_exceeded' });
  const engine = { models: AI_BANK_MODELS, parseOnce: async (/** @type {string} */ _t, /** @type {string} */ model) => {
    if (model === AI_ARBITER_MODEL) throw budgetErr();   // 兩讀成功用掉名額、仲裁那發撞上限（transport 擋下）
    return model === AI_BANK_MODELS.primary ? mk('2026-06-03') : mk('2026-06-04');   // 日期不同＝比對不一致→送仲裁
  } };
  await assert.rejects(
    aiBankRoute('QUFBQQ==', undefined, await getDb(), { engineFactory: () => engine, extract: async () => [{ y: 0, cells: [{ x: 0, s: '1,000 500 1,500 3' }] }] }),
    (/** @type {any} */ e) => e.code === 'ai_budget_exceeded' && /單日上限/.test(e.message),
    '★預算錯原句浮上來（含「明天恢復／調上限」那句白話）——被吞成 ai_disagree「幾個 AI 各自讀出了不同的內容」＝假話＋錯誤指路');
});

// ---- settings 白名單與備份保留 ----

test('settings｜上限兩欄可由 PUT 寫（posnum）；aiUsage＝server-owned：PUT 剝掉、備份匯入保留＋消毒', () => {
  const ok = sanitizeSettings({ aiCapPerBill: 8, aiCapPerDay: 30 });
  assert.equal(/** @type {any} */ (ok).aiCapPerBill, 8);
  assert.equal(/** @type {any} */ (ok).aiCapPerDay, 30);
  const bad = sanitizeSettings({ aiCapPerBill: 'x', aiCapPerDay: -1 });
  assert.ok(!('aiCapPerBill' in bad) && !('aiCapPerDay' in bad), '壞型別＝剝掉（讀取端 capOf 另有預設）');
  const put = sanitizeSettings({ aiUsage: { date: '2026-08-26', n: 5 } });
  assert.ok(!('aiUsage' in put), '★前端 PUT 寫不進每日計數（server-owned；能寫＝保險絲可被歸零）');
  const warns = /** @type {string[]} */ ([]);
  const origWarn = console.warn;
  console.warn = (/** @type {any[]} */ ...args) => { warns.push(args.join(' ')); };
  let imp;
  try { imp = sanitizeSettings({ aiUsage: { date: '2026-08-26', n: 5.7, extra: 'x' } }, { allowIbSyncFields: true }); }
  finally { console.warn = origWarn; }
  assert.deepEqual(/** @type {any} */ (imp).aiUsage, { date: '2026-08-26', n: 5 }, '★備份還原保留＋消毒（只收 date/n、取整）');
  assert.ok(!warns.some((w) => w.includes('aiUsage')), '★保留了就不可回報「剝掉」（Codex #489 r2#4 診斷說謊同族：合法備份被誤判成壞檔）');
  const impBad = sanitizeSettings({ aiUsage: { date: 9, n: 'x' } }, { allowIbSyncFields: true });
  assert.ok(!('aiUsage' in impBad), '壞形狀＝剝掉不硬收');
});

test('repo｜updateAiUsage 櫃檯：updater 收 fresh settings、寫回 settings.aiUsage', async () => {
  const db = await getDb();
  db.settings = { ...db.settings, aiCapPerDay: 7 };
  delete (/** @type {any} */ (db.settings)).aiUsage;
  await saveDb(db);
  const got = await updateAiUsage((settings) => {
    assert.equal(settings.aiCapPerDay, 7, 'updater 看得到整包 settings（上限與用量都要 fresh）');
    return { date: '2026-08-26', n: 1 };
  });
  assert.deepEqual(got, { date: '2026-08-26', n: 1 });
  assert.deepEqual(/** @type {any} */ ((await getDb()).settings).aiUsage, { date: '2026-08-26', n: 1 }, '真的落 db');
});

// ---- 接線形狀（路由與設定頁）----

const decomment = (/** @type {string} */ src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

test('接線｜statement.js：每請求一份預算、engine 工廠閉包同一份、preview/apply 都帶 aiBudget', () => {
  const src = decomment(readFileSync(new URL('../lib/routes/statement.js', import.meta.url), 'utf8'));
  assert.match(src, /makeAiBudget\(\{ updateUsage: updateAiUsage, today: nowLocal\(\)\.date \}\)/, '★真櫃檯＋本地日曆日（UTC 會讓台北早上的「今天」早一天）');
  assert.match(src, /const aiWiring = \(\) => \{\s*const budget = makeAiBudget/, '★預算建在 aiWiring **函式體內**＝每請求一份（吊到模組層＝全站共用一份、單張計數變成跨帳單累積）');
  assert.match(src, /makeAnthropicBankEngine\(key, budget\)/, '★工廠閉包預算＝transport 每發先裁');
  assert.match(src, /aiBudget: budget/, '★同一份也交給服務層（發票寫數／兌票續數）');
  const sites = src.split('aiWiring()').length - 1;
  assert.equal(sites, 2, 'preview 與 apply 各接一次（preview 的串流/非串流分支共用同一份 opts＝同一請求同一份預算，刻意只有一處）');
});

test('接線｜設定頁（頁面模組＝形狀釘）：兩個上限輸入欄＋就地解釋＋onchange 存檔；文案鐵則', () => {
  const src = decomment(readFileSync(new URL('../public/modules/settings.js', import.meta.url), 'utf8'));
  assert.match(src, /id="aiCapPerBill"/, '單張上限輸入欄');
  assert.match(src, /id="aiCapPerDay"/, '單日上限輸入欄');
  assert.match(src, /data-ai-info="budget"/, '就地解釋鈕（必須懂的就地解釋鐵則）');
  assert.match(src, /for \(const capKey of \['aiCapPerBill', 'aiCapPerDay'\]\)/, '★兩欄都接 onchange 存檔迴圈（預審：題名寫存檔、斷言沒釘＝整刪迴圈全綠）');
  assert.match(src, /body: \{ \[capKey\]: n \}/, '★存的就是那一欄、值是驗過的整數');
  for (const banned of ['已限速', '保證正確', '不會超過', '絕不超過']) assert.ok(!src.includes(banned), `文案鐵則：${banned}`);
});

test('接線｜AI_KEY_INFO.budget 就地解釋存在且講清楚「一發」與保險絲語意', async () => {
  const { AI_KEY_INFO } = await import('../public/modules/ai-key-settings.js');
  const b = /** @type {any} */ (AI_KEY_INFO).budget;
  assert.ok(b?.title && b?.html, '有 budget 詞條');
  assert.match(b.html, /一發＝讓 AI 讀一次/, '★先定義單位再講上限');
  assert.match(b.html, /保險絲/, '單日上限的語意（防暴走、不是日常預算）');
  assert.match(b.html, /不花錢|不會送出去/, '撞到上限＝那發不出門');
});
