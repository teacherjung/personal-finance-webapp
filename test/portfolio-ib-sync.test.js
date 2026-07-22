import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ibSyncFeedback } from '../public/modules/portfolio-ib-sync.js';

const formatCurrency = (value, currency) => `${currency} ${value}`;

test('IBKR 同步回報｜沒有現金時只顯示更新與新增檔數', () => {
  assert.deepEqual(ibSyncFeedback({ updated: 2, created: 1 }, formatCurrency), [
    { message: 'IBKR 同步完成：更新 2 檔、新增 1 檔', error: false }
  ]);
});

test('IBKR 同步回報｜多幣別現金依後端順序交給共用格式器', () => {
  const calls = [];
  const feedback = ibSyncFeedback({ updated: 3, created: 0, cash: { USD: 120.5, JPY: 8000 } }, (value, currency) => {
    calls.push([value, currency]);
    return `${value} ${currency}`;
  });
  assert.deepEqual(calls, [[120.5, 'USD'], [8000, 'JPY']]);
  assert.equal(feedback[0].message, 'IBKR 同步完成：更新 3 檔、新增 0 檔；現金 120.5 USD、8000 JPY');
});

test('IBKR 同步回報｜未支援幣別與缺現金資料依原順序標成警告', () => {
  const feedback = ibSyncFeedback({
    updated: 0,
    created: 0,
    skippedCurrencies: ['EUR', 'AUD'],
    cashReportMissing: true,
    cashDetailMissing: true
  }, formatCurrency);
  assert.deepEqual(feedback.slice(1).map(item => item.error), [true, true, true]);
  assert.match(feedback[1].message, /EUR、AUD/);
  assert.match(feedback[2].message, /沒有 Cash Report/);
  assert.match(feedback[3].message, /Account Information/);
});

test('IBKR 同步回報｜彙總現金說明只在有折疊帳戶時附上數量', () => {
  const collapsed = ibSyncFeedback({ updated: 0, created: 0, cashFromSummary: true, cashCollapsed: 2 }, formatCurrency);
  const plain = ibSyncFeedback({ updated: 0, created: 0, cashFromSummary: true, cashCollapsed: 0 }, formatCurrency);
  assert.equal(collapsed[1].message, '說明：這份報表的現金只有彙總列——已用基準幣別總額入帳（2 個其他幣別帳戶已併入彙總顯示）。');
  assert.equal(collapsed[1].error, false);
  assert.equal(plain[1].message, '說明：這份報表的現金只有彙總列——已用基準幣別總額入帳。');
});

test('IBKR 同步回報｜其餘三種舊值警告排在歸零提醒之前', () => {
  const feedback = ibSyncFeedback({
    updated: 0,
    created: 0,
    cashBaseUnsupported: 'EUR',
    cashDetailIncomplete: true,
    cashSummaryMissing: true,
    cashZeroed: 2
  }, formatCurrency);
  assert.deepEqual(feedback.slice(1).map(item => item.error), [true, true, true, false]);
  assert.match(feedback[1].message, /EUR 尚未支援/);
  assert.match(feedback[2].message, /部分幣別/);
  assert.match(feedback[3].message, /彙總列沒有可用金額/);
  assert.match(feedback[4].message, /2 個 IB 現金帳戶/);
});
