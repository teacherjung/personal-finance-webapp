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

test('餘額更新｜沒有現值參考日 → 400（不敢亂更新）', () => {
  assert.throws(() => applyBalancesToDb({ accounts: [] }, parsed(null, [acc('3301', 'TWD', 23)])),
    (/** @type {any} */ e) => e.status === 400);
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

test('餘額更新｜壞的現值參考日（2026/13/45）→ 400，不寫進 balanceAsOf 撞櫃檯 500', () => {
  assert.throws(() => applyBalancesToDb({ accounts: [] }, parsed('2026-13-45', [accM('x****3301', 'TWD', 23)])),
    (/** @type {any} */ e) => e.status === 400);
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
