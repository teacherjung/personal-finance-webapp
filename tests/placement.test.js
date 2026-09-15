// 放進別的專案（2026-09-13 搬家驗屋「程式格式」那一類）：搬進一個宣告 "type":"module" 的專案之後，
// 套件的工具與考題也要照樣起得來。
//
// 為什麼：專案根目錄的 package.json 宣告 "type":"module" 時，底下每一支 .js 都被當成 ES 模組讀，
// 套件的工具第一行 require 就崩（退 1、什麼都不印）。最危險的是禁區攔截器：兩家 AI 的鉤子只把「明確說拒絕」
// 當成擋，攔截器自己崩掉＝照常呼叫工具，錢的邊界靜靜失守，而安裝的人看到的是「已安裝」。
// 修法：tools/ 與 tests/ 各帶一份宣告 CommonJS 的 package.json（Node 認離檔案最近的那一份）。
//
// 守得到的：兩份宣告在、寫的是 commonjs；在 type:module 的父目錄底下，攔截器照樣印拒絕、合併指令照樣
//   回用法、考題照樣跑完全綠；對照組（同一個環境拿掉宣告）真的會崩——先證明這個環境真的會產生要防的現象。
// ⚠️ 守不到的：風格檢查（lint）不看 package.json，要在專案自己的 lint 設定另外說（套件倉庫 README「搬進一個專案」；README 不跟著搬進專案）；
//   專案的型別檢查要不要涵蓋套件檔；Node 22：套件倉庫本身沒有 Node 22 的執行環境（本機是較新的版本），搬進 personal-finance-webapp 之後在它的雲端 Node 22.23.1 跑過全綠（2026-09-15），別的專案要在自己的 Node 版本上跑一次。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CRASH = /require is not defined in ES module scope/u;

/**
 * 在暫存目錄搭一個「根目錄宣告 type:module 的專案」，把套件的 tools/（需要時連 tests/）原樣放進去。
 * 設定是考題自己給的未填版本，不讀本倉庫那份（填了真設定的專案跑這題，也不會碰到真環境）。
 */
function esmHost({ markers = true, withTests = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-placement-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'esm-host', private: true, type: 'module' }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ forbidden: { name: '未設定' }, mainBranch: '未設定', gates: [] }));
  fs.cpSync(path.join(ROOT, 'tools'), path.join(dir, 'tools'), { recursive: true });
  if (withTests) fs.cpSync(path.join(ROOT, 'tests'), path.join(dir, 'tests'), { recursive: true });
  if (!markers) {
    fs.rmSync(path.join(dir, 'tools', 'package.json'));
    if (withTests) fs.rmSync(path.join(dir, 'tests', 'package.json'));
  }
  return dir;
}

// ⚠️ 環境要拿掉 NODE_TEST_CONTEXT：考題跑在 node --test 底下時這個變數會被繼承，子行程再起 node --test
// 就改用「回報給上層」的模式，不管考題紅不紅都退 0（這一題的對照組第一次跑就抓到：拿掉宣告照樣退 0）。
const cleanEnv = { ...process.env };
delete cleanEnv.NODE_TEST_CONTEXT;
const run = (cwd, args, input = '') => spawnSync(process.execPath, args, { cwd, input, encoding: 'utf8', env: cleanEnv });
const probe = JSON.stringify({ tool_name: 'mcp__any__create_order' });

test('tools/ 與 tests/ 各帶一份宣告 CommonJS 的 package.json', () => {
  for (const dir of ['tools', 'tests']) {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    assert.equal(doc.type, 'commonjs', `${dir}/package.json 要宣告 type:commonjs`);
  }
});

test('對照組：type:module 的專案裡拿掉宣告，攔截器真的崩（退 1、什麼都不印）', () => {
  const dir = esmHost({ markers: false });
  try {
    const r = run(dir, ['tools/forbidden-tools.js'], probe);
    assert.equal(r.status, 1, `沒崩：這一題自己的前提變了（stderr：${r.stderr}）`);
    assert.equal(r.stdout, '', '崩掉的攔截器不會印拒絕');
    assert.match(r.stderr, CRASH, '崩的原因要是模組型別，不是別的');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('type:module 的專案裡：攔截器照樣印拒絕、合併指令照樣回用法', () => {
  const dir = esmHost();
  try {
    const guard = run(dir, ['tools/forbidden-tools.js'], probe);
    assert.equal(guard.status, 0, guard.stderr);
    assert.equal(JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const merge = run(dir, ['tools/merge.js']);
    assert.equal(merge.status, 2, merge.stderr);
    assert.match(merge.stdout, /用法/u);
    for (const r of [guard, merge]) assert.doesNotMatch(r.stderr, CRASH);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('type:module 的專案裡：套件的考題照樣跑完（對照組：拿掉宣告就崩）', () => {
  const ok = esmHost({ withTests: true });
  const bad = esmHost({ withTests: true, markers: false });
  try {
    const good = run(ok, ['--test', 'tests/time-point.test.js']);
    assert.equal(good.status, 0, `${good.stdout}\n${good.stderr}`);
    const broken = run(bad, ['--test', 'tests/time-point.test.js']);
    assert.notEqual(broken.status, 0, '拿掉宣告還是綠：這一題自己的前提變了');
    assert.match(`${broken.stdout}${broken.stderr}`, CRASH);
  } finally {
    fs.rmSync(ok, { recursive: true, force: true });
    fs.rmSync(bad, { recursive: true, force: true });
  }
});
