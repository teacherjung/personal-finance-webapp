// 原型污染防線考題（Codex r4#1，高）。
//
// 這個 app 有好幾張「使用者文字當 key」的表：學習表、分類別名、子類別名。若不設防，
// 使用者輸入 __proto__（分類改名的 parent、帳單原文…）會污染全域 Object.prototype——
// 實測後果不只是資料錯，而是**連 pdfjs 都當場崩潰**（Object.defineProperty called on non-object），
// 整個帳單解析掛掉。這裡鎖住「不論從哪個入口，都不會污染原型、也不會把資料寫丟」。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-proto-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { saveTree } = await import('../lib/services/categories.js');
const { learnFromStmtEdit } = await import('../lib/services/learning.js');
const { sanitizeLearned } = await import('../lib/schema.js');
const { isProtoKey, safeMap, getOwn, setOwn } = await import('../lib/safe-map.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-categories.bak', '.pre-income-categories.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});
// 每題後清掉可能殘留的污染，避免一題污染影響下一題的判斷（也順便證明「污染會外溢」）
afterEach(() => { for (const k of ['x', 'category', 'codexPolluted', 'polluted']) delete (/** @type {any} */ (Object.prototype))[k]; });

/** 空物件透過原型繼承到的值（非 undefined＝全域被污染了）。 @param {string} k */
const inherited = (k) => (/** @type {any} */ ({}))[k];

test('safe-map 判準：Object.prototype 的名字全擋，真店名放行', () => {
  assert.ok(isProtoKey('__proto__') && isProtoKey('toString') && isProtoKey('hasOwnProperty'));
  assert.ok(!isProtoKey('星巴克') && !isProtoKey('嘟嘟房'));
});

test('setOwn 拒絕原型名（回 false），getOwn 不掉到原型上', () => {
  const m = {};
  assert.equal(setOwn(m, '__proto__', { evil: 1 }), false, '原型名寫入要被拒');
  assert.equal(inherited('evil'), undefined, '而且不可污染原型');
  assert.equal(getOwn({}, 'toString'), undefined, 'getOwn 對沒有的 key 回 undefined，不回原型上的 toString');
  assert.equal(setOwn(m, '星巴克', { category: '飲食' }), true, '真店名照常寫入');
});

test('safeMap 重建：丟掉自有的 __proto__ 鍵（JSON.parse 做得出這種鍵）', () => {
  const evil = JSON.parse('{"__proto__": {"polluted": 1}, "好店": {"category": "飲食"}}');
  const dropped = [];
  const clean = safeMap(evil, dropped);
  assert.deepEqual(Object.keys(clean), ['好店'], '原型名鍵被丟掉、真的 key 留著');
  assert.ok(dropped.includes('__proto__'));
});

test('分類改名：parent 是 __proto__ 不可污染全域原型（Codex r4 實測案例）', async () => {
  store.save({ ...store.emptyDb() });
  await saveTree({ tree: { '飲食': ['麵食'] }, subRenames: [{ parent: '__proto__', from: 'x', to: 'codexPolluted' }] });
  assert.equal(inherited('codexPolluted'), undefined, 'Object.prototype 不可被污染');
});

test('編輯帳單交易：storeKey / 帳單原文是 __proto__ 都不污染、也不寫進學習表', () => {
  const db = { learnedCategories: {} };
  learnFromStmtEdit(db, { source: 'stmt', storeKey: '__proto__', stmtRef: 'c1|d|1|__proto__',
    note: 'X', category: '飲食', subcategory: '麵食' });
  assert.equal(inherited('category'), undefined, '原型不可被污染（會讓每個物件都突然有 category）');
  assert.deepEqual(Object.keys(db.learnedCategories), [], '原型名不可成為學習表 key');
});

test('sanitizeLearned：整張表重建成無原型 map，原型名 key 被丟掉', () => {
  const evil = JSON.parse('{"__proto__": {"category": "飲食"}, "constructor": {"category": "娛樂"}, "好店": {"category": "飲食"}}');
  const clean = sanitizeLearned(evil);
  assert.equal(Object.getPrototypeOf(clean), null, '學習表要是 null-prototype（JSON 來回不會退化污染）');
  assert.deepEqual(Object.keys(clean), ['好店'], '只留下真的店家 key');
  assert.equal(inherited('category'), undefined);
});

test('污染防線是全鏈路的：壞資料寫進資料庫再讀回來也乾淨', () => {
  // 直接把帶原型名 key 的學習表塞進 save（模擬被污染過的舊備份還原）
  const bad = JSON.parse('{"好店":{"category":"飲食"},"__proto__":{"category":"娛樂"}}');
  store.save({ ...store.emptyDb(), learnedCategories: bad });
  const back = store.load();
  assert.deepEqual(Object.keys(back.learnedCategories || {}), ['好店'], '櫃檯的 sanitizeLearned 會清掉原型名 key');
  assert.equal(inherited('category'), undefined);
});

// ---------- Codex r5#1：學習表四條寫入路（匯入學習／整店改分類／改名／刪除）的保留字回歸 ----------
const { learnFromImport } = await import('../lib/services/learning.js');
const { applyCategoryToStore, renameStoreDisplay, deleteLearned, getLearned } = await import('../lib/services/statement-import.js');
const { sanitizeTree } = await import('../lib/services/categories.js');
const { sanitizeCategorySettings } = await import('../lib/schema.js');

test('r5#1｜learnFromImport：storeKey 是 __proto__ → 不污染原型、不寫進學習表', () => {
  const db = { learnedCategories: {} };
  learnFromImport(db, '__proto__', '某家店', '飲食', '');
  assert.equal(inherited('category'), undefined, '以前這裡會把「飲食」寫上 Object.prototype（Codex 實測）');
  assert.deepEqual(Object.keys(db.learnedCategories), [], '也不可留下任何鍵');
  // 正常店名照常學（確保守門沒有誤傷）
  learnFromImport(db, '好店', '好店 台北', '飲食', '');
  assert.ok(Object.hasOwn(db.learnedCategories, '好店'), '真店名照常寫入');
});

test('r5#1｜applyCategoryToStore：鑰匙是保留字 → 明確 400，不污染', async () => {
  store.save({ ...store.emptyDb() });
  await assert.rejects(() => applyCategoryToStore('__proto__', '飲食'), /保留字/);
  await assert.rejects(() => applyCategoryToStore('toString', '飲食'), /保留字/);
  assert.equal(inherited('category'), undefined);
});

test('r5#1｜renameStoreDisplay：原文／新名是保留字 → 明確 400，學習表原型不可被換掉', async () => {
  store.save({ ...store.emptyDb(), learnedCategories: { '好店': { category: '飲食' } } });
  await assert.rejects(() => renameStoreDisplay('__proto__', '新名字'), /保留字/);
  await assert.rejects(() => renameStoreDisplay('好店 台北', '__proto__'), /保留字/);
  const lc = await getLearned();
  assert.equal(Object.getPrototypeOf(lc) === Object.prototype || Object.getPrototypeOf(lc) === null, true,
    '學習表的原型不可被換成別的物件（lc[__proto__]=e 的後果）');
  assert.ok(Object.hasOwn(lc, '好店'), '既有學習不受影響');
});

test('r5#1｜deleteLearned：toString 走原型鏈的 in 誤判已修——不誤刪、不拋錯、真鍵照刪', async () => {
  store.save({ ...store.emptyDb(), learnedCategories: { '好店': { category: '飲食' } } });
  assert.deepEqual(await deleteLearned('toString'), { ok: true });
  assert.ok(Object.hasOwn(await getLearned(), '好店'), '無關的刪除不可動到既有學習');
  await deleteLearned('好店');
  assert.ok(!Object.hasOwn(await getLearned(), '好店'), '真的自有鍵照常刪');
});

// ---------- Codex r5#4：分類樹——寫入明確拒絕（不靜默吞掉）、讀取容忍舊資料 ----------
test('r5#4｜saveTree：分類名／子類名／改名目標是保留字 → 明確 400（以前靜默消失＝改名變刪除）', async () => {
  store.save({ ...store.emptyDb() });
  // ⚠️ 大類名要用 JSON.parse 做：物件「字面量」裡的 '__proto__' 是設原型的特殊語法、不會成為自有鍵；
  // 真實 HTTP 路徑就是 JSON.parse，做得出這種自有鍵
  await assert.rejects(() => saveTree({ tree: JSON.parse('{"__proto__": ["x"]}') }), /保留字/);
  await assert.rejects(() => saveTree({ tree: { '飲食': ['__proto__'] } }), /保留字/);
  await assert.rejects(() => saveTree({ tree: { 'toString': ['x'] } }), /保留字/, '寫入口徑統一：整個保留字家族都拒（讀取仍容忍舊資料）');
  await assert.rejects(() => saveTree({ tree: { '飲食': ['麵食'] }, parentRenames: [{ from: '飲食', to: '__proto__' }] }), /保留字/);
  assert.equal(inherited('x'), undefined);
});

test('r5#4｜sanitizeTree：自有 __proto__ 鍵（JSON.parse 產物）容忍地丟棄，原型不可變成陣列', () => {
  const evil = JSON.parse('{"__proto__": ["polluted"], "飲食": ["麵食"]}');
  const t = sanitizeTree(evil);
  assert.ok(!Object.keys(t).includes('__proto__'), '丟棄不保留');
  assert.notEqual(Object.getPrototypeOf(t), evil['__proto__'], '原型不可被換成那個陣列');
  assert.deepEqual(t['飲食'], ['麵食'], '真分類留著');
});

test('r5#4｜sanitizeCategorySettings：__proto__ 鍵丟棄並回報 bad（匯入備份路）', () => {
  const src = JSON.parse('{"expenseTree":{"__proto__":["x"],"飲食":["麵食"]},"categoryAliases":{"__proto__":"壞"},"subAliases":{"__proto__":{"a":"b"},"飲食":{"__proto__":"壞"}}}');
  /** @type {string[]} */
  const bad = [];
  const out = sanitizeCategorySettings(src, bad);
  assert.deepEqual(Object.keys(out.expenseTree), ['飲食']);
  assert.deepEqual(Object.keys(out.categoryAliases), []);
  assert.deepEqual(Object.keys(out.subAliases), ['飲食']);
  assert.deepEqual(Object.keys(out.subAliases['飲食']), []);
  assert.ok(bad.filter(b => b.includes('__proto__')).length >= 4, '每一處丟棄都要回報，不靜默');
  assert.equal(inherited('a'), undefined);
});

// ---------- Codex r6#3：第三輪掃蕩——後端可直測的三處（前端三處見 PR 說明） ----------
const { listBatches } = await import('../lib/services/statement-import.js');
const { resolveImportCategory } = await import('../lib/services/categories.js');
const { computeAssets, buildSummary } = await import('../lib/derive.js');

test('r6#3｜resolveImportCategory：舊分類叫 toString → 原樣保留，不可誤改成 其他/未分類', () => {
  // 裸讀 pA[cat] 會撈到原型上的函式（truthy）→ c 變成函式 → conform 對不上 → 合法舊分類被毀
  const db = { settings: { expenseTree: { 'toString': ['x'], '其他': ['未分類'] } } };
  assert.deepEqual(resolveImportCategory(db, 'toString', 'x'), ['toString', 'x'],
    '讀取容忍舊資料：樹裡真的有這個分類就要對得上');
  assert.deepEqual(resolveImportCategory(db, '不存在的', ''), ['其他', '未分類'], '正常校正不受影響');
});

test('r6#3｜listBatches：批次 id 是 __proto__ → 批次照常出現在清單、不污染全域', async () => {
  store.save({ ...store.emptyDb(), transactions: [
    { id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 100,
      source: 'stmt', stmtRef: 'c|2026-07-01|100|某店', importBatch: '__proto__', importedAt: '2026-07-01T00:00:00Z' },
  ] });
  const batches = await listBatches();
  assert.equal(batches.length, 1, '以前這一批會從清單消失（讀到原型本尊、永遠不進 groups 的自有鍵）');
  assert.equal(batches[0].batchId, '__proto__');
  assert.equal(batches[0].count, 1);
  assert.equal(inherited('count'), undefined, '而且不可在 Object.prototype 上累加 count/amount');
  assert.equal(inherited('amount'), undefined);
});

test('r6#3｜資產類別叫 toString：淨值聚合與配置目標都要算成數字，不可變函式字串', () => {
  const db = { ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'x', type: 'cash', class: 'toString', currency: 'TWD', balance: 100 }],
    assetTargets: [{ id: 'g1', class: 'toString', targetPct: 50 }] };
  const a = computeAssets(db);
  assert.equal(a.byClass['toString'], 100, '裸物件的 || 0 會撈到原型函式、加總變字串');
  const rows = buildSummary(db).allocation.rows;   // computeAllocation 是內部函式，經 buildSummary 驗
  const row = rows.find(r => r.class === 'toString');
  assert.equal(row?.targetPct, 50);
  assert.equal(typeof row?.actualPct, 'number');
});
