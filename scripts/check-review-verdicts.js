#!/usr/bin/env node
// @ts-check
// **複審結論的聯集閘**（William 2026-08-02 定）。
//
// ## 這支在解什麼
//
// 2026-08-02 實測：#383 上出現**兩份都自稱「Claude 複審」的結論，而且相反**——
// 一份寫「通過，可以合併」，一份寫「需修改後再審」。GitHub 上兩則都顯示 `teacherjung`，
// **沒有任何辦法分辨誰寫的**（三方共用同一個帳號，而且每邊的桌面 session 還會各自
// 用 CLI 起另一個 session：Claude 桌面／Claude CLI／Codex 桌面／Codex CLI 至少四個）。
//
// 兩份其實都對，只是**照的地方不同**：一份查版面與結構（手機 flex、selector、sticky），
// 一份查金額口徑與資料列格數。危險的不是有兩份，是**看起來一樣有效而結論相反**，
// 於是「最後一則說通過」就變成事實上的放行。
//
// ## 兩條規則（本支實作的就是這兩條）
//
// ①**自報來歷**：每一則帶結論的複審留言，第一行必須是機器讀得懂的來歷標頭。
// ②**取聯集**：任何審查者的阻擋結論，在**同一個審查者**用更新的 commit 撤銷之前都有效。
//    「通過」**不會**抵銷另一個審查者的「需修改」——沒有「最後一則說了算」這種事。
//
// ## 誠實劃界
//
// 它讀的是**留言裡的自我宣告**，不是身分證明。一個要繞過它的協作者，
// 直接改頭標裡的 `來源` 就好——那要靠獨立 GitHub 帳號才擋得住（見
// `docs/GitHub分支保護-設定與驗證.md` 的「第二步：分身分」）。
// 它防的是**混淆與遺漏**，不是惡意。
//
// 退出碼：
//   0＝複審結論通過（有人對目前 head 說「通過」，且沒有未撤銷的阻擋）
//   1＝**複審結論未通過**——三種情形：①有未撤銷的阻擋 ②沒有任何針對目前 head 的正式通過
//      ③有留言用了 🤖 但標頭寫壞。（原本只寫「有未回應阻擋」，那是失真的——Codex #385 r2 Low）
//      ⚠️ 「疑似結論卻沒帶標頭」**只印提醒、不影響退出碼**（r11 起，理由見 looksLikeVerdict）
//   2＝查不清楚（fail-closed，比照協作欄位閘）
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fieldValue, canonicalRole } from './check-pr-collab-fields.js';

/**
 * **這支是合併程序的一道機械閘**——`test/collab-invariant-docs.test.js` 靠這個標記
 * 反查「現在到底有幾道閘」，再要求文件把每一道都點名得出來。
 *
 * ⚠️ 別把清單手寫在考題裡（Codex #385 r9／r10）：手寫的漂過一次（加了第四道閘、
 * 文件仍寫三道，考題全綠看不見），改成從散文反查又被證明可繞（lazy continuation、
 * 檔名含數字、乾脆不寫進步驟）。**真相放在閘自己身上**，加一支就一定被數到。
 */
export const MERGE_GATE = { name: '複審結論取聯集', why: '任一審查者的阻擋未被同一位撤銷前都有效' };

/** 結論用詞 → 是不是阻擋。**只認這三種**，寫別的等於沒下結論（→ 查不清楚）。 */
export const VERDICTS = {
  通過: false,
  需修改後再審: true,
  不可合併: true,
};

/**
 * 來歷標頭。**刻意是可見的一行，不是 HTML 註解**——
 * 註解在畫面上看不見，而今晚已經有三次「藏在註解裡就繞過去了」的實例。
 *
 * 格式（逐字）：
 *   🤖 <角色>｜來源：<哪個 session>｜審 `<短 sha>`｜r<輪次>｜結論：<三選一>
 */
// ⚠️ **不接受 `>` 引用與 `-` 列表前綴**（Codex #385 r1 Medium④）：
//    引用別人的標頭不該被算成一則新結論。只容許粗體包裝與水平空白。
// ⚠️ **維護邊界**（Codex #385 r12 記錄用，今天三個角色都不受影響）：
//    角色用 `[A-Za-z]+` 抓，所以未來若出現含數字、連字號或非拉丁字母的角色名，
//    這裡會先擋掉（而不是交給 `canonicalRole()` 判）。新增角色時要一起看這個字元集。
//    另外 trailer 的文件與考題目前硬驗 `William`，還沒有從 `ROLES` 雙向同步。
const HEADER = /^[^\S\n]*(?:\*\*|__)?[^\S\n]*🤖\s*([A-Za-z]+)｜來源：([^｜]+)｜審\s*`?([0-9a-fA-F]{7,40})`?｜r(\d+)｜結論：(\S+?)(?:\*\*|__)?\s*$/mu;

/**
 * 從一則留言抽出來歷標頭。抓不到就回 null（呼叫端決定那算不算問題）。
 * @param {string} body
 */
export function headerOf(body) {
  const first = String(body || '').split('\n').find((l) => l.trim()) || '';
  const m = HEADER.exec(first);
  if (!m) return null;
  const verdict = m[5].replace(/[。．.]$/u, '');
  // ⚠️ `in` 會命中原型鍵（`toString`／`constructor` 都會被當成合法的第四種結論）——
  //    本專案的原型鍵鐵則，我在自己的新腳本裡又犯一次（Codex #385 r1 Medium⑤）。
  if (!Object.hasOwn(VERDICTS, verdict)) return null;
  // ⚠️ **來源不可以是空白**（Codex #385 r4 High①）：兩個 session 都漏填來源時，
  //    正規化後都變成 `Codex（）`＝同一位審查者 ⇒ 第二個 session 的「通過」
  //    就撤銷了第一個的阻擋——**#383 的核心病原樣重現**。
  if (!m[2].trim()) return null;
  // ⚠️ **角色要走 `canonicalRole()`，不能收任意英文字**（Codex #385 r11）：
  //    原本 `[A-Za-z]+` 照單全收，於是打錯字的 `Codeex` 會被當成**另一位正式審查者**——
  //    它喊的停，正確的 `Codex` 說「通過」永遠撤銷不掉（同一位審查者才能撤銷），
  //    變成一條**幽靈阻擋**；而且因為標頭「合法」，連 `hasBotMark()` 都不會點名它是壞標頭。
  const role = canonicalRole(m[1]);
  if (!role) return null;
  return {
    role,
    // 來源做 collapse whitespace：多打一個空白不該變成「另一個審查者」（那會多出一條永遠撤不掉的阻擋）
    source: m[2].trim().replace(/\s+/gu, ' '),   // 非空由下方 headerOf 尾端把關
    sha: m[3].toLowerCase(),
    round: Number(m[4]),
    verdict,
    blocking: VERDICTS[/** @type {keyof typeof VERDICTS} */ (verdict)],
  };
}

/** 「結論」這件事的各種叫法。這一組**小而穩定**，不是在列舉結論的內容。 */
const MARKER = '(?:結論|審查結果|複審結果|審查結論|複審結論|複審完成|審查完成)';
/** 「結論三選一：」「三選一結論：」「結論（三選一）：」——**引出**結論的標籤句型。 */
const LABEL = new RegExp(`${MARKER}[^：:\\n]{0,6}[：:]`, 'u');
/** 標題裡光是提到「結論」就算在下結論（標題不需要冒號）。 */
const MARKER_RE = new RegExp(MARKER, 'u');
/**
 * **對「合併」下許可判斷**。
 * 尾端的 `(?![：:])` 是關鍵：`不可合併：兩個 state 要分開存` 是在**替某個狀態命名**，不是結論。
 */
const MODALITY = '(?:可以|可否|能否|不能|不可以|不可|不宜|不建議|建議|暫不可|暫不|尚不可|還不能|可)';
// ⚠️ `(?!…)` 裡的 `\s*` 是 Codex #385 r9 補的：`不可合併 two reviewer states` 的受詞前有空格，
//    原本只擋「緊接著」的受詞，隔一個空格就繞過去了——**又是同一種邊界漏洞**。
const MERGE_RULING = new RegExp(`${MODALITY}\\s*(?:直接\\s*)?合併(?![：:]|\\s*[\\p{L}\\p{N}])`, 'u');
/** 某一行**以結論用詞開頭**、之後句子就結束或接標點（冒號除外——那是標籤句型）。 */
const STARTS_WITH_VERDICT = new RegExp(
  // ⚠️ `／`、`、`、`/` 不算「句子結束的標點」（Codex #385 r10）：
  //    `通過／失敗：25／0` 是每份測試報告都會寫的統計句，不是結論。
  `^(?:${Object.keys(VERDICTS).join('|')})(?:\\s*$|\\s*[^\\p{L}\\p{N}\\s：:／、/])`, 'u');

/**
 * 這則留言**想用來歷標頭但寫壞了**——判準是出現 `🤖`（剝掉引用與 code 之後）。
 *
 * ⚠️ 這是**唯一還留在阻擋路徑上的文字判斷**，因為它的誤判面極小：
 * 一則正文出現 `🤖` 的留言，幾乎不可能不是在試這個格式。
 * 而它擋的是真實會發生的事——標頭打錯一個字，整則結論就被無視。
 * @param {string} body
 */
export function hasBotMark(body) {
  return stripFencesLoose(String(body || ''))
    .replace(/^[^\S\n]*>.*$/gm, '')
    .split('\n')
    .some((l) => /🤖/u.test(l.replace(/(`+)[^`]*\1/gu, '')));
}

/**
 * 一則留言看起來是不是「有人在下結論」——用來抓「下了結論卻沒有合規標頭」的漏網。
 *
 * ## ⚠️ 先講清楚它在這道閘裡的位置：**它不是判準，是提示**
 *
 * 放行的判準只有一條，而且**不依賴這個函式**：
 * 「對目前 head，有一則**合規標頭**的『通過』，來自 PR 指定的獨立審查者，且沒有未撤銷的阻擋。」
 * 沒有標頭的留言對這道閘**沒有效力**——既不能放行，也不算撤銷。
 * 所以就算這個函式一個字都沒抓到，#383 那個場景（兩則相反的無標頭複審）照樣被擋
 * ——擋它的是「沒有任何合規標頭的通過」，不是這個函式。
 *
 * 這個函式要防的是另一件事：**有人以為自己喊了停，但因為沒帶標頭而被無視。**
 * 它命中時**只印一則提醒，不影響退出碼**——r11 起刻意如此，理由是兩個方向的代價完全不對稱：
 *   ・**漏抓**：不會讓無標頭的留言取得任何效力，只是少掉一句提醒。**不是安全問題。**
 *   ・**誤擋**：會機械性擋住合併，**相對 `main` 是實質退步**（原本人工確認不會卡住那些留言）。
 * 而它連兩輪被 Codex 實測出誤擋正常留言（`## 如何合併兩個 reviewer state`、`通過／失敗：25／0`…），
 * 其中三個還是我上一輪「修誤擋」時新造出來的。
 * ⇒ **一個零安全價值、卻持續製造退步的阻擋條件，不該是阻擋條件。**
 * 唯一還留在阻擋路徑上的文字判斷是 `hasBotMark()`（見上）。
 *
 * ## 判準倒過來：偵測「下結論這個動作」，不是比對「結論寫成什麼字」
 *
 * Codex 拿**它自己寫過的 25 份報告**當語料，連兩輪打穿：r7 抓到 9/25、r8 抓到 14/25。
 * 漏掉的全是它前一天寫的正常措辭（「三選一結論：⚠️ 修正後再審。」「目前不建議合併」
 * 「4. 不可以合併。」「可以合併。」）。**那是同一個錯的第七、第八次：我在列舉措辭。**
 *
 * 現在的五種訊號都是**結構**，跟措辭無關：
 *   (1) 出現 `🤖`——想用這個格式卻寫錯
 *   (2) **標題**提到結論或合併：標題問「可以合併嗎？」＝這則要回答它（內文問才是真的在問人）
 *   (3) `結論…：` 這種**引出**結論的標籤句型
 *   (4) 對「合併」下**許可判斷**（可以／不可以／不建議／暫不可…），且前面沒有別的標籤引出它
 *   (5) 某一行**以結論用詞開頭**、之後句子就結束或接標點（冒號除外＝標籤句型）
 *
 * ## 誠實劃界
 *
 * 現在對 `test/fixtures/review-verdict-corpus.json` 是 **25/25 正例、0 誤擋**——
 * 那份語料是真的（25 份報告原文＋3 則真實非結論留言），不是我挑的代表例
 * （**r8 的題目寫「25 份」卻只放 6 個代表例，那本身就是假綠**）。
 * 擋不住的：完全不提「合併」也不寫「結論」的結論（例如只寫「LGTM」）。
 * 那種漏抓**不會造成 #383**（判準那條還在），只會少一句提醒。
 * 反方向：討論這道閘本身時，若在標題寫「結論」或在內文寫「可以合併」，會被要求補標頭
 * ——Codex 自己評估這個代價可以接受（#385 r8），改個字或補標頭即可。
 * @param {string} body
 */
export function looksLikeVerdict(body) {
  const text = stripFencesLoose(String(body || ''))
    .replace(/^[^\S\n]*>.*$/gm, '');       // 引用別人的話不是自己的結論

  /** 去掉行內 code：**任意長度的反引號**都算。 */
  const noCode = (/** @type {string} */ l) => l.replace(/(`+)[^`]*\1/gu, '');
  // ⚠️ 粗體要在判斷前剝掉（真實語料抓到的）：#383 那則「## Claude 第二輪獨立複審」
  //    把結論寫成 `**結論：通過，可以合併。**`，前面是 `**` 而不是行首 ⇒ 邊界對不上就整則看不見。
  //    **那正是造成 #383 的兩份相反複審之一。**
  const lines = text.split('\n').map((l) => noCode(l).replace(/[*_]/gu, ''));

  if (hasBotMark(body)) return true;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 標題：**不要求冒號**（`## 三題結論` 是真實原文），問句也算
    //（`## 3. 可以合併嗎？` 後面接的就是答案——標題在問，等於這則要回答它）
    // ⚠️ 標題不可以只看「有沒有合併兩個字」（Codex #385 r9）：
    //    `## 如何合併兩個 reviewer state` 是正常的技術標題，被擋掉會真的卡住合併。
    //    標題也要吃「後面接受詞」那道分辨（Codex #385 r10）：
    //    `## 為什麼不可合併兩個 reviewer state` 是技術標題，不是結論。
    if (/^#{1,6}\s/u.test(line)
      && (MARKER_RE.test(line) || MERGE_RULING.test(line) || /合併(?:嗎|與否)/u.test(line))) return true;
    if (/[？?]\s*$/u.test(line)) continue;   // 內文的問句是在問人，不是在下結論
    // ⚠️ 引號裡的裁決**通常**是在講那個詞，但**不是絕對**（Codex #385 r9 兩個方向都給了例子）：
    //    「腳本遇到『不可合併』要回 exit 1」是在講那個詞；
    //    「結論是『通過，可合併』」則是真的在下結論。分界＝**同一行有沒有「結論」這個標記**。
    if (MARKER_RE.test(line) && MERGE_RULING.test(line)) return true;
    //    引號要連 ASCII 的一起剝——只排除中文引號，`"不可合併"` 就繞過去了。
    const bare = line.replace(/[「『][^」』]*[」』]|"[^"]*"|“[^”]*”|'[^']*'/gu, '');
    if (LABEL.test(bare)) return true;
    // ⚠️ 被**別的標籤引出**的裁決是在舉例：「範例：不可合併。」「退出碼說明：不可合併，回 1。」
    //    判準是冒號在裁決**前面**，不是「這行有冒號」——
    //    「2. 暫不可合併。 仍有一條假綠：」的冒號在後面，那是正式結論（#384 r9 真實原文）。
    //    （`結論：…` 不受影響：上一行的 LABEL 已經先回 true。）
    const ruling = MERGE_RULING.exec(bare);
    //    冒號要在**同一個子句**裡才算標籤引出（Codex #385 r9）：
    //    `不通過：1 個 blocking。PR #358 暫不可合併。` 的冒號隔了一個句號，那是兩件事。
    const labelIntro = ruling && /[：:][^。！？；!?;]*$/u.test(bare.slice(0, ruling.index));
    if (ruling && !labelIntro) return true;
    // (5) 某一行**以結論用詞開頭**、後面句子就結束或接標點。
    //     排掉冒號：「通過：1395/1395 題」是標籤句型，不是結論。
    const stripped = bare.replace(/^[\s>#*+_-]*(?:\d+[.)]\s*)?/u, '').trim();
    if (STARTS_WITH_VERDICT.test(stripped)) return true;
  }
  return false;
}

/**
 * 寬鬆版的 fence 剝除（縮排 0–3、``` 與 ~~~ 都認）。
 *
 * ⚠️ 這裡刻意**不做完整的 CommonMark 文法**（那份在 `test/contract-split.test.js`）：
 * 這支要的是「別把範例裡的字當成結論」，寧可多剝一點也不要漏——
 * 和契約護欄那支「寧可紅也不要放過」的方向相反，因為這裡誤擋的代價比較高。
 * @param {string} md
 */
function stripFencesLoose(md) {
  let open = null;
  const out = [];
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) { open = open && open === m[1][0] ? null : (open || m[1][0]); continue; }
    if (!open) out.push(line);
  }
  return out.join('\n');
}

/**
 * 聯集判定。
 *
 * ⚠️ **撤銷只能由同一個審查者做，而且要用更新（或相同）的 commit**：
 * A 說「需修改」之後，B 說「通過」**不會**解除 A 的阻擋——那正是 #383 的情境。
 * 同一個審查者身分＝`角色 + 來源`（不是只有角色：兩個 Claude session 是兩個審查者）。
 *
 * @param {{body: string}[]} comments
 * @param {string} head
 * @param {string|null} [reviewerRole] PR 說明指定的獨立審查者角色；`null`＝讀不出來（退回「任何一位都算」）
 * @returns {{ problems: string[], warnings: string[], reviewers: Record<string, any> }}
 */
export function verdictProblems(comments, head, reviewerRole = null) {
  /** @type {string[]} */ const problems = [];
  /** @type {string[]} */ const warnings = [];
  /** @type {Record<string, any>} */ const latest = {};
  for (const c of comments) {
    const h = headerOf(c.body);
    if (!h) {
      const excerpt = `「${String(c.body).replace(/\s+/g, ' ').slice(0, 60)}…」`;
      const shape = `（第一行要長成「🤖 角色｜來源：…｜審 \`sha\`｜r<n>｜結論：${Object.keys(VERDICTS).join('／')}」）`;
      if (hasBotMark(c.body)) {
        // **阻擋**：出現 🤖 就是在試這個格式，寫壞了要當場說——誤判面極小。
        problems.push(`有一則留言用了 🤖 記號、但標頭格式不合規${shape}：${excerpt}`);
      } else if (looksLikeVerdict(c.body)) {
        // **只警告，不阻擋**——理由見 `looksLikeVerdict()` 上方那節。
        warnings.push(`這則留言看起來在下結論，但沒有來歷標頭 ⇒ **這道閘不會採計它**${shape}：${excerpt}`);
      }
      continue;
    }
    const who = `${h.role}（${h.source}）`;
    const cur = latest[who];
    if (!cur || h.round > cur.round) { latest[who] = { ...h, who }; continue; }
    // ⚠️ **同輪次出現相反結論 → fail-closed**（Codex #385 r1 High①）：
    //    原本用 `>=`，於是同為 r2 時「需修改」後貼「通過」就放行、反過來就阻擋
    //    ——**結果取決於留言順序**，那正是這支要根治的病，我卻在自己的實作裡犯了。
    //    契約寫的是「**更新的**輪次才能撤銷」，同輪次不算撤銷。
    if (h.round === cur.round && h.blocking !== cur.blocking) {
      latest[who] = { ...cur, conflict: true, blocking: true,
        verdict: `同一輪（r${h.round}）出現相反結論：${cur.verdict} vs ${h.verdict}` };
    }
  }
  // ⚠️ **沒有任何針對目前 head 的正式結論＝不可合併**（Codex #385 r1 High②）。
  //    我原本讓它放行，理由是「沒有人下結論不等於有人說不行」——**那是退步**：
  //    `main` 原本的合併步驟 2 就要求「確認審查結論」，而協作欄位閘只證明
  //    **有人被寫成審查者**，證明不了**審查真的發生過**。
  // ⚠️ **放行的那則「通過」必須來自 PR 指定的獨立審查者**（Codex #385 r3 High①）。
  //    原本只要求「有人說通過」——於是：實作者 Claude／獨立審查者 Codex，
  //    而留言是 **Claude 自己的「通過」**，兩道閘都零問題 ⇒ **實作者自己放行了自己的 PR**。
  //    那是唯一不變量的正面違反，而這支腳本的存在理由就是守它。
  //    阻擋仍然取**所有人**的聯集（誰都可以喊停），但**放行**只認指定的那一位。
  const passers = Object.values(latest).filter((h) => !h.blocking && head.startsWith(h.sha));
  const passedByReviewer = reviewerRole
    ? passers.some((h) => h.role === reviewerRole)
    : passers.length > 0;
  if (!passedByReviewer) {
    problems.push(passers.length && reviewerRole
      ? `對目前 head 說「通過」的是 ${passers.map((h) => h.who).join('、')}，`
        + `但 PR 說明指定的獨立審查者是「${reviewerRole}」。\n`
        + '    ⚠️ **放行只認指定的那一位**——否則實作者自己說一句「通過」就放行了自己的 PR。\n'
        + '    （阻擋不受此限：任何人都可以喊停，一律進聯集。）'
      : `沒有${reviewerRole ? `「${reviewerRole}」` : '任何一位審查者'}對目前的 head（${head.slice(0, 7)}）`
        + '下過「通過」的正式結論。\n'
        + '    ⚠️ 協作欄位閘只證明「有人被寫成審查者」，證明不了「審查真的發生過」。\n'
        + '    請獨立審查者用來歷標頭給出結論（格式見 AGENTS.md「一支 PR 上可能有好幾個審查者」節）。');
  }
  for (const h of Object.values(latest)) {
    if (!h.blocking) continue;
    problems.push(`${h.who} 在 r${h.round}（審 ${h.sha}）的結論是「${h.verdict}」，還沒有被同一位審查者撤銷。\n`
      + '    ⚠️ **取聯集，不取最後一則**：別人說「通過」不會解除這一條。'
      + '請那位審查者針對目前的 head 重新給結論。');
  }
  // 有結論的審查者都應該審到目前的 head（否則那個「通過」是對舊版本說的）
  for (const h of Object.values(latest)) {
    if (!h.blocking && !head.startsWith(h.sha)) {
      problems.push(`${h.who} 的「${h.verdict}」是對 ${h.sha} 說的，但目前 head 是 ${head.slice(0, 7)}——`
        + '分支被推過之後，那個結論不再適用。');
    }
  }
  return { problems, warnings, reviewers: latest };
}

/** @param {string} pr */
function fetchPr(pr) {
  const out = execFileSync('gh', ['pr', 'view', pr, '--json', 'comments,headRefOid,body'], { encoding: 'utf8' });
  const p = JSON.parse(out);
  if (!Array.isArray(p?.comments)) throw new Error('gh 回傳的形狀不對（comments）');
  if (typeof p.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(p.headRefOid)) {
    throw new Error('gh 沒有回傳合法的 headRefOid');
  }
  if (typeof p.body !== 'string') throw new Error('gh 回傳的形狀不對（body）');
  return { comments: p.comments, head: p.headRefOid, body: p.body };
}

/** @param {string[]} argv */
export function main(argv) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('用法：node scripts/check-review-verdicts.js <PR 編號>');
    return 2;
  }
  let data;
  try { data = fetchPr(pr); }
  catch (e) {
    console.error(`複審聯集閘 PR #${pr}：查不清楚（${/** @type {any} */ (e)?.message}）——一律當成未通過。`);
    return 2;   // fail-closed
  }
  // PR 說明指定的獨立審查者——讀不出來就是 null，那時退回「任何一位都算」並在訊息裡說明
  //（協作欄位閘會另外擋「欄位不齊」，這裡不重複擋，但也不假裝知道）。
  const reviewerRole = canonicalRole(fieldValue(data.body, '獨立審查者'));
  const { problems, warnings, reviewers } = verdictProblems(data.comments, data.head, reviewerRole);
  const who = Object.values(reviewers).map((r) => `${r.who}=${r.verdict}`).join('、') || '（沒有任何帶標頭的結論）';
  // ⚠️ 警告**不影響退出碼**：它只是提醒「這則沒被採計」，不是判準（見 looksLikeVerdict 的說明）。
  if (warnings.length) {
    console.error(`複審聯集閘 PR #${pr}：${warnings.length} 則提醒（**不影響本閘結果**）\n`
      + warnings.map((w) => `  ・${w}`).join('\n') + '\n');
  }
  if (problems.length === 0) {
    console.log(`複審聯集閘 PR #${pr}：沒有未回應的阻擋結論。現況：${who}`);
    return 0;
  }
  console.error(`複審聯集閘 PR #${pr}：**未通過**\n` + problems.map((p) => `  ・${p}`).join('\n')
    + `\n\n現況：${who}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main(process.argv.slice(2)));
}
