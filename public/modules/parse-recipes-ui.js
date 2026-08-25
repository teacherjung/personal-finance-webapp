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

/**
 * 管理窗狀態核心（Codex #513 r7）：
 * - rows **單一住所**（r7#1：settings 每次重畫都閉包舊 rows——連刪兩張時第一刀重畫、第二刀因失去
 *   擁有權跳過 UI 接續，後端兩張都刪了、畫面卻殘留一張）。
 * - 刪除**序列化**（r7#1 修法）：前一刀還在等回應＝這一刀整個不動（連 confirm 都不問），回 false。
 *   confirm 是同步阻塞窗，唯一的縫就是 API 在途那一小段。
 * - confirm **接線住這裡**（r7#2：接線寫在 settings＝node 載不進、「按取消照樣刪」的壞法測不到；
 *   settings 只傳 `window` 進來，回傳值有沒有被尊重由本模組的行為卷承重）。
 * settings 只負責畫表格＋把按鈕接到 del(id)。
 * @param {{ rows: any[], win: { confirm: (msg: string) => boolean },
 *   api: (path: string, opts?: any) => Promise<any>,
 *   toast: (msg: string, bad?: boolean) => void,
 *   watchModal: () => () => boolean,
 *   onRows: (rows: any[]) => void }} deps
 */
export function createRecipeManager({ rows, win, api, toast, watchModal, onRows }) {
  let cur = (Array.isArray(rows) ? rows : []).slice();
  let busy = false;
  /** @param {string} id */
  const del = async (id) => {
      if (busy) return false;
      const row = cur.find((/** @type {any} */ r) => r?.id === id);
      if (!row) return false;
      busy = true;
      try {
        return await deleteRecipeFlow({
          id, bank: String(row.bank || ''),
          confirm: (m) => win.confirm(m),
          api, toast, watchModal,
          onDeleted: (gone) => { cur = cur.filter((/** @type {any} */ r) => r?.id !== gone); onRows(cur.slice()); },
        });
      } finally { busy = false; }
  };
  return {
    rows: () => cur.slice(),
    busy: () => busy,
    del,
    /**
     * 把管理窗的刪除鈕接到 del（r8#1：這一段留在 settings＝node 測不到「按了沒反應」——
     * 把 `mgr.del(...)` 突變成不呼叫，鈕全死、考題照綠）。onclick 回傳 del 的 Promise
     * （DOM 不理回傳值，行為卷靠它 await）。
     * @param {Iterable<any>} buttons
     */
    bindDeleteButtons(buttons) {
      for (const btn of buttons) {
        btn.onclick = () => del(String(btn?.dataset?.del || ''));
      }
    },
  };
}
