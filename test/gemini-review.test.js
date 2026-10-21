import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import launcher from '../tools/review-launch.js';
import { nativeSettings, nativeCommand, nativePolicy, parseReply, parseArgs, runReview, reviewGit, nativePreflight, verifyNativeReceipt, sourceSnapshot, requireUnchanged } from '../scripts/gemini-review.js';
import { injectDirtyGitEnv, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

const MODEL = 'gemini-3.1-pro-preview';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const templateFile = new URL('../templates/review-request.md', import.meta.url);
const template = readFileSync(templateFile, 'utf8') + '\n';
const response = `🤖 Gemini｜來源：Gemini CLI｜審 \`${HEAD.slice(0, 7)}\`｜r1｜結論：通過\n### 本輪實際用的設定\n合成結果\n### 清單逐項結果\n合成清單\n### 發現\n本輪提了 0 條\n未貼\n`;
const result = body => ({ status: 0, signal: null, error: undefined, stdout: JSON.stringify({ response: body, stats: { models: { [MODEL]: {} }, tools: { totalCalls: 3 } } }), stderr: 'synthetic diagnostic\n' });
const retry = '核對 scripts/gemini-review.js 後跑 node --test test/gemini-review.test.js';

test('完整原生 response 與尾端換行原樣保留', () => {
  const r = result(response);
  assert.equal(parseReply(r.stdout, r, { head: HEAD, round: 1 }, MODEL).response, response, retry);
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
  writeFileSync(join(tree, 'templates/review-request.md'), template.trimEnd() + '\n');
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

test('正式接線保留輸出與收據、可跑真考題並僅在合成副本操作', async t => {
  const f = fixture(t);
  let called = 0, preflightCalled = 0;
  await runReview(f.args, {
    git: f.git, cli: process.execPath,
    preflight: async (_cli, tree, settings) => {
      preflightCalled++;
      assert.equal(JSON.parse(readFileSync(join(tree,'.gemini/settings.json'))).modelConfigs.overrides[0].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel, 'HIGH', retry);
      assert.equal(settings.tools.core.includes('run_shell_command'), true, retry);
      return { version: 'synthetic', thinkingLevelConfigured: 'HIGH' };
    },
    invoke: (_cli, args, cwd) => {
      called++;
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
  assert.equal(receipt.native.thinkingLevelConfigured, 'HIGH');
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
    await assert.rejects(runReview(f.args, { git: f.git, cli: process.execPath, preflight: async () => ({}), invoke: () => {
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

test('原生有效收據綁定本輪，缺欄、錯 HEAD／設定／CLI 拒收', () => {
  const expected = { head: HEAD, launchSha256: 'launch', settingsSha256: 'settings', cliSha256: 'cli', model: MODEL, sentinel: 'no-server' };
  const receipt = { ...expected, version: '0.64.0', thinkingLevelConfigured: 'HIGH', mcpNoConfiguredMatch: true, tools: ['glob','grep_search','list_directory','read_file','replace','run_shell_command','write_file'], bundles: [{},{}] };
  assert.equal(verifyNativeReceipt(receipt, expected), receipt, retry);
  for (const key of Object.keys(expected)) {
    const missing = { ...receipt }; delete missing[key];
    assert.throws(() => verifyNativeReceipt(missing, expected), /未綁定/u, retry);
    assert.throws(() => verifyNativeReceipt({ ...receipt, [key]: 'different' }, expected), /未綁定/u, retry);
  }
  assert.throws(() => verifyNativeReceipt({ ...receipt, thinkingLevelConfigured: 'LOW' }, expected), /未確認/u, retry);
  assert.throws(() => verifyNativeReceipt({ ...receipt, mcpNoConfiguredMatch: false }, expected), /未確認/u, retry);
  assert.throws(() => verifyNativeReceipt({ ...receipt, tools: [] }, expected), retry);
});

test('缺少或未核的外置 preflight 不執行', async t => {
  const f = fixture(t);
  await assert.rejects(nativePreflight(process.execPath, f.tree, nativeSettings(MODEL,'HIGH'), MODEL, 'no-server'), /ENOENT/u, retry);
  const marker = join(f.dir, 'ran.txt');
  writeFileSync(join(f.dir, 'native-preflight.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'unexpected');`);
  await assert.rejects(nativePreflight(process.execPath, f.tree, nativeSettings(MODEL,'HIGH'), MODEL, 'no-server'), /不是已核來源/u, retry);
  assert.equal(existsSync(marker), false, retry);
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
    cli: process.execPath, preflight: async () => ({}),
    invoke: () => { writeFileSync(file, second); return result(response); },
  }), /未授權變動/u, retry);
  assert.equal(existsSync(f.args.outFile), false, retry);
  assert.match(JSON.parse(readFileSync(f.args.outFile + '.receipt.json')).failure, /未授權變動/u, retry);
});
