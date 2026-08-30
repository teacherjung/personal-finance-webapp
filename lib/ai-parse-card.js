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
//    `adjustments`，驗算時①等式閘：上期 −已繳 ＋新增 ＋Σ具名 ＝ 應繳（容差 0＝2026-08-30 裁示①）
//    ②加總閘＝A/B 兩種退款印法的**慣例閘**（2026-08-30 裁示③；公式見 reconcileAiCard）。
//    差額**沒有名字**才擋。實測他 5 份遠銀帳單全部印了完整等式行 ⇒ 這條路走得通、★6 不必放寬。
// 2. **先單讀**（不開雙讀）：Sonnet 先讀一發，壞答案或閘紅升 Opus 補一發＝**每份最多兩發**
//    （成本護欄的 take() 由 transport 統一執行；階梯迴圈在 statement-import.js 的 aiCardRoute）。
// 3. **店名跑 `normalizeDesc`**（與內建範本同口徑）：AI 兩次讀同一份差一個空白就變兩筆＝重複入帳。
//
// ## 與 #518 機構身分判準的關係
//
// AI 抄回的發卡機構名（`issuer`）**只當顯示資訊**，不參與自動歸卡——歸卡仍走 card-identity 的
// 判準（AI 讀的版面本來就是我們認不得的家，`issuerBank()` 幾乎必然回 `''` ⇒ 分支④手選＋警語）。
// 這是刻意的：AI 的一句話不該拿到「錢記到哪張卡」的投票權。

import { isRealDate } from './schema.js';
import { isCardPayment, normalizeDesc } from './statement.js';

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

/** 具名差額與逐筆加總允許的誤差（元）：**0＝分毫不差**（William 2026-08-30 裁示，取代首版的 1）
 * ——帳單自己是自洽的：印出來的整數相加必然全等，留 1 元＝恰差 1 元的漏抄/多抄看不到（Grok 掃#1）。 */
export const CARD_TOLERANCE = 0;

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
      description: '帳單自己印的摘要金額。**只抄帳單印的數字，含正負號照帳單印的抄；帳單沒印該格＝null，絕不自己加總**',
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
        required: ['label', 'amount', 'date'],
        properties: {
          label: { type: 'string', description: '帳單印的項目名，照原文（例：循環信用利息）' },
          amount: { type: 'number', description: '金額（去千分位）' },
          date: { type: ['string', 'null'], description: '該列印的日期，西元 YYYY-MM-DD（民國要換算）；帳單沒印＝null' },
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
    '3. **一列一筆**：消費明細每一列都要出現在 transactions，**不可合併、不可略過**——'
      + '兩筆金額恰好互相抵銷（例如 +100 與 -100）也**都要抄**，漏抄它們加總是看不出來的；'
      + '「循環利息／違約金／年費／分期攤還／費用」這類**不在明細區的具名金額列**放 adjustments、不放 transactions。',
    '4. **日期換算**：民國年（例 115/07/03）換成西元（2026-07-03）；換不出來的日期寧可整筆照原文放 desc、不要編日期。',
    '',
    '金額語意：消費＝正；退款、繳款＝負（帳單印負號或「退」「繳」標記時）。摘要金額（totals）照帳單印的正負號抄。金額去千分位。',
    '負數列的說明文字要一字不差照抄——**不要把退款寫成繳款**（也不要反過來）：這兩種字樣決定那筆錢要不要入帳，抄錯字樣＝退款會被當成繳款漏掉。',
    '遮罩與卡號：照帳單原樣抄；lastFour 只在帳單明確印出末四碼時才填。',
    'adjustments 的列若印有日期也照抄（民國換算）；沒印＝null。',
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
 *             adjustments: { label: string, amount: number, date: string|null }[],
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
    // 符號紀律（Codex r1#2）：只有 paidAndRefund 取絕對值——等式自帶減號、它語意上是「繳掉多少」的
    //   量值，各行帳單印正印負都有。其餘三格**保留帳單的正負號**：退款期的本期新增／應繳可以是負數
    //  （溢繳、退款大於消費），全取絕對值會把方向反轉成消費、而且等式還照樣平（r1 實測重現）。
    statementTotals[f] = v == null ? null : (f === 'paidAndRefund' ? Math.abs(v) : v);
  }

  if (!Array.isArray(raw.adjustments) || raw.adjustments.length > CARD_LIMITS.adjustments) {
    throw apiError(400, 'AI 答案卷的 adjustments 缺失或筆數異常', 'ai_bad_answer');
  }
  const adjustments = raw.adjustments.map((/** @type {any} */ a, /** @type {number} */ i) => {
    // label 走 normalizeDesc（r3#1；同裁示③店名的理由）：它會變成交易說明與 stmtRef——
    // 「循環信用利息」與「循 環 信 用 利 息」若算兩個字串，同一筆利息會重複記帳。
    const label = normalizeDesc(str(a?.label, `adjustments[${i}].label`, CARD_LIMITS.shortStr, true));
    if (!label) throw apiError(400, `AI 答案卷的 adjustments[${i}].label 清完只剩空`, 'ai_bad_answer');
    const amount = numOrNull(a?.amount, `adjustments[${i}].amount`);
    if (amount == null || amount === 0) throw apiError(400, `AI 答案卷的 adjustments[${i}].amount 缺失或為零`, 'ai_bad_answer');
    // date（裁示②2026-08-30＝調整項要記帳）：有印就照抄；記帳日期鏈的第一環（後備＝帳單期別→最新明細日）
    let date = null;
    if (a?.date != null) {
      const d = str(a.date, `adjustments[${i}].date`, 10, true);
      if (!isRealDate(d)) throw apiError(400, `AI 答案卷的 adjustments[${i}].date 不是真日期`, 'ai_bad_answer');
      date = d;
    }
    return { label, amount, date };
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
 *
 * 比銀行線多一層（Codex r1#1）：**多重集消耗**，不是「全文出現過就好」。銀行線有帳戶餘額鏈當
 * 結構錨、卡片沒有——若只查存在，AI 可以把整份明細縮成一筆虛構列、金額直接借摘要「本期新增」
 * 那個數（它必然印在帳單上），等式與加總照樣全平。改成消耗制之後，摘要與具名調整**先占用**
 * 自己的出現位置，明細不可以借它們的數字——縮成一筆的那型會因為位置已被占而擋下。
 * 符號一併嚴格（Codex r1#2）：帶正負號逐值比對、不做絕對值後備（同銀行線交易金額的先例）；
 * 唯一例外＝paidAndRefund（normalize 已取絕對值），准配帳單印的正負任一形。
 *
 * ⚠️ 誠實劃界（同銀行線）：這是防禦縱深不是閘、不宣稱窮盡（r7#2：誤收與誤擋分開列，
 * 不再籠統寫「其餘皆 fail-closed」）。
 * **誤收型（fail-open）已知盲點**——徽章就地向使用者揭露（同銀行線盲點清單的處理）：
 * ①兩筆正負恰好抵銷的交易一起漏抄（+100 與 −100）＝加總不變、等式照平、接地只驗「有交回的」
 *   （加總制驗算的固有極限——我們不知道原文哪些行是明細行，正是要 AI 讀的原因；提示詞明令要抄）
 * ②日期與店名刻意不接地（民國→西元轉換後字面必然不同）＝金額全對、辨識欄讀錯的答案擋不到
 * ③同一個數字在帳單多處印過時可能互借（含借用沒被認領的他處數字）——要恰好仍過兩道閘才走得通
 * ④負數列是繳款還是退款，靠 AI 抄回的 desc 字樣判定（desc 不接地；r8#1）——2026-08-30 裁示後
 *   AI 路已把列對總額升級成**慣例閘**（statement-reconcile.js：A＝退款折進本期新增／B＝退款進
 *   已繳退款桶，擇一全對才收），跨桶的抄錯（退款被抄成繳款、而退款原屬本期新增）從此擋得住；
 *   **殘餘盲點＝桶內互抄**——繳款與退款同住「已繳款＋退款」一個合計桶的印法（慣例 B），
 *   桶內身分對調不改變任何合計、算術上分不出（徽章照實揭露）

 * **誤擋型（fail-closed，寧擋勿收；代價＝升級再讀、仍不行請使用者手動記帳）**：
 * 尾綴負號／括號負數這類印法會被讀成正數、配不上帶負號的宣稱；金額被拆進**三個以上** cell
 * （1,234,│567,│890）只做相鄰兩兩拼接＝接不回來；拆開的兩段**都能獨立成數**（123,│456）
 * ＝當句讀讀、也接不回來（r5#2：不然「100， 200」會憑空拼出 100200 的誤收路）；
 * 末四碼恰等於某金額、帳單又另印含末四碼的長數字串（完整卡號／對帳單編號）時**兩處各占一格**
 * ＝可能誤擋（r5#1：只占一處分不出誰是卡號）；貪婪配位理論上可能比完美配對多擋。
 * @param {ReturnType<typeof normalizeAiCard>} parsed @param {string} text
 */
export function assertAiCardGrounded(parsed, text) {
  // 句讀逗號在 **NFKC 之前**先換成空白（r6#2／r7#1）：NFKC 會把全形逗號（，）折成 ASCII 逗號，
  // 「100，200」（無空白的句讀）就變成合法千分位 token「100,200」＝憑空登記帳單沒印過的
  // 100200。真的千分位分隔一律印 ASCII 逗號——所以不變量寫成通則：**任何非 ASCII、NFKC 後
  // 是逗號的字元都是句讀**（r7#1：列舉字元表會漏 U+FE10／U+FE50 這類同樣折成逗號的親戚）。
  const stripped = String(text || '')
    .replace(/[\u{80}-\u{10FFFF}]/gu, (c) => (c.normalize('NFKC') === ',' ? ' ' : c))
    .normalize('NFKC')
    .replace(/\d{4}-\d{1,2}-\d{1,2}|\d{2,4}\/\d{1,2}\/\d{1,2}/g, ' ');
  /** @type {{ tok: string, start: number, end: number }[]} */ const toks = [];
  for (const m of stripped.matchAll(/-?[\d,]+(?:\.\d+)?/g)) {
    toks.push({ tok: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  // 值 → 可用的「實體位置組」清單。單 token＝一組一格；拆 cell 拼接＝一組**兩格**（共用組成
  // token 的位置——Codex r2#1：拼接若「額外加入」而不共用位置，摘要列相鄰的 `0 100` 會憑空拼出
  // 第三個 100，明細借它＝r1 的縮筆／幻覺又可達。占用一組＝整組位置一起占，不留免費籌碼）。
  //
  // token 形狀紀律（Codex r3#1／r3#3）：
  // ① **殘片不得登記為獨立金額**——「1,」（尾逗號）、「000」（前導零）是拆格的碎片、不是帳單印的
  //   數字；登記它們＝真交易「1, 000」可被 AI 拆開交回 1＋2 兩筆假明細，接地與兩道閘照樣全綠。
  // ② **拼接只認斷在千分位逗號的形**（前 token 尾逗號或後 token 頭逗號，且拼完是合法數字長相）
  //   ——這是實際觀測到的拆格形（1,234,│567）；不設限的話相鄰兩個普通數字「1 2」會拼出帳單沒印
  //   過的 12。附帶效果：殘片只活在拼接組裡＝別的宣稱偷不走它們，r3#3 的貪婪干擾場景隨之瓦解。
  const WELL_FORMED = /^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/;
  /** @type {Map<number, number[][]>} */ const entries = new Map();
  const addEntry = (/** @type {string} */ rawTok, /** @type {number[]} */ positions) => {
    const n = Number(rawTok.replace(/,/g, ''));
    if (!Number.isFinite(n)) return;
    const list = entries.get(n) || [];
    list.push(positions);
    entries.set(n, list);
  };
  // 先登記拼接、記下參與者——組成 token **一律**不得再獨立登記（r4#1：前逗號拆格「1 ,000」的
  // 頭段「1」自己是合法形，只靠形狀篩擋不住；它是碎片的證據＝夥伴帶著邊界逗號）。
  // r5#2 再收緊：**兩段剝掉邊界逗號後都能獨立成數＝當句讀讀、不拼**——NFKC 把全形句讀逗號
  // 折成半形，「100， 200」跟拆格「1,│000」同形；拼下去會憑空登記帳單沒印過的 100200（誤收），
  // 不拼的代價＝六位數以上被拆成「123,│456」這型接不回來（誤擋、升級→手動）。寧擋勿收。
  const trimComma = (/** @type {string} */ s) => s.replace(/^,+|,+$/g, '');
  /** @type {Set<number>} */ const spliced = new Set();
  for (let i = 0; i + 1 < toks.length; i++) {
    if (!/^[^\S\n]+$/.test(stripped.slice(toks[i].end, toks[i + 1].start))) continue;
    const combined = toks[i].tok + toks[i + 1].tok;
    if (!(toks[i].tok.endsWith(',') || toks[i + 1].tok.startsWith(',')) || !WELL_FORMED.test(combined)) continue;
    const tl = trimComma(toks[i].tok), tr = trimComma(toks[i + 1].tok);
    if (tl && WELL_FORMED.test(tl) && tr && WELL_FORMED.test(tr)) continue;   // 句讀讀法成立＝不拼
    addEntry(combined, [i, i + 1]);
    spliced.add(i); spliced.add(i + 1);
  }
  toks.forEach((t, i) => {
    if (spliced.has(i)) return;   // 拆格組成 token＝碎片，只活在拼接組裡
    if (WELL_FORMED.test(t.tok)) { addEntry(t.tok, [i]); return; }
    // r4#3：全形句讀逗號（，）被 NFKC 折成半形黏在數字上——「100，」token 化成「100,」。
    // 沒參與拼接的 token 剝頭尾逗號再驗一次形（剝完仍壞形＝真碎片，照樣不登記）。
    const trimmed = trimComma(t.tok);
    if (trimmed && WELL_FORMED.test(trimmed)) addEntry(trimmed, [i]);
  });
  /** @type {Set<number>} */ const used = new Set();
  // 貪婪配位：偏好占位少的（先用單 token、把拼接組留給真的被拆開的金額）。理論上貪婪可能在
  // 極端同額版面比完美配對多擋——方向是 fail-closed（寧擋勿收），與本檔其餘取捨一致。
  const take = (/** @type {number} */ v) => {
    const list = entries.get(v) || [];
    for (const pos of [...list].sort((a, b) => a.length - b.length)) {
      if (pos.every((p) => !used.has(p))) {
        pos.forEach((p) => used.add(p));
        return true;
      }
    }
    return false;
  };
  const miss = (/** @type {string} */ where) =>
    apiError(400, `AI 答案卷的 ${where} 數字在帳單原文找不到（可能是 AI 臆測或抄錯，也可能是帳單印法特殊）`, 'ai_bad_answer');
  // lastFour **先占位**（Codex r3#2）：卡號不是金額，但它的 token 長得像金額——不占位的話，
  // 末四碼恰等於某格摘要時，虛構明細可以借卡號那格當「金額位置」。
  // 候選（r4#2）：**只認不含逗號的 token**——卡號從不印千分位，「91,234」是金額、剝掉逗號才含
  //   1234 純屬巧合，讓它入選＝占錯位、把真卡號 token 留給虛構明細借。
  // 占法（r5#1 改「每型各占一格」）：「大到不可能是金額」的長數字串（完整卡號＝占它零成本，
  //   但**對帳單編號也長這樣**、分不出誰是卡號）與「末四碼」本人**都在場就各占一格**——
  //   只占長的那型＝真卡號 token 留給虛構明細借（r5 反例）；占多不占少＝fail-closed，
  //   代價寫在檔頭劃界。兩型都不在＝占最長的其餘候選；一個都沒有＝接不了地，照樣 miss。
  if (parsed.lastFour != null) {
    const lf = parsed.lastFour;
    const cands = toks
      .map((t, i) => ({ i, raw: t.tok }))
      .filter((c) => !c.raw.includes(',') && c.raw.includes(lf) && !used.has(c.i));
    const huge = cands.find((c) => { const v = Math.abs(Number(c.raw)); return Number.isFinite(v) && v > CARD_LIMITS.amountAbs; });
    const exact = cands.find((c) => c.raw === lf);
    if (huge) used.add(huge.i);
    if (exact) used.add(exact.i);
    if (!huge && !exact) {
      const other = cands.sort((a, b) => b.raw.length - a.raw.length)[0];
      if (!other) throw miss('lastFour');
      used.add(other.i);
    }
  }
  // 消耗順序＝摘要→具名調整→明細：讓「明細借摘要的數字」沒得借（順序反過來這層就失效）
  for (const f of /** @type {const} */ (['prevDue', 'newCharges', 'due'])) {
    const v = parsed.statementTotals[f];
    if (v != null && !take(v)) throw miss(`totals.${f}`);
  }
  {
    const v = parsed.statementTotals.paidAndRefund;
    if (v != null && !take(v) && !take(-v)) throw miss('totals.paidAndRefund');
  }
  parsed.adjustments.forEach((a, i) => { if (!take(a.amount)) throw miss(`adjustments[${i}].amount`); });
  parsed.transactions.forEach((t, i) => { if (!take(t.amount)) throw miss(`transactions[${i}].amount`); });
}

// ── 驗算閘（裁示①的加嚴；**只有 AI 這條路**過這道，內建範本行為不變）───────────
/**
 * 兩道閘，**全綠才收**（任何一道紅＝整份擋）：
 *   G1 等式閘：上期應繳 −已繳/退款 ＋本期新增 ＋Σ具名調整 ＝ 本期應繳（容差 0）
 *   G2 加總閘＝**兩種帳單慣例擇一全對**（William 2026-08-30 裁示③的落地；單一公式會誤擋真帳單）：
 *     慣例 A（遠銀式）：退款折進「本期新增」——Σ(消費−退款) ＝ 本期新增，且 Σ繳款 ＝ 已繳款退款桶
 *     慣例 B：退款進「已繳款＋退款」桶——Σ消費 ＝ 本期新增，且 Σ繳款＋Σ退款 ＝ 已繳款退款桶
 *   （具名調整**不在**明細裡，兩種慣例都不參與 G2）
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
  // 繳款判準＝模板路 finalize 與中閘的同一把尺（amount<0 && isCardPayment(desc)），不另發明第二種。
  // 慣例閘（裁示③）：退款有的銀行折進「本期新增」（A＝遠銀式）、有的放「已繳款＋退款」桶（B）——
  // 兩種各自全對才收其一。擋得住＝退款被抄成繳款（A 慣例，消費和立刻不平）與金額對不齊的亂抄；
  // 擋不住＝繳款被抄成退款、金額恰等於桶（B 全等照樣成立）——完整劃界見下方與檔頭。
  // ⚠️ 誠實劃界：**桶內互抄分不出**（慣例 B 的繳款與退款同住一個合計桶，對調不改變任何合計）。
  let sumPos = 0, refundAbs = 0, payAbs = 0, n = 0;
  for (const x of parsed.transactions) {
    n += 1;
    if (x.amount > 0) { sumPos += x.amount; continue; }
    if (isCardPayment(x.desc)) payAbs += -x.amount; else refundAbs += -x.amount;
  }
  const nc = /** @type {number} */ (t.newCharges), pr = /** @type {number} */ (t.paidAndRefund);
  // 繳款列**缺席**是常見合法印法（繳款只列在摘要、明細不重印——原影子檢查③的訊息自己就寫了）：
  // A 式在 payAbs===0 時繳款那半不驗。B 式**一律要求全等**（r1#1：改成 refundAbs<=桶 的不等式，
  // 整筆繳款被抄成退款、金額又恰等於桶時會被放行）——代價＝「桶裡有沒列出來的繳款＋有列出來的
  // 退款」這種混桶印法會被誤擋（fail-closed，升級→手動）。
  // ⚠️ 誠實劃界（r1#1 改口）：**繳款被抄成退款、金額恰等於「已繳款退款」桶＝算術上與真退款
  // 不可區分**（B 的全等式照樣成立）——這型擋不住，靠就地提醒＋使用者核對（徽章與 advisory）。
  // 擋得住的＝退款被抄成繳款（A 式的消費和立刻不平）與金額對不齊的其他亂抄。
  const eq = (/** @type {number} */ x, /** @type {number} */ y) => Math.abs(x - y) <= CARD_TOLERANCE;
  const convA = eq(sumPos - refundAbs, nc) && (payAbs === 0 || eq(payAbs, pr));
  const convB = eq(sumPos, nc) && eq(payAbs + refundAbs, pr);
  if (!convA && !convB) {
    // 訊息報**兩式各自的分量**（r8#3：只報消費和那半，繳款桶差 1 時會印「差 0 元／差 0 元」）；
    // 該側**沒有任何列**時不報那個分量——0 減整格摘要＝把原值當「差額」回聲出去（機密紀律）。
    const gA1 = Math.abs(Math.round((sumPos - refundAbs) - nc));
    const gB1 = Math.abs(Math.round(sumPos - nc));
    const aPay = payAbs > 0 ? `、繳款差 ${Math.abs(Math.round(payAbs - pr))} 元` : '';
    const bPay = (payAbs > 0 || refundAbs > 0) ? `、桶差 ${Math.abs(Math.round((payAbs + refundAbs) - pr))} 元` : '';
    throw apiError(400,
      `逐筆加總與帳單的摘要對不上（${n} 筆，兩種常見印法都試過：退款折進「本期新增」時消費和差 ${gA1} 元${aPay}；`
      + `退款算進「已繳款退款」桶時消費和差 ${gB1} 元${bPay}）——可能有漏抄、多抄、金額抄錯，或繳款退款的字樣抄錯。`
      + '為了不把沒驗算過的數字記進帳本，這一份不收；請改用手動記帳。', 'ai_reconcile_failed');
  }
}
