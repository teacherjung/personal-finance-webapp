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
import { TOOL_OUTPUT_CHARS, nativePurpose, SCAN_TOOLS } from './gemini-runtime-observer.js';
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

export function nativeCommand(command, args, cwd, trusted = false, input = undefined) {
  const env = gitEnv();
  // node:test 的父程序標誌會使子考題被當成遞迴呼叫而跳過。
  delete env.NODE_TEST_CONTEXT;
  if (trusted) env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  return spawnSync(command, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function reviewGit(cwd, args) {
  const r = nativeCommand('git', ['--no-replace-objects', ...args], cwd);
  requireThat(!r.error && r.status === 0 && !r.signal, 'Git 版本核對失敗');
  return r.stdout.trimEnd();
}

export function nativeSettings(model, effort, purpose = 'review') {
  nativePurpose(purpose);
  requireThat(model === MODEL && effort === 'HIGH', '模型或推理不在本輪登記');
  return {
    tools: { core: purpose === 'scan' ? [...SCAN_TOOLS] : ['list_directory', 'read_file', 'grep_search', 'glob', 'replace', 'write_file', 'run_shell_command'], allowed: [], discoveryCommand: '', callCommand: '', useRipgrep: false, truncateToolOutputThreshold: TOOL_OUTPUT_CHARS },
    skills: { enabled: false }, hooksConfig: { enabled: false },
    experimental: { enableAgents: false, autoMemory: false, extensionReloading: false, extensionConfig: false },
    context: { fileName: 'GEMINI.md', includeDirectoryTree: false, loadMemoryFromIncludeDirectories: false, includeDirectories: [], memoryBoundaryMarkers: [] },
    general: { checkpointing: { enabled: false } }, ide: { enabled: false },
    telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false },
    modelConfigs: { overrides: [{ match: { model }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: effort } } } }] },
  };
}

export function nativePolicy(purpose = 'review') {
  if (nativePurpose(purpose) === 'scan') return `[[rule]]
toolName = ["list_directory", "read_file", "grep_search", "glob"]
decision = "allow"
priority = 100
`;

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
export function modelObservation(models, model) {
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
  return { purpose: 'review', response, models, ...observation, tools: json.stats?.tools ?? null };
}

export function prepare(args, git = reviewGit) {
  const { model, effort, reviewTree, mutationCopy, promptFile, outFile, change, project } = args;
  const settings = nativeSettings(model, effort);
  const folder = realpathSync(dirname(resolve(promptFile)));
  const recordText = read(join(folder, 'launch.json')), record = JSON.parse(recordText);
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
  return { purpose: 'review', record, recordText, settings, prompt, folder };
}

export async function runReview(args, deps = {}) {
  return runNative(args, prepare(args, deps.git), 'review', parseReply, deps);
}

// 入口各自核正式紀錄與完整回覆；共用此段才能讓失敗仍走相同的診斷與清理。
export async function runNative(args, p, purpose = 'review', parse = parseReply, { git = reviewGit, invoke = nativeCommand, preflight = prepareNativeObserver, cli = undefined } = {}) {
  nativePurpose(purpose);
  requireThat(p.purpose === purpose, '準備結果用途不符');
  const { mutationCopy, outFile, model } = args;
  const reviewTree = purpose === 'scan' ? args.scanTree : args.reviewTree;
  const executable = cli ?? (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'gemini')).find(file => existsSync(file));
  requireThat(executable, '找不到原生 Gemini CLI');
  const before = sourceSnapshot(reviewTree, git);
  const runtime = join(reviewTree, '.gemini');
  mkdirSync(runtime, { mode: 0o700 });
  const configFile = join(runtime, 'settings.json');
  const policyFile = join(p.folder, 'gemini-policy.toml');
  const settingsText = JSON.stringify(p.settings, null, 2) + '\n';
  const policyText = nativePolicy(purpose);
  const sentinel = 'finance-no-server-' + randomUUID();
  const startedAt = new Date().toISOString();
  let result, received, native, candidateEvidence, evidence, json, observation;
  /** @type {{ firstError?: Error }} */
  const failureState = {};
  const failures = [], checks = {};
  const passed = stage => checks[stage]?.status === 'passed';
  const skipped = (stage, reason) => { checks[stage] = { status: 'skipped', reason }; };
  const check = async (stage, action) => {
    try {
      const value = await action();
      checks[stage] = { status: 'passed' };
      return value;
    } catch (error) {
      const issue = error instanceof Error ? error : new Error(String(error));
      failureState.firstError ??= issue;
      const message = issue.message;
      failures.push({ stage, message });
      checks[stage] = { status: 'failed', message };
      return undefined;
    }
  };
  const commandArgs = ['--skip-trust', '--approval-mode', 'default', '--model', model, '-e', 'none', '--allowed-mcp-server-names', sentinel, ...(purpose === 'review' ? ['--include-directories', mutationCopy] : []), '--policy', policyFile, '--output-format', 'json', ...(purpose === 'scan' ? [] : ['-p', p.prompt])];
  if (purpose === 'scan') await check('materials-create', () => {
    save(join(p.folder, 'scan-diff.json'), p.diff);
    save(join(p.folder, 'scan-input.txt'), p.input);
  });
  await check('settings-create', () => save(configFile, settingsText));
  await check('policy-create', () => save(policyFile, policyText));
  if (passed('settings-create') && passed('policy-create') && (purpose === 'review' || passed('materials-create'))) {
    native = await check('observer-prepare', () => preflight(executable, reviewTree, p.settings, model, sentinel, purpose));
  } else skipped('observer-prepare', '本輪設定或 policy 未建立');
  if (passed('observer-prepare')) {
    result = await check('invoke', () => invoke(process.execPath, ['--import', native.bootstrap, native.executable, ...commandArgs], reviewTree, true, purpose === 'scan' ? p.input : undefined));
  } else skipped('invoke', 'observer 前置未完成，未啟動 CLI');
  if (passed('invoke')) {
    await check('stdout-save', () => save(outFile + '.stdout.json', result?.stdout ?? ''));
    await check('stderr-save', () => save(outFile + '.stderr', result?.stderr ?? ''));
    await check('native-exit', () => requireThat(result && !result.error && result.status === 0 && !result.signal, '原生 Gemini 未正常完成'));
    json = await check('native-json', () => JSON.parse(result?.stdout));
  } else {
    for (const stage of ['stdout-save', 'stderr-save', 'native-exit', 'native-json']) skipped(stage, '未取得 CLI 返回資料');
  }
  if (passed('native-json')) {
    observation = await check('model-roles', () => modelObservation(json.stats?.models, model));
  } else skipped('model-roles', '缺可解析的原生 JSON');
  if (passed('native-exit') && passed('model-roles')) {
    received = await check('reply', () => {
      const parsed = parse(result.stdout, result, p.record, model);
      requireThat(parsed.purpose === purpose, '完整回覆用途不符');
      return parsed;
    });
  } else skipped('reply', '原生退出或模型資格未通過');
  if (native && passed('model-roles')) {
    candidateEvidence = await check('evidence-reconcile', () => reconcileEvidence(read(native.eventsFile), json.stats, native.binding, purpose));
  } else skipped('evidence-reconcile', '缺本輪 observer 或合格角色統計');

  // 正文不合格仍需收齊可獨立的查核；清理失敗也不能省掉來源與髒樹診斷。
  await check('source-final', () => requireUnchanged(before, sourceSnapshot(reviewTree, git)));
  await check('inputs-final', () => {
    requireUnchanged(p.recordText, read(join(p.folder, purpose === 'scan' ? 'scan.json' : 'launch.json')));
    requireUnchanged(p.prompt, read(args.promptFile));
  });
  if (passed('settings-create')) {
    await check('settings-final', () => requireUnchanged(settingsText, read(configFile)));
  } else skipped('settings-final', '本輪沒有成功建立設定，不宣稱擁有該檔');
  if (passed('policy-create')) {
    await check('policy-final', () => requireUnchanged(policyText, read(policyFile)));
  } else skipped('policy-final', '本輪沒有成功建立 policy');
  if (passed('settings-final')) {
    await check('runtime-cleanup', () => { unlinkSync(configFile); rmdirSync(runtime); });
  } else skipped('runtime-cleanup', '未確認設定歸屬及內容，不刪除');
  await check('tree-clean', () => requireThat(git(reviewTree, ['status', '--porcelain', '--untracked-files=all']) === '', '審查樹有未知產物'));
  if (native) await check('observer-sources-final', () => verifyObserverSources(native));
  else skipped('observer-sources-final', 'observer 前置未完成');

  const verified = ['inputs-final', 'source-final', 'settings-final', 'policy-final', 'observer-sources-final', 'model-roles', 'evidence-reconcile'].every(passed);
  if (verified) {
    await check('evidence-save', () => save(outFile + '.evidence.json', JSON.stringify(candidateEvidence, null, 2) + '\n'));
    if (passed('evidence-save')) evidence = candidateEvidence;
  } else skipped('evidence-save', '來源、設定、角色或事件未核實，不能保存已核證據');
  const verifiedObservation = evidence ? observation : undefined;
  try {
    save(outFile + '.receipt.json', JSON.stringify({ purpose, startedAt, finishedAt: new Date().toISOString(), record: p.record, contentAcceptance: 'pending-human-acceptance', checks, failures, evidenceSha256: evidence ? hash(JSON.stringify(evidence, null, 2) + '\n') : null, cli: executable, args: commandArgs, native, status: result?.status ?? null, signal: result?.signal ?? null, error: result?.error?.message ?? null, failure: failureState.firstError?.message ?? null, sourceBefore: before, preparedRuntime: [{ path: configFile, sha256: hash(settingsText) }], policySha256: hash(policyText), promptSha256: hash(p.prompt), inputSha256: hash(p.input ?? p.prompt), diffSha256: p.diff ? hash(p.diff) : null, responseSha256: received ? hash(received.response) : null, observationStatus: verifiedObservation ? 'verified' : 'not-verified', observedModels: verifiedObservation ? Object.keys(json.stats.models) : [], mainModel: verifiedObservation?.mainModel ?? null, auxiliaryRoles: verifiedObservation?.auxiliaryRoles ?? [], toolStats: verifiedObservation ? json.stats.tools : null, promptOnly: purpose === 'scan' ? '掃描只載讀檔搜尋工具；差異由外層讀固定 blob 提供，模型未跑 git 或考題。讀檔工具不是檔案系統沙箱，前後相同不證明中途未改回。' : '審查樹唯讀與突變目的地靠提示及前後核對；不是 OS 隔離，也不能證明中途未改回。' }, null, 2) + '\n');
  } catch (error) { throw new Error('核收收據保存失敗，未產生正式 output；' + HELP, { cause: error }); }
  if (failureState.firstError) throw failureState.firstError;
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
