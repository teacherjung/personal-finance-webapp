// 淨值日線考題（D0，每日洞察引擎的地基）：
// 月快照是「同月覆蓋」→ 手上永遠只有每月一個點；日線必須是「同日覆寫、跨日累積」，
// 差異引擎（D3）才算得出「今天 vs 昨天」。這裡鎖住三件事：
//   ①同日重跑只有一行（且值會更新）②跨日累積不覆蓋舊行 ③缺/壞 date 進不了櫃檯。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-daily-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { recordDailyValue, takeSnapshotIfDue, takeSnapshot } = await import('../lib/services/snapshot.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

/** 重置成乾淨的資料庫，只放一個現金帳戶（淨資產＝該餘額）。 @param {number} balance */
function seed(balance) {
  store.save({ ...store.emptyDb(), accounts: [{ id: 'a1', name: '現金', type: 'cash', currency: 'TWD', balance }] });
}

test('日線：同一天重跑只留一行，且值更新成最新（同日覆寫）', async () => {
  seed(1000);
  const first = await recordDailyValue();
  assert.equal(first.netWorth, 1000, '第一次寫入應反映當下淨資產');

  // 同一天資產變動後再跑一次
  const db = await getDb();
  /** @type {any} */ (db.accounts)[0].balance = 1500;
  await saveDb(db);
  const second = await recordDailyValue();

  const rows = (await getDb()).dailyValues || [];
  assert.equal(rows.length, 1, '同一天不論跑幾次都只有一行');
  assert.equal(rows[0].date, first.date, '仍是同一天');
  assert.equal(second.netWorth, 1500, '回傳值是最新的');
  assert.equal(rows[0].netWorth, 1500, '存下來的也被更新成最新值（不是留著舊的）');
});

test('日線：跨日累積不覆蓋（與月快照的同月覆蓋相反）', async (t) => {
  // ⚠️ 舊 fixture 只塞一筆 '2020-01-01'（不同月份），於是這條題**在同一個月內驗不到**：
  //    把同日去重（`d.date !== now.date`）改成同月去重（`d.date.slice(0,7) !== now.month`），
  //    當月先前每一天的日線會被整批刪掉，這條題照樣全綠。被刪掉的正是差異引擎 D3
  //    唯一的原料——「今天 vs 昨天」比的就是同一個月裡的昨天。
  // ⚠️ 而且「昨天」要用釘死的時鐘算，不能用真實時鐘（同 snapshot-history-integrity 的理由）：
  //    每個月 1 號那天本月不存在更早的日期，同日去重與同月去重行為完全相同——考題會在
  //    30 天裡有 1 天安靜地失去鑑別力，而「今天剛好驗不到」最難被發現。
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 7, 15, 12, 0, 0) });
  seed(1000);
  const first = await recordDailyValue();
  assert.equal(first.date, '2026-08-15',
    '前置條件：時鐘要真的被釘在 2026-08-15（沒釘住的話下面的字面日期就不是「昨天」與「很久以前」了）');
  // 模擬「很久以前有一行」＋「同月的昨天也有一行」：跨月與同月兩種都必須活著
  const db = await getDb();
  /** @type {any} */ (db.dailyValues).unshift(
    { date: '2020-01-01', netWorth: 1, assets: 1, liabilities: 0 },
    { date: '2026-08-14', netWorth: 2, assets: 2, liabilities: 0 });
  await saveDb(db);
  await recordDailyValue();

  const rows = (await getDb()).dailyValues || [];
  assert.equal(rows.length, 3, '舊日子的行必須留著（累積）');
  assert.deepEqual(rows.map((/** @type {any} */ r) => r.date), ['2020-01-01', '2026-08-14', '2026-08-15'],
    '而且照日期排序（差異引擎靠順序找最近的日子）');
  assert.equal(rows[0].netWorth, 1, '舊行的值不被今天的值蓋掉');
  assert.equal(rows[1].netWorth, 2,
    '同月的昨天也一樣不可以被吃掉——同日覆寫的鍵是「日」不是「月」，這一筆就是差異引擎算「今天 vs 昨天」的對照');
});

test('日線：記錄了投組成本/市值與當日匯率（差異引擎與事後回推要用）', async () => {
  seed(1000);
  const row = await recordDailyValue();
  for (const f of ['netWorth', 'assets', 'liabilities', 'pfCost', 'pfValue', 'usdTwd']) {
    assert.equal(typeof (/** @type {any} */ (row)[f]), 'number', `${f} 必須是數字（壞型別會被櫃檯剝掉）`);
  }
  assert.ok(row.usdTwd && row.usdTwd > 0, '匯率要有值（缺設定時沿用 derive 的預設 32）');
});

test('日線：缺 date／壞 date 進不了櫃檯（date 是主鍵欄）', () => {
  seed(1000);
  const base = store.emptyDb();
  assert.throws(() => store.save({ ...base, dailyValues: [{ netWorth: 1 }] }), /date/,
    '缺 date 的行必須被擋下（缺主鍵會讓差異引擎排序崩）');
  assert.throws(() => store.save({ ...base, dailyValues: [{ date: '2026-07', netWorth: 1 }] }), /date/,
    '只有年月（非 YYYY-MM-DD）也不行');
  assert.throws(() => store.save({ ...base, dailyValues: [{ date: '', netWorth: 1 }] }), /date/,
    '空字串 date 也是壞資料（不是「未設定」）');
});

test('手動按「記錄本月快照」也會更新日線（否則日線停在早上的舊值，差異引擎會對不上）', async () => {
  seed(1000);
  await takeSnapshotIfDue();                       // 模擬早上開 app
  const db = await getDb();
  /** @type {any} */ (db.accounts)[0].balance = 5000;   // 白天改了一筆大額資產
  await saveDb(db);
  await takeSnapshot();                            // 使用者按下手動快照鈕
  const rows = (await getDb()).dailyValues || [];
  assert.equal(rows.length, 1, '仍然只有今天這一行');
  assert.equal(rows[0].netWorth, 5000, '日線要跟著手動快照更新，不能停在早上的值');
});

test('開 app 的 auto 流程：月快照跳過時，日線仍然照寫（同日資產變動要跟得上）', async () => {
  seed(1000);
  const r1 = await takeSnapshotIfDue();
  assert.equal(r1.recorded, true, '第一次應記錄本月快照');
  assert.ok(r1.daily && r1.daily.date, 'auto 流程要順手回傳今天的日線');

  const db = await getDb();
  /** @type {any} */ (db.accounts)[0].balance = 2000;
  await saveDb(db);
  const r2 = await takeSnapshotIfDue();
  assert.equal(r2.recorded, false, '同一天第二次不重複記月快照');
  assert.equal(r2.daily.netWorth, 2000, '但日線必須更新到最新（月快照跳過≠日線跳過）');
  assert.equal(((await getDb()).dailyValues || []).length, 1, '且仍然只有一行');
});
