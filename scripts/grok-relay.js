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
//   grok-scan.js 拿 isToleratedRefusal() 判（本檔唯一實作，比對**原因碼**＋method＋path，逐字相等）；
//   不是刻意擋的那幾個＝該掃退 2——「升版多打新端點＝掃不成（吵）」由這條承重，
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
 * 刻意擋、而且**沒有證據顯示擋它會讓 grok 做不完事**的形狀——只有這些拒絕不讓掃描失敗。
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
 * ⚠️ 每一筆都帶**原因碼**（`shape`）：容許的只有「形狀不在白名單」這個原因下的那幾個路徑。
 * 同一個路徑因為**別的原因**被拒（`bad-target`／`path-too-long`／`auth`）**不在容許範圍**——
 * #635 r1 #1 就是栽在這裡：`GET http://x:bad/other` 解析不了會退化成 `/`，舊版比對只看 method＋path，
 * 於是那條異常被當成已審過的例外吃掉。比對走 `isToleratedRefusal()`（本檔唯一實作，考題直接呼叫它）。
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
 * @param {string | undefined} url
 */
/**
 * request-target → 路徑。⚠️ **解析失敗不可以退化成 `/`**（#635 r1 #1）：`GET http://x:bad/other` 這種
 * Node 的 HTTP parser 收得下、`new URL()` 卻拋錯的形狀，舊版 catch 把它變成 `/`，於是它的拒絕行
 * 跟**真正的根路徑逐字相同**，被容許清單一起吃掉（審查者用真沙箱端到端重現：本來該退 2 的兩種
 * 異常都變成退 0）。改成回傳 `{ path, bad }`：`bad` 那條走自己的原因碼，`path` 只拿來給人看、
 * **不參與容許判斷**。
 * @param {string} [url]
 * @returns {{ path: string, bad: boolean }}
 */
function requestPath(url) {
  const raw = url || '/';
  if (!/^[a-z]+:\/\//i.test(raw)) return { path: raw, bad: false };
  try { const u = new URL(raw); return { path: u.pathname + u.search, bad: false }; }
  catch { return { path: '/', bad: true }; }
}

/**
 * 拒絕的**穩定原因碼**。容許清單比對的是它，不是那句給人看的話（#635 r1 #1）——
 * 「給人看的話」會因為上面那個 fallback 而在兩種完全不同的情況下長得一模一樣。
 */
export const REFUSE_CODES = Object.freeze({
  BAD_TARGET: 'bad-target',       // request-target 解析不了（**絕不可與合法路徑混同**）
  PATH_TOO_LONG: 'path-too-long', // 超過 MAX_PATH
  SHAPE: 'shape',                 // method＋path 不在 ALLOWED_REQUESTS
  AUTH: 'auth',                   // Authorization 不等於本掃的假值
});

/**
 * 容許判斷的**唯一實作**（#635 r1 #2：原本考題自己抄了一份 `startsWith`，正式那支改壞它也不知道）。
 * 比對的是拒絕行的**前三個欄位**（`<原因碼> <METHOD> <path>`）**逐字相等**——不是前綴，
 * 所以 `shape GET /` 吃不掉 `shape GET /v1/x`，也吃不掉 `bad-target GET /` 與 `path-too-long GET /`。
 * @param {string} line 已經去掉 REFUSED_PREFIX 的那一行
 */
export function isToleratedRefusal(line) {
  return TOLERATED_REFUSALS.includes(line.split(' ').slice(0, 3).join(' '));
}

/**
 * 「這個請求准不准轉」——**唯一的決定點**（r6）。回傳 null＝准；字串＝拒絕理由（回 403，不轉）。
 * 考題直接餵錯 nonce／錯 method／錯 path 考它（test/grok-sandbox.test.js）。
 * @param {{ method?: string, url?: string, headers: Record<string, string | string[] | undefined> }} req
 * @param {string} [dummyBearer] broker 模式下盒內那個假值；沒給＝不啟用 broker（純轉送，Authorization 原樣過）
 */
export function rejectReason(req, dummyBearer) {
  const { path, bad } = requestPath(req.url);
  if (bad) return { code: REFUSE_CODES.BAD_TARGET, why: 'request-target 解析不了' };
  if (path.length > MAX_PATH) return { code: REFUSE_CODES.PATH_TOO_LONG, why: 'path 太長' };
  const pathname = path.split('?')[0];
  const method = String(req.method || '').toUpperCase();
  if (!ALLOWED_REQUESTS.some((a) => a.method === method && a.path.test(pathname))) return { code: REFUSE_CODES.SHAPE, why: `形狀不在白名單：${method} ${pathname}` };
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
    // ⚠️ 第一欄是**穩定原因碼**（#635 r1 #1）：容許判斷比對前三欄（碼／method／path）逐字相等，
    //    給人看的那句話放在括號裡、**不參與判斷**——它在兩種完全不同的情況下會長得一模一樣。
    process.stderr.write(`${REFUSED_PREFIX}${rej.code} ${String(req.method || '').toUpperCase()} ${requestPath(req.url).path.split('?')[0].slice(0, 200)} (${rej.why})\n`);
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
