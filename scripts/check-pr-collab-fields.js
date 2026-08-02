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
  // ⚠️ **必須錨定在行首**（Codex #379 r2 High①）：不錨定的話 `- **非實作者**：Claude`
  //    也會命中——整份 PR 說明可以一個真欄位都沒有，卻被判「五欄齊全」＝機械閘 fail-open。
  //    允許的形狀：行首可有 `-`／`*` 項目符號與空白，欄名可被 `**`／`__` 包住，然後才是冒號。
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');   // 欄名含「，」等字元，仍統一跳脫
  //   ⚠️ 也接受有序清單 `1. **實作者**：`（Codex #379 r3 記錄項）——**噪音型誤擋會讓人乾脆繞過這道閘**，
  //   而「用 1. 而不是 -」顯然不是想規避什麼。引言符號 `>` 刻意**不接受**：那是引用範例，不該滿足閘。
  const re = new RegExp(`^[^\\S\\n]*(?:(?:[-*+]|\\d+[.)])[^\\S\\n]*)?(?:\\*\\*|__)?${esc}(?:\\*\\*|__)?[^\\S\\n]*[:：][^\\S\\n]*(.*)$`, 'm');
  const m = clean.match(re);
  return m ? m[1].trim().replace(/^\*+|\*+$/g, '').trim() : '';
}

/**
 * 角色偵測用的**唯一**正規化管線（Codex #379 r4：括號掃描與最終比對必須看同一種形式）。
 *
 * 疊四層，各擋一類藏法（r3→r4 連兩輪的教訓＝少一層就有對應的繞法）：
 * ①NFKD——全形折半形、組合字拆開（`Ｃ`→`C`、`ó`→`o`＋重音）
 * ②去 `\p{M}`——拆開後的組合記號（U+0301 重音藏在字母上）
 * ③去 `\p{Default_Ignorable_Code_Point}`——U+034F、U+FE0F、U+2060 這類「預設不顯示」字元
 *   （⚠️ 比 `\p{Cf}` 大：U+034F 是 Mn、不在 Cf 裡——r4 就是這樣繞過 r3 的）
 * ④去 `\p{Cf}`——剩餘的格式控制字元
 *
 * @param {string} v @returns {string}
 */
export function probeNormalize(v) {
  return String(v || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\p{Cf}/gu, '');
}

/**
 * 把欄位值正規化成**剛好一個**角色；看不出來或不只一個就回 `null`。
 *
 * ⚠️ 這裡刻意**不用 `includes`**（Codex #379 r1 High①）：`NotClaude` 含有 `Claude`、
 *    `Claude and Codex` 也含有 `Claude`——用 substring 判斷等於把 fail-open 寫進閘裡。
 *    先剝掉 markdown 粗體、反引號、括號註記與空白，再要求**全等**於某一個角色。
 *
 * @param {string} raw @returns {string | null}
 */
export function canonicalRole(raw) {
  // ⚠️ **正規化要做在最前面、只做一次**（Codex #379 r3 Medium）：
  //    r2 版只把外層正規化、括號內的檢查用原字串，於是 `Claude（Ｃｏｄｅｘ）`（全形）與
  //    `Claude（Co\u200bdex）`（零寬）都溜過去——括號被整段剝掉，剩下乾淨的 `Claude`。
  //    根因是「同一個字串有兩種形式在流動」。**之後所有判斷都只看正規化後的字串**。
  const bare = probeNormalize(String(raw || ''))
    .replace(/[`*_~]/g, '');                    // markdown 裝飾
  // ⚠️ **混用文字系統＝看不出是誰，fail-closed**（Codex #379 r4 Medium）：
  //    西里爾 `С`（U+0421）跟拉丁 `C` 在螢幕上長一樣，正規化折不掉——那是**不同的字母**。
  //    角色名全是拉丁字母；欄位裡出現「拉丁以外的字母混在拉丁詞裡」沒有任何正當理由，
  //    整欄直接判「看不出是誰」。不做 confusable 對照表（表列不完，同型病第四次）。
  if (/\p{Script=Latin}/u.test(bare)) {
    for (const ch of bare) {
      if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch) && !/\p{Script=Han}/u.test(ch)) return null;
    }
  }
  // **括號裡若藏著第二個角色就不算單一角色**（Codex #379 r2 Medium①）：
  //   「Claude（Codex）」剝掉括號會變成乾淨的 `Claude`，與「獨立審查者：Codex」搭配就整份通過——
  //   但那個欄位實際上提到了兩個角色，語意上正是「看不出是誰」。
  for (const inner of bare.match(/\([^)]*\)/g) || []) {
    // bare 已經過 probeNormalize——括號內的藏字元在這之前就被折掉了（r4 的四個重現都在這裡歸位）
    if (ROLES.some((r) => new RegExp(r, 'i').test(inner))) return null;
  }
  const t = bare
    .replace(/\([^)]*\)/g, '')                 // 括號註記（「Claude（已看過）」；NFKC 後全形括號已折成半形）
    .replace(/\s+/g, '')                        // 空白
    .trim();
  if (!t) return null;
  const hit = ROLES.filter((r) => r.toLowerCase() === t.toLowerCase());
  return hit.length === 1 ? hit[0] : null;      // 不只一個或零個 → 看不出來
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
  const implRaw = got['實作者'];
  const revRaw = got['獨立審查者'];
  const impl = canonicalRole(implRaw);
  const rev = canonicalRole(revRaw);

  // ⚠️ **角色必須正規化成剛好一個**（Codex #379 r1 High①）。
  //    第一版用 `includes(role)` 判斷「看不看得出角色」、用原字串比對是否同一人，於是實測：
  //      ・`實作者：Claude` ／ `獨立審查者：Claude（已看過）` → **通過**（字串不同）
  //      ・`實作者：NotClaude`                                → **通過**（含有 Claude）
  //      ・`實作者：Claude and Codex`                          → **通過**（含有 Claude）
  //    也就是「同一人自審」與「模糊多人」都繞得過——這道閘最核心的那一條回到靠人肉判讀。
  //    現在：剝掉格式與裝飾字之後**必須剛好命中一個角色**，然後比對正規化後的角色。
  for (const [label, raw, role] of [['實作者', implRaw, impl], ['獨立審查者', revRaw, rev]]) {
    if (raw && !role) {
      problems.push(`「${label}」寫成「${raw}」，必須剛好是 ${ROLES.join('／')} 的其中一個`
        + '（不接受加註、多人並列、或看不出是誰的寫法）');
    }
  }
  // 核心那一條：實作者 ≠ 審查者。寫成同一個人＝違反唯一不變量，這道閘存在的全部理由。
  if (impl && rev && impl === rev) {
    problems.push(`實作者與獨立審查者都是「${impl}」——沒有任何一份產出可以由寫它的人放行`);
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
