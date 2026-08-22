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
// 同時守一個更窄的東西：**指定字串各自在兩個自訂視窗裡出現**（不是「兩份檔案講同一件事」——
// 那句 r9 點名過，字串相同不等於講法一致）。病因是規則正本在 AGENTS.md，
// **真正被照著執行的是 REVIEW-AND-MERGE.md**（`merge-procedure-docs` 的檔頭診斷過同一個病：
// 規則在一份檔案、執行在另一份檔案 ⇒ 規則等於不存在）。2026-08-19 實測的漂移就是這型：
// 三個「漏了就整遍作廢」的條件，AGENTS 寫了三個、最短可執行版只抄了兩個
// ——照它做的人會產出一份 AGENTS 判定為「根本沒跑」的掃描，而他自己不會知道。
//
// ⚠️⚠️ 誠實劃界（**這一段被連續四輪審查各推翻一次，逐字照抄 Codex r4 給的版本**）
//
// 這一格我自己寫了四次，四次都寫大、四次都被實測當場推翻：
//   r1「證明兩份檔案講法一致」    → 字串相同不等於講法一致。
//   r2「不是程式碼範例裡的字」    → 被 blockquote 裡的 fence 推翻。
//   r3「除縮排式以外都涵蓋」      → 被巢狀 fence（四個反引號包三個）推翻。
//   r4「fence 判準是封閉集合、就四條、沒有第五條」
//                                  → 被三種容器語法推翻：list item 裡的 fence、
//                                    Setext 標題（用底線畫的 `----`）、沒有收尾的 `<!--`（吃到檔尾）。
// 第四次之後 William 裁示**停戰**（2026-08-21）：不再逐形補洞、也不裝 Markdown 解析套件，
// 改成把射程寫到剛好。**下面這段是 Codex r4 逐字給的版本，不要再自己潤飾放大。**
//
//   > 證明＝`grokSection(visible(...))` 與 `shortVersion(visible(...))` 回傳的**自訂文字視窗**
//   > 含指定字串，且驗屍腳本存在。**這不是完整的 GFM 解析**；不保證 GitHub 渲染後文字可見、
//   > 仍在現行規則區塊、或仍具規範效力。擷取所依賴的節首／節尾／bullet／相鄰 blockquote
//   > 形狀會被鎖住；**其餘 Markdown 容器與標題語法不在射程**。
//
// ⚠️ 上面引文裡「**相鄰 blockquote 形狀會被鎖住**」那半句**已被 r9 取代，不再是現行保證**
// （2026-08-21 Codex r10 點名）：實作只逐字比對 `>` 這個前綴，把相鄰前導改成 `>>` 照樣全綠。
// 引文原樣保留是為了留下來歷；**現行的精確版在下面「鎖了什麼」那一格**，以那一格為準。
//
// 講白話：**它只檢查題內明列的字串條件與擷取錨點，並檢查驗屍腳本存在。**
// **它不判斷命中的文字是不是現行規則、是不是仍具規範效力，也不解析完整 GFM。**
// 已跑過的突變只證明那些具體形狀會紅；其他未列形狀不在保證內。
// ⚠️ 上面白話版是 Codex r5 逐字給的（我 r4 自己寫的白話版又把射程放大了：說它「抓得到被搬走」，
// 而同一段下面才剛承認同視窗搬進存查附錄繞得過）。**不要再自己潤飾。**
//
//   ・**不證明**＝有沒有人真的跑過那一遍掃描。條文本身就寫著「沒有任何機械保證，全靠自律」，
//     這道考題不會、也不打算改變那件事——別把它讀成「有考題＝掃有在跑」。
//   ・**不證明那些字現在還算不算數**：字串考題讀不出語意。已實測繞得過的形狀（不完整清單）：
//     ①把「程式線＝常設『複審後掃』」改成「**不再**常設『複審後掃』」，語意整個反過來，
//       而 `includes('常設')` 照樣命中；②把承重的 bullet 搬進節內標著「已停用／存查」的附錄；
//     ③④⑤＝上面 r4 那三種容器語法；⑥**用 decoy 取代真句**：把承重那一行換成一句
//     同時含那兩個字串、但講的是別件事的話。⚠️ 射程在 r13 之後變窄了，照實記兩種：
//       ・decoy **沒有**沿用現行指示的錨點前綴 → **會紅**（時機那題的「列出的現行指示」
//         要求每個錨點前綴恰有一行，前綴不見就擋下來——不是靠 decoy 偵測，是副作用）；
//       ・decoy **連錨點前綴一起偽造** → **仍然綠**（2026-08-21 實測）。分辨哪一句是真的＝語意。
//     刻意**不**補否定詞偵測、更多容器正則與 decoy 偵測器——列舉繞法補不完。
//   ・**鎖了什麼**（這一格改口兩次：r4 原寫「不鎖節的長相」、r9 原寫「不鎖件數」，兩句都與程式相反）：
//     ①擷取器逐字比對的那幾個**前綴／哨兵字串**（節首、節尾哨兵、父節標題、bullet 前綴）；
//     ②那幾個錨點的**件數**——節首／父節／bullet 各自 `assert.equal(..., 1)`，多一份同形副本就紅。
//     ⚠️ 鎖的是**那幾個逐字前綴**，不是「長相」這種大話：把相鄰前導的 `>` 改成 `>>` 照樣綠
//     （2026-08-21 Codex r9 實測）。不鎖的是**字數、節有多長、以及任何語意**（鐵則 10）。
//   ・**機械射程**＝題內明列的字串條件與擷取錨點；其他改寫是否轉紅，不作保證。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 剝掉本函式辨識得到的 HTML 註解與 fenced code；這不是「哪些字仍在發號施令」的判定器。剝兩種：
 * ①HTML 註解——`merge-procedure-docs` r1 實測：只搜關鍵字的考題，用註解就繞得過。
 * ②fenced code——把一段規則包進 fence，畫面上它就從「你要照做的規則」變成「程式碼範例」，
 *   字面卻一個沒少（2026-08-19 Codex r1 實測 6/6 假綠）。
 *
 * ⚠️ fence 這一段的歷史：r1 用一條「欄首三個反引號」的正則 → r2 被「blockquote 裡的 fence」
 * 繞過去（那種每行前面有 `>`，欄首根本不是反引號）→ 補成狀態機 → r3 又被
 * 「四個反引號包三個反引號、收尾帶尾字」繞過去（`grok-scan-docs` r3，Codex 實測 GitHub
 * 渲染後那句已是程式碼範例，而狀態機提早收了 fence，把它當成還在發號施令）。
 *
 * **一次補一種形狀補不完**（本 repo `test/contract-split.test.js` r7–r12 同型的結論：
 * 要嘛照規格做完整、要嘛老實說看不出來）。r4 曾把下面四條當成「封閉集合、沒有第五條」——
 * ⚠️ **那句話是錯的，Codex r4 當場用三種容器語法推翻**（list item 裡的 fence／Setext 標題／
 * 沒收尾的 `<!--`）。真正的「做完整」＝一整套會互相巢狀的 block grammar，那要真正的解析器。
 * William 2026-08-21 裁示**停戰**：下面四條留著（它們確實擋掉了幾種常見形狀），
 * 但**不再往下補**，射程照實寫在檔頭。四條是：
 *   ①開頭＝連續 3 個以上的 ` 或 ~（前面最多 3 個空白）
 *   ②反引號框的資訊字串裡不准再有反引號，否則它根本不算開頭
 *   ③收尾必須是**同款**記號
 *   ④收尾的長度要**大於等於**開頭，而且後面只能是空白
 * 這四條是**本函式採用的 fence 判準**，不是「再補一種繞法」。
 * ⚠️ 不要讀成「這四條就是規格本身」——完整的 block grammar 比它大得多（見上一段），
 * 那句話 2026-08-21 Codex r11 點名，已改口。
 *
 * ⚠️ 只剝 fenced，**不剝行內反引號**——條文本來就用行內 code 標指令與固定字串，剝掉會把承重的字一起剝掉。
 * ⚠️ **已知不涵蓋、也不打算涵蓋：縮排式程式碼區塊（四個空白起跳）。** 在這幾份檔案裡它跟
 * 一般的縮排續行長得一樣（條文大量使用 2–4 空白續行），硬要分會誤殺真規則。
 * 這一格照實劃界：**這種寫法本檔看不出來**，不假裝守得住。
 */
function visible(/** @type {string} */ md) {
  const out = [];
  let fence = null;   // { ch, len }；null＝不在 fence 裡
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    // 剝掉 blockquote 標記再看——`> ``` ` 在畫面上一樣是 fence（r2 的繞法）
    const line = raw.replace(/^(\s*>)+\s?/, '');
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      // ②反引號框的資訊字串不准含反引號（``` x` 之類根本不是開頭）
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) { fence = { ch: m[1][0], len: m[1].length }; continue; }
      out.push(raw);
    } else if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') {
      fence = null;   // ③同款 ④長度夠且後面只有空白
    }
  }
  return out.join('\n');
}

/**
 * 抓 AGENTS.md 的「Grok 的邊界」節：從節首那行，到**逐字等於 `**⚠️ 協作的唯一不變量` 開頭的那一行**為止。
 * 不用行號、不用固定行數——那些一改就漂。
 * ⚠️ 收尾**只認那一個哨兵字串**，不是「下一個粗體段落標題」（r9 點名的放大句）：
 * 在中間插一顆別的粗體段落（例如 `**已停用存查**`）並把承重字串搬進去，這裡照樣抓到大範圍。
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
      + '擷取只取第一處，所以多一份同形節首＝這道考題不知道自己在讀誰；因此這裡直接擋下來'
  );
  const start = starts[0];
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('**⚠️ 協作的唯一不變量')) end++;
  assert.notEqual(end, lines.length, 'AGENTS.md 抓不到「Grok 的邊界」節的結尾（下一節「協作的唯一不變量」不見了）');
  return lines.slice(start, end).join('\n');
}

/**
 * 抓 REVIEW-AND-MERGE.md 的最短可執行版：從那顆 bullet 到**下一個 blockquote 或下一個 ATX 標題**（`#` 開頭）為止。
 * ⚠️ **只認 ATX**：用底線畫的 Setext 標題收不到——那正是檔頭已列的已知盲點之一。
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
  // 在那顆 bullet 前面插一個同級標題「### 已停用存查」，最短可執行版就不在那一節裡了，
  // 而全檔 findIndex 照樣找得到 ⇒ 六題全綠。
  // ⚠️ 這裡刻意不寫「有幾處指路指著這一節」（鐵則 10：會漂；而且這道考題根本沒守那件事——
  // 刪掉其中一處指路，六題照樣全綠。2026-08-21 Codex r9 實測）。
  // ⚠️ 父節**自己**也要先驗唯一（2026-08-19 Codex r3 實測）：r2 只驗了 bullet 在選中的父節裡唯一，
  // 於是在現行節前面插一個「### 怎麼執行（已停用存查）」、裡面放一份合格的短版，
  // 再把真正現行那節還原成舊時機 ⇒ 讀到的是存查副本，六題全綠。
  const secStarts = allLines.map((l, i) => (l.startsWith('### 怎麼執行') ? i : -1)).filter((i) => i !== -1);
  assert.notEqual(secStarts.length, 0, 'REVIEW-AND-MERGE.md 找不到「### 怎麼執行」節——條文有指路指著它，改名要一起改');
  assert.equal(
    secStarts.length, 1,
    `REVIEW-AND-MERGE.md 有 ${secStarts.length} 個「### 怎麼執行」節（第 ${secStarts.map((i) => i + 1).join('、')} 行）——`
      + '擷取只取第一個，所以多一個同形父節＝這道考題不知道自己在讀誰；因此這裡直接擋下來'
  );
  const secStart = secStarts[0];
  let secEnd = secStart + 1;
  while (secEnd < allLines.length && !/^#{1,3} /.test(allLines[secEnd])) secEnd++;
  const lines = allLines.slice(secStart, secEnd);

  const starts = lines.map((l, i) => (l.startsWith('- **複審通過後、') ? i : -1)).filter((i) => i !== -1);
  assert.notEqual(
    starts.length, 0,
    'REVIEW-AND-MERGE.md 的「### 怎麼執行」節裡找不到「複審通過後、…」那條——'
      + '最短可執行版被刪了，或被搬出那一節'
  );
  assert.equal(starts.length, 1, `「### 怎麼執行」節裡有 ${starts.length} 條「複審通過後、…」——擷取只取第一條，所以這裡直接擋下來`);
  const start = starts[0];
  let end = start + 1;
  while (end < lines.length && !/^(>|#{1,6} )/.test(lines[end])) end++;
  assert.notEqual(
    end, lines.length,
    'REVIEW-AND-MERGE.md 抓不到最短可執行版的結尾（後面既沒有 blockquote 也沒有 ATX 標題）——'
      + '若放行下去，視窗會一路吃到檔尾、斷言在錯的範圍裡命中——所以這裡先擋；這道考題要跟著更新'
  );
  return lines.slice(start, end).join('\n');
}

// 三個「漏了就整遍作廢」的條件。**這道題檢查的是：這三個字串在兩個視窗裡都要有。**
// 為什麼挑「同一個字串」而不是「同樣的意思」：換句話說就是換一種講法，讀的人分不出
// 是不是同一條規則、也 grep 不到。⚠️ 但它**不要求兩份的條文逐字相同**——在其中一份的
// 條件後面加一句補語，兩份已經不一樣了，這道題照樣綠（2026-08-21 Codex r8 實測）。
// 〔這一行改口過兩次：原寫「逐字相同才算兩份檔案講同一件事」（r2 點名：字串相同 ≠ 講法一致）、
// 再寫「這裡要求兩份檔案逐字相同」（r8 點名：實作根本沒要求逐字相同）。〕
const KILL_CONDITIONS = ['版本不同＝當未跑', '退出碼非 0＝該掃作廢', '缺這一行＝當未跑'];

test('Grok 複審後掃｜三個失效條件的字串，兩個視窗裡都要有（2026-08-19 實測漂移：時序那條只寫在正本）', () => {
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

test('Grok 複審後掃｜時機：AGENTS 正本與 REVIEW 最短版把「通過」和「轉正式之前」綁在同一行；合併步驟前導寫「轉正式之前」；列出的現行指示不得出現三個舊時機字面', () => {
  const rm = read('REVIEW-AND-MERGE.md');
  const READY = '`gh pr ready` 轉正式之前';
  // ⚠️ 不能只查新字串**在**（2026-08-21 Grok 掃到、我自己重現過的兩發）：
  //   3(a) 只要新字串還在，把舊時機字面加回去，六題全綠——「兩種相反答案並存」正是
  //        Test 5 已經為「程式線」防住、卻沒為「時機」防住的同一個病。**這次補上反面絆線。**
  //   3(b) 沒有任何一題把時機綁在**「通過」之後**：把那半句整段拿掉、甚至改回「送審前」，
  //        六題全綠——本條存在的理由整段被拆掉也不響。**這次要求同一行同時出現「通過」。**
  /** 時機那一句必須**同一行**同時出現「通過」與 READY——只查 READY 等於沒守住「通過之後」。 */
  const timingLine = (/** @type {string} */ text, /** @type {string} */ where) => {
    const hit = text.split('\n').find((l) => l.includes(READY) && l.includes('通過'));
    assert.ok(
      hit,
      `${where} 沒有一行同時出現「通過」與「${READY}」——`
        + '只寫「轉正式之前」而不綁「通過之後」，時機可以整段改回「送審前」而這道考題不會紅；'
        + '而「通過已經留在紀錄上、之後撈到的才是複審漏的」正是本條存在的唯一理由'
    );
  };
  timingLine(grokSection(visible(read('AGENTS.md'))), 'AGENTS「Grok 的邊界」節');
  timingLine(shortVersion(visible(rm)), 'REVIEW-AND-MERGE 最短可執行版');

  // 合併步驟開頭那句指路——它是給「翻到合併步驟才第一次看到這件事」的人看的，
  // 所以它①必須在**被選中的那個**合併步驟 block 的前導（搬到檔案別處＝那個人看不到）
  //   ②必須含「轉正式之前」這四個字——⚠️ **只查這四個字，不查它有沒有把時機講清楚**：
  //     整段縮成「Grok 複審後掃：轉正式之前。」照樣綠（2026-08-21 Codex r9 實測）
  // ③必須不在**本檔辨識得到的** HTML 註解／fence 裡（註解掉＝讀的人一個字都看不到）。
  //   ⚠️ 不是「渲染得出來的字」——那比 `visible()` 的射程大，見檔頭劃界。
  // ⚠️ 三件都是 2026-08-19 預審實測過的繞法：原版用整份原文 find，三種都能靜靜通過。
  const lines = visible(rm).split('\n');
  // ⚠️ 這裡只把 findIndex 選中的第一個「合併也由 Codex 代執行」block 當作合併步驟；不保證它是現行區塊。
  const mergeSteps = lines.findIndex((l) => l.startsWith('>') && l.includes('合併也由 Codex 代執行'));
  assert.notEqual(mergeSteps, -1, 'REVIEW-AND-MERGE.md 找不到合併步驟區塊（「合併也由 Codex 代執行」）——這道考題要跟著更新');
  // 前導＝**緊鄰合併步驟的前一段**：往上跳過空行，再把連續的 `>` 收成一塊。
  // ⚠️ 不是「必須是 blockquote」（2026-08-21 Grok 指出的措辭不符）：若緊鄰那一行不是 `>`，
  //    它仍會把**那單獨一行**當前導。射程比「blockquote」寬，也比它窄。
  // ⚠️ 不能用「往回找到上一個標題」來夾範圍：合併步驟**上方最近的標題是檔案第 1 行的 H1**，
  //    於是那種寫法的範圍等於「檔案開頭到合併步驟」，把指路句搬到第 3 行照樣算過（r2 突變 M2d 實測）。
  //    〔原本這裡寫「第一個標題在合併步驟之後」——那是假的，2026-08-21 Codex r9 點名。〕
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
  assert.ok(
    pointer.includes('通過'),
    '合併步驟的指路句沒寫出「通過」——只寫「轉正式之前」時，把「Codex 通過之後、」刪掉這道考題不會紅'
      + '（2026-08-21 Codex r13 實測），而「通過已留在紀錄上」正是本條存在的唯一理由'
  );

  // ⚠️ 反面絆線**只掃下面列出的現行指示**（刻意不寫幾處——寫死當場就會過期，
  // r14 補第五處時原本那句「四處」立刻變成假話），不掃整份檔案（2026-08-21 Codex r13 實測：
  // 只在 CLAUDE.md 末尾加一行「歷史記錄：舊版曾寫『請人代合併之前』。」，現行指示完全不動，
  // 整份掃描版本就由 6/6 變 5/6 ＝ **誤殺沿革文字**。沿革本來就該保留舊字面，那是來歷不是指令）。
  const OLD_TIMINGS = ['請 Codex 執行合併之前', '發射合併前', '請人代合併之前'];
  const one = (/** @type {string} */ file, /** @type {string} */ prefix) => {
    const hits = visible(read(file)).split('\n').filter((l) => l.startsWith(prefix));
    assert.equal(hits.length, 1, `${file} 裡以「${prefix}」開頭的行有 ${hits.length} 行（需恰好 1）——這道考題要跟著更新`);
    return hits[0];
  };
  /** 整顆 bullet（含續行）——「省額度慣例」那條的時機寫在第二行，只取首行會漏。 */
  const oneBlock = (/** @type {string} */ file, /** @type {string} */ prefix) => {
    const lines = visible(read(file)).split('\n');
    const starts = lines.map((l, i) => (l.startsWith(prefix) ? i : -1)).filter((i) => i !== -1);
    assert.equal(starts.length, 1, `${file} 裡以「${prefix}」開頭的區塊有 ${starts.length} 塊（需恰好 1）——這道考題要跟著更新`);
    const start = starts[0];
    let end = start + 1;
    while (end < lines.length && !/^(?:- |#{1,6} )/.test(lines[end])) end++;
    return lines.slice(start, end).join('\n');
  };
  const CURRENT_DIRECTIVES = [
    ['AGENTS 複審後掃條', one('AGENTS.md', '- **複審後掃（')],
    ['CLAUDE.md 入口句', one('CLAUDE.md', '- **你實作的 PR：')],
    ['REVIEW 最短可執行版開頭兩行', shortVersion(visible(rm)).split('\n').slice(0, 2).join('\n')],
    ['合併步驟指路句', pointer],
    // ⚠️ 第五處：「省額度慣例」那條不是沿革，它直接規定「通過 → 先做 Grok → ready」。
    // 收斂射程時漏了它（2026-08-21 Codex r14 實測：只把那條改成「請人代合併之前」，
    // 其餘不動，六題仍全綠 ⇒ 兩種相反時機重新並存）。
    ['REVIEW 省額度慣例條',
      oneBlock('REVIEW-AND-MERGE.md', '- **開 PR 一律 `--draft`；')],
    // ⚠️ 第六處：角色分工表那一列是**現行**的（不是 archive），它直接把程式線角色寫成
    // 「由預審改序為複審通過後才掃」。只把它改成舊時機、其餘不動，六題仍全綠
    // （2026-08-22 Codex r15 實測）。
    ['AGENTS 角色分工 Grok 列',
      one('AGENTS.md', '| Grok |')],
  ];
  for (const [where, text] of CURRENT_DIRECTIVES) {
    for (const old of OLD_TIMINGS) {
      assert.ok(
        !text.includes(old),
        `${where}出現舊時機「${old}」——只要新字串也還在，兩種相反答案就並存；`
          + '只讀到舊那半句的人會在合併前才掃，每修一條多燒一次全卷 CI（那正是這次改時機要關掉的路）'
      );
    }
  }
});

test('Grok 複審後掃｜固定小標 `### Grok 複審後掃`：條文釘它、PR 範本要真的吐得出這個字串', () => {
  const HEADING = '### Grok 複審後掃';
  assert.ok(
    grokSection(visible(read('AGENTS.md'))).includes(`\`${HEADING}\``),
    'AGENTS「Grok 的邊界」節不再釘住固定小標——約定的 grep key 一旦不見，'
      + '日後就不能再用它可靠翻表（#483 記成零分的根因；換成另一個固定 key 也行，但兩份要一起改）'
  );
  const tpl = visible(read('.github/pull_request_template.md'));
  assert.ok(
    tpl.split('\n').some((l) => l.trim() === HEADING),
    `PR 範本裡沒有整行等於「${HEADING}」的小標（註解裡寫不算數）——範本與條文對不上約定的 grep key，日後就不能再用它可靠翻表`
  );
});

test('Grok 複審後掃｜驗屍腳本的**路徑字串**要出現在兩個自訂視窗裡，且那支檔案真的存在（全檔搜尋會被「歷史檔名存查」那種句子矇混）', () => {
  const SCRIPT = 'scripts/audit-grok-scan.js';
  // ⚠️ 不可以用全檔 includes（2026-08-19 Codex r3 實測）：把**被選中的文字視窗**裡的命令
  // 改成不存在的腳本、只在檔案開頭各留一句「歷史檔名存查：`scripts/audit-grok-scan.js`」，
  // 全檔搜尋照樣命中而考題全綠。要綁在**兩個自訂文字視窗**裡。
  // ⚠️ 兩件事本檔**不保證**：①視窗是不是現行區塊（見檔頭劃界）；
  // ②視窗裡那個路徑**是不是正式命令**——把命令改成別的腳本、只在同一個視窗裡留一句
  // 「已停用舊檔：scripts/audit-grok-scan.js」，這題照樣綠（2026-08-21 Codex r11 實測）。
  // 它證明的是「路徑字串出現在視窗裡」＋「repo 裡那支檔案存在」，不是「視窗指向它」。
  assert.ok(
    grokSection(visible(read('AGENTS.md'))).includes(SCRIPT),
    `AGENTS「Grok 的邊界」視窗裡沒有出現 ${SCRIPT} 這個路徑字串（視窗外提到不算）`
  );
  assert.ok(
    shortVersion(visible(read('REVIEW-AND-MERGE.md'))).includes(SCRIPT),
    `REVIEW-AND-MERGE 最短可執行版視窗裡沒有出現 ${SCRIPT} 這個路徑字串（視窗外提到不算）`
  );
  assert.ok(existsSync(join(ROOT, SCRIPT)), `${SCRIPT} 不存在——兩個視窗裡都寫著這個路徑，而 repo 裡沒有這支檔案`);
});

test('Grok 複審後掃｜程式線的定位：那兩個舊字串形狀不得出現，且節內**恰有一顆**「程式線」bullet、上面還留著「常設」「複審後掃」（查字不查語意）', () => {
  // ⚠️ 2026-08-19 預審抓到的假綠：絆線原本只搜「程式線預設關門」，
  // 但 AGENTS 原標題實際寫的是「程式線＝預設關門」（**中間有全形等號**）——
  // 於是這支 PR 最核心的那處修正可以整行逐字還原，而考題全綠。
  // 修法兩層：①反面絆線改成涵蓋有無等號兩種形狀 ②加一道**正面**斷言。
  // ⚠️ 正面斷言證明的只是「這兩個詞還在那一行上」——**不證明那一行還在講同一件事**：
  // 改成「不再常設『複審後掃』」語意整個反過來，這一題照樣綠（Codex r1 實測）。
  // 它擋的是「整句被換成不提常設的第三種寫法」，擋不了否定詞；後者交給複審者。
  // ⚠️ 只抓這兩種字面（中間零空白、等號可有可無）——**不是「舊語意不得復活」**：
  // 寫成「程式線 ＝ 預設關門；常設『複審後掃』已停用」照樣綠（2026-08-21 Codex r9 實測）。
  const STALE = /程式線[＝=]?預設關門/;
  for (const f of ['AGENTS.md', 'REVIEW-AND-MERGE.md', 'CLAUDE.md']) {
    assert.ok(
      !STALE.test(visible(read(f))),
      `${f} 又出現「程式線（＝）預設關門」——那是 2026-08-16 轉常設前的狀態，與「程式線常設『複審後掃』」相反；`
        + '兩種相反答案並存時，只讀到其中一句的人會直接漏跑'
    );
  }
  const section = grokSection(visible(read('AGENTS.md')));
  // ⚠️ 這裡也要驗唯一（2026-08-21 Grok 指出的不對稱）：節首／父節／短版 bullet 都有
  // assert.equal(..., 1)，這一顆當時沒有。多一顆同形 bullet 就讓定位不唯一——
  // 上面插一顆也含「常設」「複審後掃」的 decoy、下面那顆改成別的意思，就能把真的藏掉，
  // 所以現在多一顆就直接擋下來。
  const bullets = section.split('\n').filter((l) => l.startsWith('- **程式線'));
  assert.notEqual(bullets.length, 0, 'AGENTS「Grok 的邊界」節裡找不到「程式線」那顆 bullet');
  assert.equal(
    bullets.length, 1,
    `AGENTS「Grok 的邊界」節裡有 ${bullets.length} 顆「程式線」bullet——多一顆同形 bullet 就讓定位不唯一，因此直接擋下來`
  );
  const bullet = bullets[0];
  assert.ok(
    bullet.includes('常設') && bullet.includes('複審後掃'),
    '唯一那顆「程式線」bullet 上沒有同時出現「常設」與「複審後掃」——'
      + '這題只檢查那唯一一顆；反面絆線只檢查舊字串本身，'
      + '那唯一一顆改成第三種不提常設的寫法時，才由這一道轉紅。'
      + '（⚠️ 這一道只查字在不在，查不出語意：寫成「不再常設」它照樣過。）'
  );
});

test('Grok 複審後掃｜CLAUDE.md **恰有一行**同時出現「Grok 複審後掃」與「轉正式之前」（新 session 只保證讀到 CLAUDE.md）', () => {
  // 兩個字串各查各的會被「散在兩個無關 bullet」蒙混過去（2026-08-19 預審抓到）——綁同一行。
  // ⚠️ 綁的是**同一行**，不是「同一句」：同一行放兩句不相干的話照樣綠（Codex r9 實測）。。
  // ⚠️ 同樣要驗唯一（2026-08-21 Grok 指出）：不驗唯一時，前面插一行不相干但同時
  // 含這兩個詞的話，就能把後面真正那條藏掉，所以多一行就直接擋下來。
  // （⚠️ 擋不住「decoy 取代真句」——那一顆列在檔頭已知繞法清單裡。）
  const hits = visible(read('CLAUDE.md')).split('\n')
    .filter((l) => l.includes('Grok 複審後掃') && l.includes('轉正式之前'));
  assert.notEqual(
    hits.length, 0,
    'CLAUDE.md 沒有一行同時出現「Grok 複審後掃」與「轉正式之前」——'
      + '⚠️ 這一題只查這兩個字串在不在同一行，**查不出那一句有沒有把時機講清楚**（Grok 掃到）；'
      + '它防的是「只寫要做、完全不提時機」那種寫法（#464 實測過同型漏跑）；'
      + '而 CLAUDE.md 是唯一保證每個 session 都讀到的入口，規則只寫在別份檔案＝比規則晚出生的 session 讀不到'
  );
  assert.equal(
    hits.length, 1,
    `CLAUDE.md 有 ${hits.length} 行同時出現這兩個字串——多一行就讓定位不唯一，因此直接擋下來（decoy 能把真正那條藏掉）`
  );
});
