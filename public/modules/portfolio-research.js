// @ts-check
// 個股研究卡：把研究內容與表單規格整理成純資料／HTML，不碰 DOM、API 或頁面狀態。

import { icon } from './icons.js';
import { normalizePortfolioSymbol } from './portfolio-symbol.js';

/** @typedef {{escapeHtml:(value:any)=>string, formatPercent:(value:number, digits?:number)=>string}} ResearchFormatters */

/** @param {string} symbol @param {any[]} research */
function findResearch(symbol, research) {
  const key = normalizePortfolioSymbol(symbol);
  return research.find(item => normalizePortfolioSymbol(item.symbol) === key) || null;
}

/** @param {any[]} rows */
function researchHoldings(rows) {
  /** @type {Record<string, any>} */
  const grouped = Object.create(null);
  for (const row of rows) {
    if (row.layer !== 'stock') continue;
    const symbol = normalizePortfolioSymbol(row.symbol);
    if (!symbol) continue;
    if (!grouped[symbol]) grouped[symbol] = { ...row, symbol, costTwd: 0, pnlTwd: 0 };
    grouped[symbol].costTwd += Number(row.costTwd || 0);
    grouped[symbol].pnlTwd += Number(row.pnlTwd || 0);
    if (!grouped[symbol].name && row.name) grouped[symbol].name = row.name;
  }
  return Object.values(grouped);
}

/**
 * 個股研究卡區塊；只有 layer=stock 的持股會出現。
 * @param {any[]} rows
 * @param {any[]} research
 * @param {ResearchFormatters} formatters
 */
export function researchSectionHtml(rows, research, formatters) {
  const { escapeHtml: esc, formatPercent: pct } = formatters;
  const cards = researchHoldings(rows).map(holding => {
    const entry = findResearch(holding.symbol, research);
    const checkpoints = (entry?.checkpoints || []).slice().reverse().slice(0, 4);
    const block = (title, text) => text ? `<div class="rc-block"><b>${title}</b>${esc(text)}</div>` : '';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="item-title">${esc(holding.symbol)} <span class="muted" style="font-weight:400;font-size:12px">${esc(holding.name || '')}</span></div>
        <span class="tag ${holding.pnlTwd >= 0 ? 'green' : 'amber'}">${holding.pnlTwd >= 0 ? '+' : ''}${pct(holding.costTwd ? holding.pnlTwd / holding.costTwd * 100 : 0)}</span>
      </div>
      <div style="margin-top:11px;display:flex;flex-direction:column;gap:8px;font-size:12.5px">
        ${block('投資論點：', entry?.thesis) || '<div class="rc-block muted">還沒寫投資論點——寫下「為什麼買」，之後漲跌都能對照檢驗。</div>'}
        ${block('關鍵指標：', entry?.metrics)}
        ${block('風險：', entry?.risks)}
      </div>
      ${checkpoints.length ? `<div style="margin-top:10px"><b style="font-size:12px">檢查點</b>
        <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">
          ${checkpoints.map(checkpoint => `<div class="muted" style="font-size:12px"><span style="color:var(--text)">${esc(checkpoint.date)}</span>　${esc(checkpoint.note)}</div>`).join('')}
        </div></div>` : ''}
      <div style="display:flex;gap:6px;margin-top:12px;align-items:center">
        <input type="text" id="cp_${esc(holding.symbol)}" placeholder="新增檢查點筆記…" style="flex:1;font-size:12px;padding:6px 9px">
        <button class="btn-ghost btn-sm" data-add-cp="${esc(holding.symbol)}">記一筆</button>
        <button class="btn-link btn-sm" data-edit-r="${esc(holding.symbol)}" title="編輯研究卡">${icon('edit', 15)}</button>
      </div>
    </div>`;
  }).join('');

  return `<div class="section-title">個股研究卡</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr));margin-bottom:8px">
      ${cards || '<div class="empty">尚無個股研究卡——把持股的「層」設為「個股」即可出現。</div>'}
    </div>`;
}

/**
 * 研究卡表單的固定規格；onSubmit 仍由頁面接 API。
 * @param {string} symbol
 * @param {any[]} research
 */
export function researchFormModel(symbol, research) {
  const normalizedSymbol = normalizePortfolioSymbol(symbol);
  const existing = findResearch(normalizedSymbol, research);
  return {
    symbol: normalizedSymbol,
    existing,
    title: `${normalizedSymbol} 研究卡`,
    fields: [
      { key: 'thesis', label: '投資論點（為什麼買？想驗證什麼？）', type: 'textarea', full: true },
      { key: 'metrics', label: '關鍵指標（每季對照）', type: 'textarea', full: true },
      { key: 'risks', label: '風險清單', type: 'textarea', full: true }
    ],
    values: existing || {}
  };
}
