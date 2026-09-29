// @ts-check
// 開機自動更新：一步一步跑，出錯的收起來交給呼叫端出聲（裁示者 2026-09-29 裁「乙」，#649 留言 5893103735）。
//
// 為什麼：原本各段同時送出，雲端模式下會互相撞出 409，而每一段都把錯誤靜默吞掉。
// 為什麼獨立成純模組：`public/app.js` 在 node 裡 import 不進來；考題＝`test/boot-sequence.test.js`。
//
// 為什麼**任何錯都算**、不分「連不上」：錯誤型別分不出有沒有收到回應（回應內容壞掉也會丟 TypeError，
// #651 r1 #1 實測），猜錯就會把真的失敗吞掉。連不上伺服器時那一步也確實沒做成，說出來不是誤報。
//
// 守不到的：另一個分頁／手機同時寫入仍會撞（只是現在看得到）；提示消失後沒有地方回看；
// 出錯不等於沒寫進去——回應壞掉時寫入可能已成功，所以提示只說「出了問題」、不說「沒完成」。

/**
 * @typedef {{ name: string, run: () => Promise<unknown> }} BootStep
 * @typedef {{ name: string, error: unknown }} BootFailure
 */

/**
 * 依序執行；某一步出錯不擋後面的步驟；最後一步結束才回傳。
 * @param {BootStep[]} steps
 * @returns {Promise<BootFailure[]>} 出錯的那幾步
 */
export async function runBootSteps(steps) {
  /** @type {BootFailure[]} */
  const failures = [];
  for (const step of steps) {
    try { await step.run(); }
    catch (error) { failures.push({ name: step.name, error }); }
  }
  return failures;
}

/**
 * 沒有出錯回 null。
 * ⚠️ 用字只講確定的事：「出了問題」對每一種錯都成立；「下次開 App 會再檢查一次」＝那幾個端點每次開都會再叫，
 *    要不要真的重做由各自的條件決定（報價一小時內不重抓、店名指紋相同就跳過）——所以不寫「會再跑一次」。
 * @param {BootFailure[]} failures
 * @returns {string|null}
 */
export function bootFailureMessage(failures) {
  if (!failures.length) return null;
  return `開機時有 ${failures.length} 項自動更新出了問題：${failures.map((f) => f.name).join('、')}。下次開 App 會再檢查一次。`;
}
