import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolioValuationActions } from '../public/modules/portfolio-valuation-actions.js';

const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function setup(overrides = {}) {
  const calls = [];
  const notices = [];
  const elements = new Map();
  let form = null;
  let info = null;
  let renders = 0;
  const actions = createPortfolioValuationActions({
    api: async (path, options) => { calls.push({ path, options }); return {}; },
    getElement: id => elements.get(id) || null,
    openForm: config => { form = config; },
    openInfo: (title, html, options) => { info = { title, html, options }; },
    toast: message => { notices.push(message); },
    rerender: () => { renders += 1; },
    isCurrentRender: () => true,
    escapeHtml,
    formatPercent: value => `${Number(value).toFixed(1)}%`,
    ...overrides
  });
  return {
    actions, calls, notices, elements,
    getForm: () => form,
    getInfo: () => info,
    getRenders: () => renders
  };
}

test('投資估值操作｜五市場訊號同時讀 CAPE 與實質利率並填入儀表', async () => {
  const calls = [];
  const state = setup({
    api: async path => {
      calls.push(path);
      if (path === '/cape') return { value: 25 };
      if (path === '/realyield') return { value: 1 };
      return {};
    }
  });
  const body = { innerHTML: '' };
  state.elements.set('signalsBody', body);

  await state.actions.loadSignals({ signals: {} });

  assert.deepEqual(calls, ['/cape', '/realyield']);
  assert.match(body.innerHTML, /建議股債比 80 : 20/);
  assert.match(body.innerHTML, /ECY <b>3\.0%<\/b>/);
});

test('投資估值操作｜外部估值抓取失敗仍顯示誠實退路，不阻斷頁面', async () => {
  const state = setup({ api: async () => { throw new Error('外部服務中斷'); } });
  const signalsBody = { innerHTML: '' };
  const capeBody = { innerHTML: '' };
  state.elements.set('signalsBody', signalsBody);
  state.elements.set('capeBody', capeBody);
  state.elements.set('capeManualBtn', { onclick: null });

  await Promise.all([
    state.actions.loadSignals({ signals: {} }),
    state.actions.loadCape({}, 10, 30)
  ]);

  assert.match(signalsBody.innerHTML, /暫時無法計算/);
  assert.match(capeBody.innerHTML, /無法自動取得 CAPE/);
  assert.equal(typeof state.elements.get('capeManualBtn').onclick, 'function');
  state.elements.get('capeManualBtn').onclick();
  assert.equal(state.getForm().title, '手動設定 Shiller PE');
});

test('投資估值操作｜啟動後綁定說明、區域更新與休眠匯率入口', async () => {
  const state = setup();
  for (const id of ['fxBandEdit', 'signalsInfo', 'signalsEdit', 'capeBody', 'signalsBody']) {
    state.elements.set(id, { innerHTML: '', onclick: null });
  }
  state.elements.set('capeManualBtn', { onclick: null });

  await state.actions.bind({ signals: { china: 11 } }, 20, 30);

  state.elements.get('signalsInfo').onclick();
  assert.deepEqual(state.getInfo().title, '估值訊號儀表');
  assert.deepEqual(state.getInfo().options, { size: 'md' });
  state.elements.get('signalsEdit').onclick();
  assert.equal(state.getForm().title, '更新估值訊號（區域市場，每月一次）');
  state.elements.get('fxBandEdit').onclick();
  assert.equal(state.getForm().title, '調整換匯分批區間');
});

test('投資估值操作｜三種表單維持原寫入內容，成功後才提示與重畫', async () => {
  const state = setup();

  state.actions.openFxBands({ fxLow: 28, fxHigh: 32 });
  await state.getForm().onSubmit({ fxLow: '27.5', fxHigh: '33.5' });
  state.actions.openSignalsForm({ signals: { china: 12, japan: 1.1 } });
  await state.getForm().onSubmit({ china: 10, korea: 0.8 });
  state.actions.openCapeManual({ capeManual: 20 });
  await state.getForm().onSubmit({ capeManual: '24.6' });

  assert.deepEqual(state.calls, [
    { path: '/settings', options: { method: 'PUT', body: { fxLow: 27.5, fxHigh: 33.5 } } },
    { path: '/settings', options: { method: 'PUT', body: { signals: { china: 10, japan: 1.1, korea: 0.8 } } } },
    { path: '/settings', options: { method: 'PUT', body: { capeManual: '24.6' } } }
  ]);
  assert.deepEqual(state.notices, ['已更新換匯區間', '估值訊號已更新', '已更新 CAPE 手動值']);
  assert.equal(state.getRenders(), 3);
});

test('投資估值操作｜舊 render 或已被替換的容器不接收晚回來的估值結果', async () => {
  /** @type {(value:any) => void} */
  let resolveCape = () => {};
  let current = true;
  const state = setup({
    api: async () => new Promise(resolve => { resolveCape = resolve; }),
    isCurrentRender: () => current
  });
  const oldBody = { innerHTML: '' };
  state.elements.set('capeBody', oldBody);

  const staleRouteLoad = state.actions.loadCape({}, 10, 30);
  current = false;
  resolveCape({ value: 25 });
  await staleRouteLoad;
  assert.equal(oldBody.innerHTML, '');

  current = true;
  const replacedLoad = state.actions.loadCape({}, 10, 30);
  const newBody = { innerHTML: '' };
  state.elements.set('capeBody', newBody);
  resolveCape({ value: 25 });
  await replacedLoad;
  assert.equal(oldBody.innerHTML, '');
  assert.equal(newBody.innerHTML, '');
});
