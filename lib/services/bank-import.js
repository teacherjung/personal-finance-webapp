// @ts-check
// 銀行對帳單匯入（三層重構 stage 2/3 服務層）。stage 2＝概要區→更新/自動建帳戶餘額（本檔）。
// 密碼＝身分證字號，只在記憶體傳給解析器、絕不落檔；帳單原始 PDF 不持久化。
import { getDb, saveDb, uid, updateRecipeBirthStats } from '../repo.js';
import { canonicalBank, sameBank, canonRef, canonCdKey, looseBankKey } from '../bank-alias.js';
import { parseBankStatement, extractBankLines, accountSuffix as accountSuffixStar, accountSuffixAny as accountSuffix, DEBIT_CARD_SUMMARIES, linkDebitCardRows, cleanAcct, acctPatternsIntersect } from '../bank-statement.js';
// ⚠️ 本檔的 accountSuffix ＝**寬版** accountSuffixAny（先剝空白／連字號再用窄版取遮罩末碼；至少五碼純數字＝末四碼）：完整帳號的列
//   （AI 路線匯進來的）一旦存在，每一把末碼索引都必須認得它，否則重複匯入或漏擋。兩版只在「至少五碼純數字」與「遮罩與末碼之間
//   夾分隔符」上不同——
//   去重鍵帳號段的純數字靠**鍵格式**判來源（`bank|`＝祖父末碼、`bank2|`＝完整號），讀既有列的地方一律走 refSuffixReadings
//   （它用窄版 accountSuffixStar 判「有沒有星號」）；不可拿寬版直接截成四碼（Codex #504 r4#2／r7#3）。
import { reconcileBankStatement, gateFailureMessage, statementCurrencyLookup, BAL_EPS, TOTALS_CHECK } from '../statement-reconcile.js';
import { parseWithPool, statementPasswordPool, previewRowsForCard, importRowsToDb } from './statement-import.js';   // 匯入密碼池（P0.5）：銀行與信用卡同一套嘗試序
// ⚠️ P1b-1 的 import 紀律：lib/ai-parse.js 是**純模組**（schema／提示／驗收／文字，零外連）＝可以進來；
// 字面 fetch 只住 lib/ai-transport.js，**本檔絕不可 import 它**——本檔被 crud.js 等動態路徑路由檔
// import，外連能力沿 import 閉包傳染會讓外連登記閘（hosted-auth 反向對帳）正確地紅。真引擎由路由層
// （lib/routes/statement.js，全靜態路徑、可審計）用 makeAnthropicBankEngine 組成 engineFactory 注入。
import { linesToText, normalizeAiBank, assertAiBankGrounded } from '../ai-parse.js';
import { recipeMatches, parseWithRecipe, validateRecipeStrict, validateRecipeAgainstStatement, recipeReproduces, RECIPE_RULERS } from '../parse-recipe.js';   // 配方快取（P2-2/P2-3）：同版式 app 內解＋出生三關
import { RECIPE_MODEL, pickRecipeCandidate, AI_ARBITER_MODEL, dualReadWanted, aiAnswersAgree, aiDiffSummary, sanitizeAiDiffs } from '../ai-parse.js';
import { saveParseRecipe } from '../repo.js';
import { issueAiTicket, redeemAiTicket, restoreAiTicket } from '../ai-confirm-ticket.js';   // AI 預覽確認票（r4#1：AI 非確定性，apply 不可自己重跑模型）
import { isHosted } from '../hosted.js';   // AI 路線的 HOSTED 停止線（P1b-1）
import { cleanStore, normalizeDesc, finalize as finalizeCardRows } from '../statement.js';   // 收支說明過濾器（2026-07-27）：簽帳卡刷卡消費走信用卡同一條店名管線
import { CURRENCIES, isRealDate } from '../schema.js';
import { STAGES, makeStageSink } from '../progress-stages.js';
import { recordBirth } from '../recipe-birth.js';   // 規則卡出生紀錄（七個關卡各自的次數＝該不該放寬的證據）
import { nowLocal } from './snapshot.js';   // 本地日曆日（UTC 會讓台北早上的紀錄早一天）   // 上傳進度：後端只推代碼、句子住前端（零插值＝機密機械化）
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
  // 分隔符（空白、連字號）先剝——`900-100****3301` 不剝＝比不到「前綴＋星號＋末碼」的形＝前綴當空＝
  //   任何同末碼的戶都配得上（預審 #504 抓到；放寬前對 `900-100****3301` 就是這樣，本支把 X／圓點印法也帶進這條路）。
  const t = String(masked || '').replace(/[\s-]/g, '');
  const m = t.match(/^(\d+)\*+(\d+)$/);
  if (m) return { prefix: m[1], suffix: m[2] };
  // 沒有遮罩的完整帳號（AI 路線、帳單本來就沒遮；William 2026-08-23）：前綴＝末四碼以前的全部、末碼＝末四碼。
  //   登記帳號與它「對不對得上」不在這裡判——那是 accountFit／acctShapesCompatible 的事（完整對完整＝整串全等）。
  if (/^\d{5,}$/.test(t)) return { prefix: t.slice(0, -4), suffix: t.slice(-4) };
  // 全星號遮罩（簽帳金融卡明細 `**********1234`；Codex #494 r1#6）：讀得出末碼、沒有前綴。
  // ⚠️ `x****3302` 這種佔位（bankRefBase 對無遮罩列自己補的）**刻意不在此列**——那是「不知道」。
  const star = t.match(/^[*＊]+(\d+)$/);
  if (star) return { prefix: '', suffix: star[1] };
  return { prefix: '', suffix: '' };
}

/** 帳號字串帶不帶遮罩星號（半形或全形）。 @param {string} s */
const hasStar = (s) => /[*＊]/.test(String(s || ''));
/** 帳號字串的純數字（分隔符、星號全剝）。 @param {string} s */
const digitsOf = (s) => String(s || '').replace(/\D/g, '');
// 帳號的比對形 cleanAcct／語言交集 acctPatternsIntersect 已搬到 lib/bank-statement.js（幣別表的混幣判定也要用同一把尺）——
// 判準單一實作，這裡只 import 回來用（名字不變＝下游一字未動）。
/** 遮罩蓋不蓋得住一個完整號（完整號 ∈ L(遮罩)）：每段可見文字依序吻合、每段星號至少遮一碼、不把星號數當寬度。 @param {string} masked @param {string} full */
function maskCoversFull(masked, full) {
  const f = cleanAcct(full);
  return hasStar(masked) && !!f && !hasStar(f) && acctPatternsIntersect(masked, f);
}
/** 印法是不是「只比末碼」的那種：單一段星號開頭、後面只有末碼（全星號 `****3301`、佔位 `x****3302` 折成全星號後也是）——帳單印成
 * 這樣＝除末碼外什麼都看不到（多段的 `****22**3301` 不算，它露了中段、要逐段比）。 @param {string} acct */
const suffixOnlyShape = (acct) => /^\*+[0-9A-Za-z]+$/.test(cleanAcct(acct));
/** 登記帳號對帳單帳號的身分判定（呼叫端只篩機構／幣別／型別，**不**先比末碼——末碼是形狀的一部分、由語言交集一起判）：`'hit'`＝證明是同一顆／`'no'`＝不是／`'ambiguous'`＝相容但證明不了。
 * ⚠️ **相容≠命中**（Codex #504 r3#1）：`9001****3301` 只代表「某個 9001 開頭、3301 結尾的戶」，不能證明就是登記的
 *   `900133****3301`——挑一顆＝蓋錯餘額、新建＝同一顆戶拆兩顆（資產多算一份）。兩邊比的都是 `cleanAcct` 的比對形
 *   （字母保留、分隔符剝掉、遮罩統一成半形星）；相容＝語言有交集（`acctPatternsIntersect`）。
 * 判定順序（先到先算）：
 * ①比對形**全等**＝hit（任何形狀；星號數不算差異）。
 * ②帳單是「只比末碼」的形（`****3301`／`x****3302` 佔位）**沒有特例**：它就是「前面至少一碼、後面 3301」的語言——登記完整號
 *   且蓋得住＝hit（③）、登記是另一個遮罩形＝有交集也只能 ambiguous（⑤；存在可能相同不等於證明相同，Codex #504 r9#1）。
 * ③帳單印完整號：登記完整號＝不全等就 no；登記遮罩形（含看不到前綴的）＝蓋得住＝**ambiguous**、其餘 no——登記的遮罩是自動建戶
 *   抄來的、證明不了它就是這個完整號（`900100****3301` 可能是 `…1111…` 也可能是 `…9999…`；r5#1／r6#2）；停手請使用者到資產頁
 *   把帳號補成完整號，之後全等就命中。Stage 1 的標記戶（`accountNoSuffixOnly`）不進裁決器、走 matchAccount 自己的寬鬆徑。
 * ④帳單是遮罩、登記**完整號**＝帳單遮罩蓋得住登記號＝hit、其餘 no——登記的完整號是使用者給的身分，帳單與之一致就是它
 *   （既有行為；「藏幾碼＝幾顆星」不是證據）。
 * ⑤兩邊都是遮罩（不全等）＝語言有交集＝ambiguous、其餘 no（含登記是全星號的：證明不了就停手，不新建）。
 * @param {string} accountNo 登記帳號 @param {string} stmtAcct 帳單帳號 @returns {'hit'|'no'|'ambiguous'} */
function accountFit(accountNo, stmtAcct) {
  const Sc = cleanAcct(stmtAcct), Rc = cleanAcct(accountNo);
  if (Sc === Rc) return 'hit';
  const sStar = hasStar(Sc), rStar = hasStar(Rc);
  if (!sStar) {
    if (!rStar) return 'no';
    return maskCoversFull(Rc, Sc) ? 'ambiguous' : 'no';
  }
  if (!rStar) return maskCoversFull(Sc, Rc) ? 'hit' : 'no';
  return acctPatternsIntersect(Rc, Sc) ? 'ambiguous' : 'no';
}
/** 候選裁決器（餘額 `matchAccount`／幣別 `txCurrency`／交易掛名 `accountNameForTx` **三處共用**，免得各漂各的）：
 * **唯一且已證明**的命中才算命中；多重命中、命中與「證明不了」並存、只有「證明不了」＝停手（呼叫端：不更新、不新建、
 * 不掛既有戶）；全部都不是＝沒有（呼叫端走自己的退路）。 @param {any[]} cands @param {string} stmtAcct */
function resolveCandidates(cands, stmtAcct) {
  const fits = cands.map(a => ({ a, fit: accountFit(a.accountNo, stmtAcct) }));
  const hits = fits.filter(x => x.fit === 'hit'), amb = fits.filter(x => x.fit === 'ambiguous');
  if (hits.length === 1 && !amb.length) return { hit: hits[0].a, ambiguous: false };
  if (hits.length || amb.length) return { hit: null, ambiguous: true };
  return { hit: null, ambiguous: false };
}

/** 這份帳單的開戶機構（P1a 銀行身分維度）。缺席＝'台新'——祖父條款：機構維度之前的整條產線
 * （既有解析器、既有測試的合成 parsed）都只有台新，缺席的語意就是「台新時代的資料」。
 * **一律回正規短名**（Stage 4：`lib/bank-alias.js` canonicalBank）——這是機構名進去重鍵、機構戳、
 * 疑似重複索引的**唯一入口**，AI 路線照抬頭抄的「台新國際商業銀行」在這裡壓回「台新」，
 * 去重鍵才會走 `bank|` 祖父格式、與內建範本對得上。 @param {{bank?:string}} parsed */
function stmtBank(parsed) {
  return canonicalBank(String((parsed && parsed.bank) || '')) || '台新';
}

/**
 * 找帳單這筆對應的既有帳戶——對抗審查強化（避免財務資料靜默損毀，生存優先）：
 * ①**只比對現金帳戶**（自動建的都是 cash）——否則尾碼碰巧相同的負債/保單/投資帳戶餘額會被覆蓋、負債翻成資產、淨資產算錯。
 * ②**可見前綴＋末碼都要對**（遮罩露出 900100 vs 900200）——只比末碼（3~4 碼）會讓不相干帳戶尾碼碰撞而錯戶覆蓋。
 * ③在 `existing` 快照上比對（呼叫端傳匯入前的帳戶快照）——否則同一張帳單裡兩筆會比對到「本批剛新建的那筆」而互吃。
 * ④**機構維度（P1a）**：帳戶記了開戶機構（a.bank）就必須與帳單機構一致——不同銀行的相同可見帳號段不可互相
 *   覆蓋餘額。a.bank 缺席（機構維度之前建的帳戶、手動建立的帳戶）＝照舊只比數字；誠實劃界：這條祖父路徑
 *   仍有「舊帳戶與未來他行帳單可見數字全同」的理論碰撞（前綴＋末碼都得撞、機率極低），要關死得等帳戶補登機構。
 * @param {any[]} existing 匯入前的帳戶快照 @param {{suffix:string, masked:string, currency:string, suffixOnly?:boolean}} pa
 * @param {string} [bank] 帳單的開戶機構（匯入端傳 stmtBank(parsed)；reconcileBankTxAccountNames 對舊格式列傳 '台新'＝祖父身分。祖父的「寬鬆」由**帳戶側** a.bank 缺席承擔，不靠呼叫端缺席——正式呼叫端一律有傳）
 */
function matchAccount(existing, pa, bank) {
  const suffix = pa.suffix;
  if (!suffix) return { hit: null, ambiguous: false };
  const { prefix } = maskedParts(pa.masked);
  const eligible = (/** @type {any} */ a) => {
    if ((a.type || 'cash') !== 'cash') return false;                               // 只更新現金帳戶
    if (a.cdKey) return false;                                                     // 定存帳戶（分開列管）＝只走 cdKey 精確配對——泛用比對撿到它會讓活存餘額蓋進定存、交易掛名掛到定存戶
    if (a.bank && bank && !sameBank(a.bank, bank)) return false;                   // 機構維度：登記過機構的帳戶不可跨行比對（P1a）；比對兩邊都正規化＝舊戳「台新銀行」也認親（Stage 4 祖父）
    return (a.currency || 'TWD') === (pa.currency || 'TWD');
  };
  const base = (/** @type {any} */ a) => {
    if (!eligible(a)) return false;
    const d = String(a.accountNo || '').replace(/\D/g, '');
    return d.length >= suffix.length && d.endsWith(suffix);
  };
  const cands = existing.filter(base);   // 同末碼候選（寬鬆徑與帳單內重複末碼判定用）
  // ⚠️ 帳單自己就印了**同末碼的多個帳號**（Grok #494 掃 G1：900100****1234 與 900200****1234
  //   同一份出現）＝末碼在這份帳單上**本來就不唯一**——寬鬆徑（憑末碼認親）的前提整個不成立：
  //   兩列會先後命中同一顆標記戶，第一列補登完前綴、第二列再 create＝補登錯＋裂戶。
  //   呼叫端算好旗標帶進來；嚴格徑不受影響（前綴分得開）。
  const dupInStatement = /** @type {any} */ (pa).dupSuffixInStatement === true;
  if (/** @type {any} */ (pa).suffixOnly === true) {
    // ⚠️ 帳單自己只有末碼（簽帳金融卡明細／全星號遮罩）＝整條都是寬鬆比對，兩道收緊：
    // ①**明確同 bank 才可配**（Codex #494 r1#3）：完整遮罩路徑的「a.bank 缺席＝祖父寬鬆」靠
    //   前綴＋末碼雙重吻合撐著；這條路**沒有前綴**，祖父寬鬆＝只剩四碼就敢蓋餘額——他行或
    //   手建的同末碼戶會被亂蓋。bank 缺席的同末碼戶＝「無法證明是誰」＝歧義停手，不新建
    //  （新建＝裂戶）也不更新。
    // ②**唯一命中才配**：多顆同末碼挑第一顆＝把餘額蓋到別人頭上。
    if (dupInStatement) return { hit: null, ambiguous: true };   // 帳單末碼不唯一＝憑末碼的認定全不成立（G1 同判準）
    const unproven = cands.filter(a => !a.bank);
    const proven = cands.filter(a => sameBank(a.bank, bank || ''));   // bank 缺席＝sameBank 一律 false＝沒有任何一顆能證明（同「無法證明是誰」）
    if (unproven.length) return { hit: null, ambiguous: true };
    if (proven.length > 1) return { hit: null, ambiguous: true };
    return { hit: proven[0] || null, ambiguous: false };
  }
  // 嚴格徑：可見前綴也要對（免尾碼碰撞）——判準收在 accountFit 三態＋resolveCandidates（唯一且證明的命中才算）。
  // ⚠️ 嚴格命中**先放行**（Codex #494 r4#1 第二情境）：dup 停手若排在這之前，「手動補過完整
  //   帳號、標記殘留」的戶連前綴全等的正路都被誤擋——900100 帳單對 900100 戶本來就分得清清楚楚，
  //   帳單上另有 900200 不構成歧義（前綴就是分辨器）。dup 只擋**憑末碼**的寬鬆徑。
  // Stage 1 標記戶（金融卡建的、帳號只有末四碼＝全星號或純末碼）不進裁決器——它的身分本來就不完整，由下面的寬鬆徑專責
  //   （r6#2：全星號登記對完整號帳單在裁決器會是 ambiguous，標記戶就永遠補登不了）。
  // ⚠️ 裁決器看**所有**符合機構／幣別／型別的戶，不先用單向末碼 endsWith 篩（Codex #504 r8#1：`9001****301` 的登記戶對
  //   `9001****3301` 語言有交集、卻被末碼篩掉＝裂戶；兩顆相交的戶一顆被篩掉＝本該停手卻更新）。形狀由 accountFit 一把判。
  const isFlagged = (/** @type {any} */ a) => a.accountNoSuffixOnly === true && digitsOf(a.accountNo) === suffix;
  const strict = resolveCandidates(existing.filter(a => eligible(a) && !isFlagged(a)), pa.masked);
  if (strict.hit) return strict;
  if (strict.ambiguous) return strict;   // 證明不了／多顆命中＝停手（不更新、不新建）
  // 寬鬆徑（Stage 1，William 2026-08-20 三情境的②）：帳單有完整前綴、但既有帳戶是金融卡先建的
  // **suffixOnly 戶**（accountNo 只有末四碼＝嚴格徑的 startsWith 必掛）——認親的前提是
  // **同末碼的候選就只有它一顆、而且它帶標記**（Codex #494 r1#1：只查「標記戶唯一」不夠——
  // 完整戶 900100＋標記戶並存、帳單是 900200 時，末碼其實有兩顆，「只有一顆帶標記」推不出
  // 標記戶就是 900200；那次補登**不可逆**且是錯的）。
  if (prefix) {
    // ⚠️ 標記可能**過期**（Grok #494 掃 G2）：使用者在資產頁手動補了完整帳號（accountNo 在 CRUD
    //   白名單、標記不在）——那時帳號已有前綴，寬鬆徑若還信標記，會把使用者親手填的 900100
    //   覆寫成帳單的 900200。**寬鬆徑只信「帳號數字部分＝末碼而已」的標記戶**；數字更長＝
    //   身分其實已完整＝交給嚴格徑（前綴對得上就配、對不上就是另一顆帳戶）。
    const stillPartial = (/** @type {any} */ a) => a.accountNoSuffixOnly === true
      && String(a.accountNo || '').replace(/\D/g, '') === suffix;
    if (cands.some(stillPartial)) {
      // 帳單末碼不唯一（G1）＝憑末碼認親的前提不成立——只在**真的要走寬鬆徑**（有真標記戶）時停手
      if (dupInStatement) return { hit: null, ambiguous: true };
      if (cands.length === 1) return { hit: cands[0], ambiguous: false };
      return { hit: null, ambiguous: true };   // 真標記戶＋別的同末碼戶並存＝分不出，停手
    }
  }
  return { hit: null, ambiguous: false };
}

/** 自動建立帳戶的預設名（使用者可改）。 @param {{suffix:string,label:string,note:string}} pa @param {string} bank 開戶機構 */
function autoName(pa, bank) {
  const tag = (pa.note || pa.label || '').trim();
  return `${bank} ${pa.suffix}${tag ? `（${tag}）` : ''}`;
}

/** @typedef {{ bank?:string, referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string,kind?:string,period?:string}[], accountCurrency?:Record<string,string> }} ParsedBank */

/** 定存列註記（2026-08-18 分開列管；preview/apply 共用＝序號單一實作）：
 * 對 kind==='time' 的概要列造身分鍵 cdKey＝`機構|末碼|幣別|起迄日|金額|#序`——存單號帳單不印、
 * 兩筆定存可完全同值（William 的兩筆 51 美元實例），「第幾筆」只能靠列印順序；台新每期
 * 依同一順序列印＝跨月可配對（順序若變＝配錯期別的**餘額**，定存餘額到期前不變＝實害趨零）。
 * @param {ParsedBank} parsed @param {string} bank
 * @returns {Map<any, {cdKey:string, occ:number, sameCount:number}>} 以列物件為鍵 */
function annotateCdRows(parsed, bank) {
  /** @type {Map<string, any[]>} */ const groups = new Map();
  for (const pa of parsed.accounts || []) {
    if (pa.kind !== 'time') continue;
    // 金額進身分（設計裁量）：不同額的定存各自成鍵（跨月配對不吃列印順序）；只有**完全同值**的
    // 定存（William 的兩筆 51 美元實例）才靠列印序分「第幾筆」——同值互換無感＝順序依賴縮到無害。
    // 定存餘額到期前不變＝鍵穩定；續存＝新期別＝自然成新帳戶（舊的留著、名稱帶期別一眼可辨）。
    const sig = `${bank}|${pa.suffix}|${pa.currency}|${pa.period || ''}|${pa.balance}`;
    const g = groups.get(sig); if (g) g.push(pa); else groups.set(sig, [pa]);
  }
  /** @type {Map<any, {cdKey:string, occ:number, sameCount:number}>} */ const out = new Map();
  for (const [sig, rows] of groups) rows.forEach((pa, i) => out.set(pa, { cdKey: `${sig}|#${i + 1}`, occ: i + 1, sameCount: rows.length }));
  return out;
}

/** 到期歸零的判定（William 2026-08-18 裁示 b：過了迄日**且**帳單不再印那筆＝自動歸零、名稱加「已到期」）。
 * ⚠️ 三個條件缺一不可，全是為了「不誤歸零」：
 * ①**這張帳單涵蓋得到它**（同機構、且它的末碼真的出現在本次帳單的帳號集合）——不然傳別家/別戶的帳單
 *   會把無關定存歸零；②**這次帳單沒有印它**（cdKey 不在本批定存列）；③**現值參考日已過迄日**（迄日從
 *   cdKey 的期間段解析；解析不出＝**不歸零**＝fail-safe：舊帳戶或無期間版面寧可留著）。
 * 已經是 0 的不重複動（避免每期重寫 balanceAsOf 與重複加註）。
 * @param {any[]} accounts db 帳戶 @param {ParsedBank} parsed @param {string} bank @param {Set<string>} liveKeys 本批定存的 cdKey
 * @param {string} ref 現值參考日 @returns {any[]} 該歸零的帳戶 */
function maturedCdAccounts(accounts, parsed, bank, liveKeys, ref, deterministic) {
  // r1#1【高】**適用前提＝這批 accounts 真的帶得出定存結構**（2026-08-18 起 AI 答案卷也有 kind/period，
  //   所以這道判準已**不足以**分辨路線——真正擋住機率性路線的是上面那道 deterministic；本段留著當第二道）：
  // （2026-08-18 起 AI 答案卷也有 kind；配方仍沒有）⇒ 沒有 kind 時 annotateCdRows 產出空的 liveKeys
  //   ⇒「這期不再印它」恆成立
  // ⇒ 明明還印著的定存會被歸零（審查者可達情境：AI 解同一張帳單、預覽同時出現 create＋mature-zero）。
  // 第二道判準＝本批**有任何一列帶 kind 欄**（模板恆有、配方恆無；**AI 自 2026-08-18 起也有**）。
  // ⚠️ **只有確定性解析才准判死活**（Codex #488 r1#1）：舊判準是「這批 accounts 有沒有 kind 欄」，
  //   但 AI 答案卷把 kind 設成**必填**之後，每一份 AI 答案都自稱結構化——AI 只要把一列定存誤標成
  //   demand，那列就被同遮罩去重吃掉、而 db 裡那顆定存又因「本批沒印它」被歸零＝**總額靜靜變少**。
  //   機率性路線（AI／配方）讀漏一列是可能的，確定性路線（內建範本）不會；所以歸零只吃後者。
  //   代價照實記：AI 路線的定存到期後不會自動歸零，要等哪一期走模板、或使用者自己改。
  if (!deterministic) return [];
  const structured = (parsed.accounts || []).some(pa => typeof (/** @type {any} */ (pa).kind) === 'string');
  if (!structured) return [];
  const covered = new Set();   // 這張帳單涵蓋的末碼（含餘額空白只在幣別表出現的）
  for (const k of Object.keys(parsed.accountCurrency || {})) covered.add(accountSuffix(String(k)));
  for (const pa of parsed.accounts || []) covered.add(pa.suffix);
  // ⚠️ 兩端都正規化成 ISO 再比（Grok r0 提【高】：只換迄日的 / ＝'2026/01/01' > '2026-12-31' 為真
  //（'/' 字碼大於 '-'）＝迄日沒到也誤歸零）。**誠實劃界：這條在正式路不可達**——applyBalancesToDb
  // 開頭的 isRealDate(ref) 會把非 ISO 參考日整份擋成 balancesSkipped，走不到這裡（考題實證）。
  // 保留正規化＝縱深防禦（未來若有呼叫端不先驗 ref，這裡不會反向），由直測接縫咬住、不假裝它擋過真彈。
  const iso = (/** @type {any} */ d) => String(d || '').replace(/\//g, '-').trim();
  const refIso = iso(ref);
  if (!isRealDate(refIso)) return [];                          // 參考日本身讀不出＝不判死活
  return (accounts || []).filter(a => {
    if (!a.cdKey || Number(a.balance || 0) === 0) return false;
    // 機構戳 fail-safe（Grok r0【中】）：**沒戳就不歸零**——本支新建的定存戶一定有戳，沒戳的是
    // 手動建/舊資料，別家帳單同末碼撞上就會誤清。與 matchAccount 的「無戳＝寬鬆」刻意相反：
    // 那邊猜錯只是餘額下期自我修正，這邊猜錯是把還在的定存清成 0。
    if (!a.bank || !bank || !sameBank(a.bank, bank)) return false;
    const parts = String(a.cdKey).split('|');
    const suffix = parts[1] || '';
    if (!covered.has(suffix)) return false;                    // 這張帳單根本沒涵蓋它＝不判它死活
    if (liveKeys.has(canonCdKey(a.cdKey))) return false;       // 這期還印著＝還在（liveKeys 已是比對形；舊戶鍵的機構段要先壓過才對得上）
    // r1#2【高】到期分支也吃 stale guard：先匯 6/30（銀行仍印該定存）、再倒序匯 5/31（未印）＝
    // 舊帳單把較新的餘額清成 0、balanceAsOf 還倒退。與活存列的「相等或較舊都不覆蓋」同一把尺。
    if (a.balanceAsOf && refIso <= String(a.balanceAsOf)) return false;
    const end = (parts[3] || '').split('~')[1] || '';          // 期間段的迄日（YYYY/MM/DD）
    const endIso = iso(end);
    if (!isRealDate(endIso)) return false;                     // 讀不出迄日＝不歸零（fail-safe）
    return refIso > endIso;                                    // **嚴格大於**＝迄日當天仍算在存（當天才解約）
  });
}

/** 到期帳戶的新名字：加「（已到期）」；已加過就不重複加。 */
function maturedName(/** @type {any} */ a) {
  const n = String(a.name || '');
  return /[（(]已到期[）)]/.test(n) ? n : `${n}（已到期）`;   // 半形括號也算已加註（Grok r0：只認全形＝手動改過的名字會被追加第二截）
}

/** 定存帳戶的預設名（使用者可改）：期間＋金額放名字裡（到期日與哪一筆一眼可見）；
 *  完全同值的多筆才帶「第 n 筆」。 */
function autoNameCd(/** @type {any} */ pa, /** @type {string} */ bank, /** @type {number} */ occ, /** @type {number} */ sameCount) {
  const cur = pa.currency === 'TWD' ? '' : ` ${pa.currency}`;
  const span = pa.period ? ` ${String(pa.period).replace(/~/, '〜')}` : ` 末${pa.suffix}`;
  return `${bank}${cur} 定存${span}・$${pa.balance}${sameCount > 1 ? `（第${occ}筆）` : ''}`;
}

/**
 * 預覽（純函式、不寫檔）：對照既有帳戶，列出每筆「會更新／會新建／因帳單較舊而跳過」。
 * @param {any} db @param {ParsedBank} parsed
 */
export function previewBalancesForDb(db, parsed, opts = {}) {
  const ref = parsed.referenceDate;
  const bank = stmtBank(parsed);
  // ⚠️ `blocked` ＝「**這次不會更新餘額**」，**不是**「整份擋下」——交易照樣匯入。
  //    欄位名容易讓人誤讀成後者，所以在這裡講死：不要照名字推論行為。
  const blocked = !ref || !isRealDate(ref);
  const existing = [...(db.accounts || [])];
  markDupSuffixInStatement(parsed);                   // 帳單內同末碼多帳號＝寬鬆徑停手（G1，preview 同判準；含只在幣別表的無餘額帳戶）
  const cdRows = annotateCdRows(parsed, bank);
  const seen = new Set();   // 與 apply 同一套去重（2026-08-18 起 preview 也去重＝預覽所見＝匯入所得；舊版 preview 不去重、apply first-wins＝兩邊筆數不一致的既有縫）
  /** @type {any[]} */ const rows = [];
  for (const pa of parsed.accounts) {
    if (!CURRENCIES.includes(pa.currency)) {
      rows.push({ suffix: pa.suffix, currency: pa.currency, balance: pa.balance, label: pa.label, matchedName: null, oldBalance: null, action: 'unsupported' });
      continue;
    }
    const cd = cdRows.get(pa);
    const key = cd ? `cd|${cd.cdKey}` : `${pa.masked}|${pa.currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = cd ? { hit: existing.find(a => a.cdKey && canonCdKey(a.cdKey) === canonCdKey(cd.cdKey)) || null, ambiguous: false } : matchAccount(existing, pa, bank);   // cdKey 比對形（Stage 4 祖父：舊戶的機構段是原寫法）
    const acc = m.hit;
    const stale = !!(acc && acc.balanceAsOf && ref && ref <= acc.balanceAsOf);   // 相等或較舊都不覆蓋
    rows.push({
      suffix: pa.suffix, currency: pa.currency, balance: pa.balance,
      label: cd ? autoNameCd(pa, bank, cd.occ, cd.sameCount) : pa.label,
      matchedName: acc ? acc.name : null,
      oldBalance: acc ? Number(acc.balance || 0) : null,
      // ambiguous＝證明不了是哪一顆：單顆形狀相容但證明不了（登記遮罩形對完整號帳單）、或多顆候選裁決不了（同末碼多戶／相交多戶）：**不更新也不新建**（挑一顆＝把餘額
      // 蓋到別人頭上、新建＝多長一顆戶）；照實顯示讓使用者自己整理帳戶。
      action: blocked ? 'blocked' : (m.ambiguous ? 'ambiguous' : (acc ? (stale ? 'skip-stale' : 'update') : 'create')),
    });
  }
  // 到期歸零（裁示 b）也要在預覽現形——所見即所得：不能匯入後才發現餘額被清成 0。
  if (!blocked && ref) {
    const liveKeys = new Set([...cdRows.values()].map(c => canonCdKey(c.cdKey)));
    for (const a of maturedCdAccounts(existing, parsed, bank, liveKeys, ref, opts.deterministic === true)) {
      rows.push({ suffix: String(a.cdKey).split('|')[1] || '', currency: a.currency || 'TWD', balance: 0,
        label: maturedName(a), matchedName: a.name, oldBalance: Number(a.balance || 0), action: 'mature-zero' });
    }
  }
  return { bank: parsed.bank ? stmtBank(parsed) : null, referenceDate: ref, blocked, rows };
}

/**
 * 套用（純函式、就地改 db、不寫檔）：更新既有帳戶餘額（**現值參考日較新才覆蓋，相等也不覆蓋**）＋自動建立沒有的帳戶。
 * 自動建的帳戶 type:'cash'、class:'現金'、**不設 ibCashCur**（避免污染投組現金/槓桿）；accountNo 存遮罩帳號。
 * 對抗審查強化：①現值參考日過真實日曆（壞日期不進 balanceAsOf 撞櫃檯 500）②不支援幣別（非 CURRENCIES）
 * graceful skip（一個冷門幣別不擋整張帳單）③在「匯入前快照」上比對（免同批互吃）＋同批遮罩去重。
 * @param {any} db @param {ParsedBank} parsed
 */
export function applyBalancesToDb(db, parsed, opts = {}) {
  const ref = parsed.referenceDate;
  const bank = stmtBank(parsed);
  // ⚠️ **讀不到現值參考日＝只跳過「更新餘額」，不再整份退回**（William 2026-08-13）：
  //    交易明細**根本用不到**這個日期（importBankTxToDb 從頭到尾沒讀它），只有「這份帳單的餘額
  //    比 app 裡的新嗎」才需要。以前整份 throw 等於因為一個欄位讀不到，把整批交易也一起擋掉。
  //    ⚠️ 保守的部分**一點都沒放寬**：不知道新舊就**絕不覆蓋餘額**（拿舊的蓋掉新的是無聲毀資料，
  //    這個專案最嚴重的一族）。差別只在「不覆蓋」不再連坐到交易。
  //    ⚠️ 呼叫端必須把 `balancesSkipped` 講給使用者聽——餘額沒更新卻不說，等於畫面說謊。
  if (!ref || !isRealDate(ref)) {
    return { bank: parsed.bank ? stmtBank(parsed) : null, referenceDate: null, balancesSkipped: true,
      updated: 0, created: 0, skipped: 0, unsupported: 0, createdNames: /** @type {string[]} */ ([]) };
  }
  const existing = [...(db.accounts || [])];          // 快照：只比對匯入前就有的帳戶，避免同批新建的互相吃掉
  markDupSuffixInStatement(parsed);                   // 帳單內同末碼多帳號＝寬鬆徑停手（G1；含只在幣別表的無餘額帳戶）
  const cdRows = annotateCdRows(parsed, bank);
  const seen = new Set();
  let updated = 0, created = 0, skipped = 0, unsupported = 0;
  /** @type {string[]} */
  const createdNames = [];
  for (const pa of parsed.accounts) {
    if (!CURRENCIES.includes(pa.currency)) { unsupported++; continue; }            // 冷門幣別跳過、不擋整份
    const cd = cdRows.get(pa);
    // 定存列各自有身分鍵＝不再被「同遮罩去重」吃掉（分開列管的核心）；活存列鍵照舊。
    const key = cd ? `cd|${cd.cdKey}` : `${pa.masked}|${pa.currency}`;
    if (seen.has(key)) continue;                        // 同批重複列去重（防兩筆相同遮罩互吃）
    seen.add(key);
    const m = cd ? { hit: existing.find(a => a.cdKey && canonCdKey(a.cdKey) === canonCdKey(cd.cdKey)) || null, ambiguous: false } : matchAccount(existing, pa, bank);   // cdKey 比對形（Stage 4 祖父：舊戶的機構段是原寫法）
    const acc = m.hit;
    if (m.ambiguous) { skipped++; continue; }   // 證明不了（單顆相容或多顆裁決不了）＝不動（與預覽的 'ambiguous' 同判準；挑一顆或新建都比不動更危險）
    if (acc) {
      if (acc.balanceAsOf && ref <= acc.balanceAsOf) { skipped++; continue; }      // 相等或較舊都不覆蓋（保住手動修正）
      // 帳號補登（Stage 1，William 三情境的②）：金融卡先建的戶只記末四碼（suffixOnly 標記），
      // 綜合對帳單帶著完整遮罩來配到它＝把帳號補登成完整的、清掉標記。**只增不減**：
      // 金融卡帳單（沒有前綴可給）配到完整號碼戶時，這裡不會動 accountNo。
      // ⚠️ 補登在 stale 判定**之後**（Codex #494 r1#5）：較舊帳單的預覽寫著「跳過」，apply 卻
      //   偷偷改了帳號身分＝預覽與套用不一致，而補登沒有 undo；skip 就是 skip、什麼都不動，
      //   下一期較新的帳單自然會補登。
      if (acc.accountNoSuffixOnly === true && maskedParts(pa.masked).prefix) {
        acc.accountNo = pa.masked;
        delete acc.accountNoSuffixOnly;
      }
      // 手建戶的帳號恰好**只有末四碼**（digits 全長＝末碼長）且沒有標記（Codex #494 r1#4）：
      // 金融卡配到它之後補上標記——「這顆的帳號只有末四碼」是**事實陳述**（不會錯），
      // 有了標記，日後綜合對帳單才走得了寬鬆徑認親；不補＝嚴格徑 miss、loose 也 miss ⇒ 裂戶。
      if (/** @type {any} */ (pa).suffixOnly === true && !acc.accountNoSuffixOnly
        && String(acc.accountNo || '').replace(/\D/g, '') === pa.suffix) {
        acc.accountNoSuffixOnly = true;
      }
      acc.balance = pa.balance;
      acc.balanceAsOf = ref;
      updated++;
      // ⚠️ 刻意**不**在比對成功時回填 acc.bank：比對是「數字撞上」的推論、不是帳單的宣告——猜錯的餘額下一期
      // 帳單會自我修正，猜錯的機構戳卻會從此**擋掉**正確比對（硬排除），寧缺勿錯。機構戳只在「新建」時蓋。
    } else {
      const name = cd ? autoNameCd(pa, bank, cd.occ, cd.sameCount) : autoName(pa, bank);   // 新建（到期歸零在迴圈後）
      (db.accounts ||= []).push({
        // bank＝開戶機構（P1a）：新建帳戶蓋機構戳——這是帳單自己的宣告（parsed.bank），非推論。
        // 服務層寫、非 CRUD 白名單（同 balanceAsOf/ibCashCur 前例）；日後 matchAccount 憑它擋跨行誤配。
        // cdKey（分開列管）：定存帳戶的身分鍵——之後每期帳單憑它精確更新這一筆；到期（過迄日＋這期
        // 不再印）＝**自動歸零並加註「已到期」、但不刪帳戶**（William 2026-08-18 裁示 b；細則見
        // maturedCdAccounts）。⚠️ 舊註解寫「不自動歸零」＝已被取代的方案，勿據以回改。
        id: uid(), name, type: 'cash', class: '現金', bank,
        currency: pa.currency, balance: pa.balance, accountNo: pa.masked, balanceAsOf: ref,
        ...(cd ? { cdKey: cd.cdKey } : {}),
        // accountNoSuffixOnly（Stage 1）：這顆戶的帳號只知道末四碼（簽帳金融卡明細建的）——
        // 日後綜合對帳單帶完整遮罩來，matchAccount 憑這個標記走寬鬆徑認出同一顆並補登。
        // 服務層寫、非 CRUD 白名單（同 balanceAsOf/bank 前例）。
        ...(/** @type {any} */ (pa).suffixOnly === true ? { accountNoSuffixOnly: true } : {}),
      });
      created++;
      createdNames.push(name);
    }
  }
  // 到期歸零（William 2026-08-18 裁示 b）：過了迄日且這期帳單不再印它＝餘額歸零、名稱加「已到期」。
  // 為什麼歸零而不是刪：帳戶留著＝歷史與交易掛名不斷線；歸零＝淨值不再雙計（到期資金已回活存）。
  const liveKeys = new Set([...cdRows.values()].map(c => canonCdKey(c.cdKey)));
  /** @type {string[]} */ const maturedNames = [];
  for (const a of maturedCdAccounts(db.accounts || [], parsed, bank, liveKeys, ref, opts.deterministic === true)) {
    a.balance = 0; a.balanceAsOf = ref; a.name = maturedName(a);
    maturedNames.push(a.name);
  }
  // noAccounts＝這份帳單根本沒有可更新的帳戶（簽帳金融卡明細只印末四碼那條路）——完成提示要跟著
  // 改口，不然會印「帳戶：更新 0、新建 0」讓人以為是出了什麼問題（Codex #492 r1#2 同族）。
  return { bank: parsed.bank ? stmtBank(parsed) : null, referenceDate: ref, balancesSkipped: false, noAccounts: !(parsed.accounts || []).length, updated, created, skipped, unsupported, createdNames,
    ...(maturedNames.length ? { matured: maturedNames.length, maturedNames } : {}) };
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
/** 簽帳金融卡明細（Stage 5b，William 2026-08-23 選 A 案）：同一筆刷卡在 A 區（買了什麼）與 D 區（錢的流向）各印一次。
 * A 區記到卡片帳本（帶分類）；對得上的 D 區「刷卡消費／刷卡退貨」列**分類留空**——同繳卡費模型：現金流照算錢進錢出，
 * 消費分析只算卡片帳本那一份，錢不算兩次。
 *
 * **逐筆對照、兩邊互為條件**（送審前預審抓到的兩個洞：①帳戶那邊的刷卡列若是之前別份帳單匯進來的、帶著分類，
 * A 區再帶分類進卡片＝算兩次 ②只看「帳單有沒有 A 區」留空，A 區少讀一筆時那筆兩本帳都沒分類＝少算）：
 *   ・A 區的筆**只在**它對得上一列 D 區刷卡列、而且那一列會被留空（或早已留空）時，才記到卡片帳本；
 *   ・D 區刷卡列**只在**它對得上一筆會記進卡片帳本的 A 區筆時，才留空；
 *   ・對不上（兩區筆數不一）、A 區那筆抄得不完整（store 空、含分段符、金額 0）、或帳戶那邊**早就有同日同額同方向、
 *     帶分類的刷卡列**（之前匯過綜合對帳單／AI 路線）＝A 區那筆**不記**、D 區那列**不留空**——寧可卡片帳本少一筆
 *     （看得見、可事後補），也不算兩次錢（看不見）。同鍵多筆（ambiguous）整群照最保守的走。
 * 純函式、preview／apply 共用＝「預覽說幾筆、套用就記幾筆」。
 * @param {any} db @param {ParsedBankFull} parsed
 * @returns {{ blankTx: Set<number>, importable: number[], skipped: {unmatched:number, unreadable:number, cashflowCategorized:number} }} */
function debitCardPlan(db, parsed) {
  const cardRows = Array.isArray(parsed.cardRows) ? parsed.cardRows : [];
  const txs = parsed.transactions || [];
  /** @type {Set<number>} */ const blankTx = new Set();
  /** @type {number[]} */ const importable = [];
  const skipped = { unmatched: 0, unreadable: 0, cashflowCategorized: 0 };
  if (!cardRows.length) return { blankTx, importable, skipped };
  const link = linkDebitCardRows(cardRows, txs);
  skipped.unmatched += link.unmatchedCards.length;
  // 帳戶那邊**早就在**的刷卡列（source:'bank'、刷卡摘要、帶分類、同機構同末碼）：鍵＝日期|方向|金額。
  //   方向走 txDirection（舊列可能沒有 dir 欄＝從 bankRef 還原；Codex #503 r1#4）；機構走同一把尺 sameBank
  //   （別家銀行同末碼同日同額的刷卡不可誤擋台新的 A 區）；帳號段純末碼的最舊鍵也要認得。
  const bank = stmtBank(parsed);
  const suffixes = new Set(txs.map((t) => t.acctSuffix).filter(Boolean));
  /** @type {Set<string>} */ const categorized = new Set();
  for (const t of db.transactions || []) {
    if (t.source !== 'bank' || !t.category) continue;
    const raw = bankRawText(t);
    if (!DEBIT_CARD_SUMMARIES.includes(raw.summary)) continue;
    if (!sameBank(raw.bank, bank)) continue;
    const parts = String(t.bankRef || '').split('|');
    const masked = (parts[0] === 'bank2' ? parts[2] : parts[1]) || '';
    if (!refSuffixReadings(masked, parts[0] === 'bank2').some(r => suffixes.has(r.suffix))) continue;   // 純數字段靠鍵格式判來源（祖父末碼／完整號）
    const dir = txDirection(db, t);
    if (!dir) continue;
    categorized.add(`${t.date}|${dir}|${Number(t.amount) || 0}`);
  }
  const importableRow = (/** @type {import('../bank-statement.js').DebitCardRow} */ r) =>
    isRealDate(r.date) && Number.isFinite(r.amount) && r.amount !== 0 && Math.abs(r.amount) <= 1e8 && !!r.desc && !r.desc.includes('|')
    && (r.fee == null || (Number.isFinite(r.fee) && Math.abs(r.fee) <= 1e8));   // 與 importRowsToDb 的拒收條件同一套；fee 也在**計畫層**驗（Codex #509 r5#2：寫入層才略過＝「預覽說幾筆、套用記幾筆」分家，之後的列批次對位還錯位）
  // 同鍵多筆（ambiguous）整群一起判：群裡任一筆不可記、或**兩區這一鍵的筆數不等**＝整群都不記、整群都不留空
  //   （最保守；Codex #503 r1#1：不等長時只配得上的那幾筆留空、多出來的 D 列帶分類寫進去，套用時又把它當成
  //   blocker＝預覽說記 1 筆、套用記 0 筆——預覽與套用分家）。
  const keyOf = (/** @type {import('../bank-statement.js').DebitCardRow} */ r) => `${r.postDate}|${r.amount < 0 ? 'in' : 'out'}|${Math.abs(r.amount)}`;
  /** @type {Map<string, number>} */ const cardCount = new Map();
  for (const r of cardRows) { const k = keyOf(r); cardCount.set(k, (cardCount.get(k) || 0) + 1); }
  /** @type {Map<string, number>} */ const txCount = new Map();
  for (const t of txs) { if (!DEBIT_CARD_SUMMARIES.includes(t.summary)) continue; const k = `${t.date}|${t.direction}|${t.amount}`; txCount.set(k, (txCount.get(k) || 0) + 1); }
  /** @type {Map<string, {cards:number[], txs:number[], ok:boolean}>} */ const groups = new Map();
  for (const p of link.pairs) {
    const k = keyOf(cardRows[p.card]);
    const g = groups.get(k) || { cards: [], txs: [], ok: true };
    g.cards.push(p.card); g.txs.push(p.tx);
    if (!importableRow(cardRows[p.card])) g.ok = false;
    groups.set(k, g);
  }
  // 同鍵群的 D 列各自在庫裡的「家」（Codex #509 r5#1）：同鍵多筆的 A↔D 配對只到群組層級（linkDebitCardRows
  //   依列印順序硬湊、A 與 D 的順序未必一致）——群裡的 D 列一半是舊批次的重複、一半這次新匯（跨批）時，
  //   逐筆綁批就是在猜；猜錯＝刪舊批次把別筆的主筆掃掉。**跨批的同鍵群整群不記、也不留空**（計畫層就排除
  //   ＝預覽與套用同一句話；只留空不記＝那筆錢從消費視角消失）。判準與匯入端 owner 查找同一套（含台新祖父鍵）。
  // home 的三種狀態**分開編碼**（Codex #509 r6#1：新列與「庫內既有但沒有 importBatch 的舊列」共用 'NEW' 字串＝
  //   跨家歧義群被誤判同家而放行）：'new'＝庫裡沒有（這次會匯、家＝新批次）／'unowned'＝庫裡有但沒有批次
  //   （批次制之前匯的）＝生命週期沒有家可綁／'b:<id>'＝庫裡那筆的批次。
  /** @type {Map<number, string>} */ const homeOfTx = new Map();
  {
    const occ = new Map();
    for (const [i, t] of txs.entries()) {
      if (txCurrency(db, parsed, t) !== 'TWD') continue;                      // 與 importBankTxToDb 同一個 occ 判準（外幣列不編序）
      const ref = bankRefWithOcc(t, occ, bank);
      if (!DEBIT_CARD_SUMMARIES.includes(t.summary)) continue;
      const legacy = bank === '台新' ? bankRefLegacy(t) : '';
      const owner = (db.transactions || []).find((/** @type {any} */ x) => x.source === 'bank'
        && (canonRef(x.bankRef) === ref || (legacy && canonRef(x.bankRef) === legacy)));
      homeOfTx.set(i, !owner ? 'new' : (owner.importBatch ? `b:${owner.importBatch}` : 'unowned'));
    }
  }
  for (const [k, g] of groups) {
    if (categorized.has(k)) { skipped.cashflowCategorized += g.cards.length; continue; }   // 帳戶那邊早就記過且帶分類＝整群不記、不留空
    if ((cardCount.get(k) || 0) !== (txCount.get(k) || 0)) { skipped.unmatched += g.cards.length; continue; }   // 兩區筆數不等＝整群不搬
    if (!g.ok) { skipped.unreadable += g.cards.length; continue; }   // 群裡任一筆抄不完整＝整群不記（計數也整群，畫面才不低報；Codex #503 r2#3）
    const homes = new Set(g.txs.map((/** @type {number} */ t) => homeOfTx.get(t) || 'new'));
    if (homes.has('unowned')) { skipped.unmatched += g.cards.length; continue; }   // 沒有批次的舊 D 列（批次制之前匯的）＝生命週期沒有家＝整群不記、不留空（r6#1；單筆也一樣——匯入端綁不了、先講就不分家）
    if (g.cards.length > 1 && homes.size > 1) { skipped.unmatched += g.cards.length; continue; }   // 同鍵群跨家＝整群不記、不留空（r5#1）
    for (const c of g.cards) importable.push(c);
    for (const t of g.txs) blankTx.add(t);
  }
  importable.sort((a, b) => a - b);
  return { blankTx, importable, skipped };
}

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
    && !a.cdKey   // 定存戶不進「轉入到：」顯示（分開列管：同末碼的定存名冒出來會誤導）
    && !(a.bank && bank && !sameBank(a.bank, bank))
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

/** 這筆銀行交易的**帳單原文**（摘要／備註）＋機構。兩條來源、優先序固定：
 * ①**存下來的原文欄**（`bankSummary`/`bankNote`＝解析器抄下來的原文，一字未改）；
 * ②沒有那兩欄（兩欄留底之前匯入的列）⇒ 從去重鍵 `bankRef` 反解。②是**反解、不是原文**，兩種寫法會還原錯：
 *   ・**摘要**自己含 `|` ⇒ 切點錯位：摘要只取到第一個 `|` 之前，剩下的整段被歸給備註。
 *   ・**備註**以 `#數字` 結尾 ⇒ 被當成批內出現序剝掉。（備註**中間**含 `|` 反而沒事：摘要之後的段落會整段接回來。）
 *   這兩種就是要另存兩欄的理由（考題＝test/bank-raw-text.test.js 題名含「摘要自己含」與「#數字」那幾題）。
 * ⚠️ **舊資料不回填**（使用者定）：原文只有帳單知道，回填等於拿反解結果冒充原文，比誠實反解更糟。
 * 機構**一律讀 bankRef**（`bank2|機構|…`＝第 2 段；舊格式 `bank|…` 只出自台新匯入）＝兩條路同一套判準。
 * @param {any} t @returns {{summary:string, note:string, bank:string, ok:boolean}} ok=false＝兩條路都拿不到 */
function bankRawText(t) {
  const parts = String(t.bankRef || '').split('|');
  const isB2 = parts[0] === 'bank2';
  const bank = isB2 ? canonicalBank(String(parts[1] || '')) : '台新';   // 機構段過正規短名（Stage 4）：舊列抄成「台新銀行」的，顯示層（812- 前綴、轉入到）才跟新列一致
  // 「有原文」＝**兩欄都在、都是字串**。為什麼這樣定：
  //   ・空字串算「在」：備註欄空白是常態，用 truthy 判會把「摘要有、備註空」整筆丟回②（考題：題名含「備註空白」）。
  //   ・`null` 不算「在」：`FIELD_SCHEMA` 的 'str' 全站接受 null＝清空語意，外部備份／手改可能帶 null 進來；
  //     這裡當成沒有原文而退回②反解——**退化、不編造**（②本來就是沒原文欄的列走的路）。不為兩個留底欄改
  //     動全站 'str' 語意（考題：題名含「原文欄是 null」）。
  //   ・**只剩一欄**也不算：半份不是原文（匯入端永遠兩欄一起寫，缺一欄＝外部改壞），退回②比拿半份充數誠實
  //     （考題：題名含「只剩一欄」）。
  if (typeof t.bankSummary === 'string' && typeof t.bankNote === 'string') {
    return { summary: t.bankSummary, note: t.bankNote, bank, ok: true };
  }
  if ((parts[0] === 'bank' && parts.length >= 8) || (isB2 && parts.length >= 9)) {
    const note = parts.slice(isB2 ? 8 : 7).join('|').replace(/#\d+$/, '');   // note 可能含 '|'：摘要後全取回；末尾 #N＝出現序，非原文
    return { summary: parts[isB2 ? 7 : 6], note, bank, ok: true };
  }
  return { summary: '', note: '', bank, ok: false };
}

/** 銀行交易的「預設自動顯示名」。有 db＝套收支說明過濾器（2026-07-27 起的新格式：好讀版）；
 * 無 db（測試/退化）＝舊組法「摘要・原始備註」。原文來源＝`bankRawText`（存下來的原文欄優先、
 * 舊資料退回 bankRef 反解）；兩條路都拿不到＝退回既存 autoNote 欄。清空自訂說明時回復到它。
 * @param {any} t @param {any} [db] */
function bankAutoNote(t, db) {
  const raw = bankRawText(t);
  if (!raw.ok) return t.autoNote ? String(t.autoNote) : '';
  if (db) return bankDisplayNote(raw.summary, raw.note, { direction: bankDirFromRef(t.bankRef), accountNameOf: (a) => ownAccountNameByAcct(db, a, raw.bank), bank: raw.bank });
  return [raw.summary, raw.note].filter(Boolean).join('・');
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

/** 規則卡（配方）管理：列出——只給**身分與統計投影**（配方內容＝版面字面不外送：管理面板用不到、外送面愈小愈好）。
 * 每列：銀行、誕生／更新／最後使用時間、畢業進度（graduateStreak／graduated＝連 5 份全過強閘）、疑似過期（suspect）、
 * 重生次數（rebirths）、有沒有上一版（hasPrevious）。 */
export async function listParseRecipes() {
  const rows = (await getDb()).parseRecipes;
  return (Array.isArray(rows) ? rows : []).map((/** @type {any} */ r) => ({
    id: String(r?.id ?? ''), bank: String(r?.bank || ''),
    createdAt: String(r?.createdAt || ''), updatedAt: String(r?.updatedAt || ''), lastUsedAt: String(r?.lastUsedAt || ''),
    graduated: r?.graduated === true, graduateStreak: Number(r?.graduateStreak) || 0,
    suspect: r?.suspect === true, rebirths: Number(r?.rebirths) || 0, hasPrevious: !!r?.previous,
  }));
}

/** 刪除一張規則卡（使用者的控制權：卡讀錯／不想留就刪；刪掉＝下次同版面重新走 AI、之後可能再學一張新的）。
 * 不影響任何已匯入的交易——規則卡只在「上傳當下」被用來讀版面。 @param {string} id */
export async function deleteParseRecipe(id) {
  const db = await getDb();
  // 型別也嚴格（Codex #513 r2#1）：String() 強轉會讓數字 7 刪掉字串 "7" 的卡——與「嚴格比較」的承諾相反
  if (typeof id !== 'string' || !id) throw apiError(400, '缺少規則卡代號');
  const k = id;
  const rows = Array.isArray(db.parseRecipes) ? db.parseRecipes : [];
  const idx = rows.findIndex((/** @type {any} */ r) => r?.id === k);   // 嚴格比較（同 recordRecipeApplied：隱式轉換會讓數字 7 命中字串 "7"）
  if (idx < 0) throw apiError(404, '找不到這張規則卡（可能已被刪除）');
  rows.splice(idx, 1);
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

/** 帳單內「同末碼、不同帳號」偵測（Grok #494 掃 G1）：寬鬆徑（憑末碼認親）的前提是末碼唯一，
 * 這份帳單自己就印了兩個同末碼帳號時前提不成立——把旗標蓋到每個 pa 上，matchAccount 據以停手。
 * ⚠️ 帳號來源＝accounts 與 **accountCurrency 的聯集**（Codex #494 r4#1：餘額空白的帳戶只活在
 *   accountCurrency——那才是帳單上的完整帳戶清單；只掃 accounts 會漏掉「另一顆同末碼但沒印
 *   餘額」的帳戶，寬鬆徑照樣不可逆認錯親）。
 * @param {{accounts?: any[], accountCurrency?: Record<string, string>}} parsed */
function markDupSuffixInStatement(parsed) {
  /** @type {Map<string, Set<string>>} */ const bySuf = new Map();
  const add = (/** @type {string} */ suffix, /** @type {string} */ masked) => {
    if (!suffix) return;
    const g = bySuf.get(suffix) || new Set();
    g.add(String(masked || '')); bySuf.set(suffix, g);
  };
  for (const pa of parsed.accounts || []) add(pa?.suffix, pa?.masked);
  for (const masked of Object.keys(parsed.accountCurrency || {})) add(accountSuffix(masked), masked);
  for (const pa of parsed.accounts || []) {
    if (pa?.suffix && (bySuf.get(pa.suffix)?.size || 0) > 1) pa.dupSuffixInStatement = true;
  }
}

/** 銀行交易去重鍵底（**完整遮罩帳號**：末碼相同、前綴不同的兩帳戶不可撞鍵；running 餘額讓同日同額唯一；
 * 含 note＝餘額讀不到時同日同額不同備註仍分得開）。
 * **機構維度（P1a）＝雙格式祖父條款**：台新照舊 `bank|帳號|…`——既有資料的去重鍵**一個位元組都不能變**
 * （變了＝重匯同帳單判不出重複＝現金流翻倍）；非台新用新標籤 `bank2|機構|帳號|…`——不同銀行的同字樣
 * 帳號＋同日同額不可撞成同一筆。以 parts[0] 標籤區分格式，消費者（bankDirFromRef／bankAutoNote／
 * reconcileBankTxAccountNames）雙軌解析。機構名剝 `|`（分段符不可入段）。
 * AI 解析路線（P1b）解台新帳單時 parsed.bank 仍是 '台新'：帳號段**帶星號**＝同一副 `bank|` 鍵（同一份帳單不論走模板或 AI、
 * 去重彼此相認）；帳單**沒遮**的完整號＝`bank2|台新|完整號|…`（來源可判；與模板的遮罩鍵 exact 不互認，靠疑似重複提醒）。
 * @param {import('../bank-statement.js').BankTx} tx @param {string} bank */
function bankRefBase(tx, bank) {
  const acct = tx.acctMasked || `x****${tx.acctSuffix}`;
  const tail = `${tx.date}|${tx.direction}|${tx.amount}|${tx.balance ?? ''}|${tx.summary}|${tx.note}`;
  // 台新的祖父格式 `bank|…` 只給**帶星號**的帳號段（內建範本一律帶星號、含佔位）：`bank|純數字|…` 是純末碼祖父鍵的命名空間，
  //   台新沒遮的完整號（AI 路線）寫成 `bank2|台新|完整號|…`＝來源可判（Codex #504 r8#2：寫成 bank| 會被當祖父末碼讀、
  //   同一份帳單有無分隔符重抄既不是重複也不是疑似重複）；canonRef 對 bank2|台新 不帶星號的段刻意不改寫，兩邊一致。
  if (bank === '台新' && hasStar(acct)) return `bank|${acct}|${tail}`;
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
  const stmtAcct = tx.acctMasked || `x****${tx.acctSuffix}`;
  const { suffix } = maskedParts(stmtAcct);
  const cands = (db.accounts || []).filter(a => {
    if ((a.type || 'cash') !== 'cash') return false;   // 只認現金帳戶（同 matchAccount）：外幣投資/負債同末碼不誤判幣別
    // ⚠️ 刻意**不**繞開 cdKey 戶（r1#3 撤回首版的繞開）：幣別判準要的是「這個實體帳戶是什麼幣」，
    // 定存戶的幣別＝同一實體帳戶的正確資訊；繞開反而在「db 只剩定存戶」時把外幣列誤判成台幣入帳。
    if (a.bank && !sameBank(a.bank, bank)) return false;   // 機構維度：他行戳帳戶的幣別不可判本行的列（r1#2）
    return !!suffix;
  });
  const acc = resolveCandidates(cands, stmtAcct).hit;   // 與餘額同一個裁決器（看所有符合機構的戶、不先用末碼篩，r8#1）：證明不了／多顆＝當沒有（退回 TWD）
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
  // 完整號（AI 路線）的末碼＝程式取的末四碼，與遮罩帳戶同一個精度（只比末碼；r2#3：不可另加末三碼——那會把轉到
  //   別人尾碼 301 戶的真支出排出收支）
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
 * （交易會整筆掛到別家銀行的帳戶底下）。先走與餘額同一個裁決器（唯一且證明的命中）、沒有才退回只比末碼——退路只開給
 * 「登記的數字就是末碼本身」（使用者只填了末幾碼）且恰一顆候選；含銀行代碼前置、較短完整號、登記遮罩形都證明不了＝不撿。
 * 都無→帳單概要區帳戶的 autoName、再無→「<機構> 末XXXX」。
 * @param {any} db @param {import('../bank-statement.js').BankTx} tx @param {ParsedBank} parsed */
function accountNameForTx(db, tx, parsed) {   // 測試出口在檔尾（accountNameForTxForTest）——掛名繞開定存戶的行為要能直測
  const bank = stmtBank(parsed);
  const stmtAcct = tx.acctMasked || `x****${tx.acctSuffix}`;
  const { suffix } = maskedParts(stmtAcct);
  const suf = suffix || tx.acctSuffix;
  const digits = (/** @type {any} */ a) => String(a.accountNo || '').replace(/\D/g, '');
  const bySuffix = (db.accounts || []).filter(a => {
    if ((a.type || 'cash') !== 'cash') return false;
    if (a.cdKey) return false;                     // 定存戶繞開（分開列管：交易掛名不可掛到定存戶）
    if (a.bank && !sameBank(a.bank, bank)) return false;   // 機構維度：他行戳帳戶不可收編（r1#1）
    return !!suf;
  });
  // 與餘額／幣別同一個裁決器（r3#1）：唯一且已證明的命中才掛；多顆同末碼（含全星號遮罩＝沒有前綴可分辨，Grok #494 掃 G3）、
  //   相容但證明不了＝不掛既有戶、用帳單概要的 autoName（「台新 1234」）——與餘額 ambiguous 同一條紀律；交易在匯入當下
  //   掛錯名，之後的 reconcileBankTxAccountNames（歧義不改名）救不回。
  const r = resolveCandidates(bySuffix, stmtAcct);   // 看所有符合機構的現金戶、不先用末碼篩（r8#1）
  // 退路只開給「登記的數字**就是末碼本身**」的戶（使用者只填了末幾碼、或 Stage 1 金融卡建的標記戶）且**恰一顆**同末碼候選：
  //   較短但比末碼長的號（`11223301` 對 `…11223301`）分不出是「只填末幾碼」還是另一顆合法的短帳號（r5#3）、登記了另一個號只是
  //   末碼相同的戶（r1#1／r2#1）、前面多了銀行代碼的——都證明不了＝一律 autoName。
  const partialOk = (/** @type {any} */ a) => digits(a) === suf;
  const sameSuffix = bySuffix.filter(a => digits(a).endsWith(suf));
  const acc = r.hit || ((!r.ambiguous && sameSuffix.length === 1 && partialOk(sameSuffix[0])) ? sameSuffix[0] : null);
  if (acc) return acc.name;
  // r1#2：概要退路也繞開定存列——ref 缺席時交易照匯、掛名若取到定存概要（定存列印在活存前的版面）
  // ＝交易持久化掛在定存名下。kind 缺席（配方產線／2026-08-18 之前的 AI 答案）＝視同活存（舊行為）。
  const notCd = (/** @type {any} */ x) => x.kind !== 'time';
  const pa = (parsed.accounts || []).find(x => x.masked === tx.acctMasked && notCd(x)) || (parsed.accounts || []).find(x => x.suffix === tx.acctSuffix && notCd(x));
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
    const acc = matchAccount(accounts, { suffix, masked, currency: 'TWD', suffixOnly: /^[*＊]+\d+$/.test(masked) }, isB2 ? parts[1] : '台新').hit;   // 銀行匯入只進 TWD（外幣明細不匯入），故一律以 TWD 比對
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
    const fresh = bankAutoNote(t, db);           // 好讀版（原文欄優先、沒有才 bankRef 反解，再過過濾器）
    if (!fresh) {                                 // 空＝兩條路都拿不到原文、或原文本身就是空白：兩種都不該拿去覆寫既有 note（只做一件事：空 note 補 autoNote 欄）
      if (!cur && t.autoNote) { t.note = String(t.autoNote); changed++; }
      continue;
    }
    // 「仍是自動名」判準（改 autoNote 欄**之前**先判，別把判準蓋掉）：空白／＝存好的 autoNote／＝舊組法原文
    // 舊組法只存在於舊格式（bank|…）的列——bank2 列（P1a 起）沒有「過濾器之前」的年代，不算這一項
    // ⚠️ 這一段**刻意讀 bankRef 反解、不讀原文欄**：這裡要重現的是「舊組法那段程式產出過的字串」，
    //    而產出它的就是這個反解——改用原文欄會在**摘要含 `|`**（或備註以 `#數字` 結尾）的列算出另一個字串，
    //    反而認不出自動名（誤判成使用者自訂、不再升級）。
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

/** totals＝AI 路線限定（裁示⑧b：AI 從帳單抄回來的合計欄、模板路線不產）——optional。
 * cardRows＝簽帳金融卡明細限定（A 區刷卡消費明細；Stage 5b 記到卡片帳本）、cardRowsError＝A 區讀不出來時的原因——optional。
 * @typedef {ParsedBank & {transactions:import('../bank-statement.js').BankTx[], totals?: {txCount:number|null, totalOut:number|null, totalIn:number|null}, cardRows?: import('../bank-statement.js').DebitCardRow[], cardRowsError?: string}} ParsedBankFull */

/** 去重鍵帳號段的**末碼解讀**（疑似重複索引與金融卡計畫的既有列側）：遮罩＝星號後的數字，一種解讀。
 * **純數字段靠去重鍵格式判來源**（Codex #504 r7#3：兩種解讀同時收＝五碼祖父鍵 `bank|18791|…` 會被截成 8791、冒充另一個四碼戶）：
 * `bank|…`（台新祖父格式）＝**純末碼祖父鍵**（機構維度之前只記末碼；`accountSuffix` 的 `\d+` 允許五碼以上）＝整段就是末碼、
 * 前綴不知道（形 `*末碼`）；`bank2|機構|…`＝不可能是祖父鍵＝**AI 路線的完整號**（至少五碼；AI 照抄的分隔符先剝）＝末四碼。
 * 台新沒遮的完整號由 bankRefBase 寫成 `bank2|台新|完整號|…`（r8#2）＝這裡讀得出來源；`bank|` 純數字段永遠是祖父末碼。
 * @param {string} masked @param {boolean} isB2 去重鍵是不是 `bank2|` 格式 @returns {Array<{suffix:string, shape:string}>} */
function refSuffixReadings(masked, isB2) {
  const m = String(masked || '');
  const star = accountSuffixStar(m.replace(/[\s-]/g, ''));   // 遮罩與末碼之間有分隔符（`900-100-****-3301`）也要讀得到（r11#1）
  if (star) return [{ suffix: star, shape: m }];
  if (!isB2) return /^\d{3,}$/.test(m) ? [{ suffix: m, shape: `*${m}` }] : [];
  const clean = cleanAcct(m);
  return (!hasStar(clean) && /^\d{5,}$/.test(clean)) ? [{ suffix: clean.slice(-4), shape: clean }] : [];
}
/** 兩個帳號印法「可能是同一顆戶」（疑似重複的前綴否決用）：一邊看不到前綴＝不否決（跨版式印法本來就不同）；
 * 兩邊都是遮罩＝一邊只印末碼＝不否決、否則比對形全等；兩邊都是完整號＝整串全等；一遮一全＝只在
 * **既有列是完整號、新列是遮罩**時比遮罩蓋不蓋得住（`maskCoversFull`，與身分那把同一支、同一個方向）；既有列是遮罩、新列是完整號＝證明不了＝不算。
 * ⚠️ 疑似重複在畫面上**預設跳過**那幾筆（Codex #504 r2#4）——這把尺不可比餘額身分那把寬；末碼長度不同的兩種印法
 *   （`****162` 對完整號的 3162）鍵就對不上＝契約已知取捨 (c′)。
 * @param {string} a @param {string} b */
function acctShapesCompatible(a, b) {
  const sa = hasStar(a), sb = hasStar(b);
  // 一遮一全**先判方向**（r6#2：「一邊沒前綴＝不否決」排在前面會讓 `****3301` 對完整號走不到這裡）＝與身分那把同一個方向性：
  //   **既有列是完整號**（身分已知）、新列的遮罩蓋得住它＝算；**既有列是遮罩**、新列是完整號＝證明不了（`900100****3301` 可能是
  //   另一顆 `…9999…`）＝不算——算了會被預設跳過、吃掉另一顆戶的真交易（Codex #504 r5#1）。
  if (sa && !sb) return false;
  if (!sa && sb) return maskCoversFull(b, a);
  if (!sa && !sb) return digitsOf(a) === digitsOf(b);
  if (suffixOnlyShape(a) || suffixOnlyShape(b)) return true;   // 兩遮、一邊只印末碼＝不否決（跨版式印法本來就不同；既有語意）
  // 兩遮都露了前綴＝比對形**全等**才算（`900100****3301` 對 `900-100****3301`／`900100XXXX3301` 算、對 `9001****3301` 不算＝
  //   既有「可見前綴全等」判準的嚴版；`****11**3301` 對 `****22**3301` 語言雖有交集、但同一家銀行不會把同一顆戶印成不同的中段，
  //   算了就是預設跳過另一顆戶的真交易，r7#1）。
  return cleanAcct(a) === cleanAcct(b);
}

/** 機構名的**比對用鍵**（疑似重複索引用，**不碰去重鍵**——那個是 P1a 逐字凍結的）。
 * ⚠️ 同一家銀行在不同帳單／不同解析路線上的寫法會不一樣（`台新` vs `台新國際商業銀行`——
 * AI 路線是照帳單抬頭抄的）。不正規化就會**漏報**：跨版式的重複交易一聲不吭地落帳（r2#1）。
 * 這把尺刻意比身分那把（canonicalBank）**寬**：提醒猜錯只是多問一句、身分猜錯是蓋餘額——見 lib/bank-alias.js looseBankKey。 */
function instKey(bank) {
  return looseBankKey(bank);
}

/** 「疑似重複」索引（2026-08-12，William 實測踩到）：既有銀行交易的
 * `機構｜帳號末碼｜日期｜方向｜金額` → **這一格出現過的帳號印法集合**（整個形狀，給 acctShapesCompatible 比）。
 *
 * ⚠️ 為什麼需要它——**去重鍵擋不住跨版式重複**：`bankRef` 含「摘要原文｜備註原文」，而同一家銀行的
 * 兩種版面（綜合對帳單 vs 另一種明細版）對**同一筆交易**的印法幾乎一定不同（「刷卡消費」vs
 * 「金融卡消費」、備註有沒有店名…），指紋因此對不上 ⇒ 同期間各匯一次＝現金流多算一份。
 * 去重鍵守的是「同一份帳單重複上傳」，不是「跨版式辨識同一筆交易」——這道索引補的就是那個縫。
 *
 * ⚠️ 三個設計取捨：
 * ①**機構要進 key**（r2#1）：只比末碼會把一銀與台新的同日同額說成「同一個帳戶」；機構名先過
 *   `instKey` 正規化（`台新` 與 `台新國際商業銀行` 是同一家）。
 * ②**印法另存、不進 key**：跨版式的遮罩印法本來就可能不同（`900200****3302` vs `****3302`），否決交給
 *   `acctShapesCompatible`（一遮一全有方向、兩遮要比對形全等、一邊只印末碼就放行）。
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
    const dir = txDirection(db, t);
    if (!dir || !t.date) continue;
    for (const { suffix, shape } of refSuffixReadings(masked, isB2)) {
      const key = `${instKey(inst)}|${suffix}|${t.date}|${dir}|${Number(t.amount) || 0}`;
      if (!wanted.has(key)) continue;
      const set = idx.get(key) || new Set();
      set.add(shape);                                        // 存整個印法（不只前綴）——否決要比形狀（acctShapesCompatible）
      idx.set(key, set);
    }
  }
  return idx;
}

/** 一筆待匯入交易在疑似重複索引裡的 key（讀寫兩端共用，避免各拼一份而漂掉）。 */
function similarKey(bank, suffix, tx) {
  return `${instKey(bank)}|${suffix}|${tx.date}|${tx.direction}|${Number(tx.amount) || 0}`;
}

/** 這一筆是不是「疑似重複」（與 db 既有 `source:'bank'` 交易同機構＋末碼＋日期＋方向＋金額；
 * 帳號印法由 `acctShapesCompatible` 否決——跨版式的遮罩印法本來就可能不同）。
 * ⚠️ preview 與 apply（勾選跳過）**共用這一支**（#459 r2）：原本各手抄一份，apply 那份的
 * 前綴否決被拔掉時 84 題全綠——後果是「預覽判定不同帳戶、套用卻跳過**真交易**」＝使用者掉帳。
 * 判準有兩個複本，遲早分家一次，而分家那次沒有徵兆（同 settingValueOk 那課）。
 * @param {Map<string, Set<string>>} simIdx @param {string} bank @param {any} tx */
function isSimilarTx(simIdx, bank, tx) {
  const suf = tx.acctSuffix || accountSuffix(tx.acctMasked || '');
  const seen = suf ? simIdx.get(similarKey(bank, suf, tx)) : undefined;
  if (!seen) return false;
  const mine = tx.acctMasked || '';
  for (const other of seen) if (acctShapesCompatible(other, mine)) return true;
  return false;
}

/**
 * 交易明細分箱預覽（純函式、不寫檔）：分箱＋去重標記＋帳戶名。回可讓前端呈現/確認的列。
 * @param {any} db @param {ParsedBankFull} parsed
 */
export function previewBankTxForDb(db, parsed, opts = {}) {
  const own = ownSuffixSet(db, parsed);
  const bank = stmtBank(parsed);
  // 去重集合用**比對形**（Stage 4 祖父條款）：存好的鍵一個位元組不改，但比對時把機構段壓成正規短名
  // ——AI 路線抄成「台新銀行」存下的 `bank2|台新銀行|…` 與內建範本的 `bank|…` 要認得出是同一筆。
  const existing = new Set((db.transactions || []).map(t => canonRef(t.bankRef)).filter(Boolean));
  // 先算出本次真正會查的 key，再只索引那些（記憶體：不替全部既有交易建索引）
  const simWanted = new Set((parsed.transactions || []).map((/** @type {any} */ t) => {
    const suf = t.acctSuffix || accountSuffix(t.acctMasked || '');
    return suf ? similarKey(bank, suf, t) : '';
  }).filter(Boolean));
  const simIdx = similarTxIndex(db, simWanted);
  const seen = new Set();   // 同批內去重也要標（否則預覽筆數多於實際匯入，使用者看到 2 筆卻只進 1 筆）
  const occ = new Map();    // 批內出現序（同 base 第 n 筆）——同日同額同備註且餘額讀不到仍分得開
  const cardPlan = opts.cardPlan || debitCardPlan(db, parsed);   // 簽帳金融卡明細：哪幾列 D 區刷卡要留空（對得上、且那筆會記進卡片帳本）；呼叫端可傳同一份計畫
  const rows = (parsed.transactions || []).map((tx, i) => {
    const currency = txCurrency(db, parsed, tx);
    const foreign = currency !== 'TWD';   // 外幣明細：尚無歷史匯率口徑，一律不計入台幣現金流（只呈現、不匯入）
    const learned = classifyWithLearning(db, tx, own);   // 先套學過的（摘要＋對方帳號、方向相容）、否則關鍵字
    const isCardLine = cardPlan.blankTx.has(i);
    const { bankKey, name } = learned;
    const applied = isCardLine ? false : learned.applied;
    const cls = isCardLine ? { type: tx.direction === 'out' ? 'expense' : 'income', category: '', subcategory: '' } : resolveCls(db, learned.cls);
    const bankRef = bankRefWithOcc(tx, occ, bank);
    const duplicate = existing.has(bankRef) || (bank === '台新' && existing.has(bankRefLegacy(tx))) || seen.has(bankRef);   // bankRef 由正規短名拼出＝本身就是比對形，不必再過 canonRef
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

// ---------- 簽帳金融卡明細 → 卡片帳本（Stage 5b，William 2026-08-23 選 A 案：建「簽帳金融卡」卡片實體）----------

/** 這份帳單的 A 區刷卡消費明細，依卡號末四碼分組、找到（或準備建立）對應的簽帳卡，並走**信用卡帳單同一條**
 * 預覽管線（finalize → 套學過的 → 生效樹校正＋顯示標記 → 去重標記）。純函式、不寫 db：preview 與 apply 共用，
 * 「預覽看到幾筆、套用就記幾筆」才不會分家。
 * 卡片配對＝`type:'debit'`＋末四碼相同＋發卡機構相容（戳缺席或 sameBank）；找不到＝新建一張（名字「<機構>簽帳金融卡 <末四碼>」），
 * 預覽階段用暫時 id 算去重（卡片還不存在＝不可能有重複），apply 建卡時拿真 id 重算。
 * @param {any} db @param {ParsedBankFull} parsed
 * @returns {{ cards: {cardId:string, name:string, lastFour:string, exists:boolean, rows:any[], meta:{aIdx:number, isFee:boolean}[]}[], count:number, duplicate:number, skipped:{unmatched:number, unreadable:number, cashflowCategorized:number}, error:string }} */
function planDebitCardLedger(db, parsed, /** @type {ReturnType<typeof debitCardPlan>|null} */ cardPlan = null) {
  const all = Array.isArray(parsed.cardRows) ? parsed.cardRows : [];
  const plan = cardPlan || debitCardPlan(db, parsed);
  const cardRows = plan.importable.map((i) => ({ row: all[i], aIdx: i }));   // 只有對得上、抄得完整、帳戶那邊不是早就帶分類記過的筆；aIdx＝A 區原始序（匯入端靠它找配對的 D 列）
  const error = String(parsed.cardRowsError || '');
  if (!cardRows.length) return { cards: [], count: 0, duplicate: 0, skipped: plan.skipped, error };
  const bank = stmtBank(parsed);
  /** @type {Map<string, {row: import('../bank-statement.js').DebitCardRow, aIdx: number}[]>} */ const byCard = new Map();
  for (const e of cardRows) { const g = byCard.get(e.row.lastFour) || []; g.push(e); byCard.set(e.row.lastFour, g); }
  const cards = [];
  let count = 0, duplicate = 0;
  for (const [lastFour, entries] of byCard) {
    const hit = (db.cards || []).find((/** @type {any} */ c) => c.type === 'debit' && String(c.lastFour || '') === lastFour
      && (!c.issuer || sameBank(String(c.issuer), bank)));
    const cardId = hit ? String(hit.id) : `pending-debit-${lastFour}`;   // 暫時 id：只用來算「還沒有這張卡＝零重複」的去重標記，不落庫
    const name = hit ? String(hit.name) : `${bank}簽帳金融卡 ${lastFour}`;
    // 卡片帳本的列形狀＝信用卡帳單解析器的產物：消費日、店名原文、台幣金額（退款為負）。
    // 「國外交易服務費」欄**另立一筆**（William 2026-08-23 拍板）：主筆金額照帳單原樣，服務費記成
    //   「〈店名〉 國外交易服務費」緊跟在主筆後——消費分析總額＝兩筆相加、查帳時與帳單逐欄對得起來；
    //   欄位空（null）或 0＝不多記。退款列的服務費退回（負值）同一條規則。
    /** @type {{date:string, desc:string, amount:number}[]} */ const ledgerRows = [];
    /** @type {{aIdx:number, isFee:boolean}[]} */ const meta = [];
    for (const { row: r, aIdx } of entries) {
      ledgerRows.push({ date: r.date, desc: r.desc, amount: r.amount });
      meta.push({ aIdx, isFee: false });
      if (r.fee) { ledgerRows.push({ date: r.date, desc: `${r.desc} 國外交易服務費`.trim(), amount: r.fee }); meta.push({ aIdx, isFee: true }); }
    }
    const finalized = finalizeCardRows(ledgerRows, bank).transactions;
    const preview = previewRowsForCard(db, cardId, finalized);
    // 服務費筆**繼承主筆的最終分類**（Codex #509 r2#2）：學過的規則（applyLearned）只認得店名原文、
    //   「〈店名〉 國外交易服務費」這把鑰匙它不認得——不繼承＝主筆歸娛樂、服務費落其他，消費分析拆兩格。
    //   繼承在 previewRowsForCard（學習＋生效樹校正）之後做＝拿到的就是主筆的最終分類；主筆是重複列也照抄
    //   （分類是算出來的、與重複與否無關）。preview 與 finalized 逐列同序（三段都是 map）。
    for (let k = 0; k < preview.length; k++) {
      if (meta[k]?.isFee && preview[k - 1]) { preview[k].category = preview[k - 1].category; preview[k].subcategory = preview[k - 1].subcategory; }
    }
    count += preview.length; duplicate += preview.filter((/** @type {any} */ x) => x.duplicate).length;
    cards.push({ cardId, name, lastFour, exists: Boolean(hit), rows: preview, meta });
  }
  return { cards, count, duplicate, skipped: plan.skipped, error };
}

/** 這一筆交易是不是「金融卡帳單連帶記的」那個單位的一部分：卡片帳本列帶 bankBatch；銀行列所屬批次有連帶的卡片列。
 * 單筆刪任一邊都讓另一邊說謊（CRUD DELETE 守門用；Codex #503 r2#1）。 @param {any[]} all @param {any} t */
export function bankLinkedStatementRow(all, t) {
  if (!t) return false;
  if (t.bankBatch) return true;
  if (t.source === 'bank' && t.importBatch) return (all || []).some((x) => x.bankBatch === t.importBatch);
  return false;
}

/** 簽帳金融卡明細寫進卡片帳本（純函式、就地改 db、不寫檔；與餘額、現金流同一次 saveDb）。
 * 沒有對應簽帳卡＝建一張（`type:'debit'`、發卡機構＝帳單機構短名、末四碼）；每張卡走 importRowsToDb
 * ＝與信用卡帳單匯入**同一條寫入路**（stmtRef 去重、店名學習、顯示名、批次代號）。帳單期別＝對帳單期間結束日的月份。
 * @param {any} db @param {ParsedBankFull} parsed
 * @returns {{ cards: {cardId:string, name:string, lastFour:string, created:boolean, imported:number, skipped:number}[], imported:number, skipped:number, notRecorded:{unmatched:number, unreadable:number, cashflowCategorized:number}, error:string }} */
function importDebitCardLedgerToDb(db, parsed, /** @type {ReturnType<typeof debitCardPlan>} */ cardPlan, /** @type {string[]} */ refByIndex) {
  const plan = planDebitCardLedger(db, parsed, cardPlan);
  const bank = stmtBank(parsed);
  const stmtMonth = String(parsed.referenceDate || '').slice(0, 7);
  // 卡片列的 bankBatch＝**它配對的那列 D 區在庫裡所屬的批次**（Codex #509 r2#1）：部分重匯（D 全重複、只有
  //   服務費是新筆）時，D 列屬於**舊批次**——綁這次的新批次＝新批次沒有任何銀行列、匯入紀錄看不到、
  //   單獨刪又被守門擋＝清不掉的孤兒。D 列剛匯的＝新批次、重複跳過的＝它既有那筆的批次，一律查庫取得。
  // 同鍵多筆（ambiguous）的「跨家群」與「無批次舊列」在**計畫層**就整群排除（debitCardPlan 的 homeOfTx 三態判準，
  //   Codex #509 r5#1／r6#1）——能走到這裡的歧義群，成員的 D 列必然同一個家（全新或同一具體批次），逐筆綁與
  //   群組綁同一個答案，這裡就不再抄一份群組邏輯；剩下的 fail-closed（配對查不到）只補「疑似重複跳過」那類套用期落差。
  const pairs = linkDebitCardRows(Array.isArray(parsed.cardRows) ? parsed.cardRows : [], parsed.transactions || []).pairs;
  /** @type {Map<number, string>} */ const batchOfA = new Map();
  for (const p of pairs) {
    const txIdx = p.tx;
    const ref = refByIndex[txIdx] || '';
    // owner 查找＝與去重**同一個身分集合**（Codex #509 r4#1）：台新的祖父去重鍵（bankRefLegacy）也認——
    //   去重端認得的列這裡認不得＝D 被跳過卻「找不到家」＝祖父時代的帳單走不了服務費升級路徑。
    const legacy = bank === '台新' && parsed.transactions?.[txIdx] ? bankRefLegacy(parsed.transactions[txIdx]) : '';
    const owner = ref ? (db.transactions || []).find((/** @type {any} */ t) => t.source === 'bank'
      && (canonRef(t.bankRef) === ref || (legacy && canonRef(t.bankRef) === legacy))) : null;
    if (owner && owner.importBatch) batchOfA.set(p.card, String(owner.importBatch));
  }
  const out = [];
  let imported = 0, skipped = 0, unresolved = 0;
  for (const c of plan.cards) {
    // fail-closed：配對的 D 列在庫裡找不到＝這筆的生命週期沒有家，整筆（含服務費）不記、計入「對不上」。
    //   **可達路徑**（Codex #509 r3#1）：庫裡有同機構＋末碼＋日期＋方向＋金額、但去重鍵不同且**分類為空**的
    //   D 列（例如另一種版面先匯過、刷卡列留空）——它不是 cashflowCategorized 擋門的對象（那道只擋帶分類的），
    //   預設勾「跳過疑似重複」時這列 D 被跳過＝庫裡沒有這份帳單自己的 D 列。記了＝卡片列沒有 bankBatch
    //   ＝生命週期守門全失效。
    const keep = (/** @type {number} */ k) => batchOfA.has(c.meta[k].aIdx);
    const kept = c.rows.filter((/** @type {any} */ _x, /** @type {number} */ k) => keep(k));
    const keptMeta = c.meta.filter((/** @type {any} */ _x, /** @type {number} */ k) => keep(k));
    unresolved += c.rows.length - kept.length;
    if (!kept.length) continue;
    let card = c.exists ? (db.cards || []).find((/** @type {any} */ x) => String(x.id) === c.cardId) : null;
    const created = !card;
    if (!card) {
      card = { id: uid(), type: 'debit', name: c.name, issuer: bank, lastFour: c.lastFour, network: '—' };
      (db.cards ||= []).push(card);
    }
    // 新建的卡要用真 id 重算列（stmtRef 的第一段＝卡片 id，是去重與「帳單原文」的身分）。分類繼承不必重做：
    //   applyLearned 對服務費筆有 isServiceFee 守門（不套學過的規則）、conformTxs 只過生效樹——plan 層繼承好的
    //   分類重算時原樣通過（考題在 exists 與 created 兩條路都釘）。
    const rows = created ? previewRowsForCard(db, String(card.id), kept) : kept;
    const r = importRowsToDb(db, card, rows, stmtMonth, null);
    // 生命週期跟著那份銀行帳單（Codex #503 r1#3）：卡片帳本這幾筆蓋上 bankBatch——信用卡那邊的匯入紀錄
    //   不列它、不准改卡／單獨刪（改卡會讓 stmtRef 換卡片 id＝重匯時再記一次；單獨刪＝D 區那幾列已留空、
    //   消費就少算）；從「銀行匯入紀錄」刪那份帳單時一起拿掉。批次＝逐筆對回它 D 列的批次（見上）：
    //   用 importRowsToDb 回傳的 writtenIds（與輸入列逐一同序、略過＝null）逐列指認——不按位置猜
    //   （Codex #509 r5#2：寫入層才略過的列會讓位置對位錯位）。
    const byId = new Map((db.transactions || []).map((/** @type {any} */ t) => [String(t.id), t]));
    for (let k = 0; k < rows.length; k++) {
      const id = r.writtenIds[k];
      if (!id) continue;
      const t = byId.get(String(id));
      if (t) t.bankBatch = batchOfA.get(keptMeta[k].aIdx);
    }
    imported += r.imported; skipped += r.skipped;
    out.push({ cardId: String(card.id), name: String(card.name), lastFour: c.lastFour, created, imported: r.imported, skipped: r.skipped });
  }
  const notRecorded = { ...plan.skipped, unmatched: plan.skipped.unmatched + unresolved };
  return { cards: out, imported, skipped, notRecorded, error: plan.error };
}

/**
 * 交易明細匯入（純函式、就地改 db、不寫檔）：把非重複的分箱交易寫進**現金流帳本**（ledger:'cashflow'、
 * source:'bank'）。繳卡費 category 空（不進分類統計）。
 * @param {any} db @param {ParsedBankFull} parsed
 */
export function importBankTxToDb(db, parsed, opts = {}) {
  const own = ownSuffixSet(db, parsed);
  const bank = stmtBank(parsed);
  // 去重集合用**比對形**（Stage 4 祖父條款）：存好的鍵一個位元組不改，但比對時把機構段壓成正規短名
  // ——AI 路線抄成「台新銀行」存下的 `bank2|台新銀行|…` 與內建範本的 `bank|…` 要認得出是同一筆。
  const existing = new Set((db.transactions || []).map(t => canonRef(t.bankRef)).filter(Boolean));
  const occ = new Map();
  const importedAt = new Date().toISOString();
  const batchId = uid();
  // 「這次跳過疑似重複」（William 2026-08-14：同期間匯過另一種版面時，48/57 筆是重複的——
  //   全擋掉他不能匯剩下的、全放行現金流被多算一份）。判準與預覽的「疑似重複」**同一套**
  //   （similarTxIndex＋similarKey：機構＋末碼＋日期＋方向＋金額；帳號印法由 acctShapesCompatible 否決）
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
  // 計畫在**寫任何 D 列之前**算好、與卡片帳本那半共用同一份（opts.cardPlan）。Codex #503 r1#1 的病＝寫完 D 列再重算，
  //   剛寫進去的帶分類刷卡列被當成「帳戶那邊早就記過」、A 區整群被擋＝預覽說記、套用不記；承重的修法是
  //   debitCardPlan 的「兩區筆數不等＝整群不搬」（帶分類寫進去的 D 列就不會是任何 A 筆的對手）。
  //   ⚠️ 誠實記錄：共用同一份計畫在此之後是**縱深**——「寫完 D 再重算」的突變在現有考題下行為等價、咬不到。
  const cardPlan = opts.cardPlan || debitCardPlan(db, parsed);
  /** @type {string[]} 每一筆帳單交易的去重鍵（比對形；外幣列＝''）——金融卡連帶記帳靠它找「這列 D 區在庫裡的那筆」 */
  const refByIndex = [];
  for (const [i, tx] of (parsed.transactions || []).entries()) {
    if (txCurrency(db, parsed, tx) !== 'TWD') { foreign++; refByIndex[i] = ''; continue; }   // 外幣明細不計入台幣現金流（尚無歷史匯率換算）
    const bankRef = bankRefWithOcc(tx, occ, bank);
    refByIndex[i] = bankRef;
    if (existing.has(bankRef) || (bank === '台新' && existing.has(bankRefLegacy(tx)))) { skipped++; continue; }   // bankRef 已是比對形（同預覽）
    if (skipSimilar && isSimilarTx(simIdx, bank, tx)) { similarSkipped++; continue; }
    existing.add(bankRef);
    const learned = classifyWithLearning(db, tx, own);   // 先套學過的、沒學過才關鍵字
    const { bankKey, name } = learned;
    const cls = cardPlan.blankTx.has(i) ? { type: tx.direction === 'out' ? 'expense' : 'income', category: '', subcategory: '' } : resolveCls(db, learned.cls);
    // 預設自動顯示名＝收支說明過濾器的好讀版（2026-07-27；bankKey/bankRef 仍用原始 summary+note、學習與去重不受影響）
    const autoNote = bankDisplayNote(tx.summary, tx.note, { direction: tx.direction, accountNameOf: (a) => ownAccountNameByAcct(db, a, bank), bank });
    const noteText = name || autoNote;                                          // 學過自訂顯示名優先
    (db.transactions ||= []).push({
      id: uid(), date: tx.date, type: cls.type, category: cls.category, subcategory: cls.subcategory,
      amount: tx.amount, account: accountNameForTx(db, tx, parsed), note: noteText,
      // 帳單原文分兩欄存（使用者定 2026-08-22）：摘要與備註各自留底、一字未改。
      // note 是**顯示用**的組合結果（過濾器好讀版或使用者自訂名），改了就回不去原文；而去重鍵 bankRef
      // 的尾兩段要靠切 `|` 反解——**摘要含 `|`**（切點錯位）或**備註以 `#數字` 結尾**（被當出現序剝掉）就還原錯。
      // **去重鍵與學習鑰匙仍用 tx.summary/tx.note 原文計算、格式不動**（動了＝重匯同帳單認不出重複＝現金流翻倍；
      // 考題：test/bank-raw-text.test.js 題名含「去重鍵格式」）；這兩欄純粹是留底，不參與任何判定。
      bankSummary: String(tx.summary || ''), bankNote: String(tx.note || ''),
      // dir＝本筆實際金流方向（in/out）＝不可竄改的事實，供「同類一起改」逐筆方向護欄用（Codex r13#2）；
      // amount 是無正負的金額，type 又可能被使用者改錯，唯有 dir 忠實記錄錢進錢出。服務層寫、非 CRUD 白名單。
      // autoNote＝預設自動顯示名：使用者把自訂說明清空時回復到它（使用者定 2026-07-21）。服務層寫、非 CRUD。
      ledger: 'cashflow', source: 'bank', dir: tx.direction, autoNote, bankRef, bankKey, importBatch: batchId, importedAt,
    });
    imported++;
  }
  return { imported, skipped, foreign, similarSkipped, batchId, refByIndex };
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
    g.cardCount = (g.cardCount || 0);   // 下面另外數
    const amt = Number(t.amount) || 0;
    if (t.type === 'income') g.income += amt;
    else if (t.type === 'expense') g.expense += amt;
    else if (t.type === 'transfer') g.transfer += amt;
    if (t.date && t.date < g.minDate) g.minDate = t.date;
    if (t.date && t.date > g.maxDate) g.maxDate = t.date;
  }
  for (const t of db.transactions || []) {   // 簽帳金融卡明細：這份帳單連帶記進卡片帳本的筆數（刪批時一起拿掉）
    if (t.source === 'stmt' && t.bankBatch && Object.hasOwn(groups, t.bankBatch)) groups[t.bankBatch].cardCount++;
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
  // 簽帳金融卡明細那份帳單：卡片帳本那幾筆（bankBatch＝本批）一起拿掉——它們的 D 列已留空，單留著會少算消費
  db.transactions = (db.transactions || []).filter(t => !(t.source === 'bank' && t.importBatch === id) && !(t.source === 'stmt' && t.bankBatch === id));
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
  // 合計欄交叉驗證（裁示⑧b）：**AI 抄回來的**筆數/支出合計/存入合計 vs **它自己**的逐筆——多一道
  // 控制總額、兼補「每帳戶第一筆的金額/方向驗不到」盲區（首筆進不進合計藏不住）。
  // ⚠️ 主詞（r7#1／r8#1）：`parsed.totals` 整個來自 AI 答案——管線證明得了「兩邊對得上」，
  //    證明不了「帳單印的就是這個數字」，所以這一段一律不寫「帳單印的／帳單沒印」。
  // 只驗「AI 有交回」的欄（null＝誠實缺席、跳過）；容差 BAL_EPS＝與餘額鏈同一把尺（同一個常數、不留漂移副本）。
  // ⚠️ 訊息不回聲數字（AI 誤讀的欄值不可外送——與 ai_reconcile_failed 同一條機密紀律）。
  // ⚠️ 混幣帳單＝整道跳過（預審 r0）：閘與匯入的射程只有台幣（外幣列不入帳），而合計欄
  //   合計涵蓋哪一段（整份？台幣區？）機械上判不出來——拿「全列不分幣別加總」去比，正確答案
  //   會被誤判 ai_totals_mismatch 連坐擋死（William 的真實帳單正是台幣＋外幣混合形）。
  //   提示詞規則 8 已叫 AI 在混幣情境填 null；這裡是引擎側的第二道保險。
  // ⚠️ **跳過要說得出口**（2026-08-19；William 指出混幣時這道整個關掉、畫面卻說它擋得住，而他自己的
  //   帳單正是混幣＝轉述，非逐字引用）：這道檢查跑了沒有、為什麼沒跑，隨裁決回到預覽（`totalsCheck`＝封閉狀態碼
  //   ＋真的比對過的欄名，見 statement-reconcile.js 的 TOTALS_CHECK；白話句住前端）。
  //   **只報事實、不報數字**——帳單欄值一個都不外送（同 ai_reconcile_failed 那條機密紀律）。
  const t = parsed.totals;
  /** @type {string[]} 這一份**真的比對過**的欄（AI 沒交回的欄不算——句子不可把「沒得對」講成「都對得上」） */
  const totalsFields = [];
  /** @type {string} */
  let totalsStatus = TOTALS_CHECK.PASS;
  if (!t) {
    totalsStatus = TOTALS_CHECK.NO_TOTALS;                 // 配方路線：parseWithRecipe 不產合計欄
  } else if (parsed.transactions.some((/** @type {any} */ x) => ((parsed.accountCurrency && getOwn(parsed.accountCurrency, x.acctMasked)) || 'TWD') !== 'TWD')) {   // own-property 查表（原型鍵防線，同 statementCurrencyLookup）
    totalsStatus = TOTALS_CHECK.MIXED_CURRENCY;            // 混幣＝整道跳過（理由見上）
  } else {
    const sum = (/** @type {'in'|'out'} */ dir) => parsed.transactions.reduce((a, x) => a + (x.direction === dir ? x.amount : 0), 0);
    if (t.txCount != null) {
      if (t.txCount !== parsed.transactions.length) {
        throw apiError(400, 'AI 逐筆的筆數與它抄回來的明細總筆數對不上——可能漏抄或多抄了交易', 'ai_totals_mismatch');
      }
      totalsFields.push('txCount');
    }
    if (t.totalOut != null) {
      if (Math.abs(t.totalOut - sum('out')) > BAL_EPS) {
        throw apiError(400, 'AI 逐筆加總與它抄回來的支出合計對不上——翻譯結果不可信', 'ai_totals_mismatch');
      }
      totalsFields.push('totalOut');
    }
    if (t.totalIn != null) {
      if (Math.abs(t.totalIn - sum('in')) > BAL_EPS) {
        throw apiError(400, 'AI 逐筆加總與它抄回來的存入合計對不上——翻譯結果不可信', 'ai_totals_mismatch');
      }
      totalsFields.push('totalIn');
    }
    if (!totalsFields.length) totalsStatus = TOTALS_CHECK.NOT_READ;   // 三欄全 null＝AI 沒交回那一欄（帳單印沒印，管線分不出）
  }
  return { ...gate, totalsCheck: { status: totalsStatus, fields: totalsFields } };
}

/** 這個解析錯誤可不可以改走 AI？只有「**解析階段**認不得/解不動」可以；密碼錯（pdf_password）要回前端
 * 跳密碼窗、**對帳閘紅絕不可**（模板認得但數字對不上＝★6「對帳失敗禁止匯入」的既有裁決，AI 不得撿去重試
 * ——所以 AI 資格判定只包解析段、不包閘，見 preview/apply 的 try 範圍）。 @param {any} e @param {{useAi?:boolean}} opts */
function aiEligible(e, opts) {
  // bank_mixed_currency（2026-08-26）：同號混台幣＋外幣＝**版面本身的歧義**（明細列上沒有幣別欄），
  //   換 AI 讀答案一樣是拒收（三條路共用同一道判定）——送它出去只是白燒發數，比照 pdf_password 排除。
  const code = /** @type {any} */ (e)?.code;
  return opts?.useAi === true && code !== 'pdf_password' && code !== 'bank_mixed_currency' && code !== 'ai_mixed_currency';
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
 * @param {{extract?: typeof extractBankLines, stage?: (s: string) => void}} [seams] stage＝呼叫端的 stage sink（吃階段**代碼**；正式呼叫端傳 makeStageSink 的產物＝唯一出口 stageFrame 不變、G8 的 onStage 掃描也管不到別名）
 * @returns {Promise<{hit: {parsed: ParsedBankFull, reconcile: any, recipeId: string, usedVersion: 'current'|'previous', currentMatched: boolean, usedRecipe: object}|null, gateFailedIds: string[]}>}
 */
export async function recipeBankRoute(b64, password, db, seams = {}) {
  /** @type {string[]} */ const gateFailedIds = [];
  let verifyStaged = false;   // VERIFY 只報一次（多張配方逐一試、每次過閘都報＝進度列跳針）
  const stageVerify = () => { if (!verifyStaged) { verifyStaged = true; seams.stage?.(STAGES.VERIFY); } };
  const rows = Array.isArray(db?.parseRecipes) ? db.parseRecipes : [];
  if (rows.length === 0) return { hit: null, gateFailedIds };
  const extract = seams.extract || extractBankLines;
  /** @type {any} */ let lines;
  try {
    lines = await parseWithPool((b, pw) => extract(b, pw), decode(b64), statementPasswordPool(db, password ? [String(password)] : []));
  } catch {
    return { hit: null, gateFailedIds };   // 抽不了字＝配方幫不上（密碼錯已在模板路線分流、走不到這裡）
  }
  // ⚠️⚠️ **整份跑兩趟、每趟只用一把尺**（`RECIPE_RULERS`；William 2026-08-29 裁示，Codex #523
  //   r6–r11 五輪換來的結構）。「**哪一張規則卡獲勝**」本身就是一種「是哪一個」：只要候選集合
  //   變大，這裡的「照列序取第一張成功的」就會選到 **main 選不到的卡**。實測：帳單印連字 `Oﬃce`，
  //   一張卡的暗號抄正規字、一張抄帳單原文，兩張都能完整解析且都過強閘 ⇒ 依列序選到前卡 ⇒
  //   真台幣戶被標成 `USD` ⇒ 那戶交易被當外幣**不匯入** ⇒ **現金流漏帳**，而閘仍是 `strong`。
  //   ⇒ **第一趟 `'old'` 逐字就是 main（main 選誰我們就選誰）；整趟跑完都沒有 hit 才跑 `'new'`。**
  //   「絕不比 main 差」因此是**建構上**成立的——第二趟只在 main 本來就會退 AI 時才發生。
  //   ⚠️ 「沒中」指**整趟**（含拒解與閘紅退下一版／下一張），不是只看第一張。
  //   ⚠️ 每一趟內部**從頭到尾同一把尺**（比對／驗證／解析全部傳同一個 `ruler`）——混用是那五輪的病根。
  for (const ruler of RECIPE_RULERS) {
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
        if (!recipeMatches(lines, recipe, { ruler })) continue;
        if (usedVersion === 'current') currentMatched = true;
        parsed = /** @type {any} */ (parseWithRecipe(lines, recipe, { ruler }));
      } catch (e) { if (/** @type {any} */ (e)?.code === 'bank_mixed_currency') throw e; continue; }   // 拒解＝這版不行，退下一版/下一張；⚠️ 混幣是終局訊號、不是「這版不行」（r6#1）
      try {
        stageVerify();   // 三路一致（A4）：配方的驗算真的在這裡發生（hit＝過了閘才算，報在結論之前）
        const reconcile = assertAiBankReconciled(parsed, db);
        // usedRecipe＝JSON 快照（預審 G1：apply 記帳前要核對列的現況還是不是「當時用的那版」——
        // 並發雙套用/其間被還原洗過，都不可以按版本標籤盲換）
        // ⚠️ 勝出的那一列**不可以留在疑似過期名單裡**（Codex #523 r11#2）：第一趟可能已經把它標進去
        //   （current 拒解），第二趟卻用它的 previous 成功了 ⇒ apply 會把剛救回來的好版標成疑似過期、
        //   畢業計數歸零。名單是跨趟共用的，所以回傳前要把 winner 濾掉。
        return { hit: { parsed, reconcile, recipeId: row.id, usedVersion, currentMatched, usedRecipe: JSON.parse(JSON.stringify(recipe)) },
          gateFailedIds: gateFailedIds.filter((id) => id !== row.id) };
      } catch { continue; }   // 閘紅＝退上一版（迴圈自然做到）
    }
    if (currentMatched && !gateFailedIds.includes(row.id)) gateFailedIds.push(row.id);   // **現行版**中版面但整列沒過＝疑似過期候選（只看 previous 失靈不算——它本來就是備胎）；兩趟可能重複標同一列
  }
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

/** 單模型完整一讀（P2-4 抽出）：驗收→接地→強閘，全過才 ok。err 原樣保留（呼叫端分類）。 */
async function aiTryModel(/** @type {AiEngine} */ engine, /** @type {string} */ model, /** @type {string} */ text, /** @type {any} */ db) {
  try {
    const parsed = normalizeAiBank(await engine.parseOnce(text, model));   // 引擎交原始答案、服務層自己驗收（縱深防禦）
    assertAiBankGrounded(parsed, text);   // 接地檢查（裁示⑧a）：答案的每個金額都要在原文找得到
    assertAiBankReconciled(parsed, db);   // 閘只當**有效性判準**（紅＝這讀無效）。⚠️ 刻意**不回傳** reconcile：
    //   採納點（雙讀一致／仲裁／attest）報 VERIFY 時要**當場重跑閘**產生回傳的 reconcile（Codex #512 r3#1 的誠實
    //   要求）——這裡若把裁決一起交回去，「採納點改用現成的、只推碼不驗」的回退一行就能寫出來且行為等價、
    //   考題抓不到；欄位不存在＝那種回退直接被 typecheck 擋下（結構保證，不靠考題）。
    return { ok: /** @type {const} */ (true), parsed, model };
  } catch (e) { return { ok: /** @type {const} */ (false), err: e, model }; }
}
const AI_SERVICE_CODES = ['ai_auth', 'ai_unavailable', 'ai_truncated', 'ai_budget_exceeded', 'ai_mixed_currency'];   // 換模型救不了、照實丟的錯（預審 C1#1：預算錯不入名單＝仲裁那發被上限擋下時被吞成「三讀不一致」——白話說明與正確下一步（明天恢復／調上限）整句丟失，還誤指使用者去手動記帳）

export async function aiBankRoute(b64, password, db, seams = {}) {
  const stage = makeStageSink(seams.onStage);   // 進度＝附屬品：沒給 onStage 就零位移；sink 爆掉也不影響解析
  if (isHosted()) throw apiError(400, 'AI 解析尚未在雲端版開放：使用者隱私同意機制（多人前置）完成前，這條路寫死停用。', 'ai_hosted_off');
  const key = String(db?.settings?.aiApiKey || '');
  if (!key) throw apiError(400, '還沒有設定 AI 解析鑰匙——請先到設定頁存入你的 API key，再試一次。', 'ai_no_key');
  const engine = seams.engineFactory ? seams.engineFactory(key) : null;
  if (!engine) throw apiError(500, 'AI 引擎未接上（呼叫端沒帶 engineFactory）——這是程式接線錯誤，不是你的操作問題', 'ai_engine_missing');
  const extract = seams.extract || extractBankLines;
  // ⚠️ AI_START 的位置（Grok r0 修正）：不只要在 HOSTED 停止線／鑰匙／引擎三道**之後**（那三道零 AI
  // 呼叫），還要在**抽字之後**——抽字是本機工作、又要數秒，在它前面說「正在送給 AI 讀」＝資料還沒
  // 出門就宣稱已出門（#455 那型）。
  stage(STAGES.OPEN_PDF);
  const lines = await parseWithPool((b, pw) => extract(b, pw), decode(b64), statementPasswordPool(db, password ? [String(password)] : []));
  const text = linesToText(lines);
  stage(STAGES.AI_START);
  if (!dualReadWanted(db?.settings)) {
    // 單讀＋升級階梯（開關關閉＝回到 P2-2a 行為，一字不改）
    /** @type {any} */ let lastErr = null;
    for (const [i, model] of [engine.models.primary, engine.models.escalation].entries()) {
      stage(i === 0 ? STAGES.AI_SINGLE : STAGES.AI_ESCALATE);
      /** @type {any} */ let parsed;
      try {
        parsed = normalizeAiBank(await engine.parseOnce(text, model));
        assertAiBankGrounded(parsed, text);
      }
      catch (e) {
        const code = /** @type {any} */ (e)?.code;
        if (code === 'ai_bad_answer' || code === 'ai_refusal') { lastErr = e; continue; }   // 答案壞＝換大模型再試一次
        throw e;   // 鑰匙/服務錯誤：升級救不了，照實丟（訊息已白話、不含內文）
      }
      stage(STAGES.VERIFY);   // 三路一致（A4）：驗算真的在這裡發生——模板路線同款「先報驗算中再驗」，紅了照實擋
      try { return { parsed, reconcile: assertAiBankReconciled(parsed, db), aiModel: model, lines }; }   // lines 隨結果走（P2-3）
      catch (e) { lastErr = e; }   // 閘紅＝升級重試一次；第二次仍紅就照實擋
    }
    if (lastErr && /** @type {any} */ (lastErr).code) throw lastErr;   // 機密紀律（r1#3）：ai_* 訊息乾淨＝原樣丟
    throw apiError(400, 'AI 翻譯後帳仍軋不平（升級到第二個模型也一樣）。為了不把沒驗算過的數字記進帳本，這份不收——請改用手動記帳；要回報時講「AI 解析對不平」與銀行名即可，不用貼帳單內容。', 'ai_reconcile_failed');
  }
  // 雙讀（裁示⑦，預設開）：Sonnet 與 Opus **各自獨立**解一次（並行）→ 比對會影響帳本與去重鍵的欄位。
  stage(STAGES.AI_DUAL);
  const attempts = await Promise.all([engine.models.primary, engine.models.escalation].map((m) => aiTryModel(engine, m, text, db)));
  // ⚠️ **任一讀偵測到混幣即終局**（r5#2）：valid.length===1 會走 attest、仲裁那份若漏掉外幣區就把
  //   整份救回來並入帳。混幣是版面事實，不是「這一讀讀壞了」——看到的那一讀說了算。
  const mixedErr = attempts.find((a) => !a.ok && /** @type {any} */ (a).err?.code === 'ai_mixed_currency');
  if (mixedErr) throw /** @type {any} */ (mixedErr).err;
  const valid = attempts.filter((a) => a.ok);
  if (valid.length === 2) stage(STAGES.AI_COMPARE);   // ⚠️ 真的有兩份可比才說在比對（Grok r0：無條件推＝兩讀都掛也說「兩份都讀完了」）
  if (!valid.length) {
    // 兩讀都掛：服務類錯照實丟（換模型救不了）；否則丟第一個帶 code 的（訊息本來就乾淨）；再否則專用錯誤。
    const errs = attempts.map((a) => /** @type {any} */ (a).err);
    const svc = errs.find((e) => AI_SERVICE_CODES.includes(e?.code));
    if (svc) throw svc;
    const coded = errs.find((e) => e?.code);
    if (coded) throw coded;
    throw apiError(400, 'AI 翻譯後帳仍軋不平（兩個模型都一樣）。為了不把沒驗算過的數字記進帳本，這份不收——請改用手動記帳；要回報時講「AI 解析對不平」與銀行名即可，不用貼帳單內容。', 'ai_reconcile_failed');
  }
  if (valid.length === 2) {
    const cmp = aiAnswersAgree(valid[0].parsed, valid[1].parsed);
    // 全一致＝採用 **Opus（escalation）那份**（未比對的帳戶 label/note 兩份可能措辭不同——固定採較強
    // 模型、不留「誰先回來誰贏」的不確定性）；徽章標「雙讀一致」。
    if (cmp.agree) {
      stage(STAGES.VERIFY);
      const w = valid[1];
      // 報「驗算中」的同時**真的重跑一次閘**（Codex #512 r3#1：初讀的閘在 dual 階段就跑完了，只推碼不驗＝畫面說
      //   「正在驗算」其實沒在驗）。閘是純函式、同輸入同結果——重跑＝讓 stage 誠實，不改變裁決。
      return { parsed: w.parsed, reconcile: assertAiBankReconciled(w.parsed, db), aiModel: w.model, lines, dualRead: /** @type {const} */ ('agree'), ...(cmp.textVariance.length ? { dualReadTextVariance: cmp.textVariance } : {}) };
    }
  }
  // 不一致（或只有一讀有效＝另一讀掛掉也算「沒有兩份互證」）＝送 Fable 獨立第三讀仲裁（裁示⑦a）。
  // ⚠️ 兩種情境用**不同代碼**（Codex r1#2）：兩讀都有效但不一致＝arbitrate；只有一讀有效＝attest。
  // 用同一句「兩份讀得不一樣」講後者＝假話（#476 r1#1 已為徽章拆過同一組語意，這裡不得重新引入）。
  stage(valid.length === 2 ? STAGES.AI_ARBITRATE : STAGES.AI_ATTEST);
  const arb = await aiTryModel(engine, AI_ARBITER_MODEL, text, db);
  if (!arb.ok) {
    const code = /** @type {any} */ (arb).err?.code;
    if (AI_SERVICE_CODES.includes(code)) throw /** @type {any} */ (arb).err;   // 仲裁者服務故障＝照實丟（可重試），不是「三份不同」
  } else {
    const matches = valid.filter((v) => aiAnswersAgree(v.parsed, arb.parsed).agree);
    // 與**恰一份**全欄一致＝採用那份；dualRead 分兩值（預審 W3、畫面誠實）：兩讀有效但不一致＝
    // 'arbitrated'（徽章講「前兩讀不一致」）、只有一讀有效（另一讀沒產出合法答案）＝'attested'
    //（那句「前兩讀不一致」在此情境是假話——沒有兩份答案可言）。
    // ⚠️ 誠實註記（R3b 模式）：`=== 1` 與 `>= 1` 在可達狀態下行為
    // 等價——兩份有效答案彼此不一致⇒Fable 不可能同時與兩份全一致；只有一份有效時 matches∈{0,1}。
    // 寫 `=== 1` 是把「恰一份」的裁示語意直接寫進判準（防未來改動悄悄放寬），不是現在就有第二條路。
    if (matches.length === 1) {
      // ✏️ 給使用者看的是**兩份初讀**的寫法差（Grok G10：勝者對仲裁者的差＝語意偏移、且可能恒空）
      const w = matches[0];
      const first = valid.length === 2 ? aiAnswersAgree(valid[0].parsed, valid[1].parsed) : aiAnswersAgree(w.parsed, /** @type {any} */ (arb).parsed);
      const tv = first.textVariance;
      // 仲裁差異欄名現形（William 2026-08-18：「希望降低仲裁的需要」→先讓證據現形才能照證據調校）：
      // 兩份初讀在**錢欄位**差在哪幾欄，隨預覽帶給使用者（**只帶欄位路徑、絕不帶欄值**＝aiAnswersAgree
      // 的既有機密紀律；同一份 diffs 在三讀不一致的錯誤訊息裡本來就會亮相，這裡只是把「仲裁救回來」
      // 的情境也照亮）。attested 沒有第二份合法答案＝無從比較＝不帶這個欄位（Grok r0 對帳：畫面對空
      // 陣列本來就不畫，「唸怪話」的舊說法不成立——不帶的真正理由是**語意**：沒有可比的兩份就不該
      // 存在「兩份的差異」這個鍵）。
      stage(STAGES.VERIFY);   // 三路一致（A4）：報「驗算中」的同時真的重跑一次閘（r3#1，同雙讀一致路——純函式重跑＝誠實不改裁決）
      return { parsed: w.parsed, reconcile: assertAiBankReconciled(w.parsed, db), aiModel: w.model, lines, dualRead: valid.length === 2 ? /** @type {const} */ ('arbitrated') : /** @type {const} */ ('attested'), ...(tv.length ? { dualReadTextVariance: tv } : {}), ...(() => {
        // fail-closed（Codex #485 r1#1）：出站前用封閉形狀再驗一次——考題矩陣鎖 aiAnswersAgree 的
        // 現在，這道鎖它的未來（不合形＝整格丟掉；機密優先於資訊完整）。
        if (valid.length !== 2) return {};
        const maxTx = Math.max(valid[0].parsed?.transactions?.length || 0, valid[1].parsed?.transactions?.length || 0);
        const safe = sanitizeAiDiffs(first.diffs, maxTx);
        return safe.length ? { dualReadDiffs: safe } : {};
      })() };
    }
  }
  // 三份互不相同（含 Fable 只部分吻合／答案壞）＝不猜、標紅轉手動——訊息列**欄位**不列值（機密紀律）。
  const diffs = valid.length === 2 ? aiAnswersAgree(valid[0].parsed, valid[1].parsed).diffs
    : (arb.ok ? aiAnswersAgree(valid[0].parsed, arb.parsed).diffs : []);
  const where = diffs.length ? `（不一致的欄位：${aiDiffSummary(diffs)}）` : '';
  throw apiError(400, `幾個 AI 各自讀出了不同的內容${where}，程式分不出誰對。為了不把沒把握的數字記進帳本，這份不收——請改用手動記帳；要回報時講「AI 三讀不一致」與銀行名即可，不用貼帳單內容。`, 'ai_disagree');
}

/**
 * 配方生成（P2-3）：**AI 票路線兌票寫入成功之後**才跑（另一發生成呼叫——P2-4 雙讀＋仲裁走滿時
 * 它是本次上傳的第四發；一律 RECIPE_MODEL＝Opus，裁示⑥）。
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
    // ⚠️ **出生三關也是「整份跑兩趟、每趟只用一把尺」**（同 `recipeBankRoute`）：先 `'old'`
    //   （逐字＝main 的出生條件），整趟過不了才試 `'new'`（帳單把版面文字印成相容字的情形）。
    //   ⚠️ 三關與解析在同一趟內用**同一把尺**——尺不同會讓「驗過的」與「解出來的」不是同一件事。
    //   ⚠️ 失敗代碼回報**第一趟**的（`'old'` 是主線；兩趟都敗時，先敗在哪一關才是有用的診斷）。
    /** @type {ParsedBankFull|null} */ let actual = null;
    /** @type {string|null} */ let birthFail = null;
    for (const ruler of RECIPE_RULERS) {
      const step = () => {
        if (validateRecipeStrict(candidate, { ruler }).length) return 'recipe_birth_strict';
        try {
          if (!recipeMatches(lines, candidate, { ruler })) return 'recipe_birth_match';
          actual = /** @type {any} */ (parseWithRecipe(lines, candidate, { ruler }));
        } catch { return 'recipe_birth_parse'; }
        if (validateRecipeAgainstStatement(lines, candidate, /** @type {any} */ (ticket.parsed), { ruler }).length) return 'recipe_birth_statement';
        if (!recipeReproduces(/** @type {any} */ (ticket.parsed), /** @type {any} */ (actual)).ok) return 'recipe_birth_reproduce';
        return null;
      };
      const fail = step();
      if (!fail) { birthFail = null; break; }
      if (birthFail === null) birthFail = fail;   // 記第一趟的代碼
      actual = null;
    }
    if (birthFail) return { saved: false, reason: birthFail };
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
 * @param {{useAi?:boolean, aiEngineFactory?:(key:string)=>AiEngine, aiExtract?:typeof extractBankLines, onStage?:(f:any)=>void, aiBudget?:{used:()=>number, loadBill:(n:any)=>void, take:()=>Promise<void>}}} [opts] */
export async function previewBankStatement(b64, password, parse = parseBankStatement, opts = {}) {
  const stage = makeStageSink(opts.onStage);
  stage(STAGES.READ_DB);
  const db = await getDb();   // 密碼池＋閘的幣別補位（P0.1 r1#2）都要它；預覽全程唯讀
  /** @type {ParsedBankFull} */ let parsed;
  try {
    // ⚠️ 只推一碼（Grok r0：OPEN_PDF 與 TEMPLATE_TRY 之間**沒有可觀測的邊界**——開檔、試密碼、認版
    // 都在同一記 parseWithPool 裡；同步連推兩碼＝前者在同一 tick 被蓋掉＝試密碼那幾秒畫面說的是
    // 「正在認版面」。合併成一句誠實描述這段真正在做的事。）
    stage(STAGES.OPEN_PDF);
    parsed = await parseWithPool((b, pw) => parse(b, pw), decode(b64), statementPasswordPool(db, password ? [String(password)] : []));
    stage(STAGES.TEMPLATE_HIT);
  } catch (e) {
    // P2-2 配方路線：認不得（且非密碼問題）＝先試存好的配方——零元零外送、**不需 useAi**。
    // 密碼錯（pdf_password）照舊回前端跳密碼窗；配方全敗＝照原順序輪 AI 或把原錯拋回。
    /** @type {string[]} */ let recipeGateFailedIds = [];
    if (/** @type {any} */ (e)?.code !== 'pdf_password' && /** @type {any} */ (e)?.code !== 'bank_mixed_currency') {   // 混台外幣＝版面歧義，配方路的答案一樣是拒收
      // ⚠️ 只在**真的判定版面不符**時才說「範本認不得」（Codex r1#1：舊版只排除 pdf_password＝壞掉的
      // PDF、頁數/元素上限被拒都會先被說成「範本認不得」＝先報錯死因、再冒出真正的錯誤）。
      // 判準＝解析器自己的機器碼 bank_unrecognized（AI 入口的同一個判準，ai-consent shouldOfferAi 也用它）。
      if (/** @type {any} */ (e)?.code === 'bank_unrecognized') stage(STAGES.TEMPLATE_MISS);
      // ⚠️ 真的有卡可試才說在試（Codex r1#1：無卡時 recipeBankRoute 直接返回、畫面卻先說「正在試規則卡」
      // ——**有沒有卡**是布林、不是張數，報它不洩漏使用者側寫）。
      const hasRecipes = Array.isArray(db?.parseRecipes) && db.parseRecipes.length > 0;
      if (hasRecipes) stage(STAGES.RECIPE_TRY);
      const rec = await recipeBankRoute(b64, password, db, { extract: opts.aiExtract, stage });   // 傳的是 makeStageSink 的 sink（吃**代碼**、內部包 stageFrame）——唯一出口不變
      if (hasRecipes) stage(rec.hit ? STAGES.RECIPE_HIT : STAGES.RECIPE_MISS);
      recipeGateFailedIds = rec.gateFailedIds;
      if (rec.hit) {
        // 配方也發票（預審 G2/G3）：①「所見即所得」——apply 憑票用 preview 那份 parsed 與選版，
        // 不重跑選版（選版依 db 現況會漂）②「別張配方失靈、本張救場」的失靈名單搭同一張票
        // 到 apply 才標（preview 唯讀不變量不破）。
        const aiTicket = issueAiTicket({ parsed: rec.hit.parsed, aiModel: '',
          recipeUse: { id: rec.hit.recipeId, usedVersion: rec.hit.usedVersion, currentMatched: rec.hit.currentMatched, usedRecipe: rec.hit.usedRecipe },
          suspectRecipeIds: rec.gateFailedIds });
        stage(STAGES.BUILD_PREVIEW);   // 配方命中也走整理（Grok r0：只有模板路報＝做了不報、兩條路不對稱）
        return { ...previewBalancesForDb(db, rec.hit.parsed), transactions: previewBankTxForDb(db, rec.hit.parsed),
          reconcile: rec.hit.reconcile, engine: 'recipe', recipeId: rec.hit.recipeId, aiTicket };
      }
    }
    if (!aiEligible(e, opts)) throw e;
    const r = await aiBankRoute(b64, password, db, { engineFactory: opts.aiEngineFactory, extract: opts.aiExtract, onStage: opts.onStage });
    // 發確認票（r4#1）：把**這一份**已驗收＋已過閘的答案留在伺服器記憶體，apply 憑票寫入同一份——
    // AI 不是確定性解析器，apply 自己重跑會讓「使用者確認的 A」變成「實際入帳的 B」（Codex 實測）。
    // lines 進票（P2-3 W1）：正式前端的 AI 套用**不送檔案內容**（applyBody 只送 {useAi, aiTicket}）——
    // 生成的原文只能從票拿；順帶讓「AI apply 不解析檔案、不碰密碼池」的契約句在 P2-3 後仍為真（W3）。
    stage(STAGES.BUILD_PREVIEW);   // AI 路也走整理（同上）
    // aiCalls（成本護欄 C1）：把這一份在 preview 用掉的發數寫進票——apply 那邊是另一個請求、另一份
    // 預算物件，靠票續數「單張 N 發」才包含生成那一發。aiBudget 是路由組裝件（engine 工廠閉包同一份）。
    const aiTicket = issueAiTicket({ parsed: r.parsed, aiModel: r.aiModel, suspectRecipeIds: recipeGateFailedIds, lines: r.lines, aiCalls: opts.aiBudget?.used?.() ?? 0 });
    return { ...previewBalancesForDb(db, r.parsed), transactions: previewBankTxForDb(db, r.parsed), reconcile: r.reconcile, engine: 'ai', aiModel: r.aiModel, aiTicket, ...(/** @type {any} */ (r).dualRead ? { dualRead: /** @type {any} */ (r).dualRead } : {}), ...(/** @type {any} */ (r).dualReadTextVariance ? { dualReadTextVariance: /** @type {any} */ (r).dualReadTextVariance } : {}), ...(/** @type {any} */ (r).dualReadDiffs ? { dualReadDiffs: /** @type {any} */ (r).dualReadDiffs } : {}) };
  }
  stage(STAGES.VERIFY);
  const reconcile = assertBankReconciled(parsed, db);   // 對不上＝這裡就 400（前端既有錯誤路徑會原句顯示）；刻意在 try 外＝閘紅不落 AI
  stage(STAGES.BUILD_PREVIEW);
  const cardPlan = debitCardPlan(db, parsed);   // 簽帳金融卡明細：兩本帳共用同一份計畫
  const plan = planDebitCardLedger(db, parsed, cardPlan);   // A 區刷卡消費要記到哪張卡、幾筆（沒有 A 區＝空）
  return { ...previewBalancesForDb(db, parsed, { deterministic: true }), transactions: previewBankTxForDb(db, parsed, { cardPlan }), reconcile,
    cardLedger: { cards: plan.cards.map((c) => ({ cardId: c.cardId, name: c.name, lastFour: c.lastFour, exists: c.exists })), count: plan.count, duplicate: plan.duplicate, notRecorded: plan.skipped, error: plan.error } };   // 模板路線＝唯一的確定性解析
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
 * 「apply 零外部 IO」已不成立，成本邊界＝每次上傳至多 4 發（P2-4 雙讀；關雙讀＝3）、單一真相在 server.js OUTBOUND 註解）。
 * @param {string} b64 @param {string=} password @param {typeof parseBankStatement} [parse] 測試接縫（見上）
 * @param {{useAi?:boolean, aiTicket?:string, skipSimilar?:boolean, aiEngineFactory?:(key:string)=>AiEngine, aiExtract?:typeof extractBankLines, aiRecipeGen?:typeof generateRecipeAfterImport, birthWrite?:typeof updateRecipeBirthStats, aiBudget?:{used:()=>number, loadBill:(n:any)=>void, take:()=>Promise<void>}}} [opts] */
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
    // 成本護欄 C1：把票上 preview 已用的發數載入本請求的預算——生成那一發（本請求唯一可能的一發）
    // 要算在同一份帳單頭上，「單張 N 發」才不是 preview、apply 各數各的。
    opts.aiBudget?.loadBill?.(ticket.aiCalls || 0);
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
      // bank_mixed_currency（Codex #517 r3#2）：**apply 這條路也要排除**——我 r2 只改了 preview，
      //   結果一張只涵蓋台幣區的舊配方就能把它救回來（他實跑：engine:'recipe'、imported:2、foreign:0，
      //   db 同時寫入 TWD 與 USD 兩筆、還建了 TWD 帳戶）。那不是多抽一次字，是**繞過拒收牆的錢錯**。
      if (/** @type {any} */ (e)?.code !== 'pdf_password' && /** @type {any} */ (e)?.code !== 'bank_mixed_currency') {
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
    const bal = applyBalancesToDb(db, parsed, { deterministic: !ai && !recipeUse });   // 模板路線才准做到期歸零（機率性路線讀漏一列＝把還在的定存清成 0）
    const cardPlan = debitCardPlan(db, parsed);   // 兩本帳共用同一份計畫（寫 D 列之前算好）
    const tx = importBankTxToDb(db, parsed, { skipSimilar: opts.skipSimilar === true, cardPlan });
    const cardLedger = importDebitCardLedgerToDb(db, parsed, cardPlan, /** @type {any} */ (tx).refByIndex || []);   // 簽帳金融卡明細→卡片帳本（模板路線才有 cardRows；AI／配方路線＝空）；卡片列的批次＝它 D 列所屬批次
    // P2-2 配方記帳（同一次交易、saveDb 之前＝與匯入原子一致）：
    // 配方套用成功＝計數/回滾互換；AI 票帶的「預覽時配方閘紅」名單＝標疑似過期。
    if (recipeUse) recordRecipeApplied(db, { ...recipeUse, imported: Number(/** @type {any} */ (tx)?.imported) || 0 });
    if (ticket?.suspectRecipeIds?.length) markRecipesSuspect(db, ticket.suspectRecipeIds, ticket.issuedAt);
    if (directGateFailedIds.length) markRecipesSuspect(db, directGateFailedIds, directObservedAt);
    await saveDb(db);
    committed = { bal, tx, cardLedger };   // W4：寫入已成功——生成搬到恢復邊界之外（票放回的論證不可被生成的 await 掏空）
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
  // 出生結果記一筆（體檢 R2）：**成功也記**——沒有分母就看不出失敗率，而「規則卡到底誕生過沒有」
  // 正是省 AI 那條路唯一的黑箱。⚠️ 只記結果代碼＋機構名＋日期，帳單內容與配方內容一律不入。
  // ⚠️ 記錄失敗不可連坐（匯入已經成功、票已消耗）＝整段包 catch，與上面那層同一個理由。
  if (recipeGen) {
    try {
      const code = /** @type {any} */ (recipeGen).saved ? 'ok' : String(/** @type {any} */ (recipeGen).reason || 'recipe_gen_failed');
      const bank = parsed?.bank ? stmtBank(parsed) : '';   // 出生統計也用正規短名（同一家不分兩列）
      const today = nowLocal().date;   // ⚠️ 本地日曆日（Codex #489 r3#1：toISOString 是 UTC，台北 00:00–07:59 會早一天＝證據日期失真）
      // ⚠️ 一定要在櫃檯的交易內對 **fresh** 統計表累加（Codex #489 r1#2）：先讀再算好整包交出去＝
      //   兩次同時出生會都從同一個 n 讀起、後寫者把前一筆蓋掉＝掉一筆，而筆數正是這支的全部價值。
      // birthWrite＝**測試接縫**（r3#1 慣例，正式呼叫端絕不傳）：讓「統計寫入失敗」可注入，
      //   才證明得了「不連坐」是行為而不是原始碼裡有個 try（Codex #489 r1#4）。
      const writeStats = /** @type {typeof updateRecipeBirthStats} */ (opts.birthWrite || updateRecipeBirthStats);
      await writeStats((cur) => recordBirth(cur, code, bank, today));
    } catch { /* 診斷資料寫不進去，不能影響已完成的匯入 */ }
  }
  return { ok: true, ...committed.bal, transactions: committed.tx, cardLedger: committed.cardLedger, ...(ai || {}),
    ...(recipeUse ? { engine: 'recipe', recipeId: recipeUse.id } : {}),
    ...(recipeGen ? { recipe: recipeGen } : {}) };
}

export { acctPatternsIntersect as acctPatternsIntersectForTest };   // 測試接縫：語言交集的對稱性（正式呼叫端永遠把遮罩放第一參數，對方星號那一支只有直測咬得住）
export { accountNameForTx as accountNameForTxForTest };   // 測試接縫（正式呼叫端不用）：定存分開列管的「掛名繞開定存戶」行為卷直測
export { ownAccountNameByAcct as ownAccountNameByAcctForTest };   // 測試接縫：「轉入到」顯示繞開定存戶的行為卷直測
export { maturedCdAccounts as maturedCdAccountsForTest };   // 測試接縫：日期正規化＝縱深防禦（正式路的斜線參考日在上游就 blocked、走不到這裡）——直測才咬得住
