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
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerOf, looksLikeVerdict, sourceLookalike, verdictProblems, VERDICTS } from '../scripts/check-review-verdicts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 真實語料：25 份審查報告原文（正例）＋3 則真實的非結論留言（負例）。 */
const CORPUS = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/review-verdict-corpus.json'), 'utf8'));

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

test('⭐ 標頭｜角色打錯字 → 不算合法標頭（否則會生出撤不掉的幽靈阻擋）', () => {
  // ⚠️ Codex #385 r11：原本角色是 `[A-Za-z]+` 照單全收。
  //    `Codeex` 會被當成**另一位正式審查者**——它喊的停，正確的 `Codex` 說「通過」
  //    永遠撤銷不掉（只有同一位審查者能撤銷），而且因為標頭「合法」，
  //    連 `hasBotMark()` 都不會點名它是壞標頭 ⇒ **一條沒有人能解除的阻擋**。
  for (const typo of ['Codeex', 'Cluade', 'Bot', 'Reviewer']) {
    assert.equal(headerOf(head(typo, 'CLI', 'aabbccd', 1, '不可合併')), null,
      `角色「${typo}」被當成合法審查者了`);
  }
  // 打錯字的標頭會落回「用了 🤖 但寫壞」那條阻擋，訊息看得懂
  const { problems } = verdictProblems([c(head('Codeex', 'CLI', HEAD.slice(0, 7), 1, '不可合併'))], HEAD);
  assert.ok(problems.some((p) => /🤖 記號、但標頭格式不合規/.test(p)), problems.join('｜'));
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

test('聯集｜有結論卻沒有標頭 → **警告**（提醒它不被採計），但不影響閘的結果', () => {
  const { problems, warnings } = verdictProblems([c('## Claude 複審\n\n結論：通過，可以合併。')], HEAD);
  assert.ok(warnings.some((w) => /不會採計它/.test(w)), `沒有發出提醒：${warnings.join('｜')}`);
  // 這一則仍然無法放行（沒有合規標頭的「通過」不算通過）——擋它的是判準，不是偵測器
  assert.ok(problems.some((p) => /正式結論/.test(p)), problems.join('｜'));
});

test('⭐ 聯集｜🤖 記號在、標頭寫壞了 → **阻擋**（唯一還留在阻擋路徑上的文字判斷）', () => {
  // 誤判面極小：正文出現 🤖 幾乎不可能不是在試這個格式。而標頭打錯一個字＝整則結論被無視，
  // 那是真實會發生的事，必須當場說。
  const typo = '🤖 Claude｜來源：桌面｜審 abc1234｜r1｜結論：通過了';   // 結論用詞不是三選一
  const { problems } = verdictProblems([c(typo)], HEAD);
  assert.ok(problems.some((p) => /🤖 記號、但標頭格式不合規/.test(p)), problems.join('｜'));
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
  // ⚠️ **先截出「合併步驟」那個 blockquote 區塊再看**（Codex #385 r2 Medium；步數不寫死——加了閘就會變）：
  //    掃整份文件的所有 fenced code 的話，把指令從步驟 2 刪掉、搬到檔頭的啟動範例，考題照樣過。
  //    判準比照 test/merge-procedure-docs.test.js。
  const whole = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const start = whole.indexOf('合併也由 Codex 代執行');
  assert.ok(start > 0, 'REVIEW-AND-MERGE.md 找不到「合併步驟」那個區塊');
  const md = whole.slice(start, whole.indexOf('\n---', start));
  const fenced = [...md.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join('\n');
  assert.match(fenced, /node scripts\/check-review-verdicts\.js/,
    'REVIEW-AND-MERGE.md 的合併步驟沒有真的叫人跑聯集閘——規則會退回「靠記性」');
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

test('⭐ 契約｜**沒有標頭的留言兩個方向都沒有效力**——不放行、也不阻擋（#385 r10 起）', () => {
  // ⚠️ **這一題的期望在 r11 被刻意翻轉，理由要寫清楚：**
  //    r10 以前，「疑似結論卻沒標頭」會直接阻擋。連續兩輪的實測是：
  //    Codex 一輪就找到五個正常留言被誤擋（`## 如何合併兩個 reviewer state`、
  //    `通過／失敗：25／0`…），而且其中三個是我上一輪「修誤擋」時新造出來的。
  //    它的判定：**誤擋是阻擋級，且相對 `main` 是實質退步**——原本人工確認不會卡住這些留言。
  //    同時它也確認：漏抓**不是安全問題**，因為擋住 #383 的是「放行只認合規標頭的通過」。
  //    ⇒ 一個零安全價值、卻持續製造退步的阻擋條件，不該是阻擋條件。改成警告。
  //
  //    **殘餘風險寫明**：有人以自然語言喊停、又剛好有另一位指定審查者帶標頭放行時，
  //    這道閘會通過（終端會印出提醒）。契約因此是「**要喊停就帶標頭重發**」。
  const pass = c(head('Codex', 'CLI', HEAD.slice(0, 7), 2, '通過'));
  for (const blocking of ['## Claude 複審\n\n需修改後再審。', '## 結論\n\n不可合併', '複審完成：不可合併。']) {
    const { problems, warnings } = verdictProblems([c(blocking), pass], HEAD, 'Codex');
    assert.deepEqual(problems, [], `「${blocking.replace(/\n/g, ' ')}」不該阻擋——沒有標頭就沒有效力`);
    assert.ok(warnings.length > 0, `「${blocking.replace(/\n/g, ' ')}」至少要發出提醒`);
  }
});

test('⭐ 契約｜#383 的**真實場景**仍然被擋（那是判準擋的，不是偵測器）', () => {
  // 真正的 #383：兩則相反的複審，**兩則都沒有標頭**。
  // 就算偵測器一個字都沒抓到，也沒有任何合規標頭的「通過」⇒ 一律不放行。
  const { problems } = verdictProblems([
    c('## Claude 複審 r1｜結論：**需修改後再審**（不可直接合併）'),
    c('## 最終複審結論：通過，可以合併'),
  ], HEAD, 'Claude');
  assert.ok(problems.some((p) => /正式結論/.test(p)),
    `#383 的原始場景沒有被擋下——那是這支存在的全部理由。實得：${problems.join('｜') || '（零條）'}`);
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

// ── r6 的回歸鎖：用**真實留言**驗，不是用我想像的句子（Codex #385 r6 High）────

test('⭐ 結論行｜#383 的**真實阻擋留言**必須抓得到', () => {
  // ⚠️ 這是造成 #383 那場事故的原始留言格式。用詞不在行首（前面有「Claude 複審 r1｜結論：」），
  //    而 r5 的前綴是**逐字集合**，對不上就整則看不見 ⇒ 另一個 session 的「通過」直接放行
  //    ⇒ **#383 原樣重現**。Codex 是直接 `gh pr view 383` 把原文抓出來打的。
  const real = '## Claude 複審 r1｜結論：**需修改後再審**（不可直接合併）\n\n審到 commit：`6203ea0`';
  assert.equal(looksLikeVerdict(real), true, '真實的阻擋留言被忽略了');
  // 旁邊有別人的合規「通過」時，它**只發提醒不阻擋**（見上面那題的理由與殘餘風險）
  const { problems, warnings } = verdictProblems([
    c(real),
    c(head('Claude', '另一個 session', HEAD.slice(0, 7), 2, '通過')),
  ], HEAD, 'Claude');
  assert.deepEqual(problems, [], '沒有標頭的留言不該有阻擋效力');
  assert.ok(warnings.length > 0, '至少要提醒「這則沒被採計」');
});

test('結論行｜「用詞當標籤、後面接說明」不是結論（報告的日常句型）', () => {
  for (const body of [
    '- 通過：1395/1395 題。',
    '不可合併：兩個 reviewer state 必須分開保存。',
  ]) assert.equal(looksLikeVerdict(body), false, `日常句型被誤擋：「${body}」`);
});

test('結論行｜關鍵詞只認「審查/複審結果」，不認泛用的「結果」', () => {
  // 只寫「結果」的話，「測試結果：通過 1392 題」會全部中招（r5 的教訓）。
  assert.equal(looksLikeVerdict('審查結果：不可合併。'), true);
  assert.equal(looksLikeVerdict('測試結果：通過 1392 題、失敗 0 題。'), false);
});

test('回歸｜前綴與行內 code 的兩個修正都真的鎖住了', () => {
  // ⚠️ Codex #385 r6 Medium：把逐字前綴退回寬鬆版、把任意長度反引號退回單反引號，
  //    29 題都還是綠——**修好了卻沒有東西盯著它別退回去**。這兩條就是那兩把鎖。
  assert.equal(looksLikeVerdict('突變測試結果：通過率仍是 100%。'), false,
    '寬鬆前綴回來了：「突變測試結果：」被剝成結論');
  assert.equal(looksLikeVerdict('``不可合併`` 是三種結論之一。'), false,
    '只剝單反引號的版本回來了：雙反引號的 code span 沒被剝掉');
});

// ── r7：判準倒過來——偵測「下結論這個動作」，不是比對「結論寫成什麼字」────

test('⭐ 結論行｜25 份真實報告**原文**全部要抓到（不是代表例——那是 r8 的假綠）', () => {
  // ⚠️ **r8 這一題自己說謊**（Codex #385 r8 抓的）：
  //    題目寫「25 份真實報告」，實際只放了 6 個我手挑的代表例。
  //    於是「25/25」是我宣稱的，不是驗過的——Codex 拿真的 25 份跑，只中 14 份。
  //    **代表例是我從失敗案例裡挑出來的，當然會過；真正會漏的是我沒想到的那些。**
  // ⇒ 語料改成 `test/fixtures/review-verdict-corpus.json`：
  //    Codex 對 #381／#384／#385 的 25 份審查報告**原文**，加上 3 則真實的非結論留言。
  //    這份語料同時是那 25 份報告唯一的 repo 內備份（原本只活在 scratchpad，關掉對話就沒了）。
  const miss = CORPUS.positives.filter((p) => !looksLikeVerdict(p.body));
  assert.deepEqual(miss.map((m) => m.source), [],
    `這些真實審查報告沒有被判成「在下結論」——它們就會被當成一般留言而無視：\n`
    + miss.map((m) => `  ・${m.source}`).join('\n'));
  assert.equal(CORPUS.positives.length, 25,
    '語料份數變了。要增刪請一起改這個數字——**不要讓題目說的和語料裡的不一樣**（r8 就是這樣假綠的）。');
});

test('⭐ 結論行｜r9 的六個語料外案例（漏抓三個、誤擋三個，都是真實寫法）', () => {
  // ⚠️ 25/25 是真成績，但**不是語意飽和證明**——Codex 拿語料以外的 session 報告再打，
  //    兩個方向各找到三個。誤擋那三個特別要修：**漏抓不是安全問題，誤擋會真的擋住合併。**
  for (const [body, want] of /** @type {[string, boolean][]} */ ([
    ['結論是「通過，可合併」，阻擋問題無。', true],       // 引號裡也可能是真結論（分界＝同行有「結論」）
    ['不通過：1 個 blocking。PR #358 暫不可合併。', true], // 冒號隔了一個句號＝不是標籤引出
    ['**r3 通過、可合併。**', true],                       // 「可合併」少一個字也是裁決
    ['## 如何合併兩個 reviewer state', false],             // 標題只提「合併」不是結論
    ['不可合併 two reviewer states，否則會錯誤撤銷阻擋。', false], // 受詞前有空格照樣是受詞
    ['腳本遇到 "不可合併" 要回 exit 1。', false],          // ASCII 引號也要算引號
  ])) {
    assert.equal(looksLikeVerdict(body), want,
      `${want ? '漏抓' : '誤擋'}：「${body}」`);
  }
});

test('⭐ 已知的過度觸發：偵測器會誤判這幾句，但它們**擋不住合併**（這就是改成警告的意義）', () => {
  // ⚠️ 誠實劃界。以下三句 Codex #385 r10 實測會被判成「疑似結論」，而它們只是在討論這道閘：
  //    要正確分辨得有中文詞界（`是否可以合併` 裡面就藏著 `可以合併`），而中文沒有詞界——
  //    那正是這支 PR 從頭到尾在踩的坑。**與其再追一輪，不如證明它們不造成傷害。**
  const noise = [
    '## 如何判斷 PR 可否合併',
    '這支函式只負責判斷 PR 是否可以合併。',
    '腳本把「不可合併」誤判成結論。',
  ];
  const pass = c(head('Codex', 'CLI', HEAD.slice(0, 7), 1, '通過'));
  for (const body of noise) {
    const { problems, warnings } = verdictProblems([c(body), pass], HEAD, 'Codex');
    assert.deepEqual(problems, [],
      `「${body}」擋住了合併——誤擋相對 main 是實質退步，這正是 r11 把它移出阻擋路徑的理由`);
    assert.ok(warnings.length > 0, `「${body}」連提醒都沒有，那偵測器等於不存在`);
  }
});

test('⭐ 結論行｜真實的非結論留言一則都不准誤擋', () => {
  // 誤擋會逼人改寫、刪留言，最後乾脆繞過整道閘——那比漏抓一次更糟。
  const fp = CORPUS.negatives.filter((n) => looksLikeVerdict(n.body));
  assert.deepEqual(fp.map((m) => m.source), [],
    `這些不是結論，卻被要求補來歷標頭：\n${fp.map((m) => `  ・${m.source}`).join('\n')}`);
});

test('結論行｜倒過來之後，日常句型仍然不可以被誤擋', () => {
  for (const body of [
    '通過三關後才可以更新 PR。',
    '測試結果：通過 1392 題、失敗 0 題。',
    '突變測試結果：通過率仍是 100%。',
    '- 通過：1395/1395 題。',
    '不可合併：兩個 reviewer state 必須分開保存。',
    '## ACK — 沒有衝突，可以開工\n\n檔案衝突檢查逐條對過',
    '修完就可以合併嗎？',
  ]) assert.equal(looksLikeVerdict(body), false, `誤擋：「${body.replace(/\n/g, ' ')}」`);
});

// ── 重述（2026-08-06，William 裁決 B：壞標頭的唯一救濟）──────────────────────
// 起因＝真實事故：發射提示沒列出三個合規字串，五支 PR 的歷史留言裡都有「要求修改」「通過（無阻擋）」
// 這類壞標頭 ⇒ 永久阻擋、補新留言也清不掉。機制的設計原則：**重述唯一的新權力是「把讀不懂的
// 翻譯成讀得懂的」，判定規則一格都沒放寬**——下面每一條都在釘這句話的一個角。

const MAL_FIRST = '🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜r6｜結論：要求修改';
const MAL = `${MAL_FIRST}\n\n細節略。`;
/** 合規重述：Codex 自己在 r7 的通過留言裡，把壞掉的 r6 翻譯成三選一。 */
const RESTATE_OK = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
  + `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${MAL_FIRST}」`;

test('⭐ 重述｜同一位審查者逐字重述自己的壞標頭 → 不再阻擋，照常放行', () => {
  const { problems, warnings } = verdictProblems([c(MAL), c(RESTATE_OK)], HEAD, 'Codex');
  assert.deepEqual(problems, [], problems.join('｜'));
  assert.ok(warnings.some((w) => /重述行接管/.test(w)), '要留一句可稽核的警告，說明壞留言被誰接管');
});

test('⭐ 重述｜別人不能替我重述（引文裡的角色來源 ≠ 重述者 → 無效）', () => {
  // 危險情境：實作者替審查者「重述」，把審查者一則打壞的阻擋靜靜洗掉。
  const byClaude = `${head('Claude', '桌面', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`abc1234\`｜結論：通過｜原第一行：「${MAL_FIRST}」`;
  const { problems, warnings } = verdictProblems([c(MAL), c(byClaude)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `壞標頭必須維持阻擋：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /只能重述\*\*自己\*\*/.test(w)), warnings.join('｜'));
});

test('⭐ 重述｜引文對不上＝不清除（而且要出聲說引文空轉）', () => {
  const wrongQuote = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + '重述 r6｜審 `abc1234`｜結論：需修改後再審｜原第一行：「🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜r6｜結論：要求修正」';
  const { problems, warnings } = verdictProblems([c(MAL), c(wrongQuote)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `引文差一個字就不可以清：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /對不上任何壞標頭留言/.test(w)), warnings.join('｜'));
});

test('⭐ 重述｜輪次不小於自己 → 無效（防止用重述行造出更高輪的「通過」）', () => {
  const selfPromote = `${head('Codex', 'CLI（xhigh）', 'abc1234', 7, '需修改後再審')}\n`
    + `重述 r8｜審 \`${HEAD}\`｜結論：通過｜原第一行：「${MAL_FIRST}」`;
  const { problems, warnings } = verdictProblems([c(MAL), c(selfPromote)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), '無效重述不可清除壞標頭');
  assert.ok(warnings.some((w) => /不小於這則留言自己的/.test(w)), warnings.join('｜'));
  // 而且那個假造的 r8「通過」**不可以**變成放行票
  assert.ok(problems.some((p) => /沒有「Codex」對目前的 head|還沒有被同一位審查者撤銷/.test(p)),
    `重述行不可以生出放行票：${problems.join('｜')}`);
});

test('⭐ 重述｜對聯集裁決零影響：空轉的重述行（含阻擋結論）不改變任何判定', () => {
  // ⚠️ 這一題的第一版是**假比較**（#418 r1 阻擋④）：withLine 有壞留言、noLine 連壞留言一起刪掉，
  //    兩邊本來就都是 []＝比了個寂寞。真相是：重述**會**改變「壞標頭那條阻擋」（那正是它的目的），
  //    所以「改變不了判定」是 overclaim。誠實的說法＝重述唯一能改變的是壞標頭那條；
  //    **對聯集的裁決（誰通過、誰阻擋、放行票）零影響**——這一題釘的是後半句：
  //    同一批留言，唯一差別是一行「不可合併」的重述（引文空轉、對不上任何壞留言），判定必須一字不差。
  const base = [c(head('Codex', 'CLI（xhigh）', 'abc1234', 6, '需修改後再審')),
    c(head('Codex', 'CLI（xhigh）', HEAD, 7, '通過'))];
  const withLine = [base[0], c(`${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + '重述 r5｜審 `abc1234`｜結論：不可合併｜原第一行：「🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜r5｜結論：亂寫」')];
  const a = verdictProblems(withLine, HEAD, 'Codex');
  const b = verdictProblems(base, HEAD, 'Codex');
  assert.deepEqual(a.problems, b.problems, '重述行（即使寫著不可合併）不可以改變聯集的判定');
  assert.deepEqual(a.problems, [], a.problems.join('｜'));
  assert.ok(a.warnings.some((w) => /對不上任何壞標頭留言/.test(w)), '空轉要出聲');
});

test('⭐ 重述｜清不掉**合規**結論的阻擋（引用合規阻擋的第一行＝空轉，阻擋照舊）', () => {
  // 重述只對「壞標頭」有效；合規的阻擋只能靠同一位審查者的更新輪次撤銷。
  const blockLine = head('Codex', 'CLI（xhigh）', HEAD, 8, '需修改後再審');
  const tryToClear = `${head('Codex', 'CLI（xhigh）', 'abc1234', 9, '通過')}\n`   // r9 通過但審的是舊 sha
    + `重述 r8｜審 \`${HEAD}\`｜結論：通過｜原第一行：「${blockLine}」`;
  const { problems } = verdictProblems([c(blockLine), c(tryToClear)], HEAD, 'Codex');
  assert.ok(problems.length > 0, `合規阻擋不可以被重述洗掉：${problems.join('｜')}`);
});

test('重述｜結論不是三選一／讀不出引文身分 → 各自無效並出聲', () => {
  const badVerdict = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`abc1234\`｜結論：大致通過｜原第一行：「${MAL_FIRST}」`;
  const r1 = verdictProblems([c(MAL), c(badVerdict)], HEAD, 'Codex');
  assert.ok(r1.problems.some((p) => /標頭格式不合規/.test(p)));
  assert.ok(r1.warnings.some((w) => /不是三選一/.test(w)), r1.warnings.join('｜'));
  const noIdentity = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + '重述 r6｜審 `abc1234`｜結論：需修改後再審｜原第一行：「結論：要求修改（沒有標頭的那種）」';
  const r2 = verdictProblems([c('🤖 這則壞掉了而且讀不出身分'), c(noIdentity)], HEAD, 'Codex');
  assert.ok(r2.problems.some((p) => /標頭格式不合規/.test(p)), '讀不出身分的壞留言不可重述＝維持阻擋（fail-closed）');
  assert.ok(r2.warnings.some((w) => /讀不出「誰寫的/.test(w)), r2.warnings.join('｜'));
});

test('重述｜寫在 code fence 或引用裡的重述行不算（範例不是重述）', () => {
  const fenced = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + '```\n重述 r6｜審 `abc1234`｜結論：需修改後再審｜原第一行：「' + MAL_FIRST + '」\n```';
  const { problems } = verdictProblems([c(MAL), c(fenced)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), 'fence 裡的範例不可以真的清除壞標頭');
});

test('AGENTS.md 要寫下重述行的逐字格式（機制只活在腳本裡＝寫壞標頭的人不知道怎麼自救）', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(agents.includes('重述 r<輪次>｜審'), 'AGENTS.md 找不到重述行的逐字格式');
  assert.ok(agents.includes('造不出放行票'), 'AGENTS.md 要寫明重述沒有裁決權（造不出放行票、清不掉合規阻擋）——不然會被當成第二條放行通道');
});

test('⭐ 重述｜四反引號 fence、縮排 code、引用的 lazy continuation——範例都不可以生效（#418 r1①）', () => {
  const line = `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${MAL_FIRST}」`;
  // 寬鬆剝除器用「第一個字元相同」就算關柵欄：四反引號開、三反引號關會被提早關掉，內容漏出來
  const fence4 = [head('Codex', 'CLI（xhigh）', HEAD, 7, '通過'),
    '````', '```', line, '````'].join('\n');   // 四反引號開、三反引號在內容裡、四反引號關
  const indent = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n\n    ${line}`;
  const lazy = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n> 範例如下（別人的重述長這樣）：\n${line}`;
  for (const [name, body] of [['四反引號 fence', fence4], ['縮排 code', indent], ['lazy continuation', lazy]]) {
    const { problems } = verdictProblems([c(MAL), c(body)], HEAD, 'Codex');
    assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
      `${name} 裡的重述範例不可以真的清除壞標頭：${problems.join('｜')}`);
  }
});

test('⭐ 重述｜壞行中段嵌入別人的身分——身分只認**行首**（#418 r1②）', () => {
  // 壞行以 Claude 開頭、中段嵌一段假的 Codex 身分；Codex 逐字引用整行也不可以清掉它。
  const evil = '🤖 Claude - 補充說明 🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜r6｜結論：要求修改';
  const restate = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${evil}」`;
  const { problems } = verdictProblems([c(evil + '\n內文')], HEAD, 'Codex');
  const r = verdictProblems([c(evil + '\n內文'), c(restate)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), '前置：這則壞留言要先是阻擋');
  assert.ok(r.problems.some((p) => /標頭格式不合規/.test(p)),
    `行首是 Claude 的壞留言，Codex 不可以靠中段嵌的假身分清掉：${r.problems.join('｜')}`);
  assert.ok(r.warnings.some((w) => /讀不出「誰寫的/.test(w)), r.warnings.join('｜'));
});

test('⭐ 重述｜引文是逐字比對——中間多一個空白就不算引中（#418 r1③）', () => {
  const spaced = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${MAL_FIRST.replace('🤖 Codex', '🤖  Codex')}」`;
  const { problems, warnings } = verdictProblems([c(MAL), c(spaced)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
    `引文多一個空白＝沒有引中，不可以清：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /對不上任何壞標頭留言/.test(w)), warnings.join('｜'));
});

test('⭐ 重述｜HTML 註解、清單裡的柵欄、清單裡引用的 lazy continuation——容器裡的範例也不可以生效（#418 r2）', () => {
  const line = '重述 r6｜審 `abc1234`｜結論：需修改後再審｜原第一行：「' + MAL_FIRST + '」';
  const hdr = head('Codex', 'CLI（xhigh）', HEAD, 7, '通過');
  const cases = [
    ['HTML 註解', [hdr, '<!--', line, '-->'].join('\n')],
    ['清單裡的四反引號柵欄', [hdr, '- ````text', line, '````'].join('\n')],
    ['編號清單裡的波浪柵欄', [hdr, '1. ~~~~text', line, '~~~~'].join('\n')],
    ['清單裡引用的 lazy continuation', [hdr, '- > 範例如下：', line].join('\n')],
  ];
  for (const [name, body] of cases) {
    const { problems } = verdictProblems([c(MAL), c(body)], HEAD, 'Codex');
    assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
      `${name} 裡的重述範例不可以真的清除壞標頭：${problems.join('｜')}`);
  }
});

test('⭐ 重述｜sha 與輪次要綁引文——低輪重述不可以洗掉高輪阻擋（#418 r3 High①）', () => {
  // 攻擊劇本（審查者實測過 v3 會中）：壞留言是「r8 對目前 head 的阻擋」，重述者標頭 r7 通過、
  // 重述卻自報 r1＋別的 sha——規則④（1 < 7）攔不到，於是高輪阻擋被低輪重述洗掉。
  const badR8 = `🤖 Codex｜來源：CLI（xhigh）｜審 \`${HEAD}\`｜r8｜結論：要求修改`;
  const sneaky = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r1｜審 \`deadbee\`｜結論：需修改後再審｜原第一行：「${badR8}」`;
  const r = verdictProblems([c(badR8 + '\n內文'), c(sneaky)], HEAD, 'Codex');
  assert.ok(r.problems.some((p) => /標頭格式不合規/.test(p)),
    `自報的 sha／輪次與引文不一致＝不可清除：${r.problems.join('｜')}`);
  assert.ok(r.warnings.some((w) => /不一致/.test(w)), r.warnings.join('｜'));
  // 正路：標頭 r9（> 壞掉的 r8）＋重述 r8＋同一個 head ⇒ 清得掉、照常放行
  const legit = `${head('Codex', 'CLI（xhigh）', HEAD, 9, '通過')}\n`
    + `重述 r8｜審 \`${HEAD}\`｜結論：需修改後再審｜原第一行：「${badR8}」`;
  const ok = verdictProblems([c(badR8 + '\n內文'), c(legit)], HEAD, 'Codex');
  assert.deepEqual(ok.problems, [], ok.problems.join('｜'));
});

test('⭐ 重述｜不可以預先授權：重述出現在壞留言**之前**＝不清除（#418 r3 High①後半）', () => {
  const preAuth = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${MAL_FIRST}」`;
  const { problems } = verdictProblems([c(preAuth), c(MAL)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
    `後到的壞留言不可以被先前的重述接管：${problems.join('｜')}`);
  assert.ok(problems.some((p) => /預先授權/.test(p)), problems.join('｜'));
});

test('⭐ 重述｜位置規則：不緊跟在標頭後面＝不生效，但要**出聲**（#418 r3 Medium）', () => {
  // GitHub 會把「> 標題」後的普通行渲染成頂層段落，但本閘的規則是**位置**（緊跟標頭、只准空行），
  // 不是渲染結果——規則要簡單到不需要 Markdown 解析器。放錯位置的人要收到警告，不是靜靜沒效。
  const outOfPlace = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n> ## 修正摘要\n\n`
    + `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${MAL_FIRST}」`;
  const { problems, warnings } = verdictProblems([c(MAL), c(outOfPlace)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
    `位置不對＝不清除：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /不在生效位置/.test(w)),
    `要告訴他放錯位置了：${warnings.join('｜')}`);
});

test('重述｜fence 裡的 fence（#418 r3 High② 的重現形狀）也放不進生效位置', () => {
  // v3 剝容器前綴時把 fence 裡的「- \`\`\`」誤認成關柵欄；位置規則下這整族直接消失——
  // 標頭與重述行之間放了任何一行別的內容（包括柵欄），收件就截止。
  const body = [head('Codex', 'CLI（xhigh）', HEAD, 7, '通過'), '````', '- ```',
    `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${MAL_FIRST}」`, '````'].join('\n');
  const { problems } = verdictProblems([c(MAL), c(body)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), problems.join('｜'));
});

test('⭐ 重述｜寫壞的重述行不可以幫後面的行開隱形容器（#418 r4 High①）', () => {
  // 審查者的原始重放：`重述 r0｜<!--` 前綴像重述、整行不合規——舊收件迴圈跳過它繼續收，
  // 於是它夾帶的 <!-- 把下一行**真生效**的重述藏進 HTML 註解：機器算數、人看不見。
  const smuggle = [head('Codex', 'CLI（xhigh）', HEAD, 7, '通過'),
    '重述 r0｜<!--',
    `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${MAL_FIRST}」`,
    '-->'].join('\n');
  const { problems, warnings } = verdictProblems([c(MAL), c(smuggle)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
    `藏在 HTML 註解裡的重述不可以生效：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /收件當場截止/.test(w)), warnings.join('｜'));
});

test('⭐ 重述｜合規重述行的引文夾 <!-- 或未配對反引號＝不可重述＋收件截止（#418 r4 High① 變體）', () => {
  // 引文內容是自由文字——塞一個 <!-- 一樣能把下一行藏出畫面外。這種壞留言一律不可重述（劃界）。
  const evilQuote = '🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜r6｜結論：要求修改 <!--';
  const body = [head('Codex', 'CLI（xhigh）', HEAD, 7, '通過'),
    `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${evilQuote}」`,
    `重述 r5｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${MAL_FIRST}」`,
    '-->'].join('\n');
  const { problems, warnings } = verdictProblems([c(evilQuote + '\n內文'), c(MAL), c(body)], HEAD, 'Codex');
  assert.ok(problems.filter((p) => /標頭格式不合規/.test(p)).length >= 2,
    `兩則壞留言都必須維持阻擋（含 <!-- 的不可重述；被藏住的那行不生效）：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /白名單外的字元|未配對的反引號/.test(w)), warnings.join('｜'));
});

test('⭐ 重述｜引文裡塞第二組「審 sha｜r<n>」＝讀不準在講哪組，不可重述（#418 r4 High②）', () => {
  // 審查者的原始重放：壞行寫「…審 deadbee｜r1｜更正：審 <head>｜r8｜結論：要求修改」，
  // 舊解析只取第一組 ⇒ 低輪重述（r1）洗掉高輪（r8）對目前 head 的阻擋——r3 那招換殼回來。
  const twoMeta = `🤖 Codex｜來源：CLI（xhigh）｜審 \`deadbee\`｜r1｜更正：審 \`${HEAD}\`｜r8｜結論：要求修改`;
  const wash = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r1｜審 \`deadbee\`｜結論：需修改後再審｜原第一行：「${twoMeta}」`;
  const { problems, warnings } = verdictProblems([c(twoMeta + '\n內文'), c(wash)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
    `多組 metadata 的壞留言不可被低輪重述洗掉：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /第二個 sha 長相的字/.test(w)), warnings.join('｜'));
});

test('⭐ 重述｜少一個分隔符也算多組 metadata（#418 r5 High①：性質＝第二個 sha 長相的字）', () => {
  // 審查者的原始重放：`…審 deadbee｜r1｜更正：審 <HEAD>｜r8 結論：…`——r8 後面**少一個 ｜**，
  // 舊的「整組計數」就數不到第二組；人眼照樣看到兩組。性質版判準：第二個 hex 長字＝歧義＝不可重述。
  const twoSha = `🤖 Codex｜來源：CLI（xhigh）｜審 \`deadbee\`｜r1｜更正：審 \`${HEAD}\`｜r8 結論：要求修改`;
  const wash = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r1｜審 \`deadbee\`｜結論：需修改後再審｜原第一行：「${twoSha}」`;
  const { problems } = verdictProblems([c(twoSha + '\n內文'), c(wash)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
    `少個分隔符不可以讓低輪重述洗掉高輪：${problems.join('｜')}`);
});

test('⭐ 重述｜引文夾 <details> 或圖片語法——白名單把整族隱形容器關門（#418 r5 High②）', () => {
  // r4 封 <!--、r5 就來 <details> 與 ![ ——黑名單軍備賽輸定了。白名單性質：< [ ! 都不在名單上。
  for (const [name, evil] of [
    ['<details> 收合區', '🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜r6｜結論：要求修改 <details>'],
    ['圖片 alt 吞行', '🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜r6｜結論：要求修改 !['],
  ]) {
    const body = [head('Codex', 'CLI（xhigh）', HEAD, 7, '通過'),
      `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${evil}」`,
      `重述 r5｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${MAL_FIRST}」`].join('\n');
    const { problems, warnings } = verdictProblems([c(evil + '\n內文'), c(MAL), c(body)], HEAD, 'Codex');
    assert.ok(problems.filter((p) => /標頭格式不合規/.test(p)).length >= 2,
      `${name}：兩則壞留言都要維持阻擋（藏起來的第二行不可生效）：${problems.join('｜')}`);
    assert.ok(warnings.some((w) => /白名單外的字元/.test(w)), warnings.join('｜'));
  }
});

test('⭐ 重述｜反誤殺：真實的壞標頭（尾巴帶 r2、Medium、全形標點）必須仍然可重述', () => {
  // 白名單收得太緊就會誤殺真實案例——#410 的 r3 壞標頭尾巴就有「（1 Medium；r2 兩個 High 已關閉）」。
  // 那個 r2 是在講歷史不是第二組 metadata（沒有 sha 就指不到版本），不可以被判成歧義。
  const real = '🤖 Codex｜來源：CLI（xhigh）｜審 `83e04df`｜r3｜結論：需修正（1 Medium；r2 兩個 High 已關閉）';
  const fix = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r3｜審 \`83e04df\`｜結論：需修改後再審｜原第一行：「${real}」`;
  const { problems, warnings } = verdictProblems([c(real + '\n內文'), c(fix)], HEAD, 'Codex');
  assert.deepEqual(problems, [], `真實案例不可被白名單誤殺：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /重述行接管/.test(w)), warnings.join('｜'));
});

test('⭐ 重述｜隱形字元切碎第二個 sha——整行含預設不顯示碼位＝不可重述（#418 r6 High）', () => {
  // U+115F（韓文填充字元）歸類為字母、擠得進白名單，畫面上卻不顯示——把第二個 HEAD 指紋
  // 每六碼插一個，肉眼看是同一串指紋、計數器數不到。性質收口：含這族字元一律拒收。
  const chopped = HEAD.match(/.{1,6}/g).join('\u115F');
  const evil = `🤖 Codex｜來源：CLI（xhigh）｜審 \`deadbee\`｜r1｜更正 ${chopped} r8 結論：要求修改`;
  const wash = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r1｜審 \`deadbee\`｜結論：需修改後再審｜原第一行：「${evil}」`;
  const { problems, warnings } = verdictProblems([c(evil + '\n內文'), c(wash)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
    `隱形字元切碎的第二指紋不可以被洗掉：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /隱形字元/.test(w)), warnings.join('｜'));
});

test('⭐ 重述｜全形 hex 的第二個 sha——NFKC 正規化後要數得到（#418 r6 High）', () => {
  // ｄｅａｄｂｅｅｆ… 全在 \p{L}/\p{N} 白名單內、原字串數不到，但畫面上就是一串指紋。
  const fw = [...HEAD].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0)).join('');
  const evil = `🤖 Codex｜來源：CLI（xhigh）｜審 \`deadbee\`｜r1｜更正 ${fw} r8 結論：要求修改`;
  const wash = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r1｜審 \`deadbee\`｜結論：需修改後再審｜原第一行：「${evil}」`;
  const { problems, warnings } = verdictProblems([c(evil + '\n內文'), c(wash)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)),
    `全形指紋不可以逃過歧義計數：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /第二個 sha 長相的字/.test(w)), warnings.join('｜'));
});

// ── 來源字串漂掉：同一位審查者被拆成兩個身分（2026-08-14 PR #453 實際踩到）─────────
// 同一個 codex CLI，來源在不同輪次被打成 `CLI（gpt-5.6-sol xhigh）` 與
// `codex CLI (gpt-5.6-sol, xhigh)`（全形／半形括號、有無 codex 前綴、有無逗號都不同），
// 閘把它拆成**兩位**審查者：r8 的「需修改後再審」掛在其中一個身分底下、他自己沒撤銷 ⇒ 擋一次；
// 補了那一半，另一半又停在舊 sha ⇒ 再擋一次。
//
// ⚠️ 這一族考題釘的是**兩件事同時成立**：
//   ①長得像要**出聲**（現場沒有任何一句話說「這兩個可能是同一位」，人就看不出來）
//   ②**絕不可以自動把兩個身分併成一位**——不同 session 本來就該是不同審查者（#383 的病根），
//     自動正規化＝削弱這道閘。②比①重要：只有①壞掉會少一句提醒，②壞掉是安全退步。

const DRIFT_A = 'CLI（gpt-5.6-sol xhigh）';
const DRIFT_B = 'codex CLI (gpt-5.6-sol, xhigh)';

test('⭐ 來源相似｜#453 的真實兩種寫法要被點名（差一截前綴也要抓到）', () => {
  // ⚠️ 只比「去掉標點空白後**相等**」會漏掉這一個真實案例——差別不只標點，還多了 `codex` 前綴。
  const why = sourceLookalike(DRIFT_A, DRIFT_B);
  assert.ok(why, '#453 的真實案例沒被偵測到（判準只比相等就會漏掉多一個工具名前綴的那次）');
  assert.match(why, /包在另一個裡面/);
});

test('來源相似｜只差全形半形與標點 → 正規化後完全相同', () => {
  assert.match(sourceLookalike('codex CLI（xhigh）', 'codex CLI (xhigh)') || '', /完全相同/);
});

test('⭐ 來源相似｜全形**英數**也要折（NFKC 被拿掉時要轉紅）', () => {
  // Codex #456 r3 Medium②：只刪 looseSource 的 .normalize('NFKC')，90 題全綠——
  // 因為上面那題只差**括號**，而括號本來就會被後面的 regex 刪掉 ⇒ 那一題根本沒守到 NFKC。
  // 全形英數（Ｃｏｄｅｘ ＣＬＩ）不會被 regex 刪掉，只有 NFKC 折得動它。
  assert.match(sourceLookalike('Ｃｏｄｅｘ ＣＬＩ', 'codex CLI') || '', /完全相同/);
});

test('⭐ 來源相似｜真的不同的 session 一個都不准被點名（誤報會教人整批忽略提醒）', () => {
  for (const [a, b] of [
    ['桌面 A', '桌面 B'],
    ['codex CLI 版面', 'codex CLI 數字'],   // 同一輪兩個 session 的建議取名法：不互相包含
    ['Claude 桌面', 'Claude CLI'],
  ]) assert.equal(sourceLookalike(a, b), null, `「${a}」與「${b}」被誤判成同一位`);
});

test('⭐ 來源相似｜出聲提醒，但**判定一格都不放寬**（不可以自動併身分）', () => {
  // 真實情境重播：同一個 codex CLI，r8 用 A 寫「需修改後再審」，r9 用 B 寫「通過」。
  const { problems, warnings } = verdictProblems([
    c(head('Codex', DRIFT_A, HEAD, 8, '需修改後再審')),
    c(head('Codex', DRIFT_B, HEAD, 9, '通過')),
  ], HEAD, 'Codex');
  assert.ok(warnings.some((w) => /可能是同一位審查者被打成兩種寫法/.test(w)),
    `沒有出聲提醒：${warnings.join('｜')}`);
  // ⚠️ 這一行是本題的**主軸**：把提醒實作成「自動併成同一位」的話，r9 的通過就撤銷了 r8 的阻擋
  //    ⇒ problems 會變成空的。閘必須照舊把它們當兩位審查者。
  assert.ok(problems.some((p) => /還沒有被同一位審查者撤銷/.test(p)),
    `提醒被寫成自動合併身分了——那是削弱這道閘，方向剛好相反：${problems.join('｜')}`);
});

test('⭐ 來源相似｜提醒**不阻擋**：兩個身分都對目前 head 通過時照樣放行', () => {
  const { problems, warnings } = verdictProblems([
    c(head('Codex', DRIFT_A, HEAD, 8, '通過')),
    c(head('Codex', DRIFT_B, HEAD, 9, '通過')),
  ], HEAD, 'Codex');
  assert.deepEqual(problems, [], `相似提醒不可以自己變成一道阻擋：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /可能是同一位審查者被打成兩種寫法/.test(w)), warnings.join('｜'));
});

test('來源相似｜角色不同就不比（Claude 與 Codex 各有一個叫 CLI 的 session 很正常）', () => {
  const { warnings } = verdictProblems([
    c(head('Claude', 'codex CLI', HEAD, 1, '通過')),
    c(head('Codex', 'codex CLI (xhigh)', HEAD, 1, '通過')),
  ], HEAD, 'Claude');
  assert.equal(warnings.filter((w) => /可能是同一位審查者/.test(w)).length, 0,
    `不同角色被當成同一位了：${warnings.join('｜')}`);
});

test('來源相似｜提醒要把補救講清楚（補發、兩個身分都要收尾、不可編輯舊留言）', () => {
  // 提醒只說「這兩個像」而沒說怎麼辦，現場還是會去編輯舊留言——那會洗掉稽核軌跡。
  const { warnings } = verdictProblems([
    c(head('Codex', DRIFT_A, HEAD, 8, '通過')),
    c(head('Codex', DRIFT_B, HEAD, 9, '通過')),
  ], HEAD, 'Codex');
  const w = warnings.find((x) => /可能是同一位審查者/.test(x)) || '';
  // ⚠️ 這一串是 Codex #456 r1 Medium③ 補的：原本只斷言「補發」兩個字，
  //    把「**兩個身分各自**」改成「其中一個身分」照樣全綠——**題名宣稱守住的東西沒有斷言**。
  //    只補一個身分正是 #453 第二次被擋的死法（另一半停在舊 sha）。
  // ⚠️ r2 又抓到一顆：只斷言「輪次要大於」的話，把承重的「**自己**」偷換成別的字照樣全綠
  //    （Codex #456 r2 Medium③ 實測把「最高輪次」改成「最低輪次」，89 題全綠）。
  //    ⇒ 這一句**整句逐字**斷言，因為每個字都承重（各自／自己／最高）。
  for (const must of ['現況列出的每一個身分', '輪次要大於「那個身分自己」現有的最高輪次',
    '全部都要再跟一次', '下一支 PR',
    '不要用編輯舊留言的方式修', 'REVIEW-AND-MERGE.md']) {
    assert.ok(w.includes(must), `相似提醒少了「${must}」：${w}`);
  }
  // ⚠️ 處方**不可以**寫死身分數量（Codex #456 r4 Medium①：三個別名時只補兩個照樣紅）
  assert.ok(!/兩個身分各自|兩個都要/.test(w), `提醒把身分數量寫死成「兩個」了：${w}`);
});

test('⭐ 來源相似｜只差大小寫也要抓到（`.toLowerCase()` 被拿掉時要轉紅）', () => {
  // Codex #456 r2 Medium③ 的第二顆存活突變：拿掉 looseSource 的 .toLowerCase()，89 題全綠，
  // 但純大小寫漂移（同一個人第二輪把 CLI 打成 cli）就再也不提醒了。
  assert.match(sourceLookalike('codex cli', 'Codex CLI') || '', /完全相同/);
});

test('⭐ 來源相似｜`CLI` vs `codex CLI` 要抓到（LOOSE_MIN 是門檻，不是隨手填的數字）', () => {
  // Codex #456 r1 Medium③：把 LOOSE_MIN 從 3 改成 4，86 題全綠，但 `CLI` 那一族就不再提醒了
  // ——而 `CLI（gpt-5.6-sol xhigh）` 那種漂法正是 #453 的現場。門檻要兩個方向都釘住。
  assert.ok(sourceLookalike('CLI', 'codex CLI'), '`CLI` 正好在門檻上＝要比（LOOSE_MIN 調大會靜靜關掉這一族）');
  assert.equal(sourceLookalike('桌面', '桌面版'), null, '兩個字的名字互相包含沒有指示性，刻意不比（LOOSE_MIN 調小會開始亂吵）');
  // ⚠️ **參數順序反過來也要抓到**（Codex #456 r5 建議）：把 `[short, long]` 的長短排序突變成
  //    固定 `[x, y]`，82 題全綠，但 `('codex CLI', 'CLI')` 就漏報了——而閘是兩兩配對掃的，
  //    誰先誰後只看留言出現的順序，等於一半的情況失去提醒。
  assert.ok(sourceLookalike('codex CLI', 'CLI'), '參數反過來就漏報了——長短排序沒有考題守著');
});

test('⭐ 來源相似｜劃界要講**性質**，不可以列清單（列舉補不完，r1→r2 連錯兩次）', () => {
  // r1 我寫「抓不到的有三族」，Codex r2 當場又找出三族不在名單上——`main` 原本沒有任何窮盡宣稱，
  // 我卻新增了一句撐不住的 ⇒ 那是**一處**相對 main 的變糟（⚠️ r3 又找到第二處，所以這裡
  // 刻意不寫「唯一」——「唯一」本身就是一個沒有考題撐著的保證，我在講這件事的註解裡又犯一次）。
  // 這一題釘的不是「有沒有列到某一族」，而是**文件有沒有把邊界寫成演算法本身**。
  for (const [a, b] of [
    ['codex CLI (gpt-5.6-sol, xhigh)', 'codex CLI (gpt-5.6-sol, medium)'],   // 共同前綴、不同後綴
    ['本機 codex CLI', '桌面 codex CLI'],                                     // 共同後綴、不同前綴
    ['codex CLI xhigh', 'xhigh codex CLI'],                                   // 換序
    ['codex CLI xhigh', 'codex CLl xhigh'],                                   // 中間打錯一個字
  ]) assert.equal(sourceLookalike(a, b), null, `「${a}」與「${b}」的判定與劃界不符`);
  // ⚠️ r4 起這幾句住在**腳本註解**裡，不在操作手冊（審查者的實務判斷：手冊細到現場記不住，
  //    Unicode 細節與例示搬進腳本，手冊只留「不會合併身分、會漏報也會多嘴」一句）。
  const src = readFileSync(join(ROOT, 'scripts/check-review-verdicts.js'), 'utf8');
  assert.ok(src.includes('也不互相包含 ⇒ **不提醒**'),
    '劃界要寫成**演算法邊界**（性質），不是「抓不到的有 N 族」那種列舉——列舉已經被打穿兩次');
  // ⚠️ 斷言**帶 \p{L}/\p{N} 的完整那句**，不是「只保留 Unicode Letter」這幾個字：
  //    後者在檔案裡有兩處，刪掉一處由另一處滿足 includes ⇒ 假綠（突變 M40 當場抓到，
  //    與 M6 同一個病型：同一句活兩處）。完整句只出現在 looseSource 的三步定義裡。
  assert.ok(src.includes('只保留 Unicode Letter（`\\p{L}`）與 Number（`\\p{N}`）'),
    '正規化第③步的精確說法是「只保留 Letter／Number」，不是「拿掉標點」（r4 Medium②：留下連字號就會變一個判定）');
  assert.ok(src.includes('UTF-16'),
    '`LOOSE_MIN` 比的是 JS length＝UTF-16 編碼單位，不是 Unicode 字元數——不精確的宣稱就是失真');
  assert.ok(src.includes('例示（不是清單）'), '例子要標明是例示，不然下一個人又會當成完整清單');
  const doc = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  assert.ok(doc.includes('**會漏報、也會多嘴**'),
    '操作手冊至少要留「提醒會漏報也會誤報」這一句，不然現場會把它當成保證');
});

test('⭐ 來源相似｜印出來的**理由**要把正規化三步都講到（不然大小寫漂移時會說錯原因）', () => {
  // Codex #456 r4 Medium②：理由字串原本漏了「轉小寫」，純大小寫漂移時終端會說成標點或全形的差別。
  // ⚠️ 而我修完之後只斷言 /完全相同/，把整句換回舊寫法照樣全綠（突變 M36）——**題名宣稱的是理由**，
  //    所以要斷言理由本身。兩個分支（相等／包含）都要講到三步。
  for (const [a, b] of [['Ｃｏｄｅｘ ＣＬＩ', 'codex CLI'], ['CLI', 'codex CLI']]) {
    const why = sourceLookalike(a, b) || '';
    assert.match(why, /折全形/, `「${a}」vs「${b}」的理由沒講到 NFKC：${why}`);
    assert.match(why, /轉小寫/, `「${a}」vs「${b}」的理由沒講到轉小寫：${why}`);
    assert.match(why, /只留字母與數字/, `「${a}」vs「${b}」的理由沒講到字元邊界：${why}`);
  }
});

test('⭐ 來源相似｜字元邊界：連字號會被刪（`codex-CLI` 與 `codexCLI` 算同一個）', () => {
  // Codex #456 r4 Medium②：把 regex 突變成「額外保留 `-`」，92 題全綠——
  // 也就是「只保留 Letter／Number」這條邊界完全沒有考題守著。
  assert.match(sourceLookalike('codex-CLI', 'codexCLI') || '', /完全相同/);
});

test('⭐ 補救程序重播：兩個身分各自用**更高輪次**補發到目前 head，才真的解得掉', () => {
  // Codex #456 r1 阻擋①：文件原本只說「兩個身分都對目前 head 補發」，沒說輪次要往上跳
  // ——**照文件做會失敗**。這一題把整套救濟重播一次，把「怎樣沒用、怎樣才有用」都釘住。
  const OLD = 'ffee0011223344556677889900aabbccddeeff00';
  const drifted = [
    c(head('Codex', DRIFT_A, OLD, 8, '需修改後再審')),   // 漂掉的身分 A：阻擋，停在舊 sha
    c(head('Codex', DRIFT_B, OLD, 9, '通過')),           // 漂掉的身分 B：通過，也停在舊 sha
  ];
  assert.ok(verdictProblems(drifted, HEAD, 'Codex').problems.length > 0, '前提：漂掉的現場本來就擋著');

  // ❌ 照**原輪次**補發＝兩個方向都沒用
  const sameRound = verdictProblems([...drifted,
    c(head('Codex', DRIFT_A, HEAD, 8, '通過')),          // 同輪相反結論 ⇒ fail-closed，照樣阻擋
    c(head('Codex', DRIFT_B, HEAD, 9, '通過')),          // 同輪 ⇒ 不取代，仍停在舊 sha
  ], HEAD, 'Codex');
  assert.ok(sameRound.problems.some((p) => /同一輪（r8）出現相反結論/.test(p)),
    `同輪補發不可以解除阻擋：${sameRound.problems.join('｜')}`);
  assert.ok(sameRound.problems.some((p) => /是對 ffee001/.test(p)),
    `同輪補發也不會把身分推到目前 head：${sameRound.problems.join('｜')}`);

  // ✅ 兩個身分**各自**用比最高輪次更高的 r10 補發到目前 head ⇒ 全清
  const fixed = verdictProblems([...drifted,
    c(head('Codex', DRIFT_A, HEAD, 10, '通過')),
    c(head('Codex', DRIFT_B, HEAD, 10, '通過')),
  ], HEAD, 'Codex');
  assert.deepEqual(fixed.problems, [], `照文件走完補救程序之後應該全清：${fixed.problems.join('｜')}`);

  // ✅ **每個身分各自**大於自己的最高輪次也行（r2 精確化：r10 只是安全的簡化寫法，不是必要條件）
  const perIdentity = verdictProblems([...drifted,
    c(head('Codex', DRIFT_A, HEAD, 9, '通過')),    // A 自己停在 r8 ⇒ r9 就夠
    c(head('Codex', DRIFT_B, HEAD, 10, '通過')),   // B 自己停在 r9 ⇒ 要 r10
  ], HEAD, 'Codex');
  assert.deepEqual(perIdentity.problems, [],
    `閘的規則是每個身分各自算，分別用 r9／r10 也該全清：${perIdentity.problems.join('｜')}`);

  // ⚠️ 只補一個身分＝#453 第二次被擋的死法，必須仍然擋著
  const halfDone = verdictProblems([...drifted, c(head('Codex', DRIFT_A, HEAD, 10, '通過'))], HEAD, 'Codex');
  assert.ok(halfDone.problems.some((p) => /是對 ffee001/.test(p)),
    `只補一半就放行了——那正是 #453 第二次被擋的原因：${halfDone.problems.join('｜')}`);

  // ⚠️ **判準的單位是「身分」，不是「兩個」**（Codex #456 r4 Medium①）：第三個別名一樣要收。
  //    現實來源：重述產生的身分、中途換掉的審查角色、同一個工具第三種寫法。
  const DRIFT_C = 'codex CLI(gpt-5.6-sol xhigh)';
  const three = [...drifted, c(head('Codex', DRIFT_C, OLD, 9, '通過'))];
  const twoOfThree = verdictProblems([...three,
    c(head('Codex', DRIFT_A, HEAD, 10, '通過')),
    c(head('Codex', DRIFT_B, HEAD, 10, '通過')),
  ], HEAD, 'Codex');
  assert.ok(twoOfThree.problems.some((p) => /是對 ffee001/.test(p)),
    `三個別名只補兩個就放行了——處方寫死「兩個」正是這樣出事：${twoOfThree.problems.join('｜')}`);
  const allThree = verdictProblems([...three,
    c(head('Codex', DRIFT_A, HEAD, 10, '通過')),
    c(head('Codex', DRIFT_B, HEAD, 10, '通過')),
    c(head('Codex', DRIFT_C, HEAD, 10, '通過')),
  ], HEAD, 'Codex');
  assert.deepEqual(allThree.problems, [], `三個都收才該全清：${allThree.problems.join('｜')}`);
});

test('⭐ 補救之後 head 再前進：兩個身分**都**要再跟一次（別名在本 PR 內永久存在）', () => {
  // Codex #456 r3 阻擋①：我原本第 4 步寫「從下一輪起只用選定的那一個字串」——**照做會再被鎖住**。
  // 留言歷史刪不掉 ⇒ 兩個別名永遠是這支 PR 的兩個身分，而閘要求每個沒阻擋的身分都停在目前 head。
  // 「只用固定那一個」要到**下一支 PR**（留言歷史重新開始）才成立。
  const H1 = 'ffee0011223344556677889900aabbccddeeff00';
  const settled = [   // 兩個身分都已經補到 H1 ⇒ 對 H1 全清
    c(head('Codex', DRIFT_A, H1, 10, '通過')),
    c(head('Codex', DRIFT_B, H1, 10, '通過')),
  ];
  assert.deepEqual(verdictProblems(settled, H1, 'Codex').problems, [], '前提：對 H1 本來是全清的');

  // head 前進到 H2，只讓選定的那一個（A）跟上 ⇒ **仍然紅**（B 停在 H1）
  const onlyChosen = verdictProblems([...settled, c(head('Codex', DRIFT_A, HEAD, 11, '通過'))], HEAD, 'Codex');
  assert.ok(onlyChosen.problems.some((p) => /是對 ffee001/.test(p)),
    `只補選定的那一個就放行了——那正是「從下一輪起只用一個字串」會踩的雷：${onlyChosen.problems.join('｜')}`);

  // 兩個都跟到 H2 ⇒ 才綠
  const bothFollow = verdictProblems([...settled,
    c(head('Codex', DRIFT_A, HEAD, 11, '通過')),
    c(head('Codex', DRIFT_B, HEAD, 11, '通過')),
  ], HEAD, 'Codex');
  assert.deepEqual(bothFollow.problems, [], `兩個身分都跟上就該全清：${bothFollow.problems.join('｜')}`);
});

test('REVIEW-AND-MERGE.md 要有標準來源字串表與「補發、不可編輯舊留言」的補救程序', () => {
  // ⚠️ 誠實劃界：文件題只證明「規則寫在該寫的地方、沒有被靜靜刪掉」，
  //    證明不了任何人真的照著打字（那要靠審查與上面那道相似提醒）。
  //    但機制只活在腳本裡＝打字漂掉的人**不知道該用哪個字串、也不知道怎麼救**，
  //    #453 兩次被擋就是這樣來的。
  const doc = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  assert.ok(doc.includes('### ⚠️ 發審查提示：**兩組字串每輪都要逐字給**'),
    'REVIEW-AND-MERGE.md 找不到「發審查提示」那一節');
  // ⚠️ **斷言整列，不是斷言那個字串**：第一版只寫 `doc.includes('`codex CLI`')`，
  //    把整列從表格刪掉照樣全綠——因為同一串字在下面那條「不要留一個沒後綴的 `codex CLI`」
  //    裡也出現過，includes 被別處滿足了（本專案認過的病型：同一句活兩處、改壞一處看不見）。
  //    突變當場抓到（M6），這裡改成整列比對。
  for (const row of [
    '| 本機 `codex` CLI 起的審查 session | `codex CLI` |',
    '| Claude Code CLI 起的審查 session | `Claude CLI` |',
    '| Codex 桌面 session | `Codex 桌面` |',
    '| Claude 桌面 session | `Claude 桌面` |',
    '| William 本人（畫面驗收／產品裁決） | `William 本人` |',
  ]) assert.ok(doc.includes(row), `標準來源字串表少了這一列：${row}\n（沒有建議值，每個人就會自己編一個）`);
  assert.ok(doc.includes('跨輪次一字不改'), '少了「同一個工具跨輪次不可改寫法」那條');
  assert.ok(doc.includes('通過`／`需修改後再審`／`不可合併'),
    '發審查提示要**逐字**列出三個合規結論字串（沒列出來的那次，五支 PR 全被壞標頭鎖死）');
  assert.ok(doc.includes('#### 已經漂掉的補救：**用補發，不可以編輯舊留言**'),
    '少了補救程序那一節的標題（正解＝補發一則新結論，不是改舊的）');
  // r4 Medium①：判準的單位是**身分**，不是寫死的「兩個」（三個別名時只補兩個照樣紅）
  assert.ok(doc.includes('判準的單位是**身分**'),
    '補救程序把身分數量寫死了——第三個別名／重述產生的身分／換掉的審查角色都要收');
  // r1 阻擋＋r2 精確化：閘只認「更新的輪次」，而且是**每個身分各自**算
  assert.ok(doc.includes('輪次要大於「那個身分自己」現有的最高輪次'),
    '補救程序少了輪次那條——照原輪次補發撤銷不掉，而規則是每個身分各自算');
  // r3 阻擋①：別名在本 PR 內永久存在，head 再動就全部要跟——不寫這條，照舊版做會被重新鎖住
  assert.ok(doc.includes('本 PR 內所有已經出現過的身分都要跟著 head；新 PR 起只用標準來源'),
    '補救程序少了「別名在本 PR 內永久存在」的心智模型——照舊版做，下次推 commit 會再被鎖住');
  assert.ok(doc.includes('不可以編輯舊的結論留言'),
    '少了補救程序的禁令——編輯舊留言會把稽核軌跡洗掉，事後查不出當初寫了什麼');
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('「來源」是機械身分'),
    'AGENTS.md 少了指路的那一句（規則只寫在操作手冊裡，讀規則書的人看不到）');
});

// ── 缺 sha 例外＋豁免宣告（2026-08-17 William 裁「兩個都做」；實例＝#475 sha 欄空白、#461 讀不出型）──
// 死角＝留言之所以壞、常常正是缺四欄之一：缺 sha 的重述永遠對不了帳、缺身分的連重述資格都判不出，
// 兩例都只能靠 William 特准刪留言收場（刪除傷稽核、逐字存檔還會把 🤖 抄成新毒丸）。

const NOSHA_FIRST = '🤖 Codex｜來源：CLI（xhigh）｜審 ｜r6｜結論：需修改後再審';
const NOSHA_MAL = `${NOSHA_FIRST}\n\n細節略。`;

test('⭐ 缺sha例外｜sha 欄空白、其餘三欄讀得出 → 重述行自報版本即可接管', () => {
  const restate = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${NOSHA_FIRST}」`;
  const { problems, warnings } = verdictProblems([c(NOSHA_MAL), c(restate)], HEAD, 'Codex');
  assert.deepEqual(problems, [], problems.join('｜'));
  assert.ok(warnings.some((w) => /重述行接管/.test(w)), '要留一句可稽核的警告');
});

test('⭐ 缺sha例外｜引文別處冒出 sha 長相的字 → 零容忍、不可重述', () => {
  // 空欄位＋別處的指紋＝讀不準它在講哪個版本。四欄型容許恰一個，缺 sha 型必須零個。
  const first = '🤖 Codex｜來源：CLI（xhigh）｜審 ｜r6｜結論：需修改後再審 deadbee';
  const restate = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${first}」`;
  const { problems, warnings } = verdictProblems([c(`${first}\n\n略。`), c(restate)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `必須維持阻擋：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /全行零個/.test(w)), warnings.join('｜'));
});

test('⭐ 缺sha例外｜別人不能替我重述（身分綁定照舊）', () => {
  const byClaude = `${head('Claude', '桌面', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`abc1234\`｜結論：通過｜原第一行：「${NOSHA_FIRST}」`;
  const { problems, warnings } = verdictProblems([c(NOSHA_MAL), c(byClaude)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `必須維持阻擋：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /只能重述\*\*自己\*\*/.test(w)), warnings.join('｜'));
});

test('⭐ 缺sha例外｜輪次仍要綁引文（引文 r6、重述行報 r5 → 無效）', () => {
  const restate = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r5｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${NOSHA_FIRST}」`;
  const { problems, warnings } = verdictProblems([c(NOSHA_MAL), c(restate)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `必須維持阻擋：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /輪次仍要綁引文/.test(w)), warnings.join('｜'));
});

// 豁免宣告：三重指認（留言編號＋逐字引文＋特准日期）＋順序＋只中和不產生。
const cu = (/** @type {string} */ body, /** @type {string} */ url) => ({ body, url });
const UNFIX_FIRST = '🤖 ｜來源：｜審 ｜r｜結論：需修改後再審';       // 連身分都讀不出＝重述救不了的型
const UNFIX_URL = 'https://github.com/x/y/pull/9#issuecomment-5310870038';
const EXEMPT_OK = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
  + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「${UNFIX_FIRST}」`;

test('⭐ 豁免｜三重指認齊備＋宣告在壞留言之後 → 阻擋中和、留言原地保留', () => {
  const { problems, warnings } = verdictProblems(
    [cu(`${UNFIX_FIRST}\n\n略。`, UNFIX_URL), c(EXEMPT_OK)], HEAD, 'Codex');
  assert.deepEqual(problems, [], problems.join('｜'));
  assert.ok(warnings.some((w) => /已被\*\*豁免\*\*.*William 特准 2026-08-17/.test(w)), warnings.join('｜'));
});

test('⭐ 豁免｜留言編號對不上 → 不生效、維持阻擋', () => {
  const { problems } = verdictProblems(
    [cu(`${UNFIX_FIRST}\n\n略。`, 'https://github.com/x/y/pull/9#issuecomment-9999999'), c(EXEMPT_OK)],
    HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `編號不符必須維持阻擋：${problems.join('｜')}`);
});

test('⭐ 豁免｜留言物件沒有 url（讀不到編號）→ fail-closed 維持阻擋', () => {
  const { problems } = verdictProblems([c(`${UNFIX_FIRST}\n\n略。`), c(EXEMPT_OK)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `讀不到編號必須維持阻擋：${problems.join('｜')}`);
});

test('⭐ 豁免｜豁免不掉合規結論的阻擋（只能中和「標頭寫壞」那條）', () => {
  // 危險情境：拿豁免宣告去洗一則**合規**的「需修改後再審」。結構上豁免只查 malformed 名單，
  // 這題釘住那個結構不被改掉。
  const validBlock = `${head('Codex', 'CLI（xhigh）', HEAD, 6, '需修改後再審')}\n\n細節略。`;
  // 豁免行不可放在同一位審查者更高輪的「通過」裡驗——那樣 r7 本來就撤銷了 r6、題目變空包彈；
  // 放在**別人**（無撤銷效力）的留言裡，阻擋若消失就只可能是豁免洗的。
  const washByClaude = `${head('Claude', '桌面', HEAD, 1, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「${head('Codex', 'CLI（xhigh）', HEAD, 6, '需修改後再審')}」`;
  const r2 = verdictProblems([cu(validBlock, UNFIX_URL), c(washByClaude)], HEAD, 'Codex');
  assert.ok(r2.problems.some((p) => /需修改後再審.*還沒有被同一位審查者撤銷/.test(p)),
    `合規阻擋不可被豁免洗掉：${r2.problems.join('｜')}`);
});

test('⭐ 豁免｜宣告出現在壞留言之前 → 不可預先授權、維持阻擋', () => {
  const { problems } = verdictProblems(
    [c(EXEMPT_OK), cu(`${UNFIX_FIRST}\n\n略。`, UNFIX_URL)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `預先授權必須擋：${problems.join('｜')}`);
});

test('⭐ 豁免｜不產生任何結論進聯集（豁免了壞留言，放行仍要靠真的「通過」）', () => {
  // 只有壞留言＋豁免宣告（宣告者是實作者 Claude、不是指定審查者）＝沒有 Codex 的通過 ⇒ 仍不可合併。
  const exemptByClaude = `${head('Claude', '桌面', HEAD, 1, '需修改後再審')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「${UNFIX_FIRST}」`;
  const { problems } = verdictProblems(
    [cu(`${UNFIX_FIRST}\n\n略。`, UNFIX_URL), c(exemptByClaude)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /沒有「Codex」對目前的 head/.test(p)),
    `豁免不可以變成放行票：${problems.join('｜')}`);
});

test('⭐ 豁免｜宣告行含隱形字元 → 不生效且收件截止', () => {
  const sneaky = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「ᅟ${UNFIX_FIRST}」`;
  const { problems, warnings } = verdictProblems(
    [cu(`${UNFIX_FIRST}\n\n略。`, UNFIX_URL), c(sneaky)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `隱形字元必須 fail-closed：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /隱形字元/.test(w)), warnings.join('｜'));
});

test('⭐ 豁免｜編號對、引文錯 → 不生效、維持阻擋（三重指認的引文腿）', () => {
  // 危險情境（污染掃描的 F1、人工驗證屬實）：只驗編號的話，留言事後被編輯成另一段壞第一行，
  // 舊豁免仍生效＝引文腿名存實亡。突變「拿掉 e.key === m.key」必須讓本題轉紅。
  const wrongQuote = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + '豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「🤖 ｜來源：｜審 ｜r｜結論：不可合併」';
  const { problems } = verdictProblems(
    [cu(`${UNFIX_FIRST}\n\n略。`, UNFIX_URL), c(wrongQuote)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `引文不符必須維持阻擋：${problems.join('｜')}`);
});

test('⭐ 豁免｜宣告在壞留言之前且三重指認都對 → 不生效，但要出聲（對稱提示）', () => {
  const { problems } = verdictProblems(
    [c(EXEMPT_OK), cu(`${UNFIX_FIRST}\n\n略。`, UNFIX_URL)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), problems.join('｜'));
  // ⚠️ 第一版斷言是空包彈（warnings.length === 0 恆真＝OR 左肢永遠成立）——污染掃描二號抓到。
  assert.ok(problems.some((p) => /豁免不可以預先授權/.test(p)),
    `提早的豁免要在阻擋訊息裡出聲：${problems.join('｜')}`);
});

test('⭐ 缺sha例外｜自報「通過」不能變成對目前 head 的放行票（回歸縫）', () => {
  // 污染掃描的 F3、人工驗證屬實：缺 sha 重述自報版本＝唯一沒有引文對帳的 sha 來源。
  // 載體標頭 r7 阻擋、重述行 r6 自報「通過＋目前 head」——聯集裡 r7 蓋過 r6，
  // 放行仍必須靠真的「通過」。若未來有人放寬規則④或調換 apply 順序，本題轉紅。
  const noshaPassFirst = '🤖 Codex｜來源：CLI（xhigh）｜審 ｜r6｜結論：通過';
  const carrier = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '需修改後再審')}\n`
    + `重述 r6｜審 \`${HEAD}\`｜結論：通過｜原第一行：「${noshaPassFirst}」`;
  const { problems } = verdictProblems([c(`${noshaPassFirst}\n\n略。`), c(carrier)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /需修改後再審.*還沒有被同一位審查者撤銷/.test(p)),
    `r7 阻擋必須還在：${problems.join('｜')}`);
  assert.ok(problems.some((p) => /沒有「Codex」對目前的 head/.test(p) || /需修改後再審/.test(p)),
    `自報通過不可成為放行票：${problems.join('｜')}`);
});

test('⭐ 缺sha例外｜假標頭藏在引文中段（行首讀不出）→ 不可重述（行首錨承重）', () => {
  // 污染掃描二號抓到：QUOTED_HEAD_NOSHA 的 ^ 沒有考題——拿掉行首錨後，
  // 「行首是垃圾、中段才出現缺 sha 假標頭」會被綁成低輪接管，#418 規則⑤原樣重演。
  const midFirst = '審查備註 🤖 Codex｜來源：CLI（xhigh）｜審 ｜r6｜結論：需修改後再審';
  const restate = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`abc1234\`｜結論：需修改後再審｜原第一行：「${midFirst}」`;
  const { problems, warnings } = verdictProblems([c(`${midFirst}\n\n略。`), c(restate)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `行首讀不出必須維持阻擋：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /讀不出「誰寫的、審哪個 sha、第幾輪」/.test(w)), warnings.join('｜'));
});

test('⭐ 豁免｜引文只寫壞行的前綴 → 不生效（逐字＝整句，不是包含）', () => {
  // 污染掃描二號抓到：引文腿弱化成 includes 時，「原第一行：「🤖 ｜來源：」」這種前綴宣告
  // 就能中和整句更長的壞標頭——留言事後改寫仍含該前綴，舊豁免繼續生效。
  const prefixQuote = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + '豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「🤖 ｜來源：」';
  const { problems } = verdictProblems(
    [cu(`${UNFIX_FIRST}\n\n略。`, UNFIX_URL), c(prefixQuote)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `前綴引文必須維持阻擋：${problems.join('｜')}`);
});

// ── #477 r1 回饋：豁免資格三重收緊＋反引號切碎指紋＋文件階梯釘題 ──────────────

test('⭐ 豁免資格｜四欄可讀的壞標頭（結論寫錯字型）不可豁免＝必須走同身分重述', () => {
  // r1 High① 攻擊劇本：Codex r6 打錯結論（四欄可讀），Claude 用豁免宣告替它洗掉＝繞過同身分紀律。
  const readable = '🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜r6｜結論：要求修改';
  const wash = `${head('Claude', '桌面', HEAD, 1, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「${readable}」`;
  const { problems } = verdictProblems(
    [cu(`${readable}\n\n略。`, UNFIX_URL), c(wash)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `必須維持阻擋：${problems.join('｜')}`);
  assert.ok(problems.some((p) => /不符合豁免資格/.test(p)), `要講清楚為什麼沒生效：${problems.join('｜')}`);
});

test('⭐ 豁免資格｜缺 sha 型不可豁免＝必須走缺 sha 例外', () => {
  const wash = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「${NOSHA_FIRST}」`;
  const { problems } = verdictProblems(
    [cu(NOSHA_MAL, UNFIX_URL), c(wash)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `必須維持阻擋：${problems.join('｜')}`);
  assert.ok(problems.some((p) => /不符合豁免資格/.test(p)), problems.join('｜'));
});

test('⭐ 豁免資格｜第一行不含 🤖（🤖在後文）＝前言行不可當鑰匙（防事後編輯續命）', () => {
  // r1 High① 的編輯重播劇本：留言=「審查備註\n🤖 …」，豁免綁「審查備註」；
  // 之後把後文改成新的阻擋句，id 與第一行不變＝舊豁免續命。鑰匙必須是壞標頭本行。
  const preamble = '審查備註\n🤖 Codex｜來源：CLI（xhigh）｜審 壞掉 r6 結論 要求修改';
  const wash = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + '豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「審查備註」';
  const { problems } = verdictProblems(
    [cu(preamble, UNFIX_URL), c(wash)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `前言行鑰匙必須失效：${problems.join('｜')}`);
});

test('⭐ 缺sha例外｜成對反引號切碎的指紋照樣算指紋（拆掉再數）', () => {
  // r1 High②：`dead`＋`beef` 每段都短於 7 位＝舊計數為零，畫面上卻是一串指紋。
  const chopped = '🤖 Codex｜來源：CLI（xhigh）｜審 ｜r6｜結論：需修改後再審 `dead``beef1`';
  const restate = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `重述 r6｜審 \`${HEAD}\`｜結論：通過｜原第一行：「${chopped}」`;
  const { problems, warnings } = verdictProblems([c(`${chopped}\n\n略。`), c(restate)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `切碎指紋必須維持阻擋：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /全行零個/.test(w)), warnings.join('｜'));
});

test('⭐ 文件｜救濟階梯與「不再刪留言」要在兩份文件都站著（指路不漂）', () => {
  const review = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  assert.ok(/救濟階梯/.test(review), 'REVIEW-AND-MERGE 少了救濟階梯——執行者只會看到舊處方');
  assert.ok(/不再刪留言/.test(review), 'REVIEW-AND-MERGE 少了「不再刪留言」——會有人照舊例去刪');
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(/缺 sha 例外/.test(agents) && /豁免宣告/.test(agents),
    'AGENTS 還在講「唯一救濟」＝只讀規則書的人拿到過期處方');
  assert.ok(!/重述＝壞標頭的唯一救濟/.test(agents), '「唯一救濟」這句必須退場（已有三級階梯）');
});

// ── #477 r2 回饋：資格與正式身分同語意（雙向）＋雜湊指認救「引不出來」的行 ──────

test('⭐ 資格同語意｜角色打錯字（Codeex）＝身分讀不出 → 可被豁免（永久鎖死解除）', () => {
  // r2 High① 方向一：前綴正則 match 到 Codeex＝舊資格禁豁免，但重述也被 canonicalRole 拒收
  // ＝三級全接不了。新語意：canonical 讀不出＝真正的階梯③型。
  const typoFirst = '🤖 Codeex｜來源：CLI（xhigh）｜審 `abc1234`｜r6｜結論：不可合併';
  const exempt = `${head('Claude', '桌面', HEAD, 1, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「${typoFirst}」`;
  const { problems, warnings } = verdictProblems(
    [cu(`${typoFirst}\n\n略。`, UNFIX_URL), c(exempt)], HEAD, 'Codex');
  assert.ok(!problems.some((p) => /標頭格式不合規/.test(p)), `Codeex 型必須救得動：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /已被\*\*豁免\*\*/.test(w)), warnings.join('｜'));
});

test('⭐ 資格同語意｜來源全空白＝身分讀不出 → 可被豁免', () => {
  const blankSrc = '🤖 Codex｜來源：　｜審 `abc1234`｜r6｜結論：要求修改';
  const exempt = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「${blankSrc}」`;
  const { problems } = verdictProblems(
    [cu(`${blankSrc}\n\n略。`, UNFIX_URL), c(exempt)], HEAD, 'Codex');
  assert.ok(!problems.some((p) => /標頭格式不合規/.test(p)), `空來源型必須救得動：${problems.join('｜')}`);
});

test('⭐ 資格同語意｜身分讀得出、輪次打壞（rX）→ 同一身分可豁免', () => {
  const badRound = '🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜rX｜結論：要求修改';
  const exempt = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「${badRound}」`;
  const { problems, warnings } = verdictProblems(
    [cu(`${badRound}\n\n略。`, UNFIX_URL), c(exempt)], HEAD, 'Codex');
  assert.ok(!problems.some((p) => /標頭格式不合規/.test(p)), `同身分豁免必須生效：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /已被\*\*豁免\*\*/.test(w)), warnings.join('｜'));
});

test('⭐ 資格同語意｜身分讀得出、輪次打壞 → 別人不可豁免（越級擋下＋出聲）', () => {
  // r2 High① 方向二：舊資格把這型誤判成「讀不出」＝Claude 可以洗掉 Codex 身分可讀的壞留言。
  const badRound = '🤖 Codex｜來源：CLI（xhigh）｜審 `abc1234`｜rX｜結論：要求修改';
  const wash = `${head('Claude', '桌面', HEAD, 1, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行：「${badRound}」`;
  const { problems } = verdictProblems(
    [cu(`${badRound}\n\n略。`, UNFIX_URL), c(wash)], HEAD, 'Codex');
  assert.ok(problems.some((p) => /標頭格式不合規/.test(p)), `越級豁免必須擋：${problems.join('｜')}`);
  assert.ok(problems.some((p) => /只有\*\*同一身分\*\*可豁免/.test(p)), problems.join('｜'));
});

test('⭐ 雜湊指認｜🤖 帶 VS16 的壞行（引文守則正確拒收）→ 用雜湊豁免救得動', () => {
  // r2 High②：VS16 是 Default_Ignorable＝逐字引文被拒，但這正是「不可解析原文」的常態。
  const vs16First = '\u{1F916}\u{FE0F} 審查完畢 結論寫在這裡但格式全壞';
  const hash = createHash('sha256').update(vs16First, 'utf8').digest('hex');
  const exempt = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行雜湊：${hash}`;
  const { problems, warnings } = verdictProblems(
    [cu(`${vs16First}\n\n略。`, UNFIX_URL), c(exempt)], HEAD, 'Codex');
  assert.ok(!problems.some((p) => /標頭格式不合規/.test(p)), `VS16 型必須救得動：${problems.join('｜')}`);
  assert.ok(warnings.some((w) => /已被\*\*豁免\*\*/.test(w)), warnings.join('｜'));
});

test('⭐ 雜湊指認｜U+FFFD 壞行 → 用雜湊豁免救得動；雜湊錯一位 → 不生效', () => {
  const fffdFirst = '🤖 Codex�來源損毀 結論讀不出';
  const hash = createHash('sha256').update(fffdFirst, 'utf8').digest('hex');
  const good = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行雜湊：${hash}`;
  const ok = verdictProblems([cu(`${fffdFirst}\n\n略。`, UNFIX_URL), c(good)], HEAD, 'Codex');
  assert.ok(!ok.problems.some((p) => /標頭格式不合規/.test(p)), `U+FFFD 型必須救得動：${ok.problems.join('｜')}`);
  const wrongHash = hash.slice(0, 63) + (hash.endsWith('0') ? '1' : '0');
  const bad = `${head('Codex', 'CLI（xhigh）', HEAD, 7, '通過')}\n`
    + `豁免留言 5310870038｜William 特准 2026-08-17｜原第一行雜湊：${wrongHash}`;
  const ko = verdictProblems([cu(`${fffdFirst}\n\n略。`, UNFIX_URL), c(bad)], HEAD, 'Codex');
  assert.ok(ko.problems.some((p) => /標頭格式不合規/.test(p)), `雜湊錯一位必須維持阻擋：${ko.problems.join('｜')}`);
});

test('⭐ 文件與提示｜雜湊指認要走得通：閘的修復提示與 REVIEW 階梯都要教它', () => {
  // r3 Medium：VS16／U+FFFD 正是因逐字引文被拒才需要雜湊路徑，但提示只教逐字引用＝照做必失敗。
  const vs16First = '\u{1F916}\u{FE0F} 完全讀不出的壞行';
  const { problems } = verdictProblems([cu(`${vs16First}\n\n略。`, UNFIX_URL)], HEAD, 'Codex');
  const blocked = problems.find((p) => /標頭格式不合規/.test(p));
  assert.ok(blocked, problems.join('｜'));
  assert.ok(/原第一行雜湊/.test(String(blocked)), '修復提示必須教雜湊指認，否則照提示操作會反覆失敗');
  const review = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  assert.ok(/原第一行雜湊/.test(review), 'REVIEW 階梯必須教雜湊指認');
});
