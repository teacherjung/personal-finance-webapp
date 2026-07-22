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

## 本輪審查重點（r14；2026-07-22；範圍＝main 現況，火力集中 #192–#195 這批）

這 4 個 PR 是 Claude **趁使用者睡覺自主連做**的一批：**防撞護欄 G3–G5（#192）＋每日洞察引擎 D2–D4（#193/#194/#195）**。每一階段 Claude 都跑了**對抗式自審**（多路 reviewer 找碴→再派 agent 逐條「試著推翻」→只留站得住的），confirmed 的都已修＋補回歸考題。特徵：①**D3（#194）是全新子系統、最複雜**——差異引擎有**寫檔副作用（GET /api/insights 讀取即更新書籤）**＋**跨 await 寫檔**，計畫本就指定「合併後建議 Codex 審一輪」；②**G3 動到金流／帳務寫入路徑**（把「編輯＋套同類」改成原子一次寫檔）；③多條是「自審已修」的地方——歷史經驗：**修正比原始程式更容易出錯**，請帶著這個預期，尤其盯下面標「（自審修）」的點有沒有留下新破口。文末有「已自審修正紀錄」省你重工。

**重點檢查（依風險）**：
1. **D3 差異引擎**（`lib/services/insights.js`，**最複雜·計畫指定**）：
   - **read-await-write**：`getInsights` 先 await `getCape`/`getRealYield` 算 ECY，**await 之後才 `getDb`→算→`saveDb`**。驗：await 到 saveDb 之間確實**無任何 await**（否則同 syncIb r3#1 病）？兩次並發 `/api/insights` 會不會 clobber 書籤？
   - **GET 的寫檔副作用**：讀取＝更新書籤。驗：算到一半 throw 時 `lib/routes/core.js` 的 try/catch 降級（回平靜空殼）安不安全、會不會留半更新書籤？
   - **升級同鑰匙（自審修·生存級）**：訂閱/保險「將至→已過」改共用 `sub-charge-<id>`／`ins-pay-<id>`（`lib/derive.js`），不再拆 `-overdue-`——否則升級當下被謊報成「✓已解除 👍」。驗：**還有沒有別的「同一顧慮跨日換 key」的提醒漏網**？
   - **有效書籤判準（自審修）**：需 `lastSeenAt`(字串)＋`reminders`(陣列) 才算非首次；殘缺書籤退回首次。驗：`sanitizeInsightState`（`lib/schema.js`）清出來的殘缺形狀真的不會洪水標 🆕？
   - **固定窗 Δ（自審修）**：`computeWindows` 的 `pctOf` 用 **abs(基期)**（負淨值方向不反轉）、基期 0 有變動不算平靜、`closestOnOrBefore` 依賴升冪排序。**已知取捨**＝「今天」窗＝latest vs 前一個既有日，日線稀疏/跨多日時可能把多天標成「今天」——確認這是取捨非 bug。
2. **signal-tiers.js 抽出的 parity**（`public/modules/signal-tiers.js`）：估值檔位門檻從 `portfolio.js` 搬出成**前後端共用單一真相**（前端儀表＋後端 insights 跳檔都 import）。驗：`regionTier`/`taiwanTier`/`ecyOf` 跟原 portfolio.js **逐一等價**（邊界值 3／5／11.5／1.2／0.9…）？portfolio.js 改 import、`TIER_META` 從 `TIER_LABELS`＋顏色重建後儀表行為不變？後端 `computeSignalTiers` 五市場口徑（us 用 ecy、taiwan 用 PE/殖利率）對？
3. **G3 同類/同店一起改原子化**（`lib/routes/crud.js` PUT `applyAll`＋`lib/services/statement-import.js applyCategoryToStoreDb`／`bank-import.js applyLearnedBankToDb`）：傳播邏輯抽成**純 in-db worker（不自己 saveDb）**，原子入口在同一次 `updateItem` 內先學再傳播、一次寫檔。驗：worker 真的**不自己 saveDb**（否則雙寫）？傳播 throw 真的**連本筆編輯一起 rollback**（`updateItem` 尚未 save）？**（自審修）** 服務費／空分類／保留字 storeKey 的前提 guard 擋全（別讓 worker 的 throw 把本筆編輯連坐）？**方向護欄（r13#2）在原子路徑仍逐筆生效**？標準端點薄殼（`applyCategoryToStore`/`applyLearnedBankToExisting`）與 worker 同一份？
4. **G4 停車費身分判準**（`lib/statement.js applyDisplayLabels`＋`lib/services/categories.js parkingSubName`）：包裝觸發改認「停車費」子分類的**身分（現名）**、不字面比對。驗：`parkingSubName` 對「改名／刪除／改名後又重建同名」解析對（自審有個 rename-then-readd 邊角被判 REFUTED＝可接受，請自行判斷）？**六個呼叫點**（conformTxs/importRows/normalizeBranches/applyCategoryToStoreDb/renameStoreDisplay/learnFromStmtEdit）都傳了 `parkSub`？未傳時退回字面相容？
5. **G5 欄位所有權**（`AGENTS.md`「欄位所有權」表＋`lib/schema.js`）：新增 `watchlist.lastAt` 型別；把 field→owner 整理成表。驗：表與實際 `WRITABLE_FIELDS`/`FIELD_SCHEMA` **一致**、有沒有**漏標的服務層欄位還在 CRUD 白名單**？（表中已註記 watchlist 報價欄目前前端寫、待日後移後端。）
6. **D2 提醒穩定鑰匙**（`lib/derive.js computeReminders`）：19 條配 key。**（自審修）** 個股集中度改**按 symbol 彙總**（同一檔多筆手動持股不撞 key，順手補「拆單 3%+3%>5% 逃個股上限」的守門洞）。驗：同一次計算 key **必互異**、還有沒有會撞 key 或含易變值（金額/百分比/索引）的 key？
7. **D4 新聞牆**（`public/modules/dashboard.js`，純前端）：消費 `/api/insights`。驗：insights 失敗**整段退回舊「需要處理」**的 fallback 完整？**（自審修）**「一次 app-open 只抓一次」的 Promise 快取（背景重繪不重抓、免 🆕 被秒吸收）？跳檔 title／cleared title（來自書籤）有沒有 `esc`／XSS 漏網？

**新測試檔**（先看它們界定了哪些不變量，再找沒測到的縫）：`test/guardrail-g3-atomic.test.js`、`test/guardrail-g4-parking-rename.test.js`、`test/signal-tiers.test.js`、`test/insights.test.js`（＋`test/derive-reminders.test.js`／`test/server.test.js` 有新增；全庫 **510** 題）。

**已自審修正紀錄（這些已修，請驗「修得對不對、有沒有新破口」，不必重新發現）**：
- G3：服務費列 applyAll 會把本筆編輯連坐 rollback → 改為傳播不適用就略過、本筆照存（＋空分類/保留字 guard）。
- D2：`conc-stock-<symbol>` 撞 key → 按 symbol 彙總（＋補拆單逃上限）。
- D3：5 條——①升級同鑰匙（生存級）②負基期 Δ% 用 abs ③基期 0 有變動不算平靜 ④/⑤殘缺書籤退回首次。
- D4：/insights 每次重繪把 🆕 秒吸收 → 一次 app-open 只抓一次。

**收官條件**：0 高 ≤2 輕 → r14 收官。之後主線＝每日洞察引擎已完結（D0–D4 全完工），可接 D5（洞察第二批）或使用者新指示。

### 自我檢查（開審前）
- `git fetch origin && git checkout --detach origin/main`；`git log --oneline -5` 應含 #195（`e7d7bdf`，D4）；三關全綠再開審。
- **絕不在 codex worktree commit**；`?? node_modules`＝舊樹快照，先更新再看。
