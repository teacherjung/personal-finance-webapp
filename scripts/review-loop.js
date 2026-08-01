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
//   ④ 實作      → **預設 Claude**；Codex 僅限 William 明確指派（2026-07-30 三模式邊界），
//                  該支改由 Claude 複審＋執行合併（對稱授權）
//   ⑤ 審實作    → **Codex** ＝ 下一輪的 ①，循環因此閉合
//
// 兩個方向都合法，差別只在誰先發現：
//
//   Codex 先發現：Codex 找 → Claude 提 → **Codex** 審提案 → Claude 實作
//   Claude 先發現：Claude 找 → Codex 提 → **Claude** 審提案 → Claude 實作
//   William 指派 Codex 實作（模式③）：Codex 實作 → **Claude** 複審 → Claude 執行合併
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
// 審查一律 xhigh（William 2026-07-31 裁決取代舊分級；AI 不可自行降級，想省額度只能 William 逐案明說）。
const MODEL = ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"'];

/**
 * **防禦性審查的範圍聲明**——每一個提示詞的開頭都會帶著它。
 *
 * ⚠️ 2026-07-29 實測踩到：第三輪審查跑到一半被 Codex 平台的內容過濾器切斷
 *    （`This content was flagged for possible cybersecurity risk`），
 *    整份報告因此遺失，只剩片段。原因是先前的提示詞寫得像在**教它造攻擊工具**
 *    （「請找第三個縫」「造一份能通過這道牆的檔案」）。
 *
 * 實際要做的事其實一直是防禦：**檢查既有防線會不會被繞過，並給安全的修正**。
 * 把這件事在開頭講清楚，既是事實、也避免整輪審查白跑。
 */
const SCOPE = `
## 這次工作的性質與範圍（請先讀完）

這是 **repo 擁有者授權的防禦性程式碼審查**。目標只有一個：
**檢查既有防線會不會被繞過，並給出 file:line 與安全的修正建議。**

- ✅ 只用**合成資料**；為了證明某道牆有縫，可以寫最小的重現測試（那是驗證，不是攻擊）
- 🚫 **不碰任何真實憑證或第三方系統**：絕不讀 \`data/store.db\`／\`data/store.json\`（含 .bak/-wal/-shm），
     不連 Supabase／Render／IBKR／SEC／Yahoo 等任何線上服務
- 🚫 **不產出可直接照做的攻擊操作步驟或工具**。發現問題就描述**成因與修法**，
     重現用的東西留在測試碼裡即可
- 🚫 不啟動主服務、不動 \`data/\`；要實測就把 \`STORE_FILE\` 指到暫存檔

**一次只審一支 PR**（2026-07-29 起的做法）——單次範圍小，報告也不會因為太長而被截斷。
`;

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

/**
 * 分支現在的 SHA。**審查一定要釘在一個固定的 commit 上。**
 *
 * ⚠️ 2026-07-29 實測踩到：Codex 回報「牆被繞過」並附了真實輸出，
 *    Claude 造了五種變體都重現不出來，追了半小時才發現
 *    **它測的是舊版本**（建臨時 worktree 時抓到的那一版，而 Claude 之後又 force-push 了）。
 *    不是誰的錯——是流程沒有把「審的是哪一版」釘住。
 * @param {string} branch
 */
function shaOf(branch) {
  try {
    return execFileSync('git', ['rev-parse', `origin/${branch}`], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

/**
 * 叫 Codex 跑一次，把輸出存檔。
 * @param {string} prompt @param {string} dest @param {string} branch
 */
function runCodex(prompt, dest, branch) {
  const shaBefore = shaOf(branch);
  if (!shaBefore) {
    console.error(`拿不到 origin/${branch} 的 SHA——分支推上去了嗎？`);
    process.exit(2);
  }
  console.log(`釘選：origin/${branch} @ ${shaBefore.slice(0, 8)}`);
  const wtsBefore = spawnSync('git', ['worktree', 'list'], { cwd: ROOT, encoding: 'utf8' }).stdout || '';
  if (!existsSync(CODEX_WT)) {
    console.error(`找不到 Codex 的審查 worktree：${CODEX_WT}`);
    console.error('建立方式：git worktree add --detach "../<repo>-codex" origin/main');
    process.exit(2);
  }
  // 先把審查樹更新到 origin/main（AGENTS.md：detached，不可用 git pull、不可 checkout main）
  spawnSync('git', ['fetch', 'origin', '-q'], { cwd: CODEX_WT });
  spawnSync('git', ['checkout', '--detach', 'origin/main', '-q'], { cwd: CODEX_WT });

  const pinned = `

## ⚠️ 這次要審的版本（請釘住它）

**\`origin/${branch}\` @ \`${shaBefore}\`**

請在報告的**第一行**寫出你實際審到的 commit（\`git rev-parse origin/${branch}\` 的結果）。
如果它與上面那個不一樣，代表分支在審查期間被推過——**請停下來回報，不要繼續**，
那份報告會對不上實際的程式碼（2026-07-29 真的發生過：報告指出一個繞過，
但那是對舊版本測的，花了半小時才追出來）。
`;
  prompt += pinned;
  console.log(`→ 交給 Codex（gpt-5.6-sol / xhigh）…輸出會存到 ${dest.replace(ROOT + '/', '')}\n`);
  const r = spawnSync('codex', [
    'exec', ...MODEL,
    '-s', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-C', CODEX_WT,
    prompt,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });

  const out = r.stdout || '';
  const shaAfter = shaOf(branch);
  writeFileSync(dest, `<!-- 審查對象：origin/${branch} @ ${shaBefore} -->\n\n${out}`);
  console.log(out.slice(-4000));
  console.log(`\n（完整輸出：${dest.replace(ROOT + '/', '')}）`);

  // ── 跑完的三道檢查（規則 2／3 靠工具驗，不靠自律）────────────────────────
  // ⚠️ ①**分支在審查期間有沒有被推過**——動過就代表這份報告對不上程式碼。
  if (shaAfter && shaAfter !== shaBefore) {
    console.error(`\n⚠️⚠️ 分支在審查期間被推過：`);
    console.error(`     審查開始：${shaBefore.slice(0, 8)}`);
    console.error(`     現在    ：${shaAfter.slice(0, 8)}`);
    console.error('     **這份報告作廢，請重跑。** 審查中不可以推分支（規則：審查釘住 SHA）。');
  }
  // ⚠️ ②審查者不該留下任何改動。留下了就是違反唯讀角色，要當成一個發現。
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: CODEX_WT, encoding: 'utf8' }).stdout.trim();
  if (dirty) {
    console.error('\n⚠️⚠️ 審查 worktree 不乾淨——審查者動了檔案，違反唯讀角色：');
    console.error(dirty);
    console.error('請人工確認之後 `git checkout -- .`，並把這件事當成一個發現。');
  }
  // ⚠️ ③審查者不該自己開臨時 worktree（規則：一律 `git diff origin/main...origin/<branch>`，不 checkout）。
  //    2026-07-29 實測它會建 `/private/tmp/pr<N>-review.*`——那正是「測到舊版本」的來源。
  const wtsAfter = spawnSync('git', ['worktree', 'list'], { cwd: ROOT, encoding: 'utf8' }).stdout || '';
  // ⚠️ 只提**這一輪新出現的**——舊的殘留另外清，混在一起報會變成每次都響的狼來了警報
  const before = new Set((wtsBefore || '').split('\n'));
  const strays = wtsAfter.split('\n').filter(l =>
    /\/(private\/)?tmp\/.*(review|pr\d+)/i.test(l) && !before.has(l));
  if (strays.length) {
    console.error('\n⚠️ 審查期間出現臨時 worktree（審查者不該 checkout，那會讓它審到別的版本）：');
    for (const w of strays) console.error(`     ${w}`);
    console.error('     收掉：git worktree remove --force <路徑>');
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
${SCOPE}
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
⚠️ **不要改碼、不要 commit、不要合併、不要改 PR 狀態。**`, outPath(branch, 'review'), branch);

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
${SCOPE}
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
⚠️ **不要改碼、不要 commit、不要幫忙實作。**`, outPath(branch, 'review-fix'), branch);

} else if (cmd === 'conform') {
  // ── 規格符合性審查：適合「牆 vs 被保護的解析器」這一類 ──────────────────
  //
  // ⚠️ 為什麼要有這個模式（2026-07-29）：`fix/xlsx-resource-limits` 的審查**連續兩次**
  //    被 Codex 平台的內容過濾器整份切斷（第二次連一個字的審查內容都沒有）。
  //    第一次以為是提示詞寫得像在教人造攻擊工具，加了 SCOPE 之後 #347 過了——
  //    但 #342 還是被擋，因為**被審的材料本身**幾乎全是攻擊檔的建構器。
  //
  // 更重要的是：回頭看那道牆被打穿的五次（宣告值加總／宣告 0／local vs 中央目錄／
  // EOCD 欄位偏移／ZIP64 extra field），**沒有一次是「創意攻擊」**，
  // 全部都是「**牆跟解析器對同一份 metadata 有歧見**」。
  //
  // 所以正確的審查問題不是「你能不能找到繞過」，而是
  // 「**這兩份實作逐步對得起來嗎？跟規格對得起來嗎？**」——
  // 那更貼近真正的失效模式，而且只要讀程式碼、不必造任何檔案。
  const against = flags.against;
  if (!against) {
    console.error('要指定對照的實作：--against <路徑>');
    console.error('例：--against node_modules/xlsx/xlsx.js  （我們的牆要跟它讀同一份 metadata）');
    process.exit(2);
  }
  runCodex(`請先讀 repo 根目錄的 CODEX-REVIEW.md 與 AGENTS.md。

# 規格符合性審查：分支 \`${branch}\`${flags.pr ? `（PR #${flags.pr}）` : ''}
${SCOPE}
${ROLE}

## 這一次要問的問題（不是「找繞過」，是「對不對得起來」）

這支 PR 裡有一段程式，職責是**在把檔案交給解析器之前，先量它有多貴**。
它必須跟**被保護的那個解析器讀同一份 metadata**——不然它看到的世界跟解析器看到的不是同一個。

這個專案在這一點上已經出過**五次**問題，每一次都是同一個類別：
  ① 相信宣告值的加總      ② 相信「宣告 0 ＝沒東西」
  ③ 枚舉方式不同（循序掃 local header vs 走中央目錄）
  ④ 讀錯欄位偏移（EOCD 的 +8 vs +10）
  ⑤ 漏解 ZIP64 的 extra field

**沒有一次是創意攻擊，全部都是「兩份實作對同一份資料的理解有落差」。**

## 請做的事

1. 把 \`git diff origin/main...origin/${branch}\` 裡那段掃描程式**逐步讀完**（不要 checkout）。
2. 把 \`${against}\` 裡對應的解析流程**也逐步讀完**。
3. **逐步對照**：兩者在下列每一點上的行為是否一致？不一致的地方就是下一個 ⑥。
   - 從哪裡開始枚舉？（檔頭？尾部？哪個索引？）
   - 枚舉幾個項目？讀哪個欄位得到數量？
   - 每個項目的位置怎麼決定？
   - 大小從哪一份 metadata 取？有多個來源時以誰為準？
   - 有哪些欄位／旗標會改變上面任何一項的解讀？
   - 遇到解讀不了的結構時，各自怎麼處理？
4. 再對照 **ZIP 規格本身**（APPNOTE）：有沒有規格允許、但兩邊都沒處理的情形？

## 回報

逐點「一致／不一致（附兩邊的 file:line）」。不一致的每一項請說明
**「解析器會怎麼理解、我們的掃描會怎麼理解、兩者差在哪」**，以及安全的修正方向。
⚠️ **不需要造任何檔案，也不要寫攻擊步驟**——這一輪要的是逐步對照的結論。
⚠️ 不要改碼、不要 commit、不要合併。`, outPath(branch, 'conform'), branch);

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
