// @ts-check
// P2 配方快取——配方純模組（格式定義＋零內容驗證器＋泛化解析引擎＋出生驗收比對器）。
//
// 「配方」＝AI 第一次讀懂某種帳單版面後留下的**純資料翻譯規則卡**（★4 拍板 2026-08-11＋
// William 2026-08-14 定案格式 A＝填格子）。之後同版面的帳單由本引擎在 app 內解——快、免費、
// 內文不再送 AI。四條硬規矩：
//  ①**配方裡零正則**（比 ★4 的「regex 資源上限」更嚴——直接沒有 regex 就沒有 regex 炸彈）：
//    槽位只有「字面文字」與「枚舉選項」；本檔程式內部用 regex 是正常的（受考題保護的實作），
//    禁的是**配方內容**攜帶可執行／可解釋的樣式。
//  ②**零帳單內容的機械驗證**（★4 硬條件「不是口頭保證」）：每格限長、NFKC＋去空白後
//    數字**總量** 4 位以上拒收（不只連號）、禁 `*`（遮罩帳號長相）與 `|`（bankRef 分段符）
//    ——驗證器拒收，不是提示詞拜託。無數字的交易內文靠第二道 validateRecipeAgainstStatement
//    （出生帳單對照：等值＋位置約束）擋。
//  ③**幾何機關全在引擎、不在配方**：右緣分欄、running 餘額覆寫方向、換行備註歸位……
//    這些是 lib/bank-statement.js 已被考題釘住的機關的泛化；配方只告訴引擎「欄標題長什麼樣」，
//    位置由引擎自己找。配方講不出的怪版面（跨頁表格、多段式）＝正常代價，繼續走 AI。
//  ④**出生驗收（recipeReproduces）**：配方存檔前必須用它當場重解同一份帳單、逐欄重現
//    使用者已確認的 AI 答案——重現不了＝不存。存下來的配方天生證明過自己；
//    這也是「配方所得＝使用者當初確認的所得」的機械保證（同 #458 預覽所見＝匯入所得的精神）。
//
// 版本與回滾（William 2026-08-15 裁示、同日翻案、同日第二輪補細部＝**已全部拍板**）：
// 留 1 版（現行＋上一版）、回滾自動；順序＝閘紅先自動退上一版重解（免費）、
// 上一版也紅才送 AI 重生。儲存與接線＝P2-2（本支）、AI 重生＝P2-3。
import { isRealDate, CURRENCIES } from './schema.js';
import { squash, parseAmount, splitAmount, accountSuffix, isMaskedAccount, UNKNOWN_CURRENCY, makeCurrencyTable, MIXED_CURRENCY_MSG } from './bank-statement.js';

/** @typedef {import('./bank-statement.js').BankTx} BankTx */
/** @typedef {{x:number, w?:number, s:string}} Cell */
/** @typedef {{y:number, cells:Cell[]}} BLine */

/**
 * 配方比對的**同一把尺**：先 NFKC 正規化、再去空白。「**認版面**」路徑上每一個
 * 「配方槽位 ↔ 帳單原文」的比對點，兩邊都過它。⚠️ **參考日整段不在射程內**（見下方④）。
 *
 * **為什麼要 NFKC**：PDF 文字層會印**相容字**——康熙部首 `⾦`(U+2FA6) 與正常的 `金`(U+91D1)
 * 看起來一模一樣、位元組不同；全形數字 `１２３` 與 `123` 同理。AI 產配方時輸出的多半是正規字，
 * 於是暗號永遠對不上帳單原文。這種失敗**不會有任何錯誤訊息**：配方認不得版面＝當作沒有配方＝
 * 每個月照舊送一次 AI，「學一次、之後免費」對那些銀行等於不存在。
 *
 * **為什麼是「NFKC 先、去空白後」**：有一族字元自己不是空白、NFKC 之後會**生出**空白
 * （`¯`(U+00AF)、`‾`(U+203E)、`゛`(U+309B) 等）。反過來做，那個空白會留在字串裡＝比對照樣
 * 對不上，等於只做了一半。⚠️ 誠實：這個順序差別今天只在本尺自己的考題上分得出勝負
 * （真帳單要同時出現這一族字元與拆字空白才會踩到），寫成這個順序是不想留一個知道會壞的洞。
 *
 * ⚠️⚠️ **射程＝只有「認版面」那一段（誠實劃界；兩輪審查各打掉一次擴張）**：
 * 這把尺只准活在**認版面的比對**上——暗號、銀行身分、區段／收尾錨點、表頭的識別與座標、
 * 配方自己的兩道防撞名、出生對照的等值與位置約束。**四處刻意不過它，而且都是界線不是遺漏**：
 *  ①**值層**（`parseAmount`／`DATE_PARSERS`／`isMaskedAccount`）：與內建範本共用實作，改了就是
 *    改台新的 bankRef。代價＝值層印相容字（例如全形數字的金額）的帳單，交易列認不得 ⇒ 拒解退 AI
 *    （fail-closed，不是錯資料）。
 *  ②**引擎輸出的四個文字欄**（label／帳戶 note／summary／交易 note）：理由三條，寫在
 *    `parseWithRecipe` 裡 label 那一段（原文留底契約／精準去重鍵／帳號身分）。四欄**各有樣本**
 *    的保存型考題見 `test/parse-recipe.test.js`（r3#2 抓到原本只守其中兩欄）。
 *  ③**出生驗收 `recipeReproduces` 的文字比對**：單獨放寬會讓去重鍵分叉，必須與分類/去重那一層
 *    一起做（落點見 `softEq` 那一段）。
 *  ④**參考日整段**（錨點定位＋日期掃描）：**維持 main 原狀、走舊尺**——William 2026-08-29
 *    裁示「甲」。把這把尺套進去要算**位置**，而位置一碰正規化就歪：Codex #523 連續四輪各抓到
 *    一種歪法，每一種都是「main 讀得到、改版讀不到或讀錯」。四種歪法逐條列在
 *    `parseWithRecipe` 參考日那段——**那段是給下一個想動它的人看的，別再走一次**。
 * ⚠️ **殘餘（誠實）**：NFKC 不保證「子字串關係」在正規化後仍成立——暗號結尾的基字，若文件裡
 * 緊跟著組合附標，兩邊正規化後可能合成成另一個字。**本支不支援這種形、也沒有量測過真帳單
 * 有沒有**（原本這裡寫「CJK 帳單沒有這種形」——那是替真實帳單下的保證，沒有量測撐著，
 * Codex #523 r5#2 點名）。
 * @param {unknown} s
 */
export const recipeNorm = (s) => squash(String(s || '').normalize('NFKC'));

/**
 * 「這段文字裡有沒有這個東西」＝**舊尺或新尺任一命中**（William 2026-08-29 裁示「甲」）。
 *
 * ⚠️ **為什麼一定要 `舊尺 || 新尺`，不能只換成新尺**：我一路假設「新尺 ⊇ 舊尺」，**那不成立**。
 * NFKC 會把**跨格相鄰**的字合成掉（欄名尾字 `A` 與下一格開頭的組合附標 U+030A 併成 `Å`），
 * 於是有些東西**舊尺認得、新尺反而不認得**。只換成新尺 ⇒ 我們會在 main 停下來的地方繼續往前，
 * 實測後果是**銀行身分牆由 fail-closed 變 fail-open**、概要多讀帳戶、靜默漏掉一筆交易
 * （Codex #523 r6）。⇒ 用 `舊尺 || 新尺`＝**新尺只增不減，main 認得的我們一定也認得**。
 *
 * ⚠️⚠️ **拒收型的守門要用「任一尺看到衝突就拒收」**（`oldConflict || newConflict`）——與辨識**對稱**。
 * 我曾在這裡寫「拒收只走新尺＝比 main 嚴」，**那句是錯的**（Codex #523 r7 三個反例推翻）：兩把尺
 * **不可比較**，舊尺看得到的衝突新尺可能看不到 ⇒ 變成 **main 拒收、我們放行**。實測後果：
 * 台幣帳戶被標成 USD、歧義表頭下的 1,200 被當成支出解出來。⇒ 歧義守門（區段錨點互為子字串、
 * 欄位角色撞名、表頭同名格重複、出生對照的等值與位置）**一律兩把尺都看**。
 * ⚠️ `checkSlot` 與通用機構詞那類**單槽內容檢查**不在此列（它們量的是「這個槽拿去比對時長什麼樣」，
 * 不是兩個東西之間的衝突）——理由各自寫在該處，不由一句總括話背書。
 * @param {string} text @param {unknown} needle
 */
export const hitEither = (text, needle) =>
  squash(text).includes(squash(String(needle ?? ''))) || recipeNorm(text).includes(recipeNorm(needle));

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
 * @param {number=} minLen 最短長度（版面錨點與金額欄標題＝2：1 字錨點會在交易列上誤觸發）。
 * ⚠️ **兩把尺都量、任一太短就拒收**——理由見該行註解。
 */
function checkSlot(path, v, maxLen, errs, minLen = 1) {
  if (typeof v !== 'string') { errs.push(`${path}：必須是文字`); return; }
  if (v !== v.trim() || v.length === 0) { errs.push(`${path}：不可為空或帶頭尾空白`); return; }
  if (v.length > maxLen) { errs.push(`${path}：超過 ${maxLen} 字上限`); return; }
  const q = recipeNorm(v);
  if (q.length === 0) { errs.push(`${path}：去空白後為空`); return; }
  // ⚠️ **兩把尺任一太短就拒收**（Codex #523 r8）：只量新尺時，`㈱`／`⑴`／`№`／`㍿` 這類
  //   **一個字元**會被 NFKC 展開成 `(株)`／`(1)`／`No`／`株式会社` ⇒ 長度過關 ⇒ **main 拒收、我們放行**。
  //   而 minLen 存在的理由正是「一字錨點會在交易列或常見版面文字上誤觸發」。⇒ 與其他守門對稱：
  //   拒收一律「任一尺看到問題就拒收」。⚠️ 我原本在這裡寫「量真正拿去比對的那個字串」並補了一題
  //   要求 `㈱` 合格——**那題在保護一個相對 main 的放寬**，已一併改口。
  if (squash(v).length < minLen || q.length < minLen) errs.push(`${path}：至少 ${minLen} 個字（太短＝什麼版面都認）`);
  if ([...q].filter(ch => /\p{Nd}/u.test(ch)).length >= 4) errs.push(`${path}：數字達 4 位以上（疑似帳單內容，拒收）`);   // \p{Nd}＝任何數字系統（r14 建議：阿拉伯-印度數字 ٢٠٢٦ 繞過 ASCII 範圍檢）
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
  // bank 不可只有「通用機構詞」（r11#4：bank='銀行' 在甲方銀行出生、套到乙方銀行照樣命中
  // ＝機構戳與跨行去重全毀）。列舉台灣常見機構類詞（誠實劃界：非窮舉、殘餘記契約）。
  if (typeof r.bank === 'string') {
    const GENERIC_FI = ['國際商業銀行', '商業銀行', '信用合作社', '信合社', '商銀', '銀行', '郵局', '農會', '漁會', '證券', '人壽', '分行', '總行'];
    // 走 `recipeNorm` 的理由＝**這支檔的文字正規化只留一個實作**（原本這一行自己手寫了一份
    // 「先 squash 再 NFKC」的順序，兩份遲早會漂）。⚠️ 刻意**不**宣稱行為等價——我構造不出會
    // 轉紅的案例，但「構造不出」不是保證（鐵則 10；Codex #523 r4#4 點名）。
    const core = GENERIC_FI.reduce((v, w) => v.split(w).join(''), recipeNorm(r.bank));
    if (core.length === 0) errs.push('bank：只有通用機構詞（哪一家都能匹配，拒收）');
  }

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
        // 幣別＝**CURRENCIES 白名單**或 BY-CODE（r11#3：任意三碼大寫＝零內容單槽直通路——
        // 「ATM」能塞進來且三關全過；白名單同時是下游支援範圍＝雙重理由）。
        // 先驗 typeof（r6 建議：String(['TWD'])＝'TWD'——陣列包裝會矇混過 regex）
        if (typeof s.currency !== 'string' || (s.currency !== 'BY-CODE' && !CURRENCIES.includes(s.currency))) {
          errs.push(`summary.sections[${i}].currency：只准支援清單內的幣別或 BY-CODE`);
        }
      });
    }
    checkSlot('summary.endAnchor', r.summary.endAnchor, RECIPE_LIMITS.anchor, errs, 2);
    // 區段錨點兩兩不可互為子字串（r3#1：「帳戶」⊂「外幣帳戶」＋引擎取第一個命中＝外幣區被
    // 先命中的 TWD 段吃掉、外幣帳戶用台幣入帳而強閘照樣放行——拒收重疊＝fail-closed，
    // 有這種標題的版面孵不出配方、照走 AI）
    if (Array.isArray(r.summary.sections)) {
      // ⚠️ **兩把尺都看**（Codex #523 r7#1）：只看新尺時，舊尺才看得到的重疊會被放行，而引擎的
      //   `hitEither` 會用舊尺命中先列的短錨點 ⇒ 外幣區被台幣段吃掉（實測帳戶 currency 變 USD）。
      const qsN = r.summary.sections.map(s => recipeNorm(s?.anchor));
      const qsO = r.summary.sections.map(s => squash(String(s?.anchor ?? '')));
      for (let i = 0; i < qsN.length; i++) for (let j = 0; j < qsN.length; j++) {
        if (i !== j && ((qsN[i] && qsN[j] && qsN[i].includes(qsN[j])) || (qsO[i] && qsO[j] && qsO[i].includes(qsO[j])))) {
          errs.push(`summary.sections[${i}]／[${j}]：區段錨點互為子字串（命中歧義，拒收）`);
        }
      }
    }
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
    // **全部**文字角色（金額三欄＋備註＋忽略欄）兩兩不可同名（過同一把尺後判——findX 也用它，
    // 兩處尺不同＝「驗過不同名」的兩個角色在表頭上抓到同一格）——撞名＝findX
    // 抓到同一格：忽略欄撞支出欄名＝整欄支出被吃掉、備註撞存入欄名＝存款變備註
    // （r6#2 實測：翻向後餘額鏈照樣自洽、強閘放行）。
    // ⚠️ 撞名禁令**擋不住 x 重疊**（r7#1 反例推翻了 r6 的「名字不同 ⇒ x 互斥」論證：
    // BLine 允許兩個不同的格共用同一個 x）——座標互斥由引擎在表頭解析後自驗（roleXs 檢查）。
    const hs = [r.detail.headerOut, r.detail.headerIn, r.detail.headerBalance, r.detail.headerNote,
      ...(Array.isArray(r.detail.headerIgnore) ? r.detail.headerIgnore : [])]
      .filter(h => typeof h === 'string');
    // ⚠️ **兩把尺都看**（Codex #523 r7#1 同族）：`findX` 接受「精確／舊尺／新尺」任一相等，
    //   撞名稽核只看新尺＝舊尺才看得到的撞名被放行，而 findX 照樣把兩個角色綁到同一格。
    if (new Set(hs.map(recipeNorm)).size !== hs.length || new Set(hs.map(squash)).size !== hs.length) {
      errs.push('detail：欄位角色標題不可相同（含備註與忽略欄）');
    }
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
/** 從 squash 後的整列文字裡撈出所有日期（轉 ISO）。⚠️ 呼叫端**必須先切到錨點之後再餵進來**：
 * 切片會重設 `roc-slash` 那條左界，而那個左界是判準的一部分（見 parseWithRecipe 參考日那段）。 */
const DATE_SCANNERS = {
  'west-slash': (/** @type {string} */ t) => [...t.matchAll(/(\d{4})\/(\d{2})\/(\d{2})/g)].map(m => `${m[1]}-${m[2]}-${m[3]}`),
  'roc-slash': (/** @type {string} */ t) => [...t.matchAll(/(?<!\d)(\d{2,3})\/(\d{2})\/(\d{2})/g)].map(m => `${String(Number(m[1]) + 1911).padStart(4, '0')}-${m[2]}-${m[3]}`),
};

/** 這份帳單像不像這張配方講的版面：暗號（過 `recipeNorm`）必須**全部**出現在全文。
 * 正規化**逐列做、換行保留**（預審①：整份一起做會把換行吃掉＝暗號可由前列列尾＋後列列頭
 * 跨列誤拼，別家版面被錯配進來）。
 * ⚠️ **兩邊都要過同一把尺**：只有一邊做比兩邊都不做更糟——那把尺會把一邊的相容字磨掉、另一邊
 * 留著，於是「暗號抄得越忠實，越認不得自己出生的那份帳單」。
 * @param {BLine[]} lines @param {ParseRecipe} recipe @param {{ruler?: 'old'}} [opts] */
export function recipeMatches(lines, recipe, opts = {}) {
  // ⚠️ **逐列做、換行保留**（預審①：整份一起做會把換行吃掉＝暗號可由前列列尾＋後列列頭跨列誤拼）。
  // ⚠️ **舊尺或新尺任一命中**（裁示「甲」，理由見 `hitEither`）：只用新尺會讓 main 認得的版面認不得。
  // ⚠️ `opts.ruler === 'old'`＝**只用舊尺**（逐字＝main）。呼叫端要它是因為「哪一張規則卡獲勝」
  //   也是一種「是哪一個」（見 `recipeBankRoute` 的兩趟掃描）：聯集把候選集合變大之後，
  //   **卡片列序**會決定答案 ⇒ main 選不到的卡可能搶先勝出。Codex #523 r10 實測：帳單印連字
  //   `Oﬃce`、兩張卡都能完整解析且都過強閘時，聯集版依列序選到前卡 ⇒ 真台幣戶被標成 USD ⇒
  //   那戶的交易被當外幣**不匯入** ⇒ 現金流漏帳。
  const textOld = lines.map(l => squash(l.cells.map(c => c.s).join(''))).join('\n');
  if (opts.ruler === 'old') return recipe.docAnchors.every(a => textOld.includes(squash(a)));
  const textNew = lines.map(l => recipeNorm(l.cells.map(c => c.s).join(''))).join('\n');
  return recipe.docAnchors.every(a => textOld.includes(squash(a)) || textNew.includes(recipeNorm(a)));
}

/** 依配方的列判準組「這一列是不是交易列」（r9#1 銀行身分綁定與出生位置約束共用＝單一實作）。
 * @param {ParseRecipe} recipe */
const makeIsTxRow = (recipe) => {
  const toDate = DATE_PARSERS[recipe.dateFormat];
  return (/** @type {Cell[]} */ c) => recipe.detail.rowIdent === 'acct-date'
    ? (isMaskedAccount(c[0]?.s) && !!toDate(c[1]?.s || ''))
    : (!isMaskedAccount(c[0]?.s) && !!toDate(c[0]?.s || ''));
};

/** 結構性失敗（版面跟配方講的對不上）＝退回 AI 的機器判準；訊息不帶任何帳單內容。 */
const parseFail = (/** @type {string} */ why) =>
  Object.assign(new Error(`配方解不動這份帳單（${why}）`), { status: 400, code: 'recipe_parse_failed' });

/**
 * 用配方解一份帳單（座標列 → 與模板／AI **共用 ParsedBankFull 原有五個核心欄位**＋一個**多出來的診斷鍵**
 * `unclaimedAccountRows`——Codex #524 r1#1：回傳物件的可列舉鍵 5→6、JSON.stringify 會多出它，
 * 所以**不可**宣稱「零行為改變／輸出逐字相同」；可誠實宣稱的是**正式路徑的裁決、金額、db 寫入
 * 與 HTTP 回應不變**（下游逐一核對過：預覽整包只留在記憶體確認票、HTTP／db 走白名單投影、
 * recipeReproduces 逐欄明列不掃未知鍵））。
 * 幾何機關與 lib/bank-statement.js 同源泛化：右緣分欄、running 餘額覆寫方向、孤兒備註歸位。
 * 正確性不在此層保證——呼叫端（P2-2）必須讓它過 **AI 級強閘**（level strong＋台幣帳戶零未驗＝0；
 * 與模板弱閘照舊放行**刻意相反**：配方跟 AI 一樣是機器生的，比照 AI 待遇）。
 * @param {BLine[]} lines @param {ParseRecipe} recipe
 * @returns {{ bank:string, referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[], accountCurrency:Record<string,string>, transactions:BankTx[], unclaimedAccountRows:number }}
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
  const curTable = makeCurrencyTable();
  const accountCurrency = curTable.map;
  /** date-first 的「恰一帳戶」數**概要帳戶列數**（r8#4 取代 r2#4 的身分 Set）：鍵數與身分數
   * 都會被「同遮罩同幣別的兩個不同帳戶」塌成一（甲戶/乙戶同遮罩＝真實可能），列數不會。 */
  let summaryAccountRows = 0;
  /**
   * 概要掃描窗裡「印著遮罩帳號、卻不屬於配方宣告的任何區段」的列數。
   * ⚠️ **只量不擋（William 2026-08-26 裁示「甲」）——正式路徑的裁決／金額／db 寫入／HTTP 回應都不看它，
   *   也刻意沒有生產端讀者**（它讓回傳形狀多一鍵＝模組邊界上「行為」有變，宣稱時要分開講——r1#1）。
   * 它存在的唯一理由＝把「配方看不到的東西有多少」變成可量測的數字，等 D 校準拿得到真帳單時
   * 直接讀，而不是再猜一次。**不可**把它接成拒解／退 AI／標疑似過期——2026-08-26 做這三件事的
   * 三份具體設計各自在隔離副本實測被打掉（打掉的是那三份設計；新設計要重測、不是免審——
   * 理由見本檔下方「配方的幣別歸屬：兩個已知的洞」那段）。
   * ⚠️ **這個數字本身是雜訊很大的**（誠實劃界，不要拿它當「有問題」的證據）：頁首重印帳號、
   *   信用卡額度區、頁尾小計、配方本來就不打算解的定存小表——全都會被算進來。它量的是
   *   「配方沒解釋到」，不是「配方解錯了」。
   */
  let unclaimedAccountRows = 0;
  /** @type {string|null} */
  let referenceDate = null;
  let refLocked = false;   // 錨點行一給出日期＝定案（含定成 null）——壞目標不可由後面的行遞補（r12#2）
  /** @type {{currency:string}|null} */
  let section = null;
  /** @type {string|null} */
  let pendingCurrency = null;
  const refAnchor = recipe.refDate.strategy === 'none' ? null : squash(recipe.refDate.anchor || '');   // ⚠️ 舊尺——參考日整段不碰（理由見下方那段）
  const endAnchorOld = squash(recipe.summary.endAnchor), endAnchorNew = recipeNorm(recipe.summary.endAnchor);
  const isMoneyCell = (/** @type {string} */ s) => /\$/.test(s) || parseAmount(s) != null;
  // 幣別「長相」＝衝突偵測的判準（r22#1：EUR 是真幣別、只是不在支援清單——用白名單做偵測
  // 會讓它隱形、歐元帳戶列繼承 TWD＝歐元交易進台幣現金流且強閘照綠）；
  // ⚠️ 偵測降到 **token 層**（r23#1：PDF 常把幣別與標籤抽成同一格——「EUR 活存」整格比對
  // 看不到 EUR）：NFKC 後抓「前後都不是大寫字母」的三碼大寫。代價（誠實）＝帳戶列出現
  // 「ATM」這類三碼大寫縮寫會誤判衝突、配方孵不出來（fail-closed、照走 AI）。
  // 「採用」（sticky 標題設幣別）仍用整格 CURRENCIES 白名單（r14 建議：QQQ 不可被採用）。
  const cellCodes = (/** @type {string} */ t) =>
    [...String(t).normalize('NFKC').matchAll(/(?<![A-Z])[A-Z]{3}(?![A-Z])/g)].map(m => m[0]);
  // 明細表頭判準（概要迴圈也要用：r6#1——概要區若在明細表頭出現時**還沒收尾**，明細交易列
  // 會被概要迴圈當帳戶列重新寫入 accountCurrency＝r5 權威牆被自己餵毒（陌生帳戶登記成 TWD、
  // 自洽入帳且強閘照綠）。收尾列缺席/改名的版面＝拒解退 AI；概要掃描也只掃到明細表頭為止）。
  // ⚠️⚠️ **表頭判準有兩把尺，但只有一份判準**（Codex #523 r5→r6 換來的形狀）：三個欄名與
  //   `every/includes` 只寫一次，尺當參數傳（複製一份就會漂——r6 點名）。
  //   ・`isHeaderOld`＝main 認得的表頭（舊尺）。**向後相容邊界：main 會停的地方我們也要停。**
  //   ・`isHeaderNew`＝本支新增的辨識力（新尺；相容字表頭）。
  //   ・**結構邊界一律 `old || new`**——銀行身分牆、概要收尾（含「未收尾就進明細」那道 throw）、
  //     明細起點三處都用它。⚠️ r6 實測：只用新尺時，`old=true / new=false` 那一格（NFKC 把
  //     **跨格相鄰**的字合成掉，例如欄名尾字 `A` 與下一格開頭的組合附標 U+030A 併成 `Å`）會讓
  //     head 跨過 main 的結構邊界繼續解析——**銀行身分牆由 fail-closed 變 fail-open**、概要多讀
  //     一個帳戶、甚至靜默漏掉一筆交易。那不是「新尺比較寬鬆」，是**比 main 還危險**。
  //   ・參考日的 guard 只看 `old`（理由見概要迴圈那段）——四格真值表因此才完整。
  const HEADER_NAMES = [recipe.detail.headerOut, recipe.detail.headerIn, recipe.detail.headerBalance];
  const headerHit = (/** @type {string} */ t, /** @type {(s: unknown) => string} */ rule) => {
    const j = rule(t);
    return HEADER_NAMES.every(n => j.includes(rule(n)));
  };
  const isHeaderOld = (/** @type {string} */ t) => headerHit(t, squash);
  const isHeaderNew = (/** @type {string} */ t) => headerHit(t, recipeNorm);
  const isHeaderRow = (/** @type {string} */ t) => isHeaderOld(t) || isHeaderNew(t);
  // 銀行身分綁定（r8#2→r9#1→r10#1 三度收緊）：配方的 bank 會變成機構戳與 bank2 去重鍵的
  // 機構段——冒名解析＝跨行去重與帳戶歸屬全錯。r9 版「非交易列」仍被**換行的續行文字**冒領
  // （孤兒備註列不是交易列）——r10 收緊＝銀行名必須出現在**第一個明細表頭之前**的版面區域
  // （標題/概要區；交易列與其續行全在表頭之後＝結構性排除）。
  {
    let bankSeen = false;
    for (const l of lines) {
      const t = l.cells.map(c => c.s).join('');
      if (isHeaderRow(t)) break;   // old||new：main 會停的地方我們也要停（r6：只用新尺＝身分牆 fail-open）
      // 含遮罩帳號的列＝帳戶列、不算身分證據（r28#2：乙行概要的「甲方自動扣款專戶」標籤
      // 會讓甲方配方冒領乙行帳單——銀行名必須來自**標題類**列）
      if (l.cells.some(c => isMaskedAccount(c.s))) continue;
      if (hitEither(t, recipe.bank)) { bankSeen = true; break; }   // 舊尺或新尺（裁示「甲」）
    }
    if (!bankSeen) throw parseFail('銀行身分對不上');
  }

  for (const line of lines) {
    const cells = line.cells.map(c => c.s);
    const rawJoinedLine = cells.join('');
    const plainJoined = squash(rawJoinedLine);   // ⚠️ 舊尺——參考日專用（辨識點一律走 hitEither／isHeaderRow）
    // ⚠️ **參考日要跑在「因表頭而收尾」之前，但只在舊尺不認為這是表頭時**（Codex #523 r5#1）：
    //   新尺會**提早**認出相容字表頭並 break，於是舊尺的參考日區塊根本沒機會跑 ⇒ 實測同一份帳單
    //   main 讀到 2026-06-30、只換尺讀 null。修好區塊**內部**還不夠，控制流也要顧。
    //   這個 guard 讓每一種情況都對得上 main：舊尺表頭 ⇒ 兩邊都不讀（main 先 break）；
    //   兩邊都不是表頭 ⇒ 行為相同；**新尺才認得的表頭** ⇒ main 會繼續往下讀參考日，我們在收尾前
    //   先讀，於是也讀得到。
    //   ⚠️ 誠實劃界：錨點若落在**相容字表頭之後**（明細區），main 會一路掃進去撿到那裡的日期、
    //   我們則已收尾 ⇒ null。那是刻意的——參考日本來就該住在概要區，撿明細區的日期正是 r10#1 那族病。
    if (!isHeaderOld(rawJoinedLine) && !refLocked && referenceDate == null && refAnchor) {
      // ⚠️⚠️ **參考日整段維持 main 原狀＝走舊尺（只 squash），這是 William 2026-08-29 的裁示**
      //   （「甲：把參考日整段退回，這支只留辨識層」），**不是還沒做**。
      //   理由是實測出來的：把這把尺套進來要算「錨點在哪裡結束、日期從哪裡開始掃」＝**位置**，
      //   而位置一碰正規化就歪，Codex #523 連續四輪各抓到一種歪法，每一種都是
      //   **main 讀得到、改版讀不到或讀錯**：
      //     r1 多出候選（全形日期變得掃得到 ⇒ anchored-date 換人：2026-06-30 → 2099-05-06）
      //     r2 吃掉候選（`２115/05/06` 經 NFKC 黏成四位數 ⇒ 民國日期整顆消失）
      //     r3 切片本身是判準（錨點以 ASCII 數字結尾、日期緊鄰 ⇒ 左界沒被重設，候選被吃掉）
      //     r4 切點若在去空白後的字串上算 ⇒「基字＋空白＋組合附標」被合成掉，錨點找不到
      //   而它換到的東西是「**連錨點那幾個字也印成相容字**時，餘額日期也讀得到」——
      //   那個情境**沒有真帳單量測撐著**，而錯的那一型會把餘額日期寫成未來日 ⇒ 之後每份真帳單
      //   都被判 stale ⇒ **該帳戶的餘額從此靜靜不再更新**。用「可能沒人需要」換「看不出來的錯」，
      //   不划算。⇒ **這一段一個字不動。** 要做請單獨一支 PR，並且先拿真帳單量測。
      //   代價（誠實）：帳單把參考日錨點印成相容字時 ⇒ `referenceDate=null` ⇒ **只跳過餘額更新，
      //   交易明細照樣匯入**（同規則 1a「寧可 null」；與 main 完全相同，不是本支新增的限制）。
      const at = plainJoined.indexOf(refAnchor);
      if (at >= 0) {
        // **先取位、再驗真**（r12#2：先 filter(isRealDate) 再取位＝「結算基準日:2026/13/31
        // 列印日:2027/01/02」的壞目標被濾掉、撿到列印日——目標位置的日期不合法就是 null，
        // 不可順位遞補）。anchored-date＝錨點後第一個；period-end＝恰兩個取第二個
        // （1 個／3 個以上＝不確定）。找到任何日期＝就地鎖定（不再往後掃別的錨點行）。
        const ds = scanDates(plainJoined.slice(at + refAnchor.length));
        if (ds.length > 0) {
          refLocked = true;
          const target = recipe.refDate.strategy === 'anchored-date' ? ds[0]
            : (ds.length === 2 ? ds[1] : null);
          referenceDate = (target && isRealDate(target)) ? target : null;
        }
      }
    }
    if (isHeaderRow(rawJoinedLine)) {
      if (section) throw parseFail('概要區未收尾就進明細');
      break;
    }
    // ⚠️⚠️ **這一格是「是哪一個」不是「是不是」——聯集不夠用**（Codex #523 r9）：
    //   同一列可能「A 段只有舊尺命中、B 段只有新尺命中」（半形片假名 `ｶﾞ`／韓文相容 `ㄱㅏ` 都做得到），
    //   而 `.find()` 取配方**列序**第一個 ⇒ main 選 B（TWD）、聯集版選 A（USD）。
    //   實測後果不只是標籤：那個真台幣帳戶被統計成外幣（`foreignAccountsSkipped`），
    //   `bank-import` 會把它的交易**當外幣直接略過** ⇒ **現金流漏帳**，而強閘仍是 strong。
    //   同一族還有「新尺 section 排在舊尺 endAnchor 之前」⇒ main 收尾、我們反而重開一段。
    //   ⇒ **裁決一律舊尺優先（＝main 的答案），新尺只在舊尺沒有裁決時補上；兩把尺裁決不同＝歧義拒解。**
    //   （辨識取聯集只對布林成立；一旦要在候選之間挑一個，聯集會改寫 main 的答案。）
    const secOld = recipe.summary.sections.find(s => plainJoined.includes(squash(s.anchor)));
    const secNew = recipe.summary.sections.find(s => recipeNorm(rawJoinedLine).includes(recipeNorm(s.anchor)));
    const endOld = !!(endAnchorOld && squash(cells[0] || '').startsWith(endAnchorOld));
    const endNew = !!(endAnchorOld && recipeNorm(cells[0]).startsWith(endAnchorNew));
    const decOld = secOld ? 'sec' : (endOld ? 'end' : null);
    const decNew = secNew ? 'sec' : (endNew ? 'end' : null);
    // 兩把尺都有裁決、而且裁的不是同一段（含「一邊開段、一邊收尾」——那時一邊是 undefined）＝拒解
    if (decOld && decNew && secOld !== secNew) throw parseFail('同一列在兩把尺下的區段裁決不同');
    // ⚠️ 上一行擋掉之後，剩下的情形**兩把尺不可能給出不同的段**，所以下面誰在前都一樣
    //   （我原本寫「舊尺優先」的長條件，逐條驗過與這個短式**邏輯等價**＝那是沒有考題能分辨的冗餘，拿掉）。
    const hit = secOld || secNew;
    if (hit) { section = { currency: hit.currency }; pendingCurrency = null; continue; }
    if (endOld || endNew) { section = null; continue; }
    if (!section) {
      // 不屬於任何宣告區段的列＝配方看不到它。只量不擋（裁示「甲」；裁決／金額／db／HTTP 不看它）。
      if (cells.some(isMaskedAccount)) unclaimedAccountRows += 1;
      continue;
    }
    if (section.currency === 'BY-CODE' && !cells.some(isMaskedAccount)) {
      // sticky 幣別標題三分法＝bank-statement.js r1 收緊的同一套（認得＝設、匯率/空列＝不動、看不懂＝清）
      // 標題辨識用 **CURRENCIES 白名單**（r14 建議：任意三碼大寫會把「QQQ」之類的雜訊當幣別；
      // 白名單外的三碼＝看不懂 ⇒ 落 UNKNOWN 哨兵、下游 unsupported 跳過）
      const curs = [...new Set(cells.map(c => c.trim()).filter(c => CURRENCIES.includes(c)))];
      if (curs.length === 1) { pendingCurrency = curs[0]; continue; }
      const meaningful = cells.map(c => c.trim()).filter(Boolean);
      const rateOrBlank = meaningful.length === 0 || meaningful.every(c => /^[\d.,%$]+$/.test(c));
      if (!rateOrBlank) pendingCurrency = null;
      continue;
    }
    if (section.currency !== 'BY-CODE' && !cells.some(isMaskedAccount)) {
      // 固定幣別區出現**矛盾的幣別標題**＝拒解（r14#2：出生月只有台幣、次月同區冒出獨立
      // 「USD」列＋美元帳戶——固定 TWD 不反應＝美元交易走台幣入帳且強閘照綠。
      // 出生三關看不到後續月份、只有引擎自己能擋）
      const secCur = section.currency;   // 先取值——閉包會讓 let 的 null 窄化失效（tsc）
      if (cells.some(c => cellCodes(c).some(code => code !== secCur))) {
        throw parseFail('固定幣別區出現矛盾的幣別標題');
      }
    }
    const accIdx = cells.findIndex(isMaskedAccount);
    if (accIdx < 0) continue;
    // 帳戶列自帶的幣別格也要驗矛盾（r15#1：r14 的檢查只掃「沒有帳號的獨立標題列」——
    // 「美元活存｜帳號｜USD｜$150」直接印在帳戶列上＝固定 TWD 區照樣把它蓋成台幣入帳）
    if (section.currency !== 'BY-CODE') {
      const secCur2 = section.currency;
      if (cells.some(c => cellCodes(c).some(code => code !== secCur2))) {
        throw parseFail('固定幣別區出現矛盾的幣別標題');
      }
    } else {
      // BY-CODE 帳戶列自帶的明確幣別格必須與 sticky 一致（r16#2＝r15#1 同族漏口：
      // sticky=JPY、帳戶列印著 USD ⇒ 原版把帳戶標成 JPY、USD 掉進 note＝美元餘額被建成日圓）
      const rowCodes = [...new Set(cells.flatMap(c => cellCodes(c)))];
      if (rowCodes.length > 1 || (rowCodes.length === 1 && rowCodes[0] !== pendingCurrency)) {
        throw parseFail('帳戶列幣別與區段幣別不一致');
      }
    }
    const suffix = accountSuffix(cells[accIdx]);
    if (!suffix) continue;
    const masked = String(cells[accIdx]).replace(/\s/g, '');
    // ⚠️⚠️ **引擎輸出的文字欄一律不過 `recipeNorm`——這是一條界線，不是還沒做**
    //   （精確口徑：共同邊界是「不過 `recipeNorm`」，**各欄維持自己既有的空白語意**——這三欄
    //    squash、交易備註連 squash 都不做。Codex #523 r3#2 指出原本寫「一律只 squash」不精確。）
    //   （William 2026-08-28 先裁「乙＝輸出也正規化」，Codex #523 r2 打掉三條之後於 08-29
    //   改裁「縮回只修辨識層」）。同一個字串同時是**三種東西**，而它們對正規化的要求互相衝突：
    //   ①**帳單原文留底**：`bankSummary`／`bankNote` 的契約逐字寫著「一字未改」（`lib/types.js`）。
    //   ②**精準去重鍵**：`bankRefBase` 把 summary/note 拼進 `bankRef`；單邊正規化 ⇒ 同一筆交易
    //     走 AI 路線與走配方路線的鍵不同 ⇒ 重傳時精準去重失效，而 `skipSimilar` 是**選配**、
    //     疑似重複擋不住重複匯入。
    //   ③**帳號身分的來源**：`noteAccountSuffixes` 從備註抽自有末碼。NFKC 會把 `①` 折成 `1`
    //     ⇒ `****①234` 變 `****1234` ⇒ 一般支出被判成內轉 ⇒ **真支出從現金流消失**（r2 實測）。
    //     `lib/bank-statement.js` 的 `foldWidth` 早就為了同一個理由拒絕對帳號整串做 NFKC
    //     （#504 r8#4）——輸出端做 NFKC 等於從另一個入口把那條界線打開。
    //   ⇒ 正規化只准活在**比對**上（認版面、找錨點、找表頭），不准流進**存下來的字**。
    //   ⚠️ 已知的既有缺陷（**不是本支造成、也不由本支修**）：帳單印相容字時，`classifyBankTx`
    //   的關鍵字（`/卡費|信用卡款/` 等）認不得 ⇒ 繳卡費掉進「其他/未分類」。實測 main 上就到得了
    //   （AI 忠實照抄相容字時，暗號兩邊同形、舊尺照樣命中、出生驗收照樣過）。要修是修**分類那一層**
    //   （比對用正規形、原文不動），動到錢的核心＝自己一支 PR。
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
    curTable.note(masked, currency);   // 同號多幣別＝哨兵（與模板／AI 同一份判準，見 bank-statement.js 的表物件）
    summaryAccountRows += 1;
    if (balance == null) continue;   // 餘額空白＝不進餘額更新清單（幣別已記）——同模板語意
    const note = squash(after.filter(c => c !== balCellS && !isMoneyCell(c)).join(' '));
    accounts.push({ suffix, masked, balance, currency, label, note });
  }

  // 同號混台幣＋外幣＝三條路各自擋（射程＝各自看得到的範圍；見 bank-statement.js makeCurrencyTable 的說明）。
  // ⚠️ **終局訊號、不是「這張配方不合用」**（Codex #517 r6#1）：`recipeBankRoute` 對解析錯是
  //   `catch { continue; }`（退下一版／下一張），所以用一般的 recipe_parse_failed 會被吞成 miss ⇒
  //   preview 照舊當「範本認不得」去試 AI ⇒ AI 只要漏掉外幣區就把它當純 TWD 接受並匯入（實測
  //   aiAccepted:true、level:strong）。混幣是**版面事實**，看到的那一方說了算——用模板同一個
  //   終局碼 `bank_mixed_currency`，讓既有的「不落到規則卡／AI 救援」那兩道排除直接生效。
  curTable.finalize();   // 等價印法互看統一算一次（見 makeCurrencyTable）
  if (curTable.hasMixedTwd()) throw Object.assign(new Error(MIXED_CURRENCY_MSG), { status: 400, code: 'bank_mixed_currency' });
  // ⚠️⚠️ **配方的幣別歸屬：兩個已知的洞（2026-08-26 調查、William 裁示「只量不擋」）** ⚠️⚠️
  //   上面那道牆的射程＝「配方解出來的那張幣別表」。配方對某一列的幣別歸屬可能**根本沒看到**，
  //   也可能**看到但歸錯**——兩種都讓外幣以台幣入帳，而牆兩種都看不見：
  //   ①**未宣告的區段**（Codex #517 r4#1）：配方只描述台幣區、帳單另有外幣區 ⇒ 外幣列走
  //     `if (!section) continue`、整段不存在於幣別表 ⇒ hasMixedTwd() 無從得知。實測：同號混台外幣
  //     被解成純 TWD（accountCurrency={"900300****0363":"TWD"}、imported:1、建 TWD 餘額 1730）。
  //     A/B 已證實是**既有缺口**（main 8bb51fb 與 #517（6ce4056）**原有五個核心欄位逐字相同**；
  //     #524 起另多診斷鍵 unclaimedAccountRows、缺口本身不變），非哨兵批引入。
  //   ②**錨點吞併**（2026-08-26 新測）：`sections.find(s => joined.includes(squash(s.anchor)))` 是**子字串**比對，
  //     而 validateRecipeStrict 只禁止配方**自己的**區段錨點互為子字串（本檔區段錨點兩兩檢查那段）、
  //     不管它對**文件**命中幾列。所以一個通用錨點（例：`帳戶總覽`）會同時命中「新臺幣帳戶總覽區」
  //     與「外幣帳戶總覽區」⇒ 外幣區被**當成台幣區重新開張** ⇒ 每一列都「有被認領」、幣別表也
  //     只有一種幣別 ⇒ 牆全盲。實測輸出＝`{"900100****3301":"TWD","900300****363":"TWD"}`、
  //     `US$500 活期存款`被建成台幣 500 元的帳戶；同一版面換成同號時掉回 recipe_parse_failed
  //     （撞「概要出現重複的帳戶幣別」那道）⇒ 被 recipeBankRoute 吞成 miss ⇒ **落 AI**，正是上面
  //     r6#1 那段說不可以發生的事。⚠️ 中文幣別標籤（`美元活期存款`）不印 ISO 三碼，所以本檔
  //     「固定幣別區出現矛盾的幣別標題」那兩道也不會響。
  //   ⚠️ **為什麼不在這裡補第三道牆**（2026-08-26 的三份提案在各自的隔離副本實測被打掉——
  //     打掉的是**那三份具體設計**，同族變體大概率同病，但新設計要重測、不是免審）：
  //     ・「數未認領的帳號列」＝用 `isMaskedAccount`（只認 `數字****數字`）當尺，比 hasMixedTwd
  //       用的 `acctPatternsIntersect` 窄——連字號／全形星號／完整號／帶字母一律看不見（4–5 種漏放形狀）；
  //       而且它問的是「有沒有被**某個**區段認領」，對洞②完全全盲。
  //     ・誤擋已實證且**無退路**：帳單第二頁頁首重印自己的帳號（真帳單常見）⇒ 本來免費解得動的
  //       帳單變成硬性 400；出生第②關呼叫的是同一支解析器 ⇒ 該版面**永遠孵不出配方**、每期付全額
  //       AI 錢；HOSTED 沒有 AI ⇒ 那份帳單永遠匯不進來。
  //     ・做成終局碼還會跳過 `recipeBankRoute` 的兩層退路（自動退 previous、換下一張卡）＝一張過期卡
  //       毒死整次匯入，與 P2 的成文裁示相反。
  //     ・改在**出生關**要求涵蓋完整（升 RECIPE_FORMAT_VERSION）治不到病：出生第三關 recipeReproduces
  //       在比帳戶數——但比的對象是 **AI 黃金樣本**、不是原帳單（r1#2）：配方不得比 AI 答案少涵蓋，
  //       可是 AI 與配方**同漏一區**時兩邊帳戶數照樣相等＝出生月的涵蓋上限是 AI 答案、不是文件本身。
  //       配方真描述了外幣區時第②關先丟 bank_mixed_currency，新關永遠碰不到。實測 5 種形狀只擋到
  //       1 種。本檔「固定幣別區出現矛盾的幣別標題」那段的 r14#2 早就寫過同一課：
  //       **出生三關看不到後續月份、只有引擎自己能擋**。
  //   ⚠️ 今天的射程（樣本事實、不是結構保證——r1#2）：真帳單量測 0 次（William 三份台新：掛多幣別
  //     的帳號 1 個、同時含台幣的 0 個），且**那三份**走內建範本、不經配方（配方只在範本回
  //     bank_unrecognized 時才誕生）。⚠️ 正式碼會在 AI 匯入後生配方（saveParseRecipe），db 的
  //     parseRecipes 基數**未量測**——不可從樣本推「生產配方張數是 0」。
  //     ⇒ 現況是把界線量出來、寫清楚，等 D 校準拿到真帳單再決定要不要動。計數＝unclaimedAccountRows。

  // ---- 明細（泛化 parseBankDetail）----
  const { rowIdent, headerNote, headerIgnore } = recipe.detail;
  const hOut = recipe.detail.headerOut, hIn = recipe.detail.headerIn, hBal = recipe.detail.headerBalance;
  const soleMasked = rowIdent === 'date-first' ? Object.keys(accountCurrency) : null;
  if (soleMasked && (soleMasked.length !== 1 || summaryAccountRows !== 1)) {
    throw parseFail('date-first 版面需要恰好一個帳戶');   // 概要帳戶「列數」也要恰一——r2#4/r8#4
  }

  /** @type {(BankTx & {y:number, _notes:{y:number,t:string}[]})[]} */
  const rows = [];
  /** @type {{y:number, t:string}[]} */
  const orphans = [];
  let xBal = 0, xNote = 0, inDetail = false, zoneStart = 0;   // 支出/存入欄 x 只活在表頭區塊（退路已移除）
  /** @type {{x:number, kind:'ign'|'out'|'in'}[]} 欄起點（依 x 升序）——右緣分欄的判準表 */
  let colStarts = [];
  /** @type {{s:number, e:number}[]} **真忽略欄**（headerIgnore）的區間表（含**餘額右側**的——
   * r1#1：餘額分支先吞所有 x≥xBal 的數字，餘額右邊的序號欄會被當成餘額；終點＝下一個欄起點） */
  let hardIgnIntervals = [];
  /** @type {{s:number, e:number}[]} **備註欄**自己的區間（r4#2：數字型備註不可當金額/餘額）——
   * 與真忽略欄分兩張表：金額/餘額分類兩張都避、**備註蒐集只避真忽略欄**（r7 修正的副作用：
   * 拿合併表去濾 rowNote 會把備註欄自己整欄清空）、摘要蒐集兩張都避（備註文字歸 note 不歸摘要）。 */
  let noteIntervals = [];
  const inHardIgn = (/** @type {number} */ x) => hardIgnIntervals.some(iv => x >= iv.s && x < iv.e);
  const inIgn = (/** @type {number} */ x) => inHardIgn(x) || noteIntervals.some(iv => x >= iv.s && x < iv.e);
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
    const rawC = c.map(x => x.s).join('');
    if (isHeaderRow(rawC)) {   // 與概要迴圈同一份判準（單一實作）
      // findX：先精確等於，再退「過同一把尺後等於」（有些版面標題帶空白、或印相容字）；抓不到＝結構性失敗退 AI
      const findX = (/** @type {string} */ name) => {
        // 先精確等於、再舊尺等於（＝main 那條）、最後才新尺等於——舊尺永遠優先，新尺只增不減（裁示「甲」）
        const hit = c.find(x => x.s === name) || c.find(x => squash(x.s) === squash(name)) || c.find(x => recipeNorm(x.s) === recipeNorm(name));
        return hit ? hit.x : 0;
      };
      const xOut = findX(hOut); const xInCol = findX(hIn);
      xBal = findX(hBal);
      xNote = headerNote ? findX(headerNote) : 0;
      if (!xOut || !xInCol || !xBal) throw parseFail('讀不到明細欄位位置');
      // 配方點名的欄**都要真的在表頭**（r2#3：headerNote 塞交易內文、表頭根本沒這欄＝xNote 靜默
      // 歸零、rowNote 靜默跳過、出生照樣重現——「點名就必須存在」把這條單槽走私路關成結構性失敗）
      const ignXs = headerIgnore.map(findX);
      if ((headerNote && !xNote) || ignXs.some(x => !x)) throw parseFail('讀不到明細欄位位置');
      // 互斥角色不可共用 x（r7#1）：⚠️ r6 我論證「名字兩兩不同 ⇒ x 互斥結構性成立」——**論證錯了**，
      // Codex 反例：BLine 資料模型允許兩個不同的表頭格共用同一個 x（「單號」與「提領金額」都在
      // x=272），忽略區間會吞掉整欄支出且強閘照綠。座標層的互斥要在座標層自己驗。
      const roleXs = [xOut, xInCol, xBal, ...(xNote ? [xNote] : []), ...ignXs];
      if (new Set(roleXs).size !== roleXs.length) throw parseFail('欄位座標重疊');
      // v1 欄序劃界（r2#2）：餘額欄必須在兩個金額欄**右側**——「支出｜餘額｜存入」這類欄序，
      // 餘額分支（x≥xBal 先吞）與分欄窗（r≥xBal 排除）的假設會讓存入欄整筆消失且強閘照樣放行。
      // 出生就拒解＝配方孵不出來、照走 AI；**不可讓它先孵化再漏錢**。
      if (xBal <= Math.max(xOut, xInCol)) throw parseFail('不支援的欄序');
      // 備註欄也是「非金額區間」（r4#2）——宣告要在 colStarts 之前（下面兩處都用它）
      const noteIgn = xNote ? [xNote] : [];
      colStarts = [...[...ignXs, ...noteIgn.filter(x => x < xBal)].map(x => ({ x, kind: /** @type {const} */ ('ign') })),
        { x: xOut, kind: /** @type {const} */ ('out') }, { x: xInCol, kind: /** @type {const} */ ('in') }]
        .sort((a, b) => a.x - b.x);
      // 忽略區間：終點＝下一個已知欄起點（沒有＝∞）。已知欄含餘額與備註——餘額**右側**的
      // 忽略欄（r1#1）就是靠這張表在餘額分支擋下。
      const bounds = [...ignXs, xOut, xInCol, xBal, ...(xNote ? [xNote] : [])].sort((a, b) => a - b);
      // r4#2：備註欄夾在金額欄之間時，數字型備註『777』會被分欄蒐集當成支出＝偽造交易且常落
      // 首筆盲區——比照忽略欄進區間表與欄起點表（但**分兩張表**，理由見宣告處）。
      // 代價（誠實）：純數字的備註內容不再進 note＝這種帳單出生重現會差一欄、配方孵不出來。
      hardIgnIntervals = ignXs.map(s => ({ s, e: bounds.find(b => b > s) ?? Infinity }));
      noteIntervals = noteIgn.map(s => ({ s, e: bounds.find(b => b > s) ?? Infinity }));
      // 緊鄰餘額欄左側的忽略/備註欄（區間終點＝xBal）＝不支援欄序（r25#1：該欄右對齊的值
      // 會漂過 xBal、左緣落進餘額窗＝成為「唯一餘額候選」——與真餘額機械上不可分辨、
      // 一窗一格也擋不住（它是第一個候選）。v1 劃界：這種版面拒解、照走 AI）。
      if ([...hardIgnIntervals, ...noteIntervals].some(iv => iv.e === xBal)) throw parseFail('不支援的欄序');
      // 表頭完整性（r18#1）：金額區起（min(xOut,xIn)）之後的**每一個**表頭格都必須是已宣告
      // 角色（金額三欄/備註/忽略）——出生月空值的「處理類別」欄若沒宣告，配方三關全過、
      // 次月它一有值就被摘要/備註吸收（劃撥→兩筆一般支出變內轉、現金流少算且強閘照綠）。
      // 金額區**之前**（帳號/日期/摘要標籤）＝摘要身分區、值本來就歸摘要——不在此限（劃界入契約）。
      {
        // 已宣告角色的**兩份**名單（裁示「甲」：舊尺認可的也要認可，否則 main 過得了的表頭我們擋掉）
        const roleNames = [recipe.detail.headerOut, recipe.detail.headerIn, recipe.detail.headerBalance,
          ...(headerNote ? [headerNote] : []), ...headerIgnore];
        const declaredOld = new Set(roleNames.map(squash));
        const declared = new Set(roleNames.map(recipeNorm));
        zoneStart = Math.min(xOut, xInCol);
        for (const cell of c) {
          if (cell.x >= zoneStart && !declared.has(recipeNorm(cell.s)) && !declaredOld.has(squash(cell.s))) throw parseFail('表頭有未宣告的欄位');
        }
      }
      // 同名角色格不可重複（r20#2：兩個「提領金額」格＝findX 綁第一個、完整性檢查卻兩個都
      // 認可——第二欄的值落進存入窗＝支出變存入且首筆盲區強閘照綠）
      for (const roleName of [hOut, hIn, hBal, ...(headerNote ? [headerNote] : []), ...headerIgnore]) {
        // ⚠️ **與 `findX` 完全同一組判準（精確／舊尺／新尺任一相等）**（Codex #523 r7#2）：
        //   守門比 findX 窄，第二格就漏數 ⇒ 它的值靜靜落錯窗（實測 1,200 被解成支出，而 main 拒解）。
        const rqN = recipeNorm(roleName), rqO = squash(roleName);
        const same = (/** @type {Cell} */ x) => x.s === roleName || squash(x.s) === rqO || recipeNorm(x.s) === rqN;
        if (c.filter(same).length > 1) throw parseFail('表頭有重複的欄位');
      }
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
      // 值層封閉（r19#1）：交易列上、金額區內（[zoneStart, xBal)）的非金額文字格必須落在
      // 已宣告的忽略/備註區間——r18 的表頭檢查只看「偵測到的那一列」，**雙列表頭**可以把
      // 未宣告的欄名放在隔壁列繞過出生檢查；值層封閉讓「配方已快取、次月值才出現」也當場
      // 拒解退 AI（劃撥→內轉的污染路徑從值端關死，表頭長怎樣都一樣）。
      // 劃界：zoneStart 之前＝摘要身分區（值本歸摘要）；xBal 之後＝備註聚合區（模板同款語意）。
      for (const cell of rest) {
        if (parseAmount(cell.s) != null || /\$/.test(cell.s) || inIgn(cell.x)) continue;
        const inAmountZone = cell.x >= zoneStart && cell.x < xBal;
        // 縫隙帶（r20#1）：xBal 與（右側）xNote 之間、或無備註欄時 xBal 之後——r19 版的文字
        // 掉進這裡「既不拒也不進備註」＝劃撥消失、真內轉被記成支出（反向的錢）。一併封閉。
        const noteRight = xNote > xBal;
        const inGapZone = cell.x >= xBal && !(noteRight && cell.x >= xNote);
        if (inAmountZone || inGapZone) throw parseFail('金額區出現未建模的文字');
      }
      // 摘要蒐集也要尊重忽略/備註區間（r7#2：忽略欄的**文字**值——「劃撥」——會被併進摘要，
      // 讓一般支出被分箱成內轉、現金流少算；餘額鏈照樣自洽、出生驗收也預見不了後續月份的欄值）
      const summary = squash(rest.filter(x => x.x < xBal && !inIgn(x.x) && parseAmount(x.s) == null && !/\$/.test(x.s)).map(x => x.s).join(''));
      // 金額候選分兩級（r11#1）：out/in 只收**嚴格整格金額**（parseAmount 整格可解——
      // 「訂單 $100」這種夾錢字樣的文字格會被幾何分欄撈成金額＝偽支出且強閘照綠）；
      // 含 $ 的非嚴格格只當**餘額**候選（黏尾備註「$730 黏尾」是餘額欄的真實形狀）。
      // 代價（誠實）：夾 $ 的文字既不進金額也不進摘要（摘要維持模板同款排除 $）＝
      // 這種版面出生重現差一欄、配方孵不出來。
      const amtCells = rest.filter(x => parseAmount(x.s) != null || /\$/.test(x.s));
      const strictMoney = (/** @type {Cell} */ x) => parseAmount(x.s) != null;
      /** @type {Cell|null} */ let outCell = null;
      /** @type {Cell|null} */ let inCell = null;
      /** @type {Cell|null} */ let balCell = null;
      let outCount = 0, inCount = 0, balCount = 0;   // 同窗多候選＝歧義（r16#1／r24#1：先到先贏會讓 $100 被記成 $7、「累計支出」欄頂替餘額）
      for (const cell of amtCells) {
        // 餘額分支也要先過忽略區間（r1#1：餘額右側的序號欄，0000007 會被當成餘額 7）
        if (cell.x >= xBal) { if (!inIgn(cell.x)) { balCount += 1; if (!balCell) balCell = cell; } continue; }
        // 左緣在忽略/備註區間的格（r5#1→r8#1 修正）：右緣仍在同類區間＝整格是序號/備註、跳過；
        // 右緣**跨出區間**（進金額窗或過餘額欄）＝歧義——「寬序號跨窗」（r5）與「右對齊大額
        // 左緣飄進忽略欄」（r8：金額左緣隨寬度飄移、右緣才穩定＝bank-statement 既有原則）兩形
        // 機械上不可分辨：猜忽略＝無聲吞掉真支出、猜金額＝序號變交易。**不猜＝整份拒解退 AI**。
        {
          // 歧義判定認「同一個實際區間」（r9#2：只認 kind 會放過「從忽略欄一跨過支出欄、
          // 右緣落進**另一個**忽略欄」的寬格＝支出整欄無聲消失）——右緣必須留在左緣所屬
          // 的那一個區間內，跨出去（不管落在哪）＝歧義拒解。
          const iv = [...hardIgnIntervals, ...noteIntervals].find(v => cell.x >= v.s && cell.x < v.e);
          if (iv) {
            if ((cell.w ? cell.x + cell.w : cell.x) >= iv.e) throw parseFail('欄位判定歧義');
            continue;
          }
        }
        if (!strictMoney(cell)) continue;   // 夾字的 $ 格只可能是餘額（上面那分支）——不入金額窗
        // 嚴格金額格「跨」餘額欄界（左緣<xBal、右緣≥xBal）＝歧義、兩種列判準一體適用
        // （r12#1：r10 只裝在 date-first——acct-date 的漂移餘額被退路撈成反向金額、
        // 該列餘額 null 使餘額鏈無從糾正、強閘照綠）。代價＝模板的「長溢出格進退路」行為
        // 在配方引擎收緊為拒解（模板等價考題不含此形；寧可孵不出配方）。
        const rEdge = cell.w ? cell.x + cell.w : cell.x;
        if (rEdge >= xBal) throw parseFail('欄位判定歧義');
        const kind = colOf(rEdge);   // 忽略欄＝colOf 回 'ign'——兩條路都要擋（#408 r1 H² 的教訓）
        // 左緣在摘要身分區（< zoneStart）、右緣卻分進金額窗＝跨區歧義（r26#1：zoneStart 左側的
        // 未宣告序號欄、寬值右緣跨進支出窗＝幽靈支出且強閘照綠；與「大額左緣飄出窗」機械上
        // 不可分辨——表頭/值層/分欄三層現在共用同一條 zoneStart 邊界）
        if ((kind === 'out' || kind === 'in') && cell.x < zoneStart) throw parseFail('欄位判定歧義');
        if (kind === 'out') { outCount += 1; if (!outCell) outCell = cell; }
        else if (kind === 'in') { inCount += 1; if (!inCell) inCell = cell; }
        else throw parseFail('欄位判定歧義');   // 分不進任何窗的嚴格金額格（r21#1，見下）
      }
      // 同列同時有支出與存入候選、或**同一窗內兩個候選**＝歧義（r15#2＋r16#1：模板的
      // 「先到先贏」慣性會讓多出來的數字欄蓋掉真金額——7 蓋 100、同窗第一格蓋第二格；
      // 台新版面「兩欄只填一個、一窗一格」是版面事實、泛化引擎不能拿它當假設）
      // 餘額窗也一窗一格（r24#1：未宣告的「累計支出」數字欄——雙列表頭出生躲過表頭檢查、
      // 次月數字頂替餘額＝累計增量剛好像餘額鏈、支出被覆寫成收入且強閘完整放行；
      // 概要端的同型位移由強閘的期末互驗接手——明細在這裡先拒解＝整份進不來）
      if (outCount > 1 || inCount > 1 || balCount > 1 || (outCell && inCell)) throw parseFail('欄位判定歧義');
      // ⚠️ 泛化引擎**沒有退路救援**（r21#1 終局）：模板的「左緣＋中線」退路是台新專屬遺產，
      // 它的掃描帶（zoneStart−60 起）在泛化語境下是無主地帶——未宣告的序號欄次月啟用＝
      // 憑空支出（出生三關全過、強閘照綠）。分不進窗的嚴格金額格（含掃描帶與摘要區的數字）
      // 一律「欄位判定歧義」拒解：真漂移金額退 AI 重讀、序號欄請配方宣告 headerIgnore。
      // r12 已使退路判 in 不可達、本輪把判 out 也收掉＝金額只有「窗內」一種家。
      const txnCell = outCell || inCell;
      /** @type {'in'|'out'|null} */
      const direction = outCell ? 'out' : (inCell ? 'in' : null);
      if (!txnCell || !direction) continue;
      const amount = parseAmount(String(txnCell.s).match(/[\d,]+(?:\.\d+)?/)?.[0] || '');
      if (amount == null) continue;
      if (!isRealDate(dateIso)) continue;   // 壞日期（如 2 月 31）＝整筆跳過，同模板
      const bs = balCell ? splitAmount(/** @type {{x:number,w:number,s:string}} */ (balCell), true) : null;   // allowNegative＝泛化版面印負餘額（r9#3）
      // date-first 的列判準天生比 acct-date 寬（沒有遮罩帳號當第二把鎖）——r4#1：任何「日期開頭
      // ＋一個數字」的資訊列（利率起算日、優惠期間）都長得像交易，偽列又常落在強閘的首筆／
      // 餘額缺席盲區＝冒名交易入帳。v1 收緊＝date-first 的交易列**必須有餘額格**。
      // 正當代價：無逐列餘額的 date-first 版面孵不出配方——那種版面本來就過不了強閘的餘額鏈。
      // 無餘額、卻有金額候選格（含**非嚴格**的黏尾形）跨餘額欄界＝可能是左緣漂移的大額餘額
      // （r10#2 date-first、r12#1 擴到兩種列判準）——分不出是寬金額還是漂移餘額＝歧義拒解。
      if (!bs && amtCells.some(x => x.x < xBal && (x.w ? x.x + x.w : x.x) >= xBal)) {
        throw parseFail('欄位判定歧義');
      }
      if (rowIdent === 'date-first' && !bs) continue;   // 真的整列無餘額（資訊列）才靜默跳過（r4#1）
      const rowNote = xNote ? rest.filter(x => x.x >= xNote && !inHardIgn(x.x) && parseAmount(x.s) == null && !/\$/.test(x.s)).map(x => x.s).join('') : '';   // 備註蒐集只避**真忽略欄**（r7#2 同型；避合併表會把備註欄自己清空）
      /** @type {{y:number,t:string}[]} */
      const ns = [];
      if (bs && bs.rest) ns.push({ y: line.y, t: bs.rest });
      if (rowNote) ns.push({ y: line.y, t: rowNote });
      const acctMasked = soleMasked ? soleMasked[0] : String(c[0].s).replace(/\s/g, '');
      rows.push({
        y: line.y, acctSuffix: accountSuffix(acctMasked), acctMasked,
        date: dateIso, summary, direction, amount, balance: bs ? bs.amt : null, note: '', _notes: ns,
      });
    } else {
      // 明細區**非交易列**的金額窗文字＝拒解（r28#1：雙列表頭把「流水號」欄名印在偵測列的
      // 隔壁列——表頭完整性看不到、值層封閉只管交易列；出生月這行**文字**就在這裡露餡＝
      // 配方孵不出來，次月的數字值因此永遠到不了快取路徑。劃界：只掃金額窗 [zoneStart, xBal)
      // ——縫隙帶留給孤兒備註的 -70 寬容帶）。
      for (const cell of c) {
        if (cell.x >= zoneStart && cell.x < xBal && parseAmount(cell.s) == null && !/\$/.test(cell.s) && !inIgn(cell.x)) {
          throw parseFail('金額區出現未建模的文字');
        }
      }
      if (xNote) {
        // 孤兒列＝**先逐格過濾真忽略欄、再判整列**（r13#1 擋獨立換行的「劃撥」；r14#1：整列判定
        // 若在過濾之前，左側忽略格會讓「忽略格＋真備註」的混合續行列整列進不了孤兒路徑＝
        // 真備註消失、該筆內轉被記成支出——兩個方向的錯都是錢）
        const keep = c.filter(x => !inHardIgn(x.x));
        if (keep.length && keep.every(x => x.x >= xNote - 70) && !isMaskedAccount(keep[0]?.s) && !toDate(keep[0]?.s || '')) {
          orphans.push({ y: line.y, t: keep.map(x => x.s).join('') });
        }
      }
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
    // ⚠️ 交易備註**連 NFKC 都不做**（理由見上面 label 那段的第③點：`①`→`1` 會被抽成自有帳號
    //   末碼、把真支出判成內轉）。這一欄也刻意不 squash——格間空白是它的內容。
    amount: r.amount, balance: r.balance, note: r._notes.sort((a, b) => b.y - a.y).map(n => n.t).join(''),
  }));
  if (transactions.length === 0) throw parseFail('讀不到任何交易');   // 空預覽比退回 AI 更糟
  // 概要不得出現重複的（遮罩＋幣別）帳戶（r25#2：出生比對的 accounts 是不比順序的 multiset、
  // 但 applyBalancesToDb 以 masked|currency first-wins 去重——同鍵兩列互換順序＝比對照過、
  // 實際寫入的餘額卻不同＝順序決定錢。同鍵重複＝版面歧義、拒解）。
  {
    const seenAcct = new Set();
    for (const a of accounts) {
      const k = a.masked + ' ' + a.currency;
      if (seenAcct.has(k)) throw parseFail('概要出現重複的帳戶幣別');
      seenAcct.add(k);
    }
    // 帳戶「身分重疊」也拒（r26#2：字面不同的遮罩變體——9001****3301 與 900100****3301——
    // 下游按「可見前綴＋末碼」配對會命中**同一個真實帳戶**、first-wins＝順序決定餘額；
    // 判準對齊下游：同幣別＋同末碼＋前綴相容（一方是另一方的開頭、或有一方為空）＝重疊。
    // 前綴不相容（900100 vs 900200＝P1a 的同末碼雙帳戶真實形）＝不同戶、照過）。
    const pfx = (/** @type {string} */ m) => (m.replace(/[^\d*]/g, '').match(/^(\d*)\*/) || [])[1] ?? '';
    // 身分清單用 **accountCurrency 全部條目**（r27#1：r26 版只掃有餘額的 accounts——餘額空白
    // 是正式支援形狀、只活在 accountCurrency，重疊照樣漏過＝兩組首筆盲區、錯讀金額仍入帳）
    const ids = Object.entries(accountCurrency).map(([m, cur]) => ({ masked: m, currency: cur, suffix: accountSuffix(m) }));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      if (a.currency !== b.currency || a.suffix !== b.suffix || a.masked === b.masked) continue;
      const pa = pfx(a.masked), pb = pfx(b.masked);
      if (!pa || !pb || pa.startsWith(pb) || pb.startsWith(pa)) throw parseFail('概要帳戶身分重疊');
    }
  }
  // 明細帳號必須在概要幣別表（r5#2）：AI 路線早有同款不變量（ai-parse r3#1——缺幣別的帳戶
  // 會 fallback 成 TWD 入帳）；配方引擎少這道牆＝概要錨點認不得的新帳戶自洽入帳、強閘照樣綠。
  // 出生比對只保護出生那份帳單，這道牆保護的是**快取之後**的每一份。
  for (const t of transactions) {
    if (!(t.acctMasked in accountCurrency)) throw parseFail('明細帳號不在概要幣別表');
  }
  return { bank: recipe.bank, referenceDate, accounts, accountCurrency, transactions, unclaimedAccountRows };
}

// ---- 出生把關：配方對帳單（r1#2） ------------------------------------------

/**
 * 零內容驗證的第二道（r1#2：字元檢查擋不住「無數字的交易內文」——把某筆交易的收款人文字
 * 誤選成版面錨點，validateRecipeStrict 挑不出來）。這一道拿**出生那份帳單**當對照，機械驗證
 * 錨點真的來自版面、不是來自交易：
 *  ①**等值約束**：錨點（過 `recipeNorm`）不得與任何交易的摘要/備註、帳戶的標籤/備註**相等**
 *    ——用相等不用子字串（「存入」是「轉帳存入」的子字串，子字串會把正當欄標題全誤殺）。
 *  ②**位置約束**：錨點命中的每一列都不得是交易列（依配方自己的列判準）——收款人文字住在
 *    交易列上，版面錨點住在區段標題/表頭。
 * 殘餘面（誠實劃界）：孤兒備註列的無數字文字不是交易列、①又只擋「整格相等」——仍可能漏；
 * 蓄意構造屬 #452 排除的對抗性藏匿。P2-3 的出生把關＝validateRecipeStrict＋本函式＋
 * recipeReproduces 三關全過才存檔。誤殺的代價＝配方不孵、照走 AI（fail-closed，不產生錯資料）。
 * @param {BLine[]} lines 出生帳單的座標列
 * @param {ParseRecipe} recipe
 * @param {{transactions?: {summary?:string, note?:string}[], accounts?: {label?:string, note?:string}[]}} parsed 出生帳單的已驗收答案
 * @returns {string[]} 錯誤清單（只帶槽位路徑，不回聲槽值）
 */
export function validateRecipeAgainstStatement(lines, recipe, parsed) {
  /** @type {string[]} */
  const errs = [];
  const isTxRow = makeIsTxRow(recipe);
  /** @type {[string, unknown][]} */
  const anchorSlots = [
    ...recipe.docAnchors.map((a, i) => /** @type {[string, unknown]} */ ([`docAnchors[${i}]`, a])),
    ...recipe.summary.sections.map((s, i) => /** @type {[string, unknown]} */ ([`summary.sections[${i}].anchor`, s.anchor])),
    ['summary.endAnchor', recipe.summary.endAnchor],
    ...(recipe.refDate.anchor ? [/** @type {[string, unknown]} */ (['refDate.anchor', recipe.refDate.anchor])] : []),
    // r2#3：headerNote／headerIgnore 也是文字槽＝也可攜帶內文，一樣要過等值＋位置約束
    //（引擎另有「點名的欄必須在表頭」的結構性要求——兩道互補）。
    // 三個金額欄標題**刻意不納**：位置約束對它們必誤殺（「存入」是無數交易摘要的子串、
    // 逐字拆格的版面整列 squash 必含之）——它們的走私面由「必須真的當表頭用」擋。
    ...(recipe.detail.headerNote ? [/** @type {[string, unknown]} */ (['detail.headerNote', recipe.detail.headerNote])] : []),
    ...recipe.detail.headerIgnore.map((h, i) => /** @type {[string, unknown]} */ ([`detail.headerIgnore[${i}]`, h])),
  ];
  // ⚠️ **兩把尺都收**（Codex #523 r7#3）：只看新尺時，舊尺才等值的交易內文可以冒充版面錨點——
  //   而引擎的 `recipeMatches` 正是用舊尺命中它的。等值與位置兩道約束都要對稱。
  const contentNew = new Set(), contentOld = new Set();
  const noteContent = (/** @type {unknown} */ v) => { contentNew.add(recipeNorm(v)); contentOld.add(squash(String(v))); };
  for (const t of parsed.transactions || []) for (const v of [t.summary, t.note]) if (v) noteContent(v);
  for (const a of parsed.accounts || []) for (const v of [a.label, a.note]) if (v) noteContent(v);
  const isContent = (/** @type {unknown} */ slot) => contentNew.has(recipeNorm(slot)) || contentOld.has(squash(String(slot ?? '')));
  // bank 槽只做**等值**檢（r8#3：單槽直通路——「敏感收款人」填進 bank 三關全過）；
  // 不做位置檢：銀行短名本來就會出現在交易列（「台新卡費」），位置約束必誤殺。
  if (isContent(recipe.bank)) errs.push('bank：與帳單內文相等（疑似交易內容，拒收）');
  for (const [path, slot] of anchorSlots) {
    if (isContent(slot)) { errs.push(`${path}：與帳單內文相等（疑似交易內容被誤選為錨點，拒收）`); continue; }
    for (const line of lines) {
      if (!hitEither(line.cells.map(c => c.s).join(''), slot)) continue;   // 位置約束也兩尺（與引擎命中同一組）
      if (isTxRow(line.cells)) { errs.push(`${path}：錨點出現在交易列（版面錨點必須來自版面文字，拒收）`); break; }
    }
  }
  return errs;
}

// ---- 出生驗收 --------------------------------------------------------------

/**
 * 配方的出生驗收：配方重解的結果必須**逐欄重現**使用者已確認的 AI 答案。
 * 回 {ok, diff}——diff 只帶「欄位路徑」、絕不帶欄值（值可能是真帳單內容，機密紀律）。
 * accounts 不比順序（兩邊都照帳單順序、但概要區跨段時排序不保證一致），逐 masked 對欄位；
 * transactions **嚴格比順序**（匯入順序影響 bankRef 去重與畫面，順序不同＝不算重現）。
 * @param {Omit<ReturnType<typeof parseWithRecipe>, 'unclaimedAccountRows'>} expected AI 路線驗收後的答案（使用者確認的那份——AI 答案**沒有**診斷鍵，型別不可謊稱必含；r1#1）
 * @param {ReturnType<typeof parseWithRecipe>} actual 配方重解的結果（多出的診斷鍵不在逐欄比對清單＝不影響重現判定）
 * @returns {{ok: boolean, diff: string|null}}
 */
export function recipeReproduces(expected, actual) {
  const no = (/** @type {string} */ d) => ({ ok: false, diff: d });
  // r4#1（預審③張力收口、契約預授權的「接線時擇一」）：**純文字欄**比對空白不敏感——AI 答案照抄
  // 帶格間空白（linesToText 空格相接）、引擎輸出一律 squash，嚴格等值會讓逐字拆格的版面「配方
  // 永遠孵不出來」（fail-closed 假拒收＝每次上傳白花 AI 費）。黃金樣本本身一個字不動（所見即所得）；
  // 金額／日期／方向／帳號欄不在此列、照樣嚴格。
  // ⚠️ **這把尺刻意停在「只吃空白」（r4#1 原狀）——不跟 `recipeNorm` 對齊，那是界線不是遺漏**：
  //   放寬字體差會讓「AI 抄正規字、帳單印相容字」的卡孵得出來，而那種卡之後匯入的是**帳單原文的
  //   相容字** ⇒ 與 AI 路線那次記的字不同 ⇒ 精準去重鍵分叉（`skipSimilar` 是選配、疑似重複擋不住）。
  //   把引擎輸出一起正規化來收口的路已經走過並被打掉（三條理由見上面 label 那段）。
  //   ⇒ 這裡放寬**必須**與「分類／去重比對形」那一層一起做，不可單獨放寬（William 2026-08-29 裁示
  //   「縮回只修辨識層」；`recipeNorm` 的射程止於認版面，不進出生驗收的文字欄）。
  const softEq = (/** @type {any} */ a, /** @type {any} */ b) => a === b || (typeof a === 'string' && typeof b === 'string' && a.replace(/\s+/g, '') === b.replace(/\s+/g, ''));
  const SOFT = new Set(['label', 'note', 'summary']);
  const fEq = (/** @type {string} */ f, /** @type {any} */ x, /** @type {any} */ y) => (SOFT.has(f) ? softEq(x, y) : x === y);
  if (expected.bank !== actual.bank) return no('bank');
  if (expected.referenceDate !== actual.referenceDate) return no('referenceDate');
  const ek = Object.keys(expected.accountCurrency), ak = Object.keys(actual.accountCurrency);
  if (ek.length !== ak.length) return no('accountCurrency（帳戶數）');
  for (const k of ek) if (expected.accountCurrency[k] !== actual.accountCurrency[k]) return no('accountCurrency（幣別）');
  if (expected.accounts.length !== actual.accounts.length) return no('accounts（帳戶數）');
  // 逐 masked 分組做 multiset 一對一（r1#3：同一個遮罩帳號掛多幣別是真實形狀——外幣綜合帳戶；
  // 用 Map(masked→單一帳戶) 會 last-wins：重複鍵的第一筆錯值被蓋掉＝假通過，順序互換＝假失敗）。
  /** @type {Map<string, typeof actual.accounts>} */
  const actGroups = new Map();
  for (const a of actual.accounts) { const g = actGroups.get(a.masked); if (g) g.push(a); else actGroups.set(a.masked, [a]); }
  /** @type {Map<string, {i:number, a: typeof expected.accounts[0]}[]>} */
  const expGroups = new Map();
  for (const [i, a] of expected.accounts.entries()) { const g = expGroups.get(a.masked); if (g) g.push({ i, a }); else expGroups.set(a.masked, [{ i, a }]); }
  if (actGroups.size !== expGroups.size) return no('accounts（帳戶組成不同）');
  const ACC_FIELDS = /** @type {const} */ (['suffix', 'balance', 'currency', 'label', 'note']);
  for (const [masked, eg] of expGroups) {
    const ag = actGroups.get(masked);
    if (!ag || ag.length !== eg.length) return no('accounts（帳戶組成不同）');
    if (eg.length === 1) {
      for (const f of ACC_FIELDS) if (!fEq(f, eg[0].a[f], ag[0][f])) return no(`accounts[${eg[0].i}].${f}`);
    } else {
      // 同遮罩多帳戶：組內排序後成對全等（欄位級 diff 在多重組退化成組級——路徑不帶 masked，那是帳號）
      // ⚠️ 與上面 `softEq` **同一把尺**（Codex #523 r1 Medium：這條是單帳戶組的平行路徑，兩邊要一起動）
      const key = (/** @type {any} */ a) => JSON.stringify(ACC_FIELDS.map(f => (SOFT.has(f) && typeof a[f] === 'string' ? a[f].replace(/\s+/g, '') : a[f])));
      const k1 = eg.map(x => key(x.a)).sort();
      const k2 = ag.map(key).sort();
      if (k1.some((k, j) => k !== k2[j])) return no('accounts（同遮罩多帳戶組不吻合）');
    }
  }
  if (expected.transactions.length !== actual.transactions.length) return no('transactions（筆數）');
  for (const [i, e] of expected.transactions.entries()) {
    const a = actual.transactions[i];
    for (const f of /** @type {const} */ (['acctSuffix', 'acctMasked', 'date', 'summary', 'direction', 'amount', 'balance', 'note'])) {
      if (!fEq(f, e[f], a[f])) return no(`transactions[${i}].${f}`);
    }
  }
  return { ok: true, diff: null };
}
