import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatement } from '../lib/ib.js';

test('IB Flex 解析：持倉、現金流與多幣別成交損益維持同一口徑', () => {
  const parsed = parseStatement({
    FlexQueryResponse: {
      FlexStatements: {
        FlexStatement: {
          accountId: 'U-SYNTHETIC',
          fromDate: '20260101',
          toDate: '20261231',
          AccountInformation: { currency: 'USD' },
          OpenPositions: {
            OpenPosition: [
              { symbol: 'CSPX', description: 'Synthetic ETF', currency: 'USD', position: '2', costBasisMoney: '1000', markPrice: '600' },
              { symbol: 'ZERO', currency: 'USD', position: '0', costBasisPrice: '99', markPrice: '100' }
            ]
          },
          CashReport: {
            CashReportCurrency: [
              { currency: 'USD', endingSettledCash: '123.45' },
              { currency: 'BASE_SUMMARY', endingCash: '456.78' }
            ]
          },
          EquitySummaryInBase: {
            EquitySummaryByReportDateInBase: [
              { reportDate: '20260101', cash: '100', stock: '1000' },
              { reportDate: '20261231', cash: '-200', stock: '1500' }
            ]
          },
          CashTransactions: {
            CashTransaction: [
              { type: 'Dividends', currency: 'USD', amount: '10' },
              { type: 'Payment In Lieu Of Dividends', currency: 'GBP', amount: '8', fxRateToBase: '1.25' },
              { type: 'Withholding Tax', currency: 'JPY', amount: '-1000' },
              { type: 'Broker Interest Paid', currency: 'EUR', amount: '-5' },
              { type: 'Broker Interest Received', currency: 'USD', amount: '2' },
              { type: 'Other Fees', currency: 'USD', amount: '-3' }
            ]
          },
          Trades: {
            Trade: [
              { symbol: 'AAPL', tradeDate: '20260701', buySell: 'SELL', quantity: '-1', tradePrice: '200', netCash: '200', fifoPnlRealized: '50', currency: 'USD' },
              { symbol: 'CSPX', tradeDate: '20260702', buySell: 'SELL', quantity: '-2', tradePrice: '600', netCash: '1200', fifoPnlRealized: '20', currency: 'GBP', fxRateToBase: '1.25' },
              { symbol: 'EWJ', tradeDate: '20260703', buySell: 'SELL', quantity: '-3', tradePrice: '80', netCash: '240', fifoPnlRealized: '100', currency: 'JPY' }
            ]
          }
        }
      }
    }
  }, (currency) => currency === 'JPY' ? 0.007 : null);

  assert.equal(parsed.account, 'U-SYNTHETIC');
  assert.equal(parsed.accountCount, 1);
  assert.deepEqual(parsed.period, { from: '20260101', to: '20261231' });
  assert.deepEqual(parsed.positions, [{
    symbol: 'CSPX', description: 'Synthetic ETF', currency: 'USD', quantity: 2, avgCost: 500, marketPrice: 600
  }], '零股數列不應成為持倉；缺均價時以總成本除股數');
  assert.deepEqual(parsed.cashByCurrency, { USD: 123.45 });
  assert.equal(parsed.baseSummaryCash, 456.78);
  assert.deepEqual(parsed.equity, { cash: -200, stock: 1500, date: '20261231' }, '淨值摘要採報表最後一日');

  assert.deepEqual(parsed.income, {
    dividends: 10,
    paymentInLieu: 10,
    withholdingTax: -7,
    interestPaid: 0,
    interestReceived: 2,
    other: -3,
    count: 5,
    skippedNoFx: 1,
    skippedNoCurrency: 0,
    estimatedNoFx: 1,
    estimatedCurrencies: ['JPY']
  }, '外幣現金流依 IBKR 匯率、設定估算、缺匯率略過的順序換算');

  assert.deepEqual(parsed.trades.map(t => ({ symbol: t.symbol, pnl: t.pnl, pnlBase: t.pnlBase })), [
    { symbol: 'AAPL', pnl: 50, pnlBase: 50 },
    { symbol: 'CSPX', pnl: 20, pnlBase: 25 },
    { symbol: 'EWJ', pnl: 100, pnlBase: null }
  ], 'USD 直通、IBKR 匯率換算；非 USD 缺匯率不可冒充 USD');
});

// ---- 缺幣別不冒充 USD（2026-07-28 修；Codex gpt-5.6-sol 重審發現）----
// `securityTrades` 早就做到「缺 Currency 不猜 USD」，但持股／現金流／ibTrades 三條舊路沒跟上：
// Flex Query 少勾一個 Currency 欄，GBP 100 的股息就被當成 USD 100 加總（少算 27%），
// 而且 skippedNoFx 是 0＝畫面一個字都不會提。這正是專案自己禁止的「默默算錯」。
test('IB 解析｜現金交易缺幣別：有 fxRateToBase 照算；連匯率也沒有＝跳過並計入 skippedNoCurrency', () => {
  const parsed = parseStatement({
    FlexQueryResponse: { FlexStatements: { FlexStatement: {
      accountId: 'U-SYNTH',
      CashTransactions: { CashTransaction: [
        { type: 'Dividends', amount: '100', fxRateToBase: '1.27' },   // 缺幣別但有匯率 → 照算（換算正確）
        { type: 'Dividends', amount: '100' },                          // 缺幣別又缺匯率 → 不猜
        { type: 'Broker Interest Received', currency: 'USD', amount: '5' },
      ] },
    } } },
  }, () => null);
  assert.equal(parsed.income.dividends, 127, '有 fxRateToBase 就照算——那條路與幣別無關');
  assert.equal(parsed.income.skippedNoCurrency, 1, '缺幣別又缺匯率＝跳過，不可以當成 USD 100 加總');
  assert.equal(parsed.income.skippedNoFx, 0, '這是「缺幣別」不是「缺匯率」，兩種病要分開計數才修得對地方');
  assert.equal(parsed.income.interestReceived, 5, '正常的列不受影響');
});

test('IB 解析｜成交紀錄缺幣別：currency 留空、pnlBase 為 null（不當 USD 直通進 XIRR）', () => {
  const parsed = parseStatement({
    FlexQueryResponse: { FlexStatements: { FlexStatement: {
      accountId: 'U-SYNTH',
      Trades: { Trade: [
        { symbol: 'VWRL', tradeDate: '20260701', buySell: 'SELL', quantity: '-1', fifoPnlRealized: '20' },
        { symbol: 'VUAA', tradeDate: '20260702', buySell: 'SELL', quantity: '-1', fifoPnlRealized: '30', fxRateToBase: '1.27' },
      ] },
    } } },
  }, () => null);
  assert.equal(parsed.trades[0].currency, '', '不知道就說不知道');
  assert.equal(parsed.trades[0].pnlBase, null, '缺幣別又缺匯率＝算不出基準損益，不可以拿原值冒充');
  assert.equal(parsed.trades[1].pnlBase, 38.1, '有匯率照算（30 × 1.27）');
});

test('IB 解析｜持股缺幣別在 parse 層就是空字串（USD 預設只發生在同步寫入，已一併修掉）', () => {
  const parsed = parseStatement({
    FlexQueryResponse: { FlexStatements: { FlexStatement: {
      accountId: 'U-SYNTH',
      OpenPositions: { OpenPosition: { symbol: 'VWRL', position: '10', costBasisPrice: '80', markPrice: '100' } },
    } } },
  }, () => null);
  assert.equal(parsed.positions[0].currency, '');
});
