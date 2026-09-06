// 待裁清單（scripts/pending-rulings.js）的行為題。
// 為什麼要有：這支的用途是「開工時提醒還有哪些問題他沒回」，而它最貴的失敗是**靜靜印出「沒有還沒回的」**——
// 配對錯、標頭差一個字、掃到別的 repo、分頁被截斷、外人偽造裁示留言，五種情況的輸出都會長得一樣。
// 所以這裡釘的不只是「找得到」，還有「找不到的時候看得出來」。
// ⚠️ **每一題跑 CLI 都要用假 gh 遮住**：CI 的 npm test 沒有 GitHub 權杖，忘了遮的題本機綠、到 CI 才紅。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
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

/** 一則留言夾具。預設是 repo 擁有者貼的（三種留痕留言都必須是）。 */
function c({ id, body, at = T0, edited = false, pr = 100, assoc = 'OWNER' }) {
  return {
    id, body, author_association: assoc,
    created_at: iso(at), updated_at: iso(edited ? at + 60_000 : at),
    html_url: `https://github.com/o/r/pull/${pr}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/o/r/issues/${pr}`,
  };
}
const ask = (/** @type {any} */ o) => c({ body: `## ❓ 待裁（2026-09-01）：${o.q ?? '要不要做這件事？'}\n選項…`, ...o });
const ruling = (/** @type {any} */ o) => c({ body: `## ⚖️ William 裁示（2026-09-02）：答覆\n關的是 ${o.cites ?? ''}`, ...o });
const timeout = (/** @type {any} */ o) => c({ body: `## ⏳ 逾時暫定（2026-09-04）：同一句問題\n❓ 留言：${o.cites ?? ''}`, ...o });

test('沒有任何裁示留言 → 那則問題列在「還沒回」', () => {
  const r = classify([ask({ id: 1 })], T0 + 3600e3);
  assert.equal(r.pending.length, 1);
  assert.equal(r.closed.length + r.provisional.length, 0);
  assert.equal(r.pending[0].title, '要不要做這件事？');
});

test('⭐ 跨 PR 才關得掉：問題貼在 A 支、裁示貼在 B 支並引了它的網址 → 已結（只看同一支會永遠關不掉）', () => {
  // 真語料：#577 的兩則 ❓ 是被 #578 上那則 ⚖️ 關掉的。
  const a = ask({ id: 1, pr: 577 });
  const b = ruling({ id: 2, pr: 578, at: T0 + 7200e3, cites: '#issuecomment-1' });
  const r = classify([a, b], T0 + 3 * 86400e3);
  assert.deepEqual(r.pending, []);
  assert.equal(r.closed.length, 1);
  assert.equal(r.closed[0].closedBy[0].url, b.html_url, '要附上配對連結，配錯了才看得出來');
});

test('⭐ 裁示早於問題不算關：同一支上先有一則答別題的裁示、之後才貼問題 → 仍未結', () => {
  const old = ruling({ id: 1, at: T0 - 86400e3, cites: '#issuecomment-2' });
  const a = ask({ id: 2 });
  const r = classify([old, a], T0 + 3600e3);
  assert.equal(r.pending.length, 1, '較早的裁示不可能在回答還沒問的問題');
});

test('⭐ 引用編號要卡右邊界：引 #issuecomment-10 不算關掉 1（先證明沒卡邊界的寫法真的會中）', () => {
  const a = ask({ id: 1 });
  const b = ruling({ id: 2, at: T0 + 60e3, cites: '#issuecomment-10' });
  assert.ok(String(b.body).includes('#issuecomment-1'), '對照斷言：沒卡右邊界的 includes 真的會命中，這題才有意義');
  assert.equal(classify([a, b], T0 + 3600e3).pending.length, 1);
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
  for (const head of [withVS, without]) assert.equal(shapeOf({ body: `${head}\n略` }), 'ruling', head);
});

test('⭐ 時限邊界：71 小時 59 分未逾時、72 小時整逾時（現在時刻由參數注入，不看牆上時鐘）', () => {
  const at = T0;
  const before = classify([ask({ id: 1, at })], at + (71 * 60 + 59) * 60e3);
  const after = classify([ask({ id: 1, at })], at + 72 * 3600e3);
  assert.equal(before.pending[0].overdue, false);
  assert.equal(after.pending[0].overdue, true);
  assert.equal(TIMEOUT_HOURS, 72);
});

test('⭐ 時限常數綁回規則正本：AGENTS 那顆寫「時限＝三天」，這裡就必須是 72 小時', () => {
  // 沒有這一題的話，William 哪天把三天改成五天，AGENTS 改了、工具照舊按 72 小時印「已經超過時限」，全卷還是綠的。
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const m = agents.match(/時限＝\*\*(.)天\*\*/);
  assert.ok(m, 'AGENTS 的「時限＝**N 天**」找不到——規則正本改寫法了，這題與工具的常數要一起改');
  const days = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 }[m[1]];
  assert.ok(days, `讀不出天數：${m[1]}`);
  assert.equal(TIMEOUT_HOURS, days * 24, `規則正本寫 ${m[1]} 天、工具卻用 ${TIMEOUT_HOURS} 小時`);
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
  const t = timeout({ id: 2, at: T0 + 4 * 86400e3, cites: '#issuecomment-1' });
  const r = classify([a, t], T0 + 5 * 86400e3);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.closed, []);
  assert.equal(r.provisional.length, 1);
  assert.match(render(r, { host: 'github.com', slug: 'o/r', expected: 2 }), /已照預設先做、他還沒裁/);
});

test('⭐ 只有 repo 擁有者貼的才算：外人貼的裁示留言關不掉問題，而且會被列進「形狀不合」讓人看見', () => {
  // repo 是公開的，任何人都能貼一則第一行合規的留言；配對若不看作者，一則活著的問題會被靜靜吞掉。
  const a = ask({ id: 1 });
  const outsider = ruling({ id: 2, at: T0 + 3600e3, cites: '#issuecomment-1', assoc: 'NONE' });
  const r = classify([a, outsider], T0 + 4 * 86400e3);
  assert.equal(r.pending.length, 1);
  assert.equal(r.near.length, 1);
  assert.match(r.near[0].why, /不是 repo 擁有者/);
});

test('⭐ 已結的一定印出來（附配對連結）：「沒有還沒回的」必須是看得到證據的結論，不是沉默', () => {
  const a = ask({ id: 1 });
  const b = ruling({ id: 2, at: T0 + 3600e3, cites: '#issuecomment-1' });
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

test('⭐ 天數不看日曆日，所以時區換了答案不變（先證明日曆日寫法真的會因時區而不同）', () => {
  const at = T0 + 20 * 3600e3;           // UTC 9/1 20:00＝台北 9/2 04:00（日曆日已經跨過去了）
  const now = at + 77 * 3600e3;          // 77 小時後：不是 24 的倍數，日曆日寫法在兩個時區會給出不同天數
  const calDays = (/** @type {number} */ t, /** @type {number} */ offsetH) => Math.floor((t + offsetH * 3600e3) / 86400e3);
  assert.notEqual(calDays(now, 0) - calDays(at, 0), calDays(now, 8) - calDays(at, 8),
    '對照斷言：這組夾具用日曆日相減，UTC 與 +08:00 真的會給出不同天數——這題才有鑑別力');
  assert.equal(classify([ask({ id: 1, at })], now).pending[0].hours, 77, '我們用的是兩個時間點相減，跟時區無關');
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
    assert.match(r.stderr, /清單不完整/);
    assert.doesNotMatch(r.stdout, /還沒回的問題/);
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

test('⭐ CLI｜--pr 一樣掃全庫：別支的裁示照樣關得掉，別支的問題不會混進來', () => {
  const a = ask({ id: 1, pr: 577 });
  const b = ruling({ id: 2, pr: 578, at: T0 + 3600e3, cites: '#issuecomment-1' });
  const other = ask({ id: 3, pr: 500 });
  withFakeGh({ issues: ISSUES(3), comments: pages([a, b, other]), args: ['--pr', '577'] }, ({ r }) => {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /還沒回的問題：沒有/, '#578 上的裁示要能關掉 #577 的問題');
    assert.match(r.stdout, /我判定已結的：1 則/);
    assert.doesNotMatch(r.stdout, /issuecomment-3/, '別支的問題不可以混進來');
  });
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

test('⭐ 這支不是閘：合併步驟一個字都不提它（反查器看不到 --all／--pr 這種形狀，所以直接掃）', () => {
  // test/helpers/merge-gates.js 的反查器只認 `node scripts/x.js <N>`，這支的兩種呼叫形狀它都看不到，
  // 所以「不在閘名單裡」那種寫法對這支永遠不會紅——改成直接檢查合併步驟沒提到它。
  const doc = readFileSync(join(ROOT, 'REVIEW-AND-MERGE.md'), 'utf8');
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => /^> 1\.\s/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^確認遠端分支已刪除|^## /.test(l));
  assert.ok(start >= 0, '找不到合併步驟');
  assert.doesNotMatch(lines.slice(start, end < 0 ? undefined : end).join('\n'), /pending-rulings/,
    '合併步驟提到這支＝它變成流程的一環（pre-push 那種「非零就擋」的地方會讓退出碼 2 變成擋人）');
});

test('⭐ 驗收分級：這支是不需驗收那一級（新腳本沒進名單會被當未知→要重啟）', () => {
  assert.deepEqual(tierOf('scripts/pending-rulings.js'), { tier: 'E', known: true });
});
