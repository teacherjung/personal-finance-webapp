# 本專案協作附則

由共同入口 [AGENTS.md](../AGENTS.md) 路由至本檔；本檔為下列內容的正本。

## 本專案協作附則（只寫本專案的值；協作規矩正本＝根目錄 `RULES.md`，這裡一律用條號指回、不複述）

> 2026-09-17（搬家第 5 步）起，本專案的協作規矩正本＝`RULES.md`（套件本文，由 `rules.json` 產生、不手改），機器登記與專案值＝`settings.json`（人讀的產物＝`PROJECT-SETTINGS.md`），範本＝`templates/`（套件產物、本專案不改也不加檔），每條規矩有哪台機器守＝`MACHINES.md`。本節只放**只有本專案才有的值**：路徑、指令列、人名與現況。技術規則依共同入口 AGENTS.md 的路由表查各份正本。

### 共用檔清單（RULES D5）

本專案的操作指路（實作者操作化；範圍、流向與分工以 RULES D5 為正本）：

- 開工列好預計修改的完整路徑後，在施工樹根跑 `node tools/kit-lock.js --touch <路徑…>`；送審前用本支實際改動的路徑再核對。退出碼的讀法與下一步見 RULES D5、`tools/kit-lock.js` 檔頭及 `templates/review-fixed-dimensions.md`「共用檔清單」。
- 同步的版本與操作見 `tools/kit-lock.js --sync` 用法；PR 說明依複審必驗清單「共用檔清單」留同步前檢查及前後清單差異。攔截器相關檔案的變動與後續驗收仍依本檔合併段、`settings.json` 的 F 級動作及 `docs/money-guard-operations.md`。

### 套件檔常設指示

**原話正本與來源**：[AGENTS.md「William 的常設指示」](../AGENTS.md#william-的常設指示)的「套件檔無例外」保留日期與逐字原話；原來源為[套件 AGENTS.md 的固定版本](https://github.com/teacherjung/ai-collab-kit/blob/436ca9bd4277450812ceec00a509bf8cc9331f37/AGENTS.md#L65)。[無例外裁示留痕](https://github.com/teacherjung/ai-collab-kit/pull/106#issuecomment-6177109301)標明由 Claude 轉述；施工順序來源隨原話保留。

**本次操作化（不是原話）**：範圍、流向與分工依 RULES D5；本專案開工與送審操作見「共用檔清單」節。

### 工作目錄與樹（RULES D2、F1）

- **Claude 與 Codex 都在本機工作**（Codex 為本機 CLI，非雲端）——改動只存在工作目錄，`git commit` 才進歷史、`git push` 才上 GitHub。
- **一個工作目錄只服務一個角色**（Codex 提議、使用者定 2026-07-19；2026-08-02 從「寫死三個目錄」改成「寫死角色與不變量」——實測當時共有 16 棵 worktree（Codex 的實作樹在 `/private/tmp/`、每支 PR 一棵審查樹），把數量寫死等於文件一開始就是錯的，同「不寫死頁數」的道理。下表是**各角色的不變量**（角色數會長，不寫死），**實作樹＝常設兩棵（下表）、審查樹＝拋棄式每 PR 一棵**（William 2026-08-04 拍板統一「實作常設、審查拋棄」），拋棄樹的數量與清單不寫死。起因：審查當下 Claude 在同一個目錄裡 rebase／切分支十幾次，Codex 正在讀的樹在腳下移動，看到新舊混雜的程式碼）：

  | 目錄 | 角色 | 分支狀態 |
  |---|---|---|
  | `榮祥森（投資理財）` | **跑 app、放真實資料**（`data/store.db`）、使用者的桌面捷徑指向這裡 | 永遠 `main`、永遠乾淨，只接收合併結果 |
  | `榮祥森（投資理財）-claude` | Claude 實作 | 功能分支（`git checkout -B <branch> main`） |
  | `榮祥森（投資理財）-codex` | **Codex 實作**（2026-08-04 轉職；原唯讀審查樹） | 功能分支（`git checkout -B codex/<分支> origin/main`） |
  | `/private/tmp/codex-review-pr<N>`／`/private/tmp/claude-review-pr<N>` | **審查（拋棄式、每 PR 一棵）**：審 Claude 的支＝Codex、審 Codex 的支＝Claude | **detached** 釘住受審 commit；實作者備樹、審完收樹 |

  - ⚠️ **審查樹必須 detached 釘住受審 commit**（同一分支不能被兩個 worktree 同時 checkout；拋棄式樹每 PR 新建＝永遠新鮮，舊的「樹過期自檢」儀式不再需要）。備樹三步（實作者做）＝`git worktree add --detach /private/tmp/<角色>-review-pr<N> <受審commit>` → 掛 `node_modules` symlink（下一條）→ 審完 `rm <樹>/node_modules` 再 `git worktree remove <樹>`。
  - ⚠️⚠️ **`node_modules` 的 symlink：只准建、不准動**（2026-08-02 事故）。做法是 `ln -s "<主目錄>/node_modules" "<worktree>/node_modules"`（純 JS 相依，不必各裝一份），但**在任何 worktree 裡刪除、重裝、或 `rm -rf` 那個 symlink 的內容，動到的是主目錄本身**——使用者的 app 會立刻起不來（`Cannot find package 'express'`），而錯誤訊息完全指不到真因。實際踩過：清理暫存 worktree 時刪除動作順著 symlink 進去，主目錄的 `node_modules` 被清空。**移除 worktree 前先 `rm <worktree>/node_modules`（不帶斜線＝只刪 symlink 本身）**；分工統一（2026-08-04）：**純閱讀、不跑三關的分析不需要 node_modules、可不建**；正式審查要跑三關＝**由實作者備樹時建、收尾時 unlink，複審者不得自行建立／安裝／移除**。三道關與 pre-push hook 都照常運作（`core.hooksPath` 是 repo 層設定，worktree 自動繼承）。
  - ⚠️⚠️ **`.gitignore` 必須寫 `node_modules`（不帶斜線）**——symlink 對 Git 不是目錄，帶斜線擋不住，`git add -A` 會把它連本機絕對路徑收進 commit（2026-07-19 實踩：symlink 進了 PR #136 且 CI 全綠——別指望三道關攔這種東西）。worktree 裡建任何 symlink 前先 `git check-ignore -v <path>` 確認擋得住。
  - ✅ **順帶補強鐵則 1**：`data/store.db`（真實餘額、IBKR flexToken、`pdfPassword`＝身分證字號）只存在主目錄，實作與審查 worktree 的 `data/` 只有 `seed.json`——「不要讀 store.db」從君子協定變成**樹內根本沒有那個檔＝防誤觸**。**要守住這一點，在 worktree 開 App 預覽一律把 `STORE_FILE` 指到這次預覽專用的暫存資料夾**（William 2026-10-15 裁「A 改做法」）：先用 `mktemp -d /private/tmp/preview-XXXXXX` 開一個新資料夾，再用 `STORE_FILE=<那個資料夾>/store.db` 啟動。不加的話，第一次開頁 App 就在那棵樹的 `data/` 從 `seed.json` 長出 `store.db`（連同 `-wal`、`-shm`）、`store.db.bak`、`store.db.pre-ledger-migration.bak`、`backups/`（2026-08-05 在 `-codex` 樹、10/11 在一棵暫存樹都實際長過）；加了，這些全都跟著放到 `STORE_FILE` 所在的資料夾。每日備份只看資料夾、不看檔名，所以每次預覽都要用自己的資料夾：幾次預覽共用同一個資料夾、只換檔名，會互相蓋掉當天的每日備份（`Codex #691 r1` 實測）。看到 worktree 的 `data/` 有 `store.db`＝有人漏加：多半是從 `seed.json` 長出的示範庫，但檔案本身證明不了（樹裡有較新的 `data/store.json`、或有人在預覽裡匯入過真實資料，內容就不是示範），所以照樣不讀、要查只比對大小、時間、雜湊，刪不刪問 William。⚠️ 這不是對「會跑指令的未信任程序」的隔離保證：worktree 只是另一個 checkout、循路徑仍摸得回主目錄——所以 Grok 一律不進樹（見本檔「Grok（本專案）」段）；Codex／Claude 的樹紀律靠角色授權＋審查制度，不是把這道防誤觸當安全牆。
  - 建立指令留檔：常設實作樹＝`git worktree add ../<repo>-claude -b wt-claude`（`-codex` 同款）；拋棄式審查樹＝`git worktree add --detach /private/tmp/<角色>-review-pr<N> <受審commit>`；`git worktree list` 查看、`git worktree remove <path>` 移除。
  - ⚠️⚠️ **實作＝常設樹、審查＝拋棄式樹、絕不動主目錄**（William 2026-08-04 拍板統一；起因＝同日兩次實測 Codex 桌機直接在主目錄開工——主目錄被切到功能分支、本機 `main` 一度被改名消失，使用者的 app 收不到後續合併、重啟捷徑的自動同步也靜靜跳過）。**Codex 實作＝在常設 `-codex` 樹**（與 Claude 在 `-claude` 對稱），開工第一步＝`git fetch origin && git checkout -B codex/<分支> origin/main`；首次實作前照上方紀律掛 node_modules symlink。**審查一律在拋棄式樹**（上表；實作者備樹）。全程不得在主目錄 checkout、commit 或改動任何分支。William 的指派詞也會帶提醒，但**規則以本檔為準、不依賴指派詞**。
- **換手儀式**：換另一個 AI 動工之前，先把目前的改動 commit（可由完工方自行 commit，或交 Claude 審查後 commit 並以 Co-Authored-By 標明出處）。分了 worktree 之後兩邊可以同時工作，但**同一個 worktree 仍然只有一個 agent 動**。
- Commit 訊息用繁體中文、講清楚動機。

### PR、堆疊、合併（RULES C1、C2、D3、H1〜H6、A4、A5）

- 排隊程序依 RULES C1；PR 計數單位依 AGENTS.md「PR 上限」的本人更新；重疊就讓道＝D3（讓道留言的固定字樣：「本支讓道中、上游＝#N」／「本支放棄」——沒有機器讀它，是給人查的）。共享規則入口與索引人人都可能加字：兩支同時改到同一檔，合併第一支之後其餘必衝突，開 PR 時就要說「合併第一個之後我要 rebase 其餘的」。
- 堆疊＝RULES H2；堆疊閘＝`settings.json` gates 登記的 `tools/gates/check-stacked.js`（2026-07-10 #3/#5 被 `--delete-branch` 連帶關閉、2026-07-28 #309/#311/#312 各自合進自己的 base——兩次事故是這道閘存在的理由；本專案的合併指令帶 `--delete-branch`，所以這道閘必須是已啟用，考題釘著）。
- 合併條件與程序＝RULES A4、A5、H1〜H6；本專案「改到禁區清單」的範圍與登記＝`settings.json` 的 A5、B1 那兩列。本專案沒有另外的合併授權：`settings.json` 的 mergeAuthorization 欄 2026-09-28 隨套件第二輪拿掉，08-13 立、09-05 確認的常設授權由新 A4／A5 取代（裁示者 2026-09-26 定案；2026-09-28 裁 ④ 第 D1 題 a）。合併指令＝`node tools/merge.js <編號> --merger <按鍵那一方的識別值>`，只跑 `settings.json` gates 中已啟用的閘，要在**釘住受審版本的樹的根目錄**跑——主目錄永遠停在 main、它的登記不跟著分支走；合併指令回非零時先查那支的狀態、不重跑（在連結工作樹裡 `--delete-branch` 可能合併成功、刪遠端分支失敗、退 1），合併後確認遠端分支已刪。
- 合併後的驗收分級＝`node tools/acceptance-tier.js <編號>`、照它印的做（RULES H6；分級表＝`settings.json` 的 acceptance：路徑家族表與每一級的動作，F 工具安全設定排第一＝William 2026-09-15 搬家第 3 題 a；每條家族由 `test/acceptance-table.test.js` 釘住）。

### 自動守門的現況（RULES E2、E3、E4）

- 本機門＝`scripts/git-hooks/pre-push`：開頭把 `GIT_` 開頭的環境變數整族清掉（2026-08-09 從連結工作樹推送時 `GIT_DIR` 讓考題裡的 `git init` 把共用設定寫成 bare 的事故；病理與證據鏈＝`docs/bare-repo-incident.md`）→ `node tools/run-checks.js`（三關＝`settings.json` 的 checks，順序校對→糾察→考試；三關前後的工作樹檢查也在執行器裡：這棵樹還是不是工作樹、倉庫設定前後有沒有被改，外加本專案登記的主目錄布局與索引錨點〔`checks.mainWorktree`、`checks.indexAnchors`〕，守得到與守不到＝`MACHINES.md` E2、E3 那一列）；非零一律擋。⚠️ **這台機器的 `core.hooksPath` 寫的是主目錄的絕對路徑**：每棵工作樹推送時跑的都是主目錄那一份，主目錄要用桌面捷徑更新才拿到新版；新 clone 要自己 `git config core.hooksPath scripts/git-hooks`（相對路徑時每棵樹跑自己那一份）。
- 雲端門＝`.github/workflows/ci.yml`（同三關，草稿也跑）；協作欄位閘＝`.github/workflows/collab-fields.yml`，內容逐字等於 `templates/collab-fields-github.yml`（考題釘著）。
- 手動跑三關直接看 npm 的 exit code——`npm run lint 2>&1 | tail -1; echo $?` 回的是 tail 的退出碼（zsh 管線要查 `pipestatus`），曾因此漏掉 4 條 lint 錯誤。

### 審查（RULES F1〜F10）

- **套件的審查規定（2026-10-10 整批同步起）**：風險級別＝RULES D4 與 `node tools/risk-tier.js <編號>`；複審與掃描分級＝RULES F2、G1 與 `PROJECT-SETTINGS.md` 第十節；送審提示＝RULES F3 與 `templates/review-request.md`，可以用 `node tools/review-launch.js <編號> --reviewer <識別值> --dir <資料夾>` 產生；送審前跑 `node tools/stale-text.js`（RULES K5）；複審者的模型、推理與怎麼起＝RULES F11 與 `settings.json` 的 reviewers（`PROJECT-SETTINGS.md` 第十一節）；快速通道＝RULES F12；擁有者通道的本專案值：William 當複審者，結論標頭的角色寫 `William`、來源字串寫 `William 本人`；AI 通道的範圍由 `settings.json` 的 `fastLane.ai` 登記，本專案維持未登記。口頭指定過的模型與推理（含 9/29、10/1 兩次）一律由設定第十一節與 C28 取代。下面兩條（觸發與指令列、送審提示詞）跟它們不一致的，以它們為準；複審必驗清單的項號以同步進來的 `templates/review-fixed-dimensions.md` 為準。
- **Codex 審查的觸發（William 常設授權，2026-07-27 立、2026-08-03 擴充）**：Claude 直接用本機 `codex` CLI 起審查、不必先問——PR 進行中的每一輪複審，與每批合併進 main 後的例行審查。指令列＝`codex exec -m <當輪最強模型> -c model_reasoning_effort='"<最高推理>"' -s workspace-write -c sandbox_workspace_write.network_access=true -C "/private/tmp/codex-review-pr<N>" - < <提示詞檔>`（模型與推理依 AGENTS.md 常設指示 C28：發審者每輪依平台當時提供的模型與推理等級清單核對，明確指定最強模型、最高推理；不使用 auto 選模／推理或自動升降級模式，判不出最高者先問 William；歷史設定 gpt-6-astra／xhigh 是 William 2026-09-07 的裁示、落點＝https://github.com/teacherjung/personal-finance-webapp/pull/579#issuecomment-5574063644 ；設定寫在指令上、不動 `~/.codex/config.toml`；網路要開，否則綁 localhost 的端點測試被沙箱擋掉 `listen EPERM`；其餘一律這組設定、AI 不可自行分類降級）。審查樹由實作者備與收，複審者不得自建 worktree；diff 一律 `git diff -M origin/main...HEAD`。
- **送審提示詞＝RULES F3 與 `templates/review-request.md`**；本節仍是本專案複審必讀文件，來源字串的標準表＝`PROJECT-SETTINGS.md`。複審必驗清單「看情況查」的本專案落點：金額顯示走共用格式器（`money`／`moneyCur`／`pct`，`public/app.js`）；共用樣式住 `public/styles.css`。
- 複審者絕不讀 `data/store.db`（含 `.bak`／`-wal`／`-shm`）與 `data/store.json`（比 RULES B4 子點嚴：套件准 AI 在真實資料上唯讀驗證；本專案刻意照留，放寬先問 William；實作者標註）；缺 `node_modules`＝備樹失敗，停下回報、不自行 `npm install`；動到 money 路徑的支，送審前用隔離的 `STORE_FILE` 重現。
- 給 William 的回報＝RULES J1、J2；不主動貼審查回覆原文（他問才貼）；本專案補充見本檔「回報」節。
- 修不修＝RULES F6；停下來問 William＝RULES F8，F8 那兩個詞哪些算＝下方界線表；磨太久＝RULES F9（範本 `templates/self-review.md`）與 F10（範本 `templates/third-round-self-check.md`）。⚠️ **讓檢查變鬆一律等他**：放寬、關掉、豁免任何一道閘、弱化會進三關／CI 的考題通過條件、或關掉重開 PR 以脫離閘的阻擋——都是「停下來回報」，不是選項題。

**審查回饋處置（本專案的值；規矩正本＝RULES F6、F8、I1〜I3，留痕形狀的正本＝`templates/ruling-record.md`，讀它的機器＝`tools/pending-rulings.js`——開工前跑、只列不擋）**：

- **本 Session 的技術委任（本次裁示的操作化）**：本 Session 的 25 項工程及必要前置，技術裁示由實際 GPT‑6.1 Sol／xhigh 承接；RULES A5 的本人點頭、產品／畫面驗收、個人隱私公開與原錢邊界保留事項仍由 William 本人決定。依[本次待辦觸發裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6208198145)，這個範圍不推廣為其他專案或本人權限的永久移轉；下列歷史引文照留。
- **Codex 實作時，它自己在它的桌面 session 直接問 William**（他用 Codex 桌面派工，有直接管道；2026-09-10 他講的）——但留痕仍要照下面貼到該 PR：開工時印「問了還沒回」的工具掃的是 PR 留言、看不到桌面上的對話。
- 問法＝RULES I1；沒有時限＝RULES I2（本專案的落點：William 2026-09-10 裁，原話逐字「a＝拿掉時限，問了就等我」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/595#issuecomment-5617637892）。
- **留痕＝照 `templates/ruling-record.md`**（貼在哪、不編輯、一題一則、原話行、網址位置、撤回條件、「他的話比我的撤回大」、待裁未結不得合併——全在範本與 RULES I1〜I3、A5，這裡不抄）。本專案的值只有三個：①**轉述者＝實際轉述的那一方**（Claude 實作的支由 Claude 轉述；Codex 實作的支由 Codex 自己問、自己貼、如實署名）；②「❓ 網址寫在開頭那一段」的本專案落點＝William 2026-09-07 裁「a」，原話逐字「a」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/579#issuecomment-5570875993 （範本的「開頭那一段」就是它的操作化）；③七段的「要你裁示的」照常問他、並附 ❓ 的網址。⚠️ 切換紀錄（2026-09-17，搬家第 6 步）：舊制的 `⏳ 逾時暫定` 留言（2026-09-10 前）套件工具不認、也不再有新的；#577 那兩題的舊 ⚖️ 裁示（https://github.com/teacherjung/personal-finance-webapp/pull/578#issuecomment-5560007140 、https://github.com/teacherjung/personal-finance-webapp/pull/577#issuecomment-5560008679 ）形狀不合範本、套件工具會把那兩題列成還沒回，已照搬家第 12 題 d 重貼成一題一則的範本形狀（https://github.com/teacherjung/personal-finance-webapp/pull/577#issuecomment-5714673951 、https://github.com/teacherjung/personal-finance-webapp/pull/577#issuecomment-5714674364 ），套件讀法不放寬。

**界線表（William 2026-08-14 裁定；管 RULES F8 的「判準」「金額口徑」「架構」三個詞）**：只有「判準／金額口徑／架構」三個詞是不夠的——**「不確定就問」擋不住 AI 很有把握地分錯類**（分錯的當下不會覺得自己不確定）。所以界線寫出來：

| 詞 | **算**（停下來問 William） | **不算**（**實作者**自己判斷；⚠️ 2026-09-10 之前這一格寫死 Claude） |
|---|---|---|
| **判準** | 「什麼算什麼」的規則本身：分類判準、門檻數字、**考題的通過條件** | 把程式**修回既有契約**——那是修實作，判準本身沒動 |
| **金額口徑** | 金額怎麼算出來、怎麼呈現：元／萬、正負號、四捨五入、含不含稅。**純顯示格式也算** | 與金額無關的文案與樣式 |
| **架構** | ①**模組邊界／資料流向／欄位歸屬，任一有改就算**——新增、移動、**刪除、縮減**都在內（抽成新模組、把函式從模組 A 搬到 B、刪掉一個沒人用的模組、收掉一個 exported 邊界，全部算）②**三維之外，任何改變「程式怎麼跑」的也算**：執行方式、部署、併發、排程、快取層…③⚠️ **判不出來屬不屬於架構時，一律當作「算」** | ①②那些**都沒變**的純內部修改才不算。純搬移只是最常見的例子（同檔搬函式、同模組內拆區塊） |

⚠️ **架構那一列刻意寫成「補集＋兜底」，不是列舉**（William 2026-08-14 第二次裁定）。
   ①是他原本給的三維；②③是這次補的——因為**列舉維度也會補不完**：
   把同一套服務從單一行程改成多行程，模組邊界、資料流向、欄位歸屬**一件都沒變**，
   卻明顯改了執行架構（`Codex #457 r5` 的反例）。
   ⚠️ **③才是真正關門的那一句**：以後再冒出第四、第五種沒人想到的情況，它會自動落在
   「要問 William」那一邊，而不是被 Claude 當成可以自己決定。**取捨方向＝寧可多問，不可漏問**
   ——漏問的代價是我替他拍了他沒授權的板，多問的代價只是他多回一句。（**沒回＝等他**，沒有時限、也沒有逾時預設——見上方「審查回饋處置」；⚠️ 2026-09-10 之前這裡寫「時限內沒回＝照建議預設暫定、可翻案」。）
   ⚠️ **不要再改回「有沒有新增什麼」那種問法**：刪掉一個模組、收掉一個 exported 邊界、
   把欄位改歸屬、把一個工人變成五個工人，全都沒有「新增」任何東西，卻都是架構改動。
   （這一族 `Codex #457` 連三輪抓到：r3 判準縮成「有沒有新模組」、r4「刪除／縮減」掉在兩欄之外、
   r5 三維之外還有一整類——**列舉補不完，所以最後靠③關門**。本專案認過的病型：
   列舉繞法補不完就要關門。）
⚠️ **「純顯示格式也算」的理由**（起草時的推論，不是 William 的原話；規則本身才是他拍板的）：
   使用者是照**畫面上的數字**做決定的。
⚠️ 這張表是**下限、不是窮舉**。落在表外又說不準的，走 RULES F8 的第一種（實作者不確定就問）——列舉補不完是本專案認過的病型，所以這裡不追求窮舉，只把已知會分錯的四個灰帶釘住。

**角色分工（本專案的值；Claude／Codex 的角色＝RULES A1〜A5，平常誰實作、誰複審＝`settings.json` 的預設分工）**：

| 角色 | 主要責任 | 不負責 |
|---|---|---|
| William | 產品決定、需求優先序、畫面驗收、合併前的兩種例外（叫停、改到禁區清單的 PR 點頭，RULES A5）；**審查回饋的例外**（清單刻意不複述在這裡——見「審查回饋處置」） | 不需判斷程式實作細節；**一般的審查回饋修不修不必問他**（2026-08-14 起由**實作者**判斷；⚠️ 2026-09-10 對稱化前這裡寫死 Claude） |
| Grok | 教學線「外部記者」三職：腳本查核／選題雷達／就地解釋文案讀者測試；程式線＝**唯讀顧問（個案）**及**暫代正式複審（2026-10-15 本人指示）**；操作與界線見下方「Grok（本專案）」 | 正式程式實作、轉正式與合併；不進任何 repo 樹，採隔離材料制；X 輿情不得用於投資決策線 |
| Gemini | 程式線的**複審後掃**；透過固定官方網頁傳輸及隔離材料流程，操作見「Gemini 接線驗證與啟用」 | 不持有登入憑證或真實資料；不做正式複審、程式實作、轉正式或合併；回覆不能指揮工具或瀏覽器 |
| 工讀生×2（教學線，人類；2026-08-17 入列） | 教學影片的**製作與營運**：詞彙短片量產線（圖卡／配音合成／剪輯／品檢／YouTube 上架／頻道數據）＋EPxx 正片線的剪輯與上架＋生產看板（Notion 財金詞彙庫）維護（完整邊界與治理＝教學影片 repo（`../teaching-videos/`，GitHub `teacherjung/teaching-videos`） 的 `AGENTS.md`「治理」節，此處不重抄——**該線 2026-08-25 已分家獨立，規矩層不在本 repo**） | 一切程式實作、正式複審與合併；**不進 repo、無 GitHub 權限**（**與本 repo 的接點一律經 `docs/learning-hub-contract.md`**——它涵蓋 EPxx 與詞彙短片兩條產線，不只詞彙牆 metadata；2026-08-25 分家後這句原本仍寫舊的窄射程，`Grok 掃 #3` 抓到）；不接觸真實財務資料（`data/store.db`）與券商帳號憑證；語音合成與分身生成有閘（判準全文＝該檔「治理」節，**此處刻意不重抄**——重抄過一次就漂成較鬆的一份，`Codex #487 r2 High②`）；分身素材僅 EPxx |
| CI | 型別、格式、考題的自動守門 | 不判斷產品是否好用、金額口徑是否符合使用者的意思 |

- **掃描發射者與轉正式**（RULES A1、G4）＝`settings.json` 的 scanner 指定。能力登記只涵蓋同一已驗入口；換提供者版本須重做資格，協作者不能用舊 Grok 路徑或未驗宿主代替。具體設定與套件借用的過渡處理見[GPT‑6.1 Sol 技術裁示](https://github.com/teacherjung/personal-finance-webapp/pull/701#issuecomment-6234303771)。

### 回報（RULES J1、J2、J5）

- **套件的共通規定（2026-10-10 整批同步起；2026-10-11 第二支把本節跟它們重複的原文改成指路）**：七段版面與發出前的核對＝RULES J1 與 `templates/progress-report.md`；回報用白話＝RULES J2；進度摘要＝RULES J5；放哪、已結束的留幾天＝`settings.json` 位置表 J5 那一列。本節下面只留套件沒寫到的（本專案多加的、檔名為什麼用英文與 E6 的射程、決定的落點 `PROJECT.md`、各條的出處與沿革）；跟它們不一致的，以它們為準。
- **第八行「進度摘要」**（William 2026-09-21 裁；**同日稍早那條「語音回報檔」由他當場取消、由這一條取代**——他要改用 Codex 的語音功能唸，不要 Claude 自己做音檔）：規定本身＝RULES J1 與 J5「回報最後一行」那一點，這裡不複述。沿革：他當時裁的是**只在本專案、不進套件**；2026-10-05 他另裁改放進套件（套件 #39 留言 5995755141、落點套件 #41）。回報時那一格寫「已更新（時間）」原本是實作者的操作化（當時他沒有裁那一格要寫什麼）；2026-10-06 他答要不要附摘要連結時說「不附，且不要顯示年跟地點，單純月日時間就可以了」（AGENTS.md 常設指示「回報最後一行」；現行寫法＝J5）。
- **那份摘要檔放哪、叫什麼＝實作者選的**（09-21 當時他沒有裁位置；現況見 `settings.json` 位置表 J5 那一列）：**本專案主目錄的上一層**（跟倉庫同層、**不在本專案的倉庫裡**），檔名 `progress-summary.md`。⚠️ **檔名用英文**＝照 **RULES E6**（原文：「檔名只用英文字母、數字、半形符號。」）；2026-09-22 裁示者也指出了這件事（**實作者轉述，沒有原話也沒有留痕**）。⚠️ 射程只講得到這裡：**守 E6 的那支考題**（`test/doc-naming.test.js`）掃的是 `git ls-files`，**掃不到**這份倉庫外的檔——所以這一條在這裡**靠自覺、不是機器抓得到的**。⚠️ **E6 本身沒有「只管被追蹤路徑」的限定**，不要把考題的射程讀成規則的射程（#632 r3：掃描器這樣講，實作者照收，結果把一條真的規則寫成不適用——**已更正**）。至於「它在倉庫外所以可以中文」，那是**實作者自開的例外、沒有問過他**。理由（不放進本專案倉庫）：放進來會讓每次更新都污染變更紀錄，還得動 `.gitignore` 與它的登記考題。⚠️ **刻意不寫絕對路徑**——公開倉庫不寫機器路徑（2026-09-21 為這件事退過一輪）；要用的人在對話裡問。
- **他當場裁的三件**（出處；規定本身現在照 RULES J5 的「更新」「寫什麼」「清什麼」三點與 `settings.json` 位置表 J5 那一列，這裡不複述）：①每次回報時同時更新，把回報項目與日期時間記清楚 ②只留最近七天 ③七天只刪「已經結束」的——還沒完成的工作、卡住的問題、等他裁示的事，一直留到處理完，不受七天限制。⚠️ ①的記法與②的天數後來被他改掉（2026-10-07：J5「寫什麼」的新形狀；天數見設定 J5 那一列）。
- **他轉述 Codex 的建議、並要求照做的四件**——⚠️ **效力跟他自己裁的一樣**（他說了要照做，就是要照做）；標出來源只是為了**不要把 Codex 的判斷算到他頭上**，不是說這四件比較軟。四件現在都在 RULES J5，這裡不複述：④目前全貌＝「寫什麼」那一點的全貌 ⑤完成程度與下一步＝八欄的「到哪一步」「現在誰在動」「下一步是」；⑤裡 J5 沒逐字寫的那半句照留（也是他要求照做的）：不可以只寫「等待中」卻不說在等誰 ⑥最後確認時間與證據位置＝八欄的「時間」「證據」；沿革：證據原本可以放在摘要自己的「程序附件」區，2026-10-09 起附件另放一份檔（`settings.json` 位置表 J5 那一列） ⑦更新時機＝J5「更新」那一點（原本四種，現在更多，不是只有回報時）。
- ⚠️ **結案時要把「決定」搬去永久紀錄**（2026-09-22 的一次對話提問帶出來的漏洞——**起因是實作者轉述，沒有原話、沒有留痕**；原本這裡寫的落點與理由是**實作者的操作化**，不是裁示者定的）：2026-10-11 起規定本身照 RULES J5「清什麼」那一點（落點照 I3、K6；K6 的指示檔＝AGENTS.md 常設指示），這裡不複述；下面只留本專案另外的落點與理由（仍是實作者的操作化）。本專案另外的落點：不是常設指示、但「以後別重議」的專案決定，另外寫進 `PROJECT.md` 的「重要決定（已拍板，勿重議）」（提交訊息只能是多一處，不取代 I3 的留痕）。理由：結案的那一則會縮成一行、超過保留天數（`settings.json` 位置表 J5 那一列）就刪掉——只寫在摘要裡的決定之後就不在摘要上（只剩本機小倉庫的歷史，下一個人不會去翻），會被當新問題再問一次。⚠️ **兩者不互相取代**：摘要記的是會過期的進行式，`PROJECT.md` 那一節記的是**不該過期的決定**。（`PROJECT.md` 自己的整體定位見它開頭那幾句，**本條不改寫它**。）
- **回報者的核對責任**（同一次轉述、他要求寫進來；起初寫成「Codex 的責任」，#659 起改成回報者）：規定本身＝RULES J5 最後一點，這裡不複述。
- **摘要怎麼寫**＝RULES J5 與摘要檔頭「怎麼寫」那一段（含「每則白話、不放網址與版本碼（放附件）」那一點），這裡不另寫；唸給他聽的白話化在回報那一層（RULES J2；J2 管回報、不管摘要的欄位，摘要的「動哪些檔」照 J5 寫）（2026-10-11 Fable 代裁：原本這裡「寫成給人唸的散文」那句是實作者的操作化，已被 2026-10-07 的新形狀取代，拿掉）。已結束的清理照 RULES J5「清什麼」與 `settings.json` 位置表 J5 那一列（現在 30 天），由更新者寫的時候順手清——**Claude 沒有為它做任何排程或背景程式，本倉庫裡也沒有**（⚠️ 射程只到這裡：倉庫外、這台機器上有沒有別人裝的東西，**沒有查過**）。
- ⚠️ **誠實劃界**：那份檔不在本專案的倉庫裡（在哪＝`settings.json` 位置表 J5 那一列），**本倉庫的考題、閘與 PR 的 diff 都看不到它**；哪些有檢查工具列出、哪些靠自覺，照 RULES J5 的標籤，這裡不複述。⚠️ 這不等於「不可能有人看」——**人把那份檔打開就讀得到**；但**本專案的審查流程看的是 PR 的 diff，所以走那條流程看不到它**。
- **七段的版面細節**（他 2026-08-29 立、09-01 拍板全 session 適用、09-04 親自定稿；2026-09-22 照 RULES K1 從 `CLAUDE.md` 搬來；2026-09-28 隨套件第二輪 J1 從六段改成七段；2026-10-11 第二支起改成指路）：標籤框法、順序、空行與其餘版面和發出前的核對＝RULES J1 與 `templates/progress-report.md`（標籤 2026-10-06 起照 AGENTS.md 常設指示「回報標籤」改成【】、取代原本的粗體；「審查點與裁示問題各用一行清單」2026-10-06 起照常設指示「回報用清單」可以有子項目），這裡不複述。範本「附件連結發出前先查」那一點的由來（案例簿不同步）：⚠️ 附件那一段的每個網址**發出去之前先查一次**，不憑印象寫編號——2026-09-21 踩過，給了他一個編出來的留言編號。「其餘細節他問才講」那一點，他的原話：「我看不懂 or 你回報的內容太多了看不完」「盡量減少給我閱讀上的負擔」。
- **第七段的標籤**（他 2026-09-27 晚上的原話：「程序的附件：回報的時候，這幾個字應該也要粗體」；2026-09-28 起那個標籤照 RULES J1 叫「附件」）：2026-10-06 起跟其餘六個一樣照範本「用【】框起來」、不加粗體，這句原話只留作出處。
- ⚠️ 空段寫「沒有」**不在**本節，它是 RULES J1 本身的規定。

### 複審模型

- **次強模型的用途**：`settings.json` 的 `reviewers.second` 供發審者依 RULES F11 選用；送審產生器只代入 `strongest`，不是 CLI 自動 fallback。

- **2026-10-15 UTC 本人更新**：「目前Opus用量也用完了，複審能不能先暫時改成Grok」。[本人留痕](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6185994165)。操作化：沿用理財專案範圍，正式複審暫改 Grok；模型與角色接法須符合本節的隔離界線及專案設定。這段暫時安排取代下列 Opus 優先與耗盡改 Fable 的沿革，不更改套件的常設模型；本人另答「同意，本次套件前置修正也用 Grok（建議）」的單次範圍，見[本人留痕](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6187163947)。
- **沿革（2026-10-13 UTC）**：「複審幫我改用Opus模型」（[本人留痕](https://github.com/teacherjung/personal-finance-webapp/pull/679#issuecomment-6137507759)）；本人另選「只改理財專案（沿用目前範圍）」及「照既有程序改用 Fable，並回報」。

### Gemini 接線驗證與啟用

- **本人 2026-10-18 更新優先適用**：網頁掃描中止，改準備官方 CLI 的可信任協作者複審與 Grok 隔離掃描；[授權與驗收](gemini-cli-review-plan.md)。以下原生掃描與網頁掃描段落保留為歷史入口契約，不構成恢復掃描的授權。新分工須完成驗證並經本人另行確認才正式啟用；設定中尚存的網頁登記不能推翻停止指示。
- **原生候選準備**：不含真認證的程式與合成驗證依 [施工計畫](gemini-native-formal-plan.md)。`scripts/gemini-native-runner.js` 的正式入口在啟動之前拒絕，這個準備階段不綁定 scanner；先前私人合成試跑的真 HOME／Keychain 暫例不延用。本人核定認證政策、核實模型資格及完成原生整體隔離驗收後，另補正式發射器與設定接線。合成考題及來源磁碟快照不能代替 OS 隔離、已載入程式身分或 G1 實跑證據。
- **A 政策網頁接線**：沿用本人既有帳號及官方 Gemini 網頁登入，依[網頁正式掃描計畫](gemini-browser-formal-plan.md)操作；scanner 模型及推理登記 `4 Argon`／`High`。盒內 client 持有整輪狀態機；固定盒外 runner 與 CUA adapter 以新挑戰、一次性附件上傳許可與一次性送出許可交接，只處理本場提交材料與回覆。`browser-codeblock-ui/v1` 是官方畫面的可見來源觀測，不冒充原生事件或平台簽章。資格場、獨立複審、正式用途合成驗收及 G1 分開記帳；缺同版完整資格、來源釘值或任一場隔離收據均不得採用。這是有操作者的固定流程，不宣稱無人值守。

- 啟用順序依 [GPT‑6.1 Sol 技術裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6190135649)：先用固定候選版完成能力與隔離驗證，再綁定掃描者設定並重新驗證，才啟用。驗證過程不算任何 PR 的正式複審或 G1 掃描；掃描登記與實際完成證據分別核對，不能只看接線檔案存在。
- **網頁正式入口**：先核獨立保存的預期指紋，再以絕對路徑啟動固定盒外 launcher；由同版 CUA loader 依序呼叫 `beginBrowserScan`、`uploadBrowserScan`、`submitBrowserScan`、`captureBrowserScan`，取消走 `cancelBrowserScan`。部署固定受掃 repo、base/head、提示、Node、提供者完整來源及資格收據，不能用環境或一般 CLI 旗標補值。單一 UTF-8 文字附件上限 2 MiB（2,097,152 bytes），固定短提示另計、上限 4 KiB（4,096 bytes；本機傳輸界線，非平台容量宣稱；擴容驗收見[容量計畫](gemini-browser-capacity-plan.md)）；超量拒收、不截斷、不拆成多次充作一次掃描。每場只送一次、只採完整唯一回覆及同回覆官方 `Used 4 Argon 高` 明細，任何條件不合即依 G3 記未執行。實體部署路徑及原始證據只留本機。
- **原生來源沿革（未啟用）**：`scripts/gemini-auth.js` 的 `PUBLIC_CLIENT_SOURCE_PIN` 與[原生來源裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6191504939)只約束原生候選；不授權啟動登入、讀取真憑證或替代網頁入口。網頁傳輸不讀 OAuth client 配置、cookies、tokens 或 Keychain 登入秘密。
- **資料界線與借用遷移**：只處理已提交的靜態材料，模型回覆不當成已執行考題或正式放行；不因診斷改帳號、scope 或計費。套件原有 Grok 借用入口在理財 scanner 切換後不相容，須另由套件工作線更新專案自有設定及指路，模型、推理、wrap、禁區仍引用理財正本。遷移完成前依 G3 寫「未執行：借用掃描入口尚未完成 Gemini 遷移」；不得以額外設定、舊工作樹或 review 用途暗留另一套 G1 掃描。

### Grok（本專案）

- **配方雜湊的射程**：`scanScriptSha256` 是建盒前從本機磁碟讀取的 `scripts/grok-scan.js` 檔案雜湊，不表示已載入的程式映像或完整相依的執行身分；配方也不能用它作完整身分證明。固定 provider 的前後清單只支持各次核對所列檔案的範圍，載入時釘值及全部相依記帳另排，見[本次待辦觸發裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6208198145)。

- **用量回報**：Grok 帳號的額度、429 回應與用量細節只留本機；公開 PR 的未執行紀錄只寫概略原因，不附帳號或原始回應。
- **模型與推理的角色分離**：Grok 正式複審使用 `settings.json` 的 reviewers 登記及產生器的明確參數；Gemini G1 使用 scanner 登記。Grok profile、中繼與正式 review 入口保留；`scripts/grok-scan.js` 的歷史 scan 用途讀 scanner，不能在 Gemini 登記下作為替代掃描入口。
- **身分與管道**：William 機器裝有 Grok CLI（xAI）。它的正式工作通道都在 repo 外（材料制），站外 session 只能看發稿者提供的材料。查核、顧問與掃描材料要載明該次適用的界線；界線前綴的逐字正本＝教學影片 repo `../teaching-videos/AGENTS.md`「Grok 材料檔標準邊界前綴」節，這些材料逐字照抄那四行，本 repo 刻意不另存副本。正式複審依下一條的送審範本與基底規則材料。專案對它維持「未信任」預設。
- **暫代正式複審（2026-10-15 本人同意；技術接法＝[Sol 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6186173332)）**：機械身分為 Grok／Grok CLI，模型與推理由 `settings.json` 的 reviewers 那列明確指定。先用 `tools/review-launch.js` 備本輪樹與提示，再依它印出的指令經 `scripts/grok-review.js` 核對本輪資料；不得直接起 CLI。入口借用 `scripts/grok-scan.js` 的 OS 隔離、試探、釘值、中繼及掃後比對，以正式 review 用途備基底、受審版、突變副本、差異、公開平台材料與雜湊清單；此用途不套用掃描選題提示。盒內無原倉庫 .git，版本依外層核過的清單表示，不能假稱盒內做過原倉庫 Git 核對。審查材料唯讀由提示與前後雜湊核對約束，突變只改另備副本，不宣稱檔案系統唯讀。GitHub 憑證不進盒，Grok 的完整最後回覆依固定範本以結論標頭起首、文末單獨寫未貼。入口保留完整 CLI 對外輸出，並從同份已驗日誌辨認完整最後回覆，分列雜湊與位元組對應；不裁切回覆自身前言。安全鏈、身分、版本、完整性與格式均通過後，依下列私有原件／公開投影契約在盒外發布，並依 F7 核對。發起仍指定 reviewers 登記的最強模型與最高推理，不另開自動降級程序；模型資格依 AGENTS.md 的 2026-10-15 [本人更新](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6190624197)及 `scripts/grok-scan.js` 的有限資格表（適用理財及本次套件前置修正），接受已登記的 4.6 以上單一或混合模型。收據分列指定值、解析所得集合、資格下限與資格結果；未知、低版本、零模型、不完整或損壞仍拒絕，資格通過不等於內容結論通過。不能啟動時回報原因。正式複審與 G1 掃描分開計，掃描發射者不因本次模型安排變更。
- **私有原件與公開路徑投影**：依[本人 B 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/702#issuecomment-6246727209)保留 Grok，修改正式收件契約；這不是放寬 Gemini 憑證分離。完整 stdout／final 先驗安全鏈、選取與有限解碼憑證，再以父程序 launch、manifest 及 workspace 交叉核定本場路徑，按[投影計畫](grok-review-projection-plan.md)的固定政策處理。只替換明列的根或字面示例，保留相對檔名、行號、指令與診斷；未知或編碼路徑仍交嚴格公開檢查拒收。原件、投影與 UTF-8 區段證明私存且不可覆寫，收據分列原始／公開摘要與來源指紋，最後建立。發布本文是完整公開 final 加固定「發審者附記（非 Grok 原文）」，明示投影不是逐字原文；盒外重算並逐 byte 核對全部未改文字及平台回讀後才跑 F7。正式通過前不普遍啟用，舊拒收結果不得追認；首次受控自舉複審依[Sol 技術裁示](https://github.com/teacherjung/personal-finance-webapp/pull/702#issuecomment-6246824717)。
- **合成與固定系統文字的回覆檢查**：`scripts/grok-review.js` 只豁免各自由獨立單對反引號完整包住的 `/tmp/probe-write-test`、`/tmp/mut1.out`、`/tmp/probe-write-test: Operation not permitted`、`/tmp/mut1.out: Operation not permitted`，以及 `/Users/sample`、`/Users/synthetic`、`/Users/someone`、`/Users/Shared`。暫存字面值及固定診斷依 [Grok 合成命令回饋](https://github.com/teacherjung/ai-collab-kit/pull/108#issuecomment-6197466471)與 [GPT‑6.1 Sol 固定診斷裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6198722397)；合成名稱與固定系統位置依 [Sol 精確文字補充裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6201562609)。冒號、空格、大小寫與固定診斷逐字匹配；合成名稱與系統位置只准該字串本身，不准附診斷、子路徑或其他尾文。憑證先查，例外只在原始文字識別，不把解碼後的文字當例外；未命中例外的文字依[有限解碼裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6201957907)檢查：最多三輪同步 ASCII 解碼，每個視圖核對本機路徑與憑證，只作拒收、不重套例外。過深、畸形或超出支援 byte 的候選會拒收，可能連合法技術示例也被拒；這不是任意編碼辨識器。這只管回覆與完整 stdout 的文字檢查，原文與雜湊不改、輸入材料的檢查不放寬，也不授予任何檔案存取權。缺安全或完整性收據的輸出仍不能採計；修正檢查後也不得追認舊的未受理結果。
- **歷史通過的解除證據**：換版或換手要採計既成解除時，由 F7 收件者核對當時真實實跑證據並公開收據；格式與限制見 [結論閘檔頭「F7 當版核對收據 v1」](../tools/gates/check-review-verdicts.js)。缺據依閘的修法補當版通過或既有真實收據，不能用今天重跑冒充過去的 PR HEAD。
- **教學線三職**（操作面分兩處）：①**查核記者**＝腳本名詞／數字／案例查核；②**選題雷達**＝每集開工時跑一次，X 輿情只回答「散戶最近在誤解什麼」供選題——**不得產出持股輿情、行情判斷或任何進入投資決策的資訊**（錢的絕對邊界規則 5 的延伸）；①②的操作面在教學影片 repo 的 `AGENTS.md`。③**讀者測試員**＝本 repo 的 app 就地解釋等文案定稿前扮零基礎讀者、回報哪句看不懂——產線在這裡；它與工讀生的讀者測試站射程不同、互不取代，見 `docs/learning-hub-contract.md` 第三節。三職都不需 repo 權限，材料由發稿者抽出來給它。
- **複審後掃的通用紀錄**（RULES G1〜G4）：第一次正式通過後、轉正式前由登記發射者使用 Gemini 入口處理一次；紀錄照 `templates/scan-record.md` 寫在 PR 說明的「### 複審後掃」下，逐條判定由實作者負責。歷史 Grok 掃描紀錄不改，舊 CLI 呼叫不作現行 G1；Grok 正式複審仍依本節材料制入口與隔離條款。
- **主目錄禁區（隱私線，任何模式無例外）**：不得在主目錄工作——`data/store.db` 有真實餘額、IB flexToken、證件號，Grok 讀到的內容會送往 xAI 伺服器。現行條款下 Grok 本來就**不進任何樹**（上一條，材料制）；本條是兜底鐵線——連「在主目錄啟動它的 CLI」都算違規。
- **全域段落一體適用＋先規矩後開門**：錢的絕對邊界、鐵則、協作唯一不變量寫明「適用所有 AI」，Grok 含在內。要讓 Grok 承接本段以外的任何工作＝先在本段補上角色與邊界、William 拍板，才開門。
