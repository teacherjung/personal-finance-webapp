import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStockResearchPage,
  revealActiveStockTab,
  stockQuoteFromHoldings,
  stockSymbolFromHash,
  stockTabFromHash
} from '../public/modules/stock-research-page.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function button(dataset = {}) {
  return { dataset, onclick: null };
}

function fakeView(nodes = {}) {
  return {
    innerHTML: '',
    ownerDocument: { getElementById: () => null },
    querySelector: selector => {
      const value = nodes[selector];
      return Array.isArray(value) ? (value[0] || null) : (value || null);
    },
    querySelectorAll: selector => nodes[selector] || []
  };
}

function baseData(symbol = 'AAPL') {
  return {
    holdings: [{
      id: 'h1',
      symbol,
      name: symbol === 'AAPL' ? 'Apple' : 'Alphabet',
      layer: 'stock',
      currency: 'USD',
      quantity: 10,
      price: 200,
      avgCost: 150,
      quoteSymbol: symbol
    }],
    research: [{
      id: 'r1',
      symbol,
      thesis: '長期現金流',
      metrics: '營收',
      risks: '估值',
      status: 'valid',
      checkpoints: [{ date: '2026-07-01', note: '既有檢查' }]
    }],
    securities: {
      trades: [{
        id: 't1',
        symbol,
        source: 'ibkr',
        tradeDate: '2026-07-01',
        side: 'buy',
        quantity: 1,
        price: 180,
        netSettlement: 180,
        cashDirection: 'out',
        currency: 'USD'
      }]
    },
    summary: { netWorth: 2000000 },
    settings: { usdTwd: 32, ibConcentrationPct: 5, quotesLastAt: '2026-07-25T08:00:00.000Z' },
    fundamentals: {
      symbol,
      freshness: 'fresh',
      fresh: true,
      stale: false,
      fetchedAt: '2026-07-28T00:00:00.000Z',
      data: {
        symbol,
        market: 'US',
        company: { cik: '0000000001', name: `${symbol} Official`, sic: '3571', fiscalYearEnd: '12-31' },
        metrics: {},
        warnings: []
      }
    }
  };
}

function pageHarness(data = baseData(), nodes = {}) {
  let hash = '#stock?symbol=AAPL';
  let routeSeq = 1;
  const calls = [];
  const forms = [];
  const infos = [];
  const toasts = [];
  const root = fakeView(nodes);
  const responseOf = path => {
    if (/^\/stock-fundamentals\/[^/]+\/refresh$/.test(path)) {
      return data.fundamentalsRefresh || data.fundamentals;
    }
    if (/^\/stock-fundamentals\/[^/]+$/.test(path)) return data.fundamentals;
    return ({
      '/holdings': data.holdings,
      '/research': data.research,
      '/securities': data.securities,
      '/summary': data.summary,
      '/settings': data.settings
    })[path];
  };
  const render = createStockResearchPage({
    api: async (path, options) => {
      calls.push({ path, options });
      return responseOf(path);
    },
    getView: () => root,
    getHash: () => hash,
    getRouteSeq: () => routeSeq,
    getViewCurrency: () => 'TWD',
    esc,
    openForm: config => forms.push(config),
    openInfo: (title, html) => infos.push({ title, html }),
    toast: (message, error) => toasts.push({ message, error }),
    today: () => '2026-07-26'
  });
  return {
    render, root, calls, forms, infos, toasts,
    setHash: value => { hash = value; },
    setRouteSeq: value => { routeSeq = value; }
  };
}

test('個股研究頁路由｜每次從當下 hash 解析代號，非 stock 路由與缺代號回空', () => {
  assert.equal(stockSymbolFromHash('#stock?symbol=aapl'), 'AAPL');
  assert.equal(stockSymbolFromHash('#stock?foo=1&symbol=%20googl%20'), 'GOOGL');
  assert.equal(stockSymbolFromHash('#stock'), '');
  assert.equal(stockSymbolFromHash('#ib?symbol=AAPL'), '');
});

test('個股研究頁路由｜tab 深連結可重載，非法值與原型名稱一律回總覽', () => {
  assert.equal(stockTabFromHash('#stock?symbol=AAPL&tab=valuation'), 'valuation');
  assert.equal(stockTabFromHash('#stock?tab=trades&symbol=AAPL'), 'trades');
  for (const hash of [
    '#stock?symbol=AAPL',
    '#stock?symbol=AAPL&tab=not-real',
    '#stock?symbol=AAPL&tab=__proto__',
    '#stock?symbol=AAPL&tab=toString',
    '#ib?tab=trades'
  ]) {
    assert.equal(stockTabFromHash(hash), 'overview', hash);
  }
});

test('個股研究頁路由｜render 後把目前頁籤捲進可視範圍，缺 DOM 時安全略過', () => {
  const calls = [];
  revealActiveStockTab({
    querySelector: selector => selector === '.stock-tab.active'
      ? { scrollIntoView: options => calls.push(options) }
      : null
  });
  revealActiveStockTab(null);
  revealActiveStockTab({});
  assert.deepEqual(calls, [{ block: 'nearest', inline: 'center' }]);
});

test('個股研究頁報價｜只讀持股已保存現價，來源與日期不假裝成即時資料', () => {
  const quote = stockQuoteFromHoldings('aapl', baseData().holdings, baseData().settings);
  assert.deepEqual(quote, {
    price: 200,
    currency: 'USD',
    source: 'Yahoo Finance',
    asOf: '2026-07-25'
  });
  assert.deepEqual(stockQuoteFromHoldings('GOOGL', baseData().holdings, baseData().settings), {});
  assert.deepEqual(stockQuoteFromHoldings('AAPL', [{
    symbol: 'AAPL', layer: 'stock', price: null, currency: 'USD', quoteSymbol: 'AAPL'
  }], baseData().settings), {}, '缺報價不可被 Number(null) 冒充成真的 0');
});

test('個股研究頁控制器｜平行讀五個唯讀來源，總覽與交易深連結各只顯示自己的內容', async () => {
  const harness = pageHarness();
  await harness.render();

  assert.deepEqual(harness.calls.map(call => call.path).sort(), [
    '/holdings', '/research', '/securities', '/settings', '/summary'
  ]);
  assert.ok(harness.calls.every(call => call.options == null));
  assert.match(harness.root.innerHTML, /AAPL/);
  assert.match(harness.root.innerHTML, /Apple/);
  assert.match(harness.root.innerHTML, /長期現金流/);
  assert.match(harness.root.innerHTML, /6\.4 萬/);
  assert.match(harness.root.innerHTML, /data-stock-tab="overview"/);
  assert.doesNotMatch(harness.root.innerHTML, /我的交易紀錄/);

  harness.setHash('#stock?symbol=AAPL&tab=trades');
  await harness.render();
  assert.match(harness.root.innerHTML, /data-stock-tab="trades"/);
  assert.match(harness.root.innerHTML, /我的交易紀錄/);
  assert.doesNotMatch(harness.root.innerHTML, /長期現金流|6\.4 萬/);
});

test('個股研究頁基本面｜只在基本面頁籤讀快取；fresh 不自動重抓', async () => {
  const harness = pageHarness();
  harness.setHash('#stock?symbol=AAPL&tab=fundamentals');
  await harness.render();

  assert.deepEqual(harness.calls.filter(call => call.path.startsWith('/stock-fundamentals')), [{
    path: '/stock-fundamentals/AAPL',
    options: undefined
  }]);
  assert.match(harness.root.innerHTML, /AAPL Official/);
  assert.match(harness.root.innerHTML, /SEC 官方資料已是最新快取/);
  assert.match(harness.root.innerHTML, /研究這家公司要問的八組問題/);
});

test('個股研究頁基本面｜missing 先畫可用內容再背景更新，手動研究不被外部資料擋住', async () => {
  const data = baseData();
  data.fundamentals = {
    symbol: 'AAPL',
    freshness: 'missing',
    fresh: false,
    stale: false,
    fetchedAt: null,
    data: null
  };
  data.fundamentalsRefresh = baseData().fundamentals;
  const refreshButton = button();
  const infoButton = button({ stockInfo: 'missing' });
  const mount = {
    innerHTML: '',
    querySelectorAll: selector => ({
      '[data-stock-fundamentals-refresh]': [refreshButton],
      '[data-stock-info]': [infoButton]
    })[selector] || []
  };
  const harness = pageHarness(data, { '[data-stock-fundamentals-root]': mount });
  harness.setHash('#stock?symbol=AAPL&tab=fundamentals');
  await harness.render();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(harness.calls.filter(call => call.path.startsWith('/stock-fundamentals')).map(call => ({
    path: call.path,
    method: call.options?.method
  })), [
    { path: '/stock-fundamentals/AAPL', method: undefined },
    { path: '/stock-fundamentals/AAPL/refresh', method: 'POST' }
  ]);
  assert.match(mount.innerHTML, /AAPL Official/);
  assert.match(mount.innerHTML, /關鍵指標/);
  assert.match(mount.innerHTML, /營收/);
  infoButton.onclick();
  assert.equal(harness.infos.at(-1).title, '「尚未取得」是 0 嗎？',
    '背景替換基本面內容後，新說明按鈕仍要重新綁定');
});

test('個股研究頁基本面｜fresh 仍可手動更新，按鈕只走同一支 refresh API', async () => {
  const refreshButton = button();
  const mount = {
    innerHTML: '',
    querySelectorAll: selector => selector === '[data-stock-fundamentals-refresh]' ? [refreshButton] : []
  };
  const harness = pageHarness(baseData(), { '[data-stock-fundamentals-root]': mount });
  harness.setHash('#stock?symbol=AAPL&tab=fundamentals');
  await harness.render();

  assert.equal(typeof refreshButton.onclick, 'function');
  refreshButton.onclick();
  await new Promise(resolve => setImmediate(resolve));

  const refreshCalls = harness.calls.filter(call => call.path.endsWith('/refresh'));
  assert.deepEqual(refreshCalls, [{
    path: '/stock-fundamentals/AAPL/refresh',
    options: { method: 'POST' }
  }]);
  assert.deepEqual(harness.toasts.at(-1), { message: '官方基本面已更新', error: false });
});

test('個股研究頁控制器｜缺 symbol 直接顯示引導，不讀資料也不自動建立研究', async () => {
  const harness = pageHarness();
  harness.setHash('#stock');
  await harness.render();

  assert.equal(harness.calls.length, 0);
  assert.match(harness.root.innerHTML, /請先選擇一檔個股/);
  assert.doesNotMatch(harness.root.innerHTML, /data-stock-create/);
});

test('個股研究頁控制器｜同頁較舊請求晚回來也不能蓋掉新代號', async () => {
  let resolveFirst;
  const firstHoldings = new Promise(resolve => { resolveFirst = resolve; });
  let hash = '#stock?symbol=AAPL';
  let holdingCalls = 0;
  const root = fakeView();
  const allData = baseData('GOOGL');
  const render = createStockResearchPage({
    api: async path => {
      if (path === '/holdings') {
        holdingCalls += 1;
        if (holdingCalls === 1) return firstHoldings;
      }
      return ({
        '/holdings': allData.holdings,
        '/research': allData.research,
        '/securities': allData.securities,
        '/summary': allData.summary,
        '/settings': allData.settings
      })[path];
    },
    getView: () => root,
    getHash: () => hash,
    getRouteSeq: () => 1,
    getViewCurrency: () => 'TWD',
    esc,
    openForm: () => {},
    openInfo: () => {},
    toast: () => {},
    today: () => '2026-07-26'
  });

  const oldRender = render();
  hash = '#stock?symbol=GOOGL';
  await render();
  assert.match(root.innerHTML, /GOOGL/);
  resolveFirst(baseData('AAPL').holdings);
  await oldRender;
  assert.match(root.innerHTML, /GOOGL/);
  assert.doesNotMatch(root.innerHTML, /AAPL/);
});

test('個股研究頁控制器｜同代號快速切頁籤時，舊頁晚回來不能蓋掉新頁籤', async () => {
  let resolveFirst;
  const firstHoldings = new Promise(resolve => { resolveFirst = resolve; });
  let hash = '#stock?symbol=AAPL&tab=overview';
  let holdingCalls = 0;
  const root = fakeView();
  const data = baseData();
  const render = createStockResearchPage({
    api: async path => {
      if (path === '/holdings') {
        holdingCalls += 1;
        if (holdingCalls === 1) return firstHoldings;
      }
      return ({
        '/holdings': data.holdings,
        '/research': data.research,
        '/securities': data.securities,
        '/summary': data.summary,
        '/settings': data.settings
      })[path];
    },
    getView: () => root,
    getHash: () => hash,
    getRouteSeq: () => 1,
    getViewCurrency: () => 'TWD',
    esc,
    openForm: () => {},
    openInfo: () => {},
    toast: () => {},
    today: () => '2026-07-26'
  });

  const oldRender = render();
  hash = '#stock?symbol=AAPL&tab=trades';
  await render();
  assert.match(root.innerHTML, /data-stock-tab="trades"/);
  resolveFirst(data.holdings);
  await oldRender;
  assert.match(root.innerHTML, /data-stock-tab="trades"/);
  assert.doesNotMatch(root.innerHTML, /data-stock-tab="overview"/);
});

test('個股研究頁基本面｜AAPL 背景更新慢回來，不得改寫已切到的 GOOGL 頁面', async () => {
  let releaseRefresh;
  const delayedRefresh = new Promise(resolve => { releaseRefresh = resolve; });
  let hash = '#stock?symbol=AAPL&tab=fundamentals';
  const root = fakeView();
  const mount = {
    innerHTML: '',
    querySelectorAll: () => []
  };
  root.querySelector = selector => selector === '[data-stock-fundamentals-root]' ? mount : null;
  const aapl = baseData('AAPL');
  const googl = baseData('GOOGL');
  let current = aapl;
  const render = createStockResearchPage({
    api: async (path, options) => {
      if (path === '/stock-fundamentals/AAPL') {
        return { symbol: 'AAPL', freshness: 'missing', fresh: false, stale: false, data: null };
      }
      if (path === '/stock-fundamentals/AAPL/refresh' && options?.method === 'POST') return delayedRefresh;
      return ({
        '/holdings': current.holdings,
        '/research': current.research,
        '/securities': current.securities,
        '/summary': current.summary,
        '/settings': current.settings
      })[path];
    },
    getView: () => root,
    getHash: () => hash,
    getRouteSeq: () => 1,
    getViewCurrency: () => 'TWD',
    esc,
    openForm: () => {},
    openInfo: () => {},
    toast: () => {},
    today: () => '2026-07-26'
  });

  await render();
  const aaplMountBeforeNavigation = mount.innerHTML;
  current = googl;
  hash = '#stock?symbol=GOOGL&tab=overview';
  await render();
  assert.match(root.innerHTML, /GOOGL/);

  releaseRefresh(aapl.fundamentals);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(root.innerHTML, /GOOGL/);
  assert.doesNotMatch(root.innerHTML, /AAPL Official/);
  assert.equal(mount.innerHTML, aaplMountBeforeNavigation, '離頁後舊背景回應連舊 mount 都不可再寫');
});

test('個股研究頁互動｜說明、編輯與檢查點都接正確入口，儲存後仍在原頁才重畫', async () => {
  const infoButton = button({ stockInfo: 'cap' });
  const editButton = button();
  const checkpointButton = button();
  const harness = pageHarness(baseData(), {
    '[data-stock-info]': [infoButton],
    '[data-stock-edit], [data-stock-create]': [editButton],
    '[data-stock-add-checkpoint]': [checkpointButton]
  });
  await harness.render();

  infoButton.onclick();
  assert.equal(harness.infos[0].title, '個股上限怎麼看？');
  assert.match(harness.infos[0].html, /凍結加碼/);
  assert.match(harness.infos[0].html, /不會叫你賣/);

  editButton.onclick();
  assert.equal(harness.forms[0].title, 'AAPL 研究卡');
  await harness.forms[0].onSubmit({ thesis: '更新論點', metrics: '新指標', risks: '新風險' });
  assert.deepEqual(harness.calls.findLast(call => call.options?.method === 'PUT'), {
    path: '/research/r1',
    options: {
      method: 'PUT',
      body: { thesis: '更新論點', metrics: '新指標', risks: '新風險' }
    }
  });

  checkpointButton.onclick();
  assert.equal(harness.forms[1].title, 'AAPL 新增檢查點');
  await harness.forms[1].onSubmit({ date: '2026-07-26', note: '財報後重看' });
  assert.deepEqual(harness.calls.findLast(call => call.options?.method === 'PUT'), {
    path: '/research/r1',
    options: {
      method: 'PUT',
      body: {
        checkpoints: [
          { date: '2026-07-01', note: '既有檢查' },
          { date: '2026-07-26', note: '財報後重看' }
        ]
      }
    }
  });
  assert.equal(harness.toasts.at(-1).message, '已記錄檢查點');
});

test('個股研究頁接線｜app router 先拆 query，index 載入研究頁專用 CSS', async () => {
  const [app, index] = await Promise.all([
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  ]);
  assert.match(app, /location\.hash\.replace\(\/\^#\/, ''\)\.split\('\?'\)\[0\]/);
  assert.match(app, /classList\.toggle\('stock-research-route', route === 'stock'\)/);
  assert.match(app, /stock:\s*renderStockResearch/);
  assert.match(index, /href="stock-research\.css"/);
});
