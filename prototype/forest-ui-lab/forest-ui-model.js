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
]);

export const FOREST_ATMOSPHERES = Object.freeze({
  vibrant: {
    scene: 'assets/forest-return-positive.webp',
    sceneAlt: '陽光明亮、葉影輕動的森林小徑',
    guide: 'assets/guide-return-positive.webp',
    guideAlt: '開心但沉穩的小森森',
    heading: '本月淨資產顯著增加',
    statusClass: 'good',
    statusLabel: '顯著增加'
  },
  positive: {
    scene: 'assets/forest-return-positive.webp',
    sceneAlt: '柔和日光照耀的森林小徑',
    guide: 'assets/guide-return-positive.webp',
    guideAlt: '微笑的小森森',
    heading: '本月淨資產小幅增加',
    statusClass: 'good',
    statusLabel: '小幅增加'
  },
  neutral: {
    scene: 'assets/forest-return-neutral.webp',
    sceneAlt: '薄雲下平靜清楚的森林小徑',
    guide: 'assets/guide-return-neutral.webp',
    guideAlt: '平靜觀察的小森森',
    heading: '本月淨資產接近持平',
    statusClass: 'calm',
    statusLabel: '接近持平'
  },
  negative: {
    scene: 'assets/forest-return-negative.webp',
    sceneAlt: '細雨中的森林小徑',
    guide: 'assets/guide-return-negative.webp',
    guideAlt: '審慎思考的小森森',
    heading: '本月淨資產小幅減少',
    statusClass: 'watch',
    statusLabel: '小幅減少'
  },
  storm: {
    scene: 'assets/forest-return-negative.webp',
    sceneAlt: '雨勢較明顯、仍可看清方向的森林小徑',
    guide: 'assets/guide-return-negative.webp',
    guideAlt: '專注檢查風險的小森森',
    heading: '本月淨資產顯著減少',
    statusClass: 'watch',
    statusLabel: '顯著減少'
  }
});

/** @param {number} value */
export function atmosphereForChange(value) {
  if (value >= 2) return 'vibrant';
  if (value >= .5) return 'positive';
  if (value > -.5) return 'neutral';
  if (value > -2) return 'negative';
  return 'storm';
}

/** @param {readonly any[]} months @param {number} index */
export function netWorthChangeAt(months, index) {
  const current = months[index];
  const previous = months[index - 1];
  if (!current || !previous) return null;
  const amount = Number(current.netWorth) - Number(previous.netWorth);
  const base = Math.abs(Number(previous.netWorth));
  return { amount, pct: base ? amount / base * 100 : null, reason: base ? 'comparable' : 'zero-base' };
}

/** @param {number} index @param {string} key @param {number} count @param {number} columns */
export function moveGridSelection(index, key, count, columns) {
  const last = Math.max(0, Math.trunc(count) - 1);
  const current = Math.min(last, Math.max(0, Math.trunc(index)));
  const rowStep = Math.max(1, Math.trunc(columns));
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  if (key === 'ArrowLeft') return Math.max(0, current - 1);
  if (key === 'ArrowRight') return Math.min(last, current + 1);
  if (key === 'ArrowUp') return Math.max(0, current - rowStep);
  if (key === 'ArrowDown') return Math.min(last, current + rowStep);
  return current;
}

export const DEFAULT_CARD_LAYOUT = Object.freeze([
  { id: 'summary', size: 'full' },
  { id: 'cashflow', size: 'wide' },
  { id: 'guide', size: 'standard' },
  { id: 'holdings', size: 'full' },
  { id: 'valuation', size: 'full' }
]);

const ALLOWED_CARD_SIZES = Object.freeze({
  summary: ['wide', 'full'],
  cashflow: ['standard', 'wide', 'full'],
  guide: ['compact', 'standard', 'wide'],
  holdings: ['wide', 'full'],
  valuation: ['wide', 'full']
});

/** @param {unknown} value */
export function normalizeCardLayout(value) {
  const defaults = new Map(DEFAULT_CARD_LAYOUT.map((item) => [item.id, item]));
  const allowedByCard = /** @type {Record<string, readonly string[]>} */ (ALLOWED_CARD_SIZES);
  const seen = new Set();
  const normalized = [];
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const id = String(/** @type {any} */ (raw).id || '');
      const defaultItem = defaults.get(id);
      if (!defaultItem || seen.has(id)) continue;
      const requested = String(/** @type {any} */ (raw).size || '');
      const allowed = allowedByCard[id] || [];
      normalized.push({ id, size: allowed.includes(requested) ? requested : defaultItem.size });
      seen.add(id);
    }
  }
  for (const item of DEFAULT_CARD_LAYOUT) {
    if (!seen.has(item.id)) normalized.push({ ...item });
  }
  return normalized;
}

/** @param {{id:string,size:string}[]} layout @param {string} id @param {-1|1} direction */
export function moveCard(layout, id, direction) {
  const next = normalizeCardLayout(layout);
  const index = next.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** @param {string} id */
export function allowedSizesForCard(id) {
  const allowedByCard = /** @type {Record<string, readonly string[]>} */ (ALLOWED_CARD_SIZES);
  return [...(allowedByCard[id] || [])];
}
