// 快照與日線的「歷史不可被舊資料蓋掉」考題（夜班稽核第三批B，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢：`lib/services/snapshot.js` 有三處註解寫明理由的規則，
// 弄壞之後 1487 題全綠。三處的共同後果都是**歷史被靜默改寫，而歷史補不回來**。
//
// ⚠️ 與既有 `test/snapshot-safety.test.js` 的分工：那一支守的是「日線那一半」
//    （所有倒退考題都塞 `dailyValues=[明天]`）。本支補的是它漏掉的另外三件事：
//    ①倒退護欄的 **snapshots 那一半**（還原舊備份之後就是「只有月快照、日線是空的」這個形狀）
//    ②同月只留一列（月快照與投組快照兩條線都要）
//    ③日線留底的匯率預設值要與 `lib/derive.js` 算淨值時用的**同一個**（不然事後分不出
//      淨值變動是資產動了還是匯率動了——那正是日線存三種匯率的理由）。
//
// 隔離：`STORE_FILE` 指向 os 暫存檔，絕不碰真實 `data/`。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-snap-history-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { recordDailyValue, takeSnapshot, takeSnapshotIfDue } = await import('../lib/services/snapshot.js');
const { computeAssets } = await import('../lib/derive.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const thisMonth = () => today().slice(0, 7);
/** 未來日期（+30 天）：拿它當「資料庫裡最新的一天」就等於模擬「電腦時鐘被調回過去」。 */
const future = () => {
  const d = new Date(Date.now() + 30 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

beforeEach(() => { store.save({ ...store.emptyDb() }); });

test('時鐘倒退｜只有月快照、日線是空的時候，倒退護欄同樣要擋（還原舊備份後就是這個形狀）', async () => {
  // ⚠️ 護欄刻意同時看 dailyValues 與 snapshots 兩條線，但既有考題全部只塞 dailyValues；
  //    把 snapshots 那一半從判準裡拿掉時 1487 題全綠。
  //    這個形狀是真實的：還原一份舊備份之後，資料庫裡可能只有月快照、日線是空的。
  const far = future();
  store.save({
    ...store.emptyDb(),
    dailyValues: [],                                        // ← 日線是空的（漏測的那一半）
    snapshots: [{ month: far.slice(0, 7), date: far, netWorth: 999999, assets: 999999, liabilities: 0, byClass: {} }],
  });

  // 手動按鈕：要明確 throw 400 並說明（使用者主動按的動作要看得見）
  const err = await takeSnapshot().then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '資料庫裡最新的一天在未來（＝時鐘倒退），手動快照必須擋下來');
  assert.equal(err.status, 400);
  assert.match(err.message, /比已經記錄的最新資料/, '訊息要說清楚是時間問題（不然使用者不知道要去修系統時間）');

  // 自動流程（開 app）：安靜略過，但一個字都不可以改到既有紀錄
  const r = await takeSnapshotIfDue();
  assert.equal(r.recorded, false, '自動流程要略過');
  assert.equal(r.skipped, far, '要回報「因為資料庫裡最新的一天是哪天」而略過');
  const db = store.load();
  assert.equal(db.snapshots?.length, 1, '不可新增第二列');
  assert.equal(db.snapshots?.[0]?.netWorth, 999999, '既有的淨值一個字都不可被今天的數字蓋掉');
  assert.equal(db.snapshots?.[0]?.date, far, '既有的日期也不可被改寫');
  assert.equal((db.dailyValues || []).length, 0, '略過時連日線都不可寫（同一道護欄）');
});

test('同月只留一列｜月快照與投組快照連寫兩次都不可累加（重複月份會讓折線在原地來回抖）', async () => {
  // ⚠️ 檔頭第 3 行把「月快照＝同月覆蓋、一個月只留一個點」寫成本檔兩條線的分野。
  //    portfolioSnapshots 這一側前端沒有第二道門：investmentChartConfig 直接把每一列畫成一個點，
  //    重複月份會讓「投入 vs 市值」折線在同一個月來回抖，而且資料庫會無上限長大。
  store.save({
    ...store.emptyDb(),
    accounts: [{ id: 'c1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 10000 }],
  });
  await takeSnapshot();
  // 第二次：改一下資產，確認「留下的是最新那一筆的值」而不是兩列並存
  const db1 = store.load();
  db1.accounts[0].balance = 20000;
  store.save(db1);
  await takeSnapshot();

  const db = store.load();
  const mk = thisMonth();
  const months = (db.snapshots || []).filter((/** @type {any} */ s) => s.month === mk);
  const pfMonths = (db.portfolioSnapshots || []).filter((/** @type {any} */ s) => s.month === mk);
  assert.equal(months.length, 1, '同一個月的月快照只能有一列（同月覆蓋）');
  assert.equal(pfMonths.length, 1, '同一個月的投組快照也只能有一列——這一側前端沒有第二道門');
  assert.equal(months[0].netWorth, 20000, '留下的要是最新那一次的值');
  const days = (db.dailyValues || []).filter((/** @type {any} */ d) => d.date === today());
  assert.equal(days.length, 1, '同一天的日線也只能一列（同日覆寫）');
  assert.equal(days[0].netWorth, 20000, '日線也要是最新那一次的值');
});

test('日線匯率｜設定沒有 usdTwd 時，日線留底的匯率要與算淨值用的同一個（不可兩邊各寫一個字面量）', async () => {
  // ⚠️ 這一行旁邊就註明「與 derive.js fxRates 同口徑（缺值用同一個預設）」——這是真的同步點：
  //    淨值是用某個預設匯率算出來的，日線卻可能把當天的匯率記成別的數字。
  //    日線存三種匯率的理由（Codex r3#10）正是「日後看到淨值變動要分得出是資產漲了還是匯率動了」，
  //    兩邊預設不一致就直接摧毀那個用途。
  // 手法：不比對字面量 32（那樣兩邊各改成 33 也會綠），而是**用行為推算實際套用的匯率**——
  //       持有 1 股單價 100 美元 ⇒ 淨資產 ÷ 100 就是 derive 真正用的匯率。
  store.save({
    ...store.emptyDb(),
    settings: {},                                           // ← 完全沒有 usdTwd
    holdings: [{ id: 'h1', symbol: 'CSPX', name: 'ETF', layer: 'core', currency: 'USD', quantity: 1, price: 100 }],
  });
  const db = store.load();
  const impliedRate = computeAssets(db).netWorth / 100;      // derive 實際套用的美元匯率
  const row = await recordDailyValue();
  assert.ok(impliedRate > 0, '先確認這個推算法有效（淨資產應該是「100 × 匯率」）');
  assert.equal(row.usdTwd, impliedRate,
    `日線記的匯率（${row.usdTwd}）與算淨值時實際用的（${impliedRate}）必須是同一個數字——`
    + '不一致的話，事後看到淨值變動就分不出是資產動了還是匯率動了');
});
