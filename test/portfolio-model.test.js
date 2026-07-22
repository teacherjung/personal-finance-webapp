import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioModel } from '../public/modules/portfolio-model.js';

const holdings = [
  { symbol: 'CSPX', layer: 'core', currency: 'USD', price: 100, quantity: 2, avgCost: 80, source: 'ib' },
  { symbol: '00719B', layer: 'bond', currency: 'TWD', price: 30, quantity: 10, avgCost: 25 },
  { symbol: 'IAU', layer: 'gold', currency: 'USD', price: 50, quantity: 1, avgCost: 40 },
  { symbol: '0050', layer: 'satellite', price: 100, quantity: 2, avgCost: 90 }
];

const accounts = [
  { name: '台幣', type: 'cash', class: '現金', currency: 'TWD', balance: 1_000 },
  { name: '英鎊', type: 'cash', class: '現金', currency: 'GBP', balance: 10 },
  { name: '黃金存摺', type: 'asset', class: '黃金', currency: 'TWD', balance: 500 },
  { name: 'IB USD', type: 'cash', class: '現金', currency: 'USD', balance: -50, ibCashCur: 'USD' },
  { name: '房貸', type: 'mortgage', class: '負債', currency: 'TWD', balance: -100 }
];

test('投資模型｜持股、成本、資產分類與帳戶都維持台幣口徑', () => {
  const model = buildPortfolioModel(holdings, accounts, {
    usdTwd: 32,
    fxTwd: { GBP: 40.8, JPY: 0.22 },
    ib: {}
  });

  assert.deepEqual(model.rows.map(row => ({
    symbol: row.symbol,
    valueTwd: row.valueTwd,
    costTwd: row.costTwd,
    pnlTwd: row.pnlTwd
  })), [
    { symbol: 'CSPX', valueTwd: 6_400, costTwd: 5_120, pnlTwd: 1_280 },
    { symbol: '00719B', valueTwd: 300, costTwd: 250, pnlTwd: 50 },
    { symbol: 'IAU', valueTwd: 1_600, costTwd: 1_280, pnlTwd: 320 },
    { symbol: '0050', valueTwd: 200, costTwd: 180, pnlTwd: 20 }
  ]);
  assert.deepEqual({
    total: model.total,
    totalCost: model.totalCost,
    totalPnl: model.totalPnl,
    eqV: model.eqV,
    bondV: model.bondV,
    goldV: model.goldV,
    cashV: model.cashV,
    goldAll: model.goldAll,
    allBase: model.allBase
  }, {
    total: 8_500,
    totalCost: 6_830,
    totalPnl: 1_670,
    eqV: 6_600,
    bondV: 300,
    goldV: 1_600,
    cashV: 1_408,
    goldAll: 2_100,
    allBase: 10_408
  });
  assert.deepEqual(model.cashAccounts.map(account => [account.name, account.valueTwd]), [
    ['台幣', 1_000],
    ['英鎊', 408]
  ]);
  assert.deepEqual(model.goldAccounts.map(account => [account.name, account.valueTwd]), [
    ['黃金存摺', 500]
  ]);
  assert.deepEqual(model.regionMap, { 美國: 6_400, 台灣: 200 });
});

test('投資模型｜缺官方淨值時用 IB 持股與負現金算槓桿', () => {
  const model = buildPortfolioModel(holdings, accounts, {
    usdTwd: 32,
    fxTwd: { GBP: 40.8 },
    ib: {}
  });

  assert.equal(model.ibValTwd, 6_400);
  assert.equal(model.loanTwd, 1_600);
  assert.equal(model.netEquity, 4_800);
  assert.equal(model.leverage, 4 / 3);
});

test('投資模型｜官方摘要優先，全平倉只剩欠款仍顯示負淨值風險', () => {
  const model = buildPortfolioModel(holdings, accounts, {
    usdTwd: 32,
    fxTwd: { GBP: 40.8 },
    ib: { lastEquity: { stock: 0, cash: -20 } }
  });

  assert.equal(model.ibValTwd, 0);
  assert.equal(model.loanTwd, 640);
  assert.equal(model.netEquity, -640);
  assert.equal(model.leverage, Infinity);
});

test('投資模型｜帳戶資料暫時缺席時沿用舊頁面的空陣列退路', () => {
  const model = buildPortfolioModel([], undefined, { usdTwd: 32, ib: {} });

  assert.equal(model.total, 0);
  assert.equal(model.cashV, 0);
  assert.equal(model.goldAll, 0);
  assert.equal(model.leverage, 1);
});
