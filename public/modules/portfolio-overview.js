// @ts-check
// 投資頁首與摘要：排出頁首、總覽卡、估值占位卡與 XIRR 區塊，不碰 DOM、API 或頁面狀態。

import { icon } from './icons.js';
import { CHART } from './theme.js';

/** @typedef {{escapeHtml:(value:any)=>string, formatMoney:(value:number)=>string}} OverviewFormatters */

export const XIRR_INFO_HTML = `
  <p><b>XIRR（資金加權年化報酬）</b>：把每一筆投入與拿回的錢、連同發生的時間點一起解出的年化報酬率——「你的錢實際上長多快」。與只看漲跌幅的報酬率不同，它會反映你進出場時點的效果：同樣的市場，早投入多投入的人 XIRR 較高。</p>
  <p><b>資料來源</b>：每月「記錄本月快照」的投入增量＝流出；IB 賣出的已實現損益逐筆按成交日計入；今日市值＝期末流入。口徑為台幣。</p>
  <p class="muted">限制：不含股息與利息（結果略為低估）；台股手動賣出的已實現損益未納入；快照為月頻、時點以月底近似；IB 交易紀錄僅涵蓋同步期間。外幣賣出缺 IBKR 匯率時以設定匯率估算（標示「含匯率估算」）。歷史未滿 1 年時，年化會放大短期波動，僅供參考。</p>`;

/** @param {string} viewCurrency */
export function portfolioHeaderHtml(viewCurrency) {
  return `<div class="page-head">
    <div><h1>投資組合</h1><p>核心–衛星架構：掌握配置、留意風險、等待機會。</p></div>
    <div class="page-actions">
      <span class="muted" style="font-size:12px">計價
        <span class="fee-tog ${viewCurrency === 'TWD' ? 'on' : ''}" data-cur="TWD">NT</span><span class="muted">/</span><span class="fee-tog ${viewCurrency === 'USD' ? 'on' : ''}" data-cur="USD">US</span>
      </span>
      <button class="btn-ghost icon-btn" id="printPortfolio" title="列印 / 匯出 PDF（依目前計價輸出）" aria-label="列印 / 匯出 PDF">${icon('print', 16)}</button>
      <button class="btn-ghost" id="ibSync" title="從 IBKR Flex Query 同步持倉與現金（唯讀）">${icon('download', 16)}IBKR 同步</button>
      <button class="btn-ghost" id="refreshQuotes">${icon('refresh', 16)}更新報價</button>
      <button class="btn" id="addHolding">${icon('plus', 16)}新增持股</button>
    </div>
  </div>`;
}

/**
 * 頁首三張摘要卡。
 * @param {{total:number,totalCost:number,totalPnl:number,eqV:number,bondV:number,cashV:number,goldAll:number,allBase:number,leverage:number,netEquity:number,loanTwd:number,levCap:number}} data
 * @param {Pick<OverviewFormatters, 'formatMoney'>} formatters
 */
export function portfolioSummaryHtml(data, formatters) {
  const { total, totalCost, totalPnl, eqV, bondV, cashV, goldAll, allBase, leverage, netEquity, loanTwd, levCap } = data;
  const money = formatters.formatMoney;
  const share = (value) => allBase ? Math.round(value / allBase * 100) : 0;
  return `<div class="cards">
    <div class="card"><h3><button type="button" class="info-link" id="totalValueInfo">總市值</button></h3><div class="stat sm">${money(total)}</div><div class="stat-sub"><button type="button" class="info-link" id="totalCostInfo">成本</button> ${money(totalCost)}｜<span class="${totalPnl >= 0 ? 'pos' : 'neg'}" style="font-weight:700">未實現損益 ${totalPnl >= 0 ? '+' : ''}${money(totalPnl)}</span></div></div>
    <div class="card"><h3><button type="button" class="info-link" id="assetStockInfo">股票</button> / <button type="button" class="info-link" id="assetBondInfo">債券</button> / <button type="button" class="info-link" id="assetCashInfo">現金</button> / <button type="button" class="info-link" id="assetGoldInfo">黃金</button></h3><div class="stat sm">${share(eqV)} / ${share(bondV)} / ${share(cashV)} / ${share(goldAll)}</div>
      <div class="stat-sub">含黃金存摺與現金</div>
      <div class="split-bar"><div style="width:${allBase ? eqV / allBase * 100 : 0}%;background:${CHART.blue}"></div><div style="width:${allBase ? bondV / allBase * 100 : 0}%;background:${CHART.green}"></div><div style="width:${allBase ? cashV / allBase * 100 : 0}%;background:${CHART.gray}"></div><div style="flex:1;background:${CHART.brown}"></div></div></div>
    <div class="card"><h3>IB 融資槓桿</h3><div class="stat sm ${leverage > levCap ? 'neg' : ''}">${isFinite(leverage) ? leverage.toFixed(2) + ' 倍' : '⚠️ 淨值已為負'}</div>
      <div class="stat-sub">IB 淨值 ${money(netEquity)}｜<span class="neg" style="font-weight:700">IB 融資 ${money(loanTwd)}</span></div>
      <div class="mini-bar"><div style="width:${Math.min((leverage - 1) * 100, 100)}%;background:${leverage > levCap + 0.15 ? CHART.red : leverage > levCap ? CHART.orange : CHART.green}"></div></div></div>
  </div>`;
}

export function valuationPlaceholdersHtml() {
  return `<div class="chart-card" style="margin-bottom:16px" id="signalsCard">
    <h3><button type="button" class="info-link" id="signalsInfo">估值訊號儀表</button> <span class="stat-sub" style="font-weight:400;margin:0">（五市場檔位 → 動態股債比；每月檢視）</span>
      <button class="btn-link btn-sm" id="signalsEdit" style="float:right">更新區域數值</button></h3>
    <div id="signalsBody"><p class="muted small" style="margin-top:8px">讀取中…</p></div>
  </div>

  <div class="chart-card" style="margin-bottom:16px" id="capeCard">
    <h3>Shiller PE（CAPE）估值儀表 <span class="stat-sub" style="font-weight:400;margin:0">（CSPX ⇄ QQQM 輪動的紀律閘門）</span></h3>
    <div id="capeBody"><p class="muted small" style="margin-top:8px">讀取中…</p></div>
  </div>`;
}

/**
 * 投入 vs 市值與 XIRR 摘要；圖表本身仍由頁面建立。
 * @param {any} xirr
 * @param {Pick<OverviewFormatters, 'escapeHtml'>} formatters
 */
export function xirrSectionHtml(xirr, formatters) {
  const esc = formatters.escapeHtml;
  const rate = xirr?.rate ?? 0;
  const years = xirr?.years ?? 0;
  const summary = xirr?.ok
    ? `年化報酬（XIRR）<b class="${rate >= 0 ? 'pos' : 'neg'}">${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%</b>${years < 1 ? ' <span class="muted small">未滿 1 年僅供參考</span>' : ''}${xirr.estimated ? ' <span class="muted small">含匯率估算</span>' : ''}`
    : `<span class="muted small">XIRR：${esc(xirr?.why || '')}</span>`;
  return `<div class="chart-card" style="margin-bottom:16px">
    <h3><button type="button" class="info-link" id="xirrInfo">投入 vs 市值</button> <span class="stat-sub" style="font-weight:400;margin:0">（每月快照，按左下「記錄本月快照」累積）</span>
      <span style="float:right;font-size:13px">${summary}</span></h3>
    <div class="chart-box" style="height:240px"><canvas id="investChart"></canvas></div>
    <p class="muted small" style="margin-top:8px">兩線的差距＝未實現損益。市值線的波動是市場的事；投入線持續墊高，才是你能控制的事。年化報酬（XIRR）按你每筆投入的時間點計算，點標題看說明。</p>
  </div>`;
}
