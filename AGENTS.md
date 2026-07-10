# AGENTS.md — 給所有 AI 協作者（Codex / Claude / 其他）的專案規則書

這是三方協作（使用者 + Claude Code + Codex）的**單一真相來源**。動手前先讀完；改動若牽涉本文件的規則，請一併更新本文件。

## 專案概觀

本機優先（隱私第一）的個人理財網頁。**零建置**：改完存檔即生效，沒有 bundler/transpiler，不要引入 npm 前端相依。

- 後端：`server.js`（Express，只聽 `127.0.0.1`，埠 `PORT` 環境變數或 4321）
- 資料：`data/store.json`（本機 JSON，**已被 .gitignore 排除**）；首次啟動從 `data/seed.json` 複製
- 計算大腦：`lib/derive.js`（淨資產/現金流/提醒/投資原則檢查）
- IBKR 串接：`lib/ib.js`（Flex Query 唯讀）
- 前端：`public/` 原生 JS SPA——`app.js`（共用工具+路由）、`modules/*.js`（一頁一檔）、`modules/theme.js`（圖表色）、Chart.js（本機 vendor）

啟動：`npm start` → http://localhost:4321 。注意：使用者常自己開著一個伺服器佔 4321，`.claude/launch.json` 已設 `autoPort`。

## 鐵則（違反會壞事）

1. **敏感資料絕不進版控**：`data/store.json`、`*.bak`、`data/*backup*`（真實餘額、持倉、IBKR flexToken）。.gitignore 已擋，不要繞過。測試一律用 `data/seed.json`（維持「夠像真的」：多幣別、負現金融資、各層持股）。**非必要也不要「讀取」`data/store.json` 的內容**——它含真實個人財務資料與 token，讀進 AI 上下文等於外傳；要看資料形狀用 `seed.json`。
2. **循環 import TDZ**：`app.js` 與各 module 互相 import。任何「模組檔案頂層就會取用」的共用常數，必須放在**零依賴的 `modules/theme.js`**（或同型新檔）直接 import，**不可**經 app.js 轉手。曾因此全站白屏卡「載入中」。
3. **XSS**：所有使用者資料插入 innerHTML 前必過 `esc()`（app.js 提供）。
4. **色彩分工**：
   - 分類色（圖表/長條/圓餅/圓點）只從 `theme.js` 的 `CHART`/`PALETTE` 取——六色盤已通過 dataviz 驗證，不要自創 hex。品牌珊瑚色（趨勢線、單色漸層）用 `theme.js` 的 `ACCENT`/`ACCENT_SOFT`。
   - 語意色 `--pos/--neg/--warn`（CSS token，六色盤同色相加深、對比 ≥4.5:1）**只給文字/標籤/提醒邊框**。
   - **填色條一律用 CHART 亮版**，不可拿深色 token 當填色（使用者抓過違規）。
5. **金額格式**（app.js 統一格式器，不要自己 toLocaleString）：
   - 統計卡片大數字 → `wan()`（萬）；表格/明細 → `money()`（元整數）/`moneyCur()`（原幣）。**例外：訂閱追蹤頁（含內嵌歷史紀錄）全部用 `money()` 元**——訂閱金額為千元級，用萬會變「0.1 萬」不可讀（使用者拍板 D7）
   - 負號一律 U+2212「−」；投資組合頁走 `MONEY()` 雙計價（localStorage `pf_viewCur`，NT=萬 / US=K USD）
6. **UI 慣例**：卡片數字 `.stat sm`、表格數字欄 `.num`（右對齊 tabular）、空狀態 `.empty` 文案「尚無…」、頁首動作 `.page-actions`、卡片牆 `.grid.card-grid`＋`.detail-grid`、彈窗用 `openForm`/`openInfo`＋`modal-sm/md/lg/xl`、名詞說明用 `.info-link`（無底線，hover 珊瑚色）＋`openInfo`。

## 投資領域語意（改相關程式前必讀）

- **投資原則（使用者拍板）**：最高指導原則＝**生存優先**（在所有環境活著 > 多數環境賺更多），規則衝突時以此裁決。所有上限口徑＝**% 淨資產**（非投組市值）；區域曝險**穿透**計算（COMPOSITION 拆 ETF 成分）；**軟上限**＝超標僅「凍結加碼」提醒，**不強制賣**。上限存 settings：`ibConcentrationPct`(單一個股5)/`equityCapPct`(90)/`countryCapPct`(15)/`chinaCapPct`(15)/`levCapPct`(1.3)，設定頁「投資原則」卡可調。
- **融資槓桿只算 IB**：**優先用 IB 官方淨值摘要 `settings.ib.lastEquity`**（同步時更新、基準幣別 USD：stock ÷ (stock+cash)）；沒有同步資料才自算（`source:'ib'` 持倉 ÷ 淨值、融資＝`ibCashCur` 負餘額）。排除台新現金與台股，文案標「IB」前綴。`ibIdleCashAlert`＝IB 正現金閒置提醒門檻（USD）。
- **槓桿上限任何時期 1.3x**（2026-07-10 修訂，取消訊號期 1.6x——1.6x 撐不過 2008 級回檔）：估值訊號期加碼**只用新資金與現金、不舉新債**。**斷頭距離**＝市場再跌 x% 觸及 IB 強平線，`x = 1 − 借款 ÷ ((1−維持率) × IB 持倉市值)`（假設全倉維持率一致的近似）；維持率存 `settings.ibMaintenancePct`(25)。公式在 `portfolio.js marginCallDistance()` 與 `lib/derive.js` 規則 7 各一份（同步點）。
- **多幣別損益**：已實現損益/現金流換算優先序＝IBKR `pnlBase` → `fxRateToBase` → USD 直通 → 設定匯率估算（需標註）→ 缺匯率不計入（需標註）。不可把非 USD 金額默默當 USD 加總。
- **XIRR（資金加權年化，台幣）**：現金流＝第一筆月快照市值（流出）＋各月快照投入增量（流出）＋IB 賣出已實現損益逐筆按成交日（`pnlBase`×usdTwd，流入）＋今日市值（流入）。**賣出只用 Δcost 會漏掉已實現損益，必須用 ibTrades 修正**。不含股息利息；台股手動賣出未納入；快照未滿 60 天不顯示；|年化|>500% 視為資料異常。實作在 `portfolio.js portfolioXirr()/xirrRate()`（僅此一份）。快照資料曾含 seed 示範殘留（2026-07-10 已清），**判斷 XIRR 異常先懷疑快照資料**。
- 台股（0050/006208/00719B/00720B）無 API、手動維護股數；報價 Yahoo（台債後綴 `.TWO`；GBp 便士 ÷100 轉 GBP）。

## ⚠️ 同步點清單（改一處必須檢查另一處）

| 改這裡 | 記得同步這裡 |
|---|---|
| `public/modules/portfolio.js` 的 `COMPOSITION` 穿透表 | `lib/derive.js` 的同名複本 |
| `portfolio.js` `fxSection.exposureCurrency` 寫死的台幣掛牌美債 ETF 清單（00719B/00720B） | 新增同類 ETF 時要補進清單 |
| 新增 ETF 持股 | `portfolio.js` `COMPANY_WEIGHTS`（前十大成分近似權重，持股公司 Top 20 用）＋`COMPOSITION` 區域表（兩檔案）。**例外（刻意）**：XUSE/EXUS 只做區域穿透、不列 COMPANY_WEIGHTS（成分極分散，前十大各僅 1–2%） |
| `server.js` `DEFAULT_LAYER` 新增代號 | 兩份 `COMPOSITION` 也要有該代號（否則 IB 同步新增後區域穿透 fallback 成「其他」，國家上限提醒會偏掉） |
| IB 槓桿公式（lastEquity 優先、自算 fallback） | `lib/derive.js` 規則 7 ↔ `portfolio.js` render 內，兩份要一致 |
| 斷頭距離公式（借款÷((1−維持率)×持倉)） | `portfolio.js marginCallDistance()` ↔ `lib/derive.js` 規則 7 內聯，兩份要一致 |
| `theme.js` 的 CHART.green/red | `styles.css` `.cb-ok/.cb-over` 寫死同色 hex（CSS 無法 import JS） |
| settings 新增欄位 | `lib/store.js emptyDb()` 預設值＋`data/seed.json`＋設定頁 UI |
| 估值訊號門檻（`portfolio.js` `regionTier`/`taiwanTier`/`US_RATIO`） | 投資原則規則書（memory）＋標題說明彈窗 `SIGNALS_INFO_HTML`，三處門檻要一致 |
| `settings.signals`（美股自動、區域四市場每月手動） | 只在投組頁「更新區域數值」表單編輯；美股 ECY＝`/api/cape`＋`/api/realyield`（FRED DFII10）自動算，不手動 |

## 協作流程

- **Claude 與 Codex 都直接在本機這個資料夾工作**（Codex 為本機 CLI，非雲端）——改動只存在工作目錄，`git commit` 才進歷史、`git push` 才上 GitHub。
- **換手儀式**：換另一個 AI 動工之前，先把目前的改動 commit（可由完工方自行 commit，或交 Claude 審查後 commit 並以 Co-Authored-By 標明出處）。同一時間**只有一個 agent** 改本機工作樹；真要平行用 `git worktree`。
- `main` 永遠保持可用；**一任務＝一分支＝一 PR**，PR 描述寫清楚改了什麼/為什麼/怎麼驗證。
- **堆疊 PR（base 指向另一個 PR 分支）合併時，不要用 `--delete-branch`**——刪掉基底分支會讓上層 PR 被 GitHub 直接關閉而非自動轉指向（2026-07-10 實際發生，#3/#5 被誤關）。先由下而上全部合併完，再一次刪分支；或乾脆避免堆疊、等前一個合併後再開下一個。
- 使用者是最終合併者。Commit 訊息用繁體中文、講清楚動機。
- 驗證要求：改前端 → 8 個頁面 reload 無 console error；改後端 → `node --check server.js` ＋ 以 seed 資料跑 `buildSummary()` 不拋錯；UI 變動附驗證說明。

### 審查分工：Codex 審、Claude 改（2026-07-10 使用者拍板）

三個角色各司其職，職責不重疊：

- **Codex＝審查者（唯讀）**：定期對 `main` 做程式檢視（找 bug、死碼、重複、可簡化處），**只提意見、不改檔、不 commit**。提意見前**先自己驗證能重現／指出確切 `檔案:行`**，不要丟未驗證的猜測。**觸發時機＝每批 PR 合併進 `main` 之後對 `main` 審一輪**（審穩定狀態，不審改到一半的分支）；使用者也可隨時手動要求。
- **使用者＝守門者**：決定「要不要做、先做哪個」。把 Codex 的審查**原文**交給 Claude（貼上或寫成檔案），**不要口頭轉述技術細節**（避免細節在中間走樣）。
- **Claude＝判斷＋實作者**：讀 Codex 原文後，**先拿每一條意見對本檔的投資語意與同步點清單把關**再動手。凡與「刻意設計」衝突的建議（例：Codex 常會說「COMPOSITION 兩份表重複，合併吧」，但那是前端無法 import 後端的**刻意同步點**），**擋下並向使用者說明為什麼不做**，不要盲目照修。判定該做的才走「一任務＝一分支＝一 PR」流程。
- Claude 的實作在下一輪 Codex 審查時才被覆蓋審到（有時間差）；money 相關的高風險改動，可在合併前明確請 Codex 先過一次。

## 已知待辦（背景脈絡）

- ✅ 估值訊號儀表（五市場檔位 → 動態股債比）已實作（PR #7）。
- ✅ XIRR 資金加權年化報酬已實作（PR #9，投組頁「投入 vs 市值」卡）。
- ⏳ 個股基本面分析方法待建立（AAPL/GOOGL 等）——下一項，先設計「研究一檔個股要回答哪些問題、看哪些指標」的框架，再決定 app 內怎麼承接（已有個股研究卡的論點/風險/檢查點欄位可用）。
