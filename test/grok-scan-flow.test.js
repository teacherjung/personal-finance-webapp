// @ts-check
// grok-scan.js 主流程的行為考題（2026-08-22，Codex #496 r1：「沒有任何考題執行 grok-scan.js 的控制流，只有路徑字串」）。
//
// 用假的 grok／轉送器／session 根目錄跑 runScan()，考每一條 fail-closed 路徑**真的退 2**，
// 而不是像第一版那樣：Grok 沒跑、轉送器中途死、零 session——全部退 0。
//
// ⚠️ 誠實劃界：
// ・非 macOS 上，沙箱套不上 ⇒ **`--version` 檢查**（它在沙箱裡跑、位置在金絲雀之前）就會先停下來；
//   有 SANDBOX_OK guard 的題直接 skip，沒有 guard 的路徑則停在那一關。所以「沙箱之前」的路徑
//   （寫死 SHA、指示檔、破口已知來源）在 CI 也考得到；之後的路徑只在 macOS 考得到。
// ・假 grok 不會真的連 xAI；它只回一段字。考的是主流程怎麼對待它的退出碼與輸出，不是掃描品質。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScan, SESSION_CAPS, EXPECTED_GROK_VERSION, GROK_HOME_MANIFEST, stripLineMarkers, shapeHitsIn, knownShapeHitsFromTree, escapeForms, hitProfile, nearestKnown, redactWindow } from '../scripts/grok-scan.js';
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

/**
 * 破口形狀的標頭：**執行時才拼**，本檔源碼裡不留 `-----BEGIN <KIND> PRIVATE KEY-----` 的字面。
 *
 * 為什麼（#516／#530 兩支的複審後掃都判事故、都靠 William 裁示「視為誤判」才放行）：
 * ⚠️ 分兩層講，別混在一起：**這一類**假事故的成因清楚——字面材料被引用時換了呈現、逐字對不上；
 *   但 **#530 那一次具體那 36 條命中是什麼**至今未定（現場被護欄自己刪掉：退 1 不留 sessions）。
 *   本 helper 收的是前者。
 *   本檔是破口偵測器自己的考題檔，裡面的假鑰跟真鑰匙同形。字面留在檔裡，Grok 每次讀／引用本檔
 *   都可能把它帶進日誌；引用時只要換了呈現，逐字對不上就判事故。
 *   往「放寬比對」修的代價實測是排除語言從 12 條字串脹成 598 條，而最短的合法前綴只有 58 個字元、
 *   其中可以一個酬載字元都沒有（`{32,}` 的字元類含空白與反斜線＝長度下限、不是熵下限）。
 *   往這裡修則是讓爭議在源頭消失，判準一個字元都不用放寬。
 * ⚠️ 誠實劃界（兩條）：
 *   ①這只讓**源碼本身**不含命中。考題**執行後**的值若進了日誌仍會判事故——那條路本來就該判事故，
 *     本 helper 不宣稱修得掉它。
 *   ②`-----END …-----` 不經這裡：現行 BREACH_SHAPES 只從 `BEGIN` 起錨，留字面不會造出命中。
 *     這是照現行正則讀出來的，**沒有考題撐著**；正則的起錨點若改，這裡要一起重看。
 * @param {'RSA'|'OPENSSH'|'EC'|'DSA'} kind
 */
const PEM_BEGIN = (kind) => `-----BEGIN ${kind} PRIVATE KEY-----`;

/** 一個最小的真 git repo（有一顆 commit），當 runScan 的 repo。 */
function tinyRepo(/** @type {{ firstCommitFiles?: Record<string, string> }} */ o = {}) {
  const d = keep(mkdtempSync(join(tmpdir(), 'grok-flow-repo-')));
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', env: CLEAN_ENV });
  git(['init', '-q']);
  writeFileSync(join(d, 'a.txt'), 'hello\n');
  writeFileSync(join(d, 'tree-only.txt'), 'TREE-ONLY-PUBLIC-VALUE\n');   // 兩顆 commit 都有、不在 diff 裡＝只在樹裡
  mkdirSync(join(d, 'node_modules', 'eslint'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'eslint', 'package.json'), '{}');
  // firstCommitFiles：進**第一顆 commit**＝在 base 之前 ⇒ 在 head 樹裡、不在 base..head 的 diff 裡。
  // 預設不傳：把鑰匙形狀塞進共用夾具會讓每一題的樹都帶著它，反而遮蔽別的題。
  for (const [name, body] of Object.entries(o.firstCommitFiles ?? {})) writeFileSync(join(d, name), body);
  git(['add', 'a.txt', 'tree-only.txt', ...Object.keys(o.firstCommitFiles ?? {})]);
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
/**
 * 假的 grok 執行檔。
 * ⚠️ `reply` 是塞進 shell 的**雙引號字串**裡的，所以 `"`／`\`／`$`／`` ` `` 一律要跳脫——
 *   原本只跳脫單引號，於是帶 `"` 的回覆會被 shell 切成好幾個字、`printf '%s'` 只印第一個。
 *   那是**靜靜壞掉**：考題照樣綠，但它根本沒測到想測的東西（2026-09-01 寫「命中含機密」那題時踩到）。
 */
function fakeGrok(/** @type {{ version?: string, status?: number, reply?: string, noSession?: boolean, noToolFootprint?: boolean }} */ o = {}) {
  const d = keep(mkdtempSync(join(tmpdir(), 'fake-grok-install-')));
  mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions')); writeFileSync(join(d, 'config.toml'), ''); writeFileSync(join(d, 'auth.json'), fakeAuth());
  const p = join(d, 'bin', 'grok');
  const session = o.noSession ? '' : `
ws="$GROK_HOME/sessions/$(printf '%s' "$PWD" | /usr/bin/sed 's|/|%2F|g')"; mkdir -p "$ws/fake-session" && printf '${o.noToolFootprint ? '{"type":"assistant","content":"x"}' : '{"type":"tool_started","tool_name":"run_terminal_command"}'}\n' > "$ws/fake-session/updates.jsonl"`;
  writeFileSync(p, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok ${o.version ?? EXPECTED_GROK_VERSION} (fake)"; exit 0; fi${session}
printf '%s' "${(o.reply ?? 'FAKE-REPLY').replace(/["\\$`]/g, '\\$&')}" # REPLY-LINE
exit ${o.status ?? 0}
`);
  chmodSync(p, 0o755);
  return d;   // 回傳 GROK_INSTALL，不是執行檔
}

/** 假轉送器：印 READY 然後活著；或照指定行為死掉。 */
function fakeRelay(/** @type {'ok' | 'die-before-ready' | 'die-after-ready'} */ mode = 'ok') {
  const d = keep(mkdtempSync(join(tmpdir(), 'fake-relay-')));
  const p = join(d, 'relay.js');
  writeFileSync(p, mode === 'die-before-ready' ? 'process.exit(1);'
    : mode === 'die-after-ready' ? "process.stdout.write('READY 1\\n'); setTimeout(() => process.exit(1), 200);"
    : "process.stdout.write('READY 1\\n'); setInterval(() => {}, 1000);");
  return p;
}

/** @param {string} [extra] 附加到指示檔內容後面；指示檔會進 materials，**永遠不會進受掃樹**——要單獨考「材料那條路」就靠它 */
function promptFile(extra) { const d = keep(mkdtempSync(join(tmpdir(), 'fake-prompt-'))); const p = join(d, 'p.txt'); writeFileSync(p, '【界線】測試用\n' + (extra ?? '')); return p; }
/**
 * isolated() 建過的暫存根，跑完整支考題檔一起清。
 * ⚠️ **這三個根本身 `runScan` 不會刪**（它只清自己在根底下建的東西；盒子根本不住這裡，是在 BOX_ROOT）——
 *    根是考題建的、要考題自己收。沒有這個 hook，每呼叫一次 isolated() 就在使用者暫存區多留三個目錄，
 *    而且走得夠遠的題還會**留著內容**：`fake-auth-` 的假 auth.json、`fake-results-` 的整包結果（launch.json＋sessions）；
 *    早早退場的題（例如 base／head 不是寫死 SHA 那題）則三個都還是空的。
 *    （Codex #516 r1 抓到我新加的 `fake-live-` 那一族；`fake-auth-`／`fake-results-` 兩族是既有的，
 *    同一個 helper 建的、沒有道理分開清。）
 */
const TEMP_ROOTS = /** @type {string[]} */ ([]);
const keep = (/** @type {string} */ dir) => { TEMP_ROOTS.push(dir); return dir; };
after(() => { for (const d of TEMP_ROOTS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 盡力 */ } } });

/**
 * 假的第②步金絲雀：流程考題只需要「它回什麼、runScan 就怎麼反應」。
 * 為什麼非換掉不可：真的那一支是**全機共用資源的使用者**（搶系統唯一那份剪貼簿、在幾個共用位置開誘餌目錄）。
 * ⚠️ 規格與代價（秒數、探針數、位置清單）只寫在 `scripts/grok-scan.js` 的 `runCanary` 那格 JSDoc——
 *   這裡刻意不複述：同一組會漂的數字有兩個家，日後一定只改到一邊。
 * ⚠️ 沙箱**是不是真的有效**由題名關鍵字「金絲雀」那一族在 `test/grok-sandbox.test.js` 證明，不是本檔——
 *   本檔用假的 ⇒ 這裡不對沙箱有效性提供任何證據，那是刻意的分工。
 * @param {0|1|2} [code]
 * @param {string[]} [lines] 有題把「金絲雀印出第一行」當時序鉤子，那種題就地傳自己要的行，別讓預設值偷偷去滿足它
 */
const fakeCanary = (code = 0, lines = [`（假金絲雀：code ${code}）`]) => async () => ({ code, lines });
/**
 * 每題獨立的沙箱 auth 目錄、結果根與活金絲雀根（絕不碰真的 ~/.grok-sandbox-auth／~/.grok-scan-results／家目錄），
 * **並注入上面那個假金絲雀**——所以凡是用 `isolated()` 的題都走不到真的第②步；要考「不注入時走哪一支」，
 * 得自己把 `runCanary` 這一格拿掉（見題名關鍵字「不注入」那題）。
 * `liveRoot` 是 2026-08-26 加的：正式路徑的金絲雀住**真家目錄**，而家目錄是**跨程序共用**的——
 * 另一個 session、審查樹、合併閘同時跑考題時，在那裡數 `.grok-live-canary-*` 會互相誤紅。
 */
const isolated = () => ({ runCanary: fakeCanary(), authDir: keep(mkdtempSync(join(tmpdir(), 'fake-auth-'))), resultsRoot: keep(mkdtempSync(join(tmpdir(), 'fake-results-'))), liveRoot: keep(mkdtempSync(join(tmpdir(), 'fake-live-'))), fetchImpl: noFetch });
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
    `printf '%s\\n' '{"type":"assistant","content":"${PEM_BEGIN('RSA')}\\\\nMIIEOUTSIDEKEYBODYCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\\\\n-----END RSA PRIVATE KEY-----"}' >> "$ws/fake-session/updates.jsonl"; $1`);   // r10：要含內容，光標頭不是鑰匙
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
  // 盒外那個機密檔的內容也不可以出現在結果包的任何檔裡（含新增的 incident.json）
  for (const f of readdirSync(iso.resultsRoot, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) assert.ok(!readFileSync(join(f.parentPath ?? f.path, f.name), 'utf8').includes('OUTSIDE-SECRET'), `結果包 ${f.name} 裡有盒外內容`);
  }
  // ⚠️ 這條事故路徑（odd）也要留指紋：它跟破口那條一樣，原本什麼都不留就回傳了
  const oddDirs = readdirSync(iso.resultsRoot);
  assert.equal(oddDirs.length, 1, 'odd 事故沒留結果目錄');
  const oddInc = join(iso.resultsRoot, oddDirs[0], 'incident.json');
  assert.ok(existsSync(oddInc), 'odd 事故沒留 incident.json');
  assert.equal(JSON.parse(readFileSync(oddInc, 'utf8')).hits[0].family, 'odd');
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

test('runScan｜**不注入**時，走到的那一支會印出真探針詞彙的行（擋得住「接線被拿掉或換成空殼」）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 為什麼要有這一題：`deps.runCanary ?? runCanary` 是個接縫，而本檔其餘的題都注入假金絲雀
  //    ⇒ 沒有別的題會問「不注入時走到哪一支」。把那個 `??` 的預設換成不印探針行的空殼，其餘全檔照樣綠。
  //    這一題只跑一次真的，不是每一道走到第②步的題各跑一次。
  // ⚠️ **誠實劃界——它守得住什麼、守不住什麼**：
  //    ・守得住：fallback 被拿掉、或換成不印那些行的空殼。
  //    ・**守不住**：換成一支**完全不跑探針、只偽造同形文字**的替身——那樣它照樣綠。
  //      「同等強度的身分證據」三條路都不通——比函式身分是在測常數不是測呼叫點、誘餌目錄在 `finally` 就清掉
  //      觀察不到、拿耗時當門檻會 flaky——所以照家規改口，不把這一題稱為「真金絲雀接線的守門」。
  //    ・也不證明沙箱真的有效（那是 test/grok-sandbox.test.js 的事），不涵蓋 CLI 入口那一行。
  const repo = tinyRepo(); const iso = isolated();
  const { runCanary: _dropped, ...noCanary } = iso;   // 刻意不注入金絲雀
  void _dropped;
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...noCanary, repo: repo.dir, ...withGrok(fakeGrok({ status: 1 })), relayScript: fakeRelay('ok') });
  const s = r.summary.join('\n');
  assert.ok(/🔴 擋住｜/.test(s) && /✅ 通過｜/.test(s), `summary 裡沒有真金絲雀的探針行——正式路徑可能沒接著真的那一支：${s.slice(0, 200)}`);
});

test('runScan｜金絲雀非 0 就不掃：退 1（沙箱是假的）與退 2（跑不了／對照組不活）各自的訊息都要說得出來', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 為什麼非注入不可：真金絲雀在正常情況下回 0——它自己也會退 2（搶不到剪貼簿鎖、對照組不活、沙箱套不上），
  //    但那幾種都 flaky、當不了考題，所以「金絲雀說不行時 runScan 怎麼辦」只有注入才問得出來。
  // ⚠️ 這一題**需要**沙箱 guard，雖然注入點本身與平台無關：`--version` 檢查在金絲雀**之前**就已經在沙箱裡跑，
  //    非 macOS 會先死在那裡、走不到注入點（實測 CI 兩個 Node job 都紅）。
  // ⚠️ 「退 2＋訊息對」還不夠：`failAndClean` 是先清盒子再回傳，所以**漏掉那個 `return`**時訊息照樣在 summary 裡、
  //    掃描繼續往下跑、再因為盒子已被清掉而退 2——兩個斷言都會過（實測：拿掉 return，本題仍綠）。
  //    ⚠️ 釘「掃描開始那一行不可出現」也不夠：漏 return 的實況是**走不到那一行**（它死在轉送器起不來），
  //    所以那條斷言同樣抓不到（也實測過）。真正分得出來的是**「不掃」之後還有沒有動作**——
  //    正常收場時那一行就是最後一行；漏 return 時它後面還會冒出 DLP 與轉送器的行。
  const repo = tinyRepo();
  for (const [code, re] of /** @type {[1|2, RegExp][]} */ ([[1, /沙箱是假的/], [2, /跑不了沙箱／對照組不活/]])) {
    const logs = /** @type {string[]} */ ([]);
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), runCanary: fakeCanary(code), repo: repo.dir, ...withGrok(fakeGrok()) });
    assert.equal(r.code, 2, `金絲雀回 ${code} 時沒有退 2：${r.summary.join('\n')}`);
    assert.match(r.summary.join('\n'), re, `金絲雀回 ${code} 時的訊息分不出是哪一種`);
    const stopped = logs.findIndex((l) => l.startsWith('⛔ 金絲雀：'));
    assert.notEqual(stopped, -1, `金絲雀回 ${code} 時沒印出「不掃」那一行：${logs.join(' | ').slice(0, 300)}`);
    assert.equal(stopped, logs.length - 1, `金絲雀回 ${code} 說了「不掃」，後面卻還有動作＝其實還在掃：${logs.slice(stopped + 1).join(' | ').slice(0, 300)}`);
  }
});

test('runScan｜r6 #6：DLP 真相來源（authDir/auth.json）在掃描中途讀不到 → 2、不保存（原本 catch 成空集合＝fail-open）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth());
  let pulled = false;
  // 金絲雀的第一行 log 出現時（refresh 已做完、DLP 還沒讀）把真相來源抽掉。
  // ⚠️ 本題把「金絲雀印出第一行」當**時序鉤子**，所以就地注入一支會印那個記號的假金絲雀——
  //    讓這個依賴看得見，而不是靠 isolated() 的預設值碰巧滿足它。
  const log = (/** @type {string} */ m) => { if (!pulled && m.includes('🔴')) { pulled = true; rmSync(join(iso.authDir, 'auth.json')); } };
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log, ...iso, runCanary: fakeCanary(0, ['🔴 假探針（本題拿它當時序鉤子）']), repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
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

test('runScan｜驗屍的破口線索若已在材料裡（受掃 diff 自己含私鑰字面、head 樹裡沒有）→ 不算事故；材料裡沒有的同形狀仍是 1（#500 第一次正式掃描誤中自己；材料那條路）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 假鑰要落在「**只有材料有、樹裡沒有**」的位置，否則樹那條排除路會把這題一起變綠＝兩道護欄互相遮蔽
  //    （原版把它 commit 進 head，於是材料那條整個壞掉這題也照樣綠——Codex #530 r1 用突變證明過）。
  //    做法：base 有這個檔、head **刪掉**它 ⇒ 內容以 `-` 開頭的行出現在 diff 裡、而 head 樹裡沒有。
  //    diff 行首那個記號正是 `unprefixed` 那半在還原的東西，所以這題也順便守著它。
  const keyLines = [PEM_BEGIN('RSA'), 'MIIEFAKEFIXTUREKEYBODYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '-----END RSA PRIVATE KEY-----'];
  const repo = tinyRepo({ firstCommitFiles: { 'fixture.txt': `a test fixture key:\n${keyLines.join('\n')}\n` } });
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8', env: CLEAN_ENV });
  git(['rm', '-q', 'fixture.txt']); git(['commit', '-q', '-m', 'drop fixture']);
  const head3 = git(['rev-parse', 'HEAD']).trim();
  const prompt = promptFile();
  const fakeKeyJson = keyLines.join('\\n');                 // 日誌是 JSON：換行成字面 \n
  const fakeKeyJson2 = keyLines.join('\\\\n');              // 巢狀 JSON：再轉義一層
  for (const [label, sessionLine, want] of /** @type {[string, string, 0|1][]} */ ([
    ['材料裡那把假鑰以 JSON 字串形式出現在日誌（換行成字面 \\n）', `printf '%s\\n' '{"type":"assistant","content":"${fakeKeyJson}"}'`, 0],
    ['材料裡那把假鑰以巢狀 JSON（雙重轉義）出現在日誌', `printf '%s\\n' '{"type":"assistant","content":"{\\"k\\":\\"${fakeKeyJson2}\\"}"}'`, 0],
    ['只有標頭、沒內容（題名／註解）', `printf '%s\\n' '{"type":"assistant","content":"see BEGIN RSA PRIVATE KEY in test name"}'`, 0],
    ['同標頭、不同內容的外部私鑰（r10：材料有標頭也不能放過）', `printf '%s\\n' '{"type":"assistant","content":"outside: ${PEM_BEGIN('RSA')}\\nMIIEOUTSIDEKEYBODYBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\\n-----END RSA PRIVATE KEY-----"}'`, 1],
    // body 刻意是**明顯的假值**：原本那串 `b3BlbnNzaC1rZXktdjEA…AAAAtzc2g` 是每一把未加密 ed25519 私鑰
    //   **逐字相同的真開頭**（用格式常數重算，沒有產生任何真鑰匙：未加密 OpenSSH 的固定段 39 bytes
    //   ⇒ base64 前 **52** 個字元完全決定；ed25519 再加公鑰段的長度欄與識別字後固定段 62 bytes
    //   ⇒ 前 **80** 個字元完全決定。而那串是 67 個字元、落在完全決定的範圍內 ⇒ 它是任何真 ed25519
    //   私鑰的合法前綴，實測 startsWith 為真）。精確比對下無害，但只要哪天有人把樹那半
    //   放寬成前綴，它就變成一條「被截短的真 SSH 私鑰一律當本來就給它的東西」的路。本題只需要「一種
    //   材料裡沒有的 kind」，換掉不影響它在守的行為。
    // ⚠️ 本題**沒有**在守「OPENSSH 這個 kind 走得到」（改成 RSA 它照樣綠）——四種 kind 都被偵測器認得，
    //   是由 題名關鍵字「本檔源碼不留破口形狀的字面」那一題釘的。
    ['材料裡沒有的同形狀', `printf '%s\\n' '{"type":"assistant","content":"${PEM_BEGIN('OPENSSH')}\\nMIIEOPENSSHKEYBODYDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD\\n"}'`, 1],
  ])) {
    const iso = isolated(); const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `${sessionLine} >> "$ws/fake-session/updates.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: head3, promptFile: prompt }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, want, `${label}：${r.summary.join('\n')}`);
  }
});

/** 一把「真實長度」的假鑰：標頭＋8 行 64 字 base64＋結尾，真換行（不是 JS 字面的 \n） */
const PEM_LINES = [PEM_BEGIN('RSA'), ...Array.from({ length: 8 }, (_, i) => `MIIETREEONLYKEYBODY${String.fromCharCode(65 + i).repeat(45)}`), '-----END RSA PRIVATE KEY-----'];
const PEM_TEXT = PEM_LINES.join('\n') + '\n';

test('runScan｜破口形狀只在 head 樹裡、不在 diff 裡 → 不算事故（#516 的假事故）；樹裡沒有的同形狀仍是 1', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // 假鑰 commit 在 base **之前** ⇒ 在 head 樹裡、不在 base..head 的 diff 裡＝不在材料裡。
  // 2026-08-26 #516 就是這個形狀：受掃檔自己含假鑰 fixture，grok 讀了它就被判成「沙箱破了」。
  const repo = tinyRepo({ firstCommitFiles: { 'fixture-key.pem': PEM_TEXT } });
  const inTreeJson = PEM_LINES.join('\\n');        // 日誌是 JSON：真換行成字面 \n
  // 讀檔工具會在第 1 行與每 10 行插 `N→`；這裡刻意讓記號落在鑰匙區間內
  const withMarkers = PEM_LINES.map((l, i) => (i === 0 || (i + 1) % 10 === 0 ? `${i + 1}→${l}` : l)).join('\\n');
  for (const [label, sessionLine, want] of /** @type {[string, string, 0|1][]} */ ([
    ['樹裡那把鑰匙原樣回錄（cat 形）', `printf '%s\\n' '{"type":"assistant","content":"${inTreeJson}"}'`, 0],
    ['樹裡那把鑰匙帶讀檔工具的行號記號回錄', `printf '%s\\n' '{"type":"assistant","content":"${withMarkers}"}'`, 0],
    ['同標頭、不同內容（樹裡沒有這一把）', `printf '%s\\n' '{"type":"assistant","content":"${PEM_BEGIN('RSA')}\\nMIIEOUTSIDEKEYBODYZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ\\n"}'`, 1],
    ['只有標頭、沒內容（題名／註解）', `printf '%s\\n' '{"type":"assistant","content":"see BEGIN RSA PRIVATE KEY in test name"}'`, 0],
    // 樹那半刻意用**精確比對**：放寬成子字串包含就等於允許「真外洩剛好是某條 fixture 的前綴」被排除。
    // 這一案把樹裡那把鑰匙截成前綴（少了尾巴幾行）⇒ 逐字對不上 ⇒ 仍要報事故。
    ['樹裡那把鑰匙被截成前綴（日誌中段截斷的形狀）', `printf '%s\\n' '{"type":"assistant","content":"${PEM_LINES.slice(0, 4).join('\\n')}"}'`, 1],
  ])) {
    const iso = isolated(); const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `${sessionLine} >> "$ws/fake-session/updates.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, want, `${label}：${r.summary.join('\n')}`);
  }
});

test('runScan｜假 grok 先把鑰匙形狀寫進盒內 src、再把同一串回錄 → 仍是 1（已知來源不採信盒子裡的磁碟）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這題不是驗新功能，是**釘住來源不准換成 `<box>/src`**：盒子對 grok 是可寫的（profile 放行整個 SCAN_DIR），
  //    任何從盒內磁碟建已知集合的實作，都會讓破出沙箱的 grok 把自己的外洩登記成「本來就給它的東西」。
  const repo = tinyRepo(); const iso = isolated(); const inst = fakeGrok();
  const planted = PEM_LINES.join('\\n');
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8')
    .replace(/^(printf '%s' .*# REPLY-LINE)$/m,
      `printf '%s\\n' '${planted}' > ./planted-key.pem; printf '%s\\n' '{"type":"assistant","content":"${planted}"}' >> "$ws/fake-session/updates.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, `盒內自己種的鑰匙不該讓驗屍放行：${r.summary.join('\n')}`);
});

test('runScan｜事故訊息要帶得出族別與筆數，而且**完整命中值不回聲**（退 1 不留 sessions，事後只剩這行）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // 退 1 不留 sessions ⇒ 事後能拿來分辨「真破口」與「#516 式假事故」的只有這行字。
  // 而 repo 是公開的、失敗原因會被抄進 PR 描述 ⇒ 命中內容不可以回聲進去。
  {
    const liveSecret = 'LIVE-CANARY-BRIEF-77c1e0'; const iso = isolated(); const repo = tinyRepo();
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `saw ${liveSecret}` })), relayScript: fakeRelay('ok'), liveSecret });
    const s = r.summary.join('\n');
    assert.equal(r.code, 1, s);
    assert.match(s, /暗號 1 條/, '沒帶出「命中的是暗號那一族、幾條」');
    assert.match(s, /形狀 0 條/, '沒帶出形狀那族的筆數');
    assert.equal(s.includes(liveSecret), false, '事故訊息把暗號本身印出來了——那會被抄進公開的 PR 描述');
    // ⚠️ 斷言涵蓋的就是「**完整**命中值不回聲」；只洩前綴這題抓不到——題名與註解都照這個射程寫。
    assert.match(s, /形狀那族＝剝完行號記號後仍不在本次排除集合裡/, '尾句改回「不在 head 樹裡」那種不成立的話也不會紅');
  }
  {
    // 形狀那族：樹裡沒有的私鑰形狀 → 要帶出筆數與長度，同樣不得出現內容
    const body = 'MIIEBRIEFSHAPEKEYBODY' + 'W'.repeat(50);
    const iso = isolated(); const repo = tinyRepo(); const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf '%s\\n' '{"type":"assistant","content":"${PEM_BEGIN('RSA')}\\n${body}"}' >> "$ws/fake-session/updates.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    const s = r.summary.join('\n');
    assert.equal(r.code, 1, s);
    assert.match(s, /形狀 1 條/, '沒帶出形狀那族的筆數');
    assert.match(s, /形狀長度 \d+/, '沒帶出形狀命中的長度');
    assert.equal(s.includes(body), false, '事故訊息把命中內容印出來了');
  }
});

test('runScan｜暗號帶正則元字元也照樣抓得到（字面搜尋，不編譯成正則）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // `[` 會讓 new RegExp 當場丟、`.` 會大量誤中、`$` 反而找不到自己。正式路徑的暗號是 base36 碰不到，
  // 但這一格是可注入的，宣稱「字面搜尋」就要有題撐著（Codex #530 r5：改回 new RegExp 時四題活金絲雀題全綠）。
  const liveSecret = 'LIVE-CANARY-[meta].$^(regex)-9f2c4a7b';
  const iso = isolated(); const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `leaked: ${liveSecret}` })), relayScript: fakeRelay('ok'), liveSecret });
  assert.equal(r.code, 1, `帶元字元的暗號沒被抓到（或整支炸掉）：${r.summary.join('\n')}`);
});

test('runScan｜活金絲雀的暗號逐字 commit 在受掃樹裡，出現在回覆仍是 1（排除只作用在形狀那一族）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const liveSecret = 'LIVE-CANARY-TREE-9f2c4a7b1e';
  const repo = tinyRepo({ firstCommitFiles: { 'canary-lookalike.txt': liveSecret + '\n' } });
  const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `I read your store.db: ${liveSecret}` })), relayScript: fakeRelay('ok'), liveSecret });
  assert.equal(r.code, 1, `暗號被樹來源排除掉了——那是唯一不可偽造的那根針：${r.summary.join('\n')}`);
});

test('knownShapeHitsFromTree｜建不出來一律 throw，不回空集合（純函式，平台無關，CI 也跑）', () => {
  const repo = tinyRepo();
  // 這題直接打純函式：失敗形狀與訊息不必經過整條掃描流程就驗得到（接線由下一題跨平台驗）。
  assert.throws(() => knownShapeHitsFromTree(repo.dir, 'f'.repeat(40)), /ls-tree/, '查不到的 head 應該 throw');
  // 回空集合＝安靜退化成修法之前的行為，比丟例外糟：那會讓 #516 的假事故重新出現而沒人知道
  const ok = knownShapeHitsFromTree(repo.dir, repo.head);
  assert.equal(ok.hits.size, 0, 'tinyRepo 的樹裡沒有鑰匙形狀，這裡不該有命中');
  assert.ok(ok.blobs >= 2, `blob 數不對：${ok.blobs}`);
});

test('knownShapeHitsFromTree｜非 ASCII 檔名的 blob 也要讀到（`-z`；不然掃描器會靜靜跳過中文檔名）', () => {
  // 這個 repo 本來就有中文檔名。git 預設會把非 ASCII 路徑輸出成八進位轉義並加引號，
  // 沒有 -z 的話那些檔會查不到而被**靜靜跳過**——排除集合少一塊、引用到就誤報事故。
  const key = `${PEM_BEGIN('RSA')}\n${'MIIECJKNAMEKEYBODY' + 'Q'.repeat(50)}\n`;
  const repo = tinyRepo({ firstCommitFiles: { '中文檔名-鑰匙.pem': key } });
  const r = knownShapeHitsFromTree(repo.dir, repo.head);
  assert.equal(r.hits.size > 0, true, '非 ASCII 檔名的 blob 沒被讀到＝那個檔的形狀不在排除集合裡');
  assert.deepEqual([...r.bySource.keys()], ['中文檔名-鑰匙.pem'], `來源檔名不對：${[...r.bySource.keys()]}`);
});

test('knownShapeHitsFromTree｜超過單檔上限的 blob 要跳過，**而且要說出跳了誰**（涵蓋缺口不可以悄悄發生）', () => {
  // ⚠️ 這題釘的是「缺口看得見」，不是「缺口不存在」：跳過本身是刻意的（三形階梯會做兩次 JSON.stringify），
  //    但跳過的檔案形狀不進排除集合 ⇒ grok 引用到它就會誤報事故。所以跳了誰一定要能被印出來。
  // ⚠️ 用**注入的小門檻**而不是真的 16 MiB 檔：CI 上 `node --test` 多檔並行，
  //    真的大檔會配置數十 MB、把隔壁計時型考題壓過門檻（實測本支 2/2 紅、同時段重跑 main 綠）。
  const body = 'M'.repeat(200);
  const repo = tinyRepo({ firstCommitFiles: { 'big-key.pem': `${PEM_BEGIN('RSA')}\n${body}\n` } });
  const r = knownShapeHitsFromTree(repo.dir, repo.head, 64);
  assert.deepEqual(r.skippedBig, ['big-key.pem'], '跳過的大檔沒有被列出來＝呼叫端印不出缺口');
  assert.equal(r.hits.size, 0, '大檔的形狀不該進排除集合（跳過就是跳過；方向是誤報，不是靜靜放行）');
});

test('knownShapeHitsFromTree｜非 blob 的樹項目要跳過（gitlink＝物件不在這個 repo 裡，不跳過就會 throw）', () => {
  const repo = tinyRepo();
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8', env: CLEAN_ENV });
  // 直接寫一個 gitlink 進索引：它的 oid 指向一顆**這個 repo 裡沒有**的 commit
  git(['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`]);
  git(['commit', '-q', '-m', 'gitlink']);
  const head = git(['rev-parse', 'HEAD']).trim();
  assert.doesNotThrow(() => knownShapeHitsFromTree(repo.dir, head), '沒跳過非 blob ⇒ cat-file 會查不到那顆物件而失敗');
});

test('runScan｜排除集合的記帳要印出來：blob 數、命中數、跳過的大檔（含「等 N 個」）——缺口要看得見', async () => {
  // ⚠️ 純函式題只證明「回傳值裡有 skippedBig」；把**呼叫端那條記帳**整行拿掉、或只拿掉「等 N 個」，
  //    純函式題都還是綠的（Codex #530 r5 用定點突變證明）。所以這一題直接驗注入的 log 收到的字串。
  const big = 'M'.repeat(200);   // 搭配注入的小門檻（理由同上：不要在 CI 上配置大塊記憶體）
  const files = Object.fromEntries(['big1.pem', 'big2.pem', 'big3.pem', 'big4.pem'].map((n) => [n, `${PEM_BEGIN('RSA')}\n${big}\n`]));
  const repo = tinyRepo({ firstCommitFiles: files });
  /** @type {string[]} */ const logs = [];
  // ⚠️ 故意讓它在**雜湊檢查**就退場（給錯的 expectedSha256）：記帳那行在更早就印了，
  //    而這樣就不會起轉送器、不會跑沙箱——本題只看那一行，不該把整條掃描流程拖進來。
  await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, grokInstall: fakeGrok(), expectedSha256: '0'.repeat(64), maxBlobBytes: 64 });
  const line = logs.find((l) => l.startsWith('（破口已知來源：'));
  assert.ok(line, `記帳那行沒印出來：${logs.slice(0, 3).join(' / ')}`);
  // ⚠️ 用 \d+ 會放過「把數字硬編成任意值」——這裡驗真正的數字：
  //    tinyRepo 的第一顆 commit＝a.txt＋tree-only.txt＋四個大檔＝6 個 blob；大檔全跳過 ⇒ 形狀命中 0 條。
  assert.match(line, /head 樹 6 個 blob/, 'blob 數不對（或只印了外形）');
  assert.match(line, /形狀命中 0 條/, '命中數不對（大檔跳過了就不該有命中）');
  assert.match(line, /4 個超過單檔上限沒讀/, '沒印跳過幾個大檔');
  assert.match(line, /等 4 個/, '跳過清單被截成前三個卻沒說還有更多');
});

test('runScan｜已知來源（head 樹）建不出來 → 退 2 並指名是它，不安靜退回「只認材料」（接線；建盒子之前就退，平台無關）', async () => {
  const repo = tinyRepo();
  // 通過寫死 SHA 的格式檢查、但這個 repo 裡沒有這顆 commit
  const r = await runScan({ base: repo.base, head: 'f'.repeat(40), promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /已知來源/, '退 2 了但沒說是「已知來源建不出來」——分不出是哪一種失敗');
});

test('runScan｜比對強度：命中「以某條已知命中開頭」也不得被排除（放寬的危險方向）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 放寬有兩個方向，危險程度差很多：
  //   ・`known.startsWith(hit)`（命中是已知命中的前綴）＝截斷那一族；
  //   ・`hit.startsWith(known)`（命中**以**已知命中開頭）＝**更危險**：一條短的已知命中會把所有
  //     以它開頭的東西一起吞掉，而最短的合法命中只有 58 個字元、其中可以一個酬載字元都沒有
  //     （`{32,}` 的字元類含空白與反斜線＝長度下限、不是熵下限）。
  //   Codex #531 r1 抓到我原本只對前者做了突變、後者沒有題守著。
  // 做法：樹裡放一把鑰匙，日誌裡送「同一把鑰匙**再接上**更多酬載」——它以樹裡那條開頭，仍必須是事故。
  const repo = tinyRepo({ firstCommitFiles: { 'fixture-key.pem': PEM_TEXT } });
  // ⚠️ 要延長的是**命中本身**，所以接在 END 之前：`-----END` 裡的 `-` 不在破口正則的字元類裡，
  //    接在它後面命中會在那裡截斷，送出去的其實就是樹裡那條本身（第一版就是這樣，未突變也紅）。
  const extended = PEM_LINES.slice(0, -1).join('\\n') + '\\n' + 'MIIEEXTENDEDBEYONDTHEFIXTURE' + 'V'.repeat(40);
  const iso = isolated(); const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf '%s\\n' '{"type":"assistant","content":"${extended}"}' >> "$ws/fake-session/updates.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, `以已知命中開頭的更長命中被排除了——那是放寬裡最危險的方向：${r.summary.join('\n')}`);
});

/**
 * flexToken 那條腿的夾具：鍵名**執行時才拼**。
 * 直接寫字面會讓題名關鍵字「本檔源碼不留破口形狀的字面」那一題轉紅——那是既有的假事故防線，
 * 不可以為了寫這一題而放寬它。
 */
const FLEX_KV = (/** @type {string} */ val) => `"flex${'Token'}": ${JSON.stringify(val)}`;
const FLEX_VAL = 'SECRET-VALUE-1234567890';

test('BREACH_SHAPES｜flexToken 腿在 JSON 轉義形下也要認得（純函式，平台無關，CI 也跑）', () => {
  // 為什麼要有這一題：這條腿掃的是 grok 的 session 日誌，而那是 **JSONL**——原文的 `"` 在檔案裡是 `\"`。
  // 舊寫法要求 `flexToken` 後面緊跟一個**字面**的 `"` ⇒ 真的 flexToken 外洩到日誌裡**一條都認不得**，
  // 而且沒有第二道網（DLP 針只取自沙箱 auth.json，不含 flexToken）＝靜靜放過。
  assert.ok(FLEX_KV('x').includes('flex' + 'Token'), '夾具沒拼出鍵名');                       // 反空包彈
  assert.ok(FLEX_KV(FLEX_VAL).includes(FLEX_VAL), '夾具沒帶值');
  const material = `  ib: {\n${FLEX_KV(FLEX_VAL)}\n  }\n`;
  // ⚠️ 夾具**不可以**用 escapeForms 生（Codex #534 r1 的突變：讓它第三格重複第二格，這一題照樣綠
  //    ＝拿受測函式自己當 oracle）。這裡就地把三形算出來，再單獨斷言階梯本身逐字相同。
  const d0 = material, d1 = JSON.stringify(d0).slice(1, -1), d2 = JSON.stringify(d1).slice(1, -1);
  assert.notEqual(d1, d2, '就地算的兩形一樣＝夾具自己壞了，後面量不到東西');
  assert.deepEqual(escapeForms(material), [d0, d1, d2], 'escapeForms 的三形跟就地算的對不上');
  assert.equal(shapeHitsIn(d0).length, 1, '原文形（對照組：修法前後都該是 1）');
  assert.equal(shapeHitsIn(d1).length, 1, 'JSON 轉一層認不得——日誌走的就是這一形');
  assert.equal(shapeHitsIn(d2).length, 1, 'JSON 轉兩層認不得（同一檔裡兩種深度都出現過）');
  // 命中要**逐字結束在值本身**：只換引號、不擋轉義殘渣的話，命中會多吃反斜線 ⇒ 這一行轉紅
  assert.ok(shapeHitsIn(d1)[0].endsWith(FLEX_VAL), `命中夾帶了值以外的轉義殘渣：${JSON.stringify(shapeHitsIn(d1)[0].slice(-12))}`);
  // 真日誌長相：JSONL 一行、內容還帶讀檔工具的行號記號
  const line = JSON.stringify({ type: 'tool_result', content: `280→${material}` });
  const got = shapeHitsIn(stripLineMarkers(line));
  assert.equal(got.length, 1, '真 JSONL 一行（含行號記號）抓不到');
  // 對稱：日誌形的命中必須逐字落在排除側同一把階梯算出的集合裡，否則修完會變成下一次假事故
  const known = new Set([d0, d1, d2].flatMap((f) => shapeHitsIn(f)));
  for (const h of got) assert.ok(known.has(h), '日誌命中跟排除側對不上＝假事故');
});

test('BREACH_SHAPES｜值沒有收尾引號時，命中長度不可以由「上下文」決定（純函式，平台無關，CI 也跑）', () => {
  // ⚠️ 這一題守的是**修法自己會製造的假事故**：值那格若只擋引號、不擋換行，沒有收尾引號的文字
  //    （散文、表格、註解、grep 只列命中行——本專案天天在寫）會讓命中一路吃到「下一個引號」為止。
  //    於是同一段無害文字，在材料裡與在日誌裡算出**不同長度的字串**、精確比對的排除對不上 ⇒ 事故。
  //    這種文字最先出現的地方就是講這條腿的 PR 描述與註解本身。
  const one = `  一層  flex${'Token'}\\": \\"${FLEX_VAL}      舊 0 條／新 1 條   ← 病灶\n`;
  const withMore = one + `  兩層  flex${'Token'}\\\\\\": SOMETHING\n`;
  assert.ok(one.includes(FLEX_VAL) && withMore.includes(FLEX_VAL), '夾具沒帶值');   // 反空包彈
  const a = shapeHitsIn(one), b = shapeHitsIn(withMore);
  assert.equal(a.length, 1, '這段文字本來就該命中（不然本題量不到東西）');
  assert.equal(b.length, 1, '加上後文之後命中數變了');
  assert.equal(a[0], b[0], `同一段文字因為後文不同而算出不同命中＝排除必然對不上＝假事故：${a[0].length} vs ${b[0].length}`);
  assert.ok(!a[0].includes('\n'), '命中跨行了——視窗不是行內局部');
});

test('考題檔｜本檔源碼不留破口形狀的字面（純函式，平台無關，CI 也跑）', () => {
  // 為什麼要有這一題：#516（2026-08-26）與 #530（2026-08-30）兩支的複審後掃都判事故、兩次都靠
  // William 裁示「視為誤判」放行。⚠️ 分層講：**這一類**假事故的成因清楚——本檔的字面假鑰被引用時
  // 換了呈現、逐字對不上；但**那兩次具體命中了什麼**至今未定（現場被護欄自己刪掉：退 1 不留 sessions）。
  // 字面一旦回來，下一支動到本檔的 PR 又可能掃不乾淨——
  // 而複審後掃**不在任何合併閘的射程裡**（`scripts/check-*.js` 那幾道與 workflows 都不讀它的退出碼），
  // 漏掉不會有東西擋人——所以這件事只能靠這一題自己守。
  // ⚠️ 誠實劃界（三條）：
  //   ①看的是**本檔**，不是整棵樹：別的檔案新增假鑰它抓不到。全樹那條靠 runScan 的記帳行
  //     （會列出「來自 <檔>×<n>」）看得見，那是**看得見、不是擋得住**。
  //   ②只看**源碼**：考題執行後的值若進了 grok 的日誌仍會判事故——那本來就該判事故。
  //   ③掃描讀的是**已 commit** 的 blob，這一題讀的是工作區的檔；未 commit 的改動兩邊會不一致。
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  assert.deepEqual(shapeHitsIn(src), [], '本檔源碼含破口形狀命中——Grok 讀到它就可能判假事故');
  for (const form of [JSON.stringify(src), JSON.stringify(JSON.stringify(src))]) {
    assert.deepEqual(shapeHitsIn(form), [], '本檔源碼的 JSON 轉義形含破口形狀命中（日誌是 JSONL，走的是這一形）');
  }
  // 比「有沒有命中」寬一點的規則，因為它是人記得住的那一版：本檔不寫具體 kind 的字面標頭
  assert.equal(/-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/.test(src), false, '本檔出現字面標頭——請改用 PEM_BEGIN(kind) 執行時拼');
  // helper 自己要對：四種 kind 都要被偵測器認得，否則「改用 helper」等於把某些題悄悄變成不再命中
  for (const kind of /** @type {const} */ (['RSA', 'OPENSSH', 'EC', 'DSA'])) {
    assert.equal(shapeHitsIn(`${PEM_BEGIN(kind)}\n${'A'.repeat(40)}`).length, 1, `PEM_BEGIN('${kind}') 拼出來的標頭偵測器認不得`);
    // ⚠️ 上一行單獨是空包彈：helper 若忽略 kind、一律回 RSA，四種都還是命中 1（Codex #531 r1 實測）。
    //    要驗的是「kind 真的有進到標頭裡」。
    assert.equal(PEM_BEGIN(kind).includes(kind), true, `PEM_BEGIN('${kind}') 沒有把 kind 放進標頭——helper 忽略參數了`);
    // ⚠️ 只驗 includes 仍是空包彈：「固定產生 RSA 標頭、把 kind 接在尾端」也會過（Codex #531 r2 實測）。
    //    再驗兩件事：結尾要正確（接在尾端就會壞），且**不得混進別的 kind**（固定 RSA 就會壞）。
    assert.equal(PEM_BEGIN(kind).endsWith(' PRIVATE KEY-----'), true, `PEM_BEGIN('${kind}') 的結尾不對——kind 可能被接在尾端`);
    for (const other of ['RSA', 'OPENSSH', 'EC', 'DSA'].filter((k) => k !== kind)) {
      assert.equal(PEM_BEGIN(kind).includes(other), false, `PEM_BEGIN('${kind}') 裡混進了 ${other}——helper 可能固定回某一種`);
    }
  }
});

test('stripLineMarkers｜剝掉讀檔工具的行號記號（純函式，平台無關，CI 也跑）', () => {
  assert.equal(stripLineMarkers('1→abc\n10→def'), 'abc\ndef', '原文換行的記號沒剝掉');
  assert.equal(stripLineMarkers('x\\n12→abc'), 'x\\nabc', 'JSONL 的字面 \\n 前綴沒認出來');
  assert.equal(stripLineMarkers('見 12→ 那格'), '見 12→ 那格', '沒有換行前綴的數字不可以被當成行號吃掉');
  // ⚠️ 反斜線串要從**頭**認起：5 個以上時 `{1,4}` 會從第 2 個起算而誤剝（Codex #530 r1 抓到）
  assert.equal(stripLineMarkers('a\\\\\\\\\\n12→b'), 'a\\\\\\\\\\n12→b', '從反斜線串中段開始比對＝誤剝');
  // ⚠️ 誠實劃界：正文裡字面的 `\n12→` 與真記號分不出來，這一格照實斷言「會被剝掉」，不假裝守得住
  assert.equal(stripLineMarkers('x\\n12→y'), 'x\\ny', '這是已知的過度剝除，改行為要連同註解的劃界一起改');
  // `→` 不在破口正則的字元類裡：記號落在 `{32,}` **湊滿之前**時整條不匹配＝真鑰匙靜靜放行，剝完才看得見。
  // ⚠️ 條件是「湊滿之前」，**不是**「標頭之後」——先湊滿 32 個合法字元、記號落在那之後仍然命中（Codex #530 r8 的反例）。
  const keyWithMarker = `${PEM_BEGIN('RSA')}\n10→${'MIIEREALKEYBODY' + 'A'.repeat(50)}`;
  assert.equal(shapeHitsIn(keyWithMarker).length, 0, '前提變了：帶記號時本來就抓得到，這題的理由要重寫');
  assert.equal(shapeHitsIn(stripLineMarkers(keyWithMarker)).length, 1, '剝完仍抓不到＝靜默漏放沒被修掉');
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
      // ⚠️ 這一句要在**這裡**問：跑完才問的話，後面 finally 也會清一次，
      //    「emergency 自己有沒有清」就永遠問不出來（拿掉 emergency 那行、結尾的斷言仍然是綠的——實測過）。
      assert.deepEqual(readdirSync(iso.liveRoot), [], 'emergency 呼叫 exit 前還沒清活金絲雀');
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
  // ⚠️ 這一題**刻意**讓活金絲雀落在真家目錄：金絲雀的意義就在**位置**——家目錄同時住著真 ~/.grok、
  //    ~/.grok-sandbox-auth 與真的 store.db，是破出沙箱的人第一個會翻的地方。位置只能在正式位置上考。
  //    其餘走到活金絲雀那一步的題都經 isolated() 改道到隔離根。
  //    ⚠️ 另一個會碰真家目錄的是**沙箱金絲雀**：`runCanary` 也在家目錄 mkdtemp 一個 `.grok-canary-*`，
  //    而且它的四個根寫死、沒有可注入的參數。本檔只有題名關鍵字「不注入」那一題會走到它，其餘都注入假的。
  //    ⚠️ 別在這裡寫「全檔唯一還在真家目錄建東西的題」或「每一題都會」——兩種說法都不成立。
  // ⚠️ 認身分靠**每輪隨機的暗號內容**、不數個數：別的 session／審查樹／合併閘同時在跑也認不錯。
  //    （數個數正是上一題原本的寫法，也正是本支要修掉的病。）
  // ⚠️ 暗號現在走字面比對（不編譯成正則），所以帶元字元也不會炸；randomUUID 只有十六進位與 `-`，兩種寫法都安全。
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

/** 讀事故指紋包；沒有就直接讓題目說清楚（不要在後面才 undefined 爆掉） */
const readIncident = (/** @type {string} */ resultsRoot) => {
  const dirs = readdirSync(resultsRoot);
  assert.equal(dirs.length, 1, `結果根應該只有一個事故包，實際 ${dirs.length} 個`);
  const p = join(resultsRoot, dirs[0], 'incident.json');
  assert.ok(existsSync(p), '事故沒有留下 incident.json——證據又沒了');
  return { dir: join(resultsRoot, dirs[0]), json: JSON.parse(readFileSync(p, 'utf8')), raw: readFileSync(p, 'utf8') };
};

test('incident.json｜三族的欄位是**白名單**：DLP 與暗號族連雜湊、上下文都不可以有', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 為什麼用「鍵名白名單」而不是「值黑名單」：斷言「檔案裡沒有 sha256(REAL)」擋不住
  //    `sha256(REAL).slice(0,12)`、`base64(REAL)`、`{前四碼, 長度}` 這些同樣可反查的衍生物。
  //    DLP 針裡有低熵值（身分字串），截斷雜湊照樣查得回去，所以只能限制**能有哪些欄位**。
  const REAL = 'REAL-TOKEN-NEVER-IN-BOX-0123456789abcdef';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `leaked: ${REAL}` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const dlp = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'dlp');
  assert.ok(dlp.length >= 1, '沒有 dlp 族的命中——這一題量不到東西');
  for (const h of dlp) assert.deepEqual(Object.keys(h).sort(), ['family', 'len', 'where'], 'DLP 族多了不該有的欄位（雜湊／上下文都算）');
  assert.equal(raw.includes(REAL), false, '指紋包裡有真 token 原文');
});

test('incident.json｜形狀族要留得下判得出真假的東西：雜湊、字元組成、最近似排除項、遮蔽過的上下文', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const BODY = 'MIIEPLANTEDBODY' + 'W'.repeat(50);
  const planted = `${PEM_BEGIN('RSA')}\n${BODY}\n`;
  const repo = tinyRepo(); const iso = isolated();
  const replyText = `我編的示範：${planted}以上是示範`;
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: replyText })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const shape = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'shape');
  assert.equal(shape.length, 1, `形狀族命中數不對：${JSON.stringify(json.hits.map((/** @type {{family:string}} */ h) => h.family))}`);
  const h = shape[0];
  assert.equal(h.where, 'reply');
  // 期望值由考題自己算（拿實作的輸出回填就變成自證）；要對**回覆那份文字**算，
  // 因為私鑰那條腿的字元類含空白，命中會吃到 planted 後面緊接的空白為止。
  const expected = shapeHitsIn(replyText)[0];
  assert.ok(expected, '夾具沒產生命中');
  assert.equal(h.len, expected.length, '長度不是這條命中的');
  assert.equal(h.sha256, createHash('sha256').update(expected).digest('hex'), '雜湊不是這條命中的');
  assert.ok(h.profile.maxB64Run >= 50, `字元組成沒認出 base64 body：${JSON.stringify(h.profile)}`);
  assert.equal(typeof h.nearest.prefixLen, 'number');
  // 上下文：命中本身換成佔位符、周圍的字要在（那正是判「這是它編的示範」的依據）
  assert.equal(h.context.includes(BODY), false, '上下文把命中內容也寫進去了');
  assert.ok(h.context.includes('‹命中'), '上下文沒有佔位符');
  assert.ok(h.context.includes('我編的示範') && h.context.includes('以上是示範'), '上下文沒帶到周圍的字＝判不出真假');
  assert.equal(raw.includes(BODY), false, '指紋包裡有命中內容');
});

test('incident.json｜同一次掃描兩族都中刀時，族別不可以被標成同一種', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 沒有這一題，「照第一個中刀的族別標全部」與「只要有形狀命中就全部加雜湊」兩種突變都會過。
  const REAL = 'REAL-TOKEN-NEVER-IN-BOX-0123456789abcdef';
  const planted = `${PEM_BEGIN('EC')}\nMIIEBOTHFAMILIES${'Q'.repeat(50)}\n`;
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `${REAL} 與 ${planted}` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json } = readIncident(iso.resultsRoot);
  const fams = new Set(json.hits.map((/** @type {{family: string}} */ h) => h.family));
  assert.ok(fams.has('dlp') && fams.has('shape'), `兩族沒有各自標到：${[...fams].join('、')}`);
  for (const h of json.hits.filter((/** @type {{family: string}} */ x) => x.family === 'dlp')) assert.deepEqual(Object.keys(h).sort(), ['family', 'len', 'where']);
  for (const h of json.hits.filter((/** @type {{family: string}} */ x) => x.family === 'shape')) assert.ok(h.sha256 && h.context, '形狀族少了判定要用的欄位');
});

test('incident.json｜暗號族：欄位白名單、charOffset 是真的字元位置、整包不留任何可查表的衍生物', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這一題補的是 r1 抓到的假綠：原本只有 dlp 族有白名單，暗號族沒有
  //    ⇒ 幫暗號族加上 sha256(liveSecret) 的突變當時 4 題全綠。
  //    而且約束要套到**整包**，不是只套在 hits[]：頂層的 replySha256、sessionFiles[].sha256、
  //    被遮蔽的 where，任何一格留下可查表的衍生物都算破口。
  const SECRET = 'LIVE-CANARY-OFFSET-0123456789';
  const repo = tinyRepo(); const iso = isolated();
  // 暗號出現兩次，且第一次不在開頭——序號（0、1）與真位置就分得出來了
  const inst = fakeGrok({ reply: `前面墊一段話讓位置不是零。${SECRET} 中間 ${SECRET} 結束` });
  // 再讓 Grok 用**暗號當檔名**建一個 session 檔（內容也放暗號，才會走到那兩條事故訊息）：
  // 那條路徑會被回聲進 summary＝**公開的** PR 描述，所以 summary 與 incident 兩個輸出面都要斷言。
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf '${SECRET}\n' > "$ws/fake-session/${SECRET}.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok'), liveSecret: SECRET });
  assert.equal(r.code, 1, r.summary.join('\n'));
  // ⚠️ summary 會被抄進公開的 PR 描述——受控路徑在這裡回聲，遮了 incident 也沒用
  assert.equal(r.summary.join('\n').includes(SECRET), false, '公開摘要回聲了受控路徑裡的暗號');
  const { json, raw } = readIncident(iso.resultsRoot);
  const live = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'live');
  assert.ok(live.length >= 2, `暗號族命中數不對：${JSON.stringify(json.hits.map((/** @type {{family:string}} */ h) => h.family))}`);
  for (const h of live) assert.deepEqual(Object.keys(h).sort(), ['charOffset', 'family', 'len', 'where'], '暗號族多了不該有的欄位');
  assert.ok(live[0].charOffset > 0, `charOffset 是陣列序號不是字元位置：${live[0].charOffset}`);
  assert.notEqual(live[0].charOffset, live[1].charOffset, '兩次命中的位置一樣＝記的不是位置');
  // 整包：值本身、完整雜湊、截斷雜湊都不可以出現
  const full = createHash('sha256').update(SECRET).digest('hex');
  assert.equal(raw.includes(SECRET), false, '指紋包裡有暗號原文');
  assert.equal(raw.includes(full), false, '指紋包裡有暗號的完整雜湊');
  assert.equal(raw.includes(full.slice(0, 12)), false, '指紋包裡有暗號的截斷雜湊（一樣可查表）');
  assert.equal(json.replySha256, null, '回覆裡有已知機密，雜湊還是寫了');
  // 路徑那一格：遮蔽後的字串必須**就只有**記號與長度。
  // ⚠️ 不能靠上面那幾條「暗號的雜湊不出現」來守它——redactPath 雜湊的是**路徑**、不是暗號，
  //    兩者的 SHA 不一樣，那幾條斷言對這一格完全沒有射程（我第一版就是這樣守錯的）。
  //    路徑短、熵低，截斷雜湊對一個已知候選清單就是可查表的，所以只准留長度。
  const masked = json.sessionFiles.filter((/** @type {{rp: string}} */ f) => f.rp.startsWith('‹路徑已遮蔽'));
  assert.equal(masked.length, 1, `含暗號的路徑沒有被遮：${JSON.stringify(json.sessionFiles.map((/** @type {{rp:string}} */ f) => f.rp))}`);
  assert.match(masked[0].rp, /^‹路徑已遮蔽，長 \d+›$/, '遮蔽後的路徑帶了長度以外的東西（雜湊也算）');
});

test('incident.json｜兩條形狀命中靠在一起時，不可以透過彼此的上下文把對方原文帶出去', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ r1 抓到：redactWindow 原本只挖掉「自己那一條」，於是 A 的視窗完整包含 B、B 的視窗完整包含 A。
  //    原本的形狀族考題只有單一命中，所以量不到。
  const A = 'MIIEFIRSTHIT' + 'A'.repeat(50);
  const B = 'MIIESECONDHIT' + 'B'.repeat(50);
  const both = `${PEM_BEGIN('RSA')}\n${A}\n!間隔!${PEM_BEGIN('EC')}\n${B}\n`;
  const repo = tinyRepo(); const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: both })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const shape = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'shape');
  assert.equal(shape.length, 2, `這一題要兩條命中才量得到東西，實際 ${shape.length} 條`);
  assert.ok(shape.every((/** @type {{context: string}} */ h) => h.context.includes('‹另一條命中')), '視窗沒有遮掉另一條命中');
  assert.equal(raw.includes(A), false, '第一條命中的內容被另一條的上下文帶出去了');
  assert.equal(raw.includes(B), false, '第二條命中的內容被另一條的上下文帶出去了');
});

test('redactWindow｜壓在視窗邊界上的東西**連半截都不准留**（純函式，平台無關，CI 也跑）', () => {
  // ⚠️ r1 抓到「先切後替換會留半截」，我改成往外加寬——r2 證明那只是**把邊界往外移**：
  //    新邊界上照樣切得到半截。所以改成在原文上算區間、凡與視窗相交就整段換掉。
  //    這一題要守的是「半截」，不是「完整原文」——只斷言完整原文不出現，加寬版也會過。
  {
    const secret = 'BOUNDARY-SECRET-VALUE';
    const text = `${'x'.repeat(30)}${secret}${'y'.repeat(20)}HITHITHIT尾巴`;
    const w = redactWindow(text, text.indexOf('HITHITHIT'), 9, [secret], 25);   // span 25 ⇒ secret 壓在邊界
    assert.equal(w.includes(secret), false, '跨邊界的已知機密沒被遮掉');
    // 半截：任何長度 8 以上的連續片段都不准出現在視窗裡
    for (let i = 0; i + 8 <= secret.length; i++) assert.equal(w.includes(secret.slice(i, i + 8)), false, `視窗裡留下了機密的半截：位移 ${i}`);
    assert.ok(w.includes('‹已遮蔽›'), '沒有遮蔽記號＝根本沒切到那一段');
  }
  {
    // 長形狀命中跨過視窗外邊界：目標命中的視窗不可以帶出它的尾巴
    const longBody = 'MIIELONGONE' + 'A'.repeat(280);
    const longHit = `${PEM_BEGIN('RSA')}\n${longBody}\n`;
    const target = `${PEM_BEGIN('EC')}\nMIIETARGET${'B'.repeat(60)}\n`;
    const text = `${longHit}!間隔!${target}尾巴`;
    const idx = text.indexOf(PEM_BEGIN('EC'));
    const w = redactWindow(text, idx, shapeHitsIn(target)[0].length, [], 40);   // span 40 ⇒ 長命中橫跨外邊界
    assert.equal(w.includes('A'.repeat(20)), false, '長命中的尾巴被帶進視窗了');
    assert.ok(w.includes('‹另一條命中'), '相交的另一條命中沒有被整段換掉');
  }
});

test('關門｜任何文字進公開摘要／進事故檔之前都要先清洗（四種出口一起考）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這一題守的是**做法**不是單一出口：前三輪每一輪都被抓到「又一個沒遮到的出口」
  //    （自我重疊的機密、命中本身包住機密、深層路徑的錯誤訊息、提示檔的檔名）。
  //    William 2026-09-01 裁示改成關門：所有文字走同一支清洗。所以這一題挑**四個不同的出口**一起打，
  //    任何一個沒走那道門就會紅。
  const REAL = 'REAL-LOW-ENTROPY-NAME';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // 出口④：提示檔的**檔名**含機密
  const pd = keep(mkdtempSync(join(tmpdir(), 'fake-prompt-')));
  const pf = join(pd, `${REAL}.txt`); writeFileSync(pf, '【界線】測試用\n');
  // 出口②：形狀命中**本身包住**那個機密（值就是它）
  const inst = fakeGrok({ reply: `{"flex${'Token'}": "${REAL}-padding-to-8"}` });
  // 出口③：Grok 用機密當目錄名、疊到超過深度上限 ⇒ 錯誤訊息會逐字帶出那個路徑
  const deep = Array.from({ length: 14 }, (_, i) => (i === 0 ? REAL : `d${i}`)).join('/');
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `mkdir -p "$ws/fake-session/${deep}"; printf 'x\n' > "$ws/fake-session/${deep}/x.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: pf }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.notEqual(r.code, 0, `這一題要走到事故或退 2 才量得到東西：${r.summary.join('\n')}`);
  assert.equal(r.summary.join('\n').includes(REAL), false, `公開摘要漏出機密：${r.summary.join('\n').slice(0, 300)}`);
  // 有留事故包的話，整包也不准有
  for (const d of readdirSync(iso.resultsRoot)) for (const f of readdirSync(join(iso.resultsRoot, d))) {
    assert.equal(readFileSync(join(iso.resultsRoot, d, f), 'utf8').includes(REAL), false, `${f} 漏出機密`);
  }
});

test('關門｜事故檔整份寫出前要再過一次清洗：提示檔路徑這種「沒人各自遮」的欄位才擋得住', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這一題挑的是**只有最後那道門擋得到**的欄位：`promptFile` 路徑沒有經過任何一個各自的遮蔽器。
  //    （我第一版把它跟別的出口混在同一題，結果那次跑出來是退 2、根本沒有事故包，
  //     於是「事故檔不過關門」的突變照樣綠＝空包彈。）
  const REAL = 'REAL-LOW-ENTROPY-NAME';
  const SECRET = 'LIVE-CANARY-PACK-0123456789';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const pd = keep(mkdtempSync(join(tmpdir(), 'fake-prompt-')));
  const pf = join(pd, `${REAL}.txt`); writeFileSync(pf, '【界線】測試用\n');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: pf }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `洩漏：${SECRET}` })), relayScript: fakeRelay('ok'), liveSecret: SECRET });
  assert.equal(r.code, 1, `這一題要走到事故才有事故包：${r.summary.join('\n')}`);
  const { json, raw } = readIncident(iso.resultsRoot);
  assert.ok(json.hits.some((/** @type {{family: string}} */ h) => h.family === 'live'), '沒有暗號族命中＝這一題量不到東西');
  assert.equal(raw.includes(REAL), false, '提示檔路徑裡的機密進了事故包（整份清洗那道門沒生效）');
  assert.equal(raw.includes(SECRET), false, '事故包裡有暗號原文');
});

test('關門｜警報器也要認得跳脫形：三條成功出口（回覆／內容／檔名）都必須退 1', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Codex #535 r5：我 r4 只把跳脫形加進**清洗字典**（出口那道門），沒加進 `leaksIn`（警報器）
  //    ⇒ 跳脫形根本不算外洩、掃描退 0、`--out` 照寫、sessions 照存，那個表示還原得回原文。
  //    **門關好了但警報器是聾的，等於沒關。** 三條成功出口各考一次。
  const REAL = 'SYNTHETIC-"QUOTE"-BACK\\SLASH-0123456789';
  const [, ESC] = escapeForms(REAL);   // 日誌／回覆裡真正會出現的那一形
  assert.notEqual(ESC, REAL, '這根針沒有跳脫形＝這一題量不到東西');
  const repo = tinyRepo();

  // 出口①：只在**回覆**裡放跳脫形
  {
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const out = join(keep(mkdtempSync(join(tmpdir(), 'out-'))), 'reply.txt');
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `輸出：${ESC}` })), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `回覆裡的跳脫形沒被當外洩：${r.summary.join('\n')}`);
    assert.ok(!existsSync(out), '判事故了卻還是寫了 --out');
  }
  // 出口②：只在 session 檔的**內容**裡放跳脫形
  {
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf '%s\n' '{"type":"tool_started","x":"${ESC.replace(/'/g, "'\\''")}"}' > "$ws/fake-session/leak.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `session 內容裡的跳脫形沒被當外洩：${r.summary.join('\n')}`);
    assert.ok(!readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).includes('sessions/')), '判事故了卻還是留了 sessions');
  }
  // 出口③：只在 session 的**檔名**裡放跳脫形（檔名不能有 `/`，用不含斜線的那一形）
  {
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf 'x\n' > "$ws/fake-session/${ESC.replace(/(["\\$`])/g, '\\$&')}.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `檔名裡的跳脫形沒被當外洩：${r.summary.join('\n')}`);
  }
});

test('關門｜門要在第一句話出去之前上膛：DLP 字典就緒前的錯誤訊息也不准帶出 auth 實值', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Codex #535 r7：`scrubSecrets` 原本要等到 DLP 針那段（在後面很多行）才有內容，
  //    但憑證 refresh 的錯誤訊息在那之前就會走 `fail → say` 進公開摘要 ⇒ fail-closed 擋得住掃描，
  //    **擋不住那句話被抄進 PR 描述**。門有了但還沒上膛，等於沒有。
  //    ⚠️ 射程講清楚：守的是這個階段**列出來的這幾條**錯誤路徑，不是「每一條」——
  //       原本那樣寫超過實際射程（Codex #535 r8）。含兩條**隱式**的解析例外：
  //       Node 原生的 SyntaxError 會把輸入前綴印進 message，只擋自己寫的訊息是擋不到的。
  //    ⚠️ 斷言也要擋**前綴**，不是只擋完整值：洩漏出去的往往只是開頭幾個字。
  const EARLY = 'SYNTHETIC-EARLY-VALUE-SECRET-0123456789';
  // ⚠️ 對照組：先證明**這個 runtime** 的原生解析訊息真的會帶出前綴，否則下面那一格就是空包彈。
  try { JSON.parse(`{"broken": ${EARLY}}`); assert.fail('夾具竟然解析成功'); }
  catch (e) { assert.ok(/** @type {Error} */ (e).message.includes(EARLY.slice(0, 8)), '這個 runtime 的原生訊息不含前綴＝壞 JSON 那一格量不到東西，換夾具'); }
  const repo = tinyRepo();
  for (const [label, auth, want] of /** @type {[string, string, RegExp][]} */ ([
    ['issuer 不合法', fakeAuth({ issuer: EARLY }), /不等於釘住的/],
    ['client_id 不合法', fakeAuth({ clientId: EARLY }), /oidc_client_id/],
    ['進盒欄位格式不對', fakeAuth({ extra: { user_id: EARLY } }), /格式不對|不等於釘住的|鍵名/],
    // 隱式：壞掉的 auth JSON ⇒ 原生 SyntaxError 會帶出內容前綴
    // ⚠️ 夾具要用**未加引號的 token**：`{"a": "值"`（未閉合字串）那種在 Node v26 的原生訊息
    //    只有 `Expected ',' or '}'`、**不含值**，考題會變成量不到東西的空包彈（Codex #535 r9 抓到）。
    ['auth.json 不是合法 JSON', `{"broken": ${EARLY}}`, /不是合法 JSON|讀不出來/],
    // 走 `log` 不走 `say` 的那條：expires_at 只驗過「是非空字串」，壞值原本會被原文印進 log
    ['expires_at 不是合法時間', fakeAuth({ extra: { expires_at: EARLY } }), /expires_at|格式不對|不等於釘住的/],
  ])) {
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), auth);
    // ⚠️ **連 raw log 一起收**：有些路徑走的是 `log` 不是 `fail → say`，只看 summary 量不到（Codex #535 r9）
    const logs = /** @type {string[]} */ ([]);
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...iso, log: (m) => logs.push(m), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    const out = [...r.summary, ...logs].join('\n');
    assert.equal(r.code, 2, `${label}：沒有 fail-closed：${out}`);
    assert.match(out, want, `${label}：走的不是預期那條路＝這一格量不到東西`);
    // 完整值的每一種表示都不准出現；**前綴也不准**（原生解析錯誤洩的就是前綴）
    for (const form of escapeForms(EARLY)) assert.equal(out.includes(form), false, `${label}：公開摘要帶出了 auth 實值（長 ${form.length}）`);
    for (let n = 8; n <= EARLY.length; n++) assert.equal(out.includes(EARLY.slice(0, n)), false, `${label}：公開摘要帶出了 auth 實值的前 ${n} 個字`);
  }
  // 第五條：**refresh 回應**不是合法 JSON。這條特別要緊——回應裡可能是**還沒進字典的新值**
  //（Codex #535 r8 點名），所以連「事後才建字典」都救不了它，只能不回顯。
  {
    const NEW = 'SYNTHETIC-FRESH-TOKEN-FROM-SERVER-0123456789';
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ expiresInMs: -1000 }));   // 已過期 ⇒ 會去 refresh
    const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(`Unexpected token 'S', "${NEW}" is not valid JSON`); } });
    const logs = /** @type {string[]} */ ([]);
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...iso, log: (m) => logs.push(m), fetchImpl: badJson, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    const out = [...r.summary, ...logs].join('\n');
    assert.equal(r.code, 2, `refresh 回應壞掉時沒有 fail-closed：${out}`);
    assert.match(out, /不是合法 JSON|refresh/, '走的不是預期那條路＝這一格量不到東西');
    for (let n = 8; n <= NEW.length; n++) assert.equal(out.includes(NEW.slice(0, n)), false, `refresh 回應：公開摘要帶出了伺服器回來的新值的前 ${n} 個字`);
  }
});

test('關門｜兩次讀 auth 之間被換掉：DLP 來源那格也不可以回顯檔案內容', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 我原本把這一格記成「今天走不到」——**不成立**（Codex #535 r9）：
  //    `refreshSandboxAuth` 讀一次、DLP 針那段再讀一次，中間隔著 manifest／版本／盒子／金絲雀／diff。
  //    既有的 `afterGrokHomeAuthWrite` 鉤子就落在兩次讀取之間，測試可以在那裡把檔案換成壞的，
  //    穩定走到那個 catch。所以那是**競態**、不是不可達，註解要照這樣寫。
  const MID = 'SYNTHETIC-MIDSWAP-VALUE-0123456789';
  try { JSON.parse(`{"broken": ${MID}}`); assert.fail('夾具竟然解析成功'); }
  catch (e) { assert.ok(/** @type {Error} */ (e).message.includes(MID.slice(0, 8)), '這個 runtime 的原生訊息不含前綴＝這一題量不到東西'); }
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth());
  const logs = /** @type {string[]} */ ([]);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, {
    ...iso, log: (m) => logs.push(m), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok'),
    // 兩次讀取之間把檔案換成「原生訊息會帶出前綴」的壞 JSON
    afterGrokHomeAuthWrite: () => writeFileSync(join(iso.authDir, 'auth.json'), `{"broken": ${MID}}`),
  });
  const out = [...r.summary, ...logs].join('\n');
  assert.equal(r.code, 2, `DLP 來源壞掉時沒有 fail-closed：${out}`);
  assert.match(out, /DLP 真相來源/, '走的不是那條路＝這一題量不到東西');
  for (let n = 8; n <= MID.length; n++) assert.equal(out.includes(MID.slice(0, n)), false, `公開輸出帶出了檔案內容的前 ${n} 個字`);
});

test('關門｜上下文視窗要用同一份表示清單：已是跳脫形的針不可以從 context 還原得回來', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Grok 複審後掃 2026-09-01 抓到的第四條出口：`redactWindow` 原本只餵**原文**針，
  //    但日誌裡的針常常已經是跳脫形 ⇒ 視窗不會把它標成要遮的區間；接著整包再序列化一次，
  //    檔裡變成更深一層，連最後那道門的字典也涵蓋不到，`hits[].context` 就帶著可還原的針。
  //    事故照樣會判（所以不寫 --out、不留 sessions），但**證據包本身漏了**。
  const REAL = 'SYNTHETIC-"QUOTE"-CONTEXT-0123456789';
  // ⚠️ 要用**第二層**跳脫形（JSONL 裡再嵌一層 JSON 就是這一形）：
  //    第一層的話，整包序列化之後剛好變成第二層、還在清洗字典的涵蓋範圍內，
  //    最後那道門會接住 ⇒ 這一題就量不到「視窗只餵原文」這個病（我第一版就是這樣，突變沒轉紅）。
  const [, ESC1, ESC] = escapeForms(REAL);
  assert.ok(ESC !== ESC1 && ESC1 !== REAL, '這根針的三種表示沒有互異＝這一題量不到東西');
  const planted = `${PEM_BEGIN('RSA')}\nMIIECTXWINDOW${'Z'.repeat(50)}\n`;
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // 形狀命中旁邊就放那根針的跳脫形 ⇒ 它一定落在 context 的視窗裡
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `旁邊有 ${ESC} 然後 ${planted} 結束` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const shape = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'shape');
  assert.ok(shape.length >= 1 && shape.some((/** @type {{context?: string}} */ h) => h.context), '沒有帶 context 的形狀命中＝這一題量不到東西');
  // ⚠️ 斷言要看**parse 回來的語意值**，而且要比對**所有表示**：
  //    漏出去的那一形在檔案裡是第三層，raw 只比對 0–2 層會漏掉它（我第一版就是這樣，突變沒轉紅）。
  //    parse 一次之後它退回第二層，跟 escapeForms 的第三格對得上。
  const forms = escapeForms(REAL);
  const walk = (/** @type {unknown} */ v) => {
    if (typeof v === 'string') for (const f of forms) assert.equal(v.includes(f), false, `parse 回來的欄位裡還留著針的某一種表示（長 ${f.length}）`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(JSON.parse(raw));
});

test('關門｜不誤傷：某個表示本來就在給盒子的材料裡時，引用它不算外洩', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 判準放寬到「各種表示」之後，反方向的風險是**誤報**：Grok 引用我們自己給它的材料就被判事故。
  //    既有那道「針已在材料裡就不採用」要一起套到表示層，這一題釘住它。
  const REAL = 'SYNTHETIC-"QUOTE"-IN-MATERIALS-0123456789';
  const [, ESC] = escapeForms(REAL);
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // 指示檔裡就有那個表示 ⇒ 它是「給盒子的東西」，Grok 抄回來不算外洩
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(`參考：${ESC}\n`) }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `我抄一次：${ESC}` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 0, `引用公開材料被誤判成外洩：${r.summary.join('\n')}`);
});

test('關門｜帶跳脫字元的機密：事故檔的**各種序列化表示**都不准留（parse 回來也要乾淨）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Codex #535 r4：事故檔是先 JSON.stringify 再過門的，針裡有 `"`／反斜線時，
  //    序列化後的文字不再逐字含原文 ⇒ 門命不中，而 JSON.parse 回來還原得出完整機密。
  //    所以斷言要**兩種都驗**：raw 文字不含各種表示，parse 後的語意值也不含。
  const REAL = 'SYNTHETIC-"QUOTE"-BACK\\SLASH-0123456789';
  const SECRET = 'LIVE-CANARY-ESCAPED-0123456789';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // ⚠️ 機密要放在**真的會原樣進事故檔的欄位**——`promptFile` 路徑就是那一格。
  //    我第一版只把它放進回覆，但回覆原文根本不進事故檔 ⇒ 有沒有轉義形都一樣過＝空包彈。
  const pd = keep(mkdtempSync(join(tmpdir(), 'fake-prompt-')));
  const pf = join(pd, `${REAL}.txt`); writeFileSync(pf, '【界線】測試用\n');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: pf }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `洩漏：${SECRET}` })), relayScript: fakeRelay('ok'), liveSecret: SECRET });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { raw } = readIncident(iso.resultsRoot);
  for (const form of escapeForms(REAL)) assert.equal(raw.includes(form), false, `事故檔留下了機密的某一種序列化表示（長 ${form.length}）`);
  // 語意層：整份 parse 回來，任何字串欄位都不准還原出那個值
  const walk = (/** @type {unknown} */ v) => {
    if (typeof v === 'string') assert.equal(v.includes(REAL), false, 'parse 回來還原得出完整機密');
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(JSON.parse(raw));
  assert.equal(r.summary.join('\n').includes(REAL), false, '公開摘要也留下了機密');
});

test('關門｜機密只出現在 session 檔名、內容無害時，也要算事故（第三個出口）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Codex #535 r4：驗屍原本只比對檔案**內容**，所以「只有檔名帶機密」會一路走到成功路徑，
  //    把原始檔名接進結果包落盤——那是 say() 與 writeIncident() 以外的第三個出口。
  const REAL = 'SYNTHETIC-FILENAME-DLP-0123456789';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const inst = fakeGrok();   // 回覆與檔案內容都無害
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf 'harmless\n' > "$ws/fake-session/${REAL}.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, `只有檔名帶機密時沒有判成事故：${r.summary.join('\n')}`);
  assert.equal(r.summary.join('\n').includes(REAL), false, '公開摘要回聲了檔名裡的機密');
  // 結果樹裡**任何一段路徑或內容**都不准含那個值
  for (const f of readdirSync(iso.resultsRoot, { recursive: true, withFileTypes: true })) {
    const full = join(f.parentPath ?? f.path, f.name);
    assert.equal(full.includes(REAL), false, `結果包留下了帶機密的路徑：${f.name}`);
    if (f.isFile()) assert.equal(readFileSync(full, 'utf8').includes(REAL), false, `${f.name} 內容含機密`);
  }
});

test('關門｜清洗要把重疊區間接成一整段：機密自我重疊時，公開摘要不可以留下殘段', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這一題守的是**關門那支清洗函式**（不是視窗那支）。
  //    ⚠️ 病不在「起點漏掃」而在**殘段**：機密是 16 個 A、文字裡有 24 個 A 時，換掉第一段之後
  //    剩下的 8 個 A **本身不構成完整機密**，再怎麼往下找都找不到。所以要把重疊的區間先接成一整段再拿掉。
  //    （我第一版寫成「每次前進 1 個字」，那只解決起點、解決不了殘段，考題當場打臉。）
  const REAL = 'A'.repeat(16);                      // 自我重疊的 DLP 針
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // 讓 Grok 用「更長的同一個字元」當目錄名、疊過深度上限 ⇒ 錯誤訊息會帶出那串字，走 fail → say
  const deep = Array.from({ length: 14 }, (_, i) => (i === 0 ? 'A'.repeat(24) : `d${i}`)).join('/');
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `mkdir -p "$ws/fake-session/${deep}"; printf 'x\n' > "$ws/fake-session/${deep}/x.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  const out = r.summary.join('\n');
  assert.match(out, /深度|讀不完/, `這一題要走到「sessions 讀不完」那條路才量得到東西：${out.slice(0, 300)}`);
  assert.equal(out.includes('A'.repeat(8)), false, `公開摘要留下了自我重疊機密的半截：${out.slice(0, 300)}`);
});

test('關門｜形狀命中本身包住已知機密時，連雜湊都不給（否則就是「固定前綴＋低熵值」的可查表雜湊）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const REAL = 'REAL-LOW-ENTROPY-NAME';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `{"flex${'Token'}": "${REAL}-padding"}` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const shape = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'shape');
  assert.ok(shape.length >= 1, `這一題要有形狀命中才量得到東西：${JSON.stringify(json.hits)}`);
  for (const h of shape) assert.deepEqual(Object.keys(h).sort(), ['charOffset', 'family', 'len', 'where'], '命中含已知機密，卻還是寫了雜湊／上下文');
  assert.equal(raw.includes(REAL), false, '事故包漏出機密');
});

test('redactWindow｜機密自我重疊時，每一個起點都要遮到（純函式，平台無關，CI 也跑）', () => {
  // ⚠️ Codex r3：原本每找到一次就前進 v.length，自我重疊的機密會漏掉後面的起點，
  //    剩下的半截照樣是可辨識的片段。
  const secret = 'A'.repeat(16);
  const text = `${'A'.repeat(24)}HITHITHIT尾巴`;
  const w = redactWindow(text, text.indexOf('HITHITHIT'), 9, [secret], 100);
  assert.equal(w.includes('A'.repeat(8)), false, `自我重疊的機密留下了半截：${w.slice(0, 60)}`);
});

test('nearestKnown｜兩臂比較：同一把鑰匙被截斷 vs 同標頭但無關（純函式，平台無關，CI 也跑）', () => {
  // ⚠️ 這一題刻意寫成**兩臂比較**，不是單臂門檻：單臂門檻是我自己挑的數字，證明不了它分得開兩種情形。
  const treeKey = `${PEM_BEGIN('RSA')}\n${Array.from({ length: 8 }, (_, i) => `MIIETREEARM${String.fromCharCode(65 + i).repeat(45)}`).join('\n')}\n`;
  const known = new Set(shapeHitsIn(treeKey));
  assert.equal(known.size, 1, '夾具沒產生排除項＝這一題量不到東西');
  const truncated = shapeHitsIn(treeKey.slice(0, Math.floor(treeKey.length * 0.55)))[0];
  const unrelated = shapeHitsIn(`${PEM_BEGIN('RSA')}\n${Array.from({ length: 8 }, (_, i) => `MIIEOTHERARM${String.fromCharCode(97 + i).repeat(46)}`).join('\n')}\n`)[0];
  assert.ok(truncated && unrelated, '兩臂夾具沒都命中');
  const a = nearestKnown(truncated, known, ''), b = nearestKnown(unrelated, known, '');
  const ratio = (/** @type {{prefixLen: number, hitLen: number}} */ n) => n.prefixLen / n.hitLen;
  assert.ok(ratio(a) > 0.9, `截斷臂沒被認出同源：${JSON.stringify(a)}`);
  assert.ok(ratio(b) < 0.3, `無關臂被誤認成同源：${JSON.stringify(b)}`);
  assert.ok(ratio(a) - ratio(b) > 0.5, '兩臂拉不開＝這個判別式交付不了它的承諾');
});

test('hitProfile｜「標頭＋一堆空白」那個自承的誤報族要看得出來（純函式，平台無關，CI 也跑）', () => {
  // 破口正則的字元類含 \s 與 \\，所以「標頭＋32 個空白」也算命中。最長連續 b64 片段能否證它不是鑰匙？
  const noisy = shapeHitsIn(`${PEM_BEGIN('DSA')}${' '.repeat(40)}`)[0];
  const real = shapeHitsIn(`${PEM_BEGIN('DSA')}\n${'M'.repeat(64)}`)[0];
  assert.ok(noisy && real, '夾具沒都命中');
  assert.ok(hitProfile(noisy).maxB64Run < 10, `空白那族的最長 b64 片段太長：${JSON.stringify(hitProfile(noisy))}`);
  assert.ok(hitProfile(real).maxB64Run >= 60, `真 body 的最長 b64 片段太短：${JSON.stringify(hitProfile(real))}`);
  // ⚠️ 只否證一個方向：maxB64Run 大**不代表**是真外洩（真假鑰匙的 body 都是 base64）。
});

test('redactWindow｜命中換成佔位符、已知機密遮掉、周圍的字要留著（純函式，平台無關，CI 也跑）', () => {
  const secret = 'ANOTHER-KNOWN-SECRET';
  const text = `前面說了${secret}然後 HITHITHIT 後面還有話`;
  const w = redactWindow(text, text.indexOf('HITHITHIT'), 9, [secret], 50);
  assert.equal(w.includes('HITHITHIT'), false, '命中沒被換掉');
  assert.equal(w.includes(secret), false, '視窗裡的已知機密沒被遮掉');
  assert.ok(w.includes('‹命中 9 字，內容不留›'), '佔位符不對');
  assert.ok(w.includes('前面說了') && w.includes('後面還有話'), '周圍的字沒留＝判不出真假');
});

test('runScan｜Grok 掃描抓到：沒掃成（退 2）不在 ~/.grok-scan-results 留任何目錄；事故（退 1）留 launch.json＋incident.json、不留 sessions', async (t) => {
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
    const dir = join(iso.resultsRoot, dirs[0]);
    assert.deepEqual(readdirSync(dir).sort(), ['incident.json', 'launch.json'], '事故包的內容物變了');
    // ⚠️ 檔名清單證明不了「沒有把命中內容寫上磁碟」——逐檔掃內容才算。本例的命中就是暗號本身。
    for (const f of readdirSync(dir)) assert.equal(readFileSync(join(dir, f), 'utf8').includes('LIVE-CANARY-X-0123456789'), false, `${f} 裡有命中內容`);
  }
});
