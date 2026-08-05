// 護欄 G4（2026-07-22）：停車費顯示包裝「停車費（場站）」的**觸發條件認子類身分、不認舊名字面**。
// 病根：applyDisplayLabels 舊版 `ctx.subcategory === '停車費'` 字面比對——使用者把「停車費」子類改名成
// 「停車」後，停車場（嘟嘟房這種名字沒有「停車」二字的）就不再被包，失去「這是停車」的提示（同 transferSub
// 角色問題 Codex r13#4）。修法：呼叫端用 parkingSubName(db) 解析子類**現名**傳進 ctx.parkSub；刪除→null＝不包。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-g4-parking-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { getDb, saveDb } = await import('../lib/repo.js');
const { parkingSubName, saveTree } = await import('../lib/services/categories.js');
const { applyCategoryToStoreDb } = await import('../lib/services/statement-import.js');
const { applyDisplayLabels, storeKeyOf } = await import('../lib/statement.js');
const { EXPENSE_TREE } = await import('../public/modules/categories.js');

after(() => { for (const suf of ['', '.bak', '.pre-categories.bak', '.pre-income-categories.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

/** 設定生效樹（直接寫 settings，模擬某個 rename/delete 後的狀態）。 */
async function setTree(tree, subAliases = {}) {
  const db = await getDb();
  db.settings = { ...db.settings, expenseTree: tree, subAliases, categoryAliases: {} };
  db.transactions = [];
  await saveDb(db);
}

// ---------- parkingSubName：身分解析 ----------
test('parkingSubName：未改名→「停車費」；改名→現名；刪除→null（不拿 fallback 未分類當停車判準）', async () => {
  await setTree({ 交通: ['停車費', '計程車'], 其他: ['未分類'] });
  assert.equal(parkingSubName(await getDb()), '停車費', '未改名＝原名');

  await setTree({ 交通: ['停車', '計程車'], 其他: ['未分類'] }, { 交通: { 停車費: '停車' } });
  assert.equal(parkingSubName(await getDb()), '停車', '改名→現名（subAliases 對映）');

  await setTree({ 交通: ['計程車'], 其他: ['未分類'] });   // 停車費被刪、無別名
  assert.equal(parkingSubName(await getDb()), null, '刪除→null');
});

// ---------- applyDisplayLabels：觸發條件認身分 ----------
test('applyDisplayLabels：改名後的子類現名仍觸發停車包裝；null 不包；未傳 parkSub 退回字面「停車費」', () => {
  // 改名後：子類現名＝停車，parkSub＝停車 → 嘟嘟房（名字沒有「停車」二字）仍被包
  assert.equal(applyDisplayLabels('嘟嘟房', { desc: '嘟嘟房', subcategory: '停車', parkSub: '停車' }), '停車費（嘟嘟房）');
  // 舊 bug 重現：若還用字面比對，subcategory=停車 ≠ 停車費 → 不包（這正是要修的）
  assert.equal(applyDisplayLabels('嘟嘟房', { desc: '嘟嘟房', subcategory: '停車' }), '嘟嘟房', '未傳 parkSub＝字面「停車費」，停車≠停車費故不包（相容舊行為）');
  // 刪除：parkSub=null → 不論子類是什麼都不包（不會把未分類包成停車費）
  assert.equal(applyDisplayLabels('嘟嘟房', { desc: '嘟嘟房', subcategory: '未分類', parkSub: null }), '嘟嘟房', 'parkSub=null 不包');
  // 未改名基準：字面「停車費」照包（相容）
  assert.equal(applyDisplayLabels('嘟嘟房', { desc: '嘟嘟房', subcategory: '停車費', parkSub: '停車費' }), '停車費（嘟嘟房）');
});

// ---------- 端到端：走真的 saveTree 改名 → 同店整批改分類 → 顯示名仍包停車 ----------
test('端到端：saveTree 把「停車費」改名成「停車」後，整批改分類仍把嘟嘟房包成「停車費（嘟嘟房）」', async () => {
  // 用內建樹複製一份、把交通的「停車費」換成「停車」，走真的 saveTree（會建 subAliases）
  const renamed = {};
  for (const [cat, subs] of Object.entries(EXPENSE_TREE)) {
    renamed[cat] = cat === '交通' ? subs.map((s) => (s === '停車費' ? '停車' : s)) : [...subs];
  }
  await saveTree({ tree: renamed, subRenames: [{ parent: '交通', from: '停車費', to: '停車' }] });
  assert.equal(parkingSubName(await getDb()), '停車', 'saveTree 後身分解析到現名');

  // 種一筆停車場帳單交易（嘟嘟房，名字沒有「停車」二字），走同店整批改分類把它歸回停車
  const work = await getDb();   // 帶著 saveTree 存好的 settings（別名/生效樹）
  work.transactions = [{
    id: 'p1', date: '2026-07-11', type: 'expense', category: '其他', subcategory: '未分類', amount: 60,
    note: '嘟嘟房', storeKey: storeKeyOf('嘟嘟房'), source: 'stmt', stmtRef: 'c1|2026-07-11|60|嘟嘟房', ledger: 'card',
  }];
  const r = applyCategoryToStoreDb(work, storeKeyOf('嘟嘟房'), '交通', '停車費');   // 純 worker：改 work、不落檔
  assert.equal(r.changed, 1);
  const t = work.transactions.find((x) => x.id === 'p1');
  assert.equal(t.subcategory, '停車', '分類走別名對映到現名');
  assert.equal(t.note, '停車費（嘟嘟房）', '顯示包裝在改名後仍生效（G4 核心）');
});
