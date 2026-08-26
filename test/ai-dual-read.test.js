// @ts-check
// P2-4 新版式雙讀＋三讀仲裁（裁示⑦ 2026-08-16）的行為卷：比對器逐欄承重／一致採 Opus 版／
// 仲裁「恰一份全欄一致」／三讀不同＝ai_disagree 列欄位不列值＋零發票／服務錯照實丟／
// 開關關閉回單讀階梯（那條路的完整行為卷在 test/ai-parse.test.js）／fail-open 判準／呼叫數釘 2·3·4。
// 隔離＝STORE_FILE 暫存檔；引擎全假＝零鑰匙零費用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_STORE = join(tmpdir(), `finance-dualread-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { aiBankRoute, previewBankStatement } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { clearAiTicketsForTest, aiTicketCountForTest } = await import('../lib/ai-confirm-ticket.js');
const { AI_BANK_MODELS, AI_ARBITER_MODEL, aiAnswersAgree, aiDiffSummary, dualReadWanted } = await import('../lib/ai-parse.js');
const { aiPreviewBadgeHtml } = await import('../public/modules/ai-consent.js');

// ---- 夾具：合成一銀版面（帳號一律 900200 前綴＝合成資料鐵則）----
const L = (/** @type {number} */ y, /** @type {any[]} */ pairs) => ({ y, cells: pairs.map((p) => ({ x: p[0], s: p[1] })) });
const linesA = () => [
  L(10, [[40, '一銀活期帳戶明細']]),
  L(30, [[40, '900200****1234'], [200, 'TWD'], [320, '5,000']]),
  L(50, [[40, '2026/07/01'], [140, '超商繳費'], [240, '100'], [320, '4,900']]),
  L(60, [[40, '2026/07/02'], [140, '薪資入帳'], [280, '600'], [320, '5,500']]),
];
const extractA = async () => linesA();
const notRecognized = async () => { throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400 }); };
/** 合法答案卷（過驗收＋接地＋強閘）；overrides 淺蓋頂層欄。 */
const answerOf = (/** @type {any} */ over = {}) => ({
  bank: '第一銀行', referenceDate: '2026-07-31',
  accountCurrencies: [{ masked: '900200****1234', currency: 'TWD' }],
  totals: { txCount: null, totalOut: null, totalIn: null },   // 版面沒印合計＝誠實缺席（接地檢查逐數字對原文）
  accounts: [{ masked: '900200****1234', balance: 5500, currency: 'TWD', label: '活期', note: '' }],
  transactions: [
    { acctMasked: '900200****1234', date: '2026-07-01', direction: 'out', amount: 100, balance: 4900, summary: '超商繳費', note: '' },
    { acctMasked: '900200****1234', date: '2026-07-02', direction: 'in', amount: 600, balance: 5500, summary: '薪資入帳', note: '' },
  ],
  ...over,
});
/** 假引擎：byModel[model] ＝答案（函式＝丟它的錯）；spy 記呼叫順序。 */
const engineOf = (/** @type {Record<string, any>} */ byModel, /** @type {{calls:string[]}} */ spy = { calls: [] }) => ({
  models: AI_BANK_MODELS,
  parseOnce: async (/** @type {string} */ _t, /** @type {string} */ model) => {
    spy.calls.push(model);
    const a = byModel[model];
    if (a === undefined) throw new Error(`夾具沒定義 ${model} 的答案`);
    if (typeof a === 'function') throw a();
    return structuredClone(a);
  },
});
const svcErr = (/** @type {string} */ code) => () => Object.assign(new Error(`合成服務錯（${code}）`), { status: 502, code });
const badAnswer = () => Object.assign(new Error('合成壞答案'), { status: 400, code: 'ai_bad_answer' });
async function seedDb(/** @type {any} */ settingsOver = {}) {
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = [];
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  delete (/** @type {any} */ (db.settings)).aiDualRead;   // 歸零：前一題的關閉設定不可洩漏到下一題（preview 承重題實抓過）
  Object.assign(db.settings, settingsOver);   // aiDualRead 預設不掛＝走「讀不到＝開」的正式路
  await saveDb(db);
  return getDb();
}
const S = AI_BANK_MODELS.primary, O = AI_BANK_MODELS.escalation, F = AI_ARBITER_MODEL;

// ---- 比對器 ----
test('比對器｜錢欄位逐欄承重：每一個比對欄改壞都要 disagree、diffs 只有欄位沒有數值', () => {
  const base = () => /** @type {any} */ ({
    bank: '第一銀行', referenceDate: '2026-07-31', accountCurrency: { '900200****1234': 'TWD' },
    accounts: [{ masked: '900200****1234', suffix: '1234', balance: 5500, currency: 'TWD', label: '活期', note: '' }],
    transactions: [{ acctSuffix: '1234', acctMasked: '900200****1234', date: '2026-07-01', summary: '超商繳費', direction: 'out', amount: 100, balance: 4900, note: '水電' }],
  });
  assert.deepEqual(aiAnswersAgree(base(), base()), { agree: true, diffs: [], textVariance: [] });
  for (const [patch, label] of /** @type {[（(p:any)=>void）, string][]} */ ([
    [(p) => { p.referenceDate = null; }, '現值參考日'],
    [(p) => { p.accountCurrency['900200****1234'] = 'USD'; }, '帳戶幣別表'],
    [(p) => { p.accounts[0].balance = 9; }, '帳戶餘額組成'],
    [(p) => { p.transactions[0].amount = 999; }, '第 1 筆交易的金額'],
    [(p) => { p.transactions[0].direction = 'in'; }, '第 1 筆交易的方向'],
    [(p) => { p.transactions[0].date = '2026-07-09'; }, '第 1 筆交易的日期'],
    [(p) => { p.transactions[0].balance = 1; }, '第 1 筆交易的餘額'],
    [(p) => { p.transactions[0].acctSuffix = '9999'; }, '第 1 筆交易的帳號末碼'],
    [(p) => { p.accounts[0].suffix = '9999'; }, '帳戶餘額組成'],
    [(p) => { p.accounts[0].currency = 'USD'; }, '帳戶餘額組成'],
    [(p) => { p.transactions[0].summary = '超商繳費A'; }, '第 1 筆交易的摘要'],
    [(p) => { p.transactions.pop(); }, '交易筆數'],
  ])) {
    const b = base(); patch(b);
    const r = aiAnswersAgree(base(), b);
    assert.equal(r.agree, false, `★${label} 改壞要 disagree`);
    assert.ok(r.diffs.includes(label), `diffs 要指認「${label}」（實得 ${JSON.stringify(r.diffs)}）`);
    assert.ok(!r.diffs.some((d) => /999|4900|5500|900200/.test(d)), 'diffs 絕不帶數值（機密紀律）');
  }
  // P2-4b（William 2026-08-17 裁示「移出機構名＋備註」＝真帳單第一課）：寫法差異＝建議面、不觸發
  for (const [patch, label] of /** @type {[（(p:any)=>void）, string][]} */ ([
    [(p) => { p.bank = '台新國際商業銀行'; }, '機構名'],
    [(p) => { p.transactions[0].note = '瓦斯'; }, '第 1 筆交易的備註'],
    [(p) => { p.transactions[0].acctMasked = '****1234'; }, '帳號印法'],
    [(p) => { p.accounts[0].masked = '****1234'; p.accountCurrency = { '****1234': 'TWD' }; }, '帳號印法'],
  ])) {
    const b = base(); patch(b);
    const r = aiAnswersAgree(base(), b);
    assert.equal(r.agree, true, `★${label} 寫法差異不觸發仲裁（W 裁示；重複風險由疑似重複提醒層接）`);
    assert.ok(r.textVariance.includes(label), `textVariance 要誠實列出「${label}」（實得 ${JSON.stringify(r.textVariance)}）`);
    assert.ok(!r.textVariance.some((d) => /999|4900|5500|900200|1234/.test(d)), '建議面同樣不帶值');
  }
});

test('比對器｜文字欄空白不敏感（摘要/備註）、label/note 刻意不比、順序嚴格', () => {
  const a = /** @type {any} */ ({ bank: 'x', referenceDate: null, accountCurrency: {}, accounts: [], transactions: [{ acctSuffix: '1', acctMasked: 'm', date: 'd', summary: '超商 繳費', direction: 'out', amount: 1, balance: null, note: '水 電' }] });
  const b = structuredClone(a); b.transactions[0].summary = '超商繳費'; b.transactions[0].note = '水電';
  const rws = aiAnswersAgree(a, b);
  assert.equal(rws.agree, true, '★只差格間空白＝一致（兩個模型取空白本來就不同）');
  assert.deepEqual(rws.textVariance, [], '★只差空白連「建議面」都不列（不做狼來了）');
  const g = structuredClone(a); g.bank = '第一 銀行'; const h = structuredClone(a); h.bank = '第一銀行';
  const rb = aiAnswersAgree(g, h);
  assert.equal(rb.agree, true, '★r1#1：機構名只差排版空白＝一致');
  assert.deepEqual(rb.textVariance, [], '空白差異連建議面都不列');
  // P2-4b 取捨誠實記載：機構名**整欄**移出觸發（W 2026-08-17 裁示）——連「真的不同家」也只列建議面、
  // 採 Opus 版。代價寫進契約：兩模型對同一份帳單讀出不同機構＝其中一個誤讀，靠徽章建議句給使用者看。
  const g2 = structuredClone(a); g2.bank = '第一銀行'; const h2 = structuredClone(a); h2.bank = '第二銀行';
  const rb2 = aiAnswersAgree(g2, h2);
  assert.equal(rb2.agree, true, '★裁示後不同寫法（含不同家）都不觸發');
  assert.ok(rb2.textVariance.includes('機構名'), '但建議面必須誠實列出');
  const c = /** @type {any} */ ({ bank: 'x', referenceDate: null, accountCurrency: {}, accounts: [{ masked: 'm', suffix: '1', balance: 5, currency: 'TWD', label: '活儲', note: 'A' }], transactions: [] });
  const d = structuredClone(c); d.accounts[0].label = '活期儲蓄'; d.accounts[0].note = 'B';
  assert.equal(aiAnswersAgree(c, d).agree, true, '★帳戶 label/note 措辭不同＝不比（不進帳本金額與去重鍵）');
  const e = structuredClone(a); const f = structuredClone(a);
  f.transactions = [structuredClone(a.transactions[0]), structuredClone(a.transactions[0])];
  e.transactions = [structuredClone(a.transactions[0]), structuredClone(a.transactions[0])];
  f.transactions[0].amount = 2; e.transactions[1].amount = 2;
  assert.equal(aiAnswersAgree(e, f).agree, false, '★同一組交易換順序＝不一致（嚴格比順序）');
});

test('比對器｜aiDiffSummary：至多列 6 處＋「等 N 處」、去重', () => {
  assert.equal(aiDiffSummary(['a', 'a', 'b']), 'a、b');
  const many = ['一', '二', '三', '四', '五', '六', '七', '八'];
  assert.equal(aiDiffSummary(many), '一、二、三、四、五、六⋯等 8 處');
});

test('比對器｜形狀同步（Grok#1 機械化排除）：normalize 輸出必含 accountCurrency map 與比對器讀的每個交易欄', async () => {
  const { normalizeAiBank } = await import('../lib/ai-parse.js');
  const parsed = /** @type {any} */ (normalizeAiBank(/** @type {any} */ (answerOf())));
  assert.ok(parsed.accountCurrency && typeof parsed.accountCurrency === 'object' && !Array.isArray(parsed.accountCurrency), '★比對器讀 accountCurrency map——normalize 改鍵名＝這裡先紅（不會變成「兩個空物件永遠相等」的死碼）');
  assert.equal(parsed.accountCurrency['900200****1234'], 'TWD');
  for (const k of ['acctSuffix', 'acctMasked', 'date', 'direction', 'amount', 'balance', 'summary', 'note']) {
    assert.ok(k in parsed.transactions[0], `★比對器逐欄清單的「${k}」必須真的存在於 normalize 輸出（改形＝比對器對 undefined 互比＝假一致）`);
  }
  // 幣別刀打在**真實形**上：normalize 後只差幣別＝必 disagree
  const usd = /** @type {any} */ (normalizeAiBank(/** @type {any} */ (answerOf({
    accountCurrencies: [{ masked: '900200****1234', currency: 'USD' }],
    accounts: [{ masked: '900200****1234', balance: 5500, currency: 'USD', label: '活期', note: '' }],
  }))));
  const r = aiAnswersAgree(parsed, usd);
  assert.equal(r.agree, false, '★真實形只改幣別＝disagree');
  assert.ok(r.diffs.includes('帳戶幣別表'));
});

test('碰撞退嚴格（Grok G1/G2/G3）｜同末碼兩帳戶＝退回含 masked 的嚴格鍵：幣別/餘額歸屬對調要紅、逐筆歸屬也回 hard', () => {
  const two = (/** @type {any} */ over = {}) => /** @type {any} */ ({
    bank: 'x', referenceDate: null,
    accountCurrency: { '900200****1234': 'TWD', '900211****1234': 'USD' },
    accounts: [
      { masked: '900200****1234', suffix: '1234', balance: 1000, currency: 'TWD', label: '', note: '' },
      { masked: '900211****1234', suffix: '1234', balance: 2000, currency: 'USD', label: '', note: '' },
    ],
    transactions: [{ acctSuffix: '1234', acctMasked: '900200****1234', date: 'd', summary: 's', direction: 'out', amount: 1, balance: null, note: '' }],
    ...over,
  });
  assert.equal(aiAnswersAgree(two(), two()).agree, true, '碰撞但兩讀一致＝照樣綠');
  // 幣別歸屬對調（末碼 multiset 不變）＝必須紅
  const swapCur = two({ accountCurrency: { '900200****1234': 'USD', '900211****1234': 'TWD' } });
  assert.ok(aiAnswersAgree(two(), swapCur).diffs.includes('帳戶幣別表'), '★同末碼幣別對調＝hard（只比末碼會全綠——Grok 實指的塌縮）');
  // 餘額歸屬對調＝必須紅
  const swapBal = two();
  swapBal.accounts[0].balance = 2000; swapBal.accounts[1].balance = 1000;
  swapBal.accounts[0].currency = 'TWD'; swapBal.accounts[1].currency = 'USD';
  assert.ok(aiAnswersAgree(two(), swapBal).diffs.includes('帳戶餘額組成'), '★同末碼餘額對調＝hard');
  // 逐筆歸屬掛錯實體帳＝必須紅（碰撞時 masked 回 hard）
  const swapTx = two();
  swapTx.transactions[0].acctMasked = '900211****1234';
  assert.ok(aiAnswersAgree(two(), swapTx).diffs.some((d) => d.includes('帳號')), '★碰撞時逐筆 masked 回 hard');
  // 無碰撞的常見路不受影響：單帳戶印法差異仍只是建議面
  const one = (/** @type {string} */ m) => /** @type {any} */ ({ bank: 'x', referenceDate: null, accountCurrency: { [m]: 'TWD' }, accounts: [{ masked: m, suffix: '1234', balance: 5, currency: 'TWD', label: '', note: '' }], transactions: [] });
  const rSep = aiAnswersAgree(one('900200****1234'), one('9002-00****1234'));
  assert.equal(rSep.agree, true, '★無碰撞＋只差分隔符＝一致（P2-4c 後連提示都不列）');
  assert.deepEqual(rSep.textVariance, []);
  const r = aiAnswersAgree(one('900200****1234'), one('****1234'));
  assert.equal(r.agree, true, '★無碰撞＝少印前綴＝印法差異照裁示不觸發');
  assert.ok(r.textVariance.includes('帳號印法'));
});

test('P2-4c｜帳號正規化三態：分隔符＝完全相等（零提示）；前綴都印得出且對不上＝hard；少印前綴＝建議面', async () => {
  const { canonMasked, maskedCmp } = await import('../lib/ai-parse.js');
  // 純函式面
  assert.equal(canonMasked('9002-00****1234'), '900200****1234', '★剝分隔符（William 的 900200＋1234 判別法、程式端做）');
  assert.equal(canonMasked('9002 00＊？'), '900200*', 'NFKC 後全形＊＝星號要保留、其餘符號剝');
  assert.equal(maskedCmp('9002-00****1234', '900200****1234'), 'same');
  assert.equal(maskedCmp('****1234', '900200****1234'), 'variance', '少印前綴＝印法');
  assert.equal(maskedCmp('0200****1234', '900200****1234'), 'variance', '前綴一長一短尾端相容＝同戶印法（P1a 同款）');
  assert.equal(maskedCmp('900311****1234', '900200****1234'), 'conflict', '★兩邊都印得出前綴且對不上＝不同戶');
  // 比對器面：分隔符差異＝agree 且零建議（不做狼來了）
  const base = () => /** @type {any} */ ({
    bank: 'x', referenceDate: null, accountCurrency: { '900200****1234': 'TWD' },
    accounts: [{ masked: '900200****1234', suffix: '1234', balance: 5, currency: 'TWD', label: '', note: '' }],
    transactions: [{ acctSuffix: '1234', acctMasked: '900200****1234', date: 'd', summary: 's', direction: 'out', amount: 1, balance: null, note: '' }],
  });
  const sep = base(); sep.accountCurrency = { '9002-00****1234': 'TWD' }; sep.accounts[0].masked = '9002-00****1234'; sep.transactions[0].acctMasked = '9002-00****1234';
  const r1 = aiAnswersAgree(base(), sep);
  assert.equal(r1.agree, true);
  assert.deepEqual(r1.textVariance, [], '★只差分隔符＝連「印法」提示都不列');
  // Grok r0 升級的三個新形：星號中段數字差／無星完整號 vs 另一戶遮罩號／星號長短純印法
  assert.equal(maskedCmp('900200*00*1234', '900200*99*1234'), 'conflict', '★中段數字差＝首版前綴判準的洞（Grok #3）');
  assert.equal(maskedCmp('9002001234', '900311****1234'), 'conflict', '★完整號 vs 另一戶遮罩號＝無星也要擋（Grok #4）');
  assert.equal(maskedCmp('*900200****1234', '*900311****1234'), 'conflict', '★前導星號形（Codex r1#2：舊「首星前綴」判準對這形回 variance＝真正殺得死舊版的刀口）');
  assert.equal(maskedCmp('900200**1234', '900200****1234'), 'variance', '數字序列相等＝星號長短純印法');
  assert.equal(maskedCmp('900200****1234', '900200****5678'), 'conflict', '末碼不同＝conflict（#11：這分支要有自己的題）');
  // 誠實殘餘釘現況（P1a 同款取捨）：極短前綴巧合＝相容放行
  assert.equal(maskedCmp('0****1234', '900200****1234'), 'variance', '殘餘：1 碼前綴幾乎必相容——契約記載、非漏測');
  // 比對器面：前綴衝突＝hard——**三處各自拆場**（Grok #10：合場＝任一層響就過、逐筆斷言被「帳戶帳號」字串蘊含）
  const conCur = base(); conCur.accountCurrency = { '900311****1234': 'TWD' };
  const rCur = aiAnswersAgree(base(), conCur);
  assert.equal(rCur.diffs.filter((d) => d === '帳戶帳號').length, 1, `★只動幣別表鍵＝幣別表那條迴圈自己要響（實得 ${JSON.stringify(rCur.diffs)}）`);
  const conAcc = base(); conAcc.accounts[0].masked = '900311****1234';
  const rAcc = aiAnswersAgree(base(), conAcc);
  assert.equal(rAcc.diffs.filter((d) => d === '帳戶帳號').length, 1, `★只動帳戶層 masked＝帳戶層自己要響（實得 ${JSON.stringify(rAcc.diffs)}）`);
  const conTx = base(); conTx.transactions[0].acctMasked = '900311****1234';
  const rTx = aiAnswersAgree(base(), conTx);
  assert.ok(rTx.diffs.some((d) => /^第 \d+ 筆交易的帳號$/.test(d)), `★只動逐筆＝逐筆自己要響（實得 ${JSON.stringify(rTx.diffs)}）`);
  for (const r of [rCur, rAcc, rTx]) assert.ok(!r.diffs.some((d) => /1234|9003|9002/.test(d)), '機密紀律：不帶號碼');
});

// ---- 開關判準 ----
test('開關｜dualReadWanted：只有明確 false 才關——讀不到/壞型別＝開（fail 往多驗證）', () => {
  assert.equal(dualReadWanted({ aiDualRead: false }), false);
  assert.equal(dualReadWanted({ aiDualRead: true }), true);
  assert.equal(dualReadWanted({}), true, '★缺鍵＝開（預設開拍板）');
  assert.equal(dualReadWanted(undefined), true);
  assert.equal(dualReadWanted({ aiDualRead: 'off' }), true, '★壞型別＝開（與 aiAskBeforeSend 相反方向、應該相反）');
});

// ---- 路線行為 ----
test('雙讀｜兩讀一致＝採 Opus 版（label 措辭不同也算一致、寫入的是 escalation 那份）、恰 2 發、dualRead=agree', async () => {
  const db = await seedDb();
  const spy = { calls: /** @type {string[]} */ ([]) };
  const sonnet = answerOf({ accounts: [{ masked: '900200****1234', balance: 5500, currency: 'TWD', label: 'Sonnet 措辭', note: '' }] });
  const opus = answerOf({ accounts: [{ masked: '900200****1234', balance: 5500, currency: 'TWD', label: 'Opus 措辭', note: '' }] });
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: sonnet, [O]: opus }, spy), extract: extractA });
  assert.equal(r.dualRead, 'agree');
  assert.equal(r.aiModel, O, '★採用 escalation（Opus）那份');
  assert.equal(/** @type {any} */ (r).parsed.accounts[0].label, 'Opus 措辭', '★未比對欄也是 Opus 版（不留誰先回來誰贏）');
  assert.deepEqual([...spy.calls].sort(), [O, S].sort(), '★恰 2 發、無仲裁');
});

test('仲裁 tv 語意（Grok G10）｜✏️ 列的是兩份**初讀**的寫法差、不是勝者對仲裁者', async () => {
  const db = await seedDb();
  const good = answerOf();
  const bad = answerOf({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [{ ...good.transactions[0], note: 'Sonnet 版備註' }, { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: bad, [O]: good, [F]: good }), extract: extractA });
  assert.equal(r.dualRead, 'arbitrated');
  assert.ok(/** @type {any} */ (r).dualReadTextVariance?.includes('第 1 筆交易的備註'), '★初讀兩份在備註上的寫法差要透出（勝者 vs Fable 是同一份＝那樣算恒空）');
});

test('仲裁｜兩讀金額不一致→Fable 與其中一份全欄一致＝採用那份、恰 3 發、dualRead=arbitrated', async () => {
  const db = await seedDb();
  const spy = { calls: /** @type {string[]} */ ([]) };
  const good = answerOf();
  // 真的「金額不一致」（Grok#4：原版差在摘要＝掛羊頭）：bad 是**另一條自洽鏈**——tx2 改 in 100、
  // 帳戶餘額改 5000（4900＋100＝5000＝概要）、每個數字都在版面上（100/4,900/5,000）＝驗收、接地、
  // 強閘全過。兩份都合法、金額不同——正是 r4#1「AI 非確定性」的那類雙讀要抓的形。
  const bad = answerOf({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [good.transactions[0], { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: bad, [O]: good, [F]: good }, spy), extract: extractA });
  assert.equal(r.dualRead, 'arbitrated');
  assert.equal(r.aiModel, O, '★Fable 與 Opus 版一致＝採用 Opus 版（不是 Fable 自己的答案）');
  assert.equal(spy.calls.length, 3, '★恰 3 發（雙讀 2＋仲裁 1）');
  assert.ok(spy.calls.includes(F), '第三發真的是仲裁模型');
});

test('三讀不同｜ai_disagree 400：訊息列欄位、不回聲任何帳單數值；零發票、preview 零寫入', async () => {
  await seedDb();
  const db = await getDb();
  const a = answerOf();
  const b = answerOf({ transactions: [{ ...a.transactions[0], summary: '超商繳費改' }, a.transactions[1]] });
  const c = answerOf({ referenceDate: null });
  await assert.rejects(
    () => previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => /** @type {any} */ (engineOf({ [S]: a, [O]: b, [F]: c })), aiExtract: extractA }),
    (/** @type {any} */ e) => {
      assert.equal(e.code, 'ai_disagree');
      assert.match(e.message, /第 1 筆交易的摘要/, '★標紅的落地形＝訊息列欄位');
      assert.doesNotMatch(e.message, /4900|5500|100|600|900200/, '★絕不回聲帳單數值（機密紀律）');
      assert.match(e.message, /手動記帳/, '只給手動出口');
      return true;
    });
  assert.equal(aiTicketCountForTest(), 0, '★三讀不同＝零發票（沒有任何一份取得寫入資格）');
  assert.equal((db.transactions || []).length, 0);
});

test('仲裁者服務錯｜Fable ai_unavailable＝照實丟（可重試的故障≠三份不同）；Fable 答案壞＝ai_disagree', async () => {
  const db = await seedDb();
  const a = answerOf();
  const b = answerOf({ referenceDate: null });
  await assert.rejects(
    () => aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: a, [O]: b, [F]: svcErr('ai_unavailable') }), extract: extractA }),
    (/** @type {any} */ e) => e.code === 'ai_unavailable');
  await assert.rejects(
    () => aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: a, [O]: b, [F]: badAnswer }), extract: extractA }),
    (/** @type {any} */ e) => e.code === 'ai_disagree');
});

test('一讀掛掉｜另一讀有效＝沒有兩份互證→仍走仲裁：Fable 一致＝採用；兩讀都掛＝服務錯優先照實丟', async () => {
  const db = await seedDb();
  const good = answerOf();
  const spy = { calls: /** @type {string[]} */ ([]) };
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: badAnswer, [O]: good, [F]: good }, spy), extract: extractA });
  assert.equal(r.dualRead, 'attested', '★單讀無互證＝attested（W3：徽章「前兩讀不一致」在此情境是假話、不可共用 arbitrated）');
  assert.equal(spy.calls.length, 3);
  await assert.rejects(
    () => aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: badAnswer, [O]: svcErr('ai_auth') }), extract: extractA }),
    (/** @type {any} */ e) => e.code === 'ai_auth', '★兩讀都掛＝服務類錯優先（換模型救不了）');
});

test('開關關閉｜aiDualRead:false＝回單讀＋升級階梯：快樂路徑恰 1 發、一致性不比對', async () => {
  const db = await seedDb({ aiDualRead: false });
  const spy = { calls: /** @type {string[]} */ ([]) };
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: answerOf(), [O]: answerOf() }, spy), extract: extractA });
  assert.equal(spy.calls.length, 1, '★單讀＝第一發成功就停（雙讀改不動關閉模式）');
  assert.equal(/** @type {any} */ (r).dualRead, undefined, '關閉＝回應不帶 dualRead');
});

test('preview 承重（Grok#2）｜agree 與 arbitrated 都要出現在正式 preview 回應（服務回了、preview 漏掛＝徽章永不畫）', async () => {
  await seedDb();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => /** @type {any} */ (engineOf({ [S]: answerOf(), [O]: answerOf() })), aiExtract: extractA });
  assert.equal(/** @type {any} */ (pv).dualRead, 'agree', '★正式 preview 回應要帶 dualRead');
  assert.ok(pv.aiTicket, '票照發');
  clearAiTicketsForTest();
  const good = answerOf();
  const bad = answerOf({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [good.transactions[0], { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => /** @type {any} */ (engineOf({ [S]: bad, [O]: good, [F]: good })), aiExtract: extractA });
  assert.equal(/** @type {any} */ (pv2).dualRead, 'arbitrated', '★仲裁一樣要透出到 preview');
});

test('W1｜仲裁那發專屬逾時 300 秒、其他模型 90 秒（Fable 單請求可跑數分鐘——90 秒＝最需要仲裁的帳單最容易匯不進去）', async () => {
  const { makeAnthropicBankEngine } = await import('../lib/ai-transport.js');
  /** @type {number[]} */ const seen = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = /** @type {any} */ ((/** @type {number} */ ms) => { seen.push(ms); return realTimeout.call(AbortSignal, ms); });
  globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) }));
  try {
    const noopBudget = { take: async () => {} };   // C1：組裝必帶；本題測逾時、不測預算（專卷在 ai-budget.test.js）
    await makeAnthropicBankEngine('sk-ant-synthetic-test-key', noopBudget).parseOnce('x', F);
    await makeAnthropicBankEngine('sk-ant-synthetic-test-key', noopBudget).parseOnce('x', S);
  } finally { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; }
  assert.deepEqual(seen, [300_000, 90_000], '★仲裁 300 秒、其他照舊 90 秒——共用 90 秒＝W1 復發');
});

test('W4a｜雙讀兩讀皆閘紅（原錯無 code）＝ai_reconcile_failed、訊息不含任何帳單數值（機密紀律的雙讀版）', async () => {
  const db = await seedDb();
  // 兩份答案都過驗收＋接地、但餘額鏈對不上概要（帳戶 5000 vs 鏈尾 5500）＝對帳閘原錯（無 code、帶數字）
  const gateRed = answerOf({ accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }] });
  await assert.rejects(
    () => aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: gateRed, [O]: gateRed }), extract: extractA }),
    (/** @type {any} */ e) => {
      assert.equal(e.code, 'ai_reconcile_failed', '★無 code 原錯不得原樣外送（帶帳單數字）');
      assert.doesNotMatch(e.message, /4,?900|5,?500|5,?000|900200|超商|薪資/, '★訊息零帳單欄值');
      return true;
    });
});

test('W4b｜雙讀路線不落 log：帳單內文與鑰匙不可出現在任何 console 輸出（單讀版考題掛 false 走不進 aiTryModel）', async () => {
  const db = await seedDb();
  /** @type {string[]} */ const logs = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of /** @type {const} */ (['log', 'info', 'warn', 'error'])) console[k] = (/** @type {any[]} */ ...a) => { logs.push(a.map(String).join(' ')); };
  try { await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: answerOf(), [O]: answerOf() }), extract: extractA }); }
  finally { Object.assign(console, orig); }
  const all = logs.join('\n');
  assert.doesNotMatch(all, /超商繳費|薪資入帳|900200|sk-ant/, '★雙讀路徑（aiTryModel）也在零 log 契約內');
});

test('W6｜四發合成題：仲裁 preview（3 發解析）→兌票 apply（恰 1 發生成）＝「至多 4 發」有考題撐', async () => {
  await seedDb();
  const calls = { parse: 0, gen: 0 };
  const good = answerOf();
  const bad = answerOf({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [good.transactions[0], { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const byModel = { [S]: bad, [O]: good, [F]: good };
  const factory = () => ({
    models: AI_BANK_MODELS,
    parseOnce: async (/** @type {string} */ _t, /** @type {string} */ m) => { calls.parse += 1; return structuredClone(/** @type {any} */ (byModel)[m]); },
    generateRecipe: async () => { calls.gen += 1; return { junk: true }; },   // 生成內容壞掉沒關係——數的是發數
  });
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: /** @type {any} */ (factory), aiExtract: extractA });
  assert.equal(pv.dualRead, 'arbitrated');
  assert.equal(calls.parse, 3, '★仲裁路徑恰 3 發解析');
  const { applyBankStatement } = await import('../lib/services/bank-import.js');
  const res = await applyBankStatement(/** @type {any} */ (undefined), undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: /** @type {any} */ (factory) });
  assert.equal(res.ok, true);
  assert.equal(calls.parse, 3, 'apply 零解析');
  assert.equal(calls.gen, 1, '★恰 1 發生成——合計 4 發＝成本句的「至多 4 發」真的有題撐');
});

test('r3#1｜三碼末碼碰撞走**正式雙讀路**：兩讀把交易整批掛到對方帳戶＝不得 agree（slice(-4) 另寫＝漏偵測的形）', async () => {
  const db = await seedDb();
  const M3a = '900200****363', M3b = '900300****363';
  const lines3 = () => [
    L(10, [[40, '一銀活期帳戶明細']]),
    L(30, [[40, M3a], [200, 'TWD']]),          // 概要餘額空白＝只進幣別表、accounts 為空（r3#1 情境）
    L(35, [[40, M3b], [200, 'TWD']]),
    L(50, [[40, '2026/07/01'], [140, '超商繳費'], [240, '100'], [320, '4,900']]),
    L(55, [[40, '2026/07/02'], [140, '薪資入帳'], [280, '600'], [320, '5,500']]),
    L(60, [[40, '2026/07/03'], [140, '雜費'], [240, '50'], [320, '950']]),
    L(65, [[40, '2026/07/04'], [140, '利息'], [280, '20'], [320, '970']]),
  ];
  const t3 = (/** @type {string} */ m, /** @type {any} */ o) => ({ acctMasked: m, note: '', ...o });
  const ans = (/** @type {boolean} */ swap) => {
    const a = swap ? M3b : M3a, b = swap ? M3a : M3b;
    return {
      bank: '第一銀行', referenceDate: '2026-07-31',
      accountCurrencies: [{ masked: M3a, currency: 'TWD' }, { masked: M3b, currency: 'TWD' }],
      totals: { txCount: null, totalOut: null, totalIn: null },
      accounts: [],
      transactions: [
        t3(a, { date: '2026-07-01', direction: 'out', amount: 100, balance: 4900, summary: '超商繳費' }),
        t3(a, { date: '2026-07-02', direction: 'in', amount: 600, balance: 5500, summary: '薪資入帳' }),
        t3(b, { date: '2026-07-03', direction: 'out', amount: 50, balance: 950, summary: '雜費' }),
        t3(b, { date: '2026-07-04', direction: 'in', amount: 20, balance: 970, summary: '利息' }),
      ],
    };
  };
  const spy = { calls: /** @type {string[]} */ ([]) };
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: ans(false), [O]: ans(true), [F]: ans(false) }, spy), extract: async () => lines3() });
  assert.notEqual(r.dualRead, 'agree', '★整批歸屬對調（末碼同為 363、鏈各自自洽、閘全綠）不得雙讀一致');
  assert.equal(r.dualRead, 'arbitrated', 'Fable 與正確版一致＝仲裁收回');
  assert.equal(spy.calls.length, 3, '真的走了仲裁');
});

test('r1#1｜單份答案內同帳號兩種印法＋幣別對調＝fail-closed 不得 agree（canon 捏同身分、下游卻按原字串查幣別）', async () => {
  await seedDb();
  const RAW1 = '9002-00****1234', RAW2 = '900200****1234';   // canon 相同、原字串不同
  const linesDup = () => [
    L(10, [[40, '一銀活期帳戶明細']]),
    L(30, [[40, RAW1], [200, 'TWD'], [320, '5,500']]),
    L(35, [[40, RAW2], [200, 'USD'], [320, '150']]),
    L(40, [[40, '900100****3301'], [200, 'TWD'], [320, '9,000']]),
    L(50, [[40, '2026/07/01'], [60, '3301'], [140, '零用金存入'], [280, '100'], [320, '9,100']]),
    L(55, [[40, '2026/07/02'], [60, '3301'], [140, '超商繳費'], [240, '100'], [320, '9,000']]),
  ];
  const mk = (/** @type {boolean} */ swap) => ({
    bank: '第一銀行', referenceDate: '2026-07-31',
    accountCurrencies: [
      { masked: RAW1, currency: swap ? 'USD' : 'TWD' }, { masked: RAW2, currency: swap ? 'TWD' : 'USD' },
      { masked: '900100****3301', currency: 'TWD' },
    ],
    totals: { txCount: null, totalOut: null, totalIn: null },
    accounts: [
      { masked: RAW1, balance: swap ? 150 : 5500, currency: swap ? 'USD' : 'TWD', label: '', note: '' },
      { masked: RAW2, balance: swap ? 5500 : 150, currency: swap ? 'TWD' : 'USD', label: '', note: '' },
      { masked: '900100****3301', balance: 9000, currency: 'TWD', label: '', note: '' },
    ],
    transactions: [
      { acctMasked: '900100****3301', date: '2026-07-01', direction: 'in', amount: 100, balance: 9100, summary: '零用金存入', note: '' },
      { acctMasked: '900100****3301', date: '2026-07-02', direction: 'out', amount: 100, balance: 9000, summary: '超商繳費', note: '' },
    ],
  });
  await assert.rejects(
    () => previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => /** @type {any} */ (engineOf({ [S]: mk(false), [O]: mk(true), [F]: mk(false) })), aiExtract: async () => linesDup() }),
    (/** @type {any} */ e) => {
      assert.equal(e.code, 'ai_disagree', '★對調不得被任何一份「採用」——連 Fable 那份自己也帶雙印法＝一路 fail-closed 到手動');
      assert.doesNotMatch(e.message, /5,?500|150|9,?000|900200|9002/, '機密紀律');
      return true;
    });
});

// ---- 前端純函式 ----
test('r1#1｜Sonnet 勝出的仲裁：✏️ 句真的畫出且顯示 Sonnet、不得寫死 Opus；仲裁句只宣稱錢欄位一致', async () => {
  const db = await seedDb();
  const good = answerOf();   // Sonnet 讀對
  const bad = answerOf({     // Opus 讀出另一條自洽鏈（hard 不同）＋備註措辭不同（讓初讀 tv 非空＝✏️ 句真的畫）
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [{ ...good.transactions[0], note: 'Opus 版備註' }, { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const fable = answerOf({ transactions: [{ ...good.transactions[0], note: 'Fable 第三種備註' }, good.transactions[1]] });   // 錢欄同 Sonnet、備註第三種
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: good, [O]: bad, [F]: fable }), extract: extractA });
  assert.equal(r.dualRead, 'arbitrated');
  assert.equal(r.aiModel, S, '★Fable 的錢欄位與 Sonnet 版一致＝採 Sonnet');
  assert.ok(/** @type {any} */ (r).dualReadTextVariance?.includes('第 1 筆交易的備註'), '初讀 tv 非空（r2#1：空 tv＝✏️ 句沒畫＝斷言全是空包）');
  const html = aiPreviewBadgeHtml({ engine: 'ai', aiModel: r.aiModel, dualRead: r.dualRead, dualReadTextVariance: /** @type {any} */ (r).dualReadTextVariance });
  assert.match(html, /✏️/, '★✏️ 句真的畫出');
  assert.match(html, /已採用.*Sonnet/, '★顯示實際中選＝Sonnet（動態模型名）');
  assert.doesNotMatch(html, /已採用.*Opus/, '★不得謊稱採 Opus（r1#1 對抗重現的形）');
  assert.match(html, /會影響錢的欄位.*完全一致/, '★仲裁句只宣稱錢欄位一致（文字欄可能仍不同）');
});

test('r2#1b｜attested＋文字差：一讀無效、有效讀與 Fable 錢欄一致但備註不同——不得宣稱整份完全一致、✏️ 動態名', async () => {
  const db = await seedDb();
  const good = answerOf();
  const fable = answerOf({ transactions: [{ ...good.transactions[0], note: 'Fable 備註' }, good.transactions[1]] });
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: badAnswer, [O]: good, [F]: fable }), extract: extractA });
  assert.equal(r.dualRead, 'attested');
  assert.ok(/** @type {any} */ (r).dualReadTextVariance?.length, '單讀路的 tv＝勝者對仲裁者（唯一可比的兩份）');
  const html = aiPreviewBadgeHtml({ engine: 'ai', aiModel: r.aiModel, dualRead: r.dualRead, dualReadTextVariance: /** @type {any} */ (r).dualReadTextVariance });
  assert.match(html, /會影響錢的欄位.*完全一致/, '★attested 句也只宣稱錢欄位（整份完全一致＝謊：備註是第三種寫法）');
  assert.doesNotMatch(html, /讀後與這一份完全一致——/, '★舊的整份宣稱句不得復發');
  assert.match(html, /✏️/, '文字差要誠實畫出');
});

test('r1#2｜busy 文案＝未來式：零 AI 呼叫的路（HOSTED/未設鑰匙）不得宣稱「AI 讀取中」（#455 假進度同族）', async () => {
  const { AI_CONSENT_BUSY_LABEL } = await import('../public/modules/ai-consent.js');
  assert.doesNotMatch(AI_CONSENT_BUSY_LABEL, /讀取中|正在讀|核對中/, '★發請求前不得宣稱 AI 動作進行式');
  assert.match(AI_CONSENT_BUSY_LABEL, /送出/, '講的是「送出」這個當下真的在發生的事');
});

test('徽章｜dualRead=agree/arbitrated 各有一句、無 dualRead 不畫；句子只講事實不加保證', () => {
  const base = { engine: 'ai', aiModel: O };
  assert.match(aiPreviewBadgeHtml({ ...base, dualRead: 'agree' }), /雙讀一致/);
  assert.match(aiPreviewBadgeHtml({ ...base, dualRead: 'arbitrated' }), /前兩讀不一致/);
  assert.match(aiPreviewBadgeHtml({ ...base, dualRead: 'attested' }), /其中一讀沒讀出合法答案/, '★W3：一讀掛掉不得謊稱「前兩讀不一致」');
  const plain = aiPreviewBadgeHtml(base);
  assert.doesNotMatch(plain, /雙讀一致|三讀仲裁/, '單讀＝不畫雙讀句');
  // P2-4b：建議面要誠實畫出（列欄位不列值）；沒有建議面＝不畫（不做狼來了）
  const withTv = aiPreviewBadgeHtml({ ...base, dualRead: 'agree', dualReadTextVariance: ['機構名', '第 12 筆交易的備註'] });
  assert.match(withTv, /✏️/, '★文字欄寫法不同要有 ✏️ 句');
  assert.match(withTv, /機構名、第 12 筆交易的備註/, '列欄位');
  assert.match(withTv, /已採用/, '講清楚採哪份（模型名動態、r1#1）');
  assert.doesNotMatch(aiPreviewBadgeHtml({ ...base, dualRead: 'agree' }), /✏️/, '沒有建議面＝不畫');
  for (const h of [aiPreviewBadgeHtml({ ...base, dualRead: 'agree' }), aiPreviewBadgeHtml({ ...base, dualRead: 'arbitrated' }), aiPreviewBadgeHtml({ ...base, dualRead: 'attested' })]) {
    assert.doesNotMatch(h, /保證正確|一定對|免驗算/, '徽章不得加保證');
  }
});

test('設定頁｜雙讀開關接線：async 等結果、失敗向 db 重核（核對不到＝顯示關）、不吞錯、預設顯示勾', async () => {
  const { readFileSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  const src = readFileSync(j(process.cwd(), 'public/modules/settings.js'), 'utf8');
  assert.match(src, /dual\.onchange = async \(\) => \{/u, '★開關存檔要等結果（async）');
  assert.doesNotMatch(src, /dual\.checked = !want/u, '★不可用 !want 推定資料庫狀態（#455 r5#1 同款禁令）');
  assert.match(src, /dual\.checked = s2\.aiDualRead !== false/u, '★失敗要向 db 重核、顯示核對結果');
  assert.match(src, /catch \{ dual\.checked = false; \}/u, '★核對不到＝顯示「關」（畫面寧可少保證；執行期相反＝dualReadWanted 讀不到當開）');
  assert.doesNotMatch(src, /saveSettings\(\{ aiDualRead/u, '★不可繞回吞錯誤的 saveSettings');
  assert.match(src, /\$\{s\.aiDualRead === false \? '' : 'checked'\}/u, '★預設顯示勾（缺鍵＝開＝與執行期一致）');
});

test('r1#2｜使用者可見文案不得再描述舊單讀流程當預設：三個輸出**各自**釘住（r2：共用一個正向斷言＝單點復發抓不到）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  const { AI_KEY_CARD_NOTE, AI_KEY_INFO } = await import('../public/modules/ai-key-settings.js');
  const consent = readFileSync(j(process.cwd(), 'public/modules/ai-consent.js'), 'utf8');
  // ①同意窗
  assert.match(consent, /兩個 AI 各自獨立讀一遍/, '★同意窗要講預設雙讀');
  assert.doesNotMatch(consent, /萬一第一次讀出來的數字對不平，系統會自動換更強的模型再讀一次/, '★舊單讀句不得再當預設描述');
  // ②設定卡摘要（常數本體、不是整檔掃描——r2：整檔掃描讓三處互相冒充）
  assert.match(AI_KEY_CARD_NOTE, /預設「雙讀」/, '★設定卡摘要自己要講預設雙讀');
  assert.doesNotMatch(AI_KEY_CARD_NOTE, /會直接交給 AI 讀一次/, '★「讀一次」的舊預設描述不得殘留');
  // ③費用解釋窗（單獨退回這一處＝r2 的記憶體突變實測仍全綠——這兩條就是補那個洞）
  assert.match(AI_KEY_INFO.cost.html, /預設「雙讀」/, '★費用解釋窗自己要講預設雙讀');
  assert.doesNotMatch(AI_KEY_INFO.cost.html, /有沒有因為第一次讀不準而換大一點的模型再讀一次/, '★費用窗的舊單讀預設句不得單獨復發');
});

// ---- 仲裁差異欄名現形（William 2026-08-18：「希望降低仲裁的需要」→先讓證據現形才能照證據調校）----
test('差異現形｜arbitrated 帶 dualReadDiffs（只列欄名、絕不帶欄值）；一路透到 preview', async () => {
  const db = await seedDb();
  const good = answerOf();
  const bad = answerOf({
    accounts: [{ masked: '900200****1234', balance: 5000, currency: 'TWD', label: '活期', note: '' }],
    transactions: [good.transactions[0], { ...good.transactions[1], amount: 100, balance: 5000 }],
  });
  const r = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: bad, [O]: good, [F]: good }), extract: extractA });
  assert.equal(r.dualRead, 'arbitrated');
  const dd = /** @type {any} */ (r).dualReadDiffs;
  assert.ok(Array.isArray(dd) && dd.length > 0, '★仲裁成功要把「差在哪幾欄」帶出來（沒有它＝每次都只能猜要不要調比對器）');
  assert.ok(dd.includes('帳戶餘額組成') || dd.some((/** @type {string} */ x) => x.includes('金額')), `差異欄要點名錢欄（實得 ${JSON.stringify(dd)}）`);
  // ★白名單形狀（Grok r0：只擋魔術數字＝「帳號 900200****1234 的金額」這種欄名能全綠出站）：
  //   每一格都必須落在封閉集合——固定欄名或「第 N 筆交易的X」，**數字只准是序號**。
  //   aiAnswersAgree 新增路徑會把這題打紅＝強迫來這裡有意識登記，帳號/金額類欄值長不進欄名。
  const SHAPE = /^(現值參考日|帳戶帳號|帳戶幣別表|帳戶餘額組成|交易筆數|第 \d+ 筆交易的(日期|方向|金額|餘額|帳號末碼|摘要|帳號))$/;
  for (const x of dd) assert.match(String(x), SHAPE, `★欄名必須是封閉白名單形狀（夾帶任何欄值都不合形）：${x}`);
  // 一路透到正式 preview（服務回了、preview 漏掛＝畫面永不亮）
  clearAiTicketsForTest();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => engineOf({ [S]: bad, [O]: good, [F]: good }), aiExtract: extractA });
  assert.deepEqual(/** @type {any} */ (pv).dualReadDiffs, dd, '★preview 原樣透出');
});

test('差異現形｜attested 沒有第二份答案可比＝不帶 dualReadDiffs；agree 也不帶', async () => {
  const db = await seedDb();
  const good = answerOf();
  const dead = () => Object.assign(new Error('壞答案'), { status: 400, code: 'ai_bad_answer' });
  const r1 = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: dead, [O]: good, [F]: good }), extract: extractA });
  assert.equal(r1.dualRead, 'attested');
  assert.ok(!('dualReadDiffs' in r1), '★attested 不得帶——沒有兩份合法初讀就不存在「兩份的差異」（語意，非畫面問題）');
  const r2 = await aiBankRoute('QUFBQQ==', undefined, db, { engineFactory: () => engineOf({ [S]: good, [O]: answerOf({ accounts: [{ ...good.accounts[0], label: 'Opus 措辭' }] }) }), extract: extractA });
  assert.equal(r2.dualRead, 'agree');
  assert.ok(!('dualReadDiffs' in r2), '★一致路不帶（沒有差異可講）');
  clearAiTicketsForTest();
  const pvAgree = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => engineOf({ [S]: good, [O]: good }), aiExtract: extractA });
  assert.ok(!('dualReadDiffs' in /** @type {any} */ (pvAgree)), '★preview 層也不帶（透傳層不對稱＝Grok r0）');
});

test('差異現形｜徽章句：有 diffs 畫 ⚠️ 句（收合區外＝「請核對哪幾處」素材）、逃逸、去重截斷；沒有＝不畫', () => {
  const base = { engine: 'ai', aiModel: O, dualRead: 'arbitrated' };
  const withDd = aiPreviewBadgeHtml({ ...base, dualReadDiffs: ['帳戶餘額組成', '第 2 筆交易的金額', '第 2 筆交易的金額'] });
  assert.match(withDd, /兩份初讀不一致的欄位/);
  assert.match(withDd, /帳戶餘額組成、第 2 筆交易的金額/, '★去重後列出');
  assert.match(withDd, /特別核對這幾處/);
  // 收合區外＝⚠️ 句必須出現在 <details 之前（explain-must-knows 家規：核對前提不得藏進收合）
  const dIdx = withDd.indexOf('兩份初讀不一致'); const detIdx = withDd.indexOf('<details');
  assert.ok(dIdx >= 0 && (detIdx === -1 || dIdx < detIdx), '★不得藏進收合區');
  // ★XSS 斷言看**esc 的輸出真的在**（Grok r0：只驗「沒有 <img」＝整段剝掉或 <IMG 大寫都能綠）
  const xss = aiPreviewBadgeHtml({ ...base, dualReadDiffs: ['<img src=x onerror=alert(1)>'] });
  assert.ok(!/<img/i.test(xss), '★大小寫都不得出現原始標籤');
  assert.ok(xss.includes('&lt;img'), '★esc 後的輸出必須真的在（整段被剝掉也算失敗——那是靜靜丟資料）');
  // ★第二道閘：來源誤把 diffs 掛到 agree/attested，畫面不得跟著說「兩份初讀不一致」
  assert.doesNotMatch(aiPreviewBadgeHtml({ ...base, dualRead: 'agree', dualReadDiffs: ['帳戶餘額組成'] }), /兩份初讀不一致/, '★agree 誤掛不畫');
  assert.doesNotMatch(aiPreviewBadgeHtml({ ...base, dualRead: 'attested', dualReadDiffs: ['帳戶餘額組成'] }), /兩份初讀不一致/, '★attested 誤掛不畫');
  // ★非字串濾掉（join 會唸出 [object Object] 的怪句）；長欄名截斷（esc 只管逃逸不管長度）
  assert.doesNotMatch(aiPreviewBadgeHtml({ ...base, dualReadDiffs: [/** @type {any} */ ({ a: 1 }), '帳戶餘額組成'] }), /object Object/);
  const longName = 'Ｘ'.repeat(100);
  const capped = aiPreviewBadgeHtml({ ...base, dualReadDiffs: [longName] });
  assert.ok(!capped.includes(longName), '★單欄名要截長（版面不賭後端白名單）');
  assert.match(capped, /Ｘ{24}⋯/, '截到 24 字加省略號');
  const seven = aiPreviewBadgeHtml({ ...base, dualReadDiffs: ['a欄', 'b欄', 'c欄', 'd欄', 'e欄', 'f欄', 'g欄'] });
  assert.match(seven, /等 7 處/, '超過 6 個＝截斷加總數');
  assert.doesNotMatch(aiPreviewBadgeHtml({ ...base }), /兩份初讀不一致/, '★沒有 diffs＝不畫');
});

// ---- Codex r1 補強：逐欄突變矩陣＋出站 fail-closed 的承重 ----
test('r1#1｜逐欄突變矩陣：每一個 hard 欄位的 diffs 輸出都要落在封閉形狀、序號要是真實索引', async () => {
  const { aiAnswersAgree: agreeFn, sanitizeAiDiffs, normalizeAiBank } = await import('../lib/ai-parse.js');
  // ⚠️ 比對器在正式管線吃的是**驗收後**的形狀（accountCurrency 表是 normalizeAiBank 長出來的）——
  //   矩陣若餵原始答案卷，幣別表那格根本不會產生 diffs＝空轉（這一版第一跑就被自己的空轉斷言抓到）。
  const base = answerOf();
  /** 每個 hard 分支各做一個「只差這一欄」的變體（Codex r1#1：白名單題只掃一個夾具＝其他分支沒被鎖）。 */
  const MUTS = /** @type {[string, (b: any) => void][]} */ ([
    ['現值參考日', (b) => { b.referenceDate = '2026-07-30'; }],
    ['帳戶帳號', (b) => { b.accounts[0].masked = '900200****9999'; b.accountCurrencies[0].masked = '900200****9999'; for (const t of b.transactions) t.acctMasked = '900200****9999'; }],
    ['帳戶幣別表', (b) => { b.accountCurrencies.push({ masked: '900200****7777', currency: 'USD' }); }],
    ['帳戶餘額組成', (b) => { b.accounts[0].balance = 9999; }],
    ['交易筆數', (b) => { b.transactions.pop(); }],
    ['交易日期', (b) => { b.transactions[1].date = '2026-07-09'; }],
    ['交易方向', (b) => { b.transactions[1].direction = 'out'; }],
    ['交易金額', (b) => { b.transactions[1].amount = 123; }],
    ['交易餘額', (b) => { b.transactions[1].balance = 123; }],
    ['交易摘要', (b) => { b.transactions[1].summary = '完全不同的摘要'; }],
  ]);
  for (const [label, mut] of MUTS) {
    const b = answerOf(); mut(b);
    const { diffs } = agreeFn(normalizeAiBank(base), normalizeAiBank(b));
    assert.ok(diffs.length > 0, `${label}：突變要真的產生 diffs（否則這一格是空轉）`);
    const maxTx = Math.max(base.transactions.length, b.transactions.length);   // 原始與驗收後筆數同（驗收不增刪列）
    const safe = sanitizeAiDiffs(diffs, maxTx);
    assert.deepEqual(safe, diffs, `★${label}：合法路徑必須原樣通過 fail-closed（被丟＝白名單漏登記＝使用者少看到提示）`);
    for (const x of diffs) {
      const m = /^第 (\d+) 筆交易的/.exec(x);
      if (m) assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= maxTx, `★序號必須是真實交易索引（${x}，maxTx=${maxTx}）`);
      assert.doesNotMatch(x, /9999|123\b|USD|2026|完全不同/, `★欄名不得夾帶這次突變塞入的欄值：${x}`);
    }
  }
});

test('r1#1b｜出站 fail-closed：夾帶欄值或假序號的欄名在正式路被丟掉（機密優先於資訊完整）', async () => {
  const { sanitizeAiDiffs } = await import('../lib/ai-parse.js');
  // Codex 的兩個突變重放：①固定欄名夾日期值 ②金額被寫進序號位（第 100 筆、帳單只有 2 筆）
  assert.deepEqual(sanitizeAiDiffs(['現值參考日 2026-07-31', '帳戶餘額組成'], 2), ['帳戶餘額組成'], '★夾值＝整格丟');
  assert.deepEqual(sanitizeAiDiffs(['第 100 筆交易的金額', '第 2 筆交易的金額'], 2), ['第 2 筆交易的金額'], '★序號超出實際筆數＝有人把值寫進序號位＝丟');
  assert.deepEqual(sanitizeAiDiffs(['帳號 900200****1234 的金額'], 2), [], '★帳號型欄名整格丟');
  assert.deepEqual(sanitizeAiDiffs(/** @type {any} */ ([42, null, '機構名']), 2), ['機構名'], '非字串丟');
  assert.deepEqual(sanitizeAiDiffs(['第 0 筆交易的金額'], 2), [], '序號從 1 起算');
  // ★接線承重（P118 教訓：合法輸入下過濾器＝恆等函式，拔掉接線沒有行為差可測）——
  //   直接鎖「出站那一行必須經 sanitizeAiDiffs」的形狀；過濾器行為本身由上面的單元斷言承重。
  const { readFileSync } = await import('node:fs');
  const { join: j2 } = await import('node:path');
  const src = readFileSync(j2(process.cwd(), 'lib/services/bank-import.js'), 'utf8');
  assert.match(src, /const safe = sanitizeAiDiffs\(first\.diffs, maxTx\);/, '★dualReadDiffs 出站前必須過 fail-closed（直通＝未來的洩漏形直接上船）');
  assert.match(src, /return safe\.length \? \{ dualReadDiffs: safe \}/, '★出站的是過濾後那份');
});

test('r1#2｜attested 的正式 preview 也不帶 dualReadDiffs（透傳層三情境對稱鎖住）', async () => {
  await seedDb();
  const good = answerOf();
  const dead = () => Object.assign(new Error('壞答案'), { status: 400, code: 'ai_bad_answer' });
  clearAiTicketsForTest();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: () => engineOf({ [S]: dead, [O]: good, [F]: good }), aiExtract: extractA });
  assert.equal(/** @type {any} */ (pv).dualRead, 'attested');
  assert.ok(!('dualReadDiffs' in /** @type {any} */ (pv)), '★attested 的 preview 誤掛＝這題抓（Codex r1#2：原本只鎖 agree）');
});
