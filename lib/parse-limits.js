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

// ---- 連線層逾時（slowloris 防線，2026-07-28）--------------------------------
// slowloris＝「慢速連線攻擊」：不送大量資料，而是**故意送得很慢**——宣告一個很大的
// Content-Length 卻每幾秒才滴一個位元組，或把 HTTP header 分成幾百次送。
// 每一條這種連線幾乎不花頻寬，卻會佔住伺服器一個連線與一份緩衝區；開幾百條就把服務癱瘓。
// Node 內建的 `headersTimeout`(60s)／`requestTimeout`(300s) 太寬鬆，HOSTED 收緊。
//
// ⚠️ **只收緊 HOSTED**：LOCAL 只聽 127.0.0.1、只有你自己在用，收緊只會在「上傳一份大備份
// 剛好硬碟很慢」時誤殺自己。

/** 送完 HTTP header 的寬限（秒→毫秒）。header 本來就該一次送完，20 秒非常寬鬆。 */
export const HOSTED_HEADERS_TIMEOUT_MS = 20_000;
/** 整個請求（含 body）送完的寬限。要容得下「50MB 備份走比較慢的線路」，所以給 120 秒（預設 300 秒）。 */
export const HOSTED_REQUEST_TIMEOUT_MS = 120_000;
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
