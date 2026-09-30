// 自動整理的「不可逆效果」確認閘門考題（Codex r4#2，高）。
//
// 病根：開 app 自動整理（Claude 出新內建規則後第一次開）會直接套用 normalizeBranches(false)，
// 而整理會**合併學習表**——併鑰匙時兩邊教過的分類只留一個、學過的自訂名被規則改寫，
// 這些**刪掉規則也救不回來**。以前默默套用、還不告訴前端，使用者的心血無聲消失。
// 修法（呼應「平靜日不造噪音，有事才出聲」）：先 dry-run，沒有不可逆效果就照常自動套用（絕大多數
// 規則更新屬此、無感）；一旦會動到學習表就停下來回報 needsConfirmation、**不記指紋**（維持待決）。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-autonorm-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { normalizeIfRulesChanged } = await import('../lib/services/statement-import.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

/** 兩家分店（同品牌）被教成不同分類 ＋ 一條會把它們併成一把鑰匙的規則。storeRulesHash 刻意留空＝「規則像是新的」。 */
function seedConflicting() {
  store.save({ ...store.emptyDb(),
    transactions: [
      { id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 1, note: '鮮芋仙林口店',
        storeKey: '鮮芋仙林口店', source: 'stmt', stmtRef: 'c1|2026-07-01|1|鮮芋仙林口店' },
      { id: 't2', date: '2026-07-02', type: 'expense', category: '娛樂', amount: 1, note: '鮮芋仙新店店',
        storeKey: '鮮芋仙新店店', source: 'stmt', stmtRef: 'c1|2026-07-02|1|鮮芋仙新店店' }],
    learnedCategories: {
      '鮮芋仙林口店': { category: '飲食', subcategory: '零食' },
      '鮮芋仙新店店': { category: '娛樂', subcategory: '電影' } },
    settings: { ...store.emptyDb().settings,
      storeRules: { chains: ['鮮芋仙'], canon: [], brand: [], rename: [], parkExempt: [] } } });
}

test('會動到學習表 → 停下來回報 needsConfirmation，且不套用、不記指紋', async () => {
  seedConflicting();
  const r = await normalizeIfRulesChanged();
  assert.equal(r.ran, false, '不可默默套用');
  assert.equal(r.needsConfirmation, true, '要明確回報需要確認');
  assert.ok((r.learnedConflicts || []).length >= 1, '要把「哪些會被覆蓋」交出來');

  const db = store.load();
  assert.deepEqual(Object.keys(db.learnedCategories || {}).sort(), ['鮮芋仙新店店', '鮮芋仙林口店'].sort(),
    '學習表原封不動——兩家的分類都還在');
  assert.ok(!db.settings?.storeRulesHash, '不可記指紋（維持待決，下次開 app 會再問）');
  assert.ok(!db.settings?.storeNamesLastNormalizedAt, '沒套用＝不可記「上次整理」的時間');
});

test('確認後（force）才真的套用並記指紋', async () => {
  seedConflicting();
  await normalizeIfRulesChanged();                 // 第一次：擋下
  const t0 = Date.now();
  const r = await normalizeIfRulesChanged(true);   // 使用者按了確認
  const t1 = Date.now();
  assert.equal(r.ran, true, 'force 之後照常套用');
  assert.ok(store.load().settings?.storeRulesHash, '這次要記指紋（不會每次開 app 重問）');
  const stamp = store.load().settings?.storeNamesLastNormalizedAt;
  assert.ok(typeof stamp === 'string' && Date.parse(stamp) >= t0 && Date.parse(stamp) <= t1, `真的整理到資料就要記**這一次**的 ISO 時間（實得 ${stamp}）`);
  assert.deepEqual(Object.keys(store.load().learnedCategories || {}), ['鮮芋仙'], '兩家併成一把鑰匙');
});

test('沒有不可逆效果 → 照常自動套用、無需確認（平時無感）', async () => {
  // 只改顯示名的規則（chains 切分店），沒有學習表衝突、沒有自訂名被改
  store.save({ ...store.emptyDb(),
    transactions: [{ id: 't1', date: '2026-07-01', type: 'expense', category: '飲食', amount: 1,
      note: '鮮芋仙林口店', storeKey: '鮮芋仙林口店', source: 'stmt', stmtRef: 'c1|2026-07-01|1|鮮芋仙林口店' }],
    settings: { ...store.emptyDb().settings,
      storeRules: { chains: ['鮮芋仙'], canon: [], brand: [], rename: [], parkExempt: [] } } });
  const r = await normalizeIfRulesChanged();
  assert.equal(r.needsConfirmation, undefined, '沒有不可逆效果就不該打擾使用者');
  assert.equal(r.ran, true, '照常自動套用');
  assert.equal(store.load().transactions?.[0].note, '鮮芋仙（林口店）');
});

test('同一版規則只跑一次（記過指紋就不再問、不再跑）', async () => {
  seedConflicting();
  await normalizeIfRulesChanged(true);             // 套用並記指紋
  const r = await normalizeIfRulesChanged();       // 再開一次 app
  assert.equal(r.ran, false);
  assert.equal(r.needsConfirmation, undefined, '指紋沒變＝這版已處理過，不該再問');
});

test('時鐘倒退（今天比資料庫裡最新的一天還早）：確認後照樣整理，但不記「上次整理」的時間（#653 r4 #1）', async () => {
  seedConflicting();
  const db = store.load();
  store.save({ ...db, dailyValues: [{ date: '2099-01-01', netWorth: 0, assets: 0, liabilities: 0, pfCost: 0, pfValue: 0 }] });
  const r = await normalizeIfRulesChanged(true);
  assert.equal(r.ran, true, '前置條件：確認後照常套用');
  assert.deepEqual(Object.keys(store.load().learnedCategories || {}), ['鮮芋仙'], '前置條件：真的改到了資料');
  assert.ok(!store.load().settings?.storeNamesLastNormalizedAt, '時鐘倒退時不可以記「上次整理」');
});

test('規則換了一版、但沒有任何資料要改 → 記指紋、不記「上次整理」的時間（#653 留言 5905965930「開始記錄」：記的是真的改到資料）', async () => {
  store.save({ ...store.emptyDb(),
    settings: { ...store.emptyDb().settings,
      storeRules: { chains: ['鮮芋仙'], canon: [], brand: [], rename: [], parkExempt: [] } } });
  const r = await normalizeIfRulesChanged();
  assert.equal(r.ran, true, '前置條件：新一版規則照常套用');
  assert.equal(r.changed + r.keyChanged + (r.learnedRemapped || 0) + (r.learnedNamesFixed || 0), 0, '前置條件：沒有任何資料要改');
  assert.ok(store.load().settings?.storeRulesHash, '指紋照記');
  assert.ok(!store.load().settings?.storeNamesLastNormalizedAt, '沒有改到資料＝不記「上次整理」');
});
