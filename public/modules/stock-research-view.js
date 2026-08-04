// @ts-check
// 個股研究頁的純呈現層：只把 P1 模型、研究資料與證券交易整理成 HTML。
// 不碰 DOM、API、路由或資料庫；所有使用者文字都由呼叫端注入的 esc() 處理。

import { icon } from './icons.js';
import { formatPortfolioMoney } from './portfolio-format.js';
import { normalizePortfolioSymbol } from './portfolio-symbol.js';
import { rowFees, rowNetSigned } from './securities-view.js';
import { scorecardResult } from './stock-research-score.js';
import { stockFundamentalsHtml } from './stock-research-fundamentals.js';
import { ACCENT } from './theme.js';

/** 就地白話解釋。P4 只負責把 data-stock-info 接到 openInfo。 */
export const STOCK_RESEARCH_INFO = Object.freeze({
  score: Object.freeze({
    title: '總分代表什麼？',
    html: '<p>總分是讓你每次用<b>同一把尺</b>重新檢查公司的整理工具，不是買進或賣出訊號。</p><p>高分不代表現在的價格適合買；低分也不等於必須賣。真正的決定仍要一起看估值、風險、部位上限與你的投資論點。</p>'
  }),
  zero: Object.freeze({
    title: '0 分和空白有什麼不同？',
    html: '<p><b>0 分是合法評分</b>，代表已有明確反證，而且必須附上理由。</p><p>空白才代表尚未評分。五個構面沒有全部評完並寫下理由前，系統不會用部分資料算總分。</p>'
  }),
  missing: Object.freeze({
    title: '「尚未取得」是 0 嗎？',
    html: '<p>不是。「尚未取得」表示目前沒有可用的指標數字；<b>0 是一個真的數值</b>，兩者不能混在一起。</p><p>系統刻意保留這個差別，避免缺資料時看起來像公司真的交出 0 的結果。</p>'
  }),
  cap: Object.freeze({
    title: '個股上限怎麼看？',
    html: '<p>這是以<b>淨資產</b>為分母的軟上限，和投資組合頁使用同一套規則。超過時只會提醒<b>凍結加碼</b>，不會叫你賣，也不會自動賣出持股。</p><p>上限設為 0 代表你對個股採取零容忍：只要有部位就會提醒凍結加碼；這不是設定損壞。</p>'
  })
});

const CATALYST_STATUS = Object.freeze({
  watching: '觀察中',
  happened: '已發生',
  expired: '已過期'
});
const BREAKER_STATUS = Object.freeze({
  watching: '觀察中',
  triggered: '已觸發',
  cleared: '已解除'
});

export const STOCK_RESEARCH_TABS = Object.freeze([
  Object.freeze({ key: 'overview', label: '總覽', icon: 'dashboard' }),
  Object.freeze({ key: 'fundamentals', label: '基本面', icon: 'file' }),
  Object.freeze({ key: 'score', label: '評分', icon: 'star' }),
  Object.freeze({ key: 'valuation', label: '估值', icon: 'pie' }),
  Object.freeze({ key: 'thesis', label: '論點與追蹤', icon: 'bulb' }),
  Object.freeze({ key: 'trades', label: '交易', icon: 'repeat' })
]);

/** @param {unknown} value */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {unknown} value */
function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function arrayOrEmpty(value) {
  return Array.isArray(value) ? value.slice() : [];
}

/** @param {unknown} value */
export function normalizeStockResearchTab(value) {
  const key = text(value).toLowerCase();
  return STOCK_RESEARCH_TABS.some(tab => tab.key === key) ? key : 'overview';
}

/** @param {unknown} value @param {number} maximumFractionDigits */
function plainNumber(value, maximumFractionDigits = 2) {
  const number = finiteOrNull(value);
  if (number == null) return '—';
  const sign = number < 0 ? '−' : '';
  return sign + Math.abs(number).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits
  });
}

/** @param {unknown} value */
function percent(value) {
  const number = finiteOrNull(value);
  return number == null ? '—' : `${plainNumber(number, 1)}%`;
}

/**
 * 來源連結只允許 http/https。回傳瀏覽器正規化後的網址；其他 scheme 或壞網址不產生連結。
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeResearchUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * 只取同代號交易並固定成交日新→舊；回傳新陣列，不改原資料。
 * @param {unknown} symbol
 * @param {unknown} trades
 */
export function stockResearchTrades(symbol, trades) {
  const key = normalizePortfolioSymbol(symbol);
  if (!key || !Array.isArray(trades)) return [];
  return trades
    .filter(trade => trade && typeof trade === 'object'
      && normalizePortfolioSymbol(trade.symbol) === key)
    .slice()
    .sort((left, right) => (
      String(right.tradeDate || '').localeCompare(String(left.tradeDate || ''))
      || String(right.importedAt || '').localeCompare(String(left.importedAt || ''))
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
}

/**
 * 現價相對情境合理價值的距離。幣別不同、缺值或合理價值不大於 0 時不猜。
 * @param {unknown} quotePrice
 * @param {unknown} quoteCurrency
 * @param {unknown} scenarioValue
 * @param {unknown} scenarioCurrency
 * @returns {number|null}
 */
export function valuationDistance(quotePrice, quoteCurrency, scenarioValue, scenarioCurrency) {
  const price = finiteOrNull(quotePrice);
  const value = finiteOrNull(scenarioValue);
  const quoteCur = text(quoteCurrency).toUpperCase();
  const scenarioCur = text(scenarioCurrency).toUpperCase();
  if (price == null || value == null || value <= 0 || !quoteCur || quoteCur !== scenarioCur) return null;
  return (price / value - 1) * 100;
}

/**
 * P4 的單一畫面資料入口。排序時一律複製陣列，避免 render 改到 API 原資料。
 * @param {{
 *   model?:any,
 *   trades?:unknown,
 *   quote?:unknown,
 *   viewCurrency?:unknown,
 *   usdRate?:unknown,
 *   activeTab?:unknown,
 *   fundamentals?:unknown
 * }} input
 */
export function buildStockResearchViewModel(input = {}) {
  const model = objectOrEmpty(input.model);
  const research = model.research && typeof model.research === 'object'
    ? /** @type {Record<string, any>} */ (model.research)
    : null;
  const quote = objectOrEmpty(input.quote);
  const checkpoints = arrayOrEmpty(research?.checkpoints).sort((left, right) => (
    String(right?.date || '').localeCompare(String(left?.date || ''))
  ));
  const scoreHistory = arrayOrEmpty(research?.scoreHistory).sort((left, right) => (
    String(right?.date || '').localeCompare(String(left?.date || ''))
  ));
  const usdRate = finiteOrNull(input.usdRate);

  return {
    symbol: normalizePortfolioSymbol(model.symbol),
    name: text(model.name),
    status: objectOrEmpty(model.status),
    availability: objectOrEmpty(model.availability),
    position: objectOrEmpty(model.position),
    allocation: objectOrEmpty(model.allocation),
    research,
    score: scorecardResult(model.scorecard),
    valuation: objectOrEmpty(model.valuationScenarios),
    quote: {
      price: finiteOrNull(quote.price),
      currency: text(quote.currency).toUpperCase(),
      asOf: text(quote.asOf || quote.updatedAt),
      source: text(quote.source)
    },
    catalysts: arrayOrEmpty(research?.catalysts),
    thesisBreakers: arrayOrEmpty(research?.thesisBreakers),
    watchMetrics: arrayOrEmpty(research?.watchMetrics),
    sources: arrayOrEmpty(research?.sources),
    checkpoints,
    scoreHistory,
    trades: stockResearchTrades(model.symbol, input.trades),
    fundamentals: input.fundamentals,
    activeTab: normalizeStockResearchTab(input.activeTab),
    // 美元檢視沒有有效匯率時退回台幣，絕不拿 1:1 捏造美元金額。
    viewCurrency: input.viewCurrency === 'USD' && usdRate != null && usdRate > 0 ? 'USD' : 'TWD',
    usdRate: usdRate != null && usdRate > 0 ? usdRate : 1
  };
}

/** @param {(value:any)=>string} esc */
function createHtmlHelpers(esc) {
  if (typeof esc !== 'function') throw new TypeError('stockResearchViewHtml 需要 esc 格式器');
  const e = (/** @type {unknown} */ value) => esc(String(value ?? ''));
  const multiline = (/** @type {unknown} */ value, /** @type {string} */ fallback = '尚未填寫') => {
    const raw = text(value);
    return raw ? e(raw).replace(/\r?\n/g, '<br>') : `<span class="muted">${fallback}</span>`;
  };
  const info = (/** @type {string} */ key, /** @type {string} */ label) => (
    `<button type="button" class="info-link" data-stock-info="${key}">${label}</button>`
  );
  return { e, multiline, info };
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function headerHtml(view, h) {
  const title = view.symbol || '個股研究';
  const company = view.name ? `<span>${h.e(view.name)}</span>` : '';
  const researchDate = text(view.research?.lastReviewedAt);
  const availability = text(view.availability.label);
  const canEdit = Boolean(view.availability.canEdit);
  const canCreate = Boolean(view.availability.canCreate);
  const action = canEdit
    ? `<button type="button" class="btn" data-stock-edit>${icon('edit', 16)}編輯研究</button>`
    : canCreate
      ? `<button type="button" class="btn" data-stock-create>${icon('plus', 16)}建立研究</button>`
      : '';

  return `<header class="page-head stock-research-head">
    <div class="stock-research-title">
      <div class="stock-kicker">個股研究與追蹤</div>
      <h1>${h.e(title)} ${company}</h1>
      <div class="stock-head-meta">
        ${availability ? `<span class="tag">${h.e(availability)}</span>` : ''}
        ${view.research ? `<span>目前狀態：<b>${h.e(view.status.label || '尚未評估')}</b></span>` : ''}
        ${researchDate ? `<span>研究更新：${h.e(researchDate)}</span>` : ''}
      </div>
    </div>
    <div class="page-actions">
      <a class="btn-ghost stock-back-link" href="#ib">${icon('trending', 16)}回投資組合</a>
      ${action}
    </div>
  </header>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function tabsHtml(view, h) {
  const links = STOCK_RESEARCH_TABS.map(tab => {
    const active = tab.key === view.activeTab;
    const href = `#stock?symbol=${encodeURIComponent(view.symbol)}&tab=${encodeURIComponent(tab.key)}`;
    return `<a id="stock-tab-${tab.key}" class="stock-tab${active ? ' active' : ''}" href="${h.e(href)}"${active ? ' aria-current="page"' : ''}>${icon(tab.icon, 18)}<span>${h.e(tab.label)}</span></a>`;
  }).join('');
  return `<nav class="stock-tabs" aria-label="個股研究分頁">
    <div class="stock-tabs-track">${links}</div>
  </nav>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function positionHtml(view, h) {
  const position = view.position;
  const allocation = view.allocation;
  const moneyOptions = { viewCurrency: view.viewCurrency, usdRate: view.usdRate };
  const pnl = finiteOrNull(position.pnlTwd) ?? 0;
  const cap = finiteOrNull(allocation.capPct);
  const capLabel = cap == null ? '—' : `${plainNumber(cap, 1)}%`;
  const capInfo = ` ${h.info('cap', '怎麼看？')}`;
  const heldLabel = position.held ? '' : '<span class="tag">目前未持有</span>';

  const item = (/** @type {string} */ label, /** @type {string} */ value, /** @type {string} */ extra = '') => (
    `<div class="stock-position-item"><span>${label}</span><strong class="${extra}">${value}</strong></div>`
  );

  return `<section class="stock-position" aria-label="持股摘要">
    <div class="stock-section-heading">
      <div><span class="stock-eyebrow">目前部位</span>${heldLabel}</div>
      ${allocation.frozen ? '<span class="tag amber">凍結加碼</span>' : ''}
    </div>
    <div class="stock-position-grid">
      ${item('股數', plainNumber(position.quantity, 6))}
      ${item('成本', formatPortfolioMoney(position.costTwd, moneyOptions))}
      ${item('市值', formatPortfolioMoney(position.valueTwd, moneyOptions))}
      ${item('未實現損益', formatPortfolioMoney(pnl, moneyOptions), pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '')}
      ${item('占淨資產', percent(allocation.pct))}
      ${item(`個股上限${capInfo}`, capLabel)}
    </div>
  </section>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function latestCheckpointHtml(view, h) {
  const latest = view.checkpoints[0];
  return `<section class="stock-section stock-latest-checkpoint">
    <div class="stock-section-heading"><h2>最近檢查點</h2></div>
    ${latest
      ? `<div class="stock-checkpoint-summary"><time>${h.e(text(latest.date) || '未填日期')}</time><div>${h.multiline(latest.note, '尚未填寫筆記')}</div></div>`
      : '<p class="empty">尚無檢查點</p>'}
  </section>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function thesisHtml(view, h) {
  const breakers = view.thesisBreakers;
  const breakerItems = breakers.length
    ? `<ul class="stock-plain-list">${breakers.map(item => {
      const status = Object.hasOwn(BREAKER_STATUS, item?.status) ? BREAKER_STATUS[item.status] : '未設定';
      return `<li><div>${h.multiline(item?.text)}</div><span class="tag">${status}</span></li>`;
    }).join('')}</ul>`
    : '<p class="muted">尚未設定反證條件</p>';

  return `<section class="stock-section">
    <div class="stock-section-heading"><h2>研究結論</h2></div>
    <div class="stock-two-column">
      <article class="stock-panel">
        <h3>投資論點</h3>
        <div class="stock-prose">${h.multiline(view.research?.thesis, '尚未寫下投資論點')}</div>
      </article>
      <article class="stock-panel">
        <h3>反證條件</h3>
        ${breakerItems}
      </article>
    </div>
  </section>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function scoreHtml(view, h) {
  const score = view.score;
  const rows = score.items.map(item => {
    const fill = item.complete ? Math.max(0, Math.min(100, Number(item.score) / 5 * 100)) : 0;
    return `<div class="stock-score-row" data-score-key="${item.key}" data-score-complete="${item.complete}">
      <div class="stock-score-name"><b>${item.label}</b><span>權重 ${item.weight}%</span></div>
      <div class="stock-score-track" aria-hidden="true"><span style="width:${fill}%;background:${ACCENT}"></span></div>
      <div class="stock-score-value">${item.complete ? `${item.score}／5` : '尚未評分'}</div>
      <div class="stock-score-reason">${item.complete ? h.multiline(item.reason) : '<span class="muted">分數與理由缺一不可</span>'}</div>
    </div>`;
  }).join('');

  return `<section class="stock-section">
    <div class="stock-section-heading">
      <div><h2>五項評分</h2><span class="stock-score-total">${h.e(score.displayText)}</span></div>
      <div class="stock-help-links">${h.info('score', '總分怎麼看？')}${h.info('zero', '0 分和空白')}</div>
    </div>
    <div class="stock-score-list">${rows}</div>
  </section>`;
}

/** @param {number|null} distance */
function distanceText(distance) {
  if (distance == null) return '—';
  if (Math.abs(distance) < 0.05) return '與情境相同';
  return `現價${distance > 0 ? '高於' : '低於'} ${plainNumber(Math.abs(distance), 1)}%`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function valuationHtml(view, h) {
  const valuation = view.valuation;
  const currency = text(valuation.currency).toUpperCase();
  const hasValue = ['bear', 'base', 'bull'].some(key => finiteOrNull(valuation[key]) != null);
  if (!hasValue) {
    return `<section class="stock-section">
      <div class="stock-section-heading"><h2>估值情境</h2></div>
      <p class="empty">尚未填寫估值情境</p>
    </section>`;
  }

  const scenarios = [
    ['bear', '保守'],
    ['base', '基準'],
    ['bull', '樂觀']
  ].map(([key, label]) => {
    const value = finiteOrNull(valuation[key]);
    const distance = valuationDistance(view.quote.price, view.quote.currency, value, currency);
    return `<div class="stock-valuation-row ${key}">
      <b>${label}</b>
      <span class="num">${value == null ? '尚未填寫' : `${plainNumber(value, 4)} ${h.e(currency)}`}</span>
      <span class="muted">${distanceText(distance)}</span>
    </div>`;
  }).join('');

  const quote = view.quote.price == null
    ? '現價尚未取得'
    : `現價 ${plainNumber(view.quote.price, 4)} ${h.e(view.quote.currency || '—')}`;
  const quoteMeta = [view.quote.source, view.quote.asOf].filter(Boolean).map(h.e).join(' · ');
  const valuationMeta = [text(valuation.method), text(valuation.asOf)].filter(Boolean).map(h.e).join(' · ');

  return `<section class="stock-section">
    <div class="stock-section-heading">
      <div><h2>估值情境</h2>${valuationMeta ? `<span>${valuationMeta}</span>` : ''}</div>
      <div class="stock-quote">${quote}${quoteMeta ? `<small>${quoteMeta}</small>` : ''}</div>
    </div>
    <div class="stock-valuation-list">${scenarios}</div>
    <div class="stock-assumptions"><span>主要假設</span><div>${h.multiline(valuation.assumptions)}</div></div>
  </section>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function detailsHtml(view, h) {
  const catalystItems = view.catalysts.length
    ? `<ul class="stock-plain-list">${view.catalysts.map(item => {
      const status = Object.hasOwn(CATALYST_STATUS, item?.status) ? CATALYST_STATUS[item.status] : '未設定';
      return `<li><div><b>${h.e(text(item?.text) || '未命名催化劑')}</b>${text(item?.horizon) ? `<small>${h.e(item.horizon)}</small>` : ''}</div><span class="tag">${status}</span></li>`;
    }).join('')}</ul>`
    : '<p class="muted">尚未設定催化劑</p>';

  const historyByDate = new Map(view.scoreHistory.map(item => [text(item?.date), finiteOrNull(item?.total)]));
  const checkpointItems = view.checkpoints.length
    ? `<ol class="stock-timeline">${view.checkpoints.map(item => {
      const date = text(item?.date);
      const total = historyByDate.get(date);
      return `<li>
        <div class="stock-timeline-date">${h.e(date || '未填日期')}${total != null ? `<span>${plainNumber(total, 1)} 分</span>` : ''}</div>
        <div>${h.multiline(item?.note, '尚未填寫筆記')}</div>
      </li>`;
    }).join('')}</ol>`
    : '<p class="muted">尚無檢查點</p>';

  return `<section class="stock-section">
    <div class="stock-section-heading">
      <h2>風險與追蹤</h2>
      ${view.research ? `<button type="button" class="btn-link btn-sm" data-stock-add-checkpoint>${icon('record', 15)}新增檢查點</button>` : ''}
    </div>
    <div class="stock-detail-columns">
      <article class="stock-panel"><h3>主要風險</h3><div class="stock-prose">${h.multiline(view.research?.risks, '尚未寫下主要風險')}</div></article>
      <article class="stock-panel"><h3>催化劑</h3>${catalystItems}</article>
      <article class="stock-panel"><h3>檢查點</h3>${checkpointItems}</article>
    </div>
  </section>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function sourcesHtml(view, h) {
  if (!view.sources.length) return '';
  const items = view.sources.map(source => {
    const label = text(source?.label) || text(source?.url) || '未命名來源';
    const url = safeResearchUrl(source?.url);
    const title = url
      ? `<a href="${h.e(url)}" target="_blank" rel="noopener">${h.e(label)} ${icon('link', 14)}</a>`
      : `<span>${h.e(label)}</span>`;
    return `<li><div>${title}${text(source?.asOf) ? `<small>${h.e(source.asOf)}</small>` : ''}</div>${url ? '' : '<span class="muted">無可開啟連結</span>'}</li>`;
  }).join('');
  return `<section class="stock-section stock-sources">
    <div class="stock-section-heading"><h2>資料來源</h2></div>
    <ul class="stock-source-list">${items}</ul>
  </section>`;
}

/** @param {any} trade @param {ReturnType<typeof createHtmlHelpers>} h */
function tradeRowHtml(trade, h) {
  const source = trade?.source === 'ibkr' ? 'IBKR' : trade?.source === 'taishin' ? '台新證券' : text(trade?.source) || '—';
  const side = trade?.side === 'buy' ? '買進' : trade?.side === 'sell' ? '賣出' : '？';
  const net = rowNetSigned(trade);
  const foreignCommission = text(trade?.commissionCurrency)
    && text(trade?.commissionCurrency) !== text(trade?.currency);
  const fees = `${plainNumber(rowFees(trade), 2)}${foreignCommission
    ? ` ＋ ${plainNumber(trade?.commission, 2)} ${h.e(trade.commissionCurrency)}`
    : ''}`;
  return `<tr>
    <td class="nowrap">${h.e(text(trade?.tradeDate) || '—')}</td>
    <td><span class="flow-tag ${trade?.side === 'buy' ? 'neg' : trade?.side === 'sell' ? 'pos' : ''}">${side}</span></td>
    <td class="num">${plainNumber(trade?.quantity, 6)}</td>
    <td class="num">${plainNumber(trade?.price, 4)}</td>
    <td class="num">${fees}</td>
    <td class="num ${net == null ? '' : net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${net == null ? '—' : `${net > 0 ? '+' : net < 0 ? '−' : ''}${plainNumber(Math.abs(net), 2)}`}</td>
    <td>${h.e(text(trade?.currency) || '—')}</td>
    <td>${h.e(source)}</td>
  </tr>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function tradesHtml(view, h) {
  const rows = view.trades.length
    ? view.trades.map(trade => tradeRowHtml(trade, h)).join('')
    : '<tr><td colspan="8" class="empty">尚無這檔個股的交易紀錄</td></tr>';
  return `<section class="stock-section">
    <div class="stock-section-heading">
      <div><h2>我的交易紀錄</h2><span>共 ${view.trades.length} 筆</span></div>
      <span class="muted">每筆依來源原幣顯示，不跨幣別加總</span>
    </div>
    <div class="tbl-wrap stock-table-wrap">
      <table class="stock-trades-table">
        <thead><tr><th>成交日</th><th>買賣</th><th class="num">數量</th><th class="num">價格</th><th class="num">費稅</th><th class="num">淨應收付</th><th>幣別</th><th>來源</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function missingResearchHtml(view, h) {
  return `<section class="stock-research-empty">
    <img class="stock-empty-guide" src="assets/guide-return-neutral.webp" alt="" />
    <h2>${h.e(view.symbol)} 尚未撰寫研究</h2>
    <p>目前可以先查持股與交易紀錄；建立研究後，這裡會顯示投資論點、評分、估值與檢查點。</p>
    <button type="button" class="btn" data-stock-create>${icon('plus', 16)}建立研究</button>
  </section>`;
}

/** @param {ReturnType<typeof buildStockResearchViewModel>} view @param {ReturnType<typeof createHtmlHelpers>} h */
function activeTabHtml(view, h) {
  const needsResearch = !view.research
    && ['score', 'valuation', 'thesis'].includes(view.activeTab);
  if (needsResearch) return missingResearchHtml(view, h);

  if (view.activeTab === 'fundamentals') {
    return stockFundamentalsHtml({
      cache: view.fundamentals,
      watchMetrics: view.watchMetrics,
      legacyMetrics: view.research?.metrics
    }, { esc: h.e });
  }
  if (view.activeTab === 'score') return scoreHtml(view, h);
  if (view.activeTab === 'valuation') return valuationHtml(view, h);
  if (view.activeTab === 'thesis') {
    return [thesisHtml(view, h), detailsHtml(view, h), sourcesHtml(view, h)].join('');
  }
  if (view.activeTab === 'trades') return tradesHtml(view, h);

  return [
    positionHtml(view, h),
    view.research ? thesisHtml(view, h) : missingResearchHtml(view, h),
    view.research ? latestCheckpointHtml(view, h) : ''
  ].join('');
}

/**
 * 個股研究頁完整 HTML。P3 只產字串；P4 才接 DOM、API、openInfo 與按鈕事件。
 * @param {Parameters<typeof buildStockResearchViewModel>[0]} input
 * @param {{esc:(value:any)=>string}} formatters
 */
export function stockResearchViewHtml(input, formatters) {
  const h = createHtmlHelpers(formatters?.esc);
  const view = buildStockResearchViewModel(input);
  if (!view.symbol) {
    return `<div class="stock-research-page">
      ${headerHtml(view, h)}
      <section class="stock-research-empty">
        <img class="stock-empty-guide" src="assets/guide-return-neutral.webp" alt="" />
        <h2>請先選擇一檔個股</h2>
        <p>請從投資組合的個股代號進入研究頁。</p>
        <a class="btn-ghost stock-back-link" href="#ib">回投資組合</a>
      </section>
    </div>`;
  }

  if (view.availability.state === 'empty') {
    return `<div class="stock-research-page">
      ${headerHtml(view, h)}
      <section class="stock-research-empty">
        <img class="stock-empty-guide" src="assets/guide-return-neutral.webp" alt="" />
        <h2>${h.e(view.symbol)} 尚無持股或研究資料</h2>
        <p>這個網址不會自動建立空白研究；請先從投資組合的個股入口進入。</p>
        <a class="btn-ghost stock-back-link" href="#ib">回投資組合</a>
      </section>
    </div>`;
  }

  return `<div class="stock-research-page" data-stock-symbol="${h.e(view.symbol)}">
    ${headerHtml(view, h)}
    <div class="stock-research-workspace">
      ${tabsHtml(view, h)}
      <section class="stock-tab-panel" id="stock-panel-${h.e(view.activeTab)}" aria-labelledby="stock-tab-${h.e(view.activeTab)}" data-stock-tab="${h.e(view.activeTab)}">
        ${activeTabHtml(view, h)}
      </section>
    </div>
  </div>`;
}
