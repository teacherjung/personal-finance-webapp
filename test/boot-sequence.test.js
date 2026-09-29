// @ts-check
// 開機自動更新依序跑＋集中出聲（public/modules/boot-sequence.js；裁示者 2026-09-29 裁「乙」）。
// 守不到的：這裡驗的是模組的行為；app.js 真的把開機那幾步排成一條鏈，只有最後一題的原始碼文字比對盯著（不是行為）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runBootSteps, bootFailureMessage, isUnreachable } from '../public/modules/boot-sequence.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 可以從外面決定何時完成的 promise。 */
function deferred() {
  /** @type {(v?: unknown) => void} */ let resolve = () => {};
  /** @type {(e: unknown) => void} */ let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const conflict = () => Object.assign(new Error('資料在你操作期間被另一個裝置或分頁改過'), { code: 'kv_conflict' });

test('依序：前一步沒完成，下一步不開始', async () => {
  /** @type {string[]} */ const log = [];
  const a = deferred(), b = deferred();
  const done = runBootSteps([
    { name: 'A', run: async () => { log.push('A 開始'); await a.promise; log.push('A 結束'); } },
    { name: 'B', run: async () => { log.push('B 開始'); await b.promise; log.push('B 結束'); } },
  ]);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, ['A 開始'], 'A 還沒完成時 B 不可以開始（同時送出就是互撞的來源）');
  a.resolve();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, ['A 開始', 'A 結束', 'B 開始']);
  b.resolve();
  assert.deepEqual(await done, []);
});

test('某一步失敗不擋後面的步驟', async () => {
  /** @type {string[]} */ const ran = [];
  const failures = await runBootSteps([
    { name: 'A', run: async () => { ran.push('A'); throw conflict(); } },
    { name: 'B', run: async () => { ran.push('B'); } },
    { name: 'C', run: async () => { ran.push('C'); throw new Error('伺服器錯誤'); } },
  ]);
  assert.deepEqual(ran, ['A', 'B', 'C']);
  assert.deepEqual(failures.map((f) => f.name), ['A', 'C']);
});

test('連不上伺服器（TypeError）不算失敗；伺服器回的錯誤（含 409）都算', async () => {
  const failures = await runBootSteps([
    { name: '連不上', run: async () => { throw new TypeError('Failed to fetch'); } },
    { name: '互撞', run: async () => { throw conflict(); } },
    { name: '伺服器錯', run: async () => { throw new Error('500'); } },
  ]);
  assert.deepEqual(failures.map((f) => f.name), ['互撞', '伺服器錯']);
  assert.equal(isUnreachable(new TypeError('x')), true);
  assert.equal(isUnreachable(conflict()), false, '409 不是「連不上」');
});

test('提示文字：沒有失敗就不出聲；有失敗時說出幾項、哪幾項', () => {
  assert.equal(bootFailureMessage([]), null);
  assert.equal(
    bootFailureMessage([{ name: '自動對齊帳戶名', error: conflict() }, { name: '店名規則自動整理', error: conflict() }]),
    '開機時有 2 項自動更新沒完成：自動對齊帳戶名、店名規則自動整理。下次開 App 會再跑一次。');
});

test('接線（原始碼文字比對）：開機五個端點都排在同一條鏈裡（第一次 runBootSteps 到 bootFailureMessage 之間）、每個只出現一次', () => {
  const src = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(src, /import \{ runBootSteps, bootFailureMessage \} from '\.\/modules\/boot-sequence\.js';/);
  const from = src.indexOf('runBootSteps([');
  const to = src.indexOf('bootFailureMessage(failures)');
  assert.ok(from >= 0 && to > from, '找不到 runBootSteps([ … ]) 與其後的 bootFailureMessage(failures)');
  const region = src.slice(from, to);
  for (const ep of ['/quotes/refresh-auto', '/snapshot/auto', '/backup/daily', '/accounts/reconcile-names', '/statement/normalize-auto']) {
    assert.ok(region.includes(`'${ep}'`), `${ep} 不在開機那一條鏈裡——被搬回獨立的並行區塊了？`);
  }
  for (const ep of ['/quotes/refresh-auto', '/snapshot/auto', '/backup/daily', '/accounts/reconcile-names']) {
    assert.equal(src.split(`'${ep}'`).length - 1, 1, `${ep} 在 app.js 出現不只一次`);
  }
});
