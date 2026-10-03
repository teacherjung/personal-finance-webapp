# 規則入口整併施工計畫（2026-10-03）

William 指派：移除 Claude 專用入口，縮小共同入口，保存全部規則並寫入已確認的常設指示。這支視為高風險；實作者 Codex、複審者 Claude。

## 範圍與搬移對照

- `AGENTS.md`：保留錢的五條絕對邊界、鐵則、開工路由與 William 的 22 則常設指示；以 28,000 UTF-8 bytes 為專案上限。
- `CLAUDE.md`：刪除；獨有要求改為角色寫法併入共同入口；已有正本的要求只留路標。
- 專案概觀、階段路線圖、收支三層架構 → `docs/project-overview.md`。
- 錢的機械層註腳 → `docs/money-guard-operations.md`。
- 驗證與三關、PR 分級與契約 → `docs/development-workflow.md`。
- UI 現行慣例 → `docs/ui-conventions.md`；按本次指派修正橘色焦點框與邊線的衝突。
- 投資領域語意 → `docs/investment-semantics.md`。
- 同步點清單 → `docs/sync-index.md`；領域契約與索引的既有檢查跟著新位置走。
- 欄位所有權 → `docs/field-ownership.md`。
- 本專案協作附則 → `docs/project-collaboration.md`；套件後續同步請找這一份。

## 保存與驗證

搬移先以原文切段，再只修正位置語、相對連結、角色寫法及本次明確指派的新規則；逐項差異記錄在 PR。更新讀取舊位置的程式、考題、註解與路標。套件本文與工具不在本次範圍。

新增入口容量考題與禁止 Claude 專用入口考題；檢查已追蹤與本機未追蹤檔案，涵蓋子目錄；排除 Git 內部資料、相依目錄與 `.claude/worktrees` 下的獨立工作樹，不跟隨目錄 symlink。負向驗證在樹外隔離副本做，確認超限與各種禁用檔名會失敗。既有考題改查新正本，保留原有判準；三關、雲端檢查與獨立複審完成後依合併指令收口。

## 容量依據

2026-10-03 查官方說明：`project_doc_max_bytes` 預設 32 KiB，是專案根目錄至工作目錄的指示檔合計，不是每檔各有一份額度。故詳細文件使用一般名稱並由入口指路，不依賴巢狀 AGENTS 分攤容量。來源：https://learn.chatgpt.com/docs/agent-configuration/agents-md 。

## 復原

出錯時回復本支合併提交；本支不改財務資料、程式業務邏輯或工具權限。
