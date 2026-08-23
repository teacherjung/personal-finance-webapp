// @ts-check
// Stage 5b：金融卡帳單在兩本帳裡的列互為條件——走正式 HTTP 的單筆 DELETE 也要擋（Codex #503 r2#1）。
// 隔離暫存 DB；合成資料。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

const TEST_STORE = join(tmpdir(), `finance-debit-http-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
const { applyBankStatement } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;
const DEL = (/** @type {string} */ p) => fetch(base + p, { method: 'DELETE' });

after(() => { server.close(); for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

const MASKED = '**********8791';
const parsed = () => ({
  bank: '台新', referenceDate: '2026-01-31',
  accounts: [{ suffix: '8791', masked: MASKED, balance: 9695, currency: 'TWD', label: '簽帳金融卡', note: '', kind: 'demand', period: '', suffixOnly: true, balanceFromDetail: true }],
  accountCurrency: { [MASKED]: 'TWD' },
  transactions: [{ acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' }],
  cardRows: [{ postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' }],
});

test('★正式 HTTP DELETE /api/transactions/:id：卡片帳本那筆與帳戶那筆都不准單筆刪（兩本帳互為條件），其他交易照刪', async () => {
  const db0 = await getDb(); db0.accounts = []; db0.transactions = [{ id: 'manual', date: '2026-01-01', type: 'expense', category: '生活', amount: 1, account: '手打' }]; db0.cards = []; await saveDb(db0);
  await applyBankStatement('QUJD', '', async () => parsed());
  const db = await getDb();
  const cardRow = db.transactions.find((/** @type {any} */ t) => t.ledger === 'card');
  const bankRow = db.transactions.find((/** @type {any} */ t) => t.source === 'bank');
  const r1 = await DEL(`/transactions/${cardRow.id}`);
  assert.equal(r1.status, 400, '★卡片帳本那筆不准單筆刪（刪了＝帳戶那筆留空、消費少算）');
  assert.match((await r1.json()).error, /匯入紀錄/, '白話告訴使用者去哪裡整批刪');
  const r2 = await DEL(`/transactions/${bankRow.id}`);
  assert.equal(r2.status, 400, '★帳戶那筆也不准（逐筆刪光＝銀行批次從匯入紀錄消失、卡片列變孤兒）');
  const r3 = await DEL('/transactions/manual');
  assert.equal(r3.status, 200, '無關的交易照刪');
  const after_ = await getDb();
  assert.equal(after_.transactions.length, 2, '兩筆都還在');
});
