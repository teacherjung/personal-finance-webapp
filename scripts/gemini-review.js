#!/usr/bin/env node
// @ts-check
// 原生 CLI 的完整 response 才是送件本文；程序成功不代替正式結論與 F7。
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { gitEnv } from '../lib/git-env.js';
import { isMainModule } from '../lib/is-main.js';
import { promptValues, publicReply } from './grok-review.js';
import { TOOL_OUTPUT_CHARS } from './gemini-runtime-observer.js';
import { prepareNativeObserver, reconcileEvidence, verifyObserverSources } from './gemini-review-evidence.js';

const MODEL = 'gemini-3.1-pro-preview';
const HELP = 'scripts/gemini-review.js：核對 launch.json 與本輪設定後，重跑 node scripts/gemini-review.js --model <model> --effort <effort> --review-tree <tree> --mutation-copy <mutation> --prompt-file <prompt> --out-file <output> --change <PR> --project <repo>';
const hash = value => createHash('sha256').update(value).digest('hex');
const requireThat = (ok, why) => { if (!ok) throw new Error(`${why}；${HELP}`); };
const readBytes = file => {
  requireThat(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), '來源不是普通檔案');
  return readFileSync(file);
};
const read = file => readBytes(file).toString('utf8');
const save = (file, text) => writeFileSync(file, text, { flag: 'wx', mode: 0o600 });

export function nativeCommand(command, args, cwd, trusted = false) {
  const env = gitEnv();
  // node:test 的父程序標誌會使子考題被當成遞迴呼叫而跳過。
  delete env.NODE_TEST_CONTEXT;
  if (trusted) env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function reviewGit(cwd, args) {
  const r = nativeCommand('git', ['--no-replace-objects', ...args], cwd);
  requireThat(!r.error && r.status === 0 && !r.signal, 'Git 版本核對失敗');
  return r.stdout.trimEnd();
}

export function nativeSettings(model, effort) {
  requireThat(model === MODEL && effort === 'HIGH', '模型或推理不在本輪登記');
  return {
    tools: { core: ['list_directory', 'read_file', 'grep_search', 'glob', 'replace', 'write_file', 'run_shell_command'], allowed: [], discoveryCommand: '', callCommand: '', useRipgrep: false, truncateToolOutputThreshold: TOOL_OUTPUT_CHARS },
    skills: { enabled: false }, hooksConfig: { enabled: false },
    experimental: { enableAgents: false, autoMemory: false, extensionReloading: false, extensionConfig: false },
    context: { fileName: 'GEMINI.md', includeDirectoryTree: false, loadMemoryFromIncludeDirectories: false, includeDirectories: [], memoryBoundaryMarkers: [] },
    general: { checkpointing: { enabled: false } }, ide: { enabled: false },
    telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false },
    modelConfigs: { overrides: [{ match: { model }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: effort } } } }] },
  };
}

export function nativePolicy() {
  // Shell 能執行考題也能執行考題內的任意程式；此放行表不是 OS 隔離。
  return `[[rule]]
toolName = ["list_directory", "read_file", "grep_search", "glob", "replace", "write_file"]
decision = "allow"
priority = 100

[[rule]]
toolName = "run_shell_command"
commandPrefix = ["node", "npm", "git", "rg", "cat", "sed", "pwd", "ls", "wc", "head", "tail", "gh pr view", "gh pr diff", "gh pr checks"]
decision = "allow"
priority = 100
allowRedirection = true
`;
}

export function sourceSnapshot(tree, git = reviewGit) {
  const files = git(tree, ['ls-files', '-z']).split('\0').filter(Boolean);
  requireThat(files.length > 0, '受審來源清單為空');
  return { head: git(tree, ['rev-parse', 'HEAD']), files: files.map(file => [file, hash(readBytes(join(tree, file)))]) };
}

export function requireUnchanged(before, after) {
  requireThat(JSON.stringify(before) === JSON.stringify(after), '受審來源或 runtime 設定有未授權變動');
}

// 原生循環偵測也會記入 models；資格須按角色判斷，不能把整個集合當主審。
function modelObservation(models, model) {
  const ordinary = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const counts = value => {
    requireThat(ordinary(value), '原生模型計數形狀不符');
    for (const key of ['totalRequests', 'totalErrors']) requireThat(Object.hasOwn(value, key)
      && Number.isSafeInteger(value[key]) && value[key] >= 0, '原生模型計數不符');
    requireThat(value.totalErrors <= value.totalRequests, '原生模型錯誤計數超過請求');
    return value;
  };
  requireThat(model === MODEL && ordinary(models) && Object.keys(models).length > 0, '原生回報模型不符');
  let successfulMain = false;
  const auxiliaryRoles = [];
  for (const [name, row] of Object.entries(models)) {
    requireThat(name === model || name === 'gemini-3-flash-preview', '原生回報模型不符');
    requireThat(ordinary(row) && Object.hasOwn(row, 'api') && Object.hasOwn(row, 'roles')
      && ordinary(row.roles) && Object.keys(row.roles).length > 0, '原生模型缺可用角色');
    const api = counts(row.api);
    let requests = 0, errors = 0;
    for (const [role, value] of Object.entries(row.roles)) {
      requireThat(role === 'main' || role === 'utility_loop_detector', '原生模型角色未核實');
      const count = counts(value);
      if (role === 'main') {
        requireThat(name === model, '原生主審模型不符');
        successfulMain ||= name === model && count.totalRequests > count.totalErrors;
      } else auxiliaryRoles.push({ model: name, role, totalRequests: count.totalRequests, totalErrors: count.totalErrors });
      requests += count.totalRequests; errors += count.totalErrors;
    }
    requireThat(Number.isSafeInteger(requests) && Number.isSafeInteger(errors)
      && requests === api.totalRequests && errors === api.totalErrors, '原生模型請求或錯誤未完整歸屬角色');
  }
  requireThat(successfulMain, '原生模型沒有成功 main 角色請求');
  return { mainModel: model, auxiliaryRoles };
}

export function parseReply(raw, result, record, model) {
  requireThat(!result.error && result.status === 0 && !result.signal, '原生 Gemini 未正常完成');
  const json = JSON.parse(raw);
  requireThat(!json.error && typeof json.response === 'string' && json.response.trim(), '原生 JSON 缺完整 response');
  const observation = modelObservation(json.stats?.models, model);
  const models = Object.keys(json.stats.models);
  const response = json.response;
  const prefix = `🤖 Gemini｜來源：Gemini CLI｜審 \`${record.head.slice(0, 7)}\`｜r${record.round}｜結論：`;
  const first = response.split(/\r?\n/u)[0];
  requireThat(['通過', '需修改後再審', '不可合併'].some(verdict => first === prefix + verdict), '完整回覆首行不是本輪正式標頭');
  for (const title of ['### 本輪實際用的設定', '### 清單逐項結果']) requireThat(response.split(/\r?\n/u).includes(title), '正式回覆缺固定小標');
  publicReply(response);
  return { response, models, ...observation, tools: json.stats?.tools ?? null };
}

export function prepare(args, git = reviewGit) {
  const { model, effort, reviewTree, mutationCopy, promptFile, outFile, change, project } = args;
  const settings = nativeSettings(model, effort);
  const folder = realpathSync(dirname(resolve(promptFile)));
  const record = JSON.parse(read(join(folder, 'launch.json')));
  requireThat(record.reviewer === 'Gemini' && String(record.change) === String(change) && /^[a-f0-9]{40}$/u.test(record.head) && /^[a-f0-9]{40}$/u.test(record.base) && Number.isSafeInteger(record.round) && record.round > 0, '正式紀錄身分或版本不符');
  for (const [key, value] of Object.entries({ tree: reviewTree, mutation: mutationCopy, promptFile, outFile })) requireThat(resolve(record[key]) === resolve(value), '正式紀錄路徑不符');
  requireThat(realpathSync(reviewTree) === join(folder, 'tree') && realpathSync(mutationCopy) === join(folder, 'mutation') && resolve(promptFile) === join(folder, 'prompt.md') && resolve(outFile) === join(folder, 'output.log'), '不是官方本輪路徑');
  for (const tree of [reviewTree, mutationCopy]) {
    requireThat(git(tree, ['rev-parse', 'HEAD']) === record.head && git(tree, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD', '審查副本未固定本輪版本');
    requireThat(git(tree, ['status', '--porcelain', '--untracked-files=all']) === '', '審查副本不乾淨');
  }
  const registration = JSON.parse(read(join(reviewTree, 'settings.json')));
  const reviewer = registration.reviewers.find(item => item.participant === 'Gemini');
  requireThat(registration.platform.project === project && reviewer?.strongest === model && reviewer?.maxEffort === effort && reviewer?.source === 'Gemini CLI', '受審設定未登記本次模型與來源');
  const prompt = read(promptFile);
  const values = promptValues(read(join(reviewTree, 'templates/review-request.md')), prompt);
  for (const [key, value] of Object.entries({ project, change: String(change), reviewer: 'Gemini', source: 'Gemini CLI', head: record.head, headShort: record.head.slice(0, 7), base: record.base, round: String(record.round), reviewTree, mutationCopy })) requireThat(values[key] === value, 'F3 提示與本輪正式紀錄不符');
  requireThat(values.implementer !== 'Gemini', '實作與複審角色不分離');
  for (const suffix of ['', '.stdout.json', '.stderr', '.receipt.json', '.evidence.json']) requireThat(!existsSync(outFile + suffix), '本輪輸出已存在');
  requireThat(!existsSync(join(reviewTree, '.gemini')), '審查樹已有 Gemini 配置，不能覆寫');
  return { record, settings, prompt, folder };
}

export async function runReview(args, { git = reviewGit, invoke = nativeCommand, preflight = prepareNativeObserver, cli = undefined } = {}) {
  const p = prepare(args, git);
  const { reviewTree, mutationCopy, outFile, model } = args;
  const executable = cli ?? (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'gemini')).find(file => existsSync(file));
  requireThat(executable, '找不到原生 Gemini CLI');
  const before = sourceSnapshot(reviewTree, git);
  const runtime = join(reviewTree, '.gemini');
  mkdirSync(runtime, { mode: 0o700 });
  const configFile = join(runtime, 'settings.json');
  const policyFile = join(p.folder, 'gemini-policy.toml');
  const settingsText = JSON.stringify(p.settings, null, 2) + '\n';
  const policyText = nativePolicy();
  const sentinel = 'finance-no-server-' + randomUUID();
  const startedAt = new Date().toISOString();
  let result, received, native, evidence, failure;
  const commandArgs = ['--skip-trust', '--approval-mode', 'default', '--model', model, '-e', 'none', '--allowed-mcp-server-names', sentinel, '--include-directories', mutationCopy, '--policy', policyFile, '--output-format', 'json', '-p', p.prompt];
  try {
    save(configFile, settingsText); save(policyFile, policyText);
    native = await preflight(executable, reviewTree, p.settings, model, sentinel);
    result = invoke(process.execPath, ['--import', native.bootstrap, native.executable, ...commandArgs], reviewTree, true);
    save(outFile + '.stdout.json', result.stdout ?? ''); save(outFile + '.stderr', result.stderr ?? '');
    requireUnchanged(before, sourceSnapshot(reviewTree, git));
    requireUnchanged(settingsText, read(configFile)); requireUnchanged(policyText, read(policyFile));
    received = parseReply(result.stdout, result, p.record, model);
    verifyObserverSources(native);
    evidence = reconcileEvidence(read(native.eventsFile), JSON.parse(result.stdout).stats, native.binding);
    save(outFile + '.evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  } catch (error) { failure = error; }
  finally {
    // 只收掉本輪建立且仍相同的普通檔；未知產物交回操作者，不遞迴刪目錄。
    try {
      requireUnchanged(before, sourceSnapshot(reviewTree, git));
      requireUnchanged(settingsText, read(configFile));
      unlinkSync(configFile); rmdirSync(runtime);
      requireThat(git(reviewTree, ['status', '--porcelain', '--untracked-files=all']) === '', '審查樹有未知產物');
    } catch (error) { failure ??= error; }
    save(outFile + '.receipt.json', JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), record: p.record, contentAcceptance: 'pending-human-acceptance', evidenceSha256: evidence ? hash(JSON.stringify(evidence, null, 2) + '\n') : null, cli: executable, args: commandArgs, native, status: result?.status ?? null, signal: result?.signal ?? null, error: result?.error?.message ?? null, failure: failure?.message ?? null, sourceBefore: before, preparedRuntime: [{ path: configFile, sha256: hash(settingsText) }], policySha256: hash(policyText), promptSha256: hash(p.prompt), responseSha256: received ? hash(received.response) : null, observedModels: received?.models ?? [], mainModel: received?.mainModel ?? null, auxiliaryRoles: received?.auxiliaryRoles ?? [], toolStats: received?.tools ?? null, promptOnly: '審查樹唯讀與突變目的地靠提示及前後核對；不是 OS 隔離，也不能證明中途未改回。' }, null, 2) + '\n');
  }
  if (failure) throw failure;
  if (!received) throw new Error(`未收到完整正式回覆；${HELP}`);
  save(outFile, received.response);
  return { output: outFile, receipt: outFile + '.receipt.json', contentAcceptance: 'pending-human-acceptance' };
}

export function parseArgs(argv) {
  const flags = { '--model': 'model', '--effort': 'effort', '--review-tree': 'reviewTree', '--mutation-copy': 'mutationCopy', '--prompt-file': 'promptFile', '--out-file': 'outFile', '--change': 'change', '--project': 'project' };
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    requireThat(key && argv[i + 1] && !argv[i + 1].startsWith('--') && !Object.hasOwn(args, key), '缺少或重複啟動參數');
    args[key] = argv[i + 1];
  }
  requireThat(Object.keys(args).length === Object.keys(flags).length, '缺少啟動參數');
  return args;
}

if (isMainModule(import.meta.url)) {
  try { console.log(JSON.stringify(await runReview(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
