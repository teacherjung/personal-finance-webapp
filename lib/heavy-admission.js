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
// ⚠️ **SEC 官方基本面刻意不掛在 HTTP 層**（2026-08-02，Codex #371 r2 High 的正解）：
//    它的成本確實要算（單一回應可達 25MiB、服務層整包 JSON.parse，實測 RSS +118MiB，
//    與 PDF 並行會越過 512MB）——**但它有 `refreshInFlight` 去重**：兩人同時更新同一代號
//    只會真的抓一輪，第二個請求幾乎不花記憶體。掛在 HTTP 層等於把「不花錢的第二個」也擋掉
//   （實測會打掉既有的「A/B 並發同代號」考題），純損失。
//    ⇒ 改用 `withHeavySlot()` 在**服務層真的要抓的那一刻**取名額（見 lib/services/stock-fundamentals.js）。

/** 沒有 request body parser 的重型路徑（重量在**對外抓取＋解析**，不在請求本體）。
 *  ⚠️ 掛載順序考題要靠這份清單分辨「該比順序」與「只需確認掛上」，**不可用啟發式猜**
 *  （Codex #371 r2：原本寫死「只有 IB」，新增這類路徑時會靜默失準）。 */
export const HEAVY_ROUTES_WITHOUT_BODY = ['/api/ib/sync'];

/**
 * 服務層等名額的上限（毫秒）。**HTTP 層不等**（fail-fast 是它存在的理由），
 * 但服務層的等待**不花記憶體**——等待中的 SEC 請求手上沒有任何大緩衝區。
 * 見 `withHeavySlot` 的說明。
 */
export const HEAVY_SLOT_WAIT_MS = 30_000;

/** @type {number | null} */ let waitOverrideMs = null;
/** 測試用：把等待上限調短（不然「等到逾時」那題要真的等 30 秒）。傳 null 還原。 */
export function setHeavySlotWaitForTest(ms) { waitOverrideMs = ms; }

let inFlight = 0;
/** @type {Array<() => void>} 等名額的人（FIFO）。只有服務層會排隊，HTTP 層一律 fail-fast。 */
const waiters = [];

/**
 * 歸還名額。**有人在等就直接把名額轉交給他，不先減再加**——
 * 減了再讓對方加，中間隔著一個微任務，其他同步呼叫者可以插隊搶走（實測會讓公平性與上限同時失守）。
 */
function releaseSlot() {
  const next = waiters.shift();
  if (next) { next(); return; }   // 名額原地轉交，inFlight 不動
  inFlight -= 1;
}

/** 測試用：目前佔用的名額數。 */
export function heavyAdmissionInFlightForTest() { return inFlight; }
/** 測試用：目前排隊等名額的人數。 */
export function heavyAdmissionWaitingForTest() { return waiters.length; }
/** 測試用：重置（考題之間不互相污染）。 */
export function resetHeavyAdmissionForTest() { inFlight = 0; waiters.length = 0; }

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

  // ⚠️ **拿名額之前先確認連線還活著**（獨立複核 2026-08-02 抓到的 High）：
  //    `authGate` 排在這一層**之前**，而它裡面有一段**真的網路往返**——
  //    `supabase.auth.getUser()` 是打到 Supabase 驗簽，不是只讀 cookie 面值。
  //    客戶端若在那段期間斷線（按取消、關分頁、手機斷網），res 的 `'close'`
  //    **早在我們掛 listener 之前就燒掉了**，下面那兩個 listener 一輩子不會觸發
  //    ＝**名額有借無還**。而 `inFlight` 是模組層變數、不分租戶，一次洩漏就讓
  //    整個部署的所有重型功能永久 503（不會自己回收，只有重啟行程才好），
  //    訊息還是「另一份檔案正在上傳」＝指向錯誤的原因。
  //    實測窗口就是那段 RTT：延遲 0／1／5ms 不洩漏、20／60ms 洩漏；production 的
  //    Render→supabase.co 往返是數十～數百 ms，任何一次取消上傳都踩得到。
  if (res.closed || res.destroyed || req.destroyed) return next();

  inFlight += 1;
  let released = false;
  const release = () => { if (released) return; released = true; releaseSlot(); };
  // ⚠️ 兩個事件都要掛：正常回應是 finish→close；**客戶端中途斷線只有 close**。
  //    release 做成 idempotent，重複觸發只減一次。
  res.on('finish', release);
  res.on('close', release);
  // 保險：掛好之後再確認一次。上面那道守門擋的是「進來時就已經斷了」，
  // 這道擋的是任何我沒想到的順序問題；release 是 idempotent，多做一次沒有代價。
  if (res.closed || res.destroyed) release();
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

/**
 * **服務層用的名額**：跟 HTTP 入場管制共用同一個計數，但由呼叫端決定「什麼時候才算重型工作」。
 * 用於 SEC 這種**有去重**的路徑——只有真的要對外抓＋解析時才取，去重命中的請求不佔名額。
 *
 * ⚠️ **這裡會排隊等，HTTP 層不會**（獨立複核 2026-08-02 抓到的回歸）。兩層的取捨不同：
 *
 * - HTTP 層必須 fail-fast，因為**等待的人手上握著一條還沒收完的連線**；讓它等，等於
 *   一邊佔記憶體一邊排隊，正是這一層要防的事。
 * - 服務層等待**不花記憶體**：SEC 請求在等的時候手上沒有任何大緩衝區，真正貴的是
 *   「抓下來之後整包 JSON.parse」那一刻，而那一刻已經被名額保護住了。
 *
 * 原本這裡照抄 HTTP 層的 fail-fast，造成兩個相對 main 的回歸：
 * ①**不同代號的併發更新**在 main 是排隊後全部成功，在這裡變成第二個起立刻 503；
 * ② SEC 自己的佇列（#361 的 `SEC_QUEUE_MAX_DEPTH`＝兩天前才上線的護欄）在 HOSTED
 *    變成**打不到的死碼**——請求在排到它之前就被打掉了。
 * 改成有上限的等待之後，兩者都回來了：serialise 照舊（記憶體仍然只有一份工作在跑），
 * 但「都會成功」這件事沒有被犧牲。
 *
 * @template T @param {() => Promise<T>} fn @param {{waitMs?: number}=} opts
 * @returns {Promise<T>}
 */
export async function withHeavySlot(fn, opts) {
  if (!isHosted()) return fn();   // LOCAL 零改動
  const waitMs = opts?.waitMs ?? waitOverrideMs ?? HEAVY_SLOT_WAIT_MS;
  if (inFlight >= HEAVY_ADMISSION_MAX_INFLIGHT) {
    /** @type {(() => void) | null} */ let entry = null;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = entry ? waiters.indexOf(entry) : -1;
        if (i >= 0) waiters.splice(i, 1);   // 自己從隊伍裡移除，否則名額會被轉交給早已放棄的人
        reject(Object.assign(new Error('伺服器正在處理另一件重型工作（檔案上傳或資料同步），請稍後再試。'),
          { status: 503, code: 'heavy_busy' }));
      }, waitMs);
      if (typeof timer.unref === 'function') timer.unref();   // 別讓等待卡住行程結束
      entry = () => { clearTimeout(timer); resolve(undefined); };
      waiters.push(entry);
    });
    // 走到這裡＝名額是被**轉交**過來的（releaseSlot 沒有把 inFlight 減掉），所以不再自己加。
    try { return await fn(); } finally { releaseSlot(); }
  }
  inFlight += 1;
  try { return await fn(); } finally { releaseSlot(); }
}
