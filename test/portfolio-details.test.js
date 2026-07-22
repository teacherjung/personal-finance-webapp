import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetAccountDetailHtml,
  assetGoldDetailHtml,
  assetHoldingDetailHtml,
  costDetailHtml,
  tradesModalHtml
} from '../public/modules/portfolio-details.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char] || char));
const formatMoney = (value) => `${Number(value).toLocaleString('en-US')} 元`;
const formatters = { escapeHtml, formatMoney };

test('投資彈窗｜完整交易依日期新到舊，並維持買賣、數字與損益格式', () => {
  const trades = [
    { date: '20260102', symbol: 'AAPL', buySell: 'BUY', quantity: 2, price: 10, netCash: -20, pnl: 0, currency: 'USD' },
    { date: '20260304', symbol: 'CSPX', buySell: 'SELL', quantity: -1, price: 100.5, netCash: 100.5, pnl: 12.25, currency: 'USD' }
  ];

  const html = tradesModalHtml(trades, { escapeHtml });

  assert.match(html, /買 1／賣 1/);
  assert.match(html, /共 2 筆/);
  assert.ok(html.indexOf('2026-03-04') < html.indexOf('2026-01-02'));
  assert.match(html, /<span class="tag amber">賣<\/span>/);
  assert.match(html, /100\.50/);
  assert.match(html, /class="num pos">12\.25/);
  assert.deepEqual(trades.map(trade => trade.symbol), ['AAPL', 'CSPX']);
});

test('投資彈窗｜交易、標的與帳戶名稱都經消毒，不會被當成 HTML', () => {
  const tradeHtml = tradesModalHtml([
    { date: '20260101', symbol: '<script>alert(1)</script>', buySell: 'BUY', currency: '<USD>' }
  ], { escapeHtml });
  const costHtml = costDetailHtml([
    { symbol: '<img src=x onerror=alert(1)>', costTwd: 10 }
  ], 10, formatters);

  assert.doesNotMatch(tradeHtml, /<script>/);
  assert.match(tradeHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(tradeHtml, /&lt;USD&gt;/);
  assert.doesNotMatch(costHtml, /<img /);
  assert.match(costHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('投資彈窗｜成本與各資產依金額排序，合計與總資產佔比維持原口徑', () => {
  const holdings = [
    { symbol: 'SMALL', costTwd: 100, valueTwd: 200 },
    { symbol: 'LARGE', costTwd: 900, valueTwd: 600 }
  ];
  const accounts = [
    { name: '小帳戶', valueTwd: 50 },
    { name: '大帳戶', valueTwd: 150 }
  ];

  const costHtml = costDetailHtml(holdings, 1_000, formatters);
  const holdingHtml = assetHoldingDetailHtml('股票', holdings, 800, 2_000, formatters);
  const accountHtml = assetAccountDetailHtml('現金', accounts, 200, formatters);
  const goldHtml = assetGoldDetailHtml([holdings[0]], accounts, 400, 2_000, formatters);

  assert.ok(costHtml.indexOf('LARGE') < costHtml.indexOf('SMALL'));
  assert.match(costHtml, /合計：1,000 元/);
  assert.ok(holdingHtml.indexOf('LARGE') < holdingHtml.indexOf('SMALL'));
  assert.match(holdingHtml, /合計：40%/);
  assert.match(holdingHtml, /<b>LARGE<\/b>[\s\S]*600 元[\s\S]*30%/);
  assert.ok(accountHtml.indexOf('大帳戶') < accountHtml.indexOf('小帳戶'));
  assert.match(accountHtml, /合計：200 元/);
  assert.ok(goldHtml.indexOf('SMALL') < goldHtml.indexOf('大帳戶'));
  assert.match(goldHtml, /合計：20%/);
});

test('投資彈窗｜各類資產沒有資料時顯示對應空狀態', () => {
  assert.match(costDetailHtml([], 0, formatters), /目前沒有持股/);
  assert.match(assetHoldingDetailHtml('債券', [], 0, 0, formatters), /目前沒有債券部位/);
  assert.match(assetAccountDetailHtml('現金', [], 0, formatters), /目前沒有現金帳戶/);
  assert.match(assetGoldDetailHtml([], [], 0, 0, formatters), /目前沒有黃金部位/);
});
