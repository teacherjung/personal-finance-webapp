// @ts-check
// 開機自動更新依序跑＋集中出聲（public/modules/boot-sequence.js 與 public/app.js 最後那一段；裁示者 2026-09-29 裁「乙」）。
// 後兩題把 app.js 那一段**原封不動**抽出來，配假的 api／toast／router 在 node:vm 裡真的跑——驗的是行為，不是字面。
// 守不到的：真瀏覽器、真伺服器（那一層是隔離伺服器實開與合併後驗收）；假依賴只模擬回應，不模擬畫面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { runBootSteps, bootFailureMessage } from '../public/modules/boot-sequence.js';
import { backupAlertView } from '../public/modules/backup-alert.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 可以從外面決定何時完成的 promise。 */
function deferred() {
  /** @type {(v?: unknown) => void} */ let resolve = () => {};
  /** @type {(e: unknown) => void} */ let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** 讓排好的 promise 鏈往前走幾步。 */
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
/** @param {Promise<unknown>} p */
async function isPending(p) {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  return !settled;
}
const conflict = () => Object.assign(new Error('資料在你操作期間被另一個裝置或分頁改過'), { code: 'kv_conflict' });

// ─── 模組 ───────────────────────────────────────────────────────────────────

test('依序：前一步沒完成，下一步不開始；最後一步沒完成前，整段不可以結束', async () => {
  /** @type {string[]} */ const started = [];
  const d = [deferred(), deferred(), deferred()];
  const done = runBootSteps(['A', 'B', 'C'].map((name, i) => ({ name, run: async () => { started.push(name); await d[i].promise; } })));
  await flush();
  assert.deepEqual(started, ['A'], 'A 還沒完成時 B 不可以開始（同時送出就是互撞的來源）');
  d[0].resolve(); await flush();
  assert.deepEqual(started, ['A', 'B']);
  d[1].resolve(); await flush();
  assert.deepEqual(started, ['A', 'B', 'C']);
  assert.ok(await isPending(done), 'C 還沒完成時整段就結束了＝後面的步驟沒被等（#651 r1 #3 的突變）');
  d[2].resolve();
  assert.deepEqual(await done, []);
});

test('某一步出錯不擋後面的步驟；晚一點才出錯的也要收到', async () => {
  const late = deferred();
  /** @type {string[]} */ const ran = [];
  const done = runBootSteps([
    { name: 'A', run: async () => { ran.push('A'); throw conflict(); } },
    { name: 'B', run: async () => { ran.push('B'); await late.promise; } },
    { name: 'C', run: async () => { ran.push('C'); } },
  ]);
  await flush();
  assert.deepEqual(ran, ['A', 'B'], 'B 還沒結束時 C 不可以開始');
  late.reject(new Error('晚一點才出錯'));
  const failures = await done;
  assert.deepEqual(ran, ['A', 'B', 'C']);
  assert.deepEqual(failures.map((f) => f.name), ['A', 'B']);
});

test('任何錯都算（不猜「連不上」：錯誤型別分不出有沒有收到回應）', async () => {
  const failures = await runBootSteps([
    { name: '連不上', run: async () => { throw new TypeError('Failed to fetch'); } },
    { name: '回應壞掉', run: async () => { throw new TypeError('Decoding failed'); } },
    { name: '互撞', run: async () => { throw conflict(); } },
    { name: '解析失敗', run: async () => { throw new SyntaxError('Unexpected token'); } },
  ]);
  assert.deepEqual(failures.map((f) => f.name), ['連不上', '回應壞掉', '互撞', '解析失敗']);
});

test('提示文字：沒出錯就不出聲；出錯時說出幾項、哪幾項，而且不說「沒完成」「會再跑一次」', () => {
  assert.equal(bootFailureMessage([]), null);
  const msg = bootFailureMessage([{ name: '自動對齊帳戶名', error: conflict() }, { name: '店名規則自動整理', error: conflict() }]);
  assert.equal(msg, '開機時有 2 項自動更新出了問題：自動對齊帳戶名、店名規則自動整理。下次開 App 會再檢查一次。');
  // 回應壞掉時寫入可能已經成功（#651 r1 #2 實測），所以這兩種說法都是講過頭
  assert.doesNotMatch(String(msg), /沒完成|再跑一次/);
});

// ─── app.js 最後那一段，真的跑 ──────────────────────────────────────────────

const BOOT_MARKER = '// 開機自動更新（裁示者 2026-09-29 裁「乙」';
const ENDPOINTS = ['/quotes/refresh-auto', '/snapshot/auto', '/backup/daily', '/accounts/reconcile-names', '/statement/normalize-auto'];

/** 從 app.js 抽出開機那一段（它是檔案的最後一段）；找不到標記＝直接紅，不靜靜跳過。 */
function bootBlock() {
  const src = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  const i = src.indexOf(BOOT_MARKER);
  assert.ok(i >= 0, `app.js 找不到開機那一段的起點標記「${BOOT_MARKER}」——搬家了就把這裡一起改`);
  return src.slice(i);
}

/**
 * 在 vm 裡跑那一段；api 每叫一次就開一個可控的 promise。
 * @param {Record<string, (d: ReturnType<typeof deferred>, state: {settled: boolean}) => void>} [answer] 每個端點怎麼回（沒給＝等測試手動放行；state＝當下 bootSettled 落定了沒）
 */
function startBoot(answer = {}) {
  /** @type {{path: string, d: ReturnType<typeof deferred>}[]} */ const calls = [];
  /** @type {{msg: string, isErr: boolean}[]} */ const toasts = [];
  const settled = { value: false };
  const ctx = vm.createContext({
    api: (/** @type {string} */ path) => { const d = deferred(); calls.push({ path, d }); answer[path]?.(d, { settled: settled.value }); return d.promise; },
    toast: (/** @type {string} */ msg, isErr = false) => { toasts.push({ msg, isErr }); },
    router: () => {},
    _bootResolve: () => { settled.value = true; },
    runBootSteps, bootFailureMessage, backupAlertView,
    icon: () => '', esc: (/** @type {string} */ s) => s,
    document: { getElementById: () => null },
    confirm: () => false,
  });
  const done = /** @type {Promise<void>} */ (vm.runInContext(bootBlock(), ctx));   // 最後一個運算式＝那個 IIFE 回傳的 promise
  return { calls, toasts, settled, done };
}

test('app.js 開機那一段真的一步一步跑：每個端點都等前一個結束才開始，最後一個結束前整段不結束', async () => {
  const replies = [{ refreshed: false }, { recorded: false }, {}, { changed: false }, { ran: false }];
  const boot = startBoot();
  for (let k = 0; k < ENDPOINTS.length; k++) {
    await flush();
    assert.deepEqual(boot.calls.map((c) => c.path), ENDPOINTS.slice(0, k + 1),
      `第 ${k + 1} 步還沒結束時，後面的端點不可以已經送出（把某一步改成不等待就會在這裡紅）`);
    if (k === 1) assert.equal(boot.settled.value, false, '快照結束前 bootSettled 不可以先落定');
    if (k === 2) assert.equal(boot.settled.value, true, '快照那一步結束時 bootSettled 要落定（洞察的時機不變）');
    if (k === ENDPOINTS.length - 1) assert.ok(await isPending(boot.done), '最後一步還沒結束，整段不可以先結束');
    boot.calls[k].d.resolve(replies[k]);
  }
  await boot.done;
  assert.deepEqual(boot.toasts, [], '全部成功時不出聲');
});

test('app.js 開機那一段：出錯的步驟只集中說一次（紅色），每日備份出錯不算進去', async () => {
  const boot = startBoot({
    '/quotes/refresh-auto': (d) => d.resolve({ refreshed: false }),
    '/snapshot/auto': (d) => d.resolve({ recorded: false }),
    '/backup/daily': (d) => d.reject(new Error('備份那一步的錯')),
    '/accounts/reconcile-names': (d) => d.reject(conflict()),
    '/statement/normalize-auto': (d) => d.reject(new TypeError('Failed to fetch')),
  });
  await boot.done;
  assert.deepEqual(boot.calls.map((c) => c.path), ENDPOINTS, '某一步出錯後，後面的步驟照樣要跑');
  assert.equal(boot.toasts.length, 1, '出錯的步驟只集中說一次');
  assert.deepEqual(boot.toasts[0], {
    msg: '開機時有 2 項自動更新出了問題：自動對齊帳戶名、店名規則自動整理。下次開 App 會再檢查一次。',
    isErr: true,
  });
});

test('app.js 開機那一段：前半段（報價、快照）出錯也要收到、跨兩組累積；快照出錯時 bootSettled 照樣在它結束時落定', async () => {
  /** @type {boolean|null} */ let settledWhenBackupStarts = null;
  const boot = startBoot({
    '/quotes/refresh-auto': (d) => d.reject(new Error('報價那一步的錯')),
    '/snapshot/auto': (d) => d.reject(conflict()),
    '/backup/daily': (d, state) => { settledWhenBackupStarts = state.settled; d.resolve({}); },
    '/accounts/reconcile-names': (d) => d.reject(conflict()),
    '/statement/normalize-auto': (d) => d.resolve({ ran: false }),
  });
  await boot.done;
  assert.deepEqual(boot.calls.map((c) => c.path), ENDPOINTS, '前面出錯，後面照樣要跑');
  assert.equal(settledWhenBackupStarts, true,
    '快照那一步出錯時也要在它結束時落定 bootSettled（否則洞察永遠等不到；#651 r2 #1 的突變②）');
  assert.deepEqual(boot.toasts, [{
    msg: '開機時有 3 項自動更新出了問題：自動更新報價、自動記錄快照、自動對齊帳戶名。下次開 App 會再檢查一次。',
    isErr: true,
  }], '前半段的錯不可以被後半段蓋掉（#651 r2 #1 的突變①）');
});
