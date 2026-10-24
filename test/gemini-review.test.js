import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import launcher from '../tools/review-launch.js';
import { nativeSettings, nativeCommand, nativePolicy, parseReply, parseArgs, runReview, reviewGit, sourceSnapshot, requireUnchanged } from '../scripts/gemini-review.js';
import { injectDirtyGitEnv, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

const MODEL = 'gemini-3.1-pro-preview';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const templateFile = new URL('../templates/review-request.md', import.meta.url);
const template = readFileSync(templateFile, 'utf8');
const response = `🤖 Gemini｜來源：Gemini CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過\n### 本輪實際用的設定\n合成結果\n### 清單逐項結果\n合成清單\n### 發現\n本輪提了 0 條\n未貼\n`;
const LOOP_MODEL = 'gemini-3-flash-preview';
const role = (totalRequests = 1, totalErrors = 0) => ({ totalRequests, totalErrors });
const metrics = roles => ({ api: {
  totalRequests: Object.values(roles).reduce((sum, item) => sum + item.totalRequests, 0),
  totalErrors: Object.values(roles).reduce((sum, item) => sum + item.totalErrors, 0),
}, roles });
const result = (body, models = { [MODEL]: metrics({ main: role() }) }) => ({ status: 0, signal: null, error: undefined, stdout: JSON.stringify({ response: body, stats: { models, tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, byName: {} } } }), stderr: 'synthetic diagnostic\n' });
const retry = '核對 scripts/gemini-review.js 後跑 node --test test/gemini-review.test.js';

test('完整原生 response 與尾端換行原樣保留', () => {
  const r = result(response);
  assert.equal(parseReply(r.stdout, r, { head: HEAD, round: 1 }, MODEL).response, response, retry);
});

// 直接驗收件結果，避免完整入口的後段證據對帳遮住前段模型守衛失效。
test('parseReply 直接接受成功主審及合格循環偵測，保留完整本文與分工', () => {
  for (const models of [
    { [MODEL]: metrics({ main: role(2, 1) }) },
    { [MODEL]: metrics({ main: role(3, 1), utility_loop_detector: role(2, 1) }), [LOOP_MODEL]: metrics({ utility_loop_detector: role(4, 1) }) },
  ]) {
    const r = result(response, models);
    const parsed = parseReply(r.stdout, r, { head: HEAD, round: 1 }, MODEL);
    assert.equal(parsed.response, response, retry);
    assert.equal(parsed.mainModel, MODEL, retry);
    assert.deepEqual(parsed.models, Object.keys(models), retry);
    assert.deepEqual(parsed.auxiliaryRoles, Object.entries(models).flatMap(([model, row]) =>
      Object.entries(row.roles).filter(([name]) => name === 'utility_loop_detector')
        .map(([name, count]) => ({ model, role: name, ...count }))), retry);
  }
});

test('parseReply 直接拒收錯主審、缺成功主審及未核角色', async t => {
  const validMain = () => ({ [MODEL]: metrics({ main: role(2, 0) }) });
  const cases = [
    ['輔助模型不能兼任主審', () => ({ ...validMain(), [LOOP_MODEL]: metrics({ main: role() }) }), /原生主審模型不符/u],
    ['只有循環偵測不算主審', () => ({ [MODEL]: metrics({ utility_loop_detector: role() }) }), /沒有成功 main/u],
    ['主審請求全失敗', () => ({ [MODEL]: metrics({ main: role(2, 2) }) }), /沒有成功 main/u],
    ['主審零請求', () => ({ [MODEL]: metrics({ main: role(0, 0) }) }), /沒有成功 main/u],
    ['未知角色不能算輔助', () => ({ [MODEL]: metrics({ main: role(), unknown: role() }) }), /角色未核實/u],
    ['未登記模型不能作循環偵測', () => ({ ...validMain(), 'unregistered-model': metrics({ utility_loop_detector: role() }) }), /原生回報模型不符/u],
    ['模型缺角色', () => ({ [MODEL]: { api: role() } }), /缺可用角色/u],
    ['角色不能是陣列', () => ({ [MODEL]: { api: role(), roles: [] } }), /缺可用角色/u],
  ];
  for (const [name, models, error] of cases) await t.test(name, () => {
    const r = result(response, models());
    assert.throws(() => parseReply(r.stdout, r, { head: HEAD, round: 1 }, MODEL), error, retry);
  });
});

test('parseReply 直接拒收不合法及未歸屬的角色計數', async t => {
  const base = () => ({ [MODEL]: metrics({ main: role(3, 1) }), [LOOP_MODEL]: metrics({ utility_loop_detector: role(2, 0) }) });
  const cases = [
    ['請求總數未歸屬', models => { models[MODEL].api.totalRequests++; }, /未完整歸屬角色/u],
    ['錯誤總數未歸屬', models => { models[MODEL].api.totalErrors++; }, /未完整歸屬角色/u],
    ['角色缺請求數', models => { delete models[MODEL].roles.main.totalRequests; }, /模型計數不符/u],
    ['角色缺錯誤數', models => { delete models[MODEL].roles.main.totalErrors; }, /模型計數不符/u],
    ['角色數不能是字串', models => { models[MODEL].roles.main.totalRequests = '3'; }, /模型計數不符/u],
    ['角色數不能是小數', models => { models[MODEL].roles.main.totalRequests = 3.5; }, /模型計數不符/u],
    ['角色數不可超出安全整數', models => { models[MODEL].roles.main.totalRequests = Number.MAX_SAFE_INTEGER + 1; }, /模型計數不符/u],
    ['負角色計數即使總數相合也拒收', models => { models[MODEL] = metrics({ main: role(3, 1), utility_loop_detector: role(-1, -1) }); }, /模型計數不符/u],
    ['角色錯誤多於請求即使總數合法也拒收', models => { models[MODEL] = metrics({ main: role(3, 0), utility_loop_detector: role(1, 2) }); }, /錯誤計數超過請求/u],
    ['API 計數不能是字串', models => { models[MODEL].api.totalRequests = '3'; }, /模型計數不符/u],
    ['API 錯誤不能多於請求', models => { models[MODEL].api.totalErrors = 4; }, /錯誤計數超過請求/u],
    ['計數不能是空值', models => { models[MODEL].roles.main = null; }, /模型計數形狀不符/u],
  ];
  for (const [name, mutate, error] of cases) await t.test(name, () => {
    const models = base();
    mutate(models);
    const r = result(response, models);
    assert.throws(() => parseReply(r.stdout, r, { head: HEAD, round: 1 }, MODEL), error, retry);
  });
});

test('未完成或真發現在前、合規範例在後不能轉成正式通過', () => {
  for (const prefix of ['尚未完成測試。\n', 'High：會丟失原錯誤。範例：\n```text\n', '\n']) {
    const r = result(prefix + response);
    assert.throws(() => parseReply(r.stdout, r, { head: HEAD, round: 1 }, MODEL), /完整回覆首行/u, retry);
  }
});

test('非零、訊號、缺 response、錯模型與正式身分拒收', () => {
  const r = result(response);
  for (const patch of [{ status: 1 }, { signal: 'SIGTERM' }, { error: new Error('spawn failure') }]) {
    assert.throws(() => parseReply(r.stdout, { ...r, ...patch }, { head: HEAD, round: 1 }, MODEL), /未正常完成/u, retry);
  }
  assert.throws(() => parseReply('{}', r, { head: HEAD, round: 1 }, MODEL), /缺完整 response/u, retry);
  assert.throws(() => parseReply(r.stdout, r, { head: HEAD, round: 1 }, 'other-model'), /模型不符/u, retry);
  for (const body of [response.replace('Gemini｜','Grok｜'), response.replace('Gemini CLI','other CLI'), response.replace(HEAD.slice(0,7),'c'.repeat(7)), response.replace('### 清單逐項結果','其他小標')]) {
    const changed = result(body);
    assert.throws(() => parseReply(changed.stdout, changed, { head: HEAD, round: 1 }, MODEL), /標頭|小標/u, retry);
  }
});

test('effort 寫入原生模型設定且正式工具不是空表', () => {
  const s = nativeSettings(MODEL, 'HIGH');
  assert.equal(s.modelConfigs.overrides[0].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel, 'HIGH', retry);
  for (const tool of ['read_file', 'grep_search', 'run_shell_command', 'replace', 'write_file']) assert.ok(s.tools.core.includes(tool), retry);
  assert.match(nativePolicy(), /commandPrefix = .*"node".*"npm"/u, retry);
  assert.throws(() => nativeSettings(MODEL, 'LOW'), /模型或推理/u, retry);
  assert.throws(() => nativeSettings('auto', 'HIGH'), /模型或推理/u, retry);
  assert.throws(() => parseArgs([]), /缺少啟動參數/u, retry);
});

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-review-case-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = join(dir, 'tree'), mutation = join(dir, 'mutation');
  mkdirSync(tree); mkdirSync(mutation); mkdirSync(join(tree, 'templates'));
  const settings = { platform: { project: 'synthetic/repo' }, reviewers: [{ participant: 'Gemini', strongest: MODEL, maxEffort: 'HIGH', source: 'Gemini CLI' }] };
  writeFileSync(join(tree, 'settings.json'), JSON.stringify(settings));
  writeFileSync(join(tree, 'templates/review-request.md'), template);
  writeFileSync(join(tree, 'source.js'), 'export const value = 7;\n');
  const args = { model: MODEL, effort: 'HIGH', reviewTree: tree, mutationCopy: mutation, promptFile: join(dir, 'prompt.md'), outFile: join(dir, 'output.log'), change: '730', project: 'synthetic/repo' };
  const record = { reviewer: 'Gemini', change: 730, round: 1, head: HEAD, base: BASE, tree, mutation, promptFile: args.promptFile, outFile: args.outFile, root: tree };
  writeFileSync(join(dir, 'launch.json'), JSON.stringify(record));
  const values = Object.fromEntries(launcher.FILL.filter(([,key]) => key).map(([,key]) => [key,'合成事實']));
  Object.assign(values, { project: args.project, change: args.change, reviewer: 'Gemini', source: 'Gemini CLI', head: HEAD, headShort: HEAD.slice(0,7), base: BASE, round: '1', reviewTree: tree, mutationCopy: mutation, implementer: 'Codex' });
  writeFileSync(args.promptFile, launcher.fill(template, values));
  const git = (_cwd, command) => {
    if (command[0] === 'status') return '';
    if (command[0] === 'ls-files') return 'settings.json\0templates/review-request.md\0source.js\0';
    if (command.includes('--abbrev-ref')) return 'HEAD';
    return HEAD;
  };
  return { args, record, git, tree, mutation, dir };
}

function fakePreflight(f, models = { [MODEL]: metrics({ main: role() }) }) {
  return async () => {
    const bootstrap = join(f.tree, 'source.js');
    const sha = createHash('sha256').update(readFileSync(bootstrap)).digest('hex');
    const eventsFile = join(f.dir, 'native-events.jsonl');
    const events = [{ type: 'installed' }, ...['refreshAuth','initialize','request'].map(stage => ({ type: 'config', stage, configId: 1 }))];
    for (const [model, row] of Object.entries(models)) for (const [role, count] of Object.entries(row.roles)) {
      for (let i = 0; i < count.totalRequests; i++) events.push({ type: 'request', model, role, configId: 1 });
    }
    writeFileSync(eventsFile, events.map((event, index) => JSON.stringify({ sequence: index + 1, pid: 123, binding: 'synthetic', purpose: 'review', ...event })).join('\n') + '\n');
    return { executable: process.execPath, bootstrap, bootstrapSha256: sha, observer: bootstrap, observerSha256: sha, eventsFile, binding: 'synthetic', sources: [] };
  };
}

test('正式接線保留輸出與收據、可跑真考題並僅在合成副本操作', async t => {
  const f = fixture(t);
  let called = 0, preflightCalled = 0;
  await runReview(f.args, {
    git: f.git, cli: process.execPath,
    preflight: async (_cli, tree, settings) => {
      preflightCalled++;
      assert.equal(JSON.parse(readFileSync(join(tree,'.gemini/settings.json'))).modelConfigs.overrides[0].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel, 'HIGH', retry);
      assert.equal(settings.tools.core.includes('run_shell_command'), true, retry);
      return fakePreflight(f)();
    },
    invoke: (_cli, args, cwd, trusted) => {
      called++;
      assert.equal(trusted, true, retry);
      assert.equal(args[0], '--import', retry);
      assert.equal(cwd, f.tree, retry);
      assert.equal(args[args.indexOf('--model') + 1], MODEL, retry);
      assert.equal(args[args.indexOf('--approval-mode') + 1], 'default', retry);
      assert.equal(args[args.indexOf('--include-directories') + 1], f.mutation, retry);
      assert.equal(args[args.indexOf('-p') + 1], readFileSync(f.args.promptFile, 'utf8'), retry);
      const testFile = join(f.mutation, 'case.test.mjs');
      writeFileSync(testFile, "import assert from 'node:assert/strict'; assert.equal(7,7);\n");
      const run = nativeCommand(process.execPath, ['--test', testFile], f.mutation);
      assert.equal(run.status, 0, retry);
      writeFileSync(testFile, "import assert from 'node:assert/strict'; assert.equal(7,8);\n");
      assert.equal(nativeCommand(process.execPath, ['--test', testFile], f.mutation).status, 1, retry);
      writeFileSync(testFile, "import assert from 'node:assert/strict'; assert.equal(7,7);\n");
      return result(response);
    },
  });
  assert.equal(called, 1); assert.equal(preflightCalled, 1);
  assert.equal(readFileSync(f.args.outFile, 'utf8'), response, retry);
  const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
  assert.equal(receipt.status, 0); assert.equal(receipt.failure, null);
  assert.equal(receipt.native.binding, 'synthetic');
  assert.equal(receipt.contentAcceptance, 'pending-human-acceptance', retry);
  assert.equal(JSON.parse(readFileSync(f.args.outFile + '.evidence.json')).status, 'pending-human-acceptance', retry);
  assert.equal(existsSync(join(f.tree,'.gemini')), false, retry);
  assert.equal(readFileSync(join(f.tree, 'source.js'),'utf8'), 'export const value = 7;\n', retry);
});

test('送出前拒絕錯版本、缺提示與既有 runtime 配置', async t => {
  for (const mode of ['head','prompt','runtime']) {
    const f = fixture(t); let calls = 0;
    if (mode === 'head') { f.record.head = 'c'.repeat(40); writeFileSync(join(f.dir,'launch.json'), JSON.stringify(f.record)); }
    if (mode === 'prompt') rmSync(f.args.promptFile);
    if (mode === 'runtime') mkdirSync(join(f.tree, '.gemini'));
    await assert.rejects(runReview(f.args, { git: f.git, cli: process.execPath, invoke: () => { calls++; return result(response); } }), /固定本輪版本|ENOENT|已有 Gemini/u, retry);
    assert.equal(calls, 0, retry);
  }
});

test('來源或準備設定被改，保留失敗收據且不寫正式 output', async t => {
  for (const mode of ['source','runtime','exit']) {
    const f = fixture(t); let calls = 0;
    await assert.rejects(runReview(f.args, { git: f.git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => {
      calls++;
      if (mode === 'source') writeFileSync(join(f.tree,'source.js'),'unauthorized\n');
      if (mode === 'runtime') writeFileSync(join(f.tree,'.gemini/settings.json'),'{}\n');
      return { ...result(response), status: mode === 'exit' ? 2 : 0 };
    } }), /未授權變動|未正常完成/u, retry);
    assert.equal(calls, 1); assert.equal(existsSync(f.args.outFile), false, retry);
    assert.ok(JSON.parse(readFileSync(f.args.outFile + '.receipt.json')).failure, retry);
    assert.equal(readFileSync(f.args.outFile + '.stdout.json', 'utf8'), result(response).stdout, retry);
  }
});

test('Git 核對與原生子程序在髒環境仍讀對工作樹', () => {
  const restore = injectDirtyGitEnv();
  try {
    assert.equal(reviewGit(ROOT, ['rev-parse','--show-toplevel']), ROOT.replace(/\/$/u,''), retry);
    const r = nativeCommand(process.execPath, ['-e', "const {execFileSync}=require('node:child_process'); process.stdout.write(execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}));"], ROOT);
    assert.equal(r.status, 0); assert.equal(r.stdout.trim(), ROOT.replace(/\/$/u,''), retry);
  } finally { restore(); }
});

test('子行程實際環境不含 GIT_ 家族', () => {
  assertChildGitEnvClean(assert, 'Gemini reviewGit', () => reviewGit(ROOT, ['rev-parse','HEAD']));
  assertChildGitEnvClean(assert, 'Gemini nativeCommand', () => nativeCommand(process.execPath, ['-e', "require('node:child_process').spawnSync('git',['status'],{stdio:'inherit'});"], ROOT));
});

test('子程序清 NODE_TEST_CONTEXT，父程序標誌仍保留', () => {
  const before = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    const r = nativeCommand(process.execPath, ['-p', 'Object.hasOwn(process.env, "NODE_TEST_CONTEXT")'], ROOT);
    assert.equal(r.status, 0, retry); assert.equal(r.stdout.trim(), 'false', retry);
    assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8', retry);
  } finally {
    if (before === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = before;
  }
});


test('不同二進位來源即使解碼相同也拒收', async t => {
  const f = fixture(t);
  const file = join(f.tree, 'synthetic.bin');
  const first = Buffer.from([0x80]), second = Buffer.from([0x81]);
  assert.equal(first.toString('utf8'), second.toString('utf8'));
  const git = (_cwd, args) => args[0] === 'ls-files' ? 'synthetic.bin\0' : HEAD;
  writeFileSync(file, first);
  const before = sourceSnapshot(f.tree, git);
  writeFileSync(file, second);
  const after = sourceSnapshot(f.tree, git);
  assert.notEqual(before.files[0][1], after.files[0][1], retry);
  assert.throws(() => requireUnchanged(before, after), /未授權變動/u, retry);
  writeFileSync(file, first);
  await assert.rejects(runReview(f.args, {
    git: (cwd, args) => args[0] === 'ls-files' ? 'synthetic.bin\0' : f.git(cwd, args),
    cli: process.execPath, preflight: fakePreflight(f),
    invoke: () => { writeFileSync(file, second); return result(response); },
  }), /未授權變動/u, retry);
  assert.equal(existsSync(f.args.outFile), false, retry);
  assert.match(JSON.parse(readFileSync(f.args.outFile + '.receipt.json')).failure, /未授權變動/u, retry);
});


test('官方範本原文可送完整入口，固定正文改字在模型前拒收', async t => {
  const f = fixture(t);
  assert.deepEqual(readFileSync(join(f.tree, 'templates/review-request.md')), readFileSync(templateFile), retry);
  let calls = 0;
  const options = { git: f.git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => { calls++; return result(response); } };
  await runReview(f.args, options);
  assert.equal(calls, 1, retry);
  assert.equal(readFileSync(f.args.outFile, 'utf8'), response, retry);
  const changed = fixture(t);
  const original = readFileSync(changed.args.promptFile, 'utf8');
  const sentence = '3. 整份考題要不要跑，由你獨立判斷。';
  assert.equal(original.split(sentence).length, 2, retry);
  writeFileSync(changed.args.promptFile, original.replace(sentence, '3. 整份考題不可以跑。'));
  calls = 0;
  await assert.rejects(runReview(changed.args, { ...options, git: changed.git }), /範本事實格以外/u, retry);
  assert.equal(calls, 0, retry);
  assert.equal(existsSync(changed.args.outFile), false, retry);
});


test('完整入口按 main 與已核循環偵測分列模型觀測', async t => {
  for (const models of [
    { [MODEL]: metrics({ main: role(2, 1) }), [LOOP_MODEL]: metrics({ utility_loop_detector: role() }) },
    { [MODEL]: metrics({ main: role(2) }) },
    { [MODEL]: metrics({ main: role(), utility_loop_detector: role(2) }) },
  ]) {
    const f = fixture(t); let calls = 0;
    const r = result(response, models);
    await runReview(f.args, { git: f.git, cli: process.execPath, preflight: fakePreflight(f, models), invoke: () => { calls++; return r; } });
    assert.equal(calls, 1, retry);
    assert.equal(readFileSync(f.args.outFile, 'utf8'), response, retry);
    const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
    assert.equal(receipt.mainModel, MODEL, retry);
    const auxiliary = Object.entries(models).filter(([, value]) => Object.hasOwn(value.roles, 'utility_loop_detector'))
      .map(([model, value]) => ({ model, role: 'utility_loop_detector', ...value.roles.utility_loop_detector }));
    assert.deepEqual(receipt.auxiliaryRoles, auxiliary, retry);
    assert.equal(readFileSync(f.args.outFile + '.stdout.json', 'utf8'), r.stdout, retry);
  }
});

test('完整入口拒收錯主審、未知角色及未歸屬請求', async t => {
  const valid = () => ({ [MODEL]: metrics({ main: role(2) }) });
  const cases = [
    ['錯主審', { [LOOP_MODEL]: metrics({ main: role() }) }],
    ['主模型僅輔助', { [MODEL]: metrics({ utility_loop_detector: role() }), [LOOP_MODEL]: metrics({ main: role() }) }],
    ['額外模型混入 main', { ...valid(), [LOOP_MODEL]: metrics({ main: role(), utility_loop_detector: role() }) }],
    ['未知輔助模型', { ...valid(), other: metrics({ utility_loop_detector: role() }) }],
    ['未知角色', { [MODEL]: metrics({ main: role(), utility_other: role() }) }],
    ['助手角色', { [MODEL]: metrics({ main: role(), subagent: role() }) }],
    ['缺角色', { [MODEL]: { api: role(2) } }],
    ['角色為陣列', { [MODEL]: { api: role(2), roles: [] } }],
    ['未歸屬請求', { [MODEL]: { api: role(3), roles: { main: role(2) } } }],
    ['未歸屬錯誤', { [MODEL]: { api: role(2, 1), roles: { main: role(2) } } }],
    ['沒有成功 main', { [MODEL]: metrics({ main: role(2, 2) }) }],
    ['沒有 main', { [MODEL]: metrics({ utility_loop_detector: role() }) }],
    ['缺請求計數', { [MODEL]: { api: role(), roles: { main: { totalErrors: 0 } } } }],
    ['字串計數', { [MODEL]: { api: role(), roles: { main: role('1') } } }],
    ['負數計數', { [MODEL]: { api: role(), roles: { main: role(-1) } } }],
    ['非整數', { [MODEL]: { api: role(), roles: { main: role(0.5) } } }],
    ['超安全整數', { [MODEL]: { api: role(), roles: { main: role(Number.MAX_SAFE_INTEGER + 1) } } }],
    ['錯誤超過請求', { [MODEL]: { api: role(), roles: { main: role(1, 2) } } }],
    ['模型表為陣列', []],
    ['模型表為 null', null],
    ['保留字角色', { [MODEL]: { api: role(), roles: JSON.parse('{"__proto__":{"totalRequests":1,"totalErrors":0}}') } }],
  ];
  for (const [name, models] of cases) {
    const f = fixture(t); let calls = 0;
    const r = result(response, models);
    await assert.rejects(runReview(f.args, { git: f.git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => { calls++; return r; } }), /模型|角色|計數|歸屬/u, name + '；' + retry);
    assert.equal(calls, 1, name + '；' + retry);
    assert.equal(existsSync(f.args.outFile), false, name + '；' + retry);
    const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
    assert.ok(receipt.failure, name + '；' + retry);
    assert.equal(readFileSync(f.args.outFile + '.stdout.json', 'utf8'), r.stdout, name + '；' + retry);
  }
});

test('信任旗標只在正式子程序早設，不改父程序或一般命令', () => {
  const before = process.env.GEMINI_CLI_TRUST_WORKSPACE;
  const r = nativeCommand(process.execPath, ['-p', 'process.env.GEMINI_CLI_TRUST_WORKSPACE'], ROOT, true);
  assert.equal(r.status, 0, retry); assert.equal(r.stdout.trim(), 'true', retry);
  assert.equal(process.env.GEMINI_CLI_TRUST_WORKSPACE, before, retry);
});

test('缺失或矛盾旁錄使完整入口拒收，原生回覆仍保留', async t => {
  for (const mode of ['missing', 'partial', 'count']) {
    const f = fixture(t);
    await assert.rejects(runReview(f.args, {
      git: f.git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => {
        const file = join(f.dir, 'native-events.jsonl');
        if (mode === 'missing') rmSync(file);
        if (mode === 'partial') writeFileSync(file, readFileSync(file, 'utf8').trimEnd());
        if (mode === 'count') {
          const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
          lines.pop(); writeFileSync(file, lines.join('\n') + '\n');
        }
        return result(response);
      },
    }), /ENOENT|尾端|請求旁錄/u, retry);
    assert.equal(existsSync(f.args.outFile), false, retry);
    assert.equal(readFileSync(f.args.outFile + '.stdout.json', 'utf8'), result(response).stdout, retry);
    assert.ok(JSON.parse(readFileSync(f.args.outFile + '.receipt.json')).failure, retry);
  }
});

test('733 隱私拒收仍對帳已驗真的原生證據，保留全部原始輸出', async t => {
  const f = fixture(t);
  const r = result(response + '本機位置 /Users/private-case/example\n');
  await assert.rejects(runReview(f.args, {git:f.git, cli:process.execPath, preflight:fakePreflight(f), invoke:()=>r}));
  assert.equal(readFileSync(f.args.outFile+'.stdout.json','utf8'),r.stdout,retry);
  assert.equal(existsSync(f.args.outFile),false,retry);
  assert.equal(existsSync(f.args.outFile+'.evidence.json'),true,'隱私拒收不應跳過可獨立完成的原生證據對帳；'+retry);
  const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
  assert.equal(receipt.observationStatus, 'verified', retry);
  assert.equal(receipt.mainModel, MODEL, retry);
  assert.deepEqual(receipt.observedModels, [MODEL], retry);
  assert.equal(receipt.checks.reply.status, 'failed', retry);
  assert.equal(receipt.contentAcceptance, 'pending-human-acceptance', retry);
  assert.equal(JSON.parse(readFileSync(f.args.outFile + '.evidence.json')).status, 'pending-human-acceptance', retry);
});

test('733 回覆拒收與未知產物同時發生，收據保留兩項錯誤', async t => {
  const f=fixture(t); let invoked=false;
  const git=(cwd,args)=>args[0]==='status' && invoked ? '?? unexpected.md' : f.git(cwd,args);
  const r=result(response+'本機位置 /Users/private-case/example\n');
  await assert.rejects(runReview(f.args,{git,cli:process.execPath,preflight:fakePreflight(f),invoke:()=>{invoked=true;writeFileSync(join(f.tree,'unexpected.md'),'synthetic');return r;}}));
  const receipt=JSON.parse(readFileSync(f.args.outFile+'.receipt.json'));
  assert.ok(Array.isArray(receipt.failures),'收據缺多項失敗紀錄；'+retry);
  assert.ok(receipt.failures.some(item=>/本機|絕對路徑/u.test(item.message)),retry);
  assert.ok(receipt.failures.some(item=>/未知產物/u.test(item.message)),retry);
  assert.equal(readFileSync(join(f.tree,'unexpected.md'),'utf8'),'synthetic',retry);
  assert.equal(existsSync(f.args.outFile),false,retry);
});


test('正文拒收與來源變動分別留痕，來源未核不保存已核證據', async t => {
  const f = fixture(t);
  const r = result(response + '本機位置 /Users/private-case/example\n');
  await assert.rejects(runReview(f.args, { git: f.git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => {
    writeFileSync(join(f.tree, 'source.js'), 'changed source\n');
    return r;
  } }), /本機|絕對路徑/u, retry);
  const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
  assert.deepEqual(receipt.failures.map(item => item.stage), ['reply', 'source-final', 'observer-sources-final'], retry);
  assert.equal(receipt.checks['evidence-reconcile'].status, 'passed', retry);
  assert.equal(receipt.checks['evidence-save'].status, 'skipped', retry);
  assert.ok(receipt.checks['evidence-save'].reason, retry);
  assert.equal(receipt.observationStatus, 'not-verified', retry);
  assert.equal(receipt.mainModel, null, retry);
  assert.equal(receipt.evidenceSha256, null, retry);
  assert.equal(existsSync(f.args.outFile + '.evidence.json'), false, retry);
  assert.equal(existsSync(f.args.outFile), false, retry);
  assert.equal(readFileSync(f.args.outFile + '.stdout.json', 'utf8'), r.stdout, retry);
});

test('正文拒收、缺事件與髒樹並存，收尾檢查仍各自完成', async t => {
  const f = fixture(t); let invoked = false;
  const git = (cwd, args) => args[0] === 'status' && invoked ? '?? unknown.md' : f.git(cwd, args);
  const r = result(response + '本機位置 /Users/private-case/example\n');
  await assert.rejects(runReview(f.args, { git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => {
    invoked = true;
    rmSync(join(f.dir, 'native-events.jsonl'));
    writeFileSync(join(f.tree, 'unknown.md'), 'unknown');
    return r;
  } }), /本機|絕對路徑/u, retry);
  const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
  assert.deepEqual(receipt.failures.map(item => item.stage), ['reply', 'evidence-reconcile', 'tree-clean'], retry);
  for (const stage of ['source-final', 'settings-final', 'policy-final', 'runtime-cleanup', 'observer-sources-final']) assert.equal(receipt.checks[stage].status, 'passed', retry);
  assert.equal(readFileSync(join(f.tree, 'unknown.md'), 'utf8'), 'unknown', retry);
  assert.equal(existsSync(f.args.outFile + '.evidence.json'), false, retry);
  assert.equal(existsSync(f.args.outFile), false, retry);
});

test('前置拒收不啟 CLI，不假稱取得原生資料且清理本輪設定', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(runReview(f.args, { git: f.git, cli: process.execPath, preflight: () => { throw new Error('synthetic preflight rejection'); }, invoke: () => { calls++; return result(response); } }), /synthetic preflight rejection/u, retry);
  const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
  assert.equal(calls, 0, retry);
  assert.deepEqual(receipt.failures.map(item => item.stage), ['observer-prepare'], retry);
  assert.equal(receipt.failure, receipt.failures[0].message, retry);
  for (const stage of ['invoke', 'native-json', 'reply', 'evidence-reconcile', 'observer-sources-final', 'evidence-save']) {
    assert.equal(receipt.checks[stage].status, 'skipped', retry);
    assert.ok(receipt.checks[stage].reason, retry);
  }
  assert.equal(receipt.checks['runtime-cleanup'].status, 'passed', retry);
  assert.equal(receipt.mainModel, null, retry);
  assert.deepEqual(receipt.observedModels, [], retry);
  assert.equal(existsSync(join(f.tree, '.gemini')), false, retry);
  assert.equal(existsSync(f.args.outFile + '.stdout.json'), false, retry);
});

test('來源、設定、policy 與髒樹分別核對，不刪變動設定', async t => {
  const f = fixture(t); let invoked = false;
  const git = (cwd, args) => args[0] === 'status' && invoked ? '?? .gemini/settings.json' : f.git(cwd, args);
  await assert.rejects(runReview(f.args, { git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => {
    invoked = true;
    writeFileSync(join(f.tree, 'source.js'), 'changed source');
    writeFileSync(join(f.tree, '.gemini/settings.json'), '{}');
    writeFileSync(join(f.dir, 'gemini-policy.toml'), 'changed policy');
    return result(response);
  } }), /未授權變動/u, retry);
  const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
  assert.deepEqual(receipt.failures.map(item => item.stage), ['source-final', 'settings-final', 'policy-final', 'tree-clean', 'observer-sources-final'], retry);
  assert.equal(receipt.checks['runtime-cleanup'].status, 'skipped', retry);
  assert.ok(receipt.checks['runtime-cleanup'].reason, retry);
  assert.equal(readFileSync(join(f.tree, '.gemini/settings.json'), 'utf8'), '{}', retry);
  assert.equal(existsSync(f.args.outFile + '.evidence.json'), false, retry);
  assert.equal(existsSync(f.args.outFile), false, retry);
});

test('清理遇到未知 runtime 產物仍核髒樹與 observer，不刪未知檔', async t => {
  const f = fixture(t); let invoked = false;
  const git = (cwd, args) => args[0] === 'status' && invoked ? '?? .gemini/unknown' : f.git(cwd, args);
  await assert.rejects(runReview(f.args, { git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => {
    invoked = true;
    writeFileSync(join(f.tree, '.gemini/unknown'), 'keep unknown');
    return result(response);
  } }), /ENOTEMPTY/u, retry);
  const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
  assert.deepEqual(receipt.failures.map(item => item.stage), ['runtime-cleanup', 'tree-clean'], retry);
  assert.equal(receipt.checks['observer-sources-final'].status, 'passed', retry);
  assert.equal(readFileSync(join(f.tree, '.gemini/unknown'), 'utf8'), 'keep unknown', retry);
  assert.equal(existsSync(f.args.outFile), false, retry);
});

test('壞 JSON 仍保留原始輸出並核髒樹，依賴階段明列未執行原因', async t => {
  const f = fixture(t); let invoked = false;
  const git = (cwd, args) => args[0] === 'status' && invoked ? '?? unknown' : f.git(cwd, args);
  const raw = '{invalid synthetic JSON\n';
  await assert.rejects(runReview(f.args, { git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => {
    invoked = true;
    return { ...result(response), stdout: raw };
  } }), /JSON|property/u, retry);
  const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
  assert.deepEqual(receipt.failures.map(item => item.stage), ['native-json', 'tree-clean'], retry);
  for (const stage of ['model-roles', 'reply', 'evidence-reconcile', 'evidence-save']) {
    assert.equal(receipt.checks[stage].status, 'skipped', retry);
    assert.ok(receipt.checks[stage].reason, retry);
  }
  assert.equal(readFileSync(f.args.outFile + '.stdout.json', 'utf8'), raw, retry);
  assert.equal(readFileSync(f.args.outFile + '.stderr', 'utf8'), 'synthetic diagnostic\n', retry);
  assert.equal(existsSync(f.args.outFile), false, retry);
});

test('收據保存失敗直接拒收，不發布待貼全文或覆蓋既有檔', async t => {
  const f = fixture(t);
  await assert.rejects(runReview(f.args, { git: f.git, cli: process.execPath, preflight: fakePreflight(f), invoke: () => {
    writeFileSync(f.args.outFile + '.receipt.json', 'keep existing');
    return result(response);
  } }), /收據保存失敗/u, retry);
  assert.equal(readFileSync(f.args.outFile + '.receipt.json', 'utf8'), 'keep existing', retry);
  assert.equal(existsSync(f.args.outFile), false, retry);
});


test('來源、runtime、policy 與 observer 個別失敗，各自撤回證據資格', async t => {
  for (const [mode, stage] of [['source', 'source-final'], ['runtime', 'settings-final'], ['policy', 'policy-final'], ['observer', 'observer-sources-final']]) {
    const f = fixture(t);
    const observer = join(f.dir, 'independent-observer.js');
    const preflight = async () => {
      const native = await fakePreflight(f)();
      const bytes = readFileSync(native.observer);
      writeFileSync(observer, bytes);
      const sha = createHash('sha256').update(bytes).digest('hex');
      return { ...native, bootstrap: observer, observer, bootstrapSha256: sha, observerSha256: sha };
    };
    await assert.rejects(runReview(f.args, { git: f.git, cli: process.execPath, preflight, invoke: () => {
      const file = { source: join(f.tree, 'source.js'), runtime: join(f.tree, '.gemini/settings.json'), policy: join(f.dir, 'gemini-policy.toml'), observer }[mode];
      writeFileSync(file, 'changed synthetic source');
      return result(response);
    } }), undefined, mode + '；' + retry);
    const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
    assert.equal(receipt.checks[stage].status, 'failed', mode + '；' + retry);
    assert.equal(receipt.checks['evidence-reconcile'].status, 'passed', mode + '；' + retry);
    assert.equal(receipt.observationStatus, 'not-verified', mode + '；' + retry);
    assert.equal(receipt.evidenceSha256, null, mode + '；' + retry);
    assert.equal(existsSync(f.args.outFile + '.evidence.json'), false, mode + '；' + retry);
    assert.equal(existsSync(f.args.outFile), false, mode + '；' + retry);
  }
});
