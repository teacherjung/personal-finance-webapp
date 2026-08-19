// @ts-check
// 「Grok 複審後掃」條文的文件一致性考題（2026-08-19）。
//
// 病因：這一節是全 repo 同等級規則裡**沒有任何機器盯著**的一節——2026-08-19 實測，
// 把 AGENTS.md 整節刪光、REVIEW-AND-MERGE.md 的最短可執行版一併刪掉，三關與所有合併閘照樣全綠。
// 同等級的其他規則（合併守門＝`merge-procedure-docs`、唯一不變量＝`collab-invariant-docs`）都有考題釘著。
// 而這一節正好是**沒有合併閘接住**的那一條（條文自己寫明「不進任何合併閘」），
// 所以「文件不見了」就是它唯一的失效模式——這道考題只守這一件事。
//
// 同時守「兩份檔案講同一件事」這個病：規則正本在 AGENTS.md，
// **真正被照著執行的是 REVIEW-AND-MERGE.md**（`merge-procedure-docs` 的檔頭診斷過同一個病：
// 規則在一份檔案、執行在另一份檔案 ⇒ 規則等於不存在）。2026-08-19 實測的漂移就是這型：
// 三個「漏了就整遍作廢」的條件，AGENTS 寫了三個、最短可執行版只抄了兩個
// ——照它做的人會產出一份 AGENTS 判定為「根本沒跑」的掃描，而他自己不會知道。
//
// ⚠️ 誠實劃界（本檔證明什麼、不證明什麼）：
//   ・證明＝條文還在、兩份檔案對三個失效條件與時機的講法一致、被指向的腳本真的存在。
//   ・**不證明**＝有沒有人真的跑過那一遍掃描。條文本身就寫著「沒有任何機械保證，全靠自律」，
//     這道考題不會、也不打算改變那件事——別把它讀成「有考題＝掃有在跑」。
//   ・**不證明條文沒被架空**：`grokSection()` 只認頭尾兩個錨點，中間的內容它一律相信。
//     有人把承重的 bullet 搬進節內一個標著「已停用／存查」的附錄、字面全部留著，本檔照樣全綠。
//     （2026-08-19 預審實測過這個形狀。）擋這種要判斷「這段話還算不算數」，
//     那是複審者的工作，不是字串考題的——照 #479 的劃界停戰裁示，寫清楚比再補一層假保證好。
//   ・也不鎖字數、不鎖件數、不鎖節的長相（鐵則 10）：只鎖**承重的字串**。
//     條文改寫時這道會紅——那是刻意的，紅了就是提醒你「另一份也要跟著改」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/** HTML 註解裡的字不算數（`merge-procedure-docs` r1 實測：只搜關鍵字的考題，用註解就繞得過）。 */
const visible = (/** @type {string} */ md) => md.replace(/<!--[\s\S]*?-->/g, '');

/**
 * 抓 AGENTS.md 的「Grok 的邊界」節：從節首那行到下一個粗體段落標題為止。
 * 不用行號、不用固定行數——那些一改就漂。
 * @param {string} md
 */
function grokSection(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith('**Grok 的邊界（'));
  assert.notEqual(start, -1, 'AGENTS.md 找不到「Grok 的邊界」節——整節被刪或改名了，這道考題要跟著更新');
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
 * @param {string} md
 */
function shortVersion(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith('- **複審通過後、'));
  assert.notEqual(start, -1, 'REVIEW-AND-MERGE.md 找不到「複審通過後、…」那條——最短可執行版被刪了');
  let end = start + 1;
  while (end < lines.length && !/^(>|#{1,6} )/.test(lines[end])) end++;
  assert.notEqual(
    end, lines.length,
    'REVIEW-AND-MERGE.md 抓不到最短可執行版的結尾（後面既沒有 blockquote 也沒有標題）——'
      + '視窗會一路吃到檔尾，斷言就會在錯的範圍裡命中；這道考題要跟著更新'
  );
  return lines.slice(start, end).join('\n');
}

// 三個「漏了就整遍作廢」的條件。逐字相同才算兩份檔案講同一件事——
// 換句話說就是換一種講法，讀的人分不出是不是同一條規則。
const KILL_CONDITIONS = ['版本不同＝當未跑', '退出碼非 0＝該掃作廢', '缺這一行＝當未跑'];

test('Grok 複審後掃｜三個失效條件：AGENTS 正本與最短可執行版必須逐字一致（2026-08-19 實測漂移：時序那條只寫在正本）', () => {
  const canon = visible(grokSection(read('AGENTS.md')));
  const short = visible(shortVersion(read('REVIEW-AND-MERGE.md')));
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
  assert.ok(visible(grokSection(read('AGENTS.md'))).includes(READY), `AGENTS「Grok 的邊界」節的時機沒寫成「${READY}」`);
  assert.ok(visible(shortVersion(rm)).includes(READY), `REVIEW-AND-MERGE 最短可執行版的時機沒寫成「${READY}」`);

  // 合併步驟開頭那句指路——它是給「翻到合併步驟才第一次看到這件事」的人看的，
  // 所以它①必須真的在合併步驟的前導（搬到檔案別處＝那個人看不到）②必須自己講清楚時機已經過了
  // ③必須是渲染得出來的字（包進 HTML 註解＝讀的人一個字都看不到）。
  // ⚠️ 三件都是 2026-08-19 預審實測過的繞法：原版用整份原文 find，三種都能靜靜通過。
  const lines = visible(rm).split('\n');
  const mergeSteps = lines.findIndex((l) => l.startsWith('>') && l.includes('合併也由 Codex 代執行'));
  assert.notEqual(mergeSteps, -1, 'REVIEW-AND-MERGE.md 找不到合併步驟區塊（「合併也由 Codex 代執行」）——這道考題要跟著更新');
  // 前導＝合併步驟那行之前、且中間不隔著任何標題（隔了標題就是別的小節，那個人翻不到）
  let runUp = mergeSteps - 1;
  while (runUp >= 0 && !/^#{1,6} /.test(lines[runUp])) runUp--;
  const pointer = lines.slice(runUp + 1, mergeSteps).find((l) => l.startsWith('>') && l.includes('Grok 複審後掃'));
  assert.ok(pointer, '合併步驟的前導裡找不到 Grok 複審後掃的指路句（被刪、被搬到別的小節、或整句被 HTML 註解掉）');
  assert.ok(
    pointer.includes('轉正式之前'),
    '合併步驟的指路句沒寫出「轉正式之前」——人走到合併步驟時 PR 通常早已轉正式，這句話漏了時機就是叫人走燒額度的那條路'
  );
});

test('Grok 複審後掃｜固定小標 `### Grok 複審後掃`：條文釘它、PR 範本要真的吐得出這個字串', () => {
  const HEADING = '### Grok 複審後掃';
  assert.ok(
    visible(grokSection(read('AGENTS.md'))).includes(`\`${HEADING}\``),
    'AGENTS「Grok 的邊界」節不再釘住固定小標——沒有固定字串，日後要重裁 Grok 去留就翻不出紀錄（#483 記成零分的根因）'
  );
  const tpl = visible(read('.github/pull_request_template.md'));
  assert.ok(
    tpl.split('\n').some((l) => l.trim() === HEADING),
    `PR 範本裡沒有整行等於「${HEADING}」的小標（註解裡寫不算數）——條文自己承認「沒有固定小標時，日後想重裁 Grok 去留實際上做不到」`
  );
});

test('Grok 複審後掃｜被指向的驗屍腳本必須真的存在（文件指著一支不存在的腳本＝規則等於不存在）', () => {
  const SCRIPT = 'scripts/audit-grok-scan.js';
  for (const f of ['AGENTS.md', 'REVIEW-AND-MERGE.md']) {
    assert.ok(visible(read(f)).includes(SCRIPT), `${f} 沒有指向 ${SCRIPT}`);
  }
  assert.ok(existsSync(join(ROOT, SCRIPT)), `${SCRIPT} 不存在——兩份文件都在叫人跑一支不存在的腳本`);
});

test('Grok 複審後掃｜程式線的定位：舊標籤不得復活，且節內那顆 bullet 必須正面寫著「常設」', () => {
  // ⚠️ 2026-08-19 預審抓到的假綠：絆線原本只搜「程式線預設關門」，
  // 但 AGENTS 原標題實際寫的是「程式線＝預設關門」（**中間有全形等號**）——
  // 於是這支 PR 最核心的那處修正可以整行逐字還原，而考題全綠。
  // 修法兩層：①反面絆線改成涵蓋有無等號兩種形狀 ②加一道**正面**斷言，
  // 因為「舊字串沒出現」永遠擋不住第三種新寫法，而「必須正面寫著常設」擋得住。
  const STALE = /程式線[＝=]?預設關門/;
  for (const f of ['AGENTS.md', 'REVIEW-AND-MERGE.md', 'CLAUDE.md']) {
    assert.ok(
      !STALE.test(visible(read(f))),
      `${f} 又出現「程式線（＝）預設關門」——那是 2026-08-16 轉常設前的狀態，與「程式線常設『複審後掃』」相反；`
        + '兩種相反答案並存時，只讀到其中一句的人會直接漏跑'
    );
  }
  const section = visible(grokSection(read('AGENTS.md')));
  const bullet = section.split('\n').find((l) => l.startsWith('- **程式線'));
  assert.ok(bullet, 'AGENTS「Grok 的邊界」節裡找不到「程式線」那顆 bullet');
  assert.ok(
    bullet.includes('常設') && bullet.includes('複審後掃'),
    '「程式線」那顆 bullet 沒有正面寫出「常設『複審後掃』」——'
      + '它是節內唯一講程式線定位的一句，只靠反面絆線擋不住換個講法寫回「預設關門」的語意'
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
