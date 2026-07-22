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
    estimatedNoFx: 1,
    estimatedCurrencies: ['JPY']
  }, '外幣現金流依 IBKR 匯率、設定估算、缺匯率略過的順序換算');

  assert.deepEqual(parsed.trades.map(t => ({ symbol: t.symbol, pnl: t.pnl, pnlBase: t.pnlBase })), [
    { symbol: 'AAPL', pnl: 50, pnlBase: 50 },
    { symbol: 'CSPX', pnl: 20, pnlBase: 25 },
    { symbol: 'EWJ', pnl: 100, pnlBase: null }
  ], 'USD 直通、IBKR 匯率換算；非 USD 缺匯率不可冒充 USD');
});
