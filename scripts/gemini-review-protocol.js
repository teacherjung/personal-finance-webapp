// @ts-check
// 只整理資格場原件；傳輸完整不等於工具執行、權限驗收或正式複審通過。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../lib/is-main.js';
import { parseUniqueJson } from './gemini-native-protocol.js';
import { GEMINI_REVIEW_CANDIDATE } from './gemini-review.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const OUTPUT_LIMIT = 64 * 1024 * 1024;
/** @returns {never} */
const fail = code => { throw Error(`GEMINI_REVIEW_${code}`); };

/** 僅借用通用 JSON 文法檢查，不借用掃描的 findings、容量或認證契約。 */
export function inspectQualificationOutput(stdout, exitCode) {
  if (!Buffer.isBuffer(stdout) || stdout.length > OUTPUT_LIMIT) fail('OUTPUT_SIZE');
  const text = stdout.toString('utf8');
  if (!Buffer.from(text).equals(stdout)) fail('OUTPUT_ENCODING');
  if (exitCode !== 0) fail('PROCESS_FAILED');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let events;
  try { events = lines.map(line => parseUniqueJson(line)); }
  catch { fail('OUTPUT_JSON'); }
  if (events.length < 2 || events[0]?.event !== 'init' || events.at(-1)?.event !== 'result'
    || events.filter(e => e?.event === 'init').length !== 1
    || events.filter(e => e?.event === 'result').length !== 1) fail('SESSION_STRUCTURE');
  const initial = events[0], result = events.at(-1).result;
  const id = initial.conversation_id;
  if (typeof id !== 'string' || !id || initial.init?.model !== GEMINI_REVIEW_CANDIDATE.model
    || initial.init?.permission_mode !== 'strict') fail('SESSION_IDENTITY');
  for (const event of events.slice(1, -1)) {
    if (event?.event !== 'step_update' || event.step_update?.conversation_id !== id) fail('SESSION_STRUCTURE');
  }
  if (!result || result.conversation_id !== id || result.status !== 'SUCCESS' || result.num_turns !== 1) fail('RESULT_IDENTITY');
  if (result.denied_actions !== undefined && (!Array.isArray(result.denied_actions) || result.denied_actions.length)) fail('TOOL_DENIED');
  if (typeof result.response !== 'string' || !result.response.trim()) fail('EMPTY_RESPONSE');
  // 保留完整末尾回覆，包括前言；不從中挑出看似有利的結論段。
  return { purpose: 'qualification', transportComplete: true, qualificationPassed: false, formalReviewCompleted: false,
    productionEnabled: false, declaredModel: initial.init.model, response: result.response,
    stdoutSha256: digest(stdout), responseSha256: digest(Buffer.from(result.response)),
    toolEvents: events.filter(e => e.event === 'step_update' && e.step_update.step_type === 'tool').map(e => e.step_update) };
}

/**
 * 發射器必須在啟動前取得 before；這裡只能保存呼叫者交來的原件，不能補造漏失的前值。
 * 此收件器不啟動模型，也不簽發正式複審或權限資格收據。
 */
export function saveQualificationEvidence({ directory, stdout, stderr, settingsBefore, settingsAfter, prompt, exitCode }) {
  const originals = { 'stdout.log': stdout, 'stderr.log': stderr, 'settings-before.json': settingsBefore,
    'settings-after.json': settingsAfter, 'prompt.txt': prompt };
  if (Object.values(originals).some(value => !Buffer.isBuffer(value))) fail('ORIGINALS_REQUIRED');
  // 獨立新目錄與獨占寫入避免把第二次嘗試蓋成第一次的證據。
  mkdirSync(directory, { mode: 0o700 });
  const hashes = {};
  for (const [name, bytes] of Object.entries(originals)) {
    writeFileSync(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
    hashes[name] = digest(bytes);
  }
  let transport = null, failure = null;
  try { transport = inspectQualificationOutput(stdout, exitCode); }
  catch (error) { failure = error instanceof Error ? error.message : 'GEMINI_REVIEW_OUTPUT_INVALID'; }
  const receipt = { schema: 'gemini-review-qualification-evidence/v1', purpose: 'qualification',
    qualificationPassed: false, formalReviewCompleted: false, productionEnabled: false,
    settingsBytesUnchanged: settingsBefore.equals(settingsAfter), effectivePermissionsVerified: false,
    hashes, transport, failure };
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

if (isMainModule(import.meta.url)) {
  process.stderr.write('GEMINI_REVIEW_LIBRARY_ONLY\n');
  process.exitCode = 2;
}
