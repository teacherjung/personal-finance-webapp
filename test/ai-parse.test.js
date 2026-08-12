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

const TEST_STORE = join(tmpdir(), `finance-aiparse-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { normalizeAiBank, linesToText, buildBankSystem, AI_BANK_MODELS, AI_BANK_SCHEMA } = await import('../lib/ai-parse.js');
const { anthropicTransport, makeAnthropicBankEngine } = await import('../lib/ai-transport.js');
const { previewBankStatement, applyBankStatement, aiBankRoute } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');

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
  accounts: [{ masked: '900200****3302', balance: 1500, currency: 'TWD', label: '活存', note: '' }],
  transactions: [
    { acctMasked: '900200****3302', date: '2026-06-01', direction: 'in', amount: 1000, balance: 1000, summary: '轉帳存入', note: '薪資' },
    { acctMasked: '900200****3302', date: '2026-06-02', direction: 'out', amount: 500, balance: 500, summary: 'CD提款', note: '' },
    { acctMasked: '900200****3302', date: '2026-06-03', direction: 'in', amount: 1000, balance: 1500, summary: '存款息', note: '' },
  ],
});
/** 弱閘答案卷（餘額全 null、無概要帳戶＝一對都驗不到）。 */
const weakAnswer = () => ({
  bank: '合成一銀', referenceDate: '2026-06-30', accounts: [],
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
  assert.equal(ok.accountCurrency['900200****3302'], 'TWD', 'accountCurrency 由 accounts 建（與模板同形）');
  assert.equal(ok.accounts[0].suffix, '3302', '末碼由程式自己算、不信 AI');
  assert.throws(() => normalizeAiBank({ ...goodAnswer(), bank: '|||' }), (/** @type {any} */ e) => e.code === 'ai_bad_answer', '剝完只剩空＝壞答案');
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
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract });
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

test('apply｜弱閘拒收＝寫入路徑 fail-closed：db 一筆都不可多', async () => {
  await seedDb(true);
  const spy = spyTransport([weakAnswer(), weakAnswer()]);
  await assert.rejects(
    applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(spy), aiExtract: fakeExtract }),
    (/** @type {any} */ e) => e.code === 'ai_weak_refused');
  const db = await getDb();
  assert.equal(db.accounts.length, 0, '擋下＝零寫入');
  assert.equal(db.transactions.length, 0);
});

test('規矩④r1#1｜混合帳戶不搭便車：A 帳戶驗得動、B 帳戶餘額全空＝整份拒收（preview＋apply 零寫入）', async () => {
  await seedDb(true);
  const mixed = () => {
    const a = goodAnswer();
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
    (/** @type {any} */ e) => e.code === 'ai_weak_refused');
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
