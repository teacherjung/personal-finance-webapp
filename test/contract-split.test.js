// @ts-check
// 領域契約拆分的護欄考題（2026-08-02，D4c／2c 收官；r3 依 Codex #384 r2 改成 manifest 精確比對）。
//
// ## 為什麼需要它
//
// `docs/contracts/` 的拆分做過三次，**一直沒有任何機械檢查**。
// 實測：拆分省下的篇幅兩天之內被吃回去大半——AGENTS.md 的「一行索引」會慢慢長胖，
// 長到跟原本的整條規則一樣長，拆分就等於沒發生（更糟：同一條規則變成兩份，會各自漂）。
//
// ## r1／r2 連兩輪被打穿，根因是同一個
//
// **我一直在「從文字推導清單」。** 推導永遠不完整，而且被推導的那份文字**自己可以改**：
//   r1：所有斷言「從索引出發」⇒ 讓某列不再是索引，它就從受測集合消失
//   r2：改成雙向，但「是不是一條規則」仍靠文字特徵（有沒有 `**記得同步這裡**：`）
//       ⇒ **marker 與索引一起刪掉，正反兩邊同時消失，四題全綠**（Codex 實測）
//       路由那題只認 `export function`，漏 `export const`／export list／API 路徑；
//       比對還用 basename 子字串，`lib/store-rules.js` 可以冒充 `lib/services/store-rules.js`
//
// ## r3：改成**宣告**，不再推導
//
// 下面的 `MANIFEST` 是**手寫的真相**：每份契約有哪些規則、哪些責任檔。判準全部改成**精確集合相等**：
//   ・契約檔裡的標題集合 **==** `rules ∪ exempt`（多一個少一個都紅——刪 marker 沒有用）
//   ・`rules` 與 AGENTS 索引列 **雙向一一對應**（拆掉索引＝紅；索引指到不存在的規則＝紅）
//   ・README 路由列的檔案集合 **==** `files`（精確路徑，不接受 basename 子字串）
//   ・契約內文提到的 repo 路徑 **⊆** `files`（新提到一個檔就強迫更新 manifest）
//
// 代價說清楚：manifest 是一份要手動維護的副本。但它的**每一種走樣都會紅**，
// 而且更新它是刻意的動作——這正是我們要的審批點。
// 相對地，「從文字推導」看起來不用維護，實際上是**永遠不知道自己漏了什麼**。
//
// ## 誠實劃界
//
// 擋得住「索引長回原文」「拆掉索引或 marker」「連結指不到」「路由表漏檔或冒充」。
// 擋不住：①索引摘要寫得爛 ②`files` 該不該包含某個檔（那是人的判斷，manifest 只保證它被明講）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 讀契約／規則檔。
 *
 * ## ⚠️ 這裡**不剖析 Markdown**，改成「這些檔案不准出現會藏東西的語法」
 *
 * 前五輪我一直在實作 CommonMark 的 fenced code block 文法：
 * r7 只剝 ``` 不剝 ~~~ ／ r8 忘了 fence 前可以有 1–3 個空格 ／
 * r9 四個記號開三個收 ／ r10 `trim()` 連 NBSP 都吃掉 ／ r11 U+2028 與容器 fence ／
 * r12 四格縮排、巢狀容器、HTML block 與 fence 交錯……
 * 而 Codex r12 的結論是**這條路要嘛寫一個真正的 Markdown parser，要嘛不要走**。
 *
 * 然後我去數了一下：**這五個檔案裡，code fence 是 0 行、HTML 註解是 0 個。**
 * 我實作了五輪文法，守的是**這裡根本不存在的東西**。
 *
 * ⇒ **關門**：契約與規則檔**不准**出現 code fence 或 HTML 註解。
 * 這一刀同時解決兩個方向——沒有 fence 就藏不了標題（假綠消失），
 * 也沒有「合法的 fence 被誤判」（誤紅消失）。判準一行講得完，而且不可能實作錯。
 *
 * 代價寫清楚：這些檔案裡**放不了 fenced code 與 raw HTML**（**四格縮排的程式碼區塊也不行**——見下方 `assertHeadingForm()`：契約檔一律禁止縮排）。它們是規則文件，
 * 現在用的是行內反引號（`像這樣`），完全不受影響；真要放範例，放進 `docs/` 其他檔案再連過來。
 * @param {string} p
 */
/**
 * 剝掉 **container block 前綴**（引用 `>`、清單 `-`／`*`／`+`／`1.`），可以巢狀重複。
 *
 * ⚠️ **只看行首是同一條錯鏈的下一環**（Codex #384 r16）：
 * `> #### 月度回顧總覽卡` 在 CommonMark 裡是**真的標題**，一樣會搶走裸 anchor；
 * `> ```` 與 `> <div>` 同理繞過 fence／raw HTML 的禁令。
 * 而三份契約檔現在第 3–5 行**本來就在用 blockquote**——這不是刻意構造。
 * ⇒ 所有「這一行是不是危險語法」的判斷，一律先剝容器前綴再判。
 * @param {string} line
 */
function stripContainers(line) {
  let s = line;
  let prev;
  do {
    prev = s;
    // ⚠️ `>` 後面的空白可有可無（CommonMark 如此），但**清單記號後面一定要有空白**
    //    （Codex #384 r18 Medium）：`-## 文字`／`1.## 文字`／`**## 粗體**` 在 GitHub 上
    //    都只是普通段落，原本的 `[ \t]?` 會把它們剝成標題而**誤紅**。
    s = s.replace(/^ {0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t])/u, '');
  } while (s !== prev);
  return s;
}

function read(p) {
  const raw = readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
  const fence = raw.split('\n').findIndex((l) => /^\s*(?:```|~~~)/.test(stripContainers(l)));
  assert.equal(fence, -1,
    `${p}:${fence + 1} 出現 code fence。\n`
    + '⚠️ 契約與規則檔**不准**用 code fence——沒關的 fence 會把後面整份文件吞成程式碼\n'
    + '   （標題與 anchor 全部消失），而要正確判斷它有沒有關，等於要實作半個 Markdown 剖析器\n'
    + '   （2026-08-03 實際走了五輪才認清）。行內的 `反引號` 不受限制；\n'
    + '   整段程式碼範例請放到 docs/ 其他檔案再連過來。');
  // ⚠️ **raw HTML block 也會吞掉標題**（Codex #384 r13）：`<pre>` `<div>` `<script>` `<table>`
  //    `<![CDATA[` `<? ?>` …CommonMark 有六類入口，把一整節包起來，GitHub 就不產生那個標題。
  //    Codex 給的完整性宣告：**「不改 `##` 那一行、只靠前後文吞掉它」的手段，就是 fence 與 raw HTML**。
  //    這五個檔案現在**行首 HTML 是 0 行** ⇒ 一起關門，不要再逐類補。
  //    ⚠️ 這裡判的是**行首**。契約檔另有更嚴的一刀（連行「中」的 `<` 都不准，見 assertHeadingForm）——
  //    AGENTS.md 刻意不吃那一刀：它要寫 `🤖 <角色>｜來源：<哪個 session>` 這種格式範例，
  //    而它的 anchor 零消費者、索引列又是考題直接讀原始文字，藏不掉東西。
  //    （r21 我把嚴格版裝在這裡，當場擋掉 #385 那段範例——兩支各自全綠、試合併才紅。
  //      跟 r15 同一個錯：**門裝到不承重的地方，就只剩下誤擋**。）
  const html = raw.split('\n').findIndex((l) => /^\s*</.test(stripContainers(l)));
  // ⚠️ **AGENTS.md 的同步點路由表本身承重**（Codex #384 r23 High③）：
  //    它的標題 anchor 沒有消費者，但那張表就是索引本身。Codex 在表前後加了行「中」的
  //    `<details>`，GitHub 把整張表收進預設摺疊區——**人看不到、而考題照讀 raw 行，7/7 全綠**。
  //
  //    ⚠️ **這裡刻意不剝 code span**（Codex #384 r25 的反例）：跳脫的反引號 `` \` ``
  //    不構成 code span，但任何「先剝 code span 再判斷」的前處理都會被它騙過去——
  //    r24 的版本就是這樣讓 `<details>` 溜進去的。所以判準直接看原始文字。
  //
  //    代價：AGENTS.md 只擋**會把內容藏起來**的那兩個元素，不是通用的 raw HTML 禁令。
  //    理由是它合法地引用外部語法（`<Z/>` 是 XBRL、`<CorporateAction>` 是 IB Flex、
  //    `<callout icon=` 是 Notion），把那些改掉是失真。**這條界線寫在這裡，不要以為它擋得更多。**
  const hider = raw.split('\n').findIndex((l) => /<\/?(?:details|summary)\b/iu.test(l));
  assert.equal(hider, -1,
    `${p}:${hider + 1} 出現 \`<details>\` 或 \`<summary>\`。\n`
    + '⚠️ 它們會把包住的內容（包括同步點路由表）摺成預設收合——**人看不到，而考題照讀原始文字**。\n'
    + '   規則書不可以有「預設看不見」的區塊。要收合請改成連到另一份文件。\n'
    + '   （這道檢查刻意不管反引號：跳脫的反引號不構成 code span，任何前處理都會被它騙過。）');
  assert.equal(html, -1,
    `${p}:${html + 1} 出現行首 raw HTML。\n`
    + '⚠️ `<pre>`／`<div>` 這類 block 會把包住的內容整段吞掉，而畫面上看不出來。要排版請用 Markdown。');
  assert.ok(!raw.includes('<!--') && !raw.includes('-->'),
    `${p} 出現 HTML 註解。\n`
    + '⚠️ 同上：註解會讓內容在畫面上消失而考題看不見，而「有沒有閉合」同樣要剖析器才能算準。\n'
    + '   要記東西就直接寫在文件裡——**看不見的註記本來就不該存在於規則書**。');
  return raw;
}

/**
 * **標題只准一種寫法**（Codex #384 r14）。
 *
 * anchor 是 GitHub 依**每一個標題**產生的，而我原本只掃 `##` 與 `###`。
 * Codex 在正式的 `## 月度回顧總覽卡` 前面加一個**同名 `####`**（另試 Setext 標題）：
 * 七題全綠，但 GitHub 把裸 anchor 給了先出現的 `####`，正式那節變成 `…-1`
 * ⇒ **AGENTS 的索引連結默默指到錯的一節**，畫面上完全看不出來。
 *
 * 這是同一個錯的第八次：我又在列舉（「標題就是 `##` 和 `###`」）。
 * CommonMark 的標題其實只有兩種（ATX `#`×1–6、Setext 底線），列舉是封閉的——
 * 但要正確對齊 GitHub 的 anchor 演算法，還得處理縮排、tab、收尾井字號、重複序號…
 * ⇒ **關門**：第 1 行一個 `# `，其餘一律行首 `## ` 或 `### `，其他標題形式一概拒絕。
 *
 * ## 這道門只裝在**契約檔**上，不裝在 AGENTS.md
 *
 * 因為承重的只有契約檔的 anchor：AGENTS.md 有 36 條連結指進契約檔的某一節，
 * 而**指進 AGENTS.md 某一節的連結是 0 條**——它的標題被誰搶走 anchor 都不會有人踩到。
 * 我 r15 原本連 AGENTS.md 一起關，結果當場誤擋了 #385 裡一個完全正當的 `#### 兩條規則`
 * （兩支 PR 各自全綠、合起來才紅）。**護欄裝在不承重的地方，就只剩下誤擋。**
 *
 * 代價說清楚：**契約檔**只能用兩層標題，而且不能用 Setext。
 * 它們現在本來就是這樣（H1×1＋H2／H3，零縮排、零 Setext）⇒ **這道門零改寫**。
 * 反方向的誤紅也一併認了：七個以上 `#` 開頭的行其實不是標題，這裡照樣拒絕——
 * 沒有理由那樣寫，而「看起來像標題卻不是」正是最會騙過人眼的東西。
 * @param {string} p @param {string} raw
 */
function assertHeadingForm(p, raw) {
  const lines = raw.split('\n');
  // ⚠️ **不需要縮排就能藏東西的三族**（Codex #384 r20 High②）：
  //    ①link/footnote reference definition：`[x]: # (一大段隱形文字)`、`[^n]: 隱形文字`
  //      GitHub 一個字都不顯示，但它們**算進 raw 長度** ⇒ 可以灌大契約內文、
  //      讓「索引摘要必須比內文短」那道比例檢查失效，再把整條規則貼回索引。
  //    ②行**中**的 raw HTML：`可見文字 <a id="假anchor"></a><details>藏起來</details>`
  //      ——原本只擋行首 `<`。
  //    ③零寬與方向控制字元：畫面上不存在，卻一樣算長度。
  //    三族的共同點是「畫面看不見、長度算得到」⇒ 一律禁止。
  //    ⚠️ 要剝容器（r23 High①）：`> [guard-padding]: # (…)` 的行首是 `>`，原本的行首判斷看不到。
  const refDef = lines.findIndex((l) => /^\[[^\]]+\]:/u.test(stripContainers(l)));
  assert.equal(refDef, -1,
    `${p}:${refDef + 1} 出現 link／footnote reference definition。\n`
    + '⚠️ 它在 GitHub 上完全不顯示，卻算進內文長度——可以用來灌大契約、讓比例檢查失效。\n'
    + '   契約檔請直接寫行內連結。');
  const invisible = raw.split('\n').findIndex((l) => /[\u200b-\u200f\u2028\u2029\ufeff\u00ad]/u.test(l));
  assert.equal(invisible, -1,
    `${p}:${invisible + 1} 出現零寬／不可見字元。\n`
    + '⚠️ 畫面上不存在、長度卻算得到——同樣可以灌大內文，而且沒有人看得出來。');
  // ⚠️ **契約檔一個 `<` 都不准**（Codex #384 r25 給了具體反例之後的收束）。
  //
  //    r24 我用「正確的 GFM code span 判準」放行反引號裡的 `<`，並宣稱誤差方向是「寧可誤紅」。
  //    **那個宣稱是錯的，Codex 用兩個反例證明了誤放**：
  //      ①開三個反引號、關兩個 ⇒ 正規式會回溯，把前兩個當開頭、第三個當內容，整段 HTML 被剝掉
  //      ②**跳脫的反引號** `` \` `` ⇒ GFM 根本不算 code span，GitHub 建立真的 `<details>`。
  //        它把這個放在 AGENTS 同步點表前後，**整張表被摺起來，而護欄 7/7 全綠**。
  //
  //    我原本不想全面禁止，理由是 `sub-charge-<id>` 是全 repo 一致的慣例、只改契約檔會製造兩種寫法。
  //    ⇒ 解法不是保留漏洞，是**把慣例一起換掉**：全 repo 的 `<xxx>` 佔位符統一成 `{xxx}`
  //      （23 處，純註解／JSDoc／測試訊息／文件，逐字元驗過只有括號種類變動）。
  //    **這是第九次得到同一個結論：不要自己實作 Markdown 文法的一部分。**
  const anyLt = lines.findIndex((l) => l.includes('<'));
  assert.equal(anyLt, -1,
    `${p}:${anyLt + 1} 出現 \`<\`。\n`
    + '⚠️ 契約檔**一個 `<` 都不准**（連行內反引號裡的也不行）——`<a id>` 會多長一個 anchor、\n'
    + '   `<details>` 會把整段摺起來，而「這個 `<` 在不在 code span 裡」需要真正的 GFM parser 才判得準\n'
    + '   （跳脫的反引號、開關長度不等，兩種都被實測繞過）。\n'
    + '   佔位符請用 `{id}` 這種寫法（全 repo 慣例）；要角括號請寫成文字。');
  // ⚠️ **第 1 行必須是 H1，這要無條件斷言**（Codex #384 r16）：
  //    原本只寫「是標題就必須合規」，於是把第 1 行的 `# ` 刪掉會讓它變成普通文字
  //    ⇒ `atxish` 是 false ⇒ 整條判斷跳過 ⇒ **七題全綠**。
  //    「不合規」與「根本不存在」是兩件事，兩件都要擋。
  assert.ok(/^# \S/u.test(lines[0]) && !/[ \t]#+[ \t]*$/u.test(lines[0]),
    `${p}:1 不是合規的 H1 標題：${JSON.stringify(lines[0])}\n`
    + '⚠️ 契約檔的第 1 行必須是 `# 檔名標題`，而且**不可以有收尾井字號**（`# 標題 #`）。\n'
    + '   H1 消失 → 後面第一個 `##` 遞補成 outline 頂層；\n'
    + '   收尾井字號 → GitHub 算出的 anchor 是「標題」、這裡算的是「標題-」，兩邊對不上（Codex r18）。');
  lines.forEach((rawLine, i) => {
    // ⚠️ **契約檔不准有任何行首縮排**——這一刀關掉整個「容器續行」家族（Codex #384 r18 High①）。
    //
    //    r17 我用逐行剝容器前綴處理 `> ####`，Codex 立刻示範**續行**版本繞過去：
    //      - 外層
    //          > #### 月度回顧總覽卡        ← 四格縮排在清單裡，GitHub 渲染成真的 h4
    //    它同時涵蓋四格續行的 `####`／Tab 巢狀／清單內 Setext／`    > ```(fence)`／`    > <div>`。
    //    而 Codex 的判斷是對的：**這需要前文狀態，逐行剝字首分辨不了**——
    //    也就是又走回「要嘛寫一個真正的 Markdown parser，要嘛不要走」那條路（fence 那次走了五輪）。
    //
    //    然後我去數了：**這三份契約檔的縮排行是 0。** 又一次要去支撐不存在的東西。
    //    而上面每一種逃法**都需要縮排**（清單續行、巢狀容器、四格區塊都是靠縮排成立的）
    //    ⇒ 禁止縮排 ＝ 整個家族一次關完，而且判準一行講得完、不可能實作錯。
    //
    //    代價寫清楚：契約檔**不能用巢狀清單、不能用四格縮排的程式碼區塊**。
    //    （AGENTS.md 不受此限——它的 anchor 零消費者，見上面的範圍說明。）
    // ⚠️ 要看**剝掉容器之後**的縮排，不是原始行首（Codex #384 r20 High①）：
    //    `>     #### 標題` 的原始行首是 `>`，過得了「行首零縮排」，剝完才露出四格。
    assert.doesNotMatch(stripContainers(rawLine), /^[ \t]+\S/u,
      `${p}:${i + 1} 剝掉引用／清單記號之後仍有縮排：${JSON.stringify(rawLine)}\n`
      + '⚠️ 契約檔**不准縮排**。縮排會建立 container block 的續行，而續行裡的 `####`／`> ####`／\n'
      + '   fence／raw HTML 全都逃得過逐行檢查（要正確判斷得實作半個 Markdown 剖析器）。\n'
      + '   這三份檔案本來就是零縮排 ⇒ 一次關掉整個家族。巢狀清單請改寫成平的。');
    // ⚠️ 容器裡的標題**也是標題**（`> #### X` 渲染成真的 h4、一樣搶 anchor），
    //    但它**不是**合規寫法——所以偵測用剝過的、判合規用原始的。
    //    只剝完之後就當合規會留下新洞：`- ## 月度回顧總覽卡` 剝完長得跟正式標題一模一樣。
    const stripped = stripContainers(rawLine);
    const inContainer = stripped !== rawLine;
    const atxish = /^ {0,3}#{1,6}(?:[ \t]|#*[ \t]*$)/.test(stripped);
    const canonical = !inContainer && (i === 0
      ? /^# \S/.test(rawLine)
      : /^#{2,3} \S/.test(rawLine) && !/[ \t]#+[ \t]*$/.test(rawLine));
    assert.ok(!atxish || canonical,
      `${p}:${i + 1} 的標題不是允許的寫法：${JSON.stringify(rawLine)}\n`
      + '⚠️ 只准兩種：**第 1 行**一個 `# 標題`，其餘一律**行首**（不縮排、不在引用或清單裡）`## ` 或 `### `。\n'
      + '   被擋掉的都是會產生 anchor、卻不在考題掃描範圍裡的形式——\n'
      + '   `####`／縮排 1–3 格／`#` 後面接 tab／收尾井字號 `## 標題 ##`／第二個 `# `／\n'
      + '   以及容器裡的標題（`> #### X`、`- ## X`）。\n'
      + '   它們會**搶走**正式標題的 anchor（正式那節被改成 `…-1`），索引連結就指到別的地方。');
    // ⚠️ Setext 只能剝**引用**，不能剝清單記號——`---` 本身就由 `-` 組成，
    //    用剝清單的規則會把它整條吃光，這道檢查就永遠不會觸發（差點自己製造一個假綠）。
    const quoted = (/** @type {string} */ l) => l.replace(/^(?: {0,3}>[ \t]?)+/u, '');
    const under = quoted(rawLine);
    const prev = i > 0 ? quoted(lines[i - 1]).trim() : '';
    const setext = /^ {0,3}(?:=+|-+)[ \t]*$/.test(under) && prev !== '';
    assert.ok(!setext,
      `${p}:${i + 1} 出現 Setext 標題底線：${JSON.stringify(rawLine)}\n`
      + `⚠️ 上一行「${prev.slice(0, 30)}」會因此變成標題並取得 anchor，\n`
      + '   而畫面上它看起來只是一段文字加一條線。標題請一律寫成 `## `／`### `。');
  });
}

/** 索引行的硬上限。現行最長 474（SEC 官方指標挑值那條，規則本身就密）。 */
const MAX_INDEX_LEN = 600;
/** 摘要相對契約內文的上限比例（只在內文 ≥300 字元時生效）。 */
const MAX_SUMMARY_RATIO = 0.6;
const BODY_LABEL = '**記得同步這裡**：';

/**
 * **宣告的真相**（不是從文字推導的）。
 * - `rules`：每一條規則的標題原文。**每一條都必須有一列 AGENTS 索引指過來。**
 * - `exempt`：確定不是獨立規則的小節，必須逐一寫理由。
 * - `files`：這個領域**宣告的**責任檔清單（README 路由列必須剛好是這一組）。
 *   ⚠️ **它是下限，不是窮舉**（Codex #384 r29 逼出來的誠實劃界）：
 *   這道護欄只能驗「已宣告的集合彼此一致」，**驗不出人漏宣告了哪些檔案**。
 *   r27 我照 Codex 的清單補了 21 支、它 r29 又找到 64 支，而且明講「我撤回 r27 的判斷，那次抽查範圍不足」。
 *   ⇒ 繼續補下去不會收斂，而**在文件上宣稱「窮舉」是一句它證明不了的話**——
 *   那正是這支 PR 存在的理由（規則書寫了做不到的保證，讀者照著信）。
 *   真正的窮舉要另拆 PR 用別的方法做（例如從 import 圖反查）。
 */
const MANIFEST = {
  'docs/contracts/前端功能.md': {
    rules: [
      '月度回顧總覽卡',
      '訂閱續費日自動推進',
      '訂閱本月攤提',
      '訂閱狀態',
      'YYYY-MM-DD 日期解析',
      '每日洞察引擎書籤 insightState',
    ],
    exempt: [],
    files: [
      'lib/derive.js',
      'lib/repo.js',
      'lib/routes/core.js',
      'lib/routes/crud.js',
      'lib/routes/market.js',
      'lib/schema.js',
      'lib/services/insights.js',
      'lib/services/market-data.js',
      'lib/services/snapshot.js',
      'lib/services/subscriptions.js',
      'lib/store.js',
      'lib/types.js',
      'public/app.js',
      'public/modules/dashboard.js',
      'public/modules/monthly-review-card.js',
      'public/modules/subscriptions-model.js',
      'public/modules/subscriptions.js',
      'test/server.test.js',
      'test/subscriptions-model.test.js',
    ],
  },
  'docs/contracts/收支記帳與匯入.md': {
    rules: [
      'PDF 逐列抽取器',
      '信用卡負數交易的繳款與退款判斷',
      '月度回顧的消費口徑與退款配對',
      '信用卡費頁的兩種口徑',
      '銀行收支真學習的方向與內轉子分類',
      '同類同店一起改是單一原子指令',
      '停車費顯示包裝的觸發',
      '帳戶顯示名 denormalized 到交易',
      '支出分類兩層與使用者自訂',
      'CATEGORY_RULES 關鍵字順序',
      '帳單多銀行與多格式解析',
      '顯示標記 applyDisplayLabels',
      '使用者自訂店名規則 storeRules',
      '規則入櫃檯',
      '規則指紋 storeRulesHash',
      '店名規則的 API 與 UI',
      '帳單上傳免選卡自動歸卡',
      '帳單匯入批次與事後整批改卡片',
      '帳單自動學習店名與分類',
      '店家消費檔案',
    ],
    exempt: [],
    files: [
      'data/seed.json',
      'lib/bank-statement.js',
      'lib/derive.js',
      'lib/pdf-isolate.js',
      'lib/repo.js',
      'lib/routes/core.js',
      'lib/routes/crud.js',
      'lib/routes/statement.js',
      'lib/schema.js',
      'lib/services/bank-import.js',
      'lib/services/categories.js',
      'lib/services/health-check.js',
      'lib/services/learning.js',
      'lib/services/statement-import.js',
      'lib/services/store-rules.js',
      'lib/statement.js',
      'lib/store-rules.js',
      'lib/store.js',
      'lib/taishin-securities.js',
      'public/app.js',
      'public/modules/cashflow.js',
      'public/modules/categories.js',
      'public/modules/refund-attribution.js',
      'public/modules/settings-store-rules.js',
      'public/modules/settings.js',
      'public/modules/transactions-import.js',
      'public/modules/transactions.js',
      'test/refund-attribution.test.js',
      'test/refund-pairing-aggregate.test.js',
      'test/statement-pipeline.test.js',
      'test/store-rules.test.js',
    ],
  },
  'docs/contracts/投資與SEC.md': {
    rules: [
      'SEC 官方指標挑值',
      'SEC currentDebt 流動債務',
      '最新單季逐列期間',
      'SEC 全站佇列護欄',
      '重型工作名額（heavy admission）與 SEC 的關係',
      '新增 ETF 持股',
      'IB 槓桿與斷頭距離',
      '投資代號與原則上限',
      '估值訊號門檻檔位',
      'settings-signals',
    ],
    exempt: [],
    files: [
      'lib/derive.js',
      'lib/heavy-admission.js',
      'lib/http-body.js',
      'lib/pdf-isolate-child.js',
      'lib/routes/auth.js',
      'lib/routes/core.js',
      'lib/routes/market.js',
      'lib/schema.js',
      'lib/services/insights.js',
      'lib/services/market-data.js',
      'lib/services/stock-fundamentals.js',
      'lib/stock-fundamentals.js',
      'public/modules/categories.js',
      'public/modules/portfolio-calculations.js',
      'public/modules/portfolio-editors.js',
      'public/modules/portfolio-exposure.js',
      'public/modules/portfolio-forms.js',
      'public/modules/portfolio-model.js',
      'public/modules/portfolio-research.js',
      'public/modules/portfolio-risk.js',
      'public/modules/portfolio-state.js',
      'public/modules/portfolio-symbol.js',
      'public/modules/portfolio-valuation-actions.js',
      'public/modules/portfolio-valuation.js',
      'public/modules/portfolio-visuals.js',
      'public/modules/portfolio.js',
      'public/modules/signal-tiers.js',
      'public/modules/stock-research-fundamentals.js',
      'public/modules/stock-research-method.js',
      'server.js',
      'test/codex-r11.test.js',
      'test/derive-reminders.test.js',
      'test/derive.test.js',
      'test/heavy-admission.test.js',
      'test/insights.test.js',
      'test/portfolio-calculations.test.js',
      'test/portfolio-editors.test.js',
      'test/portfolio-exposure.test.js',
      'test/portfolio-forms.test.js',
      'test/portfolio-model.test.js',
      'test/portfolio-research.test.js',
      'test/portfolio-risk.test.js',
      'test/portfolio-state.test.js',
      'test/portfolio-valuation-actions.test.js',
      'test/portfolio-valuation.test.js',
      'test/portfolio-visuals.test.js',
      'test/server.test.js',
      'test/signal-tiers.test.js',
      'test/stock-fundamentals-api.test.js',
      'test/stock-fundamentals.test.js',
      'test/stock-research-fundamentals.test.js',
      'test/stock-research-method.test.js',
    ],
  },
};


/** `exempt` 每一條的理由——寫在這裡，免得有人把不想維護的規則丟進去。 */
// ⚠️ **現在是空的，這是刻意的**（Codex #384 r3 High）：
//    我原本把「最新單季逐列期間」列進豁免，理由是「它在 AGENTS 對應的是 blockquote 不是表格列」。
//    Codex 實測把那條 blockquote 整條刪掉——**六題全綠**。豁免＝那條規則沒有任何人守。
//    正確的修法是把 AGENTS 那條 blockquote 改成正式的索引列，讓它跟其他規則走同一條路。
//    ⇒ **豁免名單保持空的**。要加一條進來，就要先說服自己「這條規則不需要被守」。
const EXEMPT_REASON = {};

/** GitHub 的 anchor 規則：小寫、去標點、空白轉 `-`。 @param {string} h */
function slug(h) {
  return [...h.toLowerCase()]
    .filter((c) => /[\p{L}\p{N}]/u.test(c) || c === ' ' || c === '-' || c === '_')
    .join('')
    .replace(/ /g, '-');
}

const LINK_RE = /\[契約：[^\]]+\]\((?:\.\/)?((?:docs\/contracts\/)?[^)#]+\.md)#([^)]+)\)/;

/**
 * AGENTS.md 裡所有「指向契約檔」的同步點列。
 *
 * ## ⚠️ 索引列是一份**封閉契約**，不是「看起來像表格列就算」（Codex #384 r29）
 *
 * r27 我只擋了 raw HTML（`<`）。Codex 立刻用三個**不含 `<`** 的突變全部繞過（7/7 綠）：
 *   ①第一格規則名稱**清空** ⇒ 畫面上那一格是空的，考題照樣通過
 *   ②連結寫成 `\[契約：前端功能](...)`（跳脫方括號）⇒ regex 仍命中，但 GitHub 只顯示字面文字、**點不了**
 *   ③在索引列**前面插一個空行** ⇒ GitHub 把它移出表格、渲染成帶直線的普通段落，護欄仍通過
 * 同根的變體還有：把連結包進 code span／圖片、四格縮排、零寬與方向控制字元。
 *
 * ⇒ **不逐個補洞**（那條路今晚證明過走不通）。改成驗一份封閉的形狀契約，
 * **每一條都拿 GitHub 自己的 `/markdown` API 校準過**（照文法推會錯——見下方前一行那條）：
 *   ・零縮排，且**前一行不可以是空行**（縮排會變 code block、空行會讓它掉出表格）
 *   ・**剛好兩格**（`|` 要跳脫成 `\|`）——多一格的話 GitHub 直接丟掉，連結整個消失
 *   ・契約連結必須是**第二格的最後一個東西**，而且前一個字元不是反引號
 *     （包進 code span 就只渲染成 `<code>`，不是連結）
 *   ・第一格必須有**可見文字**：不准空連結 `[](x)`、不准圖片、不准 HTML entity、不准隱形字元
 *   ・整列不准 `<`
 * ⚠️ **它守的是形狀，不是「所有繞法」**：能證明的是「這一列在畫面上是一列可點的索引」，
 * 證明不了「摘要寫得對」。第一格刻意**不要求等於 manifest 的規則名**——
 * 真實索引列合法地含行內 code（`SEC 官方指標候選 tag／\`selectMetric\``），
 * 規格要對得上現況才有用。
 */
function indexRows() {
  const lines = read('AGENTS.md').split('\n');
  const rows = [];
  lines.forEach((line, i) => {
    if (!LINK_RE.test(line)) return;
    const where = `AGENTS.md:${i + 1}`;
    const shown = line.trim().slice(0, 70);
    assert.ok(line.startsWith('|'),
      `${where} 的索引列沒有從行首的 \`|\` 開始：${shown}…\n`
      + '⚠️ 縮排會讓 GitHub 把它移出表格（四格縮排更會變成程式碼區塊）。');
    // ①前一行不可以是**空行**——空行會讓這一列掉出表格。
    //    ⚠️ 判準是拿 GitHub 自己的 `/markdown` API 校準出來的，不是照文法推的：
    //      ・前一行空白 ⇒ 渲染成 `<p>| 第二列 | y |</p>`（**掉出表格**，Codex r29 實證）
    //      ・前一行縮排四格 ⇒ 變成程式碼區塊
    //      ・前一行是**普通文字** ⇒ 表格照樣繼續（GFM 把那行渲染成單格列）
    //    我第一版寫成「前一行必須是表格列」，那會誤紅 29 條真實索引——
    //    **照文法推出來的判準，跟 GitHub 實際做的事不一樣。**
    const prev = lines[i - 1] || '';
    assert.notEqual(prev.trim(), '',
      `${where} 的索引列前面是空行：${shown}…\n`
      + '⚠️ GitHub 會把它移出表格，渲染成一段帶直線的普通文字——**畫面上不再是索引**，'
      + '而考題照樣讀得到 ⇒ 索引形同虛設（Codex #384 r29 實證）。');
    // ②不准 raw HTML 與隱形字元
    assert.ok(!line.includes('<'),
      `${where} 的索引列出現 \`<\`：${shown}…\n`
      + '⚠️ raw HTML 可以讓整格在畫面上變成空的（`<video>` 實測過），而考題照樣讀得到。');
    assert.doesNotMatch(line, /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2028\u2029\ufeff\u00ad]/u,
      `${where} 的索引列出現零寬／方向控制字元：${shown}…`);
    // ⚠️ **剛好兩格**（Codex #384 r31）：多一格 GitHub 直接丟掉，連結整個消失。
    //    實測：本分支（與 `main`）就有一列因為兩個未跳脫的 `|` 變成四格，
    //    GitHub renderer 對它回 **0 個 `<a>`**——那條契約連結一直是點不到的。
    //    要在儲存格裡寫直線，請跳脫成 `\\|`。
    // 用私用區字元當「跳脫過的直線」的佔位符（`\\u0000` 會踩到 lint 的 no-control-regex）
    const cells = line.replace(/\\\|/gu, '\uE000').split('|');
    assert.equal(cells.length, 4,
      `${where} 的索引列不是剛好兩格（實得 ${cells.length - 2} 格）：${shown}…\n`
      + '⚠️ 同步點表是兩欄，多出來的格 GitHub 會直接丟掉——**連結會整個消失**。\n'
      + '   儲存格裡的直線請跳脫成 `\\|`。');
    // ③第一格：純文字或 **純文字**（不准連結、圖片、code span、空白）
    const first = (cells[1] || '').trim();
    assert.ok(first, `${where} 的索引列第一格是空的：${shown}…\n`
      + '⚠️ 畫面上那一格會是空的，而考題照樣通過（Codex #384 r29 實測）。');
    // ⚠️ Codex 建議「第一格只准純文字」，但實際的索引列合法地含行內 code
    //    （`SEC 官方指標候選 tag／\`selectMetric\`` 這種）——**規格要對得上現況才有用**。
    //    真正會讓一格「看起來有東西、畫面上卻沒有」的是**圖片**（alt 空就整格消失）。
    //    判準因此改成：剝掉純記號之後**必須還有可見文字**，而且不准圖片語法。
    // ⚠️ 「有可見文字」要驗**渲染後**看得見的東西，不是原始碼非空（Codex #384 r31）：
    //    `[](https://x)` 渲染成空的 `<a></a>`、`&#x200B;` 渲染成只有零寬字元的 `<td>`——
    //    兩個原始碼都非空，畫面上都是空的。
    assert.doesNotMatch(first, /!?\[[^\]]*\]\(/u,
      `${where} 的索引列第一格含連結／圖片語法：${first}\n`
      + '⚠️ 空連結 `[](x)` 與空 alt 的圖片在畫面上什麼都不顯示，而考題照樣讀得到原始文字。');
    assert.doesNotMatch(first, /&[#a-zA-Z][0-9a-zA-Z]*;/u,
      `${where} 的索引列第一格含 HTML entity：${first}\n`
      + '⚠️ `&#x200B;` 這種 entity 渲染出來是隱形的，而原始碼看起來非空。');
    assert.ok(first.replace(/[`*_~\s]/gu, ''),
      `${where} 的索引列第一格只剩記號、沒有可見文字：${first}`);
    // ④第二格結尾必須是**沒被跳脫、沒被包起來**的契約連結
    const m2 = /** @type {RegExpExecArray} */ (LINK_RE.exec(line));
    const at = line.indexOf(m2[0]);
    assert.notEqual(line[at - 1], '\\',
      `${where} 的契約連結被反斜線跳脫了：${shown}…\n`
      + '⚠️ GitHub 只會顯示字面文字，**點不了** ⇒ 索引指不到契約（Codex #384 r29 實測）。');
    // ⚠️ **連結必須是第二格的最後一個東西**（Codex #384 r31）。
    //    這一條同時關掉兩種「連結還在、畫面上卻不是連結」的手法，而且不必數反引號奇偶
    //    （r30 的奇偶判準守不住多重反引號，Codex 用 `` `` 包連結就繞過去了）：
    //      ・包進 code span ⇒ 收尾的反引號會跑到連結後面 ⇒ 連結不是最後一個 ⇒ 紅
    //      ・藏到第三格 ⇒ 上面的「剛好兩格」已經先擋掉
    const cell2 = (cells[2] || '').replace(/\uE000/gu, '\\|').trimEnd();
    assert.ok(cell2.endsWith(m2[0]),
      `${where} 的契約連結不是第二格的最後一個東西：…${cell2.slice(-60)}\n`
      + '⚠️ 連結後面還有東西時，最常見的原因是它被包進了 code span（`` `[契約：…](…)` ``）——\n'
      + '   那只會渲染成 `<code>`，**不是連結**，索引就指不到契約。');
    rows.push({ line, file: normalize(m2[1]), anchor: m2[2] });
  });
  return rows;
}

/** 契約檔裡的每一個標題段落（`##` 與 `###` 都算）。 @param {string} file */
function sectionsOf(file) {
  const md = read(file);
  assertHeadingForm(file, md);   // 只有契約檔的 anchor 承重 ⇒ 標題形式的門只裝在這裡
  const heads = [...md.matchAll(/^#{2,3} .+$/gm)];
  return heads.map((h, i) => {
    const start = /** @type {number} */ (h.index);
    const end = i + 1 < heads.length ? /** @type {number} */ (heads[i + 1].index) : md.length;
    const text = md.slice(start, end);
    const bs = text.indexOf(BODY_LABEL);
    return {
      title: h[0].replace(/^#+\s*/, ''),
      anchor: slug(h[0].replace(/^#+\s*/, '')),
      // 位移用**字串長度**算，不要手寫數字（r1 就是寫死 9、實際 11）
      body: bs < 0 ? '' : text.slice(bs + BODY_LABEL.length),
    };
  });
}

const sorted = (/** @type {string[]} */ a) => [...a].sort();

test('拆分護欄｜manifest 必須涵蓋每一份契約（新拆一個領域就要在這裡登記）', () => {
  const onDisk = readdirSync(join(ROOT, 'docs/contracts'))
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => `docs/contracts/${f}`);
  assert.deepEqual(sorted(onDisk), sorted(Object.keys(MANIFEST)),
    'docs/contracts/ 底下的契約檔與 MANIFEST 的登記不一致。\n'
    + '⚠️ manifest 是宣告的真相——新拆一份契約就要在這裡登記，刪掉也要一起刪。\n'
    + '（r2 的假綠之一：契約檔整份刪掉，考題因為「從現有檔案反查」而完全不出聲。）');
  for (const e of Object.values(MANIFEST).flatMap((m) => m.exempt)) {
    assert.ok(EXEMPT_REASON[e], `exempt 的「${e}」沒有寫理由——豁免必須有名有姓，不然它就是後門`);
  }
});

test('拆分護欄｜契約標題必須是**純文字**、且 anchor 不可重複', () => {
  // ⚠️ 兩個 anchor 層的缺口（Codex #384 r13）：
  //   ①**重複標題**：GitHub 會給第二個 anchor 加序號，而我的 slug() 兩個算出來一樣
  //     ⇒ 兩列索引都導到第一節，第二條規則實際上沒有人指得到。
  //   ②**標題含連結／圖片／HTML entity／raw HTML**：GitHub 按**渲染後的文字**算 anchor，
  //     我的 slug() 按原始語法算 ⇒ 兩邊會不一樣，連結默默失效。
  //   兩個都用「禁止」關掉，比追著 GitHub 的 anchor 演算法跑實在。
  for (const file of Object.keys(MANIFEST)) {
    // ⚠️ **H1 也要算進來**（Codex #384 r14 的同一個範圍缺口）：檔名那一行也產生 anchor，
    //    它要是跟某節同名，裸 anchor 會被它搶走、那一節變成 `…-1`。
    const h1 = read(file).split('\n')[0].replace(/^#\s*/, '');
    const titles = [h1, ...sectionsOf(file).map((s) => s.title)];
    for (const t of titles) {
      assert.ok(!/[[\]<>&]/.test(t),
        `${file} 的標題「${t}」含有連結／HTML／entity 語法。\n`
        + '⚠️ GitHub 依**渲染後的文字**算 anchor，這裡依原始語法算——兩邊會不一樣，連結默默失效。\n'
        + '   契約標題請用純文字。');
    }
    const anchors = titles.map((t) => slug(t));
    const dup = anchors.filter((a, i) => anchors.indexOf(a) !== i);
    assert.deepEqual(dup, [],
      `${file} 有重複的 anchor：${dup.join('、')}\n`
      + '⚠️ GitHub 會給第二個加序號，而這裡兩個算出來一樣 ⇒ 兩列索引都導到第一節。');
  }
});

test('拆分護欄｜契約裡的標題集合＝manifest 的 rules＋exempt（刪 marker 沒有用）', () => {
  // ⚠️ r2 的假綠：「是不是一條規則」原本靠「有沒有 `**記得同步這裡**：`」判斷，
  //    把 marker 與索引**一起**刪掉，正反兩邊同時消失、四題全綠（Codex 實測）。
  //    現在判準與文字特徵無關：**標題集合必須剛好等於宣告的清單**。
  for (const [file, m] of Object.entries(MANIFEST)) {
    const titles = sectionsOf(file).map((s) => s.title);
    assert.deepEqual(sorted(titles), sorted([...m.rules, ...m.exempt]),
      `${file} 的標題集合與 manifest 不符。\n`
      + '⚠️ 新增一條規則就要登記進 rules；刪掉一條就要一起刪。\n'
      + '   確定不是獨立規則的小節請放進 exempt **並在 EXEMPT_REASON 寫理由**。');
  }
});

test('拆分護欄｜rules 與 AGENTS 索引列**雙向**一一對應', () => {
  const rows = indexRows();
  for (const [file, m] of Object.entries(MANIFEST)) {
    const declared = m.rules.map((r) => slug(r));
    // ⚠️ 用**排序後的陣列**比對，不是 Set（Codex #384 r7）：
    //    Set 會把「同一條規則出現兩列索引」吃掉，而重複列正是真實的維護手滑
    //    （複製一列改一改忘了刪原本那列），讀的人照到哪一列是碰運氣。
    const pointed = rows.filter((r) => r.file === normalize(file)).map((r) => r.anchor);
    assert.deepEqual(sorted(pointed), sorted(declared),
      `${file} 的索引列與 manifest 的 rules 不是一一對應。\n`
      + `  AGENTS 指過來的：${sorted(pointed).join('、') || '（無）'}\n`
      + `  manifest 宣告的：${sorted(declared).join('、')}\n`
      + '⚠️ 少一個＝那條規則變成孤兒（改到相關檔案的人不會被導過去）；\n'
      + '   多一個＝索引指到不存在的段落（連結會落在檔頭）。');
  }
});

test('拆分護欄｜索引的摘要必須明顯比契約內文短（否則拆分等於沒發生）', () => {
  for (const { line, file, anchor } of indexRows()) {
    const s = sectionsOf(file).find((x) => x.anchor === anchor);
    assert.ok(s, `${file} 找不到 anchor \`#${anchor}\` 的段落 ⇒ 上一題應該已經紅；這裡不放行`);
    assert.ok(s.body, `${file}#${anchor} 的段落沒有「${BODY_LABEL}」——契約被掏空了？`);

    // 比的是「摘要 vs 內文」不是「整行 vs 整段」——整行含約 90 字元的表格框與連結標記。
    // ⚠️ 用**真正的表格 cell** 解析，不可依賴「一定有空白」的 `' | '`
    //    （Codex #384 r3 實測：把分隔符改成合法的無空白 `|`，摘要就讀到錯欄，貼回 275 字全文仍全綠）。
    // ⚠️ 用**未被跳脫**的 `|` 切欄（Codex #384 r4）：Markdown 的 cell 裡可以合法寫 `\|`，
    //    單純 `.split('|')` 會在那裡誤切，於是整段規則貼回摘要也讀不到 ⇒ 假綠。
    const cells = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((y) => y.trim());
    // ⚠️ 砍掉**結尾**的「——完整契約 → [連結]」，不是切第一個 marker（Codex #384 r6 Medium）：
    //    先放短摘要＋一個假 marker、再貼回完整內文、最後才放真 marker，
    //    切第一個就只量到那段短摘要 ⇒ 索引還是長回完整副本。
    const summary = (cells[1] || '').replace(/——完整契約\s*→\s*\[[^\]]*\]\([^)]*\)\s*$/u, '');
    // 比例只在長規則上生效：短規則的摘要本來就接近規則本身。
    // ⚠️ **比例一律適用，沒有「短規則例外」**（Codex #384 r3 之後收斂）：
    //    原本對短規則放寬成「只要比內文短一個字」，結果**整段 274 字的 body 貼回去
    //    變成 273 字的摘要照樣過**——差一個字元的「短」不是拆分。
    const limit = Math.floor(s.body.length * MAX_SUMMARY_RATIO);
    assert.ok(summary.length <= limit,
      '索引摘要沒有比契約內文短夠多 ⇒ 這條規則接近「兩份完整副本」，一定會各自漂。\n'
      + `摘要 ${summary.length} 字元、契約內文 ${s.body.length} 字元（上限 ${limit}）（${file}#${anchor}）\n`
      + `實得摘要：${summary.slice(0, 120)}…`);
    assert.ok(line.length <= MAX_INDEX_LEN,
      `索引行 ${line.length} 字元，超過上限 ${MAX_INDEX_LEN}。細節請放進 ${file}。\n`
      + `實得：${line.slice(0, 120)}…`);
  }
});

test('拆分護欄｜README 路由列的檔案集合＝manifest 的 files（精確路徑，不接受冒充）', () => {
  // ⚠️ r2 的假綠：原本用 basename 子字串比對，`lib/store-rules.js` 可以替
  //    缺掉的 `lib/services/store-rules.js` 冒充過關。現在只認**完整路徑**的精確集合相等。
  const readme = read('docs/contracts/README.md');
  // ⚠️ 判準用**解析後的連結目標**，不是原始字串（Codex #384 r6 High）：
  //    `|前端功能…|`（合法的無空格表格列）與 `[前端功能.md](./前端功能.md)`（等價相對路徑）
  //    都繞得過「以 `| ` 開頭」＋「含 `(檔名)`」這種字面比對，於是矛盾的重複列照樣過關。
  const rows = readme.split('\n').filter((l) => l.trim().startsWith('|') && /\.md\)/.test(l));
  // ⚠️ 連結要**相對該檔所在目錄解析**，不能只比 basename（Codex #384 r7）：
  //    把 README 的 `(前端功能.md)` 寫成 `(docs/contracts/前端功能.md)`
  //    ——那是從 AGENTS 複製路徑到子目錄 README 的真實手滑——實際會連到
  //    `docs/contracts/docs/contracts/…`（不存在），只比 basename 卻看不出來。
  /** @param {string} l */
  const targetsOf = (l) => [...l.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)]
    .map((m) => normalize(join('docs/contracts', m[1])));
  for (const [file, m] of Object.entries(MANIFEST)) {
    const base = /** @type {string} */ (file.split('/').pop());
    // ⚠️ **剛好一列**（Codex #384 r5 High）：原本用 `rows.find()` 只驗第一列，
    //    於是在正確列後面再加一條「同一份契約、沒有任何責任檔」的矛盾路由，六題照樣全綠。
    //    路由表有兩列指向同一份契約時，讀的人會照到哪一列是碰運氣。
    const matched = rows.filter((r) => targetsOf(r).includes(normalize(file)));
    assert.equal(matched.length, 1,
      `${file} 在 README 路由表對應到 ${matched.length} 列（必須剛好 1 列）。\n`
      + '0 列＝那個領域的規則沒人會被導到；2 列以上＝讀的人照到哪一列是碰運氣。');
    const row = matched[0];
    const listed = [...row.matchAll(/`((?:lib|public|test|data|db)\/[A-Za-z0-9_./-]+\.[a-z]+|server\.js)`/g)]
      .map((x) => x[1]);
    assert.deepEqual(sorted([...new Set(listed)]), sorted(m.files),
      `${base} 的路由列與 manifest 的 files 不一致。\n`
      + '⚠️ README 硬規則①：已拆領域的檔案清單＝**宣告的責任集合**（下限，不是窮舉）。\n'
      + `  路由列有、manifest 沒有：${listed.filter((f) => !m.files.includes(f)).join('、') || '（無）'}\n`
      + `  manifest 有、路由列沒有：${m.files.filter((f) => !listed.includes(f)).join('、') || '（無）'}`);
    for (const f of m.files) {
      assert.ok(existsSync(join(ROOT, f)), `${base} 的 files 列了不存在的檔案 ${f}`);
    }
  }
});

test('拆分護欄｜契約內文提到的 repo 路徑，都要在 files 裡（提到新檔就強迫更新 manifest）', () => {
  for (const [file, m] of Object.entries(MANIFEST)) {
    const mentioned = new Set([...read(file)
      .matchAll(/`((?:lib|public|test|data|db)\/[A-Za-z0-9_./-]+\.[a-z]+|server\.js)`/g)].map((x) => x[1]));
    const missing = [...mentioned].filter((f) => !m.files.includes(f));
    assert.deepEqual(missing, [],
      `${file} 的內文點名了這些檔案，但 manifest 的 files 沒有：\n  ${missing.join('\n  ')}\n`
      + '⚠️ 這是**下限**不是上限：契約用函式名或 API 路徑點到的檔案考題看不出來，\n'
      + '   那些仍然要靠人加進 files（Codex #384 r1／r2 兩輪各抓到一批）。');
  }
});
