// @ts-check
// P2 配方快取——配方純模組（格式定義＋零內容驗證器＋泛化解析引擎＋出生驗收比對器）。
//
// 「配方」＝AI 第一次讀懂某種帳單版面後留下的**純資料翻譯規則卡**（★4 拍板 2026-08-11＋
// William 2026-08-14 定案格式 A＝填格子）。之後同版面的帳單由本引擎在 app 內解——快、免費、
// 內文不再送 AI。四條硬規矩：
//  ①**配方裡零正則**（比 ★4 的「regex 資源上限」更嚴——直接沒有 regex 就沒有 regex 炸彈）：
//    槽位只有「字面文字」與「枚舉選項」；本檔程式內部用 regex 是正常的（受考題保護的實作），
//    禁的是**配方內容**攜帶可執行／可解釋的樣式。
//  ②**零帳單內容的機械驗證**（★4 硬條件「不是口頭保證」）：每格限長、禁連續 4 位以上數字、
//    禁 `*`（遮罩帳號長相）與 `|`（bankRef 分段符）——驗證器拒收，不是提示詞拜託。
//  ③**幾何機關全在引擎、不在配方**：右緣分欄、running 餘額覆寫方向、換行備註歸位……
//    這些是 lib/bank-statement.js 已被考題釘住的機關的泛化；配方只告訴引擎「欄標題長什麼樣」，
//    位置由引擎自己找。配方講不出的怪版面（跨頁表格、多段式）＝正常代價，繼續走 AI。
//  ④**出生驗收（recipeReproduces）**：配方存檔前必須用它當場重解同一份帳單、逐欄重現
//    使用者已確認的 AI 答案——重現不了＝不存。存下來的配方天生證明過自己；
//    這也是「配方所得＝使用者當初確認的所得」的機械保證（同 #458 預覽所見＝匯入所得的精神）。
//
// 版本與回滾（William 2026-08-15 裁示）：一種版面只存一份現行配方、不留舊版；
// 失靈（對帳閘紅）＝退回 AI 重讀、重生新配方；安全性靠閘不靠舊版。
// 儲存與管線接線＝P2-2、AI 產配方＝P2-3；本檔零 IO、零外連（同 ai-parse.js 的純模組紀律）。
import { isRealDate } from './schema.js';
import { squash, parseAmount, splitAmount, accountSuffix, isMaskedAccount, UNKNOWN_CURRENCY } from './bank-statement.js';

/** @typedef {import('./bank-statement.js').BankTx} BankTx */
/** @typedef {{x:number, w?:number, s:string}} Cell */
/** @typedef {{y:number, cells:Cell[]}} BLine */

/** 配方格式版本（引擎相容性判準：不認得的版本一律拒用，fail-closed）。 */
export const RECIPE_FORMAT_VERSION = 1;

/** 日期格式枚舉（配方只能從這裡選，不能自由發揮）。 */
export const RECIPE_DATE_FORMATS = /** @type {const} */ (['west-slash', 'roc-slash']);
/** 參考日策略枚舉：錨點行取日期／錨點行取期間結束日／這種版面沒有參考日。 */
export const RECIPE_REFDATE_STRATEGIES = /** @type {const} */ (['anchored-date', 'anchored-period-end', 'none']);
/** 概要餘額挑格策略：帶 $ 的第一格／第一個金額格／最後一個金額格。 */
export const RECIPE_BALANCE_PICKS = /** @type {const} */ (['dollar-tagged', 'first-money', 'last-money']);
/** 交易列判準：帳號格＋日期格開頭／日期格開頭（單帳戶版面）。 */
export const RECIPE_ROW_IDENTS = /** @type {const} */ (['acct-date', 'date-first']);

/** 各槽位長度上限（零內容驗證的一部分：格子小到裝不下帳單內文）。
 * 刻意沒有「整份 JSON 總長」上限——逐槽上限加總後合法配方最大約 1KB，總長檢查永遠不會觸發
 * ＝考題撐不住的保證，不寫（儲存層的字串欄上限是 P2-2 的事）。 */
export const RECIPE_LIMITS = Object.freeze({
  bank: 20, anchor: 30, header: 20, docAnchors: 4, sections: 4, headerIgnore: 4,
});

/**
 * @typedef {{
 *   formatVersion: number,
 *   bank: string,
 *   docAnchors: string[],
 *   dateFormat: 'west-slash'|'roc-slash',
 *   refDate: { strategy: 'anchored-date'|'anchored-period-end'|'none', anchor: string|null },
 *   summary: {
 *     sections: { anchor: string, currency: string }[],
 *     endAnchor: string,
 *     balancePick: 'dollar-tagged'|'first-money'|'last-money',
 *   },
 *   detail: {
 *     rowIdent: 'acct-date'|'date-first',
 *     headerOut: string, headerIn: string, headerBalance: string,
 *     headerNote: string|null,
 *     headerIgnore: string[],
 *   },
 * }} ParseRecipe
 */

// ---- 零內容驗證器 ----------------------------------------------------------

/**
 * 單一文字槽的零內容檢查。錯誤訊息**只帶槽位路徑、絕不回聲槽值**（機密紀律同 ai-parse r1#3：
 * 會走到這裡的值可能就是不該存在的帳單內文，回聲＝把它印進 log）。
 *
 * 數字判準（預審② 2026-08-15 兩條繞法後收緊）：先 **NFKC 正規化**（全形數字/星號/直線→半形，
 * 關掉「全形整碗繞過 \d」）、再 squash、再數**數字總量 ≥4 就拒收**——不只連號，CJK/標點把數字
 * 拆散重拼的繞法一併關掉。殘餘面＝每槽 ≤3 位、跨多槽拼接：那是刻意構造（#452 裁示＝不防
 * 對抗性藏匿），且 P3 共用前另有審核層；P2 配方只進自己資料庫。
 * @param {string} path @param {unknown} v @param {number} maxLen @param {string[]} errs
 * @param {number=} minLen squash 後最短長度（版面錨點與金額欄標題＝2：1 字錨點會在交易列上誤觸發）
 */
function checkSlot(path, v, maxLen, errs, minLen = 1) {
  if (typeof v !== 'string') { errs.push(`${path}：必須是文字`); return; }
  if (v !== v.trim() || v.length === 0) { errs.push(`${path}：不可為空或帶頭尾空白`); return; }
  if (v.length > maxLen) { errs.push(`${path}：超過 ${maxLen} 字上限`); return; }
  const q = squash(v).normalize('NFKC');
  if (q.length === 0) { errs.push(`${path}：去空白後為空`); return; }
  if (squash(v).length < minLen) errs.push(`${path}：至少 ${minLen} 個字（太短＝什麼版面都認）`);
  if ([...q].filter(ch => ch >= '0' && ch <= '9').length >= 4) errs.push(`${path}：數字達 4 位以上（疑似帳單內容，拒收）`);
  if (q.includes('*')) errs.push(`${path}：含星號（疑似遮罩帳號，拒收）`);
  if (q.includes('|')) errs.push(`${path}：含直線分段符（bankRef 保留字，拒收）`);
}

/** 物件只准出現白名單鍵（同 AI 答案卷 additionalProperties:false 的精神）。
 * ⚠️ 鍵名**也不回聲**（預審④：帳單內文落在鍵名位置一樣是內文）——只報長度，同 ai-parse 慣例。
 * @param {string} path @param {Record<string, unknown>} obj @param {string[]} allowed @param {string[]} errs */
function checkKeys(path, obj, allowed, errs) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errs.push(`${path}：含不認得的欄位（鍵名 ${k.length} 字，不回聲）`);
  }
}

/**
 * 配方嚴格驗證：回錯誤訊息陣列（空陣列＝合格）。整包驗、不修補——配方是機器產的，
 * 壞一格＝整份拒收重生，沒有「寬鬆修補」的路（storeRules 的寬鬆端是給人手填的，這裡不是）。
 * @param {unknown} raw @returns {string[]}
 */
export function validateRecipeStrict(raw) {
  /** @type {string[]} */
  const errs = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['配方：必須是物件'];
  const r = /** @type {Record<string, any>} */ (raw);
  checkKeys('配方', r, ['formatVersion', 'bank', 'docAnchors', 'dateFormat', 'refDate', 'summary', 'detail'], errs);
  if (r.formatVersion !== RECIPE_FORMAT_VERSION) errs.push(`formatVersion：只認 ${RECIPE_FORMAT_VERSION}`);
  checkSlot('bank', r.bank, RECIPE_LIMITS.bank, errs);

  if (!Array.isArray(r.docAnchors) || r.docAnchors.length < 1 || r.docAnchors.length > RECIPE_LIMITS.docAnchors) {
    errs.push(`docAnchors：必須是 1–${RECIPE_LIMITS.docAnchors} 條的清單`);
  } else {
    r.docAnchors.forEach((a, i) => checkSlot(`docAnchors[${i}]`, a, RECIPE_LIMITS.anchor, errs, 2));
  }

  if (!RECIPE_DATE_FORMATS.includes(r.dateFormat)) errs.push('dateFormat：不在枚舉清單');

  if (!r.refDate || typeof r.refDate !== 'object' || Array.isArray(r.refDate)) errs.push('refDate：必須是物件');
  else {
    checkKeys('refDate', r.refDate, ['strategy', 'anchor'], errs);
    if (!RECIPE_REFDATE_STRATEGIES.includes(r.refDate.strategy)) errs.push('refDate.strategy：不在枚舉清單');
    else if (r.refDate.strategy === 'none') {
      if (r.refDate.anchor !== null) errs.push('refDate.anchor：strategy=none 時必須是 null');
    } else checkSlot('refDate.anchor', r.refDate.anchor, RECIPE_LIMITS.anchor, errs, 2);
  }

  if (!r.summary || typeof r.summary !== 'object' || Array.isArray(r.summary)) errs.push('summary：必須是物件');
  else {
    checkKeys('summary', r.summary, ['sections', 'endAnchor', 'balancePick'], errs);
    if (!Array.isArray(r.summary.sections) || r.summary.sections.length < 1 || r.summary.sections.length > RECIPE_LIMITS.sections) {
      errs.push(`summary.sections：必須是 1–${RECIPE_LIMITS.sections} 段的清單`);
    } else {
      r.summary.sections.forEach((s, i) => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) { errs.push(`summary.sections[${i}]：必須是物件`); return; }
        checkKeys(`summary.sections[${i}]`, s, ['anchor', 'currency'], errs);
        checkSlot(`summary.sections[${i}].anchor`, s.anchor, RECIPE_LIMITS.anchor, errs, 2);
        // 幣別＝固定三碼（TWD/USD/…）或 BY-CODE（區內 sticky 三碼標題，台新外幣區那種）
        if (s.currency !== 'BY-CODE' && !/^[A-Z]{3}$/.test(String(s.currency))) {
          errs.push(`summary.sections[${i}].currency：只准三碼大寫幣別或 BY-CODE`);
        }
      });
    }
    checkSlot('summary.endAnchor', r.summary.endAnchor, RECIPE_LIMITS.anchor, errs, 2);
    if (!RECIPE_BALANCE_PICKS.includes(r.summary.balancePick)) errs.push('summary.balancePick：不在枚舉清單');
  }

  if (!r.detail || typeof r.detail !== 'object' || Array.isArray(r.detail)) errs.push('detail：必須是物件');
  else {
    checkKeys('detail', r.detail, ['rowIdent', 'headerOut', 'headerIn', 'headerBalance', 'headerNote', 'headerIgnore'], errs);
    if (!RECIPE_ROW_IDENTS.includes(r.detail.rowIdent)) errs.push('detail.rowIdent：不在枚舉清單');
    checkSlot('detail.headerOut', r.detail.headerOut, RECIPE_LIMITS.header, errs, 2);
    checkSlot('detail.headerIn', r.detail.headerIn, RECIPE_LIMITS.header, errs, 2);
    checkSlot('detail.headerBalance', r.detail.headerBalance, RECIPE_LIMITS.header, errs, 2);
    if (r.detail.headerNote !== null) checkSlot('detail.headerNote', r.detail.headerNote, RECIPE_LIMITS.header, errs);
    if (!Array.isArray(r.detail.headerIgnore) || r.detail.headerIgnore.length > RECIPE_LIMITS.headerIgnore) {
      errs.push(`detail.headerIgnore：必須是 0–${RECIPE_LIMITS.headerIgnore} 條的清單`);
    } else r.detail.headerIgnore.forEach((h, i) => checkSlot(`detail.headerIgnore[${i}]`, h, RECIPE_LIMITS.header, errs));
    // 三個金額欄標題必須彼此不同——撞名＝findX 抓到同一格、分欄邊界塌掉
    const hs = [r.detail.headerOut, r.detail.headerIn, r.detail.headerBalance].filter(h => typeof h === 'string').map(squash);
    if (new Set(hs).size !== hs.length) errs.push('detail：支出／存入／餘額欄標題不可相同');
  }

  return errs;
}

// ---- 引擎 ------------------------------------------------------------------

/** 日期字串照配方的格式枚舉轉 ISO；不合格式回 null（引擎內部 regex＝我們的程式，非配方內容）。 */
const DATE_PARSERS = {
  'west-slash': (/** @type {string} */ s) => {
    const m = String(s || '').trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  },
  'roc-slash': (/** @type {string} */ s) => {
    // 民國年 2–3 位（自動限縮：4 位就是西元、不歸這個格式管）
    const m = String(s || '').trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
    return m ? `${String(Number(m[1]) + 1911).padStart(4, '0')}-${m[2]}-${m[3]}` : null;
  },
};
/** 從 squash 後的整列文字裡撈出所有日期（轉 ISO）。 */
const DATE_SCANNERS = {
  'west-slash': (/** @type {string} */ t) => [...t.matchAll(/(\d{4})\/(\d{2})\/(\d{2})/g)].map(m => `${m[1]}-${m[2]}-${m[3]}`),
  'roc-slash': (/** @type {string} */ t) => [...t.matchAll(/(?<!\d)(\d{2,3})\/(\d{2})\/(\d{2})/g)].map(m => `${String(Number(m[1]) + 1911).padStart(4, '0')}-${m[2]}-${m[3]}`),
};

/** 這份帳單像不像這張配方講的版面：暗號（squash 後）必須**全部**出現在全文。
 * squash **逐列做、換行保留**（預審①：整份 squash 會把換行吃掉＝暗號可由前列列尾＋後列列頭
 * 跨列誤拼，別家版面被錯配進來）。 @param {BLine[]} lines @param {ParseRecipe} recipe */
export function recipeMatches(lines, recipe) {
  const text = lines.map(l => squash(l.cells.map(c => c.s).join(''))).join('\n');
  return recipe.docAnchors.every(a => text.includes(squash(a)));
}

/** 結構性失敗（版面跟配方講的對不上）＝退回 AI 的機器判準；訊息不帶任何帳單內容。 */
const parseFail = (/** @type {string} */ why) =>
  Object.assign(new Error(`配方解不動這份帳單（${why}）`), { status: 400, code: 'recipe_parse_failed' });

/**
 * 用配方解一份帳單（座標列 → 與模板／AI 同形狀的 ParsedBankFull，下游一行不改）。
 * 幾何機關與 lib/bank-statement.js 同源泛化：右緣分欄、running 餘額覆寫方向、孤兒備註歸位。
 * 正確性不在此層保證——呼叫端（P2-2）必須讓它過 **AI 級強閘**（level strong＋台幣帳戶零未驗＝0；
 * 與模板弱閘照舊放行**刻意相反**：配方跟 AI 一樣是機器生的，比照 AI 待遇）。
 * @param {BLine[]} lines @param {ParseRecipe} recipe
 * @returns {{ bank:string, referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[], accountCurrency:Record<string,string>, transactions:BankTx[] }}
 */
export function parseWithRecipe(lines, recipe) {
  const errs = validateRecipeStrict(recipe);
  if (errs.length) throw parseFail('配方本身不合格');
  if (!recipeMatches(lines, recipe)) throw parseFail('版面暗號對不上');
  const toDate = DATE_PARSERS[recipe.dateFormat];
  const scanDates = DATE_SCANNERS[recipe.dateFormat];

  // ---- 概要區（泛化 parseBankSummary）----
  /** @type {{suffix:string, masked:string, balance:number, currency:string, label:string, note:string}[]} */
  const accounts = [];
  /** @type {Record<string,string>} */
  const accountCurrency = {};
  /** @type {string|null} */
  let referenceDate = null;
  /** @type {{currency:string}|null} */
  let section = null;
  /** @type {string|null} */
  let pendingCurrency = null;
  const refAnchor = recipe.refDate.strategy === 'none' ? null : squash(recipe.refDate.anchor || '');
  const endAnchor = squash(recipe.summary.endAnchor);
  const isMoneyCell = (/** @type {string} */ s) => /\$/.test(s) || parseAmount(s) != null;

  for (const line of lines) {
    const cells = line.cells.map(c => c.s);
    const joined = squash(cells.join(''));
    if (referenceDate == null && refAnchor) {
      // 只掃「錨點**之後**」的文字（預審①：整列亂掃會撿到錨點前面的期間起日/別的日期，
      // 拿舊蓋新——正是規則 1a 要防的事故）。
      const at = joined.indexOf(refAnchor);
      if (at >= 0) {
        const ds = scanDates(joined.slice(at + refAnchor.length)).filter(isRealDate);
        // anchored-date＝錨點後第一個日期；anchored-period-end＝錨點後**恰好**起訖兩個日期才敢認
        // 「這是期間」、取第二個（1 個＝不是期間、3 個以上＝夾了列印日之類的別的日期，都＝不確定
        // ＝null——同 AI 提示詞規則 1a「寧可 null」：填錯會拿舊餘額蓋新數字，null 只是不更新餘額）。
        if (recipe.refDate.strategy === 'anchored-date') referenceDate = ds[0] ?? null;
        else if (ds.length === 2) referenceDate = ds[1];
      }
    }
    const hit = recipe.summary.sections.find(s => joined.includes(squash(s.anchor)));
    if (hit) { section = { currency: hit.currency }; pendingCurrency = null; continue; }
    if (endAnchor && squash(cells[0] || '').startsWith(endAnchor)) { section = null; continue; }
    if (!section) continue;
    if (section.currency === 'BY-CODE' && !cells.some(isMaskedAccount)) {
      // sticky 幣別標題三分法＝bank-statement.js r1 收緊的同一套（認得＝設、匯率/空列＝不動、看不懂＝清）
      const curs = [...new Set(cells.map(c => c.trim()).filter(c => /^[A-Z]{3}$/.test(c)))];
      if (curs.length === 1) { pendingCurrency = curs[0]; continue; }
      const meaningful = cells.map(c => c.trim()).filter(Boolean);
      const rateOrBlank = meaningful.length === 0 || meaningful.every(c => /^[\d.,%$]+$/.test(c));
      if (!rateOrBlank) pendingCurrency = null;
      continue;
    }
    const accIdx = cells.findIndex(isMaskedAccount);
    if (accIdx < 0) continue;
    const suffix = accountSuffix(cells[accIdx]);
    if (!suffix) continue;
    const masked = String(cells[accIdx]).replace(/\s/g, '');
    const label = squash(cells.slice(0, accIdx).join(' '));
    const after = cells.slice(accIdx + 1);
    /** @type {string|undefined} */
    let balCellS;
    if (recipe.summary.balancePick === 'dollar-tagged') balCellS = after.find(c => /\$/.test(c));
    else {
      const moneys = after.filter(isMoneyCell);
      balCellS = recipe.summary.balancePick === 'first-money' ? moneys[0] : moneys[moneys.length - 1];
    }
    const balance = balCellS != null ? parseAmount(balCellS) : null;
    const currency = section.currency === 'TWD' ? 'TWD'
      : section.currency === 'BY-CODE' ? (pendingCurrency || UNKNOWN_CURRENCY)
      : section.currency;   // 固定三碼（配方直接指定該區幣別）
    accountCurrency[masked] = currency;
    if (balance == null) continue;   // 餘額空白＝不進餘額更新清單（幣別已記）——同模板語意
    const note = squash(after.filter(c => c !== balCellS && !isMoneyCell(c)).join(' '));
    accounts.push({ suffix, masked, balance, currency, label, note });
  }

  // ---- 明細（泛化 parseBankDetail）----
  const { rowIdent, headerNote, headerIgnore } = recipe.detail;
  const hOut = recipe.detail.headerOut, hIn = recipe.detail.headerIn, hBal = recipe.detail.headerBalance;
  const soleMasked = rowIdent === 'date-first' ? Object.keys(accountCurrency) : null;
  if (soleMasked && soleMasked.length !== 1) throw parseFail('date-first 版面需要恰好一個帳戶');

  /** @type {(BankTx & {y:number, _notes:{y:number,t:string}[]})[]} */
  const rows = [];
  /** @type {{y:number, t:string}[]} */
  const orphans = [];
  let xOut = 0, xBal = 0, xNote = 0, mid = 0, inDetail = false;   // 存入欄 x 收進 colStarts、不留外層變數
  /** @type {{x:number, kind:'ign'|'out'|'in'}[]} 欄起點（依 x 升序）——右緣分欄的判準表 */
  let colStarts = [];
  /** @type {number[]} 忽略欄 x（退路下界要用「支出欄左側」的那些） */
  let ignXs = [];
  // 右緣 r 落在哪一欄：起點集合＝忽略欄們＋支出＋存入、區間到下一個起點為止（最右到 xBal）。
  // ⚠️ 忽略欄可在**任意位置**（預審① 2026-08-15：原版把忽略窗寫死 [xIgn, xOut)，只擋「支出欄
  // 左側」的忽略欄——右側版面（支出|存入|序號|餘額）的純序號列會被當成存款＝#408 H² 同型幽靈交易）。
  const colOf = (/** @type {number} */ r) => {
    if (r >= xBal || !colStarts.length || r < colStarts[0].x) return null;
    let hit = null;
    for (const s of colStarts) { if (s.x <= r) hit = s; else break; }
    return hit ? hit.kind : null;
  };
  const ORPHAN_MAX_DY = 40;   // 同 bank-statement.js（引擎常數，不是配方槽位）

  for (const line of lines) {
    const c = line.cells;
    const jc = squash(c.map(x => x.s).join(''));
    if (jc.includes(squash(hOut)) && jc.includes(squash(hIn)) && jc.includes(squash(hBal))) {
      // findX：先精確等於，再退 squash 等於（有些版面標題帶空白）；抓不到＝結構性失敗退 AI
      const findX = (/** @type {string} */ name) => {
        const hit = c.find(x => x.s === name) || c.find(x => squash(x.s) === squash(name));
        return hit ? hit.x : 0;
      };
      xOut = findX(hOut); xBal = findX(hBal);
      const xInCol = findX(hIn);
      xNote = headerNote ? findX(headerNote) : 0;
      if (!xOut || !xInCol || !xBal) throw parseFail('讀不到明細欄位位置');
      ignXs = headerIgnore.map(findX).filter(x => x > 0);
      colStarts = [...ignXs.map(x => ({ x, kind: /** @type {const} */ ('ign') })),
        { x: xOut, kind: /** @type {const} */ ('out') }, { x: xInCol, kind: /** @type {const} */ ('in') }]
        .sort((a, b) => a.x - b.x);
      mid = (xOut + xInCol) / 2;
      inDetail = true;
      continue;
    }
    if (!inDetail) continue;

    /** @type {string|null} */
    let dateIso = null;
    let restFrom = 0;
    if (rowIdent === 'acct-date') {
      if (isMaskedAccount(c[0]?.s)) { dateIso = toDate(c[1]?.s || ''); restFrom = dateIso ? 2 : 0; }
    } else if (!isMaskedAccount(c[0]?.s)) {
      dateIso = toDate(c[0]?.s || ''); restFrom = dateIso ? 1 : 0;
    }

    if (dateIso && restFrom) {
      const rest = c.slice(restFrom);
      const summary = squash(rest.filter(x => x.x < xBal && parseAmount(x.s) == null && !/\$/.test(x.s)).map(x => x.s).join(''));
      const amtCells = rest.filter(x => parseAmount(x.s) != null || /\$/.test(x.s));
      /** @type {Cell|null} */ let outCell = null;
      /** @type {Cell|null} */ let inCell = null;
      /** @type {Cell|null} */ let balCell = null;
      for (const cell of amtCells) {
        if (cell.x >= xBal) { if (!balCell) balCell = cell; continue; }
        const kind = colOf(cell.w ? cell.x + cell.w : cell.x);   // 忽略欄＝colOf 回 'ign'——兩條路都要擋（#408 r1 H² 的教訓）
        if (kind === 'out') { if (!outCell) outCell = cell; }
        else if (kind === 'in') { if (!inCell) inCell = cell; }
      }
      let txnCell = outCell || inCell;
      /** @type {'in'|'out'|null} */
      let direction = outCell ? 'out' : (inCell ? 'in' : null);
      if (!txnCell) {
        // 退路下界＝支出欄**左側**的忽略欄起點（右側忽略欄不縮小下界——預審①：原版 xIgn 混用
        // 會把左側真金額整列靜默丟棄）；忽略欄本身兩條路都以 colOf 擋。
        const leftIgns = ignXs.filter(x => x < xOut);
        const lower = leftIgns.length ? Math.min(...leftIgns) : (xOut - 60);
        txnCell = amtCells.find(x => {
          if (x.x < lower || x.x >= xBal) return false;
          return colOf(x.w ? x.x + x.w : x.x) !== 'ign';
        }) || null;
        if (txnCell) direction = txnCell.x < mid ? 'out' : 'in';
      }
      if (!txnCell || !direction) continue;
      const amount = parseAmount(String(txnCell.s).match(/[\d,]+(?:\.\d+)?/)?.[0] || '');
      if (amount == null) continue;
      if (!isRealDate(dateIso)) continue;   // 壞日期（如 2 月 31）＝整筆跳過，同模板
      const bs = balCell ? splitAmount(/** @type {{x:number,w:number,s:string}} */ (balCell)) : null;
      const rowNote = xNote ? rest.filter(x => x.x >= xNote && parseAmount(x.s) == null && !/\$/.test(x.s)).map(x => x.s).join('') : '';
      /** @type {{y:number,t:string}[]} */
      const ns = [];
      if (bs && bs.rest) ns.push({ y: line.y, t: bs.rest });
      if (rowNote) ns.push({ y: line.y, t: rowNote });
      const acctMasked = soleMasked ? soleMasked[0] : String(c[0].s).replace(/\s/g, '');
      rows.push({
        y: line.y, acctSuffix: accountSuffix(acctMasked), acctMasked,
        date: dateIso, summary, direction, amount, balance: bs ? bs.amt : null, note: '', _notes: ns,
      });
    } else if (xNote && c.length && c.every(x => x.x >= xNote - 70) && !isMaskedAccount(c[0]?.s) && !toDate(c[0]?.s || '')) {
      orphans.push({ y: line.y, t: c.map(x => x.s).join('') });
    }
  }

  // 方向以 running 餘額為權威（同 bank-statement.js：x 幾何只當 fallback）；分組鍵＝完整遮罩帳號
  /** @type {Map<string, typeof rows>} */
  const byAcct = new Map();
  for (const r of rows) { const g = byAcct.get(r.acctMasked); if (g) g.push(r); else byAcct.set(r.acctMasked, [r]); }
  for (const list of byAcct.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (prev.balance == null || cur.balance == null) continue;
      const delta = cur.balance - prev.balance;
      if (delta !== 0 && Math.abs(Math.abs(delta) - cur.amount) < 1) cur.direction = delta > 0 ? 'in' : 'out';
    }
  }
  for (const o of orphans) {
    let best = null, bd = Infinity;
    for (const r of rows) { const d = Math.abs(r.y - o.y); if (d < bd) { bd = d; best = r; } }
    if (best && bd <= ORPHAN_MAX_DY) best._notes.push(o);
  }
  const transactions = rows.map(r => ({
    acctSuffix: r.acctSuffix, acctMasked: r.acctMasked, date: r.date, summary: r.summary, direction: r.direction,
    amount: r.amount, balance: r.balance, note: r._notes.sort((a, b) => b.y - a.y).map(n => n.t).join(''),
  }));
  if (transactions.length === 0) throw parseFail('讀不到任何交易');   // 空預覽比退回 AI 更糟
  return { bank: recipe.bank, referenceDate, accounts, accountCurrency, transactions };
}

// ---- 出生驗收 --------------------------------------------------------------

/**
 * 配方的出生驗收：配方重解的結果必須**逐欄重現**使用者已確認的 AI 答案。
 * 回 {ok, diff}——diff 只帶「欄位路徑」、絕不帶欄值（值可能是真帳單內容，機密紀律）。
 * accounts 不比順序（兩邊都照帳單順序、但概要區跨段時排序不保證一致），逐 masked 對欄位；
 * transactions **嚴格比順序**（匯入順序影響 bankRef 去重與畫面，順序不同＝不算重現）。
 * @param {ReturnType<typeof parseWithRecipe>} expected AI 路線驗收後的答案（使用者確認的那份）
 * @param {ReturnType<typeof parseWithRecipe>} actual 配方重解的結果
 * @returns {{ok: boolean, diff: string|null}}
 */
export function recipeReproduces(expected, actual) {
  const no = (/** @type {string} */ d) => ({ ok: false, diff: d });
  if (expected.bank !== actual.bank) return no('bank');
  if (expected.referenceDate !== actual.referenceDate) return no('referenceDate');
  const ek = Object.keys(expected.accountCurrency), ak = Object.keys(actual.accountCurrency);
  if (ek.length !== ak.length) return no('accountCurrency（帳戶數）');
  for (const k of ek) if (expected.accountCurrency[k] !== actual.accountCurrency[k]) return no('accountCurrency（幣別）');
  if (expected.accounts.length !== actual.accounts.length) return no('accounts（帳戶數）');
  const byMasked = new Map(actual.accounts.map(a => [a.masked, a]));
  for (const [i, e] of expected.accounts.entries()) {
    const a = byMasked.get(e.masked);
    if (!a) return no(`accounts[${i}]（找不到對應帳戶）`);
    for (const f of /** @type {const} */ (['suffix', 'balance', 'currency', 'label', 'note'])) {
      if (e[f] !== a[f]) return no(`accounts[${i}].${f}`);
    }
  }
  if (expected.transactions.length !== actual.transactions.length) return no('transactions（筆數）');
  for (const [i, e] of expected.transactions.entries()) {
    const a = actual.transactions[i];
    for (const f of /** @type {const} */ (['acctSuffix', 'acctMasked', 'date', 'summary', 'direction', 'amount', 'balance', 'note'])) {
      if (e[f] !== a[f]) return no(`transactions[${i}].${f}`);
    }
  }
  return { ok: true, diff: null };
}
