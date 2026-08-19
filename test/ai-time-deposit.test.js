// @ts-check
// AI 路線也認得定存（2026-08-18；體檢 E1：**錢被靜靜少算**——AI 答案卷沒有「這是定存」欄位，
// 同一個遮罩帳號下的多筆定存被當成重複、first-wins 只留一筆。William 的兩筆 51 美元定存實例）。
//
// 這支補的是**答案卷的兩個欄位**（kind/period），落地效果全部是既有機制自動生效：
//   ①分開列管（annotateCdRows→cdKey）②到期歸零（maturedCdAccounts 的 structured 前提）
//   ③對帳閘的「定存概要列不對末筆」skip（判準 kind==='time'）。
// 所以本卷的重點不在「新程式做了什麼」，而在三個**界線**：
//   Ａ「AI 有講才算數」——一列都沒填 kind＝退回舊形狀（**不可**補預設 demand 讓沒看懂的答案冒充
//     結構化，否則還印在帳單上的定存會被誤歸零＝#483 r1#1 那顆高）。
//   Ｂ 期間正規化——兩讀寫法不同不得變成**新的仲裁來源**；認不出＝空字串（fail-safe）。
//   Ｃ kind 進 hard 比對、期間「缺席≠矛盾」——一讀說 time 一讀說 demand＝匯入結果差一整筆錢。
//
// 假資料鐵則：帳號一律明顯假值（900200 前綴系），絕不複製真帳單遮罩末碼。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STORE_FILE = join(tmpdir(), `finance-aicd-${process.pid}.db`);

const { normalizeAiBank, canonPeriod, aiAnswersAgree, AI_BANK_SCHEMA, buildBankSystem } = await import('../lib/ai-parse.js');
const { previewBalancesForDb, maturedCdAccountsForTest } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { reconcileBankStatement } = await import('../lib/statement-reconcile.js');

const M = '900200****1234';
/** AI 原始答案卷（未驗收）：一個活存 + 兩筆同值定存（William 的形狀，合成值）。 */
const rawAnswer = (/** @type {any} */ over = {}) => ({
  bank: '第一銀行', referenceDate: '2026-07-31',
  accountCurrencies: [{ masked: M, currency: 'USD' }],
  totals: { txCount: null, totalOut: null, totalIn: null },
  accounts: [
    { masked: M, balance: 300, currency: 'USD', label: '外幣活存', note: '', kind: 'demand', period: '' },
    { masked: M, balance: 51, currency: 'USD', label: '外幣定存', note: '', kind: 'time', period: '2026/01/15~2026/07/15' },
    { masked: M, balance: 51, currency: 'USD', label: '外幣定存', note: '', kind: 'time', period: '2026/02/20~2026/08/20' },
  ],
  transactions: [],
  ...over,
});

// ---- Ａ「AI 有講才算數」 ----
test('界線Ａ｜一列都沒填 kind＝退回舊形狀（accounts 完全沒有 kind 欄）', () => {
  const raw = rawAnswer();
  for (const a of raw.accounts) { delete (/** @type {any} */ (a)).kind; delete (/** @type {any} */ (a)).period; }
  const p = normalizeAiBank(raw);
  for (const a of p.accounts) {
    assert.ok(!('kind' in a), '★沒講就不可補預設——補了會讓「沒看懂定存」的答案冒充結構化，把還印著的定存誤歸零（#483 r1#1）');
    assert.ok(!('period' in a), '同上');
  }
});

test('界線Ａ｜有任何一列填了 kind＝整份結構化，沒填的那列補 demand（不是丟掉）', () => {
  const raw = rawAnswer();
  delete (/** @type {any} */ (raw.accounts[0])).kind;   // 活存那列沒填
  const p = normalizeAiBank(raw);
  assert.deepEqual(p.accounts.map((/** @type {any} */ a) => a.kind), ['demand', 'time', 'time']);
});

test('界線Ａ｜kind 只收 demand/time，其他值＝壞答案（fail-closed，不猜）', () => {
  for (const bad of ['fixed', 'TIME', '定存', '1']) {
    const raw = rawAnswer();
    raw.accounts[1].kind = bad;
    assert.throws(() => normalizeAiBank(raw), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /kind/.test(e.message), `★「${bad}」要被擋`);
  }
});

// ---- Ｂ 期間正規化 ----
test('界線Ｂ｜canonPeriod：各種寫法收斂成同一形；認不出＝空字串（fail-safe）', () => {
  const want = '2026/01/15~2026/07/15';
  for (const v of ['2026/01/15~2026/07/15', '2026-01-15~2026-07-15', '2026/1/15 ~ 2026/7/15',
    '2026-1-15 至 2026-7-15', '起 2026/01/15 迄 2026/07/15', '2026/01/15〜2026/07/15']) {
    assert.equal(canonPeriod(v), want, `★「${v}」要收斂成同一形（不收斂＝新的仲裁來源）`);
  }
  for (const v of ['', null, undefined, '2026/01/15', '一年期', '2026/13/45~x']) {
    assert.equal(canonPeriod(v), '', `★認不出兩個完整日期＝空字串（fail-safe）：${JSON.stringify(v)}`);
  }
});

test('界線Ｂ｜驗收會正規化期間；活存那列的期間一律清空（AI 常把利率適用期間填進來）', () => {
  const raw = rawAnswer();
  raw.accounts[1].period = '2026-1-15 至 2026-7-15';
  raw.accounts[0].period = '2026/01/01~2026/12/31';   // 活存卻填了期間
  const p = normalizeAiBank(raw);
  assert.equal(/** @type {any} */ (p.accounts[1]).period, '2026/01/15~2026/07/15');
  assert.equal(/** @type {any} */ (p.accounts[0]).period, '', '★活存不留期間（期間是定存的身分，活存帶著會汙染別的判斷）');
});

// ---- Ｃ 雙讀比對 ----
test('界線Ｃ｜kind 不一致＝hard（匯入結果差一整筆錢，不是寫法差）', () => {
  const a = normalizeAiBank(rawAnswer());
  const rawB = rawAnswer(); rawB.accounts[2].kind = 'demand'; rawB.accounts[2].period = '';
  const b = normalizeAiBank(rawB);
  const r = aiAnswersAgree(a, b);
  assert.equal(r.agree, false);
  assert.ok(r.diffs.includes('帳戶餘額組成'), `★kind 差要打進錢欄（實得 ${JSON.stringify(r.diffs)}）`);
});

test('界線Ｃ｜期間：兩讀都抄到但不同＝hard；一讀沒抄到＝建議面（缺席≠矛盾）', () => {
  const a = normalizeAiBank(rawAnswer());
  const rawB = rawAnswer(); rawB.accounts[2].period = '2026/03/20~2026/09/20';
  const hard = aiAnswersAgree(a, normalizeAiBank(rawB));
  assert.ok(hard.diffs.includes('定存期間'), `★都抄到卻不同＝hard（實得 ${JSON.stringify(hard.diffs)}）`);
  const rawC = rawAnswer(); rawC.accounts[2].period = '';
  const soft = aiAnswersAgree(a, normalizeAiBank(rawC));
  assert.ok(!soft.diffs.includes('定存期間'), '★一讀沒抄到不算矛盾（否則憑空多一輪仲裁）');
  assert.ok(soft.textVariance.includes('定存期間'), '★但要在徽章提一句');
});

test('界線Ｃ｜寫法不同（斜線 vs 破折號）＝零提示（正規化之後根本看不出差別）', () => {
  const a = normalizeAiBank(rawAnswer());
  const rawB = rawAnswer();
  rawB.accounts[1].period = '2026-01-15~2026-07-15';
  rawB.accounts[2].period = '2026-2-20 至 2026-8-20';
  const r = aiAnswersAgree(a, normalizeAiBank(rawB));
  assert.equal(r.agree, true, '★寫法差不得觸發仲裁');
  assert.ok(!r.textVariance.includes('定存期間'), '★連建議面都不該有');
});

// ---- 落地：三個既有機制自動生效 ----
test('落地①｜兩筆同值定存不再被吃掉：預覽三列、各自成戶（AI 路線的錢被少算＝體檢 E1）', async () => {
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  await saveDb(db);
  const p = normalizeAiBank(rawAnswer());
  const pv = previewBalancesForDb(db, /** @type {any} */ (p));
  assert.equal(pv.rows.length, 3, `★三列各自現形（舊行為＝2 列，少算一筆 51 美元；實得 ${JSON.stringify(pv.rows.map((/** @type {any} */ r) => [r.label, r.balance]))}）`);
  const cdNames = pv.rows.map((/** @type {any} */ r) => r.label).filter((/** @type {string} */ n) => /定存/.test(n));
  assert.equal(new Set(cdNames).size, 2, '★兩筆同值定存要有各自可辨的名字（第1筆/第2筆）');
});

test('落地②｜對帳閘的定存 skip 認得出來了：同遮罩「活存＋定存」不再整份誤擋', () => {
  // 版面：同一個遮罩帳號印兩列（活存 9000、定存 20000），明細只有活存那條鏈
  const parsed = /** @type {any} */ ({
    bank: '第一銀行', referenceDate: '2026-07-31',
    accounts: [
      { suffix: '3301', masked: '900200****3301', balance: 9000, currency: 'TWD', label: '台幣活存', note: '', kind: 'demand', period: '' },
      { suffix: '3301', masked: '900200****3301', balance: 20000, currency: 'TWD', label: '台幣定存', note: '', kind: 'time', period: '2026/01/10~2026/07/10' },
    ],
    accountCurrency: { '900200****3301': 'TWD' },
    transactions: [{ acctSuffix: '3301', acctMasked: '900200****3301', date: '2026-07-05', direction: 'out', amount: 1000, balance: 9000, summary: '轉出', note: '' }],
  });
  const withKind = reconcileBankStatement(parsed);
  assert.equal(withKind.ok, true, `★帶 kind＝定存列跳過、活存末筆對得上（實得 ${JSON.stringify(withKind.problems)}）`);
  // 對照：拿掉 kind（＝這支之前的 AI 形狀）＝閘紅，而使用者收到的訊息會把版面問題講成「AI 讀錯」
  const noKind = reconcileBankStatement(/** @type {any} */ ({ ...parsed, accounts: parsed.accounts.map((/** @type {any} */ a) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'kind' && k !== 'period'))) }));
  assert.equal(noKind.ok, false, '★對照組：沒有 kind 就會誤擋（這題同時釘住「修好了」與「本來壞在哪」）');
});

test('落地③｜到期歸零：AI 有講＝真的會歸零；沒講＝一顆都不動（行為題，不是形狀題）', () => {
  // db 裡有一筆去年到期的定存（cdKey 形狀同模板路線）；本次 AI 帳單不再印它、參考日已過迄日
  const cdKey = '第一銀行|1234|USD|2026/01/15~2026/07/15|51|#1';
  const accounts = [{ id: 'a1', name: '第一銀行 1234（外幣定存 第1筆）', bank: '第一銀行', cdKey, currency: 'USD', balance: 51, balanceAsOf: '2026-07-01' }];
  const raw = rawAnswer();
  raw.accounts = [raw.accounts[0]];   // 這期只印活存（定存已解約/到期）
  const p = normalizeAiBank(raw);
  const live = new Set();   // 本批沒有任何定存列
  const hit = maturedCdAccountsForTest(accounts, p, '第一銀行', live, '2026-07-31');
  assert.deepEqual(hit.map((/** @type {any} */ a) => a.id), ['a1'], `★AI 有講＝到期歸零真的適用（實得 ${JSON.stringify(hit)}）`);
  // 對照：同一份答案拿掉 kind（＝這支之前的 AI 形狀）＝一顆都不動（fail-safe：沒看懂就不判死活）
  const rawNo = rawAnswer(); rawNo.accounts = [rawNo.accounts[0]];
  for (const a of rawNo.accounts) { delete (/** @type {any} */ (a)).kind; delete (/** @type {any} */ (a)).period; }
  const pNo = normalizeAiBank(rawNo);
  assert.deepEqual(maturedCdAccountsForTest(accounts, pNo, '第一銀行', live, '2026-07-31'), [], '★沒講＝不判死活');
  assert.ok(!('kind' in pNo.accounts[0]), '★沒講＝維持舊形狀＝到期歸零整段不適用（fail-safe）');
});

// ---- 提示詞與答案卷形狀 ----
test('接線｜答案卷 schema 帶 kind（必填、封閉列舉）與 period；提示詞教了「每筆各列一列」', () => {
  const props = /** @type {any} */ (AI_BANK_SCHEMA).properties.accounts.items;
  assert.deepEqual(props.properties.kind.enum, ['demand', 'time'], '★封閉列舉（自由文字＝驗收又要多一道）');
  assert.ok(props.required.includes('kind'), '★必填（選填＝多數答案不會帶，這支等於沒做）');
  assert.ok(props.properties.period, 'period 欄在');
  const sys = buildBankSystem();
  assert.match(sys, /每一筆各列一列/, '★同帳號多筆定存不可合併——合併就是使用者少算錢');
  assert.match(sys, /看不出來就填 demand/, '★不確定時倒向 demand（填錯成 time 會用期間當身分）');
});
