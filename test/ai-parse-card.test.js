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

test('驗收｜totals 抄了負號＝取絕對值（符號由程式定、不由 AI 定——同遮罩符號的前例）', () => {
  const g = GOOD();
  g.totals.paidAndRefund = -1000;   // 有的帳單把已繳款印成負數
  const p = normalizeAiCard(g);
  assert.equal(p.statementTotals.paidAndRefund, 1000);
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

test('接地｜lastFour 也要在原文出現（憑空編末四碼＝ai_bad_answer）', () => {
  const p = normalizeAiCard({ ...GOOD(), lastFour: '9999' });
  assert.equal(codeOf(() => assertAiCardGrounded(p, TEXT)), 'ai_bad_answer');
});

test('接地｜千分位與拆 cell 拼接：1,000 印成「1, 000」（同列相鄰 token）也接得回來', () => {
  const p = normalizeAiCard(GOOD());
  const brokenText = TEXT.replace('上期應繳總額 1,000', '上期應繳總額 1, 000');
  assertAiCardGrounded(p, brokenText);   // 不丟＝拼接有效
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

test('驗算｜四格摘要缺任一＝驗算不了＝不收（加嚴的定義；★6 不放寬）', () => {
  for (const f of /** @type {const} */ (['prevDue', 'paidAndRefund', 'newCharges', 'due'])) {
    const g = GOOD(); g.totals[f] = null;
    assert.equal(codeOf(() => reconcileAiCard(normalizeAiCard(g))), 'ai_reconcile_failed', `★缺 ${f} 沒被擋`);
  }
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
