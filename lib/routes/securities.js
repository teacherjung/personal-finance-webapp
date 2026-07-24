// @ts-check
// 證券交易 API（S2，藍圖 §五/§八）。薄殼：業務邏輯全在 lib/services/securities-import.js 與 ib-sync 雙寫。
// securityTrades 是 READONLY 集合：前端只有 GET；寫入只經台新匯入與 IB 同步兩條服務路。
// 隱私：回應不含帳號原文（落庫的本來就只有指紋＋遮罩 label）；密碼參數不回聲、不入 log。
import { Router } from 'express';
import { getDb } from '../repo.js';
import { previewTaishinPdf, importTaishinPdf, listSecuritiesBatches, deleteSecuritiesBatch } from '../services/securities-import.js';
import { projectSecurityTrade } from '../secret-fields.js';
import { sendRouteError as fail } from './route-helpers.js';   // 錯誤口徑歸戶（系統優化 U2）；語意同原本地 fail

export const securitiesRoutes = Router();

// 查詢：全部成交（依成交日新→舊、同日依 sourceRef 穩定次序）。v1 篩選在前端做（S3），比照收支列表慣例。
securitiesRoutes.get('/api/securities', (req, res) => {
  const rows = [...(getDb().securityTrades || [])]
    .sort((a, b) => String(b.tradeDate).localeCompare(String(a.tradeDate)) || String(a.sourceRef).localeCompare(String(b.sourceRef)));
  res.json({ trades: rows.map(projectSecurityTrade) });   // 指紋/去重鍵不送瀏覽器（Codex S2r1#6；排序仍用 sourceRef 當穩定次鍵）
});

securitiesRoutes.get('/api/securities/batches', (req, res) => res.json({ batches: listSecuritiesBatches(getDb()) }));

securitiesRoutes.post('/api/securities/preview', async (req, res, next) => {
  try { res.json(await previewTaishinPdf(req.body?.file, req.body?.password)); }
  catch (e) { fail(res, next, e); }
});

securitiesRoutes.post('/api/securities/import', async (req, res, next) => {
  try { res.json(await importTaishinPdf(req.body?.file, req.body?.password)); }
  catch (e) { fail(res, next, e); }
});

securitiesRoutes.post('/api/securities/batch/delete', (req, res, next) => {
  try { res.json(deleteSecuritiesBatch(req.body?.batchId)); }
  catch (e) { fail(res, next, e); }
});
