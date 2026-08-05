// 快照與日線的「歷史不可被舊資料蓋掉」考題（夜班稽核第三批B，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢：`lib/services/snapshot.js` 有三處註解寫明理由的規則，
// 弄壞之後 1487 題全綠。三處的共同後果都是**歷史被靜默改寫，而歷史補不回來**。
//
// ⚠️ 與既有 `test/snapshot-safety.test.js` 的分工：那一支守的是「日線那一半」
//    （所有倒退考題都塞 `dailyValues=[明天]`、`snapshots` 是空的）。本支補的是它漏掉的另外三件事：
//    ①倒退護欄**兩條線都要看、取最新的那一條**（只看其中一條、另一條當後備，就會擋不住）
//    ②同月只留一列，**而且留下的那一列內容要換成最新值**（月快照與投組快照兩條線都要）
//    ③日線留底的匯率要與 `lib/derive.js` 算淨值時用的**同一個**（不然事後分不出
//      淨值變動是資產動了還是匯率動了——那正是日線存三種匯率的理由）。
//
// ⚠️ 「**留底**」一律用 `store.load()` **重讀資料庫**來斷言（Codex r1）：這三條守的都是
//    「留在資料庫裡的歷史」，而「回傳正確、寫入錯誤」是真的會發生的壞法——初版第三條只驗
//    回傳值，把寫入改成 `usdTwd: 1` 照樣全綠。
//    回傳值仍會驗，但只在它**自己就是契約**的地方：自動流程要回報 `recorded/skipped`、
//    手動按鈕要 throw 400、以及「回傳值必須與留底一致」這條本身。
//
// ⚠️ 三條題都把「今天」用 `t.mock.timers` 釘死（Codex r2）。**不是為了去 flake，是為了鑑別力**：
//    - 第二條要一列「同月、但比今天早」的既有快照才分得出「以月為鍵去重」與「以日為鍵去重」。
//      跟著真實時鐘跑的話，每個月 1 號那天本月不存在更早的日期，兩種寫法行為完全相同——
//      考題會在 30 天裡有 1 天安靜地失去鑑別力，而那種「今天剛好驗不到」最難被發現。
//    - 第一條要那筆未來紀錄剛好落在**同一個月**，才能重現真正的後果：繞過護欄之後那一列
//      不是多一列，是被同月覆蓋**整列吃掉**（+30 天的相對日期只有月底那幾天才會同月）。
//    釘住之後 fixture 全部寫成字面日期，讀的人不必在腦裡算相對日期。
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

// 收尾清掉 `store.js` 會產生的衍生檔：漏一種就在 os 暫存目錄累積殘檔（初版漏了
// `.pre-ledger-migration.bak`，每跑一次留一顆 28KB）。前六項與其他測試檔同一份清單，
// `.pre-sec-contract.bak` 是同族的另一顆一次性搬家備份（本檔目前跑不到，先列著）。
// ⚠️ 這是**列舉**，不是通則：`store.js` 日後多長一種後綴，這裡不會有人提醒——
//    只有「暫存目錄開始累積殘檔」會顯示出來。
after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '.pre-sec-contract.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

/** 釘死的「今天」＝本地時間 2026-08-15 中午（用本地年月日建構，任何時區都落在 08-15）。 */
const FIXED_NOW = () => new Date(2026, 7, 15, 12, 0, 0);
const TODAY = '2026-08-15';
const MONTH = '2026-08';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/**
 * 釘住時鐘並**當場驗證真的釘住了**。少了這行驗證，`mock.timers` 哪天失效（Node 換 API、
 * 參數打錯）時，fixture 裡的字面日期會靜靜變成「相對真實今天的過去或未來」，
 * 三條題可能還是綠的、但驗到的已經不是原本要驗的東西。
 * @param {import('node:test').TestContext} t
 */
function pinClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_NOW() });
  assert.equal(today(), TODAY, '前置條件：時鐘要真的被釘在 2026-08-15（沒釘住的話整檔 fixture 的日期意義全變）');
}

/** @param {string} date @param {number} netWorth */
const snapRow = (date, netWorth) => ({ month: date.slice(0, 7), date, netWorth, assets: netWorth, liabilities: 0, byClass: {} });
/** @param {string} date @param {number} netWorth */
const dayRow = (date, netWorth) => ({ date, netWorth, assets: netWorth, liabilities: 0,
  pfCost: 0, pfValue: 0, usdTwd: 32, gbpTwd: 0, jpyTwd: 0 });

beforeEach(() => { store.save({ ...store.emptyDb() }); });

test('時鐘倒退｜護欄要同時看 dailyValues 與 snapshots、取最新的那一條；哪一條較新都要擋', async (t) => {
  pinClock(t);
  // ⚠️ 既有考題（snapshot-safety 四條）全部是「dailyValues 有未來、snapshots 是空的」這一種形狀，
  //    所以「兩條線取最大」被改成「日線優先、月快照只當後備」時 1487 題全綠。
  //    後果不是「護欄變弱」而是歷史真的被刪：日線最新停在 2020-01-01、月快照有一筆 2026-08-20 時，
  //    護欄放行 → `writeMonthlySnapshot` 以月為鍵覆蓋 → 那筆 08-20 被**整列吃掉**。
  //    下面三個 fixture 把三種形狀都排出來，任何一種「只看一條線」的寫法都會有一個 case 轉紅。
  const FUTURE = '2026-08-20';                             // 比釘住的今天晚，且刻意同一個月（＝會被同月覆蓋吃掉）
  const OLD = '2020-01-01';                                // 舊到不可能誤判成未來

  /**
   * 手動按鈕要 throw 400、自動流程要略過，而且資料庫**一個字都不可以變**。
   * @param {string} label @param {any[]} dailyValues @param {any[]} snapshots
   */
  const mustBlock = async (label, dailyValues, snapshots) => {
    store.save({ ...store.emptyDb(),
      accounts: [{ id: 'c1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 10 }],
      dailyValues, snapshots });
    const before = store.load();                            // 從資料庫讀回正規化後的樣子再比，才不會被欄位順序/預設值干擾
    const beforeSnaps = JSON.stringify(before.snapshots || []);
    const beforeDays = JSON.stringify(before.dailyValues || []);

    // 手動按鈕：要明確 throw 400 並說明（使用者主動按的動作要看得見，他才有機會去修系統時間）
    const err = await takeSnapshot().then(() => null, (/** @type {any} */ e) => e);
    assert.ok(err, `${label}：資料庫裡最新的一天在未來（＝時鐘倒退），手動快照必須擋下來`);
    assert.equal(err.status, 400, `${label}：要是 400（使用者輸入/環境問題），不是 500`);
    assert.match(err.message, /比已經記錄的最新資料/, `${label}：訊息要說清楚是時間問題`);

    // 自動流程（開 app）：安靜略過，但一個字都不可以改到既有紀錄
    const r = await takeSnapshotIfDue();
    assert.equal(r.recorded, false, `${label}：自動流程要略過`);
    assert.equal(r.skipped, FUTURE, `${label}：要回報「因為資料庫裡最新的一天是哪天」而略過（＝兩條線裡最新的那個日期）`);

    const db = store.load();
    assert.equal(JSON.stringify(db.snapshots || []), beforeSnaps,
      `${label}：月快照整條線一個字都不可以變——放行的話 ${FUTURE} 這一列會被同月覆蓋整列吃掉，那是補不回來的歷史`);
    assert.equal(JSON.stringify(db.dailyValues || []), beforeDays,
      `${label}：日線也不可以寫（同一道護欄；略過就是整批略過，不是只略過月快照）`);
  };

  // ①還原一份舊備份之後的形狀：只有月快照、日線是空的（既有考題完全沒有這一種）
  await mustBlock('只有月快照、日線是空的', [], [snapRow(FUTURE, 999999)]);
  // ②兩條線都有值、**月快照那一側較新**：殺「日線優先、月快照只當後備」
  await mustBlock('兩條線都有值、月快照較新', [dayRow(OLD, 5)], [snapRow(FUTURE, 999999)]);
  // ③反過來：日線較新、月快照是舊的：殺「月快照優先、日線只當後備」
  await mustBlock('兩條線都有值、日線較新', [dayRow(FUTURE, 999999)], [snapRow(OLD, 5)]);

  // 誠實劃界：這條題驗的是 `dailyValues` 與 `snapshots` 兩條線。`portfolioSnapshots` 沒有 `date` 欄，
  // 護欄本來就看不到它（它只跟著月快照一起寫），本題不涵蓋、也不宣稱涵蓋。
});

test('同月只留一列｜既有的本月快照要被今天這一列換掉（不是多長一列，也不是留著舊值）', async (t) => {
  pinClock(t);
  // ⚠️ 檔頭第 3 行把「月快照＝同月覆蓋、一個月只留一個點」寫成本檔兩條線的分野。
  //    portfolioSnapshots 這一側前端沒有第二道門：investmentChartConfig 直接把每一列畫成一個點，
  //    重複月份會讓「投入 vs 市值」折線在同一個月來回抖，而且資料庫會無上限長大。
  // ⚠️ fixture 一定要先塞一列**同月、但日期比今天早**的既有快照（Codex r2）：初版兩次呼叫都落在
  //    同一天，於是「以月為鍵去重」與「以日為鍵去重」在那個 fixture 下行為完全相同——把鍵換成
  //    `s.date` 照樣全綠，實際上同一個月會長出好幾列。
  // ⚠️ fixture 也一定要放**持股**（Codex r1）：只放現金帳戶的話 portfolioSnapshots 的 cost/value
  //    前後都是 0，把正式程式改成「同月已有列就保留舊值」照樣全綠——列數對了、投組那條線卻停在
  //    舊值。「同月覆蓋」要驗的是**整列換新**，只數列數驗不到那一半。
  //    幣別全用 TWD（匯率 1）＝期望值可以直接手算；本題要驗的是有沒有換新值，不是匯率換算。
  store.save({
    ...store.emptyDb(),
    accounts: [{ id: 'c1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 10000 }],
    holdings: [{ id: 'h1', symbol: '0050', name: 'ETF', layer: 'core', currency: 'TWD', quantity: 10, price: 100, avgCost: 60 }],
    snapshots: [snapRow('2026-08-01', 111)],                // ← 本月、較早日期的既有月快照
    portfolioSnapshots: [{ month: MONTH, cost: 1, value: 2 }],
    dailyValues: [dayRow('2026-08-02', 111)],               // ← 日線是**跨日累積**：這一列必須活著（對照組）
  });
  await takeSnapshot();
  // 第二次：現金、股價、成本三個數字全換一組 → 兩條快照線的內容都必須跟著換
  const db1 = store.load();
  db1.accounts[0].balance = 20000;
  db1.holdings[0].price = 300;
  db1.holdings[0].avgCost = 150;
  store.save(db1);
  await takeSnapshot();

  const db = store.load();
  const months = (db.snapshots || []).filter((/** @type {any} */ s) => s.month === MONTH);
  const pfMonths = (db.portfolioSnapshots || []).filter((/** @type {any} */ s) => s.month === MONTH);
  assert.equal(months.length, 1,
    '同一個月的月快照只能有一列（同月覆蓋）——fixture 裡已經有一列 2026-08-01，改用日期當去重鍵的話這裡會是 2 列');
  assert.equal(months[0].date, TODAY, '留下來的要是今天這一列（不是把既有的 08-01 留著、也不是兩列都留）');
  assert.equal(pfMonths.length, 1, '同一個月的投組快照也只能有一列——這一側前端沒有第二道門');
  assert.equal(months[0].netWorth, 23000, '月快照留下的要是最新那一次的值（現金 20000＋持股 10×300）');
  assert.equal(pfMonths[0].value, 3000, '投組快照的市值也要換成最新那一次（10×300）——不是只有列數對');
  assert.equal(pfMonths[0].cost, 1500, '投入成本同理（10×150）：同月覆蓋是換掉整列，不是保留舊列的值');
  const days = (db.dailyValues || []).filter((/** @type {any} */ d) => d.date === TODAY);
  assert.equal(days.length, 1, '同一天的日線也只能一列（同日覆寫）');
  assert.equal(days[0].netWorth, 23000, '日線也要是最新那一次的值');
  assert.equal(days[0].pfValue, 3000, '日線的投組市值同樣要跟上（它與投組快照是各自獨立的一段寫入）');
  const old = (db.dailyValues || []).find((/** @type {any} */ d) => d.date === '2026-08-02');
  assert.ok(old, '⚠️ 日線與月快照的覆蓋粒度不同：同月的舊日線**不可以**被吃掉（那是差異引擎唯一的原料）');
  assert.equal(old.netWorth, 111, '而且舊日線的內容也不可以被今天的數字改寫');
});

test('日線匯率｜留底的匯率要與算淨值用的同一個：沒設定時走同一個預設、使用者設過就要用設定值', async (t) => {
  pinClock(t);
  // ⚠️ 這一行旁邊就註明「與 derive.js fxRates 同口徑（缺值用同一個預設）」——這是真的同步點：
  //    淨值是用某個匯率算出來的，日線卻可能把當天的匯率記成別的數字。
  //    日線存三種匯率的理由（Codex r3#10）正是「日後看到淨值變動要分得出是資產漲了還是匯率動了」，
  //    兩邊不一致就直接摧毀那個用途。
  // 手法：不比對字面量（那樣兩邊各改成 33 也會綠），而是**用行為推算實際套用的匯率**——
  //       持有 1 股單價 100 美元 ⇒ 淨資產 ÷ 100 就是 derive 真正用的匯率。
  // ⚠️ 而且要**重讀資料庫**、不看回傳值（Codex r1）：初版斷言 `row.usdTwd`，把正式路徑改成
  //    「回傳正確的 row、卻把 usdTwd: 1 寫進去」時全庫考題仍然全綠。留底留的是資料庫那一份，
  //    日後翻日線讀到的也是它——回傳值只是這一次呼叫端手上的副本。
  // ⚠️ 兩個 case 缺一不可（Codex r2）：只跑 `settings: {}` 的話，「正確值」「預設字面量 32」
  //    「留底」三者剛好都是 32，斷言分不出寫進去的數字是從哪個來源來的——把寫入改成寫死 32
  //    照樣全綠，而使用者一旦設過匯率（報價更新就會寫 `settings.usdTwd`，那是常態）留底就會錯。
  //    有了第二個 case，「兩邊各寫一個字面量」一定會有一邊轉紅。
  /**
   * @param {any} settings @param {number} expectRate 這個 fixture 下 derive 應該套用的匯率
   * @param {string} label
   */
  const check = async (settings, expectRate, label) => {
    store.save({
      ...store.emptyDb(),
      settings,
      holdings: [{ id: 'h1', symbol: 'CSPX', name: 'ETF', layer: 'core', currency: 'USD', quantity: 1, price: 100 }],
    });
    const db = store.load();
    const impliedRate = computeAssets(db).netWorth / 100;    // derive 實際套用的美元匯率
    assert.equal(impliedRate, expectRate,
      `${label}：前置條件——derive 這個 fixture 下實際套用的匯率必須是 ${expectRate}（不是的話這個 case 就沒有鑑別力了）`);
    const row = await recordDailyValue();
    const saved = (store.load().dailyValues || []).find((/** @type {any} */ d) => d.date === TODAY);
    assert.ok(saved, `${label}：今天這一列要真的落在資料庫裡（沒寫進去就沒有留底可言）`);
    assert.equal(saved.usdTwd, impliedRate,
      `${label}：資料庫裡日線記的匯率（${saved.usdTwd}）與算淨值時實際用的（${impliedRate}）必須是同一個數字——`
      + '不一致的話，事後看到淨值變動就分不出是資產動了還是匯率動了');
    assert.equal(row?.usdTwd, saved.usdTwd, `${label}：回傳值要與留底一致（呼叫端當下看到的與日後讀到的不可以是兩個數字）`);
  };

  // ①完全沒有 usdTwd：走「預設值」那條路，兩邊必須是同一個預設
  await check({}, 32, '設定裡沒有 usdTwd');
  // ②使用者設過（報價更新就會寫進 settings.usdTwd）：留底必須跟著設定值走，不可以是任何字面量
  //   33.5 是刻意挑的：二進位可精確表示，`netWorth / 100` 回推不會多出浮點尾數。
  await check({ usdTwd: 33.5 }, 33.5, '使用者設過匯率（33.5）');

  // 誠實劃界：這條題只驗**美元**那一格。`gbpTwd`/`jpyTwd` 目前缺值寫 0、derive 缺值用 40.8／0.215，
  // 兩邊本來就不同口徑（已知落差，不是本 PR 要改的東西）——本題擋不住那兩格，也不宣稱擋得住。
});
