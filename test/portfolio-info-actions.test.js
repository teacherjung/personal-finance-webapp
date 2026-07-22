import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolioInfoActions } from '../public/modules/portfolio-info-actions.js';

const escapeHtml = value => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

test('投資說明互動｜所有入口各開正確標題、尺寸與已算好的內容', () => {
  const elements = new Map();
  const ids = [
    'tradesFull', 'totalValueInfo', 'totalCostInfo', 'assetStockInfo', 'assetBondInfo',
    'assetCashInfo', 'assetGoldInfo', 'xirrInfo', 'disciplineInfo'
  ];
  for (const id of ids) elements.set(id, { onclick: null });
  const incomeButton = { dataset: { info: 'pil' }, onclick: null };
  const opened = [];
  const actions = createPortfolioInfoActions({
    getElement: id => elements.get(id) || null,
    getAll: selector => selector === '.info-link[data-info]' ? [incomeButton] : [],
    openInfo: (title, html, options) => opened.push({ title, html, options }),
    escapeHtml,
    formatMoney: value => `${value} 元`
  });
  actions.bind({
    ibTrades: [{ date: '20260101', symbol: '<AAPL>', buySell: 'BUY' }],
    total: 100, equityValue: 60, bondValue: 30, goldValue: 10,
    rows: [{ symbol: 'AAPL', costTwd: 50, valueTwd: 60 }], totalCost: 50,
    stockRows: [{ symbol: 'AAPL', valueTwd: 60 }], allBase: 120,
    bondRows: [{ symbol: 'BOND', valueTwd: 30 }],
    cashAccounts: [{ name: '現金帳戶', valueTwd: 20 }], cashValue: 20,
    goldRows: [{ symbol: 'GOLD', valueTwd: 5 }],
    goldAccounts: [{ name: '黃金存摺', valueTwd: 5 }], goldAll: 10,
    caps: { stock: 5, equity: 90, country: 15, china: 15, lev: 1.3, maint: 25 }
  });

  incomeButton.onclick();
  for (const id of ids) elements.get(id).onclick();

  assert.deepEqual(opened.map(item => item.title), [
    '替代股息（Payment in Lieu）', '完整交易明細', '總市值', '成本',
    '股票', '債券', '現金', '黃金', '年化報酬（XIRR）', '紀律檢查'
  ]);
  assert.deepEqual(opened.slice(1, 9).map(item => item.options?.size), ['xl', 'md', 'sm', 'sm', 'sm', 'sm', 'sm', 'md']);
  assert.match(opened[1].html, /&lt;AAPL&gt;/);
  assert.match(opened[2].html, /100 元 ＝ 股票 60 元 \+ 債券 30 元 \+ 黃金 10 元/);
  assert.match(opened[9].html, /在所有環境都活著/);
});

test('投資說明互動｜頁面缺少可選按鈕時安全略過', () => {
  const actions = createPortfolioInfoActions({
    getElement: () => null,
    getAll: () => [],
    openInfo: () => assert.fail('不應開窗'),
    escapeHtml,
    formatMoney: value => `${value} 元`
  });
  assert.doesNotThrow(() => actions.bind({}));
});
