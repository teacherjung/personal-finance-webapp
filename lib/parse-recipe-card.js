// @ts-check
// **信用卡的版面規則卡**（批四，2026-08-30）：AI 讀過一次的信用卡帳單，把版面結構學成
// 純資料規則卡——之後同版面「零費用、內容零外送」重讀。鏡射銀行線 lib/parse-recipe.js 的
// 分工與鐵則，**不共用銀行的配方 schema**：卡片帳單沒有帳戶餘額鏈、有「摘要四格＋具名調整
// ＋消費明細」的自己一套。共用的原語（checkSlot／checkKeys／DATE_PARSERS／recipeMatches／
// recipeNorm 兩把尺協定）一律 import 銀行模組的同一份——複製＝漂移副本。
//
// ## 與批二 AI 路的關係（單一真相的接法）
//
// 本引擎只負責「照規則卡把帳單抄成 AI 答案卷的形狀」；**驗收與驗算完全借批二的同一套**：
// 產出餵給 `normalizeAiCard`（fail-closed 驗收＋店名/label 過 normalizeDesc）→ `reconcileAiCard`
// （等式閘＋慣例閘、容差 0）→ 服務層再走同一支轉換與中閘。規則卡讀的帳單因此和 AI 讀的
// 過**一模一樣嚴**的閘；接地檢查不適用（規則卡是確定性抄寫、抄的就是帳單）。
//
// ## 硬規矩（同銀行格式 A）
//
// 1. 槽位只有**字面文字**與**枚舉**——零正則、零程式；引擎內部用 regex 合法，配方內容不准帶樣式。
// 2. 錯一格＝整份拒收重生，沒有寬鬆修補的路。
// 3. 明細區裡**不像交易列的列直接跳過**（小計/換頁雜訊）——漏抄的風險由驗算閘接住：
//    Σ明細對不上「本期新增」整份就不收（容差 0），這正是「跳過可以安全」的前提。
//
// ## 儲存（同一櫃子＋種類標籤，William 2026-08-30 拍板）
//
// 卡片規則卡與銀行配方同住 `db.parseRecipes`，**種類標籤 `kind:'card'` 記在櫃子列上**
// （repo.saveParseRecipe 寫入），不進配方物件本體——銀行驗證器的鍵白名單因此零改動；
// 兩邊路由各自依 kind 過濾（銀行路跳過 card、卡片路只收 card；缺席＝銀行既有卡）。

import { checkSlot, checkKeys, DATE_PARSERS, RECIPE_DATE_FORMATS, RECIPE_FORMAT_VERSION, recipeNorm } from './parse-recipe.js';
import { squash } from './bank-statement.js';

const apiError = (/** @type {number} */ status, /** @type {string} */ msg, /** @type {string=} */ code) =>
  Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });

/** 該趟的尺（協定同銀行 RECIPE_RULERS：'old'＝squash 預設、'new'＝recipeNorm，一趟一把不混用）。 */
const rulerOf = (/** @type {{ruler?: string}=} */ opts) => (opts?.ruler === 'new' ? recipeNorm : squash);

// ── 形狀 ────────────────────────────────────────────────────────────────────
/**
 * @typedef {{ formatVersion: number, bank: string, docAnchors: string[],
 *   dateFormat: keyof typeof DATE_PARSERS,
 *   totalsLabels: { prevDue: string, paidAndRefund: string, newCharges: string, due: string },
 *   adjustmentLabels: string[],
 *   lastFourLabel: string|null, monthLabel: string|null,
 *   detail: { headerAnchor: string, rowShape: 'date-date-desc-amount'|'date-desc-amount', stopAnchors: string[] } }} CardRecipe
 */
export const CARD_RECIPE_ROW_SHAPES = Object.freeze(/** @type {const} */ (['date-date-desc-amount', 'date-desc-amount']));
export const CARD_RECIPE_LIMITS = Object.freeze({ bank: 20, anchor: 30, label: 30, docAnchors: 4, adjustmentLabels: 8, stopAnchors: 4 });

// ── 嚴格驗證（出生第一關；骨架同銀行 validateRecipeStrict）──────────────────
/**
 * 卡片規則卡嚴格驗證：回錯誤訊息陣列（空＝合格）。訊息只帶槽位路徑、不回聲槽值。
 * @param {unknown} raw @param {{ruler?: string}=} opts @returns {string[]}
 */
export function validateCardRecipeStrict(raw, opts) {
  /** @type {string[]} */ const errs = [];
  const norm = rulerOf(opts);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['配方：必須是物件'];
  const r = /** @type {Record<string, any>} */ (raw);
  checkKeys('配方', r, ['formatVersion', 'bank', 'docAnchors', 'dateFormat', 'totalsLabels', 'adjustmentLabels', 'lastFourLabel', 'monthLabel', 'detail'], errs);
  if (r.formatVersion !== RECIPE_FORMAT_VERSION) errs.push('配方：formatVersion 不認得');
  checkSlot('bank', r.bank, CARD_RECIPE_LIMITS.bank, errs, 1, norm);
  if (!Array.isArray(r.docAnchors) || r.docAnchors.length < 2 || r.docAnchors.length > CARD_RECIPE_LIMITS.docAnchors) {
    errs.push(`docAnchors：必須是 2–${CARD_RECIPE_LIMITS.docAnchors} 個暗號`);
  } else r.docAnchors.forEach((/** @type {any} */ a, /** @type {number} */ i) => checkSlot(`docAnchors[${i}]`, a, CARD_RECIPE_LIMITS.anchor, errs, 4, norm));
  if (!RECIPE_DATE_FORMATS.includes(r.dateFormat)) errs.push('dateFormat：不在枚舉表');
  if (!r.totalsLabels || typeof r.totalsLabels !== 'object' || Array.isArray(r.totalsLabels)) errs.push('totalsLabels：必須是物件');
  else {
    checkKeys('totalsLabels', r.totalsLabels, ['prevDue', 'paidAndRefund', 'newCharges', 'due'], errs);
    for (const f of ['prevDue', 'paidAndRefund', 'newCharges', 'due']) checkSlot(`totalsLabels.${f}`, r.totalsLabels[f], CARD_RECIPE_LIMITS.label, errs, 2, norm);
    // r4#1→r5#2：**所有取值用的標籤**（四格＋具名調整＋末四碼＋期別）兩兩相異（該趟的尺後）——
    // 出生月數值恰好相同時，共用標籤可矇混過重現；下一期數值分家，就把 A 格的值讀進 B 格
    //（末四碼標籤共用「本期應繳」＝下一期把應繳金額當末四碼、候選縮成錯的卡）。
    // 錨點（docAnchors/headerAnchor/stopAnchors）豁免：它們只標位置、不取值。
    const seen = new Set();
    const uniq = (/** @type {string} */ path, /** @type {any} */ v) => {
      const key = typeof v === 'string' ? norm(v) : `#${path}`;
      if (seen.has(key)) errs.push(`${path}：取值標籤必須兩兩相異（共用標籤＝下一期讀錯格）`);
      seen.add(key);
    };
    for (const f of ['prevDue', 'paidAndRefund', 'newCharges', 'due']) uniq(`totalsLabels.${f}`, r.totalsLabels[f]);
    if (Array.isArray(r.adjustmentLabels)) r.adjustmentLabels.forEach((/** @type {any} */ a2, /** @type {number} */ i) => uniq(`adjustmentLabels[${i}]`, a2));
    if (typeof r.lastFourLabel === 'string') uniq('lastFourLabel', r.lastFourLabel);
    if (typeof r.monthLabel === 'string') uniq('monthLabel', r.monthLabel);
  }
  if (!Array.isArray(r.adjustmentLabels) || r.adjustmentLabels.length > CARD_RECIPE_LIMITS.adjustmentLabels) errs.push(`adjustmentLabels：必須是 0–${CARD_RECIPE_LIMITS.adjustmentLabels} 個標籤`);
  else r.adjustmentLabels.forEach((/** @type {any} */ a, /** @type {number} */ i) => checkSlot(`adjustmentLabels[${i}]`, a, CARD_RECIPE_LIMITS.label, errs, 2, norm));
  if (r.lastFourLabel !== null) checkSlot('lastFourLabel', r.lastFourLabel, CARD_RECIPE_LIMITS.label, errs, 2, norm);
  if (r.monthLabel !== null) checkSlot('monthLabel', r.monthLabel, CARD_RECIPE_LIMITS.label, errs, 2, norm);
  if (!r.detail || typeof r.detail !== 'object' || Array.isArray(r.detail)) errs.push('detail：必須是物件');
  else {
    checkKeys('detail', r.detail, ['headerAnchor', 'rowShape', 'stopAnchors'], errs);
    checkSlot('detail.headerAnchor', r.detail.headerAnchor, CARD_RECIPE_LIMITS.anchor, errs, 2, norm);
    if (!CARD_RECIPE_ROW_SHAPES.includes(r.detail.rowShape)) errs.push('detail.rowShape：不在枚舉表');
    if (!Array.isArray(r.detail.stopAnchors) || r.detail.stopAnchors.length > CARD_RECIPE_LIMITS.stopAnchors) errs.push(`detail.stopAnchors：必須是 0–${CARD_RECIPE_LIMITS.stopAnchors} 個`);
    else r.detail.stopAnchors.forEach((/** @type {any} */ a, /** @type {number} */ i) => checkSlot(`detail.stopAnchors[${i}]`, a, CARD_RECIPE_LIMITS.anchor, errs, 2, norm));
  }
  return errs;
}

// ── 套用引擎 ────────────────────────────────────────────────────────────────
const parseFail = (/** @type {string} */ why) =>
  apiError(400, `規則卡解不動這份帳單（${why}）`, 'recipe_parse_failed');

const AMOUNT_RE = /^-?[\d,]+(?:\.\d+)?$/;
/** 「長得像日期」的寬判準（r2#1）：涵蓋不補零與 -/. 分隔——只用來決定「拒解 vs 雜訊」，不做解析。
 * r3#1：偵測也要看 NFKC 摺疊後的形——全形相容日期（２０２６／０７／０３）在 old 趟解不動，
 * 但**必須**被認成「日期漂移」拒解（跳過＝互抵漏抄；拒解＝這趟收工、new 趟 NFKC 後解得動）。 */
const DATE_LIKE = /^\d{2,4}[-/.]\d{1,2}[-/.]\d{1,2}$/;
const dateLike = (/** @type {string} */ s) => {
  // r4#2：兩把尺都會去掉**字內**空白——偵測也要（「２０２６ ／ ０７ ／ ０４」new 趟解得動，
  // old 趟必須認成漂移拒解、不得當雜訊）；NFKC 形一併試。
  const t = String(s || '').replace(/\s+/g, '');
  return DATE_LIKE.test(t) || DATE_LIKE.test(t.normalize('NFKC'));
};
const toAmount = (/** @type {string} */ s) => {
  const t = String(s || '').trim();
  if (!AMOUNT_RE.test(t)) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) && Math.abs(n) <= 1e8 ? n : null;
};

/** 一列裡「恰好一個」金額格：0 個或 2 個以上＝分不出是哪格＝null（呼叫端 fail-closed）。 */
function soleAmount(/** @type {string[]} */ cells, /** @type {number} */ from = 0) {
  /** @type {number[]} */ const hits = [];
  for (let i = from; i < cells.length; i++) { if (toAmount(cells[i]) !== null) hits.push(i); }
  return hits.length === 1 ? /** @type {number} */ (toAmount(cells[hits[0]])) : null;
}

/** 找「有一格（該趟的尺後）等於 label」的列。回列索引陣列。 */
function findLabelLines(/** @type {string[][]} */ lines, /** @type {string} */ label, /** @type {(s: string) => string} */ norm) {
  const target = norm(label);
  /** @type {number[]} */ const out = [];
  lines.forEach((cells, i) => { if (cells.some((c) => norm(c) === target)) out.push(i); });
  return out;
}

/**
 * 照規則卡把帳單抄成 **AI 答案卷的原始形狀**（餵 normalizeAiCard 的那一份）。
 * fail-closed：標籤找不到、找到兩列、同列金額分不出＝recipe_parse_failed（訊息不帶帳單內容）。
 * 明細區裡不像交易列的列跳過（檔頭規矩 3——驗算閘接住漏抄）。
 * @param {string[][]} lines extractLinesForIsolation 的輸出（卡片抽取器：每列＝字串格陣列，無座標）
 * @param {CardRecipe} recipe @param {{ruler?: string}=} opts
 */
export function parseCardWithRecipe(lines, recipe, opts) {
  const strict = validateCardRecipeStrict(recipe, opts);
  if (strict.length) throw parseFail('規則卡不合格');
  const norm = rulerOf(opts);
  // 日期解析也走**該趟的尺**（r3#1）：new 趟的 recipeNorm 先 NFKC＝全形相容日期摺成 ASCII 才解得動；
  // old 趟照舊逐字（解不動的交給 dateLike 拒解、換趟再來）——尺與拼字的關係同暗號比對。
  const rawDate = DATE_PARSERS[recipe.dateFormat];
  const toDate = (/** @type {string} */ s) => rawDate(norm(String(s || '').trim()));

  // 摘要四格＋具名調整：標籤列唯一、金額格唯一，缺一不可（四格是驗算的前提）
  /** @type {any} */ const totals = {};
  for (const f of /** @type {const} */ (['prevDue', 'paidAndRefund', 'newCharges', 'due'])) {
    const hit = findLabelLines(lines, recipe.totalsLabels[f], norm);
    if (hit.length !== 1) throw parseFail(`摘要標籤 ${f} 出現 ${hit.length} 列`);
    const v = soleAmount(lines[hit[0]]);
    if (v === null) throw parseFail(`摘要 ${f} 的金額格分不出`);
    totals[f] = v;
  }
  /** @type {{label: string, amount: number, date: string|null}[]} */ const adjustments = [];
  for (const label of recipe.adjustmentLabels) {
    const hit = findLabelLines(lines, label, norm);
    if (hit.length === 0) continue;   // 這期沒有這個項目（違約金不是每期都有）＝合法缺席
    if (hit.length > 1) throw parseFail('具名調整標籤出現多列');
    const v = soleAmount(lines[hit[0]]);
    if (v === null) throw parseFail('具名調整的金額格分不出');
    // 同列若印了日期就抄（r1#2：AI 黃金答案帶日期、規則卡永遠 null ⇒ 出生重現關比不出、
    // 日後寫入日期不同 ⇒ 重傳同一帳單時 stmtRef 分岔＝同一筆利息重複記帳）。兩個以上＝分不出＝拒解。
    const dates = lines[hit[0]].map((c) => toDate(c)).filter((d) => d);
    if (dates.length > 1) throw parseFail('具名調整列的日期格分不出');
    if (v !== 0) adjustments.push({ label, amount: v, date: dates[0] || null });   // 0＝帳單印了空項，等同缺席
  }

  let lastFour = null;
  if (recipe.lastFourLabel) {
    const hit = findLabelLines(lines, recipe.lastFourLabel, norm);
    if (hit.length !== 1) throw parseFail('末四碼標籤列數不對');
    const cell = lines[hit[0]].map((c) => c.trim()).find((c) => /^\d{4}$/.test(c));
    if (!cell) throw parseFail('末四碼格找不到');
    lastFour = cell;
  }
  let statementMonth = null;
  if (recipe.monthLabel) {
    const hit = findLabelLines(lines, recipe.monthLabel, norm);
    if (hit.length !== 1) throw parseFail('期別標籤列數不對');
    const iso = lines[hit[0]].map((c) => toDate(c)).find((d) => d);
    if (!iso) throw parseFail('期別的日期格讀不出');
    statementMonth = iso.slice(0, 7);
  }

  // 明細區：表頭錨之後、停止錨（或摘要標籤列）之前；照 rowShape 抄，不像的列跳過
  const headerHit = findLabelLines(lines, recipe.detail.headerAnchor, norm);
  if (headerHit.length !== 1) throw parseFail('明細表頭錨列數不對');
  const stops = new Set(recipe.detail.stopAnchors.map((a) => norm(a)));
  const totalLabelNorms = new Set(Object.values(recipe.totalsLabels).map((l) => norm(l)));
  /** @type {{date: string, postDate: string|null, desc: string, amount: number}[]} */ const transactions = [];
  for (let i = headerHit[0] + 1; i < lines.length; i++) {
    const cells = lines[i];
    const d0 = toDate(cells[0] || '');
    // 申報形判準看**整列任何一格**（r1#1→r2→r5#1 的最終形）：日期漂到後格（版面在前面
    // 多長一欄「持卡人」之類）的列若只看首格＝被當雜訊跳過＝一正一負互抵漏抄的同一扇門。
    const anyDate = d0 || cells.some((c) => toDate(c) || dateLike(c));
    const stopHit = cells.some((c) => stops.has(norm(c)) || totalLabelNorms.has(norm(c)));
    // 停止判定**先看日期**（r4#3）：帶日期又撞停止錨＝分不出是交易還是收尾＝整份拒解（寧擋勿猜）。
    if (stopHit && anyDate) throw parseFail('明細列撞上停止錨');
    if (stopHit) break;
    // 整列分三種：
    // ・完全沒有日期形＝雜訊列（小計/換頁），跳過安全（驗算閘接住）。
    // ・有日期形、但**不在首格**或首格解不動＝版面形狀/印法與規則卡不符＝整份拒解退回 AI
    //   （跳過＝互抵漏抄；猜位＝把錯格當日期）。
    // ・首格過格式＝申報形列——一律要嘛成為交易、要嘛整份拒解。
    if (!anyDate) continue;
    if (!d0) throw parseFail('明細列的日期印法或位置與規則卡不符');
    if (recipe.detail.rowShape === 'date-date-desc-amount') {
      const d1 = toDate(cells[1] || '');
      // 第二格「長得像日期但解不動」＝同樣是漂移（r3#2）：當成說明文字會把日期污染進店名、
      // postDate 消失、去重身分跟著錯——拒解，不降級成單日期列。
      if (!d1 && dateLike(cells[1] || '')) throw parseFail('明細列的入帳日印法與規則卡不符');
      if (d1) {
        if (cells.length < 4) throw parseFail('明細列的形狀讀不出');
        const amount = soleAmount(cells, 2);
        if (amount === null) throw parseFail('明細列的金額格分不出');
        const desc = cells.slice(2).filter((c) => toAmount(c) === null).join(' ').trim();
        if (!desc) throw parseFail('明細列的說明是空的');
        transactions.push({ date: d0, postDate: d1, desc, amount });
      } else {
        // 單日期列照收（r2#3：繳款列常只印一個日期——真實版面雙日期消費與單日期繳款混排；
        // 誤擋它＝合法帳單整份讀不動）。歧義照樣拒解、絕不跳過。
        if (cells.length < 3) throw parseFail('明細列的形狀讀不出');
        const amount = soleAmount(cells, 1);
        if (amount === null) throw parseFail('明細列的金額格分不出');
        const desc = cells.slice(1).filter((c) => toAmount(c) === null).join(' ').trim();
        if (!desc) throw parseFail('明細列的說明是空的');
        transactions.push({ date: d0, postDate: null, desc, amount });
      }
    } else {
      if (cells.length < 3) throw parseFail('明細列的形狀讀不出');
      // r4#4：單日期版面日後長出入帳日欄＝第二格長得像日期——併進說明會污染店名與去重身分，
      // 與雙日期形的同款守門：拒解退回 AI（版面變了＝該重學）。
      if (dateLike(cells[1] || '')) throw parseFail('明細列多了規則卡不認得的日期欄');
      const amount = soleAmount(cells, 1);
      if (amount === null) throw parseFail('明細列的金額格分不出');
      const desc = cells.slice(1).filter((c) => toAmount(c) === null).join(' ').trim();
      if (!desc) throw parseFail('明細列的說明是空的');
      transactions.push({ date: d0, postDate: null, desc, amount });
    }
  }
  if (!transactions.length && totals.newCharges !== 0) throw parseFail('明細區一筆都抄不到');

  return { issuer: recipe.bank, lastFour, statementMonth, totals, adjustments, transactions };
}

// ── 出生把關：對照出生帳單（錨點不可是帳單內容）──────────────────────────────
/**
 * 錨點／標籤不得等於任何一筆交易的店名（等值），且命中的列不得是交易列（位置）。
 * @param {string[][]} lines @param {CardRecipe} recipe
 * @param {{transactions: {desc: string}[]}} answer 已驗收的 AI 答案
 * @param {{ruler?: string}=} opts @returns {string[]}
 */
export function validateCardRecipeAgainstStatement(lines, recipe, answer, opts) {
  /** @type {string[]} */ const errs = [];
  const norm = rulerOf(opts);
  const descs = new Set((answer.transactions || []).map((t) => norm(t.desc || '')));
  const rawDate = DATE_PARSERS[recipe.dateFormat];
  // r4#5：交易列判定也走該趟的尺＋寬日期偵測——new 趟的全形日期交易列若不被認成交易列，
  // 內容牆（錨點不可釘在明細上）與 bank 接地都會被同型列旁路。
  const isTxLine = (/** @type {string[]} */ cells) => !!rawDate(norm(String(cells[0] || '').trim())) || dateLike(cells[0] || '');
  /** @type {[string, string][]} */ const slots = [
    ['bank', recipe.bank],   // r1#3：bank 也是槽位——店名存進 bank 一樣是「交易內容進規則卡」
    ...recipe.docAnchors.map((/** @type {string} */ a, /** @type {number} */ i) => /** @type {[string, string]} */ ([`docAnchors[${i}]`, a])),
    ...Object.entries(recipe.totalsLabels).map(([k, v]) => /** @type {[string, string]} */ ([`totalsLabels.${k}`, v])),
    ...recipe.adjustmentLabels.map((/** @type {string} */ a, /** @type {number} */ i) => /** @type {[string, string]} */ ([`adjustmentLabels[${i}]`, a])),
    ...(recipe.lastFourLabel ? [/** @type {[string, string]} */ (['lastFourLabel', recipe.lastFourLabel])] : []),
    ...(recipe.monthLabel ? [/** @type {[string, string]} */ (['monthLabel', recipe.monthLabel])] : []),
    ['detail.headerAnchor', recipe.detail.headerAnchor],
    ...recipe.detail.stopAnchors.map((/** @type {string} */ a, /** @type {number} */ i) => /** @type {[string, string]} */ ([`detail.stopAnchors[${i}]`, a])),
  ];
  for (const [path, v] of slots) {
    if (descs.has(norm(v))) { errs.push(`${path}：與某筆交易的店名相等（錨點不可是帳單內容）`); continue; }
    const hits = findLabelLines(lines, v, norm);
    // bank 也要**接地**（r3#5）：憑空的機構名不在帳單上＝存進卡並顯示給使用者的字沒有出處
    if (path === 'bank' && hits.length === 0) { errs.push('bank：帳單上找不到這個機構名（憑空的字不入卡）'); continue; }
    for (const i of hits) {
      if (isTxLine(lines[i])) { errs.push(`${path}：命中的列是交易列（錨點不可釘在明細上）`); break; }
    }
  }
  return errs;
}

// ── 出生把關：重現 AI 答案 ───────────────────────────────────────────────────
const softEq = (/** @type {string} */ a, /** @type {string} */ b) => squash(String(a || '')) === squash(String(b || ''));
/**
 * 規則卡重解的結果要與使用者確認過的 AI 答案一致（錢的欄位嚴格、純文字欄空白不敏感）。
 * diff 只帶欄位路徑不帶欄值（機密紀律同銀行 recipeReproduces）。
 * ⚠️ 兩邊都先過 normalizeAiCard 再比（desc/label 的 normalizeDesc 同口徑）——呼叫端負責。
 * @typedef {{issuer: string, lastFour: string|null, statementMonth: string|null,
 *   statementTotals: Record<string, number|null>, adjustments: {label: string, amount: number}[],
 *   transactions: {date: string, postDate: string|null, desc: string, amount: number}[]}} CardAnswer
 * @param {CardAnswer} expected @param {CardAnswer} actual @returns {{ok: boolean, diff: string|null}}
 */
export function cardRecipeReproduces(expected, actual) {
  const no = (/** @type {string} */ d) => ({ ok: false, diff: d });
  if (!softEq(expected.issuer, actual.issuer)) return no('issuer');
  if ((expected.lastFour || null) !== (actual.lastFour || null)) return no('lastFour');
  if ((expected.statementMonth || null) !== (actual.statementMonth || null)) return no('statementMonth');
  for (const f of ['prevDue', 'paidAndRefund', 'newCharges', 'due']) {
    if (expected.statementTotals[f] !== actual.statementTotals[f]) return no(`totals.${f}`);
  }
  if (expected.adjustments.length !== actual.adjustments.length) return no('adjustments.length');
  // 具名調整比 multiset（帳單上沒有順序語意）：label softEq＋金額嚴格
  const pool = [...actual.adjustments];
  for (const [i, e] of expected.adjustments.entries()) {
    // date 也要比（r1#2）：日期不同＝日後寫入的 stmtRef 分岔＝重傳時同一筆利息重複記帳
    const j = pool.findIndex((a) => softEq(a.label, e.label) && a.amount === e.amount
      && ((/** @type {any} */ (a).date ?? null) === (/** @type {any} */ (e).date ?? null)));
    if (j < 0) return no(`adjustments[${i}]`);
    pool.splice(j, 1);
  }
  if (expected.transactions.length !== actual.transactions.length) return no('transactions.length');
  for (const [i, e] of expected.transactions.entries()) {
    const a = actual.transactions[i];   // 明細嚴格比順序（同銀行；順序也是身分的一部分）
    if (e.date !== a.date || (e.postDate || null) !== (a.postDate || null)) return no(`transactions[${i}].date`);
    if (e.amount !== a.amount) return no(`transactions[${i}].amount`);
    if (!softEq(e.desc, a.desc)) return no(`transactions[${i}].desc`);
  }
  return { ok: true, diff: null };
}
