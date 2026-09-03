// @ts-check
// **PDF 抽取的行程隔離**（HOSTED 專用，2026-07-29；William 裁決「只套雲端版」）。
//
// ## 為什麼需要這一層
//
// 自審實測（`--max-old-space-size=400`，模擬 Render 512MB）：兩份**結構完全合法**、
// 只有一頁的小 PDF（138KB 約 200 萬個文字節點／207KB 內容串流解壓後 83MB），
// 都會讓解析行程死掉（峰值 612MB／704MB），而**當時**那兩道牆（頁數上限、事後才數的
// `countTextItems`）都看到「正常」。⚠️ **「都看到正常」講的是 2026-07-29 之前**：
// 那之後文字節點牆改成邊收邊數的 `readPageTextCapped`，這兩顆檔案現在**會**被它擋下。
//
// ⚠️ **死法不只一種**：除了記憶體耗盡，還有「跑不完」——子行程因此掛了 keep-alive 計時器
//    （不准安靜退出），逾時判定收斂到父行程一處。
// ⚠️ **這段的成因寫錯過兩次，2026-08-29 才追到底**（起因是 CI 間歇紅）：
//    v1 把所有死法都寫成 OOM，害「沒有 stdout」被當成「使用者的檔案太貴」；
//    v2（2026-08-02）改寫成「pdfjs 卡死在解壓、promise 永遠不 settle」——**那也是錯的**。
//    真正的原因在 `lib/parse-limits.js` 的 `cancelStream`：取消 pdfjs 串流時少帶一個 `Error` 理由，
//    pdfjs 當場拒絕、也就從沒收到取消，於是它的生產端永遠等下去（我們自己造成的卡死）。
//    修好之後，那顆「炸彈檔」由文字節點牆**當場擋下、根本走不到逾時**
//    （考題釘的是「回的是 pdf_too_many_text_items 而不是 pdf_timeout」；秒數沒有考題撐，不寫）。
//    → 逾時與 keep-alive 都**留著**，但它們守的是**未知**的卡住，不是那一顆炸彈。
//
// ⚠️ **這裡原本寫「邊收邊數把峰值壓下來但還是會死，真正的成本在解壓那段、沒有地方可以掛鉤」
//    ——2026-08-29 證實那句不成立**（Codex #538 r1 指出它與本檔上面新增的根因自相矛盾）：
//    「還是會死」是取消沒生效造成的（見 `lib/parse-limits.js` 的 `cancelStream`）。
//    修好之後重測的結論：兩顆攻擊檔都由文字節點牆當場擋下、回乾淨的 400，成本留在子行程、
//    父行程不長。⚠️ **確切的數字與量測條件只住 `lib/parse-limits.js` 的 `readPageTextCapped`**
//    ——這裡刻意不抄（抄本會漂：本檔原本寫 612→406／704→456，那邊寫 612→254／704→316，
//    兩份對不起來也沒人發現。Codex #538 r2 抓到我第一版「說不抄卻抄了」的自相矛盾）。
//
// ## 為什麼是「隔離」而不是「再蓋一道牆」
//
// 蓋牆的話，我們得自己先掃一遍 PDF、算出「這份檔案會不會很貴」。
// **但那正是今晚在 XLSX 上被打穿四次的模式**——牆與解析器只要對格式的理解有一點點不同
// （枚舉方式、欄位偏移、宣告值信不信），攻擊者就從那個縫鑽過去。
// 而 PDF 的物件結構（間接 `/Length`、object stream、xref stream）比 ZIP 難得多，
// 自己寫掃描器幾乎一定會犯同一個錯。
//
// **隔離不需要看懂格式。** 它不猜、不掃、不信任何宣告值——把成本關進子行程，
// 子行程怎麼死都不影響父行程。實測（2026-07-29）：兩個攻擊檔都讓子行程死掉，
// **父行程 RSS 完全沒變**（停在 47MB）。
// ⚠️ **「都讓子行程死掉」講的是當時**（2026-08-29 更正）：取消修好之後，同樣兩顆檔案是被
// 文字節點牆當場擋下、子行程正常回一個 400 就結束的。這一段留著是因為**隔離的理由沒有變**
// （下一顆未知的攻擊檔還是可能讓子行程死掉），但別把它讀成「現在還是這樣」。
//
// ⚠️ **用字要精確（2026-08-02 修正）**：`--max-old-space-size` 是 **V8 old-space 上限，不是硬性 RSS
//    上限**（off-heap 管不到）；而且**死法不只 OOM**——也可能是「跑不完」（子行程沒有輸出）。
//    前者靠 heap 上限、後者靠 keep-alive＋父行程逾時，兩條路都要有人接。
//    （⚠️ 這裡原本把「跑不完」的成因寫成 pdfjs 卡死在解壓——**已於 2026-08-29 更正**，見上方。）
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
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { isHosted } from './hosted.js';
import { PARSE_DIAG } from './parse-limits.js';

/** 子行程可以回報的診斷代碼——**封閉集合**（單一真相＝`lib/parse-limits.js` 的 `PARSE_DIAG`）。
 *  白名單比對是刻意的：子行程回什麼都不能決定父行程日誌的內容。 */
const KNOWN_DIAG = new Set(/** @type {string[]} */ (Object.values(PARSE_DIAG)));

// ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
// ⚠️ `DOUBLES_DIR` 在這裡算好（而不是在函式裡）是**進入點守衛逼出來的**：那道 lint 規則禁止
//    「拿 import.meta 去比對」的式子，連 `abs.startsWith(⟨import.meta 算出來的路徑⟩)` 都算。
//    先算成常數再比對，語意一樣、也不必為了自己開豁免。（pre-push 的 lint 擋下來才發現的。）
const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'pdf-isolate-child.js');
/** 考題接縫唯一准許的替代腳本目錄（見 `setPdfChildScriptForTest`）。 */
const DOUBLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-doubles');

/** 子行程的 heap 上限。Render 512MB − app 底噪（約 148MB）再留給其他請求。 */
export const PDF_CHILD_HEAP_MB = 256;
/** 子行程最長跑多久。真實帳單約 0.3 秒；30 秒是「卡住」的絆索，不是效能目標。
 * ⚠️ **這是唯一的逾時判定點**（子行程只負責不安靜退出）：子行程只要沒把結果寫回來，
 *    就得靠這裡 SIGKILL 才收得回來。
 * ⚠️ **它守的是「未知」的卡住**——這句話以前寫成「內容串流炸彈會讓 pdfjs 的 promise 永不 settle」，
 *    2026-08-29 證實那個卡住是我們自己造成的（`parse-limits.js` 的 `cancelStream`），已修掉；
 *    那顆炸彈現在由文字節點牆當場擋下。**沒有考題能證明「還有別的東西會卡住」——留著是保險，不是保證。** */
export const PDF_CHILD_TIMEOUT_MS = 30_000;
/** 考題用：縮短逾時（否則每題要等 30 秒）。傳 null 還原。 @type {number|null} */
let timeoutOverrideMs = null;
/** @param {number|null} ms */
export function setPdfTimeoutForTest(ms) { timeoutOverrideMs = ms; }
/** Node 測試執行器會設的值（v22／v26 實測都是 `child-v8`；`child` 是舊版寫法）。
 *  **刻意是封閉集合**：接受任意非空字串等於「設個環境變數就開門」。 */
const NODE_TEST_CONTEXTS = new Set(['child-v8', 'child']);
/** @type {string|null} */
let childScriptOverride = null;
/**
 * 考題用：換掉子行程腳本。傳 null 還原成正式的 `pdf-isolate-child.js`。
 *
 * ⚠️ **為什麼需要這個接縫**（2026-08-29）：父行程對子行程死法的**歸類**才是這一層的安全行為
 *   （真的卡住＝400 `pdf_timeout`／提早死＝500，不可以互相假冒），但它原本只能靠
 *    「餵一顆讓 pdfjs 卡住的 PDF」來測——而那是**時間競速**：CI 上實測失敗耗時 2.91／2.98／3.02 秒、
 *    逾時 3.00 秒，餘裕 3%，於是同一顆 commit 一次紅一次綠。換成行為確定的假子行程之後，
 *    三種死法各自釘死——**不再跟 PDF 的解析時間競速**（hang／crash 題自己仍有時間斷言，
 *    但那些斷言量的是父行程的行為，不是 pdfjs 多快）。
 * ⚠️ **兩層，門在下面那一層**（Codex #538 r1/r2/r3——這句話我改了三次才撐得住）：
 *      ①**ESLint 語法樹**（`eslint.config.js` 的 `SEAM_SELECTORS`）擋掉正式程式碼裡的**正常寫法**
 *        （含別名 import、`.call`、換行呼叫）。⚠️ 它**擋不住算出來的成員存取**（模板字串、字串相加）
 *        ——這是靜態分析的天花板，不是疏漏。
 *      ②**執行期**：本函式不在 Node 測試執行器的行程裡就丟錯，而且只准換成 `test-doubles/`
 *        底下的檔案（見下）。⚠️ 它是**防誤用**的 fail-loud 護欄，**不是**擋得住刻意規避的安全邊界
 *        ——環境變數任何人都能自己設（Codex #538 r4）。它買到的是：**呼叫得到也只能指到
 *        `test-doubles/` 裡的一般檔案**（真實路徑比對、保存 canonical；r5 實證過連結繞法並已修）。
 *        ⚠️ 射程只到「設定當下」——TOCTOU／hardlink／根目錄被換不在防守範圍，理由見該函式。
 *    ⚠️ **沒有第三層**（Grok 掃描 #4）：我原本把 `test/pdf-isolate.test.js` 的 `afterEach`
 *    寫成這個接縫的第③層——那不成立。函式庫**不會**自己還原，也強制不了別支考題檔還原；
 *    那個 hook 只保護它自己那一支檔（`test/xlsx-isolate.test.js` 也在用同模組的
 *    `setPdfTimeoutForTest`，就沒有對等的 hook）。**漏還原不會有任何函式庫層的東西轉紅。**
 *    這個值不由任何外部輸入決定（不讀 env 的值、不讀請求）。
 * @param {string|null} path
 */
export function setPdfChildScriptForTest(path) {
  // ⚠️ **這是「防誤用」的 fail-loud 護欄，不是安全邊界**（Codex #538 r4 把我上一版的定位打回來）：
  //    `NODE_TEST_CONTEXT` 是**環境變數**，任何行程都能自己設——它擋得住「不小心在正式路徑呼叫」，
  //    擋不住「刻意設環境變數再呼叫」。真正的安全結論靠的是另外兩件事：
  //      ①正式程式碼裡沒有任何呼叫者（ESLint 擋正常寫法；算出來的成員存取是靜態分析的天花板）
  //      ②**就算被呼叫，設定當下也必須指到 `test-doubles/` 底下的一般檔案**，而且之後 spawn 的
  //        就是那一刻驗過的那個絕對路徑（走真實路徑、保存 canonical）。
  //    ⚠️ **它不防這三種**（Codex #538 r6 判定「不必再加固，照實寫下來」）：
  //      ・驗完到 spawn 之間把檔案換掉（TOCTOU——沒有 pin 住 inode）
  //      ・`test-doubles/` 裡放一個 hardlink 指到外部檔案
  //      ・把 `test-doubles/` 這個根目錄本身換成指向外部的連結
  //    三種都需要「能改 checkout」的同等權限，而有那個權限的人本來就能直接改正式程式碼——
  //    再加碼只會增加跨平台複雜度，換不到新的可信邊界。
  //    ⚠️ 只認 Node 測試執行器**已知的值**，不接受任何非空字串（上一版接受任意 truthy）。
  //    ⚠️ **不支援 `--test-isolation=none`**：那條路 Node 不設這個標記，本函式會大聲失敗。
  //    專案的 `npm test` 走預設的 process isolation，不受影響；Node 日後拿掉標記也是整批紅（fail-loud）。
  if (!NODE_TEST_CONTEXTS.has(String(process.env.NODE_TEST_CONTEXT || ''))) {
    throw new Error('setPdfChildScriptForTest 只能在 Node 測試執行器的行程裡呼叫'
      + '（不支援 --test-isolation=none）——正式路徑永遠是 lib/pdf-isolate-child.js。');
  }
  if (path === null) { childScriptOverride = null; return; }
  // ⚠️ **要比對「真實路徑」，而且要保存比對過的那一個**（Codex #538 r5 Medium，實證繞法）：
  //    上一版只用 `resolve()` 做字串前綴比對，然後把**原字串**交給 spawn，兩個洞：
  //      ①`test-doubles/x.js` 是個**符號連結**指到 `/bin/echo` ⇒ 前綴比對過關、跑的是外面的東西
  //       （他實測 accepted:true、real:/bin/echo）
  //      ②驗的是 `abs`、用的是原字串 ⇒ 相對路徑在 cwd 變了之後，跑的已經不是剛才驗過的檔案。
  //    ⇒ 兩邊都取 `realpathSync`（連結一路走到底）、用 `relative()` 確認仍在根目錄內、
  //      確認是**一般檔案**，最後**保存那個 canonical 絕對路徑**交給 spawn。
  /** @type {string} */
  let real;
  try { real = realpathSync(resolve(String(path))); }
  catch { throw new Error(`找不到子行程腳本（${String(path)}）——只能換成 test-doubles/ 底下實際存在的檔案。`); }
  const rel = relative(realpathSync(DOUBLES_DIR), real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`子行程腳本只能換成 test-doubles/ 底下的檔案（實際指到：${real}）`
      + '——符號連結會被一路走到底，指到目錄外一樣不收。');
  }
  if (!statSync(real).isFile()) throw new Error(`子行程腳本必須是一般檔案（實際：${real}）`);
  childScriptOverride = real;
}
/** 子行程回傳的抽取結果上限（200 頁的正常對帳單約幾 MB）。
 *  ⚠️ **刻意不給考題接縫**（Codex #551 r1 High）：只考「縮小的門檻」擋不住有人把這個常數改成無限大——
 *  考題直接灌到這個真值（實測約 2 秒），另有一條範圍絆線釘住它是有限且合理的數字。 */
export const MAX_RESULT_BYTES = 64 * 1024 * 1024;

/** 支援的種類——**與 `pdf-isolate-child.js` 的 EXTRACTORS 必須一致**（有考題盯著）。 */
export const PDF_ISOLATE_KINDS = ['statement', 'bank', 'securities', 'xlsx'];

// ⚠️ **併發上限**（Codex #350 r1 High）：行程隔離只解決「一顆打死主程式」，**沒解決「同時兩顆」**。
//    單顆峰值大約是 Render 512MB 的一半以上（確切數字與量測條件見 `lib/parse-limits.js` 的
//    `readPageTextCapped`——⚠️ 這裡刻意不抄，本檔檔頭已經因為抄數字被抓過一次），
//    連兩顆都容不下——兩個請求同時上傳炸彈檔，服務照樣死。
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
 * 這一層是 PDF 與 XLSX 共用的，錯誤訊息不能一律寫「PDF」——
 * 使用者傳的是 .xlsx，卻被告知「這份 PDF 太大」會直接讓人以為傳錯檔案（Codex #373 r1 Low）。
 * @param {string} kind @returns {string}
 */
function fileLabel(kind) { return kind === 'xlsx' ? 'Excel 檔' : 'PDF'; }

/**
 * 讓 fn 通過全站 PDF 佇列（序列執行＋深度上限）。
 * ⚠️ 深度**必須涵蓋到子行程真的結束**（記憶體是那時候才還的），所以 finally 掛在整個 fn 上。
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
function throughPdfQueue(fn) {
  if (pdfDepth >= PDF_QUEUE_MAX_DEPTH) {
    return Promise.reject(Object.assign(
      new Error('目前有多份檔案正在解析中，請稍後再試。'),
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
 * @returns {Promise<any>} 形狀由種類決定（PDF 抽取＝列陣列、xlsx＝{rows, allText}）
 */
function runInChild(kind, data, password) {
  return new Promise((resolve, reject) => {
    // ⚠️ **密碼絕不可放 argv／env**（Codex #350 r1 抓到的 PII 洩漏）：PDF 密碼＝身分證字號，
    //    argv 會出現在 `ps` 的行程清單、env 會出現在 /proc/<pid>/environ，同機任何程式都讀得到。
    //    改走 stdin 首行 JSON 標頭（任意字元都安全），base64 內容接在換行之後。考題釘住。
    const child = spawn(process.execPath,
      [`--max-old-space-size=${PDF_CHILD_HEAP_MB}`, childScriptOverride ?? CHILD, kind],
      { stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '', err = '', tooBig = false;
    let outBytes = 0;   // ⚠️ 數 Buffer 的 bytes、不是字串的 code units（多位元組字元會讓字串長度小於 bytes，牆就晚觸發——Codex #551 r2）
    let killedByTimeout = false;
    /** @type {any} */
    let timer = setTimeout(() => {
      timer = null; killedByTimeout = true;
      try { child.kill('SIGKILL'); } catch { /* 已經死了 */ }
    }, timeoutOverrideMs ?? PDF_CHILD_TIMEOUT_MS);

    child.stdout.on('data', (b) => {
      out += b; outBytes += b.length;
      // ⚠️ 這道牆拆了以前不會有任何一題轉紅——2026-09-02 第二輪稽核實測（壓縮炸彈解開後灌回主行程＝全站 OOM 重啟）；
      //    現由 test/pdf-isolate.test.js 的「回傳量炸彈」題**灌到真的 MAX_RESULT_BYTES** 釘住：超標當場 SIGKILL、回 400 pdf_result_too_large。
      if (outBytes > MAX_RESULT_BYTES) { tooBig = true; try { child.kill('SIGKILL'); } catch { /* 已經死了 */ } }
    });
    child.stderr.on('data', (b) => { err += String(b).slice(0, 2000); });

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      // spawn 本身失敗（execPath 不對、fd 用盡…）＝我們的問題，不是使用者的檔案有問題
      reject(Object.assign(new Error(`伺服器暫時無法解析${fileLabel(kind)}，請稍後再試`),
        { status: 500, code: 'pdf_isolate_spawn_failed', cause: e }));
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (tooBig) {
        return reject(Object.assign(
          new Error(`這份${fileLabel(kind)}解析出來的內容太多，無法安全處理。請確認這是一份正常的對帳單。`),
          { status: 400, code: 'pdf_result_too_large' }));
      }
      // ⚠️ **沒有 stdout 不等於「使用者的檔案太貴」**（Codex #350 r1 Medium）：child 入口打錯、
      //    相依壞掉、程式例外一樣沒有 stdout，全判 400 會**責怪使用者並藏起部署／程式故障**
      //   （實測把 child 路徑改成不存在，得到「這份 PDF 需要的資源超過上限」）。
      //    ⇒ 只有**確認是資源或逾時**才 400，其餘一律 500（真正原因進伺服器日誌）。
      // ⚠️ 逾時要**優先於**「有沒有輸出」（Codex #551 r1 Medium）：被逾時殺掉時 stdout 常常已經有半截垃圾，
      //    原本只看 `!out` 會把它判成「輸出壞掉」（500 bad_output）——逾時才是真原因，而且那是使用者檔案的問題（400）。
      if (!out || killedByTimeout) {
        const detail = `signal=${signal} code=${code} stderr=${err.slice(0, 300)} partialOut=${out.length}`;
        const oomMarks = /heap out of memory|allocation failure|Allocation failed|out of memory/i;
        const resourceKilled = killedByTimeout
          || signal === 'SIGABRT' || signal === 'SIGKILL' || code === 134
          || oomMarks.test(err);
        if (!resourceKilled) {
          console.error('[pdf-isolate] 子行程異常結束（非資源上限）：', detail);
          return reject(Object.assign(new Error(`伺服器暫時無法解析${fileLabel(kind)}，請稍後再試`),
            { status: 500, code: 'pdf_isolate_child_failed', cause: detail }));
        }
        return reject(Object.assign(
          new Error(killedByTimeout
            ? `這份${fileLabel(kind)}解析太久（超過時間上限），已停止。請確認這是一份正常的對帳單。`
            : `這份${fileLabel(kind)}需要的資源超過上限，無法解析。`
              + '請確認這是一份正常的對帳單；如果它真的很大，請改用該期單獨的帳單檔。'),
          { status: 400, code: killedByTimeout ? 'pdf_timeout' : 'pdf_resource_exhausted', cause: detail }));
      }
      /** @type {any} */
      let parsed;
      try { parsed = JSON.parse(out); }
      catch {
        return reject(Object.assign(new Error(`伺服器暫時無法解析${fileLabel(kind)}，請稍後再試`),
          { status: 500, code: 'pdf_isolate_bad_output' }));
      }
      // ⚠️ **子行程的診斷代碼要進日誌**（Codex #538 r3 High）：子行程的 stderr 只進上面那個私有字串，
      //    而「取消失敗但原錯照樣回得去」會走下面的 parsed 4xx 分支 ⇒ 那條路在 HOSTED 完全靜默，
      //    偏偏它正是本層最需要聽見的（靜靜失效比沒有護欄更糟）。
      //    ⚠️ 只記**封閉集合的代碼**（`lib/parse-limits.js` 的 `PARSE_DIAG`），不轉印 stderr
      //    ——那會把 PDF 內容（金額、帳號）帶進日誌。非字串或超量一律丟掉，不讓子行程決定日誌長什麼樣。
      const diag = Array.isArray(parsed.diag)
        ? parsed.diag.filter((/** @type {any} */ d) => typeof d === 'string' && KNOWN_DIAG.has(d)).slice(0, 8)
        : [];
      if (diag.length) console.error('[pdf-isolate] 子行程診斷：', diag.join(','));
      // 抽取器丟的錯要**原味還原**（訊息與 status 都是給使用者看的）
      if (!parsed.ok) {
        const st = Number(parsed.status) || 500;
        // 5xx＝我們的問題：真正原因只進伺服器日誌，不吐給瀏覽器（比照 SEC 服務的錯誤歸因）
        if (st >= 500) console.error('[pdf-isolate] 子行程回報內部錯誤：', String(parsed.detail || parsed.message).slice(0, 300));
        return reject(Object.assign(new Error(String(parsed.message || '解析失敗')),
          { status: st, ...(parsed.code ? { code: parsed.code } : {}) }));
      }
      // ⚠️ 契約是 `result`（任意 JSON），不是 `lines`：PDF 抽取回列陣列、XLSX 回
      //    `{rows, allText}`。寫死 `lines` 的話新種類只會拿到 undefined、而且是靜默的。
      resolve(parsed.result);
    });

    child.stdin.on('error', () => { /* 子行程先死時 EPIPE，close 那邊會處理 */ });
    // stdin 協定：首行 JSON 標頭（含 password）＋換行＋base64 內容
    child.stdin.end(`${JSON.stringify({ password: password || '' })}\n${Buffer.from(data).toString('base64')}`);
  });
}

/**
 * 讀 XLSX——**HOSTED 走子行程、LOCAL 直接跑**（取代原本手寫的 ZIP 掃描牆）。
 * @param {(d: Uint8Array) => {rows: any[][], allText: string}} inProcess LOCAL 走的原函式
 * @param {Uint8Array} data @returns {Promise<{rows: any[][], allText: string}>}
 */
export async function extractXlsxIsolated(inProcess, data) {
  // XLSX 沒有密碼；其餘與 PDF 完全同一條路（同一個佇列、同一套錯誤歸因、同一個逾時）。
  if (!isHosted()) return inProcess(data);
  return throughPdfQueue(() => runInChild('xlsx', data, undefined));
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
