// 月度回顧 P1 端到端：路由必須把資料庫交給同一個純計算積木。
// STORE_FILE 指向暫存 SQLite，絕不碰真實資料。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

const TEST_STORE = join(tmpdir(), `finance-monthly-review-p1-${process.pid}.db`);
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

test('GET /api/monthly-review：最近已結清月預設選最新，交出退款與透支資料', async () => {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 10);
  const month = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;
  store.save({ ...store.emptyDb(), transactions: [
    { id: 'buy', date: `${month}-05`, type: 'expense', ledger: 'card', source: 'stmt', account: '卡A', category: '飲食', subcategory: '餐廳', amount: 500, note: '餐廳', storeKey: '餐廳', stmtRef: `card-a|${month}-05|500|餐廳` },
    { id: 'orphan', date: `${month}-20`, type: 'expense', ledger: 'card', source: 'stmt', account: '卡A', category: '其他', subcategory: '未分類', amount: -200, note: '別家退款', storeKey: '別家', stmtRef: `card-a|${month}-20|-200|別家退款`, refundOf: null },
    { id: 'income', date: `${month}-02`, type: 'income', ledger: 'cashflow', category: '工作', subcategory: '薪資', amount: 300 },
    { id: 'out', date: `${month}-25`, type: 'expense', ledger: 'cashflow', category: '居住', subcategory: '房租', amount: 600 },
  ] });

  const res = await fetch(`http://127.0.0.1:${port}/api/monthly-review`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.selectedMonth, month);
  assert.equal(body.selected.total, 1100);
  assert.equal(body.selected.cashflow.net, -300);
  assert.equal(body.selected.cashflow.overdraft, true);
  assert.equal(body.unmatchedRefunds.count, 1);
  assert.equal(body.unmatchedRefunds.total, 200);
  assert.equal(body.unmatchedRefunds.items[0].store, '別家退款');
});
