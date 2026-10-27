import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const caseEnv = () => Object.fromEntries(Object.entries(gitEnv()).filter(([key]) => !key.startsWith('CATEGORY_SAVE')));
for (const supplied of [{}, { CATEGORY_SAVE_DOMAIN: '' }, { CATEGORY_SAVE_TYP0: '' }]) {
  test(`分類helper入口｜${Object.keys(supplied).join(',') || '無參數'}`, t => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'category-entry-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { ...caseEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'), TMPDIR: root, ...supplied };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', join(source, 'test/helpers/settings-category-save-case.js')], {
      cwd: root, env,
      encoding: 'utf8', timeout: 30000, maxBuffer: 2e6,
    });
    assert(!result.error && !result.signal);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /recursively|skipping running files/);
    assert.match(output, /settings-category-save-case\.js/);
    assert.equal(result.status, Object.keys(supplied).length ? 1 : 0, output);
    if (Object.keys(supplied).length) assert.match(output, /AssertionError[\s\S]*includes\(domain\)/);
    assert.doesNotMatch(output, /CATEGORY_SAVE_CASE_PASSED/);
    assert.equal(fs.existsSync(join(root, 'synthetic.db')), false);
  });
}
for (const domain of ['expense', 'income']) {
  for (const mode of ['dirty-open', 'structure', 'root', 'normal', 'double', 'other', 'hash', 'nav-return', 'dirty', 'cancel', 'closed', 'background', 'hash-before', 'dirty-before', 'other-error', 'unknown-written', 'unknown-unwritten', 'unknown-400', 'validation', 'entry-pending', 'entry-failed', 'entry-pending-error', 'entry-failed-error', 'entry-pending-cross', 'entry-failed-cross', 'entry-pending-error-cross', 'entry-failed-error-cross', 'unknown-reopen-failed', 'refresh-dirty', 'refresh-other', 'refresh-hash', 'refresh-failed', 'refresh-newer', 'refresh-error-other']) {
    test(`分類保存｜${domain}/${mode}`, t => {
      const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'category-save-')));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const result = spawnSync(process.execPath, [join(source, 'test/helpers/settings-category-save-case.js')], {
        cwd: root, env: { ...caseEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'), TMPDIR: root,
          CATEGORY_SAVE_SOURCE: source, CATEGORY_SAVE_DOMAIN: domain, CATEGORY_SAVE_MODE: mode },
        encoding: 'utf8', timeout: 30000, maxBuffer: 2e6,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /CATEGORY_SAVE_CASE_PASSED/);
    });
  }
}
