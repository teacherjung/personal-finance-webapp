// P2-1 配方純模組的考題：格式驗證器（零帳單內容＝機械拒收）＋泛化引擎（兩套**虛構版面**
// ——詞彙刻意不用台新的，證明引擎沒有寫死的銀行殘留）＋台新等價交叉驗證＋出生驗收比對器。
// 合成資料紀律：帳號一律 900100/900200/900300 前綴＋假末碼，金額/摘要全虛構，零真實帳單內容。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECIPE_FORMAT_VERSION, RECIPE_LIMITS, validateRecipeStrict, recipeMatches, parseWithRecipe, recipeReproduces,
  validateRecipeAgainstStatement,
} from '../lib/parse-recipe.js';
import { parseBankSummary, parseBankDetail } from '../lib/bank-statement.js';
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
  // 退路下界不可被右側忽略欄毒化：真金額右緣分不出欄（r 越過 xBal）→ 退路要撿回、序號要跳過
  const fb = parseWithRecipe(doc([
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/13'], [250, 10, '$777'], [365, 20, '0067890']]),
  ]), igRight);
  assert.equal(fb.transactions.length, 1);
  assert.deepEqual([fb.transactions[0].amount, fb.transactions[0].direction], [777, 'out'], '★退路撿回真金額、不撿序號');
});

test('引擎｜退路正向兩邊：右緣分不出欄時左緣過中線判向（金流正負號的最後防線）', () => {
  // 版面沒有忽略欄（有忽略欄時，右緣落在票號區間的格「兩條路都擋」是另一題的職責）
  const noIgn = { ...recipeA(), detail: { ...recipeA().detail, headerIgnore: [], headerNote: null } };
  const lines = [
    ...linesA().slice(0, 9),
    L(120, [[75, '帳號'], [135, '日期'], [272, '提領金額'], [331, '存進金額'], [396, '結存餘額']]),
    // 右緣 250+10=260 < 提領欄 272 ＝分不出；左緣 250 < 中線 (272+331)/2 → out
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [177, 0, '合成甲'], [250, 10, '$1,234']]),
    // 右緣 350+60=410 ≥ 結存欄 396 ＝分不出；左緣 350 ≥ 中線 → in
    L(83, [[53, 0, '900200****3302'], [124, 0, '2026/06/12'], [177, 0, '合成乙'], [350, 60, '$5,678']]),
  ];
  const p = parseWithRecipe(lines, noIgn);
  assert.deepEqual(p.transactions.map(t => [t.direction, t.amount]), [['out', 1234], ['in', 5678]]);
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

test('引擎｜欄序反轉（r1#1）：存入欄在支出欄左側的版面——主路、退路、下界都不可假設「支出在左」', () => {
  const rev = { ...recipeA(), detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: '存進金額', headerBalance: '結存餘額', headerNote: null, headerIgnore: [] } };
  const doc = [
    L(300, [[20, '合成銀行月結單'], [47, '合成帳戶總覽區'], [452, '結算基準日:2026/06/30']]),
    L(280, [[50, '甲種活存'], [150, '900100****3301'], [473, '$1,230']]),
    L(240, [[47, '總計']]),
    L(140, [[47, '往來紀錄']]),
    L(120, [[75, '帳號'], [135, '日期'], [272, '存進金額'], [331, '提領金額'], [396, '結存餘額']]),   // ★存進在左
    // 主路：右緣 290+12=302 落在 [存進272, 提領331) → in
    L(100, [[53, 0, '900100****3301'], [124, 0, '2026/06/11'], [290, 12, '$500']]),
    // 退路：右緣 250+10=260 < 272 分不出；左緣 250 < 中線 301.5＝**靠左那欄＝存進** → in
    //（r1 實測：原版下界 xOut-60=271 直接把這列丟掉＝首筆入帳無聲消失、強閘照樣放行）
    L(90, [[53, 0, '900100****3301'], [124, 0, '2026/06/12'], [250, 10, '$700']]),
    // 主路：右緣 340+20=360 落在 [提領331, 結存396) → out
    L(80, [[53, 0, '900100****3301'], [124, 0, '2026/06/13'], [340, 20, '$200']]),
  ];
  const p = parseWithRecipe(doc, rev);
  assert.deepEqual(p.transactions.map(t => [t.direction, t.amount]),
    [['in', 500], ['in', 700], ['out', 200]],
    '★三列都在：退路不丟列、中線判向跟著欄序（左半＝存進不是支出）');
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
