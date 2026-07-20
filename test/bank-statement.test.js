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

/** 合成一列（{y,cells}；概要解析不看 y，統一給 0）。 @param {[number,string][]} pairs */
const L = (pairs) => ({ y: 0, cells: pairs.map(([x, s]) => ({ x, s })) });

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

// ---- stage 3：明細解析＋分箱 ----
const { parseBankDetail } = await import('../lib/bank-statement.js');
const { classifyBankTx, previewBankTxForDb, importBankTxToDb } = await import('../lib/services/bank-import.js');

/** 合成明細列 {y, cells}。 */
const D = (y, pairs) => ({ y, cells: pairs.map(([x, s]) => ({ x, s })) });

test('明細｜方向靠 x 分欄（支出/存入）＋換行備註靠 y 歸位', () => {
  const lines = [
    D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    D(100, [[53, '209710****0122'], [124, '2026/06/11'], [177, '轉帳存入'], [349, '$36,669'], [418, '$36,669 轉出288810****8791']]),   // 存入（x349 在存入欄）
    D(83, [[53, '209710****0122'], [124, '2026/06/16'], [177, '媒體轉出'], [289, '$16,333'], [418, '$20,336 房屋貸款']]),              // 支出（x289 在支出欄）
    D(66, [[53, '288810****8791'], [124, '2026/06/02'], [180, 'CD轉入'], [349, '$24,600'], [414, '$413,829']]),
    D(50, [[450, 'ATM 806 William鐘點']]),   // 換行備註（高 x、無帳號）→ 最近列 y66
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs.length, 3);
  assert.equal(txs[0].direction, 'in');
  assert.equal(txs[0].amount, 36669);
  assert.equal(txs[0].note, '轉出288810****8791');
  assert.equal(txs[1].direction, 'out');
  assert.equal(txs[1].note, '房屋貸款');
  assert.equal(txs[2].note, 'ATM 806 William鐘點', '換行備註歸到 CD轉入 那列');
});

const btx = (o) => ({ acctSuffix: '8791', date: '2026-06-01', summary: '', direction: 'out', amount: 100, balance: 0, note: '', ...o });

test('分箱｜劃撥（證券交割，備註不在摘要）→ 內轉，不計入收支（真實資料曾誤判成收入）', () => {
  const c = classifyBankTx(btx({ summary: '轉帳存入', direction: 'in', note: '劃撥轉帳元大台灣50' }), new Set());
  assert.equal(c.type, 'transfer');
  assert.equal(c.category, '內轉');
});

test('分箱｜備註含自己帳號末碼 → 內轉；不含 → 照收支', () => {
  const own = new Set(['8791', '0122']);
  assert.equal(classifyBankTx(btx({ note: '轉入209710****0122' }), own).type, 'transfer', '對到自己帳號→內轉');
  assert.equal(classifyBankTx(btx({ summary: '轉帳支取', note: '轉入288810****3047養育費' }), own).type, 'expense', '3047非自己帳號→真支出');
});

test('分箱｜繳卡費→支出不分類（卡明細已分）；領現金→生活/其他生活雜支；手續費/房貸/養育/利息/配息各就位', () => {
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '媒體轉帳', note: '台新卡費榮祥森' }), new Set())), ['expense', '', '']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: 'CD提款', note: 'ATM/跨行交易' }), new Set())), ['expense', '生活', '其他生活雜支']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '跨轉手續費' }), new Set())), ['expense', '其他', '手續費']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '媒體轉出', note: '房屋貸款富邦人壽' }), new Set())), ['expense', '居住', '房貸']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '轉帳支取', note: '轉入288810****3047養育費' }), new Set())), ['expense', '養育', '贍養費']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '存款息', direction: 'in' }), new Set())), ['income', '被動', '利息']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '媒體轉入', direction: 'in', note: '基金配息群益' }), new Set())), ['income', '被動', '股息']);
});

test('分箱｜其餘：存入→收入其他、支出→支出其他（留給使用者在收支頁改）', () => {
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '轉帳存入', direction: 'in', note: '不明來源' }), new Set())), ['income', '其他', '其他收入']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: 'CD轉出', direction: 'out', note: '數位跨行' }), new Set())), ['expense', '其他', '未分類']);
});

function pick(c) { return [c.type, c.category, c.subcategory]; }

test('匯入｜寫進現金流帳本（ledger:cashflow、source:bank）；bankRef 去重；重匯 0 筆', () => {
  const db = { accounts: [], transactions: [] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [{ suffix: '8791', masked: '288810****8791' }],
    transactions: [btx({ summary: '存款息', direction: 'in', amount: 23, balance: 23 }), btx({ summary: 'CD提款', amount: 20000, balance: 100 })] };
  const r1 = importBankTxToDb(db, parsed);
  assert.equal(r1.imported, 2);
  const t = db.transactions[0];
  assert.equal(t.ledger, 'cashflow');
  assert.equal(t.source, 'bank');
  assert.ok(t.bankRef);
  const r2 = importBankTxToDb(db, parsed);
  assert.equal(r2.imported, 0, '重匯全去重');
  assert.equal(r2.skipped, 2);
});

test('預覽交易｜統計 income/expense/transfer＋重複標記（已匯入的標 duplicate）', () => {
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [{ suffix: '8791', masked: '288810****8791' }],
    transactions: [btx({ summary: '存款息', direction: 'in', amount: 23, balance: 23 }), btx({ summary: 'CD提款', amount: 20000, balance: 100 })] };
  // 先把第一筆的 bankRef 種進 db（模擬已匯過）
  const db0 = { accounts: [], transactions: [] };
  importBankTxToDb(db0, { ...parsed, transactions: [parsed.transactions[0]] });
  const pv = previewBankTxForDb(db0, parsed);
  assert.equal(pv.counts.duplicate, 1, '已匯過的存款息標 duplicate');
  assert.equal(pv.counts.expense, 1, 'CD提款算支出');
  assert.ok(pv.rows.find(r => r.summary === '存款息').duplicate);
});

// ---- stage 3 對抗審查補強 ----
test('明細｜方向以 running 餘額為權威：小額右對齊被 x 判反，餘額差校正回來', () => {
  // 同帳戶三列，餘額遞減＝連續支出；第 2、3 列小額手續費即使 x 落在存入側，也靠餘額差判成 out
  const lines = [
    D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [222, '支票號碼'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    D(100, [[53, '288810****8791'], [124, '2026/06/24'], [177, 'CD轉出'], [289, '$15,000'], [414, '$172,748']]),
    D(83, [[53, '288810****8791'], [124, '2026/06/24'], [177, '跨轉手續費'], [325, '$15'], [414, '$172,733']]),   // $15 x325 落存入側，但餘額 -15 → out
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs[1].direction, 'out', '餘額 172748→172733 差 -15 → 支出（不被 x 幾何判反）');
  assert.equal(txs[1].amount, 15);
});

test('明細｜表頭逐字拆/讀不到欄位 → 丟可見錯誤，不靜默歸零（無聲總損）', () => {
  const lines = [
    D(120, [[75, '帳'], [80, '號'], [272, '支'], [278, '出'], [284, '金'], [290, '額'], [331, '存'], [337, '入'], [343, '金'], [349, '額'], [396, '帳'], [402, '戶'], [408, '餘'], [414, '額']]),
    D(100, [[53, '288810****8791'], [124, '2026/06/24'], [177, 'CD轉出'], [289, '$15,000'], [414, '$172,748']]),
  ];
  assert.throws(() => parseBankDetail(lines), (/** @type {any} */ e) => e.status === 400, '表頭抓不到欄位 x → 400，不回 [] 靜默漏光');
});

test('明細｜摘要區的序號數字不被誤當交易金額（txnCell 下界）', () => {
  const lines = [
    D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [222, '支票號碼'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    D(100, [[53, '288810****8791'], [124, '2026/06/24'], [177, '轉帳存入'], [205, '12345'], [349, '$8,000'], [414, '$100,000']]),   // 摘要區 12345@x205 不可當金額
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs[0].amount, 8000, '真金額 8000，不是摘要序號 12345');
  assert.equal(txs[0].direction, 'in');
});

test('分箱｜方向護欄：出方向的「透支利息/電子發票工本費」是支出，不被翻成收入（生存優先）', () => {
  assert.equal(classifyBankTx(btx({ summary: '透支利息', direction: 'out', amount: 3000 }), new Set()).type, 'expense', '利息扣款(out)＝支出');
  assert.equal(classifyBankTx(btx({ summary: '轉帳支取', direction: 'out', note: '電子發票工本費' }), new Set()).type, 'expense', '發票工本費(out)＝支出、不判中獎');
  // in 方向的存款息/中獎才是收入
  assert.equal(classifyBankTx(btx({ summary: '存款息', direction: 'in' }), new Set()).type, 'income');
  assert.equal(classifyBankTx(btx({ summary: '媒體轉帳', direction: 'in', note: '中獎發票' }), new Set()).category, '被動');
});

test('分箱｜ownSuffixSet 只認現金帳戶＋4碼：登記的房貸帳戶繳款仍算支出、末3碼不誤中', () => {
  const db = { accounts: [
    { id: 'm', type: 'mortgage', currency: 'TWD', accountNo: '111222****5678' },   // 房貸帳戶（非現金）
    { id: 'c', type: 'cash', currency: 'TWD', accountNo: '00100200789' },           // 現金帳戶，末3碼 789
  ] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [] };
  const own = (previewBankTxForDb(db, { ...parsed, transactions: [
    btx({ summary: '媒體轉出', direction: 'out', note: '房屋貸款繳款111222****5678' }),   // 房貸帳戶末碼→不算內轉
    btx({ summary: '轉帳存入', direction: 'in', amount: 500000, note: '收款自812****789王小明' }),   // 末3碼789 不誤中
  ] }));
  assert.equal(own.rows[0].type, 'expense', '登記的房貸帳戶（非現金）繳款仍算支出、不被當內轉');
  assert.equal(own.rows[0].category, '居住');
  assert.equal(own.rows[1].type, 'income', '第三方末3碼撞到現金帳戶末3碼→不誤判內轉（只比4碼）');
});

test('匯入｜bankRef 含 note：餘額讀不到(null)時，同日同額不同備註的兩筆不被誤去重', () => {
  const db = { accounts: [], transactions: [] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: '跨行轉出', amount: 1000, balance: null, note: '付給A' }),
    btx({ summary: '跨行轉出', amount: 1000, balance: null, note: '付給B' }),
  ] };
  const r = importBankTxToDb(db, parsed);
  assert.equal(r.imported, 2, '不同備註＝不同交易，不可去重掉');
});
