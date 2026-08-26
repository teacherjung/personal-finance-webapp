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
//     逐鍵比幣別永遠不吻合 ⇒ 配方**永遠孵不出來、同版面每期付全額 AI 錢**，而且不會有任何考題轉紅
//   ④**兩道舊護欄一格沒放鬆**：沒列過的幣別仍拒（r2#1）、交易帳號不在表裡仍拒（r3#1＝防查無幣別
//     fallback 成 TWD 靜靜入帳，當年實測 imported:5）
// ⚠️ 誠實劃界：本批**不讓外幣入帳**（那是批三，要先有匯率口徑）。明細列上沒有幣別欄，所以多幣別
//    帳號的每一筆交易仍判不出自己是哪一幣＝一律「分不出」不入帳；逐筆幣別是批二。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBankSummary, noteAccountCurrency, UNKNOWN_CURRENCY } from '../lib/bank-statement.js';
import { parseWithRecipe, RECIPE_FORMAT_VERSION } from '../lib/parse-recipe.js';
import { normalizeAiBank } from '../lib/ai-parse.js';

const L = (/** @type {number} */ y, /** @type {any[]} */ pairs) => ({ y, cells: pairs.map((p) => (p.length === 3 ? { x: p[0], w: p[1], s: p[2] } : { x: p[0], s: p[1] })) });
const MULTI = '900300****363';   // 合成：同一個遮罩帳號同時掛 JPY 與 USD（真帳單就是這個形狀）
const SOLO = '900100****3301';

// ---- 登記器（三條路的單一實作）----

test('登記器｜同號多幣別＝哨兵，且與登記順序無關；同幣別重複登記不受影響；哨兵黏著', () => {
  const a = {}; noteAccountCurrency(a, MULTI, 'JPY'); noteAccountCurrency(a, MULTI, 'USD');
  const b = {}; noteAccountCurrency(b, MULTI, 'USD'); noteAccountCurrency(b, MULTI, 'JPY');
  assert.equal(a[MULTI], UNKNOWN_CURRENCY);
  assert.deepEqual(a, b, '★兩種順序得到完全相同的表（last-wins 在這裡會一份 JPY 一份 USD＝雙讀硬差異）');
  const c = {}; noteAccountCurrency(c, SOLO, 'TWD'); noteAccountCurrency(c, SOLO, 'TWD');
  assert.equal(c[SOLO], 'TWD', '同幣別重複＝照舊');
  const d = {}; noteAccountCurrency(d, MULTI, 'JPY'); noteAccountCurrency(d, MULTI, 'USD'); noteAccountCurrency(d, MULTI, 'JPY');
  assert.equal(d[MULTI], UNKNOWN_CURRENCY, '★哨兵黏著（第三次登記救不回來——救回來就等於又在猜）');
});

// ---- 三條路 ----

/** 模板版面：台幣一戶＋外幣區同一個帳號掛 JPY 與 USD 兩列 */
const templateLines = () => [
  L(300, [[47, '新臺幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
  L(290, [[78, '帳號類別'], [163, '帳戶號碼'], [433, '帳戶餘額'], [509, '備註']]),
  L(280, [[50, '新臺幣活存'], [150, SOLO], [473, '$1,230']]),
  L(270, [[47, '合計'], [445, '$1,230']]),
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
  L(280, [[50, '甲種活存'], [150, SOLO], [473, '$1,230']]),
  L(270, [[47, '總計'], [445, '$1,230']]),
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
const aiAnswer = (/** @type {boolean} */ swap = false) => {
  const fx = [{ masked: MULTI, currency: 'JPY' }, { masked: MULTI, currency: 'USD' }];
  return {
    bank: '合成銀行', referenceDate: '2026-06-30',
    accountCurrencies: [{ masked: SOLO, currency: 'TWD' }, ...(swap ? fx.slice().reverse() : fx)],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [
      { masked: SOLO, balance: 1230, currency: 'TWD', label: '新臺幣活存', note: '' },
      { masked: MULTI, balance: 700, currency: 'JPY', label: '外幣活存', note: '' },
      { masked: MULTI, balance: 500, currency: 'USD', label: '外幣活存', note: '' },
    ],
    transactions: [{ acctMasked: SOLO, date: '2026-06-11', direction: 'in', amount: 500, balance: 1730, summary: '合成轉入', note: '' }],
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
  assert.deepEqual(rec.accountCurrency, tpl.accountCurrency, '★兩條路同一份判準（只改一處＝recipeReproduces 逐鍵比幣別永遠打架、而且沒有考題會紅）');
});

test('AI 路線｜多幣別答案卷**不再整份拒收**，且幣別表與模板逐鍵相同', () => {
  const p = normalizeAiBank(aiAnswer());
  assert.equal(p.accountCurrency[MULTI], UNKNOWN_CURRENCY, '★AI 路也是哨兵');
  assert.equal(p.accountCurrency[SOLO], 'TWD');
  assert.deepEqual(p.accountCurrency, parseBankSummary(templateLines()).accountCurrency, '★三條路同一份判準');
  assert.equal(p.accounts.filter((/** @type {any} */ a) => a.masked === MULTI).length, 2, '兩列都收下來');
});

test('AI 路線｜幣別表兩列順序互換＝產出完全相同（雙讀不會因為列的順序判成硬差異、白燒一發仲裁）', () => {
  assert.deepEqual(normalizeAiBank(aiAnswer(false)), normalizeAiBank(aiAnswer(true)),
    '★順序無關（last-wins 下一份是 JPY、一份是 USD ⇒ aiAnswersAgree 硬差異「帳戶幣別表」⇒ 仲裁 ⇒ 三份互不相同 ⇒ ai_disagree）');
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

test('語意不變｜多幣別帳號＝「分不出」＝下游照舊不驗算、不入帳（本批刻意不讓外幣入帳）', async () => {
  const { statementCurrencyLookup } = await import('../lib/statement-reconcile.js');
  const p = normalizeAiBank(aiAnswer());
  assert.equal(statementCurrencyLookup(p, MULTI), UNKNOWN_CURRENCY, '★查表回哨兵＝非 TWD＝閘整組跳過、匯入標 foreign 不入帳');
  assert.equal(statementCurrencyLookup(p, SOLO), 'TWD', '同一份帳單裡的台幣帳號照常入帳（不連坐）');
});
