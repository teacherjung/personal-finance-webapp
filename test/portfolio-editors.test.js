import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolioEditors } from '../public/modules/portfolio-editors.js';

const LAYERS = { core: { label: '核心' }, stock: { label: '個股' } };
const ORDER = ['core', 'stock'];

function setup(overrides = {}) {
  const calls = [];
  const notices = [];
  let form = null;
  let renders = 0;
  const editors = createPortfolioEditors({
    api: async (path, options) => { calls.push({ path, options }); },
    openForm: config => { form = config; },
    toast: message => { notices.push(message); },
    rerender: () => { renders += 1; },
    confirmFreeze: () => true,
    getFreeze: () => ({ symbols: new Set(), regions: new Set(), equity: false }),
    layers: LAYERS,
    layerOrder: ORDER,
    ...overrides
  });
  return { editors, calls, notices, getForm: () => form, getRenders: () => renders };
}

test('投資編輯流程｜新增持股整理金額後只送一次 POST，成功才提示並重畫', async () => {
  const state = setup();
  state.editors.openHolding(null);
  const form = state.getForm();

  assert.equal(form.title, '新增持股');
  await form.onSubmit({ symbol: ' cspx ', layer: 'core', quantity: 3, avgCost: 10.126, price: 12.345 });

  assert.deepEqual(state.calls, [{
    path: '/holdings',
    options: {
      method: 'POST',
      body: { symbol: 'CSPX', layer: 'core', quantity: 3, avgCost: 10.13, price: 12.35, cost: 30.39 }
    }
  }]);
  assert.deepEqual(state.notices, ['已儲存']);
  assert.equal(state.getRenders(), 1);
});

test('投資編輯流程｜凍結持股取消加碼時不寫入、不提示也不重畫', async () => {
  let warning = '';
  let freeze = { symbols: new Set(), regions: new Set(), equity: false };
  const state = setup({
    confirmFreeze: message => { warning = message; return false; },
    getFreeze: () => freeze
  });
  state.editors.openHolding({ id: 'h1', symbol: 'AAPL', quantity: 1, layer: 'stock' });
  const form = state.getForm();
  freeze = { symbols: new Set(['AAPL']), regions: new Set(), equity: false };

  await assert.rejects(
    form.onSubmit({ symbol: 'aapl', layer: 'stock', quantity: 2, avgCost: 100, price: 110 }),
    /已取消：該標的凍結加碼中/
  );
  assert.match(warning, /AAPL 目前凍結加碼（超過：單一個股上限）/);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.notices, []);
  assert.equal(state.getRenders(), 0);
});

test('投資編輯流程｜編輯願望清單沿用原資料並只送 PUT', async () => {
  const state = setup();
  state.editors.openWatch({ id: 'w1', symbol: 'QQQM', currency: 'USD' });
  const form = state.getForm();

  assert.equal(form.title, '編輯願望清單');
  assert.equal(form.values.symbol, 'QQQM');
  const body = { symbol: 'QQQM', currency: 'USD', targetPrice: 180 };
  await form.onSubmit(body);

  assert.deepEqual(state.calls, [{ path: '/watchlist/w1', options: { method: 'PUT', body } }]);
  assert.deepEqual(state.notices, ['已儲存']);
  assert.equal(state.getRenders(), 1);
});

test('投資編輯流程｜新增願望清單只送 POST', async () => {
  const state = setup();
  state.editors.openWatch(null);
  const form = state.getForm();

  assert.equal(form.title, '新增願望清單');
  const body = { symbol: 'KWEB', currency: 'USD', targetPrice: 25 };
  await form.onSubmit(body);

  assert.deepEqual(state.calls, [{ path: '/watchlist', options: { method: 'POST', body } }]);
  assert.deepEqual(state.notices, ['已儲存']);
  assert.equal(state.getRenders(), 1);
});
