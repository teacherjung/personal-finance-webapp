// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CARD_LAYOUT,
  MONTHLY_FOREST_DATA,
  atmosphereForChange,
  moveGridSelection,
  moveCard,
  netWorthChangeAt,
  normalizeCardLayout
} from './forest-ui-model.js';

test('五段森林氛圍使用固定淨資產變動門檻', () => {
  assert.equal(atmosphereForChange(2), 'vibrant');
  assert.equal(atmosphereForChange(.5), 'positive');
  assert.equal(atmosphereForChange(.49), 'neutral');
  assert.equal(atmosphereForChange(-.5), 'negative');
  assert.equal(atmosphereForChange(-2), 'storm');
});

test('本月淨資產變動以目前月減上月底，不冒充投資報酬', () => {
  const latest = netWorthChangeAt(MONTHLY_FOREST_DATA, MONTHLY_FOREST_DATA.length - 1);
  assert.deepEqual(latest && { amount: latest.amount, pct: Number(latest.pct?.toFixed(6)) }, {
    amount: 29,
    pct: 2.378999
  });
  assert.equal(latest?.reason, 'comparable');
  assert.equal(netWorthChangeAt(MONTHLY_FOREST_DATA, 0), null);
});

test('上月底淨資產為零時保留金額變動，但不補成 0% 或冒充首筆資料', () => {
  assert.deepEqual(netWorthChangeAt([{ netWorth: 0 }, { netWorth: 50 }], 1), {
    amount: 50,
    pct: null,
    reason: 'zero-base'
  });
});

test('版面保存只接受已知卡片與合法尺寸，缺卡補回預設', () => {
  const poisoned = JSON.parse('[{"id":"guide","size":"wide"},{"id":"guide","size":"compact"},{"id":"__proto__","size":"full"},{"id":"cashflow","size":"gigantic"}]');
  assert.deepEqual(normalizeCardLayout(poisoned), [
    { id: 'guide', size: 'wide' },
    { id: 'cashflow', size: 'wide' },
    { id: 'summary', size: 'full' },
    { id: 'holdings', size: 'full' },
    { id: 'valuation', size: 'full' }
  ]);
  assert.equal((/** @type {any} */ (Object.prototype)).polluted, undefined);
});

test('鍵盤移動卡片只調整一格，邊界不越界', () => {
  const moved = moveCard([...DEFAULT_CARD_LAYOUT], 'guide', -1);
  assert.deepEqual(moved.map((item) => item.id), ['summary', 'guide', 'cashflow', 'holdings', 'valuation']);
  assert.deepEqual(moveCard(moved, 'summary', -1), moved);
});

test('月份格線鍵盤移動依實際欄數前後或上下移動，邊界不越界', () => {
  assert.equal(moveGridSelection(5, 'ArrowLeft', 12, 4), 4);
  assert.equal(moveGridSelection(5, 'ArrowRight', 12, 4), 6);
  assert.equal(moveGridSelection(5, 'ArrowUp', 12, 4), 1);
  assert.equal(moveGridSelection(5, 'ArrowDown', 12, 4), 9);
  assert.equal(moveGridSelection(10, 'ArrowDown', 12, 3), 11);
  assert.equal(moveGridSelection(0, 'ArrowUp', 12, 3), 0);
  assert.equal(moveGridSelection(11, 'ArrowRight', 12, 4), 11);
  assert.equal(moveGridSelection(7, 'Home', 12, 4), 0);
  assert.equal(moveGridSelection(2, 'End', 12, 4), 11);
});
