// @ts-check
// JSON 請求大小的單一真相：一般 API 保持精簡，帳單與完整備份另開較大的入口。
import express from 'express';

export const STANDARD_JSON_LIMIT = '1mb';
export const STATEMENT_JSON_LIMIT = '15mb';
export const BACKUP_JSON_LIMIT = '50mb';
/** 登入／設密碼的 body 只有信箱與密碼。**這是 HOSTED 身分牆「之前」唯一准許解析的 body**，
 * 所以刻意訂得很小——牆前的每一個位元組都是未驗證流量（見 server.js 的掛載順序註解）。 */
export const AUTH_JSON_LIMIT = '32kb';

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
 * 依用途安裝 JSON parser。**本函式內部的順序不可更動**：大件入口要先登記，最後才掛一般 1 MB 規則。
 * Express 看到 req.body 已解析後，後面的通用 parser 會略過，不會再套一次 1 MB。
 *
 * ⚠️ **呼叫它的位置也是安全不變量**（2026-07-28 修）：HOSTED 模式一定要在 `authGate` **之後**才呼叫。
 * 以前掛在最前面，等於「不管誰寄來的包裹都先全部拆開，拆完才到櫃台問這個人能不能進來」——
 * 實測 10 個**未登入**請求 × 45MB 就能把行程 OOM 打死（模擬 Render 512MB 容器）。
 * LOCAL 沒有牆也不對外（只聽 127.0.0.1），位置維持原樣。
 * @param {import('express').Application} app
 */
export function installJsonBodyParsers(app) {
  app.post('/api/import', express.json({ limit: BACKUP_JSON_LIMIT }));

  const statementParser = express.json({ limit: STATEMENT_JSON_LIMIT });
  for (const route of STATEMENT_JSON_POST_ROUTES) app.post(route, statementParser);

  app.use(express.json({ limit: STANDARD_JSON_LIMIT }));
}
