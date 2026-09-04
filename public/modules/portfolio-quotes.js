// @ts-check
// 投資頁手動更新報價的純備料：整理 Yahoo 代號、匯率與逐筆寫回計畫，不碰 API 或 DOM。

import { positiveRate } from './fx-rates.js';   // 正數才算匯率（丙）
const FX_QUOTE_SYMBOLS = ['TWD=X', 'GBPTWD=X', 'JPYTWD=X'];

/** @typedef {{ id?: string, quoteSymbol?: string, currency?: string }} QuoteHolding */
/** @typedef {{ id?: string, quoteSymbol?: string }} QuoteWatch */
/** @typedef {{ price?: number|string|null, currency?: string }} Quote */

/**
 * @param {QuoteHolding[]} holdings
 * @param {QuoteWatch[]} watchlist
 */
export function portfolioQuoteSymbols(holdings, watchlist) {
  return [...new Set([
    ...holdings.map(holding => holding.quoteSymbol).filter(Boolean),
    ...watchlist.map(item => item.quoteSymbol).filter(Boolean),
    ...FX_QUOTE_SYMBOLS
  ])];
}

/**
 * @param {QuoteHolding[]} holdings
 * @param {QuoteWatch[]} watchlist
 * @param {{ fxTwd?: Record<string, number|string> }} settings
 * @param {Record<string, Quote|undefined>} quotes
 */
export function portfolioQuoteWritePlan(holdings, watchlist, settings, quotes) {
  const fxBody = {};
  // 只有「正數」才寫回（Codex #556 r3）：壞值算成 NaN → JSON 變 null → 現在 null 是合法的「清除」，會把好好的匯率清掉。
  const usd = positiveRate(quotes['TWD=X']?.price), gbp = positiveRate(quotes['GBPTWD=X']?.price), jpy = positiveRate(quotes['JPYTWD=X']?.price);
  if (usd) fxBody.usdTwd = Math.round(usd * 1000) / 1000;
  const fxTwd = { ...(settings.fxTwd || {}) };
  if (gbp) fxTwd.GBP = Math.round(gbp * 1000) / 1000;
  if (jpy) fxTwd.JPY = Math.round(jpy * 10000) / 10000;
  fxBody.fxTwd = fxTwd;

  const holdingWrites = [];
  let skippedHoldings = 0;
  for (const holding of holdings) {
    const quote = holding.quoteSymbol && quotes[holding.quoteSymbol];
    if (!quote || quote.price == null) {
      if (holding.quoteSymbol) skippedHoldings++;
      continue;
    }
    // 缺幣別的舊持股預設 TWD，與投資估值及後端自動報價同口徑。
    if (quote.currency && quote.currency.toUpperCase() !== (holding.currency || 'TWD').toUpperCase()) {
      skippedHoldings++;
      continue;
    }
    holdingWrites.push({ id: holding.id, body: { price: Math.round(Number(quote.price) * 100) / 100 } });
  }

  const watchWrites = [];
  for (const item of watchlist) {
    const quote = item.quoteSymbol && quotes[item.quoteSymbol];
    if (!quote || quote.price == null) continue;
    watchWrites.push({ id: item.id, body: { lastPrice: Math.round(Number(quote.price) * 100) / 100 } });
  }

  return {
    fxBody,
    saveFx: Boolean(fxBody.usdTwd || quotes['GBPTWD=X'] || quotes['JPYTWD=X']),
    holdingWrites,
    watchWrites,
    updatedHoldings: holdingWrites.length,
    skippedHoldings
  };
}
