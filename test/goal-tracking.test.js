// 目標追蹤 P1：只用合成資料驗證設定入口、兩種速度與 summary 接線。
// 絕不讀取真實 store.db／store.json。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// store.js 載入時就決定路徑，所以所有 app/repo import 都必須放在這行之後。
const TEST_STORE = join(tmpdir(), `finance-goal-test-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { buildSummary, computeGoalTracking } = await import('../lib/derive.js');
const { emptyDb } = await import('../lib/repo.js');
const { sanitizeSettings, sanitizeSettingsDeep } = await import('../lib/schema.js');
const { app } = await import('../server.js');

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;

after(() => {
  server.close();
  for (const suffix of ['', '.bak', '-wal', '-shm']) {
    try { rmSync(TEST_STORE + suffix); } catch { /* 檔案可能不存在 */ }
  }
});

const NOW = new Date(2026, 6, 23);

function makeDb({ target = 2_000, current = 1_000, transactions = [], snapshots = [] } = {}) {
  return {
    settings: { currency: 'TWD', usdTwd: 32, netWorthTarget: target },
    accounts: [{ id: 'cash', type: 'cash', class: '現金', currency: 'TWD', balance: current }],
    holdings: [], transactions, snapshots,
    assetTargets: [], subscriptions: [], cards: [], insurance: [],
  };
}

function tx(id, date, type, amount, extra = {}) {
  return { id, date, type, amount, ledger: 'cashflow', ...extra };
}

test('目標設定：預設未啟用，只收正數或 null，null 能真的清除舊值', () => {
  assert.equal(emptyDb().settings.netWorthTarget, null);
  assert.deepEqual(sanitizeSettings({ netWorthTarget: 5_000_000 }), { netWorthTarget: 5_000_000 });
  assert.deepEqual(sanitizeSettings({ netWorthTarget: null }), { netWorthTarget: null });
  assert.deepEqual(sanitizeSettings({ netWorthTarget: 0 }), {});
  assert.deepEqual(sanitizeSettings({ netWorthTarget: -1 }), {});
  assert.deepEqual(sanitizeSettings({ netWorthTarget: '500' }), {});

  assert.deepEqual(sanitizeSettingsDeep({ netWorthTarget: null }), {
    value: { netWorthTarget: null }, bad: [],
  });
  assert.deepEqual(sanitizeSettingsDeep({ netWorthTarget: 'oops' }), {
    value: {}, bad: ['settings.netWorthTarget'],
  });
});

test('computeGoalTracking：未設定或非法目標不啟用；資料不足仍回目前進度', () => {
  assert.equal(computeGoalTracking(makeDb({ target: null }), NOW), null);
  assert.equal(computeGoalTracking(makeDb({ target: 0 }), NOW), null);

  const result = computeGoalTracking(makeDb({ target: 2_000, current: 1_000 }), NOW);
  assert.deepEqual(result, {
    target: 2_000, current: 1_000, gap: 1_000, progressPct: 50, reached: false,
    savingsSpeed: null, netWorthSpeed: null,
    monthsSavings: null, monthsNetWorth: null,
    savingsSamples: 0, netWorthSamples: 0, insufficient: true,
  });
});

test('現金結餘速度：只看六個已結束月，排除本月、信用卡帳本與內轉，並用中位數抗離群值', () => {
  const transactions = [
    tx('apr-in', '2026-04-01', 'income', 100),
    tx('apr-out', '2026-04-02', 'expense', 40),
    tx('may-in', '2026-05-01', 'income', 10_000),
    tx('jun-in', '2026-06-01', 'income', 100),
    tx('jun-out', '2026-06-02', 'expense', 40),
    tx('card', '2026-05-03', 'expense', 9_999, { ledger: 'card', source: 'stmt' }),
    tx('transfer', '2026-06-03', 'transfer', 50_000),
    tx('current-month', '2026-07-01', 'income', 999_999),
  ];
  const result = computeGoalTracking(makeDb({ target: 1_360, current: 1_000, transactions }), NOW);

  assert.equal(result.savingsSamples, 3);
  assert.equal(result.savingsSpeed, 60, '60、10000、60 的中位數應為 60');
  assert.equal(result.monthsSavings, 6);
  assert.equal(result.netWorthSpeed, null);
  assert.equal(result.insufficient, false, '其中一把尺已有足夠資料，不應把整段標成資料不足');
});

test('整體淨值速度：缺月先按實際間隔攤平、同月取較新快照、本月不列入', () => {
  const snapshots = [
    { month: '2026-01', date: '2026-01-31', netWorth: 1_000 },
    { month: '2026-03', date: '2026-03-01', netWorth: 9_999 },
    { month: '2026-03', date: '2026-03-31', netWorth: 1_200 },
    { month: '2026-06', date: '2026-06-30', netWorth: 1_500 },
    { month: '2026-07', date: '2026-07-23', netWorth: 99_999 },
  ];
  const result = computeGoalTracking(makeDb({ target: 2_000, current: 1_000, snapshots }), NOW);

  assert.equal(result.netWorthSamples, 3);
  assert.equal(result.netWorthSpeed, 100, '1→3 月與 3→6 月都應按間隔攤成每月 100');
  assert.equal(result.monthsNetWorth, 10);
  assert.equal(result.savingsSpeed, null);
});

test('速度不為正：樣本足夠也不輸出負月份或 Infinity', () => {
  const transactions = [
    tx('apr-in', '2026-04-01', 'income', 10),
    tx('apr-out', '2026-04-02', 'expense', 20),
    tx('may-in', '2026-05-01', 'income', 10),
    tx('may-out', '2026-05-02', 'expense', 10),
    tx('jun-in', '2026-06-01', 'income', 10),
    tx('jun-out', '2026-06-02', 'expense', 30),
  ];
  const snapshots = [
    { month: '2026-04', date: '2026-04-30', netWorth: 1_200 },
    { month: '2026-05', date: '2026-05-31', netWorth: 1_100 },
    { month: '2026-06', date: '2026-06-30', netWorth: 1_000 },
  ];
  const result = computeGoalTracking(makeDb({ target: 2_000, current: 1_000, transactions, snapshots }), NOW);

  assert.equal(result.savingsSamples, 3);
  assert.equal(result.netWorthSamples, 3);
  assert.equal(result.savingsSpeed, null);
  assert.equal(result.netWorthSpeed, null);
  assert.equal(result.monthsSavings, null);
  assert.equal(result.monthsNetWorth, null);
  assert.equal(result.insufficient, false, '這是近期沒有正成長，不是資料不足');
});

test('達標：進度封頂、不出負差距；🎉 報喜進提醒牆一次（使用者 2026-07-23 拍板，推翻 P1 原決定）', () => {
  const db = makeDb({ target: 1_000, current: 1_500 });
  const direct = computeGoalTracking(db, NOW);
  assert.equal(direct.reached, true);
  assert.equal(direct.gap, 0);
  assert.equal(direct.progressPct, 100);
  assert.equal(direct.monthsSavings, 0);
  assert.equal(direct.monthsNetWorth, 0);

  const summary = buildSummary(db);
  assert.equal(summary.goalTrack.reached, true);
  const cheer = summary.reminders.find(r => r.key === 'goal-reached');
  assert.ok(cheer, '達標要出現在提醒牆（新聞牆首次顯示 🆕、之後收進持續中＝天然只報喜一次）');
  assert.equal(cheer.level, 'info', 'info＝好消息不灌進「需要處理」warn/danger 計數');
  assert.equal(cheer.module, '目標');
  assert.match(cheer.title, /🎉/);
  // D2 穩定 key 規約：同狀態兩次計算 key 相同、title 才帶金額
  const again = buildSummary(db).reminders.find(r => r.key === 'goal-reached');
  assert.ok(again);
  assert.equal(again.key, cheer.key);
});

test('未達標／未設目標：提醒牆沒有 goal-reached（跌回目標下＝提醒消失→新聞牆誠實顯示「已解除」）', () => {
  const below = buildSummary(makeDb({ target: 1_000_000, current: 1_500 }));
  assert.ok(!below.reminders.some(r => r.key === 'goal-reached'), '未達標不報喜');
  const noGoal = buildSummary(makeDb({ target: null }));
  assert.ok(!noGoal.reminders.some(r => r.key.startsWith('goal-')), '未設目標整段不出現');
});

test('HTTP 全鏈路：設定目標後 summary 立即出現，送 null 後真的清除', async () => {
  const setRes = await fetch(base + '/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ netWorthTarget: 50_000_000 }),
  });
  assert.equal(setRes.status, 200);
  assert.equal((await setRes.json()).netWorthTarget, 50_000_000);

  const withGoal = await (await fetch(base + '/summary')).json();
  assert.equal(withGoal.goalTrack.target, 50_000_000);
  assert.equal(typeof withGoal.goalTrack.current, 'number');

  const clearRes = await fetch(base + '/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ netWorthTarget: null }),
  });
  assert.equal(clearRes.status, 200);
  assert.equal((await clearRes.json()).netWorthTarget, null);

  const cleared = await (await fetch(base + '/summary')).json();
  assert.equal(cleared.goalTrack, null);
});
