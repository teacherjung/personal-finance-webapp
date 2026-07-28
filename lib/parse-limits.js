// @ts-check
// 解析器資源上限（可用性第一層，2026-07-28；C0 威脅模型「解析器 DoS」那一列）。
//
// 白話：三個 PDF 解析器與 IB 的 XML 解析器，都是「拿一份檔案、跑很久、吃很多記憶體」的操作。
// 上傳大小已經被 `lib/http-body.js` 擋在 15MB／50MB，但**檔案小不代表解析便宜**——
// 一份 200KB 的 PDF 可以有幾萬頁、或幾十萬個文字節點（壓縮炸彈），解析時把記憶體吃光。
//
// **兩種模式都套**（與速率限制不同）：這一類防的是「畸形／惡意的檔案」，而你在本機一樣會
// 從銀行或券商下載檔案。這與階段四 B 的異常輸入防線同一個邏輯（那一層 LOCAL 也套）。
//
// 上限訂在「比真實帳單大一個數量級」：
//   真實信用卡帳單 ≈ 2–6 頁、銀行綜合對帳單 ≈ 6–15 頁、證券對帳單 ≈ 2–10 頁。
//   200 頁＝就算你一次匯一整年也綽綽有餘，但擋得住「幾萬頁」那種。
// **超過上限＝明確拒絕並說原因**（不是靜默截斷——截斷會讓你以為匯完了，其實少了半年）。

/** PDF 頁數上限。 */
export const MAX_PDF_PAGES = 200;
/** 整份 PDF 的文字節點總數上限（防「頁數不多但每頁塞十萬個字元節點」）。 */
export const MAX_PDF_TEXT_ITEMS = 300_000;
/** IB Flex XML 的原始字元數上限（fast-xml-parser 解析前先擋）。 */
export const MAX_IB_XML_CHARS = 40 * 1024 * 1024;
/** 一份報表可接受的最大交易列數（IB 成交紀錄／現金交易）。 */
export const MAX_IB_ROWS = 50_000;
/** 同一個上限的「位元組」版本：HTTP 回應是先有位元組才有字串，要擋就得擋在解碼之前。
 * UTF-8 的位元組數永遠 ≥ 字元數，所以用同一個數字當位元組上限只會更嚴、不會放水。 */
export const MAX_IB_XML_BYTES = MAX_IB_XML_CHARS;

/**
 * 檢查頁數。超過就 throw 帶 400 的錯（＝使用者層錯誤，路由會回原味訊息）。
 * @param {number} pages @param {string} what 檔案種類（給訊息用）
 */
export function assertPageLimit(pages, what) {
  if (Number(pages) > MAX_PDF_PAGES) {
    throw Object.assign(
      new Error(`${what}有 ${pages} 頁，超過可解析上限 ${MAX_PDF_PAGES} 頁。請確認檔案正確；正常的對帳單不會這麼多頁。`),
      { status: 400, code: 'pdf_too_many_pages' });
  }
}

/**
 * 累加文字節點數並在超標時 throw。回傳新的累計值，呼叫端自己保存。
 * ⚠️ 要在**逐頁迴圈裡**呼叫——等整份讀完才檢查就沒有意義了（記憶體早就吃光）。
 * @param {number} sofar @param {number} add @param {string} what @returns {number}
 */
export function countTextItems(sofar, add, what) {
  const total = sofar + add;
  if (total > MAX_PDF_TEXT_ITEMS) {
    throw Object.assign(
      new Error(`${what}的內容量異常龐大（文字節點超過 ${MAX_PDF_TEXT_ITEMS.toLocaleString('en-US')} 個），已停止解析以免拖垮服務。請確認檔案正確。`),
      { status: 400, code: 'pdf_too_many_items' });
  }
  return total;
}

/**
 * IB Flex XML 的原始大小上限。
 * ⚠️ 為什麼不靠 body 上限就好：XML 解析後的物件通常是原文的數倍大，
 * 15MB 的 XML 展開成物件可能要幾百 MB——**擋在解析之前**才有意義。
 * @param {string} xml
 */
export function assertXmlSize(xml) {
  const len = String(xml || '').length;
  if (len > MAX_IB_XML_CHARS) {
    throw Object.assign(
      new Error(`IBKR 報表過大（${Math.round(len / 1024 / 1024)} MB），超過可解析上限。請把 Flex Query 的期間縮短再同步。`),
      { status: 400, code: 'xml_too_large' });
  }
}

/**
 * 列數上限（IB 成交紀錄／現金交易）。**只在超過時 throw**，不截斷——
 * 截斷會讓使用者以為同步完整，其實少了一段（靜默失真是本專案的頭號禁忌）。
 * @param {number} rows @param {string} what
 */
export function assertRowLimit(rows, what) {
  if (Number(rows) > MAX_IB_ROWS) {
    throw Object.assign(
      new Error(`IBKR 報表的${what}有 ${rows} 筆，超過單次可處理上限 ${MAX_IB_ROWS.toLocaleString('en-US')} 筆。請把 Flex Query 的期間縮短、分批同步。`),
      { status: 400, code: 'ib_too_many_rows' });
  }
}

/** 回應過大的統一錯誤（400＝使用者層，路由會回原味訊息）。 @param {number} bytes */
function xmlTooLarge(bytes) {
  return Object.assign(
    new Error(`IBKR 報表過大（${Math.round(bytes / 1024 / 1024)} MB），超過可解析上限。請把 Flex Query 的期間縮短再同步。`),
    { status: 400, code: 'xml_too_large' });
}

/**
 * 把 fetch 的回應讀成字串，**邊收邊數、超標立刻中止**。
 *
 * ⚠️ 為什麼不能用 `await res.text()`（原本就是）：那會把「任意大小」的回應先整包放進記憶體，
 * 之後 `assertXmlSize` 才有機會看到它——**檢查得太晚**。實測 1GB 的回應：
 *   `res.text()` → 行程 RSS 1.8GB，而且丟出來的是 V8 的
 *                  「Cannot create a string longer than 0x1fffffe8 characters」（沒有 status、沒有原因）
 *   本函式       → 56ms、RSS 157MB、乾淨的 400
 *
 * ⚠️ 解碼要用 `new TextDecoder()`：`res.text()` 的語意是「一律 UTF-8 解碼**並吃掉開頭的 BOM**」。
 * `Buffer.concat(...).toString('utf8')` 不會吃掉 BOM，BOM 留在字串最前面會害 XML 解析失敗。
 *
 * @param {any} res @param {AbortController=} ctrl 有的話超標時順便中斷連線
 * @returns {Promise<string>}
 */
export async function readCappedText(res, ctrl) {
  if (!res.body) return '';
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IB_XML_BYTES) {   // 最便宜的那一刀：連 body 都不用讀
    await res.body.cancel().catch(() => {});
    throw xmlTooLarge(declared);
  }
  /** @type {Uint8Array[]} */
  const chunks = [];
  let bytes = 0;
  for await (const chunk of /** @type {any} */ (res.body)) {
    bytes += chunk.byteLength;
    if (bytes > MAX_IB_XML_BYTES) { ctrl?.abort(); throw xmlTooLarge(bytes); }
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** IB Flex 報表裡「一列資料」的標籤，與它在錯誤訊息裡的名字。
 * 只列**會隨期間線性長大**的節點——這些才是「報表變大」的來源。 */
const IB_ROW_TAGS = /** @type {[string, string][]} */ ([
  ['Trade', '成交紀錄'],
  ['CashTransaction', '現金交易'],
  ['OpenPosition', '持倉'],
  ['CashReportCurrency', '現金彙總列'],
]);

/**
 * 在原始 XML 字串上數列數。`<Trade` 後面不一定是空白（也可能換行或直接 `/>`），
 * 所以用字元類別 `[\s/>]` 收尾——只認 `<Trade ` 會在 IB 換一種排版時**默默數不到**，
 * 上限就等於沒設（靜默失真是本專案的頭號禁忌）。
 * `<Trades>` 這種容器標籤不會被誤數（`Trade` 之後是 `s`，不符合字元類別）。
 * @param {string} xml @param {string} name @returns {number}
 */
export function countXmlRows(xml, name) {
  const re = new RegExp(`<${name}[\\s/>]`, 'g');   // 線性掃描，沒有回溯爆炸的可能
  let n = 0;
  while (re.exec(xml) !== null) n++;
  return n;
}

/**
 * **在 parse 之前**用原始 XML 檢查列數上限。
 *
 * ⚠️ 為什麼不能等 `parser.parse()` 跑完再數（原本就是這樣）：
 *  ① fast-xml-parser 沒有串流模式，`parse()` 會把整份 XML 展開成 JS object——展開後通常是原文的數倍大，
 *     等我們拿到陣列 `.length` 時記憶體已經吃下去了（實測 38.5MB 的 XML → RSS 491MB）。
 *  ② 原本只數 `CashTransaction`／`Trade`，**`OpenPosition` 完全沒數**：20 萬筆持倉（20.7MB XML）暢行無阻。
 *  ③ 原本是**每份 statement 各自數**：10 份 × 各 3 萬筆 Trade ＝總量 30 萬筆，每一份都沒超過 5 萬，
 *     全部放行。這裡數的是**整份報表的總量**。
 * @param {string} xml
 */
export function assertXmlRowLimits(xml) {
  const s = String(xml || '');
  for (const [tag, what] of IB_ROW_TAGS) assertRowLimit(countXmlRows(s, tag), what);
}

// ---- 連線層逾時（slowloris 防線，2026-07-28）--------------------------------
// slowloris＝「慢速連線攻擊」：不送大量資料，而是**故意送得很慢**——宣告一個很大的
// Content-Length 卻每幾秒才滴一個位元組，或把 HTTP header 分成幾百次送。
// 每一條這種連線幾乎不花頻寬，卻會佔住伺服器一個連線與一份緩衝區；開幾百條就把服務癱瘓。
// Node 內建的 `headersTimeout`(60s)／`requestTimeout`(300s) 太寬鬆，HOSTED 收緊。
//
// ⚠️ **只收緊 HOSTED**：LOCAL 只聽 127.0.0.1、只有你自己在用，收緊只會在「上傳一份大備份
// 剛好硬碟很慢」時誤殺自己。

/** 送完 HTTP header 的寬限（秒→毫秒）。header 本來就該一次送完，20 秒非常寬鬆。
 * **這一條才是真正的 slowloris 防線**（把 header 拆成幾百次慢慢送）；它與 body 的傳輸速度無關，
 * 所以可以收得很緊而不會誤殺任何人。⚠️ 必須小於 requestTimeout，否則 Node 會用大的那個當實際上限。 */
export const HOSTED_HEADERS_TIMEOUT_MS = 20_000;

/** 我們願意支援的**最慢上傳速度**。requestTimeout 不該憑感覺訂，它是這個數字除出來的結果。
 * 200 KiB/s ≈ 1.6 Mbit/s ＝ 訊號不好的行動網路／飯店 Wi-Fi 大致的下限。 */
export const MIN_UPLOAD_BYTES_PER_SEC = 200 * 1024;

/**
 * 整個請求（含 body）送完的寬限。
 *
 * ⚠️ **這不是 idle timeout，是「收完整個 request 的總時間」**——連線全程都有資料在流也照殺。
 * 所以它其實是一條「隱形的最低上傳速度規定」：`最大 body ÷ requestTimeout`。
 * 舊值 120 秒配上 50MB 的備份上限＝要求持續 437 KB/s（3.5 Mbit/s）；實測 300 KB/s 的上傳
 *（50MB 需要 171 秒）在 **120.0 秒**被切斷、只收到 36MB 回 408——**正當的大備份還原被誤殺**。
 *
 * 新值＝`50MiB ÷ MIN_UPLOAD_BYTES_PER_SEC(200KiB/s)` ＝ 256 秒，取整到 270 秒（4.5 分）。
 * 放寬它為什麼可以接受：
 *  ① slowloris 的本體是 header，由 `HOSTED_HEADERS_TIMEOUT_MS`(20s) 擋著，不受影響。
 *  ② 會吃記憶體的大 body 端點在 HOSTED 都在 **authGate 之後**，未登入流量根本進不到 parser。
 *  ③ 再加上每帳號 5 分鐘 30 次的速率限制——**尖峰記憶體是「速率上限 × body 上限」決定的，
 *     跟 requestTimeout 無關**；放寬只延長「佔著連線」的時間，不會讓尖峰變高。
 *
 * 註：Node 是在 `connectionsCheckingInterval`（預設 30 秒）的巡邏裡才檢查，
 * 所以實際切斷落在 [270s, 300s) ——只會比帳面更寬鬆，不會更緊。
 */
export const HOSTED_REQUEST_TIMEOUT_MS = 270_000;
/** 閒置的 keep-alive 連線多久後關閉。 */
export const HOSTED_KEEPALIVE_TIMEOUT_MS = 10_000;

/**
 * 對 http.Server 套用 HOSTED 的連線逾時。**回傳實際套用的值供考題檢查**。
 * @param {any} server @returns {{headersTimeout: number, requestTimeout: number, keepAliveTimeout: number}}
 */
export function applyHostedTimeouts(server) {
  server.headersTimeout = HOSTED_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HOSTED_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = HOSTED_KEEPALIVE_TIMEOUT_MS;
  return {
    headersTimeout: server.headersTimeout,
    requestTimeout: server.requestTimeout,
    keepAliveTimeout: server.keepAliveTimeout,
  };
}
