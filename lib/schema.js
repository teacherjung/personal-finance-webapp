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
