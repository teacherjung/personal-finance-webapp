// @ts-check
// 固定 CLI 1.0.46、--no-subagents：root 為 encodeURIComponent(src)/UUID/chat_history.jsonl。
// 只讀既有安全快照的最後一列；不按標頭、mtime 或較早 assistant 猜測完成狀態。
// stdout 由管線解碼成字串；雜湊與範圍指保存文字的 UTF-8 表示，不是未保存的 OS 原始 bytes。
import { createHash } from 'node:crypto';
import { isMainModule } from '../lib/is-main.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const hash = (/** @type {string | Buffer} */ value) => createHash('sha256').update(value).digest('hex');
const FAILURE_CODES = Object.freeze([
  'VERSION_WORKSPACE', 'ROOT_CARDINALITY', 'ROOT_ID', 'TRANSCRIPT_MISSING', 'TRANSCRIPT_UTF8',
  'TRANSCRIPT_TERMINATION', 'TRANSCRIPT_JSON', 'FINAL_OBJECT', 'FINAL_KEYS', 'FINAL_ROLE_METADATA',
  'FINAL_CONTENT', 'STDOUT_TEXT', 'EXACT_MATCH', 'UNIQUE_MATCH', 'TRAILING_STDOUT', 'PREFIX_MARKER',
  'SELECTION_RECEIPT', 'UNKNOWN',
]);
// 不讀 Error 的公開屬性：外來 throw 可以偽造 code，或以 getter 夾帶原文。
const failureCodes = new WeakMap();
const rootDiagnostics = new WeakMap();
const CARDINALITIES = Object.freeze(['ZERO', 'ONE', 'MULTIPLE']);
const ROOT_FIELDS = Object.freeze(['rootComponents', 'uuidComponents', 'exactUuidTranscripts',
  'directWorkspaceFilePresent', 'nonUuidNestedComponentPresent', 'otherWorkspaceTopComponentPresent', 'equivalentEncodedWorkspacePresent']);
/** @typedef {{rootComponents:string, uuidComponents:string, exactUuidTranscripts:string,
 * directWorkspaceFilePresent:boolean, nonUuidNestedComponentPresent:boolean,
 * otherWorkspaceTopComponentPresent:boolean, equivalentEncodedWorkspacePresent:boolean}} RootDiagnostic */
/** @param {unknown} error @returns {RootDiagnostic | 'UNKNOWN'} */
export function finalSelectionRootDiagnostic(error) {
  const value = error && typeof error === 'object' ? rootDiagnostics.get(error) : undefined;
  if (!value || typeof value !== 'object') return 'UNKNOWN';
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).sort().join(',') !== [...ROOT_FIELDS].sort().join(',')) return 'UNKNOWN';
  for (const [index, key] of ROOT_FIELDS.entries()) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || (index < 3 ? !CARDINALITIES.includes(descriptor.value) : typeof descriptor.value !== 'boolean')) return 'UNKNOWN';
  }
  return Object.freeze({ rootComponents: value.rootComponents, uuidComponents: value.uuidComponents,
    exactUuidTranscripts: value.exactUuidTranscripts, directWorkspaceFilePresent: value.directWorkspaceFilePresent,
    nonUuidNestedComponentPresent: value.nonUuidNestedComponentPresent,
    otherWorkspaceTopComponentPresent: value.otherWorkspaceTopComponentPresent,
    equivalentEncodedWorkspacePresent: value.equivalentEncodedWorkspacePresent });
}
/** @param {number} size */
const cardinality = size => size === 0 ? 'ZERO' : size === 1 ? 'ONE' : 'MULTIPLE';
/** @param {string[]} paths @param {string} prefix */
const components = (paths, prefix) => new Set(paths.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0]));
/** @param {string[]} paths @param {string} workspace @returns {RootDiagnostic} */
function rootPathProjection(paths, workspace) {
  const encoded = encodeURIComponent(workspace), prefix = encoded + '/';
  const sessions = components(paths, prefix), uuids = [...sessions].filter(component => UUID.test(component));
  const keys = new Set(paths), relative = paths.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length));
  const other = paths.map(path => path.split('/')[0]).filter(component => component !== encoded);
  return Object.freeze({ rootComponents: cardinality(sessions.size), uuidComponents: cardinality(uuids.length),
    exactUuidTranscripts: cardinality(uuids.filter(uuid => keys.has(prefix + uuid + '/chat_history.jsonl')).length),
    directWorkspaceFilePresent: relative.some(path => !path.includes('/')),
    nonUuidNestedComponentPresent: relative.some(path => path.includes('/') && !UUID.test(path.split('/')[0])),
    otherWorkspaceTopComponentPresent: other.length > 0,
    equivalentEncodedWorkspacePresent: other.some(component => { try { return decodeURIComponent(component) === workspace; } catch { return false; } }) });
}
/** Only path keys are inspected; malformed callers cannot expose an exception or a key.
 * @param {Map<string, Buffer>} files @param {string} workspace @returns {RootDiagnostic | 'UNKNOWN'} */
export function rootCardinalityProjection(files, workspace) {
  try {
    if (typeof workspace !== 'string' || !workspace.startsWith('/')) return 'UNKNOWN';
    const paths = [...files.keys()];
    if (!paths.every(path => typeof path === 'string')) return 'UNKNOWN';
    return rootPathProjection(paths, workspace);
  } catch { return 'UNKNOWN'; }
}
/** @param {unknown} error */
export function finalSelectionFailureCode(error) {
  const code = error && typeof error === 'object' ? failureCodes.get(error) : undefined;
  return FAILURE_CODES.find(allowed => allowed === code) ?? 'UNKNOWN';
}
/** @param {string} code @param {RootDiagnostic | 'UNKNOWN'} [diagnostic] */
function failure(code, diagnostic = 'UNKNOWN') {
  const error = new Error('GROK_FINAL_SELECTION_INVALID');
  failureCodes.set(error, code);
  if (code === 'ROOT_CARDINALITY' && diagnostic !== 'UNKNOWN') rootDiagnostics.set(error, diagnostic);
  return error;
}
/** @type {(ok: unknown, code: string) => asserts ok} */
const demand = (ok, code) => { if (!ok) throw failure(code); };
/** @param {unknown} value @param {string} code @returns {asserts value is string} */
function text(value, code) {
  demand(typeof value === 'string' && value.trim() !== '', code);
  demand(Buffer.from(value, 'utf8').toString('utf8') === value, code);
}

/** @typedef {{schema:string, cliVersion:string, encoding:string, transcriptPath:string, transcriptSha256:string,
 * rowCount:number, rowIndex:number, byteStart:number, byteEnd:number, stdoutBytes:number, replyBytes:number}} FinalSelection */
/** @typedef {{reply:string, replySha256:string, stdout:string, stdoutSha256:string, selection:FinalSelection}} SelectedReply */

/** 前端核對同一份 runner 收據；不取代 runner 對快照、身分、模型或 DLP 的驗證。
 * @param {SelectedReply} selected */
export function verifyFinalSelection(selected) {
  demand(selected && typeof selected === 'object', 'SELECTION_RECEIPT');
  const { reply, replySha256, stdout, stdoutSha256, selection: s } = selected;
  text(reply, 'FINAL_CONTENT'); text(stdout, 'STDOUT_TEXT');
  demand(replySha256 === hash(reply) && stdoutSha256 === hash(stdout), 'SELECTION_RECEIPT');
  demand(s && typeof s === 'object' && !Array.isArray(s), 'SELECTION_RECEIPT');
  demand(Object.keys(s).sort().join(',') === 'byteEnd,byteStart,cliVersion,encoding,replyBytes,rowCount,rowIndex,schema,stdoutBytes,transcriptPath,transcriptSha256', 'SELECTION_RECEIPT');
  demand(s.schema === 'grok-final-selection/v1' && s.cliVersion === '1.0.46' && s.encoding === 'decoded-stdout-utf8', 'SELECTION_RECEIPT');
  demand(typeof s.transcriptPath === 'string', 'SELECTION_RECEIPT');
  const parts = s.transcriptPath.split('/');
  demand(parts.length === 3 && parts[0].startsWith('%2F') && UUID.test(parts[1]) && parts[2] === 'chat_history.jsonl', 'SELECTION_RECEIPT');
  demand(SHA.test(s.transcriptSha256) && Number.isSafeInteger(s.rowCount) && s.rowCount > 0 && s.rowIndex === s.rowCount - 1, 'SELECTION_RECEIPT');
  const all = Buffer.from(stdout, 'utf8'), final = Buffer.from(reply, 'utf8');
  demand(Number.isSafeInteger(s.byteStart) && s.byteStart >= 0 && Number.isSafeInteger(s.byteEnd)
    && s.byteEnd === s.byteStart + final.length && s.stdoutBytes === all.length && s.replyBytes === final.length, 'SELECTION_RECEIPT');
  demand(all.subarray(s.byteStart, s.byteEnd).equals(final), 'EXACT_MATCH');
  demand(all.indexOf(final) === s.byteStart && all.indexOf(final, s.byteStart + 1) === -1, 'UNIQUE_MATCH');
  const before = all.subarray(0, s.byteStart).toString('utf8'), after = all.subarray(s.byteEnd).toString('utf8');
  demand(after === '' || after === '\n', 'TRAILING_STDOUT');
  demand(!before.includes('🤖'), 'PREFIX_MARKER');
  return selected;
}

/** @param {Map<string, Buffer>} files @param {string} workspace @param {string} stdout @param {string} cliVersion
 * @returns {SelectedReply} */
export function selectFinalReply(files, workspace, stdout, cliVersion) {
  try {
    demand(cliVersion === '1.0.46' && typeof workspace === 'string' && workspace.startsWith('/'), 'VERSION_WORKSPACE');
    const prefix = encodeURIComponent(workspace) + '/';
    const paths = [...files.keys()];
    // 直層檔不是對話目錄；保留非 UUID 巢狀元件，避免先挑合格者而漏掉競爭候選。
    const sessions = components(paths.filter(path => path.startsWith(prefix) && path.slice(prefix.length).includes('/')), prefix);
    const diagnostic = rootPathProjection(paths, workspace);
    if (sessions.size !== 1) throw failure('ROOT_CARDINALITY', diagnostic);
    const session = [...sessions][0];
    demand(UUID.test(session), 'ROOT_ID');
    const transcriptPath = prefix + session + '/chat_history.jsonl';
    const bytes = files.get(transcriptPath);
    demand(bytes && bytes.length > 0, 'TRANSCRIPT_MISSING');
    let decoded;
    try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw failure('TRANSCRIPT_UTF8'); }
    demand(decoded.endsWith('\n'), 'TRANSCRIPT_TERMINATION');
    const lines = decoded.slice(0, -1).split('\n');
    // 所有列須完整 JSON；除最後一列外只驗語法，不讀 reasoning／tool／較早訊息的內容。
    let rows;
    try { rows = lines.map(line => JSON.parse(line)); }
    catch { throw failure('TRANSCRIPT_JSON'); }
    const last = rows[rows.length - 1];
    demand(last && typeof last === 'object' && !Array.isArray(last), 'FINAL_OBJECT');
    demand(Object.keys(last).sort().join(',') === 'content,model_fingerprint,model_id,reasoning_effort,type', 'FINAL_KEYS');
    demand(last.type === 'assistant' && typeof last.model_id === 'string'
      && typeof last.model_fingerprint === 'string' && typeof last.reasoning_effort === 'string', 'FINAL_ROLE_METADATA');
    const reply = last.content;
    text(reply, 'FINAL_CONTENT'); text(stdout, 'STDOUT_TEXT');
    const all = Buffer.from(stdout, 'utf8'), final = Buffer.from(reply, 'utf8');
    const byteStart = all.indexOf(final);
    demand(byteStart >= 0, 'EXACT_MATCH');
    return verifyFinalSelection({ reply, replySha256: hash(reply), stdout, stdoutSha256: hash(stdout),
      selection: { schema: 'grok-final-selection/v1', cliVersion, encoding: 'decoded-stdout-utf8',
        transcriptPath, transcriptSha256: hash(bytes), rowCount: rows.length, rowIndex: rows.length - 1,
        byteStart, byteEnd: byteStart + final.length, stdoutBytes: all.length, replyBytes: final.length } });
  } catch (error) { throw failure(finalSelectionFailureCode(error), finalSelectionRootDiagnostic(error)); }
}

if (isMainModule(import.meta.url)) {
  process.stderr.write('GROK_FINAL_ENTRY：此模組只供安全 runner 與正式前端載入，不接受直接啟動。\n');
  process.exitCode = 2;
}
