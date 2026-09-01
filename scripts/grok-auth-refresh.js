#!/usr/bin/env node
// @ts-check
// **沙箱專用憑證的 OIDC refresh**（#500 r4 之後；回答 Codex r2/r4 的「登入狀態生命週期」與「結果包去機密」）。
//
// ## 為什麼存在
// 沙箱裡網路只通轉送器（cli-chat-proxy.grok.com）；grok 的 token refresh 走 **auth.x.ai**，在沙箱裡被擋。
// token 6 小時到期（實測 expires_in=21600）——r3 端對端成功是因為 token 還新；六小時後「auth_kind=none」。
// 所以 refresh 由**父程序**（本腳本＝我們的程式，可信、在沙箱外、不是 grok）在掃描前做。
//
// ## 盒內那份 auth.json 是**重建**的，不是抄的（r4 #2 去 refresh_token → r6 #4 白名單重建）
// 真 auth.json 的登入項有 15 個欄位，其中 email／姓名／principal_id／team_id 等是身分資料，grok -p 根本不需要
// （2026-08-23 逐欄實測：缺 user_id 或 create_time 就「未登入」，其餘去掉照常跑）。盒內只放 BOX_FIELDS 這 7 欄，
// 每欄**嚴驗格式**（不是「regular file 且小」就抄——Codex r6 #4）；key 是每掃隨機的假值（broker 在沙箱外換真的）。
// refresh_token 與身分欄位只住在 ~/.grok-sandbox-auth（0700）。沒給盒子的值＝grok-scan 的 DLP 針（authNeedles）。
//
// ## 誠實劃界
// ・這是標準 OIDC refresh_token grant（issuer 的 .well-known 公告支援）；xAI 改協議＝這裡壞、掃不了（吵，不是靜默）。
// ・refresh 會**輪替** refresh_token（實測回新的）。寫回用 temp＋rename＋fsync；失敗時保留上一份。
//   擋不住的窗口有兩段（Codex r5 更正我原本「斷線所以寫不回」的因果）：①伺服器已輪替、回應在途中遺失；
//   ②父程序已收到新 token、卻在 write／rename／fsync 落盤前崩潰。兩段都是**可用性**問題（要重新登入），不是機密性。
// ・**issuer 與 client_id 釘死在程式裡**（r5 #2：原本從 auth.json 讀 issuer 再把 refresh_token POST 過去——
//   可信程式信了不可信資料；改成 auth.json 裡的值必須**等於**釘住的，不等於＝不 refresh、不掃）。
// ・grok 在盒內若仍嘗試 refresh（401 時會）會失敗 → 掃描退 2 → 吵。掃描 ≤30 分鐘、token 6 小時，正常不會發生。
// ・盒內 key 是假值、不是短效 token（r5 之後）：Grok 把盒內 auth.json 整份寫進回覆也只外流假值＋user_id／時間戳。
import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isMainModule } from '../lib/is-main.js';

/** 釘死的 OIDC 身分（grok CLI 1.0.3 登入用的公開 client id；issuer 是 xAI 的）。auth.json 裡的值必須等於這兩個，否則不 refresh。 */
export const PINNED_ISSUER = 'https://auth.x.ai';
export const PINNED_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
/** 盒內 auth.json 的 key 用這個前綴＋每掃隨機 nonce（r5 broker：轉送器在沙箱外換成真的；真 token 從未進盒子） */
export const DUMMY_BEARER_PREFIX = 'DUMMY-SCAN-TOKEN-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
/**
 * 盒內 auth.json 登入項**只會有**這幾欄（白名單重建；值逐欄驗格式）。key 不在這裡——它由呼叫端給假值。
 * @type {Readonly<Record<string, (v: unknown) => boolean>>}
 */
export const BOX_FIELDS = Object.freeze({
  auth_mode: (v) => typeof v === 'string' && /^[a-z_]{1,16}$/.test(v),
  user_id: (v) => typeof v === 'string' && UUID.test(v),
  create_time: (v) => typeof v === 'string' && ISO.test(v),
  expires_at: (v) => typeof v === 'string' && ISO.test(v),
  oidc_issuer: (v) => v === PINNED_ISSUER,
  oidc_client_id: (v) => v === PINNED_CLIENT_ID,
});

/** 盒內 auth.json 登入項的**鍵名**——grok 1.0.3 用 `<issuer>::<client_id>`（實測）；只有這個形狀准進盒子 */
export function boxEntryKey(pins = { issuer: PINNED_ISSUER, clientId: PINNED_CLIENT_ID }) { return `${pins.issuer}::${pins.clientId}`; }

/** 每掃一個新的假值：前綴＋48 個十六進位字（轉送器比對整個值） */
export function newDummyBearer() { return DUMMY_BEARER_PREFIX + randomBytes(24).toString('hex'); }

/**
 * 不是身分也不是憑證的枚舉欄位——值是 xAI 的詞彙（例如 principal_type 是一個四字的類別詞），拿來當針只會誤中任何日誌。
 * **只點名這些**；不在 BOX_FIELDS 也不在這裡的欄位（含日後新增的）一律當針（fail-closed 方向）。
 */
export const ENUM_FIELDS = Object.freeze(['principal_type']);

/**
 * DLP 針＝真 auth.json 裡**沒給盒子**的每一個字串值（遞迴、不分長短）。登入項的鍵名不算（它被釘成公開的 issuer::client_id）。
 * 「沒給盒子」看的是**值**：給了盒子的值不算針，不管它在真檔裡還叫什麼欄位（2026-08-23 真跑實測：principal_id 的值
 * 等於 user_id，user_id 給了盒子、grok 自然寫進日誌，r6 初版把它當 principal_id 的針→假事故）。
 * 按**欄位**排除、不按內容形狀（r6 #6：原本用「ISO 日期開頭」排時間戳，會把恰好長那樣的 credential 也排掉）。
 * 呼叫端還要再剔掉「已在給盒子的材料裡出現」的針（在輸入裡的字串偵測不了外流）——那一步在 grok-scan.js。
 * @param {Record<string, Record<string, unknown>>} authJson
 */
export function authNeedles(authJson) {
  /** @type {Set<string>} */ const out = new Set();
  /** @type {Set<string>} */ const givenToBox = new Set();
  const walk = (/** @type {unknown} */ v, /** @type {Set<string>} */ into) => {
    if (typeof v === 'string') { if (v) into.add(v); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, into));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, into));
  };
  for (const cred of Object.values(authJson)) {
    if (!cred || typeof cred !== 'object') continue;
    // 鍵名不加進 givenToBox：它必須等於釘住的公開形狀才進得了盒子（refreshSandboxAuth 驗），不是「任意值」
    for (const [k, v] of Object.entries(cred)) {
      if (Object.hasOwn(BOX_FIELDS, k)) walk(v, givenToBox);
      else if (!ENUM_FIELDS.includes(k)) walk(v, out);
    }
  }
  for (const v of givenToBox) out.delete(v);
  return [...out];
}

/**
 * 讀沙箱專用 auth.json，若快到期就 refresh 並原子寫回；回傳**給盒子用的版本**（白名單重建＋假 key）。
 * @param {string} authDir
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, earlySecs?: number, log?: (m: string) => void, pins?: { issuer: string, clientId: string }, dummyBearer?: string }} [opt]
 *   pins 只給考題覆寫（考假 issuer 被擋那題要先能建一個合法的）；正式呼叫不傳＝用釘死的。dummyBearer 不傳＝隨機新的。
 * @returns {Promise<{ forBox: Record<string, unknown>, dummyBearer: string, refreshed: boolean, expiresAt: string }>}
 */
export async function refreshSandboxAuth(authDir, opt = {}) {
  const f = opt.fetchImpl ?? fetch;
  const now = opt.now ?? Date.now;
  const early = (opt.earlySecs ?? 3600) * 1000;   // 剩不到 1 小時就先換——掃描最長 30 分鐘
  const log = opt.log ?? (() => {});
  const pins = opt.pins ?? { issuer: PINNED_ISSUER, clientId: PINNED_CLIENT_ID };
  const p = join(authDir, 'auth.json');
  if (!existsSync(p) || !lstatSync(p).isFile()) throw new Error(`沙箱專用 auth.json 不存在或不是 regular file：${p}`);
  // ⚠️ **解析失敗的訊息不可以往外送**：Node 原生的 SyntaxError 會把輸入的前綴印進 message
  //   （`Unexpected token ... "SYNTHET"...`），而這一段跑在 DLP 遮罩字典就緒**之前**、
  //   呼叫端會把 message 接進公開摘要＝抄進 PR 描述（Codex #535 r8）。所以換成固定訊息。
  /** @type {Record<string, Record<string, unknown>>} */
  let all;
  try { all = JSON.parse(readFileSync(p, 'utf8')); }
  catch { throw new Error('auth.json 不是合法 JSON（內容不回顯）——先在沙箱外 grok 登入一次'); }
  const entries = Object.entries(all);
  if (entries.length !== 1) throw new Error(`auth.json 應恰有一個登入項，實際 ${entries.length}`);
  const [key, cred] = entries[0];
  for (const need of ['oidc_issuer', 'oidc_client_id', 'refresh_token', 'expires_at', 'key']) {
    if (typeof cred[need] !== 'string' || !cred[need]) throw new Error(`auth.json 缺 ${need}——不是 OIDC 登入？先在沙箱外 grok 登入一次`);
  }
  // r5 #2：issuer／client_id 必須等於釘住的——refresh_token 只會被送到這一個地方
  // ⚠️ **不回顯實值**：這個訊息會被呼叫端推進 summary＝抄進公開的 PR 描述，而它發生在
  //   DLP 遮罩字典就緒**之前**（Codex #535 r7 用合成值重現：退 2 但摘要逐字含那個值）。
  //   釘住的那一個是公開常數、照印；不合法的那一個只講長度。
  if (cred.oidc_issuer !== pins.issuer) throw new Error(`auth.json 的 oidc_issuer（長 ${String(cred.oidc_issuer).length}，內容不回顯）不等於釘住的「${pins.issuer}」——不把 refresh_token 送去別處`);
  if (cred.oidc_client_id !== pins.clientId) throw new Error(`auth.json 的 oidc_client_id 不等於釘住的值——不 refresh`);
  // ⚠️ **不可以在這裡把 `expires_at` 原文往外送**（Codex #535 r9）：它只驗過「是非空字串」，
  //   壞值會讓 `Date.parse` 回 NaN、走進 refresh 分支，那裡的 `log()` 原本把原文印出去——
  //   而那條路是 `log` 不是 `fail → say`，只看 summary 的考題完全量不到。
  //   先驗成合法時間；不合法就用固定訊息。
  if (!Number.isFinite(Date.parse(String(cred.expires_at)))) throw new Error('auth.json 的 expires_at 不是合法時間（內容不回顯）——先在沙箱外 grok 登入一次');
  const expiresAt = Date.parse(String(cred.expires_at));
  let refreshed = false;
  let current = cred;
  if (!(expiresAt - now() > early)) {
    log(`憑證 ${Number.isFinite(expiresAt) && expiresAt < now() ? '已過期' : '快到期'}（${cred.expires_at}），向 ${cred.oidc_issuer} refresh…`);
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(cred.refresh_token), client_id: pins.clientId });
    const r = await f(`${pins.issuer}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });   // 用釘住的，不用檔裡的
    if (!r.ok) throw new Error(`refresh 失敗：HTTP ${r.status}——refresh_token 可能已失效，先在沙箱外 grok 登入一次、再把 ~/.grok/auth.json 抄到 ${authDir}`);
    // 同上：回應解析失敗的原生訊息會帶出回應內容的前綴，而那裡可能是**還沒進字典的新值**
    /** @type {{ access_token?: string, refresh_token?: string, expires_in?: number }} */ let j;
    try { j = /** @type {typeof j} */ (await r.json()); }
    catch { throw new Error('refresh 回應不是合法 JSON（內容不回顯）'); }
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
  // r6 #4：白名單重建、逐欄驗格式；不在名單的欄位（refresh_token、email、姓名、principal／team…）**不存在**於盒內那份
  /** @type {Record<string, unknown>} */ const forBox = {};
  for (const [k, ok] of Object.entries(BOX_FIELDS)) {
    if (!ok(current[k])) throw new Error(`auth.json 的 ${k} 格式不對——不重建盒內登入項、不掃`);
    forBox[k] = current[k];
  }
  // r7（Codex）：外層鍵名也是「進盒子的資料」——原本只驗可列印 ASCII，鍵名若是 email 就原樣進盒、又因「給了盒子」不被 DLP 抓。
  // 實測 grok 1.0.3 的鍵名＝`<issuer>::<client_id>`（兩個公開值）；釘死成這個形狀，不等於＝不掃。
  if (key !== boxEntryKey(pins)) throw new Error('auth.json 登入項的鍵名不是「釘住的 issuer::client_id」——鍵名也會進盒子，不接受別的形狀、不掃');
  const dummyBearer = opt.dummyBearer ?? newDummyBearer();
  forBox.key = dummyBearer;   // r5 broker：假的；轉送器在沙箱外換真的
  return { forBox: { [key]: forBox }, dummyBearer, refreshed, expiresAt: String(current.expires_at) };
}

if (isMainModule(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('用法：node scripts/grok-auth-refresh.js <authDir>'); process.exit(2); }
  refreshSandboxAuth(dir, { log: (m) => console.log(m) })
    .then((r) => { console.log(`${r.refreshed ? '已 refresh' : '還新、不用 refresh'}；到期 ${r.expiresAt}`); process.exit(0); })
    .catch((e) => { console.error(`⛔ ${e.message}`); process.exit(2); });
}
