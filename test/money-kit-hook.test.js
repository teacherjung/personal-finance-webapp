/**
 * 「套件那一組錢攔截器」考題（2026-09-16，搬家第 3 步 B 支）
 *
 * 這一支把協作套件的禁區攔截器接到 `.claude/settings.json`，跟原本那組 python v6 **並存**：
 * 兩組同時在擋，舊的一個字都沒動（拆舊的是搬家第 8 步、要並存一個完整週期沒有誤擋之後）。
 * 既有的 `test/money-boundary.test.js` 已經對**每一組**做「matcher 接得住 ∧ handler 實跑回 deny」的
 * 逐名配對，所以「該擋的擋、該放的放」兩面由它一起考新那組；這支考題只補既有考題管不到的三件事：
 *
 *   ①新那組的接線**逐字等於**套件範本 `templates/hook-claude.json`（matcher 與指令），而且 PreToolUse
 *     剛好兩組、python v6 那組還在——漂了就紅（範本改了就要同支換進來，驗收分級 F 第②類）；
 *   ②**歸因**：測試鈕 `mcp__guard_canary__ping` 只被新那組擋（理由含「在拒絕清單上」、沒有 v6 那種括號日期字樣），
 *     python v6 那組對它放行——所以 William 在真的對話裡看到的那句拒絕理由，能分辨是哪一層擋的；
 *   ③新那組**不靠啟動目錄**：從專案子目錄起、平台的專案目錄變數指到別處，照樣擋（它先清 GIT_ 再問
 *     版本控制根目錄，2026-09-16 實測平台變數跟著啟動目錄走）；找不到 node 時退 2 帶錯誤輸出（全擋、看得見）。
 *
 * ⚠️ 誠實劃界：這裡是用 shell 模擬鉤子的呼叫（跟 money-boundary 同一招），**不是真的 Claude session**——
 *   設定有沒有被載入、鉤子在真環境找不找得到 node，只有 William 在真的對話裡按一次測試鈕才算數
 *  （預期：被擋、理由指名「在拒絕清單上」；再叫一個平常會用的工具要照常能用）。
 *   新那組讀的是這棵樹的 `settings.json`（改檔、切分支下一次呼叫就生效），並存期間 python 那組照擋、不漏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const settings = JSON.parse(read('.claude/settings.json'));
const groups = settings.hooks.PreToolUse;
const template = JSON.parse(read('templates/hook-claude.json')).hooks.PreToolUse[0];
const CANARY = 'mcp__guard_canary__ping';
/** 一個沒有任何規則會擋的名字（跟 money-boundary 的良性樣本同一類），當「新那組不是全擋」的對照。 */
const HARMLESS = 'mcp__other__get_widget';
/** v6 那組拒絕理由的開頭（帶括號的沿革）；套件那組的理由沒有括號、直接接冒號。 */
const V6_REASON_HEAD = '錢的絕對邊界（';

const kitGroup = groups.find((g) => g.hooks?.[0]?.command === template.hooks[0].command);
const v6Group = groups.find((g) => typeof g.hooks?.[0]?.command === 'string' && g.hooks[0].command.startsWith('python3 -c'));

/** 照鉤子的起法跑一組：bash -c，標準輸入是平台會給的 JSON。 */
function run(group, toolName, { cwd = ROOT, env = {} } = {}) {
  const clean = { ...process.env };
  delete clean.CLAUDE_PROJECT_DIR;
  // 用絕對路徑起 shell：③會把 PATH 指到不存在的地方（模擬找不到 node），shell 自己不能因此起不來
  return spawnSync('/bin/bash', ['-c', group.hooks[0].command], {
    cwd, env: { ...clean, ...env }, input: JSON.stringify({ tool_name: toolName, tool_input: {} }),
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
  });
}
const denyReason = (r, why) => {
  assert.equal(r.status, 0, `${why}：退出碼 ${r.status}（${r.stderr.slice(0, 200)}）`);
  const d = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(d.permissionDecision, 'deny', why);
  assert.equal(d.hookEventName, 'PreToolUse', why);
  return d.permissionDecisionReason;
};
const allows = (r, why) => assert.deepEqual([r.status, r.stdout.trim()], [0, ''], `${why}：該放行的沒放行（${r.stderr.slice(0, 200)}）`);

test('①PreToolUse 剛好兩組：python v6 那組還在、套件那組逐字等於範本', () => {
  assert.equal(groups.length, 2, '並存期要剛好兩組（v6＋套件）；拆舊的是第 8 步');
  assert.ok(v6Group, '找不到 python v6 那組：舊的一個字都不可以動');
  assert.ok(kitGroup, '找不到指令逐字等於套件範本的那一組：範本改了就要同支換進來');
  assert.equal(kitGroup.matcher, template.matcher, '套件那組的 matcher 要跟範本一樣');
  assert.deepEqual(Object.keys(kitGroup).sort(), ['hooks', 'matcher'], '套件那組只准有 matcher 與 hooks（範本的說明鍵不要抄）');
  assert.equal(kitGroup.hooks.length, 1);
  assert.deepEqual(Object.keys(kitGroup.hooks[0]).sort(), ['command', 'type']);
  assert.ok(existsSync(path.join(ROOT, 'tools', 'forbidden-tools.js')), '套件的判斷程式不在：這組會退 2 全擋');
});

test('②歸因：測試鈕只被套件那組擋（理由含「在拒絕清單上」、沒有 v6 的括號沿革），v6 對它放行', () => {
  const reason = denyReason(run(kitGroup, CANARY), '套件那組要擋測試鈕');
  assert.match(reason, /在拒絕清單上/u, '理由要指名是逐字清單擋的（安裝說明第⑤步認這句）');
  assert.ok(reason.startsWith('錢的絕對邊界：'), `理由開頭要是套件那組的形狀：${reason.slice(0, 40)}`);
  assert.ok(!reason.includes(V6_REASON_HEAD), '理由裡出現 v6 的括號沿革＝分不出是哪一層擋的');
  allows(run(v6Group, CANARY), 'v6 那組對測試鈕要放行（清單裡沒有它；這樣看到拒絕才確定是新那組）');
  // v6 的理由形狀（正對照：那組真的會擋真下單工具、而且理由帶括號沿革）
  const v6 = denyReason(run(v6Group, settings.permissions.deny[0]), 'v6 那組對真下單工具要擋');
  assert.ok(v6.includes(V6_REASON_HEAD), 'v6 的理由形狀變了：歸因判準要跟著改');
  // 套件那組也擋真下單工具（並存＝兩組都擋）
  denyReason(run(kitGroup, settings.permissions.deny[0]), '套件那組對真下單工具要擋');
  allows(run(kitGroup, HARMLESS), '對照組：套件那組不是全擋');
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
