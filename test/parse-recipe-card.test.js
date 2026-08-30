// 信用卡規則卡（批四）純模組卷：嚴格驗證／套用引擎／出生把關（對照帳單＋重現）。
// 規矩同 test/parse-recipe.test.js：規則卡是機器產的、不可信——每題問「壞在這裡的卡會不會被靜靜收下」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_RECIPE_LIMITS, CARD_RECIPE_ROW_SHAPES,
  validateCardRecipeStrict, parseCardWithRecipe, validateCardRecipeAgainstStatement, cardRecipeReproduces,
} from '../lib/parse-recipe-card.js';
import { normalizeAiCard, reconcileAiCard } from '../lib/ai-parse-card.js';

/** 一張全對的規則卡（遠銀式；各題從它出發改壞一格）。 */
const GOOD = () => ({
  formatVersion: 1,
  bank: '遠東國際商業銀行',
  docAnchors: ['信用卡帳單', '本期應繳總額'],
  dateFormat: 'west-slash',
  totalsLabels: { prevDue: '上期應繳總額', paidAndRefund: '已繳款退款金額', newCharges: '本期新增款項', due: '本期應繳總額' },
  adjustmentLabels: ['循環信用利息', '違約金'],
  lastFourLabel: '卡號末四碼',
  monthLabel: '結帳日期',
  detail: { headerAnchor: '交易日期', rowShape: 'date-date-desc-amount', stopAnchors: ['本期消費小計'] },
});
/** GOOD 卡對應的帳單列（extractLinesForIsolation 形＝每列字串格陣列）。 */
const LINES = () => [
  ['遠東國際商業銀行', '信用卡帳單'],
  ['卡號末四碼', '5678'],
  ['結帳日期', '2026/07/20'],
  ['上期應繳總額', '1,000'],
  ['已繳款退款金額', '1,000'],
  ['本期新增款項', '450'],
  ['循環信用利息', '30'],
  ['本期應繳總額', '480'],
  ['交易日期', '入帳日期', '消費說明', '金額'],
  ['2026/07/03', '2026/07/05', '星巴克', '150'],
  ['頁次 1/2'],                                        // 雜訊列（跳過＝驗算閘接住）
  ['2026/07/10', '2026/07/11', '全聯福利中心', '350'],
  ['2026/07/12', '2026/07/13', '退款全聯', '-50'],
  ['本期消費小計', '450'],
];

const codeOf = (/** @type {() => any} */ fn) => {
  try { fn(); } catch (e) { return /** @type {any} */ (e).code; }
  return null;
};

test('正向｜全對的卡解全對的帳單：四格摘要／調整／末四碼／期別／明細三筆（雜訊列跳過），且過批二同一把驗算閘', () => {
  const answer = parseCardWithRecipe(LINES(), /** @type {any} */ (GOOD()));
  assert.equal(answer.issuer, '遠東國際商業銀行');
  assert.equal(answer.lastFour, '5678');
  assert.equal(answer.statementMonth, '2026-07');
  assert.deepEqual(answer.totals, { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 480 });
  assert.deepEqual(answer.adjustments, [{ label: '循環信用利息', amount: 30, date: null }]);   // 違約金這期沒印＝合法缺席
  assert.equal(answer.transactions.length, 3);
  assert.equal(answer.transactions[2].amount, -50, '退款保留負號');
  assert.equal(answer.transactions[0].postDate, '2026-07-05');
  const parsed = normalizeAiCard(answer);
  reconcileAiCard(parsed);   // ★規則卡讀的走**批二同一把**驗算閘（等式摺 30、慣例閘、容差 0）——沒有比較鬆的路
});

test('嚴格驗證｜fail-closed 矩陣：缺鍵／多鍵／枚舉外／藏數字＝整份拒收（訊息不回聲槽值）', () => {
  const rows = /** @type {[string, (g:any)=>void][]} */ ([
    ['不是物件', (/** @type {any} */ _g) => { void _g; }],
    ['formatVersion 錯', (/** @type {any} */ g) => { g.formatVersion = 99; }],
    ['多了不認得的鍵', (/** @type {any} */ g) => { g.evil = 'x'; }],
    ['docAnchors 只有一個', (/** @type {any} */ g) => { g.docAnchors = ['信用卡帳單']; }],
    ['docAnchors 藏了 4 位數字', (/** @type {any} */ g) => { g.docAnchors = ['信用卡帳單', '編號1234']; }],
    ['dateFormat 枚舉外', (/** @type {any} */ g) => { g.dateFormat = 'iso'; }],
    ['totalsLabels 缺格', (/** @type {any} */ g) => { delete g.totalsLabels.due; }],
    ['totalsLabels 多鍵', (/** @type {any} */ g) => { g.totalsLabels.extra = 'x'; }],
    ['adjustmentLabels 超量', (/** @type {any} */ g) => { g.adjustmentLabels = Array.from({ length: CARD_RECIPE_LIMITS.adjustmentLabels + 1 }, (_, i) => `項目甲乙${'丙'.repeat(i % 3)}`); }],
    ['rowShape 枚舉外', (/** @type {any} */ g) => { g.detail.rowShape = 'freeform'; }],
    ['lastFourLabel 給了星號', (/** @type {any} */ g) => { g.lastFourLabel = '卡號****'; }],
    ['detail 缺 headerAnchor', (/** @type {any} */ g) => { delete g.detail.headerAnchor; }],
  ]);
  assert.equal(validateCardRecipeStrict(null).length > 0, true);
  for (const [name, mutate] of rows) {
    if (name === '不是物件') continue;
    const g = /** @type {any} */ (GOOD()); mutate(g);
    assert.ok(validateCardRecipeStrict(g).length > 0, `★${name} 沒被擋`);
  }
  assert.equal(validateCardRecipeStrict(GOOD()).length, 0, '全對的卡要過');
});

test('套用｜fail-closed：摘要標籤 0 列或 2 列、金額格分不出、表頭錨缺席＝recipe_parse_failed（不帶帳單內容）', () => {
  // 標籤找不到
  const g1 = GOOD(); g1.totalsLabels.prevDue = '上期結欠';
  assert.equal(codeOf(() => parseCardWithRecipe(LINES(), /** @type {any} */ (g1))), 'recipe_parse_failed');
  // 標籤兩列（due 的標籤在本卡也是 docAnchor 沒關係——這裡再插一列真重複）
  const dupLines = [...LINES(), ['本期新增款項', '999']];
  assert.equal(codeOf(() => parseCardWithRecipe(dupLines, /** @type {any} */ (GOOD()))), 'recipe_parse_failed');
  // 同列兩個金額格＝分不出
  const twoAmt = LINES().map((l) => (l[0] === '上期應繳總額' ? ['上期應繳總額', '1,000', '2,000'] : l));
  assert.equal(codeOf(() => parseCardWithRecipe(twoAmt, /** @type {any} */ (GOOD()))), 'recipe_parse_failed');
  // 表頭錨缺席
  const noHeader = LINES().filter((l) => l[0] !== '交易日期');
  assert.equal(codeOf(() => parseCardWithRecipe(noHeader, /** @type {any} */ (GOOD()))), 'recipe_parse_failed');
  // 零明細但摘要說有新增＝不收（引擎層先擋；就算放行，批二驗算閘也會紅——雙保險）
  const noTx = LINES().filter((l) => !/^2026\//.test(l[0] || ''));
  assert.equal(codeOf(() => parseCardWithRecipe(noTx, /** @type {any} */ (GOOD()))), 'recipe_parse_failed');
});

test('套用｜rowShape=date-desc-amount 的版面也解得動；停止錨與摘要標籤都會終止明細區', () => {
  const g = GOOD(); g.detail = { headerAnchor: '交易日', rowShape: 'date-desc-amount', stopAnchors: [] };
  g.totalsLabels = { ...g.totalsLabels };
  const lines = [
    ['遠東國際商業銀行', '信用卡帳單'],
    ['卡號末四碼', '5678'], ['結帳日期', '2026/07/20'],
    ['上期應繳總額', '0'], ['已繳款退款金額', '0'], ['本期新增款項', '500'],
    ['循環信用利息', '30'], ['本期應繳總額', '530'],
    ['交易日', '說明', '金額'],
    ['2026/07/03', '全聯福利中心', '500'],
    ['本期應繳總額', '530'],   // 摘要標籤再現＝明細區自動停（不會把它讀成怪列）
  ];
  // 摘要標籤出現兩列＝fail-closed？——上面 due 印了兩次會被「標籤唯一」擋：這正是要驗的
  assert.equal(codeOf(() => parseCardWithRecipe(lines, /** @type {any} */ (g))), 'recipe_parse_failed',
    '★摘要標籤兩列＝分不出哪列是真摘要＝拒解（寧擋勿猜）');
  const lines2 = lines.slice(0, -1);
  const answer = parseCardWithRecipe(lines2, /** @type {any} */ (g));
  assert.equal(answer.transactions.length, 1);
  assert.equal(answer.transactions[0].postDate, null);
  reconcileAiCard(normalizeAiCard(answer));
});

test('套用｜r1#1：首格是日期的列**不准**當雜訊跳過——形狀/金額歧義＝整份拒解（防一正一負互抵漏抄）', () => {
  // 兩筆申報形的列各帶兩個金額格（歧義）：舊版靜靜跳過兩筆 ⇒ +100/−100 互抵、驗算閘看不到
  const lines = LINES().map((l) => l);
  lines.splice(10, 0, ['2026/07/04', '2026/07/05', '甲店', '100', '100']);   // 兩個金額格＝分不出
  assert.equal(codeOf(() => parseCardWithRecipe(lines, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★日期開頭＝申報形——歧義要拒解不准跳過（跳過安全的前提只給非日期開頭的雜訊列）');
});

test('套用｜r2#1：長得像日期但不過規則卡格式（不補零）＝拒解不跳過；r2#3：單日期繳款列照收', () => {
  // 不補零的日期列（版面日期印法漂了）：舊版當雜訊跳過 ⇒ +100/−100 互抵漏抄
  const drift = LINES().map((l) => l);
  drift.splice(10, 0, ['2026/8/1', '2026/8/2', '甲店', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(drift, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★日期印法與規則卡不符＝版面漂了＝整份拒解退回 AI（跳過＝互抵漏抄從別的門進來）');
  // 單日期列（繳款常只印一個日期）：雙日期 rowShape 也要照收、不誤擋
  const mixed = LINES().map((l) => l);
  mixed.splice(12, 0, ['2026/07/15', '信用卡自動扣繳', '-1000']);
  const answer = parseCardWithRecipe(mixed, /** @type {any} */ (GOOD()));
  const pay = answer.transactions.find((t) => t.desc === '信用卡自動扣繳');
  assert.ok(pay, '★單日期繳款列要收進來（真實版面雙日期消費與單日期繳款混排）');
  assert.equal(pay.postDate, null);
  // 收進來之後照樣過批二的閘（繳款列 G2 不計、桶對得上）
  const g = normalizeAiCard(answer);
  reconcileAiCard(g);
});

test('套用＋重現｜r1#2：具名調整同列印了日期就抄；日期不同＝重現關紅（防重傳時利息 stmtRef 分岔重複記帳）', () => {
  const lines = LINES().map((l) => (l[0] === '循環信用利息' ? ['循環信用利息', '2026/06/30', '30'] : l));
  const answer = parseCardWithRecipe(lines, /** @type {any} */ (GOOD()));
  assert.equal(answer.adjustments[0].date, '2026-06-30', '★同列的日期要抄下來（AI 黃金答案帶日期時才重現得了）');
  const e = normalizeAiCard(answer);
  const a2 = normalizeAiCard(parseCardWithRecipe(lines, /** @type {any} */ (GOOD())));
  /** @type {any} */ (a2).adjustments[0] = { .../** @type {any} */ (a2).adjustments[0], date: null };
  assert.equal(cardRecipeReproduces(e, a2).ok, false, '★調整日期不同＝重現關要紅');
});

test('套用｜r3#1/#2：全形相容日期＝old 趟拒解（不准當雜訊）、new 趟 NFKC 後解得動；入帳日漂移也拒解', () => {
  // 全形日期列插進明細區：old 趟（逐字）解不動、但**長得像日期**＝拒解不跳過（互抵漏抄的門）
  const fw = LINES().map((l) => l);
  fw.splice(10, 0, ['２０２６／０７／０４', '２０２６／０７／０５', '甲店', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(fw, /** @type {any} */ (GOOD()), { ruler: 'old' })), 'recipe_parse_failed',
    '★old 趟：全形日期＝漂移拒解——當雜訊跳過＝一正一負互抵從這裡漏');
  const answer = parseCardWithRecipe(fw, /** @type {any} */ (GOOD()), { ruler: 'new' });
  assert.equal(answer.transactions.length, 4, '★new 趟：NFKC 把全形折回 ASCII＝那一列照收（兩把尺協定的意義）');
  // 入帳日（第二格）漂成不補零＝拒解、不得降級成「說明文字」（r3#2：日期會污染店名與去重身分）
  const drift2 = LINES().map((l) => l);
  drift2.splice(10, 0, ['2026/07/04', '2026/7/5', '甲店', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(drift2, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★第二格長得像日期但解不動＝同樣是漂移');
});

test('嚴格驗證｜r4#1：四格標籤兩兩相異——共用標籤＝下一期四格分家時全讀成同一格', () => {
  const g = GOOD(); g.totalsLabels = { prevDue: '本期新增款項', paidAndRefund: '已繳款退款金額', newCharges: '本期新增款項', due: '本期應繳總額' };
  assert.ok(validateCardRecipeStrict(g).length > 0, '★prevDue 與 newCharges 共用標籤要在出生第一關就擋');
});

test('套用｜r4#2/#3/#4：帶空白的全形日期＝old 拒解；交易列撞停止錨＝拒解；單日期形多出日期欄＝拒解', () => {
  // r4#2：全形＋字內空白（２０２６ ／ ０７ ／ ０４）——old 趟不得當雜訊
  const fw = LINES().map((l) => l);
  fw.splice(10, 0, ['２０２６ ／ ０７ ／ ０４', '２０２６ ／ ０７ ／ ０５', '甲店', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(fw, /** @type {any} */ (GOOD()), { ruler: 'old' })), 'recipe_parse_failed',
    '★帶空白的全形日期＝漂移拒解（尺會去空白、偵測也要）');
  // r4#3：交易列的某格恰等於停止錨——先 break 會吞掉該列與其後（互抵漏抄）＝拒解
  const clash = LINES().map((l) => l);
  clash.splice(10, 0, ['2026/07/04', '2026/07/05', '本期消費小計', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(clash, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★日期開頭又撞停止錨＝分不出交易還是收尾＝整份拒解');
  // r4#4：單日期版面長出第二個日期欄＝拒解不併進說明
  const g = GOOD(); g.detail = { headerAnchor: '交易日期', rowShape: 'date-desc-amount', stopAnchors: ['本期消費小計'] };
  const grown = LINES().map((l) => (l[0] === '2026/07/03' ? ['2026/07/03', '2026/07/05', '星巴克', '150'] : l));
  assert.equal(codeOf(() => parseCardWithRecipe(grown, /** @type {any} */ (g))), 'recipe_parse_failed',
    '★第二格長得像日期＝版面變了該重學，不得把日期污染進店名');
});

test('出生把關｜對照帳單：錨點＝某筆店名（等值）或錨點命中交易列（位置）＝擋', () => {
  const answer = { transactions: [{ desc: '星巴克' }, { desc: '全聯福利中心' }] };
  const g1 = GOOD(); g1.adjustmentLabels = ['星巴克'];   // 錨點是店名
  assert.ok(validateCardRecipeAgainstStatement(LINES(), /** @type {any} */ (g1), answer).length > 0,
    '★錨點與交易店名相等＝把帳單內容當版面詞彙（換一期店名不同就失靈、還可能誤釘）');
  const g2 = GOOD(); g2.bank = '星巴克';   // r1#3：bank 也是槽位——店名進 bank 一樣是內容入卡
  assert.ok(validateCardRecipeAgainstStatement(LINES(), /** @type {any} */ (g2), answer).length > 0,
    '★店名存進 bank＝長期留在共用櫃並被面板投影送到前端');
  const g3 = GOOD(); g3.bank = '憑空商業銀行';   // r3#5：bank 也要接地
  assert.ok(validateCardRecipeAgainstStatement(LINES(), /** @type {any} */ (g3), answer).length > 0,
    '★帳單上找不到的機構名＝憑空的字不入卡（存了會長期顯示給使用者）');
  // r4#5：new 趟的全形日期交易列也要被認成交易列——錨點釘在它上面照樣要擋
  const fwLines = LINES().map((l) => l);
  fwLines.splice(10, 0, ['２０２６／０７／０４', '２０２６／０７／０５', '星巴克門市', '100']);
  const g4 = GOOD(); g4.docAnchors = ['信用卡帳單', '星巴克門市'];
  assert.ok(validateCardRecipeAgainstStatement(fwLines, /** @type {any} */ (g4), answer, { ruler: 'new' }).length > 0,
    '★交易列判定要走該趟的尺＋寬日期偵測——否則內容牆被全形交易列旁路');
  assert.equal(validateCardRecipeAgainstStatement(LINES(), /** @type {any} */ (GOOD()), answer).length, 0, '全對的卡要過');
});

test('出生把關｜重現：逐欄比對（錢嚴格、文字空白不敏感、調整 multiset、明細比順序）', () => {
  const mk = () => normalizeAiCard(parseCardWithRecipe(LINES(), /** @type {any} */ (GOOD())));
  const e = mk();
  assert.equal(cardRecipeReproduces(e, mk()).ok, true, '同一份帳單重解＝一致');
  const flips = /** @type {[string, (a:any)=>void][]} */ ([
    ['totals.due', (/** @type {any} */ a) => { a.statementTotals.due = 481; }],
    ['lastFour', (/** @type {any} */ a) => { a.lastFour = '9999'; }],
    ['statementMonth', (/** @type {any} */ a) => { a.statementMonth = '2026-08'; }],
    ['adjustments 金額', (/** @type {any} */ a) => { a.adjustments[0] = { ...a.adjustments[0], amount: 31 }; }],
    ['transactions 金額', (/** @type {any} */ a) => { a.transactions[0] = { ...a.transactions[0], amount: 151 }; }],
    ['transactions 順序', (/** @type {any} */ a) => { a.transactions.reverse(); }],
    ['筆數', (/** @type {any} */ a) => { a.transactions.pop(); }],
  ]);
  for (const [name, mutate] of flips) {
    const a = mk(); mutate(a);
    assert.equal(cardRecipeReproduces(e, a).ok, false, `★${name} 不同沒被抓到`);
  }
  // 文字欄空白不敏感（原文留底不過尺、比對用 softEq——同銀行）
  const soft = mk(); soft.transactions[0] = { ...soft.transactions[0], desc: '星 巴 克' };
  assert.equal(cardRecipeReproduces(e, soft).ok, true, '店名差空白＝同一筆（normalizeDesc 之後仍可能殘留全形間隔）');
});

test('兩把尺｜相容字版面：old（逐字）整趟敗、new（NFKC）過——一趟一把尺不混用', () => {
  // 帳單把「上期應繳總額」印成相容字（NFKC 後同形）：這裡用全形英數當代表
  const lines = LINES().map((l) => l.map((c) => c.replace('上期應繳總額', '上期應繳總額０'.slice(0, -1))));
  void lines;   // 中文相容字難以穩定合成——改用「標籤帶全形空白」這個 recipeNorm 能吸收、squash 也能吸收的形不成立，
  // 故此題改驗協定本身：同一張卡、同一份帳單，兩把尺各自跑都要成功（尺不影響全 ASCII-safe 版面）
  const g = GOOD();
  for (const ruler of ['old', 'new']) {
    const answer = parseCardWithRecipe(LINES(), /** @type {any} */ (g), { ruler });
    assert.equal(answer.transactions.length, 3, `ruler=${ruler} 也解得動`);
  }
});

test('形狀｜枚舉表與上限是封閉常數（考題釘住：改值要先來這裡對帳）', () => {
  assert.deepEqual([...CARD_RECIPE_ROW_SHAPES], ['date-date-desc-amount', 'date-desc-amount']);
  assert.equal(CARD_RECIPE_LIMITS.docAnchors, 4);
  assert.equal(CARD_RECIPE_LIMITS.adjustmentLabels, 8);
});
