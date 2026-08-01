// 檔案上傳 HTTP 入場管制的考題（2026-08-02；Codex #350 r2 High，William 裁決另開 PR）。
//
// 這一層守的是：**在收 body 之前就回絕**，否則並發請求會各自先把資料吃進記憶體
//（實測 6 個排隊時多吃 67.5MiB，而第 7 個雖回 503 也已通過 15MB parser）。
//
// ⚠️ 本檔的火力集中在**名額洩漏**：名額只進不出＝上傳功能慢性死亡（第一次之後再也進不來），
//    而且不會有任何錯誤訊息。每一條結束路徑（成功／錯誤／客戶端中斷）都要驗歸還。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

process.env.NOTEASY_HOSTED = '1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'k';
process.env.SITE_ORIGIN = 'http://127.0.0.1';
process.env.NOTEASY_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const { pdfAdmission, isFileUploadPath, PDF_ADMISSION_MAX_INFLIGHT,
  pdfAdmissionInFlightForTest, resetPdfAdmissionForTest } = await import('../lib/pdf-admission.js');
const { STATEMENT_FILE_POST_ROUTES } = await import('../lib/http-body.js');

/** 起一個只掛入場管制的假 app：handler 由測試決定何時回應。
 * ⚠️ 一定要等 listening 才拿得到 port（`address()` 在那之前是 null）。 */
async function makeServer(handler) {
  const app = express();
  app.use(pdfAdmission);
  app.post('/api/statement/preview', handler);
  app.post('/api/cards/:id/statement/preview', handler);
  app.post('/api/settings', (req, res) => res.json({ ok: true }));   // 非上傳路徑對照組
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

/** @param {any} server */
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

/** ⚠️ 一定要先 `closeAllConnections()`：fetch 預設 keep-alive，連線不關的話
 *  `server.close()` 會永遠等下去（實測整個測試檔掛住五分鐘）。 @param {any} server */
async function shutdown(server) {
  server.closeAllConnections?.();
  server.close();
  await once(server, 'close');
}

test('路徑比對｜六條上傳端點都認得，`:id` 參數要展開；其他端點不受管', () => {
  assert.equal(STATEMENT_FILE_POST_ROUTES.length, 6, '上傳端點清單變動了＝本題要重新確認');
  for (const p of STATEMENT_FILE_POST_ROUTES) {
    const concrete = p.replace(/:[^/]+/g, 'abc123');
    assert.ok(isFileUploadPath(concrete), `沒認出上傳端點：${concrete}`);
  }
  for (const p of ['/api/settings', '/api/db', '/api/statement/batches', '/api/statement', '/api/securities']) {
    assert.ok(!isFileUploadPath(p), `誤把一般端點當上傳：${p}`);
  }
});

test('滿了就**還沒收 body** 立刻 503（這一層存在的理由）', async () => {
  resetPdfAdmissionForTest();
  let release = () => {};
  const held = new Promise((res) => { release = () => res(undefined); });
  let bodyBytesSeen = 0;
  const server = await makeServer(async (req, res) => {
    req.on('data', (b) => { bodyBytesSeen += b.length; });
    await held;
    res.json({ ok: true });
  });
  try {
    const base = urlOf(server);
    const big = 'x'.repeat(200_000);
    const first = fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: big }),
    });
    // 等第一個真的佔到名額
    for (let i = 0; i < 100 && pdfAdmissionInFlightForTest() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(pdfAdmissionInFlightForTest(), PDF_ADMISSION_MAX_INFLIGHT, '第一個沒佔到名額');

    const seenBefore = bodyBytesSeen;
    const second = await fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: big }),
    });
    assert.equal(second.status, 503, '滿了竟然還收');
    assert.match((await second.json()).error, /稍候|另一份/, '訊息要讓使用者知道該怎麼辦');
    assert.equal(bodyBytesSeen, seenBefore,
      '被回絕的請求竟然還是被讀了 body——那就沒有擋住記憶體堆積，這一層等於白做');

    release();
    await first;
  } finally {
    await shutdown(server); resetPdfAdmissionForTest();
  }
});

test('名額歸還｜正常回應之後要還（不還＝上傳功能慢性死亡）', async () => {
  resetPdfAdmissionForTest();
  const server = await makeServer((req, res) => res.json({ ok: true }));
  try {
    const base = urlOf(server);
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/api/statement/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
      });
      assert.equal(r.status, 200, `第 ${i + 1} 次被擋下＝前一次的名額沒還`);
      await r.text();
    }
    assert.equal(pdfAdmissionInFlightForTest(), 0, `連打五次之後還剩 ${pdfAdmissionInFlightForTest()} 個名額沒還`);
  } finally {
    await shutdown(server); resetPdfAdmissionForTest();
  }
});

test('名額歸還｜handler 丟例外（500）之後也要還', async () => {
  resetPdfAdmissionForTest();
  const server = await makeServer(() => { throw new Error('boom'); });
  try {
    const base = urlOf(server);
    const r = await fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
    });
    await r.text();
    assert.equal(r.status, 500);
    // 事件是非同步的，給它一拍
    for (let i = 0; i < 50 && pdfAdmissionInFlightForTest() !== 0; i++) await new Promise((res) => setTimeout(res, 5));
    assert.equal(pdfAdmissionInFlightForTest(), 0, '錯誤路徑沒還名額');
    // 還得回來才收得下一個
    const again = await fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
    });
    await again.text();
    assert.notEqual(again.status, 503, '錯誤一次之後就再也收不到上傳＝名額洩漏');
  } finally {
    await shutdown(server); resetPdfAdmissionForTest();
  }
});

test('名額歸還｜客戶端中途斷線（只有 close、沒有 finish）也要還', async () => {
  resetPdfAdmissionForTest();
  let started = () => {};
  const startedP = new Promise((res) => { started = () => res(undefined); });
  const server = await makeServer((req, res) => { started(); /* 故意不回應 */ void res; });
  try {
    const base = urlOf(server);
    const ac = new AbortController();
    const p = fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}', signal: ac.signal,
    }).catch(() => null);
    await startedP;
    assert.equal(pdfAdmissionInFlightForTest(), 1, '請求進行中應該佔著名額');
    ac.abort();
    await p;
    for (let i = 0; i < 100 && pdfAdmissionInFlightForTest() !== 0; i++) await new Promise((res) => setTimeout(res, 5));
    assert.equal(pdfAdmissionInFlightForTest(), 0, '客戶端斷線沒還名額——這條路只有 close、沒有 finish');
  } finally {
    await shutdown(server); resetPdfAdmissionForTest();
  }
});

test('非上傳端點不受管制（不該被入場管制誤傷）', async () => {
  resetPdfAdmissionForTest();
  let release = () => {};
  const held = new Promise((res) => { release = () => res(undefined); });
  const server = await makeServer(async (req, res) => { await held; res.json({ ok: true }); });
  try {
    const base = urlOf(server);
    const first = fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
    });
    for (let i = 0; i < 100 && pdfAdmissionInFlightForTest() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    // 名額被佔滿時，一般端點仍要通
    const other = await fetch(`${base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(other.status, 200, '一般端點被上傳管制誤擋了');
    await other.text();
    release(); await first;
  } finally {
    await shutdown(server); resetPdfAdmissionForTest();
  }
});

test('LOCAL 零改動｜沒有 NOTEASY_HOSTED 就完全不管（連名額都不算）', async () => {
  resetPdfAdmissionForTest();
  const saved = process.env.NOTEASY_HOSTED;
  delete process.env.NOTEASY_HOSTED;
  let release = () => {};
  const held = new Promise((res) => { release = () => res(undefined); });
  const server = await makeServer(async (req, res) => { await held; res.json({ ok: true }); });
  try {
    const base = urlOf(server);
    // ⚠️ 兩個請求都要**先發出、後 release**：handler 要等 release 才回應，
    //    先 await 第二個就會死結（實測掛住五分鐘）。
    const a = fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
    });
    const bP = fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
    });
    // 兩個都進得去＝LOCAL 沒有入場管制；名額也不該被算
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pdfAdmissionInFlightForTest(), 0, 'LOCAL 連名額都不該算');
    release();
    const [ra, rb] = await Promise.all([a, bP]);
    assert.notEqual(rb.status, 503, 'LOCAL 不該有入場管制（零改動契約）');
    await ra.text(); await rb.text();
  } finally {
    if (saved === undefined) delete process.env.NOTEASY_HOSTED; else process.env.NOTEASY_HOSTED = saved;
    await shutdown(server); resetPdfAdmissionForTest();
  }
});

test('掛載位置｜server.js 必須把它夾在「限速之後、body parser 之前」', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js'), 'utf8');
  const iRate = src.indexOf("mountRateLimit('post-gate')");
  const iAdmit = src.indexOf('app.use(pdfAdmission)');
  const iBody = src.indexOf('installJsonBodyParsers(app)');
  assert.ok(iRate > 0 && iAdmit > 0 && iBody > 0, '三個掛載點都要找得到（結構變了就要重寫本題）');
  assert.ok(iRate < iAdmit, '入場管制掛在限速之前＝沒登入的人也能佔名額');
  assert.ok(iAdmit < iBody, '入場管制掛在 body parser 之後＝還是先把 body 收下來了，這一層等於白做');
});
