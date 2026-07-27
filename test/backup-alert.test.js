// 每日備份警告文案（純函式）考題。裁決 2026-07-24：畫面必須明顯警告、連續失敗提高強度。
// 最重要的一條反著測：**成功與抓不到回應時絕不可出現警告**——誤報會讓使用者學會忽略它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupAlertView, ESCALATE_AT } from '../public/modules/backup-alert.js';

test('成功／抓不到回應＝不警告（誤報比不報更糟）', () => {
  assert.equal(backupAlertView({ created: true, failStreak: 0 }).show, false, '今天備份成功');
  assert.equal(backupAlertView({ ran: false, failStreak: 0 }).show, false, '今天早就備過＝跳過');
  assert.equal(backupAlertView(null).show, false, '伺服器沒回＝分不出原因，不報');
  assert.equal(backupAlertView(undefined).show, false);
  assert.equal(backupAlertView({}).show, false, '沒有 failStreak 欄位＝當 0');
});

test('第 1 次失敗＝warn 級：講「今天沒成功」、不嚇人', () => {
  const v = backupAlertView({ created: false, failStreak: 1, error: 'ENOSPC: no space left' });
  assert.equal(v.show, true);
  assert.equal(v.level, 'warn');
  assert.match(v.title, /今天的自動備份沒有成功/);
  assert.match(v.body, /可以照常使用/, '第一次失敗不可危言聳聽——資料本身沒事');
  assert.match(v.why, /ENOSPC/);
});

test(`連續 ${ESCALATE_AT} 次以上＝danger 級：標題帶次數、內文給明確下一步`, () => {
  const v = backupAlertView({ created: false, failStreak: 5, error: 'x' });
  assert.equal(v.level, 'danger');
  assert.match(v.title, /連續 5 次/);
  assert.match(v.body, /硬碟空間|複製一份/, '強警告要給做得到的下一步，不是只喊狼來了');
  // 邊界：剛好到門檻就升級
  assert.equal(backupAlertView({ failStreak: ESCALATE_AT }).level, 'danger');
  assert.equal(backupAlertView({ failStreak: ESCALATE_AT - 1 }).level, 'warn');
});

test('錯誤訊息截 300 字＋壞輸入不炸', () => {
  const v = backupAlertView({ failStreak: 1, error: 'e'.repeat(1000) });
  assert.equal(v.why.length, 300, '超長錯誤訊息不可撐爆畫面');
  assert.doesNotThrow(() => backupAlertView(/** @type {any} */ ({ failStreak: 'abc', error: null })));
  assert.equal(backupAlertView(/** @type {any} */ ({ failStreak: 'abc' })).show, false, '非數字＝當 0＝不警告');
  assert.equal(backupAlertView(/** @type {any} */ ({ failStreak: -3 })).show, false, '負數＝當 0');
});
