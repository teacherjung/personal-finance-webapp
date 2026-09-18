// PR 範本、AGENTS.md 與 CLAUDE.md 的幾句話：套件的協作欄位閘讀得到範本、AGENTS 不重述合併步驟、工作區方案的承重句。
//
// ## 這個檔案現在守什麼（2026-09-18 搬家第 7 步之後）
//
// - **PR 範本**（`.github/pull_request_template.md`）：四個欄位行要在說明**開頭那一段**——套件閘只讀第一個特殊行之前
//   （讀法只有一份＝`tools/markdown-effective.js`），寫在後面的欄位機器讀不到；範本原封不動送出去套件閘要擋、換成合法值要過。
// - **AGENTS.md** 不可再出現舊的「五步驟合併」說法、也不可有把合併步驟串起來的摘要（摘要會落後）；
//   「本專案協作附則」裡的工作區方案承重句（路徑、指令列、模型名）與 CLAUDE.md 那句 symlink 分工，用出現次數釘住。
//
// 唯一不變量「沒有任何一份產出，由寫它的人做正式複審與放行」的正本＝`RULES.md` A2；本檔不釘它的字面，
// 只釘機器怎麼執行它的那一半（範本餵得進套件閘）。套件閘的行為題在套件自己的考題檔（`tests/check-collab-fields.test.js`）。
// ⚠️ 誠實劃界：本檔證明的是「範本、規則書長什麼形狀」；證明不了任何人真的照做、也證明不了雲端真的跑了那道閘
//    （workflow 檔的事在 `test/workflow-files.test.js`）。
// 沿革：本檔 2026-08-02 出生時還釘著協作框架的角色表、三模式表、審查回饋處置整節、合併閘盤點與 workflow 逐行複本；
//    切換日（2026-09-17 第 5 步）那些條文改由 `RULES.md`／`settings.json`／`templates/` 承載，題目拆到 `test/workflow-files.test.js`、
//    `test/agents-iron-rules.test.js`、`test/branch-protection-docs.test.js`；舊協作欄位閘 `scripts/check-pr-collab-fields.js` 的純函式行為題
//    （欄位怎麼讀、角色怎麼正規化、同一人自審怎麼擋，16 題）2026-09-18 第 7 步隨那支腳本一起退役。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { problemsOf as gateProblemsOf, rolesOf, REQUIRED_FIELDS as GATE_FIELDS }
  from '../tools/gates/check-collab-fields.js';
import { leadingLines } from '../tools/markdown-effective.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

// ── PR 範本 ──────────────────────────────────────────────────────

const TEMPLATE = '.github/pull_request_template.md';
const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 「這一行是不是某個欄位的欄位行」：行首可有項目符號與水平空白、欄名可被粗體記號包住、然後才是冒號。
 * 跟兩道閘的 `fieldValue()` 同一個形狀，但只看「是不是欄位行」、不取值。
 * ⚠️ 要錨在行首：範本第二欄的佔位字「不可與實作者相同」也含「實作者」，用子字串數會把它算成第二個欄位行。
 */
const fieldLineRe = (/** @type {string} */ field) =>
  new RegExp(`^[^\\S\\n]*(?:(?:[-*+]|\\d+[.)])[^\\S\\n]*)?(?:\\*\\*|__)?${esc(field)}(?:\\*\\*|__)?[^\\S\\n]*[:：]`, 'u');

test('⭐ PR 範本的四個欄位行各恰一次，而且都在第一個特殊行之前（套件閘只讀那一段）', () => {
  // ⚠️ **不要再手寫第二份欄位行的解析器**（#583 r1→r2→r3 連三輪：先是只認一種寫法而漏算，
  //    放寬之後換成欄名含 `_` 又漏算，再放寬就連「請注意：…」這種說明也被當成欄位＝假紅）。
  //    「機器讀哪一段」現在只有一份定義＝`tools/markdown-effective.js` 的 `leadingLines()`：從第一行讀到
  //    第一個特殊行（引用、圍欄、表格分隔列、HTML 與註解、圖片、連結定義、縮排…）就停。本題問的是
  //    **「四個欄位行有沒有落在那一段裡」**——落在後面的欄位，套件閘一律當沒填。
  // ⚠️ 誠實劃界：這守的是「repo 裡的範本」。它管不到「某個人在自己的 PR 說明裡把欄位往下搬」——
  //    那由閘自己判（讀不到就擋、訊息印停在哪一行），本題不宣稱擋得住。
  const all = read(TEMPLATE).replace(/\r\n?/g, '\n').split('\n');
  const { lines: leading, stopAt } = leadingLines(all.join('\n'));
  assert.ok(leading.length > 0, '範本第一行就是特殊行——機器一個欄位都讀不到');
  for (const f of GATE_FIELDS) {
    const re = fieldLineRe(f);
    const hits = all.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
    assert.equal(hits.length, 1,
      `範本裡「${f}」的欄位行有 ${hits.length} 行（要剛好 1 行；行號 ${hits.map((i) => i + 1).join('、') || '無'}）——`
      + '多一行＝兩道閘會各讀到不同的一行，少一行＝機器讀不到那一欄');
    assert.ok(hits[0] < leading.length,
      `範本裡「${f}」的欄位行在第 ${hits[0] + 1} 行，但機器讀到第 ${stopAt} 行就停了（那一行是特殊行）。\n`
      + '  四欄要留在說明最上面、前面不要放任何引用／圍欄／表格／HTML 註解——套件閘只讀那一段。');
  }
});

test('套件閘｜模板原封不動送出去也必須不通過；角括號換成合法值就要通過（角色取自 settings.json）', () => {
  // ⚠️ 兩道閘的讀法不同（舊閘剝 HTML 註解；套件閘只讀第一個特殊行之前），所以範本要各餵一次。
  //    角色名單不寫死：`rolesOf(settings).usable`＝settings.json 的 participants 裡純拉丁字母的識別值。
  const { usable } = rolesOf(JSON.parse(read('settings.json')));
  assert.ok(usable.length >= 2,
    `settings.json 可用的參與者識別值只有 ${usable.length} 個——少於兩個時套件閘自己就退 2，本題的結果不可信`);
  const tpl = read(TEMPLATE);
  assert.ok(gateProblemsOf(tpl, usable).length > 0, '範本原封不動送出去竟然通過了套件閘——閘等於沒有');
  // 對照組：同一份範本、只把四個欄位行冒號後的佔位字換成合法值，就要通過——
  // 證明上面那條「不通過」是因為值不合法，不是因為欄位根本讀不到（那樣填什麼都會擋）。
  const value = (/** @type {string} */ f) => (f === '實作者' ? usable[0] : f === '獨立審查者' ? usable[1] : '無');
  const filled = tpl.replace(/\r\n?/g, '\n').split('\n').map((l) => {
    const f = GATE_FIELDS.find((x) => fieldLineRe(x).test(l));
    return f ? l.replace(/[:：].*$/u, `：${value(f)}`) : l;
  }).join('\n');
  assert.deepEqual(gateProblemsOf(filled, usable), [],
    '把範本的佔位字換成合法值仍然不通過——欄位行不在機器讀得到的那一段，或欄位行的形狀套件閘認不得');
});

// ── AGENTS.md 不可以重述合併步驟（重述的摘要會落後）─────────────────

test('舊的「五步驟合併」說法不可以再出現（掃法要夠廣——只掃三個字串已經漏掉一處）', () => {
  // ⚠️ 這題的第一版只掃三個固定字串，結果**漏掉 `五步驟＝確認審查結論…` 那種寫法**
  //    （Codex #379 r2 High②，同一種漂移的第三次）。改成掃「五步驟」出現在合併語境裡的**任何**形式。
  // ⚠️ 2026-09-17 起只掃 AGENTS.md：合併程序那份文件已刪、正本搬去套件（合併＝`node tools/merge.js`，
  //    它跑的閘登記在 settings.json 的 gates，幾道刻意不寫死）。
  for (const f of ['AGENTS.md']) {
    const txt = read(f);
    for (const [i, line] of txt.split('\n').entries()) {
      // 「五步驟審查循環」是舊 AGENTS 那張審查循環表的名字（切換日起不在本檔），那種提法五步是對的——
      // 只放行明確講「審查循環」的那些，其餘一律當合併語境
      const mentionsFive = /五步驟|五個步驟/.test(line);
      if (!mentionsFive) continue;
      const isReviewCycle = /五步驟審查循環|五步驟表|審查循環/.test(line);
      assert.ok(isReviewCycle,
        `${f}:${i + 1} 在合併語境提到「五步驟」：\n  ${line.trim().slice(0, 160)}\n`
        + '合併步驟不得稱為五步（合併指令跑的是 settings.json gates 登記的閘，幾道刻意不寫死）。'
        + '⚠️ 別跟「五步驟**審查循環**」搞混——那是另一件事，五步是對的。');
    }
  }
});

test('AGENTS.md 不可以再有「重述合併步驟」的摘要（重述的摘要注定落後）', () => {
  // Codex r1 High② 抓到一處、r2 High② 又抓到第二處——判準改成「有沒有把步驟串起來寫」，
  // 而不是「有沒有出現某個字串」。
  const agents = read('AGENTS.md');
  const arrowChains = agents.split('\n').filter((l) =>
    /gh pr merge/.test(l) && /→|->/.test(l));
  assert.deepEqual(arrowChains.map((l) => l.trim().slice(0, 100)), [],
    'AGENTS.md 又出現把合併步驟串起來的摘要。\n'
    + '附則刻意只寫合併指令與閘的登記位置（settings.json 的 gates），不重述步驟：摘要會落後，登記不會。');
});

// ── 工作區方案的承重句（AGENTS 附則＋CLAUDE.md）───────────────────

test('工作區方案（實作常設／審查拋棄）：白名單句庫＋出現次數（改任何一份複本都會紅）', () => {
  // 三代被打穿史：v1 關鍵字→覆寫假綠＋誤擋（r2）；v2/v3 解析式→位置顛倒／逃逸／重複-b／
  // 分號注入／續行覆寫（r3/r4，劃界：解析追不上變體空間）；v4 白名單→r5 抓「只驗存在」：
  // 同一句活兩處、改壞一處由另一處滿足 includes ⇒ v5 改**出現次數精確比對**。
  // ⇒ 特性不是缺陷：改這些指令或承重句＝必先來改本考題（變更必經考題）。
  // ⚠️ 2026-09-17 搬家第 5 步：合併程序與路由表兩份文件已刪、協作規矩正本＝RULES.md。本題只剩
  //    AGENTS.md「本專案協作附則」裡真的還在的句子（路徑、指令列、模型名）與 CLAUDE.md 那句 symlink 分工；
  //    以前釘在那兩份裡的備樹指令、歷史模型名、零次釘與第 6 題承重句全部拿掉——那些要嘛已不在本 repo 的活文字裡，
  //    要嘛由套件自己的考題守。
  // ⚠️ 誠實劃界：它證明「白名單句在兩份文件各出現規定次數」，證明不了「別處沒有另立
  //    覆寫段落」（歸審查制度）、也證明不了「執行者真的照做」（歸事後稽核與指派詞）。
  const docs = { 'AGENTS.md': read('AGENTS.md'), 'CLAUDE.md': read('CLAUDE.md') };
  const count = (/** @type {string} */ hay, /** @type {string} */ needle) => hay.split(needle).length - 1;
  const PINS = [
    ['AGENTS.md', '實作＝常設樹、審查＝拋棄式樹、絕不動主目錄', 1],
    ['AGENTS.md', '`git fetch origin && git checkout -B codex/<分支> origin/main`', 1],
    ['AGENTS.md', '功能分支（`git checkout -B codex/<分支> origin/main`）', 1],
    ['AGENTS.md', '`/private/tmp/codex-review-pr<N>`／`/private/tmp/claude-review-pr<N>`', 1],
    ['AGENTS.md', '-C "/private/tmp/codex-review-pr<N>"', 1],   // 發射審查的指令列裡那一處
    ['AGENTS.md', '釘住受審 commit', 2],
    ['AGENTS.md', '審查樹由發射者備與收，審查者不得自建 worktree', 1],
    ['AGENTS.md', '由發射者備樹時建、收尾時 unlink，審查者不得自行建立／安裝／移除', 1],
    // 審查模型＝William 的裁示（2026-09-07）。**這一列守的是「全檔出現幾次」，不是「出現在哪裡」**。
    // 哪天換模型：把這一列改成新模型名、次數照附則實際次數——它買到的是：單純增刪任一個模型名一定會紅。
    ['AGENTS.md', 'gpt-6-astra', 1],
    ['CLAUDE.md', '正式審查的 symlink 一律由發射者備樹時處理', 1],
  ];
  for (const [file, pin, expected] of PINS) {
    const got = count(docs[file], pin);
    assert.equal(got, expected,
      `${file} 的白名單句「${pin}」出現 ${got} 次（規定 ${expected}）——`
      + '要改指令或承重句，先來改本考題的句庫與次數（變更必經考題）');
  }
});
