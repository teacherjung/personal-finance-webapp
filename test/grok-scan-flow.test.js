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
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScan, SESSION_CAPS, EXPECTED_GROK_VERSION, GROK_HOME_MANIFEST } from '../scripts/grok-scan.js';
import { canApplySandbox, BOX_ROOT } from '../scripts/grok-sandbox-canary.js';
import { injectDirtyGitEnv, assertChildGitEnvCleanAsync } from './helpers/dirty-git-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { PINNED_ISSUER, PINNED_CLIENT_ID, DUMMY_BEARER_PREFIX, authNeedles, boxEntryKey } from '../scripts/grok-auth-refresh.js';

const SANDBOX_OK = (() => { const d = mkdtempSync(join(BOX_ROOT, 'grok-flow-cap-')); try { return canApplySandbox(d).ok; } finally { rmSync(d, { recursive: true, force: true }); } })();
const SKIP_AFTER_CANARY = '金絲雀之後的路徑只在套得上沙箱的 macOS 考得到（這台套不上；金絲雀自己會退 2＝fail-closed）';

/** 沙盒專用環境：**從零組**，不是從 process.env 扣（鐵則 11；Codex r2 抓到 r1 版是 `{...process.env, GIT_DIR: undefined}`——
 *  從 linked worktree 的 pre-push 跑時會把 GIT_WORK_TREE／GIT_CONFIG_* 整族帶進 `git init`，正是 AGENTS 記載過把共用 config 寫成 bare 的事故形狀）。 */
const CLEAN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' };
const EXPECTED_BOX_AUTH_FIELDS = ['auth_mode', 'create_time', 'expires_at', 'key', 'oidc_client_id', 'oidc_issuer', 'user_id'];

/** 一個最小的真 git repo（有一顆 commit），當 runScan 的 repo。 */
function tinyRepo() {
  const d = mkdtempSync(join(tmpdir(), 'grok-flow-repo-'));
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', env: CLEAN_ENV });
  git(['init', '-q']);
  writeFileSync(join(d, 'a.txt'), 'hello\n');
  writeFileSync(join(d, 'tree-only.txt'), 'TREE-ONLY-PUBLIC-VALUE\n');   // 兩顆 commit 都有、不在 diff 裡＝只在樹裡
  mkdirSync(join(d, 'node_modules', 'eslint'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'eslint', 'package.json'), '{}');
  git(['add', 'a.txt', 'tree-only.txt']);
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
function fakeGrok(/** @type {{ version?: string, status?: number, reply?: string, noSession?: boolean, noToolFootprint?: boolean }} */ o = {}) {
  const d = mkdtempSync(join(tmpdir(), 'fake-grok-install-'));
  mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions')); writeFileSync(join(d, 'config.toml'), ''); writeFileSync(join(d, 'auth.json'), fakeAuth());
  const p = join(d, 'bin', 'grok');
  const session = o.noSession ? '' : `
ws="$GROK_HOME/sessions/$(printf '%s' "$PWD" | /usr/bin/sed 's|/|%2F|g')"; mkdir -p "$ws/fake-session" && printf '${o.noToolFootprint ? '{"type":"assistant","content":"x"}' : '{"type":"tool_started","tool_name":"run_terminal_command"}'}\n' > "$ws/fake-session/updates.jsonl"`;
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
/**
 * 每題獨立的沙箱 auth 目錄、結果根與活金絲雀根（絕不碰真的 ~/.grok-sandbox-auth／~/.grok-scan-results／家目錄）。
 * `liveRoot` 是 2026-08-26 加的：正式路徑的金絲雀住**真家目錄**，而家目錄是**跨程序共用**的——
 * 另一個 session、審查樹、合併閘同時跑考題時，在那裡數 `.grok-live-canary-*` 會互相誤紅。
 */
const isolated = () => ({ authDir: mkdtempSync(join(tmpdir(), 'fake-auth-')), resultsRoot: mkdtempSync(join(tmpdir(), 'fake-results-')), liveRoot: mkdtempSync(join(tmpdir(), 'fake-live-')), fetchImpl: noFetch });
/**
 * 同 isolated()，但**刻意不給 liveRoot**——要考「預設落在真家目錄」就只能走預設那條路。
 * 寫成覆蓋為 undefined（不是 delete）：isolated() 日後多欄位會自動跟上；而欄位若被改名，
 * 這裡蓋到的是舊名、新名照樣流進去 ⇒ 題名關鍵字「不注入 liveRoot」那題會直接紅，不會靜靜放行。
 */
const isolatedRealHome = () => ({ ...isolated(), liveRoot: undefined });
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

test('runScan｜版本要**精確等於**，前綴不算（r2：wrapper 印 "grok 1.0.3-other" 就能過 startsWith）', async (t) => {
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

test('runScan｜審查能力 smoke：零工具足跡 → 2 且不保存（chat-only 回覆不能冒充複審）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ noToolFootprint: true })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /沒有任何工具足跡/);
  assert.deepEqual(readdirSync(iso.resultsRoot), [], '零工具足跡還保存了結果包');
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
  assert.ok(launch.grokArgv.includes('--always-approve'), '少了 --always-approve：盒內跑指令會停在權限確認、-p 模式整輪取消、退 0 只印旁白（第四次正式掃描實際發生）');
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
  const after = before.replace(/^(printf '%s' .*# REPLY-LINE)$/m,
    `printf '%s\\n' '{"type":"assistant","content":"-----BEGIN RSA PRIVATE KEY-----\\\\nMIIEOUTSIDEKEYBODYCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\\\\n-----END RSA PRIVATE KEY-----"}' >> "$ws/fake-session/updates.jsonl"; $1`);   // r10：要含內容，光標頭不是鑰匙
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
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ issuer: 'https://elsewhere.example', expiresInMs: -1000 }));
  let called = false;
  const spyFetch = /** @type {typeof fetch} */ (async () => { called = true; return new Response('{}', { status: 200 }); });
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, fetchImpl: spyFetch, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /不等於釘住的/);
  assert.equal(called, false, 'refresh_token 被送去別處的 issuer 了');
});

test('runScan｜盒內最小家 manifest：config.toml／agent_id **不帶進盒子**；auth.json 只含固定欄位；審查 smoke 要有工具足跡', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  writeFileSync(join(inst, 'config.toml'), 'stale = "CONFIG-STALE-VALUE"\n'); writeFileSync(join(inst, 'agent_id'), 'AGENT-ID-STALE');
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, '( printf "LS=[%s] " "$(ls "$GROK_HOME" | tr \'\\n\' \' \')"; cat "$GROK_HOME/config.toml" "$GROK_HOME/agent_id" "$GROK_HOME/auth.json" 2>/dev/null ) | tr \'\\n\' \' \'; $1'));
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 0, r.summary.join('\n'));
  const reply = readFileSync(out, 'utf8');
  assert.ok(!reply.includes('CONFIG-STALE'), 'config.toml 進了盒子');
  assert.ok(!reply.includes('AGENT-ID-STALE'), 'agent_id 進了盒子');
  const ls = /LS=\[([^\]]*)\]/.exec(reply)?.[1] || '';
  assert.deepEqual(ls.trim().split(/\s+/).sort(), [...GROK_HOME_MANIFEST.topLevelEntries], `盒內 grok-home 的檔不是 manifest 宣告的最小家：${ls}`);
  const json = /\{.*\}/.exec(reply)?.[0] || '';
  const entry = Object.values(JSON.parse(json))[0];
  assert.deepEqual(Object.keys(/** @type {object} */ (entry)).sort(), EXPECTED_BOX_AUTH_FIELDS, '盒內 auth.json 的欄位不是固定白名單');
  assert.ok(!reply.includes('fake-owner@example.test'), 'email 進了盒子');
  assert.match(r.summary.join('\n'), /足跡 [1-9]\d* 筆/, '審查能力 smoke 沒有看到工具足跡');
});

test('runScan｜盒內最小家 manifest 接線：refresh 後若 auth.json 多出白名單外欄位 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, {
    ...quiet,
    ...iso,
    repo: repo.dir,
    ...withGrok(fakeGrok()),
    relayScript: fakeRelay('ok'),
    afterGrokHomeAuthWrite: (grokHome) => {
      const p = join(grokHome, 'auth.json');
      const auth = JSON.parse(readFileSync(p, 'utf8'));
      const entry = /** @type {Record<string, unknown>} */ (Object.values(auth)[0]);
      entry.principal_id = 'BOX-BYPASS-FIELD-0123456789';
      writeFileSync(p, JSON.stringify(auth), { mode: 0o600 });
    },
  });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /manifest 不符/);
  assert.match(r.summary.join('\n'), /auth\.json 欄位/);
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

test('runScan｜r6 #6：DLP 針按欄位取、不按內容形狀——email／日期形狀 token 出現在回覆＝1；給了盒子的值與枚舉詞不算針；已在材料裡的針剔除並記錄', async (t) => {
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
  // ③ 給了盒子的值不算針、不管真檔裡還叫什麼欄位：principal_id 的值＝user_id（真檔實際如此）；枚舉欄位 principal_type 不算針
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ extra: { principal_id: '0ed1fd13-5d15-4f01-9a1e-2d9cb2f1f111', principal_type: 'User' } }));
    const inst = fakeGrok({ reply: 'User 0ed1fd13-5d15-4f01-9a1e-2d9cb2f1f111 wrote this' });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, `給了盒子的 user_id／枚舉詞被當成針：${r.summary.join('\n')}`);
  }
  // ④ 但 team_id（沒給盒子、跟 user_id 不同值）出現在回覆 → 1
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ extra: { team_id: '7777aaaa-5d15-4f01-9a1e-2d9cb2f1f222' } }));
    const inst = fakeGrok({ reply: 'team 7777aaaa-5d15-4f01-9a1e-2d9cb2f1f222' });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `team_id 外流沒被當事故：${r.summary.join('\n')}`);
  }
  // ⑥ 針不在材料（diff）裡、但在 head 樹裡（例：名字在 AGENTS.md）→ 也剔除；回覆含它 → 0（空 diff 煙霧測試實際踩到）
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ extra: { team_id: 'TREE-ONLY-PUBLIC-VALUE' } }));
    const inst = fakeGrok({ reply: 'saw TREE-ONLY-PUBLIC-VALUE in the tree' });
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, `樹裡本來就有的值被當成針：${r.summary.join('\n')}`);
    assert.ok(logs.some((l) => l.includes('不採用')), '剔除樹裡已有的針時沒有記錄');
  }
  // ⑤ first_name「測試用」在指示檔裡本來就有 → 針剔除、有 log；回覆含它 → 0
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

test('readSessionsOnce｜r7：sessions 根目錄或中介目錄是 symlink → 當捷徑（odd）、不跟過去讀盒外（純函式，平台無關，CI 也跑）', async () => {
  const { readSessionsOnce } = await import('../scripts/grok-scan.js');
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
  // ① 根目錄本身是指向盒外的 symlink
  {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-'));
    execFileSync('ln', ['-s', outside, join(home, 'sessions')]);
    const r = readSessionsOnce(join(home, 'sessions'));
    assert.deepEqual(r.odd, ['.'], '根目錄是捷徑沒被當成捷徑');
    assert.equal(r.files.size, 0, '跟著根目錄捷徑讀到盒外的檔');
  }
  // ② 中介目錄是 symlink
  {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-')); mkdirSync(join(home, 'sessions'));
    execFileSync('ln', ['-s', outside, join(home, 'sessions', 'ws')]);
    const r = readSessionsOnce(join(home, 'sessions'));
    assert.deepEqual(r.odd, ['ws']);
    assert.equal(r.files.size, 0);
  }
  // ③ 正常樹照讀
  {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-')); mkdirSync(join(home, 'sessions', 'ws'), { recursive: true }); writeFileSync(join(home, 'sessions', 'ws', 'a.jsonl'), 'x');
    const r = readSessionsOnce(join(home, 'sessions'));
    assert.deepEqual(r.odd, []); assert.deepEqual([...r.files.keys()], ['ws/a.jsonl']);
  }
});

test('runScan｜r7：假 grok 把整個 sessions 目錄換成指向盒外的 symlink → 1（事故）、盒外內容不進結果包', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  // 盒外目標放在假安裝樹裡（沙箱裡 ln -s 的目標不需要讀得到，symlink 本身寫在盒內就行）
  const outside = mkdtempSync(join(tmpdir(), 'outside-sessions-')); writeFileSync(join(outside, 'leak.txt'), 'OUTSIDE-SESSIONS-SECRET');
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `rm -rf "$GROK_HOME/sessions"; /bin/ln -s ${JSON.stringify(outside)} "$GROK_HOME/sessions"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /捷徑/);
  const all = readdirSync(iso.resultsRoot).flatMap((d) => readdirSync(join(iso.resultsRoot, d)));
  assert.ok(!all.includes('sessions'), '事故還保存了 sessions');
});

test('憑證｜r7（Codex #1）：auth.json 的外層鍵名不是釘住的 issuer::client_id → 不重建、不掃；鍵名不進 DLP 的「給了盒子」集合（純函式，CI 也跑）', async () => {
  const { refreshSandboxAuth } = await import('../scripts/grok-auth-refresh.js');
  const dir = mkdtempSync(join(tmpdir(), 'auth-key-'));
  const cred = JSON.parse(fakeAuth())[boxEntryKey()];
  // 鍵名是 email → 拒
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'owner@example.test': cred }));
  await assert.rejects(() => refreshSandboxAuth(dir, { fetchImpl: noFetch }), /鍵名/, 'email 當鍵名被接受了——它會原樣進盒子');
  // 鍵名對 → 過，且盒內那份的鍵名就是釘住的形狀
  writeFileSync(join(dir, 'auth.json'), fakeAuth());
  const a = await refreshSandboxAuth(dir, { fetchImpl: noFetch });
  assert.deepEqual(Object.keys(a.forBox), [boxEntryKey()]);
  // 鍵名若含身分字串，authNeedles 不會因為「鍵名給了盒子」而排除同值的針
  const needles = authNeedles({ 'fake-owner@example.test': { ...cred, email: 'fake-owner@example.test' } });
  assert.ok(needles.includes('fake-owner@example.test'), '鍵名同值的 email 被排除出針了');
});

test('憑證｜DLP 針收集：toString／constructor 這類原型繼承名不可被當成 BOX_FIELDS', () => {
  const auth = JSON.parse(fakeAuth());
  const cred = auth[boxEntryKey()];
  cred.toString = 'TOSTRING-SHOULD-BE-A-DLP-NEEDLE';
  cred.constructor = 'CONSTRUCTOR-SHOULD-BE-A-DLP-NEEDLE';
  const needles = authNeedles(auth);
  assert.ok(needles.includes('TOSTRING-SHOULD-BE-A-DLP-NEEDLE'), 'toString 被當成盒內白名單欄位，沒有進 DLP 針');
  assert.ok(needles.includes('CONSTRUCTOR-SHOULD-BE-A-DLP-NEEDLE'), 'constructor 被當成盒內白名單欄位，沒有進 DLP 針');
});

test('runScan｜r7（Codex #2）：轉送器拒絕了不在白名單的請求 → 掃描退 2（吵），不靠 grok 的退出碼；刻意擋的 bundle/archive → 容許、只記錄', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const real = fileURLToPath(new URL('../scripts/grok-relay.js', import.meta.url));
  for (const [label, path, want] of /** @type {[string, string, 0|2][]} */ ([['白名單外', '/v1/not-in-allowlist', 2], ['刻意擋的', '/v1/bundle/archive', 0], ['刻意擋的（subagents）', '/v1/subagents/bundle', 0]])) {
    const iso = isolated(); const inst = fakeGrok();
    // 假 grok 用盒內 curl 打本掃轉送器（port 從 env 來）；grok 自己仍退 0
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `/usr/bin/curl -s -o /dev/null -m 5 "\${GROK_CLI_CHAT_PROXY_BASE_URL%/v1}${path}" -H "Authorization: Bearer $(sed -n 's/.*"key":"\\([^"]*\\)".*/\\1/p' "$GROK_HOME/auth.json")"; $1`));
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: real });
    assert.equal(r.code, want, `${label}：${r.summary.join('\n')}`);
    if (want === 2) assert.match(r.summary.join('\n'), /轉送器拒絕了 1 個不在白名單/, label);
    else assert.ok(logs.some((l) => l.includes('刻意擋的形狀') && l.includes(`GET ${path}`)), `${label}：沒記錄被容許的拒絕`);
  }
});

test('runScan｜驗屍的破口線索若已在材料裡（受掃 diff 自己含私鑰標頭字面）→ 不算事故；不在材料裡的同形狀仍是 1（#500 第一次正式掃描誤中自己）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // repo 的 head 多一個檔，內容就是破口考題的字面——那會進 diff＝進材料
  const repo = tinyRepo();
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8', env: CLEAN_ENV });
  // 假鑰放進 repo 的 head（跨行＝真鑰的樣子；進 diff 後每行多一個 `+`）
  const keyLines = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEFAKEFIXTUREKEYBODYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '-----END RSA PRIVATE KEY-----'];
  writeFileSync(join(repo.dir, 'fixture.txt'), `a test fixture key:\n${keyLines.join('\n')}\n`);
  git(['add', 'fixture.txt']); git(['commit', '-q', '-m', 'fixture']);
  const head3 = git(['rev-parse', 'HEAD']).trim();
  const fakeKeyJson = keyLines.join('\\n');                 // 日誌是 JSON：換行成字面 \n
  const fakeKeyJson2 = keyLines.join('\\\\n');              // 巢狀 JSON：再轉義一層
  for (const [label, sessionLine, want] of /** @type {[string, string, 0|1][]} */ ([
    ['材料裡那把假鑰以 JSON 字串形式出現在日誌（換行成字面 \\n）', `printf '%s\\n' '{"type":"assistant","content":"${fakeKeyJson}"}'`, 0],
    ['材料裡那把假鑰以巢狀 JSON（雙重轉義）出現在日誌', `printf '%s\\n' '{"type":"assistant","content":"{\\"k\\":\\"${fakeKeyJson2}\\"}"}'`, 0],
    ['只有標頭、沒內容（題名／註解）', `printf '%s\\n' '{"type":"assistant","content":"see BEGIN RSA PRIVATE KEY in test name"}'`, 0],
    ['同標頭、不同內容的外部私鑰（r10：材料有標頭也不能放過）', `printf '%s\\n' '{"type":"assistant","content":"outside: -----BEGIN RSA PRIVATE KEY-----\\nMIIEOUTSIDEKEYBODYBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\\n-----END RSA PRIVATE KEY-----"}'`, 1],
    ['材料裡沒有的同形狀', `printf '%s\\n' '{"type":"assistant","content":"-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2g\\n"}'`, 1],
  ])) {
    const iso = isolated(); const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `${sessionLine} >> "$ws/fake-session/updates.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: head3, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, want, `${label}：${r.summary.join('\n')}`);
  }
});

test('runScan｜父程序收到 SIGTERM（呼叫它的工具逾時）→ 緊急收尾：grok 群組死、盒子／假值檔／活金絲雀都清掉、退 2（第五次正式掃描實際留下殘留）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'sleep 30; $1'));
  /** @type {string[]} */ const logs = [];
  /** @type {number[]} */ const exits = [];
  /**
   * 掃描進行中（金絲雀已建、還沒收）那一刻，**注入的**根目錄裡有什麼。
   * ⚠️ 少了這一格，下面「清乾淨」的斷言就是空包彈：注入沒接上時金絲雀跑去真家目錄建，
   *    隔離目錄從頭到尾是空的，斷言照樣通過。
   */
  /** @type {string[] | null} */ let livesDuring = null;
  const p = runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, {
    log: (m) => { logs.push(m); if (m.startsWith('掃描開始')) { livesDuring = readdirSync(iso.liveRoot); setTimeout(() => process.emit('SIGTERM'), 300); } },
    ...iso,
    repo: repo.dir,
    ...withGrok(inst),
    relayScript: fakeRelay('ok'),
    exit: (c) => {
      exits.push(c);
      assert.deepEqual(readdirSync(iso.resultsRoot), [], 'emergency 呼叫 exit 前還留下結果目錄');
    },
  });
  const r = await p;
  assert.deepEqual(exits, [2], '緊急收尾沒呼叫 exit(2)');
  assert.equal(r.code, 2);
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  assert.ok(box && !existsSync(box), '盒子沒清');
  assert.ok(!readdirSync(iso.authDir).some((n) => n.startsWith('dummy-bearer')), '假值檔沒清');
  assert.deepEqual(readdirSync(iso.resultsRoot), [], '緊急收尾還留下只有 launch.json 的結果目錄');
  assert.equal((livesDuring ?? []).filter((n) => n.startsWith('.grok-live-canary-')).length, 1, `掃描中金絲雀沒建在注入的根目錄（實際內容：${JSON.stringify(livesDuring)}）——liveRoot 沒接上，下一行的斷言會變空包彈`);
  assert.deepEqual(readdirSync(iso.liveRoot), [], '活金絲雀目錄沒清');
  const ps = execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' });
  assert.ok(!ps.includes(box), 'grok 群組還活著');
});

test('runScan｜不注入 liveRoot 時，活金絲雀建在真的家目錄：掃描期間認得出本輪暗號那一個、掃完清掉', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 全檔**唯一**還在真家目錄建東西的題，故意的：金絲雀的意義就在**位置**——家目錄同時住著真 ~/.grok、
  //    ~/.grok-sandbox-auth 與真的 store.db，是破出沙箱的人第一個會翻的地方。位置只能在正式位置上考。
  //    其餘每一題都經 isolated() 改道到隔離根，所以真家目錄一輪只會被碰這一次。
  // ⚠️ 認身分靠**每輪隨機的暗號內容**、不數個數：別的 session／審查樹／合併閘同時在跑也認不錯。
  //    （數個數正是上一題原本的寫法，也正是本支要修掉的病。）
  // ⚠️ 暗號會被原樣插進驗屍的正規式（grok-scan.js 的 BREACH_SRC），randomUUID 只有十六進位與 `-`＝正則安全。
  const repo = tinyRepo();
  const liveSecret = `LIVE-CANARY-PIN-${randomUUID()}`;
  /** @type {string[]} */ let mine = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, {
    ...isolatedRealHome(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok'), liveSecret,
    log: (m) => {
      if (!m.startsWith('掃描開始')) return;   // 這一刻金絲雀一定已經建好（建立點在這行 log 之前）
      mine = readdirSync(homedir()).filter((n) => n.startsWith('.grok-live-canary-')).filter((n) => {
        try { return readFileSync(join(homedir(), n, 'store.db'), 'utf8').includes(liveSecret); }
        catch { return false; }   // 別人的金絲雀隨時可能被清掉，讀不到就跳過
      });
    },
  });
  assert.equal(r.code, 0, r.summary.join('\n'));
  assert.equal(mine.length, 1, '掃描期間在真家目錄找不到帶本輪暗號的金絲雀＝預設根目錄已經不是家目錄了（而搬走它不會有別的題轉紅）');
  assert.ok(mine[0] && !existsSync(join(homedir(), mine[0])), '掃完沒清掉真家目錄裡的金絲雀');
});

test('runScan｜Grok 掃描抓到：活金絲雀暗號只出現在 grok 的**回覆**（不在 session）→ 1、--out 不寫、sessions 不留（原本只掃 session 檔）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const liveSecret = 'LIVE-CANARY-TEST-0123456789';
  const inst = fakeGrok({ reply: `I read your store.db: ${liveSecret}` });
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok'), liveSecret });
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.ok(!existsSync(out), '事故還寫了 --out');
  assert.equal(readdirSync(iso.resultsRoot).flatMap((d) => readdirSync(join(iso.resultsRoot, d))).includes('sessions'), false, '事故還保存了 sessions');
});

test('runScan｜Grok 掃描抓到：沒掃成（退 2）不在 ~/.grok-scan-results 留任何目錄；事故（退 1）留 launch.json、不留 sessions', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  {
    const iso = isolated();
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ status: 1 })), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 2);
    assert.deepEqual(readdirSync(iso.resultsRoot), [], '退 2 還在結果根留了目錄');
  }
  {
    const iso = isolated();
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: 'LIVE-CANARY-X-0123456789' })), relayScript: fakeRelay('ok'), liveSecret: 'LIVE-CANARY-X-0123456789' });
    assert.equal(r.code, 1);
    const dirs = readdirSync(iso.resultsRoot); assert.equal(dirs.length, 1, '事故應留一個結果目錄當證據');
    assert.deepEqual(readdirSync(join(iso.resultsRoot, dirs[0])), ['launch.json']);
  }
});
