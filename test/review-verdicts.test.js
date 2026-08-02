// @ts-check
// 複審聯集閘的考題（2026-08-02）。
//
// 起因是一場**真實事故**：#383 上出現兩份都自稱「Claude 複審」、結論相反的留言
// （一份「通過，可以合併」、一份「需修改後再審」），而 GitHub 上兩則都是 `teacherjung`。
// 兩份其實都對，只是照的地方不同——一份查版面，一份查金額口徑與資料列格數。
// 危險的不是有兩份，是**看起來一樣有效而結論相反**，於是「最後一則說通過」等於放行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerOf, looksLikeVerdict, verdictProblems, VERDICTS } from '../scripts/check-review-verdicts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HEAD = 'aabbccdd11223344556677889900aabbccddeeff';
const c = (/** @type {string} */ body) => ({ body });
/** @param {string} role @param {string} src @param {string} sha @param {number} r @param {string} v */
const head = (role, src, sha, r, v) => `🤖 ${role}｜來源：${src}｜審 \`${sha}\`｜r${r}｜結論：${v}`;

test('標頭｜合法的來歷標頭讀得出五個欄位', () => {
  const h = headerOf(head('Claude', 'William 桌面 session', 'aabbccd', 3, '需修改後再審'));
  assert.deepEqual(h, {
    role: 'Claude', source: 'William 桌面 session', sha: 'aabbccd', round: 3,
    verdict: '需修改後再審', blocking: true,
  });
});

test('標頭｜結論只認三種寫法（寫別的＝沒下結論）', () => {
  for (const v of Object.keys(VERDICTS)) {
    assert.ok(headerOf(head('Codex', 'CLI', 'aabbccd', 1, v)), `「${v}」應該讀得出來`);
  }
  for (const v of ['大致OK', 'LGTM', '沒問題', '通過但有小問題']) {
    assert.equal(headerOf(head('Codex', 'CLI', 'aabbccd', 1, v)), null, `「${v}」不該被當成合法結論`);
  }
});

test('標頭｜只看**第一行**（把標頭藏在中間不算）', () => {
  const body = `## Claude 複審\n\n${head('Claude', 'CLI', 'aabbccd', 1, '通過')}`;
  assert.equal(headerOf(body), null, '標頭不在第一行卻被接受了——那就沒有「一眼看得出誰寫的」這件事');
});

test('⭐ 聯集｜別人說「通過」不會解除我的「需修改」（#383 的實況）', () => {
  const problems = verdictProblems([
    c(head('Claude', 'Codex 桌面起的 CLI', HEAD.slice(0, 7), 2, '通過')),
    c(head('Claude', 'William 桌面 session', HEAD.slice(0, 7), 1, '需修改後再審')),
  ], HEAD).problems;
  assert.ok(problems.some((p) => /William 桌面 session.*需修改後再審/s.test(p)),
    `別人的「通過」把阻擋解除了，實得：${problems.join('｜')}`);
});

test('聯集｜同一位審查者用更新的輪次撤銷自己的阻擋 → 放行', () => {
  const who = 'William 桌面 session';
  const { problems } = verdictProblems([
    c(head('Claude', who, HEAD.slice(0, 7), 1, '需修改後再審')),
    c(head('Claude', who, HEAD.slice(0, 7), 2, '通過')),
  ], HEAD);
  assert.deepEqual(problems, []);
});

test('⭐ 聯集｜**同一輪**出現相反結論 → fail-closed（不是最後一則說了算）', () => {
  // ⚠️ Codex #385 r1 High①：原本用 `>=`，同為 r2 時「需修改」後貼「通過」就放行、反過來就阻擋
  //    ——**結果取決於留言順序**，正是這支要根治的病，我卻在自己的實作裡犯了。
  const who = 'William 桌面 session';
  const a = c(head('Claude', who, HEAD.slice(0, 7), 2, '需修改後再審'));
  const b = c(head('Claude', who, HEAD.slice(0, 7), 2, '通過'));
  for (const order of [[a, b], [b, a]]) {
    const { problems } = verdictProblems(order, HEAD);
    assert.ok(problems.some((p) => /同一輪/.test(p)), `同輪衝突被放行了（順序 ${order === a ? 'ab' : 'ba'}）`);
  }
});

test('⭐ 聯集｜完全沒有正式結論 → 阻擋（協作欄位只證明「寫了誰」，不證明審查發生過）', () => {
  const { problems } = verdictProblems([c('這支等 #382 合併之後再 rebase')], HEAD);
  assert.ok(problems.some((p) => /沒有任何一位審查者/.test(p)),
    '「沒人審」被放行了——那比 main 原本的人工確認還退步');
});

test('聯集｜留言順序不影響結果（不是「最後一則說了算」）', () => {
  const who = 'William 桌面 session';
  const a = c(head('Claude', who, HEAD.slice(0, 7), 1, '需修改後再審'));
  const b = c(head('Claude', who, HEAD.slice(0, 7), 2, '通過'));
  assert.deepEqual(verdictProblems([a, b], HEAD).problems, verdictProblems([b, a], HEAD).problems,
    '換個順序就換結果——那不是判準，是巧合');
});

test('聯集｜「通過」如果是對舊 commit 說的，不算數', () => {
  const { problems } = verdictProblems([
    c(head('Codex', 'Claude 起的 CLI', '1234567', 1, '通過')),
  ], HEAD);
  assert.ok(problems.some((p) => /是對 1234567 說的/.test(p)), problems.join('｜'));
});

test('聯集｜有結論卻沒有標頭 → 點名（防「照舊寫一段散文就當複審」）', () => {
  const { problems } = verdictProblems([c('## Claude 複審\n\n結論：通過，可以合併。')], HEAD);
  assert.ok(problems.some((p) => /沒有合規的來歷標頭/.test(p)), problems.join('｜'));
});

test('聯集｜一般聊天留言不會被誤當成複審', () => {
  const { problems } = verdictProblems([
    c('我把 node_modules 重裝了，現在可以跑了'),
    c('這支等 #382 合併之後再 rebase'),
  ], HEAD);
  assert.ok(!problems.some((p) => /沒有合規的來歷標頭/.test(p)), `一般留言被誤擋：${problems.join('｜')}`);
});

test('聯集｜**兩個角色**各自的阻擋要各自解除', () => {
  const { problems } = verdictProblems([
    c(head('Claude', 'William 桌面 session', HEAD.slice(0, 7), 1, '需修改後再審')),
    c(head('Codex', 'Claude 起的 CLI', HEAD.slice(0, 7), 1, '不可合併')),
    c(head('Claude', 'William 桌面 session', HEAD.slice(0, 7), 2, '通過')),
  ], HEAD);
  assert.ok(problems.some((p) => /Codex/.test(p)), `Codex 那條應該還在，實得：${problems.join('｜')}`);
});

// ── 文件真的叫人跑這支腳本（不然規則又只活在腳本裡）─────────────

test('合併程序真的把聯集閘寫成一步（不是只在別處提到它）', () => {
  // ⚠️ 判準比照 test/merge-procedure-docs.test.js：**指令必須出現在剝掉 HTML 註解後的 fenced code**
  //    ——「文件某處提到這支腳本」不算數（#353 r1 的考題就是被「把指令搬進 HTML 註解」繞過的）。
  // ⚠️ **先截出「合併六步驟」那個 blockquote 區塊再看**（Codex #385 r2 Medium）：
  //    掃整份文件的所有 fenced code 的話，把指令從步驟 2 刪掉、搬到檔頭的啟動範例，考題照樣過。
  //    判準比照 test/merge-procedure-docs.test.js。
  const whole = readFileSync(join(ROOT, 'CODEX-REVIEW.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const start = whole.indexOf('合併也由 Codex 代執行');
  assert.ok(start > 0, 'CODEX-REVIEW.md 找不到「合併六步驟」那個區塊');
  const md = whole.slice(start, whole.indexOf('\n---', start));
  const fenced = [...md.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join('\n');
  assert.match(fenced, /node scripts\/check-review-verdicts\.js/,
    'CODEX-REVIEW.md 的合併步驟沒有真的叫人跑聯集閘——規則會退回「靠記性」');
  // 順序也是契約：聯集閘要在 `gh pr merge` 之前
  assert.ok(md.indexOf('check-review-verdicts.js') < md.indexOf('gh pr merge'),
    '聯集閘出現在 `gh pr merge` 之後＝合併完才檢查，等於沒有');
});

test('AGENTS.md 要寫下「取聯集，不取最後一則」與自報來歷的格式', () => {
  // ⚠️ **剝掉 HTML 註解再比對**（Codex #385 r1 Medium⑤）：
  //    不剝的話，把整段規則包進 `<!-- -->` 就能讓「文件寫了」變成假的——
  //    而這支 PR 自己新增的固定維度第 2 條講的就是這件事，我在自己的考題裡違反了它。
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(agents.includes('取聯集，不取最後一則'),
    'AGENTS.md 找不到聯集規則的原句——只寫在腳本裡＝讀 AGENTS 的人不會知道');
  assert.match(agents, /🤖 <角色>｜來源：/,
    'AGENTS.md 沒有寫出來歷標頭的逐字格式，寫的人只能猜');
});

// ── 回歸鎖：r1／r2 修過的每一條都要有考題盯著（Codex #385 r2 Medium）─────────

test('⭐ 回歸｜**沒有標頭的明確阻擋**不可以被別人的「通過」蓋掉（r2 High）', () => {
  // ⚠️ 這是 #383 的病本身。r1 我為了修誤擋把判準收太緊，親手把它放回來：
  //    這三種明確的阻擋當時全部認不出來，旁邊有一則合規「通過」就解除了。
  const pass = c(head('Codex', 'CLI', HEAD.slice(0, 7), 2, '通過'));
  for (const blocking of ['## Claude 複審\n\n需修改後再審。', '## 結論\n\n不可合併', '複審完成：不可合併。']) {
    const { problems } = verdictProblems([c(blocking), pass], HEAD);
    assert.ok(problems.length > 0, `「${blocking.replace(/\n/g, ' ')}」被別人的通過解除了`);
  }
});

test('回歸｜r1 列的五種誤擋，一種都不可以回來', () => {
  for (const body of [
    '這不是複審，只是提醒',
    '修完就可以合併嗎？',
    '> 結論：不可合併',
    '腳本遇到「不可合併」要回 exit 1',
    '```text\n結論：需修改後再審\n```',
  ]) {
    assert.equal(looksLikeVerdict(body), false, `誤擋回來了：「${body.replace(/\n/g, ' ')}」`);
  }
});

test('回歸｜標頭正規化的四個缺口（大寫 SHA／來源空白／原型鍵／引用列表前綴）', () => {
  const H = (/** @type {string} */ s) => headerOf(s);
  assert.ok(H('🤖 Codex｜來源：CLI｜審 `AABBCCD`｜r2｜結論：通過'), '大寫 SHA 被拒了');
  assert.equal(H('🤖 Codex｜來源：CLI｜審 `AABBCCD`｜r2｜結論：通過')?.sha, 'aabbccd', '大寫 SHA 沒轉小寫');
  assert.equal(
    H('🤖 Codex｜來源：Claude   起的\tCLI｜審 `aabbccd`｜r2｜結論：通過')?.source,
    H('🤖 Codex｜來源：Claude 起的 CLI｜審 `aabbccd`｜r2｜結論：通過')?.source,
    '來源的多餘空白讓同一個人變成兩個人——那會多出一條永遠撤不掉的阻擋');
  for (const proto of ['toString', 'constructor', 'hasOwnProperty']) {
    assert.equal(H(`🤖 Codex｜來源：CLI｜審 \`aabbccd\`｜r2｜結論：${proto}`), null,
      `原型鍵「${proto}」被當成合法結論——本專案的原型鍵鐵則`);
  }
  assert.equal(H('> 🤖 Codex｜來源：CLI｜審 `aabbccd`｜r2｜結論：通過'), null, '引用別人的標頭被當成新結論');
  assert.equal(H('- 🤖 Codex｜來源：CLI｜審 `aabbccd`｜r2｜結論：通過'), null, '列表形式的標頭被接受了');
  assert.ok(H('**🤖 Codex｜來源：CLI｜審 `aabbccd`｜r2｜結論：通過**'), '粗體包裝是合法寫法，不該被拒');
});

// ── 放行只認 PR 指定的獨立審查者（Codex #385 r3 High①）────────────

test('⭐ 放行｜實作者自己說「通過」不算——放行只認 PR 指定的獨立審查者', () => {
  // ⚠️ 這是唯一不變量的正面違反：PR 寫「實作者 Claude／獨立審查者 Codex」，
  //    留言卻是 Claude 自己的「通過」，而兩道閘都零問題 ⇒ 實作者放行了自己的 PR。
  const own = [c(head('Claude', 'William 桌面 session', HEAD.slice(0, 7), 1, '通過'))];
  assert.ok(verdictProblems(own, HEAD, 'Codex').problems.some((p) => /指定的獨立審查者/.test(p)),
    '實作者自己的「通過」放行了自己的 PR');
  // 指定的那一位說通過 → 放行
  assert.deepEqual(
    verdictProblems([c(head('Codex', 'CLI', HEAD.slice(0, 7), 1, '通過'))], HEAD, 'Codex').problems, []);
});

test('放行｜阻擋不受此限：**任何人**都可以喊停，一律進聯集', () => {
  const { problems } = verdictProblems([
    c(head('Codex', 'CLI', HEAD.slice(0, 7), 1, '通過')),
    c(head('William', '產品驗收', HEAD.slice(0, 7), 1, '不可合併')),
  ], HEAD, 'Codex');
  assert.ok(problems.some((p) => /William/.test(p)),
    '非指定審查者的阻擋被忽略了——喊停不該有身分門檻');
});

test('結論行｜常見標點都要抓得到（r3 High②）', () => {
  for (const body of [
    '需修改後再審（High 尚未修）',
    '結論：不可合併：High 尚未修',
    '結論：不可合併；請先修正',
    '結論：不可合併——請先修正',
  ]) assert.equal(looksLikeVerdict(body), true, `漏掉：「${body}」`);
});

test('結論行｜任意前綴與行內 code 不可誤擋（r3 Medium③）', () => {
  for (const body of [
    '範例：不可合併。',
    '退出碼說明：不可合併，回 1。',
    '`不可合併` 表示 exit 1。',
  ]) assert.equal(looksLikeVerdict(body), false, `誤擋：「${body}」`);
});

// ── r4 的四條回歸鎖 ─────────────────────────────────────────

test('⭐ 標頭｜**來源不可以是空白**（兩個 session 會被併成同一人）', () => {
  // ⚠️ Codex #385 r4 High①：兩個 Codex session 都漏填來源 ⇒ 都變成 `Codex（）`＝同一位，
  //    第二個的「通過」就撤銷了第一個的阻擋——**#383 的核心病原樣重現**。
  assert.equal(headerOf('🤖 Codex｜來源：   ｜審 `aabbccd`｜r1｜結論：通過'), null);
  assert.equal(headerOf('🤖 Codex｜來源：\t｜審 `aabbccd`｜r1｜結論：通過'), null);
});

test('⭐ 結論行｜**不再列舉標點**：清單記號、省略號、全形斜線都要抓得到', () => {
  // ⚠️ r3 我加了一組允許的標點，r4 它就用 `……`／`／`／`+ `／`1. ` 再打穿一次。
  //    **列舉標點跟列舉繞法是同一種錯**，所以改成「以結論用詞開頭就算」，後面接什麼一概不管。
  for (const body of [
    '不可合併……High 尚未修',
    '不可合併／請先修正',
    '+ 結論：不可合併。',
    '1. 結論：不可合併。',
    '審查結果：不可合併。',
  ]) assert.equal(looksLikeVerdict(body), true, `漏掉：「${body}」`);
});

test('⭐ 結論行｜行內 code 只拿掉**那一段**，不是跳過整行', () => {
  // ⚠️ r4 Medium③：跳過整行的話，「結論：不可合併；請修正 `不可合併` 偵測」整句就被放過了。
  assert.equal(looksLikeVerdict('結論：不可合併；請修正 `不可合併` 偵測'), true);
  assert.equal(looksLikeVerdict('`不可合併` 表示 exit 1。'), false, '純粹在講判準的句子被誤擋');
});

test('結論行｜「講述用」的前綴不可以被當成結論', () => {
  for (const body of ['範例：不可合併。', '退出碼說明：不可合併，回 1。']) {
    assert.equal(looksLikeVerdict(body), false, `誤擋：「${body}」`);
  }
});

test('AGENTS｜委任那段不可以自相矛盾（同一條規則的兩半要一致）', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const i = agents.indexOf('委任關係：只影響');
  assert.ok(i > 0, 'AGENTS.md 找不到委任那節');
  const block = agents.slice(i, i + 1400);
  assert.ok(/放行只認 PR 說明指定的那一位獨立審查者/.test(block),
    '委任那節沒寫清楚「放行只認指定的那一位」');
  assert.ok(!/也\*\*不構成放行\*\*/.test(block),
    '委任那節又出現「也不構成放行」——與前文矛盾，讀者無法判斷哪句才是規則');
});

// ── r5 的誤擋回歸鎖：這些是**我們每天在寫的句子**（Codex #385 r5 High）────

test('⭐ 結論行｜本專案日常的審查留言不可以被誤擋', () => {
  // ⚠️ r4 我把「用詞後面允許哪些標點」整個拿掉，於是這些全部被當成正式結論。
  //    這不是刻意構造——「通過三關」「測試結果：通過 N 題」正是我們每天寫的句子。
  //    **誤擋會逼人改寫、刪留言，最後乾脆繞過整道閘。**
  for (const body of [
    '通過三關後才可以更新 PR。',
    '測試結果：通過 1392 題、失敗 0 題。',
    '突變測試結果：通過率仍是 100%，所以考題沒守住。',
    '不可合併兩個來源的 reviewer state，否則會錯誤撤銷阻擋。',
  ]) assert.equal(looksLikeVerdict(body), false, `日常留言被誤擋：「${body}」`);
});

test('結論行｜任意長度的行內 code 都要剝掉，且機器人記號要在剝完之後才判', () => {
  assert.equal(looksLikeVerdict('``不可合併`` 是三種結論之一。'), false, '雙反引號的 code span 沒被剝掉');
  assert.equal(looksLikeVerdict('來歷標頭要從 `🤖` 開始。'), false,
    '機器人記號在行內 code 裡卻被當成有標頭——那是在講格式，不是在下結論');
});

test('⭐ 結論行｜判準是「用詞之後句子就結束、或接的是標點」', () => {
  // 這條把「列舉標點」與「完全不管後面」兩個極端都排除掉：
  //   ・接著又是文字或數字 → 那只是句子的開頭，不是結論
  //   ・接標點或結束       → 那是一個結論
  assert.equal(looksLikeVerdict('通過'), true);
  assert.equal(looksLikeVerdict('通過。'), true);
  assert.equal(looksLikeVerdict('通過（附但書）'), true);
  assert.equal(looksLikeVerdict('通過率'), false);
  assert.equal(looksLikeVerdict('通過 1392 題'), false);
});
