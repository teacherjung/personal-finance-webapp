// @ts-check
// 配方生成（P2-3）的考題：AI 票路線 apply 零解析重跑、寫入成功後另有至多一發生成（一律 Opus；
// 每次上傳至多 3 發）→出生三關→存檔/重生；
// 失敗不連坐匯入；前端徽章與完成訊息純函式。隔離＝STORE_FILE 暫存檔；引擎全假＝零鑰匙零費用。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-recipegen-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { generateRecipeAfterImport, previewBankStatement, applyBankStatement } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { clearAiTicketsForTest } = await import('../lib/ai-confirm-ticket.js');
const { parseWithRecipe, RECIPE_FORMAT_VERSION } = await import('../lib/parse-recipe.js');
const { RECIPE_MODEL, AI_BANK_MODELS } = await import('../lib/ai-parse.js');
const { makeAnthropicBankEngine } = await import('../lib/ai-transport.js');
const { bankApplyDoneText } = await import('../public/modules/cashflow-model.js');
const { recipePreviewBadgeHtml } = await import('../public/modules/ai-consent.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

// ---- 夾具（P2-1 版面 A 家族；出生帳單＝linesA、黃金樣本＝parseWithRecipe 的輸出） ----

const L = (/** @type {number} */ y, /** @type {any[]} */ pairs) => ({ y, cells: pairs.map((p) => (p.length === 3 ? { x: p[0], w: p[1], s: p[2] } : { x: p[0], s: p[1] })) });
const goodRecipe = () => ({
  formatVersion: RECIPE_FORMAT_VERSION,
  bank: '合成銀行',
  docAnchors: ['合成帳戶總覽', '往來紀錄'],
  dateFormat: 'west-slash',
  refDate: { strategy: 'anchored-date', anchor: '結算基準日' },
  summary: { sections: [{ anchor: '合成帳戶總覽', currency: 'TWD' }], endAnchor: '總計', balancePick: 'dollar-tagged' },
  detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: '附記', headerIgnore: ['單號'] },
});
const linesA = () => [
  L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
  L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$730']]),
  L(260, [[50, '乙種活存'], [150, '900200****3302'], [453, '$97,400'], [521, '主要戶']]),
  L(240, [[47, '總計'], [445, '$98,130']]),
  L(140, [[47, '往來紀錄明細']]),
  L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
  L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730']]),
  L(83, [[53, 0, '900100****3301'], [124, 0, '2026/06/16'], [177, 0, '合成扣款'], [290, 8, '$1,000'], [418, 0, '$730']]),
  L(66, [[53, 0, '900200****3302'], [124, 0, '2026/06/02'], [180, 0, '合成入帳'], [349, 40, '$2,400'], [414, 0, '$97,400']]),
];
const extractA = async () => linesA();
const notRecognized = async () => { throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400 }); };
/** 黃金樣本＝配方引擎對出生帳單的輸出（使用者確認的就是這份）。 */
const golden = () => /** @type {any} */ (parseWithRecipe(linesA(), goodRecipe()));
/** AI 的配方答案卷（無 formatVersion＝程式蓋；夾帶多餘鍵＝白名單要丟）。 */
const recipeAnswer = () => { const r = /** @type {any} */ ({ ...goodRecipe(), junkKey: '多餘的' }); delete r.formatVersion; return r; };
/** 假引擎：parseOnce＝把黃金樣本轉回答案卷；generateRecipe＝可注入。 */
const answerFromGolden = () => {
  const g = golden();
  return {
    bank: g.bank, referenceDate: g.referenceDate,
    accountCurrencies: Object.entries(g.accountCurrency).map(([masked, currency]) => ({ masked, currency })),
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: g.accounts.map((/** @type {any} */ a) => ({ masked: a.masked, balance: a.balance, currency: a.currency, label: a.label, note: a.note })),
    transactions: g.transactions.map((/** @type {any} */ t) => ({ acctMasked: t.acctMasked, date: t.date, direction: t.direction, amount: t.amount, balance: t.balance, summary: t.summary, note: t.note })),
  };
};
/** @param {{gen?: any, genSpy?: {calls: any[]}}} [o] */
const engineOf = (o = {}) => () => ({
  models: AI_BANK_MODELS,
  parseOnce: async () => answerFromGolden(),
  generateRecipe: async (/** @type {string} */ _text, /** @type {string} */ model) => {
    o.genSpy?.calls.push({ model });
    return typeof o.gen === 'function' ? o.gen() : (o.gen ?? recipeAnswer());
  },
});
async function seedDb(/** @type {any[]} */ recipes = []) {
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = []; db.parseRecipes = recipes;
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  await saveDb(db);
}
const ticketOf = (/** @type {string[]} */ suspects = [], /** @type {any} */ over = {}) => ({ parsed: golden(), aiModel: 'claude-sonnet-5', suspectRecipeIds: suspects, lines: linesA(), issuedAt: new Date().toISOString(), ...over });   // lines 隨票走（W1）

// ---- 生成本體 ----

test('生成｜快樂路徑：出生三關全過＝存新列（formatVersion 程式蓋、AI 多餘鍵被白名單丟掉）；模型一律 Opus（裁示⑥）', async () => {
  await seedDb();
  const genSpy = { calls: /** @type {any[]} */ ([]) };
  const r = await generateRecipeAfterImport(ticketOf(), { aiEngineFactory: engineOf({ genSpy }) });
  assert.equal(r.saved, true, /** @type {any} */ (r).reason);
  assert.equal(r.rebirth, false);
  assert.equal(genSpy.calls[0]?.model, RECIPE_MODEL, '★寫配方一律 Opus（配方錯誤會被免費複製到每一期）');
  const db = await getDb();
  assert.equal(db.parseRecipes?.length, 1);
  const row = /** @type {any} */ (db.parseRecipes?.[0]);
  assert.equal(row.current.formatVersion, RECIPE_FORMAT_VERSION, '★版本號程式蓋、不信 AI');
  assert.equal('junkKey' in row.current, false, '★白名單：AI 多給的鍵不落庫');
  assert.equal(row.graduateStreak, 0);
  // 存下來的配方真的可用：同版面第二份直接零元命中
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(pv.engine, 'recipe', '★閉環：AI 教的、app 自己會了');
});

test('生成｜出生三關各自擋：零內容紅／認不得版面／重現不了黃金樣本＝都不存（r2#5 漏一關＝白做）', async () => {
  const cases = [
    { gen: () => { const r = recipeAnswer(); r.docAnchors = ['錨點1234567', '往來紀錄']; return r; }, reason: 'recipe_birth_strict', why: '錨點含長數字＝零內容驗證紅' },
    { gen: () => { const r = recipeAnswer(); r.docAnchors = ['不存在的錨點', '也不存在']; return r; }, reason: 'recipe_birth_match', why: '版面上找不到錨點＝認不得出生帳單' },
    { gen: () => { const r = recipeAnswer(); r.refDate = { strategy: 'none', anchor: null }; return r; }, reason: 'recipe_birth_reproduce', why: '解得動但 referenceDate 跟黃金樣本不同（none vs 錨定日）＝重現失敗' },
    { gen: () => { const r = recipeAnswer(); r.docAnchors = ['主要戶', '往來紀錄']; return r; }, reason: 'recipe_birth_statement', why: '錨點撞到帳戶備註文字（主要戶）＝對照出生帳單紅——只有第二關抓得到（match 與 reproduce 都會過）' },
    { gen: () => { const r = recipeAnswer(); r.detail.headerIn = '存入金額'; return r; }, reason: 'recipe_birth_parse', why: '中版面但表頭字面錯＝parseWithRecipe 拒解（match 過、parse 拋）——birth_parse 這條路要有自己的樣本' },
  ];
  for (const c of cases) {
    await seedDb();
    const r = await generateRecipeAfterImport(ticketOf(), { aiEngineFactory: engineOf({ gen: c.gen }) });
    assert.equal(r.saved, false, c.why);
    assert.equal(r.reason, c.reason, c.why);
    const db = await getDb();
    assert.equal(db.parseRecipes?.length, 0, `★${c.why}＝不落庫`);
  }
});

test('生成｜重生（裁示②④）：票上帶疑似候選＝寫回那一列——舊 current 降 previous、rebirths+1、streak 歸零', async () => {
  const old = { ...goodRecipe(), docAnchors: ['舊版錨點', '往來紀錄'] };
  await seedDb([{ id: 'rcp-old', bank: '合成銀行', current: old, graduateStreak: 5, graduated: true, suspect: true, rebirths: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }]);
  const r = await generateRecipeAfterImport(ticketOf(['rcp-old']), { aiEngineFactory: engineOf({}) });
  assert.equal(r.saved, true);
  assert.equal(r.rebirth, true, '★疑似候選在場＝重生、不另開新列');
  const db = await getDb();
  assert.equal(db.parseRecipes?.length, 1);
  const row = /** @type {any} */ (db.parseRecipes?.[0]);
  assert.deepEqual(row.current.docAnchors, ['合成帳戶總覽', '往來紀錄'], '★新配方上 current');
  assert.deepEqual(row.previous.docAnchors, ['舊版錨點', '往來紀錄'], '★舊 current 降 previous（留 1 版）');
  assert.equal(row.rebirths, 2, '★重生累計 +1（達 5＝內建化候選訊號）');
  assert.equal(row.suspect, false);
  assert.equal(row.graduateStreak, 0, '★重生後從零重數');
  assert.equal(row.graduated, false);
});

test('生成｜失敗不連坐：引擎沒有 generateRecipe／生成炸掉＝匯入照常、只回 saved:false', async () => {
  await seedDb();
  const noGen = () => ({ models: AI_BANK_MODELS, parseOnce: async () => answerFromGolden() });
  const r1 = await generateRecipeAfterImport(ticketOf(), { aiEngineFactory: /** @type {any} */ (noGen) });
  assert.deepEqual(r1, { saved: false, reason: 'recipe_engine_missing' });
  const boom = () => ({ models: AI_BANK_MODELS, parseOnce: async () => answerFromGolden(), generateRecipe: async () => { throw new Error('boom'); } });
  const r2 = await generateRecipeAfterImport(ticketOf(), { aiEngineFactory: /** @type {any} */ (boom) });
  assert.deepEqual(r2, { saved: false, reason: 'recipe_gen_failed' });
});

test('端到端｜AI 預覽→兌票套用＝交易入帳＋配方順手存好（回應帶 recipe.saved）', async () => {
  await seedDb();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf({}), aiExtract: extractA });
  assert.equal(pv.engine, 'ai');
  // ⚠️ 照**正式前端的 body 形狀**打：applyBody 的 AI 分支只送 {useAi, aiTicket}——data＝undefined。
  // 首版考題在這裡帶了 b64＝假綠（生成用 b64 重抽、正式路上 decode(undefined) 必炸＝整條路 DOA、預審 W1 抓到）。
  const res = await applyBankStatement(/** @type {any} */ (undefined), undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf({}) });
  assert.equal(res.ok, true);
  assert.equal(/** @type {any} */ (res).recipe?.saved, true, '★生成掛在寫入成功之後、結果進回應——且原文從票拿（data 缺席照樣成）');
  const db = await getDb();
  assert.equal((db.transactions || []).length, 3, '交易先入帳（生成失敗也不影響——這裡是成功例）');
  assert.equal(db.parseRecipes?.length, 1, '配方也存好了');
});

test('傳輸｜generateRecipe 的線上格式：模型/配方答案卷 schema/填表提示都對（stub fetch 釘住）', async () => {
  /** @type {any} */ let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (_url, /** @type {any} */ init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) };
  });
  try {
    await makeAnthropicBankEngine('sk-ant-synthetic-test-key').generateRecipe('帳單文字', RECIPE_MODEL);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(captured.model, RECIPE_MODEL);
  assert.equal(captured.output_config.format.schema.properties.docAnchors.maxItems > 0, true, '★掛的是配方答案卷 schema');
  assert.ok(String(captured.system).includes('嚴禁任何交易內容'), '★填表提示的零內容鐵則');
  assert.ok(String(captured.system).includes('字面文字'), '★照抄字面');
});

// ---- Codex r1 五條的承重域 ----
test('r1#1｜世代檢查吃 fresh row：候選在生成在途自證＝不降版改新建（舊快照判準會誤重生、注入實測穿過）', async () => {
  await seedDb([{ id: 'rcp-old', bank: '台新銀行', current: goodRecipe(), suspect: true, graduateStreak: 0, rebirths: 0, lastUsedAt: '2026-01-01T00:00:00.000Z' }]);
  const t = ticketOf(['rcp-old'], { issuedAt: '2026-02-01T00:00:00.000Z' });
  const gen = async () => {   // 生成（await Opus）在途：候選列成功自證＝lastUsedAt 跳到票之後
    const db = await getDb(); /** @type {any} */ (db.parseRecipes)[0].lastUsedAt = '2026-03-01T00:00:00.000Z'; await saveDb(db);
    return recipeAnswer();
  };
  const r = await generateRecipeAfterImport(t, { aiEngineFactory: engineOf({ gen }) });
  assert.equal(r.saved, true);
  assert.equal(/** @type {any} */ (r).rebirth, false, '★自證發生在 await 之後＝只有 mutate 內 fresh row 看得到');
  const db = await getDb();
  assert.equal(db.parseRecipes?.length, 2, '改走新建、已自證的 rcp-old 不被降版');
});

// r2#2：兩個缺鍵**各自獨立**成題——合在一題會互相遮掩（單獨退回其中一鍵的修補仍綠＝假綠，Codex r2 突變實測）。
test('r1#2a｜白名單不修補：AI 單獨漏交 headerNote＝strict 紅（補成 null＝strict 退化成「驗修好的」）', async () => {
  await seedDb();
  const gen = () => { const r = /** @type {any} */ (recipeAnswer()); delete r.detail.headerNote; return r; };
  const r = await generateRecipeAfterImport(ticketOf(), { aiEngineFactory: engineOf({ gen }) });
  assert.equal(r.saved, false);
  assert.equal(/** @type {any} */ (r).reason, 'recipe_birth_strict', '★缺鍵原樣交 strict 擋、不是被修成 null 放行');
});

test('r1#2b｜白名單不修補：AI 單獨漏交 headerIgnore＝strict 紅（補成 []＝同上、另一鍵不得遮掩）', async () => {
  await seedDb();
  const gen = () => { const r = /** @type {any} */ (recipeAnswer()); delete r.detail.headerIgnore; return r; };
  const r = await generateRecipeAfterImport(ticketOf(), { aiEngineFactory: engineOf({ gen }) });
  assert.equal(r.saved, false);
  assert.equal(/** @type {any} */ (r).reason, 'recipe_birth_strict', '★缺鍵原樣交 strict 擋、不是被修成 [] 放行');
});

test('r1#3｜生成整支 reject 也不能把成功的匯入變失敗：呼叫端硬 catch（接縫 aiRecipeGen 注入）', async () => {
  await seedDb();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf({}), aiExtract: extractA });
  const rejecting = async () => { throw new Error('生成整支 reject（合成）'); };
  const res = await applyBankStatement(/** @type {any} */ (undefined), undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf({}), aiRecipeGen: /** @type {any} */ (rejecting) });
  assert.equal(res.ok, true, '★saveDb 已成功＝生成怎麼炸都不能改判匯入失敗');
  assert.equal(/** @type {any} */ (res).recipe?.saved, false);
  const db = await getDb();
  assert.equal((db.transactions || []).length, 3, '帳本裡真的有貨（不是回 200 的空話）');
});

test('r1#4｜傳輸有逾時上界：fetch 的 signal 由 AbortSignal.timeout(90000) 建（r2#1：只驗「有 signal」＝換成永不逾時的 signal 仍綠）', async () => {
  /** @type {any} */ let seen = null;
  /** @type {any} */ let timeoutMs = null;
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = /** @type {any} */ ((/** @type {number} */ ms) => { timeoutMs = ms; return realTimeout.call(AbortSignal, ms); });
  globalThis.fetch = /** @type {any} */ (async (_url, /** @type {any} */ init) => {
    seen = init;
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) };
  });
  try { await makeAnthropicBankEngine('sk-ant-synthetic-test-key').generateRecipe('帳單文字', RECIPE_MODEL); } finally { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; }
  assert.ok(seen?.signal instanceof AbortSignal, '★沒帶 signal＝in-flight 原文無上界');
  assert.equal(timeoutMs, 90_000, '★signal 必須真的是 AbortSignal.timeout(90000) 造的——永不逾時的替身簽不出這個值');
});

test('r1#5｜成本邊界考題：preview 不加生成、apply 恰好 1 發生成 0 發解析（「至多 3 發」的那個＋1）', async () => {
  await seedDb();
  const calls = { parse: 0, gen: 0 };
  const factory = () => ({
    models: AI_BANK_MODELS,
    parseOnce: async () => { calls.parse += 1; return answerFromGolden(); },
    generateRecipe: async () => { calls.gen += 1; return recipeAnswer(); },
  });
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: /** @type {any} */ (factory), aiExtract: extractA });
  assert.equal(calls.gen, 0, 'preview 是等待熱路徑、不加 Opus');
  const res = await applyBankStatement(/** @type {any} */ (undefined), undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: /** @type {any} */ (factory) });
  assert.equal(res.ok, true);
  assert.equal(calls.parse, 1, 'apply 零解析呼叫（票兌現、不重跑模型）');
  assert.equal(calls.gen, 1, '★apply 恰好 1 發生成——多一發＝成本句「至多 3 發」變假');
});

// ---- 前端純函式 ----

test('前端｜配方徽章：engine recipe 才畫、講「零費用零外送＋驗算照跑＋自動退版」；完成訊息帶配方一句', () => {
  assert.equal(recipePreviewBadgeHtml({ engine: 'ai' }), '', '互斥：AI 預覽不畫配方徽章');
  const html = recipePreviewBadgeHtml({ engine: 'recipe', recipeId: 'rcp-1' });
  for (const phrase of ['版面規則卡', '零費用', '零外送', '驗算照跑', '退回上一版']) {
    assert.ok(html.includes(phrase), `★徽章要講「${phrase}」`);
  }
  const bal = { updated: 1, created: 0 };
  const tx = { imported: 3 };
  assert.ok(bankApplyDoneText(bal, tx, { saved: true, rebirth: false }).includes('已存成版面規則卡'), '★存成要講');
  assert.ok(bankApplyDoneText(bal, tx, { saved: true, rebirth: true }).includes('重生'), '★重生要講');
  assert.ok(bankApplyDoneText(bal, tx, { saved: false }).includes('沒存成'), '★沒存成也要講（不嚇人、不裝沒事）');
  assert.equal(bankApplyDoneText(bal, tx).includes('規則卡'), false, '模板/配方路線沒有 recipe 欄＝一字不多');
});

test('GrokG4｜沒有可忽略欄的正常版面也存得成卡：headerIgnore 空陣列一律保留（丟鍵＝strict 紅＝這類版面全滅）', async () => {
  const { pickRecipeCandidate } = await import('../lib/ai-parse.js');
  const { validateRecipeStrict } = await import('../lib/parse-recipe.js');
  const ans = recipeAnswer();
  /** @type {any} */ (ans).detail = { ...ans.detail, headerIgnore: [] };
  const c = /** @type {any} */ (pickRecipeCandidate(ans));
  assert.deepEqual(c.detail.headerIgnore, [], '★空陣列要保留成鍵');
  assert.deepEqual(validateRecipeStrict(c), [], '★strict 對「沒有可忽略欄」的版面要綠');
});

test('GrokG3｜imported 0 也解除疑似：讀得動＋過閘＝版面證明可讀（疑似不捆「份」的門）', async () => {
  await seedDb();
  const db0 = await getDb();
  db0.parseRecipes = [{ id: 'rcp-sus', bank: '合成銀行', current: goodRecipe(), graduateStreak: 2, graduated: false, suspect: true, rebirths: 0,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }];
  await saveDb(db0);
  // 第一次匯入把交易寫進去
  const r1 = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(r1.ok, true);
  // 再標回疑似、重傳同一份（imported 0）
  const db1 = await getDb(); /** @type {any} */ (db1.parseRecipes[0]).suspect = true; await saveDb(db1);
  const r2 = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(r2.ok, true);
  const db2 = await getDb();
  assert.equal(/** @type {any} */ (db2.parseRecipes[0]).suspect, false, '★imported 0 仍解除疑似');
  assert.equal(/** @type {any} */ (db2.parseRecipes[0]).graduateStreak, 3, '★但畢業計數不動（份＝imported>0）');
});

test('W5｜重生也吃世代檢查：候選列其後已自證（lastUsedAt＞票 issuedAt）＝不降它的版、改走新建', async () => {
  await seedDb([{ id: 'rcp-proven', bank: '合成銀行', current: goodRecipe(), graduateStreak: 3, graduated: false, suspect: false, rebirths: 0,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastUsedAt: '2026-08-16T05:00:00.000Z' }]);
  const t = ticketOf(['rcp-proven'], { issuedAt: '2026-08-16T04:00:00.000Z' });   // 票比自證早
  const r = await generateRecipeAfterImport(t, { aiEngineFactory: engineOf({}) });
  assert.equal(r.saved, true);
  assert.equal(r.rebirth, false, '★已自證＝不重生、走新建');
  const db = await getDb();
  assert.equal(db.parseRecipes?.length, 2, '★新建一列、好列原封不動');
  const proven = /** @type {any} */ ((db.parseRecipes || []).find((x) => x.id === 'rcp-proven'));
  assert.equal(proven.graduateStreak, 3, '★好列的畢業計數不被舊快照降版');
});

test('契約句承重｜兩個疑似候選＝只重生第一顆、第二顆仍掛疑似等下次', async () => {
  await seedDb([
    { id: 'rcp-a', bank: '合成銀行', current: { ...goodRecipe(), docAnchors: ['A 版錨點', '往來紀錄'] }, graduateStreak: 0, graduated: false, suspect: true, rebirths: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'rcp-b', bank: '合成銀行', current: { ...goodRecipe(), docAnchors: ['B 版錨點', '往來紀錄'] }, graduateStreak: 0, graduated: false, suspect: true, rebirths: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  ]);
  const r = await generateRecipeAfterImport(ticketOf(['rcp-a', 'rcp-b']), { aiEngineFactory: engineOf({}) });
  assert.equal(r.saved, true);
  assert.equal(r.rebirth, true);
  const db = await getDb();
  const a = /** @type {any} */ ((db.parseRecipes || []).find((x) => x.id === 'rcp-a'));
  const b = /** @type {any} */ ((db.parseRecipes || []).find((x) => x.id === 'rcp-b'));
  assert.equal(a.suspect, false, '第一顆重生＝疑似解除');
  assert.deepEqual(a.current.docAnchors, ['合成帳戶總覽', '往來紀錄']);
  assert.equal(b.suspect, true, '★第二顆仍掛疑似、等下次（一次只重生一列的殘餘要有考題）');
});

test('W2｜headerNote:null＝合法值全路通：白名單保留鍵、strict 綠（撤回假宣稱的承重域）', async () => {
  const { pickRecipeCandidate } = await import('../lib/ai-parse.js');
  const { validateRecipeStrict } = await import('../lib/parse-recipe.js');
  const ans = recipeAnswer();
  /** @type {any} */ (ans).detail = { ...ans.detail, headerNote: null };
  const c = /** @type {any} */ (pickRecipeCandidate(ans));
  assert.equal(c.detail.headerNote, null, '★null 保留成鍵（不是丟掉）');
  assert.deepEqual(validateRecipeStrict(c), [], '★strict 明文放行 null——「null＝表達力上限」是誤讀探針的假宣稱、已撤回');
});