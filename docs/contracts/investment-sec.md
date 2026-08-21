# 契約：投資與 SEC（基本面／佇列護欄／曝險穿透／槓桿／代號原則／估值訊號）

> 本檔是 AGENTS.md「同步點清單」拆出的**領域契約**（D4b，2026-08-01）。
> **內文＝AGENTS 原文逐字照搬**（表格列解框成「改這裡／記得同步這裡」兩段；2026-08-04 籃C 起，同步點表以外的段落與清單同樣逐字、掛在同兩個標籤下）；新增的只有標題、標籤與本頁首。
> **適用檔案清單＝[README.md](README.md) 路由表「投資與 SEC」列（單一真相，本頁首不重複維護一份會走散的副本）**——命中就必讀本檔。

## SEC 官方指標挑值

**改這裡**：SEC 官方指標候選 tag 與 `selectMetric`（`lib/stock-fundamentals.js`）

**記得同步這裡**：候選 tag 的順序是**同一期間的語意優先序**，不是看到較大數字就採用。`revenue` 同期間依序採 `Revenues`（總額）→ `RevenueFromContractWithCustomerExcludingAssessedTax`（合約收入成分）→ `SalesRevenueNet`；其他一般指標沿用候選表既定順序，**不相加、不用數值大小猜總額**。先由第一個有合法資料的 tag 選定單一 unit；其後的低順位 tag 只能用同一 unit。同期不改寫；年度與季度各自補合法資料，不能因高順位 tag 只在另一種期間有舊資料，就讓 JNJ 型整條年度或 AAPL 型最新季度消失。**每個 tag 先保留完整去重歷史做重疊比對，最後輸出才裁最近五年**；不得讓第六年前的衝突證據因提早裁切而消失。兩來源若有重疊期間，一般任一期相對差異 **>0.1%** 就是實質口徑衝突（Dover／Ford 型）。唯一的進位例外須同時符合：兩值同號且至少百萬、差異不超過 1%、至少一值是百萬整數，且另一值四捨五入到同一百萬（CBRE capex 型）；這不是一般 1% 容忍。年度或季度任一軸證明衝突，就拒絕**整個**低順位 tag 的所有新舊期間，另一軸不可各自接上；只有被拒來源的缺期原本可能進入最近五年或最新單季時，才回 `TAG_OVERLAP_CONFLICT`，畫面外的舊缺期不誤報。舊洞門檻更嚴：仍須至少兩個重疊期間的 unit 與數值**完全相同**且沒有其他非完全相同的重疊，才補中間缺口（Alphabet 型），否則舊洞保留。`MIXED_TAG`、多 unit 與 YTD 警示只看最近五年＋最新單季真正輸出的來源；已被裁掉的舊 tag 不得讓 AAPL 型畫面一邊 F5 `comparable`、一邊誤報混合來源。同一申報脈絡但不同 tag 的 YTD 是兩筆不同來源，不可合併計數。每一列必須保留自己的 `taxonomy/tag` 與申報來源；metric 表頭的 `taxonomy/tag` 跟最新採用列走。實際輸出跨 tag 接力才回 `MIXED_TAG`；F5 趨勢只接受同 unit／taxonomy／tag／期間類型，CAGR 等真正跨期公式的起訖來源也必須相同。毛利率、淨利率、自由現金流等逐期公式只配對同一期間並保留完整 `inputs`，不可因**相容**的別期換 tag 把整條可重算序列刪光；最新季度來源與最新年度來源不同時，季度比率仍 fail-closed。改動必跑 CBRE 型（同期總額、capex 進位差）、Comcast 型（相容 tag 補新期）、Verizon 型（單一 tag 不變）、JNJ／AAPL 型（另一種期間軸不可消失）、Alphabet 型（完全同值證據才補舊洞）與 Dover／Ford 型（實質衝突拒接），並直接通過 `sanitizeDbForWrite`。`currentDebt` 仍由同一 `selectMetric` 入口分派到下節的逐期總額／成分安全判斷，但三個來源群內都維持整條 first-hit；`noncurrentDebt` 也維持整條近義 tag first-hit 退路，不做跨 tag 逐期接力。

### 最新單季逐列期間

**改這裡**：SEC 最新單季逐列期間（`periods.latestQuarterBasis:'per-metric'`）

**記得同步這裡**：各指標的最新合法單季本來就可能不同期。payload 必須以 `periods.latestQuarterBasis:'per-metric'` 明示逐列判讀；不同截止日並存時保留所有合法數值並發 `QUARTER_PERIOD_MISMATCH`，F5 每列直接顯示自己的完整期間，不把整欄假裝成同一季，也不可用全域期間把合法的 Q1 現金流列清空。

## SEC currentDebt 流動債務

**改這裡**：SEC `currentDebt`（`lib/stock-fundamentals.js`）

**記得同步這裡**：**逐期間總額優先**：先採 `DebtCurrent`；缺總額才看 `ShortTermBorrowings`＋一年內長債。兩者同時存在時，先用該份申報的 XBRL filer terse／verbose label 判斷 `ShortTermBorrowings` 是「已含一年內長債」或「純短債」；label 抓不到時，只有同 accession／unit／期間／form／filed、金額非負，且 `ShortTermBorrowings` 小於一年內長債（數值關係已排除父項包含子項）才可相加，否則保守不加並警告。**任一期間只命中一種債務時原 fact 原樣保留**，不可因另一組缺席而丟期數。候選 tag 的單一真相＝`SEC_METRIC_CANDIDATES.currentDebt.currentDebtSources`，parser／label accession 掃描都從它取，production 不得另抄群組；相加列要保留 row-level `taxonomy:'derived'`／`tag`／`formula`／`inputs`／申報來源，並通過 `sanitizeDbForWrite`。改動必跑 Dover（父子重疊）、Amazon（兩種分開）、Microsoft（單一來源）三型考題與真 SEC 申報回歸；`noncurrentDebt` 不在此同步點範圍。

## SEC 單一回應資源上限

**改這裡**：`lib/parse-limits.js` 的 `MAX_SEC_RESPONSE_BYTES`

**記得同步這裡**：SEC Company Facts 會完整收 body、解碼並 `JSON.parse`，所以位元組只是記憶體成本的起點。現行上限 25MiB；#371 的隔離量測約增加 118MiB RSS，且重型名額把同時執行限制為 1，因此保留到足以容納約 5–15MiB 的正常公司資料。`lib/services/stock-fundamentals.js` 只引用該常數，並以 `SEC_MAX_RESPONSE_BYTES` 相容轉供；不得另抄數字。調整上限前必須重新量測 Render 512MiB 容器的 app 底噪、完整解析峰值與重型名額。考題＝`test/parse-limits.test.js` 固定資源預算＋`test/stock-fundamentals-api.test.js` 正式接線與禁重複宣告。

## SEC 全站佇列護欄

**改這裡**：**SEC 全站佇列護欄（2026-07-30，#335 複審 dos 條）**

**記得同步這裡**：`lib/services/stock-fundamentals.js`：`SEC_QUEUE_MAX_DEPTH=16`（排隊中＋執行中；滿了**立即 503「請稍後再試」**＝back-pressure 第三種身分，私有 Symbol、不記 lastError、不走內部 500）＋`SEC_REFRESH_BUDGET_MS=60s`（單次 refresh 全管線總時限，含排隊等待＋整條 SEC 請求管線（必要請求＋label 補抓，上限見 `currentDebtLabelAccessions` 的 slice）＋重試；輪到自己時預算耗盡＝不再發出、branded `sec_timeout` 記入 lastError——可歸因 SEC 慢、使用者要看得到原因）。**兩種模式都套**（保護行程可用性，判準同解析器資源上限，與速率限制的「只 HOSTED」不同）。考題＝`test/stock-fundamentals-api.test.js` 的佇列考題電池（「佇列」各題、題數以檔內為準）。⚠️⚠️ **硬期限只能在「還沒開始執行」時 race**（r3 血淚）：一旦開始執行就必須交給 AbortController，因為 race 掉外層會讓 `fetchSecResource` 的 finally 清掉 per-fetch abort timer ⇒ **body 再也沒人取消、永不結束 ⇒ `secQueueDepth -= 1` 永不執行 ⇒ 名額永久洩漏、佇列慢性死亡**。（r2 版無條件 race 就是這個病，比它要修的原病更嚴重。）⚠️ **預算的誠實範圍＝SEC 網路管線**（排隊＋請求＋重試），**不含**期限後仍會跑完的本機解析與快取寫入——不是「HTTP 回應的絕對上限」。⚠️ **殘餘邊界**：若 `fetchImpl` 完全忽略 AbortSignal 就會永久掛住占名額；正式 `globalThis.fetch` 遵守 signal，故不另設防（要不要連壞掉的 fetch 實作都硬回應＝產品決定，未做）。⚠️ **收斂冗餘守門的配套（血淚兩條）**：①行為完全重疊的兩道並存會讓任一道被誤刪時考題都不出聲（實測各自單拆全綠、同拆才紅）→ 收斂成一道；②但收斂之後，**每個「傳期限給那唯一守門」的呼叫點都變成單點失效**，必須逐點各補一題（Codex 逐點突變才找出 submissions 是唯一漏網）。③參數標成**必填 `number`** 而非 optional——少寫參數會被 arity 擋，但**傳 `undefined` 連 typecheck 都過**。⚠️ 期限守門只留一道（最靠近發送點、每次 retry 都經過的那道）——行為重疊的兩道並存會讓任一道被誤刪時考題都不出聲（實測各自單拆都全綠、同拆才紅）。⚠️ 三條在 r2 才補齊的語意：①**深度必須涵蓋到 body 讀完**（headers 到了不等於資源釋放——連線與記憶體還占用中，所以 `readResponse` 留在佇列 fn 內）②**排隊等待者要有硬期限**（只在輪頭檢查的話，深度 16×每支 10 秒＝尾端 150 秒才知道逾時，「最多 60 秒」是假話；用可清除計時器 race，底下任務照常輪到並在 finally 釋放名額）③**pacing sleep 之後的那次檢查已經收斂掉了**（原本寫「sleep 後要再驗一次」，後來實測它與 `fetchSecResource` 的「發出前再驗剩餘預算」**行為完全重疊**——兩道並存時任一道被誤刪都不會有考題出聲：M6／M7 各自單獨拆掉全綠、M8 同時拆才紅）。**現行唯一守門在最靠近實際發送點、且每次 retry 都會經過的那一道**；要釘的不是「有幾道」，而是**每個呼叫點都必須把 deadline 傳給那唯一一道**（見上面「收斂冗餘守門的配套」）。⚠️ 一次 refresh 的多個請求**一律序列**（佇列本來就序列化執行，`Promise.all` 零收益卻佔兩個名額＝自己把自己擠成 503）。⚠️ 掛住的假 fetch 考題收尾要 finally＋收集**全部** resolver——單一變數會被蓋掉、懸掛請求讓 server.close 永遠等不到（實際踩過）

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
| 用在哪 | `HEAVY_ROUTES`＝`STATEMENT_FILE_POST_ROUTES` 全部上傳路由＋列匯入＋`/api/import`＋`/api/ib/sync` | SEC 官方基本面 refresh（**刻意不掛 HTTP 層**——它有 `refreshInFlight` 去重，掛上去會連「不花錢的第二個」也擋掉） |

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

考題：`test/heavy-admission.test.js`＋`test/stock-fundamentals-api.test.js` 的「重型名額｜」各題。

## 新增 ETF 持股

**改這裡**：新增 ETF 持股

**記得同步這裡**：`portfolio-exposure.js` `COMPANY_WEIGHTS`（前十大成分近似權重，持股公司 Top 20 用）＋`COMPOSITION` 區域表（前端 exposure 與後端 derive 兩檔案）。**例外（刻意）**：XUSE/EXUS 只做區域穿透、不列 COMPANY_WEIGHTS（成分極分散，前十大各僅 1–2%）

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

## 投資頁前端模組分工

**改這裡**：投資頁前端模組（`portfolio-*.js` 家族的座位表、工作流、停止線與格式單一真相）

**記得同步這裡**：投資組合的**零 DOM／零 API 純模組層**分成 `modules/portfolio-calculations.js`（匯率表、持股成本、槓桿距離、交易損益換匯、XIRR 現金流組裝與求解）、`modules/portfolio-exposure.js`（資產型別、ETF 區域／公司穿透、幣別底層曝險）、`modules/portfolio-model.js`（把持股、帳戶與 IB 官方摘要組成頁面共用的台幣金額模型）、`modules/portfolio-state.js`（把金額模型整理成分層金額、QQQM 核心佔比、投資上限／凍結名單與 XIRR 頁面狀態）、`modules/portfolio-risk.js`（前後端共用的投資上限預設＋前端凍結加碼名單）、`modules/portfolio-report.js`（把已算好的投資資料整理成 A4 列印 HTML）、`modules/portfolio-details.js`（把已算好的成本、資產、交易資料排序成彈窗 HTML；格式器由頁面注入，維持 NT／US 雙計價）、`modules/portfolio-activity.js`（IB 現金流、交易摘要與匯率來源說明；只接資料＋目前計價，不碰頁面狀態）、`modules/portfolio-visuals.js`（紀律檢查、幣別／區域／公司曝險、分層配置與持股圓環；只接已算資料與格式器，不碰 DOM/API）、`modules/portfolio-valuation.js`（把 `signal-tiers.js` 算出的五市場檔位、CAPE 分位／規則帶與列印摘要排成 HTML；API、DOM、表單仍由頁面負責，門檻單一真相仍在 `signal-tiers.js`）、`modules/portfolio-tables.js`（把持股分層排序、價格／損益／佔比與願望清單狀態排成主表 HTML；排序狀態、localStorage 與事件仍由頁面負責）、`modules/portfolio-research.js`（把個股論點、指標、風險、最近檢查點與研究表單規格排成 HTML／資料；API 寫入與事件仍由頁面負責）、`modules/portfolio-overview.js`（把頁首、總覽卡、估值占位卡與 XIRR 摘要排成 HTML；金額格式、API、圖表與事件仍由頁面負責）、`modules/portfolio-chart.js`（把投入／市值月序列、NT／US 換算與 Chart.js 設定整理成純資料）、`modules/portfolio-quotes.js`（把 Yahoo 報價代號、匯率精度、幣別護欄與逐筆寫回計畫整理成純資料；API 與真正寫入仍由頁面負責）、`modules/portfolio-forms.js`（把持股／願望清單／估值表單規格、持股成本整理與凍結加碼原因整理成純資料；確認、API 與提示仍由頁面負責）與 `modules/portfolio-ib-sync.js`（把 IBKR 同步成功摘要與現金資料異常旗標翻成使用者回報；同步、寫入與已出清確認仍由頁面負責）。**個股研究頁（Codex P1–P5）另成一組**：`modules/stock-research-model.js`（持股／研究模型、空狀態分型、占比與上限組裝）、`modules/stock-research-score.js`（五構面評分：0 分是合法評分、五項未評完不算總分、同日歷史去重）、`modules/stock-research-view.js`（純呈現層＋就地解釋 `STOCK_RESEARCH_INFO`；交易一律**原幣呈現、不跨幣別加總**）、`modules/stock-research-page.js`（DOM／API／事件接線）。**入口只有兩個、且只給 `layer:'stock'`**（P5）：投資主表的代號（`portfolio-tables.js`）與研究摘要卡的「詳細研究」（`portfolio-research.js`），都用 `normalizePortfolioSymbol` 正規化＋`encodeURIComponent` 組 `#stock?symbol=`、`target=_blank`＋`rel=noopener`；ETF／債券／衛星與店名欄維持純文字。⚠️ 路由要吃得下 query（`router()` 的 `.split('?')[0]`）；⚠️ 新分頁會**獨立重跑一次開機序列**（報價／快照／店名整理／訂閱續費日推進）＝既定裁決，伺服器端都有時間閘或冪等保護（`docs/個股研究頁-施工計畫.md` §九）；改這些公式、成分表、頁面狀態、報表、明細、活動卡、視覺、估值、主表、研究卡、摘要、圖表、報價、表單或同步回報口徑要在對應檔補固定輸入輸出考題，不要把邏輯塞回 `portfolio.js` 的畫面流程。

  - **投資代號身分＝`modules/portfolio-symbol.js`**：只做 trim＋大寫，屬零 DOM／零 API 純規則；持股寫入、ETF 穿透、QQQM／CSPX 佔比、研究卡與前後端個股上限直接共用，避免空白／大小寫讓同一標的被拆成不同身分。
  - **投資編輯工作流＝`modules/portfolio-editors.js`**：持股／願望清單的表單開啟、凍結加碼確認、POST／PUT、成功提示與重畫集中在這裡；頁面注入 API、彈窗、確認與重畫工具，模組不直接 import `app.js`。改寫入順序或入口時要用假 API 補工作流考題，並維持凍結名單在「按下儲存」時才重讀。
  - **投資遠端操作工作流＝`modules/portfolio-remote-actions.js`**：IBKR 同步、可能已出清持股確認、Yahoo 報價與匯率逐筆寫回、按鈕狀態、成功／失敗提示與切頁序號防護集中在這裡；頁面注入 API、日期、提示與重畫工具，模組不直接 import `app.js`。改遠端操作時要用假 API 鎖住寫入順序、拒絕刪除、錯誤復原，以及「切頁後不重畫舊頁」。
  - **投資估值操作工作流＝`modules/portfolio-valuation-actions.js`**：CAPE／實質利率載入、五市場訊號與休眠匯率入口、三個設定表單、成功提示與重畫集中在這裡；頁面注入 API、DOM 查找、彈窗與格式工具，模組不直接 import `app.js`。改外部估值載入或設定寫回時要用假 API／假 DOM 鎖住雙來源讀取、失敗退路、表單 payload 與按鈕綁定。
  - **投資說明互動＝`modules/portfolio-info-actions.js`**：總市值、成本、股票／債券／現金／黃金、IB 活動、XIRR 與紀律檢查的唯讀彈窗入口集中在這裡；頁面注入 DOM、彈窗與格式工具，模組不直接 import `app.js`。改彈窗標題、尺寸或內容入口時要用假 DOM 鎖住每個按鈕的對應關係。
  - **投資研究互動＝`modules/portfolio-research-actions.js`**：研究新增／編輯、檢查點新增、POST／PUT、成功提示與重畫集中在這裡；頁面注入 API、DOM、表單、日期與提示工具，模組不直接 import `app.js`。改研究寫入時要用假 API 鎖住既有／新研究分流、payload、空白檢查點與失敗退路。
  - **投資頁拆分停止線**：`portfolio.js` 刻意保留開機資料載入（Promise.all 那一批）、頁面模型／狀態協調、主 HTML 組裝、計價與排序狀態、持股／願望清單刪除綁定、圖表生命週期、各控制器啟動與 A4 報表列印。這些是頁面協調者的合理責任；**不要只為縮短行數繼續拆分**。往後只有責任真正變複雜、能形成獨立契約與考題時才新增模組。
  - **投資顯示格式單一真相＝`modules/portfolio-format.js`**：K／萬／百分比、NT／US 雙計價與 U+2212 負號都由這個零依賴純模組提供；`portfolio.js`、活動卡、A4 報表與折線圖共用。新增投資金額顯示時直接 import，不要另抄 `kNum`／`wanNum`／`fmtPct`；改格式時補固定數字考題並檢查四個使用端。總市值與紀律檢查的說明 HTML 存放在零依賴 `modules/portfolio-info.js`，頁面只接 `openInfo` 事件。休眠中的美元／台幣匯率儀表 HTML 存放在 `portfolio-valuation.js` 的 `fxGaugeHtml`，目前不插入頁面；要恢復時只在 `portfolio.js` 接 DOM 與表單事件，不把 HTML 搬回主流程。

## IB 現金幣別歸零

**改這裡**：**IB 現金幣別歸零**（Codex r4#3）

**記得同步這裡**：**IB 現金幣別歸零**（Codex r4#3）：`syncIb` 對「這次報表沒出現、但過去由 IB 同步建立的現金幣別帳戶」歸零——否則某幣別現金提光後、下次報表不再列它，帳上永久殘留舊餘額、淨資產無聲虛增（實測 USD 1000 提光後仍算 32000 TWD）。⚠️**只在 Cash Report「確實有各幣別明細列」時歸零**（Codex r5#2 收緊，原判準＝區塊存在）：兩種「沒資料」都不可當「現金為 0」——①整個區塊缺失（Flex 漏勾/查詢失敗）→ 保留舊值＋回報 `cashReportMissing`；②區塊在、只有 `BASE_SUMMARY` 彙總列——**這也是合法報表**（Codex r6#1：基準幣別總額本來就住在彙總列，一律當「沒資料」會讓這種設定的現金永遠不更新、首次同步連帳戶都建不出來）→ 基準幣別判定得了（`AccountInformation.currency`）且彙總金額有效＝以「基準幣別彙總現金」**原子取代**全部 IB 現金（其他幣別現金帳戶歸零防重複計算）＋回報 `cashFromSummary`；判定不了＝保留舊值＋回報 `cashDetailMissing`（請在 Flex 勾 Account Information）。⚠️**多 statement 報表整包 400 拒絕**（Codex r6#2；r7#3 訊息分流）：`statementCount>1` 時持倉可能混疊/重複列出、現金與官方淨值只剩最後一份的值——在寫入任何東西之前拒絕；訊息依**去重帳戶數 `accountCount`** 分流（>1＝「多帳戶，請一個 Query 一個帳戶」；=1＝「多份報表（Model-by-Model bundle 之類），請改單一整體報表」——節點數≠帳戶數，話說對使用者才修得對地方）。兩種都拒＝刻意 fail-closed（bundle 的持倉可能整體＋分模型重複列出）。⚠️**彙總入帳的回報語意**（Codex r7#2）：折疊歸零記 `cashCollapsed`（≠`cashZeroed` 的「提領/轉走」語意，前端說不同的話）；基準幣別判定得出但不支援（EUR…）＝`cashBaseUnsupported`；基準幣別齊全、彙總列卻沒有可用金額（Ending Cash 欄缺）＝`cashSummaryMissing`（Codex r8#1）——三者都≠「缺 Account Information」的 `cashDetailMissing`，**病因要各自說對，使用者才修得對地方**。`lib/ib.js parseStatement` 回 `hasCashReport`/`hasCashDetail`/`cashDetailIncomplete`/`baseCurrency`/`baseSummaryCash`/`statementCount`/`accountCount` 供判斷。⚠️**現金金額欄嚴格取值**（Codex r9#1，高）：只認期末欄（`endingCash`→`endingSettledCash`），空字串/null/非數字一律視為「沒有金額」（`Number('')` 是 0——把空白當零會直接清空真實現金）；**絕不拿 `startingCash`（期初）冒充目前現金**；金額讀不到的幣別列＝`cashDetailIncomplete`（讀得到的照更新、讀不到的沿用舊值），**歸零「沒出現的幣別」需要明細完整（`hasCashDetail && !cashDetailIncomplete`）才允許**（已 export 供考題直測——旗標語意屬「中間那棒」，兩端測了中間沒測會漏）。**前端 portfolio.js 同步完成後必須把 `cashReportMissing`/`cashDetailMissing`/`cashFromSummary`(+`cashCollapsed`)/`cashBaseUnsupported`/`cashSummaryMissing`/`cashDetailIncomplete`/`cashZeroed` 都 toast 出來**（Codex r5#7：後端只寫 server console、前端無條件報「同步完成」＝使用者不知道淨值裡的 IB 現金是過期的）；新增同型欄位時前端提示要一起接，別只加後端。

## 多幣別損益

**改這裡**：**多幣別損益**（缺幣別與缺匯率是兩種病）

**記得同步這裡**：**多幣別損益**：換算優先序＝IBKR `pnlBase` → `fxRateToBase` → USD 直通 → 設定匯率估算（需標註）→ 缺匯率不計入（需標註）。不可把非 USD 金額默默當 USD 加總。⚠️ **「缺幣別」與「缺匯率」是兩種病，處置不同（2026-07-28 全域政策，勿再退回）**：上面那條優先序講的是**缺匯率**；**缺幣別一律不猜**——`|| 'USD'` 這種寫法在本 repo 曾長出四份（`ib.js` 現金交易與成交紀錄、`ib-sync.js` 新持股、前端 `portfolio-calculations.js`），後果是 Flex Query 少勾一個 Currency 欄，GBP 100 的股息就被當成 USD 100 加總（少算 27%）且畫面零註記。正確處置＝**有 `fxRateToBase` 就照算（那條與幣別無關）；否則跳過＋分開計數回報**（`income.skippedNoCurrency`／`syncIb` 的 `skippedNoCurrency`），新持股缺幣別**不入庫**（猜錯幣別＝市值/淨資產/上限全錯）；既有持股保住原幣別、數量價格照常更新。**「幣別不支援」與「報表沒給幣別」的訊息必須分開講**，使用者才修得到對的地方。考題＝`test/ib-parser-money.test.js`＋`test/securities-sync.test.js`。**交易損益**（交易摘要＋XIRR）共用 `portfolio-calculations.js tradePnlBase()`，兩處口徑必須一致（否則 XIRR 漏估外幣賣出、年化偏低）。**現金流**（IB 股息/利息）在 `lib/ib.js parseStatement()` 解析時就套同一優先序（`lib/services/ib-sync.js` 依 settings 傳入估算器 `fxToBase`），估算/略過筆數存 `income.estimatedNoFx`/`skippedNoFx`＋幣別，前端與 PDF 都要註記。

## XIRR 資金加權年化

**改這裡**：**XIRR（資金加權年化，台幣）**

**記得同步這裡**：**XIRR（資金加權年化，台幣）**：現金流＝第一筆月快照市值（流出）＋各月快照投入增量（流出）＋IB 賣出已實現損益逐筆按成交日（`tradePnlBase`×usdTwd，流入，與交易摘要同口徑、含設定匯率估算）＋今日市值（流入）。**賣出只用 Δcost 會漏掉已實現損益，必須用 ibTrades 修正**；用估算時 header 標「含匯率估算」。不含股息利息；台股手動賣出未納入；快照未滿 60 天不顯示；|年化|>500% 視為資料異常。實作在 `portfolio-calculations.js portfolioXirr()/xirrRate()`（僅此一份）。快照資料曾含 seed 示範殘留（2026-07-10 已清），**判斷 XIRR 異常先懷疑快照資料**。

## securityTrades 欄位所有權與去重

**改這裡**：`securityTrades`（READONLY，前端只 GET）

**記得同步這裡**：**IB 同步雙寫**（ib-sync：upsert by sourceRef、**永不刪**；與 ibTrades 鏡像同次 saveDb＝原子；一致性＝「同步窗內 ⊆」非相等）＋**台新對帳單匯入**（securities-import：預覽 fail-closed→確認；台新批次可整批刪、IB 批次不可）。sourceRef＝identifier-first 去重鍵（IB：**帳戶指紋＋**transactionID→tradeID→ibExecID→指紋（Codex S2r1#4：IB 未承諾 ID 跨帳戶唯一）；台新：多維指紋**不含對帳單年月**）；IB 缺幣別/核心金額**不猜不入庫**（分原因跳過＋前端指路 Flex 欄位）；`projectSecurityTrade` 剝 sourceAccountId/sourceRef（export 除外）；**指紋類跨批身分＝內容比對＋計數對帳 `reconcileFingerprintRows`（批內序不可當跨批身分——視窗位移覆寫/補印漏記，S2 自審雙 HIGH）**，指紋列入庫不可變、官方列更新＝整列取代；帳戶只存**指紋+遮罩 label**、絕不落原文；金額原幣、netSettlement 絕對值+cashDirection。幣別牆比照持倉/現金（不支援幣別跳過+回報），**手續費幣別 commissionCurrency 也過牆**（Codex S3r2#1，高：漏驗會走到櫃檯枚舉 throw、炸掉整次原子同步——持股/現金全失敗）；核心金額 **price/grossAmount/netSettlement 必填**＋跨欄不變式 **buy→out／sell→in**（`ROW_RULES`：櫃檯 throw/strip＋匯入逐筆 400，Codex S3r2#4——單欄各自合法、合起來會把買進顯示成收錢）。`settings.taishinSecPdfPassword`＝證券 PDF 密碼（使用者 2026-07-23 拍板存本機；機密投影剝除+Set 布林、備份保留）
