// @ts-check
// 集合定義、欄位白名單、與「型別驗證」（B2＋Codex 三輪）：
// 新增/更新/匯入資料時，只接受白名單內的欄位，且數值欄位必須是數字——
// 否則像 holdings.price:'oops' 會讓 derive 的 Number() 變 NaN、污染 netWorth/槓桿（顯示 null）。
// ⚠️ 同步點：前端表單新增欄位→補進 WRITABLE_FIELDS；新增數值欄位→同時補進 NUMERIC_FIELDS。
//（伺服器會在 console 警告被剝掉的欄位名，方便發現漏加。）

import { sanitizeStoreRules } from './store-rules.js';
import { emptyMap, isProtoKey } from './safe-map.js';

/** 可自由增刪改的集合（通用 CRUD 開放）。 */
export const COLLECTIONS = ['accounts', 'assetTargets', 'transactions', 'subscriptions', 'insurance', 'cards', 'history',
  'holdings', 'watchlist', 'research'];

/** 只由 /snapshot、/ib/sync 寫入，前端唯讀 → 僅提供 GET。 */
export const READONLY_COLLECTIONS = ['portfolioSnapshots', 'ibTrades', 'dailyValues'];

// 系統實際支援的幣別（lib/derive.js fxRates 只認這四種；其餘會 fallback 到 USD 匯率而算錯）。
export const CURRENCIES = ['TWD', 'USD', 'GBP', 'JPY'];

/** 各集合允許寫入的欄位（依前端表單與匯入流程盤點，2026-07-13）。 @type {Record<string, string[]>} */
export const WRITABLE_FIELDS = {
  // ibCashCur 移除（Codex#6-3）：它是 IB 同步「擁有」的欄位（標記帳戶為 IB 現金/融資），
  // 前端表單不送、只由 lib/services/ib-sync.js 寫。放行會讓人手動塞非 IB 帳戶偽裝成 IB 融資、污染槓桿。
  accounts: ['name', 'type', 'class', 'currency', 'balance'],
  assetTargets: ['class', 'targetPct'],
  // autoCat/autoSub＝匯入當下的「完整自動判斷」（第二帖，2026-07-19）：留底才能日後精確分辨
  // 「這個分類是人改的還是舊規則判的」（體檢的分類漂移偵測靠它）。**不在 CRUD 白名單**
  // （r2-Codex#8）：它們是匯入服務層「擁有」的欄位，前端可寫的話留底就失真、D4 判斷跟著失準；
  // 服務層直接 push＋saveDb 不經 pickWritable，照樣寫得進去，型別由 FIELD_SCHEMA 驗。
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
// 型別代碼：number｜boolean｜array｜str（必須是字串）｜date（YYYY-MM-DD 或空）｜month（YYYY-MM 或空）
//          ｜monthreq／datereq（必填版，空值也算壞資料）｜string[]（枚舉）。
// str/date/month（自審 r2，高）：這些欄位在 derive 會被 .slice()/.toUpperCase()/monthKey() 處理——
// 塞成數字會讓 buildSummary 永久崩潰（例：endsOn:20991231 → endsOn.slice is not a function 炸掉總覽）、
// 壞格式日期會讓該筆默默不被計入月現金流。非法值＝拒絕（400/tripwire），不剝除（剝掉會默默改變語意）。
/** @type {Record<string, Record<string, 'number'|'boolean'|'array'|'str'|'date'|'month'|'monthreq'|'datereq'|string[]>>} */
export const FIELD_SCHEMA = {
  // accounts.type 是枚舉：錯值（'mortgagex'）會讓負債被當資產、淨資產方向相反（Codex 高severity）。
  // 合法值＝表單 ACCOUNT_TYPES ∪ derive 的 LIABILITY_TYPES（涵蓋 IB/舊資料），確保合法資料不被誤拒。
  // currency 是枚舉（Codex#6-1）：錯幣別（'TWDx'）在 derive 會 fallback 到 USD 匯率、把 100 TWD 算成 3200。
  // ibCashCur 也驗幣別（雖已從 CRUD 白名單移除，匯入仍會保留、需擋壞值）。
  accounts: { balance: 'number', currency: CURRENCIES, ibCashCur: CURRENCIES, type: ['cash', 'investment', 'property', 'insurance-cv', 'other', 'mortgage', 'loan', 'liability', 'creditcard'] },
  assetTargets: { targetPct: 'number' },
  transactions: { amount: 'number', date: 'date', autoCat: 'str', autoSub: 'str', stmtMonth: 'month', stmtDue: 'number' },   // autoCat/autoSub/stmtMonth/stmtDue 由匯入服務層寫（非 CRUD），仍須驗型別（r2-Codex#8）
  subscriptions: {
    amount: 'number', order: 'number', active: 'boolean', considerCancel: 'boolean',
    nextCharge: 'date', endsOn: 'date', expiryDate: 'date', since: 'month',
    cycle: ['monthly', 'quarterly', 'semiannual', 'yearly', 'lifetime'], status: ['active', 'ending', 'ended']
  },
  insurance: { premium: 'number', cashValue: 'number', nextPayment: 'date', startDate: 'date', endDate: 'date',
    premiumCycle: ['yearly', 'semiannual', 'quarterly', 'monthly', 'single'] },
  cards: { statementDay: 'number', dueDay: 'number', annualFee: 'number', expiry: 'str', type: ['credit', 'membership'] },   // expiry 只驗「須為字串」（格式寬鬆相容舊資料；數字會讓 cards 頁 .slice 崩，Codex#10-1）
  history: { amount: 'number', month: 'monthreq' },   // 必填：history 頁以 month 為主鍵做 .slice/.startsWith（Codex#10-2）
  // layer 枚舉：錯值會讓個股逃過「單一個股上限」等集中度守門（生存守則）。
  // source 枚舉（Codex#6-2）：source==='ib' 決定融資槓桿，'ibx' 會把 IB 持股藏起來、隱藏融資風險。
  holdings: { symbol: 'str', quantity: 'number', price: 'number', avgCost: 'number', cost: 'number', currency: CURRENCIES, source: ['ib', 'manual'], layer: ['core', 'satellite', 'stock', 'bond', 'gold'] },
  watchlist: { symbol: 'str', targetPrice: 'number', lastPrice: 'number', currency: CURRENCIES },
  research: { symbol: 'str', checkpoints: 'array' },
  // 唯讀集合也要有內層規格（Codex#10-3）：雖只由 snapshot/ib-sync 寫入，但匯入備份也會經過這裡——
  // 數字型 month/date 會讓投組頁 .split()/.localeCompare() 崩。ibTrades 來源是 XML（天生字串），寬鬆驗 str 即可。
  portfolioSnapshots: { month: 'monthreq', cost: 'number', value: 'number' },
  snapshots: { month: 'monthreq', date: 'date', netWorth: 'number', assets: 'number', liabilities: 'number' },
  // 日線（D0）：date 是主鍵欄（一天一行，同日覆寫），必填且必須是合法 YYYY-MM-DD——
  // 壞 date 會讓差異引擎的排序/「最接近的既有日」比對錯亂（比沒有資料更糟）。
  dailyValues: { date: 'datereq', netWorth: 'number', assets: 'number', liabilities: 'number',
    pfCost: 'number', pfValue: 'number', usdTwd: 'number', gbpTwd: 'number', jpyTwd: 'number' },
  ibTrades: { date: 'str', symbol: 'str' }
};

// 必填欄位（Codex#11-1）：monthreq 只驗「有傳進來的值」，欄位完全缺席會整個繞過——
// 而 month 是這三個集合的主鍵欄，缺了會讓 history 頁 .slice、投組頁 .split、快照排序全崩。
// 強制點：CRUD 新增（400）、匯入逐筆（400）、櫃檯寫入牆（throw/strip）。PUT 部分更新天然安全
//（pickWritable 只帶「有送的欄位」、updateItem 合併保留舊值，欄位不可能被「更新成缺席」）。
/** @type {Record<string, string[]>} */
export const REQUIRED_FIELDS = {
  history: ['month'],
  portfolioSnapshots: ['month'],
  snapshots: ['month'],
  dailyValues: ['date']
};
const missingRequired = (/** @type {string} */ col, /** @type {any} */ item) =>
  (REQUIRED_FIELDS[col] || []).filter(f => !(f in item) || item[f] === '' || item[f] == null);

// ---- 日期／月份的「真實日曆」驗證（Codex r3#9）----
// 長期以來只驗長相（\d{4}-\d{2}）：2026-13、2026-99-99、2026-02-31 全都過得了關。
// 後果不是崩潰而是**默默算錯**——月份排序（localeCompare 把 2026-13 排在 2026-02 後面）、
// 提醒天數、費用攤提、日線的「找最接近的既有日」全會偏掉，而且看起來一切正常。
// 四種日期型別（date／datereq／month／monthreq）共用這一套判準，不可各寫一份。
export const isRealMonth = (/** @type {any} */ v) => {
  if (typeof v !== 'string') return false;
  const m = v.match(/^(\d{4})-(\d{2})$/);
  if (!m) return false;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12;
};
export const isRealDate = (/** @type {any} */ v) => {
  if (typeof v !== 'string') return false;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  // 用 UTC 建構再比對，避開本地時區在月初/月底的位移（這裡只驗「這個日子存不存在」）
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
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
 * @param {'number'|'boolean'|'array'|'str'|'date'|'month'|'monthreq'|'datereq'|string[]|undefined} spec @param {any} v
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
  if (spec === 'str') {                                                 // 必須是字串（null＝清空可）；數字代號會讓 .toUpperCase() 崩
    return (typeof v === 'string' || v === null) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'date') {                                                // YYYY-MM-DD 或空（未設）；null 矯正為 ''（Codex#10-2：讀取端 .slice/.startsWith 遇 null 會崩）
    if (v === null || v === '') return { ok: true, value: '' };
    return isRealDate(v) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'month') {                                               // YYYY-MM 或空；null 矯正為 ''
    if (v === null || v === '') return { ok: true, value: '' };
    return isRealMonth(v) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'monthreq') {                                            // 必填月份（history/快照的主鍵欄，空值也是壞資料）
    return isRealMonth(v) ? { ok: true, value: v } : { ok: false, reject: true };
  }
  if (spec === 'datereq') {                                             // 必填日期（日線的主鍵欄，空值/壞格式都是壞資料）
    return isRealDate(v) ? { ok: true, value: v } : { ok: false, reject: true };
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
  for (const f of missingRequired(col, out)) errors.push(`${f}(缺必填)`);
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
  if (!isObj(lc)) return emptyMap();
  // null prototype ＋ 丟掉原型名的鍵（Codex r4#1）：這裡是學習表進出資料庫的必經之路，
  // 在這裡擋住，既有資料被污染過也會在下次寫入時清乾淨。
  const out = emptyMap();
  for (const [key, v] of Object.entries(lc)) {
    if (isProtoKey(key)) { console.warn(`[schema] 學習表丟棄保留字 key：${key}`); continue; }
    if (!isObj(v)) continue;
    /** @type {Record<string, any>} */
    const e = {};
    for (const f of ['category', 'subcategory', 'name']) if (typeof v[f] === 'string') e[f] = v[f];
    out[key] = e;
  }
  return out;
}

// ---- 櫃檯級整包驗證（B3「驗證入櫃檯」：唯一寫入口 store.save() 每次過這裡）----
// 七輪審查的病根＝「新寫入路徑繞過驗證牆」（CRUD→settings→匯入→IB 同步各補一次）。
// 結構性根治：把驗證裝在唯一的門上——任何路徑寫入都自動過牆，未來新程式想繞也繞不過。
// 兩種模式：'throw'（平時；枚舉/布林非法＝程式有 bug，當場炸出來讓考試抓）
//          'strip'（搬家/匯入舊資料；剝掉壞值＋大聲警告，不讓舊資料卡死系統）。

/** 全部集合（含無 FIELD_SCHEMA 的 snapshots——仍過「每筆須為物件」關）。 */
export const ALL_COLLECTIONS = [...COLLECTIONS, ...READONLY_COLLECTIONS, 'snapshots'];

/**
 * 寫入前驗證/清理整包資料庫物件。回傳清理後的新物件；結構性錯誤（不是物件、集合不是陣列）一律 throw。
 * @param {any} input
 * @param {{mode?: 'throw'|'strip'}} [opts]
 * @returns {Record<string, any>}
 */
export function sanitizeDbForWrite(input, opts = {}) {
  const mode = opts.mode || 'throw';
  if (!isObj(input) || !isObj(input.settings)) throw new Error('[schema] 寫入的不是合法資料庫物件（缺 settings）');
  /** @type {Record<string, any>} */
  const out = { ...input };
  /** @type {string[]} */
  const warns = [];
  for (const col of ALL_COLLECTIONS) {
    if (!(col in out)) continue;
    if (!Array.isArray(out[col])) throw new Error(`[schema] 集合 ${col} 必須是陣列（寫入端程式有誤）`);
    const schema = FIELD_SCHEMA[col];
    const cleaned = [];
    out[col].forEach((/** @type {any} */ item, /** @type {number} */ i) => {
      if (!isObj(item)) { warns.push(`${col}[${i}] 非物件已濾除`); return; }
      if (!schema) { cleaned.push(item); return; }
      const o = { ...item };
      const miss = missingRequired(col, o);
      if (miss.length) {
        if (mode === 'throw') throw new Error(`[schema] ${col}[${i}] 缺必填欄位 ${miss.join('/')}——寫入端漏了驗證，請修程式`);
        warns.push(`${col}[${i}] 缺必填 ${miss.join('/')} 已整筆濾除`);
        return;
      }
      const required = REQUIRED_FIELDS[col] || [];
      let dropItem = false;
      for (const [k, spec] of Object.entries(schema)) {
        if (!(k in o)) continue;
        const r = validateField(spec, o[k]);
        if (r.ok) { o[k] = r.value; continue; }
        if (r.reject && mode === 'throw') throw new Error(`[schema] ${col}[${i}].${k} 值不合法（${JSON.stringify(o[k])}）——寫入端漏了驗證，請修程式`);
        // 必填欄位格式不合法（Codex#12-1，高）：strip 模式不能只刪該欄位——會留下「缺主鍵」的壞筆
        //（month='bad' 或數字 month → 刪掉 month 後 history/投組/快照讀取端 .slice/.split 仍崩）。整筆濾除才安全。
        if (required.includes(k)) { warns.push(`${col}[${i}].${k} 必填值格式不合法（${JSON.stringify(o[k])}）已整筆濾除`); dropItem = true; break; }
        warns.push(`${col}[${i}].${k} 壞值已剝除`);
        delete o[k];
      }
      if (dropItem) return;
      cleaned.push(o);
    });
    out[col] = cleaned;
  }
  if ('learnedCategories' in out) out.learnedCategories = sanitizeLearned(out.learnedCategories);
  // settings 也要過櫃檯（Codex#8-2：漏了這塊＝usdTwd:'oops' 仍可繞過 /api/settings 與匯入的防線直接寫入）
  const sres = sanitizeSettingsDeep(out.settings);
  if (sres.bad.length) {
    if (mode === 'throw') throw new Error(`[schema] settings 含非法值：${sres.bad.join(', ')}——寫入端漏了驗證，請修程式`);
    warns.push(...sres.bad.map(b => b + ' 壞值已剝除'));
  }
  out.settings = sres.value;
  if (warns.length) console.warn(`[schema] 櫃檯寫入清理（${mode}）：${warns.slice(0, 10).join('；')}${warns.length > 10 ? `…共 ${warns.length} 筆` : ''}`);
  return out;
}

/**
 * settings 的「整包深度驗證」（櫃檯用，與路由層 sanitizeSettings 的差別：這裡驗「已存在的完整 settings」，
 * 已知欄位驗型別、巢狀 signals/fxTwd/ib（含 IB 同步欄位內層）都驗；未知頂層欄位放行（不參與計算、無害，
 * 且未來新欄位不會被櫃檯默默吃掉）。回傳 { value: 清理後(壞值已移除), bad: 壞欄位清單 }。
 * @param {any} input @returns {{value: Record<string, any>, bad: string[]}}
 */
export function sanitizeSettingsDeep(input) {
  /** @type {string[]} */
  const bad = [];
  if (!isObj(input)) return { value: {}, bad: ['settings(非物件)'] };
  /** @type {Record<string, any>} */
  const out = { ...input };
  for (const [k, kind] of Object.entries(SETTINGS_FIELD_TYPES)) {
    if (!(k in out)) continue;
    const v = out[k];
    const ok = kind === 'number' ? isNum(v) : kind === 'posnum' ? (isNum(v) && v > 0)
      : kind === 'string' ? typeof v === 'string' : okManual(v);
    if (!ok) { bad.push('settings.' + k); delete out[k]; }
  }
  if ('signals' in out) {
    if (!isObj(out.signals)) { bad.push('settings.signals'); delete out.signals; }
    else {
      const sig = { ...out.signals };
      for (const k of SIGNALS_WRITABLE_FIELDS) if (k in sig && !okManual(sig[k])) { bad.push('signals.' + k); delete sig[k]; }
      out.signals = sig;
    }
  }
  if ('fxTwd' in out) {
    if (!isObj(out.fxTwd)) { bad.push('settings.fxTwd'); delete out.fxTwd; }
    else {
      const fx = { ...out.fxTwd };
      for (const [c, r] of Object.entries(fx)) if (!(isNum(r) && r > 0)) { bad.push('fxTwd.' + c); delete fx[c]; }
      out.fxTwd = fx;
    }
  }
  if ('ib' in out) {
    if (!isObj(out.ib)) { bad.push('settings.ib'); out.ib = {}; }
    else {
      const ib = { ...out.ib };
      for (const f of IB_WRITABLE_FIELDS) if (f in ib && typeof ib[f] !== 'string') { bad.push('ib.' + f); delete ib[f]; }
      if ('lastSync' in ib && !(ib.lastSync === null || typeof ib.lastSync === 'string')) { bad.push('ib.lastSync'); delete ib.lastSync; }
      if ('lastEquity' in ib) {
        const le = ib.lastEquity;
        if (!(le === null || (isObj(le) && isNum(le.stock) && isNum(le.cash) && (le.date === undefined || typeof le.date === 'string')))) {
          bad.push('ib.lastEquity'); delete ib.lastEquity;   // 壞的官方淨值→丟棄走 fallback 自算（不可讓 NaN 藏融資）
        }
      }
      if ('income' in ib && ib.income !== null) {
        if (!isObj(ib.income)) { bad.push('ib.income'); delete ib.income; }
        else {
          const inc = { ...ib.income };
          for (const nf of ['dividends', 'paymentInLieu', 'withholdingTax', 'interestPaid', 'interestReceived', 'other', 'count', 'skippedNoFx', 'estimatedNoFx']) {
            if (nf in inc && !isNum(inc[nf])) { bad.push('ib.income.' + nf); delete inc[nf]; }
          }
          if ('estimatedCurrencies' in inc && !Array.isArray(inc.estimatedCurrencies)) { bad.push('ib.income.estimatedCurrencies'); delete inc.estimatedCurrencies; }
          ib.income = inc;
        }
      }
      out.ib = ib;
    }
  }
  // 自訂分類三欄（expenseTree/categoryAliases/subAliases）：與 sanitizeSettings 共用同一驗證器（Codex#1，勿兩處走鐘）。
  // 非物件的整欄剝除；逐項壞值剝除並記 bad（throw 模式會當場炸出，strip 模式警告）。
  const catBad = [];
  const cat = sanitizeCategorySettings(out, catBad);
  for (const f of ['expenseTree', 'categoryAliases', 'subAliases']) {
    if (!(f in out)) continue;
    if (f in cat) out[f] = cat[f]; else delete out[f];   // 整欄非物件→剝除
  }
  bad.push(...catBad);
  // 使用者自訂店名規則（第三帖）：同款處理——壞條目剝除、整欄非物件則整欄剝除
  const ruleBad = [];
  const rules = pickStoreRules(out, ruleBad);
  if ('storeRules' in out) { if ('storeRules' in rules) out.storeRules = rules.storeRules; else delete out.storeRules; }
  bad.push(...ruleBad);
  return { value: out, bad };
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
 * @param {{allowIbSyncFields?: boolean, badOut?: string[]}} [opts] badOut＝把剝掉的欄位名回報給呼叫端
 *   （匯入端據此對自訂分類/店名規則做 fail-closed，見 routes/core.js 的 /api/import，Codex r10#3）
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
    if (k === 'signals' || k === 'fxTwd' || k === 'ib' || k === 'expenseTree' || k === 'categoryAliases' || k === 'subAliases' || k === 'storeRules') continue;   // 巢狀/自訂分類/店名規則，下面處理
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
  // 自訂分類三欄（Codex#1）：匯入備份必須保留 expenseTree/categoryAliases/subAliases，否則還原後分類退回
  // 預設、改名別名消失、帳單重新歸錯類。與 sanitizeSettingsDeep 同口徑（只收合法形狀、壞值剝除）。
  Object.assign(out, sanitizeCategorySettings(input, dropped));
  Object.assign(out, pickStoreRules(input, dropped));   // 店名規則同理（第三帖）：手做的規則不可因還原備份而消失
  if (dropped.length) console.warn(`[schema] settings 剝掉名稱/型別不符的欄位：${dropped.join(', ')}（IB 同步欄位 lastEquity/income/lastSync 前端本就不可寫）`);
  if (Array.isArray(opts.badOut)) opts.badOut.push(...dropped);   // 回報給呼叫端（匯入端據此 fail-closed，Codex r10#3）
  return out;
}

/**
 * 驗證/清理 settings 的自訂分類三欄（expenseTree／categoryAliases／subAliases），只保留合法形狀。
 * 供 `sanitizeSettings`（匯入白名單）與 `sanitizeSettingsDeep`（櫃檯）共用，避免兩處走鐘（Codex#1）。
 * expenseTree＝{大類:string→子類:string[]}；categoryAliases＝{string→string}；subAliases＝{string→{string→string}}。
 * @param {any} src @param {string[]=} bad 壞欄位名收集（有給才記，供呼叫端警告/櫃檯 throw）
 * @returns {Record<string, any>} 只含存在且合法的欄位（沒給就不放，維持「缺欄位＝不動」）
 */
/**
 * 驗證/清理 settings 的 `storeRules`（使用者自訂店名規則，第三帖）。與自訂分類三欄同款：
 * 供 `sanitizeSettings`（**匯入備份必須保留**——手做的規則丟了等於白做）與 `sanitizeSettingsDeep`
 *（櫃檯）共用同一個驗證器 `sanitizeStoreRules`（形狀與編譯器住同一個檔，兩者不可能走鐘）。
 * 缺欄位＝不動（維持「沒設定過就是只有內建規則」）。
 * @param {any} src @param {string[]=} bad @returns {Record<string, any>}
 */
export function pickStoreRules(src, bad) {
  if (!isObj(src) || !('storeRules' in src)) return {};
  if (!isObj(src.storeRules)) { bad?.push('settings.storeRules'); return {}; }
  return { storeRules: sanitizeStoreRules(src.storeRules, bad) };
}

export function sanitizeCategorySettings(src, bad) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!isObj(src)) return out;
  if ('expenseTree' in src) {
    if (!isObj(src.expenseTree)) { bad?.push('settings.expenseTree'); }
    else {
      /** @type {Record<string, any>} */
      const t = {};
      // __proto__ 丟棄並回報（Codex r5#4）：JSON.parse 做得出「自有 __proto__ 鍵」，
      // `t[k]=v` 對它不是寫鍵、是把 t 的原型換掉——匯入備份這條路也得設防。
      // 只丟這一個（與 sanitizeTree 同口徑）：toString 等其他原生名賦值是安全的自有鍵，舊資料容忍。
      for (const [k, v] of Object.entries(src.expenseTree)) {
        if (k === '__proto__') { bad?.push('expenseTree.__proto__（程式保留字，已丟棄）'); continue; }
        if (typeof k === 'string' && k.trim() && Array.isArray(v) && v.every(x => typeof x === 'string')) t[k] = v;
        else bad?.push('expenseTree.' + k);
      }
      out.expenseTree = t;
    }
  }
  if ('categoryAliases' in src) {
    if (!isObj(src.categoryAliases)) { bad?.push('settings.categoryAliases'); }
    else {
      /** @type {Record<string, any>} */
      const a = {};
      for (const [k, v] of Object.entries(src.categoryAliases)) {
        if (k === '__proto__') { bad?.push('categoryAliases.__proto__（程式保留字，已丟棄）'); continue; }   // 同 expenseTree：賦值陷阱鍵
        if (typeof v === 'string') a[k] = v; else bad?.push('categoryAliases.' + k);
      }
      out.categoryAliases = a;
    }
  }
  if ('subAliases' in src) {
    if (!isObj(src.subAliases)) { bad?.push('settings.subAliases'); }
    else {
      /** @type {Record<string, any>} */
      const a = {};
      for (const [p, m] of Object.entries(src.subAliases)) {
        if (p === '__proto__') { bad?.push('subAliases.__proto__（程式保留字，已丟棄）'); continue; }   // 同上：外層 a[p]=mm 的賦值陷阱
        if (!isObj(m)) { bad?.push('subAliases.' + p); continue; }
        /** @type {Record<string, any>} */
        const mm = {};
        for (const [k, v] of Object.entries(m)) {
          if (k === '__proto__') { bad?.push('subAliases.' + p + '.__proto__（程式保留字，已丟棄）'); continue; }
          if (typeof v === 'string') mm[k] = v; else bad?.push('subAliases.' + p + '.' + k);
        }
        a[p] = mm;
      }
      out.subAliases = a;
    }
  }
  return out;
}
