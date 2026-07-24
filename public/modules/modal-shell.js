// @ts-check
// 彈窗外殼共用件（系統優化 U3，**試點中**）：13 處手刻彈窗都重複同一段外殼——
// modal-bg＋modalSizeClass、modal-head（標題＋×）、close 閉包、x-close 接線、bindBackdropClose。
// 本檔只收斂「外殼」這五行；**彈窗內容與事件生命週期（送出鎖、非同步重畫、還原鈕…）各窗自理**，
// 呼叫端拿回 { root, close } 自行接線——這是刻意的淺抽象（Codex 修訂：先試點 securities 兩窗，
// 實測 關閉/背景點擊/送出/返回 都正常再決定是否擴大到其餘 11 處）。
// 循環 import 安全：對 app.js 的綁定只在函式內取用（勿在檔案頂層取用＝TDZ 陷阱，見 theme.js 註記）。
import { byId, esc, modalSizeClass, bindBackdropClose } from '../app.js';

/**
 * 開一個彈窗外殼：title 經 esc、bodyHtml 為呼叫端組好的內容（含各自的 form-actions 按鈕）。
 * 回傳 { root, close }——呼叫端自行接 [data-cancel]/[data-close] 與內容事件。
 * @param {{ title: string, size?: string, bodyHtml: string }} cfg
 * @returns {{ root: any, close: () => void }}
 */
export function openModalShell({ title, size = 'md', bodyHtml }) {
  const root = byId('modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass(size)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="x-close">×</button></div>
    <div class="modal-body">${bodyHtml}</div>
  </div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  bindBackdropClose(root, close);
  return { root, close };
}
