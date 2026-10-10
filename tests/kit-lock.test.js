// 守共用檔清單（規矩 E7：「忽略清單」、「豁免清單」都要逐條登記，由考題比對——例外段就是這一份清單的豁免；
// K1：每條「規矩」只有一份正本——這裡守的是規則檔在使用專案的複本）。工具、考題、範本預設在套件改是擁有者 2026-09-29 的裁示，
// 見套件 README「專案裡改到套件的檔」。使用專案改到套件的檔、卻沒在清單記例外＝紅。
//
// 為什麼：原專案 #641 在專案就地改了 6 個共用檔、PR 說明與留言沒有一處提到套件，後來有人手動比對才發現、套件約 34 小時後才補上。
//   清單住使用專案（kit-lock.json），--check 在使用專案的雲端三關跑、不讀套件（套件是私有倉庫、使用專案的雲端讀不到）；
//   --write 在本機跑、從本機套件倉庫的那一版取清單內容。
// 守得到的：清單每一筆的權限＋blob 跟工作樹一致；多出來、少掉、改內容、改權限各自紅並指名路徑；例外路徑一字不差（大小寫也算）才綠；
//   例外過期、打錯路徑也紅；清單壞掉、形狀不對、git 失敗＝退 2 不猜；--write 的內容等於套件那一版、工作樹對不上又沒例外＝拒寫、
//   印出差在哪、保留與清掉的例外、一行固定提醒（攔截器相關的 5 樣）；帶不帶只看設定的登記，登記跟清單在不在對不上就紅。
// ⚠️ 守不到的：同一支 PR 連清單、工具、這一題一起改（絆線不是鎖）；--check 不驗清單內容真的出自套件；套件有沒有新的；
//   被 .gitignore 忽略的檔（下面有一題照實驗它看不到）；共用路徑以外的檔；settings.json；分不出方向（專案多改 vs 套件有新的）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');
const lock = require('../tools/kit-lock.js');
const { read: readSettings } = require('../tools/settings-data.js');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'kit-lock.js');
const DECLARED = lock.declaration(readSettings().machines, fs.existsSync(path.join(ROOT, lock.LOCK_FILE)));
let ranTree = 0;

const KIT_FILES = {
  'tools/a.js': "'use strict';\n",
  'tools/forbidden-tools.js': '// 假的攔截器（只拿檔名來對指紋清單）\n',
  'tests/b.test.js': '// b\n',
  'templates/c.md': '# c\n',
  'templates/hook-codex-global.json': '{}\n',
  'rules.json': '{}\n',
  'RULES.md': '# r\n',
  'MACHINES.md': '# m\n',
  'GLOSSARY.md': '# g\n',
  'docs/money-guard-two-pattern-tables.md': '# d\n',
};

/** 一個假套件倉庫＋一個照它同步好的專案；家目錄指到暫存區（規矩 E4：git 一律拿清過的環境）。 */
function makeRepos(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-lock-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const env = { ...gitEnv(), HOME: scratch, GIT_CEILING_DIRECTORIES: scratch, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
  const gitIn = (cwd) => (...args) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return r.stdout;
  };
  const put = (dir, rel, body, mode) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
    if (mode) fs.chmodSync(path.join(dir, rel), mode);
  };
  const kit = path.join(scratch, 'kit');
  const root = path.join(scratch, 'proj');
  fs.mkdirSync(kit);
  fs.mkdirSync(root);
  const kgit = gitIn(kit);
  const git = gitIn(root);
  kgit('init', '-q');
  for (const [rel, body] of Object.entries(KIT_FILES)) put(kit, rel, body);
  put(kit, 'tools/run.sh', '#!/bin/sh\n', 0o755);
  put(kit, 'README.md', '# 套件自己的，不是共用檔\n');
  kgit('add', '-A');
  kgit('commit', '-q', '-m', 'v1');
  const v1 = kgit('rev-parse', 'HEAD').trim();
  /** 照 README 的同步法：先刪掉共用路徑，再解開套件那一版。 */
  const syncFrom = (version) => {
    for (const p of lock.SHARED_PATHS) fs.rmSync(path.join(root, p), { recursive: true, force: true });
    const archive = spawnSync('git', ['archive', version, '--', ...lock.SHARED_PATHS.filter((p) => kgit('ls-tree', version, '--', p).trim())], { cwd: kit, env });
    assert.equal(archive.status, 0, String(archive.stderr));
    const untar = spawnSync('tar', ['-x', '-C', root], { input: archive.stdout });
    assert.equal(untar.status, 0, String(untar.stderr));
  };
  git('init', '-q');
  syncFrom(v1);
  put(root, 'settings.json', '{"x":1}\n');
  put(root, 'lib/own.js', '// 專案自己的\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const lockJson = () => JSON.parse(fs.readFileSync(path.join(root, lock.LOCK_FILE), 'utf8'));
  const saveLock = (obj) => fs.writeFileSync(path.join(root, lock.LOCK_FILE), `${JSON.stringify(obj, null, 2)}\n`);
  const except = (list) => { const j = lockJson(); j.exceptions = list; saveLock(j); };
  const cli = (...args) => spawnSync(process.execPath, [TOOL, '--root', root, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  const write = (extra = {}) => lock.write(root, { kit, version: v1, repo: 'acct/kit', date: '2026-09-29', ...extra });
  return { scratch, kit, root, env, kgit, git, put: (rel, body, mode) => put(root, rel, body, mode), putKit: (rel, body, mode) => put(kit, rel, body, mode), v1, syncFrom, lockJson, saveLock, except, cli, write };
}
const FIXED = `提醒（固定）：這支同步若動到 ${[...lock.FINGERPRINT_SHARED, 'settings.json 的 forbidden 那一塊', lock.CODEX_TEMPLATE].join('、')} 任一樣，合併後要換複本、重按信任——照 README「搬進一個專案」第 3 步：Claude 側＝④（同一支PR重印釘指紋那一行，合併後每台機器補複本、按測試鈕）；Codex 全域層＝⓪〜⑥（先關掉所有 Codex、重抽、按信任、按測試鈕）；這次有沒有動到，看這支 PR 對主幹的 git diff`;
const ex = (p, extra = {}) => ({ path: p, why: '先在專案修', who: 'agent-a', since: '2026-09-29', ...extra });

test('--write：清單內容＝套件那一版的 ls-tree（權限＋blob＋路徑），版本碼記完整的 40 碼；專案自己的檔與套件的非共用檔都不進清單', (t) => {
  const r = makeRepos(t);
  const { lock: written, lines } = r.write();
  const tree = r.kgit('ls-tree', '-r', r.v1, '--', ...lock.SHARED_PATHS).trim().split('\n').map((l) => {
    const [meta, p] = l.split('\t'); const [mode, , blob] = meta.split(' '); return { mode, blob, path: p };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
  assert.deepEqual(written.entries, tree, '清單要等於套件那一版自己的 ls-tree');
  assert.equal(written.version, r.v1, '版本碼記完整的 40 碼');
  assert.ok(written.entries.some((e) => e.path === 'tools/run.sh' && e.mode === '100755'), '可執行位元要記到');
  assert.ok(!written.entries.some((e) => /^(settings\.json|lib\/|README\.md)/u.test(e.path)), '專案自己的檔、套件自己的 README 都不在清單');
  assert.deepEqual(r.lockJson(), { repo: 'acct/kit', version: r.v1, syncedAt: '2026-09-29', entries: tree, exceptions: [] });
  assert.match(lines[0], /^第一次寫清單：套件 [0-9a-f]{7} 有 11 個共用檔$/u);
  assert.equal(lines[1], FIXED, '第一次寫也印同一行固定提醒');
  assert.equal(lock.check(r.root).ok, true, '剛寫完的清單對自己一定是綠的');
  // 權限跟 git 一樣只看擁有者的執行位元：0o654 在 git 眼裡是 100644
  fs.chmodSync(path.join(r.root, 'RULES.md'), 0o654);
  assert.equal(r.git('status', '--porcelain', '--', 'RULES.md').trim(), '', '對照：git 自己也說 RULES.md 沒改');
  assert.equal(lock.check(r.root).ok, true, '只有群組或其他人的執行位元＝不算改權限');
});

test('--write 拒寫：工作樹跟套件那一版對不上又沒有例外（覆蓋式同步留下套件刪掉的檔、專案偷改）＝退 2，清單不動', (t) => {
  const r = makeRepos(t);
  r.write();
  const before = fs.readFileSync(path.join(r.root, lock.LOCK_FILE), 'utf8');
  // 套件 v2 刪掉 templates/c.md；只覆蓋、不先刪共用路徑＝舊檔留著
  r.kgit('rm', '-q', 'templates/c.md');
  r.kgit('commit', '-q', '-m', 'v2 刪檔');
  const v2 = r.kgit('rev-parse', 'HEAD').trim();
  assert.throws(() => lock.write(r.root, { kit: r.kit, version: v2 }), (e) => e instanceof lock.LockError && /templates\/c\.md：多出來/u.test(e.message) && /先刪掉共用路徑/u.test(e.message), '套件刪掉的檔還留著＝拒寫');
  assert.equal(fs.readFileSync(path.join(r.root, lock.LOCK_FILE), 'utf8'), before, '拒寫時清單一個位元組都不動');
  // 專案偷改一個共用檔、沒記例外
  r.put('tools/a.js', '// 偷改\n');
  assert.throws(() => r.write(), (e) => e instanceof lock.LockError && /tools\/a\.js：內容不同/u.test(e.message), '專案改了又沒例外＝拒寫');
  // 版本在本機套件倉庫找不到（例如複本沒 fetch）
  assert.throws(() => r.write({ version: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }), (e) => e instanceof lock.LockError && /找不到版本.*fetch/u.test(e.message));
  assert.throws(() => r.write({ kit: path.join(r.scratch, 'nope') }), (e) => e instanceof lock.LockError && /--kit/u.test(e.message), '套件倉庫路徑不在');
  assert.throws(() => r.write({ kit: undefined }), (e) => e instanceof lock.LockError && /--kit/u.test(e.message), '沒給 --kit');
  assert.throws(() => r.write({ version: 'main' }), lock.LockError, '版本碼不是十六進位');
  assert.throws(() => r.write({ date: '2026-02-31' }), lock.LockError, '不存在的日子');
});

test('--check：改內容、多一個檔、少一個檔、改權限各自紅並指名路徑；例外路徑一字不差（大小寫也算）才綠；被忽略的檔看不到（照實）', (t) => {
  const r = makeRepos(t);
  r.write();
  const red = (why, kind, p) => {
    const c = lock.check(r.root);
    assert.equal(c.ok, false, why);
    assert.ok(c.problems.some((x) => x.startsWith(`${p}：${kind}`)), `${why}：${c.problems.join(' / ')}`);
    return c;
  };
  const green = (why) => { const c = lock.check(r.root); assert.equal(c.ok, true, `${why}：${c.problems.join(' / ')}`); };
  r.put('tools/a.js', '// changed\n');
  red('改了共用檔沒記例外', '內容不同', 'tools/a.js');
  r.except([ex('tools/a.js')]);
  green('記了例外就綠');
  r.except([ex('tools/A.js')]);
  const c = red('例外的大小寫不對', '內容不同', 'tools/a.js');
  assert.ok(c.problems.some((x) => x.startsWith('tools/A.js：例外指到的檔不在工作樹、也不在清單')), c.problems.join(' / '));
  r.except([]);
  r.git('checkout', '--', 'tools/a.js');
  green('還原就綠');
  r.put('tools/extra.js', '// 專案偷放的\n');
  red('共用資料夾多放一個檔（沒追蹤也算）', '多出來', 'tools/extra.js');
  r.except([ex('tools/extra.js')]);
  green('多出來的檔記了例外也綠');
  fs.rmSync(path.join(r.root, 'tools', 'extra.js'));
  r.except([]);
  fs.rmSync(path.join(r.root, 'templates', 'c.md'));
  red('刪掉共用檔', '少掉', 'templates/c.md');
  r.git('checkout', '--', 'templates/c.md');
  fs.chmodSync(path.join(r.root, 'RULES.md'), 0o755);
  red('只改擁有者的執行位元', '權限不同', 'RULES.md');
  fs.chmodSync(path.join(r.root, 'RULES.md'), 0o644);
  green('權限改回來就綠');
  r.put('.gitignore', '*.log\n');
  r.put('tools/x.log', 'ignored\n');
  green('被 .gitignore 忽略的檔這一題看不到（守不到的，寫在檔頭）');
  r.put('lib/own.js', '// 改專案自己的\n');
  r.put('settings.json', '{"x":2}\n');
  green('共用路徑以外的檔不比');
});

test('--check：符號連結記 120000 與目標字串的雜湊（等於 ls-tree），改指向就紅', (t) => {
  const r = makeRepos(t);
  fs.symlinkSync('a.js', path.join(r.kit, 'tools', 'link.js'));
  r.kgit('add', '-A');
  r.kgit('commit', '-q', '-m', 'link');
  const v = r.kgit('rev-parse', 'HEAD').trim();
  r.syncFrom(v);
  const { lock: written } = r.write({ version: v });
  const [meta] = r.kgit('ls-tree', v, '--', 'tools/link.js').trim().split('\t');
  const [mode, , blob] = meta.split(' ');
  assert.deepEqual(written.entries.find((e) => e.path === 'tools/link.js'), { mode, blob, path: 'tools/link.js' });
  assert.equal(mode, '120000');
  assert.equal(lock.check(r.root).ok, true);
  fs.rmSync(path.join(r.root, 'tools', 'link.js'));
  fs.symlinkSync('forbidden-tools.js', path.join(r.root, 'tools', 'link.js'));
  assert.match(lock.check(r.root).problems.join('\n'), /^tools\/link\.js：內容不同/mu);
});

test('共用路徑底下的巢狀倉庫、子模組、檔名含換行＝退 2（清單不收，不靜靜略過）', (t) => {
  const r = makeRepos(t);
  r.write();
  const nested = path.join(r.root, 'tools', 'vendored');
  fs.mkdirSync(nested);
  spawnSync('git', ['init', '-q'], { cwd: nested, env: r.env });
  fs.writeFileSync(path.join(nested, 'evil.js'), '//\n');
  for (const args of [['add', '-A'], ['commit', '-q', '-m', 'n']]) assert.equal(spawnSync('git', args, { cwd: nested, env: r.env }).status, 0, `巢狀倉庫 git ${args[0]}`);
  assert.throws(() => lock.check(r.root), (e) => e instanceof lock.LockError && /巢狀倉庫/u.test(e.message), '沒追蹤的巢狀倉庫');
  r.git('add', 'tools/vendored');
  assert.throws(() => lock.check(r.root), (e) => e instanceof lock.LockError && /子模組或巢狀倉庫/u.test(e.message), '加進索引變成 gitlink');
  r.git('rm', '-q', '-f', '--cached', 'tools/vendored');
  fs.rmSync(nested, { recursive: true, force: true });
  assert.equal(lock.check(r.root).ok, true, '拿掉之後回到綠');
  r.put(`tools/new${String.fromCharCode(10)}line.js`, '//\n');
  assert.throws(() => lock.check(r.root), (e) => e instanceof lock.LockError && /檔名含換行/u.test(e.message));
});

test('--check：例外過期（檔已經跟清單一樣）＝紅；例外的形狀不對＝退 2 不猜', (t) => {
  const r = makeRepos(t);
  r.write();
  r.except([ex('tools/a.js')]);
  const c = lock.check(r.root);
  assert.equal(c.ok, false);
  assert.match(c.problems[0], /^tools\/a\.js：例外過期/u);
  for (const [why, list] of [
    ['例外指到共用路徑以外', [ex('lib/own.js')]],
    ['例外少 who', [{ path: 'tools/a.js', why: 'x', since: '2026-09-29' }]],
    ['例外多一欄', [ex('tools/a.js', { note: 'x' })]],
    ['例外 why 空白', [ex('tools/a.js', { why: '  ' })]],
    ['例外 who 空白', [ex('tools/a.js', { who: '' })]],
    ['例外 since 不是日期', [ex('tools/a.js', { since: '昨天' })]],
    ['例外 since 是不存在的日子', [ex('tools/a.js', { since: '2026-13-01' })]],
    ['例外沒排序', [ex('tools/a.js'), ex('RULES.md')]],
    ['例外重複', [ex('tools/a.js'), ex('tools/a.js')]],
  ]) {
    r.except(list);
    assert.throws(() => lock.check(r.root), lock.LockError, why);
  }
});

test('清單本身壞掉：每一種形狀錯都退 2 不猜（對照組：好的清單要過）', (t) => {
  const r = makeRepos(t);
  r.write();
  const good = r.lockJson();
  assert.doesNotThrow(() => lock.validateLock(JSON.parse(JSON.stringify(good))), '對照組：好的清單要過');
  const mutate = (why, f) => { const j = JSON.parse(JSON.stringify(good)); f(j); assert.throws(() => lock.validateLock(j), lock.LockError, why); };
  mutate('少 exceptions 欄', (j) => { delete j.exceptions; });
  mutate('多一欄', (j) => { j.note = 'x'; });
  mutate('版本碼不是 40 碼', (j) => { j.version = j.version.slice(0, 7); });
  mutate('版本碼不是十六進位', (j) => { j.version = 'main'; });
  mutate('repo 不是帳號/倉庫名', (j) => { j.repo = 'kit'; });
  mutate('日期形狀', (j) => { j.syncedAt = '2026/09/29'; });
  mutate('不存在的日子', (j) => { j.syncedAt = '2026-02-31'; });
  mutate('entries 不是陣列', (j) => { j.entries = {}; });
  mutate('blob 不是 40 位', (j) => { j.entries[0].blob = 'abc'; });
  mutate('權限不是三種之一', (j) => { j.entries[0].mode = '100600'; });
  mutate('路徑帶 ..', (j) => { j.entries[0].path = 'tools/../lib/own.js'; });
  mutate('路徑開頭是斜線', (j) => { j.entries[0].path = '/tools/a.js'; });
  mutate('路徑有空段', (j) => { j.entries[0].path = 'tools//a.js'; });
  mutate('路徑不在共用範圍', (j) => { j.entries[0].path = 'lib/own.js'; });
  mutate('entries 沒排序', (j) => { j.entries.reverse(); });
  mutate('entries 重複', (j) => { j.entries.push({ ...j.entries[0] }); });
  mutate('entries 少欄位', (j) => { delete j.entries[0].mode; });
  fs.writeFileSync(path.join(r.root, lock.LOCK_FILE), '{not json');
  assert.throws(() => lock.check(r.root), lock.LockError, '不是 JSON');
  fs.rmSync(path.join(r.root, lock.LOCK_FILE));
  assert.throws(() => lock.check(r.root), lock.LockError, '清單不在');
  assert.throws(() => lock.write(r.root, { kit: r.kit, version: r.v1 }), (e) => /第一次寫清單要給 --repo/u.test(e.message), '第一次寫沒給 repo');
});

test('--write 第二次：列出套件這一版改了什麼、指紋檔與 Codex 接線範本、保留與清掉的例外；--repo 蓋過上一份', (t) => {
  const r = makeRepos(t);
  r.write();
  // 專案先改兩個檔、記例外；套件 v2 把其中一個搬回去（內容相同），另外改了指紋檔、Codex 範本、新加與刪掉各一個
  r.put('tools/a.js', '// 專案先修的\n');
  r.put('RULES.md', '# 專案先改的規矩\n');
  r.except([ex('RULES.md', { who: 'agent-b' }), ex('tools/a.js')]);
  assert.equal(lock.check(r.root).ok, true);
  r.putKit('tools/a.js', '// 專案先修的\n');
  r.putKit('tools/forbidden-tools.js', '// 新版攔截器\n');
  r.putKit('templates/hook-codex-global.json', '{"v":2}\n');
  r.putKit('templates/new.md', '# 套件新加的範本\n');
  r.kgit('rm', '-q', 'templates/c.md');
  r.kgit('add', '-A');
  r.kgit('commit', '-q', '-m', 'v2');
  const v2 = r.kgit('rev-parse', 'HEAD').trim();
  const keep = fs.readFileSync(path.join(r.root, 'RULES.md'), 'utf8');
  r.syncFrom(v2);
  r.put('RULES.md', keep);   // 還沒搬回套件的那一個，同步時留著專案的版本（例外保留）
  const { lines, lock: written } = lock.write(r.root, { kit: r.kit, version: v2, repo: 'acct/kit2', date: '2026-10-01' });
  assert.equal(written.repo, 'acct/kit2', '--repo 蓋過上一份');
  assert.equal(written.version, v2);
  assert.deepEqual(written.exceptions, [ex('RULES.md', { who: 'agent-b' })], '仍跟套件不同的例外保留，已相同的清掉');
  assert.equal(lines[0], `跟上一份清單（${r.v1.slice(0, 7)}，2026-09-29）比：套件這一版有 5 個共用檔不一樣`);
  assert.deepEqual(lines.slice(1, 6), [
    '  ・templates/c.md：套件這一版刪掉', '  ・templates/hook-codex-global.json：內容不同', '  ・templates/new.md：套件這一版新加',
    '  ・tools/a.js：內容不同', '  ・tools/forbidden-tools.js：內容不同',
  ]);
  assert.equal(lines[6], FIXED, '動到指紋檔與 Codex 範本時，也只印同一行固定提醒、不判斷');
  assert.equal(lines[7], '例外保留 1 筆（工作樹仍跟套件這一版不同）：RULES.md（agent-b）');
  assert.match(lines[8], /^例外清掉 1 筆（工作樹已跟套件這一版相同）：tools\/a\.js——/u);
  assert.equal(lines[9], `寫好 ${lock.LOCK_FILE}：套件 acct/kit2 ${v2}（2026-10-01），11 筆、例外 1 筆`);
  assert.equal(lines.length, 10);
  assert.equal(lock.check(r.root).ok, true);
});

// 擁有者 2026-09-29 裁 a：不判斷這次動到沒有，每次都印同一行固定提醒；有沒有動到由實作者看 PR 對主幹的差異告訴擁有者。
test('--write 的提醒是固定的一行：不論這次改了什麼（一般檔、指紋檔、Codex 範本、刪檔），都印同一句、點名那 5 樣、不說「沒動到」', (t) => {
  const r = makeRepos(t);
  const outs = [r.write().lines];
  const nextVersion = (edit, msg) => { edit(); r.kgit('add', '-A'); r.kgit('commit', '-q', '-m', msg); return r.kgit('rev-parse', 'HEAD').trim(); };
  for (const [msg, edit] of [
    ['只改一般檔', () => r.putKit('tools/a.js', '// v2\n')],
    ['只改指紋檔', () => r.putKit('tools/forbidden-tools.js', '// v3\n')],
    ['只改 Codex 範本', () => r.putKit('templates/hook-codex-global.json', '{"v":4}\n')],
    ['刪掉一個檔', () => r.kgit('rm', '-q', 'templates/c.md')],
  ]) {
    const v = nextVersion(edit, msg);
    r.syncFrom(v);
    outs.push(r.write({ version: v }).lines);
  }
  for (const out of outs) {
    assert.equal(out.filter((l) => l === FIXED).length, 1, `每一次都剛好一行固定提醒：\n${out.join('\n')}`);
    assert.ok(!out.some((l) => /沒動到|不用換|這支 PR 對 /u.test(l)), `不做判斷：\n${out.join('\n')}`);
  }
  for (const item of [...lock.FINGERPRINT_SHARED, 'settings.json 的 forbidden 那一塊', lock.CODEX_TEMPLATE]) assert.ok(FIXED.includes(item), item);
});

test('名單對得上：指紋清單＝guard-copy 的 COPY_FILES 扣掉 settings.json；Codex 接線範本＝guard-copy 的 TEMPLATE_REL', () => {
  assert.deepEqual(lock.FINGERPRINT_SHARED, ['tools/forbidden-tools.js', 'tools/package.json', 'tools/settings-data.js']);
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'guard-copy.js'), 'utf8');
  const m = /^const TEMPLATE_REL = '([^']+)';$/mu.exec(src);
  assert.ok(m, 'guard-copy.js 裡找不到 TEMPLATE_REL 的定義（改名了？這一題要跟著改）');
  assert.equal(lock.CODEX_TEMPLATE, m[1], 'Codex 全域層的接線範本換了檔名：kit-lock.js 的 CODEX_TEMPLATE 要跟著改');
});

test('指令入口：--check 綠退 0、紅退 1、清單壞掉或 git 失敗退 2；參數錯退 2 並印用法', (t) => {
  const r = makeRepos(t);
  let p = r.cli('--write', '--kit', r.kit, '--version', r.v1, '--repo', 'acct/kit', '--date', '2026-09-29');
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const good = fs.readFileSync(path.join(r.root, lock.LOCK_FILE), 'utf8');
  p = r.cli('--check');
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /^共用檔清單｜套件 acct\/kit [0-9a-f]{7}（2026-09-29）：11 筆；工作樹跟清單不一樣的 0 個、例外 0 筆\n全部相同。\n$/u);
  r.put('tools/a.js', '// changed\n');
  p = r.cli('--check');
  assert.equal(p.status, 1, p.stdout);
  assert.match(p.stdout, /tools\/a\.js：內容不同，清單裡沒有這一筆例外/u);
  r.except([ex('tools/a.js')]);
  p = r.cli('--check');
  assert.equal(p.status, 0, p.stdout);
  assert.match(p.stdout, /  例外：tools\/a\.js（agent-a，2026-09-29 起）：先在專案修\n不一樣的每一個都有例外對上。\n$/u, '有例外時照實列出來');
  fs.writeFileSync(path.join(r.root, lock.LOCK_FILE), '[]');
  p = r.cli('--check');
  assert.equal(p.status, 2, p.stdout);
  assert.match(p.stdout, /形狀不對/u);
  // 清單在、但這個目錄不是倉庫＝git 失敗＝退 2（不吞掉，規矩 E5）
  const bare = path.join(r.scratch, 'not-a-repo');
  fs.mkdirSync(path.join(bare, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(bare, 'tools', 'a.js'), '//\n');
  fs.writeFileSync(path.join(bare, lock.LOCK_FILE), good);
  p = spawnSync(process.execPath, [TOOL, '--root', bare, '--check'], { cwd: os.tmpdir(), env: r.env, encoding: 'utf8' });
  assert.equal(p.status, 2, p.stdout);
  assert.match(p.stdout, /git ls-files 退/u);
  p = spawnSync(process.execPath, [TOOL, '--root', path.join(r.scratch, 'nope'), '--check'], { cwd: os.tmpdir(), env: r.env, encoding: 'utf8' });
  assert.equal(p.status, 2, '目錄不存在＝清單不在＝退 2');
  assert.match(p.stdout, /沒有 kit-lock\.json/u);
  p = r.cli('--write', '--version', r.v1);
  assert.equal(p.status, 2, p.stdout);
  assert.match(p.stdout, /--kit/u);
  p = r.cli('--frobnicate');
  assert.equal(p.status, 2);
  assert.match(p.stdout, /看不懂的參數：--frobnicate\n用法：/u);
  p = r.cli('--check', '--write');
  assert.equal(p.status, 2);
  assert.match(p.stdout, /只能給一個/u);
  p = r.cli('--check', '--version', r.v1);
  assert.equal(p.status, 2);
  assert.match(p.stdout, /--check 不收 --version/u);
});

test('帶不帶只看設定的登記，而且登記要跟清單在不在一致（三種狀態各兩種情形）', () => {
  const row = (state) => [{ name: lock.MACHINE, state }];
  assert.deepEqual(lock.declaration(row('已啟用'), true), { run: true, problem: null, reason: null }, '登記帶、清單在：照跑');
  assert.match(lock.declaration(row('已啟用'), false).problem, /卻不在.*--write --kit/u, '登記帶、清單不在：紅，訊息教怎麼建');
  const notYet = lock.declaration(row('已安裝未啟用'), false);
  assert.deepEqual([notYet.run, notYet.problem], [false, null], '還沒建清單：跳過');
  assert.match(notYet.reason, /還沒建清單/u, '跳過要寫出原因');
  assert.match(lock.declaration(row('已安裝未啟用'), true).problem, /改成已啟用/u, '清單在了卻沒啟用：紅');
  const upstream = lock.declaration(row('未移植'), false);
  assert.deepEqual([upstream.run, upstream.problem], [false, null], '套件倉庫自己：跳過');
  assert.match(upstream.reason, /上游/u);
  assert.match(lock.declaration(row('未移植'), true).problem, /上游/u, '登記未移植、清單卻在：紅');
  assert.match(lock.declaration(row('已就位'), false).problem, /只能登記/u, '登記成別的狀態：紅');
  assert.match(lock.declaration([], false).problem, /剛好一列/u, '這一列不見了：紅');
  assert.match(lock.declaration([...row('未移植'), ...row('未移植')], false).problem, /剛好一列/u, '重複：紅');
});

test('這棵樹登記帶清單時，工作樹要跟清單對得上（改了套件的檔沒記例外＝紅；還沒搬回的例外逐筆印出來）', { skip: DECLARED.run ? false : DECLARED.reason }, (t) => {
  ranTree += 1;
  const c = lock.check(ROOT);
  for (const x of c.exceptions) t.diagnostic(`例外還沒搬回套件：${x.path}（${x.who}，${x.since} 起）：${x.why}`);
  assert.ok(c.ok, c.problems.join('\n'));
});

// ⚠️ 這一題要留在檔案最後：它核對登記跟清單在不在一致、而且該跑的那一題真的跑了
test('登記跟清單在不在一致；該跑的真的跑了', () => {
  assert.equal(DECLARED.problem, null, DECLARED.problem || '');
  assert.equal(ranTree, DECLARED.run ? 1 : 0, `登記說${DECLARED.run ? '要跑' : '不跑'}對清單那一題，實際跑了 ${ranTree} 題：跳過的接線接錯了`);
});
