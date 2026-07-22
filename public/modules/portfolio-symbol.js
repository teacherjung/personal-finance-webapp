// @ts-check
// 投資代號的單一身分規則：前後空白不屬於代號，大小寫也不應拆成不同標的。

/** @param {unknown} value */
export const normalizePortfolioSymbol = (value) => String(value || '').trim().toUpperCase();
