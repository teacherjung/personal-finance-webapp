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
// ⚠️ 照**真實解析器**的形狀：認不得會帶 code:'bank_unrecognized'（AI 入口的判準也是它）——
// 夾具漏了這個碼，就測不到「只有真的判定版面不符才說範本認不得」那條（Codex r1#1）。
const notRecognized = async () => { throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400, code: 'bank_unrecognized' }); };
/** 壞檔／資源上限：不是「版面不符」——畫面不得說成範本認不得。 */
const brokenPdf = async () => { throw Object.assign(new Error('PDF 無法開啟：Invalid PDF structure'), { status: 400 }); };
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
test('序列｜模板認得＝read_db→open_pdf→template_hit→verify→build_preview，且不含 ai/recipe 階段', async () => {
  await seedDb();
  const parsedOk = async () => ({ bank: '台新', referenceDate: '2026-07-31', accounts: [], accountCurrency: {}, transactions: [] });
  const { codes } = await stagesOf({}, parsedOk);
  assert.deepEqual(codes, [STAGES.READ_DB, STAGES.OPEN_PDF, STAGES.TEMPLATE_HIT, STAGES.VERIFY, STAGES.BUILD_PREVIEW]);
});

test('序列｜**兩讀都有效但不一致**＝compare 之後才 arbitrate（仲裁真的發生了才報）', async () => {
  await seedDb();
  const good = goodAnswer();
  // ⚠️ 兩份都要真的通過驗收＋接地＋強閘，才算「兩讀不一致」——否則是「一讀掛掉」的另一型（掛羊頭：
  // 我第一版的 other 用了 5,000，但版面沒印過這個數字＝接地擋掉＝根本只有一讀有效）。
  // 這裡讓版面多一列雜訊（利率參考）印出 5,000，other 的自洽鏈才接得到地。
  const linesWithStray = async () => [...linesA(), L(70, [[40, '本期利率參考'], [140, '5,000']])];
  const other = goodAnswer({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [good.transactions[0], { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const { codes } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: other, [AI_BANK_MODELS.escalation]: good, [AI_ARBITER_MODEL]: good }), aiExtract: linesWithStray });
  // 兩讀有效但不一致：dual → compare（真的有兩份可比）→ arbitrate → 整理
  assert.deepEqual(codes.slice(-4), [STAGES.AI_DUAL, STAGES.AI_COMPARE, STAGES.AI_ARBITRATE, STAGES.BUILD_PREVIEW]);
});

test('序列｜兩讀都掛＝不得說「兩份都讀完了正在比對」（P101 的承重：無條件推 compare 就會說謊）', async () => {
  await seedDb();
  const bad = () => Object.assign(new Error('壞答案'), { status: 400, code: 'ai_bad_answer' });
  const { codes, r } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: bad, [AI_BANK_MODELS.escalation]: bad, [AI_ARBITER_MODEL]: bad }), aiExtract: extractA });
  assert.ok(/** @type {any} */ (r).__err, '兩讀都掛＝整份不收');
  assert.ok(codes.includes(STAGES.AI_DUAL), '雙讀真的發生過');
  assert.ok(!codes.includes(STAGES.AI_COMPARE), '★沒有兩份可比＝不准說在比對');
  assert.ok(!codes.includes(STAGES.BUILD_PREVIEW), '沒整理成預覽就不准說在整理');
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
  // 原型鍵＝未知代碼裡最陰的一種（鐵則 3.5；Codex #490 r2#1 同族）：`TEXT['toString']` 撈到原型函式，
  // `|| ''` 擋不住它，畫面會印出 function 本體。自有 __proto__ 鍵只有 JSON.parse 造得出來。
  for (const k of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    assert.equal(progressText({ t: 'stage', s: k }), '', `★原型鍵 ${k} 不可撈到原型上的函式`);
  }
  assert.equal(progressText(JSON.parse('{"t":"stage","s":"__proto__"}')), '', '★JSON.parse 造的自有保留字鍵同樣不畫');
  assert.equal(progressText({ t: 'done', r: {} }), '');
  assert.equal(progressText(null), '');
  assert.match(progressText({ t: 'stage', s: STAGES.AI_SINGLE, model: 'Claude Sonnet 5' }), /（Claude Sonnet 5）/, '模型名附在句尾');
});

test('文案｜驗算那句不可無條件宣稱「合計」也驗了——那道對混幣帳單整道跳過（Codex #490 r1#2 抓到的假綠）', () => {
  // ⚠️ 這題守的是**同一族的畫面說謊**：混幣帳單的合計交叉驗證整道不跑（lib/services/bank-import.js
  //   的 assertAiBankReconciled），而使用者自己的帳單正是混幣——進度條卻在說「正在驗算（餘額鏈與合計）」。
  //   兩條斷言刻意一條鎖字面、一條鎖語意：只鎖字面守的是拼字，只鎖語意則對「完全不提合計」誤紅。
  const v = progressText({ t: 'stage', s: STAGES.VERIFY });
  assert.ok(v, '驗算階段要有句子');
  assert.doesNotMatch(v, /餘額鏈與合計|餘額鏈、合計|餘額鏈及合計/,
    '★不可把合計與餘額鏈並列成「都會驗」（退回 main 那句就是這樣寫的）');
  if (/合計/.test(v)) {
    // ⚠️ 條件要**點名混幣**（自審突變 M-progress-relapse）：原本只要求出現「要／才／不一定」，
    //    而「合計**只要**帳單印了就一起驗」四個字免費滿足它——條件只剩一半，正好吞掉這支
    //    PR 唯一在講的那一個（混幣＝整道關閉），而使用者的帳單就是混幣。同一顆假綠原地復活。
    assert.match(v, /混幣|外幣/,
      '★提到合計就要點名混幣那個條件——「只要帳單印了就驗」是假話（混幣時整道不跑）');
    assert.match(v, /要|才|不一定|未必|能.*的話/, '★而且要講成條件，不是斷言');
    // ⚠️ 主詞也要對（Codex #490 r6#1）：管線只知道「AI 有沒有交回那一欄」，證明不了帳單印了什麼
    //    （他實測：自洽錯值散放在原文別處、連合計標籤都沒有，全管線照樣 pass）。
    assert.doesNotMatch(v, /帳單印/, '★不可說「合計要帳單印得出來」——那是在替帳單斷言，我們只知道有沒有讀到那一欄');
  }
  // ⚠️ 這個階段碼是**兩條路線共用**的（r9#1）：模板命中後也會推 VERIFY（零 AI、內容不外送），
  //    句子若提 AI＝畫面先說「內建範本認得」再冒出 AI，與實際路徑和隱私語意都不符。
  assert.doesNotMatch(v, /AI/, '★驗算這句不可提 AI——模板路線（零 AI 呼叫）也會推這個階段碼');
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

// ---- Grok r0 補強：客戶端還原層（apiStream）與唯一出口的機械保證 ----
test('G6｜串流協議解讀（純模組直測）：半行/壞行/error 帶 code/斷線不假裝成功/stage 交出去', async () => {
  const { makeNdjsonParser, reduceFrames, TRUNCATED } = await import('../public/modules/ndjson-stream.js');
  /** 餵任意分塊，回 {frames 收斂結果, 收到的 stage} */
  const feed = (/** @type {string[]} */ chunks) => {
    const p = makeNdjsonParser();
    /** @type {any[]} */ const seen = [];
    /** @type {any} */ let out = null;
    for (const c of chunks) out = reduceFrames(p.push(c), (f) => seen.push(f)) || out;
    out = reduceFrames(p.end(), (f) => seen.push(f)) || out;
    return { out: out || TRUNCATED, seen };
  };
  // ①半行：frame 被切在中間，拼回來要完整解讀
  const a = feed(['{"t":"stage","s":"read_', 'db"}\n{"t":"done","r":{"ok":1}}\n']);
  assert.deepEqual(a.seen.map((f) => f.s), ['read_db'], '★半行要拼回來');
  assert.deepEqual(a.out, { ok: true, result: { ok: 1 } });
  // ②壞行（代理雜訊）不毀整趟
  assert.deepEqual(feed(['<html>proxy junk</html>\n{"t":"done","r":{"ok":2}}\n']).out, { ok: true, result: { ok: 2 } });
  // ③error frame：訊息與 code 都要還原（密碼窗靠 code 才跳得出來）
  assert.deepEqual(feed(['{"t":"error","error":"這份 PDF 有加密","code":"pdf_password"}\n']).out,
    { ok: false, error: '這份 PDF 有加密', code: 'pdf_password' });
  // ④沒有換行結尾的最後一行也要收（end() 收尾）
  assert.deepEqual(feed(['{"t":"done","r":3}']).out, { ok: true, result: 3 });
  // ⑤斷線＝沒有終端 frame＝誠實報中斷，不得假裝成功
  const d = feed(['{"t":"stage","s":"read_db"}\n']);
  assert.equal(d.out.ok, false);
  assert.match(String(/** @type {any} */ (d.out).error), /連線中斷/);
  // ⑥onStage 爆掉不得影響結果
  const p2 = makeNdjsonParser();
  const r2 = reduceFrames(p2.push('{"t":"stage","s":"read_db"}\n{"t":"done","r":9}\n'), () => { throw new Error('前端爆炸'); });
  assert.deepEqual(r2, { ok: true, result: 9 });
});

test('G6b｜app.js 的 apiStream 走那支純模組、且兩條錯誤路都保住 code 自有屬性', () => {
  const app = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  assert.match(app, /import \{ makeNdjsonParser, reduceFrames, TRUNCATED \}/, '協議解讀集中在純模組（可直測）');
  assert.match(app, /const final = out \|\| TRUNCATED;/, '沒有終端 frame＝斷線結果（不假裝成功）');
  assert.match(app, /throw Object\.assign\(new Error\(final\.error\), final\.code \? \{ code: String\(final\.code\) \} : \{\}\)/, '★error frame 路：code 自有屬性');
  assert.match(app, /throw Object\.assign\(new Error\(msg\), code \? \{ code: String\(code\) \} : \{\}\)/, '★非 200 路：code 自有屬性');
});

test('G8｜唯一出口的機械保證：服務層只能經 stage sink 推，不得直接呼叫 onStage', () => {
  const src = readFileSync(join(ROOT, 'lib/services/bank-import.js'), 'utf8');
  const bad = src.split('\n').filter((l) => /\bonStage\s*\(/.test(l) && !/makeStageSink|@param|opts\.onStage \}/.test(l));
  assert.deepEqual(bad, [], `★服務層不得直接呼叫 onStage（繞過 stageFrame 白名單＝自由物件上船）：${JSON.stringify(bad)}`);
  assert.match(src, /const stage = makeStageSink\(opts\.onStage\)/, 'preview 走 sink');
  assert.match(src, /const stage = makeStageSink\(seams\.onStage\)/, 'aiBankRoute 走 sink');
});

test('G7｜model 白名單：只收 modelDisplayName 形狀，長字串／帳單內容一律丟掉', () => {
  assert.equal(stageFrame('ai_single', { model: 'Claude Sonnet 5' })?.model, 'Claude Sonnet 5');
  assert.equal(stageFrame('ai_single', { model: 'Claude Opus 4.6' })?.model, 'Claude Opus 4.6');
  assert.equal(stageFrame('ai_single', { model: '帳戶 900200****1234 餘額 5,500' })?.model, undefined, '★帳單內容塞進 model 也上不了船');
  assert.equal(stageFrame('ai_single', { model: 'x'.repeat(200) })?.model, undefined, '★長度上限');
  assert.equal(stageFrame('ai_single', { model: 'claude-sonnet-5' })?.model, undefined, '模型代號（非顯示名）不外送＝既有慣例');
});

test('G2｜文案不得預測下一步（recipe_miss 不可說「要送 AI」——此時還沒判 useAi／停止線／鑰匙）', () => {
  // 只掃**句子字面**（引號內），不掃行內註解——註解本來就要寫得出「不得說『要送 AI 讀』」這種禁令。
  const src = readFileSync(join(ROOT, 'public/modules/progress-text.js'), 'utf8');
  const table = src.slice(src.indexOf('const TEXT'), src.indexOf('});', src.indexOf('const TEXT')));
  const sentences = [...table.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(sentences.length >= 10, `抓得到句子（實得 ${sentences.length} 句；抓不到＝這題空轉）`);
  for (const line of sentences) assert.doesNotMatch(line, /要送 ?AI|接下來會|再來會|預計|剩下/, `★預測下一步／ETA＝假進度同族：「${line}」`);
  assert.match(progressText({ t: 'stage', s: STAGES.RECIPE_MISS }), /沒有合用的版面規則卡/);
});

// ---- Codex r1 補強：失敗種類與「真的進了那一步」 ----
test('r1#1｜壞掉的 PDF（非版面不符）＝不得說「範本認不得」、也不得說在試規則卡', async () => {
  await seedDb();
  const { codes, r } = await stagesOf({}, brokenPdf);
  assert.ok(/** @type {any} */ (r).__err, '錯誤照樣往上丟');
  assert.ok(!codes.includes(STAGES.TEMPLATE_MISS), `★壞檔＝先報錯死因（實得 ${JSON.stringify(codes)}）`);
  assert.ok(!codes.includes(STAGES.RECIPE_TRY), '★沒進規則卡迴圈就不准說在試');
  assert.deepEqual(codes, [STAGES.READ_DB, STAGES.OPEN_PDF]);
});

test('r1#1b｜沒有任何規則卡＝不推 recipe_try/miss（recipeBankRoute 根本直接返回）', async () => {
  await seedDb();   // parseRecipes 空
  const { codes } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: goodAnswer(), [AI_BANK_MODELS.escalation]: goodAnswer() }), aiExtract: extractA });
  assert.ok(!codes.includes(STAGES.RECIPE_TRY) && !codes.includes(STAGES.RECIPE_MISS),
    `★無卡＝那兩碼都不推（實得 ${JSON.stringify(codes)}）`);
  assert.deepEqual(codes, [STAGES.READ_DB, STAGES.OPEN_PDF, STAGES.TEMPLATE_MISS, STAGES.OPEN_PDF,
    STAGES.AI_START, STAGES.AI_DUAL, STAGES.AI_COMPARE, STAGES.VERIFY, STAGES.BUILD_PREVIEW]);
});

test('r1#1c｜有規則卡但都不合用＝recipe_try→recipe_miss（真的進了迴圈才報）', async () => {
  await seedDb();
  const db = await getDb();
  db.parseRecipes = [{ id: 'rcp-x', bank: '別家', current: { formatVersion: 1, bank: '別家', docAnchors: ['不會命中的錨點'], dateFormat: 'YYYY/MM/DD', refDate: { strategy: 'none', anchor: null }, summary: { sections: [], endAnchor: '合計', balancePick: 'first' }, detail: { rowIdent: 'date-first', headerOut: '支出', headerIn: '存入', headerBalance: '餘額', headerNote: null, headerIgnore: [] } }, graduateStreak: 0, rebirths: 0 }];
  await saveDb(db);
  const { codes } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: goodAnswer(), [AI_BANK_MODELS.escalation]: goodAnswer() }), aiExtract: extractA });
  assert.ok(codes.includes(STAGES.RECIPE_TRY) && codes.includes(STAGES.RECIPE_MISS), `★有卡＝報試用與結果（實得 ${JSON.stringify(codes)}）`);
});

test('r1#2｜一讀掛掉走的是 ai_attest（不得用「兩份讀得不一樣」那句——#476 r1#1 同一課）', async () => {
  await seedDb();
  const bad = () => Object.assign(new Error('壞答案'), { status: 400, code: 'ai_bad_answer' });
  const { codes } = await stagesOf({ useAi: true, aiEngineFactory: engineOf({ [AI_BANK_MODELS.primary]: bad, [AI_BANK_MODELS.escalation]: goodAnswer(), [AI_ARBITER_MODEL]: goodAnswer() }), aiExtract: extractA });
  assert.ok(codes.includes(STAGES.AI_ATTEST), `★一讀掛掉＝attest（實得 ${JSON.stringify(codes)}）`);
  assert.ok(!codes.includes(STAGES.AI_ARBITRATE), '★不得報成「兩份不一致」');
  assert.match(progressText({ t: 'stage', s: STAGES.AI_ATTEST }), /其中一讀沒讀出合法答案/);
  assert.doesNotMatch(progressText({ t: 'stage', s: STAGES.AI_ATTEST }), /兩份讀得不一樣/);
});
