// 設定頁店家表：四欄排序＋分類儲存格（使用者定 2026-07-26）。
// 這幾件事會出錯的方式很固定：①降冪把「同值時的第二鍵」也反轉（同值列整組倒過來＝看起來像資料在跳）
// ②中文用預設 localeCompare（變成 Unicode 碼位序，跟使用者預期的筆畫序不同）③分類欄兩層擠成一行。
// ⚠️ 預期值＝**zh-Hant 筆畫序**，不是碼位序也不是注音序：本檔的順序都以真實 collation 實測後寫死
//（例：子類「油錢」排在「停車費」前面，碼位序剛好相反——這正是不可退回預設 localeCompare 的證據）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortStoreRows, storeCatCell, STORE_SORT_DEFAULT } from '../public/modules/settings-store-table.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
/** 三家店（真實會出現的形狀：加油站聚合鑰匙、超商分店、停車場） */
const ROWS = [
  { orig: '中油-泰山站(D2158)', key: '加油站', cur: '泰山加油站', cat: '交通', sub: '油錢' },
  { orig: '統一超商-百福A2716', key: '統一超商', cur: '統一超商（百福）', cat: '飲食', sub: '超市' },
  { orig: '嘟嘟房-林口站', key: '嘟嘟房', cur: '嘟嘟房（林口）', cat: '交通', sub: '停車費' },
];
const pick = (rows, f) => rows.map(f);

test('預設＝顯示名 A→Z（沿用加排序鈕之前的行為，使用者的肌肉記憶不變）', () => {
  assert.deepEqual(STORE_SORT_DEFAULT, { key: 'cur', dir: 'asc' });
  assert.deepEqual(pick(sortStoreRows(ROWS, STORE_SORT_DEFAULT), r => r.cur),
    ['泰山加油站', '統一超商（百福）', '嘟嘟房（林口）']);
});

test('四欄各自排序：帳單原文／身分鑰匙／顯示名／分類（各欄結果彼此不同＝四個鍵真的都有作用）', () => {
  assert.deepEqual(pick(sortStoreRows(ROWS, { key: 'orig', dir: 'asc' }), r => r.orig),
    ['中油-泰山站(D2158)', '統一超商-百福A2716', '嘟嘟房-林口站']);
  assert.deepEqual(pick(sortStoreRows(ROWS, { key: 'key', dir: 'asc' }), r => r.key),
    ['加油站', '統一超商', '嘟嘟房']);
  assert.deepEqual(pick(sortStoreRows(ROWS, { key: 'cur', dir: 'asc' }), r => r.cur),
    ['泰山加油站', '統一超商（百福）', '嘟嘟房（林口）']);
  // 分類欄：大類優先，同大類再比子類（畫面上這一格顯示的就是「大類＋子類」兩行）
  assert.deepEqual(pick(sortStoreRows(ROWS, { key: 'cat', dir: 'asc' }), r => `${r.cat}/${r.sub}`),
    ['交通/油錢', '交通/停車費', '飲食/超市']);
});

test('降冪＝整欄反過來（含分類欄的子類）', () => {
  assert.deepEqual(pick(sortStoreRows(ROWS, { key: 'key', dir: 'desc' }), r => r.key), ['嘟嘟房', '統一超商', '加油站']);
  assert.deepEqual(pick(sortStoreRows(ROWS, { key: 'cat', dir: 'desc' }), r => `${r.cat}/${r.sub}`),
    ['飲食/超市', '交通/停車費', '交通/油錢']);
});

test('同值時的第二鍵（顯示名 A→Z）固定不跟著反轉——否則同值列在降冪時整組倒過來', () => {
  const same = [   // 分類與子類全同 → 主鍵比不出高下，只剩第二鍵
    { orig: 'o3', key: 'k', cur: '泰山加油站', cat: '交通', sub: '油錢' },
    { orig: 'o1', key: 'k', cur: '嘟嘟房（林口）', cat: '交通', sub: '油錢' },
    { orig: 'o2', key: 'k', cur: '統一超商（百福）', cat: '交通', sub: '油錢' },
  ];
  const expected = ['泰山加油站', '統一超商（百福）', '嘟嘟房（林口）'];
  assert.deepEqual(pick(sortStoreRows(same, { key: 'cat', dir: 'asc' }), r => r.cur), expected);
  assert.deepEqual(pick(sortStoreRows(same, { key: 'cat', dir: 'desc' }), r => r.cur), expected, '降冪不可讓同值列倒序');
});

test('中文用 zh-Hant 比較，不是 Unicode 碼位序', () => {
  const rows = [{ cur: 'a', cat: '交通', sub: '停車費' }, { cur: 'b', cat: '交通', sub: '油錢' }];
  // 碼位序：停(U+505C) < 油(U+6CB9) → 會是「停車費」在前；zh-Hant 筆畫序則是「油錢」在前
  assert.deepEqual(pick(sortStoreRows(rows, { key: 'cat', dir: 'asc' }), r => r.sub), ['油錢', '停車費']);
  assert.deepEqual(['停車費', '油錢'].slice().sort(), ['停車費', '油錢'], '（對照）預設排序＝碼位序，與上面相反');
});

test('不動原陣列；未知或原型鍵退回顯示名', () => {
  const rows = ROWS.slice();
  const before = pick(rows, r => r.cur);
  sortStoreRows(rows, { key: 'cat', dir: 'desc' });
  assert.deepEqual(pick(rows, r => r.cur), before, '排序回傳新陣列，呼叫端資料不可被就地改動');
  const byCur = ['泰山加油站', '統一超商（百福）', '嘟嘟房（林口）'];
  assert.deepEqual(pick(sortStoreRows(ROWS, { key: '__proto__', dir: 'asc' }), r => r.cur), byCur, '原型鍵不可當比較器');
  assert.deepEqual(pick(sortStoreRows(ROWS, { key: '亂填', dir: 'asc' }), r => r.cur), byCur);
  assert.deepEqual(sortStoreRows(null, STORE_SORT_DEFAULT), []);
});

test('分類儲存格：大分類第一行、子分類第二行、沒有「·」', () => {
  const html = storeCatCell({ cat: '交通', sub: '油錢' }, esc);
  assert.match(html, /^交通<div class="muted"[^>]*>油錢<\/div>$/, '兩行＝第二行包在自己的 div 裡');
  assert.ok(!html.includes('·'), '中間點已移除（使用者定 2026-07-26）');
  assert.equal(storeCatCell({ cat: '其他', sub: '' }, esc), '其他', '沒有子分類就只有一行');
  assert.equal(storeCatCell({}, esc), '');
  // 逃脫：分類名可被使用者自訂，角括號不可變成標籤
  assert.equal(storeCatCell({ cat: '<b>x</b>', sub: '<i>y</i>' }, esc),
    '&lt;b&gt;x&lt;/b&gt;<div class="muted" style="font-size:12px">&lt;i&gt;y&lt;/i&gt;</div>');
});
