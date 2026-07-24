// @ts-check
// 個股研究五構面評分與歷史：只有完整評分才產生總分，不碰 DOM、API 或資料庫。

export const SCORE_DIMENSIONS = Object.freeze([
  Object.freeze({ key: 'business', label: '商業品質', weight: 25 }),
  Object.freeze({ key: 'financial', label: '財務品質', weight: 25 }),
  Object.freeze({ key: 'valuation', label: '估值安全邊際', weight: 20 }),
  Object.freeze({ key: 'evidence', label: '論點證據', weight: 20 }),
  Object.freeze({ key: 'risk', label: '風險控制', weight: 10 })
]);

/** @typedef {'business'|'financial'|'valuation'|'evidence'|'risk'} ScoreKey */
/** @typedef {{business:number,financial:number,valuation:number,evidence:number,risk:number}} ScoreSnapshot */

/** @param {unknown} value */
function reasonText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {unknown} value */
function validScore(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5;
}

/**
 * @param {unknown} scorecard
 * @param {ScoreKey} key
 */
export function isScoreItemComplete(scorecard, key) {
  if (!scorecard || typeof scorecard !== 'object') return false;
  const card = /** @type {Record<string, any>} */ (scorecard);
  const reasons = card.reasons && typeof card.reasons === 'object' ? card.reasons : {};
  return validScore(card[key]) && Boolean(reasonText(reasons[key]));
}

/**
 * 五項缺一就不計總分；0 分搭配理由是完整且合法的評分。
 * @param {unknown} scorecard
 */
export function scorecardResult(scorecard) {
  const card = scorecard && typeof scorecard === 'object'
    ? /** @type {Record<string, any>} */ (scorecard)
    : {};
  const reasons = card.reasons && typeof card.reasons === 'object' ? card.reasons : {};
  const items = SCORE_DIMENSIONS.map(dimension => {
    const key = /** @type {ScoreKey} */ (dimension.key);
    const complete = isScoreItemComplete(card, key);
    return {
      ...dimension,
      score: validScore(card[key]) ? card[key] : null,
      reason: reasonText(reasons[key]),
      complete
    };
  });
  const completed = items.filter(item => item.complete).length;
  const complete = completed === SCORE_DIMENSIONS.length;
  const total = complete
    ? items.reduce((sum, item) => sum + /** @type {number} */ (item.score) / 5 * item.weight, 0)
    : null;
  return {
    items,
    completed,
    totalItems: SCORE_DIMENSIONS.length,
    complete,
    total,
    displayText: complete ? `${total} 分` : `已評 ${completed}／${SCORE_DIMENSIONS.length} 項`
  };
}

/**
 * @param {unknown} scorecard
 * @returns {ScoreSnapshot|null}
 */
function scoreSnapshot(scorecard) {
  const result = scorecardResult(scorecard);
  if (!result.complete) return null;
  /** @type {Record<string, number>} */
  const scores = {};
  for (const item of result.items) scores[item.key] = /** @type {number} */ (item.score);
  return /** @type {ScoreSnapshot} */ (scores);
}

/** @param {unknown} left @param {unknown} right */
function sameScores(left, right) {
  if (!left || typeof left !== 'object' || !right || typeof right !== 'object') return false;
  return SCORE_DIMENSIONS.every(({ key }) => (
    /** @type {Record<string, any>} */ (left)[key] === /** @type {Record<string, any>} */ (right)[key]
  ));
}

/** @param {string} value */
function isRealIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/** @param {unknown} entry */
function cloneHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const source = /** @type {Record<string, any>} */ (entry);
  return {
    ...source,
    scores: source.scores && typeof source.scores === 'object' ? { ...source.scores } : source.scores
  };
}

/**
 * 只記完整且實際變動的分數；同日更新會取代當日舊值，不修改輸入陣列。
 * 若同日改回前一個狀態，當日紀錄會移除，因為收盤狀態並未形成新變動。
 * @param {unknown} history
 * @param {unknown} scorecard
 * @param {unknown} date
 */
export function updateScoreHistory(history, scorecard, date) {
  const copied = Array.isArray(history) ? history.map(cloneHistoryEntry) : [];
  const scores = scoreSnapshot(scorecard);
  const dateKey = typeof date === 'string' ? date.trim() : '';
  if (!scores || !isRealIsoDate(dateKey)) return copied;

  const withoutDate = copied.filter(entry => (
    !entry || typeof entry !== 'object' || /** @type {Record<string, any>} */ (entry).date !== dateKey
  ));
  const previous = [...withoutDate].reverse().find(entry => (
    entry && typeof entry === 'object' && /** @type {Record<string, any>} */ (entry).scores
  ));
  if (previous && sameScores(/** @type {Record<string, any>} */ (previous).scores, scores)) {
    return withoutDate;
  }

  const total = /** @type {number} */ (scorecardResult(scorecard).total);
  return [...withoutDate, { date: dateKey, total, scores: { ...scores } }];
}
