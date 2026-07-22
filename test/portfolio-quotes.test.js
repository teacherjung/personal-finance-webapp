import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portfolioQuoteSymbols, portfolioQuoteWritePlan } from '../public/modules/portfolio-quotes.js';

test('投資報價｜請求代號去重，並固定保留三種換匯代號', () => {
  const symbols = portfolioQuoteSymbols(
    [{ quoteSymbol: 'CSPX.L' }, { quoteSymbol: 'CSPX.L' }, {}],
    [{ quoteSymbol: 'QQQM' }, { quoteSymbol: 'TWD=X' }]
  );
  assert.deepEqual(symbols, ['CSPX.L', 'QQQM', 'TWD=X', 'GBPTWD=X', 'JPYTWD=X']);
});

test('投資報價｜美元英鎊日圓匯率依原精度四捨五入，既有其他幣別不消失', () => {
  const plan = portfolioQuoteWritePlan([], [], { fxTwd: { EUR: 35, GBP: 40 } }, {
    'TWD=X': { price: 32.1236 },
    'GBPTWD=X': { price: 41.9876 },
    'JPYTWD=X': { price: 0.21876 }
  });
  assert.deepEqual(plan.fxBody, { usdTwd: 32.124, fxTwd: { EUR: 35, GBP: 41.988, JPY: 0.2188 } });
  assert.equal(plan.saveFx, true);
});

test('投資報價｜持股缺幣別視為 TWD；幣別不符與缺報價都略過', () => {
  const plan = portfolioQuoteWritePlan([
    { id: 'tw', quoteSymbol: '0050.TW' },
    { id: 'gb', quoteSymbol: 'CSPX.L', currency: 'GBP' },
    { id: 'missing', quoteSymbol: 'NOPE', currency: 'USD' },
    { id: 'manual', currency: 'USD' }
  ], [], {}, {
    '0050.TW': { price: 188.126, currency: 'TWD' },
    'CSPX.L': { price: 806.12, currency: 'USD' }
  });
  assert.deepEqual(plan.holdingWrites, [{ id: 'tw', body: { price: 188.13 } }]);
  assert.equal(plan.updatedHoldings, 1);
  assert.equal(plan.skippedHoldings, 2);
});

test('投資報價｜願望清單只收有效報價並四捨五入，不把缺資料算成持股略過', () => {
  const plan = portfolioQuoteWritePlan([], [
    { id: 'ok', quoteSymbol: 'QQQM' },
    { id: 'none', quoteSymbol: 'NOPE' },
    { id: 'manual' }
  ], {}, {
    QQQM: { price: 291.995 },
    NOPE: { price: null }
  });
  assert.deepEqual(plan.watchWrites, [{ id: 'ok', body: { lastPrice: 292 } }]);
  assert.equal(plan.skippedHoldings, 0);
});
