// @ts-check
// 投資遠端操作：IBKR 同步與 Yahoo 報價更新的按鈕、寫入與回報順序。

import { icon } from './icons.js';
import { ibSyncFeedback } from './portfolio-ib-sync.js';
import { portfolioQuoteSymbols, portfolioQuoteWritePlan } from './portfolio-quotes.js';

/**
 * @param {{
 *   api: (path:string, options?:any) => Promise<any>,
 *   toast: (message:string, error?:boolean) => void,
 *   rerender: () => any,
 *   getRouteSeq: () => number,
 *   today: () => string,
 *   formatOriginalMoney: (amount:number, currency:string) => string,
 *   confirmMissing: (message:string) => boolean
 * }} deps
 */
export function createPortfolioRemoteActions(deps) {
  /** @param {any} btn */
  async function syncIb(btn) {
    const seqAtStart = deps.getRouteSeq();
    btn.disabled = true;
    btn.textContent = 'IBKR 同步中…（最多約 15 秒）';
    try {
      const result = await deps.api('/ib/sync', { method: 'POST' });
      for (const feedback of ibSyncFeedback(result, deps.formatOriginalMoney)) {
        deps.toast(feedback.message, feedback.error);
      }
      if (result.missing && result.missing.length) {
        const names = result.missing.map((holding) => holding.symbol).join('、');
        const message = `這些持股在 IBKR 報表中已找不到（可能已出清）：\n\n${names}\n\n要從投資組合移除嗎？`;
        if (deps.confirmMissing(message)) {
          for (const holding of result.missing) {
            await deps.api('/holdings/' + holding.id, { method: 'DELETE' });
          }
          deps.toast(`已移除 ${result.missing.length} 檔已出清持股`);
        }
      }
      if (seqAtStart === deps.getRouteSeq()) deps.rerender();
    } catch (error) {
      deps.toast('IBKR 同步失敗：' + error.message, true);
      btn.disabled = false;
      btn.innerHTML = icon('download', 16) + 'IBKR 同步';
    }
  }

  /**
   * @param {any} btn
   * @param {any[]} holdings
   * @param {any[]} watchlist
   * @param {any} settings
   */
  async function refreshQuotes(btn, holdings, watchlist, settings) {
    const seqAtStart = deps.getRouteSeq();
    const symbols = portfolioQuoteSymbols(holdings, watchlist);
    if (!symbols.length) return deps.toast('沒有可更新的報價代號', true);
    btn.disabled = true;
    btn.textContent = '更新中…';
    try {
      const quotes = await deps.api('/quotes?symbols=' + encodeURIComponent(symbols.join(',')));
      const plan = portfolioQuoteWritePlan(holdings, watchlist, settings, quotes);
      if (plan.saveFx) await deps.api('/settings', { method: 'PUT', body: plan.fxBody });
      for (const write of plan.holdingWrites) {
        await deps.api('/holdings/' + write.id, { method: 'PUT', body: write.body });
      }
      for (const write of plan.watchWrites) {
        await deps.api('/watchlist/' + write.id, { method: 'PUT', body: { ...write.body, lastAt: deps.today() } });
      }
      deps.toast(`已更新 ${plan.updatedHoldings} 檔報價與匯率${plan.skippedHoldings ? `，${plan.skippedHoldings} 檔略過（無資料或幣別不符）` : ''}`);
      if (seqAtStart === deps.getRouteSeq()) deps.rerender();
    } catch (error) {
      deps.toast('更新失敗：' + error.message, true);
      btn.disabled = false;
      btn.innerHTML = icon('refresh', 16) + '更新報價';
    }
  }

  return { refreshQuotes, syncIb };
}
