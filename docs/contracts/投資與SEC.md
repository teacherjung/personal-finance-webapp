# 契約：投資與 SEC（基本面／佇列護欄／曝險穿透／槓桿／代號原則／估值訊號）

> 本檔是 AGENTS.md「同步點清單」拆出的**領域契約**（D4b，2026-08-01）。
> **內文＝原同步點列逐字照搬**（唯一轉換＝表格列解框成「改這裡／記得同步這裡」兩段）；新增的只有標題與本頁首。
> **適用檔案清單＝[README.md](README.md) 路由表「投資與 SEC」列（單一真相，本頁首不重複維護一份會走散的副本）**——命中就必讀本檔。

## SEC 官方指標挑值

**改這裡**：SEC 官方指標候選 tag 與 `selectMetric`（`lib/stock-fundamentals.js`）

**記得同步這裡**：候選 tag 的順序是**同一期間的語意優先序**，不是看到較大數字就採用。`revenue` 同期間依序採 `Revenues`（總額）→ `RevenueFromContractWithCustomerExcludingAssessedTax`（合約收入成分）→ `SalesRevenueNet`；其他一般指標沿用候選表既定順序，**不相加、不用數值大小猜總額**。先由第一個有合法資料的 tag 選定單一 unit；其後的低順位 tag 只能用同一 unit。同期不改寫；年度與季度各自補合法資料，不能因高順位 tag 只在另一種期間有舊資料，就讓 JNJ 型整條年度或 AAPL 型最新季度消失。**每個 tag 先保留完整去重歷史做重疊比對，最後輸出才裁最近五年**；不得讓第六年前的衝突證據因提早裁切而消失。兩來源若有重疊期間，一般任一期相對差異 **>0.1%** 就是實質口徑衝突（Dover／Ford 型）。唯一的進位例外須同時符合：兩值同號且至少百萬、差異不超過 1%、至少一值是百萬整數，且另一值四捨五入到同一百萬（CBRE capex 型）；這不是一般 1% 容忍。年度或季度任一軸證明衝突，就拒絕**整個**低順位 tag 的所有新舊期間，另一軸不可各自接上；只有被拒來源的缺期原本可能進入最近五年或最新單季時，才回 `TAG_OVERLAP_CONFLICT`，畫面外的舊缺期不誤報。舊洞門檻更嚴：仍須至少兩個重疊期間的 unit 與數值**完全相同**且沒有其他非完全相同的重疊，才補中間缺口（Alphabet 型），否則舊洞保留。`MIXED_TAG`、多 unit 與 YTD 警示只看最近五年＋最新單季真正輸出的來源；已被裁掉的舊 tag 不得讓 AAPL 型畫面一邊 F5 `comparable`、一邊誤報混合來源。同一申報脈絡但不同 tag 的 YTD 是兩筆不同來源，不可合併計數。每一列必須保留自己的 `taxonomy/tag` 與申報來源；metric 表頭的 `taxonomy/tag` 跟最新採用列走。實際輸出跨 tag 接力才回 `MIXED_TAG`；F5 趨勢只接受同 unit／taxonomy／tag／期間類型，CAGR 等真正跨期公式的起訖來源也必須相同。毛利率、淨利率、自由現金流等逐期公式只配對同一期間並保留完整 `inputs`，不可因**相容**的別期換 tag 把整條可重算序列刪光；最新季度來源與最新年度來源不同時，季度比率仍 fail-closed。改動必跑 CBRE 型（同期總額、capex 進位差）、Comcast 型（相容 tag 補新期）、Verizon 型（單一 tag 不變）、JNJ／AAPL 型（另一種期間軸不可消失）、Alphabet 型（完全同值證據才補舊洞）與 Dover／Ford 型（實質衝突拒接），並直接通過 `sanitizeDbForWrite`。`currentDebt` 仍由同一 `selectMetric` 入口分派到下節的逐期總額／成分安全判斷，但三個來源群內都維持整條 first-hit；`noncurrentDebt` 也維持整條近義 tag first-hit 退路，不做跨 tag 逐期接力。

### 最新單季逐列期間

**改這裡**：SEC 最新單季逐列期間（`periods.latestQuarterBasis:'per-metric'`）

**記得同步這裡**：各指標的最新合法單季本來就可能不同期。payload 必須以 `periods.latestQuarterBasis:'per-metric'` 明示逐列判讀；不同截止日並存時保留所有合法數值並發 `QUARTER_PERIOD_MISMATCH`，F5 每列直接顯示自己的完整期間，不把整欄假裝成同一季，也不可用全域期間把合法的 Q1 現金流列清空。

## SEC currentDebt 流動債務

**改這裡**：SEC `currentDebt`（`lib/stock-fundamentals.js`）

**記得同步這裡**：**逐期間總額優先**：先採 `DebtCurrent`；缺總額才看 `ShortTermBorrowings`＋一年內長債。兩者同時存在時，先用該份申報的 XBRL filer terse／verbose label 判斷 `ShortTermBorrowings` 是「已含一年內長債」或「純短債」；label 抓不到時，只有同 accession／unit／期間／form／filed、金額非負，且 `ShortTermBorrowings < 一年內長債`（數值關係已排除父項包含子項）才可相加，否則保守不加並警告。**任一期間只命中一種債務時原 fact 原樣保留**，不可因另一組缺席而丟期數。候選 tag 的單一真相＝`SEC_METRIC_CANDIDATES.currentDebt.currentDebtSources`，parser／label accession 掃描都從它取，production 不得另抄群組；相加列要保留 row-level `taxonomy:'derived'`／`tag`／`formula`／`inputs`／申報來源，並通過 `sanitizeDbForWrite`。改動必跑 Dover（父子重疊）、Amazon（兩種分開）、Microsoft（單一來源）三型考題與真 SEC 申報回歸；`noncurrentDebt` 不在此同步點範圍。

## SEC 全站佇列護欄

**改這裡**：**SEC 全站佇列護欄（2026-07-30，#335 複審 dos 條）**

**記得同步這裡**：`lib/services/stock-fundamentals.js`：`SEC_QUEUE_MAX_DEPTH=16`（排隊中＋執行中；滿了**立即 503「請稍後再試」**＝back-pressure 第三種身分，私有 Symbol、不記 lastError、不走內部 500）＋`SEC_REFRESH_BUDGET_MS=60s`（單次 refresh 全管線總時限，含排隊等待＋最多 11 個請求＋重試；輪到自己時預算耗盡＝不再發出、branded `sec_timeout` 記入 lastError——可歸因 SEC 慢、使用者要看得到原因）。**兩種模式都套**（保護行程可用性，判準同解析器資源上限，與速率限制的「只 HOSTED」不同）。考題＝`test/stock-fundamentals-api.test.js` 佇列六題。⚠️⚠️ **硬期限只能在「還沒開始執行」時 race**（r3 血淚）：一旦開始執行就必須交給 AbortController，因為 race 掉外層會讓 `fetchSecResource` 的 finally 清掉 per-fetch abort timer ⇒ **body 再也沒人取消、永不結束 ⇒ `secQueueDepth -= 1` 永不執行 ⇒ 名額永久洩漏、佇列慢性死亡**。（r2 版無條件 race 就是這個病，比它要修的原病更嚴重。）⚠️ **預算的誠實範圍＝SEC 網路管線**（排隊＋請求＋重試），**不含**期限後仍會跑完的本機解析與快取寫入——不是「HTTP 回應的絕對上限」。⚠️ **殘餘邊界**：若 `fetchImpl` 完全忽略 AbortSignal 就會永久掛住占名額；正式 `globalThis.fetch` 遵守 signal，故不另設防（要不要連壞掉的 fetch 實作都硬回應＝產品決定，未做）。⚠️ **收斂冗餘守門的配套（血淚兩條）**：①行為完全重疊的兩道並存會讓任一道被誤刪時考題都不出聲（實測各自單拆全綠、同拆才紅）→ 收斂成一道；②但收斂之後，**每個「傳期限給那唯一守門」的呼叫點都變成單點失效**，必須逐點各補一題（Codex 逐點突變才找出 submissions 是唯一漏網）。③參數標成**必填 `number`** 而非 optional——少寫參數會被 arity 擋，但**傳 `undefined` 連 typecheck 都過**。⚠️ 期限守門只留一道（最靠近發送點、每次 retry 都經過的那道）——行為重疊的兩道並存會讓任一道被誤刪時考題都不出聲（實測各自單拆都全綠、同拆才紅）。⚠️ 三條在 r2 才補齊的語意：①**深度必須涵蓋到 body 讀完**（headers 到了不等於資源釋放——連線與記憶體還占用中，所以 `readResponse` 留在佇列 fn 內）②**排隊等待者要有硬期限**（只在輪頭檢查的話，深度 16×每支 10 秒＝尾端 150 秒才知道逾時，「最多 60 秒」是假話；用可清除計時器 race，底下任務照常輪到並在 finally 釋放名額）③**pacing sleep 之後的那次檢查已經收斂掉了**（原本寫「sleep 後要再驗一次」，後來實測它與 `fetchSecResource` 的「發出前再驗剩餘預算」**行為完全重疊**——兩道並存時任一道被誤刪都不會有考題出聲：M6／M7 各自單獨拆掉全綠、M8 同時拆才紅）。**現行唯一守門在最靠近實際發送點、且每次 retry 都會經過的那一道**；要釘的不是「有幾道」，而是**每個呼叫點都必須把 deadline 傳給那唯一一道**（見上面「收斂冗餘守門的配套」）。⚠️ 一次 refresh 的多個請求**一律序列**（佇列本來就序列化執行，`Promise.all` 零收益卻佔兩個名額＝自己把自己擠成 503）。⚠️ 掛住的假 fetch 考題收尾要 finally＋收集**全部** resolver——單一變數會被蓋掉、懸掛請求讓 server.close 永遠等不到（實際踩過）

## 重型工作名額（heavy admission）與 SEC 的關係

**改這裡**：`lib/heavy-admission.js`（`HEAVY_ADMISSION_MAX_INFLIGHT`／`HEAVY_ROUTES`／`withHeavySlot`）

**記得同步這裡**：`lib/services/stock-fundamentals.js` 取名額那一行，以及上面那條「SEC 全站佇列護欄」。

⚠️ **看 SEC 的排隊語意時，`SEC_QUEUE_MAX_DEPTH` 已經不是唯一的那道門**（#371，2026-08-02）——
SEC refresh 在進 `throughSecQueue` **之前**還要先過共用的重型名額。只讀 #361 的契約會漏掉這個外層。

**兩層的分工（取捨不同，別互相照抄）**：

| | HTTP 入場管制（`heavyAdmission`） | 服務層名額（`withHeavySlot`） |
|---|---|---|
| 滿了怎麼辦 | **立刻 503**（fail-fast） | **排隊等**（有上限） |
| 為什麼 | 等待的人**手上握著一條還沒收完的連線**，讓它等＝一邊佔記憶體一邊排隊，正是這一層要防的事 | 等待**不花記憶體**：SEC 在等的時候手上沒有大緩衝區，貴的是抓下來之後整包 `JSON.parse` 那一刻 |
| 用在哪 | `HEAVY_ROUTES` 六條上傳＋列匯入＋`/api/import`＋`/api/ib/sync` | SEC 官方基本面 refresh（**刻意不掛 HTTP 層**——它有 `refreshInFlight` 去重，掛上去會連「不花錢的第二個」也擋掉） |

⚠️ **上限要數「執行中＋排隊中」，不是只數排隊中**（Codex #371 r5 血淚）：
`withHeavySlot` 的 `{ group: 'sec-refresh', maxInGroup: opts.maxQueueDepth }` 用的是 `groupInUse` 計數。
只數排隊中的話，**第一個 refresh 是執行中、不在隊伍裡**，`maxQueueDepth=1` 時第二個照樣排得進去；
預設值下更明顯：1 個執行中＋16 個排隊中＝**17**，比 #361 寫下的上限多一個。

⚠️ **等名額的計時器不可以 `unref()`**（正式環境那顆 Node 22.23.1 的 CI 抓到，本機 Node 26 全綠）：
unref 之後撐不住事件迴圈，迴圈一跑乾就是
「Promise resolution is still pending but the event loop has already resolved」——
考題被整批取消，而在正式環境代表**那個逾時可能永遠不會觸發**。
等待中的請求是**真的在進行的工作**，本來就該讓行程活著。
（⚠️ 反方向的同一件事在 `lib/pdf-isolate-child.js`：那裡**刻意**用計時器撐住子行程，
因為安靜退出會讓父行程把「我們卡住」誤報成「你的檔案太貴」。兩處要一起看。）

⚠️ **拿名額之前要先確認連線還活著**（獨立複核抓到的 High）：`authGate` 排在入場管制之前，
裡面有一段真的網路往返（`supabase.auth.getUser()`）。客戶端在那段期間斷線的話，
`res` 的 `'close'` 早就燒掉了，之後掛的 listener 一輩子不會觸發＝**名額有借無還**，
而 `inFlight` 不分租戶，一次洩漏就讓全站重型功能永久 503 直到重啟。

**誠實邊界（已知、未修）**：①名額涵蓋整段「上傳傳輸時間」而非只有解析時間，
一條滴水式連線可壓住名額到 request timeout（270 秒）②`/api/cards/:id/statement/import`
在 HOSTED 是 1MB、零檔案位元組，卻被當成重型工作③計數是行程內的，多實例部署會乘以實例數。

考題：`test/heavy-admission.test.js`＋`test/stock-fundamentals-api.test.js` 的「重型名額」四題。

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
