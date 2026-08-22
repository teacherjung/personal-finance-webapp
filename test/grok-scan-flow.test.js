// @ts-check
// grok-scan.js 主流程的行為考題（2026-08-22，Codex #496 r1：「沒有任何考題執行 grok-scan.js 的控制流，只有路徑字串」）。
//
// 用假的 grok／轉送器／session 根目錄跑 runScan()，考每一條 fail-closed 路徑**真的退 2**，
// 而不是像第一版那樣：Grok 沒跑、轉送器中途死、零 session——全部退 0。
//
// ⚠️ 誠實劃界：
// ・這些題在**非 macOS** 會在「金絲雀」那一步退 2（沙箱套不上）——那正是 fail-closed，所以
//   「金絲雀之前」的路徑（版本不符、盒子壞）在 CI 也考得到；「金絲雀之後」的路徑（轉送器、grok、
//   驗屍）只在 macOS 考得到，其他平台明確 skip。
// ・假 grok 不會真的連 xAI；它只回一段字。考的是主流程怎麼對待它的退出碼與輸出，不是掃描品質。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScan, EXPECTED_GROK_VERSION } from '../scripts/grok-scan.js';
import { canApplySandbox } from '../scripts/grok-sandbox-canary.js';

const SANDBOX_OK = (() => { const d = mkdtempSync('/private/tmp/grok-flow-cap-'); try { return canApplySandbox(d).ok; } finally { rmSync(d, { recursive: true, force: true }); } })();
const SKIP_AFTER_CANARY = '金絲雀之後的路徑只在套得上沙箱的 macOS 考得到（這台套不上；金絲雀自己會退 2＝fail-closed）';

/** 一個最小的真 git repo（有一顆 commit），當 runScan 的 repo。 */
function tinyRepo() {
  const d = mkdtempSync(join(tmpdir(), 'grok-flow-repo-'));
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x', GIT_DIR: undefined } });
  git(['init', '-q']);
  writeFileSync(join(d, 'a.txt'), 'hello\n');
  mkdirSync(join(d, 'node_modules', 'eslint'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'eslint', 'package.json'), '{}');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'one']);
  const head = git(['rev-parse', 'HEAD']).trim();
  writeFileSync(join(d, 'a.txt'), 'hello world\n');
  git(['commit', '-q', '-am', 'two']);
  const head2 = git(['rev-parse', 'HEAD']).trim();
  return { dir: d, base: head, head: head2 };
}

/**
 * 假的 GROK_HOME：bin/grok 是一支 shell script（--version 回指定版本，-p 時照指定退出碼與輸出）、
 * sessions/ 是空的日誌根。放在 GROK_HOME 是因為沙箱只放行那裡——假 grok 放在 tmpdir() 會被沙箱
 * 正確擋住（126），那是沙箱做對，不是考題該繞的。
 */
function fakeGrok(/** @type {{ version?: string, status?: number, reply?: string }} */ o = {}) {
  const d = mkdtempSync(join(tmpdir(), 'fake-grok-home-'));
  mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions'));
  const p = join(d, 'bin', 'grok');
  writeFileSync(p, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${o.version ?? EXPECTED_GROK_VERSION + ' (fake)'}"; exit 0; fi
printf '%s' "${(o.reply ?? 'FAKE-REPLY').replace(/'/g, "'\\''")}"
exit ${o.status ?? 0}
`);
  chmodSync(p, 0o755);
  return d;   // 回傳 GROK_HOME，不是執行檔
}

/** 假轉送器：印 READY 然後活著；或照指定行為死掉。 */
function fakeRelay(/** @type {'ok' | 'die-before-ready' | 'die-after-ready'} */ mode = 'ok') {
  const d = mkdtempSync(join(tmpdir(), 'fake-relay-'));
  const p = join(d, 'relay.js');
  writeFileSync(p, mode === 'die-before-ready' ? 'process.exit(1);'
    : mode === 'die-after-ready' ? "process.stdout.write('READY 1\\n'); setTimeout(() => process.exit(1), 200);"
    : "process.stdout.write('READY 1\\n'); setInterval(() => {}, 1000);");
  return p;
}

function promptFile() { const d = mkdtempSync(join(tmpdir(), 'fake-prompt-')); const p = join(d, 'p.txt'); writeFileSync(p, '【界線】測試用\n'); return p; }
const quiet = { log: () => {} };

test('runScan｜base／head 不是寫死 SHA → 2（條款：不可用會移動的名稱）', async () => {
  const r = await runScan({ base: 'origin/main', head: 'HEAD', promptFile: promptFile() }, { ...quiet, grokHome: fakeGrok() });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /寫死的 SHA/);
});

test('runScan｜grok 版本不符 → 2（條款：版本不同＝當未跑；轉送器目的地是從該版本 strings 出來的）', async () => {
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, repo: repo.dir, grokHome: fakeGrok({ version: 'grok 9.9.9' }) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /版本不符/);
});

test('runScan｜grok --version 本身失敗 → 2（不是靜靜當作版本對）', async () => {
  const repo = tinyRepo();
  const d = mkdtempSync(join(tmpdir(), 'fake-grok-bad-')); mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions'));
  writeFileSync(join(d, 'bin', 'grok'), '#!/bin/sh\nexit 3\n'); chmodSync(join(d, 'bin', 'grok'), 0o755);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, repo: repo.dir, grokHome: d });
  assert.equal(r.code, 2);
});

test('runScan｜node_modules 是 symlink（工作樹形狀）→ clone 後盒子裡必須是真目錄，不是 symlink', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // 把 tinyRepo 的 node_modules 換成 symlink 指向別處（模擬 AGENTS 規定的工作樹形狀）
  const repo = tinyRepo();
  const real = mkdtempSync(join(tmpdir(), 'real-nm-'));
  mkdirSync(join(real, 'eslint')); writeFileSync(join(real, 'eslint', 'package.json'), '{}');
  rmSync(join(repo.dir, 'node_modules'), { recursive: true });
  execFileSync('ln', ['-s', real, join(repo.dir, 'node_modules')]);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, repo: repo.dir, grokHome: fakeGrok(), relayScript: fakeRelay('die-before-ready') });
  // 會在轉送器那步退 2（假轉送器故意死）——但**不是**在 node_modules 那步退
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.summary.join('\n'), /node_modules/, 'symlink 的 node_modules 沒被正確 clone 成真目錄（cp -Rc 對 symlink operand 不跟隨＝Codex r1 實測）');
  assert.match(r.summary.join('\n'), /轉送器/);
});

test('runScan｜轉送器沒 READY 就死 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, repo: repo.dir, grokHome: fakeGrok(), relayScript: fakeRelay('die-before-ready') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /轉送器沒有 READY/);
});

test('runScan｜grok 退出碼非 0 → 2（第一版只印出來、照樣退 0）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, repo: repo.dir, grokHome: fakeGrok({ status: 1 }), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /grok 沒有正常結束/);
});

test('runScan｜grok 退 0 但回覆是空的 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, repo: repo.dir, grokHome: fakeGrok({ reply: '' }), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /回覆是空的/);
});

test('runScan｜grok 正常、但零 session 日誌 → 2（第一版 dirs=[] 直接走到 exit 0——Codex r1 實測）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, repo: repo.dir, grokHome: fakeGrok(), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /找不到這次的 session 日誌/);
});

test('runScan｜發射紀錄 launch.json 會留在盒子（事後能分辨「旗標失效」與「沒帶旗標」）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  /** @type {string[]} */ const logs = [];
  await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), repo: repo.dir, grokHome: fakeGrok(), relayScript: fakeRelay('ok') });
  const boxLine = logs.find((l) => l.startsWith('盒子：'));
  assert.ok(boxLine, '沒印盒子路徑');
  const box = boxLine.slice('盒子：'.length);
  const launch = JSON.parse(readFileSync(join(box, 'launch.json'), 'utf8'));
  assert.ok(launch.sbArgv.includes('-f'), '發射紀錄沒有沙箱參數');
  assert.ok(launch.grokArgv.includes('--disable-web-search'), '發射紀錄沒有 grok 旗標');
  assert.equal(launch.env.HOME, box, '發射紀錄的 env.HOME 不是盒子');
  assert.match(launch.profileSha256, /^[0-9a-f]{64}$/);
  assert.ok(!('GITHUB_TOKEN' in launch.env) && !('ANTHROPIC_API_KEY' in launch.env), 'env 白名單漏了 token 類變數');
});
