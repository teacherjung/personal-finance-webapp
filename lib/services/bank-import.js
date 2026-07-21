// @ts-check
// 銀行對帳單匯入（三層重構 stage 2/3 服務層）。stage 2＝概要區→更新/自動建帳戶餘額（本檔）。
// 密碼＝身分證字號，只在記憶體傳給解析器、絕不落檔；帳單原始 PDF 不持久化。
import { getDb, saveDb, uid } from '../repo.js';
import { parseBankStatement } from '../bank-statement.js';
import { CURRENCIES, isRealDate } from '../schema.js';
import { resolveImportCategory, resolveImportIncome } from './categories.js';
import { getOwn, setOwn, isProtoKey } from '../safe-map.js';

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

/** @typedef {{ bank?:string, referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[], accountCurrency?:Record<string,string> }} ParsedBank */

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
  // 劃撥（證券交割）給獨立子分類「交割」（使用者定 2026-07-21）——與一般帳戶互轉分開，日後想單獨看投資搬了多少錢。
  if (/劃撥/.test(text)) return { type: 'transfer', category: '內轉', subcategory: '交割' };
  if (internal) return { type: 'transfer', category: '內轉', subcategory: out ? '內轉出' : '內轉入' };
  // ⚠️**方向護欄**（對抗審查 stage 3）：分類關鍵字必須配方向，否則出方向的「透支利息/電子發票工本費」會被
  // 當成收入（利息/發票是台灣高頻字），支出少算＋收入多算＝毀掉現金流數字（生存優先）。
  if (out) {   // 支出類
    if (/卡費|信用卡款/.test(text)) return { type: 'expense', category: '', subcategory: '' };            // 繳卡費不分類（卡明細已分）
    if (/提款/.test(tx.summary)) return { type: 'expense', category: '生活', subcategory: '其他生活雜支' };   // 領現金＝現金消費
    if (/手續費/.test(tx.summary)) return { type: 'expense', category: '其他', subcategory: '手續費' };
    if (/房屋貸款|房貸/.test(text)) return { type: 'expense', category: '居住', subcategory: '房貸' };
    if (/養育|贍養/.test(text)) return { type: 'expense', category: '養育', subcategory: '贍養費' };
    return { type: 'expense', category: '其他', subcategory: '未分類' };
  }
  // 收入類（只在 in 方向；「發票」單字太寬＝電子發票工本費之類，收窄成需含「中獎」）
  if (/存款息|利息/.test(tx.summary)) return { type: 'income', category: '被動', subcategory: '利息' };
  if (/配息|收益分配/.test(text)) return { type: 'income', category: '被動', subcategory: '股息' };
  if (/中獎/.test(text)) return { type: 'income', category: '被動', subcategory: '中獎' };
  if (/鐘點/.test(text)) return { type: 'income', category: '工作', subcategory: '鐘點' };
  return { type: 'income', category: '其他', subcategory: '其他收入' };
}

// ---------- 收支「真·學習」（記憶版，使用者定 2026-07-21）----------
// 讓銀行收支像信用卡「改一次記一輩子」：以「摘要＋對方帳號」為鑰匙，記住使用者改過的分類與顯示名，
// 未來匯入同鑰匙自動套用。鑰匙**只看原始 summary＋note**（與顯示名無關）——套用學過的自訂名後仍能重算出同鑰匙。
// 用「摘要＋對方帳號」而非只看摘要：同一個「轉帳存入」可能是薪水/朋友還錢/自己搬錢，只看摘要會互相污染（使用者定）。

/** 從備註抓出「對方遮罩帳號」全碼（含前綴，如 288810****3047、806-00204127****1206）當穩定身分。 @param {string} note */
function counterpartyAcct(note) {
  const m = String(note || '').match(/\d[\d-]*\*{2,}\d+/);
  return m ? m[0] : '';
}

/** 銀行收支學習鑰匙。有對方帳號＝摘要｜#帳號（最穩）；無帳號＝摘要｜備註描述文字（去掉帳號殘跡）；
 * 兩者皆無（光禿摘要如「轉帳存入」）＝空字串（太籠統、不學，避免亂套用）。 @param {string} summary @param {string} note */
export function bankKeyOf(summary, note) {
  const s = String(summary || '').replace(/\s+/g, ' ').trim();
  const acct = counterpartyAcct(note);
  if (acct) return `${s}|#${acct}`;
  const desc = String(note || '').replace(/\d[\d-]*\*{2,}\d+/g, '').replace(/\s+/g, ' ').trim();
  return desc ? `${s}|${desc}` : '';
}

/** 從已合併的顯示 note（"摘要・備註"）反推 bankKey——**只在交易沒存 bankKey 時退路用**（本功能前匯入的舊資料）。
 * ⚠️note 可能已被使用者改成自訂名，反推會失準，故一律優先用存好的 tx.bankKey。 @param {string} note */
function bankKeyFromNote(note) {
  const raw = String(note || '');
  const i = raw.indexOf('・');
  return i >= 0 ? bankKeyOf(raw.slice(0, i), raw.slice(i + 1)) : bankKeyOf(raw, '');
}

/** 學到的 type 是否與**本筆實際方向**相容——bankKey 不含方向（摘要＋對方帳號），同鑰匙可能同時有進帳與出帳
 * （如對同一個人有轉出也有收款）。⚠️**方向護欄**（對抗審查 2026-07-21）：收入必須是進帳(in)、支出必須是出帳(out)，
 * 否則會把出帳當收入記＝現金流數字被毀（生存優先）。內轉可進可出（出/入子類另依方向定）。 @param {string} type @param {'in'|'out'} direction */
function learnedTypeFitsDirection(type, direction) {
  if (type === 'transfer') return true;
  if (type === 'income') return direction === 'in';
  if (type === 'expense') return direction === 'out';
  return false;
}

/** 分箱（含學習）：先查 learnedBank（使用者教過的：以摘要＋對方帳號為鑰匙），命中且**方向相容**才用學過的 type/分類＋
 * 自訂顯示名；否則（沒學過／方向不符）落 classifyBankTx 關鍵字規則（它自帶方向護欄）。內轉的出/入子類一律依本筆方向，
 * 不套用學到的方向（同鑰匙的反向交易才不會被貼錯內轉出/入）。回 {bankKey, cls, name}。
 * @param {any} db @param {import('../bank-statement.js').BankTx} tx @param {Set<string>} own */
function classifyWithLearning(db, tx, own) {
  const bankKey = bankKeyOf(tx.summary, tx.note);
  const learned = (bankKey && !isProtoKey(bankKey)) ? getOwn(db.learnedBank || {}, bankKey) : null;
  if (learned && learned.type && learned.category != null && learnedTypeFitsDirection(learned.type, tx.direction)) {
    const subcategory = learned.type === 'transfer'
      ? (learned.subcategory === '交割' ? '交割'            // 交割＝方向中性（證券劃撥），保留不改
        : (tx.direction === 'out' ? '內轉出' : '內轉入'))   // 內轉出/入 隨本筆方向，不重播學到的
      : (learned.subcategory || '');
    return { bankKey, applied: true, cls: { type: learned.type, category: learned.category, subcategory },
      name: typeof learned.name === 'string' ? learned.name : '' };
  }
  return { bankKey, applied: false, cls: classifyBankTx(tx, own), name: '' };   // 沒學過／方向不符 → 關鍵字規則
}

/** 從「編輯銀行收支交易」學（掛 CRUD beforeSave，只學 source:'bank'，避免手動記帳/信用卡污染）：以交易存好的
 * bankKey（缺席才從 note 反推）為鑰匙，記住 type/分類；顯示名只在**這次真的改了 note** 時記（比照 learnFromStmtEdit
 * 用 prev 判；改成空＝清除自訂名）。未來匯入同鑰匙就自動套用。 @param {any} db @param {any} item @param {any} [prev] */
export function learnFromBankEdit(db, item, prev) {
  if (item.source !== 'bank') return;
  const bankKey = item.bankKey || bankKeyFromNote(item.note);
  if (!bankKey || isProtoKey(bankKey)) return;                 // 太籠統（光禿摘要）或保留字 → 不學
  if (!['income', 'expense', 'transfer'].includes(item.type)) return;   // 沒有合法金流方向不學（免日後套用出錯）
  const lb = (db.learnedBank ||= {});
  const e = getOwn(lb, bankKey) || {};
  e.type = item.type;
  e.category = item.category || '';
  e.subcategory = item.subcategory || '';
  // 顯示名：這次真的改了 note 才記；改成空＝清除自訂名（＝自然的「還原成自動」路徑）。
  // ⚠️刻意**不做**信用卡那種「auto 名自我修剪」（對抗審查 r2 裁定）：卡片顯示名會隨分類自動重算（note 跟著分類走），
  // 才需分辨「因改分類而變的 auto 名 vs 真自訂名」；銀行的 note 是**靜態原文、不隨分類重算**，使用者改什麼就是什麼。
  // 唯一邊角（手打出跟原始「摘要・備註」一字不差的字串才被凍結）實務不可達——該字串已被自訂名取代、使用者看不到，
  // 想還原直接清空即可。用「反推鑰匙相等」當自動樣式判準會誤傷「保留摘要前綴＋提到對方帳號」的真自訂名，故不採。
  const noteChanged = Boolean(prev) && String(item.note || '') !== String(prev.note || '');
  if (noteChanged) { if (item.note) e.name = item.note; else delete e.name; }
  setOwn(lb, bankKey, e);
}

/** 已學的銀行收支規則清單（設定頁「銀行收支學習」檢視用）：learnedBank 攤成陣列，鑰匙拆成可讀的「摘要／對方」。
 * key 形如「摘要|#帳號」或「摘要|描述」。 */
export function listLearnedBank() {
  const lb = getDb().learnedBank || {};
  return Object.entries(lb).map(([key, e]) => {
    const i = key.indexOf('|');
    const summary = i >= 0 ? key.slice(0, i) : key;
    const rest = i >= 0 ? key.slice(i + 1) : '';
    const counterparty = rest.startsWith('#') ? rest.slice(1) : rest;   // #帳號 去掉井號；描述原樣
    return { key, summary, counterparty, type: e.type, category: e.category || '', subcategory: e.subcategory || '', name: e.name || '' };
  });
}

/** 刪除一筆已學的銀行收支規則（教錯了的救援路徑之一）。 @param {string} key */
export function deleteLearnedBank(key) {
  const db = getDb();
  const k = String(key || '');
  // hasOwn 而非 in（同 deleteLearned/Codex r5#1）：只刪真的存在的自有鍵，不查原型鏈
  if (db.learnedBank && Object.hasOwn(db.learnedBank, k)) delete db.learnedBank[k];
  saveDb(db);
  return { ok: true };
}

/** 銀行交易去重鍵底（**完整遮罩帳號**：末碼相同、前綴不同的兩帳戶不可撞鍵；running 餘額讓同日同額唯一；
 * 含 note＝餘額讀不到時同日同額不同備註仍分得開）。 @param {import('../bank-statement.js').BankTx} tx */
function bankRefBase(tx) {
  const acct = tx.acctMasked || `x****${tx.acctSuffix}`;
  return `bank|${acct}|${tx.date}|${tx.direction}|${tx.amount}|${tx.balance ?? ''}|${tx.summary}|${tx.note}`;
}
/** 去重鍵＝base＋「批內第 n 次相同 base」：兩筆欄位全同且餘額讀不到(null)的真實交易不被誤去重。序號
 * 由帳單順序決定＝穩定，重匯同帳單仍正確去重。 @param {import('../bank-statement.js').BankTx} tx @param {Map<string,number>} occ */
function bankRefWithOcc(tx, occ) {
  const base = bankRefBase(tx);
  const n = (occ.get(base) || 0) + 1; occ.set(base, n);
  return n > 1 ? `${base}#${n}` : base;
}
/** 舊版去重鍵（stage 3 初版：末碼、無出現序）——向後相容：若 db 已有用舊版匯入的銀行交易，新匯入仍認得
 * 其舊 bankRef、不重複計（去重鍵格式從末碼改成完整遮罩帳號＋出現序，不加這道會重覆匯入＝現金流翻倍）。
 * @param {import('../bank-statement.js').BankTx} tx */
function bankRefLegacy(tx) {
  return `bank|${tx.acctSuffix}|${tx.date}|${tx.direction}|${tx.amount}|${tx.balance ?? ''}|${tx.summary}|${tx.note}`;
}

/** 找這筆交易對應帳戶的幣別。權威＝帳單概要區的「完整遮罩帳號→幣別」表（含餘額空白被略過的帳戶，故**不會
 * fail-open 成 TWD**）；其次比 parsed.accounts 遮罩、再比 db 的**現金**帳戶前綴+末碼（只認現金＝同 matchAccount
 * 護欄，免同末碼的外幣投資/負債帳戶誤判幣別而把真台幣現金流當外幣丟棄）；全 miss 才當 TWD。
 * @param {any} db @param {ParsedBankFull} parsed @param {import('../bank-statement.js').BankTx} tx */
function txCurrency(db, parsed, tx) {
  const byMap = (parsed.accountCurrency && tx.acctMasked) ? parsed.accountCurrency[tx.acctMasked] : null;
  if (byMap) return byMap;
  const pa = (parsed.accounts || []).find(a => a.masked && a.masked === tx.acctMasked);
  if (pa) return pa.currency || 'TWD';
  const { prefix, suffix } = maskedParts(tx.acctMasked || `x****${tx.acctSuffix}`);
  const acc = (db.accounts || []).find(a => {
    if ((a.type || 'cash') !== 'cash') return false;   // 只認現金帳戶（同 matchAccount）：外幣投資/負債同末碼不誤判幣別
    const d = String(a.accountNo || '').replace(/\D/g, '');
    if (!suffix || d.length < suffix.length || !d.endsWith(suffix)) return false;
    return !prefix || d.startsWith(prefix);
  });
  return acc ? (acc.currency || 'TWD') : 'TWD';
}

/** 分箱結果過使用者的分類改名/生效樹（同卡片匯入的 resolveImportCategory）：支出走別名+conform、收入 conform
 * 到收入樹（收入無別名機制）、繳卡費(category 空)與內轉保持原樣——免寫出分類樹外的孤兒分類。
 * @param {any} db @param {{type:string,category:string,subcategory:string}} cls */
function resolveCls(db, cls) {
  if (cls.type === 'expense' && cls.category) {
    const [category, subcategory] = resolveImportCategory(db, cls.category, cls.subcategory);
    return { ...cls, category, subcategory };
  }
  if (cls.type === 'income') {
    const [category, subcategory] = resolveImportIncome(db, cls.category, cls.subcategory);
    return { ...cls, category, subcategory };
  }
  return cls;
}

/** 「自己帳號末碼」集合＝帳單自己的帳戶（含 3 碼外幣末碼）∪ 使用者登記過 accountNo 的**現金**帳戶（供內轉判定）。
 * 對抗審查：①**只認現金帳戶**（登記房貸/信用卡帳戶不算自己人，繳款仍是支出、不被當內轉排除）②登記帳戶
 * **只用 4 碼**（3 碼太短會誤中無關第三方的遮罩帳號→真金流被當內轉靜默排除）；真 3 碼外幣帳戶靠帳單自己的
 * pa.suffix 涵蓋。 @param {any} db @param {ParsedBank} parsed */
function ownSuffixSet(db, parsed) {
  const set = new Set();
  for (const pa of parsed.accounts || []) if (pa.suffix) set.add(pa.suffix);
  for (const a of db.accounts || []) {
    if ((a.type || 'cash') !== 'cash') continue;
    const s = String(a.accountNo || '').replace(/\D/g, '');
    if (s.length >= 4) set.add(s.slice(-4));
  }
  return set;
}

/** 用交易的帳戶找帳戶名（顯示用）：只在**現金**帳戶裡找（同 matchAccount，免抓到同末碼的房貸/投資帳戶名）；
 * 先比前綴+末碼、比不到退回只比末碼（使用者登記的 accountNo 未必以遮罩露出的前綴開頭：可能只填末幾碼或含
 * 銀行代碼前置，硬要前綴相符會漏配到自己的帳戶）。都無→帳單概要區帳戶的 autoName、再無→「台新 末XXXX」。
 * @param {any} db @param {import('../bank-statement.js').BankTx} tx @param {ParsedBank} parsed */
function accountNameForTx(db, tx, parsed) {
  const { prefix, suffix } = maskedParts(tx.acctMasked || `x****${tx.acctSuffix}`);
  const suf = suffix || tx.acctSuffix;
  const digits = (/** @type {any} */ a) => String(a.accountNo || '').replace(/\D/g, '');
  const bySuffix = (db.accounts || []).filter(a => {
    if ((a.type || 'cash') !== 'cash') return false;
    const d = digits(a); return suf && d.length >= suf.length && d.endsWith(suf);
  });
  const acc = bySuffix.find(a => !prefix || digits(a).startsWith(prefix)) || bySuffix[0];   // 先前綴+末碼、退回只末碼（都限現金）
  if (acc) return acc.name;
  const pa = (parsed.accounts || []).find(x => x.masked === tx.acctMasked) || (parsed.accounts || []).find(x => x.suffix === tx.acctSuffix);
  return pa ? autoName(pa) : `台新 ${tx.acctSuffix}`;
}

/** @typedef {ParsedBank & {transactions:import('../bank-statement.js').BankTx[]}} ParsedBankFull */

/**
 * 交易明細分箱預覽（純函式、不寫檔）：分箱＋去重標記＋帳戶名。回可讓前端呈現/確認的列。
 * @param {any} db @param {ParsedBankFull} parsed
 */
export function previewBankTxForDb(db, parsed) {
  const own = ownSuffixSet(db, parsed);
  const existing = new Set((db.transactions || []).map(t => t.bankRef).filter(Boolean));
  const seen = new Set();   // 同批內去重也要標（否則預覽筆數多於實際匯入，使用者看到 2 筆卻只進 1 筆）
  const occ = new Map();    // 批內出現序（同 base 第 n 筆）——同日同額同備註且餘額讀不到仍分得開
  const rows = (parsed.transactions || []).map(tx => {
    const currency = txCurrency(db, parsed, tx);
    const foreign = currency !== 'TWD';   // 外幣明細：尚無歷史匯率口徑，一律不計入台幣現金流（只呈現、不匯入）
    const { bankKey, applied, cls: rawCls, name } = classifyWithLearning(db, tx, own);   // 先套學過的（摘要＋對方帳號、方向相容）、否則關鍵字
    const cls = resolveCls(db, rawCls);
    const bankRef = bankRefWithOcc(tx, occ);
    const duplicate = existing.has(bankRef) || existing.has(bankRefLegacy(tx)) || seen.has(bankRef);
    seen.add(bankRef);
    const displayNote = name || [tx.summary, tx.note].filter(Boolean).join('・');   // 學過自訂顯示名優先
    return {
      date: tx.date, account: accountNameForTx(db, tx, parsed),
      summary: tx.summary, note: displayNote, amount: tx.amount, direction: tx.direction, currency, foreign,
      type: cls.type, category: cls.category, subcategory: cls.subcategory,
      duplicate, bankRef, bankKey, learned: applied,   // 真的套用了學過的才標「已學」（方向不符落關鍵字＝不標）
    };
  });
  /** @type {Record<string, number>} */
  const counts = { income: 0, expense: 0, transfer: 0, duplicate: 0, foreign: 0 };
  for (const r of rows) {
    if (r.foreign) counts.foreign++;        // 外幣不進 income/expense/transfer（不匯入）
    else if (r.duplicate) counts.duplicate++;
    else counts[r.type]++;
  }
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
  const occ = new Map();
  const importedAt = new Date().toISOString();
  const batchId = uid();
  let imported = 0, skipped = 0, foreign = 0;
  for (const tx of parsed.transactions || []) {
    if (txCurrency(db, parsed, tx) !== 'TWD') { foreign++; continue; }   // 外幣明細不計入台幣現金流（尚無歷史匯率換算）
    const bankRef = bankRefWithOcc(tx, occ);
    if (existing.has(bankRef) || existing.has(bankRefLegacy(tx))) { skipped++; continue; }
    existing.add(bankRef);
    const { bankKey, cls: rawCls, name } = classifyWithLearning(db, tx, own);   // 先套學過的、沒學過才關鍵字
    const cls = resolveCls(db, rawCls);
    const noteText = name || [tx.summary, tx.note].filter(Boolean).join('・');   // 學過自訂顯示名優先
    (db.transactions ||= []).push({
      id: uid(), date: tx.date, type: cls.type, category: cls.category, subcategory: cls.subcategory,
      amount: tx.amount, account: accountNameForTx(db, tx, parsed), note: noteText,
      ledger: 'cashflow', source: 'bank', bankRef, bankKey, importBatch: batchId, importedAt,
    });
    imported++;
  }
  return { imported, skipped, foreign, batchId };
}

// ---------- 匯入批次管理（讓「匯入紀錄」可整批刪除重匯，比照信用卡帳單）----------

/** 銀行對帳單匯入批次清單：把 `source:'bank'` 的現金流交易依 `importBatch` 聚合
 * （筆數／存提日範圍／收入・支出・內轉金額／匯入時間），依匯入時間新到舊。給收支頁「匯入紀錄」用。 */
export function listBankBatches() {
  const db = getDb();
  /** @type {Record<string, any>} */
  const groups = Object.create(null);   // null-proto：批次 id 雖是 uid，仍防 '__proto__' 之類值累加到全域原型（比照 statement-import 的 listBatches）
  for (const t of db.transactions || []) {
    if (t.source !== 'bank' || !t.importBatch) continue;
    const g = groups[t.importBatch] || (groups[t.importBatch] = {
      batchId: t.importBatch, importedAt: t.importedAt || '',
      count: 0, income: 0, expense: 0, transfer: 0, minDate: t.date, maxDate: t.date,
    });
    g.count++;
    const amt = Number(t.amount) || 0;
    if (t.type === 'income') g.income += amt;
    else if (t.type === 'expense') g.expense += amt;
    else if (t.type === 'transfer') g.transfer += amt;
    if (t.date && t.date < g.minDate) g.minDate = t.date;
    if (t.date && t.date > g.maxDate) g.maxDate = t.date;
  }
  return Object.values(groups).sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
}

/** 刪除整批銀行對帳單匯入：把該批次的現金流交易全部移除（分箱不對／要換一份帳單重匯時）。
 * **雙重比對** `source==='bank' && importBatch===id`——絕不誤刪手動記帳或信用卡帳單（就算 batchId 撞號）。
 * ⚠️不回滾帳戶餘額：餘額是「當前快照」、未逐批留存舊值；重新上傳同帳單會依現值參考日重設
 *（同期＝相等則跳過、餘額已正確）。 @param {string} batchId */
export function deleteBankBatch(batchId) {
  const db = getDb();
  const id = String(batchId || '');
  if (!id) throw apiError(400, '缺少批次代號');
  const before = (db.transactions || []).length;
  db.transactions = (db.transactions || []).filter(t => !(t.source === 'bank' && t.importBatch === id));
  const removed = before - db.transactions.length;
  saveDb(db);
  return { ok: true, removed };
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
