// @ts-check
// 帳單「自動學習」的全部邏輯（B2 集中一處）：套用學習、從編輯學、從匯入學。
// 學習表＝db.learnedCategories：{ storeKey(cleanStore 後原名) → {category, subcategory, name?} }。
// ⚠️「國外交易服務費」不學：它的說明帶當筆金額（國外交易服務費-2350.00），每筆 key 都不同，
//    學了永遠不會再命中，只會讓學習表無限膨脹；它的分類本來就由 statement.js finalize
//    繼承前一筆消費，不需要也不該學（使用者定，2026-07）。判準用 statement.js 的 isServiceFee。
// 詳細規矩見 AGENTS.md「帳單自動學習」同步點列。
import { categorize, isServiceFee } from '../statement.js';
import { resolveImportCategory } from './categories.js';
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
    // 原文級覆蓋（2026-07-18，店名對照表逐列改名）：key＝帳單原文（t.desc）。銀行截斷的店名會讓
    // 不同分店共用同一個 storeKey（FP-12MINI (桃/(新 → 都是 12MINI），原文級才能各自取名——優先於 storeKey 級。
    const fine = learned[String(t.desc || '')];
    if (fine) {
      if (fine.name) out.store = fine.name;
      if (fine.category) { out.category = fine.category; out.subcategory = fine.subcategory || ''; }
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
  // 只用 storeKey 當 key（Codex#10-8：無 storeKey 的舊資料一律不學）——note 可被使用者改名，
  // 原始店名身分已不可考，退用 note 會把規則掛在錯的 key 上（永不命中、或劫持真的同名店家）。
  const key = item.storeKey;
  if (!key || isServiceFee(key) || isServiceFee(item.note)) return;   // 服務費不學（見檔頭說明）
  const e = (db.learnedCategories ||= {})[key] || {};
  e.category = item.category || ''; e.subcategory = item.subcategory || '';
  if (item.note && item.note !== key) e.name = item.note;
  else delete e.name;
  db.learnedCategories[key] = e;
}

/**
 * 從「匯入時的選擇」學：只記「使用者手動改成與『完整自動判斷』不同」的分類（避免整表爆）。
 * ⚠️ Codex#2：必須比對「完整自動＝categorize→resolveImportCategory（含別名/生效樹校正）」，不是只比內建
 * categorize——否則別名結果（娛樂→休閒）會被重記成共用 storeKey 規則，日後移除別名仍被鎖住。
 * 且若該原文已有「原文級」學習（rename-store 寫的），不可再升級成共用 storeKey（會污染同 storeKey 的其他分店）。
 * @param {Db} db @param {string} storeKey @param {string} desc 原始說明 @param {string} category @param {string} subcategory
 */
export function learnFromImport(db, storeKey, desc, category, subcategory) {
  const d = String(desc || '');
  if (!storeKey || isServiceFee(storeKey) || isServiceFee(d)) return;   // 服務費不學（見檔頭說明）
  if (db.learnedCategories?.[d]?.category) return;                      // 原文級已涵蓋→不升級成共用 storeKey（Codex#2）
  const [ac, asub] = resolveImportCategory(db, ...categorize(d));       // 完整自動結果（含別名/生效樹校正）
  if (category === ac && (subcategory || '') === (asub || '')) return;  // 與自動相同＝沒有新資訊，不學
  const e = (db.learnedCategories ||= {})[storeKey] || {};
  e.category = category; e.subcategory = subcategory;
  db.learnedCategories[storeKey] = e;
}
