// @ts-check
// 規則卡管理窗的**行為核心**（純模組、零 DOM——settings.js 是頁面模組載不進 node，confirm／API 呼叫的行為
// 只有抽到這裡才測得動：Codex #513 r2#2「呼叫 confirm、忽略結果、照刪」的突變在形狀掃描下全綠）。
// settings.js 只負責畫表格與把 window.confirm／api／toast 接進來。

/** 刪除確認句（單一住所：settings 的 confirm 與考題共用同一句）。 @param {string} bank */
export function recipeDeleteConfirmText(bank) {
  return `確定刪掉「${bank || '這張'}」的規則卡嗎？\n刪掉後下次這個版面會重新用 AI 讀（再花一次 AI 費用）；不影響已匯入的交易。`;
}

/**
 * 刪除流程：先問（confirm 回 false＝**零 API 呼叫**）、確認才打刪除端點恰一次、成功回報並讓呼叫端更新畫面。
 * watchModal（app.js 的 watchModalRoot，唯讀）：等回應期間使用者關掉管理窗／改開別的窗／換頁
 * ＝回應抵達時**零 UI 接續**（Codex #513 r6#1：onDeleted 會重畫管理窗，晚回來的重畫等於把已關的窗
 * 復活、蓋掉後開彈窗的未存內容）。⚠️ 必須在發請求**之前**取快照——回應後才問只看得到當下狀態，
 * 看不到「等待期間被接管過」。刪除本身已在後端完成，所以回傳值照實回，只是不碰畫面。
 * @param {{ id: string, bank: string,
 *   confirm: (msg: string) => boolean,
 *   api: (path: string, opts?: any) => Promise<any>,
 *   toast: (msg: string, bad?: boolean) => void,
 *   onDeleted: (id: string) => void,
 *   watchModal: () => () => boolean }} deps
 */
export async function deleteRecipeFlow({ id, bank, confirm, api, toast, onDeleted, watchModal }) {
  if (!confirm(recipeDeleteConfirmText(bank))) return false;
  const owns = watchModal();
  try {
    await api('/parse-recipes/delete', { method: 'POST', body: { id } });
    if (!owns()) return true;
    toast('已刪除這張規則卡');
    onDeleted(id);
    return true;
  } catch (e) {
    if (!owns()) return false;
    toast('刪除失敗：' + /** @type {any} */ (e).message, true);
    return false;
  }
}
