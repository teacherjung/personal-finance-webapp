// @ts-check
// 投資估值操作：CAPE／實質利率載入、估值說明與三個設定表單。

import { capeBodyHtml, signalsBodyHtml, SIGNALS_INFO_HTML } from './portfolio-valuation.js';
import { capeFormModel, fxBandsFormModel, signalsFormModel } from './portfolio-forms.js';

/**
 * @param {{
 *   api: (path:string, options?:any) => Promise<any>,
 *   getElement: (id:string) => any,
 *   openForm: (config:any) => void,
 *   openInfo: (title:string, html:string, options?:any) => void,
 *   toast: (message:string, error?:boolean) => void,
 *   rerender: () => any,
 *   isCurrentRender: () => boolean,
 *   escapeHtml: (value:any) => string,
 *   formatPercent: (value:number, digits?:number) => string
 * }} deps
 */
export function createPortfolioValuationActions(deps) {
  /** @param {any} settings */
  function openFxBands(settings) {
    const form = fxBandsFormModel(settings);
    deps.openForm({
      ...form,
      onSubmit: async (data) => {
        await deps.api('/settings', { method: 'PUT', body: { fxLow: Number(data.fxLow), fxHigh: Number(data.fxHigh) } });
        deps.toast('已更新換匯區間');
        deps.rerender();
      }
    });
  }

  /** @param {any} settings */
  async function loadSignals(settings) {
    const body = deps.getElement('signalsBody');
    if (!body) return;
    let cape = null;
    let realYield = null;
    try {
      [cape, realYield] = await Promise.all([deps.api('/cape'), deps.api('/realyield')]);
    } catch {}
    if (!deps.isCurrentRender() || body !== deps.getElement('signalsBody')) return;
    body.innerHTML = signalsBodyHtml(settings, cape, realYield, { escapeHtml: deps.escapeHtml });
  }

  /** @param {any} settings */
  function openSignalsForm(settings) {
    const form = signalsFormModel(settings);
    deps.openForm({
      ...form,
      onSubmit: async (data) => {
        await deps.api('/settings', { method: 'PUT', body: { signals: { ...form.values, ...data } } });
        deps.toast('估值訊號已更新');
        deps.rerender();
      }
    });
  }

  /** @param {any} settings @param {number} qqqmShare @param {number} qqqmMax */
  async function loadCape(settings, qqqmShare, qqqmMax) {
    const body = deps.getElement('capeBody');
    if (!body) return;
    let cape = null;
    try { cape = await deps.api('/cape'); } catch {}
    if (!deps.isCurrentRender() || body !== deps.getElement('capeBody')) return;
    body.innerHTML = capeBodyHtml(cape, qqqmShare, qqqmMax, {
      escapeHtml: deps.escapeHtml,
      formatPercent: deps.formatPercent
    });
    const button = deps.getElement('capeManualBtn');
    if (button) button.onclick = () => openCapeManual(settings);
  }

  /** @param {any} settings */
  function openCapeManual(settings) {
    const form = capeFormModel(settings);
    deps.openForm({
      ...form,
      onSubmit: async (data) => {
        await deps.api('/settings', { method: 'PUT', body: { capeManual: data.capeManual } });
        deps.toast('已更新 CAPE 手動值');
        deps.rerender();
      }
    });
  }

  /**
   * @param {any} settings
   * @param {number} qqqmShare
   * @param {number} qqqmMax
   */
  async function bind(settings, qqqmShare, qqqmMax) {
    const fxEdit = deps.getElement('fxBandEdit');
    if (fxEdit) fxEdit.onclick = () => openFxBands(settings);

    const capeLoad = loadCape(settings, qqqmShare, qqqmMax);
    const signalsLoad = loadSignals(settings);
    const signalsInfo = deps.getElement('signalsInfo');
    if (signalsInfo) signalsInfo.onclick = () => deps.openInfo('估值訊號儀表', SIGNALS_INFO_HTML, { size: 'md' });
    const signalsEdit = deps.getElement('signalsEdit');
    if (signalsEdit) signalsEdit.onclick = () => openSignalsForm(settings);
    await Promise.all([capeLoad, signalsLoad]);
  }

  return { bind, loadCape, loadSignals, openCapeManual, openFxBands, openSignalsForm };
}
