// @ts-check
// 銀行對帳單匯入（三層重構 stage 2/3 服務層）。stage 2＝概要區→更新/自動建帳戶餘額（本檔）。
// 密碼＝身分證字號，只在記憶體傳給解析器、絕不落檔；帳單原始 PDF 不持久化。
import { getDb, saveDb, uid } from '../repo.js';
import { parseBankStatement, accountSuffix } from '../bank-statement.js';
import { reconcileBankStatement, gateFailureMessage } from '../statement-reconcile.js';
import { cleanStore, normalizeDesc } from '../statement.js';   // 收支說明過濾器（2026-07-27）：簽帳卡刷卡消費走信用卡同一條店名管線
import { CURRENCIES, isRealDate } from '../schema.js';
import { resolveImportCategory, resolveImportIncome, conformTransferSub, replayTransferSub, transferSubRole } from './categories.js';
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

/** 從 bankRef（`bank|遮罩帳號|日期|方向|金額|…`，尾可能綴 `#N`）取原始金流方向；取不到回 null。bankRef 是匯入當下
 * 寫死的去重鍵、**不隨使用者改分類而變**＝比 type/子類可靠（帳號/日期不含 `|`，方向固定在第 4 段）。 @param {any} ref */
function bankDirFromRef(ref) {
  const d = String(ref || '').split('|')[3];
  return (d === 'in' || d === 'out') ? d : null;
}

/** 一筆**既有**銀行交易的實際金流方向。優先序＝①匯入存好的 `dir`（不可竄改）②`bankRef` 第 4 段的原始方向（舊資料無
 * dir 時的權威來源——比可能被改錯的分類可靠，Codex r13 複審#1：舊批次可能留下「bankRef=out 但子類=內轉入」的不一致）
 * ③最後才從 type/子分類推（連 bankRef 都缺/壞的殘缺資料）：income→in、expense→out、內轉出/內轉入角色→out/in、
 * 交割(settle)/未知→null。null＝方向不明，呼叫端須保守處理（不硬套收入/支出）。 @param {any} db @param {any} t @returns {'in'|'out'|null} */
function txDirection(db, t) {
  if (t.dir === 'in' || t.dir === 'out') return t.dir;
  const fromRef = bankDirFromRef(t.bankRef);
  if (fromRef) return fromRef;
  if (t.type === 'income') return 'in';
  if (t.type === 'expense') return 'out';
  if (t.type === 'transfer') {
    const role = transferSubRole(db, String(t.subcategory || ''));
    if (role === 'out') return 'out';
    if (role === 'in') return 'in';
  }
  return null;
}

/** 分箱（含學習）：先查 learnedBank（使用者教過的：以摘要＋對方帳號為鑰匙），命中且**方向相容**才用學過的 type/分類＋
 * 自訂顯示名；否則（沒學過／方向不符）落 classifyBankTx 關鍵字規則（它自帶方向護欄）。內轉的出/入子類一律依本筆方向，
 * 不套用學到的方向（同鑰匙的反向交易才不會被貼錯內轉出/入）。回 {bankKey, cls, name}。
 * @param {any} db @param {import('../bank-statement.js').BankTx} tx @param {Set<string>} own */
function classifyWithLearning(db, tx, own) {
  const bankKey = bankKeyOf(tx.summary, tx.note);
  const learned = (bankKey && !isProtoKey(bankKey)) ? getOwn(db.learnedBank || {}, bankKey) : null;
  if (learned && learned.type && learned.category != null && learnedTypeFitsDirection(learned.type, tx.direction)) {
    // 內轉子分類依**角色**重播（Codex r13#4）：out/in 角色隨本筆方向取現名、settle（交割）方向中性保留、
    // 自訂子類原樣——不再字面比對「交割」（角色改名後字面就對不上，會把交割誤翻成內轉出/入）。
    const subcategory = learned.type === 'transfer'
      ? replayTransferSub(db, learned.subcategory || '', tx.direction)
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
  // ⚠️「學習」需要可用的 bankKey＋合法 type；但「清空說明→回自動名」是**顯示層**、與能不能學無關——
  // 光禿摘要（存款息/利息）沒有可學的 bankKey，一樣要回自動名（使用者回報 2026-07-21：清空後停在空白）。
  // 故把回復放在最後、獨立於學習區塊；學習照舊只在 canLearn 時做。
  const canLearn = Boolean(bankKey) && !isProtoKey(bankKey) && ['income', 'expense', 'transfer'].includes(item.type);
  if (canLearn) {
    const lb = (db.learnedBank ||= {});
    const e = getOwn(lb, bankKey) || {};
    e.type = item.type;
    e.category = item.category || '';
    e.subcategory = item.subcategory || '';
    // 顯示名：這次真的改了 note 才記；改成空＝清除自訂名（＝自然的「還原成自動」路徑）。
    // ⚠️刻意**不做**信用卡那種「auto 名自我修剪」（對抗審查 r2 裁定）：卡片顯示名會隨分類自動重算（note 跟著分類走），
    // 才需分辨「因改分類而變的 auto 名 vs 真自訂名」；銀行的 note 是**靜態原文、不隨分類重算**，使用者改什麼就是什麼。
    const noteChanged = Boolean(prev) && String(item.note || '') !== String(prev.note || '');
    if (noteChanged) { if (item.note) e.name = item.note; else delete e.name; }   // 清空＝清除學過的自訂名
    setOwn(lb, bankKey, e);
  }
  // 空說明 → 回復預設自動名（放最後、避免把回復的 autoNote 誤當自訂名學進去）。使用者定 2026-07-21。
  // ⚠️**不限「這次才清空」**：銀行交易的說明**永遠不該是空白**（至少顯示摘要）——先前 early-return 的 bug 已把一批
  //   存款息洗成空白，故「只要是空的就回自動名」，讓那些舊資料一經編輯儲存就自動補回（使用者回報 2026-07-22）。
  // ⚠️ autoNote 欄同步跟上（Codex #307 r1 抓到的縫）：只更新 note 不更新 autoNote，會留下 note≠autoNote 的
  //   「孤兒自動名」——下次過濾器改版時被 reconcile 的 isAuto 判準（note===autoNote）誤判成使用者自訂、永遠停在舊版。
  if (!String(item.note || '')) { item.note = bankAutoNote(item, db); if (item.note) item.autoNote = item.note; }
}

// ---------- 收支說明過濾器（使用者定 2026-07-27）----------
// 台新對帳單的「摘要・備註」原文機器味重（CD轉出・數位跨行 824-00001110****6146 Ｗｅｉ），
// 翻成人話再當顯示名。三段式：①摘要詞對照（CD轉出→現金轉出…）②備註清理（剝通路詞、帳號尾註入括號、
// 行內轉帳對回自己帳戶名、ATM 詞、刷卡消費走 cleanStore 店名管線）③「摘要・備註」組回。
// **只動顯示層**：bankKey（學習鑰匙）與 bankRef（去重鍵）仍用原始 summary＋note，學習與去重不受影響。
/** 摘要詞對照：全等比對（原詞→顯示詞）。「媒體轉帳」不在表內＝依方向分流（見函式內）。 */
const SUMMARY_DISPLAY = new Map([
  ['CD轉出', '現金轉出'], ['CD轉入', '現金轉入'], ['CD提款', '現金提款'],   // CD轉入＝使用者補 2026-07-27 二修
  ['轉帳支取', '現金轉出'], ['轉帳存入', '現金存入'],
  ['媒體轉出', '現金轉出'], ['媒體轉入', '現金轉入'],
  ['跨轉手續費', '跨轉手續'],
  ['存款息', '存款利息'],   // 使用者定 2026-07-27 二修（分類判準用原始 summary、不受顯示影響）
]);
/** 遮罩帳號樣式（含可選的他行代碼前綴 824-…）。 */
const MASKED_ACCT_RE = /\d[\d-]*\*{2,}\d+/;
/** 自己的現金帳戶名（末碼比對）。**用帳戶全名、不剝尾括號**（使用者定 2026-07-27 二修）：
 * 「台新活儲（松德）」與「台新活儲（Richart）」剝掉括號就分不出錢轉進哪一個——括號正是身分。
 * 帶「-」的他行代碼帳號不查（824-…6146 是對方在他行的帳號，末碼撞到自己帳戶純屬巧合、不可誤標「轉入到：」）。
 * @param {any} db @param {string} acct 遮罩帳號全串 @returns {string|null} */
function ownAccountNameByAcct(db, acct) {
  const s = String(acct || '');
  if (s.includes('-')) return null;
  const m = s.match(/\*{2,}(\d+)\s*$/);
  const suf = m ? m[1] : '';
  if (suf.length < 3) return null;
  const acc = (db.accounts || []).find(a => (a.type || 'cash') === 'cash'
    && String(a.accountNo || '').replace(/\D/g, '').endsWith(suf));
  return acc ? String(acc.name).trim() || null : null;
}
/**
 * 「摘要・備註」→ 好讀顯示名（純函式）。
 * @param {string} summary 原始摘要 @param {string} note 原始備註
 * @param {{direction?: 'in'|'out'|null, accountNameOf?: (acct: string) => string|null}} [opts]
 *   direction＝金流方向（「媒體轉帳」靠它分流成轉入/轉出）；accountNameOf＝遮罩帳號→自己帳戶主體名
 *   （行內轉帳的「轉入/轉出<帳號>」翻成「轉入到：/轉出自：<帳戶名>」；回 null＝不是自己的、保留帳號）。
 * @returns {string}
 */
export function bankDisplayNote(summary, note, opts = {}) {
  const { direction = null, accountNameOf = () => null } = opts;
  const sRaw = String(summary || '').trim();
  // ①摘要詞：媒體轉帳依方向分流（它是「代收付媒介」、名字看不出進出；方向不明＝原樣不硬猜）
  const s = sRaw === '媒體轉帳'
    ? (direction === 'in' ? '現金轉入' : direction === 'out' ? '現金轉出' : sRaw)
    : (SUMMARY_DISPLAY.get(sRaw) || sRaw);
  // ②備註：先 NFKC 半形化（Ｗｅｉ→Wei、ｍｏｍｏ＊→momo*；只動顯示、原始 note 原封不動）
  let n = String(note || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (/^刷卡消費$/.test(sRaw)) {
    // 刷卡消費（簽帳卡）＝店名——走信用卡同一條 cleanStore 管線（含 momo/Apple 等全部內建規則），
    // 兩邊同一家店才長同一個樣子。normalizeDesc 先統一異體字/全形（同帳單解析入口）。
    n = n ? cleanStore(normalizeDesc(n)) : n;
  } else {
    n = n.replace(/^(?:數位跨行|簽帳卡)\s*/, '')                     // 通路詞（不是對方身分）
      .replace(/電支扣款\s*$/, '')                                   // 全支付電支扣款 → 全支付
      .replace(/^ATM\/跨行交易$/, 'ATM 跨行提領')
      .replace(/^ATM\/自行交易$/, 'ATM 本行提領');
    // 行內轉帳「轉入/轉出<帳號>」：對到自己帳戶＝翻成「轉入到：/轉出自：<帳戶名>」（搬錢去哪／從哪來，
    // 一眼看懂）；對不到（給別人的）＝剝掉「轉入/轉出」動詞、保留帳號（摘要已有方向，動詞是重複資訊）。
    // 無「-」的遮罩帳號＝台新行內格式 → 顯示補台新代碼「812-」（使用者定 2026-07-27 二修：與他行帳號
    // 824-…/808-… 格式一致、一眼看出是台新帳戶）。只動顯示；bankKey/bankRef 仍用原始備註。
    const displayAcct = (/** @type {string} */ a) => a.includes('-') ? a : `812-${a}`;
    const xfer = n.match(new RegExp(`^(轉入|轉出)\\s*(${MASKED_ACCT_RE.source})\\s*(.*)$`));
    if (xfer) {
      const own = accountNameOf(xfer[2]);
      const tail = xfer[3].trim();
      if (own) n = (xfer[1] === '轉入' ? `轉入到：${own}` : `轉出自：${own}`) + (tail ? `（${tail}）` : '');
      else n = displayAcct(xfer[2]) + (tail ? `（${tail}）` : '');
    } else {
      // 帳號＋尾註（CD轉出類：824-00001110****6146 Wei）：尾註（人名/用途）收進括號
      const acctTail = n.match(new RegExp(`^(${MASKED_ACCT_RE.source})(?:\\s+(.+))?$`));
      if (acctTail) n = displayAcct(acctTail[1]) + (acctTail[2] ? `（${acctTail[2].trim()}）` : '');
    }
    n = n.replace(/([一-鿿])(?=[A-Za-z0-9])/g, '$1 ');               // 中文貼英數＝補空格（基金配息00953B → 基金配息 00953B）
  }
  n = n.trim();
  return n ? `${s}・${n}` : s;
}

/** 銀行交易的「預設自動顯示名」。有 db＝套收支說明過濾器（2026-07-27 起的新格式：好讀版）；
 * 無 db（測試/退化）＝舊組法「摘要・原始備註」。來源：匯入存好的 bankRef 尾兩段（summary｜note，
 * 去掉批內出現序 #N）；連 bankRef 都缺＝退回既存 autoNote 欄。清空自訂說明時回復到它。
 * @param {any} t @param {any} [db] */
function bankAutoNote(t, db) {
  const parts = String(t.bankRef || '').split('|');
  if (parts[0] === 'bank' && parts.length >= 8) {
    const summary = parts[6];
    const note = parts.slice(7).join('|').replace(/#\d+$/, '');   // note 可能含 '|'：第 7 段起全取回；末尾 #N＝出現序，非原文
    if (db) return bankDisplayNote(summary, note, { direction: bankDirFromRef(t.bankRef), accountNameOf: (a) => ownAccountNameByAcct(db, a) });
    return [summary, note].filter(Boolean).join('・');
  }
  return t.autoNote ? String(t.autoNote) : '';
}

/** 已學的銀行收支規則清單（設定頁「銀行收支學習」檢視用）：learnedBank 攤成陣列，鑰匙拆成可讀的「摘要／對方」。
 * key 形如「摘要|#帳號」或「摘要|描述」。 */
export async function listLearnedBank() {
  const lb = (await getDb()).learnedBank || {};
  return Object.entries(lb).map(([key, e]) => {
    const i = key.indexOf('|');
    const summary = i >= 0 ? key.slice(0, i) : key;
    const rest = i >= 0 ? key.slice(i + 1) : '';
    const counterparty = rest.startsWith('#') ? rest.slice(1) : rest;   // #帳號 去掉井號；描述原樣
    return { key, summary, counterparty, type: e.type, category: e.category || '', subcategory: e.subcategory || '', name: e.name || '' };
  });
}

/** 刪除一筆已學的銀行收支規則（教錯了的救援路徑之一）。 @param {string} key */
export async function deleteLearnedBank(key) {
  const db = await getDb();
  const k = String(key || '');
  // hasOwn 而非 in（同 deleteLearned/Codex r5#1）：只刪真的存在的自有鍵，不查原型鏈
  if (db.learnedBank && Object.hasOwn(db.learnedBank, k)) delete db.learnedBank[k];
  await saveDb(db);
  return { ok: true };
}

/** 「同類一起改」的**純 in-db 工作函式**（護欄 G3，2026-07-22）：套 bankKey 學過的規則到所有既有同鑰匙的銀行交易，
 * **不自己讀寫檔**——供「編輯＋一起改」原子路徑（crud.js PUT applyAll）在**同一次寫檔**內連同單筆編輯一起落地，
 * 免前端兩次寫、中途失敗半套用。以 learnedBank 為準（剛學好的 type/分類；有自訂名才覆蓋 note、否則各自 note 保留）。
 * **逐筆過方向護欄**（Codex r13#2）：收入只套進帳、支出只套出帳、內轉可兩向但子分類依本筆方向重播
 * （out→內轉出/in→內轉入/交割中性）；方向不符者略過並計入 skipped。分類過生效樹校正。保留字/找不到目標＝明確 400/404。
 * @param {any} db @param {string} bankKey @returns {{changed:number, skipped:number}} */
export function applyLearnedBankToDb(db, bankKey) {
  const key = String(bankKey || '').trim();
  if (!key) throw apiError(400, '缺少學習鑰匙');
  if (isProtoKey(key)) throw apiError(400, `「${key}」是程式保留字，不可能是真的學習鑰匙`);
  const learned = getOwn(db.learnedBank || {}, key);
  if (!learned || !learned.type) throw apiError(404, '這筆還沒有學過的規則，無法套用到同類');
  const name = typeof learned.name === 'string' ? learned.name : '';
  const targets = (db.transactions || []).filter(t => t.source === 'bank' && String(t.bankKey || '') === key);
  if (!targets.length) throw apiError(404, `找不到鑰匙「${key}」的銀行交易`);
  let changed = 0, skipped = 0;
  for (const t of targets) {
    // ⚠️**逐筆方向護欄**（Codex r13#2，高）：同鑰匙可同時有進帳與出帳（如對同一人有轉出也有收款）——收入規則
    //   只可套進帳、支出規則只可套出帳，否則會把出帳無聲改成收入＝毀現金流（生存優先）。內轉可套兩向，
    //   但子分類要依**本筆自己的方向**（out→內轉出、in→內轉入、交割中性保留），不可整批套同一個。
    const dir = txDirection(db, t);
    const fits = learned.type === 'transfer' ? true : (dir ? learnedTypeFitsDirection(learned.type, dir) : false);
    if (!fits) { skipped++; continue; }   // 方向不符（或方向不明的舊資料套收支）＝略過、不誤改
    const rawSub = learned.type === 'transfer' ? replayTransferSub(db, learned.subcategory || '', dir) : (learned.subcategory || '');
    const cls = resolveCls(db, { type: learned.type, category: learned.category || '', subcategory: rawSub });
    const newNote = name || t.note;
    if (t.type === cls.type && t.category === cls.category && (t.subcategory || '') === (cls.subcategory || '') && (t.note || '') === (newNote || '')) continue;
    t.type = /** @type {'income'|'expense'|'transfer'} */ (cls.type); t.category = cls.category; t.subcategory = cls.subcategory;
    if (name) t.note = name;   // 有自訂名才覆蓋顯示說明；沒有就保留各自原始 note
    changed++;
  }
  return { changed, skipped };
}

/** 標準端點薄殼（POST /bank-tx/apply-learned，維護／相容用）：讀→套→寫。前端主流程已改走原子 PUT applyAll（G3）。
 * @param {string} bankKey @returns {Promise<{changed:number, skipped:number}>} */
export async function applyLearnedBankToExisting(bankKey) {
  const db = await getDb();
  const r = applyLearnedBankToDb(db, bankKey);
  await saveDb(db);
  return r;
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
  if (cls.type === 'transfer') {
    // 內轉子分類過使用者的現行清單（內轉出/內轉入/交割 改名→現名、刪除→空）——使用者定 2026-07-21「全部都能改」
    return { ...cls, subcategory: conformTransferSub(db, cls.subcategory) };
  }
  return cls;
}

/** 「自己帳號末碼」集合＝帳單自己的帳戶（含 3 碼外幣末碼）∪ 使用者登記過 accountNo 的**現金**帳戶（供內轉判定）。
 * 對抗審查：①**只認現金帳戶**（登記房貸/信用卡帳戶不算自己人，繳款仍是支出、不被當內轉排除）②登記帳戶
 * **只用 4 碼**（3 碼太短會誤中無關第三方的遮罩帳號→真金流被當內轉靜默排除）；真 3 碼外幣帳戶靠帳單自己的
 * pa.suffix 涵蓋。
 *
 * ⚠️ **`parsed.accounts` 不等於「帳單上的所有帳戶」**（2026-07-28 修，Codex 重審抓到）：
 * `parseBankSummary` 對「餘額欄空白」的帳戶（台新對透支／負餘額帳戶就是留空）**刻意只記幣別、
 * 不進 accounts**（那份清單的用途是「餘額更新」，沒有餘額就沒得更新）。但它仍然是**你自己的帳戶**——
 * 漏掉它的後果：轉錢給那個帳戶會被判成「支出」、從它轉回來會被判成「收入」，
 * 現金流兩個方向都髒掉，而且**每一期都會錯**——`applyBalancesToDb` 同樣只走 parsed.accounts，
 * 所以那個帳戶永遠不會被自動建進 db、也就永遠補不進下面那個迴圈。
 * 修法＝把 `accountCurrency`（帳單上**所有**帳戶的完整清單）的遮罩帳號也算進來。
 * 信任等級與 `pa.suffix` 相同（同樣來自帳單自己的概要區），不鬆動「登記帳戶只用 4 碼」那道護欄。
 * @param {any} db @param {ParsedBank} parsed */
function ownSuffixSet(db, parsed) {
  const set = new Set();
  for (const pa of parsed.accounts || []) if (pa.suffix) set.add(pa.suffix);
  for (const masked of Object.keys(parsed.accountCurrency || {})) {
    const s = accountSuffix(masked);
    if (s) set.add(s);
  }
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

/** 把既有**銀行交易**的顯示帳戶名，對齊到「用遮罩帳號比對到的現有帳戶」現名（使用者定 2026-07-21「改一次、處處同步」）。
 * ⚠️ 用 `matchAccount` 的**身分比對（遮罩帳號＝bankRef 第 2 段）**，不靠可能過期的顯示字串——所以帳戶匯入時叫「台新 8791」、
 * 之後使用者改成「【台新】活儲（Richart）」，這裡仍認得出、把舊交易一併對齊。純函式（改 db、不寫檔）。回改動筆數。
 * @param {any} db @returns {number} */
export function reconcileBankTxAccountNames(db) {
  const accounts = db.accounts || [];
  let changed = 0;
  for (const t of db.transactions || []) {
    if (t.source !== 'bank' || !t.bankRef) continue;                 // 只對齊有身分（bankRef 遮罩帳號）的銀行交易
    const masked = String(t.bankRef).split('|')[1] || '';
    const { suffix } = maskedParts(masked);
    if (!suffix) continue;
    const acc = matchAccount(accounts, { suffix, masked, currency: 'TWD' });   // 銀行匯入只進 TWD（外幣明細不匯入），故一律以 TWD 比對
    if (acc && t.account !== acc.name) { t.account = acc.name; changed++; }
  }
  return changed;
}

/** 開 app 自動修正銀行交易顯示（比照 snapshot/auto、normalize-auto）：①帳戶改名後既有交易顯示名沒跟上
 * ②被 early-return bug 洗成空白的說明（空 note → 自動名）③既有說明升級成過濾器好讀版（2026-07-27）——
 * 只動「仍是自動名」的（note＝存好的 autoNote 或舊組法「摘要・原始備註」）；使用者自訂過的一字不動。
 * autoNote 欄無條件跟上新格式（之後清空自訂說明時回復到的也是好讀版）。零操作、僅在有變動時寫檔。
 * @returns {Promise<{changed:number}>} */
export async function reconcileAccountNamesAuto() {
  const db = await getDb();
  let changed = reconcileBankTxAccountNames(db);
  for (const t of db.transactions || []) {
    if (t.source !== 'bank') continue;
    const cur = String(t.note || '');
    const fresh = bankAutoNote(t, db);           // 新格式（bankRef 反解＋過濾器）；反解不了＝''
    if (!fresh) {                                 // 連 bankRef 都缺的殘缺資料：維持舊行為（空 note 補 autoNote 欄）
      if (!cur && t.autoNote) { t.note = String(t.autoNote); changed++; }
      continue;
    }
    // 「仍是自動名」判準（改 autoNote 欄**之前**先判，別把判準蓋掉）：空白／＝存好的 autoNote／＝舊組法原文
    const parts = String(t.bankRef || '').split('|');
    const legacyAuto = [parts[6], parts.slice(7).join('|').replace(/#\d+$/, '')].filter(Boolean).join('・');
    const isAuto = !cur || cur === String(t.autoNote || '') || cur === legacyAuto;
    let touched = false;
    if (isAuto && cur !== fresh) { t.note = fresh; touched = true; }
    if (String(t.autoNote || '') !== fresh) { t.autoNote = fresh; touched = true; }
    if (touched) changed++;
  }
  if (changed) await saveDb(db);
  return { changed };
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
    // 學過自訂顯示名優先；否則走收支說明過濾器（2026-07-27：摘要詞對照＋備註清理的好讀版）
    const displayNote = name || bankDisplayNote(tx.summary, tx.note, { direction: tx.direction, accountNameOf: (a) => ownAccountNameByAcct(db, a) });
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
    // 預設自動顯示名＝收支說明過濾器的好讀版（2026-07-27；bankKey/bankRef 仍用原始 summary+note、學習與去重不受影響）
    const autoNote = bankDisplayNote(tx.summary, tx.note, { direction: tx.direction, accountNameOf: (a) => ownAccountNameByAcct(db, a) });
    const noteText = name || autoNote;                                          // 學過自訂顯示名優先
    (db.transactions ||= []).push({
      id: uid(), date: tx.date, type: cls.type, category: cls.category, subcategory: cls.subcategory,
      amount: tx.amount, account: accountNameForTx(db, tx, parsed), note: noteText,
      // dir＝本筆實際金流方向（in/out）＝不可竄改的事實，供「同類一起改」逐筆方向護欄用（Codex r13#2）；
      // amount 是無正負的金額，type 又可能被使用者改錯，唯有 dir 忠實記錄錢進錢出。服務層寫、非 CRUD 白名單。
      // autoNote＝預設自動顯示名：使用者把自訂說明清空時回復到它（使用者定 2026-07-21）。服務層寫、非 CRUD。
      ledger: 'cashflow', source: 'bank', dir: tx.direction, autoNote, bankRef, bankKey, importBatch: batchId, importedAt,
    });
    imported++;
  }
  return { imported, skipped, foreign, batchId };
}

// ---------- 匯入批次管理（讓「匯入紀錄」可整批刪除重匯，比照信用卡帳單）----------

/** 銀行對帳單匯入批次清單：把 `source:'bank'` 的現金流交易依 `importBatch` 聚合
 * （筆數／存提日範圍／收入・支出・內轉金額／匯入時間），依匯入時間新到舊。給收支頁「匯入紀錄」用。 */
export async function listBankBatches() {
  const db = await getDb();
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
export async function deleteBankBatch(batchId) {
  const db = await getDb();
  const id = String(batchId || '');
  if (!id) throw apiError(400, '缺少批次代號');
  const before = (db.transactions || []).length;
  db.transactions = (db.transactions || []).filter(t => !(t.source === 'bank' && t.importBatch === id));
  const removed = before - db.transactions.length;
  await saveDb(db);
  return { ok: true, removed };
}

/** 對帳閘（P0，2026-08-11）：驗「帳單自己的數學」（強閘＝餘額鏈＋末筆對概要；判準在 statement-reconcile.js）。
 * 不一致＝整份 400 擋下（fail-closed：寧可暫時不能匯入，不把錯的數字記進帳本）；沒數字可對＝降級放行。
 * 預覽與套用**兩個入口都要過**——apply 會重新解析同一份檔案，寫入路徑自己也要 fail-closed，
 * 不可只擋預覽（繞過預覽直打 apply 的路要一樣安全）。 @param {ParsedBankFull} parsed */
export function assertBankReconciled(parsed) {
  const gate = reconcileBankStatement(parsed);
  if (!gate.ok) throw apiError(400, gateFailureMessage(gate, '銀行對帳單'));
  return gate;
}

/** 預覽（解析 PDF → 對帳閘 → 純邏輯）：回帳戶餘額變動＋交易分箱＋對帳裁決三塊。 @param {string} b64 @param {string=} password */
export async function previewBankStatement(b64, password) {
  const parsed = await parseBankStatement(decode(b64), password);
  const reconcile = assertBankReconciled(parsed);   // 對不上＝這裡就 400（前端既有錯誤路徑會原句顯示）
  const db = await getDb();
  return { ...previewBalancesForDb(db, parsed), transactions: previewBankTxForDb(db, parsed), reconcile };
}

/** 套用（解析 PDF → 對帳閘 → 更新餘額＋匯入交易 → 一次寫檔）。 @param {string} b64 @param {string=} password */
export async function applyBankStatement(b64, password) {
  const parsed = await parseBankStatement(decode(b64), password);
  assertBankReconciled(parsed);   // 寫入路徑 fail-closed（見 assertBankReconciled 註解）
  const db = await getDb();   // PDF 解析（外部 IO）完成後才讀整包；讀→套→寫之間無外部 IO await
  const bal = applyBalancesToDb(db, parsed);
  const tx = importBankTxToDb(db, parsed);
  await saveDb(db);
  return { ok: true, ...bal, transactions: tx };
}
