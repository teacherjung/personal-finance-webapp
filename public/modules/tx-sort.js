// @ts-check
// 交易列表的共用排序 infra（三層重構 stage 1：信用卡明細頁與收支頁共用同一份，避免雙軌走鐘）。
// 兩條鐵則封在這裡、只有一份：
//  ⚠️ Codex r8#2：升降冪只作用在「主鍵」，同值時的第二鍵**固定**日期新→舊、不跟著反轉
//     （把整個比較器乘 -1 會把第二鍵一起反轉，降冪時同名資料變舊→新）。
//  ⚠️ Codex r8#4/r9#2：金額口徑＝**絕對金額大小**（收/支都存正數；這欄用途是找「大筆」，收支混排比正負直覺）。
import { esc } from '../app.js';

const zh = (/** @type {any} */ x, /** @type {any} */ y) => String(x || '').localeCompare(String(y || ''), 'zh-Hant');
const byDateDesc = (/** @type {any} */ a, /** @type {any} */ b) => (b.date || '').localeCompare(a.date || '');

/** @type {Record<string, (a: any, b: any) => number>} 各欄位主鍵比較器（升冪） */
const SORTERS = {
  date: (a, b) => (a.date || '').localeCompare(b.date || ''),
  account: (a, b) => zh(a.account, b.account),
  note: (a, b) => zh(a.note, b.note),
  category: (a, b) => zh(a.category, b.category) || zh(a.subcategory, b.subcategory),
  subcategory: (a, b) => zh(a.subcategory, b.subcategory),
  amount: (a, b) => Math.abs(Number(a.amount || 0)) - Math.abs(Number(b.amount || 0))
};

/** 依 listSort 排序（回傳新陣列，不動原陣列）。 @param {any[]} rows @param {{key:string,dir:string}} listSort */
export function sortRows(rows, listSort) {
  const cmp = SORTERS[listSort.key] || SORTERS.date;
  return rows.slice().sort((a, b) => (listSort.dir === 'desc' ? -cmp(a, b) : cmp(a, b)) || byDateDesc(a, b));
}

/** 產生可點排序的表頭 <th>（三角形指示同訂閱頁 .sortable/.sort-tri）。 @param {{key:string,dir:string}} listSort */
export function thBuilder(listSort) {
  return (/** @type {string} */ key, /** @type {string} */ label, cls = '') => {
    const on = listSort.key === key;
    return `<th class="sortable ${cls}" data-sort="${key}" title="點擊排序">${esc(label)} <span class="sort-tri${on ? ' active' : ''}">${on ? (listSort.dir === 'asc' ? '▲' : '▼') : '▾'}</span></th>`;
  };
}

/**
 * 綁定表頭點擊排序：同欄再點＝反轉；換欄＝日期/金額預設降冪（新/大在前）、文字欄預設升冪。
 * 就地改 listSort（呼叫端持有的物件），再呼叫 rerender。
 * @param {Element} viewEl 含 th.sortable 的容器 @param {{key:string,dir:string}} listSort @param {() => void} rerender
 */
export function bindSortClicks(viewEl, listSort, rerender) {
  viewEl.querySelectorAll('th.sortable').forEach(el => /** @type {HTMLElement} */ (el).onclick = () => {
    const key = /** @type {HTMLElement} */ (el).dataset.sort || 'date';
    if (listSort.key === key) listSort.dir = listSort.dir === 'asc' ? 'desc' : 'asc';
    else { listSort.key = key; listSort.dir = (key === 'date' || key === 'amount') ? 'desc' : 'asc'; }
    rerender();
  });
}
