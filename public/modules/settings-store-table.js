// @ts-check
// 設定頁「帳單說明／分類學習」店家表的純資料層（零相依，同 month-select.js 慣例：呼叫端注入 esc）。
// 表頭三角形與點擊綁定沿用 tx-sort.js 的共用件（同收支頁／訂閱頁的外觀），這裡只放「排序怎麼比」
// 與「分類儲存格長什麼樣」兩件會出錯、值得考題鎖住的事。

const zh = (/** @type {any} */ a, /** @type {any} */ b) => String(a || '').localeCompare(String(b || ''), 'zh-Hant');

/** @type {Record<string, (a: any, b: any) => number>} 四欄各自的主鍵比較器（升冪） */
const SORTERS = {
  orig: (a, b) => zh(a.orig, b.orig),   // 帳單原文（銀行印的）
  key: (a, b) => zh(a.key, b.key),      // 身分鑰匙（品牌層）
  cur: (a, b) => zh(a.cur, b.cur),      // 顯示名
  cat: (a, b) => zh(a.cat, b.cat) || zh(a.sub, b.sub),   // 分類：大類優先、同大類再比子類
};

/** 預設＝顯示名 A→Z（沿用加排序鈕之前的行為，使用者的既有肌肉記憶不變）。 */
export const STORE_SORT_DEFAULT = { key: 'cur', dir: 'asc' };

/**
 * 依 sort 排序（回傳新陣列，不動原陣列）。
 * ⚠️ 升降冪只作用在「主鍵」，同值時的第二鍵**固定**顯示名 A→Z、不跟著反轉——把整個比較器乘 -1
 * 會讓同值列在降冪時整組倒過來，看起來像資料自己在跳（同 tx-sort.js 記取的教訓）。
 * @param {any[]} rows @param {{key:string, dir:string}} sort @returns {any[]}
 */
export function sortStoreRows(rows, sort) {
  const cmp = (Object.hasOwn(SORTERS, sort?.key || '') && SORTERS[sort.key]) || SORTERS.cur;
  const list = Array.isArray(rows) ? rows.slice() : [];
  return list.sort((a, b) => (sort?.dir === 'desc' ? -cmp(a, b) : cmp(a, b)) || zh(a.cur, b.cur));
}

/**
 * 分類儲存格：**大分類第一行、子分類第二行**（使用者定 2026-07-26：拿掉中間的「·」）。
 * 沒有子分類就只有一行。 @param {any} row @param {(s:any)=>string} esc @returns {string}
 */
export function storeCatCell(row, esc) {
  const cat = String(row?.cat || '').trim();
  const sub = String(row?.sub || '').trim();
  return `${esc(cat)}${sub ? `<div class="muted" style="font-size:12px">${esc(sub)}</div>` : ''}`;
}
