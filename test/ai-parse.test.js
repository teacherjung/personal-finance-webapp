// AI 解析引擎（P1b-1）的考題：全部走**假傳輸**（不用鑰匙、不上網、零費用）。
// 射程：答案卷驗收 fail-closed／四道規矩（AI 要求旗標・HOSTED 停止線・鑰匙・★6 強閘）／模型階梯／
// 兩個正式入口的端到端（含 P1a 機構維度互扣：AI 報的機構直接餵 bank2 去重鍵與機構戳）／
// anthropicTransport 的線上格式與錯誤分類（stub fetch）／機密不落 log。
// 隔離：STORE_FILE 暫存檔（同 bank-statement.test.js 慣例）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TEST_STORE = join(tmpdir(), `finance-aiparse-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { normalizeAiBank, linesToText, buildBankSystem, AI_BANK_MODELS, AI_BANK_SCHEMA } = await import('../lib/ai-parse.js');
const { anthropicTransport, makeAnthropicBankEngine } = await import('../lib/ai-transport.js');
const { previewBankStatement, applyBankStatement, aiBankRoute } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { clearAiTicketsForTest, aiTicketCountForTest, issueAiTicket, redeemAiTicket, restoreAiTicket, AI_TICKET_MAX, AI_TICKET_TTL_MS } = await import('../lib/ai-confirm-ticket.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

// ---- 共用素材（合成資料；機構「合成一銀」＝明顯假值慣例）----

/** 模板解析器接縫：認不得（AI 資格成立的那種錯）。 */
const notRecognized = async () => { throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400 }); };
/** 模板解析器接縫：密碼錯（絕不可落 AI）。 */
const pwErr = async () => { throw Object.assign(new Error('PDF 密碼不對'), { status: 400, code: 'pdf_password' }); };
/** 抽字接縫：AI 路線的文字來源（假傳輸不看內容，給個標記字串供「不落 log」考題辨識）。 */
// ⚠️ 接地檢查（裁示⑧a）生效後，抽字樁的「帳單原文」必須真的印有答案卷會用到的數字——
// 這正是接地在驗的事（答案的每個金額都要在原文找得到）；獨立的接地考題另測「不在原文＝拒」。
const fakeExtract = async () => [{ y: 0, cells: [{ x: 0, s: '合成帳單內文標記字串 1,000 500 1,500 999 3 300 100 200 777 999,999 888,888' }] }];

/** 平衡的答案卷（強閘全過：餘額鏈 2 對＋末筆 1500 對概要 1500）。 */
const goodAnswer = () => ({
  bank: '合成一銀', referenceDate: '2026-06-30',
  accountCurrencies: [{ masked: '900200****3302', currency: 'TWD' }],
  totals: { txCount: null, totalOut: null, totalIn: null },   // 必填欄（缺席＝ai_bad_answer）；null＝AI 沒交回那一欄
  accounts: [{ masked: '900200****3302', balance: 1500, currency: 'TWD', label: '活存', note: '' }],
  transactions: [
    { acctMasked: '900200****3302', date: '2026-06-01', direction: 'in', amount: 1000, balance: 1000, summary: '轉帳存入', note: '薪資' },
    { acctMasked: '900200****3302', date: '2026-06-02', direction: 'out', amount: 500, balance: 500, summary: 'CD提款', note: '' },
    { acctMasked: '900200****3302', date: '2026-06-03', direction: 'in', amount: 1000, balance: 1500, summary: '存款息', note: '' },
  ],
});
/** 弱閘答案卷（餘額全 null、無概要帳戶＝一對都驗不到）。 */
const weakAnswer = () => ({
  bank: '合成一銀', referenceDate: '2026-06-30', accountCurrencies: [{ masked: '900200****3302', currency: 'TWD' }], totals: { txCount: null, totalOut: null, totalIn: null }, accounts: [],
  transactions: [{ acctMasked: '900200****3302', date: '2026-06-01', direction: 'in', amount: 1000, balance: null, summary: '轉帳存入', note: '' }],
});
/** 對不上的答案卷（餘額鏈斷＝擋下型不一致）。 */
const unbalancedAnswer = () => {
  const a = goodAnswer();
  a.transactions[1].balance = 999;   // 1000 - 500 應為 500
  return a;
};

/** 假傳輸：依序回 answers（元素是函式＝丟它的錯）；記錄每次呼叫的 model。 */
function spyTransport(answers) {
  /** @type {{model:string}[]} */
  const calls = [];
  const fn = async ({ model }) => {
    calls.push({ model });
    const a = answers[calls.length - 1];
    if (typeof a === 'function') throw a();
    return a;
  };
  return { fn, calls };
}

/** 假引擎工廠：包住 spyTransport＝服務層收原始答案、自己驗收（與真工廠 makeAnthropicBankEngine 同介面）。 @param {{fn:any}} spy */
const engineOf = (spy) => () => ({ models: AI_BANK_MODELS, parseOnce: (/** @type {string} */ text, /** @type {string} */ model) => spy.fn({ model, text }) });

/** 重設隔離 db：清帳戶/交易、設定鑰匙有無。 @param {boolean} withKey
 * ⚠️ P2-4 起本卷＝**單讀＋升級階梯（雙讀開關關閉）**的行為卷——夾具一律掛 aiDualRead:false；
 * 雙讀／仲裁的行為卷在 test/ai-dual-read.test.js（預設開的那條路歸它守）。 */
async function seedDb(withKey) {
  clearAiTicketsForTest();   // 票匣跨題互不干擾（比照 resetRateLimitsForTest）
  const db = await getDb();
  db.accounts = [];
  db.transactions = [];
  db.settings.aiApiKey = withKey ? 'sk-ant-synthetic-test-key' : '';
  /** @type {any} */ (db.settings).aiDualRead = false;
  await saveDb(db);
}

// ---- 答案卷驗收（fail-closed）----

test('驗收｜答案卷逐欄 fail-closed：方向/負數/假日期/無末碼帳號/壞幣別/非物件 全部 ai_bad_answer', () => {
  const bad = (mut) => {
    const a = goodAnswer();
    mut(a);
    assert.throws(() => normalizeAiBank(a), (/** @type {any} */ e) => e.code === 'ai_bad_answer');
  };
  bad((a) => { a.transactions[0].direction = 'debit'; });
  bad((a) => { a.transactions[0].amount = -100; });                 // 金額欄無正負、方向由 direction 表達
  bad((a) => { a.transactions[0].date = '2026-02-31'; });          // 不存在的日期（isRealDate 同匯入牆）
  bad((a) => { a.accounts[0].masked = '＊＊＊＊'; });               // 取不出末碼
  bad((a) => { a.accounts[0].currency = 'NT$'; });                 // 非三碼幣別
  bad((a) => { a.transactions[0].amount = Number.NaN; });
  assert.throws(() => normalizeAiBank(null), (/** @type {any} */ e) => e.code === 'ai_bad_answer');
  assert.throws(() => normalizeAiBank([1]), (/** @type {any} */ e) => e.code === 'ai_bad_answer');
});

test('驗收｜機構名剝分段符（bank2 去重鍵的 | 不可入段）；正常答案卷過驗收＝形狀對齊模板解析器', () => {
  const ok = normalizeAiBank({ ...goodAnswer(), bank: '合成|一銀' });
  assert.equal(ok.bank, '合成一銀');
  assert.equal(ok.accountCurrency['900200****3302'], 'TWD', 'accountCurrency 由權威幣別表 accountCurrencies 建（r2#1；與模板 accountCurrency 同形）');
  assert.equal(ok.accounts[0].suffix, '3302', '末碼由程式自己算、不信 AI');
  assert.throws(() => normalizeAiBank({ ...goodAnswer(), bank: '|||' }), (/** @type {any} */ e) => e.code === 'ai_bad_answer', '剝完只剩空＝壞答案');
});

test('驗收｜r2#1 幣別身分權威欄：accounts 不得兼任幣別表——與權威表缺席/矛盾都 fail-closed', () => {
  const a = goodAnswer();
  a.accountCurrencies = [];   // 有餘額的帳戶不在權威表＝壞答案（幣別表要含概要所有帳戶）
  assert.throws(() => normalizeAiBank(a), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /accountCurrencies/.test(e.message));
  const b = goodAnswer();
  b.accountCurrencies[0].currency = 'USD';   // 幣別矛盾＝壞答案
  assert.throws(() => normalizeAiBank(b), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /矛盾/.test(e.message));
  const c = goodAnswer();
  c.accountCurrencies.push({ masked: '900600****6606', currency: 'USD' });   // 空白餘額外幣帳戶＝合法、進權威表
  assert.equal(normalizeAiBank(c).accountCurrency['900600****6606'], 'USD', '餘額空白的帳戶幣別仍要記到（2026-07-28 模板同一課）');
});

test('r3#1｜整個帳戶連幣別表一起漏交＝整份打回：交易帳號必須在權威表（否則 fallback 台幣復活）', async () => {
  await seedDb(true);
  // r3 反例：USD 帳戶同時漏出 accountCurrencies 與 accounts，只剩兩筆自洽交易——曾經 imported:5
  const omitted = () => {
    const a = goodAnswer();
    a.transactions.push(
      { acctMasked: '900700****7707', date: '2026-06-04', direction: 'in', amount: 300, balance: 300, summary: '轉帳存入', note: '' },
      { acctMasked: '900700****7707', date: '2026-06-05', direction: 'out', amount: 100, balance: 200, summary: '轉帳支取', note: '' },
    );
    return a;
  };
  assert.throws(() => normalizeAiBank(omitted()), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /accountCurrencies/.test(e.message),
    '驗收層就要打回——AI 是不可信輸入，提示詞不是保證');
  const spy = spyTransport([omitted(), omitted()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_bad_answer');
  assert.equal(spy.calls.length, 2, '兩級都試過（答案卷壞＝升級重試一次）');
  const db = await getDb();
  assert.equal(db.transactions.length, 0, 'r3 實測曾 imported:5——現在必須零寫入');
});

test('r2#1｜空白餘額的外幣帳戶不得被當台幣：閘排除於 TWD 覆蓋、preview 標 foreign、apply 不入帳', async () => {
  await seedDb(true);
  // Codex r2 反例：TWD 帳戶正常＋USD 帳戶概要餘額空白（不在 accounts、只在幣別表）、明細餘額鏈自洽
  const usdMixed = () => {
    const a = goodAnswer();
    a.accountCurrencies.push({ masked: '900700****7707', currency: 'USD' });
    a.transactions.push(
      { acctMasked: '900700****7707', date: '2026-06-04', direction: 'in', amount: 300, balance: 300, summary: '轉帳存入', note: '' },
      { acctMasked: '900700****7707', date: '2026-06-05', direction: 'out', amount: 100, balance: 200, summary: '轉帳支取', note: '' },
    );
    return a;
  };
  const spy = spyTransport([usdMixed()]);
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.equal(pv.engine, 'ai', 'TWD 帳戶覆蓋完整＝整份可過（外幣列不是 TWD 覆蓋的一員）');
  const usdRows = pv.transactions.rows.filter((r) => r.currency === 'USD');
  assert.equal(usdRows.length, 2, 'r2 反例：這兩筆曾被判成 currency TWD／foreign false');
  assert.ok(usdRows.every((r) => r.foreign === true));
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.equal(res.transactions.imported, 3, '只入台幣那三筆（r2 實測曾 imported:4）');
  assert.equal(res.transactions.foreign, 2, 'USD 兩筆誠實計入 foreign、不進台幣現金流');
  const db = await getDb();
  assert.ok(db.transactions.every((t) => !String(t.bankRef).includes('900700****7707')), 'USD 帳戶的列一筆都不可寫進 cashflow');
});

test('linesToText｜cells 依 x 排序後相接（座標列→AI 輸入）', () => {
  assert.equal(linesToText([{ y: 0, cells: [{ x: 50, s: '乙' }, { x: 10, s: '甲' }] }, { y: 1, cells: [{ x: 0, s: '丙' }] }]), '甲 乙\n丙');
});

// ---- 四道規矩（順序＝防線順序）----

test('規矩② AI 要求旗標｜缺席＝零 AI 呼叫＋模板原句錯誤照丟（確認窗沒蓋好前這條路不通）', async () => {
  await seedDb(true);
  const spy = spyTransport([goodAnswer()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    /看起來不是台新/);
  assert.equal(spy.calls.length, 0, '沒有 AI 要求旗標＝連一次 AI 都不可呼叫');
});

test('規矩②之前｜密碼錯（pdf_password）不落 AI：要回前端跳密碼窗，不是送 AI', async () => {
  await seedDb(true);
  const spy = spyTransport([goodAnswer()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, pwErr, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'pdf_password');
  assert.equal(spy.calls.length, 0);
});

test('規矩①HOSTED 停止線｜有鑰匙照樣 400、零 AI 呼叫；且排在鑰匙檢查**之前**（沒鑰匙也回停止線）', async () => {
  // 直接打 aiBankRoute（見其 export 註解：整合層翻 NOTEASY_HOSTED 會讓儲存層先要租戶而炸、到不了守門）
  const spy = spyTransport([goodAnswer()]);
  process.env.NOTEASY_HOSTED = '1';
  try {
    await assert.rejects(
      aiBankRoute('QUFBQQ==', undefined, { settings: { aiApiKey: 'sk-ant-synthetic-test-key', aiDualRead: false } }, { engineFactory: engineOf(spy), extract: fakeExtract }),
      (/** @type {any} */ e) => e.code === 'ai_hosted_off' && /雲端版/.test(e.message));
    await assert.rejects(
      aiBankRoute('QUFBQQ==', undefined, { settings: { aiApiKey: '' } }, { engineFactory: engineOf(spy), extract: fakeExtract }),
      (/** @type {any} */ e) => e.code === 'ai_hosted_off', '停止線在鑰匙檢查之前——雲端版連「去設鑰匙」都不該被指路');
  } finally { delete process.env.NOTEASY_HOSTED; }
  assert.equal(spy.calls.length, 0);
});

test('規矩③鑰匙｜未設定＝白話 400 指路設定頁、零 AI 呼叫', async () => {
  await seedDb(false);
  const spy = spyTransport([goodAnswer()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_no_key' && /設定頁/.test(e.message));
  assert.equal(spy.calls.length, 0);
});

test('規矩④★6 強閘｜弱閘答案（升級後仍弱）＝拒收；模型階梯真的走了兩級', async () => {
  await seedDb(true);
  const spy = spyTransport([weakAnswer(), weakAnswer()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_weak_refused' && /不收/.test(e.message));
  assert.deepEqual(spy.calls.map((c) => c.model), [AI_BANK_MODELS.primary, AI_BANK_MODELS.escalation],
    '★3＋裁示⑥：primary 先解、閘不過升 escalation 重試一次——不多不少');
});

// ---- 模型階梯與端到端 ----

test('階梯｜閘紅（不一致）→升級成功；快樂路徑回 engine/aiModel＋P1a 機構維度直接互扣', async () => {
  await seedDb(true);
  const spy = spyTransport([unbalancedAnswer(), goodAnswer()]);
  const res = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.equal(res.engine, 'ai');
  assert.equal(res.aiModel, AI_BANK_MODELS.escalation, '第一發閘紅＝升級（escalation）那一發成功');
  assert.equal(res.reconcile.level, 'strong', '★6：AI 路線只收強閘');
  assert.equal(res.rows[0].action, 'create');
  assert.equal(res.transactions.rows.length, 3);
  assert.ok(res.transactions.rows[0].bankRef.startsWith('bank2|合成一銀|900200****3302|'),
    'AI 報的機構直接餵 P1a 的 bank2 去重鍵——不同銀行同字樣不撞鍵');
});

test('階梯｜答案卷壞（ai_bad_answer）→升級；服務類錯誤（ai_auth）＝不升級、一發就停', async () => {
  await seedDb(true);
  const s1 = spyTransport([{ bank: 123 }, goodAnswer()]);   // 第一發形狀壞
  const r1 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(s1), aiExtract: fakeExtract });
  assert.equal(r1.aiModel, AI_BANK_MODELS.escalation);
  const s2 = spyTransport([() => Object.assign(new Error('AI 解析鑰匙無效或已停用，請到設定頁重新設定'), { status: 400, code: 'ai_auth' })]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(s2), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_auth');
  assert.equal(s2.calls.length, 1, '鑰匙壞升級也不會好——不可白燒第二發');
});

test('apply｜快樂路徑真寫入：帳戶蓋機構戳（合成一銀）、交易 bank2 鍵、回 engine:ai', async () => {
  await seedDb(true);
  const spy = spyTransport([goodAnswer()]);
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.equal(res.engine, 'ai');
  assert.equal(res.aiModel, AI_BANK_MODELS.primary);
  assert.equal(res.created, 1);
  assert.equal(res.transactions.imported, 3);
  const db = await getDb();
  const acc = db.accounts.find((a) => a.accountNo === '900200****3302');
  assert.equal(acc.bank, '合成一銀', 'P1a 機構戳＝帳單（AI 答案卷）自己的宣告');
  assert.equal(acc.name, '合成一銀 3302（活存）');
  assert.ok(db.transactions.every((t) => t.bankRef.startsWith('bank2|合成一銀|')));
});

test('apply｜弱閘拒收＝連票都拿不到：preview 400，apply 無票再擋一次、db 一筆都不可多', async () => {
  await seedDb(true);
  const spy = spyTransport([weakAnswer(), weakAnswer()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_weak_refused', '弱閘在預覽就擋下＝發不出票');
  const spy2 = spyTransport([weakAnswer(), weakAnswer()]);
  await assert.rejects(
    applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy2), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_ticket_required');
  assert.equal(spy2.calls.length, 0, 'apply 不自己跑模型（r4#1）——連一發都不可');
  const db = await getDb();
  assert.equal(db.accounts.length, 0, '擋下＝零寫入');
  assert.equal(db.transactions.length, 0);
});

test('規矩④r1#1｜混合帳戶不搭便車：A 帳戶驗得動、B 帳戶餘額全空＝整份拒收（preview＋apply 零寫入）', async () => {
  await seedDb(true);
  const mixed = () => {
    const a = goodAnswer();
    a.accountCurrencies.push({ masked: '900500****5505', currency: 'TWD' });
    a.accounts.push({ masked: '900500****5505', balance: 777, currency: 'TWD', label: '活存', note: '' });
    a.transactions.push(
      { acctMasked: '900500****5505', date: '2026-06-05', direction: 'in', amount: 999999, balance: null, summary: '轉帳存入', note: '' },
      { acctMasked: '900500****5505', date: '2026-06-06', direction: 'out', amount: 888888, balance: null, summary: '轉帳支取', note: '' },
    );
    return a;
  };
  const spy = spyTransport([mixed(), mixed()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_weak_refused',
    'r1#1 反例：level 是全檔旗標，B 帳戶零擋下型也曾放行＝搭便車；逐帳戶覆蓋要求要擋下');
  const spy2 = spyTransport([mixed(), mixed()]);
  await assert.rejects(
    applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy2), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_ticket_required', 'preview 擋下＝沒有票，apply 也進不來（r4#1 之後兩道都在）');
  const db = await getDb();
  assert.equal(db.transactions.length, 0, 'r1 實測曾 imported:4——現在必須零寫入');
  assert.equal(db.accounts.length, 0);
});

test('r1#3｜閘紅終局錯誤不含帳單欄值：ai_reconcile_failed、marker/金額/末碼都不得外洩', async () => {
  await seedDb(true);
  const leaky = () => {
    const a = goodAnswer();
    a.transactions[1].balance = 999;                       // 鏈斷＝擋下型不一致
    a.transactions[1].summary = 'SENSITIVE標記字串';        // 對帳閘訊息會引用摘要——不可外送
    return a;
  };
  const spy = spyTransport([leaky(), leaky()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => {
      assert.equal(e.code, 'ai_reconcile_failed', '要有機器可讀 code（前端分流）');
      for (const leak of ['SENSITIVE標記字串', '999', '1,000', '500', '3302']) {
        assert.ok(!String(e.message).includes(leak), `終局錯誤訊息不可含帳單欄值（${leak}）`);
      }
      return true;
    });
  assert.equal(spy.calls.length, 2, '兩級都試過才收斂到終局錯誤');
});

test('r6#1｜誠實劃界的行為釘樁：末筆對概要可跳過、概要-only 台幣帳戶完全沒被驗算卻會寫入', async () => {
  await seedDb(true);
  // 反例①：TWD 帳戶有自洽明細、但概要**沒有**這個帳戶的餘額 ⇒ endBalance 是 skip、level 仍 strong
  const noSummary = () => {
    const a = goodAnswer();
    a.accounts = [];   // 概要沒有餘額可對（帳單只印明細的版面）
    return a;
  };
  const spy1 = spyTransport([noSummary()]);
  const pv1 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy1), aiExtract: fakeExtract });
  assert.equal(pv1.reconcile.checks.endBalance, 'skip', '沒有概要餘額＝末筆對概要這一關根本沒跑');
  assert.equal(pv1.reconcile.level, 'strong', '餘額鏈仍驗得動＝現行行為放行（文案已據此收回「一定會對概要」）');

  // 反例②：一個只出現在概要、明細一筆都沒有的 TWD 帳戶 ⇒ 完全沒被驗算，卻會被新建＋寫入餘額
  await seedDb(true);
  const summaryOnly = () => {
    const a = goodAnswer();
    a.accountCurrencies.push({ masked: '900800****8808', currency: 'TWD' });
    a.accounts.push({ masked: '900800****8808', balance: 777, currency: 'TWD', label: '活存', note: '' });
    return a;   // 這個帳戶沒有任何 transactions
  };
  const spy2 = spyTransport([summaryOnly()]);
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy2), aiExtract: fakeExtract });
  assert.equal(pv2.reconcile.stats.twdAccountsUnverified, 0, 'twdAccountsUnverified 只算「有交易列」的帳戶——概要-only 不在它的射程內');
  assert.equal(pv2.rows.find((/** @type {any} */ r) => r.suffix === '8808').action, 'create');
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv2.aiTicket, aiEngineFactory: engineOf(spy2), aiExtract: fakeExtract });
  assert.equal(res.created, 2, '★現行行為：完全沒被驗算的概要餘額仍會新建帳戶並寫入');
  const acc = (await getDb()).accounts.find((/** @type {any} */ a) => a.accountNo === '900800****8808');
  assert.equal(acc.balance, 777);
  // ⚠️ 這一題**釘的是現行行為、不是理想行為**：收緊成「概要-only 也要拒收」會誤擋大量合法帳單
  //    （真實帳單常有「這期沒往來」的帳戶——lib/statement-reconcile.js 的既有註解就是這樣寫的），
  //    同 P0.1 外幣誤擋的教訓。所以本支選擇「文案收回＋畫面揭露」，並把「AI 路線是否該跳過未驗算的
  //    概要餘額」列候選。將來若改政策，這一題會提醒你連同前端文案一起改。
});

// ---- 確認票（r4#1：AI 非確定性，「使用者確認的＝寫入的」）----

test('r4#1｜確認內容＝寫入內容：apply 憑票寫入 preview 那一份，第二份答案無法靜默落帳', async () => {
  await seedDb(true);
  // Codex r4 反例：兩份**各自都過強閘**但金額不同的答案（模板解析器同一份 PDF 不會這樣，AI 會）
  const second = () => {
    const a = goodAnswer();
    a.transactions[1].amount = 400;   // 500 → 400
    a.transactions[1].balance = 600;  // 鏈仍自洽：1000-400=600
    a.transactions[2].balance = 1600;
    a.accounts[0].balance = 1600;     // 概要也跟著＝末筆對概要照樣過
    return a;
  };
  const spy = spyTransport([goodAnswer(), second()]);
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.ok(pv.aiTicket, '預覽要發確認票');
  assert.deepEqual(pv.transactions.rows.map((r) => r.amount), [1000, 500, 1000], '使用者看到的是第一份');
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.equal(res.transactions.imported, 3);
  assert.equal(spy.calls.length, 1, 'apply 不可再跑模型——第二份答案根本不該被產生（r4 實測它會落帳）');
  const db = await getDb();
  assert.deepEqual(db.transactions.map((t) => t.amount).sort((a, b) => a - b), [500, 1000, 1000], '寫入的就是使用者確認的那一份');
  const acc = db.accounts.find((a) => a.accountNo === '900200****3302');
  assert.equal(acc.balance, 1500, '餘額也是第一份的 1500，不是第二份的 1600');
});

test('r4#1｜票是一次性＋認不得的票 fail-closed：重放與假票都 400、零寫入', async () => {
  await seedDb(true);
  const spy = spyTransport([goodAnswer()]);
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  const before = (await getDb()).transactions.length;
  await assert.rejects(
    applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_ticket_invalid', '同一張票用第二次＝無效（也順帶擋掉「按兩次套用寫兩次」）');
  await assert.rejects(
    applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: '不存在的票號', aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_ticket_invalid');
  assert.equal((await getDb()).transactions.length, before, '兩次拒絕都不可多寫一筆');
  assert.equal(spy.calls.length, 1, '全程只有 preview 那一發模型呼叫');
});

test('票制｜**apply 階段**的失敗要把票放回，而且不可只認某一種錯誤類別（r1#4）', async () => {
  await seedDb(true);
  // ⚠️ 這題的前身是「讀不到現值參考日→整份失敗」，那個情境 2026-08-13 起不再成立。
  //    我上一版把它改成「預覽被擋就不發票」＝守的是別的東西，於是「apply 途中失敗要放回票」
  //    在**非 getDb** 的路徑上沒有任何考題（複審把正式碼改成「只有 SyntaxError 才放回」，全綠）。
  // ⚠️ **刻意不用 getDb 失敗**：那個失敗是 JSON.parse 丟的 `SyntaxError`，壞掉的實作照樣過得了它。
  //    這裡改用 `saveDb` 的櫃檯清理（壞日期）丟出一般 Error——**換一種錯型**，才證明得了
  //    「放回」不是綁在某個錯誤類別上。
  const spy = spyTransport([goodAnswer()]);
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized,
    { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.ok(pv.aiTicket, '前置：預覽過閘、拿得到票');

  const raw = new DatabaseSync(TEST_STORE);
  const before = /** @type {any} */ (raw.prepare("SELECT data FROM kv WHERE key='transactions'").get());
  raw.prepare('UPDATE kv SET data=? WHERE key=?')
    .run(JSON.stringify([{ id: 'bad1', date: 'not-a-date', amount: 1, type: 'expense' }]), 'transactions');

  await assert.rejects(
    () => applyBankStatement('QUFBQQ==', undefined, notRecognized,
      { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code !== 'ai_ticket_invalid' && !(e instanceof SyntaxError),
    '前置：這次要因為**非 SyntaxError** 的寫入失敗而擋下，不是因為票不見');

  raw.prepare('UPDATE kv SET data=? WHERE key=?').run(before.data, 'transactions');
  raw.close();

  // ★真正要守的：票還在。不然使用者為了一次寫入失敗，得重新上傳＋再花一次 AI 費用。
  assert.ok(redeemAiTicket(pv.aiTicket), '★apply 途中失敗要把票放回——而且不可只認某一種錯誤類別');
  assert.equal(spy.calls.length, 1, '全程只有 preview 那一發模型呼叫');
});


test('票匣｜r1#3 放回也要守張數上限（兌走再補新票不可無限累積帳單內文）', () => {
  clearAiTicketsForTest();
  const t0 = 7_000_000;
  // 發滿上限、全部兌走（模擬 in-flight），再發滿上限，最後把前面那批全部放回
  const first = Array.from({ length: AI_TICKET_MAX }, (_, i) => issueAiTicket({ parsed: { n: i }, aiModel: 'm' }, t0));
  const held = first.map((id) => ({ id, t: redeemAiTicket(id, t0) }));
  for (let i = 0; i < AI_TICKET_MAX; i++) issueAiTicket({ parsed: { n: 100 + i }, aiModel: 'm' }, t0);
  for (const { id, t } of held) restoreAiTicket(id, t, t0);
  assert.ok(aiTicketCountForTest() <= AI_TICKET_MAX,
    `★放回要走同一套容量政策（實測曾累積到 ${AI_TICKET_MAX * 2} 張，每張都含帳單交易內容）——現在是 ${aiTicketCountForTest()} 張`);
});

test('票匣｜restoreAiTicket：保留原到期時間、不延長；過期的不放回', () => {
  clearAiTicketsForTest();
  const t0 = 5_000_000;
  const id = issueAiTicket({ parsed: { bank: '合成一銀' }, aiModel: 'm' }, t0);
  const t = redeemAiTicket(id, t0);
  assert.ok(t, '先兌走（模擬 apply 取票）');
  assert.equal(redeemAiTicket(id, t0), null, '兌走後票匣就沒有它了');
  assert.equal(restoreAiTicket(id, t, t0), true, '放回去');
  assert.equal(redeemAiTicket(id, t0)?.parsed.bank, '合成一銀', '放回後兌得到、內容不變');
  // 不延長：原到期時間之後就兌不到
  const id2 = issueAiTicket({ parsed: {}, aiModel: 'm' }, t0);
  const t2 = redeemAiTicket(id2, t0);
  restoreAiTicket(id2, t2, t0 + 1000);
  assert.equal(redeemAiTicket(id2, t0 + AI_TICKET_TTL_MS), null, '★放回不可延長壽命（短效是機密紀律）');
  assert.equal(restoreAiTicket('x', { parsed: {}, aiModel: 'm', exp: t0 - 1 }, t0), false, '已過期的不放回');
  assert.equal(restoreAiTicket('', null, t0), false);
});

test('票匣｜TTL 過期＝兌不到；一次性；張數上限丟最舊；票號不可預測', () => {
  clearAiTicketsForTest();
  const t0 = 1_000_000;
  const id = issueAiTicket({ parsed: { bank: '合成一銀' }, aiModel: 'm' }, t0);
  assert.match(id, /^[0-9a-f-]{36}$/, 'randomUUID＝猜不到');
  assert.equal(redeemAiTicket(id, t0 + AI_TICKET_TTL_MS - 1)?.parsed.bank, '合成一銀', 'TTL 內兌得到');
  assert.equal(redeemAiTicket(id, t0 + 1), null, '一次性：兌過就沒了');
  const id2 = issueAiTicket({ parsed: {}, aiModel: 'm' }, t0);
  assert.equal(redeemAiTicket(id2, t0 + AI_TICKET_TTL_MS), null, '到期即失效（帳單內文不在記憶體久留）');
  clearAiTicketsForTest();
  const ids = Array.from({ length: AI_TICKET_MAX + 1 }, (_, i) => issueAiTicket({ parsed: { n: i }, aiModel: 'm' }, t0));
  assert.equal(redeemAiTicket(ids[0], t0), null, '超過上限＝丟最舊');
  assert.equal(redeemAiTicket(ids[AI_TICKET_MAX], t0)?.parsed.n, AI_TICKET_MAX, '最新的還在');
});

test('r5#1｜票到期會自己把帳單內文從記憶體清掉（沒有人再碰票 API 也一樣）', (t) => {
  clearAiTicketsForTest();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  issueAiTicket({ parsed: { bank: '合成一銀', transactions: [{ amount: 1000 }] }, aiModel: 'm' });
  assert.equal(aiTicketCountForTest(), 1);
  t.mock.timers.tick(AI_TICKET_TTL_MS + 1);
  assert.equal(aiTicketCountForTest(), 0,
    '到期＝內容真的被釋放（只靠「下次有人碰票匣才清」的話，最後一次預覽的帳單內文會留到程序結束）');
});

test('r5#2｜票不是通行證：憑票的 apply 仍過 fresh-db 閘——票裡是弱閘答案＝拒收、零寫入', async () => {
  await seedDb(true);
  // 直接發一張「內容是弱閘答案」的票（正常流程發不出這種票——preview 會先擋；這題要驗的是
  // **寫入路徑自己**的那道閘還在：拿掉 applyBankStatement 的 assertAiBankReconciled 就要紅）
  const ticket = issueAiTicket({ parsed: normalizeAiBank(weakAnswer()), aiModel: AI_BANK_MODELS.primary });
  await assert.rejects(
    applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: ticket, aiEngineFactory: engineOf(spyTransport([])), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_weak_refused');
  const db = await getDb();
  assert.equal(db.transactions.length, 0, '寫入路徑 fail-closed：閘一定在任何寫入之前');
  assert.equal(db.accounts.length, 0);
});

test('r5#2b｜票裡是不一致答案（餘額鏈斷）＝fresh-db 閘擋下、零寫入', async () => {
  await seedDb(true);
  const ticket = issueAiTicket({ parsed: normalizeAiBank(unbalancedAnswer()), aiModel: AI_BANK_MODELS.primary });
  await assert.rejects(
    applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: ticket, aiEngineFactory: engineOf(spyTransport([])), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.status === 400);
  assert.equal((await getDb()).transactions.length, 0);
});

// ---- 機密流向 ----

test('機密｜整條 AI 路線不落 log：帳單內文與鑰匙不可出現在任何 console 輸出', async () => {
  await seedDb(true);
  const logged = /** @type {string[]} */ ([]);
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of /** @type {const} */ (['log', 'warn', 'error'])) {
    console[k] = (/** @type {any[]} */ ...args) => { logged.push(args.map(String).join(' ')); };
  }
  try {
    const spy = spyTransport([goodAnswer()]);
    await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  } finally { Object.assign(console, orig); }
  assert.ok(!logged.some((l) => l.includes('合成帳單內文標記字串')), '帳單內文不落 log');
  assert.ok(!logged.some((l) => l.includes('sk-ant-synthetic-test-key')), '鑰匙不落 log');
});

// ---- anthropicTransport（stub fetch：釘線上格式與錯誤分類）----

test('transport｜請求形狀＝官方結構化輸出（output_config.format.json_schema）＋鑰匙走 x-api-key 標頭', async () => {
  /** @type {any} */ let captured = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"pinged":true}' }] }) };
  });
  try {
    const out = await makeAnthropicBankEngine('sk-ant-synthetic-test-key').parseOnce('帳單文字', AI_BANK_MODELS.primary);
    assert.deepEqual(out, { pinged: true }, '真工廠交原始答案（驗收在服務層）');
  } finally { globalThis.fetch = origFetch; }
  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.init.headers['x-api-key'], 'sk-ant-synthetic-test-key');
  assert.equal(captured.init.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, AI_BANK_MODELS.primary);
  assert.equal(body.max_tokens, 16000, '★r1#2：thinking 同池後的上限（8192＝Haiku 遺產，退回＝這裡紅）');
  assert.equal(body.output_config?.effort, 'medium', '★r1#2：effort:medium（抄錄型起點；拿掉＝預設 high、思考開銷失控）');
  assert.ok(!('temperature' in body), 'r1#2：Sonnet 5 家族拒非預設 sampling 參數——一律不帶（格式由結構化輸出鎖）');
  assert.equal(body.output_config.format.type, 'json_schema', '固定答案卷＝結構化輸出（2026-08-12 官方文件核對）');
  assert.deepEqual(body.output_config.format.schema, AI_BANK_SCHEMA);
  assert.equal(body.messages[0].content, '帳單文字');
  assert.equal(body.system, buildBankSystem(), '真工廠掛的是正式提示詞');
  // r1#2 的那把刀口：升級那一發（Sonnet）的請求形狀也要釘——不帶 temperature/top_p/top_k
  const origFetch2 = globalThis.fetch;
  /** @type {any} */ let captured2 = null;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    captured2 = { url, init };
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) };
  });
  try { await makeAnthropicBankEngine('sk-ant-synthetic-test-key').parseOnce('帳單文字', AI_BANK_MODELS.escalation); }
  finally { globalThis.fetch = origFetch2; }
  const body2 = JSON.parse(captured2.init.body);
  assert.equal(body2.model, AI_BANK_MODELS.escalation);
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in body2), `Sonnet 5 對非預設 ${k} 回 400——升級那一發不可帶`);
});

test('transport｜錯誤分類：401=ai_auth、500=ai_unavailable(502)、refusal=ai_refusal、截斷=ai_truncated、壞 JSON=ai_bad_answer', async () => {
  const origFetch = globalThis.fetch;
  const respond = (/** @type {any} */ r) => { globalThis.fetch = /** @type {any} */ (async () => r); };
  const call = () => anthropicTransport('k')({ model: 'm', system: 's', user: 'u', schema: {} });
  try {
    respond({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(call(), (/** @type {any} */ e) => e.code === 'ai_auth' && e.status === 400);
    respond({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(call(), (/** @type {any} */ e) => e.code === 'ai_unavailable' && e.status === 502);
    respond({ ok: true, status: 200, json: async () => ({ stop_reason: 'refusal', content: [] }) });
    await assert.rejects(call(), (/** @type {any} */ e) => e.code === 'ai_refusal');
    respond({ ok: true, status: 200, json: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }) });
    await assert.rejects(call(), (/** @type {any} */ e) => e.code === 'ai_truncated');
    respond({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '不是JSON' }] }) });
    await assert.rejects(call(), (/** @type {any} */ e) => e.code === 'ai_bad_answer');
  } finally { globalThis.fetch = origFetch; }
});

// ---- 機密欄位（aiApiKey 比照 flexToken 五件套的行為面）----

test('aiApiKey｜投影剝除只回 aiApiKeySet；CRUD 白名單（SETTINGS_FIELD_TYPES）可寫字串', async () => {
  const { projectSettings } = await import('../lib/secret-fields.js');
  const p = projectSettings({ aiApiKey: 'sk-ant-synthetic-test-key', usdTwd: 32 });
  assert.ok(!('aiApiKey' in p), '鑰匙絕不送瀏覽器');
  assert.equal(p.aiApiKeySet, true, '設定頁靠布林知道「已設定」（清除入口的把關）');
  assert.equal(projectSettings({ aiApiKey: '' }).aiApiKeySet, false);
  const { SETTINGS_FIELD_TYPES } = await import('../lib/schema.js');
  assert.equal(SETTINGS_FIELD_TYPES.aiApiKey, 'string', '使用者可在設定頁貼入（P1b-2 UI）；空字串＝清除');
});

test('aiApiKey｜mapSecrets 走訪（HOSTED 加密／匯出剝除／匯入不採用四條路的共同驅動器）＋匯出剝除實測', async () => {
  const { mapSecrets, stripSecretsForBackup } = await import('../lib/secret-fields.js');
  /** @type {{path:string, stable:boolean, v:string}[]} */
  const visited = [];
  mapSecrets({ settings: { aiApiKey: 'sk-ant-synthetic-test-key', aiDualRead: false } }, (v, path, stable) => { visited.push({ path, stable, v }); return v; });
  const hit = visited.find((x) => x.path === 'settings.aiApiKey');
  assert.ok(hit, '走訪器必須 visit settings.aiApiKey——漏了＝HOSTED 明文落庫、匯出不剝、而且沒人會發現（雲端契約機密欄位節）');
  assert.equal(hit.stable, true, '單一 settings 路徑＝穩定 AAD');
  assert.equal(hit.v, 'sk-ant-synthetic-test-key');
  const stripped = stripSecretsForBackup({ settings: { aiApiKey: 'sk-ant-synthetic-test-key', usdTwd: 32 } });
  assert.equal(stripped.settings.aiApiKey, '', 'HOSTED 匯出剝除：欄位留著且為空（同 taishinSecPdfPassword 慣例）');
  assert.equal(stripped.settings.usdTwd, 32, '非機密欄不受影響');
});

test('票匣｜r1#4 恢復邊界要蓋住 getDb 本身：儲存層讀不起來時，票不可被吃掉', async () => {
  // 兌票之後、成功寫入之前的**每一個** await 都要在恢復邊界內。`getDb()` 自己也會 reject
  //   （儲存層壞掉／HOSTED 拿不到租戶）——它若落在 try 外，票就永久消失、使用者得再花一次 AI 費用。
  const db = await getDb();
  db.accounts = [];
  await saveDb(db);                      // 先確保 kv 有 accounts 這一列可以弄壞
  const id = issueAiTicket({ parsed: goodAnswer(), aiModel: 'claude-sonnet-5' });

  // 接縫：用第二條連線把 kv 的一列改成壞 JSON ⇒ load() 的 JSON.parse 拋錯 ⇒ getDb() 本身 reject
  //（不是閘擋、也不是 saveDb 失敗——那兩條路本來就在 try 內，測不出這一項）
  const raw = new DatabaseSync(TEST_STORE);
  const before = /** @type {any} */ (raw.prepare("SELECT data FROM kv WHERE key='accounts'").get());
  assert.ok(before, '前置：kv 要有 accounts 這一列');
  raw.prepare('UPDATE kv SET data=? WHERE key=?').run('{ 這不是合法 JSON', 'accounts');
  await assert.rejects(() => applyBankStatement('', '', notRecognized, { useAi: true, aiTicket: id }),
    '前置：儲存層壞掉時 apply 本來就該失敗');
  raw.prepare('UPDATE kv SET data=? WHERE key=?').run(before.data, 'accounts');
  raw.close();

  assert.ok(redeemAiTicket(id), '★getDb 失敗後票要放回去（不然使用者白花一次 AI 呼叫、還得重讀一次帳單）');
});

test('提示詞｜沒印「現值參考日」時要用帳單期間的**結束日**（William 2026-08-13 實測發現）', () => {
  // 病根：規則第 1 條原本寫「讀不到現值參考日＝null」，而 William 的金融卡明細**根本沒印**那五個字、
  //   只印「帳單期間 2026/01/01 ~ 2026/01/31」⇒ AI 照規矩回 null ⇒ 整份匯不進去。
  //   期末餘額本來就是截至區間結束那天，所以那是**同一個事實的另一種印法**，不是臆測。
  const sys = buildBankSystem();
  assert.match(sys, /帳單期間/, '★要告訴 AI 這種印法也算數');
  assert.match(sys, /結束日/, '★要講明用的是結束日');
  assert.match(sys, /不可填開始日/, '★只認結束日——開始日是期初、不是餘額的時點');
  assert.match(sys, /不可填今天|不可自己推算/, '★也不准自己補一個沒印在帳單上的日期');
  // ★r1#1：規則放寬到「這類區間」就太寬了——AI 可能挑到利率適用期間、某張卡的消費期間，
  //   選到較晚的結束日 ⇒ 拿這份帳單的餘額蓋掉較新的數字，之後正確的帳單反而被判成「較舊」。
  //   歧義一律 null：填錯的代價遠大於不填。
  // ★守**指令本身**，不是只守例子（實測：把「一律填 null」改成「可自行判斷」，
  //   底下那些名詞都還在、考題照樣綠——那等於整條規則被放寬而沒人出聲）。
  assert.match(sys, /一律填 null|一律 null/, '★歧義時必須是「一律 null」這種硬指令，不可改成「自行判斷」');
  assert.match(sys, /不可挑一個|不可自行挑/, '★要明講不准從多個候選裡挑');
  assert.match(sys, /唯一/, '★只認**唯一一個**明確的帳單期間');
  assert.match(sys, /兩個以上的區間|多個區間/, '★有多個區間時要明講不可挑一個');
  assert.match(sys, /利率適用期間|消費期間|存續期間/, '★要舉出「不是在講整份帳單」的區間例子');
  assert.match(sys, /寧可回 null|寧可不填/, '★要講明取捨方向：填錯會蓋掉較新的餘額，回 null 只是這次不更新');
  // 答案格式的欄位說明要同口徑（AI 兩邊都會讀）
  assert.match(AI_BANK_SCHEMA.properties.referenceDate.description, /帳單期間/,
    '★schema 的欄位說明也要講同一件事——只改提示詞、schema 還寫「沒印＝null」＝兩邊互相打架');
});

test('端到端（AI 路線）｜答案卷沒有現值參考日：憑票套用仍會落庫，既有餘額一動不動（r4／r5）', async () => {
  // ⚠️ **使用者的真實路徑是 AI fallback**，所以這一題必須走完整 AI 流程（只守模板那條＝守錯路）。
  // ⚠️ 「餘額不動」要先**種一個真的會被比對到的帳戶**：`seedDb` 會清空 accounts，
  //    沒種就是在比 `null === null`＝空包彈。套用後**重讀資料庫、比對整份帳戶快照**。
  await seedDb(true);
  const seed = await getDb();
  seed.accounts = [
    // ⚠️ **這一筆刻意沒有 `balanceAsOf`**（r6）：手動建立與舊資料的帳戶就是這個樣子。
    //    哨兵全都帶時點的話，「只改沒有時點的帳戶」這種突變會整批漏掉（複審實測全綠）。
    { id: 'ai-e2e-noasof', name: '合成活存', type: 'cash', bank: '合成一銀', currency: 'TWD',
      accountNo: '900200****3302', balance: 4242 },
    // 另一筆有時點、且**不會**被這張帳單匹配到：兩種狀態都在快照裡
    { id: 'ai-e2e-asof', name: '合成定存', type: 'cash', bank: '合成一銀', currency: 'TWD',
      accountNo: '900900****9999', balance: 777, balanceAsOf: '2026-01-31' },
  ];
  await saveDb(seed);
  const snapshotBefore = JSON.stringify((await getDb()).accounts);

  const noRef = () => ({ ...goodAnswer(), referenceDate: null });   // 過得了強閘（餘額鏈自洽），只是沒日期
  const spy = spyTransport([noRef()]);
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized,
    { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.ok(pv.aiTicket, '★沒有現值參考日不可影響「能不能拿到預覽與票」');
  assert.equal(pv.blocked, true, '預覽要標明「這次不更新餘額」');

  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized,
    { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.equal(res.ok, true, '★AI 路線也不可再整份拒絕——那正是使用者被卡住的那條路');
  assert.equal(res.balancesSkipped, true, '★回應要帶出「餘額沒更新」');
  assert.equal(res.transactions.imported, 3, '★交易要真的匯入');

  const after = await getDb();   // ⚠️ 重讀：只看回傳值證明不了「真的存進去了」
  assert.equal(after.transactions.length, 3, '★交易要真的落庫');
  assert.equal(JSON.stringify(after.accounts), snapshotBefore,
    '★整份帳戶快照要一模一樣——餘額 4242、時點 2026-01-31、帳戶數都不可以動'
    + '（比整包快照才擋得住「只改其中一欄」與「多新建一個帳戶」）');
  assert.equal(spy.calls.length, 1, '全程只有 preview 那一發模型呼叫（apply 憑票、不重跑 AI）');
});

test('答案卷驗收｜AI 給的 referenceDate 是壞日期＝整份拒收（不可流到餘額那一層）', () => {
  // ⚠️ 矩陣裡的「AI／壞日期」格（r8）：實作是有的（normalizeAiBank 驗真日曆），但沒有專屬考題。
  //    這一層**不可以放行壞日期**——放行的話下游只剩「不是真日期就跳過更新」那道，
  //    等於把「AI 亂填」與「帳單真的沒印」混成同一件事，使用者看到的原因會是錯的。
  for (const bad of ['2026-13-45', '2026-02-30', '26-01-31', '2026/01/31', 'yesterday']) {
    assert.throws(() => normalizeAiBank({ ...goodAnswer(), referenceDate: bad }),
      (/** @type {any} */ e) => e.code === 'ai_bad_answer',
      `★「${bad}」不是真日期，答案卷這一層就要擋下`);
  }
  // null 是合法的（帳單真的沒印）——不可連它一起擋
  assert.equal(normalizeAiBank({ ...goodAnswer(), referenceDate: null }).referenceDate, null,
    '★null 是合法答案（帳單沒印），擋掉它就等於逼 AI 亂填');
});

// ---- P2-2a：裁示⑥ 模型配置＋裁示⑧ 接地檢查與合計欄 ----

test('裁示⑥｜模型階梯＝Sonnet 預設、Opus 升級（Haiku 退出解析路徑）——常數釘住裁示', () => {
  assert.equal(AI_BANK_MODELS.primary, 'claude-sonnet-5', '★解析預設 Sonnet（帳單解析的錯是安靜的錢錯、省小錢冒大險不划算）');
  assert.equal(AI_BANK_MODELS.escalation, 'claude-opus-5', '★閘紅升 Opus 重試一次');
});

test('裁示⑧a 接地｜答案的金額不在帳單原文＝ai_bad_answer 走階梯；兩級都不接地＝照實擋', async () => {
  await seedDb(true);   // 自己 seed：靠前一題留下的鑰匙＝單獨跑會 ai_no_key（r8#2）
  const { assertAiBankGrounded } = await import('../lib/ai-parse.js');
  // 純函式面：帳戶餘額/交易金額/交易餘額/totals 逐類
  const grounded = normalizeAiBank({ ...goodAnswer(), totals: { txCount: 3, totalOut: 500, totalIn: null } });
  assertAiBankGrounded(grounded, '原文 1,000 500 1,500 3');   // 不丟＝通過
  for (const [patch, where] of [
    [(/** @type {any} */ a) => { a.accounts[0].balance = 4321; }, 'accounts balance'],
    [(/** @type {any} */ a) => { a.transactions[1].amount = 432; }, 'tx amount'],
    [(/** @type {any} */ a) => { a.transactions[0].balance = 4321; }, 'tx balance'],
    [(/** @type {any} */ a) => { a.totals = { txCount: null, totalOut: 4321, totalIn: null }; }, 'totals'],
  ]) {
    const raw = { ...goodAnswer(), totals: { txCount: null, totalOut: null, totalIn: null } };
    patch(raw);
    const p = normalizeAiBank(raw);
    assert.throws(() => assertAiBankGrounded(p, '原文 1,000 500 1,500 3'),
      (/** @type {any} */ e) => e.code === 'ai_bad_answer' && !/4321|432/.test(e.message),
      `★${where} 不接地＝拒、訊息不回聲數字`);
  }
  // 端到端：兩級模型都回「金額不在原文」的自洽答案＝終局照實擋（接地把自洽錯變 bad_answer）
  const evil = () => { const a = goodAnswer(); a.transactions[2].amount = 424242; a.transactions[2].balance = 424742; a.accounts[0].balance = 424742; return a; };
  const spy = spyTransport([evil(), evil()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_bad_answer' && !/424242/.test(e.message),
    '★自洽但不接地＝兩級都擋、不外洩數字');
  assert.equal(spy.calls.length, 2, '接地失敗＝ai_bad_answer＝有走階梯');
});

test('裁示⑧b 合計欄｜AI 抄回來的筆數/支出/存入合計 vs 它自己的逐筆——對不上＝ai_totals_mismatch、對上＝放行', async () => {
  await seedDb(true);   // 自己 seed：靠前一題留下的鑰匙＝單獨跑會 ai_no_key（r8#2）
  const withTotals = (/** @type {any} */ t) => { const a = goodAnswer(); a.totals = t; return a; };
  // 對得上（且數字有接地）＝放行
  const okSpy = spyTransport([withTotals({ txCount: 3, totalOut: 500, totalIn: 2000 })]);
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(okSpy), aiExtract: async () => [{ y: 0, cells: [{ x: 0, s: '原文 1,000 500 1,500 3 2,000' }] }] });
  assert.equal(pv.engine, 'ai', '合計對上＝照常出預覽');
  assert.deepEqual(pv.reconcile.totalsCheck, { status: 'pass', fields: ['txCount', 'totalOut', 'totalIn'] },
    '★這道跑了沒有要跟著裁決走到畫面（2026-08-19）：三欄都交回來了＝三欄都比對過');
  // 筆數對不上＝兩級都紅＝終局 ai_totals_mismatch（訊息不回聲數字）
  const badCount = () => withTotals({ txCount: 4, totalOut: null, totalIn: null });
  const spy2 = spyTransport([badCount(), badCount()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy2), aiExtract: async () => [{ y: 0, cells: [{ x: 0, s: '原文 1,000 500 1,500 4' }] }] }),
    (/** @type {any} */ e) => e.code === 'ai_totals_mismatch' && !/\d/.test(e.message) && /筆數/.test(e.message) && !/帳單印的/.test(e.message),
    '★筆數不符＝擋、訊息無數字、要點名是「筆數」那一欄、而且主詞不可說成「帳單印的」（r7#1：管線只知道 AI 交回什麼）（自審突變 M-wrong-column-msg：三段訊息互相對調全綠——使用者去核對錯的欄位，真正抄錯的那欄沒人看）');
  assert.equal(spy2.calls.length, 2, '閘類失敗＝有走階梯');
  // 支出合計對不上
  const badOut = () => withTotals({ txCount: null, totalOut: 600, totalIn: null });
  const spy3 = spyTransport([badOut(), badOut()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy3), aiExtract: async () => [{ y: 0, cells: [{ x: 0, s: '原文 1,000 500 1,500 600' }] }] }),
    (/** @type {any} */ e) => e.code === 'ai_totals_mismatch' && !/\d/.test(e.message) && /支出合計/.test(e.message) && !/帳單印的/.test(e.message),
    '★支出欄的刀原本只驗 code＝零訊息守衛（主詞同上：突變實測退回「帳單印的支出合計」全綠）（自審突變 M-msg-echo-out：把 AI 誤讀的帳單金額插進訊息全綠，違反本檔自己的機密紀律）');
  // 容差＝BAL_EPS（與餘額鏈同一把尺）：差 0.02 就要擋（自審突變 M-eps-50：把尺換成硬寫的 50
  // 全綠——三題的差額都是 100，只釘住一個量級，這道檢查存在的理由可以被靜靜掏空）
  const epsBad = () => withTotals({ txCount: null, totalOut: 500.02, totalIn: null });
  const spyEps = spyTransport([epsBad(), epsBad()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spyEps), aiExtract: async () => [{ y: 0, cells: [{ x: 0, s: '原文 1,000 500 1,500 500.02' }] }] }),
    (/** @type {any} */ e) => e.code === 'ai_totals_mismatch',
    '★差 0.02（> BAL_EPS 0.005）就要擋——容差被放寬到「幾十元不算」時這裡要紅');
  // 全 null（AI 沒交回那一欄）＝誠實缺席、照舊放行
  const nullSpy = spyTransport([withTotals({ txCount: null, totalOut: null, totalIn: null })]);
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(nullSpy), aiExtract: fakeExtract });
  assert.equal(pv2.engine, 'ai', '沒印合計＝跳過檢查、不連坐');
  assert.deepEqual(pv2.reconcile.totalsCheck, { status: 'not-read', fields: [] },
    '★沒交回合計欄＝畫面要說得出「這次沒跑」（不可讓人以為驗過了）；碼名刻意不叫 not-printed——管線分不出是帳單沒印還是 AI 沒讀出來（r7#1）');
});

test('預審r0#1｜混幣帳單＝合計欄整道跳過：外幣列不分幣別加總會誤擋正確答案（真實混幣版面形）', async () => {
  await seedDb(true);   // 自己 seed：靠前一題留下的鑰匙＝單獨跑會 ai_no_key（r8#2）
  // TWD＋USD 混合＋帳單印了「台幣段」合計 500：全列加總含 USD 50 ⇒ 若不跳過必 mismatch 誤擋
  const mixedTotals = () => {
    const a = goodAnswer();
    a.accountCurrencies.push({ masked: '900700****7707', currency: 'USD' });
    a.accounts.push({ masked: '900700****7707', balance: 250, currency: 'USD', label: '外幣活存', note: '' });
    a.transactions.push(
      { acctMasked: '900700****7707', date: '2026-06-04', direction: 'in', amount: 300, balance: 300, summary: '轉帳存入', note: '' },
      { acctMasked: '900700****7707', date: '2026-06-05', direction: 'out', amount: 50, balance: 250, summary: '轉帳支取', note: '' },
    );
    a.totals = { txCount: 3, totalOut: 500, totalIn: 2000 };   // 台幣段的合計（全列加總對不上）
    return a;
  };
  const spy = spyTransport([mixedTotals()]);
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: async () => [{ y: 0, cells: [{ x: 0, s: '原文 1,000 500 1,500 3 2,000 300 50 250' }] }] });
  assert.equal(pv.engine, 'ai', '★混幣＝合計欄跳過（涵蓋範圍機械判不出）、不連坐擋死');
  assert.equal(spy.calls.length, 1, '一發就過、沒有白燒升級');
  // ⚠️ **跳過要說得出口**（2026-08-19；William 指出混幣時這道整個關掉、畫面卻說它擋得住，而他自己的
  //   帳單正是混幣＝轉述）：狀態碼隨裁決回到預覽，白話句由 reconcile-summary.js 翻譯。
  assert.deepEqual(pv.reconcile.totalsCheck, { status: 'mixed-currency', fields: [] },
    '★整道跳過的事實必須傳到畫面（不傳＝說明區那句「帳單有印合計＝合計也擋」對這份帳單就是假話）');
  // 機密面（帳單欄值不隨裁決外送）由**上面那條 deepEqual** 守住：整個物件逐鍵比對，多塞一個
  // `totalOut: 500` 就有 4 題轉紅（實測 2026-08-19）。
  // ⚠️ 這裡原本另外加了三條「結構斷言」，理由寫成「原版只搜 900700、把 totalOut 塞進去照樣
  //    全綠」——**那句話是我沒實測就寫的，而且是錯的**（Codex #490 r4#2 在舊 head 上重現：同一發
  //    突變當場 4 題紅）。冗餘斷言配一個假證據比沒有更糟，所以整組刪掉、把真相記在這裡。
});

test('合計交叉驗證｜判準是「明細裡有沒有外幣列」而不是「帳單上有沒有外幣帳戶」；只交回一半＝只算比對過的那幾欄', async () => {
  await seedDb(true);   // 自己 seed：靠前一題留下的鑰匙＝單獨跑會 ai_no_key（r8#2）
  // 自審突變兩顆（M-mixed-criterion-widen／M-fields-overclaim）——原本後端只有兩個極端有題
  // （三欄全印、三欄全 null；真有外幣交易、完全沒有外幣），中間這兩格一題都沒有。
  // ①**概要有外幣帳戶、但本期明細全是台幣**：合計涵蓋哪一段沒有歧義 ⇒ 這道要照驗。
  //    判準若被簡化成「掃幣別表有沒有外幣」，使用者每一期都有外幣帳戶＝這道從此永遠靜靜關掉，
  //    而畫面還會給他一個對這份根本不成立的理由（「這份同時有台幣與外幣所以判不出涵蓋範圍」）。
  const foreignAcctOnly = () => {
    const a = goodAnswer();
    a.accountCurrencies.push({ masked: '900700****7707', currency: 'USD' });
    a.accounts.push({ masked: '900700****7707', balance: 250, currency: 'USD', label: '外幣活存', note: '' });
    a.totals = { txCount: 3, totalOut: 500, totalIn: 2000 };
    return a;
  };
  const spy1 = spyTransport([foreignAcctOnly()]);
  const pv1 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy1), aiExtract: async () => [{ y: 0, cells: [{ x: 0, s: '原文 1,000 500 1,500 3 2,000 250' }] }] });
  assert.deepEqual(pv1.reconcile.totalsCheck, { status: 'pass', fields: ['txCount', 'totalOut', 'totalIn'] },
    '★外幣帳戶只出現在概要、明細全台幣＝合計照驗（跳過的條件是明細真的有外幣列）');
  // ②**帳單只印了筆數**：fields 只能有那一欄——「跑到 pass 就是三欄都驗過了」這種簡化，
  //    會讓畫面唸出「筆數、支出合計、存入合計都一致」，而後兩欄帳單根本沒印、一次都沒比。
  const onlyCount = () => { const a = goodAnswer(); a.totals = { txCount: 3, totalOut: null, totalIn: null }; return a; };
  const spy2 = spyTransport([onlyCount()]);
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy2), aiExtract: fakeExtract });
  assert.deepEqual(pv2.reconcile.totalsCheck, { status: 'pass', fields: ['txCount'] },
    '★只印一半＝只列真的比對過的那一欄（fields 的契約：不可把「沒得對」講成「都對得上」）');
});

test('合計交叉驗證｜誠實殘餘：金額 0 或不大於容差（0.004）的列方向對調，兩側合計都不動＝看不到', async () => {
  // Codex #490 r4#1 抓到：程式正式接受 amount >= 0，而合計還有 BAL_EPS 容差——所以
  // 「方向對調會讓兩邊同時變」只在金額大於容差時成立。這是**已知取捨、不是 bug**（那種列不影響金額）。
  // ⚠️ William 2026-08-19 裁範圍之後**這條殘餘不寫進畫面**（收回誇大、不再加註），只住在
  //    reconcile-summary.js 的註解與這一題——所以它更需要真的驗得動，不能只看預設值。
  await seedDb(true);   // r6#2：自己 seed（靠前一題留下的 db 狀態＝單獨跑會 ai_no_key）
  const withTinyRow = (/** @type {'in'|'out'} */ dir, /** @type {number} */ amt, /** @type {number} */ bal) => {
    const a = goodAnswer();
    a.transactions.push({ acctMasked: '900200****3302', date: '2026-06-04', direction: dir, amount: amt, balance: bal, summary: '手續費減免', note: '' });
    a.accounts[0].balance = bal;
    a.totals = { txCount: 4, totalOut: 500, totalIn: 2000 };   // 兩種方向都吻合這一組合計
    return a;
  };
  // 邊界要**兩顆**（Codex #490 r5#2：只驗 0 守不住真正的門檻＝BAL_EPS）：0 元與 0.004 元
  // （0.004 < 0.005 ⇒ 餘額鏈與合計兩邊都在容差內）。金額本身微不足道，記錄的是「這道看不到它」。
  for (const amt of [0, 0.004]) {
    for (const dir of /** @type {const} */ (['in', 'out'])) {
      const bal = dir === 'in' ? 1500 + amt : 1500 - amt;   // 餘額鏈要跟著方向走（不然斷的是鏈、不是這題要測的合計）
      const text = async () => [{ y: 0, cells: [{ x: 0, s: `原文 1,000 500 1,500 4 2,000 ${amt} ${bal}` }] }];
      const spy = spyTransport([withTinyRow(dir, amt, bal)]);
      const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: text });
      // status 的預設值就是 pass ⇒ 只斷言它證明不了「這道真的比過」（r6#2）：要連**比到哪幾欄**
      // 與**級別**一起釘，才排除得掉「其實走了 not-read／根本沒進到比對」那些解釋。
      assert.deepEqual(pv.reconcile.totalsCheck, { status: 'pass', fields: ['txCount', 'totalOut', 'totalIn'] },
        `★金額 ${amt} 的列記成 ${dir}：三欄都真的比過了`);
      assert.equal(pv.reconcile.level, 'strong', '★而且是強閘下的結果（餘額鏈也接得上）');
    }
  }
});

test('合計交叉驗證｜配方路線沒有合計欄＝no-totals（不可靜靜當成 pass）', async () => {
  const { assertAiBankReconciled } = await import('../lib/services/bank-import.js');
  const parsed = normalizeAiBank(goodAnswer());
  const withTotals = assertAiBankReconciled(parsed, { accounts: [] });
  assert.equal(withTotals.totalsCheck.status, 'not-read', '答案卷有欄、三欄 null＝AI 沒交回那一欄');
  delete (/** @type {any} */ (parsed)).totals;            // 配方路線＝parseWithRecipe 根本不產這個欄
  const noTotals = assertAiBankReconciled(parsed, { accounts: [] });
  assert.deepEqual(noTotals.totalsCheck, { status: 'no-totals', fields: [] },
    '★路線不產合計欄＝照實說沒跑（規則卡讀的那份也不可宣稱合計把過關）');
  assert.equal(noTotals.level, 'strong', '既有裁決欄位照舊（新欄是加的、不是換的）');
});

test('預審r0#2｜接地 NFKC：全形數字帳單（１，５００）不得整版誤殺；去空白變體接回被拆格的金額', async () => {
  const { assertAiBankGrounded } = await import('../lib/ai-parse.js');
  const p = normalizeAiBank(goodAnswer());
  // 全形數字＋全形逗號＝NFKC 後接地成功（不丟＝通過）
  assertAiBankGrounded(p, '原文 １，０００ ５００ １，５００');
  // 金額被抽字器拆進兩個 cell（linesToText 以空格相接）＝去空白變體接回
  assertAiBankGrounded(p, '原文 1,00 0 500 1,500');
  // 對照組：真的不在原文＝照樣拒（NFKC 沒有把檢查放空）
  assert.throws(() => assertAiBankGrounded(p, '原文 １，０００ ５００'),
    (/** @type {any} */ e) => e.code === 'ai_bad_answer', '★缺 1,500＝照拒');
  // r1#3：拼接限同列——跨列相鄰（上列尾+下列頭）不算接地證據
  assert.throws(() => assertAiBankGrounded(p, '原文 1,00\n0 500 1,500'),
    (/** @type {any} */ e) => e.code === 'ai_bad_answer', '★跨列不拼（拆 cell 只發生在同一列）');
});

test('預審r0#3｜接地剔除日期 token：金額恰等於年份/民國日期片段＝不再誤接地', async () => {
  const { assertAiBankGrounded } = await import('../lib/ai-parse.js');
  const a = goodAnswer();
  a.transactions = [{ acctMasked: '900200****3302', date: '2026-06-01', direction: 'in', amount: 2026, balance: 1500, summary: '轉帳存入', note: '' }];
  a.accounts[0].balance = 1500;
  const p = normalizeAiBank(a);
  // 原文只有日期 2026-06-30 與 1,500——「2026」只以日期片段存在＝剔除後不得接地
  assert.throws(() => assertAiBankGrounded(p, '現值參考日 2026-06-30 餘額 1,500'),
    (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /amount/.test(e.message), '★日期片段不算接地證據');
  // 對照組：2,026 真的印在帳單上＝通過
  assertAiBankGrounded(p, '現值參考日 2026-06-30 存入 2,026 餘額 1,500');
});

test('預審r0#4｜totals 缺席＝ai_bad_answer（與 accounts 同口徑）；totalIn 對不上＝ai_totals_mismatch；訊息全無數字', async () => {
  await seedDb(true);   // 自己 seed：靠前一題留下的鑰匙＝單獨跑會 ai_no_key（r8#2）
  const missing = () => { const a = goodAnswer(); delete a.totals; return a; };
  assert.throws(() => normalizeAiBank(missing()), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /totals/.test(e.message),
    '★必填欄漏交＝壞答案、不靜默降級');
  // r1#1：物件在、單鍵缺席＝照拒（own-property 逐欄必填，不靜默補 null）
  const missingKey = () => { const a = goodAnswer(); a.totals = /** @type {any} */ ({ txCount: null, totalOut: null }); return a; };
  assert.throws(() => normalizeAiBank(missingKey()), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /totalIn/.test(e.message),
    '★單鍵缺席＝壞答案（必填不是口號）');
  const badIn = () => { const a = goodAnswer(); a.totals = { txCount: null, totalOut: null, totalIn: 1900 }; return a; };   // 訊息要點名「存入合計」（見 ⑧b 那題的同族斷言）
  const spy = spyTransport([badIn(), badIn()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: async () => [{ y: 0, cells: [{ x: 0, s: '原文 1,000 500 1,500 1,900' }] }] }),
    (/** @type {any} */ e) => e.code === 'ai_totals_mismatch' && !/\d/.test(e.message) && /存入合計/.test(e.message) && !/帳單印的/.test(e.message),
    '★存入合計不符＝擋（三欄各自有刀）、訊息一個數字都不可有、要點名自己那一欄、主詞不可誤稱');
});

test('預審r0#5｜真引擎工廠的模型接線＝AI_BANK_MODELS（裁示⑥不能只釘常數、要釘到出口）；提示詞規則 8 釘樁', async () => {
  const engine = makeAnthropicBankEngine('sk-ant-synthetic-test-key');
  assert.deepEqual(engine.models, AI_BANK_MODELS, '★正式路徑的階梯＝同一份常數（硬編舊階梯＝這裡紅）');
  const sys = buildBankSystem();
  for (const phrase of ['絕不自己加總', '印負號＝去號', '三欄一律填 null']) {
    assert.ok(sys.includes(phrase), `★提示詞規則 8 必含「${phrase}」`);
  }
});
