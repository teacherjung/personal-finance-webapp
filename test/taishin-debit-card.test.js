// @ts-check
// 台新簽帳金融卡明細的 A 區「刷卡消費明細」（Stage 5a，2026-08-22）。
// 這一區是 D 區「刷卡消費／刷卡退貨」那幾筆的**另一種印法**：多了消費日、店名、消費地區＝「買了什麼」。
// 本支只讀出來、對到 D 區的列，**不決定怎麼入帳**（同一筆錢兩區都出現，怎麼不算兩次是下一支的裁決）。
// ⚠️ 合成座標列（同 taishin-debit.test.js 家規）：店名、金額、卡號全是編的；座標照真版面。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseTaishinDebitCardRows, linkDebitCardRows, DEBIT_CARD_SUMMARIES } = await import('../lib/bank-statement.js');

/** @param {number} y @param {[number,string,number?][]} cells */
const L = (y, cells) => ({ y, cells: cells.map(([x, s, w]) => ({ x, s, w: w ?? 20 })) });

/** A 區表頭（真版面 x：扣款日135／消費日175／消費明細210／外幣折換日281／幣別330／外幣金額358／國外交易服392）。 */
const A_HEAD = (/** @type {number} */ y = 269) => L(y, [[135, '扣款日', 20], [175, '消費日', 20], [210, '消費明細 / 消費地區', 60], [281, '外幣折換日', 34], [330, '幣別', 13], [358, '外幣金額', 27], [392, '國外交易服', 34]]);
const CARD = (/** @type {number} */ y, /** @type {string} */ four) => L(y, [[269, `卡號末四碼：${four}`, 56]]);
/** 一筆＝三列：店名（y+5）、主列（扣款日 消費日｜服務費｜台幣金額，右緣 469）、地區（y-4）。 */
const purchase = (/** @type {number} */ y, /** @type {string} */ post, /** @type {string} */ date, /** @type {string} */ shop, /** @type {string} */ amt, /** @type {string} */ region = 'TW') => [
  L(y + 5, [[208, `${shop} /`, 65]]),
  L(y, [[126, `${post} ${date}`, 77], [423, '0', 4], [469 - amt.length * 4, amt, amt.length * 4]]),
  L(y - 4, [[235, region, 11]]),
];
const EXIT = L(80, [[370, '本月消費金額共計', 58], [430, 'NT$ 1,234', 41]]);

test('A 區｜三筆（含退款負數、店名換行）：扣款日／消費日／金額／店名／地區／卡號全部讀對', () => {
  const lines = [
    A_HEAD(), CARD(244, '8808'),
    ...purchase(227, '2026/01/28', '2026/01/27', '合成商店Ａ', '-305'),
    ...purchase(206, '2026/01/26', '2026/01/25', '合成商店Ｂ', '1,234'),
    // 店名換行：兩列都在「消費明細」x 帶裡、都在主列上方 10 以內
    // 店名換行＝這一筆的列距拉大（兩行店名都在主列上方 10 以內；第一行在上、分隔用的「/」印在最後一行）
    L(186, [[208, '合成很長的店名', 65]]), L(181, [[208, '第二行 /', 40]]),
    L(176, [[126, '2026/01/24 2026/01/23', 77], [423, '0', 4], [457, '999', 12]]),
    L(172, [[235, 'TW', 11]]),
    EXIT,
  ];
  const { rows, sawHeader } = parseTaishinDebitCardRows(lines);
  assert.equal(sawHeader, true);
  assert.deepEqual(rows.map((r) => [r.postDate, r.date, r.amount, r.fee, r.lastFour, r.desc, r.region, r.extra]), [
    ['2026-01-28', '2026-01-27', -305, 0, '8808', '合成商店Ａ', 'TW', ''],
    ['2026-01-26', '2026-01-25', 1234, 0, '8808', '合成商店Ｂ', 'TW', ''],
    ['2026-01-24', '2026-01-23', 999, 0, '8808', '合成很長的店名 第二行', 'TW', ''],
  ], '★退款負號保留；店名尾端的「/」剝掉；換行店名由上而下接起來');
});

test('A 區｜多張卡：第二個「卡號末四碼」之後的筆換卡；跨頁重印表頭不中斷', () => {
  const lines = [
    A_HEAD(), CARD(244, '8808'),
    ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'),
    A_HEAD(150),   // 第二頁重印表頭
    CARD(130, '1234'),
    ...purchase(110, '2026/01/20', '2026/01/19', '乙店', '200'),
    EXIT,
  ];
  const { rows } = parseTaishinDebitCardRows(lines);
  assert.deepEqual(rows.map((r) => [r.lastFour, r.desc, r.amount]), [['8808', '甲店', 100], ['1234', '乙店', 200]]);
});

test('★A 區｜只收表頭之後、離場錨點之前：B 區總額列、C 區、D 區的列一筆都不可變成刷卡', () => {
  const lines = [
    // 表頭之前的日期列（不可收）
    L(300, [[126, '2026/01/30 2026/01/29', 77], [423, '0', 4], [457, '555', 12]]),
    A_HEAD(), CARD(244, '8808'),
    ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'),
    EXIT,
    // B／C／D 區的列（已離場）
    L(70, [[158, '消費支出類別', 40], [277, '台幣金額', 27]]),
    L(60, [[126, '2026/01/10 2026/01/09', 77], [423, '0', 4], [457, '777', 12]]),
    L(50, [[143, '日期', 13], [191, '摘要', 13], [239, '支出', 13], [291, '存入', 13], [342, '餘額', 13], [415, '備註', 13]]),
    L(40, [[126, '2026/01/05 2026/01/04', 77], [423, '0', 4], [457, '888', 12]]),
  ];
  const { rows } = parseTaishinDebitCardRows(lines);
  assert.deepEqual(rows.map((r) => r.amount), [100], '★只有表頭之後、離場之前那一筆');
  // D 區表頭**直接**接在 A 區後面（沒有 B／C 區的版面）：D 的列同樣不可被收（D 列有自己的日期格式，
  // 但一列「2026/01/05 2026/01/04」長相的備註也要擋得住＝靠 D 表頭離場）
  const direct = [A_HEAD(), CARD(244, '8808'), ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'),
    L(50, [[143, '日期', 13], [191, '摘要', 13], [239, '支出', 13], [291, '存入', 13], [342, '餘額', 13], [415, '備註', 13]]),
    L(40, [[126, '2026/01/05 2026/01/04', 77], [423, '0', 4], [457, '888', 12]]),
  ];
  assert.deepEqual(parseTaishinDebitCardRows(direct).rows.map((r) => r.amount), [100], '★D 表頭本身就是離場錨點');
});

test('A 區｜店名只認「消費明細」x 帶裡、y 距離 ≤ 上限的片段：別欄的字與隔太遠的列不可黏進店名', () => {
  const lines = [
    A_HEAD(), L(263, [[446, '額', 7]]), L(258, [[403, '務費', 13]]),   // 表頭殘片（別欄）
    CARD(244, '8808'),
    L(245, [[208, '隔太遠的字 /', 65]]),                                 // 距主列 18＝不是這一筆的
    L(232, [[208, '甲店 /', 65]]), L(231, [[330, 'USD', 13]]),           // 同高度但落在幣別欄＝不收
    L(227, [[126, '2026/01/28 2026/01/27', 77], [423, '0', 4], [457, '100', 12]]),
    L(223, [[235, 'TW', 11]]),
    EXIT,
  ];
  const { rows } = parseTaishinDebitCardRows(lines);
  assert.equal(rows[0].desc, '甲店');
  assert.equal(rows[0].region, 'TW');
});

test('★A 區｜外幣列（主列多於一格在中間）：台幣金額仍取最右、其餘原文收進 extra、fee 不猜', () => {
  const lines = [
    A_HEAD(), CARD(244, '8808'),
    L(232, [[208, '海外店 /', 65]]),
    L(227, [[126, '2026/01/28 2026/01/27', 77], [281, '2026/01/28', 37], [330, 'USD', 13], [358, '10.00', 20], [423, '5', 4], [457, '325', 12]]),
    L(223, [[235, 'US', 11]]),
    EXIT,
  ];
  const { rows } = parseTaishinDebitCardRows(lines);
  assert.equal(rows[0].amount, 325);
  assert.equal(rows[0].fee, null, '★多格時不猜哪一格是服務費');
  assert.equal(rows[0].extra, '2026/01/28 USD 10.00 5');
});

test('★A 區｜讀不出＝丟 bank_unrecognized（假日期、金額不是數字），不可靜靜跳過', () => {
  const bad = (/** @type {any} */ main) => [A_HEAD(), CARD(244, '8808'), L(232, [[208, '甲店 /', 65]]), main, EXIT];
  assert.throws(() => parseTaishinDebitCardRows(bad(L(227, [[126, '2026/02/31 2026/01/27', 77], [423, '0', 4], [457, '100', 12]]))),
    (/** @type {any} */ e) => e.code === 'bank_unrecognized' && /真日曆日/.test(e.message));
  assert.throws(() => parseTaishinDebitCardRows(bad(L(227, [[126, '2026/01/28 2026/01/27', 77], [423, '0', 4], [457, 'N/A', 12]]))),
    (/** @type {any} */ e) => e.code === 'bank_unrecognized' && /台幣金額/.test(e.message));
  // 沒有表頭＝沒有 A 區（不是錯，就是讀不到）
  assert.deepEqual(parseTaishinDebitCardRows([EXIT]), { rows: [], sawHeader: false });
});

test('A 區｜表頭少了定位用的欄名（消費明細／外幣折換日）＝不進 A 區，免拿錯的 x 帶亂歸店名', () => {
  const badHead = L(269, [[135, '扣款日', 20], [175, '消費日', 20], [330, '幣別', 13]]);
  const lines = [badHead, CARD(244, '8808'), ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'), EXIT];
  assert.deepEqual(parseTaishinDebitCardRows(lines), { rows: [], sawHeader: false });
});

// ---------- 對到 D 區 ----------
const tx = (/** @type {any} */ o) => ({ acctSuffix: '8791', acctMasked: '**********8791', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 100, balance: null, note: '', ...o });
const card = (/** @type {any} */ o) => ({ postDate: '2026-01-28', date: '2026-01-27', amount: 100, fee: 0, lastFour: '8808', desc: '甲店', region: 'TW', extra: '', ...o });

test('對照｜扣款日＋金額一對一：退款配「刷卡退貨」的進帳；同日同額多筆照順序配；非刷卡的 D 列不參與', () => {
  const txs = [
    tx({ summary: 'CD轉出', amount: 100 }),                       // 不是刷卡＝不參與（同日同額也不可被配走）
    tx({ amount: 100 }), tx({ amount: 100 }),                     // 同日同額兩筆
    tx({ summary: '刷卡退貨', direction: 'in', amount: 305 }),
    tx({ amount: 999, date: '2026-01-24' }),
  ];
  const cards = [card({}), card({ desc: '乙店' }), card({ amount: -305 }), card({ postDate: '2026-01-24', amount: 999 })];
  const r = linkDebitCardRows(cards, txs);
  assert.deepEqual(r.pairs, [{ card: 0, tx: 1 }, { card: 1, tx: 2 }, { card: 2, tx: 3 }, { card: 3, tx: 4 }]);
  assert.deepEqual(r.unmatchedCards, []);
  assert.deepEqual(r.unmatchedTxs, []);
  assert.deepEqual(DEBIT_CARD_SUMMARIES, ['刷卡消費', '刷卡退貨']);
});

test('★對照｜對不上的兩邊都要列出來（不可靜靜丟掉）：A 多一筆、D 多一筆', () => {
  const txs = [tx({ amount: 100 }), tx({ amount: 50, date: '2026-01-20' })];
  const cards = [card({}), card({ amount: 70, postDate: '2026-01-21' })];
  const r = linkDebitCardRows(cards, txs);
  assert.deepEqual(r.pairs, [{ card: 0, tx: 0 }]);
  assert.deepEqual(r.unmatchedCards, [1]);
  assert.deepEqual(r.unmatchedTxs, [1]);
});

test('對照｜方向要對：金額相同但 A 是退款、D 是消費＝不配', () => {
  const r = linkDebitCardRows([card({ amount: -100 })], [tx({ amount: 100 })]);
  assert.deepEqual(r.pairs, []);
  assert.deepEqual(r.unmatchedCards, [0]);
  assert.deepEqual(r.unmatchedTxs, [0]);
});
