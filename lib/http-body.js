// @ts-check
// JSON 請求大小的單一真相：一般 API 保持精簡，帳單與完整備份另開較大的入口。
import express from 'express';
import { isHosted } from './hosted.js';

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
//    真實帳單一次幾百列、幾十 KB，1MB **有約 30 倍的誤殺餘裕**。
//
// ⚠️⚠️ **這道牆的宣稱範圍要講清楚：它只收窄「這一個端點的濫用效率」，不是租戶容量防線。**
//    （2026-07-29，Codex 定向複審第七輪指出原本的措辭寫得比實際大。）
//    因為 `/api/import` 仍然是 **50MB 的救援入口**（AGENTS.md 明定：備份還原不可以被掐死），
//    而還原就是「整包合併後直接落庫」。Codex 實測：一個 2.3MB 的合法備份請求 → 落庫 8,000 筆／
//    約 2.48MB，**完全不經過這道牆**。所以「不能把共享容量吃光」這件事，這一行做不到。
//
//    真正的租戶容量防線要做在 **HOSTED 的寫入櫃檯**（寫入後的 KV bytes 配額，超限仍允許刪除與
//    不增加容量的寫入），那牽涉「配額多少／既有大帳戶怎麼辦／救援匯入豁不豁免」——
//    **是 William 的裁決，不在本 PR 範圍**（2026-07-29 已呈報）。在那之前這裡只宣稱：
//    帳單列匯入不再是「12 次請求打滿 500MB」的那條捷徑。
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

  // ⚠️ **只在 HOSTED 收緊**（2026-07-29，Codex 定向複審抓到、William 裁決）。
  //    這一條降到 1MB 的理由是「那些列寫進 kv 會放大約 3 倍、吃掉 Supabase 的容量」——
  //    **那本來就是雲端才有的問題**。v2 對兩種模式都套，於是 LOCAL 的
  //    `/api/cards/:id/statement/import` 從「可以超過 1MB」變成 413，
  //    直接違反「LOCAL byte-for-byte 等價」的鐵則。
  //
  //    📌 **判準（值得記住）：這道牆保護的是誰的資源？**
  //       保護 Supabase 的容量／帳單 → **只套 HOSTED**
  //       保護解析器的記憶體（PDF／XLSX／IB XML 那幾道）→ **兩種模式都套**
  //       （理由是「畸形檔案在本機一樣會遇到」，見 lib/parse-limits.js 檔頭）
  //    v2 把這兩類混為一談，才會誤傷 LOCAL。
  const rowsParser = express.json({ limit: isHosted() ? STANDARD_JSON_LIMIT : STATEMENT_JSON_LIMIT });
  for (const route of STATEMENT_ROWS_POST_ROUTES) app.post(route, rowsParser);

  app.use(express.json({ limit: STANDARD_JSON_LIMIT }));
}
