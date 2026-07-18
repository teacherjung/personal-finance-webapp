// 帳單自動學習的考題：什麼該學、什麼不該學。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLearned, learnFromStmtEdit, learnFromImport } from '../lib/services/learning.js';
import { isServiceFee } from '../lib/statement.js';

test('isServiceFee：認得國外交易服務費（finalize 與 learning 共用同一判準）', () => {
  assert.equal(isServiceFee('國外交易服務費-2350.00'), true);
  assert.equal(isServiceFee('國外交易服務費'), true);
  assert.equal(isServiceFee('星巴克'), false);
  assert.equal(isServiceFee(''), false);
  assert.equal(isServiceFee(/** @type {any} */ (null)), false);
});

test('服務費不學（編輯）：改服務費的分類不會寫進學習表', () => {
  const db = { learnedCategories: {} };
  learnFromStmtEdit(db, { source: 'stmt', storeKey: '國外交易服務費-2350.00', note: '國外交易服務費-2350.00', category: '健康', subcategory: '' });
  assert.deepEqual(db.learnedCategories, {}, '帶金額的服務費 key 永遠不會再命中，學了只會讓學習表膨脹');
});

test('服務費不學（匯入）：匯入時選的分類不會寫進學習表', () => {
  const db = { learnedCategories: {} };
  learnFromImport(db, '國外交易服務費-170.00', '國外交易服務費-170.00', '娛樂', '遊戲');
  assert.deepEqual(db.learnedCategories, {});
});

test('一般店家照常學（回歸）：編輯與匯入都要學得起來', () => {
  const db = { learnedCategories: {} };
  learnFromStmtEdit(db, { source: 'stmt', storeKey: '佳音林口文化二路', note: '佳音林口文化二路', category: '交通', subcategory: '停車費' });
  assert.deepEqual(db.learnedCategories['佳音林口文化二路'], { category: '交通', subcategory: '停車費' });
  // 匯入：與內建規則不同才學（佳音 內建＝養育/補習／才藝）
  const db2 = { learnedCategories: {} };
  learnFromImport(db2, '佳音林口文化二路', '佳音林口文化二路', '交通', '停車費');
  assert.equal(db2.learnedCategories['佳音林口文化二路']?.category, '交通');
});

test('學習優先於內建規則：個案覆蓋，不誤傷通則', () => {
  const db = { learnedCategories: { '佳音林口文化二路': { category: '交通', subcategory: '停車費' } } };
  const [parkingLot, cramSchool] = applyLearned(db, [
    { store: '佳音林口文化二路', category: '養育', subcategory: '補習／才藝' },   // 內建規則判的
    { store: '佳音美語內湖', category: '養育', subcategory: '補習／才藝' },       // 沒學過 → 維持內建
  ]);
  assert.equal(parkingLot.category, '交通', '學過的停車場要被覆蓋成交通');
  assert.equal(parkingLot.subcategory, '停車費');
  assert.equal(cramSchool.category, '養育', '沒學過的佳音補習班仍走內建規則、不被誤傷');
});

test('手動記帳不污染學習表（只學帳單來源）', () => {
  const db = { learnedCategories: {} };
  learnFromStmtEdit(db, { source: 'manual', storeKey: '自己打的', note: '自己打的', category: '飲食', subcategory: '' });
  assert.deepEqual(db.learnedCategories, {});
});

test('套用端也擋服務費（自審r2-M2）：舊的服務費學習紀錄不可蓋掉繼承分類', () => {
  const db = { learnedCategories: { '國外交易服務費-700.00': { category: '生活', subcategory: '日用品', name: '舊名' } } };
  const [fee] = applyLearned(db, [{ store: '國外交易服務費-700.00', desc: '國外交易服務費-700.00', category: '工作', subcategory: 'ChatGPT' }]);
  assert.equal(fee.category, '工作', '繼承自前一筆的分類不可被舊學習紀錄蓋掉');
  assert.equal(fee.store, '國外交易服務費-700.00', '顯示名也不可被舊學習紀錄改掉');
});

test('無 storeKey 的舊資料一律不學（Codex#10-8）：note 可被改名、身分不可考', () => {
  const db = { learnedCategories: {} };
  learnFromStmtEdit(db, { source: 'stmt', storeKey: '', note: '手續費', category: '生活', subcategory: '' });
  assert.deepEqual(db.learnedCategories, {}, '退用 note 會把規則掛在錯的 key 上（劫持同名店家）——一律不學');
  const db2 = { learnedCategories: {} };
  learnFromStmtEdit(db2, { source: 'stmt', storeKey: '國外交易服務費-99.00', note: '手續費', category: '生活', subcategory: '' });
  assert.deepEqual(db2.learnedCategories, {}, 'storeKey 是服務費時，改了顯示名也不可學');
});

test('原文級覆蓋（2026-07-18 店名對照表逐列改名）：learned[原文].name 優先於 storeKey 級', () => {
  // 銀行截斷讓兩個分店共用 storeKey（12MINI 案例）：原文級各自取名、互不連動
  const db = { learnedCategories: {
    '測試分店': { name: '粗鑰匙名' },                          // storeKey 級（舊機制）
    '測試分店 (桃X999 Taipei': { name: '測試分店（桃園店）', category: '交通', subcategory: '停車費' }   // 原文級（細，含分類）
  } };
  const [tao, xin] = applyLearned(db, [
    { store: '測試分店', desc: '測試分店 (桃X999 Taipei', category: '飲食', subcategory: '' },
    { store: '測試分店', desc: '測試分店 (新X999 Taipei', category: '飲食', subcategory: '' }
  ]);
  assert.equal(tao.store, '測試分店（桃園店）', '有原文級學習→用原文級（優先於 storeKey 級）');
  assert.equal(tao.category, '交通', '原文級分類也套用（合併卡的分類編輯）');
  assert.equal(tao.subcategory, '停車費');
  assert.equal(xin.store, '粗鑰匙名', '沒有原文級→退回 storeKey 級');
  assert.equal(xin.category, '飲食', '沒有原文級分類→維持原判斷');
});

test('Codex#2｜learnFromImport 不把別名結果重記成共用 storeKey 學習', () => {
  // 樹有「休閒」（原娛樂改名）、別名 娛樂→休閒；categorize(NETFLIX)=娛樂→resolveImport 校正成休閒＝完整自動
  const db = { settings: { expenseTree: { '休閒': ['Netflix及影音串流'], '其他': ['未分類'] }, categoryAliases: { '娛樂': '休閒' } }, learnedCategories: {} };
  learnFromImport(db, 'Netflix', 'NETFLIX', '休閒', 'Netflix及影音串流');
  assert.deepEqual(db.learnedCategories, {}, '別名結果＝完整自動，不該再記成 storeKey 規則（否則移除別名仍被鎖住）');
});

test('Codex#2｜learnFromImport 不把原文級學習升級成共用 storeKey', () => {
  const db = { settings: {}, learnedCategories: { '桃分店原文': { category: '交通', subcategory: '停車費' } } };
  learnFromImport(db, '共用店', '桃分店原文', '交通', '停車費');
  assert.ok(!db.learnedCategories['共用店'], '原文級已涵蓋→不寫共用 storeKey（否則污染同店其他分店）');
});

test('Codex#2｜learnFromImport 對「真的手動改成與自動不同」仍照常學', () => {
  const db = { settings: {}, learnedCategories: {} };
  learnFromImport(db, '星巴克', '星巴克門市X', '娛樂', '');   // 自動＝飲食；使用者選娛樂
  assert.equal(db.learnedCategories['星巴克']?.category, '娛樂', '手動改成與自動不同→照常記 storeKey 學習');
});
