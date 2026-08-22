#!/usr/bin/env node
// @ts-check
// **Grok 沙箱專用的單向轉送器**（William 2026-08-22 裁示 B）。
//
// ## 為什麼存在
//
// macOS sandbox-exec 的網路規則只認 localhost／*，放不了特定網域（實測：`host must be * or localhost`）。
// 所以 scripts/grok-sandbox.sb 一律只准 localhost；localhost 上由這支接手，**只**轉到寫死的 UPSTREAM。
//
// ## 安全性質（這是全部，沒有更多）
//
// ・目的地**寫死在程式裡、不從請求取**——沙箱裡的任何程式（含 curl）都只能跟 UPSTREAM 講話。
// ・只在 127.0.0.1 上聽，沙箱外的機器連不到。
// ・不看、不存、不改請求內容（登入憑證在 header 裡，原樣過）。
// ・⚠️ **擋不住「把資料 POST 到 UPSTREAM」**——那跟 grok 送 prompt 是同一條路，本來就准。
//   真正的保護在沙箱：它根本讀不到可以送的東西（見 grok-sandbox.sb 的劃界）。
//
// ## 用法
//
//   node scripts/grok-relay.js <port>      port **必填**；啟動後 stdout 印一行 `READY <port>`（給 grok-scan.js 同步用）
//   ⚠️ 無參數＝印用法、退 2，**不啟動**——test/entry-guard.test.js 會無參數執行每支 scripts/*.js，
//      一支會永遠聽下去的伺服器會讓整套考題無聲卡死（2026-08-22 實際卡了 10 分鐘）。
//   然後 grok 以 GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:<port>/v1 啟動。
//
// UPSTREAM 是從 grok 1.0.3 執行檔裡 `strings` 出來的（`https://cli-chat-proxy.grok.com/v1`），
// 正是 GROK_CLI_CHAT_PROXY_BASE_URL 覆寫的那一個。grok 升版若換位址，這裡要跟著改——
// 壞法是「grok 連不上」（轉送器回 502），不是靜靜放行到別處。
import http from 'node:http';
import https from 'node:https';
import { isMainModule } from '../lib/is-main.js';

const UPSTREAM_HOST = 'cli-chat-proxy.grok.com';
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host']);

/** @param {number} port */
export function startRelay(port) {
const server = http.createServer((req, res) => {
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
  }
  headers.host = UPSTREAM_HOST;
  const up = https.request(
    { host: UPSTREAM_HOST, port: 443, method: req.method, path: req.url, headers, timeout: 300_000 },
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
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('用法：node scripts/grok-relay.js <port>（port 必填；無參數不啟動——見檔頭）');
    process.exit(2);
  }
  startRelay(port);
}
