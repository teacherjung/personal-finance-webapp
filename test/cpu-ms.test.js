// @ts-check
// `test/helpers/cpu-ms.js` 的自證題（Codex #552 r2：量尺自己壞掉＝所有用它的 CPU 門檻一起洗綠——
// 他實測把 helper 換成 `fn => { fn(); return 0 }` 或退回 `Date.now()`，用它的門檻題照樣全綠。
// 固定維度第 8 項：工具本身可信嗎？）
//
// 判準的寫法：用**假錶**（stub `process.cpuUsage`）釘算法，不設牆上時鐘門檻——會抖的門檻正是那支 PR 要消滅的東西。
// 假錶只有在 callback 裡「燒」的時候才前進；同一支假錶連量好幾次，每一次的起點、增量、期望值都不同，
// 其中一次的期望值高於所有用它的正式門檻——所以「沒執行 callback」「兩次讀錶都在 callback 之前」
// 「讀成絕對值不是差值」「漏掉 system」「回微秒不回毫秒」「退回 Date.now()」「吞掉例外」「固定回同一個數字」
// 「拿起點的某個欄位當除數」「答案封頂（飽和）」各自轉紅（各刀實測見 PR #552）。
// ⚠️ 數字刻意避開巧合（Codex #552 r3／r4 各抓到一刀）：起點的 user／system 都不等於 1000（微秒→毫秒的除數），
//    每一組 user＋system 的總增量都不是 1000 的整數倍、期望值彼此不同。r3 的反例＝起點 user 恰好是 1000 時
//    「除以 `u0.user`」全綠；r4 的反例＝期望值全在十幾毫秒以下時「`Math.min(…, 13)` 封頂」全綠，而正式門檻都是
//    幾百毫秒起跳，封頂的量尺會把所有壞法壓成小數字——所以要有一組期望值高於所有正式門檻（改門檻時回來對一次）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuMs } from './helpers/cpu-ms.js';

/**
 * 假錶：起點 `start`（微秒）；`burn()` 讓錶前進。
 * 不帶引數＝回目前絕對值；帶引數＝回相對引數的差值（與 Node 的 `process.cpuUsage(prev)` 同語意）。
 * @param {{ user: number, system: number }} start
 * @returns {{ burn: (user: number, system: number) => void, restore: () => void, calls: (undefined | { user: number, system: number })[] }}
 */
function fakeCpuClock(start) {
  const real = process.cpuUsage;
  const now = { ...start };
  /** @type {(undefined | { user: number, system: number })[]} */ const calls = [];
  const fake = /** @type {any} */ ((/** @type {{ user: number, system: number } | undefined} */ prev) => {
    calls.push(prev);
    return prev ? { user: now.user - prev.user, system: now.system - prev.system } : { ...now };
  });
  process.cpuUsage = fake;
  return { burn: (u, s) => { now.user += u; now.system += s; }, restore: () => { process.cpuUsage = real; }, calls };
}

test('★cpuMs 量的是 callback 期間 user＋system 的**差值**、單位毫秒、callback 真的被執行、高於正式門檻的答案不封頂', () => {
  const real = process.cpuUsage;
  const clock = fakeCpuClock({ user: 12_345, system: 678 });
  try {
    // (user 增量, system 增量, 期望毫秒)。3,000,000＋456,789 那一組＝ 3456.789ms，高於所有用它的正式門檻，守「量尺上半段不失真」。
    const cases = [[2_000, 250, 2.25], [10, 15, 0.025], [7_777, 4_444, 12.221], [3_000_000, 456_789, 3456.789]];
    for (const [u, s, expected] of cases) {
      const before = clock.calls.length;
      let ran = 0;
      const ms = cpuMs(() => { ran++; assert.equal(clock.calls.length, before + 1, '★起點要在 callback 之前讀一次（兩次都讀在前面＝量到 0）'); clock.burn(u, s); });
      assert.equal(ran, 1, `★燒 ${u}+${s}：callback 恰好執行一次`);
      assert.equal(ms, expected, `★燒 ${u}+${s} 微秒 ＝ ${expected} 毫秒（差值、含 system、換算成毫秒、不封頂；固定回同一個數、拿起點當除數、讀絕對值都對不上每一組）`);
    }
  } finally { clock.restore(); }
  assert.equal(process.cpuUsage, real, '★假錶一定被還原（不然這個行程裡後面的題都在用假錶）');
});

test('★callback 丟出的例外原樣傳出（不吞、不換物件），假錶照樣還原', () => {
  const real = process.cpuUsage;
  const clock = fakeCpuClock({ user: 4_321, system: 87 });
  const boom = new Error('boom');
  try {
    assert.throws(() => cpuMs(() => { throw boom; }), (e) => e === boom, '★同一個例外物件');
  } finally { clock.restore(); }
  assert.equal(process.cpuUsage, real, '★假錶一定被還原');
});

test('★劃界釘成行為：等待不算工作——`Atomics.wait` 60ms 的 CPU 時間接近 0（這正是它量不到 off-CPU 阻塞的意思）', () => {
  const ms = cpuMs(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60));
  assert.ok(ms < 30, `★等了 60ms 牆上時鐘，CPU 只該有系統呼叫的零頭（實測 CPU ${ms.toFixed(2)}ms）`);
});
