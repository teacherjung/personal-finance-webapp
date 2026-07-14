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

// 系統實際支援的幣別（lib/derive.js fxRates 只認這四種；其餘會 fallback 到 USD 匯率而算錯）。
export const CURRENCIES = ['TWD', 'USD', 'GBP', 'JPY'];

/** 各集合允許寫入的欄位（依前端表單與匯入流程盤點，2026-07-13）。 @type {Record<string, string[]>} */
export const WRITABLE_FIELDS = {
  // ibCashCur 移除（Codex#6-3）：它是 IB 同步「擁有」的欄位（標記帳戶為 IB 現金/融資），
  // 前端表單不送、只由 lib/services/ib-sync.js 寫。放行會讓人手動塞非 IB 帳戶偽裝成 IB 融資、污染槓桿。
  accounts: ['name', 'type', 'class', 'currency', 'balance'],
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
  // source 移除（Codex#6-2）：source==='ib' 決定槓桿計算，是 IB 同步擁有的欄位。前端表單不送，
  // 放行會讓 source:'ibx' 之類把 IB 持股偽裝成非 IB、把融資風險藏掉。
  holdings: ['symbol', 'name', 'layer', 'currency', 'quantity', 'price', 'avgCost', 'cost', 'quoteSymbol'],
  watchlist: ['symbol', 'name', 'targetPrice', 'currency', 'quoteSymbol', 'note', 'lastPrice', 'lastAt'],
  research: ['symbol', 'thesis', 'metrics', 'risks', 'checkpoints']
};

// 各集合「非自由字串」欄位的型別（其餘欄位＝自由字串，寬鬆放行）。這些是會影響 derive 計算的欄位，
// 錯型別會 NaN 污染（數值）或算錯月費/停用（布林/枚舉）。值＝'number'｜'boolean'｜'array'｜string[]（枚舉合法值）。
// ⚠️ 註：transactions.type 刻意不設枚舉——除 income/expense 外還有「轉帳等其他型別」，cashflow 已安全忽略（derive.js）。
/** @type {Record<string, Record<string, 'number'|'boolean'|'array'|string[]>>} */
export const FIELD_SCHEMA = {
  // accounts.type 是枚舉：錯值（'mortgagex'）會讓負債被當資產、淨資產方向相反（Codex 高severity）。
  // 合法值＝表單 ACCOUNT_TYPES ∪ derive 的 LIABILITY_TYPES（涵蓋 IB/舊資料），確保合法資料不被誤拒。
  // currency 是枚舉（Codex#6-1）：錯幣別（'TWDx'）在 derive 會 fallback 到 USD 匯率、把 100 TWD 算成 3200。
  // ibCashCur 也驗幣別（雖已從 CRUD 白名單移除，匯入仍會保留、需擋壞值）。
  accounts: { balance: 'number', currency: CURRENCIES, ibCashCur: CURRENCIES, type: ['cash', 'investment', 'property', 'insurance-cv', 'other', 'mortgage', 'loan', 'liability', 'creditcard'] },
  assetTargets: { targetPct: 'number' },
  transactions: { amount: 'number' },
  subscriptions: {
    amount: 'number', order: 'number', active: 'boolean', considerCancel: 'boolean',
    cycle: ['monthly', 'quarterly', 'semiannual', 'yearly', 'lifetime'], status: ['active', 'ending', 'ended']
  },
  insurance: { premium: 'number', cashValue: 'number', premiumCycle: ['yearly', 'semiannual', 'quarterly', 'monthly', 'single'] },
  cards: { statementDay: 'number', dueDay: 'number', annualFee: 'number', type: ['credit', 'membership'] },
  history: { amount: 'number' },
  // layer 枚舉：錯值會讓個股逃過「單一個股上限」等集中度守門（生存守則）。
  // source 枚舉（Codex#6-2）：source==='ib' 決定融資槓桿，'ibx' 會把 IB 持股藏起來、隱藏融資風險。
  holdings: { quantity: 'number', price: 'number', avgCost: 'number', cost: 'number', currency: CURRENCIES, source: ['ib', 'manual'], layer: ['core', 'satellite', 'stock', 'bond', 'gold'] },
  watchlist: { targetPrice: 'number', lastPrice: 'number', currency: CURRENCIES },
  research: { checkpoints: 'array' }
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

/**
 * 依欄位型別驗證/轉換一個值。回傳 { ok, value?, reject? }：
 * ok＝合法（value＝清理後值）；ok:false＋reject:true＝必須拒絕（枚舉/布林非法值，剝掉會留下危險預設）；
 * ok:false＋reject:false＝可安全剝掉（數值壞值→預設 0；非陣列→預設 []）。
 * @param {'number'|'boolean'|'array'|string[]|undefined} spec @param {any} v
 * @returns {{ok: boolean, value?: any, reject?: boolean}}
 */
function validateField(spec, v) {
  if (spec === undefined) return { ok: true, value: v };                 // 自由字串：放行
  if (Array.isArray(spec)) {                                             // 枚舉：非法→拒絕（剝掉會落到危險預設，如 cycle→月繳、type→資產）
    return (typeof v === 'string' && spec.includes(v)) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'number') { const r = coerceNum(v); return r.ok ? r : { ok: false, reject: false }; }   // 數值壞值→安全剝掉（→0）
  if (spec === 'boolean') {                                             // 布林：擋 'false' 字串被當 truthy；非法→拒絕
    if (typeof v === 'boolean') return { ok: true, value: v };
    if (v === 'true') return { ok: true, value: true };
    if (v === 'false') return { ok: true, value: false };
    return { ok: false, reject: true };
  }
  if (spec === 'array') {                                               // 非陣列→安全剝掉（→[]）；陣列→過濾掉非物件元素（擋 [null] 讓讀取端崩）
    return Array.isArray(v) ? { ok: true, value: v.filter(isObj) } : { ok: false, reject: false };
  }
  return { ok: true, value: v };
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
  if (!allow || !isObj(body)) return { value: {}, errors: [] };
  const schema = FIELD_SCHEMA[col] || {};
  /** @type {Record<string, any>} */
  const out = {};
  const dropped = [];
  /** @type {string[]} */
  const errors = [];
  for (const [k, v] of Object.entries(body)) {
    if (!allow.includes(k)) { dropped.push(k); continue; }
    const r = validateField(schema[k], v);
    if (r.ok) out[k] = r.value;
    else if (r.reject) errors.push(k);       // 枚舉/布林非法：呼叫端回 400（不可靜默落到危險預設）
    else dropped.push(`${k}(型別)`);          // 數值/陣列壞值：安全剝掉
  }
  if (dropped.length) console.warn(`[schema] ${col} 寫入剝掉了白名單外/型別不符的欄位：${dropped.join(', ')}（若是新功能欄位，記得補進 lib/schema.js）`);
  return { value: out, errors };
}

/**
 * 匯入用：驗一筆資料。回傳 { item, errors }——item＝清理後物件（數值/陣列壞值剝掉、陣列過濾壞元素，
 * 其餘含 id 原樣保留）；非物件回 item:null（呼叫端過濾）；errors＝枚舉/布林非法欄位（呼叫端拒絕整份匯入）。
 * @param {string} col @param {any} item @returns {{item: any|null, errors: string[]}}
 */
export function validateImportItem(col, item) {
  if (!isObj(item)) return { item: null, errors: [] };
  const schema = FIELD_SCHEMA[col];
  if (!schema) return { item, errors: [] };
  const out = { ...item };
  /** @type {string[]} */
  const errors = [];
  for (const [k, spec] of Object.entries(schema)) {
    if (!(k in out)) continue;
    const r = validateField(spec, out[k]);
    if (r.ok) out[k] = r.value;
    else if (r.reject) errors.push(k);
    else delete out[k];
  }
  return { item: out, errors };
}

/**
 * 匯入用：清理 learnedCategories map（value 非物件就丟棄；category/subcategory/name 非字串就丟該鍵）。
 * 避免 { bad: null } 讓設定頁讀 v.name 崩。 @param {any} lc @returns {Record<string, any>}
 */
export function sanitizeLearned(lc) {
  if (!isObj(lc)) return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, v] of Object.entries(lc)) {
    if (!isObj(v)) continue;
    /** @type {Record<string, any>} */
    const e = {};
    for (const f of ['category', 'subcategory', 'name']) if (typeof v[f] === 'string') e[f] = v[f];
    out[key] = e;
  }
  return out;
}

// ---- settings 白名單＋型別驗證（Codex 三輪：擋未知欄位、擋錯型別、擋 IB 同步欄位內層壞值）----
// 頂層欄位型別：number＝finite number；string＝字串；manual＝估值手動輸入（數字/空/數字字串）。
// 錯型別會讓 derive 的 Number(s.usdTwd||32) 變 NaN、污染核心計算（Codex 高severity 實測）。
// posnum＝必須為正數（Codex#6-4）：匯率/門檻是「乘數」，負數或 0 會讓資產變負或除以 0。
/** @type {Record<string, 'number'|'posnum'|'string'|'manual'>} */
export const SETTINGS_FIELD_TYPES = {
  currency: 'string', usdTwd: 'posnum', emergencyFundMonths: 'number', allocationDriftPct: 'number',
  ibConcentrationPct: 'number', equityCapPct: 'number', countryCapPct: 'number', chinaCapPct: 'number',
  levCapPct: 'number', ibMaintenancePct: 'number', ibIdleCashAlert: 'number', qqqmMaxPct: 'number',
  capeManual: 'manual', fxHigh: 'posnum', fxLow: 'posnum'
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
    const ok = kind === 'number' ? isNum(v) : kind === 'posnum' ? (isNum(v) && v > 0)
      : kind === 'string' ? typeof v === 'string' : kind === 'manual' ? okManual(v) : false;
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
  // fxTwd：幣別→匯率 map，只收「正數」匯率（Codex#6-4：負匯率會讓外幣資產變負、竄改負債）
  if (isObj(input.fxTwd)) {
    /** @type {Record<string, any>} */
    const fx = {};
    for (const [cur, rate] of Object.entries(input.fxTwd)) {
      if (isNum(rate) && rate > 0) fx[cur] = rate; else dropped.push('fxTwd.' + cur);
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
