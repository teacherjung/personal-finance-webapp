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

// 丙（Codex #556 r3）：null 現在是合法的「清除美元匯率」，所以壞報價絕不可算成 NaN 再變 null 送出去。
test('更新報價｜美元報價是壞值（非數字／0／負數）→ 不寫 usdTwd（省略該欄，不可變 null 清掉舊值）；同批的英鎊照寫、saveFx 仍為 true', async () => {
  const { portfolioQuoteWritePlan: plan } = await import('../public/modules/portfolio-quotes.js');
  for (const bad of ['not-a-rate', 0, -1, NaN, '']) {
    const p = plan([], [], { fxTwd: { GBP: 40 } }, /** @type {any} */ ({ 'TWD=X': { price: bad, currency: '' }, 'GBPTWD=X': { price: 41, currency: '' } }));
    assert.ok(!Object.hasOwn(p.fxBody, 'usdTwd'), `壞值 ${JSON.stringify(bad)} 不可出現在 fxBody（null 會清掉舊的美元匯率）`);
    assert.equal(p.fxBody.fxTwd.GBP, 41, '英鎊照寫');
    assert.equal(p.saveFx, true, '有任何一個匯率抓到就要存');
  }
  const ok = plan([], [], {}, /** @type {any} */ ({ 'TWD=X': { price: '31.5', currency: '' } }));
  assert.equal(ok.fxBody.usdTwd, 31.5, '對照：數字字串照寫');
});
