import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fxTable,
  holdingCost,
  marginCallDistance,
  tradePnlBase,
  tradeSummary,
  portfolioXirr,
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

const parseLocalDateForTest = (value) => {
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(y, m - 1, d);
};

test('投資計算｜組合 XIRR 依快照投入、賣出損益與今日市值計算', () => {
  const result = portfolioXirr([
    { month: '2025-01', value: 100_000, cost: 100_000 },
    { month: '2025-07', value: 130_000, cost: 150_000 }
  ], 180_000, 220_000, [
    { buySell: 'SELL', pnl: 100, currency: 'GBP', date: '20251015' },
    { buySell: 'SELL', pnl: 999, currency: 'EUR', date: '2025-11-01' },
    { buySell: 'BUY', pnl: 999, currency: 'USD', date: '2025-11-01' }
  ], 32, parseLocalDateForTest, { usdTwd: 32, fxTwd: { GBP: 40 } }, new Date(2026, 0, 15));

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(Math.abs(result.rate - 38.28155492633271) < 1e-9);
  assert.ok(Math.abs(result.years - 0.9555099247091033) < 1e-12);
  assert.equal(result.estimated, true);
});

test('投資計算｜組合 XIRR 缺快照或未滿兩個月時不顯示', () => {
  assert.deepEqual(
    portfolioXirr([], 0, 100, [], 32, parseLocalDateForTest, {}, new Date(2026, 0, 15)),
    { ok: false, why: '需先記錄月快照' }
  );
  assert.deepEqual(
    portfolioXirr([{ month: '2026-01', value: 100, cost: 100 }], 100, 110, [], 32, parseLocalDateForTest, {}, new Date(2026, 1, 15)),
    { ok: false, why: '快照未滿兩個月' }
  );
});

test('投資計算｜組合 XIRR 超過正負 500% 時拒絕誤導數字', () => {
  assert.deepEqual(
    portfolioXirr([{ month: '2025-01', value: 100, cost: 100 }], 100, 1_000, [], 32, parseLocalDateForTest, {}, new Date(2026, 0, 31)),
    { ok: false, why: '資料異常（檢查快照是否為真實紀錄）' }
  );
});


// 缺幣別時 cur 是空字串——直接放進 missingCurrencies 畫面會出現一個空白的頓號
// （提示亮了卻沒說是什麼）。2026-07-28 改成顯示「未知幣別」。
test('交易摘要｜完全沒有幣別的交易列成「未知幣別」，不是空白', () => {
  const summary = tradeSummary([
    { symbol: 'AAPL', pnl: 100, currency: 'USD' },
    { symbol: 'NOCUR', pnl: 50 },                    // 報表沒給幣別
  ], { usdTwd: 32 });
  assert.deepEqual(summary.missingCurrencies, ['未知幣別']);
  assert.ok(!summary.missingCurrencies.includes(''), '空字串會讓畫面出現孤零零的頓號');
});
