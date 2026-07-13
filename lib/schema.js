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

// ---- settings 白名單（Codex #B2-follow：/api/settings 一樣不照單全收）----
// 前端可寫的 settings 頂層欄位（依前端 settings.js／portfolio.js 的 PUT payload 盤點，2026-07-13）。
// signals／fxTwd／ib 為巢狀，另外處理（見 pickSettingsWritable）。
export const SETTINGS_WRITABLE_FIELDS = ['currency', 'usdTwd', 'emergencyFundMonths', 'allocationDriftPct',
  'ibConcentrationPct', 'equityCapPct', 'countryCapPct', 'chinaCapPct', 'levCapPct', 'ibMaintenancePct',
  'ibIdleCashAlert', 'qqqmMaxPct', 'capeManual', 'fxHigh', 'fxLow'];
// ib 底下只有這兩個由前端寫；lastEquity／income／lastSync 是 IB 同步「擁有」的內部資料，
// 只讓 lib/services/ib-sync.js 寫，前端不可覆寫（否則能偽造官方淨值→影響槓桿/斷頭距離/提醒）。
export const IB_WRITABLE_FIELDS = ['flexToken', 'flexQueryId'];
// 估值訊號的手動輸入（區域市場每月手動更新）。
export const SIGNALS_WRITABLE_FIELDS = ['realYieldManual', 'china', 'japan', 'korea', 'taiwanPE', 'taiwanYield'];

/**
 * settings 專用白名單過濾：頂層純量、signals、ib 各自白名單；fxTwd 是「幣別→匯率」map、只收數值項。
 * @param {Record<string, any>} patch @returns {Record<string, any>}
 */
export function pickSettingsWritable(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  /** @type {Record<string, any>} */
  const out = {};
  const dropped = [];
  const isObj = (/** @type {any} */ v) => v && typeof v === 'object' && !Array.isArray(v);
  /** @param {Record<string, any>} src @param {string[]} allow @param {string} prefix */
  const sub = (src, allow, prefix) => {
    /** @type {Record<string, any>} */
    const o = {};
    for (const [k, v] of Object.entries(src)) { if (allow.includes(k)) o[k] = v; else dropped.push(prefix + k); }
    return o;
  };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'signals' || k === 'fxTwd' || k === 'ib') continue;   // 巢狀，下面處理
    if (SETTINGS_WRITABLE_FIELDS.includes(k)) out[k] = v; else dropped.push('settings.' + k);
  }
  if (isObj(patch.signals)) out.signals = sub(patch.signals, SIGNALS_WRITABLE_FIELDS, 'signals.');
  if (isObj(patch.ib)) out.ib = sub(patch.ib, IB_WRITABLE_FIELDS, 'ib.');
  if (isObj(patch.fxTwd)) {
    /** @type {Record<string, any>} */
    const fx = {};
    for (const [cur, rate] of Object.entries(patch.fxTwd)) {
      if (typeof rate === 'number' && isFinite(rate)) fx[cur] = rate; else dropped.push('fxTwd.' + cur);
    }
    out.fxTwd = fx;
  }
  if (dropped.length) console.warn(`[schema] settings 寫入剝掉了白名單外的欄位：${dropped.join(', ')}（IB 同步欄位 lastEquity/income/lastSync 本就只由後端寫）`);
  return out;
}
