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

test('Codex S2r1#2｜secTradesSkipped 分原因回報（前端要說話，不只 console）', async () => {
  const { ibSyncFeedback } = await import('../public/modules/portfolio-ib-sync.js');
  const fb = ibSyncFeedback({ updated: 1, created: 0, secTradesSkipped: 3,
    secSkippedReasons: { missingCurrency: 1, missingCore: 1, cancelOrUnknown: 1 } }, (v, c) => `${v} ${c}`);
  const warn = fb.find(f => f.message.includes('證券交易紀錄'));
  assert.ok(warn, '要有一則證券交易跳過警告');
  assert.equal(warn.error, true);
  assert.match(warn.message, /缺幣別 1 筆.*Currency/, '指路補勾欄位');
  assert.match(warn.message, /缺核心金額 1 筆/);
  assert.match(warn.message, /取消\/未知買賣別 1 筆/);
  const clean = ibSyncFeedback({ updated: 1, created: 0 }, (v, c) => `${v} ${c}`);
  assert.ok(!clean.some(f => f.message.includes('證券交易紀錄')), '沒跳過就不出現');
});


// 「幣別不支援」與「報表沒給幣別」是兩種病（2026-07-28）：訊息分開講，使用者才修得到對的地方。
test('IBKR 同步回報｜缺幣別的新持股與現金交易各自出聲，與「幣別不支援」分開', () => {
  const feedback = ibSyncFeedback({
    updated: 0, created: 0,
    skippedCurrencies: ['EUR'],
    skippedNoCurrency: ['VWRL', 'VUAA'],
    incomeNoCurrency: 3,
  }, formatCurrency);
  const msgs = feedback.map(f => f.message);
  assert.ok(msgs.some(m => /幣別尚未支援.*EUR/.test(m)), '不支援幣別＝我們不支援那個幣別');
  assert.ok(msgs.some(m => /VWRL、VUAA/.test(m) && /Open Positions/.test(m)), '缺幣別＝報表沒給，要指路 Open Positions');
  assert.ok(msgs.some(m => /3 筆股息／利息/.test(m) && /Cash Transactions/.test(m)), '現金交易缺幣別要指路 Cash Transactions');
  assert.equal(feedback.filter(f => f.error).length, 3, '三種都是要使用者處理的，不可以標成一般訊息');
});

test('IBKR 同步回報｜沒有缺幣別時完全不提（乾淨的同步不該有雜訊）', () => {
  const feedback = ibSyncFeedback({ updated: 2, created: 1 }, formatCurrency);
  assert.equal(feedback.length, 1);
  assert.doesNotMatch(feedback[0].message, /幣別/);
});
