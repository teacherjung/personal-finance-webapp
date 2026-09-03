// @ts-check
// `test/helpers/cpu-ms.js` 的自證題（Codex #552 r2：量尺自己壞掉＝所有用它的 CPU 門檻一起洗綠——
// 他實測把 helper 換成 `fn => { fn(); return 0 }` 或退回 `Date.now()`，用它的兩支考題檔仍 50/50 全綠。
// 固定維度第 8 項：工具本身可信嗎？）
//
// 判準的寫法：用**假錶**（stub `process.cpuUsage`）釘算法，不設牆上時鐘門檻——會抖的門檻正是那支 PR 要消滅的東西。
// 假錶只有在 callback 裡「燒」的時候才前進，所以「沒執行 callback」「兩次讀錶都在 callback 之前」
// 「讀成絕對值不是差值」「漏掉 system」「回微秒不回毫秒」「退回 Date.now()」「吞掉例外」各自轉紅（各刀實測見 PR #552）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuMs } from './helpers/cpu-ms.js';

/**
 * 假錶：起點 {user:1000, system:500} 微秒；`burn()` 讓錶前進。
 * 不帶引數＝回目前絕對值；帶引數＝回相對引數的差值（與 Node 的 `process.cpuUsage(prev)` 同語意）。
 * @returns {{ burn: (user: number, system: number) => void, restore: () => void, calls: (undefined | { user: number, system: number })[] }}
 */
function fakeCpuClock() {
  const real = process.cpuUsage;
  const now = { user: 1_000, system: 500 };
  /** @type {(undefined | { user: number, system: number })[]} */ const calls = [];
  const fake = /** @type {any} */ ((/** @type {{ user: number, system: number } | undefined} */ prev) => {
    calls.push(prev);
    return prev ? { user: now.user - prev.user, system: now.system - prev.system } : { ...now };
  });
  process.cpuUsage = fake;
  return { burn: (u, s) => { now.user += u; now.system += s; }, restore: () => { process.cpuUsage = real; }, calls };
}

test('★cpuMs 量的是 callback 期間 user＋system 的**差值**、單位毫秒、而且 callback 真的被執行', () => {
  const real = process.cpuUsage;
  const clock = fakeCpuClock();
  try {
    let ran = 0;
    const ms = cpuMs(() => { ran++; assert.equal(clock.calls.length, 1, '★起點要在 callback 之前讀一次（兩次都讀在前面＝量到 0）'); clock.burn(3_000, 1_500); });
    assert.equal(ran, 1, '★callback 恰好執行一次');
    assert.equal(ms, 4.5, '★(3000+1500) 微秒 ＝ 4.5 毫秒：差值、含 system、換算成毫秒（絕對值會是 6.0、只算 user 是 3.0、微秒是 4500）');
  } finally { clock.restore(); }
  assert.equal(process.cpuUsage, real, '★假錶一定被還原（不然這個行程裡後面的題都在用假錶）');
});

test('★callback 丟出的例外原樣傳出（不吞、不換物件），假錶照樣還原', () => {
  const real = process.cpuUsage;
  const clock = fakeCpuClock();
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
