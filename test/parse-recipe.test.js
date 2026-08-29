// P2-1 配方純模組的考題：格式驗證器（零帳單內容＝機械拒收）＋泛化引擎（兩套**虛構版面**
// ——詞彙刻意不用台新的，證明引擎沒有寫死的銀行殘留）＋台新等價交叉驗證＋出生驗收比對器。
// 合成資料紀律：帳號一律 900100/900200/900300 前綴＋假末碼，金額/摘要全虛構，零真實帳單內容。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECIPE_FORMAT_VERSION, RECIPE_LIMITS, validateRecipeStrict, recipeMatches, parseWithRecipe, recipeReproduces,
  validateRecipeAgainstStatement, recipeNorm, hitEither,
} from '../lib/parse-recipe.js';
import { parseBankSummary, parseBankDetail, splitAmount, squash } from '../lib/bank-statement.js';
import { classifyBankTx } from '../lib/services/bank-import.js';

/** 合成列（[x,s] 或 [x,w,s]）。 */
const L = (y, pairs) => ({ y, cells: pairs.map(p => (p.length === 3 ? { x: p[0], w: p[1], s: p[2] } : { x: p[0], s: p[1] })) });

/** 版面 A 的配方：雙帳戶、TWD＋BY-CODE 兩段、帳號＋日期開列、西元日期、錨點取參考日。 */
const recipeA = () => ({
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

/** 版面 A 的合成帳單（詞彙全虛構；幾何沿用真實版面的座標習慣）。 */
const linesA = () => [
  L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
  L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
  L(260, [[50, '乙種活存'], [150, '900200****3302'], [453, '$95,000'], [521, '主要戶']]),
  L(240, [[47, '總計'], [445, '$96,230']]),
  L(220, [[47, '外幣總覽區']]),
  L(200, [[367, 'JPY']]),
  L(180, [[56, '外幣活儲'], [108, '900300****363'], [436, '$700'], [491, '$150']]),
  L(160, [[47, '總計'], [490, '0']]),
  L(140, [[47, '往來紀錄明細']]),
  L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
  // 存入（右緣 349+40 落在存進欄窗）；餘額格黏尾備註
  L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730 合成黏尾註']]),
  // 幾何誤判存入（右緣 380+8=388 落在存進欄窗 [331,396)）→ running 餘額 1730→730、|差|=金額 ⇒ 覆寫成支出
  L(83, [[53, 0, '900100****3301'], [124, 0, '2026/06/16'], [177, 0, '合成扣款'], [380, 8, '$1,000'], [418, 0, '$730']]),
  // 純票號列（單號欄、無交易金額）：右緣 230+30=260 落在 [單號x=200, 提領x=272) ⇒ 忽略、不憑空生交易
  L(72, [[53, 0, '900100****3301'], [124, 0, '2026/06/17'], [230, 30, '0006789']]),
  L(66, [[53, 0, '900200****3302'], [124, 0, '2026/06/02'], [180, 0, '合成入帳'], [349, 40, '$2,400'], [414, 0, '$97,400']]),
  L(50, [[450, 0, '合成孤兒備註片段']]),   // 換行備註（高 x、無帳號）→ 最近列 y66
];

/** 版面 B 的配方：單帳戶、日期開列、民國日期、期間結束日當參考日、餘額挑最後一個金額格。 */
const recipeB = () => ({
  formatVersion: RECIPE_FORMAT_VERSION,
  bank: '合成郵局',
  docAnchors: ['帳戶彙整', '交易紀錄'],
  dateFormat: 'roc-slash',
  refDate: { strategy: 'anchored-period-end', anchor: '帳務期間' },
  summary: {
    sections: [{ anchor: '帳戶彙整', currency: 'TWD' }],
    endAnchor: '小計',
    balancePick: 'last-money',
  },
  detail: {
    rowIdent: 'date-first',
    headerOut: '支出', headerIn: '存入', headerBalance: '餘額',
    headerNote: null, headerIgnore: [],
  },
});

const linesB = () => [
  L(300, [[20, '合成郵局存簿'], [47, '帳務期間'], [200, '115/05/01'], [280, '~'], [320, '115/05/31']]),
  L(280, [[47, '帳戶彙整']]),
  L(260, [[50, '活期儲金'], [150, '900200****7788'], [400, '0.12'], [453, '8,000']]),   // last-money＝餘額 8000（0.12 是利率）
  L(240, [[47, '小計'], [445, '8,000']]),
  L(220, [[47, '交易紀錄']]),
  L(200, [[60, '日期'], [150, '摘要'], [272, '支出'], [331, '存入'], [396, '餘額']]),
  L(180, [[60, 0, '115/05/02'], [150, 0, '合成繳費'], [289, 30, '1,200'], [414, 0, '6,800']]),
  L(160, [[60, 0, '115/05/20'], [150, 0, '合成薪轉'], [349, 40, '2,000'], [414, 0, '8,800']]),
];

// ---- 驗證器：零帳單內容＝機械拒收 ----

test('驗證器｜合格配方通過；兩套虛構版面的配方都是合法格式', () => {
  assert.deepEqual(validateRecipeStrict(recipeA()), []);
  assert.deepEqual(validateRecipeStrict(recipeB()), []);
});

test('驗證器｜零內容硬條件：4 位以上數字（含拆散）／全形／遮罩星號／分段符，一律拒收（★4「不是口頭保證」）', () => {
  // 每個案例帶「哨兵」＝該槽值最可辨識的片段；錯誤訊息含哨兵＝把疑似帳單內容印進 log（預審③：
  // 原本共用一條黑名單 regex，一半案例的回聲抓不到——逐案哨兵才是真斷言）。
  for (const [patch, sentinel, why] of [
    [r => { r.docAnchors[0] = '對帳單2026'; }, '2026', '錨點帶 4 位連號（日期長相）'],
    [r => { r.docAnchors[0] = '單 2 0 2 6 號'; }, '2 0 2 6', '空白拆字——squash 後照抓'],
    [r => { r.docAnchors[0] = '甲9乙0丙0丁2'; }, '甲9乙0', 'CJK 拆字——數字總量照數（預審②繞法 B）'],
    [r => { r.bank = '帳號０９０２'; }, '０９０２', '全形數字——NFKC 後照抓（預審②繞法 A）'],
    [r => { r.bank = '銀行1234'; }, '1234', 'bank 帶數字串'],
    [r => { r.summary.endAnchor = '900合計12'; }, '900合計', '錨點帶帳號片段（總量 5 位）'],
    [r => { r.detail.headerOut = '提領**金額'; }, '提領**', '星號＝遮罩帳號長相'],
    [r => { r.detail.headerIn = '存進＊＊額'; }, '存進＊＊', '全形星號——NFKC 後照抓'],
    [r => { r.refDate.anchor = '基準日|'; }, '基準日|', '分段符 |'],
  ]) {
    const r = recipeA(); patch(r);
    const errs = validateRecipeStrict(r);
    assert.ok(errs.length > 0, `★${why}：必須拒收`);
    assert.ok(errs.every(e => !e.includes(sentinel)), `★${why}：錯誤訊息不可回聲槽值（那可能就是帳單內容）`);
  }
  // 鍵名也是可走私位置（預審④）：不認得的鍵要拒收，且**鍵名不回聲**
  const r = recipeA(); r['帳號９００２００３３０２'] = 1;
  const errs = validateRecipeStrict(r);
  assert.ok(errs.length > 0, '★不認得的鍵要拒收');
  assert.ok(errs.every(e => !e.includes('９００２') && !e.includes('9002')), '★鍵名不可回聲');
  // 誠實劃界：每槽 ≤3 位數字仍放行（「第1銀行」這類正當詞彙）；跨槽拼接＝#452 排除的對抗性藏匿
  const ok3 = recipeA(); ok3.docAnchors[0] = '第123類總覽';
  assert.deepEqual(validateRecipeStrict(ok3), [], '3 位以內的數字是正當詞彙空間，不誤殺');
});

test('驗證器｜結構牆：不認得的欄位（頂層與巢狀）、壞版本、壞枚舉、撞名欄標題、策略與錨點矛盾', () => {
  for (const [patch, why] of [
    [r => { r.extra = 1; }, '頂層多欄位'],
    [r => { r.detail.eval = 'x'; }, '巢狀多欄位'],
    [r => { r.formatVersion = 2; }, '不認得的版本（fail-closed）'],
    [r => { r.dateFormat = 'yyyy-mm-dd'; }, '日期格式不在枚舉'],
    [r => { r.summary.balancePick = 'regex'; }, '挑格策略不在枚舉'],
    [r => { r.detail.rowIdent = 'free'; }, '列判準不在枚舉'],
    [r => { r.summary.sections[0].currency = 'ntd'; }, '幣別非三碼大寫也非 BY-CODE'],
    [r => { r.detail.headerIn = r.detail.headerOut; }, '支出／存入欄標題相同＝分欄塌掉'],
    [r => { r.refDate = { strategy: 'none', anchor: '基準日' }; }, 'none 卻帶錨點'],
    [r => { r.refDate = { strategy: 'anchored-date', anchor: null }; }, 'anchored 卻沒錨點'],
    [r => { r.docAnchors = []; }, '零暗號＝什麼版面都認'],
    [r => { r.docAnchors = ['甲', '乙', '丙', '丁', '戊']; }, '暗號超過上限'],
    [r => { r.docAnchors[0] = '收'; }, '暗號太短'],
    [r => { r.docAnchors[0] = '長'.repeat(RECIPE_LIMITS.anchor + 1); }, '槽位超長'],
  ]) {
    const r = recipeA(); patch(r);
    assert.ok(validateRecipeStrict(r).length > 0, `★${why}：必須拒收`);
  }
  assert.deepEqual(validateRecipeStrict(null), ['配方：必須是物件']);
  assert.deepEqual(validateRecipeStrict([]), ['配方：必須是物件']);
});

// ---- 引擎：版面 A（acct-date、雙段、BY-CODE、西元）----

test('引擎｜版面 A 全解析：概要雙段＋sticky 幣別、右緣分欄、餘額鏈覆寫方向、票號不生交易、孤兒備註歸位', () => {
  const p = parseWithRecipe(linesA(), recipeA());
  assert.equal(p.bank, '合成銀行');
  assert.equal(p.referenceDate, '2026-06-30', '★錨點行取日期');
  // ⚠️ 展開再比（#517 批一起 accountCurrency 是 **null-prototype**：AGENTS 鐵則要求使用者文字當鍵的 map
  //   不得有原型鏈——字面 {} 遇到 `__proto__` 會靜默不落地）。內容判準一格未變。
  assert.deepEqual({ ...p.accountCurrency }, { '900100****3301': 'TWD', '900200****3302': 'TWD', '900300****363': 'JPY' });
  assert.equal(p.accounts.length, 3);
  assert.deepEqual(p.accounts[0], { suffix: '3301', masked: '900100****3301', balance: 1230, currency: 'TWD', label: '甲種活存', note: '' });
  assert.equal(p.accounts[1].note, '主要戶');
  assert.equal(p.accounts[2].currency, 'JPY');
  assert.equal(p.accounts[2].balance, 700, '★dollar-tagged 取第一個帶 $ 的格＝原幣');
  assert.equal(p.transactions.length, 3, '★純票號列不可憑空生出交易');
  assert.deepEqual(p.transactions.map(t => [t.direction, t.amount]), [['in', 500], ['out', 1000], ['in', 2400]]);
  assert.equal(p.transactions[1].direction, 'out', '★幾何說存入、餘額鏈說支出＝餘額是權威');
  assert.equal(p.transactions[0].note, '合成黏尾註', '★餘額格黏尾備註要拆出來');
  assert.equal(p.transactions[2].note, '合成孤兒備註片段', '★換行備註靠 y 歸到最近列');
});

test('引擎｜確定性：同輸入解兩次逐位元相同（配方路線 apply 重解＝安全的前提）', () => {
  assert.deepEqual(parseWithRecipe(linesA(), recipeA()), parseWithRecipe(linesA(), recipeA()));
  assert.deepEqual(parseWithRecipe(linesB(), recipeB()), parseWithRecipe(linesB(), recipeB()));
});

// ---- 引擎：版面 B（date-first、民國、期間結束日、last-money）----

test('引擎｜版面 B：民國日期轉西元、期間結束日當參考日、last-money 跳過利率格、交易歸唯一帳戶', () => {
  const p = parseWithRecipe(linesB(), recipeB());
  assert.equal(p.bank, '合成郵局');
  assert.equal(p.referenceDate, '2026-05-31', '★期間「115/05/01~115/05/31」取結束日＋民國轉西元');
  assert.deepEqual(p.accounts, [{ suffix: '7788', masked: '900200****7788', balance: 8000, currency: 'TWD', label: '活期儲金', note: '' }],
    '純數字格（利率）不進 note——與模板同一條「金額格不當備註」判準');
  assert.equal(p.transactions.length, 2);
  assert.deepEqual(p.transactions.map(t => [t.acctMasked, t.date, t.direction, t.amount, t.balance]), [
    ['900200****7788', '2026-05-02', 'out', 1200, 6800],
    ['900200****7788', '2026-05-20', 'in', 2000, 8800],
  ], '★date-first 的交易全歸唯一帳戶；民國 115/05/02 → 2026-05-02');
});

test('引擎｜date-first 但概要有兩個帳戶＝結構性拒解（交易不知道歸誰，寧退 AI 不猜）', () => {
  const lines = linesB();
  lines.splice(3, 0, L(250, [[50, '另一戶'], [150, '900300****3303'], [453, '100']]));
  assert.throws(() => parseWithRecipe(lines, recipeB()), (e) => e.code === 'recipe_parse_failed');
});

test('引擎｜期間錨點行只有一個日期＝參考日 null（同 AI 規則 1a「寧可 null」：填錯會拿舊蓋新）', () => {
  const lines = linesB();
  lines[0] = L(300, [[20, '合成郵局存簿'], [47, '帳務期間'], [200, '115/05/31']]);
  const p = parseWithRecipe(lines, recipeB());
  assert.equal(p.referenceDate, null);
  assert.equal(p.transactions.length, 2, '參考日讀不到不連坐——交易照樣解（餘額更新那層自己會跳過）');
});

// ---- 引擎：結構性失敗＝退回 AI 的機器判準 ----

test('引擎｜失敗路徑都帶 code=recipe_parse_failed、訊息零帳單內容：暗號對不上／表頭抓不到 x／零交易／配方不合格', () => {
  const cases = [
    ['暗號對不上', () => parseWithRecipe(linesB(), recipeA())],
    ['表頭在全文出現但格子對不上（標題被拆成兩格）', () => {
      const lines = linesA();
      lines[9] = L(120, [[75, '帳號'], [272, '提領'], [300, '金額'], [331, '存進金額'], [396, '結存餘額']]);
      return parseWithRecipe(lines, recipeA());
    }],
    ['認得版面但零交易', () => parseWithRecipe(linesA().slice(0, 10), recipeA())],
    ['配方本身不合格', () => parseWithRecipe(linesA(), { ...recipeA(), formatVersion: 99 })],
  ];
  for (const [why, run] of cases) {
    assert.throws(run, (e) => e.code === 'recipe_parse_failed' && e.status === 400 && !/900100|3301|合成轉入/.test(e.message), `★${why}`);
  }
});

test('引擎｜recipeMatches：全部暗號都在才算認得；拆字（跨格）也認得', () => {
  assert.equal(recipeMatches(linesA(), recipeA()), true);
  assert.equal(recipeMatches(linesB(), recipeA()), false);
  const missingSecond = linesA().filter(l => !l.cells.some(c => c.s.includes('往來紀錄')));
  assert.equal(recipeMatches(missingSecond, recipeA()), false,
    '★第一條暗號在、第二條不在＝不認得——只驗第一條的版本會把別種版面錯認進來');
  const split = linesA();
  split[0] = L(300, [[40, '合成帳'], [90, '戶總覽'], [150, '區'], [452, '結算基準日:2026/06/30']]);
  assert.equal(recipeMatches(split, recipeA()), true, '★squash 後跨格拼回＝拆字容錯');
});

// ---- 台新等價交叉驗證：泛化引擎吃「描述台新版面的配方」必須重現模板解析器 ----

test('等價｜台新詞彙配方 vs 模板解析器：同一份合成帳單、逐欄同結果（幾何機關同源的證據）', () => {
  const taishinLines = [
    L(300, [[20, '台新銀行綜合對帳單'], [47, '新臺幣帳戶概要區'], [452, '現值參考日:2026/06/30']]),
    L(280, [[50, '新臺幣活存'], [150, '900100****3301'], [473, '$23']]),
    L(260, [[47, '合計'], [445, '$23']]),
    L(240, [[47, '外幣帳戶概要區']]),
    L(220, [[367, 'JPY']]),
    L(200, [[56, '外幣活存'], [108, '900300****363'], [436, '$0'], [491, '$0'], [513, '合成備註']]),
    L(190, [[47, '合計'], [490, '0']]),
    L(150, [[47, '交易往來明細']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '支票號碼'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$36,669'], [418, 0, '$36,692 合成黏尾']]),
    L(83, [[53, 0, '900100****3301'], [124, 0, '2026/06/16'], [177, 0, '合成轉出'], [289, 30, '$16,333'], [418, 0, '$20,359']]),
    L(50, [[450, 0, '合成孤兒註']]),
  ];
  const viaRecipe = parseWithRecipe(taishinLines, {
    formatVersion: RECIPE_FORMAT_VERSION,
    bank: '台新',
    docAnchors: ['帳戶概要區', '往來明細'],
    dateFormat: 'west-slash',
    refDate: { strategy: 'anchored-date', anchor: '現值參考日' },
    summary: {
      sections: [{ anchor: '新臺幣帳戶概要區', currency: 'TWD' }, { anchor: '外幣帳戶概要區', currency: 'BY-CODE' }],
      endAnchor: '合計',
      balancePick: 'dollar-tagged',
    },
    detail: {
      rowIdent: 'acct-date',
      headerOut: '支出金額', headerIn: '存入金額', headerBalance: '帳戶餘額',
      headerNote: '備註', headerIgnore: ['支票號碼'],
    },
  });
  const sum = parseBankSummary(taishinLines);
  const viaTemplate = { bank: '台新', referenceDate: sum.referenceDate, accounts: sum.accounts,
    accountCurrency: sum.accountCurrency, transactions: parseBankDetail(taishinLines) };
  // 已知的刻意差異：模板給空 label 填台新預設值（新臺幣活存／外幣活存）——那是台新專屬 hard-code，
  // 泛化引擎不猜 label；本合成帳單每列都印了 label，所以此處仍可全等比對。
  const rep = recipeReproduces(viaTemplate, viaRecipe);
  assert.equal(rep.diff, null);
  assert.equal(rep.ok, true, '★配方引擎必須逐欄重現模板解析器的結果');
});

// ---- 出生驗收比對器 ----

test('出生驗收｜r4#1 格間空白：純文字欄（summary/note/label）空白不敏感＝拆格版面孵得出配方；真差異照紅、金額欄照樣嚴格', () => {
  const base = () => parseWithRecipe(linesA(), recipeA());
  // AI 照抄帶格間空白（linesToText 空格相接）、引擎輸出 squash——只差空白＝算重現
  const soft = base();
  if (soft.transactions[0].summary) soft.transactions[0].summary = String(soft.transactions[0].summary).split('').join(' ');
  soft.accounts[0].label = `　${soft.accounts[0].label ?? ''} `;
  // r5#1：兩種 note（帳戶備註／交易備註）**各自**製造空白差異——只考 summary/label 時，
  // 單獨把 note 移出軟等值清單的窄刀仍綠（Codex r5 loader 突變實測）。
  soft.accounts[0].note = ` ${soft.accounts[0].note ?? ''}　`;
  const iNote = soft.transactions.findIndex((/** @type {any} */ t) => t.note);
  assert.ok(iNote >= 0, '夾具至少要有一筆帶備註的交易，否則本題考不到 transaction note');
  soft.transactions[iNote].note = String(soft.transactions[iNote].note).split('').join(' ');
  assert.deepEqual(recipeReproduces(base(), soft), { ok: true, diff: null }, '★只差空白＝重現成（假拒收修掉；四欄樣本各自到位）');
  // 真差異（剝空白後仍不同）照紅
  const bad = base();
  bad.transactions[0].summary = `${bad.transactions[0].summary ?? ''}尾`;
  assert.equal(recipeReproduces(base(), bad).diff, 'transactions[0].summary', '★空白不敏感不可放過真差異');
  // 嚴格欄不軟化：date 是字串欄、塞空白也要紅
  const strict = base();
  strict.transactions[0].date = ` ${strict.transactions[0].date}`;
  assert.equal(recipeReproduces(base(), strict).diff, 'transactions[0].date', '★軟等值只限純文字欄、日期欄照樣嚴格');
});

test('出生驗收｜逐欄重現＝ok；任何一欄走樣＝不 ok，diff 只帶欄位路徑、絕不帶欄值', () => {
  const base = () => parseWithRecipe(linesA(), recipeA());
  assert.deepEqual(recipeReproduces(base(), base()), { ok: true, diff: null });
  for (const [patch, wantDiff] of [
    [p => { p.transactions[1].amount = 999; }, 'transactions[1].amount'],
    [p => { p.transactions[0].direction = 'out'; }, 'transactions[0].direction'],
    [p => { p.transactions[2].note = '走樣'; }, 'transactions[2].note'],
    [p => { p.accounts[0].balance = 5; }, 'accounts[0].balance'],
    [p => { p.referenceDate = null; }, 'referenceDate'],
    [p => { p.bank = '別家'; }, 'bank'],
    [p => { p.accountCurrency['900300****363'] = 'USD'; }, 'accountCurrency（幣別）'],
    [p => { p.transactions.pop(); }, 'transactions（筆數）'],
    [p => { p.accounts.pop(); }, 'accounts（帳戶數）'],
  ]) {
    const a = base(); patch(a);
    const r = recipeReproduces(base(), a);
    assert.equal(r.ok, false, `★${wantDiff} 走樣要驗得出來`);
    assert.equal(r.diff, wantDiff);
  }
  // ★比對器欄位清單不可縮水（預審③：從 const 清單刪一欄＝保證靜靜縮水＝「靜靜通過最危險」的形狀）
  // ——**每一欄**都做一次突變：改壞該欄、diff 必須指認它。
  const TX_FIELDS = ['acctSuffix', 'acctMasked', 'date', 'summary', 'direction', 'amount', 'balance', 'note'];
  for (const f of TX_FIELDS) {
    const a = base();
    a.transactions[0][f] = typeof a.transactions[0][f] === 'number' ? 987 : '走樣值';
    assert.equal(recipeReproduces(base(), a).diff, `transactions[0].${f}`, `★transactions 欄位 ${f} 縮水要紅`);
  }
  const ACC_FIELDS = ['suffix', 'balance', 'currency', 'label', 'note'];
  for (const f of ACC_FIELDS) {
    const a = base();
    a.accounts[0][f] = typeof a.accounts[0][f] === 'number' ? 987 : '走樣值';
    assert.equal(recipeReproduces(base(), a).diff, `accounts[0].${f}`, `★accounts 欄位 ${f} 縮水要紅`);
  }
});

test('出生驗收｜accounts 順序不同不算走樣（逐 masked 對欄位）；transactions 順序不同＝走樣（匯入順序有意義）', () => {
  const a = parseWithRecipe(linesA(), recipeA());
  const b = parseWithRecipe(linesA(), recipeA());
  b.accounts.reverse();
  assert.equal(recipeReproduces(a, b).ok, true);
  const c = parseWithRecipe(linesA(), recipeA());
  [c.transactions[0], c.transactions[1]] = [c.transactions[1], c.transactions[0]];
  assert.equal(recipeReproduces(a, c).ok, false);
});

// ---- 預審③補題：引擎機關逐一釘住（原考題只蓋快樂路徑的部分）----

test('引擎｜sticky 幣別三分法本體：同標題第二戶延續、匯率列不動、看不懂的結構列清成 UNKNOWN', () => {
  // 歷史 bug（bank-statement.js 記載）：每解完一戶就清 pendingCurrency → 同標題第二戶掉哨兵值，
  // 實測後果＝現金虛增 150 倍。這裡把三分法的三個分支各釘一題。
  const lines = [
    L(300, [[20, '合成銀行月結單'], [47, '外幣總覽區']]),
    L(280, [[367, 'JPY']]),
    L(260, [[56, '外幣活儲'], [108, '900300****363'], [436, '$100']]),
    L(250, [[358, '0.196327']]),                                        // ②匯率列＝不動（sticky 的意義）
    L(240, [[56, '外幣活儲'], [108, '900300****364'], [436, '$200']]),  // ①同標題第二戶＝仍 JPY
    L(230, [[56, '看不懂的結構列文字'], [200, '甲乙丙']]),               // ③看不懂＝清成不知道
    L(220, [[56, '外幣活儲'], [108, '900300****365'], [436, '$300']]),  // → UNKNOWN 哨兵
    L(210, [[47, '總計']]),
    L(140, [[47, '合成帳戶總覽'], [200, '往來紀錄']]),   // 讓 docAnchors 認得（不進任何 section）
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900300****363'], [124, 0, '2026/06/11'], [289, 30, '$10'], [418, 0, '$90']]),
  ];
  const r = { ...recipeA(), summary: { ...recipeA().summary, sections: [{ anchor: '外幣總覽', currency: 'BY-CODE' }] },
    detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };   // 此版面表頭沒有單號/附記——點名的欄必須真的在
  const p = parseWithRecipe(lines, r);
  assert.equal(p.accountCurrency['900300****363'], 'JPY');
  assert.equal(p.accountCurrency['900300****364'], 'JPY', '★同標題第二戶要延續 JPY——歷史 150 倍虛增 bug 的回歸釘');
  assert.equal(p.accountCurrency['900300****365'], 'UNKNOWN', '★看不懂的結構列之後＝寧可不知道，絕不漏染上一組幣別');
});

test('引擎｜存入與餘額之間的忽略欄（#408 同型→r25#1 劃界）：整族不支援欄序、拒解退 AI', () => {
  // 演進史：預審①擋「序號被當存款」→ r2 擋「寬序號跨餘額界」→ r25 發現**右對齊的忽略欄值
  // 會漂過 xBal、左緣落進餘額窗＝成為唯一餘額候選**（與真餘額機械上不可分辨、一窗一格也
  // 擋不住——它是第一個候選）＝這個欄位位置（區間終點＝xBal）整族劃出 v1、出生拒解退 AI
  const igRight = { ...recipeA(), detail: { ...recipeA().detail, headerIgnore: ['流水號'], headerNote: null } };
  const header = L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [360, '流水號'], [396, '結存餘額']]);
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]), L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄明細']]), header,
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成入帳'], [335, 20, '$500'], [418, 0, '$1,730']]),
  ], igRight), (e) => e.code === 'recipe_parse_failed',
    '★緊鄰餘額欄左側的忽略欄＝右對齊漂移不可警戒——出生就拒（保護從「擋序號」升級成「拒解版面」）');
});

test('引擎｜退路救援已整段移除（r12→r21 終局）：分不進窗的嚴格金額一律歧義拒解', () => {
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerIgnore: [], headerNote: null } };
  const shell = [
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
  ];
  // 右緣 250+10=260 < 提領欄 272 ＝分不進窗——模板會用「左緣＋中線」退路救成 out；
  // 泛化引擎（r21）：救援帶＝無主地帶（未宣告序號欄的憑空支出來源）＝一律拒解退 AI
  assert.throws(() => parseWithRecipe([
    ...shell,
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成甲'], [250, 10, '$1,234']]),
  ], noIgn), (e) => e.code === 'recipe_parse_failed', '★漂移金額＝退 AI，不猜方向');
  // 長溢出（右緣 ≥ xBal）＝跨界歧義（r12 起既有）
  assert.throws(() => parseWithRecipe([
    ...shell,
    L(83, [[53, 0, '900200****3302'], [124, 0, '2026/06/12'], [177, 0, '合成乙'], [350, 60, '$5,678']]),
  ], noIgn), (e) => e.code === 'recipe_parse_failed', '★長溢出＝分不出寬金額還是漂移餘額＝拒解');
});

test('引擎｜餘額鏈守門條件：差為 0 不覆寫、|差|≠金額不覆寫（亂覆寫比不覆寫更糟）', () => {
  const rows = [
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [349, 40, '$500'], [418, 0, '$1,000']]),
    // 幾何 in、餘額沒動（delta=0）：不可覆寫（覆寫版會判成 out）
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [349, 40, '$500'], [418, 0, '$1,000']]),
    // 幾何 out、delta=+100 但金額 500（差對不上）：不採信、維持幾何 out
    L(80, [[53, 0, '900100****3301'], [124, 0, '2026/06/13'], [289, 30, '$500'], [418, 0, '$1,100']]),
    // $0 交易＋餘額沒動：delta=0 與 |delta|≈金額同時成立——「delta≠0 才採信」是唯一防線（同模板）
    L(70, [[53, 0, '900100****3301'], [124, 0, '2026/06/14'], [349, 40, '$0'], [418, 0, '$1,100']]),
  ];
  const p = parseWithRecipe([...linesA().slice(0, 10), ...rows], recipeA());
  assert.deepEqual(p.transactions.map(t => t.direction), ['in', 'in', 'out', 'in'],
    '★delta=0 與 |delta|≠金額都不覆寫——餘額鏈只在算術咬合時才是權威（$0 列靠 delta≠0 那半守住）');
});

test('引擎｜備註欄同列文字（rowNote）要收——模板同機關的歷史後果＝百萬劃撥誤當收入', () => {
  const p = parseWithRecipe([
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉出'], [289, 30, '$500'], [418, 0, '$730'], [495, 0, '合成備註欄文字']]),
  ], recipeA());
  assert.equal(p.transactions[0].note, '合成備註欄文字', '★x≥備註欄的同列非金額文字要進 note');
});

test('引擎｜balancePick 三選一是三種行為：first-money 取第一個、last-money 取最後一個金額格', () => {
  const doc = (pick) => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區']]),
    L(280, [[50, '丙種活存'], [150, '900100****3301'], [400, '500'], [453, '15,900']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 30, '$10'], [418, 0, '$490']]),
  ], { ...recipeA(), refDate: { strategy: 'none', anchor: null }, summary: { ...recipeA().summary, balancePick: pick },
    detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } });
  assert.equal(doc('first-money').accounts[0].balance, 500, '★first-money＝第一個金額格');
  assert.equal(doc('last-money').accounts[0].balance, 15900, '★last-money＝最後一個金額格');
  assert.equal(doc('first-money').referenceDate, null, '★strategy none＝參考日恆 null（文件裡有日期也不撿）');
});

test('引擎｜餘額空白的帳戶：幣別照記（明細判幣別不 fail-open）、不進餘額更新清單——同模板語意', () => {
  const p = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(270, [[50, '透支戶'], [150, '900200****3302']]),          // 餘額空白（台新對透支負餘額留空）
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900200****3302'], [124, 0, '2026/06/11'], [289, 30, '$10'], [418, 0, '$90']]),
  ], { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } });
  assert.equal(p.accounts.length, 1, '★餘額空白＝不進餘額更新清單');
  assert.equal(p.accountCurrency['900200****3302'], 'TWD', '★幣別照記——這格斷掉、明細幣別就 fail-open');
  assert.equal(p.transactions[0].acctMasked, '900200****3302', '明細照樣解');
});

test('引擎｜空 label 保持空——泛化引擎不猜 label（模板的台新預設值是台新專屬，這裡釘成規格）', () => {
  const p = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區']]),
    L(280, [[150, '900100****3301'], [473, '$1,230']]),   // 帳戶格前沒有任何 label 格
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 30, '$10'], [418, 0, '$1,220']]),
  ], { ...recipeA(), refDate: { strategy: 'none', anchor: null }, detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } });
  assert.equal(p.accounts[0].label, '', '★不填「新臺幣活存」之類的預設——那是台新 hard-code，不是通則');
});

test('引擎｜孤兒備註負例與多片段排序：距離 >40 不亂黏；黏尾＋孤兒依 y 由高到低拼接', () => {
  const far = parseWithRecipe([
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成丙'], [289, 30, '$500'], [418, 0, '$730']]),
    L(10, [[450, 0, '太遠的片段']]),   // 距離 90 > ORPHAN_MAX_DY=40
  ], recipeA());
  assert.equal(far.transactions[0].note, '', '★跨頁/密集列不亂黏——寧留白');
  const multi = parseWithRecipe([
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成丁'], [289, 30, '$500'], [418, 0, '$730 黏尾甲']]),
    L(80, [[450, 0, '孤兒乙']]),
  ], recipeA());
  assert.equal(multi.transactions[0].note, '黏尾甲孤兒乙', '★片段依 y 由高到低拼接（黏尾在列上、孤兒在列下）');
});

test('引擎｜參考日只掃錨點之後：錨點前的日期不撿；錨點後夾了第三個日期＝期間不確定＝null', () => {
  const mk = (cells, strategy) => parseWithRecipe(
    [L(300, [[5, '合成郵局存簿'], ...cells]), ...linesB().slice(1)],
    { ...recipeB(), refDate: { strategy, anchor: strategy === 'anchored-date' ? '結算日' : '帳務期間' } });
  // 同列「期間起訖」印在錨點**前面**：anchored-date 不可撿到起日（預審①實測：原版整列掃＝拿舊蓋新）
  const before = mk([[47, '115/05/01~115/05/31'], [250, '結算日'], [320, '115/06/02']], 'anchored-date');
  assert.equal(before.referenceDate, '2026-06-02', '★取錨點之後的第一個日期，不是整列第一個');
  // 期間錨點行夾了列印日（第三個日期）：不確定哪兩個是期間＝null（同 AI 規則 1a）
  const three = mk([[47, '帳務期間'], [150, '115/05/01'], [220, '~'], [260, '115/05/31'], [340, '列印日 115/06/15']], 'anchored-period-end');
  assert.equal(three.referenceDate, null, '★恰好兩個日期才敢認是期間——第三個日期＝不確定＝null');
});

// ---- Codex r1 的四條阻擋：逐條釘成回歸考題 ----

test('驗證器｜逐槽毒化掃蕩（r1#4：headerNote 漏驗一刀假綠）——每一個文字槽都要過零內容檢', () => {
  // r1 實測：拔掉 headerNote 的 checkSlot、23 題照綠。逐槽掃蕩＝把「哪個槽漏接檢查」整類關掉。
  const SLOT_SETTERS = [
    ['bank', r => { r.bank = '4444'; }],
    ['docAnchors[1]', r => { r.docAnchors[1] = '4444'; }],
    ['refDate.anchor', r => { r.refDate.anchor = '4444'; }],
    ['sections[0].anchor', r => { r.summary.sections[0].anchor = '4444'; }],
    ['sections[1].anchor', r => { r.summary.sections[1].anchor = '4444'; }],
    ['endAnchor', r => { r.summary.endAnchor = '4444'; }],
    ['headerOut', r => { r.detail.headerOut = '4444'; }],
    ['headerIn', r => { r.detail.headerIn = '4444'; }],
    ['headerBalance', r => { r.detail.headerBalance = '4444'; }],
    ['headerNote', r => { r.detail.headerNote = '4444'; }],
    ['headerIgnore[0]', r => { r.detail.headerIgnore = ['4444']; }],
  ];
  for (const [name, poison] of SLOT_SETTERS) {
    const r = recipeA(); poison(r);
    assert.ok(validateRecipeStrict(r).length > 0, `★槽位 ${name} 沒過零內容檢＝可走私帳單內容`);
  }
});

test('引擎｜欄序反轉（r1#1；r21 後無退路）：存入欄在左的版面——主路分欄正確、分不進窗一律拒解', () => {
  const rev = { ...recipeA(), detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: null, headerIgnore: [] } };
  const doc = [
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '存進金額'], [331, '提領金額'], [396, '結存餘額']]),   // ★存進在左
    // 主路：右緣 290+12=302 落在 [存進272, 提領331) → in
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [290, 12, '$500']]),
    // 主路：右緣 340+20=360 落在 [提領331, 結存396) → out
    L(80, [[53, 0, '900100****3301'], [124, 0, '2026/06/13'], [340, 20, '$200']]),
  ];
  const p = parseWithRecipe(doc, rev);
  assert.deepEqual(p.transactions.map(t => [t.direction, t.amount]),
    [['in', 500], ['out', 200]],
    '★欄序反轉的主路分欄正確（in 在左窗、out 在右窗）');
  // 分不進窗的列（右緣 260 < 272）＝r21 起一律拒解（原退路救援已移除）
  assert.throws(() => parseWithRecipe([...doc, L(70, [[53, 0, '900100****3301'], [124, 0, '2026/06/14'], [250, 10, '$700']])], rev),
    (e) => e.code === 'recipe_parse_failed');
});

test('引擎｜餘額右側忽略欄（r1#1）：序號欄在餘額欄右邊——序號不可被當成餘額', () => {
  const ig = { ...recipeA(), detail: { ...recipeA().detail, headerIgnore: ['流水號'], headerNote: null } };
  const p = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [450, '流水號']]),
    // 餘額格在 [396,450)、序號格在 [450,∞)：原版餘額分支先吞所有 x≥xBal ⇒ 0000007 變餘額 7
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 30, '$500'], [400, 0, '$730'], [455, 0, '0000007']]),
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [349, 40, '$100'], [455, 0, '0000008']]),   // 這列餘額真的空白
  ], ig);
  assert.equal(p.transactions[0].balance, 730, '★餘額取餘額欄的 730，不是序號 7');
  assert.equal(p.transactions[1].balance, null, '★餘額空白就是 null——序號不可冒充餘額');
});

test('出生驗收｜同遮罩多帳戶（r1#3）：multiset 一對一——順序互換＝ok、其中一筆錯值＝要抓到', () => {
  // 外幣綜合帳戶＝同一個遮罩帳號掛多幣別（計畫文件明認的真實形狀）；手構 parsed 物件測純函式。
  const mk = () => ({
    bank: '合成銀行', referenceDate: null,
    accounts: [
      { suffix: '363', masked: '900300****363', balance: 100, currency: 'JPY', label: '外幣活儲', note: '' },
      { suffix: '363', masked: '900300****363', balance: 55, currency: 'USD', label: '外幣活儲', note: '' },
    ],
    accountCurrency: { '900300****363': 'USD' },
    transactions: [{ acctSuffix: '363', acctMasked: '900300****363', date: '2026-06-11', summary: '合成', direction: 'in', amount: 1, balance: null, note: '' }],
  });
  const swapped = mk(); swapped.accounts.reverse();
  assert.equal(recipeReproduces(mk(), swapped).ok, true, '★同遮罩兩幣別只換順序＝不算走樣');
  const oneWrong = mk(); oneWrong.accounts[0].balance = 999;
  const r = recipeReproduces(mk(), oneWrong);
  assert.equal(r.ok, false, '★r1 實測形：Map last-wins 會讓第一筆錯值被第二筆蓋掉＝假通過');
  assert.ok(!String(r.diff).includes('900300'), '★diff 不帶帳號');
  const missing = mk(); missing.accounts = [missing.accounts[0], { ...missing.accounts[0] }];
  assert.equal(recipeReproduces(mk(), missing).ok, false, '★同遮罩組組成不同（JPY×2 vs JPY+USD）＝走樣');
});

test('出生把關｜配方對帳單（r1#2）：無數字的交易內文被誤選成錨點——等值約束＋位置約束都要擋', () => {
  // r1 實測形：把收款人文字「合成收款人甲」放進 docAnchors——字元檢查（數字/星號/直線）全過。
  const doc = [
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成收款人甲'], [289, 30, '$500'], [418, 0, '$730']]),
  ];
  const parsed = parseWithRecipe(doc, recipeA());
  assert.deepEqual(validateRecipeAgainstStatement(doc, recipeA(), parsed), [], '★正常配方（錨點都來自版面）通過');
  // ①等值約束：錨點＝某筆交易的摘要
  const evil1 = recipeA(); evil1.docAnchors[1] = '合成收款人甲';
  const errs1 = validateRecipeAgainstStatement(doc, evil1, parsed);
  assert.ok(errs1.length > 0, '★錨點與交易摘要相等＝拒收');
  assert.ok(errs1.every(e => !e.includes('合成收款人甲')), '★錯誤訊息不回聲（那正是交易內文）');
  // ②位置約束：交易列上的其他文字（不等於任何完整欄值、但住在交易列）也不可當錨點
  const doc2 = [...doc.slice(0, -1),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成收款'], [230, 0, '人乙註記'], [289, 30, '$500'], [418, 0, '$730']])];
  const parsed2 = parseWithRecipe(doc2, recipeA());
  const evil2 = recipeA(); evil2.docAnchors[1] = '人乙註記';
  const errsPos = validateRecipeAgainstStatement(doc2, evil2, parsed2);
  assert.ok(errsPos.length > 0, '★錨點命中交易列＝拒收（版面錨點必須來自版面）');
  assert.ok(errsPos.every(e => !e.includes('人乙註記')), '★位置分支的錯誤訊息也不回聲（r4#3b：那正是疑似內文）');
  // ①的獨自承重區：帳戶備註住在**概要區**（不是交易列）——位置約束管不到、只有等值約束擋得住
  const evil3 = recipeA(); evil3.docAnchors[1] = '主要戶';
  assert.ok(validateRecipeAgainstStatement(doc, evil3, parsed).length > 0,
    '★錨點＝帳戶備註（概要區列、非交易列）＝拒收——這一形只有等值約束在守');
  // 驗證器與位置約束是兩道不同的門：字元檢查對這兩形都無感（前提自檢）
  assert.deepEqual(validateRecipeStrict(evil1), [], '前提自檢：字元檢查真的擋不住——所以才需要第二道');
});

// ---- Codex r2 的五條阻擋：同族邊界形逐條釘住 ----

test('引擎｜寬格「跨出」忽略區間＝歧義拒解（r2#1 幽靈形＋r8#1 合法大額形，機械上不可分辨）', () => {
  const ig = { ...recipeA(), detail: { ...recipeA().detail, headerIgnore: ['流水號'], headerNote: null } };
  const doc = (row) => [
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [360, '流水號'], [396, '結存餘額']]),
    row,
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [335, 20, '$500'], [400, 0, '$1,730']]),
  ];
  // r2#1 幽靈形：序號 x=365、w=45 ⇒ 右緣 410 跨過 xBal——猜金額＝幽靈存款 67,890
  assert.throws(() => parseWithRecipe(doc(
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [365, 45, '0067890']])), ig),
    (e) => e.code === 'recipe_parse_failed',
    '★r8#1 起改歧義拒解：與「合法大額左緣飄進忽略欄」不可分辨——不猜、整份退 AI');
  // r8#1 合法大額形：**同一個幾何**（左緣 365 在忽略區、右緣 410 跨出）、內容換成真金額——
  // 兩形機械上讀到的座標一模一樣＝這就是「不可分辨、只能拒解」的證明
  assert.throws(() => parseWithRecipe(doc(
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [365, 45, '$800']])), ig),
    (e) => e.code === 'recipe_parse_failed',
    '★猜忽略＝真支出被無聲吞掉（餘額鏈仍可自洽、強閘照綠）——同一條歧義規則拒解');
});

test('引擎｜餘額欄不在金額欄右側（r2#2）：「支出｜餘額｜存入」欄序＝出生拒解，不讓它孵化後漏錢', () => {
  const rec = { ...recipeA(), detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: null, headerIgnore: [] } };
  const doc = [
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '結存餘額'], [396, '存進金額']]),   // ★餘額夾中間
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 30, '$500'], [340, 0, '$730']]),
  ];
  assert.throws(() => parseWithRecipe(doc, rec), (e) => e.code === 'recipe_parse_failed',
    '★r2 實測：這種欄序能用「只有支出」的帳單孵化，下一份的存入整筆消失且強閘照樣放行——必須出生就拒');
});

test('引擎｜配方點名的欄必須真的在表頭（r2#3 前半）：headerNote／headerIgnore 在表頭缺席＝拒解', () => {
  const doc = [
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),   // 沒有單號、附記
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 30, '$500'], [418, 0, '$730']]),
  ];
  assert.throws(() => parseWithRecipe(doc, recipeA()), (e) => e.code === 'recipe_parse_failed',
    '★表頭沒有點名的欄＝xNote/忽略欄靜默歸零的走私路，關成結構性失敗');
  const noteOnly = { ...recipeA(), detail: { ...recipeA().detail, headerIgnore: [] } };
  assert.throws(() => parseWithRecipe(doc, noteOnly), (e) => e.code === 'recipe_parse_failed', '★headerNote 缺席單獨也要拒');
});

test('出生把關｜headerNote／headerIgnore 也要過等值＋位置約束（r2#3 後半）', () => {
  const doc = [
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成收款人甲'], [289, 30, '$500'], [418, 0, '$730']]),
  ];
  const parsed = parseWithRecipe(doc, recipeA());
  const evil = recipeA(); evil.detail.headerNote = '合成收款人甲';
  const errs = validateRecipeAgainstStatement(doc, evil, parsed);
  assert.ok(errs.length > 0, '★headerNote＝交易摘要＝拒收（單槽直接攜帶內文，不屬 #452 排除範圍）');
  assert.ok(errs.every(e => !e.includes('合成收款人甲')), '★不回聲');
  const evil2 = recipeA(); evil2.detail.headerIgnore = ['合成收款人甲'];
  assert.ok(validateRecipeAgainstStatement(doc, evil2, parsed).length > 0, '★headerIgnore 同樣要過');
});

test('引擎｜date-first 同遮罩多幣別（r2#4）：帳戶「身分」數不是遮罩鍵數——歧義版面拒解', () => {
  // r2 實測形：同遮罩 USD＋TWD 在 accountCurrency 塌成一鍵＝原版放行，外幣利息被套上 TWD 權威幣別
  const doc = [
    L(300, [[20, '合成郵局存簿'], [47, '帳務期間'], [200, '115/05/01'], [280, '~'], [320, '115/05/31']]),
    L(280, [[47, '帳戶彙整']]),
    L(260, [[50, '活期儲金'], [150, '900200****7788'], [453, '8,000']]),
    L(250, [[47, '小計']]),
    L(245, [[47, '外幣區']]),
    L(240, [[367, 'USD']]),
    L(235, [[50, '外幣存款'], [150, '900200****7788'], [453, '120']]),   // ★同遮罩、USD
    L(230, [[47, '小計']]),
    L(220, [[47, '交易紀錄']]),
    L(200, [[60, '日期'], [150, '摘要'], [272, '支出'], [331, '存入'], [396, '餘額']]),
    L(180, [[60, 0, '115/05/02'], [150, 0, '合成繳費'], [289, 30, '1,200'], [414, 0, '6,800']]),
  ];
  const rec = { ...recipeB(), summary: { sections: [{ anchor: '帳戶彙整', currency: 'TWD' }, { anchor: '外幣區', currency: 'BY-CODE' }], endAnchor: '小計', balancePick: 'last-money' } };
  // ⚠️ **期望碼在 #517 批一改變（由 recipe_parse_failed → bank_mixed_currency）**，而且原本那句
  //   「拒解**退 AI**」現在知道是不安全的：退 AI 之後，AI 只要漏掉外幣區就會把它當純台幣接受並匯入
  //   （Codex #517 r6#1 實測 aiAccepted:true、level:strong）。同遮罩混台幣＋外幣是**版面事實**，
  //   看到的那一方說了算 ⇒ 終局碼、三條路都不再落到規則卡／AI 救援。歧義拒解的語意沒有放寬，是**加嚴**。
  assert.throws(() => parseWithRecipe(doc, rec), (/** @type {any} */ e) => e.code === 'bank_mixed_currency',
    '★同遮罩兩種幣別＝終局拒收（不是「這張配方不合用、換 AI 試試」）');
});

test('出生驗收｜masked 換值＝帳戶組成不同（r2#6：分組鍵改壞要被抓到）', () => {
  const base = () => parseWithRecipe(linesA(), recipeA());
  const a = base(); a.accounts[0].masked = '900900****9999';
  const r = recipeReproduces(base(), a);
  assert.equal(r.ok, false);
  assert.equal(r.diff, 'accounts（帳戶組成不同）', '★分組鍵（masked）走樣＝組成差異，不可靜靜通過');
});

// ---- Codex r3：命中歧義、考題假綠、零正則行為釘 ----

test('驗證器｜區段錨點互為子字串＝拒收（r3#1：「帳戶」⊂「外幣帳戶」＋first-hit＝外幣被當台幣入帳）', () => {
  const r = recipeA();
  r.summary.sections = [{ anchor: '帳戶總覽', currency: 'TWD' }, { anchor: '外幣帳戶總覽', currency: 'BY-CODE' }];
  const errs = validateRecipeStrict(r);
  assert.ok(errs.length > 0, '★重疊錨點＝命中歧義，出生就拒——強閘只驗台幣、驗不出外幣被冒名台幣');
  assert.ok(errs.some(e => e.includes('互為子字串')), '要指認是重疊問題');
  const ok = recipeA();
  ok.summary.sections = [{ anchor: '新臺幣總覽', currency: 'TWD' }, { anchor: '外幣總覽', currency: 'BY-CODE' }];
  assert.deepEqual(validateRecipeStrict(ok), [], '不重疊的正常雙段照過');
});

test('引擎｜headerIgnore 單獨缺席也要拒（r3#3：原考題同時缺兩者＝headerIgnore 檢查拔掉照綠）', () => {
  const noteNull = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null } };   // 仍點名「單號」
  const doc = [
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),   // 沒有單號
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 30, '$500'], [418, 0, '$730']]),
  ];
  assert.throws(() => parseWithRecipe(doc, noteNull), (e) => e.code === 'recipe_parse_failed',
    '★headerNote=null、只有 headerIgnore 缺席——這一形必須獨立轉紅');
});

test('引擎｜錨點是字面不是樣式（r3#4：零正則的行為守門）：regex 特殊字元一律當普通字', () => {
  const r = recipeA(); r.docAnchors = ['合成帳戶總覽', '往來(紀)錄'];
  assert.equal(recipeMatches(linesA(), r), false,
    '★「往來(紀)錄」≠「往來紀錄」——被當樣式解讀（括號成群組）就會 match＝配方偷渡了正則語意');
  const doc = linesA(); doc[8] = L(140, [[47, '往來(紀)錄明細']]);
  assert.equal(recipeMatches(doc, r), true, '★字面出現＝match（跳脫正確、不誤殺真含括號的版面）');
});

// ---- Codex r4：冒名交易兩洞＋零正則全族行為釘 ----

test('引擎｜date-first 交易列必須有餘額格（r4#1：日期開頭的利率資訊列＝偽交易、又落強閘首末筆盲區）', () => {
  const doc = [
    ...linesB(),
    L(150, [[60, 0, '115/06/01'], [150, 0, '合成利率資訊'], [349, 40, '50']]),   // 日期形狀＋數字、無餘額
  ];
  const p = parseWithRecipe(doc, recipeB());
  assert.equal(p.transactions.length, 2, '★資訊列不可變成第三筆交易——偽列無餘額＝末筆餘額檢查退 skip、閘攔不住');
  assert.deepEqual(p.transactions.map(t => t.amount), [1200, 2000]);
});

test('引擎｜備註欄夾在金額欄之間（r4#2）：數字型備註不可被當成金額', () => {
  const rec = { ...recipeA(), detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: '附記', headerIgnore: [] } };
  const p = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [310, '附記'], [331, '存進金額'], [396, '結存餘額']]),
    // 備註欄的數字 777（右緣 322 落在 [附記310, 存進331)）＋真存入 $500（右緣 355 落在存進窗）
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [312, 10, '777'], [335, 20, '$500'], [400, 0, '$1,730']]),
  ], rec);
  assert.deepEqual(p.transactions.map(t => [t.direction, t.amount]), [['in', 500]],
    '★777 是備註不是支出——原版會產生偽造支出 777 且落首筆盲區、強閘攔不住');
  // 備註欄在**餘額右側**（台新形）＋數字型備註：餘額分支不可把它吃成餘額
  const p2 = parseWithRecipe([
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 30, '$500'], [495, 10, '777']]),   // 餘額空白、附記欄數字
  ], recipeA());
  assert.equal(p2.transactions[0].balance, null,
    '★餘額空白就是 null——附記欄的 777 不可冒充餘額（餘額分支也要過備註區間）');
});

test('引擎｜零正則全族行為釘（r4#3a）：section／endAnchor／refDate／header 的比對都是字面不是樣式', () => {
  // section：錨點帶括號＝不得樣式命中「合成帳戶總覽區」——台幣區不開張、台幣明細帳號
  // 不在幣別表 ⇒ 整份拒解（r5#2 權威牆）；樣式解讀會讓區開張、整份解成功＝可觀察的差異
  const sec = recipeA(); sec.summary.sections = [{ anchor: '合成帳戶總(覽)', currency: 'TWD' }, { anchor: '外幣總覽', currency: 'BY-CODE' }];
  assert.throws(() => parseWithRecipe(linesA(), sec), (e) => e.code === 'recipe_parse_failed',
    '★「總(覽)」≠「總覽」——字面比對＝台幣區不開張＝拒解');
  // refDate：錨點帶括號＝不得命中「結算基準日」
  const ref = recipeA(); ref.refDate = { strategy: 'anchored-date', anchor: '結算基準(日)' };
  assert.equal(parseWithRecipe(linesA(), ref).referenceDate, null, '★參考日錨點是字面');
  // header：欄標題帶括號＝表頭認不出＝結構性失敗
  const hdr = recipeA(); hdr.detail = { ...hdr.detail, headerOut: '提領(金)額' };
  assert.throws(() => parseWithRecipe(linesA(), hdr), (e) => e.code === 'recipe_parse_failed', '★欄標題是字面');
  // endAnchor：帶括號＝不得命中「總計」＝概要區永不收尾 ⇒ 撞到明細表頭時被 r6#1 守門拒解；
  // 樣式解讀會讓「總計」收尾、整份解成功＝可觀察的差異
  const end = recipeA(); end.summary.endAnchor = '總(計)';
  assert.throws(() => parseWithRecipe(linesA(), end), (e) => e.code === 'recipe_parse_failed',
    '★endAnchor 是字面＝「總計」不收尾＝概要未收尾拒解');
});

// ---- Codex r5：主路左緣區間＋明細帳號權威牆 ----

test('引擎｜寬格左緣在忽略/備註區間、右緣跨進金額窗（r5#1→r8#1）：歧義拒解、不猜任何一邊', () => {
  // 形一：流水號格 [200,272) 起、寬 80 ⇒ 右緣 290 跨進提領窗——r5 版猜「忽略」會把
  // 合法大額（左緣飄進忽略欄的右對齊金額）無聲吞掉（r8#1 反例）＝改歧義拒解
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [210, 80, '0067890']]),
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [349, 40, '$500'], [418, 0, '$1,730']]),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed', '★跨窗寬格＝歧義、整份退 AI');
  // 形二：備註格 [310,331) 起、寬 25 ⇒ 右緣 337 跨進存進窗——同一條規則
  const rec = { ...recipeA(), detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: '附記', headerIgnore: [] } };
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [310, '附記'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [312, 25, '777'], [289, 15, '$500'], [400, 0, '$730']]),
  ], rec), (e) => e.code === 'recipe_parse_failed', '★777 跨窗＝歧義拒解（猜備註或猜收入都可能錯）');
});

test('引擎｜明細帳號必須在概要幣別表（r5#2）：概要認不得的帳戶＝拒解，不可自洽入帳', () => {
  // r5 實測形：概要只有 3301、明細兩筆 900900****9999 餘額鏈自洽（1000→1200）——
  // 原版照匯進不存在的帳戶且強閘 strong/ok（AI 路線的同款牆＝ai-parse r3#1，配方引擎漏了）
  const doc = [
    ...linesA().slice(0, 2),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
    L(100, [[53, 0, '900900****9999'], [124, 0, '2026/06/11'], [349, 40, '$100'], [418, 0, '$1,100']]),
    L(90, [[53, 0, '900900****9999'], [124, 0, '2026/06/12'], [349, 40, '$100'], [418, 0, '$1,200']]),
  ];
  assert.throws(() => parseWithRecipe(doc, recipeA()), (e) => e.code === 'recipe_parse_failed' && !/9999/.test(e.message),
    '★明細帳號不在概要幣別表＝整份拒解（訊息不回聲帳號）——快取後遇到新帳戶寧退 AI 不無聲入帳');
});

// ---- Codex r6：概要收尾守門＋角色撞名全域禁令 ----

test('引擎｜概要區未收尾就進明細＝拒解（r6#1：明細交易列會污染幣別表＝權威牆被自己餵毒）', () => {
  // r6 實測形：後續帳單少了外幣區的收尾列 ⇒ section 還開著就撞到明細表頭——
  // 原版概要迴圈會把明細的陌生帳戶列當帳戶列登記成該區幣別、權威牆照放行
  const doc = linesA().filter((_, i) => i !== 7);   // 拿掉外幣區的「總計」收尾列
  assert.throws(() => parseWithRecipe(doc, recipeA()), (e) => e.code === 'recipe_parse_failed',
    '★收尾列缺席/改名的版面＝拒解退 AI，不讓明細列進概要迴圈');
});

test('驗證器｜欄位角色撞名全域禁令（r6#2）：忽略欄/備註欄撞金額欄名＝整欄吃掉或翻向', () => {
  for (const [patch, why] of [
    [r => { r.detail.headerIgnore = ['提領金額']; }, '忽略欄撞支出欄名＝整欄支出被吃掉'],
    [r => { r.detail.headerNote = '存進金額'; }, '備註欄撞存入欄名＝存款變備註'],
    [r => { r.detail.headerIgnore = ['附記']; }, '忽略欄撞備註欄名'],
    [r => { r.detail.headerNote = '單 號'; }, '備註欄撞忽略欄名（squash 後判＝空白繞不過）'],
  ]) {
    const r = recipeA(); patch(r);
    assert.ok(validateRecipeStrict(r).length > 0, `★${why}：必須拒收`);
  }
  // 幣別欄的型別牆（r6 建議）：陣列包裝 String() 後會矇混過 regex
  const cur = recipeA(); cur.summary.sections[0].currency = ['TWD'];
  assert.ok(validateRecipeStrict(cur).length > 0, '★currency 必須是字串——[\'TWD\'] 不是');
});

// ---- Codex r7：x 重疊反例＋忽略欄文字污染摘要 ----

test('引擎｜不同角色共用同一 x＝拒解（r7#1：反例推翻「名字不同 ⇒ x 互斥」——BLine 允許同 x 兩格）', () => {
  const doc = [
    ...linesA().slice(0, 9),
    // 「單號」與「提領金額」都在 x=272——原版忽略區間 [272,331) 蓋住支出窗＝整欄支出被吞；
    // 存入列照樣入帳 ⇒ 少一筆支出、餘額鏈仍可自洽＝強閘照綠（Codex r7 實測形）
    L(120, [[75, '帳號'], [135, '日期'], [272, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 30, '$100'], [418, 0, '$1,130']]),
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [349, 40, '$500'], [418, 0, '$1,630']]),
    L(80, [[53, 0, '900100****3301'], [124, 0, '2026/06/13'], [349, 40, '$300'], [418, 0, '$1,930']]),
  ];
  assert.throws(() => parseWithRecipe(doc, recipeA()), (e) => e.code === 'recipe_parse_failed',
    '★互斥角色共用 x＝座標層自己驗、出生就拒——漏一欄支出是「會漏錢」級');
});

test('引擎｜忽略欄的文字值不進摘要與備註（r7#2：「劃撥」污染摘要＝一般支出被分箱成內轉、現金流少算）', () => {
  // r25 劃界後：忽略欄改放**支出欄左側**（合法位置——緊鄰餘額欄左側那族已拒解）；本題意圖不變
  const ig = { ...recipeA(), detail: { ...recipeA().detail, headerIgnore: ['處理類別'], headerNote: null } };
  const p = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '處理類別'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '一般扣款'], [205, 0, '劃撥'], [289, 15, '$100'], [418, 0, '$900']]),
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [177, 0, '一般扣款'], [205, 0, '劃撥'], [289, 15, '$100'], [418, 0, '$800']]),
  ], ig);
  assert.deepEqual(p.transactions.map(t => t.summary), ['一般扣款', '一般扣款'],
    '★「劃撥」住在忽略欄＝不進摘要——進了就會被分箱成內轉（劃撥判準判全文）');
  const boxed = classifyBankTx(p.transactions[1], new Set());
  assert.equal(boxed.type, 'expense', '★端到端：分箱結果必須是支出、不是內轉（r7 實測現金流少算 $100 的形）');
  // r13#1：r7 版夾具 headerNote:null＝note 路徑其實沒被驗——忽略欄的**獨立換行**列經孤兒
  // 路徑黏進 note、同樣誤判內轉；補 headerNote 在場＋忽略欄獨立列的形
  const igNote = { ...recipeA(), detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: '附記', headerIgnore: ['處理類別'] } };
  const p3 = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [430, '處理類別'], [489, '附記']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [400, 0, '$800'], [495, 0, '合成正常註']]),
    L(92, [[435, 0, '劃撥']]),   // ★忽略欄的獨立換行列（孤兒路徑）——出生月份沒有它＝三關全過
    L(84, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [289, 15, '$100'], [400, 0, '$700']]),
  ], igNote);
  assert.ok(p3.transactions.every(t => !t.note.includes('劃撥')), '★忽略欄的獨立列不可經孤兒路徑黏進 note');
  assert.equal(classifyBankTx(p3.transactions[0], new Set()).type, 'expense', '★端到端：不可被「劃撥」翻成內轉');
  assert.equal(p3.transactions[0].note, '合成正常註', '真備註照收——孤兒過濾是逐格、不是整列丟');
});

// ---- Codex r8：銀行身分綁定＋bank 內文檢＋帳戶列數＋逐層鍵白名單 ----

test('引擎｜銀行身分綁定（r8#2）：文件沒印這家銀行的名字＝拒解——別行帳單不可被冒名解析', () => {
  // r8 實測形：乙銀行帳單與甲銀行配方共用暗號與幾何 ⇒ 原版輸出仍標甲銀行、
  // 機構戳與 bank2 去重鍵全錯且強閘照綠。機械驗證＝全文必須印有配方那家銀行
  const evilDoc = linesA().map(l => ({ ...l, cells: l.cells.map(c => c.s === '合成銀行月結單' ? { ...c, s: '乙方銀行月結單' } : c) }));
  assert.throws(() => parseWithRecipe(evilDoc, recipeA()), (e) => e.code === 'recipe_parse_failed',
    '★帳單印的是「乙方銀行」＝甲配方拒解（暗號與幾何相同也一樣）');
  assert.equal(parseWithRecipe(linesA(), recipeA()).bank, '合成銀行', '正主印了名字＝照常解');
});

test('出生把關｜bank 槽的等值檢（r8#3）：交易摘要填進 bank＝三關要有一關擋', () => {
  const doc = [
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '敏感收款方'], [289, 30, '$500'], [418, 0, '$730']]),
  ];
  const parsed = parseWithRecipe(doc, recipeA());
  const evil = { ...recipeA(), bank: '敏感收款方' };
  const errs = validateRecipeAgainstStatement(doc, evil, parsed);
  assert.ok(errs.length > 0, '★bank＝交易摘要＝拒收（單槽直通路，不屬 #452 排除範圍）');
  assert.ok(errs.every(e => !e.includes('敏感收款方')), '★不回聲');
  // 位置檢刻意不做：銀行短名本來就會出現在交易列（「XX卡費」）——只有等值檢在守 bank
});

test('引擎｜date-first 概要帳戶「列數」恰一（r8#4）：同遮罩同幣別的兩個帳戶＝身分數也塌、列數不塌', () => {
  const doc = [
    L(300, [[20, '合成郵局存簿'], [47, '帳務期間'], [200, '115/05/01'], [280, '~'], [320, '115/05/31']]),
    L(280, [[47, '帳戶彙整']]),
    L(260, [[50, '甲戶'], [150, '900200****7788'], [453, '8,000']]),
    L(250, [[50, '乙戶'], [150, '900200****7788'], [453, '8,000']]),   // ★同遮罩、同 TWD、不同帳戶
    L(240, [[47, '小計']]),
    L(220, [[47, '交易紀錄']]),
    L(200, [[60, '日期'], [150, '摘要'], [272, '支出'], [331, '存入'], [396, '餘額']]),
    L(180, [[60, 0, '115/05/02'], [150, 0, '合成繳費'], [289, 30, '1,200'], [414, 0, '6,800']]),
  ];
  assert.throws(() => parseWithRecipe(doc, recipeB()), (e) => e.code === 'recipe_parse_failed',
    '★兩列帳戶＝交易歸屬歧義（就算遮罩幣別都相同）——r2#4 的身分 Set 會塌成一、列數不會');
});

test('驗證器｜逐層鍵白名單（r8#5 建議）：頂層／refDate／summary／section／detail 各塞一個多餘鍵都要拒', () => {
  for (const [patch, why] of [
    [r => { r.多餘 = 1; }, '頂層'],
    [r => { r.refDate.多餘 = 1; }, 'refDate'],
    [r => { r.summary.多餘 = 1; }, 'summary'],
    [r => { r.summary.sections[0].多餘 = 1; }, 'section'],
    [r => { r.detail.多餘 = 1; }, 'detail'],
  ]) {
    const r = recipeA(); patch(r);
    assert.ok(validateRecipeStrict(r).length > 0, `★${why} 層的多餘鍵要拒（r8 實測：拔兩層 checkKeys 照綠）`);
  }
});

// ---- Codex r9：三條已定規則的實作缺口 ----

test('引擎｜銀行名必須在非交易列（r9#1）：出現在交易摘要不算數——「合成郵局卡費」不是發單機構', () => {
  // 乙方郵局的帳單、其中一筆交易的摘要含「合成郵局」——原版全文檢照樣放行冒名
  const doc = [
    L(300, [[20, '乙方郵局存簿'], [47, '帳務期間'], [200, '115/05/01'], [280, '~'], [320, '115/05/31']]),
    L(280, [[47, '帳戶彙整']]),
    L(260, [[50, '活期儲金'], [150, '900200****7788'], [453, '8,000']]),
    L(240, [[47, '小計']]),
    L(220, [[47, '交易紀錄']]),
    L(200, [[60, '日期'], [150, '摘要'], [272, '支出'], [331, '存入'], [396, '餘額']]),
    L(180, [[60, 0, '115/05/02'], [150, 0, '合成郵局卡費'], [289, 30, '1,200'], [414, 0, '6,800']]),
  ];
  assert.throws(() => parseWithRecipe(doc, recipeB()), (e) => e.code === 'recipe_parse_failed',
    '★銀行名只出現在交易列＝那是乙行帳單上關於甲行的一筆交易、不是發單機構——拒解');
});

test('引擎｜歧義判定認「同一個區間」（r9#2）：寬格從忽略欄跨過支出欄、落進另一個忽略欄＝照樣拒解', () => {
  const ig2 = { ...recipeA(), detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: null, headerIgnore: ['單號', '類別'] } };
  const doc = [
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [310, '類別'], [331, '存進金額'], [396, '結存餘額']]),
    // 寬格：左緣 210 在 [單號200,提領272)、右緣 210+110=320 落進 [類別310,存進331)——
    // 左右都是 'ign' 但**不同區間**、中間跨過整個支出欄：原版靜默跳過＝首筆支出無聲消失
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [210, 110, '$100']]),
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [345, 10, '$500'], [400, 0, '$1,730']]),
  ];
  assert.throws(() => parseWithRecipe(doc, ig2), (e) => e.code === 'recipe_parse_failed',
    '★右緣必須留在左緣所屬的那一個區間內——跨出去（不管落在哪）＝歧義拒解');
});

test('引擎｜負數 running 餘額（r9#3）：-100 是合法餘額、整列要在——splitAmount 的配方旗標', () => {
  const doc = [
    ...linesB().slice(0, 6),
    L(180, [[60, 0, '115/05/02'], [150, 0, '合成扣款'], [289, 30, '8,100'], [414, 0, '-100']]),   // 餘額轉負
    L(170, [[60, 0, '115/05/10'], [150, 0, '合成入帳'], [349, 40, '300'], [414, 0, '200']]),
    L(160, [[60, 0, '115/05/20'], [150, 0, '合成入帳'], [349, 40, '100'], [414, 0, '300']]),
  ];
  const p = parseWithRecipe(doc, recipeB());
  assert.equal(p.transactions.length, 3, '★負餘額列不可整筆消失（原版：splitAmount 不收負號→bs null→date-first 丟列）');
  assert.deepEqual(p.transactions.map(t => t.balance), [-100, 200, 300]);
  assert.equal(p.transactions[0].direction, 'out', '餘額鏈 8000→-100＝支出 8100，方向覆寫照常');
  // 模板行為凍結釘（bankRef 含餘額段＝位元組級凍結）：不帶旗標的 splitAmount 對負號照舊回 null
  assert.equal(splitAmount({ x: 0, w: 0, s: '-100' }), null, '★模板呼叫端不帶旗標＝台新負餘額判讀不變');
  assert.deepEqual(splitAmount({ x: 0, w: 0, s: '-100' }, true), { amt: -100, rest: '' });
});

// ---- Codex r10：續行冒領、餘額漂移、凍結真釘 ----

test('引擎｜銀行名必須在明細表頭之前（r10#1）：交易的換行續行文字（孤兒備註列）也不算身分證據', () => {
  // 乙方郵局帳單、表頭之後有一列孤兒續行「合成郵局卡費」——r9 版「非交易列」會被它冒領
  const doc = [
    L(300, [[20, '乙方郵局存簿'], [47, '帳務期間'], [200, '115/05/01'], [280, '~'], [320, '115/05/31']]),
    L(280, [[47, '帳戶彙整']]),
    L(260, [[50, '活期儲金'], [150, '900200****7788'], [453, '8,000']]),
    L(240, [[47, '小計']]),
    L(220, [[47, '交易紀錄']]),
    L(200, [[60, '日期'], [150, '摘要'], [272, '支出'], [331, '存入'], [396, '餘額']]),
    L(180, [[60, 0, '115/05/02'], [150, 0, '一般扣款'], [289, 30, '1,200'], [414, 0, '6,800']]),
    L(170, [[380, 0, '合成郵局卡費']]),   // ★換行續行：非交易列、但在表頭之後
  ];
  assert.throws(() => parseWithRecipe(doc, recipeB()), (e) => e.code === 'recipe_parse_failed',
    '★銀行名只出現在表頭之後＝不是發單機構——標題/概要區（表頭之前）才算數');
});

test('引擎｜date-first 餘額格左緣漂移（r10#2）：跨餘額欄界＝歧義拒解，不可整列無聲消失', () => {
  const doc = [
    ...linesB().slice(0, 6),
    // 大額餘額「100,000」右對齊：左緣 390 < xBal=396、右緣 430 跨進餘額欄——原版當「無餘額」丟列
    L(180, [[60, 0, '115/05/02'], [150, 0, '合成入帳'], [349, 40, '92,000'], [390, 40, '100,000']]),
    L(170, [[60, 0, '115/05/10'], [150, 0, '合成扣款'], [289, 30, '99,000'], [414, 0, '1,000']]),
  ];
  assert.throws(() => parseWithRecipe(doc, recipeB()), (e) => e.code === 'recipe_parse_failed',
    '★分不出是寬金額還是漂移餘額＝拒解——原版首筆入帳 100,000 消失且強閘照綠');
});

test('模板凍結｜parseBankDetail 對負餘額照舊回 null（r10#3：真呼叫端釘、不是 helper 釘）', () => {
  // bankRef 含餘額段＝位元組級凍結：模板對負餘額的判讀一變、歷史資料重匯判不出重複
  const txs = parseBankDetail([
    L(120, [[75, '帳號'], [135, '日期'], [185, '摘要'], [272, '支出金額'], [331, '存入金額'], [396, '帳戶餘額'], [489, '備註']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成扣款'], [289, 30, '$100'], [418, 0, '-100']]),
  ]);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].balance, null, '★台新模板不收負餘額＝凍結行為——這題直接走 parseBankDetail、模板呼叫端偷帶 allowNegative 就紅');
});

// ---- Codex r11：$ 文字冒充金額、-$100、currency 白名單、通用機構詞 ----

test('引擎｜含 $ 的摘要文字不冒充金額（r11#1）：「訂單 $100」是文字、$500 才是支出', () => {
  // ⚠️ 幾何要避開忽略/備註區間（那些分支會先吞掉文字格＝嚴格檢查沒被走到＝刀測不出，
  // 62/63 號刀第一版就是這樣活下來的）——版面不設忽略欄、文字格直接落在金額窗內
  const noIgn = { ...recipeA(), detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: null, headerIgnore: [] } };
  const header = L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]);
  const shell = [...linesA().slice(0, 9), header];
  // 主路：「訂單 $100」右緣 310 落在提領窗 [272,331)、排在真支出 $500 前面——
  // 冒充版會把它當 outCell（偽支出 100）
  const p = parseWithRecipe([
    ...shell,
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [280, 30, '訂單 $100'], [300, 25, '$500'], [418, 0, '$730']]),
  ], noIgn);
  assert.deepEqual(p.transactions.map(t => [t.direction, t.amount]), [['out', 500]],
    '★金額窗只收整格可解的嚴格金額——夾字的 $ 格冒充＝偽支出 100 且強閘照綠（r11 實測形）');
  // 退路同一把尺：夾字 $ 格右緣分不出欄（260 < 272）＝落退路——不可被撈成金額
  const p2 = parseWithRecipe([
    ...shell,
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [250, 10, '訂單 $100']]),
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [349, 40, '$500'], [418, 0, '$1,730']]),
  ], noIgn);
  assert.equal(p2.transactions.length, 1, '★退路也不收夾字 $ 格');
});

test('引擎｜負餘額三種印法（r11#2）：-100／$-100／-$100 都收；雙負號看不懂回 null', () => {
  for (const [txt, want] of [['-100', -100], ['$-100', -100], ['-$100', -100], ['100', 100], ['$100', 100]]) {
    assert.deepEqual(splitAmount({ x: 0, w: 0, s: txt }, true), { amt: want, rest: '' }, `★${txt}`);
  }
  assert.equal(splitAmount({ x: 0, w: 0, s: '-$-100' }, true), null, '雙負號＝看不懂');
  // date-first 端到端：-$100 的列要在
  const doc = [
    ...linesB().slice(0, 6),
    L(180, [[60, 0, '115/05/02'], [150, 0, '合成扣款'], [289, 30, '8,100'], [414, 0, '-$100']]),
    L(170, [[60, 0, '115/05/10'], [150, 0, '合成入帳'], [349, 40, '300'], [414, 0, '200']]),
  ];
  const p = parseWithRecipe(doc, recipeB());
  assert.equal(p.transactions.length, 2, '★-$100 的列不可整筆消失');
  assert.equal(p.transactions[0].balance, -100);
});

test('驗證器｜currency 白名單（r11#3）：任意三碼大寫是單槽直通路——「ATM」拒收、支援清單內照過', () => {
  const evil = recipeA(); evil.summary.sections[1] = { anchor: '外幣總覽', currency: 'ATM' };
  assert.ok(validateRecipeStrict(evil).length > 0, '★「ATM」不是幣別是內文——白名單拒收');
  const ok = recipeA(); ok.summary.sections[1] = { anchor: '外幣總覽', currency: 'USD' };
  assert.deepEqual(validateRecipeStrict(ok), [], 'USD 在支援清單＝照過');
});

test('驗證器｜bank 不可只有通用機構詞（r11#4）：「銀行」哪一家都匹配＝機構戳與跨行去重全毀', () => {
  for (const generic of ['銀行', '商業銀行', '郵局', '銀行分行']) {
    const r = recipeA(); r.bank = generic;
    assert.ok(validateRecipeStrict(r).length > 0, `★bank='${generic}'：拒收`);
  }
  for (const okName of ['台新', '合成銀行', '合成郵局']) {
    const r = recipeA(); r.bank = okName;
    assert.deepEqual(validateRecipeStrict(r), [], `bank='${okName}' 有可辨識的字＝照過`);
  }
});

// ---- Codex r12：acct-date 跨界＋參考日先取位再驗 ----

test('引擎｜acct-date 的漂移餘額（r12#1）：嚴格金額格跨餘額欄界＝拒解；黏尾形無餘額列也拒', () => {
  // r12 實測形：真支出 $1,000 在提領窗、餘額 100,000 左緣漂過 xBal——原版把漂移餘額
  // 退路撈成存入、該列餘額 null、餘額鏈無從糾正、強閘照綠
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$1,000'], [390, 40, '100,000']]),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed', '★嚴格金額格跨界＝兩種列判準一律歧義拒解');
  // 黏尾形（非嚴格）漂移餘額＋無 bs：same
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$1,000'], [390, 40, '$100,000 黏尾']]),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed', '★黏尾形漂移餘額（非嚴格金額）也拒——無餘額列有跨界候選＝歧義');
  // 有餘額格的列＋跨界嚴格金額：一樣拒（這一形只有主路的跨界檢在守——67 號刀的獨自承重域）
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$1,000'], [390, 40, '100,000'], [418, 0, '$5,000']]),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed', '★有餘額格也不能默吞跨界金額——那可能是第二筆金額');
});

test('引擎｜參考日先取位再驗真（r12#2）：目標位置是壞日期＝null、不可順位遞補到列印日', () => {
  // anchored-date：目標（第一個）是 2026/13/31（壞）＋後面跟著列印日——原版 filter 先濾掉壞的、撿到列印日
  const bad1 = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/13/31 列印日:2027/01/02']]),
    ...linesA().slice(1),
  ], recipeA());
  assert.equal(bad1.referenceDate, null, '★目標位置不合法就是 null——遞補到列印日＝拿舊蓋新的風險');
  // anchored-period-end：期間結束日是壞日期＝null（起日合法也不遞補）
  const bad2 = parseWithRecipe([
    L(300, [[20, '合成郵局存簿'], [47, '帳務期間'], [200, '115/05/01'], [280, '~'], [320, '115/13/31']]),
    ...linesB().slice(1),
  ], recipeB());
  assert.equal(bad2.referenceDate, null, '★期間結束日不合法＝null');
  // 鎖定語意：錨點行給了（壞）日期＝定案，後面再出現合法錨點行也不遞補
  const bad3 = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/13/31']]),
    L(295, [[452, '結算基準日:2026/06/30']]),
    ...linesA().slice(1),
  ], recipeA());
  assert.equal(bad3.referenceDate, null, '★就地鎖定——壞目標不可由後面的錨點行遞補');
});

// ---- Codex r14：混合孤兒列、固定幣別區矛盾標題、Unicode 數字 ----

test('引擎｜混合孤兒列（r14#1）：左側忽略格＋右側真備註同列——先逐格過濾再判整列、真備註要活', () => {
  // r14 實測形：續行列＝忽略欄「0007」(x=205)＋備註欄「劃撥」(x=495)——整列判定在過濾前
  // ＝every() 被左側忽略格打敗、整列進不了孤兒路徑＝真備註消失、內轉被記成支出
  const igNote = { ...recipeA(), detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: '附記', headerIgnore: ['單號'] } };
  const p = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$800']]),
    L(92, [[205, 0, '0007'], [495, 0, '劃撥']]),   // ★混合續行列
  ], igNote);
  assert.equal(p.transactions[0].note, '劃撥', '★真備註（劃撥）要活、忽略格（0007）要濾——逐格不是整列');
  assert.equal(classifyBankTx(p.transactions[0], new Set()).type, 'transfer',
    '★端到端：這筆本來就是劃撥＝內轉——真備註消失會把它記成支出（r14 實測形）');
});

test('引擎｜固定幣別區的矛盾幣別標題（r14#2）：出生只有台幣、次月同區冒出 USD＝拒解不蓋台幣', () => {
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(270, [[367, 'USD']]),   // ★固定 TWD 區出現獨立 USD 標題
    L(260, [[50, '外幣活存'], [150, '900200****3302'], [473, '$100']]),
    L(240, [[47, '總計']]),
    ...linesA().slice(8),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed',
    '★固定 TWD 不反應＝美元帳戶與交易被蓋成台幣入帳且強閘照綠——矛盾標題拒解');
  // BY-CODE 的標題辨識改 CURRENCIES 白名單：白名單外的三碼（QQQ）＝看不懂 ⇒ UNKNOWN 哨兵
  const r = { ...recipeA(), summary: { ...recipeA().summary, sections: [{ anchor: '外幣總覽', currency: 'BY-CODE' }] },
    detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  const p = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '外幣總覽區']]),
    L(280, [[367, 'QQQ']]),
    L(260, [[56, '外幣活儲'], [108, '900300****363'], [436, '$100']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '合成帳戶總覽'], [200, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900300****363'], [124, 0, '2026/06/11'], [289, 30, '$10'], [418, 0, '$90']]),
  ], r);
  assert.equal(p.accountCurrency['900300****363'], 'UNKNOWN',
    '★QQQ 不在支援清單＝看不懂＝UNKNOWN 哨兵（下游 unsupported 跳過）——不可被當幣別');
});

test('驗證器｜Unicode 數字也算數字（r14 建議）：阿拉伯-印度數字 ٢٠٢٦ 不可繞過數字牆', () => {
  const r = recipeA(); r.docAnchors[0] = '單٢٠٢٦號';
  assert.ok(validateRecipeStrict(r).length > 0, '★\\p{Nd} 涵蓋所有數字系統——ASCII 範圍檢會放行');
});

// ---- Codex r15：帳戶列幣別矛盾＋同列雙候選 ----

test('引擎｜帳戶列自帶矛盾幣別格（r15#1）：「美元活存｜帳號｜USD｜$150」在固定 TWD 區＝拒解', () => {
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(270, [[50, '美元活存'], [150, '900200****3302'], [300, 'USD'], [473, '$150']]),   // ★幣別格直接在帳戶列上
    L(240, [[47, '總計']]),
    ...linesA().slice(8),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed',
    '★r14 只掃獨立標題列——帳戶列自帶 USD 格照樣被蓋成台幣入帳且強閘照綠');
});

test('引擎｜同列雙金額候選（r15#2）：支出窗與存入窗同時有格＝歧義拒解，不可無條件取支出', () => {
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    // 多出來的數字欄「7」右緣落提領窗＋真存入「100」在存進窗——模板慣性取支出 7＝反向交易
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '7'], [349, 30, '100'], [418, 0, '$1,330']]),
  ], noIgn), (e) => e.code === 'recipe_parse_failed',
    '★「兩欄只填一個」是台新版面事實不是通則——雙候選＝歧義、整份退 AI');
});

// ---- Codex r16：同窗多候選＋BY-CODE 帳戶列幣別核對 ----

test('引擎｜同一金額窗兩個候選（r16#1）：先到先贏會讓 $100 被記成 $7——歧義拒解', () => {
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [280, 10, '7'], [300, 20, '100'], [418, 0, '$900']]),
  ], noIgn), (e) => e.code === 'recipe_parse_failed', '★同 out 窗兩格＝一窗一格是台新事實不是通則');
});

test('引擎｜BY-CODE 帳戶列的明確幣別要對 sticky 核對（r16#2）：sticky=JPY、列上印 USD＝拒解', () => {
  const r = { ...recipeA(), summary: { ...recipeA().summary, sections: [{ anchor: '外幣總覽', currency: 'BY-CODE' }] },
    detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  const mk = (acctRow) => [
    L(300, [[20, '合成銀行月結單'], [47, '外幣總覽區']]),
    L(280, [[367, 'JPY']]),
    acctRow,
    L(240, [[47, '總計']]),
    L(140, [[47, '合成帳戶總覽'], [200, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900300****363'], [124, 0, '2026/06/11'], [289, 30, '$10'], [418, 0, '$90']]),
  ];
  assert.throws(() => parseWithRecipe(mk(L(260, [[50, '美元活存'], [108, '900300****363'], [300, 'USD'], [436, '$150']])), r),
    (e) => e.code === 'recipe_parse_failed',
    '★原版把帳戶標成 JPY、USD 掉進 note＝美元餘額被建成日圓 150 且強閘照綠');
  const ok = parseWithRecipe(mk(L(260, [[50, '日圓活存'], [108, '900300****363'], [300, 'JPY'], [436, '$150']])), r);
  assert.equal(ok.accounts[0].currency, 'JPY', '列上幣別與 sticky 一致＝照過、不誤殺');
});

// ---- Codex r17：退路多候選 ----

test('引擎｜窗外雙嚴格金額（r17#1；r21 後語意＝窗外即歧義）：兩格都分不進窗＝拒解', () => {
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    // 兩格右緣都 < 272（分不出欄＝都落退路）：212≤x<xBal、非忽略——次月多出的可選欄形
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [230, 10, '7'], [250, 10, '100'], [418, 0, '$900']]),
  ], noIgn), (e) => e.code === 'recipe_parse_failed', '★退路與主路同一把「一窗一格」尺');
});

// ---- Codex r18：表頭完整性 ----

test('引擎｜金額區的表頭格必須全數宣告（r18#1）：出生月空值的可選欄＝次月有值就污染摘要', () => {
  // r18 實測形：出生月表頭已有「處理類別」（值全空）、配方漏列它——三關全過、配方孵化；
  // 次月該欄出現「劃撥」＝兩筆一般支出的摘要變「一般扣款劃撥」→ 內轉誤判、強閘照綠
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [360, '處理類別'], [396, '結存餘額']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$800']]),
  ], noIgn), (e) => e.code === 'recipe_parse_failed',
    '★金額區起的未宣告表頭格＝出生就拒——配方孵不出來、逼 AI 產配方時把角色宣告齊');
  // 不誤殺：金額區之前的欄（帳號/日期/摘要標籤）＝摘要身分區、不需宣告（linesA 主考題即為此形）
});

// ---- Codex r19：雙列表頭＝值層封閉 ----

test('引擎｜值層封閉（r19#1）：雙列表頭繞過表頭檢查也沒用——金額區的未建模文字在值端拒解', () => {
  // r19 實測形：未宣告的「處理類別」欄名印在**隔壁列**（雙列表頭）＝r18 的表頭檢查看不到、
  // 出生三關全過配方孵化；次月該欄出現「劃撥」——值層封閉在交易列當場拒解（配方已快取也擋得住）
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  const doc = (row) => [
    ...linesA().slice(0, 9),
    L(122, [[360, '處理類別']]),   // ★欄名在偵測列的隔壁列
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    row,
  ];
  // 出生月（欄值空）＝照常孵化
  const birth = parseWithRecipe(doc(L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$800']])), noIgn);
  assert.equal(birth.transactions.length, 1, '出生月欄值空＝照常解（雙列表頭的欄名列不是交易列）');
  // 次月欄值出現＝值端拒解
  assert.throws(() => parseWithRecipe(doc(L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [365, 0, '劃撥'], [418, 0, '$800']])), noIgn),
    (e) => e.code === 'recipe_parse_failed',
    '★金額區的未建模文字＝拒解退 AI 重生——「劃撥」再也進不了摘要（強閘擋不住的內轉誤判從值端關死）');
});

// ---- Codex r20：縫隙帶封閉＋重複角色表頭 ----

test('引擎｜餘額與備註之間的縫隙帶（r20#1）：文字掉進去既不拒也不進備註＝一併封閉', () => {
  // 有備註欄（489）：縫隙帶 [396,489) 的「劃撥」——r19 版無聲消失＝真內轉被記成支出
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$800'], [430, 0, '劃撥']]),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed', '★縫隙帶的未建模文字＝拒解（含備註欄形）');
  // 無備註欄：餘額之後的未建模文字同樣拒
  const noNote = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$800'], [430, 0, '劃撥']]),
  ], noNote), (e) => e.code === 'recipe_parse_failed', '★無備註欄形');
});

test('引擎｜同名角色表頭重複（r20#2）：兩個「提領金額」格＝第二欄的值會落錯窗——拒解', () => {
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [345, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$800']]),
  ], noIgn), (e) => e.code === 'recipe_parse_failed',
    '★findX 只綁第一個、次月首筆落在第二個「提領金額」欄＝被解析成存入且首筆盲區強閘照綠');
});

// ---- Codex r21：未宣告數字欄的憑空支出（退路移除的直接動機） ----

test('引擎｜未宣告序號欄次月啟用（r21#1）：出生三關全過、次月單一序號候選＝拒解不憑空支出', () => {
  // r21 最小重現：摘要@175｜序號@220（未宣告）｜提領@272｜存入@331｜餘額@396
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  const doc = (row) => [
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [175, '摘要'], [220, '序號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    row,
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [289, 15, '$100'], [418, 0, '$800']]),
  ];
  // 出生月：序號欄空白＝照常孵化（序號表頭在 zoneStart 之前＝摘要身分區、不需宣告）
  const birth = parseWithRecipe(doc(L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$50'], [418, 0, '$900']])), noIgn);
  assert.equal(birth.transactions.length, 2, '出生月序號空白＝正常');
  // 次月：首列只有序號 7＋餘額——原版退路把 7 撿成幽靈支出、chain/endBalance 全 pass 強閘照綠
  assert.throws(() => parseWithRecipe(doc(L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [230, 8, '7'], [418, 0, '$900']])), noIgn),
    (e) => e.code === 'recipe_parse_failed',
    '★分不進窗的嚴格金額（序號 7）＝歧義拒解——救援帶移除後憑空支出再無來源');
});

// ---- Codex r22：真實但不支援的幣別碼 ----

test('引擎｜EUR 不在支援清單但是真幣別（r22#1）：衝突偵測用「長相」、不可讓它隱形繼承 TWD', () => {
  // 固定 TWD 區＋歐元帳戶列：白名單偵測讓 EUR 隱形＝帳戶繼承 TWD、歐元交易進台幣現金流
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(270, [[50, '歐元活存'], [150, '900200****3302'], [300, 'EUR'], [473, '$900']]),
    L(240, [[47, '總計']]),
    ...linesA().slice(8),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed', '★固定 TWD＋EUR 帳戶列＝拒解（端到端：解不動＝進不了匯入）');
  // BY-CODE sticky TWD＋歐元帳戶列：同樣拒解、不得繼承 TWD
  const r = { ...recipeA(), summary: { ...recipeA().summary, sections: [{ anchor: '外幣總覽', currency: 'BY-CODE' }] },
    detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '外幣總覽區']]),
    L(280, [[367, 'TWD']]),
    L(260, [[50, '歐元活存'], [108, '900300****363'], [300, 'EUR'], [436, '$900']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '合成帳戶總覽'], [200, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900300****363'], [124, 0, '2026/06/11'], [289, 30, '$10'], [418, 0, '$90']]),
  ], r), (e) => e.code === 'recipe_parse_failed', '★sticky TWD＋EUR 帳戶列＝拒解');
});

// ---- Codex r23：混合格的幣別偵測 ----

test('引擎｜幣別藏在混合格（r23#1）：「EUR 活存」同一格＝整格比對看不到——token 層偵測', () => {
  // 固定 TWD 區＋混合格
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(270, [[50, 'EUR 活存'], [150, '900200****3302'], [473, '$900']]),   // ★幣別與標籤同一格
    L(240, [[47, '總計']]),
    ...linesA().slice(8),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed', '★整格比對讓 EUR 隱形＝歐元帳戶繼承 TWD 入帳');
  // BY-CODE sticky TWD＋「幣別 EUR」混合格
  const r = { ...recipeA(), summary: { ...recipeA().summary, sections: [{ anchor: '外幣總覽', currency: 'BY-CODE' }] },
    detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '外幣總覽區']]),
    L(280, [[367, 'TWD']]),
    L(260, [[50, '幣別 EUR'], [108, '900300****363'], [436, '$900']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '合成帳戶總覽'], [200, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(100, [[53, 0, '900300****363'], [124, 0, '2026/06/11'], [289, 30, '$10'], [418, 0, '$90']]),
  ], r), (e) => e.code === 'recipe_parse_failed', '★sticky TWD＋混合格 EUR＝拒解、零入帳');
  // 不誤殺：VISA（四碼）不是幣別長相——不可被 token 抓中
  const ok = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, 'VISA活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$1,130']]),
  ], recipeA());
  assert.equal(ok.accounts[0].currency, 'TWD', 'VISA 四碼＝非幣別長相、照常解');
});

// ---- Codex r24：未宣告數字欄頂替餘額 ----

test('引擎｜餘額窗也一窗一格（r24#1）：「累計支出」欄雙列表頭出生、次月數字頂替餘額＝拒解', () => {
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  const doc = (rows) => [
    ...linesA().slice(0, 9),
    L(122, [[450, '累計支出']]),   // ★欄名在偵測列的隔壁列＝表頭完整性看不到
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    ...rows,
  ];
  // 出生月：累計欄空白＝照常孵化
  const birth = parseWithRecipe(doc([
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [400, 0, '$9,000']]),
  ]), noIgn);
  assert.equal(birth.transactions.length, 1, '出生月累計欄空白＝正常');
  // 次月：餘額窗出現兩個數字候選（真餘額 8,900＋累計 700）——r24 實測：累計增量像餘額鏈、
  // 支出被覆寫成收入且 strong/ok——第二候選＝歧義拒解
  assert.throws(() => parseWithRecipe(doc([
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [400, 0, '$8,900'], [455, 0, '700']]),
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [349, 30, '$100'], [400, 0, '$8,800'], [455, 0, '800']]),
  ]), noIgn), (e) => e.code === 'recipe_parse_failed', '★餘額窗第二個非忽略候選＝拒解退 AI');
});

// ---- Codex r25：重複帳戶幣別 ----

test('引擎｜概要重複的（遮罩＋幣別）帳戶＝拒解（r25#2：套用端 first-wins＝順序決定餘額）', () => {
  // 比對器 accounts 不比順序（multiset）、applyBalancesToDb 卻以 masked|currency first-wins——
  // 同鍵兩列（餘額 100/200）互換順序＝出生比對照過、寫入的餘額卻不同
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲戶'], [150, '900100****3301'], [473, '$100']]),
    L(270, [[50, '乙戶'], [150, '900100****3301'], [473, '$200']]),   // ★同遮罩同幣別、不同餘額
    L(240, [[47, '總計']]),
    ...linesA().slice(8, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$1,130']]),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed', '★同鍵重複＝版面歧義、順序不可決定錢');
});

// ---- Codex r26：跨區寬序號＋遮罩變體身分重疊 ----

test('引擎｜zoneStart 左側的寬值右緣跨進金額窗（r26#1）：跨區歧義拒解——三層共用同一條邊界', () => {
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  const doc = (row) => [
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [175, '摘要'], [250, '序號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    row,
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [349, 30, '$100'], [418, 0, '$800']]),
  ];
  // 出生月序號空白＝孵化（序號表頭在 zoneStart 之前）
  assert.equal(parseWithRecipe(doc(L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$50'], [418, 0, '$900']])), noIgn).transactions.length, 2);
  // 次月：序號值 7（x=250,w=30）右緣 280 跨進支出窗——r21 題的窄值（r=238 窗外）抓不到這形
  assert.throws(() => parseWithRecipe(doc(L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [250, 30, '7'], [418, 0, '$900']])), noIgn),
    (e) => e.code === 'recipe_parse_failed', '★左緣在摘要區、右緣在金額窗＝跨區歧義、不猜');
});

test('引擎｜遮罩變體的帳戶身分重疊（r26#2）：9001****3301 與 900100****3301＝下游撞同一戶——拒解', () => {
  const mk = (rowA, rowB) => [
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    rowA, rowB,
    L(240, [[47, '總計']]),
    ...linesA().slice(8, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$1,130']]),
  ];
  // 前綴相容（9001 ⊂ 900100）＝下游按可見前綴＋末碼會配到同一戶、first-wins 順序決定餘額——拒解
  assert.throws(() => parseWithRecipe(mk(
    L(280, [[50, '甲戶'], [150, '9001****3301'], [473, '$200']]),
    L(270, [[50, '乙戶'], [150, '900100****3301'], [473, '$300']]),
  ), recipeA()), (e) => e.code === 'recipe_parse_failed', '★解不動＝套不到 applyBalancesToDb＝端到端保證');
  // 前綴不相容（900100 vs 900200＝P1a 同末碼雙帳戶的真實形）＝不同戶、照過
  const ok = parseWithRecipe(mk(
    L(280, [[50, '甲戶'], [150, '900100****3301'], [473, '$200']]),
    L(270, [[50, '乙戶'], [150, '900200****3301'], [473, '$300']]),
  ), recipeA());
  assert.equal(ok.accounts.length, 2, '不誤殺：前綴不相容＝真實的兩個帳戶');
});

// ---- Codex r27：空餘額帳戶的身分重疊 ----

test('引擎｜空餘額帳戶也要驗身分重疊（r27#1）：只活在 accountCurrency 的重疊不可漏', () => {
  const mk = (rowA, rowB) => [
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    rowA, rowB,
    L(240, [[47, '總計']]),
    ...linesA().slice(8, 10),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$1,130']]),
  ];
  // 兩列都空餘額（r27 實測形：兩遮罩被閘分成兩組＝兩個首筆盲區、錯讀金額仍入帳）
  assert.throws(() => parseWithRecipe(mk(
    L(280, [[50, '甲戶'], [150, '9001****3301']]),
    L(270, [[50, '乙戶'], [150, '900100****3301']]),
  ), recipeA()), (e) => e.code === 'recipe_parse_failed', '★雙空餘額的身分重疊也要拒');
  // 一空一有
  assert.throws(() => parseWithRecipe(mk(
    L(280, [[50, '甲戶'], [150, '9001****3301']]),
    L(270, [[50, '乙戶'], [150, '900100****3301'], [473, '$300']]),
  ), recipeA()), (e) => e.code === 'recipe_parse_failed', '★一空一有也要拒');
  // 不誤殺：P1a 前綴不相容、雙空餘額＝兩個真實帳戶
  const ok = parseWithRecipe(mk(
    L(280, [[50, '甲戶'], [150, '900100****3301']]),
    L(270, [[50, '乙戶'], [150, '900200****3301']]),
  ), recipeA());
  assert.equal(Object.keys(ok.accountCurrency).length, 2, '前綴不相容＝照過（甲戶與明細同遮罩＝同一鍵）');
});

// ---- Codex r28：明細區欄名列＋帳戶標籤冒領 ----

test('引擎｜明細區非交易列的金額窗文字＝拒解（r28#1）：雙列表頭的欄名在出生就露餡', () => {
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerNote: null, headerIgnore: [] } };
  // 欄名列在偵測列**之後**（含跨頁重複表頭的常見形）：出生月就拒解＝次月數字永遠到不了快取路徑
  assert.throws(() => parseWithRecipe([
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    L(118, [[300, '流水號']]),   // ★金額窗內的欄名文字（非交易列）
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$800']]),
  ], noIgn), (e) => e.code === 'recipe_parse_failed',
    '★非交易列的金額窗文字＝出生拒解（值層封閉從交易列擴到整個明細區）');
  // 誠實劃界（殘餘）：欄名列印在**第一頁表頭之上**＝落在摘要區、與概要內容機械上不可分辨
  // ——列殘餘入契約（William 2026-08-15 殘餘化收尾裁示）、由出生驗收＋預覽確認＋畢業試用期承接
});

test('引擎｜帳戶標籤不算銀行身分證據（r28#2）：「甲方自動扣款專戶」不可讓甲方配方冒領乙行帳單', () => {
  // 乙行帳單、概要帳戶標籤含「合成銀行」字樣——r10 版的表頭前 substring 掃描會被它冒領
  assert.throws(() => parseWithRecipe([
    L(300, [[20, '乙方商業月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '合成銀行自動扣款專戶'], [150, '900100****3301'], [473, '$1,230']]),   // ★標籤帶他行名
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '單號'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額'], [489, '附記']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [289, 15, '$100'], [418, 0, '$1,130']]),
  ], recipeA()), (e) => e.code === 'recipe_parse_failed',
    '★含遮罩帳號的列＝帳戶列、不算身分證據——冒領版會解成功並標成「合成銀行」');
});

// ---- 同一把尺：文字比對一律 NFKC → 去空白 ----
//
// 病：`recipeMatches` 只去空白、不做 NFKC，而同一支檔的 `checkSlot` 做了 ⇒ 帳單原文印**相容字**
// （康熙部首 `⾦`U+2FA6 vs 正常的 `金`U+91D1、全形 `１２３` vs `123`——長得一模一樣、位元組不同）
// 時，AI 產的正規字暗號永遠對不上。失敗是**靜的**：沒有錯誤、只是認不得版面＝當作沒有規則卡＝
// 每個月照舊燒一次 AI。下面這幾題把「兩邊都過同一把尺」釘在**每一個**比對點上。

/** 正常字 → 康熙部首（PDF 文字層真的會這樣印；NFKC 會把部首折回正常字）。 */
const RAD = { 金: '⾦', 戶: '⼾', 日: '⽇', 月: '⽉', 頁: '⾴', 車: '⾞', 支: '⽀', 入: '⼊', 小: '⼩', 手: '⼿', 用: '⽤' };
/** 把字串裡有部首寫法的字換成部首＝「同一句話的另一種印法」。 */
const toRad = (/** @type {string} */ s) => [...String(s)].map(ch => RAD[ch] ?? ch).join('');
/** 配方的**文字槽**（會拿去跟帳單原文比對的那些）。 */
const textSlotsOf = (/** @type {any} */ r) => [
  r.bank, ...r.docAnchors, r.refDate.anchor, ...r.summary.sections.map((/** @type {any} */ x) => x.anchor), r.summary.endAnchor,
  r.detail.headerOut, r.detail.headerIn, r.detail.headerBalance, r.detail.headerNote, ...r.detail.headerIgnore,
].filter((/** @type {any} */ x) => typeof x === 'string');

/** 版面 N 的配方：詞彙刻意挑成**每一個文字槽都至少有一個字有部首寫法**——否則某個比對點漏掉
 * 這把尺時，下面兩題不會紅（夾具自己是這兩題的承重點）。 */
const recipeN = () => ({
  formatVersion: RECIPE_FORMAT_VERSION,
  bank: '合成金庫',
  docAnchors: ['存戶總表', '收支明細月報'],
  dateFormat: 'west-slash',
  refDate: { strategy: 'anchored-date', anchor: '結算日' },
  summary: { sections: [{ anchor: '存戶總表', currency: 'TWD' }], endAnchor: '本頁小計', balancePick: 'dollar-tagged' },
  detail: {
    rowIdent: 'acct-date',
    headerOut: '支出金額', headerIn: '存入金流', headerBalance: '本日餘額',
    headerNote: '日誌註記', headerIgnore: ['車號'],
  },
});
/** 版面 N 的合成帳單。`rad=true`＝**認版面用的文字**（暗號／區段／收尾／銀行名／表頭）整份改印相容字。
 * ⚠️ **參考日錨點刻意不換**——那一段整段走舊尺、不在這把尺的射程內（見題名含「參考日整段維持舊尺」那題）。
 * ⚠️ 帳號、日期、金額、摘要、標籤**刻意不換**：那些是輸出值不是比對點（引擎照原樣輸出、原樣進
 * bankRef 去重鍵），換了它們這兩題就變成在考別件事。 */
const linesN = (rad = false) => {
  const t = rad ? toRad : (/** @type {string} */ x) => x;
  return [
    // ⚠️ 參考日錨點**刻意不換**：那一段整段維持 main 原狀、走舊尺（William 2026-08-29 裁示「甲」）
    //   ——換了它 referenceDate 會變 null，那是**預期行為**，另有專題釘（題名含「參考日整段維持舊尺」）。
    L(300, [[20, t('合成金庫月結單')], [47, t('存戶總表')], [452, '結算日:2026/06/30']]),
    L(280, [[50, '甲戶活存'], [150, '900100****3301'], [473, '$1,230']]),   // 標籤挑成「換得動」的詞：出生對照那題要拿它當內文樣本
    L(240, [[47, t('本頁小計')], [445, '$1,230']]),
    L(140, [[47, t('收支明細月報')]]),
    L(120, [[75, t('帳號')], [135, t('日期')], [200, t('車號')], [272, t('支出金額')], [331, t('存入金流')], [396, t('本日餘額')], [489, t('日誌註記')]]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730']]),
  ];
};
/** 版面 N 的合成帳單，**交易摘要**也印相容字（引擎會原樣輸出＝出生對照拿到的內文就是相容字寫法）。 */
const linesNContent = () => {
  const ls = linesN();
  ls[1] = L(280, [[50, toRad('甲戶活存')], [150, '900100****3301'], [473, '$1,230']]);   // 帳戶標籤
  ls[5] = L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, toRad('合成轉入')], [349, 40, '$500'], [418, 0, '$1,730']]);   // 交易摘要
  return ls;
};
/** 版面 N 的配方，**認版面用的文字槽都抄成相容字寫法**（AI 照版面逐字抄就會長這樣）。
 * ⚠️ 參考日錨點刻意不換，理由同 `linesN`。 */
const recipeNRad = () => {
  const r = recipeN();
  return {
    ...r,
    bank: toRad(r.bank),
    docAnchors: r.docAnchors.map(toRad),
    refDate: r.refDate,   // ⚠️ 參考日錨點刻意不換＝那一段走舊尺、本支不碰（同 linesN 的說明）
    summary: {
      ...r.summary,
      sections: r.summary.sections.map(x => ({ ...x, anchor: toRad(x.anchor) })),
      endAnchor: toRad(r.summary.endAnchor),
    },
    detail: {
      ...r.detail,
      headerOut: toRad(r.detail.headerOut), headerIn: toRad(r.detail.headerIn), headerBalance: toRad(r.detail.headerBalance),
      headerNote: toRad(r.detail.headerNote), headerIgnore: r.detail.headerIgnore.map(toRad),
    },
  };
};

test('同一把尺｜夾具自檢：版面 N 的配方合格、正規字版整份解得出來（下面各題的比較基準）', () => {
  assert.deepEqual(validateRecipeStrict(recipeN()), []);
  assert.deepEqual(validateRecipeStrict(recipeNRad()), [], '相容字寫法的配方本身也要是合格配方（否則下一題考不到比對）');
  const p = parseWithRecipe(linesN(), recipeN());
  assert.equal(p.referenceDate, '2026-06-30');
  assert.equal(p.accounts.length, 1);
  assert.equal(p.transactions.length, 1);
  // **認版面用的**每個文字槽都至少有一個字換得動——這是「帳單相容字」「配方相容字」兩題的承重點。
  // ⚠️ `refDate.anchor` 刻意排除：那一段走舊尺、不在這把尺的射程內（它由題名含「參考日整段維持
  //    舊尺」那題守）。把它算進來會讓這一題看起來守著一個它其實沒守的比對點（Codex #523 r5#2）。
  const layoutSlots = textSlotsOf(recipeN()).filter(x => x !== recipeN().refDate.anchor);
  assert.ok(layoutSlots.length >= 8, '★排除參考日之後仍要覆蓋所有認版面的槽位（少了就是這一題自己縮水）');
  for (const slot of layoutSlots) {
    assert.notEqual(toRad(slot), slot, `★槽位「${slot}」沒有任何字有部首寫法＝那個比對點漏掉尺也不會紅`);
  }
});

test('同一把尺｜帳單整份印相容字、規則卡是正規字：照樣認得，逐欄輸出一字不差', () => {
  const base = parseWithRecipe(linesN(), recipeN());
  assert.equal(recipeMatches(linesN(true), recipeN()), true,
    '★這一行就是本支要修的病：認不得＝當作沒有規則卡＝下個月再燒一次 AI，而且完全沒有錯誤訊息');
  assert.deepEqual(parseWithRecipe(linesN(true), recipeN()), base,
    '★暗號／區段錨點／收尾錨點／銀行身分／五個欄標題——任何一個比對點的帳單那一邊漏掉尺，這題就紅'
    + '（⚠️ **不含參考日錨點**：夾具刻意保留正規字，那一段由題名含「參考日整段維持舊尺」那題承接）');
});

test('同一把尺｜規則卡抄成相容字、帳單是正規字：另一邊也要過同一把尺', () => {
  // AI 照版面逐字抄時會抄成相容字——只把帳單那一邊正規化，等於「抄得越忠實越認不得」。
  const base = parseWithRecipe(linesN(), recipeN());
  const out = parseWithRecipe(linesN(), recipeNRad());
  assert.equal(out.bank, recipeNRad().bank,
    'bank 是原樣回聲的**輸出值**、不是比對點——照配方寫的字回，不被尺磨掉');
  assert.deepEqual({ ...out, bank: base.bank }, base,
    '★配方那一邊漏掉尺，這題就紅（與上一題成對：一題管帳單那邊、一題管配方那邊）');
});

test('同一把尺｜全形數字：帳單印「１２３」、暗號寫「123」照樣認得，反過來也是', () => {
  const half = { ...recipeN(), docAnchors: ['第123類存戶總表', '收支明細月報'] };
  const full = { ...recipeN(), docAnchors: ['第１２３類存戶總表', '收支明細月報'] };
  assert.deepEqual(validateRecipeStrict(half), [], '前提：3 位數字仍在正當詞彙空間（4 位才拒收）');
  assert.deepEqual(validateRecipeStrict(full), [], '前提：全形也一樣——數字判準本來就先 NFKC');
  const withFull = linesN(); withFull[0] = L(300, [[20, '合成金庫月結單'], [47, '第１２３類存戶總表'], [452, '結算日:2026/06/30']]);
  const withHalf = linesN(); withHalf[0] = L(300, [[20, '合成金庫月結單'], [47, '第123類存戶總表'], [452, '結算日:2026/06/30']]);
  assert.equal(recipeMatches(withFull, half), true, '★帳單全形、卡上半形');
  assert.equal(recipeMatches(withHalf, full), true, '★帳單半形、卡上全形');
});

test('同一把尺｜NFKC 先、去空白後：反過來做會留下 NFKC 自己生出來的空白', () => {
  // `¯`(U+00AF) 屬於「自己不是空白、NFKC 之後展開成『空白＋組合附標』」的那一族。
  // 先去空白再 NFKC，那個空白就進不了去空白那一關 ⇒ 兩邊字串永遠差一個空白＝尺只做了一半。
  assert.equal(recipeNorm('甲¯乙'), '甲\u0304乙', '★NFKC 在前、去空白在後＝生出來的空白吃得掉');
  assert.notEqual(squash('甲¯乙').normalize('NFKC'), recipeNorm('甲¯乙'), '★順序反過來＝空白留著');
  // 誠實劃界：這個順序差別今天只在本題看得見——真帳單要同時出現這一族字元與拆字空白才分得出勝負。
});

test('同一把尺｜換尺對「舊尺生出來的規則卡」是恆等：卡與帳單都是正規字時，新尺逐字等於舊尺', () => {
  // 已存的規則卡是用「只去空白」那把尺生出來的。換尺之後它們還認得原本認得的帳單嗎？
  // 判準不是「跑跑看沒事」——NFKC 對**已經正規**的字串是恆等，所以兩把尺在這些字串上逐字相同，
  // 每一個比對點的判定都不可能改變。這題把那個前提釘住：哪天有人把 recipeNorm 換成會動到正規字
  // 的東西（例如順手加大小寫摺疊、加剝標點），這裡先紅。
  const slots = [...textSlotsOf(recipeA()), ...textSlotsOf(recipeB())];
  const cells = [...linesA(), ...linesB()].flatMap(l => l.cells.map(c => c.s));
  const joinedLines = [...linesA(), ...linesB()].map(l => l.cells.map(c => c.s).join(''));   // 引擎比的是整列拼起來的字串
  for (const str of [...slots, ...cells, ...joinedLines]) {
    assert.equal(str.normalize('NFKC'), str, `★夾具字串「${str}」本來就該是 NFKC 正規形，否則本題前提不成立`);
    assert.equal(recipeNorm(str), squash(str), '★正規字上，新尺與舊尺必須逐字相同');
  }
  assert.equal(recipeMatches(linesA(), recipeA()), true);
  assert.equal(recipeMatches(linesB(), recipeB()), true);
  assert.deepEqual(validateRecipeStrict(recipeA()), [], '換尺不得讓既有配方變成不合格（拒解＝那張卡當場失效）');
  assert.deepEqual(validateRecipeStrict(recipeB()), []);
  // ⚠️ 誠實劃界（沒有考題撐、也不打算加）：反方向不保證——NFKC 不保證子字串關係在正規化後仍
  // 成立（暗號結尾的基字，若文件裡緊跟組合附標會合成成另一個字）。**本支不支援這種形，
  // 也沒有量測過真帳單有沒有**——不替真實帳單下保證（Codex #523 r5#2）。
});

test('同一把尺｜表頭重複的相容字寫法照樣算「重複」（尺比 findX 窄＝第二格的值靜靜落錯窗）', () => {
  const lines = linesN();
  lines[4] = L(120, [[75, '帳號'], [135, '日期'], [200, '車號'], [272, '支出金額'], [300, toRad('支出金額')],
    [331, '存入金流'], [396, '本日餘額'], [489, '日誌註記']]);
  assert.throws(() => parseWithRecipe(lines, recipeN()),
    (/** @type {any} */ e) => e.code === 'recipe_parse_failed' && /重複/.test(e.message),
    '★要因「重複」而拒解：尺窄的版本會改因「未宣告」拒解＝同一個 code、不同的病因，所以這題認訊息');
  // 鏡像方向（配方那一邊）：卡上抄相容字、帳單印正規字的兩格——只做帳單那半邊時，這兩格數不到
  const mirror = linesN();
  mirror[4] = L(120, [[75, '帳號'], [135, '日期'], [200, '車號'], [272, '支出金額'], [300, '支出金額'],
    [331, '存入金流'], [396, '本日餘額'], [489, '日誌註記']]);
  assert.throws(() => parseWithRecipe(mirror, recipeNRad()),
    (/** @type {any} */ e) => e.code === 'recipe_parse_failed' && /重複/.test(e.message),
    '★配方那一邊也要過同一把尺，否則「兩格同名」在相容字寫法的卡上數不出來');
});

test('同一把尺｜配方自己的兩道防撞名也用它：區段錨點相容字互為子字串、角色標題相容字撞名', () => {
  const r1 = recipeN();
  r1.summary.sections = [{ anchor: '存戶總表', currency: 'TWD' }, { anchor: toRad('戶總表'), currency: 'USD' }];
  assert.ok(validateRecipeStrict(r1).some(e => e.includes('互為子字串')),
    '★尺比引擎窄＝「驗過不重疊」的兩段在文件上其實會互相吃掉（外幣區被先命中的台幣段吞掉）');
  const r2 = recipeN();
  r2.detail.headerIgnore = [toRad('支出金額')];
  assert.ok(validateRecipeStrict(r2).some(e => e.includes('不可相同')),
    '★忽略欄用相容字寫法撞支出欄名＝findX 抓到同一格、整欄支出被吃掉');
});

test('同一把尺｜出生對照的等值與位置兩道約束也用它：相容字寫法的交易內文不得當錨點', () => {
  const parsed = parseWithRecipe(linesN(), recipeN());
  assert.deepEqual(validateRecipeAgainstStatement(linesN(), recipeN(), parsed), [], '前提：正常配方要過');
  const r1 = recipeN();
  r1.detail.headerIgnore = [toRad('合成轉入')];   // ①等值：那是交易摘要，只是換了印法
  assert.ok(validateRecipeAgainstStatement(linesN(), r1, parsed).some(e => e.startsWith('detail.headerIgnore[0]') && e.includes('相等')),
    '★等值約束的兩邊也要同尺，否則「換個印法抄同一句交易內文」整道走私路照樣通');
  const r2 = recipeN();
  r2.detail.headerIgnore = [toRad('轉入')];       // ②位置：不等於任何內文，但只出現在交易列上
  assert.ok(validateRecipeAgainstStatement(linesN(), r2, parsed).some(e => e.startsWith('detail.headerIgnore[0]') && e.includes('交易列')),
    '★位置約束吃的是整列文字，尺不同就看不見相容字寫法命中了交易列');
  // 鏡像方向：**帳單內文**印相容字、卡上抄正規字（引擎原樣輸出，所以內文那一邊也得過同一把尺）
  // 這題要的內文是**相容字寫法**（出生對照的真呼叫端拿到的是 AI 答案卷，AI 忠實照抄時就長這樣），
  // 所以夾具的交易摘要與帳戶標籤都印相容字——引擎照原文輸出，這裡直接拿它當內文即可。
  const parsedC = parseWithRecipe(linesNContent(), recipeN());
  assert.equal(parsedC.transactions[0].summary, toRad('合成轉入'), '前提：引擎照帳單原文輸出（見「原文留底／去重鍵／帳號身分三條界線」那題）');
  const r3 = recipeN();
  r3.detail.headerIgnore = ['合成轉入'];
  assert.ok(validateRecipeAgainstStatement(linesNContent(), r3, parsedC).some(e => e.startsWith('detail.headerIgnore[0]') && e.includes('相等')),
    '★內文那一邊沒過尺＝這一槽會改由位置約束擋（病因不同）；等值那道就等於漏了');
  const r4 = recipeN();
  r4.detail.headerIgnore = ['轉入'];
  assert.ok(validateRecipeAgainstStatement(linesNContent(), r4, parsedC).some(e => e.startsWith('detail.headerIgnore[0]') && e.includes('交易列')),
    '★帳單那一邊沒過尺＝正規字錨點看不見它命中了印相容字的交易列，整道位置約束靜靜放行');
  // 內文集合的**兩半各自**要考到（同 r5#1 那一課：只考交易那半，單獨把帳戶那半改窄的刀仍綠）：
  // 帳戶標籤／備註也是內文，而它們住在非交易列上＝位置約束接不住，等值那道漏了就整個沒人擋。
  const r5 = recipeN();
  r5.detail.headerIgnore = ['甲戶活存'];
  assert.ok(validateRecipeAgainstStatement(linesNContent(), r5, parsedC).some(e => e.startsWith('detail.headerIgnore[0]') && e.includes('相等')),
    '★帳戶標籤那半沒過尺＝相容字寫法的標籤被當成正當錨點收下（非交易列，位置約束救不了）');
  // bank 槽只有等值檢（刻意不做位置檢：銀行短名本來就會出現在交易列）——它自己那一邊也要過尺
  const r6 = { ...recipeN(), bank: toRad('甲戶活存') };
  assert.ok(validateRecipeAgainstStatement(linesN(), r6, parsed).some(e => e.startsWith('bank：')),
    '★bank 抄成相容字寫法的帳戶標籤＝單槽直通路（r8#3）又打開了');
});

test('同一把尺｜參考日整段維持舊尺：相容字錨點＝讀不到＝null，但交易照樣匯入（保存型）', () => {
  // ⚠️ 這題守的是「**不要**把這把尺套進參考日」。套進去要算**位置**（錨點在哪結束、日期從哪開始掃），
  //   而位置一碰正規化就歪——Codex #523 連續四輪各抓到一種歪法，每一種都是「main 讀得到、
  //   改版讀不到或讀錯」，其中兩種會把餘額日期寫成**未來日** ⇒ 之後每份真帳單都被判 stale
  //   ⇒ 該帳戶餘額從此靜靜不再更新。William 2026-08-29 裁示「甲：整段退回」。
  //   代價（預期行為，不是缺陷）：帳單把參考日錨點印成相容字 ⇒ null ⇒ **只跳過餘額更新**。
  const ls = linesN();
  ls[0] = L(300, [[20, '合成金庫月結單'], [47, '存戶總表'], [452, `${toRad('結算日')}:2026/06/30`]]);
  assert.notEqual(toRad('結算日'), '結算日', '★樣本必須真的換得動字');
  const p = parseWithRecipe(ls, recipeN());
  assert.equal(p.referenceDate, null, '★相容字錨點＝讀不到參考日（與 main 相同；套上新尺才會變成讀得到）');
  assert.equal(p.transactions.length, 1, '★★但交易照樣匯入——參考日只管「要不要更新餘額」');
  assert.equal(p.accounts.length, 1, '★帳戶也照樣解出來');
  // 正規字錨點照舊讀得到（證明差別只在錨點的印法，不是這段壞了）
  assert.equal(parseWithRecipe(linesN(), recipeN()).referenceDate, '2026-06-30', '對照組：正規字錨點正常');
  // **另一個方向**：規則卡上的錨點抄成相容字、帳單印正規字 ⇒ 一樣讀不到（錨點兩邊都走舊尺）。
  //   只考帳單那一邊的話，「錨點改走新尺」那一刀會活過去（突變 U2 實測）。
  const rRad = { ...recipeN(), refDate: { ...recipeN().refDate, anchor: toRad('結算日') } };
  assert.deepEqual(validateRecipeStrict(rRad), [], '前提：相容字寫法的錨點也是合法配方');
  assert.equal(parseWithRecipe(linesN(), rRad).referenceDate, null,
    '★配方那一邊也走舊尺——把錨點改走新尺，這裡就會變成讀得到');
  // **控制流也要顧**（Codex r5#1）：新尺會提早認出相容字表頭並收尾 ⇒ 舊尺的參考日區塊
  //   根本沒機會跑。實測同一份帳單 main 讀 2026-06-30、只換尺讀 null——修好區塊內部不夠。
  const early = linesN();
  early.splice(4, 0, L(280, [[47, '結算日:2026/06/30'], [200, toRad('車號')], [272, toRad('支出金額')],
    [331, toRad('存入金流')], [396, toRad('本日餘額')], [489, toRad('日誌註記')]]));
  early[0] = L(300, [[20, '合成金庫月結單'], [47, '存戶總表']]);   // 參考日搬到那一列上，第一列不再有
  const pe = parseWithRecipe(early, recipeN());
  assert.equal(pe.referenceDate, '2026-06-30',
    '★★參考日要在「因新尺表頭而收尾」之前先跑——否則 main 讀得到的參考日會整個跳掉');
  assert.equal(pe.transactions.length, 1, '★而且那一列被當表頭收尾之後，明細照樣解得出來');
  // 但**舊尺就認得的表頭**那一列，main 是先收尾、不讀參考日——我們也不可以讀（否則就是比 main 多讀）。
  //   少了這個 guard，上面那一題照樣綠（突變實測），所以這一刀要另外考。
  const onHeader = linesN();
  onHeader[0] = L(300, [[20, '合成金庫月結單'], [47, '存戶總表']]);   // 第一列不再有參考日
  onHeader[4] = L(120, [[47, '結算日:2026/06/30'], [75, '帳號'], [135, '日期'], [200, '車號'],
    [272, '支出金額'], [331, '存入金流'], [396, '本日餘額'], [489, '日誌註記']]);
  assert.equal(parseWithRecipe(onHeader, recipeN()).referenceDate, null,
    '★參考日印在（舊尺就認得的）表頭列上＝main 先收尾、不讀 ⇒ 我們也不讀');
  // **日期候選也整段走舊尺**：一顆全形數字貼著民國日期時，正規化會把候選整顆吃掉（r2 那型）。
  //   只考錨點的話，「掃描器吃正規化後的切片」那一刀會活過去（突變 U3 實測）。
  const rocLines = linesB();
  rocLines[0] = L(300, [[20, '合成郵局存簿'], [47, '帳務期間２115/05/06列印日116/05/06']]);
  assert.equal(parseWithRecipe(rocLines, { ...recipeB(), refDate: { strategy: 'anchored-date', anchor: '帳務期間' } }).referenceDate,
    '2026-05-06', '★候選在原文上產生（吃掉候選的話會變成 2027-05-06）');
});

test('同一把尺｜辨識一律「舊尺或新尺」：新尺只增不減，main 認得的一定也認得（裁示「甲」）', () => {
  // ⚠️ 我一路假設「新尺 ⊇ 舊尺」——**那不成立**。NFKC 會把**跨格相鄰**的字合成掉
  //   （`A`＋U+030A ⇒ `Å`），於是有些東西**舊尺認得、新尺反而不認得**。只換成新尺 ⇒ 我們會在
  //   main 停下來的地方繼續往前（r6 實測：銀行身分牆 fail-open、概要多讀帳戶、靜默漏交易）。
  const R = '\u030A';
  // ①**屬性**：舊尺命中 ⇒ `hitEither` 一定命中（這是「只增不減」的機械定義）
  const cases = [
    ['甲A' + R + '乙', '甲A'],            // ★跨格相鄰被合成：舊尺命中、新尺不命中
    ['現金帳戶總覽', '現金帳戶總覽'],      // 兩尺都命中
    ['現⾦帳戶總覽', '現金帳戶總覽'],      // 只有新尺命中（本支要修的病）
    ['第１２３類', '第123類'],
    ['無關文字', '找不到的'],
  ];
  for (const [text, needle] of cases) {
    const oldHit = squash(text).includes(squash(needle));
    if (oldHit) assert.equal(hitEither(text, needle), true, `★舊尺命中「${needle}」⇒ hitEither 必須也命中`);
  }
  // 前提自檢：第一組真的是「舊尺命中、新尺不命中」，否則整題什麼都沒測
  assert.equal(squash('甲A' + R + '乙').includes(squash('甲A')), true, '★前提：舊尺要命中');
  assert.equal(recipeNorm('甲A' + R + '乙').includes(recipeNorm('甲A')), false, '★前提：新尺要不命中');
  assert.equal(hitEither('甲A' + R + '乙', '甲A'), true, '★★hitEither 要接住它');
  assert.equal(hitEither('現⾦帳戶總覽', '現金帳戶總覽'), true, '★新尺那一半也要在（否則本支主修沒了）');
  // ②**端到端**：暗號／區段錨點／收尾錨點三個辨識點各放一個「舊尺才認得」的形狀，整份要照常解出來
  const r = { ...recipeN(), docAnchors: ['存戶總表A', '收支明細月報'],
    summary: { ...recipeN().summary, sections: [{ anchor: '存戶總表A', currency: 'TWD' }], endAnchor: '本頁小計A' } };
  assert.deepEqual(validateRecipeStrict(r), [], '前提：這是合法配方');
  const ls = linesN();
  ls[0] = L(300, [[20, '合成金庫月結單'], [47, '存戶總表A'], [60, R + '註'], [452, '結算日:2026/06/30']]);
  ls[2] = L(240, [[47, '本頁小計A' + R], [445, '$1,230']]);
  assert.equal(recipeMatches(ls, r), true, '★暗號：舊尺認得的，新尺認不得也要算認得');
  const p = parseWithRecipe(ls, r);
  assert.equal(p.accounts.length, 1, '★區段錨點：舊尺認得 ⇒ 概要區照樣開得起來');
  assert.equal(p.transactions.length, 1, '★收尾錨點：舊尺認得 ⇒ 概要區照樣收得了尾');
  assert.equal(p.referenceDate, '2026-06-30');
  // ③**銀行身分**、**findX**、**表頭完整性**三個辨識點各再一個「舊尺才認得」的形狀
  //   （突變實測：只靠上面那三點，這三格的刀都活得下來）。
  const r2 = { ...recipeN(), bank: '合成金庫A',
    detail: { ...recipeN().detail, headerOut: `支出A ${R}` } };   // 錨點帶空白 ⇒ 新尺不合成；帳單那格沒空白 ⇒ 會合成
  assert.deepEqual(validateRecipeStrict(r2), [], '前提：這是合法配方');
  const ls2 = linesN();
  ls2[0] = L(300, [[20, '合成金庫A'], [40, R + '月結單'], [47, '存戶總表'], [452, '結算日:2026/06/30']]);
  ls2[4] = L(120, [[75, '帳號'], [135, '日期'], [200, '車號'], [272, `支出A${R}`],
    [331, '存入金流'], [396, '本日餘額'], [489, '日誌註記']]);
  // 前提自檢：這兩處真的是「舊尺命中／相等、新尺不命中／不相等」
  assert.equal(hitEither('合成金庫A' + R + '月結單', '合成金庫A'), true);
  assert.equal(recipeNorm('合成金庫A' + R + '月結單').includes(recipeNorm('合成金庫A')), false, '★前提：銀行名新尺要不命中');
  assert.equal(squash(`支出A${R}`) === squash(`支出A ${R}`), true, '★前提：欄名舊尺要相等');
  assert.equal(recipeNorm(`支出A${R}`) === recipeNorm(`支出A ${R}`), false, '★前提：欄名新尺要不相等');
  const p2 = parseWithRecipe(ls2, r2);
  assert.equal(p2.transactions.length, 1,
    '★★銀行身分／findX／表頭完整性三處都要收舊尺——少一處就是 main 解得動、我們解不動');
});

test('同一把尺｜「是哪一個」不能取聯集：兩把尺裁決不同＝歧義拒解（Codex r9）', () => {
  // ⚠️ 聯集只對**布林**（「是不是表頭／有沒有這個暗號」）成立。一旦要在候選之間**挑一個**，
  //   聯集會改寫 main 的答案：同一列可以「A 段只有舊尺命中、B 段只有新尺命中」，而 `.find()`
  //   取配方**列序**第一個 ⇒ main 選 B、聯集版選 A。
  //   實測後果不只是標籤：真台幣帳戶被統計成外幣（`foreignAccountsSkipped`），匯入端會把它的
  //   交易**當外幣直接略過** ⇒ **現金流漏帳**，而強閘仍是 strong。
  //   ⇒ 裁決一律**舊尺優先**（＝main 的答案），新尺只在舊尺沒有裁決時補上；**兩把尺裁決不同＝拒解**。
  //   代價（誠實）：這種版面 main 解得動、我們退 AI——歧義不猜是這支檔一貫的立場。
  const mk = (/** @type {any[]} */ sections, /** @type {string} */ endAnchor) => ({ ...recipeN(),
    summary: { ...recipeN().summary, sections, endAnchor } });
  const run = (/** @type {any} */ r, /** @type {string} */ anchorCell) => {
    const ls = linesN();
    ls[0] = L(300, [[20, '合成金庫月結單'], [47, anchorCell], [452, '結算日:2026/06/30']]);
    return parseWithRecipe(ls, r);
  };
  // ①半形片假名：帳單印 `ｶﾞ`；前列錨點用合成的 `ガ`（只有新尺命中）、後列用 `ｶ`（只有舊尺命中）
  const r1 = mk([{ anchor: '存戶總表ガ', currency: 'USD' }, { anchor: '存戶總表ｶ', currency: 'TWD' }], '本頁小計');
  assert.deepEqual(validateRecipeStrict(r1), [], '前提：strict 看不出這個歧義（兩個錨點在同尺下都不互含）');
  assert.equal(squash('存戶總表ｶﾞ').includes(squash('存戶總表ｶ')), true, '★前提：後列只有舊尺命中');
  assert.equal(recipeNorm('存戶總表ｶﾞ').includes(recipeNorm('存戶總表ガ')), true, '★前提：前列只有新尺命中');
  assert.throws(() => run(r1, '存戶總表ｶﾞ'),
    (/** @type {any} */ e) => e.code === 'recipe_parse_failed' && /裁決不同/.test(e.message),
    '★★聯集版會選到 USD ⇒ 真台幣帳戶被當外幣略過（現金流漏帳）');
  // ②韓文相容序列：同一族的另一種形狀
  const r2 = mk([{ anchor: '存戶總表가', currency: 'USD' }, { anchor: '存戶總表ㄱ', currency: 'TWD' }], '本頁小計');
  assert.throws(() => run(r2, '存戶總表ㄱㅏ'),
    (/** @type {any} */ e) => e.code === 'recipe_parse_failed' && /裁決不同/.test(e.message),
    '★同族第二種形狀');
  // ③**區段 vs 收尾**跨尺：新尺 section 排在舊尺 endAnchor 之前 ⇒ main 收尾、聯集版反而重開一段
  const r3 = mk([{ anchor: '存戶總表', currency: 'TWD' }, { anchor: '本頁小計ガ', currency: 'USD' }], '本頁小計ｶ');
  const ls3 = linesN();
  ls3[2] = L(240, [[47, '本頁小計ｶﾞ'], [445, '$1,230']]);
  assert.throws(() => parseWithRecipe(ls3, r3),
    (/** @type {any} */ e) => e.code === 'recipe_parse_failed' && /裁決不同/.test(e.message),
    '★收尾與區段在兩把尺下裁決不同＝一樣拒解');
  // 對照組：兩把尺裁決**相同**時照常解（別把整條判成「什麼都拒」）
  const ok = mk([{ anchor: '存戶總表', currency: 'TWD' }], '本頁小計');
  assert.equal(run(ok, '存戶總表').accounts[0].currency, 'TWD', '對照組：沒有跨尺歧義就照常解');
});

test('同一把尺｜歧義守門也要「任一尺看到衝突就拒收」——不是只走新尺（Codex r7）', () => {
  // ⚠️ 我曾宣稱「拒收型守門只走新尺＝比 main 嚴」——**那句是錯的**：兩把尺**不可比較**，
  //   舊尺看得到的衝突新尺可能看不到 ⇒ 變成 **main 拒收、我們放行**。實測後果：台幣帳戶被標成
  //   USD、歧義表頭下的 1,200 被解成一筆支出。⇒ 歧義守門與辨識**對稱**：`old || new`。
  const K = '\u030A';
  // ①區段錨點互為子字串：舊尺（去空白後）是前綴、新尺（先 NFKC）因為 A+K 合成而看不出重疊
  const r1 = { ...recipeN(), summary: { ...recipeN().summary,
    sections: [{ anchor: `總覽A ${K}`, currency: 'USD' }, { anchor: `總覽A${K}乙`, currency: 'TWD' }] } };
  assert.equal(squash(`總覽A${K}乙`).includes(squash(`總覽A ${K}`)), true, '★前提：舊尺要看得到重疊');
  assert.equal(recipeNorm(`總覽A${K}乙`).includes(recipeNorm(`總覽A ${K}`)), false, '★前提：新尺要看不到');
  assert.ok(validateRecipeStrict(r1).some(e => e.includes('互為子字串')),
    '★★只看新尺＝放行 ⇒ 引擎用舊尺命中先列的短錨點、外幣區被台幣段吃掉（實測帳戶變 USD）');
  // ②欄位角色撞名：同一族（`findX` 接受舊尺相等，撞名稽核也必須看舊尺）
  const r2 = { ...recipeN(), detail: { ...recipeN().detail, headerOut: `支出A${K}`, headerIgnore: [`支出A ${K}`] } };
  assert.equal(squash(`支出A${K}`) === squash(`支出A ${K}`), true, '★前提：舊尺要看到撞名');
  assert.equal(recipeNorm(`支出A${K}`) === recipeNorm(`支出A ${K}`), false, '★前提：新尺要看不到');
  assert.ok(validateRecipeStrict(r2).some(e => e.includes('不可相同')), '★忽略欄用舊尺撞支出欄名＝findX 綁同一格');
  // ③表頭同名格重複：守門必須與 findX 用**完全同一組**判準
  const r3 = { ...recipeN(), detail: { ...recipeN().detail, headerOut: `支出A ${K}` } };
  const ls = linesN();
  ls[4] = L(120, [[75, '帳號'], [135, '日期'], [200, '車號'], [272, `支出A ${K}`], [300, `支出A${K}`],
    [331, '存入金流'], [396, '本日餘額'], [489, '日誌註記']]);
  ls[5] = L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [289, 30, '$1,200'], [418, 0, '$30']]);
  assert.throws(() => parseWithRecipe(ls, r3),
    (/** @type {any} */ e) => e.code === 'recipe_parse_failed' && /重複/.test(e.message),
    '★★守門比 findX 窄＝第二格漏數 ⇒ 它下面的 1,200 被解成一筆支出（main 是拒解的）');
  // ④出生對照：舊尺才等值的交易內文，不得冒充版面錨點（引擎正是用舊尺命中它）
  const r4 = { ...recipeN(), detail: { ...recipeN().detail, headerIgnore: [`敏感A ${K}`] } };
  assert.ok(validateRecipeAgainstStatement(linesN(), r4, { transactions: [{ summary: `敏感A${K}`, note: '' }], accounts: [] })
    .some(e => e.includes('相等')), '★**等值**約束要兩把尺——否則舊尺才等值的交易內文可以冒充錨點');
  // 位置約束也要各考一刀（只考等值的話，位置那一刀活得下來——突變 Y6 實測）：
  //   這個槽**不等於**任何內文，但舊尺在交易列上找得到、新尺找不到。
  const posSlot = `合成轉A ${K}`;
  const lsPos = linesN();
  lsPos[5] = L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, `合成轉A${K}尾`],
    [349, 40, '$500'], [418, 0, '$1,730']]);
  assert.equal(squash(`合成轉A${K}尾`).includes(squash(posSlot)), true, '★前提：舊尺在交易列上找得到');
  assert.equal(recipeNorm(`合成轉A${K}尾`).includes(recipeNorm(posSlot)), false, '★前提：新尺找不到');
  const r5 = { ...recipeN(), detail: { ...recipeN().detail, headerIgnore: [posSlot] } };
  assert.ok(validateRecipeAgainstStatement(lsPos, r5, { transactions: [{ summary: `合成轉A${K}尾`, note: '' }], accounts: [] })
    .some(e => e.includes('交易列')), '★**位置**約束也要兩把尺（與引擎命中同一組）');
});

test('同一把尺｜表頭邊界一律 old||new：舊尺認得、新尺不認得的那一格，不可跨過 main 的結構邊界', () => {
  // ⚠️ Codex #523 r6：真值表的第四格。NFKC 會把**跨格相鄰**的字合成掉——欄名尾字 `A` 與下一格
  //   開頭的組合附標 U+030A 併成 `Å` ⇒ 舊尺三個 substring 都命中、新尺不命中。
  //   只用新尺當邊界時，head 會**跨過 main 停下來的地方**繼續解析：銀行身分牆由 fail-closed
  //   變 fail-open、概要多讀帳戶、甚至靜默漏掉一筆交易。那不是「比較寬鬆」，是**比 main 危險**。
  //   ⇒ 結構邊界（銀行身分／概要收尾／明細起點）一律 `old || new`。
  const r = { ...recipeN(), detail: { ...recipeN().detail, headerOut: '支出A', headerIn: '\u030A存入B', headerBalance: '餘額C' } };
  assert.deepEqual(validateRecipeStrict(r), [], '前提：這是合法配方');
  const oldOnly = L(280, [[200, '車號'], [272, '支出A'], [300, '\u030A存入B'], [396, '餘額C'], [489, '日誌註記']]);
  // 前提自檢：這一列**舊尺命中、新尺不命中**（不成立的話這題什麼都沒測）
  const joinedRaw = oldOnly.cells.map(c => c.s).join('');
  const inAll = (/** @type {(s: string) => string} */ rule) =>
    ['支出A', '\u030A存入B', '餘額C'].every(n => rule(joinedRaw).includes(rule(n)));
  assert.equal(inAll(squash), true, '★前提：舊尺要命中');
  assert.equal(inAll(recipeNorm), false, '★前提：新尺要不命中（A＋U+030A 被合成成 Å）');
  // ①銀行身分牆：銀行名只出現在 old-only 表頭**之後** ⇒ main 拒解，我們也要拒解（不可 fail-open）
  const late = [
    L(320, [[47, '存戶總表']]),
    L(310, [[50, '甲戶活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(300, [[47, '本頁小計'], [445, '$1,230']]),
    oldOnly,
    L(200, [[20, '合成金庫月結單'], [47, '收支明細月報']]),
    L(120, [[75, '帳號'], [135, '日期'], [200, '車號'], [272, '支出A'], [331, '\u030A存入B'], [396, '餘額C'], [489, '日誌註記']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730']]),
  ];
  assert.throws(() => parseWithRecipe(late, r),
    (/** @type {any} */ e) => e.code === 'recipe_parse_failed' && /銀行身分/.test(e.message),
    '★★只用新尺當邊界＝身分牆整個跳過（fail-open）——要與 main 一樣擋在「銀行身分對不上」');
  // ②概要收尾：概要區還開著就撞上 old-only 表頭 ⇒ main 拒解，我們也要拒解
  const unclosed = [
    L(320, [[20, '合成金庫月結單'], [47, '存戶總表']]),
    L(310, [[50, '甲戶活存'], [150, '900100****3301'], [473, '$1,230']]),
    oldOnly,
    L(200, [[47, '收支明細月報']]),   // 第二條暗號（否則會先撞「版面暗號對不上」）
    L(120, [[75, '帳號'], [135, '日期'], [200, '車號'], [272, '支出A'], [331, '\u030A存入B'], [396, '餘額C'], [489, '日誌註記']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成轉入'], [349, 40, '$500'], [418, 0, '$1,730']]),
  ];
  assert.throws(() => parseWithRecipe(unclosed, r),
    (/** @type {any} */ e) => e.code === 'recipe_parse_failed' && /未收尾/.test(e.message),
    '★概要未收尾就撞 old-only 表頭＝main 拒解，我們也要拒解');
});

test('同一把尺｜引擎輸出的文字**不**正規化：原文留底／去重鍵／帳號身分三條界線（保存型）', () => {
  // 這題守的是「**不要**做什麼」。正規化一旦流進**存下來的字**，會同時打破三件事：
  //  ①`bankSummary`／`bankNote` 的「帳單原文、一字未改」契約（`lib/types.js`）
  //  ②`bankRef` 精準去重（單邊正規化＝同一筆交易兩條路線的鍵不同；`skipSimilar` 是選配、擋不住）
  //  ③`noteAccountSuffixes` 的帳號身分——NFKC 把 `①` 折成 `1`（`lib/bank-statement.js` 的
  //    `foldWidth` 早就為了同一個理由拒絕對帳號整串做 NFKC，#504 r8#4）
  // 走過並被打掉的路＝William 2026-08-28 先裁「乙＝輸出也正規化」、Codex #523 r2 打掉三條後
  // 於 2026-08-29 改裁「縮回只修辨識層」。
  const lines = linesN();
  // ⚠️ **四個文字欄都要有樣本**（Codex #523 r3#2：原本只放了交易那兩欄，帳戶 label／note 兩條路
  //   各下一刀都仍全綠＝題名宣稱四欄、實際只守兩欄）。
  lines[1] = L(280, [[50, toRad('甲戶活存')], [150, '900100****3301'], [473, '$1,230'], [530, toRad('月報')]]);
  lines[5] = L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, toRad('信用卡款')],
    [289, 30, '$500'], [418, 0, '$730'], [500, 0, '****①234']]);
  for (const w of ['信用卡款', '甲戶活存', '月報']) assert.notEqual(toRad(w), w, `★樣本「${w}」必須真的換得動字`);
  const p = parseWithRecipe(lines, recipeN());
  assert.equal(p.accounts[0].label, toRad('甲戶活存'), '★帳戶標籤照帳單原文輸出');
  assert.equal(p.accounts[0].note, toRad('月報'), '★帳戶備註照帳單原文輸出');
  assert.equal(p.transactions[0].summary, toRad('信用卡款'), '★交易摘要照帳單原文輸出');
  assert.equal(p.transactions[0].note, '****①234', '★交易備註照帳單原文輸出（連 ① 都不動）');
  // ★行為面（不是字串面）：`①` 一旦被折成 `1` 就被抽成自有帳號末碼 ⇒ 一般支出被判成內轉
  //   ⇒ transfer 不進收支加總 ⇒ **真支出從現金流消失**。
  assert.equal(classifyBankTx(p.transactions[0], new Set(['1234'])).type, 'expense',
    '★★備註做了 NFKC ⇒ ****①234 變 ****1234 ⇒ 真支出被判成內轉、從現金流消失');
});

test('既有缺陷現況｜帳單印相容字時分類關鍵字漏認（characterization，**不是**本支的界線）', () => {
  // ⚠️ 這題**只描述現況**，刻意與上面那條保存型界線分開（Codex #523 r3#3：混在一起的話，
  //   日後有人把分類層修好、這題轉紅，會被誤讀成「輸出不正規化」那條界線壞了）。
  //   現況＝`classifyBankTx` 的關鍵字是正規字寫的，`信⽤卡款`(U+2F64) 過不了 `/卡費|信用卡款/`
  //   ⇒ 繳卡費掉進「其他/未分類」、與已分類的卡明細重複計算。
  //   ⚠️ **main 上就到得了**（AI 忠實照抄相容字時，暗號兩邊同形、舊尺照樣命中、出生驗收照樣過），
  //   不是本支造成、也不由本支修——要修是修**分類那一層**（比對用正規形、原文不動）。
  //   修好那天這題會紅：**紅了就把這題刪掉**，不要為了它保留缺陷。
  // ⚠️ **刻意不經過配方引擎**（Codex #523 r4#3）：經過引擎的話，動到「引擎輸出邊界」那條界線
  //   會連坐這一題，兩題就分不開了。這題只問分類器本身。
  const tx = (/** @type {string} */ summary) => ({ acctSuffix: '3301', acctMasked: '900100****3301',
    date: '2026-06-11', summary, direction: /** @type {const} */ ('out'), amount: 500, balance: 730, note: '' });
  assert.notEqual(toRad('信用卡款'), '信用卡款', '★樣本必須真的換得動字');
  assert.deepEqual(classifyBankTx(tx(toRad('信用卡款')), new Set()),
    { type: 'expense', category: '其他', subcategory: '未分類' }, '現況：相容字寫法漏認、落在「其他/未分類」');
  assert.deepEqual(classifyBankTx(tx('信用卡款'), new Set()),
    { type: 'expense', category: '', subcategory: '' }, '對照組：正規字寫法＝繳卡費不分類（差別只在字體）');
});
test('同一把尺｜槽位長度「兩把尺任一太短就拒收」：一個字元不得靠 NFKC 展開混過去', () => {
  // minLen 存在的理由＝1 字錨點會在交易列或常見版面文字上誤觸發。
  // ⚠️ 只量新尺時，`㈱`／`⑴`／`№`／`㍿` 這類**一個字元**會被展開成 `(株)`／`(1)`／`No`／`株式会社`
  //   ⇒ 長度過關 ⇒ **main 拒收、我們放行**（Codex #523 r8）。⇒ 與其他守門對稱：任一尺太短就拒收。
  //   ⚠️ 我原本在這裡寫的是相反的斷言（要求 `㈱` 合格）＝**那題在保護一個相對 main 的放寬**。
  for (const [ch, why] of [['¯', 'NFKC 展成「空白＋附標」'], ['㈱', '展開成 (株)'],
    ['⑴', '展開成 (1)'], ['№', '展開成 No'], ['㍿', '展開成 株式会社']]) {
    const r = recipeA(); r.docAnchors[0] = ch;
    assert.ok(validateRecipeStrict(r).some(e => e.includes('至少 2 個字')),
      `★一個字元的「${ch}」（${why}）＝main 拒收，我們也要拒收`);
  }
  // **另一個方向**：舊尺看起來有兩個字、新尺合成後只剩一個 ⇒ 也要拒收（比 main 嚴＝fail-closed，
  //   因為拿去比對時它真的只有一個字）。只量舊尺的話這一刀活得下來（突變 Z2 實測）。
  const composed = recipeA(); composed.docAnchors[0] = 'e\u0301';   // squash 後 2 個字、NFKC 合成成 é
  assert.equal(squash('e\u0301').length, 2, '★前提：舊尺看起來有兩個字');
  assert.equal(recipeNorm('e\u0301').length, 1, '★前提：新尺合成後只剩一個');
  assert.ok(validateRecipeStrict(composed).some(e => e.includes('至少 2 個字')),
    '★新尺看出來太短也要拒收——拿去比對時它真的只有一個字');
  // 對照組：真的有兩個字的錨點照樣合格（別把整條 minLen 判成「什麼都拒」）
  const ok = recipeA(); ok.docAnchors[0] = '總覽';
  assert.deepEqual(validateRecipeStrict(ok), [], '對照組：兩個字的正當錨點不受影響');
});
