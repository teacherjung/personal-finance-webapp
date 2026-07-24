// securityTrades 財務契約考題（Codex S3r2#4）：備份/寫入牆不能收「沒有錢的交易」或「欄欄合法、
// 合起來說謊」的列——①三個核心金額（price/grossAmount/netSettlement）必填 ②跨欄不變式 buy→out、sell→in。
// 兩道門都驗：櫃檯 sanitizeDbForWrite（throw 炸出／strip 整筆濾除）＋匯入逐筆 validateImportItem（收集錯誤→整份 400）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDbForWrite, validateImportItem } from '../lib/schema.js';

/** 合法完整列（合成資料）。 @param {object} over */
const row = (over = {}) => ({
  id: 'x1', tradeDate: '2026-06-15', sourceRef: 'ts|fp|k1', source: 'taishin', symbol: '2330',
  side: 'buy', quantity: 1000, cashDirection: 'out', currency: 'TWD',
  price: 900, grossAmount: 900000, netSettlement: 901281, ...over,
});
const dbWith = (/** @type {any} */ r) => ({ settings: {}, securityTrades: [r] });
const drop = (/** @type {any} */ r, /** @type {string} */ k) => { const o = { ...r }; delete o[k]; return o; };

test('櫃檯｜合法列（buy→out 與 sell→in）原樣通過', () => {
  for (const r of [row(), row({ side: 'sell', cashDirection: 'in', sourceRef: 'ts|fp|k2' })]) {
    const out = sanitizeDbForWrite(dbWith(r), { mode: 'throw' });
    assert.equal(out.securityTrades.length, 1);
  }
});

test('櫃檯｜缺任一核心金額：throw 模式炸出、strip 模式整筆濾除（不會變成 0 元交易）', () => {
  for (const k of ['price', 'grossAmount', 'netSettlement']) {
    const bad = drop(row(), k);
    assert.throws(() => sanitizeDbForWrite(dbWith(bad), { mode: 'throw' }), new RegExp(k));
    const out = sanitizeDbForWrite(dbWith(bad), { mode: 'strip' });
    assert.equal(out.securityTrades.length, 0, `${k} 缺席的列不可留下`);
  }
});

test('櫃檯｜跨欄不變式：buy＋in／sell＋out 整列擋下（會把買進顯示成收錢）', () => {
  for (const bad of [row({ cashDirection: 'in' }), row({ side: 'sell', cashDirection: 'out' })]) {
    assert.throws(() => sanitizeDbForWrite(dbWith(bad), { mode: 'throw' }), /現金方向/);
    const out = sanitizeDbForWrite(dbWith(bad), { mode: 'strip' });
    assert.equal(out.securityTrades.length, 0);
  }
});

test('匯入逐筆｜缺核心金額與方向矛盾都收進 errors（路由收集後整份 400，不靜默剝欄回成功）', () => {
  assert.deepEqual(validateImportItem('securityTrades', row()).errors, []);
  const miss = validateImportItem('securityTrades', drop(row(), 'netSettlement'));
  assert.ok(miss.errors.some(e => e.includes('netSettlement')), '缺應收付要點名');
  const flip = validateImportItem('securityTrades', row({ cashDirection: 'in' }));
  assert.ok(flip.errors.some(e => e.includes('現金方向')), '買進配收錢要點名');
});

test('匯入逐筆｜其他集合不受新不變式波及（transactions 照舊）', () => {
  const { errors } = validateImportItem('transactions', { date: '2026-06-01', amount: 100, category: '其他' });
  assert.deepEqual(errors, []);
});
