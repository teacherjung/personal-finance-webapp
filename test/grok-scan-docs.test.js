// @ts-check
// 「Grok 複審後掃」條文的文件一致性考題（2026-08-19）。
//
// 病因：這一節是全 repo 同等級規則裡**沒有任何機器盯著**的一節——2026-08-19 實測，
// 把 AGENTS.md 整節刪光、REVIEW-AND-MERGE.md 的最短可執行版一併刪掉，三關與所有合併閘照樣全綠。
// 同等級的其他規則（合併守門＝`merge-procedure-docs`、唯一不變量＝`collab-invariant-docs`）都有考題釘著。
// 而這一節正好是**沒有合併閘接住**的那一條（條文自己寫明「不進任何合併閘」）。
// 這道考題守的是**最粗的那一種失效：指定的字串不見了**。比它細的失效（字還在、但已經不算數）
// 它讀不出來——⚠️ 原本這裡寫「『文件不見了』就是它唯一的失效模式」，那句話是誇大的
// （2026-08-19 Codex r1 點名），已改口；完整劃界見下。
//
// 同時守「兩份檔案講同一件事」這個病：規則正本在 AGENTS.md，
// **真正被照著執行的是 REVIEW-AND-MERGE.md**（`merge-procedure-docs` 的檔頭診斷過同一個病：
// 規則在一份檔案、執行在另一份檔案 ⇒ 規則等於不存在）。2026-08-19 實測的漂移就是這型：
// 三個「漏了就整遍作廢」的條件，AGENTS 寫了三個、最短可執行版只抄了兩個
// ——照它做的人會產出一份 AGENTS 判定為「根本沒跑」的掃描，而他自己不會知道。
//
// ⚠️ 誠實劃界（本檔證明什麼、不證明什麼）：
//   ・證明＝**指定的那幾個字串，在指定的那兩個區塊裡都還在**，而且被指向的腳本檔真的存在。
//     「還在」＝不在 HTML 註解裡、不在 fence 裡（含 blockquote 內的 fence）——但**縮排式
//     程式碼區塊不涵蓋**，見 `visible()` 的劃界。⚠️ 這句話本身改口過兩次：r1 原寫
//     「兩份檔案講法一致」（字串相同不等於講法一致），r2 原寫「不是程式碼範例裡的字」
//     （被 blockquote 裡的 fence 當場推翻）。現在寫的是它真正做得到的射程。
//   ・**不證明**＝有沒有人真的跑過那一遍掃描。條文本身就寫著「沒有任何機械保證，全靠自律」，
//     這道考題不會、也不打算改變那件事——別把它讀成「有考題＝掃有在跑」。
//   ・**不證明那些字現在還算不算數**：字串考題讀不出語意。兩種形狀實測照樣全綠——
//     ①把「程式線＝常設『複審後掃』」改成「**不再**常設『複審後掃』」，語意整個反過來，
//       而 `includes('常設')` 照樣命中（2026-08-19 Codex r1 實測）；
//     ②把承重的 bullet 搬進節內一個標著「已停用／存查」的附錄、字面全部留著（同日預審實測）。
//     判斷「這句話還算不算數」是**複審者**的工作，不是字串考題的。這裡刻意**不**補一層
//     否定詞偵測（「不再」「已停用」「廢止」…）——列舉繞法補不完，補了只會長出新的假保證；
//     照 #479 的劃界停戰裁示，照實劃界比再補一層好。
//   ・也不鎖字數、不鎖件數、不鎖節的長相（鐵則 10）：只鎖**承重的字串**。
//     ⚠️ 原本這裡寫「條文改寫時這道會紅」——那句跟上面兩格直接打架（上面才剛列出
//     兩種改寫**不會**紅），2026-08-19 Codex r2 點名，改口：**只有動到那幾個承重字串
//     才會紅**；其餘的改寫它一律沉默。紅的時候就是提醒你「另一份也要跟著改」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 只留「規則真的在對讀者發號施令」的那些字。剝兩種：
 * ①HTML 註解——`merge-procedure-docs` r1 實測：只搜關鍵字的考題，用註解就繞得過。
 * ②fenced code——把一段規則包進 fence，畫面上它就從「你要照做的規則」變成「程式碼範例」，
 *   字面卻一個沒少（2026-08-19 Codex r1 實測 6/6 假綠）。
 *
 * ⚠️ fence 這一段刻意**不是**用正則列舉寫法（r1 用了欄首三個反引號的正則，r2 就被
 * 「blockquote 裡的 fence」整個繞過去——那種 fence 每行前面都有 `>`，欄首根本不是反引號）。
 * 列舉補不完（三個以上反引號／波浪號／縮排／blockquote 內…），所以改成**逐行狀態機**：
 * 先把每行的 blockquote 標記剝掉，再判斷這行是不是 fence 的開關，在 fence 裡的行整行丟掉。
 *
 * ⚠️ 只剝 fenced，**不剝行內反引號**——條文本來就用行內 code 標指令與固定字串，剝掉會把承重的字一起剝掉。
 * ⚠️ 已知不涵蓋：**縮排式程式碼區塊**（四個空白）——那種寫法在這幾份檔案裡跟一般的
 * 縮排續行分不開，硬要分會誤殺真規則。這一格照實劃界，不假裝守得住。
 */
function visible(/** @type {string} */ md) {
  const out = [];
  let fence = null;   // 目前這段 fence 的記號（` 或 ~）；null＝不在 fence 裡
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    // 剝掉 blockquote 標記再看——`> ``` ` 在畫面上一樣是 fence（r2 的繞法）
    const line = raw.replace(/^(\s*>)+\s?/, '');
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (m) { fence = m[1][0]; continue; }   // fence 開始：這行本身不算內容
      out.push(raw);
    } else if (m && m[1][0] === fence) {
      fence = null;                            // 同款記號才算收——fence 裡出現另一種不算
    }
  }
  return out.join('\n');
}

/**
 * 抓 AGENTS.md 的「Grok 的邊界」節：從節首那行到下一個粗體段落標題為止。
 * 不用行號、不用固定行數——那些一改就漂。
 * ⚠️ 傳進來的必須是 `visible()` 過的字（呼叫端負責）：先剝再抓，否則「整段包進 fence」時
 * 起點錨點仍在原文裡找得到，剝除只發生在區塊內部，這一題會靜靜通過而由別的題轉紅（誤導）。
 * @param {string} visibleMd
 */
function grokSection(visibleMd) {
  const md = visibleMd;
  const lines = md.split('\n');
  const starts = lines.map((l, i) => (l.startsWith('**Grok 的邊界（') ? i : -1)).filter((i) => i !== -1);
  assert.notEqual(starts.length, 0, 'AGENTS.md 找不到「Grok 的邊界」節——整節被刪或改名了，這道考題要跟著更新');
  // ⚠️ 先驗唯一再擷取（2026-08-19 Codex r2 實測的繞法）：把整節複製一份到
  // 「## 已停用存查」底下、補一個同形結尾錨點，`findIndex` 就抓到那份存查副本，
  // 於是現行那一節怎麼壞都全綠。多一份同形節首＝這道考題已經不知道自己在讀誰。
  assert.equal(
    starts.length, 1,
    `AGENTS.md 有 ${starts.length} 處「Grok 的邊界」節首（第 ${starts.map((i) => i + 1).join('、')} 行）——`
      + '這道考題只讀得到第一處；有存查／草稿副本時，現行那一節壞掉也不會紅'
  );
  const start = starts[0];
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('**⚠️ 協作的唯一不變量')) end++;
  assert.notEqual(end, lines.length, 'AGENTS.md 抓不到「Grok 的邊界」節的結尾（下一節「協作的唯一不變量」不見了）');
  return lines.slice(start, end).join('\n');
}

/**
 * 抓 REVIEW-AND-MERGE.md 的最短可執行版：從那顆 bullet 到**下一個 blockquote 或下一個標題**為止。
 * ⚠️ 結尾錨點兩種都要收（2026-08-19 預審實測）：原版只認 blockquote，
 * 於是把後面那顆 blockquote 改寫成一般段落（純排版動作、沒人會察覺）就讓視窗從 22 行漲到 138 行、
 * 把「省額度慣例」整節吞進來——承重句只要被**搬**到那一節，斷言就在錯的範圍裡命中＝靜靜通過。
 * 收不到錨點一律 fail-closed 地紅，不是靜靜跑到檔尾。
 * ⚠️ 同上：傳進來的必須是 `visible()` 過的字。整段被包進 fence 時，這一段就整個不見了，
 * 於是起點錨點找不到＝直接紅在「最短可執行版被刪了」，訊息指到對的地方。
 * @param {string} visibleMd
 */
function shortVersion(visibleMd) {
  const md = visibleMd;
  const allLines = md.split('\n');
  // ⚠️ 先把視窗夾在「### 怎麼執行」這一節之內（2026-08-19 Codex r2 實測的繞法）：
  // 在那顆 bullet 前面插一個同級標題「### 已停用存查」，最短可執行版就不在被三處指路
  // 共同指著的那一節裡了，而全檔 findIndex 照樣找得到 ⇒ 六題全綠。
  // ⚠️ 父節**自己**也要先驗唯一（2026-08-19 Codex r3 實測）：r2 只驗了 bullet 在選中的父節裡唯一，
  // 於是在現行節前面插一個「### 怎麼執行（已停用存查）」、裡面放一份合格的短版，
  // 再把真正現行那節還原成舊時機 ⇒ 讀到的是存查副本，六題全綠。
  const secStarts = allLines.map((l, i) => (l.startsWith('### 怎麼執行') ? i : -1)).filter((i) => i !== -1);
  assert.notEqual(secStarts.length, 0, 'REVIEW-AND-MERGE.md 找不到「### 怎麼執行」節——三處指路都指著它，改名要一起改');
  assert.equal(
    secStarts.length, 1,
    `REVIEW-AND-MERGE.md 有 ${secStarts.length} 個「### 怎麼執行」節（第 ${secStarts.map((i) => i + 1).join('、')} 行）——`
      + '這道考題只讀得到第一個；存查／草稿副本一出現，現行那節壞掉也不會紅'
  );
  const secStart = secStarts[0];
  let secEnd = secStart + 1;
  while (secEnd < allLines.length && !/^#{1,3} /.test(allLines[secEnd])) secEnd++;
  const lines = allLines.slice(secStart, secEnd);

  const starts = lines.map((l, i) => (l.startsWith('- **複審通過後、') ? i : -1)).filter((i) => i !== -1);
  assert.notEqual(
    starts.length, 0,
    'REVIEW-AND-MERGE.md 的「### 怎麼執行」節裡找不到「複審通過後、…」那條——'
      + '最短可執行版被刪了，或被搬出那一節（三處指路都指著那一節）'
  );
  assert.equal(starts.length, 1, `「### 怎麼執行」節裡有 ${starts.length} 條「複審通過後、…」——這道考題只讀得到第一條`);
  const start = starts[0];
  let end = start + 1;
  while (end < lines.length && !/^(>|#{1,6} )/.test(lines[end])) end++;
  assert.notEqual(
    end, lines.length,
    'REVIEW-AND-MERGE.md 抓不到最短可執行版的結尾（後面既沒有 blockquote 也沒有標題）——'
      + '視窗會一路吃到檔尾，斷言就會在錯的範圍裡命中；這道考題要跟著更新'
  );
  return lines.slice(start, end).join('\n');
}

// 三個「漏了就整遍作廢」的條件。這裡要求兩份檔案**逐字相同**，理由是操作面的：
// 換句話說就是換一種講法，讀的人分不出是不是同一條規則、也 grep 不到。
// ⚠️ 逐字相同**不等於**講法一致（檔頭劃界已寫明本檔讀不出語意）——原本這行寫成
// 「逐字相同才算兩份檔案講同一件事」，那是誇大，2026-08-19 Codex r2 點名後改口。
const KILL_CONDITIONS = ['版本不同＝當未跑', '退出碼非 0＝該掃作廢', '缺這一行＝當未跑'];

test('Grok 複審後掃｜三個失效條件：AGENTS 正本與最短可執行版必須逐字一致（2026-08-19 實測漂移：時序那條只寫在正本）', () => {
  const canon = grokSection(visible(read('AGENTS.md')));
  const short = shortVersion(visible(read('REVIEW-AND-MERGE.md')));
  for (const c of KILL_CONDITIONS) {
    assert.ok(canon.includes(c), `AGENTS「Grok 的邊界」節少了失效條件「${c}」`);
    assert.ok(
      short.includes(c),
      `REVIEW-AND-MERGE 的最短可執行版少了失效條件「${c}」——`
        + '照它做的人會完整跑完流程，然後產出一份正本判定為「根本沒跑」的掃描，而他自己不會知道'
    );
  }
});

test('Grok 複審後掃｜時機是「轉正式之前」：正本、最短可執行版、合併步驟指路句三處都要寫（寫成「合併之前」＝每修一條多燒一次全卷 CI）', () => {
  const rm = read('REVIEW-AND-MERGE.md');
  const READY = '`gh pr ready` 轉正式之前';
  assert.ok(grokSection(visible(read('AGENTS.md'))).includes(READY), `AGENTS「Grok 的邊界」節的時機沒寫成「${READY}」`);
  assert.ok(shortVersion(visible(rm)).includes(READY), `REVIEW-AND-MERGE 最短可執行版的時機沒寫成「${READY}」`);

  // 合併步驟開頭那句指路——它是給「翻到合併步驟才第一次看到這件事」的人看的，
  // 所以它①必須真的在合併步驟的前導（搬到檔案別處＝那個人看不到）②必須自己講清楚時機已經過了
  // ③必須是渲染得出來的字（包進 HTML 註解＝讀的人一個字都看不到）。
  // ⚠️ 三件都是 2026-08-19 預審實測過的繞法：原版用整份原文 find，三種都能靜靜通過。
  const lines = visible(rm).split('\n');
  const mergeSteps = lines.findIndex((l) => l.startsWith('>') && l.includes('合併也由 Codex 代執行'));
  assert.notEqual(mergeSteps, -1, 'REVIEW-AND-MERGE.md 找不到合併步驟區塊（「合併也由 Codex 代執行」）——這道考題要跟著更新');
  // 前導＝**緊鄰合併步驟的前一個 blockquote 區塊**。
  // ⚠️ 不能用「往回找到上一個標題」來夾範圍：這份檔案的第一個標題在合併步驟**之後**，
  //    於是那種寫法的範圍等於「檔案開頭到合併步驟」，把指路句搬到第 3 行照樣算過（r2 突變 M2d 實測）。
  let scan = mergeSteps - 1;
  while (scan >= 0 && lines[scan].trim() === '') scan--;   // 跳過中間的空行
  const blockEnd = scan;
  while (scan >= 0 && lines[scan].startsWith('>')) scan--;  // 收攏這一塊連續的 blockquote
  const pointer = lines.slice(scan + 1, blockEnd + 1).find((l) => l.includes('Grok 複審後掃'));
  assert.ok(
    pointer,
    '緊鄰合併步驟的那一塊前導裡找不到 Grok 複審後掃的指路句——'
      + '被刪、被搬去檔案別處、或整句被 HTML 註解掉了；那個人翻到合併步驟時就看不到它'
  );
  assert.ok(
    pointer.includes('轉正式之前'),
    '合併步驟的指路句沒寫出「轉正式之前」——人走到合併步驟時 PR 通常早已轉正式，這句話漏了時機就是叫人走燒額度的那條路'
  );
});

test('Grok 複審後掃｜固定小標 `### Grok 複審後掃`：條文釘它、PR 範本要真的吐得出這個字串', () => {
  const HEADING = '### Grok 複審後掃';
  assert.ok(
    grokSection(visible(read('AGENTS.md'))).includes(`\`${HEADING}\``),
    'AGENTS「Grok 的邊界」節不再釘住固定小標——沒有固定字串，日後要重裁 Grok 去留就翻不出紀錄（#483 記成零分的根因）'
  );
  const tpl = visible(read('.github/pull_request_template.md'));
  assert.ok(
    tpl.split('\n').some((l) => l.trim() === HEADING),
    `PR 範本裡沒有整行等於「${HEADING}」的小標（註解裡寫不算數）——條文自己承認「沒有固定小標時，日後想重裁 Grok 去留實際上做不到」`
  );
});

test('Grok 複審後掃｜驗屍腳本要被**正式那兩段**指到，而且真的存在（全檔搜尋會被「歷史檔名存查」那種句子矇混）', () => {
  const SCRIPT = 'scripts/audit-grok-scan.js';
  // ⚠️ 不可以用全檔 includes（2026-08-19 Codex r3 實測）：把正式命令都改成不存在的腳本、
  // 只在檔案開頭各留一句「歷史檔名存查：`scripts/audit-grok-scan.js`」，全檔搜尋照樣命中 ⇒
  // 正式流程已經指著一支不存在的腳本，而考題全綠。要綁在**發號施令的那兩段**裡。
  assert.ok(
    grokSection(visible(read('AGENTS.md'))).includes(SCRIPT),
    `AGENTS「Grok 的邊界」節裡沒有指向 ${SCRIPT}（別處提到不算——那不是發號施令的地方）`
  );
  assert.ok(
    shortVersion(visible(read('REVIEW-AND-MERGE.md'))).includes(SCRIPT),
    `REVIEW-AND-MERGE 的最短可執行版裡沒有指向 ${SCRIPT}（別處提到不算）`
  );
  assert.ok(existsSync(join(ROOT, SCRIPT)), `${SCRIPT} 不存在——兩份文件的正式流程都在叫人跑一支不存在的腳本`);
});

test('Grok 複審後掃｜程式線的定位：舊標籤不得復活，且那顆 bullet 上還留著「常設」「複審後掃」兩個詞（查字不查語意）', () => {
  // ⚠️ 2026-08-19 預審抓到的假綠：絆線原本只搜「程式線預設關門」，
  // 但 AGENTS 原標題實際寫的是「程式線＝預設關門」（**中間有全形等號**）——
  // 於是這支 PR 最核心的那處修正可以整行逐字還原，而考題全綠。
  // 修法兩層：①反面絆線改成涵蓋有無等號兩種形狀 ②加一道**正面**斷言。
  // ⚠️ 正面斷言證明的只是「這兩個詞還在那一行上」——**不證明那一行還在講同一件事**：
  // 改成「不再常設『複審後掃』」語意整個反過來，這一題照樣綠（Codex r1 實測）。
  // 它擋的是「整句被換成不提常設的第三種寫法」，擋不了否定詞；後者交給複審者。
  const STALE = /程式線[＝=]?預設關門/;
  for (const f of ['AGENTS.md', 'REVIEW-AND-MERGE.md', 'CLAUDE.md']) {
    assert.ok(
      !STALE.test(visible(read(f))),
      `${f} 又出現「程式線（＝）預設關門」——那是 2026-08-16 轉常設前的狀態，與「程式線常設『複審後掃』」相反；`
        + '兩種相反答案並存時，只讀到其中一句的人會直接漏跑'
    );
  }
  const section = grokSection(visible(read('AGENTS.md')));
  const bullet = section.split('\n').find((l) => l.startsWith('- **程式線'));
  assert.ok(bullet, 'AGENTS「Grok 的邊界」節裡找不到「程式線」那顆 bullet');
  assert.ok(
    bullet.includes('常設') && bullet.includes('複審後掃'),
    '「程式線」那顆 bullet 上不再有「常設」與「複審後掃」這兩個詞——'
      + '它是節內唯一講程式線定位的一句；反面絆線只擋得住舊字串本身，'
      + '整句被換成第三種不提常設的寫法就要靠這一道。'
      + '（⚠️ 這一道只查字在不在，查不出語意：寫成「不再常設」它照樣過。）'
  );
});

test('Grok 複審後掃｜CLAUDE.md 必須自己提一次，且時機要跟它寫在同一句（新 session 只保證讀到 CLAUDE.md）', () => {
  // 兩個字串各查各的會被「散在兩個無關 bullet」蒙混過去（2026-08-19 預審抓到）——綁同一行。
  const hit = visible(read('CLAUDE.md')).split('\n')
    .find((l) => l.includes('Grok 複審後掃') && l.includes('轉正式之前'));
  assert.ok(
    hit,
    'CLAUDE.md 沒有一句同時講出「Grok 複審後掃」與「轉正式之前」——'
      + '只寫「要做」不寫「什麼時候做」，做的人照樣會排到轉正式之後（#464 實測過同型漏跑）；'
      + '而 CLAUDE.md 是唯一保證每個 session 都讀到的入口，規則只寫在別份檔案＝比規則晚出生的 session 讀不到'
  );
});
