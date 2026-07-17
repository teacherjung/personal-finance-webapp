// @ts-check
// 帳單「自動學習」的全部邏輯（B2 集中一處）：套用學習、從編輯學、從匯入學。
// 學習表＝db.learnedCategories：{ storeKey(cleanStore 後原名) → {category, subcategory, name?} }。
// ⚠️「國外交易服務費」不學：它的說明帶當筆金額（國外交易服務費-2350.00），每筆 key 都不同，
//    學了永遠不會再命中，只會讓學習表無限膨脹；它的分類本來就由 statement.js finalize
//    繼承前一筆消費，不需要也不該學（使用者定，2026-07）。判準用 statement.js 的 isServiceFee。
// 詳細規矩見 AGENTS.md「帳單自動學習」同步點列。
import { categorize, isServiceFee } from '../statement.js';
/** @typedef {import('../types.js').Db} Db */

/**
 * 套用學習：依店名（cleanStore 後的 store）套用使用者過往修正過的分類/顯示名，優先於內建規則。
 * 回傳的每筆都帶 storeKey（穩定 key，匯入端存起來、日後學習用）。
 * @param {Db} db @param {any[]} txs
 */
export function applyLearned(db, txs) {
  const learned = db.learnedCategories || {};
  return txs.map(t => {
    const key = t.store || '';                 // cleanStore(desc)＝穩定 key（即使之後改顯示名也不變）
    // 服務費「套用端」也要擋（自審 r2，中）：擋新增不夠——學習表若還有舊的服務費紀錄（清理前、
    // 或從備份還原），固定金額的月費會重複命中同一 key，把 finalize 的「繼承前一筆」正確分類蓋掉。
    if (isServiceFee(key) || isServiceFee(t.desc)) return { ...t, storeKey: key };
    const l = learned[key];
    const out = { ...t, storeKey: key };
    if (l) {
      if (l.name) out.store = l.name;                                                     // 套用學過的顯示店名
      if (l.category) { out.category = l.category; out.subcategory = l.subcategory || ''; } // 套用學過的分類
    }
    return out;
  });
}

/**
 * 從「編輯帳單交易」學（掛在通用 CRUD 的 beforeSave）：只學 source:'stmt'，避免手動記帳污染。
 * 改了顯示名（note≠storeKey）→ 記 name；改回自動名 → 清除 name。
 * @param {Db} db @param {any} item
 */
export function learnFromStmtEdit(db, item) {
  if (item.source !== 'stmt') return;
  const key = item.storeKey || item.note;   // 穩定 key（改顯示名也不變）；舊資料無 storeKey 時退用 note
  // 服務費不學（見檔頭說明）。storeKey 與 note 都要驗：舊資料（無 storeKey）改顯示名時
  // key＝新 note、看不出是服務費——但原始 storeKey 仍可能是（自審 r2，低）。
  if (!key || isServiceFee(key) || isServiceFee(item.storeKey) || isServiceFee(item.note)) return;
  const e = (db.learnedCategories ||= {})[key] || {};
  e.category = item.category || ''; e.subcategory = item.subcategory || '';
  if (item.note && item.note !== key) e.name = item.note;
  else delete e.name;
  db.learnedCategories[key] = e;
}

/**
 * 從「匯入時的選擇」學：使用者選的分類與內建規則不同才記（避免整表爆），保留既有的顯示名學習。
 * @param {Db} db @param {string} storeKey @param {string} desc 原始說明 @param {string} category @param {string} subcategory
 */
export function learnFromImport(db, storeKey, desc, category, subcategory) {
  if (!storeKey || isServiceFee(storeKey) || isServiceFee(desc)) return;   // 服務費不學（見檔頭說明）
  const [rc, rs] = categorize(String(desc || ''));
  if (category === rc && subcategory === (rs || '')) return;
  const e = (db.learnedCategories ||= {})[storeKey] || {};
  e.category = category; e.subcategory = subcategory;
  db.learnedCategories[storeKey] = e;
}
