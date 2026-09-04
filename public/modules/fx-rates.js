// @ts-check
// 匯率表的**唯一實作**（前後端共用：後端 lib/derive.js 直接 import 這裡，與 categories.js 的做法相同）。
//
// 「丙」（William 2026-09-04 裁，取代 09-03 的「乙」）：不管哪種外幣，缺匯率都同一條規則——
//   ① 先用上次抓到的匯率（settings.usdTwd／settings.fxTwd；來源＝Yahoo → 備援 API，見 lib/services/market-data.js）
//   ② 真的沒有才用預設值 FX_DEFAULT_TWD——匯率波動通常不大、誤差可接受；**部位照常計入**，但畫面要標「用了預設匯率」
//   ③ 不支援的幣別（表上沒有、也沒有預設）才無法換算＝不計入並標註（極少見：帳戶／持股表單只給四種幣別）
// 這裡刻意沒有任何 `|| 1`：未知幣別不可被當成台幣。
export const FX_DEFAULT_TWD = Object.freeze({ USD: 31, GBP: 41, JPY: 0.2 });   // William 2026-09-04 裁：第一次用、又沒網路時用的值
export const SUPPORTED_FX = Object.freeze(['USD', 'GBP', 'JPY']);

/** 正數才算匯率（0／負數／NaN／字串垃圾都當「沒有」）。 @param {unknown} v */
export const positiveRate = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
/**
 * 四捨五入到 1/scale 之後**再驗一次**正數：有限正數乘上 scale 可能溢位成 Infinity、太小會捨成 0——
 * 這兩種寫進 JSON 都會變 null／0 而把舊匯率清掉（Codex #556 r4）。回 null＝不要寫。
 * @param {unknown} v @param {number} scale
 */
export const roundRate = (v, scale) => { const r = positiveRate(v); if (r == null) return null; const out = Math.round(r * scale) / scale; return Number.isFinite(out) && out > 0 ? out : null; };

/**
 * @typedef {{ rates: Record<string, number>, sources: Record<string, 'live'|'default'> }} FxTable
 * `rates`＝各幣別兌台幣（TWD 恆為 1）；`sources`＝每種外幣是「上次抓到的」還是「預設值」。
 */

/**
 * 由設定解出匯率表。
 * @param {{ usdTwd?: unknown, fxTwd?: Record<string, unknown> } | null | undefined} settings
 * @returns {FxTable}
 */
export function resolveFxTable(settings) {
  const s = settings || {};
  const fxTwd = /** @type {Record<string, unknown>} */ (s.fxTwd && typeof s.fxTwd === 'object' ? s.fxTwd : {});
  /** @type {Record<string, number>} */ const rates = { TWD: 1 };
  /** @type {Record<string, 'live'|'default'>} */ const sources = {};
  for (const cur of SUPPORTED_FX) {
    const live = cur === 'USD' ? positiveRate(s.usdTwd) : positiveRate(fxTwd[cur]);
    rates[cur] = live ?? FX_DEFAULT_TWD[/** @type {'USD'|'GBP'|'JPY'} */ (cur)];
    sources[cur] = live == null ? 'default' : 'live';
  }
  return { rates, sources };
}

/**
 * 一筆金額該用的匯率。缺 currency 預設台幣（既有判準，與帳戶端一致）。
 * @param {FxTable} table @param {unknown} currency
 * @returns {{ cur: string, rate: number, source: 'twd'|'live'|'default', missing: false } | { cur: string, rate: null, source: 'unsupported', missing: true }}
 */
export function fxFor(table, currency) {
  const cur = String(currency || 'TWD').toUpperCase();
  if (cur === 'TWD') return { cur, rate: 1, source: 'twd', missing: false };
  if (Object.hasOwn(table.rates, cur)) return { cur, rate: table.rates[cur], source: table.sources[cur], missing: false };
  return { cur, rate: null, source: 'unsupported', missing: true };
}

/**
 * 「用了預設匯率」與「不支援的幣別」兩張累計表（順序＝首次出現）。只登記**真的有曝險**的列（零餘額／零股數不算）。
 * defaultFx：[{currency, count, rate}]；missingFx：[{currency, count, liabilities}]（liabilities＝其中幾筆是負債：負餘額或負債型帳戶）。
 */
export function fxUsageTracker() {
  /** @type {Map<string, {count:number, rate:number}>} */ const dflt = new Map();
  /** @type {Map<string, {count:number, liabilities:number}>} */ const miss = new Map();
  return {
    /** @param {ReturnType<typeof fxFor>} f @param {boolean} [liability] */
    note(f, liability = false) {
      if (f.missing) { const v = miss.get(f.cur) || { count: 0, liabilities: 0 }; v.count += 1; if (liability) v.liabilities += 1; miss.set(f.cur, v); return; }
      if (f.source === 'default') { const v = dflt.get(f.cur) || { count: 0, rate: f.rate }; v.count += 1; dflt.set(f.cur, v); }
    },
    defaultFx() { return [...dflt].map(([currency, v]) => ({ currency, count: v.count, rate: v.rate })); },
    missingFx() { return [...miss].map(([currency, v]) => ({ currency, count: v.count, liabilities: v.liabilities })); }
  };
}
