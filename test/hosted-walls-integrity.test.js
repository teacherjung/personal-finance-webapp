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
//     **身分這一維（有沒有帶 session cookie）自 r4 起兩邊都驗**（病灶ⓔ）：不帶 cookie 那一題用
//     403-vs-401 分辨牆有沒有發言，帶 cookie 那一題打的是真實 CSRF 的形狀、並且斷言資料沒被改到。
//     ⚠️ 仍做不到的：**cookie 的內容只有「有效的受害者 session」這一種**（harness 的假 client 只認
//     `sb-test-auth-token=abc`）——真有人照 cookie 的其他特徵開特例（例如只放行某個 cookie 名），
//     本檔抓不到；「有 cookie／沒 cookie」這個二分則兩邊都有題釘著。
//   ⑧**來源這一維是「樣本」不是窮舉**（r6ⓕ 之後補寫）：`LOOKALIKE_ORIGINS` 只挑了六種已知的錯法
//     （後綴接別網域／加 port／末尾斜線／換 scheme／大小寫／**同站子網域**）＋一個純跨站。
//     沒被列進去的形狀本檔抓不到——已知還存在但**沒有題釘著**的：punycode 與 IDN 同形字
//     （`https://xn--…`）、主機名尾端多一個點（`https://noteasy.com.tw.`）、多層子網域。
//     判準是「完全相等」，理論上這些都會被拒；但「理論上」不是考題，這裡照實說沒驗。
//   ⑨**「回應裡沒有完整帳號」這條斷言的射程有限**（r6ⓖ 之後補寫，措辭刻意不用「封閉」）：
//     擋得住逐字外洩、換欄位名裝它、把值用空白或 `- _ . ·` 插開打散、以及切成**同一筆裡相鄰的兩欄**。
//     **擋不住**：重新編碼（base64／hex／倒轉／字元碼陣列）、用**非分隔符**切開（`900100|****3301`）、
//     以及把兩半放到**不相鄰**的欄位。要證「任何編碼都沒外洩」是字串比對做不到的事；
//     真正承重的是**「四條使用者路徑都經過同一個 `projectAccount`」那一題**，字串比對只是在它上面加抽查。
//     ⚠️ 哪一塊有突變撐著、哪一塊沒有，逐塊寫在 `assertNoAccountLeak`／`assertNoSplitLeak` 的註解裡
//     ——**只有兩塊有專屬突變證據**（逐格正規化、相鄰兩欄）；另兩塊（逐字、整包正規化）是便宜的
//     雙保險，不可拿它們當戰功。
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
//      使用者失去辨識帳戶的唯一線索**（UI 的任何頁面都拿不到完整帳號）。
//      📌 r5 補正：這句改寫當時寫成「完整帳號依設計**永遠**不送到瀏覽器」，那句話本身是錯的——
//        **LOCAL 的 `GET /api/export` 刻意回未投影的完整 `accountNo`**（備份漏了就永久遺失），
//        而前端是 `public/modules/settings.js` 的 `<a href="/api/export" download>`＝真的經瀏覽器下載，
//        `test/server.test.js` 有考題斷言那個完整值。HOSTED 才走 `stripSecretsForBackup` 剝除。
//        ⇒ 正確的界線是「**UI 頁面**拿不到」，不是「永遠不送到瀏覽器」。
//
// ⚠️ **r4 複審第四次打回來——這次的病型跟前三次不同，所以更值得記**（2026-08-05 自審實測）：
//   ⓔ 前三輪都在補「牆有沒有蓋在路上」，r4 抓到的是**探針的形狀不對**：CSRF 接線題的每一顆探針
//      都刻意**不帶 session cookie**（403-vs-401 那顆分辨訊號就是靠「沒有身分」才分得開），
//      而**真實 CSRF 一定是帶著受害者 cookie 的跨站請求**——瀏覽器會自動附上。
//      ⇒ 這道牆「對真正的攻擊形狀」從來沒被驗過。實測繞法：`csrfOriginGuard` 第一行插一句
//        `if (String(req.headers.cookie || '').includes('sb-')) return next();`
//        ＝對帶 cookie 的請求整道牆不發言，全套 **1502/1502 綠、退出碼 0**；
//        獨立 HTTP 探針卻是 `PUT /api/settings` 帶 evil.com ＋受害者 cookie 從 403 變 200、
//        `usdTwd` 真的從 32 被寫成 999。
//      📌 教訓可複用：**「同一道牆、每顆探針都少同一個東西」是一種盲區**。少的那個東西
//        （這裡是身分）如果剛好是攻擊必備的，整組題就等於沒驗過攻擊。誠實劃界節當時列了方法維度
//        與路徑維度，唯獨沒把「每顆探針都沒有身分」這件事寫出來——**沒被寫進劃界的維度，
//        就是沒有人在看的維度**。
//      📌 併帶發現（先實測再寫）：只斷言狀態碼 403 **也不夠**。把 guard 改成先 `next()`
//        再補 `res.status(403)`（很常見的中介層順序錯），跨站 `DELETE /api/transactions/:id`
//        **回 403、交易卻真的被刪掉**。⇒ 接線題要一起斷言「資料沒被改到」，而且探針裡
//        **必須有一條不吃 body 的寫入**（吃 body 的那種會因為 403 先送出、parser 讀不到 body
//        而自然沒寫成，抓不到這顆突變）。
//
// ⚠️ **r6（＝獨立審查者對本支的第三輪）又打回來兩項——兩項都是「保證講得比考題強」**
//    （Codex 2026-08-05 提出繞法，下面兩顆都在本地逐字重放確認過）：
//   ⓕ **Origin「完全相等」的來源樣本漏了同站子網域**。繞法＝`originAllowed` 改成
//      「白名單完全相等 **或** 主機名以 `.noteasy.com.tw` 結尾就放行」，全套 **1503/1503 綠、退出碼 0**。
//      為什麼這一格特別要緊（不是隨便再加一個壞來源）：`https://evil.com` 那種**真跨站**，
//      `SameSite=Lax` 本來就不會把 session cookie 附上去，Origin 牆在那裡是雙保險；
//      而**同站子網域對瀏覽器是 same-site**（`com.tw` 是公共後綴 ⇒ 可註冊網域＝`noteasy.com.tw`，
//      `evil.noteasy.com.tw` 是它的子網域），**Lax 照送 cookie** ⇒ 這時 Origin 牆是**唯一那道防線**。
//      子網域失陷（子網域接管、佈在子網域的第三方服務被打穿）正是這條界線存在的理由。
//      ⇒ sibling 子網域進 `LOOKALIKE_ORIGINS`（判準題、無 cookie 接線題、帶受害者 cookie 的矩陣
//        三處同時吃到），而且「狀態未變」那顆刪除探針改成**每個跨站來源各配一顆哨兵交易**——
//        原本只用 `https://evil.com` 一個來源，等於「只對某一種來源開特例」照樣不會被發現。
//   ⓖ **所謂「釘值的封閉斷言」只擋逐字外洩**。繞法＝`projectAccount` 多回一個
//      `accountNoDisplay: raw.split('').join(' ')`（把帳號逐字插空白）：完整帳號可以無損復原、
//      照樣沿 POST／GET／PUT `/api/accounts` 與 GET `/api/db` 送到 UI，而全套 **1503/1503 綠、退出碼 0**。
//      ⇒ 改成**走訪回應裡的每一個鍵名與每一個值**、各自拿掉空白與 `- _ . ·` 之後再比對帳號
//        （`assertNoAccountLeak`）。
//      ⇒ 併帶自審又找到**第三顆繞法**：把帳號切成 `accountNoHead`＋`accountNoTail` 兩個相鄰欄位，
//        上面那三塊全綠（欄位之間的 `","` 不在正規化的移除清單裡，兩半永遠接不起來）。
//        ⇒ 補第四塊 `assertNoSplitLeak`（把**那一筆**的值按鍵序接起來再比），實測轉紅。
//      ⇒ 併帶**把「封閉」這個措辭收掉**：現在擋得住的是四種寫法（逐字／換鍵名／插分隔符打散／
//        切成相鄰兩欄），**擋不住**重新編碼、非分隔符切開、以及切到不相鄰的欄位。
//        誠實劃界 ⑨ 與兩支斷言的註解各記一次。
//      📌 教訓可複用：「不列舉欄位名」只解決了**列舉的維度**，沒解決**比對的方式**——
//        `includes(原字串)` 自己就是一種列舉（只列了「一模一樣」這一種寫法）。而換一種比對方式之後
//        仍然列不完（我自己馬上又找到第三顆）：所以這一組斷言的定位是**抽查**，
//        真正承重的是「四條使用者路徑都經過同一個 `projectAccount`」那一題（單一收口）。
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

/**
 * 登入後的變更／讀取請求（帶白名單 Origin 過 CSRF 牆、帶 session cookie 過身分牆）＝**正常使用者**。
 * CSRF 那一組題拿它當反面對照（證明受測的寫入路徑真的會寫），機密投影那一組題拿它跑使用者路徑。
 * @param {string} method @param {string} path @param {any} [body]
 */
const authed = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Origin: GOOD_ORIGIN, Cookie: SESSION },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

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
 * ⚠️ 下面那一題的探針**一律不帶 session cookie**，所以 CSRF 牆若沒發言，回的會是身分牆的 401——
 *    「403 還是 401」就是分辨「牆擋下了」與「請求穿過牆了」的那顆訊號。也因為沒有 session，
 *    那些探針在任何情況下都寫不進任何資料（authGate 之後才有 tenant context）。
 *    ⚠️ **但「沒有身分」正是真實 CSRF 唯一不會有的形狀**——所以同一組路徑另有一題**帶著受害者
 *    cookie** 再打一次（r4 病灶ⓔ，見下方「帶受害者 session cookie」那一題）。兩題共用這份清單。
 */
const GUARDED_PATHS = ['/api/transactions/probe-no-such-id', '/api/settings'];
/** @param {string} method @param {string} path @param {string} [origin] */
const mutating = (method, path, origin) => fetch(`${base}${path}`, {
  method, headers: origin ? { Origin: origin } : {},
});

/**
 * 「像但不是」的來源清單：前綴比對、大小寫寬鬆比對、**同站子網域放行**各會放行其中一部分。
 * ⚠️ 這是**樣本、不是窮舉**（誠實劃界 ⑧ 列了已知沒被釘住的形狀）。
 */
const LOOKALIKE_ORIGINS = [
  'https://noteasy.com.tw.evil.com',      // 後綴接別的網域（前綴比對會放行）
  'https://noteasy.com.tw:8443',          // 加 port＝不同來源
  'https://noteasy.com.tw/',              // 末尾斜線＝不同字串
  'http://noteasy.com.tw',                // 換 scheme
  'https://NOTEASY.com.tw',               // 大小寫變化（Origin 比對是逐字的）
  // 同站子網域（r6ⓕ）：`*.noteasy.com.tw` 放行的判準會讓它通過，而它是這份清單裡**最危險的一個**——
  // `com.tw` 是公共後綴 ⇒ 可註冊網域是 `noteasy.com.tw` ⇒ 這個來源對瀏覽器算 same-site，
  // `SameSite=Lax` 不會擋它帶受害者 cookie ⇒ Origin 牆是唯一那道防線。
  // ⚠️ 上面幾個的**性質不一樣，別一句「都是真跨站」帶過**（照實分類）：`https://evil.com` 才是真跨站
  //    （Lax 會先擋一層）；換 port 的其實也算 same-site；換 scheme 依 schemeful same-site 算跨站；
  //    末尾斜線與大寫主機名是**瀏覽器不會真的送出來的寫法**（Origin 不帶路徑、主機名一律小寫）——
  //    它們釘的是「判準不可以自己幫來源做正規化」，不是真實的攻擊形狀。
  'https://evil.noteasy.com.tw',
  'https://evil.com',
];

test('Origin 白名單（判準）｜必須是「完全相等」——開頭像但不是的網址一律拒絕', () => {
  // ⚠️ 改成 `some(a => origin.startsWith(a))` 之後，`https://noteasy.com.tw.evil.com`
  //    會被當成合法來源 ⇒ 第二道 CSRF 防線失效。這是典型的「前綴比對」漏洞。
  // ⚠️ 另一個實測過的鬆法（r6ⓕ）：補一句「主機名以 `.noteasy.com.tw` 結尾就放行」——
  //    看起來像「自家網域當然可以」，實際上是把**每一個子網域**都升格成可信來源，
  //    而子網域對瀏覽器算 same-site ⇒ `SameSite=Lax` 不會幫忙擋，這道牆就是唯一防線。
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

/**
 * 帶著**受害者 session cookie** 的跨站探針＝真實 CSRF 的形狀。
 * @param {string} method @param {string} path @param {string} origin @param {any} [body]
 */
const victimMutating = (method, path, origin, body) => fetch(`${base}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: SESSION },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const SENTINEL_FX = 31.5;      // 哨兵匯率：由合法來源寫進去，跨站探針之後必須原封不動
const ATTACK_FX = 999;         // 跨站探針想寫進去的值（真的寫成功＝跨站改到錢的數字）
const CONTROL_FX = 30.5;       // 反面對照用：證明這條寫入路徑真的會寫（否則「沒被改到」是空轉）

test('Origin 白名單（接線）｜帶著受害者 session cookie 的跨站變更請求（＝真實 CSRF 的形狀）一樣 403，而且資料真的沒被改到', async () => {
  // ⚠️ **r4 病灶ⓔ：上一題的每一顆探針都刻意不帶 session cookie**——403-vs-401 那顆分辨訊號
  //    就是靠「沒有身分」才分得開。可是**真實 CSRF 一定是帶著受害者 cookie 的跨站請求**
  //    （瀏覽器會自動附上），所以那道牆從來沒有被真正的攻擊形狀驗過。
  //    自審實測：在 `csrfOriginGuard` 第一行插一句
  //      `if (String(req.headers.cookie || '').includes('sb-')) return next();`
  //    ＝**對帶 cookie 的請求整道牆不發言**，全套 1502 題照樣全綠、退出碼 0；
  //    獨立 HTTP 探針同時證實 `PUT /api/settings` 帶 evil.com ＋受害者 cookie 從 403 變 200，
  //    而且真的把 `usdTwd` 從 32 寫成 999 ＝跨站寫入成功。
  //    ⇒ 這一題把「有沒有身分」補成第三個維度（方法 × 路徑 × 身分）。
  //
  // ⚠️ **兩種斷言各自擋不同的繞法，缺一不可**（先實測再寫，不憑猜測）：
  //    ①**狀態碼 403**：擋「牆對帶 cookie 的請求不發言」那一類（上面那顆突變）。
  //    ②**資料沒被改到**：擋「403 照回，但事情已經做了」那一類。實測那顆突變＝把 guard 改成
  //      先 `next()` 再補 `res.status(403)`（忘了先擋再放行的順序，很常見的中介層寫法）：
  //      跨站 `DELETE /api/transactions/:id` **回 403、交易卻真的被刪掉了**——只看狀態碼全綠。
  //      （同一顆突變對「帶 body 的寫入」抓不到：403 先送出去、request body 還沒被讀，
  //      parser 就收不到 body、handler 根本沒跑。所以①②之外還**必須有一條不吃 body 的寫入**
  //      當探針，也就是下面的 DELETE 哨兵交易——沒有它，②在任何已知突變下都不會單獨轉紅。）
  // ⚠️ **②那顆刪除探針原本只打一個來源（`https://evil.com`），r6ⓕ 起改成逐來源各一顆哨兵**：
  //    「只對某一種跨站來源開特例」的牆，在單一來源的探針下照樣全綠。最要緊的那一種就是
  //    **同站子網域**（`https://evil.noteasy.com.tw`）——它是唯一連 `SameSite=Lax` 都攔不住的形狀。
  //    突變證據（先實測再寫）＝guard 只對 `*.noteasy.com.tw` 走「先 `next()` 再補 `res.status(403)`」：
  //      ・逐來源版（現在這版）：這顆哨兵斷言轉紅（「交易卻真的不見了」），全套 fail 1、退出碼 1。
  //      ・只打 `evil.com` 的舊版：整檔 **11 題全綠**，唯一的紅是突變自己引發的
  //        `ERR_HTTP_HEADERS_SENT` 檔案層 async 雜訊——失敗項是**檔名**、不是任何斷言，那不算抓到。
  // 📌 本題用到的 `/api/settings`、`/api/transactions` 都**不在 `RATE_LIMITS` 表上**（表只涵蓋登入類、
  //    上傳解析類與會對外連線的那幾條），所以這 60 幾顆探針不需要 resetRateLimitsForTest()。

  // ── 準備哨兵：用**合法來源**把兩份可被 CSRF 改壞的東西各寫一份進去
  assert.equal((await authed('PUT', '/api/settings', { usdTwd: SENTINEL_FX })).status, 200,
    '前置：合法來源要改得動匯率（改不動的話下面「沒被改到」全是空轉）');
  const readFx = async () => (await (await authed('GET', '/api/settings')).json()).usdTwd;
  assert.equal(await readFx(), SENTINEL_FX, '前置：哨兵匯率要真的寫進去');

  /** @param {string} note */
  const seedTx = async (note) => {
    const r = await authed('POST', '/api/transactions', { date: '2026-08-05', amount: 123, type: 'expense', note });
    assert.equal(r.status, 200, `前置：建立哨兵交易應回 200，實得 ${r.status}`);
    return String((await r.json()).id);
  };
  /** @param {string} id */
  const txExists = async (id) => (await (await authed('GET', '/api/transactions')).json())
    .some((/** @type {any} */ t) => t.id === id);
  // 每一個跨站來源各配一顆自己的哨兵交易（r6ⓕ）：共用一顆的話，第一個來源刪不掉就把後面全部蓋掉了。
  /** @type {Array<[string, string]>} */
  const sentinelTxs = [];
  for (const bad of LOOKALIKE_ORIGINS) sentinelTxs.push([bad, await seedTx(`CSRF 哨兵交易（${bad} 刪不掉才算對）`)]);
  const controlTx = await seedTx('CSRF 反面對照交易（同源刪得掉才算這題不是空轉）');
  for (const [bad, id] of sentinelTxs) {
    assert.equal(await txExists(id), true, `前置：${bad} 那顆哨兵交易要真的建起來`);
  }

  // ── ① 全矩陣：四種變更方法 × 兩條路徑 × 七個「像但不是」的來源，**全部帶著受害者 cookie**
  for (const method of MUTATING_METHODS) {
    for (const path of GUARDED_PATHS) {
      for (const bad of LOOKALIKE_ORIGINS) {
        const r = await victimMutating(method, path, bad, { usdTwd: ATTACK_FX });
        assert.equal(r.status, 403,
          `${method} ${path} 帶 Origin「${bad}」＋受害者 session cookie 必須被 CSRF 牆擋成 403，實得 ${r.status}`
          + '——這是真實 CSRF 的形狀（瀏覽器會自動附上受害者 cookie）。不是 403 代表牆對「有身分的請求」'
          + '沒發言，請求已經帶著受害者身分走到 handler：跨站網頁就能改到這個帳號的資料');
        assert.match((await r.json()).error, /請求來源不被允許/, '要回我們自己的白話訊息');
      }
    }
  }

  // ── ② 危害面：跨站的「不吃 body 的寫入」（刪交易）——403 之外，東西必須還在。**逐個跨站來源各打一次**
  for (const [bad, id] of sentinelTxs) {
    const del = await victimMutating('DELETE', `/api/transactions/${id}`, bad);
    assert.equal(del.status, 403, `帶 Origin「${bad}」＋受害者 cookie 跨站刪交易應被擋成 403，實得 ${del.status}`);
    assert.equal(await txExists(id), true,
      `帶 Origin「${bad}」的跨站刪除請求雖然回了 403，交易卻真的不見了——牆是在「事情已經做完」之後才說話的`
      + '（典型寫法：先 next() 再補 res.status(403)）。狀態碼那一顆抓不到這種，只有這一顆抓得到');
  }

  // ── ③ 危害面：跨站的「吃 body 的寫入」（改匯率）——哨兵值必須原封不動
  const fxAfterAttack = await readFx();          // 只讀一次：訊息與斷言看的必須是同一個值
  assert.equal(fxAfterAttack, SENTINEL_FX,
    `跨站探針跑完之後匯率變成 ${fxAfterAttack}（應為 ${SENTINEL_FX}）——`
    + '有一顆跨站請求真的寫進去了＝CSRF 牆沒擋住錢的數字');

  // ── ④ 反面對照：同一組請求換成**合法來源**必須真的做得到事
  //    （否則「跨站刪不掉／改不到」可能只是因為這兩條路徑本來就壞掉或根本不存在，整題空轉）
  const okDel = await authed('DELETE', `/api/transactions/${controlTx}`);
  assert.equal(okDel.status, 200, `合法來源刪交易應回 200，實得 ${okDel.status}`);
  assert.equal(await txExists(controlTx), false, '合法來源的刪除要真的刪掉（證明上面那顆哨兵不是空轉）');
  assert.equal((await authed('PUT', '/api/settings', { usdTwd: CONTROL_FX })).status, 200, '合法來源要改得動匯率');
  assert.equal(await readFx(), CONTROL_FX, '合法來源的匯率修改要真的寫進去（證明上面那顆哨兵不是空轉）');
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
 * 把一個值正規化成「拿掉所有空白與常見分隔符」的樣子。
 * 由來（r6ⓖ）：外洩斷言原本只做 `includes(原字串)`，於是把帳號**逐字插空白**
 * （`raw.split('').join(' ')`）送出去就完全比不到，而那串值是可以無損復原的。
 * @param {unknown} v
 */
const squash = (v) => String(v).replace(/[\s\-_.·・]/g, '');

/**
 * 走訪 JSON 結構，收集**每一個鍵名**與**每一個原始值**（鍵名也可以被拿來裝值：`{"900100****3301": true}`）。
 * @param {unknown} v @param {string[]} [out] @returns {string[]}
 */
const scalarsOf = (v, out = []) => {
  if (Array.isArray(v)) { for (const x of v) scalarsOf(x, out); return out; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.push(k); scalarsOf(x, out); }
    return out;
  }
  if (v !== null && v !== undefined) out.push(String(v));
  return out;
};

/** 同上，但**只收值、不收鍵名**（按鍵序）——給「切成相鄰兩欄」那條斷言接起來用。
 * @param {unknown} v @param {string[]} [out] @returns {string[]} */
const valuesOf = (v, out = []) => {
  if (Array.isArray(v)) { for (const x of v) valuesOf(x, out); return out; }
  if (v && typeof v === 'object') { for (const x of Object.values(v)) valuesOf(x, out); return out; }
  if (v !== null && v !== undefined) out.push(String(v));
  return out;
};

/**
 * 「這條路的回應裡不可以有完整帳號」。**射程要照實講，不可以說成「封閉」**（r6ⓖ 的整個病灶就是
 * 措辭比考題強）——這條斷言由三塊組成，而**只有②有專屬的突變證據**，另兩塊照實標成雙保險：
 *   ①**逐字**出現在整包原始回應字串的任何位置（含鍵名）。r5 那顆突變（`accountNoDisplay: raw`）會讓
 *     它轉紅，但②同樣抓得到 ⇒ **這不算①的專屬證據**。①獨有的角落是「原始字串裡有、解析後取不到」
 *     那種寫法（例如重複鍵只留下最後一個值）——**那個角落沒有突變釘著**。
 *   ②`JSON.parse` 之後**逐格**（每個鍵名、每個值）拿掉空白與 `- _ . ·` 再比——擋「同一格的值被分隔符
 *     打散」與「換一個欄位名裝它」。**專屬突變證據＝`accountNoDisplay: raw.split('').join(' ')`**
 *     （r6ⓖ 那顆：①逐字比完全看不到它）。它看的是解析後的值，JSON 轉義寫法會被還原。
 *   ③整包原始字串照②的方式正規化再比一次。**沒有專屬的突變證據**（它是①的正規化版）——留著只因為
 *     一行很便宜。不要把它算成本輪修好的東西。
 * ⚠️ **這三塊都抓不到「值被切成兩個 JSON 欄位」**（先實測才寫：`accountNoHead`／`accountNoTail` 那顆
 *    突變在只有①②③時整檔 11/11 全綠）——欄位之間的 `","` 這類 JSON 標點不在正規化的移除清單裡，
 *    兩半永遠接不起來。那一格改由 `assertNoSplitLeak` 負責（範圍限定在那一筆，理由見它的註解）。
 * **這三塊擋不住的（不要讀成比它更強的東西）**：重新編碼（base64／hex／倒轉／字元碼陣列）、
 * 以及用**非分隔符**切開（`900100|****3301`）。本檔沒做那種比對（誠實劃界 ⑨）。
 * @param {string} via 這條路徑的名字（訊息用）
 * @param {string} bodyText 這條路徑**整包**回應的原始字串
 * @param {unknown} parsed 同一包回應 `JSON.parse` 之後的結構
 * @param {string} accountNo 存進去的那串完整帳號
 */
const assertNoAccountLeak = (via, bodyText, parsed, accountNo) => {
  const needle = squash(accountNo);
  assert.equal(bodyText.includes(accountNo), false,
    `${via}：整包回應的字串裡逐字找得到完整帳號 ${accountNo}——完整帳號不可沿這條路送到 UI`);
  for (const s of scalarsOf(parsed)) {
    assert.equal(squash(s).includes(needle), false,
      `${via}：回應裡有一格（${JSON.stringify(s).slice(0, 60)}）把空白與 - _ . · 拿掉之後就含著完整帳號 `
      + `${accountNo}——插分隔符打散不算沒外洩，那串值可以無損復原；換個欄位名裝它也一樣會紅`);
  }
  assert.equal(squash(bodyText).includes(needle), false,
    `${via}：整包回應正規化（拿掉空白與 - _ . ·）之後含著完整帳號 ${accountNo}`);
};

/**
 * 「不可以把帳號切成同一筆裡**相鄰的兩欄**送出去」（r6 自審實測補的第四塊）：
 * 把**這一筆**的值按鍵序、不放任何分隔符接起來，再比對正規化後的帳號。
 * 突變證據＝`{ ...rest, accountNoLast4, accountNoHead: raw.slice(0, 6), accountNoTail: raw.slice(6) }`
 * 在只有 `assertNoAccountLeak` 那三塊時**整檔 11/11 全綠**，補了這一塊才轉紅。
 * ⚠️ 射程（照實寫）：①只擋**相鄰**——刻意把兩半放到不相鄰的欄位，接起來就斷開了，抓不到。
 *    ②範圍刻意限定在**那一筆帳戶物件**，不是整包回應：整包的值全接起來會變成一長串數字湯，
 *      反而容易對著無關的數字誤紅（那種假紅比缺口更糟——它會教人把考題放寬）。
 * @param {string} via @param {unknown} row 這條路徑回的**那一筆**帳戶物件 @param {string} accountNo
 */
const assertNoSplitLeak = (via, row, accountNo) => {
  const joined = valuesOf(row).map(squash).join('');
  assert.equal(joined.includes(squash(accountNo)), false,
    `${via}：把這一筆的欄位值按鍵序接起來就含著完整帳號 ${accountNo}`
    + '——切成相鄰兩欄不算沒外洩，前端拼一下就復原了');
};

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
  //    「已設定（末四碼 ⋯）」提示）。真正的傷害是**顯示層說謊**：UI 的任何頁面都拿不到完整帳號，
  //    末碼就是使用者辨識「這是哪個帳戶」的唯一線索，它與帳單對不起來＝人只能靠猜，
  //    而人照著假末碼去「訂正」帳號，才會真的動到伺服器端那個會配對的欄位。
  //    （唯一例外＝LOCAL 的 `GET /api/export` 備份下載回未投影的完整帳號，見 `lib/secret-fields.js` 檔頭；
  //     那是「下載成檔案」不是「畫面上看得到」，所以不會給使用者辨識帳戶的線索。）
  // ⚠️ 這一題**只管 helper 的判準**；「使用者真正走的那幾條路有沒有用這個判準」是下一題的事（r3ⓒ）。
  // ⚠️ 兩層都要驗（r5 病灶）：`accountNo === undefined` 釘的是**欄位名**，改個鍵名就繞過去了；
  //    另一條釘的是**值**——投影出來的東西裡不可以含那串完整帳號，鍵名叫什麼都一樣。
  //    ⚠️ 而「釘值」那條 r6ⓖ 之前只做 `includes(原字串)` ＝只擋逐字，把帳號逐字插空白就穿過去了。
  //       現在走 `assertNoAccountLeak`＋`assertNoSplitLeak`（四塊斷言、射程各自明寫），
  //       而且**六顆 fixture 逐顆驗**、不只挑一顆。
  for (const f of LAST4_FIXTURES) {
    const p = projectAccount({ id: 'h', accountNo: f.accountNo });
    assert.equal(p.accountNoLast4, f.last4, `${f.accountNo} 的末碼應為 ${f.last4}：${f.why}`);
    assert.equal(/** @type {any} */ (p).accountNo, undefined, `${f.accountNo}：完整帳號不可留在投影結果裡`);
    assert.equal(p.accountNoSet, true, `${f.accountNo}：要用布林告訴前端「有設過」`);
    const via = `projectAccount(${f.accountNo}) 的回傳物件`;
    assertNoAccountLeak(via, JSON.stringify(p), p, f.accountNo);
    assertNoSplitLeak(via, p, f.accountNo);
  }
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
  //
  // ⚠️⚠️ **外洩斷言不可以列舉欄位名**（2026-08-05 自審實測的 r5 病灶）：
  //    這一題原本只斷言 `'accountNo' in got === false`——釘的是**欄位名**，不是**值**。
  //    實測繞法：`projectAccount` 回傳物件多補一個鍵
  //    （`return { ...rest, accountNoSet, accountNoLast4, accountNoDisplay: raw }`），
  //    完整帳號照樣沿著這四條路送到瀏覽器（獨立 HTTP 探針證實 POST／GET `/api/accounts`
  //    與 GET `/api/db` 三條回應都含 `"accountNoDisplay":"900100****3301"`），
  //    而全套 **1502/1502 綠、退出碼 0**。＝AGENTS.md「列舉繞法補不完就要關門」的同一個病型，
  //    只是這次列舉的是欄位名。⇒ 改成斷言**這條路的回應裡不可出現存進去的那串帳號**，不看鍵名。
  //    ⚠️⚠️ **但 r5 那一版把它寫成「封閉」是又一次 overclaim**（r6ⓖ，Codex 實測）：那條斷言只做
  //    `includes(原字串)` ＝只擋**逐字**。繞法＝`accountNoDisplay: raw.split('').join(' ')`
  //    （逐字插空白），值可以無損復原、照樣沿這四條路送到 UI，全套 **1503/1503 綠、退出碼 0**。
  //    ⇒ 改用 `assertNoAccountLeak`（逐字＋逐格正規化＋整包正規化）＋`assertNoSplitLeak`
  //      （相鄰兩欄接起來），**射程寫在兩支斷言各自的註解裡**：擋分隔符打散、換鍵名、切成相鄰兩欄；
  //      **擋不住重新編碼、非分隔符切開、切到不相鄰的欄位**。所以本題的措辭一律不用「封閉」——
  //      這一組是抽查，真正承重的是本題自己（四條路徑都經過同一個 `projectAccount`）。
  //    📌 連帶把帳戶名字從 `末碼接線 ${f.accountNo}` 改成流水號——名字本來就會被原樣回傳，
  //       把受測字串塞進名字會讓外洩斷言對著自己造的假外洩亮紅燈（那不是投影的錯）。
  for (const [i, f] of LAST4_FIXTURES.entries()) {
    const posted = await authed('POST', '/api/accounts',
      { name: `末碼接線 #${i + 1}`, type: 'cash', currency: 'TWD', balance: 0, accountNo: f.accountNo });
    assert.equal(posted.status, 200, `建立帳戶應回 200，實得 ${posted.status}`);
    const postedText = await posted.text();
    const created = JSON.parse(postedText);
    /**
     * 一條使用者路徑要同時滿足：①整包回應裡找不到完整帳號（`assertNoAccountLeak`，射程見它的註解）
     * ②那一筆的欄位形狀對（末碼是真的）。
     * @param {string} via @param {any} got @param {string} bodyText 這條路徑**整包**回應的原始字串
     */
    const check = (via, got, bodyText) => {
      assertNoAccountLeak(via, bodyText, JSON.parse(bodyText), f.accountNo);
      assert.ok(got, `${via} 找不到剛建立的帳戶（id=${created.id}）——這條路徑根本沒回這筆資料，下面的斷言會變成空轉`);
      assertNoSplitLeak(via, got, f.accountNo);
      assert.equal('accountNo' in got, false,
        `${via} 竟然把完整帳號送到瀏覽器了（${f.accountNo}）——投影在這條路上沒接上`);
      assert.equal(got.accountNoSet, true, `${via} 要用布林告訴前端「有設過」`);
      assert.equal(got.accountNoLast4, f.last4,
        `${via} 對 ${f.accountNo} 回了 ${got.accountNoLast4}，應為 ${f.last4}`
        + `（${f.wholeDigitsTail4 !== f.last4 ? `回 ${f.wholeDigitsTail4} ＝這條路自己寫了「整串數字尾四碼」；` : ''}`
        + `${f.visibleHead4 !== f.last4 ? `回 ${f.visibleHead4} ＝自己寫了「可見段前四碼」；` : ''}`
        + '兩種都是使用者路徑繞過 lib/secret-fields.js 另寫一套判準)');
    };
    check('POST /api/accounts 的回應', created, postedText);
    const listText = await (await authed('GET', '/api/accounts')).text();
    const list = JSON.parse(listText);
    check('GET /api/accounts', list.find((/** @type {any} */ a) => a.id === created.id), listText);
    const dbText = await (await authed('GET', '/api/db')).text();
    const db = JSON.parse(dbText);
    check('GET /api/db（資產頁走的那條）', (db.accounts || []).find((/** @type {any} */ a) => a.id === created.id), dbText);
    // PUT 只改名字、不送 accountNo（＝「留空＝不變更」的真實用法）：存著的帳號不可以被吐回來，
    // 末碼也要照樣是真的（`crud.js` 的 PUT 分支自己呼叫一次 `project()`）。
    const put = await authed('PUT', `/api/accounts/${created.id}`, { name: '改個名字' });
    assert.equal(put.status, 200, `更新帳戶應回 200，實得 ${put.status}`);
    const putText = await put.text();
    check('PUT /api/accounts/:id 的回應', JSON.parse(putText), putText);
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
