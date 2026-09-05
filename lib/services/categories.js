// @ts-check
// 自訂支出分類（大類＋子類，使用者定 2026-07）：分類樹存進 settings.expenseTree（缺→用 categories.js 預設）。
// 儲存時做「連動更新」：大類/子類改名同步到既有交易與學習表；被刪除的分類把交易改歸「其他／未分類」。
// 收入分類（薪資/投資…）與「繳款/退款」不在此樹內、不受影響。分類器（statement.js categorize）仍輸出內建名，
// 匯入時用 resolveImportCategory()：改名的內建分類走「別名」對映到新名、被刪的落「其他/未分類」（靠學習自我修正）。
import { getDb, saveDb } from '../repo.js';
import { EXPENSE_TREE as DEFAULT_TREE, INCOME_TREE as DEFAULT_INCOME_TREE } from '../../public/modules/categories.js';
import { isCardLedger } from '../derive.js';
import { emptyMap, setOwn, getOwn, isProtoKey } from '../safe-map.js';
import { sanitizeTransferSubs, cleanTransferSubs, DEFAULT_TRANSFER_SUBS } from '../schema.js';

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

/** 目前生效的分類樹：settings.expenseTree 有值就用它，否則用內建預設。
 * **純函式：db 必填**（C4a——getDb 改 async 後不能再當預設參數；漏傳會拿 Promise 當 db、默默退回內建樹）。 @param {any} db */
export function effectiveTree(db) {
  const t = db.settings?.expenseTree;
  return (isObj(t) && Object.keys(t).length) ? sanitizeTree(t) : sanitizeTree(DEFAULT_TREE);
}

/** 目前生效的**收入**分類樹（三層重構 stage 1）：settings.incomeTree 有值就用它，否則用內建 INCOME_TREE。
 * **純函式：db 必填**（同 effectiveTree，C4a）。 @param {any} db */
export function effectiveIncomeTree(db) {
  const t = db.settings?.incomeTree;
  return (isObj(t) && Object.keys(t).length) ? sanitizeIncomeTree(t) : sanitizeIncomeTree(DEFAULT_INCOME_TREE);
}

/**
 * 儲存收入樹＋連動更新（三層重構 stage 1；別名 Codex r13#3 補上）。與支出 saveTree 同骨架：改名連動既有
 * income 交易＋learnedBank 收入規則，並維護收入分類器別名（銀行匯入 stage 3 起會自動分類收入，改名須沿用新名）。
 * 只動 cashflow 帳本的 income 交易（card 帳本不可能有收入，仍上 isCardLedger 保險）。
 * @param {{tree?:any, parentRenames?:{from:string,to:string}[], subRenames?:{parent:string,from:string,to:string}[]}} payload
 * @returns {Promise<{ok:true, tree:Record<string,string[]>, changedTx:number, changedLearned:number}>}
 */
export async function saveIncomeTree(payload) {
  const db = await getDb();
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
  // 銀行「真·學習」的收入規則（learnedBank type:'income'）也隨改名連動——同支出 saveTree 更新 learnedCategories。
  let changedLearned = 0;
  const lb = db.learnedBank || {};
  for (const k of Object.keys(lb)) {
    const e = lb[k];
    if (!isObj(e) || e.type !== 'income') continue;
    const r = remap(String(e.category || ''), String(e.subcategory || ''));
    if (r && (r[0] !== e.category || r[1] !== (e.subcategory || ''))) { e.category = r[0]; e.subcategory = r[1]; changedLearned++; }
  }

  // ---- 收入分類器別名（Codex r13#3）：pAlias={舊大類→現大類}、sAlias={現大類→{舊子類→現子類}}，同支出 saveTree。
  //      改名的收入分類→未來銀行匯入自動分類沿用新名；刪除→不建別名（下面修剪→落「其他/其他收入」）。 ----
  const pAlias = emptyMap();
  for (const [k, v] of Object.entries(db.settings.incomeCategoryAliases || {})) if (!isProtoKey(k)) pAlias[k] = v;
  /** @type {Record<string, Record<string,string>>} */
  const sAlias = emptyMap();
  for (const [k, v] of Object.entries(db.settings.incomeSubAliases || {})) if (isObj(v) && !isProtoKey(k)) sAlias[k] = { ...v };
  for (const [from, to] of pMap) {                                   // 大類改名（原型名已在 pMap 建構時擋掉）
    for (const k of Object.keys(pAlias)) if (pAlias[k] === from) pAlias[k] = to;   // 鏈式：舊別名指向 from→改指 to
    pAlias[from] = to;
    if (getOwn(sAlias, from)) { sAlias[to] = { ...(getOwn(sAlias, to) || {}), ...sAlias[from] }; delete sAlias[from]; }   // 子別名隨父搬移
  }
  for (const r of (Array.isArray(payload?.subRenames) ? payload.subRenames : [])) {   // 子類改名（parent＝改名後名字）
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

  db.settings.incomeTree = newTree;
  db.settings.incomeCategoryAliases = prunedP;
  db.settings.incomeSubAliases = prunedS;
  await saveDb(db);
  return { ok: true, tree: newTree, changedTx, changedLearned };
}

// ---------- 內轉子分類（使用者定 2026-07-21，「全部都能改」）----------
// 內轉沒有大類、只有一串子分類。三個系統角色 out/in/settle（內轉出/內轉入/交割）用 role 標記跟著改名走。
// 存 db.transferSubs（頂層陣列 [{label,role?}]，空→DEFAULT_TRANSFER_SUBS）。自動分類（classifyBankTx 出的
// 內轉出/內轉入/交割）在匯入層用 conformTransferSub 對映到現名；改名連動既有內轉交易（saveTransferSubs）。
/** 預設角色標籤 → 角色：供 conform 把自動分類輸出的「預設標籤」對映到現名。 */
const DEFAULT_TRANSFER_LABEL_ROLE = { '內轉出': 'out', '內轉入': 'in', '交割': 'settle' };

/** 目前生效的內轉子分類清單 [{label, role?}]。**純函式：db 必填**（同 effectiveTree，C4a）。 @param {any} db */
export function effectiveTransferSubs(db) {
  const t = db.transferSubs;
  return sanitizeTransferSubs(Array.isArray(t) && t.length ? t : DEFAULT_TRANSFER_SUBS);
}

/** 把自動分類/學習輸出的內轉子分類，對映到目前生效的標籤：現行清單有→保留；預設角色標籤被改名→現名；
 * 角色已刪或非清單內→空（不留清單外孤兒）。 @param {any} db @param {string} sub */
export function conformTransferSub(db, sub) {
  const s = String(sub || '');
  if (!s) return '';
  const subs = effectiveTransferSubs(db);
  // 預設角色代號（內轉出/內轉入/交割＝classifyBankTx 的角色輸出）：**角色優先**（對抗審查 2026-07-21）——
  // 即使使用者把角色改名到別的字、又剛好自訂一項叫這個代號，仍要對到「角色的現名」而非那個同名自訂項（否則自動分類貼錯）。
  const role = DEFAULT_TRANSFER_LABEL_ROLE[s];
  if (role) { const byRole = subs.find(x => x.role === role); return byRole ? byRole.label : ''; }
  // 非角色代號（現行/自訂標籤）：清單內就保留，否則落空（不留清單外孤兒）。
  return subs.some(x => x.label === s) ? s : '';
}

/** 某內轉子分類標籤現在的系統角色（out/in/settle）或 null（自訂/不存在）。**預設 token（內轉出/內轉入/交割）一律
 * 回其角色（role-first，與 conformTransferSub 同口徑，#184）**——即使角色被改名、又剛好有同名自訂項，也對到角色而非
 * 那個自訂項；非預設 token 才查現行清單拿它的 role。 @param {any} db @param {string} label @returns {'out'|'in'|'settle'|null} */
export function transferSubRole(db, label) {
  const s = String(label || '');
  const def = DEFAULT_TRANSFER_LABEL_ROLE[s];
  if (def) return /** @type {'out'|'in'|'settle'} */ (def);
  const found = effectiveTransferSubs(db).find(x => x.label === s);
  return found && found.role ? found.role : null;
}

/** 重播學到的內轉子分類到「本筆方向」（真·學習套用時用，Codex r13#2/#4）：
 *  - out/in（內轉出/內轉入）角色＝**依本筆方向**取現行標籤，不重播學到的方向（同鑰匙反向交易才不會貼錯）；
 *  - settle（交割）角色＝方向中性 → 保留（改名連動到現名，conform）；
 *  - 無角色的自訂子類＝原樣保留（conform 到現行清單；被刪→空）。
 *  dir 為 null/undefined（方向不明的舊資料）時保守回 conform（保留學到的值、不硬翻方向）。
 * @param {any} db @param {string} learnedSub @param {'in'|'out'|null|undefined} dir @returns {string} */
export function replayTransferSub(db, learnedSub, dir) {
  const s = String(learnedSub || '');
  const role = transferSubRole(db, s);
  if ((role === 'out' || role === 'in') && (dir === 'in' || dir === 'out')) {
    const byRole = effectiveTransferSubs(db).find(x => x.role === dir);   // dir==='out'→out 角色現名、'in'→in 角色現名
    return byRole ? byRole.label : '';
  }
  return conformTransferSub(db, s);   // settle／自訂／方向不明 → 保留＋校正到現名
}

/** 儲存內轉子分類清單＋連動更新（改名套到既有內轉交易）。renames＝編輯器算好的 [{from,to}]；刪掉的子分類，
 * 既有交易對不到新清單就 conform（角色現名或空）。保留字整組拒絕（400）。
 * @param {{subs?:any[], renames?:{from:string,to:string}[]}} payload
 * @returns {Promise<{ok:true, subs:{label:string,role?:'out'|'in'|'settle'}[], changedTx:number}>} */
export async function saveTransferSubs(payload) {
  const db = await getDb();
  const reserved = (/** @type {string} */ n) => Object.assign(new Error(`「${n}」是程式保留字，不能當分類名稱，請換一個`), { status: 400 });
  for (const it of (Array.isArray(payload?.subs) ? payload.subs : []))
    if (it && typeof it.label === 'string' && isProtoKey(it.label.trim())) throw reserved(it.label.trim());
  for (const r of (Array.isArray(payload?.renames) ? payload.renames : []))
    if (isProtoKey(String(r?.to || '').trim())) throw reserved(String(r?.to || '').trim());
  // 清乾淨之後一項都不剩＝擋下來，不要靜靜存成預設值：使用者按下的是「儲存我這份清單」，
  // 回報成功卻換成別的內容，他要下次打開才會發現。這一道守的是直接呼叫這條路的人。
  const newSubs = cleanTransferSubs(payload?.subs);
  if (!newSubs.length) throw Object.assign(new Error('清單裡沒有任何可用的內轉分類名稱，未做任何變更'), { status: 400 });
  const renameMap = new Map();
  for (const r of (Array.isArray(payload?.renames) ? payload.renames : [])) {
    const f = String(r?.from || ''), t = String(r?.to || '');
    if (f && t && f !== t) renameMap.set(f, t);
  }
  db.transferSubs = newSubs;   // 先寫新清單，conformTransferSub 才看得到現名
  const labels = new Set(newSubs.map(x => x.label));
  let changedTx = 0;
  for (const tx of db.transactions || []) {
    if (tx.type !== 'transfer') continue;
    const old = String(tx.subcategory || '');
    let sub = renameMap.has(old) ? renameMap.get(old) : old;         // 改名先套
    if (sub && !labels.has(sub)) sub = conformTransferSub(db, sub);   // 仍對不到（刪除等）→ conform
    if (sub !== old) { tx.subcategory = sub; changedTx++; }
  }
  await saveDb(db);
  return { ok: true, subs: newSubs, changedTx };
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
 * @returns {Promise<{ok:true, tree:Record<string,string[]>, changedTx:number, changedLearned:number}>}
 */
export async function saveTree(payload) {
  const db = await getDb();
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
  await saveDb(db);
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

/**
 * 「停車費」子類的**現名身分**（護欄 G4，2026-07-22）：內建停車判準是 (交通, 停車費)，但這兩個名字都可能被
 * 使用者改名（`categoryAliases`/`subAliases`）。顯示層把停車消費包成「停車費（場站）」的**觸發條件**必須認這個
 * 子類的**身分**、不可字面比對舊名「停車費」——否則改名後停車場（嘟嘟房這種名字沒有「停車」二字的）就不再被
 * 包、失去「這是停車」的提示（同 transferSub 角色問題 Codex r13#4，name/ID 分離）。回現名字串；**被刪除→null**
 * （落到 其他/未分類，不可拿 fallback 的未分類當停車判準，否則所有未分類都被包成停車費）。
 * @param {any} db @returns {string|null} */
export function parkingSubName(db) {
  const pA = db?.settings?.categoryAliases || {};
  const sA = db?.settings?.subAliases || {};
  const cat = getOwn(pA, '交通') || '交通';                                   // 大類現名（可能被改名）
  const sm = getOwn(sA, cat);
  const sub = (sm && getOwn(sm, '停車費')) || '停車費';                       // 子類現名（subAliases={現大類:{舊子類:現子類}}）
  const tree = effectiveTree(db);
  return (Array.isArray(tree[cat]) && tree[cat].includes(sub)) ? sub : null;   // 仍在生效樹才算；刪除→null
}

/**
 * 匯入用（收入版，stage 3 銀行自動分箱）：與支出 resolveImportCategory 同款——先過收入改名別名
 * （incomeCategoryAliases/incomeSubAliases）再 conform 到生效收入樹。**銀行匯入現在會自動分類收入**
 * （classifyBankTx 出 被動/利息…），故收入改名也要沿用新名（原「收入無別名」註解在 stage 3 後已不成立，Codex r13#3）；
 * 被刪除的收入分類落「其他/其他收入」（不產生樹外孤兒）。
 * @param {any} db @param {string} cat @param {string} sub @returns {[string,string]}
 */
export function resolveImportIncome(db, cat, sub) {
  const pA = db.settings?.incomeCategoryAliases || {};
  const sA = db.settings?.incomeSubAliases || {};
  const c = getOwn(pA, cat) || cat;   // getOwn（Codex r6#3）：cat='toString' 不裸讀到原型函式
  const sm = getOwn(sA, c);
  const s = (sm && getOwn(sm, sub)) || sub;
  return conformIncome(effectiveIncomeTree(db), c, s);
}
