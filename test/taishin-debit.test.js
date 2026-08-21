// @ts-check
// 台新「簽帳金融卡消費明細」內建範本的考題（2026-08-20）。
//
// 為什麼要有這支範本：這個版面原本內建範本認不得 ⇒ 每次上傳都落到 AI（花錢＋機率性）。
// 真帳單唯讀試算證明固定規則就讀得完美，所以做成確定性解析。
//
// ⚠️ **本檔一律用合成座標列**（同 bank-statement.test.js 的家規）：不放任何真實帳單內容，
//    金額、店名、帳號全是編的；座標則照真版面的欄位位置（金額右對齊是這個版面的既有特性）。
//
// 這支範本最要命的風險＝**同一筆錢被算兩次**：帳單前面還印著「刷卡消費明細」與
// 「已消費未扣款」兩區，它們的列同樣以日期起頭。所以「只收表頭之後那一區」是硬界線，
// 守它的是題名含「錢不可被算兩次」與「離場錨點」的那兩題。
// ⚠️ 那兩題的陷阱列**刻意用與明細列相同的欄位座標**：若陷阱列本來就解析不成交易，
//    考題就是在驗幾何巧合、不是在驗守門（Codex #492 r1 實測：拿掉守門仍全綠）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isTaishinDebitStatement, parseTaishinDebit, parseTaishinDebitDetail } = await import('../lib/bank-statement.js');
const { reconcileBankStatement } = await import('../lib/statement-reconcile.js');
const { previewBalancesForDb, applyBalancesToDb } = await import('../lib/services/bank-import.js');   // 走正式的帳戶比對，不重抄判準

/** 合成一列。`[x, 文字, 寬度]`——寬度會影響欄位判定（值取右緣），所以要照真版面給。
 * @param {number} y @param {[number,string,number?][]} cells */
const L = (y, cells) => ({ y, cells: cells.map(([x, s, w]) => ({ x, s, w: w ?? 20 })) });

/** 明細表頭（六欄到齊＝區段界線）。真版面的 x：日期143／摘要191／支出239／存入291／餘額342／備註415 */
const HEAD = L(400, [[143, '日期', 13], [191, '摘要', 13], [239, '支出', 13], [291, '存入', 13], [342, '餘額', 13], [415, '備註', 13]]);

/** 合成一列明細（支出與存入照真版面右對齊；餘額右緣 371、備註從 390 起）。 */
const row = (y, date, summary, out, inn, bal, note) => L(y, [
  [131, date, 37], [185, summary, 27],
  [251, out, 17], [312, inn, 11], [346, bal, 25],
  ...(note ? /** @type {[number,string,number][]} */ ([[390, note, 61]]) : []),
]);

/** 抬頭三列（機構識別＋帳號＋期間）。 */
const headerLines = () => [
  L(700, [[137, '感謝您使用本行簽帳金融卡消費(存款帳號**********1234) ，對帳單期間內之消費明細提供您核對。', 293]]),
  L(690, [[137, '對帳單期間：2026/01/01 ~ 2026/01/31', 123]]),
];

/** ⚠️ 表頭**之前**的三個區塊——它們的列也以日期起頭，全部都不可以變成交易。 */
const trapLines = () => [
  // A 刷卡消費明細（同一筆錢的另一種印法）。⚠️ **刻意用與明細列相同的座標**：
  //    只有「表頭之前不收」那道守門擋得住它——拿掉守門，這一列就會變成一筆 305 元支出。
  L(600, [[131, '2026/01/28', 37], [185, '刷卡消費', 27], [251, '305', 17], [312, '0', 11], [346, '318,186', 25], [390, 'APPLE.COM/BILL', 61]]),
  // B 本月總額與類別表
  L(560, [[370, '本月消費金額共計', 58], [430, 'NT$ 45,809', 41]]),
  L(550, [[373, '本月退款金額共計', 58], [433, 'NT$ -9,614', 40]]),
  L(540, [[158, '消費支出類別', 40], [277, '台幣金額', 27], [395, '百分比(%)', 31]]),
  L(530, [[165, '百貨超市', 27], [280, '43,638', 21], [401, '95.26', 17]]),
  L(520, [[168, '總金額', 20], [280, '45,809', 21], [404, '100', 12]]),
  // C 已消費未扣款（還沒從帳戶扣錢）。同樣用明細列的座標＝守門是唯一擋得住它的東西。
  L(510, [[168, '消費日', 20], [262, '原始交易幣別', 40], [380, '交易金額(台幣)', 45]]),
  L(500, [[131, '2026/01/27', 37], [185, '刷卡消費', 27], [251, '500', 17], [312, '0', 11], [346, '317,686', 25]]),
];

/** 一份完整的合成帳單（抬頭＋三個陷阱區＋明細四列）。 */
const wholeStatement = () => [
  ...headerLines(), ...trapLines(), HEAD,
  row(390, '2026/01/02', 'CD轉出', '2,884', '0', '318,491', '王先生'),
  row(380, '2026/01/12', 'CD提款', '1,000', '0', '317,491 822CCA4B27 202601122510'),
  row(370, '2026/01/26', '轉帳存入', '0', '100,000', '417,491'),
  row(360, '2026/01/30', '存款息', '0', '9', '417,500'),
];

test('版面辨識｜三個特徵都要在才算數；綜合對帳單不可被誤認成金融卡明細', () => {
  assert.equal(isTaishinDebitStatement(wholeStatement()), true);
  // 綜合對帳單（既有版面）：有帳戶概要區、沒有「簽帳金融卡」與六欄表頭
  const combined = [
    L(700, [[47, '新臺幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L(690, [[78, '帳號類別'], [163, '帳戶號碼'], [433, '帳戶餘額']]),
  ];
  assert.equal(isTaishinDebitStatement(combined), false, '★不可搶走綜合對帳單那條路');
  // 只有「簽帳金融卡」四個字、沒有明細表頭＝不是這個版面（例如純宣導信）
  assert.equal(isTaishinDebitStatement([...headerLines()]), false, '★缺六欄表頭＝不算（沒有明細可讀）');
  // 三個條件**逐條**各一題（Codex #492 r1 實測：原本少了這一條，把「對帳單期間」從判準拿掉全綠）。
  // ⚠️ 每一題只能少**那一個**條件：用「濾掉含某字樣的列」會連別的條件一起濾掉
  //    （抬頭那句同時含「簽帳金融卡」與「對帳單期間」），那樣就變成在測另一個條件＝又一顆空包彈。
  const onlyMissingPeriod = [
    L(700, [[137, '感謝您使用本行簽帳金融卡消費(存款帳號**********1234)', 293]]),   // 保留「簽帳金融卡」
    HEAD, row(390, '2026/01/02', 'CD轉出', '2,884', '0', '318,491'),                  // 保留六欄表頭
  ];
  assert.equal(isTaishinDebitStatement(onlyMissingPeriod), false, '★只缺「對帳單期間」就不算');
  const noDebitWord = wholeStatement().map((l) => ({ y: l.y, cells: l.cells.map((c) => ({ ...c, s: c.s.replace(/簽帳金融卡/g, '') })) }));
  assert.equal(isTaishinDebitStatement(noDebitWord), false, '★缺「簽帳金融卡」＝不算（信用卡帳單也有「消費明細」四個字）');
});

test('★錢不可被算兩次｜表頭之前的「刷卡消費明細」與「已消費未扣款」都不得變成交易', () => {
  // 承重機制（r2#2 驗過「這題自己紅、不靠別題代為報警」）：拿掉「表頭之前不收」的守門時，
  // 陷阱列會在**欄界還是 0** 的狀態下被解析 ⇒ 支出/存入格找不到 ⇒「讀不到不可折疊成 0」
  // 那道會 throw ⇒ 本題在第一行就爆。單跑 --test-name-pattern="錢不可被算兩次" 實測轉紅。
  const p = parseTaishinDebit(wholeStatement());
  assert.equal(p.transactions.length, 4, '★只有明細那一區的四列（陷阱區各有一列以日期起頭）');
  const dates = p.transactions.map((t) => t.date);
  assert.ok(!dates.includes('2026-01-28'), '★A 區（刷卡消費明細 2026/01/28）不可入帳——它是明細裡刷卡消費那幾列的另一種印法');
  assert.ok(!dates.includes('2026-01-27'), '★C 區（已消費未扣款 2026/01/27）不可入帳——那筆錢還沒從帳戶扣走');
  assert.ok(!p.transactions.some((t) => t.amount === 305 || t.amount === 500),
    '★連金額都不可出現（兩個陷阱列用的是與明細列相同的座標，拿掉「表頭之前不收」就會被收進來）');
  // B 區的「總金額 45,809」不是日期起頭，但仍釘住它沒有混進金額
  assert.ok(!p.transactions.some((t) => t.amount === 45809), '★總額列不可變成一筆交易');
});

test('明細｜方向由支出/存入哪一欄有數字決定；餘額格黏著備註要拆開（真檔就是這樣印的）', () => {
  const p = parseTaishinDebit(wholeStatement());
  const [t1, t2, t3, t4] = p.transactions;
  assert.deepEqual({ d: t1.direction, a: t1.amount, b: t1.balance, s: t1.summary, n: t1.note },
    { d: 'out', a: 2884, b: 318491, s: 'CD轉出', n: '王先生' });
  assert.deepEqual({ d: t3.direction, a: t3.amount, b: t3.balance, s: t3.summary },
    { d: 'in', a: 100000, b: 417491, s: '轉帳存入' });
  assert.equal(t4.direction, 'in', '存入 9 元＝收入方向（小額不可被當成支出）');
  // ★餘額格 `317,491 822CCA4B27 202601122510`：數字進餘額、剩下的字進備註
  assert.equal(t2.balance, 317491, '★黏著備註的餘額要拆得出數字（真檔實測「餘額鏈接不上」的唯一原因）');
  assert.match(t2.note, /822CCA4B27/, '★拆下來的字不可丟掉（它是這筆的辨識資訊）');
});

test('★Stage 1｜帳戶三情境（William 2026-08-20 拍板）：先金融卡建戶帶標記→綜合對帳單認出同顆並補登帳號', () => {
  const p = parseTaishinDebit(wholeStatement());
  assert.equal(p.bank, '台新', '★機構名要逐字「台新」——去重鍵靠它走既有格式，寫別的字舊資料就認不得了');
  assert.equal(p.accounts.length, 1, '★這個版面要產帳戶（Stage 1 取代 #492 的「不建戶」裁決）');
  const pa = p.accounts[0];
  assert.deepEqual(
    { masked: pa.masked, suffix: pa.suffix, balance: pa.balance, currency: pa.currency, suffixOnly: pa.suffixOnly, fromDetail: pa.balanceFromDetail },
    { masked: '**********1234', suffix: '1234', balance: 417500, currency: 'TWD', suffixOnly: true, fromDetail: true },
    '★帳號照抄原樣＋兩個旗標：suffixOnly（走唯一命中寬鬆徑）、balanceFromDetail（對帳閘不拿它自證）');
  assert.deepEqual(p.accountCurrency, { '**********1234': 'TWD' });
  for (const t of p.transactions) assert.equal(t.acctMasked, '**********1234', '每一筆都要掛上帳號（去重鍵要用）');

  // 情境①：先匯金融卡＝建戶（帳號只有末四碼、蓋 accountNoSuffixOnly 標記）
  const db = { accounts: [] };
  const r1 = applyBalancesToDb(db, p);
  assert.equal(r1.created, 1, '①建一顆戶');
  const acct = db.accounts[0];
  assert.equal(acct.accountNo, '**********1234');
  assert.equal(acct.accountNoSuffixOnly, true, '★標記要蓋上（日後綜合對帳單憑它認親）');
  assert.equal(acct.balance, 417500);
  assert.equal(acct.balanceAsOf, '2026-01-31', '餘額時點＝對帳單期間結束日');

  // 情境②：日後匯綜合對帳單（完整遮罩 900100****1234、較新一期）＝認出同一顆、補登帳號、清掉標記
  const combo = { bank: '台新', referenceDate: '2026-02-28',
    accounts: [{ suffix: '1234', masked: '900100****1234', balance: 500000, currency: 'TWD', label: '活存', note: '' }],
    accountCurrency: { '900100****1234': 'TWD' }, transactions: [] };
  const r2 = applyBalancesToDb(db, combo);
  assert.equal(r2.updated, 1, '②同一顆＝更新、不新建');
  assert.equal(db.accounts.length, 1, '★不裂戶（#492 當初不建戶就是怕這個——Stage 1 用標記＋補登解掉）');
  assert.equal(acct.accountNo, '900100****1234', '★帳號補登成完整遮罩（只增不減）');
  assert.equal(acct.accountNoSuffixOnly, undefined, '★標記清掉（身分已完整）');
  assert.equal(acct.balance, 500000);

  // 情境③：反過來先綜合後金融卡＝末碼直接配得到、帳號**不退化**回末四碼
  const db2 = { accounts: [] };
  applyBalancesToDb(db2, combo);
  const r3 = applyBalancesToDb(db2, { ...parseTaishinDebit(wholeStatement()), referenceDate: '2026-03-31' });
  assert.equal(r3.updated, 1, '③配得到＝更新');
  assert.equal(db2.accounts.length, 1, '不裂戶');
  assert.equal(db2.accounts[0].accountNo, '900100****1234', '★帳號只增不減：金融卡帳單不可把完整帳號洗回末四碼');
  assert.equal(db2.accounts[0].accountNoSuffixOnly, undefined, '標記也不可長回來');
});

test('★Stage 1｜同末碼撞多顆＝停手（不更新、不新建、預覽照實顯示 ambiguous）', () => {
  // 金融卡帳單（只有末碼）遇到兩顆同銀行同末碼的現金戶：挑一顆＝把餘額蓋到別人頭上、
  // 新建＝第三顆戶——都比「不動」更危險（Codex #492 r1 也點過 find 取第一不安全）。
  const two = { accounts: [
    { id: 'a1', name: '甲', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '900100****1234', balance: 1 },
    { id: 'a2', name: '乙', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '900200****1234', balance: 2 },
  ] };
  const p = parseTaishinDebit(wholeStatement());
  const r = applyBalancesToDb(two, p);
  assert.equal(r.updated, 0, '★不更新');
  assert.equal(r.created, 0, '★不新建');
  assert.equal(two.accounts.length, 2, '★帳戶數不變');
  assert.equal(two.accounts[0].balance, 1); assert.equal(two.accounts[1].balance, 2);
  const pv = previewBalancesForDb(two, p);
  assert.equal(pv.rows[0].action, 'ambiguous', '★預覽照實顯示（前端翻成白話「認不出是哪一個」）');
  // 綜合對帳單版的歧義：兩顆 suffixOnly 戶同末碼＝也停手（分不出 900100 是哪一顆）
  const twoSuffix = { accounts: [
    { id: 'b1', name: '丙', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '**********1234', accountNoSuffixOnly: true, balance: 3 },
    { id: 'b2', name: '丁', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '****1234', accountNoSuffixOnly: true, balance: 4 },
  ] };
  const combo = { bank: '台新', referenceDate: '2026-02-28',
    accounts: [{ suffix: '1234', masked: '900100****1234', balance: 500, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900100****1234': 'TWD' }, transactions: [] };
  const rc = applyBalancesToDb(twoSuffix, combo);
  assert.equal(rc.updated + rc.created, 0, '★兩顆 suffixOnly 同末碼＝停手（挑錯＝補登到別人頭上）');
  assert.equal(twoSuffix.accounts[0].accountNo, '**********1234', '帳號一個都不可被動');
});

test('現值參考日｜取「對帳單期間」的結束日；沒有那一行＝null（絕不補今天）', () => {
  assert.equal(parseTaishinDebit(wholeStatement()).referenceDate, '2026-01-31');
  // ⚠️ 只濾掉「帶日期區間」那一列：抬頭那句也含「對帳單期間**內之**消費明細」五個字
  //    （真版面就是這樣印的），連它一起濾掉會把帳號也弄丟＝這題會變成在測別的東西。
  const noPeriod = wholeStatement().filter((l) => !l.cells.some((c) => /對帳單期間[:：]?\d{4}\//.test(c.s.replace(/\s/g, ''))));
  assert.equal(parseTaishinDebit(noPeriod).referenceDate, null,
    '★讀不到就 null——填錯會拿舊帳單的餘額蓋掉新的（同 applyBalancesToDb 的既有裁決）');
});

test('讀不到存款帳號＝bank_unrecognized，不可猜一個（帳號決定錢記到哪個帳戶）', () => {
  const noAcct = wholeStatement().filter((l) => !l.cells.some((c) => /存款帳號/.test(c.s)));
  assert.throws(() => parseTaishinDebit(noAcct),
    (/** @type {any} */ e) => e.code === 'bank_unrecognized' && e.status === 400,
    '★認得版面卻讀不到帳號＝照實喊認不得，讓使用者有 AI 救援那條路可走');
});

test('跨頁｜表頭重印一次不會中斷；兩欄都 0 的列跳過（沒有金流、餘額也不動）', () => {
  const lines = [...headerLines(), HEAD,
    row(390, '2026/01/02', 'CD轉出', '2,884', '0', '318,491'),
    L(385, [[143, '－ 第 2 頁 －', 40]]),
    HEAD,                                                        // 跨頁重印表頭
    row(380, '2026/01/03', '轉帳存入', '0', '500', '318,991'),
    row(375, '2026/01/04', '通知', '0', '0', '318,991'),          // 兩欄都 0
  ];
  const { transactions, skippedZero } = parseTaishinDebitDetail(lines);
  assert.equal(transactions.length, 2, '★跨頁後照樣收得到，零金額那列不收');
  assert.equal(skippedZero, 1, '★跳過幾列要數出來（誠實計數，不是靜靜丟掉）');
});

test('端到端｜合成整份過既有對帳閘：強閘、餘額鏈全接上、零未驗帳戶', () => {
  const p = parseTaishinDebit(wholeStatement());
  const g = reconcileBankStatement(p);
  assert.equal(g.level, 'strong', '★這個版面每一列都印餘額＝驗得動');
  assert.equal(g.ok, true);
  assert.equal(g.problems.length, 0);
  assert.equal(g.stats.pairsChecked, 3, '四筆＝三對');
  assert.equal(g.stats.endChecked, 0,
    '★沒有「末筆對概要」可驗——帳戶餘額就是明細末列抄來的（balanceFromDetail），硬對＝拿同一個數字對自己恆綠、'
    + '還把覆蓋計數灌水（Stage 1 起帳戶回來了，靠這個旗標讓閘誠實 skip；旗標拿掉＝這裡變 1 ⇒ 紅）');
  assert.equal(g.stats.twdAccountsUnverified, 0, '★沒有帳戶是零驗證搭便車（餘額鏈就罩得住）');
  // 反面：把中間一列的餘額改壞 ⇒ 閘要當場抓到（證明這題不是空包彈）
  const broken = parseTaishinDebit(wholeStatement());
  broken.transactions[1].balance = 999;
  const g2 = reconcileBankStatement(broken);
  assert.equal(g2.ok, false, '★餘額改壞＝閘要紅（不紅代表上面那題什麼都沒守）');
});

// ---- 以下幾題來自「送審前的多視角查證」＋真檔量測（每一題都對應一個實測過的失敗形狀）----

test('★認得版面卻收不到東西＝throw，不可靜靜匯入 0 筆回報成功（表頭被拆兩列也算）', () => {
  // 形狀一：定位得到表頭、但一列交易都沒有。
  assert.throws(() => parseTaishinDebit([...headerLines(), HEAD]),
    (/** @type {any} */ e) => e.code === 'bank_unrecognized' && /一列交易都讀不出來/.test(e.message));
  // 形狀二（Codex #492 r1#1 實測）：抽字把六欄表頭**拆成兩列**。
  //   辨識用的是整份文字 ⇒ 說「認得」；定位用的是單一列 ⇒ 找不到表頭 ⇒ 迴圈一列都沒進去。
  //   舊守衛以「有定位到表頭」為前提，正好漏掉這一種＝偵測成功、0 筆、不丟錯。
  const splitHead = [...headerLines(),
    L(400, [[143, '日期', 13], [191, '摘要', 13], [239, '支出', 13]]),
    L(396, [[291, '存入', 13], [342, '餘額', 13], [415, '備註', 13]]),
    row(390, '2026/01/02', 'CD轉出', '2,884', '0', '318,491'),
  ];
  assert.equal(isTaishinDebitStatement(splitHead), true, '★辨識仍會說認得（六個欄名在整份文字裡都在）');
  assert.throws(() => parseTaishinDebit(splitHead),
    (/** @type {any} */ e) => e.code === 'bank_unrecognized' && /定位不到/.test(e.message),
    '★所以要有第二道：認得版面卻定位不到表頭＝照實喊認不得，不可回 0 筆成功');
});

test('★支出與存入同時有數字＝方向讀不出來，照實喊認不得（不可挑一個）', () => {
  const lines = [...headerLines(), HEAD, row(390, '2026/01/02', '不明', '500', '300', '318,491')];
  assert.throws(() => parseTaishinDebit(lines),
    (/** @type {any} */ e) => e.code === 'bank_unrecognized' && /方向判不出來/.test(e.message),
    '★挑錯邊＝收入被記成支出（fail-closed 縱深：真檔沒有這種列，但不能賭）');
});

test('餘額與備註之間沒有空白＝讀不到餘額（null），不可湊出一個假數字', () => {
  // splitAmount 的數字部分是貪婪的：`317,491822CCA4B27` 會變成 317491822（憑空多三位數，
  // 還會讓餘額鏈報一個假的「不一致」去擋下正確的帳單）。
  const lines = [...headerLines(), HEAD,
    row(390, '2026/01/02', 'CD轉出', '2,884', '0', '317,491822CCA4B27'),
    row(376, '2026/01/03', 'CD轉出', '1,000', '0', '316,491'),
  ];
  const { transactions } = parseTaishinDebitDetail(lines);
  assert.equal(transactions[0].balance, null, '★分不出來就記成讀不到');
  assert.notEqual(transactions[0].balance, 317491822, '★絕不可湊出這個假數字');
  assert.match(transactions[0].note, /317,491822CCA4B27/, '整格原文留在備註（不丟資訊）');
});

test('跨行備註要黏回**y 最近**的那一筆；太遠就寧可留白', () => {
  // 座標照**真檔量到的幾何**：交易列間距 17、跨行備註的兩行間距 9，
  // 而那兩行是**夾住**自己那筆交易的（上一行在交易列上方 4、下一行在下方 5）。
  const lines = [...headerLines(), HEAD,
    row(390, '2026/01/12', '轉帳支取', '204', '0', '310,323', '0030260110003804'),
    L(377, [[381, '養育費', 30]]),        // 距 373 是 4、距 390 是 13 ⇒ 黏到下面那筆 40,000
    row(373, '2026/01/12', '轉帳支取', '40,000', '0', '270,323'),
    L(368, [[410, 'RICHA', 30]]),         // 距 373 是 5 ⇒ 同一格的第二行，也黏到 40,000
    row(200, '2026/01/13', '刷卡消費', '303', '0', '270,020'),
    L(120, [[381, '離很遠的字', 30]]),     // 距最近的交易 80 ⇒ 超過上限，不黏
  ];
  const { transactions } = parseTaishinDebitDetail(lines);
  const big = transactions.find((t) => t.amount === 40000);
  assert.ok(big, '找得到那筆 40,000');
  assert.match(String(big?.note), /養育費/, '★交易列上方那一行要黏回來（距離 4 < 距離 13）');
  assert.match(String(big?.note), /RICHA/, '★下方那一行也要黏回來（同一格的兩行夾住交易列）');
  assert.ok(!transactions.some((t) => /離很遠/.test(t.note)), '★太遠的不黏（寧留白，不亂黏到別筆）');
  const small = transactions.find((t) => t.amount === 204);
  assert.equal(small?.note, '0030260110003804', '★自己那一格的備註不可被別人的續行污染');
  // ⚠️ 這一題守的是「備註不會被丟掉」：真檔 48 筆裡有 21 段跨行備註，丟掉會讓
  //    分類與內轉判定失去依據（`classifyBankTx` 讀 note）。
});

test('★離場錨點｜「已消費未扣款」等區塊若重印在明細之後，一樣不得入帳', () => {
  const lines = [...headerLines(), HEAD,
    row(390, '2026/01/02', 'CD轉出', '2,884', '0', '318,491'),
    L(380, [[168, '已消費未扣款明細', 40]]),                      // 區塊 C 被重印在明細後面
    // ⚠️ 這一列**與明細列同樣座標**＝錨點是唯一擋得住它的東西（把錨點改成不生效，這題就會紅）
    row(370, '2026/01/27', '刷卡消費', '500', '0', '317,991'),
    L(360, [[168, '消費支出類別', 40], [277, '台幣金額', 27]]),
    row(350, '2026/01/28', '百貨超市', '43,638', '0', '274,353'),
  ];
  const { transactions } = parseTaishinDebitDetail(lines);
  assert.equal(transactions.length, 1, '★錨點之後一律不收——多張卡／跨頁時「表頭之前不收」守不住');
  assert.equal(transactions[0].amount, 2884);
  assert.ok(!transactions.some((t) => t.amount === 500 || t.amount === 43638), '★錨點後的列連金額都不可出現');
  // A 區（刷卡消費明細）重印在 D 之後（Grok #492 掃後補）：靠它表頭的「外幣折換日」擋。
  // 陷阱列同樣用明細列的座標＝錨點是唯一擋得住它的東西。
  const aReprint = [...headerLines(), HEAD,
    row(390, '2026/01/02', 'CD轉出', '2,884', '0', '318,491'),
    L(380, [[143, '扣款日', 20], [185, '消費日', 20], [230, '消費明細 / 消費地區', 60], [310, '外幣折換日', 35], [370, '幣別', 15]]),
    row(370, '2026/01/28', '刷卡消費', '305', '0', '318,186'),
  ];
  const a = parseTaishinDebitDetail(aReprint);
  assert.equal(a.transactions.length, 1, '★A 區重印後的列不可入帳（同一筆錢的另一種印法）');
  assert.ok(!a.transactions.some((t) => t.amount === 305), '★連金額都不可出現');
  // ⚠️ 錨點**只看非交易列**（r4#1 的三個負例——裸字樣判定會把含錨點字樣的合法交易連同後面
  //    全部截掉，而截斷後的前綴餘額鏈仍自洽＝閘看不到）：
  // ①合法交易的**備註**含「外幣折換日」＝照樣入帳、後面不截斷
  const notePoison = [...headerLines(), HEAD,
    row(390, '2026/01/02', '轉帳支取', '1,000', '0', '317,491', '外幣折換日通知'),
    row(380, '2026/01/03', 'CD轉出', '500', '0', '316,991'),
  ];
  const np = parseTaishinDebitDetail(notePoison);
  assert.equal(np.transactions.length, 2, '★備註含錨點字樣的交易列不可被誤殺（後面那筆也要在）');
  // ②合法交易的**摘要**含「消費」開頭的字樣同理（B 區錨點「消費支出類別」是整串比對、不會誤中「刷卡消費」）
  // ③**跨行備註**單獨含「外幣折換日」＝不觸發錨點（A 判準是同列合取：還要同列有「扣款日／消費日」）
  const orphanPoison = [...headerLines(), HEAD,
    row(390, '2026/01/02', '轉帳支取', '1,000', '0', '317,491'),
    L(386, [[420, '外幣折換日', 40]]),           // 落在備註欄帶的跨行字（距離 4 ⇒ 會被黏回）
    row(373, '2026/01/03', 'CD轉出', '500', '0', '316,991'),
  ];
  const op = parseTaishinDebitDetail(orphanPoison);
  assert.equal(op.transactions.length, 2, '★單獨的「外幣折換日」五個字不可觸發錨點（同列合取才算 A 表頭）');
  assert.match(String(op.transactions[0].note), /外幣折換日/, '而且照樣黏回它該去的那一筆');
  // ④「交易列免疫」要**單獨**成立（r5：上面①用的是合取字樣——把錨點移回日期判定之前、
  //    保留合取，①照樣綠，因為單獨的「外幣折換日」本來就不觸發合取。B/C 錨點是**單裸字**判定，
  //    唯一擋住它誤殺交易列的就是「錨點只看非交易列」那一道——這題直接踩它）。
  const bcPoison = [...headerLines(), HEAD,
    row(390, '2026/01/02', '轉帳支取', '1,000', '0', '317,491', '已消費未扣款查詢'),
    row(380, '2026/01/03', 'CD轉出', '500', '0', '316,991'),
  ];
  const bp = parseTaishinDebitDetail(bcPoison);
  assert.equal(bp.transactions.length, 2, '★備註含 B/C 錨點字樣（單裸字）的交易列不可被誤殺——日期起頭＝免疫');
});

test('★支出/存入欄讀不出數字＝throw，「讀不到」不可折疊成 0（r2#1：折疊＝靜靜匯入 0 筆回報成功）', () => {
  // Codex r2 探針：支出格「無法辨識」、存入格 0 ⇒ 舊版折疊成 0/0 ⇒ 走「兩欄都 0＝跳過」
  // ⇒ 0 筆、對帳閘 weak/ok、apply 發 batchId ＝使用者以為匯進去了。
  const badCell = [...headerLines(), HEAD, row(390, '2026/01/02', 'CD轉出', '無法辨識', '0', '318,491')];
  assert.throws(() => parseTaishinDebit(badCell),
    (/** @type {any} */ e) => e.code === 'bank_unrecognized' && /讀不出數字/.test(e.message),
    '★非數字＝欄位定位讀錯了，照實喊認不得（不可變成一份 0 筆的「成功」）');
  // 真數字 0 仍照舊：兩欄都真的印 0＝沒有金流，跳過（不丟錯——真檔就有這種列）
  const zeroRow = [...headerLines(), HEAD,
    row(390, '2026/01/02', 'CD轉出', '2,884', '0', '318,491'),
    row(380, '2026/01/03', '通知', '0', '0', '318,491')];
  assert.equal(parseTaishinDebit(zeroRow).transactions.length, 1, '真數字 0/0＝跳過、不誤擋');
});

test('日期只驗長相不夠：2026/02/31 要當場擋下，不可拖到寫入櫃檯才變成程式錯誤', () => {
  const bad = [...headerLines(), HEAD, row(390, '2026/02/31', 'CD轉出', '2,884', '0', '318,491')];
  assert.throws(() => parseTaishinDebit(bad),
    (/** @type {any} */ e) => e.code === 'bank_unrecognized' && /真日曆日/.test(e.message),
    '★丟得早才有 AI 救援那條路；拖到寫入才擋＝使用者看到看不懂的程式錯誤');
  // 現值參考日同理：假日期＝當成讀不到（不可拿去比新舊、覆蓋餘額）
  const badRef = [
    L(700, [[137, '感謝您使用本行簽帳金融卡消費(存款帳號**********1234)', 293]]),
    L(690, [[137, '對帳單期間：2026/01/01 ~ 2026/02/31', 123]]),
    HEAD, row(390, '2026/01/02', 'CD轉出', '2,884', '0', '318,491'),
  ];
  assert.equal(parseTaishinDebit(badRef).referenceDate, null, '★假的結束日＝當成讀不到');
});

// ---- Codex #494 r1 的六個反例（每一條都是他用合成資料在正式路徑重現過的）----

test('r1#1｜混合候選（完整戶＋標記戶並存）＝ambiguous，不可把標記戶補登成別人的前綴', () => {
  // 完整戶 900100 與標記戶並存、帳單是 900200：末碼其實有兩顆——「只有一顆帶標記」推不出
  // 標記戶就是 900200，而補登不可逆。
  const db = { accounts: [
    { id: 'a1', name: '完整戶', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '900100****1234', balance: 1 },
    { id: 'a2', name: '標記戶', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '**********1234', accountNoSuffixOnly: true, balance: 2 },
  ] };
  const combo = { bank: '台新', referenceDate: '2026-02-28',
    accounts: [{ suffix: '1234', masked: '900200****1234', balance: 999, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900200****1234': 'TWD' }, transactions: [] };
  const pv = previewBalancesForDb(db, combo);
  assert.equal(pv.rows[0].action, 'ambiguous', '★預覽就要說認不出');
  const r = applyBalancesToDb(db, combo);
  assert.equal(r.updated + r.created, 0, '★不更新也不新建');
  assert.equal(db.accounts[1].accountNo, '**********1234', '★標記戶的帳號絕不可被補登成 900200（不可逆的錯）');
  assert.equal(db.accounts[1].accountNoSuffixOnly, true, '標記也不可被清');
});

test('r1#2｜真正末列的餘額讀不到＝不報帳戶（不可拿較早的 running balance 冒充期末）', () => {
  const lines = [...headerLines(), HEAD,
    row(390, '2026/01/02', 'CD轉出', '2,884', '0', '318,491'),
    row(380, '2026/01/30', '轉帳支取', '10', '0', ''),          // 末列餘額空白
  ];
  const p = parseTaishinDebit(lines);
  assert.equal(p.transactions.length, 2, '交易照收（餘額 null 只是那一欄讀不到）');
  assert.deepEqual(p.accounts, [], '★較早那列的 318,491 之後還有交易＝已過時，冒充期末沒有任何檢查抓得到');
});

test('r1#3｜無 bank 戳的同末碼戶＝ambiguous（suffix-only 進件沒有前綴，祖父寬鬆只剩四碼＝不可沿用）', () => {
  const db = { accounts: [{ id: 'a1', name: '手建舊戶', type: 'cash', currency: 'TWD', accountNo: '777700****1234', balance: 1 }] };
  const p = parseTaishinDebit(wholeStatement());
  const pv = previewBalancesForDb(db, p);
  assert.equal(pv.rows[0].action, 'ambiguous', '★無法證明它是台新＝停手（完整遮罩路徑的祖父寬鬆靠前綴＋末碼撐著，這條路沒有前綴）');
  const r = applyBalancesToDb(db, p);
  assert.equal(r.updated + r.created, 0, '★不蓋餘額、也不新建（新建＝裂戶）');
  assert.equal(db.accounts[0].balance, 1);
});

test('r1#4｜手建戶帳號恰好只有末四碼（無標記）＝金融卡配到時補上標記→日後綜合對帳單認得親', () => {
  const db = { accounts: [{ id: 'a1', name: '手建', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '1234', balance: 1 }] };
  const p = parseTaishinDebit(wholeStatement());
  const r1 = applyBalancesToDb(db, p);
  assert.equal(r1.updated, 1, '嚴格徑本來就配得到（digits 以末碼結尾）');
  assert.equal(db.accounts[0].accountNoSuffixOnly, true,
    '★配到時要補標記——「這顆的帳號只有末四碼」是事實陳述；不補＝下一期綜合對帳單嚴格 miss、loose 也 miss ⇒ 裂戶');
  const combo = { bank: '台新', referenceDate: '2026-02-28',
    accounts: [{ suffix: '1234', masked: '900200****1234', balance: 999, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900200****1234': 'TWD' }, transactions: [] };
  const r2 = applyBalancesToDb(db, combo);
  assert.equal(r2.updated, 1, '★往返：綜合對帳單認得親、不裂戶');
  assert.equal(db.accounts.length, 1);
  assert.equal(db.accounts[0].accountNo, '900200****1234', '帳號補登完成');
});

test('r1#5｜較舊帳單＝skip 就是 skip：餘額不動、帳號也不補登（預覽說跳過、套用就不可以偷改身分）', () => {
  const db = { accounts: [{ id: 'a1', name: '標記戶', type: 'cash', currency: 'TWD', bank: '台新',
    accountNo: '**********1234', accountNoSuffixOnly: true, balance: 5, balanceAsOf: '2026-03-31' }] };
  const combo = { bank: '台新', referenceDate: '2026-02-28',   // 較舊
    accounts: [{ suffix: '1234', masked: '900100****1234', balance: 999, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900100****1234': 'TWD' }, transactions: [] };
  const r = applyBalancesToDb(db, combo);
  assert.equal(r.skipped, 1);
  assert.equal(db.accounts[0].balance, 5, '餘額不動');
  assert.equal(db.accounts[0].accountNo, '**********1234', '★帳號也不動（補登沒有 undo，錯了救不回來）');
  assert.equal(db.accounts[0].accountNoSuffixOnly, true, '標記不動');
});

test('r1#7｜accountNoSuffixOnly 有進 FIELD_SCHEMA：非布林被安檢門剝掉（刪登記＝這裡紅）', async () => {
  const { FIELD_SCHEMA, sanitizeDbForWrite } = await import('../lib/schema.js');
  assert.equal(FIELD_SCHEMA.accounts.accountNoSuffixOnly, 'boolean', '★型別要登記（漏登記＝備份還原時保留非法字串）');
  const { emptyDb } = await import('../lib/store.js');
  const db = { ...emptyDb(), accounts: [
    { id: 'a1', name: 'x', type: 'cash', currency: 'TWD', accountNo: '1234', balance: 0, accountNoSuffixOnly: /** @type {any} */ ('yes') },
    { id: 'a2', name: 'y', type: 'cash', currency: 'TWD', accountNo: '5678', balance: 0, accountNoSuffixOnly: true },
  ] };
  const out = sanitizeDbForWrite(/** @type {any} */ (db), { mode: 'strip' });
  assert.equal(/** @type {any} */ (out.accounts[0]).accountNoSuffixOnly, undefined, '★字串 "yes"＝非法、剝掉（truthy 錯型會讓寬鬆徑誤開）');
  assert.equal(/** @type {any} */ (out.accounts[1]).accountNoSuffixOnly, true, '真布林保留');
});

test('r1 建議｜balanceFromDetail 只住在金融卡解析器與對帳閘（別的路線塞它＝關掉末筆對概要）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const hits = [];
  for (const dir of ['lib', 'lib/services', 'lib/routes']) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = readFileSync(`${dir}/${f}`, 'utf8');
      if (src.includes('balanceFromDetail')) hits.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(hits.sort(), ['lib/bank-statement.js', 'lib/statement-reconcile.js'],
    '★這個旗標的產地只有金融卡解析器、消費地只有對帳閘——多一個檔案用它就要先想「是不是在關掉檢查」');
});

test('r1#6｜全星號遮罩的交易掛名：帳戶改名後 reconcile 認得出末碼、同末碼多顆不退化取第一', async () => {
  const { reconcileBankTxAccountNames } = await import('../lib/services/bank-import.js');
  // 金融卡匯入的 bankRef 帳號段是 `**********1234`——舊 maskedParts 取不出末碼＝改名永遠同步不到
  const db = { accounts: [{ id: 'a1', name: '新名字', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '900100****1234', balance: 0 }],
    transactions: [{ id: 't1', account: '舊名字', source: 'bank', bankRef: 'bank|**********1234|2026-01-02|out|2884||CD轉出|' }] };
  const changed = reconcileBankTxAccountNames(db);
  assert.equal(changed, 1, '★全星號帳號段要認得出末碼（否則帳戶改名後交易永遠留舊名）');
  assert.equal(db.transactions[0].account, '新名字');
  // 多顆同末碼＝不改（全星號沒有前綴可分辨；退化成取第一顆＝交易掛到別人的帳戶名下）
  const db2 = { accounts: [
    { id: 'a1', name: '甲', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '900100****1234', balance: 0 },
    { id: 'a2', name: '乙', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '900200****1234', balance: 0 },
  ], transactions: [{ id: 't1', account: '舊名字', source: 'bank', bankRef: 'bank|**********1234|2026-01-02|out|2884||CD轉出|' }] };
  assert.equal(reconcileBankTxAccountNames(db2), 0, '★分不出是哪顆＝不改（歧義停手，與餘額同一條紀律）');
  assert.equal(db2.transactions[0].account, '舊名字');
});

// ---- Grok #494 複審後掃三條（新制首航：它自己跑正式程式重現的，我逐條再驗）----

test('G1｜帳單自己印兩個同末碼帳號＝寬鬆徑停手（不補登、不裂戶）', () => {
  // 900100****1234 與 900200****1234 同一份出現＝末碼在這份帳單上本來就不唯一，
  // 「憑末碼認親」的前提整個不成立——舊行為：第一列補登 900100、第二列 create ＝補登錯＋裂戶。
  const db = { accounts: [{ id: 'm', name: '標記戶', type: 'cash', currency: 'TWD', bank: '台新',
    accountNo: '**********1234', accountNoSuffixOnly: true, balance: 5 }] };
  const combo = { bank: '台新', referenceDate: '2026-02-28', accounts: [
    { suffix: '1234', masked: '900100****1234', balance: 111, currency: 'TWD', label: '', note: '' },
    { suffix: '1234', masked: '900200****1234', balance: 222, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900100****1234': 'TWD', '900200****1234': 'TWD' }, transactions: [] };
  const r = applyBalancesToDb(db, combo);
  assert.equal(r.updated + r.created, 0, '★兩列都停手');
  assert.equal(db.accounts.length, 1, '★不裂戶');
  assert.equal(db.accounts[0].accountNo, '**********1234', '★標記戶不可被其中一列搶先補登');
  assert.equal(db.accounts[0].accountNoSuffixOnly, true);
  const pv = previewBalancesForDb({ accounts: [...db.accounts] }, combo);
  assert.deepEqual(pv.rows.map((x) => x.action), ['ambiguous', 'ambiguous'], '★預覽兩列都照實說認不出');
});

test('G2｜使用者手動補了完整帳號但標記殘留＝寬鬆徑不可再信標記（親手填的 900100 不可被帳單洗成 900200）', () => {
  // accountNo 在 CRUD 白名單、標記不在：資產頁補完整帳號後標記還掛著。
  // 寬鬆徑只信「帳號數字部分＝末碼而已」的標記戶；數字更長＝身分其實已完整＝交給嚴格徑。
  const db = { accounts: [{ id: 'm', name: '補過號', type: 'cash', currency: 'TWD', bank: '台新',
    accountNo: '900100****1234', accountNoSuffixOnly: true, balance: 5 }] };
  const combo = { bank: '台新', referenceDate: '2026-02-28',
    accounts: [{ suffix: '1234', masked: '900200****1234', balance: 999, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900200****1234': 'TWD' }, transactions: [] };
  const r = applyBalancesToDb(db, combo);
  assert.equal(db.accounts[0].accountNo, '900100****1234', '★使用者填的前綴是歧義證據，不是「還不完整」');
  assert.equal(r.updated, 0, '★900200 對 900100＝前綴對不上＝不是同一顆');
  assert.equal(r.created, 1, '900200 是另一顆帳戶＝新建是正確行為');
  // 對照：真的 900100 帳單來＝嚴格徑照配（標記殘留不擋正路）
  const db2 = { accounts: [{ id: 'm', name: '補過號', type: 'cash', currency: 'TWD', bank: '台新',
    accountNo: '900100****1234', accountNoSuffixOnly: true, balance: 5 }] };
  const combo2 = { bank: '台新', referenceDate: '2026-02-28',
    accounts: [{ suffix: '1234', masked: '900100****1234', balance: 777, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900100****1234': 'TWD' }, transactions: [] };
  assert.equal(applyBalancesToDb(db2, combo2).updated, 1, '同前綴照樣更新');
});

test('G3｜歧義時交易掛名不可退回「取第一顆」（匯入當下就掛到別人名下、事後對齊救不回）', async () => {
  const { previewBankTxForDb } = await import('../lib/services/bank-import.js');
  const db = { accounts: [
    { id: 'a1', name: '甲', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '900100****1234', balance: 0 },
    { id: 'a2', name: '乙', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '900200****1234', balance: 0 },
  ], transactions: [] };
  const p = parseTaishinDebit(wholeStatement());
  const pv = previewBankTxForDb(db, p);
  assert.ok(pv.rows.length > 0);
  for (const row of pv.rows) {
    assert.notEqual(row.account, '甲', '★全星號帳號分不出是誰＝不可掛到第一顆');
    assert.notEqual(row.account, '乙');
    assert.match(String(row.account), /台新/, '退回帳單概要的自動名（「台新 1234」）——與餘額 ambiguous 同一條紀律');
  }
});

test('r4#1a｜第二個同末碼帳戶只活在 accountCurrency（餘額空白）＝G1 照樣要停手', () => {
  // 餘額空白的帳戶只在幣別表——那才是帳單的完整帳戶清單；只掃 accounts 會漏掉它，
  // 寬鬆徑照樣把純末碼標記戶不可逆認錯親（Codex r4 實測：update＋補登成 900100）。
  const db = { accounts: [{ id: 'm', name: '標記戶', type: 'cash', currency: 'TWD', bank: '台新',
    accountNo: '1234', accountNoSuffixOnly: true, balance: 5 }] };
  const combo = { bank: '台新', referenceDate: '2026-02-28',
    accounts: [{ suffix: '1234', masked: '900100****1234', balance: 111, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900100****1234': 'TWD', '900200****1234': 'TWD' },   // 900200 沒印餘額、只在幣別表
    transactions: [] };
  const pv = previewBalancesForDb({ accounts: [...db.accounts] }, combo);
  assert.equal(pv.rows[0].action, 'ambiguous', '★帳單末碼仍不唯一（另一顆在幣別表）＝停手');
  const r = applyBalancesToDb(db, combo);
  assert.equal(r.updated + r.created, 0);
  assert.equal(db.accounts[0].accountNo, '1234', '★不可被補登');
});

test('r4#1b｜G1×G2 交叉：過期標記戶＋帳單兩個同末碼完整帳號＝嚴格徑照樣放行（update＋create）', () => {
  // 手動補成 900100、標記殘留；帳單印 900100 與 900200。dup 停手若排在嚴格徑之前，
  // 連「前綴全等」的正路都被誤擋（Codex r4 實測：ambiguous×2、什麼都不動）。
  // 正確＝900100 走嚴格徑更新、900200 新建，手填帳號不被洗掉。
  const db = { accounts: [{ id: 'm', name: '補過號', type: 'cash', currency: 'TWD', bank: '台新',
    accountNo: '900100****1234', accountNoSuffixOnly: true, balance: 5 }] };
  const combo = { bank: '台新', referenceDate: '2026-02-28', accounts: [
    { suffix: '1234', masked: '900100****1234', balance: 111, currency: 'TWD', label: '', note: '' },
    { suffix: '1234', masked: '900200****1234', balance: 222, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900100****1234': 'TWD', '900200****1234': 'TWD' }, transactions: [] };
  const pv = previewBalancesForDb({ accounts: [...db.accounts] }, combo);
  assert.deepEqual(pv.rows.map((x) => x.action), ['update', 'create'], '★前綴就是分辨器——dup 只擋憑末碼的寬鬆徑');
  const r = applyBalancesToDb(db, combo);
  assert.equal(r.updated, 1); assert.equal(r.created, 1);
  assert.equal(db.accounts[0].accountNo, '900100****1234', '★手填帳號不被洗掉');
  assert.equal(db.accounts[0].balance, 111);
  assert.equal(db.accounts.length, 2, '900200 是另一顆＝新建正確');
});
