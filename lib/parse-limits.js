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
import { inflateRawSync } from 'node:zlib';

/** PDF 頁數上限。 */
export const MAX_PDF_PAGES = 200;
/** 整份 PDF 的文字節點總數上限（防「頁數不多但每頁塞十萬個字元節點」）。 */
export const MAX_PDF_TEXT_ITEMS = 300_000;
/**
 * IB Flex XML 的原始字元數上限（fast-xml-parser 解析前先擋）。
 *
 * ⚠️ **2026-07-28 從 40MB 降到 12MB**（Codex 收官審查 #1 引出的實測）。
 *    40MB 這個數字當初是憑「XML 展開成物件是原文數倍」的直覺訂的，沒有任何量測背書。
 *    實測（真實 IB Flex 排版，Trade 帶 50 個屬性，`--max-old-space-size=400`）：
 *
 *      12 MB → 峰值 RSS 254 MB
 *      24 MB → 峰值 RSS 387 MB
 *      40 MB → **行程直接死（OOM）**
 *
 *    也就是說**舊上限本身就是死亡線**：一份完全合法、完全被列數牆數到的報表
 *    （38,805 筆 Trade，離 50,000 的列數上限還很遠）就足以打死 Render 的 512MB 單一行程。
 *    Codex 說的「白名單漏了標籤」是真的，但**把更多標籤加進白名單修不好記憶體**——
 *    真正的病是這個數字。
 *
 *    12MB 怎麼來的：目標是把「解析多出來的記憶體」壓在 150MB 以內
 *    （Render 512MB − app 底噪約 148MB，還要留給同時進來的其他請求）。
 *    實測斜率約每 1MB XML 吃 12MB RSS → 150 ÷ 12 ≈ 12.5MB。
 *
 *    ⚠️ **已知代價**：重度交易者的 365 天報表可能超過 12MB，會被要求縮短期間分批同步。
 *    這是刻意的取捨——「同步失敗但有明確指示」遠好過「全站被打掛」。
 */
export const MAX_IB_XML_CHARS = 12 * 1024 * 1024;
/**
 * 整份 XML 的**元素總數**上限。
 *
 * 為什麼位元組上限不夠（實測，同樣 12MB）：
 *      真實 IB 排版   18,289 個元素 → 254 MB
 *      極小元素 `<Z/>` 3,145,728 個 → **472 MB**
 *    同樣的位元組數，元素多寡讓峰值差了將近兩倍——**兩道牆量的是不同的東西，缺一不可**。
 *
 * 而且這一道是**不分標籤**的：`IB_ROW_TAGS` 那份白名單只數四種標籤，
 * IB 官方還有 CorporateAction／Transfer／InterestAccrual 等十幾種區段完全不受約束
 * （Codex #1 實測：50,001 筆 `<CorporateAction/>` 原封不動通過）。
 * 改成數總元素數之後，**任何未來新增的 Flex 區段自動被涵蓋**，不必再維護白名單。
 *
 * 50 萬怎麼來的：實測 50 萬個極小元素 → 188MB（約比底噪多 83MB），是安全水位；
 * 100 萬 → 256MB 就開始逼近。對照組：真實 12MB 報表只有 18,289 個元素＝**27 倍餘裕**。
 */
export const MAX_IB_XML_ELEMENTS = 500_000;
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
/**
 * 數整份 XML 的元素總數（開標籤的個數）。線性掃描、不用正規表示式（沒有回溯爆炸風險）。
 * 只認 `<` 後面接字母的位置——`</close>`、`<?xml`、`<!--` 都不算。
 * @param {string} xml @returns {number}
 */
export function countXmlElements(xml) {
  let n = 0;
  for (let i = 0; i < xml.length; i++) {
    if (xml.charCodeAt(i) !== 60) continue;          // '<'
    const c = xml.charCodeAt(i + 1);
    // A-Z(65-90) / a-z(97-122) / '_'(95)：XML 名稱的合法開頭
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) n++;
  }
  return n;
}

/**
 * 元素總數上限——**與標籤名無關**，所以任何未來新增的 Flex 區段自動被涵蓋。
 * @param {string} xml
 */
export function assertXmlElementLimit(xml) {
  const n = countXmlElements(xml);
  if (n > MAX_IB_XML_ELEMENTS) {
    throw Object.assign(
      new Error(`這份 IB 報表的內容太多（${n.toLocaleString()} 個項目，上限 ${MAX_IB_XML_ELEMENTS.toLocaleString()}）。` +
        '請把 Flex Query 的期間縮短，分批同步。'),
      { status: 400, code: 'ib_too_many_elements' });
  }
  return n;
}

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

// ============================================================================
// XLSX（信用卡帳單）的資源上限 — 2026-07-28
// ============================================================================
//
// 為什麼 XLSX 需要**自己一套**、不能沿用「檔案大小上限」：實測（八個 agent 分頭量，
// 每個數字都有可重跑的腳本）——**檔案大小完全預測不了解析成本**：
//
//   真實台新帳單    18.8 KB → 15 毫秒、976 格            （對照組）
//   謊報範圍炸彈     1.9 KB → **150 秒還沒跑完**、CPU 100%
//   預先配置炸彈     1.5 KB → **RSS 1 GB**
//   多工作表炸彈     3.2 MB → 44 秒、1113 MB
//   壓縮炸彈         1.0 MB → 1732 MB（壓縮比 ~1027:1）
//
// 一份 1.5 KB 的合法 .xlsx 就能打垮 Render 的 512MB／單一行程。
// **「15MB body 上限」與「解壓後大小上限」兩種牆都擋不到它們**，因為攻擊檔小得可笑。
//
// SheetJS 有三個互相獨立的耗盡點，分佈在**兩個時機**，所以要兩段牆：
//   ① `XLSX.read` 之前 → 自己掃 ZIP：條目數、以及**實際解壓出來多大**
//   ② `XLSX.read` 之後、`sheet_to_json` 之前 → 逐工作表檢查**宣告的儲存格範圍**
//
// ⚠️ **一個字都不要相信 ZIP 標頭宣告的解壓後大小**。第一版的設計就是加總那個欄位，
//    被兩個獨立的對抗 agent 用同一招破掉：把 local(+22) 與 central(+24) 兩邊都宣告成 0，
//    牆算出「總共 0 bytes」放行，SheetJS 卻照樣把它整包解開。
//    所以這裡**真的去解壓**（`inflateRaw` 帶 maxOutputLength），超標就當場停——
//    工作量有上界，而且量到的是事實，不是攻擊者說的話。

/** 一份 xlsx 裡最多幾個 ZIP 條目。正常帳單 10 個；5000 張工作表要 5.7 秒（read 對表數是 O(N²)）。 */
export const MAX_XLSX_ZIP_ENTRIES = 64;
/**
 * 整份 xlsx **實際**解壓出來的總位元組上限。
 * 推導：目標是把 `XLSX.read` 的峰值壓在 ~150MB 以內（Render 512MB 扣掉 app 底噪與其他請求）。
 * 實測 SheetJS 讀進來的物件約是 XML 原文的 8–12 倍，所以 16MB × ~10 ≈ 160MB。
 * 對照組：真實帳單解壓後 0.05 MB ＝ **320 倍的誤殺餘裕**。
 */
export const MAX_XLSX_UNZIPPED_BYTES = 16 * 1024 * 1024;
/**
 * 單一工作表「宣告的儲存格數」（列 × 欄）上限。
 * 這個數字就是 `sheet_to_json` 迴圈的**確切**上界（它拿 `ws['!ref']` 當界線），不是估計值。
 * 對照組：真實帳單 `A1:H122` ＝ 976 格。攻擊 `A1:XFD1048576` ＝ 1.72e10 格。
 * 訂 20 萬：對正常值有 200 倍餘裕、對攻擊值有 8 萬倍餘裕，中間怎麼抓都不會誤殺。
 */
export const MAX_XLSX_SHEET_CELLS = 200_000;

/** 超標一律用同一種錯誤形狀（比照 assertPageLimit）：400 ＋ 使用者看得懂「該做什麼」。 @param {string} msg @param {string} code */
function xlsxTooBig(msg, code) {
  return Object.assign(new Error(msg), { status: 400, code });
}

/**
 * 掃一份 xlsx（＝ZIP）的外殼：條目數 ＋ **實際**解壓後總大小。**在 `XLSX.read` 之前跑**。
 *
 * 讀的是每個條目的 local file header，不看中央目錄——因為我們只用它定位資料、不採信它報的大小。
 * 遇到 data descriptor（bit 3，壓縮大小寫在資料後面）就無法安全地往下找，直接拒收：
 * 正常的 xlsx 產生器不會這樣寫，而「解析不了的東西」不該放行。
 * @param {Uint8Array} data
 */
export function assertXlsxShell(data) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let off = 0, entries = 0, totalOut = 0;
  const remaining = () => MAX_XLSX_UNZIPPED_BYTES - totalOut;

  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    if (++entries > MAX_XLSX_ZIP_ENTRIES) {
      throw xlsxTooBig(
        `這份 Excel 的內部結構太複雜（超過 ${MAX_XLSX_ZIP_ENTRIES} 個部件），無法安全解析。` +
        '正常的帳單檔只有十個左右——請確認下載到的是台新官網的「信用卡明細」。',
        'xlsx_too_many_entries');
    }
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    if (flags & 0x08) {
      throw xlsxTooBig('這份 Excel 用了我們不支援的壓縮寫法（streaming），無法安全解析。', 'xlsx_streaming_entry');
    }
    // ⚠️ **宣告值與實際值要各查一次，方向相反**（兩次都是實測逼出來的）：
    //    ・宣告「很大」→ 一定要擋。SheetJS 會**照宣告值預先配置緩衝區**，就算真實內容只有幾十 bytes。
    //      實測：一份 1.4KB 的檔宣告 400MB → 峰值 RSS 694MB，超過 Render 的 512MB。
    //      這一條只看宣告值，因為受害的正是「相信宣告值」這個行為本身。
    //    ・宣告「很小」（含 0）→ **完全不能信**。兩個獨立的對抗 agent 都用這招破過第一版設計：
    //      local(+22) 與 central(+24) 兩邊都宣告 0，加總是 0 就放行，SheetJS 卻照樣整包解開。
    //      所以真實大小一律**自己解壓量**（見下），不採信任何宣告值。
    const declared = buf.readUInt32LE(off + 22);
    if (declared > MAX_XLSX_UNZIPPED_BYTES) {
      throw xlsxTooBig(
        `這份 Excel 宣稱自己解開之後有 ${Math.round(declared / 1024 / 1024)} MB，` +
        '解析它會把伺服器的記憶體吃光。請確認下載到的是台新官網的「信用卡明細」。',
        'xlsx_declared_size_too_large');
    }
    const start = off + 30 + nameLen + extraLen;
    if (start + compSize > buf.length) break;   // 結構壞掉：交給 SheetJS 去回報格式錯誤
    const raw = buf.subarray(start, start + compSize);
    // ⚠️ 這裡是整段設計的核心：**真的解壓**，用 maxOutputLength 當閘門。
    //    超過就 throw、當場停——工作量有上界，而且量到的是事實而不是宣告值。
    try {
      totalOut += method === 0 ? raw.length : inflateRawSync(raw, { maxOutputLength: Math.max(1, remaining()) }).length;
    } catch {
      throw xlsxTooBig(
        `這份 Excel 解開之後太大（超過 ${Math.round(MAX_XLSX_UNZIPPED_BYTES / 1024 / 1024)} MB），` +
        '解析它會把伺服器的記憶體吃光。請確認檔案沒有損壞，或改用 PDF 版帳單。',
        'xlsx_unzipped_too_large');
    }
    if (totalOut > MAX_XLSX_UNZIPPED_BYTES) {
      throw xlsxTooBig(
        `這份 Excel 解開之後太大（超過 ${Math.round(MAX_XLSX_UNZIPPED_BYTES / 1024 / 1024)} MB），` +
        '解析它會把伺服器的記憶體吃光。請確認檔案沒有損壞，或改用 PDF 版帳單。',
        'xlsx_unzipped_too_large');
    }
    off = start + compSize;
  }
  return { entries, unzippedBytes: totalOut };
}

/**
 * 檢查**已經讀進來**的活頁簿：每張工作表宣告的儲存格數。**在 `sheet_to_json` 之前跑**。
 *
 * 為什麼這道非有不可：`sheet_to_json` 的迴圈上界就是 `ws['!ref']`，而 `!ref` 直接抄自
 * 檔案裡的 `<dimension>`，SheetJS **完全不檢查上界**（連 Excel 的 1048576 都不擋）。
 * 一份 1.9KB、只有一格資料的檔可以宣告 1.72e10 格 → 純 CPU 空轉、事件圈鎖死數十分鐘。
 * 實測它不會 OOM、行程不會自己死，所以**沒有任何既有的記憶體上限救得了**。
 *
 * ⚠️ 逐**每一張**工作表檢查，不是只看第一張：`xlsxAllText` 會遍歷全部工作表，
 *    只看第一張的話，炸彈藏在第二張就繞過去了。
 * @param {any} wb 由 `XLSX.read` 產生的活頁簿 @param {any} XLSXUtils `XLSX.utils`
 */
export function assertXlsxSheetRanges(wb, XLSXUtils) {
  for (const name of wb?.SheetNames || []) {
    const ws = wb.Sheets?.[name];
    const ref = ws?.['!ref'];
    if (!ref) continue;
    const r = XLSXUtils.decode_range(ref);
    const rows = r.e.r - r.s.r + 1;
    const cols = r.e.c - r.s.c + 1;
    if (rows * cols > MAX_XLSX_SHEET_CELLS) {
      throw xlsxTooBig(
        `這份 Excel 宣告的表格範圍太大（${rows} 列 × ${cols} 欄），解析它會讓伺服器停止回應。` +
        '正常的信用卡帳單只有幾百列——請確認下載到的是台新官網的「信用卡明細」。',
        'xlsx_sheet_range_too_large');
    }
  }
}
