#!/usr/bin/env node
// @ts-check
// **跨 PR 試合併閘**（William 2026-08-03 定）。
//
// ## 這支在解什麼
//
// 「兩支 PR 各自全綠」**不等於**「合起來全綠」。2026-08-03 一個晚上就撞了兩次，
// 而且兩次都是同一個形狀——**一支的規則，禁止了另一支的內容**：
//
// | | #384 加的規則 | #385 的內容 | 結果 |
// |---|---|---|---|
// | 第一次 | AGENTS.md 標題只准 `##`／`###` | 它寫了 `#### 兩條規則` | 各自綠、合起來紅 |
// | 第二次 | AGENTS.md 一個 `<` 都不准 | 它寫了 `🤖 <角色>｜來源：<哪個 session>` | 同上 |
//
// 兩次都**沒有改到同一個檔案的同一行**，所以：
//   ・GitHub 不顯示衝突（文字上合得起來）
//   ・兩支的 CI 都是綠的（各自跑各自的）
//   ・**合併第二支的當下，`main` 就紅了**
//
// 現有機制一個都抓不到：分支保護的 `strict` 只檢查「跟 `main` 同步」，
// 不檢查「跟另一支**開著的** PR 相容」；「預計修改的共享檔案」預約制查的是
// 檔案重疊，而這種撞法**沒有檔案重疊**。
//
// ## 為什麼做成閘，不是寫進 AGENTS.md
//
// 因為這個專案自己有證據：PR 說明的五個必填欄位是寫在規則書裡、大家都同意的規則，
// 而 2026-08-02 實測**連續三支（#374／#375／#376）漏填**。
// 「記得在合併前做試合併」是完全同一種規則——要在正確的時機、由記得的人、手動執行，
// 而**被忘記的那一次不會有任何徵兆**。
//
// 做成閘之後，AGENTS.md 只需要多一個**名字**（自報的 `MERGE_GATE` 會強迫兩處摘要點名它），
// 不需要多一條要記住的規則。照 AGENTS.md 自己那句話：**摘要會落後，名字不會。**
//
// 用法：node scripts/check-cross-pr-merge.js <PR 編號>
// 退出碼：0＝沒有其他 open PR，或每一支試合併之後三關都綠
//         1＝有一支合起來會壞（文字衝突／測試紅）→ 停下來，先處理相容性
//         2＝查不清楚（gh 失敗／不是 git repo／建不出臨時工作區）→ fail-closed
//
// ## 誠實劃界
//
// 擋得住：**測試看得到**的互相破壞（一支的護欄擋掉另一支的內容、型別對不上、行為衝突）。
// **擋不住**：兩支合起來語意上矛盾、但測試沒有覆蓋到的地方——那還是要人看。
// 它也**不保證**合併之後 `main` 一定是綠的：它試的是「這兩支的 head」，
// 而真正合併時 `main` 可能已經又前進了（那一段由 `strict` 與 CI 接手）。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from '../lib/is-main.js';

/**
 * **這支是合併程序的一道機械閘**——`test/collab-invariant-docs.test.js` 靠這個標記
 * 反查「現在到底有幾道閘」，再要求文件把每一道都點名得出來。
 */
export const MERGE_GATE = {
  name: '跨 PR 試合併',
  why: '兩支各自全綠不代表合起來全綠——一支的規則可能禁止另一支的內容',
};

/**
 * 要拿來試合併的其他 PR。
 *
 * ⚠️ 判準只有兩條，刻意不多：**base 是 `main`**、**不是自己**。
 * 草稿（draft）也算——它一樣會被合併，而且草稿階段正是最容易寫出互斥內容的時候。
 * @param {{number: number, headRefOid: string, headRefName: string, baseRefName: string, isDraft?: boolean}[]} list
 * @param {number} self
 */
export function othersToTry(list, self) {
  return list
    .filter((p) => p.number !== self && p.baseRefName === 'main')
    .sort((a, b) => a.number - b.number);
}

/**
 * 把每一支的試合併結果彙整成退出碼與訊息。
 * @param {{number: number, ok: boolean, why: string}[]} results
 */
export function verdict(results) {
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) {
    return {
      code: 0,
      message: results.length
        ? `跨 PR 試合併：與 ${results.length} 支 open PR 合起來都是綠的（#${results.map((r) => r.number).join('、#')}）。`
        : '跨 PR 試合併：目前沒有其他 open PR，不需要試。',
    };
  }
  return {
    code: 1,
    message: '跨 PR 試合併：**合起來會壞**\n'
      + bad.map((r) => `  ・#${r.number}：${r.why}`).join('\n')
      // ⚠️ 兩種壞法要分開講，不可以混為一談（實跑第一次就發現我原本的訊息不準）：
      //    文字衝突 GitHub **會**顯示；測試紅 GitHub **不會**——後者才是這道閘存在的理由。
      + (bad.some((r) => r.why.includes('文字衝突'))
        ? '\n\n⚠️ **文字衝突**：這種 GitHub 自己就看得到（合併鍵會變灰）。'
          + '這道閘的價值在於**現在**就告訴你，而不是等到要合併的那一刻。'
        : '')
      + (bad.some((r) => r.why.includes('紅了'))
        ? '\n\n⚠️ **合起來測試紅**：這種 GitHub **不會**顯示——兩支各自的 CI 都是綠的、'
          + '也沒有檔案衝突，**合併第二支的當下 `main` 就紅了**。\n'
          + '   通常是其中一支的護欄擋掉了另一支的內容。先讓兩支相容再合併。'
        : ''),
  };
}

/** @param {string[]} args */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1e8 });
}

/**
 * 在拋棄式的工作區裡把 `base` 與 `other` 合起來，跑三關。
 *
 * ⚠️ **`node_modules` 用 symlink 指回主目錄，而且只用 `unlink` 拆掉**（不是 `rm -rf`）：
 * 新建的 worktree 沒有 `node_modules`，三關會全部 127 錯誤退出（2026-08-03 踩過，
 * 而且我當時把「指令沒找到」看成「三關通過」）。
 * 但 CLAUDE.md 有一條鐵則：**不要在 worktree 裡刪除 `node_modules`**——那個 symlink
 * 指回主目錄，動到它會讓 William 的 app 起不來。所以拆的時候用 `unlinkSync`：
 * 它只刪得掉連結本身，如果哪天那裡變成真的目錄，它會直接失敗而不是遞迴刪除。
 * @param {string} repoRoot @param {string} baseSha @param {string} otherSha @param {number} otherNumber
 */
function tryMerge(repoRoot, baseSha, otherSha, otherNumber) {
  const wt = mkdtempSync(join(tmpdir(), `cross-pr-${otherNumber}-`));
  const run = (/** @type {string[]} */ argv, /** @type {string} */ cwd) =>
    execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', stdio: 'pipe' });
  try {
    run(['git', 'worktree', 'add', '--detach', '-q', wt, baseSha], repoRoot);
    const nm = join(wt, 'node_modules');
    if (!existsSync(nm)) symlinkSync(join(repoRoot, 'node_modules'), nm);
    try {
      run(['git', 'merge', '--no-edit', '-q', otherSha], wt);
    } catch {
      return { number: otherNumber, ok: false, why: '文字衝突，git merge 就過不去' };
    }
    for (const [label, script] of [['校對', 'typecheck'], ['糾察', 'lint'], ['考試', 'test']]) {
      try {
        run(['npm', 'run', script === 'test' ? 'test' : script], wt);
      } catch (e) {
        const out = String(/** @type {any} */ (e)?.stdout || '').split('\n').filter(Boolean);
        return { number: otherNumber, ok: false, why: `合起來之後「${label}」紅了：${out.slice(-3).join(' / ').slice(0, 200)}` };
      }
    }
    return { number: otherNumber, ok: true, why: '' };
  } finally {
    // ⚠️ 先拆 symlink 再移除 worktree——`unlink` 只動得了連結，動不到主目錄的 node_modules
    const nm = join(wt, 'node_modules');
    try { unlinkSync(nm); } catch { /* 不在或不是連結都不要緊 */ }
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot, stdio: 'pipe' }); }
    catch { try { rmSync(wt, { recursive: true, force: true }); } catch { /* 盡力清乾淨 */ } }
  }
}

/** @param {string[]} argv */
export function main(argv) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('用法：node scripts/check-cross-pr-merge.js <PR 編號>');
    return 2;
  }
  let repoRoot; let self; let list;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    self = JSON.parse(gh(['pr', 'view', pr, '--json', 'number,headRefOid,baseRefName']));
    list = JSON.parse(gh(['pr', 'list', '--state', 'open', '--base', 'main',
      '--json', 'number,headRefOid,headRefName,baseRefName,isDraft', '--limit', '100']));
  } catch (e) {
    console.error(`跨 PR 試合併 PR #${pr}：查不清楚（${/** @type {any} */ (e)?.message}）——一律當成未通過。`);
    return 2;   // fail-closed
  }
  if (!self?.headRefOid || !Array.isArray(list)) {
    console.error(`跨 PR 試合併 PR #${pr}：gh 回傳的形狀不對——一律當成未通過。`);
    return 2;
  }
  const others = othersToTry(list, Number(pr));
  const results = [];
  for (const o of others) {
    try {
      results.push(tryMerge(repoRoot, self.headRefOid, o.headRefOid, o.number));
    } catch (e) {
      console.error(`跨 PR 試合併 PR #${pr}：建不出臨時工作區（${/** @type {any} */ (e)?.message}）。`);
      return 2;
    }
  }
  const v = verdict(results);
  (v.code === 0 ? console.log : console.error)(v.message);
  return v.code;
}

// 只有直接執行才跑（考題 import 純函式；端到端考題用假 gh 跑整支）。
// 判斷一律走 `lib/is-main.js`——symlink 與百分號編碼兩個坑寫在那裡，
// 這裡不重述（重述的說明會漂）。它答錯的後果：`main()` 從來沒跑而退出碼是 0，
// **一道閘「什麼都沒做卻回報通過」比它不存在更危險**。考題 `test/entry-guard.test.js` 盯著。
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
