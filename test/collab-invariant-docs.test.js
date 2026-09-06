// 協作不變量的**落地**考題（2026-08-02 文件體檢）。
//
// ## 這個檔案在防什麼
//
// 「沒有任何一份產出，由寫它的人做正式複審與放行」是三方協作的唯一不變量。
// 但它原本**只寫在 `REVIEW-AND-MERGE.md`**，而 `CLAUDE.md` 給 Claude 的指示是「先讀 AGENTS.md」——
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
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { problemsOf, fieldValue, canonicalRole, staleBaseProblems, REQUIRED_FIELDS }
  from '../scripts/check-pr-collab-fields.js';
import { gatesRunInMergeSteps } from './helpers/merge-gates.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

const INVARIANT = '沒有任何一份產出，由寫它的人做「正式複審與放行」。';

test('不變量必須寫在 AGENTS.md 裡（只寫在 REVIEW-AND-MERGE.md ＝ 只讀 AGENTS 的人看不到）', () => {
  const agents = read('AGENTS.md');
  assert.ok(agents.includes(INVARIANT),
    'AGENTS.md 找不到唯一不變量的原句。\n'
    + '它若只留在 REVIEW-AND-MERGE.md，一個照 CLAUDE.md 指示「先讀 AGENTS.md」的 Claude 完全不會知道'
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
  const codexReview = read('REVIEW-AND-MERGE.md');
  assert.ok(agents.includes('REVIEW-AND-MERGE.md'), 'AGENTS.md 沒有指向 REVIEW-AND-MERGE.md（展開版與操作細節在那裡）');
  assert.ok(codexReview.includes('AGENTS.md'), 'REVIEW-AND-MERGE.md 沒有指回 AGENTS.md');
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

// ── 基準版本必須釘住目前 head（Codex #382 r4）──────────────────

const HEAD = 'f76d12b20cc55f6f608ce043051e2fa4a969cffe';
/** @param {string} sha */
const bodyWithBase = (sha) => [
  '- **實作者**：Claude',
  '- **獨立審查者**：Codex',
  `- **基準版本**：\`${sha}\``,
  '- **預計修改的共享檔案**：無',
  '- **這支若完全失敗，最糟失去什麼**：無',
].join('\n');

test('欄位閘｜基準版本對得上目前 head → 通過', () => {
  assert.deepEqual(staleBaseProblems(bodyWithBase('f76d12b'), HEAD), []);
  assert.deepEqual(staleBaseProblems(bodyWithBase(HEAD), HEAD), [], '寫完整 40 碼也要算對');
});

test('欄位閘｜**審完之後又推了新 commit** → 不通過（這個欄位存在的全部理由）', () => {
  // ⚠️ 這一條在 #382 r4 之前是**擺著好看的**：模板明寫它是「審查要釘住的 commit，
  //    分支被推過之後審查結論就失效了」，但閘只檢查非空。
  //    最常見的路徑（審完 A、作者再推 B，完全不必是惡意）就讓「已審查」變成過期的宣稱。
  const problems = staleBaseProblems(bodyWithBase('4cbef24'), HEAD);
  assert.ok(problems.length > 0, '基準版本是舊 SHA 卻通過了——那這個欄位等於裝飾');
  assert.match(problems[0], /目前的 head/);
});

test('欄位閘｜基準版本裡**每一個** SHA 都要是目前 head（順序不該影響結果）', () => {
  // ⚠️ Codex #382 r5：第一版只抓第一段十六進位。
  //    `d6c4fbd / f76d12b` 通過、反過來寫卻被拒 ⇒ 結果取決於排列順序，那不是判準。
  for (const v of ['f76d12b / d6c4fbd', 'd6c4fbd / f76d12b']) {
    assert.ok(staleBaseProblems(bodyWithBase(v).replace(/`/g, ''), HEAD).length > 0,
      `「${v}」混了舊 SHA 卻通過了`);
  }
});

test('欄位閘｜顯示值更新、連結還指著舊 commit → 不通過（很常見的手滑）', () => {
  const link = '[d6c4fbd](https://github.com/x/y/commit/f76d12b20cc55f6f608ce043051e2fa4a969cffe)';
  assert.ok(staleBaseProblems(bodyWithBase(link).replace(/`/g, ''), HEAD).length > 0,
    '連結指著舊 commit 卻通過了——這正是這個欄位要防的東西');
});

test('欄位閘｜不是合法 SHA 的長十六進位串 → 不通過', () => {
  assert.ok(staleBaseProblems(bodyWithBase(HEAD + 'a').replace(/`/g, ''), HEAD).length > 0,
    '41 碼十六進位（不是合法 SHA）卻通過了');
});

test('欄位閘｜基準版本填了看不出 SHA 的東西 → 不通過（不猜）', () => {
  for (const junk of ['（待補）', 'main', '最新版', '']) {
    assert.ok(staleBaseProblems(bodyWithBase(junk).replace(/`/g, ''), HEAD).length > 0,
      `基準版本填「${junk}」被放行了`);
  }
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

/**
 * 合併程序**實際用到的機械閘**，從 `REVIEW-AND-MERGE.md` 的合併步驟區塊反查。
 *
 * ⚠️ **不要在這裡手寫名單**（Codex #385 r9 抓的）：原本寫死三個名字，
 * 於是 #385 加了第四道閘（`check-review-verdicts.js`）之後，AGENTS.md 兩處
 * 仍叫讀者「只記住三道守門」，而**考題把舊名單當契約，44 題全綠也看不見**。
 * 這正是本節在修的那個病，我在修它的同一支 PR 裡又犯一次。
 * ⇒ 真相只有一個地方：合併步驟本身。它提到幾道，AGENTS 的摘要就要點名幾道。
 */
async function selfDeclaredGates() {
  const files = readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.startsWith('check-') && f.endsWith('.js'));
  const gates = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(ROOT, 'scripts', f)).href);
    if (!mod.MERGE_GATE) continue;
    const g = mod.MERGE_GATE;
    // ⚠️ 形狀要驗（Codex #385 r11）：`MERGE_GATE = true` 原本也能通過，
    //    那等於「自報」這件事本身沒有內容。
    assert.equal(typeof g, 'object', `scripts/${f} 的 MERGE_GATE 不是物件（要 { name, why }）`);
    for (const k of ['name', 'why']) {
      assert.ok(typeof g[k] === 'string' && g[k].trim(),
        `scripts/${f} 的 MERGE_GATE.${k} 要是非空字串——自報沒有內容就不算自報`);
    }
    gates.push({ file: `scripts/${f}`, ...g });
  }
  return gates;
}


// ## ⚠️ 誠實劃界：這份註冊表只管**盤點**，不管閘**有沒有用**
//
// 它保證的是「有幾道閘」這件事在腳本、合併步驟、AGENTS 摘要三邊一致。
// 它**證明不了**某一道閘真的會擋——一支自報、文件同步、但實際永遠 `return 0` 的假閘照樣通過這題。
// 閘的行為要靠各自的端到端考題（`merge-gate.test.js`／`review-verdicts-cli.test.js` 的假 `gh` 出口題）。
// 這一點是 Codex #385 r11 要求寫明的，因為「有註冊表」很容易被誤讀成「閘都有效」。

test('⭐ 每一道自報的合併閘，都必須出現在合併步驟與 AGENTS 的兩處摘要裡（#379 r1／#385 r9・r10・r11）', async () => {
  // ⚠️ **雙向集合相等**（Codex #385 r11）：只驗「自報者 → 步驟」的話，
  //    複製一支真的閘、拿掉 `MERGE_GATE`、把指令加進步驟、文件完全不更新 ⇒ 34/34 全綠。
  //    （原本還有一條 `gates.length >= 3` 的地板：加進第四支之後，
  //      拿掉既有某支的標記照樣過——**會隨著新增而自己失效的下限，不是判準**。）
  const gates = await selfDeclaredGates();
  const declared = gates.map((g) => g.file).sort();
  const run = gatesRunInMergeSteps().sort();
  assert.deepEqual(declared, run,
    '「自報是合併閘的腳本」與「合併步驟裡實際被執行的閘」對不起來。\n'
    + `  自報：${declared.join('、') || '（無）'}\n`
    + `  步驟裡實際跑：${run.join('、') || '（無）'}\n`
    + '⚠️ 兩個方向都要擋：自報卻沒人跑＝「有腳本」會讓人以為守住了；\n'
    + '   有人跑卻沒自報＝沒有人數得到它，文件漂了也不會紅。');
  const names = gates.map((g) => g.file.replace('scripts/', ''));
  const agents = read('AGENTS.md');
    // ⚠️ 錨點**不可以含數字**（Codex #385 r12 Medium）：原本寫死「但四道不可跳過的守門」，
  //    於是新增第五道之後，文件仍寫「四道」照樣全綠——**數字本身就是會漂的東西**。
  for (const anchor of ['不論誰執行，一律走', '不可跳過的守門要在這裡點名得出來']) {
    const i = agents.indexOf(anchor);
    assert.ok(i > 0, `AGENTS.md 找不到指標段落：「${anchor}」`);
    const block = agents.slice(i, i + 900);
    for (const must of [...names, 'Reviewed-By', 'Merged-By']) {
      assert.ok(block.includes(must),
        `AGENTS.md 的「${anchor}」段落沒有點名「${must}」。\n`
        + '⚠️ 這一段刻意不重述步驟（重述的摘要會落後，讀者照 AGENTS 執行就剛好跳過新加的關卡——\n'
        + '   那正是這一節在修的病），但**每一道守門的名字必須在**，否則指標等於沒有內容。\n'
        + `   目前自報的閘：${names.join('、')}`);
    }
  }
});

test('舊的「五步驟合併」說法不可以再出現（掃法要夠廣——只掃三個字串已經漏掉一處）', () => {
  // ⚠️ 這題的第一版只掃三個固定字串，結果**漏掉 `五步驟＝確認審查結論…` 那種寫法**
  //    （Codex #379 r2 High②，同一種漂移的第三次）。改成掃「五步驟」出現在合併語境裡的**任何**形式。
  for (const f of ['AGENTS.md', 'REVIEW-AND-MERGE.md']) {
    const txt = read(f);
    for (const [i, line] of txt.split('\n').entries()) {
      // 「五步驟審查循環」是另一件事，五步是對的——只放行明確講「審查循環」的那些
      const mentionsFive = /五步驟|五個步驟/.test(line);
      if (!mentionsFive) continue;
      const isReviewCycle = /五步驟審查循環|五步驟表|審查循環/.test(line);
      assert.ok(isReviewCycle,
        `${f}:${i + 1} 在合併語境提到「五步驟」：\n  ${line.trim().slice(0, 160)}\n`
        + '合併步驟清單不得稱為五步（實際步數以 REVIEW-AND-MERGE.md 合併步驟的清單為準，這裡刻意不寫死）。'
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
    + '這一段刻意只留指標＋各道守門的名字（幾道刻意不寫死）：摘要會落後，名字不會。');
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
  const cr = read('REVIEW-AND-MERGE.md');
  const i = cr.indexOf('Reviewed-By:');
  assert.ok(i > 0, 'REVIEW-AND-MERGE.md 找不到 Reviewed-By trailer 的格式說明');
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


const GATE_WF = '.github/workflows/collab-fields.yml';
const WF_DIR = '.github/workflows';

/**
 * 迷你 YAML 讀取器——**只夠讀我們自己寫的 workflow**（無 anchor、無多行純量、無引號逃逸）。
 * 本專案零執行時相依，不裝 YAML 套件；而這裡需要的是「把形狀讀出來」，不是通用剖析。
 *
 * ⚠️ **為什麼非得讀出整個形狀**（r2 的教訓）：r2 版只鎖 `run:` 那一行與 `continue-on-error`，
 * Codex 立刻示範了五種「閘根本沒跑、考題卻 30/30 全綠」的寫法——
 * job 加 `if: ${{ false }}`／step 加 `if: ${{ false }}`／`needs:` 一個會失敗的前置 job／
 * 自訂 `shell` 在外層吞退出碼／更早的 step 用 `actions/github-script` 把腳本覆寫成 `process.exit(0)`。
 * （被 skip 的 job，GitHub 對 required check 回報的是 **Success**。）
 *
 * **列舉這些寫法補不完**——xlsx 護欄已經證明過列舉會連漏三輪。
 * 所以改成**關門**：解析成物件，整個形狀 `deepEqual` 一份預期值。多一個 key、少一個 key、
 * 多一個 step、step 換順序，全部紅。要改這道閘的形狀＝**必須刻意改考題**。
 * @param {string} text
 */
function parseYaml(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l));
  let i = 0;
  const indentOf = (/** @type {string} */ l) => (/^ */.exec(l) || [''])[0].length;

  /** @param {number} indent @returns {any} */
  function block(indent) {
    if (/^\s*-\s/.test(lines[i])) {
      const out = [];
      while (i < lines.length && indentOf(lines[i]) === indent && /^\s*-\s/.test(lines[i])) {
        const rest = (/^\s*-\s*(.*)$/.exec(lines[i]) || ['', ''])[1];
        lines[i] = ' '.repeat(indent + 2) + rest;
        out.push(block(indent + 2));
      }
      return out;
    }
    /** @type {Record<string, any>} */
    const out = {};
    while (i < lines.length && indentOf(lines[i]) === indent && !/^\s*-\s/.test(lines[i])) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(lines[i]);
      assert.ok(m, `workflow 有這支迷你讀取器看不懂的一行（請改回單純的 key: value）：${lines[i]}`);
      const key = m[1].trim();
      const val = m[2].trim();
      i += 1;
      if (val !== '') { out[key] = val; continue; }
      out[key] = (i < lines.length && indentOf(lines[i]) > indent) ? block(indentOf(lines[i])) : null;
    }
    return out;
  }
  const doc = block(0);
  assert.equal(i, lines.length, `workflow 沒被完整讀完（停在第 ${i + 1} 行）：${lines[i]}`);
  return doc;
}

/**
 * 這道閘唯一合法的**整份 workflow** 形狀。改它＝刻意的決定，不是順手。
 *
 * ⚠️ **為什麼是整份、不是只有那個 job**（r3 的教訓，同型錯誤第三次）：
 * r2 我把門關在 `run:` 那一行 → job 的形狀還敞開；
 * r3 我把門關在 job 上 → **workflow 根層還敞開**。Codex 實測在根層加：
 *
 *     defaults:
 *       run:
 *         shell: bash -c 'bash "$1" || true' -- {0}
 *
 * 內層 `exit 7` 被轉成 0、閘永遠放行，而考題 29/29 全綠——因為 job 物件確實一模一樣。
 * **每次只關一層，外面那層就是下一個洞。** 所以改成整份 deepEqual：
 * 根層多一個 `defaults`／`env`／`concurrency`，或 `on` 的形狀變了，全部紅。
 *
 * ⚠️ `types` 刻意比對**原始的 flow sequence 字串**：寫成 `types: opened, edited, …`
 * （沒有方括號的純量）是合法 YAML 但語意不同，這樣比對就擋得住（r3 的 Low）。
 */
const EXPECTED_WORKFLOW = {
  name: '協作欄位',
  on: { pull_request: { types: '[opened, edited, reopened, synchronize]' } },
  jobs: {
    'collab-fields': {
      name: '協作欄位（實作者 ≠ 獨立審查者）',
      'runs-on': 'ubuntu-latest',
      permissions: { contents: 'read', 'pull-requests': 'read' },
      steps: [
        { uses: 'actions/checkout@v4' },
        { uses: 'actions/setup-node@v4', with: { 'node-version-file': '.node-version' } },
        {
          name: '協作欄位閘（五欄齊全＋實作者 ≠ 獨立審查者）',
          env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
          run: 'node scripts/check-pr-collab-fields.js ${{ github.event.pull_request.number }}',
        },
      ],
    },
  },
};

test('協作欄位閘｜整份 workflow 只認一種形狀（關門，不是列舉繞法）', () => {
  assert.deepEqual(parseYaml(read(GATE_WF)), EXPECTED_WORKFLOW,
    `${GATE_WF} 的形狀變了。這道閘只認一種合法形狀，因為「讓它看起來有跑、實際沒跑」的寫法列舉不完：\n`
    + '  ・job 或 step 加 `if: ${{ false }}`（被 skip 的 job 在 required check 上回報 **Success**）\n'
    + '  ・`needs:` 一個會失敗的前置 job\n'
    + '  ・step 自訂 `shell`、或**根層 `defaults.run.shell`** 在外層吞掉退出碼\n'
    + '  ・更早的 step 用 `actions/github-script` 把腳本覆寫成 `process.exit(0)`\n'
    + '  ・`run:` 尾端接 `|| true`\n'
    + '⚠️ `types` 少了 `edited` 也會在這裡紅——`pull_request:` 預設事件**不含 edited**，\n'
    + '   少了它就能「合法五欄拿綠燈 → 編輯說明撤掉欄位 → commit 沒變、綠燈還在」。\n'
    + '要改這道閘，請連同 EXPECTED_WORKFLOW 一起改——那是刻意的動作。');
});


test('分支保護｜job 名稱跨 workflow 唯一，且與文件逐字相同', () => {
  // ⚠️ 這題防兩個會「永遠卡住合併」的坑：
  //    ①required check 按**名稱字串**比對——改了 name 沒改分支保護＝等一個永遠不會出現的 check。
  //    ②GitHub 要求 required job name 在所有 workflow 之間唯一，否則有歧義（Codex #382 r2 Low）。
  const doc = read('docs/GitHub分支保護-設定與驗證.md');
  // ⚠️ **這裡刻意不用 parseYaml**（Codex #382 r4 Low）：那支迷你讀取器只夠讀我們自己寫的
  //    `collab-fields.yml`（不支援 `run: |` 多行純量、anchor…）。拿它去掃**所有** workflow，
  //    等於哪天有人在無關的 workflow 寫了一個 `run: |`，整套測試就紅——
  //    考題不該對它管不著的檔案設下格式限制。名稱盤點只要「job 層的 name:」，用正則就夠。
  /** @type {string[]} */
  const names = [];
  for (const f of readdirSync(join(ROOT, WF_DIR)).filter((f) => /\.ya?ml$/.test(f))) {
    // 縮排不寫死四格（Codex #382 r5 Low）：合法 YAML 可以用別的縮排。
    // `- name:`（step 的名字）因為 `name:` 前面有 `-` 而自然不會命中——只有 job 層的 key 會。
    for (const m of read(`${WF_DIR}/${f}`).matchAll(/^[ \t]{2,8}name:\s*(.+)$/gm)) names.push(m[1].trim());
  }
  assert.ok(names.length >= 3, `只解析到 ${names.length} 個 job 名稱，預期至少 3 個：${names.join('｜')}`);
  assert.deepEqual([...new Set(names)].sort(), [...names].sort(),
    `有跨 workflow 撞名的 job：${names.join('｜')}\nGitHub 的 required check 按名稱比對，撞名會產生歧義並可能卡住合併。`);
  for (const n of names) {
    assert.ok(doc.includes(n),
      `分支保護文件裡找不到 job 名稱「${n}」。\n`
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

test('工作區方案（實作常設／審查拋棄）：白名單句庫＋出現次數（改任何一份複本都會紅）＋第 6 題「問法與逾時預設」的承重句', () => {
  // 三代被打穿史：v1 關鍵字→覆寫假綠＋誤擋（r2）；v2/v3 解析式→位置顛倒／逃逸／重複-b／
  // 分號注入／續行覆寫（r3/r4，劃界：解析追不上變體空間）；v4 白名單→r5 抓「只驗存在」：
  // 同一句活兩處、改壞一處由另一處滿足 includes ⇒ v5 改**出現次數精確比對**。
  // ⇒ 特性不是缺陷：改這些指令或承重句＝必先來改本考題（變更必經考題）。
  // ⚠️ 誠實劃界：它證明「白名單句在兩份文件各出現規定次數」，證明不了「別處沒有另立
  //    覆寫段落」（歸審查制度）、也證明不了「執行者真的照做」（歸事後稽核與指派詞）。
  const docs = { 'AGENTS.md': read('AGENTS.md'), 'REVIEW-AND-MERGE.md': read('REVIEW-AND-MERGE.md'), 'CLAUDE.md': read('CLAUDE.md') };
  const count = (hay, needle) => hay.split(needle).length - 1;
  const PINS = [
    ['AGENTS.md', '實作＝常設樹、審查＝拋棄式樹、絕不動主目錄', 1],
    ['AGENTS.md', '一句白話問題＋最多三個選項＋我建議的預設＋時限', 1],   // 第 6 題：問法正本只住一處
    ['CLAUDE.md', '「問法與逾時預設」那顆', 1],
    // 第 6 題最危險的邊界：一條「沉默就能導致實作甚至合併」的授權，下面每一句消失都要紅（#577 r1 Medium③）
    ['AGENTS.md', '時限＝**三天**', 1],
    ['AGENTS.md', '不套逾時預設、永遠等他的', 1],
    ['AGENTS.md', '③**任何會讓閘變鬆的事**', 1],
    ['AGENTS.md', '沒有「時限內沒回就當綠」', 1],
    ['AGENTS.md', '⑦**本顆自己的射程、時限與例外清單**', 1],
    ['AGENTS.md', '**Claude 對「先做」的解讀**', 1],
    ['AGENTS.md', '題目本文中他未反對的前提', 1],
    ['AGENTS.md', '**❓ 貼出後不可編輯**', 1],
    ['AGENTS.md', '不准寫「William 拍板／裁示」', 1],
    // 永遠等他的五類各自獨立釘一句（#577 r2：只釘總標籤與③⑦時，其餘五類同時消失考題仍綠）
    ['AGENTS.md', '①「錢的絕對邊界」整節（含規則 4 的通報：沒回也不得試用）', 1],   // ① 錢的絕對邊界
    ['AGENTS.md', '②**金額口徑**——射程＝下方界線表那一列', 1],   // ② 金額口徑
    ['AGENTS.md', '④「明確指派／指名／特准」型授權', 1],   // ④ 指派型授權
    ['AGENTS.md', '⑤畫面驗收與「他點頭」——不是問句，沒有預設可套', 1],   // ⑤ 驗收點頭
    ['AGENTS.md', '⑥事故通報 ⑦', 1],   // ⑥ 事故通報
    ['AGENTS.md', '`git fetch origin && git checkout -B codex/<分支> origin/main`', 1],
    ['AGENTS.md', '功能分支（`git checkout -B codex/<分支> origin/main`）', 1],
    ['AGENTS.md', '`/private/tmp/codex-review-pr<N>`／`/private/tmp/claude-review-pr<N>`', 1],
    ['AGENTS.md', '釘住受審 commit', 2],
    ['AGENTS.md', '在該 PR 的拋棄式審查樹工作、不 checkout 任何分支', 1],
    ['AGENTS.md', '在**常設 `-codex` 實作樹**走分支與 PR', 1],
    ['REVIEW-AND-MERGE.md', '`git fetch origin && git checkout -B codex/<分支> origin/main`', 1],
    ['REVIEW-AND-MERGE.md', '`git worktree add --detach /private/tmp/<角色>-review-pr<N> <受審commit>`', 1],
    ['REVIEW-AND-MERGE.md', '-C "/private/tmp/codex-review-pr<N>"', 1],
    ['REVIEW-AND-MERGE.md', '先 `git check-ignore -v "<審查樹>/node_modules"` 確認', 1],
    ['REVIEW-AND-MERGE.md', '必須等於**提示詞釘選的受審 SHA**', 1],
    ['REVIEW-AND-MERGE.md', 'git diff origin/main...HEAD', 2],
    ['REVIEW-AND-MERGE.md', '不帶斜線＝只刪 symlink', 1],
    ['REVIEW-AND-MERGE.md', '絕不動主目錄', 1],
    ['AGENTS.md', '審查樹由發射者備與收、**審查者不得自建其他 worktree**', 1],
    ['AGENTS.md', '**審查與實作不可以是同一方**', 1],
    ['REVIEW-AND-MERGE.md', '**審查者不得自建其他 worktree**', 1],
    ['REVIEW-AND-MERGE.md', '**要參考另一支 PR＝請發射者另備一棵釘選的審查樹**', 1],
    ['REVIEW-AND-MERGE.md', '**缺＝備樹失敗，停下回報、不要自行 `npm install`**', 1],
    ['AGENTS.md', '由發射者備樹時建、收尾時 unlink，審查者不得自行建立／安裝／移除', 1],
    ['CLAUDE.md', '正式審查的 symlink 一律由發射者備樹時處理', 1],
  ];
  for (const [file, pin, expected] of PINS) {
    const got = count(docs[file], pin);
    assert.equal(got, expected,
      `${file} 的白名單句「${pin}」出現 ${got} 次（規定 ${expected}）——`
      + '要改指令或承重句，先來改本考題的句庫與次數（變更必經考題）');
  }
});

// ⚠️ 為什麼要有這一題：鐵則 10（註解寫「為什麼」不寫「現在是」）是 #417 燒掉七輪換來的，
//    而它守的東西**沒有機械閘**（「這句註解會不會過期」機器判不出來）。沒有本題的話，
//    這條規矩就是一段可以被任何人靜靜刪掉的散文——本專案已認過的病型：護欄什麼都沒做卻回報通過。
//    ⇒ 本題的射程只有一件事：**那條規矩還在 AGENTS.md 上、而且三種禁令都沒被抽掉**。
//    本題**不**證明任何人真的照做（那要靠審查者的眼睛）——這是誠實劃界，不是缺口。
test('鐵則 10「註解寫為什麼、不寫現在是」不可被靜靜刪掉（#417 換來的規矩）', () => {
  const agents = read('AGENTS.md');
  assert.ok(agents.includes('註解寫「為什麼」，不寫「現在是」'),
    'AGENTS.md 少了鐵則 10 的標題句。這條規矩是 #417 r7–r13 七輪退回換來的：'
    + '註解裡每一句「現在的狀況是…」都會過期、會誇大、會被下一個人當事實引用。');
  // ⚠️ 只斷言標題會假綠：把三種禁令抽掉、只留標題，規矩就空了（同族突變 2026-08-02 實測過）
  for (const ban of ['別處的現況', '時態相對的敘述', '沒有考題撐著的保證']) {
    assert.ok(agents.includes(ban),
      `AGENTS.md 鐵則 10 少了「${ban}」這一類禁令——`
      + '三種缺任何一種，那一族就會從下一支 PR 開始復發（#417 三種都踩過）');
  }
  // ⚠️ 這裡**不可以**只斷言「誠實劃界」四個字：AGENTS.md 別處（錢邊界那節）本來就有這四個字，
  //    把鐵則 10 的 ✅ 整段刪掉照樣全綠——我自己第一版就是這樣寫的，突變當場抓到（2026-08-08）。
  //    ⇒ 改成斷言鐵則 10 專屬的那句原文。
  assert.ok(agents.includes('唯一鼓勵寫長的一類'),
    '鐵則 10 少了「✅ 可以寫的」那一半。只留禁令會讓下一個人不敢寫誠實劃界，'
    + '而劃界正是本專案唯一鼓勵寫長的一類註解——把它一起禁掉會製造真的缺口。');
});
