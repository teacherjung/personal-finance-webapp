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
const { previewBalancesForDb } = await import('../lib/services/bank-import.js');   // 走正式的帳戶比對，不重抄判準

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

test('★不建帳戶、不動餘額｜這個版面只印得出末四碼，身分不夠明確（自動建戶會裂成兩個帳戶）', () => {
  const p = parseTaishinDebit(wholeStatement());
  assert.equal(p.bank, '台新', '★機構名要逐字「台新」——去重鍵靠它走既有格式，寫別的字舊資料就認不得了');
  assert.deepEqual(p.accounts, [], '★刻意不產帳戶：帳號只印 **********1234，自動建戶會把 accountNo 寫成它');
  // 為什麼不建戶：走**正式的** previewBalancesForDb（裡面就是正式的 matchAccount），
  // 證明「金融卡先建的戶，日後綜合對帳單會配不到它、於是再建第二顆」。
  // ⚠️ 這裡刻意**不重抄一份判準**（Codex #492 r1 實測：抄一份的話，把正式 matchAccount 的
  //    前綴檢查改成永遠成功，這題照樣全綠＝守的是抄本不是行為）。
  const comboParsed = {
    bank: '台新', referenceDate: '2026-02-28',
    accounts: [{ suffix: '1234', masked: '900100****1234', balance: 500, currency: 'TWD', label: '', note: '' }],
    accountCurrency: { '900100****1234': 'TWD' }, transactions: [],
  };
  const dbFromDebit = { accounts: [{ id: 'a1', name: '台新 1234', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '**********1234', balance: 100 }] };
  const split = previewBalancesForDb(dbFromDebit, comboParsed);
  assert.equal(split.rows[0].action, 'create',
    '★裂戶就是這樣發生的：金融卡建的戶只有末四碼，綜合對帳單（900100****1234）配不到它 ⇒ 再建一顆');
  // 反方向沒事：綜合先建、金融卡（只有末四碼）配得到 ⇒ 不對稱，所以不能賭使用者的匯入順序
  const debitParsed = { ...comboParsed, accounts: [{ ...comboParsed.accounts[0], masked: '**********1234' }],
    accountCurrency: { '**********1234': 'TWD' } };
  const dbFromCombo = { accounts: [{ id: 'a1', name: '台新 1234', type: 'cash', currency: 'TWD', bank: '台新', accountNo: '900100****1234', balance: 100 }] };
  assert.equal(previewBalancesForDb(dbFromCombo, debitParsed).rows[0].action, 'update', '反方向配得到');
  // 幣別表仍要有它：下游靠它判幣別、也靠它把這個帳號算成「自己人」（帳戶互轉才不會被當成收支）
  assert.deepEqual(p.accountCurrency, { '**********1234': 'TWD' });
  for (const t of p.transactions) assert.equal(t.acctMasked, '**********1234', '每一筆都要掛上帳號（去重鍵要用）');
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
    '★沒有「末筆對概要」可驗——這份帳單沒有獨立的概要餘額，硬要驗就是拿同一個數字對自己（誠實劃界，不是漏掉）');
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
