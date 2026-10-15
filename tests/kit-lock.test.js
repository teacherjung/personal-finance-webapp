// 守共用檔清單（規矩 D5：協作套件的檔只在套件改，使用專案不改、不刪、不在共用路徑底下加檔；同步前查到專案自己改過就停、不覆蓋；
// K1：每條「規矩」只有一份正本——這裡守的是規則檔與工具在使用專案的複本）。擁有者 2026-10-15 裁 A：一律不能改、沒有例外。
//
// 為什麼：原專案 #641 在專案就地改了 6 個共用檔、PR 說明與留言沒有一處提到套件，兩邊約 34 小時內容不同；2026-10-14 隔離重現量到舊的
//   「記例外、事後 --write」那條路會把專案的改動在同步時換掉、例外清掉、--check 照樣全綠。
//   清單住使用專案（kit-lock.json），--check 在使用專案的雲端三關跑、不讀套件（套件是私有倉庫、使用專案的雲端讀不到）；
//   --sync、--write 在本機跑、從本機套件倉庫的那一版取清單內容。
// 守得到的：--check 多出來、少掉、改內容、改權限各自紅並指名路徑；舊格式的空例外段照收、有內容＝退 2；清單壞掉、git 失敗＝退 2；
//   --sync 查到已提交、暫存區、工作樹、沒追蹤、被忽略、改名、清單被手改過（改一筆、少一筆、改權限）、共用路徑上一層是連結
//   （指到專案裡或樹外）、已追蹤的共用資料夾裡另有倉庫的 .git、清單寫不進去、只差大小寫的同名路徑、跳過工作樹或假設沒改的標記、
//   套件新檔會被專案忽略，任何一樣都不換檔（連 --apply 也是），
//   一個檔都不動（樹外也是）；查過才換、換完工作樹＝套件那一版、專案自己的檔（含 docs/、cases/ 底下的鄰居）逐位元組不變；
//   換到一半對不上、刪檔失敗、換完寫清單失敗時印的還原指令，原字串交給 shell 跑（路徑有空白、$、單引號）真的還原得回來；
//   套件舊版的共用範圍比新版小時，清單照舊版的範圍核（不把新加進範圍的檔誤判成清單少列）；版本不在套件主幹上（主幹名照套件設定）、往回同步、清單指到沒合併的版本、
//   跑的工具不是那一版的、沒有 origin/<主幹>＝拒絕；--write 只收第一次裝（歷史裡有過清單也拒）；--touch 的分類；一行固定提醒；
//   帶不帶只看設定的登記，登記跟清單在不在對不上就紅。
// ⚠️ 守不到的：同一支 PR 連清單、工具、這一題一起改（絆線不是鎖）；--check 不驗清單內容真的出自套件；套件有沒有新的；
//   --check 看不到被 .gitignore 忽略的檔與只差大小寫的同名路徑（下面有一題照實驗它看不到忽略的檔；--sync 看得到）；共用路徑以外的檔；
//   settings.json；不走 --sync、自己動手刪檔解包；--check 分不出方向（專案多改 vs 套件有新的）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

// 假套件裡放真的這支工具：--sync、--write 會核「跑的這一份＝套件那一版的 tools/kit-lock.js」，--sync 也從它讀那一版的共用路徑
const KIT_FILES = {
  'tools/a.js': "'use strict';\n",
  'tools/kit-lock.js': fs.readFileSync(TOOL, 'utf8'),
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

/** 一個假套件倉庫（主幹＝origin/main）＋一個照它同步好、提交過的專案；家目錄指到暫存區（規矩 E4：git 一律拿清過的環境）。 */
function makeRepos(t, { projName = 'proj' } = {}) {
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
  const root = path.join(scratch, projName);
  fs.mkdirSync(kit);
  fs.mkdirSync(root);
  const kgit = gitIn(kit);
  const git = gitIn(root);
  kgit('init', '-q');
  for (const [rel, body] of Object.entries(KIT_FILES)) put(kit, rel, body);
  put(kit, 'tools/run.sh', '#!/bin/sh\n', 0o755);
  put(kit, 'README.md', '# 套件自己的，不是共用檔\n');
  put(kit, 'settings.json', '{"mainBranch":"main"}\n');
  kgit('add', '-A');
  kgit('commit', '-q', '-m', 'v1');
  const v1 = kgit('rev-parse', 'HEAD').trim();
  /** 假的「推上主幹」：origin/<主幹> 指到現在這一顆。 */
  const publish = (main = 'main') => kgit('update-ref', `refs/remotes/origin/${main}`, 'HEAD');
  publish();
  /** 套件改一版、提交、推上主幹；回版本碼。 */
  const nextKit = (edit, msg = 'next', main = 'main') => { edit(); kgit('add', '-A'); kgit('commit', '-q', '-m', msg); publish(main); return kgit('rev-parse', 'HEAD').trim(); };
  /** 舊的同步法（第一次裝照這樣）：先刪掉共用路徑，再解開套件那一版。overlay＝不先刪（只新增與覆蓋）。 */
  const syncFrom = (version, { overlay = false } = {}) => {
    if (!overlay) for (const p of lock.SHARED_PATHS) fs.rmSync(path.join(root, p), { recursive: true, force: true });
    const archive = spawnSync('git', ['archive', version, '--', ...lock.SHARED_PATHS.filter((p) => kgit('ls-tree', version, '--', p).trim())], { cwd: kit, env });
    assert.equal(archive.status, 0, String(archive.stderr));
    const untar = spawnSync('tar', ['-x', '-C', root], { input: archive.stdout });
    assert.equal(untar.status, 0, String(untar.stderr));
  };
  git('init', '-q');
  syncFrom(v1);
  // 專案自己的檔，含 docs/、cases/ 底下跟共用檔當鄰居的（同步只能換那一個共用檔、不能清整個資料夾）
  put(root, 'settings.json', '{"x":1}\n');
  put(root, 'lib/own.js', '// 專案自己的\n');
  put(root, 'docs/own.md', '# 專案自己的文件\n');
  put(root, 'cases/own.md', '# 專案自己的案例\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const lockJson = () => JSON.parse(fs.readFileSync(path.join(root, lock.LOCK_FILE), 'utf8'));
  const saveLock = (obj) => fs.writeFileSync(path.join(root, lock.LOCK_FILE), `${JSON.stringify(obj, null, 2)}\n`);
  const commit = (msg = 'c') => { git('add', '-A'); git('commit', '-q', '-m', msg); };
  const cli = (...args) => spawnSync(process.execPath, [TOOL, '--root', root, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  const write = (extra = {}) => lock.write(root, { kit, version: v1, repo: 'acct/kit', date: '2026-09-29', ...extra });
  const doSync = (version, extra = {}) => lock.sync(root, { kit, version, date: '2026-10-15', ...extra });
  /** 內容的 blob 碼；store＝true 時順便寫進專案倉庫（給 update-index --cacheinfo 用）。 */
  const blobOf = (body, store = false) => spawnSync('git', ['hash-object', ...(store ? ['-w'] : []), '--stdin'], { cwd: root, env, input: body, encoding: 'utf8' }).stdout.trim();
  return { scratch, kit, root, env, kgit, git, put: (rel, body, mode) => put(root, rel, body, mode), putKit: (rel, body, mode) => put(kit, rel, body, mode), v1, publish, nextKit, syncFrom, lockJson, saveLock, commit, cli, write, doSync, blobOf };
}

/** 一個資料夾裡每一個檔（.git 以外）的擁有者執行位元＋內容雜湊（連結記目標）：用來證明「一個檔都沒動」。只看擁有者的執行位元，跟 git 一樣（各機器 umask 不同不假紅）。 */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name);
      const rel = path.relative(dir, abs);
      if (rel === '.git') continue;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(abs)}`;
      else if (st.isDirectory()) walk(abs);
      else out[rel] = `${(st.mode & 0o100) ? 'x' : '-'}:${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

const FIXED = `提醒（固定）：這支同步若動到 ${[...lock.FINGERPRINT_SHARED, 'settings.json 的 forbidden 那一塊', lock.CODEX_TEMPLATE].join('、')} 任一樣，合併後要換複本、重按信任——照 README「搬進一個專案」第 3 步：Claude 側＝④（同一支PR重印釘指紋那一行，合併後每台機器補複本、按測試鈕）；Codex 全域層＝⓪〜⑥（先關掉所有 Codex、重抽、按信任、按測試鈕）；這次有沒有動到，看這支 PR 對主幹的 git diff`;
const PASSED = '同步前檢查：清單出自套件那一版，已提交、暫存區、工作樹都跟清單一樣，共用路徑底下沒有沒追蹤或被忽略的檔';
const lsTree = (r, v) => r.kgit('ls-tree', '-r', v, '--', ...lock.SHARED_PATHS).trim().split('\n').map((l) => {
  const [meta, p] = l.split('\t'); const [mode, , blob] = meta.split(' '); return { mode, blob, path: p };
}).sort((a, b) => (a.path < b.path ? -1 : 1));

test('--write（第一次裝）：清單內容＝套件那一版的 ls-tree（權限＋blob＋路徑），版本碼記完整的 40 碼、沒有例外段；專案自己的檔與套件的非共用檔都不進清單', (t) => {
  const r = makeRepos(t);
  const { lock: written, lines } = r.write();
  const tree = lsTree(r, r.v1);
  assert.deepEqual(written.entries, tree, '清單要等於套件那一版自己的 ls-tree');
  assert.equal(written.version, r.v1, '版本碼記完整的 40 碼');
  assert.ok(written.entries.some((e) => e.path === 'tools/run.sh' && e.mode === '100755'), '可執行位元要記到');
  assert.ok(!written.entries.some((e) => /^(settings\.json|lib\/|README\.md|docs\/own|cases\/own)/u.test(e.path)), '專案自己的檔、套件自己的 README 與設定都不在清單');
  assert.deepEqual(r.lockJson(), { repo: 'acct/kit', version: r.v1, syncedAt: '2026-09-29', entries: tree }, '新寫的清單沒有 exceptions 欄');
  assert.deepEqual(lines, [`第一次寫清單：套件 ${r.v1.slice(0, 7)} 有 12 個共用檔`, FIXED, `寫好 ${lock.LOCK_FILE}：套件 acct/kit ${r.v1}（2026-09-29），12 筆`]);
  assert.equal(lock.FIXED, FIXED, '固定提醒的字釘在這裡');
  assert.equal(lock.check(r.root).ok, true, '剛寫完的清單對自己一定是綠的');
  // 權限跟 git 一樣只看擁有者的執行位元：0o654 在 git 眼裡是 100644
  fs.chmodSync(path.join(r.root, 'RULES.md'), 0o654);
  assert.equal(r.git('status', '--porcelain', '--', 'RULES.md').trim(), '', '對照：git 自己也說 RULES.md 沒改');
  assert.equal(lock.check(r.root).ok, true, '只有群組或其他人的執行位元＝不算改權限');
});

test('--write 拒寫：已經有清單、或歷史裡有過清單（之後要用 --sync）、工作樹跟套件那一版對不上、版本找不到或不在主幹上、跑的不是那一版的工具；清單不動', (t) => {
  const r = makeRepos(t);
  // 套件 v2 刪掉 templates/c.md；只覆蓋、不先刪共用路徑＝舊檔留著
  const v2 = r.nextKit(() => r.kgit('rm', '-q', 'templates/c.md'), 'v2 刪檔');
  r.syncFrom(v2, { overlay: true });
  assert.throws(() => r.write({ version: v2 }), (e) => e instanceof lock.LockError && /templates\/c\.md：多出來/u.test(e.message) && /先刪掉共用路徑/u.test(e.message), '套件刪掉的檔還留著＝拒寫');
  r.syncFrom(v2);
  r.put('tools/a.js', '// 偷改\n');
  assert.throws(() => r.write({ version: v2 }), (e) => e instanceof lock.LockError && /tools\/a\.js：內容不同/u.test(e.message), '專案改了＝拒寫（沒有例外可記）');
  assert.ok(!fs.existsSync(path.join(r.root, lock.LOCK_FILE)), '拒寫時不留清單');
  r.syncFrom(v2);
  // 版本在本機套件倉庫找不到、路徑不在、沒給、版本碼不是十六進位、日子不存在
  assert.throws(() => r.write({ version: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }), (e) => e instanceof lock.LockError && /找不到版本.*fetch/u.test(e.message));
  assert.throws(() => r.write({ version: v2, kit: path.join(r.scratch, 'nope') }), (e) => e instanceof lock.LockError && /--kit/u.test(e.message), '套件倉庫路徑不在');
  assert.throws(() => r.write({ version: v2, kit: undefined }), (e) => e instanceof lock.LockError && /--kit/u.test(e.message), '沒給 --kit');
  assert.throws(() => r.write({ version: 'main' }), lock.LockError, '版本碼不是十六進位');
  assert.throws(() => r.write({ version: v2, date: '2026-02-31' }), lock.LockError, '不存在的日子');
  assert.throws(() => r.write({ version: v2, repo: undefined }), (e) => /第一次寫清單要給 --repo/u.test(e.message), '第一次寫沒給 repo');
  // 不在主幹上：只在本機、沒推上 origin/main 的提交
  const side = r.kgit('commit-tree', `${v2}^{tree}`, '-p', v2, '-m', 'side').trim();
  assert.throws(() => r.write({ version: side }), (e) => e instanceof lock.LockError && /不在套件主幹（origin\/main）上/u.test(e.message), '沒合併的版本＝拒寫');
  // 跑的這一份工具跟那一版的不一樣
  const v3 = r.nextKit(() => r.putKit('tools/kit-lock.js', `${KIT_FILES['tools/kit-lock.js']}// 套件後來改了工具\n`), 'v3 改工具');
  r.syncFrom(v3);
  assert.throws(() => r.write({ version: v3 }), (e) => e instanceof lock.LockError && /跑的這一份 tools\/kit-lock\.js 跟套件 [0-9a-f]{7} 那一版的不一樣/u.test(e.message));
  r.syncFrom(v2);
  // 本機沒有 origin/main（沒 fetch）；主幹名讀那一版已提交的設定，工作樹上沒提交的改動不算；那一版沒有設定＝退 2
  r.kgit('update-ref', '-d', 'refs/remotes/origin/main');
  assert.throws(() => r.write({ version: v2 }), (e) => e instanceof lock.LockError && /沒有 origin\/main：先 git -C <套件> fetch/u.test(e.message));
  r.publish();
  fs.writeFileSync(path.join(r.kit, 'settings.json'), '{"mainBranch":"elsewhere"}\n');
  assert.doesNotThrow(() => lock.kitVersion(r.kit, v2), '工作樹上沒提交的設定改動不算（主幹名讀那一版已提交的）');
  r.kgit('checkout', '--', 'settings.json');
  const v4 = r.nextKit(() => r.kgit('rm', '-q', 'settings.json'), 'v4 沒有設定');
  assert.throws(() => lock.kitVersion(r.kit, v4), (e) => e instanceof lock.LockError && /讀不到套件 [0-9a-f]{7} 的 settings\.json/u.test(e.message));
  // 對照組：都對了就寫得出來；寫了之後再寫＝拒寫，指去 --sync
  r.write({ version: v2 });
  const before = fs.readFileSync(path.join(r.root, lock.LOCK_FILE), 'utf8');
  assert.throws(() => r.write({ version: v2 }), (e) => e instanceof lock.LockError && /已經有 kit-lock\.json：--write 只用在第一次裝；之後同步用 --sync/u.test(e.message));
  assert.equal(fs.readFileSync(path.join(r.root, lock.LOCK_FILE), 'utf8'), before, '拒寫時清單一個位元組都不動');
  // 提交過清單之後在工作樹上刪掉、或連刪除一起提交，再 --write＝想繞過 --sync 的同步前檢查：照樣拒寫
  r.commit('清單');
  fs.rmSync(path.join(r.root, lock.LOCK_FILE));
  assert.throws(() => r.write({ version: v2 }), (e) => e instanceof lock.LockError && /這棵樹的歷史裡有過 kit-lock\.json：不是第一次裝，同步用 --sync/u.test(e.message));
  r.commit('拿掉清單');
  assert.throws(() => r.write({ version: v2 }), (e) => e instanceof lock.LockError && /歷史裡有過 kit-lock\.json/u.test(e.message), '刪除也提交了，歷史裡還是有');
  assert.ok(!fs.existsSync(path.join(r.root, lock.LOCK_FILE)), '拒寫時不留清單');
});

test('--check：改內容、多一個檔、少一個檔、改權限各自紅並指名路徑、說去哪改；被忽略的檔看不到（照實）；共用路徑以外不比', (t) => {
  const r = makeRepos(t);
  r.write();
  const red = (why, kind, p) => {
    const c = lock.check(r.root);
    assert.equal(c.ok, false, why);
    assert.ok(c.problems.includes(`${p}：${kind}`), `${why}：${c.problems.join(' / ')}`);
    assert.match(c.fix, /只在套件改（規矩 D5）.*--sync.*重跑 node tools\/kit-lock\.js --check/u, '紅的時候說去哪改、怎麼重跑');
  };
  const green = (why) => { const c = lock.check(r.root); assert.equal(c.ok, true, `${why}：${c.problems.join(' / ')}`); };
  r.put('tools/a.js', '// changed\n');
  red('改了共用檔', '內容不同', 'tools/a.js');
  r.git('checkout', '--', 'tools/a.js');
  green('還原就綠');
  r.put('tools/extra.js', '// 專案偷放的\n');
  red('共用資料夾多放一個檔（沒追蹤也算）', '多出來', 'tools/extra.js');
  fs.rmSync(path.join(r.root, 'tools', 'extra.js'));
  fs.rmSync(path.join(r.root, 'templates', 'c.md'));
  red('刪掉共用檔', '少掉', 'templates/c.md');
  r.git('checkout', '--', 'templates/c.md');
  fs.chmodSync(path.join(r.root, 'RULES.md'), 0o755);
  red('只改擁有者的執行位元', '權限不同', 'RULES.md');
  fs.chmodSync(path.join(r.root, 'RULES.md'), 0o644);
  green('權限改回來就綠');
  r.put('.gitignore', '*.log\n');
  r.put('tools/x.log', 'ignored\n');
  green('被 .gitignore 忽略的檔這一題看不到（守不到的，寫在檔頭；--sync 看得到）');
  r.put('lib/own.js', '// 改專案自己的\n');
  r.put('settings.json', '{"x":2}\n');
  green('共用路徑以外的檔不比');
});

test('舊格式的清單：空的 exceptions 照收；例外段還有內容＝退 2（例外已取消），連 --check 也不算', (t) => {
  const r = makeRepos(t);
  r.write();
  r.saveLock({ ...r.lockJson(), exceptions: [] });
  assert.equal(lock.check(r.root).ok, true, '2026-10-15 以前寫的清單都帶空的 exceptions：照收');
  r.put('tools/a.js', '// 專案先改\n');
  r.saveLock({ ...r.lockJson(), exceptions: [{ path: 'tools/a.js', why: '先在專案修', who: 'agent-a', since: '2026-09-29' }] });
  assert.throws(() => lock.check(r.root), (e) => e instanceof lock.LockError && /exceptions 還有 1 筆：例外已經取消（擁有者 2026-10-15，規矩 D5）/u.test(e.message), '記了例外也不放行');
  r.saveLock({ ...r.lockJson(), exceptions: {} });
  assert.throws(() => lock.check(r.root), (e) => e instanceof lock.LockError && /exceptions（舊格式留下的欄）要是空陣列/u.test(e.message));
});

test('--check：符號連結記 120000 與目標字串的雜湊（等於 ls-tree），改指向就紅', (t) => {
  const r = makeRepos(t);
  const v = r.nextKit(() => fs.symlinkSync('a.js', path.join(r.kit, 'tools', 'link.js')), 'link');
  r.syncFrom(v);
  const { lock: written } = r.write({ version: v });
  const [meta] = r.kgit('ls-tree', v, '--', 'tools/link.js').trim().split('\t');
  const [mode, , blob] = meta.split(' ');
  assert.deepEqual(written.entries.find((e) => e.path === 'tools/link.js'), { mode, blob, path: 'tools/link.js' });
  assert.equal(mode, '120000');
  assert.equal(lock.check(r.root).ok, true);
  fs.rmSync(path.join(r.root, 'tools', 'link.js'));
  fs.symlinkSync('forbidden-tools.js', path.join(r.root, 'tools', 'link.js'));
  assert.ok(lock.check(r.root).problems.includes('tools/link.js：內容不同'));
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

test('清單本身壞掉：每一種形狀錯都退 2 不猜（對照組：好的清單要過）', (t) => {
  const r = makeRepos(t);
  r.write();
  const good = r.lockJson();
  assert.doesNotThrow(() => lock.validateLock(JSON.parse(JSON.stringify(good))), '對照組：好的清單要過');
  const mutate = (why, f) => { const j = JSON.parse(JSON.stringify(good)); f(j); assert.throws(() => lock.validateLock(j), lock.LockError, why); };
  mutate('多一欄', (j) => { j.note = 'x'; });
  mutate('少 entries', (j) => { delete j.entries; });
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
  mutate('路徑結尾有空白', (j) => { j.entries[0].path = `${j.entries[0].path} `; });
  mutate('路徑不在共用範圍', (j) => { j.entries[0].path = 'lib/own.js'; });
  mutate('entries 沒排序', (j) => { j.entries.reverse(); });
  mutate('entries 重複', (j) => { j.entries.push({ ...j.entries[0] }); });
  mutate('entries 少欄位', (j) => { delete j.entries[0].mode; });
  mutate('exceptions 有內容', (j) => { j.exceptions = [{ path: 'tools/a.js', why: 'x', who: 'y', since: '2026-09-29' }]; });
  mutate('exceptions 不是陣列', (j) => { j.exceptions = null; });
  fs.writeFileSync(path.join(r.root, lock.LOCK_FILE), '{not json');
  assert.throws(() => lock.check(r.root), lock.LockError, '不是 JSON');
  fs.rmSync(path.join(r.root, lock.LOCK_FILE));
  assert.throws(() => lock.check(r.root), lock.LockError, '清單不在');
});

test('--sync：先預演（一個檔都不動），--apply 才換；換完工作樹＝套件那一版、套件刪掉的檔不留、專案自己的檔（含共用檔的鄰居）逐位元組不變、新清單沒有例外段', (t) => {
  const r = makeRepos(t);
  r.write();
  r.commit('清單');
  const v2 = r.nextKit(() => {
    r.putKit('tools/a.js', '// 套件改了\n');
    r.putKit('tools/forbidden-tools.js', '// 新版攔截器\n');
    r.putKit('templates/hook-codex-global.json', '{"v":2}\n');
    r.putKit('templates/new.md', '# 套件新加的範本\n');
    r.kgit('rm', '-q', 'templates/c.md');
  }, 'v2');
  const before = snapshot(r.root);
  const dry = r.doSync(v2);
  assert.equal(dry.ok, true, dry.lines.join('\n'));
  assert.deepEqual(dry.lines, [
    PASSED,
    `跟上一份清單（${r.v1.slice(0, 7)}，2026-09-29）比：套件這一版有 5 個共用檔不一樣`,
    '  ・templates/c.md：套件這一版刪掉', '  ・templates/hook-codex-global.json：內容不同', '  ・templates/new.md：套件這一版新加',
    '  ・tools/a.js：內容不同', '  ・tools/forbidden-tools.js：內容不同',
    `預演：沒有動任何檔。確認後在同一行加 --apply 才換檔（換成套件 ${v2.slice(0, 7)}）`,
  ]);
  assert.deepEqual(snapshot(r.root), before, '預演一個檔都不動（連清單）');

  const own = Object.fromEntries(['settings.json', 'lib/own.js', 'docs/own.md', 'cases/own.md'].map((p) => [p, fs.readFileSync(path.join(r.root, p))]));
  const done = r.doSync(v2, { apply: true, repo: 'acct/kit2' });
  assert.equal(done.ok, true, done.lines.join('\n'));
  assert.deepEqual(done.lines.slice(0, 7), dry.lines.slice(0, 7), '換之前印的跟預演一樣');
  assert.equal(done.lines[7], FIXED, '動到指紋檔與 Codex 範本時，也只印同一行固定提醒、不判斷');
  assert.equal(done.lines[8], `寫好 ${lock.LOCK_FILE}：套件 acct/kit2 ${v2}（2026-10-15），12 筆`);
  assert.equal(done.lines.length, 9);
  assert.deepEqual(lock.entries(r.root), lsTree(r, v2), '工作樹的共用檔＝套件 v2 的 ls-tree');
  assert.ok(!fs.existsSync(path.join(r.root, 'templates', 'c.md')), '套件刪掉的檔不留');
  assert.deepEqual(r.lockJson(), { repo: 'acct/kit2', version: v2, syncedAt: '2026-10-15', entries: lsTree(r, v2) }, '--repo 蓋過上一份；沒有 exceptions 欄');
  for (const [p, body] of Object.entries(own)) assert.deepEqual(fs.readFileSync(path.join(r.root, p)), body, `${p} 逐位元組不變`);
  assert.equal(lock.check(r.root).ok, true);
  // 同一版再同步一次：沒有要換的也照常過（不是往回）
  r.commit('同步 v2');
  assert.equal(r.doSync(v2).ok, true);
});

test('--sync 擋下會被蓋掉或刪掉的東西：已提交、暫存、未暫存、沒追蹤、被忽略、刪檔、改權限、改名、清單被手改過、連結、大小寫、標記——預演與 --apply 都不換、一個檔都不動', (t) => {
  const r = makeRepos(t);
  r.write();
  r.commit('清單');
  const base = r.git('rev-parse', 'HEAD').trim();
  const v2 = r.nextKit(() => r.putKit('tools/a.js', '// 套件改了\n'), 'v2');
  const outside = path.join(r.scratch, 'outside');
  const editLock = (f) => { const j = r.lockJson(); f(j); r.saveLock(j); };
  const short1 = r.v1.slice(0, 7);
  /** 回到乾淨的 base：先還原、再拿掉上一輪留下的標記（檔案要在索引裡才拿得掉）、再還原一次，清掉沒追蹤的與樹外那一份。 */
  const resetTo = (sha) => {
    fs.chmodSync(r.root, 0o755);
    for (const name of ['.git', '.GIT']) fs.rmSync(path.join(r.root, 'tools', name), { recursive: true, force: true });
    r.git('reset', '-q', '--hard', sha);
    for (const [flag, file] of [['--no-skip-worktree', 'MACHINES.md'], ['--no-assume-unchanged', 'GLOSSARY.md']]) r.git('update-index', flag, file);
    r.git('reset', '-q', '--hard', sha);
    r.git('clean', '-q', '-fdx');
    fs.rmSync(outside, { recursive: true, force: true });
  };
  for (const [why, mutate, expect] of [
    ['已提交的改動', () => { r.put('RULES.md', '# 專案改的規矩\n'); r.commit('專案改'); }, /^ {2}・RULES\.md：已提交的版本內容跟清單不同$/mu],
    ['已提交、專案自己加的檔', () => { r.put('tests/own.test.js', '// 專案自己的考題\n'); r.commit('專案加'); }, /^ {2}・tests\/own\.test\.js：已提交的版本多出清單沒有的檔$/mu],
    ['已提交的刪檔', () => { r.git('rm', '-q', 'GLOSSARY.md'); r.commit('專案刪'); }, /^ {2}・GLOSSARY\.md：已提交的版本少了這個檔$/mu],
    ['暫存區的改動', () => { r.put('tools/a.js', '// 暫存\n'); r.git('add', 'tools/a.js'); }, /^ {2}・tools\/a\.js：還沒提交的改動（git status：M·）$/mu],
    ['工作樹的改動', () => { r.put('MACHINES.md', '# 沒暫存\n'); }, /^ {2}・MACHINES\.md：還沒提交的改動（git status：·M）$/mu],
    ['工作樹刪檔', () => { fs.rmSync(path.join(r.root, 'templates', 'c.md')); }, /^ {2}・templates\/c\.md：工作樹上少了這個檔$/mu],
    ['沒追蹤的檔', () => { r.put('tools/local.js', '// 沒追蹤\n'); }, /^ {2}・tools\/local\.js：沒追蹤的檔$/mu],
    ['被忽略的檔', () => { r.put('.gitignore', '*.log\n'); r.commit('忽略'); r.put('tests/run.log', 'x\n'); }, /^ {2}・tests\/run\.log：被忽略的檔/mu],
    ['改權限', () => { fs.chmodSync(path.join(r.root, 'RULES.md'), 0o755); }, /^ {2}・RULES\.md：工作樹上權限跟清單不同$/mu],
    ['暫存的改名（git status 一筆有兩段路徑）', () => { r.git('mv', 'tools/a.js', 'tools/renamed.js'); }, /^ {2}・tools\/renamed\.js：還沒提交的改動（git status：R·）$/mu],
    ['清單被手改過：改一筆內容（連清單一起改、提交）', () => {
      r.put('tools/a.js', '// 專案改了、清單也跟著改\n');
      editLock((j) => { j.entries.find((e) => e.path === 'tools/a.js').blob = r.blobOf('// 專案改了、清單也跟著改\n'); });
      r.commit('連清單一起改');
      assert.equal(lock.check(r.root).ok, true, '前提：--check 只比工作樹對清單，連清單一起改它照樣綠（絆線不是鎖）');
    }, new RegExp(`^ {2}・tools/a\\.js：內容跟清單記的不同——跟套件 ${short1} 那一版對不上（清單被手改過？）$`, 'mu')],
    ['清單被手改過：少列一筆（刪檔、清單拿掉那一筆、提交）', () => {
      r.git('rm', '-q', 'GLOSSARY.md');
      editLock((j) => { j.entries = j.entries.filter((e) => e.path !== 'GLOSSARY.md'); });
      r.commit('刪檔連清單');
      assert.equal(lock.check(r.root).ok, true, '前提：--check 照樣綠');
    }, new RegExp(`^ {2}・GLOSSARY\\.md：清單少列了這個檔——跟套件 ${short1} 那一版對不上`, 'mu')],
    ['清單被手改過：改權限（權限與清單一起改、提交）', () => {
      fs.chmodSync(path.join(r.root, 'RULES.md'), 0o755);
      editLock((j) => { j.entries.find((e) => e.path === 'RULES.md').mode = '100755'; });
      r.commit('改權限連清單');
      assert.equal(lock.check(r.root).ok, true, '前提：--check 照樣綠');
    }, new RegExp(`^ {2}・RULES\\.md：權限跟清單記的不同——跟套件 ${short1} 那一版對不上`, 'mu')],
    ['共用檔的上一層是連結（指到專案自己的資料夾）', () => {
      fs.rmSync(path.join(r.root, 'cases'), { recursive: true, force: true });
      r.put('lib/cases/DIGEST.md', '# 專案自己的、放在連結目標裡\n');
      fs.symlinkSync('lib/cases', path.join(r.root, 'cases'));
      r.commit('cases 換成連結');
    }, /^ {2}・cases：是連結，共用路徑 cases\/DIGEST\.md 在它底下——換檔會穿過它刪到別處/mu],
    ['共用檔的上一層是連結（指到樹外）', () => {
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'money-guard-two-pattern-tables.md'), '# 樹外、不在 git 裡\n');
      fs.rmSync(path.join(r.root, 'docs'), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(r.root, 'docs'));
    }, /^ {2}・docs：是連結，共用路徑 docs\/money-guard-two-pattern-tables\.md 在它底下/mu],
    ['只差大小寫的同名路徑（已提交）', () => {
      r.git('update-index', '--add', '--cacheinfo', `100644,${r.blobOf('// 大小寫不同的同名檔\n', true)},Tools/own.js`);
      r.git('commit', '-q', '-m', '大小寫不同的同名檔');
    }, /^ {2}・Tools\/own\.js：只差大小寫的同名路徑/mu],
    ['已追蹤的共用資料夾裡另開一個倉庫（外層 git 看不到它的 .git）', () => {
      const inner = (...args) => assert.equal(spawnSync('git', args, { cwd: path.join(r.root, 'tools'), env: r.env }).status, 0, `內層 git ${args[0]}`);
      inner('init', '-q');
      inner('add', '-A');
      inner('commit', '-q', '-m', '只在內層的提交');
      assert.equal(r.git('status', '--porcelain', '--ignored=matching', '--', 'tools').trim(), '', '前提：外層 git 完全看不到它');
    }, /^ {2}・tools\/\.git：共用路徑底下另有一個倉庫的 git 紀錄/mu],
    ['大小寫不分的磁碟上的 .GIT（另一個倉庫，名字只差大小寫）', () => {
      const inner = (...args) => assert.equal(spawnSync('git', args, { cwd: path.join(r.root, 'tools'), env: r.env }).status, 0, `內層 git ${args[0]}`);
      inner('init', '-q');
      inner('add', '-A');
      inner('commit', '-q', '-m', '只在內層的提交');
      fs.renameSync(path.join(r.root, 'tools', '.git'), path.join(r.root, 'tools', '.GIT'));
    }, /^ {2}・tools\/\.GIT：共用路徑底下另有一個倉庫的 git 紀錄/mu],
    ['專案根目錄寫不進去（新清單寫不了）', () => { fs.chmodSync(r.root, 0o555); }, /^ {2}・kit-lock\.json：專案根目錄寫不進去（權限）/mu],
    ['跳過工作樹的標記藏起來的改動', () => { r.git('update-index', '--skip-worktree', 'MACHINES.md'); r.put('MACHINES.md', '# 藏起來的改動\n'); }, /^ {2}・MACHINES\.md：標了跳過工作樹或假設沒改/mu],
    ['假設沒改的標記藏起來的改動', () => { r.git('update-index', '--assume-unchanged', 'GLOSSARY.md'); r.put('GLOSSARY.md', '# 藏起來的改動\n'); }, /^ {2}・GLOSSARY\.md：標了跳過工作樹或假設沒改/mu],
  ]) {
    resetTo(base);
    mutate();
    const before = snapshot(r.root);
    const beforeOutside = fs.existsSync(outside) ? snapshot(outside) : null;
    for (const apply of [false, true]) {
      const res = r.doSync(v2, { apply });
      assert.equal(res.ok, false, `${why}（apply=${apply}）：要擋下\n${res.lines.join('\n')}`);
      const out = res.lines.join('\n');
      assert.match(out, expect, `${why}：要指名哪個檔、哪一種\n${out}`);
      assert.doesNotMatch(out, /^ {2}・ls\//mu, `${why}：改名那一筆的原路徑不能被當成另一筆亂切\n${out}`);
      assert.match(res.lines[0], /^同步前檢查：查到 \d+ 處不能直接換（清單記的是套件 [0-9a-f]{7}）$/u);
      const last = res.lines[res.lines.length - 1];
      assert.match(last, /一個檔都沒動、清單也沒動.*（規矩 D5）.*先告訴擁有者：要留的先搬到協作套件.*重跑同一行 --sync/u, '說下一步：告訴擁有者、搬到套件或改回、重跑');
      assert.deepEqual(snapshot(r.root), before, `${why}（apply=${apply}）：擋下時一個檔都不動（連清單）`);
      if (beforeOutside) assert.deepEqual(snapshot(outside), beforeOutside, `${why}（apply=${apply}）：樹外的檔一個都不動`);
    }
  }
  // 對照組：回到乾淨的主幹就換得過去（證明上面每一種是被那一處擋下，不是別的原因）
  resetTo(base);
  assert.equal(r.doSync(v2, { apply: true }).ok, true);
});

test('--sync：套件這一版新加的檔會被專案的忽略規則忽略＝預演就擋下（解開後 git 看不到，換檔會停在半路）', (t) => {
  const r = makeRepos(t);
  r.put('.gitignore', '*.log\n');
  r.write();
  r.commit('清單與忽略規則');
  const v2 = r.nextKit(() => r.putKit('tests/fixtures/sample.log', 'x\n'), 'v2 新加會被忽略的檔');
  const before = snapshot(r.root);
  for (const apply of [false, true]) {
    const res = r.doSync(v2, { apply });
    assert.equal(res.ok, false, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /^ {2}・tests\/fixtures\/sample\.log：套件這一版要放進來的檔，會被專案的忽略規則忽略/mu);
    assert.deepEqual(snapshot(r.root), before);
  }
  r.put('.gitignore', '*.log\n!tests/fixtures/*.log\n');
  r.commit('不忽略套件那個檔');
  assert.equal(r.doSync(v2, { apply: true }).ok, true, '對照組：改了專案的忽略規則就換得過去');
});

test('--sync 的環境問題退 2 不猜：沒有清單、清單還有例外、清單記的版本找不到、往回同步、清單指到沒合併的版本、版本不在主幹上、工具不是那一版的、--root 不是倉庫最上層、套件新版的檔名清單收不下', (t) => {
  const r = makeRepos(t);
  const v2 = r.nextKit(() => r.putKit('tools/a.js', '// v2\n'), 'v2');
  assert.throws(() => r.doSync(v2), (e) => e instanceof lock.LockError && /沒有 kit-lock\.json.*--write/u.test(e.message), '還沒裝過＝第一次裝用 --write');
  r.write();
  r.commit('清單');
  const side = r.kgit('commit-tree', `${v2}^{tree}`, '-p', v2, '-m', 'side').trim();
  assert.throws(() => r.doSync(side), (e) => e instanceof lock.LockError && /不在套件主幹/u.test(e.message));
  const v3 = r.nextKit(() => r.putKit('tools/kit-lock.js', `${KIT_FILES['tools/kit-lock.js']}// 套件後來改了工具\n`), 'v3 改工具');
  assert.throws(() => r.doSync(v3), (e) => e instanceof lock.LockError && /跑的這一份 tools\/kit-lock\.js/u.test(e.message), '用別版的工具同步，共用路徑的範圍可能對不上');
  assert.throws(() => lock.sync(path.join(r.root, 'lib'), { kit: r.kit, version: v2 }), (e) => e instanceof lock.LockError && /--root 要是使用專案倉庫的最上層/u.test(e.message));
  assert.throws(() => r.doSync(v2, { date: '2026-13-01' }), (e) => e instanceof lock.LockError && /--date/u.test(e.message));
  const good = r.lockJson();
  r.saveLock({ ...good, exceptions: [{ path: 'tools/a.js', why: 'x', who: 'y', since: '2026-09-29' }] });
  assert.throws(() => r.doSync(v2), (e) => e instanceof lock.LockError && /例外已經取消/u.test(e.message), '還有例外＝先搬回套件，不能同步時清掉');
  r.saveLock({ ...good, version: 'f'.repeat(40) });
  assert.throws(() => r.doSync(v2), (e) => e instanceof lock.LockError && /清單記的套件版本 fffffff 在本機套件倉庫找不到/u.test(e.message));
  // 清單指到沒合併的套件提交（例如套件 PR 還在審的那一顆）：核得出來
  const pr = r.kgit('commit-tree', `${r.v1}^{tree}`, '-p', r.v1, '-m', '沒合併的套件 PR').trim();
  r.saveLock({ ...good, version: pr });
  assert.throws(() => r.doSync(v2), (e) => e instanceof lock.LockError && /不在要同步的 [0-9a-f]{7} 之前：往回同步、清單指到沒合併的版本/u.test(e.message));
  r.saveLock(good);
  assert.equal(r.doSync(v2).ok, true, '對照組：清單改回來就過');
  // 往回同步：同步到 v2 之後再要回 v1
  assert.equal(r.doSync(v2, { apply: true }).ok, true);
  r.commit('同步 v2');
  assert.throws(() => r.doSync(r.v1), (e) => e instanceof lock.LockError && /往回同步/u.test(e.message), '錢的攔截器可能被換回舊版：只往前');
  // 套件新版有清單收不下的檔名（結尾帶空白）：預演就退 2，不是換完才發現
  const v4 = r.nextKit(() => { r.putKit('tools/kit-lock.js', KIT_FILES['tools/kit-lock.js']); r.putKit('tools/trailing.js ', '//\n'); }, 'v4 工具改回、加怪檔名');
  const before = snapshot(r.root);
  for (const apply of [false, true]) assert.throws(() => r.doSync(v4, { apply }), (e) => e instanceof lock.LockError && /形狀不對/u.test(e.message));
  assert.deepEqual(snapshot(r.root), before, '一個檔都不動');
});

test('--sync 的主幹名照套件那一版已提交的設定（不寫死 main）', (t) => {
  const r = makeRepos(t);
  r.write();
  r.commit('清單');
  const v2 = r.nextKit(() => { r.putKit('settings.json', '{"mainBranch":"trunk"}\n'); r.putKit('tools/a.js', '// v2\n'); }, 'v2 主幹改名', 'trunk');
  assert.equal(r.doSync(v2).ok, true, '主幹叫 trunk、origin/trunk 在：照常');
  r.kgit('update-ref', '-d', 'refs/remotes/origin/trunk');
  assert.throws(() => r.doSync(v2), (e) => e instanceof lock.LockError && /沒有 origin\/trunk/u.test(e.message), '只有 origin/main、沒有 origin/trunk：不拿 main 頂替');
});

/** 把訊息裡印的還原指令原字串交給 shell 跑（不是拿參數陣列直接叫 git）；X 設成別的值，路徑裡的 $X 被展開就會找錯資料夾。 */
function runPrinted(r, msg) {
  const lines = lock.restoreLines(r.root, lock.readLock(r.root));
  for (const line of lines) {
    assert.ok(msg.includes(line), `訊息要逐字印出這一行還原指令：${line}\n${msg}`);
    const p = spawnSync('/bin/sh', ['-c', line], { env: { ...r.env, X: 'somewhere-else' }, encoding: 'utf8' });
    assert.equal(p.status, 0, `照貼的還原指令要跑得過：${line}\n${p.stderr}`);
  }
  return lines;
}

test('--sync --apply 換到一半對不上（套件那一版打包時少了檔）：退 2、印的還原指令照貼給 shell 跑（路徑有空白、$、單引號）真的把專案還原到同步前（連套件新加的檔一起清掉）', (t) => {
  const r = makeRepos(t, { projName: "my proj $X it's" });
  r.write();
  r.commit('清單');
  // 套件在根目錄加了 export-ignore：git archive 打包時會漏掉 templates/c.md，解開後跟那一版的 ls-tree 對不上
  const v2 = r.nextKit(() => { r.putKit('.gitattributes', 'templates/c.md export-ignore\n'); r.putKit('tools/a.js', '// v2\n'); r.putKit('templates/new2.md', '# 套件新加\n'); }, 'v2');
  const before = snapshot(r.root);
  let msg = '';
  assert.throws(() => r.doSync(v2, { apply: true }), (e) => { msg = e.message; return e instanceof lock.LockError; });
  assert.match(msg, new RegExp(`解開之後工作樹跟套件 ${v2.slice(0, 7)} 還有 1 個對不上：templates/c\\.md：少掉`, 'u'));
  assert.ok(!lock.restoreCommands(lock.readLock(r.root))[0].includes('cases/DIGEST.md'), '已提交的版本沒有的共用路徑不放進 checkout（git checkout 會退非零）');
  assert.ok(fs.existsSync(path.join(r.root, 'templates', 'new2.md')), '前提：套件新加的檔已經解開了（還原要把它清掉）');
  runPrinted(r, msg);
  assert.deepEqual(snapshot(r.root), before, '照印的指令還原＝同步前一模一樣');
  assert.equal(r.git('status', '--porcelain').trim(), '', '還原後工作樹乾淨');
});

test('--sync --apply 刪共用路徑刪到一半失敗（唯讀資料夾）：退 2、印還原指令，照印的還原回到同步前', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('以 root 跑時唯讀資料夾刪得掉，造不出這種失敗'); return; }
  const r = makeRepos(t);
  r.write();
  r.commit('清單');
  const v2 = r.nextKit(() => r.putKit('tools/a.js', '// v2\n'), 'v2');
  const before = snapshot(r.root);
  const locked = path.join(r.root, 'templates');
  fs.chmodSync(locked, 0o555);
  t.after(() => { try { fs.chmodSync(locked, 0o755); } catch { /* 已經被還原指令重建 */ } });
  let msg = '';
  assert.throws(() => r.doSync(v2, { apply: true }), (e) => { msg = e.message; return e instanceof lock.LockError; });
  assert.match(msg, /刪共用路徑時失敗（E[A-Z]+）。工作樹已經動過/u);
  fs.chmodSync(locked, 0o755);
  runPrinted(r, msg);
  assert.deepEqual(snapshot(r.root), before, '照印的指令還原＝同步前一模一樣');
});

test('--sync --apply 換完寫新清單失敗（寫到一半、或最後換名失敗）：清單還是原來那一份、不留暫存檔，訊息說共用檔已換、印的還原照貼回到同步前', (t) => {
  for (const how of ['寫到一半', '換名失敗']) {
    const r = makeRepos(t);
    r.write();
    r.commit('清單');
    const v2 = r.nextKit(() => r.putKit('tools/a.js', '// v2\n'), 'v2');
    const before = snapshot(r.root);
    const lockBefore = fs.readFileSync(path.join(r.root, lock.LOCK_FILE));
    const realWrite = fs.writeFileSync;
    const realRename = fs.renameSync;
    const boom = () => { const e = new Error('寫不進去（考題造的）'); e.code = 'EFBIG'; return e; };
    if (how === '寫到一半') {
      fs.writeFileSync = (file, data, ...rest) => {
        if (!String(file).includes(lock.LOCK_FILE)) return realWrite.call(fs, file, data, ...rest);
        realWrite.call(fs, file, String(data).slice(0, 13), ...rest);   // 先寫進 13 個字元、再失敗
        throw boom();
      };
    } else {
      fs.renameSync = (from, to) => { if (String(to).endsWith(lock.LOCK_FILE)) throw boom(); return realRename.call(fs, from, to); };
    }
    let msg = '';
    try {
      assert.throws(() => r.doSync(v2, { apply: true }), (e) => { msg = e.message; return e instanceof lock.LockError; });
    } finally { fs.writeFileSync = realWrite; fs.renameSync = realRename; }
    assert.match(msg, new RegExp(`共用檔已經換成套件 ${v2.slice(0, 7)}，寫新清單卻失敗（EFBIG），清單還是舊的那一版`, 'u'), how);
    assert.equal(fs.readFileSync(path.join(r.root, 'tools', 'a.js'), 'utf8'), '// v2\n', `${how}：前提：共用檔真的已經換了`);
    assert.deepEqual(fs.readFileSync(path.join(r.root, lock.LOCK_FILE)), lockBefore, `${how}：正式清單一個位元組都沒變（訊息說「還是舊的那一版」是真的）`);
    assert.deepEqual(fs.readdirSync(r.root).filter((n) => n.includes(lock.LOCK_FILE) && n !== lock.LOCK_FILE), [], `${how}：不留暫存檔`);
    runPrinted(r, msg);
    assert.deepEqual(snapshot(r.root), before, `${how}：照印的指令還原＝同步前一模一樣`);
    assert.equal(lock.check(r.root).ok, true, `${how}：還原後 --check 綠`);
  }
});

test('名字像 .git 的都算另一個倉庫的紀錄（大小寫、看不見的字元、結尾點與空白、短檔名），長得像但不是的不算', (t) => {
  const zw = String.fromCharCode(0x200c);
  for (const name of ['.git', '.GIT', '.Git', '.git.', '.git ', 'GIT~1', `.g${zw}it`]) assert.equal(lock.gitLikeName(name), true, JSON.stringify(name));
  for (const name of ['.gitignore', '.github', 'git', '.gitattributes', 'digit']) assert.equal(lock.gitLikeName(name), false, JSON.stringify(name));
  const r = makeRepos(t);
  fs.mkdirSync(path.join(r.root, 'tests', 'deep', '.Git'), { recursive: true });
  fs.writeFileSync(path.join(r.root, 'templates', 'GIT~1'), 'gitdir: x\n');
  fs.symlinkSync(r.root, path.join(r.root, 'tools', 'loop'));   // 不跟著連結走（不然會繞回自己）
  assert.deepEqual(lock.nestedGit(r.root), ['templates/GIT~1', 'tests/deep/.Git']);
});

test('--sync：套件舊版的共用範圍比新版小（新版才把舊版就有的檔納入），清單照舊版自己的範圍核，不誤判成清單少列', (t) => {
  const r = makeRepos(t);
  const narrow = KIT_FILES['tools/kit-lock.js'].replace(", 'cases/DIGEST.md']", ']');
  assert.notEqual(narrow, KIT_FILES['tools/kit-lock.js'], '前提：造得出一份共用範圍較小的舊工具');
  const vOld = r.nextKit(() => { r.putKit('tools/kit-lock.js', narrow); r.putKit('cases/DIGEST.md', '# 舊版就有、但還不是共用檔\n'); }, '舊版：範圍不含 cases/DIGEST.md');
  // 專案照舊版同步（舊範圍不含 cases/DIGEST.md）：舊工具寫的清單只列舊範圍的檔
  r.put('tools/kit-lock.js', narrow);
  r.saveLock({ repo: 'acct/kit', version: vOld, syncedAt: '2026-10-01', entries: lsTree(r, vOld).filter((e) => e.path !== 'cases/DIGEST.md') });
  r.commit('照舊版同步');
  const v2 = r.nextKit(() => { r.putKit('tools/kit-lock.js', KIT_FILES['tools/kit-lock.js']); r.putKit('tools/a.js', '// v2\n'); }, '新版：範圍加了 cases/DIGEST.md');
  const res = r.doSync(v2);
  assert.equal(res.ok, true, `舊版範圍裡清單沒少列：照常過\n${res.lines.join('\n')}`);
  assert.ok(res.lines.includes('  ・cases/DIGEST.md：套件這一版新加'), res.lines.join('\n'));
  assert.equal(r.doSync(v2, { apply: true }).ok, true);
  assert.ok(fs.existsSync(path.join(r.root, 'cases', 'own.md')), '專案自己的案例檔留著');
});

// 擁有者 2026-09-29 裁 a：不判斷這次動到沒有，每次都印同一行固定提醒；有沒有動到由實作者看 PR 對主幹的差異告訴擁有者。
test('--sync 的提醒是固定的一行：不論這次改了什麼（一般檔、指紋檔、Codex 範本、刪檔），都印同一句、點名那 5 樣、不說「沒動到」', (t) => {
  const r = makeRepos(t);
  const outs = [r.write().lines];
  r.commit('清單');
  for (const [msg, edit] of [
    ['只改一般檔', () => r.putKit('tools/a.js', '// v2\n')],
    ['只改指紋檔', () => r.putKit('tools/forbidden-tools.js', '// v3\n')],
    ['只改 Codex 範本', () => r.putKit('templates/hook-codex-global.json', '{"v":4}\n')],
    ['刪掉一個檔', () => r.kgit('rm', '-q', 'templates/c.md')],
  ]) {
    const v = r.nextKit(edit, msg);
    const res = r.doSync(v, { apply: true });
    assert.equal(res.ok, true, res.lines.join('\n'));
    outs.push(res.lines);
    r.commit(`同步 ${msg}`);
  }
  for (const out of outs) {
    assert.equal(out.filter((l) => l === FIXED).length, 1, `每一次都剛好一行固定提醒：\n${out.join('\n')}`);
    assert.ok(!out.some((l) => /沒動到|不用換|這支 PR 對 /u.test(l)), `不做判斷：\n${out.join('\n')}`);
  }
  for (const item of [...lock.FINGERPRINT_SHARED, 'settings.json 的 forbidden 那一塊', lock.CODEX_TEMPLATE]) assert.ok(FIXED.includes(item), item);
});

test('名單對得上：指紋清單、Codex 接線範本、工具自己的路徑；SHARED_PATHS 那一行的寫法讀得回來（--sync 從套件舊版讀它）', () => {
  assert.deepEqual(lock.FINGERPRINT_SHARED, ['tools/forbidden-tools.js', 'tools/package.json', 'tools/settings-data.js']);
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'guard-copy.js'), 'utf8');
  const m = /^const TEMPLATE_REL = '([^']+)';$/mu.exec(src);
  assert.ok(m, 'guard-copy.js 裡找不到 TEMPLATE_REL 的定義（改名了？這一題要跟著改）');
  assert.equal(lock.CODEX_TEMPLATE, m[1], 'Codex 全域層的接線範本換了檔名：kit-lock.js 的 CODEX_TEMPLATE 要跟著改');
  assert.equal(path.relative(ROOT, TOOL).split(path.sep).join('/'), lock.SELF_REL, '工具搬家了：SELF_REL 要跟著改');
  assert.ok(lock.underShared(lock.SELF_REL), '工具自己是共用檔');
  assert.deepEqual(lock.sharedPathsIn(fs.readFileSync(TOOL, 'utf8'), '這一版'), lock.SHARED_PATHS, 'SHARED_PATHS 要維持一行、單引號的寫法：下一版的 --sync 從這一版讀它');
  assert.throws(() => lock.sharedPathsIn("const SHARED_PATHS = [\n  'tools',\n];\n", '假'), lock.LockError, '拆成多行就讀不出來＝退 2，不猜');
});

test('--touch：開工時分出哪些路徑是協作套件的檔（還不存在的新檔、大小寫不同、./ 與 ../、整個資料夾都算）、清單本身另列，專案的檔不誤判', () => {
  const r = lock.touch([
    'tools/new.js', 'Tools/a.js', './templates/x.md', 'test/../tests/y.test.js', 'tools\\win.js', 'docs', 'cases', 'RULES.md', 'tools/',
    'test/local.test.js', 'settings.json', 'tools2/x.js', 'testsx/a.js', 'docs/other.md', 'cases/foo.md', 'lib/tools/x.js', 'README.md', 'kit-lock.json',
  ]);
  assert.deepEqual(r.shared, ['tools/new.js', 'Tools/a.js', 'templates/x.md', 'tests/y.test.js', 'tools/win.js', 'docs', 'cases', 'RULES.md', 'tools']);
  assert.deepEqual(r.lock, ['kit-lock.json']);
  assert.deepEqual(r.own, ['test/local.test.js', 'settings.json', 'tools2/x.js', 'testsx/a.js', 'docs/other.md', 'cases/foo.md', 'lib/tools/x.js', 'README.md']);
  for (const bad of ['../tools/a.js', '/abs/tools/a.js', 'C:/x', '', '.', `a${String.fromCharCode(10)}b`, '"tools/\\346\\226\\207.js"']) {
    assert.throws(() => lock.touch([bad]), lock.LockError, JSON.stringify(bad));
  }
});

test('指令入口：--check 綠 0 紅 1 壞 2；--sync 過 0、擋下 1、環境 2；--touch 有命中 1、沒有 0、不給路徑列出共用路徑；參數錯退 2 並印用法', (t) => {
  const r = makeRepos(t);
  let p = r.cli('--touch', 'lib/y.js');
  assert.equal(p.status, 0, p.stdout);
  assert.match(p.stdout, /這棵樹沒有 kit-lock\.json：要是在協作套件倉庫自己（上游）跑，這些檔本來就在這裡改/u, '沒有清單時說明在上游跑的情形');
  p = r.cli('--write', '--kit', r.kit, '--version', r.v1, '--repo', 'acct/kit', '--date', '2026-09-29');
  assert.equal(p.status, 0, p.stdout + p.stderr);
  r.commit('清單');
  const good = fs.readFileSync(path.join(r.root, lock.LOCK_FILE), 'utf8');
  p = r.cli('--check');
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /^共用檔清單｜套件 acct\/kit [0-9a-f]{7}（2026-09-29）：12 筆；工作樹跟清單不一樣的 0 個\n全部相同。\n$/u);
  r.put('tools/a.js', '// changed\n');
  p = r.cli('--check');
  assert.equal(p.status, 1, p.stdout);
  assert.match(p.stdout, / {2}・tools\/a\.js：內容不同\n協作套件的檔只在套件改（規矩 D5）/u);
  const v2 = r.nextKit(() => r.putKit('tools/a.js', '// v2\n'), 'v2');
  p = r.cli('--sync', '--kit', r.kit, '--version', v2, '--apply');
  assert.equal(p.status, 1, `專案改過＝擋下退 1：${p.stdout}`);
  assert.match(p.stdout, /tools\/a\.js：還沒提交的改動/u);
  r.git('checkout', '--', 'tools/a.js');
  p = r.cli('--sync', '--kit', r.kit, '--version', v2);
  assert.equal(p.status, 0, p.stdout);
  assert.match(p.stdout, /預演：沒有動任何檔/u);
  p = r.cli('--sync', '--kit', r.kit, '--version', v2, '--apply', '--date', '2026-10-15');
  assert.equal(p.status, 0, p.stdout);
  assert.match(p.stdout, /寫好 kit-lock\.json/u);
  p = r.cli('--sync', '--kit', r.kit, '--version', 'f'.repeat(40));
  assert.equal(p.status, 2, p.stdout);
  p = r.cli('--touch', 'tools/x.js', 'lib/y.js');
  assert.equal(p.status, 1, p.stdout);
  assert.match(p.stdout, /^開工查共用檔：給了 2 個路徑，1 個落在協作套件的檔\n {2}・套件的：tools\/x\.js\n {2}・專案的：lib\/y\.js\n落在套件的那幾個不在這裡改（規矩 D5）：告訴擁有者，由他指派誰去協作套件改/u);
  p = r.cli('--touch', 'kit-lock.json');
  assert.equal(p.status, 1, p.stdout);
  assert.match(p.stdout, / {2}・清單本身：kit-lock\.json（只由 --sync／--write 寫，不手改）/u);
  p = r.cli('--touch', 'lib/y.js');
  assert.equal(p.status, 0, p.stdout);
  p = r.cli('--touch');
  assert.equal(p.status, 0, p.stdout);
  for (const s of lock.SHARED_PATHS) assert.ok(p.stdout.includes(`  ・${s}\n`), `不給路徑時列出共用路徑：${s}`);
  p = r.cli('--touch', '../outside.js');
  assert.equal(p.status, 2, p.stdout);
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
  for (const [args, re] of [
    [['--frobnicate'], /看不懂的參數：--frobnicate\n用法：/u],
    [['--check', '--write'], /只能給一個/u],
    [['--check', '--version', r.v1], /--check 不收 --version/u],
    [['--write', '--apply'], /--write 不收 --apply/u],
    [['--touch', '--kit', r.kit], /--touch 不收 --kit/u],
    [['--check', 'tools/a.js'], /只有 --touch 收路徑/u],
    [[], /要給 --check、--write、--sync、--touch 其中一個/u],
  ]) {
    p = r.cli(...args);
    assert.equal(p.status, 2, `${args.join(' ')}：${p.stdout}`);
    assert.match(p.stdout, re, args.join(' '));
  }
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

test('這棵樹登記帶清單時，工作樹要跟清單對得上（改了協作套件的檔＝紅）', { skip: DECLARED.run ? false : DECLARED.reason }, () => {
  ranTree += 1;
  const c = lock.check(ROOT);
  assert.ok(c.ok, [...c.problems, c.fix].join('\n'));
});

// ⚠️ 這一題要留在檔案最後：它核對登記跟清單在不在一致、而且該跑的那一題真的跑了
test('登記跟清單在不在一致；該跑的真的跑了', () => {
  assert.equal(DECLARED.problem, null, DECLARED.problem || '');
  assert.equal(ranTree, DECLARED.run ? 1 : 0, `登記說${DECLARED.run ? '要跑' : '不跑'}對清單那一題，實際跑了 ${ranTree} 題：跳過的接線接錯了`);
});
