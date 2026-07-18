// @ts-check
// 信用卡帳單匯入（B2 服務層）：預覽（免選卡自動歸卡／指定卡）、匯入、批次管理、學習表檢視刪除。
// PDF 只在記憶體解析、不落地保存；密碼取自卡片 pdfPassword。
// 錯誤以 throw 帶 status 回報（路由層轉成對應 HTTP 狀態）。
import { getDb, saveDb, uid } from '../repo.js';
import { parseStatement, normalizeStoreDisplay, isServiceFee, cleanStore, storeKeyOf, storeKeyOfName, origFromStmtRef, isPlatformArtifactName, categorize, applyDisplayLabels, stripDisplayLabels } from '../statement.js';
import { applyLearned, learnFromImport } from './learning.js';
import { resolveImportCategory } from './categories.js';
/** @typedef {import('../types.js').Db} Db */

/** 把一批交易的 (category,subcategory) 校正到生效樹（內建分類被改名→沿用新名、被刪→其他/未分類），
 *  並替「顯示名」加上下文標記（FP 外送／停車費），讓匯入預覽就看得到最終顯示樣子。 */
const conformTxs = (/** @type {Db} */ db, /** @type {any[]} */ txs) =>
  txs.map(t => {
    const [c, s] = resolveImportCategory(db, t.category, t.subcategory);
    return { ...t, category: c, subcategory: s, store: applyDisplayLabels(t.store, { desc: t.desc, subcategory: s }) };
  });

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
    // 身分鑰匙（品牌層、不含分店與顯示標記）：**一律從帳單原文重算**（Codex#8）——
    // r.storeKey 是前端傳回來的衍生值，舊分頁/異常請求可能帶著污染字串（含顯示標記）進來當學習 key。
    const desc = String(r.desc || '');
    const storeKey = desc ? storeKeyOf(desc) : String(r.storeKey || '');
    // 顯示名再過一次標記（使用者可能在預覽改了分類 → 停車標記要跟著；預覽已加過的靠冪等不重複）
    const note = applyDisplayLabels(String(r.store || r.desc || ''), { desc: r.desc, subcategory });
    (db.transactions ||= []).push({
      id: uid(), date: r.date, type: 'expense', category, subcategory, amount,
      account: card.name, note, storeKey,   // note＝顯示店名（含標記）；storeKey＝穩定 key（不含標記）；stmtRef 用原始 desc
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
  /** @type {Map<string, string>} 交易 storeKey 舊→新（規則升級改變 cleanStore 結果時，學習表 key 要跟著搬） */
  const skMap = new Map();
  /** @type {Map<string, string>} 帳單原文 → 該搬到原文級的顯示名（舊 storeKey 級 name，見迴圈內說明） */
  const nameByOrig = new Map();
  const lc0 = db.learnedCategories || {};
  for (const t of db.transactions || []) {
    const beforeNote = String(t.note || '');
    // 顯示標記需要上下文：帳單原文（判 FP）＋子類（判停車）。原文從 stmtRef 第 4 段取回——
    // 這也是「舊 FP 記錄」能補上（FP）的原因：匯入當時前綴已被砍掉，只有原文還留著。
    const orig = t.source === 'stmt' ? origFromStmtRef(t.stmtRef) : '';
    // 自訂 vs 自動（使用者定 2026-07-18，起因＝eTag 場站名只在原文裡、舊 note 救不回）：
    // 使用者自訂過名字的（學習表有 name：原文級／新舊 storeKey 級）→ 就地整理（拆標記→整理→重上標記，保留自訂）；
    // 沒自訂的＝當年自動產的 → 直接用「現行規則」從帳單原文重生（cleanStore），規則升級才能全套上。
    // 手動記帳（無原文）只能就地整理。⚠️顯示名用 cleanStore（帶分店），身分鑰匙才用 storeKeyOf（品牌層）。
    const auto0 = orig ? cleanStore(orig) : '';
    const sk0 = orig ? storeKeyOf(orig) : '';
    const oldKey = String(t.storeKey || '');
    // 自訂名以「學習表」為準（不是交易上的舊 note）：note 可能被舊版規則改壞（優食（UE）＝平台被當店名），
    // 拿壞掉的 note 再整理只會壞下去。平台殘骸名（isPlatformArtifactName）不算自訂 → 丟掉、走重生。
    /** @param {string} k @returns {string} */
    const nameOf = (k) => (k && Object.hasOwn(lc0, k) && typeof lc0[k]?.name === 'string') ? lc0[k].name : '';   // hasOwn：擋 constructor 這類原型鍵（Codex#7）
    const customName = [nameOf(orig), nameOf(sk0), nameOf(oldKey)].find(n => n && !isPlatformArtifactName(n)) || '';
    const base = customName ? normalizeStoreDisplay(stripDisplayLabels(customName))
      : (orig ? auto0 : normalizeStoreDisplay(stripDisplayLabels(beforeNote)));   // 手動記帳（無原文）只能就地整理
    const afterNote = applyDisplayLabels(base, { desc: orig, subcategory: t.subcategory });
    if (afterNote !== beforeNote) {
      changes.push({ id: t.id, before: beforeNote, after: afterNote });
      if (!dryRun) t.note = afterNote;
    }
    // 品牌層學過的顯示名，是「帶分店的名字」：留在品牌層會讓同品牌其他分店被連動改名
    // （＝12MINI 桃/新 連動 bug 的翻版）→ 記下來，稍後改掛到「原文級」這個正確的層。
    // ⚠️ Codex#3：**不論品牌 key 有沒有變動都要搬**——原本只在 oldKey!==sk0 時搬，key 沒變的
    // （統一超商 → 統一超商）殘留 name 就會繼續連動；品牌層 entry 一律不該有 name。
    const brandName = nameOf(sk0) || nameOf(oldKey);
    if (orig && brandName && !isPlatformArtifactName(brandName)) nameByOrig.set(orig, brandName);
    // 內部 key 一併對齊（不列入 note 預覽）：有原文→用 storeKeyOf 重算（規則升級全套上）；沒有→就地正規化。
    // ⚠️ Codex#5：舊帳單資料可能整筆沒有 storeKey（學習機制上線前匯入的），此處要**補寫**而非只對齊——
    // 沒有鑰匙的交易在店家檔案會退用 note 分組，同店不同分店合不起來、也吃不到品牌層學習。
    if (!dryRun) {
      const newKey = (orig ? sk0 : storeKeyOfName(normalizeStoreDisplay(oldKey))) || oldKey;
      if (newKey && newKey !== oldKey) {
        if (oldKey) skMap.set(oldKey, skMap.get(oldKey) ?? newKey);   // 舊 key 存在才需要搬學習表
        t.storeKey = newKey;
      }
    }
  }
  // 學習表 key 一併正規化：storeKey 級的 key 跟著交易 storeKey 的舊→新對照搬（skMap；規則升級後
  // cleanStore 結果可能整個改變，光就地正規化搬不動），對照表沒有的再就地正規化；撞 key 保留先到的。
  // ⚠️ Codex#4：原文級學習的 key＝帳單原文（原始未清理字串，如「全家便利商店-三重新陽店A0145 TAIPEI」），
  // 絕不可被店名正規化改寫——改了會既不等於原文、也不等於真正的 storeKey，未來匯入永遠命中不到那條學習。
  let learnedRemapped = 0, learnedNamesFixed = 0;
  if (!dryRun) {
    const origSet = new Set();
    for (const t of db.transactions || []) {
      if (t.source !== 'stmt' || !t.stmtRef) continue;
      const o = origFromStmtRef(t.stmtRef);
      if (o) origSet.add(o);
    }
    const lc = db.learnedCategories || {};
    /** @type {Record<string, any>} */
    const newLc = {};
    for (const [k, v] of Object.entries(lc)) {
      const isOrigKey = origSet.has(k);
      const nk = isOrigKey ? k : (skMap.get(k) ?? normalizeStoreDisplay(k));   // 是帳單原文（原文級 key）→ 原樣保留
      if (nk !== k) learnedRemapped++;
      // 品牌層 entry 一律不留 name（Codex#3；顯示名改掛原文級，見下）——原文級的照舊保留
      const val = (!isOrigKey && v && typeof v === 'object' && 'name' in v)
        ? Object.fromEntries(Object.entries(v).filter(([f]) => f !== 'name'))
        : v;
      // ⚠️ Codex#2：撞 key 時原本用 `newLc[nk] || val`——空物件 {} 在 JS 是 truthy，
      // 先到的「被摘掉 name 後剩空殼」會擋掉後到者的分類學習（實測：全家商店 → {}）。
      // 改成欄位層級合併：先到者的欄位優先，缺的欄位由後到者補上。
      const prev = newLc[nk];
      newLc[nk] = prev ? { ...val, ...prev } : val;
    }
    // 把「原本掛在 storeKey 級的顯示名」改掛到原文級（正確的層）——已存在的原文級 name 優先，不覆蓋
    let namesMovedToOrig = 0;
    for (const [o, nm] of nameByOrig) {
      const e = newLc[o] || {};
      if (e.name) continue;
      e.name = nm; newLc[o] = e; namesMovedToOrig++;
    }
    learnedRemapped += namesMovedToOrig;
    // 學過的「顯示名」也用同一套規則治一次（舊版規則時代學到的錯名，如「停車場（Times）」，
    // 不治的話下次匯入又蓋回錯名）。標記先拆再整理——學習值不該帶標記（匯入端會重新上）。
    for (const [k, v] of Object.entries(newLc)) {
      if (!v || typeof v.name !== 'string' || !v.name) continue;
      if (isPlatformArtifactName(v.name)) {        // 平台殘骸名：刪掉才不會在下次匯入又蓋回錯名
        delete v.name; learnedNamesFixed++;
        if (!Object.keys(v).length) delete newLc[k];
        continue;
      }
      const nv = normalizeStoreDisplay(stripDisplayLabels(v.name));
      if (nv && nv !== v.name) { v.name = nv; learnedNamesFixed++; }
    }
    db.learnedCategories = newLc;
    saveDb(db);
  }
  return { changed: changes.length, learnedRemapped, learnedNamesFixed, changes: dryRun ? changes.slice(0, 200) : undefined };
}

/**
 * 編輯店名與分類（合併版「帳單說明／分類學習」卡的編輯，使用者定 2026-07-18）：
 * 以「帳單原文」為準（＝stmtRef 第 4 段）——只影響這個原文的帳單交易（各月份整批改），
 * 銀行截斷的店名（FP-12MINI (桃…/(新…）共用 storeKey，以原文為準不同分店才能各自取名/分類。
 * 學習口徑（以原文為 key、覆寫式）：只記「與自動判斷不同」的部分——顯示名≠cleanStore(orig) 才記 name、
 * 分類≠自動分類（categorize→resolveImportCategory 別名校正）才記 category/subcategory；
 * 全部同自動＝刪除整個 entry（自我修剪）。reset=true＝整列還原自動判斷（交易改回自動值＋清除學習）。
 * 服務費不學。applyLearned 的原文級覆蓋（name＋category）優先於 storeKey 級。
 * @param {string} orig @param {string} name
 * @param {string=} category 有給才改分類 @param {string=} subcategory @param {boolean=} reset
 * @param {boolean=} clearBrand reset 時連同「同品牌共用的分類規則」一起清（使用者在前端二次確認後才會帶）
 */
export function renameStoreDisplay(orig, name, category, subcategory, reset = false, clearBrand = false) {
  const db = getDb();
  const o = String(orig || '').trim();
  if (!o) throw apiError(400, '缺少帳單原文');
  // 自動判斷值：分類＝內建分類器再過別名/生效樹校正；顯示名＝cleanStore 再加顯示標記（FP／停車費），
  // 與匯入端、遷移端同口徑——否則「打開編輯窗直接儲存」會把帶標記的現值誤記成自訂名。
  const [autoCat, autoSub] = resolveImportCategory(db, ...categorize(o));
  const autoName = applyDisplayLabels(cleanStore(o), { desc: o, subcategory: autoSub });
  const newName = reset ? autoName : String(name || '').trim();
  if (!newName) throw apiError(400, '顯示名不可為空');
  const hasCat = reset || category !== undefined;
  const newCat = reset ? autoCat : String(category || '');
  const newSub = reset ? autoSub : String(subcategory || '');
  if (hasCat && !reset && !newCat) throw apiError(400, '分類不可為空');
  let changed = 0;
  /** @type {{key: string, sharedCount: number} | null} 還原時保留下來的同品牌共用分類規則（前端據此二次確認） */
  let brandRule = null;
  for (const t of db.transactions || []) {
    if (t.source !== 'stmt' || !t.stmtRef) continue;
    const parts = String(t.stmtRef).split('|');
    if (parts.length < 4 || parts.slice(3).join('|').trim() !== o) continue;
    let touched = false;
    if (t.note !== newName) { t.note = newName; touched = true; }
    if (hasCat && (t.category !== newCat || (t.subcategory || '') !== newSub)) { t.category = newCat; t.subcategory = newSub; touched = true; }
    if (touched) changed++;
  }
  if (!isServiceFee(o) && !isServiceFee(newName)) {   // 服務費不學（同 learning.js 檔頭說明）
    const lc = (db.learnedCategories ||= {});
    /** @type {any} */
    const e = {};                                     // 覆寫式：每次編輯重算整個 entry（彈窗呈現的就是完整現狀）
    if (newName !== autoName) e.name = newName;
    if (hasCat && (newCat !== autoCat || newSub !== (autoSub || ''))) { e.category = newCat; e.subcategory = newSub; }
    else if (!hasCat && lc[o]?.category) { e.category = lc[o].category; e.subcategory = lc[o].subcategory || ''; }   // 只改名不動分類→保留既有分類學習
    if (Object.keys(e).length) lc[o] = e;
    else delete lc[o];                                // 全部同自動＝不需要規則（自我修剪）
    // 還原自動判斷（Codex#3）：只刪原文級不夠——若同 storeKey 還有共用學習，下次匯入本原文又會被套回舊值。
    // 只有當這個 storeKey 「沒有被其他原文共用」時才可刪共用學習（共用時刪會誤傷其他分店，故保留）。
    // ⚠️ storeKey＝storeKeyOf(o)（品牌層、不含分店與顯示標記）；autoName 是顯示名（帶分店＋標記），
    // 兩者不同，不可拿 autoName 當 key 找。品牌層 key 常被同品牌其他分店共用 → 共用時保留（見下）。
    const sk = storeKeyOf(o);
    if (reset && Object.hasOwn(lc, sk)) {
      const sharedOrigs = new Set();
      for (const t of db.transactions || []) {
        if (t.source !== 'stmt' || !t.stmtRef) continue;
        const oo = origFromStmtRef(t.stmtRef);
        if (oo && oo !== o && storeKeyOf(oo) === sk) sharedOrigs.add(oo);
      }
      // ⚠️ Codex#4：鑰匙改品牌層後「被其他分店共用」變成常態 → 共用時保留（免誤傷其他分店），
      // 但這代表「還原」只是暫時的：下次匯入本原文又會被品牌規則套回舊分類。所以要回報給前端，
      // 由使用者決定要不要連同品牌規則一起清（clearBrand）。
      if (!sharedOrigs.size || clearBrand) delete lc[sk];
      else if (lc[sk]?.category) brandRule = { key: sk, sharedCount: sharedOrigs.size };
    }
  }
  saveDb(db);
  return { ok: true, changed, brandRule };
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
