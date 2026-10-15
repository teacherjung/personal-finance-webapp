// @ts-check
// 公開 OAuth client 與協定依 google-gemini/gemini-cli v0.64.0 的 code_assist/oauth2.ts、server.ts、setup.ts。
// 不引入整支 CLI：其 setupUser 缺資格時會 onboardUser，不能用在只准沿用既有通道的掃描器。
import { isMainModule } from '../lib/is-main.js';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const RESPONSE_CAP = 512 * 1024;
const CREDENTIAL_CAP = 64 * 1024;
const TIMEOUT_MS = 30_000;
export const PUBLIC_CLIENT_SOURCE_PIN = Object.freeze({
  packageName: '@google/gemini-cli', version: '0.64.0',
  bundleRelativePath: 'bundle/chunk-NR7L3FXV.js',
  bundleSha256: 'd566e81b1df8d4d44a91bf7aeea96a58ec0e6c8934fa424315ef060507dcbb8c',
  metadataSha256: 'a2d8e6d35c11a6934a12bfe2ed76ae6913c7c4dfd590c60aa420e8cb7e387508',
});
const fail = (/** @type {string} */ code) => new Error(`GEMINI_AUTH_${code}`);
/** @param {unknown} v @returns {v is Record<string, any>} */
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v */
const text = v => typeof v === 'string' && v.length > 0 && v.length <= CREDENTIAL_CAP && !/[\r\n\0]/.test(v);

/** @param {string} root @param {string} relative @param {number} cap @param {string} expectedHash */
function readPublicSourceBytes(root, relative, cap, expectedHash) {
  const file = join(root, relative);
  if (!file.startsWith(root + sep)) throw fail('CLIENT_SOURCE');
  let current = root;
  for (const part of relative.split('/')) {
    current = join(current, part);
    const state = lstatSync(current);
    if (state.isSymbolicLink() || (current !== file && !state.isDirectory())) throw fail('CLIENT_SOURCE');
  }
  const before = lstatSync(file);
  if (!before.isFile() || before.size < 1 || before.size > cap) throw fail('CLIENT_SOURCE');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw fail('CLIENT_SOURCE');
    // 多留一 byte 偵測增長；不讓檔案在 stat 之後增長成無上限的 readFileSync。
    const buffer = Buffer.alloc(opened.size + 1); let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fstatSync(fd); const named = lstatSync(file);
    if (count !== opened.size || !after.isFile() || !named.isFile() || named.isSymbolicLink()
      || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || named.dev !== opened.dev || named.ino !== opened.ino || named.size !== opened.size
      || named.mtimeMs !== opened.mtimeMs || named.ctimeMs !== opened.ctimeMs || realpathSync(file) !== file) throw fail('CLIENT_SOURCE');
    const bytes = buffer.subarray(0, count);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw fail('CLIENT_SOURCE');
    return bytes;
  } finally { closeSync(fd); }
}

/** @param {unknown} root */
function readPublicClient(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root
    || !lstatSync(root).isDirectory()) throw fail('CLIENT_SOURCE');
  const metadataBytes = readPublicSourceBytes(root, 'package.json', 64 * 1024, PUBLIC_CLIENT_SOURCE_PIN.metadataSha256);
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes));
  if (!object(metadata) || metadata.name !== PUBLIC_CLIENT_SOURCE_PIN.packageName || metadata.version !== PUBLIC_CLIENT_SOURCE_PIN.version) throw fail('CLIENT_SOURCE');
  const bundleBytes = readPublicSourceBytes(root, PUBLIC_CLIENT_SOURCE_PIN.bundleRelativePath, 16 * 1024 * 1024, PUBLIC_CLIENT_SOURCE_PIN.bundleSha256);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bundleBytes);
  if ((source.match(/\b(?:var|let|const)\s+OAUTH_CLIENT_ID\s*=/g) ?? []).length !== 1
    || (source.match(/\b(?:var|let|const)\s+OAUTH_CLIENT_SECRET\s*=/g) ?? []).length !== 1) throw fail('CLIENT_SOURCE');
  // 已核 bundle 的相鄰角色與邊界；只接普通字面量，不執行 JS 或猜其他位置的配對。
  const pairs = [...source.matchAll(/^var userAccountManager2 = new UserAccountManager\(\);\nvar OAUTH_CLIENT_ID = "([A-Za-z0-9_-]+\.apps\.googleusercontent\.com)";\nvar OAUTH_CLIENT_SECRET = "([A-Za-z0-9_-]+)";\nvar OAUTH_SCOPE = \[/gm)];
  if (pairs.length !== 1 || pairs[0][1].length > 256 || pairs[0][2].length > 128) throw fail('CLIENT_SOURCE');
  return { clientId: pairs[0][1], clientSecret: pairs[0][2] };
}

/**
 * @typedef {'TOKEN' | 'LOAD' | 'QUOTA'} Stage
 * @typedef {'TRANSPORT' | 'HTTP_401' | 'HTTP_403' | 'HTTP_429' | 'HTTP_OTHER' | 'JSON' | 'SHAPE'} Reason
 * @typedef {{status: number, body: Buffer}} Reply
 * @typedef {(url: string, headers: Record<string,string>, body: string) => Promise<Reply>} Transport
 * @typedef {{readonly project: string, getAccessToken: () => Promise<string>, dlpNeedles: () => string[], quota: () => {modelId: string, remainingFraction: number}[], toJSON: () => never}} GeminiAuth
 * @typedef {Readonly<{SERVICE_DISABLED: boolean, USER_PROJECT_DENIED: boolean, ACCESS_TOKEN_SCOPE_INSUFFICIENT: boolean, SECURITY_POLICY_VIOLATED: boolean, USER_BLOCKED_BY_ADMIN: boolean, RESOURCE_PROJECT_INVALID: boolean, UNKNOWN: boolean, MALFORMED: boolean, INCOMPLETE: boolean, PARSE_FAILED: boolean, NO_ERROR_INFO: boolean}>} QuotaDiagnostic
 */

/** @type {WeakMap<object, QuotaDiagnostic>} */ const quotaDiagnostics = new WeakMap();
const quotaReasons = new Set(['SERVICE_DISABLED', 'USER_PROJECT_DENIED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'SECURITY_POLICY_VIOLATED', 'USER_BLOCKED_BY_ADMIN', 'RESOURCE_PROJECT_INVALID']);

// 固定鍵避免把服務端文字當輸出欄位；Set 只保留集合，不保留重複次數與輸入次序。
/** @param {Set<string>} reasons @param {Set<string>} flags @returns {QuotaDiagnostic} */
function quotaProjection(reasons = new Set(), flags = new Set()) {
  return Object.freeze({
    SERVICE_DISABLED: reasons.has('SERVICE_DISABLED'),
    USER_PROJECT_DENIED: reasons.has('USER_PROJECT_DENIED'),
    ACCESS_TOKEN_SCOPE_INSUFFICIENT: reasons.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT'),
    SECURITY_POLICY_VIOLATED: reasons.has('SECURITY_POLICY_VIOLATED'),
    USER_BLOCKED_BY_ADMIN: reasons.has('USER_BLOCKED_BY_ADMIN'),
    RESOURCE_PROJECT_INVALID: reasons.has('RESOURCE_PROJECT_INVALID'),
    UNKNOWN: flags.has('UNKNOWN'),
    MALFORMED: flags.has('MALFORMED'),
    INCOMPLETE: flags.has('INCOMPLETE'),
    PARSE_FAILED: flags.has('PARSE_FAILED'),
    NO_ERROR_INFO: flags.has('NO_ERROR_INFO'),
  });
}

/** @param {Buffer} raw @returns {QuotaDiagnostic} */
function classifyQuotaForbidden(raw) {
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!object(parsed) || !Object.hasOwn(parsed, 'error') || !object(parsed.error)) return quotaProjection(new Set(), new Set(['MALFORMED', 'NO_ERROR_INFO']));
    if (!Object.hasOwn(parsed.error, 'details')) return quotaProjection(new Set(), new Set(['NO_ERROR_INFO']));
    const details = parsed.error.details;
    if (!Array.isArray(details)) return quotaProjection(new Set(), new Set(['MALFORMED', 'NO_ERROR_INFO']));
    // 部分結果會把未完整檢查寫成帳號線索，因此超界須在檢查第一項前整份放棄。
    if (details.length > 32) return quotaProjection(new Set(), new Set(['INCOMPLETE']));
    const reasons = new Set(); const flags = new Set(); let matchedType = false;
    for (const detail of details) {
      if (!object(detail) || !Object.hasOwn(detail, '@type') || typeof detail['@type'] !== 'string') { flags.add('MALFORMED'); continue; }
      if (detail['@type'] !== 'type.googleapis.com/google.rpc.ErrorInfo') { flags.add('UNKNOWN'); continue; }
      matchedType = true;
      if (!Object.hasOwn(detail, 'domain') || typeof detail.domain !== 'string') { flags.add('MALFORMED'); continue; }
      if (detail.domain !== 'googleapis.com') { flags.add('UNKNOWN'); continue; }
      if (!Object.hasOwn(detail, 'reason') || typeof detail.reason !== 'string') { flags.add('MALFORMED'); continue; }
      if (!quotaReasons.has(detail.reason)) { flags.add('UNKNOWN'); continue; }
      reasons.add(detail.reason);
    }
    if (!matchedType) flags.add('NO_ERROR_INFO');
    return quotaProjection(reasons, flags);
  } catch {
    return quotaProjection(new Set(), new Set(['PARSE_FAILED']));
  }
}

// 呼叫端明確摘取一次；不查外來 Error 屬性，也不把原回覆掛在 Error 上。
/** @param {unknown} error @returns {QuotaDiagnostic | undefined} */
export function takeGeminiQuotaDiagnostic(error) {
  if (error === null || typeof error !== 'object') return undefined;
  const projection = quotaDiagnostics.get(error);
  quotaDiagnostics.delete(error);
  return projection;
}

// 不信任外來 exception 的字串或 code；原因只從此模組建立的型別讀取。
/** @type {WeakMap<object, Reason>} */ const requestReasons = new WeakMap();
class RequestFailure extends Error {
  /** @param {Reason} reason */
  constructor(reason) { super('GEMINI_AUTH_REQUEST'); requestReasons.set(this, reason); }
}

/** 固定呼叫點用原生 HTTPS，沒有 proxy/env/redirect/retry 或任意 method 接口。
 * @type {Transport}
 */
const request = (url, headers, body) => new Promise((resolve, reject) => {
  if (![TOKEN_URL, LOAD_URL, QUOTA_URL].includes(url)) { reject(fail('DESTINATION')); return; }
  let settled = false;
  const finish = (/** @type {Error | null} */ error, /** @type {Reply} */ reply = { status: 0, body: Buffer.alloc(0) }) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (error) reject(error); else resolve(reply);
  };
  const req = httpsRequest(url, { method: 'POST', headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, agent: false }, res => {
    /** @type {Buffer[]} */ const chunks = []; let size = 0;
    res.on('data', chunk => {
      size += chunk.length;
      if (size > RESPONSE_CAP) { finish(new RequestFailure('SHAPE')); res.destroy(); req.destroy(); return; }
      chunks.push(Buffer.from(chunk));
    });
    res.on('error', () => finish(new RequestFailure('TRANSPORT')));
    res.on('aborted', () => finish(new RequestFailure('TRANSPORT')));
    res.on('end', () => res.complete ? finish(null, { status: res.statusCode ?? 0, body: Buffer.concat(chunks) }) : finish(new RequestFailure('TRANSPORT')));
  });
  const timer = setTimeout(() => { finish(new RequestFailure('TRANSPORT')); req.destroy(); }, TIMEOUT_MS);
  req.on('error', () => finish(new RequestFailure('TRANSPORT')));
  req.end(body);
});

/** @param {unknown} value @param {Set<string>} needles @param {number} depth */
function collect(value, needles, depth = 0) {
  if (depth > 16) throw fail('STRUCTURE');
  if (typeof value === 'string' && value.length >= 4) needles.add(value);
  else if (Array.isArray(value)) value.forEach(v => collect(v, needles, depth + 1));
  else if (object(value)) for (const v of Object.values(value)) collect(v, needles, depth + 1);
}

/** @param {string} path */
function readCredentials(path) {
  let fd;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || st.size > CREDENTIAL_CAP) throw fail('SOURCE');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev || opened.size !== st.size) throw fail('SOURCE');
    const raw = readFileSync(fd);
    if (raw.length !== opened.size || raw.length > CREDENTIAL_CAP) throw fail('SOURCE');
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!object(parsed)) throw fail('SOURCE');
    return parsed;
  } catch { throw fail('SOURCE'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * clientSourceRoot 只由固定可信盒外發射器傳入；其餘依賴注入僅供合成考題。
 * 來源必須先核過，才讀既有 OAuth cache；正式入口不從 CLI/env 搜尋或提供替換。
 * 回傳的秘密只交給盒外父程序；toJSON 拒絕把整個 context 寫進材料或收據。
 * @param {{clientSourceRoot?: string, credentialsPath?: string, now?: () => number, request?: Transport}} [deps]
 * @returns {Promise<GeminiAuth>}
 */
export async function loadGeminiAuth(deps = {}) {
  let client;
  try { client = readPublicClient(deps.clientSourceRoot); }
  catch { throw fail('CLIENT_SOURCE'); }
  const credentials = readCredentials(deps.credentialsPath ?? join(homedir(), '.gemini', 'oauth_creds.json'));
  const now = deps.now ?? Date.now;
  const transport = deps.request ?? request;
  const needles = new Set();
  // token_type／scope 等協定常數也會出現在公開程式材料中；機密針只收私有值與未識別的 cache 值。
  for (const [key, value] of Object.entries(credentials)) if (!['type', 'token_type', 'scope', 'expiry_date'].includes(key)) collect(value, needles);
  if ((credentials.type !== undefined && credentials.type !== 'authorized_user') || credentials.token_type !== 'Bearer'
    || !text(credentials.access_token) || !text(credentials.refresh_token)
    || !Number.isFinite(credentials.expiry_date)) throw fail('CREDENTIALS');
  let access = credentials.access_token;
  let refresh = credentials.refresh_token;
  let expiry = credentials.expiry_date;
  /** @type {Promise<void> | undefined} */ let refreshing;
  /** @param {Stage} stage @param {string} url @param {Record<string,string>} headers @param {string} body */
  const post = async (stage, url, headers, body) => {
    let response;
    try { response = await transport(url, headers, body); }
    catch (error) {
      const reason = error !== null && typeof error === 'object' ? requestReasons.get(error) : undefined;
      throw fail(`${stage}_${reason ?? 'TRANSPORT'}`);
    }
    if (!object(response)) throw fail(`${stage}_SHAPE`);
    if (response.status !== 200) {
      const reason = response.status === 401 ? 'HTTP_401' : response.status === 403 ? 'HTTP_403' : response.status === 429 ? 'HTTP_429' : 'HTTP_OTHER';
      const failure = fail(`${stage}_${reason}`);
      if (stage === 'QUOTA' && response.status === 403) {
        if (!Buffer.isBuffer(response.body) || response.body.length > RESPONSE_CAP) throw fail(`${stage}_SHAPE`);
        quotaDiagnostics.set(failure, classifyQuotaForbidden(response.body));
      }
      throw failure;
    }
    if (!Buffer.isBuffer(response.body) || response.body.length > RESPONSE_CAP) throw fail(`${stage}_SHAPE`);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
    catch { throw fail(`${stage}_JSON`); }
    if (!object(parsed)) throw fail(`${stage}_SHAPE`);
    return parsed;
  };
  const refreshOnce = async () => {
    const form = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'refresh_token', refresh_token: refresh });
    const result = await post('TOKEN', TOKEN_URL, { 'Content-Type': 'application/x-www-form-urlencoded' }, form.toString());
    for (const [key, value] of Object.entries(result)) if (!['token_type', 'scope', 'expires_in'].includes(key)) collect(value, needles);
    if (!text(result.access_token) || result.token_type !== 'Bearer' || !Number.isFinite(result.expires_in)
      || result.expires_in <= 60 || result.expires_in > 86400
      || (result.refresh_token !== undefined && !text(result.refresh_token))) throw fail('REFRESH');
    access = result.access_token;
    if (result.refresh_token !== undefined) refresh = result.refresh_token;
    expiry = now() + result.expires_in * 1000;
  };
  const getAccessToken = async () => {
    if (expiry <= now() + 60_000) {
      // 同一掃的並行讀取共用一次 refresh，避免旋轉後再送出舊 grant。
      if (!refreshing) refreshing = refreshOnce().finally(() => { refreshing = undefined; });
      await refreshing;
    }
    return access;
  };
  const jsonHeaders = async () => ({ Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' });
  const account = await post('LOAD', LOAD_URL, await jsonHeaders(), JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }, mode: 'HEALTH_CHECK' }));
  if (!object(account.currentTier) || !text(account.currentTier.id) || account.currentTier.hasOnboardedPreviously === false
    || !text(account.cloudaicompanionProject)) throw fail('EXISTING_ACCOUNT_REQUIRED');
  const project = account.cloudaicompanionProject;
  needles.add(project);
  const quota = await post('QUOTA', QUOTA_URL, await jsonHeaders(), JSON.stringify({ project }));
  if (!Array.isArray(quota.buckets) || quota.buckets.length === 0) throw fail('QUOTA');
  /** @type {{modelId: string, remainingFraction: number}[]} */ const buckets = [];
  for (const bucket of quota.buckets) {
    if (!object(bucket) || !text(bucket.modelId) || !Number.isFinite(bucket.remainingFraction) || bucket.remainingFraction < 0 || bucket.remainingFraction > 1) throw fail('QUOTA');
    buckets.push({ modelId: bucket.modelId, remainingFraction: bucket.remainingFraction });
  }
  // 只有明列的呼叫介面可讀出秘密；物件展開／一般列印不把值帶出去。
  return /** @type {GeminiAuth} */ (Object.freeze(Object.defineProperties({}, {
    project: { value: project },
    getAccessToken: { value: getAccessToken },
    dlpNeedles: { value: () => [...needles] },
    quota: { value: () => buckets.map(v => ({ ...v })) },
    toJSON: { value: () => { throw fail('OPAQUE'); } },
  })));
}

if (isMainModule(import.meta.url)) {
  process.stderr.write('GEMINI_AUTH_ENTRY：此模組由 scripts/gemini-scan.js 載入，不接受直接啟動。\n');
  process.exitCode = 2;
}
