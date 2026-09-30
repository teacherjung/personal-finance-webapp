// @ts-check
// 開機自動更新（public/modules/boot-sequence.js 與 public/app.js 最後那一段；裁示者 2026-09-29 裁「乙」、2026-09-30 再裁兩則：
// 不跳提示、改在總覽寫出狀態（#651 留言 5903711899）；每次請求有等待上限、洞察等五步全部做完（#651 留言 5903712093））。
// app.js 那一段**原封不動**抽出來（連同 bootSettled 的宣告），配假的 api／toast／router 在 node:vm 裡真的跑——驗的是行為，不是字面。
// 守不到的：真瀏覽器、真伺服器（那一層是隔離伺服器實開與合併後驗收）；總覽區塊怎麼畫（dashboard.js 只負責把文字放進去）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { runBootSteps, withTimeout, bootStatusView, BOOT_REQUEST_TIMEOUT_MS } from '../public/modules/boot-sequence.js';
import { backupAlertView } from '../public/modules/backup-alert.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 可以從外面決定何時完成的 promise。 */
function deferred() {
  /** @type {(v?: unknown) => void} */ let resolve = () => {};
  /** @type {(e: unknown) => void} */ let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** 讓排好的 promise 鏈往前走。 */
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
/** @param {Promise<unknown>} p */
async function isPending(p) {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  return !settled;
}
/** p 在 ms 內沒結束就以 msg 失敗（卡住的考題要當場紅，不能讓整份考卷掛著）。 @template T @param {Promise<T>} p @param {number} ms @param {string} msg @returns {Promise<T>} */
function within(p, ms, msg) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })])
    .finally(() => clearTimeout(t));
}
/** vm 裡建的物件原型不同，deepStrictEqual 前先轉成一般物件。 @param {unknown} x */
const plain = (x) => JSON.parse(JSON.stringify(x));
const conflict = () => Object.assign(new Error('資料在你操作期間被另一個裝置或分頁改過'), { code: 'kv_conflict' });
const timeoutError = () => Object.assign(new Error('等超過 30 秒沒有回應'), { name: 'BootTimeoutError' });
/** 本地時間的 ISO 字串（考題不綁時區）。 */
const localIso = (/** @type {number[]} */ ...p) => new Date(p[0], p[1] - 1, p[2], p[3], p[4]).toISOString();

// ─── 模組：依序、等待上限 ───────────────────────────────────────────────────

test('依序：前一步沒完成，下一步不開始；最後一步沒完成前，整段不可以結束', async () => {
  /** @type {string[]} */ const started = [];
  const d = [deferred(), deferred(), deferred()];
  const done = runBootSteps(['A', 'B', 'C'].map((key, i) => ({ key, run: async () => { started.push(key); await d[i].promise; return i; } })));
  await flush();
  assert.deepEqual(started, ['A'], 'A 還沒完成時 B 不可以開始（同時送出就是互撞的來源）');
  d[0].resolve(); await flush();
  assert.deepEqual(started, ['A', 'B']);
  d[1].resolve(); await flush();
  assert.deepEqual(started, ['A', 'B', 'C']);
  assert.ok(await isPending(done), 'C 還沒完成時整段就結束了＝後面的步驟沒被等（#651 r1 #3 的突變）');
  d[2].resolve();
  assert.deepEqual(await done, { A: { ok: true, value: 0 }, B: { ok: true, value: 1 }, C: { ok: true, value: 2 } });
});

test('某一步出錯不擋後面的步驟；晚一點才出錯的也要收到；任何錯都算（錯誤型別分不出有沒有收到回應）', async () => {
  const late = deferred();
  /** @type {string[]} */ const ran = [];
  const done = runBootSteps([
    { key: 'A', run: async () => { ran.push('A'); throw conflict(); } },
    { key: 'B', run: async () => { ran.push('B'); await late.promise; } },
    { key: 'C', run: async () => { ran.push('C'); throw new TypeError('Decoding failed'); } },
    { key: 'D', run: async () => { ran.push('D'); throw new SyntaxError('Unexpected token'); } },
  ]);
  await flush();
  assert.deepEqual(ran, ['A', 'B'], 'B 還沒結束時 C 不可以開始');
  late.reject(new TypeError('Failed to fetch'));
  const results = await done;
  assert.deepEqual(ran, ['A', 'B', 'C', 'D']);
  assert.deepEqual(Object.entries(results).map(([k, r]) => [k, r.ok]), [['A', false], ['B', false], ['C', false], ['D', false]]);
});

test('withTimeout：等太久就丟 BootTimeoutError；先回來的照原樣回（成功或失敗）；結束時把計時器收掉', async () => {
  const never = new Promise(() => {});
  await assert.rejects(withTimeout(never, 20), (/** @type {any} */ e) => e.name === 'BootTimeoutError' && /沒有回應/.test(e.message));
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000), 'ok');
  await assert.rejects(withTimeout(Promise.reject(conflict()), 1000), (/** @type {any} */ e) => e.code === 'kv_conflict');
  // 計時器沒收＝每一步都留一個 30 秒的計時器掛著（在 node 會讓程序多等 30 秒才結束）
  const realClear = globalThis.clearTimeout;
  let cleared = 0;
  globalThis.clearTimeout = /** @type {any} */ ((/** @type {any} */ t) => { cleared++; return realClear(t); });
  try { await withTimeout(Promise.resolve(1), 60_000); } finally { globalThis.clearTimeout = realClear; }
  assert.equal(cleared, 1, '先回來時要把那個計時器收掉');
  assert.equal(BOOT_REQUEST_TIMEOUT_MS, 30_000, '上限＝30 秒（裁示操作化，#651 留言 5903712093）');
});

// ─── 模組：總覽「開 App 自動更新」區塊的文字 ─────────────────────────────────

const AT = localIso(2026, 9, 30, 14, 3);
/** @param {Record<string, any>} results @param {string|null} [quotesLastAt] */
const view = (results, quotesLastAt = null) => bootStatusView({ at: AT, results, quotesLastAt });
const ok = (/** @type {any} */ value) => ({ ok: true, value });
const bad = (/** @type {unknown} */ error) => ({ ok: false, error });
const ALL_OK = {
  quotes: ok({ refreshed: true, updated: 3 }),
  snapshot: ok({ recorded: true, snap: { date: '2026-09-01' }, daily: { date: '2026-09-30' }, subsRolled: [{}, {}] }),
  backup: ok(undefined),
  accounts: ok({ changed: 3 }),
  storeNames: ok({ outcome: 'applied', bits: ['12 筆說明', '2 筆店家身分'], forced: false }),
};

test('狀態區塊：全部做成＋有變動時，每一行寫出做了什麼；每日備份不列（雲端不做備份，列了就等於暗示有）', () => {
  const v = view(ALL_OK, localIso(2026, 9, 30, 14, 3));
  assert.equal(v.checkedAt, '9/30 14:03');
  assert.deepEqual(v.rows, [
    { label: '報價', ok: true, text: '已更新（9/30 14:03）' },
    { label: '快照', ok: true, text: '本月快照 9/1；今天的淨資產已記' },
    { label: '訂閱續費日', ok: true, text: '這次把 2 筆過期的推到下一期' },
    { label: '帳戶名', ok: true, text: '這次更新了 3 筆交易的帳戶名或說明' },
    { label: '店名規則', ok: true, text: '規則有更新，整理了 12 筆說明、2 筆店家身分' },
  ]);
  assert.ok(!JSON.stringify(v).includes('備份'));
});

test('狀態區塊：沒有變動時照樣寫出檢查過了', () => {
  const v = view({
    quotes: ok({ refreshed: false, updated: 0, reason: 'fresh' }),
    snapshot: ok({ recorded: false, snap: { date: '2026-09-01' }, daily: null, subsRolled: [] }),
    accounts: ok({ changed: 0 }),
    storeNames: ok({ outcome: 'unchanged' }),
  }, localIso(2026, 9, 30, 13, 40));
  assert.deepEqual(v.rows.map((r) => [r.ok, r.text]), [
    [true, '9/30 13:40 更新過，一小時內不重抓'],
    [true, '本月快照 9/1'],
    [true, '沒有過期的'],
    [true, '都已是最新'],
    [true, '規則沒變，不用整理'],
  ]);
});

test('狀態區塊：出問題的那一行標出來（ok:false），只說「出了問題」不說「沒做成」；逾時寫出等了多久', () => {
  const v = view({
    quotes: bad(timeoutError()),
    snapshot: bad(conflict()),
    accounts: bad(new TypeError('Failed to fetch')),
    storeNames: bad(conflict()),
  }, localIso(2026, 9, 29, 22, 10));
  assert.deepEqual(v.rows.map((r) => [r.label, r.ok, r.text]), [
    ['報價', false, '這次等超過 30 秒沒有回應；目前是 9/29 22:10 的報價'],
    ['快照', false, '這次出了問題'],
    ['訂閱續費日', false, '這次出了問題'],
    ['帳戶名', false, '這次出了問題'],
    ['店名規則', false, '這次出了問題'],
  ]);
  // 回應壞掉時寫入可能已經成功（#651 r1 #2 實測）；「下次會補」在報價一小時內、店名同版規則、當天月快照三種情況不成立（#651 複審後掃）
  assert.doesNotMatch(JSON.stringify(v), /沒做成|沒完成|再跑一次|再檢查一次/);
});

test('狀態區塊：報價抓不到新的、快照遇到電腦日期倒退、報價時間讀不到', () => {
  const noData = view({ ...ALL_OK, quotes: ok({ refreshed: false, updated: 0, reason: 'no-data' }) }, localIso(2026, 9, 28, 9, 5));
  assert.deepEqual(noData.rows[0], { label: '報價', ok: false, text: '這次抓不到新報價，沿用 9/28 09:05 的報價' });
  const noTime = view({ ...ALL_OK, quotes: ok({ refreshed: false, reason: 'error' }) }, null);
  assert.deepEqual(noTime.rows[0], { label: '報價', ok: false, text: '這次抓不到新報價，沿用舊的報價' });
  const refreshedNoTime = view(ALL_OK, null);
  assert.equal(refreshedNoTime.rows[0].text, '已更新（9/30 14:03）', '讀不到報價時間時，用這次檢查的時間');
  const back = view({ ...ALL_OK, snapshot: ok({ recorded: false, snap: null, daily: null, skipped: '2026-10-02' }) });
  assert.deepEqual(back.rows.slice(1, 3).map((r) => [r.ok, r.text]), [
    [false, '電腦日期比已記錄的資料還早，這次沒有記（請確認電腦時間）'],
    [false, '這次沒有檢查（電腦日期比已記錄的資料還早）'],
  ]);
});

test('狀態區塊：店名規則的每一種結果', () => {
  /** @param {any} value */
  const store = (value) => view({ ...ALL_OK, storeNames: ok(value) }).rows[4];
  assert.deepEqual(store({ outcome: 'applied', bits: [], forced: true }), { label: '店名規則', ok: true, text: '規則有更新，已套用' });
  assert.deepEqual(store({ outcome: 'applied', bits: [], forced: false }), { label: '店名規則', ok: true, text: '規則有更新，沒有需要整理的' });
  assert.deepEqual(store({ outcome: 'declined' }), { label: '店名規則', ok: false, text: '規則有更新，你選了先不套用（下次開 App 會再問你）' });
  assert.deepEqual(store({ outcome: 'blocked' }), { label: '店名規則', ok: false, text: '這次沒有套用（確認過了仍被擋下），資料沒有變動' });
  assert.deepEqual(store({ outcome: 'unknown' }), { label: '店名規則', ok: false, text: '這次沒有套用（伺服器回了一個目前看不懂的狀況），資料沒有變動' });
});

// ─── app.js 最後那一段，真的跑 ──────────────────────────────────────────────

const SETTLE_MARKER = '// 開機序列落定信號（每日洞察引擎 D3/D4';
const BOOT_MARKER = '// 開機自動更新（裁示者 2026-09-29 裁「乙」';
const STEPS = ['/quotes/refresh-auto', '/snapshot/auto', '/backup/daily', '/accounts/reconcile-names', '/statement/normalize-auto'];
const ENDPOINTS = [...STEPS, '/settings'];

/** 從 app.js 抽出 bootSettled 的宣告＋開機那一段（檔案最後一段）；找不到標記＝直接紅，不靜靜跳過。 */
function bootBlock() {
  const src = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  const i = src.indexOf(SETTLE_MARKER);
  assert.ok(i >= 0, `app.js 找不到開機那一段的起點標記「${SETTLE_MARKER}」——搬家了就把這裡一起改`);
  assert.ok(src.indexOf(BOOT_MARKER) > i, `app.js 找不到「${BOOT_MARKER}」，或它跑到落定信號前面了`);
  const block = src.slice(i);
  assert.equal(block.split('export const bootSettled').length, 2, 'bootSettled 的宣告要剛好一個');
  return block.replace('export const bootSettled', 'const bootSettled');   // vm 跑的是 script，不認 export
}

test('app.js：開機那五個請求只出現在最後那一段（前面若留一份同時送出的舊流程，下面幾題抽不到它）', () => {
  const src = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  const i = src.indexOf(SETTLE_MARKER);
  for (const path of STEPS) assert.ok(!src.slice(0, i).includes(`'${path}'`), `${path} 出現在開機那一段前面`);
});

/**
 * 在 vm 裡跑那一段；api 每叫一次就開一個可控的 promise。
 * @param {{ answer?: Record<string, (d: ReturnType<typeof deferred>, body: any) => void>, timeoutMs?: number,
 *   confirm?: () => boolean, getElementById?: (id: string) => any }} [opts]
 *   answer＝每個端點怎麼回（沒給＝等測試手動放行）
 */
function startBoot(opts = {}) {
  /** @type {{path: string, opts: any, d: ReturnType<typeof deferred>}[]} */ const calls = [];
  /** @type {{msg: string, isErr: boolean}[]} */ const toasts = [];
  /** @type {number[]} */ const routerAt = [];   // router() 被叫時已經送出幾個請求＝是哪一步叫的
  let confirms = 0;
  const ctx = vm.createContext({
    api: (/** @type {string} */ path, /** @type {any} */ o) => {
      const d = deferred(); calls.push({ path, opts: o, d }); opts.answer?.[path]?.(d, o?.body); return d.promise;
    },
    toast: (/** @type {string} */ msg, isErr = false) => { toasts.push({ msg, isErr }); },
    router: () => { routerAt.push(calls.length); },
    runBootSteps, withTimeout, backupAlertView, BOOT_REQUEST_TIMEOUT_MS: opts.timeoutMs ?? BOOT_REQUEST_TIMEOUT_MS,
    icon: () => '', esc: (/** @type {string} */ s) => s,
    document: { getElementById: opts.getElementById ?? (() => null) },
    confirm: () => { confirms++; return opts.confirm ? opts.confirm() : false; },
  });
  const done = /** @type {Promise<void>} */ (vm.runInContext(bootBlock(), ctx));   // 最後一個運算式＝那個 IIFE 回傳的 promise
  const settled = /** @type {Promise<any>} */ (vm.runInContext('bootSettled', ctx));
  return { calls, toasts, routerAt, done, settled, confirmCount: () => confirms };
}
const quiet = {
  '/quotes/refresh-auto': (/** @type {any} */ d) => d.resolve({ refreshed: false, reason: 'fresh' }),
  '/snapshot/auto': (/** @type {any} */ d) => d.resolve({ recorded: false, snap: { date: '2026-09-01' }, daily: null, subsRolled: [] }),
  '/backup/daily': (/** @type {any} */ d) => d.resolve({}),
  '/accounts/reconcile-names': (/** @type {any} */ d) => d.resolve({ changed: 0 }),
  '/statement/normalize-auto': (/** @type {any} */ d) => d.resolve({ ran: false }),
  '/settings': (/** @type {any} */ d) => d.resolve({ quotesLastAt: '2026-09-30T05:40:00.000Z' }),
};

test('app.js：每個請求都等前一個結束才送；五步都用 POST；bootSettled 等到最後一個請求結束才落定，帶著各步結果', async () => {
  const replies = [{ refreshed: false, reason: 'fresh' }, { recorded: false, snap: null, daily: null, subsRolled: [] },
    {}, { changed: 0 }, { ran: false }, { quotesLastAt: null }];
  const boot = startBoot();
  for (let k = 0; k < ENDPOINTS.length; k++) {
    await flush();
    assert.deepEqual(boot.calls.map((c) => c.path), ENDPOINTS.slice(0, k + 1),
      `第 ${k + 1} 個請求還沒結束時，後面的不可以已經送出（把某一步改成不等待就會在這裡紅）`);
    assert.ok(await isPending(boot.settled), `第 ${k + 1} 個請求還沒結束，bootSettled 不可以先落定（洞察會跟後面幾步搶寫入）`);
    boot.calls[k].d.resolve(replies[k]);
  }
  const report = await boot.settled;
  await boot.done;
  assert.deepEqual(boot.calls.slice(0, 5).map((c) => c.opts?.method), ['POST', 'POST', 'POST', 'POST', 'POST']);
  assert.equal(boot.calls[5].opts?.method, undefined, '讀報價時間是 GET');
  assert.deepEqual(Object.keys(report.results), ['quotes', 'snapshot', 'backup', 'accounts', 'storeNames']);
  assert.equal(typeof report.at, 'string');
});

test('app.js：全部做成而且有變動——**不跳任何提示**，照舊重繪；結果交給 bootSettled', async () => {
  const boot = startBoot({ answer: {
    ...quiet,
    '/quotes/refresh-auto': (d) => d.resolve({ refreshed: true, updated: 2 }),
    '/snapshot/auto': (d) => d.resolve({ recorded: true, snap: { date: '2026-09-30' }, daily: {}, subsRolled: [{ id: 's1' }] }),
    '/accounts/reconcile-names': (d) => d.resolve({ changed: 4 }),
    '/statement/normalize-auto': (d) => d.resolve({ ran: true, changed: 7 }),
  } });
  const report = await boot.settled;
  await boot.done;
  assert.deepEqual(boot.toasts, [], '開機那幾步不跳提示（裁示 #651 留言 5903711899）');
  assert.deepEqual(boot.routerAt, [2, 4, 5], '快照、帳戶名、店名三步各自有變動就重繪（報價更新併進快照那一步的重繪）');
  assert.equal(report.quotesLastAt, '2026-09-30T05:40:00.000Z');
  assert.deepEqual(plain(report.results.storeNames), { ok: true, value: { outcome: 'applied', bits: ['7 筆說明'], forced: false } });
  assert.deepEqual(plain(report.results.snapshot.value.subsRolled), [{ id: 's1' }]);
});

test('app.js：出錯也不跳提示；每一步的錯各自記在結果裡；快照出錯但報價更新過照樣重繪；每日備份連不上不算錯', async () => {
  const boot = startBoot({ answer: {
    ...quiet,
    '/quotes/refresh-auto': (d) => d.resolve({ refreshed: true }),
    '/snapshot/auto': (d) => d.reject(conflict()),
    '/backup/daily': (d) => d.reject(new TypeError('Failed to fetch')),
    '/accounts/reconcile-names': (d) => d.reject(conflict()),
    '/statement/normalize-auto': (d) => d.reject(new TypeError('Failed to fetch')),
    '/settings': (d) => d.reject(new TypeError('Failed to fetch')),
  } });
  const report = await boot.settled;
  await boot.done;
  assert.deepEqual(boot.calls.map((c) => c.path), ENDPOINTS, '前面出錯，後面照樣要跑');
  assert.deepEqual(boot.toasts, []);
  assert.deepEqual(boot.routerAt, [2], '快照失敗、報價更新過 → 照樣重繪');
  assert.deepEqual(Object.fromEntries(Object.entries(report.results).map(([k, r]) => [k, r.ok])),
    { quotes: true, snapshot: false, backup: true, accounts: false, storeNames: false });
  assert.equal(report.quotesLastAt, null, '讀不到報價時間＝null，不是整段失敗');
});

test('app.js：某個請求一直不回——等到上限就算這一步出了問題、接著做下一步', async () => {
  const boot = startBoot({ timeoutMs: 20, answer: { ...quiet, '/snapshot/auto': () => { /* 永遠不回 */ } } });
  const report = await within(boot.settled, 2000, '等不到 bootSettled＝卡住的那個請求把整條隊擋住了（沒有等待上限）');
  await boot.done;
  assert.deepEqual(boot.calls.map((c) => c.path), ENDPOINTS, '卡住的那一步之後，後面照樣要跑（#651 複審後掃：隊首阻塞）');
  assert.equal(report.results.snapshot.ok, false);
  assert.equal(/** @type {any} */ (report.results.snapshot).error.name, 'BootTimeoutError');
  assert.deepEqual(boot.toasts, []);
});

test('app.js：每日備份畫警告框時出錯，只算那一步，不擋後面兩步', async () => {
  const boot = startBoot({ answer: quiet, getElementById: () => { throw new Error('畫面壞了'); } });
  const report = await boot.settled;
  await boot.done;
  assert.deepEqual(boot.calls.map((c) => c.path), ENDPOINTS);
  assert.equal(report.results.backup.ok, false);
  assert.equal(report.results.storeNames.ok, true);
});

test('app.js：店名規則要蓋掉教過的東西——問使用者；按確定＝帶 force 再送一次、回他一句（唯一留下的提示）', async () => {
  const boot = startBoot({ confirm: () => true, answer: {
    ...quiet,
    '/statement/normalize-auto': (d, body) => d.resolve(body?.force
      ? { ran: true, changed: 0 }
      : { needsConfirmation: true, learnedConflicts: [{ key: '全聯', kept: '超市', dropped: '日用品' }], learnedConflictTotal: 1 }),
  } });
  const report = await boot.settled;
  await boot.done;
  assert.equal(boot.confirmCount(), 1);
  const store = boot.calls.filter((c) => c.path === '/statement/normalize-auto');
  assert.deepEqual(plain(store.map((c) => c.opts)), [{ method: 'POST' }, { method: 'POST', body: { force: true } }]);
  assert.deepEqual(boot.toasts, [{ msg: '店名規則已更新並套用 ✨', isErr: false }], '問過他就要回話（他剛按下不可逆的那一步）');
  assert.deepEqual(plain(report.results.storeNames.value), { outcome: 'applied', bits: [], forced: true });
});

test('app.js：店名規則要蓋掉教過的東西——按取消＝不套用、不再送、不跳提示，狀態記成「先不套用」', async () => {
  const boot = startBoot({ confirm: () => false, answer: {
    ...quiet,
    '/statement/normalize-auto': (d) => d.resolve({ needsConfirmation: true, learnedConflicts: [], learnedNameChanges: [] }),
  } });
  const report = await boot.settled;
  await boot.done;
  assert.equal(boot.calls.filter((c) => c.path === '/statement/normalize-auto').length, 1);
  assert.deepEqual(boot.toasts, []);
  assert.deepEqual(plain(report.results.storeNames.value), { outcome: 'declined' });
});

test('app.js：店名規則回了看不懂的狀況——沒問過就不跳提示、狀態記成 unknown', async () => {
  const boot = startBoot({ answer: { ...quiet, '/statement/normalize-auto': (d) => d.resolve({ needsConfirmation: 'future-reason' }) } });
  const report = await boot.settled;
  await boot.done;
  assert.equal(boot.confirmCount(), 0);
  assert.deepEqual(boot.toasts, []);
  assert.deepEqual(plain(report.results.storeNames.value), { outcome: 'unknown' });
});
