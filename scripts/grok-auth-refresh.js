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
// ・refresh 會**輪替** refresh_token（實測回新的）。寫回用 temp＋rename＋fsync；失敗時保留上一份。
//   擋不住的窗口有兩段（Codex r5 更正我原本「斷線所以寫不回」的因果）：①伺服器已輪替、回應在途中遺失；
//   ②父程序已收到新 token、卻在 write／rename／fsync 落盤前崩潰。兩段都是**可用性**問題（要重新登入），不是機密性。
// ・**issuer 與 client_id 釘死在程式裡**（r5 #2：原本從 auth.json 讀 issuer 再把 refresh_token POST 過去——
//   可信程式信了不可信資料；改成 auth.json 裡的值必須**等於**釘住的，不等於＝不 refresh、不掃）。
// ・grok 在盒內若仍嘗試 refresh（401 時會）會失敗 → 掃描退 2 → 吵。掃描 ≤30 分鐘、token 6 小時，正常不會發生。
import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../lib/is-main.js';

/** 釘死的 OIDC 身分（grok CLI 1.0.3 登入用的公開 client id；issuer 是 xAI 的）。auth.json 裡的值必須等於這兩個，否則不 refresh。 */
export const PINNED_ISSUER = 'https://auth.x.ai';
export const PINNED_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
/** 盒子裡不該有的欄位——長效／身分類，grok 跑 -p 不需要 */
const STRIP_FOR_BOX = ['refresh_token'];
/** 盒內 auth.json 的 key 用這個假值（r5 broker：轉送器在沙箱外換成真的；真 token 從未進盒子） */
export const DUMMY_BEARER_PREFIX = 'DUMMY-SCAN-TOKEN-';

/**
 * 讀沙箱專用 auth.json，若快到期就 refresh 並原子寫回；回傳**給盒子用的版本**（已去掉 refresh_token）。
 * @param {string} authDir
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, earlySecs?: number, log?: (m: string) => void, pins?: { issuer: string, clientId: string } }} [opt]
 *   pins 只給考題覆寫（考假 issuer 被擋那題要先能建一個合法的）；正式呼叫不傳＝用釘死的
 * @returns {Promise<{ forBox: Record<string, unknown>, refreshed: boolean, expiresAt: string }>}
 */
export async function refreshSandboxAuth(authDir, opt = {}) {
  const f = opt.fetchImpl ?? fetch;
  const now = opt.now ?? Date.now;
  const early = (opt.earlySecs ?? 3600) * 1000;   // 剩不到 1 小時就先換——掃描最長 30 分鐘
  const log = opt.log ?? (() => {});
  const pins = opt.pins ?? { issuer: PINNED_ISSUER, clientId: PINNED_CLIENT_ID };
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
  // r5 #2：issuer／client_id 必須等於釘住的——refresh_token 只會被送到這一個地方
  if (cred.oidc_issuer !== pins.issuer) throw new Error(`auth.json 的 oidc_issuer「${cred.oidc_issuer}」不等於釘住的「${pins.issuer}」——不把 refresh_token 送去別處`);
  if (cred.oidc_client_id !== pins.clientId) throw new Error(`auth.json 的 oidc_client_id 不等於釘住的值——不 refresh`);
  const expiresAt = Date.parse(String(cred.expires_at));
  let refreshed = false;
  let current = cred;
  if (!(expiresAt - now() > early)) {
    log(`憑證 ${Number.isFinite(expiresAt) && expiresAt < now() ? '已過期' : '快到期'}（${cred.expires_at}），向 ${cred.oidc_issuer} refresh…`);
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(cred.refresh_token), client_id: pins.clientId });
    const r = await f(`${pins.issuer}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });   // 用釘住的，不用檔裡的
    if (!r.ok) throw new Error(`refresh 失敗：HTTP ${r.status}——refresh_token 可能已失效，先在沙箱外 grok 登入一次、再把 ~/.grok/auth.json 抄到 ${authDir}`);
    const j = /** @type {{ access_token?: string, refresh_token?: string, expires_in?: number }} */ (await r.json());
    if (!j.access_token || !j.expires_in) throw new Error('refresh 回應缺 access_token／expires_in');
    current = { ...cred, key: j.access_token, refresh_token: j.refresh_token ?? cred.refresh_token, expires_at: new Date(now() + j.expires_in * 1000).toISOString() };
    // 原子寫回：temp＋fsync＋rename；失敗時舊檔原樣（fsync：rename 只保證讀者看不到半份，不保證已落盤）
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ [key]: current }, null, 2), { mode: 0o600 });
    const fd = openSync(tmp, 'r'); fsyncSync(fd); closeSync(fd);
    renameSync(tmp, p);
    refreshed = true;
    log(`refresh 完成，新到期 ${current.expires_at}`);
  }
  const forBox = { ...current };
  for (const k of STRIP_FOR_BOX) delete forBox[k];
  // r5 broker：盒內的 key 是假的，長度跟真的一樣（grok 不驗內容，但別讓長度成為線索）
  forBox.key = DUMMY_BEARER_PREFIX + 'x'.repeat(Math.max(0, String(current.key).length - DUMMY_BEARER_PREFIX.length));
  return { forBox: { [key]: forBox }, refreshed, expiresAt: String(current.expires_at) };
}

if (isMainModule(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('用法：node scripts/grok-auth-refresh.js <authDir>'); process.exit(2); }
  refreshSandboxAuth(dir, { log: (m) => console.log(m) })
    .then((r) => { console.log(`${r.refreshed ? '已 refresh' : '還新、不用 refresh'}；到期 ${r.expiresAt}`); process.exit(0); })
    .catch((e) => { console.error(`⛔ ${e.message}`); process.exit(2); });
}
