// @ts-check

export const MONTHLY_FOREST_DATA = Object.freeze([
  { key: '2025-09', label: '9 月', yearLabel: '2025 年 9 月', netWorth: 1090, income: 18.1, expense: 12.8, emergencyMonths: 7.1, discipline: 4 },
  { key: '2025-10', label: '10 月', yearLabel: '2025 年 10 月', netWorth: 1109, income: 18.6, expense: 12.4, emergencyMonths: 7.3, discipline: 4 },
  { key: '2025-11', label: '11 月', yearLabel: '2025 年 11 月', netWorth: 1103, income: 17.9, expense: 13.1, emergencyMonths: 7.2, discipline: 3 },
  { key: '2025-12', label: '12 月', yearLabel: '2025 年 12 月', netWorth: 1132, income: 22.4, expense: 16.8, emergencyMonths: 7.4, discipline: 4 },
  { key: '2026-01', label: '1 月', yearLabel: '2026 年 1 月', netWorth: 1093, income: 18.8, expense: 12.6, emergencyMonths: 7.0, discipline: 3 },
  { key: '2026-02', label: '2 月', yearLabel: '2026 年 2 月', netWorth: 1106, income: 18.2, expense: 12.3, emergencyMonths: 7.2, discipline: 4 },
  { key: '2026-03', label: '3 月', yearLabel: '2026 年 3 月', netWorth: 1128, income: 19.1, expense: 11.7, emergencyMonths: 7.5, discipline: 4 },
  { key: '2026-04', label: '4 月', yearLabel: '2026 年 4 月', netWorth: 1129, income: 17.7, expense: 13.5, emergencyMonths: 7.4, discipline: 4 },
  { key: '2026-05', label: '5 月', yearLabel: '2026 年 5 月', netWorth: 1150, income: 20.4, expense: 10.9, emergencyMonths: 7.8, discipline: 5 },
  { key: '2026-06', label: '6 月', yearLabel: '2026 年 6 月', netWorth: 1238, income: 18.8, expense: 12.2, emergencyMonths: 8.0, discipline: 4 },
  { key: '2026-07', label: '7 月', yearLabel: '2026 年 7 月', netWorth: 1219, income: 19.8, expense: 11.2, emergencyMonths: 7.9, discipline: 3 },
  { key: '2026-08', label: '8 月', yearLabel: '2026 年 8 月', netWorth: 1248, income: 19.8, expense: 11.2, emergencyMonths: 8.2, discipline: 4 }
].map(month => Object.freeze(month)));

/** @param {readonly any[]} months @param {number} index */
export function netWorthChangeAt(months, index) {
  const current = months[index];
  const previous = months[index - 1];
  if (!current || !previous) return null;
  const amount = Number(current.netWorth) - Number(previous.netWorth);
  const base = Math.abs(Number(previous.netWorth));
  return { amount, pct: base ? amount / base * 100 : null, reason: base ? 'comparable' : 'zero-base' };
}

/** @param {readonly any[]} months */
export function netWorthTrendFor(months) {
  if (!Array.isArray(months) || months.length === 0) return null;
  const first = Number(months[0]?.netWorth);
  const last = Number(months[months.length - 1]?.netWorth);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const amount = last - first;
  const base = Math.abs(first);
  return { first, last, amount, pct: base ? amount / base * 100 : null };
}
