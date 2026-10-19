// @ts-check
import { isRealDate } from './calendar-date.js';

export const IB_INCOME_PERIOD_BASIS = 'ib-flex-single-statement-v1';
/** @typedef {{from:string,to:string,label:string}} IncomePeriod */
/** @typedef {{ok:true,period:IncomePeriod}|{ok:false,reason:string}} RecordedPeriod */

/** Flex 原字串不能用 Date.parse 猜格式，以免缺日的月份被當成完整起訖。
 * @param {unknown} value */
function rawDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null;
  const iso = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8);
  return isRealDate(iso) ? iso : null;
}

/** 只驗期間形狀；這不是來源證明。 @param {any} value @returns {IncomePeriod|null} */
export function incomePeriodDates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const from = Object.hasOwn(value, 'from') ? rawDate(value.from) : null;
  const to = Object.hasOwn(value, 'to') ? rawDate(value.to) : null;
  if (!from || !to || from > to) return null;
  return { from, to, label: from.replaceAll('-', '/') + '–' + to.replaceAll('-', '/') };
}

/** 讀取保存的來源資格，不在讀頁或還原時創造新資格。
 * @param {any} income @returns {RecordedPeriod} */
export function recordedIncomePeriod(income) {
  if (!income || typeof income !== 'object' || Array.isArray(income)) return { ok: false, reason: 'income-unavailable' };
  if (!Object.hasOwn(income, 'periodBasis') || income.periodBasis !== IB_INCOME_PERIOD_BASIS) {
    return { ok: false, reason: 'period-unverified' };
  }
  const period = incomePeriodDates(income);
  return period ? { ok: true, period } : { ok: false, reason: 'period-invalid' };
}

/** 活動與列印共用口徑，避免截成月份後暗示完整月報。 @param {any} income */
export function incomePeriodLabel(income) {
  const recorded = recordedIncomePeriod(income);
  if (recorded.ok) return recorded.period.label;
  const dates = incomePeriodDates(income);
  return dates ? dates.label + '；單報表期間尚未核對' : '期間資料不完整或無效，尚未核對';
}
