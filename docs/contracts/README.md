# 領域契約路由表：改哪些檔，要讀哪份契約

> `docs/contracts/` 是 AGENTS.md「同步點清單」的**領域拆分**（D4 系列，2026-07-31 起）：
> 拆出的領域在 AGENTS 只留**一行索引＋連結**，完整同步點內文（逐字）在各契約檔。
> **規則：開工前對照下表——你要改的檔案落在哪個領域，就必讀那份契約**；AGENTS 的同步點清單仍是總索引。
> 尚未拆出的領域（標「仍在 AGENTS」）照舊直接讀 AGENTS 同步點清單。
>
> **兩條硬規則（Codex D4a-r1 抓的防護力缺口）**：
> ①**已拆領域的檔案清單＝該契約各列實際點名的檔案（窮舉、契約改變當支 PR 同步更新）**——不是「這個領域的典型檔案」。訂閱的月底錨點規則管到 `lib/routes/crud.js`、洞察書籤管到 `lib/types.js`，光看「前端」二字想不到。
> ②**同一檔案可以落在多個領域——每一個命中的契約都要讀**（`lib/derive.js`、`lib/schema.js` 這類共用底層必然多重命中；只讀一份＝漏規則）。

| 領域 | 你改的檔案（已拆領域＝窮舉判準；未拆領域＝例示） | 契約檔 |
|---|---|---|
| 前端功能（訂閱／月度回顧卡／洞察書籤／日期與色票） | `public/modules/subscriptions.js`＋`subscriptions-model.js`＋`subscriptions-report.js`、`monthly-review-card.js`、`dashboard.js`、`public/app.js`（重繪／`parseLocalDate`）、`theme.js`／`styles.css`（色票）、`lib/services/subscriptions.js`、`lib/services/insights.js`、`lib/services/snapshot.js`（每日維護入口）、`lib/routes/core.js`（刻意不改的入口約定）、`lib/routes/crud.js`（subscriptions beforeSave／`chargeAnchorDay`）、`lib/derive.js`（攤提 `subCostForMonth`／`subActive`／提醒 key／`parseLocalDate`）、`lib/store.js`＋`lib/schema.js`＋`lib/types.js`（`insightState` 註冊件） | [前端功能.md](前端功能.md) |
| 收支記帳與匯入（帳單解析／分類／店名規則／學習） | 例示：`lib/statement.js`、`lib/bank-statement.js`、`lib/store-rules.js`、`lib/services/statement-import.js`、`transactions*.js`、解析上限（完整判準＝拆出當支 PR 窮舉） | （仍在 AGENTS——**最後拆**：#350 進行中） |
| 投資與 SEC（基本面／曝險／訊號／代號原則） | 例示：`lib/stock-fundamentals.js`、`lib/services/stock-fundamentals.js`、`portfolio-exposure.js`、`lib/ib.js`、估值訊號（完整判準＝拆出當支 PR 窮舉） | （仍在 AGENTS） |
| 資料層與儲存（repo／kv／schema 欄位／備份／快照） | 例示：`lib/repo.js`、`lib/store.js`、`lib/store-pg.js`、`lib/schema.js`、`lib/services/backup.js`、`snapshot.js`（完整判準＝拆出當支 PR 窮舉） | （仍在 AGENTS） |
| Hosted／安全與部署（auth／機密／速率限制／租戶隔離） | 例示：`lib/services/auth.js`、`lib/secret-fields.js`、`lib/rate-limit.js`、`lib/tenant.js`、`render.yaml`（完整判準＝拆出當支 PR 窮舉） | （仍在 AGENTS） |

拆分紀律（每個領域一支 PR）：**先複製後換連結、內文逐字（唯一轉換＝表格解框）、對照表寫進 PR**；契約檔的變更視同 AGENTS 同步點變更＝技術契約改變的**當支 PR** 同步更新。
