// @ts-check
// 銀行對帳單匯入（三層重構 stage 2/3 服務層）。stage 2＝概要區→更新/自動建帳戶餘額（本檔）。
// 密碼＝身分證字號，只在記憶體傳給解析器、絕不落檔；帳單原始 PDF 不持久化。
import { getDb, saveDb, uid } from '../repo.js';
import { parseBankStatement } from '../bank-statement.js';
import { CURRENCIES, isRealDate } from '../schema.js';

const apiError = (/** @type {number} */ status, /** @type {string} */ msg) => Object.assign(new Error(msg), { status });
const decode = (/** @type {string} */ b64) => {
  if (!b64) throw apiError(400, '沒有收到檔案內容');
  return new Uint8Array(Buffer.from(b64, 'base64'));
};

/** 遮罩帳號拆「可見前綴＋可見末碼」（900100****3301 → {prefix:'900100', suffix:'3301'}）。 @param {string} masked */
function maskedParts(masked) {
  const m = String(masked || '').replace(/\s/g, '').match(/^(\d+)\*+(\d+)$/);
  return m ? { prefix: m[1], suffix: m[2] } : { prefix: '', suffix: '' };
}

/**
 * 找帳單這筆對應的既有帳戶——對抗審查強化（避免財務資料靜默損毀，生存優先）：
 * ①**只比對現金帳戶**（自動建的都是 cash）——否則尾碼碰巧相同的負債/保單/投資帳戶餘額會被覆蓋、負債翻成資產、淨資產算錯。
 * ②**可見前綴＋末碼都要對**（遮罩露出 900100 vs 900200）——只比末碼（3~4 碼）會讓不相干帳戶尾碼碰撞而錯戶覆蓋。
 * ③在 `existing` 快照上比對（呼叫端傳匯入前的帳戶快照）——否則同一張帳單裡兩筆會比對到「本批剛新建的那筆」而互吃。
 * @param {any[]} existing 匯入前的帳戶快照 @param {{suffix:string, masked:string, currency:string}} pa
 */
function matchAccount(existing, pa) {
  const suffix = pa.suffix;
  if (!suffix) return null;
  const { prefix } = maskedParts(pa.masked);
  return existing.find(a => {
    if ((a.type || 'cash') !== 'cash') return false;                               // 只更新現金帳戶
    if ((a.currency || 'TWD') !== (pa.currency || 'TWD')) return false;
    const d = String(a.accountNo || '').replace(/\D/g, '');
    if (d.length < suffix.length || !d.endsWith(suffix)) return false;
    return !prefix || d.startsWith(prefix);                                         // 可見前綴也要對（免尾碼碰撞）
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
  const ref = parsed.referenceDate;
  const blocked = !ref || !isRealDate(ref);            // 沒有/壞的現值參考日 → apply 會擋，預覽也要一致標明
  const existing = [...(db.accounts || [])];
  const rows = parsed.accounts.map(pa => {
    if (!CURRENCIES.includes(pa.currency)) {
      return { suffix: pa.suffix, currency: pa.currency, balance: pa.balance, label: pa.label, matchedName: null, oldBalance: null, action: 'unsupported' };
    }
    const acc = matchAccount(existing, pa);
    const stale = !!(acc && acc.balanceAsOf && ref && ref <= acc.balanceAsOf);   // 相等或較舊都不覆蓋
    return {
      suffix: pa.suffix, currency: pa.currency, balance: pa.balance, label: pa.label,
      matchedName: acc ? acc.name : null,
      oldBalance: acc ? Number(acc.balance || 0) : null,
      action: blocked ? 'blocked' : (acc ? (stale ? 'skip-stale' : 'update') : 'create'),
    };
  });
  return { bank: parsed.bank || null, referenceDate: ref, blocked, rows };
}

/**
 * 套用（純函式、就地改 db、不寫檔）：更新既有帳戶餘額（**現值參考日較新才覆蓋，相等也不覆蓋**）＋自動建立沒有的帳戶。
 * 自動建的帳戶 type:'cash'、class:'現金'、**不設 ibCashCur**（避免污染投組現金/槓桿）；accountNo 存遮罩帳號。
 * 對抗審查強化：①現值參考日過真實日曆（壞日期不進 balanceAsOf 撞櫃檯 500）②不支援幣別（非 CURRENCIES）
 * graceful skip（一個冷門幣別不擋整張帳單）③在「匯入前快照」上比對（免同批互吃）＋同批遮罩去重。
 * @param {any} db @param {ParsedBank} parsed
 */
export function applyBalancesToDb(db, parsed) {
  const ref = parsed.referenceDate;
  if (!ref || !isRealDate(ref)) throw apiError(400, '讀不到帳單的「現值參考日」或日期異常，無法判斷新舊、不敢更新餘額');
  const existing = [...(db.accounts || [])];          // 快照：只比對匯入前就有的帳戶，避免同批新建的互相吃掉
  const seen = new Set();
  let updated = 0, created = 0, skipped = 0, unsupported = 0;
  /** @type {string[]} */
  const createdNames = [];
  for (const pa of parsed.accounts) {
    if (!CURRENCIES.includes(pa.currency)) { unsupported++; continue; }            // 冷門幣別跳過、不擋整份
    const key = `${pa.masked}|${pa.currency}`;
    if (seen.has(key)) continue;                        // 同批重複列去重（防兩筆相同遮罩互吃）
    seen.add(key);
    const acc = matchAccount(existing, pa);
    if (acc) {
      if (acc.balanceAsOf && ref <= acc.balanceAsOf) { skipped++; continue; }      // 相等或較舊都不覆蓋（保住手動修正）
      acc.balance = pa.balance;
      acc.balanceAsOf = ref;
      updated++;
    } else {
      const name = autoName(pa);
      (db.accounts ||= []).push({
        id: uid(), name, type: 'cash', class: '現金',
        currency: pa.currency, balance: pa.balance, accountNo: pa.masked, balanceAsOf: ref,
      });
      created++;
      createdNames.push(name);
    }
  }
  return { bank: parsed.bank || null, referenceDate: ref, updated, created, skipped, unsupported, createdNames };
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
