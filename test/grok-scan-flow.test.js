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
import { runScan, SESSION_CAPS, EXPECTED_GROK_VERSION } from '../scripts/grok-scan.js';
import { canApplySandbox } from '../scripts/grok-sandbox-canary.js';
import { injectDirtyGitEnv, assertChildGitEnvCleanAsync } from './helpers/dirty-git-env.js';
import { createHash } from 'node:crypto';
import { PINNED_ISSUER, PINNED_CLIENT_ID, DUMMY_BEARER_PREFIX } from '../scripts/grok-auth-refresh.js';

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
  mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions')); writeFileSync(join(d, 'config.toml'), ''); writeFileSync(join(d, 'auth.json'), fakeAuth());
  const p = join(d, 'bin', 'grok');
  const session = o.noSession ? '' : `
ws="$GROK_HOME/sessions/$(printf '%s' "$PWD" | /usr/bin/sed 's|/|%2F|g')"; mkdir -p "$ws/fake-session" && printf '{"type":"assistant","content":"x"}\n' > "$ws/fake-session/updates.jsonl"`;
  writeFileSync(p, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok ${o.version ?? EXPECTED_GROK_VERSION} (fake)"; exit 0; fi${session}
printf '%s' "${(o.reply ?? 'FAKE-REPLY').replace(/'/g, "'\\''")}" # REPLY-LINE
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
const isolated = () => ({ authDir: mkdtempSync(join(tmpdir(), 'fake-auth-')), resultsRoot: mkdtempSync(join(tmpdir(), 'fake-results-')), fetchImpl: noFetch });
/** 假 grok 的 sha256（r4：runScan 對盒內副本驗 hash；考題要把假 grok 自己的 hash 傳進去） */
const shaOf = (/** @type {string} */ installDir) => createHash('sha256').update(readFileSync(join(installDir, 'bin', 'grok'))).digest('hex');
const quiet = { log: () => {} };
/**
 * 假的 OIDC auth.json（跟真的同形：issuer／client_id／refresh_token／expires_at／key／user_id／create_time＋身分欄位）。
 * 預設到期在一天後＝不會觸發 refresh。email／first_name 是「沒給盒子」的欄位（r6：DLP 針；first_name 刻意放材料裡有的字）。
 */
const fakeAuth = (/** @type {{ key?: string, refresh?: string, expiresInMs?: number, issuer?: string, clientId?: string, extra?: Record<string, unknown> }} */ o = {}) => JSON.stringify({
  [`${o.issuer ?? PINNED_ISSUER}::${o.clientId ?? PINNED_CLIENT_ID}`]: {
    oidc_issuer: o.issuer ?? PINNED_ISSUER, oidc_client_id: o.clientId ?? PINNED_CLIENT_ID,
    key: o.key ?? 'ACCESS-TOKEN-VALUE-0123456789abcdef', refresh_token: o.refresh ?? 'REFRESH-TOKEN-VALUE-0123456789abcdef',
    expires_at: new Date(Date.now() + (o.expiresInMs ?? 86_400_000)).toISOString(), auth_mode: 'oidc',
    user_id: '0ed1fd13-5d15-4f01-9a1e-2d9cb2f1f111', create_time: '2026-08-01T00:00:00.000000Z',
    email: 'fake-owner@example.test', first_name: '測試用', ...(o.extra ?? {}),
  },
});
/** 不該被呼叫的 fetch（憑證還新時 refresh 不能發生） */
const noFetch = /** @type {typeof fetch} */ (async () => { throw new Error('不該呼叫 fetch：憑證還新'); });
/** 把假安裝樹與它的 hash 一起給 runScan */
const withGrok = (/** @type {string} */ inst) => ({ grokInstall: inst, expectedSha256: shaOf(inst) });

test('runScan｜base／head 不是寫死 SHA → 2（條款：不可用會移動的名稱）', async () => {
  const r = await runScan({ base: 'origin/main', head: 'HEAD', promptFile: promptFile() }, { ...quiet, ...isolated(), ...withGrok(fakeGrok()) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /寫死的 SHA/);
});

test('runScan｜grok 版本不符 → 2（條款：版本不同＝當未跑；轉送器目的地是從該版本 strings 出來的）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }   // r4：--version 改在沙箱內跑
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ version: 'grok 9.9.9' })) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /版本不符/);
});

test('runScan｜版本要**精確等於**，前綴不算（r2：wrapper 印 "grok 1.0.3-evil" 就能過 startsWith）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }   // r4：--version 改在沙箱內跑
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ version: EXPECTED_GROK_VERSION + '-evil' })) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /版本不符/);
});

test('runScan｜執行檔 sha256 不符 → 2，而且**不執行它**（r4 #5：版本字串是被檢者自己印的，wrapper 印對字串就過）', async () => {
  const repo = tinyRepo();
  const inst = fakeGrok();
  // 給一個錯的 hash；假 grok 若被執行會在安裝樹留下記號——斷言它沒被執行
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace('#!/bin/sh', '#!/bin/sh\ntouch "$(dirname "$0")/../EXECUTED"'));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: inst, expectedSha256: '0'.repeat(64) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /sha256 不符/);
  assert.ok(!existsSync(join(inst, 'EXECUTED')), 'hash 不符的執行檔還是被執行了');
});

test('runScan｜grok --version 本身失敗 → 2（不是靜靜當作版本對）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }   // r4：--version 改在沙箱內跑
  const repo = tinyRepo();
  const d = mkdtempSync(join(tmpdir(), 'fake-grok-bad-')); mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions')); writeFileSync(join(d, 'auth.json'), fakeAuth());
  writeFileSync(join(d, 'bin', 'grok'), '#!/bin/sh\nexit 3\n'); chmodSync(join(d, 'bin', 'grok'), 0o755);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(d) });
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
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
  // 會在轉送器那步退 2（假轉送器故意死）——但**不是**在 node_modules 那步退
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.summary.join('\n'), /node_modules/, 'symlink 的 node_modules 沒被正確 clone 成真目錄（cp -Rc 對 symlink operand 不跟隨＝Codex r1 實測）');
  assert.match(r.summary.join('\n'), /轉送器/);
});

test('runScan｜轉送器沒 READY 就死 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /轉送器沒有 READY/);
});

test('runScan｜轉送器 READY 之後、grok 結束前死掉 → 2（r2：r1 寫成 relayDead && grok≠0，假 grok 回 0 就放過）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  // 假 grok 睡 1 秒再回 0；假轉送器 READY 後 200ms 死——grok 結束時轉送器已死，必須退 2
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, "sleep 1; $1"));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('die-after-ready') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /轉送器在掃描結束前死了/);
});

test('runScan｜正常路徑：→ 0；盒子（含憑證副本）掃完清掉、結果包只留 launch.json＋sessions、真安裝樹沒被寫', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const inst = fakeGrok();
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
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
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ status: 1 })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /grok 沒有正常結束/);
});

test('runScan｜grok 退 0 但回覆是空的 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ reply: '' })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /回覆是空的/);
});

test('runScan｜grok 正常、但零 session 日誌 → 2（第一版 dirs=[] 直接走到 exit 0——Codex r1 實測）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ noSession: true })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /找不到這次的 session 日誌/);
});

test('runScan｜鐵則 11：髒的 GIT_* 環境下 git archive／diff 仍對（答案題）＋子行程實收環境乾淨（探針題）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const restore = injectDirtyGitEnv();
  try {
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, '髒 GIT_* 環境讓 runScan 壞掉：' + r.summary.join('\n'));
  } finally { restore(); }
  await assertChildGitEnvCleanAsync(assert, 'grok-scan 的 git archive／diff', async () => {
    await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
  });
});

test('runScan｜發射紀錄 launch.json 留在結果包（事後能分辨「旗標失效」與「沒帶旗標」；盒子本身已清）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
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
    ['轉送器沒 READY', { ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') }],
    ['grok 非 0', { ...withGrok(fakeGrok({ status: 1 })), relayScript: fakeRelay('ok') }],
    ['零 session', { ...withGrok(fakeGrok({ noSession: true })), relayScript: fakeRelay('ok') }],
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
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /沙箱破了/);
});

test('runScan｜--out 指到寫不進去的地方 → 退 2 且盒子仍清掉（r4 #4：r3 版在那裡 throw、盒子留著）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  /** @type {string[]} */ const logs = [];
  let threw = false;
  let r;
  try {
    r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: '/no/such/dir/reply.txt' }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
  } catch { threw = true; }
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  assert.ok(box, '沒印盒子路徑');
  assert.ok(!existsSync(box), `--out 寫失敗後盒子（含 auth.json 副本）還留在 ${box}`);
  // 允許 throw 或退 2——重點是盒子不在；但不可以退 0
  if (!threw) assert.notEqual(r?.code, 0, '--out 寫失敗還退 0');
});

test('runScan｜去機密（r5 broker 之後）：①grok 把盒內 auth.json 整個印進回覆＝只有 DUMMY、真 token 不在盒子、不算事故；②真 token 字面出現在回覆＝1、--out 不寫、sessions 不留', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const REAL = 'REAL-TOKEN-NEVER-IN-BOX-0123456789abcdef';
  // ① 盒內 auth.json 印進回覆：broker 讓盒內只有 DUMMY——回覆裡有 DUMMY、沒有真 token、code 0
  {
    const repo = tinyRepo(); const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'cat "$GROK_HOME/auth.json"; $1'));
    const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, r.summary.join('\n'));
    const reply = readFileSync(out, 'utf8');
    assert.ok(reply.includes(DUMMY_BEARER_PREFIX), '盒內 auth.json 的 key 不是 DUMMY——broker 沒生效');
    assert.ok(!reply.includes(REAL), '真 token 進了盒子');
  }
  // ② 真 token 字面出現在回覆（模擬任何別的洩漏路徑）→ DLP 抓到＝1
  {
    const repo = tinyRepo(); const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const inst = fakeGrok({ reply: `leaked: ${REAL}` });
    const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, r.summary.join('\n'));
    assert.match(r.summary.join('\n'), /去機密/);
    assert.ok(!existsSync(out), '憑證洩漏時 --out 還是寫了');
    assert.ok(!readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).includes('sessions/')), '憑證洩漏時 sessions 還是進了結果包');
  }
});

test('runScan｜憑證：盒內 auth.json **沒有 refresh_token**；還新＝不 refresh；到期＝父程序 refresh 並原子寫回；refresh 失敗＝不掃、舊檔原樣（r4 #3 由構造消失）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ① 還新：不呼叫 fetch；盒內 auth.json 沒有 refresh_token（假 grok 把它 cat 進回覆來驗）
  {
    const repo = tinyRepo(); const iso = isolated();
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'grep -c refresh_token "$GROK_HOME/auth.json" > "$GROK_HOME/has-refresh"; $1'));
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, r.summary.join('\n'));
    // 盒子已清；從假 grok 留在 sessions 的檔看不到 has-refresh——改用 launch.json 以外的證據：盒內 auth 是 forBox（去掉 refresh_token）
    // 直接驗 refreshSandboxAuth 的回傳形狀
    const { refreshSandboxAuth } = await import('../scripts/grok-auth-refresh.js');
    const a = await refreshSandboxAuth(iso.authDir, { fetchImpl: noFetch });
    assert.equal(a.refreshed, false);
    assert.ok(!JSON.stringify(a.forBox).includes('refresh_token'), '給盒子的版本還含 refresh_token');
    // r5 broker：盒內的 key 是假的（DUMMY 前綴），真 access token 不進盒子
    assert.ok(!JSON.stringify(a.forBox).includes('ACCESS-TOKEN-VALUE'), '真 access token 進了盒子——broker 沒生效');
    assert.ok(JSON.stringify(a.forBox).includes(DUMMY_BEARER_PREFIX), '盒內 key 不是 DUMMY');
  }
  // ② 到期：父程序 refresh（假 fetch 回新 token＋新 refresh_token），authDir 原子寫回；盒內拿到新 access token
  {
    const repo = tinyRepo(); const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ expiresInMs: -1000 }));
    let calls = 0;
    const okFetch = /** @type {typeof fetch} */ (async (u, init) => { calls++; assert.equal(String(u), `${PINNED_ISSUER}/oauth2/token`, 'refresh 沒送到釘住的 issuer'); const b = String(init?.body); assert.match(b, /grant_type=refresh_token/); assert.match(b, /REFRESH-TOKEN-VALUE/); assert.ok(b.includes(`client_id=${PINNED_CLIENT_ID}`), 'client_id 不是釘住的'); return new Response(JSON.stringify({ access_token: 'NEW-ACCESS-0123456789abcdef', refresh_token: 'NEW-REFRESH-0123456789abcdef', expires_in: 21600 }), { status: 200 }); });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, fetchImpl: okFetch, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, r.summary.join('\n'));
    assert.equal(calls, 1, 'refresh 該恰好呼叫一次');
    const saved = readFileSync(join(iso.authDir, 'auth.json'), 'utf8');
    assert.match(saved, /NEW-ACCESS/); assert.match(saved, /NEW-REFRESH/);
    assert.doesNotMatch(saved, /REFRESH-TOKEN-VALUE-0123/, '舊的 refresh_token 沒被輪替掉');
  }
  // ③ 到期但 refresh 失敗（HTTP 401）：不掃（2）、authDir 原樣、盒子清掉
  {
    const repo = tinyRepo(); const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); const before = fakeAuth({ expiresInMs: -1000 }); writeFileSync(join(iso.authDir, 'auth.json'), before);
    const badFetch = /** @type {typeof fetch} */ (async () => new Response('nope', { status: 401 }));
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, fetchImpl: badFetch, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 2);
    assert.match(r.summary.join('\n'), /refresh 失敗/);
    assert.equal(readFileSync(join(iso.authDir, 'auth.json'), 'utf8'), before, 'refresh 失敗卻動了 authDir');
    const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
    assert.ok(box && !existsSync(box), 'refresh 失敗後盒子沒清');
  }
});

test('runScan｜confused deputy：盒內 sessions 裡的 symlink 不被父程序跟隨（r4 #1）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const iso = isolated();
  // 盒外放一個機密檔；假 grok 在 sessions 裡放一個指向它的 symlink
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET-CONTENT');
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `ln -s "${join(outside, 'secret.txt')}" "$ws/fake-session/leak.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  // 日誌區出現 symlink＝Grok 在放捷徑＝事故（1），而且 sessions 不得進結果包
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /非 regular file/);
  const leaked = readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).endsWith('leak.jsonl') || String(f).includes('OUTSIDE-SECRET'));
  assert.ok(!leaked, '父程序跟隨了盒內 symlink、把盒外內容抄進結果包');
  // 盒外那個機密檔的內容也不可以出現在結果包的任何檔裡
  for (const f of readdirSync(iso.resultsRoot, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) assert.ok(!readFileSync(join(f.parentPath ?? f.path, f.name), 'utf8').includes('OUTSIDE-SECRET'), `結果包 ${f.name} 裡有盒外內容`);
  }
});

test('runScan｜r5 #2：auth.json 的 issuer 被改成別的網址 → 不 refresh、不掃（refresh_token 絕不送去非釘住的地方）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ issuer: 'https://attacker.example', expiresInMs: -1000 }));
  let called = false;
  const spyFetch = /** @type {typeof fetch} */ (async () => { called = true; return new Response('{}', { status: 200 }); });
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, fetchImpl: spyFetch, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /不等於釘住的/);
  assert.equal(called, false, 'refresh_token 被送去攻擊者的 issuer 了');
});

test('runScan｜r6 #4：config.toml／agent_id **不帶進盒子**；盒內 auth.json 只有白名單 7 欄＋假 key（email 等身分欄位不進去）——假 grok 把盒內 grok-home 列出來驗', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  writeFileSync(join(inst, 'config.toml'), 'poison = "CONFIG-POISON-VALUE"\n'); writeFileSync(join(inst, 'agent_id'), 'AGENT-ID-POISON');
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, '( printf "LS=[%s] " "$(ls "$GROK_HOME" | tr \'\\n\' \' \')"; cat "$GROK_HOME/config.toml" "$GROK_HOME/agent_id" "$GROK_HOME/auth.json" 2>/dev/null ) | tr \'\\n\' \' \'; $1'));
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 0, r.summary.join('\n'));
  const reply = readFileSync(out, 'utf8');
  assert.ok(!reply.includes('CONFIG-POISON'), 'config.toml 進了盒子');
  assert.ok(!reply.includes('AGENT-ID-POISON'), 'agent_id 進了盒子');
  const ls = /LS=\[([^\]]*)\]/.exec(reply)?.[1] || '';
  assert.deepEqual(ls.trim().split(/\s+/).sort(), ['auth.json', 'bin', 'sessions'], `盒內 grok-home 的檔不是白名單那三個：${ls}`);
  const json = /\{.*\}/.exec(reply)?.[0] || '';
  const entry = Object.values(JSON.parse(json))[0];
  assert.deepEqual(Object.keys(/** @type {object} */ (entry)).sort(), ['auth_mode', 'create_time', 'expires_at', 'key', 'oidc_client_id', 'oidc_issuer', 'user_id'], '盒內 auth.json 的欄位不是白名單那 7 個');
  assert.ok(!reply.includes('fake-owner@example.test'), 'email 進了盒子');
});

test('runScan｜r5 #1：失敗路徑全丟棄——grok 非 0 且把 token 寫進 stderr 與 session，結果包與 summary 都不得有 token', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: 'REAL-TOKEN-SHOULD-NEVER-LEAK-0123456789' }));
  const inst = fakeGrok({ status: 1 });
  // 假 grok：把「真 token」（它其實拿不到——盒內是 DUMMY；這裡直接寫字串模擬最壞情況）寫進 stderr 與 session，然後退 1
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'echo REAL-TOKEN-SHOULD-NEVER-LEAK-0123456789 >&2; echo REAL-TOKEN-SHOULD-NEVER-LEAK-0123456789 > "$ws/fake-session/updates.jsonl"; $1'));
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  const everything = logs.join('\n') + r.summary.join('\n') + readdirSync(iso.resultsRoot, { recursive: true, withFileTypes: true }).filter((f) => f.isFile()).map((f) => readFileSync(join(f.parentPath ?? f.path, f.name), 'utf8')).join('\n');
  assert.ok(!everything.includes('REAL-TOKEN-SHOULD-NEVER-LEAK'), '失敗路徑還是把 Grok 可控的輸出（stderr／session）留在 log 或結果包裡');
  assert.ok(!existsSync(join(iso.resultsRoot)) || !readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).includes('sessions/')), '失敗路徑還是把 sessions 抄進結果包');
});

test('runScan｜r5 #1：成功路徑、token 藏在巢狀 terminal/call-*.log → DLP 遞迴抓到、1、sessions 不留', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: 'REAL-TOKEN-IN-NESTED-LOG-0123456789' }));
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'mkdir -p "$ws/fake-session/terminal"; echo REAL-TOKEN-IN-NESTED-LOG-0123456789 > "$ws/fake-session/terminal/call-1.log"; $1'));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /去機密.*terminal\/call-1\.log/);
  assert.ok(!readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).includes('call-1.log')), '巢狀日誌還是進了結果包');
});

test('runScan｜r5 #3：假 grok 留一個背景 writer（stdio 關閉、主程序退 0）→ runScan 回來時整個程序群組已死', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  // 背景 writer：每 100ms 往 $GROK_HOME/sessions 寫一行，stdio 全關、setsid 不用（它本來就在 grok 的群組裡）
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, '( while :; do echo alive >> "$GROK_HOME/sessions/bg.txt"; sleep 0.1; done ) >/dev/null 2>&1 </dev/null & echo $! > "$GROK_HOME/bg.pid"; $1'));
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.notEqual(r.code, 2, r.summary.join('\n'));
  // 盒子已清，bg.pid 拿不到了——改用 ps 找那個 while 迴圈：盒子路徑出現在任何活程序的命令列＝還活著
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  const ps = execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' });
  assert.ok(!ps.includes(box), `runScan 回來後還有程序帶著盒子路徑在跑：${ps.split('\n').filter((l) => l.includes(box)).join(' | ').slice(0, 200)}`);
});

test('runScan｜r6 #6：DLP 真相來源（authDir/auth.json）在掃描中途讀不到 → 2、不保存（原本 catch 成空集合＝fail-open）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth());
  let pulled = false;
  // 金絲雀的第一行 log 出現時（refresh 已做完、DLP 還沒讀）把真相來源抽掉
  const log = (/** @type {string} */ m) => { if (!pulled && m.includes('🔴')) { pulled = true; rmSync(join(iso.authDir, 'auth.json')); } };
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(pulled, true, '考題沒抽到檔（時序變了？）');
  assert.equal(r.code, 2, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /DLP 真相來源/);
  assert.equal(readdirSync(iso.resultsRoot).flatMap((d) => readdirSync(join(iso.resultsRoot, d))).includes('sessions'), false, '真相來源讀不到還保存了 sessions');
});

test('runScan｜r6 #6：DLP 針按欄位取、不按內容形狀——email 出現在回覆＝1；已在材料裡的針（first_name）剔除並記錄、出現在回覆不算', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  // ① email（24 字以下、不是 token 形狀）出現在回覆 → 1
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth());
    const inst = fakeGrok({ reply: 'owner is fake-owner@example.test' });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `email 外流沒被當事故：${r.summary.join('\n')}`);
  }
  // ② 以 ISO 日期開頭的 credential（r5 會被「時間戳形狀」排除）→ 現在按欄位取，照抓
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: '2026-01-01T00:00:00Z-LOOKS-LIKE-A-DATE-BUT-IS-A-TOKEN' }));
    const inst = fakeGrok({ reply: 'leak 2026-01-01T00:00:00Z-LOOKS-LIKE-A-DATE-BUT-IS-A-TOKEN' });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `日期形狀的 token 外流沒被當事故：${r.summary.join('\n')}`);
  }
  // ③ first_name「測試用」在指示檔裡本來就有 → 針剔除、有 log；回覆含它 → 0
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth());
    const inst = fakeGrok({ reply: 'FAKE-REPLY 測試用' });
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, r.summary.join('\n'));
    assert.ok(logs.some((l) => l.includes('不採用')), '剔除材料裡已有的針時沒有記錄');
  }
});

test('runScan｜r6 #3：sessions 上限——檔數超過 → 2 且不保存；單檔超過 → 2 且不保存（父程序不再無界 readFileSync）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  for (const [label, shell, re] of /** @type {[string, string, RegExp][]} */ ([
    ['檔數', `i=0; while [ $i -le ${SESSION_CAPS.files} ]; do : > "$GROK_HOME/sessions/f$i"; i=$((i+1)); done; $1`, /檔數超過/],
    ['單檔', `/bin/dd if=/dev/zero of="$GROK_HOME/sessions/big" bs=1048576 count=${Math.ceil(SESSION_CAPS.fileBytes / 1048576) + 1} 2>/dev/null; $1`, /單檔超過/],
  ])) {
    const iso = isolated();
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, shell));
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 2, `${label}：${r.summary.join('\n')}`);
    assert.match(r.summary.join('\n'), re, label);
    assert.equal(readdirSync(iso.resultsRoot).flatMap((d) => readdirSync(join(iso.resultsRoot, d))).includes('sessions'), false, `${label}超限還保存了 sessions`);
    const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
    assert.ok(box && !existsSync(box), `${label}：盒子沒清`);
  }
});

test('runScan｜r6 #3：ulimit 真的套在盒內——假 grok 印 ulimit -f 並試寫 80MB，檔案被截在 64MB', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m,
    'printf "ULIMIT-F=%s " "$(ulimit -f)"; ( /bin/dd if=/dev/zero of="$GROK_HOME/big" bs=1048576 count=80 ) >/dev/null 2>&1; printf "BIG=%s " "$(/usr/bin/stat -f %z "$GROK_HOME/big")"; $1'));
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 0, r.summary.join('\n'));
  const reply = readFileSync(out, 'utf8');
  assert.match(reply, /ULIMIT-F=65536 /, `盒內 ulimit -f 不是 64MB：${reply.slice(0, 120)}`);
  assert.match(reply, /BIG=67108864 /, `80MB 的寫入沒被截在 64MB：${reply.slice(0, 120)}`);
});

test('runScan｜r6 #5：假值走 0600 檔給轉送器（不走 argv／env）、盒內 auth.json 的 key 就是那個值、掃完假值檔清掉', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'cat "$GROK_HOME/auth.json"; $1'));
  // 假轉送器：把 --dummy-file 的內容抄到自己目錄（考題之後比對），檔不在或形狀不對就不 READY
  const rd = mkdtempSync(join(tmpdir(), 'fake-relay-dummy-')); const relayScript = join(rd, 'relay.js');
  writeFileSync(relayScript, `const fs=require('node:fs');const i=process.argv.indexOf('--dummy-file');const f=i>=0?process.argv[i+1]:'';
if(!f||!fs.existsSync(f)||(fs.statSync(f).mode&0o077)!==0){process.exit(1)}
const v=fs.readFileSync(f,'utf8').trim();if(!v.startsWith('${DUMMY_BEARER_PREFIX}')||v.length<${DUMMY_BEARER_PREFIX.length}+32){process.exit(1)}
fs.writeFileSync(${JSON.stringify(join(rd, 'seen.txt'))},v);process.stdout.write('READY 1\\n');setInterval(()=>{},1000);`);
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript });
  assert.equal(r.code, 0, r.summary.join('\n'));
  const seen = readFileSync(join(rd, 'seen.txt'), 'utf8');
  assert.ok(readFileSync(out, 'utf8').includes(`"key":"${seen}"`), '盒內 auth.json 的 key 不等於轉送器拿到的假值');
  assert.ok(!readdirSync(iso.authDir).some((n) => n.startsWith('dummy-bearer')), '掃完假值檔還留在 authDir');
});
