# 階段 B：骨架改建 — 施工計畫（✅ 已全部完工）

> 狀態（2026-07-31 更新）：**B0–B3 全部上線**（SQLite 已是現行引擎）。現行架構真相見 AGENTS.md；本文件保留為當時的施工地圖。
>
> 目標：把後端從「一間大倉庫」整理成「一間一間房間」，並把資料進出收到「單一櫃檯」，
> 為之後換資料庫（SQLite）與多人版鋪路。**app 外觀與操作全程不變**，每步都過三道守門。
> 這種大手術**建議使用者在場、逐步確認**——本文件是開工前的地圖。

## 為什麼要改（白話）
現在 `server.js` 一個檔（~500 行）把三件事混在一起：接收網路請求、算業務邏輯、直接讀寫資料檔。
規模還小時沒問題；但要加「帳號、資料庫、多人」時，混在一起會牽一髮動全身。
先分層，之後換任何一塊（例如把文字檔換成 SQLite）都只動一間房、不影響其他。

## 目標結構（分三層房間）
```
server.js            → 只負責「啟動」＋掛載路由（很薄）
lib/routes/*.js      → 路由層：收請求、回應答（每個主題一檔：transactions / settings / statement / ib / portfolio…）
lib/services/*.js    → 業務邏輯層：分類學習、帳單匯入、IB 同步、快照…（可被測試，不碰 HTTP）
lib/repo.js          → 資料存取「單一櫃檯」：唯一讀寫資料的地方（現包 store.json，未來換 SQLite 只改這裡）
lib/derive.js        → 計算大腦（維持現狀，已型別化＋考試覆蓋）
```

## 施工順序（小步、每步一 PR、每步可獨立驗證）

### B0. 前置（最小、最安全，先做）✅ 已完成（2026-07-13）
1. **`store.js` 檔案路徑可用環境變數指定**：`const FILE = process.env.STORE_FILE || 預設`。
   —— 讓測試能用「隔離的暫存資料檔」跑,不碰真實 store.json。**預設不變、零風險。**
2. **`server.js` 把 app 與「啟動監聽」分開**：`export const app`；只有直接執行時才 `listen`。
   —— 讓「伺服器端測試」能載入 app 而不真的開埠。
3. **加伺服器端測試**（用 B0-1 的隔離資料檔）：GET /api/summary、一個集合的新增→讀回→修改→刪除、
   settings 存取、snapshot。這是 B 階段大改建的**安全網**（現有 34 題不涵蓋 HTTP 端點）。

### B1. 資料存取收斂到 `lib/repo.js`（單一櫃檯）✅ 已完成（2026-07-13）
- 建 `repo.js`：`getCollection/addItem/updateItem/deleteItem/getSettings/updateSettings/getDb/saveDb`。
- `server.js` 內所有 `load()/save()` 改走 repo。**行為完全不變**，B0-3 的測試護體。

### B2. 路由與業務邏輯拆檔 ✅ 已完成（2026-07-13）
- 把 `server.js` 的各主題端點搬到 `lib/routes/*.js`；較重的邏輯（帳單匯入、學習、IB 同步、快照）
  搬到 `lib/services/*.js`。`server.js` 收斂成薄薄的掛載。
- 順便補上「欄位白名單」（見安全地圖 B2）——只在這步、有測試護體時做。

### B3. 換 SQLite（只動 `repo.js` 後面）✅ 已完成（2026-07-14，含「驗證入櫃檯」）
- 用 Node 內建 `node:sqlite`（或 better-sqlite3）；schema 對應現有集合。
- 寫「一次性搬家」：把現有 `store.json` 匯入 SQLite。
- **因為所有讀寫都走 repo，這步理論上只改 `repo.js` 內部**，其他房間不動。
- 一併把「資料防呆」補齊（交易、損毀偵測——SQLite 原生支援）。

## 風險與護欄
- 每步都是**行為保持不變**的重構，靠三道守門＋B0-3 的端點測試＋瀏覽器 8 頁實測把關。
- 一步一 PR、使用者逐一合併；不堆疊、不一次大改。
- 遇到需要決策的岔路（例：SQLite 用哪個函式庫、schema 細節），先問使用者再做。

## 待使用者拍板
- 開工時機（是否現在開始 B0）。
- SQLite 函式庫選擇（B3 時再決定：Node 內建 `node:sqlite` vs `better-sqlite3`）。
