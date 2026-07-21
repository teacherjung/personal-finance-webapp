// 內轉子分類管理考題（使用者定 2026-07-21，「全部都能改」）：角色跟著改名走、改名連動既有交易、
// 自動分類 conform 到現名。隔離：STORE_FILE 暫存檔。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-transfer-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { sanitizeTransferSubs } = await import('../lib/schema.js');
const { effectiveTransferSubs, conformTransferSub, saveTransferSubs } = await import('../lib/services/categories.js');
const { importBankTxToDb } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

// ---------- sanitizeTransferSubs ----------
test('sanitizeTransferSubs：空/全壞 → 回預設（內轉出/內轉入/交割）', () => {
  assert.deepEqual(sanitizeTransferSubs([]).map(s => s.label), ['內轉出', '內轉入', '交割']);
  assert.deepEqual(sanitizeTransferSubs('oops').map(s => s.label), ['內轉出', '內轉入', '交割']);
});
test('sanitizeTransferSubs：label 去重/去空/去保留字；role 每角色至多一項、壞 role 丟', () => {
  const out = sanitizeTransferSubs([
    { label: '轉出', role: 'out' }, { label: '轉出', role: 'in' },   // 重複 label → 丟第二
    { label: '', role: 'in' }, { label: '__proto__' },              // 空/保留字 → 丟
    { label: '還卡費' }, { label: '交割', role: 'settle' },
    { label: '又一個', role: 'out' },                                // out 已用 → 這個無 role
    { label: '壞角色', role: 'weird' },                             // 壞 role → 無 role 但保留 label
  ]);
  assert.deepEqual(out, [
    { label: '轉出', role: 'out' }, { label: '還卡費' }, { label: '交割', role: 'settle' },
    { label: '又一個' }, { label: '壞角色' },
  ]);
});

// ---------- conformTransferSub ----------
test('conformTransferSub：現行標籤保留；預設角色標籤被改名→現名；角色刪除/非清單→空', () => {
  const db = getDb();
  db.transferSubs = [{ label: '轉出去', role: 'out' }, { label: '內轉入', role: 'in' }, { label: '還卡費' }];   // out 改名、無 settle
  saveDb(db);
  const d = getDb();
  assert.equal(conformTransferSub(d, '轉出去'), '轉出去');   // 現行標籤
  assert.equal(conformTransferSub(d, '內轉出'), '轉出去');   // 預設 out 標籤 → 現名
  assert.equal(conformTransferSub(d, '交割'), '');           // settle 已刪 → 空
  assert.equal(conformTransferSub(d, '不存在'), '');         // 非清單、非預設 → 空
  assert.equal(conformTransferSub(d, '還卡費'), '還卡費');   // 自訂現行 → 保留
});

test('conformTransferSub：角色優先——out 改名＋又自訂一項叫「內轉出」時，分類器的內轉出仍對到 out 現名（對抗審查 r1）', () => {
  const db = getDb();
  db.transferSubs = [{ label: '轉出', role: 'out' }, { label: '內轉入', role: 'in' }, { label: '交割', role: 'settle' }, { label: '內轉出' }];
  saveDb(db);
  assert.equal(conformTransferSub(getDb(), '內轉出'), '轉出');   // 角色優先，不誤對到同名的無角色自訂項
});

// ---------- effectiveTransferSubs ----------
test('effectiveTransferSubs：db 空 → 預設；有值 → 清理後回', () => {
  const db = getDb();
  db.transferSubs = [];
  saveDb(db);
  assert.deepEqual(effectiveTransferSubs(getDb()).map(s => s.label), ['內轉出', '內轉入', '交割']);
});

// ---------- saveTransferSubs（連動更新） ----------
test('saveTransferSubs：改名（角色＋自訂）連動既有內轉交易；刪除→conform；支出不動', () => {
  const db = getDb();
  db.transferSubs = [{ label: '內轉出', role: 'out' }, { label: '內轉入', role: 'in' }, { label: '交割', role: 'settle' }, { label: '還卡費' }];
  db.transactions = [
    { id: 't1', type: 'transfer', category: '內轉', subcategory: '內轉出', ledger: 'cashflow', date: '2026-06-01', amount: 100 },
    { id: 't2', type: 'transfer', category: '內轉', subcategory: '還卡費', ledger: 'cashflow', date: '2026-06-02', amount: 200 },
    { id: 't3', type: 'transfer', category: '內轉', subcategory: '交割', ledger: 'cashflow', date: '2026-06-03', amount: 300 },
    { id: 'e1', type: 'expense', category: '飲食', subcategory: '外食', ledger: 'cashflow', date: '2026-06-04', amount: 50 },
  ];
  saveDb(db);
  const r = saveTransferSubs({
    subs: [{ label: '轉出去', role: 'out' }, { label: '內轉入', role: 'in' }, { label: '還信用卡' }],   // 內轉出→轉出去、還卡費→還信用卡、刪交割
    renames: [{ from: '內轉出', to: '轉出去' }, { from: '還卡費', to: '還信用卡' }],
  });
  const after = getDb().transactions;
  assert.equal(after.find(t => t.id === 't1').subcategory, '轉出去');   // 角色改名連動
  assert.equal(after.find(t => t.id === 't2').subcategory, '還信用卡'); // 自訂改名連動
  assert.equal(after.find(t => t.id === 't3').subcategory, '');          // 交割刪除 → conform 空
  assert.equal(after.find(t => t.id === 'e1').subcategory, '外食');      // 支出不受影響
  assert.ok(r.changedTx >= 3);
});
test('saveTransferSubs：保留字整組拒絕（400）', () => {
  assert.throws(() => saveTransferSubs({ subs: [{ label: '__proto__' }] }), /保留字/);
  assert.throws(() => saveTransferSubs({ subs: [{ label: 'x' }], renames: [{ from: 'a', to: '__proto__' }] }), /保留字/);
});

// ---------- 整合：自動分類 conform 到現名 ----------
test('整合：交割改名「結算」後，匯入劃撥交易 → 子分類自動變結算（resolveCls conform）', () => {
  const btx = (o) => ({ acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-06-10', summary: '', direction: 'in', amount: 1000, balance: null, note: '', ...o });
  const parsed = (txns) => ({ accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: txns });
  const db = {
    transactions: [], accounts: [{ id: 'a', name: '台新', type: 'cash', currency: 'TWD', accountNo: '900100****3301' }],
    learnedBank: {}, settings: {},
    transferSubs: [{ label: '內轉出', role: 'out' }, { label: '內轉入', role: 'in' }, { label: '結算', role: 'settle' }],   // 交割→結算
  };
  importBankTxToDb(db, parsed([btx({ summary: '轉帳存入', note: '劃撥轉帳元大台灣50', direction: 'in', amount: 1000000 })]));
  const t = db.transactions.at(-1);
  assert.equal(t.type, 'transfer'); assert.equal(t.category, '內轉');
  assert.equal(t.subcategory, '結算');   // 交割（classifyBankTx 出）→ conform 到現名「結算」
});
