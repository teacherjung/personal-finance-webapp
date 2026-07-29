// @ts-check
// JSON 請求大小的單一真相：一般 API 保持精簡，帳單與完整備份另開較大的入口。
import express from 'express';

export const STANDARD_JSON_LIMIT = '1mb';
export const STATEMENT_JSON_LIMIT = '15mb';
export const BACKUP_JSON_LIMIT = '50mb';
/** 登入／設密碼的 body 只有信箱與密碼。**這是 HOSTED 身分牆「之前」唯一准許解析的 body**，
 * 所以刻意訂得很小——牆前的每一個位元組都是未驗證流量（見 server.js 的掛載順序註解）。 */
export const AUTH_JSON_LIMIT = '32kb';

// 這些端點會接收 base64 的 PDF／XLSX——**檔案本體**，所以需要大的入口。
// 判準：看它從 `req.body` 讀什麼（`data`／`file` ＝檔案本體）。
export const STATEMENT_FILE_POST_ROUTES = [
  '/api/statement/preview',            // req.body.data
  '/api/cards/:id/statement/preview',  // req.body.data
  '/api/bank-statement/preview',       // req.body.data
  '/api/bank-statement/apply',         // req.body.data ← 名字叫 apply，但收的是檔案本體
  '/api/securities/preview',           // req.body?.file
  '/api/securities/import',            // req.body?.file ← 名字叫 import，但收的是檔案本體
];

// 這一條端點只接收「**預覽已經解析好的列**」——身上一個位元組的檔案都沒有，
// 卻長年跟上面共用 15MB 入口。
//
// ⚠️ 為什麼單獨降下來（Codex 收官審查 #10 引出的實測）：它吃的是 JSON 陣列，
//    而那些列寫進 kv 時會**放大約 3 倍**——實測一個 15MB 的請求塞得下 261 列、落庫 44.9MB。
//    同樣要打滿 Supabase Free 的 500MB，從「12 次請求」變成「約 170 次」。
//    真實帳單一次幾百列、幾十 KB，1MB **有約 30 倍的誤殺餘裕**。
//
// ⚠️⚠️ **這張清單只准放「真的只吃已解析列」的端點**（2026-07-29 修，自審抓到的 blocking 回歸）。
//    第一版我按**端點名字**分類，把 `/api/bank-statement/apply` 與 `/api/securities/import`
//    也放了進來——**兩個都錯**：它們讀的是 `req.body.data` 與 `req.body?.file`，
//    也就是 **base64 的 PDF 本體**，跟自己的 preview 端點一模一樣
//    （`lib/routes/statement.js:23`、`lib/routes/securities.js:33`）。
//    降到 1MB 的後果是**連 LOCAL 的銀行／證券對帳單匯入都會在「按確認」那一步被 413 打斷**——
//    破了「LOCAL 零改動」鐵則。
//    **新增端點時判準是「它從 req.body 讀什麼」，不是端點名字裡有沒有 import／apply。**
export const STATEMENT_ROWS_POST_ROUTES = [
  '/api/cards/:id/statement/import',   // ← 讀 req.body.transactions（唯一真的只吃列的）
];

/** 上傳解析類端點的**全集**（`server.js` 的 RATE_LIMITS 直接吃這個，兩類都要限速）。
 *  ⚠️ 新增端點時**兩張清單都要想一次**：它吃檔案，還是吃已經解析好的列？ */
export const STATEMENT_JSON_POST_ROUTES = [...STATEMENT_FILE_POST_ROUTES, ...STATEMENT_ROWS_POST_ROUTES];

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

  const fileParser = express.json({ limit: STATEMENT_JSON_LIMIT });
  for (const route of STATEMENT_FILE_POST_ROUTES) app.post(route, fileParser);

  // 只吃「已解析的列」的那三條走一般 1MB——不必特別登記，落到下面的通用 parser 即可。
  // 但**刻意明寫出來**：不寫的話，下一個人看到 STATEMENT_ROWS_POST_ROUTES 沒被用到，
  // 很可能「順手」把它併回 fileParser，那就等於默默把 15MB 加回去。
  const rowsParser = express.json({ limit: STANDARD_JSON_LIMIT });
  for (const route of STATEMENT_ROWS_POST_ROUTES) app.post(route, rowsParser);

  app.use(express.json({ limit: STANDARD_JSON_LIMIT }));
}
