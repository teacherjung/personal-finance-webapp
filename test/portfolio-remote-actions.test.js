import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolioRemoteActions } from '../public/modules/portfolio-remote-actions.js';

function setup(overrides = {}) {
  const calls = [];
  const notices = [];
  let renders = 0;
  const actions = createPortfolioRemoteActions({
    api: async (path, options) => { calls.push({ path, options }); return {}; },
    toast: (message, error = false) => { notices.push({ message, error }); },
    rerender: () => { renders += 1; },
    getRouteSeq: () => 1,
    today: () => '2026-07-22',
    formatOriginalMoney: (amount, currency) => `${amount} ${currency}`,
    confirmMissing: () => false,
    ...overrides
  });
  return { actions, calls, notices, getRenders: () => renders };
}

test('投資遠端操作｜更新報價依序寫匯率、持股、願望清單，成功後才提示與重畫', async () => {
  const calls = [];
  const state = setup({
    api: async (path, options) => {
      calls.push({ path, options });
      if (path.startsWith('/quotes?')) {
        return {
          AAPL: { price: 201.126, currency: 'USD' },
          QQQM: { price: 299.995 },
          'TWD=X': { price: 32.1236 }
        };
      }
      return {};
    }
  });
  const button = { disabled: false, textContent: '', innerHTML: '' };

  await state.actions.refreshQuotes(
    button,
    [{ id: 'h1', quoteSymbol: 'AAPL', currency: 'USD' }],
    [{ id: 'w1', quoteSymbol: 'QQQM' }],
    { fxTwd: { GBP: 41 } }
  );

  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '更新中…');
  assert.deepEqual(calls.map(call => [call.path, call.options?.method]), [
    ['/quotes?symbols=AAPL%2CQQQM%2CTWD%3DX%2CGBPTWD%3DX%2CJPYTWD%3DX', undefined],
    ['/settings', 'PUT'],
    ['/holdings/h1', 'PUT'],
    ['/watchlist/w1', 'PUT']
  ]);
  assert.deepEqual(calls[1].options.body, { usdTwd: 32.124, fxTwd: { GBP: 41 } });
  assert.deepEqual(calls[2].options.body, { price: 201.13 });
  assert.deepEqual(calls[3].options.body, { lastPrice: 300, lastAt: '2026-07-22' });
  assert.deepEqual(state.notices, [{ message: '已更新 1 檔報價與匯率', error: false }]);
  assert.equal(state.getRenders(), 1);
});

test('投資遠端操作｜更新報價期間切頁仍完成寫入，但不把舊投資頁重畫回來', async () => {
  let routeSeq = 1;
  const state = setup({
    getRouteSeq: () => routeSeq,
    api: async (path) => {
      if (path.startsWith('/quotes?')) {
        routeSeq = 2;
        return { 'TWD=X': { price: 32 } };
      }
      return {};
    }
  });

  await state.actions.refreshQuotes({ disabled: false, textContent: '', innerHTML: '' }, [], [], {});

  assert.equal(state.getRenders(), 0);
  assert.deepEqual(state.notices, [{ message: '已更新 0 檔報價與匯率', error: false }]);
});

test('投資遠端操作｜更新報價失敗會復原按鈕並顯示錯誤，不重畫', async () => {
  const state = setup({ api: async () => { throw new Error('網路中斷'); } });
  const button = { disabled: false, textContent: '', innerHTML: '' };

  await state.actions.refreshQuotes(button, [], [], {});

  assert.equal(button.disabled, false);
  assert.match(button.innerHTML, /更新報價/);
  assert.deepEqual(state.notices, [{ message: '更新失敗：網路中斷', error: true }]);
  assert.equal(state.getRenders(), 0);
});

test('投資遠端操作｜IBKR 同步回報異常；拒絕移除可能出清持股時零刪除', async () => {
  let warning = '';
  const state = setup({
    api: async (path, options) => {
      state.calls.push({ path, options });
      return { updated: 2, created: 1, cashReportMissing: true, missing: [{ id: 'h1', symbol: 'AAPL' }] };
    },
    confirmMissing: message => { warning = message; return false; }
  });
  const button = { disabled: false, textContent: '', innerHTML: '' };

  await state.actions.syncIb(button);

  assert.deepEqual(state.calls.map(call => call.path), ['/ib/sync']);
  assert.match(warning, /AAPL/);
  assert.equal(state.notices[0].message, 'IBKR 同步完成：更新 2 檔、新增 1 檔');
  assert.equal(state.notices[1].error, true);
  assert.equal(state.getRenders(), 1);
});

test('投資遠端操作｜確認出清後逐檔刪除；同步失敗則復原按鈕', async () => {
  const calls = [];
  const success = setup({
    api: async (path, options) => {
      calls.push({ path, options });
      if (path === '/ib/sync') return { updated: 0, created: 0, missing: [{ id: 'h1', symbol: 'AAPL' }, { id: 'h2', symbol: 'MSFT' }] };
      return {};
    },
    confirmMissing: () => true
  });
  await success.actions.syncIb({ disabled: false, textContent: '', innerHTML: '' });
  assert.deepEqual(calls.map(call => [call.path, call.options?.method]), [
    ['/ib/sync', 'POST'],
    ['/holdings/h1', 'DELETE'],
    ['/holdings/h2', 'DELETE']
  ]);
  assert.equal(success.notices.at(-1).message, '已移除 2 檔已出清持股');

  const failure = setup({ api: async () => { throw new Error('Flex 逾時'); } });
  const button = { disabled: false, textContent: '', innerHTML: '' };
  await failure.actions.syncIb(button);
  assert.equal(button.disabled, false);
  assert.match(button.innerHTML, /IBKR 同步/);
  assert.deepEqual(failure.notices, [{ message: 'IBKR 同步失敗：Flex 逾時', error: true }]);
  assert.equal(failure.getRenders(), 0);
});
