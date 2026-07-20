// 銀行對帳單解析＋餘額更新的考題（三層重構 stage 2）。解析器餵合成 x 座標列（不需真 PDF）；
// 餘額更新測純函式 applyBalancesToDb/previewBalancesForDb（不必合成加密 PDF）。隔離：STORE_FILE 暫存檔。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-bank-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { parseBankSummary, accountSuffix, parseAmount } = await import('../lib/bank-statement.js');
const { applyBalancesToDb, previewBalancesForDb } = await import('../lib/services/bank-import.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

/** 合成一列（依 x 排序的 {x,s} 儲存格）。 @param {[number,string][]} pairs */
const L = (pairs) => pairs.map(([x, s]) => ({ x, s }));

// ---- 小工具 ----
test('accountSuffix：遮罩帳號取末尾數字；parseAmount：去 $ 與千分位', () => {
  assert.equal(accountSuffix('209710****0122'), '0122');
  assert.equal(accountSuffix('88875****162'), '162');
  assert.equal(accountSuffix('沒有帳號'), '');
  assert.equal(parseAmount('$1,615,555'), 1615555);
  assert.equal(parseAmount('$0'), 0);
  assert.equal(parseAmount('Richart'), null);
});

// ---- 概要區解析（合成台新格式）----
test('概要區｜台幣區：末碼＋餘額＋參考日；外幣區：取原幣、幣別由鄰近列帶入', () => {
  const lines = [
    L([[47, '新臺幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[78, '帳號類別'], [163, '帳戶號碼'], [433, '帳戶餘額'], [509, '備註']]),
    L([[50, '新臺幣活存'], [150, '209710****0122'], [473, '$23']]),
    L([[50, '新臺幣活存_母帳戶'], [150, '288810****8791'], [453, '$136,185'], [521, 'Richart']]),
    L([[47, '合計'], [445, '$2,052,207']]),
    L([[47, '外幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[367, 'JPY']]),
    L([[56, '外幣活存'], [108, '88875****162'], [436, '$0'], [491, '$0'], [513, 'Richart']]),
    L([[358, '0.196327']]),
    L([[366, 'USD']]),
    L([[56, '外幣活存'], [108, '88875****162'], [436, '$500'], [491, '$15,900'], [513, 'Richart']]),
    L([[362, '31.855']]),
    L([[47, '合計'], [490, '0']]),
  ];
  const r = parseBankSummary(lines);
  assert.equal(r.referenceDate, '2026-06-30');
  assert.equal(r.accounts.length, 4, '2 台幣 + 2 外幣（幣別各異）');
  assert.deepEqual(r.accounts[0], { suffix: '0122', masked: '209710****0122', balance: 23, currency: 'TWD', label: '新臺幣活存', note: '' });
  assert.equal(r.accounts[1].balance, 136185);
  assert.equal(r.accounts[1].note, 'Richart');
  const jpy = r.accounts.find(a => a.currency === 'JPY');
  const usd = r.accounts.find(a => a.currency === 'USD');
  assert.equal(jpy.balance, 0);
  assert.equal(usd.balance, 500, '外幣取原幣（$500）不是新臺幣（$15,900）——避免 derive 重複換匯');
  assert.equal(usd.suffix, '162');
});

test('概要區｜透支負餘額帳戶（餘額欄留空）略過、不當成 0', () => {
  const lines = [
    L([[47, '新臺幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[50, '新臺幣活存'], [150, '111111****9999']]),          // 透支：無 $ 餘額格
    L([[50, '新臺幣活存'], [150, '222222****8888'], [473, '$100']]),
    L([[47, '合計'], [445, '$100']]),
  ];
  const r = parseBankSummary(lines);
  assert.equal(r.accounts.length, 1, '只收有餘額的那筆');
  assert.equal(r.accounts[0].suffix, '8888');
});

// ---- 餘額更新（純函式）----
const parsed = (referenceDate, accounts) => ({ bank: '台新', referenceDate, accounts });
const acc = (suffix, currency, balance) => ({ suffix, masked: `x****${suffix}`, balance, currency, label: '活存', note: '' });

test('餘額更新｜末碼＋幣別比對既有帳戶就更新、沒有的自動建（type=cash/class=現金、不設 ibCashCur）', () => {
  const db = { accounts: [{ id: 'a1', name: '我的台新', type: 'cash', class: '現金', currency: 'TWD', accountNo: '209710123450122', balance: 5 }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [acc('0122', 'TWD', 23), acc('8791', 'TWD', 136185)]));
  assert.equal(r.updated, 1);
  assert.equal(r.created, 1);
  assert.equal(db.accounts.find(a => a.id === 'a1').balance, 23, '末碼 0122 比對到既有帳戶→更新餘額');
  assert.equal(db.accounts.find(a => a.id === 'a1').balanceAsOf, '2026-06-30');
  const created = db.accounts.find(a => a.accountNo === 'x****8791');
  assert.ok(created && created.type === 'cash' && created.class === '現金' && !created.ibCashCur, '自動建帳戶不設 ibCashCur');
});

test('餘額更新｜較舊帳單不覆蓋（現值參考日 < 既有 balanceAsOf → skip）', () => {
  const db = { accounts: [{ id: 'a1', type: 'cash', currency: 'TWD', accountNo: '****0122', balance: 999, balanceAsOf: '2026-06-30' }] };
  const r = applyBalancesToDb(db, parsed('2026-05-31', [acc('0122', 'TWD', 111)]));
  assert.equal(r.skipped, 1);
  assert.equal(r.updated, 0);
  assert.equal(db.accounts[0].balance, 999, '較舊帳單不可把餘額洗回去');
});

test('餘額更新｜同末碼不同幣別＝不同帳戶（162 JPY vs 162 USD 各自比對/建立）', () => {
  const db = { accounts: [{ id: 'j', type: 'cash', currency: 'JPY', accountNo: '****162', balance: 0 }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [acc('162', 'JPY', 300), acc('162', 'USD', 500)]));
  assert.equal(r.updated, 1, 'JPY 162 更新');
  assert.equal(r.created, 1, 'USD 162 是不同帳戶→新建');
  assert.equal(db.accounts.find(a => a.id === 'j').balance, 300);
});

test('餘額更新｜沒有現值參考日 → 400（不敢亂更新）', () => {
  assert.throws(() => applyBalancesToDb({ accounts: [] }, parsed(null, [acc('0122', 'TWD', 23)])),
    (/** @type {any} */ e) => e.status === 400);
});

test('預覽｜列出 update/create/skip-stale，不改 db', () => {
  const db = { accounts: [
    { id: 'a1', name: '甲', type: 'cash', currency: 'TWD', accountNo: '****0122', balance: 5 },
    { id: 'a2', name: '乙', type: 'cash', currency: 'TWD', accountNo: '****8791', balance: 9, balanceAsOf: '2026-06-30' },
  ] };
  const before = JSON.stringify(db);
  const pv = previewBalancesForDb(db, parsed('2026-05-01', [acc('0122', 'TWD', 23), acc('8791', 'TWD', 100), acc('9999', 'TWD', 7)]));
  assert.equal(pv.rows.find(r => r.suffix === '0122').action, 'update');
  assert.equal(pv.rows.find(r => r.suffix === '8791').action, 'skip-stale', '帳單較舊→標 skip-stale');
  assert.equal(pv.rows.find(r => r.suffix === '9999').action, 'create');
  assert.equal(JSON.stringify(db), before, '預覽不可改 db');
});

// ---- 對抗審查補強：matchAccount 收緊（避免財務資料靜默損毀，生存優先）----
const accM = (masked, currency, balance) => ({ suffix: (masked.match(/\*+(\d+)$/) || [])[1] || '', masked, balance, currency, label: '活存', note: '' });

test('餘額更新｜只比對現金帳戶：末碼相同的負債/保單帳戶不可被覆蓋（負債翻資產＝淨資產算錯）', () => {
  const db = { accounts: [{ id: 'loan', name: '房貸', type: 'mortgage', currency: 'TWD', accountNo: '123450122', balance: -2000000 }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('209710****0122', 'TWD', 23)]));
  assert.equal(db.accounts.find(a => a.id === 'loan').balance, -2000000, '房貸餘額不可被帳單覆蓋');
  assert.equal(r.updated, 0);
  assert.equal(r.created, 1, '改成新建一個現金帳戶');
});

test('餘額更新｜可見前綴防碰撞：末碼同 0122 但前綴不同（209710 vs 288810）＝兩個不同帳戶', () => {
  const db = { accounts: [] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('209710****0122', 'TWD', 100), accM('288810****0122', 'TWD', 200)]));
  assert.equal(r.created, 2, '前綴不同→兩個帳戶，不可合成一個');
  assert.deepEqual(db.accounts.map(a => a.balance).sort((x, y) => x - y), [100, 200]);
});

test('餘額更新｜同批快照比對：兩筆不同前綴不會比對到「本批剛新建的」而互吃', () => {
  // 既有一個完整帳號對到 209710...0122；帳單同時有 209710****0122（→update）與 288810****0122（→create）
  const db = { accounts: [{ id: 'x', type: 'cash', currency: 'TWD', accountNo: '20971000000122', balance: 5 }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('209710****0122', 'TWD', 100), accM('288810****0122', 'TWD', 200)]));
  assert.equal(r.updated, 1);
  assert.equal(r.created, 1);
  assert.equal(db.accounts.find(a => a.id === 'x').balance, 100);
});

test('餘額更新｜同批完全重複的遮罩列去重（不會建兩個）', () => {
  const db = { accounts: [] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('209710****0122', 'TWD', 100), accM('209710****0122', 'TWD', 100)]));
  assert.equal(r.created, 1, '同遮罩同幣別＝同一戶，去重');
});

test('餘額更新｜不支援幣別 graceful skip，不擋整張帳單（有效的照更新）', () => {
  const db = { accounts: [] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('111111****0122', 'TWD', 23), accM('222222****0999', 'EUR', 9999)]));
  assert.equal(r.created, 1, 'TWD 照建');
  assert.equal(r.unsupported, 1, 'EUR 略過、不 throw');
  assert.ok(!db.accounts.some(a => a.currency === 'EUR'));
});

test('餘額更新｜壞的現值參考日（2026/13/45）→ 400，不寫進 balanceAsOf 撞櫃檯 500', () => {
  assert.throws(() => applyBalancesToDb({ accounts: [] }, parsed('2026-13-45', [accM('x****0122', 'TWD', 23)])),
    (/** @type {any} */ e) => e.status === 400);
});

test('餘額更新｜現值參考日「相等」也不覆蓋（保住兩次匯入間的手動修正）', () => {
  const db = { accounts: [{ id: 'a', type: 'cash', currency: 'TWD', accountNo: '209710****0122', balance: 88888, balanceAsOf: '2026-06-30' }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('209710****0122', 'TWD', 23)]));
  assert.equal(r.skipped, 1);
  assert.equal(db.accounts[0].balance, 88888, '同一天再匯不覆蓋手改值');
});

test('預覽｜讀不到參考日→blocked，動作標 blocked（與 apply 會 400 一致）', () => {
  const pv = previewBalancesForDb({ accounts: [] }, parsed(null, [accM('x****0122', 'TWD', 23)]));
  assert.equal(pv.blocked, true);
  assert.equal(pv.rows[0].action, 'blocked');
});
