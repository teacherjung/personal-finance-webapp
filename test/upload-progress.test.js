// @ts-check
// 上傳進度即時顯示（2026-08-18；William：「停頓太久像當掉，能不能即時寫出背景在跑什麼」）的行為卷。
//
// 三條設計鐵則各自有題：
// ①**零插值**（機密機械化）：後端只推封閉列舉的階段代碼＋（唯一例外）已在徽章揭露過的模型顯示名；
//   絕不推帳單欄值／密碼池大小／規則卡張數。→ 用「全掃 frame 內容」的行為題，不是靠人自律。
// ②**只在事情真的發生後才推**（#455 假進度那課的正解方向）：HOSTED 停止線／未設鑰匙那條零 AI 呼叫
//   的路，一個 ai_* 階段都不准出現。
// ③**階段序列由資料決定**（有無規則卡、雙讀開關、要不要仲裁都不同）：四條路各自斷言真實序列。
// 另：串流與非串流兩種回應形態的**結果與錯誤契約完全相同**（code 通道不得被串流吃掉）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-progress-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { previewBankStatement } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { clearAiTicketsForTest } = await import('../lib/ai-confirm-ticket.js');
const { STAGES, stageFrame, makeStageSink } = await import('../lib/progress-stages.js');
const { AI_BANK_MODELS, AI_ARBITER_MODEL } = await import('../lib/ai-parse.js');
const { progressText, progressTextCodes } = await import('../public/modules/progress-text.js');
const { streamNdjson } = await import('../lib/routes/route-helpers.js');

const ROOT = join(import.meta.dirname, '..');
const L = (/** @type {number} */ y, /** @type {any[]} */ pairs) => ({ y, cells: pairs.map((p) => ({ x: p[0], s: p[1] })) });
const linesA = () => [
  L(10, [[40, '一銀活期帳戶明細']]),
  L(30, [[40, '900200****1234'], [200, 'TWD'], [320, '5,500']]),
  L(50, [[40, '2026/07/01'], [140, '超商繳費'], [240, '100'], [320, '4,900']]),
  L(55, [[40, '2026/07/02'], [140, '薪資入帳'], [280, '600'], [320, '5,500']]),
];
const extractA = async () => linesA();
const notRecognized = async () => { throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400 }); };
const goodAnswer = (/** @type {any} */ over = {}) => ({
  bank: '第一銀行', referenceDate: '2026-07-31',
  accountCurrencies: [{ masked: '900200****1234', currency: 'TWD' }],
  totals: { txCount: null, totalOut: null, totalIn: null },
  accounts: [{ masked: '900200****1234', balance: 5500, currency: 'TWD', label: '活期', note: '' }],
  transactions: [
    { acctMasked: '900200****1234', date: '2026-07-01', direction: 'out', amount: 100, balance: 4900, summary: '超商繳費', note: '' },
    { acctMasked: '900200****1234', date: '2026-07-02', direction: 'in', amount: 600, balance: 5500, summary: '薪資入帳', note: '' },
  ],
  ...over,
});
const engineOf = (/** @type {Record<string, any>} */ byModel) => () => ({
  models: AI_BANK_MODELS,
  parseOnce: async (/** @type {string} */ _t, /** @type {string} */ m) => {
    const a = byModel[m];
    if (a === undefined) throw new Error(`夾具缺 ${m}`);
    if (typeof a === 'function') throw a();
    return structuredClone(a);
  },
});
async function seedDb(/** @type {any} */ over = {}) {
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  delete (/** @type {any} */ (db.settings)).aiDualRead;
  Object.assign(db.settings, over);
  await saveDb(db);
}
/** 收集一次 preview 的所有 frame。 */
async function stagesOf(/** @type {any} */ opts, /** @type {any} */ parse = notRecognized) {
  /** @type {any[]} */ const frames = [];
  const r = await previewBankStatement('QUFBQQ==', undefined, parse, { ...opts, onStage: (f) => frames.push(f) }).catch((e) => ({ __err: e }));
  return { frames, codes: frames.map((f) => f.s), r };
}

// ---- ① 零插值＝機密機械化 ----
test('機密｜frame 只有代碼與（唯一例外）模型顯示名——帳單欄值／池大小／張數一律推不出去', async () => {
  await seedDb();
  const { frames } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: goodAnswer(), [AI_BANK_MODELS.escalation]: goodAnswer() }), aiExtract: extractA });
  assert.ok(frames.length > 0, '要有進度');
  for (const f of frames) {
    assert.deepEqual(Object.keys(f).sort(), f.model ? ['model', 's', 't'] : ['s', 't'], `★frame 只能有 t/s(/model)：${JSON.stringify(f)}`);
    const blob = JSON.stringify(f);
    assert.doesNotMatch(blob, /900200|1234|5,?500|4,?900|超商|薪資|sk-ant/, '★絕不回聲帳單內容或鑰匙');
  }
});

test('機密｜stageFrame 是唯一出口：非表列代碼一律丟掉（防未來有人推自由文字）', () => {
  assert.equal(stageFrame('read_db')?.s, 'read_db');
  assert.equal(stageFrame('帳戶 900200 餘額 5500'), null, '★自由文字推不出去');
  assert.equal(stageFrame('__proto__'), null);
  // sink 也吃同一條路：不合法代碼不呼叫 onStage
  /** @type {any[]} */ const got = [];
  const sink = makeStageSink((f) => got.push(f));
  sink('read_db'); sink('自由文字'); sink('open_pdf', { model: 'Claude Sonnet 5' });
  assert.deepEqual(got.map((f) => f.s), ['read_db', 'open_pdf']);
  assert.equal(got[1].model, 'Claude Sonnet 5', '模型顯示名是唯一容許的附帶值');
});

test('機密｜sink 爆掉不得影響主流程（進度是附屬品）', async () => {
  await seedDb();
  const r = await previewBankStatement('QUFBQQ==', undefined, notRecognized, {
    useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: goodAnswer(), [AI_BANK_MODELS.escalation]: goodAnswer() }),
    aiExtract: extractA, onStage: () => { throw new Error('前端爆炸'); },
  });
  assert.equal(/** @type {any} */ (r).engine, 'ai', '★推進度失敗不得讓解析失敗');
});

// ---- ② 只在事情真的發生後才推 ----
test('誠實｜未設鑰匙＝零 AI 呼叫的路：一個 ai_* 階段都不准出現（#455 假進度同族）', async () => {
  await seedDb({ aiApiKey: '' });
  const { codes, r } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({}), aiExtract: extractA });
  assert.equal(/** @type {any} */ (r).__err?.code, 'ai_no_key');
  assert.ok(!codes.some((c) => String(c).startsWith('ai_')), `★沒送出去就不准說在送（實得 ${JSON.stringify(codes)}）`);
  assert.ok(codes.includes(STAGES.TEMPLATE_MISS), '走到過的階段照樣要報');
});

// ---- ③ 階段序列由資料決定 ----
test('序列｜模板認得＝open→template_try→template_hit→verify→build_preview，且不含 ai/recipe 階段', async () => {
  await seedDb();
  const parsedOk = async () => ({ bank: '台新', referenceDate: '2026-07-31', accounts: [], accountCurrency: {}, transactions: [] });
  const { codes } = await stagesOf({}, parsedOk);
  assert.deepEqual(codes, [STAGES.READ_DB, STAGES.OPEN_PDF, STAGES.TEMPLATE_TRY, STAGES.TEMPLATE_HIT, STAGES.VERIFY, STAGES.BUILD_PREVIEW]);
});

test('序列｜認不得→無規則卡→AI 雙讀一致：recipe_try→recipe_miss→ai_start→ai_dual→ai_compare（無仲裁）', async () => {
  await seedDb();
  const { codes } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: goodAnswer(), [AI_BANK_MODELS.escalation]: goodAnswer() }), aiExtract: extractA });
  assert.deepEqual(codes, [STAGES.READ_DB, STAGES.OPEN_PDF, STAGES.TEMPLATE_TRY, STAGES.TEMPLATE_MISS,
    STAGES.RECIPE_TRY, STAGES.RECIPE_MISS, STAGES.AI_START, STAGES.AI_DUAL, STAGES.AI_COMPARE]);
  assert.ok(!codes.includes(STAGES.AI_ARBITRATE), '★兩讀一致就不准說在仲裁');
});

test('序列｜兩讀不一致＝多一個 ai_arbitrate（仲裁真的發生了才報）', async () => {
  await seedDb();
  const good = goodAnswer();
  const other = goodAnswer({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [good.transactions[0], { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const { codes } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: other, [AI_BANK_MODELS.escalation]: good, [AI_ARBITER_MODEL]: good }), aiExtract: extractA });
  assert.deepEqual(codes.slice(-3), [STAGES.AI_DUAL, STAGES.AI_COMPARE, STAGES.AI_ARBITRATE]);
});

test('序列｜關掉雙讀＝ai_single（不得謊稱兩個 AI 在讀）；升級才報 ai_escalate', async () => {
  await seedDb({ aiDualRead: false });
  const bad = () => Object.assign(new Error('壞答案'), { status: 400, code: 'ai_bad_answer' });
  const { codes } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: bad, [AI_BANK_MODELS.escalation]: goodAnswer() }), aiExtract: extractA });
  assert.ok(codes.includes(STAGES.AI_SINGLE) && codes.includes(STAGES.AI_ESCALATE), `★單讀階梯兩發各自報（實得 ${JSON.stringify(codes)}）`);
  assert.ok(!codes.includes(STAGES.AI_DUAL), '★關掉雙讀就不准說「兩個 AI 各自讀」');
});

// ---- 前端文案 ----
test('文案｜每個後端代碼都有句子（互扣：新增代碼沒補文案＝這裡紅）；未知代碼＝空字串不吐亂碼', () => {
  assert.deepEqual(progressTextCodes(), Object.values(STAGES).sort(), '★代碼表與文案表逐一對應');
  assert.match(progressText({ t: 'stage', s: STAGES.AI_DUAL }), /兩個 AI/);
  assert.equal(progressText({ t: 'stage', s: 'made_up' }), '', '未知代碼＝不畫（新後端配舊前端不吐亂碼）');
  assert.equal(progressText({ t: 'done', r: {} }), '');
  assert.equal(progressText(null), '');
  assert.match(progressText({ t: 'stage', s: STAGES.AI_SINGLE, model: 'Claude Sonnet 5' }), /（Claude Sonnet 5）/, '模型名附在句尾');
});

test('文案｜不得出現預估時間／快好了／步數（假進度禁令的文字面）', () => {
  // 只掃**句子本體**（TEXT 表），不掃註解——註解本來就要能寫「不得出現預計…」這種禁令說明。
  const src = readFileSync(join(ROOT, 'public/modules/progress-text.js'), 'utf8');
  const table = src.slice(src.indexOf('const TEXT'), src.indexOf('});', src.indexOf('const TEXT')));
  assert.ok(table.length > 100, '抓得到 TEXT 表（抓不到＝這題空轉）');
  assert.doesNotMatch(table, /預計|大約還要|剩下|快好了|還有 ?\d+ ?步|第 ?\d+ ?\/ ?\d+ ?步/, '★ETA 與步數＝猜測＝同族假進度');
  for (const line of table.split('\n')) assert.doesNotMatch(line, /\$\{/, '★句子零插值（要帶模型名走 progressText 的既有那一條路）');
});

// ---- 串流傳輸層 ----
test('串流｜NDJSON 形狀：階段逐行、最後一行 done 帶結果；錯誤走 error frame 並保住 code 通道', async () => {
  /** @type {string[]} */ const written = [];
  const fakeRes = { status: () => fakeRes, set: () => fakeRes, write: (/** @type {string} */ s) => written.push(s), end: () => {} };
  await streamNdjson(fakeRes, async (onStage) => { onStage({ t: 'stage', s: 'read_db' }); return { ok: true }; });
  const lines = written.join('').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { t: 'stage', s: 'read_db' });
  assert.deepEqual(lines[1], { t: 'done', r: { ok: true } });
  written.length = 0;
  await streamNdjson(fakeRes, async () => { throw Object.assign(new Error('這份 PDF 有加密'), { status: 400, code: 'pdf_password' }); });
  const err = JSON.parse(written.join('').trim());
  assert.deepEqual(err, { t: 'error', error: '這份 PDF 有加密', code: 'pdf_password' },
    '★code 必須跟著走（前端 e.code === "pdf_password" 才跳得出密碼窗）');
});

test('串流｜不帶 stream 旗標的呼叫端行為零位移（同一路徑、兩種形態）', () => {
  const src = readFileSync(join(ROOT, 'lib/routes/statement.js'), 'utf8');
  assert.match(src, /if \(req\.body\.stream === true\) return streamNdjson\(/, '★嚴格布林（跟 useAi 同款：字串 "true" 不算）');
  assert.match(src, /return res\.json\(await previewBankStatement\(/, '★沒帶旗標＝照舊一發 JSON');
});

test('接線｜前端：四條路徑走單一出口、出口帶 stream:true、進度只在收到 frame 時寫', () => {
  const src = readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8');
  assert.match(src, /apiStream\('\/bank-statement\/preview', \{ \.\.\.previewBody\(bodyArgs\), stream: true \}/, '★出口帶旗標');
  assert.match(src, /progressText\(f\); if \(t && setProgress\) setProgress\(t\)/, '★只有收到 frame 才寫字（沒有計時器）');
  assert.doesNotMatch(src, /setTimeout\([^)]*setProgress|setInterval\([^)]*setProgress/, '★禁止時間驅動的假動畫');
  const app = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  assert.match(app, /export async function apiStream/, 'apiStream 在 app.js（與 api 同一個家）');
  assert.match(app, /throw Object\.assign\(new Error\(msg\), code \? \{ code: String\(code\) \} : \{\}\)/, '非 200 也保 code 通道');
});
