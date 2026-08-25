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
 * @param {{ id: string, bank: string,
 *   confirm: (msg: string) => boolean,
 *   api: (path: string, opts?: any) => Promise<any>,
 *   toast: (msg: string, bad?: boolean) => void,
 *   onDeleted: (id: string) => void }} deps
 */
export async function deleteRecipeFlow({ id, bank, confirm, api, toast, onDeleted }) {
  if (!confirm(recipeDeleteConfirmText(bank))) return false;
  try {
    await api('/parse-recipes/delete', { method: 'POST', body: { id } });
    toast('已刪除這張規則卡');
    onDeleted(id);
    return true;
  } catch (e) {
    toast('刪除失敗：' + /** @type {any} */ (e).message, true);
    return false;
  }
}
