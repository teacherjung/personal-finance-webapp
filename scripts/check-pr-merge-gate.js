#!/usr/bin/env node
// @ts-check
// 合併前的堆疊閘（#353 r2；r1 的第一版被 Codex 抓出兩個洞後改成腳本）：
//   ・r1 只查「有沒有人疊在我上面」——#346（base=fix/xlsx-resource-limits）會被放行，
//     然後合進 #342 的分支而不是 main，正好重演 2026-07-28。
//   ・r1 的考題只掃文件關鍵字——被「把指令搬進 HTML 註解」直接繞過（3/3 綠）。
// 所以：閘＝這支腳本（行為考題在 test/merge-gate.test.js 用假 gh 鎖住），文件只負責「叫人跑它」。
//
// 用法：node scripts/check-pr-merge-gate.js <PR 編號>
// 退出碼：0＝非堆疊（可照常 --squash --delete-branch）
//         1＝堆疊（兩個方向其一成立）→ 停下來，改走 AGENTS.md「堆疊 PR 的合併程序」
//         2＝查不清楚（gh 失敗／跨 fork／回傳不是 JSON）→ fail-closed，一律當堆疊、不准合併。
//            「查不到」不等於「安全」——兩次事故畫面上都是 Merged＋CI 全綠、零錯誤訊息。
//
// 兩個方向各防一次真實事故：
//   ①本支的 base 必須是 main   → 不然按合併鍵會合進別支分支（2026-07-28 #311/#312 的死法）
//   ②不得有 open PR 以本支 head 為 base → 不然刪分支會把上層連帶關閉為 MERGED 且無法重開
//                                          （2026-07-10 #3/#5 的死法）
// 分頁安全：②用 gh 的伺服器端 `--base` 過濾——回來的每一列都是命中；
// 「抓一頁回來自己用 jq 濾」超過 30 支就會假陰性（r1 寫法），不要改回去。

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @typedef {{ baseRefName: string, headRefName: string, isCrossRepository: boolean }} PrInfo */

/**
 * 純判斷層（考題直測）。
 * @param {PrInfo} pr
 * @param {Array<{ number: number }>} dependents 以本支 head 為 base 的 open PR
 * @returns {{ code: 0 | 1 | 2, reason: string }}
 */
export function evaluateGate(pr, dependents) {
  if (pr.isCrossRepository) {
    return { code: 2, reason: '跨 fork 的 PR，堆疊判斷不可靠（fork 的分支名會與本 repo 撞名）——請人工確認後再合併' };
  }
  if (pr.baseRefName !== 'main') {
    return { code: 1, reason: `base 是「${pr.baseRefName}」不是 main——按合併鍵會合進那支分支（2026-07-28 #311/#312 的死法）。先把 base 改回 main 並 rebase` };
  }
  if (dependents.length > 0) {
    return { code: 1, reason: `有 PR 疊在本支上面（#${dependents.map((d) => d.number).join('、#')}）——刪分支會把它們連帶關閉為 MERGED 且無法重開（2026-07-10 #3/#5 的死法）` };
  }
  return { code: 0, reason: '非堆疊：base=main、沒有上層 PR。可照常 --squash --delete-branch' };
}

/** @param {string[]} args */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function main() {
  const n = process.argv[2];
  if (!n || !/^\d+$/.test(n)) {
    console.error('用法：node scripts/check-pr-merge-gate.js <PR 編號>');
    process.exit(2);
  }
  /** @type {PrInfo} */
  let pr;
  /** @type {Array<{ number: number }>} */
  let dependents;
  try {
    pr = JSON.parse(gh(['pr', 'view', n, '--json', 'baseRefName,headRefName,isCrossRepository']));
    // 伺服器端 --base 過濾（見檔頭「分頁安全」）；--limit 只是保險，命中列不會因分頁而消失
    dependents = JSON.parse(gh(['pr', 'list', '--state', 'open', '--base', pr.headRefName, '--json', 'number', '--limit', '200']));
  } catch (e) {
    console.error(`堆疊閘 PR #${n}：gh 查詢失敗（${e instanceof Error ? e.message : String(e)}）——查不清楚一律當堆疊，不准合併`);
    process.exit(2);
  }
  const r = evaluateGate(pr, dependents);
  console.log(`堆疊閘 PR #${n}：${r.reason}`);
  process.exit(r.code);
}

// 只有直接執行才跑（考題 import evaluateGate 純函式；端到端考題用假 gh 跑整支）。
// ⚠️ 要用 pathToFileURL 比對——本專案路徑含中文與空格，import.meta.url 是百分號編碼，
// 裸字串 `file://${argv[1]}` 永遠比不相等 → main() 靜默不跑、退出碼 0＝「放行」。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
