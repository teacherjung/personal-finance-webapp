// 「使用者自訂顯示名＝逐字照登」考題（使用者定 2026-07-20）。
//
// 病根：以前 app 把使用者存的自訂名當「半成品底稿」，每次匯入／整理都在上面**重貼一次標記**
// （applyDisplayLabels）。後果：①把（FP）拿掉、存成純名字，下次匯入又自己貼回去（使用者的選擇被推翻）；
// ②「店名格式整理」會把「人从众厚切牛排（FP）」硬拆成「人从众厚切牛排」→ 跳出「刪掉規則也救不回」的嚇人確認閘。
//
// 鐵則（鎖在這裡）：
//   ①自訂名逐字顯示——不自動加標記、也不自動拆標記（（FP）／（UE）／停車費（）／eTag 場站全算）。
//   ②只有「app 自動產的名字」（沒被使用者取過名的店）才貼標記。
//   ③使用者拿掉標記 → 逐字保留，下次不被補回去。
//   ④「店名格式整理」不動穩定的自訂名、也不因它跳確認閘（品牌改名規則 OLD→NEW 仍照舊套用並回報）。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-verbatim-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { applyLearned, customStoreName, learnFromStmtEdit } = await import('../lib/services/learning.js');
const { importRows, normalizeBranches } = await import('../lib/services/statement-import.js');
const { cleanStore } = await import('../lib/statement.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

const CARD = { id: 'c1', name: '測試卡', type: 'credit', lastFour: '0001' };
/** 一列預覽交易（匯入端會用 db 權威重算顯示名，r.store 只當自動名的底）。 */
const row = (desc, storeVal, extra = {}) => ({
  date: '2026-07-01', amount: 100, desc, store: storeVal,
  category: '飲食', subcategory: '餐廳', stmtRef: `c1|2026-07-01|100|${desc}`, ...extra });

// ---------- ① applyLearned 標 storeCustom（預覽端判「逐字 vs 自動」的依據）----------

test('applyLearned：命中自訂名 → 標 storeCustom、store＝自訂名逐字', () => {
  const db = { learnedCategories: { 'FP-阿牛牛排': { name: '阿牛牛排（FP）' } } };
  const [t] = applyLearned(db, [{ store: '阿牛牛排', desc: 'FP-阿牛牛排', storeKey: '阿牛牛排' }]);
  assert.equal(t.store, '阿牛牛排（FP）', '套用學過的自訂名（逐字，含使用者自己打的標記）');
  assert.equal(t.storeCustom, true, '標記為自訂 → conformTxs 不會再往上貼標記');
});

test('applyLearned：沒自訂名 → 不標 storeCustom（留給 conformTxs 貼自動標記）', () => {
  const db = { learnedCategories: {} };
  const [t] = applyLearned(db, [{ store: '石二鍋', desc: 'FP-石二鍋', storeKey: '石二鍋' }]);
  assert.ok(!t.storeCustom, '沒學過名字＝自動名，storeCustom 必須 falsy');
});

test('applyLearned：平台殘骸名（優食（UE））不算自訂 → 不標 storeCustom（落回自動、砍平台前綴）', () => {
  const db = { learnedCategories: { '優食-好麥豆漿': { name: '優食（UE）' } } };
  const [t] = applyLearned(db, [{ store: '好麥豆漿', desc: '優食-好麥豆漿', storeKey: '好麥豆漿' }]);
  assert.ok(!t.storeCustom, '舊 bug 的平台殘骸名不是真自訂 → 不逐字保留');
});

// customStoreName（匯入/同店改用它判自訂 vs 自動）必須與 applyLearned 逐層同判準，否則預覽≠匯入（自審 2026-07-20）。
test('customStoreName：原文級殘骸名不可遮蔽品牌級真自訂名（逐層排除，與 applyLearned 一致）', () => {
  // legacy/還原備份才會有的形狀：原文級是舊 bug 殘骸名、品牌級是真自訂名
  const db = { learnedCategories: { '優食-好麥豆漿': { name: '優食（UE）' }, '好麥豆漿': { name: '好麥豆漿本店' } } };
  assert.equal(customStoreName(db, '優食-好麥豆漿', '好麥豆漿'), '好麥豆漿本店',
    '原文級殘骸名要被逐層排除、落到品牌級真自訂名——不可先 || 合併再整體判（會回空、遮蔽真名）');
  // 與預覽端 applyLearned 對齊：同一筆兩邊都要認得品牌級真自訂名
  const [t] = applyLearned(db, [{ store: '好麥豆漿', desc: '優食-好麥豆漿', storeKey: '好麥豆漿' }]);
  assert.equal(t.store, '好麥豆漿本店', 'applyLearned 逐層排除殘骸、取品牌級真自訂名');
  assert.equal(t.storeCustom, true, '預覽與匯入一致：都判為自訂');
});

test('learnFromStmtEdit：只改分類、學過的是平台殘骸名 → 落回自動名（不逐字留殘骸，與 applyCategoryToStore 一致）', () => {
  const orig = '優食-好麥豆漿';
  const db = { learnedCategories: { [orig]: { name: '優食（UE）', category: '生活', subcategory: '' } } };
  const item = { source: 'stmt', storeKey: '好麥豆漿', note: '優食（UE）', category: '飲食', subcategory: '餐廳',
    stmtRef: `c1|2026-07-01|100|${orig}` };
  learnFromStmtEdit(db, item, { note: '優食（UE）' });   // note 欄沒動＝只改分類
  assert.equal(item.note, '好麥豆漿（UE）', '殘骸名不算真自訂 → 只改分類時 note 落回自動名（好麥豆漿（UE））');
});

// ---------- ② 匯入：自訂名逐字、自動名照樣貼標記 ----------

test('匯入：使用者把（FP）拿掉、存成純名「阿牛牛排」→ 逐字保留，下次匯入不補回（FP）', () => {
  store.save({ ...store.emptyDb(), cards: [CARD],
    learnedCategories: { 'FP-阿牛牛排': { name: '阿牛牛排' } } });   // 使用者刻意拿掉（FP）
  importRows('c1', [row('FP-阿牛牛排', '阿牛牛排')]);
  const t = (store.load().transactions || []).find(x => x.stmtRef === 'c1|2026-07-01|100|FP-阿牛牛排');
  assert.equal(t.note, '阿牛牛排', '匯入逐字沿用自訂名，絕不自動把（FP）補回去（使用者的選擇要 stick）');
});

test('匯入：自訂名本身帶（FP）→ 逐字「阿牛牛排（FP）」，不會變成兩個（冪等）', () => {
  store.save({ ...store.emptyDb(), cards: [CARD],
    learnedCategories: { 'FP-阿牛牛排': { name: '阿牛牛排（FP）' } } });
  importRows('c1', [row('FP-阿牛牛排', '阿牛牛排（FP）')]);
  const t = (store.load().transactions || []).find(x => x.stmtRef === 'c1|2026-07-01|100|FP-阿牛牛排');
  assert.equal(t.note, '阿牛牛排（FP）', '自訂名逐字，不重複貼標記');
});

test('匯入：沒被取過名的 FP 消費 → 自動名照樣貼「（FP）」（回歸：標記機制沒被關掉）', () => {
  store.save({ ...store.emptyDb(), cards: [CARD], learnedCategories: {} });
  importRows('c1', [row('FP-石二鍋', cleanStore('FP-石二鍋'))]);
  const t = (store.load().transactions || []).find(x => x.stmtRef === 'c1|2026-07-01|100|FP-石二鍋');
  assert.equal(t.note, '石二鍋（FP）', '自動名（沒有自訂名）仍要貼外送標記');
});

// ---------- ③ 店名格式整理：不動自訂名、不因它跳確認閘 ----------

test('整理：自訂名「人从众厚切牛排（FP）」逐字不動，不列入變更、不跳確認閘', () => {
  const orig = 'FP-人从众厚切牛排';
  store.save({ ...store.emptyDb(), cards: [CARD],
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', subcategory: '餐廳',
      amount: 100, note: '人从众厚切牛排（FP）', storeKey: '人从众厚切牛排', source: 'stmt',
      stmtRef: `c1|2026-07-01|100|${orig}` }],
    learnedCategories: { [orig]: { name: '人从众厚切牛排（FP）' } } });
  const r = normalizeBranches(true);   // dryRun 預覽
  assert.ok(!(r.changes || []).some(c => c.id === 't1'), 'note 逐字不變，不列入整理清單');
  assert.ok(!(r.learnedNameChanges || []).some(c => c.before === '人从众厚切牛排（FP）'),
    '不再把（FP）拆掉 → 不會跳「刪掉規則也救不回」的確認閘');
});

test('整理：使用者拿掉（FP）的「人从众厚切牛排」逐字保留，不補回（FP）', () => {
  const orig = 'FP-人从众厚切牛排';
  store.save({ ...store.emptyDb(), cards: [CARD],
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', subcategory: '餐廳',
      amount: 100, note: '人从众厚切牛排', storeKey: '人从众厚切牛排', source: 'stmt',
      stmtRef: `c1|2026-07-01|100|${orig}` }],
    learnedCategories: { [orig]: { name: '人从众厚切牛排' } } });   // 使用者刻意拿掉（FP）
  normalizeBranches(false);   // 真的套用
  const t = (store.load().transactions || []).find(x => x.id === 't1');
  assert.equal(t.note, '人从众厚切牛排', '整理不把使用者拿掉的（FP）補回去');
});
