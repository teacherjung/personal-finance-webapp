// 每題隔離帳本與模組圖；正式上傳事件、解析與匯入 HTTP，不使用私人帳單。
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
  { name: '正常匯入連按只送一次', mode: 'normal' },
  { name: '改卡在途不能匯入或排序', mode: 'reparse' },
  { name: '匯入失敗保留勾選並可重試', mode: 'retry' },
  { name: '改卡失敗保留原卡與編輯後可匯入', mode: 'retry-reparse' },
  { name: '排序保存編輯且舊按鈕不能借新窗送出', mode: 'sort' },
  { name: '同頁背景重畫仍完成原匯入', mode: 'background' },
  { name: '關閉舊預覽後新預覽可獨立匯入', mode: 'independent' },
  ...['import', 'reparse'].flatMap(operation => ['success', 'failure'].flatMap(outcome =>
    ['cancel', 'x', 'escape', 'other', 'opened-closed', 'navigate', 'return', 'hash-now'].map(action => ({ name: `${operation}/${outcome}/${action}`, mode: 'stale', operation, outcome, action })))),
  { name: '刷新失敗不說匯入失敗也不重新匯入', mode: 'read-error' },
  ...['keep', 'done', 'x', 'escape'].flatMap(action => [false, true].map(refreshError => ({ name: `完成窗刷新/${action}/${refreshError}`, mode: 'done-read', action, refreshError }))),
  ...['other', 'opened-closed', 'navigate', 'return', 'hash-now'].map(afterClose => ({ name: `完成後過期刷新/${afterClose}`, mode: 'done-read', action: 'done', afterClose })),
  ...['navigate', 'return', 'hash-now'].map(beforeClose => ({ name: `換頁後仍能關完成窗/${beforeClose}`, mode: 'done-read', action: 'done', beforeClose })),
  ...['cancel', 'x', 'escape', 'backdrop'].flatMap(closeAction => [false, true].map(cancelRefreshError => ({ name: `完成後改卡取消/${closeAction}/${cancelRefreshError}`, mode: 'done-read', action: 'reassign', closeAction, cancelRefreshError }))),
  ...['other', 'opened-closed', 'navigate', 'return', 'hash-now', 'background'].flatMap(afterClose => [false, true].map(cancelRefreshError => ({ name: `改卡取消刷新過期/${afterClose}/${cancelRefreshError}`, mode: 'done-read', action: 'reassign', closeAction: 'cancel', afterClose, cancelRefreshError }))),
  ...['cancel', 'x', 'escape'].map(closeAction => ({ name: `改卡拖出不關再取消/${closeAction}`, mode: 'done-read', action: 'reassign', closeAction, drag: true })),
  ...[false, true].map(reassignFailure => ({ name: `完成後改卡保存/${reassignFailure}`, mode: 'done-read', action: 'reassign', closeAction: 'save', reassignFailure })),
  { name: '完成後改卡保存等待新列表回覆', mode: 'done-read', action: 'reassign', closeAction: 'save', reassignFailure: false, slowNewRead: true },
  ...['x', 'escape', 'other', 'opened-closed', 'navigate', 'return', 'hash-now'].flatMap(loadAction => [false, true].map(loadFailure => ({ name: `載卡晚回/${loadAction}/${loadFailure}`, mode: 'done-read', action: 'reassign', loadAction, loadFailure }))),
  ...[false, true].map(loadFailure => ({ name: `背景載卡先發晚回/${loadFailure}`, mode: 'done-read', action: 'reassign', loadAction: 'x', loadFailure, delayedBackgroundCards: true })),
  { name: '有效載卡失敗正常提示', mode: 'done-read', action: 'reassign', loadAction: 'keep', loadFailure: true, delayedBackgroundCards: true },
  { name: '改卡過期入口/hash-now', mode: 'done-read', action: 'reassign', staleEntry: true },
  ...['cancel', 'other', 'opened-closed', 'navigate', 'return', 'hash-now'].flatMap(postAction => [false, true].map(reassignFailure => ({ name: `改卡保存晚回/${postAction}/${reassignFailure}`, mode: 'done-read', action: 'reassign', postAction, reassignFailure }))),
  ...['other', 'opened-closed', 'navigate', 'return', 'background', 'hash-now'].flatMap(action => [false, true].map(refreshError => ({ name: `刷新晚回/${action}/${refreshError}`, mode: 'stale-read', action, refreshError }))),
  { name: '過期刷新入口不發 GET 或撤銷有效重畫', mode: 'render-entry' },
];
for (const spec of cases) test('信用卡預覽保存｜' + spec.name, t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'finance-credit-save-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nonce = randomUUID(), reportPath = join(root, 'report.json');
  const result = spawnSync(process.execPath, [join(ROOT, 'test/helpers/credit-import-save-case.js')], {
    cwd: root, env: { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'), TMPDIR: root, TMP: root, TEMP: root,
      CREDIT_SAVE_CASE: JSON.stringify(spec), CREDIT_SAVE_SOURCE: ROOT, CREDIT_SAVE_REPORT: reportPath, CREDIT_SAVE_NONCE: nonce },
    encoding: 'utf8', timeout: 30000, maxBuffer: 2e6
  });
  assert.equal(result.status, 0, '查 transactions-import.js 的預覽接線；重跑 node --test test/credit-import-save.test.js。\n' + (result.error?.message || '') + result.stdout + result.stderr);
  const stat = fs.lstatSync(reportPath); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 2e6);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.nonce, nonce); assert.equal(report.name, spec.name); assert.equal(report.passed, true); assert.equal(report.realHttp, true);
});
