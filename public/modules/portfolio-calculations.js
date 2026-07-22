// @ts-check
// 投資組合頁的純計算工具：不碰 DOM、API 或頁面狀態，方便獨立驗證金額口徑。

export const fxTable = (settings) => ({
  TWD: 1,
  USD: Number(settings.usdTwd || 32),
  GBP: Number(settings.fxTwd?.GBP || 40.8),
  JPY: Number(settings.fxTwd?.JPY || 0.215)
});

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
// pnlBase → fxRateToBase → USD 直通 → 設定匯率估算 → 缺匯率(0)。
export function tradePnlBase(t, settings = {}) {
  const pnl = Number(t.pnl) || 0;
  const cur = String(t.currency || 'USD').toUpperCase();
  if (t.pnlBase != null && t.pnlBase !== '' && Number.isFinite(Number(t.pnlBase)))
    return { base: Number(t.pnlBase), source: cur === 'USD' ? 'usd' : 'ibkr', cur };
  if (t.fxRateToBase != null && t.fxRateToBase !== '' && Number.isFinite(Number(t.fxRateToBase)) && Number(t.fxRateToBase) > 0)
    return { base: pnl * Number(t.fxRateToBase), source: cur === 'USD' ? 'usd' : 'ibkr', cur };
  if (cur === 'USD') return { base: pnl, source: 'usd', cur };
  const usdTwd = Number(settings.usdTwd || 32);
  const curTwd = cur === 'TWD' ? 1 : Number(settings.fxTwd?.[cur] || 0);
  const rate = (curTwd > 0 && usdTwd > 0) ? curTwd / usdTwd : null;
  if (rate) return { base: pnl * rate, source: 'estimated', cur };
  return { base: 0, source: 'missing', cur };
}

export function tradeSummary(trades, settings = {}) {
  const ibkr = new Set();
  const estimated = new Set();
  const missing = new Set();
  const pnlBase = (t) => {
    const { base, source, cur } = tradePnlBase(t, settings);
    if (cur !== 'USD') {
      if (source === 'ibkr') ibkr.add(cur);
      else if (source === 'estimated') estimated.add(cur);
      else if (source === 'missing') missing.add(cur);
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
    missingCurrencies: [...missing]
  };
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
