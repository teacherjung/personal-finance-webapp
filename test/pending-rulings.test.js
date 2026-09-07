// 待裁清單（scripts/pending-rulings.js）的行為題。
// 為什麼要有：這支的用途是「開工時提醒還有哪些問題他沒回」，而它最貴的失敗是**靜靜印出「沒有還沒回的」**——
// 配對錯、標頭差一個字、掃到別的 repo、分頁被截斷、外人偽造裁示留言，五種情況的輸出都會長得一樣。
// 所以這裡釘的不只是「找得到」，還有「找不到的時候看得出來」。
// ⚠️ **每一題跑 CLI 都要用假 gh 遮住**：CI 的 npm test 沒有 GitHub 權杖，忘了遮的題本機綠、到 CI 才紅。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, render, flatten, expectedTotal, shapeOf, firstLine, titleOf, numberOf, TIMEOUT_HOURS } from '../scripts/pending-rulings.js';
import { tierOf } from '../scripts/acceptance-tier.js';
import { injectDirtyGitEnv, DIRTY_GIT_ENV, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/pending-rulings.js');
const T0 = Date.parse('2026-09-01T00:00:00Z');
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
const BT = '\u0060';   // 反引號：寫成字面值會跟樣板字串打架
const BS = '\u005c';   // 反斜線：寫成字面值在樣板字串裡太容易數錯

/** 一則留言夾具。預設是 repo 擁有者貼的（三種留痕留言都必須是）。 */
function c({ id, body, at = T0, edited = false, pr = 100, assoc = 'OWNER' }) {
  return {
    id, body, author_association: assoc,
    created_at: iso(at), updated_at: iso(edited ? at + 60_000 : at),
    html_url: `https://github.com/o/r/pull/${pr}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/o/r/issues/${pr}`,
  };
}
const urlOf = (/** @type {number} */ id, /** @type {number} */ pr = 100) => `https://github.com/o/r/pull/${pr}#issuecomment-${id}`;
const ask = (/** @type {any} */ o) => c({ body: `## ❓ 待裁（2026-09-01）：${o.q ?? '要不要做這件事？'}\n選項…`, ...o });
const ruling = (/** @type {any} */ o) => c({ body: `## ⚖️ William 裁示（2026-09-02）：答覆\n原話（對話中，Claude 轉述）：**「好」**\n關的是 ${o.cites ?? ''}`, ...o });
const timeout = (/** @type {any} */ o) => c({ body: `## ⏳ 逾時暫定（2026-09-04）：同一句問題\nWilliam 未裁、隨時可翻案\n❓ 留言：${o.cites ?? ''}`, ...o });

test('沒有任何裁示留言 → 那則問題列在「還沒回」', () => {
  const r = classify([ask({ id: 1 })], T0 + 3600e3);
  assert.equal(r.pending.length, 1);
  assert.equal(r.closed.length + r.provisional.length, 0);
  assert.equal(r.pending[0].title, '要不要做這件事？');
});

test('⭐ 已結的配對要印出「關掉它的那則留言的標題」：配錯時一眼就看得出來（這是防誤關的真正安全網）', () => {
  // 二十幾輪都在可見層上防「還沒回被誤判成已結」。回頭看，工具本來就把已結的每一題**印出來附配對**，
  // 判錯從來不是無聲的——差的只是配對只印網址、要點進去才知道對不對。
  // 印出標題之後，「問題是 A、關掉它的裁示標題卻是 B」一眼就看得出來。
  const a = ask({ id: 1, q: '要不要做這件事？' });
  const b = ruling({ id: 2, at: T0 + 60e3, cites: urlOf(1) });   // 標題＝「答覆」
  const r = classify([a, b], T0 + 3600e3);
  assert.equal(r.closed[0].closedBy[0].title, '答覆', '配對資料要帶著裁示留言的標題');
  const out = render(r, { host: 'github.com', slug: 'o/r', expected: 2 });
  assert.match(out, /已裁：「答覆」/, '報告要印出關掉它的那則留言的標題，不是只印網址');
  assert.match(out, /要不要做這件事？[\s\S]*已裁：「答覆」[\s\S]*issuecomment-2/, '問題、裁示標題、網址三者要印在一起');
});

test('⭐ 跨 PR 才關得掉：問題貼在 A 支、裁示貼在 B 支並引了它的網址 → 已結（只看同一支會永遠關不掉）', () => {
  // 真語料：#577 的兩則 ❓ 是被 #578 上那則 ⚖️ 關掉的。
  const a = ask({ id: 1, pr: 577 });
  const b = ruling({ id: 2, pr: 578, at: T0 + 7200e3, cites: urlOf(1, 577) });
  const r = classify([a, b], T0 + 3 * 86400e3);
  assert.deepEqual(r.pending, []);
  assert.equal(r.closed.length, 1);
  assert.equal(r.closed[0].closedBy[0].url, b.html_url, '要附上配對連結，配錯了才看得出來');
});

test('⭐ 裁示早於問題不算關：同一支上先有一則答別題的裁示、之後才貼問題 → 仍未結', () => {
  const old = ruling({ id: 1, at: T0 - 86400e3, cites: urlOf(2) });
  const a = ask({ id: 2 });
  const r = classify([old, a], T0 + 3600e3);
  assert.equal(r.pending.length, 1, '較早的裁示不可能在回答還沒問的問題');
});

test('⭐ 引用要卡右邊界：引第 10 則的網址不算關掉第 1 則（先證明沒卡邊界的寫法真的會中）', () => {
  const a = ask({ id: 1 });
  const b = ruling({ id: 2, at: T0 + 60e3, cites: urlOf(10) });
  assert.ok(String(b.body).includes(urlOf(1)), '對照斷言：沒卡右邊界的 includes 真的會命中，這題才有意義');
  assert.equal(classify([a, b], T0 + 3600e3).pending.length, 1);
});

test('⭐ 要引的是**留言網址**，不是裸的片段：只寫 #issuecomment-1、或寫別則的網址，都不算關掉（#579 r1 High②）', () => {
  const a = ask({ id: 1 });
  const bare = ruling({ id: 2, at: T0 + 60e3, cites: '只是文字 #issuecomment-1' });
  const other = ruling({ id: 3, at: T0 + 120e3, cites: 'https://github.com/o/r/pull/999#issuecomment-1' });
  assert.equal(classify([a, bare], T0 + 4 * 86400e3).pending.length, 1, '裸片段關不掉');
  assert.equal(classify([a, other], T0 + 4 * 86400e3).pending.length, 1, '別支 PR 的同號片段也關不掉');
  const longer = ruling({ id: 5, at: T0 + 180e3, cites: `${urlOf(1)}oops` });
  assert.equal(classify([a, longer], T0 + 4 * 86400e3).pending.length, 1, '網址後面還接著字＝那是另一個位置，不算引到（#579 r2 High②）');
  // 黑名單漏掉的字：`@` 是 fragment 的合法字元，`<網址>@oops` 指向的是另一個位置（#579 r3 High②）。
  // 這一排全是「當年沒列進黑名單、卻能延長網址」的字——正向收尾字集要一次全擋掉。
  for (const tail of ['@', '&', '$', '+', '=', "'", '*', '(', '~', '%', '!', '?', ':', '/', ';', ',', '.']) {
    const ext = ruling({ id: 7, at: T0 + 300e3, cites: `${urlOf(1)}${tail}oops` });
    assert.equal(classify([a, ext], T0 + 4 * 86400e3).pending.length, 1,
      `網址後面接「${tail}」還是網址的一部分，那是另一個位置，不可以算引到`);
  }
  for (const tail of [' ', ')', '］', '。', '，', '\n']) {
    const term = ruling({ id: 6, at: T0 + 240e3, cites: `${urlOf(1)}${tail}後面` });
    assert.equal(classify([a, term], T0 + 4 * 86400e3).closed.length, 1, `網址後面接「${tail.trim() || '空白'}」＝網址結束了，要算引到`);
  }
  assert.equal(classify([a, ruling({ id: 4, at: T0 + 60e3, cites: urlOf(1) })], T0 + 4 * 86400e3).closed.length, 1, '對照組：引完整網址才關得掉');
});

test('⭐ 裁示要有**真的一段原話**：只把欄名寫進否定句，不可以關掉問題（#579 r3 High①）', () => {
  const a = ask({ id: 1 });
  // 反例逐字取自 Codex 的實測：第一行完全合規、內文把欄名寫在否定句裡，舊判準（includes 欄名）會回 ruling。
  const fake = c({ id: 2, at: T0 + 60e3, body: `## ⚖️ William 裁示（2026-09-02）：答覆\n這裡沒有原話（對話中，Claude 轉述）那一段，只是拿問題當上下文：${urlOf(1)}` });
  assert.ok(String(fake.body).includes('原話（對話中，Claude 轉述）'),
    '對照斷言：這則留言真的含有那串欄名，所以舊的 includes 判準真的會中——這題才有意義');
  assert.equal(shapeOf(fake), 'near', '欄名出現在否定句裡＝沒有那一段，要進「形狀不合」讓人看見');
  const r = classify([a, fake], T0 + 4 * 86400e3);
  assert.equal(r.pending.length, 1, '真的還沒回的問題不可以被它關掉');
  assert.equal(r.closed.length, 0);
});

test('⭐ 裁示的原話那一段要有逐字引文：欄名在行首、卻沒有粗體引號裡的話，不算', () => {
  const a = ask({ id: 1 });
  const noQuote = c({ id: 2, at: T0 + 60e3, body: `## ⚖️ William 裁示（2026-09-02）：答覆\n原話（對話中，Claude 轉述）：他同意了。\n關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(noQuote), 'near', '沒有 **「逐字」** 那一段＝規則要的形狀沒寫到');
  const empty = c({ id: 3, at: T0 + 60e3, body: `## ⚖️ William 裁示（2026-09-02）：答覆\n原話（對話中，Claude 轉述）：**「」**\n關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(empty), 'near', '引號裡空的也不算');
  const indented = c({ id: 4, at: T0 + 60e3, body: `## ⚖️ William 裁示（2026-09-02）：答覆\n附註裡提到原話（對話中，Claude 轉述）：**「好」**\n關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(indented), 'near', '欄名不在行首＝那是散文在講這條規則，不是留痕的那一段');
  for (const bad of [noQuote, empty, indented]) {
    assert.equal(classify([a, bad], T0 + 4 * 86400e3).pending.length, 1, '形狀沒寫到的留言不可以關掉問題（不是只有 shapeOf 要對）');
  }
  // 對照組：規則正本要的形狀（真語料就是這樣寫的）照樣認得，不然這一收就把工具收死了
  assert.equal(shapeOf(ruling({ id: 5, cites: urlOf(1) })), 'ruling', '對照組：合規的裁示留言仍算數');
  assert.equal(classify([a, ruling({ id: 6, at: T0 + 60e3, cites: urlOf(1) })], T0 + 4 * 86400e3).closed.length, 1, '對照組：合規的關得掉');
});

test('⭐ 原話裡可以再有引號（真語料形狀）：巢狀「」不可以把真的裁示判成形狀不合', () => {
  // 這一題是實跑真語料抓到的回歸：#578 那則 ⚖️ 的原話是「…回 **「1. a. 做／2.「先做」含不含合併：含…」**」，
  // 中間巢狀的 `」` 會讓「引號裡不准有引號」的寫法整條配不到，已經回過的兩題就又冒回「還沒回」。
  const a = ask({ id: 1, pr: 577 });
  const nested = c({
    id: 2, pr: 578, at: T0 + 7200e3,
    body: '## ⚖️ William 裁示（2026-09-02）：逾時預設的兩個解讀\n'
      + '原話（對話中，Claude 轉述）：他先問「判準跟架構是什麼？」，聽完解釋後回 **「1. a. 做／2.「先做」含不含合併：含／3. 判準與架構適用」**。\n'
      + `Claude 的附註：關的是 ${urlOf(1, 577)}`,
  });
  assert.equal(shapeOf(nested), 'ruling', '原話裡引到別人的話是常態，不可以因此判成形狀不合');
  const r = classify([a, nested], T0 + 4 * 86400e3);
  assert.deepEqual(r.pending, [], '真的已經回過的題目不可以又冒回「還沒回」');
  assert.equal(r.closed.length, 1);
});

test('⭐ 逾時暫定要寫正本那一整句：只寫「William 未裁」半句不算', () => {
  const a = ask({ id: 1 });
  const half = c({ id: 2, at: T0 + 5 * 86400e3, body: `## ⏳ 逾時暫定（2026-09-06）：同一句問題\nWilliam 未裁\n❓ 留言：${urlOf(1)}` });
  assert.equal(shapeOf(half), 'near', '正本寫的是「William 未裁、隨時可翻案」——半句代表那則沒照形狀寫');
  // 藏起來的那一句同樣不算（跟裁示的原話同一條規矩，#579 r4 High①）
  const hidden = c({ id: 5, at: T0 + 5 * 86400e3,
    body: `## ⏳ 逾時暫定（2026-09-06）：同一句問題\n\n<!-- William 未裁、隨時可翻案 -->\n❓ 留言：${urlOf(1)}` });
  assert.equal(shapeOf(hidden), 'near', 'HTML 註解裡的那一句畫面上看不到，不算留痕');
  const fencedT = c({ id: 6, at: T0 + 5 * 86400e3,
    body: `## ⏳ 逾時暫定（2026-09-06）：同一句問題\n\n\`\`\`\nWilliam 未裁、隨時可翻案\n\`\`\`\n❓ 留言：${urlOf(1)}` });
  assert.equal(shapeOf(fencedT), 'near', '圍欄裡的那一句是程式碼範例（看得見，但不是正文），不算留痕');
  for (const bad of [half, hidden, fencedT]) {
    assert.equal(classify([a, bad], T0 + 6 * 86400e3).pending.length, 1, '沒照形狀寫的 ⏳ 不可以把問題移出「還沒回」');
  }
  assert.equal(shapeOf(timeout({ id: 3, cites: urlOf(1) })), 'timeout', '對照組：整句寫齊的仍算數');
  assert.equal(classify([a, timeout({ id: 4, at: T0 + 5 * 86400e3, cites: urlOf(1) })], T0 + 6 * 86400e3).provisional.length, 1,
    '對照組：整句寫齊的會進「逾時暫定」那一段（不是「已結」）');
});

test('⭐ 標頭形狀要完整：`## ⚖️ William 裁示oops` 這種規則上無效的留言不可以關掉問題，而且要進「形狀不合」（#579 r1 High①）', () => {
  const a = ask({ id: 1 });
  const fake = c({ id: 2, at: T0 + 60e3, body: `## ⚖️ William 裁示oops\n${urlOf(1)}` });
  const r = classify([a, fake], T0 + 4 * 86400e3);
  assert.equal(r.pending.length, 1, '缺「（日期）：標題」的裁示留言不是有效裁示');
  assert.equal(r.near.length, 1);
  assert.match(r.near[0].why, /完整寫法/);
});

test('⭐ 整則出現 🤖 的留痕留言一律不算數（規則明定不可以有；複審那道閘會把它當壞標頭）', () => {
  const a = ask({ id: 1 });
  const botRuling = c({ id: 2, at: T0 + 60e3, body: `## ⚖️ William 裁示（2026-09-02）：答覆\n引 🤖 Codex 的發現\n${urlOf(1)}` });
  const r = classify([a, botRuling], T0 + 4 * 86400e3);
  assert.equal(r.pending.length, 1, '含 🤖 的裁示留言不可以關掉問題');
  assert.equal(r.near.length, 1);
  assert.match(r.near[0].why, /🤖/);
  const botAsk = c({ id: 3, body: '## ❓ 待裁（2026-09-01）：內文有 🤖 Codex 的問題' });
  assert.deepEqual(classify([botAsk], T0).pending, [], '含 🤖 的問題本身也不算一則有效的待裁');
});

test('⭐ 只認第一行：被引用的標頭、內文第三行的標頭、複審留言裡的三種記號，都不算一則', () => {
  const quoted = c({ id: 1, body: '> ## ❓ 待裁（2026-09-01）：被引用的\n略' });
  const buried = c({ id: 2, body: '前言\n\n## ❓ 待裁（2026-09-01）：埋在第三行的' });
  const review = c({ id: 3, body: '🤖 Codex｜來源：codex CLI｜審 `abc1234`｜r1｜結論：通過\n內文討論 ❓ 待裁／⚖️ William 裁示／⏳ 逾時暫定 這三種留言' });
  for (const x of [quoted, buried, review]) assert.notEqual(shapeOf(x), 'ask', `不該被當成一則問題：${firstLine(x.body)}`);
  assert.deepEqual(classify([quoted, buried, review], T0).pending, []);
});

test('⭐ ⚖️ 的看不見字元：帶 U+FE0F（現實中全部都是這種）與不帶的，兩種都要認得', () => {
  const withVS = '## ⚖️ William 裁示（2026-09-02）：答覆';
  const without = '## ⚖ William 裁示（2026-09-02）：答覆';
  assert.notDeepEqual([...withVS].map((ch) => ch.codePointAt(0)), [...without].map((ch) => ch.codePointAt(0)),
    '對照斷言：兩個標頭的字元序列真的不同（差一個看不見的 U+FE0F），這題才有意義');
  for (const head of [withVS, without]) assert.equal(shapeOf({ body: `${head}\n原話（對話中，Claude 轉述）：**「好」**` }), 'ruling', head);
});

test('⭐ 標頭要**逐字**的形狀：空白少一個、日期不是真的日子，都不算有效裁示（#579 r2 High①）', () => {
  const a = ask({ id: 1 });
  const bad = [
    ['## ⚖William 裁示（2026-09-02）：答覆', '記號與名稱之間少一個空白'],
    ['## ⚖️  William 裁示（2026-09-02）：答覆', '多一個空白'],
    ['## ⚖️ William 裁示（2026-99-99）：答覆', '日期不是真的日子'],
    ['## ⚖️ William 裁示（2026-09-02）：', '標題是空的'],
  ];
  for (const [head, why] of bad) {
    const fake = c({ id: 2, at: T0 + 60e3, body: `${head}\n原話（對話中，Claude 轉述）：**「好」**\n${urlOf(1)}` });
    const r = classify([a, fake], T0 + 4 * 86400e3);
    assert.equal(r.pending.length, 1, `${why}：不可以關掉問題`);
    assert.equal(r.near.length, 1, `${why}：要列進「形狀不合」讓人看見`);
  }
  const ok = c({ id: 3, at: T0 + 60e3, body: `## ⚖️ William 裁示（2026-09-02）：答覆\n原話（對話中，Claude 轉述）：**「好」**\n${urlOf(1)}` });
  assert.equal(classify([a, ok], T0 + 4 * 86400e3).closed.length, 1, '對照組：逐字合規的才關得掉');
});

test('⭐ 內文也要有規則要求的那一欄：裁示沒有他的原話那一段、逾時暫定沒寫「William 未裁」，都不算數', () => {
  const a = ask({ id: 1 });
  const noQuote = c({ id: 2, at: T0 + 60e3, body: `## ⚖️ William 裁示（2026-09-02）：答覆\n只是上下文\n${urlOf(1)}` });
  assert.equal(classify([a, noQuote], T0 + 4 * 86400e3).pending.length, 1, '沒有原話那一段＝不是一則有效的裁示');
  const noPhrase = c({ id: 3, at: T0 + 4 * 86400e3, body: `## ⏳ 逾時暫定（2026-09-04）：同一句問題\n${urlOf(1)}` });
  const r = classify([a, noPhrase], T0 + 5 * 86400e3);
  assert.equal(r.pending.length, 1, '沒寫「William 未裁」＝不是一則有效的逾時暫定');
  assert.equal(r.provisional.length, 0);
});

// ── 第三種結局：撤回（William 2026-09-08 裁，原話逐字「補「這題不用問了」這種收法」）─────────
// ⚠️ 這一族的每一題都在守同一件事：**撤回是唯一由 Claude 單方面發動的結局**，所以它的形狀要卡得比
//    另外兩種緊，而且撤掉的題目一定要印出來給 William 看。機器判不出「我撤得對不對」——
//    安全網做在**輸出**上，不做在判斷裡（這支工具已經學過的一課）。
const withdraw = (/** @type {any} */ o) => c({
  body: `## 🚫 撤回（2026-09-02）：${o.q ?? '要不要做這件事？'}\n\n撤回理由：${o.why ?? '題目依附的東西沒了'}（${o.detail ?? '那支 PR 關了'}）\n\n`
    + `Claude 撤回、William 未回；他隨時可以要我重問\n\n${o.cites ?? ''}`,
  ...o,
});

test('⭐ 撤回：合規的一則把題目移到「我撤回的」那一堆，不是「還沒回」也不是「已結」', () => {
  const a = ask({ id: 1 });
  const r = classify([a, withdraw({ id: 2, at: T0 + 60e3, cites: urlOf(1) })], T0 + 4 * 86400e3);
  assert.equal(r.pending.length, 0);
  assert.equal(r.closed.length, 0, '撤回不是「他回了」——不可以混進已結');
  assert.equal(r.provisional.length, 0, '撤回也不是逾時暫定');
  assert.equal(r.withdrawn.length, 1);
  assert.equal(r.withdrawn[0].closedBy[0].kind, 'withdraw');
  assert.equal(r.withdrawn[0].closedBy[0].reason, '題目依附的東西沒了（那支 PR 關了）',
    '理由要帶出**整行**（類別＋括號裡的具體依據）——括號那半才是他用來推翻這次撤回的材料（#582 r1 Medium①）');
});

test('⭐ 撤回一定要印出來，而且要印理由：這是唯一由我單方面發動的結局，安全網在輸出上', () => {
  const a = ask({ id: 1, q: '要不要做這件事？' });
  const r = classify([a, withdraw({ id: 2, at: T0 + 60e3, cites: urlOf(1) })], T0 + 3600e3);
  const out = render(r, { host: 'github.com', slug: 'o/r', expected: 2 });
  assert.match(out, /我撤回的、他沒回過：1 則/);
  assert.match(out, /要不要做這件事？[\s\S]*我撤回：「要不要做這件事？」（理由：題目依附的東西沒了（那支 PR 關了））/,
    '題目、理由要印在一起，而且理由要含括號裡的具體依據——他要能一眼看出我撤了什麼、憑什麼撤');
  // ⚠️ 這一刀是 #582 r1 Medium① 的保存題：只印類別的話，下面這種「類別對、括號裡自己招了」的撤回會被印得無懈可擊
  const sneaky = c({ id: 3, at: T0 + 60e3,
    body: `## 🚫 撤回（2026-09-02）：要不要做這件事？\n\n撤回理由：題目依附的東西沒了（但其實那支 PR 還開著，只是我覺得不重要了）\n\n`
      + `Claude 撤回、William 未回；他隨時可以要我重問\n\n${urlOf(1)}` });
  const out2 = render(classify([a, sneaky], T0 + 3600e3), { host: 'github.com', slug: 'o/r', expected: 2 });
  assert.match(out2, /但其實那支 PR 還開著，只是我覺得不重要了/, '括號裡那半不可以被丟掉——那是唯一能戳破這次撤回的字');
  // 一則都沒有的時候也要出聲「沒有」：整段消失跟「沒有撤回過」看起來一樣
  const none = render(classify([a], T0 + 3600e3), { host: 'github.com', slug: 'o/r', expected: 1 });
  assert.match(none, /我撤回的、他沒回過：沒有/);
});

test('⭐ 撤回的形狀卡得比另外兩種緊：三種理由以外的、少了自報那一句的，都不算數', () => {
  const a = ask({ id: 1 });
  const bad = [
    ['撤回理由：我自己決定不問了（等太久）', '「我自己決定了」正是這種收法最危險的用法'],
    ['撤回理由：不重要了', '沒有挑三種客觀理由裡的任何一種'],
    ['撤回理由：題目依附的東西沒了但其實還在', '前綴對、但不是三種之一（要行首整串相符）'],
  ];
  for (const [reason, why] of bad) {
    const w = c({ id: 2, at: T0 + 60e3,
      body: `## 🚫 撤回（2026-09-02）：要不要做這件事？\n\n${reason}\n\nClaude 撤回、William 未回；他隨時可以要我重問\n\n${urlOf(1)}` });
    const r = classify([a, w], T0 + 4 * 86400e3);
    assert.equal(r.pending.length, 1, `${why}：不可以關掉問題`);
    assert.equal(r.near.length, 1, `${why}：要列進「形狀不合」讓人看見`);
  }
  // 少了「這不是他回的」那一句：不算數（不准把撤回寫得像他回過了）
  const noPhrase = c({ id: 3, at: T0 + 60e3,
    body: `## 🚫 撤回（2026-09-02）：要不要做這件事？\n\n撤回理由：題目依附的東西沒了（那支 PR 關了）\n\n${urlOf(1)}` });
  assert.equal(classify([a, noPhrase], T0 + 4 * 86400e3).pending.length, 1, '沒自報「Claude 撤回、William 未回」＝不算數');
  // 日期不是真的日子、記號與名稱之間多一個空白：跟另外兩種同一套嚴格度
  for (const head of ['## 🚫 撤回（2026-99-99）：要不要做這件事？', '## 🚫  撤回（2026-09-02）：要不要做這件事？']) {
    const w = c({ id: 4, at: T0 + 60e3,
      body: `${head}\n\n撤回理由：題目依附的東西沒了（那支 PR 關了）\n\nClaude 撤回、William 未回；他隨時可以要我重問\n\n${urlOf(1)}` });
    assert.equal(classify([a, w], T0 + 4 * 86400e3).pending.length, 1, `標頭不合規（${head.slice(0, 14)}…）不可以關掉問題`);
  }
});

test('⭐ 他的話比我的撤回大：我撤回過的題目，他後來貼一則 ⚖️ 就是已結', () => {
  // 這一題釘的是**權力順序**：Claude 的動作不可以擋住 William 的話。他要回一題我撤掉的，
  // 只要照常貼 ⚖️，不必先叫我撤銷撤回。
  const a = ask({ id: 1 });
  const w = withdraw({ id: 2, at: T0 + 60e3, cites: urlOf(1) });
  const later = ruling({ id: 3, at: T0 + 120e3, cites: urlOf(1) });
  const r = classify([a, w, later], T0 + 4 * 86400e3);
  assert.equal(r.closed.length, 1, '他回了就是已結');
  assert.equal(r.withdrawn.length, 0, '不可以同時掛在兩堆');
  // 反方向：先裁示、我後來又撤回（不該發生，但真的發生時仍以他的話為準）
  const r2 = classify([a, ruling({ id: 4, at: T0 + 60e3, cites: urlOf(1) }), withdraw({ id: 5, at: T0 + 120e3, cites: urlOf(1) })], T0 + 4 * 86400e3);
  assert.equal(r2.closed.length, 1); assert.equal(r2.withdrawn.length, 0);
});

test('⭐ 撤回也要照「引用寫在最外層」那條判準：藏在引言或圍欄裡的網址關不掉問題', () => {
  const a = ask({ id: 1 });
  const quoted = c({ id: 2, at: T0 + 60e3,
    body: `## 🚫 撤回（2026-09-02）：要不要做這件事？\n\n撤回理由：題目依附的東西沒了（那支 PR 關了）\n\n`
      + `Claude 撤回、William 未回；他隨時可以要我重問\n\n> 關的是 ${urlOf(1)}` });
  assert.ok(String(quoted.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡');
  assert.equal(classify([a, quoted], T0 + 4 * 86400e3).pending.length, 1, '引言裡的引用不在頂層＝認不得（跟 ⚖️／⏳ 同一把尺）');
});

test('⭐ 撤回的規則綁回正本：AGENTS 那一顆寫的三種理由與兩句固定字樣，工具要逐字認得', () => {
  // 沒有這一題的話，正本改了用詞、工具照舊認舊字樣，全卷還是綠的（同模板題與時限題的病型）。
  // ⚠️ 三種理由、欄名、自報句**一律從正本抽**，不可以寫死在考題裡（#582 r1 Medium②）：
  //    寫死的話 `section.includes(舊字串)` 只證明「舊字串還在那一節出現過」，證明不了它仍是正本列的那一組——
  //    正本把理由改成別的詞、或把欄名換掉，工具照舊認舊字樣，這一題還是綠的。
  const section = reviewSectionOf(readDoc('AGENTS.md'));
  const one = (/** @type {RegExp} */ re, /** @type {string} */ what) => {
    const hits = [...section.matchAll(re)];
    assert.equal(hits.length, 1, `那一節裡「${what}」命中 ${hits.length} 處（要剛好 1 處）——正本改寫法了，工具與這題要一起改`);
    return hits[0];
  };
  // ⚠️ **抽取的錨點是「🚫 那一行模板」，不是欄名本身**（#582 r2 Medium①）：上一版拿 `內文＝\`撤回理由：\`` 當
  //    搜尋條件，等於把「要抽的值」寫進了搜尋條件裡——正本把欄名改掉、同一節留一句「沿革：舊版寫…（已停用）」，
  //    抽取器就去抽那份停用範例，工具照舊認舊字樣，全卷仍綠。改成：先定位**唯一**的模板，只在**它到句號為止**
  //    那一段裡抽；停用範例不含模板 ⇒ 抽不到它；若它連模板也抄一份 ⇒ 模板的「剛好一處」先紅。
  // ⚠️ **抽取一律看「位置」，不看散文**（#582 r1／r2／r3 連三輪都被同一招打穿：只要在散文裡放一份
  //    「舊寫法…已停用」的範例，任何「找某個字樣」的抽法都會抽到那份停用範例，而全卷仍綠）。
  //    這一版的封閉論證：**那一句裡的反引號段落數是固定的 6 段**，順序也是固定的——
  //      ① 第一行模板 ② 欄名 ③④⑤ 三種理由 ⑥ 自報句。
  //    任何塞進那一句的範例（停用的、沿革的、舉例的）只要帶反引號就會讓段數變成 7 ⇒ **先紅**；
  //    不帶反引號的範例則進不了抽取（抽取只讀反引號段），對這一題是惰性的。
  //    ⇒ 這一族到此封頂：要再開，得給一條**保持剛好 6 段、順序不變、卻仍能誤導**的路，不是再舉一種藏法。
  const headHit = one(/`(## 🚫 撤回（YYYY-MM-DD）：)[^`]*`/gu, '🚫 的第一行模板');
  const from = /** @type {number} */ (headHit.index);
  const stop = section.indexOf('。', from);
  assert.ok(stop > from, '找不到那一句的句號——正本改寫法了，這題要跟著改');
  const rule = section.slice(from, stop + 1);
  const runs = [...rule.matchAll(/`([^`]+)`/gu)].map((m) => m[1]);
  assert.equal(runs.length, 6,
    `撤回那一句裡的反引號段落有 ${runs.length} 段（規定剛好 6：模板／欄名／三種理由／自報句）——`
    + '正本改寫法了（或多塞了一段範例），工具與這題要一起看：不要在這一句裡放帶反引號的舉例或沿革。');
  const [tplRun, field, ...rest] = runs;
  const reasons = rest.slice(0, 3);
  const phrase = rest[3];
  assert.match(tplRun, /^## 🚫 撤回（YYYY-MM-DD）：/u, '第 1 段要是第一行模板');
  const head = tplRun.replace(/〈[^〉]*〉$/u, '');
  const mk = (/** @type {string} */ reason, /** @type {string} */ f = field, /** @type {string} */ ph = phrase) => c({ id: 9,
    body: `${head.replace('YYYY-MM-DD', '2026-09-02')}標題\n\n${f}${reason}（原因）\n\n${ph}\n\n${urlOf(1)}` });
  for (const reason of reasons) {
    assert.equal(shapeOf(mk(reason)), 'withdraw', `工具不認正本列的理由：${reason}`);
  }
  // 對照組：正本那幾個字各改一處，工具就不認——證明綁的是正本，不是任何長得像的東西
  assert.equal(shapeOf(mk(`${reasons[0]}了`)), 'near', '理由多一個字就不認');
  assert.equal(shapeOf(mk(reasons[0], '撤回依據：')), 'near', '欄名換掉就不認');
  assert.equal(shapeOf(mk(reasons[0], field, `${phrase}吧`)), 'near', '自報那一句改掉就不認');
  // 權力順序那一句也要在正本裡（工具的分堆照它做）
  assert.ok(section.includes('他的話比我的撤回大'), '正本那一節裡找不到「他的話比我的撤回大」');
});

test('⭐ 時限邊界：71 小時 59 分未逾時、72 小時整逾時（現在時刻由參數注入，不看牆上時鐘）', () => {
  const at = T0;
  const before = classify([ask({ id: 1, at })], at + (71 * 60 + 59) * 60e3);
  const after = classify([ask({ id: 1, at })], at + 72 * 3600e3);
  assert.equal(before.pending[0].overdue, false);
  assert.equal(after.pending[0].overdue, true);
  assert.equal(TIMEOUT_HOURS, 72);
});

// ── 綁回正本（下面幾題共用）─────────────────────────────────────────────────────
// 「審查回饋處置」那一節：模板住在 2 格縮排的清單續行裡，工具的 visible()（只認頂層）會把那一行整個丟掉，
// 所以抽模板不能拿它來用；但也**不再自己寫一份「剝引言／剝圍欄／剝……」**——那是跑步機（#578 r1〜r7、
// #579 r22〜r27 各踩過：每一輪都有下一種 CommonMark 藏法）。改成兩件事把門關上：
//  ① 兩個錨點都要是**行首粗體**、剝掉註解後**全檔各剛好一處**（#579 r27 Medium：在正本前放一段引言，裡面帶
//     同名錨點、舊模板與假的「界線表」，用 indexOf 切段就切到假的那段）。
//  ② 那一節必須是**平文字**：引言、圍欄、原始 HTML、四格縮排、參考定義／註腳、刪除線、圖片、連結標題、
//     HTML 實體——任何一種出現，本題直接紅、請人來看，**不試著剝它**（2026-09-07 量過：這幾種在那一節都是 0）。
//     支援的寫法＝頂層粗體行、`- ` 清單、2 格續行、普通 `[文字](網址)` 連結，以及**內容本身沒踩到上面那幾種的**行內程式碼。
//     ⚠️ 它掃的是**原文**、不解析行內程式碼（#579 r29 Low②）：反引號裡寫 `<tag>`、`~~x~~`、`&amp;` 照樣報紅——
//     「改用反引號包起來」不是通用解法。
//     ⚠️ `<https://…>` 自動連結與四格續行在 GitHub 上是普通排版，這裡仍會紅（#579 r28 Low）——那是
//     「不熟的排版請人看」的維護代價，不是正本漂移：要放行就來改 NOT_PLAIN，不是改正本。
// ⚠️ 誠實劃界：這是漂移絆線（防「改了正本忘了改工具」），不是安全閘。有 commit 權的人蓄意在同一節裡放一份
//    長得一樣的假模板、又用上面沒列到的藏法，本題擋不住——那歸審查制度，不歸考題。
// ⚠️ 註解要剝：畫面上看不到的不算正本；**沒關門的 `<!--` 一路吃到結尾**（GitHub 就是那樣渲染；#579 r6 Medium③）。
//    剝的時候用空字串接起來、不是換行：`foo<!--x-->**錨點` 在畫面上是同一行的中段，不可以被剝成行首。
const readDoc = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (/** @type {string} */ text) =>
  text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/, '');
/** @type {[RegExp, string][]} */
const NOT_PLAIN = [
  [/^ {0,3}>/m, '引言（>）'],
  [/^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:`{3,}|~{3,})/m, '圍欄（``` 或 ~~~）'],
  [/^(?: {4,}|[ \t]*\t)[ \t]*\S/m, '四格以上縮排（或 tab）'],
  [/^ {0,3}\[[^\]]*\]:/m, '參考定義或註腳（[x]: …）'],
  [/<[A-Za-z/!?]/, '原始 HTML（<標籤>）'],
  [/~~/, '刪除線（~~）'],
  [/!\[/, '圖片（![…]）'],
  [/\]\([^)]*[ \t]["'(]/, '連結標題（](網址 "…")）'],
  [/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i, 'HTML 實體（&#…;）'],
];

/** AGENTS「審查回饋處置」那一節（到「界線表」為止）：錨點唯一、內容是平文字，否則丟 AssertionError。 */
function reviewSectionOf(/** @type {string} */ agentsText) {
  const text = stripComments(agentsText);
  const anchor = (/** @type {RegExp} */ re, /** @type {string} */ name) => {
    const hits = [...text.matchAll(re)];
    assert.equal(hits.length, 1, `錨點「${name}」要是行首粗體、剝掉註解後全檔剛好一處（現在 ${hits.length} 處）——正本搬家了、或別處多了一份長得一樣的，先來看本題`);
    return /** @type {number} */ (hits[0].index);
  };
  const from = anchor(/^\*\*審查回饋處置（/gmu, '**審查回饋處置（');
  const to = anchor(/^\*\*界線表（/gmu, '**界線表（');
  assert.ok(to > from, '「界線表」要在「審查回饋處置」之後（同一節的下一顆）');
  const section = text.slice(from, to);
  for (const [re, what] of NOT_PLAIN) {
    assert.doesNotMatch(section, re, `「審查回饋處置」那一節出現了${what}——本題只認平文字（頂層粗體行／- 清單／2 格續行／普通 [文字](網址) 連結／內容沒踩到這幾種的行內程式碼——它掃原文、不解析反引號），不剝它。若只是普通排版改寫（例：<https://…> 自動連結、四格續行），改成上述寫法或來改 NOT_PLAIN；若不是，先請人看那是不是一份會被當成正本的複本`);
  }
  return section;
}

/** 三種留痕留言的第一行模板（含 YYYY-MM-DD 佔位）：從正本那一節抽、各剛好一處，而且工具要認得。 */
function bindTemplates(/** @type {string} */ agentsText) {
  const section = reviewSectionOf(agentsText);
  const tpl = (/** @type {string} */ mark) => {
    const hits = [...section.matchAll(new RegExp('`(## ' + mark + '[^`]*（YYYY-MM-DD）：)[^`]*`', 'gu'))];
    assert.equal(hits.length, 1, `那一節裡 ${mark} 的第一行模板命中 ${hits.length} 處（要剛好 1 處）——正本改寫法了，這題與工具要一起改`);
    return hits[0][1];
  };
  const out = { ask: tpl('❓'), ruling: tpl('⚖️'), timeout: tpl('⏳') };
  const mk = (/** @type {string} */ first, /** @type {string} */ rest) => c({ id: 9, body: `${first.replace('YYYY-MM-DD', '2026-09-02')}標題\n\n${rest}` });
  assert.equal(shapeOf(mk(out.ask, '選項…')), 'ask', `工具不認正本的 ❓ 模板：${out.ask}`);
  assert.equal(shapeOf(mk(out.ruling, '原話（對話中，Claude 轉述）：**「好」**')), 'ruling', `工具不認正本的 ⚖️ 模板：${out.ruling}`);
  assert.equal(shapeOf(mk(out.timeout, 'William 未裁、隨時可翻案')), 'timeout', `工具不認正本的 ⏳ 模板：${out.timeout}`);
  return out;
}

/**
 * 「引用網址要寫在留言最外層才算數」那一句。**正本住在 AGENTS「留痕」那一顆**（2026-09-08 從合併手冊搬過來：
 * 它講的是 ⚖️／⏳ 留言的形狀，那是 AGENTS 的地盤，寫 ⚖️ 的人不會去翻合併手冊）。
 * 「只有一份」不是靠這一題守的（它只量 AGENTS 那一節之內）：**合併手冊與 CLAUDE.md 的零次釘**在
 * `test/collab-invariant-docs.test.js` 的 PINS 句庫裡。⚠️ 那兩顆守的也只是**那兩支檔案裡的字面尾巴**——
 * 正本檔那一節**外面**再長一份、或別的檔案裡的複本與改寫，兩邊都數不到，那一半歸複審（Grok #580 掃後 2）。
 * 量尺跟這一節的模板題、時限題共用 reviewSectionOf()：剝註解、錨點唯一、那一節平文字。
 * 落點要在**同一句**裡（第一個「。」之前），不是同一行——那一顆是一整段長文，同一行幾乎沒有約束力。
 */
function bindCitationRule(/** @type {string} */ agentsText) {
  const section = reviewSectionOf(agentsText);
  const ANCHOR = /\*\*引用 ❓ 網址必須寫在留言最外層才算數\*\*/gu;
  const hits = [...section.matchAll(ANCHOR)];
  assert.equal(hits.length, 1, `「審查回饋處置」那一節裡，正本那一句命中 ${hits.length} 處（要剛好 1 處）——規則搬家或被複製了，工具與這題要一起看`);
  assert.match(section, /\*\*引用 ❓ 網址必須寫在留言最外層才算數\*\*[^。]*issuecomment-5570875993/u,
    '那一句要在同一句裡附 William 裁示的落點網址（放到下一句去就等於沒有落點）');
  return section.slice(/** @type {number} */ (hits[0].index));
}

test('⭐ 三種第一行的形狀綁回規則正本：從 AGENTS 那一節抽出模板、填真日期，工具要認得；改模板一個字就不認', () => {
  // 三條正則與考題夾具原本都是寫死的；正本改了第一行用詞，工具與考題可以一起留在舊形狀上全綠（Grok #579 掃後 3②）。
  const t = bindTemplates(readDoc('AGENTS.md'));
  // 對照：模板改一個字（名稱多一個字），工具就不認——證明綁的是正本那一句，不是任何長得像的東西
  const fake = c({ id: 9, body: `${t.ruling.replace('YYYY-MM-DD', '2026-09-02').replace('裁示', '裁示了')}標題\n\n原話（對話中，Claude 轉述）：**「好」**` });
  assert.equal(shapeOf(fake), 'near');
});

test('⭐ 綁回正本那題自己要有保存題：r26／r27 兩種騙法餵進去都要紅，不是只在真檔上綠（#579 r27 Medium）', () => {
  const base = stripComments(readDoc('AGENTS.md'));
  const t = bindTemplates(base);   // 對照組：真正本要過
  const cell = '`' + t.ruling;     // 正本那一格的開頭：`## ⚖️ William 裁示（YYYY-MM-DD）：
  assert.equal(base.split(cell).length - 1, 1, '對照斷言：⚖️ 模板在真檔裡只出現一次（下面的夾具靠這個定位）');
  const section = reviewSectionOf(base);
  assert.ok(base.includes(section), '對照斷言：那一節是真檔的逐字切片（夾具靠它拼鬼影）');
  // 正本改了用詞（多一個「了」，仍抽得到）、工具沒跟上 → 要紅。這是本題存在的全部理由。
  const rewritten = base.replace(cell, cell.replace('裁示', '裁示了'));
  assert.throws(() => bindTemplates(rewritten), /工具不認正本的 ⚖️ 模板/, '沒有鬼影：正本改了、工具沒改 → 紅');
  // r26：舊模板留在檔頭的 HTML 註解裡（畫面上看不到）
  assert.throws(() => bindTemplates(`<!--\n${section}\n-->\n${rewritten}`), /工具不認正本的 ⚖️ 模板/, 'r26：註解裡的舊模板不算正本');
  // r27：正本前放一段標成「已停用存查」的引言，裡面帶同名錨點、舊模板與假的「界線表」
  const quoted = section.split('\n').map((l) => `> ${l}`).join('\n');
  assert.throws(() => bindTemplates(`> ⚠️ 已停用存查\n${quoted}\n> **界線表（舊）**\n\n${rewritten}`), /工具不認正本的 ⚖️ 模板/,
    'r27：引言裡的錨點不是行首粗體，切段切不到它；抽到的是真正本，而真正本已改');
  // 同一招不加引言（頂層第二份同名錨點）→ 錨點不唯一
  assert.throws(() => bindTemplates(`${section}\n**界線表（舊）**\n\n${rewritten}`), /錨點「\*\*審查回饋處置（」[^\n]*剛好一處/, '頂層第二份同名錨點 → 紅');
  // 舊模板塞進那一節裡的圍欄／引言／原始 HTML／刪除線 → 那一節不再是平文字，不剝、直接紅
  const inject = (/** @type {string} */ ghost) => rewritten.replace('\n**界線表（', `\n${ghost}\n**界線表（`);
  assert.throws(() => bindTemplates(inject('```\n' + cell + '`\n```')), /出現了圍欄/, '節內圍欄 → 紅');
  assert.throws(() => bindTemplates(inject('> ' + cell + '`')), /出現了引言/, '節內引言 → 紅');
  assert.throws(() => bindTemplates(inject('<details>' + cell + '`</details>')), /出現了原始 HTML/, '節內原始 HTML → 紅');
  assert.throws(() => bindTemplates(inject('~~' + cell + '`~~')), /出現了刪除線/, '節內刪除線 → 紅');
  // 整格刪掉 → 命中 0
  const i = base.indexOf(cell);
  const j = base.indexOf('`', i + 1);
  assert.throws(() => bindTemplates(base.slice(0, i) + base.slice(j + 1)), /⚖️ 的第一行模板命中 0 處/, '正本把模板刪掉 → 紅');
});

test('⭐ 「引用寫在最外層」這條判準綁回它的正本（AGENTS「留痕」那一顆），而且要附落點', () => {
  // ⚠️ **射程只有一件事：那一句還在正本裡、而且落點還在同一句**（Grok #580 掃後 1）。
  //    它**不**把那一句話裡的排除清單拿去跑分類——真正釘「引言／縮排／圍欄／註解認不得、頂層那一行算」的，
  //    是下面那幾題行為題（讀的是工具，不讀規則句）。所以規則句與逐字副本一起被改成相反的意思時，這題不會紅；
  //    那一半靠複審的眼睛。照實劃界，不是漏掉（Grok #579 掃後 3①、5）。量尺見 bindCitationRule()。
  bindCitationRule(readDoc('AGENTS.md'));
});

test('⭐ 那一句的綁定也要有保存題：刪掉、包進註解、搬到節外、多一份、落點拿掉，都要紅', () => {
  const real = stripComments(readDoc('AGENTS.md'));
  const line = bindCitationRule(real);   // 對照組：真正本要過
  const SENT = line.slice(0, line.indexOf('。') + 1);
  assert.equal(real.split(SENT).length - 1, 1, '對照斷言：那一句在真檔裡逐字只出現一次（夾具靠它定位）');
  assert.throws(() => bindCitationRule(real.replace(SENT, '')), /命中 0 處/, '整句刪掉 → 紅');
  assert.throws(() => bindCitationRule(real.replace(SENT, `<!-- ${SENT} -->`)), /命中 0 處/, '包進 HTML 註解（畫面上看不到）→ 紅');
  // 搬到那一節**外面**（檔尾）：正本那一顆裡沒有它就是沒有，別處長得一樣不算
  assert.throws(() => bindCitationRule(`${real.replace(SENT, '')}\n\n${SENT}\n`), /命中 0 處/, '搬到節外 → 紅');
  assert.throws(() => bindCitationRule(real.replace(SENT, SENT + SENT)), /命中 2 處/, '兩份 → 紅（哪一份是正本說不清）');
  assert.throws(() => bindCitationRule(real.replace('issuecomment-5570875993', 'issuecomment-0')), /落點/, '落點拿掉 → 紅');
  // 落點被推到下一句去（同一行、但已經不是同一句）也不算
  assert.throws(() => bindCitationRule(real.replace(SENT, SENT.replace(/落點＝\S+ 。/u, '。') + '落點＝https://github.com/teacherjung/personal-finance-webapp/pull/579#issuecomment-5570875993 。')),
    /落點/, '落點推到下一句 → 紅');
});

test('⭐ 多筆配對照時間排，不照 API 回傳順序：最早引到它的那則排第一（Grok #579 掃後 2）', () => {
  const a = ask({ id: 1 });
  const later = ruling({ id: 3, at: T0 + 7200e3, cites: urlOf(1) });
  const earlier = ruling({ id: 2, at: T0 + 3600e3, cites: urlOf(1) });
  const r = classify([a, later, earlier], T0 + 86400e3);   // 故意把較晚的放前面
  assert.deepEqual(r.closed[0].closedBy.map((x) => x.url), [earlier.html_url, later.html_url], '配對順序要照建立時間');
});

test('⭐ 已結的安全網是「印出來給人看」，不是機器判斷：裁示標題跟問題對不上時，題目仍在已結（不是還沒回）', () => {
  // 這一題釘的是**誠實的行為**：配錯不會被機器擋下，只會顯示在「已結」段讓人看見（Grok #579 掃後 2）。
  const a = ask({ id: 1, q: '要不要做這件事？' });
  const generic = c({ id: 2, at: T0 + 60e3, body: `## ⚖️ William 裁示（2026-09-02）：另一件完全無關的事\n\n原話（對話中，Claude 轉述）：**「好」**\n\n${urlOf(1)}` });
  const r = classify([a, generic], T0 + 3600e3);
  assert.equal(r.pending.length, 0); assert.equal(r.closed.length, 1);
  assert.match(render(r, { host: 'github.com', slug: 'o/r', expected: 2 }), /要不要做這件事？[\s\S]*已裁：「另一件完全無關的事」/,
    '對不上的標題要跟問題印在一起，讓人一眼看出配錯');
});

test('⭐ 時限常數綁回規則正本：AGENTS 那顆寫「時限＝三天＝連續 72 小時」，這裡就必須是 72', () => {
  // 沒有這一題的話，William 哪天把三天改成五天，AGENTS 改了、工具照舊按 72 小時印「已經超過時限」，全卷還是綠的。
  // ⚠️ 這一題自己被騙過兩次：原本在**整份 AGENTS** 取第一個命中，在前面加一行 HTML 註解寫「時限＝**三天**」
  //   就騙得過（#579 r4 Medium③）；改成只剝成對的 `<!--…-->` 之後，插一個**沒關門**的 `<!--` 又騙得過
  //   （#579 r6 Medium③）。現在跟模板那題共用 reviewSectionOf()：剝註解（含沒關門的）、錨點唯一、那一節平文字、
  //   而且正本自己寫的「N 天」與「連續 M 小時」要先對得上。
  const section = reviewSectionOf(readDoc('AGENTS.md'));
  const hits = [...section.matchAll(/時限＝\*\*(.)天\*\*＝連續 (\d+) 小時/gu)];
  assert.equal(hits.length, 1, `那一節裡「時限＝**N天**＝連續 M 小時」命中 ${hits.length} 處（要剛好 1 處）`);
  const [, cn, hours] = hits[0];
  const days = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 }[cn];
  assert.ok(days, `讀不出天數：${cn}`);
  assert.equal(Number(hours), days * 24, `正本自己就對不上：寫 ${cn} 天，卻又寫連續 ${hours} 小時`);
  assert.equal(TIMEOUT_HOURS, days * 24, `規則正本寫 ${cn} 天、工具卻用 ${TIMEOUT_HOURS} 小時`);
});

test('⭐ 藏起來的東西不算數：原話或網址放在圍欄／HTML 註解裡，關不掉問題（#579 r4 High①）', () => {
  const a = ask({ id: 1 });
  const fenced = c({ id: 2, at: T0 + 60e3, body: '## ⚖️ William 裁示（2026-09-02）：答覆\n\n```\n原話（對話中，Claude 轉述）：**「假的」**\n```\n'
    + `關的是 ${urlOf(1)}` });
  assert.ok(String(fenced.body).includes('原話（對話中，Claude 轉述）'), '對照斷言：原話那串字真的在原文裡，只是藏在圍欄裡');
  assert.equal(shapeOf(fenced), 'near', '圍欄裡的原話是程式碼範例（看得見，但不是正文），不算一段留痕');
  const commented = c({ id: 3, at: T0 + 60e3, body: '## ⚖️ William 裁示（2026-09-02）：答覆\n\n<!-- 原話（對話中，Claude 轉述）：**「假的」** -->\n'
    + `關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(commented), 'near', 'HTML 註解裡的原話畫面上看不到，不算一段留痕');
  // 反過來：原話看得見（但回答的是別題），真正要關的網址藏在 HTML 註解裡
  const hiddenUrl = c({ id: 4, at: T0 + 60e3, body: '## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n'
    + `<!-- ${urlOf(1)} -->` });
  assert.equal(shapeOf(hiddenUrl), 'ruling', '這一則本身是合規的裁示（只是它沒有可見地引到那一題）');
  for (const bad of [fenced, commented, hiddenUrl]) {
    assert.equal(classify([a, bad], T0 + 4 * 86400e3).pending.length, 1, '藏起來的內容不可以關掉問題');
  }
});

test('⭐ 原話要在標頭後的**第一個可見段落**：可見處放一段回答別題的原話，關不掉這一題', () => {
  const a = ask({ id: 1 });
  const late = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n這一段先講背景，關的是 ${urlOf(1)}\n\n原話（對話中，Claude 轉述）：**「好」**` });
  assert.equal(shapeOf(late), 'near', '規則正本寫的是「內文第一段」，原話跑到第二段之後就不是那個形狀');
  assert.equal(classify([a, late], T0 + 4 * 86400e3).pending.length, 1);
  // 對照組：第一段就是原話的照樣算數
  assert.equal(shapeOf(ruling({ id: 3, cites: urlOf(1) })), 'ruling');
});

test('⭐ 原話前面擋著一段不可見內容，仍要認得（剝掉之後它才是第一個可見段落）', () => {
  // 「第一段」講的是**正文**的第一段。上面放一則 HTML 註解（真的不顯示）或一段圍欄（顯示成程式碼、不是正文），
  // 不剝掉就會把一則完全合規的裁示判成形狀不合——那會讓已經回過的問題冒回「還沒回」。
  const a = ask({ id: 1 });
  const afterComment = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n<!-- 給下一個人的備註 -->\n\n原話（對話中，Claude 轉述）：**「好」**\n關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(afterComment), 'ruling', '註解在畫面上不顯示，它後面那一段才是第一段');
  const afterFence = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n\u0060\u0060\u0060\n附上當時的指令\n\u0060\u0060\u0060\n\n原話（對話中，Claude 轉述）：**「好」**\n關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(afterFence), 'ruling', '圍欄裡的內文不是「第一段」，它後面那一段才是');
  for (const good of [afterComment, afterFence]) {
    assert.equal(classify([a, good], T0 + 4 * 86400e3).closed.length, 1, '合規的裁示要關得掉');
  }
});

test('⭐ 圍欄要記長度：四個反引號開門，內文那行 ```js 不是關門（#579 r5 High①）', () => {
  // 只記字元種類的話，內文那行會被誤當關門，後面仍在圍欄裡的待裁網址就被放回可見層，
  // 於是「第一段是回答別題的合法原話＋圍欄裡藏著這一題的網址」就能關掉這一題。
  const a = ask({ id: 1 });
  const F4 = BT.repeat(4); const F3 = BT.repeat(3);
  // ⚠️ 兩個條件要**各自**有鑑別力的夾具：混在一起（短圍欄又帶資訊字串）的話，
  //    把長度記憶拿掉仍然會被「資訊字串」擋住而全綠——那題就證明不了長度（#579 r6 Medium②）。
  // 夾具甲＝只考「較短」：關門行是純三反引號、後面什麼都沒有。
  const shorter = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n\n${F4}\n${F3}\n${urlOf(1)}\n${F4}\n` });
  // 夾具乙＝只考「關門行後面不能有東西」：同樣長度，但帶資訊字串。
  const withInfo = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n\n${F3}\n${F3}js\n${urlOf(1)}\n${F3}\n` });
  for (const [name, cmt] of [['較短的關門行', shorter], ['帶資訊字串的關門行', withInfo]]) {
    assert.equal(shapeOf(cmt), 'ruling', `${name}：這一則本身是合規的裁示（只是它沒有可見地引到這一題）`);
    assert.ok(String(cmt.body).includes(urlOf(1)), `${name}：對照斷言——網址真的在原文裡，只是關在圍欄中`);
    assert.equal(classify([a, cmt], T0 + 4 * 86400e3).pending.length, 1, `${name}：圍欄裡的網址是程式碼範例、不是可點的引用，關不掉問題`);
  }
  // 對照組：真的關門了，後面的網址就看得見、就算引到
  const closed = c({ id: 4, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n${F4}\n範例\n${F4}\n關的是 ${urlOf(1)}` });
  assert.equal(classify([a, closed], T0 + 4 * 86400e3).closed.length, 1, '圍欄關門之後的內容是看得見的');
});

test('⭐ 縮排四格的程式碼區塊不算引用：複審留言貼範例最常用這個寫法（#579 r15 High；判準現在是「只認頂層」，這一族的夾具全部留著釘結果）', () => {
  const a = ask({ id: 1 });
  const indented = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + `我在獨立 fixture 實測：\n\n    ${urlOf(1)}\n\n以上。` });
  assert.ok(String(indented.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是縮排成了程式碼');
  assert.equal(classify([a, indented], T0 + 4 * 86400e3).pending.length, 1,
    '縮排四格＝畫面上是程式碼範例，不是引用，關不掉問題');
  // 區塊中間的**空行不結束區塊**（複審留言貼多段範例時就長這樣）
  const withBlank = c({ id: 5, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + `實測兩刀：\n\n    第一刀\n\n    ${urlOf(1)}\n\n以上。` });
  assert.equal(classify([a, withBlank], T0 + 4 * 86400e3).pending.length, 1,
    '區塊中間的空行不結束區塊，後面那段仍是程式碼');
  // `>` 引言裡的縮排式程式碼（#579 r16 High① 當時是容器解析的洞：要看得穿引言前綴；現在引言行整行不看，留著釘結果）
  const quotedIndent = c({ id: 6, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + `> 引用 Codex 的輸出：\n>\n>     ${urlOf(1)}\n` });
  assert.equal(classify([a, quotedIndent], T0 + 4 * 86400e3).pending.length, 1,
    '引言裡的縮排式程式碼也是程式碼範例，關不掉問題');
  // 清單項底下的續行：GFM 把它當正文，但本支**只認頂層**（William 2026-09-07 裁），所以認不得——
  //    後果是留在「還沒回」（安全方向），不是誤關。這一題釘的是新判準，不是舊的容器解析。
  const listCont = c({ id: 7, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `- 關的是：\n\n    ${urlOf(1)}\n` });
  assert.equal(classify([a, listCont], T0 + 4 * 86400e3).pending.length, 1,
    '清單項底下的續行不在頂層＝引用認不得（安全方向：問題留在「還沒回」，不會誤關）');
  // 清單裡的程式碼區塊結束之後的段落：同樣不在頂層、認不得（安全方向）。舊的容器解析已刪，這裡釘的是新判準。
  const afterListCode = c({ id: 9, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `- 實測輸出：\n\n      command output\n\n    關的是 ${urlOf(1)}\n` });
  assert.equal(classify([a, afterListCode], T0 + 4 * 86400e3).pending.length, 1,
    '清單裡的內容一律不在頂層＝認不得（安全方向）');
  // 巢狀清單裡的圍欄（#579 r19 High 當時要算相對縮排：第二層四格、它的圍欄八格；現在有縮排就整行不看，留著釘結果）
  const F3 = BT.repeat(3);
  const nested = c({ id: 10, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + `- outer\n    - 工具輸出：\n        ${F3}text\n        ${urlOf(1)}\n        ${F3}\n` });
  assert.ok(String(nested.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是關在第二層清單的圍欄中');
  assert.equal(classify([a, nested], T0 + 4 * 86400e3).pending.length, 1,
    '巢狀清單裡的圍欄還是圍欄，裡面的網址關不掉問題');
  // 第二層清單底下的續行（當時的反方向題：門檻要相對於那一層、續行不是程式碼；現在一樣不在頂層＝認不得，留著釘結果）
  const nestedCont = c({ id: 11, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `- outer\n    - 關的是：\n\n        ${urlOf(1)}\n` });
  assert.equal(classify([a, nestedCont], T0 + 4 * 86400e3).pending.length, 1,
    '巢狀清單裡的內容一律不在頂層＝認不得（安全方向）');
  // 清單裡的引言程式碼（#579 r20 High 當時是容器解析的洞：引言是新容器、縮排從它算起；現在有縮排就整行不看，留著釘結果）
  const quoteInList = c({ id: 12, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + `- 先列背景\n\n  >     ${urlOf(1)}\n` });
  assert.ok(String(quoteInList.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是關在清單裡的引言程式碼中');
  assert.equal(classify([a, quoteInList], T0 + 4 * 86400e3).pending.length, 1,
    '清單裡的引言程式碼還是程式碼，關不掉問題');
  // 清單裡的引言一般文字：GitHub 看得見，但不在頂層、認不得（安全方向）
  const quoteText = c({ id: 13, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `- 先列背景\n\n  > 關的是 ${urlOf(1)}\n` });
  assert.equal(classify([a, quoteText], T0 + 4 * 86400e3).pending.length, 1,
    '清單裡的引言更不在頂層＝認不得（安全方向）');
  // 清單標記同一行就開圍欄（`- ```text`）也要認出來
  const inlineFence = c({ id: 14, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + `- ${BT.repeat(3)}text\n  ${urlOf(1)}\n  ${BT.repeat(3)}\n` });
  assert.equal(classify([a, inlineFence], T0 + 4 * 86400e3).pending.length, 1,
    '清單標記同行開的圍欄也是圍欄，裡面的網址關不掉問題');
  // 對照組：清單裡**再縮四格**才是程式碼
  const listCode = c({ id: 8, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + `- 實測輸出：\n\n      ${urlOf(1)}\n` });
  assert.equal(classify([a, listCode], T0 + 4 * 86400e3).pending.length, 1,
    '清單裡再縮四格＝程式碼區塊，關不掉問題');
  // 縮排兩格：GitHub 當正文，但不在頂層、認不得（門檻是零縮排）
  const twoSpace = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n  關的是 ${urlOf(1)}` });
  assert.equal(classify([a, twoSpace], T0 + 4 * 86400e3).pending.length, 1,
    '縮排兩格也不在頂層＝認不得（門檻是「縮排零格」，安全方向）');
  // 對照組：前面沒有空行時，縮排不會開啟程式碼區塊
  const noBlank = c({ id: 4, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n    關的是 ${urlOf(1)}` });
  assert.equal(classify([a, noBlank], T0 + 4 * 86400e3).pending.length, 1,
    '不管前面有沒有空行，縮排四格就不在頂層＝認不得（判準已收成「只認頂層」）');
});

test('⭐ 引用只認頂層：有引言前綴或行首有縮排的一律不算（#579 r21 之後的判準）', () => {
  // 量過真語料才這樣收（量法＝掃全庫第一行合規的 ❓／⚖️／⏳、看含引用網址的那些網址寫在第幾層）：
  //    量的時候含引用網址的每一則都寫在頂層零縮排。筆數會長，這裡記量法與結論，不記數字。
  // 這個方向只會讓引用更難被認得（問題留在「還沒回」），不可能造成誤關。
  const a = ask({ id: 1 });
  assert.equal(classify([a, ruling({ id: 2, at: T0 + 60e3, cites: `關的是 ${urlOf(1)}` })], T0 + 4 * 86400e3).closed.length, 1,
    '頂層零縮排＝算引到');
  assert.equal(classify([a, ruling({ id: 3, at: T0 + 60e3, cites: `- 關的是 ${urlOf(1)}` })], T0 + 4 * 86400e3).closed.length, 1,
    '清單標記那一行本身也在頂層＝算引到');
  // ⚠️ 這裡不能用 ruling() 夾具：它會在網址前面補「關的是 」，縮排就被吃掉了。
  const body = (/** @type {string} */ line) =>
    `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n${line}`;
  for (const [name, line] of [
    ['縮排一格', ` 關的是 ${urlOf(1)}`],
    ['縮排四格', `    關的是 ${urlOf(1)}`],
    ['引言', `> 關的是 ${urlOf(1)}`],
  ]) {
    const cmt = c({ id: 4, at: T0 + 120e3, body: body(/** @type {string} */ (line)) });
    assert.ok(String(cmt.body).includes(urlOf(1)), `${name}：對照斷言——網址真的在原文裡`);
    assert.equal(classify([a, cmt], T0 + 4 * 86400e3).pending.length, 1, `${name}：不在頂層＝認不得`);
  }
});

test('⭐ 參考定義要在「只認頂層」之前剝：縮排一格的標籤＋下一行頂層網址不算引用（#579 r23 High①）', () => {
  const a = ask({ id: 1 });
  const cmt = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + ` [背景]:\n${urlOf(1)}\n` });
  assert.ok(String(cmt.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是它是參考定義的網址那一行');
  assert.equal(classify([a, cmt], T0 + 4 * 86400e3).pending.length, 1,
    '參考定義整段都不顯示，換行放的網址一樣不算引用');
});

test('⭐ 清單標記後面開的圍欄也要認：它的關門不可以被當成新的開門（#579 r23 High②）', () => {
  // `- ~~~text` 沒被認成開門的話，它的關門 `  ~~~` 反而被當成新的開門，
  // 後面**可見**的引用就整段被吃掉 ⇒ 真的已結冒回未回。
  const a = ask({ id: 1 });
  const T = '~'.repeat(3);
  const cmt = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `- ${T}text\n  sample\n  ${T}\n\n關的是 ${urlOf(1)}\n` });
  assert.equal(classify([a, cmt], T0 + 4 * 86400e3).closed.length, 1,
    '圍欄關掉之後，後面頂層的引用照樣算引到');
  // 對照組：圍欄**裡面**的網址仍然不算引用
  const inside = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + `- ${T}text\n${urlOf(1)}\n  ${T}\n` });
  assert.equal(classify([a, inside], T0 + 4 * 86400e3).pending.length, 1, '圍欄裡的網址關不掉問題');
});

test('⭐ 縮排一格的圍欄／註解開門也要算開門（#579 r22 High①）', () => {
  // 「縮排就當看不見」會把縮排一格的**開門行**整行丟掉，於是那道圍欄從來沒開過，
  // 裡面縮排零格的網址反而被當成可見 ⇒ 真的未回被判已結。
  const a = ask({ id: 1 });
  const F = BT.repeat(3);
  const indentedFence = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + ` ${F}\n${urlOf(1)}\n ${F}\n` });
  assert.ok(String(indentedFence.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡');
  assert.equal(classify([a, indentedFence], T0 + 4 * 86400e3).pending.length, 1,
    '縮排一格的圍欄仍是圍欄，裡面的網址關不掉問題');
  const indentedComment = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + ` <!--\n${urlOf(1)}\n-->\n` });
  assert.equal(classify([a, indentedComment], T0 + 4 * 86400e3).pending.length, 1,
    '縮排一格的註解開門仍是開門，裡面的網址關不掉問題');
});

test('⭐ `>` 引言裡的東西一律不在頂層：引 Codex 發現時貼在引言圍欄裡的範例網址不算引用（#579 r13 High）', () => {
  // AGENTS 明文要求引 Codex 的發現要放 `>` 引言或反引號，所以這是**日常寫法**，不是刁鑽角落。
  const a = ask({ id: 1 });
  const F = BT.repeat(3);
  const quoted = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「答的是別題」**\n\n`
      + `> 引用 Codex 發現裡的範例：\n> ${F}md\n> ${urlOf(1)}\n> ${F}\n` });
  assert.ok(String(quoted.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是關在引言裡的圍欄中');
  assert.equal(classify([a, quoted], T0 + 4 * 86400e3).pending.length, 1,
    '引言裡的圍欄在畫面上是程式碼範例，不是引用，關不掉問題');
  // 對照組：同樣寫在引言裡、但**不在圍欄內**的網址——畫面上看得見，但不在頂層＝認不得（只認頂層，William 2026-09-07 裁）
  const plainQuote = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n> 關的是 ${urlOf(1)}` });
  assert.equal(classify([a, plainQuote], T0 + 4 * 86400e3).pending.length, 1,
    '引言裡的引用不在頂層＝認不得（安全方向）。AGENTS 要求用 `>` 引的是「Codex 的發現」，不是引用網址本身');
  // 引言裡開一道圍欄、下一行用頂層的同款記號：本工具的機制**不是**追蹤引言深度（visible() 沒有那個狀態），
  // 而是引言行整行不看、連裡面的圍欄記號一起丟，所以頂層那一行 ``` 是**新開門**，網址落在它後面＝在圍欄裡＝認不得。
  // ⚠️ 這一刀**不是漏認**：Codex 把同一段原文逐字送進 GitHub 的 Markdown API 實測，那個網址在 GitHub 上
  //    也落在一個 `<pre><code>` 裡、根本不是連結（#579 r29 Low①；上一版寫「明知的漏認、我再問他一次」＝
  //    低估了現有行為，r28 之前更寫成「深度保護」＝跟實作不符）。⇒ 這裡是**正確排除程式碼範例**。
  const topFenceAfterQuote = c({ id: 4, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `> ${F}\n> 範例\n${F}\n\n關的是 ${urlOf(1)}` });
  assert.equal(classify([a, topFenceAfterQuote], T0 + 4 * 86400e3).pending.length, 1,
    '頂層那一行 ``` 是新開門，後面的網址在圍欄裡＝認不得（GitHub 也是這樣渲染，這是正確排除、不是漏認）');
  // 對照組：把頂層那一行 ``` 拿掉，引言行照樣整行不看、網址回到頂層＝算引到——證明剛才藏住網址的是那道新開的圍欄，不是引言
  // ⚠️ 兩個夾具的差異**只有頂層那一行 ```**：都用空行結束引言（不然下一行會是引言的懶續行，見下一題）。
  const noTopFence = c({ id: 5, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `> ${F}\n> 範例\n\n關的是 ${urlOf(1)}` });
  assert.equal(classify([a, noTopFence], T0 + 4 * 86400e3).closed.length, 1,
    '沒有頂層的圍欄記號、又用空行結束引言，後面頂層的網址照樣算引到');
});

test('⭐ 引言的**懶續行**也不在頂層：`> 關的是` 下一行零縮排的網址，GitHub 渲染在引言裡（Grok #580 掃後 1）', () => {
  // 這一刀是**誤關**方向，所以貴：AGENTS 要求「引 Codex 的發現一律放 `>` 引用」，而 Codex 的發現裡常常帶著
  // ❓ 的網址。只看行首前綴的話，引言下一行零縮排就被當成頂層 ⇒ 一則還沒回的問題被靜靜關掉。
  // ⚠️ 對照事實（2026-09-08 用 GitHub 的 Markdown API 實測，不是猜的）：那一行渲染在 <blockquote> 裡、
  //    網址仍然是連結——所以規則書寫「放進引言不算」時，工具必須真的不算，否則契約就是假的。
  // 實作是**保守的多剝**（緊接在引言行後、中間沒有空行的非空行一律當看不見），不是實作段落延續。
  const a = ask({ id: 1 });
  const lazy = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `> 關的是\n${urlOf(1)}` });
  assert.ok(String(lazy.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是落在引言的懶續行上');
  assert.equal(classify([a, lazy], T0 + 4 * 86400e3).pending.length, 1,
    '引言的懶續行不在頂層＝認不得（安全方向：問題留在「還沒回」）');
  // 對照組一：中間空一行就真的離開引言了，那一行是頂層＝算引到
  const separated = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `> 引用\n\n關的是 ${urlOf(1)}` });
  assert.equal(classify([a, separated], T0 + 4 * 86400e3).closed.length, 1, '空行結束引言之後的頂層網址照樣算引到');
  // 對照組二：多剝的代價要看得見——引言後面接著寫的**原話**也會被吃掉（那是留痕的必要欄位）
  const quotedThenQuote = c({ id: 4, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n> 先引一段\n原話（對話中，Claude 轉述）：**「好」**\n\n${urlOf(1)}` });
  assert.equal(shapeOf(quotedThenQuote), 'near', '緊貼在引言下面的原話也被當成引言的一部分＝形狀不合（多剝的代價，照實釘住）');
});

test('⭐ 沒關門的 HTML 註解一路吃到結尾：藏在裡面的網址關不掉問題（#579 r6 High①）', () => {
  // GitHub 就是這樣渲染的——`<!--` 之後到文末都不顯示。只認成對的 `<!--…-->` 就是「少剝」，
  // 而少剝正是這支最貴的失敗（真的還沒回被判成已結）。
  const a = ask({ id: 1 });
  const unclosed = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n\n<!--\n${urlOf(1)}\n` });
  assert.equal(shapeOf(unclosed), 'ruling', '這一則本身是合規的裁示（只是它沒有可見地引到這一題）');
  assert.ok(String(unclosed.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是關在沒關門的註解後面');
  assert.equal(classify([a, unclosed], T0 + 4 * 86400e3).pending.length, 1, '沒關門的註解之後都看不見，關不掉問題');
  // 對照組：註解有關門，後面的網址就看得見
  const closedC = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n<!-- 備註 -->\n關的是 ${urlOf(1)}` });
  assert.equal(classify([a, closedC], T0 + 4 * 86400e3).closed.length, 1, '註解關門之後的內容是看得見的');
});

test('⭐ Markdown 的參考定義行從來不會顯示：藏在那裡的網址關不掉問題（#579 r6 待辦④）', () => {
  const a = ask({ id: 1 });
  const refDef = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n\n[背景]: ${urlOf(1)}` });
  assert.ok(String(refDef.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是寫成參考定義');
  assert.equal(classify([a, refDef], T0 + 4 * 86400e3).pending.length, 1, '參考定義那一行不會顯示，關不掉問題');
  // GFM 允許標籤與網址之間換一行——只剝第一行就會把網址留在可見層（#579 r7 High①）
  const twoLine = c({ id: 4, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n\n[背景]:\n    ${urlOf(1)}` });
  assert.ok(String(twoLine.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是寫成換行的參考定義');
  assert.equal(classify([a, twoLine], T0 + 4 * 86400e3).pending.length, 1, '換行的參考定義也不會顯示，關不掉問題');
  // 對照組：長得像但不是參考定義（行首不是 `[名稱]:`）的照樣看得見
  const looksLike = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n見 [背景] ${urlOf(1)}` });
  assert.equal(classify([a, looksLike], T0 + 4 * 86400e3).closed.length, 1, '正常行文裡的網址照樣算引到');
  // 參考定義吃到**空行**為止（GFM 的定義可以換行放網址、再換一行放 title，逐條去湊那個文法就是在寫剖析器）。
  // 這是**多剝**的方向，代價寫成考題：沒有空行隔開、緊貼在定義下面的那句話會被當成看不見。
  const glued = c({ id: 5, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n[背景]: https://example.com/x\n關的是 ${urlOf(1)}` });
  assert.equal(classify([a, glued], T0 + 4 * 86400e3).pending.length, 1,
    '緊貼在參考定義下面（沒有空行）的內容一律當看不見——多剝的方向，代價是這一則認不得');
  // 對照組：空行隔開之後就是正常內文，照樣看得見
  const separated = c({ id: 6, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n[背景]: https://example.com/x\n\n關的是 ${urlOf(1)}` });
  assert.equal(classify([a, separated], T0 + 4 * 86400e3).closed.length, 1, '空行之後是正常內文，不可以跟著剝掉');
  // 定義的 title 另起一行也要吃掉（漏掉就是少剝＝誤關）
  const withTitle = c({ id: 7, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n\n[q]:\n  ${urlOf(1)}\n  "說明"` });
  assert.equal(classify([a, withTitle], T0 + 4 * 86400e3).pending.length, 1, '定義的網址與 title 都不會顯示，關不掉問題');
});

test('⭐ 只認兩種引法：明寫連結要緊接 `)`，裸網址才吃 GFM 的結尾標點（#579 r8 High①）', () => {
  const a = ask({ id: 1 });
  // ① 明寫連結：destination 由括號界定，裡面的 `~` 屬於網址 ⇒ 那是**別的位置**，不算引到
  const tilde = ruling({ id: 2, at: T0 + 60e3, cites: `[另一個位置](${urlOf(1)}~)` });
  assert.equal(classify([a, tilde], T0 + 4 * 86400e3).pending.length, 1, '明寫連結的網址結尾多一個 `~`＝另一個位置');
  const comma = ruling({ id: 3, at: T0 + 120e3, cites: `[另一個位置](${urlOf(1)},x)` });
  assert.equal(classify([a, comma], T0 + 4 * 86400e3).pending.length, 1, '明寫連結裡的 `,` 也屬於網址');
  // 對照組：明寫連結指到**正確**的網址就算引到
  const ok = ruling({ id: 4, at: T0 + 180e3, cites: `見 [這則待裁](${urlOf(1)})` });
  assert.equal(classify([a, ok], T0 + 4 * 86400e3).closed.length, 1, '明寫連結指對了就算引到');
  // ② 裸網址：GFM 的自動連結會把結尾的 ?!.,:*_~ 當標點修掉
  for (const tail of ['.', '，', '!', '?', ':', '~', '*', '。']) {
    const bare = ruling({ id: 5, at: T0 + 240e3, cites: `關的是 ${urlOf(1)}${tail}` });
    assert.equal(classify([a, bare], T0 + 4 * 86400e3).closed.length, 1, `裸網址後面接「${tail}」照樣算引到`);
  }
  // 裸網址後面接著字仍然不算（那是另一個位置）
  for (const tail of ['~oops', '.5', '@x', 'oops']) {
    const ext = ruling({ id: 6, at: T0 + 300e3, cites: `關的是 ${urlOf(1)}${tail}` });
    assert.equal(classify([a, ext], T0 + 4 * 86400e3).pending.length, 1, `裸網址後面接「${tail}」＝另一個位置`);
  }
});

test('⭐ 被界定的 destination 一律逐字比：留空白、角括號、角括號自動連結都不可以繞過（#579 r9 High①）', () => {
  // 上一版用單字元 lookbehind 猜「前面是不是 `(`」，這三種合法寫法都讓網址前一個字變成空白或 `<`。
  const a = ask({ id: 1 });
  const cases = [
    ['destination 前面留空白', `[文字]( ${urlOf(1)}~)`],
    ['destination 用角括號', `[文字](<${urlOf(1)}~>)`],
    ['角括號自動連結', `<${urlOf(1)}~>`],
    ['destination 帶 title', `[文字](${urlOf(1)}~ "說明")`],
  ];
  for (const [name, cite] of cases) {
    const cmt = ruling({ id: 2, at: T0 + 60e3, cites: cite });
    assert.equal(classify([a, cmt], T0 + 4 * 86400e3).pending.length, 1,
      `${name}：網址尾端多一個 ~ ＝另一個位置，不算引到`);
  }
  // 對照組：同樣三種寫法指到**正確**的網址時要算引到（不然這一收就把常見寫法收死了）
  const good = [
    ['destination 前面留空白', `[文字]( ${urlOf(1)} )`],
    ['destination 用角括號', `[文字](<${urlOf(1)}>)`],
    ['角括號自動連結', `<${urlOf(1)}>`],
    ['destination 帶 title', `[文字](${urlOf(1)} "說明")`],
  ];
  for (const [name, cite] of good) {
    const cmt = ruling({ id: 3, at: T0 + 120e3, cites: cite });
    assert.equal(classify([a, cmt], T0 + 4 * 86400e3).closed.length, 1, `${name}：指對了就算引到`);
  }
});

test('⭐ destination 要整段挖掉：巢狀括號、跳脫的 `\\)`、圖片、title 裡的網址都不算引到（#579 r10 High①）', () => {
  // 抓到第一個 `)` 或空白就停的話，這些合法連結的**內部**網址會漏回裸網址那條規則，
  // 於是指向別處的複合 destination 被算成引到這一則。
  const a = ask({ id: 1 });
  const U = urlOf(1);
  const cases = [
    ['巢狀括號', `[x](https://example.com(foo)${U})`],
    ['跳脫的 )', `[x](https://example.com\\)${U})`],
    ['圖片', `![x](https://example.com(foo)${U})`],
    ['title 裡剛好有那個網址', `[x](https://example.com (${U}))`],
  ];
  for (const [name, cite] of cases) {
    const cmt = ruling({ id: 2, at: T0 + 60e3, cites: cite });
    assert.ok(String(cmt.body).includes(U), `${name}：對照斷言——網址真的在原文裡`);
    assert.equal(classify([a, cmt], T0 + 4 * 86400e3).pending.length, 1,
      `${name}：真正的連結指向別處，不算引到這一題`);
  }
  // 對照組：同樣有括號但 destination 就是那個網址時，照樣算引到
  const good = ruling({ id: 3, at: T0 + 120e3, cites: `見 [這則待裁](${U}) （附註）` });
  assert.equal(classify([a, good], T0 + 4 * 86400e3).closed.length, 1, '指對了就算引到');
  // 對照組：連結後面另外寫一個裸網址，那個裸的照樣算引到
  const both = ruling({ id: 4, at: T0 + 180e3, cites: `[別的](https://example.com/x) 關的是 ${U}` });
  assert.equal(classify([a, both], T0 + 4 * 86400e3).closed.length, 1, '挖掉 destination 不可以把後面的裸網址一起吃掉');
  // `](` 解析不出一個完整的 inline link 時，那就**不是連結**——GitHub 也是把它當普通文字，
  // 後面那個裸網址照樣渲染成可點的連結。所以照原文放行、該認就認（r10 那一版丟到結尾＝漏認，#579 r11 High②）。
  const unclosedParen = ruling({ id: 5, at: T0 + 240e3, cites: `[壞掉的連結]( 關的是 ${U}` });
  assert.equal(classify([a, unclosedParen], T0 + 4 * 86400e3).closed.length, 1,
    '解析不出連結＝那是普通文字，後面的裸網址照樣算引到');
  // 行內程式碼裡的 `](` 更不是連結開門，不可以吃掉後面正常的引用（#579 r11 High②）
  const inCode = ruling({ id: 6, at: T0 + 300e3, cites: `語法片段 ${BT}arr](x${BT}；關的是 ${U}` });
  assert.equal(classify([a, inCode], T0 + 4 * 86400e3).closed.length, 1,
    '行內程式碼裡的 `](` 只是文字，後面的裸網址照樣算引到');
});

test('⭐ title 裡的網址不算引到：引號式 title 可以寫 `)` 與 `<網址>`（#579 r11 High①）', () => {
  const a = ask({ id: 1 });
  const U = urlOf(1);
  const cases = [
    ['title 裡有 ) 和網址', `[x](https://example.com "說明 ) ${U} 附註")`],
    ['title 裡有角括號網址', `[x](https://example.com "背景 <${U}> 補充")`],
    ['單引號 title', `[x](https://example.com '說明 ${U}')`],
    ['括號式 title', `[x](https://example.com (說明 ${U}))`],
  ];
  for (const [name, cite] of cases) {
    const cmt = ruling({ id: 2, at: T0 + 60e3, cites: cite });
    assert.ok(String(cmt.body).includes(U), `${name}：對照斷言——網址真的在原文裡`);
    assert.equal(classify([a, cmt], T0 + 4 * 86400e3).pending.length, 1,
      `${name}：連結指向別處、網址只在 title 屬性裡，不算引到`);
  }
  // 對照組：title 存在、但 destination 就是那個網址時照樣算引到
  const good = ruling({ id: 3, at: T0 + 120e3, cites: `[這則待裁](${U} "說明")` });
  assert.equal(classify([a, good], T0 + 4 * 86400e3).closed.length, 1, 'destination 指對了就算引到');
});

test('⭐ GFM 的跳脫要照規矩解：角括號裡的 `\\>` 不是關門、`\\1` 的反斜線是字面字元（#579 r12 High①）', () => {
  const a = ask({ id: 1 });
  const U = urlOf(1);
  // 角括號 destination：`\>` 是跳脫的 `>`。只用第一個 `>` 關門，後半段就漏回可見層被當成引到。
  const angleEscape = ruling({ id: 2, at: T0 + 60e3, cites: `[x](<https://example.com/${BS}>${U}>)` });
  assert.equal(classify([a, angleEscape], T0 + 4 * 86400e3).pending.length, 1,
    '真正的連結指向別處（那個 `>` 是網址的一部分），不算引到');
  // GFM 只有 ASCII 標點受跳脫：`\1` 的反斜線是字面字元，無條件去跳脫會剛好變成目標網址。
  const digitEscape = ruling({ id: 3, at: T0 + 120e3, cites: `[x](${U.slice(0, -1)}${BS}1)` });
  assert.equal(classify([a, digitEscape], T0 + 4 * 86400e3).pending.length, 1,
    '`\\1` 不是跳脫序列，那條網址跟這一題的不一樣');
  // 對照組：ASCII 標點的跳脫**要**去掉（不然就變成反方向的漏認）
  const punctEscape = ruling({ id: 4, at: T0 + 180e3, cites: `[x](${U.replace('#', `${BS}#`)})` });
  assert.equal(classify([a, punctEscape], T0 + 4 * 86400e3).closed.length, 1,
    '`\\#` 是合法的跳脫，去掉之後就是這一題的網址');
});

test('⭐ 參考定義的標籤可以含跳脫的 `]`、也可以跨行（#579 r12 High②）', () => {
  const a = ask({ id: 1 });
  const U = urlOf(1);
  const escaped = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n\n[lab${BS}]]: <${U}>` });
  assert.ok(String(escaped.body).includes(U), '對照斷言：網址真的在原文裡');
  assert.equal(classify([a, escaped], T0 + 4 * 86400e3).pending.length, 1, '標籤裡跳脫的 `]` 仍然是參考定義，不會顯示');
  const multiline = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n\n[lab\nel]: <${U}>` });
  assert.equal(classify([a, multiline], T0 + 4 * 86400e3).pending.length, 1, '標籤跨行的參考定義一樣不會顯示');
});

test('⭐ 展示語法用的寫法不是連結：跳脫的 `\\[x\\](…)` 與跨空行的 title 不可以吞掉可見的引用（#579 r12 High③）', () => {
  const a = ask({ id: 1 });
  const U = urlOf(1);
  const shown = ruling({ id: 2, at: T0 + 60e3, cites: `${BS}[x${BS}](https://example.com "background <${U}> here")` });
  assert.equal(classify([a, shown], T0 + 4 * 86400e3).closed.length, 1,
    '跳脫的中括號＝普通文字，後面那個網址在畫面上看得見、算引到');
  const acrossBlank = ruling({ id: 3, at: T0 + 120e3, cites: `[x](https://example.com\n\n"background <${U}> here")` });
  assert.equal(classify([a, acrossBlank], T0 + 4 * 86400e3).closed.length, 1,
    '空行之後連結已經不成立，不可以跨段把後面的網址當 title 吃掉');
});

test('⭐ 行內程式碼裡的 `](` 不是連結開門（這一題把上一版「沒有考題撐得住」那句自白補實了；#579 r12 High④）', () => {
  // 上一版註解老實寫「湊不出反例」，Codex 湊出來了：程式碼裡的 `](` 加上外面的引號，
  // 會被當成一個有 title 的連結，把外面正常可見的網址整段吃掉。
  const a = ask({ id: 1 });
  const U = urlOf(1);
  const inCode = ruling({ id: 2, at: T0 + 60e3, cites: `${BT}arr](${BT} "背景 <${U}> ")` });
  assert.equal(classify([a, inCode], T0 + 4 * 86400e3).closed.length, 1,
    '`arr](` 在畫面上是程式碼字樣，後面的網址正常顯示、算引到');
});

test('⭐ 佔位符不可以被留言的內容撞到：自己打私用區字元也合不出隱藏的網址（#579 r9 High②）', () => {
  // 反例：註解裡放一個行內程式碼（內容＝網址加一個尾端空白），註解外放 literal U+E000 0 U+E001。
  // GitHub 只顯示那三個怪字元、完全沒有網址；還原時若不先清掉，就會把註解裡的網址合成回可見層。
  const a = ask({ id: 1 });
  const collide = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆別題\n\n原話（對話中，Claude 轉述）：**「好」**\n\n`
      + `<!-- ${BT}${urlOf(1)} ${BT} -->\n\u{E000}0\u{E001}` });
  assert.ok(String(collide.body).includes(urlOf(1)), '對照斷言：網址真的在原文裡，只是關在 HTML 註解中');
  assert.equal(classify([a, collide], T0 + 4 * 86400e3).pending.length, 1, '註解裡的網址不可以被佔位符合成回可見層');
});

test('⭐ 星號只在網址**結尾**才算包裝，絕不改寫網址本身（#579 r7 High②）', () => {
  // 上一版對整段文字全域刪 `*`，於是 `…#issuecomment-*1` 被抹成 `…#issuecomment-1`＝另一則的網址，
  // GitHub 實際渲染出的連結指向 `issuecomment-*1`，卻被判成引到這一題 ⇒ 真的還沒回被誤關。
  const a = ask({ id: 1 });
  const inner = ruling({ id: 2, at: T0 + 60e3, cites: 'https://github.com/o/r/pull/100#issuecomment-*1' });
  assert.equal(classify([a, inner], T0 + 4 * 86400e3).pending.length, 1, '星號夾在網址中間＝那是另一個位置，不算引到');
  const innerMid = ruling({ id: 3, at: T0 + 120e3, cites: 'https://github.com/o/r/pull/1*00#issuecomment-1' });
  assert.equal(classify([a, innerMid], T0 + 4 * 86400e3).pending.length, 1, '星號夾在網址中間（前段）一樣不算');
  // 對照組：包起來的寫法仍然算引到（不然這一收就把常見寫法收死了）——
  // GFM 的自動連結明定結尾的 `*_~` 不算網址的一部分，所以只要動右邊界就夠，開頭的星號本來就不影響比對。
  for (const wrap of ['*', '**', '***']) {
    const bold = ruling({ id: 4, at: T0 + 180e3, cites: `${wrap}${urlOf(1)}${wrap}` });
    assert.equal(classify([a, bold], T0 + 4 * 86400e3).closed.length, 1, `外層 ${wrap} 包起來的網址算引到`);
  }
  const plain = ruling({ id: 5, at: T0 + 240e3, cites: `關的是 ${urlOf(1)} 。` });
  assert.equal(classify([a, plain], T0 + 4 * 86400e3).closed.length, 1, '對照組：沒包裝的照樣算引到');
});

test('⭐ 行內程式碼裡的註解語法不算註解（`` `<!--照做-->` `` 是畫面上看得見的寫法，#579 r5 High①反方向）', () => {
  const a = ask({ id: 1 });
  const inlineComment = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「${BT}<!--照做-->${BT}」**\n關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(inlineComment), 'ruling', '行內程式碼在畫面上看得見，不可以被註解剝除吃掉');
  assert.equal(classify([a, inlineComment], T0 + 4 * 86400e3).closed.length, 1);
});

test('⭐ 註解從標頭那一行的行尾開門：藏在裡面的假原話不可以關掉問題（#579 r5 High③）', () => {
  // 這一刀證明「藏起來的原話靠第一段的錨點就擋住了」那句話是錯的：
  // 註解在標頭行尾開門，剝掉之前，藏在註解裡的那行「原話…」剛好就是標頭後的第一段。
  const a = ask({ id: 1 });
  const trick = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆 <!--\n原話（對話中，Claude 轉述）：**「假的」**\n-->\n關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(trick), 'near', '藏在註解裡的原話不算數，不管它排在第幾段');
  assert.equal(classify([a, trick], T0 + 4 * 86400e3).pending.length, 1, '真的還沒回的問題不可以被它關掉');
});

test('⭐ 🤖 的判準跟複審聯集閘同一份：照 AGENTS 教的用 `>` 引用 Codex 的發現，裁示仍然有效（#579 r5 High②）', () => {
  // AGENTS 明教「引 Codex 的發現一律放 `>` 引用或反引號」；自己寫 body.includes('🤖') 比正本嚴，
  // 照做的裁示會被判成形狀不合，已經裁過的問題就冒回「還沒回」。
  const a = ask({ id: 1 });
  const quoted = c({ id: 2, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n\n> 🤖 Codex 的發現（去掉標頭）\n\n關的是 ${urlOf(1)}` });
  assert.ok(String(quoted.body).includes('🤖'), '對照斷言：原文真的有那個記號，只是放在引用裡');
  assert.equal(shapeOf(quoted), 'ruling', '引用裡的記號閘自己也不算，這支不可以比正本嚴');
  assert.equal(classify([a, quoted], T0 + 4 * 86400e3).closed.length, 1);
  // 對照組：裸的記號照樣不算數（不是把這條放掉）
  const bare = c({ id: 3, at: T0 + 60e3,
    body: `## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「好」**\n🤖 Codex\n關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(bare), 'near', '裸的 🤖 仍然讓整則不算數');
  assert.equal(classify([a, bare], T0 + 4 * 86400e3).pending.length, 1);
});

test('⭐ 行內程式碼是看得見的，不可以跟著剝掉（剝過頭＝合規的留痕被判成形狀不合）', () => {
  const a = ask({ id: 1 });
  const inlineCode = c({ id: 2, at: T0 + 60e3,
    body: '## ⚖️ William 裁示（2026-09-02）：答覆\n\n原話（對話中，Claude 轉述）：**「照 `--all` 那個做法」**\n'
      + `關的是 ${urlOf(1)}` });
  assert.equal(shapeOf(inlineCode), 'ruling', '單反引號在畫面上看得見（只是換字體），藏不了東西');
  assert.equal(classify([a, inlineCode], T0 + 4 * 86400e3).closed.length, 1);
});

test('⭐ 粗體包起來的裸網址算引到（裸網址的右邊界容許結尾的 `*_~` 等標點；不剝星號、也不把 `*` 當通用收尾）', () => {
  // `*` 是 fragment 的合法字元，當通用收尾會誤關；但 `**<網址>**` 是常見的可見寫法，
  // 判成「沒引到」會讓已經回過的問題冒回「還沒回」（#579 r4 待辦⑤）。
  // 實作＝裸網址後面最多 3 個 `?!.,:*_~` 再接收尾字或文末（GFM 自動連結會把結尾的這些當標點修掉）；
  // 可見層沒有剝星號（上一版題名寫「先剝包裝符號」，跟實作不符——#579 r28 Medium）。
  const a = ask({ id: 1 });
  const bold = ruling({ id: 2, at: T0 + 60e3, cites: `**${urlOf(1)}**` });
  assert.equal(classify([a, bold], T0 + 4 * 86400e3).closed.length, 1);
  // 對照組：`*` 沒有變成通用收尾——網址後面接 `*oops` 仍然不算引到
  const ext = ruling({ id: 3, at: T0 + 120e3, cites: `${urlOf(1)}*oops` });
  assert.equal(classify([a, ext], T0 + 4 * 86400e3).pending.length, 1, '`*` 不是收尾字，後面還接著字就是另一個位置');
});

test('⭐ 被編輯過的問題＝沒起算：不算天數、不標逾時，改印「要另貼一則新的」', () => {
  const r = classify([ask({ id: 1, edited: true })], T0 + 10 * 86400e3);
  assert.equal(r.pending[0].edited, true);
  assert.equal(r.pending[0].hours, null);
  assert.equal(r.pending[0].overdue, false);
  const out = render(r, { host: 'github.com', slug: 'o/r', expected: 1 });
  assert.match(out, /不算起算/);
  assert.doesNotMatch(out, /放了 \d+ 天/, '沒起算就不可以印出一個規則上不存在的期限');
});

test('⭐ 配不到但後面有裁示留言＝中間態：仍列在「還沒回」，並說我配不出來（找的範圍跨 PR，跟配對一致）', () => {
  const a = ask({ id: 1, pr: 577 });
  const later = ruling({ id: 2, pr: 578, at: T0 + 3600e3, cites: '（沒有引網址）' });
  const r = classify([a, later], T0 + 4 * 86400e3);
  assert.equal(r.pending.length, 1, '配不到就留在清單裡——不由這支替他把題目吞掉');
  assert.equal(r.pending[0].unlinkedLater, true);
  assert.match(render(r, { host: 'github.com', slug: 'o/r', expected: 2 }), /不能替你配對/);
});

test('⭐ 逾時暫定不算已結：那一類正是「他還沒回、我先照預設做了」，另開一段列出來', () => {
  const a = ask({ id: 1 });
  const t = timeout({ id: 2, at: T0 + 4 * 86400e3, cites: urlOf(1) });
  const r = classify([a, t], T0 + 5 * 86400e3);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.closed, []);
  assert.equal(r.provisional.length, 1);
  assert.match(render(r, { host: 'github.com', slug: 'o/r', expected: 2 }), /已照預設先做、他還沒裁/);
});

test('⭐ 只有 repo 擁有者貼的才算：外人貼的裁示留言關不掉問題，而且會被列進「形狀不合」讓人看見', () => {
  // repo 是公開的，任何人都能貼一則第一行合規的留言；配對若不看作者，一則活著的問題會被靜靜吞掉。
  const a = ask({ id: 1 });
  const outsider = ruling({ id: 2, at: T0 + 3600e3, cites: urlOf(1), assoc: 'NONE' });
  const r = classify([a, outsider], T0 + 4 * 86400e3);
  assert.equal(r.pending.length, 1);
  assert.equal(r.near.length, 1);
  assert.match(r.near[0].why, /不是 repo 擁有者/);
});

test('⭐ 已結的一定印出來（附配對連結）：「沒有還沒回的」必須是看得到證據的結論，不是沉默', () => {
  const a = ask({ id: 1 });
  const b = ruling({ id: 2, at: T0 + 3600e3, cites: urlOf(1) });
  const out = render(classify([a, b], T0 + 4 * 86400e3), { host: 'github.com', slug: 'o/r', expected: 2 });
  assert.match(out, /還沒回的問題：沒有/);
  assert.match(out, /我判定已結的：1 則/);
  assert.match(out, /issuecomment-2/, '配對連結要印出來，配錯了才看得出來');
  assert.match(out, /github\.com \/ o\/r/, '第一行要印掃的是哪個 repo——掃到別的 repo 時看得出來');
});

test('⭐ 長得像標頭但不合規定的要列出來（真的發生過：一則裁示少了「## ⚖️ 」前綴）', () => {
  const near = c({ id: 1, body: 'William 裁示（2026-08-14，選項題三選一）：**欄名統一**' });
  const r = classify([near], T0);
  assert.equal(r.near.length, 1);
  assert.match(render(r, { host: 'github.com', slug: 'o/r', expected: 1 }), /形狀不合、我沒算進去的：1 則/);
});

test('⭐ 這支不判類別：兩則問題的類別聲明不同（一則屬錢、一則不是），輸出區塊除了問題與網址以外逐字相同', () => {
  // 守的是「工具不長成第二份規則書」——可不可以照預設先做，正本在 AGENTS，這裡照著判就會變成第二份。
  const money = ask({ id: 1, at: T0, q: '甲問題', body: '## ❓ 待裁（2026-09-01）：甲問題\n類別聲明：屬①錢的絕對邊界' });
  const other = ask({ id: 2, at: T0, q: '乙問題', body: '## ❓ 待裁（2026-09-01）：乙問題\n類別聲明：非錢、非金額口徑' });
  const out = render(classify([money, other], T0 + 5 * 86400e3), { host: 'github.com', slug: 'o/r', expected: 2 });
  const blocks = out.split('\n').filter((l) => /^\s+(放了|貼在|看這裡)/.test(l));
  const norm = (/** @type {string} */ l) => l.replace(/issuecomment-\d+/, 'X');
  assert.deepEqual(blocks.slice(0, 3).map(norm), blocks.slice(3, 6).map(norm), '兩則的處置文字不可以因為類別而不同');
});

test('⭐ 排序：放最久的排最前', () => {
  const older = ask({ id: 1, at: T0 });
  const newer = ask({ id: 2, at: T0 + 86400e3 });
  assert.deepEqual(classify([newer, older], T0 + 5 * 86400e3).pending.map((x) => x.id), [1, 2]);
});

test('⭐ 逾時是兩個時間點相減、不是日曆日：跨了三個日曆日但只過 52 小時 → 不算逾時（日曆日寫法會誤標）', () => {
  const at = T0 + 20 * 3600e3;           // UTC 9/1 20:00
  const now = T0 + 3 * 86400e3;          // UTC 9/4 00:00：日曆日差 3 天，實際只過 52 小時
  const calDays = (/** @type {number} */ t, /** @type {number} */ offsetH) => Math.floor((t + offsetH * 3600e3) / 86400e3);
  assert.equal(calDays(now, 0) - calDays(at, 0), 3, '對照斷言：日曆日寫法會說「3 天」＝已達時限，這題才有鑑別力');
  assert.equal(calDays(now, 8) - calDays(at, 8), 2, '對照斷言：同一組夾具換個時區，日曆日寫法連答案都不一樣');
  const r = classify([ask({ id: 1, at })], now);
  assert.equal(r.pending[0].hours, 52);
  assert.equal(r.pending[0].overdue, false, '只過 52 小時就標逾時＝規則上不存在的期限');
});

test('形狀驗證：頁不是陣列、留言缺欄位，一律丟（不拿殘缺清單下結論）', () => {
  assert.equal(flatten(JSON.stringify([[c({ id: 1, body: 'x' })]])).length, 1);
  for (const bad of ['{}', '[{}]', '[[{"id":1}]]', '[[{"id":1,"body":"x","created_at":"t","updated_at":"t","html_url":"u"}]]']) {
    assert.throws(() => flatten(bad), `${bad} 應該丟`);
  }
  assert.equal(expectedTotal(JSON.stringify([[{ comments: 3 }, { comments: 4 }]])), 7);
  assert.throws(() => expectedTotal(JSON.stringify([[{}]])), /comments/);
});

test('小工具：第一行取標題、從網址推編號', () => {
  assert.equal(titleOf('## ❓ 待裁（2026-09-01）：問題原句\n下一行'), '問題原句');
  assert.equal(titleOf('沒有全形冒號的一行'), '沒有全形冒號的一行');
  assert.equal(numberOf('https://github.com/o/r/pull/577#issuecomment-1'), 577);
  assert.equal(numberOf('https://github.com/o/r/issues/12#issuecomment-1'), 12);
  assert.equal(numberOf('https://example.com/x'), null);
});

// ── CLI ──────────────────────────────────────────────────────────────────────
/**
 * 假 gh：逐 token 記 argv、記看到的 GIT_*；`issues?state=…` 回 issues、`issues/comments` 回 comments。
 * 缺 --paginate／--slurp／--hostname 就 exit 1（真 gh 沒有那些旗標時行為完全不同）。
 * @param {{issues?: string, comments?: string, failOnGitEnv?: boolean, env?: Record<string,string>, args?: string[]}} o
 * @param {(x: {r: ReturnType<typeof spawnSync>, calls: string[][], seen: string[]}) => void} fn
 */
function withFakeGh({ issues, comments, failOnGitEnv = false, env = {}, args = ['--all'] }, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pending-gh-'));
  try {
    if (issues !== undefined) writeFileSync(join(dir, 'issues.json'), issues);
    if (comments !== undefined) writeFileSync(join(dir, 'comments.json'), comments);
    writeFileSync(join(dir, 'gh'), [
      '#!/bin/sh',
      `{ for a in "$@"; do printf '%s\\t' "$a"; done; printf '\\n'; } >> ${JSON.stringify(join(dir, 'argv.txt'))}`,
      `{ echo CALLED; env | cut -d= -f1 | grep '^GIT_'; } >> ${JSON.stringify(join(dir, 'seen.txt'))}`,
      failOnGitEnv ? "if env | grep -q '^GIT_'; then exit 1; fi" : ':',
      'has() { for a in "$@"; do [ "$a" = "$want" ] && return 0; done; return 1; }',
      'want=--paginate; has "$@" || exit 1; want=--slurp; has "$@" || exit 1; want=--hostname; has "$@" || exit 1',
      `case "$*" in *issues/comments*) f=${JSON.stringify(join(dir, 'comments.json'))} ;; *issues?state=all*|*"issues?state=all"*) f=${JSON.stringify(join(dir, 'issues.json'))} ;; *) exit 1 ;; esac`,
      'if [ -f "$f" ]; then cat "$f"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'));
    chmodSync(join(dir, 'gh'), 0o755);
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}` } });
    const read = (/** @type {string} */ f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean) : []);
    fn({ r, calls: read('argv.txt').map((l) => l.split('\t').filter(Boolean)), seen: read('seen.txt') });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const pages = (/** @type {any[]} */ xs) => JSON.stringify([xs]);
const ISSUES = (/** @type {number} */ n) => JSON.stringify([[{ comments: n }]]);

test('⭐ CLI｜兩次呼叫逐 token 釘住（少任一旗標真 gh 的行為就不同），而且只打這兩次', () => {
  withFakeGh({ issues: ISSUES(1), comments: pages([ask({ id: 1 })]) }, ({ r, calls }) => {
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls, [
      ['api', '--paginate', '--slurp', '--hostname', 'github.com', 'repos/teacherjung/personal-finance-webapp/issues?state=all&per_page=100'],
      ['api', '--paginate', '--slurp', '--hostname', 'github.com', 'repos/teacherjung/personal-finance-webapp/issues/comments?per_page=100'],
    ], '多打一支 API、或掉一個旗標都要紅');
  });
});

test('⭐ CLI｜撈到的比 GitHub 自報的少＝被截斷 → 退 2、不印清單（不拿殘缺清單印一句「沒有還沒回的」）', () => {
  withFakeGh({ issues: ISSUES(99), comments: pages([ask({ id: 1 })]) }, ({ r }) => {
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /筆數不一致/);
    assert.doesNotMatch(r.stdout, /還沒回的問題/);
  });
});

test('⭐ CLI｜撈到的比 GitHub 自報的**多**也是壞回應 → 退 2、不印清單（對帳兩個方向都 fail-closed）', () => {
  // 只擋「少於」的話，自報被低估而剛好對上長度，成功路會走完印「沒有還沒回的」（Grok #579 掃後 1B）。
  const two = [c({ id: 1, body: '## ❓ 待裁（2026-09-01）：問題？\n選項…' }), c({ id: 2, body: '普通留言' })];
  withFakeGh({ issues: ISSUES(1), comments: JSON.stringify([two]) }, ({ r }) => {
    assert.equal(r.status, 2, '多於自報＝壞回應，要退 2');
    assert.doesNotMatch(r.stdout, /還沒回的問題/, '算不出來時 stdout 不可以有清單');
    assert.match(r.stderr, /筆數不一致[^\n]*撈到 2[^\n]*自報 1/, '診斷文案要中性（不是「只撈到」），並印出兩個數字');
    assert.doesNotMatch(r.stderr, /只撈到|殘缺/, '多於自報時不可以說「只撈到／殘缺」，那是語意顛倒（#579 r26 Low）');
  });
});

test('⭐ CLI｜「掃完了、沒有還沒回的」與「算不出來」不可以長得一樣', () => {
  let ok = ''; let bad = '';
  withFakeGh({ issues: ISSUES(0), comments: pages([]) }, ({ r }) => { ok = r.stdout; assert.equal(r.status, 0); });
  withFakeGh({ issues: ISSUES(0) }, ({ r }) => { bad = r.stdout + r.stderr; assert.equal(r.status, 2); });
  assert.notEqual(ok, bad);
  assert.match(ok, /還沒回的問題：沒有/);
  assert.doesNotMatch(bad, /還沒回的問題：沒有/, '算不出來的時候絕不可以印出「沒有」——那是靜靜通過');
});

test('⭐ CLI｜gh 非零退出、回傳形狀不對 → 都退 2、stdout 不含清單', () => {
  withFakeGh({ }, ({ r }) => { assert.equal(r.status, 2); assert.doesNotMatch(r.stdout, /還沒回/); });
  withFakeGh({ issues: ISSUES(1), comments: '{}' }, ({ r }) => { assert.equal(r.status, 2); assert.match(r.stderr, /不是陣列/); });
});

test('⭐ CLI｜無參數＝印用法、退 2，而且一次都不連網', () => {
  withFakeGh({ issues: ISSUES(1), comments: pages([]), args: [] }, ({ r, seen }) => {
    assert.equal(r.status, 2);
    assert.match(r.stderr, /用法/);
    assert.deepEqual(seen, [], '無參數不可以打 API');
  });
});

test('⭐ CLI｜多打一個參數也是「不認得」：退 2、不連網（#579 r4 Low④）', () => {
  // 只看前兩個 token 的話，`--all --bogus` 會照樣連網跑完退 0，跟檔頭寫的「參數不認得＝退 2」對不上。
  for (const args of [['--all', '--bogus'], ['--pr', '579', '--all'], ['--pr'], ['--pr', '5x'], ['--All']]) {
    withFakeGh({ issues: ISSUES(1), comments: pages([]), args }, ({ r, seen }) => {
      assert.equal(r.status, 2, `「${args.join(' ')}」要退 2`);
      assert.match(r.stderr, /用法/);
      assert.deepEqual(seen, [], `「${args.join(' ')}」不可以打 API`);
    });
  }
  // 對照組：剛好那兩種寫法照樣跑得完（不然上面那一排是把工具收死了）
  withFakeGh({ issues: ISSUES(0), comments: pages([]), args: ['--all'] }, ({ r }) => assert.equal(r.status, 0));
  withFakeGh({ issues: ISSUES(0), comments: pages([]), args: ['--pr', '579'] }, ({ r }) => assert.equal(r.status, 0));
});

test('⭐ CLI｜欄位型別不對＝算不出來，不可以印成「沒有還沒回的」（#579 r4 Medium②）', () => {
  // `body: {}` 這種壞回應原本一路走到底，印出「掃了 1 則」「還沒回的問題：沒有」——
  // 跟「掃完了、真的沒有」長得一模一樣，正是這支最貴的失敗。
  const bad = [
    ['body 不是字串', { body: {} }],
    ['html_url 不是字串', { html_url: 123 }],
    ['author_association 不是字串', { author_association: null }],
    ['created_at 讀不出時間', { created_at: '不是時間' }],
    ['updated_at 讀不出時間', { updated_at: '' }],
  ];
  for (const [name, patch] of bad) {
    const one = { ...c({ id: 1, body: '## ❓ 待裁（2026-09-01）：問題？\n選項…' }), ...patch };
    withFakeGh({ issues: ISSUES(1), comments: JSON.stringify([[one]]) }, ({ r }) => {
      assert.equal(r.status, 2, `${name} 要退 2`);
      assert.doesNotMatch(r.stdout, /還沒回的問題/, `${name}：算不出來時 stdout 不可以有清單`);
    });
  }
  // 對照組：同一則沒有壞掉時真的跑得完（證明上面紅的是型別，不是夾具本身壞了）
  withFakeGh({ issues: ISSUES(1), comments: JSON.stringify([[c({ id: 1, body: '## ❓ 待裁（2026-09-01）：問題？\n選項…' })]]) },
    ({ r }) => { assert.equal(r.status, 0); assert.match(r.stdout, /還沒回的問題：1 則/); });
});

test('⭐ CLI｜GitHub 自報的筆數是負數＝壞回應，不可以拿去對帳', () => {
  withFakeGh({ issues: JSON.stringify([[{ comments: -3 }]]), comments: pages([]) }, ({ r }) => {
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stdout, /還沒回的問題/);
  });
});

test('⭐ CLI｜--pr 一樣掃全庫：別支的裁示照樣關得掉，別支的問題不會混進來', () => {
  const a = ask({ id: 1, pr: 577 });
  const b = ruling({ id: 2, pr: 578, at: T0 + 3600e3, cites: urlOf(1, 577) });
  const other = ask({ id: 3, pr: 500 });
  withFakeGh({ issues: ISSUES(3), comments: pages([a, b, other]), args: ['--pr', '577'] }, ({ r }) => {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /還沒回的問題：沒有/, '#578 上的裁示要能關掉 #577 的問題');
    assert.match(r.stdout, /我判定已結的：1 則/);
    assert.doesNotMatch(r.stdout, /issuecomment-3/, '別支的問題不可以混進來');
  });
});

test('⭐ --pr 也要過濾「形狀不合」：標頭說只印那一支，下面就不可以列出別支的（#579 r2 Medium③）', () => {
  const mine = c({ id: 1, pr: 577, body: 'William 裁示（沒有前綴）：本支的' });
  const others = c({ id: 2, pr: 500, body: 'William 裁示（沒有前綴）：別支的' });
  const out = render(classify([mine, others], T0), { host: 'github.com', slug: 'o/r', expected: 2, only: 577, seen: true });
  assert.match(out, /形狀不合、我沒算進去的：1 則/);
  assert.match(out, /本支的/);
  assert.doesNotMatch(out, /別支的/);
});

test('⭐ CLI｜--pr 編號打錯（那一支一則留言都沒有）要看得出來，不可以跟「全部已結」長得一樣', () => {
  withFakeGh({ issues: ISSUES(1), comments: pages([ask({ id: 1, pr: 577 })]), args: ['--pr', '999'] }, ({ r }) => {
    assert.equal(r.status, 0);
    assert.match(r.stdout, /#999 上一則留言都沒有掃到/);
  });
});

test('⭐ GIT_* 題①：髒環境＋一支「有 GIT_* 就壞掉」的假 gh → 仍算得出來', () => {
  withFakeGh({ issues: ISSUES(1), comments: pages([ask({ id: 1 })]), failOnGitEnv: true, env: { ...DIRTY_GIT_ENV } }, ({ r, seen }) => {
    assert.ok(seen.includes('CALLED'), '假 gh 根本沒被叫到——這題是空轉的');
    assert.equal(r.status, 0, r.stderr);
  });
});

test('⭐ GIT_* 題②：交給 gh 的環境裡不可以有任何 GIT_*（gh 會自己再 spawn git）', () => {
  withFakeGh({ env: { ...DIRTY_GIT_ENV } }, ({ seen }) => {
    assert.ok(seen.includes('CALLED'));
    assert.deepEqual(seen.filter((l) => l !== 'CALLED'), []);
  });
});

test('⭐ GIT_* 題②｜originRepo：假 git 直接看子行程環境', () => {
  const restore = injectDirtyGitEnv();
  try {
    assertChildGitEnvClean(assert, 'scripts/pending-rulings.js 走的 originRepo()', () => {
      spawnSync(process.execPath, [SCRIPT, '--all'], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 });
    });
  } finally { restore(); }
});

test('⭐ 這支不是閘：**整份合併手冊**一個字都不提它（不是只掃「合併步驟」那一段）', () => {
  // test/helpers/merge-gates.js 的反查器只認 `node scripts/x.js <N>`，這支的兩種呼叫形狀它都看不到，
  // 所以「不在閘名單裡」那種寫法對這支永遠不會紅——改成直接掃文件。
  // ⚠️ **起點不要再釘了**：r11 釘在第一個 `> 1.`（前面插一行就繞過）、r12 改釘在前言那一行
  //   （前言**之前**插一行又繞過）。每釘一次就多一個「前面」。所以改成掃**整份檔案**——
  //   `REVIEW-AND-MERGE.md` 是合併手冊，這支不該出現在裡面的任何位置，這句話才是封閉的。
  //   代價：哪天真的想在手冊裡提到它（例如寫「這支**不是**合併步驟的一環」），就要回來改這題。
  //   那個代價是對的：那正是「把它寫進合併手冊」這件事該有的摩擦。
  const doc = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  assert.doesNotMatch(doc, /pending-rulings/,
    '合併手冊提到這支＝它變成流程的一環（pre-push 那種「非零就擋」的地方會讓退出碼 2 變成擋人）');
});

test('⭐ 這支不是閘（第二半）：CI 設定與 pre-push 也不可以叫它——那兩處是「非零就擋」，接進去它就變成閘', () => {
  // 檔頭寫「不是閘靠的是沒有人把它接進 pre-push／CI／合併步驟」；只掃合併步驟的話，接進 CI 照樣全綠（#579 r1 Medium④）。
  // ⚠️ 只掃兩份寫死的 workflow 也不夠：新增一份 workflow 就繞過去了，所以掃整個目錄。
  const dir = join(ROOT, '.github/workflows');
  const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join('.github/workflows', f));
  assert.ok(workflows.length >= 2, '掃不到 workflow＝這題變空包彈（目錄名或副檔名改了？）');
  for (const f of [...workflows, 'scripts/git-hooks/pre-push']) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /pending-rulings/,
      `${f} 叫了這支＝它變成一道會因為沒有網路或沒有權杖而擋人的閘（那兩處都是非零就擋）`);
  }
});

/**
 * `package.json` 裡哪些 script **跑得到**這支（含經 `npm run` 轉手的別名鏈，一路追）。
 * ⚠️ 抽成一份給兩題共用：原本兩題各自複製一份迴圈，「護欄本身」那題證明的是它自己那份、
 *    不是真正在對帳的那份——兩份可以各改各的而全綠（Grok #579 掃後 4）。
 * @param {Record<string, string>} scripts
 */
function reachingScripts(scripts) {
  const reaching = new Set(Object.keys(scripts).filter((k) => /pending-rulings/.test(scripts[k])));
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, cmd] of Object.entries(scripts)) {
      if (reaching.has(name)) continue;
      for (const m of String(cmd).matchAll(/(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/g)) {
        if (reaching.has(m[1])) { reaching.add(name); grew = true; break; }
      }
    }
  }
  return [...reaching].sort();
}

test('⭐ 這支不是閘（第三半）：`package.json` 也不可以給它一個 script 別名——那是繞過字面掃描的一層轉手（#579 r3 Medium③）', () => {
  // Codex 實測：加 `"opening-reminders": "node scripts/pending-rulings.js --all"`、CI 只寫 `npm run opening-reminders`，
  // 工具已經進門（沒網路／沒權杖就擋人），而只掃字面的兩題全綠。
  // 這裡直接釘住上游：**package.json 裡沒有任何 script（含經過 `npm run` 轉手的鏈）跑得到這支**。
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(reachingScripts(/** @type {Record<string, string>} */ (pkg.scripts ?? {})), [],
    'package.json 有 script 跑得到這支——CI 或 pre-push 只要寫 `npm run <別名>` 就把它變成閘，而字面掃描看不到');
});

test('⭐ 護欄本身：別名鏈追得到（跑的是上一題**同一份**函式，不是複製品）', () => {
  // 上一題在現行樹上永遠是空集合＝看不出它有沒有在做事。這裡拿假的 package.json 逼**同一份函式**走完追蹤。
  assert.deepEqual(reachingScripts({ deep: 'node scripts/pending-rulings.js --all', mid: 'npm run deep', top: 'npm run mid', other: 'node scripts/acceptance-tier.js 1' }),
    ['deep', 'mid', 'top'], '兩層轉手的別名都要追得到，不相干的 script 不可以被拖下水');
  assert.deepEqual(reachingScripts({ a: 'npm run b', b: 'echo hi' }), [], '跟這支無關的鏈不可以誤報');
});

test('⭐ 這支不是閘（第四半）：合併閘的腳本本身也不可以呼叫它（手冊沒寫檔名 ≠ 閘腳本沒接）', () => {
  // 合併步驟那題只掃手冊；真正會跑的是 scripts/check-*.js。字面掃描要連它們一起看（Grok #579 掃後 4）。
  const gates = readdirSync(join(ROOT, 'scripts')).filter((f) => /^check-.*\.js$/.test(f));
  assert.ok(gates.length >= 3, '找不到合併閘腳本＝這題變空包彈（命名改了？）');
  for (const f of gates) {
    assert.doesNotMatch(readFileSync(join(ROOT, 'scripts', f), 'utf8'), /pending-rulings/,
      `scripts/${f} 呼叫了這支＝它變成一道閘的一部分`);
  }
});

test('⭐ 驗收分級：這支是不需驗收那一級（新腳本沒進名單會被當未知→要重啟）', () => {
  assert.deepEqual(tierOf('scripts/pending-rulings.js'), { tier: 'E', known: true });
});
