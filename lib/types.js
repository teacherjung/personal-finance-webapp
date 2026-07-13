// 共用資料形狀的 JSDoc 型別定義（純型別、零 runtime）。
// 用法：在要檢查的檔案頂端加 `// @ts-check`，再用 `/** @typedef {import('./types.js').Db} Db */` 引入。
// 這是「零建置」拿到 TypeScript 抓錯的方式——不用改副檔名、不用 build，編輯器與 `tsc --noEmit` 就會檢查。

/**
 * 一筆收支交易。
 * @typedef {Object} Transaction
 * @property {string} id
 * @property {string} date                       民國轉西元後的 YYYY-MM-DD
 * @property {'income'|'expense'} type
 * @property {string} category                   大類（分類）
 * @property {string} [subcategory]              子類
 * @property {number} amount                     一律正數；收入/支出由 type 決定
 * @property {string} [account]                  帳戶／信用卡名稱
 * @property {string} [note]                     顯示用店名／備註
 * @property {string} [stmtRef]                  帳單去重鍵：卡id|消費日|金額|原始說明
 * @property {string} [storeKey]                 自動學習用的穩定鍵（cleanStore 後原名）
 * @property {'stmt'} [source]                   來源＝帳單匯入
 * @property {string} [importBatch]              匯入批次代號
 * @property {string} [importedAt]
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
 * @property {string} [since]                    起算月 YYYY-MM
 */

/**
 * 資產／負債帳戶（現金、IB、房產、房貸…）。
 * @typedef {Object} Account
 * @property {string} id
 * @property {string} [type]
 * @property {string} [class]
 * @property {number} balance                    可為負（負債／融資）
 * @property {string} [currency]                 TWD/USD/GBP/JPY，預設 TWD
 * @property {string} [ibCashCur]                有值＝IB 現金帳戶（幣別碼）
 */

/**
 * 一筆投資持股。
 * @typedef {Object} Holding
 * @property {string} symbol
 * @property {'core'|'satellite'|'stock'|'bond'|'gold'|string} [layer]
 * @property {string} [currency]
 * @property {number} [quantity]
 * @property {number} [price]
 * @property {number|string} [avgCost]           購買均價（優先於 cost）
 * @property {number} [cost]                     舊的總成本欄
 * @property {string} [source]                   'ib'＝來自 IBKR 同步
 */

/** @typedef {Object} Card
 * @property {string} id
 * @property {string} name
 * @property {string} [type]
 * @property {number|string} [dueDay]            每月繳款日
 * @property {number|string} [statementDay]      每月結帳日
 */

/** @typedef {Object} Insurance
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
 * @property {number|string} [cash]
 */

/**
 * 設定（只列 derive.js 會用到的欄位；其餘用 any 收尾）。
 * @typedef {Object} Settings
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
 * @property {number} [fxHigh]
 * @property {number} [fxLow]
 * @property {{ lastEquity?: IbEquity, income?: { interestPaid?: number } }} [ib]
 */

/** 一筆帳單分類自動學習（依店名 storeKey）。
 * @typedef {Object} LearnedEntry
 * @property {string} [category]
 * @property {string} [subcategory]
 * @property {string} [name]        使用者改過的顯示店名
 */

/**
 * 整個本機資料庫（data/store.json 的形狀）。
 * @typedef {Object} Db
 * @property {Settings} [settings]
 * @property {Account[]} [accounts]
 * @property {{class:string, targetPct?:number}[]} [assetTargets]
 * @property {Transaction[]} [transactions]
 * @property {Record<string, LearnedEntry>} [learnedCategories]
 * @property {Subscription[]} [subscriptions]
 * @property {Holding[]} [holdings]
 * @property {Card[]} [cards]
 * @property {Insurance[]} [insurance]
 * @property {{month:string, amount:number}[]} [snapshots]
 * @property {any[]} [ibTrades]
 * @property {any[]} [watchlist]
 * @property {any[]} [research]
 * @property {any[]} [portfolioSnapshots]
 * @property {any[]} [history]
 */

/** 提醒的嚴重度。 @typedef {'danger'|'warn'|'info'} Level */
/** 一則提醒。
 * @typedef {Object} Reminder
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
 * @property {number} amount          台幣金額（負數＝繳款/退款）
 */

/** finalize 後的一筆消費（分類＋顯示店名）。
 * @typedef {RawTx & {
 *   isPayment: boolean,
 *   category: string,
 *   subcategory: string,
 *   store: string
 * }} ParsedTx
 */

/** parseStatement 的回傳。
 * @typedef {Object} StatementResult
 * @property {string} bank                 '富邦'|'台新'
 * @property {string|null} [lastFour]      卡號末四碼（抓不到＝null）
 * @property {ParsedTx[]} transactions
 */

export {};   // 讓本檔成為 ES module，型別才可被 import('./types.js') 引入
