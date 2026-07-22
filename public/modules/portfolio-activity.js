// @ts-check
// 投資組合 IBKR 活動卡：把現金流與交易摘要格式化成 HTML，不碰 DOM、API 或頁面狀態。

import { tradeSummary } from './portfolio-calculations.js';
import { formatK, formatWan } from './portfolio-format.js';

/** @typedef {import('../../lib/types.js').Settings} Settings */
/** @typedef {Record<string, any>} Trade */
/** @typedef {{ escapeHtml:(value:any)=>string, viewCurrency:string, usdRate:number }} ActivityOptions */

/** @param {unknown} value */
const fmtD = (value) => value ? `${String(value).slice(0, 4)}/${String(value).slice(4, 6)}` : '';
/** @param {number} value @param {ActivityOptions} options */
function incomeMoney(value, { viewCurrency, usdRate }) {
  const sign = value < 0 ? '−' : '+';
  return viewCurrency === 'USD'
    ? sign + (Math.abs(value) / 1000).toFixed(2) + ' K USD'
    : sign + (Math.abs(value) * usdRate / 10000).toFixed(2) + ' 萬';
}

/** @param {number} value @param {ActivityOptions} options */
function tradeMoney(value, { viewCurrency, usdRate }) {
  const sign = value < 0 ? '−' : '+';
  return viewCurrency === 'USD'
    ? sign + formatK(Math.abs(value)) + ' K USD'
    : sign + formatWan(Math.abs(value) * usdRate) + ' 萬';
}

/**
 * IBKR 現金流（股息 vs 融資利息，近一年）。
 * @param {Settings} settings
 * @param {ActivityOptions} options
 */
export function incomeActivityHtml(settings, options) {
  const inc = settings.ib?.income;
  if (!inc) return '';
  const { escapeHtml: esc } = options;
  const divTotal = (inc.dividends || 0) + (inc.paymentInLieu || 0);
  const net = divTotal + (inc.withholdingTax || 0) + (inc.interestPaid || 0) + (inc.interestReceived || 0);
  const item = (label, value, cls) => `<div style="min-width:150px">
    <div class="muted" style="font-size:11.5px">${label}</div>
    <div class="${cls}" style="font-family:var(--serif);font-size:19px;font-variant-numeric:tabular-nums">${incomeMoney(value, options)}</div>
  </div>`;
  const infoBtn = (key, text) => `<button type="button" class="info-link" data-info="${key}">${text}</button>`;
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>IB 現金流 <span class="stat-sub" style="font-weight:400;margin:0">（${fmtD(inc.from)}–${fmtD(inc.to)}）</span></h3>
    <div style="display:flex;gap:28px;flex-wrap:wrap;margin-top:12px">
      ${item(`股息（含${infoBtn('pil', '替代股息')}）`, divTotal, 'pos')}
      ${item(infoBtn('interestPaid', '融資利息'), inc.interestPaid || 0, 'neg')}
      ${item(infoBtn('interestReceived', '利息收入'), inc.interestReceived || 0, 'pos')}
      ${item('淨現金流', net, net >= 0 ? 'pos' : 'neg')}
    </div>
    ${Number(inc.estimatedNoFx) > 0 ? `<p class="muted small" style="margin-top:8px">註：${inc.estimatedNoFx} 筆${inc.estimatedCurrencies?.length ? '（' + inc.estimatedCurrencies.map(esc).join('、') + '）' : ''}非美元現金交易缺 IBKR 匯率，以設定匯率估算。</p>` : ''}
    ${Number(inc.skippedNoFx) > 0 ? `<p class="muted small" style="margin-top:8px">註：${inc.skippedNoFx} 筆非美元現金交易缺匯率、亦無設定匯率可估，未計入上列金額。</p>` : ''}
  </div>`;
}

// 現金流名詞說明（由頁面綁定 .info-link 開啟彈窗）。
export const INCOME_INFO = {
  pil: ['替代股息（Payment in Lieu）',
    '<p>當你持有的股票被券商的融資／借券機制借出時，你不會直接收到公司發的股息，而是收到一筆<b>等額的現金給付</b>來替代，這就是「替代股息」。</p><p>金額上與原本的股息相同，但<b>稅務處理可能不同</b>（例如不適用某些股利優惠稅率），報稅時要留意。</p>'],
  interestPaid: ['融資利息',
    '<p>你借入資金（融資）維持槓桿部位時，IBKR 按日計收的<b>利息成本</b>。</p><p>這是持有槓桿的固定開銷——當你的股息收入<b>蓋不過</b>融資利息時，該槓桿部位就是「負現金流」持倉，長期會侵蝕報酬。</p>'],
  interestReceived: ['利息收入',
    '<p>IBKR 對你帳戶中<b>閒置現金餘額</b>支付的利息（通常要超過一定門檻才有，且分幣別計算）。</p><p>與融資利息方向相反：這是錢放著自動產生的收入。</p>']
};

/**
 * 交易摘要：已實現損益（FIFO，來自 IBKR 成交紀錄）。
 * @param {Trade[]} trades
 * @param {Settings} settings
 * @param {ActivityOptions} options
 */
export function tradesActivityHtml(trades, settings, options) {
  if (!trades || !trades.length) return '';
  const { escapeHtml: esc } = options;
  const inc = settings.ib?.income || {};
  const { realized, winners, losers, ibkrCurrencies, estimatedCurrencies, missingCurrencies } = tradeSummary(trades, settings);
  const li = (items) => items.length
    ? items.map(([symbol, pnl]) => `<div style="display:flex;justify-content:space-between;gap:14px"><span>${esc(symbol)}</span><b class="${pnl >= 0 ? 'pos' : 'neg'}">${tradeMoney(pnl, options)}</b></div>`).join('')
    : '<span class="muted">—</span>';
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3>交易摘要 <span class="stat-sub" style="font-weight:400;margin:0">（${fmtD(inc.from)}–${fmtD(inc.to)}）</span> <button type="button" class="btn-link btn-sm" id="tradesFull">完整交易</button></h3>
    <div style="display:flex;gap:40px;flex-wrap:wrap;margin-top:12px;align-items:flex-start">
      <div style="min-width:150px">
        <div class="muted" style="font-size:11.5px">已實現損益（FIFO）</div>
        <div class="${realized >= 0 ? 'pos' : 'neg'}" style="font-family:var(--serif);font-size:22px;font-variant-numeric:tabular-nums">${tradeMoney(realized, options)}</div>
      </div>
      <div style="min-width:180px;font-size:12.5px"><div class="muted" style="font-size:11.5px;margin-bottom:5px">已實現獲利 前三</div>${li(winners)}</div>
      <div style="min-width:180px;font-size:12.5px"><div class="muted" style="font-size:11.5px;margin-bottom:5px">已實現虧損 前三</div>${li(losers)}</div>
    </div>
    ${ibkrCurrencies.length ? `<p class="muted small" style="margin-top:10px">註解：換算匯率來自 IBKR</p>` : ''}
    ${estimatedCurrencies.length ? `<p class="muted small" style="margin-top:10px">提醒：${estimatedCurrencies.map(esc).join('、')} 舊交易缺少 IBKR 匯率欄位，已先用目前設定匯率估算；下次 IBKR 同步若有勾選 FX Rate to Base，會改用 IBKR 匯率。</p>` : ''}
    ${missingCurrencies.length ? `<p class="neg small" style="margin-top:10px">提醒：${missingCurrencies.map(esc).join('、')} 交易缺少可用匯率，暫未計入已實現損益。</p>` : ''}
    <p class="muted small" style="margin-top:10px">已實現＋未實現＋股息－利息，才是完整的投資成績。</p>
  </div>`;
}
