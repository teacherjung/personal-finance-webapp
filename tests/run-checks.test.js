// 守三關執行器（規矩 E2、E3）與兩份呼叫它的範本。
//
// 守得到的：①三關沒登記＝退 2；登記裡混一條「未設定」、空的或形狀錯＝退 2、一條都不跑（r1 Medium⑪）；
//   ②依序跑、第一關紅就停＝退 1；③起不來＝退 2；④全綠＝退 0；
//   ⑤跑之前是裸倉庫＝退 2、跑完變裸倉庫＝退 1（真的用臨時倉庫驗）；⑥子行程看不到 GIT_ 那一族；
//   ⑦推送前鉤子與雲端範本都呼叫這一支、不抄三關；
//   ⑧版本控制認的工作樹根目錄不是這裡（樹被指到別處、或在子目錄跑）：跑之前＝退 2、跑完才歪＝退 1（搬家驗屋 09-13）；
//   ⑨三關跑的過程中倉庫的共用設定或這棵樹自己的設定被改了＝1（就算從這棵樹看生效值健康；原專案 08-09 的形狀）；只讀＝0；
//     有提交卻索引檔不見＝2、跑完才不見＝1；正面控制：空索引、Git 支援的裸儲存庫形狀（含 r3 的三種擴充寫法）都＝0（搬家前準備）。
// ⚠️ 守不到的：三關命令本身對不對；鉤子有沒有被啟用（每個複本要自己設）；雲端有沒有設成必過檢查。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runChecks, runCommand } = require('../tools/run-checks.js');
const { gitEnv } = require('../tools/git-env.js');

const ROOT = path.join(__dirname, '..');
const okTree = () => 'ok';

test('①沒登記＝2；②第一關紅就停＝1；③起不來＝2；④全綠＝0', () => {
  const calls = [];
  const run = (argv) => { calls.push(argv.join(' ')); return argv[0] === 'red' ? { status: 3 } : argv[0] === 'gone' ? { status: null, error: 'ENOENT' } : { status: 0 }; };
  assert.equal(runChecks({ settings: { checks: { commands: [['未設定']] } }, run, tree: okTree }).code, 2);
  assert.equal(runChecks({ settings: {}, run, tree: okTree }).code, 2);
  const r = runChecks({ settings: { checks: { commands: [['a'], ['red'], ['c']] } }, run, tree: okTree });
  assert.equal(r.code, 1);
  assert.deepEqual(calls, ['a', 'red'], '紅了就停，第三關不跑');
  assert.equal(runChecks({ settings: { checks: { commands: [['gone']] } }, run, tree: okTree }).code, 2);
  assert.equal(runChecks({ settings: { checks: { commands: [['a'], ['c']] } }, run, tree: okTree }).code, 0);
  // 混一條壞的：整個退 2，而且一條都不跑（原本會靜靜濾掉、印「全綠（1 關）」）
  for (const mixed of [[['a'], ['未設定']], [['a'], []], [['a'], 'b'], [['a'], ['']], [['a'], [1]]]) {
    calls.length = 0;
    const r = runChecks({ settings: { checks: { commands: mixed } }, run, tree: okTree });
    assert.equal(r.code, 2, JSON.stringify(mixed));
    assert.equal(calls.length, 0, '有一關沒接好就一條都不跑');
    assert.match(r.lines.join('\n'), /還沒接好/u);
  }
});

test('⑤裸倉庫絆線：跑之前壞＝2；跑完變壞＝1（真的用臨時倉庫）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-checks-'));
  try {
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: gitEnv() });   // 規矩 E4：鉤子帶著 GIT_DIR 跑考題時，不清就寫進真倉庫
    git('init', '-q');
    const settings = { checks: { commands: [[process.execPath, '-e', 'process.exit(0)']] } };
    assert.equal(runChecks({ settings, cwd: dir }).code, 0, '正常的工作樹全綠');
    // 一關把倉庫弄成裸倉庫：跑完要抓到
    const breaker = { checks: { commands: [['git', 'config', 'core.bare', 'true']] } };
    const broke = runChecks({ settings: breaker, cwd: dir });
    assert.equal(broke.code, 1);
    assert.match(broke.lines.join('\n'), /跑完之後這棵樹不是工作樹了/u);
    // 現在跑之前就是壞的
    assert.equal(runChecks({ settings, cwd: dir }).code, 2);
    git('config', 'core.bare', 'false');
    assert.equal(runChecks({ settings, cwd: dir }).code, 0);
    assert.equal(runChecks({ settings, cwd: os.tmpdir() }).code, 2, '不在倉庫裡');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⑧樹被指到別處＝不放行：跑之前就歪＝2；跑完才歪＝1；不在根目錄跑＝2（搬家驗屋 09-13）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-checks-wt-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'run-checks-else-'));
  try {
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: gitEnv() });
    git('init', '-q');
    const settings = { checks: { commands: [[process.execPath, '-e', 'process.exit(0)']] } };
    assert.equal(runChecks({ settings, cwd: dir }).code, 0, '對照組：正常的樹全綠');
    fs.mkdirSync(path.join(dir, 'sub'));
    const sub = runChecks({ settings, cwd: path.join(dir, 'sub') });
    assert.equal(sub.code, 2, '在子目錄跑＝根目錄不是這裡');
    assert.match(sub.lines.join('\n'), /根目錄不是這裡/u);
    const pointer = { checks: { commands: [['git', 'config', 'core.worktree', elsewhere]] } };
    const moved = runChecks({ settings: pointer, cwd: dir });
    assert.equal(moved.code, 1, '一關把樹指到別處：跑完要抓到');
    assert.match(moved.lines.join('\n'), /被指到別處了/u);
    assert.equal(runChecks({ settings, cwd: dir }).code, 2, '現在跑之前就是歪的');
    git('config', '--unset', 'core.worktree');
    assert.equal(runChecks({ settings, cwd: dir }).code, 0, '還原後照常');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('⑥子行程看不到 GIT_ 那一族', () => {
  const prev = process.env.GIT_DIR; process.env.GIT_DIR = '/no/such';
  try {
    const marker = path.join(os.tmpdir(), `run-checks-env-${process.pid}.txt`);
    runCommand([process.execPath, '-e', `require('fs').writeFileSync(process.argv[1], String('GIT_DIR' in process.env))`, marker], os.tmpdir());
    assert.equal(fs.readFileSync(marker, 'utf8'), 'false');
    fs.rmSync(marker, { force: true });
  } finally { if (prev === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev; }
});

test('⑦鉤子與雲端範本都呼叫這一支、不抄三關；鉤子先清 GIT_；欄位閘範本訂閱 edited 且不接 || true', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'templates', 'pre-push'), 'utf8');
  // 鉤子沒有執行權＝git 靜靜略過它（搬家前準備）：版本控制裡要記成可執行，搬進專案時才帶得過去
  const mode = spawnSync('git', ['ls-files', '-s', 'templates/pre-push'], { cwd: ROOT, encoding: 'utf8', env: gitEnv() }).stdout.split(/\s+/u)[0];
  assert.equal(mode, '100755', `推送前鉤子範本在版本控制裡的模式是 ${mode}，要是 100755`);
  assert.match(hook, /node tools\/run-checks\.js/u);
  assert.match(hook, /unset "\$_gitvar"/u, '鉤子第一件事是清 GIT_');
  assert.doesNotMatch(hook, /npm (run|test)/u, '鉤子不抄三關');
  // 只看生效的行：範本的註解本來就會提到「不可以接 || true」，不剝註解會誤紅
  const effective = (text) => text.split('\n').filter((l) => !/^\s*#/u.test(l)).join('\n');
  const ci = effective(fs.readFileSync(path.join(ROOT, 'templates', 'ci-github.yml'), 'utf8'));
  assert.match(ci, /node tools\/run-checks\.js/u);
  assert.doesNotMatch(ci, /npm run (typecheck|lint)|npm test/u, '雲端不抄三關');
  assert.doesNotMatch(ci, /continue-on-error/u);
  const cf = effective(fs.readFileSync(path.join(ROOT, 'templates', 'collab-fields-github.yml'), 'utf8'));
  assert.match(cf, /types: \[.*edited.*\]/u, '改說明也要重跑');
  assert.match(cf, /tools\/gates\/check-collab-fields\.js/u);
  assert.doesNotMatch(cf, /\|\| true|continue-on-error/u, '不可以有永遠放行的接法');
});

test('⑨三關跑的過程中改了倉庫設定＝1（就算從這棵樹看還健康）；索引檔不見＝2、跑完才不見＝1；正常形狀都＝0（搬家前準備）', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'run-checks-shared-'));
  try {
    const main = path.join(scratch, 'main');
    const linked = path.join(scratch, 'linked');
    fs.mkdirSync(main);
    const env = { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env }); assert.equal(r.status, 0, `git ${a.join(' ')}：${r.stderr}`); return r.stdout.trim(); };
    const sharedCfg = path.join(main, '.git', 'config');
    g(main, 'init', '-q'); fs.writeFileSync(path.join(main, 'a.txt'), 'x\n'); g(main, 'add', '.'); g(main, 'commit', '-q', '-m', 'base');
    g(main, 'config', 'extensions.worktreeConfig', 'true');
    g(main, 'worktree', 'add', '-q', '--detach', linked);
    g(linked, 'config', '--worktree', 'core.bare', 'false');
    const settings = { checks: { commands: [[process.execPath, '-e', 'process.exit(0)']] } };
    assert.equal(runChecks({ settings, cwd: linked }).code, 0, '對照組：健康的連結工作樹全綠');

    // 原專案 08-09 的形狀：跑的過程中有一題把 bare = true 寫進共用設定；這棵樹自己的設定蓋住了，從這裡看生效值照樣健康
    const breaker = { checks: { commands: [['git', 'config', '--file', sharedCfg, 'core.bare', 'true']] } };
    const broke = runChecks({ settings: breaker, cwd: linked });
    assert.equal(g(linked, 'rev-parse', '--is-bare-repository'), 'false', '前提：從這棵樹看生效值被蓋住了（只看生效值會判健康）');
    assert.equal(broke.code, 1, broke.lines.join('\n'));
    assert.match(broke.lines.join('\n'), /倉庫的共用設定或這棵樹自己的設定被改了/u);
    g(main, 'config', '--file', sharedCfg, 'core.bare', 'false');
    // 這棵樹自己的設定被改也算
    const perTree = runChecks({ settings: { checks: { commands: [['git', 'config', '--worktree', 'kit.touched', 'yes']] } }, cwd: linked });
    assert.equal(perTree.code, 1, perTree.lines.join('\n'));
    g(linked, 'config', '--worktree', '--unset', 'kit.touched');
    // 對照組：只讀設定不算改
    assert.equal(runChecks({ settings: { checks: { commands: [['git', 'config', '--get', 'core.bare']] } }, cwd: linked }).code, 0, '只讀設定＝照常');

    // 索引不見：git ls-files 不報錯、只回空清單
    const indexFile = g(main, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    fs.rmSync(indexFile);
    assert.equal(spawnSync('git', ['ls-files'], { cwd: main, encoding: 'utf8', env }).stdout, '', '前提：索引不見時 ls-files 靜靜回空');
    const noIndex = runChecks({ settings, cwd: main });
    assert.equal(noIndex.code, 2);
    assert.match(noIndex.lines.join('\n'), /索引檔卻不見了或 git 讀不了/u);
    g(main, 'read-tree', 'HEAD');
    const indexGone = runChecks({ settings: { checks: { commands: [[process.execPath, '-e', 'require("fs").unlinkSync(process.argv[1])', indexFile]] } }, cwd: main });
    assert.equal(indexGone.code, 1, '跑完才不見＝1');
    g(main, 'read-tree', 'HEAD');
    assert.equal(runChecks({ settings, cwd: main }).code, 0, '重建索引後照常');

    // 正面控制：暫存刪除全部檔案＝索引合法地是空的（r2 B2）
    g(main, 'rm', '-r', '-q', '.');
    assert.ok(fs.existsSync(indexFile), '前提：索引檔還在');
    assert.equal(runChecks({ settings, cwd: main }).code, 0, '空索引是合法狀態，不是索引壞了');
    g(main, 'reset', '-q', '--hard', 'HEAD');

    // 正面控制：Git 支援的裸儲存庫形狀（r2 B1、r3 B1 用過的形狀；這一版不再自己解讀設定檔，一律照 Git 對這棵樹的判斷）
    g(main, 'config', 'extensions.worktreeConfig', 'false');
    g(main, 'config', '--file', sharedCfg, 'core.bare', 'true');
    assert.equal(runChecks({ settings, cwd: linked }).code, 0, '沒開擴充、共用 core.bare=true＋連結工作樹＝正常');
    g(main, 'config', '--file', sharedCfg, 'core.bare', 'false');
    const bareRepo = path.join(scratch, 'store.git');
    const bareLinked = path.join(scratch, 'bare-linked');
    g(scratch, 'clone', '-q', '--bare', main, bareRepo);
    g(bareRepo, 'worktree', 'add', '-q', '--detach', bareLinked);
    assert.equal(runChecks({ settings, cwd: bareLinked }).code, 0, '裸儲存庫＋連結工作樹＝正常');
    const storeCfg = path.join(bareRepo, 'config');
    const original = fs.readFileSync(storeCfg, 'utf8');
    const incTrue = path.join(bareRepo, 'defaults.inc');
    fs.writeFileSync(incTrue, '[extensions]\n\tworktreeConfig = true\n');
    for (const [why, text] of [
      ['include 預設開、共用檔明確關', `${original}[include]\n\tpath = ${incTrue}\n[extensions]\n\tworktreeConfig = false\n`],
      ['同一檔先開後關', `${original}[extensions]\n\tworktreeConfig = true\n[extensions]\n\tworktreeConfig = false\n`],
      ['只有 include 裡寫開', `${original}[include]\n\tpath = ${incTrue}\n`],
    ]) {
      fs.writeFileSync(storeCfg, text);
      assert.equal(runChecks({ settings, cwd: bareLinked }).code, 0, `${why}：裸儲存庫形狀＝正常`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
