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

/** 帳戶投影（三層重構 stage 2）：剝掉完整帳號 accountNo（PII），只回 accountNoSet 布林＋末四碼（顯示用、安全）。
 * 完整帳號只用於「銀行對帳單末碼比對」（伺服器端做），前端從不需要它——同 pdfPassword 的「機密不送瀏覽器」原則。 @param {any} a */
export function projectAccount(a) {
  if (!a || typeof a !== 'object') return a;
  const { accountNo, ...rest } = a;
  const raw = String(accountNo || '');
  // 遮罩帳號（209710****0122）取「星號後的可見末碼」，不是整串數字尾 4（那會變 5162 之類的假末碼）；
  // 完整帳號（無星號）取純數字尾 4。
  const maskedTail = raw.match(/\*+(\d+)\s*$/);
  const last4 = maskedTail ? maskedTail[1].slice(-4) : raw.replace(/\D/g, '').slice(-4);
  return { ...rest, accountNoSet: isSet(accountNo), accountNoLast4: last4 };
}

/** 整包資料庫投影（GET /api/db 用；**不可**用在 /api/export）。 @param {any} db */
export function projectDb(db) {
  if (!db || typeof db !== 'object') return db;
  return {
    ...db,
    cards: Array.isArray(db.cards) ? db.cards.map(projectCard) : db.cards,
    accounts: Array.isArray(db.accounts) ? db.accounts.map(projectAccount) : db.accounts,
    settings: projectSettings(db.settings),
  };
}
