// 每題新子程序與合成 LOCAL 帳本；正式前端接真 HTTP，晚回應不能取消已完成的保存。
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
  { name: '正常成功與連點', mode: 'normal' },
  { name: '明確失敗保留輸入並可重試', mode: 'retry' },
  { name: '同頁背景重畫不撤銷原窗', mode: 'background' },
  { name: '跨頁仍可手動關閉且舊 close 不清新窗', mode: 'close' },
  { name: '過期儲存入口不讀取後開窗欄位', mode: 'stale-submit' },
  { name: '失敗後重試先撤銷上一輪仍在途的重讀', mode: 'retry-read' },
  ...['success', 'failure'].flatMap(outcome => ['reopen', 'other', 'cancel', 'navigate', 'return', 'hash-now'].map(action => ({
    name: `保存回應 ${outcome}／${action}`, mode: 'stale', phase: 'post', outcome, action
  }))),
  ...['success', 'failure'].flatMap(outcome => ['reopen', 'other', 'opened-closed', 'navigate', 'return', 'background'].map(action => ({
    name: `重讀回應 ${outcome}／${action}`, mode: 'stale', phase: 'get', outcome, action
  }))),
  ...['success', 'failure'].flatMap(outcome => ['reopen', 'navigate', 'background', 'hash-now'].map(action => ({
    name: `重讀出錯 ${outcome}／${action}`, mode: 'stale', phase: 'get', outcome, action, refreshError: true
  }))),
  { name: '保存成功但重讀失敗不重送也不說保存失敗', mode: 'read-error', outcome: 'success' },
  { name: '保存失敗且重讀失敗仍保留重試', mode: 'read-error', outcome: 'failure' }
];

for (const spec of cases) test('目標配置儲存｜' + spec.name, t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'finance-target-save-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nonce = randomUUID(), reportPath = join(root, 'report.json');
  const env = { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'), TMPDIR: root, TMP: root, TEMP: root,
    ASSET_TARGET_CASE: JSON.stringify(spec), ASSET_TARGET_SOURCE: ROOT, ASSET_TARGET_REPORT: reportPath, ASSET_TARGET_NONCE: nonce };
  const result = spawnSync(process.execPath, [join(ROOT, 'test/helpers/asset-target-save-case.js')], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2e6
  });
  assert.equal(result.status, 0, '查 public/modules/assets.js 的 openTargets 與本題 helper；重跑 node --test test/asset-target-save.test.js。\n' + (result.error?.message || '') + result.stdout + result.stderr);
  const stat = fs.lstatSync(reportPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 2e6);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.nonce, nonce); assert.equal(report.name, spec.name); assert.equal(report.passed, true);
  assert.equal(report.realHttp, true);
});
