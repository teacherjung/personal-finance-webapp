// @ts-check
// 投資頁衍生狀態：把已算好的持股模型整理成畫面與事件共用的純資料。

import { portfolioXirr } from './portfolio-calculations.js';
import { portfolioCaps, portfolioFreeze } from './portfolio-risk.js';

/** @typedef {{ symbol?:string, layer?:string, valueTwd?:number|string }} StateRow */
/** @typedef {{ month:string, value?:number, cost?:number }} StateSnapshot */
/** @typedef {{ qqqmMaxPct?:number|string, ibConcentrationPct?:number|string, equityCapPct?:number|string, countryCapPct?:number|string, chinaCapPct?:number|string, levCapPct?:number|string, ibMaintenancePct?:number|string }} StateSettings */

/**
 * @param {{
 *   rows:StateRow[], regionMap:Record<string,number>, equityValue:number,
 *   summary?:{netWorth?:number|string}, settings:StateSettings,
 *   snapshots:StateSnapshot[], totalCost:number, totalValue:number,
 *   ibTrades:Array<object>, usdRate:number,
 *   parseLocalDate:(value:string)=>Date, layers:Record<string,unknown>, now?:Date
 * }} input
 */
export function buildPortfolioPageState(input) {
  /** @type {Record<string, number>} */
  const layerValues = {};
  for (const row of input.rows) {
    const layer = row.layer && input.layers[row.layer] ? row.layer : 'satellite';
    layerValues[layer] = (layerValues[layer] || 0) + Number(row.valueTwd || 0);
  }

  const valueOf = (symbol) => input.rows
    .filter(row => (row.symbol || '').toUpperCase() === symbol)
    .reduce((sum, row) => sum + Number(row.valueTwd || 0), 0);
  const qqqm = valueOf('QQQM');
  const cspx = valueOf('CSPX');
  const qqqmShare = qqqm + cspx > 0 ? qqqm / (qqqm + cspx) * 100 : 0;
  const qqqmMax = Number(input.settings.qqqmMaxPct || 30);

  const netWorth = Number(input.summary?.netWorth || 0);
  const caps = portfolioCaps(input.settings);
  const freeze = portfolioFreeze(input.rows, input.regionMap, input.equityValue, netWorth, caps);
  const xirr = portfolioXirr(
    input.snapshots,
    input.totalCost,
    input.totalValue,
    input.ibTrades,
    input.usdRate,
    input.parseLocalDate,
    input.settings,
    input.now
  );

  return { layerValues, qqqmShare, qqqmMax, netWorth, caps, freeze, xirr };
}
