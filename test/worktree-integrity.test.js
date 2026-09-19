// 「整個 repo 靜靜失去工作樹身分」那次事故（2026-08-09）留下的考題。
//
// 事故當天 `.git/config` 被寫進 `bare = true`，主目錄與 42 棵連結工作樹**同時**失效
// （`git status`／`add`／`commit` 全回 `fatal: this operation must be run in a work tree`）。
// 病因分析與實測結果寫在 `docs/bare-repo-incident.md`，這裡不重抄一份（抄兩份就會漂）。本檔兩組題：
//   ① 題名含「事故的原地重現」那一題：在沙盒裡真的用那把兇器（帶 GIT_DIR 跑 git init）重現一次，
//      證明這個機制在目前這版 git 上仍然成立（`docs/bare-repo-incident.md` 指著它）；
//   ② 檔尾實跑推送前鉤子 `scripts/git-hooks/pre-push` 的兩題（`GIT_*` 清光、只叫三關執行器、非零就擋）。
// 本檔原本另有一大組題，考本專案自己那支工作樹體檢腳本；那支 2026-09-20 照 William 裁 a 拿掉
// （https://github.com/teacherjung/personal-finance-webapp/pull/622#issuecomment-5743466843 ），那組題跟著刪。
// 三關前後的工作樹檢查現在只剩套件執行器 `tools/run-checks.js` 那一道，考它的題在套件的 `tests/run-checks.test.js`。
//
// ⚠️ 本檔的寫法＝**行為題**：造一棵真的會壞的沙盒 repo、實跑 hook——因為「考題只掃原始碼字樣，
//    實作換掉了照樣全綠」是本專案認過的病型（#433 r6 被複驗者示範過）。
//    GIT_* 清理用「實跑 hook＋注入**沒列過名**的變數」驗，不比對名單
//    （名單比對＝拿實作自己的清單驗實作＝循環自證；#435 r1 High②）。
//
// ⚠️ **沙盒的安全宣告**：下面有兩處真的會跑 `git init`（那正是事故的兇器）。它們一律：
//    ① 只在 `mkdtempSync` 的暫存目錄裡跑；
//    ② `env` 是**從零組**的（只給 PATH／HOME），不是「process.env 減掉幾個 key」
//       ——所以不可能有任何 GIT_* 洩進去；
//    ③ 事故重現那一題跑之前與跑完各問一次**真的 repo** 是不是健康的
//       （跑之前就不健康＝不是這一題弄的；跑完才壞＝這一題的沙盒漏了）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { treeState } from '../tools/run-checks.js';

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

/**
 * 從主目錄與連結工作樹各問一次 git「這是不是裸倉庫」（沙盒專用：走 sgit 那份從零組的環境）。
 * @param {string} repo @param {string} wt
 */
const bareSeenFrom = (repo, wt) => ({
  repo: sgit(['-C', repo, 'rev-parse', '--is-bare-repository']).out,
  wt: sgit(['-C', wt, 'rev-parse', '--is-bare-repository']).out,
});

/**
 * 真的 repo 的保險絲（事故重現那一題跑之前、跑完各問一次）：回 null＝健康，否則回一句說哪裡不對。問兩件事：
 * ① 套件執行器的 `treeState`（它自己清掉 GIT_ 那一族）：這棵樹還是不是工作樹、根目錄是不是這裡、索引在不在。
 *    這裡不帶本專案的登記（主目錄布局、索引錨點），也不比設定指紋——推送前的三關執行器另外會做那兩件；
 *    這裡只要它看這棵樹的生效值，所以被這棵樹自己的覆寫藏起來的共用層它看不到，要靠 ②。
 * ② 直接問 git「倉庫共用的那一份設定裡的 core.bare」（`--local`＝只讀共用的 config，從連結工作樹問也一樣；
 *    走 sgit 那份從零組的環境）：某棵樹自己的 config.worktree 覆寫了 core.bare 時，從那棵樹看生效值照樣健康、
 *    ①看不出來，別的樹（含主目錄）卻全部打不開（docs/bare-repo-incident.md「故障還會藏起來」那段）。
 *    `--bool` 讓 git 自己把 yes／on／1 換成 true；退 1 而且沒有輸出＝一筆都沒有；其他非零＝git 讀不了（例如值不是布林）。
 * @returns {string | null}
 */
function realRepoProblem() {
  const st = treeState(null, ROOT);
  if (st.state !== 'ok') return `套件執行器的 treeState 回 ${JSON.stringify(st)}`;
  const bare = sgit(['-C', ROOT, 'config', '--local', '--bool', '--get-all', 'core.bare'], { allowFail: true });
  if (bare.status === 1 && bare.out === '') return null;
  if (bare.status !== 0) return `git 讀不了共用設定的 core.bare（退 ${bare.status}）：${bare.err}`;
  const values = bare.out.split('\n');
  return values.includes('true') ? `共用設定的 core.bare 有一筆是 true（git 讀到：${values.join('、')}）` : null;
}

test('⭐ 事故的原地重現：GIT_DIR 指向連結工作樹時跑 git init，共用 config 當場變 bare', () => {
  const before = realRepoProblem();
  assert.equal(before, null,
    `跑這一題之前，真的 repo 就已經不健康了（不是這一題弄的）：${before}\n`
    + '（先還原，再照 docs/bare-repo-incident.md 查是誰寫的。）');

  let sandboxError = null;
  try {
    withSandbox(({ repo, wt, wtGitDir, sharedConfig }) => {
      const tmp = mkdtempSync(join(tmpdir(), 'innocent-cwd-'));
      try {
        assert.deepEqual(bareSeenFrom(repo, wt), { repo: 'false', wt: 'false' },
          '沙盒剛造好，git 就說它是裸倉庫了＝這一題後面驗的東西沒有意義');

        // 這就是那把兇器：cwd 明明指在一個完全無關的暫存目錄，但有 GIT_DIR 時 git 不看 cwd。
        sgit(['init', '-q'], { cwd: tmp, env: { GIT_DIR: wtGitDir } });

        assert.match(readFileSync(sharedConfig, 'utf8'), /^\s*bare\s*=\s*true$/m,
          '共用 .git/config 沒有變成 bare=true ⇒ 這一題已經不是在重現 2026-08-09 的事故了。\n'
          + '（git 版本換了？先確認機制還在，再決定要不要改題目——不要直接刪。）');
        // 直接問 git（不靠任何體檢）：主目錄與連結工作樹一起失去工作樹身分＝事故當天 43 棵一起中的樣子
        assert.deepEqual(bareSeenFrom(repo, wt), { repo: 'true', wt: 'true' },
          '共用設定寫進 bare=true 之後，git 從主目錄或連結工作樹看卻不是裸倉庫'
          + '⇒ 這版 git 讀共用設定的方式變了，docs/bare-repo-incident.md「為什麼會一起中」那段要重看。');

        // 還原：損害就只是共用設定那一格——把它改回 false，兩棵樹都要活回來
        sgit(['config', '--file', sharedConfig, '--replace-all', 'core.bare', 'false'], { cwd: tmp });
        assert.deepEqual(bareSeenFrom(repo, wt), { repo: 'false', wt: 'false' },
          '共用設定的 core.bare 改回 false 了，沙盒卻沒活回來＝兇器弄壞的不只那一格，'
          + 'docs/bare-repo-incident.md 的機制描述要重看。');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  } catch (e) {
    sandboxError = e;
  }

  // ⚠️ 上面真的跑了 git init。回頭確認它沒有波及本尊——這一段就是本檔自己的保險絲。
  //   不管沙盒那一段有沒有中途丟錯都要跑（沙盒一進場就 git init：環境被改壞時，錯可能先從沙盒丟出來，
  //   但真的 repo 已經中了——那時要看到的是這一句，不是沙盒的錯）。
  const after = realRepoProblem();
  assert.equal(after, null,
    `⛔ 這一題的 fixture 把**真的 repo** 弄壞了（${after}）。立刻檢查 SANDBOX_ENV 是不是被改成會帶 GIT_* 進去。`
    + (sandboxError ? `\n（沙盒那一段也丟了錯：${sandboxError.message}）` : ''));
  if (sandboxError) throw sandboxError;
});

/**
 * 造一組假的 node／npm 放進 PATH 給 pre-push 用：每次被叫到都把
 * 「名字＋參數＋當下還看得到哪些 GIT_*」記進 log，然後成功退出。
 * `runChecksExit`：node 跑到套件三關執行器 tools/run-checks.js 時改成退這個碼（1＝有一關紅或跑完樹壞了、
 * 2＝起不來／沒登記／三關前就壞了）；不給＝退 0。搬家第 4 步起三關由它跑，鉤子只看它的退出碼。
 * ⚠️ 假 node 不管被叫去跑什麼都照樣記一筆、退 0——鉤子若多叫了任何東西（例如把 2026-09-20 拿掉的本專案那支工作樹體檢接回去），
 *    紀錄就多一行，題名關鍵字「真的跑一次 pre-push」那題的呼叫清單轉紅。
 *
 * @param {string} dir
 * @param {{ runChecksExit?: number }} [opts]
 * @returns {{ bin: string, log: string }}
 */
function makeHookStubs(dir, opts = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const runChecksExit = opts.runChecksExit ?? 0;
  for (const name of ['node', 'npm']) {
    const stub = join(bin, name);
    writeFileSync(stub,
      '#!/bin/sh\n'
      + `{ printf '%s %s :: ' "${name}" "$*"; env | grep '^GIT_' | cut -d= -f1 | tr '\\n' ' '; printf ':: gh=%s' "\${GITHUB_TOKEN:-MISSING}"; echo; } >> ${JSON.stringify(log)}\n`
      + (name === 'node'
        ? `case "$*" in *run-checks*) [ ${runChecksExit} -gt 0 ] && { echo "三關執行器（stub）退 ${runChecksExit}" >&2; exit ${runChecksExit}; }; esac\n`
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

test('⭐ 真的跑一次 pre-push：GIT_*（含沒列過名的）必須清光，清完只叫一次三關執行器', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepush-'));
  try {
    const { bin, log } = makeHookStubs(dir);
    const r = runPrePush(bin);
    assert.equal(r.status, 0, `pre-push 在全部關卡都成功的情況下退出碼是 ${r.status}：\n${r.stdout}${r.stderr}`);

    const calls = callNames(log);
    assert.ok(!calls.some((c) => c.includes('check-worktree-integrity')),
      `pre-push 又叫了本專案那支工作樹體檢：${JSON.stringify(calls)}\n`
      + '⇒ William 2026-09-20 裁 a 把它拿掉（先從鉤子拿掉、再刪腳本）、只留套件的三關執行器'
      + '（https://github.com/teacherjung/personal-finance-webapp/pull/622#issuecomment-5743466843 ）；要接回去先問他。');
    assert.deepEqual(calls, ['node tools/run-checks.js'],
      'pre-push 的呼叫不對：清完 GIT_* 之後只叫套件的三關執行器一次。三關前後的工作樹檢查在執行器裡'
      + '（考題各跑各的子行程、順序不保證，「哪一支考題把 repo 弄壞」只有跑完再驗才看得到；'
      + '執行器那一段由套件的 tests/run-checks.test.js 守）。');

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

test('⭐ fail-closed：三關執行器退 1（有一關紅或跑完樹壞了）或退 2（起不來／沒登記／三關前就壞了）都要擋（搬家第 4 步）', () => {
  // ⚠️ 退 2 是「查不清楚」不是「全過」：套件的執行器對「三關沒登記、不在工作樹裡、指令起不來」退 2；
  //    鉤子只看非零。這題釘的是「兩種非零都擋」——把鉤子那一行寫成只擋退 1，退 2 就會靜靜放行。
  for (const code of [1, 2]) {
    const dir = mkdtempSync(join(tmpdir(), `prepush-checks-${code}-`));
    try {
      const { bin, log } = makeHookStubs(dir, { runChecksExit: code });
      const r = runPrePush(bin);
      assert.notEqual(r.status, 0, `三關執行器退 ${code}，pre-push 卻放行了 push`);
      assert.deepEqual(callNames(log), ['node tools/run-checks.js'],
        `三關執行器退 ${code} 的這一趟，鉤子只該叫過它一次（前後都不該有別的關卡）`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
