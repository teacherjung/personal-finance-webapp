// C2 考題：雙模式開關／auth 端點與 cookie 旗標／CSRF Origin 牆／secret 掃描。
// 假 Supabase client 由 setSupabaseFactoryForTest 注入（比照 STORE_FILE 隔離慣例）——考題絕不打真 Supabase。
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';

const TEST_STORE = join(tmpdir(), `finance-hosted-auth-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;
// HOSTED 模式＋必要環境變數（缺一 fail-fast 有專門考題）
process.env.NOTEASY_HOSTED = '1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SITE_ORIGIN = 'https://noteasy.com.tw,http://localhost:4321';
process.env.NOTEASY_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');   // C5：機密加密主金鑰（考題用固定值）

const { setSupabaseFactoryForTest, cookieAdapterFor, serializeCookie } = await import('../lib/services/auth.js');
const { isHosted, hostedConfig, originAllowed } = await import('../lib/hosted.js');
const { createFakePostgres, makeFakeSupabaseFactory } = await import('../test-doubles/fake-supabase.js');
const { app } = await import('../server.js');

/** 可控假 client：只假造 Supabase 的回應，cookie 寫入與資料層一律走正式管線。 */
const USER = { id: 'u-1', email: 'a@x.com' };
const fake = { failLogin: false, throwGetUser: false };
// 假 client **必須走真的 cookieAdapterFor→serializeCookie**（Codex #301 阻擋#2：自己 append Set-Cookie
// ＝繞過正式 serializer，旗標考題考不到真程式）。
// C4b 起假 client 還要接得住資料層（from('kv')／rpc('kv_save')）——HOSTED 模式的讀寫已改走
// Supabase Postgres，沒有假 Postgres 的話這個檔案裡「登入後 API 通」那幾題會直接 500。
const pg = createFakePostgres();
before(() => setSupabaseFactoryForTest(
  makeFakeSupabaseFactory({ pg, users: { abc: USER }, state: fake, cookieAdapterFor })));

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;
const GOOD_ORIGIN = 'https://noteasy.com.tw';

after(() => {
  server.close();
  setSupabaseFactoryForTest(null);
  for (const sfx of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + sfx); } catch { /* 可能不存在 */ } }
});

test('模式開關：HOSTED 判準只認 NOTEASY_HOSTED=1；缺環境變數＝fail-fast throw', () => {
  assert.equal(isHosted(), true);
  assert.deepEqual(hostedConfig().siteOrigin.includes('noteasy'), true);
  const saved = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  assert.throws(() => hostedConfig(), /SUPABASE_URL/, '缺設定必須開不起來，不可默默半套');
  process.env.SUPABASE_URL = saved;
});

test('登入成功：session cookie 由伺服器設、旗標齊（HttpOnly＋SameSite=Lax＋Secure＋Path=/）', async () => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN }, body: JSON.stringify({ email: 'a@x.com', password: 'pw' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { user: { id: 'u-1', email: 'a@x.com' } }, '只吐 id/email、不整包 Supabase user');
  const setCookie = r.headers.get('set-cookie') || '';
  for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.match(setCookie, new RegExp(flag), flag);
});

test('登入失敗：401＋不洩漏「帳號存在與否」', async () => {
  fake.failLogin = true;
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN }, body: JSON.stringify({ email: 'a@x.com', password: 'wrong' }) });
  fake.failLogin = false;
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /信箱或密碼不正確/, '統一訊息＝猜不出帳號是否存在');
});

test('/api/auth/me：有 session cookie 回 user、沒有回 null（getUser 驗簽路徑）', async () => {
  const withCookie = await fetch(`${base}/api/auth/me`, { headers: { Cookie: 'sb-test-auth-token=abc' } });
  assert.deepEqual(await withCookie.json(), { user: { id: 'u-1', email: 'a@x.com' } });
  const noCookie = await fetch(`${base}/api/auth/me`);
  assert.deepEqual(await noCookie.json(), { user: null });
});

test('CSRF Origin 牆：白名單外 Origin 的變更請求＝403；沒帶 Origin（curl）＝放行；GET 不擋', async () => {
  const evil = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evil.status, 403);
  const noOrigin = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal(noOrigin.status, 200, 'SameSite 已擋跨站帶 cookie，非瀏覽器請求放行');
  const getOk = await fetch(`${base}/api/auth/me`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(getOk.status, 200, 'GET 天然略過');
  assert.equal(originAllowed(undefined), true);
});

test('邀請回呼：token_hash 合法＝建 session、非法＝400 白話訊息；設密碼＜10 字＝400', async () => {
  const ok = await fetch(`${base}/api/auth/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN }, body: JSON.stringify({ token_hash: 'good', type: 'invite' }) });
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/api/auth/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN }, body: JSON.stringify({ token_hash: 'expired-one' }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /連結無效或已過期/);
  const shortPw = await fetch(`${base}/api/auth/set-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN, Cookie: 'sb-test-auth-token=abc' }, body: JSON.stringify({ password: 'short' }) });
  assert.equal(shortPw.status, 400);
});

test('HOSTED 靜態：/ 是公開站、/login extensionless、/health JSON、/wellness 存在、/finance 是理財 app', async () => {
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /不簡單/, '/ ＝公開站首頁');
  assert.match(await (await fetch(`${base}/login`)).text(), /登入｜不簡單/, 'extensionless rewrite');
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true }, '裁決④：/health 給機器');
  assert.match(await (await fetch(`${base}/wellness`)).text(), /健康｜不簡單/);
  // C3 上線後 /finance 要登入（本題前提隨 C3 更新）：帶 session 驗 SPA 有掛在這條路徑
  assert.match(await (await fetch(`${base}/finance/`, { headers: { Cookie: 'sb-test-auth-token=abc' } })).text(), /個人理財中心/, '/finance＝既有 SPA（登入後）');
});

test('auth 回應不可被快取：setAll 第二參數 headers 有轉發＋/api/auth/* 一律 no-store（Codex #301 r2）', async () => {
  // ① adapter 轉發 ssr 傳來的 headers（cookies.js:447 那組防快取標頭）
  const fakeRes = { headers: /** @type {Record<string,string>} */ ({}), cookies: /** @type {string[]} */ ([]),
    set(/** @type {string} */ k, /** @type {string} */ v) { this.headers[k] = v; },
    append(/** @type {string} */ k, /** @type {string} */ v) { this.cookies.push(v); } };
  cookieAdapterFor({ headers: {} }, fakeRes).setAll([{ name: 'sb-t', value: 'v' }], { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  assert.equal(fakeRes.headers['Cache-Control'], 'no-store');
  assert.equal(fakeRes.headers.Pragma, 'no-cache');
  assert.match(fakeRes.cookies[0], /Secure/);
  // ② 就算 ssr 沒傳（讀路徑），/api/auth/* 回應也一律 no-store
  const me = await fetch(`${base}/api/auth/me`);
  assert.match(String(me.headers.get('cache-control')), /no-store/);
});

test('serializeCookie：Secure 無條件開、沒有任何環境變數能關（Codex #301 回歸釘）', () => {
  process.env.NOTEASY_INSECURE_COOKIE = '1';   // 舊開關已刪：就算有人把它設回來也不該有任何效果
  const c = serializeCookie('sb-x', 'v', { maxAge: 60 });
  delete process.env.NOTEASY_INSECURE_COOKIE;
  for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/', 'Max-Age=60']) assert.match(c, new RegExp(flag), flag);
  assert.ok(!c.includes('Domain='), '不設 Domain（P2：避免子網域外洩）');
});

test('secret 掃描：repo 追蹤檔不得含 service_role 權杖（JWT payload 解碼驗證）', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n');
  const { readFileSync } = /** @type {any} */ (process.getBuiltinModule('node:fs'));
  const jwtRe = /eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g;
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }   // 二進位檔跳過
    for (const m of text.matchAll(jwtRe)) {
      try {
        const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
        if (payload?.role === 'service_role') hits.push(f);
      } catch { /* 不是 JWT，略過 */ }
    }
  }
  assert.deepEqual(hits, [], 'service_role key＝萬能鑰匙，絕不可進 repo');
});

// ---- C3 auth gate（P1-1：只宣稱 401／轉登入，不宣稱隔離——隔離歸 C4）----
test('C3 gate：未登入打理財 API＝401（逐 router 抽樣、含寫入方法）；白名單與公開站不受影響', async () => {
  // 各 router 抽樣（core/crud/market/ib/statement/securities/stock-fundamentals 都要在牆內）
  for (const p of ['/api/db', '/api/summary', '/api/transactions', '/api/cards', '/api/quotes/refresh-auto', '/api/ib/sync', '/api/statement/preview', '/api/securities', '/api/stock-fundamentals/CAL', '/api/export', '/api/refund-pairs', '/api/backup/daily']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 401, `GET ${p} 未登入必 401`);
    assert.deepEqual(await r.json(), { error: '請先登入' });
  }
  const post = await fetch(`${base}/api/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN }, body: '{}' });
  assert.equal(post.status, 401, '寫入方法同樣被牆擋（且在 CSRF 之後、業務邏輯之前）');
  const refresh = await fetch(`${base}/api/stock-fundamentals/CAL/refresh`, {
    method: 'POST', headers: { Origin: GOOD_ORIGIN }
  });
  assert.equal(refresh.status, 401, 'SEC refresh 未登入也必須在外部連線之前被擋');
  // 白名單：登入功能本身與 /health 照常
  assert.equal((await fetch(`${base}/api/auth/me`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
  // 公開站不經牆
  assert.match(await (await fetch(`${base}/login`)).text(), /登入｜不簡單/);
});

test('C3 gate：/finance 未登入＝轉 /login；登入後 API 與 /finance 都通', async () => {
  const page = await fetch(`${base}/finance/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  // 有 session（假 client 認 sb-test-auth-token=abc）＝放行
  // ⚠️ 本檔只驗「牆」（401／轉登入）；**A/B 跨使用者隔離歸 C4b**，逐集合列舉在 test/hosted-store-pg.test.js
  const okApi = await fetch(`${base}/api/summary`, { headers: { Cookie: 'sb-test-auth-token=abc' } });
  assert.equal(okApi.status, 200, '登入後 API 通');
  const okPage = await fetch(`${base}/finance/`, { headers: { Cookie: 'sb-test-auth-token=abc' } });
  assert.match(await okPage.text(), /個人理財中心/);
});

test('C3 gate：大小寫變體不可繞牆（Codex #302 實測抓到——Express 路由大小寫不敏感）', async () => {
  for (const p of ['/API/summary', '/Api/Summary', '/API/db', '/aPi/transactions']) {
    assert.equal((await fetch(`${base}${p}`)).status, 401, `${p} 未登入必 401（不可繞過小寫牆）`);
  }
  for (const p of ['/Finance/', '/FINANCE/', '/Finance']) {
    const r = await fetch(`${base}${p}`, { redirect: 'manual' });
    assert.equal(r.status, 302, `${p} 未登入必轉登入`);
  }
});

test('C3 gate：驗證服務炸掉＝fail-closed 當未登入（絕不放行）', async () => {
  const savedFail = fake.failLogin;
  fake.throwGetUser = true;
  const r = await fetch(`${base}/api/db`, { headers: { Cookie: 'sb-test-auth-token=abc' } });
  fake.throwGetUser = false;
  fake.failLogin = savedFail;
  assert.equal(r.status, 401, 'getUser 丟例外＝401，不可放行');
});

// ---- 身分牆的掛載順序（2026-07-28 修：大件 body parser 搬到 authGate 之後）----
// 病根：parser 掛在最前面＝「不管誰寄來的包裹都先全部拆開，拆完才到櫃台問這個人能不能進來」。
// 實測 10 個未登入請求 × 45MB 就把行程 OOM 打死（模擬 Render 512MB 容器）。
// 這幾題釘住「牆先發言」——它們同時是口徑考題：未登入送壞 body 拿到的是 401，不是 400/413。
test('掛載順序：未登入送壞 JSON 給大件端點＝401（不是 400——代表 parser 沒在牆前跑）', async () => {
  for (const p of ['/api/import', '/api/statement/preview', '/api/bank-statement/preview', '/api/securities/import']) {
    const r = await fetch(`${base}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN }, body: '{壞掉的 JSON',
    });
    assert.equal(r.status, 401, `${p} 回 ${r.status}——400 代表 body 已經被解析過了`);
  }
});

test('掛載順序：未登入送超過 1MB 的 body＝401（不是 413），伺服器不必吞下它', async () => {
  const big = JSON.stringify({ settings: {}, pad: 'x'.repeat(2 * 1024 * 1024) });
  const r = await fetch(`${base}/api/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN }, body: big,
  });
  assert.equal(r.status, 401, `回 ${r.status}——413 代表伺服器先收下並量了大小才想到要驗身分`);
});

test('掛載順序：跨站 Origin 的未授權請求也在 parser 之前就被擋（403，不是 400）', async () => {
  const r = await fetch(`${base}/api/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{壞掉的',
  });
  assert.equal(r.status, 403, 'CSRF 牆也該在 parser 之前發言');
});

test('掛載順序：登入端點在牆前，但仍拿得到 body（32KB 專屬 parser）；登入後大件入口照常', async () => {
  // ① 牆前的登入照常運作（body 讀得到 → 才可能回 401「信箱或密碼不正確」而不是 500）
  fake.failLogin = true;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN },
    body: JSON.stringify({ email: 'a@x.com', password: 'wrong' }),
  });
  fake.failLogin = false;
  assert.equal(login.status, 401);
  assert.match((await login.json()).error, /信箱或密碼不正確/, 'body 有被解析（否則會是別的錯）');

  // ② 登入之後，50MB 那條大件入口仍然存在（>1MB 的完整備份還原得回來——request-limits 的既有承諾）
  const payload = JSON.stringify({ settings: { usdTwd: 32 }, transactions: [], pad: 'y'.repeat(1.2 * 1024 * 1024) });
  const imp = await fetch(`${base}/api/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN, Cookie: 'sb-test-auth-token=abc' },
    body: payload,
  });
  assert.notEqual(imp.status, 413, '登入後 >1MB 的匯入不可以被 1MB 的通用 parser 擋掉');
  assert.equal(imp.status, 200, `匯入應成功，實得 ${imp.status}`);
});

// ---- 速率限制（可用性第一層，2026-07-28）----
// 只驗「牆有掛上、擋得住、訊息可操作」；計數器本身的邊界在 test/rate-limit.test.js（注入時鐘、不等真實時間）。
test('速率限制：連續猛打登入會被擋成 429＋Retry-After（保護行程，不是取代 Supabase 的防暴力）', async () => {
  fake.failLogin = true;
  let saw429 = null;
  for (let i = 0; i < 40 && !saw429; i++) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN },
      body: JSON.stringify({ email: 'a@x.com', password: 'wrong' }),
    });
    if (r.status === 429) saw429 = r;
  }
  fake.failLogin = false;
  assert.ok(saw429, '連打 40 次登入竟然沒有任何一次被限速');
  assert.ok(Number(saw429.headers.get('retry-after')) > 0, '要告訴使用者等多久，不是只說不行');
  assert.match((await saw429.json()).error, /稍等/, '訊息要可操作');
});

test('速率限制：/api/auth/me 這種輕量讀取不限速（限了只會擋到正常換頁）', async () => {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${base}/api/auth/me`);
    assert.notEqual(r.status, 429, `第 ${i + 1} 次 /api/auth/me 被限速了`);
  }
});

test('速率限制：**路徑表上的每一道**在 HOSTED 都真的擋得住（漏掛一道就會在這裡紅）', async () => {
  // ⚠️ 從 `RATE_LIMITS` 反查、不逐條手寫：手寫的話，下一個人加了第五道限速卻忘了掛，
  //    不會有任何考題紅。這一題與 `test/server.test.js` 的 LOCAL 反向題共用同一張表——
  //    一張表同時守住「HOSTED 要擋」與「LOCAL 不可以擋」兩個方向。
  const { RATE_LIMITS } = await import('../server.js');
  assert.ok(RATE_LIMITS.length >= 6, '六道限速少了一道——HOSTED 的資源或上游保護已退化');

  for (const rl of RATE_LIMITS) {
    /** @type {any} */
    let saw429 = null;
    for (let i = 0; i < rl.max + 10 && !saw429; i++) {
      const r = await fetch(`${base}${rl.probe.path}`, {
        method: rl.probe.method,
        headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN, Cookie: 'sb-test-auth-token=abc' },
        ...(rl.probe.method === 'GET' ? {} : { body: '{}' }),
      });
      if (r.status === 429) saw429 = r;
    }
    assert.ok(saw429, `「${rl.name}」的 ${rl.probe.path} 連打 ${rl.max + 10} 次都沒被擋——這道限速沒掛上`);
    assert.ok(Number(saw429.headers.get('retry-after')) > 0, `「${rl.name}」要告訴使用者等多久`);
    assert.match((await saw429.json()).error, /稍等/, `「${rl.name}」的訊息要可操作`);
  }
});

test('登入限速掛在 JSON parser **之前**：畸形 JSON 與超大 body 一樣要計次（Codex #5）', async () => {
  // 病根：body-parser 遇到壞 JSON 會在自己內部 next(err)，Express 直接跳到全域錯誤中介，
  // 中間所有一般中介層（含限速）整段被跳過。攻擊者因此有一條「無限次數、不計費」的路可以打登入端點。
  // 既有考題只送**合法** JSON，所以這個縫一直沒被抓到。
  const rl = /** @type {any} */ ((await import('../server.js')).RATE_LIMITS).find((/** @type {any} */ x) => x.stage === 'pre-gate');
  /** @param {string} body */
  const hit = (body) => fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN }, body,
  });

  let saw429 = false;
  for (let i = 0; i < rl.max + 10 && !saw429; i++) {
    const r = await hit('{ this is not json');
    if (r.status === 429) saw429 = true;
    else assert.equal(r.status, 400, `畸形 JSON 應該回 400（第 ${i + 1} 次拿到 ${r.status}）`);
  }
  assert.ok(saw429,
    `連送 ${rl.max + 10} 個畸形 JSON 都沒被限速——限速站在 parser 後面，這條路等於沒有上限`);
});

// ============================================================================
// 對外連線端點 × 速率限制的對帳（Codex 收官審查 #6，2026-07-28）
// ============================================================================
//
// 為什麼要有這一題：上一版漏掉 /api/cape、/api/realyield、/api/insights 三條對外端點，
// 而**沒有任何考題會紅**——因為所有考題都是從 `RATE_LIMITS` 反查的，漏列的當然查不到。
// 「從清單反查」只證得了「表上的每一道都掛上了」，證不了「該上表的都上了」。
//
// 所以要有第二張表（`OUTBOUND_ENDPOINTS`＝我們會去打誰）跟它對帳。
// 這一題守的不是某個 bug，是**「有人新增 fetch() 卻忘了限速」這個動作**。

test('對帳：每一條會對外連線的端點都被某道限速涵蓋（新增 fetch 卻忘了限速就會在這裡紅）', async () => {
  const { RATE_LIMITS, OUTBOUND_ENDPOINTS } = await import('../server.js');
  assert.ok(OUTBOUND_ENDPOINTS.length >= 6, '對外端點清單看起來被刪過');

  /** `app.use(路徑, …)` 是前綴比對，所以涵蓋判準也要用前綴。 */
  const covered = (/** @type {string} */ p) =>
    RATE_LIMITS.some((/** @type {any} */ rl) => rl.paths.some((/** @type {string} */ base2) =>
      p === base2 || p.startsWith(base2.endsWith('/') ? base2 : `${base2}/`)));

  /** @type {string[]} */
  const naked = [];
  for (const o of OUTBOUND_ENDPOINTS) {
    for (const p of o.paths) if (!covered(p)) naked.push(`${p}（打 ${o.host}：${o.why}）`);
  }
  assert.deepEqual(naked, [],
    `這些端點會用我們的伺服器去打上游，卻沒有任何速率限制擋著：\n  ${naked.join('\n  ')}\n` +
    '猛打它們＝拿我們的伺服器去打別人，可能害使用者被上游限流甚至停用。');
});

test('對帳（反向）：對外連線能力（字面 fetch 或 fetchImpl 慣例）只准出現在已登記的模組裡，且登記必須真的被偵測到', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join: pjoin, dirname: pdirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  // ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
  const ROOT = pjoin(pdirname(fileURLToPath(import.meta.url)), '..');
  // ⚠️ 為什麼不能只掃字面 `fetch(`（#335 複審 important，William 2026-08-01 裁決修）：
  // 可注入 `fetchImpl` 正是 AGENTS 要求的可測試慣例——market-data、stock-fundamentals 都這樣寫，
  // 字面掃描下它們**完全隱形**（實測：舊版三個登記只有 lib/ib.js 真的被掃到，其餘是空轉登記，
  // 從清單拿掉考題照綠）。下一個照慣例寫的對外模組＝不登記、不限速、零考題紅。
  // 偵測器（r1 擴大：三種日常繞法實測可穿舊版——transport = fetch 別名、node:https、globalThis['fetch']）：
  //   ①裸 fetch 識別字（呼叫、別名、預設參數都算）②fetchImpl 慣例 ③globalThis.fetch 點形式
  //   ④computed 存取（'fetch' 字串）⑤Node 網路模組 ⑥CJS require 同族 ⑦常見第三方 HTTP client。
  // 只看程式行（跳過 //、*、/* 註解行）。
  // 📜 **外連寫法契約（本題即執法點）**：lib 模組要對外一律走 fetch／fetchImpl 慣例並在 ALLOWED 登記；
  //   **禁止**直接用 node:http 家族與第三方 client——真有需要＝先來改這條偵測器並登記，讓改動可被審。
  const OUTBOUND_RE = new RegExp([
    '(^|[^.\\w])fetch\\b',
    'fetchImpl',
    'globalThis\\.fetch',
    '[\'"]fetch[\'"]',
    'node:(?:https?|http2|net|tls|dgram)\\b',
    'require\\(\\s*[\'"](?:https?|http2|net|tls|dgram)[\'"]',
    'from\\s+[\'"](?:undici|axios|node-fetch|got)[\'"]',
  ].join('|'));
  // 已知會對外的模組（端點主＝與 OUTBOUND_ENDPOINTS 對應；傳導＝把 fetchImpl 往下遞、自己不開新端點）。
  // **新增請先想清楚要不要限速。**
  const ALLOWED = new Map([
    ['lib/ib.js', '端點主：IBKR Flex（字面 fetch）'],
    ['lib/services/market-data.js', '端點主：Yahoo 報價／multpl CAPE／FRED 實質利率（fetchImpl 慣例）'],
    ['lib/services/stock-fundamentals.js', '端點主：SEC（fetchImpl 慣例＋globalThis.fetch 預設）'],
    ['lib/services/insights.js', '傳導：把 fetchImpl 傳進 market-data 的 getCape/getRealYield，自己不開新端點'],
    ['lib/services/ib-sync.js', '傳導：注入 fetchFlex（lib/ib.js），自己不開新端點'],
  ]);
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => readdirSync(pjoin(ROOT, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    if (statSync(pjoin(ROOT, rel)).isDirectory()) return walk(rel);
    return f.endsWith('.js') ? [rel] : [];
  });
  /** 只看程式行：// 行、JSDoc 的 * 行與 /* 行都跳過（註解提到慣例不算對外能力）。 @param {string} l */
  const isCodeLine = (l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); };
  /** @type {Map<string, string>} */
  const detected = new Map();
  for (const rel of walk('lib')) {
    const src = readFileSync(pjoin(ROOT, rel), 'utf8');
    const hit = src.split('\n').find((l) => isCodeLine(l) && OUTBOUND_RE.test(l));
    if (hit !== undefined) detected.set(rel, hit.trim());
  }
  // ① 正向：偵測到卻沒登記＝新的對外能力溜進來了
  const unexpected = [...detected].filter(([rel]) => !ALLOWED.has(rel)).map(([rel, line]) => `${rel}: ${line}`);
  assert.deepEqual(unexpected, [],
    `這些模組出現了未登記的對外連線能力：\n  ${unexpected.join('\n  ')}\n` +
    '請在本題 ALLOWED 寫明角色（端點主／傳導），端點主另在 server.js 的 OUTBOUND_ENDPOINTS 登記，並確認 RATE_LIMITS 涵蓋得到它的端點。');
  // ② 反向：登記了卻偵測不到＝空轉登記（絆索自己退化——#335 抓到三個登記有兩個隱形，就是這個病）
  const stale = [...ALLOWED.keys()].filter((rel) => !detected.has(rel));
  assert.deepEqual(stale, [],
    `這些登記在偵測器下是隱形的（空轉登記＝絆索退化）：\n  ${stale.join('\n  ')}\n` +
    '若模組已不再對外請移除登記；若仍對外但偵測不到＝偵測器有盲區，要先補偵測器。');
});
