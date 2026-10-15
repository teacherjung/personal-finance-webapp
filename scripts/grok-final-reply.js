// @ts-check
// 固定 CLI 1.0.46、--no-subagents：root 為 encodeURIComponent(src)/UUID/chat_history.jsonl。
// 只讀既有安全快照的最後一列；不按標頭、mtime 或較早 assistant 猜測完成狀態。
// stdout 由管線解碼成字串；雜湊與範圍指保存文字的 UTF-8 表示，不是未保存的 OS 原始 bytes。
import { createHash } from 'node:crypto';
import { isMainModule } from '../lib/is-main.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const hash = (/** @type {string | Buffer} */ value) => createHash('sha256').update(value).digest('hex');
/** @type {(ok: unknown) => asserts ok} */
const demand = (ok) => { if (!ok) throw new Error('GROK_FINAL_SELECTION_INVALID'); };
/** @param {unknown} value @returns {asserts value is string} */
function text(value) {
  demand(typeof value === 'string' && value.trim() !== '');
  demand(Buffer.from(value, 'utf8').toString('utf8') === value);
}

/** @typedef {{schema:string, cliVersion:string, encoding:string, transcriptPath:string, transcriptSha256:string,
 * rowCount:number, rowIndex:number, byteStart:number, byteEnd:number, stdoutBytes:number, replyBytes:number}} FinalSelection */
/** @typedef {{reply:string, replySha256:string, stdout:string, stdoutSha256:string, selection:FinalSelection}} SelectedReply */

/** 前端核對同一份 runner 收據；不取代 runner 對快照、身分、模型或 DLP 的驗證。
 * @param {SelectedReply} selected */
export function verifyFinalSelection(selected) {
  demand(selected && typeof selected === 'object');
  const { reply, replySha256, stdout, stdoutSha256, selection: s } = selected;
  text(reply); text(stdout);
  demand(replySha256 === hash(reply) && stdoutSha256 === hash(stdout));
  demand(s && typeof s === 'object' && !Array.isArray(s));
  demand(Object.keys(s).sort().join(',') === 'byteEnd,byteStart,cliVersion,encoding,replyBytes,rowCount,rowIndex,schema,stdoutBytes,transcriptPath,transcriptSha256');
  demand(s.schema === 'grok-final-selection/v1' && s.cliVersion === '1.0.46' && s.encoding === 'decoded-stdout-utf8');
  demand(typeof s.transcriptPath === 'string');
  const parts = s.transcriptPath.split('/');
  demand(parts.length === 3 && parts[0].startsWith('%2F') && UUID.test(parts[1]) && parts[2] === 'chat_history.jsonl');
  demand(SHA.test(s.transcriptSha256) && Number.isSafeInteger(s.rowCount) && s.rowCount > 0 && s.rowIndex === s.rowCount - 1);
  const all = Buffer.from(stdout, 'utf8'), final = Buffer.from(reply, 'utf8');
  demand(Number.isSafeInteger(s.byteStart) && s.byteStart >= 0 && Number.isSafeInteger(s.byteEnd)
    && s.byteEnd === s.byteStart + final.length && s.stdoutBytes === all.length && s.replyBytes === final.length);
  demand(all.subarray(s.byteStart, s.byteEnd).equals(final));
  demand(all.indexOf(final) === s.byteStart && all.indexOf(final, s.byteStart + 1) === -1);
  const before = all.subarray(0, s.byteStart).toString('utf8'), after = all.subarray(s.byteEnd).toString('utf8');
  demand((after === '' || after === '\n') && !before.includes('🤖'));
  return selected;
}

/** @param {Map<string, Buffer>} files @param {string} workspace @param {string} stdout @param {string} cliVersion
 * @returns {SelectedReply} */
export function selectFinalReply(files, workspace, stdout, cliVersion) {
  try {
    demand(cliVersion === '1.0.46' && typeof workspace === 'string' && workspace.startsWith('/'));
    const prefix = encodeURIComponent(workspace) + '/';
    const sessions = new Set([...files.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0]));
    demand(sessions.size === 1);
    const session = [...sessions][0];
    demand(UUID.test(session));
    const transcriptPath = prefix + session + '/chat_history.jsonl';
    const bytes = files.get(transcriptPath);
    demand(bytes && bytes.length > 0);
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    demand(decoded.endsWith('\n'));
    const lines = decoded.slice(0, -1).split('\n');
    // 所有列須完整 JSON；除最後一列外只驗語法，不讀 reasoning／tool／較早訊息的內容。
    const rows = lines.map(line => JSON.parse(line));
    const last = rows[rows.length - 1];
    demand(last && typeof last === 'object' && !Array.isArray(last));
    demand(Object.keys(last).sort().join(',') === 'content,model_fingerprint,model_id,reasoning_effort,type');
    demand(last.type === 'assistant' && typeof last.model_id === 'string'
      && typeof last.model_fingerprint === 'string' && typeof last.reasoning_effort === 'string');
    const reply = last.content;
    text(reply); text(stdout);
    const all = Buffer.from(stdout, 'utf8'), final = Buffer.from(reply, 'utf8');
    const byteStart = all.indexOf(final);
    return verifyFinalSelection({ reply, replySha256: hash(reply), stdout, stdoutSha256: hash(stdout),
      selection: { schema: 'grok-final-selection/v1', cliVersion, encoding: 'decoded-stdout-utf8',
        transcriptPath, transcriptSha256: hash(bytes), rowCount: rows.length, rowIndex: rows.length - 1,
        byteStart, byteEnd: byteStart + final.length, stdoutBytes: all.length, replyBytes: final.length } });
  } catch { throw new Error('GROK_FINAL_SELECTION_INVALID'); }
}

if (isMainModule(import.meta.url)) {
  process.stderr.write('GROK_FINAL_ENTRY：此模組只供安全 runner 與正式前端載入，不接受直接啟動。\n');
  process.exitCode = 2;
}
