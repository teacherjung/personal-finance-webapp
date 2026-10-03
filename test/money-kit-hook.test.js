/**
 * 「Claude 側錢攔截器那一組」考題（2026-09-16 搬家第 3 步 B 支起；2026-09-19 Claude 側釘指紋第 2 支改寫）
 *
 * 沿革：2026-09-16 起套件那一組（活讀那一行＝templates/hook-claude.json：清掉 GIT_ 後問版本控制根目錄、每次呼叫重讀那棵樹的清單）
 * 跟 python v6 並存；2026-09-18 第 8 步拆掉 python 那組；**2026-09-19 起換成釘指紋那一行**（William 2026-09-18 在 #615 裁：
 * Claude 側也要釘、做法跟 Codex 全域層同一招、補複本不自動、設定變更攔截同一支一起裝）。
 *
 * 現況：`.claude/settings.json` 的兩組＝`node tools/guard-copy.js --claude-line` 印的那兩組（範本＝templates/hook-claude-pinned.json）：
 *   ・PreToolUse 那一行只寫指紋、不看當下目錄、不碰 git，判斷讀倉庫外的固定複本 `$HOME/.local/share/ai-collab-kit/guard/<指紋>`
 *     （每台機器由人跑 `node tools/guard-copy.js --claude` 補）；複本不在、被改過、裡面多了東西＝退 2（所有 mcp__ 工具全擋）；
 *   ・ConfigChange 那一組＝設定變更攔截（matcher 只掛 project_settings，指令只有 exit 2）。
 *
 * 這支守的：
 *   ①兩組**逐字等於**「範本＋這棵樹四個檔的指紋」：`tools/claude-pin.js` 的 claudePinStatus(ROOT).state **必須是 'ok'**——
 *     套件自己的等式題（tests/claude-pin.test.js ①）遇到活讀是跳過，本專案不准跳過：那一行被退回活讀、改了那四個檔卻沒重印、
 *     手改過那一行，這題都紅。另外 PreToolUse、ConfigChange 各剛好一組；沒有活讀那一行、沒有 python 那一組。
 *   ⓪共用字表（`test/helpers/money-family-probes.js`，位元組由另一支考題釘著）的整張矩陣**只餵這一組**，HOME 指到本檔自己開的
 *     暫存家（裡面用這棵樹當下的四個檔造一份複本、造完驗指紋：`test/helpers/pinned-home.js`）。該擋的**每一組都斷言理由類別**
 *     （2026-09-27 ⑧：登記制之後有一批探針照樣擋、但擋的理由從家族網換成「沒有登記」——只斷言擋會假綠）；
 *     這裡只有真清單（這一行釘了指紋、換不了清單），所以家族網本身的擋與不誤殺不在這裡量，在 test/codex-global-hook.test.js ③ 的夾具那一輪真跑。
 *   ②**理由形狀**：測試鈕 `mcp__guard_canary__ping` 被擋、理由開頭是「錢的絕對邊界：」、含「在拒絕清單上」——
 *     安裝順序認這句，William 在真的對話裡看到它就知道是這一組擋的；真下單工具也擋、無害工具放行。
 *   ③釘指紋那一行的性質：
 *     ・不看當下目錄、不理平台的專案目錄變數（CLAUDE_PROJECT_DIR）：從專案子目錄、從樹外起，照樣擋；那個變數指到一棵**真的存在、
 *       清單改弱**的樹（對照：活讀那一行在那棵樹裡真的放行），照樣擋；兩種情況該放的都照樣放。
 *       「改弱」在登記制下的寫法（2026-09-27 ⑧）：把測試鈕與券商兩個連接器登記成不碰錢——清空連接器＝名單空＝全擋，那是最嚴不是最弱（weaken 上方）；
 *     ・暫存家裡**沒有複本**（＝這台機器還沒補）：每一個名字（該擋的、該放的、測試鈕）與壞輸入都退 2、標準輸出空的、
 *       錯誤輸出是「指紋對不上」那一句、兩個輸出都不含 64 碼十六進位（不把指紋遞給 AI 去手改那一行）；
 *     ・**核心宣稱**：工作樹的 settings.json 把 forbidden 改弱、複本沒變＝照複本擋。當下目錄與平台的專案目錄變數**都**指到
 *       那棵改弱的樹（真的 Claude 會把那個變數設成專案根；兩行都帶，活讀那一行不讀它、問的是版本控制根目錄）。
 *       對照組＝活讀那一行在**同一棵**改弱的樹上真的放行
 *       （同一棵樹改弱之前活讀那一行擋＝這棵暫存樹真的是一棵能用的樹；兩次之間只差 forbidden 那一塊）；
 *     ・找不到 node＝退 2、「起不來」那一句（shasum、find、env 都寫絕對路徑，指紋照樣驗得過）；
 *     ・ConfigChange 那一條實跑：/bin/sh 與 /bin/bash 的 -c 都退 2、兩個輸出都空的。
 *
 * ⚠️ 誠實劃界：
 *   ・這裡是用 shell 模擬鉤子的呼叫（/bin/sh -c；2026-09-18 在桌面版引擎 2.1.275 量到平台起鉤子的 $0 是 /bin/sh），
 *     **不是真的 Claude session**。設定有沒有被載入、這台機器真的家目錄裡有沒有那一行要的那一份複本，只有 William 在真的對話裡
 *     按一次測試鈕才算數（預期：被擋、理由含「在拒絕清單上」；看到「…（指紋對不上）」＝這台機器還沒補複本）。
 *   ・複本是考題用**工作樹**造的，不是 `--claude` 從已合併版本抽的那一份；本檔不讀寫真的家目錄（CI 上那裡也沒有複本）。
 *   ・平台給鉤子的環境變數，本檔只模擬 HOME 與 CLAUDE_PROJECT_DIR 兩個（其餘沿用考卷自己的環境）。
 *   ・改了那四個檔卻沒重印那一行：紅的是 ①（等式），以及⓪②與③裡實跑那一行的題——那幾題的錯誤輸出是那一行印的「指紋對不上」
 *     那一句（它叫人原句轉給裁示者，是寫給真的對話的）；在考卷裡它的意思是那一行沒跟著重印，失敗訊息另外接一句提示
 *     （test/helpers/pinned-home.js 的 PIN_MISMATCH_HINT）。
 *   ・ConfigChange 這裡只證明那一條指令退 2。平台上它擋不擋：2026-09-18 在 2.1.275 量過一次（只量了專案設定檔這個來源、
 *     那一組是對話中途裝上的）；裝上時（2026-09-19）又量了一次，結果記在 PROJECT.md「Claude 側釘指紋第 2 支的合併與驗收」
 *     那一段；之後沒有任何例行動作重量它（測試鈕只走 PreToolUse 那一行）。
 *   ・鉤子的環境被塞變數（SHELLOPTS、匯入的 shell 函式、PATH）這一類擋不住、那一行裡關不完，ConfigChange 那一條一樣——
 *     照實的對照在套件的 tests/guard-copy-claude.test.js ⑪；本機設定檔 `.claude/settings.local.json` 的絆線在套件的
 *     tests/claude-pin.test.js ③（只在本機工作樹跑考卷的那一次看得到，不是閘）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import guardCopy from '../tools/guard-copy.js';
import claudePin from '../tools/claude-pin.js';
import forbiddenTools from '../tools/forbidden-tools.js';
import {
  FORBIDDEN_TOOLS, FORBIDDEN_AFTER_RECONNECT, FORBIDDEN_FAMILY, EXPECTED_FORBIDDEN_FAMILY,
  LOOKALIKES_REGISTERED, EXPECTED_LOOKALIKES_REGISTERED, LOOKALIKES_UNREGISTERED, EXPECTED_LOOKALIKES_UNREGISTERED,
  IN_MATCHER_DENY, EXPECTED_IN_MATCHER_DENY, HANDLER_ONLY_DENY, EXPECTED_HANDLER_ONLY_DENY, OUT_OF_MATCHER, EXPECTED_OUT_OF_MATCHER,
  MONEY_SERVER, MONEY_SERVER_DENY, EXPECTED_MONEY_SERVER_DENY, MONEY_SERVER_ALLOW, EXPECTED_MONEY_SERVER_ALLOW,
  MONEY_SERVER_MULTISEG_DENY, EXPECTED_MONEY_SERVER_MULTISEG_DENY, MONEY_SERVER_MULTISEG_ALLOW, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW,
  HARMLESS, HARMLESS_SERVER, FAKE_UUID, reasonClass, IMPERSONATION_TAIL,
} from './helpers/money-family-probes.js';
import { makePinnedHome, makeEmptyHome, removeHome, pinMismatchHint } from './helpers/pinned-home.js';

const { claudeLine } = guardCopy;
const { claudePinStatus, PINNED_MARK } = claudePin;
const { decide } = forbiddenTools;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const settings = JSON.parse(read('.claude/settings.json'));
const preGroups = settings.hooks?.PreToolUse ?? [];
const changeGroups = settings.hooks?.ConfigChange ?? [];
/** 設定檔裡**實際寫的**釘指紋那一組（⓪②③跑的是它，不是期望值）：指令提到固定複本位置的那一組。 */
const pinnedGroup = preGroups.find((g) => typeof g?.hooks?.[0]?.command === 'string' && g.hooks[0].command.includes(PINNED_MARK));
/** 活讀那一行（2026-09-19 之前裝的那一份）：③的對照組用。 */
const LIVE = JSON.parse(read('templates/hook-claude.json')).hooks.PreToolUse[0];
const CANARY = 'mcp__guard_canary__ping';
/** 本專案的真清單（根目錄 settings.json 的 forbidden 那一塊）：前提斷言與理由類別的期望值用。 */
const projectForbidden = JSON.parse(read('settings.json')).forbidden;
/** HARMLESS（「這一組不是全擋」的對照，住在探針 helper）的前提：它的連接器在真清單登記為不碰錢。拿掉了＝前提變了，不是攔截器壞了。 */
const harmlessPremise = () => assert.ok(projectForbidden.safeServers.includes(HARMLESS_SERVER),
  `前提：settings.json 的 forbidden.safeServers 要有「${HARMLESS_SERVER}」（對照名字 ${HARMLESS} 掛在它底下；沒有它＝對照組不成立）`);
const HEX64 = /[0-9a-f]{64}/u;
const MISMATCH = /指紋對不上/u;

/** 本檔的暫存家：第一次用到才造（造不出來＝丟 AssertionError、叫到它的那一題紅），跑完刪掉。 */
let pinned = null;
const pinnedHome = () => (pinned ??= makePinnedHome(ROOT)).home;
const scratch = [];
after(() => {
  if (pinned) removeHome(pinned.home);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * 照鉤子的起法跑一條指令：/bin/sh -c（量到平台用 /bin/sh 起），標準輸入原樣給（壞輸入那幾筆不是合法 JSON，所以這一層不包 JSON）。
 * **home 一定要明講**（漏給＝當場丟錯）：沿用考卷自己的 HOME 的話，在補過複本的機器上會讀到真的那一份。
 * 平台的專案目錄變數 CLAUDE_PROJECT_DIR **由呼叫端決定**：沒給 projectDir＝刪掉（考卷自己的環境若帶著它，不讓它混進來）；
 * 要測它的地方明給（真的 Claude 會把它設成專案根＝③那棵改弱的樹）。只有這一處決定：env 裡不准另外放它。
 */
function runRaw(command, stdinText, { home, cwd = ROOT, env = {}, shell = '/bin/sh', projectDir } = {}) {
  if (typeof home !== 'string') throw new Error('考題漏給 home：跑那一行一定要把 HOME 指到考題自己開的暫存家');
  if (Object.hasOwn(env, 'CLAUDE_PROJECT_DIR')) throw new Error('平台的專案目錄變數用 projectDir 給（只有一處決定）');
  const clean = { ...process.env };
  delete clean.CLAUDE_PROJECT_DIR;
  if (typeof projectDir === 'string') clean.CLAUDE_PROJECT_DIR = projectDir;
  // 用絕對路徑起 shell：③會把 PATH 指到不存在的地方（模擬找不到 node），shell 自己不能因此起不來
  return spawnSync(shell, ['-c', command], {
    cwd, env: { ...clean, HOME: home, ...env }, input: stdinText, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
}
/** 同上，但標準輸入是平台會給的 JSON（工具名）；home 沒給＝本檔那一份有複本的暫存家。 */
const run = (command, toolName, opts = {}) =>
  runRaw(command, JSON.stringify({ tool_name: toolName, tool_input: {} }), { home: pinnedHome(), ...opts });
const cmdOf = (group) => {
  assert.ok(group, '設定檔裡找不到釘指紋那一組（指令提到固定複本位置的那一組）：①會說是哪裡不對');
  return group.hooks[0].command;
};
// denyReason／allows 的每一個呼叫點跑的都是 HOME＝本檔有複本的暫存家（空的家那一題走 mismatch()）：
// 錯誤輸出含「指紋對不上」＝那一行沒跟著重印，原句照印、另外接考卷語境的那一句（pinMismatchHint）
const denyReason = (r, why) => {
  assert.equal(r.status, 0, `${why}：退出碼 ${r.status}（${String(r.stderr).slice(0, 200)}）${pinMismatchHint(r.stderr)}`);
  let d;
  try { d = JSON.parse(r.stdout).hookSpecificOutput; } catch { assert.fail(`${why}：標準輸出不是拒絕形狀（「${String(r.stdout).slice(0, 120)}」；空的＝放行了）`); }
  assert.ok(d && typeof d === 'object', `${why}：標準輸出沒有 hookSpecificOutput（「${String(r.stdout).slice(0, 120)}」）`);
  assert.equal(d.permissionDecision, 'deny', why);
  assert.equal(d.hookEventName, 'PreToolUse', why);
  return d.permissionDecisionReason;
};
const allows = (r, why) => assert.deepEqual([r.status, r.stdout.trim()], [0, ''],
  `${why}：該放行的沒放行（退 ${r.status}；標準輸出「${String(r.stdout).slice(0, 120)}」；錯誤輸出「${String(r.stderr).slice(0, 200)}」）${pinMismatchHint(r.stderr)}`);
/** 複本不在／指紋對不上那一條路：退 2、標準輸出空的、錯誤輸出是那一句、兩個輸出都不含 64 碼十六進位。 */
const mismatch = (r, why) => {
  assert.equal(r.status, 2, `${why}：要退 2（拿到 ${r.status}；${String(r.stdout).slice(0, 120)}｜${String(r.stderr).slice(0, 200)}）`);
  assert.equal(r.stdout, '', `${why}：標準輸出要空的`);
  assert.match(r.stderr, MISMATCH, `${why}：錯誤輸出要是「指紋對不上」那一句`);
  assert.doesNotMatch(r.stdout + r.stderr, HEX64, `${why}：輸出不可以印出 64 碼十六進位（AI 拿到就可能去手改那一行）`);
};

test('①兩組逐字等於「範本＋這棵樹四個檔的指紋」（claudePinStatus 必須是 ok、不准跳過）；各剛好一組；沒有活讀那一行、沒有 python 那一組', () => {
  const status = claudePinStatus(ROOT);
  assert.deepEqual(status, { state: 'ok', problems: [] },
    `.claude/settings.json 那兩組不是「範本＋這棵樹四個檔的指紋」（state＝${status.state}）：${status.problems.join('；') || '沒有任何一條鉤子指令提到固定複本的位置＝被退回活讀或拿掉了'}`
    + '——改了那四個檔（settings.json 的 forbidden 那一塊、tools/forbidden-tools.js、tools/settings-data.js、tools/package.json）就在同一支重跑 node tools/guard-copy.js --claude-line 換進來，不要手改');
  assert.equal(preGroups.length, 1, `PreToolUse 要剛好一組（拿到 ${preGroups.length}）`);
  assert.equal(changeGroups.length, 1, `ConfigChange 要剛好一組（拿到 ${changeGroups.length}）`);
  // 同一件事再直接比一次（不只信 claudePinStatus 的判斷）：期望值＝--claude-line 會印的那兩組
  const expected = claudeLine(ROOT).groups;
  assert.deepEqual(preGroups[0], expected.PreToolUse, 'PreToolUse 那一組要整組等於 --claude-line 印的（matcher、type、command）');
  assert.deepEqual(changeGroups[0], expected.ConfigChange, 'ConfigChange 那一組要整組等於 --claude-line 印的');
  assert.equal(pinnedGroup, preGroups[0], '⓪②③跑的那一組就是這一組');
  const commands = Object.values(settings.hooks ?? {}).flat().flatMap((g) => g?.hooks ?? []).map((h) => h?.command);
  assert.ok(!commands.includes(LIVE.hooks[0].command), '活讀那一行跑回來了（2026-09-19 起換成釘指紋那一行）');
  assert.ok(!commands.some((c) => typeof c === 'string' && /git rev-parse/u.test(c)), '有一條鉤子在問版本控制根目錄（活讀的寫法）');
  assert.ok(!commands.some((c) => typeof c === 'string' && c.startsWith('python3 -c')), 'python v6 那組跑回來了（第 8 步已拆）');
  assert.ok(existsSync(path.join(ROOT, 'tools', 'forbidden-tools.js')), '套件的判斷程式不在：補複本（--claude）抽不出來');
});

test('⓪共用字表的整張矩陣只餵釘指紋那一組（HOME＝本檔的暫存家）：該擋的都擋而且每一組擋的理由類別對、該放的都放、壞輸入也擋', () => {
  const cmd = cmdOf(pinnedGroup);
  // 數量釘：字表被縮短了要有意識地改（跟既有兩卷同一套）
  assert.equal(FORBIDDEN_FAMILY.length, EXPECTED_FORBIDDEN_FAMILY);
  assert.equal(LOOKALIKES_REGISTERED.length, EXPECTED_LOOKALIKES_REGISTERED);
  assert.equal(LOOKALIKES_UNREGISTERED.length, EXPECTED_LOOKALIKES_UNREGISTERED);
  assert.equal(IN_MATCHER_DENY.length, EXPECTED_IN_MATCHER_DENY);
  assert.equal(HANDLER_ONLY_DENY.length, EXPECTED_HANDLER_ONLY_DENY);
  assert.equal(OUT_OF_MATCHER.length, EXPECTED_OUT_OF_MATCHER);
  assert.equal(MONEY_SERVER_DENY.length, EXPECTED_MONEY_SERVER_DENY);
  assert.equal(MONEY_SERVER_ALLOW.length, EXPECTED_MONEY_SERVER_ALLOW);
  assert.equal(MONEY_SERVER_MULTISEG_DENY.length, EXPECTED_MONEY_SERVER_MULTISEG_DENY);
  assert.equal(MONEY_SERVER_MULTISEG_ALLOW.length, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW);
  const matcher = new RegExp(pinnedGroup.matcher);
  // 必擋：每一組都斷言**理由類別**（reasonClass 只看理由開頭；2026-09-27 ⑧：登記制之後有一批探針「照樣擋、但擋的理由換了」，
  // 只斷言擋＝假綠）。只有真清單這一份：Claude 那一行釘了指紋、換不了清單，家族網本身的擋與不誤殺在 codex-global-hook ③ 的夾具那一輪真跑。
  // 名字像錢、掛在沒登記的連接器上（換了編號的下單工具、家族矩陣）＝尾句要是規則 3 那一句（當誤觸或冒名、立即回報裁示者）；
  // IMPERSONATION_TAIL 錨在結尾，對上它就不是登記制「看不出像錢」那一種尾句（那一種的逐字不抄，理由在 helper）。
  // 換了編號之後的券商唯讀查詢（白名單那一族名字掛在新編號上）＝同樣被登記制擋——docs/money-guard-operations.md「券商重新連線、編號換了」那一則的承重。
  /** @type {[string, string[], (name: string) => string, boolean][]} 組名、名字、期望的理由類別、是否要冒名那一句尾句 */
  const mustDeny = [
    ['FORBIDDEN_TOOLS', FORBIDDEN_TOOLS, () => 'denylist', true],
    ['FORBIDDEN_AFTER_RECONNECT', FORBIDDEN_AFTER_RECONNECT, () => 'registry', true],
    ['FORBIDDEN_FAMILY', FORBIDDEN_FAMILY, () => 'registry', true],
    ['LOOKALIKES_UNREGISTERED', LOOKALIKES_UNREGISTERED, () => 'registry', false],
    ['MONEY_SERVER_ALLOW（換了編號）', MONEY_SERVER_ALLOW.map((t) => FAKE_UUID + t), () => 'registry', false],
    // 券商連接器上名單外的：白名單制；其中同時逐字在拒絕清單上的那兩支是拒絕清單先判
    ['MONEY_SERVER_DENY', MONEY_SERVER_DENY.map((t) => MONEY_SERVER + t), (n) => (projectForbidden.deny.includes(n) ? 'denylist' : 'whitelist'), true],
    ['MONEY_SERVER_MULTISEG_DENY', MONEY_SERVER_MULTISEG_DENY.map(([name]) => name), () => 'whitelist', true],
  ];
  for (const [group, names, expected, impersonation] of mustDeny) {
    for (const name of names) {
      assert.ok(matcher.test(name), `字表裡該擋的「${name}」不在 matcher 射程內：這題的前提要重看`);
      const reason = denyReason(run(cmd, name), `釘指紋那一組沒擋「${name}」（${group}）`);
      assert.equal(reasonClass(reason), expected(name), `「${name}」（${group}）擋下的理由類別不對：${reason.slice(0, 140)}`);
      if (impersonation) {
        assert.match(reason, IMPERSONATION_TAIL, `「${name}」（${group}）的尾句要是規則 3 那一句（當誤觸或冒名、立即回報裁示者）`);
      }
    }
  }
  const mustAllow = [...LOOKALIKES_REGISTERED, ...MONEY_SERVER_ALLOW.map((t) => MONEY_SERVER + t), ...MONEY_SERVER_MULTISEG_ALLOW.map(([name]) => name)];
  for (const name of mustAllow) allows(run(cmd, name), `釘指紋那一組誤擋「${name}」`);
  // 壞輸入：matcher 接得住、但工具名不合法（結尾換行之類）＝要擋、理由是字元集；根本不是 JSON＝也要擋（fail-closed）
  for (const [payload, why] of IN_MATCHER_DENY) {
    const reason = denyReason(runRaw(cmd, payload, { home: pinnedHome() }), `輸入衛生：${why}`);
    assert.equal(reasonClass(reason), 'charset', `輸入衛生（${why}）擋下的理由要是字元集那一層：${reason.slice(0, 100)}`);
  }
  for (const [payload, why] of HANDLER_ONLY_DENY) {
    const reason = denyReason(runRaw(cmd, payload, { home: pinnedHome() }), `壞輸入 fail-closed：${why}`);
    assert.equal(reasonClass(reason), 'badInput', `壞輸入（${why}）擋下的理由要是 fail-closed 那一句：${reason.slice(0, 100)}`);
  }
  // matcher 射程外的名字：平台根本不會叫這一組（跟既有考卷同一個判準），這裡只確認 matcher 真的不接
  for (const [name, why] of OUT_OF_MATCHER) assert.equal(matcher.test(name), false, `matcher 不該接「${name}」：${why}`);
});

test('②理由形狀：測試鈕被擋、理由開頭「錢的絕對邊界：」且含「在拒絕清單上」；真下單工具也擋；無害工具放行', () => {
  const cmd = cmdOf(pinnedGroup);
  const reason = denyReason(run(cmd, CANARY), '這一組要擋測試鈕');
  assert.match(reason, /在拒絕清單上/u, '理由要指名是逐字清單擋的（安裝順序認這句）');
  assert.ok(reason.startsWith('錢的絕對邊界：'), `理由開頭要是這一組的形狀：${reason.slice(0, 40)}`);
  denyReason(run(cmd, settings.permissions.deny[0]), '這一組對真下單工具要擋');
  harmlessPremise();
  allows(run(cmd, HARMLESS), '對照組：這一組不是全擋');
});

/**
 * 弱清單：只剩一條無關的逐字規則，碰錢連接器、白名單、家族網全拿掉，**另把測試鈕與券商兩個連接器登記成不碰錢**（safeServers）。
 * 為什麼要登記（2026-09-27 ⑧，登記制）：兩欄都空＝名單空＝所有 mcp__ 名字全擋——「清空連接器」在登記制下是最嚴、不是最弱；
 * 要讓活讀那一行在這棵樹上真的放行 targets（測試鈕、真下單工具），就得把它們的連接器登記成不碰錢（整個放行）。
 * 這份弱清單只寫進考題自己的暫存替身樹，不進正式清單。weakenNow() 用 decide() 驗它真的放行 targets（前提斷言）。
 */
const weaken = (forbidden) => ({
  name: forbidden.name,
  safeServers: [CANARY.split('__')[1], FORBIDDEN_TOOLS[0].split('__')[1]],
  deny: ['mcp__z__only'],
});

/**
 * 一棵暫存替身樹：攔截器跑起來會讀的三支＋整份 settings.json（照原樣＝嚴格清單），git init（活讀那一行要問版本控制根目錄）。
 * 環境從零組（鐵則 11：不是 process.env 扣掉幾個）；HOME 指到這個暫存目錄，git 不讀真的家目錄設定。
 * 回 { tree, weakenNow }：weakenNow() 把這棵樹工作樹的 forbidden 改弱（沒提交；複本不動）、回弱清單——兩次之間只差這一塊。
 */
function makeTree() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'pfw-weak-tree-')));
  scratch.push(dir);
  const tree = path.join(dir, 'tree');
  mkdirSync(path.join(tree, 'tools'), { recursive: true });
  for (const rel of ['tools/forbidden-tools.js', 'tools/settings-data.js', 'tools/package.json']) cpSync(path.join(ROOT, rel), path.join(tree, rel));
  const whole = JSON.parse(read('settings.json'));
  const settingsFile = path.join(tree, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify(whole, null, 2));
  const init = spawnSync('git', ['init', '-q'], { cwd: tree, env: { PATH: process.env.PATH ?? '', HOME: dir }, encoding: 'utf8' });
  assert.equal(init.status, 0, `git init 失敗：${init.stderr}`);
  const weakenNow = () => {
    const weak = weaken(whole.forbidden);
    writeFileSync(settingsFile, JSON.stringify({ ...whole, forbidden: weak }, null, 2));
    for (const name of [CANARY, FORBIDDEN_TOOLS[0]]) assert.equal(decide(name, weak).deny, false, `前提：弱清單真的放行「${name}」（${decide(name, weak).why}）`);
    return weak;
  };
  return { tree, weakenNow };
}

test('③不看當下目錄、不理平台的專案目錄變數：從專案子目錄、從樹外起，那個變數指到一棵清單改弱的樹，照樣擋、該放的照樣放；找不到 node＝退 2「起不來」', () => {
  const cmd = cmdOf(pinnedGroup);
  harmlessPremise();
  // 一棵真的存在、清單改弱的樹（真的 Claude 會把專案目錄變數設成專案根）。對照：活讀那一行在這棵樹裡真的放行＝它真的是弱的
  const { tree, weakenNow } = makeTree();
  weakenNow();
  allows(run(LIVE.hooks[0].command, CANARY, { cwd: tree, projectDir: tree }), '前提：這棵樹的清單真的改弱了（活讀那一行在裡面放行測試鈕）');
  const subdir = path.join(ROOT, 'test');
  const outside = realpathSync(tmpdir());
  for (const cwd of [subdir, outside]) {
    const where = cwd === subdir ? '專案子目錄' : '樹外';
    denyReason(run(cmd, CANARY, { cwd }), `從${where}起也要擋`);
    denyReason(run(cmd, CANARY, { cwd, projectDir: tree }), `從${where}起、平台的專案目錄變數指到清單改弱的樹，照樣擋（不理這個變數）`);
    allows(run(cmd, HARMLESS, { cwd }), `從${where}起，該放行的照樣放行`);
    allows(run(cmd, HARMLESS, { cwd, projectDir: tree }), `從${where}起、專案目錄變數指到改弱的樹，該放行的照樣放行`);
  }
  const noNode = run(cmd, CANARY, { env: { PATH: '/nonexistent' } });
  assert.equal(noNode.status, 2, `找不到 node 要退 2（拿到 ${noNode.status}）`);
  assert.equal(noNode.stdout, '');
  assert.match(noNode.stderr, /起不來/u, '退 2 要帶看得見的錯誤輸出');
  assert.doesNotMatch(noNode.stderr, MISMATCH, '沒有 node 的時候指紋照樣驗得過（shasum、find、env 都寫絕對路徑）：擋下它的是尾巴，不是指紋檢查');
});

test('③暫存家裡沒有複本（這台機器還沒補）：每一個名字與壞輸入都退 2、印「指紋對不上」那一句、兩個輸出都不含 64 碼十六進位', () => {
  const cmd = cmdOf(pinnedGroup);
  harmlessPremise();
  const empty = makeEmptyHome();
  try {
    const names = [CANARY, HARMLESS, ...FORBIDDEN_TOOLS, ...FORBIDDEN_AFTER_RECONNECT, ...LOOKALIKES_REGISTERED, ...LOOKALIKES_UNREGISTERED, ...MONEY_SERVER_ALLOW.map((t) => MONEY_SERVER + t)];
    for (const name of names) mismatch(run(cmd, name, { home: empty }), `沒有複本：「${name}」`);
    for (const [payload, why] of [...IN_MATCHER_DENY, ...HANDLER_ONLY_DENY]) mismatch(runRaw(cmd, payload, { home: empty }), `沒有複本、壞輸入：${why}`);
    // 對照組：同一條指令、HOME 指回有複本的暫存家就照清單判（上面的退 2 是因為家裡沒有複本，不是那一行壞了）
    allows(run(cmd, HARMLESS), '對照組：HOME 指回有複本的家，無害工具放行');
    denyReason(run(cmd, CANARY), '對照組：HOME 指回有複本的家，測試鈕照清單擋');
  } finally {
    removeHome(empty);
  }
});

test('③核心宣稱：工作樹的 settings.json 把 forbidden 改弱、複本沒變＝照複本擋（當下目錄與平台的專案目錄變數都指到那棵樹；對照組：活讀那一行在同一棵改弱的樹上真的放行）', () => {
  const cmd = cmdOf(pinnedGroup);
  harmlessPremise();
  const live = LIVE.hooks[0].command;
  // 這棵樹的替身（makeTree）。兩行都從樹裡起、專案目錄變數都指到樹根（真的 Claude 會把它設成專案根）：
  // 活讀那一行不讀這個變數（問的是版本控制根目錄），所以對照組的前提不變
  const { tree, weakenNow } = makeTree();
  const inTree = (command, name) => run(command, name, { cwd: path.join(tree, 'tools'), projectDir: tree });
  const targets = [CANARY, FORBIDDEN_TOOLS[0]];

  // 前提：改弱之前，活讀那一行在這棵替身樹上照嚴格清單擋（這棵樹真的能用）；釘指紋那一行也擋
  for (const name of targets) {
    denyReason(inTree(live, name), `前提：嚴格清單下活讀那一行擋「${name}」`);
    denyReason(inTree(cmd, name), `前提：嚴格清單下釘指紋那一行擋「${name}」`);
  }
  // 工作樹把 forbidden 改弱（沒提交；複本不動）——兩次之間只差這一塊（weakenNow 自己驗弱清單真的放行 targets）
  weakenNow();
  for (const name of targets) {
    allows(inTree(live, name), `對照組：工作樹改弱，活讀那一行真的放行「${name}」`);
    denyReason(inTree(cmd, name), `工作樹改弱：釘指紋那一行照複本擋「${name}」`);
  }
  allows(inTree(cmd, HARMLESS), '對照組：釘指紋那一行不是全擋');
});

test('③ConfigChange 那一條實跑：/bin/sh 與 /bin/bash 的 -c 都退 2、兩個輸出都空的', () => {
  const group = changeGroups[0];
  assert.ok(group, '找不到 ConfigChange 那一組');
  assert.equal(group.matcher, 'project_settings', '只量過專案設定檔這一個來源（local_settings 刻意不掛）');
  for (const shell of ['/bin/sh', '/bin/bash']) {
    // 標準輸入給 '{}'：那一條不讀它（平台實際送什麼這裡不假裝知道）
    const r = runRaw(group.hooks[0].command, '{}', { home: pinnedHome(), shell });
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', ''], `${shell} -c：設定變更攔截那一條要退 2、兩個輸出都空的`);
  }
});
