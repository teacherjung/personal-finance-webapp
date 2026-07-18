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
const { effectiveTree, sanitizeTree, conform, saveTree, resolveImportCategory } = await import('../lib/services/categories.js');

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

test('Codex#7｜分類名撞 JS 原生屬性（toString/constructor）：不消失、不拋錯', () => {
  const t = sanitizeTree({ 'toString': ['x'], 'constructor': ['y'], '飲食': ['餐廳'] });
  assert.deepEqual(t['toString'], ['x'], 'toString 當分類名要保留');
  assert.deepEqual(t['constructor'], ['y']);
  assert.deepEqual(t['其他'], ['未分類']);
  // conform 對原生屬性名不可呼叫到 Object.prototype 的函式而崩
  assert.deepEqual(conform(t, 'toString', 'x'), ['toString', 'x']);
  const bare = { '飲食': ['餐廳'], '其他': ['未分類'] };
  assert.deepEqual(conform(bare, 'toString', 'x'), ['其他', '未分類'], '不在樹內的原生屬性名→其他/未分類（不拋錯）');
  assert.deepEqual(conform(bare, 'constructor', ''), ['其他', '未分類']);
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

test('別名｜改名內建大類：未來自動分類輸出的舊名 → 對映到新名（使用者定 2026-07）', () => {
  seed();
  const nt = renameKey(effectiveTree(repo.getDb()), '娛樂', '休閒');
  saveTree({ tree: nt, parentRenames: [{ from: '娛樂', to: '休閒' }] });
  // 分類器仍會輸出內建名「娛樂」；resolveImportCategory 要把它變「休閒」
  assert.deepEqual(resolveImportCategory(repo.getDb(), '娛樂', '電影'), ['休閒', '電影']);
  assert.deepEqual(repo.getDb().settings.categoryAliases, { '娛樂': '休閒' }, '別名有存進 settings');
});

test('別名｜刪除大類：不建別名，自動分類的該分類 → 其他/未分類', () => {
  seed();
  const nt = effectiveTree(repo.getDb());
  delete nt['生活'];
  saveTree({ tree: nt });
  assert.deepEqual(resolveImportCategory(repo.getDb(), '生活', '日用品'), ['其他', '未分類']);
  assert.ok(!('生活' in (repo.getDb().settings.categoryAliases || {})), '刪除不建別名');
});

test('別名｜連續改名（娛樂→休閒→放鬆）：舊名鏈式對映到最終名', () => {
  seed();
  let nt = renameKey(effectiveTree(repo.getDb()), '娛樂', '休閒');
  saveTree({ tree: nt, parentRenames: [{ from: '娛樂', to: '休閒' }] });
  nt = renameKey(effectiveTree(repo.getDb()), '休閒', '放鬆');
  saveTree({ tree: nt, parentRenames: [{ from: '休閒', to: '放鬆' }] });
  assert.deepEqual(resolveImportCategory(repo.getDb(), '娛樂', '電影'), ['放鬆', '電影'], '最早的舊名也對映到最終名');
  assert.deepEqual(resolveImportCategory(repo.getDb(), '休閒', '電影'), ['放鬆', '電影']);
});

test('別名｜子類改名：未來自動分類的舊子類 → 新子類', () => {
  seed();
  const nt = effectiveTree(repo.getDb());
  nt['飲食'] = nt['飲食'].map(s => s === '餐廳' ? '正餐' : s);
  saveTree({ tree: nt, subRenames: [{ parent: '飲食', from: '餐廳', to: '正餐' }] });
  assert.deepEqual(resolveImportCategory(repo.getDb(), '飲食', '餐廳'), ['飲食', '正餐']);
});

test('別名｜改名後又用同名新增回舊名：別名自清（不再誤導）', () => {
  seed();
  let nt = renameKey(effectiveTree(repo.getDb()), '娛樂', '休閒');
  saveTree({ tree: nt, parentRenames: [{ from: '娛樂', to: '休閒' }] });
  // 現在把「娛樂」當全新大類加回來（無 rename）→ 「娛樂」是真分類了，別名 key 娛樂 應被修剪掉
  nt = effectiveTree(repo.getDb());
  nt['娛樂'] = ['電影'];
  saveTree({ tree: nt });
  assert.ok(!('娛樂' in (repo.getDb().settings.categoryAliases || {})), '娛樂 已是真分類，別名自清');
  assert.deepEqual(resolveImportCategory(repo.getDb(), '娛樂', '電影'), ['娛樂', '電影']);
});

test('saveTree｜刪光也保底：其他/未分類 永遠存在', () => {
  seed();
  const r = saveTree({ tree: {} });
  assert.deepEqual(r.tree['其他'], ['未分類']);
  // 全部支出交易都落到 其他/未分類；收入不動
  assert.equal(txById('t1').category, '其他');
  assert.equal(txById('t3').category, '薪資');
});
