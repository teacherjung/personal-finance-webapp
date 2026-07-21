// 銀行對帳單「匯入紀錄」批次管理考題（listBankBatches / deleteBankBatch）。
// 這兩支經 getDb/saveDb 讀寫，故用 STORE_FILE 暫存檔隔離，seed 後直接讀驗證。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-bankbatch-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { getDb, saveDb } = await import('../lib/repo.js');
const { listBankBatches, deleteBankBatch } = await import('../lib/services/bank-import.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

/** 一筆現金流交易（給預設，欄位可覆寫）。 @param {Partial<any>} o */
const tx = (o) => ({
  id: o.id, date: '2026-06-10', type: 'expense', category: '其他', subcategory: '未分類',
  amount: 100, account: '台新 3301', note: '測試', ledger: 'cashflow', source: 'bank',
  bankRef: o.bankRef || o.id, importBatch: 'B1', importedAt: '2026-07-21T00:00:00.000Z', ...o,
});

/** 用給定的 transactions 重置隔離庫。 @param {any[]} transactions */
function seed(transactions) {
  const db = getDb();
  db.transactions = transactions;
  saveDb(db);
}

beforeEach(() => seed([]));

test('listBankBatches：只聚合 source:bank，依 importBatch 分組並算收入/支出/內轉與日期範圍', () => {
  seed([
    tx({ id: 't1', importBatch: 'B1', type: 'income', amount: 82381, date: '2026-06-05' }),
    tx({ id: 't2', importBatch: 'B1', type: 'expense', amount: 300, date: '2026-06-20' }),
    tx({ id: 't3', importBatch: 'B1', type: 'transfer', amount: 1000000, date: '2026-06-12' }),
    // 別批
    tx({ id: 't4', importBatch: 'B2', type: 'expense', amount: 50, date: '2026-05-01', importedAt: '2026-07-20T00:00:00.000Z' }),
    // 非銀行來源（手動記帳、信用卡帳單）不可入列
    { id: 'm1', date: '2026-06-01', type: 'expense', amount: 999, source: 'manual', importBatch: 'B1', ledger: 'cashflow' },
    { id: 'c1', date: '2026-06-01', type: 'expense', amount: 888, source: 'stmt', importBatch: 'B9', ledger: 'card' },
  ]);
  const batches = listBankBatches();
  assert.equal(batches.length, 2);
  const b1 = batches.find(b => b.batchId === 'B1');
  assert.equal(b1.count, 3);                     // 手動那筆 m1 雖同 importBatch 也不算（source 不是 bank）
  assert.equal(b1.income, 82381);
  assert.equal(b1.expense, 300);
  assert.equal(b1.transfer, 1000000);
  assert.equal(b1.minDate, '2026-06-05');
  assert.equal(b1.maxDate, '2026-06-20');
});

test('listBankBatches：依匯入時間新到舊排序', () => {
  seed([
    tx({ id: 'a', importBatch: 'OLD', importedAt: '2026-07-01T00:00:00.000Z' }),
    tx({ id: 'b', importBatch: 'NEW', importedAt: '2026-07-21T00:00:00.000Z' }),
  ]);
  const batches = listBankBatches();
  assert.deepEqual(batches.map(b => b.batchId), ['NEW', 'OLD']);
});

test('listBankBatches：沒有銀行批次回空陣列', () => {
  seed([{ id: 'm', date: '2026-06-01', type: 'expense', amount: 1, source: 'manual', ledger: 'cashflow' }]);
  assert.deepEqual(listBankBatches(), []);
});

test('deleteBankBatch：只刪該批的 source:bank 交易，別批與非銀行來源不動', () => {
  seed([
    tx({ id: 't1', importBatch: 'B1' }),
    tx({ id: 't2', importBatch: 'B1' }),
    tx({ id: 't3', importBatch: 'B2' }),
    { id: 'm1', date: '2026-06-01', type: 'expense', amount: 1, source: 'manual', importBatch: 'B1', ledger: 'cashflow' },
  ]);
  const r = deleteBankBatch('B1');
  assert.equal(r.removed, 2);
  const left = getDb().transactions.map(t => t.id).sort();
  assert.deepEqual(left, ['m1', 't3']);          // 手動 m1（同 importBatch）與別批 t3 都保住
});

test('deleteBankBatch：batchId 撞號時也不誤刪信用卡帳單（雙重比對 source===bank）', () => {
  seed([
    tx({ id: 't1', importBatch: 'DUP' }),
    { id: 'c1', date: '2026-06-01', type: 'expense', amount: 888, source: 'stmt', importBatch: 'DUP', ledger: 'card' },
  ]);
  const r = deleteBankBatch('DUP');
  assert.equal(r.removed, 1);
  assert.deepEqual(getDb().transactions.map(t => t.id), ['c1']);   // 信用卡帳單 c1 不受影響
});

test('deleteBankBatch：空/缺 batchId → 400，不動資料', () => {
  seed([tx({ id: 't1', importBatch: 'B1' })]);
  assert.throws(() => deleteBankBatch(''), /批次代號/);
  assert.throws(() => deleteBankBatch(undefined), /批次代號/);
  assert.equal(getDb().transactions.length, 1);
});

test('deleteBankBatch：不存在的 batchId → removed 0，不動資料', () => {
  seed([tx({ id: 't1', importBatch: 'B1' })]);
  const r = deleteBankBatch('NOPE');
  assert.equal(r.removed, 0);
  assert.equal(getDb().transactions.length, 1);
});

test('listBankBatches：批次 id 是 __proto__ → 批次照常出現、不污染 Object.prototype（比照 proto-pollution r6#3）', () => {
  seed([tx({ id: 'p1', importBatch: '__proto__', type: 'expense', amount: 42 })]);
  const batches = listBankBatches();
  assert.equal(batches.length, 1);              // Object.create(null) 才不會讓 groups['__proto__'] 讀到原型本尊而漏建
  assert.equal(batches[0].batchId, '__proto__');
  assert.equal(batches[0].count, 1);
  assert.equal(batches[0].expense, 42);
  assert.equal(({}).count, undefined);          // 全域原型沒被 g.count++ 污染
  assert.equal(Object.prototype.count, undefined);
});

test('deleteBankBatch：batchId 是 __proto__ 也正常刪、不炸、不誤傷別批', () => {
  seed([tx({ id: 'p1', importBatch: '__proto__' }), tx({ id: 'k1', importBatch: 'KEEP' })]);
  const r = deleteBankBatch('__proto__');
  assert.equal(r.removed, 1);
  assert.deepEqual(getDb().transactions.map(t => t.id), ['k1']);
});
