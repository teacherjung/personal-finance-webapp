// P2-1 配方純模組的考題：格式驗證器（零帳單內容＝機械拒收）＋泛化引擎（兩套**虛構版面**
// ——詞彙刻意不用台新的，證明引擎沒有寫死的銀行殘留）＋台新等價交叉驗證＋出生驗收比對器。
// 合成資料紀律：帳號一律 900100/900200/900300 前綴＋假末碼，金額/摘要全虛構，零真實帳單內容。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECIPE_FORMAT_VERSION, RECIPE_LIMITS, validateRecipeStrict, recipeMatches, parseWithRecipe, recipeReproduces,
  validateRecipeAgainstStatement,
} from '../lib/parse-recipe.js';
import { parseBankSummary, parseBankDetail, splitAmount } from '../lib/bank-statement.js';
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
  assert.deepEqual(p.accountCurrency, { '900100****3301': 'TWD', '900200****3302': 'TWD', '900300****363': 'JPY' });
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

test('引擎｜右側忽略欄（#408 H² 同型、預審①）：序號欄在存入欄右邊也要擋——兩條路都是', () => {
  const igRight = { ...recipeA(), detail: { ...recipeA().detail, headerIgnore: ['流水號'], headerNote: null } };
  const header = L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [360, '流水號'], [396, '結存餘額']]);
  const doc = (rows) => [L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]), L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄明細']]), header, ...rows];
  // 純序號列：右緣 365+20=385 落在 [流水號360, 結存396)——原版寫死 [xIgn,xOut) 會把它判成存款
  const ghost = parseWithRecipe(doc([
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成入帳'], [335, 20, '$500'], [418, 0, '$1,730']]),
    L(83, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [365, 20, '0067890']]),
  ]), igRight);
  assert.equal(ghost.transactions.length, 1, '★純序號列不可變成幽靈存款 67,890 元');
  // r21 終局後：退路救援已整段移除——分不進窗的嚴格金額（右緣 260 < 提領 272）＝歧義拒解
  assert.throws(() => parseWithRecipe(doc([
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/13'], [250, 10, '$777'], [365, 20, '0067890']]),
  ]), igRight), (e) => e.code === 'recipe_parse_failed',
    '★真漂移金額退 AI 重讀——無主地帶的救援正是 r21 憑空支出的來源');
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
  assert.throws(() => parseWithRecipe(doc, rec), (e) => e.code === 'recipe_parse_failed',
    '★同遮罩兩種幣別＝交易歸屬歧義＝拒解退 AI，不可套上錯的權威幣別');
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
  const ig = { ...recipeA(), detail: { ...recipeA().detail, headerIgnore: ['處理類別'], headerNote: null } };
  const p = parseWithRecipe([
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [360, '處理類別'], [396, '結存餘額']]),
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '一般扣款'], [289, 15, '$100'], [365, 0, '劃撥'], [418, 0, '$900']]),
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [177, 0, '一般扣款'], [289, 15, '$100'], [365, 0, '劃撥'], [418, 0, '$800']]),
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
