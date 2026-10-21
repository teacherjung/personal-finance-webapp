// @ts-check
// 結構對帳只確認旁錄完整性；十九項內容是否完成仍由發審者逐項核收。
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../lib/is-main.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = file => {
  assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), '核查來源不是普通檔');
  return readFileSync(file);
};

export function prepareNativeObserver(cli, tree, settings, model, sentinel) {
  const executable = realpathSync(cli), folder = dirname(tree), bundle = dirname(executable);
  const registration = JSON.parse(bytes(join(tree, 'settings.json')).toString()).reviewers.find(item => item.participant === 'Gemini');
  const pins = registration?.nativeSources;
  assert.ok(Array.isArray(pins) && pins.length === 5, '缺已核原生來源釘值');
  const names = ['gemini.js', 'gemini-Q2GRYIAK.js', 'chunk-FLKY6NH5.js', 'chunk-NR7L3FXV.js', 'chunk-DPNFVVVC.js'];
  assert.deepEqual(pins.map(item => item.file), names, '原生來源集合不同');
  const sources = pins.map(item => {
    const file = join(bundle, item.file);
    assert.equal(hash(bytes(file)), item.sha256, '原生來源已移動');
    return { file: item.file, sha256: item.sha256 };
  });
  assert.equal(executable, join(bundle, names[0]), '不是已核原生入口');
  const pkg = JSON.parse(bytes(join(bundle, '..', 'package.json')).toString());
  assert.equal(pkg.name, '@google/gemini-cli'); assert.equal(pkg.version, '0.64.0');
  for (let dir = tree; ; dir = dirname(dir)) {
    assert.equal(existsSync(join(dir, 'GEMINI.md')), false, '已有上下文檔；停止且不讀內容');
    if (dir === dirname(dir)) break;
  }
  assert.equal(existsSync(join(process.env.GEMINI_CLI_HOME || join(homedir(), '.gemini'), 'GEMINI.md')), false, '已有全域上下文檔；停止且不讀內容');
  const launchBytes = bytes(join(folder, 'launch.json'));
  const configBytes = bytes(join(tree, '.gemini/settings.json'));
  assert.deepEqual(JSON.parse(configBytes.toString()), settings);
  const observer = join(tree, 'scripts/gemini-runtime-observer.js'), observerSha256 = hash(bytes(observer));
  const binding = hash(JSON.stringify({ head: JSON.parse(launchBytes.toString()).head, launch: hash(launchBytes), settings: hash(configBytes), model, sentinel, sources, observerSha256 }));
  const eventsFile = join(folder, 'native-events.jsonl'), bootstrap = join(folder, 'native-observer.mjs');
  assert.equal(existsSync(eventsFile), false, '旁錄已存在');
  const text = `import { Config, LoggingContentGenerator, ChatRecordingService, ShellExecutionService } from ${JSON.stringify(pathToFileURL(join(bundle, names[3])).href)};\nimport { installObserver, eventWriter } from ${JSON.stringify(pathToFileURL(observer).href)};\nif (process.env.GEMINI_CLI_NO_RELAUNCH || process.env.SANDBOX) installObserver({ Config, LoggingContentGenerator, ChatRecordingService, ShellExecutionService }, ${JSON.stringify({ model, sentinel })}, eventWriter(${JSON.stringify(eventsFile)}, ${JSON.stringify(binding)}));\n`;
  writeFileSync(bootstrap, text, { flag: 'wx', mode: 0o600 });
  return { version: pkg.version, executable, bootstrap, bootstrapSha256: hash(text), observer, observerSha256, eventsFile, binding, sources };
}

export function verifyObserverSources(native) {
  for (const source of native.sources) assert.equal(hash(bytes(join(dirname(native.executable), source.file))), source.sha256, '原生來源在執行中變動');
  assert.equal(hash(bytes(native.bootstrap)), native.bootstrapSha256, '預載器在執行中變動');
  assert.equal(hash(bytes(native.observer)), native.observerSha256, '觀察器在執行中變動');
}

export function reconcileEvidence(text, stats, binding) {
  assert.ok(text.endsWith('\n'), '旁錄尾端不完整');
  const events = text.trimEnd().split('\n').map(line => JSON.parse(line));
  for (const [index, event] of events.entries()) {
    assert.equal(event.sequence, index + 1, '旁錄序列有缺口');
    assert.equal(event.binding, binding, '旁錄不屬本輪');
    assert.ok(['installed', 'config', 'request', 'tool', 'shell_start', 'shell_result', 'shell_error'].includes(event.type), '旁錄有拒收或未知事件');
  }
  assert.equal(events[0]?.type, 'installed', '旁錄沒有安裝收據');
  for (const stage of ['refreshAuth', 'initialize', 'request']) assert.ok(events.some(event => event.type === 'config' && event.stage === stage), '缺真 Config 邊界觀測');
  const requests = events.filter(event => event.type === 'request');
  const counts = new Map();
  for (const event of requests) {
    for (const stage of ['refreshAuth', 'initialize']) assert.ok(events.some(config => config.type === 'config' && config.stage === stage && config.configId === event.configId && config.pid === event.pid && config.sequence < event.sequence), '請求未綁同程序同一正式 Config');
    const key = `${event.model}/${event.role}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [model, row] of Object.entries(stats.models)) for (const [role, count] of Object.entries(row.roles)) {
    const key = `${model}/${role}`;
    assert.equal(counts.get(key) ?? 0, count.totalRequests, '請求旁錄與原生角色統計不同');
    counts.delete(key);
  }
  assert.equal(counts.size, 0, '有未歸屬的旁錄請求');
  const latest = new Map();
  for (const call of events.filter(event => event.type === 'tool')) {
    assert.ok(typeof call.id === 'string' && call.id && typeof call.name === 'string', '工具識別缺失');
    if (latest.has(call.id)) assert.equal(latest.get(call.id).name, call.name, '工具更新改名');
    latest.set(call.id, call);
  }
  const calls = [...latest.values()];
  assert.equal(calls.length, stats.tools?.totalCalls, '工具旁錄與原生計數不同');
  assert.equal(calls.filter(call => call.status === 'success').length, stats.tools.totalSuccess, '工具成功計數不同');
  assert.equal(calls.filter(call => call.status === 'error').length, stats.tools.totalFail, '工具失敗計數不同');
  assert.ok(calls.every(call => ['success', 'error'].includes(call.status)), '工具尚未終態');
  const toolNames = new Set([...calls.map(call => call.name), ...Object.keys(stats.tools.byName ?? {})]);
  for (const name of toolNames) {
    const rows = calls.filter(call => call.name === name), expected = stats.tools.byName?.[name];
    assert.equal(rows.length, expected?.count, '工具名稱計數不同');
    assert.equal(rows.filter(call => call.status === 'success').length, expected?.success, '工具名稱成功計數不同');
    assert.equal(rows.filter(call => call.status === 'error').length, expected?.fail, '工具名稱失敗計數不同');
  }
  const starts = events.filter(event => event.type === 'shell_start');
  const ends = events.filter(event => ['shell_result', 'shell_error'].includes(event.type));
  assert.equal(starts.length, ends.length, 'Shell 執行缺結束紀錄');
  assert.equal(new Set(starts.map(start => start.shellId)).size, starts.length, 'Shell 識別重複');
  for (const start of starts) assert.equal(ends.filter(end => end.shellId === start.shellId && end.sequence > start.sequence).length, 1, 'Shell 旁錄無法配對');
  return {
    status: 'pending-human-acceptance', eventsSha256: hash(text), requests: requests.length,
    requiredHumanChecks: ['拒絕揭露與回覆一致', '本機與雲端分別核對', '保護移除及指定斷言紅', '同情境還原後實跑綠', '必要邊界與十九項逐項核收'],
    tools: calls.length, toolErrors: calls.filter(call => call.status === 'error').map(call => ({ id: call.id, name: call.name, result: call.result })),
    shell: starts.map(start => ({ ...start, end: ends.find(end => end.shellId === start.shellId) })),
    limitations: '工具 success 不表示 Shell 退出零；Shell 與工具依命令、目錄及時序人工對照。還原、還原後重跑、CI、十九項及結論一致性由發審者核收，未核不能合併。',
  };
}

if (isMainModule(import.meta.url)) console.log('Gemini evidence：由 scripts/gemini-review.js 準備本輪來源及整理私有旁錄；內容仍待人工核收。驗證請跑 node --test test/gemini-review-evidence.test.js。');
