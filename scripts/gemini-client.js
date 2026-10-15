// @ts-check
// 靜態材料 client；沒有工具執行、認證讀取、重試或模型選擇流程。
import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readFileSync, closeSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { isMainModule } from '../lib/is-main.js';

/** @typedef {{scanId:string,materialSha256:string,model:string,thinking:'HIGH'}} MaterialIdentity */
/** @typedef {MaterialIdentity & {schema:'gemini-scan-material/v1',base:string,head:string,materialBytes:number}} MaterialManifest */
/** @typedef {MaterialIdentity & {text:string}} MaterialRequest */
/** @typedef {Record<string,number>} Usage */
/** @typedef {MaterialIdentity & {reply:string,replySha256:string,finishReason:'STOP',usage?:Usage}} ScanResult */
/** @typedef {{manifestFile:string,materialsFile:string,outFile:string,endpoint:string,nonce:string}} ClientArgs */
/** ES2022 的型別庫不含此 Node 執行期 API；這個交集只描述該方法，不放寬字串型別。 @typedef {string & {isWellFormed():boolean}} WellFormedString */

export const MAX_MATERIAL_BYTES = 4 * 1024 * 1024;
export const MAX_REPLY_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30 * 60 * 1000;
const usageKeys = ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount', 'toolUsePromptTokenCount'];
/** @param {string | Uint8Array} value */
const sha = (value) => createHash('sha256').update(value).digest('hex');

/** @param {string} code */
export function protocolError(code) {
  return new Error(`${code}: 停止本次掃描；核對固定 manifest、材料與 relay 收據後重新準備。`);
}

/** @param {unknown} value @param {string[]} required @param {string[]} optional @param {string} code @returns {Record<string,unknown>} */
export function closedObject(value, required, optional, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw protocolError(code);
  return /** @type {Record<string,unknown>} */ (value);
}

/** @param {unknown} value @returns {MaterialManifest} */
export function validateManifest(value) {
  const m = closedObject(value, ['schema', 'scanId', 'base', 'head', 'model', 'thinking', 'materialSha256', 'materialBytes'], [], 'MANIFEST');
  if (m.schema !== 'gemini-scan-material/v1'
    || typeof m.scanId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(m.scanId)
    || typeof m.base !== 'string' || !/^[a-f0-9]{40}$/.test(m.base)
    || typeof m.head !== 'string' || !/^[a-f0-9]{40}$/.test(m.head)
    || typeof m.model !== 'string' || !/^gemini-[a-z0-9][a-z0-9._-]{0,127}$/.test(m.model)
    || m.thinking !== 'HIGH' || typeof m.materialSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.materialSha256)
    || typeof m.materialBytes !== 'number' || !Number.isSafeInteger(m.materialBytes) || m.materialBytes < 1 || m.materialBytes > MAX_MATERIAL_BYTES) throw protocolError('MANIFEST');
  return /** @type {MaterialManifest} */ (m);
}

/** @param {unknown} value @param {unknown} text @returns {MaterialRequest} */
export function buildMaterialRequest(value, text) {
  const m = validateManifest(value);
  if (typeof text !== 'string' || !/** @type {WellFormedString} */ (text).isWellFormed() || !text.trim() || Buffer.byteLength(text) !== m.materialBytes
    || sha(text) !== m.materialSha256) throw protocolError('MATERIAL');
  return { scanId: m.scanId, model: m.model, thinking: m.thinking, materialSha256: m.materialSha256, text };
}

/** @param {unknown} value @param {string} [code] @returns {Usage} */
export function validateUsage(value, code = 'RESULT') {
  const usage = closedObject(value, [], usageKeys, code);
  if (!Object.keys(usage).length || Object.values(usage).some((n) => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) throw protocolError(code);
  return /** @type {Usage} */ ({ ...usage });
}

/** @param {unknown} value @param {MaterialIdentity} expected @returns {ScanResult} */
export function validateResult(value, expected) {
  const r = closedObject(value, ['scanId', 'materialSha256', 'model', 'thinking', 'reply', 'replySha256', 'finishReason'], ['usage'], 'RESULT');
  if (r.scanId !== expected.scanId || r.materialSha256 !== expected.materialSha256
    || r.model !== expected.model || r.thinking !== expected.thinking
    || r.finishReason !== 'STOP' || typeof r.reply !== 'string' || !/** @type {WellFormedString} */ (r.reply).isWellFormed() || !r.reply.trim()
    || Buffer.byteLength(r.reply) > MAX_REPLY_BYTES || r.replySha256 !== sha(r.reply)) throw protocolError('RESULT');
  if (Object.hasOwn(r, 'usage')) validateUsage(r.usage);
  return /** @type {ScanResult} */ (structuredClone(r));
}

/** @param {string} endpoint @returns {string} */
export function validateEndpoint(endpoint) {
  const match = typeof endpoint === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/generate$/.exec(endpoint);
  if (!match || Number(match[1]) > 65535) throw protocolError('ENDPOINT');
  return endpoint;
}

/** @param {string} path @param {number} limit @returns {string} */
function readInput(path, limit) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw protocolError('INPUT');
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || bytes.length > limit) throw protocolError('INPUT');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw protocolError('INPUT'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** @param {string} endpoint @param {string} nonce @param {string} body @param {number} timeoutMs @returns {Promise<unknown>} */
function post(endpoint, nonce, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    /** @param {Error|null} error @param {unknown} [value] */
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const req = request(endpoint, { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${nonce}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      if (res.statusCode !== 200) { finish(protocolError('HTTP_STATUS')); res.destroy(); return; }
      /** @type {Buffer[]} */ const chunks = []; let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { finish(protocolError('RESPONSE_SIZE')); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (!res.complete) { finish(protocolError('RESPONSE_TRUNCATED')); return; }
        try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
        catch { finish(protocolError('RESPONSE_JSON')); }
      });
      res.on('error', () => finish(protocolError('RESPONSE_TRUNCATED')));
    });
    const timer = setTimeout(() => { finish(protocolError('TIMEOUT')); req.destroy(); }, timeoutMs);
    req.on('error', () => finish(protocolError('NETWORK')));
    req.end(body);
  });
}

/** @param {ClientArgs} args @param {{timeoutMs?:number}} [options] @returns {Promise<ScanResult>} */
export async function runGeminiClient({ manifestFile, materialsFile, outFile, endpoint, nonce }, { timeoutMs = TIMEOUT_MS } = {}) {
  validateEndpoint(endpoint);
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(nonce)) throw protocolError('NONCE');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw protocolError('TIMEOUT');
  let manifest;
  try { manifest = JSON.parse(readInput(manifestFile, 16384)); } catch { throw protocolError('INPUT'); }
  const body = buildMaterialRequest(manifest, readInput(materialsFile, MAX_MATERIAL_BYTES));
  const result = validateResult(await post(endpoint, nonce, JSON.stringify(body), timeoutMs), manifest);
  try { writeFileSync(outFile, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch { throw protocolError('OUTPUT'); }
  return result;
}

/** @param {string[]} args @returns {ClientArgs} */
export function parseClientArgs(args) {
  const names = { '--manifest': 'manifestFile', '--materials': 'materialsFile', '--out': 'outFile', '--endpoint': 'endpoint', '--nonce': 'nonce' };
  /** @type {Partial<ClientArgs>} */ const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]], value = args[i + 1];
    if (!Object.hasOwn(names, args[i]) || Object.hasOwn(out, key) || !value || value.startsWith('--')) throw protocolError('ARGS');
    out[key] = value;
  }
  if (Object.keys(out).length !== Object.keys(names).length) throw protocolError('ARGS');
  return /** @type {ClientArgs} */ (out);
}

if (isMainModule(import.meta.url)) {
  try { await runGeminiClient(parseClientArgs(process.argv.slice(2))); process.stdout.write('Gemini 靜態材料結果已保存；仍須外層核對掃後收據。\n'); }
  catch (error) {
    const code = /^[A-Z_]+:/.exec(error instanceof Error ? error.message : '')?.[0]?.slice(0, -1) ?? 'CLIENT';
    process.stderr.write(protocolError(code).message + '\n'); process.exitCode = 2;
  }
}
