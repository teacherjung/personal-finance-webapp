// 銀行收支「真·學習（記憶版）」考題（使用者定 2026-07-21）：以「摘要＋對方帳號」為鑰匙，
// 編輯時學、未來匯入自動套用。隔離：STORE_FILE 暫存檔（持久化那幾題用 getDb/saveDb）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-banklearn-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { bankKeyOf, learnFromBankEdit, importBankTxToDb, previewBankTxForDb, listLearnedBank, deleteLearnedBank, applyLearnedBankToExisting, reconcileBankTxAccountNames } = await import('../lib/services/bank-import.js');
const { sanitizeLearnedBank } = await import('../lib/schema.js');
const { saveIncomeTree } = await import('../lib/services/categories.js');
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
test('learnFromBankEdit：清空自訂說明 → 回復預設自動名（autoNote）＋清學習名（使用者定 2026-07-21）', () => {
  const db = { learnedBank: { k: { type: 'income', category: '其他', name: '小明還錢' } } };
  const item = { source: 'bank', bankKey: 'k', type: 'income', category: '其他', subcategory: '', note: '', autoNote: '轉帳存入・ATM 對方' };
  learnFromBankEdit(db, item, { note: '小明還錢' });
  assert.equal(item.note, '轉帳存入・ATM 對方', '清空→回復 autoNote');
  assert.ok(!db.learnedBank['k']?.name, '清空→學習的自訂名清掉');
});
test('learnFromBankEdit：舊資料無 autoNote → 從 bankRef 尾兩段反解回復自動名', () => {
  const db = { learnedBank: { k: { type: 'income', category: '其他', name: '自訂' } } };
  const item = { source: 'bank', bankKey: 'k', type: 'income', category: '其他', subcategory: '', note: '', bankRef: 'bank|900100****3301|2026-06-01|in|5000||轉帳存入|ATM 對方帳號' };
  learnFromBankEdit(db, item, { note: '自訂' });
  assert.equal(item.note, '轉帳存入・ATM 對方帳號', '無 autoNote→bankRef 尾兩段反解');
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
  assert.equal(t.dir, 'in');   // 匯入忠實存下金流方向（Codex r13#2）
});
test('匯入：存下的 dir＝本筆實際方向（出帳→out）', () => {
  const db = baseDb();
  importBankTxToDb(db, parsed([btx({ summary: '跨行轉帳', note: '手續費', direction: 'out', amount: 15 })]));
  assert.equal(db.transactions.at(-1).dir, 'out');
});
test('匯入：存下 autoNote＝摘要・原始備註（清空自訂說明時回復用，使用者定 2026-07-21）', () => {
  const db = baseDb();
  importBankTxToDb(db, parsed([btx({ summary: '存款息', note: '利息2元', direction: 'in', amount: 2 })]));
  assert.equal(db.transactions.at(-1).autoNote, '存款息・利息2元');
});

// ---------- 帳戶改名連動（身分比對，使用者定 2026-07-21「改一次、處處同步」）----------
test('reconcileBankTxAccountNames：用遮罩帳號身分把 stale 顯示名對齊到帳戶現名；同末碼靠前綴區分', () => {
  const db = {
    accounts: [
      { id: 'a', name: '【台新】活儲（Richart）', type: 'cash', currency: 'TWD', accountNo: '900100****8791' },
      { id: 'b', name: '別的帳戶', type: 'cash', currency: 'TWD', accountNo: '900200****8791' },   // 同末碼、不同前綴
    ],
    transactions: [
      { id: 't1', source: 'bank', account: '台新 8791', bankRef: 'bank|900100****8791|2026-06-01|in|100||存款息|' },   // 舊自動名，屬 a
      { id: 't2', source: 'bank', account: '台新 8791', bankRef: 'bank|900200****8791|2026-06-02|out|50||提款|' },     // 屬 b
      { id: 'm1', source: 'manual', account: '手打帳戶', note: 'x' },   // 手動無 bankRef，不動
    ],
  };
  const changed = reconcileBankTxAccountNames(db);
  assert.equal(changed, 2);
  assert.equal(db.transactions.find(t => t.id === 't1').account, '【台新】活儲（Richart）');
  assert.equal(db.transactions.find(t => t.id === 't2').account, '別的帳戶', '同末碼靠前綴區分、不誤對');
  assert.equal(db.transactions.find(t => t.id === 'm1').account, '手打帳戶', '手動記帳（無 bankRef）不受影響');
  assert.equal(reconcileBankTxAccountNames(db), 0, '冪等：再跑一次無變動');
});
test('匯入：交割角色改名「結算」後，學過交割的鑰匙套到出帳 → 保留結算(方向中性)，不誤翻成內轉出（Codex r13#4）', () => {
  const db = baseDb();
  db.transferSubs = [{ label: '內轉出', role: 'out' }, { label: '內轉入', role: 'in' }, { label: '結算', role: 'settle' }];
  db.learnedBank['轉帳支取|#288810****3047'] = { type: 'transfer', category: '內轉', subcategory: '結算' };
  importBankTxToDb(db, parsed([btx({ summary: '轉帳支取', note: '288810****3047', direction: 'out', amount: 500000 })]));
  const t = db.transactions.at(-1);
  assert.equal(t.type, 'transfer'); assert.equal(t.category, '內轉');
  assert.equal(t.subcategory, '結算');   // settle 方向中性、保留現名；不因 out 方向翻成內轉出
  assert.equal(t.dir, 'out');
});
test('匯入：內轉出角色改名「匯出」後，學過內轉出（舊 token）的鑰匙套到出帳 → 依本筆方向取現名「匯出」（Codex r13#4）', () => {
  const db = baseDb();
  db.transferSubs = [{ label: '匯出', role: 'out' }, { label: '匯入', role: 'in' }, { label: '交割', role: 'settle' }];
  db.learnedBank['轉帳支取|#288810****3047'] = { type: 'transfer', category: '內轉', subcategory: '內轉出' };   // 學到舊 token
  importBankTxToDb(db, parsed([btx({ summary: '轉帳支取', note: '288810****3047', direction: 'out', amount: 500000 })]));
  assert.equal(db.transactions.at(-1).subcategory, '匯出');   // out 角色 → 本筆 out 方向 → 現名匯出
});
test('匯入端到端：收入分類改名後，自動分類的收入沿用新名（不掉到「其他」，Codex r13#3）', () => {
  const db = getDb();
  db.transactions = []; db.learnedBank = {};
  db.accounts = [{ id: 'a', name: '台新 3301', type: 'cash', currency: 'TWD', accountNo: '900100****3301' }];
  db.settings = { incomeTree: { '被動': ['利息', '股息'], '其他': ['其他收入'] } };
  saveDb(db);
  saveIncomeTree({ tree: { '投資收入': ['利息', '股息'], '其他': ['其他收入'] }, parentRenames: [{ from: '被動', to: '投資收入' }] });
  const d2 = getDb();   // 含改名後的收入樹＋別名
  importBankTxToDb(d2, parsed([btx({ summary: '存款息', direction: 'in', amount: 23, note: '' })]));
  saveDb(d2);
  const t = getDb().transactions.at(-1);
  assert.equal(t.category, '投資收入'); assert.equal(t.subcategory, '利息');   // 存款息→(關鍵字)被動/利息→(別名)投資收入/利息
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
test('學過的「交割」子分類是方向中性 → 不被改成內轉出/入（使用者定 2026-07-21）', () => {
  const db = baseDb();
  db.learnedBank['網轉|#900300****2162'] = { type: 'transfer', category: '內轉', subcategory: '交割' };
  importBankTxToDb(db, parsed([btx({ summary: '網轉', note: '900300****2162', direction: 'out', amount: 1000000 })]));
  const t = db.transactions.at(-1);
  assert.equal(t.type, 'transfer'); assert.equal(t.subcategory, '交割');   // 保留交割，不因方向改成內轉出
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

// ---------- 已學規則管理（設定頁「銀行收支學習」）----------
test('listLearnedBank：攤成陣列並把鑰匙拆成可讀的摘要/對方（#帳號去井號、描述原樣）', () => {
  const db = getDb();
  db.learnedBank = {
    'CD轉入|#806-00204127****1206': { type: 'income', category: '工作', subcategory: '鐘點', name: 'William 家教費' },
    '媒體轉入|基金配息群益主權': { type: 'income', category: '被動', subcategory: '股息' },
  };
  saveDb(db);
  const list = listLearnedBank();
  assert.equal(list.length, 2);
  const a = list.find(x => x.key.startsWith('CD轉入'));
  assert.equal(a.summary, 'CD轉入'); assert.equal(a.counterparty, '806-00204127****1206'); assert.equal(a.name, 'William 家教費');
  const b = list.find(x => x.key.startsWith('媒體轉入'));
  assert.equal(b.summary, '媒體轉入'); assert.equal(b.counterparty, '基金配息群益主權'); assert.equal(b.name, '');
});
test('deleteLearnedBank：刪指定鑰匙、其他不動；不存在的鑰匙安全略過', () => {
  const db = getDb();
  db.learnedBank = { k1: { type: 'income', category: '工作' }, k2: { type: 'expense', category: '生活' } };
  saveDb(db);
  deleteLearnedBank('k1');
  const left = getDb().learnedBank;
  assert.equal(left.k1, undefined); assert.ok(left.k2);
  deleteLearnedBank('不存在');   // 不炸
  assert.ok(getDb().learnedBank.k2);
});
test('deleteLearnedBank：保留字鑰匙用 hasOwn 判、不誤刪原型（比照 deleteLearned）', () => {
  const db = getDb();
  db.learnedBank = { real: { type: 'income', category: 'x' } };
  saveDb(db);
  deleteLearnedBank('toString');   // 'in' 會查到原型；hasOwn 不會 → 安全略過、real 還在
  assert.ok(getDb().learnedBank.real);
});

// ---------- 同類一起改（Q2乙）----------
test('applyLearnedBankToExisting：把學過的規則套到所有既有同鑰匙的銀行交易（別鑰匙/手動來源不動）', () => {
  const db = getDb();
  db.learnedBank = { k1: { type: 'transfer', category: '內轉', subcategory: '交割', name: '基金申購' } };
  db.transactions = [
    { id: 't1', source: 'bank', bankKey: 'k1', type: 'income', category: '其他', subcategory: '其他收入', note: '原文1', ledger: 'cashflow', date: '2026-06-01', amount: 100 },
    { id: 't2', source: 'bank', bankKey: 'k1', type: 'income', category: '其他', subcategory: '其他收入', note: '原文2', ledger: 'cashflow', date: '2026-06-02', amount: 200 },
    { id: 't3', source: 'bank', bankKey: 'other', type: 'income', category: '其他', subcategory: '其他收入', note: '別鑰匙', ledger: 'cashflow', date: '2026-06-03', amount: 300 },
    { id: 'm1', source: 'manual', bankKey: 'k1', type: 'income', category: '其他', subcategory: '其他收入', note: '手動', ledger: 'cashflow', date: '2026-06-04', amount: 400 },
  ];
  saveDb(db);
  const r = applyLearnedBankToExisting('k1');
  assert.equal(r.changed, 2);
  const after = getDb().transactions;
  const t1 = after.find(t => t.id === 't1');
  assert.equal(t1.type, 'transfer'); assert.equal(t1.category, '內轉'); assert.equal(t1.subcategory, '交割'); assert.equal(t1.note, '基金申購');   // 有自訂名 → 覆蓋
  assert.equal(after.find(t => t.id === 't3').type, 'income', '別鑰匙不動');
  assert.equal(after.find(t => t.id === 'm1').type, 'income', '手動來源不動');
});
test('applyLearnedBankToExisting：沒有自訂名 → 只改分類、各自 note 保留；內轉子分類依本筆方向（Codex r13#2）', () => {
  const db = getDb();
  db.learnedBank = { k1: { type: 'transfer', category: '內轉', subcategory: '內轉出' } };   // 無 name（學自某筆出帳）
  // t1 是**進帳**（dir:'in'）——套內轉規則要變「內轉入」，不可盲抄學到的「內轉出」（那會把進帳誤標成出帳型內轉）
  db.transactions = [{ id: 't1', source: 'bank', bankKey: 'k1', dir: 'in', type: 'income', category: '其他', subcategory: '其他收入', note: '原文A', ledger: 'cashflow', date: '2026-06-01', amount: 100 }];
  saveDb(db);
  applyLearnedBankToExisting('k1');
  const t1 = getDb().transactions.find(t => t.id === 't1');
  assert.equal(t1.subcategory, '內轉入'); assert.equal(t1.note, '原文A');   // 依本筆方向(in)＝內轉入；沒自訂名→保留原 note
});
test('applyLearnedBankToExisting：沒學過/找不到目標/保留字 → 明確錯誤（不靜默）', () => {
  const db = getDb(); db.learnedBank = {}; db.transactions = []; saveDb(db);
  assert.throws(() => applyLearnedBankToExisting('nokey'), /還沒有學過/);
  assert.throws(() => applyLearnedBankToExisting('__proto__'), /保留字/);
  const db2 = getDb(); db2.learnedBank = { k: { type: 'income', category: '其他' } }; db2.transactions = []; saveDb(db2);
  assert.throws(() => applyLearnedBankToExisting('k'), /找不到/);
});
test('applyLearnedBankToExisting：逐筆方向護欄——同鑰匙進帳/出帳，教收入只套進帳、出帳不被誤標成收入（Codex r13#2，生存級）', () => {
  const db = getDb();
  db.settings = { ...db.settings, incomeTree: { '工作': ['鐘點', '薪資'], '其他': ['其他收入'] } };   // 明設收入樹，免受別題污染（共用 STORE_FILE）
  db.learnedBank = { k1: { type: 'income', category: '工作', subcategory: '鐘點', name: '家教費' } };
  db.transactions = [
    { id: 'in1', source: 'bank', bankKey: 'k1', dir: 'in', type: 'income', category: '其他', subcategory: '其他收入', note: '進帳', ledger: 'cashflow', date: '2026-06-01', amount: 100 },
    { id: 'out1', source: 'bank', bankKey: 'k1', dir: 'out', type: 'expense', category: '其他', subcategory: '未分類', note: '出帳', ledger: 'cashflow', date: '2026-06-02', amount: 200 },
  ];
  saveDb(db);
  const r = applyLearnedBankToExisting('k1');
  assert.equal(r.changed, 1); assert.equal(r.skipped, 1);   // 只進帳被套；出帳方向不符略過
  const after = getDb().transactions;
  const inTx = after.find(t => t.id === 'in1'), outTx = after.find(t => t.id === 'out1');
  assert.equal(inTx.type, 'income'); assert.equal(inTx.category, '工作'); assert.equal(inTx.note, '家教費');
  assert.equal(outTx.type, 'expense'); assert.equal(outTx.category, '其他'); assert.equal(outTx.subcategory, '未分類');   // 出帳原封不動
});
test('applyLearnedBankToExisting：內轉規則套到同鑰匙進帳與出帳 → 子分類各依本筆方向（in→內轉入、out→內轉出）', () => {
  const db = getDb();
  db.learnedBank = { k2: { type: 'transfer', category: '內轉', subcategory: '內轉出' } };
  db.transactions = [
    { id: 'i', source: 'bank', bankKey: 'k2', dir: 'in', type: 'income', category: '其他', subcategory: '其他收入', note: 'A', ledger: 'cashflow', date: '2026-06-01', amount: 100 },
    { id: 'o', source: 'bank', bankKey: 'k2', dir: 'out', type: 'expense', category: '其他', subcategory: '未分類', note: 'B', ledger: 'cashflow', date: '2026-06-02', amount: 200 },
  ];
  saveDb(db);
  const r = applyLearnedBankToExisting('k2');
  assert.equal(r.changed, 2); assert.equal(r.skipped, 0);   // 內轉可套兩向
  const after = getDb().transactions;
  assert.equal(after.find(t => t.id === 'i').subcategory, '內轉入');   // 進帳→內轉入
  assert.equal(after.find(t => t.id === 'o').subcategory, '內轉出');   // 出帳→內轉出
});
test('applyLearnedBankToExisting：舊資料無 dir → 從 type 推方向（income=in），教支出套不上進帳（保守略過）', () => {
  const db = getDb();
  db.learnedBank = { k3: { type: 'expense', category: '生活', subcategory: '外食' } };
  db.transactions = [{ id: 'x', source: 'bank', bankKey: 'k3', type: 'income', category: '其他', subcategory: '其他收入', note: 'C', ledger: 'cashflow', date: '2026-06-01', amount: 100 }];   // 無 dir
  saveDb(db);
  const r = applyLearnedBankToExisting('k3');
  assert.equal(r.changed, 0); assert.equal(r.skipped, 1);   // income 推得 in、支出只套 out → 略過，不誤把進帳改成支出
});
test('applyLearnedBankToExisting：舊資料無 dir 但 bankRef=out → 用 bankRef 原始方向，教收入套不上（Codex r13 複審#1，高）', () => {
  const db = getDb();
  db.settings = { ...db.settings, incomeTree: { '工作': ['鐘點'], '其他': ['其他收入'] } };
  db.learnedBank = { k: { type: 'income', category: '工作', subcategory: '鐘點', name: '家教費' } };
  // 舊批次留下的不一致：bankRef 明確 out，但子分類卻是「內轉入」（只靠 type/子類會誤推成 in、把出帳改成收入）
  db.transactions = [{ id: 'old', source: 'bank', bankKey: 'k', type: 'transfer', category: '內轉', subcategory: '內轉入', note: '舊筆', ledger: 'cashflow', date: '2026-06-01', amount: 500, bankRef: 'bank|900100****3301|2026-06-01|out|500||轉帳支取|對方' }];
  saveDb(db);
  const r = applyLearnedBankToExisting('k');
  assert.equal(r.changed, 0); assert.equal(r.skipped, 1);   // bankRef=out 勝過分類 → 收入規則方向不符 → 略過
  assert.equal(getDb().transactions.find(t => t.id === 'old').type, 'transfer');   // 出帳沒被改成收入
});
