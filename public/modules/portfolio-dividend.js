// @ts-check
import { recordedIncomePeriod } from './ib-income-period.js';

/** @typedef {{ok:false,reason:string}} NoDividendResult */
/** @typedef {{ok:true,period:import('./ib-income-period.js').IncomePeriod,gross:number,estimated:boolean}} DividendBasis */
/** @typedef {DividendBasis & {unitPrice:number,units:number}} DividendResult */

/** 配息的稅前合計不能拿缺欄或已知漏筆補零後換算。
 * @param {any} income @returns {DividendBasis|NoDividendResult} */
export function dividendBasis(income) {
  const recorded = recordedIncomePeriod(income);
  if (!recorded.ok) return recorded;
  for (const field of ['dividends', 'paymentInLieu']) {
    if (!Object.hasOwn(income, field) || typeof income[field] !== 'number' || !Number.isFinite(income[field])) {
      return { ok: false, reason: 'amount-unavailable' };
    }
  }
  const gross = income.dividends + income.paymentInLieu;
  if (!Number.isFinite(gross)) return { ok: false, reason: 'amount-overflow' };
  for (const field of ['count', 'skippedNoFx', 'skippedNoCurrency', 'estimatedNoFx']) {
    if (!Object.hasOwn(income, field) || !Number.isSafeInteger(income[field]) || income[field] < 0) {
      return { ok: false, reason: 'quality-unavailable' };
    }
  }
  if (income.skippedNoCurrency > 0) return { ok: false, reason: 'incomplete-currency' };
  if (income.skippedNoFx > 0) return { ok: false, reason: 'incomplete-fx' };
  return { ok: true, period: recorded.period, gross, estimated: income.estimatedNoFx > 0 };
}

/** @param {any} income @param {any} price @returns {DividendResult|NoDividendResult} */
export function dividendEquivalent(income, price) {
  const basis = dividendBasis(income);
  if (!basis.ok) return basis;
  if (!price || typeof price !== 'object' || Array.isArray(price)
      || !Object.hasOwn(price, 'currency') || price.currency !== 'USD') return { ok: false, reason: 'price-currency' };
  if (!Object.hasOwn(price, 'amountText') || typeof price.amountText !== 'string') return { ok: false, reason: 'price-invalid' };
  const text = price.amountText.trim();
  if (!text) return { ok: false, reason: 'price-missing' };
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return { ok: false, reason: 'price-invalid' };
  const unitPrice = Number(text);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return { ok: false, reason: 'price-invalid' };
  const units = basis.gross / unitPrice;
  if (!Number.isFinite(units)) return { ok: false, reason: 'result-overflow' };
  if (basis.gross !== 0 && units === 0) return { ok: false, reason: 'result-out-of-range' };
  return { ...basis, unitPrice, units: Object.is(units, -0) ? 0 : units };
}

const REASONS = {
  'income-unavailable': '尚無報表配息資料，無法換算。',
  'period-unverified': '這筆紀錄的單報表期間尚未核對，請重新同步有效的單份 IB 報表。',
  'period-invalid': '報表起訖日不完整或無效，無法換算。',
  'amount-unavailable': '股息或替代股息金額不完整，無法換算。',
  'amount-overflow': '配息合計超出可表示範圍，無法換算。',
  'quality-unavailable': '收入筆數或品質記錄不完整，無法換算。',
  'incomplete-currency': '有現金交易缺少幣別而未計入，無法換算完整配息。',
  'incomplete-fx': '有現金交易缺少可用匯率而未計入，無法換算完整配息。',
  'price-currency': '參考單價必須以 USD／單位輸入。',
  'price-missing': '請輸入本次參考單價（USD／單位）。',
  'price-invalid': '請輸入有限的正數單價，只用完整十進位數字，不加逗號、幣別或科學記號。',
  'result-overflow': '換算結果超出可表示範圍，無法換算。',
  'result-out-of-range': '數值超出可表示範圍，無法換算。'
};

/** @param {string} reason */
export function dividendReason(reason) {
  return Object.hasOwn(REASONS, reason) ? REASONS[reason] : '資料無法換算。';
}

/** 結果不是金額或下單股數，不用固定小數位把可表示的小量壓成零。
 * @param {DividendResult|NoDividendResult} result */
export function dividendResultText(result) {
  if (!result.ok) return dividendReason(result.reason);
  const units = String(result.units).replaceAll('-', '−');
  return `約 ${units} 參考單位${result.estimated ? '（含匯率估算）' : ''}${result.gross < 0 ? '；負值表示配息沖回。' : result.gross === 0 ? '；本報表配息合計為零。' : ''}`;
}
