// @ts-check
// **PDF 抽取的行程隔離**（HOSTED 專用，2026-07-29；William 裁決「只套雲端版」）。
//
// ## 為什麼需要這一層
//
// 自審實測（`--max-old-space-size=400`，模擬 Render 512MB）：兩份**結構完全合法**、
// 只有一頁的小 PDF（138KB 約 200 萬個文字節點／207KB 內容串流解壓後 83MB），
// 都會讓解析行程死掉（峰值 612MB／704MB），而兩道既有的牆（頁數上限、文字節點上限）
// 都看到「正常」。
//
// ⚠️ **死法不只一種——2026-08-02 追出真相（Codex #350 r1/r2）**：除了記憶體耗盡，
//    更常見的是 **pdfjs 卡死在解壓、那個 promise 永遠不 settle**。實測：子行程 1.4 秒就
//    `code 0` 乾淨結束、stdout/stderr 全空（事件迴圈一空就退出）；行程內直跑則是
//    Node 的 exit code 13（top-level await 永不 settle）。**不是 OOM。**
//    → 子行程因此掛了 keep-alive 計時器（不准安靜退出），逾時判定收斂到父行程一處。
//    ⚠️ 舊註解曾把這兩種死法都寫成「OOM」，害「沒有 stdout」被當成「使用者的檔案太貴」。
//
// 先做的「邊收邊數」（`readPageTextCapped`）確實把記憶體峰值壓下來（612→406、704→456），
// 但**還是會死**：真正的成本在 pdfjs 解壓內容串流那一段，而那沒有任何可以掛鉤的地方。
//
// ## 為什麼是「隔離」而不是「再蓋一道牆」
//
// 蓋牆的話，我們得自己先掃一遍 PDF、算出「這份檔案會不會很貴」。
// **但那正是今晚在 XLSX 上被打穿四次的模式**——牆與解析器只要對格式的理解有一點點不同
// （枚舉方式、欄位偏移、宣告值信不信），攻擊者就從那個縫鑽過去。
// 而 PDF 的物件結構（間接 `/Length`、object stream、xref stream）比 ZIP 難得多，
// 自己寫掃描器幾乎一定會犯同一個錯。
//
// **隔離不需要看懂格式。** 它不猜、不掃、不信任何宣告值——就是給子行程一個硬性記憶體上限，
// 死了就是死了，父行程完好無損。實測：兩個攻擊檔都讓子行程 exit 13（OOM），
// **父行程 RSS 完全沒變**（停在 47MB）。
//
// ## 代價（誠實記錄）
//
// 每次解析多約 250ms（spawn 成本）。真實帳單從 ~95ms 變 ~342ms。
// 使用者是主動按「上傳」的，這個延遲可以接受；換到的是「別人上傳一份小檔不會把全站打掛」。
//
// ## ⚠️ 為什麼只套 HOSTED（William 2026-07-29 裁決）
//
// 這道防線保護的是「**多人共用的那一台機器**」——本機只有你自己在用，
// 而且檔案都是你自己從銀行下載的。判準與 `lib/http-body.js` 的 1MB 那條一致：
// **這道牆保護的是誰的資源？** 保護共用主機 → 只套 HOSTED。
//
// ⚠️ 這與「解析器上限兩種模式都套」的既有慣例**刻意不同**，理由是那些牆防的是
// 「畸形檔案本機一樣會遇到」（會讓你自己的匯入壞掉），而這一層防的是
// 「別人把共用主機打掛」——本機沒有那個情境，卻要付 250ms 的代價。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { isHosted } from './hosted.js';

// ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'pdf-isolate-child.js');

/** 子行程的 heap 上限。Render 512MB − app 底噪（約 148MB）再留給其他請求。 */
export const PDF_CHILD_HEAP_MB = 256;
/** 子行程最長跑多久。真實帳單約 0.3 秒；30 秒是「卡住」的絆索，不是效能目標。
 * ⚠️ **這是唯一的逾時判定點**（子行程只負責不安靜退出）——內容串流炸彈會讓 pdfjs 的 promise
 *    永不 settle，靠這裡 SIGKILL 才收得回來。 */
export const PDF_CHILD_TIMEOUT_MS = 30_000;
/** 考題用：縮短逾時（否則每題要等 30 秒）。傳 null 還原。 @type {number|null} */
let timeoutOverrideMs = null;
/** @param {number|null} ms */
export function setPdfTimeoutForTest(ms) { timeoutOverrideMs = ms; }
/** 子行程回傳的抽取結果上限（200 頁的正常對帳單約幾 MB）。 */
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

/** 支援的種類——**與 `pdf-isolate-child.js` 的 EXTRACTORS 必須一致**（有考題盯著）。 */
export const PDF_ISOLATE_KINDS = ['statement', 'bank', 'securities'];

// ⚠️ **併發上限**（Codex #350 r1 High）：行程隔離只解決「一顆打死主程式」，**沒解決「同時兩顆」**。
//    單顆峰值實測約 316MB，Render 512MB 連兩顆都容不下——兩個請求同時上傳炸彈檔，服務照樣死。
//    ⇒ 全站序列化（同時只跑一顆），排隊中＋執行中超過深度上限就**立刻 503**（不讓等待者
//    持續占住已經收下的 base64 body ＝ 記憶體）。判準同 SEC 佇列護欄（#361）的兩道。
/** 排隊中＋執行中的上限。滿了立刻 503 fail-fast。 */
export const PDF_QUEUE_MAX_DEPTH = 6;
let pdfDepth = 0;
/** 序列鏈＝同時只有一顆子行程（上限 1 就是用這條鏈實現的，沒有另一個常數）。
 * @type {Promise<any>} */
let pdfChain = Promise.resolve();

/** 測試用：重置佇列狀態（考題之間不互相污染）。 */
export function resetPdfQueueForTest() { pdfDepth = 0; pdfChain = Promise.resolve(); }
/** 測試用：目前排隊中＋執行中的數量。 */
export function pdfQueueDepthForTest() { return pdfDepth; }
/** 測試用：直接把 fn 送進**同一支**佇列（不 spawn 子行程），驗深度上限與序列化。
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
export function throughPdfQueueForTest(fn) { return throughPdfQueue(fn); }

/**
 * 讓 fn 通過全站 PDF 佇列（序列執行＋深度上限）。
 * ⚠️ 深度**必須涵蓋到子行程真的結束**（記憶體是那時候才還的），所以 finally 掛在整個 fn 上。
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
function throughPdfQueue(fn) {
  if (pdfDepth >= PDF_QUEUE_MAX_DEPTH) {
    return Promise.reject(Object.assign(
      new Error('目前有多份 PDF 正在解析中，請稍後再試。'),
      { status: 503, code: 'pdf_busy' }));
  }
  pdfDepth += 1;
  const run = pdfChain.then(async () => {
    try { return await fn(); } finally { pdfDepth -= 1; }
  });
  pdfChain = run.catch(() => undefined);
  return run;
}

/**
 * 在子行程裡跑 PDF 抽取。**只有 HOSTED 會走到這裡**（呼叫端已經判斷過）。
 * @param {string} kind @param {Uint8Array} data @param {string=} password
 * @returns {Promise<any[]>}
 */
function runInChild(kind, data, password) {
  return new Promise((resolve, reject) => {
    // ⚠️ **密碼絕不可放 argv／env**（Codex #350 r1 抓到的 PII 洩漏）：PDF 密碼＝身分證字號，
    //    argv 會出現在 `ps` 的行程清單、env 會出現在 /proc/<pid>/environ，同機任何程式都讀得到。
    //    改走 stdin 首行 JSON 標頭（任意字元都安全），base64 內容接在換行之後。考題釘住。
    const child = spawn(process.execPath,
      [`--max-old-space-size=${PDF_CHILD_HEAP_MB}`, CHILD, kind],
      { stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '', err = '', tooBig = false;
    let killedByTimeout = false;
    /** @type {any} */
    let timer = setTimeout(() => {
      timer = null; killedByTimeout = true;
      try { child.kill('SIGKILL'); } catch { /* 已經死了 */ }
    }, timeoutOverrideMs ?? PDF_CHILD_TIMEOUT_MS);

    child.stdout.on('data', (b) => {
      out += b;
      if (out.length > MAX_RESULT_BYTES) { tooBig = true; try { child.kill('SIGKILL'); } catch { /* 已經死了 */ } }
    });
    child.stderr.on('data', (b) => { err += String(b).slice(0, 2000); });

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      // spawn 本身失敗（execPath 不對、fd 用盡…）＝我們的問題，不是使用者的檔案有問題
      reject(Object.assign(new Error('伺服器暫時無法解析 PDF，請稍後再試'),
        { status: 500, code: 'pdf_isolate_spawn_failed', cause: e }));
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (tooBig) {
        return reject(Object.assign(
          new Error('這份 PDF 解析出來的內容太多，無法安全處理。請確認這是一份正常的對帳單。'),
          { status: 400, code: 'pdf_result_too_large' }));
      }
      // ⚠️ **沒有 stdout 不等於「使用者的檔案太貴」**（Codex #350 r1 Medium）：child 入口打錯、
      //    相依壞掉、程式例外一樣沒有 stdout，全判 400 會**責怪使用者並藏起部署／程式故障**
      //   （實測把 child 路徑改成不存在，得到「這份 PDF 需要的資源超過上限」）。
      //    ⇒ 只有**確認是資源或逾時**才 400，其餘一律 500（真正原因進伺服器日誌）。
      if (!out) {
        const detail = `signal=${signal} code=${code} stderr=${err.slice(0, 300)}`;
        const oomMarks = /heap out of memory|allocation failure|Allocation failed|out of memory/i;
        const resourceKilled = killedByTimeout
          || signal === 'SIGABRT' || signal === 'SIGKILL' || code === 134
          || oomMarks.test(err);
        if (!resourceKilled) {
          console.error('[pdf-isolate] 子行程異常結束（非資源上限）：', detail);
          return reject(Object.assign(new Error('伺服器暫時無法解析 PDF，請稍後再試'),
            { status: 500, code: 'pdf_isolate_child_failed', cause: detail }));
        }
        return reject(Object.assign(
          new Error(killedByTimeout
            ? '這份 PDF 解析太久（超過時間上限），已停止。請確認這是一份正常的對帳單。'
            : '這份 PDF 需要的資源超過上限，無法解析。'
              + '請確認這是一份正常的對帳單；如果它真的很大，請改用該期單獨的帳單檔。'),
          { status: 400, code: killedByTimeout ? 'pdf_timeout' : 'pdf_resource_exhausted', cause: detail }));
      }
      /** @type {any} */
      let parsed;
      try { parsed = JSON.parse(out); }
      catch {
        return reject(Object.assign(new Error('伺服器暫時無法解析 PDF，請稍後再試'),
          { status: 500, code: 'pdf_isolate_bad_output' }));
      }
      // 抽取器丟的錯要**原味還原**（訊息與 status 都是給使用者看的）
      if (!parsed.ok) {
        const st = Number(parsed.status) || 500;
        // 5xx＝我們的問題：真正原因只進伺服器日誌，不吐給瀏覽器（比照 SEC 服務的錯誤歸因）
        if (st >= 500) console.error('[pdf-isolate] 子行程回報內部錯誤：', String(parsed.detail || parsed.message).slice(0, 300));
        return reject(Object.assign(new Error(String(parsed.message || '解析失敗')),
          { status: st, ...(parsed.code ? { code: parsed.code } : {}) }));
      }
      resolve(parsed.lines || []);
    });

    child.stdin.on('error', () => { /* 子行程先死時 EPIPE，close 那邊會處理 */ });
    // stdin 協定：首行 JSON 標頭（含 password）＋換行＋base64 內容
    child.stdin.end(`${JSON.stringify({ password: password || '' })}\n${Buffer.from(data).toString('base64')}`);
  });
}

/**
 * 抽取 PDF 的每一行——**HOSTED 走子行程、LOCAL 直接跑**。
 * @param {string} kind `statement`／`bank`／`securities`
 * @param {(data: Uint8Array, password?: string) => Promise<any[]>} inProcess LOCAL 走的原函式
 * @param {Uint8Array} data @param {string=} password
 * @returns {Promise<any[]>}
 */
export async function extractPdfLines(kind, inProcess, data, password) {
  // LOCAL：**一行都不繞**（零改動契約）。連 spawn 的 250ms 都不付。
  if (!isHosted()) return inProcess(data, password);
  return throughPdfQueue(() => runInChild(kind, data, password));
}
