// 每題獨立行程與合成庫，讓開窗基準和保存值不受前題狀態影響。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gitEnv } from '../lib/git-env.js';

const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  'preserve-summary', 'preserve-remark', 'preserve-fields', 'same-field', 'deleted',
  'clear', 'zero', 'null-amount', 'negative', 'number-equivalent', 'fallback', 'missing', 'no-op',
  'classification-sub', 'classification-parent', 'classification-flow', 'classification-transfer', 'apply-all',
  'apply-summary', 'apply-remark', 'immutable-baseline', 'retry', 'post', 'cancel'
];
for (const scenario of cases) test(`收支編輯保存｜${scenario}`, t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'finance-cashflow-edit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportPath = join(root, 'report.json'), nonce = randomUUID();
  const env = { ...gitEnv(), TZ: 'UTC', NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'),
    TMPDIR: root, TMP: root, TEMP: root, CASHFLOW_EDIT_SOURCE: SOURCE, CASHFLOW_EDIT_CASE: scenario,
    CASHFLOW_EDIT_NONCE: nonce, CASHFLOW_EDIT_REPORT: reportPath };
  const r = spawnSync(process.execPath, [join(SOURCE, 'test/helpers/cashflow-edit-case.js')],
    { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2e6 });
  const hint = '\n檢查 public/modules/cashflow.js 的編輯 payload；重跑 node --test test/cashflow-edit-preservation.test.js。\n';
  assert.equal(r.status, 0, hint + (r.error?.message || '') + r.stdout + r.stderr);
  const stat = fs.lstatSync(reportPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 2e6);
  assert.equal(fs.realpathSync(reportPath), reportPath);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.deepEqual(report, { version: 1, nonce, scenario, passed: true });
});
