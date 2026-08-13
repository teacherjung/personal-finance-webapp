# 契約：前端功能（訂閱／月度回顧卡／洞察書籤／日期解析）

> 本檔是 AGENTS.md「同步點清單」拆出的**領域契約**（D4a 試點，2026-07-31）。
> **內文＝AGENTS 原文逐字照搬**（表格列解框成「改這裡／記得同步這裡」兩段；2026-08-04 籃C 起，同步點表以外的段落與清單同樣逐字、掛在同兩個標籤下）；新增的只有標題、標籤與本頁首。
> **適用檔案清單＝[README.md](README.md) 路由表「前端功能」列（單一真相，本頁首不重複維護一份會走散的副本）**——命中就必讀本檔。

## 月度回顧總覽卡

**改這裡**：月度回顧總覽卡

**記得同步這裡**：`public/modules/monthly-review-card.js` 是零 DOM／零 API 的純呈現層，`dashboard.js` 只負責抓 `GET /api/monthly-review`、掛 info-link 與 Chart.js。**前端不得重算消費、退款、分類百分比或現金流**，全部照 API 結果顯示。點長條切月份時要同時守 `currentRouteSeq()` 與 request 序號；完成或失敗都要解除 `#monthlyReviewBlock[aria-busy]`，避免慢回應蓋新月份或整張卡永久鎖住。

## 訂閱續費日自動推進

**改這裡**：**訂閱續費日自動推進**（使用者定 2026-07-26）

**記得同步這裡**：`nextCharge` 是使用者手填的固定日期、不會自己走——日期一過那筆就從續費時間線（只畫未來 30 天）消失（使用者實測 26 筆有 5 筆卡在過去）。**開 app 每次都會把過期的續費日推到下一期**：判準與新日期＝`subscriptions-model.js rolledNextCharge()`（純函式、有考題），寫入＝`lib/services/subscriptions.js rollDueSubscriptions(todayIso)`，掛在 `snapshot.js takeSnapshotIfDue()`（＝既有的「開 app 每日維護」入口，回傳多一個 `subsRolled`；**刻意不改 `lib/routes/core.js`**——沿用既有入口就不必動路由；`public/app.js` 則**必須改**：推進成功要重繪，見下）。**月底錨點 `chargeAnchorDay`**（服務層擁有的欄位，Codex 複審 2026-07-26）：推進用「原本約定的號數」算，不是拿收月底後的結果再加——1/31 推成 2/28 後，下個月若從 28 起算會變 3/28、一路縮回不來。**使用者一改 `nextCharge`（CRUD PUT）＝新舊值真的不同時，後端才把錨點換成新日期的號數；清空日期一併清錨點**（`lib/routes/crud.js` 的 subscriptions beforeSave，用 `prev` 比新舊值）——⚠️ **不可只看「請求有沒有帶 nextCharge」**：訂閱表單每次儲存都回送整份資料（含沒改的日期），只看「有帶」會讓「只改信箱」也把錨點蓋成當下日期的號數（2/28→28），下個月又縮成 3/28（Codex 複審 2026-07-26 第二輪實測）——⚠️ 只靠「錨點對不對得上現在的日期」推斷**不夠**：1/31 的錨點 31 遇到使用者手動改成 4/30 時 `min(31,30)=30` 剛好對得上、舊錨點會復活，下個月變 5/31（Codex 複審 2026-07-26 實測；使用者選的是 30 號）。`chargeAnchorDay` **不在 CRUD 白名單**，前端送不進來，只由該處與自動推進服務寫（HTTP 全鏈路考題在 `test/server.test.js`）。**不推的情況**：終身、已停用／已結束、**使用者手動填了停用日或標成即將停用**（使用者原話「除非我手動輸入停用日」）、沒有合法續費日、日期還沒到（含今天）。逾期多期＝一次推到「第一個未來日期」，不補記過去每一期（本 app 不記錄過去的扣款）。⚠️ **只動日期、不動任何金額**：攤提看 `since/endsOn/amount/cycle`，與 `nextCharge` 無關（考題直接比對推進前後每月 `costForMonth` 與總覽訂閱月費）。⚠️ 月底錨定：每期都從**原始日期**加 N 個月，否則 1/31 會一路縮成 28 號。沒有任何一筆要推就**不寫檔**。**推進後前端要重繪**（`app.js` 依 `subsRolled.length` 觸發 `router()`＋toast）——今天已記過快照、報價也還新鮮時，原本兩個重繪條件都不成立，訂閱頁會停在舊日期直到切頁（Codex 複審 2026-07-26）。時鐘倒退時整段每日維護已被既有護欄擋掉，這裡自然也不跑。⚠️ 對應的**過期提醒（`derive.js`）2026-07-26 拿掉「只提醒 30 天內」的下限**——原本過期超過 30 天就同時從時間線與提醒牆消失＝愈久沒處理愈安靜；現在自動推進處理常態、提醒當推不動時（時鐘倒退／每日維護沒跑到）的安全網。

## 訂閱本月攤提

**改這裡**：訂閱本月攤提（停用當月月繳不計、季/年繳按天數比例）

**記得同步這裡**：`subscriptions-model.js costForMonth()`（零依賴純模組，階段二②自 subscriptions.js 搬出）↔ `lib/derive.js subCostForMonth()`（buildSummary「本月固定訂閱」＋`avgMonthlyExpense` 無歷史時的緊急預備金 fallback 都用它），三處口徑要一致；一致性由 `test/subscriptions-model.test.js` **前後端對照考題**鎖住。**契約範圍＝通過 schema 的合法訂閱資料**（走散點結案 2026-07-24：①缺 since 兩邊同退 `RECORD_START` 地板——**單一真相＝subscriptions-model.js 的常數、derive.js 直接 import**，勿另抄一份；②月份型 endsOn＝非法輸入，由 CRUD/匯入/櫃檯三強制點拒絕＝邊界考題鎖住，公式不為進不來的輸入定義行為）；**勿在任何訂閱加總改回 `filter(active!==false)+monthlyCost`（會把已停用訂閱算進去）**

## 訂閱狀態

**改這裡**：訂閱狀態（使用中/即將停用/已停用）

**記得同步這裡**：前端 `subscriptions.js subStatus()` ↔ 後端 `lib/derive.js subActive()`（buildSummary 訂閱**項數**用它，只算未停用；否則總覽與訂閱頁項數打架）。判斷靠 `daysUntil(endsOn)`，兩份口徑要一致

## YYYY-MM-DD 日期解析

**改這裡**：YYYY-MM-DD 日期解析

**記得同步這裡**：前端 `app.js parseLocalDate` ↔ 後端 `derive.js parseLocalDate`（各一份）：一律用**本地時區**拆日期，`new Date('YYYY-MM-DD')` 會被當 UTC，在 UTC 以西時區差一天（月份/提醒天數/星期全錯）。`daysUntil`/`monthKey`/`formatDateWithWeekday` 都走它

## 每日洞察引擎書籤 insightState

**改這裡**：**每日洞察引擎書籤 `insightState`＋差異引擎**（D3，2026-07-22）

**記得同步這裡**：`lib/services/insights.js getInsights()` 是唯一寫入口，`GET /api/insights` 呼叫它——**讀取＝視為「看過了」→ 當下更新書籤**（有寫檔副作用，故只有總覽呼叫）。差異＝現在 vs 書籤：🆕新出現/✓已解除（留 title 供顯示）/持續中、跳檔（估值檔位 0/1/2，**null↔值不算跳**）、自上次 Δ、固定窗 Δ（今天/本週，從 `dailyValues` 找最接近既有日、不足不顯示）、平靜判定（無🆕/✓/跳檔且今日Δ% 的絕對值小於 0.3%）。**首次執行（空書籤）全當持續中、不標🆕**——「有效書籤」需**同時有 `lastSeenAt`(字串)＋`reminders`(陣列)**（缺任一＝退回首次，免殘缺書籤把當下每條都謊報🆕，D3 自審#2/#5）。⚠️**新增/改提醒（`derive.js`）鐵律**：**同一顧慮的升級必須共用同一把 key**（如訂閱/保險「將至」→「已過」都用 `sub-charge-{id}`／`ins-pay-{id}`，不可拆 `-overdue-`；差異引擎純比 key，拆 key 會在升級當下把仍在惡化的顧慮謊報成「✓已解除 👍」＋🆕，保險漏繳是 danger＝生存級，D3 自審#1）——比照 `card-due-{id}` info→warn 同 key。固定窗 Δ% 用 **abs(基期)**（淨值為負時方向才不反轉，D3 自審#4）；基期 0 但有變動＝不平靜（D3 自審#3）。⚠️**read-await-write**：先 await 報價（`getCape`/`getRealYield` 算 ECY，失敗靜默 null）、**await 之後才 `getDb`→算→`saveDb`**（同 D1/syncIb r3#1）。`insightState` 是**頂層 map 型鍵**：`lib/store.js` 的 **`KV_KEYS` 與 `KV_MAP_KEYS` 都要有它**（漏了 save 不寫、靜默丟失，實測踩到）＋`schema.js sanitizeInsightState`（接進 sanitizeDbForWrite，防壞形狀）＋`emptyDb`＋`types.js InsightState`。服務層專寫、非 CRUD 白名單。

## async render 與路由序號 guard

**改這裡**：**async render 寫 `#view` 前要 guard 序號**（Codex r10#6）

**記得同步這裡**：⚠️ **async render 寫 `#view` 前要 guard 序號**（Codex r10#6）：render 一進場 `const seq = currentRouteSeq()`，`await` 完、**動任何 DOM/圖表（含 `destroyCharts`）之前**先 `if (seq !== currentRouteSeq()) return;`——不然快速切頁時慢頁 resolve 會蓋掉新頁（router 的事後檢查太晚，寫入發生在 render 內部）。有遞迴重載（如 `renderSubscriptions` 的 autoExpire）也要在遞迴分支前 guard。**表單儲存後的重畫也必須先確認仍在原路由**，不可把裸的 `renderXxx` 傳給 async action；同一頁可同時啟動多代 render 時，再加頁面 generation，外部資料晚回來只能寫入目前 generation 的容器。

## 淨值目標與到達速度

**改這裡**：淨值目標與到達速度

**記得同步這裡**：後端單一真相＝`lib/derive.js computeGoalTracking(db, now)`，由 `buildSummary.goalTrack` 供前端顯示，**前端不可重算**。目標 `settings.netWorthTarget` 以台幣元保存（設定頁 P2 用萬元輸入），只收正數或 `null`。兩把尺都只看最近六個**已結束月**、至少三個月份、取中位數：①現金結餘只收 cashflow 帳本的 income−expense（card／transfer 排除）；②整體淨值變化用 snapshots，相鄰缺月要除以實際相隔月數，且文案須說含市場、匯率與帳戶更新。速度≤0 不算負月數／Infinity；資料不足仍顯示進度。達標除了在目標區顯示，也由 `computeReminders` 產生穩定 key `goal-reached`、`level:'info'` 的報喜事件：新聞牆第一次標 🆕、之後收進持續中，不另改 `insightState`。

## 時鐘倒退保護

**改這裡**：**時鐘倒退保護**（Codex r3#8，中）

**記得同步這裡**：`lib/services/snapshot.js` 的 `clockWentBackwards`：現在的日期比「資料庫裡最新的一天」（`dailyValues` ∪ `snapshots`）還早 → **不寫**。因為「同日覆寫／同月覆蓋」會拿舊資料蓋掉更新的歷史，而歷史補不回來（電腦時間被手動改、時區設錯、VM 還原都會踩到）。分流：**自動流程（開 app）安靜略過**＋console 警告、回 `skipped`；**手動按鈕明確 throw 400 並說明**（使用者主動按的動作要看得見，他才有機會去修系統時間）。另：`nowLocal()` **整個流程只擷取一次時間**，避免跨午夜時「判斷該不該寫」與「實際寫哪一天」對不上。

## 淨值日線 dailyValues

**改這裡**：**淨值日線 `dailyValues`**（D0，每日洞察引擎的地基；使用者定 2026-07-19）

**記得同步這裡**：`lib/services/snapshot.js recordDailyValue()` 是**唯一寫入口**（開 app 的 `POST /api/snapshot/auto` 每次都呼叫）。與月快照的關鍵差別＝**同日覆寫、跨日累積**（月快照是同月覆蓋，手上永遠只有每月一個點，連「今天 vs 昨天」都算不出來）；**月快照跳過不代表日線跳過**——同日資產有變動時日線要跟得上，所以 `takeSnapshotIfDue` 先寫日線再判月快照。欄位＝`date`(YYYY-MM-DD 主鍵，**必填**)/`netWorth`/`assets`/`liabilities`/`pfCost`/`pfValue`/**`usdTwd`＋`gbpTwd`＋`jpyTwd`**（三種匯率都留底才分得出「淨值變動」是資產本身動了還是匯率動了——系統支援 USD/GBP/JPY 三種外幣，只留美元等於解讀不了另外兩種；Codex r3#10）。`date` 用新的 **`datereq`** 型別（`monthreq` 的日級雙胞胎：空值/壞格式都當壞資料拒絕）＋進 `REQUIRED_FIELDS`——壞 date 會讓差異引擎的排序與「找最接近的既有日」錯亂，比沒資料更糟。集合列在 `READONLY_COLLECTIONS`（前端唯讀、`GET /api/dailyValues` 自動生效，無 CRUD 寫入）。一天一行永久保留（一年 365 行，SQLite 無壓力）。改欄位時同步 `lib/types.js` 的 `DailyValue`＋`lib/store.js emptyDb()`＋`data/seed.json`＋`test/daily-values.test.js`

## 共用彈窗契約

**改這裡**：**共用彈窗契約**（modal-shell.js 的邊界）

**記得同步這裡**：**共用彈窗契約**（modal-shell.js 的邊界）：只共用**尺寸、標題列、關閉按鈕、背景與基本關閉行為**；送出、預覽、返回、非同步狀態與重畫流程**由各功能自行負責**。**#modal-root 世代擁有權（r6→r9）**：全站表單/彈窗共用同一格 `#modal-root`——表單 `onSubmit` 有 await，回來時可能 (1) 使用者已換頁、或 (2) 期間開了新彈窗，舊的成功 continuation 若無條件 `close()` 會清掉**後開的**彈窗、毀掉未存輸入；舊的失敗會在新頁報過期錯誤。`owns()` 用**兩個判準**界定「還擁有這一格」：**世代章**（每次 `claimModalRoot()` 蓋新章；`owns.release()` 撤銷）＋**換頁序號**（claim 當下記住 `currentNavSeq()`，使用者真的換頁才作廢）。⚠️ **`openForm` 的兩個可選參數（P1b-2，2026-08-12）**：`bodyHtml`＝表單欄位**之前**的說明段落，語意同 `openInfo`＝**受信任的作者內容、不 esc**（要插使用者資料的呼叫端自己在來源模組 `esc`，`aiConsentBodyHtml` 就是）；`submitLabel`＝送出鈕文字（走 `esc`）。**不新增開窗寫入點**——`EXPECTED_OPEN_WRITES` 與 `OPENERS` 不動。⚠️ **`openInfo` 的 `opts.actionsHtml`（P1b-2，2026-08-12）**＝底部動作列要多放的按鈕 HTML，插在「了解」**右邊**（主要動作在最右＝一般慣例）；語意同 `bodyHtml`＝**受信任的作者內容、不 esc**。給了 `actionsHtml` 才會多套 `.form-actions.sticky-actions`＝**動作列貼在窗底、不隨內容捲走**——`.modal` 是 `max-height:90vh; overflow-y:auto`，長預覽（帳戶表＋整份交易明細）若沒有這條，確認鈕會沉在捲動內容的最底。⚠️ 這條 CSS 有**踩過的坑**：`bottom` 必須是 `0`、下邊距**不可為負**（sticky 對齊的是含邊距的框，負的下邊距會把停靠點推到窗底外面——實測按鈕仍滑出 8px；左右負邊距做滿版沒問題），考題 `test/ai-consent.test.js` 已把這兩點釘死。**不新增開窗寫入點**——`EXPECTED_OPEN_WRITES` 與 `OPENERS` 不動。⚠️ 刻意**不加 `onCancel`**：取消／×／背景三條路都走 `close()`＝撤銷擁有權，要在取消後留訊息就得在**開窗之前**先 toast（⚠️ 別再拿 `runAiFallback` 當例子——2026-08-12 William 裁示後它**刻意連 toast 都不發**，考題禁止它再收 `notify`）。

⚠️⚠️ **兩個序號不可混用（r9 用兩個真實 bug 換來的）**：`currentRouteSeq()`＝**重繪世代**，`router()` 每跑一次就前進（含同一頁重繪），用途是「我算完的東西還該不該寫進 `#view`」；`currentNavSeq()`＝**換頁世代**，只有**使用者眼前的網址（完整 hash）**改變才前進，用途是「使用者還在同一頁嗎」。⚠️ 鑰匙用完整 hash 而不是去掉 query 的 route：個股研究頁的身分本來就含 query（`#stock?symbol=AAPL&tab=…`），只比 route 的話「從 AAPL 上一頁跳到 GOOGL」不算換頁，AAPL 表單的舊 continuation 會在 GOOGL 畫面上關窗／報錯（Codex r10 抓到）。用完整 hash 反而更單純：背景重繪不會動到網址，原本要防的「同頁重繪不可誤判成換頁」照樣成立。`router()` 的呼叫點裡**只有 hashchange 是真換頁**（刻意不寫死有幾個——鐵則 10）——開機報價更新／自動快照／帳戶改名對齊／店名規則整理／刪除後重繪都在**同一頁**呼叫它，而 `router()` **根本不碰 `#modal-root`**（彈窗還在畫面上）。拿重繪序號當「換頁」用會出兩種事：①彈窗擁有權被誤撤 → **存檔成功卻不關窗、儲存鈕永遠灰**（r7 自己種的）；②匯入流程 `onPage` 變 false → **密碼窗靜靜不開**，使用者上傳完加密帳單什麼都沒發生（P0.5 頭號功能）。所以彈窗擁有權、匯入流程的 `onPage`／`bankUploadGate`／`runCardUpload`、設定頁的「全部清除帳單密碼」一律吃 `currentNavSeq`；各頁 renderer 寫 DOM 前的自主體檢維持 `currentRouteSeq`。**逐點判準**：這一行問的是「該不該寫進 `#view`」（留 `routeSeq`）還是「使用者還在不在這一頁」（用 `navSeq`）；兩者混在同一個函式裡時要拆開。⚠️ **誠實劃界**：`assets.js`／`cards.js`／`insurance.js`／`portfolio.js`／`securities.js`／`subscriptions.js` 還有一批「問還在不在原頁卻用 `routeSeq`」的既有消費點（origin/main 就有、非 P0.5 種的），列在候選 8-17，本契約不保證它們。

**開窗前後還有 await 的兩種情況，各有專用把手（r16／r18，都是實際踩到的產線競態）**：
- **開窗之前**還要等（先問 `/api/mode` 再開密碼窗、先載卡片名單再開上傳窗）→ 用**唯讀**的 `watchModalRoot()`：只回報「從我看的那一刻起沒人接管／撤銷這一格、也沒換頁」。⚠️ 這裡**不可**用 `claimModalRoot()`——那會把當下開著的那個窗的擁有權**搶走**，它之後連自己都關不掉（＝r7 那顆「存檔成功卻不關窗、儲存鈕永遠灰」）。
- **送出之後**再開下一窗（密碼窗送出→等 preview→開預覽窗）→ 用 `onSubmit(out, ctx)` 拿到的 `ctx.owns.handoff()`。⚠️ 這裡**不可**用 `owns()` 或 `watchModalRoot()`：正常交接本來就會蓋兩次章（自己 `close` 時 `release`、下一窗 `claim`），用那兩個判會把**正常流程整個誤擋**。`handoff()` 只放行**兩種**狀態：①還是我的（還沒關，例如剛在 `onSubmit` 裡排程）②就是我**送出成功那次**關窗之後的章。其餘一律擋：**使用者按 ×／取消／背景關窗＝撤銷不是交接**（r20：他都把窗關掉了，在途 preview 回來還彈下一窗＝把他剛丟掉的東西又推回他面前）、章比那更新＝別人接管了、以及我根本沒 `release` 成功（早被搶走）。所以 `openForm` 的兩種關窗**必須分開**：`close`（使用者撤銷）走 `owns.release()`、`closeAfterSubmit`（送出成功）走 `owns.release({ handoff: true })`；`release` 的 `handoff` **預設 false**＝沒指名就當撤銷（保守預設：新呼叫端忘了指名時，寧可少開一個窗）。判準寫在 `modal-ownership.js`（純邏輯有考題）。**P0.5 的七個排窗點**一律組成 `canOpenNext = () => onPage() && ctx.owns.handoff()` 再交給 `openWhenOnPage`；⚠️ **誠實劃界**：`securities.js` 的預覽窗與 `transactions-import.js` 整批改卡後的管理窗是 `origin/main` 就有的同型排窗點、**還沒接**（候選 8-16）。

規則：**任何直接把 `modal-bg` 外殼寫進 `#modal-root` 的開窗點，都要在那次寫入之前 `claimModalRoot()`**（中央外殼 `app.js` 的 `openForm`／`openInfo`、`modal-shell.js` 的 `openModalShell` 內部已 claim；手刻的 `assets.js` 再平衡／目標配置、`settings-store-rules.js` 規則預覽也各自 claim）；**關窗即 `owns.release()`**——`release` 是**有主才撤**，舊窗的 close 若已不是主人就不准蓋章，否則會把後開那個窗的擁有權一起洗掉；`openForm` 的 async `onSubmit` 只在 `owns()` 為真時才 `close()`／`toast`。純邏輯在 `public/modules/modal-ownership.js`（`makeModalOwnership`，零依賴可測），考題＝`test/modal-ownership.test.js`（世代／有主才撤／**同頁重繪不撤銷、真換頁才失效**行為題＋接線形狀題＋**關門題**）。關門題的掃法是四輪審查改出來的，**它守得住什麼、守不住什麼要照實說**（誇大比缺口更糟）：**守得住**＝①**開窗寫入點的總數被釘住**（`EXPECTED_OPEN_WRITES`）——**偵測面內**不管新開窗點寫成哪種形狀（頂層函式／箭頭／物件方法／class 方法／巢狀）、用哪種引號、用 `innerHTML` 或 `insertAdjacentHTML`，多一個就轉紅，逼人來登記並補 claim；⚠️ **偵測面＝原始碼裡直接看得到 `class=…modal-bg`**，動態組字串（`'modal-' + 'bg'`）、用變數帶 class 名、`className` 指派、或 `public/` 以外開的窗**都在偵測面外**（r16）；②點名表上六個開窗點的「claim 在寫入之前」（名字錨定，改名或拿掉 claim 都會紅——r10：否則 `openInfo` 的 claim 會被 `openForm` 代打）；③頂層函式與**頂層箭頭函式**的新開窗點（r12）。**守不住（已知盲點，r14 實測）**＝段落只依**頂層**大括號深度切，所以物件字面值／class 裡的兩個方法、或同一外層函式裡的兩個巢狀函式會共用一段，前一個的 claim 會替後一個未 claim 的開窗背書（attribution 會錯，但**總數那題仍會先轉紅**）。真正的解法是 AST 依函式節點掃、或把 `#modal-root` 收斂成唯一寫入 API＝**候選 8-16**；在那之前**不可**宣稱「逐函式切段」這種撐不住的保證。掃描器本身也有考題（合成原始碼直測），並在深度收不平時**大聲失敗**——它是保證的承重點，假綠的話上面兩題都守不到東西。⚠️ **誠實劃界**：手刻彈窗裡「await 回來才動 UI」的 continuation 尚未驗擁有權（候選 8-16），那是 origin/main 就有的既存缺陷，不在本契約保證範圍。
