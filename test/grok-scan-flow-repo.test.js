// @ts-check
// `grok-scan.js` 掃別的倉庫（`--repo`）、沒有相依的倉庫跳過 node_modules、紀錄寫掃哪個倉庫與程式版本、明確指定最強模型與最高推理
// （同族之一；理財接手 Grok 掃描交接，Fable 2026-10-11 代裁；William 2026-10-05「先借用試試看」、2026-10-04 常設指示「Grok掃描也請用最強模型、最高推理能力」）。
//
// 守得到的：
// ・建盒子之前的檢查（CI 也跑得到）：--repo 空的／以 - 開頭／找不到／不是資料夾／不是 git 倉庫／是倉庫的子資料夾＝退 2、⛔、訊息裡沒有路徑；
//   --repo 與考題注入的倉庫同時給＝退 2；base／head 不在要掃的倉庫＝退 2；受審版本提交了 node_modules（捷徑）＝退 2；
//   沒有 node_modules 而 package.json 宣告了任何一種相依＝退 2、沒宣告或沒有 package.json＝過（打包選項的布林不算宣告）；package.json 壞掉、是陣列＝退 2；
//   有 node_modules 時也讀 package.json：壞掉、是陣列、相依名稱形狀認不得（往上走、多一層斜線）＝退 2；requiredDeps、isSafeDepName 的單元題；
//   設定 strongest／maxEffort 缺、形狀不對、以 - 開頭＝退 2；相對路徑照目前資料夾解析；
//   遠端網址只留 owner/name（夾在網址裡的權杖、本機路徑都不出現）；指令列 --repo=… 與給兩次＝退 2；
//   結構題：沙箱參數只有那三組（要掃的倉庫進不去）、每一個 git 呼叫都清環境、指令列把 repo 傳進 runScan、不傳 deps；
//   GIT_DIR 指到別的倉庫時：建盒前的檢查仍查 --repo 那一個、考題自己設 diff 驅動寫進要寫的倉庫而別的倉庫設定不變；
//   結構題：這一族考題與夾具的每一個 git 呼叫都帶乾淨環境（#675 r1 Codex：考題的 git 呼叫跟著 GIT_DIR 寫到別的倉庫）。
// ・套得上沙箱的 macOS 才跑：沒有相依的倉庫整條走到退 0；假 grok 收到的參數有 --model <設定的最強模型> --reasoning-effort <設定的最高推理>；
//   配方聲明與 launch.json 寫了受掃倉庫、指定模型、推理、掃描程式的雜湊；沙箱參數裡沒有要掃的倉庫路徑；
//   node_modules 捷徑指到不叫 node_modules 的資料夾＝退 2、結果包不留；相依已備齊、沒有 ESLint 的倉庫建得出盒子（不在 node_modules 那步退）；
//   node_modules 是空的而 package.json 宣告了相依＝退 2、結果包不留，零相依的空 node_modules 不擋（#675 r2 Codex）。
// ⚠️ 守不到的：真的 grok 收到 --model／--reasoning-effort 之後實際用了哪一個（假 grok 只回聲參數；真的那一半看正式掃描的配方聲明「指定模型」與「模型」兩格）。
// ⚠️ 守不到的：盒子裡 node_modules 第一層跟來源對不上那一道——cp 退 0 卻少複製的情形造不出來，沒有考題（cp 退非 0 那一道有）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { GROK_WALL_MS, declaresDeps, isSafeDepName, repoLabelFrom, requiredDeps, runScan } from '../scripts/grok-scan.js';
import { CLEAN_ENV, ROOT, SANDBOX_OK, SKIP_AFTER_CANARY, cleanupTempRoots, fakeGrok, fakeRelay, isolated, keep, promptFile, quiet, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);

const SETTINGS = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8')).scanner;
/** 停在 grok 雜湊那一步（建盒子之後、沙箱之前）：建盒前的檢查都過了才會走到這裡，而這一步在 CI 也跑得到 */
const STOP_AT_HASH = { expectedSha256: '0'.repeat(64) };
const run = async (/** @type {Record<string, unknown>} */ args, /** @type {Record<string, unknown>} */ deps = {}) => {
  /** @type {string[]} */ const logs = [];
  const r = await runScan(/** @type {any} */ ({ promptFile: promptFile(), ...args }), /** @type {any} */ ({ log: (/** @type {string} */ m) => logs.push(m), ...isolated(), ...withGrok(fakeGrok()), ...STOP_AT_HASH, ...deps }));
  return { ...r, logs, text: r.summary.join('\n') };
};
const passedPreBox = (/** @type {{ logs: string[] }} */ r) => r.logs.some((l) => l.startsWith('（受掃倉庫：'));
/** 在倉庫裡設一個 diff 驅動（textconv 與外部 diff 都指到 tool）；git 帶夾具從零組的環境（鐵則 11：GIT_DIR 會讓 -C 失效、寫到別的倉庫——#675 r1 Codex 實測） */
const plantDiffDriver = (/** @type {string} */ dir, /** @type {string} */ tool) => {
  for (const k of ['textconv', 'command']) execFileSync('git', ['-C', dir, 'config', `diff.probe.${k}`, tool], { env: CLEAN_ENV });
};
/** 暫時把 GIT_DIR 指到別的倉庫（模擬從連結工作樹推送時 pre-push 的環境），做完一定還原 */
const withGitDirPointingAt = async (/** @type {string} */ gitDir, /** @type {() => unknown} */ fn) => {
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = gitDir;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
};

test('--repo：空的、以 - 開頭＝退 2、⛔，訊息裡沒有路徑', async () => {
  const repo = tinyRepo();
  for (const v of ['', '-x', '--base']) {
    const r = await run({ base: repo.base, head: repo.head, repo: v });
    assert.equal(r.code, 2, `--repo ${JSON.stringify(v)}：${r.text}`);
    assert.match(r.text, /⛔ --repo 後面要接要掃的倉庫路徑/);
    assert.ok(!passedPreBox(r));
  }
});

test('--repo：找不到、不是資料夾、不是 git 倉庫、倉庫的子資料夾＝退 2，訊息只寫原因不寫路徑', async () => {
  const repo = tinyRepo();
  const plain = keep(mkdtempSync(join(tmpdir(), 'not-a-repo-')));
  const file = join(plain, 'a-file.txt'); writeFileSync(file, 'x');
  const sub = join(repo.dir, 'sub'); mkdirSync(sub);
  const cases = [
    [join(plain, 'nope'), /要掃的倉庫找不到（ENOENT）/],
    [file, /要掃的倉庫不是資料夾/],
    [plain, /要掃的路徑不是 git 倉庫/],
    [sub, /要掃的路徑不是倉庫的根目錄/],
  ];
  for (const [p, re] of /** @type {[string, RegExp][]} */ (cases)) {
    const r = await run({ base: repo.base, head: repo.head, repo: p });
    assert.equal(r.code, 2, `${p}：${r.text}`);
    assert.match(r.text, re);
    assert.ok(!r.text.includes(p) && !r.text.includes(basename(plain)), `訊息裡出現了路徑：${r.text}`);
    assert.ok(!passedPreBox(r));
  }
});

test('--repo 相對路徑照目前資料夾解析；跟考題注入的倉庫同時給＝退 2', async () => {
  const repo = tinyRepo();
  const cwd = process.cwd();
  try {
    process.chdir(dirname(repo.dir));
    const r = await run({ base: repo.base, head: repo.head, repo: basename(repo.dir) });
    assert.ok(passedPreBox(r), `相對路徑沒過建盒前的檢查：${r.text}`);
    assert.equal(r.code, 2);
    assert.match(r.text, /sha256 不符/, '應該停在 grok 雜湊那一步（建盒前的檢查都過了）');
  } finally { process.chdir(cwd); }
  const both = await run({ base: repo.base, head: repo.head, repo: repo.dir }, { repo: repo.dir });
  assert.equal(both.code, 2);
  assert.match(both.text, /--repo 與考題注入的倉庫同時給了/);
});

test('base／head 不在要掃的倉庫裡＝退 2（建盒前）', async () => {
  const a = tinyRepo(); const b = tinyRepo({ firstCommitFiles: { 'only-in-b.txt': 'b\n' } });   // 內容要不同：一樣的內容與時間會算出同一顆提交
  assert.notEqual(a.head, b.head); assert.notEqual(a.base, b.base);
  const r1 = await run({ base: a.base, head: b.head, repo: a.dir });
  assert.equal(r1.code, 2); assert.match(r1.text, /⛔ head（[0-9a-f]{12}）不在要掃的倉庫裡/);
  const r2 = await run({ base: b.base, head: a.head, repo: a.dir });
  assert.equal(r2.code, 2); assert.match(r2.text, /⛔ base（[0-9a-f]{12}）不在要掃的倉庫裡/);
});

test('受審版本把 node_modules（捷徑）提交進去＝退 2（建盒前，不讓父程序往盒子裡的捷徑複製）', async () => {
  const repo = tinyRepo({ commitNodeModulesLink: true });
  const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
  assert.equal(r.code, 2);
  assert.match(r.text, /受審版本把 node_modules 提交進去了/);
  assert.ok(!passedPreBox(r));
});

test('沒有 node_modules：沒有 package.json、相依全空＝過；宣告了任何一種相依、package.json 壞掉或是陣列＝退 2', async () => {
  for (const [label, pkg] of /** @type {[string, string | undefined][]} */ ([['沒有 package.json', undefined], ['相依全空', '{"name":"k","dependencies":{},"devDependencies":{},"bundledDependencies":[]}'],
    ['打包選項 false（bundleDependencies）', '{"bundleDependencies":false}'], ['打包選項 false（別名 bundledDependencies）', '{"bundledDependencies":false}'], ['打包選項 true、沒有相依', '{"bundleDependencies":true}']])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: pkg });
    const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
    assert.ok(passedPreBox(r), `${label}：沒過建盒前的檢查：${r.text}`);
    assert.match(r.text, /sha256 不符/, label);
  }
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const repo = tinyRepo({ nodeModules: false, packageJson: JSON.stringify({ [k]: { x: '1' }, bundleDependencies: false }) });
    const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
    assert.equal(r.code, 2, k); assert.match(r.text, /宣告了相依套件、卻沒有 node_modules/, k);
  }
  for (const [label, body, re] of /** @type {[string, string, RegExp][]} */ ([['壞掉', '{', /不是合法的 JSON/], ['陣列', '[]', /不是一個物件/]])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: body });
    const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
    assert.equal(r.code, 2, label); assert.match(r.text, re, label);
  }
});

test('declaresDeps：空物件、空陣列不算；有內容就算', () => {
  assert.equal(declaresDeps({}), false);
  assert.equal(declaresDeps({ dependencies: {}, bundleDependencies: [] }), false);
  assert.equal(declaresDeps({ bundleDependencies: ['a'] }), true);
  assert.equal(declaresDeps({ peerDependencies: { a: '1' } }), true);
  assert.equal(declaresDeps({ devDependencies: 'weird' }), true, '形狀怪的不當成沒有');
  for (const k of ['bundleDependencies', 'bundledDependencies']) {
    for (const b of [false, true]) assert.equal(declaresDeps({ [k]: b }), false, `${k}: ${b} 是打包選項、不宣告套件`);
    assert.equal(declaresDeps({ [k]: false, dependencies: { a: '1' } }), true, `${k}: false 搭配真正的相依仍算`);
  }
  assert.equal(declaresDeps({ dependencies: false }), true, '不是打包那兩欄的布林照舊不當成沒有');
});

test('requiredDeps：dependencies 與 devDependencies 的名字（去重）；optional、peer、打包欄、形狀怪的不列', () => {
  assert.deepEqual(requiredDeps({ dependencies: { a: '1', '@s/b': '1' }, devDependencies: { a: '2', c: '1' }, optionalDependencies: { o: '1' }, peerDependencies: { p: '1' }, bundleDependencies: ['a'] }), ['a', '@s/b', 'c']);
  assert.deepEqual(requiredDeps({ dependencies: ['a'], devDependencies: 'weird' }), []);
  assert.deepEqual(requiredDeps({}), []);
});

test('isSafeDepName：一般名字與 @範圍/名字＝過；空的、. 開頭的段、多一層斜線、反斜線、.. ＝不過', () => {
  for (const ok of ['eslint', '@scope/pkg', 'a.b', 'a_b-c~d', 'UPPER']) assert.ok(isSafeDepName(ok), ok);
  for (const bad of ['', '.', '..', '../x', '.x', 'a/b', '@s/../x', '@s/.x', '@/x', 'a/b/c', 'a\\b', '@s/a/b', ' a', 'a b']) assert.ok(!isSafeDepName(bad), JSON.stringify(bad));
});

test('有 node_modules 時也讀受審版本的 package.json：壞掉、是陣列、相依名稱形狀認不得＝建盒前退 2', async () => {
  for (const [label, body, re] of /** @type {[string, string, RegExp][]} */ ([
    ['壞掉', '{', /不是合法的 JSON/], ['陣列', '[]', /不是一個物件/],
    ['名稱往上走', '{"dependencies":{"../x":"1"}}', /相依名稱形狀認不得/], ['名稱多一層斜線', '{"devDependencies":{"a/b":"1"}}', /相依名稱形狀認不得/],
  ])) {
    const repo = tinyRepo({ packageJson: body });
    const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
    assert.equal(r.code, 2, label); assert.match(r.text, re, label); assert.ok(!passedPreBox(r), label);
  }
  const repo = tinyRepo({ packageJson: '{"devDependencies":{"eslint":"1"}}' });
  assert.ok(passedPreBox(await run({ base: repo.base, head: repo.head, repo: repo.dir })), '對照組：名稱正常、node_modules 在＝過建盒前');
});

test('掃描設定：缺檔、壞 JSON、沒有掃描那一節、strongest／maxEffort 形狀不對或以 - 開頭＝退 2；合法的值印在建盒前那一行', async () => {
  const repo = tinyRepo();
  const dir = keep(mkdtempSync(join(tmpdir(), 'scan-settings-')));
  const write = (/** @type {string} */ name, /** @type {string} */ body) => { const p = join(dir, name); writeFileSync(p, body); return p; };
  const bad = [
    [join(dir, 'missing.json'), /讀不出掃描設定/],
    [write('bad.json', '{'), /讀不出掃描設定/],
    [write('noscanner.json', '{}'), /strongest（最強模型）沒填或形狀不對/],
    [write('m1.json', JSON.stringify({ scanner: { strongest: '-p', maxEffort: 'xhigh' } })), /strongest/],
    [write('m2.json', JSON.stringify({ scanner: { strongest: 'grok 4.7', maxEffort: 'xhigh' } })), /strongest/],
    [write('m3.json', JSON.stringify({ scanner: { strongest: 47, maxEffort: 'xhigh' } })), /strongest/],
    [write('e1.json', JSON.stringify({ scanner: { strongest: 'grok-4.7', maxEffort: '--x' } })), /maxEffort（最高推理）沒填或形狀不對/],
    [write('e2.json', JSON.stringify({ scanner: { strongest: 'grok-4.7', maxEffort: '' } })), /maxEffort/],
  ];
  for (const [f, re] of /** @type {[string, RegExp][]} */ (bad)) {
    const r = await run({ base: repo.base, head: repo.head }, { repo: repo.dir, settingsFile: f });
    assert.equal(r.code, 2, f); assert.match(r.text, re, f);
    assert.ok(!passedPreBox(r));
  }
  const ok = await run({ base: repo.base, head: repo.head }, { repo: repo.dir, settingsFile: write('ok.json', JSON.stringify({ scanner: { strongest: 'grok-9.9', maxEffort: 'max' } })) });
  assert.ok(ok.logs.some((l) => l.includes('指定模型 grok-9.9、推理 max')), ok.logs.join('\n'));
  const def = await run({ base: repo.base, head: repo.head }, { repo: repo.dir });
  assert.ok(def.logs.some((l) => l.includes(`指定模型 ${SETTINGS.strongest}、推理 ${SETTINGS.maxEffort}`)), '預設要讀本倉庫 settings.json 掃描那一節');
});

test('受掃倉庫的身分：只留 owner/name，網址裡的權杖與本機路徑都不出現；認不出就寫固定字串', async () => {
  assert.equal(repoLabelFrom('https://x-access-token:SECRET123@github.com/acme/kit.git'), 'acme/kit');
  assert.equal(repoLabelFrom('git@github.com:acme/kit.git'), 'acme/kit');
  assert.equal(repoLabelFrom('ssh://git@github.com/acme/kit'), 'acme/kit');
  assert.equal(repoLabelFrom('https://gitlab.com/acme/kit.git'), null);
  assert.equal(repoLabelFrom('/Users/someone/repo'), null);
  const withRemote = tinyRepo({ remote: 'https://x-access-token:SECRET123@github.com/acme/kit.git' });
  const r = await run({ base: withRemote.base, head: withRemote.head, repo: withRemote.dir });
  const line = r.logs.find((l) => l.startsWith('（受掃倉庫：')) ?? '';
  assert.match(line, /受掃倉庫：acme\/kit；掃描程式 sha256 [0-9a-f]{12}；/);
  assert.ok(!r.logs.join('\n').includes('SECRET123') && !r.text.includes('SECRET123'), '權杖跑進紀錄了');
  const none = tinyRepo();
  const r2 = await run({ base: none.base, head: none.head, repo: none.dir });
  assert.ok(r2.logs.some((l) => l.startsWith('（受掃倉庫：（沒有可辨認的 GitHub 遠端）')));
});

test('指令列：--repo=… 與 --repo 給兩次＝退 2（不默默掃回本倉庫、不默默挑一個）', () => {
  const script = join(ROOT, 'scripts', 'grok-scan.js');
  const home = keep(mkdtempSync(join(tmpdir(), 'cli-home-')));
  const env = { PATH: process.env.PATH ?? '', HOME: home };
  for (const extra of [['--repo=/x'], ['--repo', '/a', '--repo', '/b']]) {
    const r = spawnSync(process.execPath, [script, '--base', 'a'.repeat(40), '--head', 'b'.repeat(40), '--prompt', '/nope', ...extra], { encoding: 'utf8', env });
    assert.equal(r.status, 2, `${extra.join(' ')}：${r.stderr}`);
    assert.match(r.stderr, /--repo <要掃的倉庫/);
  }
});

test('結構題：沙箱參數只有那三組（要掃的倉庫、設定、參數一個都進不去）；每一個 git 呼叫都清環境；指令列把 repo 傳進 runScan、不傳 deps', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'grok-scan.js'), 'utf8');
  const sb = src.match(/const sbArgv = \[([^\]]*)\];/g) ?? [];
  assert.equal(sb.length, 1, '應該剛好一行 sbArgv');
  assert.equal(sb[0], "const sbArgv = ['-f', PROFILE, '-D', `SCAN_DIR=${box}`, '-D', `RELAY_PORT=${relayPort}`];", '沙箱參數多了或少了東西');
  const gits = src.split('\n').filter((l) => /spawnSync\('git'/.test(l));
  assert.ok(gits.length >= 10, `只找到 ${gits.length} 個 git 呼叫——掃描範圍不對`);
  for (const l of gits) assert.match(l, /env: gitEnv\(\)/, `這個 git 呼叫沒清環境（鐵則 11）：${l.trim().slice(0, 120)}`);
  const cli = src.slice(src.lastIndexOf('if (isMainModule(import.meta.url))'));
  assert.match(cli, /await runScan\(\{ base, head, promptFile, outFile, repo \}\);/, '指令列要把 repo 傳進 runScan、而且只傳一個參數（不傳 deps）');
});

test('沒有相依的倉庫整條走到退 0：假 grok 收到 --model／--reasoning-effort＝設定的值；配方聲明與 launch.json 記了受掃倉庫、模型、推理、程式雜湊；沙箱參數裡沒有倉庫路徑', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo({ nodeModules: false, remote: 'git@github.com:acme/kit.git' });
  // 要掃的倉庫與目前資料夾都放一份「錯的」設定：讀設定只能讀本掃描程式所在的倉庫
  writeFileSync(join(repo.dir, 'settings.json'), JSON.stringify({ scanner: { strongest: 'grok-wrong', maxEffort: 'wrong' } }));
  const inst = fakeGrok();
  const bin = join(inst, 'bin', 'grok');
  writeFileSync(bin, readFileSync(bin, 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'for a in "$@"; do printf \'<%s>\' "$a"; done'));
  const iso = isolated();
  const out = join(keep(mkdtempSync(join(tmpdir(), 'out-'))), 'reply.txt');
  /** @type {string[]} */ const logs = [];
  const r = await runScan(/** @type {any} */ ({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out, repo: repo.dir }), /** @type {any} */ ({ log: (/** @type {string} */ m) => logs.push(m), ...iso, ...withGrok(inst), relayScript: fakeRelay('ok') }));
  assert.equal(r.code, 0, r.summary.join('\n'));
  const reply = readFileSync(out, 'utf8');
  assert.ok(reply.includes(`<--model><${SETTINGS.strongest}><--reasoning-effort><${SETTINGS.maxEffort}>`), `假 grok 沒收到設定的模型與推理：${reply.slice(0, 300)}`);
  assert.ok(logs.some((l) => l.includes('沒有宣告相依套件、也沒有 node_modules')), '沒走跳過 node_modules 那一支');
  const recipe = r.summary.find((l) => l.startsWith('base..head=')) ?? '';
  assert.match(recipe, /｜受掃=acme\/kit｜/);
  assert.ok(recipe.includes(`｜指定模型=${SETTINGS.strongest}（推理 ${SETTINGS.maxEffort}）｜模型=`), recipe);
  const sha = createHash('sha256').update(readFileSync(join(ROOT, 'scripts', 'grok-scan.js'))).digest('hex');
  assert.ok(recipe.includes(`｜掃描程式 sha256=${sha.slice(0, 12)}｜`), recipe);
  const resultsDir = /結果包=([^（]+)/.exec(recipe)?.[1] ?? '';
  const launch = JSON.parse(readFileSync(join(resultsDir, 'launch.json'), 'utf8'));
  assert.equal(launch.repo, 'acme/kit');
  assert.equal(launch.model, SETTINGS.strongest);
  assert.equal(launch.reasoningEffort, SETTINGS.maxEffort);
  assert.equal(launch.scanScriptSha256, sha);
  assert.equal(launch.sbArgv.length, 6);
  assert.ok(!JSON.stringify(launch.sbArgv).includes(repo.dir) && !JSON.stringify(launch.env).includes(repo.dir), '要掃的倉庫路徑進了沙箱參數或環境');
});

test('node_modules 捷徑指到不叫 node_modules 的資料夾＝退 2（不把別處整包複製進盒子）、結果包不留', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  rmSync(join(repo.dir, 'node_modules'), { recursive: true });
  const elsewhere = keep(mkdtempSync(join(tmpdir(), 'elsewhere-')));
  mkdirSync(join(elsewhere, 'eslint'));
  execFileSync('ln', ['-s', elsewhere, join(repo.dir, 'node_modules')]);
  const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /node_modules 指到的不是叫 node_modules 的資料夾/);
  assert.deepEqual(readdirSync(iso.resultsRoot), [], '退 2 時結果包要整個不留');
});

test('牆上時間上限不超過盒內憑證提早換新的 60 分鐘（掃到一半憑證過期＝整輪白跑）', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'grok-auth-refresh.js'), 'utf8');
  const early = Number(/opt\.earlySecs \?\? (\d+)/.exec(src)?.[1]);
  assert.ok(early > 0, '讀不到 grok-auth-refresh.js 提早換新的秒數——考題要跟著改');
  assert.ok(GROK_WALL_MS < early * 1000, `GROK_WALL_MS ${GROK_WALL_MS} 超過提早換新的 ${early} 秒`);
});

test('node_modules 複製失敗＝退 2，訊息只寫 cp 的退出碼、不印它的錯誤輸出（裡面有本機路徑）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const locked = join(repo.dir, 'node_modules', 'eslint', 'unreadable.js');
  writeFileSync(locked, 'x'); chmodSync(locked, 0o000);
  try {
    const iso = isolated();
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    const text = r.summary.join('\n');
    assert.equal(r.code, 2, text);
    assert.match(text, /node_modules clone 失敗（cp 退 \d+）/);
    assert.ok(!text.includes(repo.dir) && !text.includes('unreadable.js') && !text.includes(tmpdir()), `訊息裡出現了路徑：${text}`);
  } finally { chmodSync(locked, 0o644); }
});

test('材料的 git diff 不執行受審版本挑的 diff 驅動（.gitattributes 指到 textconv／外部 diff 也不在盒子外跑）', async () => {
  const marker = join(keep(mkdtempSync(join(tmpdir(), 'textconv-marker-'))), 'ran');
  const tool = join(keep(mkdtempSync(join(tmpdir(), 'textconv-tool-'))), 'conv.sh');
  writeFileSync(tool, `#!/bin/sh\ntouch '${marker}'\ncat "$1"\n`); chmodSync(tool, 0o755);
  const repo = tinyRepo({ firstCommitFiles: { '.gitattributes': 'a.txt diff=probe\n' } });
  plantDiffDriver(repo.dir, tool);
  // 對照組：不關的話這個倉庫的 git diff 真的會執行它（考題自己的前提）
  execFileSync('git', ['-C', repo.dir, 'diff', `${repo.base}..${repo.head}`], { encoding: 'utf8', env: CLEAN_ENV });
  assert.ok(readdirSync(dirname(marker)).includes('ran'), '對照組沒執行驅動——考題前提不成立');
  rmSync(marker);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
  assert.equal(r.code, 2, r.summary.join('\n'));
  assert.ok(!readdirSync(dirname(marker)).includes('ran'), '掃描程式的 git diff 在盒子外執行了受審版本挑的 diff 驅動');
});

test('借掃：相依已備齊、沒有 ESLint 的倉庫照樣建得出盒子（不拿本專案的套件當必備哨兵）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo({ nodeModules: false, packageJson: '{"dependencies":{"only-dependency":"1.0.0"},"devDependencies":{"@scope/tool":"1.0.0"}}' });
  for (const n of ['only-dependency', '@scope/tool']) {
    mkdirSync(join(repo.dir, 'node_modules', n), { recursive: true });
    writeFileSync(join(repo.dir, 'node_modules', n, 'package.json'), '{}');
  }
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
  // 會在轉送器那步退 2（假轉送器故意死）——但不是在 node_modules 那步退
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.summary.join('\n'), /node_modules/, `相依已備齊的倉庫在 node_modules 那步被擋：${r.summary.join(' / ')}`);
  assert.match(r.summary.join('\n'), /轉送器/);
});

test('GIT_DIR 指到別的倉庫時（從連結工作樹推送的 pre-push 環境）：考題設 diff 驅動寫進要寫的倉庫、別的倉庫設定不變；掃描仍查 --repo 指的那一個', async () => {
  const repo = tinyRepo({ nodeModules: false });
  // 另一個倉庫的內容要不同：同一秒建的兩個 tinyRepo 提交編號一樣，查錯倉庫也查得到 base／head、分不出來
  const other = tinyRepo({ nodeModules: false, firstCommitFiles: { 'other.txt': 'other\n' } });
  assert.notEqual(other.base, repo.base, '兩個倉庫的提交編號一樣——考題前提不成立');
  const otherConfig = join(other.dir, '.git', 'config');
  const before = readFileSync(otherConfig, 'utf8');
  const r = await withGitDirPointingAt(join(other.dir, '.git'), async () => {
    plantDiffDriver(repo.dir, '/usr/bin/true');
    return run({ base: repo.base, head: repo.head, repo: repo.dir });
  });
  assert.equal(readFileSync(otherConfig, 'utf8'), before, '考題的 git 呼叫跟著 GIT_DIR 寫到別的倉庫了');
  assert.equal(execFileSync('git', ['-C', repo.dir, 'config', 'diff.probe.textconv'], { encoding: 'utf8', env: CLEAN_ENV }).trim(), '/usr/bin/true', '設定沒寫進要寫的倉庫');
  assert.ok(passedPreBox(r), `GIT_DIR 指到別處時掃描沒過建盒前的檢查（git 呼叫沒清環境＝去別的倉庫找 base／head）：${r.text}`);
});

test('結構題：掃描那一族考題與夾具裡每一個 git 呼叫都帶乾淨環境（CLEAN_ENV 或 gitEnv()）', () => {
  const dir = join(ROOT, 'test');
  const files = [...readdirSync(dir).filter((f) => /^grok-scan-flow-.*\.test\.js$/.test(f)).map((f) => join(dir, f)), join(dir, 'helpers', 'grok-scan-flow-fixtures.js')];
  let n = 0;
  for (const f of files) {
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!/(?:execFileSync|spawnSync|spawn|execFile)\('git'/.test(l)) continue;
      n++;
      assert.match(l, /env: (?:CLEAN_ENV|gitEnv\(\))/, `${basename(f)} 這個 git 呼叫沒帶乾淨環境（鐵則 11）：${l.trim().slice(0, 120)}`);
    }
  }
  assert.ok(n >= 7, `只找到 ${n} 個 git 呼叫——掃描範圍不對`);
});

test('node_modules 是空的（安裝沒完成）而受審版本宣告了相依＝退 2、結果包不留；零相依的空 node_modules＝不擋', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const empty = tinyRepo({ nodeModules: false, packageJson: '{"devDependencies":{"eslint":"1.0.0"}}' });
  mkdirSync(join(empty.dir, 'node_modules'));
  const iso = isolated();
  const r = await runScan({ base: empty.base, head: empty.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: empty.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /少了受審版本 package\.json 宣告的 1 個套件/);
  assert.deepEqual(readdirSync(iso.resultsRoot), [], '退 2 時結果包要整個不留');
  const none = tinyRepo({ nodeModules: false, packageJson: '{"name":"k"}' });
  mkdirSync(join(none.dir, 'node_modules'));
  const ok = await runScan({ base: none.base, head: none.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: none.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
  assert.doesNotMatch(ok.summary.join('\n'), /node_modules/, `零相依的空 node_modules 被擋：${ok.summary.join(' / ')}`);
  assert.match(ok.summary.join('\n'), /轉送器/);
});

