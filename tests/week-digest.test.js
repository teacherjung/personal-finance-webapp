// 守本週成果產生器（規矩 J5）：最近七天合併進主幹的 PR 照日期列成共用進度摘要「本週成果」那一節的形狀；--write 只換那一節。
//
// 守得到的：
//   ①過濾：只算 merged_at 在窗內、底是主幹的；關掉沒合併的不算；窗的邊界（剛好 7 天前算，7 天又 1 秒前不算）；
//   ②日期用台北時間（UTC 10/08 17:00 ＝台北 10/09 01:00，歸 10/09）；
//   ③形狀：產出的那一節丟給進度摘要檢查是 0 條；日期新的在前；同一天照登記順序分專案、同專案照合併時間；標題裡的換行與多餘空白收掉；
//   ④--write 只換那一節：前後的節一個字不動、分隔線留著；沒有那一節＝退 2、檔案不動；
//   ⑤驗收留痕：用待裁清單工具同一套判斷（第一行「## ✅ 驗收（YYYY-MM-DD）：標題」、真的日曆日、原話那一行、登記的貼文帳號；前面有空行照認）；r1 R2；
//   ⑥指令入口：--repos 寫法錯、gh 退非零（就算 stdout 是合法 JSON）、回的不是 JSON＝退 2；假 gh 接住參數（固定 --hostname github.com、環境沒有 GH_HOST／GH_REPO／GIT_DIR）；
//     帶 --file 不帶 --write 只印、檔案一個位元組不動；--write 整份檔＝其餘的節原樣＋那一節換掉（逐字比）；問平台期間別人改了別的節，寫回時要留著（r1 R1）；
//     空的一週寫進去也要過進度摘要檢查（r1 R5）；
//   ⑦分頁：PR 清單第一頁滿 100 筆而且最舊那一筆還在窗內才翻下一頁；翻到上限還沒到邊界＝退 2 不寫（r1 R4）；留言讀齊每一頁（第二頁的驗收也算；r1 R3）。
// ⚠️ 守不到的：沒有 PR 的成果（手寫的）；標題寫得對不對；台北以外的時區；真的 gh 沒在考題裡跑（用假的）；驗收留痕的內容真不真。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mergedWithin, dayOf, render, replaceSection, acceptedDate, traceShape, parseArgs, DAYS, HEADING, MAX_PAGES } = require('../tools/week-digest.js');
const { deciderOf } = require('../tools/pending-rulings.js');
const { evaluate } = require('../tools/check-progress-summary.js');

const TOOL = path.join(__dirname, '..', 'tools', 'week-digest.js');
const NOW_ISO = '2026-10-09T10:00:00+08:00';
const NOW = Date.parse(NOW_ISO);
const pr = (number, mergedAt, over = {}) => ({ number, title: `第 ${number} 支`, merged_at: mergedAt, updated_at: mergedAt || '2026-10-09T00:00:00Z', base: { ref: 'main' }, ...over });

/** 一份最小的合格摘要：進行中一則、本週成果那一節放進去的行、附件一條。 */
function doc(weekLines) {
  return [
    '# 進度摘要', '', '## 全貌', '', '略', '', '---', '',
    '## 進行中的線', '',
    '### 套件｜某事｜施工中｜Claude・x',
    '- 他要的：甲', '- 做了什麼：乙', '- 到哪一步：已合併', '- 現在誰在動：Claude', '- 下一步是：丙', '- 動哪些檔：x', '- 證據：附件第 1 條。', '- 時間：整理 10/09 09:00；核實 10/09 09:00（核了）。', '',
    '---', '', '## 等裁示（只列有 ❓ 留痕的）', '', '沒有', '', '---', '',
    `${HEADING}（最近七天）`, '', ...weekLines, '', '---', '',
    '## 已結束（留 30 天）', '', '### 套件｜舊事｜已結束 10/01｜無永久決定', '', '---', '',
    '## 待辦', '', '略', '', '---', '',
    '## 附件（證據位置）', '', '1. https://github.com/acme/kit/pull/41', '',
  ].join('\n');
}

test('①過濾：窗內、合併進主幹的才算；邊界剛好 7 天算、多 1 秒不算；關掉沒合併、底不是主幹的不算', () => {
  const since = NOW - DAYS * 86400000;
  const list = [
    pr(1, new Date(NOW - 2 * 86400000).toISOString()),
    pr(2, new Date(since).toISOString()),
    pr(3, new Date(since - 1000).toISOString()),
    pr(4, null),
    pr(5, new Date(NOW - 86400000).toISOString(), { base: { ref: 'develop' } }),
  ];
  const got = mergedWithin(list, { nowMs: NOW, days: DAYS, mainBranch: 'main' });
  assert.deepEqual(got.map((x) => x.number), [1, 2]);
  assert.equal(got[0].mergedMs, NOW - 2 * 86400000);
  assert.deepEqual(mergedWithin([{ number: 9, title: 'x', merged_at: 'not a time', updated_at: 'x', base: { ref: 'main' } }], { nowMs: NOW, days: DAYS, mainBranch: 'main' }), [], 'merged_at 不是時間＝不算');
});

test('②日期用台北時間：UTC 10/08 17:00 歸 10/09，UTC 10/08 15:59 歸 10/08；跨年的 12/31 也照台北', () => {
  assert.equal(dayOf(Date.parse('2026-10-08T17:00:00Z')), '10/09');
  assert.equal(dayOf(Date.parse('2026-10-08T15:59:59Z')), '10/08');
  assert.equal(dayOf(Date.parse('2026-12-31T16:30:00Z')), '01/01');
});

test('③形狀：產出的那一節丟給進度摘要檢查 0 條；日期新的在前；同一天照登記順序分專案、同專案照合併時間；標題的換行收掉', () => {
  const items = [
    { alias: '理財', number: 700, title: '理財的事', mergedMs: Date.parse('2026-10-09T01:00:00+08:00'), accepted: null },
    { alias: '套件', number: 56, title: '七條待辦\n一起收  ', mergedMs: Date.parse('2026-10-09T01:39:00+08:00'), accepted: null },
    { alias: '套件', number: 51, title: '進度摘要檢查', mergedMs: Date.parse('2026-10-08T14:49:00+08:00'), accepted: '10/08' },
    { alias: '套件', number: 55, title: '再削一刀', mergedMs: Date.parse('2026-10-09T09:43:00+08:00'), accepted: null },
  ];
  const lines = render(items, { order: ['套件', '理財'] });
  assert.deepEqual(lines, [
    '- 10/09',
    '  - 套件：七條待辦 一起收——已合併（#56）',
    '  - 套件：再削一刀——已合併（#55）',
    '  - 理財：理財的事——已合併（#700）',
    '- 10/08',
    '  - 套件：進度摘要檢查——已合併（#51；10/08 已驗收）',
  ]);
  const r = evaluate(doc(lines), { now: { year: 2026, month: 10, day: 9 }, prStates: { 'acme/kit#41': { merged: true } } });
  assert.equal(r.unsure, null);
  assert.deepEqual(r.problems, [], '產出的形狀要過進度摘要檢查');
  const empty = render([], { nowMs: NOW, days: 7 });
  assert.deepEqual(empty, ['- 10/09', '  - 最近 7 天沒有合併進主幹的 PR'], 'r1 R5：空的一週也要是檢查認得的形狀（今天的日期行＋一個子項目）');
  assert.deepEqual(evaluate(doc(empty), { now: { year: 2026, month: 10, day: 9 }, prStates: { 'acme/kit#41': { merged: true } } }).problems, []);
});

test('④--write 只換那一節：前後的節一個字不動、分隔線留著；沒有那一節＝null', () => {
  const before = doc(['- 10/01', '  - 套件：舊的']);
  const after = replaceSection(before, ['- 10/09', '  - 套件：新的——已合併（#1）']);
  assert.ok(after.includes(`${HEADING}（最近七天）\n\n- 10/09\n  - 套件：新的——已合併（#1）\n\n---\n\n## 已結束`), after);
  assert.ok(!after.includes('舊的'));
  const head = (t) => t.slice(0, t.indexOf(HEADING));
  const tail = (t) => t.slice(t.indexOf('## 已結束'));
  assert.equal(head(after), head(before)); assert.equal(tail(after), tail(before));
  assert.equal(replaceSection(before.replace(HEADING, '## 本週'), ['- 10/09']), null, '找不到那一節＝不寫');
  assert.equal(replaceSection(`${before}\n${HEADING}（又一次）\n`, ['- 10/09']), null, '那一節出現兩次＝不寫（不知道換哪一個）');
});

const SETTINGS = { participants: [{ role: '裁示者（人）', id: 'William', account: 'owner-acct' }, { role: 'AI 甲', id: 'Claude', account: 'owner-acct' }] };
const DECIDER = deciderOf(SETTINGS);
const comment = (body, over = {}) => ({ id: 1, user: { login: 'owner-acct' }, body, created_at: '2026-10-08T01:00:00Z', ...over });
const OK_BODY = '## ✅ 驗收（2026-10-08）：總覽那塊\n\n原話（對話中，Claude 轉述）：**「可以了」**\n\n照「怎麼驗收」第 1 步看過。';

test('⑤驗收留痕用待裁清單工具同一套判斷：合規才算、取最後一則；缺原話、沒登記的帳號、假日期、格式示例、不在第一行都不算；前面空行照認', () => {
  const shape = (list) => list.map((c, k) => traceShape({ ...c, id: k + 1 }, 41));
  assert.equal(acceptedDate(shape([comment(OK_BODY)]), DECIDER), '10/08');
  assert.equal(acceptedDate(shape([comment(`\n${OK_BODY}`)]), DECIDER), '10/08', '前面有空行的合規留痕照認（跟既有解析器一樣）');
  assert.equal(acceptedDate(shape([comment('## ✅ 驗收（2026-10-08）：沒有原話那一行\n\n看過了。')]), DECIDER), null, '缺原話那一行＝不算');
  assert.equal(acceptedDate(shape([comment(OK_BODY, { user: { login: 'stranger' } })]), DECIDER), null, '沒登記的帳號貼的＝不算');
  assert.equal(acceptedDate(shape([comment(OK_BODY.replace('2026-10-08', '2026-99-88'))]), DECIDER), null, '不是真的日子＝不算');
  assert.equal(acceptedDate(shape([comment('## ✅ 驗收（2026-10-08）這是格式示例，尚未驗收\n\n原話（對話中，Claude 轉述）：**「x」**')]), DECIDER), null, '標題前沒有「：」＝形狀不合');
  assert.equal(acceptedDate(shape([comment(`說明\n${OK_BODY}`)]), DECIDER), null, '標題不在第一個非空行＝不算');
  assert.equal(acceptedDate(shape([comment(OK_BODY.replace('2026-10-08', '2026-10-07'), { created_at: '2026-10-07T01:00:00Z' }), comment(OK_BODY)]), DECIDER), '10/08', '幾則都合規取最後一則（照留言時間）');
  assert.equal(acceptedDate([], DECIDER), null);
  assert.throws(() => acceptedDate(shape([comment(OK_BODY, { created_at: 'no time' })]), DECIDER), /判不了/u, '留言時間讀不出＝不猜');
});

test('⑥⑦指令入口：假 gh 接住參數與環境；只印不改檔；--write 整份逐字比、別人同時改的節留著；空週；留言第二頁的驗收；PR 翻頁與上限；寫法錯、gh 失敗、不是 JSON＝退 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'week-digest-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const record = path.join(dir, 'record.json');
  const settingsFile = path.join(dir, 'settings.json'); fs.writeFileSync(settingsFile, JSON.stringify(SETTINGS));
  const page1 = Array.from({ length: 100 }, (_, i) => pr(1000 + i, new Date(NOW - (i + 1) * 3600000).toISOString()));
  const page2 = [pr(2, new Date(NOW - 2 * 86400000).toISOString()), pr(3, new Date(NOW - 30 * 86400000).toISOString())];
  fs.writeFileSync(path.join(dir, 'page1.json'), JSON.stringify(page1));
  fs.writeFileSync(path.join(dir, 'page2.json'), JSON.stringify(page2));
  // #2 的驗收留痕在留言第二頁（第一頁是 100 則一般留言）；#1000 第一頁就有一則不合規的（沒登記的帳號）
  fs.writeFileSync(path.join(dir, 'comments-2-p1.json'), JSON.stringify(Array.from({ length: 100 }, (_, k) => comment(`一般留言 ${k}`, { id: k + 1 }))));
  fs.writeFileSync(path.join(dir, 'comments-2-p2.json'), JSON.stringify([comment(OK_BODY, { id: 999 })]));
  fs.writeFileSync(path.join(dir, 'comments-1000.json'), JSON.stringify([comment(OK_BODY, { user: { login: 'stranger' } })]));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
node -e '
const fs = require("fs"); const a = process.argv.slice(1); const rec = ${JSON.stringify(record)}; const dir = ${JSON.stringify(dir)};
const all = fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, "utf8")) : [];
all.push({ args: a, env: { GH_HOST: process.env.GH_HOST, GH_REPO: process.env.GH_REPO, GIT_DIR: process.env.GIT_DIR } });
fs.writeFileSync(rec, JSON.stringify(all));
const url = a[a.length - 1];
if (process.env.FAKE_GH_FAIL === "1") { process.stdout.write("[]"); process.stderr.write("boom"); process.exit(1); }
if (process.env.FAKE_GH_GARBAGE === "1") { process.stdout.write("not json"); process.exit(0); }
if (process.env.FAKE_GH_TOUCH && url.includes("/pulls?")) { const f = process.env.FAKE_GH_TOUCH; fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("A-專用值", "B-專用值")); }
if (url.includes("/pulls?")) {
  if (process.env.FAKE_GH_EMPTY === "1") { process.stdout.write("[]"); process.exit(0); }
  if (process.env.FAKE_GH_COMMENTS_ENDLESS === "1") { process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(dir + "/page2.json", "utf8")).slice(0, 1))); process.exit(0); }
  if (process.env.FAKE_GH_ENDLESS === "1") { process.stdout.write(fs.readFileSync(dir + "/page1.json", "utf8")); process.exit(0); }
  process.stdout.write(fs.readFileSync(dir + (url.includes("page=2") ? "/page2.json" : "/page1.json"), "utf8")); process.exit(0);
}
if (process.env.FAKE_GH_COMMENTS_ENDLESS === "1" && url.includes("/comments")) { process.stdout.write(fs.readFileSync(dir + "/comments-2-p1.json", "utf8")); process.exit(0); }
if (url.includes("/issues/2/comments")) { process.stdout.write(fs.readFileSync(dir + (url.includes("page=2") ? "/comments-2-p2.json" : "/comments-2-p1.json"), "utf8")); process.exit(0); }
if (url.includes("/issues/1000/comments")) { process.stdout.write(fs.readFileSync(dir + "/comments-1000.json", "utf8")); process.exit(0); }
if (url.includes("/comments")) { process.stdout.write("[]"); process.exit(0); }
process.stderr.write("unexpected " + url); process.exit(3);
' -- "$@"
`, { mode: 0o755 });
  const env = (extra = {}) => ({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_HOST: 'evil.test', GH_REPO: 'x/y', GIT_DIR: '/nope', ...extra });
  const base = ['--repos', '套件=acme/kit', '--now', NOW_ISO, '--settings', settingsFile];
  const cli = (args, extra) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extra) });
  // 只印
  const r = cli(base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], '- 10/09');
  assert.ok(lines.includes('  - 套件：第 2 支——已合併（#2；10/08 已驗收）'), `留言第二頁的驗收也要算：${r.stdout}`);
  assert.ok(lines.includes('  - 套件：第 1000 支——已合併（#1000）'), '沒登記的帳號貼的驗收不算');
  assert.ok(!r.stdout.includes('#3'), '30 天前的不算');
  assert.equal(lines.filter((l) => l.startsWith('  - ')).length, 101, '第一頁 100 筆全在窗內、第二頁 1 筆在窗內');
  const calls = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.deepEqual(calls[0].args.slice(0, 3), ['api', '--hostname', 'github.com']);
  assert.ok(calls[0].args[calls[0].args.length - 1].startsWith('repos/acme/kit/pulls?state=closed'), calls[0].args.join(' '));
  assert.ok(calls.some((c) => c.args[c.args.length - 1].includes('/pulls?') && c.args[c.args.length - 1].includes('page=2')), '⑦第一頁滿 100 筆且最舊的還在窗內要翻第二頁');
  assert.ok(calls.some((c) => c.args[c.args.length - 1].includes('/issues/2/comments') && c.args[c.args.length - 1].includes('page=2')), '留言第一頁滿 100 則要翻第二頁');
  assert.deepEqual(calls[0].env, {}, '選主機、選倉庫、指向別倉庫的變數要先清掉（假 gh 記的是它看到的值，沒有＝JSON 裡沒有那個鍵）');
  assert.match(r.stderr, /101 支/u);
  // 帶 --file 不帶 --write：只印，檔案一個位元組不動
  const file = path.join(dir, 'summary.md');
  const original = doc(['- 10/01', '  - 套件：舊的']).replace('## 全貌\n\n略', '## 全貌\n\nA-專用值');
  fs.writeFileSync(file, original);
  const ro = cli([...base, '--file', file, '--no-acceptance']);
  assert.equal(ro.status, 0, ro.stdout + ro.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), original, '不帶 --write 不可以動檔');
  // --write：整份檔逐字＝（別人在問平台期間改過的）原檔只換那一節；全貌的新值要留著（r1 R1）
  const w = cli([...base, '--file', file, '--write', '--no-acceptance'], { FAKE_GH_TOUCH: file });
  assert.equal(w.status, 0, w.stdout + w.stderr);
  const written = fs.readFileSync(file, 'utf8');
  assert.ok(written.includes('B-專用值') && !written.includes('A-專用值'), '問平台期間別人改的全貌要留著，不可以被舊快照蓋掉');
  const printed = cli([...base, '--no-acceptance']).stdout.trim().split('\n');
  assert.equal(written, replaceSection(original.replace('A-專用值', 'B-專用值'), printed), '整份檔＝其餘的節原樣＋那一節換成印出來的行');
  const r2 = evaluate(written, { now: { year: 2026, month: 10, day: 9 }, prStates: { 'acme/kit#41': { merged: true } } });
  assert.deepEqual(r2.problems, []);
  // 空的一週寫進去也要過檢查（r1 R5）
  const emptyFile = path.join(dir, 'empty.md'); fs.writeFileSync(emptyFile, original);
  const we = cli([...base, '--file', emptyFile, '--write', '--no-acceptance'], { FAKE_GH_EMPTY: '1' });
  assert.equal(we.status, 0, we.stdout + we.stderr);
  const emptyWritten = fs.readFileSync(emptyFile, 'utf8');
  assert.ok(emptyWritten.includes('- 10/09\n  - 最近 7 天沒有合併進主幹的 PR'), emptyWritten);
  assert.deepEqual(evaluate(emptyWritten, { now: { year: 2026, month: 10, day: 9 }, prStates: { 'acme/kit#41': { merged: true } } }).problems, []);
  // 翻到上限還沒到邊界＝退 2、不寫（r1 R4）
  const capFile = path.join(dir, 'cap.md'); fs.writeFileSync(capFile, original);
  const cap = cli([...base, '--file', capFile, '--write', '--no-acceptance'], { FAKE_GH_ENDLESS: '1' });
  assert.equal(cap.status, 2, `每一頁都滿且都在窗內，翻到 ${MAX_PAGES} 頁要退 2：${cap.stdout}${cap.stderr}`);
  assert.match(cap.stderr, /不完整/u);
  assert.equal(fs.readFileSync(capFile, 'utf8'), original, '退 2 時檔案不動');
  // 留言翻到上限還沒讀完＝退 2、不猜驗收、不寫（r2 R7：這條出口以前沒有考題守）
  const capFile2 = path.join(dir, 'cap2.md'); fs.writeFileSync(capFile2, original);
  fs.writeFileSync(record, '[]');
  const cap2 = cli([...base, '--file', capFile2, '--write'], { FAKE_GH_COMMENTS_ENDLESS: '1' });
  assert.equal(cap2.status, 2, `留言每一頁都滿、翻到 ${MAX_PAGES} 頁要退 2：${cap2.stdout}${cap2.stderr}`);
  assert.match(cap2.stderr, /不猜驗收/u);
  assert.equal(fs.readFileSync(capFile2, 'utf8'), original, '退 2 時檔案不動');
  const commentCalls = JSON.parse(fs.readFileSync(record, 'utf8')).filter((c) => c.args[c.args.length - 1].includes('/comments'));
  assert.equal(commentCalls.length, MAX_PAGES, '真的翻到了上限那一頁才放棄');
  // 退 2 的幾種
  const noSection = path.join(dir, 'no-section.md');
  fs.writeFileSync(noSection, doc(['- 10/01']).replace(HEADING, '## 本週'));
  assert.equal(cli([...base, '--file', noSection, '--write', '--no-acceptance']).status, 2, '沒有那一節＝退 2');
  assert.ok(fs.readFileSync(noSection, 'utf8').includes('- 10/01'), '退 2 時檔案不動');
  assert.equal(cli(['--repos', 'kit', '--now', NOW_ISO]).status, 2, '--repos 寫法錯');
  assert.equal(cli(['--now', NOW_ISO]).status, 2, '沒有 --repos');
  assert.equal(cli(['--repos', '套件=acme/kit', '--now', 'yesterday']).status, 2, '--now 寫法錯');
  const fail = cli(base, { FAKE_GH_FAIL: '1' });
  assert.equal(fail.status, 2, 'gh 退非零＝退 2，就算 stdout 是合法的 []');
  assert.equal(cli(base, { FAKE_GH_GARBAGE: '1' }).status, 2, '回的不是 JSON');
  assert.equal(cli(['--repos', '套件=acme/kit', '--now', NOW_ISO, '--settings', path.join(dir, 'unfilled.json')]).status, 2, '設定讀不到＝退 2');
  fs.writeFileSync(path.join(dir, 'unfilled.json'), JSON.stringify({ participants: [{ role: '裁示者（人）', id: '未設定', account: '未設定' }] }));
  assert.equal(cli(['--repos', '套件=acme/kit', '--now', NOW_ISO, '--settings', path.join(dir, 'unfilled.json')]).status, 2, '裁示者沒填＝判不了驗收、退 2');
  assert.deepEqual(parseArgs(['--repos', '套件=acme/kit,理財=acme/money']).repos, Object.assign(Object.create(null), { 套件: 'acme/kit', 理財: 'acme/money' }));
});
