// @ts-check

/** @typedef {{ month: string, date?: string, netWorth: number }} DashboardSnapshot */
/** @typedef {{ month: string, date: string, netWorth: number|null }} DashboardSnapshotPoint */
/** @typedef {{ month: string, income: number|null, expense: number|null, net: number|null }} DashboardCashflowPoint */

/** @param {any} value */
function isDashboardMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

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
 * @param {any[]} snapshots
 * @returns {Map<string, DashboardSnapshot>}
 */
function snapshotMap(snapshots) {
  /** @type {Map<string, DashboardSnapshot & { _order: number, _dateRank: string }>} */
  const byMonth = new Map();
  for (const [order, row] of (Array.isArray(snapshots) ? snapshots : []).entries()) {
    const month = String(row?.month || '');
    const netWorth = row?.netWorth;
    if (!isDashboardMonth(month) || typeof netWorth !== 'number' || !Number.isFinite(netWorth)) continue;
    const date = isDashboardDate(row?.date) ? String(row.date) : '';
    const dateRank = date || `${month}-00`;
    const old = byMonth.get(month);
    if (old && (old._dateRank > dateRank || (old._dateRank === dateRank && old._order > order))) continue;
    byMonth.set(month, { month, date, netWorth, _order: order, _dateRank: dateRank });
  }
  return new Map([...byMonth].map(([month, { date, netWorth }]) => [month, { month, date, netWorth }]));
}

/**
 * @param {string} currentMonth
 * @param {number=} limit
 */
export function dashboardMonthWindow(currentMonth, limit = 12) {
  if (!isDashboardMonth(currentMonth)) return [];
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 12));
  return Array.from({ length: safeLimit }, (_, index) => offsetMonth(currentMonth, index - safeLimit + 1));
}

/**
 * 月快照固定落在以 currentMonth 結尾的日曆月視窗；缺月保留 null，圖表不把跨月缺口接成相鄰兩點。
 * 同月重複時以日期較新的為準，日期相同則以後出現者為準。
 * @param {any[]} snapshots
 * @param {string} currentMonth
 * @param {number=} limit
 * @returns {DashboardSnapshotPoint[]}
 */
export function dashboardSnapshotSeries(snapshots, currentMonth, limit = 12) {
  const byMonth = snapshotMap(snapshots);
  return dashboardMonthWindow(currentMonth, limit).map(month => {
    const row = byMonth.get(month);
    return row ? { month, date: row.date || '', netWorth: row.netWorth } : { month, date: '', netWorth: null };
  });
}

/**
 * 收支圖與淨資產圖共用同一個日曆月視窗。後端沒有回傳的記帳前月份用 null 表示，不冒充零收支。
 * @param {any[]} rows
 * @param {string} currentMonth
 * @param {number=} limit
 * @returns {DashboardCashflowPoint[]}
 */
export function dashboardCashflowSeries(rows, currentMonth, limit = 12) {
  const byMonth = new Map((Array.isArray(rows) ? rows : [])
    .filter(row => isDashboardMonth(row?.month)
      && typeof row?.income === 'number' && Number.isFinite(row.income)
      && typeof row?.expense === 'number' && Number.isFinite(row.expense)
      && typeof row?.net === 'number' && Number.isFinite(row.net))
    .map(row => [String(row.month), {
      month: String(row.month), income: Number(row.income), expense: Number(row.expense), net: Number(row.net),
    }]));
  return dashboardMonthWindow(currentMonth, limit).map(month => byMonth.get(month)
    || { month, income: null, expense: null, net: null });
}

/**
 * 「本月淨資產變動」只比較本月與緊鄰的上月；缺一邊就明說沒有可比資料。
 * 上月為 0 時仍保留金額差，但百分比不可除以零。
 * @param {any[]} snapshots
 * @param {string} currentMonth
 */
export function dashboardNetWorthChange(snapshots, currentMonth) {
  const byMonth = snapshotMap(snapshots);
  const previousMonth = offsetMonth(currentMonth, -1);
  const current = byMonth.get(currentMonth) || null;
  const previous = byMonth.get(previousMonth) || null;
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
