// 再平衡計算器（3-13）考題：純計算模組，直接從 node 測。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebalancePlan } from '../public/modules/rebalance.js';

const ROWS = [
  { class: '股票', value: 700_000, targetPct: 60 },
  { class: '債券', value: 100_000, targetPct: 20 },
  { class: '現金', value: 200_000, targetPct: 20 },
];

test('允許買賣：買賣互抵加總為 0、恢復目標比例', () => {
  const p = rebalancePlan(ROWS, { buyOnly: false });
  const sum = p.rows.reduce((s, r) => s + r.delta, 0);
  assert.ok(Math.abs(sum) <= 2, `買賣加總應為 0（容許進位誤差），得 ${sum}`);
  const stock = p.rows.find(r => r.class === '股票');
  assert.equal(stock.delta, -100_000, '股票 70%→60%：總資產 100 萬 × 60% = 60 萬，應賣 10 萬');
  const bond = p.rows.find(r => r.class === '債券');
  assert.equal(bond.delta, 100_000, '債券 10%→20%：應買 10 萬');
  for (const r of p.rows) assert.ok(Math.abs(r.afterPct - r.targetPctNorm) < 0.01, `${r.class} 調整後應正好在目標`);
});

test('只買不賣：錢不夠補滿缺口 → 依缺口比例分配、加總＝新資金、絕不出現賣出', () => {
  const p = rebalancePlan(ROWS, { buyOnly: true, cash: 50_000 });
  const sum = p.rows.reduce((s, r) => s + r.delta, 0);
  assert.ok(Math.abs(sum - 50_000) <= 2, `加碼總額應＝新資金 5 萬，得 ${sum}`);
  for (const r of p.rows) assert.ok(r.delta >= 0, `只買不賣不可出現賣出（${r.class}: ${r.delta}）`);
  // 終局總額 105 萬：理想 股63萬(已70萬,缺0)/債21萬(缺11萬)/現金21萬(缺1萬)→ 5萬依 11:1 分
  const bond = p.rows.find(r => r.class === '債券');
  const stock = p.rows.find(r => r.class === '股票');
  assert.equal(stock.delta, 0, '已超配的股票不應再加碼');
  assert.ok(bond.delta > 40_000, '缺口最大的債券應拿走大部分新資金');
});

test('只買不賣：錢超過缺口 → 補滿缺口後剩餘依目標比例續投（維持比例）', () => {
  const p = rebalancePlan(ROWS, { buyOnly: true, cash: 1_000_000 });
  const sum = p.rows.reduce((s, r) => s + r.delta, 0);
  assert.ok(Math.abs(sum - 1_000_000) <= 2, '加碼總額＝新資金');
  for (const r of p.rows) {
    assert.ok(r.delta >= 0);
    assert.ok(Math.abs(r.afterPct - r.targetPctNorm) < 0.01, `錢夠時終局應正好在目標（${r.class}）`);
  }
});

test('目標％加總非 100 → 自動正規化', () => {
  const p = rebalancePlan([
    { class: 'A', value: 100, targetPct: 3 },   // 3:1 → 75%/25%
    { class: 'B', value: 100, targetPct: 1 },
  ], { buyOnly: false });
  assert.equal(p.rows[0].targetPctNorm, 75);
  assert.equal(p.rows[1].targetPctNorm, 25);
  assert.equal(p.rows[0].delta, 50);    // 總 200 × 75% = 150
  assert.equal(p.rows[1].delta, -50);
});

test('未設目標的類別不參與（不會被當成目標 0％＝全賣），列入 excluded', () => {
  const p = rebalancePlan([...ROWS, { class: '其他', value: 50_000, targetPct: 0 }], { buyOnly: false });
  assert.ok(!p.rows.some(r => r.class === '其他'), '未設目標不應出現在計畫中');
  assert.deepEqual(p.excluded, ['其他']);
});

test('邊角：沒有目標/沒有新資金/壞輸入都不會爆', () => {
  assert.deepEqual(rebalancePlan([], {}).rows, []);
  assert.deepEqual(rebalancePlan([{ class: 'A', value: 100, targetPct: 0 }], {}).rows, []);
  const zero = rebalancePlan(ROWS, { buyOnly: true, cash: 0 });
  assert.ok(zero.rows.every(r => r.delta === 0), '新資金 0 → 全部不動');
  const bad = rebalancePlan(ROWS, { buyOnly: true, cash: /** @type {any} */ ('oops') });
  assert.ok(bad.rows.every(r => r.delta === 0), '壞的 cash 當 0 處理');
  const neg = rebalancePlan(ROWS, { buyOnly: true, cash: -500 });
  assert.ok(neg.rows.every(r => r.delta === 0), '負的 cash 當 0 處理');
});

test('現有配置正好在目標上 → 允許買賣模式全部「不動」', () => {
  const p = rebalancePlan([
    { class: '股票', value: 600, targetPct: 60 },
    { class: '債券', value: 400, targetPct: 40 },
  ], { buyOnly: false });
  assert.ok(p.rows.every(r => r.delta === 0));
});
