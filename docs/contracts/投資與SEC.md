# 契約：投資與 SEC（基本面／佇列護欄／曝險穿透／槓桿／代號原則／估值訊號）

> 本檔是 AGENTS.md「同步點清單」拆出的**領域契約**（D4b，2026-08-01）。
> **內文＝原同步點列逐字照搬**（唯一轉換＝表格列解框成「改這裡／記得同步這裡」兩段）；新增的只有標題與本頁首。
> **適用檔案清單＝[README.md](README.md) 路由表「投資與 SEC」列（單一真相，本頁首不重複維護一份會走散的副本）**——命中就必讀本檔。

## SEC 官方指標挑值

**改這裡**：SEC 官方指標候選 tag 與 `selectMetric`（`lib/stock-fundamentals.js`）

**記得同步這裡**：候選 tag 的順序是**同一期間的語意優先序**，不是看到較大數字就採用。`revenue` 同期間依序採 `Revenues`（總額）→ `RevenueFromContractWithCustomerExcludingAssessedTax`（合約收入成分）→ `SalesRevenueNet`；其他一般指標沿用候選表既定順序，**不相加、不用數值大小猜總額**。先由第一個有合法資料的 tag 選定單一 unit；其後的低順位 tag 只能用同一 unit，而且只能補進**比目前已採序列還新**的期間。同期不改寫、舊期缺口不回頭填，最後才裁成最近五年與最新單季。多 unit 與 YTD 警示只統計真正採用的主來源，以及實際補進新期的退路來源，不可把未採用 tag 重複計數。每一列必須保留自己的 `taxonomy/tag` 與申報來源；metric 表頭的 `taxonomy/tag` 跟最新採用列走。F5 趨勢仍只接受同 unit／taxonomy／tag／期間類型，跨 tag 接力的列要 fail-closed，不可混畫成同口徑趨勢。改動必跑三型考題：CBRE 型（同期成分 250000、總額 400000，淨利 100000 時 margin＝25%）、Comcast 型（高優先總額較舊、低優先 tag 只補新期）、Verizon 型（單一 tag 前後完全不變），並直接通過 `sanitizeDbForWrite`。`currentDebt` 仍由同一 `selectMetric` 入口分派到下節的逐期總額／成分安全判斷，但三個來源群內都維持整條 first-hit；`noncurrentDebt` 也維持整條近義 tag first-hit 退路，不做跨 tag 逐期接力。

## SEC currentDebt 流動債務

**改這裡**：SEC `currentDebt`（`lib/stock-fundamentals.js`）

**記得同步這裡**：**逐期間總額優先**：先採 `DebtCurrent`；缺總額才看 `ShortTermBorrowings`＋一年內長債。兩者同時存在時，先用該份申報的 XBRL filer terse／verbose label 判斷 `ShortTermBorrowings` 是「已含一年內長債」或「純短債」；label 抓不到時，只有同 accession／unit／期間／form／filed、金額非負，且 `ShortTermBorrowings < 一年內長債`（數值關係已排除父項包含子項）才可相加，否則保守不加並警告。**任一期間只命中一種債務時原 fact 原樣保留**，不可因另一組缺席而丟期數。候選 tag 的單一真相＝`SEC_METRIC_CANDIDATES.currentDebt.currentDebtSources`，parser／label accession 掃描都從它取，production 不得另抄群組；相加列要保留 row-level `taxonomy:'derived'`／`tag`／`formula`／`inputs`／申報來源，並通過 `sanitizeDbForWrite`。改動必跑 Dover（父子重疊）、Amazon（兩種分開）、Microsoft（單一來源）三型考題與真 SEC 申報回歸；`noncurrentDebt` 不在此同步點範圍。

## SEC 全站佇列護欄

**改這裡**：**SEC 全站佇列護欄（2026-07-30，#335 複審 dos 條）**

**記得同步這裡**：`lib/services/stock-fundamentals.js`：`SEC_QUEUE_MAX_DEPTH=16`（排隊中＋執行中；滿了**立即 503「請稍後再試」**＝back-pressure 第三種身分，私有 Symbol、不記 lastError、不走內部 500）＋`SEC_REFRESH_BUDGET_MS=60s`（單次 refresh 全管線總時限，含排隊等待＋最多 11 個請求＋重試；輪到自己時預算耗盡＝不再發出、branded `sec_timeout` 記入 lastError——可歸因 SEC 慢、使用者要看得到原因）。**兩種模式都套**（保護行程可用性，判準同解析器資源上限，與速率限制的「只 HOSTED」不同）。考題＝`test/stock-fundamentals-api.test.js` 佇列六題。⚠️⚠️ **硬期限只能在「還沒開始執行」時 race**（r3 血淚）：一旦開始執行就必須交給 AbortController，因為 race 掉外層會讓 `fetchSecResource` 的 finally 清掉 per-fetch abort timer ⇒ **body 再也沒人取消、永不結束 ⇒ `secQueueDepth -= 1` 永不執行 ⇒ 名額永久洩漏、佇列慢性死亡**。（r2 版無條件 race 就是這個病，比它要修的原病更嚴重。）⚠️ **預算的誠實範圍＝SEC 網路管線**（排隊＋請求＋重試），**不含**期限後仍會跑完的本機解析與快取寫入——不是「HTTP 回應的絕對上限」。⚠️ **殘餘邊界**：若 `fetchImpl` 完全忽略 AbortSignal 就會永久掛住占名額；正式 `globalThis.fetch` 遵守 signal，故不另設防（要不要連壞掉的 fetch 實作都硬回應＝產品決定，未做）。⚠️ **收斂冗餘守門的配套（血淚兩條）**：①行為完全重疊的兩道並存會讓任一道被誤刪時考題都不出聲（實測各自單拆全綠、同拆才紅）→ 收斂成一道；②但收斂之後，**每個「傳期限給那唯一守門」的呼叫點都變成單點失效**，必須逐點各補一題（Codex 逐點突變才找出 submissions 是唯一漏網）。③參數標成**必填 `number`** 而非 optional——少寫參數會被 arity 擋，但**傳 `undefined` 連 typecheck 都過**。⚠️ 期限守門只留一道（最靠近發送點、每次 retry 都經過的那道）——行為重疊的兩道並存會讓任一道被誤刪時考題都不出聲（實測各自單拆都全綠、同拆才紅）。⚠️ 三條在 r2 才補齊的語意：①**深度必須涵蓋到 body 讀完**（headers 到了不等於資源釋放——連線與記憶體還占用中，所以 `readResponse` 留在佇列 fn 內）②**排隊等待者要有硬期限**（只在輪頭檢查的話，深度 16×每支 10 秒＝尾端 150 秒才知道逾時，「最多 60 秒」是假話；用可清除計時器 race，底下任務照常輪到並在 finally 釋放名額）③**pacing sleep 後要再驗一次 deadline**（驗在 sleep 前等於沒驗）。⚠️ 一次 refresh 的多個請求**一律序列**（佇列本來就序列化執行，`Promise.all` 零收益卻佔兩個名額＝自己把自己擠成 503）。⚠️ 掛住的假 fetch 考題收尾要 finally＋收集**全部** resolver——單一變數會被蓋掉、懸掛請求讓 server.close 永遠等不到（實際踩過）

## COMPOSITION 穿透表

**改這裡**：`public/modules/portfolio-exposure.js` 的 `COMPOSITION` 穿透表

**記得同步這裡**：`lib/derive.js` 的同名複本

## fxExposure 台幣掛牌美債 ETF 清單

**改這裡**：`portfolio-exposure.js` `fxExposure` 寫死的台幣掛牌美債 ETF 清單（00719B/00720B）

**記得同步這裡**：新增同類 ETF 時要補進清單

## 新增 ETF 持股

**改這裡**：新增 ETF 持股

**記得同步這裡**：`portfolio-exposure.js` `COMPANY_WEIGHTS`（前十大成分近似權重，持股公司 Top 20 用）＋`COMPOSITION` 區域表（前端 exposure 與後端 derive 兩檔案）。**例外（刻意）**：XUSE/EXUS 只做區域穿透、不列 COMPANY_WEIGHTS（成分極分散，前十大各僅 1–2%）

## ib-sync DEFAULT_LAYER 新增代號

**改這裡**：`lib/services/ib-sync.js` `DEFAULT_LAYER` 新增代號

**記得同步這裡**：兩份 `COMPOSITION` 也要有該代號（否則 IB 同步新增後區域穿透 fallback 成「其他」，國家上限提醒會偏掉）

## IB 槓桿與斷頭距離

**改這裡**：IB 槓桿＋斷頭距離公式（lastEquity 優先、自算 fallback）

**記得同步這裡**：後端單一真相＝`lib/derive.js computeLeverage()`（規則 7＋buildSummary 都用它、summary 有 `ib.leverage/loan/mcDist/hasLoan`）↔ 前端 `portfolio-model.js buildPortfolioModel()` 的槓桿計算與 `portfolio-calculations.js marginCallDistance()`，前後端兩份要一致。⚠️**mcDist 語意（Codex r11#3）**：100＝「無借款」專用值；**有借款但持股歸零**（已遭平倉/淨值轉負、比貼線更慘）＝回 **0**——前端 `marginCallDistance` 同情境回 null→顯示 0%，兩端口徑一致。別把兩種情境都塞 100（/api/summary 會把最危險講成最安全；test/codex-r11.test.js 鎖住）

## 投資代號與原則上限

**改這裡**：投資代號與投資原則上限／凍結加碼

**記得同步這裡**：代號身分單一真相＝`portfolio-symbol.js normalizePortfolioSymbol()`（trim＋大寫），持股寫入、ETF 穿透、QQQM／CSPX 佔比、研究卡、前後端個股上限都必須走它；同代號多筆持股必須彙總，紀律顯示、前端 `portfolioFreeze()` 與後端 `derive.computeReminders()` 不能各看單列。上限預設單一真相＝`portfolio-risk.js portfolioCaps()`；明確設定 0 代表零容忍，不可用 `||` 改回預設。編輯持股若把代號／資產身分改成已凍結標的，即使股數沒增加也要警告。

## 估值訊號門檻檔位

**改這裡**：估值訊號門檻／檔位（**程式單一真相＝`public/modules/signal-tiers.js`**，D3 抽出）

**記得同步這裡**：純模組（`regionTier`/`taiwanTier`/`ecyOf`/`computeSignalTiers`/`TIER_LABELS`/`US_RATIO`），前端 `portfolio.js` 估值儀表與後端 `lib/services/insights.js` 跳檔**都 import 這一份**（後端 import `public/modules` 的前例＝categories.js）。改門檻只改這裡一處；**白話文件要跟著對齊**：投資原則規則書（memory）＋標題說明彈窗 `portfolio.js SIGNALS_INFO_HTML`。`portfolio.js` 只保留檔位**顏色**（presentation），label 取自 `TIER_LABELS`。

## settings-signals

**改這裡**：`settings.signals`（美股自動、區域四市場每月手動）

**記得同步這裡**：只在投組頁「更新區域數值」表單編輯；美股 ECY＝`/api/cape`＋`/api/realyield`（FRED DFII10）自動算，不手動
