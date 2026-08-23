#!/usr/bin/env node
// @ts-check
// **沙箱專用憑證的 OIDC refresh**（#500 r4 之後；回答 Codex r2/r4 的「登入狀態生命週期」與「結果包去機密」）。
//
// ## 為什麼存在
// 沙箱裡網路只通轉送器（cli-chat-proxy.grok.com）；grok 的 token refresh 走 **auth.x.ai**，在沙箱裡被擋。
// token 6 小時到期（實測 expires_in=21600）——r3 端對端成功是因為 token 還新；六小時後「auth_kind=none」。
// 所以 refresh 由**父程序**（本腳本＝我們的程式，可信、在沙箱外、不是 grok）在掃描前做。
//
// ## 順便解掉的事（r4 #2）
// 盒子裡只放**短效 access token**，**不放 refresh_token**——Grok 就算把盒內 auth.json 寫進回覆，
// 外流的是 ≤6 小時的 token，不是長效的 refresh_token。長效的只住在 ~/.grok-sandbox-auth（0700）。
//
// ## 誠實劃界
// ・這是標準 OIDC refresh_token grant（issuer 的 .well-known 公告支援）；xAI 改協議＝這裡壞、掃不了（吵，不是靜默）。
// ・refresh 會**輪替** refresh_token（實測回新的）：舊的立刻失效。所以寫回必須原子（temp＋rename），
//   失敗時保留上一份——但若網路在「拿到新 token」與「寫回」之間斷了，舊的已失效、新的沒存＝要重新登入。這個窗口擋不住。
// ・grok 在盒內若仍嘗試 refresh（401 時會）會失敗 → 掃描退 2 → 吵。掃描 ≤30 分鐘、token 6 小時，正常不會發生。
import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../lib/is-main.js';

/** 盒子裡不該有的欄位——長效／身分類，grok 跑 -p 不需要 */
const STRIP_FOR_BOX = ['refresh_token'];

/**
 * 讀沙箱專用 auth.json，若快到期就 refresh 並原子寫回；回傳**給盒子用的版本**（已去掉 refresh_token）。
 * @param {string} authDir
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, earlySecs?: number, log?: (m: string) => void }} [opt]
 * @returns {Promise<{ forBox: Record<string, unknown>, refreshed: boolean, expiresAt: string }>}
 */
export async function refreshSandboxAuth(authDir, opt = {}) {
  const f = opt.fetchImpl ?? fetch;
  const now = opt.now ?? Date.now;
  const early = (opt.earlySecs ?? 3600) * 1000;   // 剩不到 1 小時就先換——掃描最長 30 分鐘
  const log = opt.log ?? (() => {});
  const p = join(authDir, 'auth.json');
  if (!existsSync(p) || !lstatSync(p).isFile()) throw new Error(`沙箱專用 auth.json 不存在或不是 regular file：${p}`);
  /** @type {Record<string, Record<string, unknown>>} */
  const all = JSON.parse(readFileSync(p, 'utf8'));
  const entries = Object.entries(all);
  if (entries.length !== 1) throw new Error(`auth.json 應恰有一個登入項，實際 ${entries.length}`);
  const [key, cred] = entries[0];
  for (const need of ['oidc_issuer', 'oidc_client_id', 'refresh_token', 'expires_at', 'key']) {
    if (typeof cred[need] !== 'string' || !cred[need]) throw new Error(`auth.json 缺 ${need}——不是 OIDC 登入？先在沙箱外 grok 登入一次`);
  }
  const expiresAt = Date.parse(String(cred.expires_at));
  let refreshed = false;
  let current = cred;
  if (!(expiresAt - now() > early)) {
    log(`憑證 ${Number.isFinite(expiresAt) && expiresAt < now() ? '已過期' : '快到期'}（${cred.expires_at}），向 ${cred.oidc_issuer} refresh…`);
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(cred.refresh_token), client_id: String(cred.oidc_client_id) });
    const r = await f(`${cred.oidc_issuer}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok) throw new Error(`refresh 失敗：HTTP ${r.status}——refresh_token 可能已失效，先在沙箱外 grok 登入一次、再把 ~/.grok/auth.json 抄到 ${authDir}`);
    const j = /** @type {{ access_token?: string, refresh_token?: string, expires_in?: number }} */ (await r.json());
    if (!j.access_token || !j.expires_in) throw new Error('refresh 回應缺 access_token／expires_in');
    current = { ...cred, key: j.access_token, refresh_token: j.refresh_token ?? cred.refresh_token, expires_at: new Date(now() + j.expires_in * 1000).toISOString() };
    // 原子寫回：temp＋rename；失敗時舊檔原樣
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ [key]: current }, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
    refreshed = true;
    log(`refresh 完成，新到期 ${current.expires_at}`);
  }
  const forBox = { ...current };
  for (const k of STRIP_FOR_BOX) delete forBox[k];
  return { forBox: { [key]: forBox }, refreshed, expiresAt: String(current.expires_at) };
}

if (isMainModule(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('用法：node scripts/grok-auth-refresh.js <authDir>'); process.exit(2); }
  refreshSandboxAuth(dir, { log: (m) => console.log(m) })
    .then((r) => { console.log(`${r.refreshed ? '已 refresh' : '還新、不用 refresh'}；到期 ${r.expiresAt}`); process.exit(0); })
    .catch((e) => { console.error(`⛔ ${e.message}`); process.exit(2); });
}
