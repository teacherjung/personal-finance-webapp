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

test('投資計算｜匯率表保留設定值；沒抓到的幣別填預設值（丙）、非正數也當沒抓到', () => {
  assert.deepEqual(fxTable({ usdTwd: 31.5, fxTwd: { GBP: 42 } }), { TWD: 1, USD: 31.5, GBP: 42, JPY: 0.2 });
  assert.equal(fxTable({ fxTwd: { GBP: 0, JPY: -1 } }).GBP, 41, '0 不是匯率 → 預設值');
  assert.equal(fxTable({ fxTwd: { GBP: 0, JPY: -1 } }).JPY, 0.2, '負數不是匯率 → 預設值');
  assert.equal(fxTable({}).USD, 31, '美元同一條規則');
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
  ], parseLocalDateForTest, { usdTwd: 32, fxTwd: { GBP: 40 } }, new Date(2026, 0, 15));

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(Math.abs(result.rate - 38.28155492633271) < 1e-9);
  assert.ok(Math.abs(result.years - 0.9555099247091033) < 1e-12);
  assert.equal(result.estimated, true);
});

test('投資計算｜組合 XIRR 缺快照或未滿兩個月時不顯示', () => {
  assert.deepEqual(
    portfolioXirr([], 0, 100, [], parseLocalDateForTest, {}, new Date(2026, 0, 15)),
    { ok: false, why: '需先記錄月快照' }
  );
  assert.deepEqual(
    portfolioXirr([{ month: '2026-01', value: 100, cost: 100 }], 100, 110, [], parseLocalDateForTest, {}, new Date(2026, 1, 15)),
    { ok: false, why: '快照未滿兩個月' }
  );
});

test('投資計算｜組合 XIRR 超過正負 500% 時拒絕誤導數字', () => {
  assert.deepEqual(
    portfolioXirr([{ month: '2025-01', value: 100, cost: 100 }], 100, 1_000, [], parseLocalDateForTest, {}, new Date(2026, 0, 31)),
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

// 丙-2（William 2026-09-04 裁）：交易損益／XIRR 的估算也用預設匯率並標註；只有不支援的幣別才 missing。
test('丙-2｜tradePnlBase：GBP 沒抓到匯率 → 用預設 41 估（÷美元 32）、source=default；美元沒設也算 default；EUR 不支援才 missing', () => {
  assert.deepEqual(tradePnlBase({ pnl: 100, currency: 'GBP' }, { usdTwd: 32 }), { base: 100 * 41 / 32, source: 'default', cur: 'GBP' });
  assert.deepEqual(tradePnlBase({ pnl: 100, currency: 'GBP' }, { fxTwd: { GBP: 40 } }), { base: 100 * 40 / 31, source: 'default', cur: 'GBP' }, '分母美元是預設值 31 ⇒ 整筆算預設估算');
  assert.deepEqual(tradePnlBase({ pnl: 100, currency: 'GBP' }, { usdTwd: 32, fxTwd: { GBP: 40 } }), { base: 125, source: 'estimated', cur: 'GBP' }, '對照：兩邊都抓到＝設定估算');
  assert.deepEqual(tradePnlBase({ pnl: 3100, currency: 'TWD' }, {}), { base: 100, source: 'default', cur: 'TWD' }, '台幣交易只靠美元匯率；沒抓到＝預設 31');
  assert.deepEqual(tradePnlBase({ pnl: 100, currency: 'EUR' }, {}), { base: 0, source: 'missing', cur: 'EUR' }, '不支援的幣別才是 missing');
  assert.deepEqual(tradePnlBase({ pnl: 100, currency: '' }, {}), { base: 0, source: 'missing', cur: '' }, '缺幣別不可被當成台幣（fxFor 的預設台幣判準是帳戶／持股的，交易不可借用）');
});

test('丙-2｜tradeSummary：預設匯率估的幣別列在 defaultCurrencies（計入合計），與 estimated／missing 分開', () => {
  const summary = tradeSummary([
    { symbol: 'A', pnl: 100, currency: 'USD' },
    { symbol: 'B', pnl: 32, currency: 'GBP' },          // 沒抓到 GBP ⇒ 預設 41/32
    { symbol: 'C', pnl: -1000, currency: 'JPY' },       // 設了 JPY ⇒ estimated
    { symbol: 'D', pnl: 500, currency: 'EUR' },         // 不支援 ⇒ missing
  ], { usdTwd: 32, fxTwd: { JPY: 0.224 } });
  assert.ok(Math.abs(summary.realized - (100 + 32 * 41 / 32 - 7)) < 1e-9, '預設匯率估的要計入合計');
  assert.deepEqual(summary.defaultCurrencies, ['GBP']);
  assert.deepEqual(summary.estimatedCurrencies, ['JPY']);
  assert.deepEqual(summary.missingCurrencies, ['EUR']);
});

test('丙-2｜XIRR：預設匯率估的賣出損益要計入現金流、且 estimated 旗標為 true', () => {
  // 乘數＝settings 解出的美元匯率（沒設＝預設 31）；金額大小要合理，否則 XIRR 會判「資料異常」
  const snaps = [{ month: '2025-01', value: 100, cost: 100 }, { month: '2025-06', value: 105, cost: 100 }];
  const r = portfolioXirr(snaps, 100, 110, [
    { buySell: 'SELL', pnl: 0.1, currency: 'GBP', date: '2025-11-01' },   // 沒抓到 GBP ⇒ 預設 41/32 估 ⇒ ×32＝4.1 台幣
  ], parseLocalDateForTest, { usdTwd: 32 }, new Date(2026, 0, 15));
  assert.equal(r.ok, true, `XIRR 要算得出來（${JSON.stringify(r)}）`); assert.ok(r.ok && r.estimated === true, '預設匯率估算也要標 estimated');
  const none = portfolioXirr(snaps, 100, 110, [
    { buySell: 'SELL', pnl: 0.1, currency: 'EUR', date: '2025-11-01' },
  ], parseLocalDateForTest, { usdTwd: 32 }, new Date(2026, 0, 15));
  assert.ok(none.ok && none.estimated === false, '不支援的幣別跳過、不算估算');
  assert.ok(r.ok && none.ok && r.rate !== none.rate, '對照：預設估的那筆真的進了現金流（兩個年化不同）');
});

test('丙-2｜XIRR 的「含估算」旗標與乘數同一張表：美元匯率是預設值時連 USD 賣出也算估算；沒進現金流的交易不點亮；美元抓到時不算；乘數來自 settings 不是參數', () => {
  const snaps = [{ month: '2025-01', value: 100, cost: 100 }, { month: '2025-06', value: 105, cost: 100 }];
  const usdSell = [{ buySell: 'SELL', pnl: 0.1, currency: 'USD', date: '2025-11-01' }];   // 0.1 USD × 匯率 ⇒ 幾塊台幣
  const dflt = portfolioXirr(snaps, 100, 110, usdSell, parseLocalDateForTest, {}, new Date(2026, 0, 15));
  assert.ok(dflt.ok && dflt.estimated === true, '美元匯率沒抓到＝每筆現金流都乘預設值 ⇒ 要標估算（Codex #557 r1 漏標）');
  const early = portfolioXirr(snaps, 100, 110, [{ buySell: 'SELL', pnl: 0.1, currency: 'GBP', date: '2024-06-01' }], parseLocalDateForTest, { usdTwd: 32 }, new Date(2026, 0, 15));
  assert.ok(early.ok && early.estimated === false, '早於首筆快照、沒進現金流的交易不可點亮旗標（r1 誤標）');
  const live = portfolioXirr(snaps, 100, 110, usdSell, parseLocalDateForTest, { usdTwd: 31 }, new Date(2026, 0, 15));
  assert.ok(live.ok && live.estimated === false, '對照：美元抓到了、USD 賣出不是估算');
  assert.ok(dflt.ok && live.ok && Math.abs(dflt.rate - live.rate) < 1e-12, '預設 31 與抓到 31 的年化相同——只有旗標不同（值與來源同一張表）');
  const half = portfolioXirr(snaps, 100, 110, usdSell, parseLocalDateForTest, { usdTwd: 16 }, new Date(2026, 0, 15));
  assert.ok(half.ok && live.ok && half.rate !== live.rate, '乘數必須來自 settings（Codex r2：以前是另傳的參數，值與來源可分離）');
});

// USD 的垃圾值（0／字串）也走「沒抓到→預設值」；三種預設值一次釘住（改常數要連這裡一起改）
test('fxTable：USD 給 0／字串垃圾也當「沒抓到」→ 預設值；三種幣別的預設值一次釘住', () => {
  assert.equal(fxTable({ usdTwd: 0 }).USD, 31, 'USD 0 不是匯率');
  assert.equal(fxTable({ usdTwd: 'abc' }).USD, 31, 'USD 垃圾字串不是匯率');
  assert.deepEqual(fxTable({}), { TWD: 1, USD: 31, GBP: 41, JPY: 0.2 });
});
