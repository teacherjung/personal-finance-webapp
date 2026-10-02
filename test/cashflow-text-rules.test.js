// 銀行收支的可編輯摘要／備註與兩組獨立、明確勾選的文字套用規則。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-cashflow-text-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { importBankTxToDb } = await import('../lib/services/bank-import.js');
const { emptyDb } = await import('../lib/store.js');
const { sanitizeSettings, sanitizeSettingsDeep } = await import('../lib/schema.js');

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api`;
const request = (method, path, body) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

after(() => {
  server.close();
  for (const suffix of ['', '.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suffix); } catch { /* absent */ }
  }
});

const bank = (id, summary = 'CD轉出', remark = '轉入帳號 1234') => ({
  id, date: '2026-06-10', type: 'expense', category: '其他', subcategory: '未分類', amount: 100,
  account: '合成帳戶', source: 'bank', ledger: 'cashflow', dir: 'out', bankKey: `${summary}|${remark}`,
  bankRef: `bank|900100****3301|2026-06-10|out|100||${summary}|${remark}`,
  bankSummary: summary, bankNote: remark, note: '舊收支說明',
});

async function reset(rows) {
  const db = await getDb();
  db.transactions = rows;
  db.settings = { ...db.settings, cashflowTextRules: { summary: {}, remark: {} } };
  db.learnedBank = {};
  await saveDb(db);
}

test('摘要與備註分別勾選才套用同原文的既有銀行收支，不改帳單原文、信用卡或金額', async () => {
  await reset([
    bank('a'), bank('b'), bank('c', '其他摘要', '轉入帳號 1234'), bank('d', 'CD轉出', '另一備註'),
    { ...bank('card'), source: 'stmt', ledger: 'card' },
  ]);
  const res = await request('PUT', '/transactions/a', {
    summary: '現金轉出', remark: '付房租', applySameSummary: true, applySameRemark: true,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.appliedText, { summary: 2, remark: 2 });
  const db = await getDb();
  const byId = Object.fromEntries(db.transactions.map(t => [t.id, t]));
  for (const id of ['a', 'b', 'd']) assert.equal(byId[id].summary, '現金轉出');
  assert.equal(byId.c.summary, undefined);
  for (const id of ['a', 'b', 'c']) assert.equal(byId[id].remark, '付房租');
  assert.equal(byId.d.remark, undefined);
  assert.equal(byId.card.summary, undefined);
  assert.equal(byId.card.remark, undefined);
  assert.equal(byId.b.bankSummary, 'CD轉出');
  assert.equal(byId.b.bankNote, '轉入帳號 1234');
  assert.equal(byId.b.bankRef, bank('b').bankRef);
  assert.equal(byId.b.amount, 100);
  assert.equal(byId.b.note, '舊收支說明', '舊欄位只保留相容，不拿來當新摘要');
  assert.equal(data.applySameSummary, undefined, '控制旗標不存進交易');
  assert.equal(db.settings.cashflowTextRules.summary['CD轉出'], '現金轉出');
  assert.equal(db.settings.cashflowTextRules.remark['轉入帳號 1234'], '付房租');
});

test('不勾選時只改這一筆；摘要、備註可以各自獨立套用', async () => {
  await reset([bank('a'), bank('b')]);
  let res = await request('PUT', '/transactions/a', { summary: '單筆摘要', remark: '單筆備註' });
  assert.equal(res.status, 200);
  assert.equal((await getDb()).transactions.find(t => t.id === 'b').summary, undefined);
  assert.deepEqual((await getDb()).settings.cashflowTextRules, { summary: {}, remark: {} });

  res = await request('PUT', '/transactions/a', { summary: '共同摘要', applySameSummary: true });
  assert.equal(res.status, 200);
  const db = await getDb();
  assert.equal(db.transactions.find(t => t.id === 'b').summary, '共同摘要');
  assert.equal(db.transactions.find(t => t.id === 'b').remark, undefined);
  assert.equal(db.settings.cashflowTextRules.summary['CD轉出'], '共同摘要');
  assert.deepEqual(db.settings.cashflowTextRules.remark, {});
});

test('新匯入套用已選擇的摘要與備註規則，但分類、原文與去重鍵不受影響', async () => {
  await reset([bank('a')]);
  const edit = await request('PUT', '/transactions/a', {
    summary: '現金轉出', remark: '付房租', applySameSummary: true, applySameRemark: true,
  });
  assert.equal(edit.status, 200);
  const db = await getDb();
  db.transactions = [];
  db.accounts = [{ id: 'acct', name: '合成帳戶', type: 'cash', currency: 'TWD', accountNo: '900100****3301' }];
  const tx = { acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-07-10',
    summary: 'CD轉出', note: '轉入帳號 1234', direction: 'out', amount: 100, balance: null };
  const parsed = { accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [tx] };
  const withoutRules = structuredClone(db);
  withoutRules.settings.cashflowTextRules = { summary: {}, remark: {} };
  importBankTxToDb(withoutRules, parsed);
  importBankTxToDb(db, parsed);
  const row = db.transactions[0], plain = withoutRules.transactions[0];
  assert.equal(row.summary, '現金轉出');
  assert.equal(row.remark, '付房租');
  assert.equal(row.bankSummary, 'CD轉出');
  assert.equal(row.bankNote, '轉入帳號 1234');
  assert.equal(row.bankRef, plain.bankRef);
  assert.equal(row.bankKey, plain.bankKey);
  assert.equal(row.type, plain.type);
  assert.equal(row.category, plain.category);
  assert.equal(row.amount, plain.amount);
});

test('手動記帳只寫入摘要與備註，不再寫入舊收支說明', async () => {
  await reset([]);
  const res = await request('POST', '/transactions', {
    date: '2026-06-15', type: 'expense', category: '居住', subcategory: '房租', amount: 12000,
    account: '合成帳戶', summary: '房租', remark: '十月租金',
  });
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.summary, '房租');
  assert.equal(row.remark, '十月租金');
  assert.equal(row.note, undefined);
});

test('文字套用規則可分別刪除，只停止未來套用，不回改已存紀錄', async () => {
  await reset([bank('a')]);
  await request('PUT', '/transactions/a', {
    summary: '現金轉出', remark: '付房租', applySameSummary: true, applySameRemark: true,
  });
  const res = await request('POST', '/cashflow-text-rules/delete', { part: 'summary', key: 'CD轉出' });
  assert.equal(res.status, 200);
  const db = await getDb();
  assert.equal(db.transactions[0].summary, '現金轉出');
  assert.equal(db.transactions[0].remark, '付房租');
  assert.equal(Object.hasOwn(db.settings.cashflowTextRules.summary, 'CD轉出'), false);
  assert.equal(db.settings.cashflowTextRules.remark['轉入帳號 1234'], '付房租');
  assert.equal((await request('POST', '/cashflow-text-rules/delete', { part: 'wrong', key: 'CD轉出' })).status, 400);
});

test('全新資料庫與示範資料都從空的兩組文字規則開始', () => {
  const expected = { summary: {}, remark: {} };
  assert.deepEqual(emptyDb().settings.cashflowTextRules, expected);
  const seed = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url), 'utf8'));
  assert.deepEqual(seed.settings.cashflowTextRules, expected);
});

test('一般設定寫入不能繞過編輯交易的明確套用選擇', async () => {
  await reset([bank('a')]);
  const res = await request('PUT', '/settings', { cashflowTextRules: { summary: { 'CD轉出': '偷偷改' } } });
  assert.equal(res.status, 200);
  const db = await getDb();
  assert.deepEqual(db.settings.cashflowTextRules, { summary: {}, remark: {} });
});

test('非布林的套用旗標只儲存單筆文字，不能建立規則或改別筆', async () => {
  await reset([bank('a'), bank('b')]);
  const res = await request('PUT', '/transactions/a', {
    summary: '只改我', remark: '也只改我', applySameSummary: 'true', applySameRemark: 1,
  });
  assert.equal(res.status, 200);
  const db = await getDb();
  assert.equal(db.transactions.find(t => t.id === 'a').summary, '只改我');
  assert.equal(db.transactions.find(t => t.id === 'b').summary, undefined);
  assert.equal(db.transactions.find(t => t.id === 'b').remark, undefined);
  assert.deepEqual(db.settings.cashflowTextRules, { summary: {}, remark: {} });
});

test('備份保留兩組規則；不合法的原型鍵和非字串值在存檔驗證時剝除並報錯', () => {
  const rules = JSON.parse('{"summary":{"CD轉出":"現金轉出","__proto__":"不行"},"remark":{"轉入帳號 1234":"付房租","toString":"不行","數字":123}}');
  const backup = sanitizeSettings({ cashflowTextRules: rules }, { allowIbSyncFields: true });
  assert.equal(backup.cashflowTextRules.summary['CD轉出'], '現金轉出');
  assert.equal(backup.cashflowTextRules.remark['轉入帳號 1234'], '付房租');
  assert.equal(Object.hasOwn(backup.cashflowTextRules.summary, '__proto__'), false);
  assert.equal(Object.hasOwn(backup.cashflowTextRules.remark, 'toString'), false);
  const checked = sanitizeSettingsDeep({ cashflowTextRules: rules });
  assert.ok(checked.bad.some(x => x.startsWith('settings.cashflowTextRules')));
  assert.equal(checked.value.cashflowTextRules.summary['CD轉出'], '現金轉出');
});

test('新匯入的摘要、備註各用自己的原文比對，不因另一欄不同而漏套或誤套', async () => {
  await reset([bank('a')]);
  assert.equal((await request('PUT', '/transactions/a', {
    summary: '現金轉出', remark: '付房租', applySameSummary: true, applySameRemark: true,
  })).status, 200);
  const db = await getDb();
  db.transactions = [];
  db.accounts = [{ id: 'acct', name: '合成帳戶', type: 'cash', currency: 'TWD', accountNo: '900100****3301' }];
  const parsed = { accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [
    { acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-07-11', summary: 'CD轉出', note: '不同備註', direction: 'out', amount: 101, balance: null },
    { acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-07-12', summary: '不同摘要', note: '轉入帳號 1234', direction: 'out', amount: 102, balance: null },
  ] };
  importBankTxToDb(db, parsed);
  assert.equal(db.transactions[0].summary, '現金轉出');
  assert.equal(db.transactions[0].remark, undefined);
  assert.equal(db.transactions[1].summary, undefined);
  assert.equal(db.transactions[1].remark, '付房租');
});
