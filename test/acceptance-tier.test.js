// 合併後驗收分級（scripts/acceptance-tier.js）的行為題。
// 為什麼要有：散文清單沒有考題會為它紅（把 public/ 移到不需驗收照樣全綠）——表住程式、這裡釘表。
// 射程：釘的是「代表性路徑組合→級別與動作」、兩條規矩（動作累積、未列到當 C）、gh 讀檔的形狀（分頁、改名）、
// 以及 D 級「重新整理就好」的前提（沒有 service worker）；路徑家族表本身對不對（哪些 scripts 啟動時會跑）
// 靠改表的人核對 start.command／render.yaml，這裡只釘現況。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, report, tierOf, RULES, TIERS, ORDER, prFilesFromApi } from '../scripts/acceptance-tier.js';
import { gatesRunInMergeSteps } from './helpers/merge-gates.js';
import { gitEnv } from '../lib/git-env.js';
import { injectDirtyGitEnv, DIRTY_GIT_ENV } from './helpers/dirty-git-env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/acceptance-tier.js');
const tiers = (/** @type {ReturnType<typeof classify>} */ r) => r.actions.map((a) => a.tier);

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
  const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/f${i}.md` }));
  const page2 = [{ filename: 'lib/x.js' }];
  const paths = prFilesFromApi(JSON.stringify([page1, page2]));
  assert.equal(paths.length, 101);
  assert.equal(classify(paths).level, 'C', '第 101 筆的 lib/ 被漏掉＝只讀前 100 筆的那種假綠');
  const renamed = prFilesFromApi(JSON.stringify([[{ filename: 'docs/x.md', previous_filename: 'lib/x.js' }]]));
  assert.deepEqual(renamed.sort(), ['docs/x.md', 'lib/x.js']);
  assert.equal(classify(renamed).level, 'C', 'lib/ 被改名到 docs/ ＝ runtime 路徑被拿掉，也要當 C');
  for (const bad of ['{}', '[{}]', '[[{"path":"x"}]]', '[[{"filename":""}]]']) assert.throws(() => prFilesFromApi(bad), `${bad} 應該丟`);
});

test('⭐ .codex/hooks.json → F（工具安全設定）：動作是重新按「信任」，不是重啟；只動它時級別是 E 但 F 動作一定印', () => {
  const r = classify(['.codex/hooks.json']);
  assert.equal(r.toolSecurity, true);
  assert.equal(r.level, 'E');
  assert.deepEqual(tiers(r), ['F', 'E']);
  const text = report(['.codex/hooks.json']);
  assert.match(text, /信任/); assert.doesNotMatch(text, /重啟 App/);
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

test('⭐ 現況對照題在髒的 GIT_* 環境下答案仍正確（題①：走了 gitEnv()）', () => {
  const restore = injectDirtyGitEnv();
  try {
    const files = trackedFiles();
    assert.ok(files.some((f) => f === 'server.js'), '髒環境下 git 讀到別的 repo（或空）——清法沒生效');
  } finally { restore(); }
});

test('⭐ 分級腳本交給 gh 的環境裡不可以有任何 GIT_*（題②：假 gh 直接看子行程環境；gh 會自己再去 spawn git）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-gh-env-'));
  try {
    const seen = join(dir, 'seen.txt');
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\nenv | cut -d= -f1 | grep '^GIT_' > "${seen}"; echo called >> "${seen}"; exit 1\n`);
    chmodSync(join(dir, 'gh'), 0o755);
    const r = spawnSync(process.execPath, [SCRIPT, '573'], { encoding: 'utf8', env: { ...process.env, ...DIRTY_GIT_ENV, PATH: `${dir}:${process.env.PATH}` } });
    assert.equal(r.status, 2);
    const lines = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.includes('called'), '假 gh 根本沒被叫到——這題是空轉的');
    const leaked = lines.filter((l) => l !== 'called');
    assert.deepEqual(leaked, [], `分級腳本把這些 GIT_* 原封不動傳給 gh 了：${leaked.join('、')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('表的形狀：每一級都有動作、RULES 只用錨定的正規式（避免子字串誤命中）', () => {
  for (const [k, v] of Object.entries(TIERS)) assert.ok(v.action.length > 10, `${k} 沒有動作`);
  for (const [, re] of RULES) assert.ok(re.source.startsWith('^'), `${re} 沒有錨在開頭`);
});

test('CLI｜--paths 給路徑 → exit 0 印報告；gh 失敗 → exit 2、不猜', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--paths', 'lib/x.js', 'test/x.test.js'], { encoding: 'utf8' });
  assert.equal(ok.status, 0); assert.match(ok.stdout, /驗收分級：C/);
  const dir = mkdtempSync(join(tmpdir(), 'acc-gh-'));
  try {
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 1\n'); chmodSync(join(dir, 'gh'), 0o755);
    const bad = spawnSync(process.execPath, [SCRIPT, '573'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    assert.equal(bad.status, 2, `gh 失敗要退 2（算不出來就說算不出來），實得 ${bad.status}\n${bad.stdout}${bad.stderr}`);
    assert.match(bad.stderr, /算不出來/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});

test('⭐ 文件｜合併步驟「回報合併結果與驗收分級」那一步要指到這支腳本，而且它不可以被合併閘反查器當成閘（不寫在 bash fence 裡、不自報閘名）', () => {
  // 用步驟**名字**找，不用序號：步驟插入後序號會漂，具名引用不會（merge-procedure-docs 的規矩）
  const doc = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => /^> \d+\.\s/.test(l) && /回報\*\*合併結果\*\*與\*\*驗收分級\*\*/.test(l));
  assert.ok(start >= 0, '找不到「回報合併結果與驗收分級」那一步');
  const end = lines.findIndex((l, i) => i > start && /^> \d+\.\s/.test(l));
  const step = lines.slice(start, end < 0 ? undefined : end).join('\n');
  assert.match(step, /scripts\/acceptance-tier\.js/, '那一步沒指到分級腳本——散文清單又會長回來');
  assert.match(step, /動作累積|命中幾級就做幾級/, '那一步沒寫「動作累積」——只取最重一級會吃掉其他動作');
  assert.match(step, /一律當「要重啟」|一律當 C/, '那一步沒寫未列到的路徑 fail-closed');
  assert.ok(!gatesRunInMergeSteps().some((g) => /acceptance-tier/.test(g)), '分級腳本被合併閘反查器抓到＝它被寫進 bash fence，會被要求自報閘名');
});
