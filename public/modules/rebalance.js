// @ts-check
// 再平衡計算器（功能 3-13）：純計算、不碰畫面——node 考題可直接 import 測試。
// 給「目前配置＋目標％」→ 算出各類別該買/賣多少。兩種模式：
//   buyOnly=true（預設）＝「只買不賣」：輸入新資金，只加碼低配的類別、不賣出——
//     符合投資原則「訊號期加碼只用新資金、不舉新債」，也避免賣出的稅費/摩擦。
//   buyOnly=false＝「允許買賣」：算出恢復目標配置的完整買賣清單（加總為 0）。
// 規則：只有「有設目標（targetPct>0）」的類別參與；有錢但沒設目標的類別列在 excluded
//（不參與、不會被當成「目標 0％＝全部賣掉」）。目標％自動正規化（加總非 100 也能算）。

/** @typedef {{class: string, value: number, targetPct: number}} AllocRow */

/**
 * @param {AllocRow[]} rows 各類別目前市值與目標％（computeAllocation 的 rows 即可）
 * @param {{buyOnly?: boolean, cash?: number}} [opts] cash＝只買不賣模式的新資金（台幣）
 * @returns {{rows: {class:string, value:number, currentPct:number, targetPct:number, targetPctNorm:number, delta:number, after:number, afterPct:number}[],
 *            excluded: string[], total: number, targetSum: number, mode: 'buy'|'both'}}
 */
export function rebalancePlan(rows, opts = {}) {
  const buyOnly = opts.buyOnly !== false;
  const cash = Math.max(0, Number(opts.cash) || 0);
  const parts = (rows || [])
    .filter(r => Number(r.targetPct) > 0)
    .map(r => ({ class: String(r.class), value: Math.max(0, Number(r.value) || 0), targetPct: Number(r.targetPct) }));
  const excluded = (rows || []).filter(r => !(Number(r.targetPct) > 0) && Number(r.value) > 0).map(r => String(r.class));
  const tSum = parts.reduce((s, r) => s + r.targetPct, 0);
  const vSum = parts.reduce((s, r) => s + r.value, 0);
  const mode = /** @type {'buy'|'both'} */ (buyOnly ? 'buy' : 'both');
  if (!parts.length || tSum <= 0) return { rows: [], excluded, total: vSum, targetSum: tSum, mode };

  const total = buyOnly ? vSum + cash : vSum;          // 只買不賣＝終局總額含新資金
  const ideal = parts.map(r => total * r.targetPct / tSum);
  /** @type {number[]} */
  let deltas;
  if (!buyOnly) {
    deltas = parts.map((r, i) => ideal[i] - r.value);   // 買賣互抵、加總為 0
  } else {
    // 注水法：先補「低於理想」的缺口；錢不夠→按缺口比例分；錢有剩→按目標比例續投（維持比例）
    const short = parts.map((r, i) => Math.max(0, ideal[i] - r.value));
    const shortSum = short.reduce((s, x) => s + x, 0);
    if (shortSum <= cash) {
      const left = cash - shortSum;
      deltas = short.map((s2, i) => s2 + left * parts[i].targetPct / tSum);
    } else {
      deltas = short.map(s2 => shortSum > 0 ? cash * s2 / shortSum : 0);
    }
  }
  const out = parts.map((r, i) => {
    const after = r.value + deltas[i];
    return {
      class: r.class, value: r.value,
      currentPct: vSum > 0 ? r.value / vSum * 100 : 0,   // 目前佔比（分母＝現有資產，不含新資金）
      targetPct: r.targetPct,
      targetPctNorm: r.targetPct / tSum * 100,
      delta: Math.round(deltas[i]),
      after, afterPct: total > 0 ? after / total * 100 : 0
    };
  });
  return { rows: out, excluded, total, targetSum: tSum, mode };
}
