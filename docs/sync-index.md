# 同步點索引

由共同入口 [AGENTS.md](../AGENTS.md) 路由至本檔；本檔為下列內容的正本。

## ⚠️ 同步點清單（改一處必須檢查另一處）

> **領域拆分（D4，2026-07-31 起）**：部分領域已拆到 `docs/contracts/`——**開工前先看 [docs/contracts/README.md](contracts/README.md) 的路由表**（改哪些檔→必讀哪份契約）。拆出的領域在下表只留一行索引＋連結、完整內文逐字在契約檔；未拆領域照舊在本表。

| 改這裡 | 記得同步這裡 |
|---|---|
| SEC 官方指標候選 tag 與 `selectMetric`（`lib/stock-fundamentals.js`） | ——完整契約 → [契約：投資與 SEC・SEC 官方指標挑值](contracts/investment-sec.md#sec-官方指標挑值) |
| SEC 最新單季逐列期間（`periods.latestQuarterBasis:'per-metric'`） | ——完整契約 → [契約：投資與 SEC・最新單季逐列期間](contracts/investment-sec.md#最新單季逐列期間) |
| `lib/parse-limits.js` 的 `MAX_SEC_RESPONSE_BYTES` | ——完整契約 → [契約：投資與 SEC・SEC 單一回應資源上限](contracts/investment-sec.md#sec-單一回應資源上限) |
| SEC `currentDebt`（`lib/stock-fundamentals.js`） | ——完整契約 → [契約：投資與 SEC・SEC currentDebt 流動債務](contracts/investment-sec.md#sec-currentdebt-流動債務) |
| `lib/repo.js` 介面（加函式／改簽名） | ——完整契約 → [契約：資料與儲存・repo 介面的新增與修改](contracts/data-storage.md#repo-介面的新增與修改) |
| **kv 的鍵**（`lib/store.js` 的 `KV_KEYS`／`KV_MAP_KEYS`；`emptyDb()` 加頂層欄位時） | ——完整契約 → [契約：資料與儲存・kv 的鍵](contracts/data-storage.md#kv-的鍵) |
| **HOSTED 資料層**（`lib/store-pg.js`／`db/supabase-schema.sql`／RLS 政策） | ——完整契約 → [契約：資料與儲存・HOSTED 資料層與測試替身](contracts/data-storage.md#hosted-資料層與測試替身) |
| **HOSTED 的並行安全＝compare-and-swap（C4b，契約 P1-5）** | ——完整契約 → [契約：資料與儲存・HOSTED 並行安全 CAS](contracts/data-storage.md#hosted-並行安全-cas) |
| 本機檔案操作一律經櫃檯（`backupNow`/`snapshotTo`/`dataDir`，維持同步簽名） | ——完整契約 → [契約：資料與儲存・本機檔案操作一律經櫃檯](contracts/data-storage.md#本機檔案操作一律經櫃檯) |
| **資料存取單一櫃檯（B1）** | ——完整契約 → [契約：資料與儲存・資料存取單一櫃檯 B1](contracts/data-storage.md#資料存取單一櫃檯-b1) |
| **驗證入櫃檯（B3）** | ——完整契約 → [契約：資料與儲存・驗證入櫃檯 B3](contracts/data-storage.md#驗證入櫃檯-b3) |
| **日期／月份走「真實日曆」判準（`isRealMonth`／`isRealDate`，Codex r3#9）** | ——完整契約 → [契約：資料與儲存・日期與月份的真實日曆判準](contracts/data-storage.md#日期與月份的真實日曆判準) |
| **必填欄位機制（`REQUIRED_FIELDS`，哪些集合、哪些欄一律以 `lib/schema.js` 的 `REQUIRED_FIELDS` 為準——本檔曾凍結一份清單、實際已漂＝改 schema 的人看不到這裡（教材句自己也不寫數字——寫了就是下一個會漂的）；`securityTrades` 的查帳合約欄全列必填，含核心金額 price/grossAmount/netSettlement）**；跨欄位不變式走 **`ROW_RULES`**（同三個強制點；清單以 schema.js 的 ROW_RULES 為準——例：securityTrades 的 buy→out／sell→in） | ——完整契約 → [契約：資料與儲存・必填欄位機制與跨欄不變式](contracts/data-storage.md#必填欄位機制與跨欄不變式) |
| **請求旗標一律嚴格**（`lib/routes/` 讀 body 的開關） | ——完整契約 → [契約：共用底層・請求旗標一律嚴格](contracts/shared-foundation.md#請求旗標一律嚴格) |
| **測試隔離慣例（B0）** | ——完整契約 → [契約：資料與儲存・測試隔離慣例 B0](contracts/data-storage.md#測試隔離慣例-b0) |
| PDF 逐列抽取器（pdfjs → 帶座標的列） | ——完整契約 → [契約：收支記帳與匯入・PDF 逐列抽取器](contracts/income-expense.md#pdf-逐列抽取器) |
| **銀行對帳單解析器＝`lib/bank-statement.js`**（與信用卡解析完全分開） | ——完整契約 → [契約：收支記帳與匯入・銀行對帳單解析與分箱](contracts/income-expense.md#銀行對帳單解析與分箱) |
| **帳戶 `accountNo`（完整帳號，PII）與餘額匯入** | ——完整契約 → [契約：收支記帳與匯入・帳戶完整帳號與餘額匯入](contracts/income-expense.md#帳戶完整帳號與餘額匯入) |
| **帳單原文取法**（後端 `origFromStmtRef`／前端 `stmtOrig`） | ——完整契約 → [契約：收支記帳與匯入・帳單原文取法 origFromStmtRef](contracts/income-expense.md#帳單原文取法-origfromstmtref) |
| **匯入對帳閘（強／中／弱三級）＝`lib/statement-reconcile.js`**（P0，2026-08-11；施工計畫＝docs/parser-generalization-plan.md §四、#437 定案） | ——完整契約 → [契約：收支記帳與匯入・匯入對帳閘](contracts/income-expense.md#匯入對帳閘) |
| **匯入密碼池（P0.5，使用者 2026-08-11 拍板：銀行與信用卡匯入密碼一致化）** | ——完整契約 → [契約：收支記帳與匯入・匯入密碼池](contracts/income-expense.md#匯入密碼池) |
| **AI 解析路線（銀行對帳單「認不得」的 fallback；★3 拍板 2026-08-12＝Anthropic）** | ——完整契約 → [契約：收支記帳與匯入・AI 解析路線 P1b](contracts/income-expense.md#ai-解析路線-p1b) |
| **配方快取（AI 讀一次→留純資料翻譯規則卡→同版面 app 內解；★4＋格式 A 拍板，施工計畫 §五 P2）** | ——完整契約 → [契約：收支記帳與匯入・配方快取 P2](contracts/income-expense.md#配方快取-p2) |
| 信用卡負數交易的繳款／退款判斷 | ——完整契約 → [契約：收支記帳與匯入・信用卡負數交易的繳款與退款判斷](contracts/income-expense.md#信用卡負數交易的繳款與退款判斷) |
| 月度回顧的消費口徑與退款配對 | ——完整契約 → [契約：收支記帳與匯入・月度回顧的消費口徑與退款配對](contracts/income-expense.md#月度回顧的消費口徑與退款配對) |
| 信用卡費頁的兩種口徑（使用者定 2026-07-27） | ——完整契約 → [契約：收支記帳與匯入・信用卡費頁的兩種口徑](contracts/income-expense.md#信用卡費頁的兩種口徑) |
| 每日滾動備份（階段四 A，2026-07-27 上線） | ——完整契約 → [契約：資料與儲存・每日滾動備份](contracts/data-storage.md#每日滾動備份) |
| 異常輸入防線（階段四 B，2026-07-27 上線） | ——完整契約 → [契約：共用底層・異常輸入防線](contracts/shared-foundation.md#異常輸入防線) |
| **機密投影與匯出的兩種模式**（鐵則 1 後半拆出；容器規則前半仍在鐵則 1） | ——完整契約 → [契約：雲端與安全・機密投影與匯出的兩種模式](contracts/cloud-security.md#機密投影與匯出的兩種模式) |
| 畫面要照模式講機密流向時——匯出告知「檔案含不含機密」、銀行對帳單上傳的密碼欄講「密碼會不會離開這台電腦」（端點＝`GET /api/mode`）。 | ——完整契約 → [契約：雲端與安全・匯出前告知的模式分流](contracts/cloud-security.md#匯出前告知的模式分流) |
| 雙模式與帳號系統（C2，2026-07-27 上線） | ——完整契約 → [契約：雲端與安全・雙模式與帳號系統](contracts/cloud-security.md#雙模式與帳號系統) |
| **機密欄位**（新增一個「不可外流」的欄位時） | ——完整契約 → [契約：雲端與安全・機密欄位與 mapSecrets](contracts/cloud-security.md#機密欄位與-mapsecrets) |
| **只剝不加密的 PII**（第二張清單，2026-07-29 建立） | ——完整契約 → [契約：雲端與安全・只剝不加密的 PII mapBackupOnlyPii](contracts/cloud-security.md#只剝不加密的-pii-mapbackuponlypii) |
| 機密加密（C5，2026-07-27 上線） | ——完整契約 → [契約：雲端與安全・機密加密與解不開的寫回保護](contracts/cloud-security.md#機密加密與解不開的寫回保護) |
| 解析器資源上限＋slowloris 逾時（可用性第一層，2026-07-28 上線） | ——完整契約 → [契約：雲端與安全・解析器資源上限與行程隔離](contracts/cloud-security.md#解析器資源上限與行程隔離) |
| **SEC 全站佇列護欄（2026-07-30，#335 複審 dos 條）** | ——完整契約 → [契約：投資與 SEC・SEC 全站佇列護欄](contracts/investment-sec.md#sec-全站佇列護欄) |
| `lib/heavy-admission.js`（`HEAVY_ADMISSION_MAX_INFLIGHT`／`HEAVY_ROUTES`／`withHeavySlot`） | ——完整契約 → [契約：投資與 SEC・重型工作名額（heavy admission）與 SEC 的關係](contracts/investment-sec.md#重型工作名額heavy-admission與-sec-的關係) |
| 速率限制（可用性第一層，2026-07-28 上線） | ——完整契約 → [契約：雲端與安全・速率限制](contracts/cloud-security.md#速率限制) |
| 租戶隔離與雲端資料層（C4b，2026-07-27 上線） | ——完整契約 → [契約：雲端與安全・租戶隔離與請求範圍狀態](contracts/cloud-security.md#租戶隔離與請求範圍狀態) |
| 部署設定（`render.yaml`＋CI，2026-07-28 對齊） | ——完整契約 → [契約：雲端與安全・部署設定與版號單一真相](contracts/cloud-security.md#部署設定與版號單一真相) |
| 月度回顧總覽卡 | ——完整契約 → [契約：前端功能・月度回顧總覽卡](contracts/frontend-features.md#月度回顧總覽卡) |
| **async render 寫 `#view` 前要 guard 序號**（Codex r10#6） | ——完整契約 → [契約：前端功能・async render 與路由序號 guard](contracts/frontend-features.md#async-render-與路由序號-guard) |
| **共用彈窗契約**（modal-shell.js 的邊界） | ——完整契約 → [契約：前端功能・共用彈窗契約](contracts/frontend-features.md#共用彈窗契約) |
| 淨值目標與到達速度 | ——完整契約 → [契約：前端功能・淨值目標與到達速度](contracts/frontend-features.md#淨值目標與到達速度) |
| `public/modules/portfolio-exposure.js` 的 `COMPOSITION` 穿透表 | ——完整契約 → [契約：共用底層・COMPOSITION 穿透表的兩份複本](contracts/shared-foundation.md#composition-穿透表的兩份複本) |
| `public/modules/accounts-model.js` 的 `LIABILITY_TYPES`（前端單一真相：`fxExposure`、帳戶表單的型別選項、資產頁的負債紅字都讀它） | ——完整契約 → [契約：共用底層・LIABILITY_TYPES 的三份複本](contracts/shared-foundation.md#liability_types-的三份複本) |
| `portfolio-exposure.js` `fxExposure` 寫死的台幣掛牌美債 ETF 清單（00719B/00720B） | ——完整契約 → [契約：投資與 SEC・台幣掛牌美債 ETF 清單](contracts/investment-sec.md#台幣掛牌美債-etf-清單) |
| 新增 ETF 持股 | ——完整契約 → [契約：投資與 SEC・新增 ETF 持股](contracts/investment-sec.md#新增-etf-持股) |
| `lib/services/ib-sync.js` `DEFAULT_LAYER` 新增代號 | ——完整契約 → [契約：共用底層・IB 同步 DEFAULT_LAYER 新增代號](contracts/shared-foundation.md#ib-同步-default_layer-新增代號) |
| IB 槓桿＋斷頭距離公式（lastEquity 優先、自算 fallback） | ——完整契約 → [契約：投資與 SEC・IB 槓桿與斷頭距離](contracts/investment-sec.md#ib-槓桿與斷頭距離) |
| 投資頁前端模組（`portfolio-*.js` 家族的座位表、工作流、停止線與格式單一真相） | ——完整契約 → [契約：投資與 SEC・投資頁前端模組分工](contracts/investment-sec.md#投資頁前端模組分工) |
| **IB 現金幣別歸零**（Codex r4#3） | ——完整契約 → [契約：投資與 SEC・IB 現金幣別歸零](contracts/investment-sec.md#ib-現金幣別歸零) |
| **多幣別損益**（缺幣別與缺匯率是兩種病） | ——完整契約 → [契約：投資與 SEC・多幣別損益](contracts/investment-sec.md#多幣別損益) |
| **XIRR（資金加權年化，台幣）** | ——完整契約 → [契約：投資與 SEC・XIRR 資金加權年化](contracts/investment-sec.md#xirr-資金加權年化) |
| `securityTrades`（READONLY，前端只 GET） | ——完整契約 → [契約：投資與 SEC・securityTrades 欄位所有權與去重](contracts/investment-sec.md#securitytrades-欄位所有權與去重) |
| 投資代號與投資原則上限／凍結加碼 | ——完整契約 → [契約：投資與 SEC・投資代號與原則上限](contracts/investment-sec.md#投資代號與原則上限) |
| **訂閱續費日自動推進**（使用者定 2026-07-26） | ——完整契約 → [契約：前端功能・訂閱續費日自動推進](contracts/frontend-features.md#訂閱續費日自動推進) |
| 訂閱本月攤提（停用當月月繳不計、季/年繳按天數比例） | ——完整契約 → [契約：前端功能・訂閱本月攤提](contracts/frontend-features.md#訂閱本月攤提) |
| 訂閱狀態（使用中/即將停用/已停用） | ——完整契約 → [契約：前端功能・訂閱狀態](contracts/frontend-features.md#訂閱狀態) |
| YYYY-MM-DD 日期解析 | ——完整契約 → [契約：前端功能・YYYY-MM-DD 日期解析](contracts/frontend-features.md#yyyy-mm-dd-日期解析) |
| `theme.js` 的 CHART.green/red | ——完整契約 → [契約：前端功能・圖表色與 CSS 狀態色](contracts/frontend-features.md#圖表色與-css-狀態色) |
| settings 新增欄位 | ——完整契約 → [契約：共用底層・settings 新增欄位](contracts/shared-foundation.md#settings-新增欄位) |
| 集合新增欄位（表單加新欄） | ——完整契約 → [契約：共用底層・集合新增欄位（表單加新欄）](contracts/shared-foundation.md#集合新增欄位表單加新欄) |
| **IB 同步跨 await 的寫入安全**（Codex r3#1，高） | ——完整契約 → [契約：共用底層・跨 await 的寫入安全](contracts/shared-foundation.md#跨-await-的寫入安全) |
| **銀行收支「真·學習」的方向與內轉子分類**（Codex r13#2/#4） | ——完整契約 → [契約：收支記帳與匯入・銀行收支真學習的方向與內轉子分類](contracts/income-expense.md#銀行收支真學習的方向與內轉子分類) |
| **銀行交易的帳單原文＝ `bankSummary`／`bankNote` 兩欄**（Stage 2，使用者定 2026-08-22） | ——完整契約 → [契約：收支記帳與匯入・帳單原文摘要與備註分兩欄留底](contracts/income-expense.md#帳單原文摘要與備註分兩欄留底) |
| 銀行收支兩行文字與使用者選擇的「相同文字一起修改」（William 2026-10-02 裁示） | ——完整契約 → [契約：收支記帳與匯入・銀行收支可編輯摘要與備註](contracts/income-expense.md#銀行收支可編輯摘要與備註) |
| **機構名＝`lib/bank-alias.js` 的正規短名**（Stage 4，使用者 2026-08-20 排定「機構名別名對照表：台新／台新銀行／TAISHIN → 同一代碼」） | ——完整契約 → [契約：收支記帳與匯入・機構名正規化與祖父比對形](contracts/income-expense.md#機構名正規化與祖父比對形) |
| **「同類/同店一起改」＝單一原子指令**（護欄 G3，2026-07-22） | ——完整契約 → [契約：收支記帳與匯入・同類同店一起改是單一原子指令](contracts/income-expense.md#同類同店一起改是單一原子指令) |
| **停車費顯示包裝的觸發＝子類身分、非字面**（護欄 G4，2026-07-22；name/ID 分離） | ——完整契約 → [契約：收支記帳與匯入・停車費顯示包裝的觸發](contracts/income-expense.md#停車費顯示包裝的觸發) |
| **帳戶顯示名 denormalized 到 `transactions.account`**（使用者定 2026-07-21「改一次、處處同步」） | ——完整契約 → [契約：收支記帳與匯入・帳戶顯示名 denormalized 到交易](contracts/income-expense.md#帳戶顯示名-denormalized-到交易) |
| **時鐘倒退保護**（Codex r3#8，中） | ——完整契約 → [契約：前端功能・時鐘倒退保護](contracts/frontend-features.md#時鐘倒退保護) |
| **淨值日線 `dailyValues`**（D0，每日洞察引擎的地基；使用者定 2026-07-19） | ——完整契約 → [契約：前端功能・淨值日線 dailyValues](contracts/frontend-features.md#淨值日線-dailyvalues) |
| 估值訊號門檻／檔位（**程式單一真相＝`public/modules/signal-tiers.js`**，D3 抽出） | ——完整契約 → [契約：投資與 SEC・估值訊號門檻檔位](contracts/investment-sec.md#估值訊號門檻檔位) |
| **每日洞察引擎書籤 `insightState`＋差異引擎**（D3，2026-07-22） | ——完整契約 → [契約：前端功能・每日洞察引擎書籤 insightState](contracts/frontend-features.md#每日洞察引擎書籤-insightstate) |
| `settings.signals`（美股自動、區域四市場每月手動） | ——完整契約 → [契約：投資與 SEC・settings-signals](contracts/investment-sec.md#settings-signals) |
| 支出分類（兩層：分類/子類，**使用者可自訂** 2026-07） | ——完整契約 → [契約：收支記帳與匯入・支出分類兩層與使用者自訂](contracts/income-expense.md#支出分類兩層與使用者自訂) |
| `lib/statement.js` `CATEGORY_RULES` 關鍵字順序 | ——完整契約 → [契約：收支記帳與匯入・CATEGORY_RULES 關鍵字順序](contracts/income-expense.md#category_rules-關鍵字順序) |
| 帳單多銀行/多格式（`parseStatement` 依位元組偵測 PDF/XLSX；PDF 再依**文件內容**判富邦/台新） | ——完整契約 → [契約：收支記帳與匯入・帳單多銀行與多格式解析](contracts/income-expense.md#帳單多銀行與多格式解析) |
| **顯示標記 `applyDisplayLabels(name, {desc, subcategory})`**（使用者定 2026-07-18） | ——完整契約 → [契約：收支記帳與匯入・顯示標記 applyDisplayLabels](contracts/income-expense.md#顯示標記-applydisplaylabels) |
| **使用者自訂店名規則 `settings.storeRules`**（第三帖「規則自助化」，使用者定 2026-07-19） | ——完整契約 → [契約：收支記帳與匯入・使用者自訂店名規則 storeRules](contracts/income-expense.md#使用者自訂店名規則-storerules) |
| **「規則入櫃檯」**（第三帖）：`lib/repo.js` 每次讀取都把 `settings.storeRules` 餵給 `store-rules.js` 的模組級單例 | ——完整契約 → [契約：收支記帳與匯入・規則入櫃檯](contracts/income-expense.md#規則入櫃檯) |
| 規則指紋 `settings.storeRulesHash`（開 app 自動整理的依據） | ——完整契約 → [契約：收支記帳與匯入・規則指紋 storeRulesHash](contracts/income-expense.md#規則指紋-storeruleshash) |
| 店名規則的 API 與 UI | ——完整契約 → [契約：收支記帳與匯入・店名規則的 API 與 UI](contracts/income-expense.md#店名規則的-api-與-ui) |
| **不可逆整批操作「刻意沒有」操作前備份**（William 2026-08-08 裁決） | ——完整契約 → [契約：資料與儲存・不可逆整批操作刻意沒有操作前備份](contracts/data-storage.md#不可逆整批操作刻意沒有操作前備份) |
| 帳單上傳「免選卡」自動歸卡（`POST /api/statement/preview`） | ——完整契約 → [契約：收支記帳與匯入・帳單上傳免選卡自動歸卡](contracts/income-expense.md#帳單上傳免選卡自動歸卡) |
| 帳單匯入批次／事後整批改卡片 | ——完整契約 → [契約：收支記帳與匯入・帳單匯入批次與事後整批改卡片](contracts/income-expense.md#帳單匯入批次與事後整批改卡片) |
| 帳單「自動學習」店名＋分類（`db.learnedCategories`＝{ `storeKey`(cleanStore後原名) → {category?,subcategory?,name?} }） | ——完整契約 → [契約：收支記帳與匯入・帳單自動學習店名與分類](contracts/income-expense.md#帳單自動學習店名與分類) |
| **店家消費檔案**（收支列表點店名開彈窗；使用者定 2026-07-18） | ——完整契約 → [契約：收支記帳與匯入・店家消費檔案](contracts/income-expense.md#店家消費檔案) |
