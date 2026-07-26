// 續費日自動推進（使用者定 2026-07-26）＋過期提醒不再有 30 天下限。
//
// 病根：nextCharge 是使用者手填的固定日期、不會自己走；日期一過那筆就從「未來 30 天」的續費時間線
// 消失（使用者實際資料 26 筆訂閱裡有 5 筆卡在過去）。
// 這裡鎖三件會出錯的事：
//   ①該推的推、**不該推的一筆都不能動**（尤其「使用者手動輸入停用日」＝使用者明確要求的例外）
//   ②**推日期不可以改到任何金額**——攤提看的是 since/endsOn/amount/cycle，跟 nextCharge 無關
//   ③1/31 這種月底日不可以一路縮成 28 號（每期都要從原始日期重算）
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { addMonthsToDate, rolledNextCharge, chargeAnchorDay, costForMonth } from '../public/modules/subscriptions-model.js';

const TEST_STORE = join(tmpdir(), `finance-autoroll-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { getDb, saveDb } = await import('../lib/repo.js');
const { rollDueSubscriptions } = await import('../lib/services/subscriptions.js');
const { buildSummary } = await import('../lib/derive.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

const TODAY = '2026-07-26';

test('addMonthsToDate：月底收到當月最後一天，不溢位到下個月', () => {
  assert.equal(addMonthsToDate('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsToDate('2028-01-31', 1), '2028-02-29');   // 閏年
  assert.equal(addMonthsToDate('2026-01-15', 12), '2027-01-15');
  assert.equal(addMonthsToDate('2026-12-05', 1), '2027-01-05');   // 跨年
  assert.equal(addMonthsToDate('', 1), '');
  assert.equal(addMonthsToDate('壞資料', 1), '');
});

test('rolledNextCharge：該推的推到「第一個未來日期」，一次補到位', () => {
  assert.equal(rolledNextCharge({ cycle: 'monthly', nextCharge: '2026-07-05' }, TODAY), '2026-08-05');
  assert.equal(rolledNextCharge({ cycle: 'monthly', nextCharge: '2026-02-05' }, TODAY), '2026-08-05', '逾期五期也只推到下一個未來日，不補記過去每一期');
  assert.equal(rolledNextCharge({ cycle: 'yearly', nextCharge: '2025-07-05' }, TODAY), '2027-07-05');
  assert.equal(rolledNextCharge({ cycle: 'quarterly', nextCharge: '2026-05-20' }, TODAY), '2026-08-20');
  // 半年繳 1/20：+6 月＝7/20，仍早於今天(7/26) → 必須再推一期到 2027-01-20（不可停在還是過去的日期）
  assert.equal(rolledNextCharge({ cycle: 'semiannual', nextCharge: '2026-01-20' }, TODAY), '2027-01-20');
});

test('rolledNextCharge：月底錨定——每期從原始日期重算，1/31 不會一路縮成 28 號', () => {
  // 1/31 月繳、今天 4/10 → 4/30（若拿收月底後的 2/28 再加，會變成 4/28＝錯）
  assert.equal(rolledNextCharge({ cycle: 'monthly', nextCharge: '2026-01-31' }, '2026-04-10'), '2026-04-30');
  // 再跑一次（新日期已是未來）＝不動
  assert.equal(rolledNextCharge({ cycle: 'monthly', nextCharge: '2026-04-30' }, '2026-04-10'), null);
  // 推過月底後回到 31 天的月份要還原成 31 號
  assert.equal(rolledNextCharge({ cycle: 'monthly', nextCharge: '2026-01-31' }, '2026-03-05'), '2026-03-31');
});

test('rolledNextCharge：不該推的一筆都不能動', () => {
  const cases = [
    [{ cycle: 'monthly', nextCharge: '2026-08-05' }, '還沒到期'],
    [{ cycle: 'monthly', nextCharge: TODAY }, '今天要扣＝維持顯示「今天」'],
    [{ cycle: 'lifetime', nextCharge: '2026-07-05' }, '終身訂閱沒有續費'],
    [{ cycle: 'monthly', nextCharge: '2026-07-05', endsOn: '2026-09-01' }, '使用者手動輸入停用日（使用者指定的例外）'],
    [{ cycle: 'monthly', nextCharge: '2026-07-05', status: 'ending' }, '標成即將停用'],
    [{ cycle: 'monthly', nextCharge: '2026-07-05', status: 'ended' }, '已結束'],
    [{ cycle: 'monthly', nextCharge: '2026-07-05', active: false }, '已停用'],
    [{ cycle: 'monthly', nextCharge: '' }, '沒填續費日'],
    [{ cycle: 'monthly', nextCharge: '2026/07/05' }, '格式不合＝不猜'],
    [{ cycle: 'monthly' }, '缺欄位'],
    [null, '空物件'],
  ];
  for (const [sub, why] of cases) assert.equal(rolledNextCharge(sub, TODAY), null, String(why));
});

test('自動推進（服務層）：只動續費日、金額一分不變、沒得推就不寫檔', () => {
  const db = getDb();
  db.subscriptions = [
    { id: 's1', name: '月繳過期', cycle: 'monthly', amount: 390, since: '2026-01', nextCharge: '2026-07-05', category: '工作' },
    { id: 's2', name: '有停用日', cycle: 'monthly', amount: 200, since: '2026-01', nextCharge: '2026-07-05', endsOn: '2026-09-01', status: 'ending', category: '工作' },
    { id: 's3', name: '未來', cycle: 'monthly', amount: 100, since: '2026-01', nextCharge: '2026-08-20', category: '工作' },
    { id: 's4', name: '終身', cycle: 'lifetime', amount: 3000, since: '2026-01', nextCharge: '2026-07-05', category: '工作' },
  ];
  saveDb(db);
  // 推之前先記下每一筆的每月攤提（推日期不可以改到任何一個月的錢）
  const before = db.subscriptions.map(s => ['2026-06', '2026-07', '2026-08'].map(m => costForMonth(s, m)));
  const cardBefore = buildSummary(getDb()).subscriptions.monthly;   // ⚠️ 真欄位在 summary.subscriptions.monthly（寫錯名字會變 undefined===undefined 的假斷言）

  const r = rollDueSubscriptions(TODAY);
  assert.deepEqual(r.rolled, [{ id: 's1', name: '月繳過期', from: '2026-07-05', to: '2026-08-05' }],
    '只有 s1 該推；有停用日／未來／終身都不可被動到');
  const after = getDb().subscriptions;
  assert.equal(after.find(s => s.id === 's1').nextCharge, '2026-08-05');
  assert.equal(after.find(s => s.id === 's2').nextCharge, '2026-07-05', '使用者手動輸入停用日的那筆維持原樣');
  assert.equal(after.find(s => s.id === 's3').nextCharge, '2026-08-20');
  assert.equal(after.find(s => s.id === 's4').nextCharge, '2026-07-05');
  // ⚠️ 金額不變（本考題的重點）
  assert.deepEqual(after.map(s => ['2026-06', '2026-07', '2026-08'].map(m => costForMonth(s, m))), before,
    '推續費日不可改動任何一個月的攤提金額');
  assert.ok(cardBefore > 0, '前置條件：這批合成訂閱本月確實有金額（否則下一行是空斷言）');
  assert.equal(buildSummary(getDb()).subscriptions.monthly, cardBefore, '總覽的訂閱月費也不可變');
  // 冪等：再跑一次沒有任何一筆要推
  assert.deepEqual(rollDueSubscriptions(TODAY).rolled, [], '推完再跑＝零變動（每次開 app 都會跑）');
});

test('過期提醒沒有 30 天下限（使用者要求補漏洞 2026-07-26）', () => {
  const db = getDb();
  // 自動推進「這次沒跑到」的情境（電腦時鐘倒退時整段每日維護會被略過；或使用者手動填了過去的日期後沒再開 app）
  // ——這正是提醒要當安全網的時候：**不呼叫 rollDueSubscriptions**，直接看提醒牆。
  db.subscriptions = [{ id: 'x2', name: '過期很久', cycle: 'monthly', amount: 100, since: '2026-01', nextCharge: '2026-01-05', category: '工作' }];
  saveDb(db);
  const overdue = buildSummary(getDb()).reminders.filter(r => /續費日已過/.test(r.title));
  assert.equal(overdue.length, 1);
  assert.match(overdue[0].title, /過期很久/);
  assert.equal(overdue[0].level, 'warn');
  // 舊行為（只提醒 30 天內）會讓這筆完全消失——時間線只畫未來 30 天、提醒又不提＝愈久愈安靜
  assert.ok(Number(/已過 (\d+) 天/.exec(overdue[0].title)?.[1]) > 30, '過期超過 30 天仍然提醒');
});

test('月底錨點：連續兩次維護（跨月分開跑）不可一路縮到 28 號（Codex 複審 2026-07-26）', () => {
  // 病根：只留得下收月底後的結果 → 1/31 推成 2/28，下個月再推就從 28 起算變 3/28。
  const db = getDb();
  db.subscriptions = [{ id: 'a1', name: '月底扣款', cycle: 'monthly', amount: 100, since: '2026-01', nextCharge: '2026-01-31', category: '工作' }];
  saveDb(db);
  rollDueSubscriptions('2026-02-05');          // 第一次開 app（二月）
  const after1 = getDb().subscriptions[0];
  assert.equal(after1.nextCharge, '2026-02-28', '二月沒有 31 號 → 收到當月最後一天');
  assert.equal(after1.chargeAnchorDay, 31, '原本的號數要留著，否則下個月回不去 31');
  rollDueSubscriptions('2026-03-05');          // 下個月再開一次
  assert.equal(getDb().subscriptions[0].nextCharge, '2026-03-31', '三月有 31 號 → 必須回到 31（不是 3/28）');
  rollDueSubscriptions('2026-04-05');
  assert.equal(getDb().subscriptions[0].nextCharge, '2026-04-30', '四月只有 30 天 → 收到 30，錨點仍是 31');
  assert.equal(getDb().subscriptions[0].chargeAnchorDay, 31);
});

test('月底錨點：閏年 2/29 與「使用者自己改過日期」', () => {
  const db = getDb();
  db.subscriptions = [{ id: 'b1', name: '閏年', cycle: 'monthly', amount: 100, since: '2026-01', nextCharge: '2028-01-31', chargeAnchorDay: 31, category: '工作' }];
  saveDb(db);
  rollDueSubscriptions('2028-02-05');
  assert.equal(getDb().subscriptions[0].nextCharge, '2028-02-29', '2028 是閏年 → 29 號');
  // 使用者把日期改成 15 號（舊錨點 31 不可復活）
  const db2 = getDb();
  db2.subscriptions[0].nextCharge = '2028-02-15';
  saveDb(db2);
  assert.equal(chargeAnchorDay(getDb().subscriptions[0]), 15, '對不上舊錨點＝使用者改過，改用新號數');
  rollDueSubscriptions('2028-03-10');   // 今天 3/10：2/15 已過 → 推到 3/15（而不是回到月底）
  assert.equal(getDb().subscriptions[0].nextCharge, '2028-03-15', '照使用者改的 15 號走');
  assert.equal(getDb().subscriptions[0].chargeAnchorDay, 15, '錨點也要換成使用者改的號數');
});

test('只動續費日與錨點：整筆物件的其他欄位一字不變（Codex 複審建議的加嚴版）', () => {
  const db = getDb();
  const base = { id: 'c1', name: '完整欄位', cycle: 'monthly', amount: 390, since: '2026-01', nextCharge: '2026-07-05',
    category: '工作', card: 'c-1', email: 'x@example.com', status: 'active', active: true, order: 3, considerCancel: false };
  db.subscriptions = [{ ...base }];
  saveDb(db);
  rollDueSubscriptions(TODAY);
  const after = getDb().subscriptions[0];
  const { nextCharge, chargeAnchorDay: anchor, ...rest } = after;
  const baseRest = { ...base };
  delete baseRest.nextCharge;
  assert.deepEqual(rest, baseRest, '除了續費日與錨點，其餘欄位（含金額、週期、卡片、信箱、排序）必須一字不變');
  assert.equal(nextCharge, '2026-08-05');
  assert.equal(anchor, 5);
});
