// @ts-check
// 配方儲存與讀取接線（P2-2）的考題：認不得→先試配方（零元零外送、不需 useAi）→全敗才輪 AI；
// 版本回滾（裁示④細部＝current 紅退 previous、apply 成功自動互換）；畢業計數（裁示②＝連 5）；
// 疑似過期標記（配方中版面但閘紅→走 AI 匯入成功後經確認票標記）。
// 夾具＝P2-1 的合成版面 A（詞彙全虛構、帳號 900100/900200 前綴假值慣例）；隔離＝STORE_FILE 暫存檔。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-recipestore-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { previewBankStatement, applyBankStatement, recipeBankRoute, recordRecipeApplied, markRecipesSuspect, previewBankTxForDb } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { clearAiTicketsForTest, issueAiTicket, redeemAiTicket, restoreAiTicket } = await import('../lib/ai-confirm-ticket.js');
const { RECIPE_FORMAT_VERSION, recipeNorm, parseWithRecipe: parseWithRecipeDefault } = await import('../lib/parse-recipe.js');
const { squash } = await import('../lib/bank-statement.js');
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
  // ⚠️ 合計交叉驗證的狀態要**真的走到這條出口**（自審突變 M-recipe-drop-totals：把這條 return
  //    改成逐欄挑既有欄位就全綠——規則卡是唯一每次都 no-totals 的路線，而它的端到端題從不看這欄）。
  //    掉了它＝規則卡使用者的預覽窗只剩「✓ 驗算通過」，而徽章才剛指路說「跑了沒有寫在那一段」。
  assert.deepEqual(pv.reconcile.totalsCheck, { status: 'no-totals', fields: [] },
    '★配方路線不產合計欄＝畫面要照實說「這次沒有跑」');
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
  db.transactions = []; await saveDb(db);   // A6：重傳同份不計——清交易＝模擬同版面的「新一份」帳單
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

// ---- #523 r10：「哪一張規則卡獲勝」也是一種「是哪一個」 ----

/** 帳單多印一個**連字** `Oﬃce`（NFKC 後是 `Office`）。 */
const linesLig = () => { const ls = linesA(); ls[0] = L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [300, 'Oﬃce'], [452, '結算基準日:2026/06/30']]); return ls; };
const extractLig = async () => linesLig();
/** 兩張卡只差暗號的寫法：一張抄正規字（只有新尺命中）、一張抄帳單原文（舊尺就命中＝main 選它）。 */
const ligRecipe = (/** @type {string} */ anchor) => { const r = goodRecipe(); r.docAnchors = [anchor, '往來紀錄']; return r; };

test('recipeBankRoute｜兩趟掃描：舊尺先跑一遍，main 選哪張卡我們就選哪張（#523 r10）', async () => {
  // ⚠️ #523 讓版面比對收「舊尺或新尺」之後，候選卡變多 ⇒ 這裡「照列序取第一張成功的」會選到
  //   **main 選不到的卡**。實測後果：真台幣戶被標成外幣 ⇒ 那戶交易被當外幣**不匯入**＝現金流漏帳，
  //   而閘仍是 strong。⇒ 第一趟只用舊尺（逐字＝main），一張都沒中才跑第二趟、**那一趟只用新尺**
  //   （兩趟都不混尺——混用正是 r6–r11 五輪的病根）。
  await seedDb({ recipes: [
    row({ id: 'rcp-new', current: ligRecipe('Office') }),   // 只有新尺命中，且**排在前面**
    row({ id: 'rcp-old', current: ligRecipe('Oﬃce') }),     // 舊尺就命中＝main 的答案
  ] });
  const r = await recipeBankRoute('QUFBQQ==', undefined, await getDb(), { extract: extractLig });
  assert.ok(r.hit, '前提：這份帳單解得出來');
  assert.equal(r.hit?.recipeId, 'rcp-old',
    '★★卡片列序不可以改寫 main 的答案——只跑一趟的版本會選到排在前面的 rcp-new');
});

test('recipeBankRoute｜第二趟仍在：舊尺一張都沒中時，新尺認得的卡照樣服役（#523 r10）', async () => {
  await seedDb({ recipes: [row({ id: 'rcp-new', current: ligRecipe('Office') })] });
  const r = await recipeBankRoute('QUFBQQ==', undefined, await getDb(), { extract: extractLig });
  assert.equal(r.hit?.recipeId, 'rcp-new',
    '★兩趟不可以退化成「只跑舊尺」——那樣本支的主修就沒了');
});

test('recipeBankRoute｜勝出的那一列不可以留在疑似過期名單裡（#523 r11）', async () => {
  // 第一趟（舊尺）：current 中版面但拒解 ⇒ 這一列被標進失敗名單；previous 舊尺不中版面。
  // 第二趟（新尺）：previous 中版面且過閘 ⇒ **同一列**成為 winner。名單是跨趟共用的，
  // 不濾掉的話 apply 會把剛救回來的好版標成疑似過期、畢業計數歸零。
  const cur = brokenRecipe(); cur.docAnchors = ['Oﬃce', '往來紀錄'];      // 舊尺就中版面、但解不動
  const prev = goodRecipe(); prev.docAnchors = ['Office', '往來紀錄'];    // 只有新尺中版面、解得動
  await seedDb({ recipes: [row({ current: cur, previous: prev })] });
  const r = await recipeBankRoute('QUFBQQ==', undefined, await getDb(), { extract: extractLig });
  assert.equal(r.hit?.usedVersion, 'previous', '前提：第二趟用 previous 救回來');
  assert.ok(!r.gateFailedIds.includes('rcp-1'),
    '★★救回來的那一列不可以同時掛在疑似過期名單上（apply 會把好版標成失效、畢業歸零）');
});

/** 帳單把 `Z`、`A`、U+030A 拆在**相鄰三格**：舊尺看得到 `ZA`、新尺會合成成 `ZÅ` ⇒ 看不到 `ZA`。 */
const linesSplit = () => { const ls = linesA(); ls[0] = L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [300, 'Z'], [310, 'A'], [320, '\u030A'], [452, '結算基準日:2026/06/30']]); return ls; };
const extractSplit = async () => linesSplit();

test('recipeBankRoute｜current 曾中版面的事實要跨趟保留（否則壞版永遠升不掉，#523 r12）', async () => {
  // 第一趟（舊尺）：current 中版面但拒解。第二趟（新尺）：previous 救回來。
  // `currentMatched` 若放在趟裡，第二趟會把它重設成 false ⇒ apply 走「只是別版面服役」分支
  // ⇒ **壞的 current 永遠升不掉、last-known-good 永遠升不上去、也永遠無法重新畢業**。
  // ⚠️ 夾具必須是**真的只有舊尺中版面**（Codex #523 r13#2：我上一版用 `Oﬃce`／`Office`，
  //   新尺會把兩邊一起正規化成 `Office` ⇒ current 在第二趟又 match 了 ⇒ 把 Map 退化成每趟重置，
  //   這一題照樣全綠＝假護欄）。所以改用「跨格 `Z`＋`A`＋U+030A」：舊尺 `ZA`、新尺 `ZÅ`。
  const cur = brokenRecipe(); cur.docAnchors = ['ZA', '往來紀錄'];        // 只有舊尺中版面
  const prev = goodRecipe(); prev.docAnchors = ['ZÅ', '往來紀錄'];        // 只有新尺中版面
  const raw = linesSplit()[0].cells.map((/** @type {any} */ c) => c.s).join('');
  assert.equal(squash(raw).includes('ZA'), true, '★前提：舊尺看得到 ZA');
  assert.equal(recipeNorm(raw).includes('ZA'), false, '★前提：新尺看不到 ZA（合成成 ZÅ）');
  await seedDb({ recipes: [row({ current: cur, previous: prev })] });
  const r = await recipeBankRoute('QUFBQQ==', undefined, await getDb(), { extract: extractSplit });
  assert.equal(r.hit?.usedVersion, 'previous', '前提：第二趟用 previous 救回來');
  assert.equal(r.hit?.currentMatched, true,
    '★★current 在第一趟中過版面＝這是回滾語意（互換版本＋streak 重數），不是「別版面服役」');
});

test('已接受的界線｜新尺命中＝以卡代 AI（characterization；William 2026-08-29 裁示「甲」）：碰撞卡標錯幣別、強閘照樣 strong、真台幣交易被標 foreign', async () => {
  // ⚠️ 這題**照實描述一條已接受的取捨**，不是缺陷回歸題（Codex #523 r14 抓到、William 裁「甲」接受）：
  //   old 沒 hit 時 main 會退給 AI；新尺命中＝以卡代 AI ⇒ 若卡在別的版面出生、對這份帳單把某區
  //   標錯幣別，強閘因「外幣列不受驗」的既有盲區仍回 strong ⇒ 那一區的真台幣交易被當外幣不匯入。
  //   **同一條鏈對舊尺命中的卡在 main 上同樣存在**（下半題移植實測）＝P2「以卡代 AI」的固有取捨，
  //   圍欄同一套（出生三關／防撞名／強閘／疑似過期／預覽確認）。若未來加了新圍欄讓這題轉紅，
  //   請照新行為改寫這題，不要為了綠燈保留舊行為。
  const collide = (/** @type {string} */ anchor) => { const r = goodRecipe();
    r.docAnchors = [anchor, '往來紀錄'];
    r.summary.sections = [{ anchor: '合成帳戶總覽', currency: 'TWD' }, { anchor: '次要帳戶清單', currency: 'USD' }];
    return r; };
  const mislabeledLines = (/** @type {string} */ printed) => [
    L(300, [[20, '合成銀行月結單'], [30, printed], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$730']]),
    L(270, [[47, '總計'], [445, '$730']]),
    L(260, [[47, '次要帳戶清單區']]),          // ★這一區其實也是台幣，卡卻宣告 USD（碰撞）
    L(250, [[50, '乙種活存'], [150, '900200****3302'], [453, '$97,400']]),
    L(240, [[47, '總計'], [445, '$97,400']]),
    L(140, [[47, '往來紀錄明細']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$730']]),
    L(66, [[53, 0, '900200****3302'], [124, 0, '2026/06/02'], [180, 0, '合成入帳'], [349, 40, '$2,400'], [414, 0, '$97,400']]),
  ];
  // 上半：new-only（帳單印連字 `Oﬃce`、卡上是正規字 `Office`）＝main 在這份帳單會退 AI
  await seedDb({ recipes: [row({ current: collide('Office') })] });
  const db = await getDb();
  const r = await recipeBankRoute('QUFBQQ==', undefined, db, { extract: async () => mislabeledLines('Oﬃce') });
  assert.ok(r.hit, '前提：新尺命中、整份解得動');
  assert.equal(r.hit?.parsed.accountCurrency['900200****3302'], 'USD', '★碰撞卡把真台幣區標成 USD');
  assert.equal(r.hit?.reconcile.level, 'strong', '★強閘照樣 strong（外幣列不受驗＝既有盲區）');
  const { rows: rows2 } = previewBankTxForDb(db, r.hit?.parsed);
  const hitRow = rows2.find((/** @type {any} */ x) => x.amount === 2400);
  assert.equal(hitRow?.foreign, true, '★★那筆 2,400 的真台幣收入被標 foreign＝正式匯入會略過（這就是被接受的代價）');
  // 下半（移植實測）：同一張碰撞卡改成**同形印法** ⇒ main 的舊尺（＝預設）就命中、同樣標錯
  //   ＝證明這條鏈不是本支新造，而是 P2 以卡代 AI 的固有取捨。
  const pOld = parseWithRecipeDefault(mislabeledLines('Office'), collide('Office'));
  assert.equal(pOld.accountCurrency['900200****3302'], 'USD',
    '★同形版在預設（舊尺＝main 語意）下同樣標錯——風險類別是既有的，本支只是把暴露面延伸到相容字帳單');
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

test('A6 操作定義（P2-3 明文）｜同一份帳單重傳＝imported 0＝不算一份：streak 不動、只記使用時間', async () => {
  await seedDb({ recipes: [row({ graduateStreak: 2 })] });
  const r1 = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(r1.ok, true);
  let db = await getDb();
  assert.equal(db.parseRecipes?.[0]?.graduateStreak, 3, '第一次真的匯入＝+1');
  const r2 = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(r2.ok, true);
  assert.equal(/** @type {any} */ (r2).transactions?.imported, 0, '前提：同一份重傳＝全被去重跳過');
  db = await getDb();
  assert.equal(db.parseRecipes?.[0]?.graduateStreak, 3, '★重複上傳不是新版面證據——streak 不可灌水（重傳 5 次≠畢業）');
  assert.ok(db.parseRecipes?.[0]?.lastUsedAt, '使用時間照記');
});

test('recipeBankRoute｜三路一致（A4）：命中＝stage sink 收到 verify 恰一次（多張卡逐一試也不跳針）、且在結論之前；沒命中＝不報 verify（沒驗算成就不說驗算了）', async () => {
  const { STAGES } = await import('../lib/progress-stages.js');
  await seedDb({ recipes: [row({ current: brokenRecipe(), previous: goodRecipe() }), row({ id: 'rcp-2', current: goodRecipe() })] });
  const db = await getDb();
  /** @type {string[]} */ const stages = [];
  const r = await recipeBankRoute('QUFBQQ==', undefined, db, { extract: extractA, stage: (s) => stages.push(s) });
  assert.ok(r.hit, '前提：命中');
  assert.deepEqual(stages, [STAGES.VERIFY], `★恰一次（實得 ${JSON.stringify(stages)}）`);
  /** @type {string[]} */ const stages2 = [];
  const db2 = await getDb();
  db2.parseRecipes = [];
  const r2 = await recipeBankRoute('QUFBQQ==', undefined, db2, { extract: extractA, stage: (s) => stages2.push(s) });
  assert.equal(r2.hit, null);
  assert.deepEqual(stages2, [], '★沒進閘＝不報');
  // 兩張卡都進閘、都被弱閘擋（明細無餘額格）＝驗算真的各跑了一次，但**只報一次**（跳針＝進度列來回閃）
  const weakLines = linesA().map((l) => ({ ...l, cells: l.cells.filter((c) => !['$1,730', '$730', '$97,400'].includes(c.s) || l.y > 110) }));
  await seedDb({ recipes: [row(), row({ id: 'rcp-2' })] });
  const db3 = await getDb();
  /** @type {string[]} */ const stages3 = [];
  const r3 = await recipeBankRoute('QUFBQQ==', undefined, db3, { extract: async () => weakLines, stage: (s) => stages3.push(s) });
  assert.equal(r3.hit, null, '前提：兩張都閘紅');
  assert.equal(r3.gateFailedIds.length, 2, `前提：兩張都進了閘（實得 ${JSON.stringify(r3.gateFailedIds)}）`);
  assert.deepEqual(stages3, [STAGES.VERIFY], '★恰一次、不跳針');
  // 前卡 parse 失敗（brokenRecipe＝根本沒進閘）、後卡命中＝仍恰一次（Codex #512 r1#2 矩陣）
  await seedDb({ recipes: [row({ current: brokenRecipe() }), row({ id: 'rcp-2', current: goodRecipe() })] });
  const db4 = await getDb();
  /** @type {string[]} */ const stages4 = [];
  const r4 = await recipeBankRoute('QUFBQQ==', undefined, db4, { extract: extractA, stage: (s) => stages4.push(s) });
  assert.equal(r4.hit?.recipeId, 'rcp-2', '前提：前卡失敗、後卡命中');
  assert.deepEqual(stages4, [STAGES.VERIFY], '★恰一次');
  // 有卡但**全部 parse 失敗**（沒有任何一張進到閘）＝不報 verify——把 stageVerify 移到 parse 之前就會在這裡謊報
  await seedDb({ recipes: [row({ current: brokenRecipe() })] });
  const db5 = await getDb();
  /** @type {string[]} */ const stages5 = [];
  const r5 = await recipeBankRoute('QUFBQQ==', undefined, db5, { extract: extractA, stage: (s) => stages5.push(s) });
  assert.equal(r5.hit, null);
  assert.deepEqual(r5.gateFailedIds, ['rcp-1'], '前提：中版面但解不動（疑似過期候選）');
  assert.deepEqual(stages5, [], '★沒進閘＝一個字都不報');
});

test('★recipe 命中路的 frame 行為保證（Codex #512 r1#1：字面掃描擋不住別名——行為面直接驗）：整條 preview 收到的每一格都是合法 stageFrame、verify 在 build_preview 之前、不回聲帳單內容', async () => {
  const { STAGES } = await import('../lib/progress-stages.js');
  await seedDb({ recipes: [row()] });
  /** @type {any[]} */ const frames = [];
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA, onStage: (f) => frames.push(f) });
  assert.equal(/** @type {any} */ (pv).engine, 'recipe', '前提：配方命中');
  assert.ok(frames.length > 0, '要有進度');
  const { stageFrame } = await import('../lib/progress-stages.js');
  for (const f of frames) {
    assert.deepEqual(f, stageFrame(f.s, { model: f.model }), `★逐格對 stageFrame 標準輸出（多餘欄位／不合白名單的 model 都現形）：${JSON.stringify(f)}`);
    assert.doesNotMatch(JSON.stringify(f), /900100|3301|730|97,?400|合成銀行月結單/, '★不回聲帳單內容');
  }
  const codes = frames.map((f) => f.s);
  assert.ok(codes.indexOf(STAGES.VERIFY) > -1 && codes.indexOf(STAGES.VERIFY) < codes.indexOf(STAGES.BUILD_PREVIEW), `★verify 在 build_preview 之前（實得 ${JSON.stringify(codes)}）`);
  assert.equal(codes.filter((c) => c === STAGES.VERIFY).length, 1, '★恰一次');
});

// ---- 規則卡管理面板（解析器優化 B1，2026-08-25）----
test('管理｜listParseRecipes 只給身分與統計投影：配方內容（版面字面）一個字不外送；空庫＝空陣列', async () => {
  const { listParseRecipes } = await import('../lib/services/bank-import.js');
  await seedDb({ recipes: [row({ previous: goodRecipe(), graduateStreak: 3, lastUsedAt: '2026-08-20T01:02:03.000Z', suspect: true, rebirths: 2 })] });
  const list = await listParseRecipes();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['bank', 'createdAt', 'graduateStreak', 'graduated', 'hasPrevious', 'id', 'lastUsedAt', 'rebirths', 'suspect', 'updatedAt'].sort(), '★欄位封閉（多一欄＝多外送一分）');
  assert.equal(list[0].bank, '合成銀行');
  assert.equal(list[0].graduateStreak, 3);
  assert.equal(list[0].suspect, true);
  assert.equal(list[0].hasPrevious, true);
  const blob = JSON.stringify(list);
  for (const literal of ['存進金額', '提領金額', '結存餘額', '合成帳戶總覽', '結算基準日', 'docAnchors', 'headerIn']) {
    assert.ok(!blob.includes(literal), `★配方內容不外送：${literal}`);
  }
  const db2 = await getDb(); db2.parseRecipes = []; await saveDb(db2);
  assert.deepEqual(await listParseRecipes(), []);
});

test('管理｜deleteParseRecipe：刪指定那張（嚴格比較 id）、其餘不動；刪掉後同版面重新走 AI；錯 id＝404、缺 id＝400、零改動', async () => {
  const { listParseRecipes, deleteParseRecipe } = await import('../lib/services/bank-import.js');
  await seedDb({ recipes: [row(), row({ id: 'rcp-2', bank: '別家銀行', current: { ...goodRecipe(), docAnchors: ['不會命中的錨點', '第二錨'] } })] });
  await assert.rejects(() => deleteParseRecipe(''), (/** @type {any} */ e) => e.status === 400);
  await assert.rejects(() => deleteParseRecipe('rcp-999'), (/** @type {any} */ e) => e.status === 404 && /找不到這張規則卡/.test(e.message));
  assert.equal((await listParseRecipes()).length, 2, '錯 id／缺 id＝零改動');
  await deleteParseRecipe('rcp-2');   // 刪第二張（不是陣列頭）＝「亂刪第一張」的壞法分得出來
  assert.deepEqual((await listParseRecipes()).map((r) => r.id), ['rcp-1'], '★只刪指定那張、其餘不動');
  await seedDb({ recipes: [row(), row({ id: 'rcp-2', bank: '別家銀行', current: { ...goodRecipe(), docAnchors: ['不會命中的錨點', '第二錨'] } })] });
  await deleteParseRecipe('rcp-1');
  const left = await listParseRecipes();
  assert.deepEqual(left.map((r) => r.id), ['rcp-2'], '★刪第一張也對');
  // 刪掉之後：同版面（rcp-1 的錨點）沒有卡可用＝recipeBankRoute 不命中（下次會走 AI；rcp-2 錨點不同、命不中這份）
  const db = await getDb();
  const r = await recipeBankRoute('QUFBQQ==', undefined, db, { extract: extractA });
  assert.equal(r.hit, null, '★刪掉＝這個版面回到沒有規則卡的狀態');
});

test('管理｜畢業計數有讀端：套用一份成功匯入的帳單後，list 的 graduateStreak 前進、lastUsedAt 有值（計數不是只寫進 db 的黑盒）', async () => {
  const { listParseRecipes } = await import('../lib/services/bank-import.js');
  await seedDb({ recipes: [row()] });
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA });
  assert.equal(/** @type {any} */ (pv).engine, 'recipe', '前提：配方命中');
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { aiExtract: extractA, aiTicket: /** @type {any} */ (pv).aiTicket });
  const list = await listParseRecipes();
  assert.equal(list[0].graduateStreak, 1, `★套用（真的匯入）＝畢業累積 +1（實得 ${JSON.stringify(list[0])}）`);
  assert.ok(list[0].lastUsedAt, '★最後使用時間有值');
});

test('管理｜設定頁接線與文案（去註解形狀釘——settings.js 是頁面模組載不進 node；服務層行為另有專卷）', () => {
  const src = readFileSync(new URL('../public/modules/settings.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  assert.match(src, /manageParseRecipesBtn/, '管理鈕在規則卡卡片裡');
  assert.match(src, /api\('\/parse-recipes'\)/, '接 GET');
  assert.match(src, /createRecipeManager/, '接管理核心（端點路徑／序列化／confirm 接線都住在 parse-recipes-ui）');
  const fn = (src.split('function openParseRecipesManager')[1] || '').split('\nfunction ')[0];   // 只掃這一支函式（掃到下一支＝別支的 confirm 也算數＝假綠）
  assert.match(fn, /畢業（穩定）/, '★畢業進度在畫面上讀得到');
  assert.match(fn, /學習中 \$\{.*\}\/5/, '學習中 n/5');
  assert.match(fn, /疑似過期/, 'suspect 狀態');
  assert.match(fn, /不影響.*已匯入的交易|不影響<\/b>已匯入的交易/, '★刪除語意就地講清楚（窗內說明）');
  assert.match(fn, /createRecipeManager\(/, '★刪除走管理核心（confirm／序列化語意的行為卷在 parse-recipes-ui 專題）');
  assert.match(fn, /mgr\.bindDeleteButtons\(/, '★刪除鈕綁定也走核心（r8#1：綁定寫在 settings＝「按了沒反應」測不到）');
  assert.match(fn, /win:\s*window/, '★confirm 接線只傳 window——「按取消照樣刪」的壞法（r7#2）住在純模組、由行為卷承重');
  assert.ok(!/confirm:/.test(fn), '★settings 不得自帶 confirm 接線（自帶＝繞過核心的承重卷）');
  assert.match(fn, /\$\{esc\(r\.bank/, '★銀行名經 esc 才插入（XSS 鐵則）');
  assert.ok(!/\$\{r\.bank/.test(fn), '★不得有未跳脫的 r.bank 插入');
  assert.match(fn, /\$\{esc\(r\.id\)\}/, '★data-del 的 id 也經 esc');
  assert.match(fn, /watchModal:\s*watchModalRoot/, '★接真的 watchModalRoot（接 () => () => true＝r6#1 的復活窗回來）');
  for (const banned of ['只存這台電腦', '永不上傳', '已限速', '保證正確', '免費']) {
    assert.ok(!fn.includes(banned), `★文案鐵則：${banned}`);
  }
});


test('管理｜刪除流程行為卷（parse-recipes-ui 純模組）：取消＝零 API 呼叫；確認＝恰一次、成功才更新畫面；失敗＝報錯不更新；等回應期間失去彈窗＝零 UI 接續', async () => {
  const { deleteRecipeFlow, recipeDeleteConfirmText } = await import('../public/modules/parse-recipes-ui.js');
  assert.match(recipeDeleteConfirmText('合成銀行'), /再花一次 AI 費用/);
  assert.match(recipeDeleteConfirmText(''), /「這張」/);
  /** @type {any[]} */ const calls = []; /** @type {string[]} */ const gone = []; /** @type {string[]} */ const toasts = []; /** @type {string[]} */ const asked = [];
  // 彈窗世代模擬（app.js watchModalRoot 的語意）：watchModal() 拍當下世代的快照，別人接管＝世代 +1。
  // lose=true＝api 等待期間有人接管（使用者關窗/開別窗）——⚠️ 快照必須在發請求**前**拍，
  // 改成回應後才拍的壞法在這裡看到的是新世代、會照樣重畫（r6#1 的復活窗）＝這卷紅。
  let gen = 1;
  const deps = (/** @type {boolean} */ yes, /** @type {boolean} */ fail = false, /** @type {boolean} */ lose = false) => ({
    id: 'rcp-1', bank: '合成銀行',
    confirm: (/** @type {string} */ msg) => { asked.push(msg); return yes; },
    api: async (/** @type {string} */ p, /** @type {any} */ o) => { calls.push([p, o?.method, o?.body?.id]); if (lose) gen++; if (fail) throw new Error('合成失敗'); },
    toast: (/** @type {string} */ m) => toasts.push(m),
    onDeleted: (/** @type {string} */ id) => gone.push(id),
    watchModal: () => { const g = gen; return () => g === gen; },
  });
  assert.equal(await deleteRecipeFlow(deps(false)), false);
  assert.deepEqual(calls, [], '★取消＝零 API 呼叫（呼叫 confirm 卻忽略結果的壞法在這裡紅）');
  assert.deepEqual(asked, [recipeDeleteConfirmText('合成銀行')], '★確認窗收到的就是那句完整警告（Codex #513 r5#1：流程改問「確定刪除？」＝代價與範圍從真正的窗消失）');
  assert.deepEqual(gone, []);
  assert.equal(await deleteRecipeFlow(deps(true)), true);
  assert.deepEqual(calls, [['/parse-recipes/delete', 'POST', 'rcp-1']], '★確認＝恰一次、帶對 id');
  assert.deepEqual(gone, ['rcp-1'], '成功才更新畫面');
  calls.length = 0; gone.length = 0;
  assert.equal(await deleteRecipeFlow(deps(true, true)), false);
  assert.deepEqual(gone, [], '★失敗＝不更新畫面');
  assert.ok(toasts.some((m) => /刪除失敗/.test(m)));
  calls.length = 0; gone.length = 0; toasts.length = 0;
  assert.equal(await deleteRecipeFlow(deps(true, false, true)), true, '刪除在後端已完成＝回傳照實');
  assert.deepEqual(calls, [['/parse-recipes/delete', 'POST', 'rcp-1']], 'API 照打（失去的是畫面、不是刪除）');
  assert.deepEqual(gone, [], '★等回應期間失去彈窗＝不重畫（重畫會復活已關的管理窗、蓋掉後開彈窗——Codex #513 r6#1）');
  assert.deepEqual(toasts, [], '★連 toast 都不接續（零 UI continuation）');
  calls.length = 0;
  assert.equal(await deleteRecipeFlow(deps(true, true, true)), false);
  assert.deepEqual(toasts, [], '★失敗路同款：失去彈窗＝連報錯 toast 都不出');
});

test('管理｜管理核心行為卷（createRecipeManager）：confirm 回傳值承重；在途序列化；rows 單一住所', async () => {
  const { createRecipeManager } = await import('../public/modules/parse-recipes-ui.js');
  const make = () => {
    /** @type {any[]} */ const apiCalls = []; /** @type {string[]} */ const asked = []; /** @type {any[][]} */ const paints = [];
    /** @type {Array<{resolve: () => void, reject: (e: any) => void}>} */ const pending = [];
    let answer = true;
    const mgr = createRecipeManager({
      rows: [{ id: 'a', bank: '甲銀行' }, { id: 'b', bank: '乙銀行' }],
      win: { confirm: (/** @type {string} */ m) => { asked.push(m); return answer; } },
      api: (/** @type {string} */ p, /** @type {any} */ o) => { apiCalls.push([p, o?.body?.id]); return new Promise((resolve, reject) => pending.push({ resolve: () => resolve(undefined), reject })); },
      toast: () => {},
      watchModal: () => () => true,
      onRows: (/** @type {any[]} */ rows) => paints.push(rows.map((r) => r.id)),
    });
    return { mgr, apiCalls, asked, paints, pending, setAnswer: (/** @type {boolean} */ v) => { answer = v; } };
  };
  // ⚠️ 每個「期望立即回來」的 await 都包一秒競速（codex-exec 教訓的同款）：合成 api 回的是
  //   永不 settle 的 deferred，突變版（confirm 不看結果／拔序列化鎖）會真的去 await 它＝考題吊死
  //   而不是快紅——2026-08-26 實際吊死過兩顆 node 程序才補這一層。
  const fast = (/** @type {Promise<any>} */ pr) => Promise.race([pr, new Promise((r) => setTimeout(() => r('hung'), 1000))]);
  // ① confirm 接線承重（r7#2）：使用者按「取消」＝零 API——核心把 win.confirm(m) 的回傳值當真，
  //   「呼叫了 confirm、不看結果、照樣刪」的接線壞法在這裡紅（settings 只傳 window，壞不出這一味）。
  const t1 = make();
  t1.setAnswer(false);
  assert.equal(await fast(t1.mgr.del('a')), false, '★按取消＝立刻回 false（hung＝壞版真的去打了 API）');
  assert.equal(t1.asked.length, 1, 'confirm 有問');
  assert.deepEqual(t1.apiCalls, [], '★按取消＝零 API（confirm 回傳值必須承重）');
  // ② 在途序列化（r7#1）：第一刀 API 在途時再點第二刀＝整個不動（不問 confirm、零 API、回 false）——
  //   不鎖的話：第一刀回應重畫（新世代）、第二刀失去擁有權跳過重畫＝後端兩張都刪了、畫面殘留一張。
  const t2 = make();
  const p1 = t2.mgr.del('a');
  assert.equal(t2.mgr.busy(), true);
  assert.equal(await fast(t2.mgr.del('b')), false, '★在途＝第二刀不動（hung＝沒鎖、真的去等第二個 API）');
  assert.equal(t2.asked.length, 1, '★第二刀連 confirm 都不問');
  assert.deepEqual(t2.apiCalls, [['/parse-recipes/delete', 'a']], '★第二刀零 API');
  t2.pending[0].resolve();
  assert.equal(await p1, true);
  // ③ rows 單一住所：成功刪除＝核心的新 rows 重畫；解鎖後第二張刪得動、畫面收斂到空
  assert.deepEqual(t2.paints, [['b']], '刪 a 之後畫面只剩 b');
  assert.equal(t2.mgr.busy(), false, '完成＝解鎖');
  const p2 = t2.mgr.del('b');
  t2.pending[1].resolve();
  assert.equal(await p2, true);
  assert.deepEqual(t2.paints, [['b'], []], '解鎖後第二刀刪得動、rows 收斂到空（閉包舊 rows 的壞法在這裡紅）');
  assert.deepEqual(t2.mgr.rows(), []);
  // ④ 失敗也解鎖：API 炸掉之後還能再刪（busy 卡死＝管理窗從此壞掉）
  const t3 = make();
  const p3 = t3.mgr.del('a');
  t3.pending[0].reject(new Error('合成失敗'));
  assert.equal(await p3, false);
  assert.equal(t3.mgr.busy(), false, '★失敗＝照樣解鎖');
  // ⑤ 不存在的 id＝不問不打
  assert.equal(await fast(t3.mgr.del('nope')), false);
  assert.equal(t3.asked.length, 1, '不存在的 id 不問 confirm');
  // ⑥ 鈕綁定承重（r8#1）：假鈕過 bindDeleteButtons，點下去要真的走到 confirm／API——
  //   「綁了 onclick 卻不呼叫 del」的突變（按鈕全死）在這裡紅。
  const t4 = make();
  /** @type {any[]} */ const btns = [{ dataset: { del: 'a' } }, { dataset: { del: 'b' } }, { dataset: {} }];
  t4.mgr.bindDeleteButtons(btns);
  t4.setAnswer(false);
  assert.equal(await fast(btns[0].onclick()), false, '★點鈕真的走進 del（hung/undefined＝onclick 沒接 del）');
  assert.equal(t4.asked.length, 1, '★點鈕有問 confirm（鈕全死的壞法在這裡紅）');
  assert.match(t4.asked[0], /甲銀行/, '★問的是這顆鈕那張卡');
  t4.setAnswer(true);
  const pDel = btns[1].onclick();
  assert.deepEqual(t4.apiCalls, [['/parse-recipes/delete', 'b']], '★id 從 data-del 讀對、打對 API');
  t4.pending[0].resolve();
  assert.equal(await pDel, true);
  assert.equal(await fast(btns[2].onclick()), false, '沒 data-del 的鈕＝空 id＝不動');
  assert.equal(t4.asked.length, 2, '空 id 不問 confirm');
});
