// 「顯示名跟著分類走」考題（使用者定 2026-07-19，取代手動的「整理店名格式」按鈕）。
//
// 病根：顯示名有一部分取決於分類——子類是「停車費」時要包成「停車費（店名）」。
// 以前只改分類不會重算 note，得手動去按「整理店名格式」才補得上，而那正是第一帖要消滅的
// 「忘了按按鈕」。更糟的是學習比對會拿**新分類算出的自動名**去比**沒重算的舊 note**，
// 兩者當然不同 → 把原本的自動名誤記成使用者刻意取的自訂名，日後規則再怎麼改進都會被壓過去。
//
// ⚠️ 一定要走 `updateItem`（真正的編輯路徑）才驗得到：判準靠的是 updateItem 提供的 `prev`
//（前端表單整份送出，patch 裡一定有 note，光看 patch 分不出「改了店名」還是「只改分類」）。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-note-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { updateItem } = await import('../lib/repo.js');
const { learnFromStmtEdit } = await import('../lib/services/learning.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

const ORIG = '嘟嘟房林口站';
/** @param {any} tx 覆寫欄位 @param {any} [learned] */
const seed = (tx, learned) => store.save({ ...store.emptyDb(),
  transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '其他', subcategory: '未分類',
    amount: 60, note: ORIG, storeKey: '嘟嘟房', source: 'stmt', stmtRef: `c1|2026-07-01|60|${ORIG}`, ...tx }],
  learnedCategories: learned || {} });

test('只改分類：顯示名跟著新分類重算，而且不留假自訂名', () => {
  seed({});
  updateItem('transactions', 't1', { category: '交通', subcategory: '停車費' }, learnFromStmtEdit);
  const db = store.load();
  assert.equal(db.transactions?.[0].note, '停車費（嘟嘟房林口站）',
    '改完分類顯示名就要跟上，不必再去按「整理店名格式」');
  assert.equal(db.learnedCategories?.[ORIG]?.name, undefined,
    '使用者根本沒改店名，不可以把原本的自動名誤記成自訂名');
  assert.deepEqual(db.learnedCategories?.['嘟嘟房'], { category: '交通', subcategory: '停車費' },
    '分類照舊學在品牌層');
});

test('這次真的改了店名：以使用者取的名字為準並學起來（不可被自動名蓋掉）', () => {
  seed({ category: '交通', subcategory: '停車費', note: '停車費（嘟嘟房林口站）' });
  updateItem('transactions', 't1', { note: '公司樓下停車場' }, learnFromStmtEdit);
  const db = store.load();
  assert.equal(db.transactions?.[0].note, '公司樓下停車場', '使用者打的名字不可被覆寫');
  assert.equal(db.learnedCategories?.[ORIG]?.name, '公司樓下停車場', '而且要學起來，下次匯入沿用');
});

test('已有自訂名 + 只改分類：自訂名逐字不動，不自動貼標記（使用者定 2026-07-20）', () => {
  // 使用者刻意取的顯示名＝逐字照登：就算子類改成「停車費」，也不自動包成「停車費（公司樓下）」——
  // 使用者在編輯框看到的本來就是完整顯示名，沒打標記＝他的選擇（不希望 app 再貼）。
  seed({ note: '公司樓下' }, { [ORIG]: { name: '公司樓下' } });
  updateItem('transactions', 't1', { category: '交通', subcategory: '停車費' }, learnFromStmtEdit);
  const db = store.load();
  assert.equal(db.transactions?.[0].note, '公司樓下', '自訂名逐字保留，不自動貼「停車費（）」');
  assert.equal(db.learnedCategories?.[ORIG]?.name, '公司樓下', '學習表存的自訂名也不動');
});

test('冪等：同樣的編輯再存一次，顯示名與學習表都不再變動', () => {
  seed({});
  updateItem('transactions', 't1', { category: '交通', subcategory: '停車費' }, learnFromStmtEdit);
  const after1 = JSON.stringify(store.load());
  updateItem('transactions', 't1', { category: '交通', subcategory: '停車費' }, learnFromStmtEdit);
  assert.equal(JSON.stringify(store.load()), after1, '重複儲存不可讓名字愈包愈多層');
});

test('把分類改回非停車：包裝要拆掉，不可留著「停車費（…）」', () => {
  seed({});
  updateItem('transactions', 't1', { category: '交通', subcategory: '停車費' }, learnFromStmtEdit);
  assert.equal(store.load().transactions?.[0].note, '停車費（嘟嘟房林口站）');
  updateItem('transactions', 't1', { category: '生活', subcategory: '其他生活雜支' }, learnFromStmtEdit);
  assert.equal(store.load().transactions?.[0].note, '嘟嘟房林口站', '改錯了改回來，名字也要跟著回去');
});

test('手動記帳（沒有帳單原文）不受影響', () => {
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '其他', subcategory: '未分類',
      amount: 60, note: '我自己寫的備註' }] });
  updateItem('transactions', 't1', { category: '交通', subcategory: '停車費' }, learnFromStmtEdit);
  assert.equal(store.load().transactions?.[0].note, '我自己寫的備註', '手動記帳的備註絕不可被改寫');
  assert.deepEqual(store.load().learnedCategories, {}, '手動記帳不學');
});

// ---------- 第二條路：「同店一起改」（apply-category）----------
// 單筆編輯修好之後才發現的（瀏覽器實測抓到）：勾「同時套用到這家店的其他 N 筆」走的是
// applyCategoryToStore，它同樣只改分類、不重算顯示名 → 那 N 筆的名字全部停在舊樣子。
// 同一個根因、第二條路，修法也是同一套。

test('同店一起改：那 N 筆的顯示名也要跟著新分類重算', async () => {
  const { applyCategoryToStore } = await import('../lib/services/statement-import.js');
  const mk = (/** @type {string} */ d, /** @type {string} */ n) => ({
    id: 't' + d.slice(-2), date: d, type: 'expense', category: '其他', subcategory: '未分類',
    amount: 50, note: n, storeKey: '阜爾運通', source: 'stmt', stmtRef: `c1|${d}|50|${n}` });
  store.save({ ...store.emptyDb(),
    transactions: [mk('2026-07-11', '阜爾運通信義店'), mk('2026-07-12', '阜爾運通大安店')] });

  const r = applyCategoryToStore('阜爾運通', '交通', '停車費');
  assert.equal(r.changed, 2);
  assert.deepEqual((store.load().transactions || []).map(t => t.note),
    ['停車費（阜爾運通信義店）', '停車費（阜爾運通大安店）'],
    '整店改分類之後，每一筆的顯示名都要跟上');
});

test('同店一起改：有自訂名的那一筆，逐字保留、不自動貼標記（使用者定 2026-07-20）', async () => {
  const { applyCategoryToStore } = await import('../lib/services/statement-import.js');
  const orig = '阜爾運通信義店';
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-11', type: 'expense', category: '其他', subcategory: '未分類',
      amount: 50, note: '公司樓下', storeKey: '阜爾運通', source: 'stmt', stmtRef: `c1|2026-07-11|50|${orig}` }],
    learnedCategories: { [orig]: { name: '公司樓下' } } });

  applyCategoryToStore('阜爾運通', '交通', '停車費');
  assert.equal(store.load().transactions?.[0].note, '公司樓下', '自訂名逐字保留，不自動包成「停車費（）」');
  assert.equal(store.load().learnedCategories?.[orig]?.name, '公司樓下', '自訂名本身不動');
});

test('同店一起改：冪等（再跑一次不會愈包愈多層）', async () => {
  const { applyCategoryToStore } = await import('../lib/services/statement-import.js');
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-11', type: 'expense', category: '其他', subcategory: '未分類',
      amount: 50, note: '阜爾運通信義店', storeKey: '阜爾運通', source: 'stmt',
      stmtRef: 'c1|2026-07-11|50|阜爾運通信義店' }] });
  applyCategoryToStore('阜爾運通', '交通', '停車費');
  const once = store.load().transactions?.[0].note;
  applyCategoryToStore('阜爾運通', '交通', '停車費');
  assert.equal(store.load().transactions?.[0].note, once, '重複套用結果不變');
});
