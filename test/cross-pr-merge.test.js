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
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { othersToTry, verdict, MERGE_GATE, redDetail, cantRunSignal, CANT_RUN_CAUSES } from '../scripts/check-cross-pr-merge.js';

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
 * 造一棵「發起樹」：暫存目錄裡的極小 git repo。
 * 帶一顆真 commit（package.json 的三關指令預設必炸＝127）——這樣萬一先驗被拿掉，
 * 腳本會一路走到真的 worktree＋npm，**原樣重演 #441 的誤報**，
 * 考題就把事故直接端到眼前，而不是只靠訊息比對間接推理。
 *
 * `nodeModules`：'none'（預設，#441 的形狀）／'dir'（空目錄——先驗放行，換三關的
 * 「執行不起來」分類接手）／'file'（普通檔案——existsSync 會說 true 的那個洞，#446 r1）。
 * `scripts`：換掉三關指令（例如換成「跑得起來、退出碼 1」來演真的紅）。
 * @param {{ nodeModules?: 'none'|'dir'|'file', scripts?: Record<string,string> }} [opts]
 */
function makeInitiatorRepo(opts = {}) {
  const { nodeModules = 'none', scripts } = opts;
  const dir = mkdtempSync(join(tmpdir(), 'cross-pr-initiator-'));
  const g = (/** @type {string[]} */ args) => {
    const r = spawnSync('git', args, { encoding: 'utf8', cwd: dir, env: { ...SANDBOX_ENV } });
    assert.equal(r.status, 0, `fixture git ${args.join(' ')} 失敗：${r.stderr}`);
    return String(r.stdout ?? '').trim();
  };
  g(['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'cross-pr-fixture', version: '0.0.0',
    scripts: scripts ?? { typecheck: 'cross-pr-fixture-no-such-cmd', lint: 'cross-pr-fixture-no-such-cmd', test: 'cross-pr-fixture-no-such-cmd' },
  }));
  g(['add', 'package.json']);
  g(['-c', 'user.email=f@example.com', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  if (nodeModules === 'dir') mkdirSync(join(dir, 'node_modules'));
  if (nodeModules === 'file') writeFileSync(join(dir, 'node_modules'), '這不是目錄\n');
  return { dir, sha: g(['rev-parse', 'HEAD']) };
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
