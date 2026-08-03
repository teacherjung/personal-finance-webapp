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
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { othersToTry, verdict, MERGE_GATE } from '../scripts/check-cross-pr-merge.js';

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
function withFakeGh(viewJson, listJson, { exitCode = 0 } = {}) {
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
  return spawnSync(process.execPath, [SCRIPT, '385'], {
    encoding: 'utf8', cwd: ROOT,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
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

test('⭐ 入口｜**經過 symlink 的路徑也要真的跑**（否則會「什麼都沒做卻 exit 0」）', () => {
  // ⚠️ 2026-08-03 實際踩到，而且是最糟的一種失敗：
  //    macOS 的 `/tmp` 是指向 `/private/tmp` 的 symlink，於是主程式守衛的兩邊對不上，
  //    `main()` **從來沒跑**，而退出碼是 **0**——閘什麼都沒做卻回報「通過」。
  //    **那比閘不存在更危險**：不存在時人還知道要自己看。
  const dir = mkdtempSync(join(tmpdir(), 'symlink-entry-'));   // /var/folders/… 本身就有 symlink
  const copy = join(dir, 'gate.js');
  writeFileSync(copy, readFileSync(join(ROOT, 'scripts/check-cross-pr-merge.js'), 'utf8'));
  const r = spawnSync(process.execPath, [copy], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 2,
    `經過 symlink 的路徑跑起來沒有進 main()（實得 ${r.status}，預期 2＝沒給 PR 編號）。\n`
    + `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /用法/, 'main() 沒有真的執行');
});
