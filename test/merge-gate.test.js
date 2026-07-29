// @ts-check
// 堆疊閘的行為考題（#353 r3）。
// r1 教訓：掃文件關鍵字的考題被 HTML 註解繞過。→ r2 改鎖腳本行為（假 gh）。
// r2 教訓（Codex 實際示範兩招）：
//   ・假 gh 只認 $1/$2 不驗其餘引數——把腳本的 `--base <head>` 突變成寫死的錯分支，13/13 仍綠，
//     而變造後的腳本會把真實 #342 放行。→ r3 假 gh 對**完整 argv 整串比對**，不符退出 65。
//     這同時把 gh 呼叫形狀鎖成契約：改 --limit 或欄位清單＝考題紅＝要「刻意」改兩邊，防無聲漂移。
//   ・`gh pr list` 回 `{}`（合法 JSON、錯形狀）→ `dependents.length` 是 undefined → 放行。
//     → r3 腳本加形狀驗證（isPrInfo／isDependentList），不符一律退出碼 2 fail-closed，考題釘住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGate, isPrInfo, isDependentList } from '../scripts/check-pr-merge-gate.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'check-pr-merge-gate.js');

// ---- 純判斷層 --------------------------------------------------------------

test('閘·純函式：base=main 且無上層 PR → 放行（code 0）', () => {
  const r = evaluateGate({ baseRefName: 'main', headRefName: 'fix/x', isCrossRepository: false }, []);
  assert.equal(r.code, 0);
});

test('閘·純函式：base 不是 main → 擋（2026-07-28 #311/#312 的死法）', () => {
  const r = evaluateGate({ baseRefName: 'fix/xlsx-resource-limits', headRefName: 'deps/xlsx-0.20.3', isCrossRepository: false }, []);
  assert.equal(r.code, 1);
  assert.ok(r.reason.includes('fix/xlsx-resource-limits'), '訊息要點名錯的 base，使用者才知道要改哪裡');
});

test('閘·純函式：有 open PR 疊在本支上面 → 擋（2026-07-10 #3/#5 的死法）', () => {
  const r = evaluateGate({ baseRefName: 'main', headRefName: 'fix/xlsx-resource-limits', isCrossRepository: false }, [{ number: 346 }]);
  assert.equal(r.code, 1);
  assert.ok(r.reason.includes('346'), '訊息要點名會被連帶關閉的 PR 編號');
});

test('閘·純函式：跨 fork → 查不清楚（code 2），不硬判', () => {
  const r = evaluateGate({ baseRefName: 'main', headRefName: 'main', isCrossRepository: true }, []);
  assert.equal(r.code, 2);
});

// ---- 形狀驗證層（Codex r2 blocking 2：合法但錯形的 JSON 曾 fail-open）----

test('閘·形狀：pr list 回 {} 不是陣列 → isDependentList 拒收（r2 的原 PoC）', () => {
  assert.equal(isDependentList(JSON.parse('{}')), false);
  assert.equal(isDependentList([{ number: 346 }]), true);
  assert.equal(isDependentList([{ number: '346' }]), false, 'number 是字串＝形狀錯，不可含混放過');
  assert.equal(isDependentList([null]), false);
});

test('閘·形狀：pr view 缺欄或型別錯 → isPrInfo 拒收', () => {
  assert.equal(isPrInfo({ baseRefName: 'main', headRefName: 'fix/x', isCrossRepository: false }), true);
  assert.equal(isPrInfo({ baseRefName: 'main', headRefName: 'fix/x' }), false, '缺 isCrossRepository＝判不了跨 fork，不可默認 false');
  assert.equal(isPrInfo({ baseRefName: '', headRefName: 'fix/x', isCrossRepository: false }), false, '空字串 base 進 !== main 分支會誤判成堆疊——形狀層就擋');
  assert.equal(isPrInfo(null), false);
});

// ---- 端到端（假 gh，走真的 PATH 解析）------------------------------------
// 假 gh 對**完整 argv 整串比對**（r3）：腳本呼叫 gh 的形狀是契約的一部分，
// 任何引數漂移（--base 換掉、--limit 改掉、欄位清單變動）＝假 gh 退出 65 → 閘退出 2 → 考題紅。

/**
 * @param {{ mode?: string, view?: string, list?: string, expectBase?: string }} scenario
 */
function runGate(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  writeFileSync(
    join(dir, 'gh'),
    '#!/bin/sh\n'
      + 'if [ "$GH_FAKE_MODE" = "fail" ]; then echo boom >&2; exit 1; fi\n'
      + 'if [ "$1 $2" = "pr view" ]; then\n'
      + '  if [ "$*" != "pr view 342 --json baseRefName,headRefName,isCrossRepository" ]; then\n'
      + '    echo "fake gh: unexpected view argv: $*" >&2; exit 65\n'
      + '  fi\n'
      + '  printf \'%s\' "$GH_FAKE_VIEW"; exit 0\n'
      + 'fi\n'
      + 'if [ "$1 $2" = "pr list" ]; then\n'
      + '  if [ "$*" != "pr list --state open --base $GH_FAKE_EXPECT_BASE --json number --limit 200" ]; then\n'
      + '    echo "fake gh: unexpected list argv: $*" >&2; exit 65\n'
      + '  fi\n'
      + '  printf \'%s\' "$GH_FAKE_LIST"; exit 0\n'
      + 'fi\n'
      + 'exit 64\n'
  );
  chmodSync(join(dir, 'gh'), 0o755);
  return spawnSync(process.execPath, [SCRIPT, '342'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GH_FAKE_MODE: scenario.mode ?? '',
      GH_FAKE_VIEW: scenario.view ?? '',
      GH_FAKE_LIST: scenario.list ?? '',
      GH_FAKE_EXPECT_BASE: scenario.expectBase ?? '',
    },
  });
}

test('閘·端到端：正常（base=main、無上層）→ 退出碼 0', () => {
  const r = runGate({
    view: JSON.stringify({ baseRefName: 'main', headRefName: 'fix/ok', isCrossRepository: false }),
    list: '[]',
    expectBase: 'fix/ok', // 假 gh 會驗腳本真的拿 view 的 head 去查——查別的分支＝65＝考題紅
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('非堆疊'));
});

test('閘·端到端：#346 式（base 不是 main）→ 退出碼 1', () => {
  const r = runGate({
    view: JSON.stringify({ baseRefName: 'fix/xlsx-resource-limits', headRefName: 'deps/xlsx-0.20.3', isCrossRepository: false }),
    list: '[]',
    expectBase: 'deps/xlsx-0.20.3',
  });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('不是 main'), '要講清楚是 base 方向的堆疊');
});

test('閘·端到端：#342 式（#346 疊在上面）→ 退出碼 1 且點名 #346', () => {
  const r = runGate({
    view: JSON.stringify({ baseRefName: 'main', headRefName: 'fix/xlsx-resource-limits', isCrossRepository: false }),
    list: JSON.stringify([{ number: 346 }]),
    expectBase: 'fix/xlsx-resource-limits',
  });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('346'));
});

test('閘·端到端：gh 掛掉 → 退出碼 2（fail-closed，不把「查不到」當「安全」）', () => {
  const r = runGate({ mode: 'fail' });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('不准合併'));
});

test('閘·端到端：gh 回非 JSON → 退出碼 2（fail-closed）', () => {
  const r = runGate({ view: 'gh: command timed out', list: '[]' });
  assert.equal(r.status, 2);
});

test('閘·端到端：pr list 回 {}（合法 JSON、錯形狀）→ 退出碼 2，不是放行（Codex r2 的原 PoC）', () => {
  const r = runGate({
    view: JSON.stringify({ baseRefName: 'main', headRefName: 'fix/shape', isCrossRepository: false }),
    list: '{}',
    expectBase: 'fix/shape',
  });
  assert.equal(r.status, 2, `r2 的洞：{} 的 .length 是 undefined → 曾判「無上層」放行。stdout=${r.stdout}`);
  assert.ok(r.stderr.includes('形狀'), '訊息要講明是形狀問題，不是 gh 掛掉');
});

test('閘·端到端：pr view 缺 isCrossRepository → 退出碼 2（缺欄不可默認）', () => {
  const r = runGate({
    view: JSON.stringify({ baseRefName: 'main', headRefName: 'fix/shape' }),
    list: '[]',
    expectBase: 'fix/shape',
  });
  assert.equal(r.status, 2);
});
