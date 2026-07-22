// @ts-check
// 投資研究互動：研究表單與檢查點的新增、寫入、提示與重畫。

import { researchFormModel } from './portfolio-research.js';
import { normalizePortfolioSymbol } from './portfolio-symbol.js';

/**
 * @param {{
 *   api: (path:string, options?:any) => Promise<any>,
 *   getElement: (id:string) => any,
 *   getAll: (selector:string) => any,
 *   openForm: (config:any) => void,
 *   toast: (message:string, error?:boolean) => void,
 *   rerender: () => any,
 *   today: () => string
 * }} deps
 */
export function createPortfolioResearchActions(deps) {
  /** @param {string} symbol @param {any[]} research */
  async function addCheckpoint(symbol, research) {
    const normalizedSymbol = normalizePortfolioSymbol(symbol);
    const input = deps.getElement('cp_' + normalizedSymbol);
    const note = (input?.value || '').trim();
    if (!note) return deps.toast('先輸入筆記內容', true);
    const existing = research.find(item => normalizePortfolioSymbol(item.symbol) === normalizedSymbol);
    const checkpoint = { date: deps.today(), note };
    try {
      if (existing) {
        await deps.api('/research/' + existing.id, {
          method: 'PUT',
          body: { checkpoints: [...(existing.checkpoints || []), checkpoint] }
        });
      } else {
        await deps.api('/research', {
          method: 'POST',
          body: { symbol: normalizedSymbol, thesis: '', metrics: '', risks: '', checkpoints: [checkpoint] }
        });
      }
      deps.toast('已記錄檢查點');
      deps.rerender();
    } catch (error) {
      deps.toast(error.message, true);
    }
  }

  /** @param {string} symbol @param {any[]} research */
  function openResearchForm(symbol, research) {
    const form = researchFormModel(symbol, research);
    deps.openForm({
      title: form.title,
      fields: form.fields,
      values: form.values,
      onSubmit: async (data) => {
        if (form.existing) await deps.api('/research/' + form.existing.id, { method: 'PUT', body: data });
        else await deps.api('/research', { method: 'POST', body: { symbol: form.symbol, ...data, checkpoints: [] } });
        deps.toast('已儲存');
        deps.rerender();
      }
    });
  }

  /** @param {any[]} research */
  function bind(research) {
    deps.getAll('[data-edit-r]').forEach((button) => {
      button.onclick = () => openResearchForm(button.dataset.editR, research);
    });
    deps.getAll('[data-add-cp]').forEach((button) => {
      button.onclick = () => addCheckpoint(button.dataset.addCp, research);
    });
  }

  return { addCheckpoint, bind, openResearchForm };
}
