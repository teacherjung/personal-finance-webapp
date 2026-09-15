// 守清 git 環境變數的共用實作（規矩 E4）。原專案：鉤子帶著 GIT_DIR 跑考題，考題裡的 git init
// 把主倉庫寫成裸倉庫，而那題顯示通過。
//
// 守得到的：GIT_ 前綴整族清掉（含會長的那一族）；GITHUB_、PATH、HOME 留著；原本那份不動。
// 另守：**整份考卷**在「GIT_DIR 指向別的倉庫」的環境下跑，那個倉庫一點都不能變（2026-09-14 補：
//   搬家修正時查到三支考題自己叫 git 沒清環境——事故的機制原封不動留在考卷裡，而考卷在專案裡正是由推送前鉤子跑的）。
// ⚠️ 守不到的：工具的呼叫點有沒有用它——那由各呼叫點的行為題釘（跨變更試合併閘有一題）；
//   誘餌那題只證明「這一次跑到的路徑」沒寫進別的倉庫，考題沒走到的分支照樣可能漏清；
//   **只讀不寫**的呼叫沒清環境它看不出來（誘餌不會變，只是那一題讀錯倉庫——突變驗過：git worktree list 不清照樣綠）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');

test('GIT_ 前綴整族清掉，含會長的那一族；GITHUB_ 與 PATH、HOME 留著；原本那份不動', () => {
  const env = {
    GIT_DIR: '/x/.git/worktrees/y', GIT_WORK_TREE: '/x', GIT_INDEX_FILE: '/x/i',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/tmp/e',
    GIT_CONFIG_PARAMETERS: "'a=b'", GIT_EXEC_PATH: '/usr/libexec/git-core',
    GITHUB_TOKEN: 'keep-me', PATH: '/usr/bin:/bin', HOME: '/Users/x', LANG: 'C',
  };
  const before = JSON.stringify(env);
  const out = gitEnv(env);
  assert.deepEqual(Object.keys(out).sort(), ['GITHUB_TOKEN', 'HOME', 'LANG', 'PATH']);
  assert.equal(out.GITHUB_TOKEN, 'keep-me', 'GITHUB_ 不是 GIT_ 那一族');
  assert.equal(JSON.stringify(env), before, '原本那份不可以被改');
  assert.ok(!('GIT_DIR' in gitEnv({ ...process.env, GIT_DIR: '/nope' })), '預設吃 process.env 也要清');
});

/** 一個目錄底下每個檔的相對路徑與內容雜湊（誘餌倉庫被寫了沒有，一比就知道）。 */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

test('整份考卷帶著指向誘餌倉庫的 GIT_DIR 跑：全綠，而且誘餌一個位元組都沒變', { skip: process.env.KIT_NESTED_SUITE === '1' ? '巢狀整卷裡不再巢狀' : false }, () => {
  // 原專案事故的機制：推送前鉤子從連結工作樹跑考題，git 把 GIT_DIR 放進環境；考題裡的 git init／git config
  // 沒清環境，就寫進真倉庫（套件倉庫的案例簿 bare-repo-incident；公開紀錄＝personal-finance-webapp #435）。這裡把真倉庫換成誘餌。
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f !== path.basename(__filename)).sort();
  assert.ok(files.length >= 20, `只找到 ${files.length} 支考題：這一題自己的前提變了`);
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'git-decoy-'));
  try {
    // 誘餌要是「主倉庫＋一棵連結工作樹」、GIT_DIR 指向那棵樹的 gitdir：事故就是這個形狀——git 看 GIT_DIR 結尾
    // 不是 .git 就猜它是裸倉庫，git init 於是把 bare = true 寫進**共用**的設定檔（指向 .git 本身反而不會）
    const g = (...a) => spawnSync('git', a, { cwd: decoy, env: { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' }, encoding: 'utf8' });
    for (const step of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'decoy'], ['worktree', 'add', '-q', '--detach', path.join(decoy, 'linked')]]) {
      const r = g(...step);
      assert.equal(r.status, 0, `前提：誘餌倉庫建得起來（git ${step[0]}：${r.stderr}）`);
    }
    const linkedGitDir = path.join(decoy, '.git', 'worktrees', 'linked');
    assert.ok(fs.existsSync(linkedGitDir), '前提：連結工作樹的 gitdir 在');
    const before = snapshot(path.join(decoy, '.git'));
    const env = { ...gitEnv(), GIT_DIR: linkedGitDir, KIT_NESTED_SUITE: '1' };   // 巢狀整卷裡另一題整卷重跑的那題標成跳過
    delete env.NODE_TEST_CONTEXT;   // 不拿掉的話子行程的 node --test 不管紅不紅都退 0
    const r = spawnSync(process.execPath, ['--test', ...files.map((f) => path.join(__dirname, f))], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
    assert.equal(r.status, 0, `帶著別的倉庫的 GIT_DIR，考卷不是全綠：\n${r.stdout.split('\n').filter((l) => /^\s*not ok|^✖/u.test(l)).slice(0, 10).join('\n')}`);
    assert.deepEqual(snapshot(path.join(decoy, '.git')), before, '誘餌倉庫被寫了：有考題（或它叫的工具）叫 git 時沒清環境');
  } finally {
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});
