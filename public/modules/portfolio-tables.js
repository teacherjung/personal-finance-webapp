// @ts-check
// 投資組合主表：把持股與願望清單排成 HTML，不碰 DOM、API 或頁面狀態。

import { icon } from './icons.js';
import { normalizePortfolioSymbol } from './portfolio-symbol.js';
import { LAYERS, LAYER_ORDER } from './portfolio-visuals.js';

/** @typedef {{escapeHtml:(value:any)=>string, formatMoney:(value:number)=>string, formatPercent:(value:number, digits?:number)=>string}} TableFormatters */

const byValueTwd = (a, b) => a.valueTwd - b.valueTwd;
const HOLDING_SORTERS = {
  value: byValueTwd,
  pnl: (a, b) => a.pnlTwd - b.pnlTwd,
  ret: (a, b) => (a.costTwd ? a.pnlTwd / a.costTwd : 0) - (b.costTwd ? b.pnlTwd / b.costTwd : 0),
  weight: byValueTwd
};

/** @param {any} price @param {string} currency */
function formatPrice(price, currency) {
  return Number(price || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + (currency || '');
}

/** 表格用價格：整數；單價 <10 保留一位小數（例：5.4 USD）。 @param {any} price @param {string} currency */
function formatTablePrice(price, currency) {
  const value = Number(price || 0);
  const text = Math.abs(value) < 10 ? value.toFixed(1) : Math.round(value).toLocaleString('en-US');
  return text + ' ' + (currency || '');
}

/** @param {string} key @param {string} sortKey @param {string} sortDir */
function sortTriangle(key, sortKey, sortDir) {
  if (sortKey === key) return `<span class="sort-tri active">${sortDir === 'asc' ? '▲' : '▼'}</span>`;
  return '<span class="sort-tri">▾</span>';
}

/** @param {string} key @param {string} sortKey @param {string} sortDir */
function ariaSort(key, sortKey, sortDir) {
  if (sortKey !== key) return 'none';
  return sortDir === 'asc' ? 'ascending' : 'descending';
}

/** 只有個股層的代號是研究入口；其他資產維持純文字。 @param {any} row @param {(value:any)=>string} esc */
function holdingSymbolHtml(row, esc) {
  const displaySymbol = String(row.symbol || '');
  const symbol = normalizePortfolioSymbol(displaySymbol);
  const label = `<b>${esc(displaySymbol)}</b>`;
  if (row.layer !== 'stock' || !symbol) return label;
  const href = `#stock?symbol=${encodeURIComponent(symbol)}`;
  const title = `在新分頁開啟 ${symbol} 個股研究`;
  return `<a class="drill-link" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(title)}" title="${esc(title)}" style="font-size:inherit;font-weight:inherit">${label}</a>`;
}

/**
 * 持股表（依層分組，組內排序）。
 * @param {any[]} rows
 * @param {number} total
 * @param {{sortKey:string, sortDir:string, formatters:TableFormatters}} options
 */
export function holdingsTableHtml(rows, total, options) {
  const { sortKey, sortDir, formatters } = options;
  const { escapeHtml: esc, formatMoney: money, formatPercent: pct } = formatters;
  const comparator = (Object.hasOwn(HOLDING_SORTERS, sortKey) && HOLDING_SORTERS[sortKey]) || HOLDING_SORTERS.value;
  const groups = LAYER_ORDER.map(layer => {
    const list = rows.filter(row => (LAYERS[row.layer] ? row.layer : 'satellite') === layer).sort(comparator);
    if (sortDir === 'desc') list.reverse();
    if (!list.length) return '';
    return `<tr class="group-row portfolio-layer-row"><td colspan="9"><span class="portfolio-layer-label"><span class="cat-dot" style="background:${LAYERS[layer].color}"></span>${LAYERS[layer].label}</span></td></tr>`
      + list.map(row => `<tr>
        <td class="nowrap">${holdingSymbolHtml(row, esc)}${row.quoteSymbol ? '' : ' <span class="tag" style="font-size:9px">手動</span>'}</td>
        <td class="muted nowrap portfolio-holding-name">${esc(row.name || '')}</td>
        <td class="nowrap muted">${formatTablePrice((row.avgCost != null && row.avgCost !== '') ? row.avgCost : (Number(row.quantity) ? Number(row.cost || 0) / Number(row.quantity) : 0), row.currency)}</td>
        <td class="nowrap">${formatTablePrice(row.price, row.currency)}</td>
        <td class="num">${money(row.valueTwd)}</td>
        <td class="num ${row.pnlTwd >= 0 ? 'pos' : 'neg'}">${row.pnlTwd >= 0 ? '+' : ''}${money(row.pnlTwd)}</td>
        <td class="num ${row.pnlTwd >= 0 ? 'pos' : 'neg'}">${row.costTwd ? pct(row.pnlTwd / row.costTwd * 100) : '—'}</td>
        <td class="num">${pct(total > 0 ? row.valueTwd / total * 100 : 0)}</td>
        <td><div class="row-actions">
          <button class="btn-link btn-sm" data-edit-h="${esc(row.id)}" title="編輯" aria-label="編輯 ${esc(row.symbol || '')}">${icon('edit', 15)}</button>
          <button class="btn-danger btn-sm" data-del-h="${esc(row.id)}" title="刪除" aria-label="刪除 ${esc(row.symbol || '')}">${icon('trash', 15)}</button>
        </div></td>
      </tr>`).join('');
  }).join('');
  return `<section class="portfolio-holdings-workspace" aria-labelledby="portfolio-holdings-title">
    <header class="portfolio-holdings-head">
      <div><span>投資配置明細</span><h2 id="portfolio-holdings-title">持股明細</h2><p>依投資分層呈現市值、損益、報酬率與資產佔比。</p></div>
      <p class="portfolio-holdings-count">目前持有 <strong>${rows.length}</strong> 檔</p>
    </header>
    <div class="tbl-wrap portfolio-holdings-table-wrap"><table class="subs-table portfolio-holdings-table">
    <thead><tr><th>代號</th><th>說明</th><th>均價</th><th>現價</th>
      <th class="sortable" data-hsort="value" aria-sort="${ariaSort('value', sortKey, sortDir)}">市值 ${sortTriangle('value', sortKey, sortDir)}</th>
      <th class="sortable" data-hsort="pnl" aria-sort="${ariaSort('pnl', sortKey, sortDir)}">損益 ${sortTriangle('pnl', sortKey, sortDir)}</th>
      <th class="sortable" data-hsort="ret" aria-sort="${ariaSort('ret', sortKey, sortDir)}">報酬率 ${sortTriangle('ret', sortKey, sortDir)}</th>
      <th class="sortable" data-hsort="weight" aria-sort="${ariaSort('weight', sortKey, sortDir)}">佔比 ${sortTriangle('weight', sortKey, sortDir)}</th>
      <th></th></tr></thead>
    <tbody>${groups || '<tr><td colspan="9" class="empty"><div class="portfolio-holdings-empty"><img src="assets/guide-return-neutral.webp" alt=""><div><strong>尚無持股</strong><span>可用頁首「新增持股」建立第一筆投資紀錄。</span></div></div></td></tr>'}</tbody>
  </table></div></section>`;
}

/**
 * 回檔買進願望清單。
 * @param {any[]} watchlist
 * @param {Pick<TableFormatters, 'escapeHtml'|'formatPercent'>} formatters
 */
export function watchlistSectionHtml(watchlist, formatters) {
  const { escapeHtml: esc, formatPercent: pct } = formatters;
  const rows = watchlist.map(item => {
    const last = Number(item.lastPrice || 0);
    const target = Number(item.targetPrice || 0);
    let status = '<span class="muted">—</span>';
    if (last && target) {
      const diff = (last - target) / target * 100;
      status = last <= target
        ? '<span class="tag green">到價！可依紀律買進</span>'
        : `<span class="muted">還差 ${pct(diff)}</span>`;
    }
    return `<tr>
      <td class="nowrap"><b>${esc(item.symbol)}</b></td>
      <td class="muted nowrap">${esc(item.name || '')}</td>
      <td class="nowrap">${formatPrice(item.targetPrice, item.currency || 'USD')}</td>
      <td class="nowrap">${last ? formatPrice(last, item.currency || 'USD') : '<span class="muted">按「更新報價」</span>'}</td>
      <td>${status}</td>
      <td class="muted" style="font-size:12px">${esc(item.note || '')}</td>
      <td><div class="row-actions">
        <button class="btn-link btn-sm" data-edit-w="${esc(item.id)}" title="編輯">${icon('edit', 15)}</button>
        <button class="btn-danger btn-sm" data-del-w="${esc(item.id)}" title="刪除">${icon('trash', 15)}</button>
      </div></td>
    </tr>`;
  }).join('');
  return `<div class="chart-card" style="margin-bottom:16px">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">回檔買進願望清單 <span class="stat-sub" style="font-weight:400;margin:0">（到價提示，把「等回檔」變成紀律）</span></h3>
      <button class="btn-ghost btn-sm" id="addWatch">${icon('plus', 14)}新增</button>
    </div>
    <div class="tbl-wrap" style="box-shadow:none;border:none;margin-top:8px"><table>
      <thead><tr><th>代號</th><th>名稱</th><th>目標買價</th><th>現價</th><th>狀態</th><th>備註</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="empty">尚無項目</td></tr>'}</tbody>
    </table></div>
  </div>`;
}
