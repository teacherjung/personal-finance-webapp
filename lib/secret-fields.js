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
//    ⚠️ 2026-07-28 實測補充，**納入前必讀**：銀行對帳單比對不是「只比末四碼」——
//    `lib/services/bank-import.js` 的 `matchAccount` 同時要求帳單遮罩的**可見前綴**相符
//    （`900100****3301` 的 prefix＝`900100`）。所以「把 accountNo 降級成 ****3301 就好」行不通：
//    配不到帳戶＝每期自動多開一個重複帳戶、餘額分散在兩戶，淨資產**默默多算**。
//    而金鑰壞掉時 accountNo 在記憶體裡會變成空字串，同樣配不到，還會讓 `ownSuffixSet` 少掉
//    自己的帳號末碼、把自己帳戶之間的內轉判成收入寫進帳本。要納入就得連這兩條路一起處理。
//
// 📌 `lib/store-pg.js` 的「解不開就把原密文寫回去」只保護**上面 `mapSecrets` 目前列的那三個欄位**。
//    每多列一個欄位，就同時多一份保護；沒列到的欄位不受保護（但也不會被加密，所以不會被毀）。

/**
 * 走訪整包 db 的每個機密欄位，用 `fn(值, 路徑, 身分穩定嗎)` 的回傳值取代它（**就地修改**）。
 * 路徑會拿去當加密的 AAD，所以要穩定且唯一（卡片用 id，**不用陣列索引**——索引會隨排序變動，
 * 一旦變動就解不開了）。
 *
 * ⚠️⚠️ 第三個參數 `stable` ＝**這條路徑真的代表一個身分嗎**（2026-07-29，Codex 定向複審第三輪）。
 *    路徑一律用 `String(id)` 組，所以 `id: 7`（數字）與 `id: "7"`（字串）會算出**同一條路徑**，
 *    而 `lib/schema.js` 的匯入驗證刻意保留任意型別的 id。實測：目前資料有 `id: 7` 的卡、
 *    匯入一張 `id: "7"` 的**不同**卡且密碼留空 → 兩邊各只有一筆、撞號數不出來 →
 *    新卡直接繼承舊卡的 PDF 密碼（還回 200）。缺 id 更直接：全部塌成 `cards..pdfPassword`。
 *
 *    **路徑本身不能改**（它是既有密文的 AAD，改了舊資料就解不開），所以改成**另外回報**：
 *    `stable` 只有在 id 是**非空字串**時才為 true。固定路徑的 settings 欄位永遠 true。
 *    加解密不需要理它（沿用 `(v, path)` 即可）；**「留空＝保留現值」的回填一定要看它**——
 *    見 `lib/routes/core.js` 的 `keepableByPath`。
 *
 * @template T @param {T} db @param {(value: string, path: string, stable: boolean) => string} fn @returns {T}
 */
export function mapSecrets(db, fn) {
  const d = /** @type {any} */ (db);
  if (!d || typeof d !== 'object') return db;
  if (d.settings && typeof d.settings === 'object') {
    if ('taishinSecPdfPassword' in d.settings) {
      d.settings.taishinSecPdfPassword = fn(String(d.settings.taishinSecPdfPassword ?? ''), 'settings.taishinSecPdfPassword', true);
    }
    if (d.settings.ib && typeof d.settings.ib === 'object' && 'flexToken' in d.settings.ib) {
      d.settings.ib.flexToken = fn(String(d.settings.ib.flexToken ?? ''), 'settings.ib.flexToken', true);
    }
  }
  if (Array.isArray(d.cards)) {
    for (const c of d.cards) {
      if (c && typeof c === 'object' && 'pdfPassword' in c) {
        c.pdfPassword = fn(String(c.pdfPassword ?? ''), `cards.${String(c.id || '')}.pdfPassword`, isStableId(c.id));
      }
    }
  }
  return db;
}

/**
 * 「這個 id 可以當回填的座標嗎」——**只有非空字串算數**。
 * 數字 `7` 與字串 `"7"` 會算出同一條路徑（`String()`），物件與陣列更會塌成 `[object Object]`；
 * 缺 id 則全部塌成同一格。這些情況一律當「身分不明」，**寧可少救一個欄位，也不要把資料寫錯**。
 * @param {unknown} id
 */
export function isStableId(id) {
  return typeof id === 'string' && id !== '';
}

/**
 * **只在雲端匯出剝除、但「不」加密的 PII**（2026-07-28）。
 *
 * ⚠️ 為什麼要有第二張清單、而不是把 `accountNo` 加進上面的 `mapSecrets`：
 *    `mapSecrets` 是**加密走訪器**——加進去就等於同時決定「accountNo 要加密」，
 *    而那是 C0 白紙黑字留給 William 的裁決（見檔頭 📌），技術上還會連帶影響
 *    `matchAccount` 的可見前綴比對與 `ownSuffixSet`。**兩件事必須分開決定**。
 *    這張清單只做一件事：**別讓完整帳號跟著備份檔離開伺服器**。
 *    資料庫裡那一份原封不動（明文照舊），所以零正確性風險。
 *
 * 為什麼這是真的暴露點（不是理論風險）：`GET /api/export` 下載的備份檔會被存到使用者的裝置、
 * 可能轉寄或丟進雲端硬碟——這正是裁決⑤當初剝掉三個機密欄位的**同一個理由**，
 * 只是當時漏了 `accountNo`（它在 C0 第五節沒被列進機密清單）。
 * ⚠️⚠️ 第三個參數 `stable` 與 `mapSecrets` 同義、同一個判準（`isStableId`）——**剝除照做，
 *    但身分不明的那一筆不可以拿路徑當「還原的座標」**。這條規矩是三輪定向複審各抓一次才收斂的：
 *    ・v3：匯入檔裡兩筆用同一個 id → 兩筆同時拿到同一個完整帳號。
 *    ・v4：目前一筆沒有 id、匯入另一筆**完全不同**、也沒有 id → 新帳戶繼承舊帳號
 *          （兩側各只有一筆，撞號根本數不出來——問題不在數不夠，在 `accounts..accountNo`
 *          看起來像座標、其實不是身分）。
 *    ・v5：`id: 7`（數字）與 `id: "7"`（字串）算出同一條路徑，同樣兩側各一筆躲過撞號偵測。
 *    後果一律相同：錯的帳號拿去配銀行帳單、判自家末碼、分內轉，而且回 200。
 *
 * @template T @param {T} db @param {(value: string, path: string, stable: boolean) => string} fn @returns {T}
 */
export function mapBackupOnlyPii(db, fn) {
  const d = /** @type {any} */ (db);
  if (!d || typeof d !== 'object') return db;
  if (Array.isArray(d.accounts)) {
    for (const a of d.accounts) {
      // ⚠️ **不可以要求「欄位已經存在」**（2026-07-29，Codex 定向複審抓到的 blocking）。
      //    v2 寫成 `if ('accountNo' in a)`，於是**舊備份根本沒有這個欄位時整個跳過**——
      //    還原路徑因此沒有機會把現值填回去，帳號一樣被洗掉（而且回 200）。
      //    「留空＝不變更」的語意必須連「欄位不存在」一起涵蓋，否則相容性宣稱是假的。
      if (!a || typeof a !== 'object') continue;
      a.accountNo = fn(String(a.accountNo ?? ''), `accounts.${String(a.id ?? '')}.accountNo`, isStableId(a.id));
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
 * ⚠️ **兩張清單都要跑**：加密清單（`mapSecrets`）＋只剝不加密的 PII 清單（`mapBackupOnlyPii`）。
 *
 * ⚠️ **這張清單一定要在「匯出」與「匯入」兩端對稱使用**（2026-07-29，自審抓到的 blocking 回歸）。
 *    第一版只接上匯出端，結果「匯出→匯入回自己的帳號」把所有帳號洗成空字串、還回 200。
 *    匯入端的對稱處理在 `lib/routes/core.js` 的 `isHosted()` 區塊——**改這裡就要去看那裡**。
 *    這正是 AGENTS.md「機密欄位只有一張清單、四條路全部從它出發」在防的事：
 *    開第二張清單可以，但**四條路要一起接**。
 *
 * 📌 已知代價（要講明，不要藏）：HOSTED 的備份還原到一個**全新帳號**時，帳號欄會是空的
 *    （匯入是「留空＝不變更」，新租戶取不到值）。還原到自己原本的帳號**不受影響**（有考題釘住）。
 * @param {any} db @returns {any}
 */
export function stripSecretsForBackup(db) {
  const copy = JSON.parse(JSON.stringify(db ?? null));
  return mapBackupOnlyPii(mapSecrets(copy, () => ''), () => '');
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
