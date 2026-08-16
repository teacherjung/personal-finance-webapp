// @ts-check
// P2-4 新版式雙讀＋三讀仲裁（裁示⑦ 2026-08-16）的行為卷：比對器逐欄承重／一致採 Opus 版／
// 仲裁「恰一份全欄一致」／三讀不同＝ai_disagree 列欄位不列值＋零發票／服務錯照實丟／
// 開關關閉回單讀階梯（那條路的完整行為卷在 test/ai-parse.test.js）／fail-open 判準／呼叫數釘 2·3·4。
// 隔離＝STORE_FILE 暫存檔；引擎全假＝零鑰匙零費用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_STORE = join(tmpdir(), `finance-dualread-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { aiBankRoute, previewBankStatement } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { clearAiTicketsForTest, aiTicketCountForTest } = await import('../lib/ai-confirm-ticket.js');
const { AI_BANK_MODELS, AI_ARBITER_MODEL, aiAnswersAgree, aiDiffSummary, dualReadWanted } = await import('../lib/ai-parse.js');
const { aiPreviewBadgeHtml } = await import('../public/modules/ai-consent.js');

// ---- 夾具：合成一銀版面（帳號一律 900200 前綴＝合成資料鐵則）----
const L = (/** @type {number} */ y, /** @type {any[]} */ pairs) => ({ y, cells: pairs.map((p) => ({ x: p[0], s: p[1] })) });
const linesA = () => [
  L(10, [[40, '一銀活期帳戶明細']]),
  L(30, [[40, '900200****1234'], [200, 'TWD'], [320, '5,000']]),
  L(50, [[40, '2026/07/01'], [140, '超商繳費'], [240, '100'], [320, '4,900']]),
  L(60, [[40, '2026/07/02'], [140, '薪資入帳'], [280, '600'], [320, '5,500']]),
];
const extractA = async () => linesA();
const notRecognized = async () => { throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400 }); };
/** 合法答案卷（過驗收＋接地＋強閘）；overrides 淺蓋頂層欄。 */
const answerOf = (/** @type {any} */ over = {}) => ({
  bank: '第一銀行', referenceDate: '2026-07-31',
  accountCurrencies: [{ masked: '900200****1234', currency: 'TWD' }],
  totals: { txCount: null, totalOut: null, totalIn: null },   // 版面沒印合計＝誠實缺席（接地檢查逐數字對原文）
  accounts: [{ masked: '900200****1234', balance: 5500, currency: 'TWD', label: '活期', note: '' }],
  transactions: [
    { acctMasked: '900200****1234', date: '2026-07-01', direction: 'out', amount: 100, balance: 4900, summary: '超商繳費', note: '' },
    { acctMasked: '900200****1234', date: '2026-07-02', direction: 'in', amount: 600, balance: 5500, summary: '薪資入帳', note: '' },
  ],
  ...over,
});
/** 假引擎：byModel[model] ＝答案（函式＝丟它的錯）；spy 記呼叫順序。 */
const engineOf = (/** @type {Record<string, any>} */ byModel, /** @type {{calls:string[]}} */ spy = { calls: [] }) => ({
  models: AI_BANK_MODELS,
  parseOnce: async (/** @type {string} */ _t, /** @type {string} */ model) => {
    spy.calls.push(model);
    const a = byModel[model];
    if (a === undefined) throw new Error(`夾具沒定義 ${model} 的答案`);
    if (typeof a === 'function') throw a();
    return structuredClone(a);
  },
});
const svcErr = (/** @type {string} */ code) => () => Object.assign(new Error(`合成服務錯（${code}）`), { status: 502, code });
const badAnswer = () => Object.assign(new Error('合成壞答案'), { status: 400, code: 'ai_bad_answer' });
async function seedDb(/** @type {any} */ settingsOver = {}) {
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  delete (/** @type {any} */ (db.settings)).aiDualRead;   // 歸零：前一題的關閉設定不可洩漏到下一題（preview 承重題實抓過）
  Object.assign(db.settings, settingsOver);   // aiDualRead 預設不掛＝走「讀不到＝開」的正式路
  await saveDb(db);
  return getDb();
}
const S = AI_BANK_MODELS.primary, O = AI_BANK_MODELS.escalation, F = AI_ARBITER_MODEL;

// ---- 比對器 ----
test('比對器｜錢欄位逐欄承重：每一個比對欄改壞都要 disagree、diffs 只有欄位沒有數值', () => {
  const base = () => /** @type {any} */ ({
    bank: '第一銀行', referenceDate: '2026-07-31', accountCurrency: { '900200****1234': 'TWD' },
    accounts: [{ masked: '900200****1234', suffix: '1234', balance: 5500, currency: 'TWD', label: '活期', note: '' }],
    transactions: [{ acctSuffix: '1234', acctMasked: '900200****1234', date: '2026-07-01', summary: '超商繳費', direction: 'out', amount: 100, balance: 4900, note: '水電' }],
  });
  assert.deepEqual(aiAnswersAgree(base(), base()), { agree: true, diffs: [] });
  for (const [patch, label] of /** @type {[（(p:any)=>void）, string][]} */ ([
    [(p) => { p.bank = '別家'; }, '機構名'],
    [(p) => { p.referenceDate = null; }, '現值參考日'],
    [(p) => { p.accountCurrency['900200****1234'] = 'USD'; }, '帳戶幣別表'],
    [(p) => { p.accounts[0].balance = 9; }, '帳戶餘額組成'],
    [(p) => { p.transactions[0].amount = 999; }, '第 1 筆交易的金額'],
    [(p) => { p.transactions[0].direction = 'in'; }, '第 1 筆交易的方向'],
    [(p) => { p.transactions[0].date = '2026-07-09'; }, '第 1 筆交易的日期'],
    [(p) => { p.transactions[0].balance = 1; }, '第 1 筆交易的餘額'],
    [(p) => { p.transactions[0].acctMasked = '900200****9999'; }, '第 1 筆交易的帳號'],
    [(p) => { p.transactions[0].acctSuffix = '9999'; }, '第 1 筆交易的帳號末碼'],
    [(p) => { p.accounts[0].masked = '900200****9999'; }, '帳戶餘額組成'],
    [(p) => { p.accounts[0].suffix = '9999'; }, '帳戶餘額組成'],
    [(p) => { p.accounts[0].currency = 'USD'; }, '帳戶餘額組成'],
    [(p) => { p.transactions[0].summary = '超商繳費A'; }, '第 1 筆交易的摘要'],
    [(p) => { p.transactions[0].note = '瓦斯'; }, '第 1 筆交易的備註'],
    [(p) => { p.transactions.pop(); }, '交易筆數'],
  ])) {
    const b = base(); patch(b);
    const r = aiAnswersAgree(base(), b);
    assert.equal(r.agree, false, `★${label} 改壞要 disagree`);
    assert.ok(r.diffs.includes(label), `diffs 要指認「${label}」（實得 ${JSON.stringify(r.diffs)}）`);
    assert.ok(!r.diffs.some((d) => /999|4900|5500|900200/.test(d)), 'diffs 絕不帶數值（機密紀律）');
  }
});

test('比對器｜文字欄空白不敏感（摘要/備註）、label/note 刻意不比、順序嚴格', () => {
  const a = /** @type {any} */ ({ bank: 'x', referenceDate: null, accountCurrency: {}, accounts: [], transactions: [{ acctSuffix: '1', acctMasked: 'm', date: 'd', summary: '超商 繳費', direction: 'out', amount: 1, balance: null, note: '水 電' }] });
  const b = structuredClone(a); b.transactions[0].summary = '超商繳費'; b.transactions[0].note = '水電';
  assert.equal(aiAnswersAgree(a, b).agree, true, '★只差格間空白＝一致（兩個模型取空白本來就不同）');
  const c = /** @type {any} */ ({ bank: 'x', referenceDate: null, accountCurrency: {}, accounts: [{ masked: 'm', suffix: '1', balance: 5, currency: 'TWD', label: '活儲', note: 'A' }], transactions: [] });
  const d = structuredClone(c); d.accounts[0].label = '活期儲蓄'; d.accounts[0].note = 'B';
  assert.equal(aiAnswersAgree(c, d).agree, true, '★帳戶 label/note 措辭不同＝不比（不進帳本金額與去重鍵）');
  const e = structuredClone(a); const f = structuredClone(a);
  f.transactions = [structuredClone(a.transactions[0]), structuredClone(a.transactions[0])];
  e.transactions = [structuredClone(a.transactions[0]), structuredClone(a.transactions[0])];
  f.transactions[0].amount = 2; e.transactions[1].amount = 2;
  assert.equal(aiAnswersAgree(e, f).agree, false, '★同一組交易換順序＝不一致（嚴格比順序）');
});

test('比對器｜aiDiffSummary：至多列 6 處＋「等 N 處」、去重', () => {
  assert.equal(aiDiffSummary(['a', 'a', 'b']), 'a、b');
  const many = ['一', '二', '三', '四', '五', '六', '七', '八'];
  assert.equal(aiDiffSummary(many), '一、二、三、四、五、六⋯等 8 處');
});

test('比對器｜形狀同步（Grok#1 機械化排除）：normalize 輸出必含 accountCurrency map 與比對器讀的每個交易欄', async () => {
  const { normalizeAiBank } = await import('../lib/ai-parse.js');
  const parsed = /** @type {any} */ (normalizeAiBank(/** @type {any} */ (answerOf())));
  assert.ok(parsed.accountCurrency && typeof parsed.accountCurrency === 'object' && !Array.isArray(parsed.accountCurrency), '★比對器讀 accountCurrency map——normalize 改鍵名＝這裡先紅（不會變成「兩個空物件永遠相等」的死碼）');
  assert.equal(parsed.accountCurrency['900200****1234'], 'TWD');
  for (const k of ['acctSuffix', 'acctMasked', 'date', 'direction', 'amount', 'balance', 'summary', 'note']) {
    assert.ok(k in parsed.transactions[0], `★比對器逐欄清單的「${k}」必須真的存在於 normalize 輸出（改形＝比對器對 undefined 互比＝假一致）`);
  }
  // 幣別刀打在**真實形**上：normalize 後只差幣別＝必 disagree
  const usd = /** @type {any} */ (normalizeAiBank(/** @type {any} */ (answerOf({
    accountCurrencies: [{ masked: '900200****1234', currency: 'USD' }],
    accounts: [{ masked: '900200****1234', balance: 5500, currency: 'USD', label: '活期', note: '' }],
  }))));
  const r = aiAnswersAgree(parsed, usd);
  assert.equal(r.agree, false, '★真實形只改幣別＝disagree');
  assert.ok(r.diffs.includes('帳戶幣別表'));
});

// ---- 開關判準 ----
test('開關｜dualReadWanted：只有明確 false 才關——讀不到/壞型別＝開（fail 往多驗證）', () => {
  assert.equal(dualReadWanted({ aiDualRead: false }), false);
  assert.equal(dualReadWanted({ aiDualRead: true }), true);
  assert.equal(dualReadWanted({}), true, '★缺鍵＝開（預設開拍板）');
  assert.equal(dualReadWanted(undefined), true);
  assert.equal(dualReadWanted({ aiDualRead: 'off' }), true, '★壞型別＝開（與 aiAskBeforeSend 相反方向、應該相反）');
});

// ---- 路線行為 ----
test('雙讀｜兩讀一致＝採 Opus 版（label 措辭不同也算一致、寫入的是 escalation 那份）、恰 2 發、dualRead=agree', async () => {
  const db = await seedDb();
  const spy = { calls: /** @type {string[]} */ ([]) };
  const sonnet = answerOf({ accounts: [{ masked: '900200****1234', balance: 5500, currency: 'TWD', label: 'Sonnet 措辭', note: '' }] });
  const opus = answerOf({ accounts: [{ masked: '900200****1234', balance: 5500, currency: 'TWD', label: 'Opus 措辭', note: '' }] });
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: sonnet, [O]: opus }, spy), extract: extractA });
  assert.equal(r.dualRead, 'agree');
  assert.equal(r.aiModel, O, '★採用 escalation（Opus）那份');
  assert.equal(/** @type {any} */ (r).parsed.accounts[0].label, 'Opus 措辭', '★未比對欄也是 Opus 版（不留誰先回來誰贏）');
  assert.deepEqual([...spy.calls].sort(), [O, S].sort(), '★恰 2 發、無仲裁');
});

test('仲裁｜兩讀金額不一致→Fable 與其中一份全欄一致＝採用那份、恰 3 發、dualRead=arbitrated', async () => {
  const db = await seedDb();
  const spy = { calls: /** @type {string[]} */ ([]) };
  const good = answerOf();
  // 真的「金額不一致」（Grok#4：原版差在摘要＝掛羊頭）：bad 是**另一條自洽鏈**——tx2 改 in 100、
  // 帳戶餘額改 5000（4900＋100＝5000＝概要）、每個數字都在版面上（100/4,900/5,000）＝驗收、接地、
  // 強閘全過。兩份都合法、金額不同——正是 r4#1「AI 非確定性」的那類雙讀要抓的形。
  const bad = answerOf({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [good.transactions[0], { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: bad, [O]: good, [F]: good }, spy), extract: extractA });
  assert.equal(r.dualRead, 'arbitrated');
  assert.equal(r.aiModel, O, '★Fable 與 Opus 版一致＝採用 Opus 版（不是 Fable 自己的答案）');
  assert.equal(spy.calls.length, 3, '★恰 3 發（雙讀 2＋仲裁 1）');
  assert.ok(spy.calls.includes(F), '第三發真的是仲裁模型');
});

test('三讀不同｜ai_disagree 400：訊息列欄位、不回聲任何帳單數值；零發票、preview 零寫入', async () => {
  await seedDb();
  const db = await getDb();
  const a = answerOf();
  const b = answerOf({ transactions: [{ ...a.transactions[0], summary: '超商繳費改' }, a.transactions[1]] });
  const c = answerOf({ referenceDate: null });
  await assert.rejects(
    () => previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => /** @type {any} */ (engineOf({ [S]: a, [O]: b, [F]: c })), aiExtract: extractA }),
    (/** @type {any} */ e) => {
      assert.equal(e.code, 'ai_disagree');
      assert.match(e.message, /第 1 筆交易的摘要/, '★標紅的落地形＝訊息列欄位');
      assert.doesNotMatch(e.message, /4900|5500|100|600|900200/, '★絕不回聲帳單數值（機密紀律）');
      assert.match(e.message, /手動記帳/, '只給手動出口');
      return true;
    });
  assert.equal(aiTicketCountForTest(), 0, '★三讀不同＝零發票（沒有任何一份取得寫入資格）');
  assert.equal((db.transactions || []).length, 0);
});

test('仲裁者服務錯｜Fable ai_unavailable＝照實丟（可重試的故障≠三份不同）；Fable 答案壞＝ai_disagree', async () => {
  const db = await seedDb();
  const a = answerOf();
  const b = answerOf({ referenceDate: null });
  await assert.rejects(
    () => aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: a, [O]: b, [F]: svcErr('ai_unavailable') }), extract: extractA }),
    (/** @type {any} */ e) => e.code === 'ai_unavailable');
  await assert.rejects(
    () => aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: a, [O]: b, [F]: badAnswer }), extract: extractA }),
    (/** @type {any} */ e) => e.code === 'ai_disagree');
});

test('一讀掛掉｜另一讀有效＝沒有兩份互證→仍走仲裁：Fable 一致＝採用；兩讀都掛＝服務錯優先照實丟', async () => {
  const db = await seedDb();
  const good = answerOf();
  const spy = { calls: /** @type {string[]} */ ([]) };
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: badAnswer, [O]: good, [F]: good }, spy), extract: extractA });
  assert.equal(r.dualRead, 'attested', '★單讀無互證＝attested（W3：徽章「前兩讀不一致」在此情境是假話、不可共用 arbitrated）');
  assert.equal(spy.calls.length, 3);
  await assert.rejects(
    () => aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: badAnswer, [O]: svcErr('ai_auth') }), extract: extractA }),
    (/** @type {any} */ e) => e.code === 'ai_auth', '★兩讀都掛＝服務類錯優先（換模型救不了）');
});

test('開關關閉｜aiDualRead:false＝回單讀＋升級階梯：快樂路徑恰 1 發、一致性不比對', async () => {
  const db = await seedDb({ aiDualRead: false });
  const spy = { calls: /** @type {string[]} */ ([]) };
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: answerOf(), [O]: answerOf() }, spy), extract: extractA });
  assert.equal(spy.calls.length, 1, '★單讀＝第一發成功就停（雙讀改不動關閉模式）');
  assert.equal(/** @type {any} */ (r).dualRead, undefined, '關閉＝回應不帶 dualRead');
});

test('preview 承重（Grok#2）｜agree 與 arbitrated 都要出現在正式 preview 回應（服務回了、preview 漏掛＝徽章永不畫）', async () => {
  await seedDb();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => /** @type {any} */ (engineOf({ [S]: answerOf(), [O]: answerOf() })), aiExtract: extractA });
  assert.equal(/** @type {any} */ (pv).dualRead, 'agree', '★正式 preview 回應要帶 dualRead');
  assert.ok(pv.aiTicket, '票照發');
  clearAiTicketsForTest();
  const good = answerOf();
  const bad = answerOf({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [good.transactions[0], { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => /** @type {any} */ (engineOf({ [S]: bad, [O]: good, [F]: good })), aiExtract: extractA });
  assert.equal(/** @type {any} */ (pv2).dualRead, 'arbitrated', '★仲裁一樣要透出到 preview');
});

test('W1｜仲裁那發專屬逾時 300 秒、其他模型 90 秒（Fable 單請求可跑數分鐘——90 秒＝最需要仲裁的帳單最容易匯不進去）', async () => {
  const { makeAnthropicBankEngine } = await import('../lib/ai-transport.js');
  /** @type {number[]} */ const seen = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = /** @type {any} */ ((/** @type {number} */ ms) => { seen.push(ms); return realTimeout.call(AbortSignal, ms); });
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) }));
  try {
    await makeAnthropicBankEngine('sk-ant-synthetic-test-key').parseOnce('x', F);
    await makeAnthropicBankEngine('sk-ant-synthetic-test-key').parseOnce('x', S);
  } finally { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; }
  assert.deepEqual(seen, [300_000, 90_000], '★仲裁 300 秒、其他照舊 90 秒——共用 90 秒＝W1 復發');
});

test('W4a｜雙讀兩讀皆閘紅（原錯無 code）＝ai_reconcile_failed、訊息不含任何帳單數值（機密紀律的雙讀版）', async () => {
  const db = await seedDb();
  // 兩份答案都過驗收＋接地、但餘額鏈對不上概要（帳戶 5000 vs 鏈尾 5500）＝對帳閘原錯（無 code、帶數字）
  const gateRed = answerOf({ accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }] });
  await assert.rejects(
    () => aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: gateRed, [O]: gateRed }), extract: extractA }),
    (/** @type {any} */ e) => {
      assert.equal(e.code, 'ai_reconcile_failed', '★無 code 原錯不得原樣外送（帶帳單數字）');
      assert.doesNotMatch(e.message, /4,?900|5,?500|5,?000|900200|超商|薪資/, '★訊息零帳單欄值');
      return true;
    });
});

test('W4b｜雙讀路線不落 log：帳單內文與鑰匙不可出現在任何 console 輸出（單讀版考題掛 false 走不進 aiTryModel）', async () => {
  const db = await seedDb();
  /** @type {string[]} */ const logs = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of /** @type {const} */ (['log', 'info', 'warn', 'error'])) console[k] = (/** @type {any[]} */ ...a) => { logs.push(a.map(String).join(' ')); };
  try { await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: answerOf(), [O]: answerOf() }), extract: extractA }); }
  finally { Object.assign(console, orig); }
  const all = logs.join('\n');
  assert.doesNotMatch(all, /超商繳費|薪資入帳|900200|sk-ant/, '★雙讀路徑（aiTryModel）也在零 log 契約內');
});

test('W6｜四發合成題：仲裁 preview（3 發解析）→兌票 apply（恰 1 發生成）＝「至多 4 發」有考題撐', async () => {
  await seedDb();
  const calls = { parse: 0, gen: 0 };
  const good = answerOf();
  const bad = answerOf({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [good.transactions[0], { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const byModel = { [S]: bad, [O]: good, [F]: good };
  const factory = () => ({
    models: AI_BANK_MODELS,
    parseOnce: async (/** @type {string} */ _t, /** @type {string} */ m) => { calls.parse += 1; return structuredClone(/** @type {any} */ (byModel)[m]); },
    generateRecipe: async () => { calls.gen += 1; return { junk: true }; },   // 生成內容壞掉沒關係——數的是發數
  });
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: /** @type {any} */ (factory), aiExtract: extractA });
  assert.equal(pv.dualRead, 'arbitrated');
  assert.equal(calls.parse, 3, '★仲裁路徑恰 3 發解析');
  const { applyBankStatement } = await import('../lib/services/bank-import.js');
  const res = await applyBankStatement(/** @type {any} */ (undefined), undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: /** @type {any} */ (factory) });
  assert.equal(res.ok, true);
  assert.equal(calls.parse, 3, 'apply 零解析');
  assert.equal(calls.gen, 1, '★恰 1 發生成——合計 4 發＝成本句的「至多 4 發」真的有題撐');
});

// ---- 前端純函式 ----
test('徽章｜dualRead=agree/arbitrated 各有一句、無 dualRead 不畫；句子只講事實不加保證', () => {
  const base = { engine: 'ai', aiModel: O };
  assert.match(aiPreviewBadgeHtml({ ...base, dualRead: 'agree' }), /雙讀一致/);
  assert.match(aiPreviewBadgeHtml({ ...base, dualRead: 'arbitrated' }), /前兩讀不一致/);
  assert.match(aiPreviewBadgeHtml({ ...base, dualRead: 'attested' }), /其中一讀沒讀出合法答案/, '★W3：一讀掛掉不得謊稱「前兩讀不一致」');
  const plain = aiPreviewBadgeHtml(base);
  assert.doesNotMatch(plain, /雙讀一致|三讀仲裁/, '單讀＝不畫雙讀句');
  for (const h of [aiPreviewBadgeHtml({ ...base, dualRead: 'agree' }), aiPreviewBadgeHtml({ ...base, dualRead: 'arbitrated' }), aiPreviewBadgeHtml({ ...base, dualRead: 'attested' })]) {
    assert.doesNotMatch(h, /保證正確|一定對|免驗算/, '徽章不得加保證');
  }
});

test('設定頁｜雙讀開關接線：async 等結果、失敗向 db 重核（核對不到＝顯示關）、不吞錯、預設顯示勾', async () => {
  const { readFileSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  const src = readFileSync(j(process.cwd(), 'public/modules/settings.js'), 'utf8');
  assert.match(src, /dual\.onchange = async \(\) => \{/u, '★開關存檔要等結果（async）');
  assert.doesNotMatch(src, /dual\.checked = !want/u, '★不可用 !want 推定資料庫狀態（#455 r5#1 同款禁令）');
  assert.match(src, /dual\.checked = s2\.aiDualRead !== false/u, '★失敗要向 db 重核、顯示核對結果');
  assert.match(src, /catch \{ dual\.checked = false; \}/u, '★核對不到＝顯示「關」（畫面寧可少保證；執行期相反＝dualReadWanted 讀不到當開）');
  assert.doesNotMatch(src, /saveSettings\(\{ aiDualRead/u, '★不可繞回吞錯誤的 saveSettings');
  assert.match(src, /\$\{s\.aiDualRead === false \? '' : 'checked'\}/u, '★預設顯示勾（缺鍵＝開＝與執行期一致）');
});
