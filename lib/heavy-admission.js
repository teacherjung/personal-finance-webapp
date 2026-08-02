// @ts-check
// **重型工作的入場管制**（HOSTED 專用，2026-08-02；Codex #350 r2 High → #371 r1 再擴大範圍）。
//
// ## 為什麼需要
//
// 行程隔離的佇列擋的是「同時有幾顆子行程」，但它拿名額的時機是 **body 已經收完、
// 解碼完之後**——並發請求可以各自先把資料吃進記憶體（實測 6 個排隊多吃 67.5MiB）。
// 真正的守門要在**收 body 之前**（但在 auth／限速之後，不能讓沒登入的人佔名額）。
//
// ## ⚠️ 範圍＝「容器裡的重型工作」，不是「PDF」（#371 r1 兩條 High 的根治）
//
// 第一版只認六條帳單上傳端點，於是：
//   ①`/api/import`（50MB 備份還原）在 PDF 名額占用中照樣通過並解析——實測 200 完成。
//     本層預算約 490MB、只剩 22MB，一個並行的大還原就越過 Render 512MB。
//   ②IB 同步解析 12MB XML 峰值 ~254MB，與 PDF 併發同樣爆掉。
// ⇒ 名額改成**全站共用**，涵蓋所有會吃大 body 或做重解析的端點（見 HEAVY_ROUTES）。
//
// ## ⚠️ 路徑比對交給 Express（#371 r1 High①）
//
// 第一版自己用 regex 比對 `req.path`，**大小寫敏感**；而 Express 預設路由大小寫不敏感——
// 實測 `/API/STATEMENT/PREVIEW` 完全繞過管制、照樣讀進 200,000 bytes。
// 現在改成 `app.post(route, heavyAdmission)` **逐條掛載**：比對由 Express 自己做，
// 不再有第二套路由語意（大小寫、尾斜線、`:id` 參數全部自動一致）。
//
// ## 上限為什麼是 1
//
// Render 容器 512MB。最貴的一份：body（15MB 上限，base64 加解碼期間約 26MB）
// ＋子行程峰值 316MB ＋ app 底噪 148MB ≈ **490MB**。第二份同時進來就撐爆。
// 要調高＝先換更大的容器，不是改常數。
//
// ## 失敗模式（這一層最容易搞砸的地方）
//
// 名額**只進不出**＝重型功能整個死掉，而且是慢性的、沒有錯誤訊息。
// 所以：①釋放是 idempotent ②`finish` 與 `close` 都掛（客戶端中斷只有 close）
// ③有洩漏考題連打驗證歸零（malformed JSON／req.destroy／res.destroy／逾時都驗過）。
import { STATEMENT_FILE_POST_ROUTES, STATEMENT_ROWS_POST_ROUTES } from './http-body.js';
import { isHosted } from './hosted.js';

/** 同時允許幾件重型工作在進行中（含收 body）。推導見檔頭；改這個數字前先讀。 */
export const HEAVY_ADMISSION_MAX_INFLIGHT = 1;

/** 受管制的重型端點（**全部是 POST**）。新增大 body／重解析端點時加進來。
 *  ⚠️ 判準＝「這條路會不會吃大 body 或做重解析」，不是「它叫什麼名字」。 */
export const HEAVY_ROUTES = [
  ...STATEMENT_FILE_POST_ROUTES,   // 六條帳單／證券檔案上傳（15MB）
  ...STATEMENT_ROWS_POST_ROUTES,   // 信用卡帳單匯入（已解析的列）
  '/api/import',                   // 備份還原（50MB，#371 r1 High② 實測可繞過）
  '/api/ib/sync',                  // IB Flex：抓 12MB XML 解析，峰值約 254MB
];

let inFlight = 0;
/** 測試用：目前佔用的名額數。 */
export function heavyAdmissionInFlightForTest() { return inFlight; }
/** 測試用：重置（考題之間不互相污染）。 */
export function resetHeavyAdmissionForTest() { inFlight = 0; }

export function heavyAdmission(req, res, next) {
  // LOCAL 零改動契約：只有自己在用、不對外，不必付這個代價（同 pdf-isolate 的分流判準）
  // ⚠️ 路徑比對**不在這裡**——由 Express 的 app.post(route, …) 負責（見檔頭）。
  if (!isHosted()) return next();

  if (inFlight >= HEAVY_ADMISSION_MAX_INFLIGHT) {
    // fail-fast：**還沒開始讀 body 就回絕**，這正是這一層存在的理由
    // Codex #371 r1：文案要誠實——第一份可能還在「上傳」而不是「解析」（request timeout 最長 270s）
    res.set('Retry-After', '10');
    res.status(503).json({ error: '另一份檔案正在上傳或解析中，請稍後再試。' });
    return;
  }

  inFlight += 1;
  let released = false;
  const release = () => { if (released) return; released = true; inFlight -= 1; };
  // ⚠️ 兩個事件都要掛：正常回應是 finish→close；**客戶端中途斷線只有 close**。
  //    release 做成 idempotent，重複觸發只減一次。
  res.on('finish', release);
  res.on('close', release);
  next();
}

/**
 * 把入場管制掛到所有重型端點上。**呼叫位置是安全不變量**：必須在 `authGate`／限速之後、
 * `installJsonBodyParsers(app)` **之前**（Express 依掛載順序執行，掛在 parser 之後＝整層白做）。
 * @param {import('express').Application} app
 */
export function installHeavyAdmission(app) {
  for (const route of HEAVY_ROUTES) app.post(route, heavyAdmission);
}
