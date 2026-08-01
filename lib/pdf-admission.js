// @ts-check
// **檔案上傳的 HTTP 入場管制**（HOSTED 專用，2026-08-02；Codex #350 r2 High，William 裁決另開 PR）。
//
// ## 為什麼行程隔離＋子行程佇列還不夠
//
// `lib/pdf-isolate.js` 的佇列擋的是「同時有幾顆子行程」，但它拿名額的時機是
// **body 已經收完、base64 也解碼完之後**。所以並發請求可以各自先把資料吃進記憶體：
// 實測 6 個請求排隊時，光解碼後的資料就多吃 67.5MiB，而第 7 個雖然回 503，
// 它也已經通過 15MB 的 JSON parser 了。
//
// ⇒ 真正的守門要在**收 body 之前**（但在 auth／限速之後——不能讓沒登入的人也佔名額）。
//
// ## 為什麼上限是 1
//
// Render 容器 512MB。一份檔案的完整成本：body（15MB 上限，base64 加解碼期間約 26MB）
// ＋子行程峰值 316MB ＋ app 底噪 148MB ≈ **490MB**。**第二份同時進來就撐爆**。
// 要調高這個數字＝要先換更大的容器，不是改個常數就好。
//
// ## 失敗模式（這一層最容易搞砸的地方）
//
// 名額**只進不出**＝上傳功能整個死掉，而且是慢性的（第一次請求之後就再也進不來）。
// 所以：①釋放是 idempotent（重複呼叫只減一次）②`finish` 與 `close` 都掛
//（客戶端中斷只會有 `close`）③有洩漏考題連打驗證歸零。
import { STATEMENT_FILE_POST_ROUTES } from './http-body.js';
import { isHosted } from './hosted.js';

/** 同時允許幾份檔案上傳在處理中（含收 body）。推導見檔頭；改這個數字前先讀。 */
export const PDF_ADMISSION_MAX_INFLIGHT = 1;

let inFlight = 0;
/** 測試用：目前佔用的名額數。 */
export function pdfAdmissionInFlightForTest() { return inFlight; }
/** 測試用：重置（考題之間不互相污染）。 */
export function resetPdfAdmissionForTest() { inFlight = 0; }

// Express 路徑樣板（含 `:id`）→ 比對用的 regex。**路徑清單沿用 http-body.js 的單一真相**：
// 新增檔案上傳端點時只改那一份，這裡自動跟上（漏改＝新端點不受管制，那正是要防的事）。
const PATTERNS = STATEMENT_FILE_POST_ROUTES.map(
  (p) => new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+')}/?$`));

/** 這條路徑是不是「會收檔案本體」的上傳端點。 @param {string} pathname */
export function isFileUploadPath(pathname) {
  return PATTERNS.some((re) => re.test(pathname));
}

/**
 * 入場管制中介層。**掛載位置是安全不變量**：必須在 `authGate`／限速**之後**、
 * body parser **之前**（見 server.js 的順序註解）。
 * @param {any} req @param {any} res @param {any} next
 */
export function pdfAdmission(req, res, next) {
  // LOCAL 零改動契約：只有自己在用、不對外，不必付這個代價（同 pdf-isolate 的分流判準）
  if (!isHosted()) return next();
  if (req.method !== 'POST' || !isFileUploadPath(req.path)) return next();

  if (inFlight >= PDF_ADMISSION_MAX_INFLIGHT) {
    // fail-fast：**還沒開始讀 body 就回絕**，這正是這一層存在的理由
    res.status(503).json({ error: '目前有另一份檔案正在解析，請稍候幾秒再上傳。' });
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
