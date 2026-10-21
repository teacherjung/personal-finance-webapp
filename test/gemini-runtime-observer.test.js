import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installObserver, configObservation, REVIEW_TOOLS, boundedText, eventWriter } from '../scripts/gemini-runtime-observer.js';

const model = 'gemini-3.1-pro-preview', expected = { model, sentinel: 'synthetic-none' };
const retry = '核 scripts/gemini-runtime-observer.js 後跑 node --test test/gemini-runtime-observer.test.js';
function setup(t) {
  const calls = [], events = [];
  class Config {
    refreshAuth(...args) { calls.push({ method: 'auth', self: this, args }); return this; }
    initialize(...args) { calls.push({ method: 'init', self: this, args }); return this; }
    getModel() { return model; }
    getModelConfigService() { return { getResolvedConfig: () => ({ generateContentConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } }) }; }
    isTrustedFolder() { return true; }
    getCoreTools() { return [...REVIEW_TOOLS]; }
    getAllowedMcpServers() { return [expected.sentinel]; }
    getMcpServers() { return {}; }
    getToolDiscoveryCommand() { return ''; }
    getToolCallCommand() { return ''; }
    getMcpServerCommand() { return undefined; }
    getExtensions() { return []; }
    getApprovalMode() { return 'default'; }
    getEnableExtensionReloading() { return false; }
    getEnableHooks() { return false; }
    isAgentsEnabled() { return false; }
    isSkillsSupportEnabled() { return false; }
    isAutoMemoryEnabled() { return false; }
    getIncludeDirectoryTree() { return false; }
    shouldLoadMemoryFromIncludeDirectories() { return false; }
    getOutputFormat() { return 'json'; }
    getTruncateToolOutputThreshold() { return 12000; }
    getToolRegistry() { return { getAllToolNames: () => [...REVIEW_TOOLS] }; }
  }
  class LoggingContentGenerator {
    constructor(config) { this.config = config; }
    generateContent(...args) { calls.push({ method: 'request', self: this, args }); return args[0]; }
    generateContentStream(...args) { calls.push({ method: 'stream', self: this, args }); return args[0]; }
  }
  class ChatRecordingService {
    recordToolCalls(...args) { calls.push({ method: 'tools', self: this, args }); return args; }
  }
  class ShellExecutionService {
    static async execute(...args) { calls.push({ method: 'shell', self: this, args }); return this.started; }
  }
  const api = { Config, LoggingContentGenerator, ChatRecordingService, ShellExecutionService };
  t.after(installObserver(api, expected, (type, fields) => events.push({ type, ...fields })));
  return { ...api, calls, events, config: new Config() };
}
const request = () => ({ model, config: { thinkingConfig: { thinkingLevel: 'HIGH' } } });

test('真物件階段與主請求固定設定原樣委派；不取模型內容', t => {
  const f = setup(t), c = f.config, auth = { synthetic: true };
  assert.equal(c.refreshAuth(auth), c); assert.equal(c.initialize(), c);
  const generator = new f.LoggingContentGenerator(c), req = request();
  Object.defineProperty(req, 'contents', { get() { throw Error('不准讀 contents'); } });
  Object.defineProperty(req.config, 'systemInstruction', { get() { throw Error('不准讀 systemInstruction'); } });
  for (const method of ['generateContent', 'generateContentStream']) assert.equal(generator[method](req, 'test', 'main'), req, retry);
  assert.equal(f.calls[0].self, c); assert.equal(f.calls[0].args[0], auth);
  assert.equal(f.events.filter(e => e.type === 'request').length, 2, retry);
  assert.ok(f.events.filter(e => e.type === 'config').every(e => e.configId === 1));
  const aux = { model: 'gemini-3-flash-preview' };
  assert.equal(generator.generateContent(aux, 'aux', 'utility_loop_detector'), aux);
});

test('設定拒絕後即使 CLI 捕捉錯誤也不能再送主請求', t => {
  for (const [method, value] of [['isTrustedFolder', false], ['getModel', 'other'], ['getCoreTools', []], ['getEnableHooks', true], ['getTruncateToolOutputThreshold', 40000], ['getApprovalMode', 'yolo']]) {
    const f = setup(t), c = f.config, original = c[method];
    c[method] = () => value;
    assert.throws(() => c.refreshAuth(), undefined, retry);
    c[method] = original;
    assert.throws(() => c.initialize(), undefined, retry);
    assert.throws(() => new f.LoggingContentGenerator(c).generateContent(request(), 'retry', 'main'), undefined, retry);
    assert.equal(f.calls.length, 0, retry);
  }
});

test('錯 HIGH、模型、角色與錯綁 Config 都在 provider 前拒絕', t => {
  for (const mode of ['low', 'missing', 'model', 'role', 'other-config', 'registry']) {
    const f = setup(t), c = f.config;
    c.refreshAuth(); c.initialize(); f.calls.length = 0;
    const req = request();
    if (mode === 'low') req.config.thinkingConfig.thinkingLevel = 'LOW';
    if (mode === 'missing') delete req.config.thinkingConfig;
    if (mode === 'model') req.model = 'other';
    if (mode === 'registry') c.getToolRegistry = () => ({ getAllToolNames: () => [] });
    const generator = new f.LoggingContentGenerator(mode === 'other-config' ? new f.Config() : c);
    assert.throws(() => generator.generateContent(req, 'p', mode === 'role' ? 'unknown' : 'main'), undefined, mode + '；' + retry);
    assert.equal(f.calls.length, 0, mode + '；' + retry);
  }
  const f = setup(t);
  f.config.getModelConfigService = () => ({ getResolvedConfig: () => ({ generateContentConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } }) });
  assert.throws(() => configObservation(f.config, expected), /推理/u, retry);
});

test('工具更新及拒絕原樣旁錄，不讀 recorder thoughts', t => {
  const f = setup(t), recorder = new f.ChatRecordingService();
  Object.defineProperty(recorder, 'queuedThoughts', { get() { throw Error('不准讀 thoughts'); } });
  const first = [{ id: 't', name: 'run_shell_command', args: { command: 'node test' }, result: [], status: 'executing' }];
  const last = [{ ...first[0], result: [{ functionResponse: { response: { error: 'Tool execution denied by policy.' } } }], status: 'error' }];
  recorder.recordToolCalls(model, first); recorder.recordToolCalls(model, last);
  assert.equal(f.calls[0].args[1], first); assert.equal(f.calls[1].args[1], last);
  assert.deepEqual(f.events.filter(e => e.type === 'tool').map(e => e.status), ['executing', 'error'], retry);
  assert.match(f.events.at(-1).result.text, /denied by policy/u, retry);
});

test('Shell 真退出、signal、abort 與拒絕保存，原物件及 promise 不替換', async t => {
  const f = setup(t), shell = f.ShellExecutionService;
  for (const value of [{ exitCode: 0 }, { exitCode: 1 }, { signal: 15, exitCode: null }, { aborted: true, exitCode: null }]) {
    const output = { ...value, output: '合成測試摘要' };
    shell.started = { pid: 42, result: Promise.resolve(output) };
    const got = await shell.execute('node synthetic', '/synthetic', () => {}, null, false, {});
    assert.equal(got, shell.started); assert.equal(got.result, shell.started.result);
    assert.equal(await got.result, output);
    const event = f.events.at(-1);
    assert.equal(event.exitCode, value.exitCode ?? null, retry);
    assert.equal(event.signal, value.signal ?? null, retry);
    assert.equal(event.aborted, value.aborted ?? null, retry);
    assert.equal(event.output.text, output.output, retry);
  }
  const error = new Error('synthetic rejection');
  shell.started = { result: Promise.reject(error) };
  const got = await shell.execute('node reject', '/synthetic');
  await assert.rejects(got.result, err => err === error);
  assert.equal(f.events.at(-1).type, 'shell_error', retry);
});

test('有界普通檔保留順序與綁定，寫入失敗不默默放過', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-observer-case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl'), emit = eventWriter(file, 'binding', 300);
  emit('installed'); emit('tool', { id: 't' });
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(e => e.sequence), [1, 2]); assert.ok(rows.every(e => e.binding === 'binding'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => emit('large', { text: 'x'.repeat(400) }), /容量/u, retry);
  assert.throws(() => eventWriter(file, 'other'), /EEXIST/u, retry);
  const value = '合成'.repeat(500) + '尾摘要';
  const bounded = boundedText(value, 60);
  assert.equal(bounded.truncated, true); assert.match(bounded.text, /尾摘要$/u);
  assert.equal(bounded.bytes, Buffer.byteLength(value));
});
