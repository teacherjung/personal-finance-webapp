// @ts-check
// 配方儲存與讀取接線（P2-2）的考題：認不得→先試配方（零元零外送、不需 useAi）→全敗才輪 AI；
// 版本回滾（裁示④細部＝current 紅退 previous、apply 成功自動互換）；畢業計數（裁示②＝連 5）；
// 疑似過期標記（配方中版面但閘紅→走 AI 匯入成功後經確認票標記）。
// 夾具＝P2-1 的合成版面 A（詞彙全虛構、帳號 900100/900200 前綴假值慣例）；隔離＝STORE_FILE 暫存檔。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-recipestore-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { previewBankStatement, applyBankStatement, recipeBankRoute } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { clearAiTicketsForTest } = await import('../lib/ai-confirm-ticket.js');
const { RECIPE_FORMAT_VERSION } = await import('../lib/parse-recipe.js');
const { sanitizeDbForWrite, READONLY_COLLECTIONS } = await import('../lib/schema.js');
const { AI_BANK_MODELS } = await import('../lib/ai-parse.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

// ---- 夾具（抄 P2-1 test/parse-recipe.test.js 的版面 A；兩份考題各自持有＝改一份不會靜默影響另一份）----

const L = (/** @type {number} */ y, /** @type {any[]} */ pairs) => ({ y, cells: pairs.map((p) => (p.length === 3 ? { x: p[0], w: p[1], s: p[2] } : { x: p[0], s: p[1] })) });

const goodRecipe = () => ({
  formatVersion: RECIPE_FORMAT_VERSION,
  bank: '合成銀行',
  docAnchors: ['合成帳戶總覽', '往來紀錄'],
  dateFormat: 'west-slash',
  refDate: { strategy: 'anchored-date', anchor: '結算基準日' },
  summary: {
    sections: [{ anchor: '合成帳戶總覽', currency: 'TWD' }, { anchor: '外幣總覽', currency: 'BY-CODE' }],
    endAnchor: '總計',
    balancePick: 'dollar-tagged',
  },
  detail: {
    rowIdent: 'acct-date',
    headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額',
    headerNote: '附記', headerIgnore: ['單號'],
  },
});
/** 失靈的變體：headerIn 字面錯（存入 vs 存進）＝版面上找不到宣告的表頭、真表頭「存進金額」又成了
 * 金額區內的未宣告格＝雙重拒解——**中版面（docAnchors 沒變）但解不動**。
 * ⚠️ 不用「出入欄對調」當失靈樣本：引擎的 running 餘額覆寫機關會把方向自我修復回來（P2-1 的
 * 功能），對調版照樣解對＝根本不失靈（首版考題就這樣假紅過，誠實記著）。 */
const brokenRecipe = () => { const r = goodRecipe(); r.detail.headerIn = '存入金額'; return r; };

// ⚠️ 與 P2-1 夾具的差異（刻意）：總覽餘額改成與末筆交易餘額一致（730／97,400）——P2-1 只驗
// 「配方引擎＝模板引擎同源」，本份要走**正式強閘**（末筆對總覽＋餘額鏈），數字必須自洽才放行。
const linesA = () => [
  L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
  L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$730']]),
  L(260, [[50, '乙種活存'], [150, '900200****3302'], [453, '$97,400'], [521, '主要戶']]),
  L(240, [[47, '總計'], [445, '$98,130']]),
  L(220, [[47, '外幣總覽區']]),
  L(200, [[367, 'JPY']]),
  L(180, [[56, '外幣活儲'], [108, '900300****363'], [436, '$700'], [491, '$150']]),
  L(160, [[47, '總計'], [490, '0']]),
  L(140, [[47, '往來紀錄明細']]),
  L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
  L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730']]),
  L(83, [[53, 0, '900100****3301'], [124, 0, '2026/06/16'], [177, 0, '合成扣款'], [290, 8, '$1,000'], [418, 0, '$730']]),
  L(66, [[53, 0, '900200****3302'], [124, 0, '2026/06/02'], [180, 0, '合成入帳'], [349, 40, '$2,400'], [414, 0, '$97,400']]),
];

const notRecognized = async () => { throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400 }); };
const pwErr = async () => { throw Object.assign(new Error('PDF 密碼不對'), { status: 400, code: 'pdf_password' }); };
const extractA = async () => linesA();

/** @param {{recipes?: any[]}} [o] */
async function seedDb(o = {}) {
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = [];
  db.transactions = [];
  db.parseRecipes = o.recipes ?? [];
  db.settings.aiApiKey = '';
  await saveDb(db);
}
const row = (/** @type {any} */ over = {}) => ({ id: 'rcp-1', bank: '合成銀行', current: goodRecipe(),   // previous 缺席＝沒有上一版（object 型別不收 null）
  graduateStreak: 0, graduated: false, suspect: false, rebirths: 0,
  createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z', ...over });

// ---- 儲存層 ----

test('登記｜parseRecipes 是唯讀集合＋備份牆：缺 current 的殘缺列整筆濾除、合法列原樣保留', async () => {
  assert.ok(READONLY_COLLECTIONS.includes('parseRecipes'), '★要在唯讀集合名單（前端不可寫）');
  const db = /** @type {any} */ (await getDb());
  db.parseRecipes = [row(), { id: 'rcp-bad', bank: '沒有配方本體' }];
  const out = sanitizeDbForWrite(db, { mode: 'strip' });
  assert.equal(out.parseRecipes.length, 1, '★缺 current＝這列無意義＝濾除（REQUIRED_FIELDS）');
  assert.equal(out.parseRecipes[0].id, 'rcp-1');
  assert.deepEqual(out.parseRecipes[0].current.docAnchors, ['合成帳戶總覽', '往來紀錄'], '合法配方物件原樣保留');
});

// ---- 讀取路線（preview）----

test('preview｜認不得→配方命中＝engine:recipe、零 AI（不需 useAi、沒鑰匙也走得通）', async () => {
  await seedDb({ recipes: [row()] });
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(pv.engine, 'recipe', '★配方路線成立');
  assert.equal(pv.recipeId, 'rcp-1');
  assert.equal(pv.reconcile.level, 'strong', '★配方比照 AI＝只收強閘');
  assert.equal(pv.transactions.rows.length, 3, '三筆交易都到（previewBankTxForDb 的 rows 形狀）');
});

test('preview｜裁示④細部：current 閘紅＝自動退 previous 重解（免費、同一次預覽內）', async () => {
  await seedDb({ recipes: [row({ current: brokenRecipe(), previous: goodRecipe() })] });
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(pv.engine, 'recipe', '★上一版救回來了');
  assert.equal(pv.reconcile.level, 'strong');
});

test('preview｜配方全敗＋沒有 useAi＝把模板的原句錯誤拋回（配方是縱深、不是新的失敗來源）', async () => {
  await seedDb({ recipes: [row({ current: brokenRecipe() })] });
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA }),
    /不是台新銀行/, '★使用者看到的仍是模板路線的原句');
});

test('preview｜密碼錯絕不落配方：pdf_password 原樣拋回、抽字接縫連碰都不碰', async () => {
  await seedDb({ recipes: [row()] });
  let extracted = 0;
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, pwErr, { aiExtract: async () => { extracted++; return linesA(); } }),
    (/** @type {any} */ e) => e.code === 'pdf_password');
  assert.equal(extracted, 0, '★密碼問題要回前端跳密碼窗，不是拿配方亂試');
});

test('preview｜配方中版面但失靈（拒解/閘紅同待遇）＋useAi＝AI 接手，票上帶著「疑似過期候選」名單', async () => {
  await seedDb({ recipes: [row({ current: brokenRecipe() })] });
  const db = await getDb(); db.settings.aiApiKey = 'sk-ant-synthetic-test-key'; await saveDb(db);
  // ⚠️ 配方與 AI 共用同一個抽字接縫（opts.aiExtract）——文字必須含版面錨點（配方才會 match 而失靈），
  //   也必須含答案卷的每個金額（AI 接地檢查）：直接用 linesA、答案數字全取自 linesA。
  const answer = {
    bank: '合成一銀', referenceDate: '2026-06-30',
    accountCurrencies: [{ masked: '900200****3302', currency: 'TWD' }],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [{ masked: '900200****3302', balance: 97400, currency: 'TWD', label: '活存', note: '' }],
    transactions: [
      { acctMasked: '900200****3302', date: '2026-06-02', direction: 'in', amount: 2400, balance: 97400, summary: '合成入帳', note: '' },
    ],
  };
  const engineOf = () => ({ models: AI_BANK_MODELS, parseOnce: async () => answer });
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf, aiExtract: extractA });
  assert.equal(pv.engine, 'ai', '配方失靈＝照原順序輪 AI');
  assert.ok(pv.aiTicket, '票照發');
  // 兌票套用＝匯入成功那一刻，該配方被標疑似過期（同一次交易原子寫）
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf, aiExtract: extractA });
  assert.equal(res.ok, true);
  const after1 = await getDb();
  const r1 = (after1.parseRecipes || []).find((x) => x.id === 'rcp-1');
  assert.equal(r1?.suspect, true, '★裁示②：配方失靈＝標疑似過期（在真的完成匯入那一刻寫）');
  assert.equal(r1?.graduateStreak, 0, '★連續計數歸零');
});

// ---- 套用路線（apply）＋計數 ----

test('apply｜配方確定性＝自己重解（不需要票）；寫入前 fresh db 重過閘；成功＝streak+1、engine:recipe', async () => {
  await seedDb({ recipes: [row()] });
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(res.ok, true);
  assert.equal(/** @type {any} */ (res).engine, 'recipe');
  const db = await getDb();
  assert.equal((db.transactions || []).length, 3, '三筆交易真的寫進帳本');
  const r1 = (db.parseRecipes || []).find((x) => x.id === 'rcp-1');
  assert.equal(r1?.graduateStreak, 1, '★套用成功＝連續計數 +1');
  assert.equal(r1?.graduated, false);
  assert.ok(r1?.lastUsedAt, '有用過的時間戳');
});

test('apply｜裁示②畢業：連續 5 份全過強閘＝graduated（第 4 份還不是）', async () => {
  await seedDb({ recipes: [row({ graduateStreak: 3 })] });
  const r1 = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA, skipSimilar: false });
  assert.equal(r1.ok, true);
  let db = await getDb();
  assert.equal(db.parseRecipes?.[0]?.graduated, false, '第 4 份＝還沒畢業');
  const r2 = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA, skipSimilar: false });
  assert.equal(r2.ok, true);
  db = await getDb();
  assert.equal(db.parseRecipes?.[0]?.graduateStreak, 5);
  assert.equal(db.parseRecipes?.[0]?.graduated, true, '★連 5＝穩定畢業');
});

test('apply｜裁示④細部自動回滾：previous 救場＝版本互換（previous 升 current、壞的降 previous）、streak 從 1 重數', async () => {
  await seedDb({ recipes: [row({ current: brokenRecipe(), previous: goodRecipe(), graduateStreak: 4, graduated: false })] });
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(res.ok, true);
  const db = await getDb();
  const r1 = (db.parseRecipes || []).find((x) => x.id === 'rcp-1');
  assert.equal(r1?.current?.detail?.headerIn, '存進金額', '★好的那版升為現行');
  assert.equal(r1?.previous?.detail?.headerIn, '存入金額', '★壞的降為上一版（留 1 版不變量：不丟、等重生比對）');
  assert.equal(r1?.graduateStreak, 1, '★換版＝從 1 重數');
  assert.equal(r1?.graduated, false);
});

test('preview｜配方比照 AI＝只收強閘：弱閘版面（明細無餘額格＝鏈驗不了）拒收、拋回模板原句', async () => {
  // linesA 的弱化版：明細列拿掉餘額格＝balance 全 null＝餘額鏈無從驗＝level weak。
  // 模板路線的閘收 weak（台新真版面有印餘額、歷史行為），配方與 AI 同待遇＝只收 strong——
  // 這一格是「配方比照 AI 級」的獨自承重域（把閘降級成模板閘＝這裡轉綠）。
  const weakLines = linesA().map((l) => ({ ...l, cells: l.cells.filter((c) => !['$1,730', '$730', '$97,400'].includes(c.s) || l.y > 110) }));
  await seedDb({ recipes: [row()] });
  await assert.rejects(
    previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: async () => weakLines }),
    /不是台新銀行/, '★弱閘＝配方不收、原句拋回');
});

test('recipeBankRoute｜純讀不變量：預覽路線跑完，db 的配方列一個位元組都沒動', async () => {
  await seedDb({ recipes: [row({ current: brokenRecipe(), previous: goodRecipe() })] });
  const db = await getDb();
  const before = JSON.stringify(db.parseRecipes);
  const r = await recipeBankRoute('QUFBQQ==', undefined, db, { extract: extractA });
  assert.ok(r.hit, '前提：previous 命中');
  assert.equal(r.hit?.usedVersion, 'previous');
  assert.equal(JSON.stringify(db.parseRecipes), before, '★版本互換與計數是 apply 的事——preview 全程唯讀');
});
