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

## 本輪審查重點（2026-07-22；範圍＝#157–#165，一次驗收 Codex r9 修正＋Claude 自主全面體檢的 9 個 PR）

這批很大（Codex r9 四條＋自主體檢 21 條確認＋使用者拍板四題），且**很多是「修正的修正」**——歷史經驗：修正比原始程式更容易出錯，請帶著這個預期審。

**重點檢查（依風險）**：
1. **IB 現金金額嚴格取值**（#157）：cashAmt 只認期末欄、空白/非數字/期初一律不當 0。有沒有漏的空值形態？`'0'` 字串是**合法的零**，確認沒被誤殺。
2. **錢的口徑**（#158）：持股缺幣別前後端都改預設 TWD、fxExposure 負債符號、淨值歸零 equityWiped。前後端口徑是否真的一致（含月快照歷史點 vs 現在點）？
3. **stmtRef 去重加 |#N**（#163）：**最需要盯的一條**——序號依解析順序、重匯要冪等。origFromStmtRef 剝序號段有沒有邊界問題？reassignBatch/學習/顯示名這條鏈路會不會被 |#N 影響？
4. **機密投影**（#164）：/cards /db /settings 剝機密、/export 保留完整。有沒有**其他**會回機密的端點漏網？編輯窗「留空＝不變更」在各種情境（清空想真的清除？）對不對？
5. **過期提醒＋短月攤提**（#165）：三處攤提口徑（derive/前端/公式文案）是否一致？過期視窗會不會誤洗？
6. **前端競態/checkbox 預設**（#160/#162）：routeSeq 守門有沒有漏接的長流程？

**收官條件**：0 高 ≤2 輕 → 這輪（Codex r9＋自主體檢）正式收官，回主線（D1 報價自動更新）。

### 自我檢查（開審前）
- `git fetch origin && git checkout --detach origin/main`；`git log --oneline -3` 應含 #165；三關全綠再開審。
- **絕不在 codex worktree commit**；`?? node_modules`＝舊樹快照，先更新再看。
