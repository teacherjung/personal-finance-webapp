// 銀行收支「真·學習（記憶版）」考題（使用者定 2026-07-21）：以「摘要＋對方帳號」為鑰匙，
// 編輯時學、未來匯入自動套用。隔離：STORE_FILE 暫存檔（持久化那幾題用 getDb/saveDb）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-banklearn-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { bankKeyOf, learnFromBankEdit, importBankTxToDb, previewBankTxForDb } = await import('../lib/services/bank-import.js');
const { sanitizeLearnedBank } = await import('../lib/schema.js');
const { getDb, saveDb } = await import('../lib/repo.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

// ---------- bankKeyOf（鑰匙推導） ----------
test('bankKeyOf：有對方帳號 → 摘要|#帳號（帳號＝穩定身分）', () => {
  assert.equal(bankKeyOf('轉帳支取', '轉入288810****3047養育費'), '轉帳支取|#288810****3047');
  assert.equal(bankKeyOf('CD轉入', 'ATM 806-00204127****1206 William鐘點'), 'CD轉入|#806-00204127****1206');
});
test('bankKeyOf：無對方帳號 → 摘要|備註描述（collapse 空白）', () => {
  assert.equal(bankKeyOf('媒體轉入', '基金配息群益主權'), '媒體轉入|基金配息群益主權');
  assert.equal(bankKeyOf('媒體轉入', '收益分配00795B'), '媒體轉入|收益分配00795B');
});
test('bankKeyOf：光禿摘要（無備註）→ 空字串（太籠統、不學）', () => {
  assert.equal(bankKeyOf('轉帳存入', ''), '');
  assert.equal(bankKeyOf('轉帳存入', '   '), '');
});
test('bankKeyOf：有帳號時，描述文字不影響鑰匙（同帳號＝同一把）', () => {
  assert.equal(bankKeyOf('CD轉入', 'ATM 103-00005695****8484'),
    bankKeyOf('CD轉入', '103-00005695****8484 換個說明'));
});

// ---------- learnFromBankEdit（編輯時學） ----------
test('learnFromBankEdit：source:bank → 記 type/分類；這次改了 note 才記自訂顯示名', () => {
  const db = { learnedBank: {} };
  learnFromBankEdit(db,
    { source: 'bank', bankKey: 'CD轉入|#806****1206', type: 'income', category: '工作', subcategory: '鐘點', note: 'William 家教費' },
    { note: 'CD轉入・ATM 806****1206' });
  assert.deepEqual(db.learnedBank['CD轉入|#806****1206'],
    { type: 'income', category: '工作', subcategory: '鐘點', name: 'William 家教費' });
});
test('learnFromBankEdit：note 沒改 → 只記分類、不動 name', () => {
  const db = { learnedBank: {} };
  learnFromBankEdit(db, { source: 'bank', bankKey: 'k', type: 'expense', category: '生活', subcategory: '外食', note: 'x' }, { note: 'x' });
  assert.deepEqual(db.learnedBank['k'], { type: 'expense', category: '生活', subcategory: '外食' });
});
test('learnFromBankEdit：改名成空 → 清除自訂名', () => {
  const db = { learnedBank: { k: { type: 'income', category: '其他', name: '舊名' } } };
  learnFromBankEdit(db, { source: 'bank', bankKey: 'k', type: 'income', category: '其他', subcategory: '', note: '' }, { note: '舊名' });
  assert.deepEqual(db.learnedBank['k'], { type: 'income', category: '其他', subcategory: '' });
});
test('learnFromBankEdit：非 bank 來源不學（手動/信用卡不污染）', () => {
  const db = { learnedBank: {} };
  learnFromBankEdit(db, { source: 'stmt', bankKey: 'k', type: 'expense', category: '生活', note: 'a' }, { note: 'b' });
  learnFromBankEdit(db, { source: undefined, bankKey: 'k', type: 'expense', category: '生活', note: 'a' }, { note: 'b' });
  assert.deepEqual(db.learnedBank, {});
});
test('learnFromBankEdit：空 bankKey（光禿摘要）不學', () => {
  const db = { learnedBank: {} };
  learnFromBankEdit(db, { source: 'bank', bankKey: '', type: 'income', category: '其他', note: 'x' }, { note: 'y' });
  assert.deepEqual(db.learnedBank, {});
});
test('learnFromBankEdit：無合法 type 不學（免日後套用出錯）', () => {
  const db = { learnedBank: {} };
  learnFromBankEdit(db, { source: 'bank', bankKey: 'k', type: 'weird', category: 'x', note: 'a' }, { note: 'b' });
  assert.deepEqual(db.learnedBank, {});
});
test('learnFromBankEdit：bankKey 缺席 → 從 note 反推（本功能前的舊資料）', () => {
  const db = { learnedBank: {} };
  learnFromBankEdit(db,
    { source: 'bank', type: 'income', category: '被動', subcategory: '股息', note: '媒體轉入・基金配息群益主權' },
    { note: '媒體轉入・基金配息群益主權' });
  assert.deepEqual(db.learnedBank['媒體轉入|基金配息群益主權'], { type: 'income', category: '被動', subcategory: '股息' });
});
test('learnFromBankEdit：__proto__ 鑰匙不污染全域原型、不寫入', () => {
  const db = { learnedBank: {} };
  learnFromBankEdit(db, { source: 'bank', bankKey: '__proto__', type: 'income', category: 'x', note: 'a' }, { note: 'b' });
  assert.equal(({}).type, undefined);
  assert.deepEqual(db.learnedBank, {});
});

// ---------- 匯入時套用 ----------
const btx = (o) => ({ acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-06-10', summary: '轉帳存入', direction: 'in', amount: 1000, balance: null, note: '', ...o });
const parsed = (txns) => ({ accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: txns });
const baseDb = () => ({ transactions: [], accounts: [{ id: 'a', name: '台新 3301', type: 'cash', currency: 'TWD', accountNo: '900100****3301' }], learnedBank: {}, settings: {} });

test('匯入：學過的鑰匙 → 套用學過的 type/分類/自訂名，蓋過關鍵字規則，並存 bankKey', () => {
  const db = baseDb();
  db.learnedBank['CD轉入|#806-00204127****1206'] = { type: 'income', category: '工作', subcategory: '鐘點', name: 'William 家教費' };
  const r = importBankTxToDb(db, parsed([btx({ summary: 'CD轉入', note: 'ATM 806-00204127****1206', direction: 'in', amount: 24600 })]));
  assert.equal(r.imported, 1);
  const t = db.transactions.at(-1);
  assert.equal(t.type, 'income'); assert.equal(t.category, '工作'); assert.equal(t.subcategory, '鐘點');
  assert.equal(t.note, 'William 家教費');
  assert.equal(t.bankKey, 'CD轉入|#806-00204127****1206');
});
test('匯入：沒學過 → 落關鍵字規則（原行為不變）', () => {
  const db = baseDb();
  importBankTxToDb(db, parsed([btx({ summary: '存款息', direction: 'in', amount: 23, note: '' })]));
  const t = db.transactions.at(-1);
  assert.equal(t.type, 'income'); assert.equal(t.category, '被動'); assert.equal(t.subcategory, '利息');
});

test('端到端：匯入→編輯(學)→重匯 自動套用（改一次、記一輩子）', () => {
  const db = baseDb();
  importBankTxToDb(db, parsed([btx({ summary: '轉帳存入', note: 'ATM 007-99901572****2074', direction: 'in', amount: 5000 })]));
  const t = db.transactions.at(-1);
  assert.equal(t.category, '其他');   // 關鍵字預設：轉帳存入→收入/其他/其他收入
  // 使用者改成 內轉/內轉入、取名「小珍還錢」
  learnFromBankEdit(db, { ...t, type: 'transfer', category: '內轉', subcategory: '內轉入', note: '小珍還錢' }, t);
  // 下個月同對象再匯入（清掉舊的模擬新帳單）
  db.transactions = [];
  importBankTxToDb(db, parsed([btx({ summary: '轉帳存入', note: 'ATM 007-99901572****2074', direction: 'in', amount: 3000 })]));
  const t2 = db.transactions.at(-1);
  assert.equal(t2.type, 'transfer'); assert.equal(t2.category, '內轉'); assert.equal(t2.subcategory, '內轉入');
  assert.equal(t2.note, '小珍還錢');
});

test('方向護欄：學過的「收入」規則遇到同鑰匙的「出帳」→ 不套用，落關鍵字規則（絕不把出帳當收入，對抗審查 2026-07-21）', () => {
  const db = baseDb();
  db.learnedBank['網轉|#888888****9999'] = { type: 'income', category: '工作', subcategory: '薪資' };
  importBankTxToDb(db, parsed([btx({ summary: '網轉', note: '888888****9999', direction: 'out', amount: 3000 })]));
  const t = db.transactions.at(-1);
  assert.equal(t.type, 'expense');   // 出帳落 classifyBankTx 預設支出，不被學過的收入蓋掉
  assert.notEqual(t.type, 'income');
});
test('方向護欄：學過的「支出」規則遇到同鑰匙的「進帳」→ 不套用（不把進帳當支出）', () => {
  const db = baseDb();
  db.learnedBank['網轉|#888888****9999'] = { type: 'expense', category: '養育', subcategory: '贍養費' };
  importBankTxToDb(db, parsed([btx({ summary: '網轉', note: '888888****9999', direction: 'in', amount: 3000 })]));
  const t = db.transactions.at(-1);
  assert.equal(t.type, 'income');   // 進帳落 classifyBankTx 預設收入
});
test('內轉出/入隨本筆方向，不重播學到的方向（同鑰匙反向交易不貼錯）', () => {
  const db = baseDb();
  db.learnedBank['網轉|#888888****9999'] = { type: 'transfer', category: '內轉', subcategory: '內轉入' };   // 學的時候是「入」
  importBankTxToDb(db, parsed([btx({ summary: '網轉', note: '888888****9999', direction: 'out', amount: 3000 })]));
  const t = db.transactions.at(-1);
  assert.equal(t.type, 'transfer'); assert.equal(t.subcategory, '內轉出');   // 這次是出帳 → 內轉出
});

test('learnFromBankEdit｜改了 note → 逐字記為自訂顯示名（銀行 note 靜態、刻意不做 auto 自我修剪）', () => {
  const db = { learnedBank: {} };
  learnFromBankEdit(db, { source: 'bank', bankKey: 'CD轉入|#806****1206', type: 'income', category: '工作', subcategory: '鐘點', note: 'William 家教費' }, { note: 'x' });
  assert.equal(db.learnedBank['CD轉入|#806****1206'].name, 'William 家教費');
});
test('learnFromBankEdit｜真自訂名保留摘要前綴＋提到對方帳號 → 不被誤清（對抗審查 r2 false-prune 回歸）', () => {
  const db = { learnedBank: {} };
  learnFromBankEdit(db,
    { source: 'bank', bankKey: '轉帳支取|#288810****3047', type: 'expense', category: '養育', subcategory: '贍養費', note: '轉帳支取・付給前妻288810****3047的養育費' },
    { note: '轉帳支取・轉入288810****3047養育費' });
  assert.equal(db.learnedBank['轉帳支取|#288810****3047'].name, '轉帳支取・付給前妻288810****3047的養育費');   // 逐字保留、不因反推鑰匙相同被誤清
});

test('預覽：套用學過的分類與自訂名，並標 learned:true', () => {
  const db = baseDb();
  db.learnedBank['轉帳存入|#007-99901572****2074'] = { type: 'transfer', category: '內轉', subcategory: '內轉入', name: '小珍還錢' };
  const { rows } = previewBankTxForDb(db, parsed([btx({ summary: '轉帳存入', note: 'ATM 007-99901572****2074', direction: 'in', amount: 5000 })]));
  assert.equal(rows[0].type, 'transfer'); assert.equal(rows[0].category, '內轉');
  assert.equal(rows[0].note, '小珍還錢'); assert.equal(rows[0].learned, true);
  assert.equal(rows[0].bankKey, '轉帳存入|#007-99901572****2074');
});

// ---------- sanitizeLearnedBank ----------
test('sanitizeLearnedBank：壞 type 整筆丟、保留字 key 丟、非字串欄丟、非物件丟', () => {
  const out = sanitizeLearnedBank({
    good: { type: 'income', category: '工作', subcategory: '鐘點', name: 'x' },
    badtype: { type: 'nope', category: 'x' },
    __proto__: { type: 'income', category: 'x' },
    nonobj: 'oops',
    badfields: { type: 'expense', category: 123, name: null },
  });
  assert.deepEqual(out.good, { type: 'income', category: '工作', subcategory: '鐘點', name: 'x' });
  assert.equal(out.badtype, undefined);
  assert.equal(out.nonobj, undefined);
  assert.deepEqual(out.badfields, { type: 'expense' });   // 壞欄剝除、type 保留
  assert.equal(({}).category, undefined);                 // 原型未污染
});

// ---------- 持久化（新 KV 鍵） ----------
test('持久化：learnedBank 存得進、讀得出', () => {
  const db = getDb();
  db.learnedBank = { 'k|#123****456': { type: 'expense', category: '居住', subcategory: '房貸' } };
  saveDb(db);
  const db2 = getDb();
  assert.deepEqual(db2.learnedBank['k|#123****456'], { type: 'expense', category: '居住', subcategory: '房貸' });
});
test('持久化：缺 learnedBank 列 → 讀成空物件 {}（不是 undefined/[]）', () => {
  const db = getDb();
  assert.ok(db.learnedBank && typeof db.learnedBank === 'object' && !Array.isArray(db.learnedBank));
});
