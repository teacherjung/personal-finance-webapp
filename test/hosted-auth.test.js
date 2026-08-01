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
// 這一題守的不是某個 bug，是**「有人新增未登記的對外模組／能力卻忘了限速」這個動作**。
// ⚠️ 誠實劃界（r7）：已登記模組（ALLOWED）**改打新主機本題不偵測**——主機級對帳（每模組
// 主機清單×URL 掃描雙向對帳）＝另案（William 2026-08-01 裁決另開 PR）。

test('對帳：每一條會對外連線的端點都被某道限速涵蓋（新增未登記的對外能力卻忘了限速就會在這裡紅）', async () => {
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

test('對帳（反向）：對外連線能力只准出現在已登記的模組裡（雙軌偵測：剝離器 bug 永不靜默漏抓）', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join: pjoin, dirname: pdirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  // ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
  const ROOT = pjoin(pdirname(fileURLToPath(import.meta.url)), '..');
  // ⚠️ 為什麼不能只掃字面 `fetch(`（#335 複審 important，William 2026-08-01 裁決修）：可注入 fetchImpl 正是
  // AGENTS 要求的可測試慣例，字面掃描下全部隱形。r1–r5 對抗共實測十四種「日常寫法」繞法，全數入矩陣。
  // 🏗️ **架構（r5 結構性收官）＝雙軌偵測**：手寫剝離器不可能完美（JS 詞法需要真 parser——巢狀模板、
  //   regex vs 除法…每輪都能再挖出一種）。與其追求完美，改變失敗方向：
  //   乾淨軌＝去註解後掃（正常判定）；**生掃軌＝原始碼直接掃（安全網）**。剝離器任何 bug 吃掉真程式碼
  //   → 生掃軌仍命中 → 本題紅（fail-noisy）。「只有註解提到 fetch」的檔案列 COMMENT_MENTIONS（有 why、
  //   雙向防空轉）。從此剝離器品質只影響「吵不吵」，不影響「漏不漏」。
  // 📜 **外連寫法契約（本題即執法點）**：lib 模組要對外一律走 fetch／fetchImpl 慣例並在 ALLOWED 登記；
  //   **禁止**直接用 node:http 家族與第三方 client——真有需要＝先來改這條偵測器並登記，讓改動可被審。
  //   惡意混淆級（eval／字串拼接／getBuiltinModule）依威脅模型留給 code review（本絆索防「忘記登記」）。
  //   呼叫外部程式（child_process 家族）＝**需登記 SPAWNERS**（William 2026-08-01 裁決）——curl/wget 等
  //   同樣是外連通道；#350 的 PDF 行程隔離落地時在此登記。
  const CORE_NET = 'https?|http2|net|tls|dgram|dns(?:\\/promises)?';
  const CLIENTS = 'undici|axios|node-fetch|got';
  const OUTBOUND_RE = new RegExp([
    '(^|[^.\\w])fetch\\b',                     // 裸 fetch：呼叫、別名、預設參數
    '(^|[^.\\w])WebSocket\\b',                 // Node 22+ 內建全域（r6：不需 import 就能對外）
    'fetchImpl',                                // AGENTS 慣例
    '(?:\\.|\\?\\.)\\s*fetch\\b',               // 成員存取：globalThis.fetch／(globalThis).fetch／?.fetch／跨行（r4+r5）
    '[\'"`]fetch[\'"`]',                       // computed 存取
    `node:(?:${CORE_NET})\\b`,
    `(?:from|import\\s*\\(|require\\s*\\()\\s*['"\`](?:${CORE_NET})['"\`]`,
    `(?:from|import\\s*\\(|require\\s*\\()\\s*['"\`](?:${CLIENTS})['"\`]`,
  ].join('|'));
  /** 去註解掃描器（堆疊式；r5 補模板插值 \${}——巢狀反引號曾讓舊版把 URL 的 // 當註解吞掉 fetch）。
   *  字串內容原樣保留；// 與 /* 前一字元是反斜線＝不當註解（regex literal 的 \/\/）。
   *  已知殘餘（因雙軌架構已無漏抓風險，僅影響吵度）：regex vs 除法需真 parser。 @param {string} src */
  const stripComments = (src) => {
    let out = ''; let prev = '';
    /** @type {string[]} */ const stack = ['code'];
    /** @type {number[]} */ const interpDepth = [];
    for (let i = 0; i < src.length; i++) {
      const c = src[i]; const n = src[i + 1];
      const st = stack[stack.length - 1];
      if (st === 'code' || st === 'interp') {
        if (c === '/' && n === '/' && prev !== '\\') { stack.push('line'); prev = ''; i++; continue; }
        if (c === '/' && n === '*' && prev !== '\\') { stack.push('block'); prev = ''; i++; continue; }
        if (c === '\'') stack.push('s1');
        else if (c === '"') stack.push('s2');
        else if (c === '`') stack.push('tpl');
        else if (st === 'interp') {
          if (c === '{') interpDepth[interpDepth.length - 1]++;
          else if (c === '}') {
            if (interpDepth[interpDepth.length - 1] === 0) { stack.pop(); interpDepth.pop(); out += c; prev = c; continue; }
            interpDepth[interpDepth.length - 1]--;
          }
        }
        out += c; prev = c;
      } else if (st === 'line') {
        if (c === '\n') { stack.pop(); out += c; prev = ''; }
      } else if (st === 'block') {
        if (c === '*' && n === '/') { stack.pop(); i++; prev = ''; }
        else if (c === '\n') out += c;
      } else if (st === 'tpl') {
        out += c;
        if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
        if (c === '`') stack.pop();
        else if (c === '$' && n === '{') { stack.push('interp'); interpDepth.push(0); out += n; i++; }
        prev = c;
      } else {   // s1 / s2
        out += c;
        if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
        if ((st === 's1' && c === '\'') || (st === 's2' && c === '"')) stack.pop();
        else if (c === '\n') stack.pop();   // 一般字串不跨行＝未終結防呆
        prev = c;
      }
    }
    return out;
  };
  /** @param {string} text */
  const hitOn = (text) => {
    const m = OUTBOUND_RE.exec(text);
    if (!m) return null;
    return { index: m.index, snippet: m[0] };
  };
  /** 乾淨軌＋行號回報。 @param {string} src */
  const cleanHit = (src) => {
    const stripped = stripComments(src);
    const m = hitOn(stripped);
    if (!m) return null;
    const lineNo = stripped.slice(0, m.index + 1).split('\n').length;
    return `第 ${lineNo} 行：${(src.split('\n')[lineNo - 1] ?? m.snippet).trim()}`;
  };
  // 端點主＝與 OUTBOUND_ENDPOINTS 對應；傳導＝把 fetchImpl 往下遞。**新增請先想清楚要不要限速。**
  const ALLOWED = new Map([
    ['lib/ib.js', '端點主：IBKR Flex（字面 fetch）'],
    ['lib/services/market-data.js', '端點主：Yahoo 報價／multpl CAPE／FRED 實質利率（fetchImpl 慣例）'],
    ['lib/services/stock-fundamentals.js', '端點主：SEC（fetchImpl 慣例＋globalThis.fetch 預設）'],
    ['lib/services/insights.js', '傳導：把 fetchImpl 傳進 market-data 的 getCape/getRealYield，自己不開新端點'],
    ['lib/services/ib-sync.js', '傳導：注入 fetchFlex（lib/ib.js），自己不開新端點'],
  ]);
  // 只有註解提到 fetch 的檔案（生掃軌會看到、乾淨軌不會）——列出＝明示「這不是外連」。
  // ⚠️ r8→r9 收緊到**片段級**：登記「精確命中字串集合」——r8 的數量級仍有「刪一個提及＋
  //   加一個被誤吞的真外連＝count 持平」的替換路（自審發現、先修）；片段一換就紅。
  const COMMENT_MENTIONS = new Map([
    ['lib/parse-limits.js', { snippets: [' fetch'], why: 'JSDoc：readCappedText「把 fetch 的回應讀成字串」——收 Response、自己不發請求' }],
    ['lib/repo.js', { snippets: ['（fetch'], why: '註解：鐵則警告「不要在讀改寫中間夾 fetch」——規則說明、非外連' }],
  ]);
  const OUTBOUND_RE_G = new RegExp(OUTBOUND_RE.source, 'g');
  // 外部程式呼叫（child_process）＝獨立類別、需登記（William 2026-08-01 裁決）
  // ⚠️ r8：spawn 也要雙軌——只掃乾淨軌的話，一個 /[//]/ 合法 regex 就能騙剝離器吞掉 import（實測）。
  const SPAWN_RE = /node:(?:child_process|cluster)\b|(?:from|import\s*\(|require\s*\()\s*['"`](?:child_process|cluster|execa|zx|cross-spawn|shelljs)['"`]/;
  const SPAWN_RE_G = new RegExp(SPAWN_RE.source, 'g');
  // spawn 的「僅註解提及」豁免（片段級；目前 lib 無任何提及＝空）
  /** @type {Map<string, {snippets: string[], why: string}>} */
  const SPAWN_MENTIONS = new Map([]);
  /** @type {Map<string, string>} */
  const SPAWNERS = new Map([
    // 目前 lib 無任何外部程式呼叫；#350（PDF 行程隔離）落地時在此登記 pdf-isolate*.js 並附 why。
  ]);
  // r10：只掃 .js 的話，放個 .mjs/.cjs 就整個隱形（mjs 是正常 ESM 副檔名）——判準抽函式＋探針釘住
  /** @param {string} f */
  const isRuntimeModule = (f) => /\.(?:js|mjs|cjs)$/.test(f);
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => readdirSync(pjoin(ROOT, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    if (statSync(pjoin(ROOT, rel)).isDirectory()) return walk(rel);
    return isRuntimeModule(f) ? [rel] : [];
  });
  /** @type {Map<string, string>} */ const detected = new Map();
  /** @type {Map<string, string[]>} */ const rawOnly = new Map();
  /** @type {string[]} */ const spawners = [];
  /** @type {Map<string, string[]>} */ const spawnRawOnly = new Map();
  for (const rel of walk('lib')) {
    const src = readFileSync(pjoin(ROOT, rel), 'utf8');
    const stripped = stripComments(src);
    if (SPAWN_RE.test(stripped)) spawners.push(rel);
    else {
      const sm = [...src.matchAll(SPAWN_RE_G)].map((m) => m[0]);
      if (sm.length > 0) spawnRawOnly.set(rel, sm);
    }
    const clean = cleanHit(src);
    if (clean !== null) { detected.set(rel, clean); continue; }
    const rawM = [...src.matchAll(OUTBOUND_RE_G)].map((m) => m[0]);
    if (rawM.length) rawOnly.set(rel, rawM);
  }
  // ⓪ 外部程式呼叫：偵測到未登記＝紅；登記了偵測不到＝空轉、也紅
  const unregSpawn = spawners.filter((rel) => !SPAWNERS.has(rel));
  assert.deepEqual(unregSpawn, [],
    `這些模組會呼叫外部程式（child_process）卻未登記 SPAWNERS：\n  ${unregSpawn.join('\n  ')}\n` +
    'curl/wget 等同樣是外連通道（William 2026-08-01 裁決：需登記附 why）。');
  const staleSpawn = [...SPAWNERS.keys()].filter((rel) => !spawners.includes(rel));
  assert.deepEqual(staleSpawn, [], `SPAWNERS 空轉登記：\n  ${staleSpawn.join('\n  ')}`);
  // 片段級豁免對帳器（純函式＝可用合成探針釘機制，即使真實清單是空的）：
  //   正向＝raw-only 檔未登記或片段集合不符；反向＝登記了卻沒有對應 raw-only（過期）或其實是真命中（該搬家）
  /** @param {Map<string, string[]>} actual @param {Map<string, {snippets: string[], why: string}>} registry @param {(rel: string) => boolean} isReal */
  const reconcileMentions = (actual, registry, isReal) => {
    const sortEq = (/** @type {string[]} */ a, /** @type {string[]} */ b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const forward = [...actual].filter(([rel, sm]) => { const reg = registry.get(rel); return !reg || !sortEq(sm, reg.snippets); })
      .map(([rel, sm]) => `${rel}（raw 命中 ${JSON.stringify(sm)}）`);
    const backward = [...registry.keys()].filter((rel) => isReal(rel) || !actual.has(rel))
      .map((rel) => `${rel}（登記無對應提及或其實是真命中）`);
    return { forward, backward };
  };
  // ⓪b spawn 生掃安全網（r8）＋反向防空轉（r9）
  const spawnRec = reconcileMentions(spawnRawOnly, SPAWN_MENTIONS, (rel) => spawners.includes(rel));
  assert.deepEqual(spawnRec.forward, [],
    `spawn 生掃軌看到、乾淨軌沒看到，且未在 SPAWN_MENTIONS 對上片段：\n  ${spawnRec.forward.join('\n  ')}\n` +
    '若是註解提及＝登記片段；若是真程式碼＝剝離器被騙（如 regex 含 //），先修剝離器。');
  assert.deepEqual(spawnRec.backward, [], `SPAWN_MENTIONS 名不符實：\n  ${spawnRec.backward.join('\n  ')}`);
  // ① 正向：乾淨軌偵測到卻沒登記
  const unexpected = [...detected].filter(([rel]) => !ALLOWED.has(rel)).map(([rel, line]) => `${rel}: ${line}`);
  assert.deepEqual(unexpected, [],
    `這些模組出現了未登記的對外連線能力：\n  ${unexpected.join('\n  ')}\n` +
    '請在本題 ALLOWED 寫明角色（端點主／傳導），端點主另在 server.js 的 OUTBOUND_ENDPOINTS 登記，並確認 RATE_LIMITS 涵蓋得到它的端點。');
  // ①b 安全網：生掃有、乾淨軌沒有、又不在 COMMENT_MENTIONS ＝要嘛新的註解提及要登記、
  //    要嘛**剝離器把真程式碼吃掉了**——兩種都要人來看（這就是「漏抓變誤報」的機制本體）
  const outboundRec = reconcileMentions(rawOnly, COMMENT_MENTIONS, (rel) => detected.has(rel));
  const suspicious = outboundRec.forward;
  assert.deepEqual(suspicious, [],
    `生掃軌看到 fetch 相關字樣、乾淨軌沒看到，且未列 COMMENT_MENTIONS：\n  ${suspicious.join('\n  ')}\n` +
    '若只是註解提及＝加進 COMMENT_MENTIONS（附 why）；若是真程式碼＝剝離器有 bug 吃掉它，先修剝離器。');
  // ② 反向：ALLOWED 空轉（絆索退化——#335 抓到三個登記有兩個隱形）
  const stale = [...ALLOWED.keys()].filter((rel) => !detected.has(rel));
  assert.deepEqual(stale, [],
    `這些登記在偵測器下是隱形的（空轉登記）：\n  ${stale.join('\n  ')}\n` +
    '若模組已不再對外請移除登記；若仍對外但偵測不到＝偵測器有盲區，要先補偵測器。');
  // ②b COMMENT_MENTIONS 也防空轉：列了卻乾淨軌命中＝其實在對外（搬去 ALLOWED）；列了卻連生掃都沒有＝過期
  const mentionWrong = outboundRec.backward;
  assert.deepEqual(mentionWrong, [],
    `COMMENT_MENTIONS 名不符實：\n  ${mentionWrong.join('\n  ')}\n` +
    '乾淨軌命中＝真的在對外、搬去 ALLOWED；生掃也沒有＝提及已移除、刪掉這條。');
  // ③ probe matrix（r2 建議、r3–r5 擴充）：三組——必抓（乾淨軌）／註解提及（生掃攔）／完全隱形
  const PROBES = [
    ['字面 fetch 呼叫', 'return fetch(url);'],
    ['別名預設參數（r1）', 'export async function p(url, transport = fetch) { return transport(url); }'],
    ['fetchImpl 慣例', 'async function f(fetchImpl = globalThis.fetch) { return fetchImpl; }'],
    ['globalThis 點形式', 'const f = globalThis.fetch;'],
    ['global.fetch（r2）', 'export const transport = global.fetch;'],
    ['optional chaining（r3）', 'export const transport = globalThis?.fetch;'],
    ['跨行 globalThis.fetch（r4）', 'export const send = (url) => globalThis\n  .fetch(url);'],
    ['括號成員存取（r5）', 'export const outboundTransport = (globalThis).fetch;'],
    ['computed 存取（r1）', "const f = globalThis['fetch'];"],
    ['node: 前綴 ESM（r1）', "import { request } from 'node:https';"],
    ['裸核心模組 ESM（r2）', "import https from 'https';"],
    ['動態 import（r2）', "const h = await import('https');"],
    ['反引號動態 import（r3）', 'const h = await import(`https`);'],
    ['跨行動態 import（r3）', "const h = await import(\n  'https'\n);"],
    ['CJS require', "const https = require('https');"],
    ['第三方 client', "import { Agent } from 'undici';"],
    ['WebSocket 全域（r6）', 'const ws = new WebSocket(url);'],
    ['DNS 解析（r6）', "import { resolve4 } from 'node:dns/promises';"],
    ['裸 dns 模組（r6）', "const dns = require('dns/promises');"],
    ['MIME 字串不掩護同行 fetch（r4）', "const accept = '*/*'; return fetch(url);"],
    ['字串含 // 不掩護同行 fetch（r4）', "const label = ' // literal'; return fetch(url);"],
    ['反引號含 /* 不掩護同行 fetch（r4）', 'const marker = `/*`; return fetch(url);'],
    ['巢狀模板字串不掩護同行 fetch（r5）', 'return { source: `${secure ? `https://` : `http://`}example.test`, response: await fetch(url) };'],
    ['URL 字串不掩護同行 fetch', "const u = 'https://example.com'; return fetch(u);"],
    ['URL regex 不掩護同行 fetch（\\/\\/ 保護）', 'if (/^https:\\/\\//.test(u)) return fetch(u);'],
  ];
  for (const [name, snippet] of PROBES) assert.ok(cleanHit(snippet) !== null, `乾淨軌抓不到代表寫法：${name}`);
  const SPAWN_PROBES = [
    ['node: 前綴 child_process（r6）', "import { execFile } from 'node:child_process';"],
    ['裸 child_process（r6）', "const cp = require('child_process');"],
    ['動態 import child_process（r6）', "const cp = await import('child_process');"],
    ['node:cluster fork（r7）', "import cluster from 'node:cluster';"],
    ['execa 包裝器（r7）', "import { execa } from 'execa';"],
    ['zx 包裝器（r7）', "import { $ } from 'zx';"],
    ['cross-spawn（r7）', "const spawn = require('cross-spawn');"],
    ['shelljs（r8 記錄補齊）', "const sh = require('shelljs');"],
  ];
  for (const [name, snippet] of SPAWN_PROBES) assert.ok(SPAWN_RE.test(stripComments(snippet)), `SPAWN 偵測抓不到：${name}`);
  // 對帳器機制探針（r9）：真實清單可為空、機制不可真空——用合成輸入釘四種判定
  const REC_SYN = () => new Map([['x.js', { snippets: [' fetch'], why: '' }]]);
  assert.deepEqual(reconcileMentions(new Map([['x.js', [' fetch']]]), REC_SYN(), () => false), { forward: [], backward: [] }, '對帳器：片段吻合應放行');
  assert.ok(reconcileMentions(new Map([['x.js', ['（fetch']]]), REC_SYN(), () => false).forward.length === 1, '對帳器：同數量不同片段必紅');
  assert.ok(reconcileMentions(new Map(), REC_SYN(), () => false).backward.length === 1, '對帳器：假登記（無對應提及）必紅');
  assert.ok(reconcileMentions(new Map([['x.js', [' fetch']]]), REC_SYN(), () => true).backward.length === 1, '對帳器：登記檔其實是真命中必紅（該搬家）');
  // walker 副檔名探針（r10 機制洞）：.mjs/.cjs 是正常 runtime 模組、不可隱形
  for (const ext of ['x.js', 'x.mjs', 'x.cjs']) assert.ok(isRuntimeModule(ext), `walker 判準漏掃 ${ext}`);
  for (const ext of ['x.json', 'x.md', 'x.d.ts']) assert.ok(!isRuntimeModule(ext), `walker 判準誤掃 ${ext}`);
  // spawn 安全網探針（r8 機制洞）：剝離器被 regex 騙走時，生掃軌必須還看得到
  const SPAWN_NET_PROBE = 'const slashMatcher = /[//]/; const cluster2 = await import(\'node:cluster\');';
  assert.equal(SPAWN_RE.test(stripComments(SPAWN_NET_PROBE)), false, '（前提確認）此探針就是會騙過乾淨軌的形狀');
  assert.ok(SPAWN_RE.test(SPAWN_NET_PROBE), 'spawn 生掃安全網竟看不到被 regex 掩護的 import');
  const MENTION_PROBES = [
    ['行首註解', '// 這裡提到 fetch 也不算外連，但生掃軌要看得到'],
    ['JSDoc 行', '/**\n * @param {typeof fetch} fetchImpl 注入點\n */'],
    ['block comment 中段（r3）', '/*\nfetch(1);\n*/'],
    ['行尾註解', 'const a = 1; // 舊版這裡用 fetch'],
    ['無空白行尾註解（r4）', 'export const x = 1;// 舊版這裡用 fetch'],
  ];
  for (const [name, snippet] of MENTION_PROBES) {
    assert.equal(cleanHit(snippet), null, `乾淨軌誤把註解當外連：${name}`);
    assert.ok(hitOn(snippet) !== null, `生掃軌（安全網）竟看不到註解提及：${name}`);
  }
  const CLEAN = [
    ['無關程式', 'export const sum = (a, b) => a + b;'],
    ['無關字串與註解', "// 一般說明\nexport const label = 'https 之類的字省略';"],
  ];
  for (const [name, snippet] of CLEAN) assert.equal(hitOn(snippet), null, `連生掃軌都不該看到：${name}`);
});
