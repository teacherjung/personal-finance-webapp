// @ts-check
// 集合定義、欄位白名單、與「型別驗證」（B2＋Codex 三輪）：
// 新增/更新/匯入資料時，只接受白名單內的欄位，且數值欄位必須是數字——
// 否則像 holdings.price:'oops' 會讓 derive 的 Number() 變 NaN、污染 netWorth/槓桿（顯示 null）。
// ⚠️ 同步點：前端表單新增欄位→補進 WRITABLE_FIELDS；新增數值欄位→同時補進 NUMERIC_FIELDS。
//（伺服器會在 console 警告被剝掉的欄位名，方便發現漏加。）

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

// 各集合的「數值欄位」——這些欄位餵給 derive 的 Number() 計算，必須是 finite number（或 null＝清空），
// 錯型別（'oops'）會 NaN 污染核心計算。其餘欄位（字串/布林/陣列）不 NaN，維持寬鬆。
/** @type {Record<string, string[]>} */
export const NUMERIC_FIELDS = {
  accounts: ['balance'],
  assetTargets: ['targetPct'],
  transactions: ['amount'],
  subscriptions: ['amount', 'order'],
  insurance: ['premium', 'cashValue'],
  cards: ['statementDay', 'dueDay', 'annualFee'],
  history: ['amount'],
  holdings: ['quantity', 'price', 'avgCost', 'cost'],
  watchlist: ['targetPrice', 'lastPrice'],
  research: []
};

const isNum = (/** @type {any} */ v) => typeof v === 'number' && isFinite(v);
const isObj = (/** @type {any} */ v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * 數值欄位驗證：接受 finite number、null（清空，openForm 空白時送 null）、或數字字串（轉成 number）；
 * 其餘（'oops'、NaN、空字串）視為不合法。 @param {any} v @returns {{ok: boolean, value?: any}}
 */
function coerceNum(v) {
  if (v === null) return { ok: true, value: null };
  if (typeof v === 'number') return isFinite(v) ? { ok: true, value: v } : { ok: false };
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return { ok: true, value: Number(v) };
  return { ok: false };
}

// 估值訊號的手動輸入（openForm number 欄位→送 number 或 null；預設值為空字串）——
// 接受 null／空字串／finite number／數字字串，擋掉 'oops'（capeManual 會餵 Number() 算 ECY）。
const okManual = (/** @type {any} */ v) => v === null || v === '' || isNum(v)
  || (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)));

/**
 * 通用 CRUD 白名單＋數值型別過濾。只保留白名單內的欄位；數值欄位驗證型別（壞值剝掉、保留原值）。
 * @param {string} col @param {Record<string, any>} body @returns {Record<string, any>}
 */
export function pickWritable(col, body) {
  const allow = WRITABLE_FIELDS[col];
  if (!allow || !isObj(body)) return {};
  const numeric = NUMERIC_FIELDS[col] || [];
  /** @type {Record<string, any>} */
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(body)) {
    if (!allow.includes(k)) { dropped.push(k); continue; }
    if (numeric.includes(k)) {
      const r = coerceNum(v);
      if (r.ok) out[k] = r.value; else dropped.push(`${k}(型別)`);
    } else {
      out[k] = v;
    }
  }
  if (dropped.length) console.warn(`[schema] ${col} 寫入剝掉了白名單外/型別不符的欄位：${dropped.join(', ')}（若是新功能欄位，記得補進 lib/schema.js）`);
  return out;
}

/**
 * 匯入用：只驗「數值欄位」型別（壞值剝掉→由 derive 的 ||0 接手，不 NaN），其餘欄位（含 id、字串）原樣保留。
 * 與 pickWritable 的差別：匯入是「還原完整物件」，要保留 id/stmtRef 等，不做白名單剝除。
 * @param {string} col @param {any} item @returns {any}
 */
export function sanitizeItem(col, item) {
  const numeric = NUMERIC_FIELDS[col];
  if (!isObj(item) || !numeric || !numeric.length) return item;
  const out = { ...item };
  for (const k of numeric) {
    if (k in out) {
      const r = coerceNum(out[k]);
      if (r.ok) out[k] = r.value; else delete out[k];   // 壞值剝掉，讓既有/預設接手
    }
  }
  return out;
}

// ---- settings 白名單＋型別驗證（Codex 三輪：擋未知欄位、擋錯型別、擋 IB 同步欄位內層壞值）----
// 頂層欄位型別：number＝finite number；string＝字串；manual＝估值手動輸入（數字/空/數字字串）。
// 錯型別會讓 derive 的 Number(s.usdTwd||32) 變 NaN、污染核心計算（Codex 高severity 實測）。
/** @type {Record<string, 'number'|'string'|'manual'>} */
export const SETTINGS_FIELD_TYPES = {
  currency: 'string', usdTwd: 'number', emergencyFundMonths: 'number', allocationDriftPct: 'number',
  ibConcentrationPct: 'number', equityCapPct: 'number', countryCapPct: 'number', chinaCapPct: 'number',
  levCapPct: 'number', ibMaintenancePct: 'number', ibIdleCashAlert: 'number', qqqmMaxPct: 'number',
  capeManual: 'manual', fxHigh: 'number', fxLow: 'number'
};
// ib 底下只有這兩個由前端寫（字串）；lastEquity／income／lastSync 是 IB 同步「擁有」的內部資料，
// 前端不可覆寫（否則能偽造官方淨值→影響槓桿/斷頭距離/提醒）。匯入備份時可保留（見 allowIbSyncFields）。
export const IB_WRITABLE_FIELDS = ['flexToken', 'flexQueryId'];
// 估值訊號的手動輸入（前端 openForm number 欄位，送 number 或 null）。
export const SIGNALS_WRITABLE_FIELDS = ['realYieldManual', 'china', 'japan', 'korea', 'taiwanPE', 'taiwanYield'];

/**
 * settings 白名單＋型別過濾。只保留「名稱在白名單、且型別正確」的欄位；其餘剝掉（console 警告）。
 * PUT /api/settings 用預設（不含 IB 同步欄位）；/api/import 用 allowIbSyncFields:true 保留備份的
 * lastEquity/income/lastSync——但深層驗型別：lastEquity.stock/cash 必須是數字，否則整個 lastEquity
 * 丟棄讓 computeLeverage 走 fallback（安全）；income 的數值欄位逐一驗、estimatedCurrencies 須陣列。
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
  // 頂層：number／string／manual
  for (const [k, v] of Object.entries(input)) {
    if (k === 'signals' || k === 'fxTwd' || k === 'ib') continue;   // 巢狀，下面處理
    const kind = SETTINGS_FIELD_TYPES[k];
    const ok = kind === 'number' ? isNum(v) : kind === 'string' ? typeof v === 'string' : kind === 'manual' ? okManual(v) : false;
    if (ok) out[k] = v; else dropped.push('settings.' + k);
  }
  // signals：白名單內、估值手動輸入型別
  if (isObj(input.signals)) {
    /** @type {Record<string, any>} */
    const sig = {};
    for (const [k, v] of Object.entries(input.signals)) {
      if (SIGNALS_WRITABLE_FIELDS.includes(k) && okManual(v)) sig[k] = v; else dropped.push('signals.' + k);
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
  // ib：前端只 flexToken/flexQueryId（字串）；匯入另可保留 IB 同步欄位（深層驗型別）
  if (isObj(input.ib)) {
    /** @type {Record<string, any>} */
    const ib = {};
    for (const f of IB_WRITABLE_FIELDS) if (typeof input.ib[f] === 'string') ib[f] = input.ib[f];
    if (allowIbSyncFields) {
      if ('lastSync' in input.ib && (input.ib.lastSync === null || typeof input.ib.lastSync === 'string')) ib.lastSync = input.ib.lastSync;
      if ('lastEquity' in input.ib) {
        const le = input.ib.lastEquity;
        // 深層驗證：stock/cash 必須是數字（date 若有須字串）。不合法→丟棄整個 lastEquity，
        // computeLeverage 改走 fallback 自算（看得見的安全退化，勝過用壞值低估槓桿風險）。
        if (le === null) ib.lastEquity = null;
        else if (isObj(le) && isNum(le.stock) && isNum(le.cash) && (le.date === undefined || typeof le.date === 'string')) ib.lastEquity = le;
        else dropped.push('ib.lastEquity(內層型別)');
      }
      if ('income' in input.ib) {
        const inc = input.ib.income;
        if (inc === null) ib.income = null;
        else if (isObj(inc)) {
          const clean = { ...inc };   // 逐一剝掉非數字的數值欄位、非陣列的 estimatedCurrencies
          for (const nf of ['dividends', 'paymentInLieu', 'withholdingTax', 'interestPaid', 'interestReceived', 'other', 'count', 'skippedNoFx', 'estimatedNoFx']) {
            if (nf in clean && !isNum(clean[nf])) { delete clean[nf]; dropped.push('ib.income.' + nf); }
          }
          if ('estimatedCurrencies' in clean && !Array.isArray(clean.estimatedCurrencies)) { delete clean.estimatedCurrencies; dropped.push('ib.income.estimatedCurrencies'); }
          ib.income = clean;
        } else dropped.push('ib.income(型別)');
      }
    }
    out.ib = ib;
  }
  if (dropped.length) console.warn(`[schema] settings 剝掉名稱/型別不符的欄位：${dropped.join(', ')}（IB 同步欄位 lastEquity/income/lastSync 前端本就不可寫）`);
  return out;
}
