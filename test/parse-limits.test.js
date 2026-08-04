// @ts-check
// 解析器資源上限＋slowloris 逾時的考題（可用性第一層，2026-07-28）。
//
// 為什麼需要這一層（上傳大小限制已經有了還不夠）：**檔案小不代表解析便宜**。
// 一份 200KB 的 PDF 可以有幾萬頁、或幾十萬個文字節點；15MB 的 XML 展開成物件可能要幾百 MB。
// 擋在「送進解析器之前」才有意義。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PDF_PAGES, MAX_PDF_TEXT_ITEMS, MAX_IB_ROWS, MAX_IB_XML_BYTES, MAX_SEC_RESPONSE_BYTES,
  MIN_UPLOAD_BYTES_PER_SEC,
  assertPageLimit, countTextItems, assertXmlSize, assertRowLimit,
  readCappedText, countXmlRows, assertXmlRowLimits,
  applyHostedTimeouts, HOSTED_HEADERS_TIMEOUT_MS, HOSTED_REQUEST_TIMEOUT_MS, HOSTED_KEEPALIVE_TIMEOUT_MS,
} from '../lib/parse-limits.js';

test('上限訂在「比真實帳單大一個數量級」——不可以訂到會誤殺正常對帳單', () => {
  // 真實：信用卡帳單 2–6 頁、銀行綜合對帳單 6–15 頁、證券對帳單 2–10 頁。
  // 這幾條斷言是「別把上限調太小」的絆索：有人想收緊時會先撞到這裡並讀到理由。
  assert.ok(MAX_PDF_PAGES >= 100, `頁數上限 ${MAX_PDF_PAGES} 太小，一次匯一整年就會被誤殺`);
  assert.ok(MAX_PDF_TEXT_ITEMS >= 100_000);
  assert.ok(MAX_IB_ROWS >= 10_000, 'IB 年度報表的成交紀錄可能上萬筆');
});

test('SEC 回應上限：25MiB 的資源預算只在 parse-limits 宣告', () => {
  assert.equal(MAX_SEC_RESPONSE_BYTES, 25 * 1024 * 1024,
    '這是正式行為；要調整必須帶新的記憶體量測，不可在服務層順手改掉');
  assert.ok(MAX_SEC_RESPONSE_BYTES >= 15 * 1024 * 1024,
    '正常 Company Facts 可達約 15MiB，上限太小會讓合法公司永遠無法更新');
});

test('頁數：正常份數放行，超標丟 400＋說得出原因', () => {
  assert.doesNotThrow(() => assertPageLimit(15, '銀行對帳單 PDF'));
  assert.doesNotThrow(() => assertPageLimit(MAX_PDF_PAGES, '銀行對帳單 PDF'), '剛好等於上限要放行');
  let err = /** @type {any} */ (null);
  try { assertPageLimit(MAX_PDF_PAGES + 1, '銀行對帳單 PDF'); } catch (e) { err = e; }
  assert.ok(err, '超標必須擋下');
  assert.equal(err.status, 400, '這是使用者層的錯（檔案不對），不是伺服器內部錯誤');
  assert.match(err.message, /銀行對帳單 PDF/, '要講清楚是哪一種檔案');
  assert.match(err.message, /正常的對帳單不會這麼多頁/, '要讓使用者知道下一步做什麼');
});

test('文字節點：逐頁累加，跨頁加總才擋得到（等整份讀完再檢查就沒有意義了）', () => {
  let n = 0;
  // 模擬 10 頁、每頁 5 萬個節點：單頁都沒超標，但加起來遠超
  let blocked = false;
  try {
    for (let i = 0; i < 10; i++) n = countTextItems(n, 50_000, '信用卡帳單 PDF');
  } catch { blocked = true; }
  assert.equal(blocked, true, '單頁不超標但總量爆掉＝**文字節點炸彈**的形狀，必須擋得到');
  assert.equal(countTextItems(0, 1_000, 'x'), 1_000, '正常量要原樣累加回傳');
});

test('這兩道牆**本來就摸不到**壓縮炸彈——所以另外有隔離層（別把它們當成防好了）', () => {
  // 這一題的措辭 2026-07-29 改過。原本寫的是「⚠️ 已知未修」，並宣稱
  //   ①唯一有效的修法是「行程級隔離＋**硬性 RSS 上限**」
  //   ②中間方案 streamTextContent「實測零收益（640MB vs 640MB）」
  //   ③它「是唯一可能讓真實帳單安靜解析錯的改動」
  // **②③ 重新實測後都不成立**（見 test/pdf-isolate.test.js 與 lib/parse-limits.js 的
  // readPageTextCapped）：612→254、704→316，而且抽出來的欄位逐項相同。
  // ⚠️ 那句錯誤的宣稱**差點讓人跳過真正的修法**——文件裡過期或本來就錯的「實測結論」，
  //    比程式的 bug 更難發現，因為沒有人會去 review 一句註解。
  //
  // 這一題保留下來的價值不變：**這兩道牆的能力邊界要寫在會被讀到的地方**。
  // 它們擋的是「頁數多」與「文字節點多」，**不是**「解壓後很大」——
  // 後者由 `lib/pdf-isolate.js` 的行程隔離負責（HOSTED；LOCAL 是明知的取捨）。
  const 單頁 = 1, 節點數 = 1_000;
  assert.doesNotThrow(() => assertPageLimit(單頁, '銀行對帳單 PDF'),
    '壓縮炸彈的頁數是正常的——頁數牆摸不到它');
  assert.doesNotThrow(() => countTextItems(0, 節點數, '銀行對帳單 PDF'),
    '壓縮炸彈的節點數是正常的——節點牆也摸不到它');
});

test('IB 回應：宣告的 Content-Length 超標＝連 body 都不讀就擋（最便宜的那一刀）', async () => {
  let cancelled = false;
  const res = /** @type {any} */ ({
    headers: { get: (/** @type {string} */ k) => (k === 'content-length' ? String(MAX_IB_XML_BYTES + 1) : null) },
    body: { cancel: async () => { cancelled = true; } },
  });
  const err = await readCappedText(res).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '宣告 4GB 的回應必須當場擋下');
  assert.equal(err.status, 400);
  assert.equal(err.code, 'xml_too_large');
  assert.equal(cancelled, true, '要主動取消，不然連線會一直掛著');
});

test('IB 回應：**邊收邊數**——超過上限立刻停，不是整包收完才檢查', async () => {
  // 這一題釘住「檢查的時機」。用 res.text() 的話，是先把任意大小的回應整包放進記憶體，
  // assertXmlSize 才有機會看到它——那時記憶體早就吃下去了。
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024);          // 每塊 1MB
  const res = /** @type {any} */ ({
    headers: { get: () => null },                      // 故意不宣告 content-length（攻擊者當然不會宣告）
    body: (async function* () { for (;;) { pulled++; yield chunk; } })(),
  });
  const err = await readCappedText(res).then(() => null, (/** @type {any} */ e) => e);
  assert.ok(err, '無限長的回應必須被擋下（不然就是等 OOM）');
  assert.equal(err.code, 'xml_too_large');
  const capMb = MAX_IB_XML_BYTES / 1024 / 1024;
  assert.ok(pulled <= capMb + 2,
    `讀了 ${pulled}MB 才停，上限是 ${capMb}MB——「邊收邊數」沒有生效`);
});

test('IB 回應：正常大小照常讀回來，而且**吃掉 BOM**（res.text() 的語意，不吃會害 XML 解析失敗）', async () => {
  const xml = '<FlexQueryResponse/>';
  const bytes = new TextEncoder().encode('﻿' + xml);
  const res = /** @type {any} */ ({
    headers: { get: () => String(bytes.byteLength) },
    body: (async function* () { yield bytes; })(),
  });
  assert.equal(await readCappedText(res), xml, 'BOM 沒被吃掉——fast-xml-parser 會解不開');
});

test('IB 列數：在**原始 XML** 上數，且涵蓋 OpenPosition（以前完全沒數）', () => {
  assert.equal(countXmlRows('<Trade a="1"/><Trade\nb="2"/><Trade/>', 'Trade'), 3,
    '後面接空白／換行／斜線都要數到——只認 `<Trade ` 會在 IB 換排版時默默數不到');
  assert.equal(countXmlRows('<Trades><Trade/></Trades>', 'Trades'), 1, '容器標籤不可以被算進列數');
  assert.equal(countXmlRows('<Trades><Trade/></Trades>', 'Trade'), 1, '`<Trades>` 不可以被誤數成 Trade');

  const 持倉炸彈 = '<OpenPosition/>'.repeat(MAX_IB_ROWS + 1);
  let err = /** @type {any} */ (null);
  try { assertXmlRowLimits(持倉炸彈); } catch (e) { err = e; }
  assert.ok(err, '20 萬筆持倉以前完全沒被數到，暢行無阻');
  assert.match(err.message, /持倉/);
  assert.doesNotThrow(() => assertXmlRowLimits('<Trade/><OpenPosition/><CashTransaction/>'), '正常份數要放行');
});

test('requestTimeout：是「最大 body ÷ 最慢可接受上傳速度」推導出來的，不是憑感覺訂的', () => {
  // 舊值 120 秒配 50MB 上限＝隱形要求 437 KB/s（3.5 Mbit/s）。
  // 實測 300 KB/s 的上傳在 120.0 秒被切斷、只收到 36MB 回 408——**正當的大備份還原被誤殺**。
  const 最大備份 = 50 * 1024 * 1024;
  const 推導值秒 = 最大備份 / MIN_UPLOAD_BYTES_PER_SEC;
  assert.ok(HOSTED_REQUEST_TIMEOUT_MS / 1000 >= 推導值秒,
    `requestTimeout ${HOSTED_REQUEST_TIMEOUT_MS / 1000}s 小於推導值 ${Math.ceil(推導值秒)}s`
    + `（50MB ÷ ${MIN_UPLOAD_BYTES_PER_SEC / 1024}KiB/s）——會誤殺走慢線路的大備份還原`);
  assert.ok(MIN_UPLOAD_BYTES_PER_SEC <= 256 * 1024,
    '「最慢可接受上傳速度」訂太高＝變相把行動網路使用者排除在外');
  assert.ok(HOSTED_HEADERS_TIMEOUT_MS < HOSTED_REQUEST_TIMEOUT_MS,
    'headersTimeout 必須小於 requestTimeout，否則 Node 會用大的那個當實際上限');
});

test('IB XML：擋在 parse 之前（展開成物件通常是原文的數倍大）', () => {
  assert.doesNotThrow(() => assertXmlSize('<FlexQueryResponse/>'));
  let err = /** @type {any} */ (null);
  try { assertXmlSize('x'.repeat(41 * 1024 * 1024)); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.status, 400);
  assert.match(err.message, /縮短再同步/, '要給可操作的下一步');
});

test('IB 列數：超標**丟錯而不是截斷**（截斷會讓使用者以為同步完整，其實少了一段）', () => {
  assert.doesNotThrow(() => assertRowLimit(5_000, '成交紀錄'));
  let err = /** @type {any} */ (null);
  try { assertRowLimit(MAX_IB_ROWS + 1, '成交紀錄'); } catch (e) { err = e; }
  assert.ok(err, '靜默截斷是本專案的頭號禁忌——寧可拒絕並說原因');
  assert.match(err.message, /成交紀錄/);
  assert.match(err.message, /分批同步/);
});

test('slowloris：HOSTED 的連線逾時比 Node 預設緊得多，且三個都有設', () => {
  const server = /** @type {any} */ ({ headersTimeout: 60_000, requestTimeout: 300_000, keepAliveTimeout: 5_000 });
  const applied = applyHostedTimeouts(server);
  assert.equal(applied.headersTimeout, HOSTED_HEADERS_TIMEOUT_MS);
  assert.equal(applied.requestTimeout, HOSTED_REQUEST_TIMEOUT_MS);
  assert.equal(applied.keepAliveTimeout, HOSTED_KEEPALIVE_TIMEOUT_MS);
  // Node 預設：headersTimeout 60s／requestTimeout 300s——對「每幾秒滴一個位元組」太寬鬆
  assert.ok(applied.headersTimeout < 60_000, 'header 本來就該一次送完，不必給到一分鐘');
  assert.ok(applied.requestTimeout < 300_000);
  // 但也不能緊到誤殺正當的大上傳（50MB 備份走比較慢的線路）——實際的下限由上一題推導
  assert.ok(applied.requestTimeout >= 60_000, `requestTimeout ${applied.requestTimeout}ms 太緊，會誤殺大備份還原`);
});

test('三個 PDF 抽取器：上限 throw 的時候也要放掉 pdfjs 的資源（try/finally）', async () => {
  // ⚠️ 這一題不打真的 pdfjs（那要造 201 頁的 PDF，慢且脆）。它驗的是**原始碼的形狀**：
  //    `task.destroy()` 必須在 `finally` 裡。沒有 finally 的話，`assertPageLimit` 一 throw
  //    就跳過 destroy，pdfjs 的 worker 與已配置的頁面資源留著不放——
  //    「防資源耗盡」的那條路自己在漏資源，而且**只有被攻擊時才會發生**（正常檔案不會 throw）。
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const f of ['lib/statement.js', 'lib/bank-statement.js', 'lib/taishin-securities.js']) {
    const src = readFileSync(root + f, 'utf8');
    assert.match(src, /}\s*finally\s*{\s*\n\s*await task\.destroy\(\);\s*\n\s*}/,
      `${f} 的 task.destroy() 不在 finally 裡——上限 throw 時會漏掉 pdfjs 的資源`);
  }
});
