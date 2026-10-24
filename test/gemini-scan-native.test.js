// 沙盒安全宣告：固定 blob 行為題的 Git 倉庫只建在 mkdtemp 內；
// 沙盒 Git 環境從零組，只給 PATH／HOME，不繼承任何 GIT_*。不碰真實帳本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import launcher from '../tools/review-launch.js';
import { prepareNativeObserver } from '../scripts/gemini-review-evidence.js';
import { nativeCommand, nativeSettings, nativePolicy, runNative } from '../scripts/gemini-review.js';
import { SCAN_TOOLS } from '../scripts/gemini-runtime-observer.js';
import { scanMaterial, scanGitBytes, prepareScan, parseScanReply, parseScanArgs, runScan, MAX_SCAN_INPUT_BYTES } from '../scripts/gemini-scan-native.js';
import { injectDirtyGitEnv, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

const MODEL = 'gemini-3.1-pro-preview', HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const template = readFileSync(new URL('../templates/scan-record.md', import.meta.url), 'utf8');
const response = `🔍 Gemini｜來源：Gemini CLI｜掃 \`${HEAD.slice(0, 7)}\`\n- 零發現\n未貼\n`;
const stats = () => ({ models: { [MODEL]: { api: { totalRequests: 1, totalErrors: 0 }, roles: { main: { totalRequests: 1, totalErrors: 0 } } } }, tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, byName: {} } });
const result = (body = response) => ({ status: 0, signal: null, stdout: JSON.stringify({ response: body, stats: stats() }), stderr: 'synthetic unique stderr\n' });
const retry = '核 scripts/gemini-scan-native.js 後跑 node --test test/gemini-scan-native.test.js';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-scan-case-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = join(dir, 'tree'), provider = join(dir, 'provider'), common = join(dir, 'common'), bundle = join(dir, 'bundle');
  for (const path of [tree, provider, common, bundle, join(tree, 'templates'), join(tree, 'scripts')]) mkdirSync(path);
  const args = { model: MODEL, effort: 'HIGH', scanTree: tree, promptFile: join(dir, 'prompt.md'), outFile: join(dir, 'output.log'), change: '736', project: 'synthetic/repo' };
  const record = { scanner: 'Gemini', source: 'Gemini CLI', reviewer: 'Grok', implementer: 'Codex', tier: '高', change: 736, head: HEAD, base: BASE, tree, root: provider, promptFile: args.promptFile, outFile: args.outFile, passCommentId: '123', passCommentLink: 'https://github.com/synthetic/repo/pull/736#issuecomment-123', startedAt: '2026-10-24T08:00:00.000Z' };
  const names = ['gemini.js', 'gemini-Q2GRYIAK.js', 'chunk-FLKY6NH5.js', 'chunk-NR7L3FXV.js', 'chunk-DPNFVVVC.js'];
  const pins = names.map(file => { const text = `throw Error('synthetic CLI must not execute: ${file}');\n`; writeFileSync(join(bundle, file), text); return { file, sha256: hash(text) }; });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', version: '0.64.0' }));
  const registration = { platform: { project: args.project }, mainBranch: 'main', participants: ['Codex', 'Grok', 'Gemini'].map(id => ({ id })), reviewers: [{ participant: 'Gemini', nativeSources: pins }], scanner: { participant: 'Gemini', tool: 'native CLI', strongest: MODEL, maxEffort: 'HIGH', source: 'Gemini CLI' } };
  writeFileSync(join(tree, 'settings.json'), JSON.stringify(registration));
  writeFileSync(join(dir, 'scan.json'), JSON.stringify(record));
  writeFileSync(join(tree, 'templates/scan-record.md'), template);
  writeFileSync(join(tree, 'source.js'), 'export const synthetic = 7;\n');
  writeFileSync(join(tree, 'scripts/gemini-runtime-observer.js'), 'export const synthetic = true;\n');
  const values = { ...record, project: args.project, change: args.change, headShort: HEAD.slice(0, 7), baseBranch: 'main', changeLink: 'https://github.com/synthetic/repo/pull/736', scanTree: tree, fullDiff: `git diff ${BASE}...${HEAD}` };
  writeFileSync(args.promptFile, launcher.fill(template, values, launcher.SCAN_FILL));
  const git = (_cwd, command) => {
    if (command[0] === 'status') return '';
    if (command[0] === 'ls-files') return 'settings.json\0templates/scan-record.md\0source.js\0scripts/gemini-runtime-observer.js\0';
    if (command[0] === 'remote') return 'https://github.com/synthetic/repo.git';
    if (command.includes('--show-toplevel')) return _cwd;
    if (command.includes('--git-common-dir')) return common;
    if (command.includes('--abbrev-ref')) return 'HEAD';
    if (command.includes('--verify')) return command.at(-1).replace(/\^\{commit\}$/u, '');
    return HEAD;
  };
  const material = () => JSON.stringify({ purpose: 'scan', base: BASE, head: HEAD, changes: [{ path: 'source.js', before: 'old', after: 'new' }] }) + '\n';
  let observed;
  const preflight = (...params) => {
    observed = prepareNativeObserver(...params);
    const events = [{ type: 'installed' }, ...['refreshAuth', 'initialize', 'request'].map(stage => ({ type: 'config', stage, configId: 1 })), { type: 'request', model: MODEL, role: 'main', configId: 1, tools: SCAN_TOOLS }];
    writeFileSync(observed.eventsFile, events.map((event, i) => JSON.stringify({ sequence: i + 1, pid: 123, purpose: 'scan', binding: observed.binding, ...event })).join('\n') + '\n');
    return observed;
  };
  return { dir, tree, provider, common, bundle, args, record, registration, values, git, material, deps: { git, material, preflight, cli: join(bundle, 'gemini.js') }, native: () => observed };
}

test('scan 設定及首行與 review 分離，完整 response 不改寫', () => {
  assert.deepEqual(nativeSettings(MODEL, 'HIGH', 'scan').tools.core, ['glob', 'grep_search', 'list_directory', 'read_file'], retry);
  assert.doesNotMatch(nativePolicy('scan'), /run_shell_command|replace|write_file/u, retry);
  const r = result();
  assert.equal(parseScanReply(r.stdout, r, { head: HEAD }, MODEL).response, response, retry);
  for (const purpose of ['', null, 'toString', 'SCAN']) assert.throws(() => nativeSettings(MODEL, 'HIGH', purpose), /用途/u, retry);
  for (const body of ['\n' + response, '尚未掃完\n' + response, '範例：\n' + response, response.replace('Gemini CLI', '其他'), response.replace('aaaaaaa', 'bbbbbbb'), response + '🤖', response + '/Users/private-person/key']) {
    const changed = result(body); assert.throws(() => parseScanReply(changed.stdout, changed, { head: HEAD }, MODEL), undefined, retry);
  }
  for (const patch of [{ status: 1 }, { signal: 'SIGTERM' }, { error: Error('failed') }]) assert.throws(() => parseScanReply(r.stdout, { ...r, ...patch }, { head: HEAD }, MODEL), /未正常完成/u, retry);
  assert.throws(() => parseScanReply('{}', r, { head: HEAD }, MODEL), /缺完整/u, retry);
  const bad = JSON.parse(r.stdout); bad.stats.models[MODEL].api.totalErrors = 1;
  assert.throws(() => parseScanReply(JSON.stringify(bad), r, { head: HEAD }, MODEL), /未完整歸屬角色/u, retry);
});

test('官方 scan 紀錄與提示逐欄核，錯來源、角色、路徑或版本不啟 CLI', t => {
  const cases = [
    ['身分', f => { f.record.scanner = 'Grok'; }], ['來源', f => { f.record.source = 'other'; }],
    ['版本', f => { f.record.head = 'c'.repeat(40); }], ['分級', f => { f.record.tier = '未知'; }],
    ['角色', f => { f.record.reviewer = 'Gemini'; }], ['角色', f => { f.record.implementer = 'Unknown'; }],
    ['通過來源', f => { f.record.passCommentLink += 'other'; }], ['準備時間', f => { f.record.startedAt = 'today'; }],
    ['路徑', f => { f.record.outFile = join(f.dir, 'other.log'); }],
  ];
  for (const [label, mutate] of cases) {
    const f = fixture(t); assert.equal(prepareScan(f.args, f.deps).purpose, 'scan');
    mutate(f); writeFileSync(join(f.dir, 'scan.json'), JSON.stringify(f.record));
    assert.throws(() => prepareScan(f.args, f.deps), undefined, label + '；' + retry);
    assert.equal(existsSync(join(f.tree, '.gemini')), false);
  }
  const f = fixture(t);
  writeFileSync(f.args.promptFile, readFileSync(f.args.promptFile, 'utf8') + 'extra');
  assert.throws(() => prepareScan(f.args, f.deps), /提示/u, retry);
  writeFileSync(join(f.dir, 'launch.json'), '{}');
  assert.throws(() => prepareScan(f.args, f.deps), /複審紀錄/u, retry);
  assert.throws(() => parseScanArgs(['toString', 'x']), /參數/u, retry);
  assert.throws(() => parseScanArgs([]), /不完整/u, retry);
});

test('本輪真靜態前置與共用收件保存掃描材料、用途及完整原件', async t => {
  const f = fixture(t), raw = result(); let called = 0;
  const got = await runScan(f.args, { ...f.deps, invoke: (_cli, args, cwd, trusted, input) => {
    called++;
    assert.equal(cwd, f.tree); assert.equal(trusted, true);
    assert.equal(args.includes('--include-directories'), false, retry);
    assert.equal(args.includes('-p'), false, retry);
    assert.equal(input, readFileSync(join(f.dir, 'scan-input.txt'), 'utf8'), retry);
    assert.ok(input.startsWith(readFileSync(f.args.promptFile, 'utf8')), retry);
    assert.match(input, /scan-material-data/u, retry);
    assert.deepEqual(JSON.parse(readFileSync(join(f.tree, '.gemini/settings.json'))).tools.core, SCAN_TOOLS, retry);
    return raw;
  } });
  assert.equal(called, 1); assert.equal(got.contentAcceptance, 'pending-human-acceptance');
  assert.equal(readFileSync(got.output, 'utf8'), response);
  assert.equal(readFileSync(got.output + '.stdout.json', 'utf8'), raw.stdout);
  assert.equal(readFileSync(got.output + '.stderr', 'utf8'), raw.stderr);
  assert.equal(existsSync(join(f.tree, '.gemini')), false);
  const receipt = JSON.parse(readFileSync(got.receipt)), evidence = JSON.parse(readFileSync(got.output + '.evidence.json'));
  assert.equal(receipt.purpose, 'scan'); assert.equal(receipt.native.purpose, 'scan'); assert.equal(evidence.purpose, 'scan');
  assert.equal(receipt.promptSha256, hash(readFileSync(f.args.promptFile)));
  assert.equal(receipt.diffSha256, hash(readFileSync(join(f.dir, 'scan-diff.json'))));
  assert.equal(receipt.inputSha256, hash(readFileSync(join(f.dir, 'scan-input.txt'))));
  assert.ok(Object.values(receipt.checks).every(row => row.status === 'passed'), retry);
  assert.ok(!evidence.requiredHumanChecks.some(value => /十九|突變/u.test(value)), retry);
});

test('錯用途與解析器不能借共用收件產生另一用途的 output', async t => {
  for (const purpose of ['unknown', null, '']) {
    const f = fixture(t), p = prepareScan(f.args, f.deps);
    await assert.rejects(runNative(f.args, p, purpose, parseScanReply, f.deps), /用途/u, retry);
    assert.equal(existsSync(join(f.tree, '.gemini')), false);
  }
  const f = fixture(t), p = prepareScan(f.args, f.deps);
  await assert.rejects(runNative(f.args, { ...p, purpose: 'review' }, 'scan', parseScanReply, f.deps), /準備結果用途/u, retry);
  await assert.rejects(runNative(f.args, p, 'scan', (...args) => ({ ...parseScanReply(...args), purpose: 'review' }), { ...f.deps, invoke: () => result() }), /完整回覆用途/u, retry);
  assert.equal(existsSync(f.args.outFile), false);
});

test('錯回覆仍保存專屬原件並做來源、設定、policy、旁錄與清理', async t => {
  const f = fixture(t), raw = result('本題獨有的前言\n' + response);
  await assert.rejects(runScan(f.args, { ...f.deps, invoke: () => raw }), /首行/u, retry);
  const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
  assert.equal(receipt.checks.reply.status, 'failed');
  for (const stage of ['inputs-final', 'source-final', 'settings-final', 'policy-final', 'evidence-reconcile', 'runtime-cleanup', 'tree-clean', 'observer-sources-final']) assert.equal(receipt.checks[stage].status, 'passed', stage + '；' + retry);
  assert.equal(readFileSync(f.args.outFile + '.stdout.json', 'utf8'), raw.stdout);
  assert.equal(readFileSync(f.args.outFile + '.stderr', 'utf8'), raw.stderr);
  assert.equal(existsSync(f.args.outFile), false); assert.equal(existsSync(join(f.tree, '.gemini')), false);
});

test('非零、缺旁錄、來源與配置漂移各留真終態，不覆蓋未知產物', async t => {
  for (const mode of ['exit', 'signal', 'events', 'purpose', 'source', 'settings', 'policy', 'pin', 'materials', 'prompt', 'record', 'unknown', 'symlink']) {
    const f = fixture(t), raw = result();
    await assert.rejects(runScan(f.args, { ...f.deps, invoke: () => {
      if (mode === 'exit') raw.status = 9;
      if (mode === 'signal') raw.signal = 'SIGTERM';
      if (mode === 'events') writeFileSync(f.native().eventsFile, '');
      if (mode === 'purpose') writeFileSync(f.native().eventsFile, readFileSync(f.native().eventsFile, 'utf8').replaceAll('"purpose":"scan"', '"purpose":"review"'));
      if (mode === 'source') writeFileSync(join(f.tree, 'source.js'), 'different');
      if (mode === 'settings') writeFileSync(join(f.tree, '.gemini/settings.json'), '{"changed":true}');
      if (mode === 'policy') writeFileSync(join(f.dir, 'gemini-policy.toml'), 'changed');
      if (mode === 'pin') writeFileSync(join(f.bundle, 'gemini.js'), 'changed');
      if (mode === 'prompt') writeFileSync(f.args.promptFile, 'different-prompt');
      if (mode === 'record') writeFileSync(join(f.dir, 'scan.json'), JSON.stringify({ ...f.record, head: 'c'.repeat(40) }));
      if (mode === 'materials') writeFileSync(join(f.dir, 'scan-diff.json'), 'changed');
      if (mode === 'unknown') writeFileSync(join(f.tree, '.gemini/unknown'), 'keep-this-case');
      if (mode === 'symlink') { const path = join(f.tree, '.gemini/settings.json'); writeFileSync(join(f.dir, 'preserve-settings'), readFileSync(path)); unlinkSync(path); symlinkSync(join(f.dir, 'preserve-settings'), path); }
      return raw;
    } }), undefined, mode + '；' + retry);
    const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
    assert.ok(receipt.failures.length > 0, mode + '；' + retry);
    assert.equal(receipt.status, raw.status); assert.equal(receipt.signal, raw.signal);
    assert.equal(readFileSync(f.args.outFile + '.stdout.json', 'utf8'), raw.stdout);
    assert.equal(readFileSync(f.args.outFile + '.stderr', 'utf8'), raw.stderr);
    assert.equal(existsSync(f.args.outFile), false);
    if (mode === 'unknown') { assert.equal(readFileSync(join(f.tree, '.gemini/unknown'), 'utf8'), 'keep-this-case'); assert.equal(receipt.checks['runtime-cleanup'].status, 'failed'); }
    if (mode === 'symlink') assert.equal(existsSync(join(f.dir, 'preserve-settings')), true);
  }
});

test('stdin 實際傳遞大於命令列大小的完整資料，掃描輸入超限先拒絕', t => {
  const input = '測'.repeat(120000);
  const actual = nativeCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], ROOT, false, input);
  assert.equal(actual.status, 0); assert.equal(actual.stdout, input, retry);
  const f = fixture(t);
  assert.throws(() => prepareScan(f.args, { ...f.deps, material: () => 'x'.repeat(MAX_SCAN_INPUT_BYTES) }), /組合輸入超限/u, retry);
  assert.equal(existsSync(join(f.tree, '.gemini')), false);
});

test('原始 blob 材料不受 -diff 或外部驅動遮蔽，二進位另列未掃', t => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-blob-repo-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  const git = (...args) => { const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid'); git('config', 'core.hooksPath', join(dir, 'no-hooks'));
  writeFileSync(join(dir, '.gitattributes'), 'masked.txt -diff\nfiltered.txt diff=synthetic\n');
  writeFileSync(join(dir, 'masked.txt'), 'before-secret-free\n'); writeFileSync(join(dir, 'filtered.txt'), 'filter-before\n'); writeFileSync(join(dir, 'binary.bin'), Buffer.from([0, 1, 2]));
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic base'); const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'masked.txt'), '\ufeffafter-secret-free\n'); writeFileSync(join(dir, 'filtered.txt'), 'filter-after\n'); writeFileSync(join(dir, 'binary.bin'), Buffer.from([0, 3, 4]));
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic head'); const head = git('rev-parse', 'HEAD');
  const marker = join(dir, 'should-not-execute');
  git('config', 'diff.synthetic.textconv', 'touch ' + marker); git('config', 'diff.synthetic.command', 'touch ' + marker);
  const material = JSON.parse(scanMaterial(dir, base, head));
  assert.equal(material.mergeBase, base); assert.equal(material.head, head);
  const masked = material.changes.find(row => row.path === 'masked.txt'), filtered = material.changes.find(row => row.path === 'filtered.txt'), binary = material.changes.find(row => row.path === 'binary.bin');
  assert.equal(masked.before.text, 'before-secret-free\n'); assert.equal(masked.after.text, '\ufeffafter-secret-free\n');
  assert.equal(filtered.after.text, 'filter-after\n'); assert.equal(existsSync(marker), false);
  assert.equal(binary.textScanned, false); assert.equal(binary.after.kind, 'non-text'); assert.equal(Object.hasOwn(binary.after, 'text'), false);
  const restore = injectDirtyGitEnv();
  try { assert.equal(scanGitBytes(dir, ['rev-parse', '--show-toplevel']).toString().trim(), realpathSync(dir), retry); } finally { restore(); }
});

test('固定 blob 子行程直接看見乾淨整族 Git 環境', () => {
  assertChildGitEnvClean(assert, 'scanGitBytes', () => scanGitBytes(ROOT, ['status']));
});


test('準備後且預載前的紀錄或提示漂移，不能被新的 binding 吸收', async t => {
  for (const target of ['record', 'prompt']) {
    const f = fixture(t);
    await assert.rejects(runScan(f.args, { ...f.deps, preflight: (...params) => {
      if (target === 'record') writeFileSync(join(f.dir, 'scan.json'), JSON.stringify({ ...f.record, head: 'c'.repeat(40) }));
      else writeFileSync(f.args.promptFile, 'synthetic changed before binding');
      return f.deps.preflight(...params);
    }, invoke: () => result() }), /未授權變動/u, retry);
    const receipt = JSON.parse(readFileSync(f.args.outFile + '.receipt.json'));
    assert.equal(receipt.checks['inputs-final'].status, 'failed');
    assert.equal(receipt.checks['observer-sources-final'].status, 'passed');
    assert.equal(existsSync(f.args.outFile), false);
  }
});

test('差異材料對原始大小、JSON 展開與非 UTF-8 分別處理', () => {
  const blob = 'd'.repeat(40), before = '0'.repeat(40);
  const fake = data => (_tree, args) => {
    if (args[0] === 'merge-base') return Buffer.from(BASE + '\n');
    if (args[0] === 'diff-tree') return Buffer.from(`:000000 100644 ${before} ${blob} A\0synthetic.bin\0`);
    assert.equal(args[0], 'cat-file'); return data;
  };
  assert.throws(() => scanMaterial('/synthetic', BASE, HEAD, fake(Buffer.alloc(MAX_SCAN_INPUT_BYTES + 1))), /原始材料超限/u, retry);
  assert.throws(() => scanMaterial('/synthetic', BASE, HEAD, fake(Buffer.alloc(MAX_SCAN_INPUT_BYTES / 2, 1))), /差異材料超限/u, retry);
  const invalid = JSON.parse(scanMaterial('/synthetic', BASE, HEAD, fake(Buffer.from([255, 254]))));
  assert.equal(invalid.changes[0].textScanned, false);
  assert.equal(invalid.changes[0].after.kind, 'non-text');
});

test('核實官方紀錄與掃描設定時，提示同步變動也不能替壞欄位背書', t => {
  const cases = [
    ['身分', f => { f.record.scanner = 'Claude'; }],
    ['身分', f => { f.record.source = 'other'; f.registration.scanner.source = 'other'; }],
    ['版本或分級', f => { f.record.base = 'not-sha'; }],
    ['版本或分級', f => { f.record.tier = '未知'; }],
    ['角色', f => { f.record.reviewer = 'Gemini'; }],
    ['通過來源', f => { f.record.passCommentLink = 'https://github.com/synthetic/repo/pull/1#issuecomment-123'; }],
    ['準備時間', f => { f.record.startedAt = 'invalid'; }],
    ['設定未登記', f => { f.registration.scanner.strongest = 'other'; }],
  ];
  for (const [message, mutate] of cases) {
    const f = fixture(t); mutate(f);
    writeFileSync(join(f.tree, 'settings.json'), JSON.stringify(f.registration));
    writeFileSync(join(f.dir, 'scan.json'), JSON.stringify(f.record));
    writeFileSync(f.args.promptFile, launcher.fill(template, { ...f.values, ...f.record, change: f.args.change }, launcher.SCAN_FILL));
    assert.throws(() => prepareScan(f.args, f.deps), new RegExp(message, 'u'), retry);
  }
});


test('掃描樹與來源的根目錄、共用庫、detached、乾淨及物件逐項核對', t => {
  const cases = [
    ['來源根目錄', (f, cwd, args) => cwd === f.provider && args.includes('--show-toplevel') ? f.tree : undefined],
    ['遠端', (_f, _cwd, args) => args[0] === 'remote' ? 'https://github.com/other/repo.git' : undefined],
    ['掃描樹不是根目錄', (f, cwd, args) => cwd === f.tree && args.includes('--show-toplevel') ? f.provider : undefined],
    ['不屬同一倉庫', (f, cwd, args) => cwd === f.tree && args.includes('--git-common-dir') ? f.provider : undefined],
    ['掃描樹版本', (_f, _cwd, args) => args.join(' ') === 'rev-parse HEAD' ? 'c'.repeat(40) : undefined],
    ['未固定版本', (_f, _cwd, args) => args.includes('--abbrev-ref') ? 'branch' : undefined],
    ['不乾淨', (_f, _cwd, args) => args[0] === 'status' ? ' M source.js' : undefined],
    ['版本不存在', (_f, _cwd, args) => args.includes('--verify') ? 'c'.repeat(40) : undefined],
  ];
  for (const [message, fake] of cases) {
    const f = fixture(t);
    assert.throws(() => prepareScan(f.args, { ...f.deps, git: (cwd, args) => fake(f, cwd, args) ?? f.git(cwd, args) }), new RegExp(message, 'u'), retry);
  }
  const f = fixture(t), alternate = join(f.dir, 'alternate.md');
  writeFileSync(alternate, readFileSync(f.args.promptFile)); f.args.promptFile = alternate; f.record.promptFile = alternate;
  writeFileSync(join(f.dir, 'scan.json'), JSON.stringify(f.record));
  assert.throws(() => prepareScan(f.args, f.deps), /官方掃描路徑/u, retry);
});

test('本輪既有輸出與 Gemini 設定不能被準備入口接管', t => {
  for (const mode of ['output', 'runtime']) {
    const f = fixture(t);
    if (mode === 'output') writeFileSync(f.args.outFile, 'keep-own-output');
    else mkdirSync(join(f.tree, '.gemini'));
    assert.throws(() => prepareScan(f.args, f.deps), /已存在|已有 Gemini 配置/u, retry);
    if (mode === 'output') assert.equal(readFileSync(f.args.outFile, 'utf8'), 'keep-own-output');
  }
});
