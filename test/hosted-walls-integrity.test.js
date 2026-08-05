// @ts-check
// 雲端防線的「牆要蓋在路上」考題（夜班稽核第四批A，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢在雲端這一片的共同結論：**牆蓋得對，但沒有考題證明它蓋在路上**。
// 四道牆各自都有「純函式層」的正確性，卻沒有一條考題釘住它真正的承重點：
//   - 身分牆之前唯一准許解析的 body 上限（32KB）→ 改成 50mb 全綠：未登入者可反覆丟大檔撐爆記憶體。
//   - CSRF Origin 白名單 → 改成「開頭符合就算」全綠：`noteasy.com.tw.evil.com` 會被當合法來源。
//   - 白名單畸形值的語意 → 改成「沒東西就一律放行」全綠。
//   - 帳號末四碼的取法 → 改成整串數字尾 4 全綠：遮罩帳號會回一個「假末碼」。
//
// ⚠️ **r1 複審把本檔的第一版打回來，病灶值得寫下來**（Codex 2026-08-05 實測，兩個 High）：
//    第一版把「牆蓋在路上」寫成**純函式與常數的斷言**——只讀 `AUTH_JSON_LIMIT`、只呼叫 `originAllowed`。
//    但真正的承重點在**接線**：
//      ① `server.js` 的 `app.use('/api/auth', express.json({ limit: AUTH_JSON_LIMIT }))`
//         → Codex 在隔離副本把它改成 `limit: '1mb'`、常數原封不動，**全綠**。
//      ② `lib/routes/auth.js` 的 `csrfOriginGuard`
//         → Codex 把 guard 改成自己 `origin.startsWith(allow)`、helper 原封不動，**全綠**。
//    ＝這正是本專案記過兩次的「中間層另寫一套判準就繞過」。常數對、helper 對，牆還是可以不在路上。
//    ⇒ 這一版起，這兩道牆改用**真的 HTTP 請求**驗收（HOSTED harness 比照 test/hosted-auth.test.js），
//      純函式那兩題保留（它們證明判準本身寫對了，是接線題的互補，不是替代）。
//
// ⚠️ 誠實劃界：**本檔仍然做不到的事**（不要把它讀成比它更強的東西）
//   ①`server.js` 的 `trust proxy`（關掉＝「每個 IP 各有額度」退化成全站共用一個額度）——
//     要驗它得偽造代理鏈（X-Forwarded-For）＋逐 IP 數額度，本檔沒做。
//   ②`lib/store-pg.js` 的未知鍵過濾與 `?? emptyFor(k)`（使用者能往 db 塞特殊名稱的鍵）——歸
//     `test/hosted-store-pg.test.js` 的租戶 harness，本檔沒做。
//   ③`lib/repo.js` 的 CAS 只重試一次、以及「找不到的資料不可白推進版本」——同上，本檔沒做。
//   ④body 上限的接線**只驗身分牆前那一道 parser**（`/api/auth` 前綴掛載的四條 POST 逐條驗）。
//     帳單（15MB）與備份（50MB）兩個入口只在本檔被當「比較基準」用（證明登入入口嚴格更小），
//     它們自己的接線沒有逐條 HTTP 驗收。
//   ⑤`projectAccount` 的「星號後末碼」在可見末碼**後面還接非數字尾綴**時（`900100****3301-01`）
//     判準仍不成立、退回整串數字尾 4（回 `0101`）。真實資料沒出現過這種寫法，本檔沒補、也沒有考題釘。
//     （星號後有空白或減號那兩種——`1234**** 56`／`1234****-56`——**已於 r3 修掉**，見下方 ⓓ。）
//   ⑥`extractLastFour` 本次只補了**第一條規則**的尾端邊界；第二、三條規則的邊界維持現狀。
//   ⑦CSRF 牆的接線逐條驗 **POST／PUT／DELETE／PATCH**（本站真的有變更路由的四種方法）。
//     guard 刻意豁免的 GET/HEAD/OPTIONS **不**在驗收範圍——那是設計（讀取請求不需要 CSRF 牆），
//     不是漏洞；把 GET 加進豁免清單不會讓任何一題轉紅，因為它本來就在裡面。
//     其餘方法（WebDAV 的 PROPFIND 之類）本站沒有任何路由，未逐條列。
//     **路徑這一維只取兩條代表**（見 `GUARDED_PATHS`）：guard 是 `app.use(csrfOriginGuard)` 全站
//     掛載、不看路徑，所以「照路徑開特例」是個很怪的改法；但要誠實講——真有人只對第三條路徑
//     開特例（例如 `/api/cards`），本檔抓不到。
//
// ⚠️ **r2 複審又打回來一次，病灶同樣值得寫下來**（2026-08-05 自審實測，兩個阻擋級 overclaim）：
//   ⓐ CSRF 接線題**只打 POST**，題名卻宣稱釘住「變更類請求」。實測把 `csrfOriginGuard` 的豁免
//      清單擴成 `GET|HEAD|OPTIONS|PUT|DELETE|PATCH`，全套 1497 題照樣全綠——而受害路由是真的
//      存在的（`lib/routes/crud.js` 的 PUT/DELETE `/api/{col}/:id`、`lib/routes/core.js` 的
//      PUT `/api/settings`）。獨立 HTTP 探針證實：evil.com 的 PUT/DELETE/PATCH 全部從 403 掉成
//      401 ＝**牆沒發言、請求已經穿過 CSRF 牆走到身分牆**。⇒ 接線題改成逐方法跑。
//   ⓑ body 上限的接線題**只打 `/api/auth/login`**，但那道 32KB parser 是
//      `app.use('/api/auth', …)` ＝**前綴掛載**，一次掛給整組 `/api/auth/*`，而 login／logout／
//      confirm／set-password 四條 POST 全在身分牆之前（authRoutes 在 `server.js:191`、authGate 在
//      192）＝未登入就打得到。實測讓 login 保持 32KB、其餘 `/api/auth` 放寬到 50mb，全套全綠——
//      檔頭點名的病灶「未登入者可反覆丟大檔撐爆記憶體」只是換一條同族端點就原樣重現。
//      ⇒ 413 探針改成對四條逐條跑。
//
// ⚠️ **r3 複審再打回來一次——第三次同一個病型，所以要寫得更難忘**（Codex 2026-08-05 實測）：
//   ⓒ 帳號末碼題**還是只驗 helper**（直接呼叫 `projectAccount`），沒有走使用者真正走的那條路。
//      Codex 在隔離副本**保留 helper 原封不動**，只讓 `lib/routes/crud.js` 的投影另寫一句
//      「整串數字尾四碼」：本檔 10/10 綠、`server.test.js` 134/134 綠、`hosted-secrets.test.js`
//      全綠，而真 HTTP 打 `/api/accounts` 送 `1234****56` 回的是 `accountNoLast4:"3456"`。
//      ＝**跟 r1 的兩個 High 同一個繞法**（中間層正確、使用者路徑另寫一套），只是換到第三格。
//      ⇒ 帳號投影也改用真 HTTP 驗收，而且**三條投影接線逐條打**：
//        `crud.js` 的 POST／GET／PUT `/api/accounts` ＋ `core.js` 的 GET `/api/db`。
//      📌 為什麼既有考題擋不住：`server.test.js` 那條 HTTP 題用的是**無星號的完整帳號**
//        （`9001001234567890` → `7890`），連遮罩分支都走不到，「整串數字尾四碼」在它身上同值。
//        ⇒ **接線題的 fixture 必須挑「helper 對、另寫一套就不同」的值**，否則走了真 HTTP 也白走。
//   ⓓ 帳號末碼的**危害說明是編的**：原本寫「猜錯末碼會讓銀行匯入配錯帳戶、甚至掛到別張卡」。
//      查證後不成立——`lib/services/bank-import.js` 的 `matchAccount` 與 `ownSuffixSet` 讀的是
//      **伺服器端的完整 `accountNo`**，`lib/statement.js` 的 `extractLastFour`（卡片末碼）更是
//      另一份資料；`accountNoLast4` 全 repo 只有 `public/modules/assets.js` 兩處顯示在用。
//      連帶地，「分隔符那題」把錯誤現況（`1234**** 56` → `3456`）鎖成紅燈的理由也是假的
//      （寫著「改判準等於改銀行配對行為」）。⇒ 本輪**直接修掉投影**（`lib/secret-fields.js` 的
//      `/\*+[\s-]*(\d+)\s*$/`），考題改成釘正確值；危害改寫成事實：**顯示層的末碼與帳單對不起來，
//      使用者失去辨識帳戶的唯一線索**（完整帳號依設計永遠不送到瀏覽器）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';

// HOSTED harness（形狀照 test/hosted-auth.test.js、test/hosted-store-pg.test.js）：
// 環境變數必須在 import server.js **之前**設好，且 STORE_FILE 指到暫存目錄——絕不碰真實資料。
const DIR = mkdtempSync(join(tmpdir(), 'finance-hosted-walls-'));
process.env.STORE_FILE = join(DIR, 'store.db');
process.env.NOTEASY_HOSTED = '1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SITE_ORIGIN = 'https://noteasy.com.tw';
process.env.NOTEASY_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const { originAllowed } = await import('../lib/hosted.js');
const { AUTH_JSON_LIMIT, STANDARD_JSON_LIMIT, BACKUP_JSON_LIMIT } = await import('../lib/http-body.js');
const { projectAccount } = await import('../lib/secret-fields.js');
const { extractLastFour } = await import('../lib/statement.js');
const { setSupabaseFactoryForTest, cookieAdapterFor } = await import('../lib/services/auth.js');
const { createFakePostgres, makeFakeSupabaseFactory } = await import('../test-doubles/fake-supabase.js');
const { app, resetRateLimitsForTest } = await import('../server.js');

const USER = { id: 'u-walls', email: 'a@x.com' };
const pg = createFakePostgres();
before(() => setSupabaseFactoryForTest(
  makeFakeSupabaseFactory({ pg, users: { abc: USER }, cookieAdapterFor })));

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;
const GOOD_ORIGIN = 'https://noteasy.com.tw';
const SESSION = 'sb-test-auth-token=abc';

after(() => {
  server.close();
  setSupabaseFactoryForTest(null);
  rmSync(DIR, { recursive: true, force: true });
});

/** '32kb' → 32768。@param {string} s */
const toBytes = (s) => {
  const m = /^(\d+)(kb|mb)$/i.exec(s);
  return Number(m?.[1] ?? 0) * (m?.[2].toLowerCase() === 'mb' ? 1024 * 1024 : 1024);
};

// ─────────────────────────────────────────────────────────────────────────────
// 一、身分牆之前的 body 上限（常數 lib/http-body.js ＋ 接線 server.js）
// ─────────────────────────────────────────────────────────────────────────────

test('身分牆前的 body 上限（常數）｜登入入口必須遠小於一般 API，而且是 KB 級', () => {
  // ⚠️ 這個常數是「HOSTED 身分牆之前唯一准許解析的 body」——牆前的每一個位元組都是未驗證流量。
  //    改成 50mb 之後，未登入的人可以反覆丟大檔把伺服器記憶體撐爆（實測 10 個未登入請求 ×45MB → OOM）。
  //    考題不寫死「32kb」這個數字（數字可以合理調整），而是釘住**它的性質**：
  //    ①單位是 kb ②數值 ≤ 64 ③嚴格小於一般 API 入口 ④嚴格小於備份入口。
  // ⚠️ 這一題**只管常數表**；「常數有沒有真的接到 parser 上」是下一題的事（r1 High①：
  //    只改接線、不動常數，這一題全綠）。
  const m = /^(\d+)(kb|mb)$/i.exec(AUTH_JSON_LIMIT);
  assert.ok(m, `AUTH_JSON_LIMIT 應該是「數字＋kb/mb」的字串，實際是 ${AUTH_JSON_LIMIT}`);
  assert.equal(m[2].toLowerCase(), 'kb',
    `登入入口必須是 KB 級（實際 ${AUTH_JSON_LIMIT}）——身分牆前的流量全部未驗證，MB 級等於開門讓人塞`);
  assert.ok(Number(m[1]) <= 64,
    `登入入口不該超過 64KB（實際 ${AUTH_JSON_LIMIT}）：body 裡只有信箱與密碼`);
  assert.ok(toBytes(AUTH_JSON_LIMIT) < toBytes(STANDARD_JSON_LIMIT),
    '登入入口必須嚴格小於一般 API 入口');
  assert.ok(toBytes(AUTH_JSON_LIMIT) < toBytes(BACKUP_JSON_LIMIT),
    '登入入口必須嚴格小於備份入口（那個是刻意大的）');
});

/**
 * 身分牆**之前**會被那道 32KB parser 蓋到的全部 POST 端點（`authRoutes` 只有這四條 POST，
 * 另一條 `/api/auth/me` 是 GET、不吃 body，未列）。
 * `server.js:190` 的 `app.use('/api/auth', express.json({ limit: AUTH_JSON_LIMIT }))` 是**前綴掛載**，
 * 一次把這道上限掛給整組 `/api/auth/*`；而 authRoutes 掛在 `server.js:191`、authGate 在 192，
 * 所以下面四條 POST **全部未登入可達**＝全部都是「牆前的未驗證流量」。
 * ⚠️ 只驗其中一條等於另外三條沒有任何考題釘著（r2 病灶ⓑ：只留 login 嚴格、其餘放寬到 50mb ⇒ 全綠）。
 * logout 也列進來：它自己不讀 body，但那道 parser 照樣會先把 body 吃下去。
 */
const PRE_GATE_POST_ROUTES = ['/api/auth/login', '/api/auth/logout', '/api/auth/confirm', '/api/auth/set-password'];

test('身分牆前的 body 上限（接線）｜牆前四條 POST 逐條超過上限＝413；小 body 仍到得了 handler；備份入口不受這道上限影響', async () => {
  // ⚠️ **這一題才是承重的那一題**（r1 High①）：Codex 把 `server.js` 的
  //    `app.use('/api/auth', express.json({ limit: AUTH_JSON_LIMIT }))` 改成 `limit: '1mb'`、
  //    常數表原封不動 ⇒ 上一題與既有 24 題 HOSTED auth 全綠。所以要走**真的 HTTP**。
  //    釘的一樣是性質不是數字：探針大小由 `AUTH_JSON_LIMIT` 算出來（上限調整不會讓這題假紅）。
  resetRateLimitsForTest();                       // 登入類限速 20 次／5 分鐘，別讓別題偷走額度
  const limit = toBytes(AUTH_JSON_LIMIT);
  const probe = limit * 2;                        // 「一定超過登入上限、又一定塞得進一般／備份入口」
  assert.ok(probe < toBytes(STANDARD_JSON_LIMIT),
    `探針 ${probe} bytes 必須仍小於一般入口 ${STANDARD_JSON_LIMIT}——否則這題證不到「登入入口比較小」，只證到「有某個上限」`);

  // ① 超過上限 → 413（body 沒有被吞下去；未登入流量到不了 handler）。
  //    **四條牆前端點逐條驗**（r2 病灶ⓑ）：413 是 parser 擋下的；400／401／200 都代表 body 已經被
  //    完整解析、只是被業務邏輯打回——那時記憶體早就吃下去了，正是這道牆要防的事。
  for (const path of PRE_GATE_POST_ROUTES) {
    const overSize = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN },
      body: JSON.stringify({ email: 'a@x.com', password: 'x'.repeat(probe) }),
    });
    assert.equal(overSize.status, 413,
      `送 ${probe} bytes 給牆前端點 ${path} 應該回 413，實得 ${overSize.status}`
      + `——200/400/401 代表這條路上掛的其實是別的（更大的）上限，常數表寫 ${AUTH_JSON_LIMIT} 只是裝飾`);
    assert.match((await overSize.json()).error, /上傳內容太大/, '要回我們自己的白話訊息');
  }

  // ② 小 body 仍然到得了 handler：回的是登入邏輯的 401（不是 parser 的 413、也不是 400）
  const small = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN },
    body: JSON.stringify({ email: 'nobody@x.com', password: 'pw' }),
  });
  assert.equal(small.status, 401, `正常大小的登入 body 必須到得了 handler，實得 ${small.status}`);
  assert.match((await small.json()).error, /信箱或密碼不正確/,
    '這句話只有 services/auth.js 的 signIn 會說——證明 body 真的被解析、handler 真的跑到了');

  // ③ 同一份大小的 body 打**備份入口**（登入後）不可以被擋：證明「登入入口嚴格更小」是真的接在路上，
  //    不是常數表上的一行字。備份還原是 AGENTS 明定不可掐死的救援入口。
  const backup = await fetch(`${base}/api/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN, Cookie: SESSION },
    body: JSON.stringify({ settings: { usdTwd: 32 }, transactions: [], pad: 'y'.repeat(probe) }),
  });
  assert.notEqual(backup.status, 413,
    `同樣 ${probe} bytes 打備份入口竟然 413——登入入口的小上限被套到全站了`);
  assert.equal(backup.status, 200, `備份還原應成功，實得 ${backup.status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、CSRF Origin 白名單（判準 lib/hosted.js ＋ 接線 lib/routes/auth.js）
// ─────────────────────────────────────────────────────────────────────────────

/** 一個沒有副作用、不吃 body、也不在限速表上的變更類請求——拿來當 CSRF 牆的探針。 @param {string} [origin] */
const postLogout = (origin) => fetch(`${base}/api/auth/logout`, {
  method: 'POST', headers: origin ? { Origin: origin } : {},
});

/** `csrfOriginGuard` 只豁免 GET/HEAD/OPTIONS ⇒ 這四種就是「變更類請求」的全部。 */
const MUTATING_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];
/**
 * 牆**後**的變更類探針路徑（都要登入才做得了事）。
 * 選這兩條是因為它們就是 r2 實測的受害者：`lib/routes/crud.js:54` 的 PUT `/api/{col}/:id`、
 * `crud.js:110` 的 DELETE `/api/{col}/:id`、`lib/routes/core.js:46` 的 PUT `/api/settings`。
 * ⚠️ **一律不帶 session cookie**，所以 CSRF 牆若沒發言，回的會是身分牆的 401——
 *    「403 還是 401」就是分辨「牆擋下了」與「請求穿過牆了」的那顆訊號。也因為沒有 session，
 *    這些探針在任何情況下都寫不進任何資料（authGate 之後才有 tenant context）。
 */
const GUARDED_PATHS = ['/api/transactions/probe-no-such-id', '/api/settings'];
/** @param {string} method @param {string} path @param {string} [origin] */
const mutating = (method, path, origin) => fetch(`${base}${path}`, {
  method, headers: origin ? { Origin: origin } : {},
});

/** 「像但不是」的來源清單：前綴比對、大小寫寬鬆比對各會放行其中一部分。 */
const LOOKALIKE_ORIGINS = [
  'https://noteasy.com.tw.evil.com',      // 後綴接別的網域（前綴比對會放行）
  'https://noteasy.com.tw:8443',          // 加 port＝不同來源
  'https://noteasy.com.tw/',              // 末尾斜線＝不同字串
  'http://noteasy.com.tw',                // 換 scheme
  'https://NOTEASY.com.tw',               // 大小寫變化（Origin 比對是逐字的）
  'https://evil.com',
];

test('Origin 白名單（判準）｜必須是「完全相等」——開頭像但不是的網址一律拒絕', () => {
  // ⚠️ 改成 `some(a => origin.startsWith(a))` 之後，`https://noteasy.com.tw.evil.com`
  //    會被當成合法來源 ⇒ 第二道 CSRF 防線失效。這是典型的「前綴比對」漏洞。
  // ⚠️ 這一題**只管 helper 的判準**；「路上那道牆有沒有用這個判準」是下一題的事（r1 High②）。
  const prev = process.env.SITE_ORIGIN;
  process.env.SITE_ORIGIN = 'https://noteasy.com.tw';
  try {
    assert.equal(originAllowed('https://noteasy.com.tw'), true, '白名單本身要放行');
    for (const bad of LOOKALIKE_ORIGINS) {
      assert.equal(originAllowed(bad), false,
        `「${bad}」不在白名單裡，必須拒絕——前綴／大小寫寬鬆比對都會讓 CSRF 防線失效`);
    }
  } finally {
    if (prev === undefined) delete process.env.SITE_ORIGIN; else process.env.SITE_ORIGIN = prev;
  }
});

test('Origin 白名單（接線）｜POST／PUT／DELETE／PATCH 四種變更請求都真的走 csrfOriginGuard：像但不是的來源一律 403（不是 401）', async () => {
  // ⚠️ **這一題才是承重的那一題**（r1 High②）：Codex 把 `csrfOriginGuard` 改成自己
  //    `origin.startsWith(allow)`、`originAllowed` 原封不動 ⇒ 判準那題與完整測試全綠。
  //    ＝「中間層另寫一套判準」這個繞法，只有走真的 HTTP 才擋得住。
  // ⚠️ **而且必須逐方法打**（r2 病灶ⓐ）：第一版只打 POST，於是「把豁免清單擴到 PUT/DELETE/PATCH」
  //    這顆突變全套 1497 題照樣全綠——受害路由卻是真的存在的（見 GUARDED_PATHS 的註解）。
  //    分辨訊號＝**403 還是 401**：403 是 CSRF 牆自己說的，401 是請求已經穿過 CSRF 牆、
  //    由後面的身分牆說的。只斷言「不是 200」抓不到這個繞法。
  const ok = await postLogout(GOOD_ORIGIN);
  assert.equal(ok.status, 200, `白名單上的 Origin 必須放行，實得 ${ok.status}`);
  for (const method of MUTATING_METHODS) {
    for (const path of GUARDED_PATHS) {
      for (const bad of LOOKALIKE_ORIGINS) {
        const r = await mutating(method, path, bad);
        assert.equal(r.status, 403,
          `${method} ${path} 帶 Origin「${bad}」必須被 CSRF 牆擋成 403，實得 ${r.status}`
          + '——401 代表這道牆把它放行了、請求已經走到身分牆：可能是方法豁免清單被擴大（牆對這個'
          + '方法根本沒發言），也可能是牆的判準比 helper 寬。兩種都只差一顆有效 cookie 就會真的改到資料');
        assert.match((await r.json()).error, /請求來源不被允許/, '要回我們自己的白話訊息');
      }
      // 反面對照（避免「整道牆一律 403」也綠）：白名單來源與沒帶 Origin 的同一個請求要**穿過**
      // 這道牆，由身分牆回 401。沒帶 Origin 照舊放行是刻意的（curl／非瀏覽器；SameSite=Lax
      // cookie 已擋跨站帶 cookie，這道是雙保險）。
      assert.equal((await mutating(method, path, GOOD_ORIGIN)).status, 401,
        `${method} ${path} 帶白名單 Origin 必須穿過 CSRF 牆、由身分牆回 401（403＝牆把合法來源也擋了）`);
      assert.equal((await mutating(method, path)).status, 401,
        `${method} ${path} 沒帶 Origin 時照舊放行到身分牆（實得非 401＝這道牆的放行條件被改了）`);
    }
  }
  // 沒帶 Origin 的變更請求不只穿過牆、還真的跑得到 handler（logout 是牆後唯一無副作用又會做事的一條）。
  assert.equal((await postLogout()).status, 200, '沒帶 Origin 的請求照舊放行');
});

test('Origin 白名單（判準）｜白名單畸形或空白時一律拒絕', () => {
  // ⚠️ 措辭要精準（r1 指出原版 overclaim）：**真的「忘記設 SITE_ORIGIN」不會走到這裡**——
  //    HOSTED 啟動時 `hostedConfig()`（lib/hosted.js）看到空字串就 fail-fast throw，服務根本起不來。
  //    這一題保護的是**「有設，但等於沒設」的畸形值**：`SITE_ORIGIN="   "`、`SITE_ORIGIN=",,"`
  //    這兩種過得了 fail-fast（非空字串），切開後卻是空白名單。
  //    改成 `allow.length === 0 || allow.includes(origin)` 之後，那種部署直接變成「誰都放行」。
  //    `''` 也一併列在下面，釘的是 `originAllowed` 自己的 fail-closed 性質（縱深防禦：
  //    就算哪天 fail-fast 被鬆掉，這個判準也不可以自己開門）。
  const prev = process.env.SITE_ORIGIN;
  try {
    for (const empty of ['', '   ', ',,']) {
      process.env.SITE_ORIGIN = empty;
      assert.equal(originAllowed('https://evil.com'), false,
        `SITE_ORIGIN=${JSON.stringify(empty)}（切開後是空白名單）時，有帶 Origin 的請求必須拒絕`
        + '——「沒東西就放行」會讓部署失誤直接變成安全洞');
      assert.equal(originAllowed(undefined), true,
        '沒有帶 Origin 的請求照舊放行（curl／同源 GET；SameSite=Lax 已擋跨站帶 cookie）');
    }
  } finally {
    if (prev === undefined) delete process.env.SITE_ORIGIN; else process.env.SITE_ORIGIN = prev;
  }
});

test('Origin 白名單（接線）｜白名單畸形時，路上那道牆也要一起拒絕（不可只有 helper 硬）', async () => {
  // 同上一題的病，但釘在**牆**上：guard 若自己補一句「白名單是空的就放行」，helper 那題照樣綠。
  const prev = process.env.SITE_ORIGIN;
  try {
    for (const malformed of ['   ', ',,']) {
      process.env.SITE_ORIGIN = malformed;
      const r = await postLogout('https://evil.com');
      assert.equal(r.status, 403,
        `SITE_ORIGIN=${JSON.stringify(malformed)} 時，跨站來源竟然拿到 ${r.status}——畸形設定不可等於整道牆消失`);
      assert.equal((await postLogout()).status, 200, '沒帶 Origin 的請求仍照舊放行');
    }
  } finally {
    if (prev === undefined) delete process.env.SITE_ORIGIN; else process.env.SITE_ORIGIN = prev;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、機密投影：末四碼不可猜錯（lib/secret-fields.js／lib/statement.js）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 帳號末碼的驗收樣本——**每一顆都挑成「helper 對、另寫一套就不同」的形狀**（r3 病灶ⓒ 的教訓：
 * `server.test.js` 那條既有 HTTP 題用無星號的 `9001001234567890`，遮罩分支根本走不到，
 * 於是「整串數字尾四碼」這顆繞法在它身上完全同值 ⇒ 走了真 HTTP 也白走）。
 * `wholeDigitsTail4` ＝把正式碼換成「整串數字尾四碼」時會回的值；`visibleHead4` ＝換成
 * `slice(0, 4)` 時會回的值。兩欄只是給訊息用的對照，斷言一律比 `last4`。
 */
const LAST4_FIXTURES = [
  { accountNo: '900100****3301', last4: '3301', wholeDigitsTail4: '3301', visibleHead4: '3301', why: '遮罩帳號要取星號後那一段（不可把前綴的數字也算進來）' },
  { accountNo: '1234****56', last4: '56', wholeDigitsTail4: '3456', visibleHead4: '56', why: '星號後只有兩碼時就只回兩碼——回 3456 是拿遮罩掉的前綴湊出來的假末碼' },
  { accountNo: '9001****123456', last4: '3456', wholeDigitsTail4: '3456', visibleHead4: '1234', why: '可見段超過四碼時要回**最後**四碼；回 1234（可見段前四碼）＝換一個維度的假末碼' },
  { accountNo: '1234**** 56', last4: '56', wholeDigitsTail4: '3456', visibleHead4: '56', why: '星號與可見末碼之間有空白（r3 修好的那一格）' },
  { accountNo: '1234****-56', last4: '56', wholeDigitsTail4: '3456', visibleHead4: '56', why: '星號與可見末碼之間有減號，同理' },
  { accountNo: '12345678901234', last4: '1234', wholeDigitsTail4: '1234', visibleHead4: '1234', why: '完整帳號（無星號）才取純數字尾四碼' },
];

test('帳號投影（判準）｜遮罩帳號要取星號後的可見末碼、而且是**最後**四碼，不可拿整串數字的尾四碼', () => {
  // ⚠️ **危害要照事實寫**（r3 病灶ⓓ）：末碼算錯**不會**造成銀行匯入配錯帳戶、也不會掛到別張卡——
  //    `lib/services/bank-import.js` 的 `matchAccount` 與 `ownSuffixSet` 讀的都是伺服器端的完整
  //    `accountNo`，卡片末碼是 `lib/statement.js` 的 `extractLastFour` 從帳單文字另抽的一份資料。
  //    `accountNoLast4` 全 repo 只有 `public/modules/assets.js` 兩處在用（帳戶表末碼欄、編輯窗的
  //    「已設定（末四碼 ⋯）」提示）。真正的傷害是**顯示層說謊**：完整帳號依設計永遠不送到瀏覽器，
  //    末碼就是使用者辨識「這是哪個帳戶」的唯一線索，它與帳單對不起來＝人只能靠猜，
  //    而人照著假末碼去「訂正」帳號，才會真的動到伺服器端那個會配對的欄位。
  // ⚠️ 這一題**只管 helper 的判準**；「使用者真正走的那幾條路有沒有用這個判準」是下一題的事（r3ⓒ）。
  for (const f of LAST4_FIXTURES) {
    assert.equal(projectAccount({ id: 'h', accountNo: f.accountNo }).accountNoLast4, f.last4,
      `${f.accountNo} 的末碼應為 ${f.last4}：${f.why}`);
  }
  const p = projectAccount({ id: 'a4', accountNo: '900100****3301' });
  assert.equal(/** @type {any} */ (p).accountNo, undefined, '完整帳號絕不可送到瀏覽器');
  assert.equal(p.accountNoSet, true, '要用布林告訴前端「有設過」');
});

/** 登入後的變更／讀取請求（帶白名單 Origin 過 CSRF 牆、帶 session 過身分牆）。 @param {string} method @param {string} path @param {any} [body] */
const authed = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN, Cookie: SESSION },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('帳號投影（接線）｜POST／GET／PUT `/api/accounts` 與 GET `/api/db` 四條使用者路徑都真的走 projectAccount', async () => {
  // ⚠️ **這一題才是承重的那一題**（r3 病灶ⓒ）：Codex 保留 `lib/secret-fields.js` 原封不動，
  //    只讓 `lib/routes/crud.js` 的投影另寫一句「整串數字尾四碼」⇒ 上一題與既有三處 projectAccount
  //    考題全綠，真 HTTP 打 `/api/accounts` 卻回 `accountNoLast4:"3456"`。
  //    ＝r1 兩個 High 的同一個繞法（中間層正確、使用者路徑另寫一套）換到第三格。
  // ⚠️ 投影的接線點有**四個**，逐條打：
  //    ①`crud.js:38` 的 `project()` 被 POST／GET／PUT `/api/{col}` 三處呼叫（DELETE 只回 `{ok:true}`，
  //      沒有投影，未列）②`core.js:20` 的 `projectDb()`（資產頁真正讀的那條）。
  //    只驗其中一條＝另外幾條可以各自另寫一套。
  for (const f of LAST4_FIXTURES) {
    const posted = await authed('POST', '/api/accounts',
      { name: `末碼接線 ${f.accountNo}`, type: 'cash', currency: 'TWD', balance: 0, accountNo: f.accountNo });
    assert.equal(posted.status, 200, `建立帳戶應回 200，實得 ${posted.status}`);
    const created = await posted.json();
    /** 一條使用者路徑回來的帳戶物件要同時滿足：不外洩完整帳號＋末碼是真的。 @param {string} via @param {any} got */
    const check = (via, got) => {
      assert.ok(got, `${via} 找不到剛建立的帳戶（id=${created.id}）——這條路徑根本沒回這筆資料，下面的斷言會變成空轉`);
      assert.equal('accountNo' in got, false,
        `${via} 竟然把完整帳號送到瀏覽器了（${f.accountNo}）——投影在這條路上沒接上`);
      assert.equal(got.accountNoSet, true, `${via} 要用布林告訴前端「有設過」`);
      assert.equal(got.accountNoLast4, f.last4,
        `${via} 對 ${f.accountNo} 回了 ${got.accountNoLast4}，應為 ${f.last4}`
        + `（${f.wholeDigitsTail4 !== f.last4 ? `回 ${f.wholeDigitsTail4} ＝這條路自己寫了「整串數字尾四碼」；` : ''}`
        + `${f.visibleHead4 !== f.last4 ? `回 ${f.visibleHead4} ＝自己寫了「可見段前四碼」；` : ''}`
        + '兩種都是使用者路徑繞過 lib/secret-fields.js 另寫一套判準)');
    };
    check('POST /api/accounts 的回應', created);
    const list = await (await authed('GET', '/api/accounts')).json();
    check('GET /api/accounts', list.find((/** @type {any} */ a) => a.id === created.id));
    const db = await (await authed('GET', '/api/db')).json();
    check('GET /api/db（資產頁走的那條）', (db.accounts || []).find((/** @type {any} */ a) => a.id === created.id));
    // PUT 只改名字、不送 accountNo（＝「留空＝不變更」的真實用法）：存著的帳號不可以被吐回來，
    // 末碼也要照樣是真的（`crud.js` 的 PUT 分支自己呼叫一次 `project()`）。
    const put = await authed('PUT', `/api/accounts/${created.id}`, { name: '改個名字' });
    assert.equal(put.status, 200, `更新帳戶應回 200，實得 ${put.status}`);
    check('PUT /api/accounts/:id 的回應', await put.json());
  }
});

test('帳單末四碼｜遮罩後接超過四碼時不可回「前」四碼（那是一個猜出來的假末碼）', () => {
  // ⚠️ 遮罩樣式結尾的 `\b` 是承重的。實測（先跑再寫，不憑猜測）：
  //      有 `\b`：'卡號 ****12345' → '2345'（退到第三條規則「該行最後一組四碼」）
  //      無 `\b`：'卡號 ****12345' → '1234'  ← 把遮罩後的**前**四碼當末碼＝猜出來的假末碼
  //    假末碼的後果＝帳單被掛到別張卡（末四碼是自動歸卡的判準）。
  //    ⚠️ 我第一版照夜班報告的建議寫成「應該回 null」，實測發現不是——契約是「回最後四碼」。
  //       報告的建議只是假設，考題要照**真實行為**寫（不然會把一個不存在的契約釘進去）。
  assert.equal(extractLastFour('卡號 ****12345'), '2345',
    '遮罩後接五碼時要回最後四碼 2345；回 1234（前四碼）＝憑空猜一個不存在的末碼');
  assert.equal(extractLastFour('卡號 **** 567890'), '7890',
    '遮罩後接六碼同理：回最後四碼，不可回 5678');
  assert.equal(extractLastFour('XXXX-1234567'), null,
    '沒有「卡號」字樣、遮罩後又接超過四碼＝抓不到，回 null 讓上層請使用者選卡（不可猜 1234）');
  // 反面：正常的四碼要抓得到（避免整條正則被關掉也綠）。
  assert.equal(extractLastFour('卡號 ****3301'), '3301', '正常的四碼要照抓');
  assert.equal(extractLastFour('末四碼 **** 5678'), '5678', '「末四碼」明寫的優先規則也要照走');
});

test('帳單末四碼｜「末四碼」那條**更優先**的規則同樣不可回前四碼（r1 Medium③：現行程式真的違反了）', () => {
  // ⚠️ 這一題連帶修了正式程式（`lib/statement.js` 的 `extractLastFour` 第一條規則）。
  //    r1 實測：`extractLastFour('末四碼 **** 12345')` → `'1234'`。
  //    病灶＝第一條規則 `/末\s*[四4]\s*碼[^\d]{0,6}(\d{4})/` **沒有尾端邊界**，
  //    而它比上一題守住的第二條（遮罩樣式，結尾有 `\b`）**先執行**——
  //    ⇒ 上一題宣稱的「不可回前四碼」在這條路徑上根本不成立，是一個假的保證。
  //    修法＝最小補丁：給第一條也加上 `(?!\d)`，跟第二條的 `\b` 同一個意思。
  //
  //    ⚠️ 修完之後的**真實行為**（先跑再寫）：
  //      '末四碼 **** 12345'      → null   ：三條規則都不成立（沒有「卡號」字樣，第三條也不接）
  //      '卡號 末四碼 **** 12345' → '2345' ：落到第三條「該行最後一組四碼」＝真正的末四碼
  //    ＝「回最後四碼，否則寧可回 null 請使用者選卡」，跟 'XXXX-1234567' 那題同一個口徑。
  //    刻意**不**讓第一條自己去猜（例如 `\d*(\d{4})`）：那等於在標籤明寫、數字卻對不上的
  //    矛盾資料上硬選一個答案，正是這一整組考題要防的「假末碼」。
  assert.equal(extractLastFour('末四碼 **** 12345'), null,
    '「末四碼」後面跟著五碼＝資料自相矛盾，回 null 讓上層請使用者選卡；回 1234 是猜的');
  assert.equal(extractLastFour('卡號 末四碼 **** 12345'), '2345',
    '同一串文字有「卡號」字樣時要落到第三條規則、回真正的最後四碼');
  // 正面：合法寫法一條都不可以被這個邊界誤殺。
  assert.equal(extractLastFour('末四碼 1234'), '1234', '「末四碼 1234」照抓');
  assert.equal(extractLastFour('卡號末4碼：5678'), '5678', '「末4碼：5678」照抓');
  assert.equal(extractLastFour('信用卡末四碼 1234 帳單'), '1234', '後面接非數字文字不受影響');
});
