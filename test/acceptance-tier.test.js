// 合併後驗收分級（scripts/acceptance-tier.js）的行為題。
// 為什麼要有：第 8 步的散文清單在 #573 r2 被突變證明「把 public/ 移到不需驗收」全綠——表住程式、這裡釘表。
// 射程：釘的是「代表性路徑組合→級別與動作」與兩條規矩（動作累積、未列到當 C）；路徑家族表本身對不對（哪些
// scripts 啟動時會跑）靠改表的人核對 start.command／render.yaml，這裡只釘現況。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, report, tierOf, RULES, TIERS } from '../scripts/acceptance-tier.js';
import { gatesRunInMergeSteps } from './helpers/merge-gates.js';

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

test('⭐ 啟動會跑的 scripts/check-node-version.js → C；只在合併程序跑的 scripts/check-review-verdicts.js → E', () => {
  assert.equal(tierOf('scripts/check-node-version.js').tier, 'C', 'start.command 每次啟動都跑它，壞了 App 起不來');
  assert.equal(tierOf('scripts/check-review-verdicts.js').tier, 'E');
  assert.equal(tierOf('scripts/grok-scan.js').tier, 'E');
  assert.equal(tierOf('scripts/git-hooks/pre-push').tier, 'E');
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

test('現況對照：目前 repo 追蹤的每一個檔案都落在某一級（沒有未列到的），新家族出現時這題會紅、逼人補表', () => {
  // core.quotePath=false：中文檔名不要被印成八進位逃逸（否則 docs/ 底下的中文 md 全部對不到表）
  const files = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const unknown = files.filter((f) => !tierOf(f).known);
  assert.deepEqual(unknown, [], `這些追蹤檔案沒有級別（會被當 C）：${unknown.slice(0, 10).join('、')}`);
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

test('⭐ 文件｜合併步驟第 8 步要指到這支腳本，而且它不可以被合併閘反查器當成閘（不寫在 bash fence 裡、不自報閘名）', () => {
  const doc = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => /^> 8\.\s/.test(l));
  assert.ok(start >= 0, '找不到第 8 步');
  const end = lines.findIndex((l, i) => i > start && /^> \d+\.\s/.test(l));
  const step = lines.slice(start, end < 0 ? undefined : end).join('\n');
  assert.match(step, /scripts\/acceptance-tier\.js/, '第 8 步沒指到分級腳本——散文清單又會長回來');
  assert.match(step, /動作累積|命中幾級就做幾級/, '第 8 步沒寫「動作累積」——只取最重一級會吃掉其他動作');
  assert.match(step, /一律當「要重啟」|一律當 C/, '第 8 步沒寫未列到的路徑 fail-closed');
  assert.ok(!gatesRunInMergeSteps().some((g) => /acceptance-tier/.test(g)), '分級腳本被合併閘反查器抓到＝它被寫進 bash fence，會被要求自報閘名');
});
