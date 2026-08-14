// @ts-check
// 複審聯集閘的**真 CLI 出口**考題（2026-08-02，#385 r2 依 Codex r1 Medium③ 補）。
//
// ⚠️ 為什麼非要另開一支測 CLI：r1 的 12 題全部只測純函式，
// Codex 把 `main()` 阻擋分支的 `return 1` 突變成 `return 0`——**12/12 照樣全綠**，
// 而實跑會「終端印出未通過、退出碼卻是 0」。掛進合併程序就是一道永遠放行的假閘。
//
// **退出碼才是這支腳本對外的介面**，不是它的內部函式。
// 判準用假 `gh` 子行程走完整入口（比照 `test/merge-gate.test.js` 的做法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/check-review-verdicts.js');
const HEAD = 'aabbccdd11223344556677889900aabbccddeeff';

/** 造一支假的 `gh`，讓腳本走完整的真實路徑（不是 stub 掉它的內部函式）。 @param {string} stdout */
function withFakeGh(stdout, { exitCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${exitCode}\n`);
  chmodSync(gh, 0o755);
  return spawnSync(process.execPath, [SCRIPT, '385'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

/** @param {string} src @param {number} round @param {string} verdict */
const header = (src, round, verdict, sha = HEAD.slice(0, 7)) =>
  `🤖 Claude｜來源：${src}｜審 ${sha}｜r${round}｜結論：${verdict}`;
/** PR 說明：宣告獨立審查者是 Claude（放行只認這個角色——見 r3 High①）。 */
const PR_BODY = ['- **實作者**：Codex', '- **獨立審查者**：Claude'].join('\n');
const payload = (/** @type {string[]} */ bodies, prBody = PR_BODY) =>
  JSON.stringify({ comments: bodies.map((b) => ({ body: b })), headRefOid: HEAD, body: prBody });

test('CLI｜有人對目前 head 說「通過」、沒有未撤銷的阻擋 → exit 0', () => {
  const r = withFakeGh(payload([header('桌面 A', 1, '通過')]));
  assert.equal(r.status, 0, `預期 0，實得 ${r.status}\n${r.stdout}${r.stderr}`);
});

test('⭐ CLI｜有未撤銷的阻擋 → exit **1**（r1 把 return 1 改成 0，12 題全綠）', () => {
  const r = withFakeGh(payload([
    header('桌面 A', 1, '需修改後再審'),
    header('桌面 B', 1, '通過'),
  ]));
  assert.equal(r.status, 1, `預期 1，實得 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /未通過/);
});

test('CLI｜完全沒有正式結論 → exit 1（不是放行）', () => {
  const r = withFakeGh(payload(['這支等 #382 合併之後再 rebase']));
  assert.equal(r.status, 1, `「沒人審」被放行了——那比 main 原本的人工確認還退步。實得 ${r.status}`);
  assert.match(r.stderr, /下過「通過」的正式結論/);
});

test('CLI｜gh 失敗 → exit 2（fail-closed）', () => {
  const r = withFakeGh('{}', { exitCode: 1 });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

test('CLI｜gh 回傳不是 JSON → exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, '#!/bin/sh\necho "not json"\n');
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, '385'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

test('CLI｜gh 回傳形狀不對（缺 headRefOid／缺 body）→ exit 2', () => {
  const r = withFakeGh(JSON.stringify({ comments: [] }));
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

test('CLI｜沒給 PR 編號 → exit 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}`);
});

test('⭐ CLI｜實作者自己的「通過」→ exit 1（放行只認指定的獨立審查者）', () => {
  const r = withFakeGh(payload([header('桌面 A', 1, '通過')],
    ['- **實作者**：Claude', '- **獨立審查者**：Codex'].join('\n')));
  assert.equal(r.status, 1, `實作者自己放行了自己的 PR。實得 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /指定的獨立審查者/);
});

test('⭐ CLI｜疑似結論卻沒標頭 → **exit 0＋stderr 有提醒**（r11 的裁定要有出口題鎖住）', () => {
  // ⚠️ Codex #385 r12 High②：在 warning 分支塞一個 `return 1`，83 題相關考題**全綠**——
  //    也就是 r11 剛裁定的「warning 不阻擋」隨時可能被改回阻擋而沒有人發現。
  //    **退出碼是這支對外的介面，純函式測不到它。**
  const r = withFakeGh(payload([
    header('桌面 A', 1, '通過'),                       // 指定審查者的合規通過
    '## Claude 複審\n\n結論：通過，可以合併。',          // 疑似結論、沒有標頭 ⇒ 只該提醒
  ]));
  assert.equal(r.status, 0,
    `疑似結論卻沒標頭把合併擋下來了——那是 r11 明確裁掉的行為。實得 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /不影響本閘結果/, `沒有印出提醒：${r.stderr}`);
});

test('⭐ CLI｜🤖 記號在、標頭寫壞 → exit 1（唯一還阻擋的文字判斷）', () => {
  const r = withFakeGh(payload([
    header('桌面 A', 1, '通過'),
    '🤖 Claude｜來源：桌面｜審 abc1234｜r1｜結論：通過了',   // 結論用詞不是三選一
  ]));
  assert.equal(r.status, 1, `標頭寫壞沒有被擋。實得 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /🤖 記號、但標頭格式不合規/);
});

test('⭐ CLI｜**同時有 warning 與真正的阻擋** → 仍然 exit 1（warning 不可以壓掉阻擋）', () => {
  // ⚠️ Codex #385 r13 Medium：在 warning 印完之後塞一個 `return 0`，CLI 10/10 仍全綠。
  //    也就是「疑似結論但沒標頭」這件事，反而可能把**別人正式的阻擋**一起吃掉——
  //    方向剛好跟 r11 的裁定相反，而且沒有任何一題看得到。
  const r = withFakeGh(payload([
    header('桌面 A', 1, '通過'),                        // 指定審查者：通過
    header('桌面 B', 1, '不可合併'),                     // 另一位：正式阻擋（合規標頭）
    '## Claude 複審\n\n結論：通過，可以合併。',           // 疑似結論、沒標頭 ⇒ 只該提醒
  ]));
  assert.equal(r.status, 1,
    `warning 把正式阻擋壓掉了。實得 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /不影響本閘結果/, '提醒不見了');
  assert.match(r.stderr, /未通過/, '正式阻擋的訊息不見了');
});

test('⭐ CLI｜兩個來源長得像 → **stderr 有提醒、退出碼不變**（#453：提醒不是阻擋、也不是自動併身分）', () => {
  // 2026-08-14 #453：同一個 codex CLI 的來源被打成兩種寫法，閘把他拆成兩位審查者、擋了兩次，
  // 而終端輸出沒有任何一句話說「這兩個可能是同一位」——現場只看得到兩個名字。
  // ⚠️ 退出碼是這支對外的介面：提醒實作成阻擋（或實作成自動併身分）都要在這裡看得見。
  const r = withFakeGh(payload([
    header('CLI（gpt-5.6-sol xhigh）', 8, '通過'),
    header('codex CLI (gpt-5.6-sol, xhigh)', 9, '通過'),
  ]));
  assert.equal(r.status, 0, `相似提醒把合併擋下來了。實得 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /可能是同一位審查者被打成兩種寫法/, `沒印出提醒：${r.stderr}`);
  assert.match(r.stderr, /不影響本閘結果/, '提醒要標明它不影響判定');
});
