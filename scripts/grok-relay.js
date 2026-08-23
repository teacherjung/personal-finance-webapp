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
// ・只轉 grok 1.0.3 實際會打的 method＋path（ALLOWED_REQUESTS，2026-08-23 用記錄型 proxy 實測抄下來的）；
//   其他形狀一律 403、**不轉**（轉送器不是通用 proxy）。每次拒絕寫一行 REFUSED_PREFIX 到 stderr，
//   grok-scan.js 讀到非 TOLERATED_REFUSALS 的拒絕＝該掃退 2——「升版多打新端點＝掃不成（吵）」由這條承重，
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
// UPSTREAM 是從 grok 1.0.3 執行檔裡 `strings` 出來的（`https://cli-chat-proxy.grok.com/v1`），
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
 * grok 1.0.3 實際會打的形狀（2026-08-23 記錄型 proxy 實測：-p 模式、跑 bash 與讀檔工具各一次）。
 * 刻意**不放** GET /v1/bundle/archive（它也打了一次；那是下載可執行 bundle——釘了執行檔雜湊卻放行遠端換程式碼就自相矛盾；
 * 實測擋掉它 grok 照常回答）。path 只比 pathname，query 原樣過（上限見 MAX_PATH）。
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
/** 刻意擋、且實測 grok 照常回答的形狀——只有這些拒絕不讓掃描失敗 */
export const TOLERATED_REFUSALS = Object.freeze(['GET /v1/bundle/archive']);
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
function requestPath(url) {
  let path = url || '/';
  try { if (/^[a-z]+:\/\//i.test(path)) path = new URL(path).pathname + new URL(path).search; } catch { path = '/'; }
  return path;
}

/**
 * 「這個請求准不准轉」——**唯一的決定點**（r6）。回傳 null＝准；字串＝拒絕理由（回 403，不轉）。
 * 考題直接餵錯 nonce／錯 method／錯 path 考它（test/grok-sandbox.test.js）。
 * @param {{ method?: string, url?: string, headers: Record<string, string | string[] | undefined> }} req
 * @param {string} [dummyBearer] broker 模式下盒內那個假值；沒給＝不啟用 broker（純轉送，Authorization 原樣過）
 */
export function rejectReason(req, dummyBearer) {
  const path = requestPath(req.url);
  if (path.length > MAX_PATH) return 'path 太長';
  const pathname = path.split('?')[0];
  const method = String(req.method || '').toUpperCase();
  if (!ALLOWED_REQUESTS.some((a) => a.method === method && a.path.test(pathname))) return `形狀不在白名單：${method} ${pathname}`;
  if (dummyBearer !== undefined) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${dummyBearer}`) return 'Authorization 不是本掃的假值（缺、自編、或上一掃的）';
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
  return { host: UPSTREAM_HOST, port: 443, method: req.method, path: requestPath(req.url), headers, timeout: 300_000 };
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
  const why = rejectReason(req, dummyBearer);
  if (why) {
    // r7（Codex）：拒絕不能靜靜發生——grok 收到 403 多半照常退 0（實測 bundle/archive），掃描就會靜默降級。
    // 每一次拒絕都寫一行固定格式到 stderr，grok-scan.js 讀它：除了 TOLERATED_REFUSALS 裡刻意擋的，任何拒絕＝該掃退 2（吵）。
    process.stderr.write(`${REFUSED_PREFIX}${String(req.method || '').toUpperCase()} ${requestPath(req.url).split('?')[0].slice(0, 200)} (${why})\n`);
    res.writeHead(403, { 'content-type': 'text/plain' }); res.end(`relay: refused (${why})`); req.resume();
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
