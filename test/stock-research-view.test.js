import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icon } from '../public/modules/icons.js';
import {
  STOCK_RESEARCH_TABS,
  buildStockResearchViewModel,
  normalizeStockResearchTab,
  safeResearchUrl,
  stockResearchTrades,
  stockResearchViewHtml,
  valuationDistance
} from '../public/modules/stock-research-view.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

const baseModel = (overrides = {}) => ({
  symbol: 'AAPL',
  name: 'Apple Inc.',
  position: {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    currency: 'USD',
    quantity: 10,
    costTwd: 500000,
    valueTwd: 620000,
    pnlTwd: 120000,
    held: true
  },
  allocation: { pct: 4.5, capPct: 5, frozen: false },
  status: { value: 'valid', label: '持有論點成立' },
  availability: { state: 'ready', label: '研究資料已建立', canEdit: true, canCreate: false },
  research: {
    symbol: 'AAPL',
    thesis: '服務收入與生態系黏著度',
    metrics: '服務營收、毛利率、回購',
    risks: '中國市場與估值',
    status: 'valid',
    lastReviewedAt: '2026-07-24',
    scorecard: {
      business: 4,
      financial: 5,
      valuation: 2,
      evidence: 3,
      risk: 4,
      reasons: {
        business: '生態系仍有黏著度',
        financial: '現金流穩健',
        valuation: '估值偏高',
        evidence: '服務成長仍支持',
        risk: '部位符合上限'
      }
    },
    valuationScenarios: {
      currency: 'USD',
      asOf: '2026-07-24',
      method: '情境估值',
      bear: 160,
      base: 200,
      bull: 250,
      assumptions: '由使用者手動填寫'
    },
    watchMetrics: [
      { label: '服務營收成長率', value: 12, unit: '%', period: '2026 Q2', source: '公司財報' },
      { label: '下一季毛利率', value: null, unit: '%', period: '2026 Q3', source: '尚待財報' }
    ],
    catalysts: [{ text: '服務營收加速', horizon: '2026 H2', status: 'watching' }],
    thesisBreakers: [{ text: '服務營收連續兩季衰退', status: 'watching' }],
    checkpoints: [{ date: '2026-07-24', note: '財報後重看，論點維持' }],
    scoreHistory: [{
      date: '2026-07-24',
      total: 73,
      scores: { business: 4, financial: 5, valuation: 2, evidence: 3, risk: 4 }
    }],
    sources: [{ label: '2026 Q2 10-Q', url: 'https://example.com/report', asOf: '2026-07-24' }]
  },
  scorecard: null,
  valuationScenarios: null,
  ...overrides
});

function syncedModel(overrides = {}) {
  const model = baseModel(overrides);
  model.scorecard = model.research?.scorecard ?? null;
  model.valuationScenarios = model.research?.valuationScenarios ?? null;
  return model;
}

const trades = [
  {
    id: 't2', symbol: 'aapl', source: 'ibkr', tradeDate: '2026-07-20',
    side: 'sell', quantity: 1.25, price: 215.1234, commission: 1,
    tax: 0, otherFees: 0, netSettlement: 267.9, cashDirection: 'in', currency: 'USD'
  },
  {
    id: 't1', symbol: 'AAPL', source: 'taishin', tradeDate: '2026-06-01',
    side: 'buy', quantity: 2, price: 6500, commission: 20,
    tax: 0, otherFees: 5, netSettlement: 13025, cashDirection: 'out', currency: 'TWD'
  },
  {
    id: 'other', symbol: 'GOOGL', source: 'ibkr', tradeDate: '2026-07-25',
    side: 'buy', quantity: 1, price: 180, netSettlement: 180, cashDirection: 'out', currency: 'USD'
  }
];

function renderTabs(input, tabs = STOCK_RESEARCH_TABS.map(tab => tab.key)) {
  return tabs.map(activeTab => stockResearchViewHtml({ ...input, activeTab }, { esc })).join('');
}

test('個股研究畫面｜完整研究依藍圖顯示摘要、評分、估值、追蹤與原幣交易', () => {
  const html = renderTabs({
    model: syncedModel(),
    trades,
    quote: { price: 220, currency: 'USD', source: 'Yahoo Finance', asOf: '2026-07-25' },
    viewCurrency: 'TWD',
    usdRate: 32
  });

  assert.match(html, /AAPL/);
  assert.match(html, /Apple Inc\./);
  assert.match(html, /持有論點成立/);
  assert.match(html, /62 萬/);
  assert.match(html, /73 分/);
  assert.match(html, /服務收入與生態系黏著度/);
  assert.match(html, /服務營收連續兩季衰退/);
  assert.match(html, /現價高於 10%/);
  assert.match(html, /財報後重看，論點維持/);
  assert.match(html, /IBKR/);
  assert.match(html, /台新證券/);
  assert.match(html, />USD</);
  assert.match(html, />TWD</);
  assert.doesNotMatch(html, /GOOGL/);
  assert.match(html, /每筆依來源原幣顯示，不跨幣別加總/);
});

test('個股研究頁籤｜六個固定連結只顯示一個 active panel，選中頁籤與網址一致', () => {
  assert.deepEqual(STOCK_RESEARCH_TABS.map(tab => tab.key), [
    'overview', 'fundamentals', 'score', 'valuation', 'thesis', 'trades'
  ]);
  const html = stockResearchViewHtml({
    model: syncedModel(),
    trades,
    activeTab: 'valuation'
  }, { esc });

  assert.equal((html.match(/<a id="stock-tab-/g) || []).length, 6);
  const tabs = html.match(/<nav class="stock-tabs"[\s\S]*?<\/nav>/)?.[0] || '';
  assert.equal((tabs.match(/<svg class="ic"/g) || []).length, 6);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /href="#stock\?symbol=AAPL&amp;tab=valuation"[^>]*aria-current="page"/);
  assert.match(html, /data-stock-tab="valuation"/);
  assert.match(html, /估值情境/);
  assert.doesNotMatch(html, /五項評分|我的交易紀錄|關鍵指標/);
});

test('個股研究頁籤｜非法、缺值與原型名稱 fail-closed 回總覽', () => {
  for (const value of [undefined, '', 'not-real', '__proto__', 'toString', 'constructor']) {
    assert.equal(normalizeStockResearchTab(value), 'overview', String(value));
  }
  assert.equal(normalizeStockResearchTab(' TRADES '), 'trades');
});

test('個股研究頁籤｜既有七區塊各歸固定工作頁，不在單頁重複堆疊', () => {
  const input = { model: syncedModel(), trades };
  const overview = stockResearchViewHtml({ ...input, activeTab: 'overview' }, { esc });
  const fundamentals = stockResearchViewHtml({ ...input, activeTab: 'fundamentals' }, { esc });
  const score = stockResearchViewHtml({ ...input, activeTab: 'score' }, { esc });
  const valuation = stockResearchViewHtml({ ...input, activeTab: 'valuation' }, { esc });
  const thesis = stockResearchViewHtml({ ...input, activeTab: 'thesis' }, { esc });
  const trade = stockResearchViewHtml({ ...input, activeTab: 'trades' }, { esc });

  assert.match(overview, /目前部位[\s\S]*研究結論[\s\S]*最近檢查點/);
  assert.doesNotMatch(overview, /五項評分|關鍵指標|估值情境|我的交易紀錄/);
  assert.match(fundamentals, /關鍵指標/);
  assert.match(score, /五項評分/);
  assert.match(valuation, /估值情境/);
  assert.match(thesis, /研究結論[\s\S]*風險與追蹤[\s\S]*資料來源/);
  assert.match(trade, /我的交易紀錄/);
});

test('個股研究畫面｜四個必懂概念都有就地 info-link', () => {
  const zeroCap = syncedModel({
    allocation: { pct: 4.5, capPct: 0, frozen: true },
    research: {
      ...baseModel().research,
      scorecard: {
        business: 0,
        financial: 0,
        valuation: 0,
        evidence: 0,
        risk: 0,
        reasons: {
          business: '已有反證',
          financial: '已有反證',
          valuation: '已有反證',
          evidence: '已有反證',
          risk: '已有反證'
        }
      }
    }
  });
  zeroCap.scorecard = zeroCap.research.scorecard;
  const html = renderTabs({ model: zeroCap }, ['overview', 'fundamentals', 'score']);

  for (const key of ['score', 'zero', 'missing', 'cap']) {
    assert.match(html, new RegExp(`class="info-link" data-stock-info="${key}"`));
  }
  assert.match(html, /0 分/);
  assert.match(html, /0／5/);
  assert.match(html, /data-score-complete="true"/);
});

test('個股研究畫面｜正常上限也永遠提供軟上限說明，評分理由保留換行', () => {
  const model = syncedModel();
  model.research.scorecard.reasons.business = '第一行\n第二行';
  model.scorecard = model.research.scorecard;
  const html = renderTabs({ model }, ['overview', 'score']);

  assert.match(html, /data-stock-info="cap">怎麼看？/);
  assert.match(html, /第一行<br>第二行/);
});

test('個股研究畫面｜未完成評分不顯示部分總分，缺指標和真的 0 分不混淆', () => {
  const model = syncedModel({
    research: {
      ...baseModel().research,
      scorecard: {
        business: 0,
        financial: 5,
        reasons: { business: '已有明確反證' }
      },
      watchMetrics: [
        { label: '有值的 0', value: 0, unit: '%' },
        { label: '缺資料', value: null, unit: '%' }
      ]
    }
  });
  model.scorecard = model.research.scorecard;
  const html = renderTabs({ model }, ['fundamentals', 'score']);

  assert.match(html, /已評 1／5 項/);
  assert.doesNotMatch(html, /部分總分|20 分/);
  assert.match(html, /data-score-key="business" data-score-complete="true"/);
  assert.match(html, /data-score-key="financial" data-score-complete="false"/);
  assert.match(html, /有值的 0/);
  assert.match(html, />0 %</);
  assert.match(html, /缺資料/);
  assert.match(html, /尚未取得/);
});

test('個股研究畫面｜惡意與超長使用者文字全部跳脫，來源連結只放行 http/https', () => {
  const payload = '<img src=x onerror=alert(1)>' + '很長的研究內容'.repeat(80);
  const model = syncedModel({
    name: payload,
    research: {
      ...baseModel().research,
      thesis: `<script>alert('thesis')</script>\n${payload}`,
      risks: '<svg onload=alert(1)>',
      sources: [
        { label: '<b>安全來源</b>', url: 'https://example.com/a?x=1&y=2' },
        { label: '惡意來源', url: 'javascript:alert(1)' },
        { label: '資料網址', url: 'data:text/html,<script>alert(1)</script>' }
      ]
    }
  });
  const html = stockResearchViewHtml({ model, activeTab: 'thesis' }, { esc });

  assert.doesNotMatch(html, /<script>|<img |<svg onload|href="javascript:|href="data:/);
  assert.match(html, /&lt;script&gt;alert\(&#39;thesis&#39;\)&lt;\/script&gt;<br>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
  assert.equal((html.match(/無可開啟連結/g) || []).length, 2);
  assert.equal(safeResearchUrl('javascript:alert(1)'), null);
  assert.equal(safeResearchUrl('https://example.com/path'), 'https://example.com/path');
});

test('個股研究畫面｜有持股沒研究時仍顯示部位和交易，不自動捏造研究', () => {
  const model = baseModel({
    research: null,
    scorecard: null,
    valuationScenarios: null,
    status: { value: 'unreviewed', label: '尚未評估' },
    availability: { state: 'missing-research', label: '尚未撰寫', canEdit: false, canCreate: true }
  });
  const html = renderTabs({ model, trades }, ['overview', 'trades']);

  assert.match(html, /AAPL 尚未撰寫研究/);
  assert.match(html, /data-stock-create/);
  assert.match(html, /62 萬/);
  assert.match(html, /我的交易紀錄/);
  assert.doesNotMatch(html, /五項評分|估值情境/);
});

test('個股研究頁籤｜沒有研究仍可開總覽、基本面與交易，手寫頁籤提供建立入口', () => {
  const model = baseModel({
    research: null,
    scorecard: null,
    valuationScenarios: null,
    availability: { state: 'missing-research', label: '尚未撰寫', canEdit: false, canCreate: true }
  });
  const fundamentals = stockResearchViewHtml({ model, activeTab: 'fundamentals' }, { esc });
  const score = stockResearchViewHtml({ model, activeTab: 'score' }, { esc });
  const trade = stockResearchViewHtml({ model, trades, activeTab: 'trades' }, { esc });

  assert.match(fundamentals, /關鍵指標/);
  assert.doesNotMatch(fundamentals, /AAPL 尚未撰寫研究/);
  assert.match(score, /AAPL 尚未撰寫研究[\s\S]*data-stock-create/);
  assert.match(trade, /我的交易紀錄[\s\S]*IBKR/);
});

test('個股研究畫面｜賣光但有研究仍可讀；完全空白與缺代號不自動建資料', () => {
  const notHeld = syncedModel({
    position: { symbol: 'AAPL', quantity: 0, costTwd: 0, valueTwd: 0, pnlTwd: 0, held: false },
    allocation: { pct: 0, capPct: 5, frozen: false },
    availability: { state: 'not-held', label: '目前未持有', canEdit: true, canCreate: false }
  });
  assert.match(stockResearchViewHtml({ model: notHeld, activeTab: 'overview' }, { esc }), /目前未持有/);
  assert.match(stockResearchViewHtml({ model: notHeld, activeTab: 'overview' }, { esc }), /服務收入與生態系黏著度/);

  const empty = baseModel({
    symbol: 'NVDA',
    name: '',
    position: { symbol: 'NVDA', quantity: 0, held: false },
    research: null,
    scorecard: null,
    valuationScenarios: null,
    availability: { state: 'empty', label: '尚無持股或研究資料', canEdit: false, canCreate: false }
  });
  const emptyHtml = stockResearchViewHtml({ model: empty }, { esc });
  assert.match(emptyHtml, /NVDA 尚無持股或研究資料/);
  assert.doesNotMatch(emptyHtml, /data-stock-create/);
  assert.ok(emptyHtml.includes(icon('arrow-left', 16)));

  const missingSymbol = stockResearchViewHtml({
    model: {
      symbol: '',
      availability: { state: 'missing-symbol', label: '未指定個股代號' }
    }
  }, { esc });
  assert.match(missingSymbol, /請先選擇一檔個股/);
  assert.match(missingSymbol, /href="#ib"/);
  assert.ok(missingSymbol.includes(icon('arrow-left', 16)));
});

test('個股研究畫面｜舊研究只有文字與檢查點仍能顯示，不要求新欄位', () => {
  const legacy = syncedModel({
    research: {
      symbol: 'AAPL',
      thesis: '舊版論點',
      metrics: '舊版指標說明',
      risks: '舊版風險',
      checkpoints: [{ date: '2026-06', note: '月格式舊檢查點' }]
    }
  });
  legacy.scorecard = null;
  legacy.valuationScenarios = null;
  const html = renderTabs({ model: legacy }, ['fundamentals', 'score', 'valuation', 'thesis']);

  assert.match(html, /舊版論點/);
  assert.match(html, /舊版指標說明/);
  assert.match(html, /舊版風險/);
  assert.match(html, /2026-06/);
  assert.match(html, /已評 0／5 項/);
  assert.match(html, /尚未填寫估值情境/);
});

test('個股研究畫面｜交易排序、代號比對與 view model 都不修改輸入資料', () => {
  const frozenTrades = structuredClone(trades);
  const frozenModel = syncedModel();
  const beforeModel = structuredClone(frozenModel);

  assert.deepEqual(stockResearchTrades(' aapl ', trades).map(trade => trade.id), ['t2', 't1']);
  const view = buildStockResearchViewModel({ model: frozenModel, trades });
  assert.deepEqual(view.trades.map(trade => trade.id), ['t2', 't1']);
  assert.deepEqual(trades, frozenTrades);
  assert.deepEqual(frozenModel, beforeModel);
});

test('個股研究畫面｜缺美元匯率時留在台幣，不用 1 比 1 捏造美元金額', () => {
  const withoutRate = buildStockResearchViewModel({
    model: syncedModel(),
    viewCurrency: 'USD',
    usdRate: null
  });
  const withRate = buildStockResearchViewModel({
    model: syncedModel(),
    viewCurrency: 'USD',
    usdRate: 32
  });

  assert.equal(withoutRate.viewCurrency, 'TWD');
  assert.equal(withRate.viewCurrency, 'USD');
  assert.equal(withRate.usdRate, 32);
});

test('個股研究畫面｜估值距離只在現價與情境同幣且合理價值大於 0 時才計算', () => {
  assert.ok(Math.abs(/** @type {number} */ (valuationDistance(220, 'USD', 200, 'USD')) - 10) < 1e-9);
  assert.equal(valuationDistance(220, 'USD', 200, 'TWD'), null);
  assert.equal(valuationDistance(null, 'USD', 200, 'USD'), null);
  assert.equal(valuationDistance(220, 'USD', 0, 'USD'), null);
});

test('個股研究樣式｜桌面有彈性欄寬、手機摘要兩欄、長字與表格不溢出外框', async () => {
  const css = await readFile(new URL('../public/stock-research.css', import.meta.url), 'utf8');

  assert.match(css, /max-width:\s*1240px/);
  assert.match(css, /grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.stock-table-wrap[\s\S]*border-radius:\s*8px/);
  assert.match(css, /\.stock-tab[\s\S]*border-radius:\s*16px 16px 0 0/);
  assert.match(css, /\.stock-tab\.active[\s\S]*border-color:\s*var\(--frame\)/);
  assert.match(css, /\.stock-tabs[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /@media \(max-width:\s*680px\)[\s\S]*\.stock-tab[\s\S]*flex:\s*0 0 52px/);
  assert.match(css, /@media \(max-width:\s*680px\)[\s\S]*\.stock-position-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);
  assert.doesNotMatch(css, /font-size:\s*[^;]*(vw|vh)/);
});
