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

## 本輪審查重點（r13；2026-07-21；範圍＝main 現況，火力集中 #175–#184 這批）

這 10 個 PR 是 Claude **趁使用者運動時自主連做**的一批（匯入紀錄、版面微調、收/支/內轉三套分類管理、銀行「真·學習」記憶版＋同類一起改＋管理畫面、D1 報價自動更新、銀行帳戶獨立頁、卡費明細改名）。#157–#174 已在 r9–r12 審過；本輪對 main 做一輪全面 pass，但**新增碼＝#175–#184 才是未審的火力點**。特徵：①**動到金流／帳務正確性關鍵路徑**（銀行分箱、學習、方向、內轉子分類），②**多條是「修正的修正」**（#178 有兩輪自審、#184 修過 collision）——歷史經驗：修正比原始程式更容易出錯，請帶著這個預期審，尤其盯 Claude 自審「已修正」的地方有沒有留下新破口。

**重點檢查（依風險）**：
1. **銀行學習方向護欄**（#178，**最高風險·生存優先**）：`classifyWithLearning`（`lib/services/bank-import.js:201`）靠 `learnedTypeFitsDirection`（:190）擋「學到的 income 被套到流出方向」。這是第一輪自審抓到的生存級 bug（學過的收入把一筆 out 記成 income → 淨值無聲虛增）。請把 type(income/expense/transfer)×direction(in/out) **六格全列出來驗**：有沒有漏擋的組合？transfer 是否兩向都放行、且子分類角色（交割 vs 內轉出/內轉入）跟著方向走對？
2. **bankKey 身分鑰匙**（#178）：`bankKeyOf(summary, note)`（:171）＋`counterpartyAcct`（:164，regex 抓遮罩帳號）。太寬＝不同交易被當同一條規則、一次教錯全部套錯；太窄＝白學。請驗：抓對方帳號的 regex 邊界（多段數字、`****` 遮罩變體）；**純摘要無帳號時 key 會不會塌成只剩摘要而過度合併**？空摘要／空備註的退化？
3. **「同類一起改」批次套用**（#182）：`applyLearnedBankToExisting(bankKey)`（:265）。請驗：範圍是否精確鎖在同 bankKey、不誤改別條？**批次路徑有沒有跟單筆一樣過方向護欄**（否則第 1 點擋住的錯配會從批次這條路漏進去）？改既有交易時分類/子分類/顯示名口徑一致？
4. **內轉子分類 role-first conform**（#180/#184）：`conformTransferSub`（`lib/services/categories.js:132`）對預設 token（內轉出/內轉入/交割）走**角色優先**、自訂 token 走字面——修過 collision（使用者又自訂一項叫「內轉出」時字面比對誤對）。`saveTransferSubs`（:148）改名連動既有交易、刪除→conform 空。請驗：改名 vs 刪+增（`renames` 標記）分得清？刪某角色後既有交易 conform 到空字串如預期？保留字整組拒絕（400）守住？`resolveCls`（bank-import.js:330）的 transfer 分支有沒有把子分類 conform 到現名？
5. **D1 報價自動更新**（#179）：`refreshQuotesIfStale`（`lib/services/market-data.js:103`）用 `quotesLastAt`（伺服器擁有、比照 `ib.lastSync`）判 >1h。**已知刻意取捨**＝任何一次成功就蓋時間戳（避免 API 被打爆、不做部分失敗重試）——確認程式與 docstring 一致、且 `quotesLastAt` **沒混進 CRUD/settings 白名單**（前端可寫就能靠改時間戳癱瘓更新）。FX 匯率 symbol 是**前置**到 syms（40 上限砍不到）——驗這條還在。
6. **新 KV 鍵的入櫃檯與備份**（#178/#184）：`learnedBank`/`transferSubs` 兩個新頂層鍵，`KV_MAP_KEYS`（`lib/store.js:26`）決定預設 `{}`(map) vs `[]`(array)。請驗：`sanitizeLearnedBank`（`lib/schema.js:268`）／`sanitizeTransferSubs`（:294）都掛進 `sanitizeDbForWrite` 單一寫入閘？`learnedBank` 以使用者文字（摘要）為 key＝**原型污染面**（鐵則 3.5）——寫入端拒保留字家族了嗎？**export→import 備份會不會漏帶這兩個鍵**（settings 新欄位同步點）？
7. **匯入紀錄／整批刪除**（#175）：`listBankBatches`（:450）/`deleteBankBatch`（:475）。請驗：刪一批後 `bankRef` 去重鍵是否一併清掉、讓「重新上傳同一份」冪等重進（不被殘留去重鍵擋住）？空批次／不存在 batchId 的處理？
8. **收入樹＋帳戶分頁＋版面**（#177/#183/#176，較低風險）：`effectiveIncomeTree`/`saveIncomeTree`（categories.js:59/72）改名連動、退路節點（其他/其他收入）鎖定不可刪；銀行帳戶獨立頁（`type:'cash'` 過濾）有沒有把非現金漏進、或現金漏出；cashflow 版面微調有無 esc/XSS 漏網。

**新測試檔**（可先看它們界定了哪些不變量、再找它們沒測到的縫）：`test/bank-learning.test.js`、`test/market-data.test.js`、`test/transfer-subcats.test.js`、`test/bank-import-batches.test.js`（全庫 446 題）。

**收官條件**：0 高 ≤2 輕 → r13 收官，回主線（每日洞察引擎 D2＝提醒配鑰匙）。

### 自我檢查（開審前）
- `git fetch origin && git checkout --detach origin/main`；`git log --oneline -3` 應含 #184（`3d53894`）；三關全綠再開審。
- **絕不在 codex worktree commit**；`?? node_modules`＝舊樹快照，先更新再看。
