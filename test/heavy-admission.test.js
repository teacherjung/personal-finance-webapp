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

const { heavyAdmission, installHeavyAdmission, HEAVY_ROUTES, HEAVY_ROUTES_WITHOUT_BODY, HEAVY_ADMISSION_MAX_INFLIGHT, withHeavySlot,
  heavyAdmissionInFlightForTest, heavyAdmissionWaitingForTest, resetHeavyAdmissionForTest }
  = await import('../lib/heavy-admission.js');

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
  let firstBodyDone = false;
  const server = await makeServer(async (req, res) => {
    req.on('data', (b) => { bodyBytesSeen += b.length; });
    req.on('end', () => { firstBodyDone = true; });
    await held;
    res.json({ ok: true });
  });
  try {
    const base = urlOf(server);
    const big = 'x'.repeat(200_000);
    const first = fetch(`${base}/api/statement/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: big }),
    });
    // 等第一個**把 body 收完**才取快照——Codex #371 r2 Medium：原本在 body 還在傳的時候
    // 就取，尾端幾 KB 隨後抵達就會讓斷言隨機失敗（CI 上 Node 26 實際紅過：200011 !== 195309）。
    for (let i = 0; i < 400 && !firstBodyDone; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(firstBodyDone, '第一個請求的 body 遲遲沒收完（環境太慢或 handler 沒接 end）');
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

test('掛載位置｜真 app：每條重型路徑上，入場管制排在**所有會匹配它的 body parser**之前', async () => {
  // ⚠️ 這題被改過三次，每次都是同一個病：**檢查面太窄**。
  //    v1 掃 server.js 的文字 → 把那行註解掉照樣綠（Codex #371 r1）。
  //    v2 只看 `layer.route.path === route` 的 route-specific parser → 在 admission 前面加一個
  //       **全域** `app.use(express.json())` 照樣綠（Codex #371 r2 實測）。
  //    v3（本版）：把所有**會匹配這條 URL** 的 parser 都找出來（含全域 app.use 掛的），
  //       比對 admission 是否排在它們**全部**之前。
  const { app } = await import('../server.js');
  const stack = (/** @type {any} */ (app))._router?.stack;   // Express 4：app.router 是會拋錯的舊 getter
  assert.ok(Array.isArray(stack), '拿不到 app 的 router stack（Express 版本變了就要重寫本題）');

  /** @param {any} layer @returns {any[]} 這一層掛的處理函式 */
  const fnsOf = (layer) => (layer?.route ? (layer.route.stack || []).map((/** @type {any} */ h) => h.handle) : [layer?.handle]);
  /** 這一層是不是 json body parser？ @param {any} layer */
  const isParser = (layer) => fnsOf(layer).some((/** @type {any} */ f) => typeof f === 'function' && /json/i.test(f.name || ''));
  /** 這一層會不會被這條 URL 命中？（route-specific 比 path；全域 app.use 比 regexp）
   *  @param {any} layer @param {string} url */
  const matches = (layer, url) => (layer?.route ? layer.route.path === url : !!layer?.regexp?.test?.(url));

  for (const route of HEAVY_ROUTES) {
    // 用具體 URL 比對全域層（`:id` 要展開，否則 regexp 對不上）
    const url = route.replace(/:[^/]+/g, 'abc123');
    const admIdx = stack.findIndex((/** @type {any} */ l) => l?.route?.path === route && fnsOf(l).includes(heavyAdmission));
    assert.ok(admIdx >= 0,
      `重型路徑沒掛上入場管制：${route}（installHeavyAdmission 被註解掉、或漏掉某條路徑都會走到這裡）`);

    const parserIdxs = stack.map((/** @type {any} */ l, /** @type {number} */ i) => ({ l, i }))
      .filter(({ l, i }) => i !== admIdx && isParser(l) && matches(l, url))
      .map(({ i }) => i);
    for (const pIdx of parserIdxs) {
      assert.ok(admIdx < pIdx,
        `${route}：入場管制排在 body parser 之後（管制@${admIdx} > parser@${pIdx}）＝body 已經被收下了，這一層等於白做`);
    }
  }
});

test('掛載位置｜前一題不可空轉：有 body 的重型路徑都必須真的比對到 parser', async () => {
  // ⚠️ 前一題對「找不到 parser 的路徑」不會比順序——若 parser 偵測壞掉（例如函式改名），
  //    每條都變成「沒有 parser」而整題空轉全綠。這一題釘住「該有 parser 的都找得到」。
  //    ⚠️ 清單來自 production 的 HEAVY_ROUTES_WITHOUT_BODY，**不是測試自己猜**
  //   （Codex #371 r2：原本寫死「只有 IB」，新增這類路徑時會靜默失準）。
  const { app } = await import('../server.js');
  const stack = (/** @type {any} */ (app))._router?.stack;
  const fnsOf = (/** @type {any} */ layer) => (layer?.route ? (layer.route.stack || []).map((/** @type {any} */ h) => h.handle) : [layer?.handle]);
  const withParser = HEAVY_ROUTES.filter((route) => stack.some((/** @type {any} */ l) => l?.route?.path === route
    && fnsOf(l).some((/** @type {any} */ f) => typeof f === 'function' && /json/i.test(f.name || ''))));
  const expected = HEAVY_ROUTES.filter((r) => !HEAVY_ROUTES_WITHOUT_BODY.includes(r));
  assert.deepEqual(withParser.sort(), expected.sort(),
    '「有 body 的重型路徑」與「實際找得到 parser 的」對不起來——parser 偵測可能壞了（前一題會空轉），'
    + '或有新的無 body 路徑沒登記進 HEAVY_ROUTES_WITHOUT_BODY');
});

test('服務層名額｜withHeavySlot 與 HTTP 入場管制**共用同一個計數**（不是各算各的）', async () => {
  resetHeavyAdmissionForTest();
  let release = () => {};
  const held = new Promise((res) => { release = () => res('done'); });
  try {
    const p = withHeavySlot(() => held);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(heavyAdmissionInFlightForTest(), 1, 'withHeavySlot 沒佔到共用名額＝兩層各算各的，預算就對不上');
    // 名額被服務層佔住時，HTTP 層的上傳也要被擋（這才叫「共用」）
    const server = await makeServer((req, res) => res.json({ ok: true }));
    try {
      const r = await fetch(`${urlOf(server)}/api/statement/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}',
      });
      await r.text();
      assert.equal(r.status, 503, 'HTTP 層沒看到服務層佔用的名額');
    } finally { await shutdown(server); }
    release(); await p;
    for (let i = 0; i < 100 && heavyAdmissionInFlightForTest() !== 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(heavyAdmissionInFlightForTest(), 0, 'withHeavySlot 沒還名額');
  } finally { resetHeavyAdmissionForTest(); }
});

test('服務層名額｜失敗路徑也要還（throw 之後名額不可留著）', async () => {
  resetHeavyAdmissionForTest();
  const err = await withHeavySlot(async () => { throw new Error('boom'); }).then(() => null, (e) => e);
  assert.equal(String(err?.message), 'boom', '錯誤要原樣往上拋');
  assert.equal(heavyAdmissionInFlightForTest(), 0, '失敗路徑沒還名額＝重型功能會慢性死亡');
  resetHeavyAdmissionForTest();
});

// ── 獨立複核（2026-08-02）抓到的三條，Codex r1–r3 都沒抓到 ─────────────────────

test('名額洩漏｜**進 admission 之前**就斷線的連線不可以佔走名額（全站重型功能會永久死掉）', async () => {
  resetHeavyAdmissionForTest();
  // ⚠️ 這一格是既有考題漏掉的：原本那題是等 handler 跑起來（await startedP）才 abort，
  //    那時 listener 早就掛好了。真正的洞在**更早**——`authGate` 裡有一段真的網路往返
  //    （supabase.auth.getUser()），客戶端在那段期間斷線的話，res 的 'close' 在
  //    admission 執行之前就燒完了，之後掛的 listener 一輩子不會觸發。
  //    這裡直接模擬那個狀態：交給 admission 一個**已經關掉**的 res。
  const closedRes = /** @type {any} */ ({
    closed: true, destroyed: true,
    on() { throw new Error('不該再掛 listener——連線已經沒了'); },
    set() { throw new Error('不該回應'); }, status() { throw new Error('不該回應'); },
  });
  const deadReq = /** @type {any} */ ({ destroyed: true });
  let passedOn = false;
  heavyAdmission(deadReq, closedRes, () => { passedOn = true; });
  assert.equal(heavyAdmissionInFlightForTest(), 0,
    '已經斷線的請求佔走了名額——它永遠不會歸還，全站重型功能會一起 503 直到重啟行程');
  assert.ok(passedOn, '仍要往下走（維持既有行為，只是不佔名額）');
  resetHeavyAdmissionForTest();
});

test('名額洩漏｜連打三次「按了又取消」之後，正常請求仍進得來', async () => {
  resetHeavyAdmissionForTest();
  for (let i = 0; i < 3; i++) {
    const dead = /** @type {any} */ ({ closed: true, destroyed: false, on() {}, });
    heavyAdmission(/** @type {any} */ ({ destroyed: false }), dead, () => {});
  }
  assert.equal(heavyAdmissionInFlightForTest(), 0,
    `連續三次取消之後名額是 ${heavyAdmissionInFlightForTest()}——洩漏是累積的，一次就夠讓全站死掉`);
  resetHeavyAdmissionForTest();
});

test('服務層排隊｜名額滿的時候**等**、不是立刻 503（等待不花記憶體，fail-fast 是相對 main 的回歸）', async () => {
  resetHeavyAdmissionForTest();
  try {
    /** @type {() => void} */ let releaseFirst = () => {};
    const first = withHeavySlot(() => new Promise((r) => { releaseFirst = () => r('第一件'); }));
    await new Promise((r) => setImmediate(r));
    assert.equal(heavyAdmissionInFlightForTest(), 1, '第一件應該拿到名額');

    const second = withHeavySlot(async () => '第二件');            // 名額滿 → 應該排隊，不是 throw
    await new Promise((r) => setImmediate(r));
    assert.equal(heavyAdmissionWaitingForTest(), 1,
      '第二件沒有排隊——照抄 HTTP 層的 fail-fast 會讓「不同代號的併發更新」全部失敗（main 上是排隊後都成功）');

    releaseFirst();
    assert.equal(await first, '第一件');
    assert.equal(await second, '第二件', '排隊的那件最後要真的跑完，不是被丟掉');
    for (let i = 0; i < 100 && heavyAdmissionInFlightForTest() !== 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(heavyAdmissionInFlightForTest(), 0, '排隊路徑沒還名額');
    assert.equal(heavyAdmissionWaitingForTest(), 0, '隊伍沒清空');
  } finally { resetHeavyAdmissionForTest(); }
});

test('服務層排隊｜等太久仍要 503（有上限的等待，不是無限期卡住）', async () => {
  resetHeavyAdmissionForTest();
  try {
    /** @type {() => void} */ let releaseFirst = () => {};
    const first = withHeavySlot(() => new Promise((r) => { releaseFirst = () => r(1); }));
    await new Promise((r) => setImmediate(r));
    const err = await withHeavySlot(async () => 2, { waitMs: 30 }).then(() => null, (e) => e);
    assert.equal(err?.status, 503, '等超過上限要回 503，不可以無限期卡著使用者');
    assert.equal(err?.code, 'heavy_busy');
    assert.equal(heavyAdmissionWaitingForTest(), 0,
      '放棄的人沒有從隊伍移除——名額會被轉交給早已離開的人，等於憑空消失');
    releaseFirst(); await first;
    for (let i = 0; i < 100 && heavyAdmissionInFlightForTest() !== 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(heavyAdmissionInFlightForTest(), 0, '逾時路徑把名額弄丟了');
  } finally { resetHeavyAdmissionForTest(); }
});

test('行為題｜/api/import 與 /api/ib/sync 真的被管住（本 PR 的招牌修正，原本只有清單題）', async () => {
  resetHeavyAdmissionForTest();
  // ⚠️ 原本只有「HEAVY_ROUTES 裡有沒有這兩條」的清單題——那是**跟著實作一起改**的斷言：
  //    把路徑從 HEAVY_ROUTES 拿掉，清單題跟著紅，看起來有守住，其實從沒證明過
  //    「掛上去之後真的擋得住」。這題從 HTTP 打進去。
  /** @type {() => void} */ let release = () => {};
  const held = new Promise((r) => { release = () => r(undefined); });
  const app = express();
  installHeavyAdmission(app);
  for (const r of ['/api/import', '/api/ib/sync', '/api/statement/preview']) {
    app.post(r, async (_req, res) => { await held; res.json({ ok: true }); });
  }
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const first = fetch(`${urlOf(server)}/api/statement/preview`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    for (let i = 0; i < 100 && heavyAdmissionInFlightForTest() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(heavyAdmissionInFlightForTest(), 1, '前提：第一件要先佔住名額');
    for (const route of ['/api/import', '/api/ib/sync']) {
      // ⚠️ 一定要帶 timeout：這題沒過的時候，請求會直接進 handler 然後卡在 `held` 上——
      //    實測突變時整題掛了 300 秒才失敗。CI 上那是掛住的 job，不是紅燈。
      const r = await fetch(`${urlOf(server)}${route}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          signal: AbortSignal.timeout(3000) })
        .catch((e) => { assert.fail(`${route} 沒有被入場管制擋住（請求直接進了 handler 並卡住：${e?.name}）`); });
      await r.text();
      assert.equal(r.status, 503, `${route} 沒有被入場管制擋住——它可以繞過名額直接開工`);
      assert.equal(r.headers.get('retry-after'), '10', `${route} 的 503 沒帶 Retry-After，前端不知道多久後重試`);
    }
    release(); await (await first).text();
  } finally { await shutdown(server); resetHeavyAdmissionForTest(); }
});
