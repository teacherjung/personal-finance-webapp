# UI2 正式總覽

## 目的

把 UI0 已驗收的森林總覽接上正式 App 的 `/summary`、月快照與既有月度回顧資料；只改呈現與新增唯讀序列，不改任何金額公式、寫入流程或路由。

## 本 PR 預約範圍

- `public/modules/dashboard.js`：正式總覽 DOM、Chart.js 與既有互動接線。
- `public/modules/dashboard-forest.js`：月快照、月份變動與圖表資料的零 DOM／零 API 純函式。
- `public/styles.css`：只新增或調整總覽專用的 `forest-*`／`dash-*` 樣式。
- `public/assets/forest-return-*.webp`、`public/assets/guide-return-*.webp`：搬入 UI0 已驗收素材。
- `lib/derive.js`：只用既有 `computeCashflow` 組成近 12 個月唯讀序列，公式本身不變。
- `test/dashboard-forest.test.js`、`test/derive.test.js`：固定資料契約與前後端接縫考題。
- 本施工契約。

## 明確排除

- 不改 `public/app.js`、其他頁面模組、`public/stock-research.css`。
- 不改 API 路徑、資料庫、schema、匯入、快照寫入或金額格式器。
- 不以森林天氣替財務數字評分；場景固定使用明亮版，正負狀態靠文字、正負號與數字表達。
- 不新增月份切換、拖拉、縮放、聚焦或版面保存。
- 不重畫每日洞察、目標追蹤、資產配置與月度回顧的業務內容，只調整它們在總覽中的版面。

## 資料契約

1. 本月淨資產變動＝指定本月快照減緊鄰上月快照；缺本月或上月時明說缺哪一邊，不拿更早的月份冒充上月。
2. 前月淨資產為 0 時保留金額變動，但百分比為 `null`，不得補成 0%。
3. 淨資產變動包含收支、投資市值、匯率與負債變化，任何位置不得稱為投資報酬率。
4. 月快照依月份去重、保留同月日期較新的合法點，再落進以本月結尾的 12 個日曆月視窗；缺月保留 `null` 不跨缺口接線，非法月份與非有限數字略過。
5. 近 12 個月現金流由後端逐月呼叫既有 `computeCashflow`；前端與淨資產圖共用同一個日曆月視窗，記帳開始前用 `null` 表示沒有資料，中間空月保留 0。
6. 當月摘要仍以 `/summary` 現值為準；月快照只負責月份比較與歷史圖。
7. 正式總覽的「本月」一律採 `/summary.cashflow.month`，瀏覽器只在舊回應缺欄位時用本地月份退路，避免 HOSTED 的瀏覽器與伺服器在月交界走散。

## 驗收

1. 正式總覽保留淨資產、目標、四項 KPI、每日洞察、資產配置、月度回顧與其所有既有互動。
2. 森林場景、小森森、近 12 個月淨資產與近 12 個月收支都使用正式資料，沒有合成數字。
3. 首筆、零基準、增加、減少與無資料狀態都有固定輸入輸出考題。
4. 桌機與手機無全頁水平溢出、無文字或圖片遮擋；圖表 canvas 有可朗讀摘要。
5. 快速切頁後慢回應不得覆蓋新頁；既有 route sequence guard 維持。
6. typecheck、lint、完整測試、GitHub CI 與隔離 SQLite 瀏覽器回歸全綠。

## 衝突邊界

開工時 open PR #371 只動 `lib/heavy-admission.js`、`lib/services/stock-fundamentals.js`、`server.js` 與對應測試；#374 只動 `AGENTS.md`、`test/xlsx-isolate.test.js`。與本 PR 預約檔案零交集。

## 回復

純呈現與唯讀摘要欄位；不合併本 PR 即可完整回復，沒有資料搬家或後端狀態需要清理。
