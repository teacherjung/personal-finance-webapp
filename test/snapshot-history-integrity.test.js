// 快照與日線的「歷史不可被舊資料蓋掉」考題（夜班稽核第三批B，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢：`lib/services/snapshot.js` 有三處註解寫明理由的規則，
// 弄壞之後 1487 題全綠。三處的共同後果都是**歷史被靜默改寫，而歷史補不回來**。
//
// ⚠️ 與既有 `test/snapshot-safety.test.js` 的分工：那一支守的是「日線那一半」
//    （所有倒退考題都塞 `dailyValues=[明天]`、`snapshots` 是空的）。本支補的是它漏掉的另外三件事：
//    ①倒退護欄**兩條線都要看、取最新的那一條**（只看其中一條、另一條當後備，就會擋不住）
//    ②同月只留一列，**而且留下的那一列內容要換成最新值**（月快照與投組快照兩條線都要）；
//      **同時只准動本月那一列**——本月以外的每一列歷史都一個字都不可以變，不論是被整條線換掉
//      （Codex 審 8152c83）還是被「只保留最近 N 個月」從最舊的那一頭裁掉（自審 r7）。
//      ⚠️ 這件事**兩條路各一題**（自審 r6）：設定頁那顆手動按鈕（`takeSnapshot`）多數人一輩子沒按過，
//      使用者每天真正走的是開 app 的 `takeSnapshotIfDue`，而那條路上**多一道節流閘**——
//      只驗按鈕那條的話，把節流從「今天記過才跳過」放寬成「本月記過就跳過」會讓月快照整個月凍住，
//      而全庫照樣全綠。
//    ③日線留底的匯率要與**同一列那五個金額欄**（netWorth／assets／liabilities／pfValue／pfCost）
//      實際套用的（`lib/derive.js` 算的那個）是**同一個**——前三格走 `computeAssets`、後兩格走 `computeIb`，
//      是兩段各自取匯率的計算，而同一段裡的每一格又是各自獨立的賦值，所以**五格逐格都要對上**
//      （不然事後分不出那格的變動是資產動了還是匯率動了——那正是日線存三種匯率的理由）。
//      ⚠️ 「五格」是**列舉**當下的欄位，不是通則：日線日後多一個金額欄，這裡不會有人提醒。
//
// ⚠️ 「**留底**」一律用 `store.load()` **重讀資料庫**來斷言（Codex r1）：這幾條守的都是
//    「留在資料庫裡的歷史」，而「回傳正確、寫入錯誤」是真的會發生的壞法——初版第三條只驗
//    回傳值，把寫入改成 `usdTwd: 1` 照樣全綠。
//    回傳值仍會驗，但只在它**自己就是契約**的地方：自動流程要回報 `recorded/skipped`、
//    手動按鈕要 throw 400、以及「回傳值必須與留底一致」這條本身。
//
// ⚠️ 每一條題都把「今天」用 `t.mock.timers` 釘死（Codex r2）。**不是為了去 flake，是為了鑑別力**：
//    - ②那兩條要一列「同月、但比今天早」的既有快照，才分得出「以月為鍵」與「以日為鍵」——
//      月快照那一側是去重鍵、自動路那一側是節流鍵，兩處問的是同一個問題。
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

// 收尾清掉 `store.js` 會產生的衍生檔：漏一種就在 os 暫存目錄累積殘檔（初版漏了
// `.pre-ledger-migration.bak`，每跑一次留一顆 28KB）。扣掉 `.pre-sec-contract.bak` 之後的**另外六項**
// 與其他測試檔同一份清單（bank-learning／market-data／cashflow-ledger／codex-r11／bank-statement／
// bank-import-batches／transfer-subcats 用的都是這六項）；`.pre-sec-contract.bak` 是同族的另一顆
// 一次性搬家備份，只有本檔多列這一顆（本檔目前跑不到，先列著）。
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
const PREV_MONTH = '2026-07';   // 「同月覆蓋不可以動到別的月份」用的對照月（見第二條題）

/**
 * 「本月以外」的歷史要**長到涵蓋 30 個月以內的裁切**（自審 r7；原本寫「比任何合理的保留上限還長」
 * 是誇大——實際只保證 N≤30，Codex r3 加上 `slice(-36)` 這一題照樣退出 0、`ℹ fail 0`）：
 * 初版本月以外只放**一列**（前月），
 * 於是「只保留最近 N 個月」式的裁切一個字都驗不到——N≥2 的上限都會同時留下 2026-07 與 2026-08。
 * 實測在 `writeMonthlySnapshot` 的 `saveDb` 之前加兩行
 * `db.snapshots = db.snapshots.slice(-12); db.portfolioSnapshots = db.portfolioSnapshots.slice(-12);`
 * → 全庫全綠。而這個裁切正是最可能被加上的那一手：第二條題的註解自己就寫了「資料庫會無上限長大」，
 * 日後有人為此設保留上限，刪掉的就是本檔題名要守的那份補不回來的歷史。
 * 這裡鋪滿 2024-01〜2026-06 連續 30 個月（加上前月那一列＝本月以外共 31 列）：
 * 儀表板的視窗是「近 12 月」，12 是最可能被挑中的 N；31 讓 N≤30 的任何上限都會轉紅。
 */
const OLDER_MONTHS = Array.from({ length: 30 }, (_, i) => {
  const ord = 2024 * 12 + i;                       // 2024-01 起算的連續月序（一路到 2026-06）
  return `${Math.floor(ord / 12)}-${String((ord % 12) + 1).padStart(2, '0')}`;
});
const HISTORY_MONTHS = OLDER_MONTHS.length + 1;    // ＋前月那一列＝「本月以外」該有的列數

/**
 * 「本月以外」的所有列（＝同月覆蓋一個字都不可以碰的部分），轉成字串好直接比。
 * 從資料庫讀回**正規化後**的樣子再比，才不會被欄位順序/預設值干擾。
 * @param {any[]=} rows
 */
const historyRows = (rows) => JSON.stringify((rows || []).filter((/** @type {any} */ s) => s.month !== MONTH));

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

/**
 * 「同月覆蓋」兩條題共用的 fixture：本月已經有一列**日期比今天早**的月快照（2026-08-01），
 * 外加一組**前月**對照。兩條題的差別只在走哪一條路進來——設定頁按鈕（`takeSnapshot`）
 * 與開 app 自動（`takeSnapshotIfDue`）——所以刻意共用同一份資料：**分得出「以月為鍵」與
 * 「以日為鍵」的 fixture 只有這一種**，兩條路都需要它。
 * fixture 每個成分為什麼非有不可：
 * ⚠️ 要先塞一列**同月、但日期比今天早**的既有快照（Codex r2）：初版兩次呼叫都落在
 *    同一天，於是「以月為鍵去重」與「以日為鍵去重」在那個 fixture 下行為完全相同——把鍵換成
 *    `s.date` 照樣全綠，實際上同一個月會長出好幾列。
 * ⚠️ 要放**持股**（Codex r1）：只放現金帳戶的話 portfolioSnapshots 的 cost/value
 *    前後都是 0，把正式程式改成「同月已有列就保留舊值」照樣全綠——列數對了、投組那條線卻停在
 *    舊值。「同月覆蓋」要驗的是**整列換新**，只數列數驗不到那一半。
 *    幣別全用 TWD（匯率 1）＝期望值可以直接手算；要驗的是有沒有換新值，不是匯率換算。
 * ⚠️ 要放**負債**（自審 r3）：月快照那一列有四個欄位（netWorth／assets／liabilities／byClass），
 *    初版只驗 netWorth，於是「保留同月舊列的 assets/liabilities/byClass、只更新 netWorth」照樣全綠。
 *    有負債才會 assets ≠ netWorth，assets 那格才分得出是不是照抄 netWorth。
 *    ⚠️ 這三格守的是**留底契約**，不是現在畫面上的某張圖（自審 r7 抓到本檔原本寫成
 *    「byClass 是歷史頁資產配置圖唯一的資料來源、停在舊值等於配置圖靜靜說謊」——那個危害是虛構的）：
 *    `snapshots[]` 的 assets／liabilities／byClass 三格**目前在 `lib/` 與 `public/` 全庫沒有任何讀者**。
 *    唯二的資產配置圖讀的都是**即時**資料（`public/modules/dashboard.js` 的 `allocSection(s.byClass)`
 *    吃的是 `buildSummary` 頂層那個 `byClass`＝當下的 `computeAssets`；`public/modules/assets.js` 的
 *    `drawPie(alloc.byClass)` 同理），月快照的下游（`public/modules/dashboard-forest.js snapshotMap`、
 *    `lib/derive.js computeGoalTracking`）只取 month／date／netWorth。
 *    留著斷言的理由是「這一列寫的是那個月的完整樣貌」——日後真的接上歷史配置圖時才不會拿舊值說謊；
 *    現在就宣稱有一張圖在說謊是誇大，而誇大比缺口更糟。
 * ⚠️ 要放**本月以外的歷史**（Codex 審 8152c83＋自審 r7）：初版只放本月資料、斷言也只篩本月，
 *    於是「每次把 `snapshots`／`portfolioSnapshots` 直接換成只含本月的新陣列」——也就是把所有
 *    舊月份刪光——照樣全綠（實測 9/9）。月快照是「一個月一個點」的長期趨勢線，
 *    舊月份沒有任何地方能重算回來，正是本檔題名（歷史不可被舊資料蓋掉）要守的東西。
 *    ⚠️ 而且**不能只放前一個月那一列**（自審 r7）：只有一列時「只保留最近 N 個月」的裁切驗不到，
 *    所以兩條線各再鋪 `OLDER_MONTHS` 那 30 個月（理由與實測繞法見該常數上方）。
 * @returns {{histSnapBefore: string, histPfBefore: string}} 「本月以外每一列都原封不動」的比對基準
 *          （從資料庫讀回**正規化後**的樣子，才不會被欄位順序/預設值干擾）
 */
function seedMonthOverwriteFixture() {
  store.save({
    ...store.emptyDb(),
    accounts: [
      { id: 'c1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 10000 },
      { id: 'l1', name: '房貸', type: 'mortgage', currency: 'TWD', balance: 4000 },   // ← 負債：讓 assets ≠ netWorth
    ],
    holdings: [{ id: 'h1', symbol: '0050', name: 'ETF', layer: 'core', currency: 'TWD', quantity: 10, price: 100, avgCost: 60 }],
    snapshots: [
      // ← 更早的 30 個月（2024-01〜2026-06）：讓「只保留最近 N 個月」的裁切也驗得到
      ...OLDER_MONTHS.map((m, i) => ({ ...snapRow(`${m}-15`, 1000 + i), byClass: { 現金: 1000 + i } })),
      { ...snapRow('2026-07-31', 555), byClass: { 現金: 555 } },   // ← **前月**：同月覆蓋不可以動到它
      // ← 本月、較早日期的既有月快照；byClass 刻意塞一組**看得出是舊的**值（保留舊列時失敗訊息才讀得懂）
      { ...snapRow('2026-08-01', 111), byClass: { 現金: 111 } },
    ],
    portfolioSnapshots: [
      ...OLDER_MONTHS.map((m, i) => ({ month: m, cost: 100 + i, value: 200 + i })),   // ← 同上
      { month: PREV_MONTH, cost: 7, value: 8 },              // ← **前月**：同上
      { month: MONTH, cost: 1, value: 2 },
    ],
    dailyValues: [dayRow('2026-08-02', 111)],               // ← 日線是**跨日累積**：這一列必須活著（對照組）
  });
  // ⚠️ 先斷言本月以外那些列真的進得了資料庫，**而且列數一列不少**：
  //    萬一 fixture 被安檢門擋掉，「原封不動」那條就變成拿 `[]` 比 `[]`＝靜靜通過；
  //    只驗「不是空的」也不夠——被擋掉一半的話，保留上限那一手又會驗不到。
  const before = store.load();
  const histSnapBefore = historyRows(before.snapshots);
  const histPfBefore = historyRows(before.portfolioSnapshots);
  assert.equal(JSON.parse(histSnapBefore).length, HISTORY_MONTHS,
    `前置條件：fixture 裡本月以外的月快照要 ${HISTORY_MONTHS} 列全部存進資料庫（少了的話「原封不動」那條斷言會失去鑑別力）`);
  assert.equal(JSON.parse(histPfBefore).length, HISTORY_MONTHS,
    `前置條件：本月以外的投組快照同樣要 ${HISTORY_MONTHS} 列全部存進資料庫（同上）`);
  // ⚠️ 本月那一列也要斷言真的進得去：它是「以月為鍵 vs 以日為鍵」唯一分得出差別的成分，
  //    被擋掉的話兩條題會退化成「今天第一次記錄」，鑑別力靜靜消失。
  const monthRow = (before.snapshots || []).find((/** @type {any} */ s) => s.month === MONTH);
  assert.equal(monthRow?.date, '2026-08-01', '前置條件：本月那一列既有快照（08-01）要真的存進資料庫，而且日期比釘住的今天早');
  return { histSnapBefore, histPfBefore };
}

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

test('同月只留一列（設定頁按鈕）｜既有的本月快照要被今天這一列換掉（不是多長一列，也不是留著舊值）', async (t) => {
  pinClock(t);
  // ⚠️ 檔頭第 3 行把「月快照＝同月覆蓋、一個月只留一個點」寫成本檔兩條線的分野。
  //    portfolioSnapshots 這一側前端沒有第二道門：investmentChartConfig 直接把每一列畫成一個點，
  //    重複月份會讓「投入 vs 市值」折線在同一個月來回抖，而且資料庫會無上限長大。
  // ⚠️ 本題走的是**設定頁那顆手動按鈕**（`takeSnapshot`）。使用者每天真正走的自動路
  //    （`takeSnapshotIfDue`）多一道節流閘，那是下一條題的事——兩條路都要有題，見下一題的開頭。
  // fixture 的成分與理由集中在 `seedMonthOverwriteFixture()`（與下一條題共用同一份）。
  // 本題另外把第二次呼叫的四個數字全換一組（含負債 4000→6000），驗「整列換新」而不只是列數對。
  const { histSnapBefore, histPfBefore } = seedMonthOverwriteFixture();
  await takeSnapshot();
  // 第二次：現金、負債、股價、成本四個數字全換一組 → 兩條快照線的內容都必須跟著換
  const db1 = store.load();
  db1.accounts[0].balance = 20000;
  db1.accounts[1].balance = 6000;
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
  // 月快照那一列有四個欄位，**四個都要換新**（只驗 netWorth 的話，「保留舊列其他三格」會全綠）
  assert.equal(months[0].netWorth, 17000, '月快照留下的要是最新那一次的值（現金 20000＋持股 10×300－房貸 6000）');
  assert.equal(months[0].assets, 23000, '資產也要換新（20000＋3000）——這一格與 netWorth 不同數字，才驗得出不是照抄 netWorth');
  assert.equal(months[0].liabilities, 6000, '負債也要換新（房貸 4000→6000）：同月覆蓋換掉的是整列，不是只換 netWorth 那一格');
  assert.deepEqual(months[0].byClass, { 現金: 20000, 股票: 3000 },
    'byClass 也要換新（同上）——這一格目前沒有讀者，守的是留底契約：這一列要是那個月的完整樣貌');
  assert.equal(pfMonths[0].value, 3000, '投組快照的市值也要換成最新那一次（10×300）——不是只有列數對');
  assert.equal(pfMonths[0].cost, 1500, '投入成本同理（10×150）：同月覆蓋是換掉整列，不是保留舊列的值');
  const days = (db.dailyValues || []).filter((/** @type {any} */ d) => d.date === TODAY);
  assert.equal(days.length, 1, '同一天的日線也只能一列（同日覆寫）');
  assert.equal(days[0].netWorth, 17000, '日線也要是最新那一次的值');
  assert.equal(days[0].pfValue, 3000, '日線的投組市值同樣要跟上（它與投組快照是各自獨立的一段寫入）');
  const old = (db.dailyValues || []).find((/** @type {any} */ d) => d.date === '2026-08-02');
  assert.ok(old, '⚠️ 日線與月快照的覆蓋粒度不同：同月的舊日線**不可以**被吃掉（那是差異引擎唯一的原料）');
  assert.equal(old.netWorth, 111, '而且舊日線的內容也不可以被今天的數字改寫');
  // 「同月覆蓋」的**範圍**：只准動本月那一列，**本月以外的每一列**一個字都不可以變
  //（Codex 審 8152c83＝整條線被換掉；自審 r7＝只裁掉最舊的幾列）
  assert.equal(historyRows(db.snapshots), histSnapBefore,
    `本月以外的 ${HISTORY_MONTHS} 列月快照必須全部原封不動——把 snapshots 換成「只含本月的新陣列」會刪光所有舊月份，`
    + '「只保留最近 N 個月」的裁切則是從最舊的那一頭刪；兩種刪掉的都是補不回來的歷史');
  assert.equal(historyRows(db.portfolioSnapshots), histPfBefore,
    '本月以外的投組快照同理：同月覆蓋換掉的是本月那一列，不是整條線、也不是「留最近幾列」');

  // 誠實劃界：上面那兩條守的是**月快照兩條線**的保留上限。日線（`dailyValues`）這一側本題只有
  // 一列對照（08-02），擋得住「被今天覆蓋」但擋不住「只保留最近 N 天」——日線是一天一列
  // （一年 365 列），要驗到那種上限得換一種規模的 fixture，本題不涵蓋、也不宣稱涵蓋。
});

test('同月只留一列（開 app 自動路）｜本月那一列是前幾天記的就必須換新：節流的鍵是「日」不是「月」', async (t) => {
  pinClock(t);
  // ⚠️ 為什麼上一條題不夠：它兩次呼叫走的都是 `takeSnapshot()`＝**設定頁那顆手動按鈕**。
  //    使用者每天真正走的是開 app 的 `POST /api/snapshot/auto` → `takeSnapshotIfDue()`，
  //    而那條路上**多一道節流閘**（`lib/services/snapshot.js` 的「已是今天的日期就跳過」），
  //    上一條題一次都沒走到它。
  //    實測把那道閘從「今天記過才跳過」放寬成「本月記過就跳過」（`if (existing) return …`，改一行）→
  //    全庫 1490 題全綠、本支自己的考題也全綠；但月快照會在該月第一次記錄之後**整個月凍住**，
  //    儀表板「近 12 月淨資產」的當月點與「本月淨資產變動」整月停在舊值——正是上一條題名
  //    宣稱要防的「留著舊值」，只是換一條路進來。
  // ⚠️ 既有 `test/daily-values.test.js` 的「開 app 的 auto 流程」分不出這兩種節流語意：
  //    它兩次呼叫都在**同一天內**，第一次 recorded=true、第二次 recorded=false，兩種寫法完全相同。
  //    分得出來的 fixture 只有一種＝**本月已經有一列、而且日期比今天早**，也就是上一條題用的那一份
  //    （所以兩題共用 `seedMonthOverwriteFixture()`）。
  seedMonthOverwriteFixture();

  // ①本月已有 08-01 那一列、釘住的今天是 08-15＝今天還沒記過 → 自動路必須記錄，而且整列換新
  const r1 = await takeSnapshotIfDue();
  assert.equal(r1.recorded, true,
    '本月那一列是 08-01 記的、今天是 08-15＝今天還沒記過，自動路必須記錄——'
    + '節流的鍵是「日」不是「月」；放寬成「本月記過就跳過」的話，月快照會從該月第一次記錄起整個月凍住');
  const afterFirst = store.load();
  const m1 = (afterFirst.snapshots || []).filter((/** @type {any} */ s) => s.month === MONTH);
  assert.equal(m1.length, 1, '同月仍然只留一列（自動路寫入也是同月覆蓋）');
  assert.equal(m1[0].date, TODAY, '而且留下的要是今天這一列，不是既有的 08-01');
  // 舊列＝netWorth/assets 111、liabilities 0、byClass {現金:111}：四個欄位每一個都必須換掉
  assert.equal(m1[0].netWorth, 7000, '淨值要換新（現金 10000＋持股 10×100－房貸 4000）');
  assert.equal(m1[0].assets, 11000, '資產也要換新（10000＋1000）——這一格與 netWorth 不同數字，才驗得出不是照抄 netWorth');
  assert.equal(m1[0].liabilities, 4000, '負債也要換新（舊列是 0）');
  assert.deepEqual(m1[0].byClass, { 現金: 10000, 股票: 1000 },
    'byClass 也要換新（舊列是 {現金:111}）——留底契約：這一列要是那個月的完整樣貌（理由見 fixture 的說明）');
  const pf1 = (afterFirst.portfolioSnapshots || []).filter((/** @type {any} */ s) => s.month === MONTH);
  assert.equal(pf1.length, 1, '投組快照同月也只留一列');
  assert.deepEqual({ cost: pf1[0].cost, value: pf1[0].value }, { cost: 600, value: 1000 },
    '投組那一列也要換新（成本 10×60、市值 10×100；舊列是 1／2）');

  // ②同一天內再開一次 app：這時才該跳過——**節流本身仍然要在**。
  //   少了這一半，把節流整道刪掉也會通過①；而那會讓每次開 app 都重寫月快照、前端每次都跳提示。
  const db1 = store.load();
  db1.accounts[0].balance = 20000;              // 白天改了一筆資產：日線要跟上、月快照這一天不再重記
  store.save(db1);
  const r2 = await takeSnapshotIfDue();
  assert.equal(r2.recorded, false, '同一天第二次開 app 不重複記月快照');
  const m2 = (store.load().snapshots || []).filter((/** @type {any} */ s) => s.month === MONTH);
  assert.equal(m2.length, 1, '同月依然只有一列');
  assert.equal(m2[0].netWorth, 7000,
    '而且月快照停在今天第一次記的值——節流是真的擋住了寫入，不是只把回傳值報成 recorded=false');
  assert.equal(r2.daily?.netWorth, 17000, '日線則必須跟上最新（20000＋1000－4000）：月快照跳過≠日線跳過');

  // 誠實劃界：本題不重複驗「本月以外的歷史原封不動」——自動路與手動路寫入用的是同一個 `writeMonthlySnapshot`，
  // 那一半由上一條題守住；本題守的是它前面那道節流閘。
});

test('日線匯率｜留底的匯率要與同一列五個金額欄實際用的同一個：沒設定時走同一個預設、使用者設過就要用設定值', async (t) => {
  pinClock(t);
  // ⚠️ 這一行旁邊就註明「與 derive.js fxRates 同口徑（缺值用同一個預設）」——這是真的同步點：
  //    淨值是用某個匯率算出來的，日線卻可能把當天的匯率記成別的數字。
  //    日線存三種匯率的理由（Codex r3#10）正是「日後看到淨值變動要分得出是資產漲了還是匯率動了」，
  //    兩邊不一致就直接摧毀那個用途。
  // 手法：**用行為回推實際套用的匯率**——fixture 裡的資產、負債、持股全部是美元，
  //       所以「這一列存的某個金額欄 ÷ 該欄的美元面額」就是寫它的當下真正套用的匯率。**兩種**斷言分工
  //       （ⓐ一條、ⓑ五條——每個金額欄一條）：
  //       ⓐ回推值＝這個 fixture 應該套用的匯率（沒有這條的話，兩端一起寫死 32 會過關）
  //       ⓑ回推值＝同一列的 `usdTwd`（這條完全不碰字面量，只問兩邊是不是同一個數字）
  // ⚠️ 同一列的**五個金額欄逐格各自回推一次**（Codex r3）：`netWorth`／`assets`／`liabilities` 走
  //    `computeAssets`、`pfValue`／`pfCost` 走 `computeIb`，是**兩段各自取匯率的計算**；
  //    而同一段裡的每一格又是各自獨立的一個 `Math.round(...)` 賦值，所以**同段之內也擋不住彼此**。
  //    實測兩顆繞法（都是「一格用另一個匯率、其餘照設定」，後果同型）：
  //    ‧把 `const ib = computeIb(db);` 改成 `computeIb({ ...db, settings: { ...db.settings, usdTwd: 32 } })`
  //      → 只釘淨值那一格時全庫全綠（投組那條線失效）
  //    ‧把 `assets:` 那一格改成用固定 32 算出來的值、其餘照設定 33.5 → 只釘淨值＋投組兩格時
  //      全庫 1491 題全綠、退出 0（Codex r3 實際打進來的那一顆：assets 與 netWorth 是分開的兩個賦值）
  //    後果都一樣：日後回推「是資產動了還是匯率動了」，被漏掉那一欄就分不出來。
  // ⚠️ 五格的美元面額刻意**兩兩不同**（assets 150／liabilities 20／netWorth 130／pfValue 100／pfCost 60）：
  //    面額相同的兩格互相照抄時，回推出來的匯率一模一樣、驗不出來；兩兩不同才連「欄位抄錯欄位」
  //    也一起擋住（實測把 `assets:` 那一格改成 `Math.round(a.netWorth)` → 本檔轉紅，
  //    資產回推 27.73、應該是 32）。
  // ⚠️ 而**美元負債**是這份 fixture 非有不可的成分：沒有它 `liabilities` 恆為 0，那一格用哪個匯率
  //    換算出來都還是 0＝匯率錯了也沒有任何可觀察的差別，負債那條斷言等於沒驗；
  //    有了它，`computeAssets` 那三格的面額才互不相同（150／20／130）、三格各自有鑑別力。
  // ⚠️ 這兩個數字**都要從資料庫的同一列讀**（Codex 審 8152c83）：初版是呼叫前先跑一次外部
  //    `computeAssets(db)` 推匯率、事後只比 `saved.usdTwd`——那驗的是「helper 在呼叫前算什麼」，
  //    不是「這一列的淨值是用什麼匯率算出來的」。實測把 `recordDailyValue()` 算淨值那一端的美元
  //    固定成 32、留底照樣寫設定值 33.5（存成 netWorth=3200／usdTwd=33.5），9 題全綠——
  //    而那正好就是本題宣稱要防的病。改成兩個數字都讀同一列之後，case ② 當場轉紅
  //    （ⓐ ⓑ 都成立，先撞到的是 ⓐ：回推 32、應該是 33.5）。
  // ⚠️ 而且要**重讀資料庫**、不看回傳值（Codex r1）：初版斷言 `row.usdTwd`，把正式路徑改成
  //    「回傳正確的 row、卻把 usdTwd: 1 寫進去」時全庫考題仍然全綠。留底留的是資料庫那一份，
  //    日後翻日線讀到的也是它——回傳值只是這一次呼叫端手上的副本。
  // ⚠️ 兩個 case 缺一不可（Codex r2）：只跑 `settings: {}` 的話，「正確值」「預設字面量 32」
  //    「留底」三者剛好都是 32，斷言分不出寫進去的數字是從哪個來源來的——把寫入改成寫死 32
  //    照樣全綠，而使用者一旦設過匯率（報價更新就會寫 `settings.usdTwd`，那是常態）留底就會錯。
  //    有了第二個 case，「兩邊各寫一個字面量」一定會有一邊轉紅。
  /**
   * 這個 fixture 下每個金額欄的**美元面額**＝回推匯率用的除數（兩兩不同，理由見上方）：
   * 美元現金 50 ＋ 持股 1×100 ＝ assets 150；美元貸款 20 ＝ liabilities；相減 ＝ netWorth 130；
   * 持股市值 100、成本 1×60 ＝ 投組那兩格。
   */
  const USD_FACE = { netWorth: 130, assets: 150, liabilities: 20, pfValue: 100, pfCost: 60 };
  /**
   * @param {any} settings @param {number} expectRate 這個 fixture 下 derive 應該套用的匯率
   * @param {string} label
   */
  const check = async (settings, expectRate, label) => {
    store.save({
      ...store.emptyDb(),
      settings,
      accounts: [
        { id: 'c1', name: '美元現金', type: 'cash', class: '現金', currency: 'USD', balance: 50 },
        // ← 美元**負債**（Codex r3）：理由見上方（沒有它 liabilities 恆為 0、assets 又會等於 netWorth）
        { id: 'l1', name: '美元貸款', type: 'mortgage', currency: 'USD', balance: 20 },
      ],
      holdings: [{ id: 'h1', symbol: 'CSPX', name: 'ETF', layer: 'core', currency: 'USD', quantity: 1, price: 100, avgCost: 60 }],
    });
    const row = await recordDailyValue();
    const saved = (store.load().dailyValues || []).find((/** @type {any} */ d) => d.date === TODAY);
    assert.ok(saved, `${label}：今天這一列要真的落在資料庫裡（沒寫進去就沒有留底可言）`);
    const appliedRate = saved.netWorth / USD_FACE.netWorth;   // 這一列的淨值回推出「寫它的時候實際套用的美元匯率」
    assert.equal(appliedRate, expectRate,
      `${label}：這一列存的淨值（${saved.netWorth}）回推出實際套用的匯率是 ${appliedRate}，但這個 fixture 應該套用 ${expectRate}`
      + '——算淨值那一端沒有照設定值走（少了這條，兩端一起寫死 32 也會通過）');
    assert.equal(saved.usdTwd, appliedRate,
      `${label}：資料庫裡日線記的匯率（${saved.usdTwd}）與**同一列**淨值實際用的（${appliedRate}）必須是同一個數字——`
      + '不一致的話，事後看到淨值變動就分不出是資產動了還是匯率動了');
    // 同一列剩下的四格逐格回推：`computeAssets` 那一段的 assets／liabilities 與 netWorth 是三個
    // 分開的賦值，`computeIb` 那一段又是另一次取匯率——四格全部要與這一列的 `usdTwd` 對得上
    assert.equal(saved.assets / USD_FACE.assets, saved.usdTwd,
      `${label}：這一列的資產（${saved.assets}）回推出的匯率是 ${saved.assets / USD_FACE.assets}，與同一列記的 ${saved.usdTwd} 不同——`
      + '資產是與淨值分開寫進去的另一個賦值（Codex r3 打中的就是這一格）：只釘淨值時「資產用 32、其餘用 33.5」全庫全綠');
    assert.equal(saved.liabilities / USD_FACE.liabilities, saved.usdTwd,
      `${label}：這一列的負債（${saved.liabilities}）回推出的匯率是 ${saved.liabilities / USD_FACE.liabilities}，`
      + `與同一列記的 ${saved.usdTwd} 不同——負債也是各自一個賦值，換算用錯匯率會讓事後看到的「負債變動」是假的`);
    assert.equal(saved.pfValue / USD_FACE.pfValue, saved.usdTwd,
      `${label}：這一列的投組市值（${saved.pfValue}）回推出的匯率是 ${saved.pfValue / USD_FACE.pfValue}，與同一列記的 ${saved.usdTwd} 不同——`
      + '同一天的淨值用一個匯率、投組市值用另一個，日後就分不出投組的變動是資產動了還是匯率動了');
    assert.equal(saved.pfCost / USD_FACE.pfCost, saved.usdTwd,
      `${label}：投入成本（${saved.pfCost}）回推出的匯率是 ${saved.pfCost / USD_FACE.pfCost}，與同一列記的 ${saved.usdTwd} 不同（同上）`);
    assert.equal(row?.usdTwd, saved.usdTwd, `${label}：回傳值要與留底一致（呼叫端當下看到的與日後讀到的不可以是兩個數字）`);
  };

  // ①完全沒有 usdTwd：走「預設值」那條路，兩邊必須是同一個預設
  await check({}, 32, '設定裡沒有 usdTwd');
  // ②使用者設過（報價更新就會寫進 settings.usdTwd）：留底必須跟著設定值走，不可以是任何字面量
  //   33.5 是刻意挑的：二進位可精確表示，五格的面額（150／20／130／100／60）乘上去都還是整數，
  //   回推不會多出浮點尾數。
  await check({ usdTwd: 33.5 }, 33.5, '使用者設過匯率（33.5）');

  // 誠實劃界：這條題只驗**美元**那一格匯率。`gbpTwd`/`jpyTwd` 兩格由 test/snapshot-safety.test.js 釘
  //（缺匯率記 null），本題不宣稱擋得住那兩格。
});
