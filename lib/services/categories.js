// @ts-check
// 自訂支出分類（大類＋子類，使用者定 2026-07）：分類樹存進 settings.expenseTree（缺→用 categories.js 預設）。
// 儲存時做「連動更新」：大類/子類改名同步到既有交易與學習表；被刪除的分類把交易改歸「其他／未分類」。
// 收入分類（薪資/投資…）與「繳款/退款」不在此樹內、不受影響。分類器（statement.js categorize）仍輸出內建名，
// 匯入時用 resolveImportCategory()：改名的內建分類走「別名」對映到新名、被刪的落「其他/未分類」（靠學習自我修正）。
import { getDb, saveDb } from '../repo.js';
import { EXPENSE_TREE as DEFAULT_TREE } from '../../public/modules/categories.js';

export const OTHER_CAT = '其他';
export const UNSET_SUB = '未分類';
const isObj = (/** @type {any} */ v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * 清理任意輸入成合法分類樹：key＝非空字串（大類名）、value＝去重後的非空字串子類陣列。
 * 永遠保留「其他:['未分類']」——它是自動分類與刪除分類時的退路，不可缺。
 * @param {any} input @returns {Record<string, string[]>}
 */
export function sanitizeTree(input) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (isObj(input)) {
    for (const [k, v] of Object.entries(input)) {
      const cat = String(k).trim();
      if (!cat || !Array.isArray(v)) continue;
      /** @type {string[]} */
      const subs = [];
      for (const s of v) { const t = String(s || '').trim(); if (t && !subs.includes(t)) subs.push(t); }
      if (!Object.hasOwn(out, cat)) out[cat] = subs;   // 撞名保留先到的（hasOwn：分類名可為 toString/constructor 等原生屬性名，Codex#7）
    }
  }
  if (!Array.isArray(out[OTHER_CAT])) out[OTHER_CAT] = [];
  if (!out[OTHER_CAT].includes(UNSET_SUB)) out[OTHER_CAT] = [UNSET_SUB, ...out[OTHER_CAT]];
  return out;
}

/** 目前生效的分類樹：settings.expenseTree 有值就用它，否則用內建預設。 @param {any=} db */
export function effectiveTree(db = getDb()) {
  const t = db.settings?.expenseTree;
  return (isObj(t) && Object.keys(t).length) ? sanitizeTree(t) : sanitizeTree(DEFAULT_TREE);
}

/**
 * 把 (cat,sub) 校正到樹內合法值：cat 不在樹內→[其他,未分類]；sub 不在該 cat（且非空）→''（不分子類）。
 * @param {Record<string,string[]>} tree @param {string} cat @param {string} sub @returns {[string,string]}
 */
export function conform(tree, cat, sub) {
  const c = String(cat || '');
  if (!Object.hasOwn(tree, c) || !Array.isArray(tree[c])) return [OTHER_CAT, UNSET_SUB];   // hasOwn＋陣列檢查：擋 toString 等原生屬性名（Codex#7）
  const s = String(sub || '');
  return [c, (s && !tree[c].includes(s)) ? '' : s];
}

/**
 * 儲存新分類樹＋連動更新。renames 讓「改名」精準連動（改名 vs 刪+增用 diff 分不出來，故由前端明確標記）。
 * 同時維護「分類器別名」：改名的分類→未來自動分類沿用新名；刪除的分類不建別名（→落其他）。
 * @param {{tree?:any, parentRenames?:{from:string,to:string}[], subRenames?:{parent:string,from:string,to:string}[]}} payload
 * @returns {{ok:true, tree:Record<string,string[]>, changedTx:number, changedLearned:number}}
 */
export function saveTree(payload) {
  const db = getDb();
  const oldTree = effectiveTree(db);
  const newTree = sanitizeTree(payload?.tree);
  const parentRenames = Array.isArray(payload?.parentRenames) ? payload.parentRenames : [];
  const subRenames = Array.isArray(payload?.subRenames) ? payload.subRenames : [];

  // 大類改名 map：from→to
  const pMap = new Map();
  for (const r of parentRenames) { const f = String(r?.from || ''), t = String(r?.to || ''); if (f && t && f !== t) pMap.set(f, t); }
  // 子類改名：巢狀 { 改名後大類 → { from → to } }（免用分隔符，名稱含空白也安全）
  /** @type {Record<string, Record<string,string>>} */
  const sMap = {};
  for (const r of subRenames) { const p = String(r?.parent || ''), f = String(r?.from || ''), t = String(r?.to || ''); if (p && f && t && f !== t) (sMap[p] = sMap[p] || {})[f] = t; }

  // 對單一 (cat,sub) 套改名＋校正到新樹。origCat 用來判斷「本來就是支出樹內的分類」（避免誤動收入/繳款）。
  const remap = (/** @type {string} */ origCat, /** @type {string} */ origSub) => {
    if (!Object.hasOwn(oldTree, origCat) && !pMap.has(origCat)) return null;   // 非支出樹分類（收入/繳款/退款…）→ 不動（hasOwn 防原生屬性名，Codex#7）
    const cat = pMap.get(origCat) || origCat;
    let sub = origSub;
    if (sMap[cat] && sMap[cat][sub]) sub = sMap[cat][sub];
    return conform(newTree, cat, sub);
  };

  let changedTx = 0;
  for (const tx of db.transactions || []) {
    if (tx.type !== 'expense') continue;   // 只動支出；收入/繳款不在樹內、別誤動
    const r = remap(String(tx.category || ''), String(tx.subcategory || ''));
    if (r && (r[0] !== tx.category || r[1] !== (tx.subcategory || ''))) { tx.category = r[0]; tx.subcategory = r[1]; changedTx++; }
  }
  let changedLearned = 0;
  const lc = db.learnedCategories || {};
  for (const k of Object.keys(lc)) {
    const e = lc[k];
    if (!isObj(e)) continue;
    const r = remap(String(e.category || ''), String(e.subcategory || ''));
    if (r && (r[0] !== e.category || r[1] !== (e.subcategory || ''))) { e.category = r[0]; e.subcategory = r[1]; changedLearned++; }
  }

  // ---- 分類器別名（使用者定 2026-07）：pAlias={舊大類→現大類}、sAlias={現大類→{舊子類→現子類}}。
  //      改名內建分類→未來自動分類沿用新名；刪除→不建別名（下面修剪掉→落其他）。 ----
  /** @type {Record<string,string>} */
  const pAlias = { ...(db.settings.categoryAliases || {}) };
  /** @type {Record<string, Record<string,string>>} */
  const sAlias = {};
  for (const [k, v] of Object.entries(db.settings.subAliases || {})) if (isObj(v)) sAlias[k] = { ...v };
  for (const [from, to] of pMap) {                                   // 大類改名
    for (const k of Object.keys(pAlias)) if (pAlias[k] === from) pAlias[k] = to;   // 鏈式：舊別名指向 from→改指 to
    pAlias[from] = to;
    if (sAlias[from]) { sAlias[to] = { ...(sAlias[to] || {}), ...sAlias[from] }; delete sAlias[from]; }   // 子別名隨父搬移
  }
  for (const r of subRenames) {                                      // 子類改名（parent＝改名後名字）
    const p = String(r?.parent || ''), from = String(r?.from || ''), to = String(r?.to || '');
    if (!p || !from || !to || from === to) continue;
    const m = sAlias[p] = sAlias[p] || {};
    for (const k of Object.keys(m)) if (m[k] === from) m[k] = to;    // 鏈式
    m[from] = to;
  }
  // 修剪：別名 key 已是真分類、或指向已不存在的分類 → 移除（刪除的分類不留別名＝落其他）
  /** @type {Record<string,string>} */
  const prunedP = {};
  for (const [k, v] of Object.entries(pAlias)) if (!Object.hasOwn(newTree, k) && Object.hasOwn(newTree, v)) prunedP[k] = v;
  /** @type {Record<string, Record<string,string>>} */
  const prunedS = {};
  for (const [p, m] of Object.entries(sAlias)) {
    if (!Object.hasOwn(newTree, p) || !Array.isArray(newTree[p]) || !isObj(m)) continue;
    /** @type {Record<string,string>} */
    const mm = {};
    for (const [os, ns] of Object.entries(m)) if (!newTree[p].includes(os) && newTree[p].includes(ns)) mm[os] = ns;
    if (Object.keys(mm).length) prunedS[p] = mm;
  }

  db.settings.expenseTree = newTree;   // settings 一律存在（load 缺檔回 emptyDb）
  db.settings.categoryAliases = prunedP;
  db.settings.subAliases = prunedS;
  saveDb(db);
  return { ok: true, tree: newTree, changedTx, changedLearned };
}

/**
 * 匯入用：把分類器輸出的 (cat,sub) 先過「改名別名」再校正到生效樹。
 * 內建分類被使用者改名→沿用新名（別名）；被刪除→落「其他/未分類」（conform）。
 * @param {any} db @param {string} cat @param {string} sub @returns {[string,string]}
 */
export function resolveImportCategory(db, cat, sub) {
  const pA = db.settings?.categoryAliases || {};
  const sA = db.settings?.subAliases || {};
  const c = pA[cat] || cat;
  const s = (sA[c] && sA[c][sub]) || sub;
  return conform(effectiveTree(db), c, s);
}
