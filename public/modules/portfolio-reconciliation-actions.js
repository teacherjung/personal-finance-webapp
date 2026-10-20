// @ts-check
import { createPortfolioReferenceSession } from './portfolio-reconciliation.js';
import { createReferenceView } from './portfolio-reconciliation-view.js';

/** @param {any} deps */
export function createPortfolioReconciliationActions(deps) {
  let disposed = false;
  let closeCurrent = () => {};
  const entry = deps.getElement('compareReferenceQuantity');
  const presenter = createReferenceView({ escapeHtml: deps.escapeHtml });

  function open() {
    if (disposed || !deps.isCurrentRender() || !entry?.isConnected) return;
    const media = deps.getMediaQuery();
    if (!media.matches) return;
    closeCurrent();
    const session = createPortfolioReferenceSession(deps.holdings);
    const shell = deps.openModalShell({
      title: '參考數量比對', size: 'lg',
      bodyHtml: session.ok
        ? presenter.initialForm(session.read().rows)
        : '<p>本頁持股資料形狀無法判讀，未建立比對。請關閉並重新載入投資組合。</p>'
    });
    const { root } = shell;
    const dialog = root.querySelector('.modal');
    const form = dialog.querySelector('[data-reference-form]');
    const result = form?.querySelector('[data-reference-result]');
    // 外殼先接管，watch 才屬於本窗；換頁後仍須用原 close 的身分守衛清場。
    const owns = deps.watchModalRoot();
    let finished = false;
    let unlisten = () => {};
    let stopObserving = () => {};
    const valid = () => !finished && !disposed && deps.isCurrentRender() && media.matches
      && entry.isConnected && owns() && root.querySelector('.modal') === dialog
      && (!form || (dialog.querySelector('[data-reference-form]') === form && form.querySelector('[data-reference-result]') === result));
    function finish() {
      if (finished) return;
      finished = true;
      if (session.ok) session.dispose();
      form?.removeEventListener('input', change);
      form?.removeEventListener('change', change);
      form?.removeEventListener('submit', calculate);
      form?.querySelector('[data-reference-close]')?.removeEventListener('click', finish);
      media.removeEventListener('change', check);
      unlisten();
      stopObserving();
      shell.close();
    }
    function check() { if (!valid()) finish(); }
    function refresh() {
      if (!session.ok) return;
      const state = session.read();
      for (const [name, value] of Object.entries(state.confirmations)) form.elements.namedItem(name).checked = value;
      const matches = state.rows.filter(row => row.id === state.selectedId);
      const selected = matches.length === 1 ? matches[0] : undefined;
      const comparison = state.comparison || {
        kind: 'parallel', reasons: ['calculation-required'], difference: null,
        referenceQuantity: state.reference.quantity, appQuantity: selected?.quantity,
        referenceDate: state.reference.date
      };
      result.innerHTML = presenter.resultHtml({ comparison, reference: state.reference, selected });
    }
    function change(event) {
      if (!valid()) { finish(); return; }
      if (!session.ok) return;
      const input = event.target;
      if (input.form !== form) return;
      const changed = input.name === 'selectedId' ? session.select(input.value)
        : input.type === 'checkbox' ? session.setConfirmation(input.name, input.checked)
          : session.setReferenceField(input.name, input.value);
      if (!changed.ok) { finish(); return; }
      refresh();
    }
    function calculate(event) {
      event.preventDefault();
      if (!valid()) { finish(); return; }
      // 送出時也讀本窗當前值，避免未發 input 的填值沿用舊差額或舊身分確認。
      if (!session.ok) return;
      const before = session.read();
      const selection = session.select(form.elements.namedItem('selectedId').value);
      if (!selection.ok) { finish(); return; }
      let contextChanged = selection.changed;
      for (const name of Object.keys(before.reference)) {
        const change = session.setReferenceField(name, form.elements.namedItem(name).value);
        if (!change.ok) { finish(); return; }
        if (name !== 'quantity' && change.changed) contextChanged = true;
      }
      if (!contextChanged) {
        for (const name of Object.keys(before.confirmations)) {
          const change = session.setConfirmation(name, form.elements.namedItem(name).checked);
          if (!change.ok) { finish(); return; }
        }
      }
      session.calculate();
      refresh();
    }
    closeCurrent = finish;
    unlisten = deps.onNavigate(finish);
    media.addEventListener('change', check);
    stopObserving = deps.observeModal(root, check);
    if (session.ok) {
      form.addEventListener('input', change);
      form.addEventListener('change', change);
      form.addEventListener('submit', calculate);
      form.querySelector('[data-reference-close]').addEventListener('click', finish);
      refresh();
    }
  }
  if (entry) entry.onclick = open;
  function dispose() {
    disposed = true;
    closeCurrent();
    if (entry?.onclick === open) entry.onclick = null;
  }
  return { open, dispose };
}
