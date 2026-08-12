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

const apiError = (/** @type {number} */ status, /** @type {string} */ msg, /** @type {string=} */ code) =>
  Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });

/** 模型階梯（★3 拍板：起步 Haiku、對帳閘紅了升 Sonnet 重試一次——階梯由服務層走，本模組單發）。 */
export const AI_BANK_MODELS = { primary: 'claude-haiku-4-5-20251001', escalation: 'claude-sonnet-5' };

/** 筆數與長度牆（防 AI 幻覺灌爆 db；正常對帳單遠低於此）。 */
const LIMITS = { accounts: 200, transactions: 5000, shortStr: 80, longStr: 500, bank: 20, masked: 40 };

/** 固定答案卷（結構化輸出 schema）：欄位語意對齊 lib/bank-statement.js 的 ParsedBankFull。 */
export const AI_BANK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bank', 'referenceDate', 'accountCurrencies', 'accounts', 'transactions'],
  properties: {
    bank: { type: 'string', description: '開戶機構短名（例：台新、國泰世華、玉山）；帳單上印的銀行名' },
    referenceDate: { type: ['string', 'null'], description: '帳戶餘額的現值參考日，西元 YYYY-MM-DD；帳單沒印＝null' },
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
    '1. 只抄帳單上印的內容，絕不臆測或補算：讀不到現值參考日＝null；某筆沒印餘額＝balance null（不要用前後筆推算）。',
    '2. 日期一律轉西元 YYYY-MM-DD（民國年＋1911）。金額去掉千分位逗號與貨幣符號，是數字。',
    '3. direction：存入/轉入/收入類＝in；支出/轉出/提領類＝out。以帳單的欄位歸屬（存入欄vs支出欄）為準。',
    '4. 遮罩帳號完全照原樣（星號、位數不可改寫）。外幣帳戶餘額填原幣、不換算。',
    '5. bank 填帳單所屬機構的短名（帳單抬頭印的銀行名）。',
    '6. accountCurrencies 要列出概要區**每一個**帳戶的遮罩帳號與幣別——含餘額欄空白（透支/負餘額）的帳戶。',
    '7. accounts 只列「有印餘額」的帳戶（餘額欄空白的不要列，但它的幣別仍要出現在 accountCurrencies）。摘要/備註欄原文照抄（含機器味文字）。',
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
 * @returns {{ bank:string, referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[], accountCurrency:Record<string,string>, transactions:import('./bank-statement.js').BankTx[] }}
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
  return { bank, referenceDate, accounts, accountCurrency, transactions };
}
