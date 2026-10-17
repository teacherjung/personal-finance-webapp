// @ts-check
// `grok-scan.js` 掃別的倉庫（`--repo`）、沒有相依的倉庫跳過 node_modules、紀錄寫掃哪個倉庫與程式版本、明確指定最強模型與最高推理
// （同族之一；理財接手 Grok 掃描交接，Fable 2026-10-11 代裁；William 2026-10-05「先借用試試看」、2026-10-04 常設指示「Grok掃描也請用最強模型、最高推理能力」）。
//
// 守得到的：
// ・建盒子之前的檢查（CI 也跑得到）：--repo 空的／以 - 開頭／找不到／不是資料夾／不是 git 倉庫／是倉庫的子資料夾＝退 2、⛔、訊息裡沒有路徑；
//   --repo 與考題注入的倉庫同時給＝退 2；base／head 不在要掃的倉庫＝退 2；受審版本提交了 node_modules（捷徑）＝退 2；
//   沒有 node_modules 而 needsInstall（dependencies 扣掉 optional 同名、加 devDependencies）有名字＝退 2，只有 peer／optional／打包欄或沒有 package.json＝過；
//   package.json 壞掉、是陣列＝退 2；package.json 讀的是受審版本（不是基底、也不是工作樹）；needsInstall 的單元題；
//   有 node_modules 時也讀 package.json：壞掉、是陣列＝退 2；相依的名字不拿來組路徑、怎麼寫都不擋（#675 r4 換做法後）；
//   設定 strongest／maxEffort 缺、形狀不對、以 - 開頭＝退 2；相對路徑照目前資料夾解析；
//   遠端網址只留 owner/name（夾在網址裡的權杖、本機路徑都不出現）；指令列 --repo=… 與給兩次＝退 2；
//   結構題：沙箱參數只有那三組（要掃的倉庫進不去）、每一個 git 呼叫都清環境、指令列把 repo 傳進 runScan、不傳 deps；
//   GIT_DIR 指到別的倉庫時：建盒前的檢查仍查 --repo 那一個、考題自己設 diff 驅動寫進要寫的倉庫而別的倉庫設定不變；
//   結構題：這一族考題與夾具的每一個 git 呼叫都帶乾淨環境（#675 r1 Codex：考題的 git 呼叫跟著 GIT_DIR 寫到別的倉庫）。
//   refs/replace 把受審版本換成別的內容時照樣讀受審版本本身；不分大小寫的磁碟上，根目錄有一項跟 node_modules 是同一個東西＝退 2（#675 複審後掃的反駁審查）。
// ・套得上沙箱的 macOS 才跑：沒有相依的倉庫整條走到退 0；假 grok 收到的參數有 --model <設定的最強模型> --reasoning-effort <設定的最高推理>；
//   配方聲明與 launch.json 寫了受掃倉庫、指定模型、推理、掃描程式的雜湊；沙箱參數裡沒有要掃的倉庫路徑；
//   node_modules 捷徑指到不叫 node_modules 的資料夾＝退 2、結果包不留；相依已備齊、沒有 ESLint 的倉庫建得出盒子（不在 node_modules 那步退）；
//   需要安裝的相依有名字、node_modules 卻是空的（點開頭的不算）＝退 2、結果包不留（#675 r2、r4 Codex）；只有 peer／optional 的不擋；
//   node_modules 頂層與 @範圍 底下的捷徑連到盒子外（絕對路徑、相對路徑往上走出去、@範圍 本身、盒內 @範圍 捷徑底下的項目）＝退 2（#675 r3、r4）；
//   盒子裡第一層跟來源對不上（來源有 socket、cp 不複製）＝退 2；盒內的相對捷徑、點開頭的 @範圍、optional 同名覆寫而沒裝＝不擋。
// ⚠️ 劃界（#675 r4 連三輪自問表）：不判斷「每一個宣告的套件都裝了」——少了某一個（例如 eslint）而 node_modules 不是空的、
//   或捷徑在盒子裡解不開（沒裝、受審版本拿掉了那個 workspace）＝不擋，只記一行；掃描照跑、盒子裡的考題會紅。有一題把這個劃界寫死。
// ⚠️ 守不到的：真的 grok 收到 --model／--reasoning-effort 之後實際用了哪一個（假 grok 只回聲參數；真的那一半看正式掃描的配方聲明「指定模型」與「模型」兩格）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { GROK_WALL_MS, needsInstall, repoLabelFrom, runScan } from '../scripts/grok-scan.js';
import { CLEAN_ENV, FAKE_SCANNER, ROOT, SANDBOX_OK, SKIP_AFTER_CANARY, cleanupTempRoots, fakeGrok, fakeRelay, isolated, keep, promptFile, quiet, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);

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

test('沒有 node_modules：沒有 package.json、相依全空、只有 peer／optional／打包欄＝過；dependencies 或 devDependencies 有名字、形狀怪、package.json 壞掉或是陣列＝退 2', async () => {
  for (const [label, pkg] of /** @type {[string, string | undefined][]} */ ([['沒有 package.json', undefined], ['相依全空', '{"name":"k","dependencies":{},"devDependencies":{},"bundledDependencies":[]}'],
    ['打包選項 false（bundleDependencies）', '{"bundleDependencies":false}'], ['打包選項 false（別名 bundledDependencies）', '{"bundledDependencies":false}'], ['打包選項 true、沒有相依', '{"bundleDependencies":true}'],
    ['只有 peer', '{"peerDependencies":{"x":"1"}}'], ['只有 optional', '{"optionalDependencies":{"x":"1"}}'], ['dependencies 全被 optional 同名覆寫', '{"dependencies":{"x":"1"},"optionalDependencies":{"x":"1"}}']])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: pkg });
    const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
    assert.ok(passedPreBox(r), `${label}：沒過建盒前的檢查：${r.text}`);
    assert.match(r.text, /sha256 不符/, label);
  }
  for (const [label, pkg] of /** @type {[string, string][]} */ ([['dependencies', '{"dependencies":{"x":"1"},"bundleDependencies":false}'], ['devDependencies', '{"devDependencies":{"x":"1"}}'],
    ['devDependencies 與 optional 同名（仍算）', '{"devDependencies":{"x":"1"},"optionalDependencies":{"x":"1"}}'], ['形狀怪', '{"devDependencies":"weird"}']])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: pkg });
    const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
    assert.equal(r.code, 2, label); assert.match(r.text, /宣告了相依套件、卻沒有 node_modules/, label);
  }
  for (const [label, body, re] of /** @type {[string, string, RegExp][]} */ ([['壞掉', '{', /不是合法的 JSON/], ['陣列', '[]', /不是一個物件/]])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: body });
    const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
    assert.equal(r.code, 2, label); assert.match(r.text, re, label);
  }
});

test('倉庫裡有 refs/replace 把受審版本換成別的內容時，掃描照樣讀受審版本本身（每一個 git 呼叫帶 --no-replace-objects）', async () => {
  const git = (/** @type {string} */ dir, /** @type {string[]} */ a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: CLEAN_ENV }).trim();
  const repo = tinyRepo({ nodeModules: false, packageJson: '{"name":"k"}' });
  // 另一顆沒有關係的提交：宣告了相依（受審版本本身沒有）。用 replace 把受審版本換成它
  writeFileSync(join(repo.dir, 'package.json'), '{"devDependencies":{"x":"1"}}');
  git(repo.dir, ['add', 'package.json']);
  const other = git(repo.dir, ['commit-tree', git(repo.dir, ['write-tree']), '-m', 'other']);
  git(repo.dir, ['checkout', '-q', '--', 'package.json']);
  git(repo.dir, ['reset', '-q']);
  git(repo.dir, ['replace', repo.head, other]);
  assert.match(git(repo.dir, ['show', `${repo.head}:package.json`]), /devDependencies/, '考題前提：replace 沒生效');
  const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
  assert.ok(passedPreBox(r), `讀到被替換的內容了（宣告相依、沒有 node_modules 而退）：${r.text}`);
});

test('不分大小寫的磁碟上，受審版本根目錄有一項跟工作樹的 node_modules 是同一個東西（例如提交 NODE_MODULES 捷徑）＝建盒前退 2', async (t) => {
  const git = (/** @type {string} */ dir, /** @type {string[]} */ a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: CLEAN_ENV }).trim();
  const repo = tinyRepo({ nodeModules: false });
  const elsewhere = join(keep(mkdtempSync(join(tmpdir(), 'steer-'))), 'node_modules');
  mkdirSync(elsewhere);
  execFileSync('ln', ['-s', elsewhere, join(repo.dir, 'NODE_MODULES')]);
  let folded = false;
  try { lstatSync(join(repo.dir, 'node_modules')); folded = true; } catch { /* 分大小寫的磁碟 */ }
  if (!folded) { t.skip('這台磁碟分大小寫：NODE_MODULES 跟 node_modules 是兩個東西，這一題的前提不成立'); return; }
  writeFileSync(join(repo.dir, '.gitattributes'), 'NODE_MODULES export-ignore\n');
  git(repo.dir, ['add', '.gitattributes', 'NODE_MODULES']);
  git(repo.dir, ['commit', '-q', '-m', 'steer']);
  const head = git(repo.dir, ['rev-parse', 'HEAD']);
  const r = await run({ base: repo.head, head, repo: repo.dir });
  assert.equal(r.code, 2, r.text);
  assert.match(r.text, /跟 node_modules 是同一個東西/);
  assert.ok(!passedPreBox(r));
});

test('needsInstall：dependencies 扣掉 optional 同名、加上 devDependencies；peer、optional、打包欄不算；形狀怪的不當成沒有', () => {
  assert.equal(needsInstall({}), false);
  assert.equal(needsInstall({ dependencies: {}, devDependencies: {}, bundleDependencies: ['a'] }), false);
  assert.equal(needsInstall({ peerDependencies: { a: '1' }, optionalDependencies: { b: '1' }, bundledDependencies: false }), false);
  assert.equal(needsInstall({ dependencies: { a: '1' }, optionalDependencies: { a: '1' } }), false, 'optional 同名覆寫的不算');
  assert.equal(needsInstall({ dependencies: { a: '1', b: '1' }, optionalDependencies: { a: '1' } }), true);
  assert.equal(needsInstall({ devDependencies: { a: '1' }, optionalDependencies: { a: '1' } }), true, 'devDependencies 同名照算');
  assert.equal(needsInstall({ dependencies: { a: '1' }, optionalDependencies: ['a'] }), true, 'optional 形狀怪的不拿來扣');
  for (const v of ['weird', null, 1, ['a']]) assert.equal(needsInstall({ devDependencies: v }), true, `形狀怪的不當成沒有：${JSON.stringify(v)}`);
  assert.equal(needsInstall({ devDependencies: [] }), false);
});

test('package.json 讀的是受審版本：基底沒宣告、受審版本宣告了＝退 2（工作樹改回沒宣告也一樣）；反過來＝過', async () => {
  const git = (/** @type {string} */ dir, /** @type {string[]} */ a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: CLEAN_ENV }).trim();
  const third = (/** @type {string} */ first, /** @type {string} */ second, /** @type {string} */ worktree) => {
    const repo = tinyRepo({ nodeModules: false, packageJson: first });
    writeFileSync(join(repo.dir, 'package.json'), second);
    git(repo.dir, ['commit', '-q', '-am', 'three']);
    writeFileSync(join(repo.dir, 'package.json'), worktree);   // 工作樹：不提交
    return { dir: repo.dir, base: repo.head, head: git(repo.dir, ['rev-parse', 'HEAD']) };
  };
  const adds = third('{"name":"k"}', '{"devDependencies":{"x":"1"}}', '{"name":"k"}');
  const r1 = await run({ base: adds.base, head: adds.head, repo: adds.dir });
  assert.equal(r1.code, 2, r1.text); assert.match(r1.text, /宣告了相依套件、卻沒有 node_modules/);
  const drops = third('{"devDependencies":{"x":"1"}}', '{"name":"k"}', '{"devDependencies":{"x":"1"}}');
  assert.ok(passedPreBox(await run({ base: drops.base, head: drops.head, repo: drops.dir })), '受審版本拿掉相依＝過（不看基底、不看工作樹）');
});

test('有 node_modules 時也讀受審版本的 package.json：壞掉、是陣列＝建盒前退 2；相依的名字不拿來組路徑，怎麼寫都不擋', async () => {
  for (const [label, body, re] of /** @type {[string, string, RegExp][]} */ ([['壞掉', '{', /不是合法的 JSON/], ['陣列', '[]', /不是一個物件/]])) {
    const repo = tinyRepo({ packageJson: body });
    const r = await run({ base: repo.base, head: repo.head, repo: repo.dir });
    assert.equal(r.code, 2, label); assert.match(r.text, re, label); assert.ok(!passedPreBox(r), label);
  }
  for (const body of ['{"devDependencies":{"eslint":"1"}}', '{"devDependencies":{"@.scope/pkg":"npm:x@1","../x":"1","a/b":"1"}}']) {
    const repo = tinyRepo({ packageJson: body });
    assert.ok(passedPreBox(await run({ base: repo.base, head: repo.head, repo: repo.dir })), `名字照寫、node_modules 在＝過建盒前：${body}`);
  }
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

});

test('正式預設設定：Gemini 登記使舊 Grok 掃描在建盒、CLI、試探及外連之前拒絕；不讀受掃倉庫或目前資料夾的設定', async () => {
  const repo = tinyRepo();
  const cwd = keep(mkdtempSync(join(tmpdir(), 'scan-decoy-cwd-')));
  // 兩份誘餌必須合法；若用非法值，誤讀誘餌也會退場而假綠。
  writeFileSync(join(repo.dir, 'settings.json'), JSON.stringify({ scanner: { strongest: 'grok-8.1', maxEffort: 'high' } }));
  writeFileSync(join(cwd, 'settings.json'), JSON.stringify({ scanner: { strongest: 'grok-8.2', maxEffort: 'low' } }));
  const iso = isolated(), install = withGrok(fakeGrok()), prompt = promptFile();
  const fs = createRequire(import.meta.url)('node:fs');
  const original = fs.mkdtempSync, previousCwd = process.cwd();
  let boxes = 0, canaries = 0, fetches = 0;
  /** @type {string[]} */ const logs = [];
  fs.mkdtempSync = (/** @type {string} */ prefix, ...args) => {
    if (String(prefix).includes('grok-scan-')) boxes++;
    return original(prefix, ...args);
  };
  syncBuiltinESMExports();
  try {
    process.chdir(cwd);
    const result = await runScan({ base: repo.base, head: repo.head, repo: repo.dir, promptFile: prompt }, {
      ...iso, ...install, settingsFile: undefined, log: line => logs.push(line),
      runCanary: async () => { canaries++; throw new Error('不得啟動試探'); },
      fetchImpl: async () => { fetches++; throw new Error('不得外連'); },
    });
    assert.equal(result.code, 2);
    assert.match(result.summary.join('\n'), /settings.json 掃描那一節的 strongest（最強模型）沒填或形狀不對/);
    assert.equal(boxes, 0, 'CLI 只在建盒後啟動，不能先建盒再清掉');
    assert.equal(canaries, 0); assert.equal(fetches, 0);
    assert.deepEqual(readdirSync(iso.resultsRoot), []);
    assert.ok(!passedPreBox({ logs }));
  } finally {
    process.chdir(previousCwd); fs.mkdtempSync = original; syncBuiltinESMExports();
  }
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

test('合成 insteadOf 確實改寫時，配方與 launch 留原始遠端標籤；非 GitHub 原值不借改寫升格', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const cases = [
    ['https://synthetic-token:SYNTHETIC-LABEL-SECRET@github.com/acme/original.git', 'https://github.com/rewritten/elsewhere.git', 'acme/original'],
    ['https://example.test/opaque.git', 'https://github.com/rewritten/masquerade.git', '（沒有可辨認的 GitHub 遠端）'],
  ];
  for (const [original, rewritten, expected] of cases) {
    const repo = tinyRepo({ remote: original });
    execFileSync('git', ['-C', repo.dir, 'config', `url.${rewritten}.insteadOf`, original], { env: CLEAN_ENV });
    const control = execFileSync('git', ['-C', repo.dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', env: CLEAN_ENV }).trim();
    assert.equal(control, rewritten, '修正本題合成 insteadOf 設定後重跑本檔');
    for (const purpose of /** @type {const} */ (['review', 'scan'])) {
      const iso = isolated();
      /** @type {string[]} */ const logs = [];
      const result = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), repo: repo.dir, purpose,
        ...(purpose === 'review' ? { model: 'grok-4.7', effort: 'xhigh', review: { project: 'owner/repo', change: '17', reviewer: 'Grok', source: 'Grok CLI', round: 1, previousHead: repo.base } } : {}),
      }, { ...iso, ...withGrok(fakeGrok({ formalTranscript: true, model: 'grok-4.7' })), relayScript: fakeRelay(), log: (line) => logs.push(line) });
      assert.equal(result.code, 0, result.summary.join('\n'));
      const recipe = result.summary.find((line) => line.startsWith('base..head=')) ?? '';
      assert.ok(recipe.includes(`｜受掃=${expected}｜`), '修正原始 remote.origin.url 的標籤讀取後重跑本檔');
      const directories = readdirSync(iso.resultsRoot);
      assert.equal(directories.length, 1, '修正本輪結果包接線後重跑本檔');
      const launch = JSON.parse(readFileSync(join(iso.resultsRoot, directories[0], 'launch.json'), 'utf8'));
      assert.equal(launch.repo, expected, '修正啟動紀錄的原始遠端標籤後重跑本檔');
      assert.ok(!JSON.stringify({ logs, summary: result.summary, launch }).includes(original), '修正遠端標籤的封閉解析後重跑本檔');
    }
  }
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

test('結構題：沙箱參數只有那三組（要掃的倉庫、設定、參數一個都進不去）；每一個 git 呼叫都清環境、都帶 --no-replace-objects；指令列把 repo 傳進 runScan、不傳 deps', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'grok-scan.js'), 'utf8');
  const sb = src.match(/const sbArgv = \[([^\]]*)\];/g) ?? [];
  assert.equal(sb.length, 1, '應該剛好一行 sbArgv');
  assert.equal(sb[0], "const sbArgv = ['-f', PROFILE, '-D', `SCAN_DIR=${box}`, '-D', `RELAY_PORT=${relayPort}`];", '沙箱參數多了或少了東西');
  const gits = src.split('\n').filter((l) => /spawnSync\('git'/.test(l));
  assert.ok(gits.length >= 10, `只找到 ${gits.length} 個 git 呼叫——掃描範圍不對`);
  for (const l of gits) assert.match(l, /env: gitEnv\(\)/, `這個 git 呼叫沒清環境（鐵則 11）：${l.trim().slice(0, 120)}`);
  for (const l of gits) assert.match(l, /spawnSync\('git', \['--no-replace-objects', /, `這個 git 呼叫沒帶 --no-replace-objects（refs/replace 會把 head 換成別的內容）：${l.trim().slice(0, 120)}`);
  const cli = src.slice(src.lastIndexOf('if (isMainModule(import.meta.url))'));
  assert.match(cli, /await runScan\(\{ base, head, promptFile, outFile, repo \}\);/, '指令列要把 repo 傳進 runScan、而且只傳一個參數（不傳 deps）');
});

test('沒有相依的倉庫整條走到退 0：假 grok 收到 --model／--reasoning-effort＝設定的值；配方聲明與 launch.json 記了受掃倉庫、模型、推理、程式雜湊；沙箱參數裡沒有倉庫路徑', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo({ nodeModules: false, remote: 'git@github.com:acme/kit.git' });
  // 合成流程明確注入自己的設定；受掃倉庫的設定不能覆蓋它。
  writeFileSync(join(repo.dir, 'settings.json'), JSON.stringify({ scanner: { strongest: 'grok-8.3', maxEffort: 'low' } }));
  const inst = fakeGrok();
  const bin = join(inst, 'bin', 'grok');
  writeFileSync(bin, readFileSync(bin, 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'for a in "$@"; do printf \'<%s>\' "$a"; done; printf "SCAN-USER=<%s>" "${USER-NOT-PRESENT}"'));
  const iso = isolated();
  const out = join(keep(mkdtempSync(join(tmpdir(), 'out-'))), 'reply.txt');
  /** @type {string[]} */ const logs = [];
  const r = await runScan(/** @type {any} */ ({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out, repo: repo.dir }), /** @type {any} */ ({ log: (/** @type {string} */ m) => logs.push(m), ...iso, ...withGrok(inst), relayScript: fakeRelay('ok') }));
  assert.equal(r.code, 0, r.summary.join('\n'));
  const reply = readFileSync(out, 'utf8');
  assert.ok(reply.includes(`<--model><${FAKE_SCANNER.strongest}><--reasoning-effort><${FAKE_SCANNER.maxEffort}>`), `假 grok 沒收到設定的模型與推理：${reply.slice(0, 300)}`);
  assert.ok(logs.some((l) => l.includes('沒有宣告相依套件、也沒有 node_modules')), '沒走跳過 node_modules 那一支');
  const recipe = r.summary.find((l) => l.startsWith('base..head=')) ?? '';
  assert.match(recipe, /｜受掃=acme\/kit｜/);
  assert.ok(recipe.includes(`｜指定模型=${FAKE_SCANNER.strongest}（推理 ${FAKE_SCANNER.maxEffort}）｜模型=`), recipe);
  const sha = createHash('sha256').update(readFileSync(join(ROOT, 'scripts', 'grok-scan.js'))).digest('hex');
  assert.ok(recipe.includes(`｜掃描程式 sha256=${sha.slice(0, 12)}｜`), recipe);
  const resultsDir = /結果包=([^（]+)/.exec(recipe)?.[1] ?? '';
  const launch = JSON.parse(readFileSync(join(resultsDir, 'launch.json'), 'utf8'));
  assert.equal(launch.repo, 'acme/kit');
  assert.equal(launch.model, FAKE_SCANNER.strongest);
  assert.equal(launch.reasoningEffort, FAKE_SCANNER.maxEffort);
  assert.ok(reply.includes('SCAN-USER=<NOT-PRESENT>'));
  assert.equal(Object.hasOwn(launch.env, 'USER'), false);
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

test('需要安裝的相依有名字、node_modules 卻是空的（點開頭的不算）＝退 2、結果包不留；零相依、只有 peer／optional 的空 node_modules＝不擋', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const dotOnly = (/** @type {string} */ dir) => { mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true }); writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}'); };
  for (const [label, pkg] of /** @type {[string, string][]} */ ([
    ['開發相依', '{"devDependencies":{"eslint":"1.0.0"}}'],
    ['開發相依與 optional 同名（npm 仍當必備，#675 r4 Codex）', '{"devDependencies":{"eslint":"1.0.0"},"optionalDependencies":{"eslint":"2.0.0"}}'],
  ])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: pkg });
    dotOnly(repo.dir);
    const iso = isolated();
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 2, `${label}：${r.summary.join(' / ')}`);
    assert.match(r.summary.join('\n'), /宣告了相依套件、node_modules 卻是空的/, label);
    assert.deepEqual(readdirSync(iso.resultsRoot), [], `${label}：退 2 時結果包要整個不留`);
  }
  for (const [label, pkg] of /** @type {[string, string][]} */ ([['零相依', '{"name":"k"}'], ['只有 peer', '{"peerDependencies":{"eslint":">=9"}}'], ['只有 optional', '{"optionalDependencies":{"@esbuild/linux-x64":"0.20.0"}}']])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: pkg });
    dotOnly(repo.dir);
    const ok = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
    assert.doesNotMatch(ok.summary.join('\n'), /node_modules/, `${label}的空 node_modules 被擋：${ok.summary.join(' / ')}`);
    assert.match(ok.summary.join('\n'), /轉送器/, label);
  }
});

test('node_modules 的捷徑連到盒子外＝退 2、結果包不留：頂層絕對路徑、相對路徑往上走出去、@範圍 本身、盒內 @範圍 捷徑底下的項目、解不開的絕對路徑、經過更深一層繞出去', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const outside = keep(mkdtempSync(join(tmpdir(), 'outside-pkg-')));
  mkdirSync(join(outside, 'pkg'));
  for (const [label, build] of /** @type {[string, (nm: string) => void][]} */ ([
    ['頂層絕對路徑', (nm) => execFileSync('ln', ['-s', outside, join(nm, 'eslint')])],
    ['相對路徑往上走出去', (nm) => execFileSync('ln', ['-s', join('..', '..', '..', '..', '..', '..', '..', '..', 'tmp'), join(nm, 'eslint')])],
    ['@範圍 本身連到盒子外（底下是真目錄）', (nm) => execFileSync('ln', ['-s', outside, join(nm, '@scope')])],
    ['盒內 @範圍 捷徑底下的項目連到盒子外', (nm) => { mkdirSync(join(nm, '.store', '@scope'), { recursive: true }); execFileSync('ln', ['-s', outside, join(nm, '.store', '@scope', 'pkg')]); execFileSync('ln', ['-s', join('.store', '@scope'), join(nm, '@scope')]); }],
    ['解不開的絕對路徑', (nm) => execFileSync('ln', ['-s', join(outside, 'does-not-exist'), join(nm, 'eslint')])],
    ['字面在盒子裡、經過更深一層的捷徑繞到盒子外', (nm) => { mkdirSync(join(nm, '.store')); execFileSync('ln', ['-s', outside, join(nm, '.store', 'x')]); execFileSync('ln', ['-s', join('.store', 'x'), join(nm, 'eslint')]); }],
    ['@範圍 是盒內捷徑、子捷徑的相對路徑接在真實位置後落到盒子外（#675 r5 鏡像那一題）', (nm) => { mkdirSync(join(nm, '.store', 'deep', '@scope'), { recursive: true }); execFileSync('ln', ['-s', join('..', '..', '..', '..', '..', 'eslint'), join(nm, '.store', 'deep', '@scope', 'pkg')]); execFileSync('ln', ['-s', join('.store', 'deep', '@scope'), join(nm, '@scope')]); }],
  ])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: '{"devDependencies":{"eslint":"1.0.0"}}' });
    const nm = join(repo.dir, 'node_modules'); mkdirSync(nm);
    mkdirSync(join(nm, 'other')); writeFileSync(join(nm, 'other', 'package.json'), '{}');
    build(nm);
    const iso = isolated();
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 2, `${label}：${r.summary.join(' / ')}`);
    assert.match(r.summary.join('\n'), /有 1 個捷徑連到盒子外/, label);
    assert.deepEqual(readdirSync(iso.resultsRoot), [], `${label}：退 2 時結果包要整個不留`);
  }
});

test('盒子裡第一層跟來源對不上＝退 2：來源 node_modules 有 socket（cp 不複製）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo({ packageJson: '{"devDependencies":{"eslint":"1.0.0"}}' });
  const nm = join(repo.dir, 'node_modules');
  execFileSync(process.execPath, ['-e', "require('node:net').createServer().listen('sock', () => process.exit(0))"], { cwd: nm });
  assert.ok(readdirSync(nm).includes('sock'), '考題前提：socket 沒建出來');
  const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2, r.summary.join(' / '));
  assert.match(r.summary.join('\n'), /跟來源不一樣/);
  assert.deepEqual(readdirSync(iso.resultsRoot), [], '退 2 時結果包要整個不留');
});

test('不擋的：盒內的相對捷徑、點開頭的 @範圍、optional 同名覆寫而沒裝；劃界：少了某一個宣告的套件、盒子裡解不開的相對捷徑（受審版本拿掉了那個 workspace）也不擋，只記一行', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const real = (/** @type {string} */ dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), '{}'); };
  for (const [label, pkg, build, missingLine] of /** @type {[string, string, (nm: string) => void, boolean][]} */ ([
    ['盒內的相對捷徑（pnpm 那種形狀）', '{"devDependencies":{"eslint":"1.0.0"}}', (nm) => { real(join(nm, '.pnpm', 'eslint')); execFileSync('ln', ['-s', join('.pnpm', 'eslint'), join(nm, 'eslint')]); }, false],
    ['盒內的 @範圍 捷徑、底下是真目錄', '{"devDependencies":{"@scope/pkg":"1.0.0"}}', (nm) => { real(join(nm, '.store', '@scope', 'pkg')); execFileSync('ln', ['-s', join('.store', '@scope'), join(nm, '@scope')]); }, false],
    ['@範圍 是盒內捷徑、子捷徑用相對路徑指回盒內套件（#675 r5 Codex）', '{"devDependencies":{"@scope/pkg":"1.0.0","eslint":"1.0.0"}}', (nm) => { real(join(nm, 'eslint')); mkdirSync(join(nm, '.store', 'deep', '@scope'), { recursive: true }); execFileSync('ln', ['-s', join('..', '..', '..', 'eslint'), join(nm, '.store', 'deep', '@scope', 'pkg')]); execFileSync('ln', ['-s', join('.store', 'deep', '@scope'), join(nm, '@scope')]); }, false],
    ['點開頭的 @範圍（npm 接受，#675 r4 Codex）', '{"devDependencies":{"@.scope/pkg":"npm:x@1","eslint":"1.0.0"}}', (nm) => { real(join(nm, '@.scope', 'pkg')); real(join(nm, 'eslint')); }, false],
    ['optional 同名覆寫而沒裝', '{"dependencies":{"addon":"1"},"optionalDependencies":{"addon":"1"},"devDependencies":{"eslint":"1.0.0"}}', (nm) => real(join(nm, 'eslint')), false],
    ['劃界：少了宣告的 eslint、有別的套件', '{"devDependencies":{"eslint":"1.0.0","other":"1.0.0"}}', (nm) => real(join(nm, 'other')), false],
    ['劃界：受審版本拿掉了 workspace，相對捷徑在盒子裡解不開', '{"workspaces":["packages/*"],"devDependencies":{"eslint":"1.0.0"}}', (nm) => { real(join(nm, 'eslint')); execFileSync('ln', ['-s', join('..', 'packages', 'old'), join(nm, 'old')]); }, true],
    ['劃界：@範圍 底下的相對捷徑解不開', '{"devDependencies":{"@scope/pkg":"1.0.0"}}', (nm) => { mkdirSync(join(nm, '@scope')); execFileSync('ln', ['-s', 'does-not-exist', join(nm, '@scope', 'pkg')]); }, true],
  ])) {
    const repo = tinyRepo({ nodeModules: false, packageJson: pkg });
    const nm = join(repo.dir, 'node_modules'); mkdirSync(nm);
    build(nm);
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, log: (/** @type {string} */ m) => logs.push(m), ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
    assert.doesNotMatch(r.summary.join('\n'), /node_modules/, `${label}被擋：${r.summary.join(' / ')}`);
    assert.match(r.summary.join('\n'), /轉送器/, label);
    assert.equal(logs.some((l) => /有 1 個捷徑在盒子裡解不開/.test(l)), missingLine, `${label}：解不開那一行${missingLine ? '沒' : '不該'}記`);
  }
});


test('外層限制寫入時仍可載入能力夾具並執行純本地題', (t) => {
  if (!SANDBOX_OK) return t.skip(SKIP_AFTER_CANARY);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'grok-fixture-host-')));
  try {
    const fixture = new URL('./helpers/grok-scan-flow-fixtures.js', import.meta.url).href;
    const source = new URL('../scripts/grok-scan.js', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import {readdirSync} from 'node:fs';
      import {tmpdir} from 'node:os';
      import {SANDBOX_OK} from ${JSON.stringify(fixture)};
      import {needsInstall} from ${JSON.stringify(source)};
      assert.equal(typeof SANDBOX_OK,'boolean');
      assert.equal(needsInstall({dependencies:{synthetic:'1'}}),true);
      assert.equal(needsInstall({optionalDependencies:{synthetic:'1'}}),false);
      assert.deepEqual(readdirSync(tmpdir()),[]);
      process.stdout.write(JSON.stringify({loaded:true,sandbox:SANDBOX_OK}));
    `;
    // 此 profile 只考夾具在受限寫入位置的載入；正式隔離由 canary 與資格場另驗。
    const profile = '(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath (param "TEST_DIR")) (literal "/dev/null"))';
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '-D', `TEST_DIR=${dir}`, process.execPath, '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout); assert.equal(result.loaded, true);
    if (!result.sandbox) assert.match(r.stderr, /跳過＝不等於通過/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
