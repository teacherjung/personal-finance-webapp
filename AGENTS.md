# AGENTS.md — 給所有 AI 協作者（Codex / Claude / 其他）的專案規則書

這是三方協作（使用者 + Claude Code + Codex）的**單一真相來源**。動手前先讀完；改動若牽涉本文件的規則，請一併更新本文件。

## 專案概觀

本機優先（隱私第一）的個人理財網頁。**零建置**：改完存檔即生效，沒有 bundler/transpiler，不要引入 npm 前端相依。

- 後端：`server.js`（Express，只聽 `127.0.0.1`，埠 `PORT` 環境變數或 4321）
- 資料：`data/store.json`（本機 JSON，**已被 .gitignore 排除**）；首次啟動從 `data/seed.json` 複製
- 計算大腦：`lib/derive.js`（淨資產/現金流/提醒/投資原則檢查）
- IBKR 串接：`lib/ib.js`（Flex Query 唯讀）
- 前端：`public/` 原生 JS SPA——`app.js`（共用工具+路由）、`modules/*.js`（一頁一檔）、`modules/theme.js`（圖表色）、Chart.js（本機 vendor）

啟動：`npm start` → http://localhost:4321 。注意：使用者常自己開著一個伺服器佔 4321，`.claude/launch.json` 已設 `autoPort`。

## 鐵則（違反會壞事）

1. **敏感資料絕不進版控**：`data/store.json`、`*.bak`、`data/*backup*`（真實餘額、持倉、IBKR flexToken、**卡片的帳單 PDF 密碼 `pdfPassword`＝身分證字號**）。.gitignore 已擋，不要繞過。測試一律用 `data/seed.json`（維持「夠像真的」：多幣別、負現金融資、各層持股；**seed 的卡片不可放真實 pdfPassword**）。**非必要也不要「讀取」`data/store.json` 的內容**——它含真實個人財務資料與 token，讀進 AI 上下文等於外傳；要看資料形狀用 `seed.json`。帳單 PDF 只在記憶體解析、不落地保存。
2. **循環 import TDZ**：`app.js` 與各 module 互相 import。任何「模組檔案頂層就會取用」的共用常數，必須放在**零依賴的 `modules/theme.js`**（或同型新檔）直接 import，**不可**經 app.js 轉手。曾因此全站白屏卡「載入中」。
3. **XSS**：所有使用者資料插入 innerHTML 前必過 `esc()`（app.js 提供）。
4. **色彩分工**：
   - 分類色（圖表/長條/圓餅/圓點）只從 `theme.js` 的 `CHART`/`PALETTE` 取——六色盤已通過 dataviz 驗證，不要自創 hex。品牌珊瑚色（趨勢線、單色漸層）用 `theme.js` 的 `ACCENT`/`ACCENT_SOFT`。
   - 語意色 `--pos/--neg/--warn`（CSS token，六色盤同色相加深、對比 ≥4.5:1）**只給文字/標籤/提醒邊框**。
   - **填色條一律用 CHART 亮版**，不可拿深色 token 當填色（使用者抓過違規）。
5. **金額格式**（app.js 統一格式器，不要自己 toLocaleString）：
   - 統計卡片大數字 → `wan()`（萬）；表格/明細 → `money()`（元整數）/`moneyCur()`（原幣）。**例外：訂閱追蹤頁（含內嵌歷史紀錄）全部用 `money()` 元**——訂閱金額為千元級，用萬會變「0.1 萬」不可讀（使用者拍板 D7）
   - 負號一律 U+2212「−」；投資組合頁走 `MONEY()` 雙計價（localStorage `pf_viewCur`，NT=萬 / US=K USD）
6. **UI 慣例**：卡片數字 `.stat sm`、表格數字欄 `.num`（右對齊 tabular）、空狀態 `.empty` 文案「尚無…」、頁首動作 `.page-actions`、卡片牆 `.grid.card-grid`＋`.detail-grid`、彈窗用 `openForm`/`openInfo`＋`modal-sm/md/lg/xl`、名詞說明用 `.info-link`（無底線，hover 珊瑚色）＋`openInfo`。

## 投資領域語意（改相關程式前必讀）

- **投資原則（使用者拍板）**：最高指導原則＝**生存優先**（在所有環境活著 > 多數環境賺更多），規則衝突時以此裁決。所有上限口徑＝**% 淨資產**（非投組市值）；區域曝險**穿透**計算（COMPOSITION 拆 ETF 成分）；**軟上限**＝超標僅「凍結加碼」提醒，**不強制賣**。上限存 settings：`ibConcentrationPct`(單一個股5)/`equityCapPct`(90)/`countryCapPct`(15)/`chinaCapPct`(15)/`levCapPct`(1.3)，設定頁「投資原則」卡可調。
- **融資槓桿只算 IB**：**優先用 IB 官方淨值摘要 `settings.ib.lastEquity`**（同步時更新、基準幣別 USD：stock ÷ (stock+cash)）；沒有同步資料才自算（`source:'ib'` 持倉 ÷ 淨值、融資＝`ibCashCur` 負餘額）。排除台新現金與台股，文案標「IB」前綴。`ibIdleCashAlert`＝IB 正現金閒置提醒門檻（USD）。
- **槓桿上限任何時期 1.3x**（2026-07-10 修訂，取消訊號期 1.6x——1.6x 撐不過 2008 級回檔）：估值訊號期加碼**只用新資金與現金、不舉新債**。**斷頭距離**＝市場再跌 x% 觸及 IB 強平線，`x = 1 − 借款 ÷ ((1−維持率) × IB 持倉市值)`（假設全倉維持率一致的近似）；維持率存 `settings.ibMaintenancePct`(25)。公式在 `portfolio.js marginCallDistance()` 與 `lib/derive.js` 規則 7 各一份（同步點）。
- **多幣別損益**：換算優先序＝IBKR `pnlBase` → `fxRateToBase` → USD 直通 → 設定匯率估算（需標註）→ 缺匯率不計入（需標註）。不可把非 USD 金額默默當 USD 加總。**交易損益**（交易摘要＋XIRR）共用 `portfolio.js tradePnlBase()`，兩處口徑必須一致（否則 XIRR 漏估外幣賣出、年化偏低）。**現金流**（IB 股息/利息）在 `lib/ib.js parseStatement()` 解析時就套同一優先序（`server.js` 依 settings 傳入估算器 `fxToBase`），估算/略過筆數存 `income.estimatedNoFx`/`skippedNoFx`＋幣別，前端與 PDF 都要註記。
- **XIRR（資金加權年化，台幣）**：現金流＝第一筆月快照市值（流出）＋各月快照投入增量（流出）＋IB 賣出已實現損益逐筆按成交日（`tradePnlBase`×usdTwd，流入，與交易摘要同口徑、含設定匯率估算）＋今日市值（流入）。**賣出只用 Δcost 會漏掉已實現損益，必須用 ibTrades 修正**；用估算時 header 標「含匯率估算」。不含股息利息；台股手動賣出未納入；快照未滿 60 天不顯示；|年化|>500% 視為資料異常。實作在 `portfolio.js portfolioXirr()/xirrRate()`（僅此一份）。快照資料曾含 seed 示範殘留（2026-07-10 已清），**判斷 XIRR 異常先懷疑快照資料**。
- 台股（0050/006208/00719B/00720B）無 API、手動維護股數；報價 Yahoo（台債後綴 `.TWO`；GBp 便士 ÷100 轉 GBP）。

## ⚠️ 同步點清單（改一處必須檢查另一處）

| 改這裡 | 記得同步這裡 |
|---|---|
| `public/modules/portfolio.js` 的 `COMPOSITION` 穿透表 | `lib/derive.js` 的同名複本 |
| `portfolio.js` `fxSection.exposureCurrency` 寫死的台幣掛牌美債 ETF 清單（00719B/00720B） | 新增同類 ETF 時要補進清單 |
| 新增 ETF 持股 | `portfolio.js` `COMPANY_WEIGHTS`（前十大成分近似權重，持股公司 Top 20 用）＋`COMPOSITION` 區域表（兩檔案）。**例外（刻意）**：XUSE/EXUS 只做區域穿透、不列 COMPANY_WEIGHTS（成分極分散，前十大各僅 1–2%） |
| `server.js` `DEFAULT_LAYER` 新增代號 | 兩份 `COMPOSITION` 也要有該代號（否則 IB 同步新增後區域穿透 fallback 成「其他」，國家上限提醒會偏掉） |
| IB 槓桿＋斷頭距離公式（lastEquity 優先、自算 fallback） | 後端單一真相＝`lib/derive.js computeLeverage()`（規則 7＋buildSummary 都用它、summary 有 `ib.leverage/loan/mcDist/hasLoan`）↔ 前端 `portfolio.js` 的 `marginCallDistance()` 與 render 內槓桿計算，前後端兩份要一致 |
| 訂閱本月攤提（停用當月月繳不計、季/年繳按天數比例） | `subscriptions.js costForMonth()` ↔ `lib/derive.js subCostForMonth()`（buildSummary「本月固定訂閱」用它），兩份口徑要一致 |
| 訂閱狀態（使用中/即將停用/已停用） | 前端 `subscriptions.js subStatus()` ↔ 後端 `lib/derive.js subActive()`（buildSummary 訂閱**項數**用它，只算未停用；否則總覽與訂閱頁項數打架）。判斷靠 `daysUntil(endsOn)`，兩份口徑要一致 |
| YYYY-MM-DD 日期解析 | 前端 `app.js parseLocalDate` ↔ 後端 `derive.js parseLocalDate`（各一份）：一律用**本地時區**拆日期，`new Date('YYYY-MM-DD')` 會被當 UTC，在 UTC 以西時區差一天（月份/提醒天數/星期全錯）。`daysUntil`/`monthKey`/`formatDateWithWeekday` 都走它 |
| `theme.js` 的 CHART.green/red | `styles.css` `.cb-ok/.cb-over` 寫死同色 hex（CSS 無法 import JS） |
| settings 新增欄位 | `lib/store.js emptyDb()` 預設值＋`data/seed.json`＋設定頁 UI |
| 估值訊號門檻（`portfolio.js` `regionTier`/`taiwanTier`/`US_RATIO`） | 投資原則規則書（memory）＋標題說明彈窗 `SIGNALS_INFO_HTML`，三處門檻要一致 |
| `settings.signals`（美股自動、區域四市場每月手動） | 只在投組頁「更新區域數值」表單編輯；美股 ECY＝`/api/cape`＋`/api/realyield`（FRED DFII10）自動算，不手動 |
| 支出分類（兩層：分類/子類） | **單一真相＝`public/modules/categories.js` 的 `EXPENSE_TREE`**（前端 import `./categories.js`、後端 `lib/statement.js`+`server.js` import `../public/modules/categories.js` 共用同一份）。`statement.js CATEGORY_RULES` 的 `[分類,子類]` 字串、`server.js CATEGORY_MIGRATION` 的目標分類，都必須對得上 EXPENSE_TREE。交易存 `category`(分類)+`subcategory`(子類)；收入類走 `INCOME_CATEGORIES`、無子類。未知支出預設 `DEFAULT_EXPENSE`（其他/未分類——與「生活/其他生活雜支」區隔：後者是已知生活雜項，前者是還沒判斷出來的） |
| `lib/statement.js` `CATEGORY_RULES` 關鍵字順序 | 特殊指定要排在通用前：YouTube→學習、ChatGPT/Claude/Notion/Canva→工作、汽車保險→交通（在保險前）、健身→健康、**地價稅→居住（排在生活/行政規費前）**、**TAPPAY/台灣國際開發→交通/停車費（第三方支付、使用者的多為停車）**、外送前綴（FP-/foodpanda）放飲食各子類之後當保底。重複判定鍵＝`stmtRef`（卡id+消費日+金額+說明） |
| 帳單多銀行/多格式（`parseStatement` 依位元組偵測 PDF/XLSX；PDF 再依**文件內容**判富邦/台新） | **PDF 銀行由文件內容判斷，不看使用者選的卡片**（`parsePdfAuto`：用「台新/富邦」行名關鍵字定方向，命中的解析器有結果就採用、否則挑筆數多者；卡片只決定記到哪＋提供 PDF 密碼）。**富邦＝PDF**（`parseFubon`：郵寄加密版說明同列、官網無密碼版說明換行下一列）；**台新＝PDF**（`parseTaishinPdf`：郵寄加密版，說明有時拆三行、支援斜線 115/06/02 與 7 碼 1150602 兩種民國日期、金額＝兩日期後第一個純整數）＋**XLSX**（`parseTaishinXlsx`＋SheetJS，官網下載，西元日期、金額獨立欄）。台新 PDF 已用同月 XLSX 交叉驗證（3月94/94、7月66/66，日期+金額零誤差）。各解析器回原始明細後共走 `finalize()`（分類＋國外交易服務費繼承＋`cleanStore()` 產生顯示用店名 `store`）。`parseStatement` 另回 `lastFour`（`extractLastFour` 從內容抓卡號末四碼，盡力而為、抓不到回 null）。**`store`＝清理過的顯示名，匯入後存進 `note` 顯示用；分類與 `stmtRef`（去重）一律用原始 `desc`，勿改用 `store`（否則分類失準、跨格式去重對不上）。`cleanStore` 流程：①先比對 `STORE_CANON` 已知品牌標準名（eTag停車/foodpanda/馬可先生/六必居/OMGYES/悠遊卡自動加值…，命中直接顯示標準名，使用者可續加）②否則走一般規則：去金流前綴（`連加*`/`騰加數位*`/`OPENAI*`/`TAPPAY_`/`FP-`）、截斷括號後段（`石二鍋(林口家樂`→`石二鍋`）、`、`後段、公司型態字（股份有限公司/有限公司…）、結尾 `/TW`、分店定位碼＋城市、設備碼、中文後殘留英文（`摩斯漢堡Mos B`→`摩斯漢堡`）。台新 PDF/XLSX 都常截斷店名（`LOUISA COFFE`/`台灣國際開`），救不回被截字（盡力而為）。無公開店名對照表可匯入。**新增銀行＝加 `parseXxx()` 並補進 `parsePdfAuto`。`parseStatementPdf` 為 `parseStatement` 別名（相容） |
| 帳單上傳「免選卡」自動歸卡（`POST /api/statement/preview`） | 上傳只丟檔案、不先選卡。後端逐一試各卡 `pdfPassword` 解密（`['', ...各卡去重密碼]`，只在密碼類錯誤才換下一個）→ 判銀行＋末四碼 → **對卡決策樹**：①末四碼唯一命中→自動；②該銀行單卡→自動；③否則回 `candidates`（該銀行優先、無則全部信用卡）請使用者選。`issuerMatchesBank`＝`card.issuer` 含 bank 字串。認不出時前端用 `POST /api/cards/:id/statement/preview`（指定卡）重解析。**卡片對應靠 `card.lastFour`**——末四碼抓取樣式（`extractLastFour`）真實帳單校準後再補；抓不到/對不準一律退回請使用者選（＝保底、不會卡住）。預覽頂部可改「記到卡片」（改了用該卡重解析＝重算重複標記）。**同步點：改 `stmtDupFlag` 的 stmtRef 格式要連動 reassign 前綴重寫。** **坑（已修 PR #30）：pdfjs `getDocument` 會 detach 傳入的 ArrayBuffer，試密碼迴圈重用同一份 bytes 第 2 次起會爆「Cannot transfer object of unsupported type」→ `extractLines` 一律傳 `new Uint8Array(data)` 副本，勿改回直接傳 data。** |
| 帳單匯入批次／事後整批改卡片 | 匯入時每筆蓋 `importBatch`(批次代號)＋`importedAt`；`GET /api/statement/batches` 依批次聚合、`POST /api/statement/reassign` 整批改卡＝**重寫 `stmtRef` 的卡片前綴**（`卡id\|消費日\|金額\|說明`，split 第一個 `\|`）＋改 `account`，目標卡已有同筆則去重丟棄。**改動 `stmtRef` 格式時 reassign 的前綴重寫要一起改**。`POST /api/statement/batch/delete`＝整批砍掉（解析/分類不對時重匯用）。前端入口：匯入完成彈窗「改到其他卡片」＋收支頁「帳單批次」鈕（有 `importBatch` 的批次才顯示，內含「改卡片」與「刪除整批」）。匯入後前端自動跳到「筆數最多的月份」（信用卡帳單主體常在前一個月，避免停在幾乎空的最新月）。**台新 PDF 說明在相鄰非交易列時「只取上一行」，不可連下一行（會黏到下一筆說明）** |
| 帳單分類「自動學習」（`db.learnedCategories`＝{ 店名(cleanStore後/=note) → {category,subcategory} }） | 匯入預覽先過 `applyLearned`（依 `store` 覆蓋分類，**優先於內建 `CATEGORY_RULES`**）。學習時機：①匯入時使用者選的分類與 `categorize(原始desc)` **不同才記**（避免整表爆）②`PUT /api/transactions/:id` 且 `source==='stmt'` 改分類時記（**手動記帳不學、避免污染**）。key 一律＝cleanStore 後的店名（apply 用 `t.store`、學習用 `note`，兩者相同）。`GET /api/learned`＋`POST /api/learned/delete`{key}；設定頁「帳單分類學習」卡可檢視/刪除。新 db 欄＝`learnedCategories`{}（已進 `emptyDb`＋`seed.json`）。使用者拍板：**自動記住、只學分類**（不學店名） |

## 協作流程

- **Claude 與 Codex 都直接在本機這個資料夾工作**（Codex 為本機 CLI，非雲端）——改動只存在工作目錄，`git commit` 才進歷史、`git push` 才上 GitHub。
- **換手儀式**：換另一個 AI 動工之前，先把目前的改動 commit（可由完工方自行 commit，或交 Claude 審查後 commit 並以 Co-Authored-By 標明出處）。同一時間**只有一個 agent** 改本機工作樹；真要平行用 `git worktree`。
- `main` 永遠保持可用；**一任務＝一分支＝一 PR**，PR 描述寫清楚改了什麼/為什麼/怎麼驗證。
- **堆疊 PR（base 指向另一個 PR 分支）合併時，不要用 `--delete-branch`**——刪掉基底分支會讓上層 PR 被 GitHub 直接關閉而非自動轉指向（2026-07-10 實際發生，#3/#5 被誤關）。先由下而上全部合併完，再一次刪分支；或乾脆避免堆疊、等前一個合併後再開下一個。
- 使用者是最終合併者。Commit 訊息用繁體中文、講清楚動機。
- 驗證要求：改前端 → 8 個頁面 reload 無 console error；改後端 → `node --check server.js` ＋ 以 seed 資料跑 `buildSummary()` 不拋錯；UI 變動附驗證說明。

### 審查分工：Codex 審、Claude 改（2026-07-10 使用者拍板）

三個角色各司其職，職責不重疊：

- **Codex＝審查者（唯讀）**：定期對 `main` 做程式檢視（找 bug、死碼、重複、可簡化處），**只提意見、不改檔、不 commit**。提意見前**先自己驗證能重現／指出確切 `檔案:行`**，不要丟未驗證的猜測。**觸發時機＝每批 PR 合併進 `main` 之後對 `main` 審一輪**（審穩定狀態，不審改到一半的分支）；使用者也可隨時手動要求。**標準審查指令存於 repo 根目錄 `CODEX-REVIEW.md`**——使用者對 Codex 說「請讀 CODEX-REVIEW.md 並照它執行審查」即可。
- **使用者＝守門者**：決定「要不要做、先做哪個」。把 Codex 的審查**原文**交給 Claude（貼上或寫成檔案），**不要口頭轉述技術細節**（避免細節在中間走樣）。
- **Claude＝判斷＋實作者**：讀 Codex 原文後，**先拿每一條意見對本檔的投資語意與同步點清單把關**再動手。凡與「刻意設計」衝突的建議（例：Codex 常會說「COMPOSITION 兩份表重複，合併吧」，但那是前端無法 import 後端的**刻意同步點**），**擋下並向使用者說明為什麼不做**，不要盲目照修。判定該做的才走「一任務＝一分支＝一 PR」流程。
- Claude 的實作在下一輪 Codex 審查時才被覆蓋審到（有時間差）；money 相關的高風險改動，可在合併前明確請 Codex 先過一次。

## 已知待辦（背景脈絡）

- ✅ 估值訊號儀表（五市場檔位 → 動態股債比）已實作（PR #7）。
- ✅ XIRR 資金加權年化報酬已實作（PR #9，投組頁「投入 vs 市值」卡）。
- ⏳ 個股基本面分析方法待建立（AAPL/GOOGL 等）——下一項，先設計「研究一檔個股要回答哪些問題、看哪些指標」的框架，再決定 app 內怎麼承接（已有個股研究卡的論點/風險/檢查點欄位可用）。
