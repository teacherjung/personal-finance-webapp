// Codex r11 修正的回歸考題（實測確認過的真 bug）。隔離：STORE_FILE 指向 os 暫存檔，絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-r11-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const repo = await import('../lib/repo.js');
const { computeLeverage, computeIb, buildSummary } = await import('../lib/derive.js');
const { importRows, applyCategoryToStore, renameStoreDisplay, normalizeBranches } = await import('../lib/services/statement-import.js');
const { learnFromStmtEdit, migrateBrandName, customStoreName } = await import('../lib/services/learning.js');
const { storeKeyOf } = await import('../lib/statement.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

// 每題自備乾淨卡片；交易透過 importRows 或直接種進 db（服務層路徑，不經 CRUD 白名單）。
// ⚠️ 共用一顆累積式 store：卡片 id、店名、learned key 都**不可跨題重用**（前面題留下的狀態會污染後題）。
function seedCard(id) {   // id 必帶且用 r11 前綴——seed.json 本來就有 c1/c2 等卡片 id，撞名會拿到 seed 的卡
  const db = repo.getDb();
  if (!(db.cards || []).some(c => c.id === id)) {
    (db.cards ||= []).push({ id, name: '測試卡', type: 'credit' });
    repo.saveDb(db);
  }
}

// ---- [1] 匯入不信前端：stmtRef 伺服器端重建（去重不可被偽造 ref 繞過）----
test('r11#1｜偽造 stmtRef 被重建成標準格式；同筆消費再匯入會被去重（100 不會變 200）', () => {
  seedCard('r11a');
  const row = { date: '2026-01-10', amount: 100, desc: '測試店家', category: '生活', subcategory: '' };
  const r1 = importRows('r11a', [{ ...row, stmtRef: '偽造|亂寫|x|y', store: '偽造店名（不是真實店名）' }]);
  assert.equal(r1.imported, 1);
  const canonical = 'r11a|2026-01-10|100|測試店家';
  const db = repo.getDb();
  const t = (db.transactions || []).find(x => x.importBatch === r1.batchId);
  assert.equal(t.stmtRef, canonical, '偽造 ref 不入庫，一律以 卡id|日期|金額|原文 重建');
  assert.equal(t.note, '測試店家', '顯示名從 desc 權威重算，偽造的 r.store 不落地');
  // 同一筆消費、標準 ref 再來一次 → 必須被去重擋下
  const r2 = importRows('r11a', [{ ...row, stmtRef: canonical }]);
  assert.equal(r2.imported, 0);
  assert.equal(r2.skipped, 1, '重建後的去重要擋住第二次匯入');
  const total = (repo.getDb().transactions || []).filter(x => x.stmtRef === canonical)
    .reduce((s, x) => s + x.amount, 0);
  assert.equal(total, 100, '金額不可翻倍');
});

test('r11#1｜合法 |#N 序號段保留（同帳單兩杯一樣的咖啡）；重匯整份不多出來', () => {
  seedCard('r11b');
  const base = 'r11b|2026-01-11|55|同店咖啡';
  const rows = [
    { date: '2026-01-11', amount: 55, desc: '同店咖啡', category: '飲食', subcategory: '', stmtRef: base },
    { date: '2026-01-11', amount: 55, desc: '同店咖啡', category: '飲食', subcategory: '', stmtRef: `${base}|#2` },
  ];
  const r1 = importRows('r11b', rows);
  assert.equal(r1.imported, 2, '兩筆真消費都要進（|#2 序號合法保留）');
  const refs = (repo.getDb().transactions || []).filter(t => t.stmtRef && t.stmtRef.startsWith(base)).map(t => t.stmtRef).sort();
  assert.deepEqual(refs, [base, `${base}|#2`]);
  const r2 = importRows('r11b', rows);
  assert.equal(r2.imported, 0, '重匯同一份帳單＝同一組 stmtRef，一筆都不多');
});

test('r11#1｜非法尾段（|#1、|垃圾）剝除重建；壞日期/缺 desc 整列跳過而非 500 毒整批', () => {
  seedCard('r11c');
  const base = 'r11c|2026-01-12|70|尾段測試店';
  const r1 = importRows('r11c', [
    { date: '2026-01-12', amount: 70, desc: '尾段測試店', category: '生活', subcategory: '', stmtRef: `${base}|#1` },
    { date: '2026-13-40', amount: 10, desc: '壞日期店', category: '生活', subcategory: '', stmtRef: 'r11c|2026-13-40|10|壞日期店' },
    { date: '2026-01-12', amount: 20, desc: '', category: '生活', subcategory: '', stmtRef: 'r11c|2026-01-12|20|' },
    { date: '2026-01-12', amount: 30, desc: '好店', category: '生活', subcategory: '', stmtRef: 'r11c|2026-01-12|30|好店' },
  ]);
  assert.equal(r1.imported, 2, '合法兩列進、壞兩列跳過（不可整批 500）');
  assert.equal(r1.skipped, 2);
  const t = (repo.getDb().transactions || []).find(x => x.stmtRef && x.stmtRef.startsWith(base));
  assert.equal(t.stmtRef, base, '|#1 不是合法序號（第一筆從不加段）→ 剝除重建');
});

// ---- [3] 斷頭距離語意：有借款且持股歸零＝0（最危險），不是 100（最安全）----
test('r11#3｜持股歸零只剩欠款：mcDist=0（前後端同口徑），不再回 100', () => {
  const db = { settings: { usdTwd: 32, ib: { lastEquity: { stock: 0, cash: -1000 } } },
    holdings: [], accounts: [], transactions: [], subscriptions: [], insurance: [], snapshots: [] };
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.hasLoan, true);
  assert.equal(lev.mcDist, 0, '已遭平倉/淨值轉負＝比貼線更慘，斷頭距離必須是 0');
  assert.equal(buildSummary(db).ib.mcDist, 0, '/api/summary 也要輸出 0');
});

test('r11#3｜自算路徑（無官方淨值、只有 ibCashCur 負餘額）同樣 mcDist=0', () => {
  const db = { settings: { usdTwd: 32 }, holdings: [],
    accounts: [{ id: 'a1', name: 'IB USD', type: 'cash', currency: 'USD', balance: -100, ibCashCur: 'USD' }] };
  const lev = computeLeverage(db, computeIb(db));
  assert.equal(lev.hasLoan, true);
  assert.equal(lev.mcDist, 0);
});

test('r11#3｜回歸：無借款仍是 100；有借款且持股>0 仍走公式', () => {
  const none = computeLeverage({ settings: { usdTwd: 32, ib: { lastEquity: { stock: 100, cash: 50 } } }, holdings: [], accounts: [] },
    computeIb({ settings: {}, holdings: [], accounts: [] }));
  assert.equal(none.mcDist, 100, '無借款＝不存在強平風險，100 專屬這個情境');
  const db = { settings: { usdTwd: 32, ibMaintenancePct: 25, ib: { lastEquity: { stock: 100, cash: -30 } } }, holdings: [], accounts: [] };
  const lev = computeLeverage(db, computeIb(db));
  assert.ok(Math.abs(lev.mcDist - 60) < 1e-9, `公式值 1−30/(0.75×100)=60，實得 ${lev.mcDist}`);
});

// ---- [4] 品牌層舊格式自訂名：搬家到原文級、不是刪除 ----
test('r11#4｜只改分類：品牌層自訂名搬到原文級，顯示名與 customStoreName 都不蒸發', () => {
  const orig = '鮮芋仙（林口）';
  const key = storeKeyOf(orig);
  assert.equal(key, '鮮芋仙', '前提：鑰匙＝品牌層');
  const item = { id: 't1', source: 'stmt', storeKey: key, note: '我的牛排店',
    category: '生活', subcategory: '', stmtRef: `c1|2026-01-02|120|${orig}` };
  const db = { transactions: [item],
    learnedCategories: { [key]: { category: '飲食', subcategory: '餐廳', name: '我的牛排店' } } };
  learnFromStmtEdit(db, item, { ...item, category: '飲食', subcategory: '餐廳' });
  const lc = db.learnedCategories;
  assert.equal(lc[key].name, undefined, '品牌層不留 name（政策不變）');
  assert.equal(lc[orig]?.name, '我的牛排店', '但名字要搬到原文級，不是刪掉');
  assert.equal(item.note, '我的牛排店', '顯示名不可被打回自動名');
  assert.equal(customStoreName(db, orig, key), '我的牛排店', '自訂名仍查得到');
  assert.equal(lc[key].category, '生活', '分類照常學在品牌層');
});

test('r11#4｜無原文可搬（交易缺 stmtRef）：品牌層 name 保留不刪（保留＞流失）', () => {
  const key = '無原文店';
  const item = { id: 't1', source: 'stmt', storeKey: key, note: '手取名', category: '生活', subcategory: '' };
  const db = { transactions: [item], learnedCategories: { [key]: { name: '手取名' } } };
  learnFromStmtEdit(db, item, { ...item, category: '飲食' });
  assert.equal(db.learnedCategories[key].name, '手取名', '無處可搬＝保留（等 normalizeBranches 再搬）');
});

test('r11#4｜平台殘骸名照舊清掉、不搬家（五處同判準）', () => {
  const orig = '優食-某某豆漿店';
  const key = storeKeyOf(orig);
  const e = { name: '優食（UE）' };
  const db = { transactions: [{ source: 'stmt', storeKey: key, stmtRef: `c1|2026-01-03|80|${orig}` }], learnedCategories: {} };
  migrateBrandName(db, key, e);
  assert.equal(e.name, undefined, '殘骸名刪除');
  assert.equal(db.learnedCategories[orig], undefined, '殘骸名不可被當自訂名搬到原文級');
});

test('r11#4｜原文級已有名＝優先不覆蓋，品牌層名照樣視為有著落而清掉', () => {
  const orig = '八方雲集（林口）';
  const key = storeKeyOf(orig);
  const e = { name: '品牌層舊名' };
  const db = { transactions: [{ source: 'stmt', storeKey: key, stmtRef: `c1|2026-01-04|90|${orig}` }],
    learnedCategories: { [orig]: { name: '原文級既有名' } } };
  migrateBrandName(db, key, e);
  assert.equal(db.learnedCategories[orig].name, '原文級既有名', '原文級優先、不覆蓋');
  assert.equal(e.name, undefined, '品牌層名清掉（原文級本就遮蔽它，無資訊流失）');
});

test('r11#4｜同店整批改分類（applyCategoryToStore）同樣搬家不刪除', () => {
  seedCard('r11d');
  const orig = '整批測試店（南崁）';
  const key = storeKeyOf(orig);
  const db = repo.getDb();
  (db.transactions ||= []).push({ id: 'r11t4', date: '2026-01-05', type: 'expense', category: '飲食', subcategory: '',
    amount: 200, account: '測試卡', note: '整批自訂名', storeKey: key,
    stmtRef: `r11d|2026-01-05|200|${orig}`, source: 'stmt' });
  (db.learnedCategories ||= {})[key] = { category: '飲食', subcategory: '', name: '整批自訂名' };
  repo.saveDb(db);
  applyCategoryToStore(key, '生活', '');
  const after = repo.getDb();
  assert.equal(after.learnedCategories[key].name, undefined, '品牌層不留 name');
  assert.equal(after.learnedCategories[orig]?.name, '整批自訂名', '名字搬到原文級');
  assert.equal(customStoreName(after, orig, key), '整批自訂名', '自訂名仍查得到');
});

// ---- 掃描收尾：renameStoreDisplay 憑空原文 404（不再靜默種規則）----
test('r11掃描｜renameStoreDisplay：找不到符合交易 → 404，且不種下隱形規則', () => {
  assert.throws(() => renameStoreDisplay('根本不存在的帳單原文XYZ', '劫持名'),
    (/** @type {any} */ e) => e.status === 404, '要 404 不要 ok:true');
  assert.equal(repo.getDb().learnedCategories?.['根本不存在的帳單原文XYZ'], undefined, '學習表不可被種入');
});

test('r11掃描｜renameStoreDisplay 回歸：存在的原文照常改、冪等重存（changed=0）不誤擋', () => {
  seedCard('r11e');
  const orig = '改名回歸店';
  const db = repo.getDb();
  (db.transactions ||= []).push({ id: 'r11t5', date: '2026-01-06', type: 'expense', category: '生活', subcategory: '',
    amount: 30, account: '測試卡', note: orig, storeKey: storeKeyOf(orig),
    stmtRef: `r11e|2026-01-06|30|${orig}`, source: 'stmt' });
  repo.saveDb(db);
  const r = renameStoreDisplay(orig, '回歸新名');
  assert.equal(r.ok, true);
  assert.equal(r.changed, 1);
  const again = renameStoreDisplay(orig, '回歸新名');   // 同值重存＝matched>0、changed=0，不可 404
  assert.equal(again.ok, true);
  assert.equal(again.changed, 0);
});

// ---- 對抗審查補洞（同輪抓到的修法缺陷，逐一鎖住）----
test('r11審查｜子集重匯保留序號：db 已有 base，單獨匯 base|#2 → 入庫且 ref 不被重編', () => {
  seedCard('r11f');
  const base = 'r11f|2026-01-20|55|子集咖啡';
  const r1 = importRows('r11f', [{ date: '2026-01-20', amount: 55, desc: '子集咖啡', category: '飲食', subcategory: '', stmtRef: base }]);
  assert.equal(r1.imported, 1);
  // 使用者當初只勾了「第二杯」重匯：序號段必須原樣保留（整批重編會把它變回 base → 被去重吃掉，真消費消失）
  const r2 = importRows('r11f', [{ date: '2026-01-20', amount: 55, desc: '子集咖啡', category: '飲食', subcategory: '', stmtRef: `${base}|#2` }]);
  assert.equal(r2.imported, 1, '只勾第二杯的子集重匯必須成功');
  const refs = (repo.getDb().transactions || []).filter(t => t.stmtRef && t.stmtRef.startsWith(base)).map(t => t.stmtRef).sort();
  assert.deepEqual(refs, [base, `${base}|#2`], '序號段不可被伺服器端重編');
});

test('r11審查｜|#N 上限：|#10 合法保留、|#999999 超上限（>99）剝除重建', () => {
  seedCard('r11g');
  const base = 'r11g|2026-01-21|60|上限測試店';
  const r1 = importRows('r11g', [
    { date: '2026-01-21', amount: 60, desc: '上限測試店', category: '生活', subcategory: '', stmtRef: `${base}|#10` },
    { date: '2026-01-21', amount: 60, desc: '上限測試店', category: '生活', subcategory: '', stmtRef: `${base}|#999999` },
  ]);
  assert.equal(r1.imported, 2);
  const refs = (repo.getDb().transactions || []).filter(t => t.stmtRef && t.stmtRef.startsWith(base)).map(t => t.stmtRef).sort();
  assert.deepEqual(refs, [base, `${base}|#10`], '兩位數序號保留；天文數字序號＝偽造長相 → 重建成 base');
});

test('r11審查｜desc trim：前後補空白的變體收斂到同一指紋，不再重複入帳', () => {
  seedCard('r11h');
  const mk = (d) => ({ date: '2026-01-22', amount: 40, desc: d, category: '飲食', subcategory: '', stmtRef: `r11h|2026-01-22|40|${d}` });
  const r1 = importRows('r11h', [mk('空白測試店')]);
  assert.equal(r1.imported, 1);
  const r2 = importRows('r11h', [mk('空白測試店 '), mk(' 空白測試店 ')]);
  assert.equal(r2.imported, 0, 'trim 後同指紋 → 全部去重');
  assert.equal(r2.skipped, 2);
});

test('r11審查｜desc 含「|」整列拒收（守住「stmtRef 第 4 段起＝原文」不變式）', () => {
  seedCard('r11i');
  const r = importRows('r11i', [{ date: '2026-01-23', amount: 30, desc: '怪店|#2', category: '生活', subcategory: '', stmtRef: 'r11i|2026-01-23|30|怪店|#2' }]);
  assert.equal(r.imported, 0);
  assert.equal(r.skipped, 1, '含分段字元的 desc 不可入庫（會佔用真序號家族位置、毒化原文取回）');
});

test('r11審查｜搬家 fan-out：同品牌兩個分店原文都要掛到名字（不可只搬第一個）', () => {
  const o1 = '探針牛排（桃園）', o2 = '探針牛排（新莊）';
  const key = storeKeyOf(o1);
  assert.equal(storeKeyOf(o2), key, '前提：同一把品牌鑰匙');
  const e = { name: '我的牛排店' };
  const db = { transactions: [
    { source: 'stmt', storeKey: key, stmtRef: `c1|2026-01-24|500|${o1}` },
    { source: 'stmt', storeKey: key, stmtRef: `c1|2026-01-25|600|${o2}` },
  ], learnedCategories: {} };
  migrateBrandName(db, key, e);
  assert.equal(db.learnedCategories[o1]?.name, '我的牛排店');
  assert.equal(db.learnedCategories[o2]?.name, '我的牛排店', '第二個原文也要掛到');
  assert.equal(e.name, undefined);
});

test('r11審查｜原文＝鑰匙（乾淨品牌名）：learnFromStmtEdit 只改分類，名字不可蒸發', () => {
  const orig = '好味小館';                       // storeKeyOf('好味小館')==='好味小館'：原文無分店裝飾
  const key = storeKeyOf(orig);
  assert.equal(key, orig, '前提：原文＝鑰匙（learned 兩層是同一格）');
  const item = { id: 't1', source: 'stmt', storeKey: key, note: '我的私藏小館',
    category: '生活', subcategory: '', stmtRef: `c1|2026-01-26|350|${orig}` };
  const db = { transactions: [item],
    learnedCategories: { [key]: { category: '飲食', subcategory: '', name: '我的私藏小館' } } };
  learnFromStmtEdit(db, item, { ...item, category: '飲食' });
  assert.equal(db.learnedCategories[key].name, '我的私藏小館', 'entry 本身就是原文級的家：名字留在原地');
  assert.equal(db.learnedCategories[key].category, '生活', '分類照常學');
  assert.equal(item.note, '我的私藏小館', '顯示名不可被打回自動名');
  assert.equal(customStoreName(db, orig, key), '我的私藏小館');
});

test('r11審查｜原文＝鑰匙：applyCategoryToStore 不可把剛學的 entry 自己清掉', () => {
  seedCard('r11j');
  const orig = '自噬測試小館';
  const key = storeKeyOf(orig);
  assert.equal(key, orig);
  const db = repo.getDb();
  (db.transactions ||= []).push({ id: 'r11t6', date: '2026-01-27', type: 'expense', category: '飲食', subcategory: '',
    amount: 260, account: '測試卡', note: '我的自噬小館', storeKey: key,
    stmtRef: `r11j|2026-01-27|260|${orig}`, source: 'stmt' });
  (db.learnedCategories ||= {})[key] = { category: '飲食', subcategory: '', name: '我的自噬小館' };
  repo.saveDb(db);
  applyCategoryToStore(key, '生活', '');
  const after = repo.getDb();
  assert.ok(after.learnedCategories[key], 'entry 不可被整個清空');
  assert.equal(after.learnedCategories[key].category, '生活', '整批改的分類要落地到學習表');
  assert.equal(after.learnedCategories[key].name, '我的自噬小館', '自訂名保留');
});

test('r11審查｜殘骸名不算著落：原文級躺著平台殘骸名時，用真名蓋掉、不可讓真名蒸發', () => {
  const orig = '殘骸豆漿店（林口）';
  const key = storeKeyOf(orig);
  const e = { name: '我取的豆漿店名' };
  const db = { transactions: [{ source: 'stmt', storeKey: key, stmtRef: `c1|2026-01-28|45|${orig}` }],
    learnedCategories: { [orig]: { name: '優食（UE）' } } };   // 舊 bug 產物：殘骸名不遮蔽品牌層
  migrateBrandName(db, key, e);
  assert.equal(db.learnedCategories[orig].name, '我取的豆漿店名', '真名蓋掉殘骸名');
  assert.equal(e.name, undefined);
});

test('r11審查｜normalizeBranches 同語意：品牌層名無著落（交易全缺 stmtRef）＝保留，不無聲蒸發', () => {
  const db = repo.getDb();
  // 品牌層自訂名＋該品牌交易缺 stmtRef（無原文可搬）；另放一筆會觸發變動的交易（確保有寫檔、不是靠「沒變動不寫檔」倖存）
  (db.transactions ||= []).push(
    { id: 'r11t7', date: '2026-01-29', type: 'expense', category: '飲食', subcategory: '', amount: 120,
      account: '測試卡', note: '無著落小館', storeKey: '無著落小館', source: 'stmt' },
    { id: 'r11t8', date: '2026-01-29', type: 'expense', category: '飲食', subcategory: '', amount: 80,
      account: '測試卡', note: '統一超商-觸發', storeKey: '統一超商', stmtRef: 'r11j|2026-01-29|80|統一超商-觸發', source: 'stmt' });
  (db.learnedCategories ||= {})['無著落小館'] = { category: '飲食', subcategory: '', name: '我的無著落名' };
  repo.saveDb(db);
  const r = normalizeBranches(false);
  assert.ok(r.changed >= 1, '前提：這一輪確實有變動寫檔（統一超商-觸發 → 統一超商（觸發））');
  assert.equal(repo.getDb().learnedCategories['無著落小館']?.name, '我的無著落名',
    '無著落的品牌層名要挺過自動整理（以前會被無聲剝掉且不計入任何回報）');
});
