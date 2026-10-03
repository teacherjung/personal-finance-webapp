# 專案概觀與資料架構

由共同入口 [AGENTS.md](../AGENTS.md) 路由至本檔；本檔為下列內容的正本。

## 專案概觀

本機優先（隱私第一）的個人理財網頁。**runtime 零建置**：改完存檔即生效，前端沒有 bundler/transpiler、不引入前端 npm 相依。**開發工具（devDependencies）為刻意引入**：typescript/@types（校對）、eslint（糾察）——只在開發/CI 使用、不影響 app 執行；新增 runtime 相依採「謹慎地裝」原則（要有明確理由，2026-07-13 使用者拍板放寬）。

- **Notion 白話規格**（使用者定 2026-07-20）：Notion 那區＝給使用者看的白話視圖（**技術正本依 AGENTS.md 路由表查閱**），**動架構時一併更新對應頁**。完整位置、回饋迴路、寫作風格、圖示規則、建頁工法見 `docs/notion-spec-playbook.md`（2026-08-04 自 AGENTS.md 逐字搬出；純操作手冊、動 Notion 才需要）——**Claude 與 Codex 都適用**（使用者 2026-07-22 起也會把 Notion 更新交給 Codex）。

## 發展方向與階段路線圖（2026-07-13 使用者拍板）

**終點＝多人註冊使用的服務**（幫他人保管理財資料＝重大安全責任，安全永遠第一優先）。分三階段、每階段讓下一階段變安全：

- **階段 A 安全網（✅ 完工）**：自動考試／型別校對／pre-push＋CI 守門／格式糾察（`npm test`・`typecheck`・`lint`）。
- **階段 B 骨架改建（✅ 完工）**：資料存取收斂單一櫃檯、routes/services 分層、SQLite 落地（現況見下方「後端」段）；app 外觀與操作不變。
- **階段 C 多人上線（進行中，C1–C5 ✅；C6 首次部署及對抗驗收完成）**：雙模式開關（LOCAL／HOSTED）、帳號系統與 auth gate、租戶隔離（RLS＋CAS）、機密 envelope 加密與雲端匯出剝機密、速率限制與資源上限**都已上線**（細節見同步點清單）；**尚未完成＝後續項（per-user 配額、Cloudflare、Render Starter、上線監控）與 C7**（真實資料上線＋DNS）。分階段裁決、威脅模型與各項現況見 `docs/multi-user-launch-plan.md`（狀態與後續項清單以它為準）。

審查與建議請以此方向為前提（正確性 bug 照抓）。

**成功優先序**（所有取捨依此排序）：①降低改壞既有功能的機率 ②讓 Claude、Codex 容易理解與交接 ③加快未來開發 ④強化資料救援。

- 後端（B2 已分層）：`server.js`＝薄殼（啟動＋掛路由；LOCAL 只聽 `127.0.0.1`、HOSTED 聽 `0.0.0.0`，埠 `PORT` 或 4321）→ `lib/routes/*.js`（HTTP 路由：core/crud/market/ib/statement）→ `lib/services/*.js`（業務邏輯：learning/snapshot/ib-sync/statement-import）→ `lib/repo.js`（資料存取單一櫃檯；**C4a 起全介面 async**，見鐵則 8）→ **兩顆引擎（C4b）**：LOCAL＝`lib/store.js`（**SQLite `data/store.db`**，Node 內建 node:sqlite、WAL＋交易；舊 `store.json` 首次啟動自動搬家、原檔保留當備份）／HOSTED＝`lib/store-pg.js`（**Supabase Postgres**，`kv(user_id,key,data,version)`＋RLS＋compare-and-swap；結構在 `db/supabase-schema.sql`）。分流判準只有 `isHosted()`，**路由與 services 一行都不必知道差別**。欄位白名單在 `lib/schema.js`
- 資料：LOCAL＝`data/store.db`（SQLite，**已被 .gitignore 排除**；首次啟動從 `data/seed.json` 複製、舊 `store.json` 自動搬家）／HOSTED＝Supabase `kv`（新租戶從 `emptyDb()` 乾淨底稿起家、**不種 seed**、無本機備份與搬家）
- 計算大腦：`lib/derive.js`（淨資產/現金流/提醒/投資原則檢查）
- IBKR 串接：`lib/ib.js`（Flex Query 唯讀）
- 前端：`public/` 原生 JS SPA——`app.js`（共用工具+路由）、`modules/*.js`（頁面模組）、`modules/theme.js`（圖表色）、Chart.js（本機 vendor）。投資頁模組的分工、工作流、停止線與格式單一真相＝`docs/sync-index.md` 同步點清單「投資頁前端模組分工」列（完整契約）。

啟動：需要 Node.js ≥22.13.0（內建 SQLite 從此版起不再需要 experimental flag）；`npm start` → http://localhost:4321。給使用者雙擊的 `start.command` 會先檢查 Node/npm、版本與首次相依安裝，失敗時保留白話訊息。注意：使用者常自己開著一個伺服器佔 4321，`.claude/launch.json` 已設 `autoPort`。

**型別檢查（可選、仍零建置）**：用 `jsconfig.json`（`checkJs:false`＝逐檔 opt-in）＋在檔案頂端加 `// @ts-check`＋JSDoc 型別。`npm run typecheck`＝本地 `tsc`（devDependencies：`typescript`＋`@types/node`＋`@types/express`，定位見「專案概觀」；第一次要 `npm install`）。共用資料形狀集中在 `lib/types.js`（純型別、`export {}`，用 `/** @typedef {import('./types.js').Db} Db */` 引入）。**不 build、不改副檔名、不影響 runtime**——編輯器(VS Code) 與 `npm run typecheck`（npx 跑 tsc、不加相依）會抓「欄位打錯／型別不符／忘了處理 undefined」這類 `node --check` 抓不到的錯。**已導入全部前後端檔案**（lib/、routes/、services/、public/ 全數 `// @ts-check`；改動請保持 `npm run typecheck` 乾淨；型別集中在 `lib/types.js`）；pdfjs/xlsx 型別自動解析（`getTextContent` items 是 `TextItem|TextMarkedContent` 聯集，用 `'str' in it` 收斂）。**`store.js load()` 已標 `@returns {Db}`，`db.x` 全程型別化**（`Db`/`Settings`/`Card`/`Account`/`Holding`/`IbSettings`… 都在 `lib/types.js`；`settings` 與 `settings.ib` 視為一律存在）。**改 store 結構（emptyDb 加欄位）＝同步更新 `lib/types.js` 的對應 typedef**（否則 server.js 讀該欄會報「不存在」）。這不是改用 React/Vite——只是零成本拿到 TS 的抓錯。 **目前 jsconfig include 到的 .js（lib／public／scripts／test-doubles／prototype 遞迴＋server.js）全數有 TypeScript 認得的 `// @ts-check`（2026-09-05 起；後兩個目錄 2026-09-11 納入——都只收 `.js`；原型目錄另有自己一份更嚴的設定、由它自己的考題跑，`server.mjs` 只歸那份管），考題 `test/ts-check-coverage.test.js` **問 TypeScript 對 jsconfig 算出來的檔案集合**（不自己展開 include——Grok #598 掃：自己展開會被「另加 exclude」「遞迴換成單一檔」假綠）、用 TypeScript 自己的判定釘住（註解裡提到那串字不算）：進了 git index 的新檔忘了加＝紅（⚠️ 還沒 `git add` 的看不到——#600 為了躲別的考題跑到一半寫進 lib/ 的暫存探針，集合改成「TypeScript 算出來的 ∩ git 追蹤中的」）、集合被靜靜縮小＝紅。** ⚠️ **`test/` 刻意不在 include 裡**（William 2026-09-11 裁「甲」＝先不納入）：考題檔檔頭寫的 `// @ts-check`（2026-09-11 量：81 支）**只有編輯器在看**——`npm run typecheck` 一支都沒開過它們（`--listFiles` 實測 0 支；⚠️ 這是「今天沒有任何 include 內的檔 import 它們」量出來的現況，不是結構保證：哪天有誰 import 了，那一支就會被順帶查；Grok #598 掃後收窄）。所以「型別檢查過了」不等於考題被檢查過。量過的帳：全部納入第一天＝1713 條診斷、分布在 111 支檔、1491 個報錯行位（量法＝修前版本、`checkJs` 開、只統計 `test/`；⚠️ **行位不是要改的行數**——一處修正常消掉好幾個行位，本支修兩行就消掉四個；Codex #598 r1 收窄），其中真的寫錯的只有 3 處（三處都是註解或失敗訊息；⚠️ 這是對那 1713 條**型別診斷**的分類——沒有一條指向「斷言永遠成立」——**不是**「整個 `test/` 沒有空包彈」的保證；三處已在 2026-09-11 就地修掉，其中一處在沒有標記的檔、改了也沒有任何檢查守著它）；而型別檢查對 .js 手寫夾具物件的屬性打錯字**不保證抓得到**——抓不抓得到，取決於編譯器拿到或推得出多少型別資訊；實測過的片段與結果記在 https://github.com/teacherjung/personal-finance-webapp/pull/598 的 r1〜r3 審查留言（同一種寫法換個形狀就從會叫變成不叫），這裡**不按寫法分類、不替任何寫法下結論**。⚠️ 另一把尺別混進來：考題最常見的空包彈（忘了 `await` 的 `assert.rejects`）是寫法檢查的事，型別檢查納不納入 `test/` 都抓不到，**它不是納入或不納入的理由**（Grok #598 掃後拆開）。**要納入＝另開題、先量再做**，不要把 `test/**/*.js` 順手加進 include。

## 收支三層架構（使用者定 2026-07-20）

交易表 `transactions` 靠 **`ledger` 欄位**分成兩本帳，語意完全不同：
- **信用卡消費明細**（畫面名稱「信用卡費」；`ledger:'card'`，帳單匯入 `source:'stmt'` 自動蓋）：消費分析＋查帳用，**絕不進現金流加總**（那些消費的現金流出＝銀行帳本日後的「繳卡費」，兩邊都算就重複）。前端＝`public/modules/transactions.js`（頁面本體：列表/編輯/店家檔案）＋`public/modules/transactions-import.js`（帳單匯入工作流：上傳→預覽→匯入→批次管理；系統優化階段二①搬出，接縫＝transactions.js 的 renderTransactions/expenseParents/setMonthFilter）。
- **收入支出／現金流**（畫面名稱「銀行收支」；`ledger:'cashflow'`，手動記帳＋銀行對帳單匯入）：**現金流真相**。前端＝`public/modules/cashflow.js`。

⚠️**帳本判準單一真相＝`public/modules/categories.js` 的 `isCardTx(t)`**（後端經 `lib/derive.js` 以 `isCardLedger` 別名轉供，沒有前後端同步點）。用**排除法**：`ledger==='card'` 或（缺 ledger 且 `source==='stmt'`）＝card，其餘一律 cashflow——**缺 ledger 的舊資料/還原舊備份不掉帳**。讀現金流的地方（`derive.computeCashflow`、`cashflow.js` 月加總、店家檔案）都要 `isCardTx` 排除 card。 **兩頁畫面上的分堆結果＝行為考題 `test/ledger-split-behavior.test.js`**（jsdom 載整張路由圖、餵固定資料、讀畫面上的數字；釘的是結果層，判準呼叫的形狀由兩頁的字面釘題守——字面釘分不出「字還在」和「碼還活著」，所以結果層另有一題）。

**三層分類（金流→分類→子分類）**：金流＝交易的 `type`（`income`/`expense`/**`transfer`=內轉**，derive 只加總 income/expense，transfer 天然不進本月收入/支出）。**支出分類直接沿用 `expenseTree`（card 與 cashflow 共用一棵——`saveTree` remap 全部 expense 交易＝正確、不加 ledger 過濾，跨帳本連動是要的、統計才合得起來）**；**收入分類＝`settings.incomeTree`**（`effectiveIncomeTree`/`saveIncomeTree`，`GET/POST /api/income-categories`，退路＝其他/其他收入；別名機制與支出同款＝`incomeCategoryAliases`／`incomeSubAliases`（同步點表「settings 新增欄位」列），沒有收入版的店名規則分類器——手動記帳由使用者選；銀行匯入先套學過的分類，未命中（含方向不符）才由 `classifyBankTx` 規則分箱，一般收入分類再經 `resolveImportIncome` 套別名）；內轉無分類樹（固定 內轉出/內轉入）。**繳卡費（stage 3 銀行匯入）category 留空**：計入現金流總額、但不進分類統計（卡明細已把那些消費分好類，重算會重複）。

⚠️**緊急預備金公式（使用者定 2026-07-20）**＝**台幣現金（`type='cash'` 且 `currency='TWD'`，活存＋定存都算、排除外幣）÷ 過去六個月現金流平均支出**（`avgMonthlyExpense` 窗口 6、只算有現金流資料的月份——半記錄月不拉低平均，是安全網保險）。自癒依賴＝每月匯銀行帳單，繳卡費那筆補回「刷卡消費的現金基礎支出」。⚠️**過渡期安全網保險（stage1→3 空窗，對抗審查抓到）**：卡消費排除後、還沒匯銀行帳單時 cashflow 支出≈0→月數虛高→緊急預備金提醒會**無聲關閉**（生存優先大忌）。解法＝`avgMonthlyCardExpense` 偵測「信用卡帳本近月平均消費 > 現金流支出基礎」時，**主動出聲**「緊急預備金月數可能被高估」（`computeReminders` 規則 2 後）——安全網不無聲關閉、明說原因與補法；銀行對帳單匯入後 cashflow 支出追上，此提醒自動消失。

⚠️**`ledger` 搬家一次性、共用單一判準**：`lib/store.js migrateLedgerIfNeeded`（meta 守衛 `__ledgerMigratedAt`＋`backupNow('pre-ledger-migration')`）＋`/api/import` 還原舊備份，**都走同一個 `normalizeLedger(txs)`**（source:stmt→card、其餘→cashflow；舊平面收入分類 `LEGACY_INCOME_MAP` 歸新樹）——別另寫一份判準。`ledger` **不進 CRUD 白名單、不進 REQUIRED_FIELDS**（必填會讓遷移前的舊列在下次寫檔被濾除），只在 FIELD_SCHEMA 有枚舉；手動記帳靠排除法天然歸 cashflow（不必前端送 ledger）。**三階段（拆帳本／帳戶餘額匯入／明細分箱）已全數上線；施工沿革見 `docs/archive/project-completion-log.md`。**

