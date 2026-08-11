// @ts-check
// 匯入對帳閘（P0）考題：lib/statement-reconcile.js 純函式全情境＋服務層接縫＋端到端擋下。
//
// 三層各測什麼、為什麼缺一不可：
//   ①純函式（reconcileBankStatement/reconcileCardStatement）——判準本體：接得上/接不上、
//     缺數字要誠實 skip 不可誤擋、容差邊界（±1／0.005）。
//   ②接縫（assertBankReconciled/assertCardReconciled）——「裁決→400」那一步：status、白話訊息。
//   ③端到端（合成 XLSX → previewForCard/previewAuto）——**閘有沒有真的接在入口上**。
//     statement-pipeline.test.js 的教訓：兩端各自有考題不等於整條線會動；擋下型功能更是——
//     接縫沒接上時整個閘就是空包彈（靜靜通過最危險）。銀行入口吃 PDF、測試合成不了，
//     故銀行端到端＝assert 接縫考題＋真帳單本機煙霧測（同 bank-statement.test.js 的既有劃界）。
//
// 假資料鐵則（收支契約）：帳號一律用明顯假值（900100****3301 系），絕不複製真帳單遮罩末碼。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import * as XLSX from 'xlsx';

const TEST_STORE = join(tmpdir(), `finance-reconcile-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { reconcileBankStatement, reconcileCardStatement, gateFailureMessage } = await import('../lib/statement-reconcile.js');
const { extractStatementTotals, extractStatementDue } = await import('../lib/statement.js');
const { assertBankReconciled } = await import('../lib/services/bank-import.js');
const { previewAuto, previewForCard, assertCardReconciled } = await import('../lib/services/statement-import.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

// ---------- ① 強閘（銀行）純函式 ----------

/** 合成一筆銀行交易（假帳號 900100****3301）。 @param {Partial<import('../lib/bank-statement.js').BankTx>} o */
const btx = (o) => ({ acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-07-01', summary: '轉帳存入',
  direction: /** @type {'in'|'out'} */ ('in'), amount: 100, balance: null, note: '', ...o });

/** 乾淨的兩帳戶交錯明細：A（3301）三筆、B（3302）兩筆，餘額鏈全接得上。 */
function cleanBankParsed() {
  return {
    accounts: [{ masked: '900100****3301', balance: 10300 }],
    transactions: [
      btx({ date: '2026-07-01', summary: '轉帳存入', direction: 'in', amount: 1000, balance: 10000 }),
      btx({ acctMasked: '900200****3302', acctSuffix: '3302', date: '2026-07-01', direction: 'in', amount: 500, balance: 5000 }),
      btx({ date: '2026-07-02', summary: '轉帳存入', direction: 'in', amount: 500, balance: 10500 }),
      btx({ acctMasked: '900200****3302', acctSuffix: '3302', date: '2026-07-03', summary: 'CD提款', direction: 'out', amount: 1000, balance: 4000 }),
      btx({ date: '2026-07-03', summary: '跨行手續費', direction: 'out', amount: 200, balance: 10300 }),
    ],
  };
}

test('強閘｜餘額鏈全接得上＝strong 通過；帳戶交錯不互相污染、末筆對得上概要區', () => {
  const v = reconcileBankStatement(cleanBankParsed());
  assert.equal(v.ok, true);
  assert.equal(v.level, 'strong');
  assert.equal(v.checks.chain, 'pass');
  assert.equal(v.checks.endBalance, 'pass');
  assert.equal(v.stats.pairsChecked, 3, 'A 帳戶 2 對＋B 帳戶 1 對＝3（交錯列要先按完整遮罩帳號分組再配對）');
  assert.equal(v.stats.endChecked, 1);
});

test('強閘｜金額讀錯＝擋下，訊息帶帳戶末碼、日期與差額（使用者要能照著找到那一筆）', () => {
  const p = cleanBankParsed();
  p.transactions[4].amount = 250;   // 帳上餘額差是 200，解析卻讀成 250
  const v = reconcileBankStatement(p);
  assert.equal(v.ok, false);
  assert.equal(v.checks.chain, 'fail');
  const msg = v.problems[0].message;
  assert.match(msg, /\*\*\*\*3301/);
  assert.match(msg, /2026-07-03/);
  assert.match(msg, /差 50/);
});

test('強閘｜中間漏讀一筆（解析器對看不懂的列是靜默 continue）＝鏈接不起來、擋下', () => {
  const p = cleanBankParsed();
  p.transactions.splice(2, 1);   // 抽掉 A 帳戶中間那筆存入 500——正是「靜默跳過」會發生的事
  const v = reconcileBankStatement(p);
  assert.equal(v.ok, false, '10,000 → (支出 200) → 10,300 接不上，必須擋');
});

test('強閘｜方向讀反＝擋下（餘額往上走卻標成支出）', () => {
  const p = cleanBankParsed();
  p.transactions[2].direction = 'out';   // 實際 +500（10,000→10,500）
  const v = reconcileBankStatement(p);
  assert.equal(v.ok, false);
});

test('強閘｜末筆餘額與概要區對不上＝擋下（期末漏讀交易的鏡像檢查）', () => {
  const p = cleanBankParsed();
  p.accounts[0].balance = 10800;   // 概要說 10,800、明細末筆只到 10,300
  const v = reconcileBankStatement(p);
  assert.equal(v.ok, false);
  assert.equal(v.checks.endBalance, 'fail');
  assert.match(v.problems[0].message, /概要區/);
  assert.match(v.problems[0].message, /差 500/);
});

test('強閘｜整份讀不到餘額＝誠實降級 weak、照舊放行（沒數字可對≠對不上）', () => {
  const p = cleanBankParsed();
  p.accounts = [];
  for (const t of p.transactions) t.balance = null;
  const v = reconcileBankStatement(p);
  assert.equal(v.ok, true);
  assert.equal(v.level, 'weak');
  assert.equal(v.checks.chain, 'skip');
  assert.equal(v.checks.endBalance, 'skip');
  assert.equal(v.stats.pairsSkipped, 3);
});

test('強閘｜單筆餘額讀不到＝只跳過相鄰兩對、其餘照驗（部分可驗仍是 strong）', () => {
  const p = cleanBankParsed();
  p.transactions[2].balance = null;   // A 帳戶中間那筆讀不到餘額
  const v = reconcileBankStatement(p);
  assert.equal(v.ok, true);
  assert.equal(v.level, 'strong');
  assert.equal(v.stats.pairsChecked, 1, 'A 的兩對都缺一端＝跳過，只剩 B 的 1 對');
  assert.equal(v.stats.pairsSkipped, 2);
});

test('強閘｜外幣兩位小數：0.005 內的修圓縫放行、超過就擋', () => {
  const rows = (/** @type {number} */ endBal) => ({ accounts: [], transactions: [
    btx({ acctMasked: '900300****363', acctSuffix: '363', balance: 100.25 }),
    btx({ acctMasked: '900300****363', acctSuffix: '363', date: '2026-07-02', direction: 'in', amount: 10.10, balance: endBal }),
  ] });
  assert.equal(reconcileBankStatement(rows(110.35)).ok, true);
  assert.equal(reconcileBankStatement(rows(110.36)).ok, false, '差 0.01＞0.005＝真的對不上');
});

test('強閘｜同末碼不同前綴＝不同帳戶，分開驗鏈（混算會誤擋）', () => {
  const v = reconcileBankStatement({ accounts: [], transactions: [
    btx({ acctMasked: '900100****3301', balance: 10000 }),
    btx({ acctMasked: '900200****3301', balance: 99 }),                                        // 另一個帳戶，餘額天差地遠
    btx({ acctMasked: '900100****3301', date: '2026-07-02', direction: 'out', amount: 400, balance: 9600 }),
    btx({ acctMasked: '900200****3301', date: '2026-07-02', direction: 'in', amount: 1, balance: 100 }),
  ] });
  assert.equal(v.ok, true, '按完整遮罩帳號分組：兩條鏈各自都接得上');
  assert.equal(v.stats.pairsChecked, 2);
});

// ---------- ① 中閘（信用卡）純函式 ----------

/** 中閘的標準情境：摘要四格平衡（10,449−2,449+450＝8,450）、明細加總對得上。
 * 四格刻意互不相同——成對相等（繳清型帳單）會遮住「等式的項被接錯/對調」型的壞法。 */
const cardOk = () => ({
  statementTotals: { due: 8450, prevDue: 10449, paidAndRefund: 2449, newCharges: 450 },
  transactions: [{ amount: 300 }, { amount: 150 }, { amount: -2449 }],
});

test('中閘｜四格平衡＋明細對得上＝medium 三檢查全過', () => {
  const v = reconcileCardStatement(cardOk());
  assert.equal(v.ok, true);
  assert.equal(v.level, 'medium');
  assert.deepEqual(v.checks, { equation: 'pass', newVsRows: 'pass', paidVsRows: 'pass' });
  assert.equal(v.stats.sumPos, 450);
  assert.equal(v.stats.sumNegAbs, 2449);
});

test('中閘｜摘要等式不平＝擋下（四格至少一格讀錯；銀行印的那行天生是平的）', () => {
  const p = cardOk();
  p.statementTotals.due = 2000;   // 10,449−2,449+450＝8,450 ≠ 2,000
  const v = reconcileCardStatement(p);
  assert.equal(v.ok, false);
  assert.equal(v.checks.equation, 'fail');
  assert.match(v.problems[0].message, /等式不平/);
  assert.match(v.problems[0].message, /差 6,450/);
});

test('中閘｜明細少一筆＝正項加總對不上「本期新增款項」、擋下（閘的主要獵物）', () => {
  const p = cardOk();
  p.transactions = [{ amount: 300 }, { amount: -2449 }];   // 150 那筆被漏讀
  const v = reconcileCardStatement(p);
  assert.equal(v.ok, false);
  assert.equal(v.checks.newVsRows, 'fail');
  assert.match(v.problems[0].message, /本期新增款項/);
  assert.match(v.problems[0].message, /差 150/);
});

test('中閘｜繳款/退款列漏讀＝負項加總對不上、擋下', () => {
  const p = cardOk();
  p.transactions = [{ amount: 300 }, { amount: 150 }];   // 繳款 −2,449 被漏讀
  const v = reconcileCardStatement(p);
  assert.equal(v.ok, false);
  assert.equal(v.checks.paidVsRows, 'fail');
  assert.match(v.problems.map((x) => x.message).join(''), /已繳款＋退款/);
});

test('中閘｜整數帳單容 ±1 進位差；差 2 就擋（容差不可寬到吞掉真錯）', () => {
  const off = (/** @type {number} */ d) => {
    const p = cardOk();
    p.statementTotals.newCharges = 450 + d;
    p.statementTotals.prevDue = 10449 - d;   // 等式維持平衡，只讓「明細 vs 新增款項」差 d
    return reconcileCardStatement(p);
  };
  assert.equal(off(1).ok, true, '±1＝帳單進位，放行');
  assert.equal(off(2).ok, false, '±2＝真的對不上');
});

test('中閘｜讀不到任何總額（台新官網 XLSX 沒印）＝weak 全 skip、照舊放行', () => {
  const v = reconcileCardStatement({ statementTotals: { due: null, prevDue: null, paidAndRefund: null, newCharges: null },
    transactions: [{ amount: 300 }] });
  assert.equal(v.ok, true);
  assert.equal(v.level, 'weak');
  assert.deepEqual(v.checks, { equation: 'skip', newVsRows: 'skip', paidVsRows: 'skip' });
});

test('中閘｜只讀到應繳金額一格＝沒有可交叉的數字、weak 放行（缺格不可誤擋）', () => {
  const v = reconcileCardStatement({ statementTotals: { due: 46299, prevDue: null, paidAndRefund: null, newCharges: null },
    transactions: [{ amount: 150 }, { amount: 300 }] });
  assert.equal(v.ok, true);
  assert.equal(v.level, 'weak', '應繳≠匯入淨額本就不同（含上期未繳/分期/年費），單獨一格不可拿來對明細');
});

// ---------- ① 中閘四格抽取（extractStatementTotals） ----------

// ⚠️ 四格數字**刻意互不相同**（且等式仍平：10,449−2,449+50,459＝58,459）：
// 真帳單常見「上期＝已繳」「新增＝應繳」成對相等（繳清型），拿那種數字當考題，
// 抽取器把格對到隔壁欄（序數右移一格的老病）考題會看不出來——自己驗過的假綠不再犯。
const TAISHIN_EQ_TEXT = [
  '台新銀行 信用卡帳單',
  '上期應款總額 - (已繳款金額+本期退款) + 本期新增款項 = 本期累計應繳金額 本期最低應繳金額',
  '10,449 2,449 50,459 58,459 8,257',
].join('\n');

test('四格抽取｜台新郵寄版等式行：依欄位序數對位，四格全中、與 extractStatementDue 同值', () => {
  const t = extractStatementTotals(TAISHIN_EQ_TEXT);
  assert.deepEqual(t, { due: 58459, prevDue: 10449, paidAndRefund: 2449, newCharges: 50459 });
  assert.equal(extractStatementDue(TAISHIN_EQ_TEXT), 58459, '共用同一副機關＝同值（refactor 不可改變 due 行為）');
});

test('四格抽取｜括號組被 PDF 拆開（掉了 +）也要中：「已繳款金額」子字串鍵接得住併回的標籤', () => {
  const text = [
    '上期應款總額 - (已繳款金額 本期退款) + 本期新增款項 = 本期累計應繳金額 本期最低應繳金額',
    '10,449 2,449 50,459 58,459 8,257',
  ].join('\n');
  assert.equal(extractStatementTotals(text).paidAndRefund, 2449);
});

test('四格抽取｜同一行版面（富邦式）各自命中；沒印的格＝null 不硬猜', () => {
  const t = extractStatementTotals('本期應繳總額：12,345\n上期應繳金額：10,000\n已繳款金額：9,000');
  assert.deepEqual(t, { due: 12345, prevDue: 10000, paidAndRefund: 9000, newCharges: null });
  assert.deepEqual(extractStatementTotals('2026/07 信用卡明細 星巴克 150'),
    { due: null, prevDue: null, paidAndRefund: null, newCharges: null }, '什麼欄位都沒有＝全 null');
});

// ---------- ② 服務層接縫（裁決→400） ----------

test('接縫｜assertBankReconciled：對不上＝throw status 400＋白話訊息；對得上＝回裁決', () => {
  const bad = cleanBankParsed();
  bad.transactions[4].amount = 250;
  assert.throws(() => assertBankReconciled(bad), (/** @type {any} */ e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /對帳沒過，這份銀行對帳單先不匯入/);
    assert.match(e.message, /回報/, '擋下一定要告訴使用者下一步，不能只說不行');
    return true;
  });
  assert.equal(assertBankReconciled(cleanBankParsed()).level, 'strong');
});

test('接縫｜assertCardReconciled：同款；訊息最多列 3 處、其餘計數', () => {
  const bad = cardOk();
  bad.statementTotals = { due: 1, prevDue: 2, paidAndRefund: 3, newCharges: 4 };   // 三道全炸
  assert.throws(() => assertCardReconciled(bad), (/** @type {any} */ e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /信用卡帳單/);
    return true;
  });
  const many = { ok: false, level: /** @type {const} */ ('strong'), checks: {},
    problems: [1, 2, 3, 4, 5].map((i) => ({ code: 'x', message: `第${i}處` })), stats: {} };
  assert.match(gateFailureMessage(many, '銀行對帳單'), /還有 2 處對不上/);
});

// ---------- ③ 端到端：合成 XLSX 走真解析器 → 預覽入口要真的擋 ----------

/** 合成「台新官網下載」格式 XLSX＋注入郵寄版的摘要等式行（走真解析器，不是假資料注入）。
 * @param {{prev:string, paid:string, add:string, due:string}} eq 等式四格 @param {any[][]} txRows */
function xlsxB64(eq, txRows) {
  const aoa = [
    ['台新銀行 信用卡明細'],
    ['帳單結帳日：115/07/04'],
    ['卡號末四碼 5678'],
    ['上期應款總額', '-', '(已繳款金額+本期退款)', '+', '本期新增款項', '=', '本期累計應繳金額', '本期最低應繳金額'],
    [eq.prev, eq.paid, eq.add, eq.due, '100'],
    ['消費日', '入帳日', '說明', '', '金額', '', '', '外幣'],
    ...txRows,
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return Buffer.from(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))).toString('base64');
}

// 繳款 −2,449 讓「已繳/退款」與「上期」互不相同（同上面 TAISHIN_EQ_TEXT 的理由：成對相等會遮住接錯格）
const TX_OK = [
  ['2026/07/02', '2026/07/03', '星巴克', '', '300', '', '', ''],
  ['2026/07/05', '2026/07/06', '全聯', '', '150', '', '', ''],
  ['2026/07/06', '2026/07/07', '信用卡自動扣繳', '', '-2,449', '', '', ''],
];

beforeEach(() => {
  store.save({ ...store.emptyDb(),
    cards: [{ id: 'c1', name: '台新卡', type: 'credit', issuer: '台新銀行', lastFour: '5678' }] });
});

test('端到端｜一致的帳單：預覽照常，回應帶 reconcile（medium、明細對總額 pass）', async () => {
  const r = await previewForCard('c1', xlsxB64({ prev: '10,449', paid: '2,449', add: '450', due: '8,450' }, TX_OK));
  assert.equal(r.reconcile.level, 'medium');
  assert.equal(r.reconcile.ok, true);
  assert.equal(r.reconcile.checks.newVsRows, 'pass');
  assert.equal(r.statementDue, 8450, 'statementDue 照舊要交出來（改走 totals.due 不可弄丟它）');
  assert.equal(r.statementMonth, '2026-07');
  assert.ok(r.transactions.length >= 2);
});

test('端到端｜明細與「本期新增款項」對不上：previewForCard 就地 400 擋下（閘真的接在入口上）', async () => {
  // 等式自平（10,449−2,449+550＝8,550）、但明細只有 450 ⇒ 只有 newVsRows 炸＝精準驗到那一道
  const b64 = xlsxB64({ prev: '10,449', paid: '2,449', add: '550', due: '8,550' }, TX_OK);
  await assert.rejects(previewForCard('c1', b64), (/** @type {any} */ e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /對帳沒過/);
    assert.match(e.message, /本期新增款項/);
    assert.match(e.message, /差 100/);
    return true;
  });
});

test('端到端｜免選卡那條路（previewAuto）同樣要擋、同樣要帶 reconcile', async () => {
  await assert.rejects(previewAuto(xlsxB64({ prev: '10,449', paid: '2,449', add: '550', due: '8,550' }, TX_OK)),
    (/** @type {any} */ e) => { assert.equal(e.status, 400); assert.match(e.message, /對帳沒過/); return true; });
  const r = await previewAuto(xlsxB64({ prev: '10,449', paid: '2,449', add: '450', due: '8,450' }, TX_OK));
  assert.ok(r.resolvedCard, '末四碼 5678 唯一命中→自動歸卡');
  assert.equal(r.reconcile.level, 'medium');
});

test('端到端｜沒印總額的帳單（今日的官網 XLSX）＝weak 照舊放行，模板解析器行為不變', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['台新銀行 信用卡明細'], ['帳單結帳日：115/07/04'], ['卡號末四碼 5678'],
    ['消費日', '入帳日', '說明', '', '金額', '', '', '外幣'],
    ...TX_OK,
  ]), 'Sheet1');
  const b64 = Buffer.from(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))).toString('base64');
  const r = await previewForCard('c1', b64);
  assert.equal(r.reconcile.level, 'weak');
  assert.equal(r.reconcile.ok, true);
});
