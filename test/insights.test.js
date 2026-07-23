// 每日洞察引擎 D3：差異引擎五情境（首次/🆕新出現/✓已解除/跳檔/平靜）＋固定窗Δ＋自上次Δ＋書籤更新＋sanitizer。
// 報價來源用「必失敗 fetchImpl」→ getCape/getRealYield 走 settings 手動值/ null 退路（不打真 API、不污染模組快取）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-insights-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { getDb, saveDb } = await import('../lib/repo.js');
const { getInsights } = await import('../lib/services/insights.js');
const { sanitizeInsightState } = await import('../lib/schema.js');

const failFetch = () => Promise.reject(new Error('offline'));
const NOW = new Date('2026-07-22T10:00:00.000Z');
const run = () => getInsights({ fetchImpl: failFetch, now: NOW });

after(() => { for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

/** 重置：控制當前提醒（用匯率門檻，最乾淨）、書籤、日線、估值訊號。 */
function reset({ usdTwd = 30, signals = {}, insightState = {}, dailyValues = [], accounts = [], netWorthTarget = null } = {}) {
  const db = getDb();
  db.settings = { ...db.settings, usdTwd, fxHigh: 32, fxLow: 28, signals, netWorthTarget };
  db.accounts = accounts; db.holdings = []; db.transactions = []; db.subscriptions = []; db.cards = []; db.insurance = [];
  db.assetTargets = [];   // 清掉種子的配置目標，免 alloc-drift 提醒混進來（要乾淨控制當前提醒集合）
  db.dailyValues = dailyValues;
  db.insightState = insightState;
  saveDb(db);
}
const bmSeed = (over) => ({ lastSeenAt: '2026-07-15T09:00:00.000Z', netWorth: 0, pfValue: 0, reminders: [], tiers: { us: null, china: null, japan: null, korea: null, taiwan: null }, usdTwd: 30, ...over });

// ---------- 情境 1：首次執行（沒書籤）----------
test('D3 首次執行：無書籤 → 全當持續中、不標 🆕、sinceLast=null；並寫下書籤', async () => {
  reset({ usdTwd: 33, insightState: {} });   // usdTwd 33 ≥ fxHigh 32 → 當前有 fx-usd-high 提醒
  const r = await run();
  assert.equal(r.firstRun, true);
  assert.equal(r.reminders.new.length, 0, '首次不標 🆕（避免假新鮮洪水）');
  assert.ok(r.reminders.ongoing.some(x => x.key === 'fx-usd-high'), '全部當持續中');
  assert.equal(r.sinceLast, null, '首次不顯示自上次 Δ');
  // 書籤已寫下（讀取＝看過了）
  const bm = getDb().insightState;
  assert.equal(bm.lastSeenAt, NOW.toISOString());
  assert.ok(bm.reminders.some(x => x.key === 'fx-usd-high'));
});

// ---------- 情境 2：🆕 新出現 ----------
test('D3 🆕 新出現：書籤沒有的 key 現在出現 → 標為 new', async () => {
  reset({ usdTwd: 33, insightState: bmSeed({ reminders: [] }) });   // 書籤空提醒、但有 lastSeenAt（非首次）
  const r = await run();
  assert.equal(r.firstRun, false);
  assert.deepEqual(r.reminders.new.map(x => x.key), ['fx-usd-high'], 'fx-usd-high 是新出現');
});

// ---------- 情境 3：✓ 已解除（報喜，留 title 供顯示）----------
test('D3 ✓ 已解除：書籤有、現在沒有 → cleared（帶 title 供「已解除：…」顯示）', async () => {
  reset({ usdTwd: 30, insightState: bmSeed({ reminders: [{ key: 'fx-usd-high', title: '美元/台幣 33 已達 32 以上', module: '匯率', level: 'info' }] }) });
  const r = await run();   // usdTwd 30 在區間內 → 當前無 fx 提醒
  assert.equal(r.reminders.cleared.length, 1);
  assert.equal(r.reminders.cleared[0].key, 'fx-usd-high');
  assert.match(r.reminders.cleared[0].title, /已達 32/, '保留上次 title 供顯示');
  assert.ok(!r.reminders.all.some(x => x.key === 'fx-usd-high'), '當前確實沒有這條');
});

// ---------- 情境 4：跳檔（估值檔位變動；null↔值 不算跳）----------
test('D3 跳檔：中股檔位 0→1 記為跳檔；未輸入(null)→有值 不算跳檔', async () => {
  reset({ usdTwd: 30, signals: { china: 11 }, insightState: bmSeed({ tiers: { us: null, china: 0, japan: null, korea: null, taiwan: null } }) });
  const r = await run();   // china PE 11 → tier 1；書籤 china=0 → 跳檔
  assert.deepEqual(r.tierChanges, [{ market: 'china', from: 0, to: 1 }]);
  // japan 書籤 null、現在也 null（沒填）→ 不在 tierChanges；us 同理
  assert.ok(!r.tierChanges.some(c => c.market === 'japan' || c.market === 'us'));

  // null→有值 不算跳檔：書籤 japan=null，現在填了 japan → 不報跳檔
  reset({ usdTwd: 30, signals: { japan: 1.25 }, insightState: bmSeed({ tiers: { us: null, china: null, japan: null, korea: null, taiwan: null } }) });
  const r2 = await run();
  assert.equal(r2.tierChanges.length, 0, 'null→有值（資料剛填）不當跳檔');
});

// ---------- 情境 5：平靜（無 🆕/✓/跳檔、且今日 Δ 低於門檻）----------
test('D3 平靜：提醒與檔位都沒變、今日 Δ 微小 → calm=true', async () => {
  const bm = bmSeed({ reminders: [{ key: 'fx-usd-high', title: 't', module: '匯率', level: 'info' }], tiers: { us: null, china: null, japan: null, korea: null, taiwan: null } });
  reset({ usdTwd: 33, insightState: bm, dailyValues: [{ date: '2026-07-21', netWorth: 1000 }, { date: '2026-07-22', netWorth: 1001 }] });   // 今日 +0.1% < 0.3%
  const r = await run();
  assert.equal(r.reminders.new.length, 0);
  assert.equal(r.reminders.cleared.length, 0);
  assert.equal(r.tierChanges.length, 0);
  assert.equal(r.calm, true, '無新事件＋今日 Δ 微小 → 平靜');
});

test('D3 非平靜：今日 Δ 超過門檻（即使無新事件）→ calm=false', async () => {
  const bm = bmSeed({ reminders: [{ key: 'fx-usd-high', title: 't', module: '匯率', level: 'info' }] });
  reset({ usdTwd: 33, insightState: bm, dailyValues: [{ date: '2026-07-21', netWorth: 1000 }, { date: '2026-07-22', netWorth: 1050 }] });   // 今日 +5% ≥ 0.3%
  const r = await run();
  assert.equal(r.calm, false);
});

// ---------- 固定窗 Δ（今天/本週，從日線；找最接近既有日）----------
test('D3 固定窗：今日＝最近兩既有日、本週＝約 7 天前既有日；不足不顯示', async () => {
  reset({ usdTwd: 30, dailyValues: [
    { date: '2026-07-15', netWorth: 100 }, { date: '2026-07-21', netWorth: 110 }, { date: '2026-07-22', netWorth: 121 },
  ] });
  const r = await run();
  assert.equal(r.windows.today.fromDate, '2026-07-21');
  assert.equal(r.windows.today.delta, 11);
  assert.ok(Math.abs(r.windows.today.pct - 10) < 1e-9);
  assert.equal(r.windows.week.fromDate, '2026-07-15', '7 天前找最接近既有日');
  assert.equal(r.windows.week.delta, 21);

  reset({ usdTwd: 30, dailyValues: [{ date: '2026-07-22', netWorth: 100 }] });   // 只有一天
  const r2 = await run();
  assert.equal(r2.windows.today, null, '資料不足不硬算');
});

// ---------- 自上次 Δ ----------
test('D3 自上次 Δ：現值 − 書籤上次值', async () => {
  reset({ usdTwd: 30, accounts: [{ id: 'a', type: 'cash', class: '現金', currency: 'TWD', balance: 1100 }],
    insightState: bmSeed({ netWorth: 1000, pfValue: 0 }) });
  const r = await run();
  assert.equal(r.sinceLast.netWorth, 100, '1100 − 1000');
});

// ---------- 同日第二次開：🆕 被上次讀取吸收 ----------
test('D3 同日第二次開：第一次讀吸收 🆕，第二次讀無新事件（平靜）', async () => {
  reset({ usdTwd: 33, insightState: bmSeed({ reminders: [] }) });
  const first = await run();
  assert.deepEqual(first.reminders.new.map(x => x.key), ['fx-usd-high'], '第一次：新出現');
  const second = await run();   // 書籤已被第一次更新
  assert.equal(second.reminders.new.length, 0, '第二次：不再新（已吸收）');
  assert.equal(second.firstRun, false);
});

test('P3 達標報喜：未達標→達標只進 new 一次，第二次讀取改列 ongoing', async () => {
  reset({
    netWorthTarget: 2_000,
    accounts: [{ id: 'cash', type: 'cash', class: '現金', currency: 'TWD', balance: 1_000 }],
    insightState: bmSeed({ netWorth: 1_000, reminders: [] }),
  });
  const before = await run();
  assert.ok(!before.reminders.all.some(x => x.key === 'goal-reached'), '未達標不能先報喜');

  const db = getDb();
  db.settings.netWorthTarget = 500;
  saveDb(db);
  const reached = await run();
  assert.deepEqual(reached.reminders.new.map(x => x.key), ['goal-reached'], '第一次達標要成為新聞牆新消息');

  const again = await run();
  assert.ok(!again.reminders.new.some(x => x.key === 'goal-reached'), '同一目標不可重播報喜');
  assert.ok(again.reminders.ongoing.some(x => x.key === 'goal-reached'), '已看過後收進持續中');
});

// ---------- D3 自審修正 ----------
test('D3 自審#1：顧慮升級（將至→已過）同 key → 判持續中，不謊報 ✓已解除＋🆕（生存級）', async () => {
  const iso = (delta) => { const d = new Date(); d.setDate(d.getDate() + delta); return d.toISOString().slice(0, 10); };
  const db = getDb();
  db.settings = { ...db.settings, usdTwd: 30, fxHigh: 32, fxLow: 28 };
  db.accounts = []; db.holdings = []; db.transactions = []; db.subscriptions = []; db.cards = []; db.assetTargets = []; db.dailyValues = [];
  db.insurance = [{ id: 'pol1', policyName: '壽險A', nextPayment: iso(-3), premium: 1000, premiumCycle: 'yearly' }];   // 已過 3 天＝danger，key=ins-pay-pol1
  db.insightState = bmSeed({ reminders: [{ key: 'ins-pay-pol1', title: '壽險A 5 天後繳費', module: '保險', level: 'warn' }] });   // 上次看＝將至
  saveDb(db);
  const r = await run();
  assert.ok(r.reminders.ongoing.some(x => x.key === 'ins-pay-pol1'), '升級後同 key → 持續中');
  assert.equal(r.reminders.cleared.length, 0, '不可謊報「已解除 👍」');
  assert.ok(!r.reminders.new.some(x => x.key === 'ins-pay-pol1'), '不是新出現');
});

test('D3 自審#2/#5：殘缺書籤（缺 reminders 陣列／缺 lastSeenAt）→ 退回首次執行，不洪水標 🆕', async () => {
  reset({ usdTwd: 33, insightState: { lastSeenAt: '2026-07-15T00:00:00Z', netWorth: 1000, tiers: { us: null, china: null, japan: null, korea: null, taiwan: null } } });
  const r1 = await run();
  assert.equal(r1.firstRun, true, '缺 reminders 陣列＝當首次執行');
  assert.equal(r1.reminders.new.length, 0, '不洪水標 🆕');

  reset({ usdTwd: 33, insightState: { reminders: [], netWorth: 1000 } });   // 缺 lastSeenAt
  const r2 = await run();
  assert.equal(r2.firstRun, true, '缺 lastSeenAt＝當首次執行');
  assert.equal(r2.reminders.new.length, 0);
});

test('D3 自審#3：基期 0 但有變動 → 不平靜（500k 從 0 起跳，pct 算不出也不可當平靜）', async () => {
  reset({ usdTwd: 30, insightState: bmSeed({ reminders: [] }), dailyValues: [{ date: '2026-07-21', netWorth: 0 }, { date: '2026-07-22', netWorth: 500000 }] });
  const r = await run();
  assert.equal(r.windows.today.pct, null, '基期 0 → pct 算不出');
  assert.equal(r.windows.today.delta, 500000);
  assert.equal(r.calm, false, '有 500k 變動不可當平靜');
});

test('D3 自審#4：淨值為負時 Δ% 用 abs(基期)：-1000→-500（變好）＝+50%，不是 -50%', async () => {
  reset({ usdTwd: 30, dailyValues: [{ date: '2026-07-21', netWorth: -1000 }, { date: '2026-07-22', netWorth: -500 }] });
  const r = await run();
  assert.equal(r.windows.today.delta, 500);
  assert.ok(Math.abs(r.windows.today.pct - 50) < 1e-9, '變好＝+50%（方向正確，不因負基期反轉）');
});

test('D3 自審 r14#3：殘缺書籤缺 netWorth → sinceLast.netWorth = null（不謊報「自上次 +全部淨值」）', async () => {
  reset({ usdTwd: 30, accounts: [{ id: 'a', type: 'cash', class: '現金', currency: 'TWD', balance: 500000 }],
    insightState: { lastSeenAt: '2026-07-15T00:00:00Z', reminders: [], tiers: { us: null, china: null, japan: null, korea: null, taiwan: null } } });   // 有 lastSeenAt+reminders，但缺 netWorth/pfValue
  const r = await run();
  assert.equal(r.firstRun, false, '有 lastSeenAt+reminders → 非首次');
  assert.equal(r.sinceLast.netWorth, null, '缺上次淨值 → 差額 null（不當成 0 → 不謊報 +500000）');
  assert.equal(r.sinceLast.pfValue, null, '缺上次投組值同理 → null');
});

// ---------- sanitizer：壞形狀→安全 ----------
test('sanitizeInsightState：非物件→{}；壞欄位丟棄、保留合法形狀', () => {
  assert.deepEqual(sanitizeInsightState(null), {});
  assert.deepEqual(sanitizeInsightState('x'), {});
  const clean = sanitizeInsightState({
    lastSeenAt: '2026-07-22T00:00:00Z', prevSeenAt: 123, netWorth: 1000, pfValue: 'bad', usdTwd: 32,
    reminders: [{ key: 'k1', title: 't', module: 'm', level: 'warn' }, { key: '', title: 'x' }, 'nope', { title: 'no-key' }],
    tiers: { us: 1, china: 'bad', japan: null, korea: 0, taiwan: 2, extra: 9 },
  });
  assert.equal(clean.lastSeenAt, '2026-07-22T00:00:00Z');
  assert.ok(!('prevSeenAt' in clean), '非字串 prevSeenAt 丟棄');
  assert.equal(clean.netWorth, 1000);
  assert.ok(!('pfValue' in clean), '非數字 pfValue 丟棄');
  assert.deepEqual(clean.reminders, [{ key: 'k1', title: 't', module: 'm', level: 'warn' }], '空 key / 非物件 / 缺 key 都丟');
  assert.deepEqual(clean.tiers, { us: 1, china: null, japan: null, korea: 0, taiwan: 2 }, '壞 tier→null、只留五市場');
});
