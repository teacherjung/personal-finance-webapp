import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioPageState } from '../public/modules/portfolio-state.js';

const parseLocalDate = (value) => {
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(year, month - 1, day);
};

const layers = { core: {}, satellite: {}, stock: {}, bond: {}, gold: {} };

test('投資頁狀態｜分層、QQQM 核心佔比與未知分層退路維持原口徑', () => {
  const state = buildPortfolioPageState({
    rows: [
      { symbol: 'CSPX', layer: 'core', valueTwd: 75 },
      { symbol: 'QQQM', layer: 'core', valueTwd: 25 },
      { symbol: 'qqqm', layer: 'core', valueTwd: 25 },
      { symbol: 'AAPL', layer: 'stock', valueTwd: 60 },
      { symbol: 'OTHER', layer: 'unknown', valueTwd: 10 }
    ],
    regionMap: { 中國: 160 },
    equityValue: 950,
    summary: { netWorth: 1_000 },
    settings: {
      qqqmMaxPct: 28,
      ibConcentrationPct: 5,
      equityCapPct: 90,
      countryCapPct: 15,
      chinaCapPct: 15,
      levCapPct: 1.3,
      ibMaintenancePct: 25
    },
    snapshots: [],
    totalCost: 170,
    totalValue: 195,
    ibTrades: [],
    usdRate: 32,
    parseLocalDate,
    layers
  });

  assert.deepEqual(state.layerValues, { core: 125, stock: 60, satellite: 10 });
  assert.equal(state.qqqmShare, 40);
  assert.equal(state.qqqmMax, 28);
  assert.equal(state.netWorth, 1_000);
  assert.deepEqual(state.caps, { stock: 5, equity: 90, country: 15, china: 15, lev: 1.3, maint: 25 });
  assert.deepEqual([...state.freeze.symbols], ['AAPL']);
  assert.deepEqual([...state.freeze.regions], ['中國']);
  assert.equal(state.freeze.equity, true);
  assert.deepEqual(state.xirr, { ok: false, why: '需先記錄月快照' });
});

test('投資頁狀態｜沒有 CSPX／QQQM 或淨資產時回零且不凍結', () => {
  const state = buildPortfolioPageState({
    rows: [{ symbol: '0050', layer: 'satellite', valueTwd: 100 }],
    regionMap: { 台灣: 100 },
    equityValue: 100,
    summary: {},
    settings: {},
    snapshots: [],
    totalCost: 100,
    totalValue: 100,
    ibTrades: [],
    usdRate: 32,
    parseLocalDate,
    layers
  });

  assert.equal(state.qqqmShare, 0);
  assert.equal(state.qqqmMax, 30);
  assert.equal(state.netWorth, 0);
  assert.deepEqual([...state.freeze.symbols], []);
  assert.deepEqual([...state.freeze.regions], []);
  assert.equal(state.freeze.equity, false);
});

test('投資頁狀態｜XIRR 原樣轉交快照、成本、市值與日期', () => {
  const state = buildPortfolioPageState({
    rows: [],
    regionMap: {},
    equityValue: 0,
    summary: {},
    settings: {},
    snapshots: [{ month: '2025-01', value: 100, cost: 100 }],
    totalCost: 100,
    totalValue: 110,
    ibTrades: [],
    usdRate: 32,
    parseLocalDate,
    layers,
    now: new Date(2026, 0, 31)
  });

  assert.equal(state.xirr.ok, true);
  assert.ok(state.xirr.ok);
  assert.ok(Math.abs(state.xirr.rate - 10.0071811) < 1e-6);
});
