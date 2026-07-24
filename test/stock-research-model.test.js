import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStockResearchModel,
  findStockResearch,
  researchStatusOf,
  stockAllocationForSymbol,
  stockResearchAvailability,
  summarizeStockPosition
} from '../public/modules/stock-research-model.js';

test('個股研究模型｜代號正規化後找到同一筆研究', () => {
  const research = [
    { symbol: 'GOOGL', thesis: '廣告與雲端' },
    { symbol: ' aapl ', thesis: '生態系' }
  ];

  assert.equal(findStockResearch(' AAPL ', research)?.thesis, '生態系');
  assert.equal(findStockResearch('aapl', research)?.thesis, '生態系');
  assert.equal(findStockResearch('', research), null);
});

test('個股研究模型｜同代號多筆個股持股合併，其他層與其他代號不混入', () => {
  const rows = [
    { symbol: 'AAPL', name: 'Apple', currency: 'usd', layer: 'stock', quantity: 3, costTwd: 90, valueTwd: 120, pnlTwd: 30 },
    { symbol: ' aapl ', layer: 'stock', quantity: 2, costTwd: 60, valueTwd: 70, pnlTwd: 10 },
    { symbol: 'AAPL', layer: 'core', quantity: 99, costTwd: 999, valueTwd: 999, pnlTwd: 999 },
    { symbol: 'GOOGL', layer: 'stock', quantity: 1, costTwd: 50, valueTwd: 60, pnlTwd: 10 }
  ];

  assert.deepEqual(summarizeStockPosition('aapl', rows), {
    symbol: 'AAPL',
    name: 'Apple',
    currency: 'USD',
    positionCount: 2,
    quantity: 5,
    costTwd: 150,
    valueTwd: 190,
    pnlTwd: 40,
    held: true
  });
});

test('個股研究模型｜TSLA 與 SPCX 有持股沒研究時都明確顯示尚未撰寫', () => {
  const rows = [
    { symbol: 'TSLA', layer: 'stock', quantity: 1, valueTwd: 100 },
    { symbol: 'SPCX', layer: 'stock', quantity: 2, valueTwd: 200 }
  ];

  for (const symbol of ['TSLA', 'SPCX']) {
    const model = buildStockResearchModel({ symbol, rows, research: [], netWorth: 1000 });
    assert.equal(model.position.held, true);
    assert.equal(model.research, null);
    assert.equal(model.availability.state, 'missing-research');
    assert.equal(model.availability.label, '尚未撰寫');
    assert.equal(model.availability.canCreate, true);
    assert.equal(model.availability.autoCreate, false);
  }
});

test('個股研究模型｜賣光但研究仍在時保留頁面並標示目前未持有', () => {
  const model = buildStockResearchModel({
    symbol: 'GOOGL',
    rows: [],
    research: [{ symbol: 'googl', status: 'valid', thesis: '既有研究' }],
    netWorth: 1000
  });

  assert.equal(model.position.held, false);
  assert.equal(model.research?.thesis, '既有研究');
  assert.equal(model.availability.state, 'not-held');
  assert.equal(model.availability.label, '目前未持有');
  assert.equal(model.availability.canEdit, true);
});

test('個股研究模型｜沒有持股也沒有研究時只回空狀態，不自動建立資料', () => {
  const model = buildStockResearchModel({
    symbol: 'NVDA',
    rows: [],
    research: [],
    netWorth: 1000
  });

  assert.equal(model.availability.state, 'empty');
  assert.equal(model.availability.canCreate, false);
  assert.equal(model.availability.autoCreate, false);
  assert.equal(model.research, null);
});

test('個股研究模型｜缺少代號時回不可編輯狀態', () => {
  const model = buildStockResearchModel({
    symbol: '   ',
    rows: [{ symbol: 'AAPL', layer: 'stock', quantity: 1, valueTwd: 100 }],
    research: [{ symbol: 'AAPL' }],
    netWorth: 1000
  });

  assert.equal(model.symbol, '');
  assert.equal(model.availability.state, 'missing-symbol');
  assert.equal(model.availability.canEdit, false);
  assert.equal(model.availability.canCreate, false);
  assert.equal(model.allocation.pct, 0);
});

test('個股研究模型｜占比分子與凍結判斷沿用投資風險規則，零上限仍有效', () => {
  const rows = [
    { symbol: 'AAPL', layer: 'stock', valueTwd: 60 },
    { symbol: ' aapl ', layer: 'stock', valueTwd: 20 },
    { symbol: 'AAPL', layer: 'core', valueTwd: 500 }
  ];
  const allocation = stockAllocationForSymbol('aapl', rows, 1000, { ibConcentrationPct: 0 });

  assert.deepEqual(allocation, {
    valueTwd: 80,
    netWorth: 1000,
    pct: 8,
    capPct: 0,
    frozen: true
  });
});

test('個股研究模型｜淨資產不是正數時不捏造占比或凍結結論', () => {
  const allocation = stockAllocationForSymbol(
    'AAPL',
    [{ symbol: 'AAPL', layer: 'stock', valueTwd: 80 }],
    0,
    { ibConcentrationPct: 0 }
  );

  assert.equal(allocation.valueTwd, 80);
  assert.equal(allocation.pct, null);
  assert.equal(allocation.frozen, false);
});

test('個股研究模型｜研究狀態只採使用者 enum，不因低分或虧損自動變破壞', () => {
  assert.deepEqual(researchStatusOf('needs-review'), {
    value: 'needs-review',
    label: '待重新檢查'
  });
  assert.deepEqual(researchStatusOf('toString'), {
    value: 'unreviewed',
    label: '尚未評估'
  });

  const model = buildStockResearchModel({
    symbol: 'AAPL',
    rows: [{ symbol: 'AAPL', layer: 'stock', quantity: 1, valueTwd: 1, pnlTwd: -999 }],
    research: [{
      symbol: 'AAPL',
      status: 'watching',
      scorecard: {
        business: 0,
        financial: 0,
        valuation: 0,
        evidence: 0,
        risk: 0
      }
    }],
    netWorth: 1000
  });

  assert.equal(model.status.value, 'watching');
  assert.equal(model.status.label, '觀察中');
});

test('個股研究模型｜情境估值固定用 valuationScenarios，不暴露歧義 valuation', () => {
  const scenarios = { currency: 'USD', bear: 100, base: 150, bull: 200 };
  const model = buildStockResearchModel({
    symbol: 'AAPL',
    rows: [],
    research: [{ symbol: 'AAPL', valuationScenarios: scenarios }],
    netWorth: 1000
  });

  assert.equal(model.valuationScenarios, scenarios);
  assert.equal(Object.hasOwn(model, 'valuation'), false);
});

test('個股研究模型｜所有純函式都不修改輸入資料', () => {
  const rows = Object.freeze([
    Object.freeze({ symbol: ' aapl ', layer: 'stock', quantity: 1, valueTwd: 100 })
  ]);
  const research = Object.freeze([
    Object.freeze({ symbol: 'aapl', status: 'valid' })
  ]);
  const settings = Object.freeze({ ibConcentrationPct: 5 });
  const before = JSON.stringify({ rows, research, settings });

  const model = buildStockResearchModel({
    symbol: 'AAPL',
    rows,
    research,
    netWorth: 1000,
    settings
  });

  assert.equal(model.symbol, 'AAPL');
  assert.equal(JSON.stringify({ rows, research, settings }), before);
});

test('個股研究模型｜availability 的四種資料組合都有固定結果', () => {
  assert.equal(stockResearchAvailability(true, true).state, 'ready');
  assert.equal(stockResearchAvailability(true, false).state, 'missing-research');
  assert.equal(stockResearchAvailability(false, true).state, 'not-held');
  assert.equal(stockResearchAvailability(false, false).state, 'empty');
});
