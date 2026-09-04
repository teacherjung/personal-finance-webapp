import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compOf, regionExposure, companyExposure, companyRegionOf, fxExposure } from '../public/modules/portfolio-exposure.js';

test('投資曝險｜已知代號走成分表，未知代號依 layer 退回', () => {
  assert.deepEqual(compOf({ symbol: ' eimi ', layer: 'core' }), {
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

test('投資曝險｜幣別曝險維持美債 ETF、黃金與缺省幣別口徑', () => {
  assert.deepEqual(fxExposure([
    { symbol: 'CSPX', layer: 'core', currency: 'USD', valueTwd: 1_000 },
    { symbol: '00719B', layer: 'bond', currency: 'TWD', valueTwd: 2_000 },
    { symbol: 'IAU', layer: 'gold', currency: 'USD', valueTwd: 3_000 },
    { symbol: 'UNKNOWN', layer: 'satellite', valueTwd: 4_000 }
  ], [], { TWD: 1, USD: 32 }), {
    USD: { stockTwd: 1_000, bondTwd: 2_000, goldTwd: 0, cashTwd: 0, netTwd: 3_000 },
    黃金: { stockTwd: 0, bondTwd: 0, goldTwd: 3_000, cashTwd: 0, netTwd: 3_000 },
    TWD: { stockTwd: 4_000, bondTwd: 0, goldTwd: 0, cashTwd: 0, netTwd: 4_000 }
  });
});

test('投資曝險｜現金依匯率換算且正數負債反向計入', () => {
  assert.deepEqual(fxExposure([], [
    { type: 'cash', currency: 'TWD', balance: 100 },
    { type: 'mortgage', currency: 'TWD', balance: 500 },
    { type: 'cash', currency: 'GBP', balance: 10 },
    { type: 'loan', currency: 'USD', balance: -20 },
    { type: 'cash', balance: 50 },
    { type: 'cash', currency: 'JPY', balance: 0 }
  ], { TWD: 1, USD: 32, GBP: 40 }), {
    TWD: { stockTwd: 0, bondTwd: 0, goldTwd: 0, cashTwd: -350, netTwd: -350 },
    GBP: { stockTwd: 0, bondTwd: 0, goldTwd: 0, cashTwd: 400, netTwd: 400 },
    USD: { stockTwd: 0, bondTwd: 0, goldTwd: 0, cashTwd: -640, netTwd: -640 }
  });
});

test('丙｜fxExposure：表上有的幣別（含預設值）照算；表上沒有的幣別（EUR）不計入、不可當台幣', async () => {
  const { fxExposure: fxExp } = await import('../public/modules/portfolio-exposure.js');
  const accounts = /** @type {any} */ ([
    { id: 'g', type: 'cash', currency: 'GBP', balance: 100 },
    { id: 'e', type: 'cash', currency: 'EUR', balance: 50 },
    { id: 't', type: 'cash', currency: 'TWD', balance: 7 },
  ]);
  const ex = fxExp([], accounts, /** @type {any} */ ({ TWD: 1, USD: 32, GBP: 40.8, JPY: 0.215 }));
  assert.equal(ex.GBP.cashTwd, 100 * 40.8, 'GBP 用表上的值（預設值也在表上）');
  assert.equal(ex.EUR?.cashTwd ?? 0, 0, '表上沒有的 EUR 不可算進去（以前 `|| 1` 會當台幣）');
  assert.equal(ex.TWD.cashTwd, 7);
});
