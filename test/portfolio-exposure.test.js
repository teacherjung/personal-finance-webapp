import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compOf, regionExposure, companyExposure, companyRegionOf } from '../public/modules/portfolio-exposure.js';

test('投資曝險｜已知代號走成分表，未知代號依 layer 退回', () => {
  assert.deepEqual(compOf({ symbol: 'eimi', layer: 'core' }), {
    type: 'equity',
    regions: { 中國: 0.25, 印度: 0.22, 台灣: 0.19, 韓國: 0.09, 其他: 0.25 }
  });
  assert.deepEqual(compOf({ symbol: 'UNKNOWN', layer: 'bond' }), { type: 'bond', regions: { 其他: 1 } });
  assert.deepEqual(compOf({ symbol: 'UNKNOWN', layer: 'gold' }), { type: 'gold', regions: { 其他: 1 } });
  assert.deepEqual(compOf({ symbol: 'UNKNOWN', layer: 'satellite' }), { type: 'equity', regions: { 其他: 1 } });
});

test('投資曝險｜區域穿透依 ETF 權重加總並排除債券與黃金', () => {
  assert.deepEqual(regionExposure([
    { symbol: 'CSPX', layer: 'core', valueTwd: 1_000 },
    { symbol: 'EIMI', layer: 'satellite', valueTwd: 1_000 },
    { symbol: '00719B', layer: 'bond', valueTwd: 5_000 },
    { symbol: 'IAU', layer: 'gold', valueTwd: 5_000 }
  ]), {
    美國: 1_000,
    中國: 250,
    印度: 220,
    台灣: 190,
    韓國: 90,
    其他: 250
  });
});

test('投資曝險｜公司穿透合併直接持股與 ETF 來源並維持排行', () => {
  const { top, coveredValue } = companyExposure([
    { symbol: 'AAPL', layer: 'stock', valueTwd: 100 },
    { symbol: 'CSPX', layer: 'core', valueTwd: 1_000 },
    { symbol: 'IAU', layer: 'gold', valueTwd: 9_999 },
    { symbol: 'XUSE', layer: 'satellite', valueTwd: 9_999 },
    { symbol: 'QQQM', layer: 'core', valueTwd: -500 }
  ], 3);

  assert.deepEqual(top, [
    ['蘋果', { v: 165, src: { AAPL: 100, CSPX: 65 } }],
    ['輝達', { v: 75, src: { CSPX: 75 } }],
    ['微軟', { v: 65, src: { CSPX: 65 } }]
  ]);
  assert.equal(coveredValue, 305);
});

test('投資曝險｜公司所屬區域維持既有顏色查表依據', () => {
  assert.equal(companyRegionOf('蘋果'), '美國');
  assert.equal(companyRegionOf('台積電'), '台灣');
  assert.equal(companyRegionOf('不存在公司'), undefined);
});
