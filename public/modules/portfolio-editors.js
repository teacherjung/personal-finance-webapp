// @ts-check
// 投資編輯工作流：表單規格、凍結確認與新增／更新的副作用順序。

import { holdingFormModel, holdingSubmission, watchFormModel } from './portfolio-forms.js';

/** @typedef {{symbols:Set<string>, regions:Set<string>, equity:boolean}} Freeze */

/**
 * @param {{
 *   api: (path:string, options?:any) => Promise<any>,
 *   openForm: (config:any) => void,
 *   toast: (message:string, error?:boolean) => void,
 *   rerender: () => any,
 *   confirmFreeze: (message:string) => boolean,
 *   getFreeze: () => Freeze,
 *   layers: Record<string, {label:string}>,
 *   layerOrder: string[]
 * }} deps
 */
export function createPortfolioEditors(deps) {
  function openHolding(holding) {
    const form = holdingFormModel(holding, deps.layers, deps.layerOrder);
    deps.openForm({
      ...form,
      onSubmit: async (data) => {
        const submission = holdingSubmission(holding, data, deps.getFreeze());
        const warning = `⚠️ ${submission.symbol} 目前凍結加碼（超過：${submission.freezeReasons.join('、')}）。\n依投資原則不應加碼，確定仍要儲存？`;
        if (submission.freezeReasons.length && !deps.confirmFreeze(warning)) {
          throw new Error('已取消：該標的凍結加碼中');
        }
        if (holding) await deps.api('/holdings/' + holding.id, { method: 'PUT', body: submission.body });
        else await deps.api('/holdings', { method: 'POST', body: submission.body });
        deps.toast('已儲存');
        deps.rerender();
      }
    });
  }

  function openWatch(watch) {
    const form = watchFormModel(watch);
    deps.openForm({
      ...form,
      onSubmit: async (data) => {
        if (watch) await deps.api('/watchlist/' + watch.id, { method: 'PUT', body: data });
        else await deps.api('/watchlist', { method: 'POST', body: data });
        deps.toast('已儲存');
        deps.rerender();
      }
    });
  }

  return { openHolding, openWatch };
}
