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
