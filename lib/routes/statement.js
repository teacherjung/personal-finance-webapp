// @ts-check
// 帳單匯入路由（B2）：邏輯在 lib/services/statement-import.js，這裡只做 HTTP 轉接與錯誤轉換。
import { Router } from 'express';
import {
  previewAuto, previewForCard, importRows, listBatches, reassignBatch, deleteBatch,
  getLearned, deleteLearned
} from '../services/statement-import.js';

export const statementRoutes = Router();

/** 服務層以 throw（帶 status）回報錯誤 → 轉成 HTTP 回應。 */
const wrap = (/** @type {(req:any,res:any)=>any} */ fn) => async (/** @type {any} */ req, /** @type {any} */ res) => {
  try { await fn(req, res); }
  catch (e) {
    const err = /** @type {any} */ (e);
    res.status(err.status || 400).json({ error: String(err.message || err) });
  }
};

// 自動預覽（免選卡）／指定卡片預覽／匯入
statementRoutes.post('/api/statement/preview', wrap(async (req, res) => res.json(await previewAuto(req.body.data))));
statementRoutes.post('/api/cards/:id/statement/preview', wrap(async (req, res) => res.json(await previewForCard(req.params.id, req.body.data))));
statementRoutes.post('/api/cards/:id/statement/import', wrap((req, res) => res.json(importRows(req.params.id, req.body.transactions))));

// 匯入批次：清單／整批改卡片／刪除整批
statementRoutes.get('/api/statement/batches', (req, res) => res.json(listBatches()));
statementRoutes.post('/api/statement/reassign', wrap((req, res) => res.json(reassignBatch(req.body.batchId, req.body.toCardId))));
statementRoutes.post('/api/statement/batch/delete', wrap((req, res) => res.json(deleteBatch(req.body.batchId))));

// 帳單分類自動學習：檢視／刪除（設定頁用）
statementRoutes.get('/api/learned', (req, res) => res.json(getLearned()));
statementRoutes.post('/api/learned/delete', (req, res) => res.json(deleteLearned(req.body.key)));
