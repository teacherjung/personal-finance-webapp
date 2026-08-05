# GitHub 分支保護 — 設定與驗證（2026-08-02 上線）

> **為什麼有這份**：分支保護的設定**只活在 GitHub 網頁裡、不進版控**——
> 有人手動改了，git 上看不出來。這份文件記下「它應該長什麼樣」，
> 讓「該是什麼」至少有紀錄可對。⚠️ 這份是**紀錄**，不是自動同步：
> 改了 GitHub 那邊要回來改這份，改了這份不會自動套用到 GitHub。

## 前提

- repo 是 **private**，方案必須是 **GitHub Pro 以上**。
  Free 方案下分支保護 API 直接回 403（`Upgrade to GitHub Pro or make this repository public`），
  **一條規則都設不了**。2026-08-02 已升級。

## A. 目前 GitHub 上真正的設定（2026-08-02 用唯讀 API 實讀，不是憑印象）

> ⚠️ **這一節記的是「現在是什麼」，不是「應該是什麼」。**
> 兩者現在**不一致**——第一版的這份文件把「我建議的」寫成「現行的」，
> Codex #382 r1 用 API 對照後當場戳破。要看「應該是什麼」請看 B 節。
>
> 重讀指令（任何時候都可以自己對一次）：
> ```
> gh api repos/teacherjung/personal-finance-webapp/branches/main/protection
> ```

| 規則 | 目前狀態 | 和 B 節（該有的樣子）一致嗎 |
|---|---|---|
| Require a pull request before merging | ✅ 開 | ✅ |
| └ **Require approvals**（`required_approving_review_count`） | **0** | ✅ 已取消（2026-08-02 William 執行；2026-08-05 API 覆核） |
| └ Dismiss stale reviews | ⬜ 關 | ✅ |
| Require status checks to pass | ✅ 開 | ✅ |
| └ 必過的 check | `上線用的 Node（.node-version）`＋`協作欄位（實作者 ≠ 獨立審查者）` | ✅ 兩個都在（2026-08-05 API 覆核） |
| └ **Require branches to be up to date**（`strict`） | ⬜ **關** | ✅ 已與 B 節設計意圖一致（2026-08-05 API 覆核） |
| Require linear history | ✅ 開 | ✅ |
| Require conversation resolution | ✅ 開 | ✅ |
| Allow force pushes | ⬜ 關 | ✅ |
| Allow deletions | ⬜ 關 | ✅ |
| **Do not allow bypassing**（`enforce_admins`） | ✅ **開** | ✅ 最關鍵的一格，理由見下一節 |

### 📌 歷史紀錄：`Require approvals = 1` 曾讓 **repo 完全合不了任何東西**（2026-08-02 當日已解）

實測（2026-08-02）：#381／#382／#383 三支的 `mergeStateStatus` 全是 **`BLOCKED`**。

原因不是 CI，是 **GitHub 天生不允許核准自己開的 PR**——
而 Claude／Codex／William **共用同一個 GitHub 身分**，
所以「需要 1 個核准」在單一身分下 ＝ **需要一個永遠不會出現的核准**。

⇒ **William 當日已把 Require approvals 取消勾選**（Settings → Branches → 編輯 `main` 的規則）。
這不是降低標準：實作者 ≠ 審查者這條，現在改由 `協作欄位` 這道 check 在**平台層**擋
（C 節），而它不需要第二個帳號就能運作。
**等分身分之後再把 Require approvals 開回來**（見文末「第二步」）——那時它才有意義。

### 📌 歷史紀錄：`Require branches to be up to date` 曾經開著（已關）

它會要求每支 PR 合併前都 rebase 到最新 `main`。**堆疊 PR 時會很煩**
（前一支合併後，後面每一支都要重推一次）。當時判斷「一次只有兩三支在飛還忍得住、先不動」，
後來已關掉（2026-08-05 API 覆核 `strict: false`），與 B 節設計意圖一致。
（記在這裡是為了：以後若又看到「每支 PR 都被要求 rebase」，知道痛是這一格造成的。）

## B. 這些規則「應該」長什麼樣（設計意圖）

| 規則 | 該是 | 為什麼 |
|---|---|---|
| Require a pull request before merging | ✅ 開 | 不准直接推 main |
| └ Require approvals | ⬜ **關**（暫時） | 單一身分下開了＝誰都合不了。分身分之後再開 |
| Require status checks to pass before merging | ✅ 開 | CI 沒綠不准合併 |
| └ 必過的 check | `上線用的 Node（.node-version）`<br>`協作欄位（實作者 ≠ 獨立審查者）` | ⚠️ **`開發機的 Node（最新版，前瞻｜不擋部署）` 刻意不列**——它是探照燈不是門（見 `.github/workflows/ci.yml` 檔頭）。列了它，下一個大版本 Node 出狀況時連安全更新都上不去 |
| └ Require branches to be up to date | ⬜ 關 | 會強迫每支 PR 合併前 rebase，堆疊 PR 時很痛 |
| Require linear history | ✅ 開 | 一律 squash（本專案慣例），禁 merge commit |
| Require conversation resolution | ✅ 開 | 審查留言沒回完不准合併 |
| Allow force pushes | ⬜ 關 | 禁改寫歷史 |
| Allow deletions | ⬜ 關 | 禁刪 main |
| **Do not allow bypassing the above settings**<br>（API：`enforce_admins`） | ✅ **開** | ⚠️ **這格最關鍵，理由見下一節** |

## ⚠️ 最重要的一課：單一身分下，「逃生門」和「強制力」是同一個開關

第一版的建議是「`enforce_admins` 關著，保留 admin 逃生門」。**那個建議是錯的**，實測當場打臉：

```
enforce_admins = false 時：
  直接推 main（用 admin token）→ ✅ 推上去了，兩個空 commit 直接進 main
```

原因：**Claude、Codex、William 三方都用同一個 admin token**。
關掉 `enforce_admins`，不只 William 能繞過——**我們每天的每一次 AI 操作都在繞過**，
規則對實際工作等於零強制力，白升級。

⇒ **`enforce_admins` 必須開。** 緊急時的逃生門改成：
**臨時到網頁把規則關一下、處理完再打開**——那是刻意的、看得見的動作，不是預設狀態。

## 驗證紀錄（2026-08-02，親眼看它擋了三次）

**設定顯示啟用 ≠ 真的擋得住。** 這三項都實際跑過：

| 測試 | 結果 | 靠哪條 |
|---|---|---|
| 直接推 main | 🚫 `GH006: Protected branch update failed`／`Changes must be made through a pull request` | Require PR ＋ `enforce_admins` |
| force push 改寫歷史 | 🚫 `protected branch hook declined` | Allow force pushes 關（⚠️ **這條連 admin 都擋，`enforce_admins` 關著時也生效**） |
| 合併 CI 紅的 PR | 🚫 `the base branch policy prohibits the merge` | Require status checks |

⚠️ **未來改動這些設定後，請重跑一次上面三項**——這個專案的招牌病就是「以為有守、其實沒守」。

## C. ✅ 兩步都已完成（2026-08-02 William 執行；2026-08-05 API 覆核）

> ⚠️ **這一節是完成紀錄，不是待辦清單**——照著再做一次等於去動一個已經設對的開關。
> 覆核指令：`gh api repos/teacherjung/personal-finance-webapp/branches/main/protection`
> 現況＝`required_approving_review_count: 0`、`strict: false`、contexts 兩個都在、`enforce_admins: true`。
> 下面保留當時的操作步驟，供**日後分身分或重建 repo 時照做**。

Settings → Branches → 編輯 `main` 的規則：

### ① ✅ 已取消勾選 `Require approvals`

理由見 A 節：單一身分下它需要一個永遠不會出現的核准（當時三支 PR 全是 `BLOCKED`）。

### ② ✅ 已把 `協作欄位` 加進必過的 check（#382 合併後執行）

`.github/workflows/collab-fields.yml` 的 `collab-fields` job 上線後會出現在 PR 頁面，
但**預設不是必過的**。要讓它有牙齒：

1. 在 **Require status checks** 的搜尋框輸入 `協作欄位`
2. 選取 **`協作欄位（實作者 ≠ 獨立審查者）`**
3. Save

⚠️ **check 名稱必須跟 workflow 裡的 `name:` 完全一致**——改了 job 名稱，
分支保護那邊會變成「等一個永遠不會出現的 check」而**永遠卡住合併**。改名時兩邊要一起改。
（`test/collab-invariant-docs.test.js` 有考題盯著兩邊字串一致。）

⚠️ 這個 check 之所以能取代 `Require approvals` 的**部分**功能，是因為它在**平台層**擋
「實作者＝獨立審查者」，而且不需要第二個帳號。**但它擋的是 PR 說明寫了誰，
不是實際上是誰按的**——那個差別只有分身分能補（見文末第二步）。

## ⚠️ 這道閘的守備範圍（誠實劃界，Codex #382 r2 查證）

- **fork 來的 PR 不在守備範圍內。** 這個 private repo 目前
  `run_workflows_from_fork_pull_requests: false`，fork PR **根本不會跑 workflow**——
  設成 required check 之後會等不到它（既有的 CI required check 也一樣，不是這次分檔引進的）。
  未來若要接受 fork 的 PR，這道閘要重新設計成 base-controlled（因為 fork 可以連 workflow
  與腳本本身一起改）。**現在三方都用同一個帳號、沒有 fork，所以不是問題。**
- **它擋的是「PR 說明寫了誰」，不是「實際上是誰按的」。** 後者只有分身分能補（見下）。

## 之後的第二步：分身分（尚未做）

給 Codex（或審查方）一個**獨立的非 admin GitHub 帳號**之後，才能開 `Require approvals`——
那條「作者不能核准自己的 PR」是 GitHub 天生強制的，比 `scripts/check-pr-collab-fields.js` 強：
腳本檢查的是「PR 說明寫了誰」，平台檢查的是「實際上是誰按的」。

代價：多一個帳號、多一組金鑰、兩個 CLI 要各認不同身分。
**建議先讓現行設定跑一陣子，確認沒有干擾日常，再動這一步。**

## 相關檔案

- `.github/workflows/ci.yml` — 兩個程式碼 job（含為什麼 dev-machine 不當門）
- `.github/workflows/collab-fields.yml` — 協作欄位閘的 job（**刻意分開一個檔**：
  它看的是 PR 說明，所以必須訂閱 `edited` 事件；而程式碼那三關不該因為改幾個字的說明就重跑）
- `scripts/check-pr-collab-fields.js` — 協作欄位閘（CI 與人工合併程序**跑同一支**）
- `scripts/check-pr-merge-gate.js` — 堆疊閘（本機執行，未進 CI）
- `REVIEW-AND-MERGE.md` — 合併步驟
- `AGENTS.md`「三方協作框架」節 — 唯一不變量與角色分工
