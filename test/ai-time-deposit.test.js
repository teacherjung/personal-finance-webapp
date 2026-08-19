// @ts-check
// AI 路線也認得定存（2026-08-18；體檢 E1：**錢被靜靜少算**——AI 答案卷沒有「這是定存」欄位，
// 同一個遮罩帳號下的多筆定存被當成重複、first-wins 只留一筆。William 的兩筆 51 美元定存實例）。
//
// 這支補的是**答案卷的兩個欄位**（kind/period），落地效果全部是既有機制自動生效：
//   ①分開列管（annotateCdRows→cdKey）②〜〜到期歸零〜〜＝**r1#1 之後改為只吃模板路線**（見下方 落地③）
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
const { previewBalancesForDb, applyBalancesToDb, maturedCdAccountsForTest, previewBankStatement, applyBankStatement } = await import('../lib/services/bank-import.js');
const { clearAiTicketsForTest } = await import('../lib/ai-confirm-ticket.js');
const { AI_BANK_MODELS } = await import('../lib/ai-parse.js');
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
  for (const v of ['', null, undefined, '2026/01/15', '一年期', '2026/13/45~x', '2026/13/45~2026/14/99', '2026/02/30~2026/07/15']) {   // 後兩個＝外形完整但不是真日期（Codex r1#2：假身分永遠到不了期）
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

test('落地③｜到期歸零**不吃 AI／配方路線**：機率性解析讀漏一列不得把還在的定存清成 0（r1#1）', () => {
  // Codex r1#1 的真彈：schema 把 kind 設成必填之後，每份 AI 答案都自稱結構化——AI 只要把定存那列
  // 誤標成 demand，那列就被同遮罩去重吃掉，db 裡的定存又因「本批沒印它」被歸零＝總額靜靜變少。
  const cdKey = '第一銀行|1234|USD|2026/01/15~2026/07/15|51|#1';
  const accounts = () => [{ id: 'a1', name: '第一銀行 1234（外幣定存 第1筆）', bank: '第一銀行', cdKey, currency: 'USD', balance: 51, balanceAsOf: '2026-07-01' }];
  const raw = rawAnswer();
  raw.accounts = [raw.accounts[0]];   // 這期 AI 只交出活存那列（誤標／漏讀都是這個形狀）
  const p = normalizeAiBank(raw);
  const live = new Set();
  assert.deepEqual(maturedCdAccountsForTest(accounts(), p, '第一銀行', live, '2026-07-31', false), [],
    '★AI 路線一律不歸零——AI 讀漏一列是可能的，而歸零是不可逆的減錢');
  // 同一份資料走確定性路線（內建範本）＝照舊會歸零（這一格證明擋的是「路線」不是「功能壞了」）
  assert.deepEqual(maturedCdAccountsForTest(accounts(), p, '第一銀行', live, '2026-07-31', true).map((/** @type {any} */ a) => a.id), ['a1']);
});

test('落地③b｜端到端保存題：AI 誤標定存為活存時，既有定存戶的錢必須原封不動（r1#1 的真彈）', () => {
  const cdKey = '第一銀行|1234|USD|2026/01/15~2026/07/15|51|#1';
  const db = { accounts: [
    { id: 'a0', name: '第一銀行 1234（外幣活存）', bank: '第一銀行', currency: 'USD', balance: 300, balanceAsOf: '2026-07-01', accountNo: M },
    { id: 'a1', name: '第一銀行 1234（外幣定存 第1筆）', bank: '第一銀行', cdKey, currency: 'USD', balance: 51, balanceAsOf: '2026-07-01' },
  ], transactions: [] };
  const before = db.accounts.reduce((/** @type {number} */ s2, /** @type {any} */ a) => s2 + a.balance, 0);
  const raw = rawAnswer();
  // schema 完全合法：兩列都有 kind，只是定存那列被 AI 誤標成 demand（餘額 51 照抄）
  raw.accounts = [raw.accounts[0], { ...raw.accounts[1], kind: 'demand', period: '' }];
  const r = applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank(raw)), { deterministic: false });
  const after = db.accounts.reduce((/** @type {number} */ s2, /** @type {any} */ a) => s2 + a.balance, 0);
  assert.equal(/** @type {any} */ (r).matured, undefined, '★不得有任何歸零');
  assert.equal(db.accounts.find((/** @type {any} */ a) => a.id === 'a1').balance, 51, '★定存戶的錢原封不動');
  assert.ok(after >= before - 0, `★總額不得因為 AI 誤標而變少（${before} → ${after}）`);
});

test('落地④｜期間後補不裂戶：這期沒印期間、下期印了＝同一戶（不是憑空多一份錢）（r1#2）', () => {
  const db = { accounts: [], transactions: [] };
  const noPeriod = rawAnswer();
  noPeriod.accounts = [{ ...noPeriod.accounts[1], period: '' }];   // 只有一筆定存、沒印期間
  applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank(noPeriod)), { deterministic: false });
  assert.equal(db.accounts.length, 1, '第一期：建一戶');
  const withPeriod = rawAnswer();
  withPeriod.accounts = [{ ...withPeriod.accounts[1], period: '2026/01/15~2026/07/15' }];
  const p2 = normalizeAiBank({ ...withPeriod, referenceDate: '2026-08-31' });
  applyBalancesToDb(db, /** @type {any} */ (p2), { deterministic: false });
  assert.equal(db.accounts.length, 1, `★下期補上期間仍是同一戶（裂成兩戶＝帳面憑空多 51 美元；實得 ${db.accounts.length}）`);
  assert.match(String(db.accounts[0].cdKey), /2026\/01\/15~2026\/07\/15/, '★身分鍵升級成資訊較全的那一把（否則下期又要靠盲配）');
  // 反向也要成立：兩邊期間都有值而**不同**＝真的是不同期別，該分開
  const other = rawAnswer();
  other.accounts = [{ ...other.accounts[1], period: '2026/03/20~2026/09/20' }];
  applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank({ ...other, referenceDate: '2026-09-30' })), { deterministic: false });
  assert.equal(db.accounts.length, 2, '★不同期別要各自成戶（分開列管的本意）');
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

// ---- Codex r2 三顆高：盲配的三道門／單向升級／起迄順序 ----
test('r2#1｜盲配不復活已歸零的定存戶（總額 51→102 的那顆真彈）', () => {
  const base = '第一銀行|1234|USD|';
  const db = { accounts: [
    { id: 'old', name: '第一銀行 1234（外幣定存 第1筆）（已到期）', bank: '第一銀行', cdKey: `${base}2025/01/15~2025/07/15|51|#1`, currency: 'USD', balance: 0, balanceAsOf: '2026-01-31' },
    { id: 'live', name: '第一銀行 1234（外幣定存 第1筆）', bank: '第一銀行', cdKey: `${base}2026/01/15~2026/07/15|51|#1`, currency: 'USD', balance: 51, balanceAsOf: '2026-07-01' },
  ], transactions: [] };
  const raw = rawAnswer();
  raw.accounts = [{ ...raw.accounts[1], period: '' }];   // 本期 AI 沒抄到期間
  const r = applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank({ ...raw, referenceDate: '2026-08-31' })), { deterministic: false });
  const old = db.accounts.find((/** @type {any} */ a) => a.id === 'old');
  assert.equal(old.balance, 0, '★已歸零的戶不得被「復活」成 51（那是看不見的加錢）');
  assert.ok(r, '有回傳');
  const total = db.accounts.reduce((/** @type {number} */ s2, /** @type {any} */ a) => s2 + Number(a.balance || 0), 0);
  assert.ok(total <= 51 + 51, `★總額不得暴增（實得 ${total}）`);
});

test('r2#1c｜餘額 0 的定存戶一律不盲配——即使名稱沒有「已到期」（使用者自己歸零的也算）', () => {
  const base = '第一銀行|1234|USD|';
  const db = { accounts: [
    { id: 'zero', name: '第一銀行 1234（外幣定存 第1筆）', bank: '第一銀行', cdKey: `${base}2025/01/15~2025/07/15|51|#1`, currency: 'USD', balance: 0, balanceAsOf: '2026-01-31' },
  ], transactions: [] };
  const raw = rawAnswer();
  raw.accounts = [{ ...raw.accounts[1], period: '' }];
  applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank({ ...raw, referenceDate: '2026-08-31' })), { deterministic: false });
  assert.equal(db.accounts.find((/** @type {any} */ a) => a.id === 'zero').balance, 0, '★零餘額戶不得被盲配復活（這一格單獨釘住餘額門，不靠名稱門搭便車）');
  assert.equal(db.accounts.length, 2, '該新建一戶');
});

test('r2#1e｜名稱已註記「已到期」的戶不盲配——即使使用者自己把餘額改回非 0（名稱門單獨承重）', () => {
  // 可達狀態：帳戶餘額是使用者可編輯的，他可能在到期歸零之後自己填回一個數字（記錯、或續存後手動更新）
  const db = { accounts: [
    { id: 'm', name: '第一銀行 1234（外幣定存 第1筆）（已到期）', bank: '第一銀行', cdKey: '第一銀行|1234|USD|2025/01/15~2025/07/15|51|#1', currency: 'USD', balance: 51, balanceAsOf: '2026-01-31' },
  ], transactions: [] };
  const raw = rawAnswer();
  raw.accounts = [{ ...raw.accounts[1], period: '' }];
  applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank({ ...raw, referenceDate: '2026-08-31' })), { deterministic: false });
  const m = db.accounts.find((/** @type {any} */ a) => a.id === 'm');
  assert.match(String(m.cdKey), /2025\/01\/15~2025\/07\/15/, '★已註記到期的戶不得被新一期的定存接手身分');
  assert.equal(db.accounts.length, 2, '該新建一戶');
});

test('r2#1d｜同一張帳單印兩筆不同期別＝各自成戶（一顆缺期間的舊戶只會被其中一列接手）', () => {
  // db 只有一顆「沒印期間」的定存；本期帳單印出兩筆同額、期間不同的定存
  const db = { accounts: [
    { id: 'a1', name: '第一銀行 1234（外幣定存 第1筆）', bank: '第一銀行', cdKey: '第一銀行|1234|USD||51|#1', currency: 'USD', balance: 51, balanceAsOf: '2026-07-01' },
  ], transactions: [] };
  const raw = rawAnswer();
  raw.accounts = [
    { ...raw.accounts[1], period: '2026/01/15~2026/07/15' },
    { ...raw.accounts[2], period: '2026/02/20~2026/08/20' },
  ];
  applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank({ ...raw, referenceDate: '2026-08-31' })), { deterministic: false });
  assert.equal(db.accounts.length, 2, `★兩列不可都收斂到同一顆戶；實得 ${JSON.stringify(db.accounts.map((/** @type {any} */ a) => [a.id, a.cdKey]))}`);
  const keys = db.accounts.map((/** @type {any} */ a) => String(a.cdKey));
  assert.equal(new Set(keys).size, 2, '★兩顆的身分鍵要各自不同');
});

test('r2#1b｜候選不唯一＝不猜（同銀行末碼幣別本金有兩顆現役定存時，缺期間那列不盲配）', () => {
  const base = '第一銀行|1234|USD|';
  const db = { accounts: [
    { id: 'c1', name: '第一銀行 1234（外幣定存 第1筆）', bank: '第一銀行', cdKey: `${base}2026/01/15~2026/07/15|51|#1`, currency: 'USD', balance: 51, balanceAsOf: '2026-07-01' },
    // ⚠️ 真實的歧義形：兩顆是**不同月份各自建立**的，各自在自己那期都是「第1筆」——序號分不開它們
    { id: 'c2', name: '第一銀行 1234（外幣定存 第1筆）', bank: '第一銀行', cdKey: `${base}2026/02/20~2026/08/20|51|#1`, currency: 'USD', balance: 51, balanceAsOf: '2026-07-01' },
  ], transactions: [] };
  const raw = rawAnswer();
  raw.accounts = [{ ...raw.accounts[1], period: '' }];
  applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank({ ...raw, referenceDate: '2026-08-31' })), { deterministic: false });
  assert.equal(db.accounts.find((/** @type {any} */ a) => a.id === 'c1').cdKey, `${base}2026/01/15~2026/07/15|51|#1`, '★歧義時不得動既有戶的身分');
  assert.equal(db.accounts.length, 3, '★分不出來就新建一戶（看得見的多一戶）而不是猜一顆去改');
});

test('r2#2｜cdKey 只做單向升級：既有有期間、新的漏抄＝不得把期間抹掉', () => {
  const db = { accounts: [{ id: 'a1', name: '第一銀行 1234（外幣定存 第1筆）', bank: '第一銀行', cdKey: '第一銀行|1234|USD|2026/03/20~2026/09/20|51|#1', currency: 'USD', balance: 51, balanceAsOf: '2026-07-01' }], transactions: [] };
  const raw = rawAnswer();
  raw.accounts = [{ ...raw.accounts[1], period: '' }];
  applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank({ ...raw, referenceDate: '2026-08-31' })), { deterministic: false });
  assert.match(String(db.accounts[0].cdKey), /2026\/03\/20~2026\/09\/20/, '★到期資訊不得被抹掉（抹掉＝那顆定存永遠不會到期，也會亂配別顆）');
});

test('r2#3｜起日晚於迄日＝抄反了，整段不收（否則下期讀成正確順序就裂成兩戶）', () => {
  assert.equal(canonPeriod('2026/07/15~2026/01/15'), '', '★反向區間回空');
  assert.equal(canonPeriod('2026/01/15~2026/01/15'), '2026/01/15~2026/01/15', '同日仍合法（單日期別）');
});

// ---- 接線（P127 教訓：我測的是函式、不是那條線）----
test('接線｜**端到端**走一趟 AI 匯入：正式路不得把既有定存歸零（r1#1 的真彈，走完整 preview→apply）', async () => {
  clearAiTicketsForTest();
  const TM = '900200****3301';
  const db = await getDb();
  db.accounts = [
    { id: 'a0', name: '第一銀行 3301（台幣活存）', type: 'cash', bank: '第一銀行', currency: 'TWD', balance: 5000, balanceAsOf: '2026-07-01', accountNo: TM },
    { id: 'a1', name: '第一銀行 3301（台幣定存 第1筆）', type: 'cash', bank: '第一銀行', cdKey: '第一銀行|3301|TWD|2026/01/15~2026/07/15|20000|#1', currency: 'TWD', balance: 20000, balanceAsOf: '2026-07-01' },
  ];
  db.transactions = [];
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';   // 假引擎注入，這把鑰匙只是讓路線走得下去
  delete db.settings.aiDualRead;
  await saveDb(db);
  // AI 這期只交出活存那列（定存被誤標成活存／漏讀都是這個形狀）——schema 完全合法、且過得了強閘
  const answer = {
    bank: '第一銀行', referenceDate: '2026-07-31',
    accountCurrencies: [{ masked: TM, currency: 'TWD' }],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [{ masked: TM, balance: 5500, currency: 'TWD', label: '台幣活存', note: '', kind: 'demand', period: '' }],
    transactions: [{ acctMasked: TM, date: '2026-07-05', direction: 'in', amount: 500, balance: 5500, summary: '薪資入帳', note: '' }],
  };
  const engine = () => ({ models: AI_BANK_MODELS, parseOnce: async () => structuredClone(answer) });
  const notRecognized = async () => { throw Object.assign(new Error('不是內建範本認得的版面'), { status: 400, code: 'bank_unrecognized' }); };
  const extract = async () => [
    { y: 10, cells: [{ x: 40, s: '合成第一銀行 存款對帳單' }] },
    { y: 30, cells: [{ x: 40, s: TM }, { x: 200, s: 'TWD' }, { x: 320, s: '5,500' }] },
    { y: 50, cells: [{ x: 40, s: '2026/07/05' }, { x: 140, s: '薪資入帳' }, { x: 280, s: '500' }, { x: 320, s: '5,500' }] },
  ];
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engine, aiExtract: extract });
  assert.ok(/** @type {any} */ (pv).aiTicket, '前提：走到 AI 路線並發票');
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: /** @type {any} */ (pv).aiTicket, aiEngineFactory: engine, aiExtract: extract });
  const after = await getDb();
  const cd = after.accounts.find((/** @type {any} */ a) => a.id === 'a1');
  assert.equal(cd.balance, 20000, '★正式路走一趟之後，定存戶的錢必須原封不動（接線斷掉＝這裡變 0）');
  assert.ok(!/已到期/.test(cd.name), '★也不得加註「已到期」');
});
