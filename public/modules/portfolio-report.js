// @ts-check
// 投資組合列印報表：只把已算好的資料整理成 A4 HTML，不碰 DOM、API 或資料庫。

import { tradeSummary } from './portfolio-calculations.js';
import { fxExposure } from './portfolio-exposure.js';
import { formatPercent as fmtPct, formatPortfolioMoney } from './portfolio-format.js';

/** @typedef {Record<string, any> & { valueTwd:number }} ReportRow */
/** @typedef {Record<string, any>} ReportAccount */
/** @typedef {{ label:string, min:number, max:number }} ReportLayer */
/** @typedef {{ value:number, percentile:number, label:string }|null} CapeInfo */

/** @param {unknown} d */
const fmtD = (d) => d ? `${String(d).slice(0, 4)}/${String(d).slice(4, 6)}` : '';
/** @param {unknown} p @param {unknown} cur */
const fmtPrice0 = (p, cur) => {
  const n = Number(p || 0);
  const s = Math.abs(n) < 10 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US');
  return s + ' ' + (cur || '');
};

/**
 * @param {Record<string, number>} v
 * @param {(n:number)=>string} fmt
 */
const fxParts = (v, fmt) => {
  /** @type {Array<[string, number]>} */
  const parts = [['股票', v.stockTwd], ['債券', v.bondTwd], ['黃金', v.goldTwd], ['現金', v.cashTwd]];
  return parts.filter(([, value]) => Math.round(Math.abs(value)) > 0)
    .map(([label, value]) => `${label} ${fmt(value)}`)
    .join(' ＋ ');
};

/**
 * @param {{
 *   rows:ReportRow[], accounts:ReportAccount[], fx:Record<string,number>, fxSources?:Record<string,string>, settings:Record<string,any>, ibTrades:ReportRow[],
 *   total:number, totalCost:number, totalPnl:number, layerV:Record<string,number>, regionMap:Record<string,number>,
 *   eqV:number, bondV:number, goldAll:number, loanTwd:number, netEquity:number, leverage:number, capeInfo?:CapeInfo
 * }} data
 * @param {{
 *   viewCurrency:'TWD'|'USD'|string, generated:string, sortKey:string, sortDir:string,
 *   layers:Record<string,ReportLayer>, layerOrder:string[], escapeHtml:(value:unknown)=>string
 * }} options
 */
export function buildPortfolioReport(data, options) {
  const { rows, accounts, fx, fxSources = {}, settings, ibTrades, total, totalCost, totalPnl,
    layerV, regionMap, eqV, bondV, goldAll, loanTwd, netEquity, leverage, capeInfo = null } = data;
  const { viewCurrency, generated, sortKey, sortDir, layers, layerOrder, escapeHtml: esc } = options;
  const rate = fx.USD;
  const isUS = viewCurrency === 'USD';
  // 台幣報表用的美元匯率是預設值時要講（丙-2）
  const defaultUsdNote = (!isUS && fxSources.USD === 'default') ? `<p class="muted">註：台幣換算用的美元匯率是預設值 ${rate}（還沒抓到即時匯率），數字會有一點誤差。</p>` : '';
  const val = (twd) => isUS
    ? Math.round(Number(twd || 0) / rate).toLocaleString('en-US') + ' USD'
    : Math.round(Number(twd || 0)).toLocaleString('en-US') + ' 元';
  const big = (twd) => formatPortfolioMoney(twd, { viewCurrency, usdRate: rate });

  const layerRows = layerOrder.map(key => {
    const config = layers[key];
    const value = layerV[key] || 0;
    const percentage = total > 0 ? value / total * 100 : 0;
    const status = percentage > config.max ? '偏高' : percentage < config.min ? '偏低' : '符合';
    return `<tr><td>${config.label}</td><td class="num">${val(value)}</td><td class="num">${fmtPct(percentage)}</td>
      <td class="center">${config.min}–${config.max}%</td><td class="center">${status}</td></tr>`;
  }).join('');

  const byValueTwd = (a, b) => a.valueTwd - b.valueTwd;
  const sorters = {
    value: byValueTwd,
    pnl: (a, b) => a.pnlTwd - b.pnlTwd,
    ret: (a, b) => (a.costTwd ? a.pnlTwd / a.costTwd : 0) - (b.costTwd ? b.pnlTwd / b.costTwd : 0),
    weight: byValueTwd
  };
  const compare = (Object.hasOwn(sorters, sortKey) && sorters[sortKey]) || sorters.value;
  const holdingRows = layerOrder.map(key => {
    const list = rows.filter(row => (layers[row.layer] ? row.layer : 'satellite') === key).sort(compare);
    if (sortDir === 'desc') list.reverse();
    if (!list.length) return '';
    return `<tr><td colspan="8" class="group">${layers[key].label}</td></tr>` + list.map(row => {
      const avg = (row.avgCost != null && row.avgCost !== '') ? row.avgCost : (Number(row.quantity) ? Number(row.cost || 0) / Number(row.quantity) : 0);
      return `<tr>
        <td><b>${esc(row.symbol)}</b></td><td>${esc(row.name || '')}</td>
        <td class="num">${fmtPrice0(avg, row.currency)}</td><td class="num">${fmtPrice0(row.price, row.currency)}</td>
        <td class="num">${val(row.valueTwd)}</td>
        <td class="num">${row.pnlTwd >= 0 ? '+' : ''}${val(row.pnlTwd)}</td>
        <td class="num">${row.costTwd ? fmtPct(row.pnlTwd / row.costTwd * 100) : '—'}</td>
        <td class="num">${fmtPct(total > 0 ? row.valueTwd / total * 100 : 0)}</td>
      </tr>`;
    }).join('');
  }).join('');

  const byCur = fxExposure(rows, accounts, fx);
  const curTotal = Object.values(byCur).reduce((sum, currency) => sum + currency.netTwd, 0);
  const curRows = Object.entries(byCur).sort((a, b) => b[1].netTwd - a[1].netTwd).map(([currency, value]) => `<tr><td>${esc(currency)}</td>
      <td class="num">${val(value.netTwd)}</td>
      <td class="num">${fmtPct(curTotal ? value.netTwd / curTotal * 100 : 0)}</td>
      <td>${fxParts(value, val)}</td></tr>`).join('');
  const lo = Number(settings.fxLow || 28), hi = Number(settings.fxHigh || 32);
  const fxZone = fx.USD >= hi ? `已進入「美元→台幣」分批區（≥${hi}）` : fx.USD <= lo ? `已進入「台幣→美元」分批區（≤${lo}）` : `中間區（${lo}–${hi}），不動作`;

  const regionRows = Object.entries(regionMap).sort((a, b) => b[1] - a[1]).map(([region, value]) =>
    `<tr><td>${esc(region)}</td><td class="num">${val(value)}</td><td class="num">${fmtPct(eqV > 0 ? value / eqV * 100 : 0)}</td></tr>`).join('');

  const income = settings.ib?.income;
  const divTotal = income ? (income.dividends || 0) + (income.paymentInLieu || 0) : 0;
  const netFlow = income ? divTotal + (income.withholdingTax || 0) + (income.interestPaid || 0) + (income.interestReceived || 0) : 0;
  const incomeHtml = income ? `<section><h2>IBKR 現金流 <span>${fmtD(income.from)}–${fmtD(income.to)}</span></h2>
    <table><thead><tr><th class="num">股息（含替代股息）</th><th class="num">融資利息</th><th class="num">利息收入</th><th class="num">淨現金流</th></tr></thead>
    <tbody><tr><td class="num">+${val(divTotal * rate)}</td><td class="num">−${val(Math.abs(income.interestPaid || 0) * rate)}</td>
    <td class="num">+${val((income.interestReceived || 0) * rate)}</td><td class="num">${netFlow >= 0 ? '+' : '−'}${val(Math.abs(netFlow) * rate)}</td></tr></tbody></table>
    ${income.estimatedNoFx > 0 ? `<p class="muted">註：${income.estimatedNoFx} 筆${income.estimatedCurrencies?.length ? '（' + income.estimatedCurrencies.map(esc).join('、') + '）' : ''}非美元現金交易缺 IBKR 匯率，以設定或預設匯率估算。</p>` : ''}
    ${income.skippedNoFx > 0 ? `<p class="muted">註：${income.skippedNoFx} 筆現金交易的幣別系統不支援、無法換算，未計入上列金額。</p>` : ''}
    ${defaultUsdNote}
    ${Number(income.skippedNoCurrency) > 0 ? `<p class="muted">註：${income.skippedNoCurrency} 筆現金交易的報表沒有幣別欄，未計入上列金額（請在 Flex Query 勾選 Currency 欄後重新同步）。</p>` : ''}</section>` : '';

  let tradesHtml = '';
  if (ibTrades && ibTrades.length) {
    const { realized, winners, losers, ibkrCurrencies, estimatedCurrencies, defaultCurrencies = [], missingCurrencies } = tradeSummary(ibTrades, settings);
    const buys = ibTrades.filter(trade => trade.buySell === 'BUY').length;
    const list = (items) => items.map(([symbol, pnl]) => `${esc(symbol)} ${pnl >= 0 ? '+' : '−'}${val(Math.abs(pnl) * rate)}`).join('、') || '—';
    const note = ibkrCurrencies.length || estimatedCurrencies.length || defaultCurrencies.length || missingCurrencies.length
      ? `<p class="muted">${ibkrCurrencies.length ? '註解：換算匯率來自 IBKR。' : ''}${estimatedCurrencies.length ? `${estimatedCurrencies.map(esc).join('、')} 舊交易以目前設定匯率估算。` : ''}${defaultCurrencies.length ? `${defaultCurrencies.map(esc).join('、')} 交易以預設匯率估算（還沒抓到匯率）。` : ''}${missingCurrencies.length ? `${missingCurrencies.map(esc).join('、')} 是系統不支援的幣別，暫未計入。` : ''}</p>` : '';
    const tradesNote = note + defaultUsdNote;
    tradesHtml = `<section><h2>交易摘要 <span>共 ${ibTrades.length} 筆（買 ${buys}／賣 ${ibTrades.length - buys}）</span></h2>
      <table><thead><tr><th>已實現損益（FIFO）</th><th>獲利前三</th><th>虧損前三</th></tr></thead>
      <tbody><tr><td class="num"><b>${realized >= 0 ? '+' : '−'}${val(Math.abs(realized) * rate)}</b></td>
      <td>${list(winners)}</td>
      <td>${list(losers)}</td></tr></tbody></table>${tradesNote}</section>`;
  }

  const capeHtml = capeInfo
    ? `<p class="muted">Shiller PE（CAPE）：<b>${capeInfo.value.toFixed(2)}</b>（歷史分位 ~${capeInfo.percentile.toFixed(0)}%，${capeInfo.label}）</p>` : '';

  const base3 = eqV + bondV + goldAll;
  const extraCss = `
      h1, h2 { margin: 0; font-weight: 600; }
      h1 { font-size: 26px; letter-spacing: .02em; }
      h2 { font-size: 16px; margin: 0 0 10px; display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #ded8cc; padding-bottom: 8px; }
      h2 span { font-size: 13px; color: #c96442; font-weight: 500; }
      .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 18px; }
      .metric { border: 1px solid #ded8cc; border-radius: 8px; padding: 12px; }
      .metric span { color: #8a887f; display: block; margin-bottom: 6px; }
      .metric b { font-size: 19px; font-family: Georgia, "Times New Roman", serif; font-weight: 500; }
      .metric small { display: block; color: #8a887f; margin-top: 4px; }
      section { break-inside: avoid; margin: 0 0 18px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
      th, td { text-align: left; border-bottom: 1px solid #ebe6dc; padding: 6px 8px; vertical-align: top; }
      th { color: #777167; background: #f5f1e8; font-size: 11px; font-weight: 600; }
      td.num, th.num, .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .center { text-align: center; }
      td.group { background: #faf7f0; font-weight: 600; }
      footer { margin-top: 14px; border-top: 1px solid #ded8cc; padding-top: 10px; font-size: 10.5px; color: #8a887f; line-height: 1.6; }
`;
  const html = `
    <div class="preview-bar"><div><strong>投資組合報表預覽</strong></div><button onclick="window.print()">列印 / 另存</button></div>
    <main class="preview-shell"><article class="paper">
      <header class="cover">
        <div><h1>「投資組合」報表</h1>
        <p class="muted">產生日期：${esc(generated)}｜計價：${isUS ? '美元（USD）' : '台幣'}（美元/台幣 ${rate.toFixed(2)}）</p></div>
      </header>
      <div class="summary">
        <div class="metric"><span>總市值</span><b>${big(total)}</b><small>投入成本 ${big(totalCost)}</small></div>
        <div class="metric"><span>損益</span><b>${totalPnl >= 0 ? '+' : ''}${big(totalPnl)}</b><small>累積報酬率 ${totalCost ? fmtPct(totalPnl / totalCost * 100) : '—'}</small></div>
        <div class="metric"><span>IB 淨值</span><b>${big(netEquity)}</b><small>IB 融資 ${big(loanTwd)}・IB 融資槓桿 ${isFinite(leverage) ? leverage.toFixed(2) + 'x' : '∞'}</small></div>
        <div class="metric"><span>股 / 債 / 金</span><b>${[eqV, bondV, goldAll].map(value => base3 ? Math.round(value / base3 * 100) : 0).join(' / ')}</b><small>含黃金存摺，不含現金</small></div>
      </div>
      <section><h2>分層配置 vs 目標</h2>
        <table><thead><tr><th>層</th><th class="num">金額</th><th class="num">佔比</th><th class="center">目標區間</th><th class="center">狀態</th></tr></thead>
        <tbody>${layerRows}</tbody></table></section>
      <section><h2>持股明細 <span>共 ${rows.length} 檔</span></h2>
        <table><thead><tr><th>代號</th><th>說明</th><th class="num">均價</th><th class="num">現價</th><th class="num">市值</th><th class="num">損益</th><th class="num">報酬率</th><th class="num">佔比</th></tr></thead>
        <tbody>${holdingRows}</tbody></table></section>
      <section><h2>幣別淨曝險與匯率 <span>${esc(fxZone)}</span></h2>
        <table><thead><tr><th>幣別</th><th class="num">折${isUS ? '美元' : '台幣'}</th><th class="num">佔比</th><th>組成</th></tr></thead>
        <tbody>${curRows}</tbody></table></section>
      <section><h2>持股曝險 <span>佔股票部位 %（已合併 ETF 內含成分）</span></h2>
        <table><thead><tr><th>區域</th><th class="num">金額</th><th class="num">佔股票部位</th></tr></thead>
        <tbody>${regionRows}</tbody></table></section>
      ${incomeHtml}
      ${tradesHtml}
      ${capeHtml}
      <footer>口徑說明：持股成本為 FIFO 成本基礎（與 IBKR 一致，含手續費）；IBKR 部位與現金來自 Flex Query（前一交易日）；報價來自 Yahoo Finance（可能延遲 15–20 分鐘）；融資借款列為負債，淨值＝總部位−融資；區域權重為近似值。本報表僅供個人記錄，非投資建議。</footer>
    </article></main>`;

  return { title: `投資組合報表 ${generated}`, extraCss, html };
}
