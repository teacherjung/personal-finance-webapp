// 共用資料形狀的 JSDoc 型別定義（純型別、零 runtime）。
// 用法：在要檢查的檔案頂端加 `// @ts-check`，再用 `/** @typedef {import('./types.js').Db} Db */` 引入。
// 這是「零建置」拿到 TypeScript 抓錯的方式——不用改副檔名、不用 build，編輯器與 `tsc --noEmit` 就會檢查。

/**
 * 一筆收支交易。
 * @typedef {Object} Transaction
 * @property {string} id
 * @property {string} date                       民國轉西元後的 YYYY-MM-DD
 * @property {'income'|'expense'|'transfer'} type   金流（三層重構）：收入/支出/內轉——transfer 不進現金流加總
 * @property {'card'|'cashflow'} [ledger]        帳本歸屬（三層重構 stage 1）：card＝信用卡消費明細（不進現金流）、cashflow＝收入支出；缺值＝cashflow（讀取端用 isCardLedger 排除法）
 * @property {string} category                   大類（分類）
 * @property {string} [subcategory]              子類
 * @property {number} amount                     通常為正數；信用卡退款為負數，收入/支出仍由 type 決定
 * @property {string} [account]                  帳戶／信用卡名稱
 * @property {string} [note]                     顯示用店名／備註
 * @property {string} [stmtRef]                  帳單去重鍵：卡id|消費日|金額|原始說明
 * @property {string} [bankRef]                  銀行對帳單去重鍵，雙格式（P1a 機構維度）：台新＝bank|遮罩帳號|存提日|方向|金額|餘額|摘要|備註；他行＝bank2|機構|遮罩帳號|存提日|方向|…（各＋批內出現序 #N）。台新格式凍結不動——變了＝重匯判不出重複＝現金流翻倍
 * @property {string} [bankKey]                  銀行收支學習鑰匙（摘要＋對方帳號）：import 時算好存起，供 learnFromBankEdit 與未來匯入比對（改顯示名不變）
 * @property {string} [storeKey]                 自動學習用的穩定鍵（cleanStore 後原名）
 * @property {'stmt'|'bank'} [source]            來源：stmt＝信用卡帳單匯入、bank＝銀行對帳單匯入（三層重構 stage 3）；缺值＝手動記帳
 * @property {'in'|'out'} [dir]                  銀行交易金流方向（存提事實，不隨分類改變）：供「同類一起改」逐筆方向護欄（Codex r13#2）
 * @property {string} [autoNote]                 銀行交易預設自動顯示名（摘要・原始備註）：清空自訂說明時回復用（使用者定 2026-07-21）
 * @property {string|null} [bankSummary]         銀行交易的**帳單原文摘要**（2026-08-22）：解析器抄下來、一字未改；顯示名可被改寫，原文不動。服務層寫、非 CRUD。null＝'str' 的全站清空語意（外部備份可能帶進來）——顯示層當成「沒有原文」
 * @property {string} [bankBatch]                卡片帳本列若是金融卡帳單連帶記的（Stage 5b）＝那份銀行帳單的匯入批次代號：生命週期跟它走（銀行匯入紀錄刪批一起拿掉；信用卡匯入紀錄不列、不准改卡／單獨刪）。服務層寫、非 CRUD
 * @property {string|null} [bankNote]            銀行交易的**帳單原文備註**（同上）：與摘要分開存——揉成一句就分不回來。⚠️ **純留底、不參與任何判定**（分類／內轉／去重／學習讀的是匯入當下解析器給的原文，不是這一欄）
 * @property {string} [importBatch]              匯入批次代號
 * @property {string} [importedAt]
 * @property {string} [autoCat]                  匯入當下的完整自動判斷（大類）——體檢分辨「人改的 vs 機器判的」用
 * @property {string} [autoSub]                  同上（子類）
 * @property {string} [stmtMonth]                這筆所屬帳單的期別 YYYY-MM（讀自帳單表頭或使用者手動修正）
 * @property {number} [stmtDue]                  這筆所屬帳單的應繳金額（讀自帳單；與匯入金額不同，見 AGENTS）
 * @property {string|null} [refundOf]            信用卡退款配對標記；null＝待 P1 彙總時配對（服務層擁有）
 * @property {boolean} [isAdjustment]            AI 帳單的具名調整列（利息/年費/回饋；裁示② 2026-08-30）——繳款判準豁免它（服務層擁有）
 */

/**
 * 一筆訂閱。
 * @typedef {Object} Subscription
 * @property {string} id
 * @property {string} name
 * @property {number} amount
 * @property {'monthly'|'quarterly'|'semiannual'|'yearly'|'lifetime'} cycle
 * @property {'active'|'ending'|'ended'} [status]
 * @property {boolean} [active]
 * @property {string} [endsOn]                   停用日 YYYY-MM-DD
 * @property {string} [nextCharge]               下次扣款日 YYYY-MM-DD
 * @property {number} [chargeAnchorDay]          續費日自動推進的號數錨點（服務層擁有；1/31 收成 2/28 後，
 *                                               下個月要回到 31 號靠它，見 subscriptions-model.js chargeAnchorDay）
 * @property {string} [since]                    起算月 YYYY-MM
 */

/**
 * 資產／負債帳戶（現金、IB、房產、房貸…）。
 * @typedef {Object} Account
 * @property {string} id
 * @property {string} [name]
 * @property {string} [type]
 * @property {string} [class]
 * @property {number} balance                    可為負（負債／融資）
 * @property {string} [currency]                 TWD/USD/GBP/JPY，預設 TWD
 * @property {string} [ibCashCur]                有值＝IB 現金帳戶（幣別碼）
 * @property {string} [accountNo]                完整帳號（PII，銀行對帳單末碼比對；GET 剝除，stage 2）
 * @property {string} [balanceAsOf]              餘額現值參考日 YYYY-MM-DD（銀行對帳單「較新才覆蓋」；服務層寫，stage 2）
 * @property {string} [cdKey]                    定存身分鍵（2026-08-18 分開列管；服務層寫）：機構|末碼|幣別|起迄日|金額|#序——有值＝這顆帳戶是一筆定存、不進泛用帳戶比對
 * @property {string} [bank]                     開戶機構（P1a 機構維度）：銀行對帳單匯入**新建**帳戶時蓋戳（帳單自己的宣告）；matchAccount 憑它擋「不同銀行、相同可見帳號段」的跨行誤配。缺席＝不驗機構（機構維度之前的帳戶／手動建立）。服務層寫、非 CRUD 白名單（同 balanceAsOf）
 * @property {boolean} [accountNoSuffixOnly]   帳號只知道末四碼（Stage 1：簽帳金融卡明細建的戶——那個版面只印 `**********8791`）。matchAccount 憑它走寬鬆徑：日後綜合對帳單帶完整遮罩、同銀行＋同幣別＋末碼**唯一**命中＝同一顆帳戶，帳號補登成完整的並清掉本標記（只增不減）。服務層寫、非 CRUD 白名單（同 balanceAsOf）
 */

/**
 * 一筆投資持股。
 * @typedef {Object} Holding
 * @property {string} [id]
 * @property {string} symbol
 * @property {string} [name]
 * @property {'core'|'satellite'|'stock'|'bond'|'gold'|string} [layer]
 * @property {string} [currency]
 * @property {number} [quantity]
 * @property {number} [price]
 * @property {number|string} [avgCost]           購買均價（優先於 cost）
 * @property {number} [cost]                     舊的總成本欄
 * @property {string} [quoteSymbol]              Yahoo 報價代號（覆寫預設）
 * @property {string} [source]                   'ib'＝來自 IBKR 同步
 */

/** @typedef {Object} Card
 * @property {string} id
 * @property {string} name
 * @property {string} [type]                     'credit'｜'debit'（簽帳金融卡，Stage 5b：銀行匯入自動建）｜'membership'
 * @property {string} [issuer]                   發卡行**顯示名稱**（2026-09-02 起只當顯示；沒有 issuerId 時才回頭當身分用）
 * @property {string} [issuerId]                 發卡機構代號（`public/modules/card-issuers.js` 的 `CARD_ISSUERS[].id`）＝自動歸卡的身分來源。
 *                                               判準是**三態**（`cardCode`），三格的處置各不相同、不可壓成兩格：
 *                                               ①代號查得到**且顯示名確認了它**（空白／正式名／別名／歧義寫法含它）⇒ 身分＝代號那一家；
 *                                               ②代號查得到**但顯示名沒有確認它**＝**說不清楚** ⇒ 判不出身分，**且刻意不退回 `issuer` 文字判準**
 *                                                 （退回文字＝讓顯示名指定另一家；J13 就是釘這一格：`{issuer:'台北富邦銀行', issuerId:'taishin'}`
 *                                                  若退回文字會被算成富邦，另一張富邦卡就成了唯一同行卡、帳單自動歸過去）；
 *                                               ③沒有可解析的代號（缺席／空／非字串／不認得）⇒ 退回 `issuer` 字串判準（舊卡零回歸，J12）。
 *                                               判準本體＝`lib/card-identity.js` 的 `cardIssuerBank`／`cardCertainlyNot`
 * @property {string} [network]
 * @property {string} [lastFour]                 卡號末四碼（自動歸卡用）
 * @property {number|string} [dueDay]            每月繳款日
 * @property {number|string} [statementDay]      每月結帳日
 * @property {number} [annualFee]
 * @property {string} [expiry]
 * @property {string} [benefits]
 * @property {string} [pdfPassword]              帳單 PDF 密碼＝身分證字號（本機、永不進版控）
 */

/** @typedef {Object} Insurance
 * @property {string} id
 * @property {string} policyName
 * @property {number} [premium]
 * @property {string} [premiumCycle]
 * @property {string} [insured]
 * @property {string} [nextPayment]
 * @property {string} [endDate]
 */

/**
 * IB 官方淨值摘要（同步時更新，基準幣別 USD）。
 * @typedef {Object} IbEquity
 * @property {number|string} [stock]
 * @property {number|string} [cash]              負＝融資借款
 * @property {string} [date]
 */

/** IB 現金流（股息/利息…，同步時整批更新）。
 * @typedef {Object} IbIncome
 * @property {number} [dividends]
 * @property {number} [paymentInLieu]
 * @property {number} [withholdingTax]
 * @property {number} [interestPaid]
 * @property {number} [interestReceived]
 * @property {number} [other]
 * @property {number} [count]
 * @property {number} [skippedNoFx]
 * @property {number} [skippedNoCurrency]
 * @property {number} [estimatedNoFx]
 * @property {string[]} [estimatedCurrencies]
 * @property {string} [from]
 * @property {string} [to]
 */

/** IB 連線設定（同步時更新 lastEquity/income）。
 * @typedef {Object} IbSettings
 * @property {string} [flexToken]
 * @property {string} [flexQueryId]
 * @property {string|null} [lastSync]
 * @property {IbEquity|null} [lastEquity]
 * @property {IbIncome|null} [income]
 */

/**
 * 設定（data/store.json 的 settings；由 lib/store.js emptyDb() 定義預設）。
 * @typedef {Object} Settings
 * @property {string} [currency]
 * @property {number} [usdTwd]
 * @property {{GBP?:number, JPY?:number}} [fxTwd]
 * @property {number} [emergencyFundMonths]
 * @property {number} [allocationDriftPct]
 * @property {number} [ibConcentrationPct]
 * @property {number} [equityCapPct]
 * @property {number} [countryCapPct]
 * @property {number} [chinaCapPct]
 * @property {number} [levCapPct]
 * @property {number} [ibMaintenancePct]
 * @property {number} [ibIdleCashAlert]
 * @property {number} [qqqmMaxPct]
 * @property {number|null} [netWorthTarget] 淨資產目標（台幣元；null＝尚未設定）
 * @property {string} [taishinSecPdfPassword] 台新證券對帳單 PDF 密碼（機密投影剝除、只在伺服器端使用；''＝未設定）
 * @property {string} [rememberedStatementPasswords] 記住的帳單密碼池（P0.5）＝JSON.stringify(string[]) 單一字串（機密投影剝除、只在伺服器端使用；''＝沒記住）
 * @property {boolean} [aiAskBeforeSend] 送 AI 前要不要先跳確認窗（2026-08-13 拍板＝**預設不問、直接送**；true 才每次問）。前端 CRUD 可寫（'bool' 型別、settingValueOk 單一判準）。
 * @property {boolean} [aiDualRead] 新版式雙讀（裁示⑦ 2026-08-16＝**預設開**）：判準 dualReadWanted＝只有明確 false 才關（讀不到/壞型別＝開＝多驗證）。前端 CRUD 可寫（'bool' 型別）。
 * @property {string} [aiApiKey] AI 解析鑰匙（P1b-1，★3 拍板＝Anthropic）：比照 flexToken——LOCAL 明文／HOSTED 加密／機密投影剝除只回 aiApiKeySet；''＝未設定
 * @property {number} [aiCapPerBill] 成本護欄 C1：單張帳單發數上限（前端 CRUD 可寫 'posnum'；讀取端 capOf 取整夾 1、非法回預設 6）
 * @property {number} [aiCapPerDay] 成本護欄 C1：單日發數上限（同上；預設 20＝防暴走保險絲）
 * @property {{date:string, n:number}} [aiUsage] 成本護欄 C1：單日已用發數（server-owned＝不進前端白名單；repo.updateAiUsage 原子累加；備份匯入保留＋消毒）
 * @property {string} [capeManual]
 * @property {string} [quotesLastAt] 報價上次自動更新時間（ISO 字串；server-owned，D1，仿 ib.lastSync，不進前端白名單）
 * @property {Record<string, {n:number, lastAt:string, lastBank:string}>} [recipeBirthStats] 規則卡出生統計（2026-08-19，體檢 R2；封閉鍵集合＝BIRTH_CODES，服務層欄位、不進前端白名單）
 * @property {string} [storeRulesHash] 上次「自動整理店名」時的規則指紋（服務層擁有；前端不寫、匯入不保留）
 * @property {string} [lastBackupDate] 上次每日滾動備份成功的日期 YYYY-MM-DD（服務層擁有；失敗時**不寫**，今天才會重試）
 * @property {number} [backupFailStreak] 每日備份連續失敗次數（服務層擁有；畫面據此提高警告強度，成功歸零）
 * @property {string} [backupLastError] 每日備份最後一次失敗訊息（服務層擁有）
 * @property {string} [backupLastErrorAt] 每日備份最後一次失敗時間 ISO（服務層擁有）
 * @property {Record<string, string>} [healthDismissed] 帳務體檢「略過」的項目指紋→時間（服務層擁有，經 /health/dismiss 寫）
 * @property {Record<string, string>} [signals]
 * @property {number} [fxHigh]
 * @property {number} [fxLow]
 * @property {Record<string, string[]>} [expenseTree]   自訂支出分類樹（大類→子類；缺→用 categories.js 預設）
 * @property {Record<string, string[]>} [incomeTree]    自訂收入分類樹（三層重構；缺→用 categories.js 的 INCOME_TREE 預設）
 * @property {Record<string, string>} [categoryAliases]  分類器別名：舊大類名→現大類名（改名內建分類後，未來自動分類沿用新名）
 * @property {Record<string, Record<string,string>>} [subAliases]  子類別名：現大類→{舊子類→現子類}
 * @property {Record<string, string>} [incomeCategoryAliases]  收入分類器別名（同 categoryAliases，銀行匯入自動分類收入用，Codex r13#3）
 * @property {Record<string, Record<string,string>>} [incomeSubAliases]  收入子類別名（同 subAliases）
 * @property {StoreRules} [storeRules]     使用者自訂店名規則（第三帖）：純資料、由 repo 櫃檯餵給 lib/store-rules.js
 * @property {IbSettings} ib               一律存在（emptyDb 預設 {flexToken,flexQueryId,lastSync}）
 */

/**
 * 使用者自訂的店名規則（第三帖，存 settings.storeRules）。**純文字，不是正規表示式**——
 * `lib/store-rules.js` 負責跳脫成安全的樣式（使用者沒有程式背景，不該也不能寫 regex）。
 * 每一種都排在同類的內建規則**前面**（自助的意義＝蓋得過內建判斷）。
 * @typedef {Object} StoreRules
 * @property {{match:string, to:string, mode:string}[]} canon        這些寫法算同一家店 → 標準名（mode＝contains/startsWith/exact）
 * @property {{match:string, to:string}[]} brand                     開頭是這個品牌 → 併回標準品牌名（分店保留）
 * @property {{match:string, to:string}[]} rename                    顯示名字串取代（保留分店）
 * @property {string[]} chains                                       沒有分隔符也要切分店的連鎖名
 * @property {string[]} parkExempt                                   不要被包成「停車費（…）」的店名
 */

/** 一筆帳單分類自動學習（依店名 storeKey）。
 * @typedef {Object} LearnedEntry
 * @property {string} [category]
 * @property {string} [subcategory]
 * @property {string} [name]        使用者改過的顯示店名
 */

/** 一筆銀行收支「真·學習」（依 bankKey＝摘要＋對方帳號）。type 必存（定收支方向）。
 * @typedef {Object} LearnedBankEntry
 * @property {'income'|'expense'|'transfer'} type
 * @property {string} [category]
 * @property {string} [subcategory]
 * @property {string} [name]        使用者改過的收支顯示說明
 */

/** @typedef {'unreviewed'|'watching'|'valid'|'needs-review'|'broken'} ResearchStatus */
/** @typedef {'business'|'financial'|'valuation'|'evidence'|'risk'} ResearchScoreKey */

/**
 * @typedef {Object} ResearchScorecard
 * @property {number} [business]
 * @property {number} [financial]
 * @property {number} [valuation]
 * @property {number} [evidence]
 * @property {number} [risk]
 * @property {Partial<Record<ResearchScoreKey,string>>} [reasons]
 */

/**
 * @typedef {Object} ResearchValuationScenarios
 * @property {'TWD'|'USD'|'GBP'|'JPY'} [currency]
 * @property {string} [asOf]
 * @property {string} [method]
 * @property {number} [bear]
 * @property {number} [base]
 * @property {number} [bull]
 * @property {string} [assumptions]
 */

/**
 * 個股研究筆記。舊資料只含 symbol/thesis/metrics/risks/checkpoints 仍合法；其餘為個股研究頁 v1 選填欄位。
 * @typedef {Object} Research
 * @property {string} [id]
 * @property {string} symbol
 * @property {string|null} [thesis]
 * @property {string|null} [metrics]
 * @property {string|null} [risks]
 * @property {ResearchStatus} [status]
 * @property {string} [lastReviewedAt]
 * @property {ResearchScorecard|null} [scorecard]
 * @property {ResearchValuationScenarios|null} [valuationScenarios]
 * @property {{id?:string,text?:string,horizon?:string,status?:'watching'|'happened'|'expired'}[]} [catalysts]
 * @property {{id?:string,text?:string,status?:'watching'|'triggered'|'cleared'}[]} [thesisBreakers]
 * @property {{id?:string,label?:string,unit?:string,value?:number|null,period?:string,source?:string}[]} [watchMetrics]
 * @property {{id?:string,label?:string,url?:string,asOf?:string}[]} [sources]
 * @property {{date?:string,note?:string}[]} [checkpoints] 日期相容 YYYY-MM 舊資料與 YYYY-MM-DD 新資料
 * @property {{date?:string,total?:number,scores?:Partial<Record<ResearchScoreKey,number>>}[]} [scoreHistory]
 */

/**
 * @typedef {Object} ParseRecipeRow 帳單配方快取列（P2-2；裁示④細部＝留 1 版、回滾自動）
 * @property {string} id
 * @property {string} [bank] 配方宣稱的銀行短名（資訊性）
 * @property {string} [kind] 種類標籤（批四：'card'＝信用卡規則卡；缺席＝銀行）——路由過濾判準
 * @property {object} current 現行配方（格式 A；出生三關驗過才存）
 * @property {object} [previous] 上一版（閘紅自動回滾用；**沒有＝欄位缺席**——schema 的 object 型別不收 null）
 * @property {number} [graduateStreak] 連續全過強閘的套用次數（≥5＝畢業）
 * @property {boolean} [graduated] 畢業旗標
 * @property {boolean} [suspect] 疑似過期（配方在場但閘紅過、等 P2-3 重生）
 * @property {number} [rebirths] 重生累計（達 5＝內建化候選訊號）
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 * @property {string} [lastUsedAt]
 */

/**
 * SEC 官方基本面每租戶快取。data 是 lib/stock-fundamentals.js 的純解析結果；研究文字不混入此集合。
 * @typedef {Object} StockFundamentalsCache
 * @property {string} symbol
 * @property {string} lastAttemptAt
 * @property {string} [fetchedAt]
 * @property {Record<string, any>} [data]
 * @property {{at:string,code:string,stage:string,status:number,message:string}} [lastError]
 */

/**
 * 整個本機資料庫（data/store.json 的形狀）。
 * @typedef {Object} Db
 * @property {Settings} settings              一律存在（load() 缺檔時回 emptyDb）
 * @property {Account[]} [accounts]
 * @property {{id?:string, class:string, targetPct?:number}[]} [assetTargets]
 * @property {Transaction[]} [transactions]
 * @property {Record<string, LearnedEntry>} [learnedCategories]
 * @property {Record<string, LearnedBankEntry>} [learnedBank]
 * @property {{label:string, role?:'out'|'in'|'settle'}[]} [transferSubs]  內轉子分類清單（可全編輯；空→用 DEFAULT_TRANSFER_SUBS）
 * @property {Subscription[]} [subscriptions]
 * @property {Holding[]} [holdings]
 * @property {Card[]} [cards]
 * @property {Insurance[]} [insurance]
 * @property {{month:string, date?:string, netWorth?:number, assets?:number, liabilities?:number, byClass?:Record<string,number>}[]} [snapshots]
 * @property {{month:string, amount:number}[]} [history]
 * @property {any[]} [ibTrades]
 * @property {SecurityTrade[]} [securityTrades] 證券交易共同集合（S2：IB 同步雙寫＋台新匯入；服務層寫、前端唯讀）
 * @property {any[]} [watchlist]
 * @property {Research[]} [research]
 * @property {StockFundamentalsCache[]} [stockFundamentals]
 * @property {ParseRecipeRow[]} [parseRecipes]
 * @property {any[]} [portfolioSnapshots]
 * @property {DailyValue[]} [dailyValues]
 * @property {InsightState} [insightState]
 */

/**
 * 每日洞察引擎書籤（D3）：GET /api/insights 被讀取＝視為「看過了」，當下更新此物件。差異引擎靠它算
 * 🆕新出現／✓已解除／跳檔／自上次 Δ。空物件＝首次執行（全當持續中、不標 🆕）。服務層 getInsights 專寫、非 CRUD。
 * @typedef {Object} InsightState
 * @property {string} [lastSeenAt]               本次讀取時間（ISO）
 * @property {string|null} [prevSeenAt]          上一次讀取時間（給「自從你上次看 7/15」顯示）
 * @property {number} [netWorth]                 上次看時的淨資產（自上次 Δ 用）
 * @property {number} [pfValue]                  上次看時的投組市值
 * @property {{key:string,title:string,module:string,level:string}[]} [reminders]  上次看時的提醒輕量快照（比 key 判新增/解除、留 title 供「已解除：…」顯示）
 * @property {{us:number|null,china:number|null,japan:number|null,korea:number|null,taiwan:number|null}} [tiers]  上次看時的五市場估值檔位（比對跳檔）
 * @property {number|null} [usdTwd]              上次看時的美元匯率
 */

/**
 * 一天一行的淨值日線（D0，差異引擎的原料）。月快照是「同月覆蓋」只留一個點，
 * 日線是「同日覆寫、跨日累積」——有了它才算得出「今天 vs 昨天」「本週 Δ」。
 * @typedef {Object} DailyValue
 * @property {string} date                       本地日 YYYY-MM-DD（主鍵，必填）
 * @property {number} [netWorth]
 * @property {number} [assets]
 * @property {number} [liabilities]
 * @property {number} [pfCost]                   投組累計投入成本（台幣）
 * @property {number} [pfValue]                  投組市值（台幣）
 * @property {number} [usdTwd]                   當日採用的美元匯率（事後回推用）
 * @property {number} [gbpTwd]                   當日採用的英鎊匯率（0＝未設定）
 * @property {number} [jpyTwd]                   當日採用的日圓匯率（0＝未設定）——三種都留底才分得出
 *                                               「淨值變動」是資產本身動了還是匯率動了
 */

/** 提醒的嚴重度。 @typedef {'danger'|'warn'|'info'} Level */
/** 一則提醒。
 * @typedef {Object} Reminder
 * @property {string} key 穩定識別鑰匙（規則代號＋實體 id/代號，如 `conc-stock-TSMC`、`card-due-{id}`）——每日洞察
 *   引擎（D2）的差異引擎靠它判「🆕新出現／✓已解除／持續中」。**不可用訊息文字**（含金額會變）**或陣列索引**（會漂移）：
 *   同一個底層狀況跨日/跨次計算 key 必須相同。同一次計算內各條 key 互異。
 * @property {Level} level
 * @property {string} module
 * @property {string} title
 * @property {string} detail
 */

// ---- 帳單解析（lib/statement.js）----
/** 各家解析器回傳的原始一列（尚未分類）。
 * @typedef {Object} RawTx
 * @property {string|null} date       消費日 YYYY-MM-DD
 * @property {string|null} [postDate] 入帳日
 * @property {string} desc            原始消費說明
 * @property {number} amount          台幣金額（負數再由 isCardPayment 分成真正繳款／退款）
 */

/** finalize 後的一筆消費（分類＋顯示店名）。
 * @typedef {RawTx & {
 *   isPayment: boolean,
 *   isRefund: boolean,
 *   category: string,
 *   subcategory: string,
 *   store: string
 * }} ParsedTx
 */

/** parseStatement 的回傳。
 * @typedef {Object} StatementResult
 * @property {string} bank                 '富邦'|'台新'|''（**空字串＝認不出是哪一家**，不得自動歸卡）
 * @property {'header'|'none'} [bankEvidence] 機構名的證據種類（見 lib/card-identity.js）；
 *   `none` ⇒ bank 必為 ''。前端據它印「認不出這是哪一家」的警語——**服務層漏帶這一欄，警語就永遠印不出來**。
 * @property {string|null} [lastFour]      卡號末四碼（抓不到＝null）
 * @property {ParsedTx[]} transactions
 * @property {string|null} [statementMonth] 帳單期別 YYYY-MM（讀自帳單表頭；讀不到為 null）
 * @property {number|null} [statementDue] 本期應繳金額（讀自帳單；讀不到為 null）
 * @property {{due:number|null, prevDue:number|null, paidAndRefund:number|null, newCharges:number|null}} [statementTotals]
 *   帳單摘要四格（P0 對帳閘的中閘原料；各格讀不到＝null，due 與 statementDue 同值）
 */

export {};   // 讓本檔成為 ES module，型別才可被 import('./types.js') 引入

/** 證券交易共同格式（S2，藍圖 §四；lib/services/security-trades.js 正規化產出＋匯入層補 id/importBatch/importedAt）
 * @typedef {Object} SecurityTrade
 * @property {string} id
 * @property {'ibkr'|'taishin'} source
 * @property {string} sourceAccountId 帳戶不可逆指紋
 * @property {string} sourceAccountLabel 遮罩顯示名
 * @property {string} tradeDate YYYY-MM-DD
 * @property {string} [settlementDate]
 * @property {string} symbol
 * @property {string} [name]
 * @property {'buy'|'sell'} side
 * @property {number} quantity 一律正數（方向看 side）
 * @property {number} [price]
 * @property {number} [grossAmount]
 * @property {number} [commission]
 * @property {number} [tax]
 * @property {number} [feeDiscount]
 * @property {number} [otherFees]
 * @property {number} [netSettlement] 應收付絕對值（方向看 cashDirection）
 * @property {'in'|'out'} cashDirection
 * @property {string} [commissionCurrency] 手續費幣別（與交易幣別不同才存；IB ibCommissionCurrency）
 * @property {string} currency
 * @property {string} [market]
 * @property {string} [rawType]
 * @property {string} sourceRef 去重鍵（identifier-first）
 * @property {string} importBatch
 * @property {string} importedAt
 */
