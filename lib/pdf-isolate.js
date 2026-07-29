// @ts-check
// **PDF 抽取的行程隔離**（HOSTED 專用，2026-07-29；William 裁決「只套雲端版」）。
//
// ## 為什麼需要這一層
//
// 自審實測（`--max-old-space-size=400`，模擬 Render 512MB）：
//     138 KB 的**一頁** PDF（約 200 萬個文字節點）→ **行程 OOM 死掉**，峰值 612MB
//     207 KB 的**一頁** PDF（內容串流解壓後 83MB）→ **行程 OOM 死掉**，峰值 704MB
// 兩份都是**結構完全合法**的 PDF，兩道既有的牆（頁數上限、文字節點上限）都看到「正常」。
//
// 先做的「邊收邊數」（`readPageTextCapped`）確實把峰值壓下來（612→406、704→456），
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
/** 子行程最長跑多久。真實帳單約 0.3 秒；30 秒是「卡住」的絆索，不是效能目標。 */
export const PDF_CHILD_TIMEOUT_MS = 30_000;
/** 子行程回傳的抽取結果上限（200 頁的正常對帳單約幾 MB）。 */
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

/** 支援的種類——**與 `pdf-isolate-child.js` 的 EXTRACTORS 必須一致**（有考題盯著）。 */
export const PDF_ISOLATE_KINDS = ['statement', 'bank', 'securities'];

/**
 * 在子行程裡跑 PDF 抽取。**只有 HOSTED 會走到這裡**（呼叫端已經判斷過）。
 * @param {string} kind @param {Uint8Array} data @param {string=} password
 * @returns {Promise<any[]>}
 */
function runInChild(kind, data, password) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [`--max-old-space-size=${PDF_CHILD_HEAP_MB}`, CHILD, kind, password || ''],
      { stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '', err = '', tooBig = false;
    /** @type {any} */
    let timer = setTimeout(() => { timer = null; try { child.kill('SIGKILL'); } catch { /* 已經死了 */ } }, PDF_CHILD_TIMEOUT_MS);

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
      // ⚠️ **沒有 stdout ＝子行程被資源上限打死**（OOM 或逾時）。
      //    這正是這一層存在的理由：在父行程裡它會是「整個服務死掉」，在這裡只是一個 400。
      if (!out) {
        return reject(Object.assign(
          new Error('這份 PDF 需要的資源超過上限，無法解析。'
            + '請確認這是一份正常的對帳單；如果它真的很大，請改用該期單獨的帳單檔。'),
          { status: 400, code: 'pdf_resource_exhausted', cause: `signal=${signal} code=${code} stderr=${err.slice(0, 300)}` }));
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
        return reject(Object.assign(new Error(String(parsed.message || '解析失敗')),
          { status: Number(parsed.status) || 400, ...(parsed.code ? { code: parsed.code } : {}) }));
      }
      resolve(parsed.lines || []);
    });

    child.stdin.on('error', () => { /* 子行程先死時 EPIPE，close 那邊會處理 */ });
    child.stdin.end(Buffer.from(data).toString('base64'));
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
  return runInChild(kind, data, password);
}
