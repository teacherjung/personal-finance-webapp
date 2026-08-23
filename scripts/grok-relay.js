#!/usr/bin/env node
// @ts-check
// **Grok 沙箱專用的單向轉送器**（William 2026-08-22 裁示 B）。
//
// ## 為什麼存在
//
// macOS sandbox-exec 的網路規則只認 localhost／*，放不了特定網域（實測：`host must be * or localhost`）。
// 所以 scripts/grok-sandbox.sb 一律只准 localhost；localhost 上由這支接手，**只**轉到寫死的 UPSTREAM。
//
// ## r5：credential broker（Codex r2 提、r5 再提；實測 grok 不在本地驗 token，可行）
//
// 盒內 auth.json 的 `key` 是**假的**（DUMMY-…）；本轉送器在沙箱外持有真 access token（從 0700 的 authDir 讀），
// 看到 `Authorization: Bearer DUMMY-…` 就換成真的。**真 token 從未進過盒子**——「資料不外流」從事後比對
// 變成構造上不可能；事後比對（grok-scan 第⑤步的 DLP）降為 defense-in-depth。
//
// ## 安全性質（這是全部，沒有更多）
//
// ・目的地**寫死在程式裡、不從請求取**——經過本轉送器的請求只會到 UPSTREAM。
// ・只換**帶 DUMMY 前綴**的 Authorization；其他 header 原樣過。真 token 只存在於本程序記憶體與 authDir。
//   （「盒內程式只能跟 UPSTREAM 講話」這句是**沙箱**的保證、不是轉送器的：grok-sandbox.sb 只准連本轉送器的 port，
//   r1 時放行 localhost:* 被抓到，那時這句是假的。）
// ・只在 127.0.0.1 上聽，沙箱外的機器連不到。
// ・不看、不存、不改請求內容（登入憑證在 header 裡，原樣過）。
// ・⚠️ **擋不住「把資料 POST 到 UPSTREAM」**——那跟 grok 送 prompt 是同一條路，本來就准。
//   真正的保護在沙箱：它根本讀不到可以送的東西（見 grok-sandbox.sb 的劃界）。
//
// ## 用法
//
//   node scripts/grok-relay.js <port> [--auth-dir <dir>]   port **必填**；--auth-dir 給了就啟用 broker（讀 <dir>/auth.json 的 key）；
//                                                         啟動後 stdout 印一行 `READY <port>`（給 grok-scan.js 同步用）
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
/** 盒內假 token 的固定前綴——grok-scan.js 寫進盒子、本轉送器認它 */
export const DUMMY_BEARER_PREFIX = 'DUMMY-SCAN-TOKEN-';
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host']);

/**
 * 「這個請求要送到哪、帶什麼」——**唯一的決定點**，抽出來是為了讓考題直接考它。
 * 不管請求的 Host、X-Forwarded-*、X-Upstream、absolute-form URL 寫什麼，host/port 永遠是寫死的那組。
 * @param {{ method?: string, url?: string, headers: Record<string, string | string[] | undefined> }} req
 * @param {string} [realBearer] broker：有給時，把 DUMMY 前綴的 Authorization 換成它
 */
export function upstreamOptions(req, realBearer) {
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
  }
  headers.host = UPSTREAM_HOST;
  // broker：只換 DUMMY 的；盒內程式自己編一個別的 bearer 送出來＝原樣送到 xAI、被拒（不替它背書）
  const auth = headers.authorization;
  if (realBearer && typeof auth === 'string' && auth.startsWith(`Bearer ${DUMMY_BEARER_PREFIX}`)) headers.authorization = `Bearer ${realBearer}`;
  // absolute-form（`GET http://evil/x`）只留 path——不然 path 本身就能帶走整個 URL
  let path = req.url || '/';
  try { if (/^[a-z]+:\/\//i.test(path)) path = new URL(path).pathname + new URL(path).search; } catch { path = '/'; }
  return { host: UPSTREAM_HOST, port: 443, method: req.method, path, headers, timeout: 300_000 };
}

/**
 * @param {number} port
 * @param {{ authDir?: string }} [opt] authDir 給了＝broker：從 <authDir>/auth.json 讀真 access token（唯一登入項的 key）
 */
export function startRelay(port, opt = {}) {
/** @type {string | undefined} */
let realBearer;
if (opt.authDir) {
  const p = join(opt.authDir, 'auth.json');
  if (!lstatSync(p).isFile()) throw new Error(`broker：${p} 不是 regular file`);
  const all = JSON.parse(readFileSync(p, 'utf8'));
  const entries = Object.values(all);
  if (entries.length !== 1 || typeof entries[0]?.key !== 'string' || entries[0].key.length < 16) throw new Error('broker：auth.json 不是「恰一個登入項、key 為字串」的形狀');
  realBearer = entries[0].key;
}
const server = http.createServer((req, res) => {
  if (req.method === 'CONNECT') { res.writeHead(405); res.end('relay: CONNECT not supported'); return; }
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
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('用法：node scripts/grok-relay.js <port> [--auth-dir <dir>]（port 必填；無參數不啟動——見檔頭）');
    process.exit(2);
  }
  try { startRelay(port, ai >= 0 ? { authDir: args[ai + 1] } : {}); }
  catch (e) { console.error(`[relay] ${/** @type {Error} */ (e).message}`); process.exit(2); }
}
