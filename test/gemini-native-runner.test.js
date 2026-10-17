import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cp, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { snapshotPinnedSources, verifyPinnedSourcesUnchanged, prepareNativePacket, prepareNativeScan, runGeminiNativeScan } from '../scripts/gemini-native-runner.js';
import { sha256 } from '../scripts/gemini-native-protocol.js';
import { FILES, MODEL } from './helpers/gemini-native-fixture.js';

test('正式入口在讀來源、認證與啟動之前拒絕；旗標與環境不能開門', () => {
  let touched = false;
  const args = new Proxy({}, { get() { touched = true; throw Error('unexpected access'); } });
  assert.throws(() => runGeminiNativeScan(args), /GEMINI_NATIVE_AUTH_POLICY_REQUIRED/);
  assert.equal(touched, false);
  const child = spawnSync(process.execPath, ['scripts/gemini-native-runner.js', '--enable', '--authorize'], {
    cwd: new URL('..', import.meta.url), env: { PATH: '/usr/bin:/bin', GEMINI_NATIVE_ENABLED: 'true' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 78); assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'GEMINI_NATIVE_AUTH_POLICY_REQUIRED\n');
});
test('來源固定檔前後核對；操作確實執行且新種內容被改時拒收', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-source-')));
  const path = join(dir, 'source.js');
  try {
    writeFileSync(path, 'synthetic-one', { mode: 0o600 });
    const pins = [{ name: 'synthetic-source', path, sha256: sha256('synthetic-one') }];
    const before = snapshotPinnedSources(pins);
    assert.deepEqual(verifyPinnedSourcesUnchanged(pins, before), before);
    writeFileSync(path, 'synthetic-two'); assert.equal(readFileSync(path, 'utf8'), 'synthetic-two');
    assert.throws(() => verifyPinnedSourcesUnchanged(pins, before));
    writeFileSync(path, 'synthetic-one');
    assert.throws(() => verifyPinnedSourcesUnchanged(pins, before), /SOURCE_CHANGED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('來源不接受符號連結、硬連結、可共同寫入檔及不符雜湊', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-source-'))), path = join(dir, 'source.js');
  const pin = p => [{ name: 'source', path: p, sha256: sha256('synthetic') }];
  try {
    writeFileSync(path, 'synthetic', { mode: 0o600 });
    symlinkSync(path, join(dir, 'link.js')); assert.throws(() => snapshotPinnedSources(pin(join(dir, 'link.js'))));
    symlinkSync(dir, join(dir, 'nested')); assert.throws(() => snapshotPinnedSources(pin(join(dir, 'nested', 'source.js'))));
    chmodSync(path, 0o622); assert.throws(() => snapshotPinnedSources(pin(path))); chmodSync(path, 0o600);
    assert.throws(() => snapshotPinnedSources([{ ...pin(path)[0], sha256: '0'.repeat(64) }]));
    linkSync(path, join(dir, 'hard.js')); assert.throws(() => snapshotPinnedSources(pin(path)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('材料 hash 與正式 findings schema 帶入完整輸入，沒有預填答案', () => {
  const text = JSON.stringify({ files: FILES, diff: 'synthetic diff', prompt: 'synthetic prompt' });
  const packet = prepareNativePacket({ text, materialSha256: sha256(text) }, { scanId: 'synthetic', model: MODEL });
  const wire = JSON.parse(packet.bytes), payload = JSON.parse(wire.message.content.split('\n').at(-2));
  assert.deepEqual(payload.material.files, FILES); assert.deepEqual(payload.schema, packet.schema);
  assert.equal(payload.binding.materialSha256, sha256(text)); assert.equal('findings' in payload, false);
  assert.match(packet.tailChallenge, /^[a-f0-9]{64}$/);
  const content = wire.message.content;
  assert.equal(content.split('\n').at(-1), `INPUT_TAIL_CHALLENGE ${packet.tailChallenge}`);
  assert.equal(content.indexOf(packet.tailChallenge), content.lastIndexOf(packet.tailChallenge));
  assert.ok(content.indexOf(packet.tailChallenge) > content.indexOf(JSON.stringify(payload)));
  assert.equal(JSON.stringify(payload).includes(packet.tailChallenge), false);
  const repeated = prepareNativePacket({ text, materialSha256: sha256(text) }, { scanId: 'synthetic', model: MODEL });
  assert.notEqual(repeated.tailChallenge, packet.tailChallenge);
  assert.equal(packet.formalScan, false);
  assert.throws(() => prepareNativePacket({ text, materialSha256: '0'.repeat(64) }, { scanId: 'synthetic', model: MODEL }));
});

test('屬性或外部設定使文字差異變成二進位摘要時拒絕準備，不把摘要說成完整 diff', () => {
  for (const diff of ['Binary files a/lib/synthetic.js and b/lib/synthetic.js differ\n', 'diff --git a/x b/x\nGIT binary patch\n', '']) {
    const text = JSON.stringify({ files: FILES, diff, prompt: 'synthetic' });
    assert.throws(() => prepareNativePacket({ text, materialSha256: sha256(text) }, { scanId: 'synthetic', model: MODEL }), /TEXT_DIFF_REQUIRED/);
  }
});

test('GN-02：直接準備入口串起來源、提供者與完整提交材料；假 Git 物件不建立或改寫 repo', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-prepare-entry-')));
  const provider = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const base = 'a'.repeat(40), head = 'b'.repeat(40), providerHead = 'c'.repeat(40);
  const promptFile = join(dir, 'prompt.txt'); writeFileSync(promptFile, 'Synthetic review only.', { mode: 0o600 });
  const pins = [{ name: 'prompt', path: promptFile, sha256: sha256(readFileSync(promptFile)) }];
  const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
  const entry = (path, text) => ({ path, text: Buffer.from(text), oid: blob(text), mode: '100644' });
  const sources = ['scripts/gemini-client.js', 'lib/is-main.js', 'scripts/grok-sandbox.sb', 'package.json'].map(path => entry(path, readFileSync(join(provider, path))));
  const before = entry('synthetic.js', 'export const value = 1;\n'), after = entry('synthetic.js', 'export const value = 2;\n');
  const tree = entries => Buffer.from(entries.map(e => `${e.mode} blob ${e.oid}\t${e.path}\0`).join(''));
  const original = cp.spawnSync;
  const calls = [];
  let dirtyProvider = false, binary = false, mutatePrompt = false;
  cp.spawnSync = (command, argv, opts) => {
    assert.equal(command, 'git');
    assert.deepEqual(Object.keys(opts.env).filter(key => key.startsWith('GIT_')), []);
    const repo = argv[2], args = argv.slice(3); calls.push({ repo, args });
    let stdout;
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') stdout = repo + '\n';
    else if (args[0] === 'rev-parse') stdout = args[2] === 'HEAD^{commit}' ? providerHead + '\n' : args[2].slice(0, 40) + '\n';
    else if (args[0] === 'status') stdout = dirtyProvider ? ' M package.json\0' : '';
    else if (args[0] === 'ls-tree') stdout = tree(repo === provider ? sources : args.at(-1) === base ? [before] : [after]);
    else if (args[0] === 'diff' && args.includes('--name-only')) stdout = 'synthetic.js\0';
    else if (args[0] === 'diff') {
      stdout = binary ? 'Binary files a/synthetic.js and b/synthetic.js differ\n' : 'diff --git a/synthetic.js b/synthetic.js\n-export const value = 1;\n+export const value = 2;\n';
      if (mutatePrompt) writeFileSync(promptFile, 'Changed after source pin.');
    } else if (args[0] === 'cat-file') {
      stdout = Buffer.concat(opts.input.toString().trim().split('\n').map(id => {
        const e = [before, after].find(x => x.oid === id); assert.ok(e);
        return Buffer.concat([Buffer.from(`${id} blob ${e.text.length}\n`), e.text, Buffer.from('\n')]);
      }));
    } else throw Error(`Unexpected fixture command ${args}`);
    return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), signal: null };
  };
  syncBuiltinESMExports();
  try {
    const args = { repo: dir, base, head, providerHead, promptFile, model: MODEL, scanId: 'direct-entry' };
    const result = prepareNativeScan(args, pins);
    assert.equal(result.preparationOnly, true); assert.equal(result.authenticationAuthorized, false);
    assert.equal(result.isolationVerified, false); assert.equal(result.files[0].path, 'synthetic.js');
    assert.equal(calls.filter(c => c.repo === provider && c.args[0] === 'status').length, 2);
    assert.ok(calls.some(c => c.args[0] === 'cat-file'));
    assert.throws(() => prepareNativeScan(args, []), /PINS/);
    dirtyProvider = true; assert.throws(() => prepareNativeScan(args, pins), /PROVIDER/); dirtyProvider = false;
    binary = true; assert.throws(() => prepareNativeScan(args, pins), /TEXT_DIFF_REQUIRED/); binary = false;
    mutatePrompt = true; assert.throws(() => prepareNativeScan(args, pins), /SOURCE/);
  } finally { cp.spawnSync = original; syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});
