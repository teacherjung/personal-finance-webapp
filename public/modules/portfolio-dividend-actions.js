// @ts-check
import { dividendEquivalent, dividendResultText } from './portfolio-dividend.js';

/** 每輪綁定自己的收入與節點；舊事件不得把上輪換算寫進新頁面。
 * @param {{income:any,getElement:(id:string)=>any,isCurrentRender:()=>boolean}} deps */
export function bindDividendActions({ income, getElement, isCurrentRender }) {
  const snapshot = income && typeof income === 'object' && !Array.isArray(income) ? Object.freeze({ ...income }) : income;
  const panel = getElement('dividendEquivalence');
  if (!panel) return;
  const form = panel.querySelector('form');
  const input = panel.querySelector('input');
  const output = panel.querySelector('output');
  const clear = panel.querySelector('[data-dividend-clear]');
  if (!form || !input || !output || !clear) return;
  const active = () => isCurrentRender() && getElement('dividendEquivalence') === panel;
  const update = () => {
    if (!active()) return;
    output.textContent = dividendResultText(dividendEquivalent(snapshot, { currency: 'USD', amountText: input.value }));
  };
  input.oninput = update;
  form.onsubmit = event => { event.preventDefault(); update(); };
  clear.onclick = () => {
    if (!active()) return;
    input.value = '';
    update();
    input.focus();
  };
  update();
}
