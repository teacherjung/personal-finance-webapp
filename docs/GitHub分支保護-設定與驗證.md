# GitHub 分支保護 — 設定與驗證（2026-08-02 上線）

> **為什麼有這份**：分支保護的設定**只活在 GitHub 網頁裡、不進版控**——
> 有人手動改了，git 上看不出來。這份文件記下「它應該長什麼樣」，
> 讓「該是什麼」至少有紀錄可對。⚠️ 這份是**紀錄**，不是自動同步：
> 改了 GitHub 那邊要回來改這份，改了這份不會自動套用到 GitHub。

## 前提

- repo 是 **private**，方案必須是 **GitHub Pro 以上**。
  Free 方案下分支保護 API 直接回 403（`Upgrade to GitHub Pro or make this repository public`），
  **一條規則都設不了**。2026-08-02 已升級。

## 現行設定（main 分支）

在 **Settings → Branches → Branch protection rules → `main`**：

| 規則 | 狀態 | 為什麼 |
|---|---|---|
| Require a pull request before merging | ✅ 開 | 不准直接推 main |
| └ Require approvals | ⬜ **關** | ⚠️ 目前 Claude／Codex／William **共用同一個 GitHub 身分**，而 GitHub 不允許核准自己開的 PR ⇒ 開了會變成誰都合不了。**等分身分之後再開**（見文末） |
| Require status checks to pass before merging | ✅ 開 | CI 沒綠不准合併 |
| └ 必過的 check | `上線用的 Node（.node-version）`<br>`協作欄位（實作者 ≠ 獨立審查者）` | ⚠️ **`開發機的 Node（最新版，前瞻｜不擋部署）` 刻意不列**——它是探照燈不是門（見 `.github/workflows/ci.yml` 檔頭）。列了它，下一個大版本 Node 出狀況時連安全更新都上不去 |
| └ Require branches to be up to date | ⬜ 關 | 會強迫每支 PR 合併前 rebase，堆疊 PR 時很痛。之後需要再開 |
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

## 新增 `協作欄位` 這道 check（本 PR 之後要做的一步）

`.github/workflows/ci.yml` 的 `collab-fields` job 上線後，它會出現在 PR 頁面，
但**預設不是必過的**。要讓它有牙齒：

1. Settings → Branches → 編輯 `main` 的規則
2. 在 **Require status checks** 的搜尋框輸入 `協作欄位`
3. 選取 **`協作欄位（實作者 ≠ 獨立審查者）`**
4. Save

⚠️ **check 名稱必須跟 `ci.yml` 裡的 `name:` 完全一致**——改了 job 名稱，
分支保護那邊會變成「等一個永遠不會出現的 check」而**永遠卡住合併**。改名時兩邊要一起改。

## 之後的第二步：分身分（尚未做）

給 Codex（或審查方）一個**獨立的非 admin GitHub 帳號**之後，才能開 `Require approvals`——
那條「作者不能核准自己的 PR」是 GitHub 天生強制的，比 `scripts/check-pr-collab-fields.js` 強：
腳本檢查的是「PR 說明寫了誰」，平台檢查的是「實際上是誰按的」。

代價：多一個帳號、多一組金鑰、兩個 CLI 要各認不同身分。
**建議先讓現行設定跑一陣子，確認沒有干擾日常，再動這一步。**

## 相關檔案

- `.github/workflows/ci.yml` — 三個 job 的定義（含為什麼 dev-machine 不當門）
- `scripts/check-pr-collab-fields.js` — 協作欄位閘（CI 與人工合併程序**跑同一支**）
- `scripts/check-pr-merge-gate.js` — 堆疊閘（本機執行，未進 CI）
- `CODEX-REVIEW.md` — 合併六步驟
- `AGENTS.md`「三方協作框架」節 — 唯一不變量與角色分工
