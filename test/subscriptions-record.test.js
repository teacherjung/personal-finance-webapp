// 每題使用新子程序與專屬合成庫，避免上題留下的資料替保存斷言作證。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gitEnv } from '../lib/git-env.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ...['active', 'ending', 'ended'].flatMap(list => ['cancel', 'success', 'failure'].map(outcome => ({ list, outcome, handoff: 'none' }))),
  ...['focus', 'navigation', 'modal'].flatMap(handoff => ['success', 'failure'].map(outcome => ({ list: 'active', outcome, handoff })))
];
for (const spec of cases) test(`訂閱記帳｜${spec.list}｜${spec.outcome}｜${spec.handoff}`, t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'finance-sub-record-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportPath = join(root, 'report.json'), nonce = randomUUID();
  assert.equal(fs.existsSync(reportPath), false);
  const env = { ...gitEnv(), TZ: 'UTC', NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'),
    TMPDIR: root, TMP: root, TEMP: root, SUBSCRIPTION_RECORD_SOURCE: ROOT,
    SUBSCRIPTION_RECORD_CASE: JSON.stringify(spec), SUBSCRIPTION_RECORD_NONCE: nonce, SUBSCRIPTION_RECORD_REPORT: reportPath };
  const result = spawnSync(process.execPath, [join(ROOT, 'test/helpers/subscriptions-record-case.js')],
    { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2e6 });
  const hint = '\n檢查 public/modules/subscriptions.js 的記帳續行與 test/helpers/subscriptions-record-case.js；重跑 node --test test/subscriptions-record.test.js。\n';
  assert.equal(result.status, 0, hint + (result.error?.message || '') + result.stdout + result.stderr);
  try {
    const stat = fs.lstatSync(reportPath);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 2e6);
    assert.equal(fs.realpathSync(reportPath), reportPath);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.version, 1); assert.equal(report.nonce, nonce);
    assert.deepEqual(report.spec, spec); assert.equal(report.passed, true);
    assert.equal(report.confirmations, 1);
    assert.equal(report.posts, spec.outcome === 'cancel' ? 0 : 1);
    assert.equal(report.httpPosts, report.posts);
    assert.equal(report.rawRoundTrip, true); assert.equal(report.presentationPreserved, true);
  } catch (error) {
    error.message += hint + result.stdout + result.stderr;
    throw error;
  }
});
