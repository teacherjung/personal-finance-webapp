// 快照與日線的「資料安全」考題（Codex 第三輪 r3#1／#8／#10）。
// 這三條的共通點：**都會讓已經寫好的歷史被靜默蓋掉**，而歷史補不回來。
//   #1 IB 同步跨 await 用過期快照整包寫回 → 請求期間別人寫的東西全沒了
//   #8 電腦時間被調回過去 → 同日覆寫/同月覆蓋拿舊資料蓋掉更新的紀錄
//   #10 日線只留美元匯率 → 事後分不出淨值變動是資產動了還是匯率動了
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-snapsafe-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { recordDailyValue, takeSnapshot, takeSnapshotIfDue } = await import('../lib/services/snapshot.js');
const { syncIb } = await import('../lib/services/ib-sync.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

const today = () => { const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** 明天（保證比「今天」新，用來模擬時鐘倒退：資料庫裡有比現在更新的紀錄） */
const tomorrow = () => { const d = new Date(Date.now() + 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

beforeEach(() => {
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: '現金', type: 'cash', currency: 'TWD', balance: 1000 }] });
});

// ---------- r3#1：IB 同步不可用過期快照整包蓋回 ----------

test('IB 同步進行中寫入的日線，同步完成後必須還在（跨 await 不可用過期快照整包蓋回）', async () => {
  // 假的 Flex 回應：在「網路請求進行中」寫一筆日線，模擬使用者同時重新整理頁面觸發 /snapshot/auto
  const fake = async () => {
    await recordDailyValue();                               // ← 請求期間發生的寫入
    assert.equal((store.load().dailyValues || []).length, 1, '前置條件：請求期間確實寫進去了');
    return { positions: [{ symbol: 'CSPX', currency: 'USD', quantity: 10, marketPrice: 500, avgCost: 480 }],
      cashByCurrency: { USD: 1000 }, equity: { stock: 5000, cash: 1000 },
      income: null, trades: [], account: 'TEST', period: {} };
  };
  await syncIb(/** @type {any} */ (fake));

  const db = store.load();
  assert.equal((db.dailyValues || []).length, 1,
    '同步完成後日線必須還在——原本 syncIb 是請求前讀整包、請求後把那份過期快照寫回，這筆會整個消失');
  assert.ok((db.holdings || []).some(h => h.symbol === 'CSPX'), '同時 IB 自己的資料照樣要同步進去');
});

test('IB 同步也不可吃掉請求期間新增的交易（日線會自癒，交易不會）', async () => {
  const fake = async () => {
    const d = store.load();
    (d.transactions = d.transactions || []).push({ id: 'tx-mid', date: today(), type: 'expense',
      category: '飲食', amount: 100, note: '同步進行中記的一筆' });
    store.save(d);
    return { positions: [], cashByCurrency: {}, equity: null, income: null, trades: [], account: 'T', period: {} };
  };
  await syncIb(/** @type {any} */ (fake));
  assert.ok((store.load().transactions || []).some(t => t.id === 'tx-mid'),
    '交易被吃掉不會自己長回來，這是這條被列高風險的原因');
});

// ---------- r3#8：時鐘倒退不可蓋掉更新的歷史 ----------

test('時鐘倒退：自動快照安靜略過，不拿舊資料蓋掉更新的歷史', async () => {
  const db = store.load();
  db.dailyValues = [{ date: tomorrow(), netWorth: 99999, assets: 99999, liabilities: 0 }];
  store.save(db);

  const r = await takeSnapshotIfDue();
  assert.equal(r.recorded, false, '不可寫月快照');
  assert.equal(r.daily, null, '不可寫日線');
  assert.ok(r.skipped, '要回報略過的原因（供前端/log 追查）');
  const rows = store.load().dailyValues || [];
  assert.equal(rows.length, 1, '更新的那筆歷史必須原封不動');
  assert.equal(rows[0].netWorth, 99999, '而且值不可被今天的值蓋掉');
});

test('時鐘倒退：手動按快照鈕要明確擋下並說明（不是安靜略過）', async () => {
  const db = store.load();
  db.dailyValues = [{ date: tomorrow(), netWorth: 99999, assets: 99999, liabilities: 0 }];
  store.save(db);
  await assert.rejects(() => takeSnapshot(), /系統時間/,
    '使用者主動按的動作要看得見錯誤，他才有機會去修電腦時間');
  assert.equal((store.load().dailyValues || []).length, 1, '擋下後不可留下任何寫入');
});

test('時間正常時一切照舊（保護不可誤傷正常情況）', async () => {
  const r = await takeSnapshotIfDue();
  assert.equal(r.recorded, true);
  assert.ok(r.daily && r.daily.date === today());
  assert.equal((store.load().dailyValues || []).length, 1);
});

// ---------- r3#10：三種匯率都要留底 ----------

test('日線留下三種匯率，事後才分得出「資產漲了」還是「匯率動了」', async () => {
  const db = store.load();
  db.settings = { ...db.settings, usdTwd: 31.5, fxTwd: { GBP: 40.8, JPY: 0.215 } };
  store.save(db);
  const row = await recordDailyValue();
  assert.equal(row?.usdTwd, 31.5);
  assert.equal(row?.gbpTwd, 40.8, '系統支援 GBP 資產，只存美元匯率的話英鎊部位的變化解讀不了');
  assert.equal(row?.jpyTwd, 0.215);
});

test('丙｜沒抓到匯率的幣別，日線記「實際採用」的預設值（GBP 40.8／JPY 0.215），不是 0 也不是 null；抓到就記即時值', async () => {
  const { FX_DEFAULT_TWD } = await import('../public/modules/fx-rates.js');
  const db = store.load();
  db.settings = { ...db.settings, usdTwd: 32, fxTwd: {} };
  store.save(db);
  const row = await recordDailyValue();
  assert.equal(row?.gbpTwd, FX_DEFAULT_TWD.GBP, '沒抓到＝記預設值（那就是這天實際用來算淨值的匯率）');
  assert.equal(row?.jpyTwd, FX_DEFAULT_TWD.JPY);
  const saved = (store.load().dailyValues || [])[0];
  assert.equal(saved.gbpTwd, FX_DEFAULT_TWD.GBP, '存進資料庫後也要在');
});

// ---------- 階段三缺口 H2：日線的時鐘倒退護欄（r3#8 只考了月快照與手動按鈕，日線這條沒人考過） ----------

test('日線時鐘倒退護欄：資料庫已有「明天」的日線 → 今天寫入被擋（回 null、一列不增不改）', async () => {
  // 這條護欄壞掉的後果＝VM 還原/時區設錯後開 app，用舊日期覆寫較新的淨值歷史——
  // 程式註解自己說「補不回來」，而 D3 差異引擎的 Δ 全部以這條線為原料。
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: '現金', type: 'cash', currency: 'TWD', balance: 1000 }],
    dailyValues: [{ date: tomorrow(), netWorth: 777 }] });
  const r = await recordDailyValue();
  assert.equal(r, null, '時鐘倒退＝不寫（硬寫會拿舊資料蓋掉更新的歷史）');
  const dv = store.load().dailyValues || [];
  assert.equal(dv.length, 1, '一列不增');
  assert.equal(dv[0].date, tomorrow());
  assert.equal(dv[0].netWorth, 777, '既有的較新紀錄一字未動');
});

test('丙｜emptyDb() 與種子不預填 GBP／JPY 匯率（預設值住在 fx-rates.js 的常數，不進資料庫）', () => {
  assert.deepEqual(store.emptyDb().settings.fxTwd, {}, 'emptyDb 的 fxTwd 要是空的');
  const seed = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8'));
  assert.deepEqual(seed.settings.fxTwd, {}, 'seed.json 的 fxTwd 要是空的');
  const db = store.load(); db.settings = { ...db.settings, fxTwd: {} }; store.save(db);   // 先把同檔前面題留下的匯率清掉
  assert.equal(store.load().settings.fxTwd?.GBP, undefined, 'load() 走 mergeSettingsDefaults 之後仍不可把猜值灌回來');
});

test('丙｜種子不預填 usdTwd：走正式 load() 路徑的新資料庫，美元資產也要標「用了預設值」（不可被種子的 32 冒充成抓到的）', async () => {
  const { buildSummary } = await import('../lib/derive.js');
  const { FX_DEFAULT_TWD } = await import('../public/modules/fx-rates.js');
  assert.equal(store.emptyDb().settings.usdTwd, undefined, 'emptyDb 不可預填 usdTwd');
  const db = store.load();
  delete db.settings.usdTwd;   // 同檔前面的題可能設過；清掉＝模擬從來沒抓到
  db.accounts = [{ id: 'u', name: '美元現金', type: 'cash', class: '現金', currency: 'USD', balance: 10 }];
  store.save(db);
  const loaded = store.load();   // mergeSettingsDefaults 不可把 32 灌回來
  assert.equal(loaded.settings.usdTwd, undefined, 'load() 合併預設後 usdTwd 仍不可出現');
  const s = buildSummary(loaded);
  assert.equal(s.assets, 10 * FX_DEFAULT_TWD.USD, '金額用預設值 32 照算');
  assert.deepEqual(s.defaultFx, [{ currency: 'USD', count: 1, rate: FX_DEFAULT_TWD.USD }], '而且要標「用了預設值」');
});
