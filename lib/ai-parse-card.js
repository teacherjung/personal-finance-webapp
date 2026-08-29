// @ts-check
// **信用卡帳單的 AI 解析**（批二，2026-08-30）：內建範本認不得的信用卡 PDF（`card_unrecognized`）
// 的救援路——答案卷 schema／提示詞／fail-closed 驗收／接地檢查／驗算閘，全部住這裡（純模組、零外連；
// 打供應商的只有 lib/ai-transport.js）。鏡射銀行線 lib/ai-parse.js 的分工，**不共用銀行的答案卷**：
// 信用卡與存款對帳單的語意不同（卡片沒有帳戶餘額鏈、有「應繳等式」與「非明細的具名金額列」）。
//
// ## William 的三項裁示（2026-08-27/28，本檔的憲法）
//
// 1. **驗算閘＝加嚴**：AI 讀的信用卡帳單，逐筆加總對不上就**不收**（內建範本那條路行為不變）。
//    ⚠️ 天真版是比錯了東西：帳單等式＝「上期應繳 −已繳/退款 ＋本期新增 ＋利息 ＋違約金 … ＝本期應繳」，
//    循環利息／分期攤還**本來就不在消費明細裡**。正解＝AI 把**有名字的非明細金額列**另抄成
//    `adjustments`，驗算時①等式閘：上期 −已繳 ＋新增 ＋Σ具名 ≈ 應繳②加總閘：Σ明細 ≈ 本期新增。
//    差額**沒有名字**才擋。實測他 5 份遠銀帳單全部印了完整等式行 ⇒ 這條路走得通、★6 不必放寬。
// 2. **先單讀**（不開雙讀）：每份最多打一發解析（成本護欄的 take() 由 transport 統一執行）。
// 3. **店名跑 `normalizeDesc`**（與內建範本同口徑）：AI 兩次讀同一份差一個空白就變兩筆＝重複入帳。
//
// ## 與 #518 機構身分判準的關係
//
// AI 抄回的發卡機構名（`issuer`）**只當顯示資訊**，不參與自動歸卡——歸卡仍走 card-identity 的
// 判準（AI 讀的版面本來就是我們認不得的家，`issuerBank()` 幾乎必然回 `''` ⇒ 分支④手選＋警語）。
// 這是刻意的：AI 的一句話不該拿到「錢記到哪張卡」的投票權。

import { isRealDate } from './schema.js';
import { normalizeDesc } from './statement.js';

// 同 lib/ai-parse.js 的作法：錯誤物件自帶 status/code，路由層原樣轉出（不 import route-helpers＝維持零依賴方向）
const apiError = (/** @type {number} */ status, /** @type {string} */ msg, /** @type {string=} */ code) =>
  Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });

// ── 上限（fail-closed 的邊界；超過＝壞答案，不是「盡量收」）─────────────────
export const CARD_LIMITS = {
  issuer: 60,
  shortStr: 80,
  transactions: 500,     // 一期信用卡帳單的合理上限（實測他的帳單最多 75 筆）
  adjustments: 40,       // 具名金額列（利息／年費／分期…）不會多過這個量級
  amountAbs: 1e8,        // 與模板路同一個解析雜訊上限
};

/** 模型階梯（同銀行線裁示⑥：解析預設 Sonnet、閘紅／壞答案升 Opus 重試一次；單讀＝裁示②）。 */
export const AI_CARD_MODELS = { primary: 'claude-sonnet-5', escalation: 'claude-opus-5' };

/** 具名差額與逐筆加總允許的誤差（元）：帳單都是整數元；1 元吸收去尾差。 */
export const CARD_TOLERANCE = 1;

// ── 答案卷 ──────────────────────────────────────────────────────────────────
export const AI_CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issuer', 'lastFour', 'statementMonth', 'totals', 'adjustments', 'transactions'],
  properties: {
    issuer: { type: 'string', description: '帳單抬頭印的發卡機構名，照原文抄（例：遠東國際商業銀行）' },
    lastFour: { type: ['string', 'null'], description: '卡號末四碼（四位數字）；帳單沒印＝null，不要從別處湊' },
    statementMonth: { type: ['string', 'null'], description: '帳單期別，西元 YYYY-MM（民國要換算）；讀不到＝null' },
    totals: {
      type: 'object', additionalProperties: false,
      description: '帳單自己印的摘要金額。**只抄帳單印的數字；帳單沒印該格＝null，絕不自己加總**。一律填正數（負號去掉）',
      required: ['prevDue', 'paidAndRefund', 'newCharges', 'due'],
      properties: {
        prevDue: { type: ['number', 'null'], description: '上期應繳總額；沒印＝null' },
        paidAndRefund: { type: ['number', 'null'], description: '已繳款／退款金額（合計）；沒印＝null' },
        newCharges: { type: ['number', 'null'], description: '本期新增款項（消費明細的合計欄）；沒印＝null' },
        due: { type: ['number', 'null'], description: '本期應繳總額；沒印＝null' },
      },
    },
    adjustments: {
      type: 'array',
      description: '**不在消費明細裡**、但帳單有印名字與金額的調整列（循環利息、違約金、年費、分期攤還本金、'
        + '各種費用…）。這些列**不要**放進 transactions。金額帶正負：計入本期應繳＝正、抵減＝負。'
        + '沒有這種列＝空陣列；**只抄有名字的**，不要發明',
      items: {
        type: 'object', additionalProperties: false,
        required: ['label', 'amount'],
        properties: {
          label: { type: 'string', description: '帳單印的項目名，照原文（例：循環信用利息）' },
          amount: { type: 'number', description: '金額（去千分位）' },
        },
      },
    },
    transactions: {
      type: 'array',
      description: '消費明細逐筆，照帳單順序。**一列一筆，不可合併、不可略過**。'
        + '金額語意：消費＝正、退款與繳款＝負（照帳單的正負號或退款標記）',
      items: {
        type: 'object', additionalProperties: false,
        required: ['date', 'postDate', 'desc', 'amount'],
        properties: {
          date: { type: 'string', description: '消費日，西元 YYYY-MM-DD（民國要換算）' },
          postDate: { type: ['string', 'null'], description: '入帳日，西元 YYYY-MM-DD；帳單沒印＝null' },
          desc: { type: 'string', description: '消費說明／商店名，照帳單原文抄（含外幣資訊可併在後面）' },
          amount: { type: 'number', description: '台幣金額（去千分位；退款為負）' },
        },
      },
    },
  },
};

// ── 提示詞 ──────────────────────────────────────────────────────────────────
export function buildCardSystem() {
  return [
    '你是信用卡帳單的抄寫員。輸入是一份台灣信用卡帳單 PDF 的逐列文字，你的工作是**照抄**成答案卷，不是理解或推論。',
    '',
    '四條鐵則：',
    '1. **只抄不猜**：帳單沒印的欄位一律填 null 或空值；**絕不自己加總、換算或補齊**。',
    '2. **原文照抄**：商店名、機構名、項目名照帳單字面抄（含空格與符號）；不要翻譯、不要改寫。',
    '3. **一列一筆**：消費明細每一列都要出現在 transactions，**不可合併、不可略過**；'
      + '「循環利息／違約金／年費／分期攤還／費用」這類**不在明細區的具名金額列**放 adjustments、不放 transactions。',
    '4. **日期換算**：民國年（例 115/07/03）換成西元（2026-07-03）；換不出來的日期寧可整筆照原文放 desc、不要編日期。',
    '',
    '金額語意：消費＝正；退款、繳款＝負（帳單印負號或「退」「繳」標記時）。金額去千分位。',
    '遮罩與卡號：照帳單原樣抄；lastFour 只在帳單明確印出末四碼時才填。',
  ].join('\n');
}

// ── fail-closed 驗收 ─────────────────────────────────────────────────────────
const str = (/** @type {any} */ v, /** @type {string} */ path, /** @type {number} */ max, must = false) => {
  if (v == null) { if (must) throw apiError(400, `AI 答案卷缺 ${path}`, 'ai_bad_answer'); return ''; }
  if (typeof v !== 'string') throw apiError(400, `AI 答案卷的 ${path} 型別不對`, 'ai_bad_answer');
  const t = v.trim();
  if (t.length > max) throw apiError(400, `AI 答案卷的 ${path} 超長`, 'ai_bad_answer');
  if (must && !t) throw apiError(400, `AI 答案卷的 ${path} 是空的`, 'ai_bad_answer');
  return t;
};
const numOrNull = (/** @type {any} */ v, /** @type {string} */ path) => {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw apiError(400, `AI 答案卷的 ${path} 不是數字`, 'ai_bad_answer');
  if (Math.abs(v) > CARD_LIMITS.amountAbs) throw apiError(400, `AI 答案卷的 ${path} 大得離譜`, 'ai_bad_answer');
  return v;
};

/**
 * AI 答案卷 → 內部形狀（**引擎答案不可信，一律 fail-closed**：欄位缺、型別錯、值離譜＝整份拒收）。
 * ⚠️ 錯誤訊息**不回聲帳單數值**（同銀行線 E3 的機密紀律）。
 * @param {any} raw
 * @returns {{ issuer: string, lastFour: string|null, statementMonth: string|null,
 *             statementTotals: { prevDue: number|null, paidAndRefund: number|null, newCharges: number|null, due: number|null },
 *             adjustments: { label: string, amount: number }[],
 *             transactions: { date: string, postDate: string|null, desc: string, amount: number }[] }}
 */
export function normalizeAiCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw apiError(400, 'AI 沒有交回答案卷（不是物件）', 'ai_bad_answer');
  const issuer = str(raw.issuer, 'issuer', CARD_LIMITS.issuer, true).replace(/\|/g, '');
  if (!issuer) throw apiError(400, 'AI 答案卷的 issuer 只剩非法字元', 'ai_bad_answer');

  let lastFour = null;
  if (raw.lastFour != null) {
    const lf = str(raw.lastFour, 'lastFour', 8, true);
    if (!/^\d{4}$/.test(lf)) throw apiError(400, 'AI 答案卷的 lastFour 不是四位數字', 'ai_bad_answer');
    lastFour = lf;
  }
  let statementMonth = null;
  if (raw.statementMonth != null) {
    const m = str(raw.statementMonth, 'statementMonth', 7, true);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw apiError(400, 'AI 答案卷的 statementMonth 不是 YYYY-MM', 'ai_bad_answer');
    statementMonth = m;
  }

  if (!raw.totals || typeof raw.totals !== 'object' || Array.isArray(raw.totals)) throw apiError(400, 'AI 答案卷缺 totals', 'ai_bad_answer');
  /** @type {any} */ const statementTotals = {};
  for (const f of /** @type {const} */ (['prevDue', 'paidAndRefund', 'newCharges', 'due'])) {
    const v = numOrNull(raw.totals[f], `totals.${f}`);
    // schema 說一律正數；AI 若照帳單抄了負號，取絕對值＝**符號由程式定、不由 AI 定**（同遮罩符號的前例）
    statementTotals[f] = v == null ? null : Math.abs(v);
  }

  if (!Array.isArray(raw.adjustments) || raw.adjustments.length > CARD_LIMITS.adjustments) {
    throw apiError(400, 'AI 答案卷的 adjustments 缺失或筆數異常', 'ai_bad_answer');
  }
  const adjustments = raw.adjustments.map((/** @type {any} */ a, /** @type {number} */ i) => {
    const label = str(a?.label, `adjustments[${i}].label`, CARD_LIMITS.shortStr, true);
    const amount = numOrNull(a?.amount, `adjustments[${i}].amount`);
    if (amount == null || amount === 0) throw apiError(400, `AI 答案卷的 adjustments[${i}].amount 缺失或為零`, 'ai_bad_answer');
    return { label, amount };
  });

  if (!Array.isArray(raw.transactions) || raw.transactions.length > CARD_LIMITS.transactions) {
    throw apiError(400, 'AI 答案卷的 transactions 缺失或筆數異常', 'ai_bad_answer');
  }
  const transactions = raw.transactions.map((/** @type {any} */ t, /** @type {number} */ i) => {
    const date = str(t?.date, `transactions[${i}].date`, 10, true);
    if (!isRealDate(date)) throw apiError(400, `AI 答案卷的 transactions[${i}].date 不是真日期`, 'ai_bad_answer');
    let postDate = null;
    if (t?.postDate != null) {
      const pd = str(t.postDate, `transactions[${i}].postDate`, 10, true);
      if (!isRealDate(pd)) throw apiError(400, `AI 答案卷的 transactions[${i}].postDate 不是真日期`, 'ai_bad_answer');
      postDate = pd;
    }
    // 裁示③：店名走與內建範本**同一支** normalizeDesc——差一個空白就是兩個 stmtRef＝重複入帳
    const desc = normalizeDesc(str(t?.desc, `transactions[${i}].desc`, 200, true));
    if (!desc) throw apiError(400, `AI 答案卷的 transactions[${i}].desc 清完只剩空`, 'ai_bad_answer');
    const amount = numOrNull(t?.amount, `transactions[${i}].amount`);
    if (amount == null || amount === 0) throw apiError(400, `AI 答案卷的 transactions[${i}].amount 缺失或為零`, 'ai_bad_answer');
    return { date, postDate, desc, amount };
  });

  return { issuer, lastFour, statementMonth, statementTotals, adjustments, transactions };
}

// ── 接地檢查（防臆測；手法同銀行線 assertAiBankGrounded，含拆 cell 拼接）────────
/**
 * 答案卷上的每一個金額都必須在帳單原文出現過——抄的才收，算的、猜的不收。
 * ⚠️ 誠實劃界（同銀行線）：這是防禦縱深不是閘、不宣稱窮盡（遮罩片段、獨立年份仍可能誤接地）。
 * @param {ReturnType<typeof normalizeAiCard>} parsed @param {string} text
 */
export function assertAiCardGrounded(parsed, text) {
  const seen = new Set();
  const add = (/** @type {string} */ rawTok) => {
    const n = Number(rawTok.replace(/,/g, ''));
    if (Number.isFinite(n)) { seen.add(n); seen.add(Math.abs(n)); }
  };
  const stripped = String(text || '').normalize('NFKC')
    .replace(/\d{4}-\d{1,2}-\d{1,2}|\d{2,4}\/\d{1,2}\/\d{1,2}/g, ' ');
  /** @type {{ tok: string, start: number, end: number }[]} */ const toks = [];
  for (const m of stripped.matchAll(/-?[\d,]+(?:\.\d+)?/g)) {
    toks.push({ tok: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    add(m[0]);
  }
  for (let i = 0; i + 1 < toks.length; i++) {
    if (/^[^\S\n]+$/.test(stripped.slice(toks[i].end, toks[i + 1].start))) add(toks[i].tok + toks[i + 1].tok);
  }
  const miss = (/** @type {string} */ where) =>
    apiError(400, `AI 答案卷的 ${where} 數字在帳單原文找不到（可能是 AI 臆測或抄錯，也可能是帳單印法特殊）`, 'ai_bad_answer');
  parsed.transactions.forEach((t, i) => { if (!seen.has(t.amount) && !seen.has(Math.abs(t.amount))) throw miss(`transactions[${i}].amount`); });
  parsed.adjustments.forEach((a, i) => { if (!seen.has(a.amount) && !seen.has(Math.abs(a.amount))) throw miss(`adjustments[${i}].amount`); });
  for (const f of /** @type {const} */ (['prevDue', 'paidAndRefund', 'newCharges', 'due'])) {
    const v = parsed.statementTotals[f];
    if (v != null && !seen.has(v)) throw miss(`totals.${f}`);
  }
  if (parsed.lastFour != null && !String(text || '').normalize('NFKC').includes(parsed.lastFour)) throw miss('lastFour');
}

// ── 驗算閘（裁示①的加嚴；**只有 AI 這條路**過這道，內建範本行為不變）───────────
/**
 * 兩道閘，全紅才收：
 *   G1 等式閘：上期應繳 −已繳/退款 ＋本期新增 ＋Σ具名調整 ≈ 本期應繳
 *   G2 加總閘：Σ消費明細 ≈ 本期新增款項（具名調整**不在**明細裡，所以不參與這一道）
 * ⚠️ 四格摘要有任何一格 null ＝ **驗算不了 ＝ 不收**（加嚴的定義；★6 不放寬——
 *    實測使用者的遠銀帳單每期都印完整等式行，這個要求在目標版面上是可達的）。
 * ⚠️ 訊息帶「差額」與筆數、**不帶帳單的原始金額**（機密紀律與裁示②「說明差多少」的折衷：
 *    差額是衍生值、單獨一個差額回推不出帳單內容；A/B 原值仍不回聲）。
 * @param {ReturnType<typeof normalizeAiCard>} parsed
 */
export function reconcileAiCard(parsed) {
  const t = parsed.statementTotals;
  const missing = (/** @type {const} */ (['prevDue', 'paidAndRefund', 'newCharges', 'due'])).filter((f) => t[f] == null);
  if (missing.length) {
    throw apiError(400,
      'AI 讀出了明細，但帳單的摘要金額（上期應繳／已繳款／本期新增／本期應繳）有讀不到的格子——'
      + '沒有這些數字就驗算不了，照規矩不收。可能是帳單印法特殊，請改用手動記帳。', 'ai_reconcile_failed');
  }
  const adjSum = parsed.adjustments.reduce((s, a) => s + a.amount, 0);
  const g1 = /** @type {number} */ (t.prevDue) - /** @type {number} */ (t.paidAndRefund)
    + /** @type {number} */ (t.newCharges) + adjSum - /** @type {number} */ (t.due);
  if (Math.abs(g1) > CARD_TOLERANCE) {
    throw apiError(400,
      `帳單的應繳等式對不上（上期應繳 −已繳退款 ＋本期新增 ＋具名調整 與 本期應繳 差了 ${Math.abs(Math.round(g1))} 元，`
      + '找不到對應的具名項目）。為了不把沒驗算過的數字記進帳本，這一份不收；請改用手動記帳。', 'ai_reconcile_failed');
  }
  const txSum = parsed.transactions.reduce((s, x) => s + x.amount, 0);
  const g2 = txSum - /** @type {number} */ (t.newCharges);
  if (Math.abs(g2) > CARD_TOLERANCE) {
    throw apiError(400,
      `逐筆加總與帳單的「本期新增款項」對不上（${parsed.transactions.length} 筆加起來差了 ${Math.abs(Math.round(g2))} 元，`
      + '差額沒有任何具名項目可以解釋——可能有漏抄、多抄或金額抄錯）。'
      + '為了不把沒驗算過的數字記進帳本，這一份不收；請改用手動記帳。', 'ai_reconcile_failed');
  }
}
