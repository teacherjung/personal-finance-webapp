# 欄位所有權

由共同入口 [AGENTS.md](../AGENTS.md) 路由至本檔；本檔為下列內容的正本。

## ⚠️ 欄位所有權（護欄 G5，2026-07-22；防「PUT 挾帶假值劫持服務資料」）

**原則**：每個欄位只有一個「擁有者」。**使用者可寫**的欄位進 `lib/schema.js` 的 `WRITABLE_FIELDS`（CRUD 表單改）；**服務層擁有**的衍生欄位**絕不進 `WRITABLE_FIELDS`**（前端表單從不送；放行過的年代 PUT 可挾帶假 `storeKey` 劫持學習鑰匙、假 `source:'ib'` 藏融資風險、假 `dir` 毀現金流方向）。三道寫入閘門：①`pickWritable`（CRUD PUT/POST，只收白名單）②`sanitizeDbForWrite`（櫃檯 `save`，驗 `FIELD_SCHEMA` 型別、**放行**白名單外的服務欄位）③`validateImportItem`（`/api/import` 還原，驗型別、不剝白名單外欄位）。**服務欄位仍要有 `FIELD_SCHEMA` 型別**——服務寫入與匯入還原都靠它擋壞值（數字型會讓 `.split`/`.slice`/聚合走樣）。

| 集合 | 使用者可寫（CRUD 白名單） | 服務層擁有（誰寫、不進白名單） | 唯讀/衍生 |
|---|---|---|---|
| `transactions` | date, type, category, subcategory, amount, account, note, summary, remark（後兩欄也可由銀行匯入規則與明確選擇的同原文傳播寫入） | **帳單匯入**（statement-import）：stmtRef, storeKey, source, importBatch, importedAt, autoCat, autoSub, stmtMonth, stmtDue, refundOf, isAdjustment（AI 帳單具名調整列，#529）；**銀行匯入**（bank-import）：ledger, source, dir, autoNote, bankRef, bankKey, bankSummary/bankNote（帳單原文留底，Stage 2）；ledger 亦由遷移寫 | — |
| `accounts` | name, type, class, currency, balance, accountNo（PII，前端可填、GET 剝成末 4 碼） | **balanceAsOf**（銀行對帳單「較新才覆蓋」的餘額參考日——**服務層寫、非 CRUD 白名單**，Codex r14#5：勿誤列成使用者可寫）、ibCashCur（IB 同步）、**bank**（開戶機構戳，P1a 機構維度——銀行匯入**新建**帳戶時蓋、比對成功不回填；matchAccount 憑它擋跨行誤配；FIELD_SCHEMA 驗字串（P1a r1#3）） | — |
| `holdings` | symbol, name, layer, currency, quantity, price, avgCost, cost, quoteSymbol | source（IB 同步；`source:'ib'` 決定融資槓桿，假值會藏風險） | ⚠️`price` **多方合法寫**：使用者手動＋前端「更新報價」按鈕＋後端 D1 `refreshQuotesIfStale`（開 app 自動）——都合法，非違規 |
| `watchlist` | symbol, name, targetPrice, currency, quoteSymbol, note | — | ⚠️`lastPrice`/`lastAt`＝**報價衍生**，目前**前端「更新報價」按鈕**寫（PUT）故**仍在白名單**。低風險（觀察清單不進淨值）。**待辦**：D-engine market-data 服務化後，把持股/觀察清單報價更新全移到後端（比照 D1），`lastPrice`/`lastAt`（＋或 `holdings.price`）退出白名單＝純服務擁有 |
| `cards` | name, type（credit／debit／membership）, issuer, issuerId, network, lastFour, level, memberId, statementDay, dueDay, annualFee, expiry, benefits, note, pdfPassword | 銀行匯入（bank-import）會**自動建**簽帳金融卡（type:'debit'；Stage 5b；**不帶 issuerId**——那條路走 `bank-alias` 的 `sameBank`、讀的是 issuer 字串） | pdfPassword＝PII（身分證字號；讀寫端 `projectCard` 剝，只卡片編輯窗需要）。issuer＝發卡機構名稱＝**顯示＋確認**（2026-09-02 起；有可解析代號時它負責確認代號，沒有代號時它才是身分本身——**不可寫成「只當顯示」**）；issuerId＝**機構代號**＝自動歸卡的身分來源（清單＝`public/modules/card-issuers.js` 的 `CARD_ISSUERS[].id`，判準＝`lib/card-identity.js` 的 `cardIssuerBank`；**缺席／不認得＝退回 issuer 字串判準**，舊卡零回歸）。⚠️ **兩欄是同一個身分的兩半**：`PUT` 部分更新＋淺合併會讓它們走散（「只送 issuer」留下舊代號＝舊分頁就會這樣送；兩欄一起送也可以互相矛盾）。兩側收口：`pickWritable` 跨欄規則（送 issuer 沒送 issuerId ⇒ 代號一起清掉，**反向不補顯示名**）＋判準側 `cardCode` 三態（顯示名沒有確認代號＝**說不清楚**，既不採信代號也**不退回文字**）。⇒ 不變量：**有代號的卡只會判成它自己那一家或判不出來，不可能判成別家**。⚠️ **代號是持久資料、永不改名或刪除**（改了＝那些卡查不到身分），考題把整組代號釘成精確集合。⚠️ **代號今天只作用在信用卡帳單那條路**（`statement-import.js` 兩個入口都只收 credit）；簽帳卡歸卡（`bank-import.js` 的 `sameBank`）**不讀 issuerId**＝改發卡行的字會另建一張卡（base 既有），所以卡片頁的升級提示**只發給信用卡**。兩欄**都刻意不進 `FIELD_SCHEMA`**（issuer＝封閉枚舉會讓清單外機構填不進去、`'str'` 會讓升級前的壞值炸掉整庫寫入；issuerId＝讀取端 typeof 硬判、壞型別安全退回文字，型別牆買不到行為改變）|
| `subscriptions` / `insurance` / `research` / `history` | 全部欄位（見 `WRITABLE_FIELDS`） | — | — |
| `settings` | 頂層／signals／ib 各有白名單（見同步點「settings 新增欄位」列） | quotesLastAt（報價更新）、storeRulesHash（規則整理）、healthDismissed（體檢略過）、上次真的推進／對齊／整理的三個時間（subsLastRolledAt、accountNamesLastAlignedAt、storeNamesLastNormalizedAt）；其餘服務欄與「**匯入備份要保留**」規則＝同步點「settings 新增欄位」列（單一真相，此處不重抄清單） | — |
| `securityTrades` | —（READONLY，前端只 GET） | **IB 同步雙寫＋台新對帳單匯入**；細節見`docs/sync-index.md` 同步點清單「securityTrades 欄位所有權與去重」列 | — |
| `assetTargets` | class, targetPct | — | 資產配置目標（使用者自訂） |
| `portfolioSnapshots` / `ibTrades` / `dailyValues` / `stockFundamentals` / `snapshots` | —（`READONLY_COLLECTIONS`＋snapshots，前端只 GET；securityTrades 同屬 READONLY、見上列） | portfolioSnapshots・ibTrades＝IB 同步；dailyValues＝`snapshot.js recordDailyValue`（D0）；stockFundamentals＝SEC 官方資料快取（stock-fundamentals 服務）；snapshots＝`snapshot.js`（月快照） | 純服務寫、前端唯讀 |

**改欄位所有權時**：搬進/搬出白名單都要想「這個值可信嗎」——使用者能捏造的值不可決定財務判準（槓桿/方向/帳本/學習鑰匙）。新增服務欄位一律補 `FIELD_SCHEMA` 型別、**不要**加進 `WRITABLE_FIELDS`（測試種假資料走 repo 直寫＝`server.test.js seedTx`，不可為了種資料把白名單加回去）。

