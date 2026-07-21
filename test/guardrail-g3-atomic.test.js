// 護欄 G3（2026-07-22）：「同類/同店一起改」原子化——單筆編輯＋傳播到同鑰匙其他筆**一次寫檔**完成，
// 取代前端「PUT 再另呼 apply」兩次寫（中途失敗會半套用）。這裡守三件事：
//  ①HTTP 端 PUT applyAll 真的觸發傳播、回傳 applied 計數；②方向護欄在原子路徑仍生效（Codex r13#2 不被繞過）；
//  ③工作函式（*ToDb）是**純的**（不自己 saveDb）——這正是原子性的地基（呼叫端掌握唯一一次寫檔）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

const TEST_STORE = join(tmpdir(), `finance-g3-atomic-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { applyCategoryToStoreDb } = await import('../lib/services/statement-import.js');
const { applyLearnedBankToDb } = await import('../lib/services/bank-import.js');
const { storeKeyOf } = await import('../lib/statement.js');

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;
const SEND = (method) => async (p, body) => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const POST = SEND('POST'), PUT = SEND('PUT');
const GET = async (p) => (await fetch(base + p)).json();

after(() => {
  server.close();
  for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

/** 每題重置：清交易＋學習表，明設分類樹（共用 STORE_FILE，免受別題污染）。 */
function reset(txns) {
  const db = getDb();
  db.transactions = txns;
  db.learnedBank = {};
  db.learnedCategories = {};
  db.settings = { ...db.settings, incomeTree: { 工作: ['鐘點', '薪資'], 其他: ['其他收入'] } };
  saveDb(db);
}

// 用「星巴克」分店＝storeKeyOf 會把分店收斂成品牌鑰匙「星巴克」（阜爾運通不收斂、兩原文各自成鑰匙），
// 才貼近真實：同品牌多原文共用一把 storeKey。seed 的 storeKey 用 storeKeyOf(orig) 保持與生產一致。
const stmtTx = (id, date, orig, cat = '其他', sub = '未分類') => ({
  id, date, type: 'expense', category: cat, subcategory: sub, amount: 50, note: orig,
  storeKey: storeKeyOf(orig), source: 'stmt', stmtRef: `c1|${date}|50|${orig}`, ledger: 'card',
});
const bankTx = (id, date, dir, note, amount = 100) => ({
  id, date, dir, amount, source: 'bank', bankKey: 'k1', ledger: 'cashflow',
  type: dir === 'in' ? 'income' : 'expense', category: '其他', subcategory: dir === 'in' ? '其他收入' : '未分類', note,
});

// ---------- ① 帳單「同店一起改」原子路徑（transactions.js 走的 PUT applyAll）----------
test('PUT /transactions/:id applyAll（帳單）：一次寫檔完成編輯＋同店傳播，回傳 applied 計數，N 筆全改到', async () => {
  reset([stmtTx('a', '2026-07-11', '星巴克信義店'), stmtTx('b', '2026-07-12', '星巴克大安店')]);
  const r = await (await PUT('/transactions/a', { category: '交通', subcategory: '停車費', note: '停車費', applyAll: true })).json();
  assert.ok(r.applied, '有勾 applyAll → 回傳傳播計數');
  assert.equal(r.applied.changed, 1, '同店另 1 筆一起改到（不含被編輯的本筆）');
  const after = await GET('/transactions');
  for (const t of after) { assert.equal(t.category, '交通'); assert.equal(t.subcategory, '停車費'); }
  assert.match(after.find(t => t.id === 'b').note, /停車費/, '傳播那筆的顯示名也跟著新分類重算（停車費包裝）');
});

test('PUT /transactions/:id 不帶 applyAll（帳單）：只改本筆，不傳播、回應無 applied', async () => {
  reset([stmtTx('a', '2026-07-11', '星巴克信義店'), stmtTx('b', '2026-07-12', '星巴克大安店')]);
  const r = await (await PUT('/transactions/a', { category: '交通', subcategory: '停車費' })).json();
  assert.equal(r.applied, undefined, '沒勾 → 不回 applied');
  const after = await GET('/transactions');
  assert.equal(after.find(t => t.id === 'b').category, '其他', '同店另一筆維持原分類（沒被傳播）');
});

// ---------- ② 銀行「同類一起改」原子路徑（cashflow.js 走的 PUT applyAll）+ 方向護欄 ----------
test('PUT /transactions/:id applyAll（銀行）：同方向同鑰匙一起改；反方向那筆被方向護欄擋下（skipped）', async () => {
  reset([
    bankTx('in1', '2026-06-01', 'in', '進帳A'),
    bankTx('in2', '2026-06-02', 'in', '進帳B'),
    bankTx('out1', '2026-06-03', 'out', '出帳'),
  ]);
  // 把 in1 改成收入·工作·鐘點·家教費並套同類 → in2 同方向被套；out1 反方向被護欄擋（生存級：出帳不可被誤標成收入）
  const r = await (await PUT('/transactions/in1', { type: 'income', category: '工作', subcategory: '鐘點', note: '家教費', applyAll: true })).json();
  assert.ok(r.applied);
  assert.equal(r.applied.changed, 1, '另一筆進帳被套');
  assert.equal(r.applied.skipped, 1, '出帳方向不符→略過');
  const after = await GET('/transactions');
  const in2 = after.find(t => t.id === 'in2'), out1 = after.find(t => t.id === 'out1');
  assert.equal(in2.type, 'income'); assert.equal(in2.category, '工作'); assert.equal(in2.note, '家教費');
  assert.equal(out1.type, 'expense'); assert.equal(out1.category, '其他'); assert.equal(out1.subcategory, '未分類');   // 出帳原封不動
});

// ---------- ③ 設定頁「同店一起改」原子路徑（settings.js 走的 rename-store applyAll）----------
test('POST /statement/rename-store applyAll：改名＋分類傳播一次寫檔，回傳 applied 計數', async () => {
  reset([stmtTx('a', '2026-07-11', '星巴克信義店'), stmtTx('b', '2026-07-12', '星巴克大安店')]);
  const r = await (await POST('/statement/rename-store', {
    orig: '星巴克信義店', name: '公司樓下', category: '交通', subcategory: '停車費', applyAll: true,
  })).json();
  assert.ok(r.applied, '有勾 applyAll → 回傳傳播計數');
  assert.equal(r.applied.changed, 1, '同品牌另一原文一起改分類');
  const after = await GET('/transactions');
  for (const t of after) assert.equal(t.category, '交通', '整品牌分類都改到');
  assert.equal(after.find(t => t.id === 'a').note, '公司樓下', '被編輯原文用自訂顯示名');
});

// ---------- ④ 工作函式純度（原子性的地基）：*ToDb 只改 in-memory、不落檔 ----------
test('applyCategoryToStoreDb 是純的：改傳入的 db 物件、但不自己 saveDb（原子呼叫端才寫）', () => {
  reset([stmtTx('a', '2026-07-11', '星巴克信義店')]);
  const db = getDb();
  const r = applyCategoryToStoreDb(db, '星巴克', '交通', '停車費');
  assert.equal(r.changed, 1, '傳入的 db 物件確實被改');
  assert.equal(db.transactions.find(t => t.id === 'a').category, '交通');
  // 關鍵：沒有 saveDb → 重新讀檔應該還是舊值（證明 worker 不寫檔）
  assert.equal(getDb().transactions.find(t => t.id === 'a').category, '其他', '未落檔：磁碟上仍是原分類');
});

test('applyLearnedBankToDb 是純的：改傳入的 db 物件、但不自己 saveDb', () => {
  reset([bankTx('in1', '2026-06-01', 'in', '進帳')]);
  const db = getDb();
  db.learnedBank = { k1: { type: 'income', category: '工作', subcategory: '鐘點', name: '家教費' } };
  const r = applyLearnedBankToDb(db, 'k1');
  assert.equal(r.changed, 1);
  assert.equal(db.transactions.find(t => t.id === 'in1').note, '家教費', '傳入 db 被改');
  assert.equal(getDb().transactions.find(t => t.id === 'in1').note, '進帳', '未落檔：磁碟上仍是原 note');
});
