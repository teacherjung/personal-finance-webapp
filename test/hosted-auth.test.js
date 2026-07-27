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

const { setSupabaseFactoryForTest, cookieAdapterFor, serializeCookie } = await import('../lib/services/auth.js');
const { isHosted, hostedConfig, originAllowed } = await import('../lib/hosted.js');
const { app } = await import('../server.js');

/** 可控假 client：紀錄呼叫、可指定回應；setAll 走真的 cookie 轉接頭驗旗標。 */
const fake = { user: { id: 'u-1', email: 'a@x.com' }, failLogin: false, cookieJar: /** @type {any[]} */ ([]) };
// 假 client **必須走真的 cookieAdapterFor→serializeCookie**（Codex #301 阻擋#2：自己 append Set-Cookie
// ＝繞過正式 serializer，旗標考題考不到真程式）。這裡只假造 Supabase 的回應，cookie 寫入走正式管線。
before(() => setSupabaseFactoryForTest((req, res) => {
  const cookies = cookieAdapterFor(req, res);
  return {
  auth: {
    signInWithPassword: async () => {
      if (fake.failLogin) return { data: {}, error: { message: 'invalid' } };
      cookies.setAll([{ name: 'sb-test-auth-token', value: 'abc' }]);
      return { data: { user: fake.user }, error: null };
    },
    signOut: async () => { cookies.setAll([{ name: 'sb-test-auth-token', value: '', options: { maxAge: 0 } }]); return { error: null }; },
    getUser: async () => (String(req.headers.cookie || '').includes('sb-test-auth-token=abc')
      ? { data: { user: fake.user } } : { data: { user: null } }),
    verifyOtp: async ({ token_hash }) => (token_hash === 'good'
      ? { data: { user: fake.user }, error: null } : { data: {}, error: { message: 'expired' } }),
    updateUser: async () => ({ error: null }),
  },
  };
}));

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
  assert.match(await (await fetch(`${base}/finance/`)).text(), /個人理財中心/, '/finance＝既有 SPA（C3 才掛 gate）');
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
