// @ts-check
// 月份選單共用件（系統優化 U4，選配）：transactions 與 cashflow 共用
// 「從資料推月份清單 → 回退最新月」；收支頁再用同檔的年／月純函式拆成兩組選單。
// 刻意的小（Codex 修訂：不為它造 UI 框架）；零依賴、esc 由呼叫端注入 → node --test 可直測。
// 證券頁的期間快選（datePresetRange）是另一套篩選系統，不屬本件範圍。

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 從交易列推出「有資料的月份」清單（YYYY-MM，新→舊）。 @param {any[]} rows @returns {string[]} */
export function deriveMonths(rows) {
  return [...new Set((rows || [])
    .map(t => (typeof t?.date === 'string' ? t.date.slice(0, 7) : ''))
    .filter(month => MONTH_KEY_RE.test(month)))].sort().reverse();
}

/** 從月份鍵推出年份清單（YYYY，新→舊）。 @param {string[]} months @returns {string[]} */
export function deriveYears(months) {
  return [...new Set((months || [])
    .map(month => String(month))
    .filter(month => MONTH_KEY_RE.test(month))
    .map(month => month.slice(0, 4)))].sort().reverse();
}

/** 指定年份中有資料的月份（MM，新→舊）。 @param {string[]} months @param {string} year @returns {string[]} */
export function monthNumbersForYear(months, year) {
  return (months || [])
    .map(month => String(month))
    .filter(month => MONTH_KEY_RE.test(month) && month.startsWith(`${year}-`))
    .map(month => month.slice(5, 7));
}

/** 目前選的月份不在清單時回退最新月；清單空＝保留原值（畫面顯示唯一選項）。 @param {string} cur @param {string[]} months */
export function fallbackMonth(cur, months) {
  return (!months.includes(cur) && months.length) ? months[0] : cur;
}

/** <select> 的 options 標記（含目前選中；清單空時顯示目前值當唯一選項）。
 * @param {string[]} months @param {string} cur @param {(s: any) => string} esc */
export function monthOptionsHtml(months, cur, esc) {
  return months.map(m => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('')
    || `<option>${esc(cur)}</option>`;
}

/** 年份選單 options；清單空時仍保留目前年份。 @param {string[]} years @param {string} cur @param {(s: any) => string} esc */
export function yearOptionsHtml(years, cur, esc) {
  const list = years.length ? years : [cur];
  return list.map(year => `<option value="${esc(year)}" ${year === cur ? 'selected' : ''}>${esc(year)} 年</option>`).join('');
}

/** 月份選單 options；值維持兩位數，畫面顯示自然月數。 @param {string[]} months @param {string} cur @param {(s: any) => string} esc */
export function monthNumberOptionsHtml(months, cur, esc) {
  const list = months.length ? months : [cur];
  return list.map(month => `<option value="${esc(month)}" ${month === cur ? 'selected' : ''}>${Number(month)} 月</option>`).join('');
}
