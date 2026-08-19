// @ts-check
// 「Grok 複審後掃」條文的文件一致性考題（2026-08-19）。
//
// 病因：這一節是全 repo 同等級規則裡**唯一沒有任何機器盯著的一節**——2026-08-19 實測，
// 把 AGENTS.md 整節刪光、REVIEW-AND-MERGE.md 的最短可執行版一併刪掉，三關與五道合併閘照樣全綠。
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
 * 抓 REVIEW-AND-MERGE.md 的最短可執行版：從那顆 bullet 到下一個 blockquote 為止。
 * @param {string} md
 */
function shortVersion(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith('- **複審通過後、發射合併前'));
  assert.notEqual(start, -1, 'REVIEW-AND-MERGE.md 找不到「複審通過後、發射合併前」那條——最短可執行版被刪了');
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('>')) end++;
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
  // 所以它必須自己講清楚時機已經過了，不能只寫「請人代合併之前」。
  const pointer = rm.split('\n').find((l) => l.startsWith('>') && l.includes('Grok 複審後掃'));
  assert.ok(pointer, 'REVIEW-AND-MERGE 合併步驟開頭少了 Grok 複審後掃的指路句');
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

test('Grok 複審後掃｜過期標籤絆線：「程式線預設關門」不得復活（2026-08-16 轉常設後它就跟本節開頭直接打架）', () => {
  for (const f of ['AGENTS.md', 'REVIEW-AND-MERGE.md', 'CLAUDE.md']) {
    assert.ok(
      !visible(read(f)).includes('程式線預設關門'),
      `${f} 又出現「程式線預設關門」——那是轉常設前的狀態，與「程式線常設『複審後掃』」相反；`
        + '兩種相反答案並存時，只讀到其中一句的人會直接漏跑'
    );
  }
});

test('Grok 複審後掃｜CLAUDE.md 必須自己提一次（新 session 只保證讀到它；規則在別份檔案＝比規則晚出生的 session 讀不到）', () => {
  const claude = visible(read('CLAUDE.md'));
  assert.ok(claude.includes('Grok 複審後掃'), 'CLAUDE.md 沒提 Grok 複審後掃——新對話從頭到尾不會知道有這件事（#464 實測過同型漏跑）');
  assert.ok(
    claude.includes('轉正式之前'),
    'CLAUDE.md 提了 Grok 複審後掃但沒寫時機——只寫「要做」而不寫「什麼時候做」，做的人照樣會排到轉正式之後'
  );
});
