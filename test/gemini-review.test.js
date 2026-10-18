import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GEMINI_REVIEW_CANDIDATE, runGeminiReview } from '../scripts/gemini-review.js';
import { inspectQualificationOutput, saveQualificationEvidence } from '../scripts/gemini-review-protocol.js';

const fixture = () => [
  { event: 'init', conversation_id: 'synthetic-session', init: { model: 'gemini-4-argon-high', permission_mode: 'strict' } },
  { event: 'step_update', step_update: { conversation_id: 'synthetic-session', step_type: 'tool', tool_name: 'view_file', state: 'DONE' } },
  { event: 'result', result: { conversation_id: 'synthetic-session', status: 'SUCCESS', num_turns: 1, response: '完整前言\n合成結論\nQUALIFICATION_ONLY\n' } },
];
const wire = events => Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n');

test('未通過資格的正式入口拒絕，環境與旗標不能啟用，也不讀呼叫材料', () => {
  let read = false;
  const material = new Proxy({}, { get() { read = true; throw Error('read material'); } });
  assert.throws(() => runGeminiReview(material), /GEMINI_REVIEW_NOT_ENABLED/);
  assert.equal(read, false);
  assert.equal(GEMINI_REVIEW_CANDIDATE.enabled, false);
  assert.throws(() => { GEMINI_REVIEW_CANDIDATE.enabled = true; }, TypeError);
  const child = spawnSync(process.execPath, ['scripts/gemini-review.js', '--enable', '--purpose', 'review'], {
    cwd: new URL('..', import.meta.url), env: { PATH: '/usr/bin:/bin', GEMINI_REVIEW_ENABLED: 'true' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 78);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /^GEMINI_REVIEW_NOT_ENABLED:/);
});

test('保留完整末尾原文且不沿用掃描的小容量；傳輸完整仍不能算複審或工具資格', () => {
  const events = fixture();
  const response = '前言\n' + '合成長材料'.repeat(20_000) + '\n完整末尾\n';
  events.at(-1).result.response = response;
  const result = inspectQualificationOutput(wire(events), 0);
  assert.equal(result.response, response);
  assert.equal(result.toolEvents.length, 1);
  assert.equal(result.transportComplete, true);
  assert.equal(result.qualificationPassed, false);
  assert.equal(result.formalReviewCompleted, false);
  assert.equal(result.productionEnabled, false);
});

test('原生 SUCCESS 仍拒收空回覆、工具拒絕、錯模型、跨對話、多結果及毀損輸出', () => {
  assert.equal(inspectQualificationOutput(wire(fixture()), 0).transportComplete, true);
  for (const mutate of [
    e => { e.at(-1).result.response = ''; },
    e => { e.at(-1).result.denied_actions = [{ action: 'read_file' }]; },
    e => { e[0].init.model = 'different-model'; },
    e => { e[0].init.permission_mode = 'auto'; },
    e => { e[1].step_update.conversation_id = 'different-session'; },
    e => { e.at(-1).result.num_turns = 2; },
    e => { e.push(structuredClone(e.at(-1))); },
  ]) { const events = fixture(); mutate(events); assert.throws(() => inspectQualificationOutput(wire(events), 0)); }
  assert.throws(() => inspectQualificationOutput(wire(fixture()), 1), /PROCESS_FAILED/);
  assert.throws(() => inspectQualificationOutput(Buffer.from('{"event":"init","event":"result"}\n'), 0), /OUTPUT_JSON/);
  assert.throws(() => inspectQualificationOutput(Buffer.concat([wire(fixture()), Buffer.from([0xff])]), 0), /OUTPUT_ENCODING/);
});

test('失敗場仍私存完整原件與前後設定，沒有前值不能補造；重跑不能覆蓋', () => {
  const root = mkdtempSync(join(tmpdir(), 'gemini-review-evidence-'));
  try {
    const events = fixture(); events.at(-1).result.response = '';
    const args = { directory: join(root, 'run'), stdout: wire(events), stderr: Buffer.from('synthetic denial'),
      settingsBefore: Buffer.from('{"synthetic":"before"}'), settingsAfter: Buffer.from('{"synthetic":"after"}'),
      prompt: Buffer.from('synthetic prompt'), exitCode: 0 };
    const result = saveQualificationEvidence(args);
    assert.equal(result.failure, 'GEMINI_REVIEW_EMPTY_RESPONSE');
    assert.equal(result.settingsBytesUnchanged, false);
    assert.equal(result.effectivePermissionsVerified, false);
    assert.deepEqual(readFileSync(join(args.directory, 'stdout.log')), args.stdout);
    assert.deepEqual(readFileSync(join(args.directory, 'settings-before.json')), args.settingsBefore);
    assert.deepEqual(readFileSync(join(args.directory, 'settings-after.json')), args.settingsAfter);
    assert.equal(statSync(join(args.directory, 'stdout.log')).mode & 0o777, 0o600);
    assert.equal(statSync(args.directory).mode & 0o777, 0o700);
    assert.throws(() => saveQualificationEvidence(args), /EEXIST/);
    assert.throws(() => saveQualificationEvidence({ ...args, directory: join(root, 'missing'), settingsBefore: undefined }), /ORIGINALS_REQUIRED/);
    assert.deepEqual(readFileSync(join(args.directory, 'stdout.log')), args.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
