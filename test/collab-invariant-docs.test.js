// 協作不變量的**落地**考題（2026-08-02 文件體檢）。
//
// ## 這個檔案在防什麼
//
// 「沒有任何一份產出，由寫它的人做正式複審與放行」是三方協作的唯一不變量。
// 但它原本**只寫在 `CODEX-REVIEW.md`**，而 `CLAUDE.md` 給 Claude 的指示是「先讀 AGENTS.md」——
// **規則在一份檔案、執行在另一份檔案 ⇒ 規則等於不存在**。
//
// 這個病 `test/merge-procedure-docs.test.js` 的檔頭已經診斷過一次（刪分支規則失效十九天、
// 兩次事故）。本檔就是不讓它換一條規則重演：**規則要在讀者會讀的那份檔案裡，而且要有考題釘著。**
//
// 另一半是「寫下來 ≠ 會被遵守」：40 支已合併 PR 的 `mergedBy` 全部是同一個帳號、
// GitHub reviews 全部 0 筆，唯一還看得見分工的地方是 PR 說明的欄位——而它靠記憶維持，
// 2026-08-02 實測已經斷了（#374／#375／#376 連續三支漏填）。所以另加一道機械閘
// （`scripts/check-pr-collab-fields.js`），本檔也把那支腳本的判斷釘住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { problemsOf, fieldValue, canonicalRole, REQUIRED_FIELDS }
  from '../scripts/check-pr-collab-fields.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

const INVARIANT = '沒有任何一份產出，由寫它的人做「正式複審與放行」。';

test('不變量必須寫在 AGENTS.md 裡（只寫在 CODEX-REVIEW.md ＝ 只讀 AGENTS 的人看不到）', () => {
  const agents = read('AGENTS.md');
  assert.ok(agents.includes(INVARIANT),
    'AGENTS.md 找不到唯一不變量的原句。\n'
    + '它若只留在 CODEX-REVIEW.md，一個照 CLAUDE.md 指示「先讀 AGENTS.md」的 Claude 完全不會知道'
    + '自己審自己的提案是違規的——這正是 merge-procedure-docs.test.js 診斷過的同一種病。');
  assert.ok(agents.includes('作者自查仍然必須做'),
    'AGENTS.md 少了「這不是禁止自審」的但書——沒有它，這條不變量會跟「轉 ready 前對抗式自審」互相否定');
});

test('五步驟循環的第⑤步不可以寫死「Codex」（模式③下會變成 Codex 審自己）', () => {
  const agents = read('AGENTS.md');
  assert.ok(/⑤ 審實作 \| \*\*實作者以外的那一方\*\*/.test(agents),
    'AGENTS.md 的第⑤步不是「實作者以外的那一方」。寫死 Codex 的話，'
    + 'William 指派 Codex 實作時（模式③）就變成 Codex 複審自己的產出＝違反唯一不變量');
});

test('角色表要寫明 Claude 也複審 Codex 的實作（2026-07-30 起的常態，原本表上沒有）', () => {
  const agents = read('AGENTS.md');
  const claudeRow = agents.split('\n').find((l) => l.startsWith('| Claude |')) || '';
  // ⚠️ **只斷言「這一列有『複審』兩個字」會假綠**（2026-08-02 突變實測）：
  //    同一列的「不負責」欄有「**不**複審自己實作的支」，否定句照樣命中。
  //    要看的是**主要責任那一格**（第 2 欄），而且要求是完整的正面敘述。
  const claudeDuty = claudeRow.split('|')[2] || '';
  assert.ok(/複審\s*Codex\s*實作/.test(claudeDuty),
    '角色表的 Claude「主要責任」欄沒有「複審 Codex 實作」。這張表是新人與新 AI 第一眼看的權威表——'
    + '照舊表理解，Claude 只會實作、Codex 只會審查，遇到 Codex 開的 PR 會不知道該做什麼，'
    + `最省事的做法就是直接合併。實得責任欄：${claudeDuty.slice(0, 140)}`);
  const codexRow = agents.split('\n').find((l) => l.startsWith('| Codex |')) || '';
  const codexNo = codexRow.split('|')[3] || '';   // 同理：要看「不負責」那一格，不是整列
  assert.ok(/不複審[^|]*自己實作/.test(codexNo),
    `角色表 Codex 的「不負責」欄沒寫明「不複審自己實作的支」。實得：${codexNo.slice(0, 160)}`);
});

test('兩份規則書要互相指得到（指標死掉＝又變成兩份各說各話）', () => {
  const agents = read('AGENTS.md');
  const codexReview = read('CODEX-REVIEW.md');
  assert.ok(agents.includes('CODEX-REVIEW.md'), 'AGENTS.md 沒有指向 CODEX-REVIEW.md（展開版與操作細節在那裡）');
  assert.ok(codexReview.includes('AGENTS.md'), 'CODEX-REVIEW.md 沒有指回 AGENTS.md');
});

test('2026-07-10 那節過期的「審查分工」不可以再出現（它擺在最像結論的位置）', () => {
  const agents = read('AGENTS.md');
  for (const stale of ['使用者＝守門者', '把 Codex 的審查**原文**交給 Claude']) {
    assert.ok(!agents.includes(stale),
      `AGENTS.md 仍有已過期的舊分工敘述「${stale}」。\n`
      + '2026-07-27 起 Claude 自己跑 codex CLI（#294），沒有「使用者轉交審查原文」這一步了。'
      + '舊規則用完整、絕對的語氣寫在最後一節＝讀起來像總結，讀者沒有理由懷疑。');
  }
});

// ── PR 協作欄位的機械閘 ──────────────────────────────────────

test('PR 模板存在，且五個必填欄位都在裡面', () => {
  const tpl = read('.github/pull_request_template.md');
  for (const f of REQUIRED_FIELDS) {
    assert.ok(tpl.includes(f), `PR 模板少了必填欄位「${f}」——模板與腳本的清單走散了`);
  }
});

test('欄位閘｜五欄齊全且實作者 ≠ 審查者 → 通過', () => {
  const body = [
    '## 協作欄位', '',
    '- **實作者**：Claude',
    '- **獨立審查者**：Codex',
    '- **基準版本**：`abc1234`',
    '- **預計修改的共享檔案**：AGENTS.md',
    '- **這支若完全失敗，最糟失去什麼**：文件回到今天早上的樣子',
  ].join('\n');
  assert.deepEqual(problemsOf(body), []);
});

test('欄位閘｜**模板原封不動送出去必須不通過**（填寫說明都在 HTML 註解裡）', () => {
  // ⚠️ 這題是這道閘的核心：不剝註解的話，空模板也會「找得到欄位名」而放行＝閘等於沒有。
  //    同型的病：#353 r1 的考題只掃文件關鍵字，被「把指令搬進 HTML 註解」直接繞過（3/3 綠）。
  const tpl = read('.github/pull_request_template.md');
  const problems = problemsOf(tpl);
  assert.ok(problems.length >= REQUIRED_FIELDS.length,
    `空模板應該被判五欄皆缺，實得 ${problems.length} 條：${problems.join('；')}`);
});

test('欄位閘｜實作者與審查者是同一個人 → 不通過（這是它存在的全部理由）', () => {
  const body = [
    '- **實作者**：Codex',
    '- **獨立審查者**：Codex',
    '- **基準版本**：abc1234',
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
  for (const f of ['基準版本', '預計修改的共享檔案', '這支若完全失敗，最糟失去什麼']) {
    assert.ok(problems.some((p) => p.includes(f)), `沒有點名缺少的「${f}」`);
  }
});

test('欄位閘｜角色寫成看不懂的字串要被點名（避免「已填」但填了廢話）', () => {
  const body = [
    '- **實作者**：某人',
    '- **獨立審查者**：Codex',
    '- **基準版本**：abc1234',
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
  '- **基準版本**：abc1234',
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

// ── 本檔不可以重述合併步驟（重述的摘要會落後）─────────────────

test('AGENTS.md 的代合併段落要點名三道守門，且不重述步驟（Codex #379 r1 High②）', () => {
  const agents = read('AGENTS.md');
  const i = agents.indexOf('不論誰執行，一律走');
  assert.ok(i > 0, 'AGENTS.md 找不到代合併的指標段落');
  const block = agents.slice(i, i + 700);
  for (const must of ['check-pr-collab-fields.js', 'check-pr-merge-gate.js', 'Reviewed-By', 'Merged-By']) {
    assert.ok(block.includes(must),
      `AGENTS.md 的代合併段落沒有點名「${must}」。\n`
      + '這一段刻意不重述步驟（重述的摘要會落後，讀者照 AGENTS 執行就剛好跳過新加的關卡——'
      + '那正是這一節在修的病），但**三道守門的名字必須在**，否則指標等於沒有內容。');
  }
});

test('舊的「五步驟合併」說法不可以再出現（掃法要夠廣——只掃三個字串已經漏掉一處）', () => {
  // ⚠️ 這題的第一版只掃三個固定字串，結果**漏掉 `五步驟＝確認審查結論…` 那種寫法**
  //    （Codex #379 r2 High②，同一種漂移的第三次）。改成掃「五步驟」出現在合併語境裡的**任何**形式。
  for (const f of ['AGENTS.md', 'CODEX-REVIEW.md']) {
    const txt = read(f);
    for (const [i, line] of txt.split('\n').entries()) {
      // 「五步驟審查循環」是另一件事，五步是對的——只放行明確講「審查循環」的那些
      const mentionsFive = /五步驟|五個步驟/.test(line);
      if (!mentionsFive) continue;
      const isReviewCycle = /五步驟審查循環|五步驟表|審查循環/.test(line);
      assert.ok(isReviewCycle,
        `${f}:${i + 1} 在合併語境提到「五步驟」：\n  ${line.trim().slice(0, 160)}\n`
        + '合併程序 2026-08-02 起是**六**步驟（多了協作欄位閘）。'
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
    + '這一段刻意只留指標＋三道守門的名字：摘要會落後，名字不會。');
});

test('欄位閘｜**假欄位名不可以冒充真欄位**（`非實作者` 也曾被判成「實作者」）', () => {
  // ⚠️ Codex #379 r2 High①：欄位抽取沒有錨定在行首，於是整份 PR 說明一個真欄位都沒有，
  //    卻被判「五欄齊全」＝機械閘 fail-open。
  const fake = REQUIRED_FIELDS.map((f) => `- **非${f}**：Claude`).join('\n');
  const problems = problemsOf(fake);
  assert.ok(problems.length >= REQUIRED_FIELDS.length,
    `全部是假欄位名卻通過了（實得 ${problems.length} 條問題）——欄位抽取沒有錨定行首`);
});

test('欄位閘｜括號裡藏第二個角色 → 看不出是誰（含全形與零寬藏法）', () => {
  // ⚠️ r2 只擋得住半形寫法：括號內的檢查用**原字串**，於是全形 `（Ｃｏｄｅｘ）` 與
  //    零寬 `（Co\u200bdex）` 都溜過去——括號被整段剝掉，剩下乾淨的 `Claude`（Codex #379 r3）。
  //    根因是「同一個字串有兩種形式在流動」。現在 NFKC ＋ 去除 \p{Cf} 做在**最前面、只做一次**。
  for (const sneaky of [
    'Claude（Codex）', 'Claude (Codex)', 'Codex（Claude 也看了）',
    'Claude（Ｃｏｄｅｘ）',          // 全形
    'Claude（Co\u200bdex）',        // 零寬空白插在中間
    'Ｃｌａｕｄｅ（Ｃｏｄｅｘ）',    // 兩邊都全形
    // ── Codex #379 r4 的四種：\p{Cf} 擋不住的那一群 ──
    'Claude（Co\u034Fdex）',       // U+034F 組合接合符（Mn，不在 Cf 裡——r4 就是這樣繞過 r3）
    'Claude（Co\uFE0Fdex）',       // U+FE0F 變體選擇符（default-ignorable）
    'Claude（Co\u0301dex）',       // U+0301 組合重音（NFKD＋去 Mark 才折得掉）
    'Claude（\u0421odex）',        // 西里爾 С——螢幕上跟拉丁 C 一樣；混用文字系統整欄 fail-closed
    // ⚠️ U+2065（未指派、保留給未來格式字元）＝**只有 Default_Ignorable 那層擋得住**：
    //    不是 Mark、不是 Cf、也不是字母（所以 mixed-script 不觸發）。突變實測拿掉 DI 層時
    //    上面四種全部照樣被 M 層擋住——沒有這個探針，DI 層是一層沒有考題盯著的防線。
    'Claude（Co\u2065dex）',
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
    ['Cla\u200bude', 'Claude', '零寬 vs 乾淨'],
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

test('trailer 格式要涵蓋三個角色（模板允許 William 當審查者，格式卻不允許＝逼人寫假的）', () => {
  const cr = read('CODEX-REVIEW.md');
  const i = cr.indexOf('Reviewed-By:');
  assert.ok(i > 0, 'CODEX-REVIEW.md 找不到 Reviewed-By trailer 的格式說明');
  const line = cr.slice(i, cr.indexOf('\n', i));
  assert.ok(line.includes('William'),
    `Reviewed-By 的格式沒有列 William，但模板與 check-pr-collab-fields.js 都允許他當獨立審查者。\n`
    + '格式與規則不一致會逼人在「照實寫」與「照格式寫」之間二選一，兩種選擇都讓稽核軌跡失真。\n'
    + `實得：${line}`);
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

// ── CI 的協作欄位閘（2026-08-02）─────────────────────────────

test('CI 有協作欄位閘這個 job，且跑的是與人工同一支腳本（不可另寫一份判斷）', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes('collab-fields'), 'ci.yml 沒有 collab-fields job——協作欄位閘沒有進 CI，只剩「記得跑」');
  // ⚠️ **只查「檔案裡有沒有這個字串」會假綠**（2026-08-02 突變實測）：
  //    檔頭註解裡就寫著那個路徑，所以把實際的 `run:` 換成別的東西照樣通過。
  //    要查的是**真的有一行 `run:` 在執行它**。
  const runsScript = ci.split('\n').some((l) =>
    /^\s*run:\s*.*node\s+scripts\/check-pr-collab-fields\.js/.test(l));
  assert.ok(runsScript,
    'CI 沒有任何一行 `run:` 真的執行 scripts/check-pr-collab-fields.js。\n'
    + '⚠️ 不可以在 CI 裡另寫一份判斷邏輯——兩份會漂移，而「規則兩份、各說各話」正是本專案的招牌病。');
  assert.ok(/if:\s*github\.event_name\s*==\s*'pull_request'/.test(ci),
    'collab-fields 沒有限定只在 PR 上跑——push 到 main 時沒有 PR 編號可查，會無謂地紅');
});

test('分支保護文件裡的 check 名稱，必須與 ci.yml 的 job 名稱**逐字相同**', () => {
  // ⚠️ 這題防的是一個會「永遠卡住合併」的坑：分支保護的 required check 是**按名稱字串**比對的。
  //    改了 ci.yml 的 name 而沒改分支保護，GitHub 會一直等一個永遠不會出現的 check。
  //    文件是我們這邊唯一的紀錄（GitHub 設定本身不進版控），所以至少讓兩邊字串對得起來。
  const ci = read('.github/workflows/ci.yml');
  const doc = read('docs/GitHub分支保護-設定與驗證.md');
  const names = [...ci.matchAll(/^\s{4}name:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.ok(names.length >= 3, `ci.yml 只解析到 ${names.length} 個 job 名稱，預期至少 3 個：${names.join('｜')}`);
  for (const n of names) {
    assert.ok(doc.includes(n),
      `分支保護文件裡找不到 CI 的 job 名稱「${n}」。\n`
      + '兩邊名稱走散時，required check 會變成「等一個永遠不會出現的 check」＝永遠卡住合併。');
  }
});

test('分支保護文件要記下「enforce_admins 必須開」與它的理由', () => {
  const doc = read('docs/GitHub分支保護-設定與驗證.md');
  assert.ok(doc.includes('enforce_admins'), '文件沒提 enforce_admins');
  assert.ok(/逃生門.*強制力|強制力.*逃生門/.test(doc),
    '文件沒記下那一課：**單一身分下，逃生門與強制力是同一個開關**。\n'
    + '關掉 enforce_admins 不只 William 能繞過——三方共用同一個 token，'
    + '等於我們每天的每一次操作都在繞過，規則零強制力。實測當場打臉過（兩個空 commit 直接進 main）。');
});
