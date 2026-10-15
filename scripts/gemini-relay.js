// @ts-check
// 盒外有限 relay：憑證只由注入函式取得；沒有登入、onboard、設定或加購 API。
import { isMainModule } from '../lib/is-main.js';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { buildMaterialRequest, closedObject, protocolError, validateManifest, validateResult, validateUsage, MAX_RESPONSE_BYTES } from './gemini-client.js';

/** @typedef {import('./gemini-client.js').MaterialIdentity} MaterialIdentity */
/** @typedef {import('./gemini-client.js').MaterialManifest} MaterialManifest */
/** @typedef {import('./gemini-client.js').ScanResult} ScanResult */
/** @typedef {MaterialIdentity & {nonce:string,materialBytes:number,project:string,getAccessToken:()=>Promise<string>,port?:number}} RelayConfig */
/** @typedef {{url:string,method:'POST',headers:Record<string,string>,body:string,signal:AbortSignal}} TransportRequest */
/** @typedef {{statusCode:number|undefined,body:Buffer}} TransportResponse */
/** @typedef {(request:TransportRequest)=>Promise<TransportResponse>} Transport */
/** @typedef {{failed:boolean,reason:string|null,requestCount:number,response:ScanResult|null}} RelaySnapshot */
/** @typedef {{port:number,url:string,snapshot:()=>RelaySnapshot,close:()=>Promise<void>}} GeminiRelay */

export const UPSTREAM_URL = 'https://cloudcode-pa.googleapis.com/v1internal:generateContent';
// JSON 字串轉義可以膨脹材料；原文大小另外按 manifest 核對。
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30 * 60 * 1000;
/** @param {string} value */
const sha = (value) => createHash('sha256').update(value).digest('hex');

/** @param {RelayConfig} config @returns {MaterialManifest} */
function materialManifest(config) {
  return { schema: 'gemini-scan-material/v1', base: '0'.repeat(40), head: '0'.repeat(40), scanId: config.scanId, model: config.model, thinking: config.thinking, materialSha256: config.materialSha256, materialBytes: config.materialBytes };
}

/** @param {unknown} value @param {MaterialIdentity} expected @returns {ScanResult} */
export function normalizeCodeAssistResponse(value, expected) {
  const envelope = closedObject(value, ['response'], ['traceId', 'remainingCredits', 'consumedCredits'], 'UPSTREAM_ENVELOPE');
  // 不把付費資訊默默抹掉，外層也不能將付費回應當成正常掃描。
  if (Object.hasOwn(envelope, 'consumedCredits') && (!Array.isArray(envelope.consumedCredits) || envelope.consumedCredits.length)) throw protocolError('UPSTREAM_CREDITS');
  const response = closedObject(envelope.response, ['modelVersion', 'candidates'], ['usageMetadata', 'responseId', 'createTime', 'promptFeedback'], 'UPSTREAM_SCHEMA');
  if (response.modelVersion !== expected.model) throw protocolError('UPSTREAM_MODEL');
  if (!Array.isArray(response.candidates) || response.candidates.length !== 1) throw protocolError('UPSTREAM_CANDIDATES');
  const candidate = closedObject(response.candidates[0], ['content', 'finishReason'], ['index', 'safetyRatings', 'finishMessage', 'citationMetadata', 'avgLogprobs'], 'UPSTREAM_CANDIDATE');
  if (candidate.finishReason !== 'STOP') throw protocolError('UPSTREAM_FINISH');
  const content = closedObject(candidate.content, ['role', 'parts'], [], 'UPSTREAM_CONTENT');
  if (content.role !== 'model' || !Array.isArray(content.parts) || !content.parts.length || content.parts.length > 10000) throw protocolError('UPSTREAM_PARTS');
  /** @type {string[]} */ const texts = [];
  for (const item of content.parts) {
    const part = closedObject(item, ['text'], ['thought', 'thoughtSignature'], 'UPSTREAM_PART');
    if (typeof part.text !== 'string' || (Object.hasOwn(part, 'thought') && typeof part.thought !== 'boolean')
      || (Object.hasOwn(part, 'thoughtSignature') && typeof part.thoughtSignature !== 'string')) throw protocolError('UPSTREAM_PART');
    if (part.thought !== true) texts.push(part.text);
  }
  const reply = texts.join('');
  /** @type {ScanResult} */ const result = { scanId: expected.scanId, materialSha256: expected.materialSha256, model: response.modelVersion, thinking: expected.thinking, reply, replySha256: sha(reply), finishReason: 'STOP' };
  if (Object.hasOwn(response, 'usageMetadata')) result.usage = validateUsage(response.usageMetadata, 'UPSTREAM_USAGE');
  try { return validateResult(result, expected); } catch { throw protocolError('UPSTREAM_RESULT'); }
}

/** @type {Transport} */
function productionTransport({ url, method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, headers, signal, agent: false }, (res) => {
      /** @type {Buffer[]} */ const chunks = []; let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { res.destroy(protocolError('UPSTREAM_SIZE')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (!res.complete) reject(protocolError('UPSTREAM_TRUNCATED'));
        else resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) });
      });
      res.on('error', () => reject(protocolError('UPSTREAM_NETWORK')));
    });
    req.on('error', () => reject(protocolError('UPSTREAM_NETWORK')));
    req.end(body);
  });
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<unknown>} */
async function readBody(req) {
  let size = 0; /** @type {Buffer[]} */ const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw protocolError('BODY_SIZE');
    chunks.push(chunk);
  }
  if (!req.complete) throw protocolError('BODY_TRUNCATED');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw protocolError('BODY_JSON'); }
}

/** @template T @param {Promise<T>|T} promise @param {AbortSignal} signal @returns {Promise<T>} */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(protocolError('REFUSED'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** @param {RelayConfig} config @param {{transport?:Transport}} [options] @returns {Promise<GeminiRelay>} */
export async function startGeminiRelay(config, { transport = productionTransport } = {}) {
  closedObject(config, ['nonce', 'scanId', 'materialSha256', 'materialBytes', 'model', 'thinking', 'getAccessToken', 'project'], ['port'], 'CONFIG');
  validateManifest(materialManifest(config));
  if (typeof config.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(config.nonce)
    || typeof config.project !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(config.project)
    || typeof config.getAccessToken !== 'function' || typeof transport !== 'function'
    || (Object.hasOwn(config, 'port') && (typeof config.port !== 'number' || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535))) throw protocolError('CONFIG');
  // 複製非機密固定值，避免呼叫者在等待期間換掉核對基準。
  config = Object.freeze({ ...config });
  let failed = false, requestCount = 0, active = 0, closing = false;
  /** @type {string|null} */ let reason = null;
  /** @type {ScanResult|null} */ let response = null;
  /** @type {Promise<void>|undefined} */ let closePromise;
  /** @type {Set<import('node:net').Socket>} */ const sockets = new Set();
  /** @type {Set<AbortController>} */ const controllers = new Set();
  /** @type {WeakSet<import('node:net').Socket>} */ const completedSockets = new WeakSet();
  /** @param {string} code */
  function fail(code) { failed = true; reason ??= code; response = null; }
  /** @param {import('node:http').ServerResponse} res */
  function replyError(res) { if (!res.destroyed) { res.writeHead(400, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify({ error: reason ?? 'REFUSED' })); } }
  const server = createServer(async (req, res) => {
    requestCount += 1;
    if (closing || failed || requestCount !== 1) { fail('SINGLE_USE'); replyError(res); return; }
    active += 1;
    const controller = new AbortController(); controllers.add(controller);
    const requestSocket = req.socket;
    res.once('finish', () => completedSockets.add(requestSocket));
    res.once('close', () => { if (!res.writableFinished) { fail('CLIENT_DISCONNECTED'); controller.abort(); } });
    const timeout = setTimeout(() => { fail('TIMEOUT'); controller.abort(); req.destroy(); res.destroy(); }, TIMEOUT_MS);
    try {
      const authCount = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization').length;
      if (req.method !== 'POST' || req.url !== '/generate') throw protocolError('ROUTE');
      if (authCount !== 1 || req.headers.authorization !== `Bearer ${config.nonce}`) throw protocolError('NONCE');
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) throw protocolError('CONTENT_TYPE');
      const input = closedObject(await readBody(req), ['scanId', 'model', 'thinking', 'materialSha256', 'text'], [], 'REQUEST_SCHEMA');
      if (input.scanId !== config.scanId || input.model !== config.model || input.thinking !== config.thinking || input.materialSha256 !== config.materialSha256) throw protocolError('REQUEST_BINDING');
      buildMaterialRequest(materialManifest(config), input.text);
      if (failed || closing) throw protocolError('REFUSED');
      const token = await abortable(config.getAccessToken(), controller.signal);
      if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/.test(token) || token.includes(String.fromCharCode(0))) throw protocolError('AUTH');
      if (failed || closing) throw protocolError('REFUSED');
      const body = JSON.stringify({ model: config.model, project: config.project, user_prompt_id: config.scanId, request: { contents: [{ role: 'user', parts: [{ text: input.text }] }], generationConfig: { thinkingConfig: { thinkingLevel: config.thinking } }, session_id: config.scanId } });
      const upstream = await abortable(transport({ url: UPSTREAM_URL, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body, signal: controller.signal }), controller.signal);
      if (upstream?.statusCode !== 200) throw protocolError('UPSTREAM_STATUS');
      if (!Buffer.isBuffer(upstream.body) || upstream.body.length > MAX_RESPONSE_BYTES) throw protocolError('UPSTREAM_SIZE');
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(upstream.body)); } catch { throw protocolError('UPSTREAM_JSON'); }
      const result = normalizeCodeAssistResponse(value, config);
      if (result.reply.includes(token) || result.reply.includes(config.project)) throw protocolError('UPSTREAM_SECRET');
      if (failed || closing) throw protocolError('REFUSED');
      response = result;
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify(result));
    } catch (error) {
      const code = /^[A-Z_]+:/.exec(error instanceof Error ? error.message : '')?.[0]?.slice(0, -1) ?? 'RELAY_FAILURE';
      const safeCodes = new Set(['ROUTE', 'NONCE', 'CONTENT_TYPE', 'REQUEST_SCHEMA', 'REQUEST_BINDING', 'MATERIAL', 'BODY_SIZE', 'BODY_JSON', 'BODY_TRUNCATED', 'AUTH', 'REFUSED', 'UPSTREAM_STATUS', 'UPSTREAM_SIZE', 'UPSTREAM_JSON', 'UPSTREAM_ENVELOPE', 'UPSTREAM_CREDITS', 'UPSTREAM_SCHEMA', 'UPSTREAM_MODEL', 'UPSTREAM_CANDIDATES', 'UPSTREAM_CANDIDATE', 'UPSTREAM_FINISH', 'UPSTREAM_CONTENT', 'UPSTREAM_PARTS', 'UPSTREAM_PART', 'UPSTREAM_USAGE', 'UPSTREAM_RESULT', 'UPSTREAM_SECRET']);
      fail(safeCodes.has(code) ? code : 'RELAY_FAILURE'); replyError(res);
    } finally { clearTimeout(timeout); controllers.delete(controller); active -= 1; }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { fail('HTTP_PROTOCOL'); socket.destroy(); });
  for (const event of ['connect', 'upgrade']) server.on(event, (_req, socket) => { fail('ROUTE'); socket.destroy(); });
  server.on('error', () => fail('SERVER'));
  await new Promise(/** @param {(value?:void)=>void} resolve */ (resolve, reject) => {
    const bindError = () => reject(protocolError('BIND'));
    server.once('error', bindError);
    server.listen(config.port ?? 0, '127.0.0.1', () => { server.removeListener('error', bindError); resolve(); });
  });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return {
    port, url: `http://127.0.0.1:${port}/generate`,
    snapshot: () => structuredClone({ failed, reason, requestCount, response }),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      if (active || [...sockets].some((socket) => !completedSockets.has(socket))) fail('CLOSED_ACTIVE');
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise(/** @param {(value?:void)=>void} resolve */ (resolve) => server.close(() => resolve()));
      return closePromise;
    },
  };
}

if (isMainModule(import.meta.url)) {
  process.stderr.write('GEMINI_RELAY_ENTRY：此模組由 scripts/gemini-scan.js 載入，不接受直接啟動。\n');
  process.exitCode = 2;
}
