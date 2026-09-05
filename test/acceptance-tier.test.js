// 合併後驗收分級（scripts/acceptance-tier.js）的行為題。
// 為什麼要有：散文清單沒有考題會為它紅（把 public/ 移到不需驗收照樣全綠）——表住程式、這裡釘表。
// 射程：釘的是「每一條規則的級別」（RULE_SAMPLES 逐條）、代表性路徑組合→級別與動作、規矩（動作累積、未列到當 C、B 連帶 C、只 F 寫 F）、
// gh 讀檔的形狀（分頁、改名、檔數對不上、站台與 repo 身分釘在 origin、正式呼叫逐 token 釘旗標）、每個會 spawn 子行程的呼叫點各兩種 GIT_* 題、
// 以及 D 級「重新整理就好」的前提（沒有 service worker）；路徑家族表本身對不對（哪些 scripts 啟動時會跑）
// 靠改表的人核對 start.command／render.yaml，這裡只釘現況。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, report, tierOf, originRepo, RULES, TIERS, ORDER, prFilesFromApi } from '../scripts/acceptance-tier.js';
import { gatesRunInMergeSteps } from './helpers/merge-gates.js';
import { gitEnv } from '../lib/git-env.js';
import { injectDirtyGitEnv, DIRTY_GIT_ENV, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/acceptance-tier.js');
const tiers = (/** @type {ReturnType<typeof classify>} */ r) => r.actions.map((a) => a.tier);
/** gh 檔案物件的最小合法形狀（真 API 一定帶 status）。 @param {number} n @param {string} prefix */
const page = (n, prefix) => Array.from({ length: n }, (_, i) => ({ filename: `${prefix}${i}.md`, status: 'modified' }));

/**
 * 假 gh：每次被叫到就把 argv **逐 token**（tab 分隔、一行一次呼叫）記下來、並記看到的 GIT_*。
 * 回什麼**依旗標**決定，模擬真 gh 的契約：`pr view … --json changedFiles --jq .changedFiles` 才回 view；
 * `api` 要同時帶 `--paginate` 與 `--slurp` 才回 api（真 gh 少了 --paginate 只給第一頁、少了 --slurp 外層不是頁陣列）——
 * 少任何一個就 exit 1，所以正式碼掉旗標會紅（#573 r5）。
 * failOnGitEnv＝模擬真 gh 被髒 GIT_DIR 弄壞：環境裡只要有 GIT_* 就 exit 1（題①用）。
 * @param {{view?: string, api?: string, failOnGitEnv?: boolean, cwd?: string, env?: Record<string, string>}} o
 * @param {(x: {r: ReturnType<typeof spawnSync>, calls: string[][], seen: string[]}) => void} fn
 */
function withFakeGh({ view, api, failOnGitEnv = false, cwd = ROOT, env = {} }, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'acc-gh-'));
  try {
    if (view !== undefined) writeFileSync(join(dir, 'view.json'), view);
    if (api !== undefined) writeFileSync(join(dir, 'api.json'), api);
    writeFileSync(join(dir, 'gh'), [
      '#!/bin/sh',
      `{ for a in "$@"; do printf '%s\\t' "$a"; done; printf '\\n'; } >> ${JSON.stringify(join(dir, 'argv.txt'))}`,
      `{ echo CALLED; env | cut -d= -f1 | grep '^GIT_'; } >> ${JSON.stringify(join(dir, 'seen.txt'))}`,
      failOnGitEnv ? "if env | grep -q '^GIT_'; then exit 1; fi" : ':',
      'has() { for a in "$@"; do [ "$a" = "$want" ] && return 0; done; return 1; }',
      `if [ "$1" = pr ] && [ "$2" = view ] && [ -f ${JSON.stringify(join(dir, 'view.json'))} ]; then`,
      '  want=--json; has "$@" || exit 1; want=changedFiles; has "$@" || exit 1; want=.changedFiles; has "$@" || exit 1',
      `  cat ${JSON.stringify(join(dir, 'view.json'))}; exit 0; fi`,
      `if [ "$1" = api ] && [ -f ${JSON.stringify(join(dir, 'api.json'))} ]; then`,
      '  want=--paginate; has "$@" || exit 1; want=--slurp; has "$@" || exit 1',
      `  cat ${JSON.stringify(join(dir, 'api.json'))}; exit 0; fi`,
      'exit 1',
      '',
    ].join('\n'));
    chmodSync(join(dir, 'gh'), 0o755);
    const r = spawnSync(process.execPath, [SCRIPT, '573'], { cwd, encoding: 'utf8', env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` } });
    const read = (/** @type {string} */ f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean) : []);
    const calls = read('argv.txt').map((l) => l.split('\t').filter(Boolean));
    fn({ r, calls, seen: read('seen.txt') });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('純 D（只動 public/）→ D，動作只有重新整理、沒有重啟', () => {
  const r = classify(['public/app.js', 'public/index.html']);
  assert.equal(r.level, 'D');
  assert.deepEqual(tiers(r), ['D']);
  assert.doesNotMatch(report(['public/app.js']), /重啟 App/);
});

test('D＋E（public/ 伴隨考題與文件）→ 仍是 D：伴隨的考題／文件不改變級別', () => {
  const r = classify(['public/modules/x.js', 'test/x.test.js', 'docs/contracts/frontend-features.md']);
  assert.equal(r.level, 'D');
  assert.deepEqual(tiers(r), ['D'], '伴隨的 E 不該多出動作、也不該把 D 拉低');
});

test('⭐ A＋B＋C（db/＋package-lock＋lib/）→ 回報 A，但動作要三件都做（累積，不是只取最重）', () => {
  const r = classify(['db/supabase-schema.sql', 'package-lock.json', 'lib/store-pg.js']);
  assert.equal(r.level, 'A');
  assert.deepEqual(tiers(r), ['A', 'B', 'C'], '只取最重一級會把裝相依與重啟吃掉（#573 r2 High①）');
  const text = report(['db/supabase-schema.sql', 'package-lock.json', 'lib/store-pg.js']);
  assert.match(text, /SQL Editor/); assert.match(text, /npm install/); assert.match(text, /重啟 App/);
});

test('⭐ 只動 package-lock.json → 回報 B，但 C 的動作一定連帶列出（「裝完做 C」不可以是沒展開的指示）', () => {
  const r = classify(['package-lock.json']);
  assert.equal(r.level, 'B');
  assert.deepEqual(tiers(r), ['B', 'C'], '執行者照輸出做：沒印 C 的核心流程就等於叫他裝完不重啟（#573 r4）');
  assert.match(report(['package-lock.json']), /重啟 App/);
});

test('⭐ 每一條規則的級別逐條釘住：多一條規則、或把任何一條換到別級（例：render.yaml C→E），這題要紅', () => {
  /** 與 RULES **同序**，每條一個代表路徑；新增規則就得在這裡補一行（長度對不上就紅）。 @type {[string, string][]} */
  const RULE_SAMPLES = [
    ['F', '.codex/hooks.json'], ['F', '.claude/settings.json'],
    ['A', 'db/supabase-schema.sql'],
    ['B', 'package-lock.json'],
    ['C', 'lib/store.js'], ['C', 'server.js'], ['C', 'start.command'], ['C', '.node-version'], ['C', 'render.yaml'],
    ['C', 'data/seed.json'], ['C', 'scripts/check-node-version.js'],
    ['D', 'public/app.js'], ['D', 'public-site/index.html'],
    ['P', 'prototype/forest-ui-lab/index.html'],
    ['E', 'test/x.test.js'], ['E', 'test-doubles/x.js'], ['E', 'docs/contracts/README.md'], ['E', 'AGENTS.md'], ['E', '.github/workflows/ci.yml'],
    ['E', 'scripts/grok-scan.js'], ['E', 'scripts/grok-sandbox.sb'], ['E', 'scripts/git-hooks/pre-push'], ['E', 'eslint.config.js'], ['E', '.claude/launch.json'],
  ];
  assert.equal(RULE_SAMPLES.length, RULES.length, 'RULES 與 RULE_SAMPLES 條數不同——新增／刪除規則要同步這張表');
  RULE_SAMPLES.forEach(([tier, sample], i) => {
    assert.ok(RULES[i][1].test(sample), `第 ${i + 1} 條 ${RULES[i][1]} 對不上樣本 ${sample}——兩張表的順序漂了`);
    assert.equal(RULES[i][0], tier, `第 ${i + 1} 條（${sample}）的級別被換成 ${RULES[i][0]}，釘的是 ${tier}`);
    assert.equal(tierOf(sample).tier, tier, `${sample} 被更上面的規則先攔走了`);
  });
  assert.equal(tierOf('package.json').tier, 'B');
});

test('⭐ 啟動會跑的 scripts/check-node-version.js → C；只在合併程序跑的 scripts/check-review-verdicts.js → E；scripts/ 裡沒點名的新腳本 → 未知（當 C），不因為叫 check-* 就免驗', () => {
  assert.equal(tierOf('scripts/check-node-version.js').tier, 'C', 'start.command 每次啟動都跑它，壞了 App 起不來');
  assert.equal(tierOf('scripts/check-review-verdicts.js').tier, 'E');
  assert.equal(tierOf('scripts/grok-scan.js').tier, 'E');
  assert.equal(tierOf('scripts/git-hooks/pre-push').tier, 'E');
  const fresh = tierOf('scripts/check-runtime-health.js');
  assert.deepEqual(fresh, { tier: 'C', known: false }, 'E 的腳本必須是明確名單——寬鬆的 check-* 會把未來被啟動流程掛上的新腳本靜靜當成不需驗收（#573 r3）');
});

test('⭐ 回報級別的順序是固定的：同重的 D 與 P 不看路徑順序（permutation 同答案）', () => {
  const a = classify(['public/x.js', 'prototype/x.html']);
  const b = classify(['prototype/x.html', 'public/x.js']);
  assert.equal(a.level, b.level, `同一組路徑換順序答案不同：${a.level} vs ${b.level}`);
  assert.equal(a.level, ORDER.find((t) => t === 'D' || t === 'P'));
  assert.deepEqual(a.actions.map((x) => x.tier), b.actions.map((x) => x.tier));
});

test('⭐ D 級「重新整理就好」的前提：public/ 與 public-site/ 沒有 service worker——有人加了註冊，這題要紅、逼人改 D 的動作', () => {
  const out = spawnSync('grep', ['-rl', '-e', 'serviceWorker', '-e', 'sw.js', join(ROOT, 'public'), join(ROOT, 'public-site')], { encoding: 'utf8' });
  assert.ok(out.status === 0 || out.status === 1, `grep 自己失敗了（${out.stderr}）——這題不能在掃不到目錄時靜靜通過`);
  const hits = out.stdout.split('\n').filter(Boolean);
  assert.deepEqual(hits, [], `前端出現 service worker 的跡象：${hits.join('、')}——「重新整理就好」不再成立，D 級的動作要改`);
});

test('⭐ gh 讀檔：分頁全拿（第 101 筆是 lib/ 也要算到）、改名要把舊路徑也算進去、形狀不對就丟', () => {
  const paths = prFilesFromApi(JSON.stringify([page(100, 'docs/f'), [{ filename: 'lib/x.js', status: 'modified' }]]));
  assert.equal(paths.length, 101);
  assert.equal(classify(paths).level, 'C', '第 101 筆的 lib/ 被漏掉＝只讀前 100 筆的那種假綠');
  const renamed = prFilesFromApi(JSON.stringify([[{ filename: 'docs/x.md', status: 'renamed', previous_filename: 'lib/x.js' }]]));
  assert.deepEqual(renamed.sort(), ['docs/x.md', 'lib/x.js']);
  assert.equal(classify(renamed).level, 'C', 'lib/ 被改名到 docs/ ＝ runtime 路徑被拿掉，也要當 C');
  assert.deepEqual(prFilesFromApi(JSON.stringify([[{ filename: 'docs/y.md', status: 'copied', previous_filename: 'docs/x.md' }]])).sort(), ['docs/x.md', 'docs/y.md']);
  const bad = {
    '{}': '外層不是陣列', '[{}]': '頁不是陣列', '[[{"path":"x","status":"modified"}]]': '缺 filename', '[[{"filename":"","status":"modified"}]]': 'filename 空',
    '[[{"filename":"lib/x.js"}]]': '缺 status', '[[{"filename":"docs/new.md","status":"renamed"}]]': 'renamed 沒有 previous_filename（舊路徑若是 lib/ 就漏了）',
    '[[{"filename":"docs/new.md","status":"renamed","previous_filename":7}]]': 'previous_filename 不是字串', '[[{"filename":"docs/new.md","status":"modified","previous_filename":""}]]': 'previous_filename 空字串',
  };
  for (const [json, why] of Object.entries(bad)) assert.throws(() => prFilesFromApi(json), `${why}：${json} 應該丟`);
});

test('⭐ gh 讀檔：筆數要對得上 PR 自報的檔數——這個端點最多只回 3000 筆，對不上＝清單不完整，丟；對得上才算', () => {
  const thirtyPages = JSON.stringify(Array.from({ length: 30 }, (_, p) => page(100, `docs/p${p}-f`)));
  assert.throws(() => prFilesFromApi(thirtyPages, { expectEntries: 3001 }), /不完整|對不上/);
  assert.equal(prFilesFromApi(thirtyPages, { expectEntries: 3000 }).length, 3000);
  assert.throws(() => prFilesFromApi(JSON.stringify([page(2, 'docs/f')]), { expectEntries: 3 }), /對不上/);
  assert.throws(() => prFilesFromApi(JSON.stringify([page(2, 'docs/f')]), { expectEntries: Number.NaN }), /不是整數/);
  assert.equal(prFilesFromApi(JSON.stringify([page(2, 'docs/f')]), { expectEntries: 2 }).length, 2);
});

test('⭐ CLI｜PR 自報 3001 筆、API 只回得了 3000 筆（第 3001 筆若是 lib/ 就漏了）→ exit 2、不猜；對得上 → exit 0', () => {
  const thirtyPages = JSON.stringify(Array.from({ length: 30 }, (_, p) => page(100, `docs/p${p}-f`)));
  withFakeGh({ view: '3001\n', api: thirtyPages }, ({ r }) => {
    assert.equal(r.status, 2, `殘缺清單算出來的級別不可信，實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /算不出來/);
  });
  withFakeGh({ view: '3000\n', api: thirtyPages }, ({ r }) => { assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /驗收分級：E/); });
  withFakeGh({ view: 'null\n', api: thirtyPages }, ({ r }) => assert.equal(r.status, 2, 'gh 回的檔數不是整數也要退 2'));
});

/** 夾具 repo：只有 origin、沒有 commit（本題只看身分怎麼解）。 @param {string} url */
function fixtureRepo(url) {
  const dir = mkdtempSync(join(tmpdir(), 'acc-origin-'));
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', url]]) {
    const g = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv() });
    assert.equal(g.status, 0, `夾具 git ${args.join(' ')} 失敗：${g.stderr}`);
  }
  return dir;
}

test('⭐ originRepo｜站台與 owner/repo 都從 origin 解（https／ssh／scp 三種寫法），解不出來就丟、不猜', () => {
  for (const url of ['https://github.com/acme/widgets.git', 'https://github.com/acme/widgets', 'git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets.git']) {
    const dir = fixtureRepo(url);
    try { assert.deepEqual(originRepo(dir), { host: 'github.com', slug: 'acme/widgets' }, url); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const ghes = fixtureRepo('https://ghe.example.com/acme/widgets.git');
  try { assert.equal(originRepo(ghes).host, 'ghe.example.com', '企業站的 origin 就釘企業站，不偷換成 github.com'); } finally { rmSync(ghes, { recursive: true, force: true }); }
  assert.throws(() => originRepo(tmpdir()), '不在 repo 裡要丟，不可以回一個猜的身分');
  assert.deepEqual(originRepo(ROOT), { host: 'github.com', slug: 'teacherjung/personal-finance-webapp' });
});

test('⭐ CLI｜正式呼叫逐 token 釘旗標，站台與 repo 都明講：GH_REPO、GH_HOST 一起塞也導不走（否則別站／別 repo 的同號 PR 剛好是純文件就錯報 E）', () => {
  const dir = fixtureRepo('https://github.com/acme/widgets.git');
  try {
    withFakeGh({ view: '1\n', api: JSON.stringify([[{ filename: 'lib/x.js', status: 'modified' }]]), cwd: dir, env: { GH_REPO: 'cli/cli', GH_HOST: 'example.com' } }, ({ r, calls }) => {
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /驗收分級：C/);
      assert.deepEqual(calls, [
        ['pr', 'view', '573', '-R', 'github.com/acme/widgets', '--json', 'changedFiles', '--jq', '.changedFiles'],
        ['api', '--paginate', '--slurp', '--hostname', 'github.com', 'repos/acme/widgets/pulls/573/files?per_page=100'],
      ], '兩次呼叫的每一個 token 都要對：少 --paginate 只拿到第一頁、少 --slurp 形狀不對、少站台就被 GH_HOST 導走、-R 沒帶站台也一樣');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⭐ .codex/hooks.json → F（工具安全設定）：只動它時級別就是 F、動作只有 F（不是「E 不需驗收」＋F 的自相矛盾）；F＋E → E 且 F 動作一定印', () => {
  const r = classify(['.codex/hooks.json']);
  assert.equal(r.toolSecurity, true);
  assert.equal(r.level, 'F');
  assert.deepEqual(tiers(r), ['F'], 'E 沒被路徑命中就不可以列 E 的動作（#573 r4）');
  const text = report(['.codex/hooks.json']);
  assert.match(text, /驗收分級：F/); assert.match(text, /信任/); assert.doesNotMatch(text, /重啟 App/); assert.doesNotMatch(text, /不需驗收/);
  const fe = classify(['.claude/settings.json', 'AGENTS.md']);
  assert.equal(fe.level, 'E'); assert.deepEqual(tiers(fe), ['F', 'E']);
  assert.match(report(['.claude/settings.json', 'AGENTS.md']), /另有 F/);
  assert.equal(classify(['.claude/settings.json', 'lib/x.js']).toolSecurity, true);
});

test('⭐ 未列到的路徑 → 當 C（fail-closed）並列出來，報告要說怎麼補表', () => {
  const r = classify(['some-new-dir/thing.txt']);
  assert.equal(r.level, 'C');
  assert.deepEqual(r.unknown, ['some-new-dir/thing.txt']);
  const text = report(['some-new-dir/thing.txt']);
  assert.match(text, /未列到.*一律當 C/); assert.match(text, /RULES/);
});

test('prototype/ → P：開原型自己的預覽，不重啟理財 App；全 E → E「不需驗收」', () => {
  assert.equal(classify(['prototype/forest-ui-lab/index.html']).level, 'P');
  assert.match(report(['prototype/x.html']), /原型自己的預覽/);
  assert.doesNotMatch(report(['prototype/x.html']), /重啟 App/);
  const e = classify(['test/a.test.js', 'AGENTS.md', '.github/workflows/ci.yml', 'eslint.config.js', 'test-doubles/x.js', '.claude/launch.json']);
  assert.equal(e.level, 'E'); assert.deepEqual(tiers(e), ['E']);
  assert.match(report(['AGENTS.md']), /不需驗收/);
});

/** 追蹤檔清單：走 gitEnv()、先驗子行程成功再解析（git 讀不到 repo 時不可以把空輸出當成「零檔案」而全綠——#573 r3）。 */
function trackedFiles() {
  // core.quotePath=false：中文檔名不要被印成八進位逃逸（否則 docs/ 底下的中文 md 全部對不到表）
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files'], { cwd: ROOT, encoding: 'utf8', env: gitEnv() });
  assert.equal(r.status, 0, `git ls-files 失敗（${r.stderr}）——這題不能在 git 讀不到 repo 時靜靜通過`);
  const files = r.stdout.split('\n').filter(Boolean);
  assert.ok(files.length > 50, `追蹤檔只有 ${files.length} 個——不像這個 repo，git 可能讀到別的地方`);
  return files;
}

test('現況對照：目前 repo 追蹤的每一個檔案都落在某一級（沒有未列到的），新家族出現時這題會紅、逼人補表', () => {
  const unknown = trackedFiles().filter((f) => !tierOf(f).known);
  assert.deepEqual(unknown, [], `這些追蹤檔案沒有級別（會被當 C）：${unknown.slice(0, 10).join('、')}`);
});

// ── 每一個會 spawn 子行程的呼叫點（考題的 trackedFiles()、正式碼的 originRepo() 與它叫的 gh），各兩種 GIT_* 題
//    （test/git-env.test.js 檔頭的規矩；射程對照在 test/helpers/dirty-git-env.js）──
test('⭐ trackedFiles｜題①：髒 GIT_* 環境下答案仍正確', () => {
  const restore = injectDirtyGitEnv();
  try {
    assert.ok(trackedFiles().some((f) => f === 'server.js'), '髒環境下 git 讀到別的 repo（或空）——清法沒生效');
  } finally { restore(); }
});

test('⭐ trackedFiles｜題②：假 git 直接看子行程環境，不可以有任何 GIT_*', () => {
  assertChildGitEnvClean(assert, 'acceptance-tier 考題的 trackedFiles()', () => trackedFiles());
});

test('⭐ originRepo｜題①：髒 GIT_* 環境下仍解出本 repo', () => {
  const restore = injectDirtyGitEnv();
  try { assert.equal(originRepo(ROOT).slug, 'teacherjung/personal-finance-webapp'); } finally { restore(); }
});

test('⭐ originRepo｜題②：假 git 直接看子行程環境，不可以有任何 GIT_*', () => {
  assertChildGitEnvClean(assert, 'scripts/acceptance-tier.js 的 originRepo()', () => originRepo(ROOT));
});

test('⭐ 分級腳本交給 gh｜題①：髒 GIT_* 環境＋一支會被 GIT_* 弄壞的 gh → 仍 exit 0、級別正確', () => {
  withFakeGh({ view: '1\n', api: JSON.stringify([[{ filename: 'lib/x.js', status: 'modified' }]]), failOnGitEnv: true, env: { ...DIRTY_GIT_ENV } }, ({ r, seen }) => {
    assert.ok(seen.includes('CALLED'), '假 gh 根本沒被叫到——這題是空轉的');
    assert.equal(r.status, 0, `gh 收到髒環境被弄壞了：${r.stderr}`);
    assert.match(r.stdout, /驗收分級：C/);
  });
});

test('⭐ 分級腳本交給 gh｜題②：假 gh 直接看子行程環境，不可以有任何 GIT_*（gh 會自己再去 spawn git）', () => {
  withFakeGh({ env: { ...DIRTY_GIT_ENV } }, ({ r, seen }) => {
    assert.equal(r.status, 2);
    assert.ok(seen.includes('CALLED'), '假 gh 根本沒被叫到——這題是空轉的');
    const leaked = seen.filter((l) => l !== 'CALLED');
    assert.deepEqual(leaked, [], `分級腳本把這些 GIT_* 原封不動傳給 gh 了：${leaked.join('、')}`);
  });
});

test('表的形狀：每一級都有動作、RULES 只用錨定的正規式（避免子字串誤命中）', () => {
  for (const [k, v] of Object.entries(TIERS)) assert.ok(v.action.length > 10, `${k} 沒有動作`);
  for (const [, re] of RULES) assert.ok(re.source.startsWith('^'), `${re} 沒有錨在開頭`);
});

test('CLI｜--paths 給路徑 → exit 0 印報告；gh 失敗 → exit 2、不猜；沒參數 → exit 2', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--paths', 'lib/x.js', 'test/x.test.js'], { encoding: 'utf8' });
  assert.equal(ok.status, 0); assert.match(ok.stdout, /驗收分級：C/);
  withFakeGh({}, ({ r }) => {
    assert.equal(r.status, 2, `gh 失敗要退 2（算不出來就說算不出來），實得 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /算不出來/);
  });
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});

test('⭐ 文件｜合併步驟「回報合併結果與驗收分級」那一步要指到這支腳本，而且它不可以被合併閘反查器當成閘（不寫在 bash fence 裡、不自報閘名）；PR 模板只指路、不抄任何一級', () => {
  // 用步驟**名字**找，不用序號：步驟插入後序號會漂，具名引用不會（merge-procedure-docs 的規矩）
  const doc = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => /^> \d+\.\s/.test(l) && /回報\*\*合併結果\*\*與\*\*驗收分級\*\*/.test(l));
  assert.ok(start >= 0, '找不到「回報合併結果與驗收分級」那一步');
  const end = lines.findIndex((l, i) => i > start && /^> \d+\.\s/.test(l));
  const step = lines.slice(start, end < 0 ? undefined : end).join('\n');
  assert.match(step, /scripts\/acceptance-tier\.js/, '那一步沒指到分級腳本——散文清單又會長回來');
  assert.match(step, /照它印的動作做/, '那一步要叫執行者照腳本印的做');
  // 只指路、不抄副本：規矩與家族清單只住腳本（#573 r5——同一句先說只住腳本、接著又抄一遍＝第二份會漂的副本）
  assert.doesNotMatch(step, /動作累積|最重|一律當|db\/|package-lock|命中幾級/, '那一步又在抄分級的算法或家族清單——只准指到腳本');
  assert.ok(!gatesRunInMergeSteps().some((g) => /acceptance-tier/.test(g)), '分級腳本被合併閘反查器抓到＝它被寫進 bash fence，會被要求自報閘名');
  const tpl = readFileSync(join(ROOT, '.github/pull_request_template.md'), 'utf8');
  const section = tpl.slice(tpl.indexOf('## 怎麼驗收'), tpl.indexOf('### Grok 複審後掃'));
  assert.match(section, /scripts\/acceptance-tier\.js/, 'PR 模板沒指到分級腳本');
  assert.doesNotMatch(section, /只動 E 級|取最重|由上往下|E 級：|不需驗收/, 'PR 模板又在抄級名、分級表或算法（#573 r4／r5）——只准指路');
});
