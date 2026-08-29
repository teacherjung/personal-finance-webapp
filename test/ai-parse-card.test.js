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

test('接地｜答案卷上的每個金額都要在原文出現過：臆測的金額＝ai_bad_answer', () => {
  const g = GOOD(); g.transactions[0].amount = 151;   // 原文只有 150
  const p = normalizeAiCard(g);
  assert.equal(codeOf(() => assertAiCardGrounded(p, TEXT)), 'ai_bad_answer');
  // totals 與 adjustments 也在接地射程內
  const g2 = GOOD(); g2.totals.due = 481;
  assert.equal(codeOf(() => assertAiCardGrounded(normalizeAiCard(g2), TEXT.replace('本期應繳總額 480', '本期應繳總額 480'))), 'ai_bad_answer');
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

test('驗算｜加總閘：Σ明細 ≈ 本期新增；漏抄一筆＝擋，且訊息只帶差額與筆數、不回聲帳單原值', () => {
  const g = GOOD(); g.transactions = g.transactions.slice(0, 2);   // 漏掉 -50 那筆 ⇒ Σ=500 vs 450
  let msg = '';
  try { reconcileAiCard(normalizeAiCard(g)); } catch (e) { msg = String(/** @type {any} */ (e).message); assert.equal(/** @type {any} */ (e).code, 'ai_reconcile_failed'); }
  assert.match(msg, /差了 50 元/, '★要說明差多少（裁示②的白話說明）');
  assert.doesNotMatch(msg, /450|480|1,?000/, '★不回聲帳單的原始金額（機密紀律；差額是衍生值、單獨回推不出內容）');
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

test('驗算｜容差＝1 元（吸收去尾差；差 2 元就要擋）', () => {
  const g1 = GOOD(); g1.totals.due = 481;   // 等式差 1 ⇒ 收
  reconcileAiCard(normalizeAiCard(g1));
  const g2 = GOOD(); g2.totals.due = 482;   // 差 2 ⇒ 擋
  assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(g2))), 'ai_reconcile_failed');
  assert.equal(CARD_TOLERANCE, 1);
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
