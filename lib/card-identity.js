// 信用卡帳單的「這是誰印的」判準——**純函式、零 I/O、只吃 `string[][]`**（所以合成得出來、測得到）。
//
// ## 為什麼要有這一支（2026-08-27）
//
// 這個 app 要開放給多人使用，目標是「任何銀行的任何帳單都能正確讀取」。所以
// **「不是台新／富邦」＝多數使用者的常態，不是邊緣案例**。而原本 `parsePdfAuto` 決定機構名的方式是
// **數全文出現幾次「台新」「富邦」**——那個計數掃的是整份文件，包含**消費明細裡的商店名**：
// 實測使用者的遠銀帳單刷了「富邦人壽」保費，富邦命中 4 次、台新 1 次 ⇒ 會說「這是富邦的帳單」。
//
// 更嚴重的是另一半：兩支內建解析器的列判準都很寬（富邦＝首格民國日期＋末格金額；台新＝前兩格都是
// 民國日期），台灣帳單普遍長這樣。實測合成別家帳單：
//   遠東國際商業銀行 → `bank:'台新'` ＋ 1 筆；國泰世華四欄式 → `bank:'富邦'` ＋ 2 筆乾淨交易
// **不是讀不出來，是讀出看起來很正常的假資料，還會自動歸到錯的卡。**
//
// ## 判準
//
// **機構名只能來自「解析器自己沒有消耗掉的、又不像交易列的那些列」。**
// 商店名一律沒有投票權——它們要嘛已被解析器消耗（`used`），要嘛落在像交易列的列上（`looksLikeTxRow`）。
//
// ## ⚠️ 誠實劃界（這一支**不**保證什麼）
//
// - **`OTHER_ISSUERS` 不是判準、是否證器。** 漏列一家的後果是退回「`bank:''`＋不自動歸卡＋警語」，
//   **不是**退回「貼上台新／富邦的標籤」。所以這張清單不完整是可以接受的；它只負責把已知的別家
//   從「盡力讀出來的列」升級成「整份丟棄」。⚠️ 不可以把這句話寫成「別家不會被誤認」。
// - **不保證抓到的列是完整的。** 部分漏抓（版面改版、`parseFubon` 的排除清單誤傷）照樣通過。
// - **不保證分得出「這期沒消費」與「這個版面我讀不動」。** 要真的分得出需要版面錨點，而錨點字面
//   今天唯一的來源是註解——這個 repo 有「311 句註解驗出 58 句假」的前科，所以不猜。
// - **未列舉、又不印任何可辨識機構名的銀行**，仍會拿到「用內建版面盡力讀出來的列」。本支只保證
//   不貼錯機構、不自動歸卡、畫面有警語，**不保證不給垃圾列**。

import { squash } from './bank-statement.js';

/** 民國日期（兩種模板）或西元日期——判「像不像交易列」用，刻意比解析器寬。 */
const dateish = (/** @type {string} */ s) => /^\d{2,3}\/\d{2}\/\d{2}$/.test(s) || /^1\d{6}$/.test(s) || /^\d{4}\/\d{2}\/\d{2}$/.test(s);
/** 金額樣（至少一位數字，允許千分位與小數）。 */
const amtish = (/** @type {string} */ s) => /^-?(?=[\d,]*\d)[\d,]+(\.\d+)?$/.test(String(s || '').trim());

/**
 * 這一列**像不像**交易列——用來把它排除在「機構名證據」之外。
 *
 * ⚠️ **刻意不與 `parseFubon`／`parseTaishinPdf` 的列判準共用**，即使長得像。理由是兩處的失敗方向相反：
 * - 抓交易時判**太寬**的代價＝多一筆垃圾；判**太嚴**的代價＝漏一筆錢。
 * - 排除證據時判**太寬**的代價＝證據變少（退回「不猜機構名」＝安全方向）；判**太嚴**的代價＝
 *   **商店名污染身分判定**（就是本支要修的那個病）。
 * 所以這裡寧可**排除過頭**。共用一把尺會讓其中一邊被迫接受另一邊的取捨。
 *
 * @param {string[]} cells
 */
export const looksLikeTxRow = (cells) => Array.isArray(cells) && cells.length >= 3
  && cells.some((c) => dateish(String(c || '').trim())) && cells.some((c) => amtish(c));

/**
 * 自家內建範本的機構名樣式。⚠️ 這是**唯一實作**——`parsePdfAuto` 原本另外寫了一份全文計數版，
 * 已刪（同一件事兩把尺是這個 repo 反覆踩到的病）。
 */
export const OWN_ISSUERS = /** @type {const} */ ([
  { bank: '台新', re: /台\s*新|Taishin|Richart/i },
  { bank: '富邦', re: /富\s*邦|Fubon/i },
]);

/**
 * **否證器**（不是判準——看檔頭劃界）：證據文字裡出現這些字，代表這份帳單很可能是別家印的。
 * ⚠️ 只放**不會與自家撞號**、也**不是通用詞**的機構名（`K1`／`K2` 兩題會機械檢查這兩件事）。
 * ⚠️ 用機構的**銀行名**而不是集團短名（`新光銀行` 而不是 `新光`），因為短名會撞到商店
 * ⚠️ 每一條至少三個字（`K2` 機械檢查）——兩個字的短名（`兆豐`／`花旗`）太容易在廣告與告示裡誤觸發。
 *    （新光三越、遠東百貨）——雖然證據文字已排除交易列，非交易列上仍可能出現廣告與告示。
 */
export const OTHER_ISSUERS = /** @type {const} */ ([
  '國泰世華', '玉山銀行', '玉山商業銀行', '中國信託', '遠東商銀', '遠東國際商業銀行',
  '兆豐銀行', '兆豐國際商業銀行', '第一銀行', '華南銀行', '彰化銀行', '聯邦銀行', '永豐銀行', '元大銀行',
  '星展銀行', '匯豐銀行', '渣打銀行', '花旗銀行', '上海商業儲蓄', '台灣銀行', '合作金庫',
  '安泰銀行', '凱基銀行', '王道銀行', '新光銀行', '陽信銀行', '三信商業銀行',
]);

/**
 * 可以拿來當「機構名證據」的文字＝**解析器沒消耗掉的、又不像交易列的**那些列。
 *
 * ⚠️ `squash` **逐列做、換行保留**：整份 squash 之後，證據可能由「前一列的列尾＋後一列的列頭」
 *    拼出來（`lib/parse-recipe.js:222-225` 記過同一個坑）。
 *
 * @param {string[][]} lines @param {Set<number>} used 解析器自報消耗掉的列索引
 */
export function evidenceText(lines, used) {
  const u = used instanceof Set ? used : new Set();
  return (lines || [])
    .filter((l, i) => !u.has(i) && !looksLikeTxRow(l))
    .map((l) => squash((l || []).join('')))
    .join('\n');
}

/**
 * 判斷這份帳單的機構身分。
 * @param {string[][]} lines
 * @param {Set<number>} used 兩支解析器消耗掉的列索引**聯集**（與「最後採用哪一支」無關 ⇒ 不循環）
 * @returns {{ bank: string, bankEvidence: 'header'|'none', own: string[], other: string[] }}
 */
export function identifyIssuer(lines, used) {
  const text = evidenceText(lines, used);
  const own = OWN_ISSUERS.filter((o) => o.re.test(text)).map((o) => o.bank);
  const other = OTHER_ISSUERS.filter((n) => text.includes(n));
  // 只有「唯一一家自家、且沒有任何別家」才敢掛機構名。其餘一律不猜。
  const sure = own.length === 1 && other.length === 0;
  return { bank: sure ? own[0] : '', bankEvidence: sure ? 'header' : 'none', own, other };
}

/**
 * 機構名的證據種類。
 * - `header`＝PDF：機構名出現在「解析器沒消耗掉、又不像交易列」的列上（本檔的判準）
 * - `xlsx-template`＝XLSX：內建欄位版面對得上。⚠️ 這**比 header 弱**——XLSX 那條路是靠
 *   **欄位位置**（第 0/2/4/7 欄）認的，沒有任何欄名或機構名比對，所以別家 XLSX 只要欄序不同
 *   就會靜靜抄錯欄。刻意給它一個**不同的名字**而不是混進 `header`，是為了讓「這份的身分有多可靠」
 *   在型別上就看得出來，而不是靠讀註解。
 * - `none`＝沒有夠格的證據 ⇒ `bank` 必須是空字串
 * @typedef {'header'|'xlsx-template'|'none'} BankEvidence
 */

/**
 * 輸出不變量——違反代表**我們的程式有 bug**（不是使用者的檔案有問題），所以丟 500。
 *
 * ⚠️ **刻意 throw 而不是把值夾正**。夾正（`seal`）會讓「把身分算錯」與「把值修好」互相蒙眼，
 *    屬性測試就變成恆真——工作流的對抗驗證實測過：改成夾正之後，「挑筆數多者」那顆突變全綠。
 *
 * @param {{ bank: string, bankEvidence: string, rows: unknown[], code?: string|null }} r
 */
export function assertCardIdentityInvariants(r) {
  const bad = (/** @type {string} */ why) => {
    throw Object.assign(new Error(`卡片身分不變量被違反：${why}`), { status: 500, code: 'card_identity_invariant' });
  };
  if (r.code && (r.rows.length !== 0 || r.bank !== '')) bad('丟錯時不得同時交出列或機構名');
  if (r.bank !== '' && r.bankEvidence === 'none') bad('掛了機構名就必須說得出證據來源');
  if (!['header', 'xlsx-template', 'none'].includes(r.bankEvidence)) bad(`證據種類 ${r.bankEvidence} 不是已知的三種之一`);
  if (r.bank !== '' && !OWN_ISSUERS.some((o) => o.bank === r.bank)) bad(`機構名 ${r.bank} 不在內建範本清單裡`);
  if (r.bankEvidence === 'none' && r.bank !== '') bad('沒有證據就不得掛機構名');
  return r;
}
