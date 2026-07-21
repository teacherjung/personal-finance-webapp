// 估值訊號檔位單一真相（D3 抽出，前後端共用）——門檻鎖在這裡（改門檻＝改一處，這些考題跟著動）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionTier, taiwanTier, ecyOf, computeSignalTiers, TIER_LABELS, US_RATIO } from '../public/modules/signal-tiers.js';

test('regionTier｜美股 ECY：<3 常態(0)、3–5 加碼(1)、>5 重壓(2)', () => {
  assert.equal(regionTier('us', 2.9), 0);
  assert.equal(regionTier('us', 3), 1);
  assert.equal(regionTier('us', 5), 1);
  assert.equal(regionTier('us', 5.01), 2);
  assert.equal(regionTier('us', null), null);
  assert.equal(regionTier('us', ''), null);
});

test('regionTier｜中股 PE / 日股 P/B / 韓股 P/B 門檻', () => {
  assert.equal(regionTier('china', 13), 0);
  assert.equal(regionTier('china', 11.5), 1);
  assert.equal(regionTier('china', 9.9), 2);
  assert.equal(regionTier('japan', 1.25), 0);
  assert.equal(regionTier('japan', 1.2), 1);
  assert.equal(regionTier('japan', 0.99), 2);
  assert.equal(regionTier('korea', 0.95), 0);
  assert.equal(regionTier('korea', 0.85), 1);
  assert.equal(regionTier('korea', 0.79), 2);
});

test('taiwanTier｜PE／殖利率任一達標即算；都沒有→null', () => {
  assert.equal(taiwanTier('', ''), null);
  assert.equal(taiwanTier(17, ''), 0);
  assert.equal(taiwanTier(12.9, ''), 1);      // PE<13
  assert.equal(taiwanTier(10.9, ''), 2);      // PE<11
  assert.equal(taiwanTier('', 4.6), 1);       // 殖利率>4.5
  assert.equal(taiwanTier('', 5.6), 2);       // 殖利率>5.5
});

test('ecyOf｜1/CAPE−實質利率（%）；缺任一或 CAPE≤0→null', () => {
  assert.equal(ecyOf(20, 1), 4);              // 100/20 − 1 = 4
  assert.equal(ecyOf(25, 0), 4);              // 100/25 − 0 = 4
  assert.equal(ecyOf(null, 1), null);
  assert.equal(ecyOf(20, null), null);
  assert.equal(ecyOf(20, ''), null);
  assert.equal(ecyOf(0, 1), null);
});

test('computeSignalTiers｜五市場物件；ecy=null→us=null', () => {
  const t = computeSignalTiers({ signals: { china: 11, japan: 1.25, korea: 0.85, taiwanPE: 12 }, ecy: 4 });
  assert.deepEqual(t, { us: 1, china: 1, japan: 0, korea: 1, taiwan: 1 });
  assert.equal(computeSignalTiers({ signals: {}, ecy: null }).us, null);
});

test('常數｜TIER_LABELS 與 US_RATIO 三檔對齊', () => {
  assert.deepEqual(TIER_LABELS, ['常態', '加碼', '重壓']);
  assert.deepEqual(US_RATIO, ['70 : 30', '80 : 20', '90 : 10']);
});
