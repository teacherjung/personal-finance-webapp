// C2 考題：雙模式開關／auth 端點與 cookie 旗標／CSRF Origin 牆／secret 掃描。
// 假 Supabase client 由 setSupabaseFactoryForTest 注入（比照 STORE_FILE 隔離慣例）——考題絕不打真 Supabase。
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { gitEnv } from '../lib/git-env.js';
import { injectDirtyGitEnv, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

/**
 * repo 追蹤中的檔案清單。
 *
 * ⚠️ **`env: gitEnv()` 不可省**：`GIT_DIR` 一旦被繼承（從連結工作樹 push 時 hook 環境本來就有），
 *    git 根本不看 cwd ⇒ 這份清單會變成**別棵樹**的內容，甚至變空。
 *    下面那道 secret 掃描守的是「萬能鑰匙（service_role 權杖）有沒有進 repo」，
 *    清單一被換掉它就**掃了個寂寞、回報沒有外洩**——這一族裡後果最重的一顆假綠。
 *    機制與理由在 lib/git-env.js；行為題＝本檔題名關鍵字「secret 掃描的清單不可被繼承的 GIT_*」那題。
 */
const trackedFiles = () =>
  execFileSync('git', ['ls-files'], { encoding: 'utf8', env: gitEnv() }).trim().split('\n').filter(Boolean);

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
  const files = trackedFiles();
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
  // ⚠️ 反面自檢：清單空了的話上面那圈一個檔都不讀，`hits` 當然是空的 ⇒ **零違規是假的**。
  assert.ok(files.length > 100, `追蹤檔只列到 ${files.length} 支——清單壞了，上面那道 secret 掃描是空轉的`);
});

test('⭐ secret 掃描的清單不可被繼承的 GIT_* 帶走（拿掉 env: gitEnv() 要紅）', () => {
  // ⚠️ 這一題守的是題名關鍵字「secret 掃描：repo 追蹤檔不得含 service_role 權杖」那題的**前提**：
  //    `cwd` 隔離不了 `GIT_DIR`（有它時 git 不看 cwd），而從連結工作樹 push 時 git 自己會把它
  //    塞進 hook 環境、`pre-push` 又會跑 `npm test`。清單被換成別棵樹或變空 ⇒ 那一題照樣綠，
  //    而它守的是「萬能鑰匙有沒有進 repo」。
  // ⚠️ **這一題是代理指標，射程有限**：注入的 `GIT_DIR` 是實測唯一「四種呼叫形狀通吃」的變數
  //    （對照表在 test/helpers/dirty-git-env.js 檔頭），它證明的是真實情境下結果沒被帶偏。
  //    ⚠️ 它**擋不住**「把清法退化成只刪 GIT_DIR 的列名版」——那一族由同檔的
  //    「交給 git 的環境裡不可以有任何 GIT_*」那題（直接讀子行程收到什麼）守。
  const restore = injectDirtyGitEnv();
  try {
    const files = trackedFiles();
    assert.ok(files.includes('server.js'),
      '注入髒 GIT_* 之後清單裡就沒有 server.js 了＝環境沒被隔離，secret 掃描會掃錯對象或掃到空的');
    assert.ok(files.length > 100, `注入髒 GIT_* 之後只列到 ${files.length} 支＝隔離失效`);
  } finally {
    restore();
  }
});

// ---- C3 auth gate（P1-1：只宣稱 401／轉登入，不宣稱隔離——隔離歸 C4）----
test('⭐ 模式端點｜HOSTED **已登入**回 {hosted:true}，而且只有這一個鍵（#417：匯出前告知靠它分流）', async () => {
  // ⚠️ 為什麼這一格非有不可（#417 r6 阻擋②）：契約（docs/contracts/cloud-security.md
  //    「匯出前告知的模式分流」）明列三格＝LOCAL 200／HOSTED 未登入 401／HOSTED 已登入 200。
  //    前兩格分別由 test/server.test.js 與上一題守；這一格原本**沒有考題**，而我在 server.test.js
  //    的註解裡誤稱「hosted-secrets 那支有守」——註解說謊比缺口更糟，所以補這題並改掉那句。
  // ⚠️ 這格是承重點：端點若在 HOSTED 回成 false，前端會講「匯出檔案含機密」——方向錯得**保守**、
  //    不致外洩，但雲端使用者會以為還原後不必重輸憑證。反過來 LOCAL 若回 true 才是真的危險
  //    （那一格由 server.test.js 守）。兩邊都要釘。
  const r = await fetch(`${base}/api/mode`, { headers: { Cookie: 'sb-test-auth-token=abc' } });
  assert.equal(r.status, 200, 'HOSTED 已登入要放行（它在 auth gate 後面，登入了就該回答）');
  const body = await r.json();
  assert.deepEqual(body, { hosted: true }, 'HOSTED 要回 true（回 false 會讓雲端使用者以為備份含憑證）');
  assert.deepEqual(Object.keys(body), ['hosted'],
    '只准一個鍵：契約寫明不得擴張成其他環境資訊（版本／路徑／設定都不行）');
  assert.equal(typeof body.hosted, 'boolean', '必須是布林');
});

test('C3 gate：未登入打理財 API＝401（逐 router 抽樣、含寫入方法）；白名單與公開站不受影響', async () => {
  // 各 router 抽樣（core/crud/market/ib/statement/securities/stock-fundamentals 都要在牆內）
  for (const p of ['/api/db', '/api/summary', '/api/transactions', '/api/cards', '/api/quotes/refresh-auto', '/api/ib/sync', '/api/statement/preview', '/api/securities', '/api/stock-fundamentals/CAL', '/api/export', '/api/refund-pairs', '/api/backup/daily', '/api/mode']) {
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
  const CLIENTS = 'undici|axios|node-fetch|got|@supabase\\/(?:ssr|supabase-js)';   // r11：Supabase SDK 也是網路 client
  const OUTBOUND_RE = new RegExp([
    '(^|[^.\\w])fetch\\b',                     // 裸 fetch：呼叫、別名、預設參數
    '(^|[^.\\w])WebSocket\\b',                 // Node 22+ 內建全域（r6：不需 import 就能對外）
    '(?:\\.|\\?\\.)\\s*WebSocket\\b',            // globalThis.WebSocket 成員形（r19 繞法）
    '[\'"`]WebSocket[\'"`]',                    // computed 存取
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
  // r12：角色結構化——端點主必須宣告 hosts 並與 server.js 的 OUTBOUND_ENDPOINTS 機械對帳
  //（「只補 ALLOWED 不登記端點」從此必紅）；傳導不得有 hosts。
  const ALLOWED = new Map([
    ['lib/ib.js', { role: 'endpoint', hosts: ['ndcdyn.interactivebrokers.com'], paths: ['/api/ib/sync'], why: 'IBKR Flex（字面 fetch）' }],
    ['lib/services/market-data.js', { role: 'endpoint', hosts: ['query1.finance.yahoo.com', 'www.multpl.com', 'fred.stlouisfed.org'], paths: ['/api/quotes', '/api/quotes/refresh-auto', '/api/cape', '/api/realyield'], why: 'Yahoo 報價／multpl CAPE／FRED 實質利率（fetchImpl 慣例）' }],
    ['lib/services/stock-fundamentals.js', { role: 'endpoint', hosts: ['www.sec.gov', 'data.sec.gov'], paths: ['/api/stock-fundamentals/:symbol/refresh'], why: 'SEC（fetchImpl 慣例＋globalThis.fetch 預設）' }],
    ['lib/services/insights.js', { role: 'conduit', paths: ['/api/insights'], why: '把 fetchImpl 傳進 market-data 的 getCape/getRealYield，自己不開新端點' }],
    ['lib/services/ib-sync.js', { role: 'conduit', why: '注入 fetchFlex（lib/ib.js），自己不開新端點' }],
    ['lib/services/auth.js', { role: 'endpoint', hosts: ['SUPABASE_URL（環境變數指定的 Supabase 主機）'], paths: ['/api/auth/login', '/api/auth/confirm', '/api/auth/set-password'], why: 'Supabase Auth（@supabase/ssr；HOSTED 登入／驗證）' }],
    ['lib/ai-transport.js', { role: 'endpoint', hosts: ['api.anthropic.com'], paths: ['/api/bank-statement/preview', '/api/bank-statement/apply'], why: 'AI 解析帳單（P1b-1，★3 拍板＝Anthropic；全 repo 唯一字面 fetch 的 AI 檔，只有全靜態路徑的 lib/routes/statement.js import 它組引擎。HOSTED 停止線寫死＋useAi AI 要求旗標＝實際只有 LOCAL 走得到（確認窗僅 aiAskBeforeSend 開啟時出現）；表上限速僅 HOSTED 掛載＝LOCAL 實際無 runtime 限速（r1#4 誠實句）——成本邊界＝每次上傳至多 3 發（preview 階梯 2＋apply 成功後 1 發配方生成＝P2-3）＋確認窗僅 aiAskBeforeSend=true 時出現，正式成本護欄歸 P3）' }],
  ]);
  // 只有註解提到 fetch 的檔案（生掃軌會看到、乾淨軌不會）——列出＝明示「這不是外連」。
  // ⚠️ r8→r9 收緊到**片段級**：登記「精確命中字串集合」——r8 的數量級仍有「刪一個提及＋
  //   加一個被誤吞的真外連＝count 持平」的替換路（自審發現、先修）；片段一換就紅。
  const COMMENT_MENTIONS = new Map([
    ['lib/parse-limits.js', { snippets: [' fetch'], why: 'JSDoc：readCappedText「把 fetch 的回應讀成字串」——收 Response、自己不發請求' }],
    ['lib/repo.js', { snippets: ['（fetch'], why: '註解：鐵則警告「不要在讀改寫中間夾 fetch」——規則說明、非外連' }],
    // P1b-1 的 import 紀律註解（真外連只在已登記的 lib/ai-transport.js）：三個檔案的註解都在**說明**
    // 「fetch 住哪、誰拿不到」，本身零外連——正是這道閘要的架構，說明文字照實登記。
    ['lib/ai-parse.js', { snippets: [' fetch', ' fetch'], why: '檔頭：純模組宣告「真正打 API 的 fetch 住 lib/ai-transport.js」「本檔與服務層都拿不到 fetch」——規則說明、非外連' }],
    ['lib/routes/statement.js', { snippets: [' fetch'], why: '註解：引擎組裝點說明「服務層與 crud.js 拿不到 fetch」——真外連在 ai-transport.js（已登記 ALLOWED）' }],
    ['lib/services/bank-import.js', { snippets: [' fetch'], why: '註解：import 紀律「字面 fetch 只住 lib/ai-transport.js、本檔絕不可 import 它」——規則說明、非外連' }],
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
    ['lib/pdf-isolate.js', 'PDF 抽取的行程隔離（#350，HOSTED 專用）：spawn 自己的 node（process.execPath）跑 pdf-isolate-child，帶 --max-old-space-size 讓惡意 PDF 只打死子行程。**不是對外連線**——沒有網路、只跑本機 pdfjs；子行程收 stdin 的 PDF、回 stdout 的行資料。'],
  ]);
  // r10→r11：Node 22.18+ 連 .ts/.mts/.cts 都能直接執行——「可執行」判準涵蓋全家族；
  //   另立 fail-closed 禁令：本 repo 零建置、runtime 只准 .js，出現其他可執行副檔名＝直接紅。
  /** @param {string} f */
  const isRuntimeCapable = (f) => /\.(?:js|mjs|cjs|ts|mts|cts)$/.test(f);
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => readdirSync(pjoin(ROOT, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    if (statSync(pjoin(ROOT, rel)).isDirectory()) return walk(rel);
    return isRuntimeCapable(f) ? [rel] : [];
  });
  // r11→r12：後端 runtime 不只 lib——repo.js/derive.js/insights.js 會 import public/modules 的共用
  //   模組（實測在 normalizePortfolioSymbol 藏 fetch 可穿透）。掃描範圍＝server.js＋lib 的 **import 閉包**：
  //   逐檔抽相對 import／require／動態 import，解析存在就入掃、遞迴到不動點。
  // r13：side-effect import（import './x.js';——沒有 from）也是標準 ESM，必須進閉包
  const IMPORT_SPEC_RE = /(?:from|import\s*\(|require\s*\()\s*['"`](\.[^'"`]*)['"`]|(?:^|[^.\w])import\s+['"`](\.[^'"`]*)['"`]/gm;
  /** @param {string} src @returns {string[]} */
  const extractImportSpecs = (src) => [...src.matchAll(IMPORT_SPEC_RE)].map((m) => m[1] ?? m[2]);
  /** @param {string[]} seeds @returns {string[]} */
  const importClosure = (seeds) => {
    const seen = new Set(seeds);
    const queue = [...seeds];
    while (queue.length) {
      const rel = /** @type {string} */ (queue.shift());
      const src = (() => { try { return readFileSync(pjoin(ROOT, rel), 'utf8'); } catch { return null; } })();
      if (src === null) continue;
      for (const spec of extractImportSpecs(src)) {
        let target = pjoin(pdirname(rel), spec.replace(/[?#].*$/, ''));   // r21：?query#fragment 是 URL 語意、不屬檔名
        if (!/\.[a-z]+$/i.test(target)) target += '.js';
        try { statSync(pjoin(ROOT, target)); } catch { continue; }
        if (!isRuntimeCapable(target) || seen.has(target)) continue;
        seen.add(target); queue.push(target);
      }
    }
    return [...seen];
  };
  const scanTargets = importClosure([...walk('lib'), 'server.js']);
  // 閉包機制探針：後端實際 import 的五支 public 共用模組必須在掃描範圍內（walker 壞掉就紅）
  for (const must of ['public/modules/portfolio-symbol.js', 'public/modules/categories.js', 'public/modules/portfolio-risk.js', 'public/modules/subscriptions-model.js', 'public/modules/signal-tiers.js']) {
    assert.ok(scanTargets.includes(must), `import 閉包漏了後端共用模組：${must}`);
  }
  // import 語法四型探針（r13：side-effect 型曾漏）
  assert.deepEqual(extractImportSpecs("import { a } from './x.js';"), ['./x.js'], 'from 型');
  assert.deepEqual(extractImportSpecs("const m = await import('./y.js');"), ['./y.js'], '動態型');
  assert.deepEqual(extractImportSpecs("const m = require('./z.js');"), ['./z.js'], 'CJS 型');
  assert.deepEqual(extractImportSpecs("import './side-effect.js';"), ['./side-effect.js'], 'side-effect 型（r13 繞法）');
  const nonJs = scanTargets.filter((rel) => !rel.endsWith('.js'));
  assert.deepEqual(nonJs, [],
    `掃描範圍出現非 .js 的可執行模組（本 repo 零建置、runtime 只准 .js）：\n  ${nonJs.join('\n  ')}\n` +
    'Node 22.18+ 連 .mts/.cts 都能直接跑——要引進新副檔名＝先來改這條禁令，讓改動可被審。');
  /** @type {Map<string, string>} */ const detected = new Map();
  /** @type {Map<string, string[]>} */ const rawOnly = new Map();
  /** @type {string[]} */ const spawners = [];
  /** @type {Map<string, string[]>} */ const spawnRawOnly = new Map();
  for (const rel of scanTargets) {
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
  // ②c 角色對帳（r12）：端點主的 hosts ↔ server.js OUTBOUND_ENDPOINTS 雙向；傳導不得有 hosts
  const { OUTBOUND_ENDPOINTS: OE } = await import('../server.js');
  const atomicHosts = new Set(OE.flatMap((/** @type {any} */ o) => String(o.host).split(' + ')));
  /** @type {string[]} */ const roleProblems = [];
  /** @type {Set<string>} */ const claimed = new Set();
  for (const [rel, reg] of ALLOWED) {
    if (reg.role === 'endpoint') {
      if (!reg.hosts || reg.hosts.length === 0) roleProblems.push(`${rel}：端點主必須宣告至少一個 host`);
      for (const h of reg.hosts || []) {
        if (!atomicHosts.has(h)) roleProblems.push(`${rel}：host「${h}」未登記在 OUTBOUND_ENDPOINTS`);
        claimed.add(h);
      }
    } else if (/** @type {any} */ (reg).hosts) roleProblems.push(`${rel}：傳導不得宣告 hosts`);
  }
  for (const h of atomicHosts) if (!claimed.has(h)) roleProblems.push(`OUTBOUND_ENDPOINTS 的 host「${h}」沒有任何端點主認領`);
  // r13：主機集合對帳不夠——重用既有主機開新未限速路由可繞（實測）。加**路徑級**雙向：
  //   端點主必須宣告 paths 且每條 ∈ 端點表；端點表每條 path 也要有人認領（傳導可認領自己的曝露路由）。
  const oePaths = new Set(OE.flatMap((/** @type {any} */ o) => o.paths));
  /** @type {Set<string>} */ const claimedPaths = new Set();
  for (const [rel, reg] of ALLOWED) {
    if (reg.role === 'endpoint' && (!reg.paths || reg.paths.length === 0)) roleProblems.push(`${rel}：端點主必須宣告至少一條 path`);
    for (const p of reg.paths || []) {
      if (!oePaths.has(p)) roleProblems.push(`${rel}：path「${p}」未登記在 OUTBOUND_ENDPOINTS`);
      claimedPaths.add(p);
    }
  }
  for (const p of oePaths) if (!claimedPaths.has(p)) roleProblems.push(`OUTBOUND_ENDPOINTS 的 path「${p}」沒有任何模組認領`);
  assert.deepEqual(roleProblems, [], `端點主↔端點表對帳失敗：\n  ${roleProblems.join('\n  ')}`);
  // ②d 路由錨定（r14）：兩張登記表互相一致不夠——要錨到真實 route。規則：**具外連能力的
  //   路由檔**（自身 import 閉包碰得到 ALLOWED 模組）的每條路徑，必須「登記 OUTBOUND_ENDPOINTS」
  //   或「在 ROUTE_EXEMPT 明示豁免（＝宣告此路徑不是對外入口；未來改成會觸發外連就要搬進 OE）」。
  //   新增 route 忘了登記＝紅（r14 的 /api/r14-known-host 繞法從此必死）。
  // r14→r19 統一路由參數解析器：動詞集合＝Node 官方 http.METHODS（小寫）＋all/use/route
  //   （機械完備，trace/search 等不再靠手列）；點後允許空白（r19 繞法）。第一參數規則：
  //   整顆靜態字串且以 / 開頭＝路徑（入錨定）；靜態字串非 / 開頭＝header/config getter、忽略；
  //   use 的非字串＝middleware／router 掛載、跳過；其餘（串接、模板插值、變數）＝動態禁令。
  const { METHODS: HTTP_METHODS } = await import('node:http');
  const ROUTE_VERBS = new Set([...HTTP_METHODS.map((v) => v.toLowerCase()), 'all', 'use', 'route']);
  /** @param {string} src2 @returns {{ statics: string[], dynamics: string[] }} */
  const parseRouteArgs = (src2) => {
    /** @type {string[]} */ const statics = [];
    /** @type {string[]} */ const dynamics = [];
    for (const m2 of src2.matchAll(/\.\s*([a-z]+)\s*\??\.?\s*\(\s*/g)) {   // r21：?.( optional call 也算
      if (!ROUTE_VERBS.has(/** @type {string} */ (m2[1]))) continue;
      const after = src2.slice((m2.index ?? 0) + m2[0].length, (m2.index ?? 0) + m2[0].length + 200);
      const sm = after.match(/^(['"])([^'"\n]*)\1\s*([,)])/) || after.match(/^`([^`$\n]*)`\s*([,)])/);
      if (sm) {
        const p = /** @type {string} */ (sm.length === 4 ? sm[2] : sm[1]);
        const delim = /** @type {string} */ (sm.length === 4 ? sm[3] : sm[2]);
        if (delim === ')') continue;
        if (p.startsWith('/')) statics.push(p);
        else dynamics.push(`.${m2[1]}('${p}', …)＝非 / 開頭的註冊路徑（r20：'*' 萬用等 fail-closed）`);
        continue;
      }
      if (m2[1] === 'use' && /^\[/.test(after)) {   // r21：use(['/a','/b'], h) 靜態陣列可解析
        const arr = after.match(/^\[([^\]]*)\]\s*,/);
        if (arr) {
          const items = [...arr[1].matchAll(/(['"`])([^'"`]*)\1/g)].map((x) => x[2]);
          const rest = arr[1].replace(/(['"`])[^'"`]*\1|[\s,]/g, '');
          if (rest === '' && items.length) { for (const it of items) if (it.startsWith('/')) statics.push(it); else dynamics.push(`.use([… '${it}' …])＝非 / 開頭`); continue; }
        }
        dynamics.push(`.use(${after.slice(0, 30)}…＝無法解析的陣列路徑`);
        continue;
      }
      if (m2[1] === 'use' && !/^['"`]/.test(after)) continue;
      dynamics.push(`.${m2[1]}(${after.slice(0, 30)}…`);
    }
    return { statics, dynamics };
  };
  const ROUTE_EXEMPT = new Map([
    // 口徑：key＝path（同 path 多 method 算一條）。why 的「不觸發業務上游」指不打需由
    // OUTBOUND_ENDPOINTS 限速的上游（Supabase 驗身分／資料庫 RPC 是 HOSTED 基礎設施、另有 auth 牆）。
    ['/health', '健康檢查、不觸發業務上游'],
    ['/api/auth/logout', 'Supabase 輕量 session 操作（signOut）；不限速＝2026-07-28 既有裁決'],
    ['/api/auth/me', 'Supabase 輕量 session 讀取（getUser）；不限速＝2026-07-28 既有裁決'],
    ['/api/stock-fundamentals/:symbol', '唯讀快取、不觸發 SEC 抓取（refresh 才會）'],
    ['/api/auth', 'body limit middleware 掛點（r17 起 use 帶字串入錨定）'],
    ['/finance', '靜態站掛點'],
    ['/vendor/chart.js', '靜態資源掛點'],
    ['/api', 'API 404 收尾掛點'],
    // P1b-1：lib/routes/statement.js 因組裝 AI 引擎（import lib/ai-transport.js）成為外連能力檔——
    // 但檔內只有 /api/bank-statement/preview 與 /api/bank-statement/apply 的 useAi 分支會觸發 AI 上游
    //（那兩條已登記 OUTBOUND_ENDPOINTS），其餘全是模板解析／純資料操作，逐條豁免：
    ['/api/statement/preview', '信用卡模板解析（免選卡）；不觸發 AI 上游'],
    ['/api/cards/:id/statement/preview', '信用卡模板解析（指定卡）；不觸發 AI 上游'],
    ['/api/cards/:id/statement/import', '信用卡匯入（吃已解析列）；不觸發 AI 上游'],
    ['/api/statement/password/remember', '記住帳單密碼（P0.5）；純資料操作'],
    ['/api/statement/password/clear', '清除記住的帳單密碼（P0.5）；純資料操作'],
    ['/api/statement/batches', '匯入批次清單；純資料操作'],
    ['/api/statement/batch/month', '批次改期別；純資料操作'],
    ['/api/statement/batch/delete', '整批刪除；純資料操作'],
    ['/api/statement/reassign', '批次改卡；純資料操作'],
    ['/api/statement/apply-category', '同店一起改分類；純資料操作'],
    ['/api/statement/rename-store', '店名改名；純資料操作'],
    ['/api/statement/normalize-auto', '規則指紋自動整理；純資料操作'],
    ['/api/statement/normalize-branches', '分店名整理；純資料操作'],
    ['/api/statement/health', '帳務體檢（唯讀）；純資料操作'],
    ['/api/statement/health/dismiss', '體檢項目略過；純資料操作'],
    ['/api/statement/rules', '店名規則讀寫；純資料操作'],
    ['/api/statement/rules/preview', '店名規則影響預覽；純資料操作'],
    ['/api/statement/learned/orphans', '孤兒學習規則清單（唯讀）；純資料操作'],
    ['/api/learned', '信用卡學習表清單（唯讀）；純資料操作'],
    ['/api/learned/delete', '刪除信用卡學習規則；純資料操作'],
    ['/api/bank-statement/batches', '銀行匯入批次清單；純資料操作'],
    ['/api/bank-statement/batch/delete', '銀行整批刪除；純資料操作'],
    ['/api/bank-learned', '銀行學習表清單（唯讀）；純資料操作'],
    ['/api/bank-learned/delete', '刪除銀行學習規則；純資料操作'],
    ['/api/bank-tx/apply-learned', '同類一起改（套學過規則）；純資料操作'],
  ]);
  const routeFiles = scanTargets.filter((rel) => rel.startsWith('lib/routes/') || rel === 'server.js');
  /** @type {string[]} */ const routeProblems = [];
  /** @type {string[]} */ const dynRoutes = [];
  /** @type {Set<string>} */ const seenCapablePaths = new Set();
  for (const rf of routeFiles) {
    const cl = importClosure([rf]);
    if (![...ALLOWED.keys()].some((m2) => cl.includes(m2))) continue;
    const parsed = parseRouteArgs(stripComments(readFileSync(pjoin(ROOT, rf), 'utf8')));
    for (const d of parsed.dynamics) dynRoutes.push(`${rf}: ${d}`);
    for (const p of parsed.statics) {
      seenCapablePaths.add(p);
      if (!oePaths.has(p) && !ROUTE_EXEMPT.has(p)) routeProblems.push(`${rf}: ${p}`);
    }
  }
  assert.deepEqual(dynRoutes, [],
    `具外連能力的路由檔使用非整顆靜態字串的路徑註冊（錨定抽取不到＝禁止；串接／模板／變數都算）：\n  ${dynRoutes.join('\n  ')}\n` +
    '改用完整靜態字串路徑；真需要動態＝先來改這條禁令，讓改動可被審。');
  // ②g bracket 記法禁令（r17）：routes['all'](…) 讓動詞偵測失效——具外連能力檔案禁止
  const BRACKET_ROUTE_RE = new RegExp(`\\[\\s*['"\`](?:${[...ROUTE_VERBS].join('|')})['"\`]\\s*\\]\\s*\\??\\.?\\s*\\(`);
  /** @type {string[]} */ const bracketRoutes = [];
  for (const rf of routeFiles) {
    const cl3 = importClosure([rf]);
    if (![...ALLOWED.keys()].some((m4) => cl3.includes(m4))) continue;
    if (BRACKET_ROUTE_RE.test(stripComments(readFileSync(pjoin(ROOT, rf), 'utf8')))) bracketRoutes.push(rf);
  }
  // r20：computed 動詞（routes[verb](…)）＝識別字 bracket 呼叫全面禁令（實測誤傷面＝零）
  const COMPUTED_CALL_RE = /\[\s*[A-Za-z_$][\w$]*\s*\]\s*\??\.?\s*\(/;   // r21：?.( 一併禁
  for (const rf of routeFiles) {
    const cl4 = importClosure([rf]);
    if (![...ALLOWED.keys()].some((m5) => cl4.includes(m5))) continue;
    if (COMPUTED_CALL_RE.test(stripComments(readFileSync(pjoin(ROOT, rf), 'utf8')))) bracketRoutes.push(`${rf}（computed 動詞）`);
  }
  assert.deepEqual(bracketRoutes, [], `具外連能力的路由檔使用 bracket 記法註冊（動詞偵測失效＝禁止）：\n  ${bracketRoutes.join('\n  ')}`);
  assert.ok(COMPUTED_CALL_RE.test("marketRoutes[verb]('/api/x', h)"), 'computed 動詞探針（r20 繞法）');
  assert.ok(BRACKET_ROUTE_RE.test("marketRoutes['all']('/x', h)"), 'bracket 偵測探針');
  assert.ok(BRACKET_ROUTE_RE.test("app['get']('/x', h)"), 'bracket 偵測探針：任意 receiver（r18 繞法）');
  assert.equal(parseRouteArgs("app.use ('/api/sp', h)").statics[0], '/api/sp', '動詞與括號間空白（r18 繞法）');
  assert.equal(parseRouteArgs("marketRoutes. get('/api/ds', h)").statics[0], '/api/ds', '點後空白（r19 繞法）');
  assert.equal(parseRouteArgs("r.trace('/api/tr', h)").statics[0], '/api/tr', 'METHODS 全集動詞（r19 繞法）');
  assert.deepEqual(parseRouteArgs("res.get('Origin')").statics, [], '非 / 開頭字串＝getter、不入錨定');
  assert.equal(parseRouteArgs("r.get('*', h)").dynamics.length, 1, "'*' 萬用路徑 fail-closed（r20 繞法）");
  assert.equal(parseRouteArgs("r.all('*', h)").dynamics.length, 1, "all('*') 同上");
  assert.equal(parseRouteArgs("r.get?.('/api/oc', h)").statics[0], '/api/oc', 'optional call 點記法（r21 繞法）');
  assert.deepEqual(parseRouteArgs("r.use(['/api/a1','/api/a2'], h)").statics, ['/api/a1', '/api/a2'], 'use 靜態陣列（r21 繞法）');
  assert.equal(parseRouteArgs("r.use([dyn, '/api/a3'], h)").dynamics.length, 1, 'use 陣列含變數＝fail-closed');
  assert.ok(COMPUTED_CALL_RE.test("marketRoutes[verb]?.('/x', h)"), 'computed optional call（r21 繞法）');
  assert.deepEqual(extractImportSpecs("import { a } from './x.js?review';").map((sp) => sp.replace(/[?#].*$/, '')), ['./x.js'], 'import query 剝除（r21 繞法）');
  // ②h package-imports 別名禁令（r17）：#alias 同時繞過閉包與套件分類——後端 runtime 明文禁止
  /** @type {string[]} */ const hashAliases = [];
  for (const rel of scanTargets) {
    const src4 = (() => { try { return readFileSync(pjoin(ROOT, rel), 'utf8'); } catch { return null; } })();
    if (src4 === null) continue;
    if (/(?:from|import\s*\(|require\s*\()\s*['"`]#|(?:^|[^.\w])import\s+['"`]#/m.test(stripComments(src4))) hashAliases.push(rel);
  }
  assert.deepEqual(hashAliases, [], `後端 runtime 使用 package-imports 別名（#…；繞過閉包與套件分類＝禁止）：\n  ${hashAliases.join('\n  ')}`);
  const pkgJson = JSON.parse(readFileSync(pjoin(ROOT, 'package.json'), 'utf8'));
  assert.ok(!('imports' in pkgJson), 'package.json 出現 imports 欄位（#alias 地圖）——後端 runtime 禁用，要用＝先改本禁令');
  const HASH_RE = /(?:from|import\s*\(|require\s*\()\s*['"`]#|(?:^|[^.\w])import\s+['"`]#/m;
  assert.ok(HASH_RE.test("import x from '#r17-client';"), '#alias 偵測探針');
  assert.ok(HASH_RE.test("import '#r18-client';"), '#alias side-effect 探針（r18 繞法）');
  assert.deepEqual(routeProblems, [],
    `具外連能力的路由檔出現「未登記也未豁免」的路徑：\n  ${routeProblems.join('\n  ')}\n` +
    '會觸發外連＝登記 OUTBOUND_ENDPOINTS＋確認限速；不會＝加 ROUTE_EXEMPT 附 why。');
  // 解析器探針（r16 繞法全數入陣）
  assert.deepEqual(parseRouteArgs("r.get('/api/a', h); r.all('/api/b', h); r.head('/api/c', h);").statics, ['/api/a', '/api/b', '/api/c'], '動詞覆蓋');
  assert.equal(parseRouteArgs('r.get("/api/x" + sfx, h);').dynamics.length, 1, '串接式必須歸動態（r16 繞法）');
  assert.equal(parseRouteArgs('r.get(`/api/${x}`, h);').dynamics.length, 1, '模板插值歸動態');
  assert.equal(parseRouteArgs('r.get(someVar, h);').dynamics.length, 1, '變數歸動態');
  assert.deepEqual(parseRouteArgs('r.get(`/api/static-tpl`, h);').statics, ['/api/static-tpl'], '無插值反引號＝靜態');
  // 豁免防空轉：豁免路徑必須真的存在於具外連能力檔案、且不可同時登記在 OE
  const exemptStale = [...ROUTE_EXEMPT.keys()].filter((p) => !seenCapablePaths.has(p) || oePaths.has(p));
  assert.deepEqual(exemptStale, [], `ROUTE_EXEMPT 名不符實（路徑不存在或已登記 OE）：\n  ${exemptStale.join('\n  ')}`);
  // ②f bare 套件分類登記（r16）：第三方 client 靠枚舉熱門名稱永遠列不完（superagent/ws/
  //   nodemailer 實測隱形）——改 fail-closed：掃描範圍內**每個 bare import 都必須分類**；
  //   'outbound' 類的匯入模組必須在 ALLOWED；未分類套件＝紅。
  const BARE_SPEC_RE = /(?:from|import\s*\(|require\s*\()\s*['"`]([A-Za-z@][^'"`]*)['"`]|(?:^|[^.\w])import\s+['"`]([A-Za-z@][^'"`]*)['"`]/gm;
  /** @param {string} spec */
  const pkgNameOf = (spec) => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : /** @type {string} */ (spec.split('/')[0]);
  /** @type {Map<string, {kind: 'outbound'|'safe', why: string}>} */
  const PACKAGE_REGISTRY = new Map([
    ['express', { kind: 'safe', why: 'HTTP 伺服器框架（入站）' }],
    ['@supabase/ssr', { kind: 'outbound', why: 'Supabase client——匯入者必須是 ALLOWED 端點主' }],
    ['fast-xml-parser', { kind: 'safe', why: 'XML 解析（IB Flex 回應）、零網路' }],
    ['pdfjs-dist', { kind: 'safe', why: 'PDF 解析、零網路' }],
    ['xlsx', { kind: 'safe', why: 'Excel 解析、零網路（資源上限另有考題）' }],
  ]);
  /** @type {string[]} */ const pkgProblems = [];
  /** @type {Set<string>} */ const seenPkgs = new Set();
  for (const rel of scanTargets) {
    const src3 = (() => { try { return readFileSync(pjoin(ROOT, rel), 'utf8'); } catch { return null; } })();
    if (src3 === null) continue;
    for (const m3 of stripComments(src3).matchAll(BARE_SPEC_RE)) {
      const spec3 = m3[1] ?? m3[2];
      if (spec3.startsWith('node:')) continue;   // 內建模組：網路類另有 OUTBOUND/SPAWN 專門偵測
      const pkg = pkgNameOf(spec3);
      seenPkgs.add(pkg);
      const reg = PACKAGE_REGISTRY.get(pkg);
      if (!reg) pkgProblems.push(`${rel}: 未分類套件「${pkg}」`);
      else if (reg.kind === 'outbound' && !ALLOWED.has(rel)) pkgProblems.push(`${rel}: 匯入外連套件「${pkg}」但未登記 ALLOWED`);
    }
  }
  assert.deepEqual(pkgProblems, [],
    `bare 套件分類失敗（新套件必須先分類、外連套件的匯入者必須登記）：\n  ${pkgProblems.join('\n  ')}`);
  for (const [p, reg] of PACKAGE_REGISTRY) assert.ok(reg.why.trim().length > 0, `PACKAGE_REGISTRY「${p}」缺 why`);
  for (const [k, v] of ALLOWED) assert.ok(v.why.trim().length > 0, `ALLOWED「${k}」缺 why`);
  for (const [k, v] of COMMENT_MENTIONS) assert.ok(v.why.trim().length > 0, `COMMENT_MENTIONS「${k}」缺 why`);
  for (const [k, v] of SPAWN_MENTIONS) assert.ok(v.why.trim().length > 0, `SPAWN_MENTIONS「${k}」缺 why`);
  for (const [k, v] of ROUTE_EXEMPT) assert.ok(v.trim().length > 0, `ROUTE_EXEMPT「${k}」缺 why`);
  for (const [k, v] of SPAWNERS) assert.ok(String(v).trim().length > 0, `SPAWNERS「${k}」缺 why`);
  const pkgStale = [...PACKAGE_REGISTRY.keys()].filter((p) => !seenPkgs.has(p));
  assert.deepEqual(pkgStale, [], `PACKAGE_REGISTRY 空轉登記：\n  ${pkgStale.join('\n  ')}`);
  // 分類器探針
  assert.equal(pkgNameOf('@supabase/ssr'), '@supabase/ssr', 'scoped 套件名');
  assert.equal(pkgNameOf('pdfjs-dist/legacy/build/pdf.mjs'), 'pdfjs-dist', '子路徑歸主套件');
  assert.deepEqual([...'import s from \'superagent\';'.matchAll(BARE_SPEC_RE)].map((m3) => pkgNameOf(m3[1] ?? m3[2])), ['superagent'], 'bare 抽取（r16 繞法代表）');
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
    ['WebSocket 成員形（r19 繞法）', 'export const s = (u) => new globalThis.WebSocket(u);'],
    ['WebSocket computed', "const W = globalThis['WebSocket'];"],
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
  for (const ext of ['x.js', 'x.mjs', 'x.cjs', 'x.ts', 'x.mts', 'x.cts']) assert.ok(isRuntimeCapable(ext), `walker 判準漏掃 ${ext}`);
  for (const ext of ['x.json', 'x.md']) assert.ok(!isRuntimeCapable(ext), `walker 判準誤掃 ${ext}`);
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

test('⭐ secret 掃描交給 git 的環境裡不可以有任何 GIT_*（直接斷言，不靠代理指標）', () => {
  // ⚠️ 題名關鍵字「secret 掃描的清單不可被繼承的 GIT_* 帶走」那題是**代理指標**：
  //    它問「清單對不對」，只涵蓋「剛好會改變這個指令的變數」。
  //    ⚠️ 不要寫「上一題」——本檔的題序會漂，複審實測那個指標當時指到的是外連掃描題（#463 r3）。
  //    這一題直接問子行程收到什麼——沒人見過的新家族也涵蓋得到（射程對照表在 helper 檔頭）。
  assertChildGitEnvClean(assert, 'hosted-auth 的 trackedFiles()', () => trackedFiles());
});
