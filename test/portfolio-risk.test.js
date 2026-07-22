import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portfolioCaps, portfolioFreeze, stockExposureBySymbol } from '../public/modules/portfolio-risk.js';

test('投資風險｜未設定採預設值，明確設定 0 不被改回預設', () => {
  assert.deepEqual(portfolioCaps({}), {
    stock: 5, equity: 90, country: 15, china: 15, lev: 1.3, maint: 25
  });
  assert.deepEqual(portfolioCaps({
    ibConcentrationPct: 0,
    equityCapPct: 0,
    countryCapPct: 0,
    levCapPct: 0,
    ibMaintenancePct: 0
  }), {
    stock: 0, equity: 0, country: 0, china: 0, lev: 0, maint: 0
  });
});

test('投資風險｜同代號多筆且大小寫不同要合併，不能拆單逃過上限', () => {
  const caps = portfolioCaps({ ibConcentrationPct: 5 });
  const rows = [
    { symbol: 'TSLA', layer: 'stock', valueTwd: 3 },
    { symbol: ' tsla ', layer: 'stock', valueTwd: 3 },
    { symbol: 'TSLA', layer: 'core', valueTwd: 99 }
  ];
  const freeze = portfolioFreeze(rows, {}, 6, 100, caps);

  assert.deepEqual({ ...stockExposureBySymbol(rows) }, { TSLA: 6 });
  assert.deepEqual([...freeze.symbols], ['TSLA']);
});

test('投資風險｜中國獨立上限、其他國家零上限與股票總曝險都各自生效', () => {
  const caps = portfolioCaps({ countryCapPct: 0, chinaCapPct: 5, equityCapPct: 5 });
  const freeze = portfolioFreeze([], { 美國: 80, 其他: 10, 台灣: 1, 中國: 4 }, 6, 100, caps);

  assert.deepEqual([...freeze.regions], ['台灣']);
  assert.equal(freeze.equity, true);
});

test('投資風險｜淨資產不是正數時不產生可操作的凍結名單', () => {
  const freeze = portfolioFreeze([{ symbol: 'TSLA', layer: 'stock', valueTwd: 100 }], { 台灣: 100 }, 100, 0, portfolioCaps({}));

  assert.equal(freeze.symbols.size, 0);
  assert.equal(freeze.regions.size, 0);
  assert.equal(freeze.equity, false);
});
