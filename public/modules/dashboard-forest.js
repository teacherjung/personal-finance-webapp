// @ts-check

/** @typedef {{ month: string, date?: string, netWorth: number }} DashboardSnapshot */

/** @param {any} value */
function isDashboardDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** @param {string} month @param {number} offset */
function offsetMonth(month, offset) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return '';
  const ordinal = Number(match[1]) * 12 + Number(match[2]) - 1 + offset;
  const year = Math.floor(ordinal / 12);
  const value = ordinal - year * 12 + 1;
  return `${year}-${String(value).padStart(2, '0')}`;
}

/**
 * 月快照只留下可比較的資料；同月重複時以日期較新的為準，日期相同則以後出現者為準。
 * @param {any[]} snapshots
 * @param {number=} limit
 * @returns {DashboardSnapshot[]}
 */
export function dashboardSnapshotSeries(snapshots, limit = 12) {
  /** @type {Map<string, DashboardSnapshot & { _order: number, _dateRank: string }>} */
  const byMonth = new Map();
  for (const [order, row] of (Array.isArray(snapshots) ? snapshots : []).entries()) {
    const month = String(row?.month || '');
    const netWorth = Number(row?.netWorth);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isFinite(netWorth)) continue;
    const date = isDashboardDate(row?.date) ? String(row.date) : '';
    const dateRank = date || `${month}-00`;
    const old = byMonth.get(month);
    if (old && (old._dateRank > dateRank || (old._dateRank === dateRank && old._order > order))) continue;
    byMonth.set(month, { month, date, netWorth, _order: order, _dateRank: dateRank });
  }
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 12));
  return [...byMonth.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-safeLimit)
    .map(({ month, date, netWorth }) => ({ month, date, netWorth }));
}

/**
 * 「本月淨資產變動」只比較本月與緊鄰的上月；缺一邊就明說沒有可比資料。
 * 上月為 0 時仍保留金額差，但百分比不可除以零。
 * @param {any[]} snapshots
 * @param {string} currentMonth
 */
export function dashboardNetWorthChange(snapshots, currentMonth) {
  const series = dashboardSnapshotSeries(snapshots);
  const previousMonth = offsetMonth(currentMonth, -1);
  const current = series.find(row => row.month === currentMonth) || null;
  const previous = series.find(row => row.month === previousMonth) || null;
  if (!current) return { status: 'missing-current', currentMonth, previousMonth, current: null, previous, amount: null, pct: null };
  if (!previous) return { status: 'missing-previous', currentMonth, previousMonth, current, previous: null, amount: null, pct: null };
  const amount = current.netWorth - previous.netWorth;
  return {
    status: previous.netWorth === 0 ? 'zero-base' : 'ready',
    currentMonth, previousMonth, current, previous, amount,
    pct: previous.netWorth === 0 ? null : amount / Math.abs(previous.netWorth) * 100,
  };
}

/** @param {string} month */
export function dashboardMonthLabel(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${Number(match[1])} 年 ${Number(match[2])} 月` : month;
}

/**
 * 小森森只反映「是否有待處理提醒」，不把單月淨資產漲跌當成情緒或投資評等。
 * @param {any[]} reminders
 */
export function dashboardGuideState(reminders) {
  const rows = Array.isArray(reminders) ? reminders : [];
  const danger = rows.filter(row => row?.level === 'danger').length;
  const warn = rows.filter(row => row?.level === 'warn').length;
  if (danger) return { mood: 'negative', title: '先處理高優先提醒', detail: `有 ${danger} 項高優先事項，先確認風險再做下一步。` };
  if (warn) return { mood: 'neutral', title: '有幾件事值得留意', detail: `有 ${warn} 項提醒需要確認，不必急著一次處理完。` };
  return { mood: 'positive', title: '今天可以從容檢查', detail: '目前沒有高優先提醒，照原有紀律持續記錄即可。' };
}
