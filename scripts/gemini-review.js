#!/usr/bin/env node
// @ts-check
// 原生 CLI 的完整 response 才是送件本文；程序成功不代替正式結論與 F7。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { gitEnv } from '../lib/git-env.js';
import { isMainModule } from '../lib/is-main.js';
import { promptValues, publicReply } from './grok-review.js';

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

export function nativeCommand(command, args, cwd) {
  const env = gitEnv();
  // node:test 的父程序標誌會使子考題被當成遞迴呼叫而跳過。
  delete env.NODE_TEST_CONTEXT;
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
    tools: { core: ['list_directory', 'read_file', 'grep_search', 'glob', 'replace', 'write_file', 'run_shell_command'], allowed: [], discoveryCommand: '', callCommand: '', useRipgrep: false },
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

export function parseReply(raw, result, record, model) {
  requireThat(!result.error && result.status === 0 && !result.signal, '原生 Gemini 未正常完成');
  const json = JSON.parse(raw);
  requireThat(!json.error && typeof json.response === 'string' && json.response.trim(), '原生 JSON 缺完整 response');
  const models = Object.keys(json.stats?.models ?? {});
  requireThat(models.length === 1 && models[0] === model, '原生回報模型不符');
  const response = json.response;
  const prefix = `🤖 Gemini｜來源：Gemini CLI｜審 \`${record.head.slice(0, 7)}\`｜r${record.round}｜結論：`;
  const first = response.split(/\r?\n/u)[0];
  requireThat(['通過', '需修改後再審', '不可合併'].some(verdict => first === prefix + verdict), '完整回覆首行不是本輪正式標頭');
  for (const title of ['### 本輪實際用的設定', '### 清單逐項結果']) requireThat(response.split(/\r?\n/u).includes(title), '正式回覆缺固定小標');
  publicReply(response);
  return { response, models, tools: json.stats?.tools ?? null };
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
  const values = promptValues(read(join(reviewTree, 'templates/review-request.md')) + '\n', prompt);
  for (const [key, value] of Object.entries({ project, change: String(change), reviewer: 'Gemini', source: 'Gemini CLI', head: record.head, headShort: record.head.slice(0, 7), base: record.base, round: String(record.round), reviewTree, mutationCopy })) requireThat(values[key] === value, 'F3 提示與本輪正式紀錄不符');
  requireThat(values.implementer !== 'Gemini', '實作與複審角色不分離');
  for (const suffix of ['', '.stdout.json', '.stderr', '.receipt.json']) requireThat(!existsSync(outFile + suffix), '本輪輸出已存在');
  requireThat(!existsSync(join(reviewTree, '.gemini')), '審查樹已有 Gemini 配置，不能覆寫');
  return { record, settings, prompt, folder };
}

export function verifyNativeReceipt(receipt, expected) {
  for (const [key, value] of Object.entries(expected)) requireThat(receipt[key] === value, '原生 preflight 收據未綁定本輪資料');
  requireThat(receipt.version === '0.64.0' && receipt.thinkingLevelConfigured === 'HIGH' && receipt.mcpNoConfiguredMatch === true, '原生有效設定未確認');
  assert.deepEqual(receipt.tools, ['glob', 'list_directory', 'read_file', 'replace', 'run_shell_command', 'grep_search', 'write_file'].sort());
  requireThat(Array.isArray(receipt.bundles) && receipt.bundles.length === 2, '原生公開 bundle 收據不完整');
  return receipt;
}

// 每輪外置核查只讀原生公開設定 API；入口核其實際執行結果，不以手填聲明放行。
export async function nativePreflight(cli, tree, settings, model, sentinel) {
  const folder = dirname(tree);
  const script = join(folder, 'native-preflight.mjs');
  const scriptSha256 = hash(read(script));
  const registration = JSON.parse(read(join(tree, 'settings.json'))).reviewers.find(item => item.participant === 'Gemini');
  requireThat(registration?.preflightSha256 === scriptSha256, '外置 preflight 不是已核來源');
  const resultFile = join(folder, 'native-preflight.result.json');
  requireThat(!existsSync(resultFile), '本輪原生 preflight 結果已存在');
  const configFile = join(tree, '.gemini', 'settings.json');
  const launchFile = join(folder, 'launch.json');
  const record = JSON.parse(read(launchFile));
  assert.deepEqual(JSON.parse(read(configFile)), settings);
  const expected = { head: record.head, launchSha256: hash(read(launchFile)), settingsSha256: hash(read(configFile)), cliSha256: hash(read(realpathSync(cli))), model, sentinel };
  const r = nativeCommand(process.execPath, [script, tree, realpathSync(cli), model, sentinel], tree);
  save(join(folder, 'native-preflight.stdout.json'), r.stdout ?? '');
  save(join(folder, 'native-preflight.stderr'), r.stderr ?? '');
  requireThat(!r.error && r.status === 0 && !r.signal, '本輪原生 preflight 執行失敗');
  const receipt = verifyNativeReceipt(JSON.parse(read(resultFile)), expected);
  const bundleDir = dirname(realpathSync(cli));
  for (const item of receipt.bundles) {
    requireThat(dirname(realpathSync(item.path)) === bundleDir && /^chunk-[A-Za-z0-9]+\.js$/u.test(item.path.split('/').at(-1)), '原生 bundle 來源不在已核 CLI');
    requireThat(hash(read(item.path)) === item.sha256, '原生 bundle 已移動');
  }
  requireThat(hash(read(script)) === scriptSha256, '本輪外置 preflight 來源有變動');
  return { ...receipt, scriptSha256 };
}

export async function runReview(args, { git = reviewGit, invoke = nativeCommand, preflight = nativePreflight, cli = undefined } = {}) {
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
  let result, received, native, failure;
  const commandArgs = ['--skip-trust', '--approval-mode', 'default', '--model', model, '-e', 'none', '--allowed-mcp-server-names', sentinel, '--include-directories', mutationCopy, '--policy', policyFile, '--output-format', 'json', '-p', p.prompt];
  try {
    save(configFile, settingsText); save(policyFile, policyText);
    native = await preflight(executable, reviewTree, p.settings, model, sentinel);
    result = invoke(executable, commandArgs, reviewTree);
    save(outFile + '.stdout.json', result.stdout ?? ''); save(outFile + '.stderr', result.stderr ?? '');
    requireUnchanged(before, sourceSnapshot(reviewTree, git));
    requireUnchanged(settingsText, read(configFile)); requireUnchanged(policyText, read(policyFile));
    received = parseReply(result.stdout, result, p.record, model);
  } catch (error) { failure = error; }
  finally {
    // 只收掉本輪建立且仍相同的普通檔；未知產物交回操作者，不遞迴刪目錄。
    try {
      requireUnchanged(before, sourceSnapshot(reviewTree, git));
      requireUnchanged(settingsText, read(configFile));
      unlinkSync(configFile); rmdirSync(runtime);
      requireThat(git(reviewTree, ['status', '--porcelain', '--untracked-files=all']) === '', '審查樹有未知產物');
    } catch (error) { failure ??= error; }
    save(outFile + '.receipt.json', JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), record: p.record, cli: executable, args: commandArgs, native, status: result?.status ?? null, signal: result?.signal ?? null, error: result?.error?.message ?? null, failure: failure?.message ?? null, sourceBefore: before, preparedRuntime: [{ path: configFile, sha256: hash(settingsText) }], policySha256: hash(policyText), promptSha256: hash(p.prompt), responseSha256: received ? hash(received.response) : null, observedModels: received?.models ?? [], toolStats: received?.tools ?? null, promptOnly: '審查樹唯讀與突變目的地靠提示及前後核對；不是 OS 隔離，也不能證明中途未改回。' }, null, 2) + '\n');
  }
  if (failure) throw failure;
  if (!received) throw new Error(`未收到完整正式回覆；${HELP}`);
  save(outFile, received.response);
  return { output: outFile, receipt: outFile + '.receipt.json' };
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
