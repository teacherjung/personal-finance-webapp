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

/** 遮罩帳號拆「可見前綴＋可見末碼」（209710****0122 → {prefix:'209710', suffix:'0122'}）。 @param {string} masked */
function maskedParts(masked) {
  const m = String(masked || '').replace(/\s/g, '').match(/^(\d+)\*+(\d+)$/);
  return m ? { prefix: m[1], suffix: m[2] } : { prefix: '', suffix: '' };
}

/**
 * 找帳單這筆對應的既有帳戶——對抗審查強化（避免財務資料靜默損毀，生存優先）：
 * ①**只比對現金帳戶**（自動建的都是 cash）——否則尾碼碰巧相同的負債/保單/投資帳戶餘額會被覆蓋、負債翻成資產、淨資產算錯。
 * ②**可見前綴＋末碼都要對**（遮罩露出 209710 vs 288810）——只比末碼（3~4 碼）會讓不相干帳戶尾碼碰撞而錯戶覆蓋。
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

// ---------- 交易明細分箱（stage 3，使用者定 2026-07-20）----------
// 每筆銀行往來是「存入(in)」或「支出(out)」，再依摘要/備註分箱成 收入/支出/內轉：
//  - 內轉（不計入收支）：備註含**自己帳號末碼**（帳單自己的帳戶＋使用者登記過的帳戶），或摘要含「劃撥」
//    （＝證券交割戶買賣 ETF 的投資金流，不是花錢/賺錢）。
//  - 繳卡費（支出、**不分類**：卡明細已分好類，這裡分類會重複統計）：備註含 卡費/信用卡款。
//  - 領現金（支出，生活/其他生活雜支）：摘要含 提款（CD提款/ATM）。使用者定：領錢＝現金消費。
//  - 手續費（支出，其他/手續費）、房貸（支出，居住/房貸）、養育費給前妻（支出，養育/贍養費）。
//  - 存款息/利息→收入 被動/利息；配息/收益分配→收入 被動/股息。
//  - 其餘：方向決定收入/支出，落「其他」讓使用者在收支頁改。**匯入是預覽→使用者確認**，自動分箱只是起點。

/** 從備註抓出所有「遮罩帳號的末碼」。 @param {string} note */
function noteAccountSuffixes(note) {
  return [...String(note || '').matchAll(/\*+\s*(\d+)/g)].map(m => m[1]);
}

/**
 * 分箱單筆銀行交易 → {type, category, subcategory}。 @param {import('../bank-statement.js').BankTx} tx @param {Set<string>} ownSuffixes 自己帳號末碼
 */
export function classifyBankTx(tx, ownSuffixes) {
  const text = `${tx.summary || ''} ${tx.note || ''}`;
  const out = tx.direction === 'out';
  const internal = noteAccountSuffixes(tx.note).some(s => ownSuffixes.has(s));
  // ⚠️劃撥＝證券交割戶買賣 ETF 的投資金流（單筆可上百萬），**在備註不在摘要**——判**全文**（早期只判摘要
  // 讓百萬劃撥被當成收入，真實資料抓到）。劃撥/內部帳號 → 內轉（不計入收支）。
  if (internal || /劃撥/.test(text)) return { type: 'transfer', category: '內轉', subcategory: out ? '內轉出' : '內轉入' };
  if (/卡費|信用卡款/.test(text)) return { type: 'expense', category: '', subcategory: '' };            // 繳卡費不分類（卡明細已分）
  if (/提款/.test(tx.summary)) return { type: 'expense', category: '生活', subcategory: '其他生活雜支' };   // 領現金＝現金消費
  if (/手續費/.test(tx.summary)) return { type: 'expense', category: '其他', subcategory: '手續費' };
  if (/房屋貸款|房貸/.test(text)) return { type: 'expense', category: '居住', subcategory: '房貸' };
  if (/養育|贍養/.test(text)) return { type: 'expense', category: '養育', subcategory: '贍養費' };
  if (/存款息|利息/.test(tx.summary)) return { type: 'income', category: '被動', subcategory: '利息' };
  if (/配息|收益分配/.test(text)) return { type: 'income', category: '被動', subcategory: '股息' };
  if (/中獎|發票/.test(text)) return { type: 'income', category: '被動', subcategory: '中獎' };
  if (/鐘點/.test(text)) return { type: 'income', category: '工作', subcategory: '鐘點' };
  return out ? { type: 'expense', category: '其他', subcategory: '未分類' } : { type: 'income', category: '其他', subcategory: '其他收入' };
}

/** 銀行交易去重鍵（running 餘額讓同日同額也唯一）。 @param {import('../bank-statement.js').BankTx} tx */
function bankRefOf(tx) {
  return `bank|${tx.acctSuffix}|${tx.date}|${tx.direction}|${tx.amount}|${tx.balance ?? ''}|${tx.summary}`;
}

/** 「自己帳號末碼」集合＝帳單自己的帳戶 ∪ 使用者登記過 accountNo 的帳戶（供內轉判定）。 @param {any} db @param {ParsedBank} parsed */
function ownSuffixSet(db, parsed) {
  const set = new Set();
  for (const pa of parsed.accounts || []) if (pa.suffix) set.add(pa.suffix);
  for (const a of db.accounts || []) { const s = String(a.accountNo || '').replace(/\D/g, ''); if (s) { set.add(s.slice(-4)); set.add(s.slice(-3)); } }
  return set;
}

/** 用交易的帳戶末碼找帳戶名（顯示用；找不到回「台新 末XXXX」）。 @param {any} db @param {string} suffix @param {ParsedBank} parsed */
function accountNameForSuffix(db, suffix, parsed) {
  const acc = (db.accounts || []).find(a => { const d = String(a.accountNo || '').replace(/\D/g, ''); return d && suffix && d.endsWith(suffix); });
  if (acc) return acc.name;
  const pa = (parsed.accounts || []).find(x => x.suffix === suffix);
  return pa ? autoName(pa) : `台新 ${suffix}`;
}

/** @typedef {ParsedBank & {transactions:import('../bank-statement.js').BankTx[]}} ParsedBankFull */

/**
 * 交易明細分箱預覽（純函式、不寫檔）：分箱＋去重標記＋帳戶名。回可讓前端呈現/確認的列。
 * @param {any} db @param {ParsedBankFull} parsed
 */
export function previewBankTxForDb(db, parsed) {
  const own = ownSuffixSet(db, parsed);
  const existing = new Set((db.transactions || []).map(t => t.bankRef).filter(Boolean));
  const rows = (parsed.transactions || []).map(tx => {
    const cls = classifyBankTx(tx, own);
    const bankRef = bankRefOf(tx);
    return {
      date: tx.date, account: accountNameForSuffix(db, tx.acctSuffix, parsed),
      summary: tx.summary, note: tx.note, amount: tx.amount, direction: tx.direction,
      type: cls.type, category: cls.category, subcategory: cls.subcategory,
      duplicate: existing.has(bankRef), bankRef,
    };
  });
  /** @type {Record<string, number>} */
  const counts = { income: 0, expense: 0, transfer: 0, duplicate: 0 };
  for (const r of rows) { if (r.duplicate) counts.duplicate++; else counts[r.type]++; }
  return { rows, counts };
}

/**
 * 交易明細匯入（純函式、就地改 db、不寫檔）：把非重複的分箱交易寫進**現金流帳本**（ledger:'cashflow'、
 * source:'bank'）。繳卡費 category 空（不進分類統計）。
 * @param {any} db @param {ParsedBankFull} parsed
 */
export function importBankTxToDb(db, parsed) {
  const own = ownSuffixSet(db, parsed);
  const existing = new Set((db.transactions || []).map(t => t.bankRef).filter(Boolean));
  const importedAt = new Date().toISOString();
  const batchId = uid();
  let imported = 0, skipped = 0;
  for (const tx of parsed.transactions || []) {
    const bankRef = bankRefOf(tx);
    if (existing.has(bankRef)) { skipped++; continue; }
    existing.add(bankRef);
    const cls = classifyBankTx(tx, own);
    const noteText = [tx.summary, tx.note].filter(Boolean).join('・');
    (db.transactions ||= []).push({
      id: uid(), date: tx.date, type: cls.type, category: cls.category, subcategory: cls.subcategory,
      amount: tx.amount, account: accountNameForSuffix(db, tx.acctSuffix, parsed), note: noteText,
      ledger: 'cashflow', source: 'bank', bankRef, importBatch: batchId, importedAt,
    });
    imported++;
  }
  return { imported, skipped, batchId };
}

/** 預覽（解析 PDF → 純邏輯）：回帳戶餘額變動＋交易分箱兩塊。 @param {string} b64 @param {string=} password */
export async function previewBankStatement(b64, password) {
  const parsed = await parseBankStatement(decode(b64), password);
  const db = getDb();
  return { ...previewBalancesForDb(db, parsed), transactions: previewBankTxForDb(db, parsed) };
}

/** 套用（解析 PDF → 更新餘額＋匯入交易 → 一次寫檔）。 @param {string} b64 @param {string=} password */
export async function applyBankStatement(b64, password) {
  const parsed = await parseBankStatement(decode(b64), password);
  const db = getDb();
  const bal = applyBalancesToDb(db, parsed);
  const tx = importBankTxToDb(db, parsed);
  saveDb(db);
  return { ok: true, ...bal, transactions: tx };
}
