import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';

const source = fileURLToPath(new URL('..', import.meta.url));
for (const [name, supplied, status] of [['無設定', {}, 0], ['空設定', { TRANSFER_SAVE_SOURCE: '' }, 1], ['拼錯前綴設定', { TRANSFER_SAVE_TYPO: 'x' }, 1]]) {
  test('內轉 helper 入口：' + name, t => {
    const folder = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'transfer-entry-')));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const env = gitEnv();
    for (const key of Object.keys(env)) if (key.startsWith('TRANSFER_SAVE')) delete env[key];
    // 獨立 runner 需真正執行檔案，不能繼承父 runner 的子測試標記而跳過。
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', 'test/helpers/settings-transfer-save-case.js'], {
      cwd: source, timeout: 30000, maxBuffer: 2e6, encoding: 'utf8',
      env: { ...env, ...supplied, NOTEASY_HOSTED: '', STORE_FILE: join(folder, 'synthetic.db'), TMPDIR: folder },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /settings-transfer-save-case/);
    assert.doesNotMatch(result.stdout + result.stderr, /recursive|skipping running files|TRANSFER_SAVE_CASE_PASSED/i);
    if (status) assert.match(result.stdout + result.stderr, /AssertionError/);
    assert.equal(fs.existsSync(join(folder, 'synthetic.db')), false, '入口拒收不能建立帳本');
  });
}
for (const mode of ['normal', 'double', 'new', 'hash', 'unknown-written', 'unknown-unwritten', 'structure', 'cancel', 'closed', 'root', 'dirty', 'unknown-400', 'validation', 'refresh-dirty', 'refresh-new', 'refresh-hash', 'refresh-error', 'refresh-error-new', 'entry-pending', 'entry-failed', 'entry-pending-error', 'entry-failed-error', 'nav-return', 'background', 'stale-handler', 'replaced-control', 'entry-pending-same', 'entry-failed-same', 'refresh-newer']) {
  test('內轉保存生命週期：' + mode, t => {
    const folder = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'transfer-save-')));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const env = gitEnv();
    for (const key of Object.keys(env)) if (key.startsWith('TRANSFER_SAVE')) delete env[key];
    const result = spawnSync(process.execPath, ['test/helpers/settings-transfer-save-case.js'], {
      cwd: source, timeout: 30000, maxBuffer: 2e6, encoding: 'utf8',
      env: { ...env, NOTEASY_HOSTED: '', STORE_FILE: join(folder, 'synthetic.db'), TMPDIR: folder,
        TRANSFER_SAVE_SOURCE: source, TRANSFER_SAVE_MODE: mode },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /TRANSFER_SAVE_CASE_PASSED/);
  });
}
