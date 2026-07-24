// @ts-check
// 檔案處理共用工具（系統優化 U1）：原本 transactions／cashflow／securities 三頁各有一份**逐字相同**的
// 轉碼器（各檔互相註明「同 transactions.js 的做法」）——歸戶到這裡，一處修改、全站生效。
// **刻意零依賴**（不 import app.js 或任何模組）：任何頁面模組都能安全引用，天然免疫循環 import TDZ
//（theme.js／securities.js 檔頭記錄過的陷阱）。FileReader 是瀏覽器 API，node --test 測不到——
// 行為驗證走各頁上傳流程的隔離瀏覽器回歸（施工計畫 U1）。

/** 檔案 → base64 字串（剝掉 data URL 前綴）。上傳用：檔案與密碼只在記憶體、隨請求送、不落地。
 * @param {File} file @returns {Promise<string>} */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('讀取檔案失敗'));
    fr.readAsDataURL(file);
  });
}
