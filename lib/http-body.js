// @ts-check
// JSON 請求大小的單一真相：一般 API 保持精簡，帳單與完整備份另開較大的入口。
import express from 'express';

export const STANDARD_JSON_LIMIT = '1mb';
export const STATEMENT_JSON_LIMIT = '15mb';
export const BACKUP_JSON_LIMIT = '50mb';

// 這些端點會接收 base64 PDF/XLSX，或接收由預覽產生的整批帳單列。
export const STATEMENT_JSON_POST_ROUTES = [
  '/api/statement/preview',
  '/api/cards/:id/statement/preview',
  '/api/cards/:id/statement/import',
  '/api/bank-statement/preview',
  '/api/bank-statement/apply',
  '/api/securities/preview',
  '/api/securities/import',
];

/**
 * 依用途安裝 JSON parser。順序不可更動：大件入口要先解析，最後才掛一般 1 MB 規則。
 * Express 看到 req.body 已解析後，後面的通用 parser 會略過，不會再套一次 1 MB。
 * @param {import('express').Application} app
 */
export function installJsonBodyParsers(app) {
  app.post('/api/import', express.json({ limit: BACKUP_JSON_LIMIT }));

  const statementParser = express.json({ limit: STATEMENT_JSON_LIMIT });
  for (const route of STATEMENT_JSON_POST_ROUTES) app.post(route, statementParser);

  app.use(express.json({ limit: STANDARD_JSON_LIMIT }));
}
