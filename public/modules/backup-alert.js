// @ts-check
// 每日備份警告的文案與強度（純函式積木，零相依）。裁決 2026-07-24：
// 備份失敗時 **app 仍可正常使用**，但**畫面必須明顯警告**（不可只記 server log），且**連續失敗要提高警告強度**。
//
// 為什麼是純函式：文案要能被考題釘住——「第 1 次」與「連續 5 次」講的話必須真的不一樣，
// 而且**絕不可在成功時冒出警告**（誤報比不報更糟：使用者會學會忽略它）。

/** 連續失敗幾次以上升級成強警告。 */
export const ESCALATE_AT = 3;

/**
 * 依備份結果算出要不要顯示警告、以及顯示什麼。
 * @param {{created?:boolean, failStreak?:number, error?:string, date?:string}|null|undefined} status
 *   後端 `POST /api/backup/daily` 的回應；抓不到（網路/伺服器沒回）時傳 null＝不警告
 *   （分不出是備份壞了還是伺服器沒開，硬報會變狼來了）。
 * @returns {{show:boolean, level:'warn'|'danger', title:string, body:string, why:string}}
 */
export function backupAlertView(status) {
  const streak = Math.max(0, Number(status?.failStreak) || 0);
  const ok = !status || streak === 0;
  if (ok) return { show: false, level: 'warn', title: '', body: '', why: '' };

  const danger = streak >= ESCALATE_AT;
  const title = danger ? `自動備份已經連續 ${streak} 次失敗` : '今天的自動備份沒有成功';
  const body = danger
    // 強度提高：講清楚「已經多久沒有新備份」的後果，並給明確下一步
    ? '這代表你的資料已經有一段時間沒有新的每日備份了。請檢查電腦硬碟空間是否足夠，或把 data 資料夾整個複製一份到別的地方，然後重開 app 再看這行字會不會消失。'
    : '資料本身沒有問題、可以照常使用；只是今天這一份備份沒有建立起來。重開 app 會再試一次。';
  const why = String(status?.error || '').slice(0, 300);
  return { show: true, level: danger ? 'danger' : 'warn', title, body, why };
}
