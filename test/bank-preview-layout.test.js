// 銀行對帳單預覽窗的**排版順序**（William 2026-08-13 第⑤項：說明區移到最下面）。
//
// 為什麼需要這一題：那項要求原本**零考題**——把說明區搬回頂端，1997 題照樣全綠。
// 而它不是體感問題：William 要的是「窗一打開先看到帳戶餘額與交易明細」，
// 搬回去等於這項交辦被靜靜撤銷。2026-08-14 我在解 #453 的衝突時，
// 這一整塊正好落在衝突區裡、必須手工重放——沒有考題的話，放錯了不會有人知道。
//
// 這題**跑真的樣板**（把 showBankPreview 裡 `const body = ` 那段原封不動抽出來執行），
// 驗的是**產出的 HTML 裡各區塊的先後**，不是原始碼長相：
// 只要渲染結果的順序對，怎麼寫都行；順序錯了，怎麼寫都紅。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankPreviewFootnote, bankBlockedWarningHtml, bankSimilarWarningHtml, bankSimilarTagHtml, bankNoAccountNote } from '../public/modules/cashflow-model.js';
import { aiPreviewBadgeHtml, recipePreviewBadgeHtml } from '../public/modules/ai-consent.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 抽出 `showBankPreview` 由區域變數到 body 樣板結束的那一段，當成函式跑。
 * ⚠️ 刻意**不抄一份樣板**：抄了就是在驗抄本，實作搬走了考題也不會知道。
 */
function renderPreviewBody(/** @type {any} */ r) {
  const src = read('public/modules/cashflow.js');
  const start = src.indexOf('function showBankPreview(');
  assert.ok(start >= 0, '找不到 showBankPreview——實作改名了就要改這題（不是刪掉它）');
  const bodyStart = src.indexOf('const rows = r.rows || [];', start);
  const bodyEnd = src.indexOf('\n`;\n', bodyStart);
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, '找不到 body 樣板的起訖');
  const chunk = src.slice(bodyStart, bodyEnd + 3);

  const esc = (/** @type {any} */ v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const money = (/** @type {any} */ n) => String(n);
  const ACTION_LABEL = { update: '更新餘額', create: '新建帳戶' };
  const gateSummaryHtml = () => '<div data-stub="gate">對帳結果</div>';
  return Function('r', 'esc', 'money', 'ACTION_LABEL', 'gateSummaryHtml',
    'bankBlockedWarningHtml', 'bankSimilarWarningHtml', 'bankSimilarTagHtml',
    'bankPreviewFootnote', 'aiPreviewBadgeHtml', 'recipePreviewBadgeHtml', 'bankNoAccountNote',
    `${chunk}\n return body;`)(
    r, esc, money, ACTION_LABEL, gateSummaryHtml,
    bankBlockedWarningHtml, bankSimilarWarningHtml, bankSimilarTagHtml,
    bankPreviewFootnote, aiPreviewBadgeHtml, recipePreviewBadgeHtml, bankNoAccountNote);
}

/** 合成資料——**刻意不用任何真實帳單內容**（PII 鐵則）。 */
const RESULT = Object.freeze({
  bank: '合成銀行',
  referenceDate: '2026-05-31',
  reconcile: { level: 'strong', ok: true },
  engine: 'ai',                                  // ⚠️ aiPreviewBadgeHtml 只認 engine==='ai'
  aiModel: 'claude-haiku-4-5-20251001',          //    形狀寫錯＝徽章渲染成空字串、順序斷言變空包彈
  rows: [{ name: '合成帳戶', currency: 'TWD', balance: 1000, oldBalance: 900, action: 'update' }],
  transactions: {
    counts: { income: 1, expense: 2, transfer: 0, duplicate: 0, foreign: 0 },
    rows: [{ date: '2026-05-02', account: '合成帳戶', desc: '合成明細', type: 'expense', amount: 100, category: '飲食' }],
  },
});

/** 回傳每個標記在 HTML 裡的位置；找不到就直接讓考題失敗（不可回 -1 讓比較恆真＝空包彈） */
function positions(html, marks) {
  const out = {};
  for (const [key, needle] of Object.entries(marks)) {
    const i = html.indexOf(needle);
    assert.ok(i >= 0, `預覽窗裡找不到「${key}」（${needle}）——這題比的是先後，找不到就沒得比`);
    out[key] = i;
  }
  return out;
}

test('預覽窗排版｜說明區在最下面：先帳戶餘額與交易明細，「誰讀的／驗到什麼程度」在核對之後', () => {
  const html = renderPreviewBody(RESULT);
  const p = positions(html, {
    帳戶餘額: '帳戶餘額',
    交易明細: '交易明細',
    腳註: '按下確認會匯入的全部內容',                 // bankPreviewFootnote 的產出
    說明區: 'border-top:1px solid var(--line)',    // 說明區的分隔線容器
    徽章: '這一份是 AI 幫你讀出來的帳單預覽',
    對帳結果: 'data-stub="gate"',
  });
  assert.ok(p.帳戶餘額 < p.交易明細, '帳戶餘額要在交易明細之前');
  assert.ok(p.交易明細 < p.說明區, '★交易明細必須在說明區**之前**（William 2026-08-13：窗一打開先看到數字）');
  assert.ok(p.說明區 < p.徽章 && p.徽章 < p.對帳結果, '★說明區容器內依序是徽章、參考日、對帳結果');
  assert.match(html, /請確認「機構名」/u,
    '★徽章要真的渲染出內容——形狀寫錯會渲染成空字串，那時上面那些順序斷言全是空包彈');
  assert.ok(p.徽章 > p.交易明細,
    '★AI 徽章不可以回到頂端——它那句「請確認有沒有讀錯」是 William 明示要放在核對之後的');
});

test('預覽窗排版｜「餘額這次不更新」是警告不是說明，要留在最上面', () => {
  const html = renderPreviewBody({ ...RESULT, blocked: true });
  const p = positions(html, {
    警告: '這次不會更新',              // bankBlockedWarningHtml 的產出
    帳戶餘額: '帳戶餘額',
    說明區: 'border-top:1px solid var(--line)',
  });
  assert.ok(p.警告 < p.帳戶餘額,
    '★這是「你的餘額不會被更新」的警告，不是背景說明——被搬到最下面就等於沒講');
  assert.ok(p.警告 < p.說明區);
  assert.doesNotMatch(renderPreviewBody(RESULT), /這次不會更新/u,
    '沒 blocked 的帳單不可以出現這句（恆顯示＝這題其實沒在驗 blocked）');
});

test('P2-3｜配方預覽的徽章真的接上：engine recipe 的 body 含「版面規則卡」（只塞 harness 參數＝假綠）', () => {
  const html = renderPreviewBody({ ...RESULT, engine: 'recipe', recipeId: 'rcp-1' });
  assert.ok(html.includes('版面規則卡'), '★徽章要真的出現在預覽 body（cashflow.js 的插值被刪＝這裡紅）');
  const aiHtml = renderPreviewBody({ ...RESULT, engine: 'ai' });
  assert.equal(aiHtml.includes('版面規則卡'), false, '互斥：AI 預覽不畫配方徽章');
});