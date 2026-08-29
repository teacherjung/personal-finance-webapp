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

const { parseBankSummary, makeCurrencyTable, UNKNOWN_CURRENCY, MIXED_CURRENCY_MSG, MAX_CURRENCY_ROWS, MAX_CURRENCY_CHARS, MAX_ACCOUNT_KEY_LEN, MAX_COMPARE_STATES } = await import('../lib/bank-statement.js');
const { parseWithRecipe, recipeReproduces, RECIPE_FORMAT_VERSION } = await import('../lib/parse-recipe.js');
const { normalizeAiBank, aiAnswersAgree } = await import('../lib/ai-parse.js');
const { previewBankTxForDb, importBankTxToDb, assertBankReconciled, previewBankStatement } = await import('../lib/services/bank-import.js');

const L = (/** @type {number} */ y, /** @type {any[]} */ pairs) => ({ y, cells: pairs.map((p) => (p.length === 3 ? { x: p[0], w: p[1], s: p[2] } : { x: p[0], s: p[1] })) });
const MULTI = '900300****363';   // 合成：同一個遮罩帳號同時掛 JPY 與 USD（真帳單就是這個形狀）
const SOLO = '900100****3301';

// ---- 登記器（三條路的單一實作）----

// ⚠️ 照三條解析路的正式用法：登記完**呼叫 finalize()** 才做等價印法互看
//   （分開的理由＝每筆都重算是 Θ(n³)、實測 300 列 8.38 秒卡住主行程，見 makeCurrencyTable 的說明）
const tableOf = (/** @type {[string,string][]} */ pairs) => { const t = makeCurrencyTable(); for (const [m, c] of pairs) t.note(m, c); t.finalize(); return t; };

test('幣別表｜同號多幣別＝哨兵，且與登記順序無關；同幣別重複不受影響；哨兵黏著', () => {
  const a = tableOf([[MULTI, 'JPY'], [MULTI, 'USD']]);
  const b = tableOf([[MULTI, 'USD'], [MULTI, 'JPY']]);
  assert.equal(a.map[MULTI], UNKNOWN_CURRENCY);
  assert.deepEqual(a.map, b.map, '★兩種順序得到完全相同的表（last-wins 在這裡會一份 JPY 一份 USD＝雙讀硬差異）');
  assert.equal(tableOf([[SOLO, 'TWD'], [SOLO, 'TWD']]).map[SOLO], 'TWD', '同幣別重複＝照舊');
  assert.equal(tableOf([[MULTI, 'JPY'], [MULTI, 'USD'], [MULTI, 'JPY']]).map[MULTI], UNKNOWN_CURRENCY, '★哨兵黏著（第三次登記救不回來＝又在猜）');
});

test('幣別表｜「是不是同一個帳號」用 acctPatternsIntersect 語言交集判準（#504 那把尺），不是比字串相等——分隔符／星號數／完整號對遮罩都涵蓋（#517 r2#2・r3#1・r5#1 各示範一種未涵蓋的寫法）', () => {
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

test('★等價印法的同一個帳號也要塌成哨兵（Grok 掃描第 1 條：那把身分尺原本只接在 hasMixedTwd 上，note() 仍用原字串當鍵）', () => {
  // 純外幣同號、兩種印法：原本各自成鍵、各自單一幣別＝**不會**塌成哨兵（下游看到的是 JPY 與 USD 兩個「確定」的答案）
  const t = tableOf([['900300****0363', 'JPY'], ['900300-****-0363', 'USD']]);
  assert.equal(t.map['900300****0363'], UNKNOWN_CURRENCY, '★兩個鍵都要變哨兵');
  assert.equal(t.map['900300-****-0363'], UNKNOWN_CURRENCY);
  const t2 = tableOf([['900300****0363', 'JPY'], ['90030012340363', 'USD']]);   // 完整號 vs 遮罩
  assert.equal(t2.map['900300****0363'], UNKNOWN_CURRENCY, '★完整號那一種也算同一個帳號');
  assert.equal(t2.map['90030012340363'], UNKNOWN_CURRENCY);
  const t3 = tableOf([[SOLO, 'TWD'], ['900300****0363', 'USD']]);   // 語言沒交集＝各自保留
  assert.equal(t3.map[SOLO], 'TWD', '不同帳號不受連累');
  assert.equal(t3.map['900300****0363'], 'USD');
  const t4 = tableOf([['900300****0363', 'JPY'], ['900300-****-0363', 'JPY']]);   // 同一個帳號、同一種幣別
  assert.equal(t4.map['900300****0363'], 'JPY', '★同幣別的兩種印法不得誤降成哨兵（只有幣別不同才是歧義）');
  // 一般的遮罩對遮罩相交（不是只有「完整號 vs 遮罩」那一種）——Codex r11 指出原題沒直接釘這格
  const t5 = tableOf([['9003**0363', 'JPY'], ['900300*0363', 'USD']]);
  assert.equal(t5.map['9003**0363'], UNKNOWN_CURRENCY, '★遮罩對遮罩語言相交也算同一個帳號');
  assert.equal(t5.map['900300*0363'], UNKNOWN_CURRENCY);
});

test('★整張表**重算**、與登記順序無關（Codex r11 非阻擋建議；「順序相依」正是本支廢除 last-wins 的理由，修的東西不可自己長出同一族毛病）', () => {
  // 三節點鏈：A(完整號,JPY) 與 C(完整號,USD) 彼此不相交，但都與 B(寬遮罩) 相交。
  const A = '90030011110363', B = '9003*0363', C = '90030022220363';
  const rows = /** @type {[string,string][]} */ ([[A, 'JPY'], [B, 'JPY'], [C, 'USD']]);
  /** 六種登記順序 */
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const shots = perms.map((order) => {
    const t = tableOf(order.map((i) => rows[i]));
    return JSON.stringify({ A: t.map[A], B: t.map[B], C: t.map[C] });
  });
  assert.equal(new Set(shots).size, 1, `★六種登記順序得到同一張表（逐次互看的壞法在這裡紅）：${shots.join(' | ')}`);
  const one = JSON.parse(shots[0]);
  assert.equal(one.B, UNKNOWN_CURRENCY, '★B 同時看到 JPY 與 USD＝歧義');
  assert.equal(one.A, 'JPY', '★A 只與 B 直接相交、與 C 不相交＝保持 JPY（誠實劃界：只看直接相交、不做傳遞閉包）');
  assert.equal(one.C, UNKNOWN_CURRENCY, '★C 與 B 直接相交、B 帶著 JPY＝歧義');
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
  assert.throws(() => parseWithRecipe(mixRecipeLines, recipe()),
    (/** @type {any} */ e) => e.code === 'bank_mixed_currency' && /台幣與外幣/.test(String(e?.message || '')),
    '★配方路線也擋，而且丟的是與模板**同一個終局碼**（Grok 掃描第 3 條：原本只斷言訊息＝假綠——recipe_parse_failed 帶同一句 MIXED_CURRENCY_MSG 照樣過，而那個碼會被 recipeBankRoute 吞成 miss、照舊落到 AI 救援）');
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

test('★**從配方偵測起跑**：配方看到混台外幣＝終局，不得被吞成一般 miss 而落到 AI 救援（Codex #517 r6#1：既有兩題一個只直接呼叫解析器、一個只從模板的碼起跑，都沒守到這條接線）', async () => {
  const { previewBankStatement } = await import('../lib/services/bank-import.js');
  const { getDb, saveDb } = await import('../lib/repo.js');
  const mixLines = [
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, MULTI], [473, '$1,730']]),
    L(270, [[47, '總計'], [445, '$1,730']]),
    L(260, [[47, '外幣總覽區']]), L(250, [[366, 'USD']]),
    L(240, [[56, '外幣活儲'], [108, MULTI], [436, '$500'], [491, '$15,900']]),
    L(210, [[47, '總計'], [490, '0']]),
    L(140, [[47, '往來紀錄明細']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
    L(100, [[53, 0, MULTI], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730']]),
  ];
  const db0 = await getDb();
  db0.parseRecipes = [{ id: 'rcp-term', bank: '合成銀行', current: recipe(), graduateStreak: 0, graduated: false, suspect: false, rebirths: 0,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lastUsedAt: '2026-08-01T00:00:00.000Z' }];
  db0.transactions = []; db0.accounts = [];
  db0.settings = { ...db0.settings, aiApiKey: 'sk-ant-synthetic' };
  await saveDb(db0);
  const txBefore = (await getDb()).transactions.length;
  let engineCalls = 0;
  // 模板認不得（一般的 bank_unrecognized）⇒ 走規則卡救援 ⇒ 配方解析時才偵測到混幣
  const unrecognized = async () => { throw Object.assign(new Error('這份 PDF 看起來不是內建範本'), { status: 400, code: 'bank_unrecognized' }); };
  await assert.rejects(
    () => previewBankStatement('QUFBQQ==', undefined, /** @type {any} */ (unrecognized), {
      useAi: true,   // ★使用者明確要求 AI，仍不得送出去
      aiEngineFactory: () => { engineCalls++; return /** @type {any} */ ({ models: { primary: 'p', escalation: 'e' }, parseOnce: async () => ({}) }); },
      aiExtract: async () => mixLines,
    }),
    (/** @type {any} */ e) => e.code === 'bank_mixed_currency',
    '★配方偵測到的混幣要原樣穿出去（被 catch{continue} 吞掉＝回 hit:null＝照舊當「範本認不得」去試 AI）');
  assert.equal(engineCalls, 0, '★AI 引擎一次都沒組裝（吞掉的話 AI 只要漏掉外幣區就會把它當純台幣接受、實測 level:strong）');
  assert.equal((await getDb()).transactions.length, txBefore, '★db 零變動');
});

test('⚠️ 誠實殘餘｜配方**只被教過台幣區**時看不到外幣區＝那個混幣帳號會被當純台幣解出來（Codex #517 r4#1；**既有缺口、非本支引入**）', () => {
  // A/B 實測（2026-08-26，**釘住 #517 的 lib**——會漂的「本支 HEAD」不可當比較對象，#524 r3#1）：
  //   同一份素材、同一張配方，載入 main 8bb51fb 與 #517（6ce4056）的 lib，**原有五個核心欄位逐字相同**
  //   ＝`accountCurrency={"900300****0363":"TWD"}`、交易 1 筆、帳戶 1 個（#524 起回傳另多診斷鍵
  //   unclaimedAccountRows＝整包不再逐字相同，但那是本支自己加的、不是缺口變了）。
  //   根因＝`hasMixedTwd()` 只看得到**配方實際解析出的區段**；配方沒被教過的外幣區它根本不知道存在。
  // ⚠️ 本題**照實釘住現況**，不是在祝福它。**方向已裁（William 2026-08-26）＝「甲：只量不擋」**：
  //   2026-08-26 的三份具體提案（①②③）在各自的隔離副本實測被打掉（漏放形狀 4–5 種、誤擋已實證
  //   且無退路、出生關治不到病；新設計要重測、不是免審），
  //   完整理由寫在 lib/parse-recipe.js「配方的幣別歸屬：兩個已知的洞」那段。所以現在的處置＝
  //   把「配方沒解釋到的帳號列」量成 `unclaimedAccountRows`（**只量不擋**），界線照實寫，
  //   等 D 校準拿到真帳單再決定要不要動。
  //   ⚠️ 未來真要修時這題會紅——請連同 lib/parse-recipe.js 那段與契約的誠實劃界一起更新。
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
  // ★裁示「甲」落地：看不到的那一列**被數到了**，但**裁決層**一格沒變（不拒解、不退 AI、不標疑似）。
  //   ⚠️ 措辭刻意不寫「零行為改變」（Codex #524 r1#1）：回傳物件的可列舉鍵 5→6＝模組邊界上輸出形狀
  //   有變；不變的是裁決、金額、db 寫入與 HTTP 回應。
  assert.equal(p.unclaimedAccountRows, 1, '★配方沒認領的那一列帳號被計數（外幣區那列）');
  assert.equal(p.transactions.length, 1, '★裁決不變：照舊解出 1 筆交易（計數不擋任何東西）');
  assert.equal(p.accounts.length, 1, '★裁決不變：照舊只建 1 個帳戶');
  // 對照：配方**有**被教過外幣區時，同一份帳單就擋得住（射程差別完全來自配方描述了什麼）
  assert.throws(() => parseWithRecipe(mixLines, recipe()), (/** @type {any} */ e) => /台幣與外幣/.test(String(e?.message || '')),
    '★配方看得到那個區段時就擋得住＝拒收的射程＝「解析器看得到的範圍」');
});

test('⚠️ 誠實殘餘②｜**錨點吞併**：一個通用區段錨點同時命中台幣與外幣小標＝外幣區被當台幣區重新開張，每一列都「有被認領」⇒ unclaimedAccountRows 對它回 0（2026-08-26 實測，裁示「甲」照實釘住）', () => {
  // 為什麼這題必須存在：誠實殘餘①（本檔題名含「只被教過台幣區」那題）講的是「配方**沒看到**」，
  //   本題講的是「配方**看到但歸錯**」。兩者都讓外幣以台幣入帳，但只有①會被「未認領的帳號列」
  //   這種判準量到——所以任何宣稱「數一數沒解到的列就補起來了」的修法，都會在本題這個形狀上
  //   發出假保證。⚠️ 本題直接釘住的射程（r1#3 收窄）＝FX 被歸 TWD、500 被建戶、**這一個**
  //   unclaimedAccountRows 判準回 0；未來別種「涵蓋率」判準要各自加題自證、不得引本題背書。
  // 根因：`sections.find(s => joined.includes(squash(s.anchor)))` 是**子字串**比對，而 validateRecipeStrict
  //   只禁止配方**自己的**區段錨點互為子字串，不管它對**文件**命中幾列。
  // ⚠️ 幣別標籤刻意用中文（`美元活期存款`）：印 ISO 三碼的話 parse-recipe.js 那兩道
  //   「固定幣別區出現矛盾的幣別標題」會先響，就量不到本題要量的東西了。
  const FX = '900300****363';
  const genericRecipe = {
    ...recipe(),
    docAnchors: ['帳戶總覽', '往來紀錄'],
    summary: { ...recipe().summary, sections: [{ anchor: '帳戶總覽', currency: 'TWD' }] },
  };
  const lines = [
    L(300, [[20, '合成銀行月結單'], [47, '新臺幣帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, SOLO], [473, '$1,730']]),
    L(270, [[47, '總計'], [445, '$1,730']]),
    L(260, [[47, '外幣帳戶總覽區']]),                                  // ★通用錨點 `帳戶總覽` 也命中它 ⇒ 區段又被開成 TWD
    L(240, [[56, '美元活期存款'], [108, FX], [436, '$500']]),           // ★US$500
    L(210, [[47, '總計'], [490, '0']]),
    L(140, [[47, '往來紀錄明細']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
    L(100, [[53, 0, SOLO], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730']]),
  ];
  const p = /** @type {any} */ (parseWithRecipe(lines, genericRecipe));
  assert.equal(p.accountCurrency[FX], 'TWD', '★現況＝美元戶被歸成台幣（區段被通用錨點吞併）');
  assert.equal(p.accounts.find((/** @type {any} */ a) => a.masked === FX)?.balance, 500,
    '★US$500 被建成台幣 500 元的帳戶＝這就是錢錯本身');
  assert.equal(p.unclaimedAccountRows, 0,
    '★★本題的重點：**一列都沒有「未認領」**——這個計數器在這個形狀上完全看不到問題（宣稱「數沒解到的列就修好了」＝假保證）');
  // ★同號變體＝掉回 recipe_parse_failed（撞「概要出現重複的帳戶幣別」那道既有牆）、**不是**
  //   bank_mixed_currency 終局碼 ⇒ 會被 recipeBankRoute 的 catch{continue} 當一般 miss（該吞法
  //   本身是設計、有自己的考題）＝契約寫的那條路的第一半在這裡釘住（r1#3：不釘就是空口宣稱）。
  const sameAcctLines = lines.map((/** @type {any} */ l) => ({ ...l, cells: l.cells.map((/** @type {any} */ c) => (c.s === FX ? { ...c, s: SOLO } : c)) }));
  assert.throws(() => parseWithRecipe(sameAcctLines, genericRecipe), (/** @type {any} */ e) =>
    e?.code === 'recipe_parse_failed' && /重複的帳戶幣別/.test(String(e?.message || '')),
    '★同號吞併＝recipe_parse_failed（一般 miss、會落 AI），不是混幣終局碼——這正是「涵蓋率牆治不到洞②」的行為證據');
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
  // ⚠️ 原本這裡比對 `t.desc`——**匯入列根本沒有那個欄**（Grok 掃描第 4 條），半截斷言是死的。
  //   改成打在真的有的欄上，並補「哨兵不得進入帳戶的幣別欄」（餘額更新走逐列 pa.currency、不是那張表；
  //   沒人釘的話哪天有人改成讀表就會把 UNKNOWN 寫進帳戶）。
  assert.ok(db.transactions.every((/** @type {any} */ t) => !/合成外幣/.test(String(t.note || '') + String(t.bankSummary || ''))), '★多幣別帳號的兩筆一筆都沒進 db');
  const { applyBalancesToDb } = await import('../lib/services/bank-import.js');
  const db2 = { accounts: [], transactions: [], cards: [], settings: {} };
  applyBalancesToDb(db2, p);
  assert.ok(db2.accounts.length > 0, '概要有帳戶＝有建戶（本題要看的是建出來的幣別欄）');
  assert.ok(db2.accounts.every((/** @type {any} */ a) => a.currency !== UNKNOWN_CURRENCY), '★哨兵不得被寫進帳戶的幣別欄');
  assert.deepEqual(db2.accounts.map((/** @type {any} */ a) => a.currency).sort(), ['JPY', 'TWD', 'USD'], '★三顆戶各自帶原幣（同號不同幣＝不同帳戶，既有行為）');
});

test('★哨兵必須是 truthy（Grok 掃描第 2 條）：查表端寫的是 `if (byMap) return byMap`——改成空字串／null 會讓「查到了」被當成「查無」而 fail-open 成台幣', async () => {
  const { statementCurrencyLookup } = await import('../lib/statement-reconcile.js');
  assert.ok(UNKNOWN_CURRENCY, '★非空字串（這是下游 truthy 查表的隱含契約）');
  // 餘額空白的帳戶**只進幣別表、不進 accounts**（parseBankSummary 先 note 再 `if (balance == null) continue`），
  // 那時沒有 accounts 補位可接——哨兵一旦變 falsy，這條路會一路退到 db、再退到 TWD。
  const parsed = { accountCurrency: { [MULTI]: UNKNOWN_CURRENCY }, accounts: [] };
  assert.equal(statementCurrencyLookup(parsed, MULTI), UNKNOWN_CURRENCY, '★沒有 accounts 補位時仍查得到哨兵');
  const falsy = { accountCurrency: { [MULTI]: '' }, accounts: [] };
  assert.equal(statementCurrencyLookup(falsy, MULTI), null, '對照組：falsy 值真的會被當成查無（所以那個契約是實的、不是我在猜）');
});

test('★300 筆 note() 與一次 finalize() 都在數量級內（Codex #517 r12：每筆都重算＝Θ(n³)、實測 300 列 8.38 秒卡住主行程。⚠️ r15 提醒：單一 n 的時間斷言**證不到漸近線性**，本題只宣稱「這個規模下沒有那個壞法」）', () => {
  const keys = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `9001${String(i).padStart(4, '0')}****${String(i).padStart(4, '0')}`);
  // ★把兩段時間**分開量**：note() 那段必須是線性的（每筆重算的壞法會讓它變成整個建表的成本）
  const t = makeCurrencyTable();
  const t0 = Date.now();
  keys(300).forEach((k, i) => t.note(k, i % 2 ? 'TWD' : 'USD'));
  const noteMs = Date.now() - t0;
  const t1 = Date.now();
  t.finalize();
  const finalizeMs = Date.now() - t1;
  // 門檻刻意寬鬆（不同機器差很多）：這題守的是**數量級**，不是效能調校。
  //   每筆重算的壞法在本機是 8.38 秒、且那 8 秒會落在 note() 那一段。
  assert.ok(noteMs < 500, `★300 筆 note() 在數量級內（實測 ${noteMs}ms；每筆重算的壞法會把 8 秒落在這一段）`);
  assert.ok(finalizeMs < 2000, `★finalize() 的 Θ(n²) 在數量級內（實測 ${finalizeMs}ms）`);
});

test('★三道 fail-closed 上限：不同帳號鍵數／鍵的總字元數／**單鍵長度**（r13：500 個 1KB 帳號卡 14.3 秒；r14：兩個 4,702 字元、合計 9,404<10,000 的合法鍵卡 6 秒後丟 RangeError＝連 fail-closed 都沒做到）', () => {
  const build = (/** @type {number} */ n, /** @type {number} */ pad = 4) => {
    const t = makeCurrencyTable();
    for (let i = 0; i < n; i++) t.note(`9001${String(i).padStart(pad, '0')}****${String(i).padStart(4, '0')}`, 'TWD');
    return t;
  };
  assert.equal(MAX_CURRENCY_ROWS, 500);
  assert.equal(MAX_CURRENCY_CHARS, 10000);
  // ⚠️ 上限數的是**不同帳號鍵數**（byRaw.size），不是「note 被呼叫幾次」——題名照實寫（r13#2）
  const same = makeCurrencyTable();
  for (let i = 0; i < MAX_CURRENCY_ROWS + 1; i++) same.note('900100****3301', 'TWD');
  assert.doesNotThrow(() => same.finalize(), '★同一個帳號登記幾百次＝只有一個鍵＝不得誤擋');
  assert.throws(() => build(MAX_CURRENCY_ROWS + 1).finalize(), (/** @type {any} */ e) => e.code === 'bank_too_many_accounts', '★超過鍵數上限＝拒收');
  assert.doesNotThrow(() => build(MAX_CURRENCY_ROWS).finalize(), '★剛好上限＝照收（邊界不要差一）');
  // ★總字元那道：列數不多、但每個鍵超長
  const fat = makeCurrencyTable();
  for (let i = 0; i < 20; i++) fat.note(`9001${String(i).padStart(4, '0')}${'*'.repeat(600)}0001`, 'TWD');
  assert.throws(() => fat.finalize(), (/** @type {any} */ e) => e.code === 'bank_too_many_accounts',
    '★20 列但每列 600+ 字元＝總字元超標＝拒收（只擋列數的話這裡會放行並卡住主行程）');
  // ★第三道：**總長在上限內、但單鍵超長**——r14 的素材（兩個 4,702 字元、合計 9,404 < 10,000，
  //   星號段位置不同、尾碼不同）讓 DP 卡 6,021ms 後丟 RangeError＝**連 fail-closed 都沒做到**。
  //   真正引爆的是**形狀不是長度**，所以要限單鍵長度＝結構性封頂（每對狀態 ≤ 64×64）。
  assert.equal(MAX_ACCOUNT_KEY_LEN, 64);
  const big = (/** @type {number} */ pos) => '9'.repeat(pos) + '**' + '1'.repeat(4702 - pos - 2);
  const long = makeCurrencyTable();
  const k1 = big(1), k2 = big(50);
  assert.notEqual(k1, k2, '素材真的是兩個不同的鍵');
  assert.equal(k1.length + k2.length, 9404, '總長 9,404 < 10,000＝總字元那道擋不住它（這正是 r14 的重點）');
  assert.ok([k1, k2].every((k) => /^\d+\*{2,}\d+$/.test(k)), '★素材是**合法**遮罩帳號（過得了 isMaskedAccount，不是靠壞資料擋掉的）');
  long.note(k1, 'TWD'); long.note(k2, 'USD');
  const t0 = Date.now();
  assert.throws(() => long.finalize(), (/** @type {any} */ e) => e.code === 'bank_too_many_accounts',
    '★單鍵超長＝拒收，而且是**帶 code 的 fail-closed**（原本是 RangeError 崩潰＝沒有 code/status）');
  assert.ok(Date.now() - t0 < 500, '★而且要**立刻**擋下（原本卡 6 秒才崩）');
});

test('★真正的界線是**計算量記帳**、不是長度或數量（Codex #517 r15：我上一版的「最壞情形」素材是假的——`i % 40` 讓 156 列其實只有 40 個不同的鍵；換成真正不同的鍵之後 finalize 4,106ms＋hasMixedTwd 1,009ms＝5,115ms 照樣過關）', () => {
  // ⚠️ 素材要**真的不同**（這正是上一版的錯）：每個鍵長度都是 64、星號位置各異、內容互不相同。
  const key = (/** @type {number} */ i) => { const p = 4 + (i % 30); return '9'.repeat(p) + '**' + String(i).padStart(MAX_ACCOUNT_KEY_LEN - p - 2, '0'); };
  const build = (/** @type {number} */ n) => {
    const t = makeCurrencyTable();
    for (let i = 0; i < n; i++) t.note(key(i), i % 2 ? 'TWD' : 'USD');
    return t;
  };
  assert.equal(new Set(Array.from({ length: 156 }, (_, i) => key(i))).size, 156, '★素材真的是 156 個不同的鍵（上一版只有 40 個＝量錯了東西）');
  assert.ok(Array.from({ length: 156 }, (_, i) => key(i)).every((k) => k.length === MAX_ACCOUNT_KEY_LEN && /^\d+\*{2,}\d+$/.test(k)), '★而且都是**合法**遮罩、都剛好 64 字元（三道長度上限全都擋不住它）');
  // ★關鍵：這組素材通過所有長度／數量上限，只有計算量記帳擋得住
  const t0 = Date.now();
  assert.throws(() => build(156).finalize(), (/** @type {any} */ e) => e.code === 'bank_too_many_accounts',
    '★超出計算量預算＝fail-closed 成同一個對外碼（不是沒有 code 的崩潰）');
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `★而且**上界與形狀無關**：預算用完就停（實測 ${ms}ms；沒有記帳的版本是 5,115ms）`);
  assert.equal(MAX_COMPARE_STATES, 2_000_000, '預算是寫死的常數（依實測選，見 bank-statement.js 的說明）');
  // ★真實規模完全不受影響
  const real = makeCurrencyTable();
  for (let i = 0; i < 20; i++) real.note(`9001${String(i).padStart(2, '0')}****${String(i).padStart(4, '0')}`, i % 3 ? 'TWD' : 'USD');
  const t1 = Date.now();
  assert.doesNotThrow(() => real.finalize(), '★真實規模（20 個帳號 × 14 字元）照常通過');
  assert.ok(Date.now() - t1 < 200, '★而且是毫秒等級');
});

test('★等價印法在三條路各自的實際行為（行為驗證，不是掃原始碼有沒有 finalize 這幾個字）：模板與 AI 塌成哨兵、配方**先**塌成哨兵、之後明細段的身分重疊守衛才拒解', () => {
  // 同一個帳號、兩種印法、兩種外幣。⚠️ 這裡用**星號數**不同、不用連字號：
  //   模板／配方的帳號列要過 `isMaskedAccount`（/^\d+\*{2,}\d+$/），帶連字號的寫法**在那兩條路不可達**
  //   （上游就不會被認成帳號列）——用不可達的形狀當素材＝這題會變成在測一個不存在的情境。
  const P1 = '900300****0363', P2 = '900300*****0363';
  // ① 模板：外幣區兩列改成兩種印法（JPY 用 P1、USD 用 P2）
  const tpl = templateLines().map((ln, i) => ({ ...ln,
    cells: ln.cells.map((/** @type {any} */ c) => (c.s === MULTI ? { ...c, s: (i <= 6 ? P1 : P2) } : c)) }));
  const t = parseBankSummary(tpl);
  assert.equal(t.accountCurrency[P1], UNKNOWN_CURRENCY, '★模板路：兩種印法互相看見＝都塌成哨兵');
  assert.equal(t.accountCurrency[P2], UNKNOWN_CURRENCY);
  // ② 配方：**行為不同**——互看其實**先跑**（finalize 在概要迴圈之後），把兩個鍵都塌成哨兵；
  //   之後明細段的既有守衛「概要帳戶身分重疊」才拒解（r13 更正我原本寫反的先後）。照實斷言、
  //   不硬求三條路長一樣：射程仍是 fail-closed（這張配方不適用、退回上一版／AI），
  //   不會靜靜產出「兩個確定的幣別」。
  const rl = recipeLines().map((ln, i) => ({ ...ln,
    cells: ln.cells.map((/** @type {any} */ c) => (c.s === MULTI ? { ...c, s: (i <= 5 ? P1 : P2) } : c)) }));
  assert.throws(() => parseWithRecipe(rl, recipe()),
    (/** @type {any} */ e) => e.code === 'recipe_parse_failed' && /身分重疊/.test(String(e?.message || '')),
    '★配方路：互看先把兩個鍵塌成哨兵，之後明細段的「概要帳戶身分重疊」守衛才拒解（fail-closed，不是靜靜給出兩個確定幣別）');
  // ③ AI：幣別表把同一個帳號用兩種印法各列一次
  const a = aiAnswer();
  a.accountCurrencies = [{ masked: SOLO, currency: 'TWD' }, { masked: P1, currency: 'JPY' }, { masked: P2, currency: 'USD' }];
  a.accounts = [
    { masked: SOLO, balance: 1730, currency: 'TWD', label: '甲種活存', note: '' },
    { masked: P1, balance: 700, currency: 'JPY', label: '外幣活儲', note: '' },
    { masked: P2, balance: 500, currency: 'USD', label: '外幣活儲', note: '' },
  ];
  const p = normalizeAiBank(a);
  assert.equal(p.accountCurrency[P1], UNKNOWN_CURRENCY, '★AI 路：同款');
  assert.equal(p.accountCurrency[P2], UNKNOWN_CURRENCY);
  assert.equal(p.accountCurrency[SOLO], 'TWD', '不相干的帳號不受連累（三條路都一樣）');
});
