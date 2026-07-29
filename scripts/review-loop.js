#!/usr/bin/env node
// @ts-check
// **四步驟審查循環的跑腿工具**（William 2026-07-29 定）。
//
// ## 這支在解什麼問題
//
// 2026-07-29 那一夜的實證：Claude 對每一支 PR 都做過突變測試、都說「驗過了」，
// 結果自審與 Codex 複審合計抓到 **10 個問題**——其中 4 個是「修完之後自己再驗一次」也沒抓到的。
// 而 Codex 自己也用錯過一次判準（把真考題誤判成假的，後來撤回）。
//
// 結論不是「誰比較可靠」，是**沒有人可以自己審自己**。所以：
//
// ## 不變量（唯一要守的一條）
//
//   **沒有任何一份產出，由寫它的人自己審。**
//
// 展開成步驟：
//
//   ① 找問題    → **A**（誰先發現都可以）
//   ② 提修法    → **B**（另一方）
//   ③ 審修法    → **A**（＝發現者，**不是**提案者）
//   ④ 實作      → **一律 Claude**（規則：審查者不可改程式）
//   ⑤ 審實作    → **Codex** ＝ 下一輪的 ①，循環因此閉合
//
// 兩個方向都合法，差別只在誰先發現：
//
//   Codex 先發現：Codex 找 → Claude 提 → **Codex** 審提案 → Claude 實作
//   Claude 先發現：Claude 找 → Codex 提 → **Claude** 審提案 → Claude 實作
//
// ⑤ 是關鍵：**實作本身也要有人審**，而它自然接回下一輪的第一步。
//
// **③ 是這個循環最省錢的一步**：2026-07-29 好幾次是「修法本身就是錯的方向」而不是
// 「實作有 bug」——XLSX 的牆設計連續被打穿四次（相信宣告值 → 相信宣告 0 →
// 枚舉方式不同 → 欄位偏移不同），每一次都是設計層面的錯，寫完才發現就白做一輪。
// 在寫程式之前審一次設計，比寫完再打掉便宜得多。
//
// ## 這支**不做**什麼（刻意的）
//
// 它不會自動改程式、不會自動合併、不會替任何人做判斷。
// 它只做三件跑腿的事：**用一致的提示詞叫 Codex**、**把產出存檔**、**檢查該有的東西在不在**。
// 判斷仍然是人（與模型）的事——這支只是讓「該做的步驟不會被跳過」。
//
// ## 用法
//
//   node scripts/review-loop.js review     <branch> [--pr N]   # ①／⑤ Codex 審 code
//   node scripts/review-loop.js review-fix <branch> --proposal <檔案> [--pr N]
//                                                              # ③ Codex 審「Claude 寫的修法提案」
//   node scripts/review-loop.js status     <branch>            # 看這支走到哪一步了
//
// ⚠️ **反方向（Claude 先發現、Codex 提修法）時，第③步是 Claude 審**——那一步不需要這支工具，
//    Claude 直接讀 Codex 的提案即可。這支只跑「要叫 Codex」的那幾步。
//    `review-fix` 會擋下「提案是 Codex 寫的」那種情形（見下方的守門）。
//
// 產出存到 `.codex-reviews/`（已在 .gitignore）。

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.codex-reviews');
/** Codex 專屬的唯讀 worktree（AGENTS.md：一律在這裡跑，碰不到主資料夾與 data/store.db）。 */
const CODEX_WT = join(ROOT, '..', '榮祥森（投資理財）-codex');

/** 審查模型與力度：高風險 PR 一律用這組（CODEX-REVIEW.md 開頭）。 */
const MODEL = ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"'];

const ROLE = `
## 你的角色（不可逾越）

你是**唯讀審查者**。這一條是專案寫定的規則（CODEX-REVIEW.md）：

> ⚠️ 合併前**不可**自行修改程式（審查者角色不變）；發現問題就回報給 Claude 修。

理由不是形式主義：**如果審查者自己寫修法，那個修法就沒有人審了。**
2026-07-29 的實證——Claude 對每支 PR 都做過突變測試、都說「驗過了」，
仍被抓到 10 個問題，其中 4 個是「自己再驗一次」也沒抓到的。
而你自己那一輪也用錯過一次判準（把真考題誤判成假的，後來撤回）。
**結論不是誰比較可靠，是沒有人可以自己審自己。**

所以：只提意見、附 file:line 與你自己的重現輸出，**不改任何檔案、不 commit、不 push**。

## 判準（AGENTS.md 鐵則 9，Claude 與你 2026-07-29 共同定案）

突變測試分兩型，**用錯型會把真考題誤判成假的、也會把假考題放過**：

| 型別 | 正確的突變 |
|---|---|
| **修法生效型** | 拿掉修法 → 考題必須紅 |
| **保存型**（斷言「X 在操作 Y 之後還在」） | **保留受測操作、破壞保存機制** → 必須紅。**刪掉 Y 不是有效突變** |

兩型都必須證明受測操作**確實執行**，且**不可依賴前一題留下的狀態**。
`;

/** @param {string[]} argv */
function parseArgs(argv) {
  const [cmd, branch, ...rest] = argv;
  /** @type {Record<string,string>} */
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] || '';
  }
  return { cmd, branch, flags };
}

/** 這支分支相對 main 改了什麼——放進提示詞讓審查者不必自己找。 @param {string} branch */
function diffStat(branch) {
  try {
    return execFileSync('git', ['diff', '--stat', `origin/main...origin/${branch}`],
      { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { return '（拿不到 diff——分支可能還沒推上去）'; }
}

/** @param {string} branch @param {string} stage */
function outPath(branch, stage) {
  mkdirSync(OUT_DIR, { recursive: true });
  const safe = branch.replace(/[^\w.-]/g, '_');
  const n = readdirSync(OUT_DIR).filter(f => f.startsWith(`${safe}-${stage}-`)).length + 1;
  return join(OUT_DIR, `${safe}-${stage}-${n}.md`);
}

/** 叫 Codex 跑一次，把輸出存檔。 @param {string} prompt @param {string} dest */
function runCodex(prompt, dest) {
  if (!existsSync(CODEX_WT)) {
    console.error(`找不到 Codex 的審查 worktree：${CODEX_WT}`);
    console.error('建立方式：git worktree add --detach "../<repo>-codex" origin/main');
    process.exit(2);
  }
  // 先把審查樹更新到 origin/main（AGENTS.md：detached，不可用 git pull、不可 checkout main）
  spawnSync('git', ['fetch', 'origin', '-q'], { cwd: CODEX_WT });
  spawnSync('git', ['checkout', '--detach', 'origin/main', '-q'], { cwd: CODEX_WT });

  console.log(`→ 交給 Codex（gpt-5.6-sol / xhigh）…輸出會存到 ${dest.replace(ROOT + '/', '')}\n`);
  const r = spawnSync('codex', [
    'exec', ...MODEL,
    '-s', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-C', CODEX_WT,
    prompt,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });

  const out = r.stdout || '';
  writeFileSync(dest, out);
  console.log(out.slice(-4000));
  console.log(`\n（完整輸出：${dest.replace(ROOT + '/', '')}）`);

  // ⚠️ 副作用檢查：審查者不該留下任何改動。留下了就是違反角色，要當成發現回報。
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: CODEX_WT, encoding: 'utf8' }).stdout.trim();
  if (dirty) {
    console.error('\n⚠️⚠️ 審查 worktree 不乾淨——審查者動了檔案，違反唯讀角色：');
    console.error(dirty);
    console.error('請人工確認之後 `git checkout -- .`，並把這件事當成一個發現。');
  }
}

const { cmd, branch, flags } = parseArgs(process.argv.slice(2));

if (!cmd || !branch) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(cmd ? 2 : 0);
}

if (cmd === 'review') {
  // ── ① Codex 審 code ────────────────────────────────────────────────────
  runCodex(`請先讀 repo 根目錄的 CODEX-REVIEW.md 與 AGENTS.md（特別是「審查分工」「⚠️ 同步點清單」「鐵則 9」）。

# 第①步：審查分支 \`${branch}\`${flags.pr ? `（PR #${flags.pr}）` : ''}
${ROLE}

## 這支改了什麼

用 \`git diff origin/main...origin/${branch}\` 看內容（**不要 checkout**——那個分支歸 Claude 的 worktree）。

\`\`\`
${diffStat(branch)}
\`\`\`

## 請查核

1. **每個保護是否真的有考題、而且打在正式環境會跑到的那條路上**（不是只考純函式）。
   請**實際跑突變**抽驗，依鐵則 9 的兩型判準下手；不要只看 PR 描述。
2. **修法本身有沒有引進新洞**——特別注意共用底層（資料層、中介層、解析器）。
3. **LOCAL 模式零改動契約**有沒有破。
4. 新增的考題裡有沒有假考題（只認得一種寫法／斷言的東西本來就不存在／依賴前一題的狀態）。

回報格式：逐條「屬實／誤報／需 William 裁決」，附 file:line 與你自己的重現輸出。
⚠️ **不要改碼、不要 commit、不要合併、不要改 PR 狀態。**`, outPath(branch, 'review'));

} else if (cmd === 'review-fix') {
  // ── ③ Codex 審「修法提案」（還沒動工）──────────────────────────────────
  const pf = flags.proposal;
  if (!pf || !existsSync(pf)) {
    console.error('要指定修法提案檔：--proposal <路徑>');
    console.error('提案要寫的是「打算怎麼修」，不是已經寫好的程式——這一步的價值就在動工前攔下錯的方向。');
    process.exit(2);
  }
  // ⚠️ **守門：提案是誰寫的，就不能由誰審。** 這是整個循環唯一要守的不變量。
  //    反方向（Claude 先發現、Codex 提修法）時，第③步該由 Claude 做，不該走這支工具。
  const proposalText = readFileSync(pf, 'utf8');
  if (/^\s*(作者|proposer|by)\s*[:：]\s*codex/im.test(proposalText)) {
    console.error('⚠️ 這份提案是 Codex 寫的，不可以再叫 Codex 審——那就是自己審自己。');
    console.error('   反方向的第③步由 Claude 做：直接讀提案、附證據同意或反駁，不需要這支工具。');
    process.exit(2);
  }
  if (!/^\s*(作者|proposer|by)\s*[:：]/im.test(proposalText)) {
    console.error('⚠️ 提案檔開頭要標明作者（例如 `作者：Claude`）——');
    console.error('   這個循環唯一要守的不變量是「寫的人不審」，沒標作者就檢查不了。');
    process.exit(2);
  }
  runCodex(`請先讀 repo 根目錄的 CODEX-REVIEW.md 與 AGENTS.md（特別是鐵則 9）。

# 第③步：審「**修法提案**」（分支 \`${branch}\`${flags.pr ? `，PR #${flags.pr}` : ''}）
${ROLE}

## ⚠️ 這一步審的是「打算怎麼修」，**不是已經寫好的程式**

Claude 還沒動工。這一步的價值就在**動工前攔下錯的方向**——
2026-07-29 那一夜好幾次是「修法本身就是錯的方向」而不是「實作有 bug」：
XLSX 的牆設計連續被打穿四次（相信宣告值 → 相信宣告 0 → 枚舉方式不同 → 欄位偏移不同），
每一次都是設計層面的錯，寫完才發現就白做一輪。

## Claude 的修法提案

\`\`\`markdown
${readFileSync(pf, 'utf8')}
\`\`\`

## 請查核（針對提案，不是程式）

1. **這個修法會不會修不到真正的病**？（例：Codex 自己第一輪建議「把更多標籤加進白名單」，
   但實測真正的病是位元組上限訂太高——加標籤修不好記憶體。）
2. **有沒有更簡單、風險更低的做法被漏掉**？
3. **這個修法會不會引進新的失效模式**？特別是：
   - 它有沒有假設某個外部函式庫的行為？那個假設驗證過嗎？
   - 它會不會誤殺正常使用者的輸入？（今晚有前例：data descriptor 一律拒收會擋掉
     LibreOffice 與 Google Sheets 匯出的檔案）
4. **提案裡的考題設計擋得住這個病嗎**？依鐵則 9 判斷型別，說明正確的突變應該是什麼。
5. **有沒有越權**——這個提案裡有沒有應該由 William 裁決的事（花錢、隱私取捨、風險胃納、
   要求使用者改變操作習慣），卻被當成技術決定？

回報格式：逐點「同意／建議改成…／這一項要 William 裁決」，並在最後給一個明確結論：
**「可以照這個方向動工」** 或 **「先別動工，理由是…」**。
⚠️ **不要改碼、不要 commit、不要幫忙實作。**`, outPath(branch, 'review-fix'));

} else if (cmd === 'status') {
  // ── 看這支走到哪一步 ──────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  const safe = branch.replace(/[^\w.-]/g, '_');
  const files = readdirSync(OUT_DIR).filter(f => f.startsWith(`${safe}-`)).sort();
  const has = (/** @type {string} */ s) => files.filter(f => f.includes(`-${s}-`)).length;
  console.log(`分支 ${branch} 的審查循環：\n`);
  console.log(`  ① Codex 審 code       ${has('review') ? `✅ 跑過 ${has('review')} 次` : '⬜ 還沒'}`);
  console.log(`  ② Claude 提出修法     （提案檔由 Claude 自己維護）`);
  console.log(`  ③ Codex 審修法提案    ${has('review-fix') ? `✅ 跑過 ${has('review-fix')} 次` : '⬜ 還沒'}`);
  console.log(`  ④ Claude 判斷並實作   （看 git log 與 PR 留言）`);
  if (files.length) console.log(`\n存檔：\n${files.map(f => `  .codex-reviews/${f}`).join('\n')}`);

} else {
  console.error(`不認得的指令：${cmd}（可用：review／review-fix／status）`);
  process.exit(2);
}
