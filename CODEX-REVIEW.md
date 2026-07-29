# Codex 定期審查指令

> **使用方式（自動，William 2026-07-27 常設授權）**：每批 PR 合併進 `main` 後，**Claude 直接用本機 `codex` CLI 跑這份審查**，不必 William 手動轉述。指令：
>
> ```bash
> codex exec -m gpt-5.6-sol -c model_reasoning_effort='"xhigh"' \
>   -s workspace-write -c sandbox_workspace_write.network_access=true \
>   -C "<repo>-codex" "請讀 CODEX-REVIEW.md 並照它執行審查"
> ```
>
> - **審查模型＝`gpt-5.6-sol` ＋ `model_reasoning_effort=xhigh`（William 定 2026-07-27）**：設定寫在**指令上**，
>   **不動 `~/.codex/config.toml` 的全域預設**（改全域會連帶改掉 William 自己的互動式 Codex，超出「調整審查」的範圍）。
>   為什麼升級：實測有效——升級後的第一次全面重審，在**先前多輪審查都跑過的同一份 `main@272ec9a`** 上
>   找出 5 項可重現問題（4 High／1 Medium，含一項「備份檔的任意 `id` 造成持久型 XSS」）。
>   代價：單次約 **72 萬 tokens**（原本 8–13 萬）＋等待較久。**高風險 PR 一律用這組設定**；
>   低風險小 PR 想省額度可退回預設模型，但要在回報裡註明用了哪一組。
> - **一律在 `-codex` 這個獨立 worktree 跑**（先 `git fetch origin && git checkout --detach origin/main`），寫入範圍限在那棵樹，碰不到主資料夾與 `data/store.db`。
> - **網路權限要開**：不開的話 9 個會綁 localhost 的端點測試檔會被沙箱擋掉（`listen EPERM`），測試關卡只跑得了一半（2026-07-27 實測）。
> - **跑完檢查副作用**：`git status` 那棵樹是否乾淨；Codex 可能自建 `/private/tmp/codex-pr<N>` 臨時 worktree 跑 PR 版本測試（正確做法，但會留下 `package-lock.json` 之類的殘留）→ 用 `git worktree remove --force` 收掉。
> - **審尚未合併的 PR** 時，在提示詞裡指名 branch 與重點，並要求 `git diff origin/main...origin/<branch>`、不要 checkout。
> - **成本**：每次約 8–13 萬 tokens（走 William 的 ChatGPT 方案額度）。
> - **回報**：Claude 把 Codex 的**原始回覆原文**貼給 William（不轉述、不挑），再附上自己逐條核對的結論（屬實／誤報／需裁決）；**修不修由 William 決定**，Claude 不因為「Codex 說了」就自動動工。
>
> （手動備援：William 也可以自己對 Codex 說「請讀 CODEX-REVIEW.md 並照它執行審查」，拿到清單後整段原文貼給 Claude。）

> **合併也由 Codex 代執行（William 2026-07-27 追加授權；2026-07-30 補對稱原則「實作者不按自己的合併鍵」）**：Claude 實作、你審過的 PR 由你代執行；**你實作、Claude 審過的 PR 由 Claude 代執行**（同這五個步驟）。五個步驟缺一不可：
> 1. 確認**審查結論**（無阻擋問題）與 **CI 全綠**（`gh pr checks`）；有任一不成立就**停下來回報，不要合併**。
> 2. ⚠️ **堆疊閘（機械執行，不可憑印象跳過）**：
>    ```bash
>    node scripts/check-pr-merge-gate.js <N>
>    ```
>    **退出碼 0＝非堆疊，才可進步驟 3；非零＝停下來回報、本輪不合併**（1＝堆疊、2＝查不清楚。
>    查不清楚也一律當堆疊——fail-closed，別把「查不到」當「安全」：兩次事故畫面上都是
>    「Merged」＋CI 全綠、零錯誤訊息）。堆疊時改走 AGENTS.md「堆疊 PR 的合併程序」：
>    由下而上、每合併一支就把下一支的 base 改成 `main` 並 rebase（rebase 完**從步驟 1 重新開始**——
>    新 commit 要重新過審查與 CI）、**全程不可 `--delete-branch`**，整疊合併完再抽查
>    最上層 PR 的代表性新檔**是否真的出現在 `main`**。
>    〔閘查**兩個方向**，各防一次真實事故：①本支的 base 必須是 `main`——不然按合併鍵會合進
>    別支分支（2026-07-28 #311/#312 的死法）；②不得有 open PR 以本支的 head 為 base——不然
>    刪分支會把上層連帶關閉為 MERGED 且無法重開（2026-07-10 #3/#5 的死法）。
>    行為考題＝`test/merge-gate.test.js`（假 gh 五情境）。r1 的第一版只查②——#346 那種
>    「自己疊在別人上面」會被放行；而且考題只掃文件關鍵字、被 HTML 註解繞過，故改成腳本。〕
> 3. `gh pr merge <N> --squash --delete-branch`（**一律 Squash and merge**；`--delete-branch` **僅限步驟 2 退出碼 0 時**）。
> 4. 確認遠端分支已刪除。
> 5. 回報**合併結果**與**是否需要重啟服務**（動到 `lib/`、`server.js`、`package.json` ＝要重啟；只動 `public/` 的前端改動重新整理即可；純文件不必）。
>
> ⚠️ Codex 合併前**不可**自行修改程式（審查者角色不變）；發現問題就回報給 Claude 修。

> **常態分工＝三方協作框架 v4（AGENTS.md「三方協作框架」節，2026-07-24 裁決）**：Claude 實作、**Codex 唯讀審查**（獨立複審、對抗測試、同步點檢查、風險分析）、William 決定與驗收。**高風險 PR（金額公式/資料庫/搬家/匯入/機密/共用底層）＝Codex 複審後才合併**——William 指定審某支 PR 時，用 `git fetch origin && git diff origin/main...origin/<branch>` 看內容、不 checkout。
> 文末「實作模式」**只在 William 明確指派 Codex 做獨立功能時才啟用**（三條件：有獨立施工計畫／不碰 Claude 預約中的共享檔案／Claude 的 PR 需要複審時審查優先），不是常態。

---

你是這個專案的程式審查者。開始前請先讀 repo 根目錄的 AGENTS.md，
特別是「審查分工」「⚠️ 同步點清單」「投資領域語意」三個段落——那是你的
職責邊界與這個專案的刻意設計，務必遵守。

**你有三種模式，邊界不同（完整表＝AGENTS.md 角色分工「Codex 的三模式邊界」；2026-07-30 定）**：
①**常態審查**（本節，預設）＝絕對唯讀；②**代合併**（上方五步驟）＝只執行合併、不含修碼；
③**實作**（文末「實作模式」節）＝僅 William 明確指派才啟用。**模式間不會自動升級**——
審查中發現「順手就能修」的問題＝回報 Claude，不是修；審查／代合併權限不得自行膨脹成實作權限。

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

## 實作模式（非常態；**只有 William 明確指派你做獨立功能時才啟用**）

啟用條件＝協作框架 v4 的三條件：①有獨立施工計畫（先交 William 裁決再動工）②不碰 Claude 預約中的共享檔案（見 PROJECT.md「共享檔案預約」表）③一旦 Claude 的 PR 需要複審，**審查優先於你的實作**。前例＝月度回顧 P0–P2、目標追蹤、個股研究頁。被指派時照這裡走：

- **工作環境**：**不要在 `-codex`（唯讀複審用）commit**。實作用能 commit/push 的 worktree。流程：`git fetch origin && git checkout -b <分支> origin/main` → 改 → commit（訊息繁中、講動機，Co-Authored-By 標你）→ push → `gh pr create --base main`。合併＝**William 裁決**後照上方合併五步驟執行（決策與執行的完整規則在 AGENTS.md「協作流程」）；⚠️ **實作者不按自己的合併鍵**（William 2026-07-30 對稱授權）——你實作、Claude 審過的支由 **Claude** 依同五步驟執行；你的代合併授權只涵蓋「別人實作、你審過」的支。
- **三關全綠才開 PR**：`npm run typecheck && npm run lint && npm test`（本機 pre-push hook 也會擋、雲端 CI 也會跑）。
- **鐵則照 `AGENTS.md`**（PR 分級與流程重量見「三方協作框架」節）：一任務＝一分支＝一 PR；動到分類/店名/金額口徑順手在 `test/` 補考題；服務層擁有欄位絕不加進 CRUD 白名單（見「欄位所有權」表）；動到架構一併更新對應 Notion 頁（「Notion 白話規格・更新工法」小節，留言用【Codex】開頭）；改後端合併後提醒使用者重啟；合併點提醒「Squash and merge ＋勾 delete branch」（**堆疊例外**：先跑 `node scripts/check-pr-merge-gate.js <N>`，非零就不勾 delete branch——見上方合併步驟 2）。
- **開 PR 前自己對抗式自審一輪**：money 相關路徑（現金流方向、分類、槓桿、洞察差異、原子寫入）先假設「哪裡會壞」再驗；可疑處用隔離 `STORE_FILE` 的 `node --test` 重現，別只憑推測。**你實作的高風險 PR＝Claude 複審後才合併**（與 Claude 的高風險 PR 由你複審對稱）。
- **PII**：絕不讀 `data/store.db`（含 `.bak/-wal/-shm`）與 `store.json`；測試一律 `STORE_FILE` 指暫存 `.db`；帳單 PDF 密碼＝身分證字號，只記憶體用、絕不落任何檔/log/commit。

### 自我檢查（開審前）
- `git fetch origin && git checkout --detach origin/main`；`git rev-parse --short HEAD` 應等於 `origin/main`；三關全綠再開審。
- **絕不在 codex worktree commit**；`?? node_modules`＝舊樹快照，先更新再看。
- 當期審查重點由使用者隨任務給（或審整個 main 現況）；歷史輪次的重點清單（r1–r14）見本檔 git 紀錄。
