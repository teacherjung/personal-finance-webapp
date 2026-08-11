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
const { getDb } = await import('../lib/repo.js');
const { reconcileBankStatement, reconcileCardStatement, gateFailureMessage } = await import('../lib/statement-reconcile.js');
const { extractStatementTotals, extractStatementDue } = await import('../lib/statement.js');
const { assertBankReconciled, previewBankStatement, applyBankStatement, importBankTxToDb } = await import('../lib/services/bank-import.js');
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

test('強閘｜真正的末筆餘額讀不到＝endBalance skip——不可拿較早的餘額冒充末筆（r1#2）', () => {
  // 較早餘額（10,500）之後還有一筆支出沒印餘額：帳戶真實期末≠10,500。
  // 舊寫法會拿 10,500 去對概要的 10,300 → 把「缺數字」誤報成「不一致」擋下合法帳單。
  const p = cleanBankParsed();
  p.transactions[4].balance = null;   // A 帳戶最後一筆（支出 200）的餘額欄讀不到
  p.accounts[0].balance = 10300;      // 概要印的是真期末
  const v = reconcileBankStatement(p);
  assert.equal(v.ok, true, '缺數字＝skip，不是不一致');
  assert.equal(v.checks.endBalance, 'skip');
  assert.equal(v.stats.endChecked, 0);
});

test('強閘｜已知界線（r1#3，誠實揭露）：每帳戶第一筆的金額/方向驗不到，stats 要照實計數', () => {
  // 期初餘額目前沒有抽取＝「期初＋Σ進出＝期末」尚未實作：首筆金額被讀壞、它自己印的餘額
  // 沒壞時，鏈從首筆餘額起錨照樣全綠。這一題**釘住這條界線**（模組檔頭①、契約與計畫同步揭露）；
  // 日後補上期初抽取時，本題改寫成「首筆也要轉紅」。
  const p = cleanBankParsed();
  p.transactions[0].amount = 999999;   // 首筆金額天差地遠，但 balance 10,000 沒動
  const v = reconcileBankStatement(p);
  assert.equal(v.ok, true, '首筆不在鏈上＝目前驗不到（已知界線，非保證）');
  assert.equal(v.level, 'strong');
  assert.equal(v.stats.firstRowsUnverified, 2, '兩個帳戶＝兩筆「驗不到的首筆」要誠實計數');
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

test('強閘｜小數餘額：0.005 內的修圓縫放行、超過就擋（帳單查無幣別＝比照台幣驗，P0.1 後仍受驗）', () => {
  const rows = (/** @type {number} */ endBal) => ({ accounts: [], transactions: [
    btx({ acctMasked: '900300****363', acctSuffix: '363', balance: 100.25 }),
    btx({ acctMasked: '900300****363', acctSuffix: '363', date: '2026-07-02', direction: 'in', amount: 10.10, balance: endBal }),
  ] });
  assert.equal(reconcileBankStatement(rows(110.35)).ok, true);
  assert.equal(reconcileBankStatement(rows(110.36)).ok, false, '差 0.01＞0.005＝真的對不上（fallback＝會被當台幣匯入＝要驗）');
});

test('強閘｜外幣綜合帳戶（同帳號多幣別）＝整組 skip 不誤擋（P0.1，真帳單煙霧測 2026-08-11）', () => {
  // 真帳單實測的**形狀**（數字與末碼全為合成假值——真末碼＝PII 鐵則，r1#1）：同一個遮罩帳號
  // 概要區出現兩列（兩種幣別各自的餘額），明細各幣別交易共用帳號欄且列上無幣別——按帳號驗鏈
  // 必把兩條幣別攪在一起（外幣利息列撞上別幣別的餘額、同一末筆被拿去對兩個概要餘額）。
  // 外幣明細本來就不匯入現金流＝**閘的射程對齊匯入的射程**：外幣整組 skip 並誠實計數、台幣照驗。
  const p = cleanBankParsed();
  p.accountCurrency = { '900100****3301': 'TWD', '900200****3302': 'TWD', '900400****905': 'USD' };
  p.accounts.push(
    { masked: '900400****905', balance: 77.31, currency: 'USD' },
    { masked: '900400****905', balance: 0, currency: 'JPY' },
  );
  p.transactions.push(
    btx({ acctMasked: '900400****905', acctSuffix: '905', date: '2026-02-01', summary: '外幣利息', direction: 'in', amount: 0, balance: 0.05 }),
    btx({ acctMasked: '900400****905', acctSuffix: '905', date: '2026-02-01', summary: '利息', direction: 'in', amount: 3, balance: 77.31 }),
  );
  const v = reconcileBankStatement(p);
  assert.equal(v.ok, true, '外幣鏈亂不可擋整份——那些列本來就不會進帳本');
  assert.equal(v.level, 'strong', '台幣帳戶照驗、級別不因外幣 skip 而虛降');
  assert.equal(v.stats.pairsChecked, 3, '台幣的三對照驗');
  assert.equal(v.stats.foreignRowsSkipped, 2);
  assert.equal(v.stats.foreignAccountsSkipped, 2, '同帳號兩個幣別的概要列都要 skip');
  assert.equal(v.stats.firstRowsUnverified, 2, '首筆計數只數受驗的台幣帳戶');
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

test('強閘×匯入｜幣別判準四種來源同向：map 命中／accounts 補位／db 補位／全 miss（r1#2 的縫關掉）', () => {
  // r1#2 實測的縫：map 缺鍵、accounts 判 USD——匯入端把列當 foreign 跳過、舊閘卻當台幣驗＝
  // 為不入帳的列擋整份。判準抽成單一份（statementCurrencyLookup＋db 補位＝txCurrency 同一條鏈）
  // 之後，四種幣別來源下「閘擋不擋」必須永遠等於「匯入收不收」。
  const M = '900500****888';
  const brokenChain = () => [
    btx({ acctMasked: M, acctSuffix: '888', balance: 100 }),
    btx({ acctMasked: M, acctSuffix: '888', date: '2026-07-02', direction: 'in', amount: 5, balance: 999 }),   // 亂鏈
  ];
  const base = () => ({ bank: '台新', referenceDate: '2026-07-31',
    accounts: /** @type {any[]} */ ([]), accountCurrency: /** @type {Record<string,string>} */ ({}), transactions: brokenChain() });
  // a. map 命中 USD → 閘 skip、不擋
  const pa1 = base(); pa1.accountCurrency = { [M]: 'USD' };
  assert.equal(assertBankReconciled(pa1).ok, true, 'map 判外幣＝skip');
  // b. map 缺鍵、accounts 補位判 USD → 同樣 skip（r1#2 當初就是這一格出縫）；且與匯入端同向
  const pa2 = base(); pa2.accounts = [{ suffix: '888', masked: M, balance: 999, currency: 'USD', label: '', note: '' }];
  assert.equal(assertBankReconciled(pa2).ok, true, 'accounts 補位判外幣＝閘也要跳過，不可當台幣驗');
  const db2 = store.emptyDb();
  const imp = importBankTxToDb(db2, /** @type {any} */ (pa2));
  assert.equal(imp.foreign, 2, '匯入端把同兩列當外幣跳過＝兩邊同向');
  assert.equal(imp.imported, 0);
  // c. 帳單查無、db 現金帳戶說 USD → 服務層帶 db 補位＝skip
  const db3 = { accounts: [{ type: 'cash', currency: 'USD', accountNo: '900500888', name: '外幣戶' }] };
  assert.equal(assertBankReconciled(base(), db3).ok, true, 'db 補位判外幣＝閘也要跳過');
  // d. 全 miss → fallback TWD＝會被當台幣匯入＝亂鏈必須照擋
  assert.throws(() => assertBankReconciled(base()), (/** @type {any} */ e) => e.status === 400);
});

// ---------- ① 中閘（信用卡）純函式 ----------

/** 中閘的標準情境：摘要四格平衡（10,449−2,449+450＝8,450）、明細加總對得上。
 * 四格刻意互不相同——成對相等（繳清型帳單）會遮住「等式的項被接錯/對調」型的壞法。
 * 繳款列帶 isPayment 旗標（同 finalize 產物；P0.2 公式吃旗標分繳款/退款）。 */
const cardOk = () => ({
  statementTotals: { due: 8450, prevDue: 10449, paidAndRefund: 2449, newCharges: 450 },
  transactions: [{ amount: 300 }, { amount: 150 }, { amount: -2449, isPayment: true }],
});

test('中閘｜四格平衡＋明細對得上＝medium 三檢查全過、零 advisories', () => {
  const v = reconcileCardStatement(cardOk());
  assert.equal(v.ok, true);
  assert.equal(v.level, 'medium');
  assert.deepEqual(v.checks, { equation: 'pass', newVsRows: 'pass', paidVsRows: 'pass' });
  assert.deepEqual(v.advisories, []);
  assert.equal(v.stats.sumPos, 450);
  assert.equal(v.stats.payAbs, 2449);
  assert.equal(v.stats.refundAbs, 0);
});

test('中閘｜校準語意（P0.2，四份真郵寄版實測的版面）：新增款項＝淨額、已繳款桶只有繳款列', () => {
  // 真版面：消費 4,500、退款 500、繳款 9,000；帳單印 新增款項 4,000（＝4,500−500 淨額）、
  // 已繳款桶 9,000（不含退款）；等式 10,000−9,000+4,000＝5,000＝應繳。
  // P0.2 之前的公式（正項全額 vs 新增款項；退款算進已繳款桶）在這種版面兩道都會誤鳴。
  const v = reconcileCardStatement({
    statementTotals: { due: 5000, prevDue: 10000, paidAndRefund: 9000, newCharges: 4000 },
    transactions: [{ amount: 4500 }, { amount: -500, isRefund: true }, { amount: -9000, isPayment: true }],
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.checks, { equation: 'pass', newVsRows: 'pass', paidVsRows: 'pass' });
  assert.deepEqual(v.advisories, [], '合法真版面＝零誤鳴（校準的意義）');
  assert.equal(v.stats.refundAbs, 500);
  assert.equal(v.stats.payAbs, 9000);
});

test('中閘｜負數列缺旗標＝用 desc 過 isCardPayment 重判（單一真相共用，r1#2）', () => {
  // r1#2 的反例：缺旗標一律猜退款 → 真繳款（−9,000）會被灌進退款桶，C2′/C3′ 兩道一起誤鳴。
  const v = reconcileCardStatement({
    statementTotals: { due: 5000, prevDue: 10000, paidAndRefund: 9000, newCharges: 4000 },
    transactions: [{ amount: 4500 }, { amount: -500, desc: '蝦皮退貨' }, { amount: -9000, desc: '信用卡自動扣繳' }],
  });
  assert.deepEqual(v.checks, { equation: 'pass', newVsRows: 'pass', paidVsRows: 'pass' });
  assert.equal(v.stats.payAbs, 9000, '「信用卡自動扣繳」缺旗標仍認得是繳款（isCardPayment 重判）');
  assert.equal(v.stats.refundAbs, 500);
});

test('中閘｜負數列連 desc 都沒有＝分不出繳款/退款＝②③兩道誠實 skip、不猜（r1#2）', () => {
  const v = reconcileCardStatement({
    statementTotals: { due: 5000, prevDue: 10000, paidAndRefund: 9000, newCharges: 4000 },
    transactions: [{ amount: 4500 }, { amount: -9000 }],
  });
  assert.equal(v.checks.equation, 'pass', 'C1 不受影響（吃的是摘要四格）');
  assert.equal(v.checks.newVsRows, 'skip', 'sums 不完整＝比了只會亂鳴');
  assert.equal(v.checks.paidVsRows, 'skip');
  assert.deepEqual(v.advisories, []);
  assert.equal(v.stats.unjudgeableNeg, 1);
});

test('中閘｜部分負數列 desc 是空字串/純空白＝同缺席、照樣 skip（r2#2：空字串過 isCardPayment 必回 false＝會被猜成退款）', () => {
  const v = reconcileCardStatement({
    statementTotals: { due: 5000, prevDue: 10000, paidAndRefund: 9000, newCharges: 4000 },
    transactions: [{ amount: 4500 }, { amount: -500, desc: '蝦皮退貨' }, { amount: -9000, desc: '  ' }],
  });
  assert.equal(v.checks.newVsRows, 'skip', '有一筆無從判＝整組 sums 不可信');
  assert.equal(v.checks.paidVsRows, 'skip');
  assert.equal(v.stats.unjudgeableNeg, 1);
  assert.equal(v.stats.refundAbs, 500, '判得出的照算（供 stats 呈現），只是不拿去比');
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

test('中閘｜明細少一筆＝影子檢查記 advisories、不擋（r1#1：分不出「漏讀」還是「版面只列摘要」）', () => {
  const p = cardOk();
  p.transactions = [{ amount: 300 }, { amount: -2449, isPayment: true }];   // 150 那筆不在明細
  const v = reconcileCardStatement(p);
  assert.equal(v.ok, true, '影子檢查不擋——硬擋會誤傷分期/年費只列摘要的合法帳單');
  assert.equal(v.checks.newVsRows, 'mismatch');
  assert.equal(v.advisories.length, 1);
  assert.match(v.advisories[0].message, /本期新增款項/);
  assert.match(v.advisories[0].message, /差 150/);
  assert.match(v.advisories[0].message, /也可能/, '訊息要把兩種可能都講、不可誣賴解析器');
  assert.deepEqual(v.problems, [], 'mismatch 絕不可漏進 problems（那會變回硬擋）');
});

test('中閘｜繳款/退款列不在明細＝同樣只記 advisories 不擋', () => {
  const p = cardOk();
  p.transactions = [{ amount: 300 }, { amount: 150 }];   // 繳款 −2,449 不在明細
  const v = reconcileCardStatement(p);
  assert.equal(v.ok, true);
  assert.equal(v.checks.paidVsRows, 'mismatch');
  assert.match(v.advisories.map((x) => x.message).join(''), /已繳款＋退款/);
});

test('中閘｜合法摘要調整型（r1#1 的反例場景）：等式自平、明細比摘要少＝放行＋兩則 advisories', () => {
  // 分期/年費只列摘要：10,000−10,000+1,300＝1,300 等式平；明細只有 1,000 消費、無繳款列。
  // 修法前這種合法帳單會被 C2（差 300）＋C3（差 10,000）整份 400。
  const v = reconcileCardStatement({
    statementTotals: { due: 1300, prevDue: 10000, paidAndRefund: 10000, newCharges: 1300 },
    transactions: [{ amount: 1000 }],
  });
  assert.equal(v.ok, true, '合法帳單不可被影子檢查擋下');
  assert.equal(v.level, 'medium', 'C1 有跑＝medium');
  assert.deepEqual(v.checks, { equation: 'pass', newVsRows: 'mismatch', paidVsRows: 'mismatch' });
  assert.equal(v.advisories.length, 2);
});

test('中閘｜擋下型（C1）容 ±1 進位差；差 2 就擋（容差不可寬到吞掉真錯）', () => {
  const off = (/** @type {number} */ d) => {
    const p = cardOk();
    p.statementTotals.due = 8450 + d;   // 只動等式：|算出 8,450 − 讀到 due| ＝ d
    return reconcileCardStatement(p);
  };
  assert.equal(off(1).ok, true, '±1＝帳單進位，放行');
  assert.equal(off(2).ok, false, '±2＝真的對不上，擋');
});

test('中閘｜C1 沒開（缺交叉欄）、只剩影子 mismatch＝level 必須是 weak（影子不得撐級別，r2#1）', () => {
  // r2 實測的假綠：把 level 改成「任何非 skip 都算 medium」原本 30 題全綠——影子 mismatch 撐出
  // medium 會讓使用者以為「這份有中閘保護」，實際擋下型檢查一道都沒跑。
  const v = reconcileCardStatement({
    statementTotals: { due: null, prevDue: null, paidAndRefund: null, newCharges: 550 },
    transactions: [{ amount: 450 }],
  });
  assert.equal(v.checks.equation, 'skip');
  assert.equal(v.checks.newVsRows, 'mismatch');
  assert.equal(v.level, 'weak', '只剩影子＝沒有任何擋下型驗證＝weak');
  assert.equal(v.ok, true);
});

test('中閘｜影子檢查同一把容差尺：差 1＝pass、差 2＝mismatch', () => {
  const off = (/** @type {number} */ d) => {
    const p = cardOk();
    p.statementTotals.newCharges = 450 + d;
    p.statementTotals.prevDue = 10449 - d;   // 等式維持平衡，只讓「明細 vs 新增款項」差 d
    return reconcileCardStatement(p);
  };
  assert.equal(off(1).checks.newVsRows, 'pass');
  assert.equal(off(2).checks.newVsRows, 'mismatch');
  assert.equal(off(2).ok, true, 'mismatch 仍不擋（影子）');
});

test('中閘｜什麼總額都讀不到的格式＝weak 全 skip、照舊放行（通用題，不綁特定版式——r3#2）', () => {
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
  const many = { ok: false, level: /** @type {const} */ ('strong'), checks: {}, advisories: [],
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

test('端到端｜一致的帳單：預覽照常，回應帶 reconcile 與 statementTotals（r1#4）', async () => {
  const r = await previewForCard('c1', xlsxB64({ prev: '10,449', paid: '2,449', add: '450', due: '8,450' }, TX_OK));
  assert.equal(r.reconcile.level, 'medium');
  assert.equal(r.reconcile.ok, true);
  assert.equal(r.reconcile.checks.newVsRows, 'pass');
  assert.equal(r.statementDue, 8450, 'statementDue 照舊要交出來（改走 totals.due 不可弄丟它）');
  assert.deepEqual(r.statementTotals, { due: 8450, prevDue: 10449, paidAndRefund: 2449, newCharges: 450 },
    '四格要一路帶到預覽回應（契約說到就要做到，r1#4）');
  assert.equal(r.statementMonth, '2026-07');
  assert.ok(r.transactions.length >= 2);
});

test('端到端｜摘要等式不平（C1）：previewForCard 就地 400 擋下（閘真的接在入口上）', async () => {
  // 10,449−2,449+450＝8,450，帳單卻印 9,999 ⇒ 四格至少一格被讀錯＝唯一的擋下型檢查轉紅
  const b64 = xlsxB64({ prev: '10,449', paid: '2,449', add: '450', due: '9,999' }, TX_OK);
  await assert.rejects(previewForCard('c1', b64), (/** @type {any} */ e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /對帳沒過/);
    assert.match(e.message, /等式不平/);
    assert.match(e.message, /差 1,549/);
    return true;
  });
});

test('端到端｜明細與摘要對不上（影子）：放行、advisories 進回應（r1#1 合法摘要調整型不再誤擋）', async () => {
  // 等式自平（10,449−2,449+550＝8,550）、明細只有 450 ⇒ 修法前這裡會 400，現在＝advisory
  const r = await previewForCard('c1', xlsxB64({ prev: '10,449', paid: '2,449', add: '550', due: '8,550' }, TX_OK));
  assert.equal(r.reconcile.ok, true);
  assert.equal(r.reconcile.checks.newVsRows, 'mismatch');
  assert.equal(r.reconcile.advisories.length, 1);
  assert.match(r.reconcile.advisories[0].message, /差 100/);
});

test('端到端｜免選卡那條路（previewAuto）同樣擋 C1、同樣帶 reconcile', async () => {
  await assert.rejects(previewAuto(xlsxB64({ prev: '10,449', paid: '2,449', add: '450', due: '9,999' }, TX_OK)),
    (/** @type {any} */ e) => { assert.equal(e.status, 400); assert.match(e.message, /對帳沒過/); return true; });
  const r = await previewAuto(xlsxB64({ prev: '10,449', paid: '2,449', add: '450', due: '8,450' }, TX_OK));
  assert.ok(r.resolvedCard, '末四碼 5678 唯一命中→自動歸卡');
  assert.equal(r.reconcile.level, 'medium');
  assert.deepEqual(r.statementTotals, { due: 8450, prevDue: 10449, paidAndRefund: 2449, newCharges: 450 },
    '免選卡那條路也要逐欄帶四格（r2#2：只驗 previewForCard 的話這邊拔掉照樣全綠）');
});

// ---------- ③ 端到端：銀行兩個正式入口（注入假解析器＝r3#1 的測試接縫） ----------
// 銀行入口吃真 PDF、考題合成不了；r3 實測「把兩處 assert 拔掉、31 題全綠」＝接線是空包彈。
// 這三題經**正式入口本人**（previewBankStatement/applyBankStatement 的第三參數注入解析結果）驗：
// 不平衡＝兩入口都 400、apply 一筆都不寫；平衡＝預覽帶裁決、套用真的落地（接縫不是只會擋）。

/** 完整的銀行解析產物（good path 供 apply 落地用；mutate 可把它弄壞）。 @param {(f:any)=>void} [mutate] */
function bankParsedFull(mutate) {
  const full = {
    bank: '台新', referenceDate: '2026-07-31',
    accounts: [{ suffix: '3301', masked: '900100****3301', balance: 10300, currency: 'TWD', label: '新臺幣活儲', note: '' }],
    accountCurrency: { '900100****3301': 'TWD', '900200****3302': 'TWD' },
    transactions: cleanBankParsed().transactions,
  };
  if (mutate) mutate(full);
  return full;
}

test('端到端｜銀行預覽入口：不平衡＝previewBankStatement 就地 400（接線本人受測，r3#1）', async () => {
  const parse = async () => bankParsedFull((f) => { f.transactions[4].amount = 250; });
  await assert.rejects(previewBankStatement('QUJD', '', parse), (/** @type {any} */ e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /對帳沒過，這份銀行對帳單先不匯入/);
    return true;
  });
});

test('端到端｜銀行套用入口：不平衡＝400 且資料庫一筆都不寫（寫入路徑 fail-closed）', async () => {
  const parse = async () => bankParsedFull((f) => { f.transactions[4].amount = 250; });
  await assert.rejects(applyBankStatement('QUJD', '', parse), (/** @type {any} */ e) => e.status === 400);
  const db = await getDb();
  assert.equal((db.transactions || []).length, 0, '閘要在任何寫入之前擋下——半套用比不套用更糟');
  assert.equal((db.accounts || []).length, 0, '也不可建出任何帳戶');
});

test('端到端｜銀行兩入口平衡通過：預覽帶 reconcile=strong、套用真的落地（接縫不是只會擋）', async () => {
  const r = await previewBankStatement('QUJD', '', async () => bankParsedFull());
  assert.equal(r.reconcile.level, 'strong');
  assert.equal(r.reconcile.ok, true);
  assert.equal(r.transactions.rows.length, 5);
  const a = await applyBankStatement('QUJD', '', async () => bankParsedFull());
  assert.equal(a.ok, true);
  assert.equal(a.transactions.imported, 5);
  const db = await getDb();
  assert.equal((db.transactions || []).filter((/** @type {any} */ t) => t.source === 'bank').length, 5);
});

test('端到端｜今日的官網 XLSX（只有「本期帳單金額」、無交叉欄）＝weak 照舊放行，行為不變', async () => {
  // r2#4 更正：官網 XLSX 不是「四格全 null」——它有「本期帳單金額」（DUE_KEYS 末位）＝due 讀得到；
  // 缺的是 prev/paid/new 三個交叉欄 ⇒ C1 skip、三檢查全開不了 ⇒ weak。fixture 要照實含這個欄位。
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['台新銀行 信用卡明細'], ['帳單結帳日：115/07/04'], ['本期帳單金額', '', 'NT$450'], ['卡號末四碼 5678'],
    ['消費日', '入帳日', '說明', '', '金額', '', '', '外幣'],
    ...TX_OK,
  ]), 'Sheet1');
  const b64 = Buffer.from(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))).toString('base64');
  const r = await previewForCard('c1', b64);
  assert.equal(r.statementDue, 450, 'due 讀自「本期帳單金額」（既有行為）');
  assert.deepEqual(r.statementTotals, { due: 450, prevDue: null, paidAndRefund: null, newCharges: null });
  assert.equal(r.reconcile.checks.equation, 'skip', '缺交叉欄＝C1 開不了');
  assert.equal(r.reconcile.level, 'weak');
  assert.equal(r.reconcile.ok, true);
});
