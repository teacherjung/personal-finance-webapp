import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatK, formatPercent, formatPortfolioMoney, formatWan } from '../public/modules/portfolio-format.js';

test('投資格式｜K 小於十保留一位，十以上取整並加千分位', () => {
  assert.equal(formatK(2_400), '2.4');
  assert.equal(formatK(12_500), '13');
  assert.equal(formatK(1_234_000), '1,234');
});

test('投資格式｜萬小於十保留一位，十以上取整', () => {
  assert.equal(formatWan(65_000), '6.5');
  assert.equal(formatWan(105_000), '11');
  assert.equal(formatWan(-24_000), '-2.4');
});

test('投資格式｜百分比保留指定小數，空值與非數字退回零', () => {
  assert.equal(formatPercent(12.345), '12.3%');
  assert.equal(formatPercent(12.345, 2), '12.35%');
  assert.equal(formatPercent('bad'), '0.0%');
});

test('投資格式｜台幣檢視用萬，負號固定使用全站 U+2212', () => {
  assert.equal(formatPortfolioMoney(65_000, { viewCurrency: 'TWD', usdRate: 32 }), '6.5 萬');
  assert.equal(formatPortfolioMoney(-120_000, { viewCurrency: 'TWD', usdRate: 32 }), '−12 萬');
  assert.equal(formatPortfolioMoney(null, { viewCurrency: 'TWD', usdRate: 32 }), '0.0 萬');
});

test('投資格式｜美元檢視先依匯率換算，再用 K USD', () => {
  assert.equal(formatPortfolioMoney(80_000, { viewCurrency: 'USD', usdRate: 32 }), '2.5 K USD');
  assert.equal(formatPortfolioMoney(-640_000, { viewCurrency: 'USD', usdRate: 32 }), '−20 K USD');
});
