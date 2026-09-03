// 信用卡規則卡（批四）純模組卷：嚴格驗證／套用引擎／出生把關（對照帳單＋重現）。
// 規矩同 test/parse-recipe.test.js：規則卡是機器產的、不可信——每題問「壞在這裡的卡會不會被靜靜收下」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_RECIPE_LIMITS, CARD_RECIPE_ROW_SHAPES,
  validateCardRecipeStrict, parseCardWithRecipe, validateCardRecipeAgainstStatement, cardRecipeReproduces,
} from '../lib/parse-recipe-card.js';
import { normalizeAiCard, reconcileAiCard } from '../lib/ai-parse-card.js';
import { cpuMs } from './helpers/cpu-ms.js';

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
  ['頁次 1/2'],                                        // 雜訊列（無日期形也無金額形＝跳過；r15 金額錨）
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

test('套用｜r5#1：日期漂到後格（版面前面多長一欄）＝拒解不跳過；嚴格驗證 r5#2：取值標籤全域相異', () => {
  // 「持卡人、交易日、入帳日、店名、金額」形＝日期不在首格——當雜訊跳過＝互抵漏抄同一扇門
  const shifted = LINES().map((l) => l);
  shifted.splice(10, 0, ['王小明', '2026/07/04', '2026/07/05', '甲店', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(shifted, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★整列任何一格帶日期形＝申報形——不在首格＝版面形狀與規則卡不符＝整份拒解');
  // r5#2：lastFourLabel 兼用摘要標籤＝下一期把應繳金額當末四碼（候選縮成錯的卡）
  const g = GOOD(); g.lastFourLabel = '本期應繳總額';
  assert.ok(validateCardRecipeStrict(g).length > 0, '★取值標籤（含末四碼/期別/調整）與四格全域兩兩相異');
  const g2 = GOOD(); g2.adjustmentLabels = ['本期新增款項'];
  assert.ok(validateCardRecipeStrict(g2).length > 0, '★調整標籤共用摘要標籤＝同一格被摺兩次');
});

test('套用｜r6#1/#2/#3：民國年月日形＝申報形；末四碼格唯一；單日期形任何後格帶日期＝拒解', () => {
  // r6#1：115年07月04日 的交易列不得當雜訊（互抵漏抄）
  const cjk = LINES().map((l) => l);
  cjk.splice(10, 0, ['115年07月04日', '115年07月05日', '甲店', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(cjk, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★中文/民國日期印法也是申報形——跳過＝互抵漏抄');
  // r6#2：末四碼列多出另一個四位數（製表年度）＝分不出、不得取第一個
  const two4 = LINES().map((l) => (l[0] === '卡號末四碼' ? ['製表年度', '2027', '卡號末四碼', '5678'] : l));
  const gLF = GOOD(); gLF.lastFourLabel = '卡號末四碼';
  assert.equal(codeOf(() => parseCardWithRecipe(two4, /** @type {any} */ (gLF))), 'recipe_parse_failed',
    '★同列兩個四位數＝末四碼分不出（取第一個會把 2027 當末四碼、候選縮到錯卡）');
  // r7#1：雙日期形的**單日期支路**同款洞——「日期、持卡人、日期、店名、金額」走 fallback 時
  // 後格也要掃（不掃＝第二個日期併進店名）
  const fb = [
    ...LINES().slice(0, 9),
    ['2026/07/03', '持卡人甲', '2026/07/05', '星巴克', '150'],   // d1 不是日期 ⇒ 走單日期支路
    ['本期消費小計', '450'],
  ];
  assert.equal(codeOf(() => parseCardWithRecipe(fb, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★雙日期形 fallback 的後格日期＝拒解（r6#3 只修到另一個 rowShape）');
  // r6#3：單日期形「持卡人欄插中間」＝第三格帶日期也要拒解（只看第二格會漏）——
  // fixture 只留單日期列（其他列不得自己踩中第二格判準、讓突變紅錯理由）
  const g = GOOD(); g.detail = { headerAnchor: '交易日期', rowShape: 'date-desc-amount', stopAnchors: ['本期消費小計'] };
  const mid = [
    ...LINES().slice(0, 9),
    ['2026/07/03', '持卡人甲', '2026/07/05', '星巴克', '150'],   // 陷阱列：日期在第三格
    ['2026/07/10', '全聯福利中心', '350'],                        // 正常單日期列（第二格不是日期）
    ['本期消費小計', '450'],
  ];
  assert.equal(codeOf(() => parseCardWithRecipe(mid, /** @type {any} */ (g))), 'recipe_parse_failed',
    '★任何後格長出日期＝版面變了該重學，不得把日期污染進店名');
});

test('套用｜r8#2：期別列兩個日期＝分不出（帳單期間 06/21–07/20 版面不得靜默取第一個）', () => {
  const two = LINES().map((l) => (l[0] === '結帳日期' ? ['帳單期間', '2026/06/21', '2026/07/20'] : l));
  const g = GOOD(); g.monthLabel = '帳單期間';
  assert.equal(codeOf(() => parseCardWithRecipe(two, /** @type {any} */ (g))), 'recipe_parse_failed',
    '★取第一個＝整批月份記錯、調整項期別 1 號跟著錯——唯一候選同金額/末四碼紀律');
});

test('套用｜r9#1：無分隔日期（20260704／1150704）也是申報形＝拒解不跳過；8 位大金額不誤判', () => {
  for (const bare of ['20260704', '1150704']) {
    const lines = LINES().map((l) => l);
    lines.splice(10, 0, [bare, bare, '甲店', '100']);
    assert.equal(codeOf(() => parseCardWithRecipe(lines, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
      `★無分隔日期 ${bare} 的列不得當雜訊（互抵漏抄）`);
  }
  // 月/日位不像月/日的 8 位數＝不是日期形；但它是**金額形**——r15 起帶金額的列必須看懂，
  // 拒解（原本斷言「雜訊照跳」＝2026-08-31 裁示前的行為，該列正是可漏帳的形）
  const amt = LINES().map((l) => l);
  amt.splice(10, 0, ['累計消費回饋試算', '12345678']);
  assert.equal(codeOf(() => parseCardWithRecipe(amt, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★帶金額解不成交易＝拒解（不再因為「不像日期」就當雜訊放行）');
});

test('套用｜r10#1：日期與店名併成同一格（2026/07/04 甲店）＝申報形拒解，不得當雜訊', () => {
  const merged = LINES().map((l) => l);
  merged.splice(10, 0, ['2026/07/04 甲店', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(merged, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★抽字併格是 card-identity 記載過的真實形——跳過＝互抵漏抄；整格純日期與雜訊列行為不變');
  // 雜訊仍是雜訊：非日期開頭的併字格照跳（頁次 1/2 在 LINES 既有、此處再驗一個含斜線的）
  const noise = LINES().map((l) => l);
  noise.splice(10, 0, ['共 2/3 頁']);
  assert.equal(parseCardWithRecipe(noise, /** @type {any} */ (GOOD())).transactions.length, 3, '非日期開頭＝照舊跳過');
});

test('套用｜r11#1：日期後緊接數字的併格（7-ELEVEN 店名／第二個日期）＝申報形拒解，剝空白不得吃掉 token 邊界', () => {
  // 互抵成對插入＝r11 對抗重現的原形：跳過的話驗算照樣平、靜默漏帳
  const digitStore = LINES().map((l) => l);
  digitStore.splice(10, 0, ['2026/07/04 7-ELEVEN', '100'], ['2026/07/05 7-ELEVEN 退', '-100']);
  assert.equal(codeOf(() => parseCardWithRecipe(digitStore, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★數字開頭店名：剝空白黏成「…047-ELEVEN」＝(?!\\d) 不成立——原樣形（空白＝邊界）必須也測');
  const doubleDate = LINES().map((l) => l);
  doubleDate.splice(10, 0, ['2026/07/04 2026/07/05 甲店', '100'], ['2026/07/06 2026/07/07 甲店退', '-100']);
  assert.equal(codeOf(() => parseCardWithRecipe(doubleDate, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★兩個日期併一格同理（剝空白＝日期黏日期）');
  // 無分隔日期＋空白＋店名：BARE 形也吃原樣邊界
  const bareStore = LINES().map((l) => l);
  bareStore.splice(10, 0, ['20260704 乙店', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(bareStore, /** @type {any} */ (GOOD()))), 'recipe_parse_failed');
});

test('套用｜r12#1：日期字內空白×數字開頭店名的交叉形＝申報形拒解（逐 token 黏合掃描）', () => {
  // r12 對抗重現的四組形：字內空白＋數字店名／Tab／全形空白＋數字店名／字內空白＋第二日期
  const shapes = [
    [['2026 / 07 / 04 7-ELEVEN', '100'], ['2026 / 07 / 05 7-ELEVEN 退', '-100']],
    [['2026/07/04\t7-ELEVEN', '100'], ['2026/07/05\t7-ELEVEN 退', '-100']],
    [['２０２６ ／ ０７ ／ ０４ 7-ELEVEN', '100'], ['２０２６ ／ ０７ ／ ０５ 7-ELEVEN 退', '-100']],
    [['2026 / 07 / 04 2026/07/05 甲店', '100'], ['2026 / 07 / 06 2026/07/07 甲店退', '-100']],
    // 無分隔（民國表格印法）字內空白×數字店名＝黏合掃描獨力承重的形：整格剝空白會黏成
    // 11507047-ELEVEN（無分隔形的數字邊界不成立）、原樣又只有 115 開頭——逐段黏到 1150704 才認得
    [['115 07 04 7-ELEVEN', '100'], ['115 07 05 7-ELEVEN 退', '-100']],
  ];
  for (const [row1, row2] of shapes) {
    const merged = LINES().map((l) => l);
    merged.splice(10, 0, row1, row2);
    assert.equal(codeOf(() => parseCardWithRecipe(merged, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
      `★互抵成對跳過＝驗算照樣平＝靜默漏帳：${JSON.stringify(row1[0])}`);
  }
  // 黏死無空白（分隔符形不設數字邊界）也認得
  const glued = LINES().map((l) => l);
  glued.splice(10, 0, ['2026/07/047-ELEVEN', '100']);
  assert.equal(codeOf(() => parseCardWithRecipe(glued, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★兩個分隔符已經夠像日期＝後面黏什麼都拒解');
  // 無分隔形照舊擋大金額誤判：8 位金額當雜訊、非日期開頭雜訊照跳（誤擋不外溢）
  const noise = LINES().map((l) => l);
  noise.splice(10, 0, ['折扣代碼 20269999', '備註'], ['會員點數 20260704100'], ['共 2/3 頁']);
  assert.equal(parseCardWithRecipe(noise, /** @type {any} */ (GOOD())).transactions.length, 3,
    '20269999 月位 99 不像月、20260704100 日期後黏數字＝與長數字分不出＝都不是日期；雜訊列行為不變');
});

test('套用｜r13#1：文字黏在日期前面（王小明2026/07/04）＝申報形拒解——抽取器 x 排序黏格、方向沒有保證', () => {
  // r13 對抗實證的六種逃逸形（前黏無空白／冒號／括號／零寬字／前黏 CJK 日期／前黏民國無分隔）
  const shapes = [
    [['王小明2026/07/04', '甲店100'], ['王小明2026/07/05', '甲店退-100']],
    [['日期:2026/07/04 甲店', '100'], ['日期:2026/07/05 甲店退', '-100']],
    [['(2026/07/04) 甲店', '100'], ['(2026/07/05) 甲店退', '-100']],
    [['2026\u200B/07/04 甲店', '100'], ['2026\u200B/07/05 甲店退', '-100']],
    [['王小明115年07月04日', '100'], ['王小明115年07月05日', '-100']],
    [['王小明1150704', '100'], ['王小明1150705', '-100']],
  ];
  for (const [row1, row2] of shapes) {
    const merged = LINES().map((l) => l);
    merged.splice(10, 0, row1, row2);
    assert.equal(codeOf(() => parseCardWithRecipe(merged, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
      `★互抵成對跳過＝驗算照樣平＝靜默漏帳：${JSON.stringify(row1[0])}`);
  }
  // 唯一照實不認的形＝純數字串裡的無分隔片段（真的與長數字分不出）；一般雜訊照跳
  const noise = LINES().map((l) => l);
  noise.splice(10, 0, ['流水號 9920260704', '備註'], ['客服 02-2712-3456']);
  assert.equal(parseCardWithRecipe(noise, /** @type {any} */ (GOOD())).transactions.length, 3,
    '9920260704 前面是數字＝無分隔形邊界不成立；電話兩段連字號拼不出日期形');
});

test('套用｜r15：有金額就必須看懂（William 2026-08-31 裁示）——日期印成怪字形也逃不掉金額錨', () => {
  // r14 的 Unicode 逃逸族（U+2010 連字號／en dash／減號／分數斜線／組合字／阿拉伯-印度數字）：
  // 日期偵測認不得沒關係——列上有 ASCII 金額＝拒解，互抵漏抄的路被金額錨堵死
  const escapes = [
    '\u738b2026\u201007\u201004 \u7532\u5e97',
    '2026\u201307\u201304 \u7532\u5e97',
    '2026\u221207\u221204 \u7532\u5e97',
    '2026\u204407\u204404 \u7532\u5e97',
    '2026/07\u034f/04 \u7532\u5e97',
    '\u0662\u0660\u0662\u0666/\u0660\u0667/\u0660\u0664 \u7532\u5e97',
  ];
  for (const cell of escapes) {
    const merged = LINES().map((l) => l);
    merged.splice(10, 0, [cell, '100'], [`${cell}\u9000`, '-100']);
    assert.equal(codeOf(() => parseCardWithRecipe(merged, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
      `★互抵成對也漏不掉：${JSON.stringify(cell)}`);
  }
  // 未宣告的小計列＝帶金額解不成＝拒解（裁示言明的代價：這種版面學不成卡、照舊走 AI）
  const subtotal = LINES().map((l) => l);
  subtotal.splice(10, 0, ['促銷活動小計', '1,234']);
  assert.equal(codeOf(() => parseCardWithRecipe(subtotal, /** @type {any} */ (GOOD()))), 'recipe_parse_failed');
  // 豁免＝規則卡宣告過的標籤列：具名調整落在明細區內照樣有名有分，不拒解、照收
  const inRegion = LINES().filter((l) => l[0] !== '循環信用利息');
  inRegion.splice(10, 0, ['循環信用利息', '30']);   // 移進明細區（頁次列之後）
  const ok = parseCardWithRecipe(inRegion, /** @type {any} */ (GOOD()));
  assert.equal(ok.transactions.length, 3);
  assert.deepEqual(ok.adjustments, [{ label: '循環信用利息', amount: 30, date: null }], '宣告列在區內＝豁免且照抄');
  // 頁碼獨立格（['1']）＝整格純數字＝金額形＝拒解——這是裁示言明代價的一部分（多頁帳單的
  // 頁碼常自佔一格；學不成卡、照舊走 AI），characterization 題釘住「這是故意的不是漏的」
  const pageNo = LINES().map((l) => l);
  pageNo.splice(10, 0, ['1']);
  assert.equal(codeOf(() => parseCardWithRecipe(pageNo, /** @type {any} */ (GOOD()))), 'recipe_parse_failed');
  // 純文字雜訊照跳（沒有錢可漏）
  const noise = LINES().map((l) => l);
  noise.splice(10, 0, ['\u672c\u671f\u512a\u60e0\u8a73\u898b\u5b98\u7db2', '\u5099\u8a3b']);
  assert.equal(parseCardWithRecipe(noise, /** @type {any} */ (GOOD())).transactions.length, 3);
});

test('套用｜r16：金額錨自身的三個洞——豁免夾帶／怪形金額／點號千分位', () => {
  // r16#1：末四碼列搬進明細區、夾帶一正一負——豁免列上只准有「被抄走那格」的金額形
  const smuggle = LINES().filter((l) => l[0] !== '卡號末四碼');
  smuggle.splice(9, 0, ['卡號末四碼', '5678', '100', '-100']);
  assert.equal(codeOf(() => parseCardWithRecipe(smuggle, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★宣告列豁免不得變成漏帳門');
  // 同家族：具名調整列在區內夾帶一格 toAmount 認不得的全形金額
  const adjSmuggle = LINES().filter((l) => l[0] !== '循環信用利息');
  adjSmuggle.splice(10, 0, ['循環信用利息', '30', '１００']);
  assert.equal(codeOf(() => parseCardWithRecipe(adjSmuggle, /** @type {any} */ (GOOD()))), 'recipe_parse_failed');
  // r16#2：toAmount 認不得的金額形（全形／阿拉伯-印度數字／撇號分組／幣別記號）＝寬判準也是錢，拒解
  for (const [amtA, amtB] of [['１００', '－１００'], ['\u0661\u0660\u0660', '-\u0661\u0660\u0660'], ["1'000", "-1'000"], ['NT$100', 'NT$-100'], ['100元', '-100元']]) {
    const pair = LINES().map((l) => l);
    pair.splice(10, 0, ['甲店', amtA], ['甲店退', amtB]);
    assert.equal(codeOf(() => parseCardWithRecipe(pair, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
      `★互抵成對的怪形金額不得當雜訊：${JSON.stringify(amtA)}`);
  }
  // r17#1：正負號印在幣別記號前面（+NT$100／-NT$100）——剝記號要把號留下來，整對不得被跳過
  for (const [amtA, amtB] of [['+NT$100', '-NT$100'], ['(NT$100)', 'NT$100'], ['+ NT$100', '- NT$100'], ['\u2212 US$100', 'US$100']]) {
    const pair = LINES().map((l) => l);
    pair.splice(10, 0, ['甲店', amtA], ['甲店退', amtB]);
    assert.equal(codeOf(() => parseCardWithRecipe(pair, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
      `★號在記號前也是錢：${JSON.stringify(amtA)}`);
  }
  // r17#2：長輸入不得二次方回溯（3 萬字元舊判準牆上時鐘實測兩秒級；線性判準毫秒級——門檻放很寬防機器快慢）
  const longCell = LINES().map((l) => l);
  longCell.splice(10, 0, [`${'1'.repeat(50000)}X`]);
  //   ⚠️ 量 CPU 工作量、不量牆上時鐘（交換與劃界見 test/helpers/cpu-ms.js）：
  //   夾心正則的壞法在這 5 萬字元上 CPU 實測 4,240ms（Codex #552 r1 獨立量到 3,957ms），對 1,500ms 是近三倍距離；
  //   這道斷言證明的是「不會二次方回溯」，不是「X 毫秒內收工」（同步等待它量不到）。
  const longMs = cpuMs(() => assert.equal(parseCardWithRecipe(longCell, /** @type {any} */ (GOOD())).transactions.length, 3, '數字堆＋非集字元＝不是金額形＝雜訊'));
  assert.ok(longMs < 1500, `★單格 5 萬字元的 CPU 工作量不得二次方（實測 CPU ${longMs.toFixed(0)}ms；夾心正則的壞法是 4 秒級）`);
  // r16#3：點號千分位 1.000 不是合法金額（舊判準被 Number 讀成 1＝整份自洽的錯數字）——
  // 摘要用它＝金額格分不出＝拒解；交易列多一格它＝不得被說明吃掉
  const dotted = LINES().map((l) => (l[0] === '上期應繳總額' ? ['上期應繳總額', '1.000'] : l));
  assert.equal(codeOf(() => parseCardWithRecipe(dotted, /** @type {any} */ (GOOD()))), 'recipe_parse_failed');
  const dottedTx = LINES().map((l) => l);
  dottedTx.splice(10, 0, ['2026/07/04', '2026/07/05', '星巴克', '1.000', '150']);
  assert.equal(codeOf(() => parseCardWithRecipe(dottedTx, /** @type {any} */ (GOOD()))), 'recipe_parse_failed',
    '★1.000 被 desc 吃掉＝錢混進店名裡消失');
  // 合法千分位與小數照收；雜訊列（文字夾數字）照跳＝寬判準不誤殺
  const fine = LINES().map((l) => l);
  fine.splice(10, 0, ['2026/07/04', '2026/07/05', '乙店', '1,234.56']);
  const ok = parseCardWithRecipe(fine, /** @type {any} */ (GOOD()));
  assert.equal(ok.transactions.length, 4);
  assert.equal(ok.transactions[1].amount, 1234.56);
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
  // ASCII fixture 在兩把尺下同形＝驗不出「一趟一把尺」——本題必須用能讓 old/new 真分歧的
  // 相容字：規則卡標籤存半形 VISA、帳單印全形 ＶＩＳＡ（NFKC 後同形、逐字不同形）。
  const g = GOOD(); g.lastFourLabel = 'VISA末四碼';
  const lines = LINES().map((l) => (l[0] === '卡號末四碼' ? ['ＶＩＳＡ末四碼', '5678'] : l));
  assert.equal(codeOf(() => parseCardWithRecipe(lines, /** @type {any} */ (g), { ruler: 'old' })), 'recipe_parse_failed',
    '★old（逐字）：全形標籤對不上半形槽＝整趟敗');
  const answer = parseCardWithRecipe(lines, /** @type {any} */ (g), { ruler: 'new' });
  assert.equal(answer.lastFour, '5678', '★new（NFKC）：同一份帳單解得動——兩把尺真的各是各的');
  assert.equal(answer.transactions.length, 3);
});

test('形狀｜枚舉表與上限是封閉常數（考題釘住：改值要先來這裡對帳）', () => {
  assert.deepEqual([...CARD_RECIPE_ROW_SHAPES], ['date-date-desc-amount', 'date-desc-amount']);
  assert.equal(CARD_RECIPE_LIMITS.docAnchors, 4);
  assert.equal(CARD_RECIPE_LIMITS.adjustmentLabels, 8);
});
