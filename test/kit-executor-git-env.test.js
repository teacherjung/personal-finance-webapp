// @ts-check
// 套件共用執行器 `tools/platform.js` 的 `runCommand()`（所有閘問 gh 都走它）的兩種 GIT_* 題——2026-09-18 搬家第 7 步，
// 接替舊 test/cross-pr-merge.test.js「會叫 gh 的閘」那族的**第②種題**（Grok #614 掃後①）：
//   套件自己的呼叫點題（tests/platform.test.js:160 等四處）只斷言子行程看不到 GIT_DIR——清法退化成「只刪 GIT_DIR」的列名版
//   照樣綠；關得起門的是題②：注入整組髒 GIT_*（含 git -c 會長出來的 GIT_CONFIG_* 與一個世上還不存在的名字），
//   斷言子行程**一個 GIT_* 都看不到**。這裡對套件那份 `tools/git-env.js` 與執行器各釘一次。
// ⚠️ 誠實劃界：只釘 `runCommand()` 這一個呼叫點（gh 的統一入口）；`tools/merge.js`、`tools/run-checks.js`、
//    `tools/gates/check-cross-merge.js` 自己 spawn 的那三處仍只有套件的 GIT_DIR 題＝套件側待辦（PROJECT.md 第 7 步結案⑤）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { injectDirtyGitEnv, DIRTY_GIT_ENV } from './helpers/dirty-git-env.js';
import { runCommand } from '../tools/platform.js';
import { gitEnv } from '../tools/git-env.js';

const PRINT_GIT_KEYS = 'process.stdout.write(Object.keys(process.env).filter((k) => k.startsWith("GIT_")).sort().join(","))';

test('對照斷言：髒環境真的注進去了（不然下面兩題是空包彈）', () => {
  const restore = injectDirtyGitEnv();
  try {
    for (const k of Object.keys(DIRTY_GIT_ENV)) assert.ok(k in process.env, `${k} 沒注進 process.env`);
    assert.ok(Object.keys(DIRTY_GIT_ENV).some((k) => /BOGUS|FUTURE/i.test(k)), '髒環境裡要有一個世上還不存在的 GIT_ 名字（列名版的照妖鏡）');
  } finally { restore(); }
});

test('⭐ 套件 tools/git-env.js 的 gitEnv()：整族清掉、沒列過名的也清；PATH 留著', () => {
  const restore = injectDirtyGitEnv();
  try {
    const env = gitEnv();
    const leftover = Object.keys(env).filter((k) => k.startsWith('GIT_'));
    assert.deepEqual(leftover, [], `套件的 gitEnv() 漏了：${leftover.join('、')}`);
    assert.ok(env.PATH, 'PATH 被清掉＝子行程連 gh 都找不到');
  } finally { restore(); }
});

test('⭐ 題①：髒 GIT_* 環境下 runCommand() 的答案仍正確（子行程照常跑、退出碼照常）', () => {
  const restore = injectDirtyGitEnv();
  try {
    const r = runCommand(process.execPath, ['-e', 'process.stdout.write("ok")']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'ok');
  } finally { restore(); }
});

test('⭐ 題②：runCommand() 的子行程直接看環境，不可以有任何 GIT_*（含 GIT_CONFIG_* 與沒列過名的）', () => {
  const restore = injectDirtyGitEnv();
  try {
    const r = runCommand(process.execPath, ['-e', PRINT_GIT_KEYS]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', `交給子行程的環境裡漏了 GIT_*：${r.stdout}`);
    // 對照組：不經執行器、直接用 process.env 起同一支探針，子行程要看得到整組（證明探針有效、不是子行程本來就看不到）
    const seen = spawnSync(process.execPath, ['-e', PRINT_GIT_KEYS], { encoding: 'utf8' });
    const seenKeys = String(seen.stdout).split(',').filter(Boolean);
    for (const k of Object.keys(DIRTY_GIT_ENV)) assert.ok(seenKeys.includes(k), `對照組：不清的子行程應該看得到 ${k}，實際只看到：${seen.stdout}`);
  } finally { restore(); }
});
