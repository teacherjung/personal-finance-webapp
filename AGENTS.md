# AGENTS.md — 給所有 AI 協作者（Codex / Claude / 其他）的專案規則書

這是三方協作（使用者 + Claude Code + Codex）的**單一真相來源**。動手前先讀完；改動若牽涉本文件的規則，請一併更新本文件。

## 專案概觀

本機優先（隱私第一）的個人理財網頁。**runtime 零建置**：改完存檔即生效，前端沒有 bundler/transpiler、不引入前端 npm 相依。**開發工具（devDependencies）為刻意引入**：typescript/@types（校對）、eslint（糾察）——只在開發/CI 使用、不影響 app 執行；新增 runtime 相依採「謹慎地裝」原則（要有明確理由，2026-07-13 使用者拍板放寬）。

## 發展方向與階段路線圖（2026-07-13 使用者拍板）

**終點＝多人註冊使用的服務**（幫他人保管理財資料＝重大安全責任，安全永遠第一優先）。分三階段、每階段讓下一階段變安全：

- **階段 A 安全網（✅ 完工）**：自動考試（`npm test`）→ 型別校對全覆蓋（`npm run typecheck`）→ 自動守門（pre-push hook＋GitHub Actions CI）→ 格式糾察（`npm run lint`）。
- **階段 B 骨架改建（✅ 完工）**：①B0 前置（STORE_FILE 隔離＋app 可測試載入＋端點測試）②B1 資料存取收斂到 `lib/repo.js` 單一櫃檯 ③B2 分層拆房間（routes/services）＋欄位白名單 ④B3 `store.json` → SQLite（含**驗證入櫃檯**）。**app 外觀與操作不變。**
- **階段 C 多人上線（進行中，C1–C5 ✅）**：雙模式開關（LOCAL／HOSTED）、帳號系統與 auth gate、租戶隔離（RLS＋CAS）、機密 envelope 加密與雲端匯出剝機密、速率限制與資源上限**都已上線**（細節見同步點清單）；剩 **C6**（合成資料的全面對抗審查收官）與 **C7**（真實資料上線＋DNS）。分階段裁決與威脅模型見 `docs/多人上線-施工計畫.md`。

審查與建議請以此方向為前提（正確性 bug 照抓）。

- 後端（B2 已分層）：`server.js`＝薄殼（啟動＋掛路由；LOCAL 只聽 `127.0.0.1`、HOSTED 聽 `0.0.0.0`，埠 `PORT` 或 4321）→ `lib/routes/*.js`（HTTP 路由：core/crud/market/ib/statement）→ `lib/services/*.js`（業務邏輯：learning/snapshot/ib-sync/statement-import）→ `lib/repo.js`（資料存取單一櫃檯；**C4a 起全介面 async**，見鐵則 8）→ **兩顆引擎（C4b）**：LOCAL＝`lib/store.js`（**SQLite `data/store.db`**，Node 內建 node:sqlite、WAL＋交易；舊 `store.json` 首次啟動自動搬家、原檔保留當備份）／HOSTED＝`lib/store-pg.js`（**Supabase Postgres**，`kv(user_id,key,data,version)`＋RLS＋compare-and-swap；結構在 `db/supabase-schema.sql`）。分流判準只有 `isHosted()`，**路由與 services 一行都不必知道差別**。欄位白名單在 `lib/schema.js`
- 資料：LOCAL＝`data/store.db`（SQLite，**已被 .gitignore 排除**；首次啟動從 `data/seed.json` 複製、舊 `store.json` 自動搬家）／HOSTED＝Supabase `kv`（新租戶從 `emptyDb()` 乾淨底稿起家、**不種 seed**、無本機備份與搬家）
- 計算大腦：`lib/derive.js`（淨資產/現金流/提醒/投資原則檢查）
- IBKR 串接：`lib/ib.js`（Flex Query 唯讀）
- 前端：`public/` 原生 JS SPA——`app.js`（共用工具+路由）、`modules/*.js`（頁面模組）、`modules/theme.js`（圖表色）、Chart.js（本機 vendor）。投資組合的**零 DOM／零 API 純模組層**分成 `modules/portfolio-calculations.js`（匯率表、持股成本、槓桿距離、交易損益換匯、XIRR 現金流組裝與求解）、`modules/portfolio-exposure.js`（資產型別、ETF 區域／公司穿透、幣別底層曝險）、`modules/portfolio-model.js`（把持股、帳戶與 IB 官方摘要組成頁面共用的台幣金額模型）、`modules/portfolio-state.js`（把金額模型整理成分層金額、QQQM 核心佔比、投資上限／凍結名單與 XIRR 頁面狀態）、`modules/portfolio-risk.js`（前後端共用的投資上限預設＋前端凍結加碼名單）、`modules/portfolio-report.js`（把已算好的投資資料整理成 A4 列印 HTML）、`modules/portfolio-details.js`（把已算好的成本、資產、交易資料排序成彈窗 HTML；格式器由頁面注入，維持 NT／US 雙計價）、`modules/portfolio-activity.js`（IB 現金流、交易摘要與匯率來源說明；只接資料＋目前計價，不碰頁面狀態）、`modules/portfolio-visuals.js`（紀律檢查、幣別／區域／公司曝險、分層配置與持股圓環；只接已算資料與格式器，不碰 DOM/API）、`modules/portfolio-valuation.js`（把 `signal-tiers.js` 算出的五市場檔位、CAPE 分位／規則帶與列印摘要排成 HTML；API、DOM、表單仍由頁面負責，門檻單一真相仍在 `signal-tiers.js`）、`modules/portfolio-tables.js`（把持股分層排序、價格／損益／佔比與願望清單狀態排成主表 HTML；排序狀態、localStorage 與事件仍由頁面負責）、`modules/portfolio-research.js`（把個股論點、指標、風險、最近檢查點與研究表單規格排成 HTML／資料；API 寫入與事件仍由頁面負責）、`modules/portfolio-overview.js`（把頁首、總覽卡、估值占位卡與 XIRR 摘要排成 HTML；金額格式、API、圖表與事件仍由頁面負責）、`modules/portfolio-chart.js`（把投入／市值月序列、NT／US 換算與 Chart.js 設定整理成純資料）、`modules/portfolio-quotes.js`（把 Yahoo 報價代號、匯率精度、幣別護欄與逐筆寫回計畫整理成純資料；API 與真正寫入仍由頁面負責）、`modules/portfolio-forms.js`（把持股／願望清單／估值表單規格、持股成本整理與凍結加碼原因整理成純資料；確認、API 與提示仍由頁面負責）與 `modules/portfolio-ib-sync.js`（把 IBKR 同步成功摘要與現金資料異常旗標翻成使用者回報；同步、寫入與已出清確認仍由頁面負責）。**個股研究頁（Codex P1–P5）另成一組**：`modules/stock-research-model.js`（持股／研究模型、空狀態四型、占比與上限組裝）、`modules/stock-research-score.js`（五構面評分：0 分是合法評分、五項未評完不算總分、同日歷史去重）、`modules/stock-research-view.js`（純呈現層＋四段就地解釋 `STOCK_RESEARCH_INFO`；交易一律**原幣呈現、不跨幣別加總**）、`modules/stock-research-page.js`（DOM／API／事件接線）。**入口只有兩個、且只給 `layer:'stock'`**（P5）：投資主表的代號（`portfolio-tables.js`）與研究摘要卡的「詳細研究」（`portfolio-research.js`），都用 `normalizePortfolioSymbol` 正規化＋`encodeURIComponent` 組 `#stock?symbol=`、`target=_blank`＋`rel=noopener`；ETF／債券／衛星與店名欄維持純文字。⚠️ 路由要吃得下 query（`router()` 的 `.split('?')[0]`）；⚠️ 新分頁會**獨立重跑一次開機序列**（報價／快照／店名整理／訂閱續費日推進）＝既定裁決，伺服器端都有時間閘或冪等保護（`docs/個股研究頁-施工計畫.md` §九）；改這些公式、成分表、頁面狀態、報表、明細、活動卡、視覺、估值、主表、研究卡、摘要、圖表、報價、表單或同步回報口徑要在對應檔補固定輸入輸出考題，不要把邏輯塞回 `portfolio.js` 的畫面流程。
  - **投資代號身分＝`modules/portfolio-symbol.js`**：只做 trim＋大寫，屬零 DOM／零 API 純規則；持股寫入、ETF 穿透、QQQM／CSPX 佔比、研究卡與前後端個股上限直接共用，避免空白／大小寫讓同一標的被拆成不同身分。
  - **投資編輯工作流＝`modules/portfolio-editors.js`**：持股／願望清單的表單開啟、凍結加碼確認、POST／PUT、成功提示與重畫集中在這裡；頁面注入 API、彈窗、確認與重畫工具，模組不直接 import `app.js`。改寫入順序或入口時要用假 API 補工作流考題，並維持凍結名單在「按下儲存」時才重讀。
  - **投資遠端操作工作流＝`modules/portfolio-remote-actions.js`**：IBKR 同步、可能已出清持股確認、Yahoo 報價與匯率逐筆寫回、按鈕狀態、成功／失敗提示與切頁序號防護集中在這裡；頁面注入 API、日期、提示與重畫工具，模組不直接 import `app.js`。改遠端操作時要用假 API 鎖住寫入順序、拒絕刪除、錯誤復原，以及「切頁後不重畫舊頁」。
  - **投資估值操作工作流＝`modules/portfolio-valuation-actions.js`**：CAPE／實質利率載入、五市場訊號與休眠匯率入口、三個設定表單、成功提示與重畫集中在這裡；頁面注入 API、DOM 查找、彈窗與格式工具，模組不直接 import `app.js`。改外部估值載入或設定寫回時要用假 API／假 DOM 鎖住雙來源讀取、失敗退路、表單 payload 與按鈕綁定。
  - **投資說明互動＝`modules/portfolio-info-actions.js`**：總市值、成本、股票／債券／現金／黃金、IB 活動、XIRR 與紀律檢查的唯讀彈窗入口集中在這裡；頁面注入 DOM、彈窗與格式工具，模組不直接 import `app.js`。改彈窗標題、尺寸或內容入口時要用假 DOM 鎖住每個按鈕的對應關係。
  - **投資研究互動＝`modules/portfolio-research-actions.js`**：研究新增／編輯、檢查點新增、POST／PUT、成功提示與重畫集中在這裡；頁面注入 API、DOM、表單、日期與提示工具，模組不直接 import `app.js`。改研究寫入時要用假 API 鎖住既有／新研究分流、payload、空白檢查點與失敗退路。
  - **投資頁拆分停止線**：`portfolio.js` 刻意保留八組資料載入、頁面模型／狀態協調、主 HTML 組裝、計價與排序狀態、持股／願望清單刪除綁定、圖表生命週期、各控制器啟動與 A4 報表列印。這些是頁面協調者的合理責任；**不要只為縮短行數繼續拆分**。往後只有責任真正變複雜、能形成獨立契約與考題時才新增模組。
  - **投資顯示格式單一真相＝`modules/portfolio-format.js`**：K／萬／百分比、NT／US 雙計價與 U+2212 負號都由這個零依賴純模組提供；`portfolio.js`、活動卡、A4 報表與折線圖共用。新增投資金額顯示時直接 import，不要另抄 `kNum`／`wanNum`／`fmtPct`；改格式時補固定數字考題並檢查四個使用端。總市值與紀律檢查的說明 HTML 存放在零依賴 `modules/portfolio-info.js`，頁面只接 `openInfo` 事件。休眠中的美元／台幣匯率儀表 HTML 存放在 `portfolio-valuation.js` 的 `fxGaugeHtml`，目前不插入頁面；要恢復時只在 `portfolio.js` 接 DOM 與表單事件，不把 HTML 搬回主流程。
  - ⚠️ **async render 寫 `#view` 前要 guard 序號**（Codex r10#6）：render 一進場 `const seq = currentRouteSeq()`，`await` 完、**動任何 DOM/圖表（含 `destroyCharts`）之前**先 `if (seq !== currentRouteSeq()) return;`——不然快速切頁時慢頁 resolve 會蓋掉新頁（router 的事後檢查太晚，寫入發生在 render 內部）。有遞迴重載（如 `renderSubscriptions` 的 autoExpire）也要在遞迴分支前 guard。**表單儲存後的重畫也必須先確認仍在原路由**，不可把裸的 `renderXxx` 傳給 async action；同一頁可同時啟動多代 render 時，再加頁面 generation，外部資料晚回來只能寫入目前 generation 的容器。
  - **帳單原文一律用 `origFromStmtRef`（後端）／`stmtOrig`（前端 `app.js`）取**，會剝去重序號 `|#N`（Codex r10#5）；不要在各頁手寫 `split('|').slice(3)`（會把「星巴克｜#2」當原文，改名/分組/tooltip 全對不上）。

啟動：需要 Node.js ≥22.13.0（內建 SQLite 從此版起不再需要 experimental flag）；`npm start` → http://localhost:4321。給使用者雙擊的 `start.command` 會先檢查 Node/npm、版本與首次相依安裝，失敗時保留白話訊息。注意：使用者常自己開著一個伺服器佔 4321，`.claude/launch.json` 已設 `autoPort`。

**型別檢查（可選、仍零建置）**：用 `jsconfig.json`（`checkJs:false`＝逐檔 opt-in）＋在檔案頂端加 `// @ts-check`＋JSDoc 型別。`npm run typecheck`＝本地 `tsc`（devDependencies：`typescript`＋`@types/node`＋`@types/express`，dev-only、不影響 runtime/不需 build；第一次要 `npm install`）。共用資料形狀集中在 `lib/types.js`（純型別、`export {}`，用 `/** @typedef {import('./types.js').Db} Db */` 引入）。**不 build、不改副檔名、不影響 runtime**——編輯器(VS Code) 與 `npm run typecheck`（npx 跑 tsc、不加相依）會抓「欄位打錯／型別不符／忘了處理 undefined」這類 `node --check` 抓不到的錯。**已導入全部前後端檔案**（lib/、routes/、services/、public/ 全數 `// @ts-check`；改動請保持 `npm run typecheck` 乾淨；型別集中在 `lib/types.js`）；pdfjs/xlsx 型別自動解析（`getTextContent` items 是 `TextItem|TextMarkedContent` 聯集，用 `'str' in it` 收斂）。**`store.js load()` 已標 `@returns {Db}`，`db.x` 全程型別化**（`Db`/`Settings`/`Card`/`Account`/`Holding`/`IbSettings`… 都在 `lib/types.js`；`settings` 與 `settings.ib` 視為一律存在）。**改 store 結構（emptyDb 加欄位）＝同步更新 `lib/types.js` 的對應 typedef**（否則 server.js 讀該欄會報「不存在」）。要再擴到其他核心檔（如前端 `app.js`）＝加 `// @ts-check`＋補型別到乾淨即可。這不是改用 React/Vite——只是零成本拿到 TS 的抓錯。

## 收支三層架構（三層重構 stage 1，使用者定 2026-07-20）

交易表 `transactions` 靠 **`ledger` 欄位**分成兩本帳，語意完全不同：
- **信用卡消費明細**（畫面名稱「信用卡費」；`ledger:'card'`，帳單匯入 `source:'stmt'` 自動蓋）：消費分析＋查帳用，**絕不進現金流加總**（那些消費的現金流出＝銀行帳本日後的「繳卡費」，兩邊都算就重複）。前端＝`public/modules/transactions.js`（頁面本體：列表/編輯/店家檔案）＋`public/modules/transactions-import.js`（帳單匯入工作流：上傳→預覽→匯入→批次管理；系統優化階段二①搬出，接縫＝transactions.js 的 renderTransactions/expenseParents/setMonthFilter）。
- **收入支出／現金流**（畫面名稱「銀行收支」；`ledger:'cashflow'`，手動記帳＋銀行對帳單匯入）：**現金流真相**。前端＝`public/modules/cashflow.js`。

⚠️**帳本判準單一真相＝`public/modules/categories.js` 的 `isCardTx(t)`**（後端經 `lib/derive.js` 以 `isCardLedger` 別名轉供，沒有前後端同步點）。用**排除法**：`ledger==='card'` 或（缺 ledger 且 `source==='stmt'`）＝card，其餘一律 cashflow——**缺 ledger 的舊資料/還原舊備份不掉帳**。讀現金流的地方（`derive.computeCashflow`、`cashflow.js` 月加總、店家檔案）都要 `isCardTx` 排除 card。

**三層分類（金流→分類→子分類）**：金流＝交易的 `type`（`income`/`expense`/**新增 `transfer`=內轉**，derive 只加總 income/expense，transfer 天然不進本月收入/支出）。**支出分類直接沿用 `expenseTree`（card 與 cashflow 共用一棵——`saveTree` remap 全部 expense 交易＝正確、不加 ledger 過濾，跨帳本連動是要的、統計才合得起來）**；**收入分類＝新的 `settings.incomeTree`**（`effectiveIncomeTree`/`saveIncomeTree`，`GET/POST /api/income-categories`，退路＝其他/其他收入，無別名機制——收入是手動選、沒有自動分類器）；內轉無分類樹（固定 內轉出/內轉入）。**繳卡費（stage 3 銀行匯入）category 留空**：計入現金流總額、但不進分類統計（卡明細已把那些消費分好類，重算會重複）。

⚠️**緊急預備金公式（使用者定 2026-07-20）**＝**台幣現金（`type='cash'` 且 `currency='TWD'`，活存＋定存都算、排除外幣）÷ 過去六個月現金流平均支出**（`avgMonthlyExpense` 窗口 6、只算有現金流資料的月份——半記錄月不拉低平均，是安全網保險）。自癒依賴＝每月匯銀行帳單，繳卡費那筆補回「刷卡消費的現金基礎支出」。⚠️**過渡期安全網保險（stage1→3 空窗，對抗審查抓到）**：卡消費排除後、還沒匯銀行帳單時 cashflow 支出≈0→月數虛高→緊急預備金提醒會**無聲關閉**（生存優先大忌）。解法＝`avgMonthlyCardExpense` 偵測「信用卡帳本近月平均消費 > 現金流支出基礎」時，**主動出聲**「緊急預備金月數可能被高估」（`computeReminders` 規則 2 後）——安全網不無聲關閉、明說原因與補法；銀行對帳單匯入後 cashflow 支出追上，此提醒自動消失。

⚠️**`ledger` 搬家一次性、共用單一判準**：`lib/store.js migrateLedgerIfNeeded`（meta 守衛 `__ledgerMigratedAt`＋`backupNow('pre-ledger-migration')`）＋`/api/import` 還原舊備份，**都走同一個 `normalizeLedger(txs)`**（source:stmt→card、其餘→cashflow；舊平面收入分類 `LEGACY_INCOME_MAP` 歸新樹）——別另寫一份判準。`ledger` **不進 CRUD 白名單、不進 REQUIRED_FIELDS**（必填會讓遷移前的舊列在下次寫檔被濾除），只在 FIELD_SCHEMA 有枚舉；手動記帳靠排除法天然歸 cashflow（不必前端送 ledger）。**分階段：stage 1＝拆帳本＋總覽改吃現金流＋收入樹；stage 2＝帳戶完整帳號＋概要區→更新/建帳戶餘額；stage 3（已做）＝明細→分箱進收支。**
⚠️**銀行對帳單解析器＝`lib/bank-statement.js`（與信用卡 `lib/statement.js` 完全分開）**：台新綜合對帳單餵的是現金流＋帳戶餘額，不是卡消費。**自己做保留 x 座標的抽取 `extractBankLines`**（銀行明細「支出金額/存入金額」是兩個獨立欄位、只填一個，靠 x 落在哪一欄判方向；statement.js 的 extractLines 丟了 x 不能用）。解析器/服務都吃「合成 x 座標列」測試、不需真 PDF（`test/bank-statement.test.js`；真 PDF 只做本機煙霧校準、絕不進版控）。⚠️**合成測試的帳號末碼一律用明顯假值**（前綴 900100/900200/900300、末碼 3301/3302/363/7788…），**絕不複製真實帳單的遮罩末碼**（stage 2/3 曾誤用真末碼＋前妻收款末碼、事後全數清理；真末碼＝PII，與 pdfPassword 同級）。stage 2＝`parseBankSummary`（概要區→帳戶末碼/餘額/幣別/現值參考日；外幣取**原幣**不是新臺幣、否則 derive 重複換匯；透支負餘額帳戶台新留空→略過）。**stage 3＝`parseBankDetail`（明細）＋`bank-import.js classifyBankTx`（分箱）**：⚠️extractBankLines 保留 **x＋y**——支出/存入靠 x 分欄（右對齊金額落該欄 header 與下欄 header 之間）、換行備註靠 y 歸到最近交易列。分箱規則（使用者定 2026-07-20，匯入是**預覽→確認**、自動分箱只是起點）：內轉（不計入收支）＝備註含自己帳號末碼（帳單自己的帳戶∪登記過 accountNo 的帳戶）**或摘要/備註含「劃撥」**（證券交割戶買賣 ETF 的投資金流，單筆可上百萬，**在備註不在摘要、務必判全文**——真實資料抓到只判摘要會讓百萬劃撥被當收入）；繳卡費（卡費/信用卡款）→支出**category 空**（卡明細已分類、不重複統計）；領現金（提款）→生活/其他生活雜支；手續費→其他/手續費；房貸→居住/房貸；養育→養育/贍養費（收款方末碼非自己帳戶＝真支出，非內轉）；存款息/利息→被動/利息；配息/收益分配→被動/股息；中獎→被動/中獎；鐘點→工作/鐘點；其餘落其他讓使用者改。銀行交易寫**現金流帳本**（ledger:'cashflow'、source:'bank'，非 stmt 故 card 專屬功能不誤掃），去重鍵 `bankRef`（含 running 餘額＝同日同額也唯一）。
⚠️**帳戶 `accountNo`（完整帳號，PII）**：前端可填、`secret-fields.js projectAccount` **GET 剝除只回 `accountNoSet`＋`accountNoLast4`**（同 pdfPassword「機密不送瀏覽器」；完整帳號只在伺服器端做末碼比對）。`balanceAsOf`＝餘額現值參考日（服務層寫、非 CRUD）。銀行對帳單匯入＝`lib/services/bank-import.js`：**末碼＋幣別比對**既有帳戶（`accountNo` 純數字 endsWith 帳單末碼，完整與遮罩都適用）→ 有就更新（**現值參考日較新才覆蓋**）、沒有就自動建（`type:'cash'`/`class:'現金'`/**不設 ibCashCur** 免污染投組現金與槓桿；accountNo 存遮罩帳號供日後比對）。純邏輯 `applyBalancesToDb`/`previewBalancesForDb` 與解析分離、可直測。密碼＝身分證字號只在記憶體傳給 pdfjs、絕不落檔、絕不入 log。上傳 UI 在收支頁（`cashflow.js openBankUpload`→預覽→確認）。 排序 infra 共用 `public/modules/tx-sort.js`（絕對值排序 r9#2＋日期次鍵 r8#2 封在那）。

## 鐵則（違反會壞事）

1. **敏感資料絕不進版控**：`data/store.json`、`*.bak`、`data/*backup*`（真實餘額、持倉、IBKR flexToken、**卡片的帳單 PDF 密碼 `pdfPassword`＝身分證字號**）。.gitignore 已擋，不要繞過。測試一律用 `data/seed.json`（維持「夠像真的」：多幣別、負現金融資、各層持股；**seed 的卡片不可放真實 pdfPassword**）。**非必要也不要「讀取」`data/store.json` 的內容**——它含真實個人財務資料與 token，讀進 AI 上下文等於外傳；要看資料形狀用 `seed.json`。帳單 PDF 只在記憶體解析、不落地保存。**機密投影要套在所有回應、含寫入端**（Codex r10#2）：`lib/secret-fields.js` 的 `projectCard`/`projectSettings`/`projectDb` 不只掛在 GET——`/api/cards` 的 POST/PUT、`PUT /api/settings` 的**回應**也要投影（改個名字/匯率就把存的 `pdfPassword`/`flexToken` 送回瀏覽器＝洩漏）。唯一例外＝`/api/export`，而它**兩種模式刻意相反**（C5 裁決⑤，`lib/routes/core.js`）：**LOCAL 完整含機密**（備份留在自己硬碟上，缺了密碼就永久還原不回來）／**HOSTED 剝除**（`stripSecretsForBackup`：那個檔案會經瀏覽器下載、可能轉寄或存到別處，風險完全不同；還原後重輸 IB 憑證與 PDF 密碼各一次）。**HOSTED 還一併剝掉 `accountNo`**（第二張清單，見下方同步點）。「留空＝不變更」保留，但要另給明確的「清除已設定」入口（送空字串清空，Codex r10#10）。
2. **循環 import TDZ**：`app.js` 與各 module 互相 import。任何「模組檔案頂層就會取用」的共用常數，必須放在**零依賴的 `modules/theme.js`**（或同型新檔）直接 import，**不可**經 app.js 轉手。曾因此全站白屏卡「載入中」。
3. **XSS**：所有使用者資料插入 innerHTML 前必過 `esc()`（app.js 提供）。
3.5. **原型污染**（Codex r4#1）：凡是**以使用者文字為 key 的 map**（學習表、分類別名 `categoryAliases`/`subAliases`、將來任何同型的表），寫入前一律過 `lib/safe-map.js`——`setOwn`（原型名回 false 拒收）、`getOwn`（只讀自有屬性）、`emptyMap`（null prototype）、`safeMap`（重建時丟掉原型名 key）。理由：`map['__proto__']={…}` 會污染全域 `Object.prototype`，**實測連 pdfjs 都當場崩潰**（`Object.defineProperty called on non-object`），不只是資料錯。學習表進出資料庫的必經之路＝`schema.sanitizeLearned`（已改 null-proto＋丟原型名）。⚠️ 光靠 `Object.create(null)` 不夠——`JSON.parse('{"__proto__":…}')` 造得出「自有的 __proto__ 鍵」，JSON 來回一趟就退化，所以讀寫兩端都要用 safe-map。**產品規則（Codex r5#1/#4 拍板統一）：寫入一律拒絕整個保留字家族（`isProtoKey`＝`__proto__`/`toString`/`constructor`…，服務入口明確 400、不靜默吞掉——靜默的後果＝「改名成保留字」變成刪除，儲存卻回報成功）；讀取容忍舊資料（只丟 `__proto__` 這個唯一的賦值陷阱鍵，toString 等安全自有鍵留著）。** 學習表的四條寫入路（`learnFromStmtEdit`/`learnFromImport`/`applyCategoryToStore`/`renameStoreDisplay`）＋刪除（`deleteLearned` 用 hasOwn、不可用會查原型鏈的 `in`）都已上防線並各有保留字考題（test/proto-pollution.test.js）。前端聚合（transactions.js byCat/totals/variants、subscriptions.js byCat/byCard×2、settings.js outTree）與後端聚合（derive.js byClass/targets、statement-import.js listBatches groups/normalizeBranches newLc）用 `Object.create(null)`／`emptyMap`——分類名/店鑰匙/備註/批次id/資產類別是使用者文字，普通物件的 `m[k] || 0` 撞到 toString 會撈到原型上的函式、加總變字串（Codex r5#5、r6#3 兩輪掃出九處）。⚠️ 三個最陰的變體（r6#3 實測）：①`m[k] ||= {…}`——k=`__proto__` 時讀到 Object.prototype 本尊（truthy 所以不重新賦值）→ **直接在全域原型上累加**；②前端把使用者鍵組進普通物件再 `JSON.stringify` 送後端——`__proto__` 在序列化前就消失，後端的保留字 400 防線根本收不到，畫面還回報成功（outTree 案例；null-proto 物件的 `__proto__` 是自有鍵、會正常序列化）；③查表 `({...})[name]`——name=toString 撈到原型函式（cardLabel 案例，用 `Object.hasOwn` 守）。**凡「使用者文字當 key」，聚合一律 null-proto、查表一律 hasOwn/getOwn，沒有例外**——r7#4 補收官四處：app.js router 的 `ROUTES[route]`（#toString 網址讓頁面卡「載入中」）、subscriptions `SUB_CAT_TO_EXPENSE[category]`（解構原型函式 TypeError）、market.js `/api/quotes` 聚合（symbols=__proto__ 吞鍵）、dashboard `CLASS_COLOR[k]` 查色。⚠️ 寫「保留字自有鍵」的考題要用 `JSON.parse`——物件**字面量**裡的 `'__proto__'` 是設原型的特殊語法、不會成為自有鍵，字面量寫的考題永遠測不到真實路徑。
4. **色彩分工**：
   - 分類色（圖表/長條/圓餅/圓點）只從 `theme.js` 的 `CHART`/`PALETTE` 取——六色盤已通過 dataviz 驗證，不要自創 hex。品牌珊瑚色（趨勢線、單色漸層）用 `theme.js` 的 `ACCENT`/`ACCENT_SOFT`。
   - 語意色 `--pos/--neg/--warn`（CSS token，六色盤同色相加深、對比 ≥4.5:1）**只給文字/標籤/提醒邊框**。
   - **填色條一律用 CHART 亮版**，不可拿深色 token 當填色（使用者抓過違規）。
5. **金額格式**（app.js 統一格式器，不要自己 toLocaleString）：
   - 統計卡片大數字 → `wan()`（萬）；表格/明細 → `money()`（元整數）/`moneyCur()`（原幣）。**例外：訂閱追蹤頁（含內嵌歷史紀錄）全部用 `money()` 元**——訂閱金額為千元級，用萬會變「0.1 萬」不可讀（使用者拍板 D7）；**例外二：證券交易頁**（原幣多幣別的 12 欄查帳表）用自製 `fmtAmt/fmtQty/fmtPrice`——純數字千分位、**不掛幣別後綴**（幣別自成一欄，掛了會擠爆），數量留 6 位小數（IB 碎股）、價格 4 位（securities.js 檔頭有註；S3 落地）
   - 負號一律 U+2212「−」；投資組合頁走 `MONEY()` 雙計價（localStorage `pf_viewCur`，NT=萬 / US=K USD）
6. **前端型別化的刻意放寬（勿當問題報）**：`app.js` 的 `byId()` 回傳 any、彈窗 `onMount(root)` 標 any、`globals.d.ts` 的 `Chart: any`——DOM 層刻意寬鬆（本專案以 innerHTML 樣板為主，元素層級逐處標型別是噪音；畫面正確性靠「全部頁面 reload 無錯」把關（頁數以 app.js ROUTES 為準，不寫死數字），型別檢查主力放資料邏輯）。`portfolio-valuation.js` 的 `fxGaugeHtml`＝**刻意休眠停放**（有固定輸入輸出考題、目前未插入頁面），非死碼、勿刪。
7. **UI 慣例**：卡片數字 `.stat sm`、表格數字欄 `.num`（右對齊 tabular）、空狀態 `.empty` 文案「尚無…」、頁首動作 `.page-actions`、卡片牆 `.grid.card-grid`＋`.detail-grid`、彈窗用 `openForm`/`openInfo`＋`modal-sm/md/lg/xl`、名詞說明用 `.info-link`（無底線，hover 珊瑚色）＋`openInfo`。**列表排序（tx-sort 慣例，自建排序也必須遵守）：降冪只反轉主鍵，第二鍵固定日期新→舊、不跟著反轉**（Codex r8#2：整個比較器乘 −1 會讓降冪時同值資料變舊→新）。
8. **repo 櫃檯是 async 的（C4a，2026-07-27；C4b Postgres 的前置）**——四條規矩：
   ①**呼叫必 `await`**：`getDb`/`saveDb`/`getCollection`/`addItem`/`updateItem`/`deleteItem`/`replaceCollection`/`getSettings`/`updateSettings` 全回 Promise（轉供的 `uid`/`emptyDb`/`backupNow`/`normalizeLedger` 仍同步）。最陰的漏法＝`res.json(service())` 忘了 await——**不炸、默默回 `{}`**；tsc 只抓得到「讀屬性」的漏，寫入 fire-and-forget 要靠自查。
   ②**Express handler 一律包 `wrapRoute`（statement/ib 慣例：帶 status 錯回原味 JSON）或 `asyncRoute`（core/crud/securities 慣例：一切交全域錯誤中介）**——Express 4 不接 async handler 的 rejection，裸的 async handler 拋錯＝unhandled rejection、請求掛死。兩個包裝器語意不同，別混用（會改變既有錯誤口徑）。
   ③**「getDb→改→saveDb」之間不可夾外部 IO await**（fetch/fs/timer）：LOCAL 下櫃檯呼叫只隔 microtask、Node 清空 microtask queue 前不會處理下一個請求，所以讀改寫鏈對其他請求不可分割（`test/repo-async.test.js` 用 HTTP 並發釘死）；一夾真 IO 就打開 stale-overwrite 窗口（先例＝syncIb r3#1／refreshQuotesIfStale r13#1 的「先抓完外部資料、才 getDb 寫」模式，照抄它）。同一個請求內也**不可 `Promise.all` 兩條寫入鏈**（兩者都會先讀舊快照、後寫蓋前寫）——寫入一律序列 await。
   ④**`updateItem` 的 `beforeSave` 必須是同步函式**（在讀寫之間對記憶體 db 動手；C4b 的 CAS 依賴此假設——衝突重試會**整段重跑**，所以 beforeSave 必須「對新讀出來的 db 重跑一次也對」，不可有外部副作用）。`effectiveTree`/`effectiveIncomeTree`/`effectiveTransferSubs` 已改**純函式、db 必填**——漏傳不再有預設值可躲（以前 `db = getDb()` 預設參數會拿到 Promise、默默退回內建樹）。
   ⑤**HOSTED 的並行安全＝compare-and-swap（C4b，契約 P1-5）**，兩條寫入路徑處置不同、刻意的：**櫃檯自己的五支**（`addItem`/`updateItem`/`deleteItem`/`replaceCollection`/`updateSettings`）改動邏輯在櫃檯手上，撞版本時**重讀重做重寫一次**、呼叫端無感；**`getDb…saveDb` 這一對**改動邏輯在呼叫端的記憶體物件裡，櫃檯**沒有能力重算**，直接丟 **409**（`server.js` 有專屬分支回原味訊息，不走「請求格式不正確」）。假裝重試＝拿舊快照再寫一次＝把別人剛寫的吃掉，比 409 危險得多。**`saveDb` 對「沒有版本戳的整包寫入」預設 throw**，只有 `/api/import` 明寫 `{ overwrite: true, from: snapshot }` 才准（全 repo 僅此一處）。⚠️**`from` 必須是呼叫端讀資料時那一次 `getDb()` 的結果**（2026-07-29 契約，Codex 收官審查 #2）——它同時是「機密的來源」與「版本戳的來源」，兩者**必須是同一次讀取**。舊行為是「寫入前一刻自己重抓一次目前版本」＝**自己蓋章給自己看**：CAS 只保護「重抓」到「寫入」那一瞬間，而真正要保護的是「呼叫端讀資料」到「寫入」的整段。已重現：A 分頁還原備份的同時 B 分頁存了新的 IB token → CAS 照樣通過 → 新 token 被舊值蓋掉、**而且回 200 說成功**。拿不出 `from` 一律 throw（`kv_no_version`），讓「無來源版本的整包覆蓋」在櫃檯上根本不存在；`store-pg.js` 的 `currentVersions()` 已**移除**（它的存在本身就是那個 bug，原地留墓誌銘說明不要加回來）。考題 `test/hosted-import-overwrite.test.js`（三種並發方各一題＋架構題釘死「只准一個入口、而且一定要帶 `from`」）。
   ⑥**本機檔案操作一律經櫃檯**（`backupNow`/`snapshotTo`/`dataDir`，維持同步簽名）：HOSTED 下 `backupNow` 回 `false`、另兩支 throw。理由不是潔癖——HOSTED 碰到它們會憑空建出一顆空的本機 SQLite，而空庫會被 `data/seed.json` 種底稿，於是「今天的備份」內容是 demo 假帳本、畫面卻顯示已備份。架構考題釘死「只有 `repo.js` 與 `store-pg.js` 能 import `store.js`」。

9. **突變測試的判準分兩型——用錯型會把真考題誤判成假的，也會把假考題放過**
   （2026-07-29 定；Claude 與 Codex 各用錯過一次，Codex 已撤回原結論並協助定案）。

   「補了考題」不等於「那題守得住東西」。唯一算數的證明是**突變測試**：把保護拿掉，考題必須紅。
   但**突變要怎麼下，取決於考題是哪一型**：

   | 型別 | 它在證明什麼 | **正確的突變** |
   |---|---|---|
   | **① 修法生效型** | 「這個修法真的接在正式路徑上」 | **拿掉修法** → 考題必須紅 |
   | **② 保存型** | 「受保護的狀態在某個操作之後仍然完好」 | **保留受測操作，破壞保存機制（或強制壞結果）** → 考題必須紅 |

   ⚠️ **對保存型考題，「刪掉受測操作」不是有效突變**——一題斷言「X 在操作 Y 之後還在」，
   把 Y 刪掉 X 當然還在，那不代表它沒在守東西。
   實例：`test/hosted-secrets.test.js` 的「來回②」曾被依此誤判為假考題；
   改用正確突變（把匯入端的機密保留改成一律清空）後**紅 3 題**，證明它是真的回歸守門。

   ③ **兩型都必須明確證明「受測操作確實執行」，而且不可依賴前一題留下的狀態。**
   保存型的正確寫法＝**先種一個本題專屬的新值**，走完受測操作後斷言它仍完好——
   受測操作因此提供了「受保護狀態被覆寫或清除的機會」，斷言才有意義。
   （只檢查前一題留下的狀態＝那一題其實什麼都沒測。）

   ⚠️ 突變腳本本身也會說謊：**一律先 `assert` 替換目標存在**再跑
   （踩過：bash 把 `${VAR}` 展開成空字串，替換根本沒生效卻顯示「通過」）。
   掃原始碼的形狀考題**要先去掉註解**（不然註解裡解釋病因的字會讓考題自己紅），
   而且**不可以只認得一種寫法**（踩過：只比對 `key: 'transactions'` 字面，
   換成 `const k = 'transactions'` 就漏）。

## 投資領域語意（改相關程式前必讀）

- **投資原則（使用者拍板）**：最高指導原則＝**生存優先**（在所有環境活著 > 多數環境賺更多），規則衝突時以此裁決。所有上限口徑＝**% 淨資產**（非投組市值）；區域曝險**穿透**計算（COMPOSITION 拆 ETF 成分）；**軟上限**＝超標僅「凍結加碼」提醒，**不強制賣**。上限存 settings：`ibConcentrationPct`(單一個股5)/`equityCapPct`(90)/`countryCapPct`(15)/`chinaCapPct`(15)/`levCapPct`(1.3)，設定頁「投資原則」卡可調。
**IB 現金幣別歸零**（Codex r4#3）：`syncIb` 對「這次報表沒出現、但過去由 IB 同步建立的現金幣別帳戶」歸零——否則某幣別現金提光後、下次報表不再列它，帳上永久殘留舊餘額、淨資產無聲虛增（實測 USD 1000 提光後仍算 32000 TWD）。⚠️**只在 Cash Report「確實有各幣別明細列」時歸零**（Codex r5#2 收緊，原判準＝區塊存在）：兩種「沒資料」都不可當「現金為 0」——①整個區塊缺失（Flex 漏勾/查詢失敗）→ 保留舊值＋回報 `cashReportMissing`；②區塊在、只有 `BASE_SUMMARY` 彙總列——**這也是合法報表**（Codex r6#1：基準幣別總額本來就住在彙總列，一律當「沒資料」會讓這種設定的現金永遠不更新、首次同步連帳戶都建不出來）→ 基準幣別判定得了（`AccountInformation.currency`）且彙總金額有效＝以「基準幣別彙總現金」**原子取代**全部 IB 現金（其他幣別現金帳戶歸零防重複計算）＋回報 `cashFromSummary`；判定不了＝保留舊值＋回報 `cashDetailMissing`（請在 Flex 勾 Account Information）。⚠️**多 statement 報表整包 400 拒絕**（Codex r6#2；r7#3 訊息分流）：`statementCount>1` 時持倉可能混疊/重複列出、現金與官方淨值只剩最後一份的值——在寫入任何東西之前拒絕；訊息依**去重帳戶數 `accountCount`** 分流（>1＝「多帳戶，請一個 Query 一個帳戶」；=1＝「多份報表（Model-by-Model bundle 之類），請改單一整體報表」——節點數≠帳戶數，話說對使用者才修得對地方）。兩種都拒＝刻意 fail-closed（bundle 的持倉可能整體＋分模型重複列出）。⚠️**彙總入帳的回報語意**（Codex r7#2）：折疊歸零記 `cashCollapsed`（≠`cashZeroed` 的「提領/轉走」語意，前端說不同的話）；基準幣別判定得出但不支援（EUR…）＝`cashBaseUnsupported`；基準幣別齊全、彙總列卻沒有可用金額（Ending Cash 欄缺）＝`cashSummaryMissing`（Codex r8#1）——三者都≠「缺 Account Information」的 `cashDetailMissing`，**病因要各自說對，使用者才修得對地方**。`lib/ib.js parseStatement` 回 `hasCashReport`/`hasCashDetail`/`cashDetailIncomplete`/`baseCurrency`/`baseSummaryCash`/`statementCount`/`accountCount` 供判斷。⚠️**現金金額欄嚴格取值**（Codex r9#1，高）：只認期末欄（`endingCash`→`endingSettledCash`），空字串/null/非數字一律視為「沒有金額」（`Number('')` 是 0——把空白當零會直接清空真實現金）；**絕不拿 `startingCash`（期初）冒充目前現金**；金額讀不到的幣別列＝`cashDetailIncomplete`（讀得到的照更新、讀不到的沿用舊值），**歸零「沒出現的幣別」需要明細完整（`hasCashDetail && !cashDetailIncomplete`）才允許**（已 export 供考題直測——旗標語意屬「中間那棒」，兩端測了中間沒測會漏）。**前端 portfolio.js 同步完成後必須把 `cashReportMissing`/`cashDetailMissing`/`cashFromSummary`(+`cashCollapsed`)/`cashBaseUnsupported`/`cashSummaryMissing`/`cashDetailIncomplete`/`cashZeroed` 都 toast 出來**（Codex r5#7：後端只寫 server console、前端無條件報「同步完成」＝使用者不知道淨值裡的 IB 現金是過期的）；新增同型欄位時前端提示要一起接，別只加後端。
- **融資槓桿只算 IB**：**優先用 IB 官方淨值摘要 `settings.ib.lastEquity`**（同步時更新、基準幣別 USD：stock ÷ (stock+cash)）；沒有同步資料才自算（`source:'ib'` 持倉 ÷ 淨值、融資＝`ibCashCur` 負餘額）。排除台新現金與台股，文案標「IB」前綴。`ibIdleCashAlert`＝IB 正現金閒置提醒門檻（USD）。
- **槓桿上限任何時期 1.3x**（2026-07-10 修訂，取消訊號期 1.6x——1.6x 撐不過 2008 級回檔）：估值訊號期加碼**只用新資金與現金、不舉新債**。**斷頭距離**＝市場再跌 x% 觸及 IB 強平線，`x = 1 − 借款 ÷ ((1−維持率) × IB 持倉市值)`（假設全倉維持率一致的近似）；維持率存 `settings.ibMaintenancePct`(25)。公式在 `portfolio-calculations.js marginCallDistance()` 與 `lib/derive.js` 規則 7 各一份（同步點）。
- **多幣別損益**：換算優先序＝IBKR `pnlBase` → `fxRateToBase` → USD 直通 → 設定匯率估算（需標註）→ 缺匯率不計入（需標註）。不可把非 USD 金額默默當 USD 加總。⚠️ **「缺幣別」與「缺匯率」是兩種病，處置不同（2026-07-28 全域政策，勿再退回）**：上面那條優先序講的是**缺匯率**；**缺幣別一律不猜**——`|| 'USD'` 這種寫法在本 repo 曾長出四份（`ib.js` 現金交易與成交紀錄、`ib-sync.js` 新持股、前端 `portfolio-calculations.js`），後果是 Flex Query 少勾一個 Currency 欄，GBP 100 的股息就被當成 USD 100 加總（少算 27%）且畫面零註記。正確處置＝**有 `fxRateToBase` 就照算（那條與幣別無關）；否則跳過＋分開計數回報**（`income.skippedNoCurrency`／`syncIb` 的 `skippedNoCurrency`），新持股缺幣別**不入庫**（猜錯幣別＝市值/淨資產/上限全錯）；既有持股保住原幣別、數量價格照常更新。**「幣別不支援」與「報表沒給幣別」的訊息必須分開講**，使用者才修得到對的地方。考題＝`test/ib-parser-money.test.js`＋`test/securities-sync.test.js`。**交易損益**（交易摘要＋XIRR）共用 `portfolio-calculations.js tradePnlBase()`，兩處口徑必須一致（否則 XIRR 漏估外幣賣出、年化偏低）。**現金流**（IB 股息/利息）在 `lib/ib.js parseStatement()` 解析時就套同一優先序（`lib/services/ib-sync.js` 依 settings 傳入估算器 `fxToBase`），估算/略過筆數存 `income.estimatedNoFx`/`skippedNoFx`＋幣別，前端與 PDF 都要註記。
- **XIRR（資金加權年化，台幣）**：現金流＝第一筆月快照市值（流出）＋各月快照投入增量（流出）＋IB 賣出已實現損益逐筆按成交日（`tradePnlBase`×usdTwd，流入，與交易摘要同口徑、含設定匯率估算）＋今日市值（流入）。**賣出只用 Δcost 會漏掉已實現損益，必須用 ibTrades 修正**；用估算時 header 標「含匯率估算」。不含股息利息；台股手動賣出未納入；快照未滿 60 天不顯示；|年化|>500% 視為資料異常。實作在 `portfolio-calculations.js portfolioXirr()/xirrRate()`（僅此一份）。快照資料曾含 seed 示範殘留（2026-07-10 已清），**判斷 XIRR 異常先懷疑快照資料**。
- 台股（0050/006208/00719B/00720B）無 API、手動維護股數；報價 Yahoo（台債後綴 `.TWO`；GBp 便士 ÷100 轉 GBP）。

## ⚠️ 同步點清單（改一處必須檢查另一處）

> **領域拆分（D4，2026-07-31 起）**：部分領域已拆到 `docs/contracts/`——**開工前先看 [docs/contracts/README.md](docs/contracts/README.md) 的路由表**（改哪些檔→必讀哪份契約）。拆出的領域在下表只留一行索引＋連結、完整內文逐字在契約檔；未拆領域照舊在本表。

| 改這裡 | 記得同步這裡 |
|---|---|
| SEC 官方指標候選 tag／`selectMetric`（`lib/stock-fundamentals.js`） | 同期依候選語意優先；各 tag 完整歷史先判口徑、最後才裁五年，任一年度／季度重疊衝突就拒絕整個低順位 tag；一般重疊差異 >0.1% 禁止接續，只有受限的百萬位申報進位例外；舊洞只有兩來源至少兩期完全同值才補；先由第一個可用 tag 鎖單一 unit，禁止取最大值或相加；`currentDebt` 各來源群與 `noncurrentDebt` 保留整條 first-hit；row-level taxonomy/tag 保留，`MIXED_TAG`／unit／YTD 只看實際輸出，衝突只警告可能進入輸出的缺期；F5 與 CAGR 等真正跨期比較 fail-closed，逐期比率保留 inputs；CBRE／Comcast／Verizon＋JNJ／AAPL／Alphabet／Dover 型必跑——完整契約 → [契約：投資與 SEC](docs/contracts/投資與SEC.md#sec-官方指標挑值) |
| SEC `currentDebt`（`lib/stock-fundamentals.js`） | 逐期間總額優先（DebtCurrent）；相加要 label 或數值證明排除父子重疊、否則保守不加；單源期間原樣保留；tag 單一真相 currentDebtSources；Dover／Amazon／Microsoft 三型考題必跑——完整契約 → [契約：投資與 SEC](docs/contracts/投資與SEC.md#sec-currentdebt-流動債務) |
| `lib/repo.js` 介面（加函式／改簽名） | **新函式一律 async**（C4a 契約，鐵則 8）：全部呼叫端 `await`＋handler 包 `wrapRoute`/`asyncRoute`；改完跑 `npm run typecheck`（抓「讀」的漏）＋grep 掃「寫」的 fire-and-forget（tsc 抓不到）；`test/repo-async.test.js` 的簽名鎖與 HTTP 並發考題必須仍綠。**C4b 起還要顧到兩顆引擎**：新的寫入函式要走 `mutate()`（才有 CAS 重試），新的讀取函式要走 `readDb()`（才有規則同步與版本戳）；`test/hosted-store-pg.test.js` 也要仍綠 |
| **kv 的鍵**（`lib/store.js` 的 `KV_KEYS`／`KV_MAP_KEYS`；`emptyDb()` 加頂層欄位時） | 三處一起：①`KV_KEYS`＋`KV_MAP_KEYS`（漏了那個鍵**永遠寫不進 db 且不報錯**）②`lib/types.js` 的 typedef ③**`db/supabase-schema.sql` 不必改**（kv 是 key/value，加鍵不用改 DDL）——但 `test/hosted-store-pg.test.js` 有「KV_KEYS 長度」的絆索會紅，那是提醒你回來讀這一列。⚠️ `lib/store-pg.js` **必須從 store.js import** 這兩個常數，不可以自己抄一份 |
| **HOSTED 資料層**（`lib/store-pg.js`／`db/supabase-schema.sql`／RLS 政策） | 兩邊是同一份語意的兩種寫法：`kv_save` 的 CAS 規則改了，`test-doubles/fake-supabase.js` 的 `saveAs` 要同步改（否則考題全綠、正式環境壞）。政策形狀（`FOR ALL`＋`USING`＋`WITH CHECK`＋`force RLS`＋service_role 無權限）有靜態考題盯著。**改完 SQL 要到 Supabase Dashboard 重跑一次**——那是唯一的部署方式 |
| PDF 逐列抽取器（pdfjs → 帶座標的列） | 三份刻意分工勿合併（信用卡丟座標／銀行保留 x+y／證券 x+y＋跨頁）＋各自的合成座標考題——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#pdf-逐列抽取器) |
| 信用卡負數交易的繳款／退款判斷 | 單一真相 `isCardPayment`；後端必須重判、不信前端；退款候選保留負號與 `refundOf`——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#信用卡負數交易的繳款與退款判斷) |
| 月度回顧的消費口徑與退款配對 | 配對本體＝`derive.js pairRefunds`（唯一實作，兩頁共用）；抵減順序、消費視角口徑、**配對身分不是 storeKey**——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#月度回顧的消費口徑與退款配對) |
| 信用卡費頁的兩種口徑（使用者定 2026-07-27） | 上半消費歸屬／下半帳面原貌**刻意並存**（加總不相等不是 bug）；配對一律向後端拿、兩端標記純呈現不寫回資料——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#信用卡費頁的兩種口徑) |
| 每日滾動備份（階段四 A，2026-07-27 上線） | 三種備份共用 `store.js snapshotTo(dest)`（VACUUM INTO→.tmp→原子改名；失敗丟例外＋清 .tmp）：啟動 `.bak`＝每行程一顆／操作前 `<tag>.bak`＝backupNow／**每日 `data/backups/store-YYYY-MM-DD.db`＝`lib/services/backup.js dailyBackupIfDue`，保留 30 天**。開 app 由 `POST /api/backup/daily`（日期用 snapshot.js `nowLocal()`，勿另算）觸發；同日已備且檔案還在＝跳過，檔案被刪＝補做。**失敗不擋 app**：不寫 `lastBackupDate`（今天才會重試）、`backupFailStreak` 累積、前端 `backup-alert.js` 畫面警告（≥3 次升 danger；**成功與抓不到回應絕不可出警告**——誤報會讓使用者學會忽略）。清理只認 `store-YYYY-MM-DD.db` 樣式＝正式庫絕不會被誤刪；先備份後清理。狀態欄位（lastBackupDate/backupFailStreak/backupLastError/backupLastErrorAt）＝**服務層擁有**（同 storeRulesHash：路由白名單擋前端寫、櫃檯放行、匯入備份被剝＝還原後當天自動重備）。**宣稱範圍（裁決）**：只防誤刪/錯誤匯入/程式寫壞，不防硬碟損壞；離開本機的備份等加密格式＋明確同意（DB 含明文 token/密碼）。考題 `test/daily-backup.test.js`（裁決五條全蓋）＋`test/backup-alert.test.js`。 |
| 異常輸入防線（階段四 B，2026-07-27 上線） | 字串長度兩級制（`lib/schema.js`）：**短欄位 `LEN_SHORT`=200**（預設）／**長內容 `LEN_LONG`=20000**（`LONG_TEXT_FIELDS` 名單：note/stmtRef/autoNote/bankRef/benefits/coverage/thesis…＋研究巢狀寫作欄 reasons/text/note/assumptions 掛 `{long:true}`）。**長度 400 只擋新輸入**（`pickWritable`＝CRUD，錯誤點名欄位＋上限＋實際長度、絕不靜默截斷）；**備份還原路（`validateImportItem`）與櫃檯（兩種模式）一律放行只 warn**——裁決「合法舊資料不可因升級被刪」，超長舊備份必須還原得回來（#201 的 >1MB 考題釘這件事；throw 會把還原變 500＝Codex r2 收官#1 同款教訓）。研究巢狀用模組級 `lenEnforced` flag 切嚴格/寬容（全同步無 await、不跨請求汙染；`sanitizeResearchItemLenient`）。settings 字串欄位未納入本輪（欄位少且全短、路由剝除語意既有——記錄在案的範圍取捨，Codex 覆核同意不列 blocker、多人化前另盤點）。**服務層新輸入路也要牆**（Codex #297 複審抓到繞道）：`POST /api/cards/:id/statement/import` 吃 client 直給的 rows、不經 pickWritable → `importRows` 入口逐筆驗 desc（長級）/category/subcategory（短級）超過整批 400 點名；銀行與證券匯入吃 b64 PDF 伺服器端解析＝天然安全（desc 非 client 直給）。新增「client 可直給列資料」的匯入端點時必須比照加牆。考題 `test/input-guard.test.js`。 |
| 雙模式與帳號系統（C2，2026-07-27 上線） | 開關＝`lib/hosted.js isHosted()`（**只認 `NOTEASY_HOSTED=1`**，不用 SUPABASE_URL 推斷）；HOSTED 缺環境變數＝啟動 fail-fast throw。**LOCAL 分支＝現狀零改動**（server.js 的 else 路徑；聽 127.0.0.1）；HOSTED＝聽 0.0.0.0（P1-6）＋公開站 public-site（extensionless rewrite）＋`/health` JSON（裁決④）＋`/finance`＝既有 SPA（C3 掛 gate）＋`/api/auth/*`。Auth＝`lib/services/auth.js`：**@supabase/ssr createServerClient、不自寫 token 邏輯（P1-4）**；cookie HttpOnly+SameSite=Lax+Path=/+**Secure 無條件、無開關**（Codex #301：測試開關在正式環境誤設＝session 降級，整個拿掉；Chromium 對 localhost 豁免 Secure＝本機測試不受影響）；登入失敗統一訊息不洩帳號存在性；user 只投影 id/email。CSRF＝`csrfOriginGuard`（變更類請求 Origin 白名單 `SITE_ORIGIN`；沒帶 Origin 放行＝SameSite 已擋跨站帶 cookie）。測試注入＝`setSupabaseFactoryForTest`（考題絕不打真 Supabase）；**secret 掃描考題**＝repo 追蹤檔的 JWT payload 解碼驗無 service_role。新依賴 @supabase/supabase-js+ssr（P1-4 官方流程必要）；⚠️ 既有 xlsx 依賴有無修可用的 advisory（本機單人低風險、記錄在案）。考題 `test/hosted-auth.test.js`。**C3 gate（同日）**：`authGate`（auth.js）＝HOSTED 下 `/finance`＋全部 `/api/*` 驗身分（白名單 `/api/auth/*`；`/health` 不在 /api 下天然不經牆）；API 未登入 401、頁面轉 /login；**currentUser 丟例外＝fail-closed 當未登入絕不放行**；**只宣稱 401、不宣稱 A/B 隔離**（單一全域庫，隔離歸 C4——P1-1 誠實劃界）。 |
| **機密欄位**（新增一個「不可外流」的欄位時） | ⚠️ **先分辨這是哪一類**（2026-07-29 起有兩張清單，見下一列）：要**加密**的走 `mapSecrets`，**刻意不加密、只是不該跟著備份檔出門**的走 `mapBackupOnlyPii`。以下講的是前者——**只改 `lib/secret-fields.js` 的 `mapSecrets`**，它是 C5 的加密清單，加密（`lib/crypto-secrets.js`）、解密、雲端匯出剝除、匯入不採用**四條路全部從它出發**。以前「哪些欄位算機密」散在三個投影函式各寫一次，再抄第四份必定走散（漏一個＝那個機密以明文躺在雲端資料庫，而且沒有人會發現）。加完跑 `test/hosted-secrets.test.js`（逐欄位驗）。⚠️ 路徑會拿去當加密 AAD，**必須穩定且唯一**（卡片用 id、不可用陣列索引；⚠️ 目前 id 缺失時會塌成 `cards..pdfPassword`，撞號的欄位在 C6 寫回保護裡會被跳過）。投影（`projectCard`/`projectSettings`）仍要各自更新——**加密管 at-rest、投影管不送瀏覽器，兩道各管各的、缺一不可**。 |
| **只剝不加密的 PII**（第二張清單，2026-07-29 建立） | `lib/secret-fields.js` 的 **`mapBackupOnlyPii`**（目前只有 `accounts[].accountNo`）。**它跟 `mapSecrets` 是兩件事**：`mapSecrets` 是加密走訪器，把欄位加進去＝**同時決定它要加密**，而「accountNo 要不要加密」是 C0 留給 William 的裁決（加密會連帶影響 `matchAccount` 的可見前綴比對與 `ownSuffixSet`）。這張清單只做一件事：**別讓完整帳號跟著備份檔離開伺服器**（`GET /api/export` 的檔案會下載到裝置、可能轉寄——與裁決⑤剝掉三個機密欄位是同一個理由）。**新增這一類欄位時，四處要一起接**：①`mapBackupOnlyPii` 本體 ②HOSTED 匯出剝除（`stripSecretsForBackup`）③**HOSTED 匯入端的對稱保存**（`lib/routes/core.js` 的 `isHosted()` 區塊）④瀏覽器投影（`accountNoSet`／`accountNoLast4` 這種）。**漏掉③＝「匯出→匯入回自己的帳號」會把值洗成空字串而且回 200**（2026-07-29 實際發生過）。⚠️ 回填只准在**三個條件同時成立**時做：①這一筆有穩定身分 ②目前資料那側沒有同路徑重複 ③匯入後那側也沒有。判準抽在 `lib/routes/core.js` 的 `keepableByPath`，**兩張清單共用**（`mapSecrets` 那張以前完全沒有這道防線，v6 才補上）。「穩定身分」＝`isStableId`：**只有非空字串算數**——缺 id 會塌成 `accounts..accountNo`／`cards..pdfPassword`，而 `id: 7` 與 `id: "7"` 經 `String()` 之後是同一條路徑，兩側各只有一筆時撞號根本數不出來。⚠️ **路徑本身照樣是字串、不是 `null`**（它是既有密文的 AAD，改了舊資料就解不開）；安全性靠走訪器回報的**第三個參數 `stable`**。⚠️ 兩個走訪器都**不可以要求「欄位已經存在」**（`'pdfPassword' in c` 這種寫法會讓省略欄位的舊備份整筆被跳過→現值沒機會填回、匯入回 200 後永久消失，而且還能繞過重複偵測）。三個條件是四次定向複審各抓一次才收斂出來的，**不要「簡化」掉任何一個**。考題＝`test/hosted-secrets.test.js` 的來回①③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭（⑪⑫鎖「缺欄位也要走訪」、⑬⑭鎖型別碰撞的**反方向**＝目標端身分不明）。 |
| 機密加密（C5，2026-07-27 上線） | `NOTEASY_MASTER_KEY`（base64 32 bytes，`openssl rand -base64 32`）進 `hostedConfig()` 的 fail-fast 清單——**缺了不可以「還是開得起來」**，那會讓 IB token 與身分證字號以明文落庫且無人察覺。AES-256-GCM，**AAD＝`使用者id｜欄位路徑`**（密文搬到別人的列或別的欄位都解不開）。解不開＝**回空字串＋警告、不炸掉**（生存優先：app 要能開，使用者重輸一次即可）；警告只講欄位路徑、**絕不含值或密文**。**LOCAL 維持明文**（檔案不出門，加密只是把鑰匙跟鎖放同一個抽屜）。**匯出兩邊刻意相反**：LOCAL 完整（缺密碼＝永久還原不回來）／HOSTED 剝除（裁決⑤，檔案會經瀏覽器下載）。**HOSTED 匯入不採用檔案裡的機密**，改保留目前已存的值（沿用「留空＝不變更」）。考題 `test/hosted-secrets.test.js`。⚠️**解不開＝絕不可以把密文蓋掉**（C6 止血，2026-07-28）：`saveKv` 每次寫入都重寫全部 KV_KEYS，所以「解不開回空字串」會在使用者下一次**隨手記一筆帳**時把原密文永久毀掉——主金鑰設錯一次＝IB token 與身分證字號全滅，**換回正確金鑰也救不回來**（已實測）。修法＝`loadKv` 把解不開的欄位記進**租戶槽** `tenantUndecryptableSecrets()`（`lib/tenant.js`），`saveKv` 對「這一輪解不開**且**現在要寫空字串」的欄位寫回原密文。三條規矩：①**每次讀取先 `clear()`**（CAS 重試會重跑 loadKv，不清空會把別的分頁剛正當清空的欄位復活）②判準刻意收窄——使用者輸入新值一律照常加密覆蓋，不可被舊密文黏住 ③**路徑撞號的欄位不登記**（`/api/import` 可帶沒有 id 的卡片，兩張都算出 `cards..pdfPassword`；按路徑寫回會把甲的密碼變成乙的——寧可少救一個欄位，也不要寫錯）。已知取捨：對「已經解不開」的欄位送清除會變成 no-op，但三個清除入口都由 `…Set` 布林把關、UI 走不到。考題 `test/hosted-secret-writeback.test.js`。 |
| 解析器資源上限＋slowloris 逾時（可用性第一層，2026-07-28 上線） | 單一真相＝`lib/parse-limits.js`。**上傳大小限制（http-body.js）不夠**——檔案小不代表解析便宜：200KB 的 PDF 可以有幾萬頁或幾十萬個文字節點，15MB 的 XML 展開成物件可能幾百 MB。所以三個 PDF 抽取器（statement／bank-statement／taishin-securities）各掛 `assertPageLimit`（200 頁）＋**逐頁累加**的 `countTextItems`（30 萬；等整份讀完才檢查就沒意義了），`lib/ib.js` 掛 `assertXmlSize`＋`assertXmlRowLimits`＋**`assertXmlElementLimit`**（三者都擋在 `parser.parse` 之前）＋`assertRowLimit`（5 萬列）。⚠️ **IB XML 的兩個上限是 2026-07-29 依實測重訂的契約（Codex 收官審查 #1）**，改動前務必先讀這一段：
  ・`MAX_IB_XML_CHARS` = **12MB**（原 40MB）。實測真實 IB Flex 排版（Trade 帶 50 個屬性、`--max-old-space-size=400`）：12MB→峰值 RSS 254MB、24MB→387MB、**40MB→行程直接死（OOM）**。也就是**舊上限本身就是死亡線**，而打死它的是一份完全合法、完全被列數牆數到的報表（38,805 筆 Trade，離 5 萬列上限還很遠）——所以 Codex 建議的「把更多標籤加進白名單」**修不好記憶體**。12MB 的推導：斜率約每 1MB XML 吃 12MB RSS，目標把解析多出來的記憶體壓在 150MB 內（512MB − app 底噪 148MB，再留給同時進來的其他請求）。
  ・`MAX_IB_XML_ELEMENTS` = **50 萬**（新增）。為什麼位元組上限不夠：同樣 12MB，真實排版是 18,289 個元素→254MB，極小元素 `<Z/>` 是 3,145,728 個→**472MB**，**元素多寡讓峰值差了將近兩倍**——兩道牆量的是不同的東西，缺一不可。而且這一道**不分標籤**，所以任何未來新增的 Flex 區段自動被涵蓋，不必再維護 `IB_ROW_TAGS` 那份白名單（原本只數四種標籤，實測 50,001 筆 `<CorporateAction/>` 原封不動通過）。
  ・⚠️ **已知代價（刻意的取捨）**：重度交易者的 365 天報表可能超過 12MB，會被要求縮短期間分批同步（錯誤訊息已明講該怎麼做）。「同步失敗但有明確指示」遠好過「全站被打掛」。要調鬆的話改一個常數即可，但 `test/ib-parser-money.test.js` 有一題**用子行程實際驗證這個推導**（餵一份剛好等於上限的真實排版報表，在 400MB heap 下必須活著跑完），調高了那一題會紅——到時候要一起把新的推導寫清楚。⚠️ **超標一律丟 400 拒絕、絕不靜默截斷**（截斷會讓使用者以為匯完了、其實少了半年）。**兩種模式都套**（與速率限制不同）——畸形檔案在本機一樣會遇到，同階段四 B 異常輸入防線的邏輯。⚠️ **IB 那條路 2026-07-28 補了三個洞**：①`getText` **不可以用 `res.text()`**（那會把任意大小的回應整包吃進記憶體，`assertXmlSize` 才看得到＝檢查太晚；改用 `readCappedText` 邊收邊數，並先看宣告的 Content-Length）——這條路 `sendRequest` 與 `getStatement` 共用，所以第一步的回應也一併有了上限 ②列數要在**原始 XML 上數**（`countXmlRows`／`assertXmlRowLimits`），不是等 `parse()` 展開成物件才數陣列長度，而且要涵蓋 **`OpenPosition`**（原本完全沒數，20 萬筆持倉暢行無阻）③`parseStatement` 的列數改成**跨 statement 累計**（原本每份各自檢查，10 份 × 各 3 萬筆＝總量 30 萬筆全部放行）。⚠️ 三個 PDF 抽取器的 `task.destroy()` 一律放在 **`finally`**——上限一 throw 就跳過它，pdfjs 的 worker 留著不放＝「防資源耗盡」的路自己在漏資源，而且**只有被攻擊時才會發生**。⚠️ **考題要打「整條路」，不是只考純函式**：實測把 `readCappedText` 改回 `res.text()`、把 `assertXmlRowLimits` 整行刪掉，純函式考題**全綠**——牆蓋得對 ≠ 牆蓋在路上（`test/ib-parser-money.test.js` 的三題「整條路｜…」打真的 `fetchFlex`）。slowloris＝`applyHostedTimeouts`（**只收緊 HOSTED**）：header 20s／請求 **270s**／keep-alive 10s。⚠️ **requestTimeout 不是憑感覺訂的**：它是「收完整個 request 的總時間」（不是 idle timeout），等於一條隱形的最低上傳速度規定＝`最大 body ÷ requestTimeout`。舊值 120s 配 50MB＝要求持續 437KB/s，實測 300KB/s 的上傳在 120.0 秒被切斷只收到 36MB＝**正當的大備份還原被誤殺**。新值由 `MIN_UPLOAD_BYTES_PER_SEC`(200KiB/s) 除出來。放寬它安全的理由：slowloris 的本體是 header（由 20s 擋著）、大 body 端點都在 authGate 之後、尖峰記憶體是「速率上限 × body 上限」決定的、與 requestTimeout 無關。**✅ 壓縮炸彈已修（2026-07-29，取代下面那段過期的「已知未修」）**——原文說「`streamTextContent` 實測零收益（640MB vs 640MB）卻可能讓真實帳單安靜解析錯」，**重新實測後兩句都不成立**：①138KB 的一頁 PDF 612MB→254MB、207KB 的 704MB→316MB（原本兩份都會打死行程）⚠️ **死法不只 OOM（2026-08-02 追出，#350 r2）**：更常見的是 **pdfjs 卡死在解壓、promise 永不 settle**——實測子行程 1.4 秒 `code 0` 靜默退出（stdout/stderr 全空）、行程內直跑是 exit 13。舊敘述把兩種死法都寫成 OOM，害父行程把「沒有 stdout」當成「使用者檔案太貴」回 400。現行：子行程 keep-alive 不准安靜退出、逾時判定收斂在父行程一處（逾時／OOM 訊號才 400，其餘 500）；②正確性用擬真帳單（6 頁×120 列、多字級、FlateDecode）兩種抽法逐項比對，抽取器真的會用到的欄位（`str`／`transform[4]`／`transform[5]`／`width`）**完全相同**（只有 `fontName` 的 `g_d0_`/`g_d1_` 前綴不同，那是「本行程載入的第幾份文件」的計數器，三個抽取器都沒用到它）。⚠️ **那句錯誤的宣稱害我差點跳過真正的修法**——文件裡的「實測結論」過期或本來就錯，比程式的 bug 更難發現。
  修法兩層：**①邊收邊數**（`readPageTextCapped` 用 `streamTextContent()` 超標當場 cancel，兩種模式都套）**②行程隔離**（`lib/pdf-isolate.js`，**只套 HOSTED**——William 2026-07-29 裁決；本機只有自己在用、檔案都是自己下載的，不值得付每次 250ms）。⚠️ 用字precision：子行程帶的是 **`--max-old-space-size`（V8 old-space 上限）**，**不是硬性 RSS 上限**——off-heap 的配置它管不到。實測對這兩種攻擊足夠（父行程 RSS 109→113MB，連打五次），但別把它當成萬用的記憶體天花板。⚠️ **LOCAL 仍然帶著這個洞，是明知的取捨、不是漏掉的。**考題 `test/parse-limits.test.js`（含「上限別調太小」的絆索：訂太小會先撞到斷言並讀到理由）。**③ XLSX 也走同一條隔離**（#373，2026-08-02）：一份 468KB 的**合法** .xlsx 解壓後可以吃掉 856MB。原本的路是「自己先掃一遍 ZIP 判斷這份貴不貴」（#342），**被打穿四次**——每次都是同一類病：牆與 SheetJS 對格式的理解差一點（最後一次差在「牆讀 EOCD +10、SheetJS 讀 +8」＝兩個位元組）。**隔離不需要看懂格式**，這是換掉那道牆的全部理由。⚠️ **鐵則：全 production tree 只有 `lib/statement.js` 可以 `import xlsx`**——**執法者是 ESLint**（`eslint.config.js`：`no-restricted-imports` 管靜態引入、`no-restricted-syntax` 的 AST 選擇器管動態 `import()` 與 `require`；另**關掉 `createRequire`**——取別名再呼叫是 AST 上唯一看不出是 require 的路，本專案純 ESM 全樹零使用，關掉成本是零）。⚠️ **不可自己寫正規表示式掃字串**（Codex #374 r1 抓到）：註解在 JS 語法上等同空白，`import XLSX from ⟨註解⟩ 'xlsx'`、`import 'xlsx'`、`await import ⟨註解⟩ ('xlsx')` 都是合法寫法——我手寫的 regex **七種寫法漏掉五種**。用字串比對解析一門語言，補到死也補不完；parser 看語法樹，這些寫法對它是同一件事。`test/xlsx-isolate.test.js` 的職責因此改成**盯著執法者還在不在**（規則被刪、ignores 被偷加檔案 → 紅；七種寫法逐一丟給真的 eslint 跑 → 任何一種沒被擋下就紅）。別的檔案引入就代表那條路不經子行程，攻擊檔會直接打在主行程上。⚠️ **架構掃描題的檔案清單一律用 `git ls-files --cached --others --exclude-standard <production 路徑>`**（repo 既有寫法見 `test/hosted-store-pg.test.js` 的 `libFiles`）——**不可自己 `readdirSync` 遞迴走訪**：2026-08-02 實測，自己走訪會把 `.claude/worktrees/` 底下的 repo 副本也掃進來，CI 是乾淨 checkout 所以全綠、**只有真正在用的那台會紅**，是假紅裡最糟的一種（擋住 push，還看起來像程式壞了）。`--others` 也是刻意的：違規的新檔要在 `git add` 之前就被抓到，否則護欄會在最需要它的那一刻失效。⚠️ **防假紅的考題自己要造誘餌**：只斷言「現在沒掃到副本」的話，CI 是乾淨 checkout 永遠綠，有人改回走訪也抓不到——**那題就只在出事的那台有效，等於沒有防線**。現行寫法會自己建一份 `.claude/worktrees/_guard_probe/lib/statement.js` 再刪掉（實測：改回走訪就紅）。⚠️ **攻擊題必須在另一個行程產生攻擊檔**（Codex #373 r1 抓到假綠）：在測試行程裡就地組出 390MB 再量 RSS，基準線早就含了攻擊內容，「增量」還會是負數——**那樣量的是垃圾回收，不是隔離**。現行考題另帶一組「不隔離」對照（實測 856.8MB vs 6.0MB），沒有對照組的話「只長 6MB」只是一個孤零零的數字。 |
| **SEC 全站佇列護欄（2026-07-30，#335 複審 dos 條）** | 深度上限 16＋**SEC 網路管線**總預算 60s（誠實範圍不含本機解析與快取寫入；兩模式都套）；硬期限只准在「未開始執行」時 race；守門收斂成一道＋逐呼叫點補題、期限參數必填 number——完整契約 → [契約：投資與 SEC](docs/contracts/投資與SEC.md#sec-全站佇列護欄) |
| 速率限制（可用性第一層，2026-07-28 上線） | `lib/rate-limit.js`＝記憶體內固定窗口、零依賴、**時鐘可注入**（考題不等真實時間）。**只在 HOSTED 掛**（LOCAL 一個人用自己的電腦、只聽 127.0.0.1，限了只會擋到「一次補匯十二個月帳單」這種正當密集操作——`test/server.test.js` 有反向考題釘住）。**路徑表＝單一真相 `server.js` 的 `RATE_LIMITS`**（掛載與正反兩面考題全部從它反查；⚠️ 加新的一道只改這張表，**不要自己在考題裡挑一條路徑打**——原本的 LOCAL 反向題挑到 `/api/transactions`，而那條根本沒掛限速，於是誤掛到 LOCAL 也照樣綠＝假考題）。五道：①登入類**按 IP**（`stage:'pre-gate'`，登入還沒有身分；只限 login/confirm/set-password，`me`／`logout` 是輕量讀取不限）②上傳解析類**按帳號**（30/5 分）③**IB 同步 6/5 分**④**報價 60/5 分**⑤**SEC 官方基本面 refresh 12/5 分**（②③④⑤ `stage:'post-gate'`，掛在 gate 之後所以拿得到身分；同一個出口 IP 的兩個人不該互相排擠）。③④⑤ 的理由與②不同：**它們會對外連線**，猛打等於拿我們的伺服器去打 IBKR、Yahoo 與 SEC、可能害使用者被對方限流。超限直接回 **429＋`Retry-After`、不 throw**（被猛打時不該再產生堆疊物件）；取不到 key 就放行（寧可放行也不誤擋）。⚠️ **每顆計數器有 `maxKeys`（預設 10000）＋淘汰**：`sweep` 每個窗口最多跑一次，兩次之間攻擊者高速換 IP 可以塞進幾百萬個鍵＝「防資源耗盡」自己成了資源耗盡的來源。淘汰挑**最早插入的**（O(1)，不在被猛打時掃全表），這靠 `hit()` 續約時**先 delete 再 set** 維持「插入順序＝到期順序」——`Map.set` 對既有 key 不改插入位置，少了那個 delete 就會淘汰到最晚到期的那一個（考題釘死）。⚠️ **HOSTED 必須 `app.set('trust proxy', 1)`**——不設的話 `req.ip` 是代理 IP，「每 IP 限制」退化成「全站共用一個額度」。⚠️ **`trust proxy: 1` 的正確性有一個前提**（2026-07-28 釐清）：它取 `X-Forwarded-For` 的**最後一個**＝「我們前面那一層代理實際看到的來源」。Render／Cloudflare 都是 append，所以正常拓樸下這是對的、偽造不了。**但前提是「源站不可直達」**——只要有人繞過 Cloudflare 直打 Render 原始網址，那個最後一個就變成他自己填的（見 `renderSubdomainPolicy`）。「限速的來源判定」與「關掉 onrender 子網域」是**同一件事的兩半**，不可只做一半。⚠️ **多實例部署時每個實例各算各的**（上限變 N 倍）：Render 目前單實例；要開多實例前必須改成共用儲存。**誠實劃界：這一層防的是「單一來源猛打造成的行程資源耗盡」，防不到真正的大流量 DDoS**（那要 Cloudflare，見 docs 第十節）。考題 `test/rate-limit.test.js`＋`test/hosted-auth.test.js`。 |
| 租戶隔離與雲端資料層（C4b，2026-07-27 上線） | **身分交棒點＝`authGate`**：驗完身分後整條請求鏈跑在 `runWithTenant({userId, supabase}, next)`（`lib/tenant.js`，AsyncLocalStorage，契約 P1-2）——**必須包住 `next`**，不可用 `enterWith`。資料層從 context 拿身分，**絕不從請求參數拿 user_id**；沒有 context＝`requireTenant()` throw＝fail-closed。**隔離只靠 RLS**：`lib/store-pg.js` 的查詢**一條 `where user_id` 都不下**（考題斷言 `filters` 為空），列的歸屬由 `default auth.uid()`＋政策 `with check` 決定；一般讀寫一律用**使用者 JWT 的 client**（gate 傳下來的），**service_role 不准碰 kv**（裁決⑥，SQL 直接 `revoke`）。新租戶＝`emptyDb()` 乾淨底稿，**不種 `data/seed.json`**（那是 William 本機的示範資料）。⚠️**跨租戶污染的隱蔽破口已修**：店名規則本來是模組級單例（`lib/store-rules.js`），HOSTED 改成 per-request 槽——否則 A 的規則會被 B 的讀取洗掉，而 `userRulesFingerprint()` 會把污染值**持久化**進 `settings.storeRulesHash`。⚠️**要加新的請求範圍狀態，一律加進 `lib/tenant.js` 的 context 物件，不要在別的模組開模組級 `let`／`Map`**（目前有兩個槽：`rules` 與 C6 的 `undecryptable`；後者若做成模組級，A 解不開的密文會被寫進 B 的列＝同一類跨租戶污染，而且後果是資料毀損）。順帶修掉 `dismissHealthItem` 在讀改寫中間夾一次 `getDb()`（LOCAL 看不出來、HOSTED 是真的網路往返）。每日備份在 HOSTED **整支短路**（`ran:false, hosted:true, failStreak:0`）。考題 `test/hosted-store-pg.test.js`（23 題：逐集合列舉隔離／PUT・DELETE 打別人的 id／CAS／匯入綁 session user／絕不落回 SQLite／fail-closed／規則不污染／JSONB `__proto__` 往返／同代號 SEC 公開抓取共用但租戶寫入分離／架構護欄／SQL 政策形狀）＋假 Postgres 在 `test-doubles/fake-supabase.js`（**不在 `test/` 底下**——`node --test` 會把 `test/**/*.js` 全當測試檔載入）。**誠實劃界：本階段證明的是「我們的程式在正確的資料庫語意下不洩漏、不互蓋」；「Supabase 上的 RLS 真的寫對了」要打真 Postgres＝C6 驗收。** |
| 部署設定（`render.yaml`＋CI，2026-07-28 對齊） | **Node 版號只准有一個地方寫＝`.node-version`**（目前 22.23.1）。Render 的優先序是 `NODE_VERSION 環境變數 > .node-version > .nvmrc > package.json engines`，所以 render.yaml **刻意不設 `NODE_VERSION`**——設了就會蓋掉 `.node-version`，而 CI 的主 job 讀的正是同一份（`node-version-file`）。⚠️ 病史：render.yaml 釘 22.13.0、CI 寫死 24、開發機 26，結果**真正上線的那顆 runtime，三道關卡一次都沒測到**。要換版本＝改一個檔，部署與 CI 一起動。CI 第二個 job `dev-machine`（Node 26＝William 本機那顆，讓「只在他機器上壞」也能在 PR 看見）刻意 `continue-on-error: true`——它是**探照燈不是門**，不該有權力擋住安全更新的部署。**`autoDeployTrigger: checksPass`**（不是 `autoDeploy: true`＝型別錯／考題紅也照上；兩個都寫時前者勝出，舊欄位要刪乾淨）；代價＝**沒有任何 check 的 commit 不會自動部署**，所以 CI **不可以加 `paths` 過濾**（會讓某些 commit 靜默不部署，比壞掉更難查）。**`renderSubdomainPolicy` 必須明寫**：不寫＝onrender 子網域開著，任何人可直連源站、繞過 Cloudflare 的 DDoS／WAF／速率限制——**也讓 `trust proxy` 的來源判定失效**（見速率限制那一列，兩者是同一件事的兩半）。Render 規定要設 `disabled` 至少要有一個 custom domain，所以 C6 測試期先明寫 `enabled`，C7 指好 DNS 時與 `domains:` 同一支 PR 改。⚠️ **xlsx 從原廠 CDN 裝（`https://cdn.sheetjs.com/…`，#346，2026-08-02）——完整性與可用性是兩件事**：完整性由 `package-lock.json` 的 sha512 integrity ＋ `npm ci` 守住（CDN 上的檔案被換掉會直接安裝失敗，**不會靜默吃到新內容**）；可用性則要求 CI 與 Render 都連得到 `cdn.sheetjs.com`——離線、企業 proxy 未放行、或 CDN 暫時掛掉時會**裝不起來（fail-closed）**，不是默默降回 npm 上的 0.18.5。換部署環境或加網路白名單時要記得放行這個網域。考題 `test/deploy-config.test.js`（7 題；**「有 domains ⇒ 必須 disabled」刻意只驗單向**——反向會在「網域從 Render 後台加、render.yaml 沒有 domains 區塊」時，強迫把子網域重新打開才能讓 CI 綠）。**誠實劃界：靜態考題只證明 repo 寫得對，證明不了 Render 後台照著跑**（有人手動改後台就會走散）——那屬 C6 部署後人工確認。 |
| 月度回顧總覽卡 | 純呈現層分工（前端不得重算）＋切月 route/序號與 aria-busy 守則——完整契約 → [契約：前端功能](docs/contracts/前端功能.md#月度回顧總覽卡) |
| 淨值目標與到達速度 | 後端單一真相＝`lib/derive.js computeGoalTracking(db, now)`，由 `buildSummary.goalTrack` 供前端顯示，**前端不可重算**。目標 `settings.netWorthTarget` 以台幣元保存（設定頁 P2 用萬元輸入），只收正數或 `null`。兩把尺都只看最近六個**已結束月**、至少三個月份、取中位數：①現金結餘只收 cashflow 帳本的 income−expense（card／transfer 排除）；②整體淨值變化用 snapshots，相鄰缺月要除以實際相隔月數，且文案須說含市場、匯率與帳戶更新。速度≤0 不算負月數／Infinity；資料不足仍顯示進度。達標除了在目標區顯示，也由 `computeReminders` 產生穩定 key `goal-reached`、`level:'info'` 的報喜事件：新聞牆第一次標 🆕、之後收進持續中，不另改 `insightState`。 |
| `public/modules/portfolio-exposure.js` 的 `COMPOSITION` 穿透表 | `lib/derive.js` 的同名複本 |
| `portfolio-exposure.js` `fxExposure` 寫死的台幣掛牌美債 ETF 清單（00719B/00720B） | 新增同類 ETF 時要補進清單 |
| 新增 ETF 持股 | COMPANY_WEIGHTS＋兩份 COMPOSITION 都要補；XUSE/EXUS 刻意只做區域穿透——完整契約 → [契約：投資與 SEC](docs/contracts/投資與SEC.md#新增-etf-持股) |
| `lib/services/ib-sync.js` `DEFAULT_LAYER` 新增代號 | 兩份 COMPOSITION 也要有該代號，否則穿透 fallback「其他」、國家上限提醒偏掉——完整契約 → [契約：投資與 SEC](docs/contracts/投資與SEC.md#ib-sync-default_layer-新增代號) |
| IB 槓桿＋斷頭距離公式（lastEquity 優先、自算 fallback） | 後端 computeLeverage ↔ 前端兩檔一致；mcDist：無借款＝100、有借款持股歸零＝0，兩情境不可混——完整契約 → [契約：投資與 SEC](docs/contracts/投資與SEC.md#ib-槓桿與斷頭距離) |
| 投資代號與投資原則上限／凍結加碼 | 代號一律 normalizePortfolioSymbol＋同代號彙總；上限設 0＝零容忍不可 || 回預設；編輯持股把代號／身分**改成**已凍結標的（即使股數沒增加）也要警告——完整契約 → [契約：投資與 SEC](docs/contracts/投資與SEC.md#投資代號與原則上限) |
| **訂閱續費日自動推進**（使用者定 2026-07-26） | 開 app 自動推進過期續費日：判準／月底錨點／不推清單／只動日期不動金額／推後重繪——完整契約 → [契約：前端功能](docs/contracts/前端功能.md#訂閱續費日自動推進) |
| 訂閱本月攤提（停用當月月繳不計、季/年繳按天數比例） | 前後端三處攤提口徑一致＋RECORD_START 單一真相＋勿改回 active 過濾加總——完整契約 → [契約：前端功能](docs/contracts/前端功能.md#訂閱本月攤提) |
| 訂閱狀態（使用中/即將停用/已停用） | 前端 subStatus ↔ 後端 subActive 口徑一致（項數才不打架）——完整契約 → [契約：前端功能](docs/contracts/前端功能.md#訂閱狀態) |
| YYYY-MM-DD 日期解析 | 一律本地時區拆日期；new Date(字串) 會當 UTC、以西時區差一天——完整契約 → [契約：前端功能](docs/contracts/前端功能.md#yyyy-mm-dd-日期解析) |
| `theme.js` 的 CHART.green/red | styles.css .cb-ok/.cb-over 寫死同色 hex（CSS 無法 import JS）——完整契約 → [契約：前端功能](docs/contracts/前端功能.md#theme-色票) |
| settings 新增欄位 | `lib/store.js emptyDb()` 預設值＋`data/seed.json`＋設定頁 UI＋`lib/types.js` 的 `Settings` typedef＋**`lib/schema.js` 的 settings 白名單**（前端可寫的頂層欄位進 `SETTINGS_WRITABLE_FIELDS`、signals 進 `SIGNALS_WRITABLE_FIELDS`、ib 進 `IB_WRITABLE_FIELDS`；漏加會在 `/api/settings` 被剝掉、console 有警告。IB 同步擁有的 lastEquity/income/lastSync 刻意不在白名單、只由 `lib/services/ib-sync.js` 寫）。**非前端寫、但由服務層存進 settings 的欄位（如 `expenseTree`/`incomeTree`/`categoryAliases`/`subAliases`/`incomeCategoryAliases`/`incomeSubAliases`、`storeRules`）＝匯入備份必須保留**：加進 `sanitizeSettings`（否則 export→import 會遺失、Codex#1）＋`sanitizeSettingsDeep`（櫃檯），兩者共用同一個驗證器（分類欄＝`sanitizeCategorySettings`；店名規則＝`pickStoreRules`→`lib/store-rules.js` 的 `sanitizeStoreRules`，形狀與編譯器住同一個檔才不會走鐘）。⚠️**收入別名（`incomeCategoryAliases`/`incomeSubAliases`，Codex r13#3）與支出同款**：銀行匯入會自動分類收入（classifyBankTx 出 被動/利息…），`saveIncomeTree` 改名時建別名、`resolveImportIncome` 匯入時套別名沿用新名，並連動 `learnedBank` type:'income' 規則——收入不再是「純手動、無別名」。手做的店名規則若因還原備份而消失＝白做，務必保留 |
| 集合新增欄位（表單加新欄） | **`lib/schema.js` 的 `WRITABLE_FIELDS` 白名單**（B2 起後端只收白名單內欄位，漏加會被默默剝掉——伺服器 console 會警告）；**若是數值/布林/枚舉/陣列欄位，同時補進 `FIELD_SCHEMA`**（否則型別驗證管不到、壞值仍可能污染計算）＋`lib/types.js` 對應 typedef。⚠️**服務層「擁有」的衍生欄位絕不放進 CRUD 白名單**（Codex r11 收斂完成）：transactions 的 `stmtRef`/`storeKey`/`source`/`importBatch`/`importedAt`（＋既有的 `autoCat`/`autoSub`/`stmtMonth`/`stmtDue`/`refundOf`）只由帳單匯入服務層寫——放行過的年代，PUT 挾帶假 `storeKey` 可劫持 `learnFromStmtEdit` 的學習鑰匙（毒化學習表）、手動記帳可偽裝 `source:'stmt'`（實測重現）。前例＝holdings.source（Codex#6-2）、accounts.ibCashCur（Codex#6-3）。這些欄位仍要有 `FIELD_SCHEMA` 型別（服務層寫入與匯入備份都靠它驗）；**備份還原不受白名單影響**（`/api/import` 走 `validateImportItem`、櫃檯走 `sanitizeDbForWrite`，都只驗型別、不剝白名單外欄位——有考題鎖住）。測試要種帳單假資料＝以服務層身分走 repo 直寫（`server.test.js` 的 `seedTx`），不可為了種資料把白名單加回去 |
| **IB 同步跨 await 的寫入安全**（Codex r3#1，高） | `syncIb` **等待網路請求之前只讀「發請求需要的設定」（`getSettings`），整包資料庫等回應之後才 `getDb()`**。原本一開頭就拿整包、請求結束把那份過期快照整包寫回——Flex Query 要跑數秒到數十秒，期間任何寫入都被靜默吃掉（Codex 實測：同步中寫入的當日日線，同步完成後整個消失；交易與月快照同理且**不會自癒**）。⚠️ 任何「讀整包 → await → 寫整包」的流程都有這個病，新增類似流程時一律「await 之後重讀再合併」（另兩個前例＝`normalizeIfRulesChanged` 的 `const fresh = getDb()`；`lib/services/market-data.js refreshQuotesIfStale` await 前只讀新鮮度＋要抓哪些代號、await 後才 `getDb()` 合併匯率/股價再寫，Codex r13#1——原本 await 前拿整包、報價回來把舊快照整包寫回，會吞掉抓報價期間的記帳/店名整理）。 |
| **銀行收支「真·學習」的方向與內轉子分類**（Codex r13#2/#4） | 不可竄改的 `dir`、方向護欄與來源優先序、內轉子分類用角色重播（不可字面比對）——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#銀行收支真學習的方向與內轉子分類) |
| **「同類/同店一起改」＝單一原子指令**（護欄 G3，2026-07-22） | 一次寫檔全有或全無；純函式 worker＋`PUT applyAll` 原子入口，標準端點只留相容薄殼——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#同類同店一起改是單一原子指令) |
| **停車費顯示包裝的觸發＝子類身分、非字面**（護欄 G4，2026-07-22；name/ID 分離） | 觸發＝停車費子類的**現名身分**、非字面；`parkSub` 整批算一次傳入；六個呼叫點；與 strip 反向對稱——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#停車費顯示包裝的觸發) |
| **帳戶顯示名 denormalized 到 `transactions.account`**（使用者定 2026-07-21「改一次、處處同步」） | 銀行交易靠 `bankRef` 遮罩帳號比對現名、手動記帳走舊名→新名；三處跑 reconcile——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#帳戶顯示名-denormalized-到交易) |
| **時鐘倒退保護**（Codex r3#8，中） | `lib/services/snapshot.js` 的 `clockWentBackwards`：現在的日期比「資料庫裡最新的一天」（`dailyValues` ∪ `snapshots`）還早 → **不寫**。因為「同日覆寫／同月覆蓋」會拿舊資料蓋掉更新的歷史，而歷史補不回來（電腦時間被手動改、時區設錯、VM 還原都會踩到）。分流：**自動流程（開 app）安靜略過**＋console 警告、回 `skipped`；**手動按鈕明確 throw 400 並說明**（使用者主動按的動作要看得見，他才有機會去修系統時間）。另：`nowLocal()` **整個流程只擷取一次時間**，避免跨午夜時「判斷該不該寫」與「實際寫哪一天」對不上。 |
| **淨值日線 `dailyValues`**（D0，每日洞察引擎的地基；使用者定 2026-07-19） | `lib/services/snapshot.js recordDailyValue()` 是**唯一寫入口**（開 app 的 `POST /api/snapshot/auto` 每次都呼叫）。與月快照的關鍵差別＝**同日覆寫、跨日累積**（月快照是同月覆蓋，手上永遠只有每月一個點，連「今天 vs 昨天」都算不出來）；**月快照跳過不代表日線跳過**——同日資產有變動時日線要跟得上，所以 `takeSnapshotIfDue` 先寫日線再判月快照。欄位＝`date`(YYYY-MM-DD 主鍵，**必填**)/`netWorth`/`assets`/`liabilities`/`pfCost`/`pfValue`/**`usdTwd`＋`gbpTwd`＋`jpyTwd`**（三種匯率都留底才分得出「淨值變動」是資產本身動了還是匯率動了——系統支援 USD/GBP/JPY 三種外幣，只留美元等於解讀不了另外兩種；Codex r3#10）。`date` 用新的 **`datereq`** 型別（`monthreq` 的日級雙胞胎：空值/壞格式都當壞資料拒絕）＋進 `REQUIRED_FIELDS`——壞 date 會讓差異引擎的排序與「找最接近的既有日」錯亂，比沒資料更糟。集合列在 `READONLY_COLLECTIONS`（前端唯讀、`GET /api/dailyValues` 自動生效，無 CRUD 寫入）。一天一行永久保留（一年 365 行，SQLite 無壓力）。改欄位時同步 `lib/types.js` 的 `DailyValue`＋`lib/store.js emptyDb()`＋`data/seed.json`＋`test/daily-values.test.js` |
| 估值訊號門檻／檔位（**程式單一真相＝`public/modules/signal-tiers.js`**，D3 抽出） | 單一真相 signal-tiers.js、前後端都 import；改門檻要同步白話文件＋SIGNALS_INFO_HTML——完整契約 → [契約：投資與 SEC](docs/contracts/投資與SEC.md#估值訊號門檻檔位) |
| **每日洞察引擎書籤 `insightState`＋差異引擎**（D3，2026-07-22） | 唯一寫入口 getInsights（讀取有寫檔副作用）／同顧慮同 key 鐵律／註冊五件套 `KV_KEYS`＋`KV_MAP_KEYS`＋schema＋`emptyDb`＋types——完整契約 → [契約：前端功能](docs/contracts/前端功能.md#每日洞察引擎書籤-insightstate) |
| `settings.signals`（美股自動、區域四市場每月手動） | 只在投組頁「更新區域數值」表單編輯；美股 ECY 自動算、不手動——完整契約 → [契約：投資與 SEC](docs/contracts/投資與SEC.md#settings-signals) |
| 支出分類（兩層：分類/子類，**使用者可自訂** 2026-07） | 生效樹＝`settings.expenseTree`＋`effectiveTree(db)`；改名連動與別名、刪除歸「其他/未分類」（強制保留的退路）——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#支出分類兩層與使用者自訂) |
| `lib/statement.js` `CATEGORY_RULES` 關鍵字順序 | 三層先中先贏：特殊指定→店家/關鍵字→**場所保底排表尾**（具體店家 > 場所）；重複判定鍵＝`stmtRef`——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#category_rules-關鍵字順序) |
| 帳單多銀行/多格式（`parseStatement` 依位元組偵測 PDF/XLSX；PDF 再依**文件內容**判富邦/台新） | 銀行由**文件內容**判斷不看選的卡；富邦/台新 PDF＋台新 XLSX（HOSTED 走子行程）；`finalize()` 共用；`statementMonth` 只掃表頭——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#帳單多銀行與多格式解析) |
| **顯示標記 `applyDisplayLabels(name, {desc, subcategory})`**（使用者定 2026-07-18） | 只加在顯示名（`note`）**絕不進 `storeKey`**；只加在「自動名」，使用者取過的名字逐字保留；三處呼叫端——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#顯示標記-applydisplaylabels) |
| **使用者自訂店名規則 `settings.storeRules`**（第三帖「規則自助化」，使用者定 2026-07-19） | 純資料非正規表示式（使用者只填純文字）；每種規則排在同類內建規則**前面**；寫入端嚴格、櫃檯端寬鬆——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#使用者自訂店名規則-storerules) |
| **「規則入櫃檯」**（第三帖）：`lib/repo.js` 每次讀取都把 `settings.storeRules` 餵給 `store-rules.js` 的模組級單例 | `repo.js` 每次讀取都經 `loadSynced()` 餵規則進純函式模組；預覽要講兩種不可逆變更；預覽失敗不可繼續儲存——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#規則入櫃檯) |
| 規則指紋 `settings.storeRulesHash`（開 app 自動整理的依據） | 內建規則雜湊＋使用者規則**每次重算**；`normalizeIfRulesChanged` 必須**先 `getDb()` 再算指紋**——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#規則指紋-storeruleshash) |
| 店名規則的 API 與 UI | 四個端點（讀／全庫影響預覽／存檔即套用／孤兒學習條目）＋設定頁編輯器；預覽返回不可用 innerHTML 還原——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#店名規則的-api-與-ui) |
| **不可逆整批操作前的真備份 `backupNow(tag)`**（Codex r3#7） | `lib/store.js` 的 `backupNow(tag)` → `data/store.db.<tag>.bak`（VACUUM INTO＋原子替換，經 repo 轉供）。**與啟動備份 `.bak` 是不同的檔**：啟動備份每個行程只寫一次（`backedUp` 旗標），對「一天內做了好幾次整批操作」毫無保護力——而 UI 原本就寫著「套用前自動備份」，是空頭支票。目前兩個呼叫點：`saveStoreRules`（`pre-rules`）與 `normalizeBranches` 實際套用時（`pre-normalize`）。每個 tag 一顆、重複執行覆蓋（檔案數有上限）。best-effort（同啟動備份的設計決策），失敗只警告不擋操作。`*.bak` 已被 .gitignore 全域排除。**新增其他不可逆的整批操作時，一併加一個 tag。** |
| 帳單上傳「免選卡」自動歸卡（`POST /api/statement/preview`） | 逐卡試密碼→判銀行末四碼→對卡決策樹三段；認不出一律退回請使用者選；pdfjs detach ArrayBuffer 的坑——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#帳單上傳免選卡自動歸卡) |
| 帳單匯入批次／事後整批改卡片 | `importBatch` 批次代號；整批改卡＝重寫 `stmtRef` 卡片前綴；**`stmtRef` 一律由伺服器端重算**（偽造會繞過去重）——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#帳單匯入批次與事後整批改卡片) |
| 帳單「自動學習」店名＋分類（`db.learnedCategories`＝{ `storeKey`(cleanStore後原名) → {category?,subcategory?,name?} }） | key＝`storeKey`（品牌層）；**分類記品牌層、顯示名記原文級**；品牌層永不留 `name`，且「不留」的手段是搬家不是刪除——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#帳單自動學習店名與分類) |
| **店家消費檔案**（收支列表點店名開彈窗；使用者定 2026-07-18） | 純前端 `openStoreProfile`；聚合口徑＝`storeKey`（品牌層合併）；三層內容；`fmtNT`「358 NT」僅此彈窗——完整契約 → [契約：收支記帳與匯入](docs/contracts/收支記帳與匯入.md#店家消費檔案) |

> **SEC 最新單季逐列期間**：各指標保留自己的最新合法單季；payload 用 `periods.latestQuarterBasis:'per-metric'` 明示，截止日不齊時發 `QUARTER_PERIOD_MISMATCH`，F5 每列直接顯示自己的完整期間。完整契約見 [投資與 SEC：最新單季逐列期間](docs/contracts/投資與SEC.md#最新單季逐列期間)。

## ⚠️ 欄位所有權（護欄 G5，2026-07-22；防「PUT 挾帶假值劫持服務資料」）

**原則**：每個欄位只有一個「擁有者」。**使用者可寫**的欄位進 `lib/schema.js` 的 `WRITABLE_FIELDS`（CRUD 表單改）；**服務層擁有**的衍生欄位**絕不進 `WRITABLE_FIELDS`**（前端表單從不送；放行過的年代 PUT 可挾帶假 `storeKey` 劫持學習鑰匙、假 `source:'ib'` 藏融資風險、假 `dir` 毀現金流方向）。三道寫入閘門：①`pickWritable`（CRUD PUT/POST，只收白名單）②`sanitizeDbForWrite`（櫃檯 `save`，驗 `FIELD_SCHEMA` 型別、**放行**白名單外的服務欄位）③`validateImportItem`（`/api/import` 還原，驗型別、不剝白名單外欄位）。**服務欄位仍要有 `FIELD_SCHEMA` 型別**——服務寫入與匯入還原都靠它擋壞值（數字型會讓 `.split`/`.slice`/聚合走樣）。

| 集合 | 使用者可寫（CRUD 白名單） | 服務層擁有（誰寫、不進白名單） | 唯讀/衍生 |
|---|---|---|---|
| `transactions` | date, type, category, subcategory, amount, account, note | **帳單匯入**（statement-import）：stmtRef, storeKey, source, importBatch, importedAt, autoCat, autoSub, stmtMonth, stmtDue, refundOf；**銀行匯入**（bank-import）：ledger, source, dir, autoNote, bankRef, bankKey；ledger 亦由遷移寫 | — |
| `accounts` | name, type, class, currency, balance, accountNo（PII，前端可填、GET 剝成末 4 碼） | **balanceAsOf**（銀行對帳單「較新才覆蓋」的餘額參考日——**服務層寫、非 CRUD 白名單**，Codex r14#5：勿誤列成使用者可寫）、ibCashCur（IB 同步） | — |
| `holdings` | symbol, name, layer, currency, quantity, price, avgCost, cost, quoteSymbol | source（IB 同步；`source:'ib'` 決定融資槓桿，假值會藏風險） | ⚠️`price` **多方合法寫**：使用者手動＋前端「更新報價」按鈕＋後端 D1 `refreshQuotesIfStale`（開 app 自動）——都合法，非違規 |
| `watchlist` | symbol, name, targetPrice, currency, quoteSymbol, note | — | ⚠️`lastPrice`/`lastAt`＝**報價衍生**，目前**前端「更新報價」按鈕**寫（PUT）故**仍在白名單**。低風險（觀察清單不進淨值）。**待辦**：D-engine market-data 服務化後，把持股/觀察清單報價更新全移到後端（比照 D1），`lastPrice`/`lastAt`（＋或 `holdings.price`）退出白名單＝純服務擁有 |
| `cards` | name, type, issuer, network, lastFour, level, memberId, statementDay, dueDay, annualFee, expiry, benefits, note, pdfPassword | — | pdfPassword＝PII（身分證字號；讀寫端 `projectCard` 剝，只卡片編輯窗需要） |
| `subscriptions` / `insurance` / `research` / `history` | 全部欄位（見 `WRITABLE_FIELDS`） | — | — |
| `settings` | 頂層／signals／ib 各有白名單（見同步點「settings 新增欄位」列） | quotesLastAt（報價更新）、storeRulesHash（規則整理）、healthDismissed（體檢略過）、ib.lastEquity/income/lastSync（IB 同步）、expenseTree/incomeTree/各別名/storeRules（分類・規則服務層）——皆**匯入備份要保留**（進 `sanitizeSettings`） | — |
| `securityTrades` | —（READONLY，前端只 GET） | **IB 同步雙寫**（ib-sync：upsert by sourceRef、**永不刪**；與 ibTrades 鏡像同次 saveDb＝原子；一致性＝「同步窗內 ⊆」非相等）＋**台新對帳單匯入**（securities-import：預覽 fail-closed→確認；台新批次可整批刪、IB 批次不可）。sourceRef＝identifier-first 去重鍵（IB：**帳戶指紋＋**transactionID→tradeID→ibExecID→指紋（Codex S2r1#4：IB 未承諾 ID 跨帳戶唯一）；台新：多維指紋**不含對帳單年月**）；IB 缺幣別/核心金額**不猜不入庫**（分原因跳過＋前端指路 Flex 欄位）；`projectSecurityTrade` 剝 sourceAccountId/sourceRef（export 除外）；**指紋類跨批身分＝內容比對＋計數對帳 `reconcileFingerprintRows`（批內序不可當跨批身分——視窗位移覆寫/補印漏記，S2 自審雙 HIGH）**，指紋列入庫不可變、官方列更新＝整列取代；帳戶只存**指紋+遮罩 label**、絕不落原文；金額原幣、netSettlement 絕對值+cashDirection。幣別牆比照持倉/現金（不支援幣別跳過+回報），**手續費幣別 commissionCurrency 也過牆**（Codex S3r2#1，高：漏驗會走到櫃檯枚舉 throw、炸掉整次原子同步——持股/現金全失敗）；核心金額 **price/grossAmount/netSettlement 必填**＋跨欄不變式 **buy→out／sell→in**（`ROW_RULES`：櫃檯 throw/strip＋匯入逐筆 400，Codex S3r2#4——單欄各自合法、合起來會把買進顯示成收錢）。`settings.taishinSecPdfPassword`＝證券 PDF 密碼（使用者 2026-07-23 拍板存本機；機密投影剝除+Set 布林、備份保留） | — |
| `portfolioSnapshots` / `ibTrades` / `dailyValues` / `snapshots` | —（`READONLY_COLLECTIONS`＋snapshots，前端只 GET） | portfolioSnapshots・ibTrades＝IB 同步；dailyValues＝`snapshot.js recordDailyValue`（D0）；snapshots＝`snapshot.js`（月快照） | 純服務寫、前端唯讀 |

**改欄位所有權時**：搬進/搬出白名單都要想「這個值可信嗎」——使用者能捏造的值不可決定財務判準（槓桿/方向/帳本/學習鑰匙）。新增服務欄位一律補 `FIELD_SCHEMA` 型別、**不要**加進 `WRITABLE_FIELDS`（測試種假資料走 repo 直寫＝`server.test.js seedTx`，不可為了種資料把白名單加回去）。

## 協作流程

- **Claude 與 Codex 都在本機工作**（Codex 為本機 CLI，非雲端）——改動只存在工作目錄，`git commit` 才進歷史、`git push` 才上 GitHub。
- **一個工作目錄只服務一個角色**（Codex 提議、使用者定 2026-07-19；2026-08-02 從「寫死三個目錄」改成「寫死角色與不變量」——實測當時共有 16 棵 worktree（Codex 的實作樹在 `/private/tmp/`、每支 PR 一棵審查樹），把數量寫死等於文件一開始就是錯的，同「不寫死頁數」的道理。下表是**三種角色各自的不變量**，目錄名與數量不再是規則的一部分。起因：審查當下 Claude 在同一個目錄裡 rebase／切分支十幾次，Codex 正在讀的樹在腳下移動，看到新舊混雜的程式碼）：

  | 目錄 | 角色 | 分支狀態 |
  |---|---|---|
  | `榮祥森（投資理財）` | **跑 app、放真實資料**（`data/store.db`）、使用者的桌面捷徑指向這裡 | 永遠 `main`、永遠乾淨，只接收合併結果 |
  | `榮祥森（投資理財）-claude` | Claude 實作 | 功能分支（`git checkout -B <branch> main`） |
  | `榮祥森（投資理財）-codex` | Codex 唯讀審查 | **detached** 於 `origin/main` |

  - ⚠️ **Codex 的 worktree 必須 detached**：Git 不允許同一個分支被兩個 worktree 同時 checkout，而主目錄佔著 `main`。更新方式＝`git fetch origin && git checkout --detach origin/main`（`git pull` 在 detached 狀態下沒有意義）。
  - ⚠️⚠️ **`node_modules` 的 symlink：只准建、不准動**（2026-08-02 事故）。做法是 `ln -s "<主目錄>/node_modules" "<worktree>/node_modules"`（純 JS 相依，不必各裝一份），但**在任何 worktree 裡刪除、重裝、或 `rm -rf` 那個 symlink 的內容，動到的是主目錄本身**——使用者的 app 會立刻起不來（`Cannot find package 'express'`），而錯誤訊息完全指不到真因。實際踩過：清理暫存 worktree 時刪除動作順著 symlink 進去，主目錄的 `node_modules` 被清空。**移除 worktree 前先 `rm <worktree>/node_modules`（不帶斜線＝只刪 symlink 本身）**；更安全的做法是——**唯讀分析根本不需要 node_modules，不要建那個 symlink**。三道關與 pre-push hook 都照常運作（`core.hooksPath` 是 repo 層設定，worktree 自動繼承）。
  - ⚠️⚠️ **`.gitignore` 必須寫 `node_modules`（不帶斜線）**——帶斜線的 `node_modules/` 只比對「目錄」，而 symlink 對 Git 來說**不是目錄**，會被 `git add -A` 當成一般檔案收進 commit（模式 `120000`），還把本機絕對路徑一起帶進版控。2026-07-19 實際踩到並修掉（symlink 一度進了 PR #136；CI 竟然還是綠的，所以**別指望三道關會攔這種東西**）。同理，日後在 worktree 裡建任何 symlink 都要先確認 `git check-ignore -v <path>` 擋得住。
  - ✅ **順帶補強鐵則 1**：`data/store.db`（真實餘額、IBKR flexToken、`pdfPassword`＝身分證字號）只存在主目錄，兩個 worktree 的 `data/` 只有 `seed.json`——「不要讀 store.db」從君子協定變成**結構上讀不到**。
  - 建立指令留檔：`git worktree add ../<repo>-claude -b wt-claude` ／ `git worktree add --detach ../<repo>-codex origin/main`；`git worktree list` 查看、`git worktree remove <path>` 移除。
- **換手儀式**：換另一個 AI 動工之前，先把目前的改動 commit（可由完工方自行 commit，或交 Claude 審查後 commit 並以 Co-Authored-By 標明出處）。分了 worktree 之後兩邊可以同時工作，但**同一個 worktree 仍然只有一個 agent 動**。
- `main` 永遠保持可用；**一任務＝一分支＝一 PR**，PR 描述寫清楚改了什麼/為什麼/怎麼驗證。
- **同時開多個 PR 時先講清楚相依性**（2026-07-19 踩到）：程式碼互不相依**不等於**可以任意順序合併——只要它們都改到 `AGENTS.md`（本檔是一張大表，人人都往裡面加字），合併第一個之後其餘全部會衝突。開 PR 時就要說明「合併第一個之後我要 rebase 其餘的」，別讓使用者以為隨便挑一個合併就好。
- ⚠️⚠️ **堆疊 PR 的合併程序（2026-07-28 真的踩到，兩支已核准的 PR 差點蒸發）**：合併順序**由下而上**，而且**每合併一支，就要把下一支的 base 改成 `main` 並 rebase**，然後才合下一支。
  - **踩到的實況**：`#309 C4b(base=main) → #311 C5(base=feat-c4b-postgres) → #312 C6前置(base=feat-c5-secrets)`。#309 先合進 main，接著在 GitHub 上連續按下 #311、#312 的合併鍵——它們各自合進了**自己的 base 分支**（中間分支），不是 main。結果：main 只拿到 C4b，C5 與 C6 前置的內容留在中間分支裡，而兩支 PR 都被關閉為 **MERGED、無法重開**。內容沒丟（在分支裡），但要另開一支 cherry-pick 才救得回來（#322）。
  - **為什麼特別陰**：GitHub 顯示「Merged」、CI 全綠、沒有任何錯誤訊息。**只有去查「那個檔案到底在不在 main」才發現**。所以合併完一整疊之後，務必抽查最上層 PR 的代表性新檔是否真的出現在 main。
  - 舊有的「不要用 `--delete-branch`」仍然成立（刪基底會讓上層 PR 被直接關閉），但那只是這件事的一半。
- **堆疊 PR（base 指向另一個 PR 分支）合併時，不要用 `--delete-branch`**——刪掉基底分支會讓上層 PR 被 GitHub 直接關閉而非自動轉指向（2026-07-10 實際發生，#3/#5 被誤關）。先由下而上全部合併完，再一次刪分支；或乾脆避免堆疊、等前一個合併後再開下一個。
  - ⚠️ **「這支是不是堆疊」不可憑印象判斷**：合併前必跑**堆疊閘 `node scripts/check-pr-merge-gate.js <N>`**（`CODEX-REVIEW.md` 合併六步驟的第 3 步；行為考題＝`test/merge-gate.test.js` 假 gh 五情境）。閘查**兩個方向**：①本支 base 必須是 `main`（防 2026-07-28「合進自己的 base」）②不得有 open PR 疊在本支上（防 2026-07-10「刪分支連帶關閉」）；gh 失敗或跨 fork＝fail-closed 當堆疊。**執行合併的人讀的是 `CODEX-REVIEW.md`，所以那份必須自帶這道閘**——本條只是規則來源。〔2026-07-30 修：CODEX-REVIEW 原本寫「一律 `--squash --delete-branch`」、完全沒提本例外，而它才是合併時真正被照著執行的檔案；r1 曾只查方向②、被 #346 示範放行，故改成雙向腳本。〕
- **Notion 白話規格**（使用者定 2026-07-20）：Notion 那區＝給使用者看的白話視圖（**本檔 AGENTS.md 仍是技術唯一真相**），**動架構時一併更新對應頁**。完整位置、回饋迴路、寫作風格、圖示規則、建頁工法見下方「**Notion 白話規格・更新工法**」小節——**Claude 與 Codex 都適用**（使用者 2026-07-22 起也會把 Notion 更新交給 Codex）。
- **合併的決策與執行是兩件事，分開講**（2026-07-30 對齊；此前「使用者是最終合併者」「使用者合併」「PR 由 William 合併」三句散在三份文件、字面上都已與實務不符——本條是唯一規則來源）：
  - **決策（要不要合、何時合）＝永遠 William**（角色表「合併裁決」）。任何人不得自行決定合併——「審查通過」只是門檻之一，不是合併指令。
  - **執行（按下合併鍵）核心原則＝「實作者不按自己的合併鍵」**（William 2026-07-30 定，對稱授權）：**由審查者執行**——Claude 實作、Codex 審過 → **Codex 執行**（2026-07-27 常設授權）；Codex 實作、Claude 審過 → **Claude 執行**（2026-07-30 對稱常設授權）。這是「不可自審」在執行面的延伸：合併程序裡「確認審查結論無阻擋」那一關由實作者自己判讀＝利益衝突最容易滲進來的地方。⚠️ 這裡刻意**不寫第幾關**——步驟編號會變（2026-08-02 新增協作欄位閘之後就整個往後推一格），寫死編號的敘述注定過期。
  - William 本人隨時可直接執行（GitHub「Squash and merge」）；個案明確指示（如「把 #338 合了」）可指定任何人執行該支。
  - **不論誰執行，一律走 `CODEX-REVIEW.md` 的「合併六步驟」**——⚠️ **本檔刻意不重述那幾步**（Codex #379 r1 High②：重述的摘要會落後，讀者照本檔執行就剛好跳過新加的關卡；這正是本節在修的那個病）。只記住它有**三道不可跳過的守門**：`scripts/check-pr-collab-fields.js`（協作欄位）、`scripts/check-pr-merge-gate.js`（堆疊）、以及合併訊息的 `Reviewed-By:` ／ `Merged-By:` trailer。任一關卡不成立＝停下來回報 William，不得便宜行事。考題 `test/collab-invariant-docs.test.js` 盯著這三個名字都還在本段裡。
- Commit 訊息用繁體中文、講清楚動機。
- 驗證要求：改前端 → **全部頁面** reload 無 console error（清單＝`app.js` 的 `ROUTES`，**不寫死頁數**——曾同檔並存 8 頁與 10 頁兩個數字、新頁面永遠追不上）；改後端 → `node --check server.js` ＋ 以 seed 資料跑 `buildSummary()` 不拋錯；UI 變動附驗證說明。**另有兩道自動關卡：`npm run typecheck`（型別校對）＋`npm test`（自動考試，`node --test`、零相依，測 `lib/derive.js`＋`lib/statement.js` 的分類/店名清理/淨資產/訂閱口徑/槓桿等）——改動後都要保持乾淨/全過；改到分類規則、店名清理、金額口徑時，順手在 `test/` 補一條考題鎖住。****資料存取單一櫃檯（B1）**：讀寫資料一律走 `lib/repo.js`（getDb/saveDb/getCollection/addItem/updateItem/deleteItem/getSettings/updateSettings；uid/emptyDb 也由它轉供）——**除了 repo.js 自己，任何檔案都不要直接 import `lib/store.js`**。附帶效果要與更新同一次寫檔時用 `updateItem` 的 `beforeSave`（例：帳單交易改分類→寫學習表）。未來換資料庫（B3 SQLite）只改 repo.js。**驗證入櫃檯（B3）**：`store.save()` 是唯一寫入口、每次寫入自動過 `schema.js sanitizeDbForWrite`——枚舉/布林非法值會直接 throw（＝寫入端程式有 bug，考試會抓到），任何新寫入路徑**結構上不可能**繞過驗證牆（七輪審查的病根根治）。新增欄位照舊補 `WRITABLE_FIELDS`/`FIELD_SCHEMA`。**日期／月份走「真實日曆」判準（`isRealMonth`／`isRealDate`，Codex r3#9）**：`date`/`datereq`/`month`/`monthreq` 四種型別**共用同一套**，不可各寫一份。以前只驗長相（`\d{4}-\d{2}`），`2026-13`／`2026-99-99`／`2026-02-31` 全都過得了關——後果不是崩潰而是**默默算錯**（月份排序把 `2026-13` 排到 `2026-02` 後面、提醒天數、費用攤提、日線的「找最接近的既有日」全偏掉，畫面上卻一切正常）。閏年用 `Date.UTC` 建構回比對（避開本地時區在月初月底的位移）。服務層的手動輸入（`setBatchMonth`、`importRows` 的 `statementMonth`）也一律改用同一個判準。⚠️ 這是**收緊**：萬一舊資料裡真的躺著一個假日期，下次寫入會在櫃檯 throw（訊息已指出集合/索引/值）——那是刻意的，發現了就把那筆改掉，不要為了它把驗證放寬回去。 **必填欄位機制（`REQUIRED_FIELDS`，目前＝history/portfolioSnapshots/snapshots 的 `month` 主鍵欄＋`dailyValues` 的 `date`＋`securityTrades` 的查帳合約 11 欄——身分/方向/數量/幣別/去重鍵＋三個核心金額 price/grossAmount/netSettlement，Codex S2r1#5＋S3r2#4）**；跨欄位不變式走 **`ROW_RULES`**（同三個強制點；目前＝securityTrades 的 buy→out／sell→in）：三個強制點——CRUD 新增回乾淨 400、匯入逐筆列 errors→整份 400、櫃檯 throw 模式當場 throw。**strip 模式（舊 JSON 搬家專用）對必填欄位「缺席／空值／格式錯／數字型」一律整筆濾除，不可只刪欄位**（只刪欄位會留下缺主鍵的殘骸，讓讀取端 `.slice`/`.split` 崩，Codex#12）；PUT 部分更新天然安全（合併保留舊值）。新增「不可缺的主鍵欄」時補進 `REQUIRED_FIELDS`。**測試隔離慣例（B0）**：`lib/store.js` 的資料檔路徑可用 `STORE_FILE` 環境變數覆寫（測試一律指到 os 暫存目錄的 `.db` 檔、絕不碰真實 `data/`）；`server.js` `export const app`、只有直接執行才 `listen`（測試 import app 後在隨機埠自行監聽）——`test/server.test.js` 是階段 B 改建的行為安全網，改後端端點要保持它全過。第三道＝`npm run lint`（ESLint 格式糾察：未用變數/危險寫法；設定在 `eslint.config.js`，已依本專案慣例調整——catch 未用 e、空 catch、模板內全形空白皆放行；「刻意停放」的函式用 `eslint-disable-next-line no-unused-vars` 註記原因，勿當死碼刪）。
- **測試覆蓋率是診斷、不是第四道關卡（2026-07-22）**：`npm run test:coverage` 使用 Node 內建 coverage、不另裝套件；它只統計測試曾載入的檔案，不能把全庫百分比當成整個 App 的真實覆蓋率，也不設硬門檻。優先補金額、日期、幣別、方向、搬家、原子寫入與機密投影的高價值考題；完整讀法與風險地圖見 `docs/測試覆蓋率地圖.md`。
- **JSON 請求大小分流（2026-07-22）**：單一真相在 `lib/http-body.js`，一般 API＝1 MB、信用卡／銀行帳單六個吃檔案的大型 POST（另有一個只吃列的端點，僅 HOSTED 收到 1MB）＝15 MB、完整備份還原 `/api/import`＝50 MB。**安裝順序是安全不變量**：大型端點的 route-specific parser 必須先掛，最後才掛一般 parser；倒過來會讓大件入口先被 1 MB 擋掉。新增會接收大型內容的端點時，要加入集中清單並補 `test/request-limits.test.js`；尤其 `/api/import` 是資料救援入口，絕不可繼承一般 1 MB 上限。
- **自動守門（兩道，2026-07-13 起）**：①**本機門**＝versioned pre-push hook（`scripts/git-hooks/pre-push`，啟用：`git config core.hooksPath scripts/git-hooks`，本 clone 已設好）——push 前自動跑 typecheck＋lint＋test，不過就擋下（緊急跳過 `--no-verify`，不建議）；②**雲端門**＝GitHub Actions（`.github/workflows/ci.yml`）——每個 PR 自動跑同三關並在 PR 頁顯示 ✅/❌，**執行合併的人（不論哪條路徑）合併前先確認綠勾**。新 clone 記得重新 `git config core.hooksPath scripts/git-hooks`。⚠️ **手動跑三關時直接看 npm 的 exit code**——`npm run lint 2>&1 | tail -1; echo $?` 回的是 tail 的退出碼，曾因此漏掉 4 條 lint 錯誤、靠 pre-push 才攔下（zsh 管線要查 `pipestatus`）。

### 三方協作框架（William 2026-07-24 裁決定稿；Codex 起草＋Claude 三處修訂＝流程分級適用／預約表內容校正／低風險仍過三關。本節已**整併**同日稍早的裁決補則，為唯一版本）

**成功優先序**（所有取捨依此排序）：①降低改壞既有功能的機率 ②讓 Claude、Codex 容易理解與交接 ③加快未來開發 ④強化資料救援。

**Codex 審查的觸發方式（William 2026-07-27 常設授權）**：每批 PR 合併進 `main` 後，**Claude 直接用本機 `codex` CLI 自動跑一次審查**（完整指令、沙箱參數、副作用檢查與回報規則見 `CODEX-REVIEW.md` 開頭）。要點：只在 `-codex` 獨立 worktree 跑（碰不到主資料夾與 `data/store.db`）、沙箱要開網路否則端點測試跑不了、跑完收掉 Codex 自建的臨時 worktree、**Codex 的回覆原文貼給 William 並附 Claude 的逐條核對**、修不修仍由 William 決定。授權範圍僅限「跑審查」，不含依審查結果自動動工。**追加（2026-07-27）：合併也由 Codex 代 William 執行**——**程序一律照 `CODEX-REVIEW.md` 的合併六步驟**。⚠️ **本檔不重述那幾步**（Codex #379 r1 High②／r2 High②：這裡原本留著一份舊摘要，少了協作欄位閘與 trailer——照它執行就剛好跳過新加的關卡。同一種漂移前後抓到五處）。**但三道不可跳過的守門要在這裡點名得出來**（`test/merge-procedure-docs.test.js` 與 `test/collab-invariant-docs.test.js` 各自盯著）：`scripts/check-pr-collab-fields.js`（協作欄位）、`scripts/check-pr-merge-gate.js`（堆疊）、合併訊息的 `Reviewed-By:` ／ `Merged-By:` trailer。**摘要會落後，名字不會**——這就是「指標＋守門名字」與「重述步驟」的差別。任一關卡不成立就停下來回報、不得合併，且 Codex 合併前不可自行改碼。

**角色分工（含「不負責」邊界）**：

| 角色 | 主要責任 | 不負責 |
|---|---|---|
| William | 產品決定、需求優先序、畫面驗收、合併裁決 | 不需判斷程式實作細節 |
| Claude | 主要實作、考題、PR、自審、技術文件更新；**複審 Codex 實作的 PR 並代執行合併**（2026-07-30 對稱常設授權） | 不自行推翻已拍板的產品規則；**不複審、不放行自己實作的支** |
| Codex | 獨立複審、對抗測試、同步點檢查、風險分析；William 明確指派時實作（模式③） | **三模式邊界（見下）以外的一切**——尤其不得把審查／代合併權限自行膨脹成實作權限；**不複審、不放行自己實作的支** |
| CI | 型別、格式、考題的自動守門 | 不判斷產品是否好用、金額口徑是否符合使用者的意思 |

**Codex 的三模式邊界**（2026-07-30 定；此前角色表寫「**原則上**不修改」＝弱版、審查分工節寫「不改檔、不 commit」＝絕對版，兩種強度並存——而 Codex 手上已有代合併授權，「一邊擴權一邊留著模糊邊界」是這批文件對齊裡最危險的一處。三模式方案由 Codex 自己在重整案第三輪提出）：

| 模式 | 能做什麼 | 不能做什麼 | 誰啟動 |
|---|---|---|---|
| **①常態審查**（預設） | 讀、跑三關、提意見（附重現與 `檔案:行`） | **絕對唯讀：不改檔、不 commit、不 push**；不在 `-codex` 樹 checkout 別人的分支 | 常設（每批合併後）或 William 隨時 |
| **②代合併** | 照 `CODEX-REVIEW.md` 的**合併六步驟**執行「**Claude 實作、你審過**」的合併（授權範圍就這麼窄——其他實作者的支不在內） | **不含修碼**——發現問題回報 Claude 修，不得順手改；不合自己實作的支（見「實作者不按自己的合併鍵」） | 常設授權（2026-07-27） |
| **③實作** | 在**另開的可寫 worktree** 走分支與 PR（三條件：獨立施工計畫／不碰他人預約檔案／Claude 的複審需求優先於實作） | 不得在 `-codex` 審查樹 commit；高風險 PR 未經 Claude 複審不得合併 | **僅 William 明確指派**——空檔≠自動啟動 |

**⚠️ 協作的唯一不變量（William 2026-07-29 定；原本只寫在 `CODEX-REVIEW.md`，2026-08-02 搬進本檔）**：

> **沒有任何一份產出，由寫它的人做「正式複審與放行」。**

⚠️ **這不是禁止自審**（免與「轉 ready 前對抗式自審」互相否定）：**作者自查仍然必須做**
（自己先假設哪裡會壞、跑突變、過三關）——那是交件品質；**正式複審與「可以合併」的判定，作者不得擔任**。
兩件事分開，循環才成立。

⚠️ **為什麼要搬過來**：它原本只寫在 `CODEX-REVIEW.md`，而 `CLAUDE.md` 叫 Claude「先讀 AGENTS.md」——
**規則在一份檔案、執行在另一份檔案 ⇒ 規則等於不存在**。這個病 `test/merge-procedure-docs.test.js`
的檔頭已經診斷過一次（刪分支規則失效十九天、兩次事故），不要換一條規則重演。
考題 `test/collab-invariant-docs.test.js` 盯著這段還在、且 `CODEX-REVIEW.md` 對它的指標沒死掉。

⚠️ **兩個名字很像的東西，不要搞混**（2026-08-02 實測就是這樣漂移的）：**五步驟審查循環**＝下面這張表，講「誰找問題、誰提修法、誰審實作」；**合併六步驟**＝`CODEX-REVIEW.md` 的按合併鍵程序（協作欄位閘 → 審查結論與 CI → 堆疊閘 → 合併＋trailer → 確認刪分支 → 回報）。

**五步驟審查循環**（展開版與操作細節見 `CODEX-REVIEW.md`）：

| 步驟 | 誰 | 說明 |
|---|---|---|
| ① 找問題 | **A** | 誰先發現都可以 |
| ② 提修法 | **B** | 另一方。**先寫修法提案，不要先寫程式** |
| ③ 審修法 | **A** | ＝發現者，**不是**提案者 |
| ④ 實作 | 預設 **Claude**；Codex 只在 William 明確指派時（模式③） | 審查者不可改自己要審的碼 |
| ⑤ 審實作 | **實作者以外的那一方**（預設 Codex；**Codex 實作時＝Claude**） | ＝下一輪的 ①，循環因此閉合。⚠️ 寫死「Codex」會在模式③下變成 Codex 審自己的產出＝違反上面的不變量 |

**三個合法方向**（差別只在誰先發現）：

| 誰先發現 | 流程 | 誰按合併鍵 |
|---|---|---|
| Codex | Codex 找 → Claude 提 → **Codex** 審提案 → Claude 實作 → **Codex** 審實作 | Codex（模式②） |
| Claude | Claude 找 → Codex 提 → **Claude** 審提案 → Claude 實作 → **Codex** 審實作 | Codex（模式②） |
| William 指派 Codex 實作（模式③） | Codex 實作 → **Claude 複審** | **Claude** |

模式間**不會自動升級**：審查中發現「順手就能修」的問題＝回報，不是修。〔前例＝Codex 曾把 `-codex` worktree checkout 到 `main` 佔住分支、主目錄一度切不回——越界通常不是惡意，是「順手」，所以邊界要寫成表。〕

**PR 分級（風險決定流程重量）**：
- **高風險**＝金額公式、資料庫、搬家、匯入、機密、全站共用底層：必須小步拆分、合成資料驗證、有回復方案，且**由 Codex 複審後才合併**。
- **中風險**＝共用 UI、跨頁元件、工作流程：三關＋桌面與手機測試＋主要操作流程＋**截圖確認無重疊、溢出或文字截斷**（免施工計畫）。
- **低風險**＝文案、局部樣式、文件：可較快合併、不套高風險流程——但**三關仍全數適用**（pre-push 與 CI 本來就自動擋；低風險＝流程輕，不是裸奔）。
- **標準全流程**（需求→整理→William 裁決→施工計畫定稿→標記共享檔→小型 PR→三關＋對抗式自審→Codex 獨立複審→修正→收官確認→William 實測驗收→Squash merge→文件收官）**只適用高風險與新功能**；中風險免施工計畫；低風險＝分支→三關→合併。

**PR 單一目的（搬家與修正分離）**：每支 PR 只能有一個主要目的——**搬程式**＝行為完全不變（機械 diff／對照考題證明）；**修 bug**＝清楚列出舊結果、新結果與受影響情境＋回歸考題；**加功能**＝列出新接口與驗收方式；**改畫面**＝不順手改公式。搬家途中發現既有 bug **不得順手修**：先記錄（考題釘住現狀），搬完另開修正 PR——「搬家後數字變了」會讓人無法判斷是刻意修正還是意外破壞。

**模組之間先約契約再動工**（不要靠「我猜對方怎麼寫」）：輸入是什麼／輸出是什麼／哪些欄位必填／錯誤如何回報／空資料怎麼處理／日期與幣別口徑／誰擁有這份資料。**契約一旦改變，當支 PR 必須同步五項**：型別（types.js）、schema、API 考題、前端使用端、本檔同步點清單。

**每一步如何復原（高風險安全帶）**：

| 改動 | 復原／保護方式 |
|---|---|
| 純程式修改 | 回復該支 squash commit |
| 金額公式 | 新舊雙算，或同組案例對照（前例＝test/subscriptions-model.test.js 前後端對照考題） |
| 資料庫／資料格式搬家 | 搬家前備份＋可重跑＋失敗不覆蓋 |
| 匯入流程 | 預覽→確認→原子寫入 |
| 共用元件 | 先遷移 1–2 個試點，再擴大（前例＝U3 彈窗外殼） |
| 大型新功能 | 功能開關或暫不接入主導航 |
| 真實資料異常 | 保留原始證據，不自動修掉來源資料 |

兩個固定關卡：**合併前一句話檢查**——PR 說明要回答「這支若完全失敗，最糟會失去什麼？」；**合併後五分鐘檢查**——William 重啟 App、以實際操作完成最核心的一條流程（＝每支 PR 附的「驗收法」）。

**共享檔案預約（2026-07-31 起＝Draft PR，人工預約表退役）**：**開工第一步＝先開 Draft PR**（哪怕只有一個開工 commit），**且 PR 說明開工時就要列出「預計修改的共享檔案／區域」**（還沒 commit 到的也要列——open PR 的 files 只看得到已改的，宣告才蓋得住整個工作範圍）——「誰在做什麼」的唯一即時來源就是 GitHub 的 open PR 清單（`gh pr list`＋各 PR 說明），不再人工維護第二張表（人工表實證會過期：曾經同時開著五支 PR、表上只寫一支）。**工作中途要碰開工時沒宣告的共享檔案＝先更新自己 PR 的說明、並重查其他 open PR 的宣告**；撞到別人已宣告的範圍就停下協調（插隊條件除外），不可先改再說。規則不變：同一檔案同一時間只有一位持有人（＝該 PR 的實作者）；其他人可讀可審、不直接修改；發現會造成**金額算錯／資料遺失／機密外洩／頁面或核心路由崩潰**的問題可立即插隊——插隊問題由**持有人**修，發現者提供重現條件並複審。

**規則衝突**：本檔（AGENTS.md）是最高技術準則。**發現程式碼與本檔不一致時，不可直接選一邊修改**——先查：①Git 紀錄 ②施工計畫 ③固定輸入輸出考題 ④使用者先前裁決；仍無法確認才交 William 裁決。

**共用彈窗契約**（modal-shell.js 的邊界）：只共用**尺寸、標題列、關閉按鈕、背景與基本關閉行為**；送出、預覽、返回、非同步狀態與重畫流程**由各功能自行負責**。

**文件分工**：

| 文件 | 用途 | 更新時機 |
|---|---|---|
| AGENTS.md（本檔） | 技術鐵則、公式口徑、同步點 | 技術契約改變的**當支 PR** |
| PROJECT.md | 做到哪、下一步、待裁決事項（**「誰在做」＝看 open PR 清單，不在本檔**） | 每**階段收官** |
| 施工計畫 | 這個功能準備怎麼做 | **開工前定稿**（只有高風險與新功能需要） |
| Notion | 給 William 的白話原理與開發紀錄 | **複審收官後** |
| PR 說明 | **五個必填欄位**：①實作者 ②獨立審查者 ③基準版本（審查要釘的 commit）④預計修改的共享檔案（＝預約）⑤這支若完全失敗最糟失去什麼；再加「實際改了什麼＋驗收法」 | 每支 PR。⚠️ **模板在 `.github/pull_request_template.md`、由 `scripts/check-pr-collab-fields.js` 機械把關**——2026-08-02 實測連續三支（#374/#375/#376）漏填，證明只靠記憶維持不住 |

不要求每支搬家 PR 同時修改多套文件。

**一句話總綱**：Claude 負責建造，Codex 負責挑戰，William 負責決定與驗收；共享檔案一次只交給一人。高風險工作小步前進，每一步有考題、有證據、有退路。文件說明規則，契約連接模組，PR 隔離變更。

### Notion 白話規格・更新工法（Claude 或 Codex 動架構時一起更新）

使用者 2026-07-20 定；**2026-07-22 起 Notion 更新也交給 Codex**，故把細節從 Claude 的 memory 搬進本檔（Codex 看不到 memory）。

- **位置＋現況**：Notion「不簡單 › 榮祥森（理財中心）› **動態藍圖區（架構・規則・原理）**」＝給使用者看的白話視圖（本檔仍是技術唯一真相）。目前＝**9 頁子系統**（1 消費說明→鑰匙→顯示／2 帳單匯入／3 分類與自動學習／4 資產・投資・IB／5 訂閱・提醒／6 資料安全／7 前端架構／8 協作機制／**9 每日洞察引擎**）＋一頁跨切面「**防撞護欄設計原理（G3–G5）**」。**動到某子系統的架構＝一併更新對應那頁**（一致性由動工方顧）。容器頁 id `3a39485922f58100aaedead0094987e0`；workspace＝teacherjung's Notion。
- **回饋迴路**：Notion 上的設計由使用者決定。①**措辭／版面／比喻／圖示**＝使用者全權、直接改、不通知：**更新頁面前先 `fetch` 現況、只做最小 search-replace、絕不覆蓋使用者的編輯**；②**規則／數字／設計描述**＝使用者在該段留 comment 寫明「理由：…」→ 讀後動工（改程式＋更新本檔＋補考題，PR 照舊）或先在同串 comment 確認。**每次開工先 `get-comments`（`page_id`＋`include_all_blocks:true`）掃一輪留言**；自己的留言一律加作者前綴——**Claude 用「【Claude】」、Codex 用「【Codex】」**（Notion MCP 以使用者帳號發言，不加前綴會被當成使用者自己說的）。
- **寫作風格**：白話＋表格＋標題為主體，生活比喻開場（收發室／稽核抽查／配電箱…）；**避免「程式碼」這類詞，說「文件夾」**；金額口徑照該子系統（訂閱用「元」、其餘「萬」）。callout 只用少數重點框、`color="gray_background"`，開場用 `book_gray`、設計哲學／心法用 `light-bulb_gray`。**⚠️ 圖示一律 Notion 內建灰色 icon、絕不用 emoji**：頁面 icon＝create/update 傳 `icons/<name>_gray`；callout＝`<callout icon="/icons/<name>_gray.svg">`。實測可用：book／light-bulb／checkmark／tag／wrench／document／chart／bell／lock／code／people／circle／circle-dot。目錄狀態欄用文字（「已完成」）不用 emoji。
- **建頁／改頁工法（實測教訓）**：①`create-pages`／`update-page` 後**務必 fetch 回來逐頁校對**（會滑出錯字型字碼，攤→攞之類）；②`.md` 檔名用反引號包（否則被自動轉成 `http://AGENTS.md` 假連結）；③多頁批次照目錄順序建，底部子頁連結順序才對。
- **維護承諾（頁內已建機制）**：「防撞護欄設計原理」頁文末有「**更新紀錄**」表——那三道原理（G3 原子化／G4 身分判準／G5 欄位所有權）日後有變，回該表**補一列日期＋改內文**；子系統頁（含每日洞察引擎）就地更新。

### 審查分工的沿革（2026-07-10 版已被取代）

> 2026-07-10 拍板的「Codex 審、Claude 改」已由**三方協作框架 v4**（本檔上方）與
> **五步驟審查循環＋唯一不變量**（同上）取代。舊版有三處與現況相反，故整段移除，
> 避免它擺在最像結論的位置被誤讀：①舊版要求由**使用者轉交審查原文**給 Claude——
> 2026-07-27 起改為 Claude 自己跑 `codex exec`（常設授權，#294）；②舊版要求對 `main`
> 審穩定狀態、不審改到一半的分支——現況是**逐支 PR 合併前**審 r1..rN；③舊版寫 Codex
> 只提意見、不改檔——2026-07-30 三模式邊界已允許模式③實作。沿革見 `docs/archive/`。

**唯一從舊版保留下來的規則**（它與現況不衝突，且仍然重要）：

⚠️ **凡與「刻意設計」衝突的審查建議，要擋下並說明為什麼不做**——不是照單全收。
最典型的例子：`COMPOSITION` 前後端兩份表看起來是重複，實際上是**刻意的同步點**
（見同步點清單），把它「去重」會讓前端與後端的穿透結果走散。
審查者提出的每一條，都要先拿本檔的投資語意與同步點清單把關再動手。

## 已知待辦（背景脈絡）

- ✅ 估值訊號儀表（五市場檔位 → 動態股債比）已實作（PR #7）。
- ✅ XIRR 資金加權年化報酬已實作（PR #9，投組頁「投入 vs 市值」卡）。
- ⏳ 個股基本面分析方法待建立（AAPL/GOOGL 等）——下一項，先設計「研究一檔個股要回答哪些問題、看哪些指標」的框架，再決定 app 內怎麼承接（已有個股研究卡的論點/風險/檢查點欄位可用）。
