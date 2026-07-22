// @ts-check
// 投資頁共用數字格式：統一 K／萬／百分比與 NT／US 雙計價，不碰頁面狀態。

/** @param {number} value */
export function formatK(value) {
  const scaled = value / 1000;
  return Math.abs(scaled) >= 10 ? Math.round(scaled).toLocaleString('en-US') : scaled.toFixed(1);
}

/** @param {number} value */
export function formatWan(value) {
  const scaled = value / 10000;
  return Math.abs(scaled) >= 10 ? Math.round(scaled).toLocaleString('en-US') : scaled.toFixed(1);
}

/** @param {unknown} value @param {number} [digits] */
export function formatPercent(value, digits = 1) {
  return (Number(value) || 0).toFixed(digits) + '%';
}

/**
 * 把台幣金額依目前檢視模式顯示為「萬」或「K USD」。
 * @param {unknown} twd
 * @param {{ viewCurrency:string, usdRate:number }} options
 */
export function formatPortfolioMoney(twd, { viewCurrency, usdRate }) {
  const amount = Number(twd || 0);
  const sign = amount < 0 ? '−' : '';
  const value = Math.abs(amount);
  return viewCurrency === 'USD'
    ? sign + formatK(value / usdRate) + ' K USD'
    : sign + formatWan(value) + ' 萬';
}
