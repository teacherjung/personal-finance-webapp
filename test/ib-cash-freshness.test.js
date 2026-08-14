// 銀行帳戶頁那行「上次 IB 同步 YYYY-MM-DD」**賴以成立的前提**，用真的 `syncIb` 釘住。
//
// 這一題的由來（#454 r1 阻擋①，Codex 抓到）：我第一版寫「IB 同步更新至 X」，
// 等於宣稱那筆餘額更新到那天。但 `lib/services/ib-sync.js` 在 Cash Report 缺失／不完整／
// 幣別不支援時是**刻意沿用舊餘額**（保守路線），而 `lastSync` 是**每次同步結束無條件寫上去的**
// ⇒ 「同步時間前進、餘額其實沒動」是**正常會發生的狀態**，不是異常。
// 拿它冒充當天的數字，正是這支 PR 要消滅的那種謊話，只是換了個殼。
//
// 所以文案只講「上次 IB 同步 X」＝**單純陳述同步這件事**，不對餘額新舊做任何保證。
// ⚠️ 它**也不是上界**（r2 推翻了我原本的講法）：手動改過餘額的話，畫面上的數字反而比那個日期新。
// ⚠️ **這句文案的前提就是本題**：
// 如果哪天 IB 同步改成「拿不到現金報表就不更新 lastSync」或「每個帳戶各存一個時間」，
// 這題會紅，那時文案就可以（也應該）講得更強。**先問「哪條考題會因此轉紅」才敢那樣寫**。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_STORE = join(tmpdir(), `finance-ib-cash-fresh-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { syncIb } = await import('../lib/services/ib-sync.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { balanceAsOfNote } = await import('../public/modules/accounts-model.js');

after(() => {
  for (const suffix of ['', '-wal', '-shm', '.bak']) {
    try { rmSync(TEST_STORE + suffix); } catch { /* 沒有就算了 */ }
  }
});

/** 一份「有持倉、但**沒有** Cash Report」的合成解析結果——IBKR 實際會出的形狀之一。 */
const FEED_WITHOUT_CASH = Object.freeze({
  positions: [],
  trades: [],
  rawTrades: [],
  cashByCurrency: {},
  hasCashReport: false,        // ★這一格是本題的主角
  hasCashDetail: false,
  baseCurrency: 'USD',
});

test('前提｜同步拿不到現金報表時：餘額原封不動，但 lastSync 照樣往前走', async () => {
  const db = await getDb();
  db.accounts = [{ id: 'ib-usd', name: 'IBKR 美元現金', type: 'cash', class: '現金',
    currency: 'USD', ibCashCur: 'USD', balance: 1000 }];
  db.settings = { ...(db.settings || {}), ib: { ...(db.settings?.ib || {}), lastSync: '2026-01-01T00:00:00.000Z' } };
  await saveDb(db);

  await syncIb(/** @type {any} */ (async () => FEED_WITHOUT_CASH));

  const after1 = await getDb();
  const acc = (after1.accounts || []).find(a => a.id === 'ib-usd');
  assert.equal(acc.balance, 1000, '★餘額必須原封不動（沒有現金報表就不猜——ib-sync 的保守路線）');
  assert.notEqual(after1.settings.ib.lastSync, '2026-01-01T00:00:00.000Z',
    '★lastSync 仍然前進了——這就是「同步時間 ≠ 這筆餘額的時間」的實證');

  // ⇒ 因此畫面那行**只能**講「上次 IB 同步」，不可以講「這筆餘額更新到那天」。
  const note = balanceAsOfNote(acc, after1.settings.ib.lastSync);
  assert.equal(note.source, 'ib');
  assert.match(note.text, /^上次 IB 同步 \d{4}-\d{2}-\d{2}$/u,
    '★文案只能陳述同步這件事——不可以順便宣稱這個數字有多新（兩個方向都會對不上）');
  assert.doesNotMatch(note.text, /更新至|更新到/u,
    '★一旦寫成「更新至」，這個情境下畫面就在說謊：餘額是 1000 沒動過，日期卻是今天');
});

test('對照組｜真的拿到現金報表時，餘額才會跟著動（證明上面那題不是因為同步整個沒作用）', async () => {
  const db = await getDb();
  db.accounts = [{ id: 'ib-usd', name: 'IBKR 美元現金', type: 'cash', class: '現金',
    currency: 'USD', ibCashCur: 'USD', balance: 1000 }];
  await saveDb(db);

  await syncIb(/** @type {any} */ (async () => ({
    ...FEED_WITHOUT_CASH, hasCashReport: true, hasCashDetail: true, cashByCurrency: { USD: 2500 },
  })));

  const acc = (await getDb()).accounts.find(a => a.id === 'ib-usd');
  assert.equal(acc.balance, 2500,
    '★有現金報表就要真的更新——不然上一題的「餘額沒動」只是同步整個沒作用，什麼也證明不了');
});
