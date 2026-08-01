// @ts-check
// 大型請求分流考題：一般 API 要擋超大 body，但帳單與救援用備份還原不可一起被掐死。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';
import {
  installJsonBodyParsers, STATEMENT_JSON_POST_ROUTES,
  STATEMENT_FILE_POST_ROUTES, STATEMENT_ROWS_POST_ROUTES,
} from '../lib/http-body.js';

const TEST_STORE = join(tmpdir(), `finance-request-limits-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;

const largeText = 'x'.repeat(1_100_000);
const sendJson = (url, body, method = 'POST') => fetch(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

after(() => {
  server.close();
  for (const suffix of ['', '.bak', '-wal', '-shm']) {
    try { rmSync(TEST_STORE + suffix); } catch { /* 可能不存在 */ }
  }
});

test('一般 API 超過 1 MB：回 413 與可讀訊息', async () => {
  const response = await sendJson(`${base}/settings`, { note: largeText }, 'PUT');
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: '上傳內容太大，請縮小檔案或備份後再試' });
});

test('/api/import 可還原超過 1 MB 的完整備份', async () => {
  const exported = await (await fetch(`${base}/export`)).json();
  exported.transactions[0].note = largeText;

  const response = await sendJson(`${base}/import`, exported);
  assert.equal(response.status, 200, await response.text());

  const restored = await (await fetch(`${base}/export`)).json();
  assert.equal(restored.transactions[0].note.length, largeText.length, '大型備份內容要完整寫回，不可截斷');
});

// ⚠️ 這一題 2026-07-28 從「七個端點都可以超過 1MB」改成「**吃檔案的六個**可以、**吃列的一個**不行」。
//    （2026-07-29 更正註解：一度寫成「四個／三個」，那是按端點名字誤分類時的數字，
//     正式清單與這一題實際跑的都是六／一。Codex 定向複審抓到——這種數字對不上最容易
//     讓下一個人再照著錯的判準分一次。）
//    原因（Codex 收官審查 #10 引出的實測）：那一個只收「預覽已經解析好的列」，身上一個位元組的檔案
//    都沒有，卻跟吃 base64 PDF/XLSX 的端點共用 15MB 入口。而那些列寫進 kv 時會**放大約 3 倍**——
//    一個 15MB 的請求塞得下 261 列、落庫 44.9MB。這不是新增限制，是把混進群組的成員請出去。
test('吃檔案的六個端點可以超過 1 MB；只吃「已解析的列」的那一條不行', async () => {
  const parserApp = express();
  installJsonBodyParsers(parserApp);
  for (const route of STATEMENT_JSON_POST_ROUTES) {
    parserApp.post(route, (req, res) => res.json({ size: req.body.payload.length }));
  }

  const parserServer = parserApp.listen(0, '127.0.0.1');
  await once(parserServer, 'listening');
  const parserPort = /** @type {any} */ (parserServer.address()).port;

  try {
    // 吃 base64 檔案本體 → 需要大入口
    // ⚠️ 判準是「**它從 req.body 讀什麼**」，不是端點名字裡有沒有 import／apply
    //    （2026-07-29 自審抓到：我第一版照名字分類，把下面兩條 apply/import 誤放進 rows 組，
    //     結果連 LOCAL 的銀行／證券對帳單匯入都會在「按確認」那步被 413 打斷）。
    const filePaths = [
      '/api/statement/preview',              // req.body.data
      '/api/cards/card-1/statement/preview', // req.body.data
      '/api/bank-statement/preview',         // req.body.data
      '/api/bank-statement/apply',           // req.body.data ← 名字叫 apply，收的是檔案本體
      '/api/securities/preview',             // req.body?.file
      '/api/securities/import',              // req.body?.file ← 名字叫 import，收的是檔案本體
    ];
    // 只吃預覽產生的列 → 一般 1MB 就夠（真實帳單一次幾百列、幾十 KB，餘裕約 30 倍）
    const rowPaths = [
      '/api/cards/card-1/statement/import',  // req.body.transactions ← 唯一真的只吃列的
    ];
    assert.equal(filePaths.length + rowPaths.length, STATEMENT_JSON_POST_ROUTES.length,
      '端點清單與考題要同步（兩張清單合起來＝全集）');
    assert.equal(filePaths.length, STATEMENT_FILE_POST_ROUTES.length, '吃檔案的清單要同步');
    assert.equal(rowPaths.length, STATEMENT_ROWS_POST_ROUTES.length, '吃列的清單要同步');

    for (const path of filePaths) {
      const response = await sendJson(`http://127.0.0.1:${parserPort}${path}`, { payload: largeText });
      assert.equal(response.status, 200, `${path} 收的是檔案本體，不該套到一般 1 MB 上限`);
      assert.deepEqual(await response.json(), { size: largeText.length });
    }
    // ⚠️ 這一檔跑在 **LOCAL** 模式（沒設 NOTEASY_HOSTED），所以「吃列」那條**維持大入口**——
    //    1MB 只套 HOSTED（那條牆保護的是 Supabase 的容量，本機沒有那個問題）。
    //    v2 對兩種模式都套，破了「LOCAL byte-for-byte 等價」；Codex 定向複審抓到。
    for (const path of rowPaths) {
      const response = await sendJson(`http://127.0.0.1:${parserPort}${path}`, { payload: largeText });
      assert.equal(response.status, 200,
        `${path} 在 LOCAL 必須維持原本的大入口（零改動契約）——1MB 是 HOSTED 專屬的`);
    }
  } finally {
    parserServer.close();
  }
});

// ⚠️ 上面那題自建 `parserApp` 直接呼叫 helper，**證明得了 helper 對、證明不了 `server.js` 還在用它**
//    （Codex 定向複審第四輪：在 LOCAL 路徑提前插一個 1MB parser 把正式路徑弄壞，整檔仍 5/5 全綠）。
//    這一題打檔案頂端那個**正式 LOCAL app**，而且要走到底：斷言 200、`imported` 對得上、真的落庫。
test('LOCAL 正式接線：超過 1 MB 的合法列匯入必須真的寫進去（零改動契約）', async () => {
  const card = await (await sendJson(`${base}/cards`, { name: 'LOCAL 大 body 測試卡' })).json();
  assert.ok(card?.id, `前置條件：建卡片應該成功——${JSON.stringify(card)}`);

  // 每一列都合法（`lib/services/statement-import.js` 會伺服器端重建 stmtRef 並比對），
  // 並把整包撐過 1MB——note 塞在**列裡面**，才是真的「列很大」而不是外面掛個大欄位。
  const DESC = (/** @type {number} */ i) => `某某餐飲店股份有限公司台北信義分店-local-${i}-${'補'.repeat(600)}`;
  const transactions = Array.from({ length: 300 }, (_, i) => ({
    date: '2026-07-01', desc: DESC(i), amount: 1234 + i,
    stmtRef: `${card.id}|2026-07-01|${1234 + i}|${DESC(i)}`,
  }));
  const bytes = Buffer.byteLength(JSON.stringify({ transactions }));
  assert.ok(bytes > 1_048_576, `前置條件：這一包要真的超過 1MB，否則考不到（目前 ${bytes} bytes）`);

  const response = await sendJson(`${base}/cards/${card.id}/statement/import`, { transactions });
  assert.equal(response.status, 200,
    `LOCAL 必須維持原本的大入口（零改動契約）——${bytes} bytes：${await response.clone().text()}`);
  const body = await response.json();
  assert.equal(body.imported, 300, `300 筆必須真的匯進去（實際 ${JSON.stringify(body)}）`);

  const txs = await (await fetch(`${base}/transactions`)).json();
  assert.equal(txs.filter((/** @type {any} */ t) => t.importBatch === body.batchId).length, 300,
    '本題這一批必須真的落庫（回應說 imported:300 不等於真的寫進去了）');
});

test('正常尺寸的帳單匯入照樣通過（防止為了收緊而誤殺真實使用者）', async () => {
  const parserApp = express();
  installJsonBodyParsers(parserApp);
  for (const route of STATEMENT_ROWS_POST_ROUTES) {
    parserApp.post(route, (req, res) => res.json({ n: req.body.transactions.length }));
  }
  const parserServer = parserApp.listen(0, '127.0.0.1');
  await once(parserServer, 'listening');
  const parserPort = /** @type {any} */ (parserServer.address()).port;
  try {
    // 一份「重度刷卡族」規模的帳單：500 筆，每筆帶完整欄位。真實台新帳單約 122 筆。
    const transactions = Array.from({ length: 500 }, (_, i) => ({
      id: `tx-${i}`, date: '2026-07-01', postDate: '2026-07-05',
      desc: `某某餐飲店股份有限公司台北信義分店-${i}`, amount: 1234, category: '餐飲', subcategory: '外食',
      stmtRef: `card-1|2026-07-01|1234|某某餐飲店-${i}`,
    }));
    const response = await sendJson(`http://127.0.0.1:${parserPort}/api/cards/card-1/statement/import`, { transactions });
    assert.equal(response.status, 200,
      `500 筆的真實規模帳單必須過得去（實際 body ${JSON.stringify({ transactions }).length} bytes）`);
    assert.deepEqual(await response.json(), { n: 500 });
  } finally {
    parserServer.close();
  }
});

// ⚠️ HOSTED 那一半以前完全沒有考題（Codex 定向複審 2026-07-29，高）：
//    上面那題只跑 LOCAL，只證明「LOCAL 仍可超過 1MB」。把 rowsParser 改回無條件 15MB，
//    它照樣全綠——**被保護的那一側從來沒被考過**。
//    `isHosted()` 每次呼叫都重讀 env，而 `installJsonBodyParsers` 是在安裝當下讀，
//    所以環境變數必須在**掛 parser 之前**設好，跑完還原。
test('HOSTED：只吃列的那一條降到 1 MB（正常尺寸照過、超限回 413）', async () => {
  const before = process.env.NOTEASY_HOSTED;
  process.env.NOTEASY_HOSTED = '1';
  /** @type {any} */
  let parserServer = null;
  try {
    const parserApp = express();
    installJsonBodyParsers(parserApp);   // ← 一定要在設好 env 之後才呼叫
    for (const route of STATEMENT_JSON_POST_ROUTES) {
      parserApp.post(route, (req, res) => res.json({ ok: true }));
    }
    parserServer = parserApp.listen(0, '127.0.0.1');
    await once(parserServer, 'listening');
    const parserPort = /** @type {any} */ (parserServer.address()).port;
    const rowsPath = '/api/cards/card-1/statement/import';

    // ① 正常規模照過——牆收緊了但不可以誤殺真實使用者（真實台新帳單約 122 筆）
    const transactions = Array.from({ length: 500 }, (_, i) => ({
      id: `tx-${i}`, date: '2026-07-01', desc: `某某餐飲店股份有限公司台北信義分店-${i}`, amount: 1234,
    }));
    const okResponse = await sendJson(`http://127.0.0.1:${parserPort}${rowsPath}`, { transactions });
    assert.equal(okResponse.status, 200,
      `HOSTED 的 500 筆真實規模帳單必須過得去（body ${JSON.stringify({ transactions }).length} bytes）`);

    // ② 超過 1MB 必須被擋——這是修法真正保護的那一面
    const tooBig = await sendJson(`http://127.0.0.1:${parserPort}${rowsPath}`, { payload: largeText });
    assert.equal(tooBig.status, 413, 'HOSTED 的列匯入超過 1 MB 必須擋下（保護 Supabase 容量）');

    // ③ 同一個 app 上，吃檔案的端點在 HOSTED 仍維持大入口（收緊只針對吃列的那一條）
    const filePath = '/api/bank-statement/apply';
    const fileResponse = await sendJson(`http://127.0.0.1:${parserPort}${filePath}`, { payload: largeText });
    assert.equal(fileResponse.status, 200, 'HOSTED 也不可以把吃檔案的端點一起掐死');
  } finally {
    parserServer?.close();
    if (before === undefined) delete process.env.NOTEASY_HOSTED;
    else process.env.NOTEASY_HOSTED = before;
  }

  // ⚠️ 還原的斷言必須留在**本題之內**（Codex 定向複審 v4 抓到）。
  //    原本另開一題只寫 `assert.notEqual(process.env.NOTEASY_HOSTED, '1')`——
  //    那是假考題：單獨跑時上面這一段根本沒執行過，它照樣綠。
  //    考題必須守住「**本題自己**動過環境變數、也自己還原了」。
  assert.equal(process.env.NOTEASY_HOSTED, before,
    '本題把 NOTEASY_HOSTED 留在被改過的狀態——後面每一題都會在 HOSTED 下跑，整串走樣');
});
