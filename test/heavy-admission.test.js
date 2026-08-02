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

const { heavyAdmission, installHeavyAdmission, HEAVY_ROUTES, HEAVY_ADMISSION_MAX_INFLIGHT,
  heavyAdmissionInFlightForTest, resetHeavyAdmissionForTest } = await import('../lib/heavy-admission.js');

/** 起一個只掛入場管制的假 app：handler 由測試決定何時回應。
 * ⚠️ 一定要等 listening 才拿得到 port（`address()` 在那之前是 null）。 */
async function makeServer(handler) {
  const app = express();
  // ⚠️ 用 production 的同一支安裝函式：路徑比對交給 Express，考題不自造第二套語意
  installHeavyAdmission(app);
  app.post('/api/statement/preview', handler);
  app.post('/api/cards/:id/statement/preview', handler);
  app.post('/api/import', handler);                                  // 重型：備份還原
  app.post('/api/settings', (req, res) => res.json({ ok: true }));   // 非重型對照組
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

test('受管清單｜六條上傳＋列匯入＋備份還原＋IB 同步都在（範圍是「重型工作」不是「PDF」）', () => {
  for (const must of ['/api/statement/preview', '/api/cards/:id/statement/preview',
    '/api/bank-statement/preview', '/api/bank-statement/apply', '/api/securities/preview',
    '/api/securities/import', '/api/cards/:id/statement/import', '/api/import', '/api/ib/sync']) {
    assert.ok(HEAVY_ROUTES.includes(must), `重型端點沒被納管：${must}（#371 r1 High②：/api/import 曾可繞過）`);
  }
  assert.ok(!HEAVY_ROUTES.includes('/api/settings'), '一般端點不該納管');
});

test('滿了就**還沒收 body** 立刻 503（這一層存在的理由）', async () => {
  resetHeavyAdmissionForTest();
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
    for (let i = 0; i < 100 && heavyAdmissionInFlightForTest() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(heavyAdmissionInFlightForTest(), HEAVY_ADMISSION_MAX_INFLIGHT, '第一個沒佔到名額');

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
    await shutdown(server); resetHeavyAdmissionForTest();
  }
});

test('名額歸還｜正常回應之後要還（不還＝上傳功能慢性死亡）', async () => {
  resetHeavyAdmissionForTest();
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
    assert.equal(heavyAdmissionInFlightForTest(), 0, `連打五次之後還剩 ${heavyAdmissionInFlightForTest()} 個名額沒還`);
  } finally {
    await shutdown(server); resetHeavyAdmissionForTest();
  }
});

test('名額歸還｜handler 丟例外（500）之後也要還', async () => {
  resetHeavyAdmissionForTest();
  const server = await makeServer(() => { throw new Error('boom'); });
  try {
    const base = urlOf(server);
    const r = await fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
    });
    await r.text();
    assert.equal(r.status, 500);
    // 事件是非同步的，給它一拍
    for (let i = 0; i < 50 && heavyAdmissionInFlightForTest() !== 0; i++) await new Promise((res) => setTimeout(res, 5));
    assert.equal(heavyAdmissionInFlightForTest(), 0, '錯誤路徑沒還名額');
    // 還得回來才收得下一個
    const again = await fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
    });
    await again.text();
    assert.notEqual(again.status, 503, '錯誤一次之後就再也收不到上傳＝名額洩漏');
  } finally {
    await shutdown(server); resetHeavyAdmissionForTest();
  }
});

test('名額歸還｜客戶端中途斷線（只有 close、沒有 finish）也要還', async () => {
  resetHeavyAdmissionForTest();
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
    assert.equal(heavyAdmissionInFlightForTest(), 1, '請求進行中應該佔著名額');
    ac.abort();
    await p;
    for (let i = 0; i < 100 && heavyAdmissionInFlightForTest() !== 0; i++) await new Promise((res) => setTimeout(res, 5));
    assert.equal(heavyAdmissionInFlightForTest(), 0, '客戶端斷線沒還名額——這條路只有 close、沒有 finish');
  } finally {
    await shutdown(server); resetHeavyAdmissionForTest();
  }
});

test('非上傳端點不受管制（不該被入場管制誤傷）', async () => {
  resetHeavyAdmissionForTest();
  let release = () => {};
  const held = new Promise((res) => { release = () => res(undefined); });
  const server = await makeServer(async (req, res) => { await held; res.json({ ok: true }); });
  try {
    const base = urlOf(server);
    const first = fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
    });
    for (let i = 0; i < 100 && heavyAdmissionInFlightForTest() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    // 名額被佔滿時，一般端點仍要通
    const other = await fetch(`${base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(other.status, 200, '一般端點被上傳管制誤擋了');
    await other.text();
    release(); await first;
  } finally {
    await shutdown(server); resetHeavyAdmissionForTest();
  }
});

test('LOCAL 零改動｜沒有 NOTEASY_HOSTED 就完全不管（連名額都不算）', async () => {
  resetHeavyAdmissionForTest();
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
    assert.equal(heavyAdmissionInFlightForTest(), 0, 'LOCAL 連名額都不該算');
    release();
    const [ra, rb] = await Promise.all([a, bP]);
    assert.notEqual(rb.status, 503, 'LOCAL 不該有入場管制（零改動契約）');
    await ra.text(); await rb.text();
  } finally {
    if (saved === undefined) delete process.env.NOTEASY_HOSTED; else process.env.NOTEASY_HOSTED = saved;
    await shutdown(server); resetHeavyAdmissionForTest();
  }
});

test('掛載位置｜**讀真 app 的 middleware stack**：每條重型路徑上，入場管制都排在該路徑的 body parser 之前', async () => {
  // ⚠️ 舊版用 indexOf 掃 server.js 的文字——Codex #371 r1 Medium 實測：把 admission 那行註解掉、
  //    或在它前面插一個 parser，斷言照樣通過（**假綠**）。改成檢查**真的 app 物件**。
  // ⚠️ 而且要**逐條路徑**比：全域第一個 parser 是 `/api/auth` 專用的（掛在 authRoutes 之前、
  //    不碰重型路徑），拿它來比會誤判。真正的不變量是「同一條路徑上，管制在 parser 前面」。
  const { app } = await import('../server.js');
  const stack = (/** @type {any} */ (app))._router?.stack;   // Express 4：app.router 是會拋錯的舊 getter
  assert.ok(Array.isArray(stack), '拿不到 app 的 router stack（Express 版本變了就要重寫本題）');

  /** @param {any} layer @returns {any[]} 這一層掛的處理函式 */
  const fnsOf = (layer) => (layer?.route ? (layer.route.stack || []).map((/** @type {any} */ h) => h.handle) : [layer?.handle]);

  for (const route of HEAVY_ROUTES) {
    const admIdx = stack.findIndex((/** @type {any} */ l) => l?.route?.path === route && fnsOf(l).includes(heavyAdmission));
    assert.ok(admIdx >= 0,
      `重型路徑沒掛上入場管制：${route}（把 installHeavyAdmission 註解掉、或漏掉某條路徑，都會走到這裡）`);
    // ⚠️ 不是每條重型路徑都有專屬 parser：`/api/ib/sync` 的重量來自**對外抓 12MB XML 並解析**
    //    （峰值約 254MB），請求本體很小。有 parser 的才比順序；沒有的只要確認管制掛上了。
    const parserIdx = stack.findIndex((/** @type {any} */ l, /** @type {number} */ i) => i !== admIdx
      && l?.route?.path === route
      && fnsOf(l).some((/** @type {any} */ f) => typeof f === 'function' && /json/i.test(f.name || '')));
    if (parserIdx >= 0) {
      assert.ok(admIdx < parserIdx,
        `${route}：入場管制排在 body parser 之後（管制@${admIdx} > parser@${parserIdx}）＝body 已經被收下了，這一層等於白做`);
    }
  }
});

test('掛載位置｜前一題不可空轉：至少要有 8 條重型路徑真的比對過 parser 順序', async () => {
  // ⚠️ 上一題對「沒有 parser 的路徑」會跳過比對——若某天 parser 偵測壞掉（例如函式改名），
  //    每條都變成「沒有 parser」而整題空轉全綠。這一題釘住實際比對到的條數。
  const { app } = await import('../server.js');
  const stack = (/** @type {any} */ (app))._router?.stack;
  const fnsOf = (/** @type {any} */ layer) => (layer?.route ? (layer.route.stack || []).map((/** @type {any} */ h) => h.handle) : [layer?.handle]);
  const withParser = HEAVY_ROUTES.filter((route) => stack.some((/** @type {any} */ l) => l?.route?.path === route
    && fnsOf(l).some((/** @type {any} */ f) => typeof f === 'function' && /json/i.test(f.name || ''))));
  assert.equal(withParser.length, HEAVY_ROUTES.length - 1,
    `只有 ${withParser.length} 條路徑找得到 body parser（預期＝全部 ${HEAVY_ROUTES.length} 條扣掉沒有 body 的 /api/ib/sync）——parser 偵測可能壞了，上一題會空轉`);
  assert.ok(!withParser.includes('/api/ib/sync'), '/api/ib/sync 不該有專屬 body parser');
});
