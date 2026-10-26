import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';

const source = fileURLToPath(new URL('../', import.meta.url));
test('證券測試入口｜無案例不啟動、部分或非法設定必須失敗', () => {
  const clean = Object.fromEntries(Object.entries(gitEnv()).filter(([key]) => !key.startsWith('SEC_BATCH_')));
  const invoke = extra => spawnSync(process.execPath, [join(source, 'test/helpers/securities-batch-lifecycle-case.js')], {
    env: { ...clean, ...extra }, encoding: 'utf8', timeout: 10000,
  });
  const empty = invoke({});
  assert.equal(empty.status, 0, empty.stderr);
  assert.doesNotMatch(empty.stdout, /SEC_BATCH_CASE_PASSED|\[store\]/);
  for (const extra of [{ SEC_BATCH_MODE: 'normal' }, { SEC_BATCH_SOURCE: source, SEC_BATCH_MODE: 'invalid' }]) {
    const invalid = invoke(extra);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /AssertionError/);
    assert.doesNotMatch(invalid.stdout, /SEC_BATCH_CASE_PASSED|\[store\]/);
  }
});
const cases = [
  ...['reverse-unknown-batch', 'reverse-unknown-page', 'reverse-unknown-batch-error', 'reverse-unknown-page-error'].map(mode => ({ mode, outcome: 'success' })),
  ...['revision-batch', 'revision-page'].map(mode => ({ mode, outcome: 'failure' })),
  ...['unknown-no-write', 'unknown-batch-error', 'unknown-page-error'].map(mode => ({ mode, outcome: 'success' })),
  ...['other', 'opened-closed', 'x', 'escape', 'close', 'hash-now', 'navigate-return'].map(mode => ({ mode, outcome: 'failure' })),
  ...['confirm-reentrant', 'navigate-return'].map(mode => ({ mode, outcome: 'success' })),
  ...['initial-double', 'initial-new-failure', 'confirm-cancel'].map(mode => ({ mode, outcome: 'success' })),
  { mode: 'boot-delayed', outcome: 'success' },
  ...['reverse-batch', 'reverse-page', 'revision-batch', 'revision-page'].map(mode => ({ mode, outcome: 'success' })),
  ...['render-race', 'render-error', 'render-entry', 'stale-button'].map(mode => ({ mode, outcome: 'success' })),
  ...['success', 'failure'].map(outcome => ({ mode: 'initial', outcome })),
  ...['normal', 'parallel', 'other', 'opened-closed', 'x', 'escape', 'close', 'hash-now', 'background', 'unknown', 'wrong-id', 'wrong-ok', 'bad-count', 'batch-error', 'page-error'].map(mode => ({ mode, outcome: 'success' })),
];
for (const { mode, outcome } of cases) {
  test(`證券批次生命週期｜${mode}/${outcome}`, t => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'securities-batch-case-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [join(source, 'test/helpers/securities-batch-lifecycle-case.js')], {
      cwd: root, env: { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'), TMPDIR: root,
        SEC_BATCH_SOURCE: source, SEC_BATCH_OUTCOME: outcome, SEC_BATCH_MODE: mode }, encoding: 'utf8', timeout: 30000, maxBuffer: 2e6,
    });
    assert.equal(result.status, 0, '證券批次初載生命週期：' + result.stdout + result.stderr);
    assert.match(result.stdout, /SEC_BATCH_CASE_PASSED/);
  });
}
