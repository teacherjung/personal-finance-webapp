// @ts-check
// 外幣綜合帳戶（同一個遮罩帳號掛多種幣別）＝**批一：歧義哨兵**。
//
// 病根（2026-08-26 用 William 的真帳單證實，三份跨三個月 100% 重現）：`masked → currency` 是一對一，
// 裝不下同號多幣別，三條解析路都寫 last-wins。AI 路線因此在驗收的「幣別一致」牆上必然打架
// ⇒ `accounts[N] 幣別與 accountCurrencies 矛盾` ⇒ **整份拒收**，且與模型用力程度無關
// （medium／high／xhigh 三段實測結果完全相同＝不是讀不懂，是我們表達不了）。
//
// 本卷守四件事：
//   ①**多幣別不再整份拒收**（AI 路線讀得進來）
//   ②**表填哨兵、與登記順序無關**（last-wins 是順序相依的：兩個模型把兩列順序寫反＝雙讀硬差異
//     ⇒ 隨機仲裁／隨機拒收；換句話說天真的放寬會把「必然拒收」換成「隨機拒收＋白燒一發」）
//   ③**三條路同一份判準**（模板／配方／AI）——只改一處的話，配方出生第三關 `recipeReproduces`
//     逐鍵比幣別永遠不吻合 ⇒ 配方**永遠孵不出來、同版面每期付全額 AI 錢**（沒有任何**既有**考題會抓到，
//     本卷就是為此存在）
//   ④**兩道舊護欄一格沒放鬆**：沒列過的幣別仍拒（r2#1）、交易帳號不在表裡仍拒（r3#1＝防查無幣別
//     fallback 成 TWD 靜靜入帳，當年實測 imported:5）
// ⚠️ 誠實劃界：本批**不讓外幣入帳**（那是批三，要先有匯率口徑）。明細列上沒有幣別欄，所以多幣別
//    帳號的每一筆交易仍判不出自己是哪一幣＝一律「分不出」不入帳；逐筆幣別是批二。
// ⚠️ **隔離資料庫（鐵則 1）**：本卷有題會走 previewBankStatement，而它 getDb()——沒隔離的話會在
//    執行目錄開/建 data/store.db，還會 backupOnce 覆蓋 store.db.bak。靜態 import 會被提升到設定
//    環境變數之前，所以一律用動態 import。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-multicur-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;
after(() => { for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

const { parseBankSummary, makeCurrencyTable, UNKNOWN_CURRENCY, MIXED_CURRENCY_MSG } = await import('../lib/bank-statement.js');
const { parseWithRecipe, recipeReproduces, RECIPE_FORMAT_VERSION } = await import('../lib/parse-recipe.js');
const { normalizeAiBank, aiAnswersAgree } = await import('../lib/ai-parse.js');
const { previewBankTxForDb, importBankTxToDb, assertBankReconciled, previewBankStatement } = await import('../lib/services/bank-import.js');

const L = (/** @type {number} */ y, /** @type {any[]} */ pairs) => ({ y, cells: pairs.map((p) => (p.length === 3 ? { x: p[0], w: p[1], s: p[2] } : { x: p[0], s: p[1] })) });
const MULTI = '900300****363';   // 合成：同一個遮罩帳號同時掛 JPY 與 USD（真帳單就是這個形狀）
const SOLO = '900100****3301';

// ---- 登記器（三條路的單一實作）----

const tableOf = (/** @type {[string,string][]} */ pairs) => { const t = makeCurrencyTable(); for (const [m, c] of pairs) t.note(m, c); return t; };

test('幣別表｜同號多幣別＝哨兵，且與登記順序無關；同幣別重複不受影響；哨兵黏著', () => {
  const a = tableOf([[MULTI, 'JPY'], [MULTI, 'USD']]);
  const b = tableOf([[MULTI, 'USD'], [MULTI, 'JPY']]);
  assert.equal(a.map[MULTI], UNKNOWN_CURRENCY);
  assert.deepEqual(a.map, b.map, '★兩種順序得到完全相同的表（last-wins 在這裡會一份 JPY 一份 USD＝雙讀硬差異）');
  assert.equal(tableOf([[SOLO, 'TWD'], [SOLO, 'TWD']]).map[SOLO], 'TWD', '同幣別重複＝照舊');
  assert.equal(tableOf([[MULTI, 'JPY'], [MULTI, 'USD'], [MULTI, 'JPY']]).map[MULTI], UNKNOWN_CURRENCY, '★哨兵黏著（第三次登記救不回來＝又在猜）');
});

test('幣別表｜混台外幣的判定用**正規形**分組：不同遮罩印法不得繞過（Codex #517 r2#2 實測可繞）', () => {
  assert.equal(tableOf([[MULTI, 'JPY'], [MULTI, 'USD']]).hasMixedTwd(), false, '純外幣同號＝不是混台外幣');
  assert.equal(tableOf([[MULTI, 'TWD'], [MULTI, 'USD']]).hasMixedTwd(), true, '同一個字串的混台外幣');
  assert.equal(tableOf([['900300****0363', 'TWD'], ['900300-****-0363', 'USD']]).hasMixedTwd(), true,
    '★分隔符不是資訊（用原字串分組會被繞過：實測兩筆都被當 TWD、foreign=0、閘仍 strong）');
  assert.equal(tableOf([['900300****0363', 'TWD'], ['900300*****0363', 'USD']]).hasMixedTwd(), true,
    '★**星號數也不是資訊**（r3#1：只剝分隔符仍被繞過——實測 imported=2、db 真的多兩筆台幣交易）');
  assert.equal(tableOf([['900300****0363', 'TWD'], ['9003 00＊＊＊＊0363', 'USD']]).hasMixedTwd(), true,
    '★全形星號＋空白也是同一個帳號');
  assert.equal(tableOf([[SOLO, 'TWD'], [MULTI, 'USD']]).hasMixedTwd(), false, '不同帳號各自單一幣別＝不是混');
  assert.equal(tableOf([['90030012340363', 'TWD'], ['900300****0363', 'USD']]).hasMixedTwd(), true,
    '★**完整號 vs 遮罩**也是同一個帳號（r5#1：字串正規化後不相等，但完整號 ∈ 遮罩的語言——實測繞過後 imported=2、db 真的多兩筆台幣交易）');
  assert.equal(tableOf([['900999****1111', 'TWD'], ['900300****0363', 'USD']]).hasMixedTwd(), false,
    '★語言沒有交集＝不同帳號（判準是保守的「有交集就算同一個」，不是「長得像就算」）');
});

test('幣別表｜map 是 null-prototype（AGENTS 鐵則：使用者文字當鍵的 map 沒有例外）——`__proto__` 不得靜默缺鍵', () => {
  const t = tableOf([['__proto__', 'TWD'], ['__proto__', 'USD']]);
  assert.equal(Object.getPrototypeOf(t.map), null, '★null-proto');
  assert.equal(t.map['__proto__'], UNKNOWN_CURRENCY, '★字面 {} 的話這個鍵會靜默不落地（成員表有資料、map 卻缺鍵）');
  assert.ok(Object.hasOwn(t.map, '__proto__'), '★真的是自有鍵');
  assert.equal(tableOf([['constructor', 'JPY']]).map['constructor'], 'JPY', 'constructor 同款（原型成員不得誤命中）');
});

// ---- 三條路 ----

/** 模板版面：台幣一戶＋外幣區同一個帳號掛 JPY 與 USD 兩列 */
const templateLines = () => [
  L(300, [[47, '新臺幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
  L(290, [[78, '帳號類別'], [163, '帳戶號碼'], [433, '帳戶餘額'], [509, '備註']]),
  L(280, [[50, '新臺幣活存'], [150, SOLO], [473, '$1,730']]),
  L(270, [[47, '合計'], [445, '$1,730']]),
  L(260, [[47, '外幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
  L(250, [[367, 'JPY']]),
  L(240, [[56, '外幣活存'], [108, MULTI], [436, '$700'], [491, '$150']]),
  L(230, [[366, 'USD']]),
  L(220, [[56, '外幣活存'], [108, MULTI], [436, '$500'], [491, '$15,900']]),
  L(210, [[47, '合計'], [490, '0']]),
];

/** 配方版面：同一份帳單的配方路線版（外幣區走 BY-CODE＝幣別由小標帶入） */
const recipeLines = () => [
  L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
  L(280, [[50, '甲種活存'], [150, SOLO], [473, '$1,730']]),
  L(270, [[47, '總計'], [445, '$1,730']]),
  L(260, [[47, '外幣總覽區']]),
  L(250, [[367, 'JPY']]),
  L(240, [[56, '外幣活儲'], [108, MULTI], [436, '$700'], [491, '$150']]),
  L(230, [[366, 'USD']]),
  L(220, [[56, '外幣活儲'], [108, MULTI], [436, '$500'], [491, '$15,900']]),
  L(210, [[47, '總計'], [490, '0']]),
  L(140, [[47, '往來紀錄明細']]),
  L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
  L(100, [[53, 0, SOLO], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730']]),
];
const recipe = () => ({
  formatVersion: RECIPE_FORMAT_VERSION, bank: '合成銀行',
  docAnchors: ['合成帳戶總覽', '往來紀錄'], dateFormat: 'west-slash',
  refDate: { strategy: 'anchored-date', anchor: '結算基準日' },
  summary: { sections: [{ anchor: '合成帳戶總覽', currency: 'TWD' }, { anchor: '外幣總覽', currency: 'BY-CODE' }], endAnchor: '總計', balancePick: 'dollar-tagged' },
  detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: '附記', headerIgnore: ['單號'] },
});

/** AI 答案卷：同一份帳單的 AI 版（幣別表把 MULTI 列兩次＝提示詞規則 6「概要區每一個帳戶」的誠實產出） */
const aiAnswer = (/** @type {boolean} */ swap = false, /** @type {boolean} */ withMultiTx = false) => {
  const fx = [{ masked: MULTI, currency: 'JPY' }, { masked: MULTI, currency: 'USD' }];
  return {
    bank: '合成銀行', referenceDate: '2026-06-30',
    accountCurrencies: [{ masked: SOLO, currency: 'TWD' }, ...(swap ? fx.slice().reverse() : fx)],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [
      // 標籤／備註刻意對齊配方版面的字面——出生第三關 recipeReproduces 是**逐欄**比對，
      // 這裡不對齊就會在 label 上先掛掉、量不到我們真正要測的幣別那一格。
      { masked: SOLO, balance: 1730, currency: 'TWD', label: '甲種活存', note: '' },   // ＝明細末筆餘額（閘要算得平）
      { masked: MULTI, balance: 700, currency: 'JPY', label: '外幣活儲', note: '' },
      { masked: MULTI, balance: 500, currency: 'USD', label: '外幣活儲', note: '' },
    ],
    transactions: [
      { acctMasked: SOLO, date: '2026-06-11', direction: 'in', amount: 500, balance: 1730, summary: '合成轉入', note: '' },   // 同上：與配方版面同一筆
      // 多幣別帳號自己的明細（只有走閘／匯入那一題會帶）：它們正是「判不出幣別」的那些列
      ...(withMultiTx ? [
        { acctMasked: MULTI, date: '2026-06-12', direction: /** @type {const} */ ('in'), amount: 700, balance: 700, summary: '合成外幣存入', note: '' },
        { acctMasked: MULTI, date: '2026-06-13', direction: /** @type {const} */ ('out'), amount: 200, balance: 500, summary: '合成外幣支出', note: '' },
      ] : []),
    ],
  };
};

test('模板路線｜同號多幣別＝哨兵；單幣別帳號不受影響；accounts 兩列各自保留原幣別', () => {
  const r = parseBankSummary(templateLines());
  assert.equal(r.accountCurrency[MULTI], UNKNOWN_CURRENCY, '★同號多幣別＝分不出（last-wins 會挑一個＝猜）');
  assert.equal(r.accountCurrency[SOLO], 'TWD', '單幣別照舊');
  const multi = r.accounts.filter((/** @type {any} */ a) => a.masked === MULTI);
  assert.equal(multi.length, 2, '概要兩列各自成戶');
  assert.deepEqual(multi.map((/** @type {any} */ a) => a.currency).sort(), ['JPY', 'USD'], '★每一列自己的幣別沒有被哨兵吃掉（餘額更新靠它、身分是 masked+currency）');
});

test('配方路線｜同一份帳單給出與模板**逐鍵相同**的幣別表（不同＝配方出生第三關永遠不吻合＝規則卡孵不出來）', () => {
  const rec = /** @type {any} */ (parseWithRecipe(recipeLines(), recipe()));
  assert.equal(rec.accountCurrency[MULTI], UNKNOWN_CURRENCY);
  assert.equal(rec.accountCurrency[SOLO], 'TWD');
  const tpl = parseBankSummary(templateLines());
  assert.deepEqual(rec.accountCurrency, tpl.accountCurrency, '★兩條路同一份判準');
  // ★呼叫**正式的出生第三關**（Codex #517 r1#3：只比兩張 map＝把 recipeReproduces 改成遇 UNKNOWN 必敗
  //   也全綠＝守不住那個接縫）。expected＝AI 那份（黃金樣本）、actual＝配方重解的那份。
  const ai = normalizeAiBank(aiAnswer());
  const verdict = recipeReproduces(ai, rec);
  assert.equal(verdict.ok, true, `★配方孵得出來（不吻合＝規則卡永遠不存檔、同版面每期付全額 AI 錢）：${JSON.stringify(verdict.diff)}`);
});

test('AI 路線｜多幣別答案卷**不再整份拒收**，且幣別表與模板逐鍵相同', () => {
  const p = normalizeAiBank(aiAnswer());
  assert.equal(p.accountCurrency[MULTI], UNKNOWN_CURRENCY, '★AI 路也是哨兵');
  assert.equal(p.accountCurrency[SOLO], 'TWD');
  assert.deepEqual(p.accountCurrency, parseBankSummary(templateLines()).accountCurrency, '★三條路同一份判準');
  assert.equal(p.accounts.filter((/** @type {any} */ a) => a.masked === MULTI).length, 2, '兩列都收下來');
});

test('AI 路線｜幣別表兩列順序互換＝雙讀判定 agree（不因列序判成硬差異、白燒一發仲裁）', () => {
  const a = normalizeAiBank(aiAnswer(false));
  const b = normalizeAiBank(aiAnswer(true));
  assert.deepEqual(a, b, '正規化產出本身就與順序無關');
  // ★呼叫**正式的雙讀比對**（Codex #517 r1#3：只比兩份 normalize 結果＝把 aiAnswersAgree 改成遇 UNKNOWN
  //   強制硬差異也全綠）。last-wins 下這裡會是 agree:false、hard diff「帳戶幣別表」⇒ 仲裁 ⇒ 三份互不相同 ⇒ ai_disagree。
  const cmp = aiAnswersAgree(a, b);
  assert.equal(cmp.agree, true, `★兩讀一致（不一致＝每張外幣綜合帳單都白燒一發仲裁）：${JSON.stringify(cmp.diffs || [])}`);
});

test('AI 路線｜舊護欄一格沒放鬆：沒列過的幣別仍拒（r2#1）、交易帳號不在表裡仍拒（r3#1）', () => {
  const a = aiAnswer();
  a.accounts[1].currency = 'EUR';   // MULTI 只列過 JPY/USD
  assert.throws(() => normalizeAiBank(a), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /矛盾/.test(e.message),
    '★成員判準：沒列過的幣別照樣打回（不是「多幣別就全放行」）');
  const b = aiAnswer();
  b.accountCurrencies = b.accountCurrencies.filter((/** @type {any} */ x) => x.masked !== SOLO);
  assert.throws(() => normalizeAiBank(b), (/** @type {any} */ e) => e.code === 'ai_bad_answer',
    '★整個帳戶連幣別表一起漏交＝仍拒（查無幣別 fallback 成 TWD 入帳＝r3 實測過的錢錯）');
  const c = aiAnswer();
  c.transactions[0].acctMasked = '900900****9999';
  assert.throws(() => normalizeAiBank(c), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /不在 accountCurrencies/.test(e.message),
    '★交易帳號必須有幣別身分（r3#1）');
});

test('★同號混台幣＋外幣＝拒收（不是哨兵）：預審抓到的 regression——哨兵會讓對帳閘被整組繞過、未驗算的台幣餘額照樣入帳', () => {
  const a = aiAnswer();
  a.accountCurrencies.push({ masked: MULTI, currency: 'TWD' });   // 同號多一種台幣＝我們真的判不出來的形狀
  a.accounts.push({ masked: MULTI, balance: 50000, currency: 'TWD', label: '新臺幣活存', note: '' });
  assert.throws(() => normalizeAiBank(a), (/** @type {any} */ e) => e.code === 'ai_mixed_currency' && /同時列了台幣與外幣/.test(e.message),
    '★留在原地的 loud 拒收：改成哨兵＝①壞餘額鏈不再被擋（twdCheckable 看壓平值）②台幣概要餘額仍入帳（applyBalancesToDb 走逐列 pa.currency）③真台幣明細列被當外幣丟掉且畫面說是「外幣明細」——拿 loud 換 silent 錢錯');
  const pure = aiAnswer();   // 純外幣同號＝安全（那些列本來就不入帳）＝照樣放行
  assert.equal(normalizeAiBank(pure).accountCurrency[MULTI], UNKNOWN_CURRENCY, '★純外幣同號不受這道影響（放寬的射程剛好是安全的那一格）');
});

test('幣別表｜原型鍵防線：constructor／toString 這種名字不得因為讀到原型成員而被誤降成哨兵', () => {
  assert.equal(tableOf([['constructor', 'JPY']]).map['constructor'], 'JPY', '★own-property 讀（直讀會拿到 Object 原型的 function ⇒ 第一次登記就變 UNKNOWN）');
  assert.equal(tableOf([['toString', 'TWD'], ['toString', 'TWD']]).map['toString'], 'TWD');
});

test('提示詞｜同號多幣別要各列一列（規則 6）——沒教的話 AI 合併成一列，本支的放寬就吃不到、仍整份被打回', async () => {
  const { buildBankSystem } = await import('../lib/ai-parse.js');
  const sys = buildBankSystem();
  assert.match(sys, /每一種幣別各列一列/, '★提示詞要明講（對稱於定存那條「每一筆各列一列」）');
  // 合併形的處置＝照實記載：幣別表只列一種、概要卻有兩列 ⇒ 仍拒（誠實殘餘，不是靜靜放行）
  const merged = aiAnswer();
  merged.accountCurrencies = merged.accountCurrencies.filter((/** @type {any} */ x) => !(x.masked === MULTI && x.currency === 'USD'));
  assert.throws(() => normalizeAiBank(merged), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /矛盾/.test(e.message),
    '★合併形仍被打回（所以提示詞那句是必要的，不是裝飾）');
});

test('★三條路都擋混台外幣（Codex #517 r2#1：只擋 AI 不夠——歧義的來源是明細列沒有幣別欄，那是版面事實、跟誰讀的無關）', async () => {
  const mixLines = templateLines().map((ln) => ({ ...ln, cells: ln.cells.map((/** @type {any} */ c) => (c.s === 'JPY' ? { ...c, s: 'TWD' } : c)) }));
  assert.throws(() => parseBankSummary(mixLines), (/** @type {any} */ e) => e.code === 'bank_mixed_currency',
    '★模板路線也擋（他實測：不擋的話閘仍 strong、未驗算的 TWD 餘額 50,000 照樣建戶寫入）');
  const mixRecipeLines = recipeLines().map((ln) => ({ ...ln, cells: ln.cells.map((/** @type {any} */ c) => (c.s === 'JPY' ? { ...c, s: 'TWD' } : c)) }));
  assert.throws(() => parseWithRecipe(mixRecipeLines, recipe()), (/** @type {any} */ e) => /台幣與外幣/.test(String(e?.message || '')),
    '★配方路線也擋（呼叫端 fail-closed 當 miss，不會靜靜產出歧義結果）');
  const a = aiAnswer();
  a.accountCurrencies.push({ masked: MULTI, currency: 'TWD' });
  a.accounts.push({ masked: MULTI, balance: 50000, currency: 'TWD', label: '新臺幣活存', note: '' });
  assert.throws(() => normalizeAiBank(a), (/** @type {any} */ e) => e.code === 'ai_mixed_currency' && /台幣與外幣/.test(e.message), '★AI 路線也擋（專用終局碼，不是通用 ai_bad_answer——通用碼會被換模型／仲裁救回，見下一題）');
  // 三條路共用同一句白話（不帶任何欄值）
  assert.ok(!/\d{3}/.test(MIXED_CURRENCY_MSG), '★訊息不含帳號/末碼（欄值一律不回聲）');
});

test('★混台外幣不落到規則卡／AI 救援：**引擎工廠一次都不能被呼叫**（同一道判定，換誰讀答案都一樣——白繞一圈還白燒 AI 發數）', async () => {
  // ⚠️ 這裡刻意**不用形狀釘**：原本掃「原始碼含 code !== 'bank_mixed_currency'」是假綠——
  //    同一檔另一處（配方救援那條分支）也含同一段字面，砍掉 aiEligible 那處照樣全綠（實測）。
  let engineCalls = 0, extractCalls = 0;
  // ⚠️ 庫裡要**真的有一張規則卡**，這題才分得出「規則卡救援有沒有被試」——沒有卡的話
  //    recipeBankRoute 一開始就返回、根本不會抽字，拿掉那道排除也量不到差別（實測全綠＝假綠）。
  const { getDb, saveDb } = await import('../lib/repo.js');
  const db0 = await getDb();
  db0.parseRecipes = [{ id: 'rcp-mc', bank: '合成銀行', current: recipe(), graduateStreak: 0, graduated: false, suspect: false, rebirths: 0,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastUsedAt: '2026-08-01T00:00:00.000Z' }];
  await saveDb(db0);
  const mixed = async () => { throw Object.assign(new Error('同一個帳號同時列了台幣與外幣'), { status: 400, code: 'bank_mixed_currency' }); };
  await assert.rejects(
    () => previewBankStatement('QUFBQQ==', undefined, /** @type {any} */ (mixed), {
      useAi: true,   // ★連使用者明確要求 AI 都不該送出去
      aiEngineFactory: () => { engineCalls++; return /** @type {any} */ ({ models: { primary: 'p', escalation: 'e' }, parseOnce: async () => ({}) }); },
      aiExtract: async () => { extractCalls++; return [{ y: 0, cells: [{ x: 0, s: '合成' }] }]; },
    }),
    (/** @type {any} */ e) => e.code === 'bank_mixed_currency', '★原錯誤照實丟回（不是被改寫成「範本認不得」）');
  assert.equal(engineCalls, 0, '★AI 引擎一次都沒組裝＝零發數（拿掉 aiEligible 那道排除＝這裡會變 ≥1）');
  assert.equal(extractCalls, 0, '★規則卡救援也沒被試（抽字是那條路的第一步；拿掉配方那道排除＝這裡會變 ≥1）');
});

test('★apply 這條路看到 bank_mixed_currency 也不得去試配方救援（Codex #517 r3#2：我 r2 只改了 preview；r4#2 更正題名——本題證的是「看到這個碼就不救援」，**不是**「配方一定攔得住」，後者見下一題的誠實殘餘）', async () => {
  const { applyBankStatement } = await import('../lib/services/bank-import.js');
  const { getDb, saveDb } = await import('../lib/repo.js');
  const db0 = await getDb();
  db0.parseRecipes = [{ id: 'rcp-apply', bank: '合成銀行', current: recipe(), graduateStreak: 0, graduated: false, suspect: false, rebirths: 0,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastUsedAt: '2026-08-01T00:00:00.000Z' }];
  db0.transactions = []; db0.accounts = [];
  await saveDb(db0);
  const txBefore = (await getDb()).transactions.length;
  const acctBefore = (await getDb()).accounts.length;
  const mixed = async () => { throw Object.assign(new Error('同一個帳號同時列了台幣與外幣'), { status: 400, code: 'bank_mixed_currency' }); };
  await assert.rejects(
    () => applyBankStatement('QUFBQQ==', undefined, /** @type {any} */ (mixed), { aiExtract: async () => recipeLines() }),
    (/** @type {any} */ e) => e.code === 'bank_mixed_currency', '★原錯誤照實丟回');
  const after = await getDb();
  assert.equal(after.transactions.length, txBefore, '★db 交易數零變動（不擋的話他實測 imported:2、TWD 與 USD 兩筆都寫進去）');
  assert.equal(after.accounts.length, acctBefore, '★也沒有建出帳戶');
});

test('★AI 救援不得把已偵測到的混台外幣救回（Codex #517 r5#2：通用碼會被換模型／仲裁頂上——實測 Sonnet 誠實列出被拒、Opus 與 Fable 漏掉外幣區，於是 attested 過閘、匯入 2 筆）', async () => {
  const { aiBankRoute } = await import('../lib/services/bank-import.js');
  const honest = () => { const a = aiAnswer(); a.accountCurrencies.push({ masked: MULTI, currency: 'TWD' }); a.accounts.push({ masked: MULTI, balance: 50000, currency: 'TWD', label: '新臺幣活存', note: '' }); return a; };
  const blind = () => { const a = aiAnswer(); a.accountCurrencies = a.accountCurrencies.filter((/** @type {any} */ x) => !(x.masked === MULTI)); a.accounts = a.accounts.filter((/** @type {any} */ x) => x.masked !== MULTI); return a; };
  const { AI_BANK_MODELS, AI_ARBITER_MODEL } = await import('../lib/ai-parse.js');
  const db = { settings: { aiApiKey: 'sk-ant-synthetic', aiDualRead: true }, accounts: [] };
  // 誠實那讀（Sonnet）看到混幣、另外兩讀（Opus/Fable）漏掉外幣區
  const engine = { models: AI_BANK_MODELS, parseOnce: async (/** @type {string} */ _t, /** @type {string} */ m) => (m === AI_BANK_MODELS.primary ? honest() : blind()) };
  await assert.rejects(
    aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engine, extract: async () => [{ y: 0, cells: [{ x: 0, s: '1,730 500 50,000 700' }] }] }),
    (/** @type {any} */ e) => e.code === 'ai_mixed_currency',
    '★任一讀偵測到＝終局（混幣是版面事實，別讀沒看到只是它漏了；通用碼會走 attest→仲裁被救回）');
  assert.ok(AI_ARBITER_MODEL, '仲裁模型常數存在（本題刻意不讓它被叫到）');
});

test('⚠️ 誠實殘餘｜配方**只被教過台幣區**時看不到外幣區＝那個混幣帳號會被當純台幣解出來（Codex #517 r4#1；**既有缺口、非本支引入**）', () => {
  // A/B 實測（2026-08-26）：同一份素材、同一張配方，載入 main 8bb51fb 與本支 HEAD 的 lib，
  //   輸出**逐字相同**＝`accountCurrency={"900300****0363":"TWD"}`、交易 1 筆、帳戶 1 個。
  //   根因＝`hasMixedTwd()` 只看得到**配方實際解析出的區段**；配方沒被教過的外幣區它根本不知道存在。
  // ⚠️ 本題**照實釘住現況**，不是在祝福它：真正的修法是「配方必須解釋整份帳單的帳號／不得忽略
  //   未宣告的概要區段」——那會改到配方的適用性與既有配方，是獨立議題（已記待辦、留 William 裁）。
  //   釘住它的用意：未來有人修好時這題會紅，逼他回來把這段誠實劃界一起更新。
  const twdOnlyRecipe = { ...recipe(), summary: { ...recipe().summary, sections: [{ anchor: '合成帳戶總覽', currency: 'TWD' }] } };
  // 混幣帳號要**同時出現在台幣區與外幣區**（真實的外幣綜合帳戶就是這個長相）
  const mixLines = [
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, MULTI], [473, '$1,730']]),          // 台幣區：這個帳號
    L(270, [[47, '總計'], [445, '$1,730']]),
    L(260, [[47, '外幣總覽區']]),
    L(250, [[367, 'USD']]),
    L(240, [[56, '外幣活儲'], [108, MULTI], [436, '$500'], [491, '$15,900']]),   // 外幣區：同一個帳號
    L(210, [[47, '總計'], [490, '0']]),
    L(140, [[47, '往來紀錄明細']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
    L(100, [[53, 0, MULTI], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730']]),
  ];
  const p = /** @type {any} */ (parseWithRecipe(mixLines, twdOnlyRecipe));
  assert.equal(p.accountCurrency[MULTI], 'TWD', '★現況＝被當純台幣（配方看不到外幣區）——修好之後這裡會變 UNKNOWN 或整份拒收，屆時請一併更新契約的誠實劃界');
  // 對照：配方**有**被教過外幣區時，同一份帳單就擋得住（射程差別完全來自配方描述了什麼）
  assert.throws(() => parseWithRecipe(mixLines, recipe()), (/** @type {any} */ e) => /台幣與外幣/.test(String(e?.message || '')),
    '★配方看得到那個區段時就擋得住＝拒收的射程＝「解析器看得到的範圍」');
});

test('語意不變｜多幣別帳號＝「分不出」：**真的**走對帳閘與匯入——閘整組跳過、預覽標 foreign、**歧義那兩筆**匯入零筆（同份帳單的台幣列照常入帳 1 筆）', async () => {
  const { statementCurrencyLookup } = await import('../lib/statement-reconcile.js');
  const p = normalizeAiBank(aiAnswer(false, true));
  assert.equal(statementCurrencyLookup(p, MULTI), UNKNOWN_CURRENCY, '查表回哨兵');
  assert.equal(statementCurrencyLookup(p, SOLO), 'TWD', '同一份帳單裡的台幣帳號不連坐');
  // ★①真的跑閘（Codex #517 r1#2：只呼叫查表＝把 twdCheckable 改成也接受 UNKNOWN 仍全綠）
  const gate = assertBankReconciled(p, { accounts: [] });
  assert.equal(gate.stats.foreignRowsSkipped, 2, '★多幣別帳號的兩筆明細＝閘整組跳過（被當台幣驗＝這裡會變 0）');
  assert.equal(gate.stats.foreignAccountsSkipped, 2, '★概要那兩列（JPY/USD）也跳過');
  // ★②真的跑預覽投影
  const { rows, counts } = previewBankTxForDb({ accounts: [], transactions: [], cards: [] }, p);   // 回 { rows, counts }
  // 預覽列**不帶帳號欄**（機密紀律），所以按幣別欄認：判不出的那兩列＝哨兵＋foreign
  const multiRows = rows.filter((/** @type {any} */ r) => r.currency === UNKNOWN_CURRENCY);
  assert.equal(multiRows.length, 2, '兩筆判不出幣別的列都在預覽投影裡');
  assert.ok(multiRows.every((/** @type {any} */ r) => r.foreign === true), '★預覽標 foreign（本批不讓外幣入帳）');
  assert.equal(counts.foreign, 2, '★腳註那個「不會匯入」的計數也算到它們');
  assert.equal(rows.filter((/** @type {any} */ r) => r.currency === 'TWD' && !r.foreign).length, 1, '台幣那筆照常會匯入');
  // ★③真的跑正式匯入牆，並斷言 db 交易數（Codex 的第二刀＝讓歧義列進台幣現金流，這裡會紅）
  const db = { accounts: [], transactions: [], cards: [], settings: {} };
  const before = db.transactions.length;
  const res = importBankTxToDb(db, p);
  assert.equal(res.foreign, 2, '★兩筆判不出幣別的列＝foreign 計數');
  assert.equal(res.imported, 1, '★只有台幣那一筆入帳');
  assert.equal(db.transactions.length, before + 1, '★db 只多一筆（多的是台幣那筆）');
  assert.ok(db.transactions.every((/** @type {any} */ t) => !/外幣/.test(String(t.desc || '') + String(t.note || ''))), '★多幣別帳號的兩筆一筆都沒進 db');
});
