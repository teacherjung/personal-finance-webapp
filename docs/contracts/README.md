# 領域契約路由表：改哪些檔，要讀哪份契約

> `docs/contracts/` 是 AGENTS.md「同步點清單」的**領域拆分**（D4 系列，2026-07-31 起）：
> 拆出的領域在 AGENTS 只留**一行索引＋連結**，完整同步點內文（逐字）在各契約檔。
> **規則：開工前對照下表與下方各領域小節——你要改的檔案落在哪個領域，就必讀那份契約**；AGENTS 的同步點清單仍是總索引。
> 尚未拆出的領域（標「仍在 AGENTS」）照舊直接讀 AGENTS 同步點清單。
>
> **兩條硬規則（Codex D4a-r1 抓的防護力缺口）**：
> ①**已拆領域的檔案清單＝該契約的「宣告責任集合」——是下限，不是窮舉**（契約改變當支 PR 同步更新）——不是「這個領域的典型檔案」。訂閱的月底錨點規則管到 `lib/routes/crud.js`、洞察書籤管到 `lib/types.js`，光看「前端」二字想不到。
> ②**同一檔案可以落在多個領域——每一個命中的契約都要讀**（`lib/derive.js`、`lib/schema.js` 這類共用底層必然多重命中；只讀一份＝漏規則）。

| 領域 | 範圍 | 契約檔 |
|---|---|---|
| 前端功能 | 訂閱／月度回顧卡／洞察書籤／日期解析 | [frontend-features.md](frontend-features.md) |
| 收支記帳與匯入 | 帳單解析／分類／店名規則／學習／退款配對 | [income-expense.md](income-expense.md) |
| 投資與 SEC | 基本面／佇列護欄／曝險穿透／槓桿／代號原則／估值訊號 | [investment-sec.md](investment-sec.md) |
| 資料與儲存 | 所有資料只走櫃檯一個窗口、入庫過安檢門（欄位／日期／必填驗證）、兩顆引擎（本機 SQLite／雲端 Postgres）同步、每日滾動備份（⚠️ **使用者觸發的**「操作前備份」那一層已於 2026-08-08 裁決整層移除，不得偷偷加回） | [data-storage.md](data-storage.md) |
| 雲端與安全 | 開餐廳給別人用才需要的整套——雙模式開關與帳號登入、機密的 HOSTED 落庫加密、回應投影與分模式匯出、超大檔案不准吃垮伺服器、限流、租戶包廂隔離、部署單一真相 | [cloud-security.md](cloud-security.md) |

拆分紀律（每個領域一支 PR）：**先複製後換連結、內文逐字（轉換僅限表格解框，或當支 PR 逐條宣告、無語意變更的必要轉寫）、對照表寫進 PR**；契約檔的變更視同 AGENTS 同步點變更＝技術契約改變的**當支 PR** 同步更新。

## 各領域的責任檔案（一行一檔、依路徑排序）

> 上表第二欄原本把整個領域的責任檔案塞在**同一格**（一列幾百個路徑）；2026-09-03 起搬到這裡，**每個領域一個小節、一行一檔、依路徑排序**（比較方式＝JavaScript 預設 `sort()` 的字串順序；`test/contract-split.test.js` 強制每個小節與 MANIFEST 的 `files` 都排好序、不重複）。理由：兩支 PR 各自往同一領域加檔案時，改動落在**不同行**、git 通常能自動合併，不再因為擠在同一行而衝突→被迫 rebase→head 變→複審結論閘失效、重拿一張「通過」。⚠️ **已知邊界**：兩支加的檔案依路徑排序後**剛好相鄰**時，README 與 MANIFEST 仍會衝突（git 看的是相鄰行的 hunk）——一行一檔降低的是撞行的**機率**，不是保證。
> **清單＝宣告的責任集合（下限）**，與拆分護欄考題的 MANIFEST 精確相等（這句原本每列各抄一次，現在只寫這一次）。每行括號裡的說明照原表格**逐字**搬；原表格裡冠在一批檔案前面的粗體小標（籃C 補搬點名檔、#409 補宣告……）改成掛在該批每一檔後面的〔標籤〕——排序打散了批次，標籤讓「它原本屬於哪一批」仍看得出來。不屬於任何單一檔案的句子逐字收在各小節的「備註」。

### 前端功能

契約：[frontend-features.md](frontend-features.md)

- `data/seed.json`（dailyValues 欄位連動）
- `lib/derive.js`（攤提 `subCostForMonth`／`subActive`／提醒 key／`parseLocalDate`——**與收支、投資多重命中**）
- `lib/repo.js`（`getDb`／`saveDb`）
- `lib/routes/core.js`（刻意不改的入口約定）
- `lib/routes/crud.js`（subscriptions beforeSave／`chargeAnchorDay`）
- `lib/routes/market.js`（`/api/insights`）
- `lib/schema.js`（`insightState` 註冊件）
- `lib/services/insights.js`（每日維護入口）
- `lib/services/market-data.js`（`getCape`／`getRealYield`）
- `lib/services/snapshot.js`（每日維護入口）
- `lib/services/subscriptions.js`（每日維護入口）
- `lib/store.js`（`insightState` 註冊件）
- `lib/types.js`（`insightState` 註冊件）
- `public/app.js`（重繪／`parseLocalDate`）
- `public/modules/assets.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/backup-export.js`（匯出「先驗再存」與提示文案——#417）
- `public/modules/cards.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/cashflow.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/dashboard.js`（重繪／`parseLocalDate`）
- `public/modules/form-options.js`（`openForm` 的 select 選項唯一實作——現在的值不在選項清單裡時保留它、不被瀏覽器靜靜換成第一項；**與收支多重命中**：收支的分類／子類下拉也走它）〔#409 補宣告（彈窗下拉的通用保留機制）〕
- `public/modules/goal-tracking.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/history.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/html-escape.js`（`esc` 的實作本體，`app.js` 原樣 re-export；鐵則 3 的承重點）〔#409 補宣告（彈窗下拉的通用保留機制）〕
- `public/modules/insurance.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/modal-ownership.js`（#modal-root 世代擁有權純邏輯——r6）〔籃C 補搬點名檔〕
- `public/modules/modal-shell.js`（共用彈窗邊界）〔籃C 補搬點名檔〕
- `public/modules/monthly-review-card.js`（重繪／`parseLocalDate`）
- `public/modules/portfolio.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/securities.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/settings-store-rules.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/settings.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/subscriptions-model.js`（重繪／`parseLocalDate`）
- `public/modules/subscriptions.js`（重繪／`parseLocalDate`）
- `public/modules/toast-timing.js`（提示停留時間照字數給——#417）
- `public/modules/transactions-import.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `public/modules/transactions.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `test/ai-consent.test.js`（`openInfo({actionsHtml})` 的固定動作列考題——**與收支、雲端多重命中**）〔籃C 補搬點名檔〕
- `test/daily-values.test.js`
- `test/goal-tracking-ui.test.js`（頁面模組＝**與各自領域多重命中**）〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `test/goal-tracking.test.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `test/modal-ownership.test.js`（世代行為＋接線形狀考題）〔籃C 補搬點名檔〕
- `test/server.test.js`（契約點名的考題——**弱化考題也要先讀契約**）
- `test/snapshot-safety.test.js`〔籃C 補搬點名檔〕〔async guard 管的九個頁面模組＋彈窗呼叫端＋淨值目標／時鐘倒退承重〕
- `test/subscriptions-model.test.js`（契約點名的考題——**弱化考題也要先讀契約**）

### 收支記帳與匯入

契約：[income-expense.md](income-expense.md)

- `data/seed.json`
- `lib/ai-budget.js`（成本護欄 C1：發數上限與每日計數的純模組）
- `lib/ai-confirm-ticket.js`（AI 預覽確認票＝「使用者確認的＝寫入的」；記憶體、一次性、短效）〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `lib/ai-parse-card.js`（批二＝信用卡 AI 的答案卷／提示詞／fail-closed 驗收／接地／驗算閘——等式閘＋逐筆加總閘、具名調整 `adjustments`）〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `lib/ai-parse.js`（純模組＝答案卷 schema／提示詞／fail-closed 驗收／文字組裝，零外連）〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `lib/ai-transport.js`（**唯一**打 AI 供應商的檔：傳輸＋真引擎工廠；入外連登記閘 hosted-auth ALLOWED＋server.js OUTBOUND_ENDPOINTS）〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `lib/bank-alias.js`（Stage 4：機構名正規化——身分尺只認台新、去重鍵／定存鍵的祖父比對形、疑似重複的寬鬆尺）
- `lib/bank-statement.js`
- `lib/card-identity.js`（信用卡帳單的機構身分判準：證據只取「**第一筆交易列之前**」的表頭列、逐列比對、樣式錨定在列開頭＋否證器＋輸出不變量）
- `lib/derive.js`（`pairRefunds`／`consumptionByMonth`——**與前端、投資多重命中**）
- `lib/parse-recipe-card.js`（批四＝信用卡規則卡純模組：嚴格驗證／文字流＋錨點引擎／出生把關——與銀行同櫃、`kind:'card'` 標籤分流）〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `lib/parse-recipe.js`（P2-1 配方純模組：驗證器/引擎/出生驗收）
- `lib/pdf-isolate.js`（HOSTED 讀 xlsx 走子行程）
- `lib/progress-stages.js`（上傳進度：封閉階段代碼、零插值）
- `lib/recipe-birth.js`（規則卡出生統計：封閉代碼、只記結果不記內容）
- `lib/repo.js`（`loadSynced()`＝規則入櫃檯，漏一處就有路徑拿到過期規則）
- `lib/routes/core.js`（`/api/refund-pairs`／`/api/monthly-review`／`/api/categories`）
- `lib/routes/crud.js`（`applyAll` 原子入口／`onAccountSave`）
- `lib/routes/route-helpers.js`（錯誤 `code` 通道）〔P0.5 匯入密碼池（2026-08-11）〕
- `lib/routes/statement.js`（帳單與店名規則端點）
- `lib/schema.js`（`refundOf`／`dir` 進 `FIELD_SCHEMA` 但**不**進 `WRITABLE_FIELDS`）
- `lib/secret-fields.js`（projectAccount 機密投影——**與雲端領域多重命中**）〔籃C 補搬點名檔〕
- `lib/services/bank-import.js`（`applyLearnedBankToDb`／`reconcileBankTxAccountNames`／`txDirection`）
- `lib/services/categories.js`（`effectiveTree`）
- `lib/services/health-check.js`
- `lib/services/ib-sync.js`
- `lib/services/learning.js`
- `lib/services/statement-import.js`
- `lib/services/store-rules.js`
- `lib/statement-password-policy.js`（池上限常數，讀寫端共用）〔P0.5 匯入密碼池（2026-08-11）〕
- `lib/statement-reconcile.js`（強／中／弱三級對帳閘純函式）〔P0 匯入對帳閘（2026-08-11）〕
- `lib/statement.js`（解析＋`CATEGORY_RULES`＋`isCardPayment`＋`applyDisplayLabels`＋`AGGREGATE_STORE_KEYS`）
- `lib/store-rules.js`（使用者規則的形狀／驗證／編譯）
- `lib/store.js`（`emptyDb`／`save`——**多領域命中**）
- `lib/taishin-securities.js`
- `lib/types.js`〔籃C 補搬點名檔〕〔帳號 UI／型別／直接考題〕
- `public/app.js`（`normalize-auto`）
- `public/modules/accounts-model.js`（帳戶型別選項與負債判準的前端單一真相——**與投資多重命中**：`portfolio-exposure.js` 的 `fxExposure` 讀同一份 `LIABILITY_TYPES`）〔籃C 補搬點名檔〕〔帳號 UI／型別／直接考題〕
- `public/modules/ai-consent.js`（AI 入口判準＋同意窗/徽章/錯誤碼文案的家）〔P1b-2 前端（2026-08-12）〕
- `public/modules/ai-key-settings.js`（設定頁鑰匙欄判準＋就地解釋文案）〔P1b-2 前端（2026-08-12）〕
- `public/modules/assets.js`〔籃C 補搬點名檔〕〔帳號 UI／型別／直接考題〕
- `public/modules/card-issuers.js`（發卡行可選清單＝卡片表單與 `cardIssuerBank` 共用同一份機構清單：**機構代號**／正式名稱／別名／對應的內建範本，歧義由資料算出來；代號＝持久資料，永不改名）
- `public/modules/card-last-four.js`（卡側末四碼安全字串化＝前後端共用單一實作：`{toString:null}` 炸彈值炸不出＝''、壞型別攤平照字串化答案——hit 比對與顯示欄共用）
- `public/modules/cards.js`（發卡行下拉＋「其他（自行輸入）」的接線與就地解釋文案——**與前端、雲端多重命中**：這裡的 round-trip 決定既有 `card.issuer` 會不會被靜靜改掉，那是自動歸卡的輸入）
- `public/modules/cashflow-model.js`（密碼窗文案單一住所——**與雲端領域多重命中**）〔P0.5 匯入密碼池（2026-08-11）〕
- `public/modules/cashflow.js`（銀行收支 `applyAll` 與方向略過 toast）
- `public/modules/categories.js`
- `public/modules/form-options.js`（收支的分類／子類下拉「保留清單外的現值」的唯一實作——分類事後被刪掉、或匯入資料帶著舊分類時，這一層決定那筆錢會不會被靜靜改成別的分類；**與前端多重命中**）〔#409 補宣告〕
- `public/modules/ndjson-stream.js`（串流協議解讀：半行/壞行/終端 frame/斷線，純模組可直測）
- `public/modules/parse-recipes-ui.js`（規則卡刪除流程的行為核心：confirm 語意／API 恰一次）
- `public/modules/progress-text.js`（進度句白話文案）
- `public/modules/recipe-birth-text.js`（出生結果白話文案）
- `public/modules/reconcile-summary.js`（預覽窗對帳說明——兩頁共用的白話翻譯純函式）〔P0 匯入對帳閘（2026-08-11）〕
- `public/modules/refund-attribution.js`
- `public/modules/settings-store-rules.js`（`openStoreRulesEditor`／規則影響預覽）
- `public/modules/settings.js`
- `public/modules/transactions-import.js`（免選卡預覽／批次列表／改卡）
- `public/modules/transactions.js`
- `test/ai-account-mask.test.js`（放寬帳號遮罩判準：AI 照原樣抄、X／圓點／全形星由程式改寫成半形星、沒遮就不動；去重鍵與帳戶比對的下游）〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `test/ai-budget.test.js`（護欄專卷：擋點順序／序列化／票匣續數／白名單）
- `test/ai-card-pipeline.test.js`〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `test/ai-consent.test.js`〔P1b-2 前端（2026-08-12）〕
- `test/ai-dual-read.test.js`
- `test/ai-gate-interception.test.js`（P1b-3 攔截率：故障注入量閘的條件攔截率，與計畫 §八 互扣）〔疑似重複提醒（2026-08-12）〕
- `test/ai-key-settings.test.js`〔P1b-2 前端（2026-08-12）〕
- `test/ai-parse-card.test.js`〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `test/ai-parse.test.js`（假引擎考題：四道規矩／模型階梯／端到端／票制／線上格式）〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `test/ai-pipeline-interception.test.js`（P1b-3 續集：同 23 型打全管線＝接地＋合計＋閘，與 §八「全管線重測」小節互扣）〔疑似重複提醒（2026-08-12）〕
- `test/ai-time-deposit.test.js`（AI 路線的定存欄：三條界線）
- `test/bank-accounts-asof-ui.test.js`
- `test/bank-alias.test.js`（Stage 4：機構名正規化——身分尺只認台新、去重鍵／定存鍵的祖父比對形、疑似重複的寬鬆尺）
- `test/bank-preview-layout.test.js`
- `test/bank-raw-text.test.js`（Stage 2：帳單原文摘要／備註兩欄留底）
- `test/bank-statement.test.js`（合成座標列）
- `test/card-identity.test.js`（機構身分判準專卷：證據來源／否證器／不變量／端到端分流）
- `test/card-issuers.test.js`（清單紀律／代號紀律（精確集合）／判準／表單行為／升級提示／接線／突變）
- `test/card-last-four.test.js`（helper／後綴 builder 行為題＋行級接線掃描）
- `test/cashflow-bank-upload.test.js`（跨版式疑似重複的預覽文案與接線——**與雲端多重命中**）〔疑似重複提醒（2026-08-12）〕
- `test/cd-split.test.js`（定存分開列管：解析 kind/period／cdKey 建戶與精確更新／到期不動／matchAccount 護欄／預覽＝套用／對帳閘跳過定存列）〔疑似重複提醒（2026-08-12）〕
- `test/codex-r10.test.js`（types/server 類＝**多重命中**）〔籃C 補搬點名檔〕〔帳號 UI／型別／直接考題〕
- `test/debit-card-ledger-http.test.js`（Stage 5b：單筆 DELETE 守門）
- `test/debit-card-ledger.test.js`（Stage 5b：簽帳金融卡明細一份帳單兩種明細）
- `test/helpers/build-pdf.js`（手工造最小合法 PDF，含中文 Type0/Identity-H——**「PDF 合成不了」那句劃界已被推翻**）
- `test/ib-cash-freshness.test.js`
- `test/ledger-split-behavior.test.js`（兩頁分堆的行為考題：銀行收支只吃現金流帳本、信用卡費只吃信用卡帳本）〔疑似重複提醒（2026-08-12）〕
- `test/multi-currency-account.test.js`（外幣綜合帳戶＝同號多幣別：三條解析路的歧義哨兵與成員判準）
- `test/note-naming.test.js`
- `test/parse-recipe-card.test.js`〔P1b-1 AI 解析引擎（2026-08-12，★3 拍板＝Anthropic）〕
- `test/parse-recipe-store.test.js`
- `test/parse-recipe.test.js`
- `test/parse-recipes-http.test.js`（規則卡管理端點的真 HTTP 封閉投影與刪除）
- `test/recipe-birth.test.js`（封閉鍵／不膨脹／文案互扣／機密）
- `test/recipe-gen.test.js`
- `test/reconcile-summary.test.js`（句意／跳脫／接線形狀考題）〔P0 匯入對帳閘（2026-08-11）〕
- `test/refund-attribution.test.js`
- `test/refund-pairing-aggregate.test.js`
- `test/reminder-thresholds.test.js`（回饋＝負數列第三格：安全網刻意仍抵減回饋的保存型考題）
- `test/server.test.js`〔籃C 補搬點名檔〕〔帳號 UI／型別／直接考題〕
- `test/skip-similar-import.test.js`
- `test/statement-password-pool.test.js`（池順序／迴圈分類／記住清除／銀行兩入口端到端）〔P0.5 匯入密碼池（2026-08-11）〕
- `test/statement-pipeline.test.js`
- `test/statement-reconcile.test.js`（純函式＋接縫＋端到端擋下考題）〔P0 匯入對帳閘（2026-08-11）〕
- `test/statement.test.js`〔籃C 補搬點名檔〕〔帳號 UI／型別／直接考題〕
- `test/store-rules.test.js`
- `test/taishin-debit-card.test.js`（Stage 5a：A 區刷卡消費明細讀出＋對到 D 區）
- `test/taishin-debit.test.js`（第二個內建範本＝簽帳金融卡明細）
- `test/upload-progress.test.js`（進度串流的機密/誠實/序列三鐵則與 NDJSON 契約）

### 投資與 SEC

契約：[investment-sec.md](investment-sec.md)

- `lib/derive.js`（computeLeverage／COMPOSITION 複本——**與前端、收支多重命中**）
- `lib/heavy-admission.js`（HTTP 入場管制＝佇列外面那一層）
- `lib/http-body.js`（重型端點全集＋解析上限）
- `lib/ib.js`（IB Flex 解析——現金幣別歸零／缺幣別旗標）
- `lib/parse-limits.js`（SEC 單一回應上限）
- `lib/pdf-isolate-child.js`（子行程本體）
- `lib/routes/auth.js`（`authGate`——名額要在它之後才拿）
- `lib/routes/core.js`（估值訊號 `settings.signals` 的讀寫端點）
- `lib/routes/market.js`（`/api/cape`／`/api/realyield`）
- `lib/routes/securities.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `lib/schema.js`（`sanitizeDbForWrite`——**多領域命中**）
- `lib/secret-fields.js`（`projectSecurityTrade` 機密投影——**與收支、雲端多重命中**）〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `lib/services/ib-sync.js`
- `lib/services/insights.js`（估值跳檔）
- `lib/services/market-data.js`（CAPE／實質殖利率取數）
- `lib/services/securities-import.js`（台新證券匯入）〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `lib/services/security-trades.js`（`reconcileFingerprintRows` 指紋對帳）〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `lib/services/stock-fundamentals.js`（SEC 服務／佇列護欄）
- `lib/stock-fundamentals.js`（SEC 純解析器）
- `lib/store.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `lib/taishin-securities.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `lib/types.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `public/app.js`（`router()` query 路由與開機序列——**與前端、收支多重命中**）〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/accounts-model.js`（`portfolio-exposure.js` 的 `fxExposure` 讀它的 `LIABILITY_TYPES` 把負債帳戶翻成負的現金曝險——收支那一列早就明寫「與投資多重命中」，硬規則②要求投資這一列也要點名它，否則只讀投資契約的人不會被導過去）〔#409 補宣告〕
- `public/modules/categories.js`（僅作為「後端 import public/modules」前例被點名）
- `public/modules/fx-rates.js`
- `public/modules/portfolio-activity.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-calculations.js`
- `public/modules/portfolio-chart.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-details.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-editors.js`（凍結標的的編輯入口）
- `public/modules/portfolio-exposure.js`（門檻單一真相）
- `public/modules/portfolio-format.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-forms.js`（**表單提交判準：股數沒增加、但身分改成凍結標的仍要警告**——Codex #384 r25 抓到它原本不在清單裡）（門檻單一真相）
- `public/modules/portfolio-ib-sync.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-info-actions.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-info.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-model.js`（門檻單一真相）
- `public/modules/portfolio-overview.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-quotes.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-remote-actions.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-report.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-research-actions.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-research.js`（研究卡（代號身分））
- `public/modules/portfolio-risk.js`
- `public/modules/portfolio-state.js`（凍結名單的狀態來源）（門檻單一真相）
- `public/modules/portfolio-symbol.js`（門檻單一真相）
- `public/modules/portfolio-tables.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/portfolio-valuation-actions.js`（`SIGNALS_INFO_HTML` 的接線）
- `public/modules/portfolio-valuation.js`（`SIGNALS_INFO_HTML` 實際定義處）
- `public/modules/portfolio-visuals.js`（紀律顯示）
- `public/modules/portfolio.js`（門檻單一真相）
- `public/modules/securities-view.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `public/modules/securities.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `public/modules/signal-tiers.js`（門檻單一真相）
- `public/modules/stock-research-fundamentals.js`（SEC 指標挑值的前端呈現）
- `public/modules/stock-research-method.js`（挑值方法說明）
- `public/modules/stock-research-model.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/stock-research-page.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/stock-research-score.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `public/modules/stock-research-view.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕
- `server.js`（`authGate` → `installHeavyAdmission` 的順序）
- `test/codex-r11.test.js`
- `test/derive-reminders.test.js`
- `test/derive.test.js`
- `test/fx-sentinel.test.js`（哨兵匯率：三個檔每一處換算都吃設定裡的匯率）
- `test/heavy-admission.test.js`
- `test/ib-cash-freshness.test.js`（IB 同步寫入與 securityTrades 雙寫）
- `test/ib-parser-money.test.js`
- `test/ib-sync-integrity.test.js`（IB 同步與匯率的失真守衛：匯率空值／1019 白名單／官方淨值壞值／重複持股）
- `test/insights.test.js`
- `test/parse-limits.test.js`
- `test/portfolio-activity.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-calculations.test.js`
- `test/portfolio-chart.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-details.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-editors.test.js`
- `test/portfolio-exposure.test.js`
- `test/portfolio-format.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-forms.test.js`
- `test/portfolio-ib-sync.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-info-actions.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-info.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-model.test.js`
- `test/portfolio-overview.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-quotes.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-remote-actions.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-report.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-research-actions.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-research.test.js`
- `test/portfolio-risk.test.js`
- `test/portfolio-state.test.js`（**弱化這幾支前必讀本契約**）（契約點名的考題——**弱化考題也要先讀契約**）
- `test/portfolio-tables.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/portfolio-valuation-actions.test.js`
- `test/portfolio-valuation.test.js`
- `test/portfolio-visuals.test.js`
- `test/securities-contract.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `test/securities-import.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `test/securities-migration.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `test/securities-preview-projection.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `test/securities-sync.test.js`（多幣別／幣別牆考題）
- `test/securities-ui.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `test/security-trades.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕
- `test/server.test.js`
- `test/signal-tiers.test.js`（直接鎖住契約列出的六個單一真相）
- `test/stock-fundamentals-api.test.js`（契約點名的考題——**弱化考題也要先讀契約**）
- `test/stock-fundamentals.test.js`（**契約點名的 CBRE／Dover／Amazon／Microsoft／JNJ／AAPL／Alphabet 考題都在這支**）
- `test/stock-research-fundamentals.test.js`
- `test/stock-research-method.test.js`
- `test/stock-research-model.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/stock-research-page.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/stock-research-score.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/stock-research-view.test.js`〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔模組分工節點名的 17 支同名考題〕
- `test/taishin-securities.test.js`（types/store/taishin/server 類＝**多領域多重命中**）〔籃C 補搬點名檔（投資頁前端模組分工座位表＋securityTrades）〕〔securityTrades 的 API／UI／資料形狀與直接考題〕

備註（原表格同一格裡、不屬於任何單一檔案的句子，逐字）：

- 〔〔原表格版的位置語：「後面這一批」＝Codex #384 r27 補列、原本緊接在「清單＝宣告的責任集合」那句後面的那一批；本版依路徑排序後不再分批，也不另存那一批的名單——要看當時的分批去讀原表格版（本檔的 git 歷史）〕⚠️ 後面這一批是 Codex #384 r27 抓到的漏項。**它 r29 又找到 64 支，並撤回自己「補完就可合併」的判斷（「那次抽查範圍不足」）**——所以硬規則①已把「窮舉」降級成「宣告的責任集合」：這道護欄主要驗已宣告的集合彼此一致，**大體上驗不出人漏宣告了什麼**（#409 r6（2026-08-06）補了一道例外：**已宣告的正式程式 import 進來的模組**，兩邊一起漏列時會轉紅——那只關掉「從已宣告的檔案切出一個新模組卻沒登記」這一種漏法，其餘仍然靠人）。弱化這幾支考題前必讀本契約。〕

### 資料與儲存

契約：[data-storage.md](data-storage.md)

- `data/seed.json`
- `db/supabase-schema.sql`
- `lib/repo.js`
- `lib/routes/core.js`
- `lib/schema.js`
- `lib/services/backup.js`
- `lib/services/snapshot.js`
- `lib/services/statement-import.js`（importRows／setBatchMonth 的日期判準，以及 normalizeBranches **刻意沒有**操作前備份這條裁決——**與收支多重命中**）
- `lib/services/store-rules.js`
- `lib/store-pg.js`
- `lib/store-rules.js`
- `lib/store.js`
- `lib/types.js`
- `public/modules/backup-alert.js`
- `server.js`
- `test-doubles/fake-supabase.js`
- `test/backup-alert.test.js`
- `test/daily-backup.test.js`
- `test/hosted-import-overwrite.test.js`
- `test/hosted-store-pg.test.js`
- `test/repo-async.test.js`
- `test/server.test.js`
- `test/vault-and-backup-integrity.test.js`（寫入櫃檯 fail-loud／備份的原子替換與殘骸清理／**「不得再長出操作前自動備份」的裁決題**／損毀 fail-closed）

### 雲端與安全

契約：[cloud-security.md](cloud-security.md)

- `data/seed.json`
- `db/supabase-schema.sql`
- `lib/bank-statement.js`
- `lib/crypto-secrets.js`
- `lib/hosted.js`
- `lib/http-body.js`
- `lib/ib.js`
- `lib/parse-limits.js`
- `lib/pdf-isolate-child.js`
- `lib/pdf-isolate.js`
- `lib/rate-limit.js`
- `lib/routes/auth.js`
- `lib/routes/core.js`
- `lib/routes/crud.js`
- `lib/secret-fields.js`
- `lib/services/auth.js`
- `lib/statement.js`
- `lib/store-pg.js`
- `lib/store-rules.js`
- `lib/taishin-securities.js`
- `lib/tenant.js`
- `package-lock.json`
- `public/modules/ai-consent.js`（AI 送出前的同意告知——**與收支多重命中**）
- `public/modules/ai-key-settings.js`（AI 鑰匙欄與文案：機密不回顯、句子在 LOCAL/HOSTED 都要成立）
- `public/modules/assets.js`
- `public/modules/backup-export.js`（匯出那條路的機密面：LOCAL 含機密／HOSTED 剝除，畫面文案依模式分流——#417）
- `public/modules/cards.js`
- `public/modules/cashflow-model.js`（密碼欄兩句文案與 `bankPasswordLabel` 挑句判準的家）
- `public/modules/cashflow.js`（銀行上傳密碼欄的告知依模式分流：先問 `/api/mode` 再開窗——2026-08-11；**與前端、收支多重命中**）
- `public/modules/settings.js`
- `public/modules/toast-timing.js`（匯出提示停留時間——#417）
- `public/modules/transactions-import.js`（信用卡上傳密碼窗：借同一份挑句問 `/api/mode` 再開窗——P0.5；**與收支多重命中**）
- `server.js`
- `test-doubles/fake-supabase.js`
- `test/ai-consent.test.js`
- `test/ai-key-settings.test.js`
- `test/backup-export.test.js`
- `test/cashflow-bank-upload.test.js`（密碼欄挑句判準＋接線題）
- `test/deploy-config.test.js`
- `test/hosted-auth.test.js`
- `test/hosted-secret-writeback.test.js`
- `test/hosted-secrets.test.js`
- `test/hosted-store-pg.test.js`
- `test/ib-parser-money.test.js`
- `test/parse-limits.test.js`
- `test/pdf-isolate.test.js`
- `test/pdf-limits-wiring.test.js`
- `test/rate-limit.test.js`
- `test/server.test.js`
- `test/xlsx-isolate.test.js`

備註（原表格同一格裡、不屬於任何單一檔案的句子，逐字）：

- 〔**清單＝宣告的責任集合（下限）**，與拆分護欄考題的 MANIFEST 精確相等（⚠️ `render.yaml`／`.node-version`／`eslint.config.js`／public-site 內未以帶副檔名路徑點名的頁面，仍在機械抽取正規式之外——契約內文照提、機器驗不到，誠實劃界；package.json 與 package-lock.json、public-site/、.github/workflows 三類已於 #397 納入正規式視野）〕
