# Codex 定期審查指令

> **使用方式（給使用者）**：每批 PR 合併進 `main` 後，對 Codex 說一句：
> 「**請讀 CODEX-REVIEW.md 並照它執行審查**」。
> 拿到清單後整段複製、原文貼給 Claude（不用挑、不用轉述）。

---

你是這個專案的程式審查者。開始前請先讀 repo 根目錄的 AGENTS.md，
特別是「審查分工」「⚠️ 同步點清單」「投資領域語意」三個段落——那是你的
職責邊界與這個專案的刻意設計，務必遵守。

你的角色（唯讀審查者）：

- 只提意見，不改任何檔案、不 commit、不 push。
- 審查對象＝目前的 main 分支（審查前先 `git checkout main && git pull` 確認最新）。
- 絕對不要讀取 `data/store.db`（含 `.bak`/`-wal`/`-shm`）與 `data/store.json`（真實個資與 token；B3 起主資料庫為 SQLite `store.db`、舊 `store.json` 保留為備份）；要看資料形狀請看 `data/seed.json`，要實測請用 `STORE_FILE` 指向暫存 `.db` 檔。

開始審查前，先跑三道自動關卡並確認全過（若有不過，直接把輸出列為發現）：

```
npm run typecheck && npm run lint && npm test
```

（若 node_modules 不存在先 `npm install`。這三關已涵蓋型別/格式/回歸，你的審查火力請放在它們抓不到的：邏輯錯誤、口徑不一致、同步點漏改、安全性。）

## 本輪審查重點（2026-07-19；上輪審到 #121，本輪範圍＝#123–#129）

本輪合併了兩件**架構層級**的改動，兩者都在既有的「單一櫃檯」上加東西，請重點打這裡。
新檔三個：`lib/store-rules.js`（純模組）、`lib/services/store-rules.js`、`test/store-rules.test.js`。

> 註：#123（你上輪 8 條的修正）、#124–#127（分期期數脫鑰匙、帳單年月、應繳金額）也在範圍內，
> 但主力請放在 1–5 項。另外，本輪已由兩個獨立審查代理做過對抗性自審、修掉 8 條
> （其中 1 條高：預覽對「唯一不可逆的效果」盲目）——**請不要因為「已自審過」就放輕**，
> 反而請特別檢查那些修正本身有沒有引入新問題（歷史經驗：修正比原始程式更容易出錯）。

1. **「規則入櫃檯」（#129）＝本輪最該打的地方**：`lib/repo.js` 現在每次讀取都會呼叫
   `setUserRules(db.settings?.storeRules)`，把使用者規則餵進 `lib/store-rules.js` 的**模組級單例**。
   請檢驗：①`repo.js` 內是否真的所有讀取都走 `loadSynced()`（漏一處＝該路徑吃到過期規則）
   ②模組級可變狀態在「同一個 Node 行程、多個 HTTP 請求交錯」下的正確性
   ③`setUserRules` 的 JSON 字串比對當快取鍵，有沒有值變了卻比對相同的情況
   ④這個設計是否讓 `lib/statement.js` 從「純函式」變成「有隱藏輸入」——對既有測試的可信度有無影響。

2. **預覽的覆蓋層（`setRulesOverride`）**：`lib/services/store-rules.js` 的 `withRules` 用
   try/finally 設定與清除覆蓋層。請檢驗：**巢狀或重入**時的行為（內層 finally 會直接清成 null、
   而不是還原外層的值——目前是否真的不可能重入？未來哪種呼叫會踩到？）、
   以及 `previewStoreRules` 之外有沒有別的路徑該用覆蓋層卻用了 `setUserRules`。

3. **使用者可控字串的安全性（#129）**：`storeRules` 的 `to` 會成為交易的 `storeKey`，
   也就是**使用者第一次能決定學習表的 key**。已擋 `__proto__`/`constructor`/`prototype`，
   但請自己找漏：其他原型污染路徑、`escapeRe` 是否涵蓋所有 regex 元字元、
   `rename` 的取代字串 `$` 跳脫是否完整、規則造成的 `storeKey` 為空字串或純空白的情形、
   以及 `sanitizeStoreRules` 與 `compileStoreRules` 兩處對「合法」的認定是否完全一致。

4. **`normalizeBranches` 的 dryRun 語意改變（#129）**：學習表區塊原本整段包在 `if (!dryRun)`，
   現在**計算照跑、只有寫入跳過**，並回傳 `learnedConflicts`。請檢驗：
   ①dryRun 路徑真的沒有任何副作用了嗎（該區塊會就地改 `v.name`，已改為淺拷貝——夠不夠？）
   ②`learnedConflicts` 的判定（兩邊都有值且不同才算衝突）會不會漏報真正會遺失的資料
   ③這個改動有沒有讓「沒變動就不寫檔」的判定失準。

5. **D0 日線（#128）**：`dailyValues` 進了 `READONLY_COLLECTIONS`，新型別 `datereq`。
   `takeSnapshotIfDue` 刻意呼叫私有的 `writeMonthlySnapshot` 而非 `takeSnapshot`（避免寫兩遍）。
   請檢驗：同日覆寫/跨日累積的邊界（跨月、跨年、系統時間被調整）、
   `recordDailyValue` 每次開 app 都寫一次全庫的代價、
   以及**與 `syncIb` 跨 await 覆寫的互動**（已知既有問題：`syncIb` 請求前讀、請求後把過期快照寫回；
   已另列待辦，**這條不必重複提**，但若你發現 D0 讓它從「一天一次」變成「每次開 app」而有新後果，請說）。

6. **同步點**：AGENTS.md 新增了三列（使用者自訂店名規則／規則入櫃檯／規則的 API 與 UI）
   與 `dailyValues` 一列，請對照程式檢查是否一致、有無漏記的新同步點。

（此段每輪審查後由 Claude 更新範圍；常青規則在下方不變。）

---

請針對以下面向檢視程式，找出值得處理的問題：

1. 正確性 bug（邏輯錯誤、邊界條件、多幣別/匯率換算、日期時區）
2. 死碼、重複程式、可簡化處
3. 同步點是否有一邊改了另一邊沒跟上（對照 AGENTS.md 的同步點清單）

每一條意見在提出前，請先自己驗證：

- 指出確切的「檔案:行號」。
- 說明為什麼是問題（能重現的用什麼輸入會出錯；不能重現的別當 bug 提）。
- 如果你懷疑某處「看起來重複/奇怪但可能是刻意設計」（例如 COMPOSITION
  表在前後端各一份是刻意的同步點），請照樣列出，但標註「可能為刻意設計，
  待 Claude 判斷」，不要直接斷定是錯的。
- 之前輪次已判定為「刻意設計」的項目（記錄在 AGENTS.md 的同步點清單與
  例外說明中）**不要重複提出**。特別提醒：AGENTS.md 鐵則 6 的前端型別放寬
  （byId any／onMount any／Chart any／fxGaugeSection 休眠停放）與
  devDependencies（typescript/eslint/@types）都是刻意引入，非問題。

輸出格式（讓使用者可以整段複製轉交）：把發現條列，每條用這個格式——

```
[編號] [嚴重度: 高/中/低] 檔案:行號
問題：一句話講清楚
證據：為什麼是問題 / 什麼情況會出錯
建議：怎麼改（只描述，不要真的改）
```

最後附一句總結：總共幾條、其中幾條是你較有把握的。

不要修任何東西，也不要幫使用者 commit。你的產出就是這份清單，使用者會
轉交給 Claude 判斷後再決定要不要做。
