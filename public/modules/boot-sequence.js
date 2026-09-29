// @ts-check
// 開機自動更新：一步一步跑，失敗的收起來交給呼叫端出聲（裁示者 2026-09-29 裁「乙」，#649 留言 5893103735）。
//
// 為什麼：原本各段同時送出，雲端模式下會互相撞出 409，而每一段都把錯誤靜默吞掉。
// 為什麼獨立成純模組：`public/app.js` 在 node 裡 import 不進來；考題＝`test/boot-sequence.test.js`。
//
// 守不到的：另一個分頁／手機同時寫入仍會撞（只是現在看得到）；提示消失後沒有地方回看。

/**
 * @typedef {{ name: string, run: () => Promise<unknown> }} BootStep
 * @typedef {{ name: string, error: unknown }} BootFailure
 */

/**
 * 連不上伺服器（fetch 本身失敗會丟 TypeError）不算失敗：分不出是壞了還是沒連上，
 * 照每日備份那一段的前例（2026-07-24 裁示）不出聲。
 * @param {unknown} error
 */
export function isUnreachable(error) {
  return error instanceof TypeError;
}

/**
 * 依序執行；某一步失敗不擋後面的步驟。
 * @param {BootStep[]} steps
 * @returns {Promise<BootFailure[]>} 伺服器有回應、但回了錯誤的那幾步（連不上的不算）
 */
export async function runBootSteps(steps) {
  /** @type {BootFailure[]} */
  const failures = [];
  for (const step of steps) {
    try { await step.run(); }
    catch (error) { if (!isUnreachable(error)) failures.push({ name: step.name, error }); }
  }
  return failures;
}

/**
 * 沒有失敗回 null。
 * @param {BootFailure[]} failures
 * @returns {string|null}
 */
export function bootFailureMessage(failures) {
  if (!failures.length) return null;
  return `開機時有 ${failures.length} 項自動更新沒完成：${failures.map((f) => f.name).join('、')}。下次開 App 會再跑一次。`;
}
