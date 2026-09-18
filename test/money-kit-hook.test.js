/**
 * 「套件那一組錢攔截器」考題（2026-09-16，搬家第 3 步 B 支）
 *
 * 這一支把協作套件的禁區攔截器接到 `.claude/settings.json`：2026-09-16（搬家第 3 步 B 支）起跟原本那組 python v6 **並存**，
 * 2026-09-18（第 8 步，William 裁第 15 題 a：兩層考題都綠、並存一個完整變更週期無誤擋才拆）拆掉 python 那組，從此**剛好一組**。
 * 既有的 `test/money-boundary.test.js` 對每一組做「matcher 接得住 ∧ handler 實跑回 deny」的逐名配對，
 * 拒絕面只要求「至少一組擋」（並存期 v6 擋住了就算過，新那組漏一筆也看不出來——Codex #608 r1 B1 實測）；
 * 現在只剩一組，那兩面在那支考題裡已經等於只考這一組；這支仍把共用字表的**整張矩陣單獨跑在這一組上**（判準寫在這裡、不借別題）：
 *
 *   ⓪共用字表（`test/helpers/money-family-probes.js`，位元組由另一支考題釘著）裡該擋的每一筆、該放的每一筆、
 *     壞輸入的每一筆，**只餵這一組**；matcher 射程外的名字確認 matcher 不接。
 *   ①這一組的接線**整組逐字等於**套件範本 `templates/hook-claude.json`（matcher、hooks 的每一格含 type），
 *     而且 PreToolUse **剛好一組**（第 8 步起）——多一組或漂了就紅（範本改了就要同支換進來，驗收分級 F 第②類）；
 *   ②**理由形狀**：測試鈕 `mcp__guard_canary__ping` 被擋、理由開頭是「錢的絕對邊界：」、含「在拒絕清單上」——
 *     安裝說明第⑤步認這句，William 在真的對話裡看到它就知道是這一組擋的；真下單工具也擋、無害工具放行；
 *   ③新那組**不靠啟動目錄**：從專案子目錄起、平台的專案目錄變數指到別處，照樣擋（它先清 GIT_ 再問
 *     版本控制根目錄，2026-09-16 實測平台變數跟著啟動目錄走）；找不到 node 時退 2 帶錯誤輸出（全擋、看得見）。
 *
 * ⚠️ 誠實劃界：這裡是用 shell 模擬鉤子的呼叫（跟 money-boundary 同一招），**不是真的 Claude session**——
 *   設定有沒有被載入、鉤子在真環境找不找得到 node，只有 William 在真的對話裡按一次測試鈕才算數
 *  （預期：被擋、理由指名「在拒絕清單上」；再叫一個平常會用的工具要照常能用）。
 *   這一組讀的是這棵樹的 `settings.json`（改檔、切分支下一次呼叫就生效）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  FORBIDDEN_TOOLS, FORBIDDEN_AFTER_RECONNECT, FORBIDDEN_FAMILY, ALLOWED_LOOKALIKES, EXPECTED_ALLOWED_COUNT,
  IN_MATCHER_DENY, EXPECTED_IN_MATCHER_DENY, HANDLER_ONLY_DENY, EXPECTED_HANDLER_ONLY_DENY, OUT_OF_MATCHER, EXPECTED_OUT_OF_MATCHER,
  MONEY_SERVER, MONEY_SERVER_DENY, EXPECTED_MONEY_SERVER_DENY, MONEY_SERVER_ALLOW, EXPECTED_MONEY_SERVER_ALLOW,
  MONEY_SERVER_MULTISEG_DENY, EXPECTED_MONEY_SERVER_MULTISEG_DENY, MONEY_SERVER_MULTISEG_ALLOW, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW,
} from './helpers/money-family-probes.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const settings = JSON.parse(read('.claude/settings.json'));
const groups = settings.hooks.PreToolUse;
const template = JSON.parse(read('templates/hook-claude.json')).hooks.PreToolUse[0];
const CANARY = 'mcp__guard_canary__ping';
/** 一個沒有任何規則會擋的名字（跟 money-boundary 的良性樣本同一類），當「新那組不是全擋」的對照。 */
const HARMLESS = 'mcp__other__get_widget';
const kitGroup = groups.find((g) => g.hooks?.[0]?.command === template.hooks[0].command);

/** 照鉤子的起法跑一組：bash -c，標準輸入原樣給（壞輸入那幾筆不是合法 JSON，所以這一層不包 JSON）。 */
function runRaw(group, stdinText, { cwd = ROOT, env = {} } = {}) {
  const clean = { ...process.env };
  delete clean.CLAUDE_PROJECT_DIR;
  // 用絕對路徑起 shell：③會把 PATH 指到不存在的地方（模擬找不到 node），shell 自己不能因此起不來
  return spawnSync('/bin/bash', ['-c', group.hooks[0].command], {
    cwd, env: { ...clean, ...env }, input: stdinText, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
  });
}
/** 同上，但標準輸入是平台會給的 JSON（工具名）。 */
const run = (group, toolName, opts) => runRaw(group, JSON.stringify({ tool_name: toolName, tool_input: {} }), opts);
const denyReason = (r, why) => {
  assert.equal(r.status, 0, `${why}：退出碼 ${r.status}（${r.stderr.slice(0, 200)}）`);
  const d = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(d.permissionDecision, 'deny', why);
  assert.equal(d.hookEventName, 'PreToolUse', why);
  return d.permissionDecisionReason;
};
const allows = (r, why) => assert.deepEqual([r.status, r.stdout.trim()], [0, ''], `${why}：該放行的沒放行（${r.stderr.slice(0, 200)}）`);

test('①PreToolUse 剛好一組、逐字等於套件範本（第 8 步起：python v6 那組已拆）', () => {
  assert.equal(groups.length, 1, `PreToolUse 要剛好一組（拿到 ${groups.length}）——多出來的那組要先在這裡說清楚是什麼`);
  assert.ok(kitGroup, '找不到指令逐字等於套件範本的那一組：範本改了就要同支換進來');
  assert.ok(!groups.some((g) => typeof g.hooks?.[0]?.command === 'string' && g.hooks[0].command.startsWith('python3 -c')), 'python v6 那組跑回來了（第 8 步已拆）');
  // 整組逐字比（不只比指令）：hooks 的 type 不是 command 就不是有效接線，只比鍵名看不出來（Codex #608 r1 B2）
  assert.deepEqual(kitGroup, { matcher: template.matcher, hooks: template.hooks }, '套件那組要整組等於範本（matcher、type、command；範本的說明鍵不要抄）');
  assert.equal(template.hooks[0].type, 'command', '範本的 hook 型別變了：這題的前提要重看');
  assert.ok(existsSync(path.join(ROOT, 'tools', 'forbidden-tools.js')), '套件的判斷程式不在：這組會退 2 全擋');
});

test('⓪共用字表的整張矩陣只餵套件那組：該擋的都擋、該放的都放、壞輸入也擋', () => {
  // 數量釘：字表被縮短了要有意識地改（跟既有兩卷同一套）
  assert.equal(ALLOWED_LOOKALIKES.length, EXPECTED_ALLOWED_COUNT);
  assert.equal(IN_MATCHER_DENY.length, EXPECTED_IN_MATCHER_DENY);
  assert.equal(HANDLER_ONLY_DENY.length, EXPECTED_HANDLER_ONLY_DENY);
  assert.equal(OUT_OF_MATCHER.length, EXPECTED_OUT_OF_MATCHER);
  assert.equal(MONEY_SERVER_DENY.length, EXPECTED_MONEY_SERVER_DENY);
  assert.equal(MONEY_SERVER_ALLOW.length, EXPECTED_MONEY_SERVER_ALLOW);
  assert.equal(MONEY_SERVER_MULTISEG_DENY.length, EXPECTED_MONEY_SERVER_MULTISEG_DENY);
  assert.equal(MONEY_SERVER_MULTISEG_ALLOW.length, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW);
  const matcher = new RegExp(kitGroup.matcher);
  const mustDeny = [
    ...FORBIDDEN_TOOLS, ...FORBIDDEN_AFTER_RECONNECT, ...FORBIDDEN_FAMILY,
    ...MONEY_SERVER_DENY.map((t) => MONEY_SERVER + t), ...MONEY_SERVER_MULTISEG_DENY.map(([name]) => name),
  ];
  const mustAllow = [...ALLOWED_LOOKALIKES, ...MONEY_SERVER_ALLOW.map((t) => MONEY_SERVER + t), ...MONEY_SERVER_MULTISEG_ALLOW.map(([name]) => name)];
  for (const name of mustDeny) {
    assert.ok(matcher.test(name), `字表裡該擋的「${name}」不在 matcher 射程內：這題的前提要重看`);
    denyReason(run(kitGroup, name), `套件那組沒擋「${name}」（並存期 v6 會替它遮掉這一筆；現在剛好一組，這題自己算數）`);
  }
  for (const name of mustAllow) allows(run(kitGroup, name), `套件那組誤擋「${name}」`);
  // 壞輸入：matcher 接得住、但工具名不合法（結尾換行之類）＝要擋；根本不是 JSON＝也要擋（fail-closed）
  for (const [payload, why] of IN_MATCHER_DENY) denyReason(runRaw(kitGroup, payload), `輸入衛生：${why}`);
  for (const [payload, why] of HANDLER_ONLY_DENY) denyReason(runRaw(kitGroup, payload), `壞輸入 fail-closed：${why}`);
  // matcher 射程外的名字：平台根本不會叫這一組（跟既有考卷同一個判準），這裡只確認 matcher 真的不接
  for (const [name, why] of OUT_OF_MATCHER) assert.equal(matcher.test(name), false, `matcher 不該接「${name}」：${why}`);
});

test('②理由形狀：測試鈕被擋、理由開頭「錢的絕對邊界：」且含「在拒絕清單上」；真下單工具也擋；無害工具放行', () => {
  const reason = denyReason(run(kitGroup, CANARY), '這一組要擋測試鈕');
  assert.match(reason, /在拒絕清單上/u, '理由要指名是逐字清單擋的（安裝說明第⑤步認這句）');
  assert.ok(reason.startsWith('錢的絕對邊界：'), `理由開頭要是這一組的形狀：${reason.slice(0, 40)}`);
  denyReason(run(kitGroup, settings.permissions.deny[0]), '這一組對真下單工具要擋');
  allows(run(kitGroup, HARMLESS), '對照組：這一組不是全擋');
});

test('③套件那組不靠啟動目錄；找不到 node 時退 2 帶錯誤輸出（全擋、看得見）', () => {
  const subdir = path.join(ROOT, 'test');
  denyReason(run(kitGroup, CANARY, { cwd: subdir }), '從專案子目錄起也要擋');
  denyReason(run(kitGroup, CANARY, { cwd: subdir, env: { CLAUDE_PROJECT_DIR: '/nonexistent' } }), '平台的專案目錄變數指到別處也不理它');
  allows(run(kitGroup, HARMLESS, { cwd: subdir }), '從子目錄起，該放行的照樣放行');
  const noNode = run(kitGroup, CANARY, { env: { PATH: '/nonexistent' } });
  assert.equal(noNode.status, 2, `找不到 node 要退 2（拿到 ${noNode.status}）`);
  assert.equal(noNode.stdout, '');
  assert.match(noNode.stderr, /起不來/u, '退 2 要帶看得見的錯誤輸出');
});
