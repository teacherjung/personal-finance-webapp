// @ts-check
// 信用卡帳單匯入（B2 服務層）：預覽（免選卡自動歸卡／指定卡）、匯入、批次管理、學習表檢視刪除。
// PDF 只在記憶體解析、不落地保存；密碼取自卡片 pdfPassword。
// 錯誤以 throw 帶 status 回報（路由層轉成對應 HTTP 狀態）。
import { getDb, saveDb, uid } from '../repo.js';
import { parseStatement, normalizeStoreDisplay, isServiceFee } from '../statement.js';
import { applyLearned, learnFromImport } from './learning.js';
import { resolveImportCategory } from './categories.js';
/** @typedef {import('../types.js').Db} Db */

/** 把一批交易的 (category,subcategory) 校正到生效樹：內建分類被改名→沿用新名（別名）、被刪→其他/未分類。 */
const conformTxs = (/** @type {Db} */ db, /** @type {any[]} */ txs) =>
  txs.map(t => { const [c, s] = resolveImportCategory(db, t.category, t.subcategory); return { ...t, category: c, subcategory: s }; });

/** 帶 HTTP 狀態的錯誤（路由層 catch 後用 e.status 回應）。 @param {number} status @param {string} msg */
const apiError = (status, msg) => Object.assign(new Error(msg), { status });

// 重複偵測：每筆算 stmtRef（卡id+消費日+金額+說明），與既有記帳比對標記 duplicate。
// ⚠️ 同步點（AGENTS.md）：改 stmtRef 格式要連動 reassignBatch 的前綴重寫。
function stmtDupFlag(db, cardId, txs) {
  const existing = new Set((db.transactions || []).map(t => t.stmtRef).filter(Boolean));
  return txs.map(t => {
    const stmtRef = `${cardId}|${t.date}|${t.amount}|${t.desc}`;
    return { ...t, stmtRef, duplicate: existing.has(stmtRef) };
  });
}
const issuerMatchesBank = (/** @type {any} */ issuer, /** @type {string} */ bank) => String(issuer || '').includes(bank);

const decode = (/** @type {string} */ b64) => {
  if (!b64) throw apiError(400, '沒有收到檔案內容');
  return new Uint8Array(Buffer.from(b64, 'base64'));
};

/** 免選卡自動預覽：試各卡密碼解密→判銀行＋末四碼→自動歸卡；認不出回 candidates 讓使用者選。 @param {string} b64 */
export async function previewAuto(b64) {
  const db = getDb();
  const bytes = decode(String(b64 || ''));
  const cards = (db.cards || []).filter(c => (c.type || 'credit') === 'credit');
  // 逐一試密碼：空字串（未加密/XLSX）＋各卡去重後的 pdfPassword（多為同組身分證字號）
  const pwList = ['', ...new Set(cards.map(c => c.pdfPassword).filter(Boolean))];
  let parsed = null, lastErr = null;
  for (const pw of pwList) {
    try { parsed = await parseStatement(bytes, pw); break; }
    catch (e) {
      lastErr = e;
      if (!/密碼|加密|Password/i.test(String(/** @type {any} */ (e).message || ''))) break;   // 非密碼錯誤（格式/無明細）直接回報
    }
  }
  if (!parsed) throw apiError(400, String(/** @type {any} */ (lastErr)?.message || '解析失敗'));
  // 對卡：①末四碼唯一命中→自動；②該銀行只有一張卡→自動；③否則回候選（該銀行優先，無則全部信用卡）
  const bankCards = cards.filter(c => issuerMatchesBank(c.issuer, parsed.bank));
  let resolved = null, candidates = [];
  if (parsed.lastFour) {
    const hit = cards.filter(c => String(c.lastFour) === String(parsed.lastFour));
    if (hit.length === 1) resolved = hit[0];
    else if (hit.length > 1) candidates = hit;
  }
  if (!resolved && !candidates.length) {
    if (bankCards.length === 1) resolved = bankCards[0];
    else candidates = bankCards.length ? bankCards : cards;
  }
  const base = { bank: parsed.bank, lastFour: parsed.lastFour || null };
  if (resolved) {
    return { ...base, resolvedCard: { id: resolved.id, name: resolved.name, lastFour: resolved.lastFour || null },
      transactions: stmtDupFlag(db, resolved.id, conformTxs(db, applyLearned(db, parsed.transactions))) };
  }
  return { ...base, resolvedCard: null,
    candidates: candidates.map(c => ({ id: c.id, name: c.name, lastFour: c.lastFour || null })) };
}

/** 指定卡片預覽（自動判斷失敗時使用者選卡、或預覽中改卡後重解析）。 @param {string} cardId @param {string} b64 */
export async function previewForCard(cardId, b64) {
  const db = getDb();
  const card = (db.cards || []).find(c => c.id === cardId);
  if (!card) throw apiError(404, '找不到卡片');
  const bytes = decode(String(b64 || ''));
  let parsed;
  try { parsed = await parseStatement(bytes, card.pdfPassword); }
  catch (e) { throw apiError(400, String(/** @type {any} */ (e).message || '解析失敗')); }   // 密碼錯/格式錯＝使用者層 400（維持原味訊息）
  return { bank: parsed.bank, lastFour: parsed.lastFour || null,
    card: { id: card.id, name: card.name }, transactions: stmtDupFlag(db, card.id, conformTxs(db, applyLearned(db, parsed.transactions))) };
}

/** 匯入：把使用者確認過的列寫進記帳（再做一次重複防呆）＋匯入時學習。 @param {string} cardId @param {any[]} rows */
export function importRows(cardId, rows) {
  const db = getDb();
  const card = (db.cards || []).find(c => c.id === cardId);
  if (!card) throw apiError(404, '找不到卡片');
  const list = Array.isArray(rows) ? rows : [];
  const existing = new Set((db.transactions || []).map(t => t.stmtRef).filter(Boolean));
  const batchId = uid();                       // 這次匯入的批次代號（供事後整批改卡片）
  const importedAt = new Date().toISOString();
  let imported = 0, skipped = 0;
  for (const r of list) {
    const amount = Number(r.amount);
    // 負數（繳款/退款）不入帳；上限防呆：單筆信用卡消費不可能破億，超過者多為解析誤抓參考號碼→跳過，避免灌爆當月支出
    if (!r.date || !(amount > 0) || amount > 1e8 || !r.stmtRef) { skipped++; continue; }
    if (existing.has(r.stmtRef)) { skipped++; continue; }
    const [category, subcategory] = resolveImportCategory(db, String(r.category || '生活'), String(r.subcategory || ''));
    const storeKey = String(r.storeKey || r.store || '');   // 穩定 key（清理後原名）；顯示名可能已被學習覆蓋
    (db.transactions ||= []).push({
      id: uid(), date: r.date, type: 'expense', category, subcategory, amount,
      account: card.name, note: String(r.store || r.desc || ''), storeKey,   // note＝顯示店名；storeKey＝穩定 key；stmtRef 用原始 desc
      stmtRef: r.stmtRef, source: 'stmt', importBatch: batchId, importedAt
    });
    learnFromImport(db, storeKey, r.desc, category, subcategory);
    existing.add(r.stmtRef);
    imported++;
  }
  saveDb(db);
  return { ok: true, imported, skipped, batchId, cardId: card.id, cardName: card.name };
}

/** 批次清單：把 source:'stmt' 的交易依 importBatch 聚合（卡片名/日期範圍/筆數/金額）。 */
export function listBatches() {
  const db = getDb();
  /** @type {Record<string, any>} */
  const groups = {};
  for (const t of db.transactions || []) {
    if (t.source !== 'stmt' || !t.importBatch) continue;
    const g = groups[t.importBatch] || (groups[t.importBatch] = {
      batchId: t.importBatch, cardName: t.account || '', importedAt: t.importedAt || '',
      count: 0, amount: 0, minDate: t.date, maxDate: t.date
    });
    g.count++; g.amount += Number(t.amount) || 0;
    if (t.date < g.minDate) g.minDate = t.date;
    if (t.date > g.maxDate) g.maxDate = t.date;
  }
  return Object.values(groups).sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
}

/** 整批改卡片：改 account＋重寫 stmtRef 的卡片前綴；目標卡已有同筆則丟棄重複。 @param {string} batchId @param {string} toCardId */
export function reassignBatch(batchId, toCardId) {
  const db = getDb();
  const id = String(batchId || '');
  const card = (db.cards || []).find(c => c.id === String(toCardId || ''));
  if (!id) throw apiError(400, '缺少批次代號');
  if (!card) throw apiError(404, '找不到目標卡片');
  const others = new Set((db.transactions || [])
    .filter(t => t.importBatch !== id).map(t => t.stmtRef).filter(Boolean));   // 目標卡既有 stmtRef（排除本批）
  let moved = 0, dropped = 0;
  const kept = [];
  for (const t of db.transactions || []) {
    if (t.importBatch !== id) { kept.push(t); continue; }
    const ref = String(t.stmtRef || '');
    const idx = ref.indexOf('|');
    const newRef = idx >= 0 ? card.id + ref.slice(idx) : ref;
    if (others.has(newRef)) { dropped++; continue; }   // 目標卡已有同筆消費 → 丟棄重複
    others.add(newRef);
    kept.push({ ...t, account: card.name, stmtRef: newRef });
    moved++;
  }
  db.transactions = kept;
  saveDb(db);
  return { ok: true, moved, dropped, cardName: card.name };
}

/** 刪除整批：把某次匯入的所有消費從記帳移除（解析/分類不對時整批砍掉重匯）。 @param {string} batchId */
export function deleteBatch(batchId) {
  const db = getDb();
  const id = String(batchId || '');
  if (!id) throw apiError(400, '缺少批次代號');
  const before = (db.transactions || []).length;
  db.transactions = (db.transactions || []).filter(t => t.importBatch !== id);
  const removed = before - db.transactions.length;
  saveDb(db);
  return { ok: true, removed };
}

/**
 * 店名格式整理（可重複執行，使用者定 2026-07）：把既有交易的顯示說明（note）整理成統一格式
 *（分店括號＋品牌名，normalizeStoreDisplay），並對齊 storeKey 與學習表 key（future 匯入的
 * storeKey 會是正規化格式，舊 key 才對得上）。新增整理規則後再跑一次即可套到舊資料。
 * dryRun=true 只回預覽（note 的 before→after，最多 200 筆），不寫檔。實際套用會自動備份（save 內建 .bak）。
 * @param {boolean} [dryRun]
 */
export function normalizeBranches(dryRun = false) {
  const db = getDb();
  /** @type {{id:string, before:string, after:string}[]} */
  const changes = [];
  for (const t of db.transactions || []) {
    const beforeNote = String(t.note || '');
    const afterNote = normalizeStoreDisplay(beforeNote);
    if (afterNote !== beforeNote) {
      changes.push({ id: t.id, before: beforeNote, after: afterNote });
      if (!dryRun) t.note = afterNote;
    }
    if (!dryRun && t.storeKey) t.storeKey = normalizeStoreDisplay(String(t.storeKey));   // 內部 key 一併對齊（不列入 note 預覽）
  }
  // 學習表 key 一併正規化；正規化後若撞 key，保留先到的（避免覆蓋既有學習）
  let learnedRemapped = 0;
  if (!dryRun) {
    const lc = db.learnedCategories || {};
    /** @type {Record<string, any>} */
    const newLc = {};
    for (const [k, v] of Object.entries(lc)) {
      const nk = normalizeStoreDisplay(k);
      if (nk !== k) learnedRemapped++;
      newLc[nk] = newLc[nk] || v;
    }
    db.learnedCategories = newLc;
    saveDb(db);
  }
  return { changed: changes.length, learnedRemapped, changes: dryRun ? changes.slice(0, 200) : undefined };
}

/**
 * 整批改顯示名（店名對照表的編輯，使用者定 2026-07）：同 storeKey 的所有帳單交易 note 一起改，
 * 並記進學習表（口徑同 learnFromStmtEdit：新名≠自動名→記 name、改回自動名→清除 name、服務費不學），
 * 未來匯入同一家店自動沿用新名。
 * @param {string} storeKey @param {string} name
 */
export function renameStoreDisplay(storeKey, name) {
  const db = getDb();
  const key = String(storeKey || '').trim();
  const newName = String(name || '').trim();
  if (!key) throw apiError(400, '缺少店名鑰匙（storeKey）');
  if (!newName) throw apiError(400, '顯示名不可為空');
  let changed = 0;
  for (const t of db.transactions || []) {
    if (t.source !== 'stmt' || t.storeKey !== key) continue;
    if (t.note !== newName) { t.note = newName; changed++; }
  }
  if (!isServiceFee(key) && !isServiceFee(newName)) {   // 服務費不學（同 learning.js 檔頭說明）
    const e = (db.learnedCategories ||= {})[key] || {};
    if (newName !== key) e.name = newName;
    else delete e.name;   // 改回自動名＝取消自訂
    db.learnedCategories[key] = e;
  }
  saveDb(db);
  return { ok: true, changed };
}

/** 學習表檢視。 */
export function getLearned() { return getDb().learnedCategories || {}; }

/** 刪除一筆學習。 @param {string} key */
export function deleteLearned(key) {
  const db = getDb();
  const k = String(key || '');
  if (db.learnedCategories && k in db.learnedCategories) delete db.learnedCategories[k];
  saveDb(db);
  return { ok: true };
}
