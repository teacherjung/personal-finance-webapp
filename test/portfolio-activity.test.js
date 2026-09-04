import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomeActivityHtml, INCOME_INFO, tradesActivityHtml } from '../public/modules/portfolio-activity.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char] || char));
const twd = { escapeHtml, viewCurrency: 'TWD', usdRate: 32 };
const usd = { escapeHtml, viewCurrency: 'USD', usdRate: 32 };

test('投資活動｜IB 現金流維持原本合計、正負號與雙計價格式', () => {
  const settings = { ib: { income: {
    dividends: 100, paymentInLieu: 20, withholdingTax: -10,
    interestPaid: -5, interestReceived: 2, from: '202507', to: '202606'
  } } };

  const twdHtml = incomeActivityHtml(settings, twd);
  const usdHtml = incomeActivityHtml(settings, usd);

  assert.match(twdHtml, /IB 現金流/);
  assert.match(twdHtml, /（2025\/07–2026\/06）/);
  assert.match(twdHtml, /股息[\s\S]*\+0\.38 萬/);
  assert.match(twdHtml, /融資利息[\s\S]*−0\.02 萬/);
  assert.match(twdHtml, /淨現金流[\s\S]*\+0\.34 萬/);
  assert.match(usdHtml, /股息[\s\S]*\+0\.12 K USD/);
  assert.match(usdHtml, /淨現金流[\s\S]*\+0\.11 K USD/);
});

test('投資活動｜IB 現金流明說估算與略過筆數，幣別經消毒', () => {
  const html = incomeActivityHtml({ ib: { income: {
    estimatedNoFx: 2, estimatedCurrencies: ['GBP', '<JPY>'], skippedNoFx: 1
  } } }, twd);

  assert.match(html, /2 筆（GBP、&lt;JPY&gt;）/);
  assert.match(html, /1 筆現金交易的幣別系統不支援/);   // 丙-2：只有不支援的幣別才會被略過
  assert.doesNotMatch(html, /<JPY>/);
  assert.equal(INCOME_INFO.pil[0], '替代股息（Payment in Lieu）');
});

// 「缺幣別」與「缺匯率」是兩種病，註記必須分開講（2026-07-28）：
// 金額總額已經排除了那些筆，**少了註記就是默默算錯**——這是本卡片最不能退讓的一條。
test('投資活動｜IB 現金流：報表沒有幣別欄的筆數要獨立出聲，並指路 Flex Query', () => {
  const html = incomeActivityHtml({ ib: { income: { skippedNoCurrency: 3 } } }, twd);
  assert.match(html, /3 筆現金交易的報表沒有幣別欄/);
  assert.match(html, /未計入上列金額/, '要說清楚「這個數字不含什麼」');
  assert.match(html, /Cash Transactions/, '要指路到 Flex Query 的哪一個區塊，使用者才修得到');
});

test('投資活動｜沒有缺幣別時不出現那行註記（不可以無條件嚇使用者）', () => {
  const html = incomeActivityHtml({ ib: { income: { dividends: 100, skippedNoCurrency: 0 } } }, twd);
  assert.doesNotMatch(html, /沒有幣別欄/);
});

test('投資活動｜交易摘要維持多幣別損益優先序、排名與匯率說明', () => {
  const trades = [
    { symbol: 'AAPL', pnl: 200, currency: 'USD' },
    { symbol: 'AAPL', pnl: -50, currency: 'USD' },
    { symbol: 'CSPX', pnl: 100, currency: 'GBP', fxRateToBase: 1.2 },
    { symbol: 'JPLOSS', pnl: -32_000, currency: 'JPY' },
    { symbol: 'MISS', pnl: -80, currency: 'EUR' }
  ];
  const settings = { usdTwd: 32, fxTwd: { JPY: 0.2 }, ib: { income: { from: '202501', to: '202512' } } };
  const html = tradesActivityHtml(trades, settings, usd);

  assert.match(html, /已實現損益（FIFO）/);
  assert.match(html, /\+0\.1 K USD/); // 150 + 120 - 200 = 70 USD
  assert.ok(html.indexOf('AAPL') < html.indexOf('CSPX'));
  assert.match(html, /JPLOSS[\s\S]*−0\.2 K USD/);
  assert.match(html, /換算匯率來自 IBKR/);
  assert.match(html, /提醒：JPY 舊交易缺少 IBKR 匯率欄位/);
  assert.match(html, /提醒：EUR 是系統不支援的幣別/);   // 丙-2
});

test('投資活動｜無資料不渲染卡片，交易代號與幣別不會成為 HTML', () => {
  assert.equal(incomeActivityHtml({ ib: {} }, twd), '');
  assert.equal(tradesActivityHtml([], { ib: {} }, twd), '');

  const html = tradesActivityHtml([
    { symbol: '<img src=x onerror=alert(1)>', pnl: 10, currency: 'USD' },
    { symbol: 'MISS', pnl: 10, currency: '<GBP>' }
  ], { ib: {} }, twd);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;GBP&gt;/);
});

test('丙-2｜交易摘要註記：預設匯率估的幣別單獨一行（講「先用預設匯率估算」、不可講「未計入」），不支援的幣別另一行', () => {
  const html = tradesActivityHtml([
    { symbol: 'B', pnl: 32, currency: 'GBP', date: '20250101' },
    { symbol: 'D', pnl: 500, currency: 'EUR', date: '20250101' },
  ], { usdTwd: 32 }, { escapeHtml: (v) => String(v), viewCurrency: 'USD', usdRate: 32 });
  assert.match(html, /GBP 交易缺少 IBKR 匯率、也還沒抓到匯率，先用預設匯率估算/);
  assert.match(html, /EUR 是系統不支援的幣別/);
  assert.doesNotMatch(html, /GBP[^<]*未計入/, '預設估的 GBP 是計入的');
});

test('丙-2｜台幣計價時，美元匯率是預設值 → IB 現金流與交易摘要都要標「台幣換算用的美元匯率是預設值」；抓到的不標；USD 計價不標', () => {
  const income = { ib: { income: { dividends: 100, count: 1 } } };
  const dflt = { escapeHtml, viewCurrency: 'TWD', usdRate: 32, usdRateSource: /** @type {'default'} */ ('default') };
  assert.match(incomeActivityHtml(income, dflt), /台幣換算用的美元匯率是預設值 32/);
  assert.match(tradesActivityHtml([{ symbol: 'A', pnl: 100, currency: 'USD', date: '20250101' }], { usdTwd: 32 }, dflt), /台幣換算用的美元匯率是預設值 32/);
  const live = { ...dflt, usdRateSource: /** @type {'live'} */ ('live') };
  assert.doesNotMatch(incomeActivityHtml(income, live), /預設值/);
  const usdView = { ...dflt, viewCurrency: 'USD' };
  assert.doesNotMatch(incomeActivityHtml(income, usdView), /預設值/, 'USD 計價不經台幣換算、不標');
});
