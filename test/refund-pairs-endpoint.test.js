// GET /api/refund-pairs 端到端（使用者定 2026-07-27）：信用卡費頁靠它做消費歸屬統計與兩端標記。
// 重點＝**與月度回顧同一份配對判準**（同步點），且未對應的退款兩邊都要看得到同一份清單。
// STORE_FILE 指向暫存 SQLite，絕不碰真實資料。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

const TEST_STORE = join(tmpdir(), `finance-refund-pairs-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;

after(() => {
  server.close();
  for (const suffix of ['', '.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suffix); } catch { /* 可能不存在 */ }
  }
});

const card = (id, date, category, amount, note) => ({
  id, date, type: 'expense', ledger: 'card', source: 'stmt', account: '卡A',
  category, subcategory: '', amount, note, storeKey: note, stmtRef: `card-a|${date}|${amount}|${note}`,
});

test('GET /api/refund-pairs：配得到的吐出「原消費月份」，配不到的進未對應清單', async () => {
  store.save({ ...store.emptyDb(), transactions: [
    card('buy', '2026-01-12', '娛樂', 1700, 'Klook'),
    card('refund', '2026-03-16', '娛樂', -1700, 'Klook'),
    card('orphan', '2026-03-20', '保險', -5198, '友邦人壽'),
  ] });

  const res = await fetch(`http://127.0.0.1:${port}/api/refund-pairs`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pairs.length, 1);
  assert.deepEqual(body.pairs[0], {
    refundId: 'refund', refundDate: '2026-03-16', amount: 1700,
    purchaseId: 'buy', purchaseDate: '2026-01-12', purchaseMonth: '2026-01',
  }, '退款要指回原消費那一筆與那個月');
  assert.deepEqual(body.unmatchedRefunds.map((/** @type {any} */ u) => u.id), ['orphan']);
});

test('與月度回顧同一份判準：配對結果一致（同步點，走散就會兩頁抵到不同月）', async () => {
  store.save({ ...store.emptyDb(), transactions: [
    card('buy1', '2026-01-12', '娛樂', 1700, 'Klook'),
    card('buy2', '2026-02-12', '娛樂', 1700, 'Klook'),   // 同額同店 → 只能配到「較早的最近一筆」中的一筆
    card('refund', '2026-03-16', '娛樂', -1700, 'Klook'),
    card('orphan', '2026-03-20', '保險', -5198, '友邦人壽'),
  ] });

  const [pairsBody, reviewBody] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/refund-pairs`).then(r => r.json()),
    fetch(`http://127.0.0.1:${port}/api/monthly-review?month=2026-02`).then(r => r.json()),
  ]);
  // 配到 2 月那筆（退款日之前最近的未配消費）→ 月度回顧的 2 月娛樂應被抵成 0
  assert.equal(pairsBody.pairs.length, 1);
  assert.equal(pairsBody.pairs[0].purchaseId, 'buy2');
  assert.equal(pairsBody.pairs[0].purchaseMonth, '2026-02');
  const feb = (reviewBody.selected?.categories || []).find((/** @type {any} */ c) => c.name === '娛樂');
  assert.equal(feb ? feb.amount : 0, 0, '月度回顧抵的必須是同一個月');
  // 未對應清單兩邊同一份
  assert.deepEqual(
    pairsBody.unmatchedRefunds.map((/** @type {any} */ u) => u.id),
    reviewBody.unmatchedRefunds.items.map((/** @type {any} */ u) => u.id));
});

test('繳卡費的負數不是退款（不可被當成可配對的退款）', async () => {
  store.save({ ...store.emptyDb(), transactions: [
    card('buy', '2026-01-12', '飲食', 800, '餐廳'),
    { id: 'pay', date: '2026-02-15', type: 'expense', ledger: 'card', source: 'stmt', account: '卡A',
      category: '其他', subcategory: '', amount: -800, note: '信用卡自動扣繳', storeKey: '信用卡自動扣繳',
      stmtRef: 'card-a|2026-02-15|-800|信用卡自動扣繳' },
  ] });
  const body = await fetch(`http://127.0.0.1:${port}/api/refund-pairs`).then(r => r.json());
  assert.deepEqual(body.pairs, []);
  assert.deepEqual(body.unmatchedRefunds, []);
});
