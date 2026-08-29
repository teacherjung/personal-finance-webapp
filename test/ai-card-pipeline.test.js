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
const { previewAuto, previewForCard, aiCardRoute } = await import('../lib/services/statement-import.js');
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
    },
  };
}
const fakeBudget = () => { let n = 0; return { used: () => n, take: async () => { n += 1; }, loadBill: () => {} }; };

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
  assert.equal(p1.transactions.length, 3);
  assert.equal(typeof p1.aiTicket, 'string');
  assert.notEqual(p1.aiTicket, r.aiTicket, '★票一次性 ⇒ 回應要發新票');
  // 舊票再用＝fail-closed
  await assert.rejects(() => previewForCard('ts', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: r.aiTicket }),
    (/** @type {any} */ e) => e.code === 'ai_ticket_invalid');
  // 新票換另一張卡照樣走
  const p2 = await previewForCard('ts', b64Of(CARD_PDF()), undefined, undefined, { aiTicket: p1.aiTicket });
  assert.equal(p2.resolvedCard.id, 'ts');
  assert.equal(p2.transactions.length, 3);
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
