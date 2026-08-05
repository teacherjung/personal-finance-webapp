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
//  **本檔修的是機制**——幣別、分類、卡片、週期…每一個下拉都踩同一個坑。）
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
// ## 刻意的邊界
//
// ・**空值不算「值」**（`''`／`null`／`undefined`）：那是「還沒選」，原本「選第一項」就是對的行為，
//   不可因此長出一個空白選項。判準用 `String(value) === ''`（不 trim）——只認真正的空字串，
//   不去猜「全是空白算不算空」，行為才可預期。
// ・值有命中時，輸出**與舊寫法逐字相同**（含未選中時 `"` 與 `>` 之間那個空格）——
//   修這個坑不可以順手改壞既有的每一張表單。考題用一份「舊寫法」參考實作逐字比對釘住。
// ・`openForm` 的 checkbox 那個自製下拉（值 `'true'`／`'false'`）**刻意不套用本機制**，理由見 `app.js` 該處註解。

import { esc } from './html-escape.js';

/** 下拉選項：純字串（值＝標籤），或 `{value, label}`。 @typedef {string | {value: string, label: string}} FormSelectOption */

/**
 * 「保留下來的現值」那一項的提示字（放在值後面的括號裡）。
 * 文案是給**沒有程式背景**的使用者看的：不出現英文技術詞，只講「這是你現在的設定、它不在標準選項裡」。
 * ⚠️ 專案慣例＝文案由 Claude 起草、William 審改；改字要連本檔考題一起改。
 */
export const UNLISTED_VALUE_NOTE = '目前的設定，不在標準選項裡';

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
    const ov = typeof o === 'string' ? o : o?.value;
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
