import { test } from 'node:test';
import assert from 'node:assert/strict';
import { investmentChartConfig } from '../public/modules/portfolio-chart.js';
import { AXIS, GRID, ACCENT, ACCENT_SOFT } from '../public/modules/theme.js';

const formatK = value => `K(${value})`;
const formatWan = value => `W(${value})`;
const snapshots = [
  { month: '2026-05', cost: 12345.6, value: 23456.7 },
  { month: '2026-06', cost: 20000.4, value: 30000.8 }
];

test('投入折線圖｜台幣資料四捨五入並保留目前月份', () => {
  const config = investmentChartConfig(snapshots, 40000.5, 50000.5, {
    viewCurrency: 'TWD', usdRate: 32, formatK, formatWan
  });
  assert.deepEqual(config.data.labels, ['2026-05', '2026-06', '本月（現在）']);
  assert.deepEqual(config.data.datasets[0].data, [12346, 20000, 40001]);
  assert.deepEqual(config.data.datasets[1].data, [23457, 30001, 50001]);
  assert.equal(config.options.scales.y.ticks.callback(20000), '2 萬');
  assert.equal(config.options.plugins.tooltip.callbacks.label({ dataset: { label: '市值' }, parsed: { y: 50001 } }), ' 市值: W(50001) 萬');
});

test('投入折線圖｜美元計價先除匯率，再使用 K USD 提示', () => {
  const config = investmentChartConfig([{ month: '2026-06', cost: 32000, value: 40000 }], 64000, 80000, {
    viewCurrency: 'USD', usdRate: 32, formatK, formatWan
  });
  assert.deepEqual(config.data.datasets[0].data, [1000, 2000]);
  assert.deepEqual(config.data.datasets[1].data, [1250, 2500]);
  assert.equal(config.options.scales.y.ticks.callback(2000), '2 K');
  assert.equal(config.options.plugins.tooltip.callbacks.label({ dataset: { label: '投入成本' }, parsed: { y: 2000 } }), ' 投入成本: K(2000) K USD');
});

test('投入折線圖｜沒有歷史快照時仍保留本月成本與市值', () => {
  const config = investmentChartConfig([], 100, 120, {
    viewCurrency: 'TWD', usdRate: 32, formatK, formatWan
  });
  assert.deepEqual(config.data.labels, ['本月（現在）']);
  assert.deepEqual(config.data.datasets[0].data, [100]);
  assert.deepEqual(config.data.datasets[1].data, [120]);
});

test('投入折線圖｜兩條線、圖例、格線與填色沿用共同色票', () => {
  const config = investmentChartConfig([], 0, 0, {
    viewCurrency: 'TWD', usdRate: 32, formatK, formatWan
  });
  assert.equal(config.type, 'line');
  assert.deepEqual(config.data.datasets[0].borderDash, [5, 4]);
  assert.equal(config.data.datasets[0].borderColor, AXIS);
  assert.equal(config.data.datasets[1].borderColor, ACCENT);
  assert.equal(config.data.datasets[1].backgroundColor, ACCENT_SOFT);
  assert.equal(config.options.plugins.legend.labels.color, AXIS);
  assert.equal(config.options.scales.x.grid.color, GRID);
  assert.equal(config.options.scales.y.grid.color, GRID);
});
