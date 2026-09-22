# 契約：共用底層（跨領域與全域的同步點）

> 本檔是 AGENTS.md「同步點清單」拆出的**第六個領域契約**（2026-09-22，裁示者裁「丁」；**實作者轉述，沒有原話、沒有留痕**）。
> ⚠️ **它跟前五份不一樣：前五份是「命中責任檔案才讀」，這一份是不分領域一律讀**——因為裡面每一條都**同時落在兩個以上的領域**（或不屬於任何單一領域）。
> **內文＝AGENTS.md 原文逐字照搬**，轉換**兩類**：①表格列解框成「改這裡／記得同步這裡」兩段（跟前五份同樣的做法）②**搬移後失效的位置語**，逐處在原地用〔…〕宣告（目前一處：`集合新增欄位（表單加新欄）`那一節的「下方『欄位所有權』節」——在 AGENTS 表格裡「下方」成立，搬過來就指不到，改成指回 AGENTS 該節、語意未變）。對照表在變更說明。⚠️ 先前這一行寫「轉換只有一類」，加了第②類之後那句就不成立（#633 r2 抓到、已更正）。
> **適用檔案清單＝[README.md](README.md)「共用底層」節的責任檔案清單（單一真相，本頁首不重複維護一份會走散的副本）**——⚠️ 但**這一份不是「命中才讀」**：README 硬規則③要求**不分領域一律讀**，那份清單是額外的路徑路由。
> ⚠️ **本支的選取母集合＝AGENTS 同步點表裡「還沒拆出去」的那 10 列**，不是整張 88 列。同一個判準套到**已經拆走、只剩索引的那 78 列**，也會命中 10 列跨領域（第 3、5、6、7、10、17、35、44、77、81 列）——**它們不在本支**（已各自住在領域契約裡），要不要重新分配是另一件事、記成待辦（#633 r1）。
> **入場條件（寫死，防它變成垃圾桶）**：一條同步點要住進這裡，必須**①它提到的檔案跨兩個以上領域的責任清單，或②它根本不屬於任何單一領域**。只落在一個領域的，一律回那個領域的契約。

## 請求旗標一律嚴格

**改這裡**：**請求旗標一律嚴格**（`lib/routes/` 讀 body 的開關）

**記得同步這裡**：只有 `=== true`／`!== true` 算「打開」——`!!x` 與直接拿來當條件的寫法連字串 `'false'` 都算開，而「同店一起改」這種開關誤開會一次改到很多筆（William 2026-09-05 裁）。行為與形狀兩層考題在 `test/request-flags.test.js`；**新增開關名要一起加進那支的名單**，否則形狀那道網看不到它

## 異常輸入防線

**改這裡**：異常輸入防線（階段四 B，2026-07-27 上線）

**記得同步這裡**：字串長度兩級制（`lib/schema.js`）：**短欄位 `LEN_SHORT`=200**（預設）／**長內容 `LEN_LONG`=20000**（`LONG_TEXT_FIELDS` 名單：note/stmtRef/autoNote/bankRef/benefits/coverage/thesis…＋研究巢狀寫作欄 reasons/text/note/assumptions 掛 `{long:true}`）。**長度 400 只擋新輸入**（`pickWritable`＝CRUD，錯誤點名欄位＋上限＋實際長度、絕不靜默截斷）；**備份還原路（`validateImportItem`）與櫃檯（兩種模式）一律放行只 warn**——裁決「合法舊資料不可因升級被刪」，超長舊備份必須還原得回來（#201 的 >1MB 考題釘這件事；throw 會把還原變 500＝Codex r2 收官#1 同款教訓）。研究巢狀用模組級 `lenEnforced` flag 切嚴格/寬容（全同步無 await、不跨請求汙染；`sanitizeResearchItemLenient`）。settings 字串欄位未納入本輪（欄位少且全短、路由剝除語意既有——記錄在案的範圍取捨，Codex 覆核同意不列 blocker、多人化前另盤點）。**服務層新輸入路也要牆**（Codex #297 複審抓到繞道）：`POST /api/cards/:id/statement/import` 吃 client 直給的 rows、不經 pickWritable → `importRows` 入口逐筆驗 desc（長級）/category/subcategory（短級）超過整批 400 點名；銀行與證券匯入吃 b64 PDF 伺服器端解析＝天然安全（desc 非 client 直給）。新增「client 可直給列資料」的匯入端點時必須比照加牆。考題 `test/input-guard.test.js`。

## COMPOSITION 穿透表的兩份複本

**改這裡**：`public/modules/portfolio-exposure.js` 的 `COMPOSITION` 穿透表

**記得同步這裡**：`lib/derive.js` 的同名複本

## LIABILITY_TYPES 的三份複本

**改這裡**：`public/modules/accounts-model.js` 的 `LIABILITY_TYPES`（前端單一真相：`fxExposure`、帳戶表單的型別選項、資產頁的負債紅字都讀它）

**記得同步這裡**：還要一起改的地方**逐一列名、刻意不寫「共幾處」**（這一族的數字漂過兩次：「兩處」→「三處」→其實還藏著第四第五份）：`lib/derive.js` 的同名複本、`lib/schema.js` 的 `accounts.type` 枚舉。⚠️**存得進去的一定要選得到**：枚舉有而表單沒有的型別，使用者在下拉裡**選不到**（只能改資料庫才設得上去）；那種既有帳戶的現值本身已由 `public/modules/form-options.js` 的通用保留機制守住（**不再**一打開儲存就靜靜變 `cash`），但下拉裡顯示的是資料裡的原始代碼、不是中文標籤。三者的相等由 `test/exposure-sync-integrity.test.js` 釘住，那支還有一題全站掃描擋「又長出一份手抄複本」

## IB 同步 DEFAULT_LAYER 新增代號

**改這裡**：`lib/services/ib-sync.js` `DEFAULT_LAYER` 新增代號

**記得同步這裡**：兩份 COMPOSITION 也要有該代號，否則穿透 fallback「其他」、國家上限提醒偏掉

## settings 新增欄位

**改這裡**：settings 新增欄位

**記得同步這裡**：`lib/store.js emptyDb()` 預設值＋`data/seed.json`＋設定頁 UI＋`lib/types.js` 的 `Settings` typedef＋**`lib/schema.js` 的 settings 白名單**（前端可寫的頂層欄位進 `SETTINGS_WRITABLE_FIELDS`、signals 進 `SIGNALS_WRITABLE_FIELDS`、ib 進 `IB_WRITABLE_FIELDS`；漏加會在 `/api/settings` 被剝掉、console 有警告。IB 同步擁有的 lastEquity/income/lastSync 刻意不在白名單、只由 `lib/services/ib-sync.js` 寫）。**非前端寫、但由服務層存進 settings 的欄位（如 `expenseTree`/`incomeTree`/`categoryAliases`/`subAliases`/`incomeCategoryAliases`/`incomeSubAliases`、`storeRules`）＝匯入備份必須保留**：加進 `sanitizeSettings`（否則 export→import 會遺失、Codex#1）＋`sanitizeSettingsDeep`（櫃檯），兩者共用同一個驗證器（分類欄＝`sanitizeCategorySettings`；店名規則＝`pickStoreRules`→`lib/store-rules.js` 的 `sanitizeStoreRules`，形狀與編譯器住同一個檔才不會走鐘）。⚠️**收入別名（`incomeCategoryAliases`/`incomeSubAliases`，Codex r13#3）與支出同款**：銀行匯入會自動分類收入（classifyBankTx 出 被動/利息…），`saveIncomeTree` 改名時建別名、`resolveImportIncome` 匯入時套別名沿用新名，並連動 `learnedBank` type:'income' 規則——收入不再是「純手動、無別名」。手做的店名規則若因還原備份而消失＝白做，務必保留

## 集合新增欄位（表單加新欄）

**改這裡**：集合新增欄位（表單加新欄）

**記得同步這裡**：checklist：使用者可寫→補 **`lib/schema.js` 的 `WRITABLE_FIELDS`**（漏加會被默默剝掉、console 有警告）；數值/布林/枚舉/陣列→同補 **`FIELD_SCHEMA`**＋`lib/types.js` typedef；**服務層擁有的衍生欄位絕不進 CRUD 白名單**。原則、三道寫入閘門、逐集合歸屬與「PUT 挾帶假值」病史＝AGENTS.md 的「**⚠️ 欄位所有權**」節（單一真相）〔**本支必要轉寫**：原文寫「下方」，那是它還在 AGENTS 表格裡時的位置語；搬到本契約之後「下方」指不到，改成指回 AGENTS 該節，**語意未變**〕。測試種帳單假資料走 repo 直寫（`server.test.js seedTx`），不可為了種資料把白名單加回去

## 跨 await 的寫入安全

**改這裡**：**IB 同步跨 await 的寫入安全**（Codex r3#1，高）

**記得同步這裡**：`syncIb` **等待網路請求之前只讀「發請求需要的設定」（`getSettings`），整包資料庫等回應之後才 `getDb()`**。原本一開頭就拿整包、請求結束把那份過期快照整包寫回——Flex Query 要跑數秒到數十秒，期間任何寫入都被靜默吃掉（Codex 實測：同步中寫入的當日日線，同步完成後整個消失；交易與月快照同理且**不會自癒**）。⚠️ 任何「讀整包 → await → 寫整包」的流程都有這個病，新增類似流程時一律「await 之後重讀再合併」（另兩個前例＝`normalizeIfRulesChanged` 的 `const fresh = getDb()`；`lib/services/market-data.js refreshQuotesIfStale` await 前只讀新鮮度＋要抓哪些代號、await 後才 `getDb()` 合併匯率/股價再寫，Codex r13#1——原本 await 前拿整包、報價回來把舊快照整包寫回，會吞掉抓報價期間的記帳/店名整理）。
