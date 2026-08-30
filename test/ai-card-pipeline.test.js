// 信用卡 AI（批二）管線卷：previewAuto/previewForCard 的 AI 路——旗標守門、階梯、票制、歸卡紀律。
// 假引擎注入（同 test/ai-parse.test.js 的做法）；PDF 用 test/helpers/build-pdf.js 真合成（走完整抽字）。
// 隔離：STORE_FILE 指向暫存檔（絕不碰真實 data/）。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-ai-card-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { previewAuto, previewForCard, aiCardRoute, importRows } = await import('../lib/services/statement-import.js');
const { issueAiTicket, redeemAiTicket, clearAiTicketsForTest, aiTicketCountForTest } = await import('../lib/ai-confirm-ticket.js');
const { cjkPdf, passwordPdf } = await import('./helpers/build-pdf.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

// 一份內建範本認不得的「遠銀式」帳單（台新／富邦解析器都讀不出列＝card_unrecognized 的入口）。
// ⚠️ 金額全部印在版面上＝AI 答案的接地來源；等式：1000 − 1000 ＋ 450 ＋ 30(利息) ＝ 480。
const CARD_PDF = () => cjkPdf([
  ['遠東國際商業銀行', '信用卡帳單'],
  ['卡號末四碼', '5678'],
  ['結帳日期', '2026/07/20'],
  ['上期應繳總額', '1,000'],
  ['已繳款退款金額', '1,000'],
  ['本期新增款項', '450'],
  ['循環信用利息', '30'],
  ['本期應繳總額', '480'],
  ['2026/07/03', '星巴克', '150'],
  ['2026/07/10', '全聯福利中心', '350'],
  ['2026/07/12', '退款全聯', '-50'],
]);
const b64Of = (/** @type {Uint8Array} */ pdf) => Buffer.from(pdf).toString('base64');

/** 全對的假答案（接地於 CARD_PDF 的文字）。 */
const GOOD_ANSWER = () => ({
  issuer: '遠東國際商業銀行',
  lastFour: '5678',
  statementMonth: '2026-07',
  totals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 480 },
  adjustments: [{ label: '循環信用利息', amount: 30 }],
  transactions: [
    { date: '2026-07-03', postDate: null, desc: '星巴克', amount: 150 },
    { date: '2026-07-10', postDate: null, desc: '全聯福利中心', amount: 350 },
    { date: '2026-07-12', postDate: null, desc: '退款全聯', amount: -50 },
  ],
});

/** 假引擎：answers[i]＝第 i 次 parseOnce 回什麼（函式＝丟錯）。記下每次用的模型。 */
function fakeEngine(answers) {
  /** @type {string[]} */ const modelsUsed = [];
  let i = 0;
  return {
    modelsUsed,
    engine: {
      models: { primary: 'model-primary', escalation: 'model-escalation' },
      parseOnce: async (/** @type {string} */ _text, /** @type {string} */ model) => {
        modelsUsed.push(model);
        const a = answers[Math.min(i, answers.length - 1)]; i += 1;
        if (typeof a === 'function') throw a();
        return a;
      },
      // 批四：規則卡生成（考題可注入候選；沒設定＝表現得像沒有這個能力）
      generateRecipe: async (/** @type {string} */ _text, /** @type {string} */ model) => {
        modelsUsed.push(`gen:${model}`);
        if (!(/** @type {any} */ (fakeGen).candidate)) throw new Error('no candidate');
        return /** @type {any} */ (fakeGen).candidate;
      },
    },
  };
}
const fakeBudget = () => { let n = 0; return { used: () => n, take: async () => { n += 1; }, loadBill: () => {} }; };
/** 生成候選的注入點（generateRecipe 讀它；每題自行設定/清空）。 */
const fakeGen = { candidate: /** @type {any} */ (null) };
/** 一張與 CARD_PDF 版面全對的卡片規則卡（出生/命中考題共用）。 */
const CARD_RECIPE = () => ({
  formatVersion: 1, bank: '遠東國際商業銀行',
  docAnchors: ['信用卡帳單', '本期應繳總額'], dateFormat: 'west-slash',
  totalsLabels: { prevDue: '上期應繳總額', paidAndRefund: '已繳款退款金額', newCharges: '本期新增款項', due: '本期應繳總額' },
  adjustmentLabels: ['循環信用利息'], lastFourLabel: '卡號末四碼', monthLabel: '結帳日期',
  detail: { headerAnchor: '本期應繳總額', rowShape: 'date-desc-amount', stopAnchors: [] },   // CARD_PDF 沒獨立表頭列＝用摘要末列當起點錨
});

beforeEach(() => {
  store.save({ ...store.emptyDb(),
    settings: { aiApiKey: 'k-test' },
    cards: [
      { id: 'ts', name: '台新卡', type: 'credit', issuer: '台新銀行', lastFour: '1111' },
      { id: 'feib', name: '遠銀卡', type: 'credit', issuer: '遠東商銀', lastFour: '5678' },
    ] });
});

test('★端到端｜認不得＋useAi＝AI 讀成功：engine 標記、票、aiIssuer 只當顯示、不自動歸卡', async () => {
  const fe = fakeEngine([GOOD_ANSWER()]);
  const r = await previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.equal(r.engine, 'ai');
  assert.equal(r.aiModel, 'model-primary');
  assert.equal(r.aiIssuer, '遠東國際商業銀行', '★AI 抄的機構名要帶給前端顯示');
  assert.equal(r.bank, '', '★但 bank 固定空字串——AI 的一句話不該拿到「錢記到哪張卡」的投票權');
  assert.equal(r.bankEvidence, 'none', '★分支④：前端警語照印');
  assert.equal(typeof r.aiTicket, 'string', '★要發確認票（換卡重預覽不重跑模型）');
  // ⚠️ 末四碼 5678 唯一命中遠銀卡，但機構認不出（bank ''）⇒ #518 J3 的守門：只當候選、不自動選
  assert.equal(r.resolvedCard, null, '★AI 路不得自動歸卡（末四碼唯一命中也一樣）');
  assert.ok(Array.isArray(r.candidates) && r.candidates.some((/** @type {any} */ c) => c.id === 'feib'));
  assert.deepEqual(r.statementTotals, { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 480 });
});

test('★守門｜旗標缺席＝原錯誤原句丟回、零 AI 呼叫（同意機制的後端半邊）', async () => {
  const fe = fakeEngine([GOOD_ANSWER()]);
  await assert.rejects(() => previewAuto(b64Of(CARD_PDF()), undefined, { aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() }),
    (/** @type {any} */ e) => e.code === 'card_unrecognized');
  assert.equal(fe.modelsUsed.length, 0, '★沒有 useAi:true 卻打了引擎＝同意機制被繞過');
});

test('★守門｜認得的版面不走 AI（useAi 只是「認不得時可以用」，不是「一律用」）', async () => {
  const fe = fakeEngine([GOOD_ANSWER()]);
  const okPdf = cjkPdf([
    ['台新國際商業銀行', '信用卡消費明細'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ]);
  const r = await previewAuto(b64Of(okPdf), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.equal(r.engine, undefined, '★模板讀得動就不走 AI');
  assert.equal(fe.modelsUsed.length, 0);
});

test('★守門｜密碼錯不走 AI：pdf_password 原 code 丟回（跳密碼窗），連「去設鑰匙」都不可搶在它前面', async () => {
  // 真加密 PDF 走完整真路（passwordPdf 見 helpers）。突變演練抓到的洞（2026-08-30）：
  // 原本用「認得的台新版面」當等價路徑，守門放寬成 ['card_unrecognized','pdf_password'] 也全綠。
  const fe = fakeEngine([GOOD_ANSWER()]);
  await assert.rejects(() => previewAuto(b64Of(passwordPdf()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() }),
    (/** @type {any} */ e) => e.code === 'pdf_password');
  assert.equal(fe.modelsUsed.length, 0, '★密碼錯＝零 AI 呼叫');
  // ★判別點：沒設鑰匙時**仍然**回 pdf_password、不是 ai_no_key——密碼窗的優先序不可被 AI 路的
  //   前置檢查搶走（守門若放寬讓 pdf_password 進 aiCardRoute，使用者會先被指去設鑰匙、密碼窗永遠跳不出來）。
  store.save({ ...store.emptyDb(), settings: {}, cards: [] });
  await assert.rejects(() => previewAuto(b64Of(passwordPdf()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() }),
    (/** @type {any} */ e) => e.code === 'pdf_password');
  assert.equal(fe.modelsUsed.length, 0);
});

test('★守門｜沒設鑰匙＝ai_no_key 白話指路（引擎零呼叫）', async () => {
  store.save({ ...store.emptyDb(), settings: {}, cards: [] });
  const fe = fakeEngine([GOOD_ANSWER()]);
  await assert.rejects(() => previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() }),
    (/** @type {any} */ e) => e.code === 'ai_no_key');
  assert.equal(fe.modelsUsed.length, 0);
});

test('★階梯｜第一讀壞答案＝升級 Opus 段再讀一次（單讀＝最多兩發；第二讀成功）', async () => {
  const fe = fakeEngine([{ garbage: true }, GOOD_ANSWER()]);
  const r = await previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.deepEqual(fe.modelsUsed, ['model-primary', 'model-escalation'], '★階梯順序＝primary 先、escalation 補');
  assert.equal(r.aiModel, 'model-escalation', '徽章要標實際採用的模型');
});

test('★階梯｜兩段都閘紅＝ai_reconcile_failed、恰好兩發（不無限重試）', async () => {
  const bad = () => { const g = GOOD_ANSWER(); g.adjustments = []; return g; };   // 等式差 30 ⇒ 閘紅
  const fe = fakeEngine([bad(), bad()]);
  await assert.rejects(() => previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() }),
    (/** @type {any} */ e) => e.code === 'ai_reconcile_failed');
  assert.equal(fe.modelsUsed.length, 2, '★單讀階梯＝最多兩發，第二次仍紅就照實擋');
});

test('★票制｜選卡憑票：不重跑模型、回新票；舊票一次性；新票可再換卡', async () => {
  const fe = fakeEngine([GOOD_ANSWER()]);
  const r = await previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  const callsAfterPreview = fe.modelsUsed.length;
  // 憑票選卡 ⇒ 有 resolvedCard 與 dup 標記過的 rows，且**引擎零新呼叫**
  const p1 = await previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: r.aiTicket });
  assert.equal(fe.modelsUsed.length, callsAfterPreview, '★憑票＝不重跑模型（AI 非確定性＋省發數）');
  assert.equal(p1.engine, 'ai');
  assert.equal(p1.resolvedCard.id, 'feib');
  assert.equal(p1.transactions.length, 4, '3 筆明細＋1 筆具名調整（裁示②＝利息記帳）');
  assert.equal(typeof p1.aiTicket, 'string');
  assert.notEqual(p1.aiTicket, r.aiTicket, '★票一次性 ⇒ 回應要發新票');
  // 舊票再用＝fail-closed
  await assert.rejects(() => previewForCard('ts', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: r.aiTicket }),
    (/** @type {any} */ e) => e.code === 'ai_ticket_invalid');
  // 新票換另一張卡照樣走
  const p2 = await previewForCard('ts', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: p1.aiTicket });
  assert.equal(p2.resolvedCard.id, 'ts');
  assert.equal(p2.transactions.length, 4);
});

test('★HOSTED 停止線｜雲端版 400、零 AI 呼叫；且排在鑰匙檢查**之前**（Grok 掃#5：缺這題時刪掉停止線照樣全綠）', async () => {
  // 直打 aiCardRoute（見其 export 註解：整合層翻 NOTEASY_HOSTED 會讓儲存層先要租戶而炸、到不了守門）
  const fe = fakeEngine([GOOD_ANSWER()]);
  process.env.NOTEASY_HOSTED = '1';
  try {
    await assert.rejects(() => aiCardRoute(new Uint8Array([1]), undefined, { settings: { aiApiKey: 'k-test' } }, { aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() }),
      (/** @type {any} */ e) => e.code === 'ai_hosted_off' && /雲端版/.test(e.message));
    await assert.rejects(() => aiCardRoute(new Uint8Array([1]), undefined, { settings: {} }, { aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() }),
      (/** @type {any} */ e) => e.code === 'ai_hosted_off', '★停止線在鑰匙檢查之前——雲端版連「去設鑰匙」都不該被指路');
  } finally { delete process.env.NOTEASY_HOSTED; }
  assert.equal(fe.modelsUsed.length, 0);
});

test('★票綁用途｜銀行式票（無 aiKind）拿到卡片預覽＝拒收且**還票**（Grok 掃#4：銀行列不得變卡片消費）', async () => {
  // 銀行/配方票的 parsed 沒有卡片摘要 ⇒ 卡片中閘只會弱閘放行——kind 閘要在中閘之前擋下
  const bankish = issueAiTicket({ parsed: { bank: '台新銀行', accounts: [], transactions: [] }, aiModel: 'm' });
  await assert.rejects(() => previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: bankish }),
    (/** @type {any} */ e) => e.code === 'ai_ticket_invalid' && /不是這份信用卡帳單/.test(e.message));
  assert.ok(redeemAiTicket(bankish), '★票要放回——那張票屬於銀行線，吞掉會害銀行 apply 只能重跑模型');
});

test('★兌票後半路丟錯＝還票再丟（Grok 掃#8）：中閘紅不吞票、使用者不必重跑模型', async () => {
  const badTotals = { prevDue: 0, paidAndRefund: 0, newCharges: 100, due: 999 };   // 等式差 899 ⇒ 中閘紅
  const cardBad = issueAiTicket({ parsed: { bank: '', bankEvidence: 'none', statementTotals: badTotals,
    transactions: [{ date: '2026-07-03', desc: '甲', amount: 100 }] }, aiModel: 'm', aiKind: 'card' });
  await assert.rejects(() => previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: cardBad }));
  assert.ok(redeemAiTicket(cardBad), '★半路丟錯要把票放回（同銀行 apply 的 restore 慣例）');
});

test('★發新票在最後一刻（Codex r12）：中閘之後、列組裝丟錯＝還舊票且**不留幽靈新票**', async () => {
  clearAiTicketsForTest();
  // 陷阱只在列組裝引爆：中閘讀 amount/desc、previewRowsForCard 才碰 date——date 是丟錯的 getter。
  const totals = { prevDue: 0, paidAndRefund: 0, newCharges: 100, due: 100 };   // 等式平 ⇒ 中閘綠
  const trapped = { amount: 100, desc: '甲店', get date() { throw new Error('列組裝陷阱'); } };
  const id = issueAiTicket({ parsed: { bank: '', bankEvidence: 'none', statementTotals: totals,
    transactions: [trapped] }, aiModel: 'm', aiKind: 'card' });
  await assert.rejects(() => previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: id }),
    /列組裝陷阱/);
  assert.equal(aiTicketCountForTest(), 1, '★只剩還回來的那一張——發票夾在中途時這裡會是 2（幽靈新票以全新 TTL 活著）');
  assert.ok(redeemAiTicket(id), '還回來的是原票、照樣可兌');
});

test('★中閘摺入｜AI 的 parsed 帶 aiAdjustments ⇒ 等式含利息也過中閘；模板 parsed 沒這欄＝行為零改變', async () => {
  const { reconcileCardStatement } = await import('../lib/statement-reconcile.js');
  const totals = { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 480 };
  const txs = [{ amount: 150, desc: '星巴克' }, { amount: 350, desc: '全聯' }, { amount: -50, desc: '退款', isRefund: true }];
  const ai = reconcileCardStatement(/** @type {any} */ ({ statementTotals: totals, transactions: txs, aiAdjustments: [{ label: '利息', amount: 30 }] }));
  assert.equal(ai.checks.equation, 'pass', '★具名調整摺進等式（遠銀的 due 含利息）');
  assert.equal(ai.stats.adjFolded, 30, '★摺了多少要進 stats——前端摘要句靠它照實換寫法（r2#2）');
  const tpl = reconcileCardStatement(/** @type {any} */ ({ statementTotals: totals, transactions: txs }));
  assert.equal(tpl.checks.equation, 'fail', '★模板 parsed 沒有 aiAdjustments ⇒ 同一組數字照舊不平（行為零改變的證據）');
  assert.equal(tpl.stats.adjFolded, 0, '★模板路恆 0＝前端句子一字不變');
});

test('★中閘等式容差分路（Grok 掃#1）｜AI 路差 1 元＝擋（裁示①）；模板路照舊 ±1（行為零改變）', async () => {
  const { reconcileCardStatement } = await import('../lib/statement-reconcile.js');
  const totals = { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 481 };   // 計算值 480、差 1
  const rows = [{ amount: 450, desc: '星巴克', isPayment: false, isRefund: false }];
  const ai = reconcileCardStatement(/** @type {any} */ ({ statementTotals: totals, transactions: rows,
    aiAdjustments: [{ label: '利息', amount: 30 }] }));
  assert.equal(ai.ok, false, '★兌票只重跑中閘那條路——中閘留 ±1＝差 1 元照收、與 G1 的 0 矛盾');
  // 模板組沒有 adjSum＝四格要自己差 1（450 vs 451），不能照抄 AI 組（那組差 31）
  const tpl = reconcileCardStatement(/** @type {any} */ ({ statementTotals: { ...totals, due: 451 }, transactions: rows }));
  assert.equal(tpl.checks.equation, 'pass', '★模板路照舊 CARD_EPS（差 1 收＝行為零改變）');
});

test('★中閘提醒（r1#1）｜明細無繳款列卻有退款列＝就地示警（盲點型：繳款被抄成退款恰等於桶）', async () => {
  const { reconcileCardStatement } = await import('../lib/statement-reconcile.js');
  const v = reconcileCardStatement(/** @type {any} */ ({
    statementTotals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 500, due: 500 },
    transactions: [{ amount: 500, desc: '星巴克', isPayment: false, isRefund: false },
      { amount: -1000, desc: '感謝您的支持', isPayment: false, isRefund: true }],
    aiAdjustments: [] }));
  assert.equal(v.ok, true, '算術上與真退款不可區分＝閘放行（已在檔頭與徽章劃界）');
  assert.ok(v.advisories.some((/** @type {any} */ p) => p.code === 'card-refund-check'),
    '★但要就地提醒：沒有繳款列、卻有退款列——請使用者看那幾筆負數');
  // 有繳款列＝正常形，不亂鳴
  const ok = reconcileCardStatement(/** @type {any} */ ({
    statementTotals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 450 },
    transactions: [{ amount: 450, desc: '星巴克', isPayment: false, isRefund: false },
      { amount: -1000, desc: '信用卡自動扣繳', isPayment: true, isRefund: false }],
    aiAdjustments: [] }));
  assert.equal(ok.ok, true);
  assert.ok(!ok.advisories.some((/** @type {any} */ p) => p.code === 'card-refund-check'), '繳款有列＝不鳴（狼來了會讓提醒失效）');
});

test('★調整列分開 finalize（r1#2）｜「國外交易服務費」不得繼承最後一筆消費的分類', async () => {
  const { categorize } = await import('../lib/statement.js');
  const pdf = cjkPdf([
    ['遠東國際商業銀行', '信用卡帳單'],
    ['卡號末四碼', '5678'],
    ['上期應繳總額', '1,000'],
    ['已繳款退款金額', '1,000'],
    ['本期新增款項', '500'],
    ['國外交易服務費', '30'],
    ['本期應繳總額', '530'],
    ['2026/07/03', '全聯福利中心', '350'],
    ['2026/07/10', '星巴克', '150'],
  ]);
  const answer = { issuer: '遠東國際商業銀行', lastFour: '5678', statementMonth: '2026-07',
    totals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 500, due: 530 },
    adjustments: [{ label: '國外交易服務費', amount: 30, date: null }],
    transactions: [
      { date: '2026-07-03', postDate: null, desc: '全聯福利中心', amount: 350 },
      { date: '2026-07-10', postDate: null, desc: '星巴克', amount: 150 },
    ] };
  const fe = fakeEngine([answer]);
  const r = await previewAuto(b64Of(pdf), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  const p = await previewForCard('feib', b64Of(pdf), undefined, undefined, { aiTicket: r.aiTicket });   // 列走憑票預覽（同正式 UI 動線）
  const fee = p.transactions.find((/** @type {any} */ t) => t.desc === '國外交易服務費');
  const coffee = p.transactions.find((/** @type {any} */ t) => t.desc === '星巴克');
  assert.ok(fee && coffee);
  const [expCat] = categorize('國外交易服務費');
  assert.equal(fee.category, expCat, '★分類走它自己的 categorize——不繼承相鄰消費');
  assert.notEqual(fee.category, coffee.category, '★尾接消費列一起 finalize 時會繼承星巴克的分類（finalize 的相鄰特例）——分開跑就不會');
  assert.equal(fee.isAdjustment, true, '標記要通過 finalize 存活（中閘據它跳過列對總額）');
});

test('★負的具名調整不是繳款（r8#1）｜「自動扣繳回饋金」標籤命中繳款判準也要可記帳', async () => {
  const pdf = cjkPdf([
    ['遠東國際商業銀行', '信用卡帳單'], ['卡號末四碼', '5678'],
    ['上期應繳總額', '1,000'], ['已繳款退款金額', '1,000'], ['本期新增款項', '500'],
    ['自動扣繳回饋金', '-30'], ['本期應繳總額', '470'],
    ['2026/07/03', '全聯福利中心', '500'],
  ]);
  const answer = { issuer: '遠東國際商業銀行', lastFour: '5678', statementMonth: '2026-07',
    totals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 500, due: 470 },
    adjustments: [{ label: '自動扣繳回饋金', amount: -30, date: null }],
    transactions: [{ date: '2026-07-03', postDate: null, desc: '全聯福利中心', amount: 500 }] };
  const fe = fakeEngine([answer]);
  const r = await previewAuto(b64Of(pdf), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  const p = await previewForCard('feib', b64Of(pdf), undefined, undefined, { aiTicket: r.aiTicket });
  const rebate = p.transactions.find((/** @type {any} */ t) => t.desc === '自動扣繳回饋金');
  assert.ok(rebate);
  assert.equal(rebate.isPayment, false, '★調整列不是繳款——標成繳款＝預覽禁選、直匯略過＝違反裁示②');
  assert.equal(rebate.isRefund, true, '負的調整＝抵減（消費視角）');
  // r9#1：**真寫入**——匯入端「不信前端重判 desc」會把它當繳款靜默略過（r8 考題只停在預覽）
  const out = await importRows('feib', [rebate], '2026-07', 470);
  assert.equal(out.skipped, 0, '★預覽說會記、寫入就要記——skipped 1 ＝畫面說謊');
  assert.equal(out.imported, 1);
  // Grok 掃#4：旗標要**入庫**、消費視角的配對尺要看得見——只活在預覽→匯入那一跳的話，
  // pairRefunds 照 desc 把這筆負回饋金當繳款丟掉＝月度回顧當它沒發生（裁示②只做到查帳那半）
  const { pairRefunds } = await import('../lib/derive.js');
  const db = store.load();
  const saved = (db.transactions || []).find((/** @type {any} */ t) => t.note === '自動扣繳回饋金' || t.storeKey === rebate.storeKey);
  assert.ok(saved && saved.isAdjustment === true, '★isAdjustment 要寫進資料庫');
  const { pairs, unmatchedRefunds, rewards } = pairRefunds(db);
  const inPool = [...(unmatchedRefunds || []), ...(rewards || []), ...((pairs || []).map((/** @type {any} */ p) => p.refund))]
    .some((/** @type {any} */ t) => t && t.id === saved.id);
  assert.ok(inPool, '★負的具名調整要進消費視角（退款候選/回饋任一格），不得被繳款 continue 吃掉');
});

test('★isAdjustment 是登記過型別的服務欄位（Codex r11）：還原塞 "false" 字串＝淨化成 false，不得 truthy 誤豁免繳款', async () => {
  // 還原路的規矩是**寬容淨化**不是拒收（異常輸入防線：合法舊資料不可因升級被刪）——
  // 危險的是「沒登記＝原樣收回」：'false' 字串是 truthy，pairRefunds 會把普通自動繳款改列成未對應退款。
  const { validateImportItem } = await import('../lib/schema.js');
  const base = { id: 'x', date: '2026-07-01', type: 'expense', category: '餐飲', amount: -1000 };
  assert.equal(validateImportItem('transactions', { ...base, isAdjustment: 'false' }).item.isAdjustment, false,
    '★"false" 字串要被淨化成布林 false（沒登記型別＝原樣收回＝truthy 誤豁免）');
  assert.equal(validateImportItem('transactions', { ...base, isAdjustment: true }).item.isAdjustment, true, '真 boolean 原樣保留');
  assert.ok(!('isAdjustment' in validateImportItem('transactions', base).item), '缺席不憑空長出欄位（既有列零改變）');
});

test('★調整列日期鏈（r3#3）｜三環各自有行為斷言：列印日期 → 期別 1 號 → 最新明細日；三者皆無＝不收', async () => {
  // 兩筆明細、日期一前一後（r4#2：只放一筆分不出「最新」「第一筆」「任一筆」——sort().pop()
  // 突變成取第一筆時考題要會紅）
  const mk = (/** @type {any} */ adjDate, /** @type {any} */ month) => ({
    issuer: '遠東國際商業銀行', lastFour: '5678', statementMonth: month,
    totals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 500, due: 530 },
    adjustments: [{ label: '循環信用利息', amount: 30, date: adjDate }],
    transactions: [
      { date: '2026-07-03', postDate: null, desc: '星巴克', amount: 200 },   // 第一筆＝較早（讓「取第一筆」的突變會紅）
      { date: '2026-07-20', postDate: null, desc: '全聯福利中心', amount: 300 },
    ] });
  const pdf = (/** @type {string[][]} */ extra) => cjkPdf([
    ['遠東國際商業銀行', '信用卡帳單'], ['卡號末四碼', '5678'],
    ['上期應繳總額', '1,000'], ['已繳款退款金額', '1,000'], ['本期新增款項', '500'],
    ['循環信用利息', '30'], ['本期應繳總額', '530'],
    ['2026/07/20', '全聯福利中心', '300'], ['2026/07/03', '星巴克', '200'], ...extra,
  ]);
  const rowOf = async (/** @type {any} */ answer, /** @type {any} */ p0) => {
    const fe = fakeEngine([answer]);
    const r = await previewAuto(b64Of(p0), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
    const p = await previewForCard('feib', b64Of(p0), undefined, undefined, { aiTicket: r.aiTicket });
    return p.transactions.find((/** @type {any} */ t) => t.desc === '循環信用利息');
  };
  assert.equal((await rowOf(mk('2026-07-15', '2026-07'), pdf([['2026/07/15', '利息列印日']]))).date, '2026-07-15', '★列印了日期＝用它');
  assert.equal((await rowOf(mk(null, '2026-07'), pdf([]))).date, '2026-07-01', '★沒印列日期＝期別 1 號');
  assert.equal((await rowOf(mk(null, null), pdf([]))).date, '2026-07-20', '★連期別都沒有＝**最新**明細日（不是第一筆——兩筆日期一前一後才驗得出）');
  // 三者皆無＝照實不收（fail-closed，不靜靜丟、不亂編日期）——零明細帳單：新增 0、應繳＝利息 30
  const corner = { issuer: '遠東國際商業銀行', lastFour: '5678', statementMonth: null,
    totals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 0, due: 30 },
    adjustments: [{ label: '循環信用利息', amount: 30, date: null }], transactions: [] };
  const cornerPdf = cjkPdf([
    ['遠東國際商業銀行', '信用卡帳單'], ['卡號末四碼', '5678'],
    ['上期應繳總額', '1,000'], ['已繳款退款金額', '1,000'], ['本期新增款項', '0'],
    ['循環信用利息', '30'], ['本期應繳總額', '30'],
  ]);
  const fe = fakeEngine([corner]);
  await assert.rejects(() => previewAuto(b64Of(cornerPdf), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() }),
    /記不了帳|沒印日期/);
});

test('★調整列逐列 finalize（r2#1）｜同批調整彼此也不得污染：「星巴克分期攤還」後的服務費不歸咖啡', async () => {
  const { categorize } = await import('../lib/statement.js');
  const pdf = cjkPdf([
    ['遠東國際商業銀行', '信用卡帳單'],
    ['卡號末四碼', '5678'],
    ['上期應繳總額', '1,000'],
    ['已繳款退款金額', '1,000'],
    ['本期新增款項', '500'],
    ['星巴克分期攤還', '200'],
    ['國外交易服務費', '30'],
    ['本期應繳總額', '730'],
    ['2026/07/03', '全聯福利中心', '500'],
  ]);
  const answer = { issuer: '遠東國際商業銀行', lastFour: '5678', statementMonth: '2026-07',
    totals: { prevDue: 1000, paidAndRefund: 1000, newCharges: 500, due: 730 },
    adjustments: [
      { label: '星巴克分期攤還', amount: 200, date: null },
      { label: '國外交易服務費', amount: 30, date: null },
    ],
    transactions: [{ date: '2026-07-03', postDate: null, desc: '全聯福利中心', amount: 500 }] };
  const fe = fakeEngine([answer]);
  const r = await previewAuto(b64Of(pdf), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  const p = await previewForCard('feib', b64Of(pdf), undefined, undefined, { aiTicket: r.aiTicket });
  const fee = p.transactions.find((/** @type {any} */ t) => t.desc === '國外交易服務費');
  const stages = p.transactions.find((/** @type {any} */ t) => t.desc === '星巴克分期攤還');
  assert.ok(fee && stages);
  assert.equal(fee.category, categorize('國外交易服務費')[0],
    '★逐列 finalize＝誰都不相鄰；同批一起跑時服務費會繼承前一列（分期攤還→咖啡）的分類');
  assert.notEqual(fee.category, stages.category, '兩列各走各的 categorize（分期攤還含店名＝會被歸進該店分類，這是它自己的事）');
});

test('★中閘慣例閘（裁示③）｜AI 路列對總額對不上＝擋；模板路**同款列差額**仍只提醒（Grok 掃#5：模板組 due 改 450 讓 C1 過——本題射程只在 C2 的擋/不擋，不宣稱四格相同）', async () => {
  const { reconcileCardStatement } = await import('../lib/statement-reconcile.js');
  const totals = { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 480 };
  const rows = [{ amount: 150, desc: '星巴克', isPayment: false, isRefund: false },
    { amount: 350, desc: '全聯', isPayment: false, isRefund: false }];   // 漏了 -50 那筆 ⇒ 兩種慣例都差 50
  const ai = reconcileCardStatement(/** @type {any} */ ({ statementTotals: totals, transactions: rows,
    aiAdjustments: [{ label: '利息', amount: 30 }] }));
  assert.equal(ai.ok, false, '★AI 路（有 aiAdjustments 欄＝標記）＝慣例閘升級成擋');
  assert.ok(ai.problems.some((/** @type {any} */ p) => p.code === 'card-rows-vs-totals'));
  const tpl = reconcileCardStatement(/** @type {any} */ ({ statementTotals: { ...totals, due: 450 }, transactions: rows }));
  assert.equal(tpl.ok, true, '★模板路同款差 50＝照舊只提醒不擋（行為零改變）');
  assert.ok(tpl.advisories.some((/** @type {any} */ p) => p.code === 'card-new-vs-rows'));
  // 具名調整列（isAdjustment）不得參與列對總額（等式已摺過 adjSum、再計入＝重複計）
  const withAdj = reconcileCardStatement(/** @type {any} */ ({ statementTotals: totals,
    transactions: [...rows, { amount: -50, desc: '退款', isPayment: false, isRefund: true },
      { amount: 30, desc: '循環信用利息', isAdjustment: true, isPayment: false, isRefund: false }],
    aiAdjustments: [{ label: '循環信用利息', amount: 30 }] }));
  assert.equal(withAdj.ok, true, '★調整列跳過後：450 對 450、等式摺 30 對 480——全綠');
});

// ── 批四：規則卡（免費路）＋出生全循環 ─────────────────────────────────────────

test('★規則卡命中｜認不得＋櫃子有 kind=card 的卡＝**免費**讀出（零 AI 呼叫、不需 useAi）；票帶 recipeUse', async () => {
  const db0 = store.load();
  db0.parseRecipes = [{ id: 'rcp-card1', bank: '遠東國際商業銀行', kind: 'card', current: CARD_RECIPE(),
    graduateStreak: 0, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }];
  store.save(db0);
  const fe = fakeEngine([GOOD_ANSWER()]);
  const r = await previewAuto(b64Of(CARD_PDF()), undefined, { aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.equal(r.engine, 'recipe', '★規則卡讀的＝engine recipe（前端徽章據此換句）');
  assert.equal(r.recipeId, 'rcp-card1');
  assert.equal(fe.modelsUsed.length, 0, '★零 AI 呼叫＝零費用（連 useAi 旗標都不用）');
  assert.equal(r.bank, '', '★歸卡紀律同 AI：規則卡的機構名也只當顯示、不投票');
  assert.equal(r.aiIssuer, '遠東國際商業銀行');
  assert.deepEqual(r.statementTotals, { prevDue: 1000, paidAndRefund: 1000, newCharges: 450, due: 480 });
  // 憑票換卡＝同一份、engine 仍是 recipe、新票傳承 recipeUse
  const p1 = await previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: r.aiTicket });
  assert.equal(p1.engine, 'recipe');
  assert.equal(p1.recipeId, 'rcp-card1');
  // 匯入帶票＝畢業計數 +1（真的寫入了才算）
  const out = await importRows('feib', p1.transactions, '2026-07', 480, { aiTicket: p1.aiTicket });
  assert.ok(out.imported > 0);
  const row = (store.load().parseRecipes || []).find((/** @type {any} */ x) => x.id === 'rcp-card1');
  assert.equal(row.graduateStreak, 1, '★用 current 成功匯入＝畢業計數 +1（與銀行同一支 recordRecipeApplied）');
});

test('★規則卡全敗｜useAi 才輪到 AI；AI 票帶 gateFailedIds（匯入成功才標疑似過期）', async () => {
  const db0 = store.load();
  const stale = CARD_RECIPE(); stale.totalsLabels = { ...stale.totalsLabels, prevDue: '上期結欠' };   // 版面對不上這張卡
  db0.parseRecipes = [{ id: 'rcp-stale', bank: '遠東國際商業銀行', kind: 'card', current: stale,
    graduateStreak: 3, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }];
  store.save(db0);
  const fe = fakeEngine([GOOD_ANSWER()]);
  const r = await previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.equal(r.engine, 'ai', '規則卡救不了＝AI 救');
  assert.ok(fe.modelsUsed.length > 0);
  // 匯入（AI 票）＝疑似過期落地：rcp-stale 的 current 中了版面暗號、整列沒過 ⇒ 標 suspect
  const p1 = await previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: r.aiTicket });
  fakeGen.candidate = null;   // 這題不測出生
  const out = await importRows('feib', p1.transactions, '2026-07', 480, { aiTicket: p1.aiTicket, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.ok(out.imported > 0);
  const row = (store.load().parseRecipes || []).find((/** @type {any} */ x) => x.id === 'rcp-stale');
  assert.equal(row.suspect, true, '★current 中暗號卻整列沒過＝疑似過期（匯入成功才標；同銀行）');
  assert.equal(row.graduateStreak, 0, '疑似過期＝畢業計數歸零');
});

test('★出生全循環｜AI 讀→匯入學卡（Opus 一發、出生把關全過、kind=card）→**同版面第二份免費**', async () => {
  const fe = fakeEngine([GOOD_ANSWER()]);
  fakeGen.candidate = CARD_RECIPE();
  const r = await previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.equal(r.engine, 'ai');
  const p1 = await previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: r.aiTicket });
  const out = await importRows('feib', p1.transactions, '2026-07', 480, { aiTicket: p1.aiTicket, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.ok(out.imported > 0);
  assert.ok(fe.modelsUsed.includes('gen:claude-opus-5'), '★出生那一發一律 Opus（同銀行 RECIPE_MODEL）');
  const rows = (store.load().parseRecipes || []).filter((/** @type {any} */ x) => x.kind === 'card');
  assert.equal(rows.length, 1, '★學成一張卡片規則卡（kind=card 進同一個櫃子）');
  assert.equal(rows[0].bank, '遠東國際商業銀行');
  // 第二份同版面＝免費（零 AI 呼叫、不需 useAi）
  const fe2 = fakeEngine([GOOD_ANSWER()]);
  const r2 = await previewAuto(b64Of(CARD_PDF()), undefined, { aiEngineFactory: () => fe2.engine, aiBudget: fakeBudget() });
  assert.equal(r2.engine, 'recipe', '★「AI 讀一次 → 學成規則卡 → 之後免費」全循環閉合');
  assert.equal(fe2.modelsUsed.length, 0);
  fakeGen.candidate = null;
});

test('★出生把關擋壞卡｜候選錨點是店名＝不存卡、匯入不受影響（不連坐）', async () => {
  const fe = fakeEngine([GOOD_ANSWER()]);
  const bad = CARD_RECIPE(); bad.adjustmentLabels = ['星巴克'];   // 錨點＝帳單內容（出生對照關要擋）
  fakeGen.candidate = bad;
  const r = await previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  const p1 = await previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: r.aiTicket });
  const out = await importRows('feib', p1.transactions, '2026-07', 480, { aiTicket: p1.aiTicket, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.ok(out.imported > 0, '★出生失敗不連坐——匯入照常完成');
  assert.equal((store.load().parseRecipes || []).filter((/** @type {any} */ x) => x.kind === 'card').length, 0, '★壞卡不入櫃');
  const stats = store.load().settings?.recipeBirthStats || {};
  assert.ok(/** @type {any} */ (stats).recipe_birth_statement?.n >= 1, '★出生統計記下是哪一關擋的（對照關）');
  fakeGen.candidate = null;
});

test('★櫃子分流｜kind=card 的卡不進銀行路（銀行帳單不會拿它試、也不會把它標成疑似過期）', async () => {
  const { recipeBankRoute } = await import('../lib/services/bank-import.js');
  // 卡片卡的 docAnchors 故意選會出現在銀行帳單裡的字（若沒過濾，match 會中、parse 會敗 ⇒ 進 gateFailedIds）
  const cardRow = { id: 'rcp-cardX', bank: '遠銀', kind: 'card',
    current: { ...CARD_RECIPE(), docAnchors: ['台幣', '存款'] },
    graduateStreak: 0, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' };
  const db = { parseRecipes: [cardRow], settings: {}, cards: [] };
  const fakeExtract = async () => [{ y: 0, cells: [{ x: 0, s: '台幣' }, { x: 1, s: '存款' }] }];
  const out = await recipeBankRoute('QUFBQQ==', undefined, /** @type {any} */ (db), { extract: fakeExtract });
  assert.equal(out.hit, null);
  assert.deepEqual(out.gateFailedIds, [], '★沒過濾的話這張卡會被銀行路標成疑似過期候選（畢業計數會被銀行匯入清洗）');
});

test('★面板投影帶 kind｜listParseRecipes 分得出信用卡卡（面板顯示「信用卡」標籤用）', async () => {
  const db0 = store.load();
  db0.parseRecipes = [
    { id: 'rcp-b', bank: '台新', current: { x: 1 }, graduateStreak: 0, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'rcp-c', bank: '遠銀', kind: 'card', current: { x: 1 }, graduateStreak: 0, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
  ];
  store.save(db0);
  const { listParseRecipes } = await import('../lib/services/bank-import.js');
  const rows = await listParseRecipes();
  assert.equal(rows.find((/** @type {any} */ r) => r.id === 'rcp-b').kind, 'bank', '缺席＝bank（既有卡零遷移）');
  assert.equal(rows.find((/** @type {any} */ r) => r.id === 'rcp-c').kind, 'card');
});

test('★櫃子分流（反向）｜銀行卡不進卡片路：暗號撞上卡片帳單也不得被試、不得被標疑似過期', async () => {
  const db0 = store.load();
  db0.parseRecipes = [{ id: 'rcp-bankX', bank: '台新',   // 沒有 kind＝銀行卡；暗號故意撞 CARD_PDF
    current: { formatVersion: 1, bank: '台新', docAnchors: ['信用卡帳單', '本期應繳總額'], dateFormat: 'west-slash',
      refDate: { strategy: 'none', anchor: null }, summary: { sections: [{ anchor: '台幣', currency: 'TWD' }], endAnchor: '總計', balancePick: 'last' },
      detail: { rowIdent: 'date-first', headerOut: '支出', headerIn: '存入', headerBalance: '餘額', headerNote: null, headerIgnore: [] } },
    graduateStreak: 4, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }];
  store.save(db0);
  const fe = fakeEngine([GOOD_ANSWER()]);
  fakeGen.candidate = null;
  const r = await previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  assert.equal(r.engine, 'ai', '銀行卡不服役卡片路＝照樣走 AI');
  const p1 = await previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: r.aiTicket });
  await importRows('feib', p1.transactions, '2026-07', 480, { aiTicket: p1.aiTicket, aiEngineFactory: () => fe.engine, aiBudget: fakeBudget() });
  const row = (store.load().parseRecipes || []).find((/** @type {any} */ x) => x.id === 'rcp-bankX');
  assert.equal(row.suspect, false, '★不濾 kind 的話：銀行卡暗號撞中卡片帳單→解不動→進疑似名單→卡片匯入把它清洗（鏡像銀行路那題）');
  assert.equal(row.graduateStreak, 4, '畢業計數不受卡片匯入影響');
});

test('★規則卡不收爛帳｜版面命中但帳單數學不平＝當作沒有規則卡（fail-closed 退回認不得/AI）', async () => {
  const db0 = store.load();
  db0.parseRecipes = [{ id: 'rcp-card1', bank: '遠東國際商業銀行', kind: 'card', current: CARD_RECIPE(),
    graduateStreak: 0, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }];
  store.save(db0);
  // 同版面、但「本期應繳」印錯（等式差 100）——規則卡解得動、驗算閘要擋
  const badPdf = cjkPdf([
    ['遠東國際商業銀行', '信用卡帳單'], ['卡號末四碼', '5678'], ['結帳日期', '2026/07/20'],
    ['上期應繳總額', '1,000'], ['已繳款退款金額', '1,000'], ['本期新增款項', '450'],
    ['循環信用利息', '30'], ['本期應繳總額', '580'],
    ['2026/07/03', '星巴克', '150'], ['2026/07/10', '全聯福利中心', '350'], ['2026/07/12', '退款全聯', '-50'],
  ]);
  await assert.rejects(() => previewAuto(b64Of(badPdf), undefined, {}),
    (/** @type {any} */ e) => e.code === 'card_unrecognized',
    '★規則卡讀的走批二同一把閘——閘紅＝這張卡這次不算命中，原錯誤照丟（前端照舊長 AI 入口）');
});

test('★重生鎖同 kind（r1#4）｜rebirthId 撞到銀行列＝改走新建、不跨線覆寫', async () => {
  const { saveParseRecipe } = await import('../lib/repo.js');
  const db0 = store.load();
  db0.parseRecipes = [{ id: 'rcp-bankY', bank: '台新', current: { x: 1 }, graduateStreak: 5, graduated: true,
    suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }];
  store.save(db0);
  const out = await saveParseRecipe(/** @type {any} */ (CARD_RECIPE()), { kind: 'card', rebirthId: 'rcp-bankY', notAfter: '2099-01-01T00:00:00.000Z' });
  assert.equal(out.rebirth, false, '★異 kind＝不重生、走新建');
  const rows = store.load().parseRecipes || [];
  const bankRow = rows.find((/** @type {any} */ x) => x.id === 'rcp-bankY');
  assert.equal(bankRow.graduated, true, '★銀行列的畢業狀態一根汗毛都不能動');
  assert.deepEqual(bankRow.current, { x: 1 });
  assert.ok(rows.some((/** @type {any} */ x) => x.kind === 'card' && x.id !== 'rcp-bankY'), '卡片卡另立新列');
});

test('★異種票先還再忽略（r1#5）｜銀行票丟進卡片匯入＝匯入照常、票放回（銀行 apply 不必重跑模型）', async () => {
  const bankish = issueAiTicket({ parsed: { bank: '台新', accounts: [], transactions: [] }, aiModel: 'm' });
  const out = await importRows('feib', [
    { date: '2026-07-03', desc: '甲店', amount: 100, category: '餐飲', stmtRef: 'feib|2026-07-03|100|甲店' },
  ], '2026-07', 100, { aiTicket: bankish });
  assert.equal(out.imported, 1, '匯入本身照常');
  assert.ok(redeemAiTicket(bankish), '★票要放回——破壞性兌掉＝銀行 apply 只能重花錢重讀');
});

test('★出生載回票發數（r2#2）｜loadBill(ticket.aiCalls)＝單張上限跨 preview→import 不歸零', async () => {
  const fe = fakeEngine([GOOD_ANSWER()]);
  fakeGen.candidate = CARD_RECIPE();
  // 假引擎不經真 transport＝take 不會累積——preview 的護欄注入 used:()=>2，票就記下 aiCalls=2
  const r = await previewAuto(b64Of(CARD_PDF()), undefined, { useAi: true, aiEngineFactory: () => fe.engine,
    aiBudget: { used: () => 2, take: async () => {}, loadBill: () => {} } });
  const p1 = await previewForCard('feib', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: r.aiTicket });
  /** @type {number[]} */ const loaded = [];
  const budget = { used: () => 0, take: async () => {}, loadBill: (/** @type {number} */ n) => { loaded.push(n); } };
  await importRows('feib', p1.transactions, '2026-07', 480, { aiTicket: p1.aiTicket, aiEngineFactory: () => fe.engine, aiBudget: budget });
  assert.deepEqual(loaded, [2], '★票裡 preview 用掉的發數要載回護欄——不載＝出生那發從零起算、單張上限被請求邊界繞過');
  fakeGen.candidate = null;
});

test('★同種票兌後失敗要還票（r2#5）｜計數/寫入段炸掉＝票放回、錯誤原樣丟（同銀行 apply 的還票邊界）', async () => {
  // 兌票之後、saveDb 完成之前的失敗都走同一個 catch——這裡用票內 recipeUse 的陷阱 getter
  // 從官方通道引爆計數段（SQLite 連線先開＝檔案權限注入對已開的 fd 無效，saveDb 難以外部弄炸；
  // 兩種失敗共用同一條還票邊界，引爆哪一段證明的是同一件事）。
  const trap = { id: 'rcp-x', get usedVersion() { throw new Error('boom-counting'); }, currentMatched: true, usedRecipe: {} };
  const cardT = issueAiTicket({ parsed: { bank: '', bankEvidence: 'none',
    statementTotals: { prevDue: 0, paidAndRefund: 0, newCharges: 100, due: 100 },
    transactions: [{ date: '2026-07-03', desc: '甲', amount: 100 }] }, aiModel: '', aiKind: 'card',
    recipeUse: /** @type {any} */ (trap) });
  await assert.rejects(() => importRows('feib', [
    { date: '2026-07-03', desc: '甲店', amount: 100, category: '餐飲', stmtRef: 'x|2026-07-03|100|甲店' },
  ], '2026-07', 100, { aiTicket: cardT }), /boom-counting/);
  assert.ok(redeemAiTicket(cardT), '★兌了卻沒完成寫入＝票要放回（吞掉＝重試會寫錢卻永遠學不成卡）');
});

test('★疑似過期鎖同櫃（r2#4）｜卡片票的失靈名單撞到銀行同 id 列＝不動它', async () => {
  const { markRecipesSuspect } = await import('../lib/services/bank-import.js');
  const db = { parseRecipes: [
    { id: 'same-id', bank: '台新', current: { x: 1 }, graduateStreak: 5, graduated: true, suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
  ] };
  markRecipesSuspect(/** @type {any} */ (db), ['same-id'], '2099-01-01T00:00:00.000Z', 'card');
  assert.equal(db.parseRecipes[0].suspect, false, '★卡片線只動卡片櫃——銀行列的畢業狀態不可被跨櫃清洗');
  assert.equal(db.parseRecipes[0].graduated, true);
  markRecipesSuspect(/** @type {any} */ (db), ['same-id'], '2099-01-01T00:00:00.000Z');   // 銀行線自己動自己＝照舊
  assert.equal(db.parseRecipes[0].suspect, true, '銀行線（缺席 kind 預設 bank）行為零改變');
});

test('★畢業計數鎖同櫃（r3#3）｜卡片票的 recipeUse 撞到銀行同 id 同內容列＝不動它', async () => {
  const { recordRecipeApplied } = await import('../lib/services/bank-import.js');
  const db = { parseRecipes: [
    { id: 'same-id2', bank: '台新', current: { x: 1 }, graduateStreak: 4, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
  ] };
  recordRecipeApplied(/** @type {any} */ (db), { id: 'same-id2', usedVersion: 'current', currentMatched: true, usedRecipe: { x: 1 }, imported: 3 }, 'card');
  assert.equal(db.parseRecipes[0].graduateStreak, 4, '★卡片線不可把銀行列的 streak 推到 5＝畢業（跨櫃污染）');
  recordRecipeApplied(/** @type {any} */ (db), { id: 'same-id2', usedVersion: 'current', currentMatched: true, usedRecipe: { x: 1 }, imported: 3 });
  assert.equal(db.parseRecipes[0].graduateStreak, 5, '銀行線（預設 bank）行為零改變');
  assert.equal(db.parseRecipes[0].graduated, true);
});

test('★kind 是封閉枚舉（r3#4）｜備份塞 kind:"cadr" ＝驗證擋下，不得靜默當成銀行列', async () => {
  const { validateImportItem } = await import('../lib/schema.js');
  const base = { id: 'rcp-1', current: { x: 1 } };
  assert.ok(validateImportItem('parseRecipes', { ...base, kind: 'cadr' }).errors.length > 0,
    '★kind 是兩櫃唯一的分流鍵——拼錯值靜默通過＝靜默改櫃');
  assert.equal(validateImportItem('parseRecipes', { ...base, kind: 'card' }).errors.length, 0);
  assert.equal(validateImportItem('parseRecipes', base).errors.length, 0, '缺席＝銀行（既有備份零改變）');
});

test('★重生守門缺席≡bank（r4#6）｜顯式 kind:"bank" 的列、銀行重生省略 kind＝照樣重生（不誤判跨櫃另建）', async () => {
  const { saveParseRecipe } = await import('../lib/repo.js');
  const db0 = store.load();
  db0.parseRecipes = [{ id: 'rcp-bankZ', bank: '台新', kind: 'bank', current: { x: 1 }, graduateStreak: 2, graduated: false,
    suspect: true, rebirths: 0, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }];
  store.save(db0);
  const out = await saveParseRecipe(/** @type {any} */ ({ y: 2 }), { rebirthId: 'rcp-bankZ', notAfter: '2099-01-01T00:00:00.000Z' });
  assert.equal(out.rebirth, true, '★缺席 kind 與顯式 bank ＝同一櫃——誤判跨櫃會另建重複列、疑似卡留著');
  const rows = store.load().parseRecipes || [];
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].current, { y: 2 });
});
