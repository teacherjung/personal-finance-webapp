// @ts-check
// AI 解析引擎（P1b-1，解析器通用化 §二「會計師」）：把「帳單抽出的文字」交給 AI，照固定答案卷
// （AI_BANK_SCHEMA）填成與模板解析器**同形狀**的 ParsedBankFull——下游（P1a 機構維度、對帳閘、
// 預覽、匯入）一行不改就接得上。
//
// 三條硬規矩（拍板依據見 docs/parser-generalization-plan.md）：
// 1. **答案不可信、逐欄驗收（normalizeAiBank fail-closed）**：AI 回的每一欄都過型別／日期／金額／
//    方向／長度／筆數牆，任何一欄壞＝整份丟 `ai_bad_answer`（寧可不吃）。驗收過了也只是「形狀對」，
//    **數字對不對由對帳閘裁決**（服務層接線，★6：AI 路線必須過強閘才准匯入）。
// 2. **供應商是接縫不是信仰（★3 拍板 2026-08-12＝Anthropic）**：本檔是**純模組（零外連能力）**——
//    答案卷 schema／提示詞／驗收器／文字組裝。真正打 API 的 fetch 住 lib/ai-transport.js（唯一外連檔、
//    入外連登記閘），由路由層組成 engineFactory 注入服務層；**本檔與服務層都拿不到 fetch**＝外連能力
//    不沿 import 閉包傳染到 crud.js 等動態路徑路由檔（hosted-auth 反向對帳閘的要求）。考題全走假引擎。
// 3. **機密流向**：鑰匙與帳單內文**絕不落 log**（本模組零 console；考題用 console spy 釘住）；
//    內文不進錯誤訊息（錯誤只帶分類 code 與白話說明）。
import { accountSuffix } from './bank-statement.js';
import { isRealDate } from './schema.js';
import { RECIPE_FORMAT_VERSION, RECIPE_DATE_FORMATS, RECIPE_REFDATE_STRATEGIES, RECIPE_BALANCE_PICKS, RECIPE_ROW_IDENTS, RECIPE_LIMITS } from './parse-recipe.js';

const apiError = (/** @type {number} */ status, /** @type {string} */ msg, /** @type {string=} */ code) =>
  Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });

/** 模型階梯（★3 拍板＝Anthropic；**裁示⑥ 2026-08-15**：解析預設 Sonnet、閘紅升 Opus 重試一次、
 * Haiku 退出解析路徑——帳單解析的錯是「安靜的錢錯」、省小錢冒大險不划算。階梯由服務層走，本模組單發。
 * 「寫配方一律用 Opus」的落點在 P2-3 配方生成（配方錯誤會被免費複製到未來每一期）。 */
export const AI_BANK_MODELS = { primary: 'claude-sonnet-5', escalation: 'claude-opus-5' };

/** 寫配方一律 Opus（裁示⑥ 2026-08-15）：配方錯誤會被免費複製到未來每一期——生成品質不省小錢。 */
export const RECIPE_MODEL = 'claude-opus-5';

/** 三讀仲裁模型（裁示⑦ 2026-08-16 拍板）：雙讀不一致時由 Fable 獨立解第三份——不看前兩份答案
 * （「送給 Fable 讀看看」的拍板語意、也避免錨定）。 */
export const AI_ARBITER_MODEL = 'claude-fable-5';

/** 雙讀開關判準（裁示⑦b＝預設開）：**只有明確 false 才關**——讀不到／壞型別＝開。
 * fail 的方向刻意與 aiAskBeforeSend 相反：那顆壞值→「當成要問」是少送、這顆壞值→「當成要雙讀」
 * 是多驗證（代價只是多一發費用，換到的是金額欄位的獨立核對）。
 * @param {any} settings */
export function dualReadWanted(settings) { return settings?.aiDualRead !== false; }

/** 雙讀比對（裁示⑦；**P2-4b 校準＝William 2026-08-17 裁示「移出機構名＋備註」**——真帳單第一份
 * 就實測到：錢欄位兩讀全同、分歧全在文字欄的**寫法差異**（「台新銀行」vs 全名、備註措辭），照舊
 * 觸發仲裁＝白等 Fable 五分鐘再被 ai_disagree 擋＝不可用）。
 * **hard（觸發仲裁/擋下）**＝金額／方向／日期／餘額／帳號**末碼**／幣別／摘要（去重鍵主力、照舊
 * 空白不敏感）／現值參考日／帳戶幣別表／帳戶錢組成（**末碼＋幣別＋餘額**——帳號「印法」兩模型本來
 * 就會不同（含不含前綴、分隔符），末碼才是穩定身分；印法差異降到 textVariance）／交易筆數與順序。
 * **textVariance（建議面：不觸發、徽章 ✏️ 句顯示**實際中選模型**——一致路固定 Opus、仲裁/互證路可能是 Sonnet）**＝機構名／交易備註／帳號印法
 * （masked 全字）。⚠️ 備註仍進 bankRef 去重鍵——重複入帳的風險由「疑似重複提醒」層接住（裁示時
 * 明講的取捨）。diffs 與 textVariance 都**只帶欄位路徑、絕不帶欄值**（機密紀律，同 recipeReproduces）。
 * 帳戶 label／note 照舊完全不比。transactions 嚴格比順序。
 * @param {any} a @param {any} b
 * @returns {{agree: boolean, diffs: string[], textVariance: string[]}} */
export function aiAnswersAgree(a, b) {
  /** @type {string[]} */ const diffs = [];
  /** @type {string[]} */ const textVariance = [];
  const soft = (/** @type {any} */ x, /** @type {any} */ y) => x === y || (typeof x === 'string' && typeof y === 'string' && x.replace(/\s+/g, '') === y.replace(/\s+/g, ''));
  if (!soft(a?.bank, b?.bank)) textVariance.push('機構名');   // P2-4b：寫法差異不觸發（W 裁示）；空白差異連建議都不算（r1#1）
  if (a?.referenceDate !== b?.referenceDate) diffs.push('現值參考日');
  // ⚠️ 末碼碰撞＝退回嚴格鍵（Grok G1/G2/G3：兩帳戶**同末碼**時，只比末碼會讓幣別/餘額「歸屬對調」
  // 全綠——罕見情境寧嚴勿鬆；無碰撞的常見路照裁示走末碼身分、印法差異不誤觸發）。
  // r3#1：末碼一律走單一真相 accountSuffix()（支援三碼末碼 900200****363→'363'——另寫 slice(-4)
  // 會得 '*363'≠交易的 '363'＝碰撞漏偵測、三碼戶的歸屬對調靜默全綠）。
  const suf = (/** @type {any} */ k) => accountSuffix(String(k ?? '').replace(/\s+/g, ''));
  const ca = a?.accountCurrency || {}, cb = b?.accountCurrency || {};
  const accsA = Array.isArray(a?.accounts) ? a.accounts : [], accsB = Array.isArray(b?.accounts) ? b.accounts : [];
  // 碰撞＝**單份答案內**同末碼出現超過一次（跨份加總會把正常帳戶也算成碰撞——考題實抓）。
  const collideIn = (/** @type {string[]} */ keys) => {
    const c = new Map();
    for (const k of keys) c.set(k, (c.get(k) || 0) + 1);
    return [...c.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  };
  const collide = new Set([
    ...collideIn(Object.keys(ca).map(suf)), ...collideIn(Object.keys(cb).map(suf)),
    ...collideIn(accsA.map((/** @type {any} */ x) => String(x?.suffix ?? ''))), ...collideIn(accsB.map((/** @type {any} */ x) => String(x?.suffix ?? ''))),
  ]);
  const curKey = (/** @type {string} */ k, /** @type {string} */ v) => (collide.has(suf(k)) ? `${String(k).replace(/\s+/g, '')}\u0000${v}` : `${suf(k)}\u0000${v}`);
  const sa = Object.entries(ca).map(([k, v]) => curKey(k, /** @type {string} */ (v))).sort();
  const sb = Object.entries(cb).map(([k, v]) => curKey(k, /** @type {string} */ (v))).sort();
  if (sa.length !== sb.length || sa.some((k, i) => k !== sb[i])) diffs.push('帳戶幣別表');
  else if (JSON.stringify(Object.keys(ca).sort()) !== JSON.stringify(Object.keys(cb).sort())) textVariance.push('帳號印法');
  const accMoney = (/** @type {any} */ x) => [collide.has(String(x?.suffix ?? '')) ? String(x?.masked ?? '').replace(/\s+/g, '') : '', x?.suffix, x?.currency, x?.balance].join('\u0000');
  const A = accsA.map(accMoney).sort(), B = accsB.map(accMoney).sort();
  if (A.length !== B.length || A.some((k, i) => k !== B[i])) diffs.push('帳戶餘額組成');
  else if (JSON.stringify(accsA.map((/** @type {any} */ x) => x?.masked).sort()) !== JSON.stringify(accsB.map((/** @type {any} */ x) => x?.masked).sort()) && !textVariance.includes('帳號印法')) textVariance.push('帳號印法');
  const ta = Array.isArray(a?.transactions) ? a.transactions : [], tb = Array.isArray(b?.transactions) ? b.transactions : [];
  if (ta.length !== tb.length) diffs.push('交易筆數');
  else ta.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
    const f = tb[i];
    for (const [name, label, softly] of /** @type {[string,string,boolean][]} */ ([
      ['date', '日期', false], ['direction', '方向', false], ['amount', '金額', false], ['balance', '餘額', false],
      ['acctSuffix', '帳號末碼', false], ['summary', '摘要', true],
    ])) {
      if (!(softly ? soft(e?.[name], f?.[name]) : e?.[name] === f?.[name])) diffs.push(`第 ${i + 1} 筆交易的${label}`);
    }
    if (collide.has(String(e?.acctSuffix ?? '')) && !soft(e?.acctMasked, f?.acctMasked)) diffs.push(`第 ${i + 1} 筆交易的帳號`);   // 碰撞時逐筆歸屬回 hard（G3）
    else if (!soft(e?.acctMasked, f?.acctMasked) && e?.acctSuffix === f?.acctSuffix) { if (!textVariance.includes('帳號印法')) textVariance.push('帳號印法'); }
    if (!soft(e?.note, f?.note)) textVariance.push(`第 ${i + 1} 筆交易的備註`);
  });
  return { agree: diffs.length === 0, diffs, textVariance };
}

/** 不一致欄位清單→白話短句（標紅落地＝錯誤訊息列**欄位**；值一律不回聲）。 */
export function aiDiffSummary(/** @type {string[]} */ diffs) {
  const list = [...new Set(diffs)];
  return list.slice(0, 6).join('、') + (list.length > 6 ? `⋯等 ${list.length} 處` : '');
}

/** 筆數與長度牆（防 AI 幻覺灌爆 db；正常對帳單遠低於此）。 */
const LIMITS = { accounts: 200, transactions: 5000, shortStr: 80, longStr: 500, bank: 20, masked: 40 };

/** 固定答案卷（結構化輸出 schema）：欄位語意對齊 lib/bank-statement.js 的 ParsedBankFull。 */
export const AI_BANK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bank', 'referenceDate', 'accountCurrencies', 'accounts', 'totals', 'transactions'],
  properties: {
    bank: { type: 'string', description: '開戶機構短名（例：台新、國泰世華、玉山）；帳單上印的銀行名' },
    referenceDate: { type: ['string', 'null'], description: '帳戶餘額的現值參考日（餘額算到哪一天），西元 YYYY-MM-DD。'
      + '帳單沒印這個欄位、但有**唯一一個**明確標示為整份帳單期間的區間時，填該區間的結束日；'
      + '有多個區間、區間不是在講整份帳單、或無法確定它就是餘額截止日＝一律 null（寧可不填也不要填錯）' },
    accountCurrencies: {
      type: 'array',
      description: '概要區**每一個**帳戶的幣別身分——含餘額欄空白（透支/負餘額）的帳戶也要列。這張表是幣別的權威來源',
      items: {
        type: 'object', additionalProperties: false,
        required: ['masked', 'currency'],
        properties: {
          masked: { type: 'string', description: '遮罩帳號，照帳單原樣' },
          currency: { type: 'string', description: 'ISO 幣別碼（TWD/USD/JPY…）' },
        },
      },
    },
    accounts: {
      type: 'array',
      description: '概要區的帳戶清單（餘額欄空白的帳戶不要列）',
      items: {
        type: 'object', additionalProperties: false,
        required: ['masked', 'balance', 'currency'],
        properties: {
          masked: { type: 'string', description: '遮罩帳號，照帳單原樣（如 900100****3301）' },
          balance: { type: 'number', description: '帳戶餘額；外幣帳戶填原幣金額、不要換算' },
          currency: { type: 'string', description: 'ISO 幣別碼（TWD/USD/JPY…）' },
          label: { type: 'string', description: '帳戶類別名（如 新臺幣活存）；沒有＝空字串' },
          note: { type: 'string', description: '備註（如 Richart）；沒有＝空字串' },
        },
      },
    },
    totals: {
      type: 'object', additionalProperties: false,
      description: '帳單自己印的合計欄（裁示⑧：給對帳閘交叉驗證、兼補「每帳戶第一筆驗不到」盲區）。'
        + '只抄帳單印的數字；帳單沒印該項＝null，**絕不自己加總**。'
        + '一律填正數（帳單把支出合計印成負號＝去號）。'
        + '帳單同時有台幣與外幣帳戶、而合計欄涵蓋範圍不明（整份？台幣段？）＝三欄一律填 null',
      required: ['txCount', 'totalOut', 'totalIn'],
      properties: {
        txCount: { type: ['number', 'null'], description: '帳單印的明細總筆數；沒印＝null' },
        totalOut: { type: ['number', 'null'], description: '帳單印的支出/轉出合計；沒印＝null' },
        totalIn: { type: ['number', 'null'], description: '帳單印的存入/轉入合計；沒印＝null' },
      },
    },
    transactions: {
      type: 'array',
      description: '明細區逐筆交易，照帳單順序',
      items: {
        type: 'object', additionalProperties: false,
        required: ['acctMasked', 'date', 'direction', 'amount', 'balance', 'summary', 'note'],
        properties: {
          acctMasked: { type: 'string', description: '這筆所屬帳戶的遮罩帳號，照帳單原樣' },
          date: { type: 'string', description: '交易日，西元 YYYY-MM-DD（民國年要換算）' },
          direction: { type: 'string', enum: ['in', 'out'], description: 'in＝存入、out＝支出' },
          amount: { type: 'number', description: '金額（正數、去千分位）' },
          balance: { type: ['number', 'null'], description: '這筆之後的帳戶餘額；帳單沒印＝null、不要用算的' },
          summary: { type: 'string', description: '摘要欄原文；沒有＝空字串' },
          note: { type: 'string', description: '備註欄原文；沒有＝空字串' },
        },
      },
    },
  },
};

/** 座標列 → 純文字（AI 的輸入）：每列 cells 依 x 排序後以空格相接。 @param {{y:number,cells:{x:number,s:string}[]}[]} lines */
export function linesToText(lines) {
  return (lines || [])
    .map((l) => [...(l.cells || [])].sort((a, b) => a.x - b.x).map((c) => c.s).join(' '))
    .join('\n');
}

/** 解析提示（system）：規則講死、不留發揮空間——照抄不臆測，讀不到就留 null/空。 */
export function buildBankSystem() {
  return [
    '你是銀行對帳單解析器。把使用者提供的對帳單文字，逐字照抄填進指定的 JSON 答案格式。',
    '規則：',
    '1. 只抄帳單上印的內容，絕不臆測或補算：某筆沒印餘額＝balance null（不要用前後筆推算）。',
    '1a. referenceDate（現值參考日＝**帳戶餘額**算到哪一天）：帳單若直接印「現值參考日」就照抄。'
      + '若沒印，**只有在帳單上找得到唯一一個、明確標示為整份帳單期間的區間**（例如「帳單期間 2026/01/01 ~ 2026/01/31」）時，'
      + '才填那個區間的**結束日**——期末餘額本來就是截至區間結束那天。'
      + '⚠️ 以下情況一律填 null，**不可挑一個**：帳單上有兩個以上的區間、'
      + '區間不是在講整份帳單（例如某個利率適用期間、某張卡的消費期間、某筆定存的存續期間）、'
      + '或你無法確定那個區間就是餘額的截止日。'
      + '⚠️ 也不可填開始日、不可填今天、不可自己推算或補一個沒印在帳單上的日期。'
      + '⚠️ **寧可回 null**：填錯會讓 app 拿這份帳單的餘額去蓋掉比較新的數字，而回 null 只是這次不更新餘額。',
    '2. 日期一律轉西元 YYYY-MM-DD（民國年＋1911）。金額去掉千分位逗號與貨幣符號，是數字。',
    '3. direction：存入/轉入/收入類＝in；支出/轉出/提領類＝out。以帳單的欄位歸屬（存入欄vs支出欄）為準。',
    '4. 遮罩帳號完全照原樣（星號、位數不可改寫）。外幣帳戶餘額填原幣、不換算。',
    '5. bank 填帳單所屬機構的短名（帳單抬頭印的銀行名）。',
    '6. accountCurrencies 要列出概要區**每一個**帳戶的遮罩帳號與幣別——含餘額欄空白（透支/負餘額）的帳戶。',
    '7. accounts 只列「有印餘額」的帳戶（餘額欄空白的不要列，但它的幣別仍要出現在 accountCurrencies）。摘要/備註欄原文照抄（含機器味文字）。',
    '8. totals：帳單自己印的明細總筆數/支出合計/存入合計照抄；帳單沒印該項＝null，絕不自己加總或推算。一律填正數（印負號＝去號）。帳單同時有台幣與外幣、合計欄涵蓋範圍不明＝三欄一律填 null。',
  ].join('\n');
}

/** 驗一個字串欄：型別、去頭尾空白、長度上限。 @param {any} v @param {string} field @param {number} max @param {boolean} [required] */
function str(v, field, max, required = false) {
  if (v == null && !required) return '';
  if (typeof v !== 'string') throw apiError(400, `AI 答案卷的 ${field} 不是文字`, 'ai_bad_answer');
  const s = v.trim();
  if (required && !s) throw apiError(400, `AI 答案卷的 ${field} 是空的`, 'ai_bad_answer');
  if (s.length > max) throw apiError(400, `AI 答案卷的 ${field} 超長（${s.length} 字）`, 'ai_bad_answer');
  return s;
}

/** 驗一個有限數字。 @param {any} v @param {string} field */
function num(v, field) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw apiError(400, `AI 答案卷的 ${field} 不是有效數字`, 'ai_bad_answer');
  return v;
}

/**
 * AI 答案卷 → ParsedBankFull（fail-closed 逐欄驗收；任何一欄壞＝整份 `ai_bad_answer`）。
 * 這裡只保證**形狀與型別**合法；**數字對不對交給對帳閘**（服務層接線）。
 * @param {any} raw AI 回的物件
 * @returns {{ bank:string, referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[], accountCurrency:Record<string,string>, transactions:import('./bank-statement.js').BankTx[], totals:{txCount:number|null, totalOut:number|null, totalIn:number|null} }}
 */
export function normalizeAiBank(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw apiError(400, 'AI 沒有交回答案卷（不是物件）', 'ai_bad_answer');
  const bank = str(raw.bank, 'bank', LIMITS.bank, true).replace(/\|/g, '');   // 分段符不可入段（同 bankRefBase）
  if (!bank) throw apiError(400, 'AI 答案卷的 bank 只剩非法字元', 'ai_bad_answer');
  let referenceDate = null;
  if (raw.referenceDate != null) {
    const d = str(raw.referenceDate, 'referenceDate', 10, true);
    if (!isRealDate(d)) throw apiError(400, 'AI 答案卷的現值參考日不是真日期', 'ai_bad_answer');   // 不回聲值（r1#3：AI 輸出可能夾帳單資料）
    referenceDate = d;
  }
  if (!Array.isArray(raw.accounts) || raw.accounts.length > LIMITS.accounts) throw apiError(400, 'AI 答案卷的 accounts 缺失或筆數異常', 'ai_bad_answer');
  if (!Array.isArray(raw.accountCurrencies) || raw.accountCurrencies.length > LIMITS.accounts) throw apiError(400, 'AI 答案卷的 accountCurrencies 缺失或筆數異常', 'ai_bad_answer');
  if (!Array.isArray(raw.transactions) || raw.transactions.length > LIMITS.transactions) throw apiError(400, 'AI 答案卷的 transactions 缺失或筆數異常', 'ai_bad_answer');
  // 幣別身分的權威來源＝accountCurrencies（r2#1：概要**所有**帳戶、含餘額空白的——模板解析器 2026-07-28
  // 同一課：parseBankSummary 對空白餘額帳戶「只記幣別、不進 accounts」，漏了它＝外幣交易查無幣別
  // fail-open 成 TWD、被當台幣入帳。accounts 只承載「有餘額可更新」的帳戶，不可兼任幣別表）。
  /** @type {Record<string,string>} */
  const accountCurrency = {};
  for (let i = 0; i < raw.accountCurrencies.length; i++) {
    const e = raw.accountCurrencies[i];
    const masked = str(e?.masked, `accountCurrencies[${i}].masked`, LIMITS.masked, true);
    if (!accountSuffix(masked)) throw apiError(400, `AI 答案卷的 accountCurrencies[${i}].masked 取不出末碼`, 'ai_bad_answer');
    const currency = str(e?.currency, `accountCurrencies[${i}].currency`, 8, true).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw apiError(400, `AI 答案卷的 accountCurrencies[${i}].currency 不是三碼幣別`, 'ai_bad_answer');
    accountCurrency[masked] = currency;   // 同帳號多列＝後者為準（與模板 last-wins 同）
  }
  const accounts = raw.accounts.map((/** @type {any} */ a, /** @type {number} */ i) => {
    const masked = str(a?.masked, `accounts[${i}].masked`, LIMITS.masked, true);
    const suffix = accountSuffix(masked);
    if (!suffix) throw apiError(400, `AI 答案卷的 accounts[${i}].masked 取不出末碼（${masked.length} 字）`, 'ai_bad_answer');
    const currency = str(a?.currency, `accounts[${i}].currency`, 8, true).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw apiError(400, `AI 答案卷的 accounts[${i}].currency 不是三碼幣別`, 'ai_bad_answer');
    // 一致性（fail-closed）：有餘額的帳戶也必須出現在權威幣別表、且幣別一致——內部矛盾＝壞答案
    if (accountCurrency[masked] == null) throw apiError(400, `AI 答案卷的 accounts[${i}] 不在 accountCurrencies 裡（幣別表要含概要所有帳戶）`, 'ai_bad_answer');
    if (accountCurrency[masked] !== currency) throw apiError(400, `AI 答案卷的 accounts[${i}] 幣別與 accountCurrencies 矛盾`, 'ai_bad_answer');
    return { suffix, masked, balance: num(a?.balance, `accounts[${i}].balance`), currency,
      label: str(a?.label, `accounts[${i}].label`, LIMITS.shortStr), note: str(a?.note, `accounts[${i}].note`, LIMITS.shortStr) };
  });
  const transactions = raw.transactions.map((/** @type {any} */ t, /** @type {number} */ i) => {
    const acctMasked = str(t?.acctMasked, `transactions[${i}].acctMasked`, LIMITS.masked, true);
    const acctSuffix = accountSuffix(acctMasked);
    if (!acctSuffix) throw apiError(400, `AI 答案卷的 transactions[${i}].acctMasked 取不出末碼`, 'ai_bad_answer');
    // r3#1：交易帳號也必須在權威幣別表——AI 是不可信輸入，「提示詞叫它列概要所有帳戶」不可當成已成立的
    // 前提；整個帳戶連幣別表一起漏交＝下游查無幣別照樣 fallback 成 TWD 入帳（r3 實測 imported:5）。
    if (accountCurrency[acctMasked] == null) throw apiError(400, `AI 答案卷的 transactions[${i}] 帳號不在 accountCurrencies 裡（每個交易帳號都要有幣別身分）`, 'ai_bad_answer');
    const date = str(t?.date, `transactions[${i}].date`, 10, true);
    if (!isRealDate(date)) throw apiError(400, `AI 答案卷的 transactions[${i}].date 不是真日期`, 'ai_bad_answer');   // 不回聲值（r1#3）
    const direction = t?.direction;
    if (direction !== 'in' && direction !== 'out') throw apiError(400, `AI 答案卷的 transactions[${i}].direction 不是 in/out`, 'ai_bad_answer');
    const amount = num(t?.amount, `transactions[${i}].amount`);
    if (amount < 0) throw apiError(400, `AI 答案卷的 transactions[${i}].amount 是負數（金額欄無正負、方向由 direction 表達）`, 'ai_bad_answer');
    const balance = t?.balance == null ? null : num(t.balance, `transactions[${i}].balance`);
    return { acctSuffix, acctMasked, date, direction: /** @type {'in'|'out'} */ (direction), amount, balance,
      summary: str(t?.summary, `transactions[${i}].summary`, LIMITS.shortStr), note: str(t?.note, `transactions[${i}].note`, LIMITS.longStr) };
  });
  // totals（裁示⑧）：null 容忍（帳單沒印＝誠實缺席）、有值必須是有限數字且非負
  /** @type {{txCount:number|null, totalOut:number|null, totalIn:number|null}} */
  const totals = { txCount: null, totalOut: null, totalIn: null };
  // 缺席＝拒（與 accounts/accountCurrencies 同口徑）：schema 列 required、結構化輸出必給——
  // 漏交必填欄位就是壞答案，不靜默降級成「全 null」（fail-closed 家規；三欄各自 null 仍合法＝帳單沒印）
  if (raw.totals == null) throw apiError(400, 'AI 答案卷缺 totals（帳單沒印合計＝三欄填 null，欄位本身不可缺席）', 'ai_bad_answer');
  {
    if (typeof raw.totals !== 'object' || Array.isArray(raw.totals)) throw apiError(400, 'AI 答案卷的 totals 不是物件', 'ai_bad_answer');
    for (const f of /** @type {const} */ (['txCount', 'totalOut', 'totalIn'])) {
      // r1#1：三欄逐欄必填（own-property）——物件在、單鍵缺席若靜默補 null，「必填」就只剩口號
      if (!Object.hasOwn(raw.totals, f)) throw apiError(400, `AI 答案卷的 totals 缺 ${f} 欄（帳單沒印＝該欄填 null，鍵本身不可缺席）`, 'ai_bad_answer');
      const v = raw.totals[f];
      if (v == null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw apiError(400, `AI 答案卷的 totals.${f} 不是非負數字`, 'ai_bad_answer');
      totals[f] = v;
    }
  }
  return { bank, referenceDate, accounts, accountCurrency, transactions, totals };
}

/**
 * 接地檢查（裁示⑧a，抓「自洽錯」的主力、零 AI 成本）：答案卷裡的每一個**金額數字**都必須在
 * 帳單原文逐字找得到——AI 把一組數字抄錯得剛好互相吻合時，餘額鏈與合計都軋得平，
 * 但「帳單上根本沒印過這個數字」藏不住。
 * 範圍＝帳戶餘額、交易金額、交易餘額、totals 三欄（非 null 者）；日期刻意不查
 * （民國→西元轉換後字面必然不同）。比對法＝把原文所有「數字長相」token（去 $ 與千分位）
 * 收成數值集合，答案的每個數字必須在集合裡。訊息**不回聲數字**（機密紀律 r1#3）。
 * @param {ReturnType<typeof normalizeAiBank>} parsed
 * @param {string} text 送給 AI 的同一份帳單文字
 */
export function assertAiBankGrounded(parsed, text) {
  // 集合建法（預審 r0 補強）：①NFKC 正規化——台灣帳單常見全形數字/逗號（１，５００），
  // 不正規化＝整個版面每筆都「不接地」誤殺（AI 路線正是給未知版面的退路、首當其衝）
  // ②日期長相 token（2026-08-15、115/08/15）先剔除再掃＝減少「金額恰等於年月日」的誤接地
  // ③相鄰兩 token 只隔空白＝加收拼接值——抽字器把一個金額拆進兩個 cell（1,234,│567）時
  //   token 斷裂，配對拼接把它接回來；**只增不減**（原 token 仍在集合）＝方向是放寬不是收緊。
  // ⚠️ 已知殘洞（誠實記載、非窮盡）：遮罩帳號片段、獨立年份、拼接產生的噪音值仍會進集合，
  //   金額恰等於它們的臆測會誤接地——本檢查是防禦縱深（把 B 類自洽錯壓低），不是閘、不宣稱窮盡。
  const seen = new Set();
  const add = (/** @type {string} */ raw) => {
    const n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n)) { seen.add(n); seen.add(Math.abs(n)); }
  };
  const stripped = String(text || '').normalize('NFKC')
    .replace(/\d{4}-\d{1,2}-\d{1,2}|\d{2,4}\/\d{1,2}\/\d{1,2}/g, ' ');
  /** @type {{ tok: string, start: number, end: number }[]} */
  const toks = [];
  for (const m of stripped.matchAll(/-?[\d,]+(?:\.\d+)?/g)) {
    toks.push({ tok: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    add(m[0]);
  }
  for (let i = 0; i + 1 < toks.length; i++) {
    // 間隔限「同列空白」（不含換行）：拆 cell 只發生在同一列（linesToText 列間是 \n）——
    // 跨列拼接會讓「上列尾數字＋下列頭數字」變合法接地證據（r1 殘餘、順手關掉）
    if (/^[^\S\n]+$/.test(stripped.slice(toks[i].end, toks[i + 1].start))) add(toks[i].tok + toks[i + 1].tok);
  }
  const miss = (/** @type {string} */ where) =>
    apiError(400, `AI 答案卷的 ${where} 數字在帳單原文找不到（可能是 AI 臆測或抄錯，也可能是帳單印法特殊）`, 'ai_bad_answer');
  parsed.accounts.forEach((a, i) => { if (!seen.has(a.balance) && !seen.has(Math.abs(a.balance))) throw miss(`accounts[${i}].balance`); });
  parsed.transactions.forEach((t, i) => {
    if (!seen.has(t.amount)) throw miss(`transactions[${i}].amount`);
    if (t.balance != null && !seen.has(t.balance) && !seen.has(Math.abs(t.balance))) throw miss(`transactions[${i}].balance`);
  });
  for (const f of /** @type {const} */ (['txCount', 'totalOut', 'totalIn'])) {
    const v = parsed.totals?.[f];
    if (v != null && !seen.has(v)) throw miss(`totals.${f}`);
  }
}

// ============================== 配方生成（P2-3） ==============================

/** 配方答案卷（格式 A＝填格子）：AI 只能填、不能發明格子；枚舉欄只准從清單選；
 * 錨點/表頭一律「版面上印的字面文字」。formatVersion 由程式蓋、不入答案卷。
 * 深層把關不在這裡——出生三關（validateRecipeStrict＋against-statement＋reproduces）在存檔前。 */
export const RECIPE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['bank', 'docAnchors', 'dateFormat', 'refDate', 'summary', 'detail'],
  properties: {
    bank: { type: 'string', description: '銀行短名（帳單抬頭印的；同答案卷 bank 規則）' },
    docAnchors: { type: 'array', maxItems: RECIPE_LIMITS.docAnchors, items: { type: 'string' },
      description: '2–4 個「這份版面獨有」的字面標題文字（照版面逐字抄、不含數字），用來認出同版面' },
    dateFormat: { type: 'string', enum: [...RECIPE_DATE_FORMATS], description: '明細日期的印法' },
    refDate: {
      type: 'object', additionalProperties: false, required: ['strategy', 'anchor'],
      properties: {
        strategy: { type: 'string', enum: [...RECIPE_REFDATE_STRATEGIES] },
        anchor: { type: ['string', 'null'], description: '現值參考日旁邊印的字面標籤（strategy=none＝null）' },
      },
    },
    summary: {
      type: 'object', additionalProperties: false, required: ['sections', 'endAnchor', 'balancePick'],
      properties: {
        sections: { type: 'array', maxItems: RECIPE_LIMITS.sections,
          items: { type: 'object', additionalProperties: false, required: ['anchor', 'currency'],
            properties: { anchor: { type: 'string', description: '總覽區段標題的字面文字' },
              currency: { type: 'string', description: '三碼幣別（TWD…）或 BY-CODE（區段內按幣別碼列）' } } },
          description: '概要總覽的每一個區段' },
        endAnchor: { type: 'string', description: '總覽收尾列的字面文字（如 總計）' },
        balancePick: { type: 'string', enum: [...RECIPE_BALANCE_PICKS], description: '帳戶列有多個金額格時挑哪個當餘額' },
      },
    },
    detail: {
      type: 'object', additionalProperties: false,
      required: ['rowIdent', 'headerOut', 'headerIn', 'headerBalance', 'headerNote', 'headerIgnore'],
      properties: {
        rowIdent: { type: 'string', enum: [...RECIPE_ROW_IDENTS], description: '交易列的長相' },
        headerOut: { type: 'string', description: '支出/提領欄的表頭字面' },
        headerIn: { type: 'string', description: '存入欄的表頭字面' },
        headerBalance: { type: 'string', description: '餘額欄的表頭字面' },
        headerNote: { type: ['string', 'null'], description: '備註欄表頭；版面沒有＝null' },
        headerIgnore: { type: 'array', maxItems: RECIPE_LIMITS.headerIgnore, items: { type: 'string' },
          description: '金額區內要忽略的欄表頭（如 單號）；沒有＝空陣列' },
      },
    },
  },
};

/** 配方生成提示（system）：填格子、照抄字面、嚴禁交易內容。 */
export function buildRecipeSystem() {
  return [
    '你是銀行對帳單「版面規則卡」的填表員。根據使用者提供的對帳單文字，把版面結構填進固定格子。',
    '規則：',
    '1. 每一格只准照抄版面上印的**字面文字**（標題、表頭、標籤）；一個字都不可以改寫或翻譯。',
    '2. 枚舉欄位（dateFormat/strategy/balancePick/rowIdent/currency）只准從格子說明的清單選。',
    '3. **嚴禁任何交易內容**：金額、帳號、日期值、人名、店名、備註內文都不可以出現在任何格子裡。',
    '4. docAnchors 挑「這份版面獨有、每期都會印」的標題文字 2 到 4 個；不確定獨不獨有就挑版面自己的產品名稱。',
    '5. 版面沒有的欄位照格子說明填 null 或空陣列；不可以硬湊。',
  ].join('\n');
}

/**
 * 候選配方白名單化（零信任）：只搬 schema 內的鍵、蓋上 formatVersion——AI 多給的鍵一律丟棄。
 * 深層合法性交給出生三關（validateRecipeStrict 等），這裡不重複驗。
 * @param {any} raw @returns {object}
 */
export function pickRecipeCandidate(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    formatVersion: RECIPE_FORMAT_VERSION,
    bank: o.bank, docAnchors: o.docAnchors, dateFormat: o.dateFormat,
    refDate: o.refDate && typeof o.refDate === 'object'
      ? { strategy: o.refDate.strategy, anchor: o.refDate.anchor } : undefined,
    summary: o.summary && typeof o.summary === 'object'
      ? { sections: Array.isArray(o.summary.sections)
            ? o.summary.sections.map((/** @type {any} */ x) => ({ anchor: x?.anchor, currency: x?.currency }))
            : undefined,
          endAnchor: o.summary.endAnchor, balancePick: o.summary.balancePick } : undefined,
    detail: o.detail && typeof o.detail === 'object'
      ? { rowIdent: o.detail.rowIdent, headerOut: o.detail.headerOut, headerIn: o.detail.headerIn,
          headerBalance: o.detail.headerBalance,
          // 白名單只搬、不修補（r1#2）：headerNote null／headerIgnore [] 是**合法值**（W2/G4：丟鍵＝
          // 這類正常版面全滅；「null＝strict 紅」是誤讀探針的假宣稱、已撤回）；但**缺鍵與壞型別原樣
          // 交給 strict 擋**——白名單替 AI 補成 null/[] ＝ strict 從「整包驗」退化成「驗修好的」，
          // 出生月剛好沒備註/忽略欄時會靜默放行壞答案卷（Codex r1 實測）。
          ...('headerNote' in o.detail ? { headerNote: o.detail.headerNote } : {}),
          ...('headerIgnore' in o.detail ? { headerIgnore: o.detail.headerIgnore } : {}) }
      : undefined,
  };
}
