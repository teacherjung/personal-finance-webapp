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
// ⚠️ **誠實劃界①（2026-08-10 更正）：肇因已有高度吻合的證據鏈，但沒有當場的行程目擊。**
//    本檔第一版這裡寫「查過 PR #433 的 11 個 commit，沒有任何一處 `git init`、已排除」——那是
//    **誤判**：程式裡寫的是 `git('init', '-q')` 輔助函式呼叫，拿字面「git init」去掃掃不到
//    （掃描器說謊的老病型）。#435 r1 提出、並經獨立重現的直接證據：
//      ・`4ab8e0b` 與 `0c0b176`（#433 過程 commit）的 test/test-path-decoding.test.js 各有一處
//        `git('init', '-q')`；兩顆 commit 時間 01:28:33／10:34:07，與兩次事故（01:28／10:34:27）
//        分秒貼合；#433 的 squash 訊息（`7c573f2`）亦記載那顆 fixture 曾污染主 repo。
//    所以「上面的機制」不只是重現得出來——它就是證據指向的肇因鏈（fixture 的 git init ×
//    hook 環境的 GIT_DIR）。本檔職責不變：把壞掉的狀態驗出來，並讓 `pre-push` 把 `GIT_*`
//    整族清掉、不再把那個前提條件交給考題。
//
// ⚠️ **誠實劃界②：這是絆線，不是預防。** 考題檔案彼此獨立、`node --test` 的檔案順序不保證，
//    所以「某支考題把 repo 弄壞」這件事，本檔**不保證在同一次執行裡當場抓到**——真正釘住它的是
//    `scripts/git-hooks/pre-push`：那裡在 `npm test` **之後**再跑一次本檔，考試把樹弄壞就推不出去。
//
// ⚠️ **誠實劃界③：本檔驗「你指給它的那一棵樹」＋共用 config 那一層的原始值。**
//    共用層（`core.bare`）**指名直讀檔案**、不吃 effective 值——不然某棵樹自己的
//    `config.worktree` 覆寫會把共用層的壞掩住（#435 r1 Medium③實測）。所以共用層的壞，
//    驗一棵就看得到；但「**別棵**樹自己的 `config.worktree` 被寫壞」仍只有在那棵樹裡跑
//    才驗得到——本檔不逐棵走訪。
//    ・承載檔定位交給 git 的 `--show-origin`（include 有展開、global 也指得到；r3 Medium①）；
//      定位不到（值來自環境或 blob）＝不印猜的還原指令，改教你自查。
//    ・repo 壞到 git 打不開時的退路只讀「這棵樹的 config.worktree＋共用 config」兩檔
//      （各帶 --includes）；global／system 層在退路讀不到——那兩層能弄壞的是整台機器
//      的每個 repo，不在本檔射程。
//    ・origin 解析走 `-z`（NUL 邊界）——tab／雙引號等會被 git C-quote 的路徑因此**在射程內**
//      （r4 Low）；還剩「路徑本身含換行（或 U+2028）」不在考題射程（逐行抽取的限制，r3 Low④），
//      那種路徑請自行以 `-z --show-origin` 自查。
//    ・多值 key（同檔重複、跨 scope 各一筆）：還原指令一律用 `--replace-all`／`--unset-all`
//      （r4 Medium）；同 key 散在**多個檔**時，修完一檔要重跑體檢、照新訊息修下一檔。
//    ・需要 git ≥ 2.8（`--show-origin`，2016 年）：更舊的 git 上這些查詢會失敗，體檢退化成
//      泛用診斷（not-a-repo 級，照樣非零擋下）——不會假綠，但拿不到承載檔與還原指令。
//
// 用法：node scripts/check-worktree-integrity.js
// 退出碼：0＝這棵樹的工作樹身分正常；1＝有問題（訊息裡附還原指令）

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main.js';
// ⚠️ 清環境的實作在 `lib/git-env.js`（前綴整族清的理由寫在那裡）。**體檢本身若在 `GIT_DIR`
//    之下跑，量到的就不是你指的那棵樹**——從 worktree push 時 hook 的環境正是如此，
//    那會變成「靜靜量了別棵樹、回報一切正常」，也就是這支要防的病自己中招。
import { gitEnv } from '../lib/git-env.js';

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
  const r = spawnSync('git', args, { encoding: 'utf8', cwd, env: gitEnv() });
  if (r.error) throw r.error;
  if (typeof r.status !== 'number') {
    throw new Error(`git ${args.join(' ')} 沒有正常結束（signal=${r.signal}）——體檢無法下判斷。`);
  }
  return { status: r.status, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

/**
 * 這棵樹的 gitdir（主目錄＝`<repo>/.git`；連結工作樹＝`.git` 指標檔裡的那個路徑）。
 * 純檔案操作，不經過 git ⇒ repo 已經壞掉時照樣讀得到。
 * `core.worktree` 的相對路徑就是以這裡為基準解的（git 文件：relative to $GIT_DIR）。
 *
 * @param {string} repoDir
 * @returns {string | null}
 */
function gitDirPath(repoDir) {
  const dotGit = join(repoDir, '.git');
  if (!existsSync(dotGit)) return null;
  if (!statSync(dotGit).isFile()) return dotGit;
  const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
  return m ? resolve(repoDir, m[1]) : null;
}

/**
 * 找出這棵樹的**共用** config 檔（走 gitdir → commondir）。
 * 純檔案操作，不經過 git ⇒ repo 已經壞掉時照樣讀得到。
 *
 * @param {string} repoDir
 * @returns {string | null} 讀不出來就回 null（讓呼叫端維持「查不到就不宣稱」）
 */
function sharedConfigPath(repoDir) {
  const gitDir = gitDirPath(repoDir);
  if (!gitDir) return null;
  const commondirFile = join(gitDir, 'commondir');
  const commonDir = existsSync(commondirFile)
    ? resolve(gitDir, readFileSync(commondirFile, 'utf8').trim())
    : gitDir;
  const cfg = join(commonDir, 'config');
  return existsSync(cfg) ? cfg : null;
}

/**
 * @typedef {{ status: 'value', out: string, file: string | null }
 *   | { status: 'invalid', err: string, file: string | null }
 *   | { status: 'absent' }} ConfigOrigin
 */

/**
 * 列出一個 key 的**全部條目**（origin＋raw 值），用 `-z --show-origin --get-all`。
 *
 * ⚠️ 為什麼是 `-z`（#435 r4 Low）：不帶 `-z` 時 git 會把含 tab／雙引號等特殊字元的
 *    origin 路徑做 C-quote，自己解引號＝重新發明 git 的跳脫規則（一定漂）。
 *    `-z` 的邊界是 NUL：`file:<路徑>\0<值>\0` 重複，路徑照原樣，整族問題消失。
 * ⚠️ 為什麼是 `--get-all`（#435 r4 Medium）：同一個 key 可以有**很多筆**（同檔重複、
 *    跨 scope 各一筆）；`--get` 只回最後贏家，壞值若在別筆，承載檔就指錯。
 * ⚠️ origin 路徑可能是**相對的**（git 以自己的 cwd 為基準印）——以 `base` 解成絕對，
 *    不然還原指令站在別處照貼就找不到檔（r3 事故重現考題實際踩到）。
 *    非 `file:` 來源（blob、command line…）＝file 記 null，**不會拿去印還原指令**。
 *
 * @param {{ status: number, out: string }} r 跑完的 git 結果
 * @param {string} base
 * @returns {{ file: string | null, value: string }[] | null} null＝這條查詢自己跑不動
 */
function parseEntriesZ(r, base) {
  if (r.status !== 0) return null;
  const parts = r.out.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  /** @type {{ file: string | null, value: string }[]} */
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i];
    const value = parts[i + 1];
    if (!origin.startsWith('file:')) { entries.push({ file: null, value }); continue; }
    const p = origin.slice(5);
    entries.push({ file: isAbsolute(p) ? p : resolve(base, p), value });
  }
  return entries;
}

/**
 * 「這個字串是不是 git 認的合法布林、值是多少」——**問 git 自己**，不自己實作布林語意
 * （yes/on/1/無值…的規則抄一份就會漂）。站在 repo 外跑，不吃任何 repo 的 config。
 * @param {string} value
 * @returns {{ ok: true, out: string } | { ok: false }}
 */
function gitBoolOracle(value) {
  const r = gitOutsideRepo(['-c', `probe.v=${value}`, 'config', '--bool', '--get', 'probe.v']);
  return r.status === 0 ? { ok: true, out: r.out } : { ok: false };
}

/**
 * 問「這個 key 的有效值是什麼、**值真正住在哪個檔**」。
 *
 * ⚠️ 用 git 自己的 `--show-origin`（include 有展開），**不自己列舉檔案**：列舉補不完——
 *    #435 r2 漏了 worktree-local、r3 又漏了 include 與 global（連兩輪同型洞）。
 *    關這一類門的方法是問 git 拿真相，不是把清單加長。
 *
 * 兩條路：
 *    ・repo 還打得開 ⇒ effective 讀法（global／include 的來源都拿得到）。
 *    ・repo 已壞到 git 打不開（`core.worktree` 亂指）⇒ 退路：對「這棵樹的 config.worktree」
 *      與「共用 config」兩檔各以 `--file --includes --show-origin` 直讀（include 照樣展開）。
 *      global／system 在退路讀不到——但那兩層若能把 repo 弄壞，壞的是整台機器每個 repo，
 *      不在本檔射程（檔頭誠實劃界有記）。
 *
 * 布林語意逐筆問 `gitBoolOracle`（#435 r3 Medium③＋r4 Medium）：`--bool --get` 只要**任何
 * 一筆**壞就整條 fatal、而且指不出是哪筆——這裡改成 raw 列舉全部條目、逐筆請 git 判、
 * 壞的那一筆的 origin 才是要修的檔。贏家（最後一筆）合法時也要掃其餘各筆：低順位的
 * 壞值照樣會讓 git 開 repo 時炸掉。
 *
 * @param {string} repoDir
 * @param {string} key
 * @param {{ bool?: boolean }} [opts]
 * @returns {ConfigOrigin}
 */
function configOrigin(repoDir, key, opts = {}) {
  // 逐筆列舉（不帶 --bool——多筆裡混一筆壞的就會整條 fatal，壞值定位交給 oracle）。
  // effective 讀法涵蓋 system／global／include；repo 壞到打不開時退路直讀兩個 repo 檔
  //（順序＝共用檔先、config.worktree 後＝git 的優先序，**最後一筆＝贏家**）。
  let entries = parseEntriesZ(
    git(repoDir, ['config', '-z', '--show-origin', '--get-all', key]),
    repoDir,
  );
  if (entries === null) {
    const gd = gitDirPath(repoDir);
    const shared = sharedConfigPath(repoDir);
    /** @type {{ file: string | null, value: string }[]} */
    const collected = [];
    let anyReadable = false;
    for (const file of [shared, gd ? join(gd, 'config.worktree') : null]) {
      if (!file || !existsSync(file)) continue;
      const got = parseEntriesZ(
        gitOutsideRepo(['config', '--file', file, '--includes', '-z', '--show-origin', '--get-all', key]),
        dirname(file),
      );
      if (got !== null) { anyReadable = true; collected.push(...got); }
    }
    if (!anyReadable) return { status: 'absent' };
    entries = collected;
  }
  if (entries.length === 0) return { status: 'absent' };
  const winner = entries[entries.length - 1];
  if (!opts.bool) return { status: 'value', out: winner.value, file: winner.file };
  // 布林語意：贏家先問 oracle；贏家合法時**還要掃其餘各筆**——git 開 repo 時會把
  // 每一筆都吃下去，低順位一筆 banana 照樣讓整個 repo 打不開（#435 r4 Medium 的實測）。
  const winnerBool = gitBoolOracle(winner.value);
  if (!winnerBool.ok) return { status: 'invalid', err: `'${winner.value}' 不是合法布林`, file: winner.file };
  const bad = entries.find((e) => !gitBoolOracle(e.value).ok);
  if (bad) return { status: 'invalid', err: `'${bad.value}' 不是合法布林（非贏家那一筆，但 git 開 repo 時照樣會炸）`, file: bad.file };
  return { status: 'value', out: winnerBool.out, file: winner.file };
}

/** 把承載檔講成人話：這棵樹自己的、共用的、還是 include／全域進來的。
 *  @param {string} repoDir @param {string} file @returns {string} */
function describeConfigFile(repoDir, file) {
  const gd = gitDirPath(repoDir);
  if (gd && resolve(file) === resolve(join(gd, 'config.worktree'))) {
    return '這棵樹自己的 config.worktree——只有這棵樹中';
  }
  const shared = sharedConfigPath(repoDir);
  if (shared && resolve(file) === resolve(shared)) {
    return '共用的 .git/config——主目錄與所有連結工作樹一起中';
  }
  return `這份設定檔（include 進來的檔或全域設定；讀到它的 repo 都會中）`;
}

/**
 * POSIX shell 單引號安全字串：單引號裡 `$`、反引號、`\` 一律不展開；
 * 路徑本身含單引號用 `'\''` 接法。體檢印的還原指令是給人**複製貼上進 shell** 的，
 * 用雙引號包路徑會讓字面上的 `$HOME`、`$()` 被展開（#435 r2 Medium③——考題會拿
 * 含 `$`／反引號的路徑照字面丟給 `sh -c` 驗證）。
 *
 * @param {string} s
 * @returns {string}
 */
function shq(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`;
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
  // ① 事故本體。⚠️ 一律走 `--bool`：yes／on／1 都是 git 合法的 true，比字面 'true' 會被
  //    同義值騙過（#435 r2 Medium①）。承載檔由 configOrigin 用 --show-origin 定位——
  //    include／global 進來的也指得到，**還原才會改對檔**（r2 Medium②＋r3 Medium①）。
  const bare = configOrigin(repoDir, 'core.bare', { bool: true });
  if (bare.status === 'value' && bare.out === 'true') {
    problems.push({
      id: 'core-bare',
      message:
        `core.bare = true${bare.file ? `（值住在${describeConfigFile(repoDir, bare.file)}）` : ''}。\n`
        + (bare.file
          ? `  還原：git config --file ${shq(bare.file)} --replace-all core.bare false\n`
          : '  ⚠️ 定位不到承載檔（值可能來自環境或 blob）——不給猜的還原指令，'
            + `先自查：git -C ${shq(repoDir)} config --show-origin --get core.bare\n`)
        + '  ⚠️ 還原之前先看一眼是誰寫的：檔頭記著有直接證據的機制'
        + '（GIT_DIR 指向 .git/worktrees/<名> 時跑 git init）。',
    });
  }

  // ①c 壞布林值（core.bare=banana 這型）：不是假綠——repo 照樣壞、push 照樣被擋——
  //    但只回泛用 not-a-repo 等於把成因藏起來（#435 r3 Medium③）。指名病灶與承載檔。
  if (bare.status === 'invalid') {
    problems.push({
      id: 'core-bare-invalid',
      message:
        `core.bare 的值不是合法布林（git：${bare.err.split('\n')[0]}）`
        + `${bare.file ? `，值住在${describeConfigFile(repoDir, bare.file)}` : ''}。\n`
        + (bare.file
          ? `  還原：git config --file ${shq(bare.file)} --replace-all core.bare false\n`
          : `  ⚠️ 定位不到承載檔——先自查：git -C ${shq(repoDir)} config --show-origin --get core.bare\n`),
    });
  }

  // ①b **共用檔要指名直讀**（#435 r1 Medium③＋r2 Medium①）：extensions.worktreeConfig 開著時，
  //    某棵樹自己的 config.worktree 一旦覆寫 core.bare，effective 讀法會被掩住——這棵樹自己
  //    好好的，**其他沒覆寫的樹（含主目錄）卻全部一起中**。
  //    ⚠️ 這裡不能用「照優先序找到就停」的查法——那會先讀到覆寫值、把掩蔽 bug 往下搬一層
  //    （r2 rework 第一版真的犯過，考題當場抓紅）。帶 --includes：include 進來的照樣算（r3 Medium①）。
  const bareSharedCfg = sharedConfigPath(repoDir);
  if (!(bare.status === 'value' && bare.out === 'true') && bare.status !== 'invalid' && bareSharedCfg) {
    const sharedEntries = parseEntriesZ(
      gitOutsideRepo(['config', '--file', bareSharedCfg, '--includes', '-z', '--show-origin', '--get-all', 'core.bare']),
      dirname(bareSharedCfg),
    );
    if (sharedEntries && sharedEntries.length > 0) {
      const sw = sharedEntries[sharedEntries.length - 1];
      const swBool = gitBoolOracle(sw.value);
      const badShared = sharedEntries.find((e) => !gitBoolOracle(e.value).ok);
      if (badShared) {
        problems.push({
          id: 'core-bare-invalid',
          message:
            `共用 config 這一層的 core.bare 有一筆值不是合法布林（'${badShared.value}'）。\n`
            + (badShared.file
              ? `  還原：git config --file ${shq(badShared.file)} --replace-all core.bare false\n`
              : `  ⚠️ 定位不到承載檔——先自查：git config --file ${shq(bareSharedCfg)} --includes -z --show-origin --get-all core.bare\n`),
        });
      } else if (swBool.ok && swBool.out === 'true') {
        problems.push({
          id: 'core-bare-shared',
          message:
            '共用 config 這一層的 core.bare = true（這棵樹自己的 config.worktree 蓋住了它，'
            + '所以 effective 值看不到）。\n'
            + '  ⇒ 其他**沒有**覆寫的樹（含主目錄）全部一起中。\n'
            + (sw.file
              ? `  還原：git config --file ${shq(sw.file)} --replace-all core.bare false`
              : `  ⚠️ 定位不到承載檔——先自查：git config --file ${shq(bareSharedCfg)} --includes -z --show-origin --get-all core.bare`),
        });
      }
    }
  }

  // ② 同族的靜靜壞法：core.worktree 指到不存在的地方 ⇒ 每個 git 指令都變成
  //    `fatal: Invalid path '<那個路徑>'`（實測：主目錄與連結工作樹一起中）。
  //    ⚠️ 相對路徑是**合法設定**——git 以 $GIT_DIR 為基準解它；existsSync 直接吃原字串
  //    等於拿「本行程的 cwd」當基準＝把好設定判成壞（#435 r1 Medium④）。先解到 gitdir 上。
  //    ⚠️ effective 讀法在這個壞法下自己就 fatal——configOrigin 的退路會直讀檔案
  //    （含這棵樹自己的 config.worktree 與 include 展開；#435 r2 Medium②＋r3 Medium①）。
  const cw = configOrigin(repoDir, 'core.worktree');
  if (cw.status === 'value' && cw.out) {
    const cwBase = gitDirPath(repoDir);
    const cwTarget = isAbsolute(cw.out) ? cw.out : cwBase ? resolve(cwBase, cw.out) : cw.out;
    if (!existsSync(cwTarget)) {
      // ⚠️ 還原指令不能寫 `git -C <repo> ...`：這個狀態下 repo 裡的每個 git 指令（含 config）
      //    自己就會 fatal——上面 gitOutsideRepo 的存在理由。要站在 repo 外用 --file 指著
      //    **真正承載這個 key 的檔**改（改錯檔＝回報成功、病灶原封不動）。
      problems.push({
        id: 'core-worktree-missing',
        message:
          `core.worktree 指到不存在的路徑：${cw.out}`
          + `${cwTarget === cw.out ? '' : `（以 gitdir 為基準解到 ${cwTarget}）`}\n`
          + '  ⇒ 讀到這份 config 的樹，每個 git 指令都會回 fatal: Invalid path，\n'
          + '     所以「git -C 這棵樹」形式的指令（含 config）救不了自己。站在 repo 外面改檔案：\n'
          + (cw.file
            ? `  還原：git config --file ${shq(cw.file)} --unset-all core.worktree\n`
              + `  （這個值住在${describeConfigFile(repoDir, cw.file)}。）`
            : '  ⚠️ 定位不到承載檔（值可能來自環境或 blob）——不給猜的還原指令，'
              + `先自查：git config --file ${shq(join(repoDir, '.git', 'config'))} --includes --show-origin --get core.worktree`),
      });
    }
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
          + `  還原：git -C ${shq(repoDir)} read-tree HEAD\n`
          + '  （另一條路：git reset 也能重建索引。備註刻意放這一行——上一行要照貼可跑，'
          + '黏在指令尾巴的中文會一起進 shell；#435 r3 Medium②。）',
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
