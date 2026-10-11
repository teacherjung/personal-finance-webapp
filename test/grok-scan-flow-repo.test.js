// @ts-check
// `grok-scan.js` 掃別的倉庫（`--repo`）、沒有相依的倉庫跳過 node_modules、紀錄寫掃哪個倉庫與程式版本、明確指定最強模型與最高推理
// （同族之一；理財接手 Grok 掃描交接，Fable 2026-10-11 代裁；William 2026-10-05「先借用試試看」、2026-10-04 常設指示「Grok掃描也請用最強模型、最高推理能力」）。
//
// 守得到的：
// ・建盒子之前的檢查（CI 也跑得到）：--repo 空的／以 - 開頭／找不到／不是資料夾／不是 git 倉庫／是倉庫的子資料夾＝退 2、⛔、訊息裡沒有路徑；
//   --repo 與考題注入的倉庫同時給＝退 2；base／head 不在要掃的倉庫＝退 2；受審版本提交了 node_modules（捷徑）＝退 2；
//   沒有 node_modules 而 package.json 宣告了任何一種相依＝退 2、沒宣告或沒有 package.json＝過；package.json 壞掉、是陣列＝退 2；
//   設定 strongest／maxEffort 缺、形狀不對、以 - 開頭＝退 2；相對路徑照目前資料夾解析；
//   遠端網址只留 owner/name（夾在網址裡的權杖、本機路徑都不出現）；指令列 --repo=… 與給兩次＝退 2；
//   結構題：沙箱參數只有那三組（要掃的倉庫進不去）、每一個 git 呼叫都清環境、指令列把 repo 傳進 runScan、不傳 deps。
// ・套得上沙箱的 macOS 才跑：沒有相依的倉庫整條走到退 0；假 grok 收到的參數有 --model <設定的最強模型> --reasoning-effort <設定的最高推理>；
//   配方聲明與 launch.json 寫了受掃倉庫、指定模型、推理、掃描程式的雜湊；沙箱參數裡沒有要掃的倉庫路徑；
//   node_modules 捷徑指到不叫 node_modules 的資料夾＝退 2、結果包不留。
// ⚠️ 守不到的：真的 grok 收到 --model／--reasoning-effort 之後實際用了哪一個（假 grok 只回聲參數；真的那一半看正式掃描的配方聲明「指定模型」與「模型」兩格）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { GROK_WALL_MS, declaresDeps, repoLabelFrom, runScan } from '../scripts/grok-scan.js';
import { ROOT, SANDBOX_OK, SKIP_AFTER_CANARY, cleanupTempRoots, fakeGrok, fakeRelay, isolated, keep, promptFile, quiet, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

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
  for (const [label, pkg] of /** @type {[string, string | undefined][]} */ ([['沒有 package.json', undefined], ['相依全空', '{"name":"k","dependencies":{},"devDependencies":{},"bundledDependencies":[]}']])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: pkg });
    const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
    assert.ok(passedPreBox(r), `${label}：沒過建盒前的檢查：${r.text}`);
    assert.match(r.text, /sha256 不符/, label);
  }
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const repo = tinyRepo({ nodeModules: false, packageJson: JSON.stringify({ [k]: { x: '1' } }) });
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
