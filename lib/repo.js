// @ts-check
// 資料存取「單一櫃檯」（B1）：所有讀寫資料的動作都經過這裡。
// 櫃檯後面是 SQLite data/store.db（lib/store.js，B3）；再換引擎也只改 store.js，
// 其他程式（路由、業務邏輯）一行都不用動。
// 規矩：server.js 與 services 一律 import 本檔，不要直接 import store.js（AGENTS.md）。
import { load, save, uid, emptyDb, backupNow, normalizeLedger } from './store.js';
import { setUserRules } from './store-rules.js';
/** @typedef {import('./types.js').Db} Db */
/** @typedef {import('./types.js').Settings} Settings */

export { uid, emptyDb, backupNow, normalizeLedger };   // 由櫃檯統一轉供（呼叫端不必知道 store.js 的存在）

/**
 * 「**規則入櫃檯**」（第三帖，2026-07-19）：使用者自訂的店名規則存在 `settings.storeRules`，
 * 但 `lib/statement.js` 是純函式模組（測試直接 import、不碰資料庫）不能自己讀 settings——
 * 所以由櫃檯在每次讀取時把規則餵給 `store-rules.js` 的模組級單例。
 *
 * 為什麼裝在櫃檯（比照 B3「驗證入櫃檯」）：任何要用到店名規則的程式碼，**一定**得先向櫃檯拿資料，
 * 所以在這裡同步就「結構上不可能忘記」——不必在每個新端點記得呼叫、也不必為此多讀一次檔。
 * 值沒變時 `setUserRules` 直接返回（只比對一小段 JSON），對每次讀取的成本可忽略。
 * **本檔所有讀取一律走這裡、不要直接呼叫 `load()`**——漏一處就會有路徑拿到過期規則。
 * @returns {Db}
 */
function loadSynced() {
  const db = load();
  try { setUserRules(db.settings?.storeRules); }
  catch (e) { console.warn('[repo] 店名規則同步失敗（沿用上一版規則）:', /** @type {any} */ (e)?.message); }
  return db;
}

/** 讀整包資料（複雜流程用：IB 同步、帳單匯入、總覽計算…）。 @returns {Db} */
export function getDb() { return loadSynced(); }

/** 寫回整包資料（與 getDb 成對使用）。 @param {Db} db */
export function saveDb(db) { save(db); return db; }

/** 讀某個集合（不存在回空陣列）。 @param {string} col @returns {any[]} */
export function getCollection(col) { return /** @type {any} */ (loadSynced())[col] || []; }

/** 新增一筆（自動配 id）並存檔。 @param {string} col @param {Record<string, any>} fields */
export function addItem(col, fields) {
  const db = /** @type {any} */ (loadSynced());
  const item = { id: uid(), ...fields };
  (db[col] ||= []).push(item);
  save(db);
  return item;
}

/**
 * 更新一筆並存檔；找不到回 null。
 * beforeSave(db, item, prev)：同一次寫入內順帶的其他更新（例：帳單交易改分類→寫入學習表、
 * 顯示名跟著新分類重算），確保「更新＋附帶效果」一次寫檔完成，不會存到一半。
 * `prev`＝更新前的那一筆（淺拷貝快照）——**判斷「使用者這次到底改了什麼」必須靠它**：
 * 前端表單是整份送出的，`patch` 裡一定有 note，光看 patch 分不出「改了店名」還是「只改分類」。
 * @param {string} col @param {string} id @param {Record<string, any>} patch
 * @param {(db: Db, item: any, prev: any) => void=} beforeSave
 */
export function updateItem(col, id, patch, beforeSave) {
  const db = /** @type {any} */ (loadSynced());
  const list = db[col] || [];
  const i = list.findIndex((/** @type {any} */ x) => x.id === id);
  if (i < 0) return null;
  const prev = { ...list[i] };
  list[i] = { ...list[i], ...patch, id };
  if (beforeSave) beforeSave(db, list[i], prev);
  save(db);
  return list[i];
}

/** 刪除一筆並存檔。 @param {string} col @param {string} id */
export function deleteItem(col, id) {
  const db = /** @type {any} */ (loadSynced());
  db[col] = (db[col] || []).filter((/** @type {any} */ x) => x.id !== id);
  save(db);
}

/** **整批取代**某集合並存檔（原子：單次寫檔，全有或全無）。呼叫端負責先驗證每筆＋配好 id——本函式不再驗證。
 * 用途＝「先清空再重建」型的儲存（如資產配置目標）不必 GET→逐筆 DELETE→逐筆 POST（中途失敗會半刪半建）。
 * @param {string} col @param {any[]} items @returns {any[]} */
export function replaceCollection(col, items) {
  const db = /** @type {any} */ (loadSynced());
  db[col] = items;
  save(db);
  return db[col];
}

/** 讀設定。 @returns {Settings} */
export function getSettings() { return loadSynced().settings; }

/** 部分更新設定（巢狀的 ib / fxTwd 用合併、不整包蓋掉）並存檔。 @param {Record<string, any>} patch */
export function updateSettings(patch) {
  const db = loadSynced();
  db.settings = {
    ...db.settings, ...patch,
    ib: { ...db.settings.ib, ...(patch.ib || {}) },
    fxTwd: { ...db.settings.fxTwd, ...(patch.fxTwd || {}) },
    // signals 同樣要巢狀合併（自審 r2，中）：整包取代會讓「只更新中國 PE」抹掉其他四個市場的手動估值
    signals: { ...db.settings.signals, ...(patch.signals || {}) }
  };
  save(db);
  return db.settings;
}
