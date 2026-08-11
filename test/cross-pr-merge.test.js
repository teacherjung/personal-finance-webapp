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
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { othersToTry, verdict, MERGE_GATE, redDetail } from '../scripts/check-cross-pr-merge.js';

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
    { number: 385, ok: false, why: '合起來之後「考試」紅了：契約標題不是允許的寫法' },
  ]);
  assert.equal(v.code, 1);
  assert.match(v.message, /#385/);
  assert.match(v.message, /各自的 CI 都是綠的/, '訊息沒有解釋「為什麼兩支 CI 綠還是會壞」——那正是最難懂的地方');
});

test('⭐ 裁決｜**兩種壞法要分開講**（第一次實跑就發現我原本混為一談了）', () => {
  // 文字衝突：GitHub 自己就看得到（合併鍵會變灰）——這道閘的價值只是「提早告訴你」。
  // 合起來測試紅：GitHub **不會**顯示——那才是它存在的理由。
  // 把兩種都說成「GitHub 不會顯示衝突」是不準確的，而且會讓人不信任後面那句。
  const textOnly = verdict([{ number: 387, ok: false, why: '文字衝突，git merge 就過不去' }]);
  assert.match(textOnly.message, /GitHub 自己就看得到/);
  assert.doesNotMatch(textOnly.message, /GitHub \*\*不會\*\* 顯示/u);

  const testRed = verdict([{ number: 385, ok: false, why: '合起來之後「考試」紅了：契約標題不是允許的寫法' }]);
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
  return spawnSync(process.execPath, [SCRIPT, pr], {
    encoding: 'utf8', cwd,
    env: { ...env, PATH: `${dir}:${env.PATH}` },
  });
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
 * 造一棵「發起樹」：暫存目錄裡的極小 git repo，**刻意沒有 node_modules**。
 * 帶一顆真 commit（package.json 的三關指令必炸）——這樣萬一先驗被拿掉，
 * 腳本會一路走到真的 worktree＋npm，**原樣重演 #441 的誤報（退出碼 1）**，
 * 考題就用「預期 2 實得 1」把事故直接端到眼前，而不是只靠訊息比對間接推理。
 */
function makeInitiatorRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cross-pr-initiator-'));
  const g = (/** @type {string[]} */ args) => {
    const r = spawnSync('git', args, { encoding: 'utf8', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 0, `fixture git ${args.join(' ')} 失敗：${r.stderr}`);
    return String(r.stdout ?? '').trim();
  };
  g(['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'cross-pr-fixture', version: '0.0.0',
    scripts: { typecheck: 'cross-pr-fixture-no-such-cmd', lint: 'cross-pr-fixture-no-such-cmd', test: 'cross-pr-fixture-no-such-cmd' },
  }));
  g(['add', 'package.json']);
  g(['-c', 'user.email=f@example.com', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  return { dir, sha: g(['rev-parse', 'HEAD']) };
}

test('⭐ CLI｜發起樹沒有 node_modules ＋ 有其他 open PR → exit 2，訊息點名環境（#441 的誤報不可再犯）', () => {
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
      '環境問題被包裝成相容性結論——這道閘的信用就是靠「1 永遠代表真的相斥」撐的');
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

// ⭐ 入口守衛（經過 symlink 的路徑也要真的跑）**移到 `test/entry-guard.test.js`**。
// 原因：這裡原本是**把檔案內容複製**到暫存資料夾再跑，那同時斷言了兩件事——
//   ① 路徑經過 symlink 仍認得出自己是進入點（**真實情境，就是當初那個 bug**）
//   ② 這支檔案可以整支複製出去單獨執行（**從來不是需求**）
// 進入點判斷收攏成 `lib/is-main.js` 之後，②自然不再成立（複製出去的孤兒檔找不到它）。
// 新考題用**真正的 symlink** 驗①，而且一次涵蓋**四支閘**，不是只有這一支。
