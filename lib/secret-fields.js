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
// ⚠️ **`/api/export`（下載備份）在 LOCAL 一定要用未投影的完整資料**——備份漏了密碼，還原後就永久遺失。
//    **HOSTED 刻意相反**（C5 裁決⑤）：走 `stripSecretsForBackup` 剝掉 `mapSecrets` 列出的**每一個**機密＋`accountNo`，
//    （刻意不寫死幾個——鐵則 10：P0.5 加了密碼池，原本寫死的「三個」當場過期）
//    因為那個檔案會經瀏覽器下載、可能轉寄或存到別處。分流在 `lib/routes/core.js` 的 `/api/export`。

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
// 📌 `lib/store-pg.js` 的「解不開就把原密文寫回去」只保護**上面 `mapSecrets` 目前列的欄位**（顆數刻意不寫死——寫死的數字自己會漂）。
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
  // ⚠️⚠️ **不可以要求「欄位已經存在」**（2026-07-29，Codex 定向複審第四輪抓到的 High）。
  //    這是 `mapBackupOnlyPii` v2 修過的**同一個病，在這個函式裡沒人修**：
  //    `validateImportItem` 允許舊備份省略非必填欄位，而這裡原本寫 `'pdfPassword' in c`，
  //    於是「省略了 pdfPassword 的卡片」整張被跳過。兩個後果都實測重現過：
  //    ①舊備份省略欄位 → 現有密碼**沒機會被填回，匯入回 200 後永久消失**。
  //    ②兩張同 id、其中一張省略欄位 → 目標側只數到一次 → **繞過重複路徑判定**，
  //      舊密碼被填進其中一張。
  //    所以現在**一律走訪**，欄位不存在就當空字串——與 accountNo 同一個判準。
  if (d.settings && typeof d.settings === 'object') {
    d.settings.taishinSecPdfPassword = fn(String(d.settings.taishinSecPdfPassword ?? ''), 'settings.taishinSecPdfPassword', true);
    // 記住的帳單密碼池（P0.5）：整串 JSON 當**單一字串**走固定路徑——AAD 穩定；陣列逐元素加密
    // 是死路（索引 AAD 重排解不開／塌同路徑撞 C6 撞號不救名單），勿改回逐元素。
    d.settings.rememberedStatementPasswords = fn(String(d.settings.rememberedStatementPasswords ?? ''), 'settings.rememberedStatementPasswords', true);
    // AI 解析鑰匙（P1b-1，★3 拍板＝Anthropic）：比照 flexToken——LOCAL 明文、HOSTED 加密、投影剝除
    d.settings.aiApiKey = fn(String(d.settings.aiApiKey ?? ''), 'settings.aiApiKey', true);
    // `ib` 不存在時**不要**幫它造一個（那會改變 db 形狀）；存在就一定走訪 flexToken。
    if (d.settings.ib && typeof d.settings.ib === 'object') {
      d.settings.ib.flexToken = fn(String(d.settings.ib.flexToken ?? ''), 'settings.ib.flexToken', true);
    }
  }
  if (Array.isArray(d.cards)) {
    for (const c of d.cards) {
      if (!c || typeof c !== 'object') continue;
      c.pdfPassword = fn(String(c.pdfPassword ?? ''), `cards.${String(c.id ?? '')}.pdfPassword`, isStableId(c.id));
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

/** settings 投影：剝掉 ib.flexToken 與 taishinSecPdfPassword（證券對帳單密碼＝身分證字號級），各補 <欄>Set 布林；
 * 記住的帳單密碼池（P0.5）同樣剝除、只回 `rememberedStatementPasswordsCount`（幾組——設定頁「已記住 N 組／清除」用，
 * 數量不是機密、內容是）。 @param {any} s */
export function projectSettings(s) {
  if (!s || typeof s !== 'object') return s;
  const { taishinSecPdfPassword, rememberedStatementPasswords, aiApiKey, ...rest } = s;
  let pwCount = 0;
  try { const arr = JSON.parse(String(rememberedStatementPasswords || '[]')); if (Array.isArray(arr)) pwCount = arr.filter((x) => typeof x === 'string' && x).length; } catch { /* 壞形狀＝當 0 組，不炸投影 */ }
  const out = { ...rest, taishinSecPdfPasswordSet: isSet(taishinSecPdfPassword), rememberedStatementPasswordsCount: pwCount, aiApiKeySet: isSet(aiApiKey) };
  if (out.ib && typeof out.ib === 'object') {
    const { flexToken, ...ibRest } = out.ib;
    out.ib = { ...ibRest, flexTokenSet: isSet(flexToken) };
  }
  return out;
}

/** 帳戶投影（三層重構 stage 2）：剝掉完整帳號 accountNo（PII），只回 accountNoSet 布林＋末四碼（顯示用、安全）。
 * 完整帳號只用於「銀行對帳單末碼比對」（伺服器端做），前端從不需要它——同 pdfPassword 的「機密不送瀏覽器」原則。
 *
 * ⚠️ **`accountNoLast4` 的消費者只有顯示層**（2026-08-05 查證，別把它讀成比它更重要的東西）：
 *    `public/modules/assets.js` 的帳戶表末碼欄與編輯窗的「已設定（末四碼 ⋯）」提示，全 repo 就這兩處。
 *    銀行對帳單配對（`lib/services/bank-import.js` 的 `matchAccount`）與「自家帳號末碼」判定
 *    （同檔 `ownSuffixSet`）讀的都是**伺服器端的完整 `accountNo`**，不讀這個投影欄位；
 *    信用卡帳單的末四碼更是另一份資料（`lib/statement.js` 的 `extractLastFour` 從帳單文字抽）。
 *    ⇒ 這一格算錯**不會**造成錯帳戶配對或錯卡歸帳；它的傷害是**畫面上的末碼與帳單對不起來**，
 *      使用者只能靠猜、而照著假末碼去「訂正」帳號才會真的動到伺服器端那個會配對的欄位。
 *
 * ⚠️ 這裡刻意**不寫「完整帳號永遠不送到瀏覽器」**（2026-08-05 自審抓到的事實錯誤，原本三處都這樣寫，
 *    而且本檔檔頭自己就寫著相反的例外＝前後矛盾）：**LOCAL 的 `GET /api/export`（備份下載）刻意回
 *    未投影的完整 `accountNo`**，前端那顆按鈕是 `public/modules/settings.js` 的
 *    `<a href="/api/export" download>`＝真的經瀏覽器下載；考題釘在 `test/server.test.js`
 *    （LOCAL export 斷言回完整值）。HOSTED 相反，走 `stripSecretsForBackup` 剝除。
 *
 * ⚠️⚠️ **也不可以寫成「UI 的任何頁面都拿不到完整帳號（唯一例外＝LOCAL 的備份下載）」**
 *    （2026-08-05 r7 實測到的**第二個反例**，前一版只補了備份下載那一個）：
 *    **HOSTED 也有一條路** ——`transactions[].bankRef`（銀行交易去重鍵）的第 2 段就是**帳單上那串
 *    帳號**（`lib/services/bank-import.js` 的 `bankRefBase`；P1a 起他行新格式 `bank2|機構|帳號|…`
 *    ＝帳號在第 3 段——段位不同、**暴露不變**，本節結論原句適用），而**銀行對帳單匯入自動建立的帳戶，
 *    就是拿同一串存進 `accountNo`**（同檔 `accountNo: pa.masked`）。`projectDb` 只投影
 *    cards／accounts／securityTrades／settings，**transactions 原樣送出** ⇒ `GET /api/db` 與
 *    `GET /api/transactions` 的回應**逐字含有那串帳號**。實測（隔離暫存 STORE_FILE、未碰
 *    `data/store.json`）：帳戶列投影正確（只回 `accountNoSet`／`accountNoLast4`），整包回應仍逐字
 *    含有 `900100****3301`。**Stage 2（2026-08-22）起同一段帳單原文另外存進 `bankSummary`／`bankNote`
 *    ——同樣原樣送出**；補記它不是為了把清單列全（列舉補不完），而是要說清楚重點：
 *    **`transactions` 整包未經投影**，任何存進交易的帳單原文都到得了前端。
 *    ⇒ **本函式能保證的只有這一句**：`accounts[].accountNo` 這個**欄位**不出現在任何讀取端的回應裡
 *      （唯一例外＝LOCAL 的備份下載）。它**不是**「那串值不會到瀏覽器」——對銀行匯入建立的帳戶，
 *      同一串值沿 `bankRef` 照樣到得了前端，「畫面上的末碼是唯一辨識線索」對那些帳戶也不成立。
 *    📌 這是**已知的知情缺口、不是本輪要修的東西**：`bankRef` 是既有資料的去重鍵（改它＝重複匯入、
 *      現金流翻倍），要收斂得連 `bankDirFromRef`／`bankAutoNote`／`applyLearnedBankToDb` 一起想，
 *      並自帶考題。目前全 repo 沒有前端程式讀 `bankRef`（grep 過 `public/`），所以它是**暴露面**
 *      而不是功能需求——但「沒人讀」不等於「沒送出去」，所以照實記在這裡。
 *    考題＝`test/hosted-walls-integrity.test.js`（外洩斷言的射程收在「那一筆帳戶／accounts 集合」，
 *    另有「外洩斷言的射程」一題用真 HTTP 播種這個形狀並留在暫存 DB 裡，讓「把射程放回整包」
 *    這個改法會在下一題立刻紅）。
 * @param {any} a */
export function projectAccount(a) {
  if (!a || typeof a !== 'object') return a;
  const { accountNo, ...rest } = a;
  const raw = String(accountNo || '');
  // 遮罩帳號（900100****3301）取「星號後的可見末碼」，不是整串數字尾 4（那會變 5162 之類的假末碼）；
  // 完整帳號（無星號）取純數字尾 4。
  // ⚠️ 星號與可見末碼之間**容忍空白或減號**（`1234**** 56`、`1234****-56` 都是手打得出來的寫法）。
  //    2026-08-05 前這裡要求數字**緊接**星號，那兩種寫法會整條判準不成立、退回「整串數字尾 4」＝
  //    回 `3456`：把遮罩掉的前綴 `1234` 的後兩碼跟可見的 `56` 湊成一個**帳單上不存在的末碼**。
  //    改動波及的範圍＝上面點名的那兩處顯示（`accountNoLast4` 的消費者 grep 過，全 repo 就那兩處）；
  //    配對與金額邏輯讀的是完整 `accountNo`、不經這裡。考題釘在
  //    `test/hosted-walls-integrity.test.js`（helper 判準與真 HTTP 接線兩層都有）。
  //    📌 仍未涵蓋、也不打算猜的形狀：可見末碼**後面還接非數字尾綴**（`900100****3301-01`）——
  //       判準照舊不成立、退回整串數字尾 4（`0101`）。真實資料還沒出現過這種寫法，
  //       與其猜一個答案，不如維持現狀並在此記名。
  const maskedTail = raw.match(/\*+[\s-]*(\d+)\s*$/);
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
  const out = {
    ...db,
    cards: Array.isArray(db.cards) ? db.cards.map(projectCard) : db.cards,
    accounts: Array.isArray(db.accounts) ? db.accounts.map(projectAccount) : db.accounts,
    securityTrades: Array.isArray(db.securityTrades) ? db.securityTrades.map(projectSecurityTrade) : db.securityTrades,
    settings: projectSettings(db.settings),
  };
  // 配方（規則卡）整個剝掉（Codex #513 r3#1）：內容是帳單版面字面；要它的畫面一律走 /api/parse-recipes 的
  //   封閉投影（只有身分與統計）——留在廣域的 /api/db＝封閉投影被旁路推翻。
  delete out.parseRecipes;
  return out;
}
