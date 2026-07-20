// @ts-check
// 銀行對帳單匯入（三層重構 stage 2/3 服務層）。stage 2＝概要區→更新/自動建帳戶餘額（本檔）。
// 密碼＝身分證字號，只在記憶體傳給解析器、絕不落檔；帳單原始 PDF 不持久化。
import { getDb, saveDb, uid } from '../repo.js';
import { parseBankStatement } from '../bank-statement.js';

const apiError = (/** @type {number} */ status, /** @type {string} */ msg) => Object.assign(new Error(msg), { status });
const decode = (/** @type {string} */ b64) => {
  if (!b64) throw apiError(400, '沒有收到檔案內容');
  return new Uint8Array(Buffer.from(b64, 'base64'));
};

/** 用「帳號末碼＋幣別」找既有帳戶。帳戶的 accountNo 可能是**完整**帳號（使用者手填，無星號）或**遮罩**帳號
 * （自動建立時存的 209710****0122）——兩者的「純數字」都以帳單末碼結尾，用 endsWith 比對即可涵蓋。
 * @param {any} db @param {string} suffix @param {string} currency */
function matchAccount(db, suffix, currency) {
  if (!suffix) return null;
  return (db.accounts || []).find(a => {
    const digits = String(a.accountNo || '').replace(/\D/g, '');
    return digits.length >= suffix.length && digits.endsWith(suffix) && (a.currency || 'TWD') === (currency || 'TWD');
  }) || null;
}

/** 自動建立帳戶的預設名（使用者可改）。 @param {{suffix:string,label:string,note:string}} pa */
function autoName(pa) {
  const tag = (pa.note || pa.label || '').trim();
  return `台新 ${pa.suffix}${tag ? `（${tag}）` : ''}`;
}

/** @typedef {{ bank?:string, referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[] }} ParsedBank */

/**
 * 預覽（純函式、不寫檔）：對照既有帳戶，列出每筆「會更新／會新建／因帳單較舊而跳過」。
 * @param {any} db @param {ParsedBank} parsed
 */
export function previewBalancesForDb(db, parsed) {
  const rows = parsed.accounts.map(pa => {
    const acc = matchAccount(db, pa.suffix, pa.currency);
    const stale = !!(acc && acc.balanceAsOf && parsed.referenceDate && parsed.referenceDate < acc.balanceAsOf);
    return {
      suffix: pa.suffix, currency: pa.currency, balance: pa.balance, label: pa.label,
      matchedName: acc ? acc.name : null,
      oldBalance: acc ? Number(acc.balance || 0) : null,
      action: acc ? (stale ? 'skip-stale' : 'update') : 'create',
    };
  });
  return { bank: parsed.bank || null, referenceDate: parsed.referenceDate, rows };
}

/**
 * 套用（純函式、就地改 db、不寫檔）：更新既有帳戶餘額（**現值參考日較新才覆蓋**）＋自動建立沒有的帳戶。
 * 自動建的帳戶 type:'cash'、class:'現金'、**不設 ibCashCur**（避免污染投組現金/槓桿）；accountNo 存遮罩帳號。
 * @param {any} db @param {ParsedBank} parsed
 */
export function applyBalancesToDb(db, parsed) {
  if (!parsed.referenceDate) throw apiError(400, '讀不到帳單的「現值參考日」，無法判斷新舊、不敢更新餘額');
  let updated = 0, created = 0, skipped = 0;
  /** @type {string[]} */
  const createdNames = [];
  for (const pa of parsed.accounts) {
    const acc = matchAccount(db, pa.suffix, pa.currency);
    if (acc) {
      if (acc.balanceAsOf && parsed.referenceDate < acc.balanceAsOf) { skipped++; continue; }   // 帳單較舊→不覆蓋
      acc.balance = pa.balance;
      acc.balanceAsOf = parsed.referenceDate;
      updated++;
    } else {
      const name = autoName(pa);
      (db.accounts ||= []).push({
        id: uid(), name, type: 'cash', class: '現金',
        currency: pa.currency, balance: pa.balance, accountNo: pa.masked, balanceAsOf: parsed.referenceDate,
      });
      created++;
      createdNames.push(name);
    }
  }
  return { bank: parsed.bank || null, referenceDate: parsed.referenceDate, updated, created, skipped, createdNames };
}

/** 預覽（解析 PDF → 純邏輯）。 @param {string} b64 @param {string=} password */
export async function previewBankStatement(b64, password) {
  const parsed = await parseBankStatement(decode(b64), password);
  return previewBalancesForDb(getDb(), parsed);
}

/** 套用（解析 PDF → 純邏輯 → 一次寫檔）。 @param {string} b64 @param {string=} password */
export async function applyBankStatement(b64, password) {
  const parsed = await parseBankStatement(decode(b64), password);
  const db = getDb();
  const res = applyBalancesToDb(db, parsed);
  saveDb(db);
  return { ok: true, ...res };
}
