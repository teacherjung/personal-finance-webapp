// @ts-check
// 資料存取「單一櫃檯」（B1）：所有讀寫資料的動作都經過這裡。
// 櫃檯後面是 SQLite data/store.db（lib/store.js，B3）；再換引擎也只改 store.js，
// 其他程式（路由、業務邏輯）一行都不用動。
// 規矩：server.js 與 services 一律 import 本檔，不要直接 import store.js（AGENTS.md）。
import { load, save, uid, emptyDb } from './store.js';
/** @typedef {import('./types.js').Db} Db */
/** @typedef {import('./types.js').Settings} Settings */

export { uid, emptyDb };   // 由櫃檯統一轉供（呼叫端不必知道 store.js 的存在）

/** 讀整包資料（複雜流程用：IB 同步、帳單匯入、總覽計算…）。 @returns {Db} */
export function getDb() { return load(); }

/** 寫回整包資料（與 getDb 成對使用）。 @param {Db} db */
export function saveDb(db) { save(db); return db; }

/** 讀某個集合（不存在回空陣列）。 @param {string} col @returns {any[]} */
export function getCollection(col) { return /** @type {any} */ (load())[col] || []; }

/** 新增一筆（自動配 id）並存檔。 @param {string} col @param {Record<string, any>} fields */
export function addItem(col, fields) {
  const db = /** @type {any} */ (load());
  const item = { id: uid(), ...fields };
  (db[col] ||= []).push(item);
  save(db);
  return item;
}

/**
 * 更新一筆並存檔；找不到回 null。
 * beforeSave(db, item)：同一次寫入內順帶的其他更新（例：帳單交易改分類→寫入學習表），
 * 確保「更新＋附帶效果」一次寫檔完成，不會存到一半。
 * @param {string} col @param {string} id @param {Record<string, any>} patch
 * @param {(db: Db, item: any) => void=} beforeSave
 */
export function updateItem(col, id, patch, beforeSave) {
  const db = /** @type {any} */ (load());
  const list = db[col] || [];
  const i = list.findIndex((/** @type {any} */ x) => x.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, id };
  if (beforeSave) beforeSave(db, list[i]);
  save(db);
  return list[i];
}

/** 刪除一筆並存檔。 @param {string} col @param {string} id */
export function deleteItem(col, id) {
  const db = /** @type {any} */ (load());
  db[col] = (db[col] || []).filter((/** @type {any} */ x) => x.id !== id);
  save(db);
}

/** 讀設定。 @returns {Settings} */
export function getSettings() { return load().settings; }

/** 部分更新設定（巢狀的 ib / fxTwd 用合併、不整包蓋掉）並存檔。 @param {Record<string, any>} patch */
export function updateSettings(patch) {
  const db = load();
  db.settings = {
    ...db.settings, ...patch,
    ib: { ...db.settings.ib, ...(patch.ib || {}) },
    fxTwd: { ...db.settings.fxTwd, ...(patch.fxTwd || {}) }
  };
  save(db);
  return db.settings;
}
