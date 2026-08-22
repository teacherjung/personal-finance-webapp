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
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScan, EXPECTED_GROK_VERSION } from '../scripts/grok-scan.js';
import { canApplySandbox } from '../scripts/grok-sandbox-canary.js';
import { injectDirtyGitEnv, assertChildGitEnvCleanAsync } from './helpers/dirty-git-env.js';

const SANDBOX_OK = (() => { const d = mkdtempSync('/private/tmp/grok-flow-cap-'); try { return canApplySandbox(d).ok; } finally { rmSync(d, { recursive: true, force: true }); } })();
const SKIP_AFTER_CANARY = '金絲雀之後的路徑只在套得上沙箱的 macOS 考得到（這台套不上；金絲雀自己會退 2＝fail-closed）';

/** 沙盒專用環境：**從零組**，不是從 process.env 扣（鐵則 11；Codex r2 抓到 r1 版是 `{...process.env, GIT_DIR: undefined}`——
 *  從 linked worktree 的 pre-push 跑時會把 GIT_WORK_TREE／GIT_CONFIG_* 整族帶進 `git init`，正是 AGENTS 記載過把共用 config 寫成 bare 的事故形狀）。 */
const CLEAN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' };

/** 一個最小的真 git repo（有一顆 commit），當 runScan 的 repo。 */
function tinyRepo() {
  const d = mkdtempSync(join(tmpdir(), 'grok-flow-repo-'));
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', env: CLEAN_ENV });
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
 * 假的 grok **安裝樹**（GROK_INSTALL）：bin/grok 是一支 shell script（--version 回指定版本，-p 時照指定退出碼與輸出）。
 * runScan 會把它 APFS clone 進盒子當 GROK_HOME。放在 GROK_INSTALL 是因為沙箱只放行那裡（唯讀）——
 * 假 grok 放在 tmpdir() 會被沙箱正確擋住（126），那是沙箱做對，不是考題該繞的。
 * 預設寫一個會把 session 日誌寫進 $GROK_HOME/sessions/ 的假 grok（驗屍要讀得到）。
 */
function fakeGrok(/** @type {{ version?: string, status?: number, reply?: string, noSession?: boolean }} */ o = {}) {
  const d = mkdtempSync(join(tmpdir(), 'fake-grok-install-'));
  mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions')); writeFileSync(join(d, 'config.toml'), ''); writeFileSync(join(d, 'auth.json'), '{"fake":true}');
  const p = join(d, 'bin', 'grok');
  const session = o.noSession ? '' : `
ws="$GROK_HOME/sessions/$(printf '%s' "$PWD" | /usr/bin/sed 's|/|%2F|g')"; mkdir -p "$ws/fake-session" && printf '{"type":"assistant","content":"x"}\n' > "$ws/fake-session/updates.jsonl"`;
  writeFileSync(p, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok ${o.version ?? EXPECTED_GROK_VERSION} (fake)"; exit 0; fi${session}
printf '%s' "${(o.reply ?? 'FAKE-REPLY').replace(/'/g, "'\\''")}"
exit ${o.status ?? 0}
`);
  chmodSync(p, 0o755);
  return d;   // 回傳 GROK_INSTALL，不是執行檔
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
/** 每題獨立的沙箱 auth 目錄與結果根（絕不碰真的 ~/.grok-sandbox-auth／~/.grok-scan-results） */
const isolated = () => ({ authDir: mkdtempSync(join(tmpdir(), 'fake-auth-')), resultsRoot: mkdtempSync(join(tmpdir(), 'fake-results-')) });
const quiet = { log: () => {} };

test('runScan｜base／head 不是寫死 SHA → 2（條款：不可用會移動的名稱）', async () => {
  const r = await runScan({ base: 'origin/main', head: 'HEAD', promptFile: promptFile() }, { ...quiet, ...isolated(), grokInstall: fakeGrok() });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /寫死的 SHA/);
});

test('runScan｜grok 版本不符 → 2（條款：版本不同＝當未跑；轉送器目的地是從該版本 strings 出來的）', async () => {
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: fakeGrok({ version: 'grok 9.9.9' }) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /版本不符/);
});

test('runScan｜版本要**精確等於**，前綴不算（r2：wrapper 印 "grok 1.0.3-evil" 就能過 startsWith）', async () => {
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: fakeGrok({ version: EXPECTED_GROK_VERSION + '-evil' }) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /版本不符/);
});

test('runScan｜grok --version 本身失敗 → 2（不是靜靜當作版本對）', async () => {
  const repo = tinyRepo();
  const d = mkdtempSync(join(tmpdir(), 'fake-grok-bad-')); mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions')); writeFileSync(join(d, 'auth.json'), '{}');
  writeFileSync(join(d, 'bin', 'grok'), '#!/bin/sh\nexit 3\n'); chmodSync(join(d, 'bin', 'grok'), 0o755);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: d });
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
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: fakeGrok(), relayScript: fakeRelay('die-before-ready') });
  // 會在轉送器那步退 2（假轉送器故意死）——但**不是**在 node_modules 那步退
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.summary.join('\n'), /node_modules/, 'symlink 的 node_modules 沒被正確 clone 成真目錄（cp -Rc 對 symlink operand 不跟隨＝Codex r1 實測）');
  assert.match(r.summary.join('\n'), /轉送器/);
});

test('runScan｜轉送器沒 READY 就死 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: fakeGrok(), relayScript: fakeRelay('die-before-ready') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /轉送器沒有 READY/);
});

test('runScan｜轉送器 READY 之後、grok 結束前死掉 → 2（r2：r1 寫成 relayDead && grok≠0，假 grok 回 0 就放過）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  // 假 grok 睡 1 秒再回 0；假轉送器 READY 後 200ms 死——grok 結束時轉送器已死，必須退 2
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace("printf '%s'", "sleep 1; printf '%s'"));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: inst, relayScript: fakeRelay('die-after-ready') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /轉送器在掃描結束前死了/);
});

test('runScan｜正常路徑：→ 0；盒子（含憑證副本）掃完清掉、結果包只留 launch.json＋sessions、真安裝樹沒被寫', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const inst = fakeGrok();
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, grokInstall: inst, relayScript: fakeRelay('ok') });
  assert.equal(r.code, 0, r.summary.join('\n'));
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  // r3：盒子（含憑證副本）掃完必須**不在**；結果包（去機密）必須在
  assert.ok(!existsSync(box), `盒子掃完還留在 /private/tmp（裡面有 auth.json 副本）：${box}`);
  const resultsLine = r.summary.find((l) => l.includes('結果包=')) || '';
  const resultsDir = /結果包=([^（]+)/.exec(resultsLine)?.[1];
  assert.ok(resultsDir && existsSync(join(resultsDir, 'launch.json')), '結果包裡沒有 launch.json');
  assert.ok(resultsDir && existsSync(join(resultsDir, 'sessions')), '結果包裡沒有 sessions/');
  assert.ok(resultsDir && !existsSync(join(resultsDir, 'auth.json')), '結果包裡有 auth.json——憑證不該留在結果包');
  assert.ok(!existsSync(join(inst, 'sessions', 'fake-session')) && readdirSync(join(inst, 'sessions')).length === 0, '真安裝樹的 sessions/ 被寫了——GROK_HOME 沒有指進盒子');
});

test('runScan｜grok 退出碼非 0 → 2（第一版只印出來、照樣退 0）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: fakeGrok({ status: 1 }), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /grok 沒有正常結束/);
});

test('runScan｜grok 退 0 但回覆是空的 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: fakeGrok({ reply: '' }), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /回覆是空的/);
});

test('runScan｜grok 正常、但零 session 日誌 → 2（第一版 dirs=[] 直接走到 exit 0——Codex r1 實測）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: fakeGrok({ noSession: true }), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /找不到這次的 session 日誌/);
});

test('runScan｜鐵則 11：髒的 GIT_* 環境下 git archive／diff 仍對（答案題）＋子行程實收環境乾淨（探針題）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const restore = injectDirtyGitEnv();
  try {
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: fakeGrok(), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, '髒 GIT_* 環境讓 runScan 壞掉：' + r.summary.join('\n'));
  } finally { restore(); }
  await assertChildGitEnvCleanAsync(assert, 'grok-scan 的 git archive／diff', async () => {
    await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: fakeGrok(), relayScript: fakeRelay('die-before-ready') });
  });
});

test('runScan｜發射紀錄 launch.json 留在結果包（事後能分辨「旗標失效」與「沒帶旗標」；盒子本身已清）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, grokInstall: fakeGrok(), relayScript: fakeRelay('ok') });
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  const resultsDir = /結果包=([^（]+)/.exec(r.summary.find((l) => l.includes('結果包=')) || '')?.[1];
  assert.ok(resultsDir, '沒印結果包路徑');
  const launch = JSON.parse(readFileSync(join(resultsDir, 'launch.json'), 'utf8'));
  assert.ok(launch.sbArgv.includes('-f'), '發射紀錄沒有沙箱參數');
  assert.ok(launch.grokArgv.includes('--disable-web-search') && launch.grokArgv.includes('--no-subagents'), '發射紀錄沒有 grok 旗標');
  assert.equal(launch.env.HOME, box, '發射紀錄的 env.HOME 不是盒子');
  assert.equal(launch.env.GROK_HOME, join(box, 'grok-home'), '發射紀錄的 env.GROK_HOME 不是盒內副本');
  assert.match(launch.profileSha256, /^[0-9a-f]{64}$/);
  assert.ok(!('GITHUB_TOKEN' in launch.env) && !('ANTHROPIC_API_KEY' in launch.env), 'env 白名單漏了 token 類變數');
});

test('runScan｜每一條失敗出口都清盒子：轉送器沒 READY／grok 非 0／零 session 三條，盒子掃完都不在', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const cases = [
    ['轉送器沒 READY', { grokInstall: fakeGrok(), relayScript: fakeRelay('die-before-ready') }],
    ['grok 非 0', { grokInstall: fakeGrok({ status: 1 }), relayScript: fakeRelay('ok') }],
    ['零 session', { grokInstall: fakeGrok({ noSession: true }), relayScript: fakeRelay('ok') }],
  ];
  for (const [name, extra] of /** @type {[string, object][]} */ (cases)) {
    const repo = tinyRepo();
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, ...extra });
    assert.equal(r.code, 2, `${name}：該退 2`);
    const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
    assert.ok(box, `${name}：沒印盒子路徑`);
    assert.ok(!existsSync(box), `${name}：失敗後盒子（含 auth.json 副本）還留在 ${box}`);
  }
});

test('runScan｜驗屍查到破口線索（日誌裡出現私鑰標頭這種盒子外才有的形狀）→ 1＝事故，不是 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  // 假 grok 把一段「BEGIN RSA PRIVATE KEY」寫進 session 日誌——模擬「它讀到了盒子外的東西並回錄」。
  // 不用活金絲雀的暗號：那要在正式程式留測試鉤子把暗號塞進盒子，鉤子本身就是洞。驗屍認得的另一種形狀同樣走 code 1。
  const inst = fakeGrok();
  const before = readFileSync(join(inst, 'bin', 'grok'), 'utf8');
  const after = before.replace('"content":"x"', '"content":"-----BEGIN RSA PRIVATE KEY-----"');
  assert.notEqual(after, before, '假 grok 改寫沒套上');
  writeFileSync(join(inst, 'bin', 'grok'), after);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: inst, relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /沙箱破了/);
});
