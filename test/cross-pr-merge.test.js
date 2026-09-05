// @ts-check
// 跨 PR 試合併閘的考題（2026-08-03）。
//
// ## 為什麼需要這道閘
//
// 2026-08-03 一個晚上撞了兩次，兩次都是「**一支的規則禁止了另一支的內容**」：
// #384 加了「AGENTS.md 標題只准 `##`／`###`」，而 #385 寫了 `#### 兩條規則`；
// 修完之後 #384 又加了「AGENTS.md 一個 `<` 都不准」，而 #385 寫了 `🤖 <角色>`。
//
// 兩次都**沒有改到同一個檔案的同一行** ⇒ GitHub 不顯示衝突、兩支 CI 都綠、
// **合併第二支的當下 `main` 就紅了**。
//
// ## 這支考題的分工
//
// 純函式（`othersToTry`／`verdict`）在這裡鎖行為；
// **退出碼**用假 `gh` 走完整入口鎖住——比照 `review-verdicts-cli.test.js` 的教訓：
// 那次把阻擋分支的 `return 1` 突變成 `return 0`，12 題純函式**全部照樣綠**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, symlinkSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { othersToTry, verdict, MERGE_GATE, redDetail, cantRunSignal, CANT_RUN_CAUSES, runIn, lockMismatches, RERUN_LIMITS, failingTestNames, resultShapeProblems } from '../scripts/check-cross-pr-merge.js';
import { injectDirtyGitEnv, DIRTY_GIT_ENV } from './helpers/dirty-git-env.js';
import { worktreeIntegrityProblems } from '../scripts/check-worktree-integrity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/check-cross-pr-merge.js');

const pr = (/** @type {number} */ number, /** @type {any} */ extra = {}) => ({
  number, headRefOid: `sha${number}`, headRefName: `b${number}`, baseRefName: 'main', ...extra,
});

test('挑選｜排除自己，其餘 base=main 的 open PR 都要試', () => {
  const got = othersToTry([pr(384), pr(385), pr(387)], 385);
  assert.deepEqual(got.map((p) => p.number), [384, 387]);
});

test('挑選｜base 不是 main 的不試（那是堆疊，交給堆疊閘）', () => {
  const got = othersToTry([pr(390, { baseRefName: 'feat/x' }), pr(391)], 385);
  assert.deepEqual(got.map((p) => p.number), [391]);
});

test('⭐ 挑選｜**草稿也要試**（草稿階段正是最容易寫出互斥內容的時候）', () => {
  const got = othersToTry([pr(392, { isDraft: true })], 385);
  assert.deepEqual(got.map((p) => p.number), [392],
    '草稿被跳過了——草稿一樣會被合併，而且它還在改，更容易跟別支撞');
});

test('挑選｜順序固定（同樣的輸入不該有兩種輸出）', () => {
  assert.deepEqual(othersToTry([pr(391), pr(384), pr(387)], 385).map((p) => p.number), [384, 387, 391]);
});

test('裁決｜沒有其他 open PR → 0，而且訊息要說清楚「不需要試」', () => {
  const v = verdict([]);
  assert.equal(v.code, 0);
  assert.match(v.message, /沒有其他 open PR/);
});

test('裁決｜全部合得起來 → 0', () => {
  assert.equal(verdict([{ number: 384, ok: true, why: '' }]).code, 0);
});

test('⭐ 裁決｜任一支合起來會壞 → 1（這是它存在的全部理由）', () => {
  const v = verdict([
    { number: 384, ok: true, why: '' },
    { number: 385, ok: false, kind: 'red', why: '合起來之後「考試」紅了：契約標題不是允許的寫法' },
  ]);
  assert.equal(v.code, 1);
  assert.match(v.message, /#385/);
  assert.match(v.message, /各自的 CI 都是綠的/, '訊息沒有解釋「為什麼兩支 CI 綠還是會壞」——那正是最難懂的地方');
});

test('⭐ 裁決｜**兩種壞法要分開講**（第一次實跑就發現我原本混為一談了）', () => {
  // 文字衝突：GitHub 自己就看得到（合併鍵會變灰）——這道閘的價值只是「提早告訴你」。
  // 合起來測試紅：GitHub **不會**顯示——那才是它存在的理由。
  // 把兩種都說成「GitHub 不會顯示衝突」是不準確的，而且會讓人不信任後面那句。
  const textOnly = verdict([{ number: 387, ok: false, kind: 'conflict', why: '文字衝突，git merge 就過不去' }]);
  assert.match(textOnly.message, /GitHub 自己就看得到/);
  assert.doesNotMatch(textOnly.message, /GitHub \*\*不會\*\* 顯示/u);

  const testRed = verdict([{ number: 385, ok: false, kind: 'red', why: '合起來之後「考試」紅了：契約標題不是允許的寫法' }]);
  assert.match(testRed.message, /GitHub \*\*不會\*\*顯示/);
  assert.match(testRed.message, /護欄擋掉了另一支的內容/);
});

test('自報｜這支要自報是合併閘，否則註冊表數不到它', () => {
  assert.equal(typeof MERGE_GATE, 'object');
  for (const k of ['name', 'why']) {
    assert.ok(typeof MERGE_GATE[k] === 'string' && MERGE_GATE[k].trim(), `MERGE_GATE.${k} 要是非空字串`);
  }
});

// ── 退出碼才是這支對外的介面：用假 gh 走完整入口 ──────────────

/** 造一支假的 `gh`，讓腳本走真實路徑。 @param {string} viewJson @param {string} listJson */
function withFakeGh(viewJson, listJson, { exitCode = 0, pr = '385', cwd = ROOT, env = process.env } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cross-pr-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh
case "$1 $2" in
  "pr view") cat <<'JSON'\n${viewJson}\nJSON
  ;;
  "pr list") cat <<'JSON'\n${listJson}\nJSON
  ;;
esac
exit ${exitCode}
`);
  chmodSync(gh, 0o755);
  try {
    return spawnSync(process.execPath, [SCRIPT, pr], {
      encoding: 'utf8', cwd,
      env: { ...env, PATH: `${dir}:${env.PATH}` },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SELF = JSON.stringify({ number: 385, headRefOid: 'aabbcc', baseRefName: 'main' });

test('CLI｜沒有其他 open PR → exit 0（不會白花時間去建工作區）', () => {
  const r = withFakeGh(SELF, JSON.stringify([{ number: 385, headRefOid: 'aabbcc', headRefName: 'b385', baseRefName: 'main' }]));
  assert.equal(r.status, 0, `預期 0，實得 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /沒有其他 open PR/);
});

test('⭐ CLI｜gh 失敗 → exit 2（fail-closed，「查不到」不等於「安全」）', () => {
  const r = withFakeGh(SELF, '[]', { exitCode: 1 });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
});

test('CLI｜gh 回傳不是 JSON → exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cross-pr-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, '#!/bin/sh\necho "not json"\n');
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, '385'],
    { encoding: 'utf8', cwd: ROOT, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

test('⭐ CLI｜gh 的 open PR 清單有一筆缺 baseRefName（或 number／headRefOid 壞掉）→ exit 2，不可以被靜靜濾掉變成「沒有其他 open PR」退 0（#566 r9）', () => {
  for (const broken of [
    { number: 567, headRefOid: 'deadbeef', headRefName: 'other' },                       // 缺 baseRefName
    { number: '567', headRefOid: 'deadbeef', headRefName: 'other', baseRefName: 'main' },  // number 不是數字
    { number: 567, headRefOid: '', headRefName: 'other', baseRefName: 'main' },            // headRefOid 空
    null,
  ]) {
    const r = withFakeGh(SELF, JSON.stringify([{ number: 385, headRefOid: 'aabbcc', headRefName: 'x', baseRefName: 'main' }, broken]));
    assert.equal(r.status, 2, `${JSON.stringify(broken)}：預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}\n——0＝壞掉的那一筆被當成「不是 main」濾掉，整輪變成沒有其他 open PR`);
    assert.match(r.stderr, /形狀不對/);
    assert.doesNotMatch(r.stdout, /沒有其他 open PR/);
  }
});

test('CLI｜gh 回傳形狀不對（缺 headRefOid）→ exit 2', () => {
  const r = withFakeGh(JSON.stringify({ number: 385 }), '[]');
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

test('CLI｜沒給 PR 編號 → exit 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

// ── 環境假紅（2026-08-11 #441 實踩）：發起樹沒有 node_modules ──────────
//
// Codex 從 /private/tmp 的代合併樹（detached、**沒有 node_modules**）發起這道閘，
// 臨時工作區的 node_modules symlink 指回發起樹＝懸空連結，三關全部 127，
// 被誤報成「#442 合起來之後『校對』紅了」退出碼 1——但 #442 只動兩個 .md，
// 從主目錄重跑同一道閘＝0。環境問題要走「查不清楚」（2），不可以冒充「兩支相斥」（1）。

/** 沙盒 env **從零組**（只給 PATH／HOME）——下面會跑 `git init`（2026-08-09 事故的
 *  兇器），紀律照 `test/worktree-integrity.test.js` 檔頭的宣告：GIT_* 不可能洩進去。 */
const SANDBOX_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

/**
 * 造一棵「發起樹」：暫存目錄裡的極小 git repo。
 * 帶一顆真 commit（package.json 的三關指令預設必炸＝127）——這樣萬一先驗被拿掉，
 * 腳本會一路走到真的 worktree＋npm，**原樣重演 #441 的誤報**，
 * 考題就把事故直接端到眼前，而不是只靠訊息比對間接推理。
 *
 * `nodeModules`：'none'（預設，#441 的形狀）／'dir'（空目錄——先驗放行，換三關的
 * 「執行不起來」分類接手）／'file'（普通檔案——existsSync 會說 true 的那個洞，#446 r1）。
 * `scripts`：換掉三關指令（例如換成「跑得起來、退出碼 1」來演真的紅）。
 * `conflictPair`：再造一對「同一個檔案從共同 base 改成不同內容」的 head（sha／shaB），
 * 真的合不起來——給文字衝突的端到端接線題用（#446 r6）。
 * `lock`：base 那顆 commit 的 package-lock.json 要求哪些套件（預設零套件——現行考題的
 * 形狀不變，lock 核對必過）；`installed`：node_modules 裡實際裝著的套件與版本（要 nodeModules='dir'）；
 * `otherLock`：再造一顆「只改 package-lock.json」的 head（shaB），演「另一支動了 lock」。
 * `selfLock`：另一支從 base 分岔只加一個檔；本支從 base 開分支、只改 package-lock.json；main 停在 base
 * （演「本支那側動了 lock、另一支沒動」——#561 那時的形狀）。回傳 sha＝本支 head、shaB＝另一支、mainSha＝main。
 * `mainLock`：另一支從 base 分岔只加一個檔；**main 自己**再往前一顆改 lock 的 commit；本支從新 main 開分支
 * 只加一個檔（演「main 在兩支分岔之間動了 lock、兩支都沒動」——#566 r1 Codex 點名的形狀）。
 * `mergeHookFails`：裝一個 pre-merge-commit hook 一律退 1——演「merge 失敗但不是文字衝突」。
 * `markGates`：三關指令改成「在發起樹寫一個記號檔 gate-ran 再退 0」——考題用它斷言三關到底跑了沒。
 * 隱藏 lock：fixture 一律替 `installed` 寫一份 `node_modules/.package-lock.json`（來源與指紋預設跟 lock 同一套
 * 假值：resolved＝`fixture://<name>/<version>`、integrity＝`sha512-<name>@<version>`）；`hiddenOverride` 可改某一筆
 * （演「同名同版換了內容」）；`noHiddenLock` 不寫。
 * `staleOriginMain`：在 fixture 裡建一個停在 base 的 `refs/remotes/origin/main`（演「本機 origin/main 過時」）。
 * 身分：fixture 用 `git config` 在 repo 內設 user.name／user.email——閘在臨時 worktree 裡 `git merge` 要建
 * merge commit，乾淨的 Linux runner 沒有全域身分（#566 r1 CI 紅的原因），repo 內設的 worktree 共用。
 * @param {{ nodeModules?: 'none'|'dir'|'file', scripts?: Record<string,string>, conflictPair?: boolean,
 *   lock?: Record<string, {version: string, optional?: boolean}> | null,
 *   installed?: Record<string, string>,
 *   otherLock?: Record<string, {version: string, optional?: boolean}>,
 *   selfLock?: Record<string, {version: string, optional?: boolean}>,
 *   mainLock?: Record<string, {version: string, optional?: boolean}>,
 *   mergeHookFails?: boolean, noIdentity?: boolean,
 *   hiddenOverride?: Record<string, {resolved?: string, integrity?: string}>, noHiddenLock?: boolean,
 *   staleOriginMain?: boolean, selfStale?: boolean,
 *   markGates?: boolean }} [opts]
 * @returns {{ dir: string, sha: string, shaB?: string, mainSha: string }}
 */
function makeInitiatorRepo(opts = {}) {
  const { nodeModules = 'none', conflictPair = false, lock = {}, installed = {}, otherLock, selfLock, mainLock, mergeHookFails = false, noIdentity = false, hiddenOverride = {}, noHiddenLock = false, staleOriginMain = false, selfStale = false, markGates = false } = opts;
  let { scripts } = opts;
  const dir = mkdtempSync(join(tmpdir(), 'cross-pr-initiator-'));
  const g = (/** @type {string[]} */ args) => {
    const r = spawnSync('git', args, { encoding: 'utf8', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 0, `fixture git ${args.join(' ')} 失敗：${r.stderr}`);
    return String(r.stdout ?? '').trim();
  };
  g(['init', '-q', '-b', 'main', dir]);
  if (!noIdentity) {
    g(['config', 'user.name', 'fixture']);
    g(['config', 'user.email', 'f@example.com']);
    g(['config', 'commit.gpgsign', 'false']);
  }
  if (mergeHookFails) {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\necho "hook 拒絕 merge" >&2\nexit 1\n');
    chmodSync(join(dir, '.git', 'hooks', 'pre-merge-commit'), 0o755);
  }
  if (markGates) {
    const mark = `node -e "require('fs').writeFileSync('${join(dir, 'gate-ran')}', '')"`;
    scripts = { typecheck: mark, lint: mark, test: mark };
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'cross-pr-fixture', version: '0.0.0',
    scripts: scripts ?? { typecheck: 'cross-pr-fixture-no-such-cmd', lint: 'cross-pr-fixture-no-such-cmd', test: 'cross-pr-fixture-no-such-cmd' },
  }));
  const prov = (/** @type {string} */ name, /** @type {string} */ version) =>
    ({ resolved: `fixture://${name}/${version}`, integrity: `sha512-${name}@${version}` });
  const lockJson = (/** @type {Record<string, {version: string, optional?: boolean}>} */ pk) => JSON.stringify({
    name: 'cross-pr-fixture', version: '0.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'cross-pr-fixture', version: '0.0.0' },
      ...Object.fromEntries(Object.entries(pk).map(([k, v]) => [`node_modules/${k}`, { ...prov(k, v.version), ...v }])) },
  });
  if (lock !== null) writeFileSync(join(dir, 'package-lock.json'), lockJson(lock));
  g(['add', '.']);
  g(['-c', 'user.email=f@example.com', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  if (nodeModules === 'dir') mkdirSync(join(dir, 'node_modules'));
  for (const [name, version] of Object.entries(installed)) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  if (nodeModules === 'dir' && !noHiddenLock) {
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({
      name: 'cross-pr-fixture', version: '0.0.0', lockfileVersion: 3, requires: true,
      packages: Object.fromEntries(Object.entries(installed).map(([name, version]) =>
        [`node_modules/${name}`, { version, ...prov(name, version), ...(hiddenOverride[name] ?? {}) }])),
    }));
  }
  if (staleOriginMain) g(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const commit = (/** @type {string} */ msg) =>
    g(['-c', 'user.email=f@example.com', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', msg]);
  const commitLock = (/** @type {Record<string, {version: string, optional?: boolean}>} */ pk, /** @type {string} */ msg) => {
    writeFileSync(join(dir, 'package-lock.json'), lockJson(pk));
    g(['add', 'package-lock.json']);
    commit(msg);
    return g(['rev-parse', 'HEAD']);
  };
  const addFileOnBranch = (/** @type {string} */ branch, /** @type {string} */ file) => {
    g(['checkout', '-q', '-b', branch]);
    writeFileSync(join(dir, file), `${file}\n`);
    g(['add', file]);
    commit(`${branch} adds ${file}`);
    const sha = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    return sha;
  };
  let shaB;
  if (otherLock) {
    g(['checkout', '-q', '-b', 'lock-b']);
    shaB = commitLock(otherLock, 'other touches lock');
    g(['checkout', '-q', 'main']);
  } else if (selfLock || mainLock) {
    shaB = addFileOnBranch('other-stale', 'other.txt');
  }
  if (selfLock) {
    g(['checkout', '-q', '-b', 'self-lock']);
    const sha = commitLock(selfLock, 'self touches lock');
    g(['checkout', '-q', 'main']);
    return { dir, sha, shaB, mainSha: g(['rev-parse', 'HEAD']) };
  }
  if (mainLock) {
    // selfStale：本支也從舊 base 分岔（兩支都落後 main）；否則從新 main 分岔
    const sha = selfStale ? addFileOnBranch('self-stale', 'self.txt') : '';
    const mainSha = commitLock(mainLock, 'main touches lock');
    return { dir, sha: sha || addFileOnBranch('self-fresh', 'self.txt'), shaB, mainSha };
  }
  if (shaB) return { dir, sha: g(['rev-parse', 'HEAD']), shaB, mainSha: g(['rev-parse', 'HEAD']) };
  if (nodeModules === 'file') writeFileSync(join(dir, 'node_modules'), '這不是目錄\n');
  if (conflictPair) {
    const commit = (/** @type {string} */ msg) =>
      g(['-c', 'user.email=f@example.com', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', msg]);
    g(['checkout', '-q', '-b', 'pair-a']);
    writeFileSync(join(dir, 'clash.txt'), 'A 版本\n');
    g(['add', 'clash.txt']);
    commit('A');
    const sha = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    g(['checkout', '-q', '-b', 'pair-b']);
    writeFileSync(join(dir, 'clash.txt'), 'B 版本\n');
    g(['add', 'clash.txt']);
    commit('B');
    const shaB = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    return { dir, sha, shaB, mainSha: g(['rev-parse', 'HEAD']) };
  }
  const sha = g(['rev-parse', 'HEAD']);
  return { dir, sha, mainSha: sha };
}

test('⭐ CLI｜發起樹沒有 node_modules ＋ 有其他 open PR → exit 2，訊息點名環境（#441 的誤報不可再犯）', () => {
  // ⚠️ 突變的真相（#446 r2 Codex 糾正過我的誇大）：只拔先驗＝第二層「執行不起來」
  //    仍以 2 接住（本題照樣綠、「普通檔案」題靠訊息斷言轉紅）；**兩層都拔**才會
  //    回到 #441 的退出碼 1——那個劇本由本題的 status 斷言接住（r3 實測）。
  const { dir, sha } = makeInitiatorRepo();
  try {
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),
      JSON.stringify([
        { number: 441, headRefOid: sha, headRefName: 'b441', baseRefName: 'main' },
        { number: 442, headRefOid: sha, headRefName: 'b442', baseRefName: 'main' },
      ]),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 2,
      `預期 2（查不清楚），實得 ${r.status}\n${r.stdout}${r.stderr}\n`
      + '——1＝把環境問題報成「兩支合起來會壞」，正是 2026-08-11 #441 的誤報原樣。');
    assert.match(r.stderr, /node_modules/, '訊息沒點名 node_modules，看的人不知道要修的是環境');
    assert.match(r.stderr, /主目錄|symlink/, '訊息沒指路（從主目錄跑／把 symlink 掛進發起樹）');
    assert.doesNotMatch(r.stderr, /合起來會壞|紅了/,
      '環境問題被包裝成相容性結論——「1」要盡可能只代表真的相斥：'
      + '執行不起來的環境問題一律走 2（r1 版這句曾寫成「1 永遠代表真的相斥」，那是撐不住的保證）');
    assert.doesNotMatch(r.stderr, /建不出臨時工作區/,
      '先驗沒接住、倒在下游的泛用訊息——歸因要在源頭，看的人才知道下一步是修環境');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI｜發起樹沒有 node_modules 但零其他 open PR → 0（結論不需要三關；#438 的正常代合併不可被誤傷）', () => {
  const { dir, sha } = makeInitiatorRepo();
  try {
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),
      JSON.stringify([{ number: 441, headRefOid: sha, headRefName: 'b441', baseRefName: 'main' }]),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 0,
      `預期 0，實得 ${r.status}\n${r.stdout}${r.stderr}\n`
      + '——「沒有其他 open PR」不需要 node_modules 就答得出來；把它也擋下來＝誤傷 #438 那種本來就正確的用法');
    assert.match(r.stdout, /沒有其他 open PR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #446 r1 的三條發現（High＋兩個 Medium），r2 補的行為題 ──────────

test('⭐ CLI｜node_modules 是普通檔案（existsSync 會說 true）→ 先驗照樣要擋，exit 2（#446 r1 High 之一）', () => {
  // 這一題守的是**歸因精準**：先驗在動手前就說出「不是目錄」這個確切病因。
  // 單拔先驗不會回到退出碼 1——第二層「執行不起來」會以 2 接住（fail-closed 不破），
  // 但訊息會退化成泛用的「無法判定」；本題下面的訊息斷言就是為此轉紅（#446 r2 實測）。
  const { dir, sha } = makeInitiatorRepo({ nodeModules: 'file' });
  try {
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),
      JSON.stringify([
        { number: 441, headRefOid: sha, headRefName: 'b441', baseRefName: 'main' },
        { number: 442, headRefOid: sha, headRefName: 'b442', baseRefName: 'main' },
      ]),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 2,
      `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}\n`
      + '——「存在」不等於「可用」：普通檔案會讓臨時工作區的 symlink 指到檔案，三關照樣 127。');
    assert.match(r.stderr, /不是目錄|可用的 node_modules/, '訊息沒說出「存在但不是目錄」這種壞法');
    assert.doesNotMatch(r.stderr, /合起來會壞/, '環境問題又冒充相容性結論了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜node_modules 目錄在、但三關「執行不起來」（127）→ exit 2，不是 1（#446 r1 High 之二：先驗管不到的殘缺）', () => {
  // 空目錄過得了先驗（它驗不了「內容齊不齊」，誠實劃界寫在腳本檔頭）——
  // 所以 127 這族要在三關的 catch 裡分類成「執行不起來＝無法判定」，整輪轉 2
  // （不宣稱一定是環境：#446 r2 Codex 造出過兩支各自全綠、合併後 127 的反例）。
  const { dir, sha } = makeInitiatorRepo({ nodeModules: 'dir' });
  try {
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),
      JSON.stringify([
        { number: 441, headRefOid: sha, headRefName: 'b441', baseRefName: 'main' },
        { number: 442, headRefOid: sha, headRefName: 'b442', baseRefName: 'main' },
      ]),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 2,
      `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}\n`
      + '——127 拿不到可直接判讀的正常結果（成因不只一種，#446 r3 連「測試自己退 127」都造出來過），'
      + '不可以報成「合起來會壞」。');
    assert.match(r.stderr, /執行不起來/, '訊息沒把「執行不起來」跟「跑完是紅的」分開講');
    assert.match(r.stderr, /127/, '環境訊號（退出碼 127）沒有印出來，看的人少一條線索');
    assert.doesNotMatch(r.stderr, /合起來會壞/, '環境問題又冒充相容性結論了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜三關跑得起來、真的紅（退出碼 1）→ exit 1，死因帶兩路輸出（redDetail 的正式接線；#446 r1 Medium）', () => {
  // 這一題同時鎖兩件事：①「跑得起來的紅」仍然走 1（環境分類沒有殺過頭）；
  // ②tryMerge → redDetail 的接線真的把 stdout／stderr 都帶進死因——
  //   r1 版把這條呼叫突變成固定字串時 18/18 照樣全綠（Codex 的突變實測），本題就是補這個洞。
  const RED_GATE = 'node -e "console.log(\'GATE-STDOUT-MARK\');console.error(\'GATE-STDERR-MARK\');process.exit(1)"';
  const { dir, sha } = makeInitiatorRepo({
    nodeModules: 'dir',
    scripts: { typecheck: RED_GATE, lint: RED_GATE, test: RED_GATE },
  });
  try {
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),
      JSON.stringify([
        { number: 441, headRefOid: sha, headRefName: 'b441', baseRefName: 'main' },
        { number: 442, headRefOid: sha, headRefName: 'b442', baseRefName: 'main' },
      ]),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 1,
      `預期 1，實得 ${r.status}\n${r.stdout}${r.stderr}\n`
      + '——跑得起來的紅是這道閘存在的全部理由，環境分類不可以把它也吃掉。');
    assert.match(r.stderr, /合起來會壞/);
    assert.match(r.stderr, /「校對」紅了/);
    assert.match(r.stderr, /GATE-STDERR-MARK/,
      '死因裡沒有 stderr 的內容——redDetail 的接線斷了（或被換成固定字串），#441 那種環境線索會再度被吞');
    assert.match(r.stderr, /GATE-STDOUT-MARK/, '死因裡沒有 stdout 的內容——倒在哪一關的哪個指令看不到了');
    // footer 的分類也要從正式接線驗（#446 r6：只在純函式層餵正確 kind＝沒驗到
    // tryMerge 真的有標）：真測試紅 ⇒ 測試紅的說明要在、衝突的說明不可以在。
    assert.match(r.stderr, /合起來測試紅/, 'red kind 沒從 tryMerge 流到 verdict 的 footer——正式接線斷了');
    assert.doesNotMatch(r.stderr, /GitHub 自己就看得到/, '真測試紅長出了「文字衝突」的說明——分類接線錯');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜兩支真的文字衝突 → exit 1，衝突的說明照 kind 長出來（tryMerge→verdict 正式接線；#446 r6）', () => {
  const { dir, sha, shaB } = makeInitiatorRepo({ nodeModules: 'dir', conflictPair: true });
  try {
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),
      JSON.stringify([
        { number: 441, headRefOid: sha, headRefName: 'b441', baseRefName: 'main' },
        { number: 442, headRefOid: shaB, headRefName: 'b442', baseRefName: 'main' },
      ]),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 1, `預期 1（文字衝突＝已確定的阻擋），實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /文字衝突，git merge 就過不去/);
    assert.match(r.stderr, /GitHub 自己就看得到/, 'conflict kind 沒從 tryMerge 流到 verdict 的 footer——正式接線斷了');
    assert.doesNotMatch(r.stderr, /合起來測試紅/, '衝突長出了「測試紅」的說明——分類接線錯');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 合併後 lock 核對（2026-09-02 #548 在途 PR 加 devDependency 讓整條佇列假紅；2026-09-05 William 裁示入冊） ──

const OK_GATE = 'node -e "process.exit(0)"';
/** 受審支的 gh pr view 回應：baseRefOid＝main 目前的 head（閘用它量「哪一側動了 lock」）。 */
const SELF_VIEW = (/** @type {string} */ sha, /** @type {string} */ mainSha) =>
  JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main', baseRefOid: mainSha });
const LOCK_OTHERS = (/** @type {string} */ sha, /** @type {string} */ shaB) => JSON.stringify([
  { number: 441, headRefOid: sha, headRefName: 'b441', baseRefName: 'main' },
  { number: 442, headRefOid: shaB, headRefName: 'b442', baseRefName: 'main' },
]);

test('lockMismatches｜全部對得上 → 空；沒有 packages 表 → 一筆「無法核對」（fail-closed，lockfileVersion 1 也走這裡）', () => {
  const lock = { packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/a/node_modules/b': { version: '2.1.0' } } };
  const have = /** @type {Record<string,{name:string,version:string}>} */ ({
    'node_modules/a': { name: 'a', version: '1.0.0' }, 'node_modules/a/node_modules/b': { name: 'b', version: '2.1.0' } });
  assert.deepEqual(lockMismatches(lock, (k) => have[k] ?? null, null), []);
  for (const bad of [null, undefined, 'x', {}, { packages: null }, { lockfileVersion: 1, dependencies: {} },
    { packages: [] }, { packages: {} }, { packages: { 'node_modules/a': { version: '1.0.0' } } }, [{ packages: { '': {} } }],
    // 根項目在、但不是物件（#566 r2 反例：null／陣列／數字／字串）
    { packages: { '': null } }, { packages: { '': [] } }, { packages: { '': 7 } }, { packages: { '': 'x' } }]) {
    const m = lockMismatches(bad, () => ({ name: 'a', version: '1.0.0' }), null);
    assert.equal(m.length, 1, `${JSON.stringify(bad)} 應該回一筆「無法核對」，實得 ${m.length}：${m.join(' / ')}`);
    assert.match(m[0], /無法核對/);
  }
  // 項目不是物件（null／陣列）＝那一筆無法核對，不可以靜靜跳過（#566 r1 反例）
  const broken = { packages: { '': {}, 'node_modules/ok': { version: '1.0.0' }, 'node_modules/nul': null, 'node_modules/arr': ['1.0.0'] } };
  const m = lockMismatches(broken, (k) => (k === 'node_modules/ok' ? { name: 'ok', version: '1.0.0' } : null), null);
  assert.equal(m.length, 2, `null 與陣列項目各要一筆，實得：${m.join(' / ')}`);
  assert.ok(m.every((x) => /無法核對/.test(x)));
});

test('⭐ lockMismatches｜lock 要的沒裝 → 對不上並點名套件；他平台的 optional 沒裝 → 不算（平台專屬二進位本來就只裝自己那一個）', () => {
  const lock = { packages: { '': {}, 'node_modules/req': { version: '1.0.0' }, 'node_modules/opt': { version: '3.0.0', optional: true, os: ['not-this-os'] } } };
  const m = lockMismatches(lock, () => null, null);
  assert.equal(m.length, 1, `只該有 req 一筆對不上，實得：${m.join(' / ')}`);
  assert.match(m[0], /node_modules\/req/);
  assert.match(m[0], /1\.0\.0/);
  assert.match(m[0], /沒有裝/);
  assert.doesNotMatch(m.join(' '), /node_modules\/opt/, '他平台的 optional 沒裝也被算成對不上——平台專屬二進位本來就只裝自己那一個，這樣每次都紅');
});

test('⭐ lockMismatches｜版本不同 → 對不上、兩個版本都要印；optional 但裝了且版本不同 → 照樣對不上', () => {
  const lock = { packages: { '': {},
    'node_modules/dep': { version: '6.2.108' },
    'node_modules/opt': { version: '3.0.0', optional: true } } };
  const have = /** @type {Record<string,{name:string,version:string}>} */ ({
    'node_modules/dep': { name: 'dep', version: '6.1.200' }, 'node_modules/opt': { name: 'opt', version: '2.9.0' } });
  const m = lockMismatches(lock, (k) => have[k] ?? null, null);
  assert.equal(m.length, 2, `應有 dep 與 opt 兩筆，實得：${m.join(' / ')}`);
  const dep = m.find((x) => x.includes('node_modules/dep'));
  assert.ok(dep && dep.includes('6.2.108') && dep.includes('6.1.200'), `dep 那筆要同時印 lock 版與已裝版：${dep}`);
  assert.ok(m.some((x) => x.includes('node_modules/opt')), 'optional 裝了但版本不對，不可以因為 optional 就放過');
});

test('⭐ lockMismatches｜同版號不同套件（alias）→ 對不上；workspace 連結（link）→ 視為對不上；scoped 與巢狀的名字照路徑尾段比、不誤紅（#566 r1 High）', () => {
  // alias：lock 的 name 欄是 new-tool、路徑是 node_modules/tool；裝的是 old-tool@1.0.0——版本相同、套件不同
  const lock = { packages: { '': {},
    'node_modules/tool': { name: 'new-tool', version: '1.0.0' },
    'node_modules/ws': { version: '2.0.0', link: true, resolved: 'packages/ws' },
    'node_modules/@scope/pkg': { version: '1.2.3' },
    'node_modules/a/node_modules/b': { version: '4.5.6' } } };
  const have = /** @type {Record<string,{name:string,version:string}>} */ ({
    'node_modules/tool': { name: 'old-tool', version: '1.0.0' },
    'node_modules/ws': { name: 'ws', version: '1.0.0' },
    'node_modules/@scope/pkg': { name: '@scope/pkg', version: '1.2.3' },
    'node_modules/a/node_modules/b': { name: 'b', version: '4.5.6' } });
  const m = lockMismatches(lock, (k) => have[k] ?? null, null);
  assert.ok(m.some((x) => x.includes('node_modules/tool') && x.includes('new-tool') && x.includes('old-tool')),
    `alias 同版號不同套件沒被抓到：${m.join(' / ')}`);
  assert.ok(m.some((x) => x.includes('node_modules/ws') && /link/.test(x)), `link 項目沒被當成對不上：${m.join(' / ')}`);
  assert.equal(m.length, 2, `scoped 或巢狀的名字被誤紅：${m.join(' / ')}`);
  // name 是空字串＝有寫但壞掉，不可以退回路徑名而放行（#566 r9 的封頂族觀察，順手修：一行）
  const empty = lockMismatches({ packages: { '': {}, 'node_modules/x': { name: '', version: '1.0.0' } } }, () => ({ name: 'x', version: '1.0.0' }), null);
  assert.equal(empty.length, 1, `name:'' 應對不上：${empty.join(' / ')}`);
});

test('⭐ lockMismatches｜同名同版但內容指紋（integrity）或來源（resolved）在根 lock 與隱藏 lock 的中繼紀錄不同 → 對不上；隱藏 lock 讀不到／沒那一筆 → 核對不了也算對不上；lock 沒寫來源的項目不比（#566 r2 High）', () => {
  const lock = { packages: { '': {},
    'node_modules/a': { version: '1.0.0', resolved: 'https://cdn.example/a-1.0.0.tgz', integrity: 'sha512-AAA' },
    'node_modules/b': { version: '2.0.0', resolved: 'https://registry/b-2.0.0.tgz', integrity: 'sha512-BBB' },
    'node_modules/c': { version: '3.0.0' } } };
  const installed = (/** @type {string} */ k) => ({ name: k.slice('node_modules/'.length), version: { 'node_modules/a': '1.0.0', 'node_modules/b': '2.0.0', 'node_modules/c': '3.0.0' }[k] ?? '' });
  const good = { 'node_modules/a': { version: '1.0.0', resolved: 'https://cdn.example/a-1.0.0.tgz', integrity: 'sha512-AAA' },
    'node_modules/b': { version: '2.0.0', resolved: 'https://registry/b-2.0.0.tgz', integrity: 'sha512-BBB' } };
  assert.deepEqual(lockMismatches(lock, installed, good), [], '全部一致卻對不上');
  const swapped = { ...good, 'node_modules/a': { ...good['node_modules/a'], integrity: 'sha512-ZZZ' } };
  let m = lockMismatches(lock, installed, swapped);
  assert.equal(m.length, 1, `integrity 不同要剛好一筆：${m.join(' / ')}`);
  assert.match(m[0], /node_modules\/a.*integrity/);
  const moved = { ...good, 'node_modules/b': { ...good['node_modules/b'], resolved: 'https://mirror/b-2.0.0.tgz' } };
  m = lockMismatches(lock, installed, moved);
  assert.equal(m.length, 1, `resolved 不同要剛好一筆：${m.join(' / ')}`);
  assert.match(m[0], /node_modules\/b.*resolved/);
  m = lockMismatches(lock, installed, null);
  assert.equal(m.length, 1, `隱藏 lock 讀不到要合成一筆、不可以每個套件各一筆也不可以零筆：${m.join(' / ')}`);
  assert.match(m[0], /\.package-lock\.json/);
  m = lockMismatches(lock, installed, { 'node_modules/a': good['node_modules/a'] });
  assert.equal(m.length, 1, `隱藏 lock 沒有 b 那一筆要對不上：${m.join(' / ')}`);
  assert.match(m[0], /node_modules\/b.*沒有這一筆/);
});

test('⭐ lockMismatches｜套件路徑（key）不合法一律「無法核對」：含 ..、絕對路徑、不是 node_modules/ 開頭、反斜線、空字元（#566 r8：.. 會逃出臨時樹借外部 package.json 假綠）', () => {
  const installed = () => ({ name: 'x', version: '1.0.0' });
  for (const key of ['../../outside', 'node_modules/../../outside', '/abs/node_modules/x', 'lib/x', 'node_modules/a\\..\\b', 'node_modules/a\0b', 'node_modules//a', 'node_modules/./a']) {
    const m = lockMismatches({ packages: { '': {}, [key]: { version: '1.0.0', name: 'x' } } }, installed, null);
    assert.equal(m.length, 1, `${JSON.stringify(key)} 應該一筆「無法核對」，實得：${m.join(' / ')}`);
    assert.match(m[0], /路徑不合法/);
  }
  assert.deepEqual(lockMismatches({ packages: { '': {}, 'node_modules/@s/p': { version: '1.0.0', name: '@s/p' }, 'node_modules/a/node_modules/b': { version: '1.0.0', name: 'b' } } },
    (k) => ({ name: k.slice(k.lastIndexOf('node_modules/') + 13), version: '1.0.0' }), null), [], 'scoped 與巢狀的正常 key 被誤紅');
});

test('⭐ CLI｜lock 的套件路徑用 .. 指到臨時樹外的 package.json → exit 2、三關沒跑（#566 r8：正式接線也要擋，不只純函式）', () => {
  // 樹外放一個 package.json（name/version 跟 lock 寫的一樣），lock 的 key 用 ../ 指過去——舊版會讀到它、回「對得上」、進三關
  const outside = mkdtempSync(join(tmpdir(), 'cross-pr-outside-'));
  writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'escaped', version: '9.9.9' }));
  const { dir, sha, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } }, installed: { 'fx-dep': '1.0.0' },
  });
  try {
    // 另一支＝從 main 開分支、把 lock 換成帶逃逸 key 的版本
    const lockPath = join(dir, 'package-lock.json');
    const g = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...SANDBOX_ENV } });
    g(['checkout', '-q', '-b', 'lock-escape']);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const depth = dir.split('/').filter(Boolean).length + 3;   // 臨時樹在 tmpdir 底下，多爬幾層到根再走絕對路徑
    lock.packages[`node_modules/${'../'.repeat(depth)}${outside.replace(/^\//, '')}`] = { version: '9.9.9', name: 'escaped' };
    writeFileSync(lockPath, JSON.stringify(lock));
    g(['add', 'package-lock.json']);
    g(['-c', 'user.email=f@example.com', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'escape']);
    const shaEsc = String(g(['rev-parse', 'HEAD']).stdout).trim();
    g(['checkout', '-q', 'main']);
    const r = withFakeGh(SELF_VIEW(sha, mainSha), LOCK_OTHERS(sha, shaEsc), { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}\n——0＝lock 的 .. 逃出臨時樹、借樹外的 package.json 通過核對`);
    assert.match(r.stderr, /路徑不合法/);
    assert.equal(existsSync(join(dir, 'gate-ran')), false, '對不上還是進了三關');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('⭐ 裁決｜任一筆 lock 對不上（kind: lock）→ 整輪 2；訊息要講「不適用重跑」、不可以說「合起來會壞」', () => {
  const v = verdict([
    { number: 384, ok: true, why: '' },
    { number: 385, ok: false, kind: 'lock', why: '合併後的 package-lock.json 跟已裝的套件對不上（1 處；#385 相對本支動了 package-lock.json：是）：node_modules/x：lock 要 2.0.0，裝的是 1.0.0' },
  ]);
  assert.equal(v.code, 2, '拿舊套件跑出來的三關結果不可信，只值得「查不清楚」；1 會被當成真的相斥去修相容性');
  assert.doesNotMatch(v.message, /合起來會壞/);
  assert.match(v.message, /對不上/);
  assert.match(v.message, /不適用「紅了重跑一次」/, '沒講清楚這種結果重跑無效——「紅了重跑一次」的裁示會被拿來對付它');
  assert.match(v.message, /npm ci/, '沒給處置（誰、在哪棵樹裝套件）');
  assert.match(v.message, /不要在掛著 symlink 的 worktree 裡動 node_modules/, '少了 CLAUDE.md 那條禁區的提醒——最省事的錯誤處置正是在 worktree 裡重裝');
  assert.match(v.message, /沒掛 symlink 的全新臨時樹/, '「臨時樹 npm ci」沒說哪種樹形才安全——跟禁區那句放在一起就自相矛盾（預審抓的）');
});

test('裁決｜lock 對不上混著真紅／衝突 → 整輪 2，但已確定的阻擋要被點名保留（跟 cantRun 混輪同一套規矩）', () => {
  const v = verdict([
    { number: 384, ok: false, kind: 'red', why: '合起來之後「考試」紅了：斷言炸了' },
    { number: 385, ok: false, kind: 'lock', why: '合併後的 package-lock.json 跟已裝的套件對不上（…）' },
    { number: 386, ok: false, kind: 'conflict', why: '文字衝突，git merge 就過不去' },
  ]);
  assert.equal(v.code, 2);
  assert.match(v.message, /本輪已確定的阻擋/);
  assert.match(v.message, /文字衝突/);
  assert.match(v.message, /跑得起來的測試紅/);
  assert.match(v.message, /#384/); assert.match(v.message, /#385/); assert.match(v.message, /#386/);
});

test('裁決｜退出碼 1 的「合起來測試紅」footer 要指路「重跑一次」的規則與限制（只限本閘、只限一次）', () => {
  const v = verdict([{ number: 385, ok: false, kind: 'red', why: '合起來之後「考試」紅了：斷言炸了' }]);
  assert.equal(v.code, 1);
  assert.match(v.message, /重跑\*\*一次\*\*/, '真紅的訊息沒提「可以重跑一次」——看的人只能憑記憶找 William 09-03 的裁示');
  assert.ok(v.message.includes(RERUN_LIMITS), '重跑的限制沒逐字帶——沒有限制的重跑＝fail-closed 閘的逃生口');
  assert.match(v.message, /紅的考題/, '沒叫人先看是哪一題紅，「重跑一次」會被用在確定性的紅上');
  assert.match(v.message, /REVIEW-AND-MERGE\.md/, '沒指回規則正本');
});

test('⭐ CLI｜另一支動了 package-lock.json、要求的版本沒裝 → exit 2 並點名套件與「動了 lock：是」；三關不可以跑（拿舊套件跑出來的紅綠都不算數）', () => {
  // 2026-09-02 #548 的原形：在途 PR 加 devDependency，整條佇列假紅。舊版閘會靜靜用發起樹的
  // 舊套件跑三關；本題的 scripts 三關都是「退 0」——若閘沒核對 lock 就會以 0 收場＝假綠（比假紅更危險）。
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir',
    markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } },
    installed: { 'fx-dep': '1.0.0' },
    otherLock: { 'fx-dep': { version: '1.0.0' }, 'marked': { version: '17.0.1' } },
  });
  try {
    const r = withFakeGh(
      SELF_VIEW(sha, mainSha),
      LOCK_OTHERS(sha, /** @type {string} */ (shaB)),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 2,
      `預期 2（查不清楚），實得 ${r.status}\n${r.stdout}${r.stderr}\n`
      + '——0＝閘沒核對 lock、拿舊套件跑三關回報綠（假綠）；1＝把套件對不上報成「兩支相斥」。');
    assert.match(r.stderr, /對不上/);
    assert.match(r.stderr, /node_modules\/marked/, '沒點名是哪個套件對不上——看的人不知道要裝什麼');
    assert.match(r.stderr, /17\.0\.1/, '沒印 lock 要求的版本');
    assert.match(r.stderr, /本支那側動了 package-lock\.json：否，#442 那側動了：是/, '沒講是哪一側動了 lock（這裡是另一支、本支沒動）');
    assert.equal(existsSync(join(dir, 'gate-ran')), false, '三關留了記號檔＝對不上還是進了三關（拿舊套件跑出來的紅綠都不算數，而且 #548 那種假紅會原樣重演）');
    assert.match(r.stderr, /不適用「紅了重跑一次」/);
    assert.doesNotMatch(r.stderr, /合起來會壞|執行不起來/, '套件對不上被冒充成相容性或環境結論');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜發起樹的套件本來就沒跟上本支的 lock（主目錄還沒重裝）、另一支沒動 lock → exit 2，「動了 lock：否」', () => {
  // 主目錄真的發生過的形狀（#563 合併後 lock 升版、node_modules 沒重裝）——差異不是任何一支
  // 造成的，兩側都要印「否」，看的人才知道要修的是發起樹。
  const { dir, sha, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir',
    markGates: true,
    lock: { 'pdfjs-dist': { version: '6.2.108' } },
    installed: { 'pdfjs-dist': '6.1.200' },
  });
  try {
    const r = withFakeGh(
      SELF_VIEW(sha, mainSha),
      LOCK_OTHERS(sha, sha),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /pdfjs-dist：lock 要 6\.2\.108，裝的是 6\.1\.200/);
    assert.match(r.stderr, /本支那側動了 package-lock\.json：否，#442 那側動了：否/, '兩側都沒動＝發起樹自己沒跟上，訊息要讓人看得出來');
    assert.match(r.stderr, /主目錄本身.*npm install/, '兩側都「否」的處置沒指到「在主目錄本身 npm install」——主目錄真的發生過這個狀態');
    assert.equal(existsSync(join(dir, 'gate-ran')), false, '對不上還是進了三關');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜本支那側動了 lock、另一支停在舊 base 沒動（#561 的形狀）→ 「本支那側：是，#442 那側：否」（兩顆 head 直接比會冤枉另一支）', () => {
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } },
    installed: { 'fx-dep': '1.0.0' },
    selfLock: { 'fx-dep': { version: '2.0.0' } },
  });
  try {
    const r = withFakeGh(
      SELF_VIEW(sha, mainSha),
      LOCK_OTHERS(sha, /** @type {string} */ (shaB)),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /本支那側動了 package-lock\.json：是，#442 那側動了：否/,
      '另一支根本沒動 lock 卻被印成「是」——處置會叫人先去合併它，白繞一輪（預審在真 repo 上對 #561 實跑到的）');
    assert.match(r.stderr, /沒掛 symlink 的全新臨時樹/, '本支自己動了 lock 的處置沒指到「全新臨時樹 npm ci」');
    assert.match(r.stderr, /從那棵樹重跑本閘、拿到退出碼 0/, '手動路徑沒有能進下一步的狀態——REVIEW 只認本閘的退出碼 0，手動跑三關產不出它（#566 r5）');
    assert.equal(existsSync(join(dir, 'gate-ran')), false, '對不上還是進了三關');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜main 在兩支分岔之間動了 lock、兩支自己都沒動 → 兩側都「否」（#566 r1 Codex 點名：從共同祖先量會把 main 的改動算到本支頭上）', () => {
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } },
    installed: { 'fx-dep': '1.0.0' },
    mainLock: { 'fx-dep': { version: '2.0.0' } },
  });
  try {
    const r = withFakeGh(
      SELF_VIEW(sha, mainSha),
      LOCK_OTHERS(sha, /** @type {string} */ (shaB)),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /本支那側動了 package-lock\.json：否，#442 那側動了：否/,
      'main 自己的 lock 變動被算到本支或另一支頭上——處置會叫人走手動路徑或先合併別支，其實只要主目錄重裝');
    assert.match(r.stderr, /主目錄本身.*npm install/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜git merge 失敗但不是文字衝突（hook 拒絕）→ exit 2「執行不起來」，不可以報成可重跑的「文字衝突」（#566 r1 High：乾淨 runner 沒有 committer 身分就是這型）', () => {
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true, mergeHookFails: true,
    lock: { 'fx-dep': { version: '1.0.0' } }, installed: { 'fx-dep': '1.0.0' },
    // 只為了讓兩支分岔（真的要建 merge commit）：main 多一個沒裝的 optional 套件，lock 仍對得上
    mainLock: { 'fx-dep': { version: '1.0.0' }, 'only-on-linux': { version: '9.9.9', optional: true, os: ['linux'] } },
  });
  try {
    const r = withFakeGh(SELF_VIEW(sha, mainSha), LOCK_OTHERS(sha, /** @type {string} */ (shaB)), { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}\n——1＝把 merge 的執行錯誤冒充成文字衝突，而衝突那種紅是准許重跑一次的`);
    assert.match(r.stderr, /試合併」執行不起來/);
    assert.match(r.stderr, /hook 拒絕 merge/, 'merge 的 stderr 沒進死因，看的人不知道是身分、hook 還是別的');
    assert.doesNotMatch(r.stderr, /文字衝突，git merge 就過不去/);
    assert.equal(existsSync(join(dir, 'gate-ran')), false, 'merge 都失敗了三關還跑');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI｜對照組：兩支真的分岔、merge 要建 commit、fixture 沒有全域身分也能成功（repo 內身分——CI 乾淨 runner 的形狀）', () => {
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } }, installed: { 'fx-dep': '1.0.0' },
    mainLock: { 'fx-dep': { version: '1.0.0' }, 'only-on-linux': { version: '9.9.9', optional: true, os: ['linux'] } },
  });
  const emptyHome = mkdtempSync(join(tmpdir(), 'cross-pr-home-'));
  try {
    const r = withFakeGh(SELF_VIEW(sha, mainSha), LOCK_OTHERS(sha, /** @type {string} */ (shaB)),
      { pr: '441', cwd: dir, env: { PATH: SANDBOX_ENV.PATH, HOME: emptyHome } });
    assert.equal(r.status, 0, `預期 0，實得 ${r.status}\n${r.stdout}${r.stderr}\n——沒有全域 git 身分時 merge commit 建不出來＝#566 r1 CI 紅的原因；fixture 要在 repo 內設身分`);
    assert.equal(existsSync(join(dir, 'gate-ran')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('⭐ CLI｜另一支把同名同版的套件換成另一份內容（lock 的 integrity 變了、已裝的沒變）→ exit 2、三關不可以跑（#566 r2 High：只比名字版本會假綠）', () => {
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } },
    installed: { 'fx-dep': '1.0.0' },
    otherLock: { 'fx-dep': { version: '1.0.0', integrity: 'sha512-fx-dep@1.0.0-rebuilt' } },
  });
  try {
    const r = withFakeGh(SELF_VIEW(sha, mainSha), LOCK_OTHERS(sha, /** @type {string} */ (shaB)), { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}\n——0＝同名同版換內容被放行、拿舊內容跑三關`);
    assert.match(r.stderr, /fx-dep.*integrity/);
    assert.match(r.stderr, /#442 那側動了：是/);
    assert.equal(existsSync(join(dir, 'gate-ran')), false, '對不上還是進了三關');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI｜發起樹沒有隱藏 lock（node_modules/.package-lock.json）→ 核對不了來源與指紋，exit 2（fail-closed）', () => {
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true, noHiddenLock: true,
    lock: { 'fx-dep': { version: '1.0.0' } }, installed: { 'fx-dep': '1.0.0' },
    otherLock: { 'fx-dep': { version: '1.0.0' }, 'only-on-linux': { version: '9.9.9', optional: true, os: ['linux'] } },
  });
  try {
    const r = withFakeGh(SELF_VIEW(sha, mainSha), LOCK_OTHERS(sha, /** @type {string} */ (shaB)), { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /\.package-lock\.json/);
    assert.equal(existsSync(join(dir, 'gate-ran')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜gh 給的 baseRefOid 本機沒有那顆 commit、本機 origin/main 又過時 → 側別印「查不到」並指路 fetch，不可以拿過時的 origin/main 算出錯的側別（#566 r2 Medium）', () => {
  // 形狀：origin/main 停在 base；main 後來動了 lock；兩支都從新 main 分岔、都沒動 lock。
  // 真相是「兩側都否、發起樹重裝」；拿過時的 origin/main 算會把 main 的 lock 變動算到兩支頭上（兩側都是）。
  const { dir, sha, shaB } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true, staleOriginMain: true,
    lock: { 'fx-dep': { version: '1.0.0' } }, installed: { 'fx-dep': '1.0.0' },
    mainLock: { 'fx-dep': { version: '2.0.0' } },
  });
  try {
    const originMain = String(spawnSync('git', ['rev-parse', 'origin/main'], { cwd: dir, encoding: 'utf8', env: { ...SANDBOX_ENV } }).stdout).trim();
    for (const notFetched of [
      '0123456789abcdef0123456789abcdef01234567',   // gh 看得到、本機沒有的那顆
      // #566 r3 Codex 的形狀：origin/main 的完整 sha 後面多一個字元——前綴比對會當成同一顆。
      // 多的字元刻意用非 hex：多一個 hex 字元（41 碼）在 CI 的 git 版本上竟解析得到（本機的 git 解析不到），
      // 夾具會因版本不同而失真；非 hex 在任何版本都是「不是物件名」。
      `${originMain}z`,
    ]) {
      const probe = spawnSync('git', ['cat-file', '-e', `${notFetched}^{commit}`], { cwd: dir, encoding: 'utf8', env: { ...SANDBOX_ENV } });
      assert.notEqual(probe.status, 0, `夾具失真：${notFetched} 本機竟然有，這題就沒走到「本機沒有」那條路`);
      const r = withFakeGh(SELF_VIEW(sha, notFetched), LOCK_OTHERS(sha, /** @type {string} */ (shaB)), { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } });
      assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /本支那側動了 package-lock\.json：查不到，#442 那側動了：查不到/,
        `baseRefOid=${notFetched}：本機沒有 main 那顆 commit 卻還是答了是／否——多半是拿過時的 origin/main 算的，處置會指錯人`);
      assert.match(r.stderr, /git fetch origin main/, '「查不到」沒給處置');
      assert.doesNotMatch(r.stderr, /那側動了：是/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI｜對照組：gh 沒給 baseRefOid → 退回本機 origin/main 算側別（origin/main 是最新時答對：兩側都否）', () => {
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } }, installed: { 'fx-dep': '1.0.0' },
    mainLock: { 'fx-dep': { version: '2.0.0' } },
  });
  try {
    spawnSync('git', ['update-ref', 'refs/remotes/origin/main', mainSha], { cwd: dir, env: { ...SANDBOX_ENV } });
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),   // 沒有 baseRefOid
      LOCK_OTHERS(sha, /** @type {string} */ (shaB)), { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /本支那側動了 package-lock\.json：否，#442 那側動了：否/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜兩支都落後 main（合併後的 lock 是舊的、發起樹已是新的）→ 2，訊息要說「合併後的 lock 跟 main 的一樣：否」並指路 rebase，不是叫人重裝發起樹（Grok #566 掃 #3）', () => {
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true, selfStale: true,
    lock: { 'fx-dep': { version: '1.0.0' } },
    installed: { 'fx-dep': '2.0.0' },            // 發起樹已經跟上 main 的新 lock
    mainLock: { 'fx-dep': { version: '2.0.0' } },
  });
  try {
    const r = withFakeGh(SELF_VIEW(sha, mainSha), LOCK_OTHERS(sha, /** @type {string} */ (shaB)), { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /本支那側動了 package-lock\.json：否，#442 那側動了：否；合併後的 lock 跟 main 的一樣：否/);
    assert.match(r.stderr, /兩支都落後 main/, '沒分出「落後 main」這種形狀——處置會叫人重裝發起樹，重裝完還是 2');
    assert.match(r.stderr, /rebase/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI｜對照：發起樹沒跟上（合併後的 lock 跟 main 一樣、發起樹是舊的）→ 訊息「一樣：是」，處置指主目錄 npm install', () => {
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } }, installed: { 'fx-dep': '1.0.0' },
    mainLock: { 'fx-dep': { version: '2.0.0' } },
  });
  try {
    const r = withFakeGh(SELF_VIEW(sha, mainSha), LOCK_OTHERS(sha, /** @type {string} */ (shaB)), { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /合併後的 lock 跟 main 的一樣：是/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ CLI｜合併後的 package.json 宣告了 lock 沒有的套件 → 2、三關沒跑（Grok #566 掃 #7：git 合出合法但少套件的 lock）', () => {
  const { dir, sha, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir', markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } }, installed: { 'fx-dep': '1.0.0' },
  });
  try {
    const g = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...SANDBOX_ENV } });
    g(['checkout', '-q', '-b', 'declares']);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkg.devDependencies = { marked: '^17.0.1' };     // 宣告了、lock 沒跟上（合併把 lock 的那一筆弄丟就是這個形狀）
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    g(['add', 'package.json']);
    g(['-c', 'user.email=f@example.com', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'declare dep']);
    const shaD = String(g(['rev-parse', 'HEAD']).stdout).trim();
    g(['checkout', '-q', 'main']);
    const r = withFakeGh(SELF_VIEW(sha, mainSha), LOCK_OTHERS(sha, shaD), { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}\n——0＝package.json 宣告了、lock 沒有，核對掃不到它就進三關`);
    assert.match(r.stderr, /marked.*沒有這一筆/);
    assert.equal(existsSync(join(dir, 'gate-ran')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RERUN_LIMITS｜常數本身要是一句有內容的限制句，正本裡那一句前面不可以是否定詞（Grok #566 掃 #5：includes 對空字串恆真、對「不只限」也真）', () => {
  assert.ok(typeof RERUN_LIMITS === 'string' && RERUN_LIMITS.length >= 10, '常數被掏空，includes 對空字串恆真');
  assert.match(RERUN_LIMITS, /只限.*一次/);
  assert.match(RERUN_LIMITS, /第二次/);
  const step = /** @type {string} */ (crossPrStepText(readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8')));
  const i = step.indexOf(RERUN_LIMITS);
  assert.ok(i >= 0);
  const before = step.slice(Math.max(0, i - 3), i);
  assert.doesNotMatch(before, /不|非|廢/, `正本的限制句被否定詞包住：「${before}${RERUN_LIMITS.slice(0, 6)}…」`);
});

test('failingTestNames｜撈 spec reporter 的 ✖ 題名：去 (ms)、去重、排除「✖ failing tests:」摘要行、有上限', () => {
  const out = [
    'ℹ tests 3', '✔ 好的 (1ms)', '✖ 量時間的那題 (12.3ms)', '  AssertionError: 超時', '✖ 第二題 (0.5ms)',
    '✖ failing tests:', '', 'test at test/x.test.js:10', '✖ 量時間的那題 (12.3ms)', '✖ 第二題 (0.5ms)',
    '✖ 三', '✖ 四', '✖ 五', '✖ 六', '✖ 七',
  ].join('\n');
  const names = failingTestNames(out);
  assert.deepEqual(names.slice(0, 2), ['量時間的那題', '第二題']);
  assert.ok(!names.includes('failing tests:'), '摘要標題被當成題名');
  assert.equal(new Set(names).size, names.length, '同一題印了兩次');
  assert.ok(names.length < 7, '沒有上限，訊息會被幾百題撐爆');
  assert.deepEqual(failingTestNames(undefined), []);
  assert.deepEqual(failingTestNames('全綠\nℹ pass 3'), []);
});

test('⭐ CLI｜三關「考試」真紅時，死因要帶失敗題名（redDetail 的視窗只留頭尾，題名在中段——沒有它「先看是哪一題紅」做不到）', () => {
  const SPEC_LIKE = 'node -e "' + [
    'console.log(\'ℹ tests 40\')',
    'for (let i = 0; i < 20; i++) console.log(\'✔ 第\' + i + \' 題 (1ms)\')',
    'console.log(\'✖ 量時間的那題 (12.3ms)\')',
    'for (let i = 0; i < 20; i++) console.log(\'  斷言細節 \' + i)',
    'console.log(\'✖ failing tests:\')',
    'console.log(\'✖ 量時間的那題 (12.3ms)\')',
    'console.log(\'ℹ fail 1\')',
    'process.exit(1)',
  ].join(';') + '"';
  const { dir, sha } = makeInitiatorRepo({
    nodeModules: 'dir',
    scripts: { typecheck: OK_GATE, lint: OK_GATE, test: SPEC_LIKE },
  });
  try {
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),
      LOCK_OTHERS(sha, sha),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 1, `預期 1，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /紅的考題：量時間的那題/, '失敗題名沒進死因——看的人判斷不了是不是計時題、也就用不了「重跑一次」');
    assert.doesNotMatch(r.stderr, /紅的考題：[^\n]*failing tests/, '摘要標題被當成題名');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('裁決｜lock 混輪的分類句要照輸入算：只混真紅不可以長出「文字衝突」、只混衝突不可以長出「測試紅」', () => {
  const lock = { number: 385, ok: false, kind: /** @type {const} */ ('lock'), why: '對不上（…）' };
  const onlyRed = verdict([lock, { number: 384, ok: false, kind: 'red', why: '合起來之後「考試」紅了：…' }]);
  assert.equal(onlyRed.code, 2);
  assert.match(onlyRed.message, /本輪已確定的阻擋\*\*（跑得起來的測試紅）/);
  assert.doesNotMatch(onlyRed.message, /阻擋\*\*（[^）]*文字衝突/, '沒有衝突卻說有——分類句寫死了');
  const onlyConflict = verdict([lock, { number: 386, ok: false, kind: 'conflict', why: '文字衝突，git merge 就過不去' }]);
  assert.equal(onlyConflict.code, 2);
  assert.match(onlyConflict.message, /本輪已確定的阻擋\*\*（文字衝突）/);
  assert.doesNotMatch(onlyConflict.message, /阻擋\*\*（[^）]*測試紅/, '沒有測試紅卻說有——分類句寫死了');
});

/**
 * 規則正本的「可見文字」——**刻意只剝下面列出的形狀，不是 Markdown renderer**：HTML 註解、hidden／display:none
 * 容器連同內容、其餘 HTML 標籤、fenced code 區塊（規則不會寫在指令框裡）、圖片（載得到圖時 alt 不顯示）、
 * reference-style 連結定義行（`[label]: 網址`，不渲染）、inline 連結目的地（`[字](網址)` 只留字）。
 * #566 r1／r2／r3 Codex 各示範一種空包彈（註解、`<span hidden>`、reference definition）。
 * ⚠️ 誠實劃界（同族第三輪，射程在此封頂）：HTML entity、`<details>` 折疊、code span、多行標籤等其餘形狀
 * **不處理**——這題守的是「正本那一步的可見句子裡逐字有限制句」，不是 GitHub 的渲染結果；再有新形狀進待辦。
 * @param {string} md
 */
function visibleText(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<([a-z][a-z0-9-]*)\b[^>]*\b(?:hidden|display\s*:\s*none)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^(?:> ?)*\s*```[\s\S]*?^(?:> ?)*\s*```[ \t]*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^(?:> ?)*\s*\[[^\]]+\]:\s.*$/gm, '')
    .replace(/\]\([^)]*\)/g, ']');
}

/** 合併步驟裡「跨 PR 試合併閘」那一步的可見文字：從該步的編號行起、到下一個編號步驟為止。 @param {string} md */
function crossPrStepText(md) {
  const lines = visibleText(md).split('\n');
  const start = lines.findIndex((l) => /^> \d+\.\s/.test(l) && l.includes('跨 PR 試合併閘'));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^> \d+\.\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('文件釘住的 helper｜看的是可見文字：HTML 註解、hidden 容器、連結目的地裡的限制句都不算（#566 r1／r2 的空包彈形狀）', () => {
  const rule = RERUN_LIMITS;
  const base = `> 5. ⚠️ **跨 PR 試合併閘（機械執行）**：\n>    \`\`\`bash\n>    node scripts/check-cross-pr-merge.js <N>\n>    \`\`\`\n>    可以重跑一次，${rule}。\n> 6. 下一步`;
  assert.ok(/** @type {string} */ (crossPrStepText(base)).includes(rule), '正常寫法要找得到');
  const inComment = base.replace(rule, '可以重跑兩次') + `\n<!-- ${rule} -->`;
  assert.ok(!/** @type {string} */ (crossPrStepText(inComment)).includes(rule), 'HTML 註解裡的限制句被當成可見規則');
  const inHidden = base.replace(rule, `可以重跑兩次<span hidden>${rule}</span>`);
  assert.ok(!/** @type {string} */ (crossPrStepText(inHidden)).includes(rule), 'hidden 容器裡的限制句被當成可見規則');
  const inStyle = base.replace(rule, `可以重跑兩次<div style="display:none">${rule}</div>`);
  assert.ok(!/** @type {string} */ (crossPrStepText(inStyle)).includes(rule), 'display:none 容器裡的限制句被當成可見規則');
  const inLink = base.replace(rule, `[可以重跑兩次](https://x/${rule})`);
  assert.ok(!/** @type {string} */ (crossPrStepText(inLink)).includes(rule), '連結目的地裡的限制句被當成可見規則');
  const otherStep = `> 4. 別的步驟 ${rule}\n` + base.replace(rule, '可以重跑兩次');
  assert.ok(!/** @type {string} */ (crossPrStepText(otherStep)).includes(rule), '別步驟的限制句被算進這一步');
  // #566 r3 Codex 的三種：reference-style 連結定義（不渲染）、圖片 alt（載圖時不顯示）、fenced code（指令框）
  // 定義行要放在這一步裡面（下一個編號行之前），不然只是被「別步驟不算」擋掉、沒測到剝定義行
  const refDef = base.replace(rule, '[可以重跑兩次][policy]').replace('> 6. 下一步', `>\n> [policy]: https://example.com/${rule}\n> 6. 下一步`);
  assert.ok(!/** @type {string} */ (crossPrStepText(refDef)).includes(rule), 'reference definition 裡的限制句被當成可見規則');
  const inImage = base.replace(rule, `可以重跑兩次 ![${rule}](https://example.com/x.png)`);
  assert.ok(!/** @type {string} */ (crossPrStepText(inImage)).includes(rule), '圖片 alt 裡的限制句被當成可見規則');
  const inFence = base.replace(`可以重跑一次，${rule}。`, `可以重跑兩次。\n>    \`\`\`text\n>    ${rule}\n>    \`\`\``);
  assert.ok(!/** @type {string} */ (crossPrStepText(inFence)).includes(rule), 'fenced code 裡的限制句被當成可見規則');
  // 對照：真的寫在正文裡、旁邊有連結與 code span，仍要找得到
  const normal = base.replace(rule, `${rule}（見 [規則](https://example.com)、\`RERUN_LIMITS\`）`);
  assert.ok(/** @type {string} */ (crossPrStepText(normal)).includes(rule), '正文裡的限制句反而找不到');
});

test('⭐ 文件｜REVIEW-AND-MERGE.md 跨 PR 試合併那一步（規則正本）要逐字含同一串限制句，並寫明 lock 對不上的退 2 不適用重跑', () => {
  // 訊息那份被上面的題釘住；正本這份若漂成「兩次」或整段消失，操作者看到的是訊息與正本互相矛盾——
  // 兩邊共用 RERUN_LIMITS 這一串，漂哪一邊都紅。可見文字的定義在 visibleText／crossPrStepText（有自己的題）。
  const raw = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  const step = crossPrStepText(raw);
  assert.ok(step !== null, '合併步驟裡找不到「跨 PR 試合併閘」那一步的編號行');
  // 指令行住在指令框裡（visibleText 會剝掉指令框），所以對原文驗：編號行之後、下一步之前要有那行
  const rawLines = raw.split('\n');
  const at = rawLines.findIndex((l) => /^> \d+\.\s/.test(l) && l.includes('跨 PR 試合併閘'));
  const next = rawLines.findIndex((l, i) => i > at && /^> \d+\.\s/.test(l));
  assert.ok(rawLines.slice(at, next < 0 ? undefined : next).some((l) => l.includes('node scripts/check-cross-pr-merge.js')), '那一步裡沒有這道閘的指令行');
  assert.ok(step.includes(RERUN_LIMITS), `正本那一步沒有逐字含限制句「${RERUN_LIMITS}」——訊息與正本會分岔`);
  assert.match(step, /不適用/, '正本沒寫 lock 對不上的退 2 不適用重跑');
  assert.match(step, /不會安裝套件/, '正本沒寫這道閘不會安裝套件——「重跑一次」會被拿去對付那種紅');
  assert.match(step, /重跑本閘/, '正本的手動路徑沒寫「從乾淨樹重跑本閘拿 0」——照字面手動跑三關永遠進不了下一步（#566 r5）');
});

test('CLI｜對照組：lock 要求的套件都裝著、版本相同 → 核對放行，三關照跑（三關退 0 ⇒ exit 0）', () => {
  // 沒有這一題，上面兩題的「2」也可能是核對永遠對不上造成的——那樣的閘等於把每一支都擋下來。
  const { dir, sha, shaB, mainSha } = makeInitiatorRepo({
    nodeModules: 'dir',
    markGates: true,
    lock: { 'fx-dep': { version: '1.0.0' } },
    installed: { 'fx-dep': '1.0.0' },
    // 另一支加了一個 optional 套件（沒裝）：lock 真的有差、但核對要放行——optional 那條判準走到端到端
    otherLock: { 'fx-dep': { version: '1.0.0' }, 'only-on-linux': { version: '9.9.9', optional: true, os: ['linux'] } },
  });
  try {
    const r = withFakeGh(
      SELF_VIEW(sha, mainSha),
      LOCK_OTHERS(sha, /** @type {string} */ (shaB)),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 0, `預期 0，實得 ${r.status}\n${r.stdout}${r.stderr}\n——lock 對得上（optional 沒裝不算）就該進三關；擋下來＝把每一支都當成對不上`);
    assert.match(r.stdout, /合起來都是綠的/);
    assert.equal(existsSync(join(dir, 'gate-ran')), true, '記號檔不在＝三關根本沒跑；上面那幾題的「沒有記號」就是空包彈');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI｜合併後的樹沒有 package-lock.json → exit 2（無法核對＝fail-closed，不可以靜靜進三關）', () => {
  const { dir, sha } = makeInitiatorRepo({ nodeModules: 'dir', scripts: { typecheck: OK_GATE, lint: OK_GATE, test: OK_GATE }, lock: null });
  try {
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),
      LOCK_OTHERS(sha, sha),
      { pr: '441', cwd: dir, env: { ...SANDBOX_ENV } },
    );
    assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /無法核對/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('裁決｜任何一筆「執行不起來」（cantRun）→ 整輪 2，標題不可以說「合起來會壞」', () => {
  const v = verdict([
    { number: 384, ok: true, why: '' },
    { number: 385, ok: false, kind: 'cantRun', why: '「校對」執行不起來（症狀：退出碼 127）：…' },
  ]);
  assert.equal(v.code, 2, '「執行不起來」＝拿不到可信的測試判決，只值得「查不清楚」');
  assert.doesNotMatch(v.message, /合起來會壞/);
  assert.match(v.message, /下不了定論/,
    'r2 版標題寫「這是環境問題，不是兩支相斥」——但 126／127 兩支各自全綠也造得出來（Codex 反例），只能說「下不了定論」');
  // 訊息的「不推定成因」不是裝飾（#446 r3 實測：把成因改寫成單一環境歸因，當時的
  // 考題照綠＝散文沒人守）。字串只釘這一個詞；**結構性的守法在下面 CANT_RUN_CAUSES 的資料題**。
  assert.match(v.message, /不推定成因/,
    '訊息替 126／127 斷定了成因——127 連「測試自己印完輸出再退 127」都做得到（#446 r3 反例）');
});

test('裁決｜成因可能是資料不是散文：環境與非環境必須同時在列、且每一條都要進訊息（#446 r4——關鍵字守不住語意）', () => {
  // #446 r4 Codex 實測：三種可能全改寫成環境歸因、保留「追蹤檔案」關鍵字，字串斷言照綠。
  // 所以守法改成驗資料結構＋資料到訊息的接線；kind 的文字被改寫到失真屬散文層，
  // 考題原則上守不住——那條界線寫在 CANT_RUN_CAUSES 檔頭，由審查的人守。
  const kinds = new Set(CANT_RUN_CAUSES.map((c) => c.kind));
  assert.ok(kinds.has('env'), '環境成因不在列——#441 那種最常見的形狀反而沒人講');
  assert.ok(kinds.has('cross-pr'),
    '非環境的「兩支合出來的破壞」成因不在列（#446 r2 反例）——只剩環境歸因，看的人會以為修環境就好');
  assert.ok(kinds.has('self-exit'), '「受測內容自己退 126／127」的成因不在列（#446 r3 反例）');
  const v = verdict([{ number: 385, ok: false, kind: 'cantRun', why: '「校對」執行不起來（症狀：退出碼 127）：…' }]);
  for (const c of CANT_RUN_CAUSES) {
    assert.ok(typeof c.text === 'string' && c.text.trim().length > 0,
      `成因「${c.kind}」的 text 是空的——includes('') 恆真，「每條都進訊息」的斷言會假綠（#446 r5）`);
    assert.ok(v.message.includes(c.text), `成因「${c.kind}」沒有進到訊息裡——資料與訊息斷線`);
  }
});

test('裁決｜同輪混著「跑得起來的真紅」與「執行不起來」→ 整輪 2，但真紅要列出、不可被標題否定（#446 r2）', () => {
  const v = verdict([
    { number: 385, ok: false, kind: 'red', why: '合起來之後「考試」紅了：斷言炸了' },
    { number: 390, ok: false, kind: 'cantRun', why: '「校對」執行不起來（症狀：EACCES）：…' },
  ]);
  assert.equal(v.code, 2, '有一筆量不準，整輪就下不了「安全」的定論——fail-closed');
  assert.match(v.message, /#385/);
  assert.match(v.message, /#390/);
  assert.match(v.message, /已確定的阻擋/,
    'r2 版標題「不是兩支相斥」會把同輪已經量到的真阻擋一句話否定掉——它們必須被點名保留');
  // 分類句要**照輸入算**：這一輪的已確定阻擋只有測試紅、沒有文字衝突——
  // 寫死的散文分類句正是 #446 r4 抓到的假綠形狀（同義改寫照樣全綠）。
  assert.match(v.message, /跑得起來的測試紅/, '測試紅那筆沒被分類句點名');
  assert.doesNotMatch(v.message, /文字衝突/, '這一輪根本沒有文字衝突，分類句卻提到它＝分類是寫死的散文、不是照輸入算');
});

test('裁決｜「文字衝突」＋「執行不起來」混輪 → 2，衝突要被點名保留、且不可以被叫成「測試紅」（#446 r3）', () => {
  // r3 版把所有非 cantRun 統稱「跑得起來的紅（真的測試紅）」——文字衝突是確定阻擋、
  // 但它根本沒跑到測試，這樣叫會讓看的人去翻不存在的測試輸出（Codex r3 實測重現）。
  const v = verdict([
    { number: 387, ok: false, kind: 'conflict', why: '文字衝突，git merge 就過不去' },
    { number: 390, ok: false, kind: 'cantRun', why: '「校對」執行不起來（症狀：EACCES）：…' },
  ]);
  assert.equal(v.code, 2);
  assert.match(v.message, /文字衝突/, '衝突那筆的死因不見了');
  assert.match(v.message, /已確定的阻擋/, '文字衝突是該輪試合併已確定的阻擋，不因下不了定論而失效——要點名保留');
  // 分類句照輸入算：這一輪只有文字衝突，訊息裡不可以出現任何「測試紅」——
  // 同義改寫（如「確定的測試紅，文字衝突也算在內」）在 #446 r4 被實測騙過逐字斷言，
  // 語意斷言（輸入沒有測試紅⇒訊息不得說測試紅）才守得住。
  assert.doesNotMatch(v.message, /測試紅/,
    '文字衝突被歸進「測試紅」——它根本沒跑到測試，看的人會去翻不存在的測試輸出');
});

test('裁決｜分類看 kind、不嗅 why：測試輸出裡剛好有「文字衝突」字樣的真測試紅，不可以被分類成衝突（#446 r5）', () => {
  // 嗅 why.includes('文字衝突') 的版本在這個輸入下把真測試紅分類成「文字衝突」，
  // 「跑得起來的測試紅」從分類句消失（#446 r5 Codex 實測）——why 包著測試自己的輸出，
  // 內容出現什麼字樣都有可能；分類的依據必須是 tryMerge 在知道死法當下標的結構化 kind。
  const v = verdict([
    { number: 385, ok: false, kind: 'red', why: '合起來之後「考試」紅了：「文字衝突偵測」這道考題炸了 / stderr：assert 不成立' },
    { number: 390, ok: false, kind: 'cantRun', why: '「校對」執行不起來（症狀：EACCES）：…' },
  ]);
  assert.equal(v.code, 2);
  assert.ok(v.message.includes('已確定的阻擋**（跑得起來的測試紅）'),
    `分類句沒把這筆算成測試紅——它的 why 只是「內容提到」文字衝突，死法是 kind='red'。訊息：\n${v.message}`);
  assert.ok(!v.message.includes('已確定的阻擋**（文字衝突'),
    '分類句被 why 的散文內容帶偏成「文字衝突」——嗅字串的病（#446 r5 反例）');
});

test('裁決｜footer 也看 kind、不嗅 why：why 提到「文字衝突」的真測試紅，不可以長出衝突的說明（#446 r6）', () => {
  const v = verdict([
    { number: 385, ok: false, kind: 'red', why: '合起來之後「考試」紅了：「文字衝突偵測」這道考題炸了' },
  ]);
  assert.equal(v.code, 1);
  assert.match(v.message, /合起來測試紅/, '測試紅的說明不見了');
  assert.doesNotMatch(v.message, /GitHub 自己就看得到/,
    '「文字衝突」的說明被 why 的散文內容觸發——footer 的判準退回嗅字串（#446 r6 存活過的突變）');
});

test('⭐ 裁決｜ok 不是布林（例如字串 "false"）＝整輪查不清楚（2）：單獨、混綠、混真紅都一樣（#566 r5：truthiness 會把 "false" 當成綠而退 0）', () => {
  const fake = /** @type {any} */ ({ number: 1, ok: 'false', why: 'bad', kind: 'cantRun' });
  for (const results of [[fake], [{ number: 2, ok: true, why: '' }, fake], [fake, { number: 3, ok: false, kind: 'red', why: '紅' }]]) {
    const v = verdict(results);
    assert.equal(v.code, 2, `${JSON.stringify(results)} 應退 2，實得 ${v.code}——「false」字串被當成綠＝假綠`);
    assert.match(v.message, /形狀不對/);
    assert.doesNotMatch(v.message, /都是綠的/);
  }
  // 編號不是數字、整包不是陣列、項目不是物件——同一道形狀防線
  assert.equal(verdict(/** @type {any} */ ([{ number: '1', ok: false, kind: 'red', why: '紅' }])).code, 2);
  assert.equal(verdict(/** @type {any} */ (null)).code, 2);
  assert.equal(verdict(/** @type {any} */ ([null])).code, 2);
  // #566 r6 的四種：[undefined] 不可以丟例外；ok:true 帶 kind 是矛盾；NaN 編號；未知欄位不可回聲
  assert.equal(verdict(/** @type {any} */ ([undefined])).code, 2, '[undefined] 應退 2，不是丟 TypeError');
  assert.equal(verdict(/** @type {any} */ ([{ number: 1, ok: true, why: '', kind: 'red' }])).code, 2, 'ok:true 卻帶失敗 kind＝矛盾，不可宣告全綠');
  assert.equal(verdict(/** @type {any} */ ([{ number: NaN, ok: true, why: '' }])).code, 2, 'NaN 編號不是合法 PR 編號');
  assert.equal(verdict(/** @type {any} */ ([{ number: 1.5, ok: true, why: '' }])).code, 2);
  assert.equal(verdict(/** @type {any} */ ([{ number: 1, ok: true }])).code, 2, 'why 缺席也是形狀不對');
  const leaky = verdict(/** @type {any} */ ([{ number: 1, ok: 'false', why: 'x', token: 'SECRET-SENTINEL' }]));
  assert.equal(leaky.code, 2);
  assert.doesNotMatch(leaky.message, /SECRET-SENTINEL/, '形狀防線把未知 payload 整包印出來——這條分支的敘事就是「有別的東西在餵結果」');
  assert.match(leaky.message, /第 0 筆：.*ok 不是布林/, '診斷要指到哪一筆哪個欄');
  // 循環物件、BigInt 也不可以讓診斷路徑丟例外
  const cyc = /** @type {any} */ ({ number: 1, ok: 'x', why: '' }); cyc.self = cyc;
  assert.equal(verdict([cyc]).code, 2);
  assert.equal(verdict(/** @type {any} */ ([{ number: 1, ok: true, why: '', big: 10n }])).code, 0, '多餘欄位（型別正確）不算形狀不對——只驗承重欄');
  // #566 r7 的兩種：稀疏陣列的空槽（forEach 會跳過）、顯式 kind: undefined（own property 存在＝帶了）
  assert.equal(verdict(/** @type {any} */ (Array(1))).code, 2, '稀疏陣列的空槽被跳過＝一筆沒驗就宣告全綠');
  const holed = /** @type {any[]} */ ([{ number: 1, ok: true, why: '' }]);
  holed[2] = { number: 2, ok: true, why: '' };   // 第 1 格是空槽
  assert.equal(verdict(holed).code, 2, '中間的空槽被跳過');
  assert.equal(verdict(/** @type {any} */ ([{ number: 566, ok: true, why: 'green', kind: undefined }])).code, 2, '顯式 kind: undefined 也是帶了 kind——ok:true 帶 kind 是矛盾');
  assert.equal(verdict(/** @type {any} */ ([{ number: 566, ok: false, why: 'x', kind: undefined }])).code, 2, 'ok:false 帶 kind: undefined＝kind 不是字串');
  // 對照：形狀正確的綠仍是 0
  assert.equal(verdict([{ number: 1, ok: true, why: '' }]).code, 0);
  assert.deepEqual(resultShapeProblems([{ number: 1, ok: false, why: '', kind: 'red' }]), []);
});

test('⭐ lockMismatches｜optional 只認布林 true：字串 "false"／數字／物件都不能豁免缺套件（算無法核對）；optional: false 缺套件照樣對不上（#566 r5：閘會變鬆的例外）', () => {
  for (const bad of ['false', 'true', 1, 0, {}, []]) {
    const lock = { packages: { '': {}, 'node_modules/a': { version: '1.0.0', optional: bad } } };
    const m = lockMismatches(lock, () => null, null);
    assert.equal(m.length, 1, `optional=${JSON.stringify(bad)} 缺套件竟然放行或多報：${m.join(' / ')}`);
    assert.match(m[0], /無法核對/, `optional=${JSON.stringify(bad)} 要報「無法核對」，實得 ${m[0]}`);
  }
  const strictFalse = lockMismatches({ packages: { '': {}, 'node_modules/a': { version: '1.0.0', optional: false } } }, () => null, null);
  assert.equal(strictFalse.length, 1); assert.match(strictFalse[0], /沒有裝/);
  const strictTrue = lockMismatches({ packages: { '': {}, 'node_modules/a': { version: '1.0.0', optional: true, os: ['not-this-os'] } } }, () => null, null);
  assert.deepEqual(strictTrue, []);
});

test('⭐ lockMismatches｜optional 缺套件只在「這台本來就不該裝」（os／cpu 排除本機）時放行；本機該裝的 optional 缺了照樣對不上（Grok #566 掃 #1）', () => {
  const missing = () => null;
  const lock = (/** @type {object} */ extra) => ({ packages: { '': {}, 'node_modules/native': { version: '1.0.0', optional: true, ...extra } } });
  const here = { platform: 'darwin', arch: 'arm64' };
  assert.deepEqual(lockMismatches(lock({ os: ['linux'], cpu: ['x64'] }), missing, null, here), [], '他平台的 optional 缺了應放行');
  assert.deepEqual(lockMismatches(lock({ os: ['!darwin'] }), missing, null, here), [], '排除本機的 optional 缺了應放行');
  assert.equal(lockMismatches(lock({ os: ['darwin'], cpu: ['arm64'] }), missing, null, here).length, 1, '本機該裝的原生 optional 缺了卻放行');
  assert.equal(lockMismatches(lock({}), missing, null, here).length, 1, '沒寫 os／cpu 的 optional（純 JS）缺了卻放行');
  assert.equal(lockMismatches(lock({ os: ['darwin', 'linux'], cpu: ['!x64'] }), missing, null, here).length, 1);
  assert.deepEqual(lockMismatches(lock({ os: ['darwin'], cpu: ['x64'] }), missing, null, here), [], 'cpu 不同的 optional 缺了應放行');
  // 沒給 opts 時用本機的 platform／arch；os 清單裡非字串的項目略過
  assert.deepEqual(lockMismatches(lock({ os: [`!${process.platform}`, 7] }), missing, null), []);
});

test('⭐ lockMismatches｜package.json 宣告的相依都要在 lock 的 packages 裡：git 三方合併可能合出合法 JSON 卻少了套件（Grok #566 掃 #7）', () => {
  const installed = () => ({ name: 'a', version: '1.0.0' });
  const lock = { packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } };
  assert.deepEqual(lockMismatches(lock, installed, null, { pkgJson: { dependencies: { a: '^1' } } }), []);
  const m = lockMismatches(lock, installed, null, { pkgJson: { dependencies: { a: '^1' }, devDependencies: { marked: '^17' } } });
  assert.equal(m.length, 1, `少了 marked 應一筆：${m.join(' / ')}`);
  assert.match(m[0], /marked.*devDependencies.*沒有這一筆/);
  assert.deepEqual(lockMismatches(lock, installed, null, { pkgJson: null }), [], 'pkgJson 沒給就不驗這條');
  assert.deepEqual(lockMismatches(lock, installed, null, { pkgJson: { dependencies: 'x' } }), [], 'dependencies 不是物件就略過');
});

test('⭐ lockMismatches｜承重欄位有寫就要是對的型別：link:0／name:0／resolved:0／integrity:0／version:1 一律「無法核對」，不可以被當成沒寫而放行（#566 r6：閘會變鬆的例外）', () => {
  const installed = () => ({ name: 'a', version: '1.0.0' });
  for (const entry of [
    { version: '1.0.0', link: 0 }, { version: '1.0.0', link: 'true' },
    { version: '1.0.0', name: 0 }, { version: '1.0.0', name: {} },
    { version: '1.0.0', resolved: 0, integrity: 0 }, { version: '1.0.0', resolved: 'x', integrity: [] },
    { version: 1 }, { version: null },
  ]) {
    const m = lockMismatches({ packages: { '': {}, 'node_modules/a': entry } }, installed, { 'node_modules/a': { version: '1.0.0', resolved: 'x', integrity: 'y' } });
    assert.equal(m.length, 1, `${JSON.stringify(entry)} 應該一筆「無法核對」，實得：${m.join(' / ')}`);
    assert.match(m[0], /型別不對|無法核對/);
  }
  // 隱藏 lock 那一筆的 resolved／integrity 型別錯也一樣
  const hb = lockMismatches({ packages: { '': {}, 'node_modules/a': { version: '1.0.0', resolved: 'x', integrity: 'y' } } }, installed, { 'node_modules/a': { version: '1.0.0', resolved: 0, integrity: 'y' } });
  assert.equal(hb.length, 1); assert.match(hb[0], /隱藏 lock.*型別不對/);
  // 對照：欄位都是對的型別 → 空
  assert.deepEqual(lockMismatches({ packages: { '': {}, 'node_modules/a': { version: '1.0.0', name: 'a', link: false, optional: false, resolved: 'x', integrity: 'y' } } }, installed, { 'node_modules/a': { version: '1.0.0', resolved: 'x', integrity: 'y' } }), []);
});

test('裁決｜kind 缺席＝整輪查不清楚（2）：單獨、混 red、混 conflict、混 cantRun 四種都一樣（#446 r6／r7）', () => {
  // 產出端（tryMerge）由 discriminated union 鎖「失敗必帶 kind」＝拔掉就校對紅；
  // verdict 是 exported 純函式、執行期擋不了亂餵，runtime 的防線是：出現未標記
  // ＝這一輪的分類不可信，一律 2。#446 r7 實測舊版只在混到 cantRun 時保守——
  // 單獨缺席仍回 1 掛「合起來會壞」、混 red 時被測試紅的 footer 籠罩背書。
  const unlabeled = { number: 385, ok: false, why: '不明死法' };
  /** @type {Parameters<typeof verdict>[0][]} */
  const combos = [
    [unlabeled],
    [unlabeled, { number: 390, ok: false, kind: 'red', why: '合起來之後「考試」紅了：斷言炸了' }],
    [unlabeled, { number: 391, ok: false, kind: 'conflict', why: '文字衝突，git merge 就過不去' }],
    [unlabeled, { number: 392, ok: false, kind: 'cantRun', why: '「校對」執行不起來（症狀：EACCES）：…' }],
  ];
  for (const results of combos) {
    const v = verdict(results);
    const label = results.map((r) => r.kind ?? '（無）').join('＋');
    assert.equal(v.code, 2,
      `${label}：預期 2，實得 ${v.code}——有一筆死法不可信，「合起來會壞／都是綠的」都下不了手`);
    assert.match(v.message, /未標記/, `${label}：未標記的條目要被點名，不可以靜靜滑走或被別的分類背書`);
    assert.doesNotMatch(v.message, /合起來會壞/, `${label}：分類不可信時不可以宣稱相容性結論`);
  }
});

test('cantRunSignal｜判準是「拿不到數字退出碼」＋126／127，不是 errno 名單（#446 r2 High：EACCES 曾漏網）', () => {
  assert.equal(cantRunSignal({ status: null, code: 'EACCES', signal: null }), 'EACCES',
    'r2 版列舉 ENOENT／126／127，EACCES（npm 在 PATH 上但沒執行位）就漏成退出碼 1');
  assert.equal(cantRunSignal({ status: null, code: 'ENOENT', signal: null }), 'ENOENT');
  assert.equal(cantRunSignal({ status: null, signal: 'SIGTERM' }), '被 SIGTERM 終止');
  assert.equal(cantRunSignal({ status: 127 }), '退出碼 127');
  assert.equal(cantRunSignal({ status: 126 }), '退出碼 126');
  assert.equal(cantRunSignal({ status: 1 }), null, '跑得起來的紅是這道閘存在的全部理由，不可以被吃掉');
  assert.equal(cantRunSignal({ status: 2 }), null,
    'eslint 的退出碼 2 可能是合出來的壞設定＝真的相容性問題，刻意不歸「執行不起來」');
});

test('⭐ CLI｜npm 存在但不可執行（spawn EACCES）→ exit 2（#446 r2 High：errno 名單外的「執行不起來」）', () => {
  // PATH 只放三樣：不可執行的 npm＋symlink 的真 git 與 cat（假 gh 的 heredoc 要用 cat；
  // 少了它假 gh 自己先崩，走到「gh 失敗」的 2——理由對不上，本題就白考了）。
  // libuv 的 PATH 搜尋在只找得到不可執行檔時回 EACCES（status null、code 'EACCES'）
  // ——實測見 r3 commit 訊息。
  const { dir, sha } = makeInitiatorRepo({ nodeModules: 'dir' });
  const bin = mkdtempSync(join(tmpdir(), 'npm-noexec-'));
  try {
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');   // 刻意不 chmod ＝不可執行
    for (const tool of ['git', 'cat']) {
      const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8', env: { ...SANDBOX_ENV } }).stdout.trim();
      symlinkSync(real, join(bin, tool));
    }
    const r = withFakeGh(
      JSON.stringify({ number: 441, headRefOid: sha, baseRefName: 'main' }),
      JSON.stringify([
        { number: 441, headRefOid: sha, headRefName: 'b441', baseRefName: 'main' },
        { number: 442, headRefOid: sha, headRefName: 'b442', baseRefName: 'main' },
      ]),
      { pr: '441', cwd: dir, env: { PATH: bin, HOME: SANDBOX_ENV.HOME } },
    );
    assert.equal(r.status, 2,
      `預期 2，實得 ${r.status}\n${r.stdout}${r.stderr}\n`
      + '——spawn 層的失敗拿不到任何測試判決，報成 1 就是 #441 的誤報換個 errno 重演（r2 實得 1）。');
    assert.match(r.stderr, /執行不起來/);
    assert.match(r.stderr, /EACCES/, '症狀（errno 字串）沒進死因欄，看的人少一條關鍵線索');
    assert.doesNotMatch(r.stderr, /合起來會壞/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redDetail｜太長時頭尾都留：最後一行的真正死因不可以被裁掉（#446 r1 Medium 的行為示範）', () => {
  const noise = Array.from({ length: 7 }, (_, i) => `${'x'.repeat(80)}-${i}`);
  const d = redDetail({ stderr: [...noise, 'FINAL-CAUSE-CODE-127'].join('\n') });
  assert.match(d, /FINAL-CAUSE-CODE-127/,
    '末行死因被「只留開頭」的截斷裁掉——看的人拿到的全是前置噪音（r1 版 slice(0,300) 的實際行為）');
  assert.match(d, /x{20}/, '開頭也要留著（sh 的「command not found」常常就在第一行）');
});

test('redDetail｜stderr 超過行窗時首行也要活著：sh 的死因常在第一行（#446 r7——「只取末 N 行」會整行丟掉它）', () => {
  // 噪音行刻意各不相同：#446 r7 實測過「七行相同的 x」連行窗 8→7 的弱化都測不出。
  // 行窗本身是調校值不是承重點；承重的是「首行與末行都活著」。
  const noise = Array.from({ length: 20 }, (_, i) => `noise-line-${i}-${'y'.repeat(20)}`);
  const d = redDetail({ stderr: ['HEAD-CAUSE-COMMAND-NOT-FOUND', ...noise, 'TAIL-CAUSE-EXIT-127'].join('\n') });
  assert.match(d, /HEAD-CAUSE-COMMAND-NOT-FOUND/,
    '首行被「只取末 N 行」整行丟掉（#446 r7 實測）——sh 的「command not found」就住在那一行');
  assert.match(d, /TAIL-CAUSE-EXIT-127/, '末行也要活著（#446 r1 的教訓）');
});

test('三關紅的死因要帶 stderr（127 的「command not found」不在 stdout——#441 當時只看得到 npm 橫幅）', () => {
  const d = redDetail({
    stdout: '\n> app@0.0.0 typecheck\n> tsc -p jsconfig.json\n',
    stderr: 'sh: tsc: command not found\nnpm error Lifecycle script `typecheck` failed with error:\nnpm error code 127',
  });
  assert.match(d, /command not found/,
    '死因（stderr）被丟掉，只剩 stdout 的 npm 橫幅——環境錯誤看起來就像測試紅，#441 就是這樣誤判的');
  assert.match(d, /typecheck/, 'stdout 的橫幅也要留著（它說明倒在哪一關的哪個指令）');
});

test('三關紅但子行程兩邊都沒輸出（如 spawn 本身失敗）→ 退回 message，不可以是空死因', () => {
  assert.match(redDetail({ message: 'spawnSync npm ENOENT' }), /ENOENT/);
  assert.ok(redDetail(null).length > 0,
    '連 message 都沒有也要給一句話——空字串會讓訊息停在「紅了：」，看的人什麼線索都拿不到');
});

test('⭐ runIn 不可以被繼承的 GIT_* 牽著走（拿掉 env: gitEnv() 要紅）', () => {
  // ⚠️ 這一題守的是這道閘**動到哪一個 repo**。`runIn` 是它 worktree add／merge／remove 的唯一入口，
  //    而 `GIT_DIR` 一存在，git 就完全不看 `cwd`——那些「建立」與「移除」有可能落在別棵樹上。
  //
  // ⚠️ **刻意不在考題裡 `git init` 造一棵誘餌 repo**：那正是 2026-08-09 事故的兇器
  //    （在帶 `GIT_DIR` 的環境下 `git init` 會把共用 config 寫成 bare=true）。這裡改用
  //    「指到不存在的 gitdir」——環境沒被清時 git 會直接 fatal、`execFileSync` 丟例外，
  //    一樣是行為上的紅，而且不必在考題裡動任何真的 repo。
  // ⚠️ **這一題是代理指標，射程有限**：注入的 `GIT_DIR` 是實測唯一「四種呼叫形狀通吃」的變數
  //    （對照表在 test/helpers/dirty-git-env.js 檔頭），它證明的是真實情境下結果沒被帶偏。
  //    ⚠️ 它**擋不住**「把清法退化成只刪 GIT_DIR 的列名版」——那一族由同檔題名關鍵字
  //    「runIn 交給子行程的環境裡不可以有任何 GIT_*」那題（直接讀子行程收到什麼）守。
  const restore = injectDirtyGitEnv();
  try {
    const top = runIn(['git', 'rev-parse', '--show-toplevel'], ROOT).trim();
    assert.equal(realpathSync(top), realpathSync(ROOT),
      '注入髒 GIT_* 之後 runIn 回答的 toplevel 就不是本樹了。\n'
      + '⇒ 這道閘會在**別棵樹**上 git worktree add／remove。cwd 隔離不了 GIT_DIR——'
      + '本題只證明「環境必須清乾淨」，不宣稱技術上只有一種寫法；'
      + '本專案的規定是一律走 lib/git-env.js 的 gitEnv()（AGENTS.md 鐵則 11），理由是收成一份才不會漂。');
  } finally {
    restore();
  }
});

test('⭐ runIn 交給子行程的環境裡不可以有任何 GIT_*（直接斷言，不靠代理指標）', () => {
  // ⚠️ 題名關鍵字「runIn 不可以被繼承的 GIT_* 牽著走」那題是**代理指標**：它問「答案對不對」，
  //    而那要靠注入的變數**剛好會改變 git 行為**才驗得到
  //    ——一個沒人見過的新家族就驗不到（那正是列名式清法一路失守的形狀）。
  //    這一題改成直接問**子行程實際收到什麼**：不管未來冒出哪個名字都涵蓋得到。
  //    （#463 r1 複審的建議：「以假 git/gh 記錄並斷言所有 GIT_* 均未傳入」。）
  const dir = mkdtempSync(join(tmpdir(), 'runin-env-probe-'));
  try {
    const log = join(dir, 'seen.txt');
    const probe = join(dir, 'probe');
    writeFileSync(probe, `#!/bin/sh\nenv | grep '^GIT_' | cut -d= -f1 | sort > ${JSON.stringify(log)}\nexit 0\n`);
    chmodSync(probe, 0o755);
    const restore = injectDirtyGitEnv();
    try {
      runIn([probe], ROOT);
    } finally {
      restore();
    }
    const seen = readFileSync(log, 'utf8').trim();
    assert.equal(seen, '',
      `runIn 把這些 GIT_* 原封不動傳給子行程了：\n${seen}\n`
      + '⇒ 這道閘會 spawn git 與 npm（`npm run test` 會在臨時工作區跑整套考題），'
      + '任何一個漏網的 GIT_* 都可能讓它們去動別的 repo。');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ runIn 的 opts 不可以覆寫 env（Grok 預審抓到：那是一道靜靜打開的門）', () => {
  // ⚠️ `runIn` 的註解宣稱「**不接受 `env`**」，而它成立的**唯一理由**是物件字面量裡
  //    `env: gitEnv()` 寫在 `...opts` **後面**（後寫的鍵蓋掉先寫的）。那是一個
  //    **沒有考題撐著的排序保證**：把 `...opts` 挪到最後（`{ cwd, …, env: gitEnv(), ...opts }`
  //    ——一種很常見的重構寫法），呼叫端塞的 `env` 就會生效，而**本檔 43 題照樣全綠**（實測）。
  //    ⇒ 這一題把「呼叫端硬塞 env」那條路真的走一遍：不管實作怎麼排鍵，子行程都不可以看到 GIT_*。
  const dir = mkdtempSync(join(tmpdir(), 'runin-optsenv-'));
  try {
    const log = join(dir, 'seen.txt');
    const probe = join(dir, 'probe');
    writeFileSync(probe, `#!/bin/sh\n{ echo CALLED; env | grep '^GIT_' | cut -d= -f1 | sort; } > ${JSON.stringify(log)}\nexit 0\n`);
    chmodSync(probe, 0o755);
    // 呼叫端刻意把一整包髒環境當 opts.env 塞進去。型別上不接受，所以要 cast——
    // **但型別擋不住執行期，而這一題守的正是執行期**。
    runIn([probe], ROOT, /** @type {any} */ ({ env: { ...process.env, ...DIRTY_GIT_ENV } }));
    const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.includes('CALLED'), '探針沒被叫到 ⇒ 這一題是空轉的');
    const leaked = lines.filter((l) => l.startsWith('GIT_'));
    assert.deepEqual(leaked, [],
      `呼叫端塞的 env 蓋掉了清理，子行程看到：${leaked.join('、')}\n`
      + '⇒ `runIn` 的「不接受 env」是靠鍵的排序成立的，而那道門被打開了。'
      + '請讓 `env: gitEnv()` 永遠寫在 `...opts` 之後（或明確把 opts.env 剔除）。');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ 發起樹的 fixture 不可以波及真的 repo（保險絲：本檔也會跑 git init）', () => {
  // ⚠️ `makeInitiatorRepo()` 會在暫存目錄跑 `git init`——**那正是 2026-08-09 事故的兇器**。
  //    它用的 `SANDBOX_ENV` 是**從零組**的（只給 PATH／HOME），所以 GIT_* 洩不進去；
  //    但那是「現在的寫法」，不是保證。⚠️ Grok 預審（2026-08-15）指出：同族的
  //    `test/worktree-integrity.test.js` 有這道保險絲、本檔沒有 ⇒ 有人把 SANDBOX_ENV 改成
  //    「`process.env` 扣幾個」時，本檔的 fixture 會安安靜靜把真的 repo 寫成 bare，而沒有題會紅。
  const { dir } = makeInitiatorRepo();
  try {
    assert.deepEqual(worktreeIntegrityProblems(ROOT), [],
      '⛔ 本檔的 fixture 把**真的 repo** 弄壞了。立刻檢查 SANDBOX_ENV 是不是被改成會帶 GIT_* 進去。');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ 會叫 gh 的閘（不寫死幾支——#526 r3 抓到寫死的『四』漏了真考卷），交給 gh 的環境裡也不可以有 GIT_*（r1 High）', () => {
  // ⚠️ 為什麼 `gh` 算在鐵則 11 的射程內：**它會自己再去 spawn git**。實測（2026-08-15）
  //    `env GIT_DIR=<不存在的路徑> gh pr view 463` ⇒ `failed to run git: fatal: not a git repository`。
  //    後果分兩種：指到不存在的路徑＝**假阻擋**（閘查不到就 fail-closed，看起來像 PR 有問題）；
  //    指到另一個**有效** repo＝這幾道閘會去讀**別的 repo** 的 PR、留言與 open PR 清單，
  //    而輸出看起來完全正常——合併程序會照著別人的資料做判斷。
  //
  // ⚠️ 這一題用**假 gh 記錄環境**，不看指令結果：假 gh 一律 exit 1，這幾支閘都會走 fail-closed
  //    的那條路直接收工 ⇒ 不會有任何一支真的去 `git worktree add`（考題不動任何真的樹）。
  //    ⚠️ 也因此**每支閘只有第一次 gh 呼叫被走到**（#526 r4）——多次呼叫的閘（如真考卷閘）
  //    後面幾個呼叫點的行為題在它自己的考題檔（test/ci-really-ran.test.js 鐵則 11 那題）。
  const GH_GATES = [
    'scripts/check-ci-really-ran.js',   // #526 r3（Codex）：漏在原「四支」清單外，三次 gh 呼叫都沒 gitEnv()
    'scripts/check-cross-pr-merge.js',
    'scripts/check-pr-collab-fields.js',
    'scripts/check-pr-merge-gate.js',
    'scripts/check-review-verdicts.js',
  ];
  for (const rel of GH_GATES) {
    const dir = mkdtempSync(join(tmpdir(), 'gh-env-probe-'));
    try {
      const log = join(dir, 'seen.txt');
      const fake = join(dir, 'gh');
      // 記下「被叫到了」與「當下看得到哪些 GIT_*」，然後 exit 1 讓閘 fail-closed 收工。
      writeFileSync(fake,
        `#!/bin/sh\n{ echo CALLED; env | grep '^GIT_' | cut -d= -f1 | sort; } >> ${JSON.stringify(log)}\nexit 1\n`);
      chmodSync(fake, 0o755);
      spawnSync(process.execPath, [join(ROOT, rel), '463'], {
        encoding: 'utf8', cwd: ROOT,
        env: { ...process.env, ...DIRTY_GIT_ENV, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });
      const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
      // 反面①：gh 真的被叫到了——沒被叫到的話下面那條斷言是空的（0 個 GIT_* 當然通過）
      assert.ok(lines.includes('CALLED'),
        `${rel} 根本沒有叫到 gh ⇒ 這一輪的斷言是空轉的（假 gh 沒被撿到？參數不對？）`);
      const leaked = lines.filter((l) => l.startsWith('GIT_'));
      assert.deepEqual(leaked, [],
        `${rel} 把這些 GIT_* 傳給 gh 了：${leaked.join('、')}\n`
        + 'gh 會自己再去 spawn git（AGENTS.md 鐵則 11 的射程），請加 env: gitEnv()。');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ⭐ 入口守衛（經過 symlink 的路徑也要真的跑）**移到 `test/entry-guard.test.js`**。
// 原因：這裡原本是**把檔案內容複製**到暫存資料夾再跑，那同時斷言了兩件事——
//   ① 路徑經過 symlink 仍認得出自己是進入點（**真實情境，就是當初那個 bug**）
//   ② 這支檔案可以整支複製出去單獨執行（**從來不是需求**）
// 進入點判斷收攏成 `lib/is-main.js` 之後，②自然不再成立（複製出去的孤兒檔找不到它）。
// 新考題用**真正的 symlink** 驗①，而且一次涵蓋**四支閘**，不是只有這一支。
