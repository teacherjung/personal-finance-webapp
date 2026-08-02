// 「錢的大腦」的自動考試：淨資產、訂閱計算、槓桿，以及修過的兩個 bug（回歸保護）。
// 跑法：npm test（Node 內建測試工具，零相依）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monthKey, computeAssets, computeCashflowHistory, computeIb, computeLeverage, buildSummary } from '../lib/derive.js';

test('monthKey：日期字串取到正確月份（不受時區影響）', () => {
  assert.equal(monthKey('2026-07-15'), '2026-07');
  assert.equal(monthKey('2026-12-31'), '2026-12');
  assert.equal(monthKey('2026-01-01'), '2026-01');   // 修過的時區 bug：不會變成前一個月
});

test('computeAssets：淨資產＝資產−負債', () => {
  const db = {
    settings: { usdTwd: 32 },
    accounts: [
      { id: 'a', type: 'cash', class: '現金', currency: 'TWD', balance: 1000 },
      { id: 'b', type: 'loan', currency: 'TWD', balance: -300 },
    ],
    holdings: [],
  };
  const r = computeAssets(db);
  assert.equal(r.assets, 1000);
  assert.equal(r.liabilities, 300);
  assert.equal(r.netWorth, 700);
});

test('總覽 12 月現金流：沿用現金流帳本口徑，記帳前不補零、開始後的空月保留', () => {
  const db = /** @type {any} */ ({ transactions: [
    { date: '2025-06-01', type: 'income', amount: 999 },
    { date: '2026-03-01', type: 'income', amount: 100 },
    { date: '2026-03-02', type: 'expense', amount: 40 },
    { date: '2026-04-01', type: 'expense', amount: 999, ledger: 'card' },
    { date: '2026-05-01', type: 'transfer', amount: 500 },
    { date: '2026-06-01', type: 'expense', amount: 30 },
    { date: '2026-13-01', type: 'income', amount: 999 },
  ] });
  assert.deepEqual(computeCashflowHistory(db, '2026-06', 6), [
    { month: '2026-03', income: 100, expense: 40, net: 60 },
    { month: '2026-04', income: 0, expense: 0, net: 0 },
    { month: '2026-05', income: 0, expense: 0, net: 0 },
    { month: '2026-06', income: 0, expense: 30, net: -30 },
  ]);
});

test('總覽 12 月現金流：視窗內沒有有效銀行收支時回空序列', () => {
  const db = /** @type {any} */ ({ transactions: [
    { date: '2026-06-01', type: 'expense', amount: 200, ledger: 'card' },
    { date: '2026-06-02', type: 'transfer', amount: 300 },
  ] });
  assert.deepEqual(computeCashflowHistory(db, '2026-06'), []);
});

test('總覽 12 月現金流：最後一筆記帳後維持無資料，不用 0 冒充確定零收支', () => {
  const db = /** @type {any} */ ({ transactions: [
    { date: '2026-03-01', type: 'income', amount: 100 },
    { date: '2026-04-01', type: 'expense', amount: 40 },
  ] });
  assert.deepEqual(computeCashflowHistory(db, '2026-06', 6), [
    { month: '2026-03', income: 100, expense: 0, net: 100 },
    { month: '2026-04', income: 0, expense: 40, net: -40 },
  ]);
});

test('訂閱項數：已停用的不算（總覽與訂閱頁同口徑）', () => {
  const db = {
    settings: { usdTwd: 32 },
    accounts: [], holdings: [], transactions: [],
    subscriptions: [
      { id: 's1', name: '使用中', amount: 100, cycle: 'monthly' },                                  // 無停用日→算
      { id: 's2', name: '已停用', amount: 200, cycle: 'monthly', status: 'ending', active: true, endsOn: '2020-01-01' }, // 停用日已過→不算
    ],
  };
  assert.equal(buildSummary(db).subscriptions.count, 1);
});

test('緊急預備金：已停用訂閱不該灌進去（Codex #39 修正）', () => {
  const db = {
    settings: { usdTwd: 32, emergencyFundMonths: 6 },
    accounts: [{ id: 'c', type: 'cash', class: '現金', currency: 'TWD', balance: 3000 }],
    holdings: [], transactions: [],
    subscriptions: [
      { id: 's', name: '已停用月繳', amount: 1000, cycle: 'monthly', status: 'ending', active: true, endsOn: '2020-01-01' },
    ],
  };
  const reminders = buildSummary(db).reminders;
  // 修前：已停用訂閱被當成每月 1000 → 3000/1000=3 個月<6 → 誤報「緊急預備金不足」
  assert.ok(!reminders.some(r => /緊急預備金/.test(r.title)), '不應誤報緊急預備金不足');
});

test('訂閱提醒：status ended（旗標未寫回）不該再跳續費提醒（Codex 第三輪 #4）', () => {
  const d = new Date(); d.setDate(d.getDate() + 3);   // 三天後（在 7 天提醒窗內）
  const soon = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const db = {
    settings: { usdTwd: 32 },
    accounts: [], holdings: [], transactions: [],
    subscriptions: [{ id: 's', name: '已停用但旗標未寫回', amount: 100, cycle: 'monthly', status: 'ended', active: true, nextCharge: soon }],
  };
  const reminders = buildSummary(db).reminders;
  assert.ok(!reminders.some(r => /續費/.test(r.title)), '已停用訂閱不應出現續費提醒');
});

test('computeLeverage：用 IB 官方淨值算融資槓桿', () => {
  const db = { settings: { usdTwd: 32, ib: { lastEquity: { stock: 100, cash: -50 } } }, holdings: [], accounts: [] };
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.leverage, 2);       // 持倉 100 ÷ 淨值(100−50)=50 → 2 倍
  assert.equal(lev.loan, 1600);        // 借款 50 × 匯率 32
  assert.equal(lev.hasLoan, true);
});

test('buildSummary：用 seed 範例資料能正常算出總覽（結構檢查）', () => {
  const db = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8'));
  const s = buildSummary(db);
  assert.equal(typeof s.netWorth, 'number');
  assert.ok(s.netWorth > 0);
  assert.equal(typeof s.subscriptions.count, 'number');
  assert.ok(Array.isArray(s.reminders));
  assert.ok(Array.isArray(s.snapshots));
  assert.ok(Array.isArray(s.cashflowHistory));
});

test('自主體檢｜淨值歸零：summary 不輸出 Infinity（equityWiped 旗標）、提醒不印 Infinityx', async () => {
  const { buildSummary } = await import('../lib/derive.js');
  const db = /** @type {any} */ ({ settings: { usdTwd: 32, ib: { lastEquity: { stock: 100000, cash: -150000 } } },
    holdings: [{ id: 'h1', symbol: 'CSPX', currency: 'USD', quantity: 1, price: 100, source: 'ib' }] });
  const s = buildSummary(db);
  assert.equal(s.ib.leverage, null, 'Infinity 不可流進 JSON（會變 null 被前端當 0.00x）');
  assert.equal(s.ib.equityWiped, true, '要給前端明確訊號');
  const t = s.reminders.find(r => r.title.includes('淨值已為負'));
  assert.ok(t, '要有危險級提醒');
  assert.equal(t.level, 'danger');
  assert.ok(!s.reminders.some(r => r.title.includes('Infinity')), '不可出現 Infinityx 字樣');
});
