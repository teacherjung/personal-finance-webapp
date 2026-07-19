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
- **在你專屬的審查 worktree 裡工作**：`~/Desktop/07 專案/榮祥森（投資理財）-codex`（使用者定 2026-07-19）。那裡是 **detached HEAD**，更新方式＝`git fetch origin && git checkout --detach origin/main`（**不要用 `git pull`**，detached 狀態下沒有意義；也**不要 `git checkout main`**——`main` 被主目錄佔著，Git 會拒絕）。
  - 為什麼要分開：上一輪審查時 Claude 在同一個目錄裡 rebase 與切分支十幾次，你正在讀的樹在腳下移動、看到新舊混雜的程式碼。現在 Claude 在 `-claude` worktree 工作、主目錄永遠停在 `main`，三邊互不干擾。
  - **不要在你的 worktree 裡切到別人的功能分支**（那會把它從主目錄／Claude 的 worktree 搶走）。要看某個 PR 的內容用 `git fetch origin && git log/diff origin/<branch>`，不必 checkout。
  - 順帶一提：你的 worktree 裡**沒有** `data/store.db`（真實個資只在主目錄），所以下面那條「絕對不要讀取」現在是結構上做不到，不必再擔心誤觸。
  - 🚩 **「我的樹是不是過期了」的自我檢查**：審查開始前先 `git rev-parse --short HEAD`，跟 `git rev-parse --short origin/main` 比對；不一樣就先更新。**最常見的過期徵兆＝`git status --short` 出現 `?? node_modules`**——那個 symlink 早已被 `.gitignore` 忽略（2026-07-19 起 `.gitignore` 用不帶斜線的 `node_modules`，帶斜線只比對目錄、擋不住 symlink），會冒出來只代表你停在那次修正之前的 commit。遇到就 `git fetch origin && git checkout --detach origin/main`，不要當成待修問題回報。
  - ⚠️ **不要在你的 worktree 裡 commit 任何東西**（使用者定 2026-07-19）。你的產出是意見清單，實作與修正一律由 Claude 在 `-claude` worktree 走分支與 PR。
- 絕對不要讀取 `data/store.db`（含 `.bak`/`-wal`/`-shm`）與 `data/store.json`（真實個資與 token；B3 起主資料庫為 SQLite `store.db`、舊 `store.json` 保留為備份）；要看資料形狀請看 `data/seed.json`，要實測請用 `STORE_FILE` 指向暫存 `.db` 檔。

開始審查前，先跑三道自動關卡並確認全過（若有不過，直接把輸出列為發現）：

```
npm run typecheck && npm run lint && npm test
```

（若 node_modules 不存在先 `npm install`。這三關已涵蓋型別/格式/回歸，你的審查火力請放在它們抓不到的：邏輯錯誤、口徑不一致、同步點漏改、安全性。）

## 本輪審查重點（2026-07-20；上輪＝r4 審到 #137，本輪範圍＝#138–#145）

本輪是**驗收輪**：主要對象是「你 r4 六條的修正本身」（#139–#142）＋#138＋#144（extractStatementDue 兩版面重寫——使用者實帳單抓錯後改；請驗序數對位與各守門的繞過情形）＋#145（DUE_KEYS 補「本期帳單金額」＝台新官網 XLSX 的叫法，一鍵之差，順帶驗優先序與「最低應繳金額」不可誤抓）。
歷史經驗（本週已驗證兩次）：**修正比原始程式更容易出錯**——請帶著這個預期審。

1. **safe-map 的覆蓋率（#139 的漏網）**：#139 只硬化了學習表（learning.js/schema.js sanitizeLearned）
   與分類別名（categories.js saveTree 的四張 map）。請找**其他**「使用者文字當 key」的表有沒有同型漏洞：
   `expenseTree`（Claude 快查過兩條路徑守得住，但 HTTP body 帶「自有 __proto__ 鍵」經 sanitizeTree 的
   路徑值得你再驗）、`settings.healthDismissed`（ID 含 storeKey）、`storeRules` 各欄、
   前端 modules 裡的任何同型 map。判準：`JSON.parse('{"__proto__":…}')` 能造出自有鍵，
   光 `Object.create(null)` 不夠，讀寫兩端都要走 `lib/safe-map.js`。

2. **#140 IB 現金歸零的誤傷面**：`hasCashReport` 判斷在 IB Flex 真實形狀下（多個 FlexStatement、
   CashReport 存在但只有 BASE_SUMMARY 列、幣別牆跳過的幣別）會不會把不該歸零的歸零？
   特別是：EUR 現金被幣別牆跳過時不在 cashSeen 裡——若曾有 EUR 帳戶會被歸零嗎？該嗎？

3. **#141 閘門的互動與繞過**：①手動 `POST /api/statement/normalize-branches`（維護用途，UI 已移除）
   **沒有閘門**、直接套用——這是「維護後門刻意繞過」還是漏洞？請評估後標註，由 Claude 判斷。
   ②不記指紋＝每次開 app 都 dry-run 一次全庫直到使用者確認——成本與騷擾頻率可接受嗎？
   ③與 `saveStoreRules(force)` 的組合有沒有「不經確認就套用」的縫。

4. **#142 冪等檢查的 false negative**：`checkRulesIdempotent` 對每條規則的產物 `to` 再清一次——
   會不會漏掉「產物被內建規則（branchNormalize/BRAND_CANON）而非使用者規則二次改寫」的情形？
   「跑兩次結果相同」的整組性質，有沒有這個檢查抓不到的反例？

5. **平行 PR 會合縫（新 bug class，rebase 時實際抓到）**：#141 寫確認視窗時用 `cf.length`，
   #142 才引入真實總數——兩個同日 PR 各自全綠，會合後出現「計數用被截斷的長度」縫（已修）。
   請掃 #139–#142 之間還有沒有同型：A PR 引入的機制，B PR 的新程式碼不知道要用。

6. **#138（顯示名跟著分類走）**：`learnFromStmtEdit` 靠 `updateItem` 的 `prev` 判斷「這次改了什麼」；
   `applyCategoryToStore` 重算 note。兩條路與 #141/#142 的學習表變動有沒有互相踩。

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
