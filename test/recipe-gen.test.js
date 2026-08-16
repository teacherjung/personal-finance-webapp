// @ts-check
// 配方生成（P2-3）的考題：AI 票路線寫入成功後第二呼叫（一律 Opus）→出生三關→存檔/重生；
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
const ticketOf = (/** @type {string[]} */ suspects = []) => ({ parsed: golden(), aiModel: 'claude-sonnet-5', suspectRecipeIds: suspects });

// ---- 生成本體 ----

test('生成｜快樂路徑：出生三關全過＝存新列（formatVersion 程式蓋、AI 多餘鍵被白名單丟掉）；模型一律 Opus（裁示⑥）', async () => {
  await seedDb();
  const genSpy = { calls: /** @type {any[]} */ ([]) };
  const r = await generateRecipeAfterImport('QUFBQQ==', undefined, ticketOf(), { aiEngineFactory: engineOf({ genSpy }), aiExtract: extractA });
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
  ];
  for (const c of cases) {
    await seedDb();
    const r = await generateRecipeAfterImport('QUFBQQ==', undefined, ticketOf(), { aiEngineFactory: engineOf({ gen: c.gen }), aiExtract: extractA });
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
  const r = await generateRecipeAfterImport('QUFBQQ==', undefined, ticketOf(['rcp-old']), { aiEngineFactory: engineOf({}), aiExtract: extractA });
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
  const r1 = await generateRecipeAfterImport('QUFBQQ==', undefined, ticketOf(), { aiEngineFactory: /** @type {any} */ (noGen), aiExtract: extractA });
  assert.deepEqual(r1, { saved: false, reason: 'recipe_engine_missing' });
  const boom = () => ({ models: AI_BANK_MODELS, parseOnce: async () => answerFromGolden(), generateRecipe: async () => { throw new Error('boom'); } });
  const r2 = await generateRecipeAfterImport('QUFBQQ==', undefined, ticketOf(), { aiEngineFactory: /** @type {any} */ (boom), aiExtract: extractA });
  assert.deepEqual(r2, { saved: false, reason: 'recipe_gen_failed' });
});

test('端到端｜AI 預覽→兌票套用＝交易入帳＋配方順手存好（回應帶 recipe.saved）', async () => {
  await seedDb();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf({}), aiExtract: extractA });
  assert.equal(pv.engine, 'ai');
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf({}), aiExtract: extractA });
  assert.equal(res.ok, true);
  assert.equal(/** @type {any} */ (res).recipe?.saved, true, '★生成掛在寫入成功之後、結果進回應');
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
