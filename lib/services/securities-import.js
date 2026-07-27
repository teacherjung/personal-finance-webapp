// @ts-check
// 台新證券對帳單匯入服務（S2，藍圖 §五/§七/§八）。
// 分層同 bank-import 前例：**純邏輯**（buildSecuritiesPreview / applySecuritiesImport，吃解析結果、可直測）
// 與 **b64 薄殼**（previewTaishinPdf / importTaishinPdf，解密＋解析＋getDb/saveDb）分開。
//
// fail-closed（藍圖 §七）：預覽就把「不能匯」的原因列清楚，**任何 blocker 存在時 import 一律 400**——
// 未知交易類別不猜方向、彙總核對不符不偷改數字、缺帳戶識別不入庫（空指紋會跨帳戶互撞去重）。
// 冪等：sourceRef（含同批出現序）＝唯一去重鍵；重匯同一份 PDF＝0 新增；upsert 永不刪。
// 隱私：PDF 密碼只在記憶體傳給 pdfjs；帳號原文只到正規化為止，**落庫的只有指紋＋遮罩 label**。
import { getDb, saveDb, uid } from '../repo.js';
import { parseTaishinSecuritiesPdf } from '../taishin-securities.js';
import { normalizeTaishinTrade, reconcileFingerprintRows } from './security-trades.js';
import { CURRENCIES } from '../schema.js';

const AMOUNT_CAP = 1e8;   // 單筆合理上限（同 statement-import：超過多為解析誤抓參考號碼）

/** 遮罩顯示名：只取數字末 4 碼（絕不含帳號原文）。 @param {string} accountRaw */
export function taishinAccountLabel(accountRaw) {
  const digits = String(accountRaw || '').replace(/\D/g, '');
  return digits ? `台新證券 …${digits.slice(-4)}` : '台新證券';
}

/**
 * 解析結果 → 正規化列＋blockers（純函式）。
 * @param {any} db
 * @param {{stmtMonth:string|null, accountRaw:string, trades:any[], groups:any[]}} parsed
 */
export function buildSecuritiesPreview(db, parsed) {
  const stmtMonth = String(parsed?.stmtMonth || '');
  const accountLabel = taishinAccountLabel(parsed?.accountRaw || '');
  const ctx = { accountRaw: String(parsed?.accountRaw || ''), accountLabel, stmtMonth };
  /** @type {string[]} */
  const blockers = [];

  const rawList = Array.isArray(parsed?.trades) ? parsed.trades : [];
  const normalized = rawList.map(t => normalizeTaishinTrade(t, ctx));
  const dropped = normalized.filter(t => t == null).length;
  if (dropped) blockers.push(`有 ${dropped} 筆缺成交日/代號/數量，無法辨識（請回報帳單版面）`);
  /** @type {NonNullable<ReturnType<typeof normalizeTaishinTrade>>[]} */
  const rows = /** @type {any} */ (normalized.filter(t => t != null));

  const unknown = rows.filter(t => t.flags.unknownType);
  if (unknown.length) {
    const names = [...new Set(unknown.map(t => t.rawType || '（空白）'))].slice(0, 5).join('、');
    blockers.push(`有 ${unknown.length} 筆交易類別無法判定買賣方向（${names}）——不猜方向，請回報這些類別`);
  }
  if (rows.some(t => t.flags.missingAccount)) blockers.push('讀不到帳戶識別資訊，無法安全去重（請回報帳單版面）');
  const over = rows.filter(t => [t.grossAmount, t.netSettlement].some(v => v != null && Math.abs(v) > AMOUNT_CAP));
  if (over.length) blockers.push(`有 ${over.length} 筆金額超過合理解析上限（可能誤抓參考號碼）`);
  // 核心金額必須是有限數字（藍圖 §七；自審 #6：缺價/缺成交金額/缺應收付的列若放行＝查帳頁出現缺錢的交易）
  const noCore = rows.filter(t => [t.price, t.grossAmount, t.netSettlement].some(v => v == null || !Number.isFinite(v)));
  if (noCore.length) blockers.push(`有 ${noCore.length} 筆缺成交價/成交金額/應收付金額（核心金額讀不到），無法安全匯入`);
  const badCur = rows.filter(t => !CURRENCIES.includes(String(t.currency || '').toUpperCase()));
  if (badCur.length) blockers.push(`有 ${badCur.length} 筆幣別不在系統支援範圍（${[...new Set(badCur.map(t => t.currency))].join('、')}）——放行會在寫入櫃檯被拒、毒死整批`);
  const badGroups = (Array.isArray(parsed?.groups) ? parsed.groups : []).filter(g => g && g.sumMatches === false);
  if (badGroups.length) blockers.push(`有 ${badGroups.length} 組交割彙總的金額無法核對（明細加總 ≠ 帳單合計）——不修改來源數字，請回報`);

  // 去重＝**內容比對＋計數對帳**（S2 自審三 HIGH 根治：批內序跨批不穩——補印插入會漏記、視窗位移會覆寫）；
  // 摘要金額**分幣別**、絕不跨幣別相加（藍圖 §二）
  const plan = reconcileFingerprintRows(db.securityTrades || [], rows);
  /** @type {Record<string, {buy:number, sell:number, fees:number, buyCount:number, sellCount:number}>} */
  const byCurrency = Object.create(null);
  let dup = 0;
  const items = rows.map((t, i) => {
    const duplicate = plan.duplicate[i];
    if (duplicate) dup++;
    const cur = t.currency || 'TWD';
    const agg = byCurrency[cur] || (byCurrency[cur] = { buy: 0, sell: 0, fees: 0, buyCount: 0, sellCount: 0 });
    if (t.side === 'buy') { agg.buy += t.netSettlement || 0; agg.buyCount++; }
    else if (t.side === 'sell') { agg.sell += t.netSettlement || 0; agg.sellCount++; }
    agg.fees += (t.commission || 0) + (t.tax || 0) + (t.otherFees || 0);
    return { ...t, duplicate, insertRef: plan.insertRefs[i] };
  });
  return { stmtMonth, accountLabel, blockers, rows: items, byCurrency, counts: { total: items.length, duplicate: dup, importable: items.length - dup } };
}

/**
 * 確認匯入（純函式；blockers 存在＝400，重建自伺服器端解析、不信前端列）。
 * @param {any} db @param {{stmtMonth:string|null, accountRaw:string, trades:any[], groups:any[]}} parsed
 */
export function applySecuritiesImport(db, parsed) {
  const preview = buildSecuritiesPreview(db, parsed);
  if (preview.blockers.length) {
    throw Object.assign(new Error(`這份對帳單有無法安全匯入的問題：${preview.blockers.join('；')}`), { status: 400 });
  }
  db.securityTrades = db.securityTrades || [];
  const importedAt = new Date().toISOString();
  const batchId = `ts-${preview.stmtMonth}-${uid()}`;
  let imported = 0, skippedDup = 0;
  for (const t of preview.rows) {
    if (t.duplicate || !t.insertRef) { skippedDup++; continue; }
    const { flags, duplicate, insertRef, ...fields } = /** @type {any} */ (t);
    void flags; void duplicate;   // 明確丟棄（lint no-unused-vars）
    /** @type {any} */
    const row = { id: uid(), importBatch: batchId, importedAt };
    for (const [k, v] of Object.entries(fields)) if (v != null) row[k] = v;   // null 不落庫（schema 不收）
    row.sourceRef = insertRef;   // 序號＝庫內既有最大＋1（reconcile 配發；永不與既有列相撞）
    db.securityTrades.push(row);
    imported++;
  }
  return { ok: true, imported, skippedDup, batchId, stmtMonth: preview.stmtMonth, accountLabel: preview.accountLabel };
}

/** 匯入紀錄（藍圖 §八）：依 importBatch 聚合。null-proto＋hasOwn——batch id 雖是我們產的，仍守 AGENTS 3.5。 @param {any} db */
export function listSecuritiesBatches(db) {
  /** @type {Record<string, any>} */
  const groups = Object.create(null);
  for (const r of db.securityTrades || []) {
    const key = String(r.importBatch || '（無批次）');
    const g = groups[key] || (groups[key] = { batchId: key, source: r.source || '', account: r.sourceAccountLabel || '',
      count: 0, buyCount: 0, sellCount: 0, minDate: r.tradeDate, maxDate: r.tradeDate, importedAt: r.importedAt || '', currency: r.currency || '' });
    g.count++;
    if (r.side === 'buy') g.buyCount++; else if (r.side === 'sell') g.sellCount++;
    if (String(r.tradeDate) < String(g.minDate)) g.minDate = r.tradeDate;
    if (String(r.tradeDate) > String(g.maxDate)) g.maxDate = r.tradeDate;
  }
  return Object.values(groups).sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
}

/**
 * 整批刪除（藍圖 §八）：**只准台新批次**——同時比對 batchId 與 source==='taishin'，
 * IB 同步批次不可整批刪（誤刪長期歷史；要修就重同步同期間覆寫）。
 * @param {string} batchId
 */
export async function deleteSecuritiesBatch(batchId) {
  const id = String(batchId || '');
  if (!id) throw Object.assign(new Error('缺少批次編號'), { status: 400 });
  const db = await getDb();
  const rows = (db.securityTrades || []).filter((/** @type {any} */ r) => String(r.importBatch || '') === id);
  if (!rows.length) throw Object.assign(new Error('找不到這個匯入批次'), { status: 404 });
  if (rows.some((/** @type {any} */ r) => r.source !== 'taishin')) {
    throw Object.assign(new Error('IBKR 同步批次不可整批刪除（避免誤刪長期歷史）；資料有誤請重新同步同一期間覆寫。'), { status: 400 });
  }
  db.securityTrades = (db.securityTrades || []).filter((/** @type {any} */ r) => String(r.importBatch || '') !== id);
  await saveDb(db);
  return { ok: true, deleted: rows.length, batchId: id };
}

/** b64 → 解析（密碼優先用本次輸入、否則用已存的 settings.taishinSecPdfPassword）。 @param {string} b64 @param {string=} password */
async function parseB64(b64, password) {
  const data = Uint8Array.from(Buffer.from(String(b64 || ''), 'base64'));
  if (!data.length) throw Object.assign(new Error('沒有收到檔案內容'), { status: 400 });
  const db = await getDb();
  const pw = String(password || '') || String(db.settings?.taishinSecPdfPassword || '');
  return await parseTaishinSecuritiesPdf(data, pw || undefined);
}

/**
 * 預覽回應的機密投影（同 GET /api/securities 的口徑，Codex S2r1#6）：帳戶指紋 sourceAccountId、
 * 去重鍵 sourceRef／insertRef 不送瀏覽器——前端預覽只需要顯示欄位＋duplicate 標記。
 * 只投影**回應**：applySecuritiesImport 走的是未投影的 buildSecuritiesPreview（寫入要靠 insertRef）。
 * @param {ReturnType<typeof buildSecuritiesPreview>} p
 */
export function projectSecuritiesPreview(p) {
  return {
    ...p,
    rows: (p.rows || []).map((/** @type {any} */ r) => {
      const { sourceAccountId, sourceRef, insertRef, ...rest } = r;
      void sourceAccountId; void sourceRef; void insertRef;
      return rest;
    }),
  };
}

/** 上傳預覽（b64 薄殼；回應經機密投影）。 @param {string} b64 @param {string=} password */
export async function previewTaishinPdf(b64, password) {
  const parsed = await parseB64(b64, password);
  return projectSecuritiesPreview(buildSecuritiesPreview(await getDb(), parsed));
}

/** 確認匯入（b64 薄殼；**伺服器端重新解析**、不信前端傳回的列）。 @param {string} b64 @param {string=} password */
export async function importTaishinPdf(b64, password) {
  const parsed = await parseB64(b64, password);
  const db = await getDb();   // PDF 解析（外部 IO）完成後才讀整包；讀→apply→寫之間無外部 IO await
  const result = applySecuritiesImport(db, parsed);
  await saveDb(db);
  return result;
}
