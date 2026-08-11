// @ts-check
// 信用卡帳單匯入（B2 服務層）：預覽（免選卡自動歸卡／指定卡）、匯入、批次管理、學習表檢視刪除。
// PDF 只在記憶體解析、不落地保存；密碼取自卡片 pdfPassword。
// 錯誤以 throw 帶 status 回報（路由層轉成對應 HTTP 狀態）。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getDb, saveDb, uid } from '../repo.js';
import { parseStatement, normalizeStoreDisplay, isServiceFee, isCardPayment, cleanStore, storeKeyOf, storeKeyOfName, origFromStmtRef, isPlatformArtifactName, categorize, applyDisplayLabels, stripDisplayLabels } from '../statement.js';
import { reconcileCardStatement, gateFailureMessage } from '../statement-reconcile.js';
import { userRulesFingerprint } from '../store-rules.js';
import { applyLearned, learnFromImport, customStoreName, migrateBrandName } from './learning.js';
import { resolveImportCategory, parkingSubName } from './categories.js';
import { isRealMonth, isRealDate, LEN_SHORT, LEN_LONG } from '../schema.js';
import { getOwn, setOwn, isProtoKey, emptyMap } from '../safe-map.js';
import { DEFAULT_EXPENSE } from '../../public/modules/categories.js';
/** @typedef {import('../types.js').Db} Db */

/** 把一批交易的 (category,subcategory) 校正到生效樹（內建分類被改名→沿用新名、被刪→其他/未分類），
 *  並替「顯示名」加上下文標記（FP 外送／停車費），讓匯入預覽就看得到最終顯示樣子。
 *  ⚠️ 自訂名（applyLearned 標了 storeCustom）逐字、不貼標記（使用者定 2026-07-20）——只有自動名才套。 */
const conformTxs = (/** @type {Db} */ db, /** @type {any[]} */ txs) => {
  const parkSub = parkingSubName(db);   // 護欄 G4：「停車費」子類現名，整批共用一次解析（改名後仍認得停車包裝）
  return txs.map(t => {
    const [c, s] = resolveImportCategory(db, t.category, t.subcategory);
    const store = t.storeCustom ? t.store : applyDisplayLabels(t.store, { desc: t.desc, subcategory: s, parkSub });
    return { ...t, category: c, subcategory: s, store };
  });
};

/** 帶 HTTP 狀態的錯誤（路由層 catch 後用 e.status 回應）。 @param {number} status @param {string} msg */
const apiError = (status, msg) => Object.assign(new Error(msg), { status });

// 重複偵測：每筆算 stmtRef（卡id+消費日+金額+說明），與既有記帳比對標記 duplicate。
// ⚠️ 同步點（AGENTS.md）：改 stmtRef 格式要連動 reassignBatch 的前綴重寫＋origFromStmtRef 的原文取回（含 |#N 序號段的剝除）。
function stmtDupFlag(db, cardId, txs) {
  const existing = new Set((db.transactions || []).map(t => t.stmtRef).filter(Boolean));
  // 同帳單內「同卡+同日+同額+同說明」的第 N 筆（N≥2）加序號段 `|#N`（自主體檢，使用者定 2026-07-22）：
  // 同天在同店買兩杯一樣的咖啡是真消費，不加序號會產生相同 stmtRef → 第二筆被當重複默默吃掉。
  // 序號依「解析順序」決定＝**重匯同一份帳單仍得到同一組 stmtRef**，去重照樣正確（重匯不會多出來）。
  // ⚠️ `|#N` 是附加段，origFromStmtRef 會把它剝掉（銀行說明不含 `|`，實務上不會誤傷）。
  /** @type {Map<string, number>} */
  const seen = new Map();
  return txs.map(t => {
    const base = `${cardId}|${t.date}|${t.amount}|${t.desc}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const stmtRef = n === 1 ? base : `${base}|#${n}`;
    return { ...t, stmtRef, duplicate: existing.has(stmtRef) };
  });
}
const issuerMatchesBank = (/** @type {any} */ issuer, /** @type {string} */ bank) => String(issuer || '').includes(bank);

const decode = (/** @type {string} */ b64) => {
  if (!b64) throw apiError(400, '沒有收到檔案內容');
  return new Uint8Array(Buffer.from(b64, 'base64'));
};

/**
 * 解析失敗的錯誤歸因（Codex #373 r1 Medium）：**5xx／503 一律原樣往上拋**。
 * 原本兩個入口把所有例外都包成 400，連 spawn 失敗、子行程協定損壞、部署相依錯誤都變成
 * 「你的檔案有問題」，而且丟掉 `code` 與 `cause`——那正是 #350／#358 花好幾輪修掉的病，
 * 在這一層又犯一次。只有**已知的使用者層錯誤**（密碼、格式、無明細）才是 400。
 * @param {unknown} e @returns {never}
 */
export function rethrowParseError(e) {
  const err = /** @type {any} */ (e);
  const st = Number(err?.status);
  if (st >= 500 || st === 503) throw err;   // 我們的問題／back-pressure：原樣（含 code、cause）交給路由層
  throw apiError(st || 400, String(err?.message || '解析失敗'));
}

/** 對帳閘（P0，2026-08-11）：驗「帳單自己的數學」（中閘＝摘要等式＋明細加總對摘要；判準在 statement-reconcile.js）。
 * 不一致＝整份 400 擋下（fail-closed）；讀不到總額（如台新官網 XLSX）＝誠實降級弱閘、照舊放行。
 * ⚠️ 卡片的閘只能設在**預覽**（解析發生的地方）：importRows 吃的是使用者勾選的列、不重新解析檔案
 * （已知取捨，同 stmtRef 的 |#N 段劃界——單機自用，繞過前端直打 importRows 的人＝使用者本人）。 @param {any} parsed */
export function assertCardReconciled(parsed) {
  const gate = reconcileCardStatement(parsed);
  if (!gate.ok) throw apiError(400, gateFailureMessage(gate, '信用卡帳單'));
  return gate;
}

/** 免選卡自動預覽：試各卡密碼解密→判銀行＋末四碼→自動歸卡；認不出回 candidates 讓使用者選。 @param {string} b64 */
export async function previewAuto(b64) {
  const db = await getDb();
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
  if (!parsed) rethrowParseError(lastErr);
  const reconcile = assertCardReconciled(parsed);   // 對帳閘：解析成功才驗（密碼錯的重試不經這裡）；對不上＝400
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
  // ⚠️ statementMonth／statementDue 一定要往上帶（2026-07-19 修）：前端匯入時是從**預覽的回應**
  // 讀這兩個值再送進 importRows 的（`curR.statementMonth` / `curR.statementDue`）。
  // 之前這裡只挑了 bank/lastFour/transactions，解析器讀到的期別與應繳金額在這一步被默默丟掉，
  // 結果每一批都退回「推估」年月、應繳金額永遠空白——兩端各自都對，斷在中間這條線上。
  const base = { bank: parsed.bank, lastFour: parsed.lastFour || null,
    statementMonth: parsed.statementMonth || '', statementDue: parsed.statementDue ?? null, reconcile };
  if (resolved) {
    return { ...base, resolvedCard: { id: resolved.id, name: resolved.name, lastFour: resolved.lastFour || null },
      transactions: stmtDupFlag(db, resolved.id, conformTxs(db, applyLearned(db, parsed.transactions))) };
  }
  return { ...base, resolvedCard: null,
    candidates: candidates.map(c => ({ id: c.id, name: c.name, lastFour: c.lastFour || null })) };
}

/** 指定卡片預覽（自動判斷失敗時使用者選卡、或預覽中改卡後重解析）。 @param {string} cardId @param {string} b64 */
export async function previewForCard(cardId, b64) {
  const db = await getDb();
  const card = (db.cards || []).find(c => c.id === cardId);
  if (!card) throw apiError(404, '找不到卡片');
  const bytes = decode(String(b64 || ''));
  let parsed;
  try { parsed = await parseStatement(bytes, card.pdfPassword); }
  catch (e) { rethrowParseError(e); }   // 密碼錯/格式錯＝400 原味訊息；5xx／503 原樣往上（見 rethrowParseError）
  const reconcile = assertCardReconciled(parsed);   // 對帳閘（P0）：對不上＝400，同 previewAuto
  return { bank: parsed.bank, lastFour: parsed.lastFour || null,
    // 同 previewAuto：這兩個是前端匯入時要回送的，漏了就退回推估年月＋空白應繳金額
    statementMonth: parsed.statementMonth || '', statementDue: parsed.statementDue ?? null, reconcile,
    card: { id: card.id, name: card.name }, transactions: stmtDupFlag(db, card.id, conformTxs(db, applyLearned(db, parsed.transactions))) };
}

/** 匯入：把使用者確認過的列寫進記帳（再做一次重複防呆）＋匯入時學習。 @param {string} cardId @param {any[]} rows */
export async function importRows(cardId, rows, statementMonth = '', statementDue = null) {
  const db = await getDb();
  const card = (db.cards || []).find(c => c.id === cardId);
  if (!card) throw apiError(404, '找不到卡片');
  const stmtMonth = isRealMonth(String(statementMonth || '')) ? String(statementMonth) : '';   // 真實日曆判準（Codex r3#9）
  const stmtDue = Number.isFinite(Number(statementDue)) && statementDue !== null ? Number(statementDue) : null;
  const list = Array.isArray(rows) ? rows : [];
  // 異常輸入防線（Codex #297 複審抓到的繞道）：這個端點吃 req.body.transactions＝HTTP 可直給的
  // 新輸入、不經 pickWritable——超長 desc 會被重建成 note/stmtRef/storeKey 落庫（櫃檯對匯入語意
  // 只 warn 放行）。正常解析器產物碰不到上限（PDF 一行幾十字），能超過的只有繞前端的異常請求
  // → 明確 400 點名（裁決：匯入＝明確拒絕並說明，不靜默丟棄）。desc＝帳單原文給長級（不誤傷匯入內容）。
  /** @type {string[]} */
  const lenBad = [];
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    for (const [k, lim] of /** @type {[string, number][]} */ ([['desc', LEN_LONG], ['category', LEN_SHORT], ['subcategory', LEN_SHORT]])) {
      const v = /** @type {any} */ (r)[k];
      if (typeof v === 'string' && v.length > lim) lenBad.push(`第 ${i + 1} 筆 ${k}(超過 ${lim} 字上限，目前 ${v.length} 字)`);
    }
  });
  if (lenBad.length) throw apiError(400, `匯入內容有欄位超過長度上限，已中止、未寫入任何資料：${lenBad.slice(0, 5).join('；')}${lenBad.length > 5 ? `…共 ${lenBad.length} 筆` : ''}`);
  const existing = new Set((db.transactions || []).map(t => t.stmtRef).filter(Boolean));
  const batchId = uid();                       // 這次匯入的批次代號（供事後整批改卡片）
  const importedAt = new Date().toISOString();
  // 「第一次見到的店家」＝交易與學習表都沒出現過（使用者定 2026-07-19 的匯入完成摘要用）。
  // 兩邊都要看：刪批重匯時交易沒了但學習還在，只看交易會把老店誤報成新店（自審）。
  const seenKeys = new Set([
    ...(db.transactions || []).filter(t => t.source === 'stmt').map(t => String(t.storeKey || '')),
    ...Object.keys(db.learnedCategories || {}),
  ].filter(Boolean));
  /** @type {Set<string>} */
  const newStores = new Set();
  let uncategorized = 0;
  let imported = 0, skipped = 0;
  const parkSub = parkingSubName(db);   // 護欄 G4：「停車費」子類現名（整批共用一次解析）
  for (const r of list) {
    if (!r || typeof r !== 'object') { skipped++; continue; }   // null/非物件列（自主體檢：以前直接炸 500 毒整批）
    const amount = Number(r.amount);
    // desc 一律 trim——與 origFromStmtRef／cleanStore 同口徑：前後補空白的變體會產生不同指紋、
    // 同筆消費重複入帳，畫面上顯示名卻一模一樣、使用者無從分辨（對抗審查實測 4 筆 400 元）。
    const desc = String(r.desc || '').trim();
    // 真正繳款不入帳；其餘負數＝退款候選，照實存進卡帳，P1 彙總時再配對原消費。
    // 上限防呆用絕對值：正／負破億都多半是解析誤抓參考號碼，不可把負雜訊當退款灌進資料。
    // date 過真實日曆（isRealDate，同 statementMonth 的 isRealMonth 判準、Codex r3#9）：壞格式若放行，
    // 會在櫃檯 tripwire 以 500 毒掉整批（含其他合法列）。desc 必填：它是分類/鑰匙/指紋三者的權威來源。
    // desc 含「|」拒收：真帳單說明不含分段字元（既有 documented 假設），放行會讓「stmtRef 第 4 段起＝原文」
    // 不變式破功，還能佔用 |#N 序號家族的位置、把之後真實的「同店第二杯」吃掉（對抗審查實測）。
    const payment = amount < 0 && isCardPayment(desc);   // 後端重判，不信任瀏覽器傳來的 isPayment
    if (!r.date || !isRealDate(String(r.date)) || !Number.isFinite(amount) || amount === 0
      || Math.abs(amount) > 1e8 || payment || !r.stmtRef || !desc || desc.includes('|')) { skipped++; continue; }
    const refund = amount < 0;
    // 身分指紋伺服器端重建（Codex r11#1）：stmtRef＝`卡id|消費日|金額|原文`（＋同帳單重複的 |#N，見 stmtDupFlag）
    // 是衍生值，原樣信任前端會讓「同筆消費、兩個 ref」繞過去重（100 變 200），且假 ref 會毒化
    // origFromStmtRef 的原文取回（改名/整批改分類/體檢/整理全對不上）。前端傳回的值只拿來
    // 「保留合法的 |#N 序號段」（N≤99；序號依整份帳單的解析順序編，匯入端只看勾選子集、無從重編）。
    // ⚠️ 已知取捨：|#N 段本質上仍信前端（伺服器無從分辨「真第二杯」與偽造序號，除非重新解析整份帳單）——
    // 偽造「合法長相」的序號段仍可多入一筆；上限 99 縮小重放面。單機自用實害面窄，勿當回歸報。
    const base = `${card.id}|${r.date}|${amount}|${desc}`;
    const tail = String(r.stmtRef).startsWith(base) ? String(r.stmtRef).slice(base.length) : null;
    const stmtRef = (tail !== null && /^(\|#(?:[2-9]|[1-9]\d))?$/.test(tail)) ? String(r.stmtRef) : base;
    if (existing.has(stmtRef)) { skipped++; continue; }
    const [category, subcategory] = resolveImportCategory(db, String(r.category || '生活'), String(r.subcategory || ''));
    // 身分鑰匙（品牌層、不含分店與顯示標記）：**一律從帳單原文重算**（Codex#8）——
    // r.storeKey 是前端傳回來的衍生值，舊分頁/異常請求可能帶著污染字串（含顯示標記）進來當學習 key。
    const storeKey = storeKeyOf(desc);
    // 顯示名一律從 db 權威重算（不信前端傳回的 r.store——Codex r11#1 抓到舊版註解說到沒做到）：
    // 使用者自訂名＝逐字（使用者定 2026-07-20，不貼標記）；沒自訂＝自動名（cleanStore＋上下文標記，冪等，
    // 與預覽的 finalize→conformTxs 同口徑）。
    const custom = customStoreName(db, desc, storeKey);
    const note = custom || applyDisplayLabels(cleanStore(desc), { desc, subcategory, parkSub });
    // 匯入當下的「完整自動判斷」留底（第二帖，2026-07-19）：r.category 是「學習套用後＋使用者可能
    // 在預覽改過」的值，這裡要重算純自動——日後「現值≠autoCat」＝人碰過，體檢不會誤把人工修正洗掉
    const [autoCat, autoSub] = resolveImportCategory(db, ...categorize(desc));
    (db.transactions ||= []).push({
      id: uid(), date: r.date, type: 'expense', category, subcategory, amount,
      account: card.name, note, storeKey,   // note＝顯示店名（含標記）；storeKey＝穩定 key（不含標記）；stmtRef 用原始 desc
      // ledger:'card'（三層重構 stage 1）：信用卡消費明細帳本——分析/查帳用，不進現金流
      //（現金流出＝銀行帳本日後的「繳卡費」那筆；這裡也算會重複）。服務層擁有欄位，同 autoCat 待遇。
      stmtRef, source: 'stmt', ledger: 'card', importBatch: batchId, importedAt, autoCat, autoSub,
      ...(refund ? { refundOf: null } : {}),   // 服務層標記：P0 待配對；不進 CRUD 白名單
      ...(stmtMonth ? { stmtMonth } : {}),   // 帳單期別（從帳單表頭讀出；讀不到就不寫，列表退回推估值）
      ...(stmtDue !== null ? { stmtDue } : {})   // 帳單自己印的應繳金額（對帳用；與匯入金額本就不同）
    });
    learnFromImport(db, storeKey, desc, category, subcategory);
    if (storeKey && !seenKeys.has(storeKey) && !isServiceFee(storeKey)) { newStores.add(storeKey); seenKeys.add(storeKey); }
    if (category === DEFAULT_EXPENSE[0]) uncategorized++;
    existing.add(stmtRef);
    imported++;
  }
  await saveDb(db);
  return { ok: true, imported, skipped, batchId, cardId: card.id, cardName: card.name,
    newStores: [...newStores], uncategorized };
}

/** 批次清單：把 source:'stmt' 的交易依 importBatch 聚合（卡片名/日期範圍/筆數/金額）。 */
export async function listBatches() {
  const db = await getDb();
  /** @type {Record<string, any>} */
  const groups = Object.create(null);   // 批次 id 可經備份匯入/CRUD 寫入任意字串：'__proto__' 在普通物件上會讓
  // 「讀到原型本尊（truthy）→ 在全域原型上累加 count/amount、批次從清單消失」（Codex r6#3 實測）
  for (const t of db.transactions || []) {
    if (t.source !== 'stmt' || !t.importBatch) continue;
    const g = groups[t.importBatch] || (groups[t.importBatch] = {
      batchId: t.importBatch, cardName: t.account || '', importedAt: t.importedAt || '',
      count: 0, amount: 0, minDate: t.date, maxDate: t.date, stmtMonth: '', stmtDue: null
    });
    if (!g.stmtMonth && t.stmtMonth) g.stmtMonth = String(t.stmtMonth);   // 帳單期別（讀自帳單表頭或使用者修正）
    if (g.stmtDue == null && t.stmtDue != null) g.stmtDue = Number(t.stmtDue);   // 帳單應繳金額
    g.count++; g.amount += Number(t.amount) || 0;
    if (t.date < g.minDate) g.minDate = t.date;
    if (t.date > g.maxDate) g.maxDate = t.date;
  }
  return Object.values(groups).sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
}

/** 整批改卡片：改 account＋重寫 stmtRef 的卡片前綴；目標卡已有同筆則丟棄重複。 @param {string} batchId @param {string} toCardId */
export async function reassignBatch(batchId, toCardId) {
  const db = await getDb();
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
  await saveDb(db);
  return { ok: true, moved, dropped, cardName: card.name };
}

/** 刪除整批：把某次匯入的所有消費從記帳移除（解析/分類不對時整批砍掉重匯）。 @param {string} batchId */
export async function deleteBatch(batchId) {
  const db = await getDb();
  const id = String(batchId || '');
  if (!id) throw apiError(400, '缺少批次代號');
  const before = (db.transactions || []).length;
  db.transactions = (db.transactions || []).filter(t => t.importBatch !== id);
  const removed = before - db.transactions.length;
  await saveDb(db);
  return { ok: true, removed };
}

/**
 * 店名格式整理（可重複執行，使用者定 2026-07）：把既有交易的顯示說明（note）整理成統一格式
 *（分店括號＋品牌名，normalizeStoreDisplay），並對齊 storeKey 與學習表 key（future 匯入的
 * storeKey 會是正規化格式，舊 key 才對得上）。新增整理規則後再跑一次即可套到舊資料。
 * dryRun=true 只回預覽（note 的 before→after，最多 200 筆），不寫檔。
 * ⚠️ **這條路刻意沒有「操作前自動備份」**：不產生 `pre-normalize.bak`、不擋、不問——理由與刻意
 * 接受的代價寫在 `lib/services/backup.js` 的設計註解。救援手段＝每日滾動備份與使用者自己按的〈匯出備份〉。
 * ⚠️ 別把別的東西誤當成這裡的安全帶：`saveDb` 不碰任何 `.bak`；啟動備份 `.bak` 由 `lib/store.js`
 *  的 `backupOnce` 每個行程只寫一次，對「一天內整理好幾次」沒有保護力。
 * @param {boolean} [dryRun]
 */
export async function normalizeBranches(dryRun = false) {
  const db = await getDb();
  /** @type {{id:string, before:string, after:string}[]} */
  const changes = [];
  /** @type {Map<string, string>} 交易 storeKey 舊→新（規則升級改變 cleanStore 結果時，學習表 key 要跟著搬） */
  const skMap = new Map();
  /** @type {Map<string, string>} 帳單原文 → 該搬到原文級的顯示名（舊 storeKey 級 name，見迴圈內說明） */
  const nameByOrig = new Map();
  /** @type {Set<string>} 名字已收進 nameByOrig 的品牌 key——只有「確定有著落」的品牌層 name 才可摘（Codex r11#4） */
  const brandNameLanded = new Set();
  /** @type {Set<string>} 現存交易用過的 storeKey（新舊都收）＝「證明得了是品牌級」的 key 清單（r2-Codex#1） */
  const keysSeen = new Set();
  const lc0 = db.learnedCategories || {};
  let keyChanged = 0;
  const parkSub = parkingSubName(db);   // 護欄 G4：「停車費」子類現名（整批共用一次解析）
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
    // 自訂名＝逐字顯示（使用者定 2026-07-20）：套品牌改寫規則（normalizeStoreDisplay：OLD→NEW、殘骸治療
    // 停車場（Times）→台灣普客二四），但**不再拆／貼顯示標記**——「人从众厚切牛排（FP）」的（FP）不會被動、
    // 也不再跳確認閘；使用者若把（FP）或「停車費（）」拿掉，逐字保留、下次不會被 app 自動補回去。
    // 為何不「治好後補標記」：治好的殘骸名（台灣普客二四）與使用者刻意拿掉包裝的名字（嘟嘟房林口站）都＝自動底名，
    // 補標記就會把使用者「刻意拿掉的包裝」硬加回來——違反上面的鐵則，故一律逐字。
    // 沒自訂＝自動名：帳單有原文用現行規則重生（cleanStore）＋標記；手動記帳（無原文）就地整理＋標記。
    const afterNote = customName ? normalizeStoreDisplay(customName, { customName: true })   // 自訂名不套加油站改寫（逐字，自審A#2）
      : applyDisplayLabels(orig ? auto0 : normalizeStoreDisplay(stripDisplayLabels(beforeNote)),
        { desc: orig, subcategory: t.subcategory, parkSub });
    if (afterNote !== beforeNote) {
      changes.push({ id: t.id, before: beforeNote, after: afterNote });
      if (!dryRun) t.note = afterNote;
    }
    // 品牌層學過的顯示名，是「帶分店的名字」：留在品牌層會讓同品牌其他分店被連動改名
    // （＝12MINI 桃/新 連動 bug 的翻版）→ 記下來，稍後改掛到「原文級」這個正確的層。
    // ⚠️ Codex#3：**不論品牌 key 有沒有變動都要搬**——原本只在 oldKey!==sk0 時搬，key 沒變的
    // （統一超商 → 統一超商）殘留 name 就會繼續連動；品牌層 entry 一律不該有 name。
    const brandName = nameOf(sk0) || nameOf(oldKey);
    if (orig && brandName && !isPlatformArtifactName(brandName)) {
      nameByOrig.set(orig, brandName);
      if (nameOf(sk0) === brandName) brandNameLanded.add(sk0);        // 記下名字的來源 key＝它有著落了
      if (nameOf(oldKey) === brandName) brandNameLanded.add(oldKey);
    }
    // 內部 key 一併對齊（不列入 note 預覽）：有原文→用 storeKeyOf 重算（規則升級全套上）；沒有→就地正規化。
    // ⚠️ Codex#5：舊帳單資料可能整筆沒有 storeKey（學習機制上線前匯入的），此處要**補寫**而非只對齊——
    // 沒有鑰匙的交易在店家檔案會退用 note 分組，同店不同分店合不起來、也吃不到品牌層學習。
    // ⚠️ 鑰匙變動在 dryRun 也要算（自審）：預覽只列 note 的話，「鑰匙會怎麼搬、學習表會不會撞」
    // 這些最危險的變更使用者事前看不到——自動整理更需要事後說清楚改了什麼。
    const newKey = (orig ? sk0 : storeKeyOfName(normalizeStoreDisplay(oldKey))) || oldKey;
    if (oldKey) keysSeen.add(oldKey);
    if (newKey) keysSeen.add(newKey);
    if (newKey && newKey !== oldKey) {
      if (oldKey) skMap.set(oldKey, skMap.get(oldKey) ?? newKey);   // 舊 key 存在才需要搬學習表
      keyChanged++;
      if (!dryRun) t.storeKey = newKey;
    }
  }
  // 學習表 key 一併正規化：storeKey 級的 key 跟著交易 storeKey 的舊→新對照搬（skMap；規則升級後
  // cleanStore 結果可能整個改變，光就地正規化搬不動），對照表沒有的再就地正規化；撞 key 保留先到的。
  // ⚠️ Codex#4：原文級學習的 key＝帳單原文（原始未清理字串，如「全家便利商店-三重新陽店A0145 TAIPEI」），
  // 絕不可被店名正規化改寫——改了會既不等於原文、也不等於真正的 storeKey，未來匯入永遠命中不到那條學習。
  // ⚠️ 這一段**在 dryRun 也要算**（自審 r3，高）：學習表的合併是唯一「還原不回來」的效果——
  // 兩把鑰匙併成一把時，兩邊學過的分類只留得下一個，把規則刪掉也救不回被蓋掉的那個。
  // 以前整段包在 if (!dryRun) 裡，預覽（＝套用前唯一的安全帶）對它完全盲目：使用者看到
  // 「4 筆顯示名會變」就按下去，結果手動教過的分類默默消失。算出來、回報衝突，才叫預覽。
  // 只有「寫入」是 dryRun 要跳過的，計算不是。
  let learnedRemapped = 0, learnedNamesFixed = 0;
  /** @type {{key:string, field:string, kept:string, dropped:string}[]} 併 key 時被蓋掉的學習值 */
  const learnedConflicts = [];
  /** @type {{key:string, before:string, after:string}[]} 學過的自訂店名被改寫／清除（after 空＝清除） */
  const learnedNameChanges = [];
  {
    const origSet = new Set();
    for (const t of db.transactions || []) {
      if (t.source !== 'stmt' || !t.stmtRef) continue;
      const o = origFromStmtRef(t.stmtRef);
      if (o) origSet.add(o);
    }
    const lc = db.learnedCategories || {};
    /** @type {Record<string, any>} */
    const newLc = emptyMap();   // 鍵是帳單文字的 remap 產物（storeKeyOf 輸出），null-proto 杜絕 '__proto__' 換原型（Codex r6#3 掃蕩同型）
    for (const [k, v] of Object.entries(lc)) {
      // 這條學習屬於哪一層？三種情形，只有「證明得了是品牌級」才可以動它（r2-Codex#1）：
      // ①key＝現存交易的帳單原文 → 原文級，原樣保留
      // ②key＝現存交易的 storeKey（新或舊）→ 品牌級，可搬家＋摘 name
      // ③兩者都不是＝孤兒（交易被刪、學習刻意留著給未來匯入，見 AGENTS 說明）→ **原封不動**。
      //   以前這裡會把孤兒當品牌級：key 被 normalizeStoreDisplay 改寫（統一超商-德權 → 統一超商（德權））
      //   且 name 被摘掉——改完既不等於原文也不等於真 storeKey，未來匯入兩邊都命中不到，自訂全失效。
      const isOrigKey = origSet.has(k);
      const isBrandKey = keysSeen.has(k);
      const nk = isBrandKey ? (skMap.get(k) ?? k) : k;
      if (nk !== k) learnedRemapped++;
      // 品牌層 entry 一律不留 name（Codex#3；顯示名改掛原文級，見下）——原文級與孤兒的照舊保留。
      // ⚠️「不留」＝搬家不是刪除（Codex r11#4）：有效自訂名要**確定有著落**（brandNameLanded）才可摘；
      // 該品牌的現存交易一個原文都撈不到（全缺 stmtRef）＝保留，與 learning.js migrateBrandName 同語意——
      // 否則「暫留待搬」的名字會在下一次規則指紋變動觸發自動整理時無聲蒸發、且不計入任何預覽回報
      // （對抗審查實測：dryRun 回「不會改動任何既有記錄」，寫檔後名字卻消失）。殘骸名/空值/非字串照舊清。
      const heldName = (v && typeof v === 'object' && 'name' in v) ? v.name : undefined;
      const nameRemovable = heldName !== undefined
        && (typeof heldName !== 'string' || !heldName || isPlatformArtifactName(heldName) || brandNameLanded.has(k));
      const val = (isBrandKey && !isOrigKey && nameRemovable)
        ? Object.fromEntries(Object.entries(v).filter(([f]) => f !== 'name'))
        : v;
      // ⚠️ Codex#2：撞 key 時原本用 `newLc[nk] || val`——空物件 {} 在 JS 是 truthy，
      // 先到的「被摘掉 name 後剩空殼」會擋掉後到者的分類學習（實測：全家商店 → {}）。
      // 改成欄位層級合併：先到者的欄位優先，缺的欄位由後到者補上。
      const prev = newLc[nk];
      // 真正的衝突＝兩邊「都有值且不一樣」的欄位：先到者留下、後到者被丟掉且救不回來。
      // 收集起來回報給預覽（缺一邊的欄位只是互補，不算衝突、不必打擾使用者）。
      if (prev && val && typeof val === 'object') {
        for (const f of ['category', 'subcategory', 'name']) {
          // ⚠️ 用 `Object.hasOwn` 判「有沒有這個欄位」，不可用 truthy（Codex r3#3）：
          // **空字串子類是合法值**（＝這家店不分子類，使用者拍板、categories.js 有註記），
          // 用 `prev[f] && val[f]` 會把它當成「沒有值」→ 一邊 ''、一邊 '餐廳' 不算衝突，
          // 合併後只留下 ''，「餐廳」永久消失卻沒人警告。
          if (Object.hasOwn(prev, f) && Object.hasOwn(val, f) && prev[f] !== val[f]) {
            learnedConflicts.push({ key: nk, field: f, kept: String(prev[f] ?? ''), dropped: String(val[f] ?? '') });
          }
        }
      }
      // 一律淺拷貝：下面的「學過的顯示名也治一次」會就地改 v.name，不拷貝的話 dryRun 也會
      // 動到剛讀進來的 db 物件（目前不存檔所以無害，但這種地雷不值得留著）。
      newLc[nk] = prev ? { ...val, ...prev } : { ...val };
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
    // ⚠️ 這裡改的是**使用者親手取的店名**，而且改完刪掉規則也還原不回來——
    // 所以不只要計數，還要逐筆記下 before→after 交給預覽（Codex r3#2，高）。
    // 原本只回一個 learnedNamesFixed 數字、而預覽根本沒轉交它：孤兒學習的自訂名被規則改掉時，
    // 預覽會回 changed=0／keyChanged=0／conflicts=[]，UI 於是說「不會改動任何既有記錄」——
    // 使用者放心按下去，取好的名字就沒了。這正是「A 有產出、B 轉手漏欄位、C 看不到」的同類漏洞。
    // 學過的顯示名也用規則治一次，但**只套品牌改寫（normalizeStoreDisplay）、不再 stripDisplayLabels**
    // （使用者定 2026-07-20）：以前 `normalizeStoreDisplay(stripDisplayLabels(v.name))` 會把
    // 「人从众厚切牛排（FP）」的（FP）拆掉→跳出「刪掉規則也救不回」的嚇人確認閘。拿掉 strip 後，
    // 顯示標記逐字保留（normalizeStoreDisplay 不碰它），而品牌改名規則（OLD→NEW）仍會套用並逐筆回報。
    // 平台殘骸名（優食（UE）等舊 bug 產物）另清（使用者定 2026-07-18 全部改回原本的）。
    for (const [k, v] of Object.entries(newLc)) {
      if (!v || typeof v.name !== 'string' || !v.name) continue;
      if (isPlatformArtifactName(v.name)) {        // 平台殘骸名：刪掉才不會在下次匯入又蓋回錯名
        learnedNameChanges.push({ key: k, before: v.name, after: '' });   // after 空＝這個自訂名會被清掉
        delete v.name; learnedNamesFixed++;
        if (!Object.keys(v).length) delete newLc[k];
        continue;
      }
      const nv = normalizeStoreDisplay(v.name, { customName: true });   // 不 stripDisplayLabels、不套加油站改寫（自審A#2）：顯示標記與自訂名逐字，只套品牌改寫規則
      if (nv && nv !== v.name) {
        learnedNameChanges.push({ key: k, before: v.name, after: nv });
        v.name = nv; learnedNamesFixed++;
      }
    }
    // 只有「寫入」跳過 dryRun（上面的計算照跑，預覽才看得到學習表的效果）
    if (!dryRun) {
      db.learnedCategories = newLc;
      // 沒有任何變動就不寫檔：自動整理每次開 app 都可能跑，空跑白寫一次全庫沒有意義
      //（原註解說「會洗掉 .bak」是**錯的**，自審 r3 實測：backupOnce 有 module 級旗標、
      // .bak 每個行程只在啟動時寫一次，saveDb 根本不碰它。真正的理由是寫入成本與不必要地
      // 推進 __dbUpdatedAt——那是舊 JSON 搬家衝突偵測的依據。）
      if (changes.length || keyChanged || learnedRemapped || learnedNamesFixed) {
        await saveDb(db);
      }
    }
  }
  return { changed: changes.length, keyChanged, learnedRemapped, learnedNamesFixed,
    learnedConflicts: learnedConflicts.slice(0, 50), learnedConflictTotal: learnedConflicts.length,
    learnedNameChanges: learnedNameChanges.slice(0, 50), learnedNameChangeTotal: learnedNameChanges.length,
    changes: dryRun ? changes.slice(0, 200) : undefined };
}

/**
 * 同店整批改分類（使用者定 2026-07-19：「改一筆以為修好了」的解藥）——收支列表編輯單筆時，
 * 勾「同時套用到這家店的其他 N 筆」就走這裡：同一把身分鑰匙（品牌層）的帳單交易全部改成同一分類，
 * 並把分類學在品牌層（同品牌各分店本來就該共用分類）。顯示名不動——那是各分店自己的事。
 * @param {string} storeKey @param {string} category @param {string=} subcategory
 */
export async function applyCategoryToStore(storeKey, category, subcategory = '') {
  const db = await getDb();
  const r = applyCategoryToStoreDb(db, storeKey, category, subcategory);
  await saveDb(db);
  return r;
}

/** 「同店一起改」的**純 in-db 工作函式**（護欄 G3，2026-07-22）：**不自己讀寫檔**——供「編輯＋一起改」原子路徑
 * （crud.js PUT applyAll、renameStoreDisplay applyAll）在**同一次寫檔**內連同單筆編輯一起落地，免前端兩次寫、
 * 中途失敗半套用。行為與 applyCategoryToStore 原版一致，僅抽掉 getDb/saveDb。
 * @param {any} db @param {string} storeKey @param {string} category @param {string} [subcategory]
 * @returns {{ok:boolean, changed:number, origCleared:number, category:string, subcategory:string}} */
export function applyCategoryToStoreDb(db, storeKey, category, subcategory = '') {
  const key = String(storeKey || '').trim();
  const cat = String(category || '').trim();
  if (!key) throw apiError(400, '缺少身分鑰匙');
  if (!cat) throw apiError(400, '分類不可為空');
  // 原型名整組拒絕（Codex r5#1）：以前 `lc[key] || {}` 會撈到 Object.prototype **本尊**（truthy）
  // → 在全域原型上寫分類。明確拒絕（不靜默跳過）——這種鑰匙不可能是真店名，出現＝上游有問題要看得見。
  if (isProtoKey(key)) throw apiError(400, `「${key}」是程式保留字，不可能是真的店家鑰匙`);
  // 服務費整組拒絕（r2-Codex#3）：它的分類是 finalize 從「前一筆消費」繼承來的，
  // 同金額的服務費可能屬於不同消費，依 key 批次改會互相污染。原本只擋「不學」、交易照改。
  if (isServiceFee(key)) throw apiError(400, '國外交易服務費的分類由所屬消費決定，不支援整批改');
  const targets = (db.transactions || []).filter(t => t.source === 'stmt' && String(t.storeKey || '') === key);
  // 沒有任何符合的交易就不該落規則（r2-Codex#4）：原本會靜默種下一條「隱形品牌規則」，
  // 未來出現同名 key 時被它劫持，而使用者從沒在任何畫面看過這條。
  if (!targets.length) throw apiError(404, `找不到身分鑰匙「${key}」的帳單記錄`);
  const [c, s] = resolveImportCategory(db, cat, String(subcategory || ''));
  const parkSub = parkingSubName(db);   // 護欄 G4：「停車費」子類現名（整批共用一次解析）
  let changed = 0;
  /** @type {Set<string>} 這個品牌底下的帳單原文（清原文級分類用） */
  const origs = new Set();
  for (const t of targets) {
    const o = origFromStmtRef(t.stmtRef);
    if (o) origs.add(o);
    if (isServiceFee(o) || isServiceFee(String(t.note || ''))) continue;   // 混在同一把鑰匙下的服務費也跳過
    if (t.category === c && (t.subcategory || '') === (s || '')) continue;
    t.category = c; t.subcategory = s; changed++;
    // 顯示名跟著分類走（使用者定 2026-07-19）：這條路以前只改分類不重算 note，「同店一起改」之後
    // 那 N 筆的名字全部停在舊樣子（實測確認）。自動名的停車費包裝（子類＝停車費）要跟著新分類更新；
    // 自訂名則逐字不動（使用者定 2026-07-20，分類變動也不重貼標記）。
    if (!o) continue;
    const custom = customStoreName(db, o, storeKeyOf(o));
    t.note = custom || applyDisplayLabels(cleanStore(o), { desc: o, subcategory: s, parkSub });
  }
  const lc = (db.learnedCategories ||= {});
  const e = getOwn(lc, key) || {};                   // getOwn/setOwn：入口已拒原型名，這裡再上一道保險（Codex r5#1）
  e.category = c; e.subcategory = s;
  migrateBrandName(db, key, e);                      // 品牌層永不留顯示名（Codex#3）——搬家到原文級、不是刪除（Codex r11#4）
  setOwn(lc, key, e);
  // 原文級分類優先於品牌層（applyLearned 的細粒度覆蓋）→ 不清的話，這個品牌底下曾被單獨設過
  // 分類的原文，未來匯入仍會套回舊分類，使用者以為「整店都改好了」其實沒有（r2-Codex#2）。
  // 只清分類、**保留 name**（顯示名是各分店自己的事，與分類無關）。
  let origCleared = 0;
  for (const o of origs) {
    // 原文＝鑰匙（乾淨品牌名）：learned[o] 就是剛寫入的品牌層 entry 本身——清下去等於把剛學的分類
    // 自己刪掉（entry 變空殼被整個移除，「同店整批改分類」完全不落地還回報成功；對抗審查實測，Codex r11）
    if (o === key) continue;
    const oe = getOwn(lc, o);                        // 先確認是自有鍵再讀（裸寫 lc[o] 會先摸到原型）
    if (!oe || !oe.category) continue;
    delete oe.category; delete oe.subcategory; origCleared++;
    if (!Object.keys(oe).length) delete lc[o];
  }
  return { ok: true, changed, origCleared, category: c, subcategory: s };
}

// ---------- 規則更新後自動整理（使用者定 2026-07-19：「忘了按套用」不該再發生）----------
// 病根：店名規則住在程式碼裡，改完要「合併→重啟→**記得手動按整理**」才套到舊資料，缺一步就沒生效。
// 解法比照 1-1 自動快照：開 app 時比對「規則指紋」，跟上次整理時不同就自動跑一次（整理本身冪等、
// 有變動才寫檔、save 內建 .bak），結果回報給前端提示。
// 指紋＝**內建規則（程式碼）＋使用者規則（資料）**：
//  ①lib/statement.js＋lib/store-rules.js 的內容雜湊——規則散在資料表與 cleanStore 的 regex 兩處，
//    雜湊整個檔案才不會漏（誤判只會多跑一次無害的整理）；程式碼部分只讀一次、可快取。
//  ②settings.storeRules 的正規化字串（第三帖）——使用者自己加一條規則，也要跟「Claude 改了程式」
//    一樣觸發整理，否則自助改完舊資料不動，等於沒改（＝第一帖要解的那個病，別在第三帖復發）。
//    這部分**每次重算**（規則隨時會被編輯，快取會過期）。
let codeHashCache = '';
/** @returns {string} */
function rulesHash() {
  if (!codeHashCache) {
    const src = ['../statement.js', '../store-rules.js']
      .map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
    codeHashCache = createHash('sha1').update(src).digest('hex').slice(0, 12);
  }
  return codeHashCache + '-' + createHash('sha1').update(userRulesFingerprint()).digest('hex').slice(0, 8);
}
/**
 * 規則有更新才整理（開 app 時呼叫；同一版規則只跑一次）。
 *
 * **停下來問使用者**的訊號＝`needsConfirmation:true`：整理會蓋掉學過的分類／自訂名，而那些
 * 刪掉規則也救不回來，所以不可以默默套用。⚠️ 這個欄位刻意是**單一個 truthy 旗標**、不是每種
 * 原因各開一個布林：呼叫端只要問「有沒有值」就知道要停下來，連它不認得的原因也會落在「要問」
 * 那一邊；各開欄位的話，呼叫端不認得的那一種會直接掉進「沒事發生」＝該問的那一次被靜靜跳過。
 * 停下來時**不記指紋**＝維持待決，下次開 app 會再問一次。
 *（⚠️ 不要為「操作前備份沒存成」另開一種原因：不可逆操作前的自動備份是本專案刻意不做的，
 *  理由見 `lib/services/backup.js` 的設計註解；`test/vault-and-backup-integrity.test.js`
 *  的〈裁決〉那一題釘著這幾條路不得長出它。）
 *
 * @param {boolean} [force] 略過「不可逆效果」的確認閘門（使用者已在 UI 預覽並確認時才傳 true）
 * @returns {Promise<{ran:boolean, rulesHash:string, needsConfirmation?:boolean, changed?:number,
 *   keyChanged?:number, learnedRemapped?:number, learnedNamesFixed?:number,
 *   learnedConflicts?:any[], learnedConflictTotal?:number, learnedNameChanges?:any[], learnedNameChangeTotal?:number}>}
 */
export async function normalizeIfRulesChanged(force = false) {
  // ⚠️ 順序不可對調：指紋含「使用者規則」，而使用者規則是 getDb()（規則入櫃檯）才餵進單例的——
  // 先算指紋會拿到上一次的規則，剛編輯完的那一版就不會觸發整理。
  const db = await getDb();
  const hash = rulesHash();
  if (db.settings?.storeRulesHash === hash) return { ran: false, rulesHash: hash };
  // ⚠️ 不可逆效果要先問過（Codex r4#2）：整理會**合併學習表**——併鑰匙時兩邊教過的分類只留一個、
  // 學過的自訂名被規則改寫，這些**刪掉規則也救不回來**。開 app 自動跑的情境（Claude 出新規則後
  // 第一次開）若默默套用，使用者的心血會無聲消失。做法呼應每日洞察引擎的「平靜日不造噪音，有事才出聲」：
  // 先 dry-run，**沒有不可逆效果就照常自動套用**（絕大多數規則更新屬此，無感）；
  // 一旦會動到學習表，就**停下來回報 needsConfirmation**、不記指紋（維持待決），等使用者確認。
  const preview = await normalizeBranches(true);
  const conflicts = preview.learnedConflicts || [];
  const nameChanges = preview.learnedNameChanges || [];
  if (!force && (conflicts.length || nameChanges.length)) {
    // 總數也要轉交（r4#5 同款「B 轉手漏欄位」）：明細截 50，前端計數要用 Total
    return { ran: false, needsConfirmation: true, rulesHash: hash,
      changed: preview.changed, keyChanged: preview.keyChanged,
      learnedConflicts: conflicts, learnedConflictTotal: preview.learnedConflictTotal ?? conflicts.length,
      learnedNameChanges: nameChanges, learnedNameChangeTotal: preview.learnedNameChangeTotal ?? nameChanges.length };
  }
  const r = await normalizeBranches(false);
  // 記下這版規則已套用（就算 0 筆變動也要記，否則每次開 app 都重跑）。
  // 這是「服務層擁有」的欄位：save 的櫃檯放行未知欄位、PUT /settings 走合併不會抹掉；
  // 匯入備份時會被白名單剝掉——那是刻意的（還原舊資料後本來就該重跑一次整理）。
  const fresh = await getDb();
  fresh.settings = { ...fresh.settings, storeRulesHash: hash };
  await saveDb(fresh);
  return { ran: true, rulesHash: hash, changed: r.changed, keyChanged: r.keyChanged,
    learnedRemapped: r.learnedRemapped, learnedNamesFixed: r.learnedNamesFixed };
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
 * @param {boolean=} applyAll 「同店一起改」（護欄 G3）：非 reset 且有改分類時，於**同一次寫檔**把分類套到同品牌其他原文，
 *   取代前端「先 rename-store、再 apply-category」兩次寫（中途失敗會半套用）。回傳多一個 `applied` 欄（propagate 計數）。
 */
export async function renameStoreDisplay(orig, name, category, subcategory, reset = false, clearBrand = false, applyAll = false) {
  const db = await getDb();
  const o = String(orig || '').trim();
  if (!o) throw apiError(400, '缺少帳單原文');
  // 原型名明確拒絕（Codex r5#1）：o='__proto__' 時下面的 `lc[o] = e` 不是寫鍵、是**把整張學習表的
  // 原型換掉**（資料靜默消失＋全表繼承到假值）。這種原文不可能是真帳單，出現＝上游有問題要看得見。
  if (isProtoKey(o)) throw apiError(400, `「${o}」是程式保留字，不可能是真的帳單原文`);
  if (isProtoKey(String(name || '').trim())) throw apiError(400, '這個名字是程式保留字，請換一個顯示名');
  // 自動判斷值：分類＝內建分類器再過別名/生效樹校正；顯示名＝cleanStore 再加顯示標記（FP／停車費），
  // 與匯入端、遷移端同口徑——否則「打開編輯窗直接儲存」會把帶標記的現值誤記成自訂名。
  const [autoCat, autoSub] = resolveImportCategory(db, ...categorize(o));
  const autoName = applyDisplayLabels(cleanStore(o), { desc: o, subcategory: autoSub, parkSub: parkingSubName(db) });
  const newName = reset ? autoName : String(name || '').trim();
  if (!newName) throw apiError(400, '顯示名不可為空');
  const hasCat = reset || category !== undefined;
  const newCat = reset ? autoCat : String(category || '');
  const newSub = reset ? autoSub : String(subcategory || '');
  if (hasCat && !reset && !newCat) throw apiError(400, '分類不可為空');
  let changed = 0, matched = 0;
  /** @type {{key: string, sharedCount: number} | null} 還原時保留下來的同品牌共用分類規則（前端據此二次確認） */
  let brandRule = null;
  for (const t of db.transactions || []) {
    if (t.source !== 'stmt' || !t.stmtRef) continue;
    // 用 origFromStmtRef 取原文（會剝掉去重序號 |#N，Codex r10#5）——手動 split 會把「星巴克|#2」
    // 當成原文，導致第二筆同店改名改不到（漏改＋計數少報）。與檔頭同步點註解一致。
    if (origFromStmtRef(t.stmtRef) !== o) continue;
    matched++;
    let touched = false;
    if (t.note !== newName) { t.note = newName; touched = true; }
    if (hasCat && (t.category !== newCat || (t.subcategory || '') !== newSub)) { t.category = newCat; t.subcategory = newSub; touched = true; }
    if (touched) changed++;
  }
  // 沒有任何符合的交易就不該落規則（Codex r11 掃描；同 applyCategoryToStore 的 r2-Codex#4 防線）：
  // 原本 orig 打錯/憑空捏造也回 ok 並靜默種下一條看不見的原文級規則，未來匯入同名原文會被它劫持。
  // matched 而非 changed 判斷——「存在但值全同」的冪等重存是合法操作，不可誤擋。
  if (!matched) throw apiError(404, `找不到帳單原文「${o}」的記錄`);
  if (!isServiceFee(o) && !isServiceFee(newName)) {   // 服務費不學（同 learning.js 檔頭說明）
    const lc = (db.learnedCategories ||= {});
    /** @type {any} */
    const e = {};                                     // 覆寫式：每次編輯重算整個 entry（彈窗呈現的就是完整現狀）
    if (newName !== autoName) e.name = newName;
    if (hasCat && (newCat !== autoCat || newSub !== (autoSub || ''))) { e.category = newCat; e.subcategory = newSub; }
    else if (!hasCat && getOwn(lc, o)?.category) { const p = getOwn(lc, o); e.category = p.category; e.subcategory = p.subcategory || ''; }   // 只改名不動分類→保留既有分類學習
    if (Object.keys(e).length) setOwn(lc, o, e);
    else delete lc[o];                                // 全部同自動＝不需要規則（自我修剪；入口已拒原型名，delete 自有鍵安全）
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
      else if (getOwn(lc, sk)?.category) brandRule = { key: sk, sharedCount: sharedOrigs.size };
    }
  }
  // 「同店一起改」原子化（護欄 G3）：非 reset 且有改分類才傳播——在同一次寫檔內把分類套到同品牌其他原文。
  // 順序＝先本原文（上面）再品牌傳播，與原「rename-store→apply-category」兩次呼叫的結果逐字一致，只是併成一次寫檔。
  /** @type {ReturnType<typeof applyCategoryToStoreDb>|null} */
  let applied = null;
  // 服務費不支援整批改（r2-Codex#3）：略過傳播、本筆改名照常存（同 crud.js PUT applyAll 的 G3 對抗審查修正）
  if (applyAll && !reset && hasCat && newCat && !isServiceFee(o)) applied = applyCategoryToStoreDb(db, storeKeyOf(o), newCat, newSub);
  await saveDb(db);
  return { ok: true, changed, brandRule, applied };
}

/** 學習表檢視。 */
export async function getLearned() { return (await getDb()).learnedCategories || {}; }

/** 刪除一筆學習。 @param {string} key */
export async function deleteLearned(key) {
  const db = await getDb();
  const k = String(key || '');
  // hasOwn 而非 `in`（Codex r5#1 掃出）：`in` 會查原型鏈——k='toString' 時永遠成立，
  // 誤以為刪了東西；只刪「真的存在的自有鍵」。
  if (db.learnedCategories && Object.hasOwn(db.learnedCategories, k)) delete db.learnedCategories[k];
  await saveDb(db);
  return { ok: true };
}

/**
 * 手動修正整批的「帳單年月」（使用者定 2026-07-19）：帳單格式百百種，表頭讀不出期別時
 * （或讀錯時）要能自己指定——不然使用者會卡在一個永遠不對的欄位上。
 * @param {string} batchId @param {string} month YYYY-MM（空字串＝清掉、退回推估值）
 */
export async function setBatchMonth(batchId, month) {
  const db = await getDb();
  const id = String(batchId || '');
  const mm = String(month || '').trim();
  if (!id) throw apiError(400, '缺少批次代號');
  if (mm && !isRealMonth(mm)) throw apiError(400, '帳單年月格式須為 YYYY-MM（例：2026-01）');
  const targets = (db.transactions || []).filter(t => t.importBatch === id);
  if (!targets.length) throw apiError(404, '找不到這個匯入批次');
  for (const t of targets) { if (mm) t.stmtMonth = mm; else delete t.stmtMonth; }
  await saveDb(db);
  return { ok: true, changed: targets.length, stmtMonth: mm };
}
