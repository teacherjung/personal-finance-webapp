// 「錢的大腦」深度考題：每一條總覽提醒規則、槓桿/斷頭距離邊角、多幣別資產、投組權重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, computeAssets, computeIb, computeLeverage } from '../lib/derive.js';

const base = { settings: { usdTwd: 32, emergencyFundMonths: 6, allocationDriftPct: 5 }, accounts: [], holdings: [], transactions: [], subscriptions: [] };
const remind = (over) => buildSummary({ ...base, ...over, settings: { ...base.settings, ...(over.settings || {}) } }).reminders;
const hasTitle = (over, re) => remind(over).some(r => re.test(r.title));

test('提醒｜本月現金流為負', () => {
  assert.ok(hasTitle({ transactions: [{ date: '2026-07-05', type: 'expense', amount: 1000 }, { date: '2026-07-06', type: 'income', amount: 100 }] }, /現金流為負/));
});

test('提醒｜緊急預備金不足（現金撐不到目標月數）', () => {
  assert.ok(hasTitle({
    accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 1000 }],
    transactions: [{ date: '2026-06-05', type: 'expense', amount: 2000 }],
  }, /緊急預備金不足/));
});

test('提醒｜單一個股超過上限（凍結加碼）', () => {
  const db = { settings: { usdTwd: 1, ibConcentrationPct: 5 }, accounts: [], holdings: [{ id: 'h', symbol: 'TSLA', layer: 'stock', currency: 'TWD', quantity: 1, price: 100, source: 'ib' }], transactions: [], subscriptions: [] };
  assert.ok(buildSummary(db).reminders.some(r => /TSLA.*個股上限/.test(r.title)));
});

test('提醒｜IB 融資槓桿超上限', () => {
  const db = { settings: { usdTwd: 1, ib: { lastEquity: { stock: 100, cash: -60 } }, levCapPct: 1.3, ibMaintenancePct: 25 }, accounts: [], holdings: [], transactions: [], subscriptions: [] };
  assert.ok(buildSummary(db).reminders.some(r => /融資槓桿.*超過上限/.test(r.title)));
});

test('提醒｜匯率進入分批區（高/低各一）', () => {
  assert.ok(hasTitle({ settings: { usdTwd: 33, fxHigh: 32, fxLow: 28 } }, /美元\/台幣.*已達/));
  assert.ok(hasTitle({ settings: { usdTwd: 27, fxHigh: 32, fxLow: 28 } }, /美元\/台幣.*已低於/));
});

test('提醒｜正常狀態（現金充足、無投資、平衡）→ 不亂報', () => {
  const rs = remind({ accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 5_000_000 }] });
  assert.ok(!rs.some(r => /緊急預備金|現金流為負|槓桿/.test(r.title)), '不該有緊急/現金流/槓桿提醒');
});

test('computeLeverage｜斷頭距離：借款越多、距離越近', () => {
  const mk = (cash) => computeLeverage({ settings: { usdTwd: 1, ib: { lastEquity: { stock: 100, cash } }, ibMaintenancePct: 25 }, holdings: [], accounts: [] }, { positions: [] });
  const light = mk(-30), heavy = mk(-60);
  assert.ok(heavy.mcDist < light.mcDist, '借更多→斷頭距離更近');
  assert.ok(light.mcDist > 0 && light.mcDist <= 100);
});

test('computeLeverage｜淨值≤0（跌破本金）→ leverage=Infinity、mcDist=0（前端須同步顯示危險）', () => {
  const db = { settings: { usdTwd: 1, ib: { lastEquity: { stock: 100, cash: -150 } }, ibMaintenancePct: 25 }, holdings: [], accounts: [] };
  const lev = computeLeverage(db, { positions: [] });
  assert.equal(lev.leverage, Infinity, '有借款且淨值≤0 不可算成有限值（更不可是 1）');
  assert.equal(lev.hasLoan, true);
  assert.equal(lev.mcDist, 0, '已在強平線上');
});

test('computeLeverage｜無融資時 leverage=1、hasLoan=false', () => {
  const lev = computeLeverage({ settings: { usdTwd: 1, ib: { lastEquity: { stock: 100, cash: 50 } } }, holdings: [], accounts: [] }, { positions: [] });
  assert.equal(lev.leverage, 1);
  assert.equal(lev.hasLoan, false);
  assert.ok(!(lev.loan > 0), '無融資時借款不為正');
});

test('computeLeverage｜無 lastEquity 時自算（source:ib 持倉 ÷ 淨值）', () => {
  const db = {
    settings: { usdTwd: 1, ibMaintenancePct: 25 },
    holdings: [{ symbol: 'CSPX', currency: 'TWD', quantity: 1, price: 100, source: 'ib' }],
    accounts: [{ id: 'x', ibCashCur: 'TWD', currency: 'TWD', balance: -50 }],
  };
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.hasLoan, true);
  assert.equal(lev.loan, 50);
  assert.ok(Math.abs(lev.leverage - 2) < 1e-9, '100 ÷ (100−50) = 2');
});

test('computeIb｜權重加總 100%、依市值排序', () => {
  const ib = computeIb({ settings: { usdTwd: 1 }, holdings: [{ symbol: 'A', currency: 'TWD', quantity: 1, price: 40 }, { symbol: 'B', currency: 'TWD', quantity: 1, price: 60 }] });
  assert.equal(ib.positions[0].symbol, 'B');   // 市值大的在前
  assert.equal(Math.round(ib.positions.reduce((s, p) => s + p.weight, 0)), 100);
});

test('computeAssets｜多幣別換算台幣（USD/GBP）', () => {
  const r = computeAssets({
    settings: { usdTwd: 30, fxTwd: { GBP: 40 } },
    accounts: [
      { id: 'a', type: 'cash', class: '現金', currency: 'USD', balance: 10 },
      { id: 'b', type: 'cash', class: '現金', currency: 'GBP', balance: 10 },
    ],
    holdings: [],
  });
  assert.equal(r.assets, 700);   // 10×30 + 10×40
  assert.equal(r.netWorth, 700);
});

test('computeAssets｜負餘額帳戶算負債', () => {
  const r = computeAssets({ settings: { usdTwd: 32 }, accounts: [{ id: 'a', type: 'cash', class: '現金', currency: 'TWD', balance: 1000 }, { id: 'b', currency: 'TWD', balance: -400 }], holdings: [] });
  assert.equal(r.liabilities, 400);
  assert.equal(r.netWorth, 600);
});

test('自審｜持股缺 currency 預設台幣、不被當美元灌 32 倍', () => {
  const usd = computeAssets({ settings: { usdTwd: 32 }, accounts: [], holdings: [{ symbol: 'CSPX', currency: 'USD', quantity: 1, price: 500 }] });
  assert.equal(usd.assets, 16000, '有標 USD → ×32');
  const noCur = computeAssets({ settings: { usdTwd: 32 }, accounts: [], holdings: [{ symbol: '0050', quantity: 1000, price: 180 }] });
  assert.equal(noCur.assets, 180000, '缺 currency → 台幣（非 5,760,000）');
});

test('自審｜緊急預備金：現金分散在「現金」與「cash」兩種 class 都要算', () => {
  const db = {
    settings: { usdTwd: 32 },
    accounts: [{ type: 'cash', class: '現金', currency: 'TWD', balance: 120000 }, { type: 'cash', currency: 'TWD', balance: 900000 }],
    holdings: [], subscriptions: [], transactions: [{ date: '2026-06-05', type: 'expense', amount: 30000 }],
  };
  assert.ok(!buildSummary(db).reminders.some((x) => /緊急預備金/.test(x.title)), '總現金 102 萬≈34 個月，不該誤報不足');
});

test('自審｜沒有日期的交易不算進當月現金流', () => {
  const db = { settings: { usdTwd: 32 }, accounts: [], holdings: [], subscriptions: [], transactions: [{ type: 'expense', amount: 9999 }] };
  assert.equal(buildSummary(db).cashflow.expense, 0, '缺日期的支出不歸入當月');
});
