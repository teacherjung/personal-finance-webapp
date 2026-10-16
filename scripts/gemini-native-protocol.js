// @ts-check
// 結構化答案與一般對話文字分開驗；後者不能在結構化欄位缺失時補位。
import { isMainModule } from '../lib/is-main.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const MAX_MATERIAL_BYTES = 4 * 1024 * 1024;
export const MAX_WIRE_BYTES = MAX_MATERIAL_BYTES * 6 + 128;
export const OUTPUT_CAP = 256 * 1024;
export const RESPONSE_CAP = 64 * 1024;
export const NATIVE_LIMITS = Object.freeze({ clientSeconds: 120, wallMs: 150_000 });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** @param {string} code @returns {never} */
const fail = code => { throw Error(`GEMINI_NATIVE_${code}`); };
/** @param {string} value */
const wellFormed = value => /** @type {import('./gemini-client.js').WellFormedString} */ (value).isWellFormed();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, required, optional = []) {
  if (!object(value) || required.some(k => !Object.hasOwn(value, k))
    || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail('FIELDS');
}
function string(value, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || !wellFormed(value)
    || Buffer.byteLength(value) > max || [...value].some(c => c.charCodeAt(0) < 32 && !'\t\n\r'.includes(c))) fail('STRING');
}
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// JSON.parse 會保留重複鍵的最後一值；先按 JSON 文法辨認鍵，再交原生 parser 解析。
// 深度與節點上限避免模型文字把驗證器本身變成不受限的遞迴工作。
export function parseUniqueJson(text) {
  if (typeof text !== 'string' || !wellFormed(text)) fail('JSON');
  let pos = 0, nodes = 0;
  const ws = () => { while (/[ \r\n\t]/.test(text[pos] || '\x01')) pos++; };
  function tokenString() {
    const start = pos++;
    for (; pos < text.length; pos++) {
      if (text[pos] === '\\') { pos++; continue; }
      if (text[pos] === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, ++pos)); } catch { fail('JSON'); }
        if (!wellFormed(value)) fail('JSON');
        return value;
      }
    }
    fail('JSON');
  }
  function visit(depth) {
    if (++nodes > 100_000 || depth > 64) fail('JSON_LIMIT');
    ws(); const c = text[pos];
    if (c === '"') return tokenString();
    if (c === '{' || c === '[') {
      const end = c === '{' ? '}' : ']';
      const keys = new Set(); pos++; ws();
      if (text[pos] === end) { pos++; return; }
      for (;;) {
        ws();
        if (c === '{') {
          if (text[pos] !== '"') fail('JSON');
          const key = tokenString();
          if (keys.has(key)) fail('DUPLICATE_KEY');
          keys.add(key); ws(); if (text[pos++] !== ':') fail('JSON');
        }
        visit(depth + 1); ws();
        if (text[pos] === end) { pos++; return; }
        if (text[pos++] !== ',') fail('JSON');
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    if (!literal) fail('JSON');
    if (!['true', 'false', 'null'].includes(literal[0]) && !Number.isFinite(Number(literal[0]))) fail('JSON');
    pos += literal[0].length;
  }
  visit(0); ws(); if (pos !== text.length) fail('JSON');
  try { return JSON.parse(text); } catch { fail('JSON'); }
}

export function encodeNativeInput(material) {
  string(material, MAX_MATERIAL_BYTES);
  const bytes = Buffer.from(JSON.stringify({ event: 'user', message: { content: material } }) + '\n');
  if (bytes.length > MAX_WIRE_BYTES) fail('WIRE_SIZE');
  return { bytes, materialBytes: Buffer.byteLength(material), wireBytes: bytes.length, inputSha256: sha256(bytes) };
}

export function findingsSchema({ scanId, materialSha256 }) {
  string(scanId, 128);
  if (!/^[a-f0-9]{64}$/.test(materialSha256)) fail('BINDING');
  return {
    type: 'object', additionalProperties: false,
    required: ['scanId', 'materialSha256', 'tailChallenge', 'findings'],
    properties: {
      scanId: { type: 'string', enum: [scanId] },
      materialSha256: { type: 'string', enum: [materialSha256] },
      tailChallenge: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      findings: { type: 'array', maxItems: 50, items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'path', 'side', 'line', 'mechanism', 'reproduction'],
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          path: { type: 'string', minLength: 1, maxLength: 1000 },
          side: { type: 'string', enum: ['before', 'after'] },
          line: { type: 'integer', minimum: 1 },
          mechanism: { type: 'string', minLength: 1, maxLength: 4000 },
          reproduction: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      } },
    },
  };
}

export function validateFindings(answer, binding, files, tailChallenge) {
  fields(answer, ['scanId', 'materialSha256', 'tailChallenge', 'findings']);
  if (answer.scanId !== binding.scanId || answer.materialSha256 !== binding.materialSha256) fail('BINDING');
  if (typeof tailChallenge !== 'string' || !/^[a-f0-9]{64}$/.test(tailChallenge)
    || answer.tailChallenge !== tailChallenge) fail('TAIL_CHALLENGE');
  if (!Array.isArray(answer.findings) || answer.findings.length > 50) fail('FINDINGS');
  const index = new Map(files.map(file => [file.path, file]));
  for (const finding of answer.findings) {
    fields(finding, ['severity', 'path', 'side', 'line', 'mechanism', 'reproduction']);
    if (!['P0', 'P1', 'P2', 'P3'].includes(finding.severity) || !['before', 'after'].includes(finding.side)) fail('FINDING_ENUM');
    string(finding.path, 1000); string(finding.mechanism); string(finding.reproduction);
    const version = index.get(finding.path)?.[finding.side];
    if (!version || typeof version.text !== 'string') fail('FINDING_PATH');
    const lines = version.text === '' ? 0 : version.text.split('\n').length - (version.text.endsWith('\n') ? 1 : 0);
    if (!Number.isSafeInteger(finding.line) || finding.line < 1 || finding.line > lines) fail('FINDING_LINE');
  }
  return answer;
}

function usage(value) {
  fields(value, [], ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens']);
  if (Object.values(value).some(v => !Number.isSafeInteger(v) || v < 0)) fail('USAGE');
}

export function validateNativeStream({ stdout, stderr, code, timedOut, capped }, { model, schema, binding, files, tailChallenge }) {
  if (!Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stdout.length + stderr.length > OUTPUT_CAP) fail('OUTPUT_SIZE');
  if (code !== 0 || timedOut !== false || capped !== false) fail('INCOMPLETE');
  let text, err;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(stdout); err = new TextDecoder('utf-8', { fatal: true }).decode(stderr); }
  catch { fail('UTF8'); }
  // 警告也可能代表 CLI 只交出部分結果；先採零 stderr，避免把未知診斷當成功。
  if (err.length) fail('STDERR');
  if (!text.endsWith('\n')) fail('STREAM');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > 512 || lines.some(line => !line.trim())) fail('STREAM');
  const events = lines.map(parseUniqueJson);
  if (events.length < 5 || events[0]?.event !== 'init' || events.at(-1)?.event !== 'result'
    || events.slice(1, -1).some(e => e?.event !== 'step_update')) fail('STREAM');
  fields(events[0], ['event', 'conversation_id', 'init']);
  const cid = events[0].conversation_id, init = events[0].init;
  string(cid, 256);
  fields(init, ['model'], ['cwd', 'tools', 'permission_mode', 'agent', 'json_schema']);
  if (init.model !== model) fail('MODEL');
  for (const key of ['cwd', 'permission_mode', 'agent']) if (key in init) string(init[key], 1000);
  if ('tools' in init && (!Array.isArray(init.tools) || init.tools.length > 256 || init.tools.some(t => typeof t !== 'string' || t.length > 256))) fail('TOOLS_DECLARATION');
  if ('json_schema' in init && !isDeepStrictEqual(init.json_schema, schema)) fail('SCHEMA');
  let current = -1, closed = true, kind, users = 0, agents = 0, finishes = 0;
  const steps = events.slice(1, -1);
  for (const [i, event] of steps.entries()) {
    fields(event, ['event', 'step_update']);
    const step = event.step_update;
    fields(step, ['conversation_id', 'step_index', 'state', 'step_type'],
      ['duration_seconds', 'usage', ...(step?.step_type === 'agent_response' ? ['text_delta'] : [])]);
    if (step.conversation_id !== cid || !Number.isSafeInteger(step.step_index) || step.step_index < 0
      || !['ACTIVE', 'DONE'].includes(step.state) || !['user_input', 'agent_response', 'checkpoint', 'finish'].includes(step.step_type)) fail('STEP');
    if ('text_delta' in step && (typeof step.text_delta !== 'string' || !wellFormed(step.text_delta))) fail('STEP');
    if ('duration_seconds' in step && !finite(step.duration_seconds)) fail('STEP');
    if ('usage' in step) usage(step.usage);
    if (step.step_index !== current) {
      if (step.step_index <= current || !closed) fail('LIFECYCLE');
      current = step.step_index; kind = step.step_type; closed = false;
      if (kind === 'user_input' && (++users !== 1 || i !== 0 || step.state !== 'DONE')) fail('USER_INPUT');
    } else if (closed || kind !== step.step_type) fail('LIFECYCLE');
    if (step.state === 'DONE') { closed = true; if (kind === 'agent_response') agents++; }
    if (kind === 'finish') {
      fields(step, ['conversation_id', 'duration_seconds', 'state', 'step_index', 'step_type']);
      if (++finishes !== 1 || i !== steps.length - 1 || step.state !== 'DONE') fail('FINISH');
    }
  }
  if (!closed || users !== 1 || agents !== 1 || finishes !== 1) fail('LIFECYCLE');
  fields(events.at(-1), ['event', 'result']);
  const result = events.at(-1).result;
  fields(result, ['conversation_id', 'status', 'response', 'num_turns', 'structured_output', 'json_schema'], ['duration_seconds', 'usage', 'error']);
  if (result.conversation_id !== cid || result.status !== 'SUCCESS' || result.num_turns !== 1
    || ('error' in result && result.error !== '')) fail('RESULT');
  if ('duration_seconds' in result && !finite(result.duration_seconds)) fail('RESULT');
  if ('usage' in result) usage(result.usage);
  if (typeof result.response !== 'string' || !wellFormed(result.response) || Buffer.byteLength(result.response) > RESPONSE_CAP) fail('RESPONSE');
  if (!isDeepStrictEqual(result.json_schema, schema)) fail('SCHEMA');
  const candidateAnswer = validateFindings(result.structured_output, binding, files, tailChallenge);
  return { candidateAnswer, outputSha256: sha256(stdout), structuredSha256: sha256(JSON.stringify(candidateAnswer)),
    modelDeclaration: init.model, responseBytes: Buffer.byteLength(result.response),
    authority: 'STRUCTURED_OUTPUT_ONLY', structureValidated: true, tailChallengeMatched: true,
    receiverConsumptionVerified: false, formalScan: false };
}

if (isMainModule(import.meta.url)) {
  process.stderr.write('GEMINI_NATIVE_LIBRARY_ONLY\n'); process.exitCode = 2;
}
