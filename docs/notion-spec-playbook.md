# Notion 白話規格・更新工法（Claude 或 Codex 動架構時一起更新）

> 📦 2026-08-04 自 `AGENTS.md`「協作流程」節**逐字搬出**（籃 A 文件瘦身）：這是純操作手冊（頁面位置、id、icon 清單、建頁踩坑），只有動 Notion 時才需要。規則位階不變——使用者 2026-07-20 定；**2026-07-22 起 Notion 更新也交給 Codex**，細節當時已從 Claude 的 memory 搬進共用文件（Codex 看不到 memory）。`AGENTS.md` 仍是技術唯一真相。

- **位置＋現況**：Notion「不簡單 › 榮祥森（理財中心）› **動態藍圖區（架構・規則・原理）**」＝給使用者看的白話視圖（AGENTS.md 仍是技術唯一真相）。目前＝**9 頁子系統**（1 消費說明→鑰匙→顯示／2 帳單匯入／3 分類與自動學習／4 資產・投資・IB／5 訂閱・提醒／6 資料安全／7 前端架構／8 協作機制／**9 每日洞察引擎**）＋兩頁跨切面：「**防撞護欄設計原理（G3–G5）**」與「**錢的絕對邊界（AI 永遠碰不到你的錢）**」（2026-08-04 新建，放在「🔐 資料與安全」群組下）。〔頁面清單會長——動到架構時以 Notion 現況為準，本檔不維護會漂的完整枚舉。〕**動到某子系統的架構＝一併更新對應那頁**（一致性由動工方顧）。容器頁 id `3a39485922f58100aaedead0094987e0`；workspace＝teacherjung's Notion。
- **回饋迴路**：Notion 上的設計由使用者決定。①**措辭／版面／比喻／圖示**＝使用者全權、直接改、不通知：**更新頁面前先 `fetch` 現況、只做最小 search-replace、絕不覆蓋使用者的編輯**；②**規則／數字／設計描述**＝使用者在該段留 comment 寫明「理由：…」→ 讀後動工（改程式＋更新 AGENTS.md＋補考題，PR 照舊）或先在同串 comment 確認。**每次開工先 `get-comments`（`page_id`＋`include_all_blocks:true`）掃一輪留言**；自己的留言一律加作者前綴——**Claude 用「【Claude】」、Codex 用「【Codex】」**（Notion MCP 以使用者帳號發言，不加前綴會被當成使用者自己說的）。
- **寫作風格**：白話＋表格＋標題為主體，生活比喻開場（收發室／稽核抽查／配電箱…）；**避免「程式碼」這類詞，說「文件夾」**；金額口徑照該子系統（訂閱用「元」、其餘「萬」）。callout 只用少數重點框、`color="gray_background"`，開場用 `book_gray`、設計哲學／心法用 `light-bulb_gray`。**⚠️ 圖示一律 Notion 內建灰色 icon、絕不用 emoji**：頁面 icon＝create/update 傳 `icons/<name>_gray`；callout＝`<callout icon="/icons/<name>_gray.svg">`。實測可用：book／light-bulb／checkmark／tag／wrench／document／chart／bell／lock／code／people／circle／circle-dot。目錄狀態欄用文字（「已完成」）不用 emoji。
- **建頁／改頁工法（實測教訓）**：①`create-pages`／`update-page` 後**務必 fetch 回來逐頁校對**（會滑出錯字型字碼，攤→攞之類）；②`.md` 檔名用反引號包（否則被自動轉成 `http://AGENTS.md` 假連結）；③多頁批次照目錄順序建，底部子頁連結順序才對。
- **維護承諾（頁內已建機制）**：「防撞護欄設計原理」頁文末有「**更新紀錄**」表——那三道原理（G3 原子化／G4 身分判準／G5 欄位所有權）日後有變，回該表**補一列日期＋改內文**；子系統頁（含每日洞察引擎）就地更新。
