// @ts-check
// AI 路線也認得定存（2026-08-18；體檢 E1：**錢被靜靜少算**——AI 答案卷沒有「這是定存」欄位，
// 同一個遮罩帳號下的多筆定存被當成重複、first-wins 只留一筆。William 的兩筆 51 美元定存實例）。
//
// 這支補的是**答案卷的兩個欄位**（kind/period），落地效果全部是既有機制自動生效：
//   ①分開列管（annotateCdRows→cdKey）②〜〜到期歸零〜〜＝**r1#1 之後改為只吃模板路線**（見下方 落地③）
//   ③對帳閘的「定存概要列不對末筆」skip（判準 kind==='time'）。
// 所以本卷的重點不在「新程式做了什麼」，而在三個**界線**：
//   Ａ「AI 有講才算數」＝決定「這份答案帶不帶定存結構」（影響分開列管與對帳閘的定存 skip）。
//     一列都沒有 kind 欄＝退回舊形狀；欄位在但型別/值不合法＝拒收整份，不得靜靜降級。
//     ⚠️ 它**不是**防誤歸零的邊界——那道是 bank-import 的 deterministic 旗標（到期歸零只吃內建範本）。
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
test('界線Ａ｜一列都**沒有 kind 欄**＝退回舊形狀（缺席才算沒講；型別錯另有一題）', () => {
  const raw = rawAnswer();
  for (const a of raw.accounts) { delete (/** @type {any} */ (a)).kind; delete (/** @type {any} */ (a)).period; }
  const p = normalizeAiBank(raw);
  for (const a of p.accounts) {
    assert.ok(!('kind' in a), '★沒講就不可補預設——補了等於替這份答案宣稱它認得定存（下游會據此分戶）；防誤歸零的是 deterministic 旗標，不是這裡');
    assert.ok(!('period' in a), '同上');
  }
});

test('界線Ａ｜整份已結構化就**不准有列漏填**（漏的若是定存列＝又回到少算一筆；Grok G5）', () => {
  // 舊行為：漏填的補 demand ⇒ 定存列被當活存 ⇒ 同遮罩去重吃掉 ⇒ 兩筆 51 變一筆
  const cdMissing = rawAnswer();
  delete (/** @type {any} */ (cdMissing.accounts[2])).kind;   // 漏的是**定存**那列
  assert.throws(() => normalizeAiBank(cdMissing), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /kind/.test(e.message),
    '★定存列漏填＝拒收整份（補成 demand 就是靜靜少算一筆）');
  // 漏的是活存列一樣拒收——「同一份答案裡不可有的有、有的沒有」比逐列猜意圖安全
  const demandMissing = rawAnswer();
  delete (/** @type {any} */ (demandMissing.accounts[0])).kind;
  assert.throws(() => normalizeAiBank(demandMissing), (/** @type {any} */ e) => e.code === 'ai_bad_answer');
  // 全部都有＝正常通過
  assert.deepEqual(normalizeAiBank(rawAnswer()).accounts.map((/** @type {any} */ a) => a.kind), ['demand', 'time', 'time']);
});

test('界線Ａ｜kind **欄位在但型別不對**＝壞答案，不得被當成「沒講」而繞過驗收（r4#1）', () => {
  for (const bad of [1, true, null, {}, ['time']]) {
    const raw = rawAnswer();
    raw.accounts[1].kind = /** @type {any} */ (bad);
    assert.throws(() => normalizeAiBank(raw), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /kind/.test(e.message),
      `★「${JSON.stringify(bad)}」要被擋（舊寫法會整份當成舊形狀＝兩筆同遮罩定存被吃成一筆、總額少一半）`);
  }
  // ★審查者點名的情境：**每一列**都不合法——舊寫法會整份判成「沒講」、靜靜退回舊形狀
  const allBad = rawAnswer();
  for (const a of allBad.accounts) (/** @type {any} */ (a)).kind = 1;
  assert.throws(() => normalizeAiBank(allBad), (/** @type {any} */ e) => e.code === 'ai_bad_answer',
    '★全列型別錯＝拒收（舊寫法會當成舊形狀，兩筆同遮罩定存被吃成一筆＝總額少一半）');
  // 對照：欄位**真的缺席**才走舊形狀
  const gone = rawAnswer();
  for (const a of gone.accounts) delete (/** @type {any} */ (a)).kind;
  assert.ok(!('kind' in normalizeAiBank(gone).accounts[0]), '缺席＝舊形狀（這一格分開「缺席」與「型別錯」）');
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
  // ★錢真的要進庫（Grok G1：headline 題只驗預覽＝「只讓預覽好看」也會綠；P127 同一課）
  const r = applyBalancesToDb(db, /** @type {any} */ (p), { deterministic: false });
  assert.equal(r.created, 3, `★三戶真的建起來（實得 ${JSON.stringify(r)}）`);
  const cds = db.accounts.filter((/** @type {any} */ a) => a.cdKey);
  assert.equal(cds.length, 2, '★兩顆定存戶各自存在');
  assert.equal(cds.reduce((/** @type {number} */ s2, /** @type {any} */ a) => s2 + a.balance, 0), 102, '★兩筆 51 都在（舊行為＝只剩 51）');
  assert.equal(db.accounts.reduce((/** @type {number} */ s2, /** @type {any} */ a) => s2 + a.balance, 0), 402, '★總額＝活存 300＋定存 102');
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
  assert.equal(after, before, `★總額必須一格不差（Grok G2：舊寫的 >= before-0 在「定存歸零＋另建同額活存」時也會綠）；${before} → ${after}`);
});

test('接線｜答案卷 schema 帶 kind（必填、封閉列舉）與 period；提示詞教了「每筆各列一列」', () => {
  const props = /** @type {any} */ (AI_BANK_SCHEMA).properties.accounts.items;
  assert.deepEqual(props.properties.kind.enum, ['demand', 'time'], '★封閉列舉（自由文字＝驗收又要多一道）');
  assert.ok(props.required.includes('kind'), '★必填（選填＝多數答案不會帶，這支等於沒做）');
  assert.ok(props.properties.period, 'period 欄在');
  const sys = buildBankSystem();
  assert.match(sys, /每一筆各列一列/, '★同帳號多筆定存不可合併——合併就是使用者少算錢');
  assert.match(sys, /看不出來就填 demand/, '★不確定時倒向 demand（填錯成 time 會用期間當身分）');
});

test('r8｜末碼碰撞時，期間歸屬不得在不同遮罩帳戶之間互換（碰撞鍵的承重題）', () => {
  // 兩顆定存：末碼同為 1234、遮罩不同（900100 / 900200）、幣別金額都一樣 —— 只有「哪一段期間屬於哪一戶」不同。
  // 舊鍵（suffix|currency|balance）會把兩戶揉成同一組，兩邊排序後看起來一模一樣＝錯報 agree。
  const mk = (/** @type {string} */ p1, /** @type {string} */ p2) => normalizeAiBank({
    bank: '第一銀行', referenceDate: '2026-07-31',
    accountCurrencies: [{ masked: '900100****1234', currency: 'USD' }, { masked: '900200****1234', currency: 'USD' }],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [
      { masked: '900100****1234', balance: 51, currency: 'USD', label: '外幣定存', note: '', kind: 'time', period: p1 },
      { masked: '900200****1234', balance: 51, currency: 'USD', label: '外幣定存', note: '', kind: 'time', period: p2 },
    ],
    transactions: [],
  });
  const A = mk('2026/01/15~2026/07/15', '2026/02/20~2026/08/20');
  const B = mk('2026/02/20~2026/08/20', '2026/01/15~2026/07/15');   // 期間對調
  const r = aiAnswersAgree(A, B);
  assert.ok(r.diffs.includes('定存期間'), `★期間掛錯戶＝hard（實得 ${JSON.stringify(r.diffs)}）——用舊鍵會錯報一致`);
  assert.equal(r.agree, false);
  // 對照：期間沒對調＝完全一致（確認上面那顆紅不是因為別的欄位）
  assert.equal(aiAnswersAgree(A, mk('2026/01/15~2026/07/15', '2026/02/20~2026/08/20')).agree, true);
});

// ---- Codex r2#3（保留）：期間必須是合法區間 ----
test('r2#3｜起日晚於迄日＝抄反了，整段不收；假日期同樣不收（假身分永遠到不了期）', () => {
  assert.equal(canonPeriod('2026/07/15~2026/01/15'), '', '★反向區間回空');
  assert.equal(canonPeriod('2026/01/15~2026/01/15'), '2026/01/15~2026/01/15', '同日仍合法（單日期別）');
  assert.equal(canonPeriod('2026/13/45~2026/14/99'), '', '★外形完整但不是真日期');
});

// ---- William 裁示（2026-08-19）：跨期身分穩定不做，殘餘照實釘住 ----
test('殘餘｜期間由缺席變有值＝新建一戶（**看得見的多一戶**，不是靜靜加錢）', () => {
  const db = { accounts: [], transactions: [] };
  const noPeriod = rawAnswer();
  noPeriod.accounts = [{ ...noPeriod.accounts[1], period: '' }];
  applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank(noPeriod)), { deterministic: false });
  assert.equal(db.accounts.length, 1, '第一期建一戶');
  const withPeriod = rawAnswer();
  withPeriod.accounts = [{ ...withPeriod.accounts[1], period: '2026/01/15~2026/07/15' }];
  applyBalancesToDb(db, /** @type {any} */ (normalizeAiBank({ ...withPeriod, referenceDate: '2026-08-31' })), { deterministic: false });
  // ⚠️ 這是**現況**不是理想：期間進身分鍵，鍵變了就是另一顆。W 2026-08-19 裁示縮範圍——跨期身分
  //   穩定（盲配／升級）連三輪製造「錢憑空變多」的高，整段拿掉、另案重新設計。
  //   選這個殘餘的理由：多一戶**會出現在預覽與帳戶清單上、可以手刪**；而盲配那半的失敗是
  //   「舊戶被復活、金額靜靜長回來」——看不見的加錢比看得見的多一戶危險得多。
  assert.equal(db.accounts.length, 2, '★現況＝多一戶（看得見、可手刪）；不得靜靜併戶或改既有戶的身分');
  assert.equal(db.accounts[0].cdKey, '第一銀行|1234|USD||51|#1', '★既有戶的身分鍵原封不動（不被新一期改寫）');
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
  // ★預覽也不得出現歸零列（Grok G3：預覽誤傳 deterministic:true、apply 沒傳＝畫面說要歸零、實際沒歸零＝所見≠所得）
  assert.ok(!(/** @type {any} */ (pv).rows || []).some((/** @type {any} */ r2) => r2.action === 'mature-zero'),
    `★AI 路線的預覽不得出現「定存已到期→歸零」那一列（實得 ${JSON.stringify((/** @type {any} */ (pv).rows || []).map((/** @type {any} */ r2) => r2.action))}）`);
});
