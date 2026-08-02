#!/usr/bin/env node
// @ts-check
// 合併前的**協作欄位閘**（2026-08-02，文件體檢抓到）。
//
// ## 為什麼要有這支
//
// 「實作者不按自己的合併鍵」「高風險由對方複審」這些規則，在 git 與 GitHub 上**不留任何痕跡**：
// 40 支已合併 PR 的 `mergedBy` 全部是 teacherjung（Claude 與 Codex 都用同一個 token）、
// GitHub reviews 全部 0 筆。唯一還看得見分工的地方是 **PR 說明的欄位**——
// 而它靠記憶維持，**2026-08-02 實測已經斷了：#374／#375／#376 連續三支漏填**。
//
// 所以：模板（`.github/pull_request_template.md`）管「寫得出來」，這支腳本管「沒寫就合不了」。
// 兩者都沒有的話，唯一不變量（沒有任何一份產出由寫它的人放行）就只是一句話。
//
// 用法：node scripts/check-pr-collab-fields.js <PR 編號>
// 退出碼：0＝五欄齊全、且實作者 ≠ 獨立審查者
//         1＝缺欄位或實作者自審 → 停下來補齊，不要合併
//         2＝查不清楚（gh 失敗／回傳不是 JSON／形狀不符）→ **fail-closed**
//            「查不到」不等於「安全」——這是 check-pr-merge-gate.js 學到的教訓：
//            兩次堆疊事故畫面上都是 Merged＋CI 全綠、零錯誤訊息。

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** 五個必填欄位。**這份清單是單一真相**——模板與 AGENTS.md 的文件分工表都照它。 */
export const REQUIRED_FIELDS = [
  '實作者',
  '獨立審查者',
  '基準版本',
  '預計修改的共享檔案',
  '這支若完全失敗，最糟失去什麼',
];

/** 合法的角色名（實作者／審查者只能是這三個之一）。 */
export const ROLES = ['Claude', 'Codex', 'William'];

/**
 * 從 PR 說明裡抽出某一欄的值。
 *
 * ⚠️ **必須忽略 HTML 註解**：模板本身就把填寫說明放在 `<!-- -->` 裡，而那些說明裡也出現
 *    「實作者」「獨立審查者」等字。不剝註解的話，模板原封不動送出去也會通過＝這道閘等於沒有。
 *   （同型的病：#353 r1 的考題只掃文件關鍵字，被「把指令搬進 HTML 註解」直接繞過。）
 *
 * @param {string} body @param {string} field @returns {string}
 */
export function fieldValue(body, field) {
  const clean = String(body || '').replace(/<!--[\s\S]*?-->/g, '');
  // 形如：`- **實作者**：Claude` ／ `**實作者**: Claude` ／ `實作者：Claude`
  // ⚠️ 冒號後只准吃**水平空白**（`[^\\S\\n]`），不可用 `\\s`——`\\s` 會吃掉換行，
  //    於是「欄位留空」會抓到**下一行**的內容，空模板看起來像「每一欄都填了」。
  //    實測：本檔的考題抓到這個 bug——空模板只被判 2 條問題，而不是五欄皆缺。
  const re = new RegExp(`\\*{0,2}${field}\\*{0,2}[^\\S\\n]*[:：][^\\S\\n]*(.*)`);
  const m = clean.match(re);
  return m ? m[1].trim().replace(/^\*+|\*+$/g, '').trim() : '';
}

/**
 * 檢查一份 PR 說明。回傳問題清單（空陣列＝通過）。
 * @param {string} body @returns {string[]}
 */
export function problemsOf(body) {
  /** @type {string[]} */ const problems = [];
  /** @type {Record<string,string>} */ const got = {};
  for (const f of REQUIRED_FIELDS) {
    const v = fieldValue(body, f);
    got[f] = v;
    if (!v) problems.push(`缺「${f}」`);
  }
  const impl = got['實作者'];
  const rev = got['獨立審查者'];
  // ⚠️ 核心那一條：實作者 ≠ 審查者。寫成同一個人＝違反唯一不變量，這道閘存在的全部理由。
  if (impl && rev && impl.toLowerCase() === rev.toLowerCase()) {
    problems.push(`實作者與獨立審查者都是「${impl}」——沒有任何一份產出可以由寫它的人放行`);
  }
  for (const [label, v] of [['實作者', impl], ['獨立審查者', rev]]) {
    if (v && !ROLES.some((r) => v.toLowerCase().includes(r.toLowerCase()))) {
      problems.push(`「${label}」寫成「${v}」，看不出是 ${ROLES.join('／')} 的哪一個`);
    }
  }
  return problems;
}

/** @param {string} pr @returns {string} */
function fetchBody(pr) {
  const out = execFileSync('gh', ['pr', 'view', pr, '--json', 'body'], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  if (!parsed || typeof parsed.body !== 'string') throw new Error('gh 回傳的形狀不對');
  return parsed.body;
}

/** @param {string[]} argv */
export function main(argv) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('用法：node scripts/check-pr-collab-fields.js <PR 編號>');
    return 2;
  }
  /** @type {string} */ let body;
  try { body = fetchBody(pr); }
  catch (e) {
    // fail-closed：查不到不等於安全
    console.error(`協作欄位閘 PR #${pr}：查不清楚（${/** @type {any} */ (e)?.message}）——一律當成未通過。`);
    return 2;
  }
  const problems = problemsOf(body);
  if (problems.length === 0) {
    console.log(`協作欄位閘 PR #${pr}：五欄齊全、實作者 ≠ 獨立審查者。可繼續合併程序。`);
    return 0;
  }
  console.error(`協作欄位閘 PR #${pr}：**未通過**\n` + problems.map((p) => `  ・${p}`).join('\n')
    + '\n\n請照 .github/pull_request_template.md 補齊再合併（規則見 AGENTS.md 三方協作框架節）。');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main(process.argv.slice(2)));
}
