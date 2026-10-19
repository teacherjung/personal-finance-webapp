// 合成資料及預設分支的外置來源副本皆由本題擁有；不開正式預設帳本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { gitEnv } from '../lib/git-env.js';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELPER = join(ROOT, 'test/helpers/store-guidance-case.js');
function fixture(t, copy = false) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'finance-store-guidance-')));
  t.after(() => {
    const modules = join(root, 'source/node_modules');
    if (fs.existsSync(modules)) fs.unlinkSync(modules);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = copy ? join(root, 'source') : ROOT;
  if (copy) {
    fs.mkdirSync(source);
    for (const part of ['lib', 'public', 'scripts', 'server.js', 'package.json']) fs.cpSync(join(ROOT, part), join(source, part), { recursive: true });
    fs.symlinkSync(fs.realpathSync(join(ROOT, 'node_modules')), join(source, 'node_modules'), 'dir');
  }
  const env = { ...gitEnv(), NOTEASY_HOSTED: '', TMPDIR: root, TMP: root, TEMP: root, STORE_GUIDANCE_SOURCE: source };
  delete env.STORE_FILE;
  return { root, source, env };
}
function run(c, phase, file) {
  const env = { ...c.env, STORE_GUIDANCE_CASE: phase };
  if (file !== undefined) env.STORE_FILE = file;
  const r = spawnSync(process.execPath, [HELPER], { cwd: c.root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2e6 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
function expected(file) {
  return ['主檔：', 'WAL：', 'SHM：', '候選備份：'].map((label, i) => label + JSON.stringify(file + ['', '-wal', '-shm', '.bak'][i])).join('\n');
}
for (const shape of ['unset', 'empty', 'absolute', 'relative', 'non-db', 'space-reserved']) {
  test(`本機定位｜${shape} 正式 async 櫃檯不讀庫，FILE 取用時點與後綴保持`, t => {
    const c = fixture(t, true);
    const file = shape === 'unset' ? undefined : shape === 'empty' ? '' : shape === 'relative' ? './relative 目錄/ledger.db'
      : join(c.root, shape === 'non-db' ? 'ledger.sqlite' : shape === 'space-reserved' ? '  中文 #?% ~.db  ' : 'absolute.db');
    const target = file ? resolve(c.root, file) : join(c.source, 'data/store.db');
    const r = run(c, 'location', file);
    assert.equal(r.promise, true); assert.equal(r.diagnostic, expected(target)); assert.equal(r.afterEnvChange, r.diagnostic);
    assert.deepEqual(r.io, []); assert.equal(r.sql, 0);
    assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(join(c.source, 'data')), false);
  });
}
test('本機定位｜終端控制字元跳脫、長值有界且明示截短', t => {
  const c = fixture(t, true), file = join(c.root, 'line\n\u001b\u0085\u202e' + '字'.repeat(3000));
  const r = run(c, 'location', file);
  assert.equal(r.diagnostic.split('\n').length, 4);
  for (const char of r.diagnostic) {
    const code = char.codePointAt(0);
    assert.ok(code === 10 || (code >= 32 && !(code >= 127 && code <= 159) && code !== 8238));
  }
  assert.match(r.diagnostic, /\\n\\u001b\\u0085\\u202e/);
  for (const line of r.diagnostic.split('\n')) {
    const value = JSON.parse(line.slice(line.indexOf('：') + 1));
    assert.ok(value.endsWith('…（已截短）')); assert.ok(value.length < 2070); assert.ok(line.length < 12400);
  }
  assert.deepEqual(r.io, []); assert.equal(r.sql, 0);
});
for (const shape of ['unset', 'empty', 'relative', 'non-db']) {
  test(`真啟動橫幅｜${shape} 只印有效定位、不建立帳本或聲稱固定舊 JSON`, async t => {
    const c = fixture(t, true);
    const file = shape === 'unset' ? undefined : shape === 'empty' ? '' : shape === 'relative' ? './banner 目錄/ledger.db' : join(c.root, 'banner #?%資料.sqlite');
    const target = file ? resolve(c.root, file) : join(c.source, 'data/store.db');
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolveClose => listener.close(resolveClose));
    const env = { ...c.env, PORT: String(port) }; if (file !== undefined) env.STORE_FILE = file;
    const child = spawn(process.execPath, [join(c.source, 'server.js')], { cwd: c.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; const closed = once(child, 'close');
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    try {
      await new Promise((done, reject) => {
        const timer = setTimeout(() => reject(new Error('banner timeout: ' + err)), 15000);
        const check = () => { if (out.includes('按 Ctrl+C 可關閉。')) { clearTimeout(timer); done(); } };
        child.stdout.on('data', check); child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('close', () => { clearTimeout(timer); reject(new Error('early exit: ' + err)); }); check();
      });
      const mode = await fetch('http://127.0.0.1:' + port + '/api/mode');
      assert.equal(mode.status, 200); assert.deepEqual(await mode.json(), { hosted: false });
      assert.ok(out.includes(expected(target)), out); assert.match(out, /未驗證檔案或備份/);
      assert.doesNotMatch(out, /舊 store.json 僅為搬家備份/); assert.equal(fs.existsSync(target), false);
      assert.equal(fs.existsSync(join(c.source, 'data')), false);
    } finally { child.kill('SIGTERM'); await closed; }
  });
}
for (const phase of ['not-directory', 'corrupt']) for (const backup of (phase === 'corrupt' ? [false, true] : [false])) {
  test(`真開庫與 HTTP｜${phase} 備份${backup ? '存在' : '缺席'}，JSON／NDJSON 不洩漏且不自動復原`, t => {
    const c = fixture(t), marker = join(c.root, '唯一合成定位 #?% note');
    const file = phase === 'not-directory' ? join(marker, 'ledger.sqlite') : marker + '.sqlite';
    const original = phase === 'not-directory' ? marker : file;
    fs.writeFileSync(original, 'synthetic original ' + phase);
    if (backup && phase === 'corrupt') fs.writeFileSync(file + '.bak', 'synthetic candidate backup');
    const before = fs.readdirSync(c.root).sort().map(name => [name, fs.readFileSync(join(c.root, name)).toString('base64')]);
    const r = run(c, phase, file);
    assert.equal(r.responses.length, 3); assert.equal(r.errors.length, 2); assert.ok(r.errors.every(Boolean));
    for (const response of r.responses) {
      assert.equal(response.status, response.stream === true ? 200 : 500);
      const body = response.stream === true ? response.raw.trim().split('\n').map(s => JSON.parse(s)) : JSON.parse(response.raw);
      const message = response.stream === true ? body.at(-1).error : body.error;
      if (response.stream === true) { assert.equal(body[0].t, 'stage'); assert.equal(body.at(-1).t, 'error'); }
      assert.equal(message, r.errors[0].message);
      for (const secret of [c.root, file, encodeURI(file), encodeURIComponent(file), '唯一合成定位', 'ENOTDIR', 'not a database', 'node:sqlite', ' at open']) assert.ok(!response.raw.includes(secret), secret);
      assert.doesNotMatch(response.raw, /"(?:cause|stack)"/);
    }
    const diagnostic = r.localErrors.join('\n');
    for (const suffix of ['', '-wal', '-shm', '.bak']) assert.ok(diagnostic.includes(JSON.stringify(file + suffix)));
    assert.match(diagnostic, phase === 'corrupt' ? /④從候選備份的副本恢復主檔/ : /ENOTDIR/);
    if (phase === 'not-directory') assert.doesNotMatch(diagnostic, /④從候選備份/);
    const after = fs.readdirSync(c.root).sort().map(name => [name, fs.readFileSync(join(c.root, name)).toString('base64')]);
    assert.deepEqual(after, before, '本題原檔、候選備份及缺席狀態在真開庫之後保存');
  });
}
test('安全建立原因｜原始 cause 留內部、終端有界跳脫、公開訊息沒有低階原因', t => {
  const c = fixture(t), file = join(c.root, 'cause.db'), r = run(c, 'cause-bound', file);
  assert.equal(r.errors.length, 1); assert.match(r.errors[0].cause, /private-cause/);
  assert.match(r.errors[0].message, /安全建立失敗/); assert.doesNotMatch(r.errors[0].message, /private-cause|原因/);
  const diagnostic = r.localErrors.join('\n'); assert.ok(diagnostic.includes(JSON.stringify(file)));
  assert.match(diagnostic, /private-cause\\n\\u001b\\u0085\\u202e/); assert.match(diagnostic, /已截短/);
  assert.ok(diagnostic.length < 18000); assert.equal(fs.existsSync(file), false);
});
