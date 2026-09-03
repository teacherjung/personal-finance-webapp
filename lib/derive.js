// @ts-check
// 從原始資料推導出「總覽」需要的數字與提醒。
// 這裡是整個網頁的大腦：把各模組的資料整合成你對財務的掌握。
import { isCardTx, isRewardCredit } from '../public/modules/categories.js';
import { portfolioCaps } from '../public/modules/portfolio-risk.js';
import { normalizePortfolioSymbol } from '../public/modules/portfolio-symbol.js';
import { isCardPayment, origFromStmtRef, refundPairKeyOf, refundPairKeyOfStoreKey } from './statement.js';
import { isRealDate, isRealMonth } from './schema.js';
import { RECORD_START } from '../public/modules/subscriptions-model.js';   // 訂閱起算地板的單一真相（走散點①修正）
/** @typedef {import('./types.js').Db} Db */
/** @typedef {import('./types.js').Subscription} Subscription */
/** @typedef {import('./types.js').Holding} Holding */
/** @typedef {import('./types.js').Reminder} Reminder */

// 負債型帳戶白名單——與 public/modules/accounts-model.js 的同名複本同步維護（前端不能 import lib/）。
// ⚠️ 新增型別要改的地方**逐一列名，刻意不寫「共幾處」**：這一族的數字漂過兩次——
//    原本寫「改其一要改兩處」，#409 r5 補成「三處」，r8 實測又發現前端還藏著第四第五份
//    （assets.js 的 isLiab 手抄清單＋帳戶表單的型別選項；後者現已收斂到 accounts-model 自動長出來）。
//    ・本檔的 LIABILITY_TYPES
//    ・public/modules/accounts-model.js 的同名 Set（前端單一真相：表單選項＋資產頁紅字都讀它）
//    ・lib/schema.js 的 FIELD_SCHEMA.accounts.type 枚舉（寫入牆；那行註解自己寫明合法值怎麼來）
//    漏掉枚舉那一處的下場：新型別在計算層都算得出負債，使用者一按儲存卻過不了櫃檯——
//    HOSTED 走 throw 模式（lib/store-pg.js）當場炸「值不合法」、根本寫不進去；
//    LOCAL 讀檔／還原走 strip 模式（lib/store.js）**默默把 type 剝掉**，帳戶變無型別 ⇒
//    正數餘額落到本檔 computeAssets 的 else 分支＝當成資產（實測：50 萬負債算成 netWorth +500000）。
// export 是給 test/exposure-sync-integrity.test.js 比對兩份成員用的：不 export 就只能各釘各的四個成員，
// 「單邊新增第五個型別」兩邊都不會紅（#409 r6 的洞，r7 補上集合比對題封死）。
// 「還有沒有第六份藏在別的檔案」不靠人記：同一支考題有一題全站掃描（自己寫了擋不住什麼）。
export const LIABILITY_TYPES = new Set(['loan', 'liability', 'mortgage', 'creditcard']);

// ETF 成分穿透（近似權重）——與 public/modules/portfolio-exposure.js 的 COMPOSITION 同步維護
/** @type {Record<string, { type: 'equity'|'bond'|'gold', regions: Record<string, number> }>} */
export const COMPOSITION = {
  CSPX:   { type: 'equity', regions: { 美國: 1 } },
  QQQM:   { type: 'equity', regions: { 美國: 1 } },
  VUAA:   { type: 'equity', regions: { 美國: 1 } },
  SPY:    { type: 'equity', regions: { 美國: 1 } },
  VOO:    { type: 'equity', regions: { 美國: 1 } },
  GOOGL:  { type: 'equity', regions: { 美國: 1 } },
  GOOG:   { type: 'equity', regions: { 美國: 1 } },
  AAPL:   { type: 'equity', regions: { 美國: 1 } },
  TSLA:   { type: 'equity', regions: { 美國: 1 } },
  SPACEX: { type: 'equity', regions: { 美國: 1 } },
  EIMI:   { type: 'equity', regions: { 中國: 0.25, 印度: 0.22, 台灣: 0.19, 韓國: 0.09, 其他: 0.25 } },
  XUSE:   { type: 'equity', regions: { 日本: 0.21, 其他: 0.79 } },
  EXUS:   { type: 'equity', regions: { 日本: 0.21, 其他: 0.79 } },
  ICHN:   { type: 'equity', regions: { 中國: 1 } },
  KWEB:   { type: 'equity', regions: { 中國: 1 } },
  CSKR:   { type: 'equity', regions: { 韓國: 1 } },
  SJPA:   { type: 'equity', regions: { 日本: 1 } },
  '0050':   { type: 'equity', regions: { 台灣: 1 } },
  '006208': { type: 'equity', regions: { 台灣: 1 } },
  SMH:      { type: 'equity', regions: { 美國: 1 } },
  SPCX:     { type: 'equity', regions: { 美國: 1 } },
  SGLD:     { type: 'gold', regions: {} },
  GLD:      { type: 'gold', regions: {} },
  IAU:      { type: 'gold', regions: {} },
  '00719B': { type: 'bond', regions: {} },
  '00720B': { type: 'bond', regions: {} }
};
/** ETF/持股 → 成分（型別、區域穿透）。未知代號 fallback 到 layer。 @param {Holding} h */
// ⚠️ export 供考題直測（2026-08-05）：這份 COMPOSITION 與 public/modules/portfolio-exposure.js
// 的同名複本是刻意同步點，必須逐鍵完全相等——兩邊都拿得到 compOf 才比對得起來。
// 病因：夜班突變體檢把後端的 KWEB 從「中國」改成「美國」，1487 題全綠——
// 中國**軟上限**（投資原則 v1，預設 15%：超標＝提醒凍結加碼、不強制賣）就此無聲失效，
// 而投組頁照樣顯示中國曝險。
export const compOf = (h) => COMPOSITION[normalizePortfolioSymbol(h.symbol)]
  || { type: h.layer === 'bond' ? 'bond' : h.layer === 'gold' ? 'gold' : 'equity', regions: { 其他: 1 } };

// 解析 YYYY-MM-DD 為「本地時區」的 Date：new Date('YYYY-MM-DD') 會被當 UTC，在 UTC 以西時區差一天。
/** @param {Date|string|number} d @returns {Date} */
function parseLocalDate(d) {
  if (d instanceof Date) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
}

/** 月份鍵 YYYY-MM。日期字串直接取前 7 碼、免受時區影響。 @param {Date|string=} d @returns {string} */
export function monthKey(d = new Date()) {
  if (typeof d === 'string') { const m = /^(\d{4})-(\d{2})/.exec(d); if (m) return `${m[1]}-${m[2]}`; }
  const dt = parseLocalDate(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

/** 距今幾天（負數＝已過期）；無日期回 Infinity。 @param {string=} dateStr @returns {number} */
function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = parseLocalDate(dateStr); target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function formatDateWithWeekday(dateStr) {
  const d = parseLocalDate(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr || '';
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${dateStr} (${weekdays[d.getDay()]})`;
}

// 距離「每月某日」還有幾天（用於信用卡繳款日）
/** @param {number|string=} day @returns {number} */
function daysUntilDayOfMonth(day) {
  const dd = Number(day);
  if (!dd || dd < 1 || dd > 31) return Infinity;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();   // 該月最後一天（m 可溢位，Date 自動進位年份）
  const clamped = (y, m) => new Date(y, m, Math.min(dd, lastDay(y, m)));   // 繳款日 31 在小月＝月底（銀行慣例）
  let target = clamped(today.getFullYear(), today.getMonth());
  if (target < today) target = clamped(today.getFullYear(), today.getMonth() + 1);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

// 把訂閱換算成「每月平均」成本
/** @param {Subscription} sub @returns {number} */
function monthlyCost(sub) {
  const amt = Number(sub.amount || 0);
  if (sub.cycle === 'lifetime') return 0;
  if (sub.cycle === 'yearly') return amt / 12;
  if (sub.cycle === 'semiannual') return amt / 6;
  if (sub.cycle === 'quarterly') return amt / 3;
  return amt;
}

// 訂閱是否仍在使用（active 或 ending）——與前端 subscriptions.js subStatus 同口徑（同步點）。
// 停用日已過（daysUntil ≤ 0）或明確停用＝不算；用於總覽「每月固定訂閱」項數，避免與訂閱頁打架。
/** @param {Subscription} sub @returns {boolean} */
function subActive(sub) {
  if (sub.status === 'ended' || sub.active === false) return false;
  if (sub.status === 'ending' || sub.endsOn) return daysUntil(sub.endsOn) > 0;
  return true;
}

// 某訂閱在指定月份實際應計入的攤提（與前端 subscriptions-model.js costForMonth 同口徑）：
// 停用當月的月繳不計、季/年繳按停用日天數比例。（同步點：兩處邏輯須一致，
// 由 test/subscriptions-model.test.js 前後端對照考題鎖住）
/** @param {Subscription} sub @param {string} mk 月份 YYYY-MM @returns {number} */
export function subCostForMonth(sub, mk) {   // export 供 Q4 攤提直測（自主體檢）
  if (sub.cycle === 'lifetime') return 0;
  // 缺 since 的舊資料退 RECORD_START 地板（走散點①修正，Codex 修正單＋William 照准 2026-07-24）：
  // 與前端 costForMonth 同口徑——「沒有起算資料時，不虛構 2026-06 以前的歷史費用」。
  // 現行資料零缺 since＝零現行影響；防的是未來還原舊備份＋算歷史月時兩頁數字不同。
  const since = sub.since || RECORD_START;
  if (mk < since) return 0;
  const base = monthlyCost(sub);
  const endsOn = sub.endsOn || '';
  if (!endsOn) return (sub.active === false || sub.status === 'ended') ? 0 : base;
  const endMk = endsOn.slice(0, 7);
  if (endMk < mk) return 0;
  if (sub.cycle === 'monthly') return endMk === mk ? 0 : base;
  if (endMk === mk) {
    // 停用當月按天數比例：分母用**該月實際天數**（自主體檢，使用者定 2026-07-22）——
    // 舊寫死 30 天讓 2/28 滿月停用被算成 28/30≈93%（該月都在用卻打折）。同步點：subscriptions-model.js costForMonth／公式文案。
    const [ey, em] = mk.split('-').map(Number);
    const dim = new Date(ey, em, 0).getDate();
    return base * Math.min(Number(endsOn.slice(8, 10)) || dim, dim) / dim;
  }
  return base;
}

// 匯率表（兌台幣）。usdTwd 為主匯率，其他幣別在 settings.fxTwd。
// 「乙」（William 2026-09-03 裁）：GBP／JPY 沒設（非正數）＝**缺匯率**＝ null——不再用猜的數算進去；
// 消費端一律經 fxFor()：缺匯率的那筆**不計入**並累計到 missingFx，讓畫面看得見「少算了幾筆」。
// ⚠️ USD 的 `|| 32` 是另一個口徑（設定頁可手填、有自己的預設），不在乙的裁示範圍——不要順手改。
// 前端 public/modules/portfolio-calculations.js fxTable() 是同步點：兩邊必須同口徑（考題釘住）。
/** @param {Db} db @returns {{TWD: number, USD: number, GBP: number|null, JPY: number|null}} */
function fxRates(db) {
  const s = db.settings || {};
  const pos = (/** @type {unknown} */ v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  return {
    TWD: 1,
    USD: Number(s.usdTwd || 32),
    GBP: pos(s.fxTwd?.GBP),
    JPY: pos(s.fxTwd?.JPY)
  };
}
/**
 * 一筆金額該用的匯率。缺 currency 預設台幣（既有判準，與帳戶端一致）；表上沒有這個幣別、或值是 null ＝ 缺匯率。
 * @param {Record<string, number|null>} rates @param {unknown} currency
 * @returns {{cur:string, rate:number, missing:false}|{cur:string, rate:null, missing:true}}
 */
function fxFor(rates, currency) {
  const cur = String(currency || 'TWD').toUpperCase();
  if (cur === 'TWD') return { cur, rate: 1, missing: false };   // 台幣本身不需要匯率
  const rate = Object.hasOwn(rates, cur) ? rates[cur] : null;
  return (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) ? { cur, rate, missing: false } : { cur, rate: null, missing: true };
}
/**
 * 缺匯率累計器：`[{currency, count, liabilities}]`，順序＝首次出現。
 * `liabilities`＝其中幾筆是負債（負餘額或負債型帳戶）——缺匯率的負債被略過會把負債、融資與槓桿**低估**、淨值**高估**，
 * 是最危險的方向（生存優先），提醒引擎據此升成 danger。只登記**真的有曝險**的列（零餘額／零股數不算）。
 */
function missingFxTracker() {
  /** @type {Map<string, {count:number, liabilities:number}>} */
  const m = new Map();
  return {
    add(/** @type {string} */ cur, liability = false) {
      const v = m.get(cur) || { count: 0, liabilities: 0 };
      v.count += 1; if (liability) v.liabilities += 1; m.set(cur, v);
    },
    list() { return [...m].map(([currency, v]) => ({ currency, count: v.count, liabilities: v.liabilities })); }
  };
}
// 持股成本：優先用「均價 × 股數」，沒有均價才退回舊的總成本欄位
/** @param {Holding} h @returns {number} */
function holdingCost(h) {
  if (h.avgCost != null && h.avgCost !== '') return Number(h.avgCost) * Number(h.quantity || 0);
  return Number(h.cost || 0);
}

/** @param {Db} db */
export function computeAssets(db) {
  const rates = fxRates(db);
  const missing = missingFxTracker();
  let assets = 0, liabilities = 0;
  /** @type {Record<string, number>} */
  const byClass = Object.create(null);   // 資產類別是使用者文字：class='toString' 時普通物件的 || 0 撈到原型函式、金額變字串（Codex r6#3）
  // 帳戶（現金/黃金等，各幣別換算台幣）
  for (const a of db.accounts || []) {
    const f = fxFor(rates, a.currency);
    if (f.missing) {   // 缺匯率＝這筆不計入（乙）；有曝險（非零餘額）才登記，負債另計
      if (Number(a.balance || 0) !== 0) missing.add(f.cur, LIABILITY_TYPES.has(a.type || '') || Number(a.balance || 0) < 0);
      continue;
    }
    const bal = Number(a.balance || 0) * f.rate;
    if (LIABILITY_TYPES.has(a.type || '') || bal < 0) {
      liabilities += Math.abs(bal);
    } else {
      assets += bal;
      const cls = a.class || a.type || '其他';
      byClass[cls] = (byClass[cls] || 0) + bal;
    }
  }
  // 投資組合持股自動併入，避免手動重複記帳。
  // 股/債/金分類走 COMPOSITION（compOf，與投組頁同口徑）；未知代號 compOf 內部才 fallback 到 layer。
  for (const h of db.holdings || []) {
    const f = fxFor(rates, h.currency);   // 缺 currency 預設台幣（與帳戶端一致），避免台股被當美元灌 32 倍
    if (f.missing) { if (Number(h.quantity || 0) !== 0) missing.add(f.cur); continue; }   // 缺匯率＝不計入（乙）；零股數不算曝險
    const v = Number(h.price || 0) * Number(h.quantity || 0) * f.rate;
    const type = compOf(h).type;
    const cls = type === 'bond' ? '債券' : type === 'gold' ? '黃金' : '股票';
    byClass[cls] = (byClass[cls] || 0) + v;
    assets += v;
  }
  return { assets, liabilities, netWorth: assets - liabilities, byClass, missingFx: missing.list() };
}

// 帳本歸屬判準：**唯一一份住在 public/modules/categories.js（isCardTx）**，這裡轉供後端（服務層/測試
// 從 derive 拿），前端直接 import categories.js——同一份定義，沒有前後端同步點。
export { isCardTx as isCardLedger };

/** @param {Db} db @param {string=} mk @returns {{month:string, income:number, expense:number, net:number}} */
export function computeCashflow(db, mk = monthKey()) {
  let income = 0, expense = 0;
  for (const t of db.transactions || []) {
    if (isCardTx(t)) continue;            // 信用卡消費明細帳本不進現金流（三層重構；繳卡費那筆才是現金流出）
    if (!t.date) continue;                    // 沒日期的交易不歸入任何月份（否則 monthKey() 會誤算進當月）
    if (monthKey(t.date) !== mk) continue;
    if (t.type === 'income') income += Number(t.amount || 0);
    else if (t.type === 'expense') expense += Number(t.amount || 0);   // 只算明確支出；transfer（內轉）等其他型別不計入
  }
  return { month: mk, income, expense, net: income - expense };
}

/**
 * 總覽近月現金流：逐月一律回到 computeCashflow 單一公式。
 * 只畫視窗內第一筆到最後一筆真的收入／支出；中間空月保留 0，前後沒有記帳的月份都不偽裝成零收支。
 * @param {Db} db
 * @param {string=} currentMonth
 * @param {number=} limit
 */
export function computeCashflowHistory(db, currentMonth = monthKey(), limit = 12) {
  if (!isRealMonth(currentMonth)) return [];
  const match = /^(\d{4})-(\d{2})$/.exec(currentMonth);
  if (!match) return [];
  const count = Math.max(1, Math.floor(Number(limit) || 12));
  const currentOrdinal = Number(match[1]) * 12 + Number(match[2]) - 1;
  const months = Array.from({ length: count }, (_, index) => {
    const ordinal = currentOrdinal - count + 1 + index;
    const year = Math.floor(ordinal / 12);
    const month = ordinal - year * 12 + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  });
  const monthSet = new Set(months);
  let firstRecorded = '', lastRecorded = '';
  for (const t of db.transactions || []) {
    if (isCardTx(t) || !isRealDate(t.date) || !['income', 'expense'].includes(t.type || '')) continue;
    const mk = monthKey(t.date);
    if (!monthSet.has(mk)) continue;
    if (!firstRecorded || mk < firstRecorded) firstRecorded = mk;
    if (!lastRecorded || mk > lastRecorded) lastRecorded = mk;
  }
  if (!firstRecorded) return [];
  return months.filter(mk => mk >= firstRecorded && mk <= lastRecorded).map(mk => computeCashflow(db, mk));
}

// ---- 月度回顧：消費視角（卡帳＋現金流帳）----

/** @param {any} t @returns {boolean} */
function isTwdConsumption(t) {
  return !t?.currency || String(t.currency).toUpperCase() === 'TWD';
}

/**
 * 「同卡」優先用 stmtRef 第一段的卡片 id（改卡名也不會變）；
 * 非帳單交易才退回 account 名稱。沒有可證明的帳戶就不配，寧可擱置也不亂抵。
 * @param {any} t @returns {string}
 */
function consumptionAccountKey(t) {
  if (isCardTx(t) && t?.stmtRef) {
    const ref = String(t.stmtRef);
    const i = ref.indexOf('|');
    if (i > 0) return `card:${ref.slice(0, i)}`;
  }
  const account = String(t?.account || '').trim();
  return account ? `account:${account}` : '';
}

/** @param {any} t @returns {string} */
function paymentDescription(t) {
  return origFromStmtRef(t?.stmtRef) || String(t?.note || '');
}

/**
 * 退款配對（純函式，不寫 db）：每筆退款配「同卡＋同細身分＋同額＋日期較早」的最近一筆未配消費，一對一。
 * 部分退款或無法證明的退款寧可列為未對應，絕不猜測。每次用當下全庫重配 → 先匯退款、後補舊月消費會自癒。
 * ⚠️ **同步點**：月度回顧（consumptionByMonth）與信用卡費頁的消費歸屬／退款標記（/api/refund-pairs）
 * 共用這一份判準，配對規則只能改這裡——分成兩份實作就會走散（同一筆退款兩頁抵到不同月）。
 * ⚠️ 負數列分**三格**（順序不可調換）：繳款 → 回饋 → 退款候選。繳款先判＝今天被當繳款的列行為零位移；
 * 回饋（點數折抵）不是把某筆消費的錢退回來，所以不進配對池、也不抵減任何一個月的消費（使用者定 2026-08-06）。
 * @param {Db|any} db
 * @returns {{purchases: any[], pairs: Array<{purchase:any, refund:any}>, unmatchedRefunds: Array<{id:string,date:string,amount:number,account:string,storeKey:string,store:string}>, rewards: Array<{id:string,date:string,amount:number,account:string,storeKey:string,store:string}>}}
 */
export function pairRefunds(db) {
  /** @type {any[]} */
  const purchases = [];
  /** @type {any[]} */
  const refunds = [];
  /** @type {any[]} */
  const rewardRows = [];

  for (const t of db?.transactions || []) {
    if (!t || t.type !== 'expense' || !isRealDate(t.date) || !isTwdConsumption(t)) continue;
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const category = String(t.category || '').trim();
    // 銀行繳卡費的分類刻意留空，卡帳舊資料可能留「繳款/退款」；兩者都不是消費。
    if (!category || category === '繳款/退款') continue;
    if (amount < 0) {
      // 三格，順序不可調換：繳款優先（既有行為零位移）→ 回饋（不是退款、不進配對池）→ 其餘才是退款候選。
      const desc = paymentDescription(t);
      // 具名調整列（isAdjustment＝AI 帳單的等式項，Grok 掃#4）不是繳款：「自動扣繳回饋金」
      // 命中繳款字樣也照樣進下面的回饋/退款分格——被 continue 掉＝消費分析當這筆抵減沒發生
      if (!t.isAdjustment && isCardPayment(desc)) continue;
      if (isRewardCredit(desc)) { rewardRows.push(t); continue; }
      refunds.push(t);
      continue;
    }
    purchases.push(t);
  }

  /** @type {Map<string, any[]>} */
  // 配對身分（Codex 複審 2026-07-26）：**不用彙總鑰匙**（加油站／停車費會讓不同店家撞成同一把、
  // 退款配到別家店的消費）。有帳單原文就用原文算細身分；沒有原文（手動記帳）時彙總鑰匙一律不可配對。
  /** @param {any} t @returns {string} */
  const refundPairIdentity = (t) => {
    const orig = origFromStmtRef(t?.stmtRef);
    return orig ? refundPairKeyOf(orig) : refundPairKeyOfStoreKey(t?.storeKey);
  };
  const candidates = new Map();
  for (const purchase of purchases) {
    const account = consumptionAccountKey(purchase);
    const storeKey = refundPairIdentity(purchase);
    if (!account || !storeKey) continue;
    const key = JSON.stringify([account, storeKey, Number(purchase.amount)]);
    const list = candidates.get(key) || [];
    list.push(purchase);
    candidates.set(key, list);
  }
  for (const list of candidates.values()) {
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id || '').localeCompare(String(b.id || '')));
  }

  /** @type {Set<any>} */
  const paired = new Set();
  /** @type {Array<{purchase:any, refund:any}>} */
  const pairs = [];
  /** @type {Array<{id:string,date:string,amount:number,account:string,storeKey:string,store:string}>} */
  const unmatchedRefunds = [];
  refunds.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id || '').localeCompare(String(b.id || '')));
  for (const refund of refunds) {
    const account = consumptionAccountKey(refund);
    const storeKey = refundPairIdentity(refund);
    const key = account && storeKey ? JSON.stringify([account, storeKey, Math.abs(Number(refund.amount))]) : '';
    const list = key ? (candidates.get(key) || []) : [];
    let purchase = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!paired.has(list[i]) && String(list[i].date) < String(refund.date)) { purchase = list[i]; break; }
    }
    if (purchase) {
      paired.add(purchase);
      pairs.push({ purchase, refund });
    } else {
      unmatchedRefunds.push(negativeRowSummary(refund, '未命名退款'));
    }
  }
  // 回饋與未對應退款**同一個形狀、同一個口徑（全庫不分月）**：兩者都是「有這筆錢、但沒有抵到任何一筆消費」，
  // 畫面並排講。⚠️ 形狀不一致過（改版時踩過）：回饋若只回選定月，畫面上那筆錢會在某些月份整個消失。
  rewardRows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id || '').localeCompare(String(b.id || '')));
  const rewards = rewardRows.map((t) => negativeRowSummary(t, '未命名回饋'));
  return { purchases, pairs, unmatchedRefunds, rewards };
}

/**
 * 負數列的畫面摘要（未對應退款與回饋共用一份，免得兩邊欄位漂）。金額一律取絕對值＝畫面講「有多少錢」。
 * @param {any} t @param {string} fallbackName @returns {{id:string,date:string,amount:number,account:string,storeKey:string,store:string}}
 */
function negativeRowSummary(t, fallbackName) {
  return {
    id: String(t.id || ''), date: String(t.date), amount: Math.abs(Number(t.amount)),
    account: String(t.account || ''), storeKey: String(t.storeKey || ''),
    store: String(t.note || t.storeKey || fallbackName),
  };
}

/**
 * 兩帳聯集的「消費視角」純計算積木：消費算在消費當月，配對成功的退款回頭抵減**該消費的月份**。
 * 配對本身見 `pairRefunds`（同步點）。
 * @param {Db|any} db
 * @returns {{byMonth: Record<string, Record<string, {total:number, subs:Record<string, number>}>>, unmatchedRefunds: Array<{id:string,date:string,amount:number,account:string,storeKey:string,store:string}>, rewards: Array<{id:string,date:string,amount:number,account:string,storeKey:string,store:string}>}}
 */
export function consumptionByMonth(db) {
  /** @type {Record<string, Record<string, {total:number, subs:Record<string, number>}>>} */
  const byMonth = Object.create(null);
  const { purchases, pairs, unmatchedRefunds, rewards } = pairRefunds(db);

  /** @param {any} t @param {number} delta */
  const add = (t, delta) => {
    const mk = monthKey(t.date);
    const category = String(t.category || '').trim();
    const subcategory = String(t.subcategory || '').trim() || '（未分子類）';
    const cats = byMonth[mk] || (byMonth[mk] = Object.create(null));
    const row = cats[category] || (cats[category] = { total: 0, subs: Object.create(null) });
    row.total = Math.max(0, row.total + delta);
    row.subs[subcategory] = Math.max(0, (row.subs[subcategory] || 0) + delta);
  };
  for (const purchase of purchases) add(purchase, Number(purchase.amount));
  // 抵減順序＝pairRefunds 的配對順序（退款日→id），與拆分前逐字相同：add 有 Math.max(0,…) 夾底，順序會影響結果
  for (const { purchase, refund } of pairs) add(purchase, -Math.abs(Number(refund.amount)));

  return { byMonth, unmatchedRefunds, rewards };
}

/** @param {Date} now @returns {string[]} */
function settledMonthKeys(now) {
  const keys = [];
  for (let i = 6; i >= 1; i--) keys.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  return keys;
}

/**
 * 月度回顧 API 的純資料形狀：前六個已結清月（不含本月）、選定月分類與現金流。
 * @param {Db|any} db @param {string=} requestedMonth @param {Date=} now
 */
export function buildMonthlyReview(db, requestedMonth = '', now = new Date()) {
  const consumption = consumptionByMonth(db);
  const candidates = settledMonthKeys(now);
  const seen = new Set();
  for (const t of db?.transactions || []) {
    if (!t || !isRealDate(t.date) || !isTwdConsumption(t) || !['income', 'expense'].includes(t.type)) continue;
    const mk = monthKey(t.date);
    if (candidates.includes(mk)) seen.add(mk);
  }
  // 記帳開始前的月份不補 0 假資料；開始後的中間空檔則保留、標成無資料。
  const firstSeen = candidates.findIndex(mk => seen.has(mk));
  const visibleKeys = firstSeen < 0 ? [] : candidates.slice(firstSeen);
  const months = visibleKeys.map(mk => {
    const cats = consumption.byMonth[mk] || Object.create(null);
    const total = Object.values(cats).reduce((sum, row) => sum + Number(row.total || 0), 0);
    return { month: mk, total, hasData: seen.has(mk), possiblyIncomplete: !seen.has(mk) };
  });
  // 預設先看最近一個真的有消費的月份；最新已結清月可能尚未匯帳單，直接選它會讓卡片一打開就空白。
  // 使用者明確點選的月份仍照原樣尊重，即使該月為空。
  const latestWithConsumption = [...months].reverse().find(row => Number(row.total) > 0)?.month;
  const selectedMonth = visibleKeys.includes(requestedMonth) ? requestedMonth : (latestWithConsumption || visibleKeys.at(-1) || null);
  const selectedCats = selectedMonth ? (consumption.byMonth[selectedMonth] || Object.create(null)) : Object.create(null);
  const selectedTotal = Object.values(selectedCats).reduce((sum, row) => sum + Number(row.total || 0), 0);
  const categories = Object.entries(selectedCats)
    .filter(([, row]) => Number(row.total) > 0)
    .map(([name, row]) => ({
      name, amount: Number(row.total), pct: selectedTotal > 0 ? Number(row.total) / selectedTotal * 100 : 0,
      subcategories: Object.entries(row.subs || Object.create(null))
        .filter(([, amount]) => Number(amount) > 0)
        .map(([subName, amount]) => ({ name: subName, amount: Number(amount), pct: Number(row.total) > 0 ? Number(amount) / Number(row.total) * 100 : 0 }))
        .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'zh-Hant')),
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'zh-Hant'));
  const baseCashflow = selectedMonth ? computeCashflow(db, selectedMonth) : { month: '', income: 0, expense: 0, net: 0 };
  const cashflow = { ...baseCashflow, overdraft: baseCashflow.net < 0, overdraftAmount: Math.max(0, -baseCashflow.net) };
  const unmatchedTotal = consumption.unmatchedRefunds.reduce((sum, row) => sum + row.amount, 0);
  const rewardTotal = consumption.rewards.reduce((sum, row) => sum + row.amount, 0);
  return {
    months, selectedMonth,
    selected: { total: selectedTotal, categories, cashflow },
    unmatchedRefunds: { count: consumption.unmatchedRefunds.length, total: unmatchedTotal, items: consumption.unmatchedRefunds },
    // ⚠️ 與 unmatchedRefunds 同為**全庫不分月**：選定月只涵蓋近六個已結清月，回饋若跟著選定月走，
    //    落在窗口外的回饋會在畫面上完全看不見——而它同時已經被移出未對應退款清單＝那筆錢憑空消失。
    rewards: { count: consumption.rewards.length, total: rewardTotal, items: consumption.rewards },
  };
}

// 過去幾個月的平均支出（給緊急預備金計算用）。窗口＝6 個月（使用者定 2026-07-20：可撐月數
// ＝台幣現金 ÷ 過去六個月現金流平均支出）。只算「有現金流資料的月份」（下面 counted 判斷）＝
// 影響分析點名的保險：只記了卡帳、銀行帳單還沒匯的「半記錄月」不會被當成零支出月拉低平均。
/** @param {Db} db @param {number=} months @returns {number} */
function avgMonthlyExpense(db, months = 6) {
  const now = new Date();
  const keys = [];
  for (let i = 1; i <= months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(monthKey(d));
  }
  let total = 0, counted = 0;
  for (const k of keys) {
    const cf = computeCashflow(db, k);
    // 有任何收支紀錄的月份才算（含真正零支出月）；完全沒資料的月份（開始記帳前）才略過
    if (cf.income > 0 || cf.expense > 0) { total += cf.expense; counted++; }
  }
  // 沒有歷史資料時，退而求其次用訂閱+本月支出估
  if (counted === 0) {
    // 與總覽「本月固定訂閱」同口徑（subCostForMonth：已停用/停用當月月繳/超期都計 0），避免把已停用訂閱算進緊急預備金
    const nowMk = monthKey();
    const subs = (db.subscriptions || []).reduce((s, x) => s + subCostForMonth(x, nowMk), 0);
    return Math.max(computeCashflow(db).expense, subs);
  }
  return total / counted;
}

// 過去六個月「信用卡帳本」平均淨消費（緊急預備金過渡期保險用；只算有卡消費的月份，比照 avgMonthlyExpense）。
// 三層重構 stage1→3 空窗期：真實支出多在 card 帳本、還沒經銀行對帳單的繳卡費進現金流——用它偵測「現金流
// 支出基礎是否低估了真實花費」。銀行對帳單匯入後這條保險自然失效（cashflow 支出會追上）。
// 退款保留負數、刻意抵減消費：安全網要比較實際淨花費；若改用毛額，退款後仍會長期高估並反覆誤報。
/** @param {Db} db @param {number=} months @returns {number} */
function avgMonthlyCardExpense(db, months = 6) {
  const now = new Date();
  let total = 0, counted = 0;
  for (let i = 1; i <= months; i++) {
    const mk = monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1));
    let exp = 0;
    for (const t of db.transactions || []) {
      if (!isCardTx(t) || t.type !== 'expense') continue;
      if (!t.date || monthKey(t.date) !== mk) continue;
      exp += Number(t.amount || 0);
    }
    if (exp > 0) { total += exp; counted++; }
  }
  return counted ? total / counted : 0;
}

/** @param {number[]} values @returns {number|null} */
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {string} mk @returns {number} */
function monthOrdinal(mk) {
  const [year, month] = mk.split('-').map(Number);
  return year * 12 + month - 1;
}

/**
 * 淨值目標的兩種到達速度。兩把尺刻意分開：
 * - savingsSpeed：最近六個已結束月的現金流結餘中位數，只反映收入－支出。
 * - netWorthSpeed：月快照變化中位數，包含市場、匯率與帳戶更新。
 * 兩者都至少要三個月份；速度不為正時不硬算負月數或 Infinity。
 * @param {Db} db
 * @param {Date=} now
 * @returns {null|{
 *   target:number,current:number,gap:number,progressPct:number,reached:boolean,
 *   savingsSpeed:number|null,netWorthSpeed:number|null,
 *   monthsSavings:number|null,monthsNetWorth:number|null,
 *   savingsSamples:number,netWorthSamples:number,insufficient:boolean
 * }}
 */
export function computeGoalTracking(db, now = new Date()) {
  const rawTarget = db.settings?.netWorthTarget;
  if (typeof rawTarget !== 'number' || !Number.isFinite(rawTarget) || rawTarget <= 0) return null;

  const target = rawTarget;
  const current = computeAssets(db).netWorth;
  const gap = Math.max(0, target - current);
  const reached = current >= target;
  const progressPct = Math.max(0, Math.min(100, current / target * 100));
  const candidateMonths = settledMonthKeys(now);
  const candidateSet = new Set(candidateMonths);

  // 只把真的有收入／支出列的月份當樣本；信用卡消費帳本與內轉都不算現金結餘。
  const cashflowMonths = new Set();
  for (const t of db.transactions || []) {
    if (isCardTx(t) || !isRealDate(t.date) || !['income', 'expense'].includes(t.type || '')) continue;
    const mk = monthKey(t.date);
    if (candidateSet.has(mk)) cashflowMonths.add(mk);
  }
  const savingsValues = candidateMonths
    .filter(mk => cashflowMonths.has(mk))
    .map(mk => computeCashflow(db, mk).net);
  const savingsSamples = savingsValues.length;
  const rawSavingsSpeed = savingsSamples >= 3 ? median(savingsValues) : null;
  const savingsSpeed = rawSavingsSpeed != null && rawSavingsSpeed > 0 ? rawSavingsSpeed : null;

  // 正常流程同月只有一筆快照；若舊備份意外重複，保留日期較新的那筆，避免同月自己互減。
  /** @type {Map<string, {month:string,date?:string,netWorth:number}>} */
  const snapshotsByMonth = new Map();
  for (const snap of db.snapshots || []) {
    if (!snap || !isRealMonth(snap.month) || !candidateSet.has(snap.month)
      || typeof snap.netWorth !== 'number' || !Number.isFinite(snap.netWorth)) continue;
    const old = snapshotsByMonth.get(snap.month);
    if (!old || String(snap.date || '') >= String(old.date || '')) {
      snapshotsByMonth.set(snap.month, { month: snap.month, date: snap.date, netWorth: snap.netWorth });
    }
  }
  const snapshots = [...snapshotsByMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  const netWorthSamples = snapshots.length;
  const netWorthChanges = [];
  for (let i = 1; i < snapshots.length; i++) {
    const monthGap = monthOrdinal(snapshots[i].month) - monthOrdinal(snapshots[i - 1].month);
    if (monthGap > 0) netWorthChanges.push((snapshots[i].netWorth - snapshots[i - 1].netWorth) / monthGap);
  }
  const rawNetWorthSpeed = netWorthSamples >= 3 ? median(netWorthChanges) : null;
  const netWorthSpeed = rawNetWorthSpeed != null && rawNetWorthSpeed > 0 ? rawNetWorthSpeed : null;

  return {
    target, current, gap, progressPct, reached,
    savingsSpeed, netWorthSpeed,
    monthsSavings: reached ? 0 : (savingsSpeed != null ? gap / savingsSpeed : null),
    monthsNetWorth: reached ? 0 : (netWorthSpeed != null ? gap / netWorthSpeed : null),
    savingsSamples, netWorthSamples,
    insufficient: savingsSamples < 3 && netWorthSamples < 3,
  };
}

/** @param {Db} db @returns {Reminder[]} */
function computeReminders(db) {
  /** @type {Reminder[]} */
  const out = [];
  const s = db.settings || {};
  const riskCaps = portfolioCaps(s);

  // 0) 缺匯率（乙）：外幣部位沒匯率＝不計入淨值、槓桿與配置——要讓人看見方向：資產缺＝淨值被低估（warn）、負債缺＝負債與槓桿被低估、淨值被高估（danger），不是默默變小
  const missingFx = computeAssets(db).missingFx;
  if (missingFx.length) {
    const n = missingFx.reduce((sum, m) => sum + m.count, 0);
    const liab = missingFx.reduce((sum, m) => sum + m.liabilities, 0);
    const curs = missingFx.map(m => m.currency).join('、');
    // 方向不同、嚴重度不同：缺匯率的**負債**被略過＝負債、融資與槓桿被低估、淨值被高估（最危險）→ danger；
    // 只有資產缺匯率＝淨值被低估（保守方向）→ warn。
    out.push(liab > 0
      ? { key: 'fx-missing', level: 'danger', module: '投資',
        title: `有 ${n} 筆外幣部位沒有匯率（${curs}），其中 ${liab} 筆是負債：負債、融資與槓桿被低估、淨值被高估`,
        detail: '生存優先：看不見的負債最危險。到投資頁按「更新報價」會自動抓匯率；在那之前不要把目前的槓桿與淨值當真。' }
      : { key: 'fx-missing', level: 'warn', module: '投資',
        title: `有 ${n} 筆外幣資產沒有匯率（${curs}），未計入淨值（淨值被低估）`,
        detail: '到投資頁按「更新報價」會自動抓匯率；在那之前這些帳戶／持股不算進淨資產、槓桿與配置。' });
  }

  // 1) 現金流：本月淨現金流為負
  const cf = computeCashflow(db);
  if (cf.net < 0) {
    out.push({ key: 'cashflow-negative', level: 'warn', module: '收支', title: '本月現金流為負',
      detail: `本月支出比收入多 ${fmt(-cf.net)}，注意控制。` });
  }

  // 2) 緊急預備金不足（公式使用者定 2026-07-20）：分子＝**台幣現金**（type='cash' 且 TWD——活存定存
  // 都算、**排除外幣**：外幣要先換匯才救得了急，且匯率波動會虛胖可撐月數）；分母＝過去六個月現金流平均支出。
  const { netWorth } = computeAssets(db);
  const cash = (db.accounts || [])
    .filter(a => (a.type || 'cash') === 'cash' && (a.currency || 'TWD') === 'TWD' && Number(a.balance) > 0)
    .reduce((sum, a) => sum + Number(a.balance || 0), 0);
  const avgExp = avgMonthlyExpense(db);
  if (avgExp > 0) {
    const months = cash / avgExp;
    const target = s.emergencyFundMonths || 6;
    if (months < target) {
      out.push({ key: 'emergency-fund-low', level: months < target / 2 ? 'danger' : 'warn', module: '收支',
        title: '緊急預備金不足',
        detail: `目前現金約可支撐 ${months.toFixed(1)} 個月，低於目標 ${target} 個月。` });
    }
  }
  // ⚠️ 過渡期安全網保險（三層重構 stage1→3 空窗，生存優先）：現金流帳本的支出基礎，若低於「信用卡帳本」
  // 近幾個月的平均消費，代表刷卡消費的現金流出還沒經銀行對帳單（繳卡費）進到現金流——此時可撐月數會被高估。
  // 對抗審查抓到：支出全刷卡、只匯了卡帳還沒匯銀行帳單時，緊急預備金提醒會無聲關閉；生存優先＝安全網不可無聲，
  // 明確出聲告知「這個月數偏樂觀、原因、怎麼補」。銀行對帳單匯入後繳卡費進現金流，avgExp 追上 cardAvg，此提醒自動消失。
  const cardAvg = avgMonthlyCardExpense(db);
  if (cardAvg > 0 && cardAvg > avgExp) {
    out.push({ key: 'emergency-fund-optimistic', level: 'warn', module: '收支', title: '緊急預備金月數可能被高估',
      detail: `目前支出多來自信用卡帳單（近月平均約 ${fmt(cardAvg)}），這些消費要等銀行對帳單匯入、「繳卡費」進到現金流後才會計入「可撐幾個月」。在那之前，緊急預備金的月數會偏樂觀，別完全照它放心。` });
  }

  // 3) 資產配置偏離目標
  const drift = computeAllocation(db);
  for (const row of drift.rows) {
    if (Math.abs(row.diff) >= (s.allocationDriftPct || 5)) {
      out.push({ key: `alloc-drift-${row.class}`, level: 'info', module: '資產配置',
        title: `${row.class} 偏離目標 ${row.diff > 0 ? '+' : ''}${row.diff.toFixed(1)}%`,
        detail: `實際 ${row.actualPct.toFixed(1)}% vs 目標 ${row.targetPct}%，可考慮再平衡。` });
    }
  }

  // 4) 訂閱：即將停用 / 續費（7 天內）
  for (const sub of db.subscriptions || []) {
    if (!subActive(sub)) continue;   // 與訂閱頁/項數同口徑：status:'ended' 或停用日已過都不提醒
    if (sub.cycle === 'lifetime') continue;
    const endDays = daysUntil(sub.endsOn);
    if (endDays >= 0 && endDays <= 7) {
      out.push({ key: `sub-ending-${sub.id}`, level: 'info', module: '訂閱',
        title: `「${sub.name}」將於一週內停用`,
        detail: `「停用日」為 ${formatDateWithWeekday(sub.endsOn)}` });
    }

    // 即將停用的訂閱不會再續費（停用時 nextCharge 被設成＝endsOn），跳過續費提醒避免重複
    const chargeDays = daysUntil(sub.nextCharge);
    if (chargeDays >= 0 && chargeDays <= 7 && sub.status !== 'ending' && !sub.endsOn) {
      out.push({ key: `sub-charge-${sub.id}`, level: 'info', module: '訂閱',
        title: `「${sub.name}」將於一週內續費`,
        detail: `「續費日」為 ${formatDateWithWeekday(sub.nextCharge)}` });
    } else if (chargeDays < 0 && sub.status !== 'ending' && !sub.endsOn && sub.nextCharge) {
      // 續費日已過、nextCharge 未更新（自主體檢）：多半已扣款但日期沒推——提醒使用者更新到下一期。
      // ⚠️ 2026-07-26 拿掉「只提醒 30 天內」的下限（使用者要求補漏洞）：原本過期超過 30 天就完全不提，
      // 那筆訂閱同時從續費時間線（只畫未來 30 天）與提醒牆消失＝**愈久沒處理愈安靜**，剛好相反。
      // 正常情況已由 rollDueSubscriptions 自動推走；還會落到這裡的多半是「推不動」的（週期怪、資料壞），
      // 那更該一直看得到。
      // ⚠️ key **與「即將續費」同一把 `sub-charge-{id}`**（D3 自審#1）：這兩段是同一筆訂閱的同一個顧慮升級
      //（將至→已過），互斥分支。若各給一把 key，跨日從「將至」變「已過」時差異引擎會把它當「✓已解除＋🆕新出現」，
      // 對一個仍在惡化的顧慮謊報成「已解決 👍」。同 key＝差異引擎判為「持續中」（比照 card-due 的 info→warn 同 key）。
      out.push({ key: `sub-charge-${sub.id}`, level: 'warn', module: '訂閱',
        title: `「${sub.name}」續費日已過 ${-chargeDays} 天`,
        detail: `原續費日 ${formatDateWithWeekday(sub.nextCharge)}。多半已自動扣款，請到訂閱頁把「下次續費日」更新到下一期。` });
    }
  }

  // 4b) 信用卡：繳款日將至（7 天內）
  for (const c of db.cards || []) {
    if ((c.type || 'credit') !== 'credit' || !c.dueDay) continue;
    const d = daysUntilDayOfMonth(c.dueDay);
    if (d <= 7) {
      out.push({ key: `card-due-${c.id}`, level: d <= 3 ? 'warn' : 'info', module: '卡片',
        title: `${c.name} ${d === 0 ? '今天' : d + ' 天後'}繳款`,
        detail: `每月 ${c.dueDay} 日為繳款日${c.statementDay ? `（結帳日 ${c.statementDay} 日）` : ''}。` });
    }
  }

  // 5) 保險：繳費將至（30 天內）＋**已過期未更新**（自主體檢，使用者定 2026-07-22）：
  // nextPayment 是手動欄位、系統不會自動往後推，繳費日一過提醒就無聲消失——最需要提醒的「漏繳」反而零訊號。
  // 加負天數視窗（過期 60 天內）出 danger，逾 60 天不再洗（多半是忘了更新的舊資料）。
  for (const p of db.insurance || []) {
    const d = daysUntil(p.nextPayment);
    if (d >= 0 && d <= 30) {
      out.push({ key: `ins-pay-${p.id}`, level: d <= 7 ? 'warn' : 'info', module: '保險',
        title: `${p.policyName} ${d === 0 ? '今天' : d + ' 天後'}繳費`,
        detail: `保費 ${fmt(p.premium)} / ${cycleLabel(p.premiumCycle)}，被保險人 ${p.insured || '—'}` });
    } else if (d < 0 && d >= -60) {
      // key **與「即將繳費」同一把 `ins-pay-{id}`**（D3 自審#1，生存級）：同一張保單的繳費顧慮升級（將至→已過）＝
      // 同一件事，互斥分支。分兩把 key 會讓「保險漏繳 danger」在跨日升級當下被謊報成「✓已解除 👍」——生存優先絕不可。
      out.push({ key: `ins-pay-${p.id}`, level: 'danger', module: '保險',
        title: `${p.policyName} 繳費日已過 ${-d} 天`,
        detail: `原繳費日 ${formatDateWithWeekday(p.nextPayment)}。若已繳，請到保險頁把「下次繳費日」更新到下一期；若漏繳請盡快處理。` });
    }
    // 保單保障即將停用
    const de = daysUntil(p.endDate);
    if (de >= 0 && de <= 90) {
      out.push({ key: `ins-ending-${p.id}`, level: 'warn', module: '保險', title: `${p.policyName} 保障即將停用`,
        detail: `${p.endDate} 停用（約 ${de} 天後）。` });
    }
  }

  // 6) 投資原則 v1：口徑一律「% 淨資產」、區域穿透計算、軟上限（超標＝凍結加碼，不強制賣）
  const ib = computeIb(db);
  if (ib.totalValue > 0 && netWorth > 0) {
    const pctNw = (v) => v / netWorth * 100;
    // 6a) 單一個股 ≤ ibConcentrationPct（預設 5%）——**按 symbol 彙總**（D2 自審）：同一檔可能拆成多筆手動
    //     持股/多券商，per-position 判會①漏掉「3%+3%>5%」的拆單逃過上限（生存級守門破洞）②同 symbol 兩筆都
    //     超標時產生撞 key 的重複提醒。彙總才是「單一個股上限」的正確語意，也讓 conc-stock-{symbol} 這唯一
    //     不靠 uid 的 per-entity key 在一次計算內必唯一。symbol 是使用者文字＝null-proto 聚合（Codex r6#3 同型）。
    const stockCap = riskCaps.stock;
    /** @type {Record<string, number>} */
    const stockBySym = Object.create(null);
    for (const p of ib.positions) {
      if (p.layer !== 'stock') continue;
      const symbol = normalizePortfolioSymbol(p.symbol);
      if (!symbol) continue;
      stockBySym[symbol] = (stockBySym[symbol] || 0) + p.marketValue;
    }
    for (const [sym, mv] of Object.entries(stockBySym)) {
      if (pctNw(mv) > stockCap) {
        out.push({ key: `conc-stock-${sym}`, level: 'warn', module: '投資',
          title: `${sym} ${pctNw(mv).toFixed(1)}%（超過個股上限 ${stockCap}%，凍結加碼）`,
          detail: '佔淨資產比例超出單一個股上限（軟上限）：禁止加碼，讓部位自然稀釋。' });
      }
    }
    // 6b) 股票總曝險 ≤ equityCapPct（預設 90%，＝動態股債比 90:10 的天花板）
    const eqCap = riskCaps.equity;
    const eqTotal = ib.positions.filter(p => compOf(p).type === 'equity').reduce((t, p) => t + p.marketValue, 0);
    if (pctNw(eqTotal) > eqCap) {
      out.push({ key: 'conc-equity-total', level: 'warn', module: '投資',
        title: `股票總曝險 ${pctNw(eqTotal).toFixed(1)}%（超過上限 ${eqCap}%，凍結加碼）`,
        detail: '股票合計佔淨資產超出天花板（軟上限）：僅重壓訊號期才允許接近此上限。' });
    }
    // 6c) 各國曝險（穿透，美國與「其他」不設限）≤ countryCapPct（預設 15%）；中國可獨立設 chinaCapPct
    const cCap = riskCaps.country;
    const capFor = (rg) => rg === '中國' ? riskCaps.china : cCap;
    /** @type {Record<string, number>} */
    const region = {};
    for (const p of ib.positions) {
      const c = compOf(p);
      if (c.type !== 'equity') continue;
      for (const [rg, w] of Object.entries(c.regions)) region[rg] = (region[rg] || 0) + p.marketValue * w;
    }
    for (const [rg, v] of Object.entries(region)) {
      if (rg === '美國' || rg === '其他') continue;
      if (pctNw(v) > capFor(rg)) {
        out.push({ key: `conc-country-${rg}`, level: 'warn', module: '投資',
          title: `${rg} ${pctNw(v).toFixed(1)}%（超過國家上限 ${capFor(rg)}%，凍結加碼）`,
          detail: `${rg}曝險（穿透含 ETF 成分）佔淨資產超出單一國家上限（軟上限）：禁止加碼。` });
      }
    }
  }

  // 7) IB 融資槓桿（computeLeverage 單一真相；上限任何時期一體適用——生存優先原則）
  const ratesLev = fxRates(db);
  const { leverage: lev, loan, mcDist, maintPct } = computeLeverage(db, ib);
  if (loan > 0 && !Number.isFinite(lev)) {
    // 淨值 ≤ 0（借款超過總市值）：比斷頭更慘的狀態，不能讓標題印出「Infinityx」（自主體檢）
    out.push({ key: 'ib-underwater', level: 'danger', module: '投資', title: 'IB 淨值已為負（借款已超過持股市值）',
      detail: '帳戶可能已被強制平倉或即將被強平。請立即登入 IBKR 確認狀態。' });
  } else if (loan > 0 && lev > 1) {
    const levCap = riskCaps.lev;
    if (lev >= 1.1) {
      const inc = db.settings?.ib?.income;
      const intTxt = inc && inc.interestPaid ? `近一年融資利息 ${fmt(Math.abs(inc.interestPaid) * ratesLev.USD)}。` : '';
      out.push({ key: 'ib-leverage', level: mcDist < 40 ? 'danger' : lev > levCap ? 'warn' : 'info', module: '投資',
        title: lev > levCap
          ? `IB 融資槓桿 ${lev.toFixed(2)}x（超過上限 ${levCap}x，停借新錢）`
          : `IB 融資槓桿 ${lev.toFixed(2)}x（借款 ${fmt(loan)}）`,
        detail: (lev > levCap
          ? `依投資原則（上限任何時期適用，訊號期加碼只用新資金）：新資金優先償還融資，直到回到 ${levCap}x 內。`
          : '使用融資中：波動會被放大。')
          + `斷頭距離約 ${mcDist.toFixed(0)}%（市場再跌這麼多會觸及 IB 強平線，維持率 ${maintPct}%）。` + intTxt });
    }
  }

  // 7b) IB 閒置現金：正餘額（未投入）合計超過門檻 → 提醒安排投入
  const idleCap = Number(s.ibIdleCashAlert || 5000);
  const idleUsd = (db.accounts || []).filter(a => a.ibCashCur && Number(a.balance) > 0)
    .reduce((sum, a) => { const f = fxFor(ratesLev, a.currency || 'USD'); return f.missing ? sum : sum + Number(a.balance) * f.rate; }, 0) / ratesLev.USD;
  if (idleCap > 0 && idleUsd >= idleCap) {
    out.push({ key: 'ib-idle-cash', level: 'info', module: '投資',
      title: `IB 閒置現金約 ${Math.round(idleUsd).toLocaleString('en-US')} USD`,
      detail: `超過提醒門檻 ${idleCap.toLocaleString('en-US')} USD：閒置資金可依估值訊號與紀律安排投入。` });
  }

  // 8) 匯率：美元/台幣進入分批換匯區間
  const usdTwd = ratesLev.USD;   // 沿用規則 7 已算好的匯率表
  const fxHigh = Number(s.fxHigh || 32), fxLow = Number(s.fxLow || 28);
  if (usdTwd >= fxHigh) {
    out.push({ key: 'fx-usd-high', level: 'info', module: '匯率', title: `美元/台幣 ${usdTwd} 已達 ${fxHigh} 以上`,
      detail: '進入「美元→台幣」分批區：可考慮把部分美元分 2–3 批換回台幣，而非一次全換。' });
  } else if (usdTwd <= fxLow) {
    out.push({ key: 'fx-usd-low', level: 'info', module: '匯率', title: `美元/台幣 ${usdTwd} 已低於 ${fxLow}`,
      detail: '進入「台幣→美元」分批區：可考慮分批換美元，補足海外投資的銀彈。' });
  }

  // 🎉 淨值目標達成（使用者 2026-07-23 拍板：達標要在新聞牆報喜一次——推翻 P1 原「只在目標卡顯示」的決定）。
  // 穩定 key `goal-reached`＝D2 規約：首次達標→🆕 報喜一次、之後收進「持續中」不重播。level=info＝不灌進
  // 「需要處理」計數（好消息不是待辦）。已知邊角（P1 顧慮、使用者接受）：跌回目標下／調高／清除目標時
  // 提醒消失→新聞牆顯示「✓ 已解除」——跌回時這是誠實的報憂；調高目標時語意稍怪但只出現一次，可接受。
  const goal = computeGoalTracking(db);
  if (goal?.reached) {
    out.push({ key: 'goal-reached', level: 'info', module: '目標', title: '🎉 已達成淨值目標',
      detail: `目前淨資產 ${fmt(goal.current)}，已達成你設定的目標 ${fmt(goal.target)}。可以到「設定」訂下一個目標。` });
  }

  const order = { danger: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  return out;
}

/** @param {Db} db */
function computeAllocation(db) {
  const { byClass, assets } = computeAssets(db);
  /** @type {Record<string, number>} */
  const targets = Object.create(null);   // 同 byClass：目標類別名是使用者文字（Codex r6#3 掃蕩同型）
  for (const t of db.assetTargets || []) targets[t.class] = Number(t.targetPct || 0);
  const classes = new Set([...Object.keys(byClass), ...Object.keys(targets)]);
  const rows = [];
  for (const c of classes) {
    const val = byClass[c] || 0;
    const actualPct = assets > 0 ? (val / assets) * 100 : 0;
    const targetPct = targets[c] || 0;
    rows.push({ class: c, value: val, actualPct, targetPct, diff: actualPct - targetPct });
  }
  rows.sort((a, b) => b.value - a.value);
  return { rows, total: assets };
}

// 投資組合：從 holdings（核心/債券/衛星/個股/投機）計算，各幣別換算成台幣
/** @param {Db} db */
export function computeIb(db) {
  const rates = fxRates(db);
  const missing = missingFxTracker();
  const positions = (db.holdings || []).map(h => {
    const f = fxFor(rates, h.currency);   // 缺 currency 預設台幣（與帳戶端一致），避免台股被當美元灌 32 倍
    if (f.missing && Number(h.quantity || 0) !== 0) missing.add(f.cur);   // 零股數不算曝險
    const fx = f.missing ? 0 : f.rate;    // 缺匯率＝市值／成本記 0 並帶 fxMissing（自然不進總數；乙）
    const marketValue = Number(h.price || 0) * Number(h.quantity || 0) * fx;
    const costBasis = holdingCost(h) * fx;
    return { ...h, marketValue, costBasis, unrealizedPnl: marketValue - costBasis, weight: 0, pnlPct: 0, fxMissing: f.missing };
  });
  const totalMv = positions.reduce((s, p) => s + p.marketValue, 0);
  for (const p of positions) {
    p.weight = totalMv > 0 ? (p.marketValue / totalMv) * 100 : 0;
    p.pnlPct = p.costBasis ? (p.unrealizedPnl / Math.abs(p.costBasis)) * 100 : 0;
  }
  positions.sort((a, b) => b.marketValue - a.marketValue);
  return {
    positions, totalValue: totalMv,
    totalCost: positions.reduce((s, p) => s + p.costBasis, 0),
    totalPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    missingFx: missing.list()
  };
}

// IB 融資槓桿與斷頭距離（單一真相）：優先用 IB 官方淨值摘要 settings.ib.lastEquity
// （同步時更新、基準幣別 USD），沒有才自算（source:'ib' 持倉 ÷ 淨值、融資＝ibCashCur 負餘額）。
// 提醒規則 7 與 buildSummary 都用它；與前端 public/modules/portfolio.js 為同步點（AGENTS.md）。
/** @param {Db} db @param {ReturnType<typeof computeIb>} ib */
export function computeLeverage(db, ib) {
  const s = db.settings || {};
  const rates = fxRates(db);
  const eqIb = s.ib?.lastEquity;
  let ibValue, negCash;
  // 官方淨值摘要：持股>0、**或**現金為負（欠款）就採用（Codex r10#1）——原本只看 stock>0，
  // 全部持股遭平倉後只剩欠款（stock=0, cash<0）會被判成「沒有官方資料」退回本機自算，
  // 而本機帳戶此時多半也清空 → 融資訊號整個消失、淨值歸負卻不警告（最壞情境反而無感）。
  if (eqIb && (Number(eqIb.stock) > 0 || Number(eqIb.cash) < 0)) {
    ibValue = Number(eqIb.stock) * rates.USD;
    negCash = Math.min(Number(eqIb.cash) || 0, 0) * rates.USD;
  } else {
    ibValue = (ib.positions || []).filter(p => p.source === 'ib').reduce((sum, p) => sum + p.marketValue, 0);
    negCash = (db.accounts || []).filter(a => a.ibCashCur).reduce((sum, a) => {
      const f = fxFor(rates, a.currency);
      if (f.missing) return sum;   // 缺匯率＝不計入（乙）。這筆負現金在 computeAssets 會算成「缺匯率的負債」，提醒 fx-missing 升 danger 講明融資與槓桿被低估
      const v = Number(a.balance || 0) * f.rate;
      return v < 0 ? sum + v : sum;
    }, 0);
  }
  const hasLoan = negCash < 0;   // 有欠款就成立（Codex r10#1）——不再要求 ibValue>0，否則持股歸零只剩欠款時判不出融資
  const net = ibValue + negCash;
  const leverage = hasLoan ? (net > 0 ? ibValue / net : Infinity) : 1;
  const maintPct = portfolioCaps(s).maint;
  // 斷頭距離語意（Codex r11#3）：100 是「無借款＝最安全」專用值；「有借款但持股歸零」是比貼線更慘的
  // 狀態（已遭平倉/淨值轉負），必須回 0——原本兩種情境共用 100，/api/summary 把最危險講成最安全，
  // 且與前端 portfolio.js marginCallDistance（同情境 null→顯示 0%）口徑相反（同步點）。
  const mcDist = hasLoan
    ? (ibValue > 0 ? Math.max(0, 1 - (-negCash) / ((1 - maintPct / 100) * ibValue)) * 100 : 0)
    : 100;
  return { leverage, loan: -negCash, ibValue, mcDist, maintPct, hasLoan };
}

/** @param {Db} db 從 data/store.json 載入的整個資料庫 */
export function buildSummary(db) {
  const assets = computeAssets(db);
  const cashflow = computeCashflow(db);
  const cashflowHistory = computeCashflowHistory(db);
  const goalTrack = computeGoalTracking(db);
  const reminders = computeReminders(db);
  const allocation = computeAllocation(db);
  const ib = computeIb(db);
  const lev = computeLeverage(db, ib);
  // 本月固定訂閱：與訂閱頁同口徑（停用當月的月繳不計），避免總覽與訂閱頁數字打架
  const nowMk = monthKey();
  const subsMonthly = (db.subscriptions || []).reduce((s, x) => s + subCostForMonth(x, nowMk), 0);
  return {
    netWorth: assets.netWorth, assets: assets.assets, liabilities: assets.liabilities,
    missingFx: assets.missingFx,   // 缺匯率未計入的筆數（乙）：總覽就地標註用
    byClass: assets.byClass, cashflow, cashflowHistory, goalTrack, reminders, allocation,
    // computeIb 已換算為台幣；leverage 為 IB 融資槓桿（無融資時為 1）
    // leverage=Infinity（淨值≤0）經 res.json 會變 null、前端 Number(null)=0 顯示成「0.00x」——
    // 最危險的狀態被畫成幾乎無槓桿（自主體檢）。序列化前轉明確訊號：equityWiped 旗標＋null。
    ib: { totalValue: ib.totalValue, totalPnl: ib.totalPnl, count: ib.positions.length,
      leverage: Number.isFinite(lev.leverage) ? lev.leverage : null,
      equityWiped: lev.hasLoan && !Number.isFinite(lev.leverage),
      loan: lev.loan, mcDist: lev.mcDist, hasLoan: lev.hasLoan },
    subscriptions: { monthly: subsMonthly, yearly: subsMonthly * 12,
      count: (db.subscriptions || []).filter(subActive).length },
    insuranceCount: (db.insurance || []).length,
    snapshots: db.snapshots || []
  };
}

// 明細金額：整數 + 千分位 +「元」後綴（與前端 app.js money() 一致；負號用 U+2212）
function fmt(n) { const v = Number(n || 0); return (v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('en-US') + ' 元'; }
function cycleLabel(c) {
  return { monthly: '月', quarterly: '季', semiannual: '半年', yearly: '年', single: '躉繳' }[c] || c || '—';
}
