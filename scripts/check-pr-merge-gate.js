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
import { isMainModule } from '../lib/is-main.js';
import { gitEnv } from '../lib/git-env.js';

/** @typedef {{ baseRefName: string, headRefName: string, isCrossRepository: boolean }} PrInfo */

// ---- 形狀驗證（r3；Codex r2 blocking 2）----------------------------------
// JSON.parse 成功不代表形狀對：`gh pr list` 回 `{}` 時 `dependents.length` 是 undefined、
// `undefined > 0` 是 false → 判「無上層」→ 退出碼 0＝放行。**合法但錯形的 JSON 曾經 fail-open。**
// 所以解析完必過形狀驗證，不符一律退出碼 2（fail-closed）。

/**
 * **這支是合併程序的一道機械閘**——`test/collab-invariant-docs.test.js` 靠這個標記
 * 反查「現在到底有幾道閘」，再要求文件把每一道都點名得出來。
 *
 * ⚠️ 別把清單手寫在考題裡（Codex #385 r9／r10）：手寫的漂過一次（加了第四道閘、
 * 文件仍寫三道，考題全綠看不見），改成從散文反查又被證明可繞（lazy continuation、
 * 檔名含數字、乾脆不寫進步驟）。**真相放在閘自己身上**，加一支就一定被數到。
 */
export const MERGE_GATE = { name: '堆疊', why: 'base 必須是 main，且不得有 open PR 疊在本支上' };

/**
 * @param {unknown} v
 * @returns {v is PrInfo}
 */
export function isPrInfo(v) {
  return !!v && typeof v === 'object'
    && typeof (/** @type {any} */ (v).baseRefName) === 'string' && (/** @type {any} */ (v).baseRefName).length > 0
    && typeof (/** @type {any} */ (v).headRefName) === 'string' && (/** @type {any} */ (v).headRefName).length > 0
    && typeof (/** @type {any} */ (v).isCrossRepository) === 'boolean';
}

/**
 * @param {unknown} v
 * @returns {v is Array<{ number: number }>}
 */
export function isDependentList(v) {
  return Array.isArray(v) && v.every((d) => !!d && typeof d === 'object' && typeof d.number === 'number');
}

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
  // ⚠️ **`env: gitEnv()` 不可省**（AGENTS.md 鐵則 11；#463 r1 High）：`gh` 會**自己再去 spawn git**
  //    ——實測 `env GIT_DIR=<不存在的路徑> gh pr view <N>` 回 `failed to run git: fatal: not a git repository`。
  //    繼承來的 GIT_DIR 指到另一個**有效** repo 時，這道閘會去讀**那個** repo 的 PR 與留言，
  //    而輸出看起來完全正常。行為題＝test/cross-pr-merge.test.js「會叫 gh 的閘」那題（#526 起不寫死幾支）。
  return execFileSync('gh', args, { encoding: 'utf8', env: gitEnv() });
}

function main() {
  const n = process.argv[2];
  if (!n || !/^\d+$/.test(n)) {
    console.error('用法：node scripts/check-pr-merge-gate.js <PR 編號>');
    process.exit(2);
  }
  /** @type {unknown} */
  let prRaw;
  /** @type {unknown} */
  let depRaw;
  try {
    prRaw = JSON.parse(gh(['pr', 'view', n, '--json', 'baseRefName,headRefName,isCrossRepository']));
    if (!isPrInfo(prRaw)) throw new Error(`pr view 回傳形狀不對：${JSON.stringify(prRaw).slice(0, 120)}`);
    // 伺服器端 --base 過濾（見檔頭「分頁安全」）；--limit 只是保險，命中列不會因分頁而消失
    depRaw = JSON.parse(gh(['pr', 'list', '--state', 'open', '--base', prRaw.headRefName, '--json', 'number', '--limit', '200']));
    if (!isDependentList(depRaw)) throw new Error(`pr list 回傳形狀不對：${JSON.stringify(depRaw).slice(0, 120)}`);
  } catch (e) {
    console.error(`堆疊閘 PR #${n}：gh 查詢失敗或回傳形狀不對（${e instanceof Error ? e.message : String(e)}）——查不清楚一律當堆疊，不准合併`);
    process.exit(2);
  }
  // 走到這裡＝兩個 isXxx 都過了（沒過會在 catch 裡 exit 2），cast 是安全的
  const pr = /** @type {PrInfo} */ (prRaw);
  const dependents = /** @type {Array<{ number: number }>} */ (depRaw);
  const r = evaluateGate(pr, dependents);
  console.log(`堆疊閘 PR #${n}：${r.reason}`);
  process.exit(r.code);
}

// 只有直接執行才跑（考題 import evaluateGate 純函式；端到端考題用假 gh 跑整支）。
// ⚠️ 判斷「是不是被直接執行」一律走 lib/is-main.js——這裡原本自己寫一份，
//    六個地方六種寫法，錯了不會叫（main() 靜默不跑、退出碼 0＝「放行」）。
if (isMainModule(import.meta.url)) main();
