// @ts-check
// 投資說明互動：集中交易、資產、XIRR 與紀律說明彈窗的按鈕綁定。

import {
  assetAccountDetailHtml,
  assetGoldDetailHtml,
  assetHoldingDetailHtml,
  costDetailHtml,
  tradesModalHtml
} from './portfolio-details.js';
import { INCOME_INFO } from './portfolio-activity.js';
import { XIRR_INFO_HTML } from './portfolio-overview.js';
import { disciplineInfoHtml, totalValueInfoHtml } from './portfolio-info.js';

/**
 * @param {{
 *   getElement: (id:string) => any,
 *   getAll: (selector:string) => any,
 *   openInfo: (title:string, html:string, options?:any) => void,
 *   escapeHtml: (value:any) => string,
 *   formatMoney: (value:number) => string
 * }} deps
 */
export function createPortfolioInfoActions(deps) {
  /** @param {any} data */
  function bind(data) {
    deps.getAll('.info-link[data-info]').forEach((button) => {
      button.onclick = () => {
        const info = INCOME_INFO[button.dataset.info];
        if (info) deps.openInfo(info[0], info[1]);
      };
    });

    const tradesFull = deps.getElement('tradesFull');
    if (tradesFull) tradesFull.onclick = () => deps.openInfo(
      '完整交易明細',
      tradesModalHtml(data.ibTrades, { escapeHtml: deps.escapeHtml }),
      { size: 'xl' }
    );
    const totalValue = deps.getElement('totalValueInfo');
    if (totalValue) totalValue.onclick = () => deps.openInfo('總市值', totalValueInfoHtml({
      total: data.total,
      equity: data.equityValue,
      bond: data.bondValue,
      gold: data.goldValue
    }, { formatMoney: deps.formatMoney }), { size: 'md' });
    const totalCost = deps.getElement('totalCostInfo');
    if (totalCost) totalCost.onclick = () => deps.openInfo(
      '成本',
      costDetailHtml(data.rows, data.totalCost, detailFormatters()),
      { size: 'sm' }
    );
    const stock = deps.getElement('assetStockInfo');
    if (stock) stock.onclick = () => deps.openInfo(
      '股票',
      assetHoldingDetailHtml('股票', data.stockRows, data.equityValue, data.allBase, detailFormatters()),
      { size: 'sm' }
    );
    const bond = deps.getElement('assetBondInfo');
    if (bond) bond.onclick = () => deps.openInfo(
      '債券',
      assetHoldingDetailHtml('債券', data.bondRows, data.bondValue, data.allBase, detailFormatters()),
      { size: 'sm' }
    );
    const cash = deps.getElement('assetCashInfo');
    if (cash) cash.onclick = () => deps.openInfo(
      '現金',
      assetAccountDetailHtml('現金', data.cashAccounts, data.cashValue, detailFormatters()),
      { size: 'sm' }
    );
    const gold = deps.getElement('assetGoldInfo');
    if (gold) gold.onclick = () => deps.openInfo(
      '黃金',
      assetGoldDetailHtml(data.goldRows, data.goldAccounts, data.goldAll, data.allBase, detailFormatters()),
      { size: 'sm' }
    );
    const xirr = deps.getElement('xirrInfo');
    if (xirr) xirr.onclick = () => deps.openInfo('年化報酬（XIRR）', XIRR_INFO_HTML, { size: 'md' });
    const discipline = deps.getElement('disciplineInfo');
    if (discipline) discipline.onclick = () => deps.openInfo('紀律檢查', disciplineInfoHtml(data.caps));
  }

  const detailFormatters = () => ({ escapeHtml: deps.escapeHtml, formatMoney: deps.formatMoney });
  return { bind };
}
