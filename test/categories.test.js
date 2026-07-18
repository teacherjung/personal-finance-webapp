// 自訂支出分類（大類＋子類）的考題：純函式（sanitizeTree/conform）＋儲存連動更新（saveTree）。
// 隔離：STORE_FILE 指向 os 暫存檔，絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-cats-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const repo = await import('../lib/repo.js');
const { effectiveTree, sanitizeTree, conform, saveTree } = await import('../lib/services/categories.js');

after(() => { for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

// 每個測試前重置：一組已知交易＋學習表
function seed() {
  const db = repo.emptyDb();
  db.transactions = [
    { id: 't1', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 100 },
    { id: 't2', type: 'expense', category: '娛樂', subcategory: '電影', amount: 200 },
    { id: 't3', type: 'income', category: '薪資', subcategory: '', amount: 50000 },
    { id: 't4', type: 'expense', category: '飲食', subcategory: '超市', amount: 80 },
    { id: 't5', type: 'expense', category: '生活', subcategory: '日用品', amount: 60 }
  ];
  db.learnedCategories = { '星巴克': { category: '娛樂', subcategory: '電影' } };
  delete db.settings.expenseTree;
  repo.saveDb(db);
}
const txById = (id) => repo.getDb().transactions.find(t => t.id === id);
// 從目前生效樹改名一個大類的 key（其餘照舊），回傳新樹
const renameKey = (tree, from, to) => { const nt = {}; for (const k of Object.keys(tree)) nt[k === from ? to : k] = tree[k]; return nt; };

test('sanitizeTree：清掉壞 key/value、去重、強制保留 其他/未分類', () => {
  const t = sanitizeTree({ '飲食': ['餐廳', '餐廳', '', '超市'], '': ['x'], '壞': 'notarray' });
  assert.deepEqual(t['飲食'], ['餐廳', '超市']);   // 去重＋濾空
  assert.ok(!('' in t), '空大類名被丟');
  assert.ok(!('壞' in t), 'value 非陣列被丟');
  assert.deepEqual(t['其他'], ['未分類'], '一定含 其他/未分類');
});

test('conform：不在樹內→其他/未分類；子類不合→清空；合法→原樣', () => {
  const tree = { '飲食': ['餐廳', '超市'], '其他': ['未分類'] };
  assert.deepEqual(conform(tree, '飲食', '餐廳'), ['飲食', '餐廳']);
  assert.deepEqual(conform(tree, '飲食', '不存在的子類'), ['飲食', '']);
  assert.deepEqual(conform(tree, '已刪的大類', 'x'), ['其他', '未分類']);
  assert.deepEqual(conform(tree, '飲食', ''), ['飲食', ''], '空子類（不分子類）合法');
});

test('effectiveTree：沒設定時回內建預設（含 其他/未分類）', () => {
  seed();
  const t = effectiveTree(repo.getDb());
  assert.ok(t['飲食'] && t['娛樂'] && t['其他'].includes('未分類'));
});

test('saveTree｜大類改名：舊交易與學習表一併更新，收入不動', () => {
  seed();
  const nt = renameKey(effectiveTree(repo.getDb()), '娛樂', '休閒');
  const r = saveTree({ tree: nt, parentRenames: [{ from: '娛樂', to: '休閒' }] });
  assert.equal(txById('t2').category, '休閒');
  assert.equal(txById('t2').subcategory, '電影', '子類保留（電影仍在休閒底下）');
  assert.equal(txById('t1').category, '飲食', '沒改到的不動');
  assert.equal(txById('t3').category, '薪資', '收入分類不受影響');
  assert.equal(repo.getDb().learnedCategories['星巴克'].category, '休閒', '學習表一併改名');
  assert.ok(r.changedTx >= 1 && r.changedLearned >= 1);
  assert.ok('休閒' in effectiveTree(repo.getDb()), '新樹已存進 settings');
});

test('saveTree｜刪大類：該分類的交易改歸 其他/未分類', () => {
  seed();
  const nt = effectiveTree(repo.getDb());
  delete nt['生活'];
  saveTree({ tree: nt });
  assert.equal(txById('t5').category, '其他');
  assert.equal(txById('t5').subcategory, '未分類');
  assert.equal(txById('t1').category, '飲食', '其他分類不動');
});

test('saveTree｜子類改名：對應交易的子類更新', () => {
  seed();
  const nt = effectiveTree(repo.getDb());
  nt['飲食'] = nt['飲食'].map(s => s === '餐廳' ? '正餐' : s);
  saveTree({ tree: nt, subRenames: [{ parent: '飲食', from: '餐廳', to: '正餐' }] });
  assert.equal(txById('t1').subcategory, '正餐');
  assert.equal(txById('t1').category, '飲食');
});

test('saveTree｜刪子類：交易子類清空（不分子類），大類不變', () => {
  seed();
  const nt = effectiveTree(repo.getDb());
  nt['飲食'] = nt['飲食'].filter(s => s !== '超市');
  saveTree({ tree: nt });
  assert.equal(txById('t4').category, '飲食');
  assert.equal(txById('t4').subcategory, '', '被刪的子類→不分子類');
});

test('saveTree｜刪光也保底：其他/未分類 永遠存在', () => {
  seed();
  const r = saveTree({ tree: {} });
  assert.deepEqual(r.tree['其他'], ['未分類']);
  // 全部支出交易都落到 其他/未分類；收入不動
  assert.equal(txById('t1').category, '其他');
  assert.equal(txById('t3').category, '薪資');
});
