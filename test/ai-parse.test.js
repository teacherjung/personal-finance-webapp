// AI 解析引擎（P1b-1）的考題：全部走**假傳輸**（不用鑰匙、不上網、零費用）。
// 射程：答案卷驗收 fail-closed／四道規矩（同意旗標・HOSTED 停止線・鑰匙・★6 強閘）／模型階梯／
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
const fakeExtract = async () => [{ y: 0, cells: [{ x: 0, s: '合成帳單內文標記字串' }] }];

/** 平衡的答案卷（強閘全過：餘額鏈 2 對＋末筆 1500 對概要 1500）。 */
const goodAnswer = () => ({
  bank: '合成一銀', referenceDate: '2026-06-30',
  accountCurrencies: [{ masked: '900200****3302', currency: 'TWD' }],
  accounts: [{ masked: '900200****3302', balance: 1500, currency: 'TWD', label: '活存', note: '' }],
  transactions: [
    { acctMasked: '900200****3302', date: '2026-06-01', direction: 'in', amount: 1000, balance: 1000, summary: '轉帳存入', note: '薪資' },
    { acctMasked: '900200****3302', date: '2026-06-02', direction: 'out', amount: 500, balance: 500, summary: 'CD提款', note: '' },
    { acctMasked: '900200****3302', date: '2026-06-03', direction: 'in', amount: 1000, balance: 1500, summary: '存款息', note: '' },
  ],
});
/** 弱閘答案卷（餘額全 null、無概要帳戶＝一對都驗不到）。 */
const weakAnswer = () => ({
  bank: '合成一銀', referenceDate: '2026-06-30', accountCurrencies: [{ masked: '900200****3302', currency: 'TWD' }], accounts: [],
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

/** 重設隔離 db：清帳戶/交易、設定鑰匙有無。 @param {boolean} withKey */
async function seedDb(withKey) {
  clearAiTicketsForTest();   // 票匣跨題互不干擾（比照 resetRateLimitsForTest）
  const db = await getDb();
  db.accounts = [];
  db.transactions = [];
  db.settings.aiApiKey = withKey ? 'sk-ant-synthetic-test-key' : '';
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

test('規矩②同意旗標｜缺席＝零 AI 呼叫＋模板原句錯誤照丟（確認窗沒蓋好前這條路不通）', async () => {
  await seedDb(true);
  const spy = spyTransport([goodAnswer()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    /看起來不是台新/);
  assert.equal(spy.calls.length, 0, '沒有同意旗標＝連一次 AI 都不可呼叫');
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
      aiBankRoute('QUFBQQ==', undefined, { settings: { aiApiKey: 'sk-ant-synthetic-test-key' } }, { engineFactory: engineOf(spy), extract: fakeExtract }),
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

test('規矩④★6 強閘｜弱閘答案（升 Sonnet 後仍弱）＝拒收；模型階梯真的走了兩級', async () => {
  await seedDb(true);
  const spy = spyTransport([weakAnswer(), weakAnswer()]);
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_weak_refused' && /不收/.test(e.message));
  assert.deepEqual(spy.calls.map((c) => c.model), [AI_BANK_MODELS.primary, AI_BANK_MODELS.escalation],
    '★3 拍板：Haiku 先解、閘不過升 Sonnet 重試一次——不多不少');
});

// ---- 模型階梯與端到端 ----

test('階梯｜閘紅（不一致）→升 Sonnet 成功；快樂路徑回 engine/aiModel＋P1a 機構維度直接互扣', async () => {
  await seedDb(true);
  const spy = spyTransport([unbalancedAnswer(), goodAnswer()]);
  const res = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
  assert.equal(res.engine, 'ai');
  assert.equal(res.aiModel, AI_BANK_MODELS.escalation, '第一發閘紅＝升級那一發成功');
  assert.equal(res.reconcile.level, 'strong', '★6：AI 路線只收強閘');
  assert.equal(res.rows[0].action, 'create');
  assert.equal(res.transactions.rows.length, 3);
  assert.ok(res.transactions.rows[0].bankRef.startsWith('bank2|合成一銀|900200****3302|'),
    'AI 報的機構直接餵 P1a 的 bank2 去重鍵——不同銀行同字樣不撞鍵');
});

test('階梯｜答案卷壞（ai_bad_answer）→升 Sonnet；服務類錯誤（ai_auth）＝不升級、一發就停', async () => {
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
  mapSecrets({ settings: { aiApiKey: 'sk-ant-synthetic-test-key' } }, (v, path, stable) => { visited.push({ path, stable, v }); return v; });
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
  const id = issueAiTicket({ parsed: goodAnswer(), aiModel: 'claude-haiku-4-5-20251001' });

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

test('端到端（AI 路線）｜答案卷沒有現值參考日：憑票套用仍會落庫，餘額一動不動（r4 指正）', async () => {
  // ⚠️ **William 的真實情況走的是 AI 路線，不是模板路線。** 上一版只補了模板那條的端到端，
  //    複審把突變改成「只擋 AI＋缺參考日」，132 題照樣全綠（r4）——等於這支想解鎖的**那條路**
  //    仍然沒被守住。這一題走完整的 AI 流程：預覽發票 → 憑票套用 → 重讀資料庫。
  await seedDb(true);
  const before = await getDb();
  const acct = before.accounts.find((/** @type {any} */ a) => a.accountNo === '900200****3302');
  const beforeBalance = acct ? acct.balance : null;
  const beforeAsOf = acct ? acct.balanceAsOf : null;
  const beforeCount = before.accounts.length;

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
  assert.equal(after.accounts.length, beforeCount, '★不可新建帳戶');
  const a2 = after.accounts.find((/** @type {any} */ a) => a.accountNo === '900200****3302');
  assert.equal(a2 ? a2.balance : null, beforeBalance, '★餘額一動都不可以動');
  assert.equal(a2 ? a2.balanceAsOf : null, beforeAsOf, '★時點也不可以動');
  assert.equal(spy.calls.length, 1, '全程只有 preview 那一發模型呼叫（apply 憑票、不重跑 AI）');
});

