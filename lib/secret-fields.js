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

// ---- 機密欄位的「單一清單」（C5）------------------------------------------
// 以前「哪些欄位算機密」散在三個投影函式裡各寫一次。C5 要對同一組欄位再做**加密**與
// **雲端匯出剝除**，再抄第三、第四份就一定會走散（漏一個欄位＝那個機密以明文躺在雲端資料庫）。
// 所以集中成一個走訪器：加密、解密、匯出剝除全部從這裡出發。
// ⚠️ **新增機密欄位時只改這裡**，然後跑 `test/hosted-secrets.test.js`（它逐欄位驗加密與剝除）。
//
// 📌 待裁決（Claude 建議，C0 第五節沒列，留給 William）：`accounts[].accountNo`（完整帳號，PII；
//    AGENTS.md 已把它與 pdfPassword 同級處理、GET 一律剝除）目前**沒有**加密。
//    它有伺服器端消費者（銀行對帳單末碼比對），技術上加了照樣能用（解密在讀取時完成）。
//    要納入就在下面 `mapSecrets` 補一段。

/**
 * 走訪整包 db 的每個機密欄位，用 `fn(值, 路徑)` 的回傳值取代它（**就地修改**）。
 * 路徑會拿去當加密的 AAD，所以要穩定且唯一（卡片用 id，**不用陣列索引**——索引會隨排序變動，
 * 一旦變動就解不開了）。
 * @template T @param {T} db @param {(value: string, path: string) => string} fn @returns {T}
 */
export function mapSecrets(db, fn) {
  const d = /** @type {any} */ (db);
  if (!d || typeof d !== 'object') return db;
  if (d.settings && typeof d.settings === 'object') {
    if ('taishinSecPdfPassword' in d.settings) {
      d.settings.taishinSecPdfPassword = fn(String(d.settings.taishinSecPdfPassword ?? ''), 'settings.taishinSecPdfPassword');
    }
    if (d.settings.ib && typeof d.settings.ib === 'object' && 'flexToken' in d.settings.ib) {
      d.settings.ib.flexToken = fn(String(d.settings.ib.flexToken ?? ''), 'settings.ib.flexToken');
    }
  }
  if (Array.isArray(d.cards)) {
    for (const c of d.cards) {
      if (c && typeof c === 'object' && 'pdfPassword' in c) {
        c.pdfPassword = fn(String(c.pdfPassword ?? ''), `cards.${String(c.id || '')}.pdfPassword`);
      }
    }
  }
  return db;
}

/**
 * **雲端匯出專用**（裁決⑤，C5）：把機密欄位一律清成空字串（＝「未設定」）。
 * 為什麼雲端與本機刻意相反：本機備份留在你自己的硬碟上，缺了密碼就永久還原不回來，所以**必須完整**；
 * 雲端匯出的檔案會經過瀏覽器下載、可能被轉寄或存到別處，風險完全不同——
 * William 確認過「不含機密仍可正常還原，只需重輸 PDF 密碼與 IB 憑證各一次」之後拍板。
 * ⚠️ 走深拷貝：絕不可以順手把記憶體裡那包正在用的 db 也清掉。
 * @param {any} db @returns {any}
 */
export function stripSecretsForBackup(db) {
  return mapSecrets(JSON.parse(JSON.stringify(db ?? null)), () => '');
}

/** 卡片投影：剝掉 pdfPassword、補 pdfPasswordSet 布林。 @param {any} c */
export function projectCard(c) {
  if (!c || typeof c !== 'object') return c;
  const { pdfPassword, ...rest } = c;
  return { ...rest, pdfPasswordSet: isSet(pdfPassword) };
}

/** settings 投影：剝掉 ib.flexToken 與 taishinSecPdfPassword（證券對帳單密碼＝身分證字號級），各補 <欄>Set 布林。 @param {any} s */
export function projectSettings(s) {
  if (!s || typeof s !== 'object') return s;
  const { taishinSecPdfPassword, ...rest } = s;
  const out = { ...rest, taishinSecPdfPasswordSet: isSet(taishinSecPdfPassword) };
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
  // 遮罩帳號（900100****3301）取「星號後的可見末碼」，不是整串數字尾 4（那會變 5162 之類的假末碼）；
  // 完整帳號（無星號）取純數字尾 4。
  const maskedTail = raw.match(/\*+(\d+)\s*$/);
  const last4 = maskedTail ? maskedTail[1].slice(-4) : raw.replace(/\D/g, '').slice(-4);
  return { ...rest, accountNoSet: isSet(accountNo), accountNoLast4: last4 };
}

/** 證券交易列投影（Codex S2r1#6，藍圖 §四「來源帳戶身分經機密投影」）：剝 sourceAccountId（指紋——IB 帳號
 * 範圍小＋畫面又給末四碼，不可視為真不可逆）與 sourceRef（部分嵌入帳戶指紋）。批次/顯示用 importBatch 與
 * 遮罩 label 保留。/api/export 照舊完整（還原要靠 sourceRef 冪等）。 @param {any} t */
export function projectSecurityTrade(t) {
  if (!t || typeof t !== 'object') return t;
  const { sourceAccountId, sourceRef, ...rest } = t;
  void sourceAccountId; void sourceRef;
  return rest;
}

/** 整包資料庫投影（GET /api/db 用；**不可**用在 /api/export）。 @param {any} db */
export function projectDb(db) {
  if (!db || typeof db !== 'object') return db;
  return {
    ...db,
    cards: Array.isArray(db.cards) ? db.cards.map(projectCard) : db.cards,
    accounts: Array.isArray(db.accounts) ? db.accounts.map(projectAccount) : db.accounts,
    securityTrades: Array.isArray(db.securityTrades) ? db.securityTrades.map(projectSecurityTrade) : db.securityTrades,
    settings: projectSettings(db.settings),
  };
}
