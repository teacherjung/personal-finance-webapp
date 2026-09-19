# 2026-08-09 裸倉庫事故：病理與證據鏈

> **歷史紀錄，停在 #433／#435 當時（2026-08-09〜08-10）；現行規則＝`AGENTS.md` 鐵則 11。**
> 這份是事故病理與證據鏈的單一真相：`AGENTS.md` 鐵則 11、`lib/git-env.js`、`scripts/git-hooks/pre-push` 各自只留解釋自己那一處「為什麼」的精簡版，完整的在這裡（勿重抄——抄兩份就會漂）。
> 本文 2026-09-20 從 #435 加的那支工作樹體檢腳本（`scripts/check-worktree-integrity.js`）的檔頭搬來；搬的時候只改了會變假話或失去主詞的幾句，逐條寫在搬家那一支的變更說明。

## 那天發生什麼

2026-08-09 01:28，主目錄的 `.git/config` 被寫進 `bare = true`（同日 10:34:27 又被寫進一次，見下面的證據鏈）。壞掉的不是一棵樹，是**主目錄與當時 42 棵連結工作樹一起**：`git status`／`add`／`commit`／`rev-parse --show-toplevel` 全部回 `fatal: this operation must be run in a work tree`，`git worktree list` 把主目錄標成 `(bare)`。

為什麼會一起中：`core.bare` 存在**共用的** `.git/config`。這個 repo 的 `extensions.worktreeConfig` 是開著的，但當時只有 3 棵樹有自己的 `config.worktree`，而那 3 份**都沒有覆寫 `core.bare`** ⇒ 43 棵樹全部讀同一個值。

故障還會藏起來（#435 r1 Medium③ 實測）：某棵樹自己的 `config.worktree` 若覆寫了 `core.bare`，從那棵樹讀到的生效值是它自己的覆寫值——這棵樹自己好好的，共用層的壞從這裡看不出來，其他**沒有**覆寫的樹（含主目錄）卻全部一起中。事故當天沒有任何一棵樹覆寫它。

## 怎麼會被寫進去（沙盒實測，2026-08-09；肇因見下面的證據鏈）

`git init` 只要在**環境變數 `GIT_DIR` 指向某棵連結工作樹的 gitdir**（`.git/worktrees/<名>`）之下執行，就會把 `bare = true` 寫進**共用** config——就算你已經好好把 `cwd` 指到 `/var/folders/...` 的暫存目錄也一樣，因為有 `GIT_DIR` 時 git 根本不看 cwd。原因是 git 猜「這是不是 bare repo」時只看 `GIT_DIR` 的**路徑長相**：結尾是 `.git` 就猜「不是」，其餘一律猜「是」，而 `.git/worktrees/<名>` 的結尾不是 `.git`。實測三種情形：

| `GIT_DIR` | 結果 |
|---|---|
| 沒有 `GIT_DIR` | 安全（在暫存目錄開新 repo，跟主 repo 無關） |
| `GIT_DIR=<主目錄>/.git` | 安全（結尾是 `.git`，猜「不是 bare」） |
| `GIT_DIR=<主目錄>/.git/worktrees/X` | ☠️ 共用 `.git/config` 當場變成 `bare = true` |

而 `GIT_DIR` 不需要有人手動設：**git 自己會放進 hook 的環境**。實測從連結工作樹 push／commit 時，`pre-push`／`pre-commit` 都拿得到 `GIT_DIR=<主目錄>/.git/worktrees/<名>`（從主目錄操作時則沒有）。當時（#435 之前）的 `pre-push` 沒有清 `GIT_*` 就直接跑 `npm test` ⇒ **從任何一棵 worktree push，整套考題都是在那個環境下跑的**。同一個 `GIT_DIR` 還有第二個副作用：它會蓋掉 `git -C <路徑>` 與 `execFileSync(..., { cwd })`，讓「掃這棵樹」的考題其實掃到別棵。

這個機制有考題在每次考試時真的重現一次：`test/worktree-integrity.test.js` 題名含「事故的原地重現」那一題（沙盒裡帶 `GIT_DIR` 跑 `git init`，斷言共用設定真的變成 `bare = true`）。紅在那一句斷言＝那個沙盒裡 git 沒有把共用設定寫成 bare——先確認機制還在（git 版本換了？），再決定要不要改題目，不要直接刪。

## 證據鏈（2026-08-10 更正後）

⚠️ **肇因已有高度吻合的證據鏈，但沒有當場的行程目擊。**

那支體檢腳本第一版的檔頭寫「查過 PR #433 的 11 個 commit，沒有任何一處 `git init`、已排除」——那是**誤判**：程式裡寫的是 `git('init', '-q')` 輔助函式呼叫，拿字面「git init」去掃掃不到（掃描器說謊的老病型）。#435 r1 提出、並經獨立重現的直接證據：

- `4ab8e0b` 與 `0c0b176`（#433 過程 commit）的 `test/test-path-decoding.test.js` 各有一處 `git('init', '-q')`；兩顆 commit 時間 01:28:33／10:34:07，與兩次事故（01:28／10:34:27）分秒貼合；#433 的 squash 訊息（`7c573f2`）亦記載那顆 fixture 曾污染主 repo。

所以「上面的機制」不只是重現得出來——它就是證據指向的肇因鏈（fixture 的 git init × hook 環境的 GIT_DIR）。

## 出處

- #433 的壓縮提交 `7c573f2`（2026-08-09）：訊息裡記了那天的事故，以及「那顆 fixture 真的弄壞了主 repo」。
- #435 的壓縮提交 `92cb482`（2026-08-10）：加上工作樹體檢、把 `pre-push` 的 `GIT_*` 整族清乾淨。它合併前的 `pre-push` 直接跑 `npm test`、沒有清 `GIT_*`（`git show 92cb482^:scripts/git-hooks/pre-push`）。

## 現在的防線在哪裡（只指路，不抄規則）

- `scripts/git-hooks/pre-push` 開頭按 `GIT_` 前綴整族清環境（shell 那一份實作）。
- `lib/git-env.js` 的 `gitEnv()`：Node 這邊叫 git 的地方走它（JS 那一份實作；規矩與射程＝`AGENTS.md` 鐵則 11）。
- 協作套件的三關執行器 `tools/run-checks.js`：三關前後驗這棵樹還是不是工作樹、倉庫設定有沒有被改，本專案另登記主目錄布局與索引錨點（`settings.json` 的 `checks.mainWorktree`、`checks.indexAnchors`）；它驗什麼、守不到什麼＝它自己的檔頭與 `MACHINES.md` E2、E3 那一列。
