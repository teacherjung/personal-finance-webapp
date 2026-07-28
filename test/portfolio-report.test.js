import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioReport } from '../public/modules/portfolio-report.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char] || char));

const layers = {
  core: { label: '核心（美股）', min: 45, max: 65 },
  satellite: { label: '衛星', min: 8, max: 20 },
  stock: { label: '個股', min: 0, max: 20 },
  bond: { label: '債券', min: 15, max: 30 },
  gold: { label: '黃金', min: 0, max: 10 }
};
const layerOrder = ['core', 'satellite', 'stock', 'bond', 'gold'];

const baseData = {
  rows: [{ symbol: '<TSLA>', name: '成長 & 科技', layer: 'stock', currency: 'USD', quantity: 1, avgCost: 80, price: 100, valueTwd: 3_200, costTwd: 2_560, pnlTwd: 640 }],
  accounts: [{ name: '台幣', type: 'cash', currency: 'TWD', balance: 1_000 }],
  fx: { USD: 32, TWD: 1 },
  settings: { fxLow: 28, fxHigh: 32, ib: {} },
  ibTrades: [],
  total: 3_200,
  totalCost: 2_560,
  totalPnl: 640,
  layerV: { stock: 3_200 },
  regionMap: { 美國: 3_200 },
  eqV: 3_200,
  bondV: 0,
  goldAll: 0,
  loanTwd: 0,
  netEquity: 3_200,
  leverage: 1,
  capeInfo: { value: 30, percentile: 92, label: '偏高' }
};

test('投資報表｜台幣口徑、分層狀態與 CAPE 維持原本內容', () => {
  const report = buildPortfolioReport(baseData, {
    viewCurrency: 'TWD', generated: '2026-07-22', sortKey: 'value', sortDir: 'desc', layers, layerOrder, escapeHtml
  });

  assert.equal(report.title, '投資組合報表 2026-07-22');
  assert.match(report.html, /總市值<\/span><b>0\.3 萬/);
  assert.match(report.html, /個股<\/td><td class="num">3,200 元<\/td><td class="num">100\.0%/);
  assert.match(report.html, /Shiller PE（CAPE）：<b>30\.00<\/b>（歷史分位 ~92%，偏高）/);
});

test('投資報表｜所有持股文字都經共用消毒器，不可把標的名稱當 HTML', () => {
  const report = buildPortfolioReport(baseData, {
    viewCurrency: 'TWD', generated: '2026-07-22', sortKey: 'value', sortDir: 'desc', layers, layerOrder, escapeHtml
  });

  assert.doesNotMatch(report.html, /<TSLA>/);
  assert.match(report.html, /&lt;TSLA&gt;/);
  assert.match(report.html, /成長 &amp; 科技/);
});

test('投資報表｜美元計價、IB 現金流與交易摘要使用同一換算口徑', () => {
  const data = {
    ...baseData,
    settings: {
      fxLow: 28,
      fxHigh: 35,
      ib: { income: { from: '202601', to: '202606', dividends: 10, paymentInLieu: 2, withholdingTax: -1, interestPaid: -3, interestReceived: 1, skippedNoCurrency: 2 } }
    },
    ibTrades: [{ symbol: 'AAPL', buySell: 'SELL', pnl: 5, currency: 'USD' }]
  };
  const report = buildPortfolioReport(data, {
    viewCurrency: 'USD', generated: '2026-07-22', sortKey: 'toString', sortDir: 'desc', layers, layerOrder, escapeHtml
  });

  assert.match(report.html, /總市值<\/span><b>0\.1 K USD/);
  assert.match(report.html, /IBKR 現金流 <span>2026\/01–2026\/06/);
  assert.match(report.html, /交易摘要 <span>共 1 筆（買 0／賣 1）/);
  assert.match(report.html, /AAPL \+5 USD/);
});


// A4 報表與活動卡是**同一份數字的兩個出口**，註記口徑要一致（2026-07-28）：
// 列印出來的報表少了註記，讀的人完全沒有機會發現總額不完整。
test('A4 報表｜報表沒有幣別欄的筆數要跟活動卡一樣出聲', () => {
  const data = {
    ...baseData,
    settings: { fxLow: 28, fxHigh: 35, ib: { income: { from: '202601', to: '202606', dividends: 10, skippedNoCurrency: 2 } } },
    ibTrades: [],
  };
  const report = buildPortfolioReport(data, {
    viewCurrency: 'USD', generated: '2026-07-22', sortKey: 'toString', sortDir: 'desc', layers, layerOrder, escapeHtml
  });
  assert.match(report.html, /2 筆現金交易的報表沒有幣別欄/);
  assert.match(report.html, /未計入上列金額/);

  const clean = buildPortfolioReport({
    ...baseData,
    settings: { fxLow: 28, fxHigh: 35, ib: { income: { from: '202601', to: '202606', dividends: 10 } } },
    ibTrades: [],
  }, { viewCurrency: 'USD', generated: '2026-07-22', sortKey: 'toString', sortDir: 'desc', layers, layerOrder, escapeHtml });
  assert.doesNotMatch(clean.html, /沒有幣別欄/, '沒有缺漏就不該出現註記');
});
