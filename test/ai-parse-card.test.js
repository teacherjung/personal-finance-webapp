// 信用卡 AI 解析（批二）純模組卷：答案卷驗收（fail-closed）／接地／驗算閘（等式＋加總）。
// 規矩同 test/ai-parse.test.js：引擎答案不可信——每一題都問「壞在這裡的答案，會不會被靜靜收下」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_CARD_SCHEMA, AI_CARD_MODELS, CARD_LIMITS, CARD_TOLERANCE,
  buildCardSystem, normalizeAiCard, assertAiCardGrounded, reconcileAiCard,
} from '../lib/ai-parse-card.js';

/** 一份全對的最小答案卷（各題從它出發改壞一格——單變因）。 */
const GOOD = () => ({
  issuer: '遠東國際商業銀行',
  lastFour: '1234',
  statementMonth: '2026-07',
  totals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 480 },
  adjustments: [{ label: '循環信用利息', amount: 30 }],
  transactions: [
    { date: '2026-07-03', postDate: '2026-07-05', desc: '星巴克', amount: 150 },
    { date: '2026-07-10', postDate: null, desc: '全聯福利中心', amount: 350 },
    { date: '2026-07-12', postDate: null, desc: '退款：全聯', amount: -50 },
  ],
});
/** GOOD 的帳單原文（接地集合的來源；金額全部印在裡面）。 */
const TEXT = [
  '遠東國際商業銀行 信用卡帳單 2026-07 卡號末四碼 1234',
  '上期應繳總額 1,000 已繳款/退款金額 1,000 本期新增款項 450 循環信用利息 30 本期應繳總額 480',
  '115/07/03 星巴克 150',
  '115/07/10 全聯福利中心 350',
  '115/07/12 退款：全聯 -50',
].join('\n');

const codeOf = (/** @type {() => any} */ fn) => {
  try { fn(); } catch (e) { return /** @type {any} */ (e).code; }
  return null;
};

test('正向｜全對的答案卷過三關（驗收→接地→驗算），欄位形狀完整', () => {
  const p = normalizeAiCard(GOOD());
  assertAiCardGrounded(p, TEXT);
  reconcileAiCard(p);
  assert.equal(p.issuer, '遠東國際商業銀行');
  assert.equal(p.lastFour, '1234');
  assert.equal(p.statementMonth, '2026-07');
  assert.deepEqual(p.statementTotals, { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 480 });
  assert.equal(p.transactions.length, 3);
  assert.equal(p.transactions[2].amount, -50, '退款保留負號');
});

test('驗收｜fail-closed 矩陣：欄位缺／型別錯／值離譜＝整份拒收（ai_bad_answer）', () => {
  const rows = /** @type {[string, (g:any)=>void][]} */ ([
    ['整份不是物件', () => normalizeAiCard(null)],
    ['整份是陣列', () => normalizeAiCard([])],
    ['issuer 缺', () => { const g = GOOD(); delete g.issuer; normalizeAiCard(g); }],
    ['issuer 全是分段符', () => { const g = GOOD(); g.issuer = '|||'; normalizeAiCard(g); }],
    ['lastFour 不是四位數字', () => { const g = GOOD(); g.lastFour = '12a4'; normalizeAiCard(g); }],
    ['statementMonth 亂寫', () => { const g = GOOD(); g.statementMonth = '2026/07'; normalizeAiCard(g); }],
    ['statementMonth 假月份', () => { const g = GOOD(); g.statementMonth = '2026-13'; normalizeAiCard(g); }],
    ['totals 缺', () => { const g = GOOD(); delete g.totals; normalizeAiCard(g); }],
    ['totals 值不是數字', () => { const g = GOOD(); g.totals.due = '480'; normalizeAiCard(g); }],
    ['totals 大得離譜', () => { const g = GOOD(); g.totals.due = 1e9; normalizeAiCard(g); }],
    ['adjustments 缺', () => { const g = GOOD(); delete g.adjustments; normalizeAiCard(g); }],
    ['adjustment 金額為零', () => { const g = GOOD(); g.adjustments = [{ label: 'x', amount: 0 }]; normalizeAiCard(g); }],
    ['adjustment 沒名字', () => { const g = GOOD(); g.adjustments = [{ label: '', amount: 30 }]; normalizeAiCard(g); }],
    ['transactions 缺', () => { const g = GOOD(); delete g.transactions; normalizeAiCard(g); }],
    ['交易日期是假日曆日', () => { const g = GOOD(); g.transactions[0].date = '2026-02-30'; normalizeAiCard(g); }],
    ['入帳日是假日曆日', () => { const g = GOOD(); g.transactions[0].postDate = '2026-13-01'; normalizeAiCard(g); }],
    ['金額為零', () => { const g = GOOD(); g.transactions[0].amount = 0; normalizeAiCard(g); }],
    ['金額不是數字', () => { const g = GOOD(); g.transactions[0].amount = 'NaN'; normalizeAiCard(g); }],
    ['desc 清完只剩空', () => { const g = GOOD(); g.transactions[0].desc = '   '; normalizeAiCard(g); }],
  ]);
  for (const [name, fn] of rows) assert.equal(codeOf(fn), 'ai_bad_answer', `★${name} 沒被擋`);
});

test('驗收｜筆數上限 fail-closed（超過＝壞答案，不是截斷收下）', () => {
  const g = GOOD();
  g.transactions = Array.from({ length: CARD_LIMITS.transactions + 1 }, (_, i) => ({ date: '2026-07-01', postDate: null, desc: `店${i}`, amount: 1 }));
  assert.equal(codeOf(() => normalizeAiCard(g)), 'ai_bad_answer');
  const g2 = GOOD();
  g2.adjustments = Array.from({ length: CARD_LIMITS.adjustments + 1 }, () => ({ label: 'x', amount: 1 }));
  assert.equal(codeOf(() => normalizeAiCard(g2)), 'ai_bad_answer');
});

test('驗收｜符號紀律（r1#2）：只有 paidAndRefund 取絕對值，其餘三格保留帳單的正負號', () => {
  const g = GOOD();
  g.totals.paidAndRefund = -1000;   // 有的帳單把已繳款印成負數；等式自帶減號＝這格是量值
  const p = normalizeAiCard(g);
  assert.equal(p.statementTotals.paidAndRefund, 1000);
  // 退款期的本期新增／應繳可以是負數——全取絕對值會把方向反轉成消費（r1 的高危重現）
  const g2 = GOOD(); g2.totals.newCharges = -100; g2.totals.due = -100;
  const p2 = normalizeAiCard(g2);
  assert.equal(p2.statementTotals.newCharges, -100, '★負的本期新增要原樣保留');
  assert.equal(p2.statementTotals.due, -100, '★負的應繳（溢繳）要原樣保留');
});

test('驗算＋接地｜退款期方向不可反轉（r1#2 完整重現）：帳單印 -100、AI 翻成 +100 ＝擋', () => {
  const totalsNeg = { prevDue: 0, paidAndRefund: 0, newCharges: -100, due: -100 };
  const textNeg = [
    '測試商業銀行 信用卡帳單 卡號末四碼 1234',
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 -100 本期應繳總額 -100',
    '115/07/12 退款商店 -100',
  ].join('\n');
  // 誠實答案（照抄負號）＝三關全過
  const honest = { ...GOOD(), totals: { ...totalsNeg }, adjustments: [],
    transactions: [{ date: '2026-07-12', postDate: null, desc: '退款商店', amount: -100 }] };
  const hp = normalizeAiCard(honest);
  assertAiCardGrounded(hp, textNeg);
  reconcileAiCard(hp);
  // 翻正的答案（+100 摘要＋ +100 明細）＝接地就擋：帳單上只有 -100，沒有 +100 這個位置
  const flipped = { ...GOOD(), totals: { prevDue: 0, paidAndRefund: 0, newCharges: 100, due: 100 }, adjustments: [],
    transactions: [{ date: '2026-07-12', postDate: null, desc: '退款商店', amount: 100 }] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(flipped), textNeg)), 'ai_bad_answer',
    '★退款被讀成消費、等式與加總卻照樣全平——只有帶符號的接地擋得住這型');
});

test('驗收｜desc 走 normalizeDesc（裁示③）：同一店名不同空白＝同一個字串（否則 stmtRef 分岔＝重複入帳）', () => {
  const g1 = GOOD(); g1.transactions[0].desc = '星巴克  信義店';
  const g2 = GOOD(); g2.transactions[0].desc = '星巴克 信義店';
  assert.equal(normalizeAiCard(g1).transactions[0].desc, normalizeAiCard(g2).transactions[0].desc,
    '★AI 兩次讀同一份差一個空白就變兩筆——這正是裁示③要擋的');
});

test('驗收｜調整列 label 走 normalizeDesc（r3#1；同裁示③店名）：空白漂移不得產生兩個 stmtRef', () => {
  const g1 = GOOD(); g1.adjustments = [{ label: '循環信用利息', amount: 30, date: null }];
  const g2 = GOOD(); g2.adjustments = [{ label: '循環  信用　利息', amount: 30, date: null }];
  assert.equal(normalizeAiCard(g1).adjustments[0].label, normalizeAiCard(g2).adjustments[0].label,
    '★同一筆利息兩種空白寫法＝同一個字串——否則重匯時 stmtRef 分岔＝利息重複記帳');
  const g3 = GOOD(); g3.adjustments = [{ label: '   ', amount: 30, date: null }];
  assert.equal(codeOf(() => normalizeAiCard(g3)), 'ai_bad_answer', '清完只剩空＝拒收');
});

test('接地｜答案卷上的每個金額都要在原文出現過：臆測的金額＝ai_bad_answer', () => {
  const g = GOOD(); g.transactions[0].amount = 151;   // 原文只有 150
  const p = normalizeAiCard(g);
  assert.equal(codeOf(() => assertAiCardGrounded(p, TEXT)), 'ai_bad_answer');
  // totals 與 adjustments 也在接地射程內（Grok 掃#7：原本這行掛了個把 480 換成 480 的空操作
  // replace——看起來在測「原文仍印 480」、實際只測「481 不在原文」；拿掉空操作、斷言不變）
  const g2 = GOOD(); g2.totals.due = 481;
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(g2), TEXT)), 'ai_bad_answer');
  const g3 = GOOD(); g3.adjustments[0].amount = 31;
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(g3), TEXT)), 'ai_bad_answer');
});

test('接地｜多重集消耗（r1#1）：把三筆明細縮成一筆、金額借摘要的「本期新增」＝擋', () => {
  // 摘要的 450 印在帳單上 ⇒ 舊版「全文出現過就好」會放行這份縮寫答案（等式、加總也全平）。
  // 消耗制：totals.newCharges 先占掉 450 唯一的位置，明細再要 450 就沒得借。
  const g = GOOD();
  g.transactions = [{ date: '2026-07-03', postDate: null, desc: '星巴克', amount: 450 }];
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(g), TEXT)), 'ai_bad_answer',
    '★明細不可以借摘要的數字——縮成一筆的幻覺明細要在接地就死');
  // 對照：真的有兩筆同額時，帳單印兩次、消耗兩次都成立（不會誤擋）
  const dup = GOOD();
  dup.totals = { prevDue: 1000, paidAndRefund: 1000, newCharges: 300, due: 330 };
  dup.transactions = [
    { date: '2026-07-03', postDate: null, desc: '星巴克', amount: 150 },
    { date: '2026-07-04', postDate: null, desc: '星巴克', amount: 150 },
  ];
  const dupText = [
    '遠東國際商業銀行 信用卡帳單 卡號末四碼 1234',
    '上期應繳總額 1,000 已繳款/退款金額 1,000 本期新增款項 300 循環信用利息 30 本期應繳總額 330',
    '115/07/03 星巴克 150',
    '115/07/04 星巴克 150',
  ].join('\n');
  assertAiCardGrounded(normalizeAiCard(dup), dupText);
});

test('接地｜殘片紀律（r3#1）：拆格碎片不得當獨立金額；拼接只認斷在千分位逗號的形', () => {
  // 真交易 1,000 被抽成「1,│000」＝AI 不可以拆開交回「1 元」假明細（殘片「1,」「000」都不是
  // 帳單印的數字）；相鄰普通數字「1 2」也不可以拼成帳單沒印過的 12。
  const text = [
    '測試商業銀行 信用卡帳單 卡號末四碼 1234',
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 1,002 本期應繳總額 1,002',
    '115/07/03 拆格店 1, 000',
    '115/07/04 兩個小數字 1 2',
  ].join('\n');
  // 誠實答案：1000（拼接）＋1＋2（各自獨立 token）＝過
  const honest = { ...GOOD(), totals: { prevDue: 0, paidAndRefund: 0, newCharges: 1002, due: 1002 }, adjustments: [],
    transactions: [
      { date: '2026-07-03', postDate: null, desc: '拆格店', amount: 1000 },
      { date: '2026-07-04', postDate: null, desc: '小額甲', amount: 1 },
      { date: '2026-07-04', postDate: null, desc: '小額乙', amount: 2 },
    ] };
  assertAiCardGrounded(normalizeAiCard(honest), text);
  // 攻擊①：把拆格的 1,000 拆成假明細「1 元」——殘片「1,」不得供位（G2 也平不了，但接地要先擋）
  const shred = { ...honest, transactions: [
    { date: '2026-07-03', postDate: null, desc: '假拆', amount: 1 },
    { date: '2026-07-03', postDate: null, desc: '假拆', amount: 1 },   // 第二個 1 只能指望殘片「1,」
    { date: '2026-07-04', postDate: null, desc: '小額乙', amount: 1000 },
  ] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(shred), text)), 'ai_bad_answer',
    '★殘片「1,」若被登記成獨立的 1，這份就會過');
  // 攻擊②：相鄰普通數字「1 2」拼成 12（帳單沒印過 12）
  const merge = { ...honest, transactions: [
    { date: '2026-07-03', postDate: null, desc: '拆格店', amount: 1000 },
    { date: '2026-07-04', postDate: null, desc: '憑空合體', amount: 12 },
  ] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(merge), text)), 'ai_bad_answer',
    '★拼接不認沒有逗號斷點的形——「1 2」不是被拆開的 12');
  // 攻擊③（判別場景）：殘片提供「致勝籌碼」而拼接值本身沒被宣稱——上面兩式在殘片照登的壞版本裡
  // 也可能因為別格先搶位而剛好紅（突變演練㉒實測），這一式只有殘片紀律本人擋得住。
  const text3 = [
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 2 本期應繳總額 2',
    '拆格殘片 1, 000',
    '單獨數字 1',
  ].join('\n');
  const forged3 = { ...GOOD(), lastFour: null, totals: { prevDue: 0, paidAndRefund: 0, newCharges: 2, due: 2 }, adjustments: [],
    transactions: [
      { date: '2026-07-03', postDate: null, desc: '真的一元', amount: 1 },
      { date: '2026-07-03', postDate: null, desc: '假的一元', amount: 1 },   // 只能指望殘片「1,」
    ] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(forged3), text3)), 'ai_bad_answer',
    '★殘片「1,」不是帳單印的 1——它只活在拼接組裡，獨立宣稱借不走');
});

test('接地｜前逗號拆格（r4#1）：「1 ,000」的頭段「1」自己是合法形——照樣不得獨立供位', () => {
  // r3 的形狀篩只擋得住「1,│000」方向（殘片自己壞形）；「1 │,000」的頭段是合法的「1」，
  // 要靠「拼接組成員一律不得獨立登記」才擋得住。
  const text = [
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 1,001 本期應繳總額 1,001',
    '拆格店 1 ,000',
    '單獨數字 1',
  ].join('\n');
  const honest = { ...GOOD(), lastFour: null, totals: { prevDue: 0, paidAndRefund: 0, newCharges: 1001, due: 1001 }, adjustments: [],
    transactions: [
      { date: '2026-07-03', postDate: null, desc: '拆格店', amount: 1000 },
      { date: '2026-07-04', postDate: null, desc: '單獨一元', amount: 1 },
    ] };
  assertAiCardGrounded(normalizeAiCard(honest), text);
  // ⚠️ forged **刻意不宣稱 1000**：連 1000 一起宣稱時，壞版本會因為頭段「1」先被搶走、換 1000
  //   那格 miss——一樣紅、但紅錯理由（突變演練㉕實測）。拿掉 1000 才讓「頭段可不可獨立供位」
  //   成為唯一判別點。
  const forged = { ...honest, transactions: [
    { date: '2026-07-04', postDate: null, desc: '真的一元', amount: 1 },
    { date: '2026-07-04', postDate: null, desc: '假的一元', amount: 1 },   // 只能指望拆格頭段的「1」
  ] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(forged), text)), 'ai_bad_answer',
    '★拆格頭段的「1」是碎片（夥伴「,000」帶著邊界逗號）——不得再獨立供位');
});

test('接地｜句讀逗號不誤殺（r4#3）：全形逗號被 NFKC 折成半形黏在數字上，剝掉再驗形', () => {
  // 帳單印「…450，本期應繳…」＝token「450,」——它不是拆格碎片（右鄰不是數字），是句讀。
  const p = normalizeAiCard(GOOD());
  const textPunct = TEXT.replace('本期新增款項 450 ', '本期新增款項 450， ');
  assertAiCardGrounded(p, textPunct);   // 不丟＝450 還接得到地
});

test('接地｜lastFour 候選只認無逗號 token（r4#2）：「91,234」是金額不是卡號，不得被搶去占位', () => {
  // 偏好「最長」的舊排序會把 91,234（剝逗號後含 1234）當末四碼占掉——占錯位之後，
  // 真的卡號 token 反而留給虛構的 1,234 明細借用。
  const text = [
    '測試商業銀行 卡號末四碼 1234',
    '上期應繳總額 91,234 已繳款退款金額 91,234 本期新增款項 1,234 本期應繳總額 1,234',
  ].join('\n');
  const base = { ...GOOD(), lastFour: '1234', totals: { prevDue: 91234, paidAndRefund: 91234, newCharges: 1234, due: 1234 }, adjustments: [] };
  assertAiCardGrounded(normalizeAiCard({ ...base, transactions: [] }), text);   // 誠實（零明細）＝過
  const forged = { ...base, transactions: [{ date: '2026-07-03', postDate: null, desc: '憑空店', amount: 1234 }] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(forged), text)), 'ai_bad_answer',
    '★lastFour 占「1234」本人、兩格摘要占兩個「1,234」——虛構明細沒位置可借');
});

test('接地｜lastFour 先占位（r3#2）：卡號 token 不得被虛構明細借去當金額位置', () => {
  // 末四碼、本期新增、本期應繳恰好同為 1234、原文沒有任何交易列——虛構一筆 1234 不可過。
  const text = [
    '測試商業銀行 信用卡帳單 卡號末四碼 1234',
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 1234 本期應繳總額 1234',
  ].join('\n');
  const base = { ...GOOD(), lastFour: '1234', totals: { prevDue: 0, paidAndRefund: 0, newCharges: 1234, due: 1234 }, adjustments: [] };
  // 誠實（零明細）＝接地過（之後 G2 自然會紅，那是驗算閘的事）
  assertAiCardGrounded(normalizeAiCard({ ...base, transactions: [] }), text);
  const forged = { ...base, transactions: [{ date: '2026-07-03', postDate: null, desc: '憑空店', amount: 1234 }] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(forged), text)), 'ai_bad_answer',
    '★三個 1234 的位置＝末四碼＋兩格摘要，虛構明細沒位置可借');
  // 完整卡號在場、金額**不撞**末四碼＝正常過（占長 token 不影響金額）
  const text2 = [
    '測試商業銀行 卡號 4321567812341234',
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 500 本期應繳總額 500',
    '115/07/03 真的店 500',
  ].join('\n');
  const legit = { ...base, totals: { prevDue: 0, paidAndRefund: 0, newCharges: 500, due: 500 },
    transactions: [{ date: '2026-07-03', postDate: null, desc: '真的店', amount: 500 }] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(legit), text2)), null,
    '★完整卡號那型占位零成本——金額不撞末四碼就不受影響');
  // 長數字串與撞號金額**同場**＝每型各占一格（r5#1）：可能誤擋，是檔頭劃界寫明的 fail-closed 代價
  //（只占長的那型會把真卡號 token 留給虛構明細借——r5 的對帳單編號反例，見下一題）。
  const text3 = [
    '測試商業銀行 卡號 4321567812341234',
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 1234 本期應繳總額 1234',
    '115/07/03 真的店 1234',
  ].join('\n');
  const collide = { ...base, transactions: [{ date: '2026-07-03', postDate: null, desc: '真的店', amount: 1234 }] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(collide), text3)), 'ai_bad_answer',
    '★撞號＋長數字串同場＝多占一格、寧擋勿收（誠實劃界的已知代價）');
});

test('接地｜「大到不可能是金額」不等於「是卡號」（r5#1）：對帳單編號不可搶走末四碼的占位', () => {
  // 帳單另印含 1234 的長數字串（對帳單編號）——只占它的話，真的「1234」卡號 token 會留給
  // 虛構的 1234 元明細借用。改「每型各占一格」後：長串與末四碼本人都占，虛構明細沒得借。
  const text = [
    '對帳單編號 991234567890 卡號末四碼 1234',
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 1234 本期應繳總額 1234',
  ].join('\n');
  const base = { ...GOOD(), lastFour: '1234', totals: { prevDue: 0, paidAndRefund: 0, newCharges: 1234, due: 1234 }, adjustments: [] };
  assertAiCardGrounded(normalizeAiCard({ ...base, transactions: [] }), text);   // 誠實（零明細）＝過
  const forged = { ...base, transactions: [{ date: '2026-07-03', postDate: null, desc: '憑空店', amount: 1234 }] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(forged), text)), 'ai_bad_answer',
    '★編號占一格、末四碼本人占一格、兩格摘要占兩格——虛構明細沒位置可借');
});

test('接地｜無空白的全形句讀（r6#2）：「100，200」不得被 NFKC 折成千分位；ASCII 逗號的真千分位照收', () => {
  // NFKC 把全形逗號折成半形——沒有空白時「100，200」整個變成合法千分位 token「100,200」，
  // r5 的兩-token 判準管不到。修在折疊之前：全形逗號永遠是句讀、先換成空白。
  const text = [
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 300 本期應繳總額 300',
    '消費清單 100，200',
  ].join('\n');
  const honest = { ...GOOD(), lastFour: null, totals: { prevDue: 0, paidAndRefund: 0, newCharges: 300, due: 300 }, adjustments: [],
    transactions: [
      { date: '2026-07-03', postDate: null, desc: '甲店', amount: 100 },
      { date: '2026-07-04', postDate: null, desc: '乙店', amount: 200 },
    ] };
  const hp = normalizeAiCard(honest);
  assertAiCardGrounded(hp, text);
  reconcileAiCard(hp);
  const forged = { ...honest, totals: { prevDue: 0, paidAndRefund: 0, newCharges: 100200, due: 100200 },
    transactions: [{ date: '2026-07-03', postDate: null, desc: '幻影店', amount: 100200 }] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(forged), text)), 'ai_bad_answer',
    '★句讀合成的 100200 不是帳單印的數字');
  // r7#1：不只全形逗號——**任何** NFKC 後是逗號的字元都是句讀（U+FE50 小逗號、U+FE10 直排逗號
  // 這類親戚，列舉字元表必漏）
  for (const punct of ['﹐', '︐']) {
    const t2 = text.replace('100，200', `100${punct}200`);
    assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(forged), t2)), 'ai_bad_answer',
      `★U+${punct.codePointAt(0).toString(16).toUpperCase()} 也折成逗號——通則不是字元表`);
    assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(honest), t2)), null, '誠實的 100 與 200 照樣接得到地');
  }
  // 對照：ASCII 逗號的真千分位（帳單本來的印法）照收——摘要與明細各印各的、位置夠分
  const textReal = [
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 100,200 本期應繳總額 100,200',
    '真的大額 100,200',
  ].join('\n');
  const big = { ...honest, totals: { prevDue: 0, paidAndRefund: 0, newCharges: 100200, due: 100200 },
    transactions: [{ date: '2026-07-03', postDate: null, desc: '真的大額', amount: 100200 }] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(big), textReal)), null,
    '★ASCII 逗號＝真千分位、不可誤殺');
});

test('提示詞｜抵銷對也要抄（r6#1 的提示詞半邊）：加總制驗算看不到正負互抵的整組漏抄', () => {
  assert.ok(buildCardSystem().includes('互相抵銷'), '★提示詞要明令：兩筆恰好互抵的交易都要抄');
});

test('提示詞｜繳款退款字樣不可互抄（r8#1 的提示詞半邊）：這兩種字樣決定那筆要不要入帳', () => {
  assert.ok(buildCardSystem().includes('不要把退款寫成繳款'), '★desc 不接地——字樣抄錯＝退款被當繳款漏掉');
});

test('接地｜句讀逗號湊成合法千分位（r5#2）：「100， 200」不得拼成幻影 100200；兩個真金額照樣接得到地', () => {
  const text = [
    '上期應繳總額 0 已繳款退款金額 0 本期新增款項 300 本期應繳總額 300',
    '消費清單 100， 200',
  ].join('\n');
  // 誠實：100 與 200 各自是印出來的金額（句讀讀法）＝過三關
  const honest = { ...GOOD(), lastFour: null, totals: { prevDue: 0, paidAndRefund: 0, newCharges: 300, due: 300 }, adjustments: [],
    transactions: [
      { date: '2026-07-03', postDate: null, desc: '甲店', amount: 100 },
      { date: '2026-07-04', postDate: null, desc: '乙店', amount: 200 },
    ] };
  const hp = normalizeAiCard(honest);
  assertAiCardGrounded(hp, text);
  reconcileAiCard(hp);
  // 攻擊：宣稱帳單印過 100200（兩段都能獨立成數＝當句讀讀、不拼）
  const forged = { ...honest, totals: { prevDue: 0, paidAndRefund: 0, newCharges: 100200, due: 100200 },
    transactions: [{ date: '2026-07-03', postDate: null, desc: '幻影店', amount: 100200 }] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(forged), text)), 'ai_bad_answer',
    '★「100，」＋「200」拼下去＝憑空登記帳單沒印過的數字（r5 的誤收路）');
});

test('接地｜符號嚴格、無絕對值後備（r1#2 的另一個方向）：帳單印正數、AI 宣稱負數＝擋', () => {
  // 消費被讀成退款：單筆會被 G2 擋，但**成對反轉會在 G2 互相抵消**——接地是唯一每筆獨立把關的位置，
  // 放寬成「配絕對值也算」這裡就破了（突變演練⑯抓到的洞，2026-08-30）。
  const g = GOOD(); g.transactions[0].amount = -150;   // TEXT 只印正的 150
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(g), TEXT)), 'ai_bad_answer',
    '★負數宣稱不可以借正數 token（尾綴負號印法會被誤擋＝已在檔頭照實劃界，寧擋勿收）');
});

test('接地｜lastFour 也要在原文出現（憑空編末四碼＝ai_bad_answer）', () => {
  const p = normalizeAiCard({ ...GOOD(), lastFour: '9999' });
  assert.equal(codeOf(() => assertAiCardGrounded(p, TEXT)), 'ai_bad_answer');
});

test('接地｜千分位與拆 cell 拼接：1,000 印成「1, 000」（同列相鄰 token）也接得回來', () => {
  const p = normalizeAiCard(GOOD());
  const brokenText = TEXT.replace('上期應繳總額 1,000', '上期應繳總額 1, 000');
  assertAiCardGrounded(p, brokenText);   // 不丟＝拼接有效
});

test('接地｜拼接不產生免費籌碼（r2#1）：拼出來的值與組成 token 共用實體位置', () => {
  // 摘要列「0 0 100 100」相鄰只隔空白 ⇒「0」+「100」會拼出第三個 100；拼接若「額外加入」
  // 而不共用位置，一筆日期店名都憑空的 100 明細可借它同時過接地、G1、G2（Codex r2 最小重現）。
  const text = [
    '測試商業銀行 信用卡帳單 卡號末四碼 1234',
    '0 0 100 100',
    '115/07/03 真的店 100',
  ].join('\n');
  const answer = { ...GOOD(), lastFour: '1234', totals: { prevDue: 0, paidAndRefund: 0, newCharges: 100, due: 100 },
    adjustments: [], transactions: [
      { date: '2026-07-03', postDate: null, desc: '真的店', amount: 100 },
      { date: '2026-07-04', postDate: null, desc: '憑空的店', amount: 100 },
    ] };
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(answer), text)), 'ai_bad_answer',
    '★摘要與真明細占完位置之後，憑空的第二筆 100 沒有位置可借（拼接組的兩格都已被占）');
  // 對照：誠實的一筆 ⇒ 過（位置夠分）
  const one = { ...answer, transactions: [answer.transactions[0]] };
  assertAiCardGrounded(normalizeAiCard(one), text);
});

test('驗算｜等式閘：具名調整（利息）摺進等式才平——這正是「天真版比錯了東西」的修法（裁示①三層的第一層）', () => {
  // GOOD：1000 − 1000 ＋ 450 ＋ 30(利息) ＝ 480 ✓
  reconcileAiCard(normalizeAiCard(GOOD()));
  // 把利息從 adjustments 拿掉 ⇒ 等式差 30 ⇒ 擋
  const g = GOOD(); g.adjustments = [];
  assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(g))), 'ai_reconcile_failed');
});

test('驗算｜加總閘（慣例閘）：漏抄一筆＝兩種印法都對不上＝擋；訊息只帶差額與筆數、不回聲帳單原值', () => {
  const g = GOOD(); g.transactions = g.transactions.slice(0, 2);   // 漏掉 -50 那筆 ⇒ Σ=500 vs 450
  let msg = '';
  try { reconcileAiCard(normalizeAiCard(g)); } catch (e) { msg = String(/** @type {any} */ (e).message); assert.equal(/** @type {any} */ (e).code, 'ai_reconcile_failed'); }
  assert.match(msg, /差 50 元/, '★要說明差多少（裁示②的白話說明；兩種印法各報各的差額）');
  assert.doesNotMatch(msg, /450|480|1,?000/, '★不回聲帳單的原始金額（機密紀律；差額是衍生值、單獨回推不出內容）');
});

test('驗算｜慣例閘（裁示③2026-08-30；r1#1 收緊）：兩種退款印法各自全對才收其一', () => {
  // 慣例 B 全列版：桶 1050 ＝ 繳款 1000（有列）＋退款 50（有列）；本期新增＝純消費 500
  const B = { ...GOOD(), totals: { prevDue: 1000, paidAndRefund: 1050, newCharges: 500, due: 480 },
    adjustments: [{ label: '循環信用利息', amount: 30, date: null }],
    transactions: [...GOOD().transactions, { date: '2026-07-05', postDate: null, desc: '信用卡自動扣繳', amount: -1000 }] };
  reconcileAiCard(normalizeAiCard(B));   // 等式 1000−1050+500+30=480 ✓；B 式 500==500、1000+50==1050 ✓
  // r8 攻擊在 A 慣例下（GOOD）：退款 -50 被抄成繳款字樣 ⇒ 消費和少了退款的抵減、兩式全紅
  const atk = GOOD(); atk.transactions[2] = { ...atk.transactions[2], desc: '信用卡自動扣繳' };
  assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(atk))), 'ai_reconcile_failed',
    '★退款被抄成繳款（A 慣例）＝擋——這是慣例閘真正擋得住的那一型');
  // 繳款有列出來就要對得上（A 的缺席放行只給 payAbs===0）
  const listed = GOOD(); listed.totals.paidAndRefund = 1000;
  listed.transactions = [...listed.transactions, { date: '2026-07-05', postDate: null, desc: '信用卡自動扣繳', amount: -999 }];
  assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(listed))), 'ai_reconcile_failed',
    '★繳款列有印（-999）就要對上摘要的 1000——差 1 也擋（容差 0）');
  // r1#1 的收緊：B 的「不等式缺席放行」拿掉——桶裡有沒列的繳款＋有列的退款＝混桶、驗不了＝擋
  const partial = { ...GOOD(), totals: { prevDue: 1000, paidAndRefund: 1050, newCharges: 500, due: 480 },
    adjustments: [{ label: '循環信用利息', amount: 30, date: null }] };
  assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(partial))), 'ai_reconcile_failed',
    '★refundAbs(50)≠桶(1050) 且繳款缺席——舊版不等式會放行、r1#1 攻擊正是鑽這條（fail-closed 誤擋照實認）');
  // r1#1 誠實劃界的釘子：整筆繳款被抄成退款、金額恰等於桶＝算術不可區分＝**會過**（已文件化的盲點）
  const blind = { ...GOOD(), totals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 500, due: 500 },
    adjustments: [], transactions: [
      { date: '2026-07-03', postDate: null, desc: '星巴克', amount: 500 },
      { date: '2026-07-05', postDate: null, desc: '感謝您的支持', amount: -1000 },   // 真身是繳款、字樣抄壞
    ] };
  reconcileAiCard(normalizeAiCard(blind));   // 不丟＝盲點如實存在（改成會丟＝這題轉紅提醒重寫劃界）
});

test('驗算｜加總閘排除繳款列（r1#4，同模板路 finalize／中閘的那把尺）：明細裡有繳款的合法帳單不可誤擋', () => {
  // 很多帳單把「已繳款」列在明細區；「本期新增款項」卻不含繳款——不排除的話帳單全對也必然開紅。
  const g = GOOD();
  g.transactions = [...g.transactions, { date: '2026-07-05', postDate: null, desc: '信用卡自動扣繳', amount: -1000 }];
  reconcileAiCard(normalizeAiCard(g));   // Σ(不含繳款)＝450＝newCharges ⇒ 過；不排除會差 1000
  // 判準同模板：要「負數＋繳款字樣」兩個條件都成立才排除——正數列即使叫繳款也照算（單向、不多排）
  const g2 = GOOD();
  g2.transactions = [...g2.transactions, { date: '2026-07-05', postDate: null, desc: '信用卡自動扣繳', amount: 1000 }];
  assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(g2))), 'ai_reconcile_failed');
});

test('驗算｜四格摘要缺任一＝驗算不了＝不收（加嚴的定義；★6 不放寬）', () => {
  for (const f of /** @type {const} */ (['prevDue', 'paidAndRefund', 'newCharges', 'due'])) {
    const g = GOOD(); g.totals[f] = null;
    assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(g))), 'ai_reconcile_failed', `★缺 ${f} 沒被擋`);
  }
  // ★缺兩格互相抵消也要擋（突變演練抓到的洞，2026-08-30）：單缺一格時 null→0 讓等式自己不平、
  //   等式閘會「代打」擋下——上面那圈其實沒證明缺格閘存在。這組 prevDue 與 paidAndRefund 同缺
  //   ＝ 0−0 抵消、等式假平衡（0−0＋450＋30＝480 ✓），只有缺格閘本人擋得住。
  const g2 = GOOD(); g2.totals.prevDue = null; g2.totals.paidAndRefund = null;
  assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(g2))), 'ai_reconcile_failed', '★缺格閘被等式閘掩護＝形同不存在');
});

test('驗算｜容差＝0（裁示①2026-08-30）：分毫不差才收——差 1 元也擋', () => {
  const g1 = GOOD(); g1.totals.due = 481;   // 等式差 1 ⇒ 首版（容差 1）會收，現在擋
  assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(g1))), 'ai_reconcile_failed',
    '★帳單自己是自洽的：整數相加必然全等；留 1 元＝恰差 1 元的漏抄/多抄看不到（Grok 掃#1 的洞由裁示①關上）');
  assert.equal(CARD_TOLERANCE, 0);
});

test('提示詞｜四條鐵則與關鍵語意都在（只抄不猜／原文照抄／一列一筆／民國換算；具名列進 adjustments）', () => {
  const sys = buildCardSystem();
  for (const kw of ['只抄不猜', '原文照抄', '一列一筆', '民國', 'adjustments', '絕不自己加總', '不可合併']) {
    assert.ok(sys.includes(kw), `提示詞少了「${kw}」`);
  }
});

test('形狀｜schema 必填欄與模型階梯（單讀＝裁示②：只有 primary/escalation 兩段，沒有雙讀欄）', () => {
  assert.deepEqual(AI_CARD_SCHEMA.required, ['issuer', 'lastFour', 'statementMonth', 'totals', 'adjustments', 'transactions']);
  assert.deepEqual(Object.keys(AI_CARD_MODELS), ['primary', 'escalation']);
});
