// @ts-check
// 投資組合頁的純資料模型：把 API 原始資料換算成畫面共用的台幣金額與資產分組。

import { resolveFxTable, fxFor, fxUsageTracker, holdingCost } from './portfolio-calculations.js';
import { compOf, regionExposure } from './portfolio-exposure.js';
import { LIABILITY_TYPES } from './accounts-model.js';   // 負債型帳戶白名單（缺匯率的負債要另計：方向最危險）

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
  const table = resolveFxTable(settings);   // 與後端 derive 同一份實作（丙）：沒抓到的幣別已填預設值
  const fx = table.rates;
  const accountRows = accounts || [];
  const usage = fxUsageTracker();   // defaultFx／missingFx 與後端 computeAssets 同形狀；只登記真的有曝險的列
  const rows = holdings.map(h => {
    // 缺 currency 預設台幣，與後端 derive 的持股口徑一致；不支援的幣別＝市值／成本記 0 並帶 fxMissing（不進總數）；預設匯率照算。
    const f = fxFor(table, h.currency);
    if (Number(h.quantity || 0) !== 0) usage.note(f);   // 零股數不算曝險
    const rate = f.missing ? 0 : f.rate;
    const valueTwd = Number(h.price || 0) * Number(h.quantity || 0) * rate;
    const costTwd = holdingCost(h) * rate;
    return { ...h, valueTwd, costTwd, pnlTwd: valueTwd - costTwd, fxMissing: f.missing, fxSource: f.source };
  });
  const total = rows.reduce((sum, row) => sum + row.valueTwd, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.costTwd, 0);
  const totalPnl = total - totalCost;

  const bondV = rows.filter(row => compOf(row).type === 'bond').reduce((sum, row) => sum + row.valueTwd, 0);
  const goldV = rows.filter(row => compOf(row).type === 'gold').reduce((sum, row) => sum + row.valueTwd, 0);
  const eqV = total - bondV - goldV;
  // 帳戶只登記一次（accTwd 在下面會被叫好幾次：現金／黃金／融資各算一遍）
  for (const account of accountRows) {
    const f = fxFor(table, account.currency); const bal = Number(account.balance || 0);
    if (bal !== 0) usage.note(f, LIABILITY_TYPES.has(account.type || '') || bal < 0);   // 零餘額不算曝險；負債另計
  }
  const accTwd = (account) => { const f = fxFor(table, account.currency); return f.missing ? 0 : Number(account.balance || 0) * f.rate; };

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
    regionMap: regionExposure(rows),
    defaultFx: usage.defaultFx(),
    missingFx: usage.missingFx()
  };
}
