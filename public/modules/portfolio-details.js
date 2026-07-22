// @ts-check
// 投資組合彈窗內容：只把已算好的資料排序、格式化成 HTML，不碰 DOM、API 或頁面狀態。

/** @typedef {(value: any) => string} EscapeHtml */
/** @typedef {(value: number) => string} FormatMoney */
/** @typedef {{ escapeHtml: EscapeHtml, formatMoney: FormatMoney }} DetailFormatters */
/** @typedef {{ date?: string, symbol?: string, buySell?: string, quantity?: number, price?: number, netCash?: number, pnl?: number, currency?: string }} Trade */
/** @typedef {{ symbol?: string, costTwd?: number, valueTwd?: number }} HoldingRow */
/** @typedef {{ name?: string, valueTwd?: number }} AccountRow */

const pctOf = (value, base) => base ? Math.round(value / base * 100) : 0;

/**
 * 完整交易明細（全部成交逐筆，依日期新到舊）。
 * @param {Trade[]} trades
 * @param {{ escapeHtml: EscapeHtml }} formatters
 */
export function tradesModalHtml(trades, { escapeHtml: esc }) {
  const buys = trades.filter(t => t.buySell === 'BUY').length;
  const sells = trades.length - buys;
  const fmtDate = (date) => (date && date.length === 8)
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : (date || '');
  const number = (value, decimals = 0) => Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  const rows = trades.slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map(trade => {
      const pnl = Number(trade.pnl) || 0;
      return `<tr>
      <td class="nowrap">${esc(fmtDate(trade.date))}</td>
      <td class="nowrap"><b>${esc(trade.symbol)}</b></td>
      <td><span class="tag ${trade.buySell === 'BUY' ? 'blue' : 'amber'}">${trade.buySell === 'BUY' ? '買' : '賣'}</span></td>
      <td class="num">${number(Math.abs(Number(trade.quantity) || 0))}</td>
      <td class="num">${number(trade.price, 2)}</td>
      <td class="num">${number(trade.netCash, 2)}</td>
      <td class="num ${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}">${pnl ? number(pnl, 2) : '—'}</td>
      <td class="muted nowrap">${esc(trade.currency || '')}</td>
    </tr>`;
    }).join('');

  return `<div class="cost-detail-total"><span>買 ${buys}／賣 ${sells}</span><b>共 ${trades.length} 筆</b></div>
    <div class="cost-detail-table-wrap" style="max-height:58vh;overflow:auto">
      <table class="cost-detail-table">
        <thead><tr><th>日期</th><th>代號</th><th>買賣</th><th class="num">股數</th><th class="num">價格</th><th class="num">淨現金</th><th class="num">已實現損益</th><th>幣別</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * @param {{ head: string[], items: {label:string, value:number, pct?:number}[], total?:number, totalPct?:number, emptyText?:string }} config
 * @param {DetailFormatters} formatters
 */
function detailTableHtml({ head, items, total, totalPct, emptyText = '' }, { escapeHtml: esc, formatMoney }) {
  const threeColumns = head.length >= 3;
  const body = items.length
    ? items.map(item => `<tr>
    <td class="nowrap"><b>${esc(item.label)}</b></td>
    <td class="num">${formatMoney(item.value)}</td>${threeColumns ? `
    <td class="num">${item.pct}%</td>` : ''}
  </tr>`).join('')
    : `<tr><td colspan="${head.length}" class="muted" style="text-align:center;padding:22px">${esc(emptyText)}</td></tr>`;

  return `<div class="cost-detail-total compact-summary${threeColumns ? ' three-col' : ''}">
      <span></span>
      <b>合計：${formatMoney(Number(total) || 0)}</b>${threeColumns ? `
      <b>合計：${Number(totalPct) || 0}%</b>` : ''}
    </div>
    <div class="cost-detail-table-wrap compact" style="max-height:52vh;overflow-y:auto">
      <table class="cost-detail-table compact${threeColumns ? ' three-col' : ''}">
        <thead><tr>${head.map((heading, index) => `<th${index ? ' class="num"' : ''}>${esc(heading)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/** @param {HoldingRow[]} rows @param {number} totalCost @param {DetailFormatters} formatters */
export function costDetailHtml(rows, totalCost, formatters) {
  return detailTableHtml({
    head: ['標的', '成本'],
    items: rows.slice()
      .sort((a, b) => Number(b.costTwd || 0) - Number(a.costTwd || 0))
      .map(row => ({ label: row.symbol || '', value: Number(row.costTwd) || 0 })),
    total: totalCost,
    emptyText: '目前沒有持股'
  }, formatters);
}

/** @param {string} label @param {HoldingRow[]} rows @param {number} totalValue @param {number} baseValue @param {DetailFormatters} formatters */
export function assetHoldingDetailHtml(label, rows, totalValue, baseValue, formatters) {
  return detailTableHtml({
    head: ['標的', '市值', '佔比'],
    items: rows.slice()
      .sort((a, b) => Number(b.valueTwd || 0) - Number(a.valueTwd || 0))
      .map(row => ({
        label: row.symbol || '',
        value: Number(row.valueTwd) || 0,
        pct: pctOf(Number(row.valueTwd) || 0, baseValue)
      })),
    total: totalValue,
    totalPct: pctOf(totalValue, baseValue),
    emptyText: `目前沒有${label}部位`
  }, formatters);
}

/** @param {string} label @param {AccountRow[]} accounts @param {number} totalValue @param {DetailFormatters} formatters */
export function assetAccountDetailHtml(label, accounts, totalValue, formatters) {
  return detailTableHtml({
    head: ['帳戶', '金額'],
    items: accounts.slice()
      .sort((a, b) => Number(b.valueTwd || 0) - Number(a.valueTwd || 0))
      .map(account => ({ label: account.name || '未命名帳戶', value: Number(account.valueTwd) || 0 })),
    total: totalValue,
    emptyText: `目前沒有${label}帳戶`
  }, formatters);
}

/** @param {HoldingRow[]} rows @param {AccountRow[]} accounts @param {number} totalValue @param {number} baseValue @param {DetailFormatters} formatters */
export function assetGoldDetailHtml(rows, accounts, totalValue, baseValue, formatters) {
  const items = rows.map(row => ({ label: row.symbol || '', value: Number(row.valueTwd) || 0 }))
    .concat(accounts.map(account => ({ label: account.name || '黃金帳戶', value: Number(account.valueTwd) || 0 })))
    .sort((a, b) => b.value - a.value)
    .map(item => ({ ...item, pct: pctOf(item.value, baseValue) }));

  return detailTableHtml({
    head: ['項目', '市值', '佔比'],
    items,
    total: totalValue,
    totalPct: pctOf(totalValue, baseValue),
    emptyText: '目前沒有黃金部位'
  }, formatters);
}
