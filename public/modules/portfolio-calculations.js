// @ts-check
// 投資組合頁的純計算工具：不碰 DOM、API 或頁面狀態，方便獨立驗證金額口徑。

// 匯率表＝./fx-rates.js 的唯一實作（後端 lib/derive.js 也 import 同一份；丙：上次抓到的 → 預設值，不支援的幣別才不計入）。
export { resolveFxTable, fxFor, fxUsageTracker, FX_DEFAULT_TWD } from './fx-rates.js';
/** 既有呼叫端只要匯率值：`{TWD:1, USD, GBP, JPY}`（沒抓到的幣別已填預設值）。 @param {any} settings */
export const fxTable = (settings) => resolveFxTable(settings).rates;
import { resolveFxTable, fxFor } from './fx-rates.js';

// 成本＝均價 × 股數（舊資料退回總成本欄位）
export const holdingCost = (h) => (h.avgCost != null && h.avgCost !== '')
  ? Number(h.avgCost) * Number(h.quantity || 0)
  : Number(h.cost || 0);

// 斷頭距離：市場再跌 x% 觸及 IB 強平線（借款固定、資產縮水；假設全部持倉維持率一致的近似值）
// x = 1 − 借款 ÷ ((1 − 維持率) × 持倉市值)
export function marginCallDistance(ibValTwd, loanTwd, maintPct) {
  if (!(loanTwd > 0) || !(ibValTwd > 0)) return null;
  return Math.max(0, 1 - loanTwd / ((1 - maintPct / 100) * ibValTwd)) * 100;
}

// 交易已實現損益 → 基準幣別（USD）。優先序（AGENTS.md）：
// pnlBase → fxRateToBase → USD 直通 → 設定匯率估算（source 'estimated'）→ 預設匯率估算（source 'default'；丙-2，William 2026-09-04 裁）
// → 不支援的幣別才是 missing(0)。匯率表＝fx-rates.js 唯一實作（與資產換算同一份）。
export function tradePnlBase(t, settings = {}) {
  const pnl = Number(t.pnl) || 0;
  // ⚠️ 缺幣別不冒充 USD（2026-07-28 修，與 lib/ib.js 的同步點）：空字串會一路落到最後的
  // `source: 'missing'`，tradeSummary 因此把它列進「缺匯率不計入」的註記——看得見的退化勝過默默算錯。
  const cur = String(t.currency || '').toUpperCase();
  if (t.pnlBase != null && t.pnlBase !== '' && Number.isFinite(Number(t.pnlBase)))
    return { base: Number(t.pnlBase), source: cur === 'USD' ? 'usd' : 'ibkr', cur };
  if (t.fxRateToBase != null && t.fxRateToBase !== '' && Number.isFinite(Number(t.fxRateToBase)) && Number(t.fxRateToBase) > 0)
    return { base: pnl * Number(t.fxRateToBase), source: cur === 'USD' ? 'usd' : 'ibkr', cur };
  if (cur === 'USD') return { base: pnl, source: 'usd', cur };
  if (!cur) return { base: 0, source: 'missing', cur };   // 缺幣別 ≠ 缺匯率：不可借 fxFor 的「缺 currency 預設台幣」判準（那是帳戶／持股的），交易缺幣別一律列「未知幣別」
  const table = resolveFxTable(settings);
  const f = fxFor(table, cur);
  if (f.missing) return { base: 0, source: 'missing', cur };   // 不支援的幣別：無法換算
  const usedDefault = f.source === 'default' || table.sources.USD === 'default';   // 分子或分母任一邊是預設值＝整筆算「預設匯率估算」
  return { base: pnl * (f.rate / table.rates.USD), source: usedDefault ? 'default' : 'estimated', cur };
}

export function tradeSummary(trades, settings = {}) {
  const ibkr = new Set();
  const estimated = new Set();
  const defaulted = new Set();   // 用預設匯率估的幣別（丙-2）：計入但要另外標
  const missing = new Set();
  const pnlBase = (t) => {
    const { base, source, cur } = tradePnlBase(t, settings);
    if (cur !== 'USD') {
      if (source === 'ibkr') ibkr.add(cur);
      else if (source === 'estimated') estimated.add(cur);
      else if (source === 'default') defaulted.add(cur);
      // 缺幣別時 cur 是空字串——直接放進去畫面會出現一個空白的頓號（提示亮了卻沒說是什麼）。
      else if (source === 'missing') missing.add(cur || '未知幣別');
    }
    return base;
  };
  const realized = trades.reduce((s, t) => s + pnlBase(t), 0);
  const bySym = Object.create(null);   // 代號來自 IB/備份匯入的自由字串，避免撞到原型鍵。
  trades.forEach(t => { const p = pnlBase(t); if (p) bySym[t.symbol] = (bySym[t.symbol] || 0) + p; });
  const sorted = Object.entries(bySym).sort((a, b) => b[1] - a[1]);
  return {
    realized,
    winners: sorted.filter(x => x[1] > 0).slice(0, 3),
    losers: sorted.filter(x => x[1] < 0).slice(-3).reverse(),
    ibkrCurrencies: [...ibkr],
    estimatedCurrencies: [...estimated],
    defaultCurrencies: [...defaulted],
    missingCurrencies: [...missing]
  };
}

/**
 * 依月快照、IB 賣出損益與今日市值計算資金加權年化報酬。
 * @param {Array<{month: string, value?: number, cost?: number}>} psnaps
 * @param {number} curCost
 * @param {number} curValue
 * @param {Array<object>|undefined} ibTrades
 * @param {(value: string) => Date} parseLocalDate
 * @param {object} [settings]
 * @param {Date} [now]
 * @returns {{ok: false, why: string}|{ok: true, rate: number, years: number, estimated: boolean}}
 */
export function portfolioXirr(psnaps, curCost, curValue, ibTrades, parseLocalDate, settings = {}, now = new Date()) {
  if (!Array.isArray(psnaps) || !psnaps.length || !(curValue > 0)) return { ok: false, why: '需先記錄月快照' };
  const today = new Date(now.getTime()); today.setHours(0, 0, 0, 0);
  const eom = (mk) => {   // 快照時點以月底近似（本月快照則視為今天）
    const [y, m] = mk.split('-').map(Number);
    const d = new Date(y, m, 0);
    return d > today ? today : d;
  };
  const flows = [{ t: eom(psnaps[0].month), v: -Number(psnaps[0].value || 0) }];
  for (let i = 1; i < psnaps.length; i++) {
    flows.push({ t: eom(psnaps[i].month), v: -(Number(psnaps[i].cost || 0) - Number(psnaps[i - 1].cost || 0)) });
  }
  const t0 = flows[0].t;
  // 賣出時投入額只減成本，已實現損益要另外補回現金流。換算與交易摘要同口徑
  // （tradePnlBase：pnlBase→fxRateToBase→USD→設定匯率估算→預設匯率估算），避免漏估外幣賣出讓年化偏低。
  // 「含估算」旗標（Codex #557 r1）：①只在那筆**真的進了現金流**之後才點（日期守門前點亮＝誤標）；
  // ②每筆 base 都要再乘 usd（USD→TWD）——美元匯率本身是預設值時，整條年化都算估算，連 USD 交易也是。
  // 乘數（USD→TWD）與「是否預設值」**同一張表、同一次解出**（Codex #557 r2）：以前乘數是呼叫端另傳的 usd 參數，
  // 值與來源可以分離——考題用 usd=1 配 settings={} 也綠。現在呼叫端不能再傳別的乘數。
  const fxTable = resolveFxTable(settings);
  const usd = fxTable.rates.USD;
  const usdIsDefault = fxTable.sources.USD === 'default';
  let estimated = false;
  for (const tr of ibTrades || []) {
    if (tr.buySell !== 'SELL') continue;
    const { base, source } = tradePnlBase(tr, settings);
    if (source === 'missing' || !base) continue;
    const ds = String(tr.date || '');
    const d = parseLocalDate(/^\d{8}$/.test(ds) ? `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6)}` : ds);   // 本地解析（XIRR 其他日期都是本地時區）
    if (isNaN(d.getTime()) || d <= t0) continue;
    flows.push({ t: d > today ? today : d, v: base * usd });
    if (source === 'estimated' || source === 'default' || usdIsDefault) estimated = true;
  }
  const lastCost = Number(psnaps[psnaps.length - 1].cost || 0);
  flows.push({ t: today, v: curValue - (curCost - lastCost) });   // 期末市值＋最後一筆快照之後的投入增量
  flows.sort((a, b) => a.t.getTime() - b.t.getTime());
  const spanDays = (today.getTime() - t0.getTime()) / 86400000;
  if (spanDays < 60) return { ok: false, why: '快照未滿兩個月' };
  const r = xirrRate(flows);
  if (r == null) return { ok: false, why: '無法計算' };
  // 年化超過 ±500% 代表資料有問題（如快照與市值口徑不符），不顯示誤導數字
  if (Math.abs(r) > 5) return { ok: false, why: '資料異常（檢查快照是否為真實紀錄）' };
  return { ok: true, rate: r * 100, years: spanDays / 365.25, estimated };
}

// 解 XIRR：對 NPV(r)=Σ v/(1+r)^年 做二分法（區間 −95%～+1000%）
export function xirrRate(flows) {
  const t0 = flows[0].t;
  const yrs = (f) => (f.t - t0) / 31557600000;   // 365.25 天
  const npv = (r) => flows.reduce((s, f) => s + f.v / Math.pow(1 + r, yrs(f)), 0);
  let lo = -0.95, hi = 1e4, flo = npv(lo);
  const fhi = npv(hi);   // 只用於下行的同號檢查，二分法過程不更新它
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}
