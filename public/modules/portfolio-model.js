// @ts-check
// 投資組合頁的純資料模型：把 API 原始資料換算成畫面共用的台幣金額與資產分組。

import { fxTable, holdingCost } from './portfolio-calculations.js';
import { compOf, regionExposure } from './portfolio-exposure.js';

/** @typedef {{ symbol?: string, layer?: string, currency?: string, price?: number|string, quantity?: number|string, avgCost?: number|string, cost?: number|string, source?: string }} ModelHolding */
/** @typedef {{ name?: string, type?: string, class?: string, currency?: string, balance?: number|string, ibCashCur?: string }} ModelAccount */
/** @typedef {{ usdTwd?: number|string, fxTwd?: Record<string, number|string>, ib?: { lastEquity?: { stock?: number|string, cash?: number|string } } }} ModelSettings */

/**
 * 建立投資頁會重複使用的金額模型。這裡只算資料，不碰 DOM、API 或 localStorage。
 * @param {ModelHolding[]} holdings
 * @param {ModelAccount[]|undefined} accounts
 * @param {ModelSettings} settings
 */
export function buildPortfolioModel(holdings, accounts, settings) {
  const fx = fxTable(settings);
  const accountRows = accounts || [];
  const rows = holdings.map(h => {
    // 缺 currency 預設台幣，與後端 derive 的持股口徑一致。
    const rate = fx[h.currency || 'TWD'] || 1;
    const valueTwd = Number(h.price || 0) * Number(h.quantity || 0) * rate;
    const costTwd = holdingCost(h) * rate;
    return { ...h, valueTwd, costTwd, pnlTwd: valueTwd - costTwd };
  });
  const total = rows.reduce((sum, row) => sum + row.valueTwd, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.costTwd, 0);
  const totalPnl = total - totalCost;

  const bondV = rows.filter(row => compOf(row).type === 'bond').reduce((sum, row) => sum + row.valueTwd, 0);
  const goldV = rows.filter(row => compOf(row).type === 'gold').reduce((sum, row) => sum + row.valueTwd, 0);
  const eqV = total - bondV - goldV;
  const accTwd = (account) => Number(account.balance || 0) * (fx[account.currency || 'TWD'] || 1);

  // IB 融資優先採官方摘要；缺摘要才退回 IB 持股與 ibCashCur 帳戶自行換算。
  const eqIb = settings.ib?.lastEquity;
  let ibValTwd;
  let negCashTwd;
  if (eqIb && (Number(eqIb.stock) > 0 || Number(eqIb.cash) < 0)) {
    ibValTwd = Number(eqIb.stock) * fx.USD;
    negCashTwd = Math.min(Number(eqIb.cash) || 0, 0) * fx.USD;
  } else {
    ibValTwd = rows.filter(row => row.source === 'ib').reduce((sum, row) => sum + row.valueTwd, 0);
    negCashTwd = accountRows.filter(account => account.ibCashCur).reduce((sum, account) => {
      const value = accTwd(account);
      return value < 0 ? sum + value : sum;
    }, 0);
  }
  const loanTwd = -negCashTwd;
  const netEquity = ibValTwd + negCashTwd;
  const hasLoan = loanTwd > 0;
  const leverage = hasLoan ? (netEquity > 0 ? ibValTwd / netEquity : Infinity) : 1;

  const goldAccV = accountRows
    .filter(account => Number(account.balance) > 0 && account.class === '黃金')
    .reduce((sum, account) => sum + accTwd(account), 0);
  const goldAll = goldV + goldAccV;
  const cashV = accountRows
    .filter(account => Number(account.balance) > 0 && account.class !== '黃金' && (account.type === 'cash' || account.class === '現金'))
    .reduce((sum, account) => sum + accTwd(account), 0);
  const allBase = eqV + bondV + cashV + goldAll;

  const stockRows = rows.filter(row => compOf(row).type === 'equity');
  const bondRows = rows.filter(row => compOf(row).type === 'bond');
  const goldRows = rows.filter(row => compOf(row).type === 'gold');
  const cashAccounts = accountRows
    .filter(account => Number(account.balance) > 0 && account.class !== '黃金' && (account.type === 'cash' || account.class === '現金'))
    .map(account => ({ ...account, valueTwd: accTwd(account) }));
  const goldAccounts = accountRows
    .filter(account => Number(account.balance) > 0 && account.class === '黃金')
    .map(account => ({ ...account, valueTwd: accTwd(account) }));

  return {
    fx,
    rows,
    total,
    totalCost,
    totalPnl,
    bondV,
    goldV,
    eqV,
    ibValTwd,
    loanTwd,
    netEquity,
    leverage,
    goldAll,
    cashV,
    allBase,
    stockRows,
    bondRows,
    goldRows,
    cashAccounts,
    goldAccounts,
    regionMap: regionExposure(rows)
  };
}
