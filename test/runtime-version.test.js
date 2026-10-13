// 注入版本只驗啟動決策；SQLite 相容性由真正跑三關的 runtime 提供證據。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../lib/git-env.js';
import { MIN_NODE_VERSION, isSupportedNodeVersion, parseNodeVersion } from '../scripts/check-node-version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CASES = [
  ['21.99.99', false], ['22.13.0', false], ['22.23.0', false],
  ['22.23.1', true], ['22.99.0', true], ['23.0.0', false], ['23.99.99', false],
  ['24.0.0', true], ['26.0.0', true],
  ['22.23.1-nightly', false], ['24.0.0-nightly', false], ['22.23.1+build', true],
  ['22.23.1+build-with-hyphen', true],
];

test('Node 支援 22.23.1 起的 22 系列及 24 起，排除 23 與預發行版', () => {
  for (const [version, supported] of CASES) assert.equal(isSupportedNodeVersion(String(version)), supported, String(version));
});

test('Node 版本解析保留標記讀法，異常版本不可啟動', () => {
  assert.deepEqual(parseNodeVersion('v22.23.1'), [22, 23, 1]);
  assert.deepEqual(parseNodeVersion('22.23.1-nightly'), [22, 23, 1]);
  assert.equal(parseNodeVersion('22.23'), null);
  assert.equal(isSupportedNodeVersion('unknown'), false);
});

test('專案 engines 與鎖檔根共用支援範圍及最低版本', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(MIN_NODE_VERSION, '22.23.1');
  assert.equal(pkg.engines?.node, '^22.23.1 || >=24.0.0');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
});

for (const [version, supported] of CASES) {
  test(`版本 CLI 真入口｜${version} ${supported ? '可啟動' : '拒絕並給完整範圍'}`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'finance-node-entry-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const preload = join(dir, 'version.mjs');
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)}, configurable: true });\n`);
    const r = spawnSync(process.execPath, ['--import', preload, 'scripts/check-node-version.js'], { cwd: ROOT, env: gitEnv(), encoding: 'utf8' });
    assert.equal(r.status, supported ? 0 : 1, r.stderr);
    assert.equal(r.stdout, '');
    if (!supported) {
      assert.ok(r.stderr.includes(String(version)), '提示須點名注入版本');
      assert.ok(r.stderr.includes('^22.23.1 || >=24.0.0'));
      assert.match(r.stderr, /不支援 Node 23/);
    } else assert.equal(r.stderr, '');
  });
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
for (const [version, supported] of [['22.23.0', false], ['22.23.1', true], ['23.0.0', false], ['24.0.0', true], ['26.0.0', true]]) {
  test(`雙擊入口｜${version} ${supported ? '才接到啟動' : '在 npm 前停下'}`, { skip: process.platform === 'win32' }, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'finance-start-entry-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const marker = join(dir, 'npm-called');
    const preload = join(dir, 'version.mjs');
    writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)}, configurable: true });\n`);
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(preload)} "$@"\n`, { mode: 0o700 });
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s' "$*" > ${quote(marker)}\n`, { mode: 0o700 });
    writeFileSync(join(bin, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(dir, 'start.command'), readFileSync(join(ROOT, 'start.command')));
    symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
    mkdirSync(join(dir, 'node_modules'));
    // 假 npm/open 阻止啟動伺服器與打開瀏覽器；沒有接觸財務資料。
    const r = spawnSync('/bin/bash', [join(dir, 'start.command')], { cwd: dir, env: { ...gitEnv(), PATH: bin + ':' + process.env.PATH }, encoding: 'utf8' });
    assert.equal(r.status, supported ? 0 : 1, r.stdout + r.stderr);
    assert.equal(existsSync(marker), supported, '版本判斷要在安裝與啟動之前');
    if (supported) assert.equal(readFileSync(marker, 'utf8'), 'start');
    else assert.match(r.stderr, /不支援 Node 23/);
  });
}
