#!/usr/bin/env node
// @ts-check
// **Grok 沙箱專用的單向轉送器**（William 2026-08-22 裁示 B）。
//
// ## 為什麼存在
//
// macOS sandbox-exec 的網路規則只認 localhost／*，放不了特定網域（實測：`host must be * or localhost`）。
// 所以 scripts/grok-sandbox.sb 一律只准 localhost；localhost 上由這支接手，**只**轉到寫死的 UPSTREAM。
//
// ## r5／r6：credential broker（Codex r2 提、r5 再提、r6 收窄；實測 grok 不在本地驗 token，可行）
//
// 盒內 auth.json 的 `key` 是**假的**（DUMMY-SCAN-TOKEN-<每掃隨機 nonce>）；本轉送器在沙箱外持有真 access token
// （從 0700 的 authDir 讀），看到 Authorization **恰等於** `Bearer <那個假值>` 就換成真的。**真 token 從未進過盒子**。
//
// ## r6 收窄（Codex r6 #5：「替任何 DUMMY 前綴、任何 method／path 背書」＝confused deputy，且能力可跨掃描重用）
// ・假值**每掃隨機**、比對**精確相等**，不是前綴——上一掃離開來的程序拿公開前綴等不到下一掃的真 token。
// ・只轉 ALLOWED_REQUESTS 表上的 method＋path（表是 2026-08-23 用 grok 1.0.3 記錄型 proxy 實測抄的；1.0.13、1.0.40 都沒重抄——打出表外一律 403；**除了 TOLERATED_REFUSALS 上那幾個**，其餘會讓該掃退 2，由考題釘；一兩輪真掃零拒收只證明那幾輪沒打出表外下來的）；
//   其他形狀一律 403、**不轉**（轉送器不是通用 proxy）。每次拒絕寫一行 REFUSED_PREFIX 到 stderr，
//   **決定由轉送器下**（`isTolerated()`，吃結構化原值），印在拒絕行第一欄；grok-scan.js 只看那一欄。
//   第一欄不是 tolerated ＝該掃退 2——「升版多打新端點＝掃不成（吵）」由這條承重，
//   不是由 grok 自己的退出碼（r7：grok 收到 403 照常退 0，靠它就是靜默降級）。
// ・Authorization 不等於假值（含缺、含自編）＝403 不轉——不替盒內程式自編的 bearer 背書，也不讓它拿別的 token 借道。
// ・上限：每個轉送器生命週期 MAX_REQUESTS 個請求、同時 MAX_INFLIGHT 個、每個 body ≤ MAX_BODY bytes；超過＝503／413、不轉。
//
// ## 安全性質（這是全部，沒有更多）
//
// ・目的地**寫死在程式裡、不從請求取**——經過本轉送器的請求只會到 UPSTREAM。
// ・只有「假值精確相等＋形狀在白名單」的請求會帶真 token 出去；其他 header 原樣過。真 token 只存在於本程序記憶體與 authDir。
//   （「盒內程式只能跟 UPSTREAM 講話」這句是**沙箱**的保證、不是轉送器的：grok-sandbox.sb 只准連本轉送器的 port，
//   r1 時放行 localhost:* 被抓到，那時這句是假的。）
// ・只在 127.0.0.1 上聽，沙箱外的機器連不到。
// ・不看、不存、不改請求**內容**（body 原樣過；只數 bytes）。
// ・⚠️ **擋不住「把資料 POST 到 UPSTREAM 的 /v1/responses」**——那跟 grok 送 prompt 是同一條路，本來就准。
//   盒子裡放了什麼、它就能送什麼；所以盒子裡只放已 commit 的公開內容（grok-scan.js 負責）。
//
// ## 用法
//
//   node scripts/grok-relay.js <port> [--auth-dir <dir> --dummy-file <file>]
//     port **必填**；--auth-dir 給了就啟用 broker（讀 <dir>/auth.json 的 key），此時 --dummy-file 必填
//     （檔內一行＝盒內那個假值；走檔不走 argv／env——同 uid 的程序 ps 看得到 argv 與 env）；
//     啟動後 stdout 印一行 `READY <port>`（給 grok-scan.js 同步用）
//   ⚠️ 無參數＝印用法、退 2，**不啟動**——test/entry-guard.test.js 會無參數執行每支 scripts/*.js，
//      一支會永遠聽下去的伺服器會讓整套考題無聲卡死（2026-08-22 實際卡了 10 分鐘）。
//   然後 grok 以 GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:<port>/v1 啟動。
//
// UPSTREAM 是從 grok 1.0.3 執行檔裡 `strings` 出來的（`https://cli-chat-proxy.grok.com/v1`；1.0.13 於 2026-09-05、1.0.40 於 2026-09-22 各重驗一次、都相同），
// 正是 GROK_CLI_CHAT_PROXY_BASE_URL 覆寫的那一個。grok 升版若換位址，這裡要跟著改——
// 壞法是「grok 連不上」（轉送器回 502），不是靜靜放行到別處。
import http from 'node:http';
import https from 'node:https';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../lib/is-main.js';

const UPSTREAM_HOST = 'cli-chat-proxy.grok.com';
/** 盒內假 token 的固定前綴——後面接每掃隨機的 nonce；轉送器比對的是**整個值**，前綴只是讓人一眼認出它是假的 */
export const DUMMY_BEARER_PREFIX = 'DUMMY-SCAN-TOKEN-';
/**
 * grok 1.0.3 實際會打的形狀（1.0.13、1.0.40 都沒重抄；打出表外一律 403，**除了 TOLERATED_REFUSALS 上那幾個**其餘讓該掃退 2）
 * （2026-08-23 記錄型 proxy 實測：-p 模式、跑 bash 與讀檔工具各一次）。
 * 刻意**不放**（三個，都在 TOLERATED_REFUSALS 裡＝繼續擋、但拒絕不讓掃描失敗）：
 *   ・GET /v1/bundle/archive、GET /v1/subagents/bundle——下載可執行 bundle；釘了執行檔雜湊卻放行遠端換程式碼就自相矛盾。
 *   ・GET /——根路徑；**在 1.0.40 的那次掃描首次觀察到**（#634 的掃描被自己的拒絕閘擋下來才發現；
 *     中間版本沒重抄，定位不了是哪一版開始打的）。
 * 前兩個實測擋掉 grok 照常回答；`GET /` 只量到「那次被擋之後 grok 仍正常退出並產生輸出」——
 * **沒有量**內容完整性或能力有沒有降級（沒有對照組）。path 只比 pathname，query 原樣過（上限見 MAX_PATH）。
 */
export const ALLOWED_REQUESTS = Object.freeze([
  { method: 'GET', path: /^\/v1\/models$/ },
  { method: 'GET', path: /^\/v1\/settings$/ },
  { method: 'GET', path: /^\/v1\/feedback\/config$/ },
  { method: 'POST', path: /^\/v1\/responses$/ },
  { method: 'POST', path: /^\/v1\/sessions\/[0-9a-f-]{36}\/signals$/ },
  { method: 'POST', path: /^\/v1\/sessions\/[0-9a-f-]{36}\/turn-deltas$/ },
  { method: 'POST', path: /^\/v1\/traces$/ },
]);
/** 拒絕記錄的行首（grok-scan.js 用它解析 stderr） */
export const REFUSED_PREFIX = '[relay] refused: ';
/**
 * 刻意擋、而且**沒有證據顯示擋它會讓 grok 做不完事**的形狀——`isTolerated()` 只對這幾把鑰匙回 true。
 * ⚠️ 射程逐筆不同，見下面每一筆自己的說明；不要把它讀成「擋了完全沒影響」。
 * 前兩個是「下載可執行 bundle」：釘了執行檔雜湊卻放行遠端換碼自相矛盾。subagents/bundle 是 #500 第一次正式掃描（2026-08-23）
 * 被自己的拒絕閘擋下來才發現的——`--no-subagents` 下 grok 仍會去拿；那次掃描照設計退 2、輸出丟棄，這裡補上後重掃。
 *
 * `GET /` 是**同一個劇本第二次**：#634 把執行檔釘值升到 1.0.40 之後，那支的複審後掃就被自己的拒絕閘擋下來
 * （2026-09-22T08:31:55.571Z〜08:58:07.149Z，腳本印「轉送器拒絕了 1 個不在白名單的請求…GET /」，退 2、不寫 `--out`）。
 * ⚠️ **刻意放進容許、而不是放進 `ALLOWED_REQUESTS`**：進容許＝**繼續擋它**，只是不再讓它弄垮整遍掃描；
 * 進白名單＝真的放它出去，等於為了讓掃描能跑而新開一個出口。
 * ⚠️ **證據只到這裡**：那次掃描裡 `GET /` 被擋掉之後，**grok 仍正常退出（0）並產生輸出（回覆長度 3396）**。
 *   **沒有量到**的：那次回答的內容完整性、能力有沒有降級——沒有對照組，原始輸出也已依設計丟棄。
 *   所以**不可以**說「擋它不影響掃描結果」，也**不可以**說「它要用的端點都在白名單上」（#635 r1 #3）。
 * ⚠️ 我們也**不知道** `GET /` 對上游是什麼意思（沒有記錄型 proxy 實測）。**正因為不知道，才選擇繼續擋。**
 *
 * ⚠️ 每一筆的形狀是 `<原因碼> <METHOD> <含 query 的完整路徑>`，由 `isTolerated()` **逐字相等**比對。
 * 所以 `GET /?probe=新端點` **不在**容許範圍（Grok 複審後掃 #1③：前一版把 query 剝掉，它會變成 `/`）；
 * absolute-form 的表外請求也不在（它走 `absolute-form` 這個碼）。
 * 同一個路徑因為**別的原因**被拒（`bad-target`／`path-too-long`／`auth`）**不在容許範圍**——
 * #635 r1 #1 就是栽在這裡：`GET http://x:bad/other` 解析不了會退化成 `/`，舊版比對只看 method＋path，
 * 於是那條異常被當成已審過的例外吃掉。**決定點是 `isTolerated()`**（吃結構化原值，本檔唯一實作，考題直接呼叫它）；
 * `isToleratedRefusal()` 只是掃描腳本讀那一行時看第一欄，不重算。
 */
export const TOLERATED_REFUSALS = Object.freeze(['shape GET /v1/bundle/archive', 'shape GET /v1/subagents/bundle', 'shape GET /']);
/** 拒絕次數上限：超過＝轉送器自己退出（退出碼 3）→ grok-scan 看到轉送器死＝退 2。否則盒內程式可以用無限個被拒請求灌爆 stderr。 */
export const MAX_REFUSALS = 100;
export const MAX_REQUESTS = 2000;          // 一次掃描的上限（實測一輪問答約 10 個請求）
export const MAX_INFLIGHT = 8;
export const MAX_BODY = 96 * 1024 * 1024;  // /v1/responses 會帶整份材料（diff 上限 64MB）
const MAX_PATH = 2048;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host']);

/**
 * 請求的 path（absolute-form `GET http://other-host/x` 只留 path——不然 path 本身就能帶走整個 URL）
/**
 * request-target → 路徑。回 `{ path, bad, absolute }`。
 *
 * ⚠️ **解析失敗不可以退化成 `/`**（#635 r1 #1）：`GET http://x:bad/other` 這種 Node 的 HTTP parser
 * 收得下、`new URL()` 卻拋錯的形狀，更早的版本 catch 把它變成 `/`，拒絕行就跟真正的根路徑逐字相同、
 * 被容許清單一起吃掉（審查者用真沙箱端到端重現：本來該退 2 的兩種異常都變成退 0）。`bad` 走自己的原因碼。
 * ⚠️ **`absolute` 是第二道**（Grok 複審後掃 #1①）：`new URL()` **成功**的時候也會正規化——
 * `http://evil/a/b/../../` 的 pathname 就是 `/`，跟真的根路徑分不出來。所以 absolute-form 的
 * **表外請求**另給一個碼，永遠不在容許範圍。
 * ⚠️ 射程講明：`path` **是**容許判斷的一部分（含 query，見 `isTolerated()`）——**不可以**說它「只拿來給人看」。
 * 只拿來給人看的是**印進拒絕行的那一整行**（`safeLine()` 清洗過的版本）。
 * @param {string} [url]
 * @returns {{ path: string, bad: boolean, absolute: boolean }}
 */
function requestPath(url) {
  const raw = url || '/';
  if (!/^[a-z]+:\/\//i.test(raw)) return { path: raw, bad: false, absolute: false };
  try { const u = new URL(raw); return { path: u.pathname + u.search, bad: false, absolute: true }; }
  catch { return { path: '/', bad: true, absolute: true }; }
}

/**
 * 寫進 stderr 的那**一整行**的清洗。⚠️ **整行過濾，不是逐欄過濾**——
 * #635 r5 #2：上一版只清洗了 `path`，而 `why` 裡還帶著**原始的** pathname／method，
 * 於是一個含換行的 request-target 照樣能在 stderr 裡**偽造出一整行假的「已容許」紀錄**
 * （審查者拿真的 request callback 攔 stderr 重現過）。逐欄清洗就是在列舉出口。
 *
 * **轉成 `%` 加上碼位的十六進位**（至少兩位；U+2028 會變成 `%2028`，**不是**標準的百分比編碼，這是給人看的字串不是 URL）。
 * **實際涵蓋的範圍（逐一寫出來，不寫「所有控制字元」）**：C0（U+0000–U+001F）、DEL（U+007F）、
 * C1（U+0080–U+009F，含 NEL U+0085）、以及 U+2028／U+2029 這兩個分行符。**空白保留**——
 * 決定只看第一欄（見 `isToleratedRefusal`），欄位裡有空白不影響它。
 * ⚠️ 射程講明（#635 r6 #2）：上一版只涵蓋 C0＋DEL，我卻寫成「所有控制字元」——NEL 原樣留著，
 * 審查者量給我看。**但他同時說明：`grok-scan.js` 用 LF 切行，所以那些字元當時並沒有讓掃描被繞過**；
 * 錯的是那句話，不是行為。這一版把範圍擴大到上面那幾類＝**縱深**，不是在修一個已證實的繞法。
 * ⚠️ 這個值**只給人看**：容許判斷走 `isTolerated()`，吃的是結構化原值，不是這一串。
 * @param {string} text
 */
export function safeLine(text) {
  // eslint-disable-next-line no-control-regex -- 這裡就是要抓控制字元：CR／LF 會被拿來偽造整行拒絕紀錄（#635 r5 #2）
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => '%' + (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, '0'));
}

/** 印進拒絕行的路徑長度上限（只截斷，清洗由 `safeLine` 對整行做）。 @param {string} path */
export function clipPath(path) { return path.slice(0, 200); }

/**
 * 拒絕的**穩定原因碼**。容許清單比對的是它，不是那句給人看的話（#635 r1 #1）——
 * 「給人看的話」會因為上面那個 fallback 而在兩種完全不同的情況下長得一模一樣。
 */
export const REFUSE_CODES = Object.freeze({
  BAD_TARGET: 'bad-target',       // request-target 解析不了（**絕不可與合法路徑混同**）
  PATH_TOO_LONG: 'path-too-long', // 超過 MAX_PATH
  SHAPE: 'shape',                 // method＋path 不在 ALLOWED_REQUESTS（**origin-form**）
  AUTH: 'auth',                   // Authorization 不等於本掃的假值
  // ⚠️ absolute-form 的表外請求自己一碼：`new URL()` 會把 `http://evil/a/b/../../` **正規化成 `/`**，
  //    跟真的根路徑分不出來（Grok 複審後掃 #1① 列了八種）。給它自己的碼＝**永遠不在容許範圍**。
  //    准轉的 absolute-form 不受影響（它根本走不到拒絕這條路）。
  ABSOLUTE_FORM: 'absolute-form',
});

/** 拒絕行的第一欄：這個拒絕有沒有被容許。掃描腳本只看這一欄。 */
export const REFUSAL_TOLERATED = 'tolerated';
export const REFUSAL_BLOCKING = 'BLOCKING';

/**
 * 容許判斷的**唯一實作**（#635 r1 #2：原本考題自己抄了一份比對式，正式那支改壞也不知道）。
 * ⚠️ **吃結構化的原值，不從印出來的那行字回推**——Grok 複審後掃指出前一版的四條路：
 *   ①`http://evil/a/b/../../` 這類 absolute-form 被 `new URL()` 正規化成 `/`（本函式不管它，
 *     由 `REFUSE_CODES.ABSOLUTE_FORM` 擋在外面）②`GET /?probe=新端點` 的 query 被剝掉之後也變成 `/`
 *     ⇒ 所以**這裡的 `path` 是含 query 的完整路徑**，`/?x` 與 `/` 不是同一把鑰匙
 *   ③④路徑裡的空白／換行會把欄位切歪、甚至偽造出假的拒絕行 ⇒ 不再有「切欄位」這一步。
 * @param {string} code @param {string} method @param {string} path **含 query 的完整路徑**
 */
export function isTolerated(code, method, path) {
  return TOLERATED_REFUSALS.includes(`${code} ${method} ${path}`);
}

/**
 * 掃描腳本用的：這一行拒絕紀錄是不是「刻意擋的」。**只看第一欄**——決定是轉送器在
 * 拿得到結構化原值的時候下的，這裡不重算、也沒有東西可以被切歪。
 * @param {string} line 已經去掉 REFUSED_PREFIX 的那一行
 */
export function isToleratedRefusal(line) {
  return line.startsWith(REFUSAL_TOLERATED + ' ');
}

/**
 * 「這個請求准不准轉」——**唯一的決定點**（r6）。回傳 `null`＝准；`{ code, why }`＝拒絕（回 403，不轉）：
 * `code` 是**穩定原因碼**（容許判斷吃它），`why` 是給人看的那句話（**不參與判斷**）。
 * 考題直接餵錯 nonce／錯 method／錯 path 考它（test/grok-sandbox.test.js）。
 * @param {{ method?: string, url?: string, headers: Record<string, string | string[] | undefined> }} req
 * @param {string} [dummyBearer] broker 模式下盒內那個假值；沒給＝不啟用 broker（純轉送，Authorization 原樣過）
 */
export function rejectReason(req, dummyBearer) {
  const { path, bad, absolute } = requestPath(req.url);
  if (bad) return { code: REFUSE_CODES.BAD_TARGET, why: 'request-target 解析不了' };
  if (path.length > MAX_PATH) return { code: REFUSE_CODES.PATH_TOO_LONG, why: 'path 太長' };
  const pathname = path.split('?')[0];
  const method = String(req.method || '').toUpperCase();
  if (!ALLOWED_REQUESTS.some((a) => a.method === method && a.path.test(pathname))) {
    return absolute
      ? { code: REFUSE_CODES.ABSOLUTE_FORM, why: `absolute-form 的表外請求：${method} ${pathname}` }
      : { code: REFUSE_CODES.SHAPE, why: `形狀不在白名單：${method} ${pathname}` };
  }
  if (dummyBearer !== undefined) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${dummyBearer}`) return { code: REFUSE_CODES.AUTH, why: 'Authorization 不是本掃的假值（缺、自編、或上一掃的）' };
  }
  return null;
}

/**
 * 「准轉的請求要送到哪、帶什麼」。**先過 rejectReason 才能叫它**（呼叫端負責；考題直接考組合）。
 * 不管請求的 Host、X-Forwarded-*、X-Upstream、absolute-form URL 寫什麼，host/port 永遠是寫死的那組。
 * @param {{ method?: string, url?: string, headers: Record<string, string | string[] | undefined> }} req
 * @param {string} [realBearer] broker：有給時，Authorization 整個換成它（能走到這裡＝已精確比對過假值）
 */
export function upstreamOptions(req, realBearer) {
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
  }
  headers.host = UPSTREAM_HOST;
  if (realBearer) headers.authorization = `Bearer ${realBearer}`;
  // 走到這裡代表已過 rejectReason（`bad` 的在那裡就被擋掉了）；這裡仍只取 path 欄，不替解析失敗兜底。
  return { host: UPSTREAM_HOST, port: 443, method: req.method, path: requestPath(req.url).path, headers, timeout: 300_000 };
}

/**
 * @param {number} port
 * @param {{ authDir?: string, dummyFile?: string }} [opt]
 *   authDir 給了＝broker：從 <authDir>/auth.json 讀真 access token（唯一登入項的 key）；
 *   此時 dummyFile 必填：檔內一行＝盒內假值（DUMMY_BEARER_PREFIX 開頭、≥32 字）
 */
export function startRelay(port, opt = {}) {
/** @type {string | undefined} */
let realBearer;
/** @type {string | undefined} */
let dummyBearer;
if (opt.authDir) {
  const p = join(opt.authDir, 'auth.json');
  if (!lstatSync(p).isFile()) throw new Error(`broker：${p} 不是 regular file`);
  const all = JSON.parse(readFileSync(p, 'utf8'));
  const entries = Object.values(all);
  if (entries.length !== 1 || typeof entries[0]?.key !== 'string' || entries[0].key.length < 16) throw new Error('broker：auth.json 不是「恰一個登入項、key 為字串」的形狀');
  realBearer = entries[0].key;
  if (!opt.dummyFile) throw new Error('broker：要 --dummy-file（盒內假值）——沒有它就無從精確比對，不啟動');
  if (!lstatSync(opt.dummyFile).isFile()) throw new Error(`broker：${opt.dummyFile} 不是 regular file`);
  dummyBearer = readFileSync(opt.dummyFile, 'utf8').trim();
  if (!dummyBearer.startsWith(DUMMY_BEARER_PREFIX) || dummyBearer.length < DUMMY_BEARER_PREFIX.length + 32) throw new Error('broker：假值形狀不對（要 DUMMY_BEARER_PREFIX＋≥32 字隨機）');
}
let served = 0, inflight = 0, refusals = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'CONNECT') { res.writeHead(405); res.end('relay: CONNECT not supported'); return; }
  const rej = rejectReason(req, dummyBearer);
  if (rej) {
    // r7（Codex）：拒絕不能靜靜發生——grok 收到 403 多半照常退 0（實測 bundle/archive），掃描就會靜默降級。
    // 每一次拒絕都寫一行固定格式到 stderr，grok-scan.js 讀它：除了 TOLERATED_REFUSALS 裡刻意擋的，任何拒絕＝該掃退 2（吵）。
    // ⚠️ **第一欄是判決**（`tolerated`／`BLOCKING`，#635 r5）：決定在這裡下、由 `isTolerated()` 吃結構化原值算，
    //    掃描腳本只讀那一欄、不重算。第二欄起是原因碼／method／path，括號裡是給人看的那句話——
    //    **都不參與判斷**（r5 #1／#2：從印出來的字回推，會被前綴、空白、換行、query 各種切歪）。
    const rejMethod = String(req.method || '').toUpperCase();
    const rejPath = requestPath(req.url).path;   // **含 query**：`/?x` 與 `/` 不是同一把鑰匙
    const verdict = isTolerated(rej.code, rejMethod, rejPath) ? REFUSAL_TOLERATED : REFUSAL_BLOCKING;
    // ⚠️ 先把整行組出來，**整行**過濾一次再寫（r5 #2：逐欄清洗漏掉了 `why` 裡的原始 pathname）。
    process.stderr.write(REFUSED_PREFIX + safeLine(`${verdict} ${rej.code} ${rejMethod} ${clipPath(rejPath)} (${rej.why})`) + '\n');
    res.writeHead(403, { 'content-type': 'text/plain' }); res.end(`relay: refused (${rej.why})`); req.resume();
    if (++refusals >= MAX_REFUSALS) { process.stderr.write(`[relay] 拒絕次數達 ${MAX_REFUSALS}，轉送器退出\n`); process.exit(3); }
    return;
  }
  if (served >= MAX_REQUESTS) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('relay: request cap reached'); req.resume(); return; }
  if (inflight >= MAX_INFLIGHT) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('relay: too many in flight'); req.resume(); return; }
  served++; inflight++;
  res.on('close', () => { inflight--; });
  const up = https.request(
    upstreamOptions(req, realBearer),
    (upRes) => {
      /** @type {Record<string, string | string[]>} */
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
      }
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);   // 串流原樣過（SSE 也靠這個）
    }
  );
  up.on('error', (e) => {
    process.stderr.write(`[relay] upstream error: ${e.message}\n`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('relay: upstream unreachable');
  });
  let bodyBytes = 0;
  req.on('data', (d) => {
    bodyBytes += d.length;
    if (bodyBytes > MAX_BODY) { up.destroy(); if (!res.headersSent) res.writeHead(413); res.end('relay: body too large'); req.destroy(); }
  });
  req.pipe(up);
});

server.on('error', (/** @type {NodeJS.ErrnoException} */ e) => {
  // EADDRINUSE 最常見＝上一次掃描的轉送器沒收乾淨；說清楚，不要丟一串 stack
  process.stderr.write(`[relay] 起不來：${e.code === 'EADDRINUSE' ? `port ${port} 被占著（lsof -i :${port} 找出來殺掉）` : e.message}\n`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`READY ${port}\n`);
  process.stderr.write(`[relay] 127.0.0.1:${port} → https://${UPSTREAM_HOST}（只此一家）\n`);
});
return server;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const port = Number(args[0]);
  const ai = args.indexOf('--auth-dir');
  const di = args.indexOf('--dummy-file');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('用法：node scripts/grok-relay.js <port> [--auth-dir <dir> --dummy-file <file>]（port 必填；無參數不啟動——見檔頭）');
    process.exit(2);
  }
  try { startRelay(port, ai >= 0 ? { authDir: args[ai + 1], dummyFile: di >= 0 ? args[di + 1] : undefined } : {}); }
  catch (e) { console.error(`[relay] ${/** @type {Error} */ (e).message}`); process.exit(2); }
}
