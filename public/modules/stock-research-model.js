// @ts-check
// 個股研究頁的純資料模型：組持股、研究、占比與顯示狀態，不碰 DOM、API 或資料庫。

import { portfolioCaps, portfolioFreeze, stockExposureBySymbol } from './portfolio-risk.js';
import { normalizePortfolioSymbol } from './portfolio-symbol.js';

/** @typedef {{ symbol?: unknown, name?: unknown, currency?: unknown, layer?: unknown, quantity?: unknown, costTwd?: unknown, valueTwd?: unknown, pnlTwd?: unknown }} StockRow */
/** @typedef {{ symbol?: unknown, status?: unknown, scorecard?: unknown, valuationScenarios?: unknown, [key:string]: any }} ResearchEntry */
/** @typedef {'unreviewed'|'watching'|'valid'|'needs-review'|'broken'} ResearchStatus */

export const RESEARCH_STATUS_LABELS = Object.freeze({
  unreviewed: '尚未評估',
  watching: '觀察中',
  valid: '持有論點成立',
  'needs-review': '待重新檢查',
  broken: '論點已破壞'
});

/** @param {unknown} value */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** @param {unknown} value */
function usefulText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 未知狀態只回到「尚未評估」，絕不依價格、損益或分數自行推論研究已破壞。
 * @param {unknown} value
 * @returns {{value:ResearchStatus,label:string}}
 */
export function researchStatusOf(value) {
  const status = typeof value === 'string' ? value : '';
  if (Object.hasOwn(RESEARCH_STATUS_LABELS, status)) {
    return {
      value: /** @type {ResearchStatus} */ (status),
      label: RESEARCH_STATUS_LABELS[/** @type {keyof typeof RESEARCH_STATUS_LABELS} */ (status)]
    };
  }
  return { value: 'unreviewed', label: RESEARCH_STATUS_LABELS.unreviewed };
}

/**
 * 研究與持股共用同一把代號正規化尺；P2 會在寫入端保證一個代號只留一筆。
 * @param {unknown} symbol
 * @param {unknown} research
 * @returns {ResearchEntry|null}
 */
export function findStockResearch(symbol, research) {
  const key = normalizePortfolioSymbol(symbol);
  if (!key || !Array.isArray(research)) return null;
  return research.find(item => item && typeof item === 'object'
    && normalizePortfolioSymbol(item.symbol) === key) || null;
}

/**
 * 合併同代號的個股層持股。金額使用 portfolio-model 已算好的台幣欄位，
 * 不在研究頁另抄匯率或成本公式。
 * @param {unknown} symbol
 * @param {unknown} rows
 */
export function summarizeStockPosition(symbol, rows) {
  const key = normalizePortfolioSymbol(symbol);
  const summary = {
    symbol: key,
    name: '',
    currency: '',
    positionCount: 0,
    quantity: 0,
    costTwd: 0,
    valueTwd: 0,
    pnlTwd: 0,
    held: false
  };
  if (!key || !Array.isArray(rows)) return summary;

  for (const row of /** @type {StockRow[]} */ (rows)) {
    if (!row || row.layer !== 'stock') continue;
    if (normalizePortfolioSymbol(row.symbol) !== key) continue;
    summary.positionCount += 1;
    summary.quantity += finiteNumber(row.quantity);
    summary.costTwd += finiteNumber(row.costTwd);
    summary.valueTwd += finiteNumber(row.valueTwd);
    summary.pnlTwd += finiteNumber(row.pnlTwd);
    if (!summary.name) summary.name = usefulText(row.name);
    if (!summary.currency) summary.currency = usefulText(row.currency).toUpperCase();
  }
  summary.held = summary.quantity !== 0;
  return summary;
}

/**
 * 個股占比分子沿用 stockExposureBySymbol，凍結判斷沿用 portfolioFreeze；
 * 分母由未來 P4 從 /api/summary 傳入。
 * @param {unknown} symbol
 * @param {unknown} rows
 * @param {unknown} netWorth
 * @param {unknown} settings
 */
export function stockAllocationForSymbol(symbol, rows, netWorth, settings = {}) {
  const key = normalizePortfolioSymbol(symbol);
  const sourceRows = Array.isArray(rows) ? /** @type {StockRow[]} */ (rows) : [];
  const safeRows = sourceRows.map(row => ({
    symbol: normalizePortfolioSymbol(row?.symbol),
    layer: row?.layer === 'stock' ? 'stock' : String(row?.layer || ''),
    valueTwd: finiteNumber(row?.valueTwd)
  }));
  const safeSettings = settings && typeof settings === 'object' ? settings : {};
  const caps = portfolioCaps(/** @type {any} */ (safeSettings));
  const denominator = finiteNumber(netWorth);
  const exposures = stockExposureBySymbol(safeRows);
  const valueTwd = key ? finiteNumber(exposures[key]) : 0;
  const freeze = portfolioFreeze(safeRows, {}, 0, denominator, caps);
  return {
    valueTwd,
    netWorth: denominator,
    pct: denominator > 0 ? valueTwd / denominator * 100 : null,
    capPct: caps.stock,
    frozen: key ? freeze.symbols.has(key) : false
  };
}

/**
 * 頁面空狀態不可靠 truthy 猜測，避免賣光後研究消失或無資料時誤建空白研究。
 * @param {boolean} hasHolding
 * @param {boolean} hasResearch
 * @param {boolean} hasSymbol
 */
export function stockResearchAvailability(hasHolding, hasResearch, hasSymbol = true) {
  if (!hasSymbol) {
    return {
      state: 'missing-symbol',
      label: '未指定個股代號',
      canEdit: false,
      canCreate: false,
      autoCreate: false
    };
  }
  if (hasHolding && hasResearch) {
    return {
      state: 'ready',
      label: '研究資料已建立',
      canEdit: true,
      canCreate: false,
      autoCreate: false
    };
  }
  if (hasHolding) {
    return {
      state: 'missing-research',
      label: '尚未撰寫',
      canEdit: false,
      canCreate: true,
      autoCreate: false
    };
  }
  if (hasResearch) {
    return {
      state: 'not-held',
      label: '目前未持有',
      canEdit: true,
      canCreate: false,
      autoCreate: false
    };
  }
  return {
    state: 'empty',
    label: '尚無持股或研究資料',
    canEdit: false,
    canCreate: false,
    autoCreate: false
  };
}

/**
 * 個股研究頁的單一純模型接口。P4 只需把 API 資料餵進來，不必再重寫判斷。
 * @param {{symbol?:unknown,rows?:unknown,research?:unknown,netWorth?:unknown,settings?:unknown}} input
 */
export function buildStockResearchModel(input = {}) {
  const symbol = normalizePortfolioSymbol(input.symbol);
  const position = summarizeStockPosition(symbol, input.rows);
  const research = findStockResearch(symbol, input.research);
  const status = researchStatusOf(research?.status);
  const availability = stockResearchAvailability(position.held, Boolean(research), Boolean(symbol));
  return {
    symbol,
    name: position.name,
    position,
    research,
    status,
    availability,
    allocation: stockAllocationForSymbol(symbol, input.rows, input.netWorth, input.settings),
    scorecard: research?.scorecard ?? null,
    valuationScenarios: research?.valuationScenarios ?? null
  };
}
