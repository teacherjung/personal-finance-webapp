// @ts-check
// 彈窗表單下拉選項的產生器（零依賴純模組：不碰 DOM／API，考題可以直接 import 跑行為級斷言）。
//
// ## 這一檔在修的是「靜靜改掉使用者資料」的通用坑（William 2026-08-05 拍板）
//
// `public/app.js` 的 `openForm` 產生下拉時，原本只在「選項的值與現在的值**完全相同**」時才加
// `selected`，送出時直接讀 `select.value`。所以**當某筆資料現在的值不在選項清單裡，瀏覽器會自動
// 選第一項**——使用者只是打開表單改個別的欄位按儲存，那個欄位就被靜靜改掉了，畫面零提示。
//
// 已查證的實害（不是假設）：帳戶型別在 `lib/schema.js` 的 `FIELD_SCHEMA.accounts.type` 有九個合法值，
// 而帳戶表單當時只列七個，漏掉兩個負債型別（其他負債、信用卡未繳餘額）。型別是那兩種的帳戶，
// 在資產頁打開、只改個名字按儲存 ⇒ 靜靜 PUT 成現金型別，50 萬負債變 50 萬資產、淨資產一次跳 100 萬。
//（那兩個型別本身已由 `public/modules/accounts-model.js` 收成單一真相——本檔刻意不重抄型別代碼，
//  `test/exposure-sync-integrity.test.js` 有一題全站掃描只准三個宣告過的檔案出現那些字串；
//  **本檔修的是機制**——同一個坑在幣別（`accounts-model.js` 的 `ACCOUNT_CURRENCIES`、投資頁的
//  `PORTFOLIO_CURRENCIES`）、卡別（`cards.js` 的 `NETWORKS`）、訂閱的分類與提醒天數、續費卡片…
//  每一個「由 `openForm` 的 `options` 餵出來」的下拉都成立。⚠️ **分類下拉不在這一句裡面**，
//  理由見下面的誠實劃界——第一版註解把它算進來，那是錯的。）
//
// ## 處置：現在的值不在選項裡時，**保留它**（渲染成一個標了 selected 的選項），不可靜靜換成第一項
//
// 分層說清楚（兩層都要，不是重複）：
//   ・**呼叫端**若想給更好的字（例：`subscriptions.js` 的「（已失效，請更新）」、
//     `transactions.js`／`cashflow.js` 的 `accountOptions(…, current)` 直接把現值 unshift 進去並顯示原名），
//     就自己把現值放進 options——那時本檔什麼都不會多做（值有命中）。
//   ・**沒有人處理時**，本檔是最後一道網：補一個帶提示字的選項擺在最前面，寧可畫面多一列，
//     也不要使用者的資料被靜靜換掉。
//
// ## ⚠️ 誠實劃界：本檔只覆蓋「`openForm` 用 `options` 產出來」的下拉
//
// `openForm` 產完之後，好幾張表單會在 `onMount` 裡把某個 `<select>` 的 `innerHTML` **整段覆寫**
//（分類要跟著金流連動、子類要跟著分類連動）。那些下拉**走不到 `openForm` 那條路**，本檔的保留機制
// 對它們一點效果都沒有——除非那一處自己來呼叫本檔的函式。#415 自審抓到「分類」正是這一類，
// 而且其中兩處當時仍是同一個病（舊病，不是 #415 弄壞的）。現況逐處列名：
//
//   ・`cashflow.js` `fillCats`（收支的**父分類**）——原本 `parents.includes(curCat) ? curCat : parents[0]`：
//     分類事後被刪掉、或匯入資料帶著舊分類時，一打開表單就被靜靜換成第一個父分類，按儲存就寫進去。
//     **已改走本檔的 `selectOptionsHtml` ＋ `effectiveSelectValue`。**
//   ・`transactions.js` `subOptions`（信用卡明細的**子類**）——原本沒有把清單外的現值補回去：
//     子類被刪掉後，編輯任一筆就被靜靜清成空白。**已改走本檔的 `subcategoryOptionsHtml`。**
//   ・`cashflow.js` `subOptionsFor`、`settings.js` 店家編輯的 `fill`（子類）——這兩處本來就有
//     `unshift` 保留現值（沒有病）；一併收成 `subcategoryOptionsHtml`，讓「保留現值」只有一份實作。
//
// 刻意**不**套用本機制、而且沒有這個病的下拉（`grep '<option'` 逐處看過，不是憑印象）：
//   ・`settings.js` 的帳務體檢（`openHealthCheck`）：那些下拉是「替**未分類**的項目挑一個新分類」，
//     沒有「現在的值」可保留，套上去只會多一列廢選項。
//   ・`transactions-import.js` 帳單匯入預覽的分類／卡片下拉：資料還沒進資料庫，改的是候選值。
//   ・`month-select.js`／`history.js`／`securities.js` 的月份、年份與篩選下拉：那些是**檢視條件**、
//     不是某筆紀錄的欄位，選錯不會改資料（`month-select.js` 自己還有「清單空了就顯示現值」的退路）。
//   ・`settings-store-rules.js` 的比對模式：值域封閉（包含／開頭是／完全等於），只由那張 UI 自己寫入。
//   ・`openForm` 的 checkbox 那個自製下拉（值 `'true'`／`'false'`），理由見 `app.js` 該處註解。
//
// **本檔不宣稱全站的下拉都安全。** 考題釘得住的只有：本檔三個函式的行為、`app.js` 真的把
// `f.options` 與這一欄現在的值餵進來、以及上面四處確實改走本檔（`test/form-options.test.js`）。
// 沒有任何一題會在「別人新開一張表單、又自己拼一份選項」時轉紅。
//
// 已知**還沒修**的同族缺口（另案，本支刻意不動）：`cashflow.js` 的支出分類下拉沒有「不分類」這一項，
// 而銀行匯入的「繳卡費」那筆 `category` 是**刻意留空**的（`lib/services/bank-import.js`：卡明細已分好類，
// 這裡再分會重複統計）。空值在本檔判準裡不算「值」（見下面的刻意邊界），所以打開那筆收支按儲存，
// 分類會被指派成第一個父分類、那筆錢從此進了分類統計。要修得先決定「空分類要不要在下拉裡現身」
//（產品決定，交 William），不是本檔改個判準的事。
//
// ## 刻意的邊界
//
// ・**空值不算「值」**（`''`／`null`／`undefined`）：那是「還沒選」，原本「選第一項」就是對的行為，
//   不可因此長出一個空白選項。判準用 `String(value) === ''`（不 trim）——只認真正的空字串，
//   不去猜「全是空白算不算空」，行為才可預期。
// ・值有命中時，輸出**與舊寫法逐字相同**（含未選中時 `"` 與 `>` 之間那個空格）——
//   修這個坑不可以順手改壞既有的每一張表單。考題用一份「舊寫法」參考實作逐字比對釘住。

import { esc } from './html-escape.js';

/** 下拉選項：純字串（值＝標籤），或 `{value, label}`。 @typedef {string | {value: string, label: string}} FormSelectOption */

/**
 * 「保留下來的現值」那一項的提示字（放在值後面的括號裡）。
 * 文案是給**沒有程式背景**的使用者看的：不出現英文技術詞，只講「這是你現在的設定、清單裡沒有它」。
 * ⚠️ 專案慣例＝文案由 Claude 起草、William 審改；改字要連本檔考題一起改。
 *（#415 自審改過一次字：原本是「不在標準選項裡」——「標準」像術語，而且暗示「你的資料不標準」，
 *  沒有程式背景的人第一反應容易是「我的資料壞了嗎」。改成純事實描述「清單裡沒有這一項」。）
 */
export const UNLISTED_VALUE_NOTE = '目前的設定，清單裡沒有這一項';

/** 一個選項的值（純字串選項＝值本身）。 @param {FormSelectOption | undefined} o */
const valueOf = (o) => (typeof o === 'string' ? o : o?.value);

/**
 * 產生一個 `select` 的內層選項 HTML。
 *
 * @param {FormSelectOption[] | undefined | null} options 忘給或給了非陣列時＝空下拉，不整頁掛掉（沿用舊行為）
 * @param {unknown} value 這筆資料現在的值（`openForm` 已先解析成 `values[key] ?? default ?? ''`）
 * @returns {string}
 */
export function selectOptionsHtml(options, value) {
  const list = Array.isArray(options) ? options : [];
  const cur = value === null || value === undefined ? '' : String(value);
  let hit = false;
  const html = list.map(o => {
    const ov = valueOf(o);
    const ol = typeof o === 'string' ? o : o?.label;
    const selected = String(ov) === cur;
    if (selected) hit = true;   // 多個選項同值時舊行為是全部標 selected（瀏覽器取最後一個）——原樣保留
    return `<option value="${esc(ov)}" ${selected ? 'selected' : ''}>${esc(ol)}</option>`;
  }).join('');
  if (hit || cur === '') return html;
  // 現值沒有任何選項命中 ⇒ 補在**最前面**並標 selected：使用者一打開就看得到自己現在的設定，
  // 而且不管有沒有動這個欄位，按儲存送出的都還是同一個值。
  return `<option value="${esc(cur)}" selected>${esc(cur)}（${UNLISTED_VALUE_NOTE}）</option>` + html;
}

/**
 * 「使用者不去動這個下拉的話，送出去會是哪個值」——與 `selectOptionsHtml` **同一套判準**的孿生函式。
 *
 * 給「`onMount` 事後重建選項」的呼叫端用：它們拼完 HTML 之後還得知道「現在選中的是誰」，
 * 才能連動下一層下拉（例：分類決定子類）。刻意做成共用函式、不讓呼叫端自己再寫一次空值判準——
 * 兩份判準走散就會長出「HTML 保留了現值、連動卻拿第一項去算」這種半修好的狀態。
 *
 * @param {FormSelectOption[] | undefined | null} options
 * @param {unknown} value
 * @returns {string} 非空的現值原樣回傳（`selectOptionsHtml` 保證它被渲染且 selected）；空值＝退回第一項
 */
export function effectiveSelectValue(options, value) {
  const list = Array.isArray(options) ? options : [];
  const cur = value === null || value === undefined ? '' : String(value);
  if (cur !== '') return cur;   // 非空的現值一律保留：命中就選它、沒命中由 selectOptionsHtml 補一項
  const first = valueOf(list[0]);
  return first === null || first === undefined ? '' : String(first);
}

/**
 * 子分類下拉的選項 HTML：**唯一**一份「（不分子類）空選項 ＋ 保留清單外的現值」實作。
 *
 * 三處 `onMount` 各自抄過一份（`transactions.js`／`cashflow.js`／`settings.js`），其中
 * `transactions.js` 那份漏了保留現值 ⇒ 子類被刪掉後，編輯任一筆就被靜靜清成空白。收成一份之後，
 * 「漏了保留」只可能發生在這裡，而這裡有考題。
 *
 * 輸出與收斂前的三份**逐字相同**（`（不分子類）` 的標籤、`"` 與 `>` 之間那個空格都照舊）。
 *
 * @param {string[]} subs 選項值，`''` ＝不分子類（要不要放空選項由呼叫端決定：內轉有時刻意不放）
 * @param {string} [cur] 這筆資料現在的子類
 * @returns {string}
 */
export function subcategoryOptionsHtml(subs, cur = '') {
  const list = (Array.isArray(subs) ? subs : []).map(s => String(s ?? ''));
  // 現值是清單外的孤兒（子類被改名／刪除後的舊值）→ 補在最前面，不可被 <select> 默默選成第一項
  const opts = (cur && !list.includes(cur)) ? [cur, ...list] : list;
  return opts.map(s => `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${s === '' ? '（不分子類）' : esc(s)}</option>`).join('');
}
