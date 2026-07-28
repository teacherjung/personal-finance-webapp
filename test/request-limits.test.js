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

// ⚠️ 這一題 2026-07-28 從「七個端點都可以超過 1MB」改成「**吃檔案的四個**可以、**吃列的三個**不行」。
//    原因（Codex 收官審查 #10 引出的實測）：那三個只收「預覽已經解析好的列」，身上一個位元組的檔案
//    都沒有，卻跟吃 base64 PDF/XLSX 的端點共用 15MB 入口。而那些列寫進 kv 時會**放大約 3 倍**——
//    一個 15MB 的請求塞得下 261 列、落庫 44.9MB。這不是新增限制，是把混進群組的成員請出去。
test('吃檔案的四個端點可以超過 1 MB；只吃「已解析的列」的三個不行', async () => {
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
    const filePaths = [
      '/api/statement/preview',
      '/api/cards/card-1/statement/preview',
      '/api/bank-statement/preview',
      '/api/securities/preview',
    ];
    // 只吃預覽產生的列 → 一般 1MB 就夠（真實帳單一次幾百列、幾十 KB，餘裕約 30 倍）
    const rowPaths = [
      '/api/cards/card-1/statement/import',
      '/api/bank-statement/apply',
      '/api/securities/import',
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
    for (const path of rowPaths) {
      const response = await sendJson(`http://127.0.0.1:${parserPort}${path}`, { payload: largeText });
      assert.equal(response.status, 413,
        `${path} 只收「已解析的列」，不該享有 15MB 入口（落庫會放大約 3 倍）`);
    }
  } finally {
    parserServer.close();
  }
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
