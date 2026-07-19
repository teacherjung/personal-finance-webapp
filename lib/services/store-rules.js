// @ts-check
// 店名規則自助管理（第三帖，使用者定 2026-07-19）：讀取／預覽影響／套用。
//
// 「預覽影響」是這一帖的安全帶：規則是全庫生效的，一條寫太寬的規則可能把幾百筆店名改壞。
// 所以套用前一定先跑一次 dryRun——**用候選規則暫時上線、跑既有的 normalizeBranches(dryRun)、
// 再還原**——讓使用者看到「這條規則會動到哪幾筆、變成什麼樣」才決定要不要存。
import { getDb, saveDb } from '../repo.js';
import { setRulesOverride, sanitizeStoreRules, emptyStoreRules } from '../store-rules.js';
import { normalizeBranches, normalizeIfRulesChanged } from './statement-import.js';
import { origFromStmtRef } from '../statement.js';

/** @param {number} status @param {string} msg */
const apiError = (status, msg) => Object.assign(new Error(msg), { status });

/** 目前的使用者規則（沒設定過＝空規則，代表只有內建規則生效）。 */
export function getStoreRules() {
  const db = getDb();
  return { rules: sanitizeStoreRules(db.settings?.storeRules ?? emptyStoreRules()) };
}

/**
 * 用「候選規則」暫時上線跑一段程式，跑完**一定**還原（finally）——
 * 預覽不可以留下副作用：中途拋錯卻沒還原的話，這個 Node 行程接下來所有的店名清理都會用到
 * 那份還沒被使用者接受的規則（本機單行程，影響是全域且看不見的）。
 *
 * ⚠️ 用的是 `setRulesOverride`（覆蓋層）而不是 `setUserRules`：規則入櫃檯之後，預覽內部的
 * `getDb()` 會把規則重設回 settings 的值——候選規則會在讀第一次資料時就被洗掉，
 * 預覽永遠顯示「0 筆變動」（自審實測踩到）。覆蓋層才蓋得住櫃檯。
 * @template T @param {any} candidate @param {() => T} fn @returns {T}
 */
function withRules(candidate, fn) {
  try {
    setRulesOverride(candidate);
    return fn();
  } finally {
    setRulesOverride(null);
  }
}

/**
 * 預覽一組規則對「全庫」的影響（不寫檔）：回傳會被改到的顯示名 before→after，以及身分鑰匙的變動筆數。
 * 鑰匙變動特別重要——它是「同一家店」的判準，改了會影響學習、店家檔案、消費排行。
 * @param {any} rules @returns {{changed:number, keyChanged:number, changes:{id:string,before:string,after:string}[]}}
 */
export function previewStoreRules(rules) {
  const clean = sanitizeStoreRules(rules);
  const r = withRules(clean, () => normalizeBranches(true));
  return { changed: r.changed, keyChanged: r.keyChanged, changes: r.changes || [] };
}

/**
 * 存下規則並立刻套用到既有資料（＝存完就生效，不必再記得按一次「整理店名格式」——
 * 那正是第一帖要解的病，別在第三帖復發）。
 * 套用順序：先寫 settings → 再走 `normalizeIfRulesChanged`（它會重算含使用者規則的指紋、
 * 跑整理、記下新指紋），這樣「開 app 自動整理」與「這裡手動存檔」共用同一條路，不會互相打架。
 * @param {any} rules @returns {{ok:true, rules:any, changed:number, keyChanged:number, learnedRemapped:number, learnedNamesFixed:number}}
 */
export function saveStoreRules(rules) {
  if (rules === undefined || rules === null) throw apiError(400, '缺少規則內容');
  const clean = sanitizeStoreRules(rules);
  const db = getDb();
  db.settings = { ...db.settings, storeRules: clean };
  saveDb(db);
  const r = normalizeIfRulesChanged();   // 內含 getDb()＝規則入櫃檯，新規則在這裡才正式上線
  return { ok: true, rules: clean,
    changed: r.changed || 0, keyChanged: r.keyChanged || 0,
    learnedRemapped: r.learnedRemapped || 0, learnedNamesFixed: r.learnedNamesFixed || 0 };
}

/**
 * 孤兒學習條目：`learnedCategories` 裡「對不上任何現存交易」的 key
 *（既不是某筆交易的帳單原文，也不是某筆交易的身分鑰匙）。
 *
 * 為什麼要看得到它們（使用者定 2026-07-19，第三帖的配套）：
 * ①刪掉整批帳單後，學習仍刻意留著給未來匯入——但使用者無從得知自己還留著哪些規則；
 * ②改了店名規則會讓鑰匙搬家，**搬不動的孤兒**（normalizeBranches 刻意原封不動，r2-Codex#1）
 *   就成了「看不見卻仍會在下次匯入生效」的隱形規則。列出來才有機會判斷要不要刪。
 * 純唯讀（比照帳務體檢）；刪除走既有的 `POST /api/learned/delete`。
 * @returns {{items: {key:string, name?:string, category?:string, subcategory?:string}[], total:number}}
 */
export function listOrphanLearned() {
  const db = getDb();
  const origs = new Set();
  const keys = new Set();
  for (const t of db.transactions || []) {
    if (t.storeKey) keys.add(String(t.storeKey));
    if (t.source === 'stmt' && t.stmtRef) {
      const o = origFromStmtRef(t.stmtRef);
      if (o) origs.add(o);
    }
  }
  const lc = db.learnedCategories || {};
  const items = [];
  for (const [key, v] of Object.entries(lc)) {
    if (origs.has(key) || keys.has(key)) continue;
    items.push({ key, name: v?.name, category: v?.category, subcategory: v?.subcategory });
  }
  items.sort((a, b) => a.key.localeCompare(b.key, 'zh-Hant'));
  return { items, total: Object.keys(lc).length };
}
