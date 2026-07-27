// 退款配對：彙總鑰匙不可讓不同店家錯配（Codex 複審 2026-07-26 抓到，端到端）。
//
// 病根：月度回顧的退款配對用 [卡片, storeKey, 金額] 找「退款日前最近的同額消費」。
// 加油站（2026-07-18 起）與停車費（2026-07-26 起）是**彙總鑰匙**——所有站共用一把 →
// 退六月嘟嘟房那筆，會被算到七月普客二四頭上（六月仍記 40、七月變 0）＝金額歸錯月份。
// ⚠️ 實測確認：同型錯配在**加油站上早就存在**（不是停車改動造成的），本檔一併鎖住。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-refund-agg-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { getDb, saveDb } = await import('../lib/repo.js');
const { consumptionByMonth } = await import('../lib/derive.js');
const { storeKeyOf } = await import('../lib/statement.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

/** 三筆同卡、同額、跨月的合成消費／退款；回傳六月與七月的交通合計與未對應退款數。 */
async function review(rows) {
  const db = await getDb();
  db.cards = [{ id: 'c1', name: '合成卡', type: 'credit', lastFour: '9001' }];   // 合成末四碼（假值）
  db.transactions = rows.map(([date, desc, amount, sub], i) => ({
    id: `t${i}`, date, type: 'expense', category: '交通', subcategory: sub,
    amount, account: '合成卡', note: desc, storeKey: storeKeyOf(desc),
    stmtRef: `c1|${date}|${amount}|${desc}`, source: 'stmt', ledger: 'card',
    ...(amount < 0 ? { refundOf: null } : {}),
  }));
  await saveDb(db);
  const r = consumptionByMonth(await getDb());
  return {
    jun: r.byMonth?.['2026-06']?.['交通']?.total ?? 0,
    jul: r.byMonth?.['2026-07']?.['交通']?.total ?? 0,
    unmatched: r.unmatchedRefunds.length,
    keys: [...new Set((await getDb()).transactions.map(t => t.storeKey))],
  };
}

test('停車：跨月、同卡、同額、不同停車場的退款不可錯配（Codex 複審重現）', async () => {
  const r = await review([
    ['2026-06-01', '嘟嘟房-台北101', 40, '停車費'],
    ['2026-07-09', '聯信-台灣普客二四股份有A0145 TAIPEI', 40, '停車費'],
    ['2026-07-10', '新北市停車費退費C-30***H8', -40, '停車費'],
  ]);
  assert.deepEqual(r.keys, ['停車費'], '前提：三筆的身分鑰匙確實都被彙總成「停車費」');
  assert.equal(r.jun, 40, '六月那筆不是被退的那一筆，金額必須留著');
  assert.equal(r.jul, 40, '七月普客二四那筆不可被別家店的退款抵掉');
  assert.equal(r.unmatched, 1, '證明不了原消費 → 列未對應退款（無法證明就不猜）');
});

test('加油：同型錯配（main 既有）也一併擋住', async () => {
  const r = await review([
    ['2026-06-01', '中油-泰山站(D2158)TAIPEI', 40, '油錢'],
    ['2026-07-09', '台亞林口中山站', 40, '油錢'],
    ['2026-07-10', '中油-新店站TAIPEI', -40, '油錢'],
  ]);
  assert.deepEqual(r.keys, ['加油站']);
  assert.equal(r.jun, 40);
  assert.equal(r.jul, 40);
  assert.equal(r.unmatched, 1);
});

test('同一站／同一場的退款仍然配得到（不可因為修錯配而全部不配）', async () => {
  const gas = await review([
    ['2026-06-01', '中油-泰山站(D2158)TAIPEI', 40, '油錢'],
    ['2026-07-09', '台亞林口中山站', 40, '油錢'],
    ['2026-07-10', '中油-泰山站(D2158)TAIPEI', -40, '油錢'],
  ]);
  assert.equal(gas.jun, 0, '退的就是六月泰山那筆 → 六月歸零');
  assert.equal(gas.jul, 40, '七月不受影響');
  assert.equal(gas.unmatched, 0);
  const park = await review([
    ['2026-06-01', '嘟嘟房-台北101', 40, '停車費'],
    ['2026-07-10', '嘟嘟房-台北101', -40, '停車費'],
  ]);
  assert.equal(park.jun, 0);
  assert.equal(park.unmatched, 0);
});

test('非彙總店家的配對完全不受影響（Klook 型退款照舊）', async () => {
  const r = await review([
    ['2026-06-01', 'KLOOK TRAVEL', 40, ''],
    ['2026-07-10', 'KLOOK TRAVEL', -40, ''],
  ]);
  assert.equal(r.jun, 0, '同店退款照舊抵減原消費月份');
  assert.equal(r.unmatched, 0);
});
