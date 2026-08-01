// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTHLY_FOREST_DATA,
  netWorthChangeAt,
  netWorthTrendFor
} from './forest-ui-model.js';

test('月份基準資料的陣列與每筆內容都不可被意外改寫', () => {
  assert.equal(Object.isFrozen(MONTHLY_FOREST_DATA), true);
  assert.equal(MONTHLY_FOREST_DATA.every(month => Object.isFrozen(month)), true);
  assert.equal(Reflect.set(MONTHLY_FOREST_DATA[0], 'netWorth', 0), false);
  assert.equal(MONTHLY_FOREST_DATA[0].netWorth, 1090);
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

test('近十二個月淨資產趨勢以首尾月份比較', () => {
  const trend = netWorthTrendFor(MONTHLY_FOREST_DATA);
  assert.deepEqual(trend && { ...trend, pct: Number(trend.pct?.toFixed(6)) }, {
    first: 1090,
    last: 1248,
    amount: 158,
    pct: 14.495413
  });
});

test('淨資產趨勢沒有資料或起點為零時不捏造百分比', () => {
  assert.equal(netWorthTrendFor([]), null);
  assert.deepEqual(netWorthTrendFor([{ netWorth: 0 }, { netWorth: 50 }]), {
    first: 0,
    last: 50,
    amount: 50,
    pct: null
  });
});
