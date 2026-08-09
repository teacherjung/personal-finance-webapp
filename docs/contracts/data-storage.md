# 契約：資料與儲存（repo 櫃檯／兩顆引擎／欄位驗證／備份）

> 本檔是 AGENTS.md 拆出的**領域契約**（籃B-2，2026-08-04；路由表原名「資料層與儲存」，William 拍板改名「資料與儲存」）。
> **內文＝AGENTS.md 原文逐字照搬**，轉換僅限三類、對照表在 PR 說明：①表格列解框成「改這裡／記得同步這裡」兩段（同前三科）②鐵則 8 清單項與「驗證要求」段落同樣解框（籃B 新形態）③兩處 tag 佔位符改 {tag}、每日備份的檔名樣式反引號拆寫（契約檔禁角括號；樣式名非實檔、防路徑考題誤抓）。
> **適用檔案清單＝[README.md](README.md) 路由表「資料與儲存」列（單一真相，本頁首不重複維護一份會走散的副本）**——命中就必讀本檔。

## 資料存取單一櫃檯 B1

**改這裡**：**資料存取單一櫃檯（B1）**

**記得同步這裡**：讀寫資料一律走 `lib/repo.js`（getDb/saveDb/getCollection/addItem/updateItem/deleteItem/getSettings/updateSettings；uid/emptyDb 也由它轉供）——**除了 repo.js 自己，任何檔案都不要直接 import `lib/store.js`**。附帶效果要與更新同一次寫檔時用 `updateItem` 的 `beforeSave`（例：帳單交易改分類→寫學習表）。未來換資料庫（B3 SQLite）只改 repo.js。

## repo 介面的新增與修改

**改這裡**：`lib/repo.js` 介面（加函式／改簽名）

**記得同步這裡**：**新函式一律 async**（C4a 契約，鐵則 8）：全部呼叫端 `await`＋handler 包 `wrapRoute`/`asyncRoute`；改完跑 `npm run typecheck`（抓「讀」的漏）＋grep 掃「寫」的 fire-and-forget（tsc 抓不到）；`test/repo-async.test.js` 的簽名鎖與 HTTP 並發考題必須仍綠。**C4b 起還要顧到兩顆引擎**：新的寫入函式要走 `mutate()`（才有 CAS 重試），新的讀取函式要走 `readDb()`（才有規則同步與版本戳）；`test/hosted-store-pg.test.js` 也要仍綠

## 驗證入櫃檯 B3

**改這裡**：**驗證入櫃檯（B3）**

**記得同步這裡**：`store.save()` 是唯一寫入口、每次寫入自動過 `schema.js sanitizeDbForWrite`——枚舉/布林非法值會直接 throw（＝寫入端程式有 bug，考試會抓到），任何新寫入路徑**結構上不可能**繞過驗證牆（七輪審查的病根根治）。新增欄位照舊補 `WRITABLE_FIELDS`/`FIELD_SCHEMA`。

## 日期與月份的真實日曆判準

**改這裡**：**日期／月份走「真實日曆」判準（`isRealMonth`／`isRealDate`，Codex r3#9）**

**記得同步這裡**：`date`/`datereq`/`month`/`monthreq` 四種型別**共用同一套**，不可各寫一份。以前只驗長相（`\d{4}-\d{2}`），`2026-13`／`2026-99-99`／`2026-02-31` 全都過得了關——後果不是崩潰而是**默默算錯**（月份排序把 `2026-13` 排到 `2026-02` 後面、提醒天數、費用攤提、日線的「找最接近的既有日」全偏掉，畫面上卻一切正常）。閏年用 `Date.UTC` 建構回比對（避開本地時區在月初月底的位移）。服務層的手動輸入（`setBatchMonth`、`importRows` 的 `statementMonth`）也一律改用同一個判準。⚠️ 這是**收緊**：萬一舊資料裡真的躺著一個假日期，下次寫入會在櫃檯 throw（訊息已指出集合/索引/值）——那是刻意的，發現了就把那筆改掉，不要為了它把驗證放寬回去。

## 必填欄位機制與跨欄不變式

**改這裡**：**必填欄位機制（`REQUIRED_FIELDS`，目前＝history/portfolioSnapshots/snapshots 的 `month` 主鍵欄＋`dailyValues` 的 `date`＋`securityTrades` 的查帳合約 11 欄——身分/方向/數量/幣別/去重鍵＋三個核心金額 price/grossAmount/netSettlement，Codex S2r1#5＋S3r2#4）**；跨欄位不變式走 **`ROW_RULES`**（同三個強制點；目前＝securityTrades 的 buy→out／sell→in）

**記得同步這裡**：三個強制點——CRUD 新增回乾淨 400、匯入逐筆列 errors→整份 400、櫃檯 throw 模式當場 throw。**strip 模式（舊 JSON 搬家專用）對必填欄位「缺席／空值／格式錯／數字型」一律整筆濾除，不可只刪欄位**（只刪欄位會留下缺主鍵的殘骸，讓讀取端 `.slice`/`.split` 崩，Codex#12）；PUT 部分更新天然安全（合併保留舊值）。新增「不可缺的主鍵欄」時補進 `REQUIRED_FIELDS`。

## HOSTED 並行安全 CAS

**改這裡**：**HOSTED 的並行安全＝compare-and-swap（C4b，契約 P1-5）**

**記得同步這裡**：兩條寫入路徑處置不同、刻意的：**櫃檯自己的五支**（`addItem`/`updateItem`/`deleteItem`/`replaceCollection`/`updateSettings`）改動邏輯在櫃檯手上，撞版本時**重讀重做重寫一次**、呼叫端無感；**`getDb…saveDb` 這一對**改動邏輯在呼叫端的記憶體物件裡，櫃檯**沒有能力重算**，直接丟 **409**（`server.js` 有專屬分支回原味訊息，不走「請求格式不正確」）。假裝重試＝拿舊快照再寫一次＝把別人剛寫的吃掉，比 409 危險得多。**`saveDb` 對「沒有版本戳的整包寫入」預設 throw**，只有 `/api/import` 明寫 `{ overwrite: true, from: snapshot }` 才准（全 repo 僅此一處）。⚠️**`from` 必須是呼叫端讀資料時那一次 `getDb()` 的結果**（2026-07-29 契約，Codex 收官審查 #2）——它同時是「機密的來源」與「版本戳的來源」，兩者**必須是同一次讀取**。舊行為是「寫入前一刻自己重抓一次目前版本」＝**自己蓋章給自己看**：CAS 只保護「重抓」到「寫入」那一瞬間，而真正要保護的是「呼叫端讀資料」到「寫入」的整段。已重現：A 分頁還原備份的同時 B 分頁存了新的 IB token → CAS 照樣通過 → 新 token 被舊值蓋掉、**而且回 200 說成功**。拿不出 `from` 一律 throw（`kv_no_version`），讓「無來源版本的整包覆蓋」在櫃檯上根本不存在；`store-pg.js` 的 `currentVersions()` 已**移除**（它的存在本身就是那個 bug，原地留墓誌銘說明不要加回來）。考題 `test/hosted-import-overwrite.test.js`（三種並發方各一題＋架構題釘死「只准一個入口、而且一定要帶 `from`」）。

## HOSTED 資料層與測試替身

**改這裡**：**HOSTED 資料層**（`lib/store-pg.js`／`db/supabase-schema.sql`／RLS 政策）

**記得同步這裡**：兩邊是同一份語意的兩種寫法：`kv_save` 的 CAS 規則改了，`test-doubles/fake-supabase.js` 的 `saveAs` 要同步改（否則考題全綠、正式環境壞）。政策形狀（`FOR ALL`＋`USING`＋`WITH CHECK`＋`force RLS`＋service_role 無權限）有靜態考題盯著。**改完 SQL 要到 Supabase Dashboard 重跑一次**——那是唯一的部署方式

## kv 的鍵

**改這裡**：**kv 的鍵**（`lib/store.js` 的 `KV_KEYS`／`KV_MAP_KEYS`；`emptyDb()` 加頂層欄位時）

**記得同步這裡**：三處一起：①`KV_KEYS`＋`KV_MAP_KEYS`（漏了那個鍵**永遠寫不進 db 且不報錯**）②`lib/types.js` 的 typedef ③**`db/supabase-schema.sql` 不必改**（kv 是 key/value，加鍵不用改 DDL）——但 `test/hosted-store-pg.test.js` 有「KV_KEYS 長度」的絆索會紅，那是提醒你回來讀這一列。⚠️ `lib/store-pg.js` **必須從 store.js import** 這兩個常數，不可以自己抄一份

## 本機檔案操作一律經櫃檯

**改這裡**：本機檔案操作一律經櫃檯（`backupNow`/`snapshotTo`/`dataDir`，維持同步簽名）

**記得同步這裡**：HOSTED 下 `backupNow` 回 `false`、另兩支 throw。理由不是潔癖——HOSTED 碰到它們會憑空建出一顆空的本機 SQLite，而空庫會被 `data/seed.json` 種底稿，於是「今天的備份」內容是 demo 假帳本、畫面卻顯示已備份。架構考題釘死「只有 `repo.js` 與 `store-pg.js` 能 import `store.js`」。

## 每日滾動備份

**改這裡**：每日滾動備份（階段四 A，2026-07-27 上線）

**記得同步這裡**：三種備份共用 `store.js snapshotTo(dest)`（VACUUM INTO→.tmp→原子改名；失敗丟例外＋清 .tmp）：啟動 `.bak`＝每行程一顆／操作前 `{tag}.bak`＝backupNow（**函式還在、正式操作路徑零呼叫**，見下一節的裁決）／**每日 `data/backups/` 底下的 store-YYYY-MM-DD.db＝`lib/services/backup.js dailyBackupIfDue`，保留 30 天**。開 app 由 `POST /api/backup/daily`（日期用 snapshot.js `nowLocal()`，勿另算）觸發；同日已備且檔案還在＝跳過，檔案被刪＝補做。**失敗不擋 app**：不寫 `lastBackupDate`（今天才會重試）、`backupFailStreak` 累積、前端 `backup-alert.js` 畫面警告（≥3 次升 danger；**成功與抓不到回應絕不可出警告**——誤報會讓使用者學會忽略）。清理只認 `store-YYYY-MM-DD.db` 樣式＝正式庫絕不會被誤刪；先備份後清理。狀態欄位（lastBackupDate/backupFailStreak/backupLastError/backupLastErrorAt）＝**服務層擁有**（同 storeRulesHash：路由白名單擋前端寫、櫃檯放行、匯入備份被剝＝還原後當天自動重備）。**宣稱範圍（裁決）**：只防誤刪/錯誤匯入/程式寫壞，不防硬碟損壞；離開本機的備份等加密格式＋明確同意（DB 含明文 token/密碼）。考題 `test/daily-backup.test.js`（裁決五條全蓋）＋`test/backup-alert.test.js`。

## 不可逆整批操作刻意沒有操作前備份

**改這裡**：**不可逆整批操作「刻意沒有」操作前備份**（William 2026-08-08 裁決）

**記得同步這裡**：**現況＝使用者觸發的不可逆整批操作前，沒有這一層備份**。`saveStoreRules`（店名規則儲存）與 `normalizeBranches`（開 app 自動整理）**直接動手**：不產生 `pre-rules`／`pre-normalize` 備份、不擋、不問；畫面只寫「儲存後沒有「復原」可以按」，不承諾任何自動還原檔。低階的 `lib/store.js` `backupNow(tag)` → `data/store.db.{tag}.bak`（VACUUM INTO＋原子替換，`lib/repo.js` 照櫃檯慣例轉供）**函式本身保留**，但**正式操作路徑零呼叫**——它沒有錯，只是沒有使用端；要接新用途之前先讀本節與 `lib/services/backup.js` 檔中的裁決註解。⚠️ **誠實劃界：這條裁決管的是「使用者按下去的整批操作」，不含開庫時的一次性 schema 搬家**——`migrateLedgerIfNeeded`（`pre-ledger-migration.bak`）與證券合約收緊（`pre-sec-contract.bak`）仍各自在動手前寫一顆（兩者都在 `lib/store.js`、各跑一次、不是使用者觸發的），別把本節讀成「repo 裡再也沒有任何 pre-* 備份」。**使用者的救援手段**（都還在）：①每日滾動備份 30 天②自己按的「匯出備份」③啟動 `.bak`。**代價（拍板接受）**：救援粒度從「按下去的前一秒」退成「今天第一次開 app」。⚠️ **想補回來之前先問 William**——`test/vault-and-backup-integrity.test.js` 有一題（⭐ 裁決｜…不得再長出「操作前自動備份」）會擋住任何順手加回的呼叫、旗標與文案承諾。**新增其他使用者觸發的不可逆整批操作時，照這條裁決辦：不要順手配一顆備份。**

〔**沿革（歷史，不是現況）**——留著是為了讓後來的人知道「那是拿掉的，不是漏掉的」：這一層原名「不可逆整批操作前的真備份 `backupNow(tag)`」（Codex r3#7），曾有兩個呼叫點＝`saveStoreRules` 的 `pre-rules` 與 `normalizeBranches` 實際套用時的 `pre-normalize`，理由是啟動備份 `.bak` 每個行程只寫一次（`backedUp` 旗標），對「一天內做了好幾次整批操作」毫無保護力。2026-08-06 之前備份失敗只 `console.warn`、照樣往下做＝畫面仍顯示「儲存成功」；2026-08-06 改成擋下＋確認（`backupBeforeIrreversible`＋`needsConfirmation:'backup_failed'`＋`proceedWithoutBackup` 旗標＋三處文案）；2026-08-08 William 讀完完整拆解後裁決**整層移除**——理由是「那層網會自己失敗，而為了誠實交代它，一個單純的操作長出兩個確認框與三處說明」。08-06 另為它做過一支 `backupSupported()`（分開「本機真失敗」與「HOSTED 本來就沒有」兩種 `false`）——那個判斷本身沒有錯，但唯一使用端隨閘門一起消失，2026-08-09 依「沒用到的程式直接刪」刪掉（Codex #422 r1 指出它是零呼叫的遺留 API）；那條判準的**理由**留在這段沿革裡，真要再做同型能力時連同使用端、契約、考題一起加回來。`*.bak` 已被 .gitignore 全域排除。〕

## 測試隔離慣例 B0

**改這裡**：**測試隔離慣例（B0）**

**記得同步這裡**：`lib/store.js` 的資料檔路徑可用 `STORE_FILE` 環境變數覆寫（測試一律指到 os 暫存目錄的 `.db` 檔、絕不碰真實 `data/`）；`server.js` `export const app`、只有直接執行才 `listen`（測試 import app 後在隨機埠自行監聽）——`test/server.test.js` 是階段 B 改建的行為安全網，改後端端點要保持它全過。
