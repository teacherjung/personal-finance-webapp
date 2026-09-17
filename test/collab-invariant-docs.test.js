// 舊協作欄位閘 `scripts/check-pr-collab-fields.js` 的**純函式行為題**，外加 PR 範本與 AGENTS.md 的幾句話。
//
// ## 這個檔案現在守什麼（2026-09-17 搬家第 5 步之後）
//
// - **舊閘的判斷**（`problemsOf`／`fieldValue`／`canonicalRole`）：欄位怎麼讀、角色怎麼正規化、同一人自審怎麼擋。
//   這些題**跟著那支腳本一起退役**（搬家第 7 步）；在那之前舊閘仍在本機鉤子與舊指令路徑上跑，行為題照留、
//   每一題仍真的守東西。套件那一道（`tools/gates/check-collab-fields.js`）的行為題在它自己的考題檔，本檔只拿範本餵它一次。
// - **PR 範本**（`.github/pull_request_template.md`）：四個欄位行要在說明**開頭那一段**——套件閘只讀第一個特殊行之前
//   （讀法只有一份＝`tools/markdown-effective.js`），寫在後面的欄位機器讀不到；範本原封不動送出去，舊閘與套件閘都要擋。
// - **AGENTS.md** 不可再出現舊的「五步驟合併」說法、也不可有把合併步驟串起來的摘要（摘要會落後）；
//   「本專案協作附則」裡的工作區方案承重句（路徑、指令列、模型名）與 CLAUDE.md 那句 symlink 分工，用出現次數釘住。
//
// 唯一不變量「沒有任何一份產出，由寫它的人做正式複審與放行」的正本＝`RULES.md` A2；本檔不釘它的字面，
// 只釘機器怎麼執行它的那一半（兩欄不同人）。
// ⚠️ 誠實劃界：本檔證明的是「這些函式對這些輸入怎麼回答」與「範本、規則書長什麼形狀」；證明不了任何人真的照做、
//    也證明不了雲端真的跑了那道閘（workflow 檔的事在 `test/workflow-files.test.js`）。
// 沿革：本檔 2026-08-02 出生時還釘著協作框架的角色表、三模式表、審查回饋處置整節、合併閘盤點與 workflow 逐行複本；
//    切換日那些條文改由 `RULES.md`／`settings.json`／`templates/` 承載，題目拆到 `test/workflow-files.test.js`、
//    `test/agents-iron-rules.test.js`、`test/branch-protection-docs.test.js`，其餘刪除。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { problemsOf, fieldValue, canonicalRole, REQUIRED_FIELDS }
  from '../scripts/check-pr-collab-fields.js';
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
  assert.deepEqual(GATE_FIELDS, REQUIRED_FIELDS,
    '套件閘與舊閘的必填欄位清單不同——第 7 步之前兩道都在跑，欄位漂開＝一邊放行一邊擋');
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

test('⭐ 欄位定位｜八種常見寫法都讀得到同一個值（合法裝飾不可誤擋、註解裡的同名字串不算）', () => {
  // ⚠️ 這一族原本只住在一支 2026-09-08 被刪掉的考題檔裡（那支專驗一個已經拿掉的欄位）。
  //    搬過來換成「實作者」再釘一次：`fieldValue()` 的三個分支（項目符號／粗體包住／有序清單）
  //    是**實作者與獨立審查者兩欄共用的**，沒有它，那兩欄從此會被靜靜誤擋而沒人發現。
  for (const [body, want, why] of /** @type {[string, string, string][]} */ ([
    ['- **實作者**：Claude', 'Claude', '模板的標準寫法'],
    ['* __實作者__: Claude', 'Claude', '另一種項目符號＋底線粗體＋半形冒號'],
    ['1. **實作者**：`Claude`', '`Claude`', '有序清單（反引號原樣留著，值由呼叫端自己正規化）'],
    ['2) 實作者：Claude', 'Claude', '有序清單的另一種括號、欄名不加粗'],
    ['實作者：**Claude**', 'Claude', '行首直接寫欄名（值外層的粗體記號會被剝掉，反引號不會——照實釘住現行行為）'],
    ['  - **實作者** ：  Claude  ', 'Claude', '前後空白與全形冒號前的空白都要吃掉'],
    ['<!--\n- **實作者**：例如 Claude 或 Codex\n-->\n- **實作者**：Codex', 'Codex', 'HTML 註解裡的同名字串不算（模板原封不動送出去要能被擋）'],
    ['- **實作者**：', '', '欄位留空＝空字串（⚠️ 這一格只有一行，抓不到「冒號後改吃換行」那種突變——那由空模板那一題守）'],
  ])) {
    assert.equal(fieldValue(body, '實作者'), want, `${why}\n說明：\n${body}`);
  }
});

test('欄位閘｜必填欄位齊全且實作者 ≠ 審查者 → 通過', () => {
  const body = [
    '## 協作欄位', '',
    '- **實作者**：Claude',
    '- **獨立審查者**：Codex',
    '- **預計修改的共享檔案**：AGENTS.md',
    '- **這支若完全失敗，最糟失去什麼**：文件回到今天早上的樣子',
  ].join('\n');
  assert.deepEqual(problemsOf(body), []);
});

test('欄位閘｜**模板原封不動送出去必須不通過**（舊閘；填寫說明都在 HTML 註解裡）', () => {
  // ⚠️ 這題是這道閘的核心：不剝註解的話，空模板也會「找得到欄位名」而放行＝閘等於沒有。
  //    同型的病：#353 r1 的考題只掃文件關鍵字，被「把指令搬進 HTML 註解」直接繞過（3/3 綠）。
  // ⚠️ 只斷言「至少一條」、不斷言「四欄皆缺」：範本的欄位值是角括號佔位字（`<識別值>`、`<一句話>`），
  //    後兩欄只要非空就算填了，會被判缺的只有前兩欄（角色看不出是誰）。寫成 ≥ 4 會假紅。
  const problems = problemsOf(read(TEMPLATE));
  assert.ok(problems.length > 0, '範本原封不動送出去竟然通過了舊閘——閘等於沒有');
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

test('欄位閘｜實作者與審查者是同一個人 → 不通過（這是它存在的全部理由）', () => {
  const body = [
    '- **實作者**：Codex',
    '- **獨立審查者**：Codex',
    '- **預計修改的共享檔案**：無',
    '- **這支若完全失敗，最糟失去什麼**：無',
  ].join('\n');
  const problems = problemsOf(body);
  assert.ok(problems.some((p) => p.includes('沒有任何一份產出可以由寫它的人放行')),
    `實作者自審沒有被擋下，實得：${problems.join('；') || '（零條）'}`);
});

test('欄位閘｜缺任何一欄都要被點名（不是只看有沒有欄位名）', () => {
  const body = ['- **實作者**：Claude', '- **獨立審查者**：Codex'].join('\n');
  const problems = problemsOf(body);
  for (const f of ['預計修改的共享檔案', '這支若完全失敗，最糟失去什麼']) {
    assert.ok(problems.some((p) => p.includes(f)), `沒有點名缺少的「${f}」`);
  }
});

test('欄位閘｜角色寫成看不懂的字串要被點名（避免「已填」但填了廢話）', () => {
  const body = [
    '- **實作者**：某人',
    '- **獨立審查者**：Codex',
    '- **預計修改的共享檔案**：無',
    '- **這支若完全失敗，最糟失去什麼**：無',
  ].join('\n');
  assert.ok(problemsOf(body).some((p) => p.includes('看不出是')), '角色填成「某人」沒有被點名');
});

test('欄位抽取｜HTML 註解裡的同名字串不算數', () => {
  const body = '<!-- - **實作者**：Codex -->\n- **實作者**：Claude';
  assert.equal(fieldValue(body, '實作者'), 'Claude',
    '註解沒有被剝掉——註解裡的值會蓋過真正填的值');
});

// ── 角色解析不可 fail-open（Codex #379 r1 High①）─────────────────

/** @param {string} impl @param {string} rev */
const bodyWith = (impl, rev) => [
  `- **實作者**：${impl}`,
  `- **獨立審查者**：${rev}`,
  '- **預計修改的共享檔案**：無',
  '- **這支若完全失敗，最糟失去什麼**：無',
].join('\n');

test('欄位閘｜**加註文字不可以讓同一人變成兩個人**（第一版就是這樣被繞過的）', () => {
  // ⚠️ 第一版用原字串比對是否同一人，於是「Claude」與「Claude（已看過）」被當成不同人 → 通過。
  //    這道閘最核心的那一條（沒有人可以放行自己的產出）當場失效。
  for (const decorated of ['Claude（已看過）', 'Claude (reviewed)', '`Claude`', '**Claude**', ' Claude ']) {
    const problems = problemsOf(bodyWith('Claude', decorated));
    assert.ok(problems.some((x) => x.includes('沒有任何一份產出可以由寫它的人放行')),
      `「Claude」對上「${decorated}」沒有被判成同一人——加註／格式就能繞過自審檢查。實得：${problems.join('；') || '（零條）'}`);
  }
});

test('欄位閘｜含有角色名 ≠ 就是那個角色（NotClaude／多人並列都要擋）', () => {
  for (const bogus of ['NotClaude', 'Claude and Codex', 'Claude/Codex', '不是 Claude', 'Claudia']) {
    const problems = problemsOf(bodyWith(bogus, 'Codex'));
    assert.ok(problems.some((x) => x.includes('必須剛好是')),
      `「${bogus}」被當成合法角色放行了——用 includes 判斷等於把 fail-open 寫進閘裡。實得：${problems.join('；') || '（零條）'}`);
  }
});

test('欄位閘｜合法的裝飾寫法不可以誤擋（粗體、反引號、前後空白）', () => {
  for (const [impl, rev] of [['`Claude`', 'Codex'], ['**Claude**', '**Codex**'], [' Claude ', 'Codex ']]) {
    assert.deepEqual(problemsOf(bodyWith(impl, rev)), [],
      `合法寫法「${impl}／${rev}」被誤擋了——噪音型誤擋會讓人繞過這道閘`);
  }
});

test('角色正規化｜看不出來就回 null，不猜', () => {
  assert.equal(canonicalRole('Claude'), 'Claude');
  assert.equal(canonicalRole('**Codex**'), 'Codex');
  assert.equal(canonicalRole('William（產品）'), 'William');
  for (const bad of ['', '某人', 'NotClaude', 'Claude and Codex', 'AI']) {
    assert.equal(canonicalRole(bad), null, `「${bad}」不該被猜成某個角色`);
  }
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

// ── 欄位閘的藏法（Codex #379 r2〜r4）───────────────────────────────

test('欄位閘｜**假欄位名不可以冒充真欄位**（`非實作者` 也曾被判成「實作者」）', () => {
  // ⚠️ Codex #379 r2 High①：欄位抽取沒有錨定在行首，於是整份 PR 說明一個真欄位都沒有，
  //    卻被判「欄位齊全」＝機械閘 fail-open。
  const fake = REQUIRED_FIELDS.map((f) => `- **非${f}**：Claude`).join('\n');
  const problems = problemsOf(fake);
  assert.ok(problems.length >= REQUIRED_FIELDS.length,
    `全部是假欄位名卻通過了（實得 ${problems.length} 條問題）——欄位抽取沒有錨定行首`);
});

test('欄位閘｜括號裡藏第二個角色 → 看不出是誰（含全形與零寬藏法）', () => {
  // ⚠️ r2 只擋得住半形寫法：括號內的檢查用**原字串**，於是全形 `（Ｃｏｄｅｘ）` 與
  //    零寬 `（Co<U+200B>dex）` 都溜過去——括號被整段剝掉，剩下乾淨的 `Claude`（Codex #379 r3）。
  //    根因是「同一個字串有兩種形式在流動」。現在 NFKC ＋ 去除 \p{Cf} 做在**最前面、只做一次**。
  for (const sneaky of [
    'Claude（Codex）', 'Claude (Codex)', 'Codex（Claude 也看了）',
    'Claude（Ｃｏｄｅｘ）',          // 全形
    'Claude（Co​dex）',        // 零寬空白插在中間
    'Ｃｌａｕｄｅ（Ｃｏｄｅｘ）',    // 兩邊都全形
    // ── Codex #379 r4 的四種：\p{Cf} 擋不住的那一群 ──
    'Claude（Co͏dex）',       // U+034F 組合接合符（Mn，不在 Cf 裡——r4 就是這樣繞過 r3）
    'Claude（Co️dex）',       // U+FE0F 變體選擇符（default-ignorable）
    'Claude（Códex）',       // U+0301 組合重音（NFKD＋去 Mark 才折得掉）
    'Claude（Сodex）',        // 西里爾 С——螢幕上跟拉丁 C 一樣；混用文字系統整欄 fail-closed
    // ⚠️ U+2065（未指派、保留給未來格式字元）＝**只有 Default_Ignorable 那層擋得住**：
    //    不是 Mark、不是 Cf、也不是字母（所以 mixed-script 不觸發）。突變實測拿掉 DI 層時
    //    上面四種全部照樣被 M 層擋住——沒有這個探針，DI 層是一層沒有考題盯著的防線。
    'Claude（Co⁥dex）',
  ]) {
    const problems = problemsOf(bodyWith(sneaky, 'William'));
    assert.ok(problems.length > 0,
      `「${sneaky}」被剝成單一角色而通過——括號內的檢查必須看**正規化後**的字串`);
  }
});

test('欄位閘｜正規化之後，換個字形不能變成另一個人（自審檢查才是重點）', () => {
  // 把 NFKC 提前的副作用：裸全形 `Ｃｌａｕｄｅ` 現在會被接受（r2 版是 fail-closed 擋掉）。
  // **那是刻意的**——擋掉只是「看不懂所以擋」，接受並正規化才能認出「這兩欄其實是同一個人」。
  for (const [impl, rev, label] of [
    ['Ｃｌａｕｄｅ', 'Claude', '全形 vs 半形'],
    ['Cla​ude', 'Claude', '零寬 vs 乾淨'],
    ['ＣＬＡＵＤＥ', 'claude', '全形大寫 vs 半形小寫'],
  ]) {
    const problems = problemsOf(bodyWith(impl, rev));
    assert.ok(problems.some((x) => x.includes('由寫它的人放行')),
      `「${label}」沒有被判成同一人——換個字形就能自審放行`);
  }
  assert.deepEqual(problemsOf(bodyWith('Ｃｌａｕｄｅ', 'Codex')), [],
    '全形寫法配上不同角色被誤擋了——噪音型誤擋會讓人乾脆繞過這道閘');
});

test('欄位閘｜有序清單是合法填法，引用範例不是', () => {
  const rows = (bullet) => REQUIRED_FIELDS
    .map((f, i) => `${bullet(i)} **${f}**：${f === '實作者' ? 'Claude' : f === '獨立審查者' ? 'Codex' : '無'}`)
    .join('\n');
  assert.deepEqual(problemsOf(rows((i) => `${i + 1}.`)), [],
    '有序清單 `1. **實作者**：` 被誤擋了——用 1. 而不是 - 顯然不是想規避什麼，'
    + '而噪音型誤擋會讓人乾脆繞過這道閘');
  assert.ok(problemsOf(rows(() => '> -')).length >= REQUIRED_FIELDS.length,
    '引用區塊（`> - **實作者**：`）被當成真的填寫了——那是引用範例，不該滿足這道閘');
});

test('欄位閘｜混用文字系統 fail-closed，但純中文註記不可誤擋', () => {
  // 西里爾 С 這類同形字**正規化折不掉**（它就是另一個字母）。不做 confusable 對照表
  //（表列不完——r1 列字串、r2 列形狀、r3 列名字，同型病不犯第四次），改成劃界：
  // 角色名全是拉丁字母，欄位裡「拉丁詞夾非拉丁、非漢字的字母」沒有正當理由 → 整欄看不出是誰。
  const cyr = problemsOf(bodyWith('Сlaude', 'Codex'));   // 整個字用西里爾 С 開頭
  assert.ok(cyr.length > 0, '西里爾同形字冒充角色名沒有被擋');
  assert.deepEqual(problemsOf(bodyWith('Claude（已看過）', 'Codex')), [],
    '中文括號註記被誤擋——噪音型誤擋會讓人乾脆繞過這道閘');
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
