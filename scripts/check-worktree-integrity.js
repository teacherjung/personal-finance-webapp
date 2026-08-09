#!/usr/bin/env node
// @ts-check
// 「整個 repo 靜靜失去工作樹身分」的體檢（2026-08-09 事故）。
//
// ## 那天發生什麼
//
// 01:28，主目錄的 `.git/config` 被寫進 `bare = true`。壞掉的不是一棵樹，是**主目錄與當時
// 42 棵連結工作樹一起**：`git status`／`add`／`commit`／`rev-parse --show-toplevel` 全部回
// `fatal: this operation must be run in a work tree`，`git worktree list` 把主目錄標成 `(bare)`。
//
// 為什麼會一起中：`core.bare` 存在**共用的** `.git/config`。這個 repo 的
// `extensions.worktreeConfig` 是開著的，但當時只有 3 棵樹有自己的 `config.worktree`，
// 而那 3 份**都沒有覆寫 `core.bare`** ⇒ 43 棵樹全部讀同一個值。
//
// ## 怎麼會被寫進去（沙盒實測，2026-08-09；肇因見下面的誠實劃界）
//
// `git init` 只要在**環境變數 `GIT_DIR` 指向某棵連結工作樹的 gitdir**（`.git/worktrees/<名>`）
// 之下執行，就會把 `bare = true` 寫進**共用** config——就算你已經好好把 `cwd` 指到
// `/var/folders/...` 的暫存目錄也一樣，因為有 `GIT_DIR` 時 git 根本不看 cwd。
// 原因是 git 猜「這是不是 bare repo」時只看 `GIT_DIR` 的**路徑長相**：結尾是 `.git` 就猜「不是」，
// 其餘一律猜「是」，而 `.git/worktrees/<名>` 的結尾不是 `.git`。實測三種情形：
//
//   ・沒有 `GIT_DIR`                      → 安全（在暫存目錄開新 repo，跟主 repo 無關）
//   ・`GIT_DIR=<主目錄>/.git`             → 安全（結尾是 `.git`，猜「不是 bare」）
//   ・`GIT_DIR=<主目錄>/.git/worktrees/X` → ☠️ 共用 `.git/config` 當場變成 `bare = true`
//
// 而 `GIT_DIR` 不需要有人手動設：**git 自己會放進 hook 的環境**。實測從連結工作樹
// push／commit 時，`pre-push`／`pre-commit` 都拿得到 `GIT_DIR=<主目錄>/.git/worktrees/<名>`
// （從主目錄操作時則沒有）。本專案的 `pre-push` 會跑 `npm test` ⇒ **從任何一棵 worktree push，
// 整套考題都是在那個環境下跑的**。同一個 `GIT_DIR` 還有第二個副作用：它會蓋掉
// `git -C <路徑>` 與 `execFileSync(..., { cwd })`，讓「掃這棵樹」的考題其實掃到別棵。
//
// ⚠️ **誠實劃界①：肇因沒有查明，上面是「重現得出來的機制」，不是「那天就是這樣發生的」。**
//    2026-08-09 查過全樹與 PR #433 的 11 個 commit，**沒有任何一處 `git init`**；當時同時有
//    多方在跑（考題、Codex 審查行程、可能的並行 session），現場沒留下足以指認的痕跡。
//    所以這支只做兩件做得到的事：**把壞掉的狀態驗出來**，以及讓 `pre-push` 把 `GIT_DIR`
//    清掉、不再把那個前提條件交給考題。
//
// ⚠️ **誠實劃界②：這是絆線，不是預防。** 考題檔案彼此獨立、`node --test` 的檔案順序不保證，
//    所以「某支考題把 repo 弄壞」這件事，本檔**不保證在同一次執行裡當場抓到**——真正釘住它的是
//    `scripts/git-hooks/pre-push`：那裡在 `npm test` **之後**再跑一次本檔，考試把樹弄壞就推不出去。
//
// ⚠️ **誠實劃界③：本檔只驗「你指給它的那一棵樹」。** 不逐一走訪 43 棵——因為壞掉的
//    `core.bare` 住在共用 config，從任何一棵樹看都是同一個值，驗一棵就夠。
//    反過來說，**單一 worktree 自己的 `config.worktree` 被寫壞**，只有在那棵樹裡跑才驗得到。
//
// 用法：node scripts/check-worktree-integrity.js
// 退出碼：0＝這棵樹的工作樹身分正常；1＝有問題（訊息裡附還原指令）

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main.js';

/**
 * 會讓 git「不看你給的路徑、改看環境變數」的變數名。
 *
 * ⚠️ 具名匯出是給考題與 hook 用的**單一真相**：`test/worktree-integrity.test.js` 拿這份清單
 *    逐字檢查 `pre-push` 有沒有把它們全部 `unset`。手寫兩份的話，哪天多一個變數只會漏在其中一邊。
 */
export const GIT_DISCOVERY_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
];

/**
 * 把上面那些變數從一份環境裡拿掉。
 *
 * ⚠️ 這不是潔癖：**體檢本身若在 `GIT_DIR` 之下跑，量到的就不是你指的那棵樹**
 *    （從 worktree push 時 hook 的環境正是如此），那會變成「靜靜量了別棵樹、回報一切正常」。
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanGitEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = { ...env };
  for (const key of GIT_DISCOVERY_ENV) delete out[key];
  return out;
}

/**
 * 這個 repo 一定在版控裡的檔案——拿來驗「索引還在、`git ls-files` 沒有靜靜掃到零檔案」。
 * ⚠️ 刻意用**具體檔名**而不是「檔案數 > N」：寫死的數字自己會漂，檔名不會。
 */
export const REQUIRED_TRACKED = ['package.json', 'AGENTS.md', 'server.js'];

/**
 * 跑一次 git。**跑不起來要大聲炸**——吞掉例外就會回「沒問題」，那正是這支要防的病。
 *
 * @param {string} repoDir
 * @param {string[]} args
 * @returns {{ status: number, out: string, err: string }}
 */
function git(repoDir, args) {
  return runGit(['-C', repoDir, ...args], repoDir);
}

/**
 * 在 repo **外面**跑 git。給 `config --file` 用：config 壞到讓 git 打不開 repo 時
 * （`core.worktree` 亂指就是這樣），只要 cwd 還在 repo 裡，連 `git config --file` 都會一起 fatal
 * ——實測過，不是理論。要診斷成因，就得站在 repo 外面問。
 *
 * @param {string[]} args
 * @returns {{ status: number, out: string, err: string }}
 */
function gitOutsideRepo(args) {
  return runGit(args, tmpdir());
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number, out: string, err: string }}
 */
function runGit(args, cwd) {
  const r = spawnSync('git', args, { encoding: 'utf8', cwd, env: cleanGitEnv(process.env) });
  if (r.error) throw r.error;
  if (typeof r.status !== 'number') {
    throw new Error(`git ${args.join(' ')} 沒有正常結束（signal=${r.signal}）——體檢無法下判斷。`);
  }
  return { status: r.status, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

/**
 * 找出這棵樹的**共用** config 檔（`.git` 可能是目錄，也可能是連結工作樹的那一行指標檔）。
 * 純檔案操作，不經過 git ⇒ repo 已經壞掉時照樣讀得到。
 *
 * @param {string} repoDir
 * @returns {string | null} 讀不出來就回 null（讓呼叫端維持「查不到就不宣稱」）
 */
function sharedConfigPath(repoDir) {
  const dotGit = join(repoDir, '.git');
  if (!existsSync(dotGit)) return null;
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    gitDir = resolve(repoDir, m[1]);
  }
  const commondirFile = join(gitDir, 'commondir');
  const commonDir = existsSync(commondirFile)
    ? resolve(gitDir, readFileSync(commondirFile, 'utf8').trim())
    : gitDir;
  const cfg = join(commonDir, 'config');
  return existsSync(cfg) ? cfg : null;
}

/**
 * 讀一個 config 值。先照正規路子問 git；**問不出來時退一步直接讀 config 檔**。
 *
 * ⚠️ 為什麼要有這條退路：`git config --get` 讀不到有兩種完全不同的意思——**沒設定**（正常），
 *    或者 **config 已經壞到 git 連這個 repo 都打不開**（`core.worktree` 亂指就是這樣；實測連
 *    `git config --file` 都會一起 fatal，只要 cwd 還在 repo 裡面）。後者正是要診斷的那一種，
 *    而光看退出碼兩者長得一模一樣 ⇒ 成因會被自己的後果蓋掉。
 *
 * @param {string} repoDir
 * @param {string} key
 * @returns {{ status: number, out: string, err: string }}
 */
function configValue(repoDir, key) {
  const direct = git(repoDir, ['config', '--get', key]);
  if (direct.status === 0) return direct;
  const cfg = sharedConfigPath(repoDir);
  return cfg ? gitOutsideRepo(['config', '--file', cfg, '--get', key]) : direct;
}

/**
 * 驗一棵工作樹還是不是工作樹。
 *
 * @param {string} repoDir 要驗的**工作樹根目錄**（不是子目錄）
 * @param {{ requiredTracked?: string[] }} [opts] `requiredTracked`：驗索引用的錨點檔（沙盒考題會換掉）
 * @returns {{ id: string, message: string }[]} 空陣列＝正常；每一項的 `id` 是給考題斷言用的機器欄位
 */
export function worktreeIntegrityProblems(repoDir, opts = {}) {
  const anchors = opts.requiredTracked ?? REQUIRED_TRACKED;
  /** @type {{ id: string, message: string }[]} */
  const problems = [];

  // ⚠️ **先問 config、後問 rev-parse**：`git config` 不需要工作樹就讀得到，而 rev-parse 這一族
  //    在 config 被寫壞時會整個 fatal。順序反過來的話，「core.worktree 亂指」只會得到一句
  //    「這裡不是 repo」——**成因被自己的後果蓋掉**，看訊息的人會去查錯的方向。
  //
  // ① 事故本體。它住在**共用** config ⇒ 一中就是所有的樹一起中。
  const bare = configValue(repoDir, 'core.bare');
  if (bare.status === 0 && bare.out === 'true') {
    problems.push({
      id: 'core-bare',
      message:
        'core.bare = true。這個值住在共用的 .git/config，主目錄與所有連結工作樹讀的是同一份'
        + '（除非那棵樹的 config.worktree 自己覆寫了，2026-08-09 當下沒有任何一棵有）。\n'
        + `  還原：git -C ${JSON.stringify(repoDir)} config core.bare false\n`
        + '  ⚠️ 還原之前先看一眼是誰寫的：檔頭記著唯一重現得出來的機制'
        + '（GIT_DIR 指向 .git/worktrees/<名> 時跑 git init）。',
    });
  }

  // ② 同族的靜靜壞法：core.worktree 指到不存在的地方 ⇒ 每個 git 指令都變成
  //    `fatal: Invalid path '<那個路徑>'`（實測：主目錄與連結工作樹一起中）。
  const cw = configValue(repoDir, 'core.worktree');
  if (cw.status === 0 && cw.out && !existsSync(cw.out)) {
    problems.push({
      id: 'core-worktree-missing',
      message:
        `core.worktree 指到不存在的路徑：${cw.out}\n`
        + '  ⇒ 這棵樹（以及所有讀同一份 config 的樹）每個 git 指令都會回 fatal: Invalid path。\n'
        + `  還原：git -C ${JSON.stringify(repoDir)} config --unset core.worktree`,
    });
  }

  // ③ 工作樹身分還在嗎。
  const inside = git(repoDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0) {
    problems.push({
      id: 'not-a-repo',
      message:
        `git 沒辦法把 ${repoDir} 當成 repo 讀：\n  ${inside.err}\n`
        + '  （可能根本不是 repo，也可能是上面那幾項把 config 寫壞了——先看有沒有其他項。）',
    });
    return problems;   // 後面每一項都要靠 git 讀得進這棵樹，再問下去只會得到一堆同因的雜訊
  }
  if (inside.out !== 'true') {
    problems.push({
      id: 'not-a-work-tree',
      message:
        `${repoDir} 已經不是工作樹了（git rev-parse --is-inside-work-tree = ${inside.out || '<空>'}）。\n`
        + '  ⇒ git status／add／commit 會一律回 fatal: this operation must be run in a work tree。',
    });
  }

  // ④ 「我量到的是不是你指的那棵樹」——GIT_DIR 洩漏、傳錯目錄，都會在這裡現形。
  //    ⚠️ 這一條是本檔自己的防假綠：沒有它，體檢可能一路量了別棵健康的樹然後回報正常。
  const top = git(repoDir, ['rev-parse', '--show-toplevel']);
  if (top.status === 0 && top.out) {
    const measured = realpathSync(top.out);
    const asked = realpathSync(repoDir);
    if (measured !== asked) {
      problems.push({
        id: 'wrong-tree',
        message:
          '體檢量到的不是你指的那棵樹：\n'
          + `  你指的     = ${asked}\n`
          + `  git 回答的 = ${measured}\n`
          + '  ⇒ 這份報告對「你指的那棵樹」沒有效力。'
          + '（常見成因：GIT_DIR 環境變數蓋掉了 -C／cwd，或傳進來的是子目錄不是根。）',
      });
    }
  }

  // ⑤ 索引不見了。⚠️ 這一種**不會報錯**：`git ls-files` 會安安靜靜回傳空清單，
  //    於是所有「走 git ls-files 掃全樹」的考題都掃到零個檔案、回報「零違規」。
  //    （實測：`git status` 這時會把每一支受版控的檔案報成 D＋??，但考題不看 status。）
  for (const anchor of anchors) {
    const listed = git(repoDir, ['ls-files', '--error-unmatch', '--', anchor]);
    if (listed.status !== 0) {
      problems.push({
        id: 'index-unusable',
        message:
          `git ls-files 找不到一定在版控裡的 ${anchor}（${listed.err || '沒有錯誤訊息'}）。\n`
          + '  ⇒ 索引（.git/index）多半沒了或壞了。這一種不會噴錯：以 git ls-files 掃全樹的考題'
          + '會掃到零個檔案，然後回報「零違規」。\n'
          + `  還原：git -C ${JSON.stringify(repoDir)} read-tree HEAD（或 git reset 重建索引）`,
      });
      break;   // 同一個成因，列一次就夠
    }
  }

  return problems;
}

/** 這支腳本自己所在的那棵 checkout（⚠️ 路徑含空白與中文，一定要走 fileURLToPath，不能取 .pathname）。 */
export const SCRIPT_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (isMainModule(import.meta.url)) {
  const problems = worktreeIntegrityProblems(SCRIPT_REPO_ROOT);
  if (problems.length === 0) {
    console.log(`✅ 工作樹身分正常：${realpathSync(SCRIPT_REPO_ROOT)}`);
  } else {
    console.error(`⛔ 工作樹體檢不過（${problems.length} 項）：${realpathSync(SCRIPT_REPO_ROOT)}`);
    for (const p of problems) console.error(`\n[${p.id}] ${p.message}`);
    process.exitCode = 1;
  }
}
