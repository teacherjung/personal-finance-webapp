// @ts-check
// `test/helpers/cpu-ms.js` 的自證題（Codex #552 r2：量尺自己壞掉＝所有用它的 CPU 門檻一起洗綠——
// 他實測把 helper 換成 `fn => { fn(); return 0 }` 或退回 `Date.now()`，用它的門檻題照樣全綠。
// 固定維度「工具本身可信嗎？」那一條）
//
// 判準的寫法：用**假錶**（stub `process.cpuUsage`）釘算法，不設牆上時鐘門檻——會抖的門檻正是那支 PR 要消滅的東西。
// 假錶只有在 callback 裡「燒」的時候才前進；同一支假錶連量好幾次，每一次的起點、增量、期望值都不同，
// 其中一次燒到幾千毫秒（3456.789ms 這一點不得失真）——所以「沒執行 callback」「兩次讀錶都在 callback 之前」
// 「讀成絕對值不是差值」「漏掉 system」「回微秒不回毫秒」「退回 Date.now()」「吞掉例外」「固定回同一個數字」
// 「拿起點的某個欄位當除數」「在那一點以下封頂（飽和）」各自轉紅（各刀實測見 PR #552）。
// ⚠️ 數字刻意避開巧合（Codex #552 r3／r4 各抓到一刀）：起點的 user／system 都不等於 1000（微秒→毫秒的除數），
//    每一組 user＋system 的總增量都不是 1000 的整數倍、期望值彼此不同。r3 的反例＝起點 user 恰好是 1000 時
//    「除以 `u0.user`」全綠；r4 的反例＝期望值全在十幾毫秒以下時「`Math.min(…, 13)` 封頂」全綠——封頂的量尺會把
//    比封頂值大的壞法壓成小數字，所以要有一個幾千毫秒的探針（3456.789ms）。⚠️ 誠實劃界：本題只證明那一點不失真，
//    比它更高的區間不在射程（封頂值若高於那一點、或只在有限案例之外失真——例如 `% 4096` 回捲——本題抓不到；
//    這是有限案例的結構上限，不再加案例去追，Codex #552 r5 亦判為不阻擋）。門檻與探針之間沒有機械互扣。
// ⚠️ 真錶兩側都要釘（Grok #552 複審後掃第 2 條）：假錶只證明算式，證明不了**這台機器的 `process.cpuUsage()` 真的在走**
//    ——若某個環境把它做成永遠回 0（虛擬化／seccomp 之類），假錶題綠、等待題綠（0 < 30）、用這把量尺的上限門檻也全綠
//    ＝整族靜靜變空包彈。所以除了「等待量到接近 0」，還要有「固定的一段真工作量到明顯非 0」的對照組。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuMs } from './helpers/cpu-ms.js';

/** 模組載入當下的原生 `process.cpuUsage`——還原檢查一律對它比，不對「本題開始時的值」比
 *  （Grok #552 複審後掃第 3 條：對區域變數比的話，前一題漏還原時後面每一題都看不見）。 */
const NATIVE_CPU_USAGE = process.cpuUsage;

/**
 * 假錶：起點 `start`（微秒）；`burn()` 讓錶前進。
 * 不帶引數＝回目前絕對值；帶引數＝回相對引數的差值（與 Node 的 `process.cpuUsage(prev)` 同語意）。
 * @param {{ user: number, system: number }} start
 * @returns {{ burn: (user: number, system: number) => void, restore: () => void, calls: (undefined | { user: number, system: number })[] }}
 */
function fakeCpuClock(start) {
  const now = { ...start };
  /** @type {(undefined | { user: number, system: number })[]} */ const calls = [];
  const fake = /** @type {any} */ ((/** @type {{ user: number, system: number } | undefined} */ prev) => {
    calls.push(prev);
    return prev ? { user: now.user - prev.user, system: now.system - prev.system } : { ...now };
  });
  process.cpuUsage = fake;
  return { burn: (u, s) => { now.user += u; now.system += s; }, restore: () => { process.cpuUsage = NATIVE_CPU_USAGE; }, calls };
}

test('★cpuMs 量的是 callback 期間 user＋system 的**差值**、單位毫秒、callback 真的被執行、3456.789ms 這一點不封頂', () => {
  assert.equal(process.cpuUsage, NATIVE_CPU_USAGE, '★開始前錶必須是原生的（不然是別題漏還原）');
  const clock = fakeCpuClock({ user: 12_345, system: 678 });
  try {
    // (user 增量, system 增量, 期望毫秒)。3,000,000＋456,789 那一組＝ 3456.789ms，守「幾千毫秒這一點不失真」（更高的區間不在射程）。
    const cases = [[2_000, 250, 2.25], [10, 15, 0.025], [7_777, 4_444, 12.221], [3_000_000, 456_789, 3456.789]];
    for (const [u, s, expected] of cases) {
      const before = clock.calls.length;
      let ran = 0;
      const ms = cpuMs(() => { ran++; assert.equal(clock.calls.length, before + 1, '★起點要在 callback 之前讀一次（兩次都讀在前面＝量到 0）'); clock.burn(u, s); });
      assert.equal(ran, 1, `★燒 ${u}+${s}：callback 恰好執行一次`);
      assert.equal(ms, expected, `★燒 ${u}+${s} 微秒 ＝ ${expected} 毫秒（差值、含 system、換算成毫秒、不封頂；固定回同一個數、拿起點當除數、讀絕對值都對不上每一組）`);
    }
  } finally { clock.restore(); }
  assert.equal(process.cpuUsage, NATIVE_CPU_USAGE, '★假錶一定還原成**原生**的錶（不然這個行程裡後面的題都在用假錶）');
});

test('★callback 丟出的例外原樣傳出（不吞、不換物件），假錶照樣還原成原生的錶', () => {
  assert.equal(process.cpuUsage, NATIVE_CPU_USAGE, '★開始前錶必須是原生的（不然是別題漏還原）');
  const clock = fakeCpuClock({ user: 4_321, system: 87 });
  const boom = new Error('boom');
  try {
    assert.throws(() => cpuMs(() => { throw boom; }), (e) => e === boom, '★同一個例外物件');
  } finally { clock.restore(); }
  assert.equal(process.cpuUsage, NATIVE_CPU_USAGE, '★假錶一定還原成原生的錶');
});

test('★真錶兩側：等待不算工作（`Atomics.wait` 60ms ⇒ CPU 接近 0）、固定的一段真工作必須量到明顯非 0', () => {
  assert.equal(process.cpuUsage, NATIVE_CPU_USAGE, '★這題要量真錶（不然是別題漏還原）');
  const waitMs = cpuMs(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60));
  assert.ok(waitMs < 30, `★等了 60ms 牆上時鐘，CPU 只該有系統呼叫的零頭（實測 CPU ${waitMs.toFixed(2)}ms）`);
  // 對照組：固定 3e7 次整數運算（結果要用到，免得被最佳化掉）。這台 Mac 實測 CPU 約 120ms；下限 5ms 留二十幾倍
  //   給更快的機器與 Linux tick 級的計時解析度。真錶若是空操作，這句紅、上一族假錶題不會紅——這正是它存在的理由。
  let x = 0;
  const workMs = cpuMs(() => { for (let i = 0; i < 30_000_000; i++) x = (x + i * 7) % 1_000_003; });
  assert.ok(x > 0, '對照組的結果真的被算出來（不是被最佳化掉的空迴圈）');
  assert.ok(workMs >= 5, `★固定 3e7 次運算的 CPU 時間必須明顯非 0（實測 CPU ${workMs.toFixed(1)}ms）——這台機器的 process.cpuUsage() 真的在走`);
});
