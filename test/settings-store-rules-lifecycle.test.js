import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';

const source = fileURLToPath(new URL('..', import.meta.url));
const intentModes = ['intent-preflight', 'intent-save', 'intent-failure', 'preview-intent', 'refresh-new-read', 'refresh-open-close', 'unknown-reopen'];
for (const [name, supplied, status] of [['無設定', {}, 0], ['空設定', { RULES_LIFE_SOURCE: '' }, 1], ['拼錯前綴', { RULES_LIFE_TYPO: 'x' }, 1]]) {
  test('店名規則 helper 入口：' + name, t => {
    const folder = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'rules-entry-')));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const env = gitEnv();
    for (const key of Object.keys(env)) if (key.startsWith('RULES_LIFE')) delete env[key];
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', 'test/helpers/settings-store-rules-lifecycle-case.js'], {
      cwd: source, timeout: 30000, maxBuffer: 2e6, encoding: 'utf8',
      env: { ...env, ...supplied, NOTEASY_HOSTED: '', STORE_FILE: join(folder, 'synthetic.db'), TMPDIR: folder },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /settings-store-rules-lifecycle-case/);
    assert.doesNotMatch(result.stdout + result.stderr, /recursive|skipping running files|RULES_LIFE_CASE_PASSED/i);
    if (status) assert.match(result.stdout + result.stderr, /AssertionError/);
    assert.equal(fs.existsSync(join(folder, 'synthetic.db')), false);
  });
}
for (const mode of [...intentModes, 'payload', 'needs-confirmation', ...['normal', 'double', 'preflight-new', 'preflight-hash', 'save-new', 'unknown-written', 'unknown-unwritten', 'preview-nochange', 'preview-failure', 'preview-new', 'preflight-failure', 'preview-back', 'preview-x', 'preview-escape', 'preview-back-hash', 'preview-x-hash', 'preview-escape-hash', 'preview-old-back', 'confirm-cancel', 'confirm-hash', 'confirm-accept', 'unknown-400', 'preflight-root', 'preflight-nav-return', 'background', 'dirty', 'mix-save', 'preview-mix', 'entry-same', 'entry-failure', 'entry-cross', 'entry-old', 'refresh-new', 'refresh-dirty', 'refresh-hash', 'refresh-error', 'refresh-error-new']]) {
  test('店名規則生命週期：' + mode, t => {
    const folder = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'rules-life-')));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const env = gitEnv();
    for (const key of Object.keys(env)) if (key.startsWith('RULES_LIFE')) delete env[key];
    const result = spawnSync(process.execPath, ['test/helpers/settings-store-rules-lifecycle-case.js'], {
      cwd: source, timeout: 30000, maxBuffer: 2e6, encoding: 'utf8',
      env: { ...env, NOTEASY_HOSTED: '', STORE_FILE: join(folder, 'synthetic.db'), TMPDIR: folder,
        RULES_LIFE_SOURCE: source, RULES_LIFE_MODE: mode },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /RULES_LIFE_CASE_PASSED/);
  });
}
