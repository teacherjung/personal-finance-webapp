// 月度回顧 P0：信用卡帳單必須把「真正繳款」與「退款」分開。
// 全部使用合成資料與暫存 SQLite，絕不讀取真實 store／帳單。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-monthly-review-p0-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { finalize, isCardPayment } = await import('../lib/statement.js');
const { importRows } = await import('../lib/services/statement-import.js');
const { pickWritable, validateImportItem } = await import('../lib/schema.js');

after(() => {
  for (const suffix of ['', '.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suffix); } catch { /* 可能不存在 */ }
  }
});

beforeEach(() => {
  store.save({
    ...store.emptyDb(),
    cards: [{ id: 'card1', name: '合成測試卡', type: 'credit', issuer: '測試銀行', lastFour: '3301' }],
  });
});

test('isCardPayment：只認真正繳款，不把一般商店退款當繳款', () => {
  for (const desc of ['自動轉帳扣繳信用卡款', '感謝您繳款', '本期已繳款', '信用卡款']) {
    assert.equal(isCardPayment(desc), true, desc);
  }
  for (const desc of ['星巴克退款', '商品退貨退款', 'OPENAI REFUND', '']) {
    assert.equal(isCardPayment(desc), false, desc || '空字串');
  }
});

test('finalize：負數繳款仍禁止匯入；負數退款保留店家分類並可匯入', () => {
  const { transactions } = finalize([
    { date: '2026-07-01', desc: '自動轉帳扣繳信用卡款', amount: -8_000 },
    { date: '2026-07-02', desc: '星巴克退款', amount: -500 },
  ], '測試銀行');

  const [payment, refund] = transactions;
  assert.equal(payment.isPayment, true);
  assert.equal(payment.isRefund, false);
  assert.equal(payment.category, '繳款/退款');
  assert.equal(refund.isPayment, false);
  assert.equal(refund.isRefund, true);
  assert.equal(refund.category, '飲食', '退款仍應由店家說明判斷分類，供預覽辨識');
  assert.equal(refund.storeKey, '星巴克', '退款要帶穩定店家鑰匙，P1 才能配對原消費');
});

test('finalize：退款後的國外交易服務費不可繼承退款分類', () => {
  const { transactions } = finalize([
    { date: '2026-07-02', desc: '星巴克退款', amount: -500 },
    { date: '2026-07-02', desc: '國外交易服務費', amount: 8 },
  ], '測試銀行');

  assert.equal(transactions[0].isRefund, true);
  assert.notEqual(transactions[1].category, transactions[0].category,
    '退款不是一筆正向刷卡，後面的服務費不可把它當前一筆消費來繼承');
});

test('importRows：後端重判繳款、放行退款，並寫入服務層 refundOf 標記', () => {
  const rows = finalize([
    { date: '2026-07-01', desc: '自動轉帳扣繳信用卡款', amount: -8_000 },
    { date: '2026-07-02', desc: '星巴克退款', amount: -500 },
  ], '測試銀行').transactions.map((row, index) => ({
    ...row,
    // 故意把繳款的 isPayment 偽造為 false：匯入端不可相信瀏覽器標記。
    ...(index === 0 ? { isPayment: false } : {}),
    stmtRef: `preview-${index}`,
  }));

  const out = importRows('card1', rows);
  assert.equal(out.imported, 1);
  assert.equal(out.skipped, 1, '真正繳款即使前端偽造標記仍須擋下');

  const txs = store.load().transactions || [];
  assert.equal(txs.length, 1);
  assert.equal(txs[0].amount, -500);
  assert.equal(txs[0].ledger, 'card');
  assert.equal(txs[0].source, 'stmt');
  assert.equal(txs[0].storeKey, '星巴克');
  assert.equal(txs[0].refundOf, null, 'P0 先標成待配對；P1 彙總時再找原消費');
});

test('importRows：零元、非數字與正負破億都跳過，不讓解析雜訊變退款', () => {
  const mk = (amount, desc) => ({
    date: '2026-07-03', amount, desc, category: '其他', subcategory: '未分類', stmtRef: String(amount),
  });
  const out = importRows('card1', [
    mk(0, '零元'), mk('oops', '壞金額'), mk(100_000_001, '正破億'), mk(-100_000_001, '負破億退款'),
  ]);
  assert.equal(out.imported, 0);
  assert.equal(out.skipped, 4);
  assert.equal((store.load().transactions || []).length, 0);
});

test('refundOf 欄位所有權：CRUD 不能偽造，備份／櫃檯仍驗型別並保留合法 null', () => {
  const picked = pickWritable('transactions', { date: '2026-07-02', amount: -500, refundOf: 'fake-target' });
  assert.equal(Object.hasOwn(picked.value, 'refundOf'), false, '服務層欄位不可進 CRUD 白名單');

  const legal = validateImportItem('transactions', { id: 'r1', refundOf: null });
  assert.deepEqual(legal.errors, []);
  assert.equal(legal.item.refundOf, null, '備份還原要保留合法待配對標記');

  const bad = validateImportItem('transactions', { id: 'r2', refundOf: { forged: true } });
  assert.ok(bad.errors.includes('refundOf'), '物件型 refundOf 必須被型別牆拒絕');
});
