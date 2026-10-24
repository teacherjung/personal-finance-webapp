import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareNativeObserver, reconcileEvidence, verifyObserverSources } from '../scripts/gemini-review-evidence.js';

const model = 'gemini-3.1-pro-preview';
const retry = '核 scripts/gemini-review-evidence.js 後跑 node --test test/gemini-review-evidence.test.js';
test('靜態來源核查綁真入口、設定與預載器，漂移不放行且不執行 CLI', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-source-case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = join(dir, 'bundle'), tree = join(dir, 'tree');
  for (const path of [bundle, tree, join(tree, '.gemini'), join(tree, 'scripts')]) mkdirSync(path);
  const names = ['gemini.js', 'gemini-Q2GRYIAK.js', 'chunk-FLKY6NH5.js', 'chunk-NR7L3FXV.js', 'chunk-DPNFVVVC.js'];
  const pins = names.map(file => {
    const data = `throw new Error('synthetic source must not execute: ${file}');\n`;
    writeFileSync(join(bundle, file), data);
    return { file, sha256: createHash('sha256').update(data).digest('hex') };
  });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', version: '0.64.0' }));
  writeFileSync(join(dir, 'launch.json'), JSON.stringify({ reviewer: 'Gemini', head: 'a'.repeat(40), base: 'b'.repeat(40) }));
  writeFileSync(join(tree, 'settings.json'), JSON.stringify({ reviewers: [{ participant: 'Gemini', nativeSources: pins }] }));
  writeFileSync(join(dir, 'prompt.md'), 'synthetic prompt');
  writeFileSync(join(tree, '.gemini/settings.json'), '{}');
  writeFileSync(join(tree, 'scripts/gemini-runtime-observer.js'), 'export const synthetic = true;\n');
  const cli = join(bundle, 'gemini.js');
  const native = prepareNativeObserver(cli, tree, {}, model, 'none');
  verifyObserverSources(native);
  const bootstrap = readFileSync(native.bootstrap, 'utf8');
  assert.match(bootstrap, /GEMINI_CLI_NO_RELAUNCH/u, retry);
  assert.match(bootstrap, /installObserver/u, retry);
  assert.doesNotMatch(bootstrap, /setTrusted|new Config/u, retry);
  for (const file of [cli, native.bootstrap, native.observer]) {
    const before = readFileSync(file);
    writeFileSync(file, 'changed');
    assert.throws(() => verifyObserverSources(native), /變動/u, retry);
    writeFileSync(file, before);
    verifyObserverSources(native);
  }
  writeFileSync(cli, 'moved');
  assert.throws(() => prepareNativeObserver(cli, tree, {}, model, 'none'), /已移動/u, retry);
});
function fixture() {
  const events = [{ type: 'installed' }, ...['refreshAuth', 'initialize', 'request'].map(stage => ({ type: 'config', stage, configId: 1 })), { type: 'request', model, role: 'main', configId: 1 }];
  events.push({ type: 'shell_start', shellId: 1, command: { text: 'npm test' }, cwd: '/synthetic' }, { type: 'shell_result', shellId: 1, exitCode: 0, output: { text: 'tests 5552; pass 5545; fail 0; skipped 7' } });
  events.push({ type: 'tool', id: 'baseline', name: 'run_shell_command', status: 'success' });
  for (let i = 0; i < 6; i++) events.push({ type: 'tool', id: `denied-${i}`, name: 'run_shell_command', status: 'error', result: { text: 'Tool execution denied by policy.' } });
  events.push({ type: 'tool', id: 'restore', name: 'replace', status: 'success' });
  const stats = { models: { [model]: { roles: { main: { totalRequests: 1, totalErrors: 0 } } } }, tools: { totalCalls: 8, totalSuccess: 2, totalFail: 6, byName: { run_shell_command: { count: 7, success: 1, fail: 6 }, replace: { count: 1, success: 1, fail: 0 } } } };
  const text = () => events.map((event, i) => JSON.stringify({ sequence: i + 1, binding: 'round', purpose: 'review', pid: 123, ...event })).join('\n') + '\n';
  return { events, stats, text };
}

test('保留完整基線綠與六拒絕；還原不冒充還原綠，沒有 CI 仍待核收', () => {
  const f = fixture(), evidence = reconcileEvidence(f.text(), f.stats, 'round');
  assert.equal(evidence.toolErrors.length, 6, retry);
  assert.equal(evidence.shell[0].end.exitCode, 0, retry);
  assert.match(evidence.shell[0].end.output.text, /fail 0/u, retry);
  assert.equal(evidence.shell.length, 1, retry);
  assert.equal(evidence.status, 'pending-human-acceptance', retry);
  assert.ok(evidence.requiredHumanChecks.includes('同情境還原後實跑綠'), retry);
  assert.ok(evidence.requiredHumanChecks.includes('本機與雲端分別核對'), retry);
  assert.equal(Object.hasOwn(evidence, 'restoredGreen'), false);
  assert.equal(Object.hasOwn(evidence, 'ciPassed'), false);
});

test('同工具 id 的進度更新只算一次，原順序仍留在事件原件', () => {
  const f = fixture();
  f.events.splice(7, 0, { type: 'tool', id: 'baseline', name: 'run_shell_command', status: 'executing' });
  const evidence = reconcileEvidence(f.text(), f.stats, 'round');
  assert.equal(evidence.tools, 8, retry);
  assert.equal(f.events.filter(e => e.type === 'tool' && e.id === 'baseline').length, 2);
});

test('缺旁錄、錯本輪、錯 Config、壞計數與未終態不產生核收結果', () => {
  const cases = [
    f => { f.events.shift(); },
    f => { f.events[0].sequence = 2; },
    f => { f.events[0].binding = 'other'; },
    f => { f.events[4].configId = 2; },
    f => { f.events[4].pid = 456; },
    f => { f.events[1].stage = 'request'; },
    f => { f.events[4].model = 'other'; },
    f => { f.stats.tools.totalFail = 0; },
    f => { f.stats.tools.byName.run_shell_command.count = 99; },
    f => { f.events.splice(6, 1); },
    f => { f.events[6].shellId = 2; },
    f => { f.events.push({ type: 'guard_failure' }); },
  ];
  for (const mutate of cases) {
    const f = fixture(); mutate(f);
    assert.throws(() => reconcileEvidence(f.text(), f.stats, 'round'), undefined, retry);
  }
  const f = fixture();
  assert.throws(() => reconcileEvidence(f.text().trimEnd(), f.stats, 'round'), /尾端/u, retry);
});

test('Shell 紅、signal、abort 與未知退出不被工具 success 洗成綠', () => {
  for (const fields of [{ exitCode: 1 }, { exitCode: null, signal: 15 }, { exitCode: null, aborted: true }, { exitCode: null }, { type: 'shell_error', message: { text: 'rejected' } }]) {
    const f = fixture(); Object.assign(f.events[6], fields);
    const evidence = reconcileEvidence(f.text(), f.stats, 'round');
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(evidence.shell[0].end[key], value, retry);
    assert.equal(evidence.status, 'pending-human-acceptance', retry);
  }
});


function scanFixture() {
  const f = fixture();
  f.events.splice(5);
  f.events[4].tools = ['glob', 'grep_search', 'list_directory', 'read_file'];
  f.events.push({ type: 'tool', id: 'read-only', name: 'read_file', status: 'error', result: { text: 'synthetic missing source' } });
  f.stats.tools = { totalCalls: 1, totalSuccess: 0, totalFail: 1, byName: { read_file: { count: 1, success: 0, fail: 1 } } };
  f.text = () => f.events.map((event, i) => JSON.stringify({ sequence: i + 1, binding: 'round', purpose: 'scan', pid: 123, ...event })).join('\n') + '\n';
  return f;
}

test('scan 證據有獨立人工核對項，工具錯誤保留而非正式放行', () => {
  const f = scanFixture(), e = reconcileEvidence(f.text(), f.stats, 'round', 'scan');
  assert.equal(e.purpose, 'scan'); assert.equal(e.status, 'pending-human-acceptance');
  assert.equal(e.toolErrors[0].result.text, 'synthetic missing source');
  assert.deepEqual(e.shell, []);
  assert.ok(e.requiredHumanChecks.some(x => x.includes('發現逐項核實')), retry);
  assert.ok(!e.requiredHumanChecks.some(x => /十九|還原/u.test(x)), retry);
  assert.throws(() => reconcileEvidence(f.text(), f.stats, 'round'), /用途/u, retry);
  const review = fixture();
  assert.throws(() => reconcileEvidence(review.text(), review.stats, 'round', 'scan'), /用途/u, retry);
  for (const purpose of [null, '', 'toString']) assert.throws(() => reconcileEvidence(f.text(), f.stats, 'round', purpose), /用途/u, retry);
});

test('scan 錯用途、額外工具與 Shell 事件不產生核收證據', () => {
  for (const mode of ['purpose', 'missing-purpose', 'registry', 'tool', 'shell']) {
    const f = scanFixture();
    if (mode === 'purpose') f.events[0].purpose = 'review';
    if (mode === 'missing-purpose') f.events[0].purpose = undefined;
    if (mode === 'registry') f.events[4].tools.push('write_file');
    if (mode === 'tool') { f.events[5].name = 'write_file'; f.stats.tools.byName = { write_file: { count: 1, success: 0, fail: 1 } }; }
    if (mode === 'shell') f.events.push({ type: 'shell_start', shellId: 1 }, { type: 'shell_result', shellId: 1, exitCode: 0 });
    assert.throws(() => reconcileEvidence(f.text(), f.stats, 'round', 'scan'), undefined, mode + '；' + retry);
  }
});
