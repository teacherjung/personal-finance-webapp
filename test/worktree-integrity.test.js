// 「整個 repo 靜靜失去工作樹身分」的考題（2026-08-09 事故）。
//
// 事故當天 `.git/config` 被寫進 `bare = true`，主目錄與 42 棵連結工作樹**同時**失效
// （`git status`／`add`／`commit` 全回 `fatal: this operation must be run in a work tree`）。
// 病因分析與實測結果寫在 `scripts/check-worktree-integrity.js` 的檔頭，這裡不重抄一份
// （抄兩份就會漂）。本檔只負責一件事：**證明那支體檢真的會轉紅**。
//
// ⚠️ 本檔的寫法＝**行為題**：造一棵真的壞掉的 repo 餵進去、實跑 hook、照訊息把還原指令
//    丟給真的 shell——因為「考題只掃原始碼字樣，實作換掉了照樣全綠」是本專案認過的病型
//    （#433 r6 被複驗者示範過）。兩個從審查學來的具體姿勢：
//    ・GIT_* 清理用「實跑 hook＋注入**沒列過名**的變數」驗，不比對名單
//      （名單比對＝拿實作自己的清單驗實作＝循環自證；#435 r1 High②）。
//    ・還原指令用 `sh -c` 照字面跑（使用者就是複製貼上進 shell 的），
//      不用 argv 假代 shell（#435 r2 Medium③）。
//
// ⚠️ **沙盒的安全宣告**：下面有兩處真的會跑 `git init`（那正是事故的兇器）。它們一律：
//    ① 只在 `mkdtempSync` 的暫存目錄裡跑；
//    ② `env` 是**從零組**的（只給 PATH／HOME），不是「process.env 減掉幾個 key」
//       ——所以不可能有任何 GIT_* 洩進去；
//    ③ 事故重現那一題跑完會**回頭斷言真的 repo 還是健康的**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { worktreeIntegrityProblems } from '../scripts/check-worktree-integrity.js';
import { injectDirtyGitEnv, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 沙盒專用環境：**從零組**，不是從 process.env 扣。這樣 GIT_* 不可能洩進 `git init`。 */
const SANDBOX_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

/** @param {string[]} args @param {{ cwd?: string, env?: Record<string,string>, allowFail?: boolean }} [opts] */
function sgit(args, opts = {}) {
  const r = spawnSync('git', args, {
    encoding: 'utf8', cwd: opts.cwd, env: { ...SANDBOX_ENV, ...(opts.env ?? {}) },
  });
  if (r.error) throw r.error;
  if (!opts.allowFail && r.status !== 0) {
    throw new Error(`沙盒 git ${args.join(' ')} 失敗（${r.status}）：${r.stderr}`);
  }
  return { status: r.status, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

/**
 * 造一棵「主 repo ＋ 一棵連結工作樹」的沙盒，跑完一定刪掉。
 * @param {(paths: { dir: string, repo: string, wt: string, wtGitDir: string, sharedConfig: string }) => void} fn
 */
function withSandbox(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-integrity-'));
  try {
    const repo = join(dir, 'repo');
    sgit(['init', '-q', '-b', 'main', repo]);
    sgit(['-C', repo, 'config', 'user.email', 'f@example.com']);
    sgit(['-C', repo, 'config', 'user.name', 'fixture']);
    writeFileSync(join(repo, 'anchor.txt'), 'x\n');
    sgit(['-C', repo, 'add', 'anchor.txt']);
    sgit(['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
    const wt = join(dir, 'wt');
    sgit(['-C', repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD']);
    // 鏡像真 repo 的狀態：extensions.worktreeConfig 開著，但沒有任何一棵樹覆寫 core.bare
    //（事故當天就是這樣——所以共用 config 一被寫壞，43 棵樹一起中）。
    sgit(['-C', repo, 'config', 'extensions.worktreeConfig', 'true']);
    fn({ dir, repo, wt, wtGitDir: join(repo, '.git', 'worktrees', 'wt'), sharedConfig: join(repo, '.git', 'config') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 沙盒的錨點檔（真 repo 用 package.json 那組，沙盒裡沒有那些檔）。 */
const SANDBOX_ANCHORS = ['anchor.txt'];
/** @param {{ id: string, message: string }[]} problems */
const ids = (problems) => problems.map((p) => p.id);

/**
 * 從體檢訊息抽出「還原：git …」那一行，**照字面交給真的 shell** 跑——使用者就是這樣
 * 複製貼上的。用 argv 假代 shell 會跳過引號與 `$` 展開，量不到訊息真正的可用性
 * （#435 r2 Medium③：雙引號包路徑時，路徑裡字面的 $HOME 會被展開、指令壞掉）。
 * @param {string} message
 * @returns {{ status: number, err: string, cmd: string }}
 */
function runRepairFromMessage(message) {
  const m = message.match(/^\s*還原：(git .+)$/m);
  assert.ok(m, `訊息裡找不到「還原：git …」指令：\n${message}`);
  const r = spawnSync('sh', ['-c', m[1]], { encoding: 'utf8', cwd: tmpdir(), env: { ...SANDBOX_ENV } });
  return { status: r.status ?? -1, err: String(r.stderr ?? '').trim(), cmd: m[1] };
}

test('⭐ 這一棵 checkout 現在是健康的工作樹（這就是那道閘本身）', () => {
  const problems = worktreeIntegrityProblems(ROOT);
  assert.deepEqual(problems, [],
    '這棵樹的工作樹身分有問題：\n'
    + problems.map((p) => `[${p.id}] ${p.message}`).join('\n')
    + '\n（還原完之後請照 scripts/check-worktree-integrity.js 檔頭查是誰寫的。）');
});

test('⭐ 事故的原地重現：GIT_DIR 指向連結工作樹時跑 git init，共用 config 當場變 bare', () => {
  withSandbox(({ repo, wtGitDir, sharedConfig }) => {
    const tmp = mkdtempSync(join(tmpdir(), 'innocent-cwd-'));
    try {
      assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
        '沙盒剛造好就已經壞了＝這一題後面驗的東西沒有意義');

      // 這就是那把兇器：cwd 明明指在一個完全無關的暫存目錄，但有 GIT_DIR 時 git 不看 cwd。
      sgit(['init', '-q'], { cwd: tmp, env: { GIT_DIR: wtGitDir } });

      assert.match(readFileSync(sharedConfig, 'utf8'), /^\s*bare\s*=\s*true$/m,
        '共用 .git/config 沒有變成 bare=true ⇒ 這一題已經不是在重現 2026-08-09 的事故了。\n'
        + '（git 版本換了？先確認機制還在，再決定要不要改題目——不要直接刪。）');

      const afterProbs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
      const after = ids(afterProbs);
      assert.ok(after.includes('core-bare'),
        `體檢沒有抓到 core.bare=true（只回報了 ${JSON.stringify(after)}）⇒ 那道閘是空的。`);
      assert.ok(after.includes('not-a-work-tree'),
        `體檢沒有抓到「已經不是工作樹」（只回報了 ${JSON.stringify(after)}）。`);
      // 每一種會印「還原：」的病灶，指令都要照貼可跑（#435 r3 Medium②）——這裡跑 core-bare 的。
      const bareP = afterProbs.find((p) => p.id === 'core-bare');
      assert.ok(bareP);
      const fix = runRepairFromMessage(bareP.message);
      assert.equal(fix.status, 0, `core-bare 的還原指令跑不動（${fix.status}）：${fix.err}\n指令＝${fix.cmd}`);
      assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
        '照 core-bare 的還原指令跑完，沙盒 repo 卻沒活回來。');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ⚠️ 上面真的跑了 git init。回頭確認它沒有波及本尊——這一行就是本檔自己的保險絲。
  assert.deepEqual(worktreeIntegrityProblems(ROOT), [],
    '⛔ 這一題的 fixture 把**真的 repo** 弄壞了。立刻檢查 SANDBOX_ENV 是不是被改成會帶 GIT_* 進去。');
});

test('⭐ 連結工作樹也一起中：共用 config 一 bare，worktree 那一邊同樣不是工作樹', () => {
  withSandbox(({ repo, wt }) => {
    assert.deepEqual(ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS })), []);
    sgit(['-C', repo, 'config', 'core.bare', 'true']);
    const seenFromWorktree = ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS }));
    assert.ok(seenFromWorktree.includes('core-bare') && seenFromWorktree.includes('not-a-work-tree'),
      '從連結工作樹看不到共用 config 的 core.bare ⇒ 「驗一棵就夠」這個宣告不成立，'
      + `體檢必須改成逐棵驗（實際回報：${JSON.stringify(seenFromWorktree)}）。`);
  });
});

test('⭐ 掩蔽騙不過：樹自己覆寫 core.bare=false 時，共用 config 的 bare=true 還是要被抓', () => {
  withSandbox(({ repo, wt }) => {
    sgit(['-C', wt, 'config', '--worktree', 'core.bare', 'false']);
    sgit(['-C', repo, 'config', 'core.bare', 'true']);
    // 這棵樹自己因為覆寫而一切正常（git 在這裡照常運作）——只看 effective 值會回報零問題，
    // 但共用 config 已經壞了：其他沒覆寫的樹（含主目錄）此刻全部中鏢（#435 r1 Medium③）。
    const seen = ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS }));
    assert.ok(seen.includes('core-bare-shared'),
      `共用 config 的 bare=true 被這棵樹的 worktree 覆寫蓋住，體檢卻回報 ${JSON.stringify(seen)}`
      + '——「驗一棵就夠」只有在直接讀共用原始值時才成立。');
  });
});

test('⭐ 同族壞法①：core.worktree 指到不存在的路徑', () => {
  withSandbox(({ repo }) => {
    sgit(['-C', repo, 'config', 'core.worktree', '/nowhere/does/not/exist']);
    const seen = ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS }));
    assert.ok(seen.includes('core-worktree-missing'),
      `體檢沒抓到 core.worktree 亂指（回報：${JSON.stringify(seen)}）。`
      + '這一種會讓每個 git 指令都變成 fatal: Invalid path。');
    // ⚠️ 順序也要釘住：這個狀態下 rev-parse 一律 fatal，所以體檢一定也會回一個 not-a-repo。
    //    **成因必須排在後果前面**，不然看訊息的人只會看到「這裡不是 repo」而去查錯方向。
    assert.equal(seen[0], 'core-worktree-missing',
      `第一項是 ${seen[0]}，成因被後果蓋掉了（完整回報：${JSON.stringify(seen)}）。`);
  });
});

test('合法的相對 core.worktree（以 gitdir 為基準）不可以被誤判成壞掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-relcw-'));
  try {
    const work = join(dir, 'work');
    mkdirSync(work);
    sgit(['init', '-q', '-b', 'main', '--separate-git-dir', join(dir, 'gitbox'), work]);
    sgit(['-C', work, 'config', 'user.email', 'f@example.com']);
    sgit(['-C', work, 'config', 'user.name', 'fixture']);
    writeFileSync(join(work, 'anchor.txt'), 'x\n');
    sgit(['-C', work, 'add', 'anchor.txt']);
    sgit(['-C', work, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
    // 相對路徑以 $GIT_DIR（<dir>/gitbox）為基準 ⇒ ../work＝<dir>/work，真實存在＝合法設定。
    sgit(['-C', work, 'config', 'core.worktree', '../work']);
    assert.equal(sgit(['-C', work, 'rev-parse', '--is-inside-work-tree']).out, 'true',
      '前提壞了：git 自己都不認這個設定，本題要重寫');
    const seen = ids(worktreeIntegrityProblems(work, { requiredTracked: SANDBOX_ANCHORS }));
    assert.ok(!seen.includes('core-worktree-missing'),
      `git 自己說這是好好的工作樹，體檢卻把合法的相對 core.worktree 判成壞掉`
      + `（回報：${JSON.stringify(seen)}）——誤擋跟漏抓一樣是病（#435 r1 Medium④）。`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ 還原指令自己要跑得動：照體檢印的指令用真 shell 執行，repo 要活回來', () => {
  withSandbox(({ repo }) => {
    sgit(['-C', repo, 'config', 'core.worktree', '/nowhere/does/not/exist']);
    const probs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-worktree-missing');
    assert.ok(p, `沒抓到 core-worktree-missing（回報：${JSON.stringify(ids(probs))}）`);
    // r1 抓到的病：舊訊息教 `git -C <repo> config ...`，這個壞法下那個指令自己就 fatal。
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0,
      `照訊息跑還原指令失敗（${r.status}）：${r.err}\n指令＝${r.cmd}\n——訊息在教一條走不通的路。`);
    assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原指令跑成功了，repo 卻還是壞的——指令跟病灶對不上。');
  });
});

test('⭐ git 的同義 true（yes／on／1）騙不過：字面比對＝假綠（r2 Medium①）', () => {
  withSandbox(({ repo, wt }) => {
    // 掩蔽版：這棵樹覆寫 false、共用檔寫的是 `yes`——git 認它是 true，體檢也必須認。
    sgit(['-C', wt, 'config', '--worktree', 'core.bare', 'false']);
    sgit(['-C', repo, 'config', 'core.bare', 'yes']);
    const seen = ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS }));
    assert.ok(seen.includes('core-bare-shared'),
      `共用 config 的 core.bare=yes（git 語意＝true）沒被抓（回報：${JSON.stringify(seen)}）`
      + '——比字面 "true" 會被合法同義值繞過，主目錄此刻已經壞了。');
  });
  withSandbox(({ repo }) => {
    sgit(['-C', repo, 'config', 'core.bare', 'on']);
    const seen = ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS }));
    assert.ok(seen.includes('core-bare'),
      `core.bare=on（git 語意＝true）沒被抓（回報：${JSON.stringify(seen)}）。`);
  });
});

test('⭐ 病灶住在 worktree-local config 時：歸因要對、還原指令要改到對的檔（r2 Medium②）', () => {
  // 反例一：worktree-local 的 core.bare=true——這棵樹壞了，但值不在共用檔。
  withSandbox(({ wt }) => {
    sgit(['-C', wt, 'config', '--worktree', 'core.bare', 'true']);
    const probs = worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-bare');
    assert.ok(p, `沒抓到 core-bare（回報：${JSON.stringify(ids(probs))}）`);
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0, `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
    assert.deepEqual(ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原指令回報成功、這棵樹卻還是壞的——指令改到了別的檔（歸因錯誤，照做等於白做）。');
  });
  // 反例二：worktree-local 的 core.worktree 亂指——effective 讀法自己 fatal，
  // 只讀共用檔的退路會整個看漏這個病灶（舊版只回 not-a-repo、沒有還原指令）。
  withSandbox(({ wt }) => {
    sgit(['-C', wt, 'config', '--worktree', 'core.worktree', '/nowhere/r2-missing']);
    const probs = worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-worktree-missing');
    assert.ok(p,
      `worktree-local 的 core.worktree 亂指沒被辨識成病灶（回報：${JSON.stringify(ids(probs))}）`
      + '——只回 not-a-repo 的話，看訊息的人連還原指令都拿不到。');
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0, `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
    const after = ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS }));
    assert.ok(!after.includes('core-worktree-missing') && !after.includes('not-a-repo'),
      `還原後這棵樹還是壞的（${JSON.stringify(after)}）——指令跟病灶對不上。`);
  });
});

test('⭐ 路徑含 $／反引號／單引號時，還原指令照貼 shell 也不可以走樣（r2 Medium③）', () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-evil-'));
  try {
    // 字面上的 $HOME 與 `id`：引號錯了就會被 shell 展開／執行，指令改到不存在的路徑。
    const evil = join(base, "repo-$HOME-`id`-'q'");
    mkdirSync(evil);
    const repo = join(evil, 'repo');
    sgit(['init', '-q', '-b', 'main', repo]);
    sgit(['-C', repo, 'config', 'user.email', 'f@example.com']);
    sgit(['-C', repo, 'config', 'user.name', 'fixture']);
    writeFileSync(join(repo, 'anchor.txt'), 'x\n');
    sgit(['-C', repo, 'add', 'anchor.txt']);
    sgit(['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
    sgit(['-C', repo, 'config', 'core.worktree', '/nowhere/does/not/exist']);
    const probs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-worktree-missing');
    assert.ok(p, `沒抓到 core-worktree-missing（回報：${JSON.stringify(ids(probs))}）`);
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0,
      `在含 $HOME／反引號／單引號的合法路徑下，照貼還原指令失敗（${r.status}）：${r.err}\n`
      + `指令＝${r.cmd}\n——引號沒關緊，shell 把路徑裡的字面符號展開了。`);
    assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原指令跑成功了，repo 卻還是壞的。');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('⭐ 同族壞法②（最陰的一種）：索引不見了，git ls-files 安安靜靜回空清單', () => {
  withSandbox(({ repo }) => {
    unlinkSync(join(repo, '.git', 'index'));

    // 先把「陰」證明出來：它不噴錯、不非零，只是回空的——考題會因此掃到零個檔案、回報「零違規」。
    const listed = sgit(['-C', repo, 'ls-files'], { allowFail: true });
    assert.equal(listed.status, 0, 'git ls-files 這時居然是非零退出？那它就不是「靜靜失敗」了，本題的前提要重寫');
    assert.equal(listed.out, '', 'git ls-files 沒有回空清單 ⇒ 這一題描述的靜靜失敗已經不存在了');

    const probs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
    const seen = ids(probs);
    assert.ok(seen.includes('index-unusable'),
      `體檢沒抓到索引不見（回報：${JSON.stringify(seen)}）——那所有靠 git ls-files 掃全樹的考題`
      + '都會在這個狀態下靜靜回報「零違規」。');
    // 還原指令照貼可跑（#435 r3 Medium②：舊版把中文備註黏在指令尾巴，照貼必炸）。
    const p = probs.find((x) => x.id === 'index-unusable');
    assert.ok(p);
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0, `index-unusable 的還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
    assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
      '照還原指令重建索引後，沙盒 repo 卻還是壞的。');
  });
});

test('⭐ include 進來的病灶也要抓到、也要修得回（r3 Medium①）', () => {
  // 反例一：共用 config 只放 include.path，bare=true 藏在被 include 的檔裡＋這棵樹覆寫掩蔽。
  withSandbox(({ dir, wt, sharedConfig }) => {
    const inc = join(dir, 'included.cfg');
    writeFileSync(inc, '[core]\n\tbare = true\n');
    sgit(['-C', wt, 'config', '--worktree', 'core.bare', 'false']);
    sgit(['config', '--file', sharedConfig, 'include.path', inc]);
    const probs = worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-bare-shared');
    assert.ok(p,
      `bare=true 藏在 include 檔＋本樹掩蔽，體檢回報 ${JSON.stringify(ids(probs))}`
      + '——不帶 --includes 的直讀會整個看漏（主目錄此刻已經壞了）。');
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0, `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
    assert.deepEqual(ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原指令回報成功、病灶卻還在——指令改到了 include 的殼、不是承載值的檔。');
  });
  // 反例二：core.worktree 亂指藏在被 include 的檔裡——還原指令要指到 include 的那個檔。
  withSandbox(({ dir, repo, sharedConfig }) => {
    const inc = join(dir, 'included2.cfg');
    writeFileSync(inc, '[core]\n\tworktree = /nowhere/include-missing\n');
    sgit(['config', '--file', sharedConfig, 'include.path', inc]);
    const probs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-worktree-missing');
    assert.ok(p, `沒抓到 include 進來的 core.worktree 病灶（回報：${JSON.stringify(ids(probs))}）`);
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0,
      `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}\n`
      + '——r3 Medium① 的原始重現：指令指向共用檔、值卻在 include 檔，照做退出碼 5。');
    assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原後 repo 還是壞的。');
  });
});

test('⭐ 全域設定（~/.gitconfig）的病灶：抓得到、還原指令指向全域檔（r3 Medium①）', () => {
  withSandbox(({ dir, repo }) => {
    const fakeHome = join(dir, 'home');
    mkdirSync(fakeHome);
    writeFileSync(join(fakeHome, '.gitconfig'), '[core]\n\tworktree = /nowhere/global-missing\n');
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = fakeHome;
    process.env.XDG_CONFIG_HOME = join(fakeHome, 'xdg');   // 隔離，別讀到真使用者的
    try {
      const probs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
      const p = probs.find((x) => x.id === 'core-worktree-missing');
      assert.ok(p, `全域 core.worktree 亂指沒被抓（回報：${JSON.stringify(ids(probs))}）`);
      assert.ok(p.message.includes(fakeHome),
        `還原指令沒有指向全域檔（訊息：\n${p.message}）——改 repo 的 .git/config 修不到全域值。`);
      const r = runRepairFromMessage(p.message);
      assert.equal(r.status, 0, `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
      assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
        '還原後 repo 還是壞的。');
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
      if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    }
  });
});

test('⭐ 多值 key：同檔兩筆 core.worktree，一道指令要能整組修掉（r4 Medium）', () => {
  withSandbox(({ repo, sharedConfig }) => {
    // 合法路徑一筆＋亂指一筆：贏家（最後一筆）壞掉，--unset 會因多值 exit 5。
    sgit(['config', '--file', sharedConfig, 'core.worktree', tmpdir()]);
    sgit(['config', '--file', sharedConfig, '--add', 'core.worktree', '/nowhere/second']);
    const probs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-worktree-missing');
    assert.ok(p, `沒抓到多值 core.worktree 的壞贏家（回報：${JSON.stringify(ids(probs))}）`);
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0,
      `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}\n`
      + '——單值形式的 --unset 對多值 key 會 exit 5（r4 Medium 的實測），要用 --unset-all。');
    assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原後 repo 還是壞的——多值沒有整組清掉。');
  });
});

test('⭐ 多值 key：同檔 banana＋false 兩筆 core.bare，一道指令要能修好（r4 Medium）', () => {
  withSandbox(({ repo, sharedConfig }) => {
    sgit(['config', '--file', sharedConfig, 'core.bare', 'banana']);
    sgit(['config', '--file', sharedConfig, '--add', 'core.bare', 'false']);
    const probs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-bare-invalid');
    assert.ok(p, `同檔多值裡的 banana 沒被指名（回報：${JSON.stringify(ids(probs))}）`);
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0,
      `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}\n`
      + '——單值形式的 set 對多值 key 會 exit 5（r4 Medium 的實測），要用 --replace-all。');
    assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原後 repo 還是壞的——多值沒有整組收斂。');
  });
});

test('⭐ 壞布林住在低順位（全域檔），高順位是合法值：承載檔要指到真兇（r4 Medium）', () => {
  withSandbox(({ dir, repo, sharedConfig }) => {
    const fakeHome = join(dir, 'home2');
    mkdirSync(fakeHome);
    writeFileSync(join(fakeHome, '.gitconfig'), '[core]\n\tbare = banana\n');
    sgit(['config', '--file', sharedConfig, 'core.bare', 'false']);   // 高順位合法值
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = fakeHome;
    process.env.XDG_CONFIG_HOME = join(fakeHome, 'xdg');
    try {
      const probs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
      const p = probs.find((x) => x.id === 'core-bare-invalid');
      assert.ok(p,
        `全域檔的 banana 沒被指名（回報：${JSON.stringify(ids(probs))}）`
        + '——贏家合法不代表沒事：git 開 repo 時每一筆都會吃。');
      assert.ok(p.message.includes(fakeHome),
        `承載檔指錯了（訊息：\n${p.message}）——壞值在全域檔，改 repo 的檔白改（r4 Medium 的原始重現）。`);
      const r = runRepairFromMessage(p.message);
      assert.equal(r.status, 0, `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
      assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
        '還原後 repo 還是壞的。');
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
      if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    }
  });
});

test('⭐ 承載檔路徑含 tab：-z 解析不吃 C-quote，還原照樣可跑（r4 Low）', () => {
  withSandbox(({ dir, wt, sharedConfig }) => {
    const inc = join(dir, 'with\ttab.cfg');
    writeFileSync(inc, '[core]\n\tbare = true\n');
    // 用 git 自己寫 include.path（它會照規矩把 tab 引號化）——手寫原字 git 會讀不到。
    sgit(['config', '--file', sharedConfig, 'include.path', inc]);
    sgit(['-C', wt, 'config', '--worktree', 'core.bare', 'false']);
    const probs = worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-bare-shared');
    assert.ok(p, `tab 路徑的 include 病灶沒被抓（回報：${JSON.stringify(ids(probs))}）`);
    assert.ok(!p.message.includes('\\t') && !p.message.includes('"'),
      `訊息裡的路徑帶著 C-quote 殘渣（訊息：\n${p.message}）——沒走 -z 解析、把引號當路徑。`);
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0, `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
    assert.deepEqual(ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原後病灶仍在。');
  });
});

test('⭐ 壞布林值（core.bare=banana）：要指名病灶與承載檔，不可以只退成 not-a-repo（r3 Medium③）', () => {
  // 直接寫壞：repo 自己就打不開了，但成因要說得出來、還原要跑得動。
  withSandbox(({ repo }) => {
    sgit(['config', '--file', join(repo, '.git', 'config'), 'core.bare', 'banana']);
    const probs = worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS });
    const seen = ids(probs);
    assert.ok(seen.includes('core-bare-invalid'),
      `core.bare=banana 只回報了 ${JSON.stringify(seen)}——成因被泛用錯誤蓋掉，`
      + '看訊息的人拿不到病灶與還原法（r3 Medium③）。');
    const p = probs.find((x) => x.id === 'core-bare-invalid');
    assert.ok(p);
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0, `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
    assert.deepEqual(ids(worktreeIntegrityProblems(repo, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原後 repo 還是壞的。');
  });
  // 掩蔽版：這棵樹覆寫 false（自己好好的），共用檔的值是 banana——照樣要指名。
  withSandbox(({ wt, sharedConfig }) => {
    sgit(['-C', wt, 'config', '--worktree', 'core.bare', 'false']);
    sgit(['config', '--file', sharedConfig, 'core.bare', 'banana']);
    const probs = worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-bare-invalid');
    assert.ok(p,
      `共用檔 core.bare=banana 被本樹覆寫掩住，體檢回報 ${JSON.stringify(ids(probs))}`
      + '——其他沒覆寫的樹此刻已經打不開了。');
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0, `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
    assert.deepEqual(ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原後這棵樹視角仍有問題。');
  });
  // 病灶住在樹自己的 config.worktree（①b 只看共用層、蓋不到這裡）：還原要指到 config.worktree。
  withSandbox(({ wt, wtGitDir }) => {
    sgit(['config', '--file', join(wtGitDir, 'config.worktree'), 'core.bare', 'banana']);
    const probs = worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS });
    const p = probs.find((x) => x.id === 'core-bare-invalid');
    assert.ok(p,
      `config.worktree 裡的 core.bare=banana 沒被指名（回報：${JSON.stringify(ids(probs))}）`
      + '——這棵樹打不開，成因卻被泛用錯誤蓋掉。');
    assert.ok(p.message.includes('config.worktree'),
      `訊息沒指出值住在 config.worktree（訊息：\n${p.message}）——改共用檔修不到它。`);
    const r = runRepairFromMessage(p.message);
    assert.equal(r.status, 0, `還原指令跑不動（${r.status}）：${r.err}\n指令＝${r.cmd}`);
    assert.deepEqual(ids(worktreeIntegrityProblems(wt, { requiredTracked: SANDBOX_ANCHORS })), [],
      '還原後這棵樹還是壞的。');
  });
});

test('⭐ 體檢不可以量到別棵樹：傳子目錄進去要被擋下來', () => {
  withSandbox(({ repo }) => {
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    const seen = ids(worktreeIntegrityProblems(sub, { requiredTracked: SANDBOX_ANCHORS }));
    assert.ok(seen.includes('wrong-tree'),
      `傳子目錄進去卻回報一切正常（${JSON.stringify(seen)}）⇒ 體檢無法保證它量的是你指的那一棵，`
      + '而「量了別棵健康的樹然後回報正常」正是這支要防的假綠。');
  });
});

test('⭐ 根本不是 repo 的目錄：要說「不認得」，不可以回「沒問題」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
  try {
    const seen = ids(worktreeIntegrityProblems(dir, { requiredTracked: SANDBOX_ANCHORS }));
    assert.deepEqual(seen, ['not-a-repo'],
      `對一個不是 repo 的目錄回報 ${JSON.stringify(seen)}——「查不到」不等於「安全」。`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ 體檢本身不可以被 GIT_* 牽著走（行為題，不是掃它有沒有寫清環境那一行）', () => {
  withSandbox(({ repo }) => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(repo, '.git');   // 假裝我們是在 hook 的環境裡跑
    // ⚠️ **這一題是代理指標，射程有限**：注入的 `GIT_DIR` 是實測唯一「四種呼叫形狀通吃」的變數
    //    （對照表在 test/helpers/dirty-git-env.js 檔頭），它證明的是真實情境下結論沒被帶偏。
    //    ⚠️ 它**擋不住**「把清法退化成只刪 GIT_DIR 的列名版」——那一族由題名關鍵字
    //    「體檢交給 git 的環境裡不可以有任何 GIT_*」那題（直接讀子行程收到什麼）守。
    const restoreDirty = injectDirtyGitEnv();
    try {
      assert.deepEqual(worktreeIntegrityProblems(ROOT), [],
        '環境裡有 GIT_* 時，體檢就量到別棵樹了 ⇒ 從 worktree push 時（hook 環境本來就有 GIT_DIR）'
        + '這支會靜靜量錯對象。');
    } finally {
      restoreDirty();
      if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    }
  });
});

test('⭐ 體檢交給 git 的環境裡不可以有任何 GIT_*（直接斷言，不靠代理指標）', () => {
  // ⚠️ 題名關鍵字「體檢本身不可以被 GIT_* 牽著走」那題是**代理指標**：它問「體檢的結論對不對」，
  //    只涵蓋「剛好會改變那些指令的變數」。實測 `rev-parse --show-toplevel` 這一族
  //    **只有 `GIT_DIR` 有影響力**（對照表在 test/helpers/dirty-git-env.js 檔頭），
  //    所以光靠它，把清法退化成「只刪 GIT_DIR」的列名版仍會全綠。
  //    這一題直接問子行程收到什麼，未來的新家族也涵蓋得到。
  assertChildGitEnvClean(assert, '體檢的 runGit()', () => worktreeIntegrityProblems(ROOT));
});

/**
 * 造一組假的 node／npm 放進 PATH 給 pre-push 用：每次被叫到都把
 * 「名字＋參數＋當下還看得到哪些 GIT_*」記進 log，然後成功退出。
 * `checkFailsAt`（1-based）：node 跑到體檢腳本的第 N 次呼叫**起**改成失敗——
 * 給 fail-closed 兩題用；不給＝永遠成功。
 *
 * @param {string} dir
 * @param {{ checkFailsAt?: number }} [opts]
 * @returns {{ bin: string, log: string }}
 */
function makeHookStubs(dir, opts = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const count = join(dir, 'check-count');
  const failsAt = opts.checkFailsAt ?? 0;
  for (const name of ['node', 'npm']) {
    const stub = join(bin, name);
    writeFileSync(stub,
      '#!/bin/sh\n'
      + `{ printf '%s %s :: ' "${name}" "$*"; env | grep '^GIT_' | cut -d= -f1 | tr '\\n' ' '; printf ':: gh=%s' "\${GITHUB_TOKEN:-MISSING}"; echo; } >> ${JSON.stringify(log)}\n`
      + (name === 'node'
        ? 'case "$*" in *check-worktree-integrity*)\n'
          + `  n=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > ${JSON.stringify(count)}\n`
          + `  if [ ${failsAt} -gt 0 ] && [ "$n" -ge ${failsAt} ]; then echo "體檢炸了（stub 第 $n 次）" >&2; exit 1; fi\n`
          + 'esac\n'
        : '')
      + 'exit 0\n');
    chmodSync(stub, 0o755);
  }
  return { bin, log };
}

/** 跑正式的 pre-push（用 stub 的 PATH），把注入的髒 GIT_* 一起帶進去。 @param {string} bin */
function runPrePush(bin) {
  /** @type {Record<string,string>} */
  const polluted = { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '' };
  // 注入「列過名的＋沒列過名的」兩種。後者是 #435 r1 High② 的洞：
  // GIT_CONFIG_* 一族是 `git -c` 生出來、會長的；只清名單它們就漏網。
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
    polluted[key] = '/fake/path/.git/worktrees/x';
  }
  polluted.GIT_CONFIG_PARAMETERS = "'user.name=fixture'";
  polluted.GIT_CONFIG_COUNT = '1';
  polluted.GIT_CONFIG_KEY_0 = 'user.name';
  polluted.GIT_CONFIG_VALUE_0 = 'fixture';
  polluted.GIT_BOGUS_FUTURE_THING = 'unlisted';
  // 哨兵：非 GIT_ 前綴（第四字元是 H），**必須活著穿過正式 hook**——前綴規則寫鬆
  // （GIT 而非 GIT_）就會殺掉它，CI 的 GITHUB_* 會遭殃（r2 Low④：hook 那一行 sh 是
  // **另一份實作**，`lib/git-env.js` 的考題守不到它，所以這個哨兵要在這裡再釘一次）。
  polluted.GITHUB_TOKEN = 'keep-me';
  return spawnSync('sh', [join(ROOT, 'scripts', 'git-hooks', 'pre-push')],
    { encoding: 'utf8', cwd: ROOT, env: polluted });
}

/** @param {string} log */
const callNames = (log) => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  .map((line) => line.split('::')[0].trim());

test('⭐ 真的跑一次 pre-push：GIT_*（含沒列過名的）必須清光，考試前後各驗一次工作樹', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepush-'));
  try {
    const { bin, log } = makeHookStubs(dir);
    const r = runPrePush(bin);
    assert.equal(r.status, 0, `pre-push 在全部關卡都成功的情況下退出碼是 ${r.status}：\n${r.stdout}${r.stderr}`);

    assert.deepEqual(callNames(log), [
      'node scripts/check-worktree-integrity.js',
      'npm run typecheck',
      'npm run lint',
      'npm test',
      'node scripts/check-worktree-integrity.js',
    ], 'pre-push 的關卡順序不對。⚠️ **考試之後那一次體檢是關鍵**：'
      + '考題各跑各的子行程，「哪一支考題把 repo 弄壞」只有在跑完之後量才看得到。');

    for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
      const parts = line.split('::');
      const leaked = (parts[1] ?? '').trim();
      assert.equal(leaked, '',
        `pre-push 的子行程還看得到 GIT_* 環境變數：${leaked}\n`
        + '⇒ 從連結工作樹 push 時，整套考題會在「有 GIT_DIR」的環境下跑。那個環境裡\n'
        + '   ① 任何一句 git init 都會把共用 .git/config 寫成 bare=true（2026-08-09 事故的機制），\n'
        + '   ② git -C／execFileSync 的 cwd 會被蓋掉，宣稱掃這棵樹的考題其實掃別棵。\n'
        + '（有列名沒列名都不可以漏——名單清不完，這扇門是前綴制。）');
      assert.equal((parts[2] ?? '').trim(), 'gh=keep-me',
        `GITHUB_TOKEN 哨兵沒有活著到達子行程（${line}）\n`
        + '⇒ 正式 hook 的前綴規則殺過頭了——CI 的 GITHUB_* 會被誤殺（r2 Low④）。');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ fail-closed①：考試「之後」那次體檢失敗，push 必須被擋（那一行不是裝飾）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepush-post-'));
  try {
    // 第一次體檢過、三關全過、**第二次體檢炸**——正是「考試把樹弄壞了」的劇本。
    const { bin, log } = makeHookStubs(dir, { checkFailsAt: 2 });
    const r = runPrePush(bin);
    assert.notEqual(r.status, 0,
      '第二次體檢已經失敗，pre-push 卻放行了 push——fail-closed 一行退化成裝飾，'
      + '考題還全綠，正是 #435 r1 Medium⑤ 用突變示範的洞。');
    assert.deepEqual(callNames(log), [
      'node scripts/check-worktree-integrity.js',
      'npm run typecheck',
      'npm run lint',
      'npm test',
      'node scripts/check-worktree-integrity.js',
    ], '擋下的位置不對：應該是五關都跑了、倒在最後那一次體檢。');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ fail-closed②：考試「之前」那次體檢失敗＝立刻擋下，三關一關都不准跑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepush-pre-'));
  try {
    const { bin, log } = makeHookStubs(dir, { checkFailsAt: 1 });
    const r = runPrePush(bin);
    assert.notEqual(r.status, 0, 'push 之前就已經壞了還放行——這道門白裝了。');
    assert.deepEqual(callNames(log), ['node scripts/check-worktree-integrity.js'],
      '體檢已經報壞，後面的關卡卻還在跑——壞掉的樹上跑出來的三關結果本身不可信。');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
