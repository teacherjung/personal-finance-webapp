import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fxTable,
  holdingCost,
  marginCallDistance,
  tradePnlBase,
  tradeSummary,
  xirrRate
} from '../public/modules/portfolio-calculations.js';

test('投資計算｜匯率表保留設定值與既有預設值', () => {
  assert.deepEqual(fxTable({ usdTwd: 31.5, fxTwd: { GBP: 42 } }), {
    TWD: 1,
    USD: 31.5,
    GBP: 42,
    JPY: 0.215
  });
});

test('投資計算｜持股成本優先用均價乘股數，舊資料退回總成本', () => {
  assert.equal(holdingCost({ avgCost: 25, quantity: 8, cost: 999 }), 200);
  assert.equal(holdingCost({ avgCost: '', quantity: 8, cost: 999 }), 999);
});

test('投資計算｜斷頭距離維持既有公式與無融資退路', () => {
  assert.equal(marginCallDistance(1_000_000, 400_000, 25), 46.666666666666664);
  assert.equal(marginCallDistance(1_000_000, 800_000, 25), 0);
  assert.equal(marginCallDistance(1_000_000, 0, 25), null);
});

test('投資計算｜交易損益換匯依 pnlBase、IBKR 匯率、USD、設定匯率排序', () => {
  const settings = { usdTwd: 32, fxTwd: { GBP: 40 } };
  assert.deepEqual(tradePnlBase({ pnl: 100, pnlBase: 130, currency: 'GBP' }, settings), { base: 130, source: 'ibkr', cur: 'GBP' });
  assert.deepEqual(tradePnlBase({ pnl: 100, fxRateToBase: 1.2, currency: 'GBP' }, settings), { base: 120, source: 'ibkr', cur: 'GBP' });
  assert.deepEqual(tradePnlBase({ pnl: 100, currency: 'USD' }, settings), { base: 100, source: 'usd', cur: 'USD' });
  assert.deepEqual(tradePnlBase({ pnl: 100, currency: 'GBP' }, settings), { base: 125, source: 'estimated', cur: 'GBP' });
  assert.deepEqual(tradePnlBase({ pnl: 100, currency: 'EUR' }, settings), { base: 0, source: 'missing', cur: 'EUR' });
});

test('投資計算｜交易摘要合計、排行、匯率來源與原型鍵代號', () => {
  const summary = tradeSummary([
    { symbol: 'AAPL', pnl: 100, currency: 'USD' },
    { symbol: 'AAPL', pnl: -20, currency: 'USD' },
    { symbol: '__proto__', pnl: 30, currency: 'USD' },
    { symbol: 'BARC', pnl: 40, currency: 'GBP', fxRateToBase: 1.25 },
    { symbol: 'EWJ', pnl: -1_000, currency: 'JPY' },
    { symbol: 'SAP', pnl: 500, currency: 'EUR' }
  ], { usdTwd: 32, fxTwd: { JPY: 0.224 } });

  assert.equal(summary.realized, 153);
  assert.deepEqual(summary.winners, [['AAPL', 80], ['BARC', 50], ['__proto__', 30]]);
  assert.deepEqual(summary.losers, [['EWJ', -7]]);
  assert.deepEqual(summary.ibkrCurrencies, ['GBP']);
  assert.deepEqual(summary.estimatedCurrencies, ['JPY']);
  assert.deepEqual(summary.missingCurrencies, ['EUR']);
});

test('投資計算｜XIRR 一年投入 100、收回 110 約為 10%', () => {
  const rate = xirrRate([
    { t: new Date(2025, 0, 1), v: -100 },
    { t: new Date(2026, 0, 1), v: 110 }
  ]);
  assert.ok(rate != null);
  assert.ok(Math.abs(rate - 0.100071811) < 1e-6);
});

test('投資計算｜XIRR 沒有正負現金流交會時回傳 null', () => {
  assert.equal(xirrRate([
    { t: new Date(2025, 0, 1), v: -100 },
    { t: new Date(2026, 0, 1), v: -10 }
  ]), null);
});
