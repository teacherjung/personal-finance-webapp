// @ts-check
// 銀行對帳單匯入（三層重構 stage 2/3 服務層）。stage 2＝概要區→更新/自動建帳戶餘額（本檔）。
// 密碼＝身分證字號，只在記憶體傳給解析器、絕不落檔；帳單原始 PDF 不持久化。
import { getDb, saveDb, uid } from '../repo.js';
import { parseBankStatement, extractBankLines, accountSuffix } from '../bank-statement.js';
import { reconcileBankStatement, gateFailureMessage, statementCurrencyLookup, BAL_EPS } from '../statement-reconcile.js';
import { parseWithPool, statementPasswordPool } from './statement-import.js';   // 匯入密碼池（P0.5）：銀行與信用卡同一套嘗試序
// ⚠️ P1b-1 的 import 紀律：lib/ai-parse.js 是**純模組**（schema／提示／驗收／文字，零外連）＝可以進來；
// 字面 fetch 只住 lib/ai-transport.js，**本檔絕不可 import 它**——本檔被 crud.js 等動態路徑路由檔
// import，外連能力沿 import 閉包傳染會讓外連登記閘（hosted-auth 反向對帳）正確地紅。真引擎由路由層
// （lib/routes/statement.js，全靜態路徑、可審計）用 makeAnthropicBankEngine 組成 engineFactory 注入。
import { linesToText, normalizeAiBank, assertAiBankGrounded } from '../ai-parse.js';
import { recipeMatches, parseWithRecipe, validateRecipeStrict, validateRecipeAgainstStatement, recipeReproduces } from '../parse-recipe.js';   // 配方快取（P2-2/P2-3）：同版式 app 內解＋出生三關
import { RECIPE_MODEL, pickRecipeCandidate } from '../ai-parse.js';
import { saveParseRecipe } from '../repo.js';
import { issueAiTicket, redeemAiTicket, restoreAiTicket } from '../ai-confirm-ticket.js';   // AI 預覽確認票（r4#1：AI 非確定性，apply 不可自己重跑模型）
import { isHosted } from '../hosted.js';   // AI 路線的 HOSTED 停止線（P1b-1）
import { cleanStore, normalizeDesc } from '../statement.js';   // 收支說明過濾器（2026-07-27）：簽帳卡刷卡消費走信用卡同一條店名管線
import { CURRENCIES, isRealDate } from '../schema.js';
import { resolveImportCategory, resolveImportIncome, conformTransferSub, replayTransferSub, transferSubRole } from './categories.js';
import { getOwn, setOwn, isProtoKey } from '../safe-map.js';

/** @param {number} status @param {string} msg @param {string} [code] 機器可讀錯誤碼（P0.5 pdf_password 通道同款；P1b-1 起 AI 路線用） */
const apiError = (status, msg, code) => Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });
const decode = (/** @type {string} */ b64) => {
  if (!b64) throw apiError(400, '沒有收到檔案內容');
  return new Uint8Array(Buffer.from(b64, 'base64'));
};

/** 遮罩帳號拆「可見前綴＋可見末碼」（900100****3301 → {prefix:'900100', suffix:'3301'}）。 @param {string} masked */
function maskedParts(masked) {
  const m = String(masked || '').replace(/\s/g, '').match(/^(\d+)\*+(\d+)$/);
  return m ? { prefix: m[1], suffix: m[2] } : { prefix: '', suffix: '' };
}

/** 這份帳單的開戶機構（P1a 銀行身分維度）。缺席＝'台新'——祖父條款：機構維度之前的整條產線
 * （既有解析器、既有測試的合成 parsed）都只有台新，缺席的語意就是「台新時代的資料」。 @param {{bank?:string}} parsed */
function stmtBank(parsed) {
  return String((parsed && parsed.bank) || '台新');
}

/**
 * 找帳單這筆對應的既有帳戶——對抗審查強化（避免財務資料靜默損毀，生存優先）：
 * ①**只比對現金帳戶**（自動建的都是 cash）——否則尾碼碰巧相同的負債/保單/投資帳戶餘額會被覆蓋、負債翻成資產、淨資產算錯。
 * ②**可見前綴＋末碼都要對**（遮罩露出 900100 vs 900200）——只比末碼（3~4 碼）會讓不相干帳戶尾碼碰撞而錯戶覆蓋。
 * ③在 `existing` 快照上比對（呼叫端傳匯入前的帳戶快照）——否則同一張帳單裡兩筆會比對到「本批剛新建的那筆」而互吃。
 * ④**機構維度（P1a）**：帳戶記了開戶機構（a.bank）就必須與帳單機構一致——不同銀行的相同可見帳號段不可互相
 *   覆蓋餘額。a.bank 缺席（機構維度之前建的帳戶、手動建立的帳戶）＝照舊只比數字；誠實劃界：這條祖父路徑
 *   仍有「舊帳戶與未來他行帳單可見數字全同」的理論碰撞（前綴＋末碼都得撞、機率極低），要關死得等帳戶補登機構。
 * @param {any[]} existing 匯入前的帳戶快照 @param {{suffix:string, masked:string, currency:string}} pa
 * @param {string} [bank] 帳單的開戶機構（匯入端傳 stmtBank(parsed)；reconcileBankTxAccountNames 對舊格式列傳 '台新'＝祖父身分。祖父的「寬鬆」由**帳戶側** a.bank 缺席承擔，不靠呼叫端缺席——正式呼叫端一律有傳）
 */
function matchAccount(existing, pa, bank) {
  const suffix = pa.suffix;
  if (!suffix) return null;
  const { prefix } = maskedParts(pa.masked);
  return existing.find(a => {
    if ((a.type || 'cash') !== 'cash') return false;                               // 只更新現金帳戶
    if (a.bank && bank && a.bank !== bank) return false;                           // 機構維度：登記過機構的帳戶不可跨行比對（P1a）
    if ((a.currency || 'TWD') !== (pa.currency || 'TWD')) return false;
    const d = String(a.accountNo || '').replace(/\D/g, '');
    if (d.length < suffix.length || !d.endsWith(suffix)) return false;
    return !prefix || d.startsWith(prefix);                                         // 可見前綴也要對（免尾碼碰撞）
  }) || null;
}

/** 自動建立帳戶的預設名（使用者可改）。 @param {{suffix:string,label:string,note:string}} pa @param {string} bank 開戶機構 */
function autoName(pa, bank) {
  const tag = (pa.note || pa.label || '').trim();
  return `${bank} ${pa.suffix}${tag ? `（${tag}）` : ''}`;
}

/** @typedef {{ bank?:string, referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[], accountCurrency?:Record<string,string> }} ParsedBank */

/**
 * 預覽（純函式、不寫檔）：對照既有帳戶，列出每筆「會更新／會新建／因帳單較舊而跳過」。
 * @param {any} db @param {ParsedBank} parsed
 */
export function previewBalancesForDb(db, parsed) {
  const ref = parsed.referenceDate;
  const bank = stmtBank(parsed);
  // ⚠️ `blocked` ＝「**這次不會更新餘額**」，**不是**「整份擋下」——交易照樣匯入。
  //    欄位名容易讓人誤讀成後者，所以在這裡講死：不要照名字推論行為。
  const blocked = !ref || !isRealDate(ref);
  const existing = [...(db.accounts || [])];
  const rows = parsed.accounts.map(pa => {
    if (!CURRENCIES.includes(pa.currency)) {
      return { suffix: pa.suffix, currency: pa.currency, balance: pa.balance, label: pa.label, matchedName: null, oldBalance: null, action: 'unsupported' };
    }
    const acc = matchAccount(existing, pa, bank);
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
  const bank = stmtBank(parsed);
  // ⚠️ **讀不到現值參考日＝只跳過「更新餘額」，不再整份退回**（William 2026-08-13）：
  //    交易明細**根本用不到**這個日期（importBankTxToDb 從頭到尾沒讀它），只有「這份帳單的餘額
  //    比 app 裡的新嗎」才需要。以前整份 throw 等於因為一個欄位讀不到，把整批交易也一起擋掉。
  //    ⚠️ 保守的部分**一點都沒放寬**：不知道新舊就**絕不覆蓋餘額**（拿舊的蓋掉新的是無聲毀資料，
  //    這個專案最嚴重的一族）。差別只在「不覆蓋」不再連坐到交易。
  //    ⚠️ 呼叫端必須把 `balancesSkipped` 講給使用者聽——餘額沒更新卻不說，等於畫面說謊。
  if (!ref || !isRealDate(ref)) {
    return { bank: parsed.bank || null, referenceDate: null, balancesSkipped: true,
      updated: 0, created: 0, skipped: 0, unsupported: 0, createdNames: /** @type {string[]} */ ([]) };
  }
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
    const acc = matchAccount(existing, pa, bank);
    if (acc) {
      if (acc.balanceAsOf && ref <= acc.balanceAsOf) { skipped++; continue; }      // 相等或較舊都不覆蓋（保住手動修正）
      acc.balance = pa.balance;
      acc.balanceAsOf = ref;
      updated++;
      // ⚠️ 刻意**不**在比對成功時回填 acc.bank：比對是「數字撞上」的推論、不是帳單的宣告——猜錯的餘額下一期
      // 帳單會自我修正，猜錯的機構戳卻會從此**擋掉**正確比對（硬排除），寧缺勿錯。機構戳只在「新建」時蓋。
    } else {
      const name = autoName(pa, bank);
      (db.accounts ||= []).push({
        // bank＝開戶機構（P1a）：新建帳戶蓋機構戳——這是帳單自己的宣告（parsed.bank），非推論。
        // 服務層寫、非 CRUD 白名單（同 balanceAsOf/ibCashCur 前例）；日後 matchAccount 憑它擋跨行誤配。
        id: uid(), name, type: 'cash', class: '現金', bank,
        currency: pa.currency, balance: pa.balance, accountNo: pa.masked, balanceAsOf: ref,
      });
      created++;
      createdNames.push(name);
    }
  }
  return { bank: parsed.bank || null, referenceDate: ref, balancesSkipped: false, updated, created, skipped, unsupported, createdNames };
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

/** 從 bankRef（台新 `bank|遮罩帳號|日期|方向|金額|…`；他行 `bank2|機構|遮罩帳號|日期|方向|…`——P1a 雙格式，
 * 見 bankRefBase；尾可能綴 `#N`）取原始金流方向；取不到回 null。bankRef 是匯入當下寫死的去重鍵、
 * **不隨使用者改分類而變**＝比 type/子類可靠（帳號/日期不含 `|`，方向依格式固定在第 4／第 5 段）。 @param {any} ref */
function bankDirFromRef(ref) {
  const parts = String(ref || '').split('|');
  const d = parts[0] === 'bank2' ? parts[4] : parts[3];
  return (d === 'in' || d === 'out') ? d : null;
}

/** 一筆**既有**銀行交易的實際金流方向。優先序＝①匯入存好的 `dir`（不可竄改）②`bankRef` 的原始方向——台新格式第 4 段、bank2 第 5 段，`bankDirFromRef` 雙軌解析（舊資料無
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
 * 機構維度（P1a r1#1）：無「-」＝**發單行的行內帳號**——只可對到與帳單機構相容（同機構或無戳）的帳戶，
 * 蓋過他行戳的同號帳戶不可被翻成「轉入到：」（祖父語意同 matchAccount）。
 * @param {any} db @param {string} acct 遮罩帳號全串 @param {string} [bank] 帳單開戶機構 @returns {string|null} */
function ownAccountNameByAcct(db, acct, bank) {
  const s = String(acct || '');
  if (s.includes('-')) return null;
  const m = s.match(/\*{2,}(\d+)\s*$/);
  const suf = m ? m[1] : '';
  if (suf.length < 3) return null;
  const acc = (db.accounts || []).find(a => (a.type || 'cash') === 'cash'
    && !(a.bank && bank && a.bank !== bank)
    && String(a.accountNo || '').replace(/\D/g, '').endsWith(suf));
  return acc ? String(acc.name).trim() || null : null;
}
/**
 * 「摘要・備註」→ 好讀顯示名（純函式）。
 * @param {string} summary 原始摘要 @param {string} note 原始備註
 * @param {{direction?: 'in'|'out'|null, accountNameOf?: (acct: string) => string|null, bank?: string}} [opts]
 *   direction＝金流方向（「媒體轉帳」靠它分流成轉入/轉出）；accountNameOf＝遮罩帳號→自己帳戶主體名
 *   （行內轉帳的「轉入/轉出<帳號>」翻成「轉入到：/轉出自：<帳戶名>」；回 null＝不是自己的、保留帳號）；
 *   bank＝帳單開戶機構（P1a；預設台新）——只影響「行內格式帳號補 812- 代碼」那一手（他行不補）。
 * @returns {string}
 */
export function bankDisplayNote(summary, note, opts = {}) {
  const { direction = null, accountNameOf = () => null, bank = '台新' } = opts;
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
    // 無「-」的遮罩帳號＝**發單行**的行內格式 → 台新帳單顯示補台新代碼「812-」（使用者定 2026-07-27 二修：
    // 與他行帳號 824-…/808-… 格式一致、一眼看出是台新帳戶）；非台新帳單（P1a）＝不補——那串是**該行**的
    // 行內帳號，硬掛 812- 是指鹿為馬（他行的代碼對照表等該行帳單真的進來再議）。只動顯示；bankKey/bankRef 仍用原始備註。
    const displayAcct = (/** @type {string} */ a) => (a.includes('-') || bank !== '台新') ? a : `812-${a}`;
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
  // 雙格式（P1a）：台新 bank|…＝摘要在第 7 段；他行 bank2|機構|…＝整體右移一段（機構在第 2 段，供顯示層分行）
  const isB2 = parts[0] === 'bank2';
  if ((parts[0] === 'bank' && parts.length >= 8) || (isB2 && parts.length >= 9)) {
    const summary = parts[isB2 ? 7 : 6];
    const note = parts.slice(isB2 ? 8 : 7).join('|').replace(/#\d+$/, '');   // note 可能含 '|'：摘要後全取回；末尾 #N＝出現序，非原文
    if (db) return bankDisplayNote(summary, note, { direction: bankDirFromRef(t.bankRef), accountNameOf: (a) => ownAccountNameByAcct(db, a, isB2 ? parts[1] : '台新'), bank: isB2 ? parts[1] : '台新' });
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
 * 含 note＝餘額讀不到時同日同額不同備註仍分得開）。
 * **機構維度（P1a）＝雙格式祖父條款**：台新照舊 `bank|帳號|…`——既有資料的去重鍵**一個位元組都不能變**
 * （變了＝重匯同帳單判不出重複＝現金流翻倍）；非台新用新標籤 `bank2|機構|帳號|…`——不同銀行的同字樣
 * 帳號＋同日同額不可撞成同一筆。以 parts[0] 標籤區分格式，消費者（bankDirFromRef／bankAutoNote／
 * reconcileBankTxAccountNames）雙軌解析。機構名剝 `|`（分段符不可入段）。
 * 順帶的未來性質：AI 解析路線（P1b）解台新帳單時 parsed.bank 仍是 '台新'＝產出同一副鍵——同一份帳單
 * 不論走模板或 AI 解析，去重彼此相認。 @param {import('../bank-statement.js').BankTx} tx @param {string} bank */
function bankRefBase(tx, bank) {
  const acct = tx.acctMasked || `x****${tx.acctSuffix}`;
  const tail = `${tx.date}|${tx.direction}|${tx.amount}|${tx.balance ?? ''}|${tx.summary}|${tx.note}`;
  if (bank === '台新') return `bank|${acct}|${tail}`;
  return `bank2|${String(bank).replace(/\|/g, '')}|${acct}|${tail}`;
}
/** 去重鍵＝base＋「批內第 n 次相同 base」：兩筆欄位全同且餘額讀不到(null)的真實交易不被誤去重。序號
 * 由帳單順序決定＝穩定，重匯同帳單仍正確去重。 @param {import('../bank-statement.js').BankTx} tx @param {Map<string,number>} occ @param {string} bank */
function bankRefWithOcc(tx, occ, bank) {
  const base = bankRefBase(tx, bank);
  const n = (occ.get(base) || 0) + 1; occ.set(base, n);
  return n > 1 ? `${base}#${n}` : base;
}
/** 舊版去重鍵（stage 3 初版：末碼、無出現序）——向後相容：若 db 已有用舊版匯入的銀行交易，新匯入仍認得
 * 其舊 bankRef、不重複計（去重鍵格式從末碼改成完整遮罩帳號＋出現序，不加這道會重覆匯入＝現金流翻倍）。
 * 只在台新查（P1a）：舊版鍵只可能出自機構維度之前的台新匯入，他行帳單查它＝拿無星號末碼字樣冒領。
 * @param {import('../bank-statement.js').BankTx} tx */
function bankRefLegacy(tx) {
  return `bank|${tx.acctSuffix}|${tx.date}|${tx.direction}|${tx.amount}|${tx.balance ?? ''}|${tx.summary}|${tx.note}`;
}

/** 找這筆交易對應帳戶的幣別。權威＝帳單概要區的「完整遮罩帳號→幣別」表（含餘額空白被略過的帳戶，故**不會
 * fail-open 成 TWD**）；其次比 parsed.accounts 遮罩、再比 db 的**現金**帳戶前綴+末碼（只認現金＝同 matchAccount
 * 護欄，免同末碼的外幣投資/負債帳戶誤判幣別而把真台幣現金流當外幣丟棄；機構維度 P1a r1#2＝同一條護欄的
 * 跨行版：他行同號帳戶的幣別不可拿來判本行的列——「台新 JPY」撞號會讓一銀真台幣列被當外幣**靜默不匯入**）；
 * 全 miss 才當 TWD。 @param {any} db @param {ParsedBankFull} parsed @param {import('../bank-statement.js').BankTx} tx */
function txCurrency(db, parsed, tx) {
  // 前兩步（帳單自帶判準）＝與對帳閘共用的 statementCurrencyLookup（P0.1 r1#2：各寫一份會歧義——
  // map 缺鍵、accounts 判外幣時，這裡跳過該列、閘卻當台幣驗＝為不入帳的列擋整份）
  const fromStmt = tx.acctMasked ? statementCurrencyLookup(parsed, tx.acctMasked) : null;
  if (fromStmt) return fromStmt;
  const bank = stmtBank(parsed);
  const { prefix, suffix } = maskedParts(tx.acctMasked || `x****${tx.acctSuffix}`);
  const acc = (db.accounts || []).find(a => {
    if ((a.type || 'cash') !== 'cash') return false;   // 只認現金帳戶（同 matchAccount）：外幣投資/負債同末碼不誤判幣別
    if (a.bank && a.bank !== bank) return false;       // 機構維度：他行戳帳戶的幣別不可判本行的列（r1#2）
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
 * 機構維度（P1a r1#1）＝同 matchAccount 的機構規則與祖父語意：蓋過他行戳的同號帳戶不可拿來當顯示名
 * （交易會整筆掛到別家銀行的帳戶底下）。先比前綴+末碼、比不到退回只比末碼（使用者登記的 accountNo 未必以
 * 遮罩露出的前綴開頭：可能只填末幾碼或含銀行代碼前置，硬要前綴相符會漏配到自己的帳戶）。都無→帳單概要區
 * 帳戶的 autoName、再無→「<機構> 末XXXX」。
 * @param {any} db @param {import('../bank-statement.js').BankTx} tx @param {ParsedBank} parsed */
function accountNameForTx(db, tx, parsed) {
  const bank = stmtBank(parsed);
  const { prefix, suffix } = maskedParts(tx.acctMasked || `x****${tx.acctSuffix}`);
  const suf = suffix || tx.acctSuffix;
  const digits = (/** @type {any} */ a) => String(a.accountNo || '').replace(/\D/g, '');
  const bySuffix = (db.accounts || []).filter(a => {
    if ((a.type || 'cash') !== 'cash') return false;
    if (a.bank && a.bank !== bank) return false;   // 機構維度：他行戳帳戶不可收編（r1#1）
    const d = digits(a); return suf && d.length >= suf.length && d.endsWith(suf);
  });
  const acc = bySuffix.find(a => !prefix || digits(a).startsWith(prefix)) || bySuffix[0];   // 先前綴+末碼、退回只末碼（都限現金）
  if (acc) return acc.name;
  const pa = (parsed.accounts || []).find(x => x.masked === tx.acctMasked) || (parsed.accounts || []).find(x => x.suffix === tx.acctSuffix);
  return pa ? autoName(pa, stmtBank(parsed)) : `${stmtBank(parsed)} ${tx.acctSuffix}`;
}

/** 把既有**銀行交易**的顯示帳戶名，對齊到「用遮罩帳號比對到的現有帳戶」現名（使用者定 2026-07-21「改一次、處處同步」）。
 * ⚠️ 用 `matchAccount` 的**身分比對（遮罩帳號＝台新格式 bankRef 第 2 段、bank2 第 3 段——雙軌，P1a）**，不靠可能過期的顯示字串——所以帳戶匯入時叫「台新 8791」、
 * 之後使用者改成「【台新】活儲（Richart）」，這裡仍認得出、把舊交易一併對齊。純函式（改 db、不寫檔）。回改動筆數。
 * @param {any} db @returns {number} */
export function reconcileBankTxAccountNames(db) {
  const accounts = db.accounts || [];
  let changed = 0;
  for (const t of db.transactions || []) {
    if (t.source !== 'bank' || !t.bankRef) continue;                 // 只對齊有身分（bankRef 遮罩帳號）的銀行交易
    const parts = String(t.bankRef).split('|');
    const isB2 = parts[0] === 'bank2';                               // 雙格式（P1a）：bank2＝機構在第 2 段、帳號右移到第 3 段
    const masked = (isB2 ? parts[2] : parts[1]) || '';
    const { suffix } = maskedParts(masked);
    if (!suffix) continue;
    // 機構＝bank2 讀自鍵；舊格式＝'台新'（祖父條款：舊格式只出自台新匯入）——他行同字樣帳號的帳戶不可被錯認改名
    const acc = matchAccount(accounts, { suffix, masked, currency: 'TWD' }, isB2 ? parts[1] : '台新');   // 銀行匯入只進 TWD（外幣明細不匯入），故一律以 TWD 比對
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
    // 舊組法只存在於舊格式（bank|…）的列——bank2 列（P1a 起）沒有「過濾器之前」的年代，不算這一項
    const parts = String(t.bankRef || '').split('|');
    const legacyAuto = parts[0] === 'bank' ? [parts[6], parts.slice(7).join('|').replace(/#\d+$/, '')].filter(Boolean).join('・') : '';
    const isAuto = !cur || cur === String(t.autoNote || '') || (legacyAuto !== '' && cur === legacyAuto);
    let touched = false;
    if (isAuto && cur !== fresh) { t.note = fresh; touched = true; }
    if (String(t.autoNote || '') !== fresh) { t.autoNote = fresh; touched = true; }
    if (touched) changed++;
  }
  if (changed) await saveDb(db);
  return { changed };
}

/** totals＝AI 路線限定（裁示⑧b：帳單自己印的合計欄、模板路線不產）——optional。
 * @typedef {ParsedBank & {transactions:import('../bank-statement.js').BankTx[], totals?: {txCount:number|null, totalOut:number|null, totalIn:number|null}}} ParsedBankFull */

/** 遮罩帳號的**可見前綴**（`900200****3302` → `900200`；只印末碼的 `****3302` → `''`）。
 * ⚠️ **分隔符要洗掉再比**（r2#2）：帳單原樣保留遮罩，`900-100****3302` 與 `900-200****3302`
 * 是同一家銀行的**兩個不同帳戶**——只認連續英數字的話兩者都被當成「沒有前綴」而互報。
 * `x****3302` 是 bankRefBase 在沒有遮罩時自己補的佔位，當成「不知道」。 */
function acctPrefix(masked) {
  const raw = String(masked || '');
  const star = raw.indexOf('*');
  if (star <= 0) return '';                                   // 沒有遮罩星號、或整串以星號開頭＝看不到前綴
  const head = raw.slice(0, star).replace(/[^0-9A-Za-z]/g, '');
  return (!head || head === 'x') ? '' : head;
}

/** 機構名的**比對用鍵**（只給疑似重複用，**不碰去重鍵**——那個是 P1a 逐字凍結的）。
 * ⚠️ 同一家銀行在不同帳單／不同解析路線上的寫法會不一樣（`台新` vs `台新國際商業銀行`——
 * AI 路線是照帳單抬頭抄的）。不正規化就會**漏報**：跨版式的重複交易一聲不吭地落帳（r2#1）。
 * 只剝通用後綴（公司型態與「（國際）（商業）銀行」），不做同義詞猜測——寧可漏合併、不可亂合併
 * （亂合併＝把兩家銀行說成同一家，那是會說謊的方向）。 */
function instKey(bank) {
  return String(bank || '').trim().toLowerCase()
    .replace(/股份有限公司|有限公司/g, '')
    .replace(/(國際)?(商業)?銀行$/, '')
    .trim();
}

/** 「疑似重複」索引（2026-08-12，William 實測踩到）：既有銀行交易的
 * `機構｜帳號末碼｜日期｜方向｜金額` → **這一格出現過的可見前綴集合**。
 *
 * ⚠️ 為什麼需要它——**去重鍵擋不住跨版式重複**：`bankRef` 含「摘要原文｜備註原文」，而同一家銀行的
 * 兩種版面（綜合對帳單 vs 另一種明細版）對**同一筆交易**的印法幾乎一定不同（「刷卡消費」vs
 * 「金融卡消費」、備註有沒有店名…），指紋因此對不上 ⇒ 同期間各匯一次＝現金流多算一份。
 * 去重鍵守的是「同一份帳單重複上傳」，不是「跨版式辨識同一筆交易」——這道索引補的就是那個縫。
 *
 * ⚠️ 三個設計取捨：
 * ①**機構要進 key**（r2#1）：只比末碼會把一銀與台新的同日同額說成「同一個帳戶」；機構名先過
 *   `instKey` 正規化（`台新` 與 `台新國際商業銀行` 是同一家）。
 * ②**前綴另存、不進 key**：跨版式的遮罩印法本來就可能不同（`900200****3302` vs `****3302`），
 *   所以前綴**只在兩邊都印得出來時**才拿來否決；有一邊不知道就放行。
 * ③**只提醒、不擋**（William 裁示）：同一天、同一個帳戶、同樣金額的兩筆真實交易是可能的
 *   （同一家店刷兩次、分兩次轉同額）。擋掉會吞掉真交易，比重複更難發現。
 *
 * ⚠️ `wanted`＝本次帳單真正會查的 key（先算好再掃）：不限制的話會替**全部**既有銀行交易建索引，
 * 10 萬筆約多吃 28MiB（審查者實測）——而其中絕大多數這次根本查不到。
 * @param {any} db @param {Set<string>} wanted @returns {Map<string, Set<string>>}
 */
function similarTxIndex(db, wanted) {
  /** @type {Map<string, Set<string>>} */
  const idx = new Map();
  if (!wanted.size) return idx;
  for (const t of db.transactions || []) {
    if (t.source !== 'bank') continue;
    const parts = String(t.bankRef || '').split('|');
    const isB2 = parts[0] === 'bank2';                  // 雙格式（P1a）：bank2 才有機構段
    const inst = isB2 ? String(parts[1] || '') : '台新';   // 舊格式 `bank|…` 依定義就是台新
    const masked = String((isB2 ? parts[2] : parts[1]) || '');
    // ⚠️ 舊資料的第二段可能是**純末碼**（`bank|3302|…`，沒有遮罩星號）——`accountSuffix` 讀不到，
    //    整筆就不進索引＝那些最老的交易永遠不會被提醒（r3#1）。純數字＝末碼本身、前綴當作不知道。
    const suffix = accountSuffix(masked) || (/^\d{3,}$/.test(masked) ? masked : '');
    const dir = txDirection(db, t);
    if (!suffix || !dir || !t.date) continue;
    const key = `${instKey(inst)}|${suffix}|${t.date}|${dir}|${Number(t.amount) || 0}`;
    if (!wanted.has(key)) continue;
    const set = idx.get(key) || new Set();
    set.add(acctPrefix(masked));
    idx.set(key, set);
  }
  return idx;
}

/** 一筆待匯入交易在疑似重複索引裡的 key（讀寫兩端共用，避免各拼一份而漂掉）。 */
function similarKey(bank, suffix, tx) {
  return `${instKey(bank)}|${suffix}|${tx.date}|${tx.direction}|${Number(tx.amount) || 0}`;
}

/** 這一筆是不是「疑似重複」（與 db 既有 `source:'bank'` 交易同機構＋末碼＋日期＋方向＋金額；
 * 可見前綴**兩邊都印得出來才否決**——跨版式的遮罩印法本來就可能不同）。
 * ⚠️ preview 與 apply（勾選跳過）**共用這一支**（#459 r2）：原本各手抄一份，apply 那份的
 * 前綴否決被拔掉時 84 題全綠——後果是「預覽判定不同帳戶、套用卻跳過**真交易**」＝使用者掉帳。
 * 判準有兩個複本，遲早分家一次，而分家那次沒有徵兆（同 settingValueOk 那課）。
 * @param {Map<string, Set<string>>} simIdx @param {string} bank @param {any} tx */
function isSimilarTx(simIdx, bank, tx) {
  const suf = tx.acctSuffix || accountSuffix(tx.acctMasked || '');
  const seen = suf ? simIdx.get(similarKey(bank, suf, tx)) : undefined;
  if (!seen) return false;
  const pfx = acctPrefix(tx.acctMasked || '');
  return pfx === '' || seen.has('') || seen.has(pfx);
}

/**
 * 交易明細分箱預覽（純函式、不寫檔）：分箱＋去重標記＋帳戶名。回可讓前端呈現/確認的列。
 * @param {any} db @param {ParsedBankFull} parsed
 */
export function previewBankTxForDb(db, parsed) {
  const own = ownSuffixSet(db, parsed);
  const bank = stmtBank(parsed);
  const existing = new Set((db.transactions || []).map(t => t.bankRef).filter(Boolean));
  // 先算出本次真正會查的 key，再只索引那些（記憶體：不替全部既有交易建索引）
  const simWanted = new Set((parsed.transactions || []).map((/** @type {any} */ t) => {
    const suf = t.acctSuffix || accountSuffix(t.acctMasked || '');
    return suf ? similarKey(bank, suf, t) : '';
  }).filter(Boolean));
  const simIdx = similarTxIndex(db, simWanted);
  const seen = new Set();   // 同批內去重也要標（否則預覽筆數多於實際匯入，使用者看到 2 筆卻只進 1 筆）
  const occ = new Map();    // 批內出現序（同 base 第 n 筆）——同日同額同備註且餘額讀不到仍分得開
  const rows = (parsed.transactions || []).map(tx => {
    const currency = txCurrency(db, parsed, tx);
    const foreign = currency !== 'TWD';   // 外幣明細：尚無歷史匯率口徑，一律不計入台幣現金流（只呈現、不匯入）
    const { bankKey, applied, cls: rawCls, name } = classifyWithLearning(db, tx, own);   // 先套學過的（摘要＋對方帳號、方向相容）、否則關鍵字
    const cls = resolveCls(db, rawCls);
    const bankRef = bankRefWithOcc(tx, occ, bank);
    const duplicate = existing.has(bankRef) || (bank === '台新' && existing.has(bankRefLegacy(tx))) || seen.has(bankRef);
    seen.add(bankRef);
    // 疑似重複（只在「不是明確重複」且「會匯入」的列才問）——判準住 isSimilarTx（apply 共用）
    const similar = !duplicate && !foreign && isSimilarTx(simIdx, bank, tx);
    // 學過自訂顯示名優先；否則走收支說明過濾器（2026-07-27：摘要詞對照＋備註清理的好讀版）
    const displayNote = name || bankDisplayNote(tx.summary, tx.note, { direction: tx.direction, accountNameOf: (a) => ownAccountNameByAcct(db, a, bank), bank });
    return {
      date: tx.date, account: accountNameForTx(db, tx, parsed),
      summary: tx.summary, note: displayNote, amount: tx.amount, direction: tx.direction, currency, foreign,
      type: cls.type, category: cls.category, subcategory: cls.subcategory,
      duplicate, similar, bankRef, bankKey, learned: applied,   // 真的套用了學過的才標「已學」（方向不符落關鍵字＝不標）
    };
  });
  /** @type {Record<string, number>} */
  const counts = { income: 0, expense: 0, transfer: 0, duplicate: 0, foreign: 0, similar: 0 };
  for (const r of rows) {
    if (r.similar) counts.similar++;        // 與收支類別**並存**（它是提醒、不是分類）：這些列仍會匯入
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
export function importBankTxToDb(db, parsed, opts = {}) {
  const own = ownSuffixSet(db, parsed);
  const bank = stmtBank(parsed);
  const existing = new Set((db.transactions || []).map(t => t.bankRef).filter(Boolean));
  const occ = new Map();
  const importedAt = new Date().toISOString();
  const batchId = uid();
  // 「這次跳過疑似重複」（William 2026-08-14：同期間匯過另一種版面時，48/57 筆是重複的——
  //   全擋掉他不能匯剩下的、全放行現金流被多算一份）。判準與預覽的「疑似重複」**同一套**
  //   （similarTxIndex＋similarKey：機構＋末碼＋日期＋方向＋金額；可見前綴兩邊都印得出來才否決）
  //   ——預覽標幾筆、這裡就跳幾筆，不另立第二套口徑。
  //   ⚠️ 誠實劃界：「疑似」是啟發式——真的同帳戶同日同額刷兩次會被一起跳過（可事後手動補記），
  //   所以它由使用者的勾選決定（**預覽窗預設勾、可取消**——預設方向＝不多算錢），且只認嚴格 true。
  const skipSimilar = opts.skipSimilar === true;
  const simWanted = new Set((parsed.transactions || []).map((/** @type {any} */ t) => {
    const suf = t.acctSuffix || accountSuffix(t.acctMasked || '');
    return suf ? similarKey(bank, suf, t) : '';
  }).filter(Boolean));
  const simIdx = skipSimilar ? similarTxIndex(db, simWanted) : new Map();
  let imported = 0, skipped = 0, foreign = 0, similarSkipped = 0;
  for (const tx of parsed.transactions || []) {
    if (txCurrency(db, parsed, tx) !== 'TWD') { foreign++; continue; }   // 外幣明細不計入台幣現金流（尚無歷史匯率換算）
    const bankRef = bankRefWithOcc(tx, occ, bank);
    if (existing.has(bankRef) || (bank === '台新' && existing.has(bankRefLegacy(tx)))) { skipped++; continue; }
    if (skipSimilar && isSimilarTx(simIdx, bank, tx)) { similarSkipped++; continue; }
    existing.add(bankRef);
    const { bankKey, cls: rawCls, name } = classifyWithLearning(db, tx, own);   // 先套學過的、沒學過才關鍵字
    const cls = resolveCls(db, rawCls);
    // 預設自動顯示名＝收支說明過濾器的好讀版（2026-07-27；bankKey/bankRef 仍用原始 summary+note、學習與去重不受影響）
    const autoNote = bankDisplayNote(tx.summary, tx.note, { direction: tx.direction, accountNameOf: (a) => ownAccountNameByAcct(db, a, bank), bank });
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
  return { imported, skipped, foreign, similarSkipped, batchId };
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
 * 預覽與套用**兩個入口都要過**——模板路線的 apply 會重新解析同一份檔案、AI 路線的 apply 兌回票裡那份
 * （P1b-1 r4#1），**兩條路的寫入路徑都自己再過一次閘**（用 fresh db），不可只擋預覽（繞過預覽直打
 * apply 的路要一樣安全；AI 那條另有 r5#2 專屬考題釘住）。
 * 幣別判定＝與匯入**同一條鏈**（P0.1 r1#2）：帳單自帶判準（statementCurrencyLookup）＋db 現金帳戶
 * 補位（txCurrency 第三步）——有 db 就帶上、兩邊永遠同向；無 db（純接縫測試）＝txCurrency 在空 db
 * 下的同一結果（帳單判準＋TWD fallback）。 @param {ParsedBankFull} parsed @param {any} [db] */
export function assertBankReconciled(parsed, db = null) {
  const currencyOf = (/** @type {string} */ masked) =>
    txCurrency(db || { accounts: [] }, parsed, /** @type {any} */ ({ acctMasked: masked, acctSuffix: accountSuffix(masked) }));
  const gate = reconcileBankStatement(parsed, currencyOf);
  if (!gate.ok) throw apiError(400, gateFailureMessage(gate, '銀行對帳單'));
  return gate;
}

// ---------- AI 解析路線（P1b-1，解析器通用化 §五；★3 拍板 2026-08-12＝Anthropic）----------
// 四道規矩（順序＝防線順序，缺一不可）：
//   ①**HOSTED 停止線**（★1）：隱私同意機制完成前，雲端版寫死不啟用——比鑰匙檢查更前面，有鑰匙也不行。
//   ②**AI 要求旗標**（★1 子項原拍板「每次送前先問」；2026-08-13 翻成預設直送＝aiAskBeforeSend
//     打開才問）：呼叫端要**明送 useAi:true** 才進得來；旗標缺席＝模板解析器的原錯誤原句丟回、**零 AI 呼叫**。
//     在後端把關＝確認窗還沒蓋好之前，這條路根本不通（拍板從第一天成立）。
//   ③**鑰匙**：settings.aiApiKey（機密欄位，比照 flexToken）；沒設＝白話 400 指路設定頁。
//   ④**強閘（★6）**：AI 解的帳單必須過強閘（逐筆餘額鏈）才准入——弱閘＝拒收（與模板弱閘「照舊放行」
//     刻意相反，見收支契約「匯入對帳閘」節）。
// 模型階梯（★3 拍板；裁示⑥ 2026-08-15 改版）：Sonnet 先解；答案卷驗收不過（ai_bad_answer/ai_refusal）或對帳閘紅＝升 Opus
// 重試**一次**；鑰匙/服務類錯誤（ai_auth/ai_unavailable…）升級也不會好、照實丟。

/** AI 路線的閘政策（★6）：先過既有對帳閘（不一致＝400），再要求①級別是強閘②**每個受驗（台幣）帳戶
 * 都至少吃到一道擋下型檢查**（r1#1：level 是**全檔**旗標——A 帳戶驗得動、B 帳戶餘額全空時整份仍 strong，
 * B 的列會零驗證搭便車入帳；判準＝`stats.twdAccountsUnverified === 0`，欄位缺席＝fail-closed 拒收，
 * 防未來裁決形狀漂移）。 @param {ParsedBankFull} parsed @param {any} db */
// export＝配方路線（P2-2）共用同一道「AI 級」放行條件：配方與 AI 一樣是「非模板」翻譯，
// 強閘＋台幣零未驗一體適用（totals 交叉驗證對配方輸出自然跳過——parseWithRecipe 不產 totals 欄）。
export function assertAiBankReconciled(parsed, db) {
  const gate = assertBankReconciled(parsed, db);
  const uncovered = Number(gate?.stats?.twdAccountsUnverified ?? 1);
  if (gate.level !== 'strong' || uncovered !== 0) {
    throw apiError(400, 'AI 讀不到這份帳單的逐筆餘額（或其中有帳戶整組讀不到），翻譯結果無從驗算——照規矩不收（寧可暫時不能匯入，不把沒驗算過的數字記進帳本）。這份請改用手動記帳。', 'ai_weak_refused');
  }
  // 合計欄交叉驗證（裁示⑧b）：帳單自己印的筆數/支出合計/存入合計 vs AI 逐筆——多一道帳單
  // 印的控制總額、兼補「每帳戶第一筆的金額/方向驗不到」盲區（首筆進不進合計藏不住）。
  // 只驗「有印」的欄（null＝誠實缺席、跳過）；容差 BAL_EPS＝與餘額鏈同一把尺（同一個常數、不留漂移副本）。
  // ⚠️ 訊息不回聲數字（AI 誤讀的欄值不可外送——與 ai_reconcile_failed 同一條機密紀律）。
  // ⚠️ 混幣帳單＝整道跳過（預審 r0）：閘與匯入的射程只有台幣（外幣列不入帳），而帳單印的
  //   合計涵蓋哪一段（整份？台幣區？）機械上判不出來——拿「全列不分幣別加總」去比，正確答案
  //   會被誤判 ai_totals_mismatch 連坐擋死（William 的真實帳單正是台幣＋外幣混合形）。
  //   提示詞規則 8 已叫 AI 在混幣情境填 null；這裡是引擎側的第二道保險。
  const t = parsed.totals;
  const mixedCurrency = parsed.transactions.some((/** @type {any} */ x) => (parsed.accountCurrency?.[x.acctMasked] || 'TWD') !== 'TWD');
  if (t && !mixedCurrency) {
    const sum = (/** @type {'in'|'out'} */ dir) => parsed.transactions.reduce((a, x) => a + (x.direction === dir ? x.amount : 0), 0);
    if (t.txCount != null && t.txCount !== parsed.transactions.length) {
      throw apiError(400, 'AI 逐筆的筆數與帳單印的明細總筆數對不上——可能漏抄或多抄了交易', 'ai_totals_mismatch');
    }
    if (t.totalOut != null && Math.abs(t.totalOut - sum('out')) > BAL_EPS) {
      throw apiError(400, 'AI 逐筆加總與帳單印的支出合計對不上——翻譯結果不可信', 'ai_totals_mismatch');
    }
    if (t.totalIn != null && Math.abs(t.totalIn - sum('in')) > BAL_EPS) {
      throw apiError(400, 'AI 逐筆加總與帳單印的存入合計對不上——翻譯結果不可信', 'ai_totals_mismatch');
    }
  }
  return gate;
}

/** 這個解析錯誤可不可以改走 AI？只有「**解析階段**認不得/解不動」可以；密碼錯（pdf_password）要回前端
 * 跳密碼窗、**對帳閘紅絕不可**（模板認得但數字對不上＝★6「對帳失敗禁止匯入」的既有裁決，AI 不得撿去重試
 * ——所以 AI 資格判定只包解析段、不包閘，見 preview/apply 的 try 範圍）。 @param {any} e @param {{useAi?:boolean}} opts */
function aiEligible(e, opts) {
  return opts?.useAi === true && /** @type {any} */ (e)?.code !== 'pdf_password';
}

/**
 * AI 路線本體：停止線→鑰匙→抽字（密碼池同一套）→AI（模型階梯）→驗收→強閘。回 {parsed, reconcile, aiModel}。
 * **只有 preview 會走到這裡**（r4#1）：apply 憑票取回這份結果、不重跑模型。
 * ⚠️ 傳入的 db 只做「鑰匙＋密碼池＋閘的幣別補位」；**apply 寫入前要用 fresh db 重過閘**（讀→閘→套→寫
 * 之間無外部 IO await 的既有不變量——transport 是外部 IO，必須全部發生在寫入用 getDb 之前）。
 * export＝**供直接考題**（HOSTED 停止線在整合層測不到：測試翻 NOTEASY_HOSTED 會讓儲存層先要租戶而炸，
 * 到不了這裡的守門）；正式呼叫端只有本檔兩個入口，HTTP 打不到它。
 * @typedef {{models:{primary:string,escalation:string}, parseOnce:(text:string, model:string)=>Promise<any>, generateRecipe?:(text:string, model:string)=>Promise<any>}} AiEngine
 * @param {string} b64 @param {string|undefined} password @param {any} db
 * @param {{engineFactory?: (key:string)=>AiEngine, extract?: typeof extractBankLines}} seams
 *   engineFactory＝**路由層組裝**（lib/routes/statement.js 用真傳輸組、考題用假傳輸組——本檔刻意
 *   拿不到真引擎，見檔頭 import 註解）；extract＝測試接縫（同 parse 接縫的理由 r3#1）。
 */
/**
 * 配方路線（P2-2）：模板認不得的帳單，先拿存好的配方試解——**零元、零外送、不需 useAi**。
 * 順序（裁示④細部）＝每張配方先試 current；閘紅或拒解→自動退 previous 重解（免費）；
 * 都不行→下一張；全敗＝回 hit:null（輪到 AI 或把原錯拋回）。
 * ⚠️ 本函式**全程唯讀**（預覽唯讀不變量）：版本互換與畢業計數在 apply 寫入路徑做；
 *   「配方中版面但閘紅」的 id 收進 gateFailedIds——走 AI 成功匯入後才標疑似過期（經確認票）。
 * ⚠️ 拒解（recipe_parse_failed）與閘紅都＝「這版配方不行」，不逐層外洩原因（配方是防禦縱深，
 *   失敗就換下一個候選；最終使用者看到的錯誤仍是模板路線的原句或 AI 路線的結果）。
 * @param {string} b64 @param {string|undefined} password @param {any} db
 * @param {{extract?: typeof extractBankLines}} [seams]
 * @returns {Promise<{hit: {parsed: ParsedBankFull, reconcile: any, recipeId: string, usedVersion: 'current'|'previous', currentMatched: boolean, usedRecipe: object}|null, gateFailedIds: string[]}>}
 */
export async function recipeBankRoute(b64, password, db, seams = {}) {
  /** @type {string[]} */ const gateFailedIds = [];
  const rows = Array.isArray(db?.parseRecipes) ? db.parseRecipes : [];
  if (rows.length === 0) return { hit: null, gateFailedIds };
  const extract = seams.extract || extractBankLines;
  /** @type {any} */ let lines;
  try {
    lines = await parseWithPool((b, pw) => extract(b, pw), decode(b64), statementPasswordPool(db, password ? [String(password)] : []));
  } catch {
    return { hit: null, gateFailedIds };   // 抽不了字＝配方幫不上（密碼錯已在模板路線分流、走不到這裡）
  }
  for (const row of rows) {
    if (typeof row?.id !== 'string' || !row.id) continue;   // 無 id 的列不服役（Grok GH3：票與記帳都以 id 對列——對不到＝改錯列/漏標；備份牆下次寫入也會濾掉它）
    // currentMatched（Grok GH1）：「用了 previous」有三種原因，只有「current **中版面**但失靈
    //（拒解或閘紅）」才是回滾語意；current 根本沒中版面（例：P2-3 重生後新舊版指紋不同、
    // 這張是舊版面的帳單）＝previous 正常服役，**不可**互換、也不可把整列打成疑似。
    let currentMatched = false;
    for (const usedVersion of /** @type {const} */ (['current', 'previous'])) {
      const recipe = row[usedVersion];
      if (!recipe || typeof recipe !== 'object') continue;
      /** @type {ParsedBankFull} */ let parsed;
      try {
        if (!recipeMatches(lines, recipe)) continue;
        if (usedVersion === 'current') currentMatched = true;
        parsed = /** @type {any} */ (parseWithRecipe(lines, recipe));
      } catch { continue; }   // 拒解＝這版不行，退下一版/下一張
      try {
        const reconcile = assertAiBankReconciled(parsed, db);
        // usedRecipe＝JSON 快照（預審 G1：apply 記帳前要核對列的現況還是不是「當時用的那版」——
        // 並發雙套用/其間被還原洗過，都不可以按版本標籤盲換）
        return { hit: { parsed, reconcile, recipeId: row.id, usedVersion, currentMatched, usedRecipe: JSON.parse(JSON.stringify(recipe)) }, gateFailedIds };
      } catch { continue; }   // 閘紅＝退上一版（迴圈自然做到）
    }
    if (currentMatched) gateFailedIds.push(row.id);   // **現行版**中版面但整列沒過＝疑似過期候選（只看 previous 失靈不算——它本來就是備胎）
  }
  return { hit: null, gateFailedIds };
}

/**
 * apply 寫入路徑的配方記帳（P2-2；**在同一次 db 交易內、saveDb 之前呼叫**＝計數與匯入原子一致）。
 * - 用 previous 成功＝**自動回滾**：previous 升為 current、壞的 current 降為 previous（留 1 版不變量）；
 *   連續計數從 1 重數（換了現行版）。
 * - 用 current 成功＝graduateStreak+1；連續 5 次全過強閘＝graduated（裁示②；之後照樣計數）。
 * - 成功套用＝suspect 解除（它剛證明自己還讀得動這個版面）。
 * @param {any} db @param {{id:string, usedVersion:'current'|'previous', currentMatched?:boolean, usedRecipe:object, imported?:number}} use
 */
export function recordRecipeApplied(db, use) {
  const row = (Array.isArray(db?.parseRecipes) ? db.parseRecipes : []).find((/** @type {any} */ r) => r?.id === use.id);   // 嚴格比較（r1#2：String() 隱式轉換會讓數字 id 7 命中字串票 "7"）
  if (!row) return;   // 配方在 preview 與 apply 之間被移除＝計數沒對象，匯入本身照常（守衛同時證明票鎖住了 parsed）
  // 身分核對（預審 G1/A2）：fresh db 的那一格必須仍是「當時用的那版」才記帳——並發雙套用會把
  // 自動回滾**再換回去**（壞版回鍋當 current）、其間被備份還原洗過的列按標籤盲換可讓 current
  // 變 undefined 並炸掉 saveDb（計數副作用沒有資格弄死匯入主流程）。內容不符＝計數靜默跳過，
  // 匯入本身照常完成。
  const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(row[use.usedVersion], use.usedRecipe)) return;
  const now = new Date().toISOString();
  // A6 操作定義（P2-3 明文；裁示②的「份」）：**這次真的寫入了新交易（imported>0）才算一份**——
  // 同一份帳單重傳＝全被去重跳過＝imported 0＝只記使用時間，不累積畢業、也不觸發互換
  //（重複上傳不是新版面證據）。判準屬流程計數、非金額口徑（Claude 依授權裁量、審查可挑戰）。
  if ((use.imported ?? 1) === 0) {
    row.suspect = false;   // Grok G3：讀得動＋過閘＝版面證明仍可讀——疑似解除不捆「份」的門（份只管畢業累積）
    row.lastUsedAt = now;
    row.updatedAt = now;
    return;
  }
  // Grok GH1：previous 服役但 current **沒中版面**＝不是回滾（current 對它自己的版面可能好好的，
  // 例：P2-3 重生後新舊版指紋不同、這張是舊版面帳單）——只記使用時間，不互換、不動畢業計數。
  if (use.usedVersion === 'previous' && !use.currentMatched) {
    row.lastUsedAt = now;
    row.updatedAt = now;
    return;
  }
  if (use.usedVersion === 'previous') {
    const broken = row.current;
    row.current = row.previous;
    row.previous = broken;
    row.graduateStreak = 1;
    row.graduated = false;
  } else {
    row.graduateStreak = (Number(row.graduateStreak) || 0) + 1;
    if (row.graduateStreak >= 5) row.graduated = true;   // 裁示②：連 5 份全過強閘＝穩定
  }
  row.suspect = false;
  row.lastUsedAt = now;
  row.updatedAt = now;
}

/** apply 寫入成功前標記「預覽時中版面但失靈」的配方＝疑似過期（裁示②；同交易原子寫）。
 * 世代檢查（預審 A4）：名單是 preview 時刻的快照——若該配方**其後已自證**（lastUsedAt 晚於
 * 快照時刻＝期間成功套用過），舊快照不可把它蓋回 suspect（批次匯多月帳單的正常型態會踩）。
 * @param {any} db @param {string[]} ids @param {string} [snapshotAt] 快照時刻（票的 issuedAt／直接路徑＝now） */
export function markRecipesSuspect(db, ids, snapshotAt) {
  if (!ids?.length) return;
  const now = new Date().toISOString();
  for (const row of (Array.isArray(db?.parseRecipes) ? db.parseRecipes : [])) {
    if (typeof row?.id !== 'string' || !ids.includes(row.id)) continue;   // 嚴格比較（r1#2）
    if (snapshotAt && typeof row?.lastUsedAt === 'string' && row.lastUsedAt > snapshotAt) continue;   // 其後已自證
    row.suspect = true; row.graduateStreak = 0; row.graduated = false; row.updatedAt = now;
  }
}

export async function aiBankRoute(b64, password, db, seams = {}) {
  if (isHosted()) throw apiError(400, 'AI 解析尚未在雲端版開放：使用者隱私同意機制（多人前置）完成前，這條路寫死停用。', 'ai_hosted_off');
  const key = String(db?.settings?.aiApiKey || '');
  if (!key) throw apiError(400, '還沒有設定 AI 解析鑰匙——請先到設定頁存入你的 API key，再試一次。', 'ai_no_key');
  const engine = seams.engineFactory ? seams.engineFactory(key) : null;
  if (!engine) throw apiError(500, 'AI 引擎未接上（呼叫端沒帶 engineFactory）——這是程式接線錯誤，不是你的操作問題', 'ai_engine_missing');
  const extract = seams.extract || extractBankLines;
  const lines = await parseWithPool((b, pw) => extract(b, pw), decode(b64), statementPasswordPool(db, password ? [String(password)] : []));
  const text = linesToText(lines);
  /** @type {any} */ let lastErr = null;
  for (const model of [engine.models.primary, engine.models.escalation]) {
    /** @type {any} */ let parsed;
    try {
      parsed = normalizeAiBank(await engine.parseOnce(text, model));   // 引擎交原始答案、服務層自己驗收（縱深防禦）
      assertAiBankGrounded(parsed, text);   // 接地檢查（裁示⑧a）：答案的每個金額都要在原文找得到——自洽錯的主力剋星；不接地＝ai_bad_answer＝升級再試
    }
    catch (e) {
      const code = /** @type {any} */ (e)?.code;
      if (code === 'ai_bad_answer' || code === 'ai_refusal') { lastErr = e; continue; }   // 答案壞＝換大模型再試一次
      throw e;   // 鑰匙/服務錯誤：升級救不了，照實丟（訊息已白話、不含內文）
    }
    try { return { parsed, reconcile: assertAiBankReconciled(parsed, db), aiModel: model, lines }; }   // lines 隨結果走（P2-3：生成從票拿、不重抽）
    catch (e) { lastErr = e; }   // 閘紅／弱閘拒收＝「閘紅了才升級」（★3 拍板、裁示⑥後升的是 Opus）；第二次仍紅就照實擋
  }
  // 終局錯誤的機密紀律（r1#3）：對帳閘的白話訊息**帶帳單數字**——那是 ★6 為模板路線設計的核對體驗
  //（模板逐字抄使用者自家的帳單）；AI 路線若原樣外送＝把 AI 誤讀的帳單欄值塞進錯誤訊息，違反本支
  // 「內文不進錯誤訊息」契約。帶 ai_* code 的錯（弱閘拒收/答案壞…）訊息本來就乾淨＝原樣丟；
  // 沒 code 的（＝底層對帳閘原錯）換成不含任何帳單欄值的專用錯誤。
  if (lastErr && /** @type {any} */ (lastErr).code) throw lastErr;
  throw apiError(400, 'AI 翻譯後帳仍軋不平（升級到第二個模型也一樣）。為了不把沒驗算過的數字記進帳本，這份不收——請改用手動記帳；要回報時講「AI 解析對不平」與銀行名即可，不用貼帳單內容。', 'ai_reconcile_failed');
}

/**
 * 配方生成（P2-3）：**AI 票路線兌票寫入成功之後**才跑（另一發生成呼叫——preview 升級階梯走滿時
 * 它是本次上傳的第三發；一律 RECIPE_MODEL＝Opus，裁示⑥）。
 * 為什麼掛在 apply 成功後而不是 preview：①出生三關的 reproduces 要對照「**使用者確認過**的那份答案」
 * （＝票裡的 parsed）——沒按套用的答案沒資格當黃金樣本 ②preview 是等待熱路徑、再加一發 Opus 不划算
 * ③apply 的讀→閘→套→寫不變量禁止外部 IO——所以生成整段在 saveDb 成功**之後**、用 repo 櫃檯另開原子交易。
 * ⚠️ **原文從票拿、不重抽（W1/W3）**：正式前端的 AI 套用**不送檔案內容**（applyBody 只送
 * {useAi, aiTicket}）——用 b64 重抽＝decode(undefined) 必炸＝整條路 DOA（預審實抓：考題直呼服務層
 * 帶了 b64＝假綠）。lines 隨票走也讓「AI apply 不解析檔案、不碰密碼池」（r6#1）在 P2-3 後仍為真。
 * 失敗絕不連坐：匯入已完成、生成掛掉只回 {saved:false, reason}（費用已花在解析上、配方是順手的紅利）。
 * ⚠️ 同步生成的取捨（Grok G2）：saveDb 成功後同一請求再 await 一發 Opus（數秒）——AI 路線只在
 * LOCAL 可達（HOSTED 停止線）＝localhost 無 proxy 逾時面；未來 HOSTED 開放 AI 時**必須**改非同步。
 * 重生（裁示②④）：票上 suspectRecipeIds 有值＝寫回**第一個**候選列；⚠️ **重生也吃 A4 世代檢查（W5）**：
 * 候選列其後已自證（lastUsedAt 晚於票 issuedAt）＝不降它的版、改走新建（批次匯多月的正常型態）。
 * 多於一個候選＝其餘照樣掛疑似、等下次重生（殘餘：一次只重生一列，記入契約）。
 * @param {any} ticket 兌出的 AI 票（parsed＝黃金樣本、lines＝原文、suspectRecipeIds＋issuedAt＝重生依據）
 * @param {{aiEngineFactory?: (key:string)=>AiEngine, aiExtract?: typeof extractBankLines}} opts
 * @returns {Promise<{saved: boolean, recipeId?: string, rebirth?: boolean, reason?: string}>}
 */
export async function generateRecipeAfterImport(ticket, opts) {
  try {
    const db = await getDb();   // 唯讀用途：鑰匙（生成寫入走 repo 櫃檯自己的交易；**不碰密碼池**＝r6#1 仍為真）
    const key = String(db?.settings?.aiApiKey || '');
    const engine = key && opts.aiEngineFactory ? opts.aiEngineFactory(key) : null;
    if (!engine?.generateRecipe) return { saved: false, reason: 'recipe_engine_missing' };
    const lines = ticket?.lines;
    if (!Array.isArray(lines) || !lines.length) return { saved: false, reason: 'recipe_gen_failed' };   // 舊票/殘票無原文＝不硬抽
    const candidate = pickRecipeCandidate(await engine.generateRecipe(linesToText(lines), RECIPE_MODEL));
    // 出生三關（r2#5：漏列任何一關＝白做的安全門）——①零內容機械驗證
    if (validateRecipeStrict(candidate).length) return { saved: false, reason: 'recipe_birth_strict' };
    // ②對照出生帳單（錨點必須真的在版面上、不得是交易內文）
    /** @type {ParsedBankFull} */ let actual;
    try {
      if (!recipeMatches(lines, candidate)) return { saved: false, reason: 'recipe_birth_match' };
      actual = /** @type {any} */ (parseWithRecipe(lines, candidate));
    } catch { return { saved: false, reason: 'recipe_birth_parse' }; }
    if (validateRecipeAgainstStatement(lines, candidate, /** @type {any} */ (ticket.parsed)).length) return { saved: false, reason: 'recipe_birth_statement' };
    // ③逐欄重現使用者確認的答案（黃金樣本＝票裡那份）
    if (!recipeReproduces(/** @type {any} */ (ticket.parsed), /** @type {any} */ (actual)).ok) return { saved: false, reason: 'recipe_birth_reproduce' };
    const rebirthId = ticket.suspectRecipeIds?.[0];
    // W5/r1#1：世代檢查在 saveParseRecipe 的 mutate 內用 fresh row 做——這裡先讀 db 再 await Opus
    // ＝舊快照，生成在途時候選若自證，舊快照會誤判可重生（Codex r1 注入實測穿過）。
    const saved = await saveParseRecipe(candidate, rebirthId ? { rebirthId, notAfter: ticket.issuedAt } : {});
    return { saved: true, ...saved };
  } catch {
    return { saved: false, reason: 'recipe_gen_failed' };   // 匯入已完成——生成失敗不連坐、不外洩內文
  }
}

// ⚠️ 兩個正式入口的第三參數＝**測試接縫**（r3#1）：銀行入口吃真 PDF、考題合成不了，接線若沒有行為
// 考題保護，「拔掉 assert 照樣全綠」＝空包彈（靜靜通過最危險）。注入假解析器讓考題能走**正式入口本人**
// 驗「不平衡＝400、apply 未寫入任何資料」。第四參數 opts：路由只傳 `useAi`（AI 要求旗標，P1b-1）；
// `aiTransport`/`aiExtract` 是 AI 路線的測試接縫（正式呼叫端**絕不傳**——它們不在 HTTP body 的解讀範圍，
// 前端塞什麼都注入不了）。

/** 預覽（密碼池試開 → 解析 PDF → 對帳閘 → 純邏輯）：回帳戶餘額變動＋交易分箱＋對帳裁決三塊。
 * P0.5：password 可選——留白＝自動試統一密碼池（''→各卡 pdfPassword→記住的帳單密碼），
 * 全敗＝400（code:'pdf_password'）讓前端跳密碼窗。
 * P1b-1：模板認不得＋`opts.useAi===true` ＝改走 AI 路線（規矩見上方 AI 節）；回應多 `engine:'ai'`
 * ＋`aiModel`＋**`aiTicket`（確認票，apply 憑它寫入同一份答案，r4#1）**（模板路徑回應形狀**不變**）。
 * @param {string} b64 @param {string=} password @param {typeof parseBankStatement} [parse] 測試接縫（見上）
 * @param {{useAi?:boolean, aiEngineFactory?:(key:string)=>AiEngine, aiExtract?:typeof extractBankLines}} [opts] */
export async function previewBankStatement(b64, password, parse = parseBankStatement, opts = {}) {
  const db = await getDb();   // 密碼池＋閘的幣別補位（P0.1 r1#2）都要它；預覽全程唯讀
  /** @type {ParsedBankFull} */ let parsed;
  try {
    parsed = await parseWithPool((b, pw) => parse(b, pw), decode(b64), statementPasswordPool(db, password ? [String(password)] : []));
  } catch (e) {
    // P2-2 配方路線：認不得（且非密碼問題）＝先試存好的配方——零元零外送、**不需 useAi**。
    // 密碼錯（pdf_password）照舊回前端跳密碼窗；配方全敗＝照原順序輪 AI 或把原錯拋回。
    /** @type {string[]} */ let recipeGateFailedIds = [];
    if (/** @type {any} */ (e)?.code !== 'pdf_password') {
      const rec = await recipeBankRoute(b64, password, db, { extract: opts.aiExtract });
      recipeGateFailedIds = rec.gateFailedIds;
      if (rec.hit) {
        // 配方也發票（預審 G2/G3）：①「所見即所得」——apply 憑票用 preview 那份 parsed 與選版，
        // 不重跑選版（選版依 db 現況會漂）②「別張配方失靈、本張救場」的失靈名單搭同一張票
        // 到 apply 才標（preview 唯讀不變量不破）。
        const aiTicket = issueAiTicket({ parsed: rec.hit.parsed, aiModel: '',
          recipeUse: { id: rec.hit.recipeId, usedVersion: rec.hit.usedVersion, currentMatched: rec.hit.currentMatched, usedRecipe: rec.hit.usedRecipe },
          suspectRecipeIds: rec.gateFailedIds });
        return { ...previewBalancesForDb(db, rec.hit.parsed), transactions: previewBankTxForDb(db, rec.hit.parsed),
          reconcile: rec.hit.reconcile, engine: 'recipe', recipeId: rec.hit.recipeId, aiTicket };
      }
    }
    if (!aiEligible(e, opts)) throw e;
    const r = await aiBankRoute(b64, password, db, { engineFactory: opts.aiEngineFactory, extract: opts.aiExtract });
    // 發確認票（r4#1）：把**這一份**已驗收＋已過閘的答案留在伺服器記憶體，apply 憑票寫入同一份——
    // AI 不是確定性解析器，apply 自己重跑會讓「使用者確認的 A」變成「實際入帳的 B」（Codex 實測）。
    // lines 進票（P2-3 W1）：正式前端的 AI 套用**不送檔案內容**（applyBody 只送 {useAi, aiTicket}）——
    // 生成的原文只能從票拿；順帶讓「AI apply 不解析檔案、不碰密碼池」的契約句在 P2-3 後仍為真（W3）。
    const aiTicket = issueAiTicket({ parsed: r.parsed, aiModel: r.aiModel, suspectRecipeIds: recipeGateFailedIds, lines: r.lines });
    return { ...previewBalancesForDb(db, r.parsed), transactions: previewBankTxForDb(db, r.parsed), reconcile: r.reconcile, engine: 'ai', aiModel: r.aiModel, aiTicket };
  }
  const reconcile = assertBankReconciled(parsed, db);   // 對不上＝這裡就 400（前端既有錯誤路徑會原句顯示）；刻意在 try 外＝閘紅不落 AI
  return { ...previewBalancesForDb(db, parsed), transactions: previewBankTxForDb(db, parsed), reconcile };
}

/** 路由層 apply 的 body 投影（#459 r5）：字面掃描守不住「=== true || !!x」這類等價寫法——
 * 嚴格布林的**真相**收成這一支，用行為題餵五種輸入驗轉交值；`statement.js` 不准再直接讀
 * `req.body.skipSimilar`（考題禁令）。engine 工廠由路由自己補（它是路由的組裝件、不是 body 的投影）。
 * @param {any} body
 * @returns {{skipSimilar:boolean, useAi:boolean, aiTicket:string|undefined}} */
export function applyOptsFromBody(body) {
  const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
  return {
    skipSimilar: b.skipSimilar === true,
    useAi: b.useAi === true,
    aiTicket: typeof b.aiTicket === 'string' ? b.aiTicket : undefined,
  };
}

/** 套用（密碼池試開 → 解析 PDF → 對帳閘 → 更新餘額＋匯入交易 → 一次寫檔）。
 * **兩條路（P1b-1 r4#1）**：①**模板路線**＝照舊自己解析檔案（密碼池、對帳閘、寫入）——池的取用＝
 * 解析**前**另一次唯讀 getDb（**只在這條分支裡**，r6#1），`apply 自己重跑池`（不是收前端帶回的「中選密碼」：池內容全是機密、
 * 絕不回前端）②**AI 路線**＝`opts.aiTicket` 兌回 preview 那份**已驗收＋已過閘**的答案，**不解析檔案、
 * 不重跑解析模型、不碰密碼池**（AI 非確定性：重跑會讓使用者確認的 A 變成寫入的 B）。兩條路都在
 * 「讀→（閘）→套→寫之間無外部 IO await」的既有不變量內：AI 的**解析**外部 IO 全發生在 preview；
 * P2-3 起 saveDb 成功後另有至多一發 Opus 配方生成（原文從票、非解析、失敗不連坐——r1#5 誠實句：
 * 「apply 零外部 IO」已不成立，成本邊界＝每次上傳至多 3 發、單一真相在 server.js OUTBOUND 註解）。
 * @param {string} b64 @param {string=} password @param {typeof parseBankStatement} [parse] 測試接縫（見上）
 * @param {{useAi?:boolean, aiTicket?:string, skipSimilar?:boolean, aiEngineFactory?:(key:string)=>AiEngine, aiExtract?:typeof extractBankLines, aiRecipeGen?:typeof generateRecipeAfterImport}} [opts] */
export async function applyBankStatement(b64, password, parse = parseBankStatement, opts = {}) {
  // parsed 的型別退到 any（P2-2）：三條賦值路（票／模板 try／catch 裡的配方命中）讓 TS 的
  // 控制流跟不上「recipeUse 有值 ⟺ parsed 已賦值」的不變量；執行期由 !recipeUse 分支的 throw 保證。
  /** @type {any} */ let parsed;
  /** @type {{engine:'ai', aiModel:string}|null} */ let ai = null;
  /** @type {{id:string, usedVersion:'current'|'previous', currentMatched?:boolean, usedRecipe:object}|null} */ let recipeUse = null;   // P2-2
  /** @type {string[]} */ let directGateFailedIds = [];   // P2-2 預審 G3：無票路徑的失靈名單
  /** @type {string} */ let directObservedAt = '';   // Grok GH2：無票路徑的觀測時刻（世代檢查基準）
  /** @type {any} */ let committed;   // W4：寫入成功的產出（生成與回傳在恢復邊界外用；try 成功才有值）
  // AI 路線＝**憑票寫入、不重跑模型**（r4#1）：票是 preview 那次「已驗收＋已過閘」答案的伺服器端身分。
  // 帶了票卻兌不到（過期／已用過／假票）＝fail-closed 要求重新預覽，絕不改走「自己再解一次」。
  const ticket = opts.aiTicket ? redeemAiTicket(opts.aiTicket) : null;
  if (opts.aiTicket && !ticket) throw apiError(400, '這份 AI 預覽已經過期或已經套用過了——請重新預覽一次，確認內容無誤再套用。', 'ai_ticket_invalid');
  if (ticket && ticket.recipeUse) {
    // 配方票（P2-2 預審 G2）：憑票取回 preview 那份 parsed 與選版——與 AI 票同一套「所見即所得」。
    parsed = ticket.parsed;
    recipeUse = ticket.recipeUse;
  } else if (ticket) {
    parsed = ticket.parsed;
    ai = { engine: 'ai', aiModel: ticket.aiModel };
  } else {
    // 密碼池只在**模板路線**組（r6#1：契約寫「AI apply 不碰密碼池」就要真的不碰——無條件先組
    // 等於把各卡 pdfPassword 與記住的密碼白白拉進記憶體。機密最小化，也讓契約字面成立）
    const db0 = await getDb();
    const pool = statementPasswordPool(db0, password ? [String(password)] : []);
    try {
      parsed = await parseWithPool((b, pw) => parse(b, pw), decode(b64), pool);
    } catch (e) {
      // P2-2 配方路線：與 preview 同順序（配方確定性＝apply 可自己重解，不需要票；
      // 寫入前仍會用 fresh db 重過同一道 AI 級強閘——見下方恢復邊界內）。
      if (/** @type {any} */ (e)?.code !== 'pdf_password') {
        // Grok GH2：世代檢查要用**觀測**時刻（route 看到失靈的當下），不是標記當下——中間隔著
        // getDb 的讓出點（並發下另一請求可讓該配方自證）。⚠️ 誠實記錄：把這裡改回「標記當下」的
        // 突變在無讓出接縫的考題環境行為等價、刀 GK5 咬不到（不造假接縫）；語意承重＝
        // markRecipesSuspect 的世代檢查單元題（預審A4）＋本註解。
        directObservedAt = new Date().toISOString();
        const rec = await recipeBankRoute(b64, password, db0, { extract: opts.aiExtract });
        if (rec.hit) {
          parsed = rec.hit.parsed;
          recipeUse = { id: rec.hit.recipeId, usedVersion: rec.hit.usedVersion, currentMatched: rec.hit.currentMatched, usedRecipe: rec.hit.usedRecipe };
          directGateFailedIds = rec.gateFailedIds;   // 預審 G3：別張失靈的直接路徑也要標（同交易內）
        }
      }
      if (!recipeUse) {
        if (!aiEligible(e, opts)) throw e;
        // 認不得＋有 AI 要求旗標但**沒有票**：不在這裡跑模型（那正是 r4#1 的病）——請前端先走預覽。
        throw apiError(400, 'AI 解析的帳單要先預覽、確認解出來的內容無誤，才能套用——請先按「預覽」。', 'ai_ticket_required');
      }
    }
  }
  // ⚠️ **恢復邊界從這裡開始**（r1#4）：`getDb()` 自己也可能 reject（儲存層壞掉／HOSTED 拿不到租戶），
  //    它若在 try 外就會讓票永久消失——正是本支要修的那一類失敗。兌票之後、成功 commit 之前的
  //    **每一個** await 都要在同一個恢復邊界內。
  try {
    const db = await getDb();   // 解析／AI（外部 IO）完成後才讀整包；讀→（閘）→套→寫之間無外部 IO await
    // AI／配方路線寫入前用 fresh db 重過閘（同一道 AI 級放行條件）。⚠️ 誠實記錄：配方分支的這一行
    // 是**縱深**——命中在同一請求裡已於 recipeBankRoute 過了同一顆 assertAiBankReconciled（db0），
    // 「把這裡降級成模板閘」的突變在無 db 漂移接縫下行為等價、考題咬不到（不造假接縫演戲）；
    // 承重考題在 recipeBankRoute 路徑（弱閘拒收題＋刀 R3）。
    if (ai || recipeUse) assertAiBankReconciled(parsed, db);
    else assertBankReconciled(parsed, db);        // 寫入路徑 fail-closed——閘一定在任何寫入之前
    const bal = applyBalancesToDb(db, parsed);
    const tx = importBankTxToDb(db, parsed, { skipSimilar: opts.skipSimilar === true });
    // P2-2 配方記帳（同一次交易、saveDb 之前＝與匯入原子一致）：
    // 配方套用成功＝計數/回滾互換；AI 票帶的「預覽時配方閘紅」名單＝標疑似過期。
    if (recipeUse) recordRecipeApplied(db, { ...recipeUse, imported: Number(/** @type {any} */ (tx)?.imported) || 0 });
    if (ticket?.suspectRecipeIds?.length) markRecipesSuspect(db, ticket.suspectRecipeIds, ticket.issuedAt);
    if (directGateFailedIds.length) markRecipesSuspect(db, directGateFailedIds, directObservedAt);
    await saveDb(db);
    committed = { bal, tx };   // W4：寫入已成功——生成搬到恢復邊界之外（票放回的論證不可被生成的 await 掏空）
  } catch (e) {
    // ⚠️ 寫入失敗＝把票放回去（2026-08-12 William 實測踩到）：票是同步取走的（擋並發），
    //    但這條路失敗時票就沒了 ⇒ 使用者只能重新上傳、**再花一次 AI 費用**。
    //    ⚠️ 會走到這裡的失敗路徑：getDb 掛掉／對帳閘紅／saveDb 櫃檯清理擋下。
    //    （**不含**「讀不到現值參考日」——那個只跳過更新餘額、不再是失敗。）
    //    放回時保留原 id 與原到期時間（不延長）。
    // ⚠️ **放回不會造成「重放已寫入的匯入」**，理由不是「失敗都在 saveDb 之前」——`saveDb` 自己
    //    也在這個 catch 的射程內（r4#2 指正）。真正的理由是**兩種模式的寫入都不留半套**：
    //    LOCAL 的 `save` 走 SQLite 交易（失敗 ROLLBACK）、HOSTED 走 CAS（版本不合＝一個字都不寫）；
    //    而 saveDb 成功就 `return` 了、根本走不到這裡。
    if (ticket && opts.aiTicket) restoreAiTicket(opts.aiTicket, ticket);
    throw e;
  }
  // P2-3（W4＋r1#3 雙層結構保證）：走到這裡＝saveDb 已成功、票已消耗——生成在恢復 try 之外
  // （reject 也碰不到票放回），呼叫端再包一層硬 catch（reject 也不能把成功的匯入變成 HTTP 失敗）。
  // aiRecipeGen＝測試接縫（r3#1 慣例：正式呼叫端絕不傳；讓「會 reject 的生成」可注入、把這層 catch 釘住）。
  const genFn = /** @type {typeof generateRecipeAfterImport} */ (opts.aiRecipeGen || generateRecipeAfterImport);
  const recipeGen = (ai && ticket)
    ? await genFn(ticket, opts).catch(() => ({ saved: false, reason: 'recipe_gen_failed' }))
    : null;
  return { ok: true, ...committed.bal, transactions: committed.tx, ...(ai || {}),
    ...(recipeUse ? { engine: 'recipe', recipeId: recipeUse.id } : {}),
    ...(recipeGen ? { recipe: recipeGen } : {}) };
}
