// @ts-check
// 月份選單共用件（系統優化 U4，選配）：transactions 與 cashflow 兩頁逐字相同的
// 「從資料推月份清單 → 回退最新月 → <select> 選項標記」歸戶成三個具名純函式。
// 刻意的小（Codex 修訂：不為它造 UI 框架）；零依賴、esc 由呼叫端注入 → node --test 可直測。
// 證券頁的期間快選（datePresetRange）是另一套篩選系統，不屬本件範圍。

/** 從交易列推出「有資料的月份」清單（YYYY-MM，新→舊）。 @param {any[]} rows @returns {string[]} */
export function deriveMonths(rows) {
  return [...new Set((rows || []).map(t => (typeof t?.date === 'string' ? t.date.slice(0, 7) : '')).filter(Boolean))].sort().reverse();
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
