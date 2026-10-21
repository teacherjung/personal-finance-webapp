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
  | `榮祥森（投資理財）-claude` | 歷史 Claude 實作目錄；現行分工不在此啟動新實作 | 功能分支（`git checkout -B <branch> main`） |
  | `榮祥森（投資理財）-codex` | **Codex 實作**（2026-08-04 轉職；原唯讀審查樹） | 功能分支（`git checkout -B codex/<分支> origin/main`） |
  | 送審產生器建立的 `tree`／`mutation`（歷史命名：`/private/tmp/codex-review-pr<N>`／`/private/tmp/claude-review-pr<N>`） | **審查與突變副本（拋棄式）**：Codex 備樹，Grok 透過下方正式複審入口收盒內材料，不進原樹 | **detached** 釘住受審 commit；實作者備樹、審完收樹 |

  - ⚠️ **審查樹必須 detached 釘住受審 commit**（避免審查途中分支移動）。實作者用 `node tools/review-launch.js <編號> --reviewer Grok --dir <資料夾>` 建立同輪的 `tree`／`mutation` 與啟動紀錄，再依下一條掛 `node_modules` symlink；Grok 正式入口會核對這些路徑，不能用歷史角色目錄取代。審完先移除兩棵樹的 symlink 本身，再用 `node tools/review-launch.js --close <編號> --dir <資料夾>` 核對乾淨與版本後收樹。
  - ⚠️⚠️ **`node_modules` 的 symlink：只准建、不准動**（2026-08-02 事故）。做法是 `ln -s "<主目錄>/node_modules" "<worktree>/node_modules"`（純 JS 相依，不必各裝一份），但**在任何 worktree 裡刪除、重裝、或 `rm -rf` 那個 symlink 的內容，動到的是主目錄本身**——使用者的 app 會立刻起不來（`Cannot find package 'express'`），而錯誤訊息完全指不到真因。實際踩過：清理暫存 worktree 時刪除動作順著 symlink 進去，主目錄的 `node_modules` 被清空。**移除 worktree 前先 `rm <worktree>/node_modules`（不帶斜線＝只刪 symlink 本身）**；分工統一（2026-08-04）：**純閱讀、不跑三關的分析不需要 node_modules、可不建**；正式審查要跑三關＝**由實作者備樹時建、收尾時 unlink，複審者不得自行建立／安裝／移除**。三道關與 pre-push hook 都照常運作（`core.hooksPath` 是 repo 層設定，worktree 自動繼承）。
  - ⚠️⚠️ **`.gitignore` 必須寫 `node_modules`（不帶斜線）**——symlink 對 Git 不是目錄，帶斜線擋不住，`git add -A` 會把它連本機絕對路徑收進 commit（2026-07-19 實踩：symlink 進了 PR #136 且 CI 全綠——別指望三道關攔這種東西）。worktree 裡建任何 symlink 前先 `git check-ignore -v <path>` 確認擋得住。
  - ✅ **順帶補強鐵則 1**：`data/store.db`（真實餘額、IBKR flexToken、`pdfPassword`＝身分證字號）只存在主目錄，實作與審查 worktree 的 `data/` 只有 `seed.json`——「不要讀 store.db」從君子協定變成**樹內根本沒有那個檔＝防誤觸**。**要守住這一點，在 worktree 開 App 預覽一律把 `STORE_FILE` 指到這次預覽專用的暫存資料夾**（William 2026-10-15 裁「A 改做法」）：先用 `mktemp -d /private/tmp/preview-XXXXXX` 開一個新資料夾，再用 `STORE_FILE=<那個資料夾>/store.db` 啟動。不加的話，第一次開頁 App 就在那棵樹的 `data/` 從 `seed.json` 長出 `store.db`（連同 `-wal`、`-shm`）、`store.db.bak`、`store.db.pre-ledger-migration.bak`、`backups/`（2026-08-05 在 `-codex` 樹、10/11 在一棵暫存樹都實際長過）；加了，這些全都跟著放到 `STORE_FILE` 所在的資料夾。每日備份只看資料夾、不看檔名，所以每次預覽都要用自己的資料夾：幾次預覽共用同一個資料夾、只換檔名，會互相蓋掉當天的每日備份（`Codex #691 r1` 實測）。看到 worktree 的 `data/` 有 `store.db`＝有人漏加：多半是從 `seed.json` 長出的示範庫，但檔案本身證明不了（樹裡有較新的 `data/store.json`、或有人在預覽裡匯入過真實資料，內容就不是示範），所以照樣不讀、要查只比對大小、時間、雜湊，刪不刪問 William。⚠️ 這不是對「會跑指令的未信任程序」的隔離保證：worktree 只是另一個 checkout、循路徑仍摸得回主目錄——所以 Grok 一律不進樹（見本檔「Grok（本專案）」段）；Codex／Claude 的樹紀律靠角色授權＋審查制度，不是把這道防誤觸當安全牆。
  - 常設 Codex 實作樹的建立指令＝`git worktree add ../<repo>-codex -b codex/<分支> origin/main`；先用 `git worktree list` 確認是否已有可沿用的實作樹。拋棄式審查樹的建立與移除都經上方送審產生器，保留同輪紀錄與收樹核對。
  - ⚠️⚠️ **實作＝常設樹、審查＝拋棄式樹、絕不動主目錄**（William 2026-08-04 拍板統一；起因＝同日兩次實測 Codex 桌機直接在主目錄開工——主目錄被切到功能分支、本機 `main` 一度被改名消失，使用者的 app 收不到後續合併、重啟捷徑的自動同步也靜靜跳過）。**Codex 實作＝在常設 `-codex` 樹**，開工第一步＝`git fetch origin && git checkout -B codex/<分支> origin/main`；首次實作前照上方紀律掛 node_modules symlink。**審查一律在拋棄式樹**（上表；實作者備樹，Grok 收盒內材料）。全程不得在主目錄 checkout、commit 或改動任何分支。William 的指派詞也會帶提醒，但**規則以本檔為準、不依賴指派詞**。
- **換手儀式**：換另一個 AI 動工之前，先把目前的改動 commit（可由完工方自行 commit；接收另一位留下的未提交改動時，先審查再 commit 並以 Co-Authored-By 標明原作者，正式複審仍依本支分工）。分了 worktree 之後兩邊可以同時工作，但**同一個 worktree 仍然只有一個 agent 動**。
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
- **Codex 審查的歷史接法（2026-07-27 立、2026-08-03 擴充）**：本專案現行正式複審用 Grok，以下接法須本人另行指定才使用；舊安排由 Claude 直接用本機 `codex` CLI 起審查、不必先問——PR 進行中的每一輪複審，與每批合併進 main 後的例行審查。指令列＝`codex exec -m <當輪最強模型> -c model_reasoning_effort='"<最高推理>"' -s workspace-write -c sandbox_workspace_write.network_access=true -C "/private/tmp/codex-review-pr<N>" - < <提示詞檔>`（模型與推理依 AGENTS.md 常設指示 C28：發審者每輪依平台當時提供的模型與推理等級清單核對，明確指定最強模型、最高推理；不使用 auto 選模／推理或自動升降級模式，判不出最高者先問 William；歷史設定 gpt-6-astra／xhigh 是 William 2026-09-07 的裁示、落點＝https://github.com/teacherjung/personal-finance-webapp/pull/579#issuecomment-5574063644 ；設定寫在指令上、不動 `~/.codex/config.toml`；網路要開，否則綁 localhost 的端點測試被沙箱擋掉 `listen EPERM`；其餘一律這組設定、AI 不可自行分類降級）。審查樹由實作者備與收，複審者不得自建 worktree；diff 一律 `git diff -M origin/main...HEAD`。
- **送審提示詞＝RULES F3 與 `templates/review-request.md`**；本節仍是本專案複審必讀文件，來源字串的標準表＝`PROJECT-SETTINGS.md`。複審必驗清單「看情況查」的本專案落點：金額顯示走共用格式器（`money`／`moneyCur`／`pct`，`public/app.js`）；共用樣式住 `public/styles.css`。
- 複審者絕不讀 `data/store.db`（含 `.bak`／`-wal`／`-shm`）與 `data/store.json`（比 RULES B4 子點嚴：套件准 AI 在真實資料上唯讀驗證；本專案刻意照留，放寬先問 William；實作者標註）；缺 `node_modules`＝備樹失敗，停下回報、不自行 `npm install`；動到 money 路徑的支，送審前用隔離的 `STORE_FILE` 重現。
- 給 William 的回報＝RULES J1、J2；不主動貼審查回覆原文（他問才貼）；本專案補充見本檔「回報」節。
- 修不修＝RULES F6；停下來問 William＝RULES F8，F8 那兩個詞哪些算＝下方界線表；磨太久＝RULES F9（範本 `templates/self-review.md`）與 F10（範本 `templates/third-round-self-check.md`）。⚠️ **讓檢查變鬆一律等他**：放寬、關掉、豁免任何一道閘、弱化會進三關／CI 的考題通過條件、或關掉重開 PR 以脫離閘的阻擋——都是「停下來回報」，不是選項題。

**審查回饋處置（本專案的值；規矩正本＝RULES F6、F8、I1〜I3，留痕形狀的正本＝`templates/ruling-record.md`，讀它的機器＝`tools/pending-rulings.js`——開工前跑、只列不擋）**：

- **本工作線的技術委任**：`finance-handoff-20261018` 承接的 25 項工程及必要前置，依[本人原話指派](https://github.com/teacherjung/personal-finance-webapp/pull/689#issuecomment-6161914097)交實際 GPT‑6.1 Sol／xhigh。設定正本是 `settings.json` 的 `rulingAssignments` 路由 `session25-technical`，人讀表由 `PROJECT-SETTINGS.md` 產生；裁示／撤回格式照 `templates/ruling-record.md`。RULES A5 本人點頭、產品／畫面驗收、個人隱私公開與原錢邊界保留事項仍由 William 本人決定。此指派不推廣為其他工作線的永久移轉，也不改 Grok 正式複審資格。
- **本輪理財待辦委任**：依[本人本輪原話](https://github.com/teacherjung/personal-finance-webapp/pull/708#issuecomment-6253454472)，技術裁示走 `finance-backlog-20261019`，交實際 GPT‑6.1 Sol／xhigh；推薦代選不冒稱本人實看。較早暫停同步的[原文](https://github.com/teacherjung/ai-collab-kit/pull/111#issuecomment-6252361888)保留，必要同步前置與待辦施工順序依[本輪技術解讀](https://github.com/teacherjung/personal-finance-webapp/pull/708#issuecomment-6253484711)，不改成 William 曾說「取消延期」。手機、雲端與理財 Gemini／掃描線照原停止指示。
- **未另行指派或屬本人保留事項時，Codex 在桌面 session 直接問 William**（他用 Codex 桌面派工，有直接管道；2026-09-10 他講的）——但留痕仍要照下面貼到該 PR：開工時印「問了還沒回」的工具掃的是 PR 留言、看不到桌面上的對話。
- 問法＝RULES I1；沒有時限＝RULES I2（本專案的落點：William 2026-09-10 裁，原話逐字「a＝拿掉時限，問了就等我」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/595#issuecomment-5617637892）。
- **留痕＝照 `templates/ruling-record.md`**（貼在哪、不編輯、一題一則、原話行、網址位置、撤回條件、「他的話比我的撤回大」、待裁未結不得合併——全在範本與 RULES I1〜I3、A5，這裡不抄）。本專案的值只有三個：①**轉述者＝實際轉述的那一方**（Claude 實作的支由 Claude 轉述；Codex 實作的支由 Codex 自己問、自己貼、如實署名）；②「❓ 網址寫在開頭那一段」的本專案落點＝William 2026-09-07 裁「a」，原話逐字「a」，落點＝https://github.com/teacherjung/personal-finance-webapp/pull/579#issuecomment-5570875993 （範本的「開頭那一段」就是它的操作化）；③七段的「要你裁示的」依當時有效指派詢問裁示者，本人保留事項問 William，並附 ❓ 的網址。⚠️ 切換紀錄（2026-09-17，搬家第 6 步）：舊制的 `⏳ 逾時暫定` 留言（2026-09-10 前）套件工具不認、也不再有新的；#577 那兩題的舊 ⚖️ 裁示（https://github.com/teacherjung/personal-finance-webapp/pull/578#issuecomment-5560007140 、https://github.com/teacherjung/personal-finance-webapp/pull/577#issuecomment-5560008679 ）形狀不合範本、套件工具會把那兩題列成還沒回，已照搬家第 12 題 d 重貼成一題一則的範本形狀（https://github.com/teacherjung/personal-finance-webapp/pull/577#issuecomment-5714673951 、https://github.com/teacherjung/personal-finance-webapp/pull/577#issuecomment-5714674364 ），套件讀法不放寬。

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

**角色分工（本專案的值；角色責任＝RULES A1〜A5；現行 Codex 實作、Grok 複審，與 `settings.json` 的預設分工一致）**：

| 角色 | 主要責任 | 不負責 |
|---|---|---|
| William | 產品決定、需求優先序、畫面驗收、合併前的兩種例外（叫停、改到禁區清單的 PR 點頭，RULES A5）；**審查回饋的例外**（清單刻意不複述在這裡——見「審查回饋處置」） | 不需判斷程式實作細節；**一般的審查回饋修不修不必問他**（2026-08-14 起由**實作者**判斷；⚠️ 2026-09-10 對稱化前這裡寫死 Claude） |
| Grok | 教學線「外部記者」三職：腳本查核／選題雷達／就地解釋文案讀者測試；程式線＝**唯讀顧問（個案）**及**正式複審（現行分工見下方本人更新）**；操作與界線見下方「Grok（本專案）」 | 正式程式實作、轉正式與合併；不進任何 repo 樹，採隔離材料制；X 輿情不得用於投資決策線 |
| Gemini | #730 依本人單輪授權做正式複審；其他 PR 不因這次登記自動啟用；接法見「Gemini 原生單輪複審」 | 不讀真實資料或憑證、不做產品實作、提交或合併；歷史 GN 接線不因本輪恢復 |
| 工讀生×2（教學線，人類；2026-08-17 入列） | 教學影片的**製作與營運**：詞彙短片量產線（圖卡／配音合成／剪輯／品檢／YouTube 上架／頻道數據）＋EPxx 正片線的剪輯與上架＋生產看板（Notion 財金詞彙庫）維護（完整邊界與治理＝教學影片 repo（`../teaching-videos/`，GitHub `teacherjung/teaching-videos`） 的 `AGENTS.md`「治理」節，此處不重抄——**該線 2026-08-25 已分家獨立，規矩層不在本 repo**） | 一切程式實作、正式複審與合併；**不進 repo、無 GitHub 權限**（**與本 repo 的接點一律經 `docs/learning-hub-contract.md`**——它涵蓋 EPxx 與詞彙短片兩條產線，不只詞彙牆 metadata；2026-08-25 分家後這句原本仍寫舊的窄射程，`Grok 掃 #3` 抓到）；不接觸真實財務資料（`data/store.db`）與券商帳號憑證；語音合成與分身生成有閘（判準全文＝該檔「治理」節，**此處刻意不重抄**——重抄過一次就漂成較鬆的一份，`Codex #487 r2 High②`）；分身素材僅 EPxx |
| CI | 型別、格式、考題的自動守門 | 不判斷產品是否好用、金額口徑是否符合使用者的意思 |

- **掃描發射者與轉正式**（RULES A1、G3、G4）：`settings.json` 的 scanner 登記「無」，沒有掃描發射者。Codex 在有效正式通過後記未執行，依 G4 轉正式；不以歷史能力登記或舊提供者恢復 Gemini／Grok 掃描。

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

### 本次分工更新

- **現行分工與掃描｜2026-10-18 UTC**：本人先說「Gemini 尚未登記前仍然交給Grok複審，掃描跳過。等Gemini確定登記複審啟用，在開始使用Grok掃描。」（[原話留痕](https://github.com/teacherjung/personal-finance-webapp/pull/705#issuecomment-6249011463)），其後在Gemini排障線更新：「算了，這條線結束掉。目前就Codex實作Grok複審就好」（[更新留痕](https://github.com/teacherjung/personal-finance-webapp/pull/702#issuecomment-6249335559)）。操作化：Codex實作、Grok正式複審，掃描跳過；停止Gemini工作線，不等待登記或啟用，也不自行恢復Grok掃描。取代下列Gemini角色與掃描啟用安排；既有沙盒、真實資料及憑證界線保持。
- **驗收推薦代選｜2026-10-18 UTC**：本人說「需要我驗收的：全部都幫我選推薦的選項，並繼續工作不要停下來問我。」（[原話留痕](https://github.com/teacherjung/personal-finance-webapp/pull/705#issuecomment-6248889808)）。操作化：產品推薦依此代選並留痕；工具可完成的驗證照程序執行，代選與自動操作不得寫成本人已實看或H6本人驗收通過。與此同則較早的Gemini複審安排，角色部分由上一條更新取代。

本人同日再要求：「請把相關共同規則與設定也統一成 Codex 實作、Grok 複審，避免其他 Session 之後又照舊設定啟用 Gemini。」（[原話與技術核對](https://github.com/teacherjung/personal-finance-webapp/pull/707#issuecomment-6249555794)）。本節與 `settings.json` 為現行分工；AGENTS.md 的 C9、C7 等歷史 Claude／Codex 角色名稱不更改這項分工，正式程序仍適用。

舊指示原話（僅留沿革；角色與掃描由上列本人更新取代，隔離界線保持）：

- **C42｜2026-10-03 UTC 更新**：「掃描啟用」。〔本次操作化〕啟用掃描前試探、掃描後比對；裁示留痕：https://github.com/teacherjung/personal-finance-webapp/pull/659#issuecomment-5971978555 。取代 2026-10-03 UTC 的原話「等等，我反悔了，先不啟用」。
- **本次分工與隔離｜2026-10-15 UTC**：「本人在旁支已決定：Codex 繼續實作，正式複審暫用 Grok，掃描者改用 Gemini。保留現有沙盒的隔離保護，補上 Gemini 所需接線，驗證成功後再啟用；不取消沙盒、不放寬真實資料與憑證的界線。請依此留痕並安排施工，留意既有分工衝突。」[本人留痕](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6188273106)。

### Gemini 原生單輪複審

- **本人單輪授權（2026-10-21 UTC）**：「本輪正式複審改用 Gemini（建議）」（[原話](https://github.com/teacherjung/personal-finance-webapp/pull/730#issuecomment-6308077455)）；限 #730，預設分工仍為 Codex／Grok。依 [Sol 技術裁示](https://github.com/teacherjung/personal-finance-webapp/pull/730#issuecomment-6308173885)，本輪例外更新下方舊停止文字，不復活 GN 事件協議，也不把靜態掃描當正式複審或後掃。
- 用官方 `tools/review-launch.js` 的 `--reviewer Gemini` 備同版 detached 審查樹／突變副本、掛相依捷徑，再執行產生器依 reviewers 印出的 `scripts/gemini-review.js` 指令。F3 提示不加料；設定的模型與 HIGH 必須傳入原生 workspace 設定並解析生效。來源為 Gemini CLI；只有本次登記的模型可採計，不自動退檔。
- 實作者可在原先沒有 .gemini 的審查樹準備本輪 .gemini/settings.json；獨立列為 runtime，不當受審 commit 來源。先核來源／HEAD／乾淨狀態，前後核來源及 runtime 雜湊；只移除本輪實建且未變的設定，空目錄才移除，未知產物不廣刪。不改 ignore、system 或 admin，不覆寫私人設定。正式工具可讀來源、跑考題及改突變副本；MCP 使用非命中排他名單，-e none、hooks／skills／agents／自動記憶停用。
- 每輪樹外 `native-preflight.mjs` 由實作者按[已公開原碼](https://github.com/teacherjung/personal-finance-webapp/pull/730#issuecomment-6308323138)準備；`settings.json` 的 Gemini `preflightSha256` 釘來源。入口在送模型前執行並核本輪 launch／HEAD／runtime 設定／CLI／公開 bundle 雜湊與有效 HIGH、工具表、MCP 名單；缺失、非零或不匹配即停。診斷 stdout／stderr 與獨立 JSON 結果分別保留，不裁輸出。這是發審環境核對，原碼使用 literal imports，不改專案 lint。
- 原生 core 使用實際工具名，兼有排他工具表與免確認授權；其放行優先於本場 policy，不能把 policy 的 Shell 字首列當排他限制。Shell 內考題仍可跑任意程式。審查樹唯讀、禁止讀真資料／憑證及突變只在副本靠提示與前後有限核對，不是 OS 隔離，不證明中途未改回。CLI 自行處理既有登入，內部仍可能讀擴充資料；不把認證或私人記憶放進模型材料。不得建立／修改／送出交易、移動資金、提交、安裝套件、轉正式或合併。
- 公開平台材料由 reviewer 的唯讀查詢取得。若貼文工具未放行，依固定範本把完整結論留在最後回覆並寫未貼，由 Codex 逐字代貼。公開結論用 repo 相對路徑，不包含本機路徑、憑證或 session 包裝；完整 response 若不宜公開就保留拒收，不改正文。
- 原生 stdout／stderr 與退出碼保留私有，完整 JSON.response 不裁前言、不挑範例標頭；格式／角色／版本與模型皆核對後才輸出待貼全文。原生程序零不等於通過，仍須當版 F7、F6 對帳、後掃紀錄、合併與驗收。審完按官方程序收樹。

### Gemini 接線沿革（舊工作線已停止；單輪例外見上）

- 原生與網頁方案均停止；[原生準備計畫](gemini-native-formal-plan.md)與[網頁接線計畫](gemini-browser-formal-plan.md)只供追溯，不是施工、資格試跑或啟用授權。#702 已關閉未合併，不移植或追認其未合併成果。
- 舊固定 provider、launcher、CUA loader、部署與資格／隔離收據均不能作為繼續執行依據。不得換舊工作樹、資格用途、原生 CLI 或等待容量解決後自動續跑；恢復須有本人新的明確指示。
- 現行來源的正式網頁 scan 入口會核 scanner 登記，原生正式入口仍拒絕啟動；這不是全域關閉開關。舊固定副本讀取其自身設定，資格模式亦不由這項登記拒絕，因此協作者必須遵守上述授權撤銷，不能把歷史通過當成現行許可。
- 保留來源、舊失敗與合成證據供稽核；不刪帳號、登入或憑證，不改全域權限。套件借用線亦不得依本專案舊 Gemini 入口續跑；需要變更其專案自有設定時由該線處理，沒有掃描者依 G3 記未執行。

### Grok（本專案）

- **配方與有限磁碟來源帳的射程**：正式複審使用 `grok-disk-snapshots/v1`，固定集合由 [來源帳 helper](../scripts/grok-disk-snapshots.js) 宣告，包含專案來源及另標角色的套件入口；套件入口不代表全部間接相依。provider 在準備前與正式輸出前觀測，runner 在建盒前、實際 relay 啟動前與正式結果前觀測，實際 relay 的磁碟快照另列。固定來源缺失、讀取失敗、集合／角色／階段不符或前後變動即拒收；provider 承接 runner 的同一份帳，另保留自身觀測。
- **相容欄位與限制**：正式用途的 `scanScriptSha256` 是 runner 建盒前快照中 `scripts/grok-scan.js` 的相容欄位，`profileSha256` 沿同張快照取值；人讀配方標明磁碟快照時點。歷史 scan 配方與舊收據維持其原來的磁碟讀值射程，不回填新帳。前後相同不能證明已載入映像、全部遞迴相依、每次 profile 的讀取映像或排除中途替換與競態；受審 repo 的同名檔也不是執行來源。原完整身分待辦的再啟動條件及驗證見[施工計畫](runner-source-output-plan.md)，沿革見[原觸發裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6208198145)。
- **正式複審輸出上限**：stdout 與 stderr 各以解碼後的 UTF‑16 碼元計數，恰等上限可收；最後一段跨線當下即標記超限，該段不接入，後續排空而不累加，任一通道超限使本輪無效並清理。這個保留上限與 final 選取的 UTF‑8 位元組範圍不同；relay 診斷收取仍有自己的既有射程，有限來源帳不宣稱保存 relay 的全部輸出。

- **用量回報**：Grok 帳號的額度、429 回應與用量細節只留本機；公開 PR 的未執行紀錄只寫概略原因，不附帳號或原始回應。
- **模型與推理的角色分離**：Grok 正式複審使用 `settings.json` 的 reviewers 登記及產生器的明確參數，沿用 Grok profile、中繼、前後檢查與 formal review 入口；scanner 登記「無」不撤除這條複審隔離鏈。歷史 scan 用途不能作為替代掃描入口。
- **身分與管道**：William 機器裝有 Grok CLI（xAI）。它的正式工作通道都在 repo 外（材料制），站外 session 只能看發稿者提供的材料。查核、顧問與掃描材料要載明該次適用的界線；界線前綴的逐字正本＝教學影片 repo `../teaching-videos/AGENTS.md`「Grok 材料檔標準邊界前綴」節，這些材料逐字照抄那四行，本 repo 刻意不另存副本。正式複審依下一條的送審範本與基底規則材料。專案對它維持「未信任」預設。
- **正式複審（現行分工見「本次分工更新」；技術接法＝[Sol 裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6186173332)）**：機械身分為 Grok／Grok CLI，模型與推理由 `settings.json` 的 reviewers 那列明確指定。先用 `tools/review-launch.js` 備本輪樹與提示，再依它印出的指令經 `scripts/grok-review.js` 核對本輪資料；不得直接起 CLI。入口借用 `scripts/grok-scan.js` 的 OS 隔離、試探、釘值、中繼及掃後比對，以正式 review 用途備基底、受審版、突變副本、差異、公開平台材料與雜湊清單；此用途不套用掃描選題提示。盒內無原倉庫 .git，版本依外層核過的清單表示，不能假稱盒內做過原倉庫 Git 核對。審查材料唯讀由提示與前後雜湊核對約束，突變只改另備副本，不宣稱檔案系統唯讀。GitHub 憑證不進盒，Grok 的完整最後回覆依固定範本以結論標頭起首、文末單獨寫未貼。入口保留完整 CLI 對外輸出，並從同份已驗日誌辨認完整最後回覆，分列雜湊與位元組對應；不裁切回覆自身前言。安全鏈、身分、版本、完整性與格式均通過後，由盒外逐字代貼最後回覆並依 F7 核對。發起仍指定 reviewers 登記的最強模型與最高推理，不另開自動降級程序；模型資格依 AGENTS.md 的 2026-10-15 [本人更新](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6190624197)及 `scripts/grok-scan.js` 的有限資格表（適用理財及本次套件前置修正），接受已登記的 4.6 以上單一或混合模型。收據分列指定值、解析所得集合、資格下限與資格結果；未知、低版本、零模型、不完整或損壞仍拒絕，資格通過不等於內容結論通過。不能啟動時回報原因。正式複審與 G1 掃描分開計，不把複審收據當成已完成掃描。
- **合成與固定系統文字的回覆檢查**：`scripts/grok-review.js` 只豁免各自由獨立單對反引號完整包住的 `/tmp/probe-write-test`、`/tmp/mut1.out`、`/tmp/probe-write-test: Operation not permitted`、`/tmp/mut1.out: Operation not permitted`，以及 `/Users/sample`、`/Users/synthetic`、`/Users/someone`、`/Users/Shared`。暫存字面值及固定診斷依 [Grok 合成命令回饋](https://github.com/teacherjung/ai-collab-kit/pull/108#issuecomment-6197466471)與 [GPT‑6.1 Sol 固定診斷裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6198722397)；合成名稱與固定系統位置依 [Sol 精確文字補充裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6201562609)。冒號、空格、大小寫與固定診斷逐字匹配；合成名稱與系統位置只准該字串本身，不准附診斷、子路徑或其他尾文。憑證先查，例外只在原始文字識別，不把解碼後的文字當例外；未命中例外的文字依[有限解碼裁示](https://github.com/teacherjung/personal-finance-webapp/pull/692#issuecomment-6201957907)檢查：最多三輪同步 ASCII 解碼，每個視圖核對本機路徑與憑證，只作拒收、不重套例外。過深、畸形或超出支援 byte 的候選會拒收，可能連合法技術示例也被拒；這不是任意編碼辨識器。這只管回覆與完整 stdout 的文字檢查，原文與雜湊不改、輸入材料的檢查不放寬，也不授予任何檔案存取權。缺安全或完整性收據的輸出仍不能採計；修正檢查後也不得追認舊的未受理結果。
- **歷史通過的解除證據**：換版或換手要採計既成解除時，由 F7 收件者核對當時真實實跑證據並公開收據；格式與限制見 [結論閘檔頭「F7 當版核對收據 v1」](../tools/gates/check-review-verdicts.js)。缺據依閘的修法補當版通過或既有真實收據，不能用今天重跑冒充過去的 PR HEAD。
- **教學線三職**（操作面分兩處）：①**查核記者**＝腳本名詞／數字／案例查核；②**選題雷達**＝每集開工時跑一次，X 輿情只回答「散戶最近在誤解什麼」供選題——**不得產出持股輿情、行情判斷或任何進入投資決策的資訊**（錢的絕對邊界規則 5 的延伸）；①②的操作面在教學影片 repo 的 `AGENTS.md`。③**讀者測試員**＝本 repo 的 app 就地解釋等文案定稿前扮零基礎讀者、回報哪句看不懂——產線在這裡；它與工讀生的讀者測試站射程不同、互不取代，見 `docs/learning-hub-contract.md` 第三節。三職都不需 repo 權限，材料由發稿者抽出來給它。
- **複審後掃的通用紀錄**（RULES G1〜G4）：第一次有效正式通過後、轉正式前，Codex 在 PR 說明的「### 複審後掃」寫「未執行：本人已取消 Gemini 工作線，目前未登記掃描者」，附本人指示與當版通過來源。歷史掃描紀錄保留；不啟動 Gemini 或 Grok 掃描，Grok 正式複審仍走本節隔離入口。
- **主目錄禁區（隱私線，任何模式無例外）**：不得在主目錄工作——`data/store.db` 有真實餘額、IB flexToken、證件號，Grok 讀到的內容會送往 xAI 伺服器。現行條款下 Grok 本來就**不進任何樹**（上一條，材料制）；本條是兜底鐵線——連「在主目錄啟動它的 CLI」都算違規。
- **全域段落一體適用＋先規矩後開門**：錢的絕對邊界、鐵則、協作唯一不變量寫明「適用所有 AI」，Grok 含在內。要讓 Grok 承接本段以外的任何工作＝先在本段補上角色與邊界、William 拍板，才開門。
