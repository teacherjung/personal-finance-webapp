// 銀行對帳單解析＋餘額更新的考題（三層重構 stage 2）。解析器餵合成 x 座標列（不需真 PDF）；
// 餘額更新測純函式 applyBalancesToDb/previewBalancesForDb（不必合成加密 PDF）。隔離：STORE_FILE 暫存檔。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-bank-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { parseBankSummary, accountSuffix, parseAmount, UNKNOWN_CURRENCY } = await import('../lib/bank-statement.js');
const { CURRENCIES } = await import('../lib/schema.js');
const { applyBalancesToDb, previewBalancesForDb } = await import('../lib/services/bank-import.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

/** 合成一列（{y,cells}；概要解析不看 y，統一給 0）。 @param {[number,string][]} pairs */
const L = (pairs) => ({ y: 0, cells: pairs.map(([x, s]) => ({ x, s })) });

// ---- 小工具 ----
test('accountSuffix：遮罩帳號取末尾數字；parseAmount：去 $ 與千分位', () => {
  assert.equal(accountSuffix('900100****3301'), '3301');
  assert.equal(accountSuffix('900300****363'), '363');
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
    L([[50, '新臺幣活存'], [150, '900100****3301'], [473, '$23']]),
    L([[50, '新臺幣活存_母帳戶'], [150, '900200****3302'], [453, '$136,185'], [521, 'Richart']]),
    L([[47, '合計'], [445, '$2,052,207']]),
    L([[47, '外幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[367, 'JPY']]),
    L([[56, '外幣活存'], [108, '900300****363'], [436, '$0'], [491, '$0'], [513, 'Richart']]),
    L([[358, '0.196327']]),
    L([[366, 'USD']]),
    L([[56, '外幣活存'], [108, '900300****363'], [436, '$500'], [491, '$15,900'], [513, 'Richart']]),
    L([[362, '31.855']]),
    L([[47, '合計'], [490, '0']]),
  ];
  const r = parseBankSummary(lines);
  assert.equal(r.referenceDate, '2026-06-30');
  assert.equal(r.accounts.length, 4, '2 台幣 + 2 外幣（幣別各異）');
  assert.deepEqual(r.accounts[0], { suffix: '3301', masked: '900100****3301', balance: 23, currency: 'TWD', label: '新臺幣活存', note: '' });
  assert.equal(r.accounts[1].balance, 136185);
  assert.equal(r.accounts[1].note, 'Richart');
  const jpy = r.accounts.find(a => a.currency === 'JPY');
  const usd = r.accounts.find(a => a.currency === 'USD');
  assert.equal(jpy.balance, 0);
  assert.equal(usd.balance, 500, '外幣取原幣（$500）不是新臺幣（$15,900）——避免 derive 重複換匯');
  assert.equal(usd.suffix, '363');
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
  const db = { accounts: [{ id: 'a1', name: '我的台新', type: 'cash', class: '現金', currency: 'TWD', accountNo: '900100123453301', balance: 5 }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [acc('3301', 'TWD', 23), acc('3302', 'TWD', 136185)]));
  assert.equal(r.updated, 1);
  assert.equal(r.created, 1);
  assert.equal(db.accounts.find(a => a.id === 'a1').balance, 23, '末碼 3301 比對到既有帳戶→更新餘額');
  assert.equal(db.accounts.find(a => a.id === 'a1').balanceAsOf, '2026-06-30');
  const created = db.accounts.find(a => a.accountNo === 'x****3302');
  assert.ok(created && created.type === 'cash' && created.class === '現金' && !created.ibCashCur, '自動建帳戶不設 ibCashCur');
});

test('餘額更新｜較舊帳單不覆蓋（現值參考日 < 既有 balanceAsOf → skip）', () => {
  const db = { accounts: [{ id: 'a1', type: 'cash', currency: 'TWD', accountNo: '****3301', balance: 999, balanceAsOf: '2026-06-30' }] };
  const r = applyBalancesToDb(db, parsed('2026-05-31', [acc('3301', 'TWD', 111)]));
  assert.equal(r.skipped, 1);
  assert.equal(r.updated, 0);
  assert.equal(db.accounts[0].balance, 999, '較舊帳單不可把餘額洗回去');
});

test('餘額更新｜同末碼不同幣別＝不同帳戶（363 JPY vs 363 USD 各自比對/建立）', () => {
  const db = { accounts: [{ id: 'j', type: 'cash', currency: 'JPY', accountNo: '****363', balance: 0 }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [acc('363', 'JPY', 300), acc('363', 'USD', 500)]));
  assert.equal(r.updated, 1, 'JPY 363 更新');
  assert.equal(r.created, 1, 'USD 363 是不同帳戶→新建');
  assert.equal(db.accounts.find(a => a.id === 'j').balance, 300);
});

test('餘額更新｜沒有現值參考日 → **餘額不動、但不再整份退回**（William 2026-08-13）', () => {
  // ⚠️ 舊行為是丟 400、整份匯不進去。但交易明細**根本用不到**這個日期——只有「這份帳單的餘額
  //    比 app 裡的新嗎」才需要。因為一個欄位讀不到就把整批交易也擋掉，是連坐。
  //    ⚠️ 保守的部分一點都沒放寬：**不知道新舊就絕不覆蓋餘額**（拿舊的蓋掉新的＝無聲毀資料）。
  const db = { accounts: [{ id: 'a1', name: '台新活存', type: 'bank', currency: 'TWD', balance: 111, accountNo: '900100****3301', balanceAsOf: '2026-05-31' }], transactions: [] };
  const parsed = { bank: '台新', referenceDate: null,
    accounts: [{ suffix: '3301', masked: '900100****3301', balance: 999, currency: 'TWD', label: '活存', note: '' }],
    transactions: [] };
  const r = applyBalancesToDb(db, parsed);
  assert.equal(r.balancesSkipped, true, '★要明確回報「這次沒更新餘額」——呼叫端得講給使用者聽');
  assert.equal(r.updated, 0); assert.equal(r.created, 0);
  assert.equal(db.accounts[0].balance, 111, '★餘額一動都不可以動（不知道新舊）');
  assert.equal(db.accounts[0].balanceAsOf, '2026-05-31', '★balanceAsOf 也不可以被改掉');
  assert.equal(db.accounts.length, 1, '★也不可以新建帳戶（新建就等於寫進一個不知道時點的餘額）');
});
test('預覽｜列出 update/create/skip-stale，不改 db', () => {
  const db = { accounts: [
    { id: 'a1', name: '甲', type: 'cash', currency: 'TWD', accountNo: '****3301', balance: 5 },
    { id: 'a2', name: '乙', type: 'cash', currency: 'TWD', accountNo: '****3302', balance: 9, balanceAsOf: '2026-06-30' },
  ] };
  const before = JSON.stringify(db);
  const pv = previewBalancesForDb(db, parsed('2026-05-01', [acc('3301', 'TWD', 23), acc('3302', 'TWD', 100), acc('9999', 'TWD', 7)]));
  assert.equal(pv.rows.find(r => r.suffix === '3301').action, 'update');
  assert.equal(pv.rows.find(r => r.suffix === '3302').action, 'skip-stale', '帳單較舊→標 skip-stale');
  assert.equal(pv.rows.find(r => r.suffix === '9999').action, 'create');
  assert.equal(JSON.stringify(db), before, '預覽不可改 db');
});

// ---- 對抗審查補強：matchAccount 收緊（避免財務資料靜默損毀，生存優先）----
const accM = (masked, currency, balance) => ({ suffix: (masked.match(/\*+(\d+)$/) || [])[1] || '', masked, balance, currency, label: '活存', note: '' });

test('餘額更新｜只比對現金帳戶：末碼相同的負債/保單帳戶不可被覆蓋（負債翻資產＝淨資產算錯）', () => {
  const db = { accounts: [{ id: 'loan', name: '房貸', type: 'mortgage', currency: 'TWD', accountNo: '123453301', balance: -2000000 }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('900100****3301', 'TWD', 23)]));
  assert.equal(db.accounts.find(a => a.id === 'loan').balance, -2000000, '房貸餘額不可被帳單覆蓋');
  assert.equal(r.updated, 0);
  assert.equal(r.created, 1, '改成新建一個現金帳戶');
});

test('餘額更新｜可見前綴防碰撞：末碼同 3301 但前綴不同（900100 vs 900200）＝兩個不同帳戶', () => {
  const db = { accounts: [] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('900100****3301', 'TWD', 100), accM('900200****3301', 'TWD', 200)]));
  assert.equal(r.created, 2, '前綴不同→兩個帳戶，不可合成一個');
  assert.deepEqual(db.accounts.map(a => a.balance).sort((x, y) => x - y), [100, 200]);
});

test('餘額更新｜同批快照比對：兩筆不同前綴不會比對到「本批剛新建的」而互吃', () => {
  // 既有一個完整帳號對到 900100...3301；帳單同時有 900100****3301（→update）與 900200****3301（→create）
  const db = { accounts: [{ id: 'x', type: 'cash', currency: 'TWD', accountNo: '90010000003301', balance: 5 }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('900100****3301', 'TWD', 100), accM('900200****3301', 'TWD', 200)]));
  assert.equal(r.updated, 1);
  assert.equal(r.created, 1);
  assert.equal(db.accounts.find(a => a.id === 'x').balance, 100);
});

test('餘額更新｜同批完全重複的遮罩列去重（不會建兩個）', () => {
  const db = { accounts: [] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('900100****3301', 'TWD', 100), accM('900100****3301', 'TWD', 100)]));
  assert.equal(r.created, 1, '同遮罩同幣別＝同一戶，去重');
});

test('餘額更新｜不支援幣別 graceful skip，不擋整張帳單（有效的照更新）', () => {
  const db = { accounts: [] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('111111****3301', 'TWD', 23), accM('222222****0999', 'EUR', 9999)]));
  assert.equal(r.created, 1, 'TWD 照建');
  assert.equal(r.unsupported, 1, 'EUR 略過、不 throw');
  assert.ok(!db.accounts.some(a => a.currency === 'EUR'));
});

test('餘額更新｜壞的現值參考日（2026/13/45）＝比照讀不到：餘額不動，不寫進 balanceAsOf 撞櫃檯 500', () => {
  const db = { accounts: [{ id: 'a1', name: '台新活存', type: 'bank', currency: 'TWD', balance: 111, accountNo: '900100****3301', balanceAsOf: '2026-05-31' }], transactions: [] };
  const parsed = { bank: '台新', referenceDate: '2026-13-45',
    accounts: [{ suffix: '3301', masked: '900100****3301', balance: 999, currency: 'TWD', label: '活存', note: '' }],
    transactions: [] };
  const r = applyBalancesToDb(db, parsed);
  assert.equal(r.balancesSkipped, true, '★壞日期＝當成讀不到（絕不拿它當時點）');
  assert.equal(db.accounts[0].balance, 111);
  assert.equal(db.accounts[0].balanceAsOf, '2026-05-31', '★壞日期不可進 balanceAsOf（會讓後續比大小撞櫃檯 500）');
});
test('餘額更新｜現值參考日「相等」也不覆蓋（保住兩次匯入間的手動修正）', () => {
  const db = { accounts: [{ id: 'a', type: 'cash', currency: 'TWD', accountNo: '900100****3301', balance: 88888, balanceAsOf: '2026-06-30' }] };
  const r = applyBalancesToDb(db, parsed('2026-06-30', [accM('900100****3301', 'TWD', 23)]));
  assert.equal(r.skipped, 1);
  assert.equal(db.accounts[0].balance, 88888, '同一天再匯不覆蓋手改值');
});

test('預覽｜讀不到參考日→blocked，動作標 blocked（與 apply 會 400 一致）', () => {
  const pv = previewBalancesForDb({ accounts: [] }, parsed(null, [accM('x****3301', 'TWD', 23)]));
  assert.equal(pv.blocked, true);
  assert.equal(pv.rows[0].action, 'blocked');
});

// ---- stage 3：明細解析＋分箱 ----
const { parseBankDetail } = await import('../lib/bank-statement.js');
const { classifyBankTx, previewBankTxForDb, importBankTxToDb } = await import('../lib/services/bank-import.js');

/** 合成明細列 {y, cells}（不帶寬度 w→解析走「左緣」退路）。 */
const D = (y, pairs) => ({ y, cells: pairs.map(([x, s]) => ({ x, s })) });
/** 合成明細列（帶寬度 w：[x, w, s]）——測「右緣分欄」（右對齊金額靠 x+w 判欄）。 */
const DW = (y, pairs) => ({ y, cells: pairs.map(([x, w, s]) => ({ x, w, s })) });

test('明細｜方向靠 x 分欄（支出/存入）＋換行備註靠 y 歸位', () => {
  const lines = [
    D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    D(100, [[53, '900100****3301'], [124, '2026/06/11'], [177, '轉帳存入'], [349, '$36,669'], [418, '$36,669 轉出900200****3302']]),   // 存入（x349 在存入欄）
    D(83, [[53, '900100****3301'], [124, '2026/06/16'], [177, '媒體轉出'], [289, '$16,333'], [418, '$20,336 房屋貸款']]),              // 支出（x289 在支出欄）
    D(66, [[53, '900200****3302'], [124, '2026/06/02'], [180, 'CD轉入'], [349, '$24,600'], [414, '$413,829']]),
    D(50, [[450, 'ATM 806 鐘點薪資']]),   // 換行備註（高 x、無帳號）→ 最近列 y66
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs.length, 3);
  assert.equal(txs[0].direction, 'in');
  assert.equal(txs[0].amount, 36669);
  assert.equal(txs[0].note, '轉出900200****3302');
  assert.equal(txs[1].direction, 'out');
  assert.equal(txs[1].note, '房屋貸款');
  assert.equal(txs[2].note, 'ATM 806 鐘點薪資', '換行備註歸到 CD轉入 那列');
});

test('明細｜方向退路（右緣分不出欄）：左緣＋中線判向——帳戶第一列、餘額空白時它就是最終裁決（階段三缺口 H1）', () => {
  // 這條退路是唯一決定金流正負號的最後防線：右緣落不進「支出/存入」欄窗、又沒有 running 餘額可校正時，
  // 全靠「左緣是否過中線」。被改壞（中線算錯/比較反向）＝真實支出被匯成存入，正負翻面且無聲。
  const lines = [
    D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    // 右緣 250+10=260 落在支出欄左外側（<272）＝右緣分不出欄；左緣 250 < 中線 (272+331)/2=301.5 → out
    DW(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '現金支出'], [250, 10, '$1,234']]),
    // 右緣 350+60=410 越過餘額欄左緣（≥396）、左緣 350 < 396 又非餘額欄＝右緣分不出欄；350 ≥ 中線 → in
    DW(83, [[53, 0, '900200****3302'], [124, 0, '2026/06/12'], [177, 0, '轉帳存入'], [350, 60, '$5,678']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs.length, 2);
  assert.equal(txs[0].direction, 'out', '左緣在中線左＝支出');
  assert.equal(txs[0].amount, 1234);
  assert.equal(txs[1].direction, 'in', '左緣在中線右＝存入');
  assert.equal(txs[1].amount, 5678);
});

const btx = (o) => ({ acctSuffix: '3302', acctMasked: '900200****3302', date: '2026-06-01', summary: '', direction: 'out', amount: 100, balance: 0, note: '', ...o });

test('分箱｜劃撥（證券交割）→ 內轉/交割（獨立子分類、不計收支；使用者定 2026-07-21）', () => {
  const c = classifyBankTx(btx({ summary: '轉帳存入', direction: 'in', note: '劃撥轉帳元大台灣50' }), new Set());
  assert.equal(c.type, 'transfer'); assert.equal(c.category, '內轉'); assert.equal(c.subcategory, '交割');
});

test('分箱｜備註含自己帳號末碼 → 內轉出/入（非劃撥用方向子類，不是交割）；不含 → 照收支', () => {
  const own = new Set(['3302', '3301']);
  const inTx = classifyBankTx(btx({ note: '轉入900100****3301' }), own);   // 自己帳號、非劃撥、direction out
  assert.equal(inTx.type, 'transfer'); assert.equal(inTx.subcategory, '內轉出');   // 依方向、不是交割
  assert.equal(classifyBankTx(btx({ summary: '轉帳支取', note: '轉入900200****7788養育費' }), own).type, 'expense', '7788非自己帳號→真支出');
});

test('分箱｜繳卡費→支出不分類（卡明細已分）；領現金→生活/其他生活雜支；手續費/房貸/養育/利息/配息各就位', () => {
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '媒體轉帳', note: '台新卡費' }), new Set())), ['expense', '', '']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: 'CD提款', note: 'ATM/跨行交易' }), new Set())), ['expense', '生活', '其他生活雜支']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '跨轉手續費' }), new Set())), ['expense', '其他', '手續費']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '媒體轉出', note: '房屋貸款富邦人壽' }), new Set())), ['expense', '居住', '房貸']);
  assert.deepEqual(pick(classifyBankTx(btx({ summary: '轉帳支取', note: '轉入900200****7788養育費' }), new Set())), ['expense', '養育', '贍養費']);
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
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [{ suffix: '3302', masked: '900200****3302' }],
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
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [{ suffix: '3302', masked: '900200****3302' }],
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
    D(100, [[53, '900200****3302'], [124, '2026/06/24'], [177, 'CD轉出'], [289, '$15,000'], [414, '$172,748']]),
    D(83, [[53, '900200****3302'], [124, '2026/06/24'], [177, '跨轉手續費'], [325, '$15'], [414, '$172,733']]),   // $15 x325 落存入側，但餘額 -15 → out
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs[1].direction, 'out', '餘額 172748→172733 差 -15 → 支出（不被 x 幾何判反）');
  assert.equal(txs[1].amount, 15);
});

test('明細｜表頭逐字拆/讀不到欄位 → 丟可見錯誤，不靜默歸零（無聲總損）', () => {
  const lines = [
    D(120, [[75, '帳'], [80, '號'], [272, '支'], [278, '出'], [284, '金'], [290, '額'], [331, '存'], [337, '入'], [343, '金'], [349, '額'], [396, '帳'], [402, '戶'], [408, '餘'], [414, '額']]),
    D(100, [[53, '900200****3302'], [124, '2026/06/24'], [177, 'CD轉出'], [289, '$15,000'], [414, '$172,748']]),
  ];
  assert.throws(() => parseBankDetail(lines), (/** @type {any} */ e) => e.status === 400, '表頭抓不到欄位 x → 400，不回 [] 靜默漏光');
});

test('明細｜摘要區的序號數字不被誤當交易金額（txnCell 下界）', () => {
  const lines = [
    D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [222, '支票號碼'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    D(100, [[53, '900200****3302'], [124, '2026/06/24'], [177, '轉帳存入'], [205, '12345'], [349, '$8,000'], [414, '$100,000']]),   // 摘要區 12345@x205 不可當金額
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

// ---- Codex r12 對抗審查修正的回歸考題（8 findings）----
test('r12#1 明細｜同列獨立「備註欄」的文字要收進 note（劃撥放備註欄→內轉，不漏收成收入）', () => {
  const lines = [
    D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    D(100, [[53, '900100****3301'], [124, '2026/06/11'], [177, '轉帳存入'], [349, '$500,000'], [500, '劃撥轉帳元大台灣50']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].note, '劃撥轉帳元大台灣50', '獨立備註欄(x≥xNote)的文字要收進 note');
  assert.equal(classifyBankTx(txs[0], new Set()).type, 'transfer', '劃撥→內轉（note 有收到才判得出來）');
});

test('r12#2 分箱｜外幣帳戶明細不計入台幣現金流：預覽標 foreign、匯入跳過（尚無歷史匯率）', () => {
  const parsed = { bank: '台新', referenceDate: '2026-06-30',
    accounts: [{ suffix: '3302', masked: '900200****3302', currency: 'TWD' }, { suffix: '363', masked: '900300****363', currency: 'USD' }],
    transactions: [
      btx({ acctMasked: '900200****3302', acctSuffix: '3302', summary: '存款息', direction: 'in', amount: 23, balance: 23 }),
      btx({ acctMasked: '900300****363', acctSuffix: '363', summary: '轉帳支取', direction: 'out', amount: 1000, balance: 5000 }),
    ] };
  const db = { accounts: [], transactions: [] };
  const pv = previewBankTxForDb(db, parsed);
  assert.equal(pv.counts.foreign, 1, 'USD 那筆標 foreign');
  assert.ok(pv.rows.find(r => r.currency === 'USD').foreign);
  const r = importBankTxToDb(db, parsed);
  assert.equal(r.foreign, 1, 'USD 不匯入');
  assert.equal(r.imported, 1, '只匯入 TWD 那筆');
  assert.ok(!db.transactions.some(t => t.amount === 1000), 'USD 1000 原幣不進台幣現金流');
});

test('r12#3 明細｜方向靠右緣：帳戶第一筆小額支出(左緣越過中線)仍判支出，不被中線翻成存入', () => {
  // 支出欄 [272,331)；$15 右對齊右緣 325（在支出欄）但左緣 315（>中線 301.5）。第一筆、無餘額→無法靠餘額校正
  const lines = [
    DW(120, [[75, 0, '帳號'], [135, 0, '日期'], [185, 0, '摘要'], [222, 0, '支票號碼'], [272, 0, '支出金額'], [331, 0, '存入金額'], [396, 0, '帳戶餘額'], [489, 0, '備註']]),
    DW(100, [[53, 40, '900200****3302'], [124, 50, '2026/06/24'], [177, 30, '跨轉手續費'], [315, 10, '$15']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs[0].direction, 'out', '右緣 325 落支出欄 [272,331)→支出（非靠中線 301.5 判成存入）');
  assert.equal(txs[0].amount, 15);
});

test('r12#4 明細｜純數字支票號碼不被當交易金額（右緣落支票號碼欄→忽略）', () => {
  const lines = [
    DW(120, [[75, 0, '帳號'], [135, 0, '日期'], [185, 0, '摘要'], [222, 0, '支票號碼'], [272, 0, '支出金額'], [331, 0, '存入金額'], [396, 0, '帳戶餘額'], [489, 0, '備註']]),
    DW(100, [[53, 40, '900200****3302'], [124, 50, '2026/06/24'], [177, 30, '轉帳支取'], [235, 30, '12345'], [300, 25, '$8,000'], [430, 45, '$100,000']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs[0].amount, 8000, '真金額 8000（支票號碼 12345 右緣落 [222,272)→忽略）');
  assert.equal(txs[0].direction, 'out');
  assert.equal(txs[0].balance, 100000);
});

test('r12#5 明細｜末碼相同、前綴不同的兩帳戶不可混：餘額差分組用完整遮罩、去重不撞', () => {
  // 兩帳戶都末碼 3301、各一筆支出；餘額差剛好=金額，若用末碼分組會把第二筆誤校正成收入
  const lines = [
    D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    D(100, [[53, '900100****3301'], [124, '2026/06/01'], [177, '轉帳支取'], [289, '$1,000'], [414, '$50,000']]),
    D(83, [[53, '900200****3301'], [124, '2026/06/01'], [177, '轉帳支取'], [289, '$1,000'], [414, '$51,000']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs[0].direction, 'out');
  assert.equal(txs[1].direction, 'out', '不同帳戶→不因跨帳戶餘額差(50000→51000=1000)誤校正成收入');
  assert.notEqual(txs[0].acctMasked, txs[1].acctMasked, '保留完整遮罩帳號');
  const db = { accounts: [], transactions: [] };
  const r = importBankTxToDb(db, { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: txs });
  assert.equal(r.imported, 2, '兩不同帳戶同額同日不被誤去重（去重鍵含完整遮罩帳號）');
});

test('r12#6 匯入｜完全相同、餘額讀不到(null)的兩筆真實交易靠批內出現序不被誤去重', () => {
  const db = { accounts: [], transactions: [] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: '跨轉手續費', amount: 15, balance: null, note: '' }),
    btx({ summary: '跨轉手續費', amount: 15, balance: null, note: '' }),
  ] };
  const r = importBankTxToDb(db, parsed);
  assert.equal(r.imported, 2, '同日同額同備註、餘額 null 的兩筆＝各自出現序，不被誤去重');
  const r2 = importBankTxToDb(db, parsed);
  assert.equal(r2.imported, 0, '重匯全去重（出現序穩定）');
  assert.equal(r2.skipped, 2);
});

test('r12#7 明細｜壞日期（不存在的 2026/02/31）整筆跳過，不讓匯入時撞 schema 500', () => {
  const lines = [
    D(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    D(100, [[53, '900200****3302'], [124, '2026/02/31'], [177, '轉帳支取'], [289, '$100'], [414, '$5,000']]),
    D(83, [[53, '900200****3302'], [124, '2026/06/15'], [177, '轉帳支取'], [289, '$200'], [414, '$4,800']]),
  ];
  const txs = parseBankDetail(lines);
  assert.equal(txs.length, 1, '壞日期那筆跳過（格式對但日曆上不存在）');
  assert.equal(txs[0].date, '2026-06-15');
});

test('r12#8 分箱｜支出自動分箱套用使用者的分類改名（resolveImportCategory）：不寫樹外孤兒', () => {
  const db = { accounts: [], transactions: [], settings: {
    categoryAliases: { '生活': '日常' },
    expenseTree: { '日常': ['其他生活雜支'], '其他': ['未分類', '手續費'] },
  } };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: 'CD提款', direction: 'out', amount: 2000, balance: 1000, note: 'ATM' }),
  ] };
  const pv = previewBankTxForDb(db, parsed);
  assert.deepEqual([pv.rows[0].category, pv.rows[0].subcategory], ['日常', '其他生活雜支'], '領現金→改名後的「日常」，非樹外「生活」');
});

test('r12#8b 分箱｜收入分箱 conform 到生效收入樹：被刪的收入分類落其他/其他收入（不留孤兒）', () => {
  const db = { accounts: [], transactions: [], settings: { incomeTree: { '其他': ['其他收入'] } } };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: '存款息', direction: 'in', amount: 23, balance: 23 }),
  ] };
  const pv = previewBankTxForDb(db, parsed);
  assert.deepEqual([pv.rows[0].category, pv.rows[0].subcategory], ['其他', '其他收入'], '被刪的「被動」→落其他/其他收入');
});

// ---- Codex r12 修正的「對抗式回歸審查」再補強（txCurrency fail-open / cash 護欄 / 名稱退回 / 舊鍵相容）----
test('r12v2 概要｜餘額空白的外幣帳戶仍記幣別到 accountCurrency（明細判幣別不 fail-open 成 TWD）', () => {
  const lines = [
    L([[47, '外幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[366, 'USD']]),
    L([[56, '外幣活存'], [108, '900300****363']]),   // 餘額空白→不進 accounts，但幣別要記
  ];
  const r = parseBankSummary(lines);
  assert.equal(r.accounts.length, 0, '餘額空白→不進餘額更新清單');
  assert.equal(r.accountCurrency['900300****363'], 'USD', '幣別仍被記下（供明細可靠判幣別）');
});

test('r12v2 分箱｜外幣帳戶(概要餘額空白、db 未登記)的明細靠 accountCurrency 判外幣→匯入跳過、不以面值計台幣', () => {
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [],
    accountCurrency: { '900300****363': 'USD' },
    transactions: [btx({ acctMasked: '900300****363', acctSuffix: '363', summary: '轉帳支取', direction: 'out', amount: 1000, balance: 5000 })] };
  const db = { accounts: [], transactions: [] };
  assert.equal(previewBankTxForDb(db, parsed).counts.foreign, 1);
  const r = importBankTxToDb(db, parsed);
  assert.equal(r.foreign, 1);
  assert.equal(r.imported, 0, 'USD 1000 不以面值計入台幣現金流');
});

test('r12v2 分箱｜真台幣現金流不因撞到「同前綴末碼的外幣非現金帳戶」被誤判 foreign 靜默漏帳（cash 護欄）', () => {
  const db = { accounts: [{ id: 'inv', type: 'investment', currency: 'USD', accountNo: '900100999993301' }], transactions: [] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], accountCurrency: {},
    transactions: [btx({ acctMasked: '900100****3301', acctSuffix: '3301', summary: '薪資轉入', direction: 'in', amount: 50000, balance: 80000 })] };
  const r = importBankTxToDb(db, parsed);
  assert.equal(r.foreign, 0, '不因撞到外幣非現金帳戶被判外幣');
  assert.equal(r.imported, 1, '真台幣薪資照匯入（現金流不漏帳）');
});

test('r12v2 帳戶名｜登記 accountNo 未含遮罩前綴時仍靠末碼配到自己的現金帳戶；不抓同末碼的非現金帳戶名', () => {
  const db = { accounts: [
    { id: 'loan', name: '房貸', type: 'mortgage', currency: 'TWD', accountNo: '999993301' },   // 非現金、同末碼→不可當名
    { id: 'cash', name: '我的台新活存', type: 'cash', currency: 'TWD', accountNo: '3301' },       // 只登記末碼、無前綴
  ], transactions: [] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], accountCurrency: { '900100****3301': 'TWD' },
    transactions: [btx({ acctMasked: '900100****3301', acctSuffix: '3301', summary: '轉帳存入', direction: 'in', amount: 100, balance: 100 })] };
  importBankTxToDb(db, parsed);
  assert.equal(db.transactions[0].account, '我的台新活存', '配到現金帳戶（只登記末碼也行）、不抓房貸');
});

test('r12v2 匯入｜向後相容：db 有舊版格式 bankRef 的銀行交易，新匯入認得、不重複計（現金流不翻倍）', () => {
  const tx = btx({ acctMasked: '900200****3302', acctSuffix: '3302', summary: '存款息', direction: 'in', amount: 23, balance: 23 });
  const legacy = 'bank|3302|2026-06-01|in|23|23|存款息|';   // 舊版鍵＝末碼、無出現序
  const db = { accounts: [], transactions: [{ id: 'old', bankRef: legacy, ledger: 'cashflow', source: 'bank' }] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], accountCurrency: {}, transactions: [tx] };
  const r = importBankTxToDb(db, parsed);
  assert.equal(r.imported, 0, '舊版已匯入→認得舊 bankRef、不重覆匯入');
  assert.equal(r.skipped, 1);
});

// ---- 餘額空白的自己帳戶也算「自己人」（2026-07-28 修；Codex gpt-5.6-sol 重審發現）----
// 病根：`parseBankSummary` 對「餘額欄空白」的帳戶（台新對透支／負餘額帳戶就這樣印）**刻意只記幣別、
// 不進 accounts**——那份清單是給「餘額更新」用的，沒有餘額就沒得更新。但 `ownSuffixSet` 只讀 accounts，
// 於是它不算「自己的帳戶」：轉錢過去被判成**支出**、從它轉回來被判成**收入**，現金流兩個方向都髒掉。
// 而且**每一期都會錯**——applyBalancesToDb 同樣只走 parsed.accounts，那個帳戶永遠不會被自動建進 db。
test('內轉判定｜概要區「餘額空白」的自己帳戶：轉出與轉入兩個方向都要判成內轉（不是支出／收入）', () => {
  // 3301 是自己的帳戶但餘額欄空白（透支）→ 只在 accountCurrency，不在 accounts
  const mkParsed = (tx) => ({
    bank: '台新', referenceDate: '2026-06-30',
    accounts: [{ suffix: '3302', masked: '900200****3302', balance: 136185, currency: 'TWD', label: '台新 3302（Richart）', note: '' }],
    accountCurrency: { '900200****3302': 'TWD', '900100****3301': 'TWD' },
    transactions: [tx],
  });

  const out = previewBankTxForDb({ accounts: [], transactions: [] }, mkParsed(
    btx({ summary: '轉帳支取', direction: 'out', amount: 50000, note: '轉入900100****3301', balance: 86185 }))).rows[0];
  assert.equal(out.type, 'transfer', '轉給自己的透支戶＝內轉，不可以算成支出（會讓當月支出虛增 5 萬）');
  assert.equal(out.subcategory, '內轉出');

  const inn = previewBankTxForDb({ accounts: [], transactions: [] }, mkParsed(
    btx({ summary: '轉帳存入', direction: 'in', amount: 50000, note: '轉自900100****3301', balance: 186185 }))).rows[0];
  assert.equal(inn.type, 'transfer', '從自己的透支戶轉回來＝內轉，不可以算成收入（收入多算＝現金流數字整個毀掉）');
  assert.equal(inn.subcategory, '內轉入');
});

test('內轉判定｜「別人的帳號」仍然是真金流（修完不可以把所有轉帳都當成內轉）', () => {
  const parsed = {
    bank: '台新', referenceDate: '2026-06-30', accounts: [],
    accountCurrency: { '900200****3302': 'TWD' },     // 只有自己這一戶
    transactions: [btx({ summary: '轉帳支取', direction: 'out', amount: 8000, note: '轉入700500****9999', balance: 1000 })],
  };
  const r = previewBankTxForDb({ accounts: [], transactions: [] }, parsed).rows[0];
  assert.notEqual(r.type, 'transfer', '轉給第三方＝真支出，不可被誤判成內轉而從現金流消失');
  assert.equal(r.type, 'expense');
});

// ---- 外幣幣別標題 sticky ＋ 讀不到就 fail-closed（2026-07-28 修；Codex gpt-5.6-sol 重審發現）----
// 病根一：每解析完一個外幣帳戶就把 pendingCurrency 清空 → 同一個幣別標題下的第二個帳戶落到預設值。
// 病根二：那個預設值是 'USD'（fail-open）。兩者相乘＝JPY 帳戶被當成 USD，
// 實測現金從 43,000 TWD 變成 3,221,500 TWD（虛增約 150 倍）、真 JPY 帳戶留在舊餘額、外加一個幽靈帳戶。
test('概要區｜同一個幣別標題底下的第二個帳戶，幣別要跟著標題（不可退成 USD）', () => {
  const lines = [
    L([[47, '外幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[367, 'JPY']]),
    L([[56, '外幣活存'], [108, '900300****363'], [436, '$100,000'], [513, 'Richart']]),
    L([[56, '外幣定存'], [108, '900400****777'], [436, '$100,000'], [513, '']]),
    L([[47, '合計'], [490, '0']]),
  ];
  const r = parseBankSummary(lines);
  assert.equal(r.accounts.length, 2);
  assert.equal(r.accounts[0].currency, 'JPY');
  assert.equal(r.accounts[1].currency, 'JPY', '第二戶被判成 USD 的話，10 萬日圓會被當成 10 萬美元');
  assert.equal(r.accountCurrency['900400****777'], 'JPY');
});

test('概要區｜幣別標題多幾格（幣別｜JPY｜匯率）仍要認得出來——限格數只會讓整組退回預設值', () => {
  const lines = [
    L([[47, '外幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[300, '幣別'], [367, 'JPY'], [420, '匯率']]),
    L([[56, '外幣活存'], [108, '900300****363'], [436, '$100,000'], [513, '']]),
    L([[47, '合計'], [490, '0']]),
  ];
  assert.equal(parseBankSummary(lines).accounts[0].currency, 'JPY');
});

test('概要區｜真的讀不出唯一幣別＝哨兵值（fail-closed），不猜 USD', () => {
  const lines = [
    L([[47, '外幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[300, '幣別代碼欄位異常']]),                                    // 有文字、讀不出代碼
    L([[56, '外幣活存'], [108, '900300****363'], [436, '$100,000'], [513, '']]),
    L([[47, '合計'], [490, '0']]),
  ];
  const r = parseBankSummary(lines);
  assert.equal(r.accounts[0].currency, UNKNOWN_CURRENCY, '認不出幣別就要說「不知道」，不可以猜');
  assert.ok(!CURRENCIES.includes(r.accounts[0].currency), '哨兵值必須不在 CURRENCIES 裡，才會走 unsupported 分支');
});

// ⚠️ sticky 的必要配套（Codex 複審阻擋#2）：只讓標題延續到**下一個標題**，
// 絕不讓上一組的幣別漏到下一組。少了這條，sticky 只是把 fail-open 從「猜 USD」換成「猜上一個幣別」。
test('概要區｜sticky 不可以漏到下一組：認不出的第二個標題要清成「不知道」，不是沿用 JPY', () => {
  const lines = [
    L([[47, '外幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[367, 'JPY']]),
    L([[56, '外幣活存'], [108, '900300****363'], [436, '$100,000'], [513, '']]),
    L([[358, '0.196327']]),                                          // 匯率列＝結構上無意義，不可清掉 JPY
    L([[300, '幣別代碼欄位異常']]),                                    // 認不出的第二個標題 → 必須清成不知道
    L([[56, '外幣定存'], [108, '900400****777'], [436, '$100,000'], [513, '']]),
    L([[47, '合計'], [490, '0']]),
  ];
  const r = parseBankSummary(lines);
  assert.equal(r.accounts[0].currency, 'JPY', '第一組照常（匯率列不可以把 JPY 清掉）');
  assert.equal(r.accounts[1].currency, UNKNOWN_CURRENCY,
    '第二組沿用了 JPY＝把 10 萬美元當成 10 萬日圓（sticky 從 fail-open 換成另一種 fail-open）');
});

test('概要區｜幣別不明的帳戶：預覽標 unsupported、套用不建帳戶也不動餘額（fail-closed 一路到底）', () => {
  const parsed = {
    bank: '台新', referenceDate: '2026-06-30',
    accounts: [{ suffix: '363', masked: '900300****363', balance: 100000, currency: UNKNOWN_CURRENCY, label: '外幣活存', note: '' }],
    accountCurrency: { '900300****363': UNKNOWN_CURRENCY },
  };
  const pv = previewBalancesForDb({ accounts: [] }, parsed);
  assert.equal(pv.rows[0].action, 'unsupported');
  const db = { accounts: [] };
  const r = applyBalancesToDb(db, parsed);
  assert.equal(r.created, 0, '不可以建出一個幣別不明的幽靈帳戶');
  assert.equal(r.unsupported, 1);
  assert.equal(db.accounts.length, 0);
});

test('概要區｜台幣區不受影響（sticky 只作用在外幣區）', () => {
  const lines = [
    L([[47, '新臺幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[50, '新臺幣活存'], [150, '900100****3301'], [473, '$23']]),
    L([[47, '合計'], [445, '$23']]),
    L([[47, '外幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L([[367, 'JPY']]),
    L([[56, '外幣活存'], [108, '900300****363'], [436, '$100'], [513, '']]),
  ];
  const r = parseBankSummary(lines);
  assert.equal(r.accounts.find(a => a.suffix === '3301').currency, 'TWD');
  assert.equal(r.accounts.find(a => a.suffix === '363').currency, 'JPY');
});

// ---- 機構維度（P1a 銀行身分維度，2026-08-12）：多銀行前提工程 ----
// 設計要旨：①帳戶記了開戶機構（bank）＝跨行不可互配；缺席＝祖父條款照舊只比數字（行為釘住）
// ②去重鍵雙格式：台新既有格式**位元組級凍結**、他行走 bank2|機構|…——不同銀行同字樣不撞鍵
// ③顯示層 812- 補碼只屬台新。合成機構名一律用「合成一銀」（明顯假值，同帳號末碼慣例）。
const { reconcileBankTxAccountNames, bankDisplayNote, applyLearnedBankToDb } = await import('../lib/services/bank-import.js');
const parsedAs = (bank, referenceDate, accounts) => ({ bank, referenceDate, accounts });

test('機構維度｜蓋過機構戳的帳戶不可被他行帳單覆蓋：同字樣可見帳號→不更新、另建新帳戶', () => {
  const db = { accounts: [{ id: 'fx', name: '一銀活儲', type: 'cash', class: '現金', bank: '合成一銀', currency: 'TWD', accountNo: '900100123453301', balance: 777 }] };
  const r = applyBalancesToDb(db, parsedAs('台新', '2026-06-30', [accM('900100****3301', 'TWD', 23)]));
  assert.equal(db.accounts.find(a => a.id === 'fx').balance, 777, '一銀帳戶餘額不可被台新帳單覆蓋（跨行誤配＝財務資料損毀）');
  assert.equal(r.created, 1, '台新這筆自成新帳戶');
  const created = db.accounts.find(a => a.id !== 'fx');
  assert.equal(created.bank, '台新', '新建帳戶蓋機構戳（帳單自己的宣告）');
  assert.equal(created.name, '台新 3301（活存）');
});

test('機構維度｜祖父條款：沒有機構戳的既有帳戶照舊只比數字（更新成功、且不回填機構戳）', () => {
  const db = { accounts: [{ id: 'a1', name: '我的台新', type: 'cash', currency: 'TWD', accountNo: '900100123453301', balance: 5 }] };
  const r = applyBalancesToDb(db, parsedAs('台新', '2026-06-30', [accM('900100****3301', 'TWD', 23)]));
  assert.equal(r.updated, 1, '機構維度之前建的帳戶（無 bank 欄）＝既有行為不變');
  const a = db.accounts.find(x => x.id === 'a1');
  assert.equal(a.balance, 23);
  assert.equal(a.bank, undefined, '比對成功＝數字推論、不是帳單宣告——不可回填機構戳（猜錯會從此擋掉正確比對）');
});

test('機構維度｜非台新帳單：新建帳戶名帶機構、蓋機構戳；無戳帳戶依祖父條款照樣可配', () => {
  const db = { accounts: [{ id: 'old', name: '舊帳戶', type: 'cash', currency: 'TWD', accountNo: '900200123453302', balance: 1 }] };
  const r = applyBalancesToDb(db, parsedAs('合成一銀', '2026-06-30', [accM('900200****3302', 'TWD', 88), accM('900400****4404', 'TWD', 7)]));
  assert.equal(r.updated, 1, '無戳帳戶＝不驗機構（誠實劃界：祖父路徑的理論碰撞已記在 matchAccount 註解）');
  assert.equal(db.accounts.find(a => a.id === 'old').bank, undefined, '更新不回填');
  const created = db.accounts.find(a => a.accountNo === '900400****4404');
  assert.equal(created.name, '合成一銀 4404（活存）', '自動名帶帳單機構、不再寫死台新');
  assert.equal(created.bank, '合成一銀');
});

test('機構維度｜去重鍵雙格式：台新位元組級凍結（bank|…）、他行 bank2|機構|…', () => {
  const tx = btx({ summary: 'CD提款', amount: 20000, balance: 100 });
  const db1 = { accounts: [], transactions: [] };
  importBankTxToDb(db1, { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [tx] });
  assert.equal(db1.transactions[0].bankRef, 'bank|900200****3302|2026-06-01|out|20000|100|CD提款|',
    '台新格式一個位元組都不能變——變了＝既有資料重匯判不出重複＝現金流翻倍');
  const db2 = { accounts: [], transactions: [] };
  importBankTxToDb(db2, { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [tx] });
  assert.equal(db2.transactions[0].bankRef, 'bank2|合成一銀|900200****3302|2026-06-01|out|20000|100|CD提款|',
    '他行新格式：機構第 2 段、帳號右移第 3 段');
  assert.equal(db2.transactions[0].account, '合成一銀 3302', '帳戶名 fallback 帶機構、不再寫死台新');
});

test('機構維度｜不同銀行的同字樣交易不互判重複：台新已匯，同字樣他行照樣匯入（預覽也不標 duplicate）', () => {
  const tx = btx({ summary: 'CD提款', amount: 20000, balance: 100 });
  const db = { accounts: [], transactions: [] };
  importBankTxToDb(db, { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [tx] });
  const pv = previewBankTxForDb(db, { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [tx] });
  assert.equal(pv.counts.duplicate, 0, '跨行同字樣＝不同交易，預覽不可標 duplicate');
  const r = importBankTxToDb(db, { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [tx] });
  assert.equal(r.imported, 1, '跨行同字樣＝各自成立（撞鍵會少記他行的錢）');
});

test('機構維度｜舊版末碼鍵只屬台新：台新重匯認得舊列去重、他行不可冒領', () => {
  const tx = btx({ summary: 'CD提款', amount: 20000, balance: 100 });
  const legacyRow = { id: 'L1', source: 'bank', bankRef: 'bank|3302|2026-06-01|out|20000|100|CD提款|' };   // stage 3 初版格式（末碼）
  const dbA = { accounts: [], transactions: [legacyRow] };
  const rA = importBankTxToDb(dbA, { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [tx] });
  assert.equal(rA.imported, 0, '台新重匯：舊版鍵仍認得＝不重複記');
  const dbB = { accounts: [], transactions: [{ ...legacyRow }] };
  const rB = importBankTxToDb(dbB, { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [tx] });
  assert.equal(rB.imported, 1, '他行不可拿台新時代的舊版鍵冒領去重（那會把他行的真交易吃掉）');
});

test('機構維度｜顯示層 812- 補碼只屬台新：他行行內帳號原樣呈現', () => {
  assert.equal(bankDisplayNote('CD轉出', '00001234****5678 甲'), '現金轉出・812-00001234****5678（甲）', '台新（預設）＝補台新代碼');
  assert.equal(bankDisplayNote('CD轉出', '00001234****5678 甲', { bank: '合成一銀' }), '現金轉出・00001234****5678（甲）', '他行帳單＝不可硬掛台新代碼（指鹿為馬）');
});

test('機構維度｜bank2 反解：改名對齊認機構、方向護欄讀第 5 段', () => {
  // 改名對齊：bank2 列的帳號在第 3 段、機構在第 2 段——只可對到同機構（或無戳）的帳戶
  const db = { accounts: [{ id: 'fx', name: '一銀活儲', type: 'cash', bank: '合成一銀', currency: 'TWD', accountNo: '900200123453302', balance: 0 }],
    transactions: [
      { id: 't1', source: 'bank', account: '合成一銀 3302', bankRef: 'bank2|合成一銀|900200****3302|2026-06-01|out|100||CD提款|' },
      { id: 't2', source: 'bank', account: '台新 3302', bankRef: 'bank|900200****3302|2026-06-01|out|100||CD提款|' },
    ] };
  const changed = reconcileBankTxAccountNames(db);
  assert.equal(changed, 1, '只有 bank2 列（機構相符）改名');
  assert.equal(db.transactions.find(t => t.id === 't1').account, '一銀活儲');
  assert.equal(db.transactions.find(t => t.id === 't2').account, '台新 3302', '舊格式列＝台新身分，不可被一銀帳戶收編改名');
  // 方向護欄：bank2 的方向在第 5 段（無 dir 欄的殘缺列靠 bankRef 反解）——讀錯段會把出帳當成可套收入
  const db2 = { accounts: [], learnedBank: { '轉帳存入|付款人甲': { type: 'income', category: '其他', subcategory: '其他收入' } },
    transactions: [{ id: 'x', source: 'bank', type: 'expense', category: '其他', subcategory: '未分類', note: '',
      bankKey: '轉帳存入|付款人甲', bankRef: 'bank2|合成一銀|900200****3302|2026-06-01|in|500||轉帳存入|付款人甲' }] };
  const r = applyLearnedBankToDb(db2, '轉帳存入|付款人甲');
  assert.equal(r.changed, 1, 'bank2 第 5 段是 in→收入規則可套（讀成第 4 段會拿帳號當方向＝全 skip）');
  assert.equal(db2.transactions[0].type, 'income');
});

// ---- 機構維度 r1 補強（Codex r1 四條，反例逐字入題）----
const dualStamped = () => ({ accounts: [
  { id: 'ts', name: '台新舊帳戶', type: 'cash', bank: '台新', currency: 'TWD', accountNo: '900200123453302', balance: 1 },
  { id: 'fb', name: '一銀活儲', type: 'cash', bank: '合成一銀', currency: 'TWD', accountNo: '900200123453302', balance: 2 },
], transactions: [] });
const xferTx = () => btx({ summary: '轉帳存入', direction: 'in', amount: 500, balance: null, note: '轉入900200****3302 生活費' });

test('機構維度｜r1#1 顯示帳戶名與行內轉帳說明認機構：同號雙戳帳戶各歸各行（preview＋import）', () => {
  const db = dualStamped();
  const pv = previewBankTxForDb(db, { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [xferTx()] });
  assert.equal(pv.rows[0].account, '一銀活儲', '一銀交易不可掛到台新帳戶（r1 實測反例：account=台新舊帳戶）');
  assert.equal(pv.rows[0].note, '現金存入・轉入到：一銀活儲（生活費）', '行內轉帳翻譯也要認機構（反例：轉入到：台新舊帳戶）');
  const r = importBankTxToDb(db, { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [xferTx()] });
  assert.equal(r.imported, 1);
  assert.equal(db.transactions[0].account, '一銀活儲', 'import 路徑同一套查找');
  assert.equal(db.transactions[0].note, '現金存入・轉入到：一銀活儲（生活費）');
  // 正向對照：台新帳單照樣對到台新帳戶（祖父行為不變）
  const pvTs = previewBankTxForDb(dualStamped(), { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [xferTx()] });
  assert.equal(pvTs.rows[0].account, '台新舊帳戶');
  assert.equal(pvTs.rows[0].note, '現金存入・轉入到：台新舊帳戶（生活費）');
});

test('機構維度｜r1#2 幣別 fallback 認機構：他行同號 JPY 帳戶不可讓本行台幣列被當外幣丟掉', () => {
  const db = { accounts: [
    { id: 'jp', name: '台新日圓', type: 'cash', bank: '台新', currency: 'JPY', accountNo: '900200123453302' },
    { id: 'tw', name: '一銀台幣', type: 'cash', bank: '合成一銀', currency: 'TWD', accountNo: '900200123453302' },
  ], transactions: [] };
  const parsed = { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [xferTx()] };   // 概要缺幣別＝走 db 補位
  const pv = previewBankTxForDb(db, parsed);
  assert.equal(pv.rows[0].currency, 'TWD', 'db 補位只認同機構（r1 實測反例＝被同號台新 JPY 判成外幣）');
  assert.equal(pv.rows[0].foreign, false);
  const r = importBankTxToDb(db, parsed);
  assert.equal(r.imported, 1, '真台幣現金流不可被靜默丟掉');
  assert.equal(r.foreign, 0);
});

test('機構維度｜r1#3 accounts.bank 型別牆：備份匯入擋非字串、CRUD 白名單不可寫', async () => {
  const { validateImportItem, pickWritable, WRITABLE_FIELDS } = await import('../lib/schema.js');
  const bad = validateImportItem('accounts', { id: 'x', name: 'n', balance: 1, bank: { spoof: '台新' } });
  assert.ok(bad.errors.length >= 1 && bad.errors.join('；').includes('bank'), '物件型 bank 必須報錯（truthy 錯型會永久硬擋正確比對、falsy 錯型繞過護欄）');
  assert.equal(validateImportItem('accounts', { id: 'x', name: 'n', balance: 1, bank: '台新' }).errors.length, 0, '正常字串照過');
  assert.ok(!WRITABLE_FIELDS.accounts.includes('bank'), 'bank＝服務層擁有，不進 CRUD 白名單');
  assert.ok(!('bank' in pickWritable('accounts', { name: 'n', bank: '偽造機構' })), 'CRUD 表單挾帶 bank＝剝掉');
});

test('機構維度｜r2 祖父條款保存：無戳帳戶照樣供行內轉帳翻譯與幣別補位（收緊祖父＝這裡紅）', () => {
  // (a) 行內轉帳翻譯：機構維度之前建的無戳帳戶，他行帳單的行內帳號仍要翻得出「轉入到：」——
  //     把 ownAccountNameByAcct 收緊成「只認 a.bank === bank」會把祖父帳戶一起丟掉（r2 實測仍綠的第一刀）
  const db = { accounts: [{ id: 'old', name: '舊活儲', type: 'cash', currency: 'TWD', accountNo: '900200123453302', balance: 0 }], transactions: [] };
  const pv = previewBankTxForDb(db, { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [xferTx()] });
  assert.equal(pv.rows[0].account, '舊活儲', '無戳＝祖父條款：顯示帳戶名照樣可配');
  assert.equal(pv.rows[0].note, '現金存入・轉入到：舊活儲（生活費）', '無戳＝祖父條款：行內轉帳翻譯照樣成立');
  // (b) 幣別補位：無戳 JPY 現金帳戶仍要供補位——收緊成「a.bank !== bank 一律排除」會把無戳也排掉、
  //     fail-open 成 TWD、把外幣列當台幣匯入（r2 實測仍綠的第二刀＝方向最危險的那把）
  const dbJ = { accounts: [{ id: 'oj', name: '舊日圓', type: 'cash', currency: 'JPY', accountNo: '900200123453302' }], transactions: [] };
  const pvJ = previewBankTxForDb(dbJ, { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [xferTx()] });
  assert.equal(pvJ.rows[0].currency, 'JPY', '無戳 JPY＝祖父補位照用（排除無戳＝fail-open 成 TWD）');
  assert.equal(pvJ.rows[0].foreign, true);
  const rJ = importBankTxToDb(dbJ, { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], transactions: [xferTx()] });
  assert.equal(rJ.imported, 0, '外幣列不匯入');
  assert.equal(rJ.foreign, 1);
});

const { getDb, saveDb } = await import('../lib/repo.js');
const { reconcileAccountNamesAuto } = await import('../lib/services/bank-import.js');

test('機構維度｜r1#4 bank2 自動名重建：摘要備註右移段位、行內帳號認機構、不補 812-', async () => {
  const db = await getDb();
  db.accounts = [
    { id: 'ts2', name: '台新舊帳戶', type: 'cash', bank: '台新', currency: 'TWD', accountNo: '900200123453302', balance: 0 },
    { id: 'fb2', name: '一銀活儲', type: 'cash', bank: '合成一銀', currency: 'TWD', accountNo: '900200123453302', balance: 0 },
  ];
  db.transactions = [{ id: 'b2note', date: '2026-06-01', type: 'income', category: '其他', subcategory: '其他收入',
    amount: 500, account: '一銀活儲', note: '', autoNote: '', ledger: 'cashflow', source: 'bank', dir: 'in',
    bankRef: 'bank2|合成一銀|900200****3302|2026-06-01|in|500||轉帳存入|轉入900200****3302 生活費' }];
  await saveDb(db);
  await reconcileAccountNamesAuto();
  const t = (await getDb()).transactions.find(x => x.id === 'b2note');
  assert.equal(t.note, '現金存入・轉入到：一銀活儲（生活費）',
    'bank2 摘要在第 8 段、備註第 9 段起（退回舊段位＝拿餘額欄當摘要）；行內帳號只對同機構帳戶（台新戳同號排前面也不可抓走）');
  assert.equal(t.autoNote, t.note, 'autoNote 欄同步新格式');
});

test('預覽與匯入互扣｜外幣列不算進「會匯入」：preview 的可匯入筆數＝import 的 imported', () => {
  // r1#2：畫面說「以上 N 筆就是會匯入的全部內容」，但正式匯入對非 TWD 直接跳過 ⇒ 數字要對得起來。
  const db = { accounts: [], transactions: [] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30',
    accounts: [{ suffix: '3302', masked: '900200****3302', balance: 0, currency: 'TWD', label: '活存', note: '' }],
    accountCurrency: { '900200****3302': 'TWD', '900300****363': 'USD' },
    transactions: [
      btx({ summary: '轉帳存入', direction: 'in', amount: 1000, balance: 1000 }),
      btx({ acctSuffix: '363', acctMasked: '900300****363', summary: '外幣利息', direction: 'in', amount: 5, balance: 5 }),
    ] };
  const pv = previewBankTxForDb(db, parsed);
  const willImport = pv.rows.filter((/** @type {any} */ r) => !r.duplicate && !r.foreign).length;
  assert.equal(pv.counts.foreign, 1, '外幣要被認出來');
  const res = importBankTxToDb(db, parsed);
  assert.equal(res.imported, willImport, '★預覽宣稱會匯入的筆數，要等於實際匯入的筆數（外幣列不可算進去）');
  assert.equal(res.foreign, pv.counts.foreign, '外幣筆數兩邊也要對得起來');
});

// ---- 疑似重複（2026-08-12 William 實測：同期間的兩種版面各匯一次＝現金流多算一份）----
// ⚠️ 這道**不是**去重（去重鍵守的是「同一份帳單重複上傳」）：跨版式時摘要／備註原文不同 ⇒ 指紋
//    必然不同、去重認不出來。所以另立一個寬鬆判準（帳號末碼＋日期＋方向＋金額），**只提醒不擋**。
test('疑似重複｜同帳戶同日同額同方向、既有資料已有一筆＝標 similar（但仍會匯入、不是 duplicate）', () => {
  const db = { accounts: [], transactions: [
    // 既有交易：用**另一種版面**的摘要（跨版式的重點——原文不同，bankRef 必然對不上）
    { id: 'old1', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank|900200****3302|2026-06-01|in|1000|1000|轉帳存入|舊版面的備註' },
  ] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: '匯款存入', direction: 'in', amount: 1000, balance: 1000, note: '新版面的備註' }),   // 同日同額同向、文字不同
    btx({ date: '2026-06-02', summary: '轉帳存入', direction: 'in', amount: 1000, balance: 2000 }),      // 不同日
    btx({ summary: '轉帳存入', direction: 'in', amount: 999, balance: 999 }),                             // 不同額
    btx({ summary: '轉帳存入', direction: 'out', amount: 1000, balance: 0 }),                             // 不同方向
  ] };
  const pv = previewBankTxForDb(db, parsed);
  assert.equal(pv.rows[0].similar, true, '★跨版式的同一筆交易：去重認不出來，這道要標出來');
  assert.equal(pv.rows[0].duplicate, false, '★只提醒不擋：它仍然會被匯入（同日同額也可能真的是兩筆）');
  assert.equal(pv.rows[1].similar, false, '不同日＝不提醒');
  assert.equal(pv.rows[2].similar, false, '不同金額＝不提醒');
  assert.equal(pv.rows[3].similar, false, '不同方向＝不提醒');
  assert.equal(pv.counts.similar, 1);
  assert.equal(pv.counts.income, 3, 'similar 與收支分類並存——它是提醒，不改變這筆算不算收入');
});

test('疑似重複｜比的是帳號末碼不是完整遮罩（不同版面的帳號印法可能不同）＋明確重複不重複標', () => {
  const db = { accounts: [], transactions: [
    { id: 'old1', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank|****3302|2026-06-01|in|1000||舊摘要|' },   // 既有：遮罩只印末碼
  ] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: '轉帳存入', direction: 'in', amount: 1000, balance: 1000 }),   // 新版：900200****3302
  ] };
  assert.equal(previewBankTxForDb(db, parsed).rows[0].similar, true, '★遮罩印法不同也要對得上（比末碼）');
  // 明確重複（同一份帳單重匯）＝duplicate，不再多標一個 similar（同一件事不要講兩次）
  const db2 = { accounts: [], transactions: [] };
  importBankTxToDb(db2, parsed);
  const pv2 = previewBankTxForDb(db2, parsed);
  assert.equal(pv2.rows[0].duplicate, true);
  assert.equal(pv2.rows[0].similar, false, '已經是明確重複＝不再標疑似（不會匯入的列不必提醒）');
  assert.equal(pv2.counts.similar, 0);
});

test('疑似重複｜只提醒不影響寫入：similar 的列照樣匯入，db 也不留這個旗標（r1#3）', () => {
  // ⚠️ 原本只驗預覽的 duplicate/分類＝**假綠**：把正式 import 改成「similar 就跳過」，考題照樣全綠
  //    （審查者實測）。「只提醒不擋」是本支對使用者的承諾，要用**真的寫入結果**扣住。
  const db = { accounts: [], transactions: [
    { id: 'old1', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank|900200****3302|2026-06-01|in|1000|1000|轉帳存入|舊版面的備註' },
  ] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: '匯款存入', direction: 'in', amount: 1000, balance: 1000, note: '新版面的備註' }),   // similar
    btx({ date: '2026-06-02', summary: '轉帳存入', direction: 'in', amount: 500, balance: 1500 }),
  ] };
  const pv = previewBankTxForDb(db, parsed);
  assert.equal(pv.counts.similar, 1, '前置：要真的有一筆疑似重複');

  const res = importBankTxToDb(db, parsed);
  assert.equal(res.imported, 2, '★疑似重複的那筆**照樣匯入**（只提醒、不擋）');
  assert.equal(res.skipped, 0, '★不可被算成略過');
  assert.equal(res.foreign, 0);
  const added = db.transactions.filter((/** @type {any} */ t) => t.id !== 'old1');
  assert.equal(added.length, 2, '★兩筆都要真的落進 db');
  assert.ok(added.every((/** @type {any} */ t) => !('similar' in t)),
    '★similar 是**預覽用的旗標**，不可寫進 db（寫進去就會被後續功能當成資料）');
});

test('疑似重複｜不同機構、不同可見前綴＝不是同一個帳戶，不可提醒（r1#2）', () => {
  // 警語逐字說「同一個帳戶」——只比末碼的話，一銀與台新的同日同額會被說成同一個帳戶＝說謊。
  const other = { accounts: [], transactions: [
    { id: 'o1', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank2|合成一銀|900200****3302|2026-06-01|in|1000|1000|轉帳存入|' },
  ] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: '轉帳存入', direction: 'in', amount: 1000, balance: 1000 }),   // 台新 900200****3302
  ] };
  assert.equal(previewBankTxForDb(other, parsed).rows[0].similar, false,
    '★不同銀行的同末碼帳戶不是同一個帳戶');

  const samePrefixDiff = { accounts: [], transactions: [
    { id: 'o2', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank|900100****3302|2026-06-01|in|1000|1000|轉帳存入|' },   // 同銀行、前綴不同
  ] };
  assert.equal(previewBankTxForDb(samePrefixDiff, parsed).rows[0].similar, false,
    '★同一家銀行但可見前綴不同＝不同帳戶');

  // 但「有一邊印不出前綴」仍要對得上——那正是跨版式的常見情況
  const unknownPrefix = { accounts: [], transactions: [
    { id: 'o3', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank|****3302|2026-06-01|in|1000|1000|轉帳存入|' },
  ] };
  assert.equal(previewBankTxForDb(unknownPrefix, parsed).rows[0].similar, true,
    '★一邊只印末碼＝不知道前綴，不可拿來否決（否則跨版式救援直接失效）');
});

test('疑似重複｜機構寫法不同要算同一家，前綴帶分隔符也要分得出兩個帳戶（r2#1／r2#2）', () => {
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: '轉帳存入', direction: 'in', amount: 1000, balance: 1000 }),   // 900200****3302
  ] };
  // ① 既有那筆的機構寫成全稱（AI 路線是照帳單抬頭抄的）——不正規化就漏報，跨版式重複一聲不吭落帳
  const longName = { accounts: [], transactions: [
    { id: 'o1', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank2|台新國際商業銀行|900200****3302|2026-06-01|in|1000|1000|轉帳存入|' },
  ] };
  assert.equal(previewBankTxForDb(longName, parsed).rows[0].similar, true,
    '★「台新」與「台新國際商業銀行」是同一家——漏報等於這支功能對這種帳單完全失效');

  // ② 但不可亂合併：不同銀行仍要分開（正規化只剝通用後綴，不做同義詞猜測）
  const otherBank = { accounts: [], transactions: [
    { id: 'o2', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank2|合成一銀商業銀行|900200****3302|2026-06-01|in|1000|1000|轉帳存入|' },
  ] };
  assert.equal(previewBankTxForDb(otherBank, parsed).rows[0].similar, false,
    '★剝掉「商業銀行」之後仍是不同機構，不可互報');

  // ③ 前綴帶分隔符：兩個都被當成「沒有前綴」的話，同銀行的兩個帳戶會互報
  const dashed = { accounts: [], transactions: [
    { id: 'o3', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank|900-100****3302|2026-06-01|in|1000|1000|轉帳存入|' },
  ] };
  const dashedParsed = { ...parsed, transactions: [
    btx({ acctMasked: '900-200****3302', summary: '轉帳存入', direction: 'in', amount: 1000, balance: 1000 }),
  ] };
  assert.equal(previewBankTxForDb(dashed, dashedParsed).rows[0].similar, false,
    '★900-100 與 900-200 是同一家銀行的兩個不同帳戶，不可說成同一個');
  // 同一個帳戶、只是分隔符印法不同＝仍要對得上
  const sameDashed = { ...parsed, transactions: [
    btx({ acctMasked: '900100****3302', summary: '轉帳存入', direction: 'in', amount: 1000, balance: 1000 }),
  ] };
  assert.equal(previewBankTxForDb(dashed, sameDashed).rows[0].similar, true,
    '★洗掉分隔符後是同一個前綴＝同一個帳戶');
});

test('疑似重複｜最舊的 bankRef 只存純末碼（沒有遮罩星號）也要進索引（r3#1）', () => {
  // repo 明確保留相容性的正式資料形狀。accountSuffix 只認「星號後的數字」，讀不到就整筆不進索引
  //   ⇒ 那些最老的交易**永遠不會被提醒**，而它們正是最可能被跨版式重匯的一批。
  const legacy = { accounts: [], transactions: [
    { id: 'o1', source: 'bank', date: '2026-06-01', amount: 1000, dir: 'in',
      bankRef: 'bank|3302|2026-06-01|in|1000|1000|舊摘要|' },
  ] };
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ summary: '匯款存入', direction: 'in', amount: 1000, balance: 1000, note: '新版面' }),
  ] };
  assert.equal(previewBankTxForDb(legacy, parsed).rows[0].similar, true,
    '★純末碼＝末碼本身、前綴當作不知道（不可整筆略過）');
});

test('去重鍵｜摘要或日期讀錯＝重匯時認不出同一筆，會重複入帳（P1b-3 r12 實測後果）', () => {
  // ⚠️ 這一題釘住的是**使用者真的會遇到的後果**，不是理論：AI 把摘要或日期讀錯時金額全對、
  //    驗算也通過，但那兩欄是去重鍵 `bankRef` 的一部分 ⇒ 下次重匯同一份帳單認不出是同一筆。
  //    複審實跑：支出從 400 變 600。日期那型連「疑似重複」提醒都不會出現（那道也拿日期比對）。
  const base = () => ({ bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ date: '2026-06-05', summary: '提款', direction: 'out', amount: 400, balance: 600 }),
  ] });

  for (const [what, mutate] of /** @type {[string, (p:any) => void][]} */ ([
    ['摘要讀錯', (/** @type {any} */ p) => { p.transactions[0].summary = '提欵'; }],
    ['日期讀錯', (/** @type {any} */ p) => { p.transactions[0].date = '2026-06-06'; }],
  ])) {
    const db = { accounts: [], transactions: [] };
    importBankTxToDb(db, base());
    const second = base(); mutate(second);
    const r = importBankTxToDb(db, second);
    assert.equal(r.imported, 1, `★${what}：重匯時認不出是同一筆 ⇒ 又匯進去一筆（這就是為什麼它算「帳本會出錯」）`);
    assert.equal(db.transactions.length, 2, `★${what}：帳本上變成兩筆、支出被多算一次`);
  }
});

test('去重鍵｜餘額欄讀成空白也會破壞去重（P1b-3 r13：D 類不是「帳本不會出錯」）', () => {
  // ⚠️ 餘額欄同樣在 bankRef 裡。所以「金額與方向全對、只是餘額沒讀到」**仍會**讓重匯重複入帳。
  //    ⚠️ 這一型在正式 AI 路線會被 ★6（逐帳戶覆蓋）擋下，**不是生產漏洞**——這題釘的是
  //    「分類敘述不可寫成『帳本不會出錯』」這件事（r13 指正，與 r12 同型）。
  const withBal = () => ({ bank: '台新', referenceDate: '2026-06-30', accounts: [], transactions: [
    btx({ date: '2026-06-05', summary: '提款', direction: 'out', amount: 400, balance: 600 }),
  ] });
  const noBal = () => { const p = withBal(); p.transactions[0].balance = null; return p; };

  const db = { accounts: [], transactions: [] };
  importBankTxToDb(db, noBal());                  // 先匯「餘額沒讀到」的版本
  const r = importBankTxToDb(db, withBal());      // 再匯正確版本
  assert.equal(r.imported, 1, '★餘額欄不同＝指紋不同 ⇒ 認不出是同一筆，又匯進去一次');
  assert.equal(db.transactions.length, 2, '★帳本上變成兩筆＝同一筆被記了兩次');
});

test('純函式｜讀不到現值參考日：交易照樣進帳本、餘額一動都不動（正式入口那題在檔尾）', () => {
  // ⚠️ 這題是整個變更的**承重點**：使用者的金融卡明細沒印「現值參考日」，舊行為整份退回、
  //    他只能手動記帳。新行為＝交易照匯、餘額不動。兩半都要驗，缺一半都不成立：
  //    ①只驗「交易進去了」→ 可能連餘額也被亂寫（拿舊的蓋掉新的＝無聲毀資料）
  //    ②只驗「餘額沒動」→ 可能整份還是被擋（那就沒解鎖到任何東西）
  const db = { accounts: [{ id: 'a1', name: '台新活存', type: 'bank', currency: 'TWD',
    balance: 111, accountNo: '900100****3301', balanceAsOf: '2026-05-31' }], transactions: [] };
  const parsed = { bank: '台新', referenceDate: null,
    accounts: [{ suffix: '3301', masked: '900100****3301', balance: 999, currency: 'TWD', label: '活存', note: '' }],
    transactions: [
      btx({ date: '2026-06-05', summary: '提款', direction: 'out', amount: 400, balance: 600 }),
      btx({ date: '2026-06-08', summary: '轉帳存入', direction: 'in', amount: 100, balance: 700 }),
    ] };

  const bal = applyBalancesToDb(db, parsed);
  const tx = importBankTxToDb(db, parsed);

  assert.equal(tx.imported, 2, '★交易要真的進帳本——這就是這次變更解鎖的東西');
  assert.equal(db.transactions.length, 2);
  assert.equal(bal.balancesSkipped, true, '★要明確回報「這次沒更新餘額」');
  assert.equal(db.accounts[0].balance, 111, '★餘額一動都不可以動（不知道帳單新不新）');
  assert.equal(db.accounts[0].balanceAsOf, '2026-05-31', '★時點也不可以動');
  assert.equal(db.accounts.length, 1, '★不可新建帳戶（新建＝寫進一個不知道時點的餘額）');
});

const { applyBankStatement: applyBankE2E, previewBankStatement: previewBankE2E } =
  await import('../lib/services/bank-import.js');

test('端到端（正式入口）｜讀不到現值參考日：走 applyBankStatement，交易真的落庫、餘額一動不動', async () => {
  // ⚠️ 上一版那題叫「端到端」卻只直接呼叫 applyBalancesToDb／importBankTxToDb——**沒經過正式入口**。
  //    複審在 `applyBankStatement` 裡重新加一行「缺日期就整份拒絕」，171 題照樣全綠（r2#1）。
  //    這一版走真的入口、真的存檔、**再重讀資料庫**驗結果，那條路才被守住。
  const seed = await getDb();
  seed.accounts = [{ id: 'e2e1', name: '台新活存', type: 'cash', bank: '台新', currency: 'TWD',
    accountNo: '900100****3301', balance: 111, balanceAsOf: '2026-05-31' }];
  seed.transactions = [];
  await saveDb(seed);

  // 模板路線的解析器接縫（第三參數）：回一份**沒有現值參考日**、但餘額鏈自洽的帳單
  const parseNoRef = async () => ({ bank: '台新', referenceDate: null,
    accounts: [{ suffix: '3301', masked: '900100****3301', balance: 999, currency: 'TWD', label: '活存', note: '' }],
    accountCurrency: { '900100****3301': 'TWD' },
    transactions: [
      btx({ date: '2026-06-05', summary: '提款', direction: 'out', amount: 400, balance: 600 }),
      btx({ date: '2026-06-08', summary: '轉帳存入', direction: 'in', amount: 100, balance: 700 }),
    ] });

  const pv = await previewBankE2E('QUFBQQ==', undefined, parseNoRef);
  assert.equal(pv.blocked, true, '預覽要標明「這次不會更新餘額」');

  const res = await applyBankE2E('QUFBQQ==', undefined, parseNoRef);
  assert.equal(res.ok, true, '★正式入口不可再整份拒絕——那正是使用者被卡住的原因');
  assert.equal(res.balancesSkipped, true, '★回應要帶出「餘額沒更新」給畫面用');
  assert.equal(res.transactions.imported, 2, '★交易要真的匯入');

  const after = await getDb();   // ⚠️ 重讀資料庫：只看回傳值證明不了「真的存進去了」
  assert.equal(after.transactions.length, 2, '★交易要真的落庫');
  assert.equal(after.accounts.length, 1, '★不可新建帳戶（新建＝寫進一個不知道時點的餘額）');
  assert.equal(after.accounts[0].balance, 111, '★餘額一動都不可以動');
  assert.equal(after.accounts[0].balanceAsOf, '2026-05-31', '★時點也不可以動');
});

