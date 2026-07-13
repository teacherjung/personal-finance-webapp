// @ts-check
// 集合定義與「欄位白名單」（B2）：新增/更新資料時，只接受這裡列出的欄位，
// 其餘（含企圖覆寫 id）一律剝掉——後端不再照單全收前端送來的東西（安全地圖 B2）。
// ⚠️ 同步點：前端表單「新增欄位」時必須把欄位名補進來，否則寫入會被默默剝掉
//（伺服器會在 console 警告被剝掉的欄位名，方便發現）。

/** 可自由增刪改的集合（通用 CRUD 開放）。 */
export const COLLECTIONS = ['accounts', 'assetTargets', 'transactions', 'subscriptions', 'insurance', 'cards', 'history',
  'holdings', 'watchlist', 'research'];

/** 只由 /snapshot、/ib/sync 寫入，前端唯讀 → 僅提供 GET。 */
export const READONLY_COLLECTIONS = ['portfolioSnapshots', 'ibTrades'];

/** 各集合允許寫入的欄位（依前端表單與匯入流程盤點，2026-07-13）。 @type {Record<string, string[]>} */
export const WRITABLE_FIELDS = {
  accounts: ['name', 'type', 'class', 'currency', 'balance', 'ibCashCur'],
  assetTargets: ['class', 'targetPct'],
  transactions: ['date', 'type', 'category', 'subcategory', 'amount', 'account', 'note',
    'stmtRef', 'storeKey', 'source', 'importBatch', 'importedAt'],
  subscriptions: ['name', 'category', 'amount', 'cycle', 'card', 'email', 'status', 'active',
    'nextCharge', 'endsOn', 'expiryDate', 'since', 'order', 'considerCancel'],
  insurance: ['policyName', 'insurer', 'policyholder', 'insured', 'beneficiary', 'coverage',
    'cashValue', 'premium', 'premiumCycle', 'nextPayment', 'startDate', 'endDate'],
  cards: ['name', 'type', 'issuer', 'network', 'lastFour', 'level', 'memberId',
    'statementDay', 'dueDay', 'annualFee', 'expiry', 'benefits', 'note', 'pdfPassword'],
  history: ['month', 'amount'],
  holdings: ['symbol', 'name', 'layer', 'currency', 'quantity', 'price', 'avgCost', 'cost', 'quoteSymbol', 'source'],
  watchlist: ['symbol', 'name', 'targetPrice', 'currency', 'quoteSymbol', 'note', 'lastPrice', 'lastAt'],
  research: ['symbol', 'thesis', 'metrics', 'risks', 'checkpoints']
};

/**
 * 過濾出白名單內的欄位；剝掉的欄位名列在 console 警告（幫忙抓「忘了進白名單」）。
 * @param {string} col @param {Record<string, any>} body @returns {Record<string, any>}
 */
export function pickWritable(col, body) {
  const allow = WRITABLE_FIELDS[col];
  if (!allow || !body || typeof body !== 'object') return {};
  /** @type {Record<string, any>} */
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(body)) {
    if (allow.includes(k)) out[k] = v;
    else dropped.push(k);
  }
  if (dropped.length) console.warn(`[schema] ${col} 寫入剝掉了白名單外的欄位：${dropped.join(', ')}（若是新功能欄位，記得補進 lib/schema.js）`);
  return out;
}

// ---- settings 白名單＋型別驗證（Codex 兩輪：不只擋未知欄位，也擋錯型別）----
// 頂層純量欄位的型別（依前端 settings.js／portfolio.js 的 PUT payload 盤點，2026-07-13）。
// 只收對的型別——數值欄位收 finite number、字串欄位收 string。錯型別會讓 derive 的
// Number(s.usdTwd||32) 變 NaN、污染 netWorth/槓桿等核心計算（Codex 高severity 實測）。
/** @type {Record<string, 'number'|'string'>} */
export const SETTINGS_FIELD_TYPES = {
  currency: 'string', usdTwd: 'number', emergencyFundMonths: 'number', allocationDriftPct: 'number',
  ibConcentrationPct: 'number', equityCapPct: 'number', countryCapPct: 'number', chinaCapPct: 'number',
  levCapPct: 'number', ibMaintenancePct: 'number', ibIdleCashAlert: 'number', qqqmMaxPct: 'number',
  capeManual: 'string', fxHigh: 'number', fxLow: 'number'
};
// ib 底下只有這兩個由前端寫（字串）；lastEquity／income／lastSync 是 IB 同步「擁有」的內部資料，
// 前端不可覆寫（否則能偽造官方淨值→影響槓桿/斷頭距離/提醒）。匯入備份時可保留（見 allowIbSyncFields）。
export const IB_WRITABLE_FIELDS = ['flexToken', 'flexQueryId'];
// 估值訊號的手動輸入（字串，區域市場每月手動更新）。
export const SIGNALS_WRITABLE_FIELDS = ['realYieldManual', 'china', 'japan', 'korea', 'taiwanPE', 'taiwanYield'];

const isNum = (/** @type {any} */ v) => typeof v === 'number' && isFinite(v);
const isObj = (/** @type {any} */ v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * settings 白名單＋型別過濾。只保留「名稱在白名單、且型別正確」的欄位；其餘剝掉（console 警告）。
 * PUT /api/settings 用預設（不含 IB 同步欄位）；/api/import 用 allowIbSyncFields:true 以保留備份的
 * lastEquity/income/lastSync（仍驗型別：物件或 null、字串或 null）。
 * @param {Record<string, any>} input
 * @param {{allowIbSyncFields?: boolean}} [opts]
 * @returns {Record<string, any>}
 */
export function sanitizeSettings(input, opts = {}) {
  if (!isObj(input)) return {};
  const allowIbSyncFields = opts.allowIbSyncFields || false;
  /** @type {Record<string, any>} */
  const out = {};
  const dropped = [];
  // 頂層純量：名稱在表、型別對
  for (const [k, v] of Object.entries(input)) {
    if (k === 'signals' || k === 'fxTwd' || k === 'ib') continue;   // 巢狀，下面處理
    const kind = SETTINGS_FIELD_TYPES[k];
    if (kind && (kind === 'number' ? isNum(v) : typeof v === 'string')) out[k] = v;
    else dropped.push('settings.' + k);
  }
  // signals：白名單內、字串
  if (isObj(input.signals)) {
    /** @type {Record<string, any>} */
    const sig = {};
    for (const [k, v] of Object.entries(input.signals)) {
      if (SIGNALS_WRITABLE_FIELDS.includes(k) && typeof v === 'string') sig[k] = v; else dropped.push('signals.' + k);
    }
    out.signals = sig;
  }
  // fxTwd：幣別→匯率 map，只收數值
  if (isObj(input.fxTwd)) {
    /** @type {Record<string, any>} */
    const fx = {};
    for (const [cur, rate] of Object.entries(input.fxTwd)) {
      if (isNum(rate)) fx[cur] = rate; else dropped.push('fxTwd.' + cur);
    }
    out.fxTwd = fx;
  }
  // ib：前端只 flexToken/flexQueryId（字串）；匯入另可保留 IB 同步欄位（驗型別）
  if (isObj(input.ib)) {
    /** @type {Record<string, any>} */
    const ib = {};
    for (const f of IB_WRITABLE_FIELDS) if (typeof input.ib[f] === 'string') ib[f] = input.ib[f];
    if (allowIbSyncFields) {
      if ('lastSync' in input.ib && (input.ib.lastSync === null || typeof input.ib.lastSync === 'string')) ib.lastSync = input.ib.lastSync;
      if ('lastEquity' in input.ib && (input.ib.lastEquity === null || isObj(input.ib.lastEquity))) ib.lastEquity = input.ib.lastEquity;
      if ('income' in input.ib && (input.ib.income === null || isObj(input.ib.income))) ib.income = input.ib.income;
    }
    out.ib = ib;
  }
  if (dropped.length) console.warn(`[schema] settings 剝掉名稱/型別不符的欄位：${dropped.join(', ')}（IB 同步欄位 lastEquity/income/lastSync 前端本就不可寫）`);
  return out;
}
