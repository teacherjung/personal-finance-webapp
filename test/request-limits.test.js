// @ts-check
// 大型請求分流考題：一般 API 要擋超大 body，但帳單與救援用備份還原不可一起被掐死。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';
import { installJsonBodyParsers, STATEMENT_JSON_POST_ROUTES } from '../lib/http-body.js';

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

test('五個帳單端點都可通過超過 1 MB 的 JSON body', async () => {
  const parserApp = express();
  installJsonBodyParsers(parserApp);
  for (const route of STATEMENT_JSON_POST_ROUTES) {
    parserApp.post(route, (req, res) => res.json({ size: req.body.payload.length }));
  }

  const parserServer = parserApp.listen(0, '127.0.0.1');
  await once(parserServer, 'listening');
  const parserPort = /** @type {any} */ (parserServer.address()).port;

  try {
    const concretePaths = [
      '/api/statement/preview',
      '/api/cards/card-1/statement/preview',
      '/api/cards/card-1/statement/import',
      '/api/bank-statement/preview',
      '/api/bank-statement/apply',
    ];
    assert.equal(concretePaths.length, STATEMENT_JSON_POST_ROUTES.length, '大型帳單端點清單與考題要同步');

    for (const path of concretePaths) {
      const response = await sendJson(`http://127.0.0.1:${parserPort}${path}`, { payload: largeText });
      assert.equal(response.status, 200, `${path} 不該套到一般 1 MB 上限`);
      assert.deepEqual(await response.json(), { size: largeText.length });
    }
  } finally {
    parserServer.close();
  }
});
