// @ts-check
// 台新簽帳金融卡明細的 A 區「刷卡消費明細」（2026-08-22）。
// 這一區是 D 區「刷卡消費／刷卡退貨」那幾筆的**另一種印法**：多了消費日、店名、消費地區＝「買了什麼」。
// 這兩個函式的責任只有「讀出來、對到 D 區的列」；它們**不決定怎麼入帳**（同一筆錢兩區都出現，怎麼不算兩次＝未決的產品裁決）。
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

test('★A 區｜相鄰兩筆照真版面的列距（13~17）：店名與地區照版面順序各歸各的，不可互相污染', () => {
  // Codex #501 r1#1：半徑內「全收」會讓第一筆的地區吃到第二筆的店名。真版面主列相距 13~17，上一筆的地區（-4）與
  // 下一筆的店名（+5）中間只隔 4~8，兩者都落在另一筆的半徑 10 內——靠版面順序（主列之後緊接的第一片＝地區、
  // 其餘＝下一筆的店名）才分得開；比距離在換行店名時仍會搶錯（題名含「換行店名」那題）。
  for (const pitch of [13, 14, 15, 16, 17]) {
    const lines = [A_HEAD(), CARD(244, '8808'),
      ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'),
      ...purchase(227 - pitch, '2026/01/26', '2026/01/25', '乙店', '200'),
      ...purchase(227 - 2 * pitch, '2026/01/24', '2026/01/23', '丙店', '300'),
      EXIT,
    ];
    const { rows } = parseTaishinDebitCardRows(lines);
    assert.deepEqual(rows.map((r) => [r.desc, r.region]), [['甲店', 'TW'], ['乙店', 'TW'], ['丙店', 'TW']], `★列距 ${pitch}：店名與地區各歸各的`);
  }
});

test('★A 區｜換行店名（主列上 10 與 5）緊接在前一筆的地區之後：照版面順序歸位，前一筆不可把它搶走', () => {
  // Codex #501 r2#1：比距離時，後筆的第一行店名（主列上 10）離前一筆的地區只差幾個單位、會被前筆當成地區。
  // 換行店名的那一筆區塊較高，列距至少要容得下四列文字（店名兩行＋主列＋地區）：前筆地區 223、後筆店名從 219 起。
  const lines = [A_HEAD(), CARD(244, '8808'),
    ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'),                       // 店名 232、主列 227、地區 223
    L(219, [[208, '乙店很長', 65]]), L(214, [[208, '第二行 /', 40]]),                   // 後筆店名兩行
    L(209, [[126, '2026/01/26 2026/01/25', 77], [423, '0', 4], [457, '200', 12]]),    // 後筆主列
    L(205, [[235, 'TW', 11]]),
    EXIT,
  ];
  const { rows } = parseTaishinDebitCardRows(lines);
  assert.deepEqual(rows.map((r) => [r.desc, r.region]), [['甲店', 'TW'], ['乙店很長 第二行', 'TW']], '★前筆的地區只有 TW、後筆的店名兩行都在');
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
  // D 表頭被抽字拆成兩列（同 Stage 3 認得的形狀）：碎片那一列就是離場錨點，後面的列不可再被當 A 區收
  const splitHead = [A_HEAD(), CARD(244, '8808'), ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'),
    L(50, [[143, '日期', 13], [191, '摘要', 13], [239, '支出', 13]]),
    L(46, [[291, '存入', 13], [342, '餘額', 13], [415, '備註', 13]]),
    L(40, [[126, '2026/01/05 2026/01/04', 77], [423, '0', 4], [457, '888', 12]]),
  ];
  assert.deepEqual(parseTaishinDebitCardRows(splitHead).rows.map((r) => r.amount), [100], '★拆成兩列的 D 表頭也是離場錨點（Codex #501 r1#4）');
});

test('A 區｜地區只認主列之後緊接、夠近的那一片：隔太遠的孤片不可當地區；落在店名欄的「日期 日期」字樣是店名、不是主列', () => {
  const lines = [A_HEAD(), CARD(244, '8808'),
    L(232, [[208, '甲店 /', 65]]),
    L(227, [[126, '2026/01/28 2026/01/27', 77], [423, '0', 4], [457, '100', 12]]),
    L(205, [[235, 'XX', 11]]),                                                          // 距主列 22＝不是這一筆的地區
    L(192, [[208, '2026/01/20 2026/01/19', 60]]),                                      // 店名欄裡長得像兩個日期＝店名文字（例如票券效期），不是主列
    L(187, [[126, '2026/01/26 2026/01/25', 77], [423, '0', 4], [457, '200', 12]]),
    L(183, [[235, 'TW', 11]]),
    EXIT,
  ];
  const { rows } = parseTaishinDebitCardRows(lines);
  assert.deepEqual(rows.map((r) => [r.amount, r.desc, r.region]), [[100, '甲店', ''], [200, '2026/01/20 2026/01/19', 'TW']],
    '★第一筆地區留空（孤片太遠）；第二筆的店名是那串日期字樣、且不可多出第三筆');
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

test('★A 區｜抄不對就說（一律 bank_unrecognized、不靜靜跳過）：假日曆日、日期長得像卻讀不成、金額不是數字', () => {
  const bad = (/** @type {any} */ main) => [A_HEAD(), CARD(244, '8808'), L(232, [[208, '甲店 /', 65]]), main, EXIT];
  const unrecog = (/** @type {RegExp} */ re) => (/** @type {any} */ e) => e.code === 'bank_unrecognized' && re.test(e.message);
  assert.throws(() => parseTaishinDebitCardRows(bad(L(227, [[126, '2026/02/31 2026/01/27', 77], [423, '0', 4], [457, '100', 12]]))), unrecog(/真日曆日/));
  assert.throws(() => parseTaishinDebitCardRows(bad(L(227, [[126, '2026/01/28 2026/01/27', 77], [423, '0', 4], [457, 'N/A', 12]]))), unrecog(/台幣金額/));
  // ★以日期起頭卻讀不成兩個日期（Codex #501 r1#2：以前會被當成說明列靜靜跳過＝整筆消失、下一筆照收）
  assert.throws(() => parseTaishinDebitCardRows(bad(L(227, [[126, '2026/01/2X 2026/01/27', 77], [423, '0', 4], [457, '100', 12]]))), unrecog(/讀不成「扣款日 消費日」/));
  assert.throws(() => parseTaishinDebitCardRows(bad(L(227, [[126, '2026/01/28', 37], [423, '0', 4], [457, '100', 12]]))), unrecog(/讀不成「扣款日 消費日」/), '只有一個日期');
  // ★金額欄整格缺失：剩下的那一格是服務費，不可被當成金額（Codex #501 r2#2）
  assert.throws(() => parseTaishinDebitCardRows(bad(L(227, [[126, '2026/01/28 2026/01/27', 77], [423, '0', 4]]))), unrecog(/台幣金額/), '缺金額格');
  assert.throws(() => parseTaishinDebitCardRows(bad(L(227, [[126, '2026/01/28 2026/01/27', 77], [240, '0', 4], [260, '100', 12]]))), unrecog(/台幣金額/), '金額格落在左邊的欄＝不是台幣金額');
  // 日期拆成兩格＝抽字的正常變體，要收——但第二格要落在日期欄（Codex #501 r2#3：落在外幣折換日欄的日期是別的日期）
  const split = parseTaishinDebitCardRows(bad(L(227, [[126, '2026/01/28', 37], [170, '2026/01/27', 37], [423, '0', 4], [457, '100', 12]])));
  assert.deepEqual([split.rows[0].postDate, split.rows[0].date, split.rows[0].amount, split.rows[0].fee], ['2026-01-28', '2026-01-27', 100, 0]);
  assert.throws(() => parseTaishinDebitCardRows(bad(L(227, [[126, '2026/01/28', 37], [281, '2026/01/27', 37], [423, '0', 4], [457, '100', 12]]))), unrecog(/讀不成「扣款日 消費日」/), '★第二個日期落在外幣折換日欄＝不是消費日');
  // 年份起頭的說明句（不在日期欄、也不是日期形狀）＝不是主列候選，不可整份丟錯（Codex #501 r2#4）
  const note = parseTaishinDebitCardRows([A_HEAD(), CARD(244, '8808'), L(236, [[137, '2026/年度消費說明', 120]]), ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'), EXIT]);
  assert.equal(note.rows.length, 1);
  // 沒有表頭＝沒有 A 區（不是錯，就是讀不到）
  assert.deepEqual(parseTaishinDebitCardRows([EXIT]), { rows: [], sawHeader: false });
});

test('★A 區｜卡號：還沒看到「卡號末四碼」就出現消費列＝丟錯；看到「卡號末四碼」卻讀不出四碼＝丟錯（不可沿用上一張）', () => {
  const unrecog = (/** @type {RegExp} */ re) => (/** @type {any} */ e) => e.code === 'bank_unrecognized' && re.test(e.message);
  assert.throws(() => parseTaishinDebitCardRows([A_HEAD(), ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'), EXIT]), unrecog(/還沒看到「卡號末四碼」/));
  assert.throws(() => parseTaishinDebitCardRows([A_HEAD(), CARD(244, '8808'), ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'),
    L(200, [[269, '卡號末四碼：12X4', 56]]), ...purchase(180, '2026/01/20', '2026/01/19', '乙店', '200'), EXIT]), unrecog(/讀不出四碼/), '★第二張讀不出＝不可把乙店掛到 8808');
});

test('A 區｜表頭少了定位用的欄名（消費明細／外幣折換日）＝不進 A 區，免拿錯的 x 帶亂歸店名', () => {
  const badHead = L(269, [[135, '扣款日', 20], [175, '消費日', 20], [330, '幣別', 13]]);
  const lines = [badHead, CARD(244, '8808'), ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '100'), EXIT];
  assert.deepEqual(parseTaishinDebitCardRows(lines), { rows: [], sawHeader: false });
});

test('★parseTaishinDebit 的輸出帶 cardRows（A 區讀出的筆）：這是 bank-import 記卡片帳本的唯一來源', async () => {
  const { parseTaishinDebit } = await import('../lib/bank-statement.js');
  const lines = [
    L(700, [[137, '感謝您使用本行簽帳金融卡消費(存款帳號**********1234) ，對帳單期間內之消費明細提供您核對。', 293]]),
    L(690, [[137, '對帳單期間：2026/01/01 ~ 2026/01/31', 123]]),
    A_HEAD(), CARD(244, '8808'), ...purchase(227, '2026/01/28', '2026/01/27', '甲店', '305'),
    L(120, [[143, '日期', 13], [191, '摘要', 13], [239, '支出', 13], [291, '存入', 13], [342, '餘額', 13], [415, '備註', 13]]),
    L(110, [[131, '2026/01/28', 37], [185, '刷卡消費', 27], [251, '305', 17], [312, '0', 11], [346, '9,695', 25], [390, '甲店', 61]]),
  ];
  const r = parseTaishinDebit(lines);
  assert.equal(r.transactions.length, 1);
  assert.deepEqual(r.cardRows.map((c) => [c.date, c.desc, c.amount, c.lastFour]), [['2026-01-27', '甲店', 305, '8808']], '★A 區的筆要一起交出去');
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
  assert.deepEqual(r.pairs, [
    { card: 0, tx: 1, ambiguous: true }, { card: 1, tx: 2, ambiguous: true },   // ★同日同額兩筆＝只能說「這一群對得上」，哪一筆對哪一筆不可當真
    { card: 2, tx: 3, ambiguous: false }, { card: 3, tx: 4, ambiguous: false },
  ]);
  assert.deepEqual(r.unmatchedCards, []);
  assert.deepEqual(r.unmatchedTxs, []);
  assert.deepEqual(DEBIT_CARD_SUMMARIES, ['刷卡消費', '刷卡退貨']);
});

test('★對照｜同鍵多筆的歧義要標出來：群組不等長時配上的那一對也是 ambiguous（A 多或 D 多都算）', () => {
  const r = linkDebitCardRows([card({}), card({ desc: '乙店' })], [tx({ amount: 100 })]);
  assert.deepEqual(r.pairs, [{ card: 0, tx: 0, ambiguous: true }]);
  assert.deepEqual(r.unmatchedCards, [1]);
  const r2 = linkDebitCardRows([card({})], [tx({ amount: 100 }), tx({ amount: 100 })]);
  assert.deepEqual(r2.pairs, [{ card: 0, tx: 0, ambiguous: true }], '★D 區那邊有兩筆同鍵＝哪一筆對上也不可當真');
  assert.deepEqual(r2.unmatchedTxs, [1]);
});

test('★對照｜對不上的兩邊都要列出來（不可靜靜丟掉）：A 多一筆、D 多一筆', () => {
  const txs = [tx({ amount: 100 }), tx({ amount: 50, date: '2026-01-20' })];
  const cards = [card({}), card({ amount: 70, postDate: '2026-01-21' })];
  const r = linkDebitCardRows(cards, txs);
  assert.deepEqual(r.pairs, [{ card: 0, tx: 0, ambiguous: false }]);
  assert.deepEqual(r.unmatchedCards, [1]);
  assert.deepEqual(r.unmatchedTxs, [1]);
});

test('對照｜方向要對：金額相同但 A 是退款、D 是消費＝不配', () => {
  const r = linkDebitCardRows([card({ amount: -100 })], [tx({ amount: 100 })]);
  assert.deepEqual(r.pairs, []);
  assert.deepEqual(r.unmatchedCards, [0]);
  assert.deepEqual(r.unmatchedTxs, [0]);
});
