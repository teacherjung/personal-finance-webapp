// @ts-check
// 複審聯集閘的**真 CLI 出口**考題（2026-08-02，#385 r2 依 Codex r1 Medium③ 補）。
//
// ⚠️ 為什麼非要另開一支測 CLI：r1 的 12 題全部只測純函式，
// Codex 把 `main()` 阻擋分支的 `return 1` 突變成 `return 0`——**12/12 照樣全綠**，
// 而實跑會「終端印出未通過、退出碼卻是 0」。掛進合併程序就是一道永遠放行的假閘。
//
// **退出碼才是這支腳本對外的介面**，不是它的內部函式。
// 判準用假 `gh` 子行程走完整入口（比照 `test/merge-gate.test.js` 的做法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/check-review-verdicts.js');
const HEAD = 'aabbccdd11223344556677889900aabbccddeeff';

/** 造一支假的 `gh`，讓腳本走完整的真實路徑（不是 stub 掉它的內部函式）。 @param {string} stdout */
function withFakeGh(stdout, { exitCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${exitCode}\n`);
  chmodSync(gh, 0o755);
  return spawnSync(process.execPath, [SCRIPT, '385'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

/** @param {string} src @param {number} round @param {string} verdict */
const header = (src, round, verdict, sha = HEAD.slice(0, 7)) =>
  `🤖 Claude｜來源：${src}｜審 ${sha}｜r${round}｜結論：${verdict}`;
const payload = (/** @type {string[]} */ bodies) =>
  JSON.stringify({ comments: bodies.map((b) => ({ body: b })), headRefOid: HEAD });

test('CLI｜有人對目前 head 說「通過」、沒有未撤銷的阻擋 → exit 0', () => {
  const r = withFakeGh(payload([header('桌面 A', 1, '通過')]));
  assert.equal(r.status, 0, `預期 0，實得 ${r.status}\n${r.stdout}${r.stderr}`);
});

test('⭐ CLI｜有未撤銷的阻擋 → exit **1**（r1 把 return 1 改成 0，12 題全綠）', () => {
  const r = withFakeGh(payload([
    header('桌面 A', 1, '需修改後再審'),
    header('桌面 B', 1, '通過'),
  ]));
  assert.equal(r.status, 1, `預期 1，實得 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /未通過/);
});

test('CLI｜完全沒有正式結論 → exit 1（不是放行）', () => {
  const r = withFakeGh(payload(['這支等 #382 合併之後再 rebase']));
  assert.equal(r.status, 1, `「沒人審」被放行了——那比 main 原本的人工確認還退步。實得 ${r.status}`);
  assert.match(r.stderr, /沒有任何一位審查者/);
});

test('CLI｜gh 失敗 → exit 2（fail-closed）', () => {
  const r = withFakeGh('{}', { exitCode: 1 });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

test('CLI｜gh 回傳不是 JSON → exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, '#!/bin/sh\necho "not json"\n');
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, '385'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

test('CLI｜gh 回傳形狀不對（缺 headRefOid）→ exit 2', () => {
  const r = withFakeGh(JSON.stringify({ comments: [] }));
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

test('CLI｜沒給 PR 編號 → exit 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});
