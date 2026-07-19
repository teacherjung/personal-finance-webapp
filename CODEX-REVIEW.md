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

## 本輪審查重點（2026-07-20；上輪＝r6 審到 #149 交 3 條全數成立，本輪範圍＝#150–#151）

本輪驗收 r6 三條的修正：#150（r6#3 原型污染第三輪九處）、#151（r6#1 只有 BASE_SUMMARY 的合法報表以基準幣別彙總入帳＋r6#2 多帳戶報表整包 400）。
歷史經驗不變：**修正比原始程式更容易出錯**。

1. **彙總入帳的語意**（#151）：只有彙總列＋基準幣別可判定時「原子取代」（基準幣別入帳、其他幣別歸零防重複）。
   請驗：①BASE_SUMMARY 的 endingCash 語意（是否含應計利息/在途款之類會讓「彙總≠各幣別和」的成分）
   ②交錯情境：明細報表↔彙總報表輪流同步時會不會震盪或殘留 ③AccountInformation 缺 currency 欄的真實頻率。
2. **多帳戶擋門的邊界**（#151）：statementCount 判準是 FlexStatement 節點數。有沒有「單帳戶卻多個
   FlexStatement」的合法報表（如多期間切割）會被誤擋？
3. **原型污染收官檢查**（#150）：r4–r6 三輪共治了學習表/分類樹/前端聚合/查表約二十處。請做**最後一次**
   全庫掃蕩（grep 使用者文字當 key 的所有寫法變體：m[k]=、m[k]||=、m[k]||(、({...})[k]、in 運算子），
   宣告這個 bug class 關閉、或列出最後的漏網。
4. **前端三處不可測的驗證**（#150）：transactions variants／settings outTree／subscriptions cardLabel
   是讀碼修的（DOM 模組進不了 node --test）。請用你的方式獨立驗證行為正確。

**收官條件（與使用者約定）**：0 高、≤2 輕微 → 硬化循環收官，回主線（架構健檢第一包 → D1 報價自動更新）。

### 自我檢查（開審前）
- `git fetch origin && git checkout --detach origin/main`；`git log --oneline -3` 應含 #151；三關全綠再開審。
- **絕不在 codex worktree commit**；`?? node_modules`＝舊樹快照，先更新再看。
