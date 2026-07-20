// @ts-check
// 機密欄位投影（自主體檢，使用者定 2026-07-22）：把最敏感的 PII 與憑證從「用不到它們的讀取端」剝掉。
//
// 病根：GET /api/db 回整包（含每張卡的 pdfPassword＝身分證字號、settings.ib.flexToken＝IBKR 憑證）、
// GET /api/cards / /api/settings 也回完整物件；但實際只有「卡片編輯窗」用 pdfPassword、「設定頁 IB 卡」用
// flexToken。等於把身分證字號廣播到資產頁、收支頁下拉選單等一堆用不到的頁面（瀏覽器記憶體/DevTools/
// Network 都看得到），無謂擴大暴露面。本機單人 app 屬「防禦縱深」，但符合「身分證字號不外擴」的鐵則。
//
// 設計：**機密完全不送到瀏覽器**（比「預填後隱藏」更徹底）。改回傳一個布林 `<欄位>Set` 讓 UI 知道
// 「已設定 vs 未設定」，編輯窗用「留空＝不變更」的慣例；真的要改才輸入、才送回後端。
// ⚠️ **`/api/export`（下載備份）一定要用未投影的完整資料**——備份漏了密碼，還原後就永久遺失。

const isSet = (/** @type {any} */ v) => v != null && String(v) !== '';

/** 卡片投影：剝掉 pdfPassword、補 pdfPasswordSet 布林。 @param {any} c */
export function projectCard(c) {
  if (!c || typeof c !== 'object') return c;
  const { pdfPassword, ...rest } = c;
  return { ...rest, pdfPasswordSet: isSet(pdfPassword) };
}

/** settings 投影：剝掉 ib.flexToken、補 ib.flexTokenSet 布林。 @param {any} s */
export function projectSettings(s) {
  if (!s || typeof s !== 'object') return s;
  const out = { ...s };
  if (out.ib && typeof out.ib === 'object') {
    const { flexToken, ...ibRest } = out.ib;
    out.ib = { ...ibRest, flexTokenSet: isSet(flexToken) };
  }
  return out;
}

/** 整包資料庫投影（GET /api/db 用；**不可**用在 /api/export）。 @param {any} db */
export function projectDb(db) {
  if (!db || typeof db !== 'object') return db;
  return {
    ...db,
    cards: Array.isArray(db.cards) ? db.cards.map(projectCard) : db.cards,
    settings: projectSettings(db.settings),
  };
}
