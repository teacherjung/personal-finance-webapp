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

## 本輪審查重點（2026-07-20；上輪＝r5 審到 #145 交 8 條全數成立，本輪範圍＝#146–#149）

本輪是 **r5 修正的驗收輪**：你 r5 的 8 條（3 高 5 中）全部驗證成立並修正——#146（r5#1/#4/#5 原型污染收尾）、#147（r5#2/#7 IB 現金）、#148（r5#3 序數偏移）、#149（r5#6/#8 冪等＋閘門）。
歷史經驗不變：**修正比原始程式更容易出錯**——請帶著這個預期審。

1. **safe-map 掃蕩的漏網**（#146）：這輪把學習表四條寫入路（learnFromImport/applyCategoryToStore/
   renameStoreDisplay/deleteLearned）、分類樹三張表、前端四處聚合都治了。請再掃一次**還有沒有**
   「使用者文字當 key 的裸物件讀寫」——特別是 services/ 我們沒點名的檔案、以及 `in` 運算子的殘留。
2. **IB 歸零判準的已知取捨**（#147）：歸零現在需要「至少一列真實幣別明細」。取捨＝若使用者把
   **全部**幣別的現金都提光且報表只剩 BASE_SUMMARY，舊值會殘留（有紅色警告）。請判斷：這個
   取捨在真實 Flex 報表行為下站不站得住？（IB 對「本期有活動的幣別」是否一定出明細列？）
   另驗 parseStatement 直測考題與 sync 假資料的形狀有沒有對不上真實 XML 的地方。
3. **括號組併欄的邊界**（#148）：深度計數處理全形/半形括號混用、括號不閉合、巢狀括號時
   會不會把欄位併錯反而製造新的偏移？「欄位數＝數字數」守門有沒有繞得過的版型？
4. **品牌口徑檢查的漏網**（#149，r5#6 修正）：判準＝storeKeyOfName(cleanStore(to)) ≠ storeKeyOfName(to)
   才拒。有沒有「品牌身分剛好相等、顯示名卻仍會漂移」的反例？canon 類產物要不要同款檢查？
5. **閘門全景**（#149，r5#8 裁定落地）：normalize-branches 維護端點已要求 force:true。
   請掃一遍**其他**會寫檔的端點，還有沒有「不經確認、不用明說就動不可逆資料」的路。
6. **前端保留字錯誤顯示**（#146）：saveTree 現在 400 拒絕保留字，前端靠既有 catch 顯示
   「儲存失敗：…」。請確認分類設定 UI 的所有儲存路徑都會把這個訊息帶到使用者眼前。

**收官條件（與使用者約定）**：0 高、≤2 輕微 → 這輪硬化循環收官，回主線（D1 報價自動更新／清體檢佇列／候選 5-1）。

### 自我檢查（開審前）
- `git fetch origin && git checkout --detach origin/main` 更新到最新 main（**絕不在 codex worktree commit**）。
- `git log --oneline -3` 應含 #149 的合併；`git status` 應乾淨（`?? node_modules` ＝舊樹快照，先 fetch＋detach 再看一次）。
- 三關（typecheck／lint／test）全綠再開審。
