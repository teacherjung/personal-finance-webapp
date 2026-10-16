// 合成 Git 物件、假認證／canary、真 localhost relay；沒有 git init 或真服務呼叫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildScanMaterials, verifyProvider, runGeminiScan, parseScanArgs, runGit } from '../scripts/gemini-scan.js';
import { startGeminiRelay } from '../scripts/gemini-relay.js';
import { killGroupAndWait, escapeForms, readSessionsOnce, shapeMatchesIn } from '../scripts/grok-scan.js';

const base = 'a'.repeat(40), head = 'b'.repeat(40), providerHead = 'c'.repeat(40), model = 'gemini-test-pro';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const blob = (s) => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const source = fileURLToPath(new URL('..', import.meta.url));
const entry = (path, text, mode = '100644') => ({ path, mode, oid: blob(text), text });
const listing = (entries) => Buffer.from(entries.map(e => `${e.mode} blob ${e.oid}\t${e.path}\0`).join(''));
const privateValue = 'SYNTHETIC-PRIVATE-"TOKEN"-\\VALUE';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gemini-scan-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provider = join(root, 'provider'), repo = join(root, 'repo'), liveRoot = join(root, 'live'), boxRoot = join(root, 'boxes');
  for (const p of [provider, repo, liveRoot, boxRoot]) mkdirSync(p);
  const providerEntries = ['scripts/gemini-client.js', 'lib/is-main.js', 'scripts/grok-sandbox.sb'].map(path => entry(path, readFileSync(join(source, path))));
  providerEntries.push(entry('package.json', '{"type":"module"}\n'));
  for (const e of providerEntries) { mkdirSync(dirname(join(provider, e.path)), { recursive: true }); writeFileSync(join(provider, e.path), e.text, { mode: 0o644 }); }
  const before = [entry('a.js', 'export const value = 1;\n')], after = [entry('a.js', 'export const value = 2;\n')];
  const state = { before, after, paths: ['a.js'], diff: 'diff --git a/a.js b/a.js\n-export const value = 1;\n+export const value = 2;\n', dirty: false, wrongHead: false, calls: [], childCount: 0, canaryCount: 0, authCount: 0, upstreamCount: 0, sweepCount: 0, readCount: 0, envObserved: false, killed: 0, ports: [], prompt: '只分析提供的靜態材料。' };
  const git = (where, args, input) => {
    state.calls.push({ where, args, input });
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return Buffer.from(where + '\n');
    if (args[0] === 'rev-parse') return Buffer.from((where === provider ? (state.wrongHead ? head : providerHead) : args.at(-1).slice(0, 40)) + '\n');
    if (args[0] === 'status') return Buffer.from(state.dirty ? ' M a.js\0' : '');
    if (args[0] === 'ls-tree') return listing(where === provider ? providerEntries : args.includes(base) ? state.before : state.after);
    if (args[0] === 'diff') return Buffer.from(args.includes('--name-only') ? state.paths.join('\0') + '\0' : state.diff);
    if (args[0] === 'cat-file' && args.includes('--batch')) {
      const entries = [...state.before, ...state.after];
      return Buffer.concat(input.toString().trim().split('\n').filter(Boolean).flatMap(oid => {
        const e = entries.find(x => x.oid === oid); assert.ok(e);
        return [Buffer.from(`${oid} blob ${Buffer.byteLength(e.text)}\n`), Buffer.from(e.text), Buffer.from('\n')];
      }));
    }
    throw new Error('unexpected synthetic git command');
  };
  const promptFile = join(root, 'prompt.txt'), outFile = join(root, 'out.json'); writeFileSync(promptFile, state.prompt);
  const args = { repo, base, head, promptFile, outFile, model, providerHead, clientSourceRoot: join(root, 'public-client-source') };
  const deps = {
    providerRoot: provider, git, liveRoot, boxRoot, wallMs: 5000, processCount: () => 2,
    loadAuth: async () => { state.authCount += 1; return { project: 'fake-project', getAccessToken: async () => privateValue, dlpNeedles: () => [privateValue, 'fake-project'], quota: () => [{ modelId: model, remainingFraction: 0.5 }] }; },
    runCanary: async (box, options) => { state.canaryCount += 1; state.ports.push(options.relayPort); assert.ok(existsSync(box)); return { code: 0, lines: ['synthetic canary only'] }; },
    startRelay: (cfg) => { state.ports.push(cfg.port); return startGeminiRelay(cfg, { transport: async () => { state.upstreamCount += 1; return { statusCode: 200, body: Buffer.from(JSON.stringify({ response: { modelVersion: model, candidates: [{ content: { role: 'model', parts: [{ text: '合成掃描回答。' }] }, finishReason: 'STOP' }] } })) }; } }); },
    spawn: (file, argv, options) => {
      state.childCount += 1;
      assert.equal(file, '/bin/sh'); assert.match(argv[1], /ulimit -f 65536 -u 258 -t 1800/); assert.match(argv[1], /exec \/usr\/bin\/sandbox-exec/);
      assert.equal(options.detached, true); assert.equal(options.env.HOME, options.cwd); assert.equal(options.env.TMPDIR, join(options.cwd, 'tmp'));
      assert.equal(argv[argv.indexOf('-f') + 1].endsWith('/scripts/grok-sandbox.sb'), true);
      assert.equal(JSON.stringify({ argv, env: options.env }).includes(privateValue), false);
      assert.equal(JSON.stringify({ argv, env: options.env }).includes('fake-project'), false);
      assert.deepEqual(readdirSync(options.cwd).sort(), ['lib', 'manifest.json', 'materials.txt', 'package.json', 'results', 'scripts', 'tmp']);
      assert.deepEqual(readdirSync(join(options.cwd, 'scripts')), ['gemini-client.js']);
      assert.ok(argv.includes(`RELAY_PORT=${state.ports[0]}`));
      const at = argv.indexOf(process.execPath); assert.ok(at > 0);
      const script = argv[at + 1], childArgs = argv.slice(at + 2);
      const wrapper = `if(process.env.SYNTHETIC_PARENT_SECRET||Object.keys(process.env).some(k=>k.startsWith('GIT_')))process.exit(91);console.log('SYNTHETIC-ENV-OK');await import('node:url').then(async({pathToFileURL})=>{await import(pathToFileURL(process.argv[1]).href)});`;
      const p = spawn(process.execPath, ['--input-type=module', '-e', wrapper, script, ...childArgs], options);
      p.stdout.on('data', d => { if (String(d).includes('SYNTHETIC-ENV-OK')) state.envObserved = true; });
      assert.equal(readdirSync(liveRoot).length, 1);
      return p;
    },
    killGroupAndWait: async (pid) => { state.killed += 1; await killGroupAndWait(pid); },
    sweepEscapees: () => { state.sweepCount += 1; return 0; },
  };
  return { root, provider, repo, liveRoot, boxRoot, providerEntries, state, git, args, deps };
}

test('固定材料使用完整 diff 及 changed path 前後 Git blob，不讀工作檔', (t) => {
  const f = fixture(t); writeFileSync(join(f.repo, 'a.js'), 'UNCOMMITTED-DO-NOT-SEND');
  const m = buildScanMaterials(f.args, { git: f.git });
  const parsed = JSON.parse(m.text);
  assert.equal(parsed.files[0].before.text, f.state.before[0].text); assert.equal(parsed.files[0].after.text, f.state.after[0].text);
  assert.equal(parsed.diff, f.state.diff); assert.equal(parsed.prompt, f.state.prompt); assert.equal(parsed.providerHead, providerHead);
  assert.doesNotMatch(m.text, /UNCOMMITTED/); assert.match(parsed.scope, /未.*執行考題/);
  assert.equal(m.materialSha256, hash(m.text)); assert.equal(m.materialBytes, Buffer.byteLength(m.text));
  const diffCalls = f.state.calls.filter(c => c.args[0] === 'diff');
  assert.ok(diffCalls.every(c => c.args.includes('--no-ext-diff') && c.args.includes('--no-textconv') && c.args.includes('--no-renames')));
});

test('固定材料拒二進位、非 regular、禁路徑、超量及缺漏', (t) => {
  for (const change of [
    f => { f.state.after[0] = entry('a.js', Buffer.from([0, 0xff])); },
    f => { f.state.after[0] = entry('a.js', Buffer.from([0, 65])); },
    f => { f.state.after[0].mode = '120000'; },
    f => { f.state.paths = ['data/store.json']; f.state.after = [entry('data/store.json', '{}')]; },
    f => { f.state.after[0] = entry('a.js', 'x'.repeat(4 * 1024 * 1024)); },
    f => { f.state.paths = ['missing.js']; },
  ]) { const f = fixture(t); change(f); assert.throws(() => buildScanMaterials(f.args, { git: f.git }), /GEMINI_SCAN_/); }
});

test('provider 核真 HEAD、clean、每個 tracked blob bytes 與 mode', (t) => {
  const f = fixture(t), good = verifyProvider(f.provider, providerHead, { git: f.git });
  assert.equal(good.files.length, f.providerEntries.length);
  f.state.wrongHead = true; assert.throws(() => verifyProvider(f.provider, providerHead, { git: f.git }), /PROVIDER/); f.state.wrongHead = false;
  f.state.dirty = true; assert.throws(() => verifyProvider(f.provider, providerHead, { git: f.git }), /PROVIDER/); f.state.dirty = false;
  const path = join(f.provider, 'package.json');
  chmodSync(path, 0o755); assert.throws(() => verifyProvider(f.provider, providerHead, { git: f.git }), /PROVIDER/); chmodSync(path, 0o644);
  writeFileSync(path, '{}'); assert.throws(() => verifyProvider(f.provider, providerHead, { git: f.git }), /PROVIDER/);
});

test('runner 正面全鏈：同 port、env 實收、活假機密、單次結果與清理', async (t) => {
  const f = fixture(t), previous = process.env.SYNTHETIC_PARENT_SECRET;
  process.env.SYNTHETIC_PARENT_SECRET = privateValue;
  let result; try { result = await runGeminiScan(f.args, f.deps); } finally { if (previous === undefined) delete process.env.SYNTHETIC_PARENT_SECRET; else process.env.SYNTHETIC_PARENT_SECRET = previous; }
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(f.state.canaryCount, 1); assert.equal(f.state.authCount, 1); assert.equal(f.state.upstreamCount, 1); assert.equal(f.state.childCount, 1); assert.equal(f.state.envObserved, true);
  assert.equal(f.state.ports[0], f.state.ports[1]); assert.ok(f.state.killed >= 1); assert.equal(f.state.sweepCount, 1);
  assert.equal(readdirSync(f.boxRoot).length, 0); assert.equal(readdirSync(f.liveRoot).length, 0);
  const bytes = readFileSync(f.args.outFile); assert.equal(JSON.parse(bytes).reply, '合成掃描回答。');
  assert.equal(result.receipt.outputSha256, hash(bytes));
  const receipt = readFileSync(f.args.outFile + '.receipt.json', 'utf8');
  assert.doesNotMatch(receipt, /SYNTHETIC-PRIVATE|fake-project|\/private\/|\/Users\//);
  assert.equal(result.receipt.materialScope, '完整 diff、每個 changed path 的前後文字與提示；未在盒內執行考題');
});

test('runner canary、quota、DLP 無針失敗都不生成', async (t) => {
  for (const edit of [
    f => { f.deps.runCanary = async () => ({ code: 1, lines: [privateValue] }); },
    f => { f.deps.loadAuth = async () => { throw new Error(privateValue); }; },
    f => { const orig = f.deps.loadAuth; f.deps.loadAuth = async () => ({ ...await orig(), quota: () => [{ modelId: model, remainingFraction: 0 }] }); },
    f => { const orig = f.deps.loadAuth; f.deps.loadAuth = async () => ({ ...await orig(), quota: () => [{ modelId: 'gemini-other', remainingFraction: 1 }] }); },
    f => { const orig = f.deps.loadAuth; f.deps.loadAuth = async () => ({ ...await orig(), dlpNeedles: () => [] }); },
    f => { writeFileSync(f.args.promptFile, privateValue); },
  ]) { const f = fixture(t); edit(f); const result = await runGeminiScan(f.args, f.deps); assert.notEqual(result.code, 0); assert.equal(f.state.childCount, 0); assert.equal(f.state.upstreamCount, 0); assert.equal(existsSync(f.args.outFile), false); assert.equal(JSON.stringify(result).includes(privateValue), false); }
});

test('runner 非0、timeout、relay 拒絕與 provider 後改皆不得成功', async (t) => {
  for (const mode of ['nonzero', 'timeout', 'relay', 'provider']) {
    const f = fixture(t), original = f.deps.spawn;
    if (mode === 'nonzero') f.deps.spawn = (_file, _argv, options) => spawn(process.execPath, ['-e', 'process.exit(7)'], options);
    if (mode === 'timeout') { f.deps.wallMs = 30; f.deps.spawn = (_file, _argv, options) => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options); }
    if (mode === 'relay') { const start = f.deps.startRelay; f.deps.startRelay = async cfg => { const r = await start(cfg); return { ...r, snapshot: () => ({ ...r.snapshot(), failed: true, reason: 'SYNTHETIC' }) }; }; }
    if (mode === 'provider') f.deps.spawn = (...a) => { const p = original(...a); p.once('close', () => writeFileSync(join(f.provider, 'package.json'), '{}')); return p; };
    const result = await runGeminiScan(f.args, f.deps); assert.notEqual(result.code, 0); assert.equal(existsSync(f.args.outFile), false); assert.equal(readdirSync(f.liveRoot).length, 0);
  }
});

test('runner 輸出 DLP 每層表示及新 refresh 針都拒絕，不保存 hash 或原值', async (t) => {
  for (const secret of escapeForms(privateValue)) {
    const f = fixture(t), original = f.deps.spawn;
    f.deps.spawn = (...args) => { const p = original(...args); p.stdout.on('data', () => {}); return p; };
    f.deps.startRelay = cfg => startGeminiRelay(cfg, { transport: async () => ({ statusCode: 200, body: Buffer.from(JSON.stringify({ response: { modelVersion: model, candidates: [{ content: { role: 'model', parts: [{ text: secret }] }, finishReason: 'STOP' }] } })) }) });
    const result = await runGeminiScan(f.args, f.deps); assert.notEqual(result.code, 0); assert.equal(existsSync(f.args.outFile), false); assert.equal(JSON.stringify(result).includes(hash(secret)), false); assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('runner 單趟 reader、產物改動、symlink 與既有輸出檔保護', async (t) => {
  for (const mode of ['extra', 'symlink', 'changed', 'existing']) {
    const f = fixture(t), original = f.deps.spawn;
    if (mode === 'existing') writeFileSync(f.args.outFile, 'keep');
    else f.deps.spawn = (...args) => { const p = original(...args), box = args[2].cwd; p.once('close', () => {
      const output = join(box, 'results', 'result.json');
      if (mode === 'extra') writeFileSync(join(box, 'results', 'extra.json'), '{}');
      if (mode === 'changed') writeFileSync(output, '{}');
      if (mode === 'symlink') { rmSync(output); symlinkSync(f.args.promptFile, output); }
    }); return p; };
    const result = await runGeminiScan(f.args, f.deps); assert.notEqual(result.code, 0);
    if (mode === 'existing') assert.equal(readFileSync(f.args.outFile, 'utf8'), 'keep'); else assert.equal(existsSync(f.args.outFile), false);
  }
});

test('runner CLI 只收必要固定選項，不接受依賴或替代端點', () => {
  const args = ['--repo', 'r', '--base', base, '--head', head, '--prompt', 'p', '--out', 'o', '--model', model, '--provider-head', providerHead];
  assert.equal(parseScanArgs(args).providerHead, providerHead);
  for (const bad of [args.slice(0, -2), [...args, '--endpoint', 'http://x'], [...args, '--model', model], [...args, '--profile', 'x']]) assert.throws(() => parseScanArgs(bad), /ARGS/);
  assert.equal(typeof runGit, 'function');
});

function afterChild(f, action) {
  const original = f.deps.spawn;
  f.deps.spawn = (...args) => { const p = original(...args); p.once('close', () => action(p, args[2].cwd)); return p; };
}

test('runner 真針與非法 UTF-8 同存仍算事故，含 stdout、stderr 與結果 bytes', async (t) => {
  for (const channel of ['stdout', 'stderr', 'result']) {
    const f = fixture(t);
    afterChild(f, (p, box) => {
      const bytes = Buffer.concat([Buffer.from(privateValue), Buffer.from([0xff])]);
      if (channel === 'result') writeFileSync(join(box, 'results/result.json'), bytes);
      else p[channel].emit('data', bytes);
    });
    const r = await runGeminiScan(f.args, f.deps); assert.equal(r.code, 1, channel); assert.equal(existsSync(f.args.outFile), false);
    assert.equal(JSON.stringify(r).includes(privateValue), false); assert.equal(JSON.stringify(r).includes(hash(privateValue)), false);
  }
});

test('runner 已識別事故不被 cleanup、provider 或 signal 未完成理由洗成 code2', async (t) => {
  for (const cause of ['cleanup', 'provider', 'signal']) {
    const f = fixture(t);
    afterChild(f, (p) => p.stdout.emit('data', Buffer.from(privateValue)));
    if (cause === 'cleanup') { const original = f.deps.startRelay; f.deps.startRelay = async cfg => { const r = await original(cfg); let closed = 0; return { ...r, close: async () => { await r.close(); if (++closed > 1) throw new Error('synthetic cleanup'); } }; }; }
    if (cause === 'provider') afterChild(f, () => writeFileSync(join(f.provider, 'package.json'), '{}'));
    if (cause === 'signal') f.deps.readSessionsOnce = (...a) => { const snap = readSessionsOnce(...a); process.emit('SIGTERM'); return snap; };
    const r = await runGeminiScan(f.args, f.deps); assert.equal(r.code, 1, cause); assert.equal(existsSync(f.args.outFile), false);
  }
});

test('runner 空目錄也違反單檔協定，名字含真針仍是事故', async (t) => {
  for (const name of ['extra-directory', 'SYNTHETIC-NEW-DIRECTORY-SECRET']) {
    const f = fixture(t), original = f.deps.loadAuth;
    f.deps.loadAuth = async () => { const a = await original(); return { ...a, dlpNeedles: () => [...a.dlpNeedles(), 'SYNTHETIC-NEW-DIRECTORY-SECRET'] }; };
    afterChild(f, (_p, box) => mkdirSync(join(box, 'results', name)));
    const r = await runGeminiScan(f.args, f.deps);
    if (name.startsWith('SYNTHETIC')) assert.equal(r.code, 1); else assert.notEqual(r.code, 0);
    assert.equal(existsSync(f.args.outFile), false);
  }
});

test('runner timeout／output size 終止與 close0 競態不能回報成功', async (t) => {
  for (const cause of ['timeout', 'output']) {
    const f = fixture(t), original = f.deps.spawn; let proxy, realPid, completed = false, killObserved = false;
    f.deps.wallMs = 350;
    f.deps.spawn = (...args) => {
      const child = original(...args); realPid = child.pid;
      proxy = new EventEmitter(); proxy.pid = child.pid; proxy.stdout = child.stdout; proxy.stderr = child.stderr;
      child.once('error', e => proxy.emit('error', e));
      child.once('close', code => { assert.equal(code, 0); completed = true; if (cause === 'output') proxy.stdout.emit('data', Buffer.alloc(8 * 1024 * 1024 + 1, 65)); });
      return proxy;
    };
    f.deps.killGroupAndWait = async pid => {
      if (proxy && pid === realPid && !killObserved) { killObserved = true; assert.equal(completed, true); proxy.emit('close', 0, null); await new Promise(ok => setTimeout(ok, 15)); }
      await killGroupAndWait(pid);
    };
    const r = await runGeminiScan(f.args, f.deps); assert.equal(killObserved, true); assert.equal(r.code, 2, cause); assert.equal(existsSync(f.args.outFile), false);
  }
});

test('runner refresh 後新私值與 live 假機密都列入比針', async (t) => {
  for (const mode of ['refreshed', 'live']) {
    const f = fixture(t), needles = [privateValue, 'fake-project'], fresh = 'SYNTHETIC-REFRESH-NEW-SECRET';
    f.deps.loadAuth = async () => ({ project: 'fake-project', getAccessToken: async () => { needles.push(fresh); return privateValue; }, dlpNeedles: () => [...needles], quota: () => [{ modelId: model, remainingFraction: 1 }] });
    afterChild(f, p => { const value = mode === 'refreshed' ? fresh : readFileSync(join(f.liveRoot, readdirSync(f.liveRoot)[0], 'store.db'), 'utf8').trim(); p.stderr.emit('data', Buffer.from(value)); });
    const r = await runGeminiScan(f.args, f.deps); assert.equal(r.code, 1); assert.equal(existsSync(f.args.outFile), false);
  }
});

test('runner 單趟讀取後檔案變動不改已驗 bytes，結果不可覆寫', async (t) => {
  const f = fixture(t); let count = 0, verified;
  f.deps.readSessionsOnce = (...args) => { count += 1; const snap = readSessionsOnce(...args); verified = Buffer.from(snap.files.get('result.json')); writeFileSync(join(args[0], 'result.json'), 'CHANGED-AFTER-READ'); return snap; };
  const r = await runGeminiScan(f.args, f.deps); assert.equal(r.code, 0); assert.equal(count, 1); assert.ok(readFileSync(f.args.outFile).equals(verified));
});

test('runner 超量輸出與跨 chunk 真針仍優先事故，不保留部分結果', async (t) => {
  for (const mode of ['over-cap', 'split']) {
    const f = fixture(t);
    afterChild(f, p => {
      if (mode === 'over-cap') p.stderr.emit('data', Buffer.concat([Buffer.alloc(8 * 1024 * 1024 + 1, 65), Buffer.from(privateValue), Buffer.from([0xff])]));
      else { p.stdout.emit('data', Buffer.from(privateValue.slice(0, 13))); p.stdout.emit('data', Buffer.from(privateValue.slice(13))); }
    });
    const r = await runGeminiScan(f.args, f.deps); assert.equal(r.code, 1); assert.equal(existsSync(f.args.outFile), false);
  }
});

test('runner 引用已提供公開假 key 形狀可通過，新形狀仍算事故', async (t) => {
  for (const known of [true, false]) {
    const f = fixture(t), shape = '"flexToken": "12345678901234567890123456789012"';
    assert.ok(shapeMatchesIn(shape).length > 0);
    if (known) f.state.after = [entry('a.js', `// public synthetic fixture\n${shape}\n`)];
    f.deps.startRelay = cfg => { f.state.ports.push(cfg.port); return startGeminiRelay(cfg, { transport: async () => ({ statusCode: 200, body: Buffer.from(JSON.stringify({ response: { modelVersion: model, candidates: [{ content: { role: 'model', parts: [{ text: shape }] }, finishReason: 'STOP' }] } })) }) }); };
    const r = await runGeminiScan(f.args, f.deps); assert.equal(r.code, known ? 0 : 1, JSON.stringify(r));
  }
});

test('runner 真私值即使已在材料也不當公開形狀排除', async (t) => {
  const f = fixture(t), secret = '"flexToken": "12345678901234567890123456789012"', original = f.deps.loadAuth;
  f.state.after = [entry('a.js', secret)];
  f.deps.loadAuth = async () => { const a = await original(); return { ...a, dlpNeedles: () => [...a.dlpNeedles(), secret] }; };
  const r = await runGeminiScan(f.args, f.deps); assert.equal(r.code, 1); assert.equal(f.state.childCount, 0);
});

test('runner 可信 relay 與檔案逐項綁定，材料被改與清理失敗均拒絕', async (t) => {
  for (const mode of ['valid-forged-result', 'materials', 'manifest', 'sweep', 'kill', 'invalid-utf8']) {
    const f = fixture(t);
    if (mode === 'sweep') f.deps.sweepEscapees = (_box, log) => { log('synthetic failed sweep'); return 0; };
    else if (mode === 'kill') f.deps.killGroupAndWait = async () => { throw new Error(privateValue); };
    else afterChild(f, (_p, box) => {
      if (mode === 'valid-forged-result') { const path = join(box, 'results/result.json'), r = JSON.parse(readFileSync(path)); r.reply = 'forged'; r.replySha256 = hash(r.reply); writeFileSync(path, JSON.stringify(r) + '\n'); }
      if (mode === 'materials') writeFileSync(join(box, 'materials.txt'), 'changed');
      if (mode === 'manifest') writeFileSync(join(box, 'manifest.json'), '{}');
      if (mode === 'invalid-utf8') writeFileSync(join(box, 'results/result.json'), Buffer.from([0xff]));
    });
    const r = await runGeminiScan(f.args, f.deps); assert.equal(r.code, 2, mode); assert.equal(existsSync(f.args.outFile), false); assert.equal(JSON.stringify(r).includes(privateValue), false);
  }
});

test('runner runGit 實際子程序收乾淨 Git 家族環境與固定 repo 參數', (t) => {
  const f = fixture(t), bin = join(f.root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),git:Object.keys(process.env).filter(k=>k.startsWith('GIT_'))}));\n`, { mode: 0o755 });
  const keys = ['PATH', 'GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_UNKNOWN_FUTURE_VARIABLE'], old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    process.env.PATH = bin + ':' + process.env.PATH; process.env.GIT_DIR = '/synthetic/wrong'; process.env.GIT_CONFIG_COUNT = '42'; process.env.GIT_UNKNOWN_FUTURE_VARIABLE = 'synthetic';
    const result = JSON.parse(runGit(f.repo, ['rev-parse', '--show-toplevel']));
    assert.deepEqual(result.git, []); assert.deepEqual(result.args, ['--no-replace-objects', '-C', f.repo, 'rev-parse', '--show-toplevel']);
  } finally { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
});

test('runner 材料事故尚未起 child 時也不能被清理錯誤覆蓋', async (t) => {
  const f = fixture(t); writeFileSync(f.args.promptFile, privateValue);
  f.deps.killGroupAndWait = async () => { throw new Error('synthetic cleanup'); };
  const r = await runGeminiScan(f.args, f.deps); assert.equal(r.code, 1); assert.equal(f.state.childCount, 0); assert.ok(r.reasons.includes('CLEANUP'));
});

test('runner 已取得名稱或可信 reply 的事故不被 reader 深度失敗掩蓋', async (t) => {
  for (const source of ['name', 'reply']) {
    for (const nested of [false, true]) {
      const f = fixture(t);
      if (source === 'reply') f.deps.startRelay = cfg => { f.state.ports.push(cfg.port); return startGeminiRelay(cfg, { transport: async () => ({ statusCode: 200, body: Buffer.from(JSON.stringify({ response: { modelVersion: model, candidates: [{ content: { role: 'model', parts: [{ text: escapeForms(privateValue).at(-1) }] }, finishReason: 'STOP' }] } })) }) }); };
      afterChild(f, (_p, box) => {
        const dir = join(box, 'results', source === 'name' ? privateValue : 'extra-directory'); mkdirSync(dir);
        if (nested) mkdirSync(join(dir, 'nested'));
      });
      let readerCalls = 0;
      f.deps.readSessionsOnce = (...args) => { readerCalls += 1; return readSessionsOnce(...args); };
      const r = await runGeminiScan(f.args, f.deps);
      assert.equal(r.code, 1, `${source}-${nested}`); assert.ok(r.reasons.includes('DLP'));
      assert.equal(readerCalls, 1); assert.equal(existsSync(f.args.outFile), false);
      assert.equal(JSON.stringify(r).includes(privateValue), false); assert.equal(JSON.stringify(r).includes(hash(privateValue)), false);
    }
  }
});


test('runner results 根捷徑在任何盒外名稱列舉之前拒絕', async (t) => {
  const f = fixture(t), outside = join(f.root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, privateValue), 'synthetic outside-only fixture');
  const originalReadDir = fsDefault.readdirSync; let externalListings = 0;
  afterChild(f, (_p, box) => {
    const resultDir = join(box, 'results'); rmSync(resultDir, { recursive: true }); symlinkSync(outside, resultDir);
    fsDefault.readdirSync = (...args) => { if (fsDefault.realpathSync(args[0]) === fsDefault.realpathSync(outside)) externalListings += 1; return originalReadDir(...args); };
    syncBuiltinESMExports();
  });
  let result;
  try { result = await runGeminiScan(f.args, f.deps); }
  finally { fsDefault.readdirSync = originalReadDir; syncBuiltinESMExports(); }
  assert.equal(externalListings, 0); assert.notEqual(result.code, 0); assert.equal(existsSync(f.args.outFile), false);
});


test('runner 只透傳程式型官方來源定位，來源不進盒或結果', async (t) => {
  const f = fixture(t), original = f.deps.loadAuth;
  let received;
  f.deps.loadAuth = async options => { received = options; return original(); };
  const r = await runGeminiScan(f.args, f.deps);
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.deepEqual(received, { clientSourceRoot: f.args.clientSourceRoot });
  assert.equal(JSON.stringify(r).includes(f.args.clientSourceRoot), false);
  assert.equal(readFileSync(f.args.outFile, 'utf8').includes(f.args.clientSourceRoot), false);
  assert.equal(readFileSync(f.args.outFile + '.receipt.json', 'utf8').includes(f.args.clientSourceRoot), false);
});

test('runner 缺可信來源在 provider、canary 與 auth 前拒絕，不採 env 或 cwd', async (t) => {
  for (const missing of [undefined, '', 7]) {
    const f = fixture(t), old = process.env.GEMINI_CLIENT_SOURCE_ROOT;
    if (missing === undefined) delete f.args.clientSourceRoot; else f.args.clientSourceRoot = missing;
    process.env.GEMINI_CLIENT_SOURCE_ROOT = join(f.root, 'looks-valid-but-untrusted');
    let r;
    try { r = await runGeminiScan(f.args, f.deps); }
    finally { if (old === undefined) delete process.env.GEMINI_CLIENT_SOURCE_ROOT; else process.env.GEMINI_CLIENT_SOURCE_ROOT = old; }
    assert.equal(r.code, 2); assert.ok(r.reasons.includes('CLIENT_SOURCE'));
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.canaryCount, 0); assert.equal(f.state.authCount, 0); assert.equal(f.state.childCount, 0);
  }
  const args = ['--repo', 'r', '--base', base, '--head', head, '--prompt', 'p', '--out', 'o', '--model', model, '--provider-head', providerHead];
  assert.throws(() => parseScanArgs([...args, '--client-source-root', '/synthetic/public-source']), /ARGS/);
});


test('runner 官方來源錯誤保留固定分類，且不洩漏定位', async (t) => {
  const f = fixture(t);
  f.deps.loadAuth = async () => { f.state.authCount += 1; throw new Error('GEMINI_AUTH_CLIENT_SOURCE'); };
  const r = await runGeminiScan(f.args, f.deps);
  assert.equal(r.code, 2); assert.deepEqual(r.reasons, ['CLIENT_SOURCE']);
  assert.match(r.summary.join(' '), /已固定的盒外發射器/);
  assert.equal(f.state.authCount, 1); assert.equal(f.state.childCount, 0);
  assert.equal(JSON.stringify(r).includes(f.args.clientSourceRoot), false);
});
