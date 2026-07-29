// @ts-check
// 堆疊閘的行為考題（#353 r2）。r1 的教訓：掃文件關鍵字的考題被 HTML 註解繞過（Codex 實際示範 3/3 綠）——
// 所以這裡鎖的是**腳本的行為**：純函式層直測＋端到端用假 gh 跑整支腳本（連 PATH 解析都走真的）。
// 五個情境對應四種真實世界：正常放行／#346 式（base 不是 main）／#342 式（有人疊上面）／
// gh 掛掉／gh 回垃圾——後兩種必須 fail-closed（退出碼 2），「查不到」不等於「安全」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGate } from '../scripts/check-pr-merge-gate.js';

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

// ---- 端到端（假 gh，走真的 PATH 解析）------------------------------------

/**
 * @param {{ mode?: string, view?: string, list?: string }} scenario
 */
function runGate(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  writeFileSync(
    join(dir, 'gh'),
    '#!/bin/sh\n'
      + 'if [ "$GH_FAKE_MODE" = "fail" ]; then echo boom >&2; exit 1; fi\n'
      + 'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf \'%s\' "$GH_FAKE_VIEW"; exit 0; fi\n'
      + 'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf \'%s\' "$GH_FAKE_LIST"; exit 0; fi\n'
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
    },
  });
}

test('閘·端到端：正常（base=main、無上層）→ 退出碼 0', () => {
  const r = runGate({
    view: JSON.stringify({ baseRefName: 'main', headRefName: 'fix/ok', isCrossRepository: false }),
    list: '[]',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('非堆疊'));
});

test('閘·端到端：#346 式（base 不是 main）→ 退出碼 1', () => {
  const r = runGate({
    view: JSON.stringify({ baseRefName: 'fix/xlsx-resource-limits', headRefName: 'deps/xlsx-0.20.3', isCrossRepository: false }),
    list: '[]',
  });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('不是 main'), '要講清楚是 base 方向的堆疊');
});

test('閘·端到端：#342 式（#346 疊在上面）→ 退出碼 1 且點名 #346', () => {
  const r = runGate({
    view: JSON.stringify({ baseRefName: 'main', headRefName: 'fix/xlsx-resource-limits', isCrossRepository: false }),
    list: JSON.stringify([{ number: 346 }]),
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
