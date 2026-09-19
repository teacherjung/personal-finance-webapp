// 守三關執行器（規矩 E2、E3）與兩份呼叫它的範本。
//
// 守得到的：①三關沒登記＝退 2；登記裡混一條「未設定」、空的或形狀錯＝退 2、一條都不跑（r1 Medium⑪）；
//   ②依序跑、第一關紅就停＝退 1；③起不來＝退 2；④全綠＝退 0；
//   ⑤跑之前是裸倉庫＝退 2、跑完變裸倉庫＝退 1（真的用臨時倉庫驗）；⑥子行程看不到 GIT_ 那一族；
//   ⑦推送前鉤子與雲端範本都呼叫這一支、不抄三關；
//   ⑧版本控制認的工作樹根目錄不是這裡（樹被指到別處、或在子目錄跑）：跑之前＝退 2、跑完才歪＝退 1（搬家驗屋 09-13）；
//   ⑨三關跑的過程中倉庫的共用設定或這棵樹自己的設定被改了＝1（就算從這棵樹看生效值健康；原專案 08-09 的形狀）；只讀＝0；
//     有提交卻索引檔不見＝2、跑完才不見＝1；沒登記下面兩項時的正面控制：空索引、擴充關＋共用 core.bare=true＋連結樹
//     （這個夾具的主目錄其實打不開，登記了就擋，見⑩）、真的裸儲存庫＋連結樹（含 r3 的三種擴充寫法）都＝0（搬家前準備）；
//   ⑩登記了 checks.mainWorktree＝「一般工作樹」：從連結樹看健康、主目錄卻被判成裸倉庫或打不開（含工作樹根指到檔案、
//     主目錄自己的 config.worktree 寫壞、主目錄放在別的倉庫底下而自己那份 .git 壞了——上層路徑含冒號與不含冒號成對、
//     上層是路徑含冒號的裸儲存庫時判成「問到的是另一個倉庫」而不給改上層設定檔的指令）＝跑之前 2、跑完才壞 1，
//     身分那一問問到的共用目錄讀不到＝擋、照實說問不到（假 git 造的）；
//     訊息裡的還原或自查指令從別的目錄照貼跑得動（路徑含空白、單引號、全形括號與中文）；沒登記照舊放行；
//     帶著髒 GIT_DIR 照樣擋、還原改的是這個倉庫的設定檔；合法布局（每棵樹都覆寫、從主目錄跑、core.worktree 合法搬家、
//     資料夾名字結尾是空白）登記了也＝0，store.git、--separate-git-dir 登記了＝0 而且全綠那一行說這次沒驗；
//     照實的代價：proj/.git 是裸儲存庫＋連結樹，登記了＝2；
//   ⑩b 大小寫不分的檔案系統上（分大小寫的就跳過、寫明原因），建連結樹之後主目錄或它的上層只改了大小寫：登記了也＝0；
//     主目錄自己那份 .git 壞了照樣＝2（上層改了大小寫、再上一層是別的倉庫時第一道失效，靠身分比對擋）；
//   ⑪登記了 checks.indexAnchors：錨點不在這棵樹的索引裡（整份清空、少一筆、路徑位元組被改）＝跑之前 2、跑完才不見 1，
//     還原照貼跑得動（稀疏 checkout 照貼之後樹是乾淨的；路徑位元組被改的照貼之後索引清單＝最新提交的清單）；
//     錨點名字含 : 或 - 開頭、中文、雙引號；問錨點那一次 git 失敗＝不放行
//     （不當成都在），帶著髒 GIT_DIR 照樣問對倉庫；沒登記照舊放行；取消追蹤或改名非錨點、暫存修改錨點登記了也＝0；
//     三關中途暫存並提交非錨點的修改（HEAD 前進、錨點都在）＝0；
//     暫存刪除全部、已提交改名錨點照登記擋；填了目錄＝2、不給指令；三關中途 HEAD 解析不到（switch --orphan 等）＝1、
//     照貼切回去；三關中途提交了刪除錨點＝1、不叫人改登記；跑之前只暫存的錨點被拿掉（含最新提交裡是同名目錄的）＝1、
//     叫人重新暫存、不叫人改登記；HEAD 解析不到（剛 init、在還沒有提交的分支上）＝0、全綠那一行說沒驗
//     （三關前解析不到、三關中途做了第一顆提交也照實說三關前那一次沒驗）；三關前解析不到、三關中途做了第一顆提交而錨點不對
//     （填成目錄、登記的有一個從來沒進過索引）＝1、用三關前那一套判斷（叫人改登記、不說跑之前怎樣），下一次跑＝2 說同一件事；
//   ⑫兩個登記寫錯＝2、一關都不跑、訊息指出哪一格；沒寫或寫「未設定」＝沒登記、全綠那一行照實說沒驗；三關後樹壞了、設定也變了＝兩段都印；
//     三關後讀不到設定指紋＝說沒辦法比對、不說被改了。
// ⚠️ 守不到的：三關命令本身對不對；鉤子有沒有被啟用（每個複本要自己設）；雲端有沒有設成必過檢查；
//   兩個登記本身守不到的形狀（tools/run-checks.js 的 mainProblem、anchorProblem 註解與 MACHINES.md 的 E2、E3 那一列）。
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
const okTree = () => ({ state: 'ok' });

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

test('⑨三關跑的過程中改了倉庫設定＝1（就算從這棵樹看還健康）；索引檔不見＝2、跑完才不見＝1；沒登記時這幾種形狀都＝0（搬家前準備）', () => {
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

    // 沒登記主目錄布局時的正面控制（r2 B1 用過的形狀；這一版不自己解讀設定檔，照 Git 對這棵樹的判斷）。
    // ⚠️ 這個夾具不是裸儲存庫：主目錄是有檔案的一般 checkout，寫了共用 core.bare=true 之後它其實打不開（下面兩句前提量給你看）；
    //   登記了 checks.mainWorktree 就擋（見⑩）。「真的裸儲存庫＋連結樹＝0」由後面 store.git 那幾句撐著。
    g(main, 'config', 'extensions.worktreeConfig', 'false');
    g(main, 'config', '--file', sharedCfg, 'core.bare', 'true');
    const statusOf = (cwd) => spawnSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd, encoding: 'utf8', env }).status;
    assert.notEqual(statusOf(main), 0, '前提：主目錄打不開');
    assert.equal(statusOf(linked), 0, '前提：連結工作樹照常');
    assert.equal(runChecks({ settings, cwd: linked }).code, 0, '沒登記主目錄布局：擴充關＋共用 core.bare=true＋連結工作樹＝照舊放行（這個夾具的主目錄其實打不開；登記了就擋，見⑩）');
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

// ---- ⑩⑪⑫共用的小工具 ----
const OK_CMD = [process.execPath, '-e', 'process.exit(0)'];
const withKeys = (extra, commands = [OK_CMD]) => ({ checks: { commands, ...extra } });
const MAIN_REG = { mainWorktree: '一般工作樹' };
/** 路徑故意含空白、單引號、全形括號與中文：訊息裡的還原指令要照貼跑得動（使用專案的真主目錄就長這種樣子）。 */
const ODD_PREFIX = "run-checks 主目錄（it's）-";

function gitKit() {
  const env = { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
  const raw = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env });
  const g = (cwd, ...a) => { const r = raw(cwd, ...a); assert.equal(r.status, 0, `git ${a.join(' ')}：${r.stderr}`); return r.stdout.trim(); };
  const status = (cwd) => raw(cwd, '--no-optional-locks', 'status', '--porcelain').status;
  return { raw, g, status };
}

/** 主目錄（有提交、有檔案的一般 checkout）＋一棵連結工作樹。 */
function makePair(g, root, name, { ext }) {
  const main = path.join(root, name, 'main');
  const wt = path.join(root, name, 'wt');
  fs.mkdirSync(main, { recursive: true });
  g(main, 'init', '-q');
  fs.writeFileSync(path.join(main, 'a.txt'), 'x\n');
  g(main, 'add', '.');
  g(main, 'commit', '-q', '-m', 'base');
  if (ext) g(main, 'config', 'extensions.worktreeConfig', 'true');
  g(main, 'worktree', 'add', '-q', '--detach', wt);
  return { main, wt, cfg: path.join(main, '.git', 'config') };
}

/** 訊息裡以 git 開頭的行（還原或自查指令）。 */
const commandLines = (res) => res.lines.filter((l) => l.startsWith('git '));
/** 主目錄被判成裸倉庫時的還原那一行（自查那一行長得不一樣）。 */
const RESTORE_BARE = /^git config --file '.+' --replace-all core\.bare false$/u;

/**
 * 照貼跑：在別的目錄用 sh -c 跑訊息裡每一行指令，每一行都要退 0；回每一行的標準輸出。
 * 指令那一行在引號外不可以有 ASCII 以外的字（後面接了中文，照貼就壞）。
 */
function paste(res, cwd) {
  return commandLines(res).map((c) => {
    assert.doesNotMatch(c.replace(/'[^']*'|\\./gu, ''), /[^ -~]/u, `指令那一行後面不可以接字：${c}`);   // 拿掉單引號段與 \' 之後
    const r = spawnSync('sh', ['-c', c], { cwd, encoding: 'utf8', env: gitEnv() });
    assert.equal(r.status, 0, `照貼 ${c}：${r.stderr}`);
    return r.stdout;
  });
}

test('⑩主目錄布局（登記了 checks.mainWorktree 才驗）：主目錄被判成裸倉庫或打不開＝跑之前 2、跑完才壞 1、還原照貼跑得動；沒登記照舊放行；合法布局登記了也＝0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ODD_PREFIX));
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'run-checks-away-'));   // 照貼指令的「別的目錄」（不在任何倉庫裡）
  try {
    const { raw: rawGit, g, status } = gitKit();
    const loose = withKeys({});
    const reg = withKeys(MAIN_REG);
    const setShared = (p, ...a) => g(root, 'config', '--file', p.cfg, ...a);   // 站在倉庫外面改：主目錄打不開時也改得動

    // 1. 形狀 (1)：擴充開、連結樹自己覆寫 false、共用 core.bare 寫成 Git 認得的各種 true
    const p1 = makePair(g, root, 'one', { ext: true });
    g(p1.wt, 'config', '--worktree', 'core.bare', 'false');
    assert.equal(runChecks({ settings: reg, cwd: p1.wt }).code, 0, '對照組：還沒寫壞時登記了＝0');
    for (const v of ['true', 'yes', 'on', '1']) {
      setShared(p1, 'core.bare', v);
      assert.equal(g(p1.wt, 'rev-parse', '--is-bare-repository'), 'false', `前提（${v}）：從連結樹看生效值健康`);
      assert.notEqual(status(p1.main), 0, `前提（${v}）：主目錄真的打不開`);
      const quiet = runChecks({ settings: loose, cwd: p1.wt });
      assert.equal(quiet.code, 0, `沒登記（${v}）＝照舊放行`);
      assert.match(quiet.lines.join('\n'), /沒登記、所以沒驗：主目錄是不是一般工作樹/u);
      const r = runChecks({ settings: reg, cwd: p1.wt });
      assert.equal(r.code, 2, `登記了（${v}）：${r.lines.join('\n')}`);
      assert.match(r.lines[0], /被 Git 判成裸倉庫了/u);
      assert.doesNotMatch(r.lines.join('\n'), /不是這個倉庫自己的設定檔/u, `對照組（${v}）：只有倉庫自己的設定檔一筆 true，不提醒 include`);
      assert.ok(commandLines(r).every((l) => RESTORE_BARE.test(l)), `給的是還原、不是自查（${v}）：${r.lines.join('\n')}`);
      assert.equal(paste(r, away).length, 1, `剛好一行還原（${v}）：${r.lines.join('\n')}`);
      assert.equal(status(p1.main), 0, `照貼還原之後主目錄打得開（${v}）`);
      assert.equal(runChecks({ settings: reg, cwd: p1.wt }).code, 0, `還原之後再跑＝0（${v}）`);
    }

    // 2. 形狀 (2)：擴充關、共用 core.bare=true
    const p2 = makePair(g, root, 'two', { ext: false });
    setShared(p2, 'core.bare', 'true');
    assert.notEqual(status(p2.main), 0, '前提：主目錄打不開');
    assert.equal(status(p2.wt), 0, '前提：連結樹照常');
    assert.equal(runChecks({ settings: loose, cwd: p2.wt }).code, 0, '沒登記＝照舊放行');
    const r2 = runChecks({ settings: reg, cwd: p2.wt });
    assert.equal(r2.code, 2, r2.lines.join('\n'));
    assert.ok(commandLines(r2).every((l) => RESTORE_BARE.test(l)), `給的是還原、不是自查：${r2.lines.join('\n')}`);
    assert.equal(paste(r2, away).length, 1, r2.lines.join('\n'));
    assert.equal(status(p2.main), 0, '照貼還原之後主目錄打得開');
    assert.equal(runChecks({ settings: reg, cwd: p2.wt }).code, 0, '還原之後再跑＝0');
    // 共用檔與 include 引進的檔各寫一筆 true：兩筆各給一行還原，改到 include 那個檔之前先提醒它可能被別的倉庫共用
    const incTrue = path.join(root, 'bare-true.inc');
    fs.writeFileSync(incTrue, '[core]\n\tbare = true\n');
    setShared(p2, 'core.bare', 'true');
    setShared(p2, 'include.path', incTrue);
    const r2i = runChecks({ settings: reg, cwd: p2.wt });
    assert.equal(r2i.code, 2, r2i.lines.join('\n'));
    const tip = r2i.lines.findIndex((l) => /不是這個倉庫自己的設定檔/u.test(l));
    assert.ok(tip !== -1 && tip < r2i.lines.findIndex((l) => l.startsWith('git ')), `include 那一檔的提醒要在還原指令之前：${r2i.lines.join('\n')}`);
    assert.equal(paste(r2i, away).length, 2, r2i.lines.join('\n'));
    assert.equal(status(p2.main), 0, '兩行都照貼之後主目錄打得開');
    setShared(p2, '--unset', 'include.path');

    // 3. 擴充關、共用 core.worktree 指到不存在的地方：主目錄打不開、連結樹照常。這一種只給自查、不給還原
    for (const [why, target] of [['上層也不存在', `/nowhere-${process.pid}/zz`], ['只有最後一層不存在', path.join(root, 'missing')]]) {
      setShared(p2, 'core.worktree', target);
      assert.notEqual(status(p2.main), 0, `前提（${why}）：主目錄打不開`);
      assert.equal(status(p2.wt), 0, `前提（${why}）：連結樹照常`);
      assert.equal(runChecks({ settings: loose, cwd: p2.wt }).code, 0, `沒登記（${why}）＝照舊放行`);
      const r = runChecks({ settings: reg, cwd: p2.wt });
      assert.equal(r.code, 2, `${why}：${r.lines.join('\n')}`);
      assert.match(r.lines[0], /git 打不開/u);
      const [seen] = paste(r, away);
      assert.ok(seen.includes(target), `自查那一行照貼跑得動、看得到成因（${why}）：${seen}`);
      setShared(p2, '--unset', 'core.worktree');
    }
    // 共用 core.worktree 指到一個存在的「檔案」：主目錄照樣打不開（「在不在」要問成「是不是存在的目錄」）
    const aFile = path.join(root, 'not-a-dir');
    fs.writeFileSync(aFile, 'x\n');
    setShared(p2, 'core.worktree', aFile);
    assert.notEqual(status(p2.main), 0, '前提（指到檔案）：主目錄打不開');
    assert.equal(status(p2.wt), 0, '前提（指到檔案）：連結樹照常');
    assert.equal(runChecks({ settings: loose, cwd: p2.wt }).code, 0, '沒登記（指到檔案）＝照舊放行');
    const rf = runChecks({ settings: reg, cwd: p2.wt });
    assert.equal(rf.code, 2, `指到檔案：${rf.lines.join('\n')}`);
    assert.match(rf.lines[0], /不存在或不是目錄/u);
    assert.ok(paste(rf, away).join('').includes(aFile), rf.lines.join('\n'));
    setShared(p2, '--unset', 'core.worktree');

    // 成因在主目錄自己的 config.worktree（擴充開；使用專案就是這種）：多給一行自查，照貼看得到成因
    const own = makePair(g, root, 'own', { ext: true });
    const ownCfg = path.join(own.main, '.git', 'config.worktree');
    const bad = `/nowhere-own-${process.pid}/zz`;
    g(root, 'config', '--file', ownCfg, 'core.worktree', bad);
    assert.notEqual(status(own.main), 0, '前提：主目錄打不開');
    assert.equal(status(own.wt), 0, '前提：連結樹照常');
    assert.equal(runChecks({ settings: loose, cwd: own.wt }).code, 0, '沒登記＝照舊放行');
    const ro = runChecks({ settings: reg, cwd: own.wt });
    assert.equal(ro.code, 2, ro.lines.join('\n'));
    const seenOwn = paste(ro, away);
    assert.equal(seenOwn.length, 2, `共用設定檔與主目錄自己的 config.worktree 各一行：${ro.lines.join('\n')}`);
    assert.ok(seenOwn.join('').includes(bad), `照貼兩行自查、看得到成因：${seenOwn.join('')}`);
    fs.rmSync(ownCfg);
    assert.equal(runChecks({ settings: reg, cwd: own.wt }).code, 0, '拿掉之後＝0');

    // 主目錄放在另一個倉庫底下、主目錄自己那份 .git 壞了（HEAD 不見）：Git 會改去開上層那個倉庫。成對：上層路徑不含冒號時
    // 第一道（GIT_CEILING_DIRECTORIES）就讓 Git 退非零；含冒號時那個變數擋不住（它是冒號分隔的清單），靠身分比對擋
    for (const [why, parentName, ceilingHolds] of [['上層路徑不含冒號', 'nest', true], ['上層路徑含冒號', 'nest:colon', false]]) {
      const parent = path.join(root, parentName);
      fs.mkdirSync(parent);
      g(parent, 'init', '-q');
      const nested = makePair(g, parent, 'sub', { ext: true });
      assert.equal(runChecks({ settings: reg, cwd: nested.wt }).code, 0, `對照組（${why}）：巢狀、健康＝0`);
      const mainHead = path.join(nested.main, '.git', 'HEAD');
      fs.renameSync(mainHead, `${mainHead}.moved`);
      assert.equal(status(nested.wt), 0, `前提（${why}）：連結樹照常`);
      assert.equal(fs.realpathSync(g(nested.main, 'rev-parse', '--show-toplevel')), fs.realpathSync(parent), `前提（${why}）：在主目錄問 Git，問到的是上層那個倉庫`);
      // 對照斷言：這一對真的只差在第一道擋不擋得住（用執行器同一種環境，站在主目錄問）
      const ceiled = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: nested.main, encoding: 'utf8', env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(nested.main) } });
      if (ceilingHolds) assert.notEqual(ceiled.status, 0, `前提（${why}）：GIT_CEILING_DIRECTORIES 擋得住、Git 退非零`);
      else assert.equal(fs.realpathSync(ceiled.stdout.replace(/\n$/u, '')), fs.realpathSync(parent), `前提（${why}）：GIT_CEILING_DIRECTORIES 擋不住、照樣問到上層那個倉庫`);
      assert.equal(runChecks({ settings: loose, cwd: nested.wt }).code, 0, `沒登記（${why}）＝照舊放行`);
      const rn = runChecks({ settings: reg, cwd: nested.wt });
      assert.equal(rn.code, 2, `${why}、主目錄的 .git 壞了：${rn.lines.join('\n')}`);
      assert.match(rn.lines[0], /git 打不開/u);
      if (!ceilingHolds) assert.match(rn.lines[0], /在主目錄問到的是另一個倉庫（'.+'）/u, rn.lines[0]);
      if (!ceilingHolds) assert.match(rn.lines[1], /多半不是設定：主目錄自己那份 \.git 壞了/u, `問到另一個倉庫時照實說成因多半不是設定：${rn.lines.join('\n')}`);
      if (!ceilingHolds) assert.doesNotMatch(rn.lines.join('\n'), /原因多半在共用設定檔/u, '不說原因多半在共用設定檔');
      fs.renameSync(`${mainHead}.moved`, mainHead);
      assert.equal(runChecks({ settings: reg, cwd: nested.wt }).code, 0, `還原之後＝0（${why}）`);
    }
    // 上層路徑含冒號、而且上層是裸儲存庫（git init --bare 出來的）：身分那一問排在裸不裸之前，判成「問到的是另一個倉庫」；
    // 排在後面的話會判成主目錄被判成裸倉庫，還原指令改的是上層那個裸儲存庫的設定檔
    const bo = path.join(root, 'bo:x.git');
    fs.mkdirSync(bo);
    g(bo, 'init', '-q', '--bare');
    const boMain = path.join(bo, 'project');
    const boWt = path.join(bo, 'wt');
    fs.mkdirSync(boMain);
    g(boMain, 'init', '-q');
    fs.writeFileSync(path.join(boMain, 'a.txt'), 'x\n');
    g(boMain, 'add', '.');
    g(boMain, 'commit', '-q', '-m', 'base');
    g(boMain, 'worktree', 'add', '-q', '--detach', boWt);
    assert.equal(runChecks({ settings: reg, cwd: boWt }).code, 0, '對照組：上層是裸儲存庫、健康＝0');
    const boHead = path.join(boMain, '.git', 'HEAD');
    fs.renameSync(boHead, `${boHead}.moved`);
    assert.equal(status(boWt), 0, '前提：連結樹照常');
    const boAsk = (...a) => spawnSync('git', a, { cwd: boMain, encoding: 'utf8', env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: bo } });
    assert.equal(fs.realpathSync(boAsk('rev-parse', '--path-format=absolute', '--git-common-dir').stdout.replace(/\n$/u, '')), fs.realpathSync(bo), '前提：用執行器同一種環境站在主目錄問，問到的是上層那個裸儲存庫');
    assert.equal(boAsk('rev-parse', '--is-bare-repository').stdout.trim(), 'true', '前提：先問裸不裸的話，Git 會說裸');
    const rb = runChecks({ settings: reg, cwd: boWt });
    assert.equal(rb.code, 2, rb.lines.join('\n'));
    assert.match(rb.lines[0], /git 打不開（在主目錄問到的是另一個倉庫（'.+'））/u, rb.lines[0]);
    assert.match(rb.lines[1], /多半不是設定：主目錄自己那份 \.git 壞了/u, rb.lines.join('\n'));
    assert.doesNotMatch(rb.lines.join('\n'), /判成裸倉庫|core\.bare/u, `不說主目錄被判成裸倉庫、不給 core.bare 的還原：${rb.lines.join('\n')}`);
    // 只給自查、而且查的是這個倉庫自己的共用設定檔（不是上層那個裸儲存庫的）
    const boFiles = commandLines(rb).map((l) => (l.match(/^git config --file '(.+)' --show-origin --list$/u) || [])[1]);
    assert.equal(boFiles.length, 1, rb.lines.join('\n'));
    assert.ok(boFiles[0], `給的是自查、不是還原：${rb.lines.join('\n')}`);
    assert.equal(fs.realpathSync(boFiles[0].replace(/'\\''/gu, "'")), fs.realpathSync(path.join(boMain, '.git', 'config')), rb.lines.join('\n'));
    paste(rb, away);
    fs.renameSync(`${boHead}.moved`, boHead);
    assert.equal(runChecks({ settings: reg, cwd: boWt }).code, 0, '還原之後＝0（上層是裸儲存庫）');
    // 身分那一問問到的共用目錄讀不到（stat 失敗）：當成不是同一個、照實說問不到。用假 git 造——真的 Git 回的是它剛打開的目錄，
    // 沒找到用真的 Git 造得出來的方法
    const probe = makePair(g, root, 'probe', { ext: false });
    const probeReal = fs.realpathSync(probe.main);
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const fakeBin = path.join(root, 'fake-bin-who');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\ncase " $* " in *" --git-common-dir "*) if [ "$(pwd -P)" = "$KIT_FAKE_MAIN" ]; then printf '%s\\n' "$KIT_FAKE_SEEN"; exit 0; fi;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const faked = (seenPath) => {
      const prev = { PATH: process.env.PATH, KIT_FAKE_MAIN: process.env.KIT_FAKE_MAIN, KIT_FAKE_SEEN: process.env.KIT_FAKE_SEEN };
      Object.assign(process.env, { PATH: `${fakeBin}${path.delimiter}${prev.PATH}`, KIT_FAKE_MAIN: probeReal, KIT_FAKE_SEEN: seenPath });
      try { return runChecks({ settings: reg, cwd: probe.wt }); } finally {
        for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    };
    const other = faked(path.join(p2.main, '.git'));
    assert.equal(other.code, 2, `對照組：假 git 真的接上了（回別的倉庫＝擋）：${other.lines.join('\n')}`);
    assert.match(other.lines[0], /問到的是另一個倉庫/u, other.lines[0]);
    const nowhere = path.join(root, 'no-such-dir', '.git');
    const unknown = faked(nowhere);
    assert.equal(unknown.code, 2, unknown.lines.join('\n'));
    assert.match(unknown.lines[0], /問不到是不是這個倉庫（在主目錄問到的共用目錄 '.+' 或這棵樹的共用目錄讀不到）：.+驗不到就不放行。$/u, unknown.lines[0]);
    assert.doesNotMatch(unknown.lines[0], /另一個倉庫|打不開|會失敗/u, `讀不到不說成另一個倉庫、也不說打不開：${unknown.lines[0]}`);
    paste(unknown, away);
    assert.equal(runChecks({ settings: reg, cwd: probe.wt }).code, 0, '對照組：拿掉假 git＝0');

    // 資料夾名字結尾是空白（主目錄與連結樹都是）：Git 印的路徑不可以整串 trim
    const spaced = path.join(root, 'spaced');
    const spMain = path.join(spaced, 'proj ');
    const spWt = path.join(spaced, 'wt ');
    fs.mkdirSync(spMain, { recursive: true });
    g(spMain, 'init', '-q');
    fs.writeFileSync(path.join(spMain, 'a.txt'), 'x\n');
    g(spMain, 'add', '.');
    g(spMain, 'commit', '-q', '-m', 'base');
    g(spMain, 'worktree', 'add', '-q', '--detach', spWt);
    assert.equal(status(spMain), 0, '前提：主目錄打得開');
    assert.equal(status(spWt), 0, '前提：連結樹打得開');
    assert.match(rawGit(spMain, 'rev-parse', '--show-toplevel').stdout, / \n$/u, '前提：Git 印的主目錄路徑結尾真的是空白');
    assert.match(rawGit(spWt, 'rev-parse', '--show-toplevel').stdout, / \n$/u, '前提：Git 印的連結樹路徑結尾真的是空白');
    const rs = runChecks({ settings: reg, cwd: spWt });
    assert.equal(rs.code, 0, `結尾是空白的主目錄與連結樹，登記了也＝0：${rs.lines.join('\n')}`);
    assert.equal(runChecks({ settings: reg, cwd: spMain }).code, 0, '從結尾是空白的主目錄本身跑＝0');

    // 共用 core.bare=true、後面 include 一檔寫 false、連結樹自己覆寫 false：生效值說不裸，主目錄照樣打不開
    const p9 = makePair(g, root, 'nine', { ext: true });
    g(p9.wt, 'config', '--worktree', 'core.bare', 'false');
    const inc = path.join(root, 'bare-false.inc');
    fs.writeFileSync(inc, '[core]\n\tbare = false\n');
    setShared(p9, 'core.bare', 'true');
    setShared(p9, 'include.path', inc);
    assert.equal(g(p9.main, 'rev-parse', '--is-bare-repository'), 'false', '前提：在主目錄問生效值，Git 說不裸');
    assert.notEqual(status(p9.main), 0, '前提：主目錄照樣打不開');
    assert.equal(runChecks({ settings: loose, cwd: p9.wt }).code, 0, '沒登記＝照舊放行');
    const r9 = runChecks({ settings: reg, cwd: p9.wt });
    assert.equal(r9.code, 2, r9.lines.join('\n'));
    assert.match(r9.lines[0], /git 打不開/u);

    // 4. 三關中途只寫主目錄自己的 config.worktree：指紋只看共用檔與這棵樹自己的，看不到它
    const mainOwn = path.join(p1.main, '.git', 'config.worktree');
    const breaker = (extra) => withKeys(extra, [['git', 'config', '--file', mainOwn, 'core.bare', 'true']]);
    assert.equal(runChecks({ settings: breaker({}), cwd: p1.wt }).code, 0, '沒登記＝照舊放行');
    assert.notEqual(status(p1.main), 0, '對照組：主目錄真的被弄壞了，指紋沒看到');
    fs.rmSync(mainOwn);
    assert.equal(status(p1.main), 0, '前提：拿掉之後主目錄好了');
    const r4 = runChecks({ settings: breaker(MAIN_REG), cwd: p1.wt });
    assert.equal(r4.code, 1, r4.lines.join('\n'));
    assert.match(r4.lines.join('\n'), /三關跑完之後，主目錄/u);
    assert.match(r4.lines.join('\n'), /或是不是同一段時間有別的工作階段在動/u, '三關後也可能是別的工作階段：照實說');
    assert.doesNotMatch(r4.lines.join('\n'), /本來就是裸儲存庫/u, '三關後（跑之前是好的）不提「本來就是裸儲存庫」');
    assert.equal(paste(r4, away).length, 1, r4.lines.join('\n'));
    assert.equal(status(p1.main), 0, '照貼還原之後主目錄打得開');
    fs.rmSync(mainOwn);
    // 三關中途把主目錄弄到打不開（共用 core.worktree 指到不存在的地方）：樹的狀態與設定指紋兩段都印
    const lostRoot = `/nowhere-mid-${process.pid}/zz`;
    const r4u = runChecks({ settings: withKeys(MAIN_REG, [['git', 'config', '--file', p2.cfg, 'core.worktree', lostRoot]]), cwd: p2.wt });
    assert.equal(r4u.code, 1, r4u.lines.join('\n'));
    assert.match(r4u.lines.join('\n'), /三關跑完之後，主目錄 .+ 的 git 打不開/u);
    assert.match(r4u.lines.join('\n'), /或是不是同一段時間有別的工作階段在動/u, '三關後也可能是別的工作階段：照實說');
    assert.match(r4u.lines.join('\n'), /設定被改了/u, '設定指紋那一段也印');
    assert.ok(paste(r4u, away).join('').includes(lostRoot), r4u.lines.join('\n'));
    setShared(p2, '--unset', 'core.worktree');

    // 5. 行程帶著 GIT_DIR（指向另一個健康倉庫）：問主目錄的子行程也要清掉它，不然問到的是那個健康倉庫
    const healthy = makePair(g, root, 'healthy', { ext: true });
    setShared(p1, 'core.bare', 'true');
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(healthy.main, '.git');
    let dirty;
    try { dirty = runChecks({ settings: reg, cwd: p1.wt }); } finally { if (prev === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev; }
    assert.equal(dirty.code, 2, `帶著髒 GIT_DIR 也要擋：${dirty.lines.join('\n')}`);
    // 問 core.bare 出處的那一次也要清：不然問到那個健康倉庫、沒有 true，就只給自查
    const fixes = commandLines(dirty);
    assert.equal(fixes.length, 1, `帶著髒 GIT_DIR：剛好一行還原：${dirty.lines.join('\n')}`);
    const [, quoted] = fixes[0].match(/^git config --file '(.+)' --replace-all core\.bare false$/u) || [];
    assert.ok(quoted, `給的是還原、不是自查：${fixes[0]}`);
    assert.equal(fs.realpathSync(quoted.replace(/'\\''/gu, "'")), fs.realpathSync(p1.cfg), `改的是這個倉庫的共用設定檔，不是 GIT_DIR 指的那個：${fixes[0]}`);
    paste(dirty, away);
    assert.equal(status(p1.main), 0, '照貼還原之後主目錄打得開');
    setShared(p1, 'core.bare', 'false');

    // 6. 合法布局，登記了也＝0
    assert.equal(runChecks({ settings: reg, cwd: healthy.main }).code, 0, '從主目錄本身跑＝0');
    const every = makePair(g, root, 'every', { ext: true });
    g(every.main, 'config', '--worktree', 'core.bare', 'false');
    g(every.wt, 'config', '--worktree', 'core.bare', 'false');
    setShared(every, 'core.bare', 'true');
    assert.equal(status(every.main), 0, '前提：每棵樹都覆寫了，主目錄打得開');
    assert.equal(runChecks({ settings: reg, cwd: every.wt }).code, 0, '共用 true、每棵樹（含主目錄）都覆寫 false＝0');
    const store = path.join(root, 'store.git');
    g(root, 'clone', '-q', '--bare', healthy.main, store);
    g(store, 'worktree', 'add', '-q', '--detach', path.join(root, 'store-wt'));
    const skippedMain = /登記了、這次沒驗：主目錄是不是一般工作樹（checks\.mainWorktree；共用目錄不叫 \.git/u;
    const rStore = runChecks({ settings: reg, cwd: path.join(root, 'store-wt') });
    assert.equal(rStore.code, 0, '真的裸儲存庫（store.git）＋連結樹＝0');
    assert.match(rStore.lines.at(-1), skippedMain, `登記了卻驗不到：全綠那一行要說：${rStore.lines.at(-1)}`);
    g(root, 'clone', '-q', '--separate-git-dir', path.join(root, 'gitstore'), healthy.main, path.join(root, 'sep'));
    g(path.join(root, 'sep'), 'worktree', 'add', '-q', '--detach', path.join(root, 'sep-wt'));
    const rSep = runChecks({ settings: reg, cwd: path.join(root, 'sep-wt') });
    assert.equal(rSep.code, 0, '--separate-git-dir＋連結樹＝0');
    assert.match(rSep.lines.at(-1), skippedMain, `登記了卻驗不到：全綠那一行要說：${rSep.lines.at(-1)}`);
    assert.doesNotMatch(runChecks({ settings: reg, cwd: every.wt }).lines.at(-1), /登記了、這次沒驗/u, '對照組：驗得到的布局不說沒驗');
    const moved = makePair(g, root, 'moved', { ext: false });
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.renameSync(path.join(moved.main, 'a.txt'), path.join(elsewhere, 'a.txt'));
    setShared(moved, 'core.worktree', elsewhere);
    assert.equal(fs.realpathSync(g(moved.main, 'rev-parse', '--show-toplevel')), fs.realpathSync(elsewhere), '前提：Git 說主目錄的工作樹根搬到了別處');
    assert.equal(runChecks({ settings: reg, cwd: moved.wt }).code, 0, 'core.worktree 把主目錄合法搬到存在的別處＝0');

    // 7. 照實的代價：proj/.git 是裸儲存庫＋連結樹，從 Git 看跟形狀 (2) 一模一樣——登記了就擋
    const proj = path.join(root, 'proj');
    g(root, 'clone', '-q', '--bare', healthy.main, path.join(proj, '.git'));
    g(path.join(proj, '.git'), 'worktree', 'add', '-q', '--detach', path.join(proj, 'wt'));
    assert.equal(runChecks({ settings: loose, cwd: path.join(proj, 'wt') }).code, 0, '沒登記＝0');
    const rp = runChecks({ settings: reg, cwd: path.join(proj, 'wt') });
    assert.equal(rp.code, 2, '登記了「一般工作樹」的專案，這種布局的複本會被擋（MACHINES.md 的 E2、E3 那一列）');
    const warn = rp.lines.findIndex((l) => /本來就是裸儲存庫的話不要照做/u.test(l));
    const fix = rp.lines.findIndex((l) => l.startsWith('git '));
    assert.ok(warn !== -1 && fix !== -1 && warn < fix, `「不適用這台」那句要在還原指令之前：${rp.lines.join('\n')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(away, { recursive: true, force: true });
  }
});

test('⑩b 主目錄或它的上層只改了大小寫（大小寫不分的檔案系統）：身分比對看裝置與 inode，同一個目錄＝0；主目錄自己那份 .git 壞了照樣擋', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ODD_PREFIX));
  try {
    const probe = path.join(root, 'CaseProbe');
    fs.mkdirSync(probe);
    const folded = path.join(root, 'caseprobe');
    if (!fs.existsSync(folded)) {
      t.skip('這台的檔案系統分大小寫：只差大小寫的兩個名字是兩個不同的目錄，「只改了大小寫、其實是同一個目錄」這個形狀造不出來');
      return;
    }
    assert.equal(fs.statSync(folded).ino, fs.statSync(probe).ino, '前提：這台的檔案系統不分大小寫（兩個名字是同一個目錄）');
    const { g, status } = gitKit();
    const reg = withKeys(MAIN_REG);
    // (1) 主目錄本身改了大小寫：第一道照樣擋得住（上層沒改）。(2) 主目錄的上層改了大小寫、再上一層是別的倉庫：
    //   這棵樹記的上層還是舊的大小寫，Git 比對 GIT_CEILING_DIRECTORIES 時分大小寫、對不上＝第一道失效，靠身分比對擋
    for (const [why, renamed] of [['主目錄本身', 'main'], ['主目錄的上層', 'up']]) {
      const outer = path.join(root, renamed === 'main' ? 'case-main' : 'case-up');
      fs.mkdirSync(outer);
      if (renamed === 'up') g(outer, 'init', '-q');
      const pair = makePair(g, outer, 'Up', { ext: true });   // outer/Up/main＋outer/Up/wt
      const mainNow = renamed === 'main' ? path.join(outer, 'Up', 'MAIN') : path.join(outer, 'up', 'main');
      if (renamed === 'main') fs.renameSync(pair.main, mainNow);
      else fs.renameSync(path.join(outer, 'Up'), path.join(outer, 'up'));
      const wtNow = path.join(path.dirname(mainNow), 'wt');
      assert.equal(status(wtNow), 0, `前提（${why}）：連結樹的 git status 退 0`);
      assert.equal(status(mainNow), 0, `前提（${why}）：主目錄的 git status 退 0`);
      const fromWt = g(wtNow, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      const fromMain = g(mainNow, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      assert.notEqual(fromWt, fromMain, `前提（${why}）：兩邊 Git 印的共用目錄字串不同（比字串會誤擋）`);
      assert.notEqual(fs.realpathSync(fromWt), fs.realpathSync(fromMain), `前提（${why}）：解開符號連結之後字串也不同`);
      const healthy = runChecks({ settings: reg, cwd: wtNow });
      assert.equal(healthy.code, 0, `${why}只改了大小寫、登記了＝0：${healthy.lines.join('\n')}`);
      const mainHead = path.join(mainNow, '.git', 'HEAD');
      fs.renameSync(mainHead, `${mainHead}.moved`);
      assert.equal(status(wtNow), 0, `前提（${why}）：主目錄的 .git 壞了、連結樹照常`);
      const ceiled = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path.dirname(fromWt), encoding: 'utf8', env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(path.dirname(fromWt)) } });
      if (renamed === 'main') assert.notEqual(ceiled.status, 0, `前提（${why}）：第一道擋得住、Git 退非零`);
      else assert.equal(fs.realpathSync(ceiled.stdout.replace(/\n$/u, '')), fs.realpathSync(path.join(outer, '.git')), `前提（${why}）：第一道擋不住、問到的是再上一層那個倉庫`);
      const broken = runChecks({ settings: reg, cwd: wtNow });
      assert.equal(broken.code, 2, `${why}只改了大小寫、主目錄的 .git 壞了：${broken.lines.join('\n')}`);
      assert.match(broken.lines[0], /git 打不開/u, broken.lines[0]);
      if (renamed === 'up') assert.match(broken.lines[0], /在主目錄問到的是另一個倉庫/u, broken.lines[0]);
      fs.renameSync(`${mainHead}.moved`, mainHead);
      assert.equal(runChecks({ settings: reg, cwd: wtNow }).code, 0, `還原之後＝0（${why}）`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('⑪索引錨點（登記了 checks.indexAnchors 才驗）：錨點不在這棵樹的索引裡＝跑之前 2、跑完才不見 1、還原照貼跑得動；沒登記照舊放行；合法形狀登記了也＝0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ODD_PREFIX));
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'run-checks-away-'));
  try {
    const { raw, g } = gitKit();
    const repo = path.join(root, 'repo');
    // : 開頭（pathspec 語法）、- 開頭（選項）、中文與全形括號、雙引號（Git 預設會替後兩種加引號跳脫）
    const ANCHORS = ['anchor.txt', 'deep/x/anchor2.txt', ':odd', '-dash.txt', '文件/說明（一）.md', 'a"b.txt'];
    for (const f of [...ANCHORS, 'other.txt', 'dir2/y.txt']) {
      fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      fs.writeFileSync(path.join(repo, f), `${f}\n`);
    }
    g(repo, 'init', '-q');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'base');
    const loose = withKeys({});
    const reg = withKeys({ indexAnchors: ANCHORS });
    const check = (settings = reg) => runChecks({ settings, cwd: repo });
    const indexFile = g(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index');

    // 1. 健康＝0（含 : 開頭、- 開頭、中文、雙引號的錨點）
    const fine = check();
    assert.equal(fine.code, 0, fine.lines.join('\n'));
    assert.doesNotMatch(fine.lines.join('\n'), /索引錨點（checks\.indexAnchors/u, '登記了就不再說沒驗');
    // 行程帶著 GIT_DIR（指向另一個沒有這些錨點的健康倉庫）：問錨點那一次也要清掉它，不然問到的是那個倉庫、判成找不到
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    g(elsewhere, 'init', '-q');
    fs.writeFileSync(path.join(elsewhere, 'z.txt'), 'z\n');
    g(elsewhere, 'add', '.');
    g(elsewhere, 'commit', '-q', '-m', 'z');
    const prevDir = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(elsewhere, '.git');
    let dirty;
    try { dirty = check(); } finally { if (prevDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prevDir; }
    assert.equal(dirty.code, 0, `帶著髒 GIT_DIR、樹是健康的＝0：${dirty.lines.join('\n')}`);
    // 問錨點的那一次 git 失敗（PATH 最前面放一支假 git，只讓帶 --literal-pathspecs 的那一次退 128）：不可以當成都在
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\ncase " $* " in *" --literal-pathspecs "*) echo "fatal: injected" >&2; exit 128;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${prevPath}`;
    let blind;
    let blindLoose;
    try { blind = check(); blindLoose = check(loose); } finally { process.env.PATH = prevPath; }
    assert.equal(blindLoose.code, 0, `對照組：假 git 只擋問錨點那一次，其餘照常：${blindLoose.lines.join('\n')}`);
    assert.equal(blind.code, 2, `問不到錨點＝不放行：${blind.lines.join('\n')}`);
    assert.match(blind.lines[0], /git 讀不了/u);

    // 2. 整份清空（兩種寫法）
    for (const args of [['read-tree', '--empty'], ['rm', '-r', '-q', '--cached', '.']]) {
      const why = args.join(' ');
      g(repo, ...args);
      assert.equal(raw(repo, 'ls-files').stdout, '', `前提（${why}）：ls-files 靜靜回空`);
      assert.ok(fs.existsSync(indexFile), `前提（${why}）：索引檔還在`);
      assert.equal(check(loose).code, 0, `沒登記（${why}）＝照舊放行`);
      const r = check();
      assert.equal(r.code, 2, `${why}：${r.lines.join('\n')}`);
      assert.match(r.lines[0], /登記的全部不見：索引整份是空的/u);
      assert.match(r.lines.join('\n'), /有意暫存刪除或改名錨點的話不要照做/u, '三關前：先提醒有意暫存的不要照做');
      assert.equal(paste(r, away).length, 1, r.lines.join('\n'));
      assert.equal(check().code, 0, `照貼還原之後＝0（${why}）`);
    }

    // 3. 只拿掉一筆
    g(repo, 'rm', '-q', '--cached', 'anchor.txt');
    const r12 = check();
    assert.equal(r12.code, 2, r12.lines.join('\n'));
    assert.match(r12.lines[0], /：anchor\.txt。$/u, `只列少掉的那一個：${r12.lines[0]}`);
    // 只登記這一個、只拿掉它：登記的全部不見，但索引裡還有別的檔＝不說「整份是空的」
    const onlyOne = check(withKeys({ indexAnchors: ['anchor.txt'] }));
    assert.equal(onlyOne.code, 2, onlyOne.lines.join('\n'));
    assert.match(onlyOne.lines[0], /登記的全部不見/u);
    assert.doesNotMatch(onlyOne.lines[0], /整份/u, `索引裡還有別的檔：${onlyOne.lines[0]}`);
    assert.equal(paste(r12, away).length, 1);
    assert.equal(check().code, 0, '照貼還原之後＝0');
    // 整份清空、登記裡又有一筆最新提交裡本來就沒有：兩段都說（一段叫你改登記、一段給還原）
    g(repo, 'read-tree', '--empty');
    const mixed = check(withKeys({ indexAnchors: [...ANCHORS, 'ghost.txt'] }));
    assert.equal(mixed.code, 2, mixed.lines.join('\n'));
    assert.match(mixed.lines[0], /登記的全部不見：索引整份是空的/u, mixed.lines[0]);
    assert.match(mixed.lines.join('\n'), /最新提交裡也沒有：ghost\.txt。登記跟專案對不上/u);
    assert.equal(commandLines(mixed).length, 1, mixed.lines.join('\n'));
    g(repo, 'read-tree', 'HEAD');
    // 錨點填成目錄：最新提交裡它是目錄，重建索引也不會好＝不給指令、說要填檔案
    for (const anchors of [['dir2'], [...ANCHORS, 'dir2']]) {
      const d = check(withKeys({ indexAnchors: anchors }));
      assert.equal(d.code, 2, d.lines.join('\n'));
      assert.match(d.lines.join('\n'), /在最新提交裡是目錄：dir2。錨點要填檔案、不能填目錄/u, d.lines.join('\n'));
      assert.equal(commandLines(d).length, 0, `填了目錄不給 git 指令：${d.lines.join('\n')}`);
      assert.doesNotMatch(d.lines.join('\n'), /只是少了這幾筆/u, '登記填錯不是索引丟了東西');
    }

    // 4. 索引裡那一筆的路徑被改了一個位元組（檢查碼沒重算）
    const buf = fs.readFileSync(indexFile);
    const at = buf.indexOf('anchor.txt');
    assert.ok(at > 0, '前提：索引裡找得到那一筆');
    buf.write('anchos.txt', at);
    fs.writeFileSync(indexFile, buf);
    const listed = raw(repo, 'ls-files');
    assert.equal(listed.status, 0, '前提：ls-files 照常');
    assert.match(listed.stdout, /^anchos\.txt$/mu, '前提：列出來的是被改過的名字');
    const r13 = check();
    assert.equal(r13.code, 2, r13.lines.join('\n'));
    assert.equal(paste(r13, away).length, 1);
    // 照貼之後索引跟最新提交逐筆相同（以 NUL 分隔比）：只補錨點那幾筆的還原會留下被改壞的那一筆，這一句當下就紅
    assert.equal(raw(repo, 'ls-files', '-z').stdout, raw(repo, 'ls-tree', '-r', '--name-only', '-z', 'HEAD').stdout, '照貼之後索引清單＝最新提交的清單');
    assert.equal(check().code, 0, '照貼還原之後＝0');

    // 5. 三關中途清空（兩種寫法）
    for (const cmd of [['git', 'read-tree', '--empty'], ['git', 'rm', '-r', '-q', '--cached', '.']]) {
      assert.equal(check(withKeys({}, [cmd])).code, 0, `沒登記（${cmd.join(' ')}）＝照舊放行`);
      g(repo, 'read-tree', 'HEAD');
      const r = check(withKeys({ indexAnchors: ANCHORS }, [cmd]));
      assert.equal(r.code, 1, r.lines.join('\n'));
      const text = r.lines.join('\n');
      assert.match(text, /三關跑完之後，這棵樹的索引/u);
      assert.match(text, /或是不是同一段時間有別的工作階段在動/u, '三關後也可能是別的工作階段：照實說');
      assert.match(text, /如果是同一段時間別的工作階段有意暫存刪除或改名錨點，不要照做/u, '三關後的提醒放在指令之前');
      assert.doesNotMatch(text, /改 settings\.json/u, '三關後（跑之前都在）不叫人改登記');
      assert.doesNotMatch(text, /本來就是裸儲存庫/u);
      assert.equal(paste(r, away).length, 1);
      assert.equal(check().code, 0, '照貼還原之後＝0');
    }

    // 5b. 三關中途 HEAD 被動了
    const branch = g(repo, 'symbolic-ref', '--short', 'HEAD');
    const base = g(repo, 'rev-parse', 'HEAD');
    const as = (cmd) => ['sh', '-c', cmd];
    const commitCmd = 'git -c user.name=t -c user.email=t@x commit -q --allow-empty -m moved';
    // (a) 切到還沒有提交的分支：錨點那一項被跳過，不可以放行
    assert.equal(check(withKeys({}, [as('git switch -q --orphan tmp')])).code, 0, '沒登記（switch --orphan）＝照舊放行');
    g(repo, 'switch', '-q', branch);
    // 帶著髒 GIT_DIR（指向 elsewhere，它也有同名分支、指在別顆）跑：問原本的分支在哪那一次也要清，不然會判成分支被移動了
    process.env.GIT_DIR = path.join(elsewhere, '.git');
    let orphan;
    try { orphan = check(withKeys({ indexAnchors: ANCHORS }, [as('git switch -q --orphan tmp')])); } finally { if (prevDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prevDir; }
    assert.equal(g(elsewhere, 'symbolic-ref', '--short', 'HEAD'), branch, '前提：elsewhere 也有同名分支');
    assert.notEqual(g(elsewhere, 'rev-parse', 'HEAD'), base, '前提：elsewhere 那個同名分支指在別顆');
    assert.equal(orphan.code, 1, `三關中途 switch --orphan：${orphan.lines.join('\n')}`);
    assert.match(orphan.lines.join('\n'), /HEAD 解析不到了/u);
    assert.doesNotMatch(orphan.lines.join('\n'), /改 settings\.json/u, '不叫人改登記');
    assert.deepEqual(commandLines(orphan).map((l) => l.replace(/^git -C '.+' /u, '')), [`switch '${branch}'`], orphan.lines.join('\n'));
    paste(orphan, away);
    assert.equal(g(repo, 'status', '--porcelain'), '', '照貼之後樹是乾淨的');
    assert.equal(check().code, 0, '照貼之後＝0');
    // (b) checkout --orphan 再清空索引（檔案還在工作區）：switch 會被拒絕，改用訊息裡「只把 HEAD 指回去」那一句
    const co = check(withKeys({ indexAnchors: ANCHORS }, [as('git checkout -q --orphan x && git rm -r -q --cached .')]));
    assert.equal(co.code, 1, co.lines.join('\n'));
    assert.doesNotMatch(co.lines.join('\n'), /改 settings\.json/u);
    const [, pointer] = co.lines.join('\n').match(/改用 (git -C .+?) 只把 HEAD 指回去/u) || [];
    assert.ok(pointer, co.lines.join('\n'));
    assert.equal(spawnSync('sh', ['-c', pointer], { cwd: away, encoding: 'utf8', env: gitEnv() }).status, 0, `照貼 ${pointer}`);
    const after = check();
    assert.equal(after.code, 2, `HEAD 指回去之後，索引還是空的：${after.lines.join('\n')}`);
    paste(after, away);
    assert.equal(g(repo, 'status', '--porcelain'), '', '照貼之後樹是乾淨的');
    assert.equal(check().code, 0, '照貼之後＝0');
    // (c) 分離的 HEAD：切回那一顆提交
    g(repo, 'switch', '-q', '--detach');
    const det = check(withKeys({ indexAnchors: ANCHORS }, [as('git switch -q --orphan tmp')]));
    assert.equal(det.code, 1, det.lines.join('\n'));
    assert.deepEqual(commandLines(det).map((l) => l.replace(/^git -C '.+' /u, '')), [`switch --detach ${base}`], det.lines.join('\n'));
    paste(det, away);
    assert.equal(check().code, 0, '照貼之後＝0');
    g(repo, 'switch', '-q', branch);
    // (d) 分支被移動了（先提交一顆才切走）：不切回那個分支，切回跑之前那一顆
    const movedRun = check(withKeys({ indexAnchors: ANCHORS }, [as(`${commitCmd} && git switch -q --orphan tmp`)]));
    assert.equal(movedRun.code, 1, movedRun.lines.join('\n'));
    assert.match(movedRun.lines.join('\n'), /已經不指在跑之前那一顆上/u);
    assert.deepEqual(commandLines(movedRun).map((l) => l.replace(/^git -C '.+' /u, '')), [`switch --detach ${base}`], movedRun.lines.join('\n'));
    paste(movedRun, away);
    assert.equal(check().code, 0, '照貼之後＝0');
    g(repo, 'switch', '-q', branch);
    g(repo, 'reset', '-q', '--hard', base);
    // (e) 提交了刪除錨點（HEAD 被移動）：不叫人改登記，指去看 HEAD 移動紀錄
    const oops = check(withKeys({ indexAnchors: ANCHORS }, [as(`git rm -q --cached anchor.txt && ${commitCmd.replace('--allow-empty -m moved', '-m oops')}`)]));
    assert.equal(oops.code, 1, oops.lines.join('\n'));
    assert.match(oops.lines.join('\n'), /HEAD 被移動了/u);
    assert.doesNotMatch(oops.lines.join('\n'), /改 settings\.json/u, '三關中途提交了刪除：不叫人改登記');
    assert.deepEqual(commandLines(oops).map((l) => l.replace(/^git -C '.+' /u, '')), ['reflog -n 5'], oops.lines.join('\n'));
    paste(oops, away);
    g(repo, 'reset', '-q', base);
    assert.equal(check().code, 0, '退回之後＝0');
    // (f) 跑之前只暫存、還沒提交的錨點被拿掉：HEAD 沒動，叫人重新暫存、不叫人改登記
    fs.writeFileSync(path.join(repo, 'fresh.txt'), 'fresh\n');
    g(repo, 'add', 'fresh.txt');
    const withFresh = withKeys({ indexAnchors: [...ANCHORS, 'fresh.txt'] }, [['git', 'rm', '-q', '--cached', 'fresh.txt']]);
    const staged = check(withFresh);
    assert.equal(staged.code, 1, staged.lines.join('\n'));
    assert.match(staged.lines.join('\n'), /最新提交裡本來就沒有：fresh\.txt.*重新暫存/u);
    assert.doesNotMatch(staged.lines.join('\n'), /改 settings\.json/u);
    assert.equal(commandLines(staged).length, 0, staged.lines.join('\n'));
    fs.rmSync(path.join(repo, 'fresh.txt'));
    // (g) 最新提交裡是目錄、跑之前索引裡暫存成同名的檔（只暫存、還沒提交），三關中途被拿掉：登記沒填錯，不叫人改登記
    const swap = path.join(root, 'swap');
    fs.mkdirSync(path.join(swap, 'replace'), { recursive: true });
    fs.writeFileSync(path.join(swap, 'replace', 'old.txt'), 'old\n');
    g(swap, 'init', '-q');
    g(swap, 'add', '.');
    g(swap, 'commit', '-q', '-m', 'base');
    g(swap, 'rm', '-r', '-q', 'replace');
    fs.writeFileSync(path.join(swap, 'replace'), 'now a file\n');
    g(swap, 'add', 'replace');
    const swapHead = g(swap, 'rev-parse', 'HEAD');
    assert.equal(g(swap, 'cat-file', '-t', 'HEAD:replace'), 'tree', '前提：最新提交裡 replace 是目錄');
    assert.equal(g(swap, 'ls-files', '--', 'replace'), 'replace', '前提：索引裡 replace 是檔案');
    const swapped = (commands) => runChecks({ settings: withKeys({ indexAnchors: ['replace'] }, commands), cwd: swap });
    assert.equal(swapped([OK_CMD]).code, 0, '跑之前：登記對得上索引裡的檔＝0');
    const pulled = swapped([['git', 'rm', '-q', '--cached', 'replace']]);
    assert.equal(pulled.code, 1, pulled.lines.join('\n'));
    assert.equal(g(swap, 'rev-parse', 'HEAD'), swapHead, '前提：HEAD 沒動');
    assert.ok(fs.statSync(path.join(swap, 'replace')).isFile(), '前提：工作區的檔還在');
    const pulledText = pulled.lines.join('\n');
    assert.match(pulledText, /最新提交裡它是目錄：replace（跑之前索引裡是檔案＝只暫存、還沒提交）：有一題把它從索引拿掉了。不要改登記/u, pulledText);
    assert.doesNotMatch(pulledText, /改 settings\.json|不能填目錄/u, `三關後不叫人改登記、不說填了目錄：${pulledText}`);
    const pulledHead = pulled.lines.findIndex((l) => l.startsWith('三關跑完之後'));
    assert.ok(pulledHead !== -1 && pulled.lines.slice(pulledHead + 1).every((l) => !l.includes('checks.indexAnchors')), `開頭那一行指名登記項之後，不再提登記：${pulledText}`);
    assert.equal(commandLines(pulled).length, 0, pulledText);
    g(swap, 'add', 'replace');
    assert.equal(swapped([OK_CMD]).code, 0, '重新暫存回去之後＝0');
    // (h) 三關中途合法地暫存、提交非錨點的修改（HEAD 前進、錨點都還在）＝0：不攔同一棵樹上正常的 add／commit
    const legit = check(withKeys({ indexAnchors: ANCHORS }, [as(`printf 'more\\n' >> other.txt && git add other.txt && ${commitCmd.replace('--allow-empty -m moved', '-m legit')}`)]));
    assert.equal(legit.code, 0, legit.lines.join('\n'));
    assert.notEqual(g(repo, 'rev-parse', 'HEAD'), base, '前提：HEAD 真的前進了');
    g(repo, 'reset', '-q', '--hard', base);

    // 6. 合法、登記了也＝0
    g(repo, 'rm', '-q', '--cached', 'other.txt');
    assert.equal(check().code, 0, '取消追蹤非錨點＝0');
    g(repo, 'reset', '-q');
    g(repo, 'mv', 'other.txt', 'other2.txt');
    assert.equal(check().code, 0, '改名非錨點＝0');
    g(repo, 'mv', 'other2.txt', 'other.txt');
    fs.appendFileSync(path.join(repo, 'anchor.txt'), 'more\n');
    g(repo, 'add', 'anchor.txt');
    assert.equal(check().code, 0, '暫存修改錨點＝0');
    g(repo, 'reset', '-q', '--hard');
    // 稀疏 cone（有沒有稀疏索引兩種）：健康＝0；拿掉一個錨點，照貼訊息裡每一行還原之後，樹是乾淨的、範圍外的檔仍標成不在工作區
    for (const flavor of ['--sparse-index', '--no-sparse-index']) {
      g(repo, 'sparse-checkout', 'init', '--cone', flavor);
      g(repo, 'sparse-checkout', 'set', 'dir2');
      assert.ok(!fs.existsSync(path.join(repo, 'deep')), `前提（${flavor}）：錨點所在的目錄不在磁碟上`);
      if (flavor === '--sparse-index') assert.match(raw(repo, 'ls-files', '--sparse').stdout, /^deep\/$/mu, '前提：索引裡 deep 收成一筆稀疏目錄');
      assert.equal(check().code, 0, `稀疏 cone（${flavor}）＝0`);
      g(repo, 'rm', '-q', '--cached', 'anchor.txt');
      const sp = check();
      assert.equal(sp.code, 2, sp.lines.join('\n'));
      assert.equal(paste(sp, away).length, 2, `稀疏的樹要多一行 reapply：${sp.lines.join('\n')}`);
      assert.equal(g(repo, 'status', '--porcelain'), '', `照貼之後樹是乾淨的（${flavor}）`);
      assert.match(raw(repo, 'ls-files', '-v', '--', 'deep/x/anchor2.txt').stdout, /^S /u, `範圍外的檔仍標成不在工作區（${flavor}）`);
      assert.equal(check().code, 0, `照貼之後＝0（${flavor}）`);
      g(repo, 'sparse-checkout', 'disable');
    }

    // 7. 照登記擋的（專案自己選的）
    g(repo, 'rm', '-r', '-q', '.');
    assert.equal(check(loose).code, 0, '沒登記：暫存刪除全部＝0（⑨的正面控制照舊）');
    assert.equal(check().code, 2, '登記了：暫存刪除全部（含錨點）＝2');
    g(repo, 'reset', '-q', '--hard', 'HEAD');
    g(repo, 'mv', 'anchor.txt', 'renamed.txt');
    g(repo, 'commit', '-q', '-m', 'rename');
    const stale = check();
    assert.equal(stale.code, 2, stale.lines.join('\n'));
    assert.match(stale.lines.join('\n'), /最新提交裡也沒有：anchor\.txt。登記跟專案對不上/u);
    assert.equal(commandLines(stale).length, 0, '登記跟專案對不上時不給 git 指令（重建索引也不會好）');
    assert.equal(check(withKeys({ indexAnchors: ['renamed.txt', 'deep/x/anchor2.txt', ':odd'] })).code, 0, '登記跟著改＝0');

    // 8. HEAD 解析不到（剛 init、或目前在還沒有提交的分支上）：登記了也不驗＝0，全綠那一行照實說這次沒驗
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh);
    g(fresh, 'init', '-q');
    const three = withKeys({ indexAnchors: ['package.json', 'AGENTS.md', 'server.js'] });
    const skippedAnchor = /登記了、這次沒驗：索引錨點（checks\.indexAnchors；HEAD 解析不到/u;
    const empty = runChecks({ settings: three, cwd: fresh });
    assert.equal(empty.code, 0, `剛 init、還沒提交：${empty.lines.join('\n')}`);
    assert.match(empty.lines.at(-1), skippedAnchor, empty.lines.at(-1));
    fs.writeFileSync(path.join(fresh, 'package.json'), '{}\n');
    g(fresh, 'add', 'package.json');
    assert.equal(runChecks({ settings: three, cwd: fresh }).code, 0, '剛 init、只暫存了一個錨點、還沒提交＝0');
    g(fresh, 'commit', '-q', '-m', 'first');
    const firstCommit = runChecks({ settings: three, cwd: fresh });
    assert.equal(firstCommit.code, 2, `對照組：有提交之後同一份登記就驗：${firstCommit.lines.join('\n')}`);
    assert.match(firstCommit.lines.join('\n'), /最新提交裡也沒有/u);
    g(fresh, 'switch', '-q', '--orphan', 'other');
    const onOrphan = runChecks({ settings: three, cwd: fresh });
    assert.equal(onOrphan.code, 0, `有提交、但目前在還沒有提交的分支上：${onOrphan.lines.join('\n')}`);
    assert.match(onOrphan.lines.at(-1), skippedAnchor, onOrphan.lines.at(-1));
    // 三關前跳過、三關後驗到：剛 init、已暫存錨點、還沒有 HEAD，唯一一關做第一顆提交。全綠那一行仍要說三關前那一次沒驗
    const firstRun = path.join(root, 'first-run');
    fs.mkdirSync(firstRun);
    g(firstRun, 'init', '-q');
    fs.writeFileSync(path.join(firstRun, 'package.json'), '{}\n');
    g(firstRun, 'add', 'package.json');
    const onlyPkg = (commands) => runChecks({ settings: withKeys({ indexAnchors: ['package.json'] }, commands), cwd: firstRun });
    assert.notEqual(raw(firstRun, 'rev-parse', '--verify', '-q', 'HEAD').status, 0, '前提：跑之前 HEAD 解析不到');
    const born = onlyPkg([['sh', '-c', 'git -c user.name=t -c user.email=t@x commit -q -m first']]);
    assert.equal(raw(firstRun, 'rev-parse', '--verify', '-q', 'HEAD').status, 0, '前提：跑完 HEAD 解析得到（三關後那一次真的驗了錨點）');
    assert.equal(born.code, 0, born.lines.join('\n'));
    assert.match(born.lines.at(-1), skippedAnchor, `三關前那一次沒驗，全綠那一行要照實說：${born.lines.at(-1)}`);
    const again = onlyPkg([OK_CMD]);
    assert.equal(again.code, 0, again.lines.join('\n'));
    assert.doesNotMatch(again.lines.at(-1), /登記了、這次沒驗/u, `對照組：前後都驗到就不說沒驗：${again.lines.at(-1)}`);
    // 三關前跳過、三關後才驗到而且不對＝1，但跑之前沒驗過：不可以用三關後那一套（跑之前都在、有一題拿掉了、不要改登記），
    // 改用三關前那一套判斷；下一次跑（三關前就驗到）說的是同一件事
    const firstCommit1 = ['sh', '-c', 'git -c user.name=t -c user.email=t@x commit -q -m first'];
    const lateRun = (name, anchors, files) => {
      const dir = path.join(root, name);
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), `${f}\n`);
      }
      g(dir, 'init', '-q');
      g(dir, 'add', '--', ...files);
      assert.notEqual(raw(dir, 'rev-parse', '--verify', '-q', 'HEAD').status, 0, `前提（${name}）：跑之前 HEAD 解析不到`);
      const settings = withKeys({ indexAnchors: anchors }, [firstCommit1]);
      const r = runChecks({ settings, cwd: dir });
      assert.equal(raw(dir, 'rev-parse', '--verify', '-q', 'HEAD').status, 0, `前提（${name}）：跑完 HEAD 解析得到`);
      const text = r.lines.join('\n');
      assert.equal(r.code, 1, text);
      assert.match(r.lines[1], /^專案登記的索引錨點（checks\.indexAnchors）跑之前 HEAD 解析不到、這一項沒驗；三關跑完之後才驗到，找不到：/u, text);
      assert.doesNotMatch(text.replace(/跑之前 HEAD 解析不到/gu, ''), /跑之前/u, `除了「跑之前 HEAD 解析不到」，不說跑之前怎樣：${text}`);
      assert.doesNotMatch(text, /不要改登記|有一題把它從索引拿掉了|只暫存、還沒提交/u, `不用三關後那一套：${text}`);
      assert.doesNotMatch(text, /只是少了這幾筆/u, `登記填錯不是索引丟了東西：${text}`);
      assert.match(text, /在同一支變更裡改 settings\.json 的 checks\.indexAnchors/u, `叫人改登記：${text}`);
      assert.equal(commandLines(r).length, 0, text);
      const next = runChecks({ settings: withKeys({ indexAnchors: anchors }), cwd: dir });
      assert.equal(next.code, 2, `下一次跑（三關前就驗到）：${next.lines.join('\n')}`);
      assert.match(next.lines.join('\n'), /在同一支變更裡改 settings\.json 的 checks\.indexAnchors/u, `下一次跑說的是同一件事：${next.lines.join('\n')}`);
      return text;
    };
    // (1) 錨點填成有檔的目錄
    const lateDir = lateRun('late-dir', ['docs'], ['docs/a.md']);
    assert.match(lateDir, /在最新提交裡是目錄：docs。錨點要填檔案、不能填目錄/u, lateDir);
    // (2) 登記了兩個、只暫存了一個：另一個最新提交裡也沒有＝登記跟專案對不上
    const lateGhost = lateRun('late-ghost', ['package.json', 'AGENTS.md'], ['package.json']);
    assert.match(lateGhost, /找不到：AGENTS\.md。/u, lateGhost);
    assert.match(lateGhost, /最新提交裡也沒有：AGENTS\.md。登記跟專案對不上/u, lateGhost);
    assert.doesNotMatch(lateGhost, /跑之前都在/u, lateGhost);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(away, { recursive: true, force: true });
  }
});

test('⑫兩個登記寫錯＝2、一關都不跑、訊息指出哪一格；沒寫或寫「未設定」＝沒登記、全綠那一行照實說沒驗；登記了三關前後都照登記驗；三關後兩種壞法都印、讀不到指紋不說被改了；三關後 HEAD 不見＝1', () => {
  const calls = [];
  const seen = [];
  const run = (argv) => { calls.push(argv); return { status: 0 }; };
  const tree = (_run, _cwd, opts) => { seen.push(opts); return { state: 'ok' }; };
  const go = (extra) => { calls.length = 0; seen.length = 0; return runChecks({ settings: withKeys(extra), run, tree, fingerprint: () => 'same' }); };
  const ch = (n) => String.fromCharCode(n);
  const oneLine = (s) => !Array.from(s).some((c) => { const n = c.codePointAt(0); return n < 0x20 || n === 0x7f || n === 0x85 || n === 0x2028 || n === 0x2029; });
  const anchorsBad = [
    [[], 0], ['a', 0], [null, 0], [[1], 1], [['未設定', 'a'], 1], [['ok.txt', './a'], 2],
    [['a/'], 1], [['/a'], 1], [['..'], 1], [['.'], 1], [['../a'], 1], [['a//b'], 1], [['a/./b'], 1], [['a/../b'], 1], [[''], 1],
    [[`a${ch(10)}b`], 1], [[`a${ch(0x2028)}b`], 1], [[`a${ch(0)}b`], 1], [[`a${ch(0x7f)}b`], 1], [[`a${ch(9)}b`], 1], [[`a${ch(0x85)}b`], 1],
  ];
  for (const [value, at] of anchorsBad) {
    const r = go({ indexAnchors: value });
    const what = JSON.stringify(value);
    assert.equal(r.code, 2, what);
    assert.equal(calls.length + seen.length, 0, `寫錯就一關都不跑、也不去驗樹：${what}`);
    assert.equal(r.lines.length, 1, what);
    assert.match(r.lines[0], /^專案設定 checks\.indexAnchors /u, `訊息要指出是錨點那一格寫錯（不是被「找不到」擋下）：${what}`);
    if (at) assert.match(r.lines[0], new RegExp(`第 ${at} 筆`, 'u'), what);
    assert.ok(oneLine(r.lines[0]), `訊息維持一行：${what}`);
  }
  for (const value of ['裸', '', 1, true, null, `一般工作樹${ch(0x2028)}`]) {
    const r = go({ mainWorktree: value });
    const what = JSON.stringify(value);
    assert.equal(r.code, 2, what);
    assert.equal(calls.length + seen.length, 0, what);
    assert.match(r.lines[0], /^專案設定 checks\.mainWorktree /u, what);
    assert.ok(oneLine(r.lines[0]), `訊息維持一行：${what}`);
  }
  // 沒登記：沒寫、或寫「未設定」
  for (const extra of [{}, { mainWorktree: '未設定', indexAnchors: ['未設定'] }]) {
    const r = go(extra);
    assert.equal(r.code, 0, JSON.stringify(extra));
    assert.deepEqual(seen, [{ mainNormal: false, anchors: null }, { mainNormal: false, anchors: null }], JSON.stringify(extra));
    assert.equal(r.lines.at(-1), '三關全綠（1 關）。沒登記、所以沒驗：主目錄是不是一般工作樹（checks.mainWorktree）、索引錨點（checks.indexAnchors）。');
  }
  const both = go({ mainWorktree: '一般工作樹', indexAnchors: [':odd', 'a/b.txt'] });
  assert.equal(both.code, 0);
  const want = { mainNormal: true, anchors: [':odd', 'a/b.txt'] };
  assert.deepEqual(seen, [want, want], '三關前後兩次都照登記驗');
  assert.equal(both.lines.at(-1), '三關全綠（1 關）。');
  assert.match(go({ mainWorktree: '一般工作樹' }).lines.at(-1), /。沒登記、所以沒驗：索引錨點（checks\.indexAnchors）。$/u);
  assert.match(go({ indexAnchors: ['a'] }).lines.at(-1), /。沒登記、所以沒驗：主目錄是不是一般工作樹（checks\.mainWorktree）。$/u);

  // 三關後樹壞了、設定也變了：兩段都印（原本樹壞了就先回、設定那一段看不到）
  let n = 0;
  let print = 0;
  const flip = () => ({ state: n++ === 0 ? 'ok' : 'wrong-tree' });
  const r = runChecks({ settings: withKeys({}), run, tree: flip, fingerprint: () => `v${print++}` });
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /被指到別處了/u);
  assert.match(r.lines.join('\n'), /設定被改了/u);
  // 三關後指紋讀不到（例如這棵樹的 .git 檔被刪掉）：不說「被改了」，照實說沒辦法比對
  n = 0;
  let prints = 0;
  const gone = runChecks({ settings: withKeys({}), run, tree: flip, fingerprint: () => (prints++ === 0 ? 'v0' : null) });
  assert.equal(gone.code, 1);
  assert.doesNotMatch(gone.lines.join('\n'), /設定被改了/u, gone.lines.join('\n'));
  assert.match(gone.lines.join('\n'), /沒辦法比對/u);

  // 登記了錨點、跑之前 HEAD 解析得到、跑完解析不到＝1；沒登記、或跑之前就解析不到＝0
  const heads = (a, b) => { let k = 0; return () => ({ state: 'ok', head: k++ === 0 ? a : b, branch: null, tree: '/t', skipped: [] }); };
  const anchored = withKeys({ indexAnchors: ['a'] });
  const lost = runChecks({ settings: anchored, run, tree: heads('c0ffee', null), fingerprint: () => 'same' });
  assert.equal(lost.code, 1, lost.lines.join('\n'));
  assert.match(lost.lines[1], /HEAD 解析不到了（跑之前在 c0ffee，分離的 HEAD）/u);
  assert.equal(runChecks({ settings: withKeys({}), run, tree: heads('c0ffee', null), fingerprint: () => 'same' }).code, 0, '沒登記錨點＝照舊放行');
  assert.equal(runChecks({ settings: anchored, run, tree: heads(null, null), fingerprint: () => 'same' }).code, 0, '跑之前就解析不到＝不驗、放行');
  // 登記了、這次沒驗：全綠那一行跟「沒登記、所以沒驗」並列
  const note = runChecks({ settings: withKeys({ mainWorktree: '一般工作樹' }), run, tree: () => ({ state: 'ok', skipped: ['某一項（原因）'] }), fingerprint: () => 'same' });
  assert.equal(note.lines.at(-1), '三關全綠（1 關）。沒登記、所以沒驗：索引錨點（checks.indexAnchors）。登記了、這次沒驗：某一項（原因）。');
});
