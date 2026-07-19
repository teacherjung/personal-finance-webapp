// @ts-check
// 帳單匯入路由（B2）：邏輯在 lib/services/statement-import.js，這裡只做 HTTP 轉接與錯誤轉換。
import { Router } from 'express';
import {
  previewAuto, previewForCard, importRows, listBatches, reassignBatch, deleteBatch,
  getLearned, deleteLearned, normalizeBranches, renameStoreDisplay, normalizeIfRulesChanged, applyCategoryToStore, setBatchMonth
} from '../services/statement-import.js';
import { runHealthCheck, dismissHealthItem } from '../services/health-check.js';

export const statementRoutes = Router();

/** 服務層以 throw（帶 status）回報「已知的使用者層錯誤」→ 原味訊息回應（密碼錯/找不到卡片等，使用者要看得懂）。
 * 沒帶 status＝非預期的內部錯誤 → 交給全域錯誤中介（console.error＋500，口徑統一，Codex#10-6）。 */
const wrap = (/** @type {(req:any,res:any)=>any} */ fn) => async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
  try { await fn(req, res); }
  catch (e) {
    const err = /** @type {any} */ (e);
    if (err && err.status) return res.status(err.status).json({ error: String(err.message || err) });
    next(err);
  }
};

// 自動預覽（免選卡）／指定卡片預覽／匯入
statementRoutes.post('/api/statement/preview', wrap(async (req, res) => res.json(await previewAuto(req.body.data))));
statementRoutes.post('/api/cards/:id/statement/preview', wrap(async (req, res) => res.json(await previewForCard(req.params.id, req.body.data))));
statementRoutes.post('/api/cards/:id/statement/import', wrap((req, res) =>
  res.json(importRows(req.params.id, req.body.transactions, req.body.statementMonth, req.body.statementDue))));
// 手動修正整批的帳單年月（表頭讀不出期別／讀錯時的退路）
statementRoutes.post('/api/statement/batch/month', wrap((req, res) =>
  res.json(setBatchMonth(req.body?.batchId, req.body?.month))));

// 匯入批次：清單／整批改卡片／刪除整批
statementRoutes.get('/api/statement/batches', (req, res) => res.json(listBatches()));
statementRoutes.post('/api/statement/reassign', wrap((req, res) => res.json(reassignBatch(req.body.batchId, req.body.toCardId))));
statementRoutes.post('/api/statement/batch/delete', wrap((req, res) => res.json(deleteBatch(req.body.batchId))));

// 帳單分類自動學習：檢視／刪除（設定頁用）
statementRoutes.get('/api/learned', (req, res) => res.json(getLearned()));
statementRoutes.post('/api/learned/delete', (req, res) => res.json(deleteLearned(req.body.key)));

// 店名格式整理（可重複執行）：dryRun 預覽 note 的 before→after；正式套用寫檔（含 storeKey/學習表對齊）
statementRoutes.post('/api/statement/normalize-branches', (req, res) => res.json(normalizeBranches(!!req.body?.dryRun)));
// 帳務體檢（第二帖）：唯讀偵測器＋略過持久化；修正動作走既有的 rename-store / apply-category
statementRoutes.get('/api/statement/health', wrap((req, res) => res.json(runHealthCheck())));
statementRoutes.post('/api/statement/health/dismiss', wrap((req, res) =>
  res.json(dismissHealthItem(req.body?.id, !!req.body?.clearAll))));
// 規則更新後自動整理（開 app 呼叫，同一版規則只跑一次）——「忘了按套用」的解藥，比照 /snapshot/auto
statementRoutes.post('/api/statement/normalize-auto', wrap((req, res) => res.json(normalizeIfRulesChanged())));
// 同店整批改分類（收支列表編輯時勾「同時套用到這家店的其他 N 筆」）
statementRoutes.post('/api/statement/apply-category', wrap((req, res) =>
  res.json(applyCategoryToStore(req.body?.storeKey, req.body?.category, req.body?.subcategory))));

// 帳單說明／分類學習（合併卡）編輯：以「帳單原文」為準改顯示名＋分類（同原文整批改＋記學習，
// 未來匯入沿用；不同分店可各自取名）。reset=true＝整列還原自動判斷並清除學習。
statementRoutes.post('/api/statement/rename-store', wrap((req, res) =>
  res.json(renameStoreDisplay(req.body?.orig, req.body?.name, req.body?.category, req.body?.subcategory, !!req.body?.reset, !!req.body?.clearBrand))));
