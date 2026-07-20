// @ts-check
// 自訂支出分類（大類＋子類，使用者定 2026-07）：分類樹存進 settings.expenseTree（缺→用 categories.js 預設）。
// 儲存時做「連動更新」：大類/子類改名同步到既有交易與學習表；被刪除的分類把交易改歸「其他／未分類」。
// 收入分類（薪資/投資…）與「繳款/退款」不在此樹內、不受影響。分類器（statement.js categorize）仍輸出內建名，
// 匯入時用 resolveImportCategory()：改名的內建分類走「別名」對映到新名、被刪的落「其他/未分類」（靠學習自我修正）。
import { getDb, saveDb } from '../repo.js';
import { EXPENSE_TREE as DEFAULT_TREE, INCOME_TREE as DEFAULT_INCOME_TREE } from '../../public/modules/categories.js';
import { isCardLedger } from '../derive.js';
import { emptyMap, setOwn, getOwn, isProtoKey } from '../safe-map.js';

export const OTHER_CAT = '其他';
export const UNSET_SUB = '未分類';
// 收入樹的退路（三層重構）：類比支出的 其他/未分類——sanitize 強制保留、編輯器鎖定不可刪。
/** @type {[string, string]} */
export const OTHER_INCOME = ['其他', '其他收入'];
const isObj = (/** @type {any} */ v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * 清理任意輸入成合法分類樹：key＝非空字串（大類名）、value＝去重後的非空字串子類陣列。
 * 永遠保留「其他:['未分類']」——它是自動分類與刪除分類時的退路，不可缺。
 * @param {any} input @returns {Record<string, string[]>}
 */
export function sanitizeTree(input) { return sanitizeTreeCore(input, OTHER_CAT, UNSET_SUB); }

/** 收入樹同款清理（三層重構 stage 1）：退路＝「其他/其他收入」。 @param {any} input */
export function sanitizeIncomeTree(input) { return sanitizeTreeCore(input, OTHER_INCOME[0], OTHER_INCOME[1]); }

/** @param {any} input @param {string} otherCat 退路大類 @param {string} unsetSub 退路子類 @returns {Record<string, string[]>} */
function sanitizeTreeCore(input, otherCat, unsetSub) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (isObj(input)) {
    for (const [k, v] of Object.entries(input)) {
      const cat = String(k).trim();
      if (!cat || !Array.isArray(v)) continue;
      // __proto__ 一律丟棄（Codex r5#4）：`out[cat]=subs` 對這個鍵不是「寫鍵」而是**把 out 的原型
      // 換成那個陣列**——鍵靜默消失、物件原型變陣列。讀取路（舊資料）容忍地丟掉；
      // 儲存路（saveTree）會在進來之前就明確拒絕整個保留字家族。
      if (cat === '__proto__') continue;
      /** @type {string[]} */
      const subs = [];
      for (const s of v) { const t = String(s || '').trim(); if (t && !subs.includes(t)) subs.push(t); }
      if (!Object.hasOwn(out, cat)) out[cat] = subs;   // 撞名保留先到的（hasOwn：**既有資料**的分類名可為 toString 等原生屬性名，Codex#7；新儲存已被 saveTree 擋）
    }
  }
  if (!Array.isArray(out[otherCat])) out[otherCat] = [];
  if (!out[otherCat].includes(unsetSub)) out[otherCat] = [unsetSub, ...out[otherCat]];
  return out;
}

/** 目前生效的分類樹：settings.expenseTree 有值就用它，否則用內建預設。 @param {any=} db */
export function effectiveTree(db = getDb()) {
  const t = db.settings?.expenseTree;
  return (isObj(t) && Object.keys(t).length) ? sanitizeTree(t) : sanitizeTree(DEFAULT_TREE);
}

/** 目前生效的**收入**分類樹（三層重構 stage 1）：settings.incomeTree 有值就用它，否則用內建 INCOME_TREE。 @param {any=} db */
export function effectiveIncomeTree(db = getDb()) {
  const t = db.settings?.incomeTree;
  return (isObj(t) && Object.keys(t).length) ? sanitizeIncomeTree(t) : sanitizeIncomeTree(DEFAULT_INCOME_TREE);
}

/**
 * 儲存收入樹＋連動更新（三層重構 stage 1）。與支出 saveTree 同骨架但刻意精簡：
 * **無別名機制**——收入沒有自動分類器（別名是給「匯入時自動分類沿用新名」用的，收入是手動選的），
 * 改名直接連動既有交易即可；日後 stage 3 銀行匯入若做收入自動分類再補。
 * 只動 cashflow 帳本的 income 交易（card 帳本不可能有收入，仍上 isCardLedger 保險）。
 * @param {{tree?:any, parentRenames?:{from:string,to:string}[], subRenames?:{parent:string,from:string,to:string}[]}} payload
 * @returns {{ok:true, tree:Record<string,string[]>, changedTx:number}}
 */
export function saveIncomeTree(payload) {
  const db = getDb();
  const oldTree = effectiveIncomeTree(db);
  const reserved = (/** @type {string} */ n) =>
    Object.assign(new Error(`「${n}」是程式內部的保留字，不能當分類名稱，請換一個名字`), { status: 400 });
  if (isObj(payload?.tree)) {
    for (const [k, v] of Object.entries(payload.tree)) {
      if (isProtoKey(String(k).trim())) throw reserved(String(k).trim());
      for (const s of (Array.isArray(v) ? v : [])) if (isProtoKey(String(s || '').trim())) throw reserved(String(s || '').trim());
    }
  }
  for (const r of (Array.isArray(payload?.parentRenames) ? payload.parentRenames : []))
    if (isProtoKey(String(r?.to || '').trim())) throw reserved(String(r?.to || '').trim());
  for (const r of (Array.isArray(payload?.subRenames) ? payload.subRenames : []))
    if (isProtoKey(String(r?.to || '').trim())) throw reserved(String(r?.to || '').trim());
  const newTree = sanitizeIncomeTree(payload?.tree);
  const pMap = new Map();
  for (const r of (Array.isArray(payload?.parentRenames) ? payload.parentRenames : [])) {
    const f = String(r?.from || ''), t = String(r?.to || '');
    if (f && t && f !== t && !isProtoKey(f) && !isProtoKey(t)) pMap.set(f, t);
  }
  /** @type {Record<string, Record<string,string>>} */
  const sMap = emptyMap();
  for (const r of (Array.isArray(payload?.subRenames) ? payload.subRenames : [])) {
    const p = String(r?.parent || ''), f = String(r?.from || ''), t = String(r?.to || '');
    if (p && f && t && f !== t && !isProtoKey(p) && !isProtoKey(f)) setOwn(sMap[p] || (sMap[p] = emptyMap()), f, t);
  }
  const remap = (/** @type {string} */ origCat, /** @type {string} */ origSub) => {
    if (!Object.hasOwn(oldTree, origCat) && !pMap.has(origCat)) return null;   // 不在收入樹的分類（未搬家舊資料等）→ 不動
    const cat = pMap.get(origCat) || origCat;
    let sub = origSub;
    const sm = getOwn(sMap, cat); if (sm && getOwn(sm, sub) != null) sub = sm[sub];
    return conformIncome(newTree, cat, sub);
  };
  let changedTx = 0;
  for (const tx of db.transactions || []) {
    if (tx.type !== 'income' || isCardLedger(tx)) continue;   // 只動現金流帳本的收入
    const r = remap(String(tx.category || ''), String(tx.subcategory || ''));
    if (r && (r[0] !== tx.category || r[1] !== (tx.subcategory || ''))) { tx.category = r[0]; tx.subcategory = r[1]; changedTx++; }
  }
  db.settings.incomeTree = newTree;
  saveDb(db);
  return { ok: true, tree: newTree, changedTx };
}

/**
 * 把 (cat,sub) 校正到樹內合法值：cat 不在樹內→[其他,未分類]；sub 不在該 cat（且非空）→''（不分子類）。
 * @param {Record<string,string[]>} tree @param {string} cat @param {string} sub @returns {[string,string]}
 */
export function conform(tree, cat, sub) { return conformCore(tree, cat, sub, [OTHER_CAT, UNSET_SUB]); }

/** 收入樹版校正：退路＝其他/其他收入（三層重構）。 @param {Record<string,string[]>} tree @param {string} cat @param {string} sub @returns {[string,string]} */
export function conformIncome(tree, cat, sub) { return conformCore(tree, cat, sub, OTHER_INCOME); }

/** @param {Record<string,string[]>} tree @param {string} cat @param {string} sub @param {[string,string]} fallback @returns {[string,string]} */
function conformCore(tree, cat, sub, fallback) {
  const c = String(cat || '');
  if (!Object.hasOwn(tree, c) || !Array.isArray(tree[c])) return [fallback[0], fallback[1]];   // hasOwn＋陣列檢查：擋 toString 等原生屬性名（Codex#7）
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
  // 保留字**明確拒絕、不靜默吞掉**（Codex r5#4）：以前 __proto__ 會在 sanitize 時無聲消失——
  // 使用者把既有分類「改名成 __proto__」時，舊名刪了、新名沒存，儲存卻回報成功，
  // 舊交易全被改歸「其他／未分類」。產品規則（統一口徑）：**寫入一律拒絕整個保留字家族
  //（__proto__/toString/constructor…，與學習表同一把尺），讀取容忍舊資料**。
  const reserved = (/** @type {string} */ n) =>
    Object.assign(new Error(`「${n}」是程式內部的保留字，不能當分類名稱，請換一個名字`), { status: 400 });
  if (isObj(payload?.tree)) {
    for (const [k, v] of Object.entries(payload.tree)) {
      if (isProtoKey(String(k).trim())) throw reserved(String(k).trim());
      for (const s of (Array.isArray(v) ? v : [])) if (isProtoKey(String(s || '').trim())) throw reserved(String(s || '').trim());
    }
  }
  for (const r of (Array.isArray(payload?.parentRenames) ? payload.parentRenames : []))
    if (isProtoKey(String(r?.to || '').trim())) throw reserved(String(r?.to || '').trim());
  for (const r of (Array.isArray(payload?.subRenames) ? payload.subRenames : []))
    if (isProtoKey(String(r?.to || '').trim())) throw reserved(String(r?.to || '').trim());
  const newTree = sanitizeTree(payload?.tree);
  const parentRenames = Array.isArray(payload?.parentRenames) ? payload.parentRenames : [];
  const subRenames = Array.isArray(payload?.subRenames) ? payload.subRenames : [];

  // 大類改名 map：from→to
  const pMap = new Map();
  for (const r of parentRenames) { const f = String(r?.from || ''), t = String(r?.to || ''); if (f && t && f !== t && !isProtoKey(f) && !isProtoKey(t)) pMap.set(f, t); }
  // 子類改名：巢狀 { 改名後大類 → { from → to } }（免用分隔符，名稱含空白也安全）
  /** @type {Record<string, Record<string,string>>} */
  const sMap = emptyMap();
  // 原型名（__proto__/toString…）不可能是真的分類名，跳過整條——否則 sMap['__proto__'] 或
  // 內層的 [from] 會污染全域 Object.prototype（Codex r4#1，實測連 pdfjs 都被弄崩）。
  for (const r of subRenames) { const p = String(r?.parent || ''), f = String(r?.from || ''), t = String(r?.to || ''); if (p && f && t && f !== t && !isProtoKey(p) && !isProtoKey(f)) setOwn(sMap[p] || (sMap[p] = emptyMap()), f, t); }

  // 對單一 (cat,sub) 套改名＋校正到新樹。origCat 用來判斷「本來就是支出樹內的分類」（避免誤動收入/繳款）。
  const remap = (/** @type {string} */ origCat, /** @type {string} */ origSub) => {
    if (!Object.hasOwn(oldTree, origCat) && !pMap.has(origCat)) return null;   // 非支出樹分類（收入/繳款/退款…）→ 不動（hasOwn 防原生屬性名，Codex#7）
    const cat = pMap.get(origCat) || origCat;
    let sub = origSub;
    const sm = getOwn(sMap, cat); if (sm && getOwn(sm, sub) != null) sub = sm[sub];
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
  const pAlias = emptyMap();
  for (const [k, v] of Object.entries(db.settings.categoryAliases || {})) if (!isProtoKey(k)) pAlias[k] = v;
  /** @type {Record<string, Record<string,string>>} */
  const sAlias = emptyMap();
  for (const [k, v] of Object.entries(db.settings.subAliases || {})) if (isObj(v) && !isProtoKey(k)) sAlias[k] = { ...v };
  for (const [from, to] of pMap) {                                   // 大類改名（原型名已在 pMap 建構時擋掉）
    for (const k of Object.keys(pAlias)) if (pAlias[k] === from) pAlias[k] = to;   // 鏈式：舊別名指向 from→改指 to
    pAlias[from] = to;
    if (getOwn(sAlias, from)) { sAlias[to] = { ...(getOwn(sAlias, to) || {}), ...sAlias[from] }; delete sAlias[from]; }   // 子別名隨父搬移
  }
  for (const r of subRenames) {                                      // 子類改名（parent＝改名後名字）
    const p = String(r?.parent || ''), from = String(r?.from || ''), to = String(r?.to || '');
    if (!p || !from || !to || from === to || isProtoKey(p) || isProtoKey(from) || isProtoKey(to)) continue;
    const m = sAlias[p] || (sAlias[p] = emptyMap());
    for (const k of Object.keys(m)) if (m[k] === from) m[k] = to;    // 鏈式
    m[from] = to;
  }
  // 修剪：別名 key 已是真分類、或指向已不存在的分類 → 移除（刪除的分類不留別名＝落其他）
  const prunedP = emptyMap();
  for (const [k, v] of Object.entries(pAlias)) if (!Object.hasOwn(newTree, k) && Object.hasOwn(newTree, v)) prunedP[k] = v;
  const prunedS = emptyMap();
  for (const [p, m] of Object.entries(sAlias)) {
    if (!Object.hasOwn(newTree, p) || !Array.isArray(newTree[p]) || !isObj(m)) continue;
    const mm = emptyMap();
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
  // getOwn（Codex r6#3）：cat='toString' 時裸讀 pA[cat] 撈到原型上的**函式**（truthy）→ c 變成函式
  // → conform 對不上 → 合法的舊分類被誤改成「其他/未分類」，違反「讀取容忍舊資料」的產品規則
  const c = getOwn(pA, cat) || cat;
  const sm = getOwn(sA, c);
  const s = (sm && getOwn(sm, sub)) || sub;
  return conform(effectiveTree(db), c, s);
}
