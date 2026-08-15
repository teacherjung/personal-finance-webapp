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

const { previewBankStatement, applyBankStatement, recipeBankRoute, recordRecipeApplied, markRecipesSuspect } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { clearAiTicketsForTest, issueAiTicket, redeemAiTicket, restoreAiTicket } = await import('../lib/ai-confirm-ticket.js');
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

test('preview｜裁示④細部：current 失靈（此題樣本＝拒解；真閘紅另有預審B1 題）＝自動退 previous 重解（免費）', async () => {
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
  await seedDb({ recipes: [row({ current: brokenRecipe(), graduateStreak: 4, graduated: true })] });
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
  assert.equal(r1?.graduateStreak, 0, '★連續計數歸零（種 4 進去＝斷言真的承重）');
  assert.equal(r1?.graduated, false, '★畢業旗標也要取消（已畢業配方失靈＝畢業狀態不可說謊）');
});

// ---- 套用路線（apply）＋計數 ----

test('apply｜配方確定性＝自己重解（不需要票）；寫入前 fresh db 重過閘；成功＝streak+1、suspect 解除、engine:recipe', async () => {
  await seedDb({ recipes: [row({ suspect: true })] });   // 種 suspect＝「成功套用＝解除」的斷言真承重（預審 B3）
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(res.ok, true);
  assert.equal(/** @type {any} */ (res).engine, 'recipe');
  const db = await getDb();
  assert.equal((db.transactions || []).length, 3, '三筆交易真的寫進帳本');
  const r1 = (db.parseRecipes || []).find((x) => x.id === 'rcp-1');
  assert.equal(r1?.graduateStreak, 1, '★套用成功＝連續計數 +1');
  assert.equal(r1?.graduated, false);
  assert.equal(r1?.suspect, false, '★成功套用＝suspect 解除（它剛證明自己還讀得動）');
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

// ---- 預審 r0 補題（Grok G1/G2/G3＋工作流 A1/A4/B1/B2/B5）----

/** 真閘紅樣本（預審 B1）：first-money 會讀到總覽列的誘餌數字＝過解析、卡強閘（末筆 730 對不上 999999）。 */
const gateRedRecipe = () => { const r = goodRecipe(); r.summary.balancePick = 'first-money'; return r; };
const decoyLines = () => linesA().map((l) => (l.y === 280
  ? L(280, [[50, '甲種活存'], [150, '900100****3301'], [300, '999,999'], [473, '$730']])
  : l));
const extractDecoy = async () => decoyLines();

test('預審B1｜真閘紅（非拒解）也退 previous：current 解得動但數字對不上＝previous 救場', async () => {
  await seedDb({ recipes: [row({ current: gateRedRecipe(), previous: goodRecipe() })] });
  const db = await getDb();
  const r = await recipeBankRoute('QUFBQQ==', undefined, db, { extract: extractDecoy });
  assert.ok(r.hit, '★previous 要救回來');
  assert.equal(r.hit?.usedVersion, 'previous', '★current 是閘紅（parseWithRecipe 成功、reconcile 擋）——這一格逼「閘紅 catch」真的退版');
});

test('預審B2｜先試 current 的順序承重：兩版都有效＝用 current、不互換、streak 正常累加', async () => {
  await seedDb({ recipes: [row({ current: goodRecipe(), previous: goodRecipe(), graduateStreak: 2 })] });
  const db = await getDb();
  const r = await recipeBankRoute('QUFBQQ==', undefined, db, { extract: extractA });
  assert.equal(r.hit?.usedVersion, 'current', '★順序反轉＝這裡變 previous＝版本乒乓、永遠畢不了業');
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(res.ok, true);
  const after2 = await getDb();
  assert.equal(after2.parseRecipes?.[0]?.graduateStreak, 3, '★current 路＝累加、不重數');
  assert.ok(after2.parseRecipes?.[0]?.previous, '★沒有發生互換');
});

test('預審G2｜配方票＝所見即所得：preview 後配方列被整個移除，apply 憑票照樣寫入 preview 那份答案', async () => {
  await seedDb({ recipes: [row()] });
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(pv.engine, 'recipe');
  assert.ok(pv.aiTicket, '★配方預覽也發票');
  const db = await getDb(); db.parseRecipes = []; await saveDb(db);   // 其間配方被清掉（極端漂移）
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiTicket: pv.aiTicket, aiExtract: extractA });
  assert.equal(res.ok, true, '★票鎖住 parsed＝不重跑選版');
  assert.equal(/** @type {any} */ (res).engine, 'recipe');
  const after3 = await getDb();
  assert.equal((after3.transactions || []).length, 3, '寫入的是 preview 那份（計數守衛靜默跳過＝列已不在）');
});

test('預審G1｜並發雙套用的身分守衛：互換後的舊「previous 救場」記帳不得把壞版換回 current', async () => {
  const dbObj = /** @type {any} */ ({ parseRecipes: [row({ current: brokenRecipe(), previous: goodRecipe() })] });
  const staleUse = { id: 'rcp-1', usedVersion: /** @type {const} */ ('previous'), currentMatched: true, usedRecipe: goodRecipe() };   // 真回滾語意（current 中版面但失靈）
  recordRecipeApplied(dbObj, staleUse);   // 第一次：合法互換（previous=good 升 current）
  assert.equal(dbObj.parseRecipes[0].current.detail.headerIn, '存進金額', '前提：好版已升 current');
  recordRecipeApplied(dbObj, staleUse);   // 第二次（並發請求的舊決定）：previous 現在是壞版≠當時用的好版
  assert.equal(dbObj.parseRecipes[0].current.detail.headerIn, '存進金額', '★身分不符＝靜默跳過，壞版不得回鍋 current');
  // A2 邊角：previous 缺席時的舊互換決定＝不得把 current 設成 undefined（炸 saveDb）
  const dbObj2 = /** @type {any} */ ({ parseRecipes: [row()] });
  recordRecipeApplied(dbObj2, staleUse);
  assert.ok(dbObj2.parseRecipes[0].current, '★current 不得變 undefined（計數副作用沒資格弄死匯入）');
});

test('預審A1｜票放回＝整份放回：suspectRecipeIds／recipeUse／issuedAt 不得在失敗重試路上被丟掉', () => {
  clearAiTicketsForTest();
  const id = issueAiTicket({ parsed: { bank: '合成一銀' }, aiModel: '', suspectRecipeIds: ['rcp-x'], recipeUse: { id: 'rcp-1', usedVersion: 'current', usedRecipe: goodRecipe() } });
  const t1 = redeemAiTicket(id);
  assert.ok(t1 && restoreAiTicket(id, t1), '前提：兌出再放回');
  const t2 = redeemAiTicket(id);
  assert.deepEqual(t2?.suspectRecipeIds, ['rcp-x'], '★放回後名單還在（丟了＝疑似過期永不標）');
  assert.equal(t2?.recipeUse?.id, 'rcp-1', '★放回後配方票身分還在（丟了＝配方票退化成 AI 票）');
  assert.ok(t2?.issuedAt, '★世代戳還在');
});

test('預審A4｜suspect 世代檢查：其後已自證的配方不被舊快照蓋回', () => {
  const mk = (/** @type {string=} */ lastUsedAt) => /** @type {any} */ ({ parseRecipes: [row(lastUsedAt ? { lastUsedAt } : {})] });
  const dbLate = mk('2026-08-16T02:00:00.000Z');
  markRecipesSuspect(dbLate, ['rcp-1'], '2026-08-16T01:00:00.000Z');   // 快照比自證早＝跳過
  assert.equal(dbLate.parseRecipes[0].suspect, false, '★期間成功套用過＝舊快照不可蓋回');
  const dbOld = mk('2026-08-16T00:30:00.000Z');
  markRecipesSuspect(dbOld, ['rcp-1'], '2026-08-16T01:00:00.000Z');
  assert.equal(dbOld.parseRecipes[0].suspect, true, '對照：沒有其後自證＝照標');
});

test('預審G3｜別張配方救場（直接路徑、無票）：失靈的那張照樣被標疑似過期', async () => {
  await seedDb({ recipes: [row({ id: 'rcp-broken', current: brokenRecipe() }), row({ id: 'rcp-good' })] });
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(res.ok, true);
  assert.equal(/** @type {any} */ (res).recipeId, 'rcp-good');
  const db = await getDb();
  const broken = (db.parseRecipes || []).find((x) => x.id === 'rcp-broken');
  const good = (db.parseRecipes || []).find((x) => x.id === 'rcp-good');
  assert.equal(broken?.suspect, true, '★中版面但失靈＝標疑似（不因別張救場而漏）');
  assert.equal(good?.suspect, false);
  assert.equal(good?.graduateStreak, 1);
});

test('預審B5｜「不開裸 GET」要有守門：crud 路由表沒有 GET /api/parseRecipes（對照組 dailyValues 有）', async () => {
  const { crudRoutes } = await import('../lib/routes/crud.js');
  const gets = /** @type {string[]} */ ([]);
  for (const layer of /** @type {any} */ (crudRoutes).stack) {
    if (layer?.route?.path && layer.route.methods?.get) gets.push(layer.route.path);
  }
  assert.ok(gets.includes('/api/dailyValues'), `對照組要在（路由表解析法沒壞）：${gets.join('，')}`);
  assert.ok(!gets.includes('/api/parseRecipes'), '★裸 GET 不可以長出來（skip 條件被拿掉＝這裡紅）');
});

// ---- Grok 合規掃描（#468）三發現的承重域 ----

test('GrokGH1｜previous 服役≠回滾：current 沒中版面（別的版面家族）＝不互換、不動畢業計數', async () => {
  // current＝別家版面（docAnchors 不同＝對 linesA 不中）；previous＝本版面好配方——P2-3 重生後的常態
  const otherLayout = () => { const r = goodRecipe(); r.docAnchors = ['別家帳戶總覽', '別家往來紀錄']; return r; };
  await seedDb({ recipes: [row({ current: otherLayout(), previous: goodRecipe(), graduateStreak: 5, graduated: true })] });
  const db = await getDb();
  const r = await recipeBankRoute('QUFBQQ==', undefined, db, { extract: extractA });
  assert.equal(r.hit?.usedVersion, 'previous');
  assert.equal(r.hit?.currentMatched, false, '★current 根本沒中版面');
  assert.deepEqual(r.gateFailedIds, [], '★previous 正常服役＝這列不是疑似過期候選');
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(res.ok, true);
  const after4 = await getDb();
  const r1 = after4.parseRecipes?.[0];
  assert.deepEqual(r1?.current?.docAnchors, ['別家帳戶總覽', '別家往來紀錄'], '★不互換（混月匯入不得讓兩版乒乓對倒）');
  assert.equal(r1?.graduateStreak, 5, '★current 的畢業計數不動（它對自己的版面可能好好的）');
  assert.equal(r1?.graduated, true);
  assert.ok(r1?.lastUsedAt, 'previous 服役有記使用時間');
});

test('GrokGH1b｜只有 previous 中版面且失靈＝這列不進疑似名單（previous 本來就是備胎）', async () => {
  const otherLayout = () => { const r = goodRecipe(); r.docAnchors = ['別家帳戶總覽', '別家往來紀錄']; return r; };
  await seedDb({ recipes: [
    row({ id: 'rcp-mixed', current: otherLayout(), previous: brokenRecipe() }),   // previous 中但拒解
    row({ id: 'rcp-good' }),
  ] });
  const res = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(res.ok, true);
  assert.equal(/** @type {any} */ (res).recipeId, 'rcp-good');
  const db = await getDb();
  assert.equal((db.parseRecipes || []).find((x) => x.id === 'rcp-mixed')?.suspect, false,
    '★current 沒中版面＝整列不得被打成疑似（那會冤枉健康的 current）');
});

test('GrokGH3｜無 id 的列不服役：對不到列的配方不可發票、不可記帳（備份牆也會濾）', async () => {
  const noId = /** @type {any} */ (row()); delete noId.id;
  await seedDb();
  const db = await getDb();
  db.parseRecipes = [noId];   // 記憶體內直塞（存檔會被必填牆濾掉——那正是第二段在驗的事）
  const r = await recipeBankRoute('QUFBQQ==', undefined, db, { extract: extractA });
  assert.equal(r.hit, null, '★沒有身分＝不服役（票/計數/疑似全對不到列）');
  // 備份牆：id 現在是必填＝殘缺列整筆濾除
  const db2 = /** @type {any} */ (await getDb());
  db2.parseRecipes = [noId, row()];
  const out = sanitizeDbForWrite(db2, { mode: 'strip' });
  assert.equal(out.parseRecipes.length, 1, '★缺 id＝濾除');
});

// ---- Codex r1 的承重域（票綁租戶／id 形狀與唯一） ----

test('r1#1｜票綁租戶：別的租戶兌不到、放不回、也驅逐不了我的票（HOSTED 多租戶可達後的硬條件）', async () => {
  const { runWithTenant } = await import('../lib/tenant.js');
  clearAiTicketsForTest();
  const id = runWithTenant({ userId: 'tenant-A' }, () => issueAiTicket({ parsed: { bank: 'A 的帳單' }, aiModel: '' }));
  // B 兌 A 的票＝查無（且不銷毀——B 不能幫 A 銷票）
  assert.equal(runWithTenant({ userId: 'tenant-B' }, () => redeemAiTicket(id)), null, '★跨租戶兌票＝查無');
  // B 發滿 5 張＝驅逐的是 B 自己的、A 的票還在
  runWithTenant({ userId: 'tenant-B' }, () => { for (let i = 0; i < 5; i++) issueAiTicket({ parsed: { i }, aiModel: '' }); });
  const tA = runWithTenant({ userId: 'tenant-A' }, () => redeemAiTicket(id));
  assert.equal(tA?.parsed?.bank, 'A 的帳單', '★容量按租戶各自計——B 發滿不可驅逐 A（跨租戶阻斷）');
  // 放回也核對：B 拿到 A 的票物件也放不回
  assert.equal(runWithTenant({ userId: 'tenant-B' }, () => restoreAiTicket(id, /** @type {any} */ (tA))), false, '★跨租戶放回＝拒');
  assert.equal(runWithTenant({ userId: 'tenant-A' }, () => restoreAiTicket(id, /** @type {any} */ (tA))), true, '對照：本人放回 OK');
  clearAiTicketsForTest();
});

test('r1#2｜id 形狀與唯一：數字 id 過不了牆；重複 id 後到濾除；記帳嚴格比較不吃隱式轉換', async () => {
  const db = /** @type {any} */ (await getDb());
  db.parseRecipes = [ /** @type {any} */ ({ ...row(), id: 7 }), row({ id: 'dup' }), row({ id: 'dup' }) ];
  const out = sanitizeDbForWrite(db, { mode: 'strip' });
  assert.equal(out.parseRecipes.length, 1, '★數字 id＝必填值格式不合法整筆濾除；重複 id＝後到濾除');
  assert.equal(out.parseRecipes[0].id, 'dup');
  // 嚴格比較：數字 id 7 的列不可被字串票 "7" 命中（記帳打錯人）
  const dbObj = /** @type {any} */ ({ parseRecipes: [{ ...row(), id: 7, graduateStreak: 0 }] });
  recordRecipeApplied(dbObj, { id: '7', usedVersion: 'current', currentMatched: true, usedRecipe: goodRecipe() });
  assert.equal(dbObj.parseRecipes[0].graduateStreak, 0, '★String() 隱式轉換的碰撞已封死');
});

test('r2｜/api/import 重複 id＝驗證階段 400＋零寫入（使用者壞備份不可被誤報成 500 伺服器錯）', async () => {
  await seedDb({ recipes: [row({ id: 'keep-me' })] });
  const { coreRoutes } = await import('../lib/routes/core.js');
  const express = (await import('express')).default;
  const app = express(); app.use(express.json({ limit: '50mb' })); app.use(coreRoutes);
  const http = await import('node:http');
  const srv = http.createServer(app); await new Promise((ok) => srv.listen(0, ok)); srv.unref();   // 考題結束不等它＝事件圈可收
  const port = /** @type {any} */ (srv.address()).port;
  const dup = { settings: {}, parseRecipes: [row({ id: 'dup' }), row({ id: 'dup' })] };   // 備份 JSON 需含 settings
  const res = await fetch(`http://127.0.0.1:${port}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dup) });
  assert.equal(res.status, 400, '★驗證階段就擋（櫃檯 throw tripwire 留給內部漏驗證）');
  const body = await res.json();
  assert.ok(String(body.error).includes('重複 id'), `錯誤要點名原因：${body.error}`);
  srv.close();
  const db = await getDb();
  assert.equal(db.parseRecipes?.length, 1, '★零寫入');
  assert.equal(db.parseRecipes?.[0]?.id, 'keep-me');
});
