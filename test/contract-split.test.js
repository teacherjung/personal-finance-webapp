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
// ⚠️ **這一段是全檔的總結，它不可以比下面各處的劃界說得更多**（Codex #384 r41 抓到我又犯一次）：
// 細部劃界都已降到「已知手法」，檔頭卻還寫著無條件的「擋得住」——**讀的人只會看到檔頭**。
//
// **完整保證**（判準與資料精確相等，沒有近似）：
//   ・拆掉索引列或 marker、索引與 manifest 對不上、路由表漏檔或用短檔名冒充
//   ・契約標題的形式（層級／縮排／Setext／組合符／NFC／重複 anchor）
//   ・manifest／README 第一格／契約頁首三邊的領域名**精確相等**
//
// **只擋得住「已知手法」**（是近似，不是渲染器保證）：
//   ・索引長回原文——`visibleLen()` 只算得掉已知的撐分母手法（見它自己的劃界）
//   ・連結指不到、索引列掉出表格——`TABLE_BREAKERS` 是不完備列舉，
//     **不宣稱**「這一列一定渲染在 `<td>` 裡、一定可點」
//
// **完全擋不住**：①索引摘要寫得爛 ②`files` 該不該包含某個檔（那是人的判斷，
//   manifest 只保證它被明講；**它是下限，不是窮舉**——見 MANIFEST 上方）。
//
// ## #409 r6（2026-08-06）新增一道，只關掉「兩邊一起漏列」的其中一種
//
// 上面每一題比的都是「README 與 manifest **兩邊已宣告的集合**」，所以兩邊**同時**漏掉同一個檔案
// 是完全靜的——本支 PR 就是這樣漏了 `public/modules/form-options.js` 與
// `public/modules/html-escape.js`（八題全綠，Codex 該輪複審抓到）。
// 補的那一題（本檔最後一題）改用**import 關係**當機械線索：已宣告的正式程式 import 進來的本地 `.js`，
// 自己也必須被某份契約宣告，否則要明確登記進 `UNDECLARED_IMPORTED` 這份看得見的欠帳清單。
// ⚠️ 它擋得住的只有「**從已宣告的檔案切出新模組、兩邊都沒登記**」（也就是本支的漏法）；
// 沒有人 import 的新檔案（新考題、新文件）與「該歸哪個領域」仍然完全靠人。
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
 * 也沒有「合法的 fence 被誤判」（誤紅消失）。判準一行講得完、直接看字串，沒有需要剖析的東西。
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
 * 因為承重的只有契約檔的 anchor：AGENTS.md 的每一條契約索引都連進契約檔的某一節，
 * 而**指進 AGENTS.md 某一節的連結是 0 條**——它的標題被誰搶走 anchor 都不會有人踩到。
 * 我 r15 原本連 AGENTS.md 一起關，結果當場誤擋了 #385 裡一個完全正當的 `#### 兩條規則`
 * （兩支 PR 各自全綠、合起來才紅）。**護欄裝在不承重的地方，就只剩下誤擋。**
 *
 * 代價說清楚：**契約檔**只能用兩層標題，而且不能用 Setext。
 * 它們現在本來就是這樣（H1×1＋H2／H3，零縮排、零 Setext）⇒ **這道門零改寫**。
 * ⚠️ 七個以上 `#` 開頭的行**會通過**（`####### 文字`）。那是對的：CommonMark 本來就不把它
 * 當標題，GitHub 也不會給它 anchor。（這裡原本寫「照樣拒絕」，與實作不符——Codex #384 r41。）
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
  // ⚠️ HTML entity 也算「畫面看不見、長度算得到」（Codex #384 r37）：
  //    `&ZeroWidthSpace;` 在原始碼是 18 個字元、在畫面上是 0 個 ⇒ 一樣能撐大比例的分母。
  const entity = raw.split('\n').findIndex((l) => /&(?:[a-zA-Z][0-9a-zA-Z]{1,30}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/u.test(l));
  assert.equal(entity, -1,
    `${p}:${entity + 1} 出現 HTML entity。\n`
    + '⚠️ 它在原始碼佔位、在畫面上可能什麼都不是——同樣可以灌大內文長度。直接寫字元本身。');
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
    //    ⇒ 禁止縮排 ＝ 整個家族一次關完，而且判準一行講得完、直接看字串。
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
/** 摘要相對契約內文的上限比例。**一律適用，沒有長短規則的例外**（下方有理由）。 */
const MAX_SUMMARY_RATIO = 0.6;
/**
 * 一段 Markdown**畫面上看得到幾個字**。
 *
 * ⚠️ 存在的理由：拿原始碼長度當分母會被「正常維護」灌大（Codex #384 r35）——
 * 契約裡加一個 `[來源](https://…很長…)`，畫面只多兩個字，原始碼卻多幾十個字元，
 * 於是「摘要要比內文短 40%」這道門就被撐開，索引可以貼回整段可見內文。
 * ⇒ **對已支援的簡單形式**近似成：連結只算 label、圖片整個不算、強調記號與表格框不算。
 *   （緊接著這句就是它在哪些情形**不成立**——先講能力再講界線，兩句要一起讀。）
 * ⚠️ **誠實劃界（Codex #384 r37 逐條打掉我上一版的宣稱）**：
 *   ・**不是**「連結只算 label」——巢狀超過一層括號的目的地仍會有殘留被算成可見文字。
 *   ・**不是**「擋得住所有用不可見原始碼撐分母的手法」——例如契約 body 裡的 HTML entity
 *     （`&ZeroWidthSpace;`）在這裡算成 18 個字，在畫面上是 0 個。
 *   ・**不是**「行內 code 只算內容」——`|_*~` 這些字元在 code 裡也會被一起刪掉。
 * 它能說的只有：**已知的幾種撐分母手法算不進來**。要更準就得接真正的 Markdown 渲染器。
 * @param {string} md
 */
function visibleLen(md) {
  return String(md)
    // ⚠️ 目的地可以含**平衡括號**（`…/report(section)?utm=…` 是正常網址，Codex #384 r37）：
    //    只吃到第一個 `)` 的話，後面的查詢參數會被當成可見文字，分母又被撐大。
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/gu, '')       // 圖片：整個不算
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/gu, '$1')    // 連結：只算 label
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, '$1')     // reference-style 同上
    .replace(/^\[[^\]]+\]:.*$/gmu, '')               // reference definition：不顯示
    .replace(/[`*_~|]/gu, '')                        // 記號與表格框
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]/gu, '')
    .replace(/\u034f/gu, '')   // CGJ 單獨處理：放進字元類別會踩到 no-misleading-character-class
    .replace(/\s+/gu, ' ')
    .trim().length;
}

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
  'docs/contracts/cloud-security.md': {
    /** 三邊（manifest／README 第一格／契約頁首）都要精確對這個名字。 */
    domain: '雲端與安全',
    rules: [
      '機密投影與匯出的兩種模式',
      '雙模式與帳號系統',
      '機密欄位與 mapSecrets',
      '只剝不加密的 PII mapBackupOnlyPii',
      '機密加密與解不開的寫回保護',
      '解析器資源上限與行程隔離',
      '速率限制',
      '租戶隔離與請求範圍狀態',
      '部署設定與版號單一真相',
    ],
    exempt: [],
    files: [
      'data/seed.json',
      'lib/bank-statement.js',
      'lib/crypto-secrets.js',
      'lib/hosted.js',
      'lib/http-body.js',
      'lib/ib.js',
      'lib/parse-limits.js',
      'lib/pdf-isolate-child.js',
      'lib/pdf-isolate.js',
      'db/supabase-schema.sql',
      'lib/rate-limit.js',
      'lib/routes/auth.js',
      'lib/routes/core.js',
      'lib/routes/crud.js',
      'lib/secret-fields.js',
      'lib/services/auth.js',
      'lib/statement.js',
      'lib/store-pg.js',
      'lib/store-rules.js',
      'lib/taishin-securities.js',
      'lib/tenant.js',
      'package-lock.json',
      'public/modules/assets.js',
      'public/modules/cards.js',
      'public/modules/settings.js',
      'server.js',
      'test-doubles/fake-supabase.js',
      'test/deploy-config.test.js',
      'test/hosted-auth.test.js',
      'test/hosted-secret-writeback.test.js',
      'test/hosted-secrets.test.js',
      'test/hosted-store-pg.test.js',
      'test/ib-parser-money.test.js',
      'test/parse-limits.test.js',
      'test/pdf-isolate.test.js',
      'test/pdf-limits-wiring.test.js',
      'test/rate-limit.test.js',
      'test/server.test.js',
      'test/xlsx-isolate.test.js',
    ],
  },
  'docs/contracts/data-storage.md': {
    /** 三邊（manifest／README 第一格／契約頁首）都要精確對這個名字。 */
    domain: '資料與儲存',
    rules: [
      '資料存取單一櫃檯 B1',
      'repo 介面的新增與修改',
      '驗證入櫃檯 B3',
      '日期與月份的真實日曆判準',
      '必填欄位機制與跨欄不變式',
      'HOSTED 並行安全 CAS',
      'HOSTED 資料層與測試替身',
      'kv 的鍵',
      '本機檔案操作一律經櫃檯',
      '每日滾動備份',
      '不可逆整批操作前的真備份 backupNow',
      '測試隔離慣例 B0',
    ],
    exempt: [],
    files: [
      'data/seed.json',
      'db/supabase-schema.sql',
      'lib/repo.js',
      'lib/routes/core.js',
      'lib/schema.js',
      'lib/services/backup.js',
      'lib/services/snapshot.js',
      'lib/services/statement-import.js',
      'lib/services/store-rules.js',
      'lib/store-pg.js',
      'lib/store-rules.js',
      'lib/store.js',
      'lib/types.js',
      'public/modules/backup-alert.js',
      'server.js',
      'test-doubles/fake-supabase.js',
      'test/backup-alert.test.js',
      'test/daily-backup.test.js',
      'test/hosted-import-overwrite.test.js',
      'test/hosted-store-pg.test.js',
      'test/repo-async.test.js',
      'test/server.test.js',
    ],
  },
  'docs/contracts/frontend-features.md': {
    /** 三邊（manifest／README 第一格／契約頁首）都要精確對這個名字。 */
    domain: '前端功能',
    rules: [
      '月度回顧總覽卡',
      '訂閱續費日自動推進',
      '訂閱本月攤提',
      '訂閱狀態',
      'YYYY-MM-DD 日期解析',
      '每日洞察引擎書籤 insightState',
      'async render 與路由序號 guard',
      '淨值目標與到達速度',
      '時鐘倒退保護',
      '淨值日線 dailyValues',
      '共用彈窗契約',
    ],
    exempt: [],
    files: [
      'lib/derive.js', 'data/seed.json',
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
      'lib/types.js', 'test/daily-values.test.js',
      'public/app.js',
      'public/modules/dashboard.js',
      'public/modules/monthly-review-card.js', 'public/modules/modal-shell.js', 'public/modules/goal-tracking.js', 'public/modules/settings.js', 'public/modules/assets.js', 'public/modules/cards.js', 'public/modules/cashflow.js', 'public/modules/history.js', 'public/modules/insurance.js', 'public/modules/portfolio.js', 'public/modules/securities.js', 'public/modules/transactions.js', 'public/modules/settings-store-rules.js', 'public/modules/transactions-import.js', 'test/snapshot-safety.test.js', 'test/goal-tracking.test.js', 'test/goal-tracking-ui.test.js',
      'public/modules/subscriptions-model.js',
      'public/modules/subscriptions.js',
      // #409 補宣告：彈窗下拉的通用保留機制（form-options 與收支多重命中）＋ esc 的實作本體
      'public/modules/form-options.js', 'public/modules/html-escape.js',
      'test/server.test.js',
      'test/subscriptions-model.test.js',
    ],
  },
  'docs/contracts/income-expense.md': {
    /** 三邊（manifest／README 第一格／契約頁首）都要精確對這個名字。 */
    domain: '收支記帳與匯入',
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
      '銀行對帳單解析與分箱',
      '帳戶完整帳號與餘額匯入',
      '帳單原文取法 origFromStmtRef',
    ],
    exempt: [],
    files: [
      'data/seed.json',
      'lib/bank-statement.js', 'test/bank-statement.test.js',
      'lib/derive.js',
      'lib/pdf-isolate.js',
      'lib/repo.js',
      'lib/routes/core.js',
      'lib/routes/crud.js',
      'lib/routes/statement.js',
      'lib/schema.js', 'lib/secret-fields.js', 'public/modules/assets.js', 'public/modules/accounts-model.js', 'lib/types.js', 'test/server.test.js', 'test/statement.test.js', 'test/codex-r10.test.js',
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
      // #409 補宣告：收支的分類／子類下拉也走這一份（與前端多重命中）
      'public/modules/form-options.js',
      'test/refund-attribution.test.js',
      'test/refund-pairing-aggregate.test.js',
      'test/statement-pipeline.test.js',
      'test/store-rules.test.js',
    ],
  },
  'docs/contracts/investment-sec.md': {
    /** 三邊（manifest／README 第一格／契約頁首）都要精確對這個名字。 */
    domain: '投資與 SEC',
    rules: [
      'SEC 官方指標挑值',
      'SEC currentDebt 流動債務',
      '最新單季逐列期間',
      'SEC 單一回應資源上限',
      'SEC 全站佇列護欄',
      '重型工作名額（heavy admission）與 SEC 的關係',
      '新增 ETF 持股',
      'IB 槓桿與斷頭距離',
      '投資代號與原則上限',
      '估值訊號門檻檔位',
      'settings-signals',
      '投資頁前端模組分工',
      'IB 現金幣別歸零',
      '多幣別損益',
      'XIRR 資金加權年化',
      'securityTrades 欄位所有權與去重',
    ],
    exempt: [],
    files: [
      'lib/derive.js',
      'lib/heavy-admission.js',
      'lib/http-body.js', 'lib/ib.js',
      'lib/parse-limits.js',
      'lib/pdf-isolate-child.js',
      'lib/routes/auth.js',
      'lib/routes/core.js',
      'lib/routes/market.js', 'lib/services/ib-sync.js', 'lib/services/securities-import.js', 'lib/secret-fields.js', 'lib/services/security-trades.js', 'lib/routes/securities.js', 'public/modules/securities.js', 'public/modules/securities-view.js', 'lib/types.js', 'lib/store.js', 'lib/taishin-securities.js', 'test/security-trades.test.js', 'test/securities-contract.test.js', 'test/securities-import.test.js', 'test/securities-migration.test.js', 'test/securities-preview-projection.test.js', 'test/securities-ui.test.js', 'test/taishin-securities.test.js', 'test/portfolio-activity.test.js', 'test/portfolio-chart.test.js', 'test/portfolio-details.test.js', 'test/portfolio-format.test.js', 'test/portfolio-ib-sync.test.js', 'test/portfolio-info-actions.test.js', 'test/portfolio-info.test.js', 'test/portfolio-overview.test.js', 'test/portfolio-quotes.test.js', 'test/portfolio-remote-actions.test.js', 'test/portfolio-report.test.js', 'test/portfolio-research-actions.test.js', 'test/portfolio-tables.test.js', 'test/stock-research-model.test.js', 'test/stock-research-page.test.js', 'test/stock-research-score.test.js', 'test/stock-research-view.test.js',
      'lib/schema.js',
      'lib/services/insights.js',
      'lib/services/market-data.js',
      'lib/services/stock-fundamentals.js',
      'lib/stock-fundamentals.js',
      'public/app.js', 'public/modules/categories.js', 'public/modules/portfolio-activity.js', 'public/modules/portfolio-chart.js', 'public/modules/portfolio-details.js', 'public/modules/portfolio-format.js', 'public/modules/portfolio-ib-sync.js', 'public/modules/portfolio-info-actions.js', 'public/modules/portfolio-info.js', 'public/modules/portfolio-overview.js', 'public/modules/portfolio-quotes.js', 'public/modules/portfolio-remote-actions.js', 'public/modules/portfolio-report.js', 'public/modules/portfolio-research-actions.js', 'public/modules/portfolio-tables.js', 'public/modules/stock-research-model.js', 'public/modules/stock-research-page.js', 'public/modules/stock-research-score.js', 'public/modules/stock-research-view.js',
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
      'test/heavy-admission.test.js', 'test/ib-parser-money.test.js',
      'test/insights.test.js', 'test/securities-sync.test.js',
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
      'test/parse-limits.test.js',
      'test/server.test.js',
      'test/signal-tiers.test.js',
      'test/stock-fundamentals-api.test.js',
      'test/stock-fundamentals.test.js',
      'test/stock-research-fundamentals.test.js',
      'test/stock-research-method.test.js',
      // #409 補宣告：fxExposure 讀 accounts-model 的 LIABILITY_TYPES（收支那一列早就寫「與投資多重命中」，
      // 硬規則②要求被命中的每一個領域都要點名它）
      'public/modules/accounts-model.js',
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

/**
 * 會**中斷 GFM 表格**的區塊起始。
 *
 * ⚠️ 這張表是拿 GitHub 自己的 `/markdown` API **一種一種試出來的**，不是照文法推的
 * （r30 我照文法推，把「普通文字行」也當成會中斷，當場誤紅 29 條真實索引——
 * 實測結果是普通文字與兩格縮排的續行**不會**中斷，GFM 把它們渲染成單格列）。
 *
 * ⚠️ **誠實劃界（Codex #384 r37 指出我上一版把界線寫得比能力寬）**：
 * 這是一份**列舉**，而列舉不會完備。所以這道檢查能說的只有
 * 「**沒有踩到這幾種已知的中斷寫法**」，**不是**「這一列一定渲染在 `<td>` 裡」。
 * 每一條都有 GitHub `/markdown` 實測與突變；清單以外的寫法它看不到。
 */
const TABLE_BREAKERS = [
  [/^\s*$/u, '空行'],
  [/^ {0,3}#{1,6}[ \t]/u, 'ATX 標題'],
  [/^ {0,3}[-*+][ \t]/u, '清單'],
  [/^ {0,3}\d{1,9}[.)][ \t]/u, '編號清單'],
  [/^ {0,3}>/u, '引用'],
  // ⚠️ 分隔線的記號之間可以有空白（`_ _ _` 是合法的——Codex #384 r37）
  [/^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/u, '分隔線'],
  [/^ {0,3}={2,}[ \t]*$/u, 'Setext 底線'],
  [/^(?: {4,}|\t)\S/u, '四格縮排（程式碼區塊）'],
];

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
 *   ・第一格**擋掉已知的「看起來有字、畫面上卻空」手法**：空連結 `[](x)`、圖片、
 *     HTML entity、列舉到的隱形字元。**不是**「保證有可見文字」——那要接渲染器。
 *   ・整列不准 `<`
 * ⚠️ **它守的是形狀，不是「所有繞法」**：能說的只有「**沒有踩到下列已知的失真寫法**」，
 * **不是**「這一列在畫面上一定是可點的索引」（那要接渲染器才證得了），也證明不了「摘要寫得對」。第一格刻意**不要求等於 manifest 的規則名**——
 * 真實索引列合法地含行內 code（`SEC 官方指標候選 tag／\`selectMetric\``），
 * 規格要對得上現況才有用。
 */
function indexRows() {
  const lines = read('AGENTS.md').split('\n');
  // 從每一條表頭分隔線開始逐行追「表格還活著嗎」：breaker 讓它死，新的分隔線讓它復活。
  const liveTableRows = new Set();
  let live = false;
  lines.forEach((l, n) => {
    if (/^ {0,3}\|[ :|-]*-{3,}[ :|-]*\|?\s*$/u.test(l)) { live = true; return; }
    if (!live) return;
    if (TABLE_BREAKERS.some(([re2]) => re2.test(l))) { live = false; return; }
    if (l.startsWith('|')) liveTableRows.add(n);
  });
  const rows = [];
  lines.forEach((line, i) => {
    if (!LINK_RE.test(line)) return;
    const where = `AGENTS.md:${i + 1}`;
    const shown = line.trim().slice(0, 70);
    assert.ok(line.startsWith('|'),
      `${where} 的索引列沒有從行首的 \`|\` 開始：${shown}…\n`
      + '⚠️ 縮排會讓 GitHub 把它移出表格（四格縮排更會變成程式碼區塊）。');
    // ①這一列必須落在**還活著的表格**裡。
    //    ⚠️ **表格狀態不是「前一行的狀態」**（Codex #384 r37）：先插一個清單、再接一行普通續文，
    //    前一行看起來無害，但表格早在更前面就斷了——**普通續文不會讓它重新接回**。
    //    ⇒ 從表頭分隔線開始逐行追狀態：遇到 breaker 就死，遇到新的分隔線才復活。
    //    ⚠️ breaker 那張表是拿 GitHub `/markdown` 一種一種試出來的，不是照文法推的
    //    （r30 我照文法推，把「普通文字行」也當成會中斷，當場誤紅 29 條真實索引）。
    assert.ok(liveTableRows.has(i),
      `${where} 的索引列**不在活著的表格裡**：${shown}…\n`
      + '⚠️ 表格一斷，後面的索引列會變成 `<p>`／`<li>`／blockquote——畫面上不再是索引，\n'
      + '   而考題照樣讀得到 ⇒ 索引形同虛設。表格中間要寫說明，請放到表格外面。');
    // ②不准 raw HTML 與隱形字元
    assert.ok(!line.includes('<'),
      `${where} 的索引列出現 \`<\`：${shown}…\n`
      + '⚠️ raw HTML 可以讓整格在畫面上變成空的（`<video>` 實測過），而考題照樣讀得到。');
    assert.doesNotMatch(line, /\u034f/u,
      `${where} 的索引列出現 U+034F CGJ（Codex #384 r43 實測：一格只放它，畫面上是空的）：${shown}…`);
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
    // ③第一格：擋掉已知的「看起來有字、畫面上卻空」手法（方括號／entity／隱形字元／全是記號）。
    //    ⚠️ **行內 code 是放行的**——真實索引列合法地用它（`…／\`selectMetric\``）。
    const first = (cells[1] || '').trim();
    assert.ok(first, `${where} 的索引列第一格是空的：${shown}…\n`
      + '⚠️ 畫面上那一格會是空的，而考題照樣通過（Codex #384 r29 實測）。');
    // ⚠️ Codex 建議「第一格只准純文字」，但實際的索引列合法地含行內 code
    //    （`SEC 官方指標候選 tag／\`selectMetric\`` 這種）——**規格要對得上現況才有用**。
    //    真正會讓一格「看起來有東西、畫面上卻沒有」的是**圖片**（alt 空就整格消失）。
    //    判準因此改成：剝掉純記號之後**還要剩下東西**，而且不准方括號語法。
    // ⚠️ 「有可見文字」要驗**渲染後**看得見的東西，不是原始碼非空（Codex #384 r31）：
    //    `[](https://x)` 渲染成空的 `<a></a>`、`&#x200B;` 渲染成只有零寬字元的 `<td>`——
    //    兩個原始碼都非空，畫面上都是空的。
    //    ⚠️ **直接禁止方括號**，不要只擋 `](`（Codex #384 r33）：
    //    reference-style 的 `[][blank]` 一樣渲染成空的 `<a></a>`，但它沒有 `](` ⇒ 前一版全綠。
    //    索引列的第一格現在**沒有任何方括號** ⇒ 這一刀零誤紅。
    assert.doesNotMatch(first, /[[\]]/u,
      `${where} 的索引列第一格含方括號（連結或圖片語法）：${first}\n`
      + '⚠️ 空連結（inline `[](x)` 或 reference-style `[][ref]`）與空 alt 的圖片\n'
      + '   在畫面上什麼都不顯示，而考題照樣讀得到原始文字。第一格請用文字（行內 code 可以）。');
    assert.doesNotMatch(first, /&[#a-zA-Z][0-9a-zA-Z]*;/u,
      `${where} 的索引列第一格含 HTML entity：${first}\n`
      + '⚠️ `&#x200B;` 這種 entity 渲染出來是隱形的，而原始碼看起來非空。');
    assert.ok(first.replace(/[`*_~\s]/gu, ''),
      `${where} 的索引列第一格剝掉記號之後什麼都不剩：${first}`);
    // ④第二格結尾必須是**沒被跳脫、沒被包起來**的契約連結
    const m2 = /** @type {RegExpExecArray} */ (LINK_RE.exec(line));
    const at = line.indexOf(m2[0]);
    assert.notEqual(line[at - 1], '!',
      `${where} 的契約連結是**圖片**（前面有驚嘆號）：${shown}…\n`
      + '⚠️ GitHub 會渲染成圖片，不是前往契約的連結。');
    assert.notEqual(line[at - 1], '\\',
      `${where} 的契約連結被反斜線跳脫了：${shown}…\n`
      + '⚠️ GitHub 只會顯示字面文字，**點不了** ⇒ 索引指不到契約（Codex #384 r29 實測）。');
    // ⚠️ **連結必須是第二格的最後一個東西**（Codex #384 r31）。
    //    這一條同時關掉兩種「連結還在、畫面上卻不是連結」的手法，而且不必數反引號奇偶
    //    （r30 的奇偶判準守不住多重反引號，Codex 用 `` `` 包連結就繞過去了）：
    //      ・包進 code span ⇒ 收尾的反引號會跑到連結後面 ⇒ 連結不是最後一個 ⇒ 紅
    //      ・藏到第三格 ⇒ 上面的「剛好兩格」已經先擋掉
    // ⚠️ **連結 label 只准 `契約：<領域名>`**（Codex #384 r35）：
    //    把整段契約原文塞進 label（`[契約：整段原文](…)`）畫面上完整顯示，
    //    但摘要計算會把整個連結剝掉 ⇒ 索引長回原文而護欄全綠。
    //    領域名限制成「不含標點的短字串」——現況三種：前端功能／投資與 SEC／收支記帳與匯入。
    assert.match(m2[0], /^\[契約：[^\][()。，、；：！？\n]{1,12}\]\(/u,
      `${where} 的契約連結 label 不是 \`契約：<領域名>\` 的短形式：${m2[0].slice(0, 60)}…\n`
      + '⚠️ label 是畫面上唯一顯示的文字——把內文塞進去，索引就長回原文了，\n'
      + '   而摘要計算會把整個連結剝掉、量不到它。');
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

test('拆分護欄｜契約標題不得含連結／圖片／HTML／entity／組合符，且 anchor 不可重複', () => {
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
        + '   契約標題請用文字，不要放連結／圖片／HTML／entity。');
    }
    // ⚠️ **標題不可含組合符，而且必須是 NFC 正規化形式**（Codex #384 r35）：
    //    自製的 `slug()` 只留 `\p{L}\p{N}`，會把 combining mark 丟掉；
    //    GitHub 的 anchor **會保留**它 ⇒ 兩邊算出來不一樣，索引默默指到舊 anchor。
    //    這不是刻意構造——複製貼上人名／外文（`á` 的分解式 `a`+U+0301）就會自然發生。
    //    ⇒ 不追著 GitHub 的 anchor 演算法跑，改成**關掉這個字元類別**（現況零改寫）。
    for (const t of titles) {
      assert.doesNotMatch(t, /\p{M}/u,
        `${file} 的標題「${t}」含 Unicode 組合符（分解式）。\n`
        + '⚠️ GitHub 算 anchor 時保留它、這裡的 slug() 會丟掉 ⇒ 索引連結默默指到別的地方。\n'
        + '   請改用預組合字元（NFC）。');
      assert.equal(t, t.normalize('NFC'),
        `${file} 的標題「${t}」不是 NFC 正規化形式——同上，兩邊 anchor 會算不一樣。`);
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
    // ⚠️ **比例一律適用，沒有「短規則例外」**（Codex #384 r3 之後收斂）：
    //    原本對短規則放寬成「只要比內文短一個字」，結果**整段 274 字的 body 貼回去
    //    變成 273 字的摘要照樣過**——差一個字元的「短」不是拆分。
    // ⚠️ **比的是畫面上看得到的字，不是 Markdown 原始碼長度**（Codex #384 r35）：
    //    原本拿 raw 長度當分母，於是「契約裡加一個 `[來源](很長的網址)`」——
    //    畫面只多兩個字、分母卻大增 ⇒ 之後把契約的可見內文整段貼回索引，照樣過。
    //    那是**正常維護會做的事**（補一個參考連結），不是刻意構造。
    const visLimit = Math.floor(visibleLen(s.body) * MAX_SUMMARY_RATIO);
    assert.ok(visibleLen(summary) <= visLimit,
      '索引摘要沒有比契約內文短夠多 ⇒ 這條規則接近「兩份完整副本」，一定會各自漂。\n'
      + `摘要可見 ${visibleLen(summary)} 字、契約內文可見 ${visibleLen(s.body)} 字`
      + `（上限 ${visLimit}）（${file}#${anchor}）\n`
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
  //    `|前端功能…|`（合法的無空格表格列）與 `[frontend-features.md](./frontend-features.md)`（等價相對路徑）
  //    都繞得過「以 `| ` 開頭」＋「含 `(檔名)`」這種字面比對，於是矛盾的重複列照樣過關。
  const rows = readme.split('\n').filter((l) => l.trim().startsWith('|') && /\.md\)/.test(l));
  // ⚠️ 連結要**相對該檔所在目錄解析**，不能只比 basename（Codex #384 r7）：
  //    把 README 的 `(frontend-features.md)` 寫成 `(docs/contracts/frontend-features.md)`
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
    const listed = [...row.matchAll(/`((?:lib|public-site|public|test-doubles|test|data|db|\.github\/workflows)\/[A-Za-z0-9_./-]+\.[a-z]+|server\.js|package(?:-lock)?\.json)`/g)]
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

test('⭐ 拆分護欄｜契約頁首必須精確指向**自己**的 README 路由列（三邊的第三邊）', () => {
  // ⚠️ Codex #384 r35 ④：manifest ↔ README 的集合相等一直有守，但**契約檔這第三邊沒人驗**。
  //    它把「前端功能」契約的頁首改成「適用檔案清單＝README『投資與 SEC』列」，7/7 全綠——
  //    也就是三份契約可以互相指錯，而三邊一致的承諾其實只成立兩邊。
  const readme = read('docs/contracts/README.md');
  const rows = readme.split('\n').filter((l) => l.startsWith('|'));
  for (const file of Object.keys(MANIFEST)) {
    const base = file.replace('docs/contracts/', '');
    const declared = /路由表「([^」]+)」列/u.exec(read(file));
    assert.ok(declared,
      `${file} 的頁首沒有宣告它屬於 README 的哪一列（要寫成「路由表「<領域名>」列」）。\n`
      + '⚠️ 沒有這句話，契約與路由表就只能靠人記得對應——那正是這支 PR 在修的病。');
    const row = rows.find((l) => l.includes(`](${base})`));
    assert.ok(row, `README 路由表沒有指向 ${base} 的那一列`);
    // ⚠️ **精確相等，不是 startsWith**（Codex #384 r37）：把頁首「前端功能」改成「前端」
    //    照樣過——**題目寫「精確」而實作是前綴比對**，那本身就是一句不誠實的話。
    //    canonical 名稱宣告在 manifest，三邊都精確對它。
    const domain = (row.split('|')[1] || '').trim();
    assert.equal(declared[1], MANIFEST[file].domain,
      `${file} 頁首宣告的領域名「${declared[1]}」不等於 manifest 宣告的「${MANIFEST[file].domain}」。`);
    // ⚠️ **精確相等，連括號補充都不放行**（Codex #384 r39）：
    //    上一版允許 `canonical（…）`，於是 `前端功能（完全不同的領域）` 照樣過——
    //    **題名與註解寫「精確」，實作卻是受限制的前綴比對**，那又是一句不誠實的話。
    //    ⇒ README 第一格只留 canonical 名稱，範圍說明搬到第二格開頭（本輪一起改）。
    assert.equal(domain, MANIFEST[file].domain,
      `README 指向 ${base} 的那一列第一格是「${domain.slice(0, 30)}」，`
      + `但 manifest 宣告的領域名是「${MANIFEST[file].domain}」。\n`
      + '⚠️ 三邊（manifest／README 第一格／契約頁首）要對**同一個字串**，不接受任何後綴。\n'
      + '   範圍說明請寫在第二格。');
  }
});

test('拆分護欄｜契約內文提到的 repo 路徑，都要在 files 裡（提到新檔就強迫更新 manifest）', () => {
  for (const [file, m] of Object.entries(MANIFEST)) {
    const mentioned = new Set([...read(file)
      .matchAll(/`((?:lib|public-site|public|test-doubles|test|data|db|\.github\/workflows)\/[A-Za-z0-9_./-]+\.[a-z]+|server\.js|package(?:-lock)?\.json)`/g)].map((x) => x[1]));
    const missing = [...mentioned].filter((f) => !m.files.includes(f));
    assert.deepEqual(missing, [],
      `${file} 的內文點名了這些檔案，但 manifest 的 files 沒有：\n  ${missing.join('\n  ')}\n`
      + '⚠️ 這是**下限**不是上限：契約用函式名或 API 路徑點到的檔案考題看不出來，\n'
      + '   那些仍然要靠人加進 files（Codex #384 r1／r2 兩輪各抓到一批）。');
  }
});

/**
 * 去註解掃描器（堆疊式；字串／樣板字串／樣板插值裡的 `//` 不算註解）。
 *
 * 演算法與 `test/hosted-auth.test.js`、`test/form-options.test.js` 那兩支同源——本 repo 的考題
 * **不共用 helper 檔**（`test/` 底下任何 .js 都會被 `node --test` 當考題跑），所以這裡是刻意的區域副本。
 * 為什麼下面那題需要它：AGENTS.md 的硬規則「掃原始碼的形狀考題**要先去掉註解**」，而本 repo 的註解
 * 極常**逐字引用舊程式碼**（`// 原本寫 from './modules/xxx.js'`）——不去註解就會掃到不存在的 import。
 * @param {string} src
 */
function stripComments(src) {
  let out = ''; let prev = '';
  /** @type {string[]} */ const stack = ['code'];
  /** @type {number[]} */ const interp = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]; const n = src[i + 1];
    const st = stack[stack.length - 1];
    if (st === 'code' || st === 'interp') {
      if (c === '/' && n === '/' && prev !== '\\') { stack.push('line'); prev = ''; i++; continue; }
      if (c === '/' && n === '*' && prev !== '\\') { stack.push('block'); prev = ''; i++; continue; }
      if (c === '\'') stack.push('s1');
      else if (c === '"') stack.push('s2');
      else if (c === '`') stack.push('tpl');
      else if (st === 'interp') {
        if (c === '{') interp[interp.length - 1]++;
        else if (c === '}') {
          if (interp[interp.length - 1] === 0) { stack.pop(); interp.pop(); out += c; prev = c; continue; }
          interp[interp.length - 1]--;
        }
      }
      out += c; prev = c;
    } else if (st === 'line') {
      if (c === '\n') { stack.pop(); out += c; prev = ''; }
    } else if (st === 'block') {
      if (c === '*' && n === '/') { stack.pop(); i++; prev = ''; }
      else if (c === '\n') out += c;
    } else if (st === 'tpl') {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
      if (c === '`') stack.pop();
      else if (c === '$' && n === '{') { stack.push('interp'); interp.push(0); out += n; i++; }
      prev = c;
    } else {   // s1 / s2
      out += c;
      if (c === '\\') { out += n ?? ''; i++; prev = ''; continue; }
      if ((st === 's1' && c === '\'') || (st === 's2' && c === '"')) stack.pop();
      else if (c === '\n') stack.pop();   // 一般字串不跨行＝未終結防呆
      prev = c;
    }
  }
  return out;
}

/**
 * **已經被某個宣告過的正式程式 import 進來，但自己還沒有進任何契約 `files` 的模組**——存量清單。
 *
 * 這不是豁免名單，是**今天的欠帳**：每一項都代表「某份契約的責任集合裡有一個檔案靠它幹活，
 * 而讀那份契約的人不會被導到它」。清單裡的東西可以慢慢還（挑一個歸進某個領域，同時改 README 路由列
 * 與 manifest，然後從這裡刪掉）；**不可以默默變長**——變長就是又發生一次「兩邊一起漏列」。
 *
 * ⚠️ 為什麼不是「一次全部歸戶」：這 15 個檔案該落在哪個領域是**人的判斷**（`icons.js` 與 `theme.js`
 * 被十幾個頁面模組共用、`safe-map.js` 是後端共用底層），逐一決定要一支專門的 PR；
 * #409 是「彈窗下拉不可靜靜改資料」那一支，把 15 個檔案的歸屬順手決定掉會讓真正的改動看不見。
 */
const UNDECLARED_IMPORTED = [
  'lib/is-main.js',                          // ← server.js（「被直接執行還是被 import」判斷）
  'lib/routes/ib.js',                        // ← server.js（IB 端點掛載；投資契約點名的是 services/ib-sync.js）
  'lib/routes/route-helpers.js',             // ← 四支 routes（共用的回應／驗證輔助）
  'lib/routes/stock-fundamentals.js',        // ← server.js（SEC 端點掛載）
  'lib/safe-map.js',                         // ← 七個後端檔（原型污染安全的 Map 包裝＝安全承重件）
  'public/modules/cashflow-model.js',        // ← cashflow.js
  'public/modules/dashboard-forest.js',      // ← dashboard.js
  'public/modules/file-util.js',             // ← cashflow.js／securities.js／transactions-import.js
  'public/modules/icons.js',                 // ← app.js ＋十七個頁面模組（共用圖示）
  'public/modules/month-select.js',          // ← cashflow.js／transactions.js
  'public/modules/rebalance.js',             // ← assets.js
  'public/modules/settings-store-table.js',  // ← settings.js
  'public/modules/subscriptions-report.js',  // ← subscriptions.js
  'public/modules/theme.js',                 // ← 十一個模組（圖表色單一真相，AGENTS 地雷 2 點名）
  'public/modules/tx-sort.js',               // ← settings.js／cashflow.js／securities.js／transactions.js
];

test('⭐ 拆分護欄｜宣告過的正式程式 import 進來的模組，自己也要被宣告（關掉「兩邊一起漏列」的盲區）', () => {
  // ## 這一題補的是 #409 r6（2026-08-06）Codex 指出的盲區
  //
  // 上面那兩題（README 路由列 == manifest 的 files、契約內文提到的路徑 ⊆ files）比的都是
  // **兩邊已經宣告的集合**。所以「README 與 manifest **一起**漏掉同一個檔案」是完全靜的——
  // 而本支 PR 就是這樣漏的：`public/modules/form-options.js` 與 `public/modules/html-escape.js`
  // 從 `public/app.js` 裡切出來、`app.js`／`settings.js`／`cashflow.js`／`transactions.js`
  // 都改成 import 它們，而兩邊都沒有登記 ⇒ 八題全綠。
  //
  // ## 判準：**import 關係是機械可查的責任傳遞**
  //
  // 某個檔案已經被宣告成某個領域的責任檔，它 import 進來的本地模組就承載著同一份責任
  //（把一段承重邏輯搬進新檔案＝最常見的走樣路徑，r6 的漏法就是它）。所以：
  //   「被宣告過的正式程式 import 進來的 `.js`」 **⊆** 「被宣告過的檔案 ∪ 上面那份存量清單」
  // 而且是**精確相等**（不是單向）：某一項被歸進契約、或那個 import 被拿掉時，
  // 清單必須跟著縮——否則欠帳清單自己會爛掉（列著早就還完的債）。
  //
  // ## ⚠️ 誠實劃界：它關掉的是**這一種**漏法，不是「漏宣告」這件事本身
  //
  // 擋得住：**從已宣告的檔案長出一個新模組而兩邊都沒登記**（本支的漏法、也是最常見的一種）。
  // 擋不住：
  //   ・**完全新增、沒有人 import 的東西**——新的 route 檔（只由 `server.js` 掛載算 import，
  //     但新的考題檔、新的文件、新的 seed 欄位不算）。
  //   ・**該不該屬於某個領域**：那是人的判斷，這一題只保證「它至少被某份契約明講過」。
  //   ・動態拼出來的路徑（`import('./modules/' + name + '.js')`）——判準看的是字面字串。
  //   ・來源刻意只收**正式程式**（`lib/`／`public/`／`server.js`）：考題 import 的東西不一定是
  //     那個領域的承重件（測試常為了組 fixture 去 import 共用的顏色表），把它們算進來只會製造噪音。
  const declaredFiles = new Set(Object.values(MANIFEST).flatMap((m) => m.files));
  const sources = [...declaredFiles]
    .filter((f) => f.endsWith('.js') && !f.startsWith('test/') && !f.startsWith('test-doubles/'));
  // 反面①：來源集合要真的有東西（manifest 若被掏空，下面整圈會「什麼都沒掃卻通過」）。
  assert.ok(sources.length >= 40,
    `受掃的正式程式只有 ${sources.length} 個（manifest 宣告的 .js），這個數字太小＝掃描範圍壞了`);
  // 反面②：**去註解器與 import 正規式的自檢，餵考題自己控制的 fixture**（不押正式程式的寫法細節）。
  //   ⚠️ 上一版（r6）把這道自檢釘在「`public/app.js` 必須逐字含 `from './modules/form-options.js'`」，
  //      **連引號樣式一起釘死** ⇒ 只把那一行的單引號改成雙引號（純風格、行為零差異、本 repo 的 eslint
  //      也沒有 quotes 規則）就轉紅，而訊息說「剝離器把正式程式吃掉了」＝**歸因完全錯**，
  //      下一個人會跑去 debug stripComments。（#409 r7（2026-08-06）Codex 實測。）
  //      fixture 是考題自己控制的字串，正式程式怎麼重構都不會製造假紅。
  //   ⚠️ fixture 兩種引號都放，而且**與下面那圈共用同一份正規式**：AGENTS.md:102-104「掃原始碼的形狀
  //      考題要先去掉註解、**不可只認得一種寫法**」——r6 這一題自己就只認得單引號（Codex 實測的繞法：
  //      在已宣告的 `settings.js` 頂端用**雙引號** import 一個未宣告的新模組 → 九題全綠，
  //      同一顆突變改成單引號才紅）。這道 fixture 就是那個盲區的看門狗：漏掉任一種寫法就轉紅。
  //   ⚠️ 不可以改回「逐檔斷言至少有一個 import」——`lib/hosted.js` 這種純設定檔真的零 import（實測誤紅）。
  const importRe = () => /(?:\bfrom|\bimport)\s*\(?\s*(['"])(\.[^'"]+)\1/g;
  const probe = [
    '// import { 假貨 } from \'./ghost-line.js\';',
    '/* import { 假貨 } from "./ghost-block.js"; */',
    'import { a } from \'./single-quoted.js\';',
    'import { b } from "./double-quoted.js";',
    'const lazyA = () => import(\'./dyn-single.js\');',
    'const lazyB = () => import("./dyn-double.js");',
  ].join('\n');
  assert.deepEqual([...stripComments(probe).matchAll(importRe())].map((m) => m[2]),
    ['./single-quoted.js', './double-quoted.js', './dyn-single.js', './dyn-double.js'],
    '去註解器或 import 正規式壞了：註解裡的假 import 要被吃掉，而 import 的四種寫法'
    + '（靜態／動態 × 單引號／雙引號）都要認得——漏掉哪一種，那一種就是本題的盲區（改個引號就靜靜放行）');
  /** @type {Map<string, string[]>} 未宣告的模組 → 誰 import 它 */
  const undeclared = new Map();
  let edges = 0;
  for (const f of sources) {
    const src = stripComments(readFileSync(join(ROOT, f), 'utf8'));
    for (const m of src.matchAll(importRe())) {
      const target = normalize(join(dirname(f), m[2]));
      if (!target.endsWith('.js') || !existsSync(join(ROOT, target))) continue;
      edges++;
      if (declaredFiles.has(target)) continue;
      if (!undeclared.has(target)) undeclared.set(target, []);
      /** @type {string[]} */ (undeclared.get(target)).push(f);
    }
  }
  // 反面③：正規式要真的解析到 import（regex 寫壞時 edges 會是 0 而斷言照樣「通過」）。
  assert.ok(edges >= 100, `只解析到 ${edges} 條本地 import——這個 repo 遠不止這麼少，正規式壞了`);
  for (const f of UNDECLARED_IMPORTED) {
    assert.ok(existsSync(join(ROOT, f)), `存量清單列了不存在的檔案 ${f}——檔案刪掉／改名了就從清單刪掉`);
  }
  const detail = [...undeclared].map(([f, who]) => `  ${f}  ← ${who.join('、')}`).join('\n');
  assert.deepEqual(sorted([...undeclared.keys()]), sorted(UNDECLARED_IMPORTED),
    '「已宣告的正式程式 import 進來、自己卻沒被任何契約宣告」的集合變了。\n'
    + `實得：\n${detail || '  （空）'}\n`
    + '⚠️ **變多**＝又發生一次「README 與 manifest 一起漏列」（那正是這一題存在的理由）：\n'
    + '   請把新模組加進某份契約的 files **並同步 README 路由列**；真的還不決定歸屬，\n'
    + '   就把它明確寫進 UNDECLARED_IMPORTED（那是刻意的、看得見的欠帳，不是沉默）。\n'
    + '⚠️ **變少**＝有一筆欠帳還完了（或那個 import 被拿掉）：請把它從 UNDECLARED_IMPORTED 刪掉，\n'
    + '   否則清單會開始說謊。');
});
