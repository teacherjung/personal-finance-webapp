// @ts-check
// 投資原則的純風險規則：前端凍結加碼與後端提醒共用同一組上限口徑。

import { normalizePortfolioSymbol } from './portfolio-symbol.js';

/** @typedef {{ ibConcentrationPct?: number|string, equityCapPct?: number|string, countryCapPct?: number|string, chinaCapPct?: number|string, levCapPct?: number|string, ibMaintenancePct?: number|string }} RiskSettings */
/** @typedef {{ symbol?: string, layer?: string, valueTwd?: number|string }} RiskHolding */

/**
 * 解析投資原則上限。使用 nullish fallback，讓使用者明確設定的 0 保持為 0。
 * @param {RiskSettings} settings
 */
export function portfolioCaps(settings) {
  return {
    stock: Number(settings.ibConcentrationPct ?? 5),
    equity: Number(settings.equityCapPct ?? 90),
    country: Number(settings.countryCapPct ?? 15),
    china: Number(settings.chinaCapPct ?? settings.countryCapPct ?? 15),
    lev: Number(settings.levCapPct ?? 1.3),
    maint: Number(settings.ibMaintenancePct ?? 25)
  };
}

/**
 * 個股部位依標準化代號彙總；紀律顯示與凍結判斷必須共用，不能讓拆單看起來各自安全。
 * @param {RiskHolding[]} rows
 */
export function stockExposureBySymbol(rows) {
  /** @type {Record<string, number>} */
  const totals = Object.create(null);
  for (const row of rows) {
    if (row.layer !== 'stock') continue;
    const symbol = normalizePortfolioSymbol(row.symbol);
    if (!symbol) continue;
    totals[symbol] = (totals[symbol] || 0) + Number(row.valueTwd || 0);
  }
  return totals;
}

/**
 * 算出前端「凍結加碼」名單。同代號不分大小寫合併，避免拆成多筆逃過單一個股上限。
 * @param {RiskHolding[]} rows
 * @param {Record<string, number>} regionMap
 * @param {number} equityValue
 * @param {number} netWorth
 * @param {ReturnType<typeof portfolioCaps>} caps
 */
export function portfolioFreeze(rows, regionMap, equityValue, netWorth, caps) {
  const freeze = { symbols: new Set(), regions: new Set(), equity: false };
  if (!(netWorth > 0)) return freeze;

  for (const [symbol, value] of Object.entries(stockExposureBySymbol(rows))) {
    if (value / netWorth * 100 > caps.stock) freeze.symbols.add(symbol);
  }

  for (const [region, value] of Object.entries(regionMap)) {
    if (region === '美國' || region === '其他') continue;
    const cap = region === '中國' ? caps.china : caps.country;
    if (value / netWorth * 100 > cap) freeze.regions.add(region);
  }
  freeze.equity = equityValue / netWorth * 100 > caps.equity;
  return freeze;
}
