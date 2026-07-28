// @ts-check
// 解析器資源上限＋slowloris 逾時的考題（可用性第一層，2026-07-28）。
//
// 為什麼需要這一層（上傳大小限制已經有了還不夠）：**檔案小不代表解析便宜**。
// 一份 200KB 的 PDF 可以有幾萬頁、或幾十萬個文字節點；15MB 的 XML 展開成物件可能要幾百 MB。
// 擋在「送進解析器之前」才有意義。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PDF_PAGES, MAX_PDF_TEXT_ITEMS, MAX_IB_ROWS,
  assertPageLimit, countTextItems, assertXmlSize, assertRowLimit,
  applyHostedTimeouts, HOSTED_HEADERS_TIMEOUT_MS, HOSTED_REQUEST_TIMEOUT_MS, HOSTED_KEEPALIVE_TIMEOUT_MS,
} from '../lib/parse-limits.js';

test('上限訂在「比真實帳單大一個數量級」——不可以訂到會誤殺正常對帳單', () => {
  // 真實：信用卡帳單 2–6 頁、銀行綜合對帳單 6–15 頁、證券對帳單 2–10 頁。
  // 這幾條斷言是「別把上限調太小」的絆索：有人想收緊時會先撞到這裡並讀到理由。
  assert.ok(MAX_PDF_PAGES >= 100, `頁數上限 ${MAX_PDF_PAGES} 太小，一次匯一整年就會被誤殺`);
  assert.ok(MAX_PDF_TEXT_ITEMS >= 100_000);
  assert.ok(MAX_IB_ROWS >= 10_000, 'IB 年度報表的成交紀錄可能上萬筆');
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
  assert.equal(blocked, true, '單頁不超標但總量爆掉＝正是壓縮炸彈的形狀，必須擋得到');
  assert.equal(countTextItems(0, 1_000, 'x'), 1_000, '正常量要原樣累加回傳');
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
  // 但也不能緊到誤殺正當的大上傳（50MB 備份走比較慢的線路）
  assert.ok(applied.requestTimeout >= 60_000, `requestTimeout ${applied.requestTimeout}ms 太緊，會誤殺大備份還原`);
});
