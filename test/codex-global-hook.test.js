// @ts-check
/**
 * 「Codex 側錢鎖」考題——全域層版（2026-09-18 搬家第 8 步；接替 2026-09-01〜09-18 的 test/codex-money-hook.test.js）
 *
 * Codex 側自 2026-09-17 起走**家目錄全域層**：`~/.codex/hooks.json` 的那一組讀 `tools/guard-copy.js` 從已合併進主幹的版本抽出、
 * 放在倉庫外的固定複本（接線範本＝`templates/hook-codex-global.json`；複本路徑與指紋寫死在指令裡）。專案層副本 `.codex/hooks.json`
 * 第 8 步刪除（William 2026-09-18 裁第 14 題 a；他在 Codex /hooks 面板看過：兩組都在家目錄那份、沒有專案來源那一列）。
 *
 * 這支考題證明的是**本專案的真清單裝進全域層那條指令之後，指令真的擋該擋、放該放**：
 *   ①從這棵樹（tools/ 四檔＋範本＋settings.json 只留 forbidden）造一個暫存倉庫、當成已合併，用 `tools/guard-copy.js` 的 `build()`
 *     抽固定複本＋算指紋＋印接線——跟人安裝時跑的是同一支程式、同一份範本；
 *   ②真的用 `/bin/sh -lc` 跑印出來的那條指令：測試鈕與兩支下單工具＝退 2＋錯誤輸出是合規 deny（含「在拒絕清單上」）；
 *     無害工具＝退 0 零輸出；煙霧探針分兩輪（2026-09-27 ⑧，登記制）：真清單那一輪 19 個全在沒登記的連接器上＝全擋、理由「沒有登記」，
 *     家族網夾具那一輪（`familyNetFixture()`：把煙霧名的連接器登記成碰錢、工具名放上白名單）11 擋（理由是家族網或額外樣式）8 放；
 *     壞輸入 fail-closed；複本改一個位元組＝退 2「指紋對不上」；
 *   ③整張家族矩陣（`test/helpers/money-family-probes.js`，位元組由另一支考題釘）**兩路都跑**：真的餵印出來的指令（每一個名字
 *     一次 sh＋node；舊題「完整矩陣直接餵 command、誰都不能代考」那一格照留），再餵複本裡那份清單的行程內 `decide()` 對照；
 *     每一組斷言理由類別（登記制之後有一批「照樣擋、理由換了」）；另外**用家族網夾具再抽一份複本、真跑一遍家族矩陣**——
 *     Claude 側那一行釘了指紋、換不了清單，所以「整張家族矩陣經過鉤子指令、擋的理由是家族網」只在這一支量（行程內 decide() 的同一件事＝money-boundary 的家族網矩陣題）。夾具那一份不拿去跑白名單精確集合與雙保險（它把
 *     create／delete_order_instruction 也放上了白名單）；
 *     白名單集合＝探針的 MONEY_SERVER_ALLOW（JSON 逐字集合，多列少列都紅）；白名單誤放建單工具時**家族網**仍擋（變因只留家族網：
 *     逐字拒絕清單清空、servers 留著）——**壞清單真的寫進來源倉庫、抽第二份複本、用印出來的指令再跑一次**（不只行程內 decide()），
 *     對照組＝名單內、家族網接不到的仍放行。
 *   ⚠️ 劃界：暫存倉庫把 origin/<主幹> 指到同一顆 HEAD，所以 build() 的「只 git show、不讀工作樹」「必須已合併」在這裡恆真；
 *     那兩條由套件 tests/guard-copy.test.js ①（提交後再改工作樹）與 ⑧（本機多一顆沒推的提交要拒）守，本題不假裝在守。
 *
 * 環境：印出來的指令用 `env -i PATH=… node` 起攔截器，環境本來就清空；那一截由套件 tests/guard-copy.test.js 的「⑥環境變數夾帶的程式
 * 進不來（NODE_OPTIONS）」題守（envonly 那一段測的是找不到 node 退 2，不是清環境），這裡不另出「髒 GIT_*」題
 * （考題自己起 shell 時已走 gitEnv()，髒環境到不了指令＝那種題永遠綠，不留）。
 *
 * ⚠️ 安全宣告（AGENTS 鐵則 11）：本檔會 `git init` 一個暫存倉庫（在 os.tmpdir() 底下、跑完刪掉），沙盒環境**從零組**——只給 PATH／HOME
 *    加提交身分的 GIT_AUTHOR_*／GIT_COMMITTER_*，不是 process.env 扣掉幾個；不碰任何真倉庫、不讀寫家目錄設定。
 *
 * ⚠️ 誠實劃界——這支考題證明不了的事：
 *   - **Codex 會不會真的執行家目錄那一組**：要 William 在 Codex 介面（/hooks）按過「信任」才會跑，信任狀態在 ~/.codex/config.toml、
 *     不在 repo；家目錄那份實際長什麼樣、複本抽的是哪個版本，repo 的考題看不到（人做的驗收＝按測試鈕看到「在拒絕清單上」）。
 *   - 這裡抽的複本來自**這棵樹當下的檔**（造暫存倉庫、當成已合併），不是 William 機器上從某個已合併版本抽的那一份
 *     （是哪一版看 ~/.codex/hooks.json 那一組的路徑，repo 看不到——這裡刻意不寫版本碼，寫死的會過時）；
 *     兩者若不同（forbidden 改了還沒重抽），只有重抽＋重按信任那條人的流程會補上、沒有機器提醒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, COPY_FILES } from '../tools/guard-copy.js';
import { decide } from '../tools/forbidden-tools.js';
import { gitEnv } from '../lib/git-env.js';
import {
  FORBIDDEN_TOOLS, FORBIDDEN_AFTER_RECONNECT, FORBIDDEN_FAMILY, EXPECTED_FORBIDDEN_FAMILY,
  LOOKALIKES_REGISTERED, EXPECTED_LOOKALIKES_REGISTERED, LOOKALIKES_UNREGISTERED, EXPECTED_LOOKALIKES_UNREGISTERED,
  IN_MATCHER_DENY, EXPECTED_IN_MATCHER_DENY, HANDLER_ONLY_DENY, EXPECTED_HANDLER_ONLY_DENY,
  MONEY_SERVER, MONEY_SERVER_DENY, EXPECTED_MONEY_SERVER_DENY, MONEY_SERVER_ALLOW, EXPECTED_MONEY_SERVER_ALLOW,
  MONEY_SERVER_MULTISEG_DENY, EXPECTED_MONEY_SERVER_MULTISEG_DENY, MONEY_SERVER_MULTISEG_ALLOW, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW,
  HARMLESS, HARMLESS_SERVER, familyNetFixture, reasonClass, IMPERSONATION_TAIL,
} from './helpers/money-family-probes.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CANARY = 'mcp__guard_canary__ping';
const MISMATCH = /指紋對不上/u;

/** 沙盒 git 的環境從零組（鐵則 11）：只給 PATH／HOME 與提交身分；不是 process.env 扣掉幾個。 */
const SANDBOX_ENV = Object.freeze({
  PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
});
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...SANDBOX_ENV } });

/**
 * 從這棵樹造暫存來源倉庫：攔截器會讀的四檔＋範本＋settings.json 只留 forbidden（跟 guard-copy 抽複本時一樣），提交一顆、當成已合併。
 * 讀的是**工作樹當下的檔**（含沒提交的改動），不是 origin/main。editForbidden 可以在寫進去之前改壞清單（雙保險那題用）。
 * @param {string} scratch
 * @param {(f: any) => any} [editForbidden]
 */
function sourceRepo(scratch, editForbidden) {
  const src = mkdtempSync(join(scratch, 'src-'));
  mkdirSync(join(src, 'tools'));
  for (const rel of ['tools/forbidden-tools.js', 'tools/settings-data.js', 'tools/package.json', 'tools/git-env.js']) {
    cpSync(join(ROOT, rel), join(src, rel));
  }
  cpSync(join(ROOT, 'templates'), join(src, 'templates'), { recursive: true });
  const { forbidden: real, mainBranch } = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8'));
  const forbidden = editForbidden ? editForbidden(real) : real;
  writeFileSync(join(src, 'settings.json'), JSON.stringify({ participants: [], mainBranch, forbidden, gates: [] }, null, 2));
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'src'], ['update-ref', `refs/remotes/origin/${mainBranch}`, 'HEAD']]) {
    const r = git(src, ...args);
    assert.equal(r.status, 0, `git ${args[0]} 失敗：${r.stderr}`);
  }
  return { src, forbidden };
}

/** 照 Codex 起鉤子的方式跑印出來的指令（登入 shell、工作目錄在倉庫外、標準輸入是平台會給的 JSON 或壞輸入）。 */
const hook = (/** @type {string} */ command, /** @type {string} */ input, cwd = tmpdir()) =>
  spawnSync('/bin/sh', ['-lc', command], { cwd, env: { ...gitEnv() }, input, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
const asTool = (/** @type {string} */ name) => JSON.stringify({ tool_name: name, tool_input: {} });
/** 全域層接線的拒絕：退 2、標準輸出空、錯誤輸出是合規 deny 形狀（hookSpecificOutput／PreToolUse／deny／理由非空）。回理由。 */
function denies(/** @type {ReturnType<typeof hook>} */ r, /** @type {string} */ why) {
  assert.equal(r.status, 2, `${why}：退出碼 ${r.status}（stdout=${String(r.stdout).slice(0, 80)}｜stderr=${String(r.stderr).slice(0, 160)}）`);
  assert.equal(r.stdout, '', `${why}：拒絕時標準輸出要空（登入 shell 往 stdout 印字會弄壞拒絕形狀，所以全域層改印到 stderr）`);
  let parsed;
  try { parsed = JSON.parse(String(r.stderr).trim()); } catch { assert.fail(`${why}：stderr 不是 JSON（${String(r.stderr).slice(0, 120)}）`); }
  const d = parsed?.hookSpecificOutput;
  assert.equal(typeof d, 'object', `${why}：缺 hookSpecificOutput`);
  assert.equal(d.hookEventName, 'PreToolUse', why);
  assert.equal(d.permissionDecision, 'deny', why);
  assert.ok(typeof d.permissionDecisionReason === 'string' && d.permissionDecisionReason.trim(), `${why}：deny 理由是空的`);
  return /** @type {string} */ (d.permissionDecisionReason);
}
const allows = (/** @type {ReturnType<typeof hook>} */ r, /** @type {string} */ why) =>
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `${why}：該放行的沒放行（或多印了東西）`);

const DENY_SMOKE = [
  ['mcp__ib__create_order_instruction', '建單（券商真實工具名）'], ['mcp__ib__delete_order_instruction', '刪單'],
  ['mcp__ib__place_order', '下單'], ['mcp__ib__cancel_order', '取消委託'], ['mcp__bank__transfer_funds', '轉帳'],
  ['mcp__bank__withdraw', '提款'], ['mcp__bank__deposit', '入金'], ['mcp__bank__wire', '電匯'], ['mcp__x__sell_stock', '賣股'],
  ['mcp__x__buyShares', '駝峰式買股——正規化要拆得開'], ['mcp__x__swap_crypto_coins', '換幣'],
];
const PASS_SMOKE = [
  ['mcp__ib__get_account_positions', '唯讀查持倉'], ['mcp__ib__get_account_orders', '唯讀查委託（⚠️ **不是靠前綴豁免**：它本來就沒命中任何拒絕規則——把 readPrefixes 清空也照樣放行，#641 r2 #1）'],
  ['mcp__ib__search_contracts', '唯讀搜尋合約'], ['mcp__notion__create_pages', '建 Notion 頁（非錢）'],
  ['mcp__slack__slack_send_message', '發訊息（send 是家族動詞、名詞不像）'], ['mcp__ib__create_watchlist', '觀察清單＝明文允許'],
  ['mcp__ib__create_alert', '提醒＝明文允許'], ['mcp__ib__update_alert', '改提醒'],
];
const EXPECTED_DENY_SMOKE = 11;
const EXPECTED_PASS_SMOKE = 8;
/** 煙霧名的家族網夾具（連接器登記成碰錢、工具名放上白名單；做法與限制＝探針 helper 的 familyNetFixture）。 */
const smokeFixture = (/** @type {any} */ f) => familyNetFixture(f, [...DENY_SMOKE, ...PASS_SMOKE].map(([name]) => name));
/** 本專案的真清單（根目錄 settings.json 的 forbidden 那一塊）：夾具那兩輪的前提「詞表照真清單」拿它比。 */
const realForbidden = () => JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8')).forbidden;
/** HARMLESS 的前提：它的連接器在真清單登記為不碰錢（拿掉了＝前提變了，不是攔截器壞了）。 */
const harmlessPremise = (/** @type {any} */ forbidden) => assert.ok(forbidden.safeServers.includes(HARMLESS_SERVER),
  `前提：settings.json 的 forbidden.safeServers 要有「${HARMLESS_SERVER}」（對照名字 ${HARMLESS} 掛在它底下）`);

/**
 * @param {(ctx: { copyDir: string, command: string, forbidden: any, copyForbidden: any }) => void} fn
 * @param {(f: any) => any} [editForbidden] 寫進來源倉庫之前改清單（雙保險那題用；其他題用真清單）
 */
function withCopy(fn, editForbidden) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pfw-codex-global-')));
  try {
    const { src, forbidden } = sourceRepo(scratch, editForbidden);
    // home 指到暫存區：「複本不可放在家目錄 .codex／.claude 底下」那條檢查不依賴真家目錄
    const { copyDir, group, failure } = build({ from: 'HEAD', to: join(scratch, 'copy'), root: src, home: scratch, allowTemp: true });
    assert.equal(failure, null, `guard-copy 自我試跑沒過：${failure}`);
    assert.equal(group.matcher, '^mcp__', '全域層接線的 matcher 變了');
    const command = group.hooks[0].command;
    for (const ph of ['{copyDir}', '{files}', '{fingerprint}']) assert.ok(!command.includes(ph), `佔位 ${ph} 沒換`);
    const copyForbidden = JSON.parse(readFileSync(join(copyDir, 'settings.json'), 'utf8')).forbidden;
    fn({ copyDir, command, forbidden, copyForbidden });
  } finally {
    // 複本是唯讀（0o444）；先開寫再刪
    const walk = (/** @type {string} */ p) => { try { chmodSync(p, 0o755); } catch { /* 沒了就算了 */ } };
    walk(scratch);
    for (const rel of COPY_FILES) walk(join(scratch, 'copy', rel));
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('①②接線印得出來、真的跑一遍：測試鈕與兩支下單工具退 2＋stderr 合規 deny（含「在拒絕清單上」）、無害工具退 0 零輸出', () => withCopy(({ command, forbidden }) => {
  const reason = denies(hook(command, asTool(CANARY)), '測試鈕要被這一組擋');
  assert.match(reason, /在拒絕清單上/u, '理由要指名是逐字清單擋的（安裝順序第⑤步認這句）');
  for (const name of FORBIDDEN_TOOLS) denies(hook(command, asTool(name)), `真下單工具 ${name}`);
  for (const name of FORBIDDEN_AFTER_RECONNECT) {
    const why = denies(hook(command, asTool(name)), `換了 UUID 的下單工具 ${name}`);
    assert.equal(reasonClass(why), 'registry', `換了 UUID 的下單工具要被登記制擋（新編號沒登記）：${why.slice(0, 100)}`);
    assert.match(why, IMPERSONATION_TAIL, '換了 UUID 的下單工具：尾句要是規則 3 那一句（當誤觸或冒名、立即回報裁示者）');
  }
  harmlessPremise(forbidden);
  allows(hook(command, asTool(HARMLESS)), '對照組：無害工具');
  assert.ok(forbidden.deny.includes(CANARY), '對照斷言：測試鈕真的在 forbidden.deny 上（不然上面那題擋它的是別的規則）');
}));

test('②煙霧測（真清單那一輪）：煙霧名全掛在沒登記的連接器上＝19 個全擋、理由「沒有登記」（錢的形狀那 11 個尾句是當冒名回報）；壞輸入 fail-closed（全都真的跑那條指令）', () => withCopy(({ command }) => {
  assert.equal(DENY_SMOKE.length, EXPECTED_DENY_SMOKE); assert.equal(PASS_SMOKE.length, EXPECTED_PASS_SMOKE);
  for (const [name, why] of DENY_SMOKE) {
    const reason = denies(hook(command, asTool(name)), `${name}（${why}）`);
    assert.equal(reasonClass(reason), 'registry', `${name}：真清單下擋它的要是登記制（${reason.slice(0, 100)}）`);
    assert.match(reason, IMPERSONATION_TAIL, `${name}：名字像錢＝尾句要是規則 3 那一句（當誤觸或冒名、立即回報裁示者）`);
  }
  // 名字不像錢的也擋（登記制：連接器沒登記＝整個擋）——它們「家族網不誤殺」的承重在下一題（夾具那一輪）
  for (const [name, why] of PASS_SMOKE) {
    const reason = denies(hook(command, asTool(name)), `${name}（${why}；真清單下連接器沒登記）`);
    assert.equal(reasonClass(reason), 'registry', `${name}：真清單下擋它的要是登記制（${reason.slice(0, 100)}）`);
  }
  assert.equal(IN_MATCHER_DENY.length, EXPECTED_IN_MATCHER_DENY); assert.equal(HANDLER_ONLY_DENY.length, EXPECTED_HANDLER_ONLY_DENY);
  for (const [payload, why] of IN_MATCHER_DENY) assert.equal(reasonClass(denies(hook(command, payload), `輸入衛生：${why}`)), 'charset', `輸入衛生（${why}）：理由要是字元集那一層`);
  for (const [payload, why] of HANDLER_ONLY_DENY) assert.equal(reasonClass(denies(hook(command, payload), `壞輸入 fail-closed：${why}`)), 'badInput', `壞輸入（${why}）：理由要是 fail-closed 那一句`);
}));

test('②煙霧測（家族網夾具那一輪）：煙霧名的連接器登記成碰錢、工具名放上白名單，錢的形狀 11 擋（理由是家族網或額外樣式）、唯讀與非錢 8 放（全都真的跑那條指令）', () => withCopy(({ command, copyForbidden }) => {
  const real = realForbidden();
  for (const key of ['verbs', 'nouns', 'readPrefixes', 'patterns', 'patternsReadSafe', 'deny']) {
    assert.deepEqual(copyForbidden[key], real[key], `前提：夾具複本的「${key}」要等於真清單（承重是真清單的詞表）`);
  }
  for (const [name, why] of DENY_SMOKE) {
    const reason = denies(hook(command, asTool(name)), `${name}（${why}）`);
    assert.equal(reasonClass(reason), 'family', `${name}：夾具下擋它的要是家族網或額外樣式（不是登記制、白名單制）：${reason.slice(0, 100)}`);
  }
  for (const [name, why] of PASS_SMOKE) allows(hook(command, asTool(name)), `${name}（${why}）`);
}, smokeFixture));

test('②複本改一個位元組＝退 2「指紋對不上」、放回去就恢復（指紋是寫死在指令裡的，不信任 node）', () => withCopy(({ copyDir, command, forbidden }) => {
  harmlessPremise(forbidden);
  const file = join(copyDir, 'settings.json');
  const original = readFileSync(file);
  const flipped = Buffer.from(original); flipped[Math.floor(flipped.length / 2)] ^= 0x01;
  chmodSync(file, 0o644); writeFileSync(file, flipped);
  const r = hook(command, asTool(HARMLESS));
  assert.equal(r.status, 2, `改過一個位元組要退 2（拿到 ${r.status}）`); assert.match(String(r.stderr), MISMATCH);
  writeFileSync(file, original); chmodSync(file, 0o444);
  allows(hook(command, asTool(HARMLESS)), '對照組：放回去就恢復');
}));

test('③整張家族矩陣直接餵印出來的指令（每個名字一次 sh＋node）：該擋的都擋、每一組擋的理由類別對、該放的都放；行程內 decide() 對複本清單再對照一次', () => withCopy(({ command, copyForbidden }) => {
  assert.equal(FORBIDDEN_FAMILY.length, EXPECTED_FORBIDDEN_FAMILY);
  assert.equal(LOOKALIKES_REGISTERED.length, EXPECTED_LOOKALIKES_REGISTERED); assert.equal(LOOKALIKES_UNREGISTERED.length, EXPECTED_LOOKALIKES_UNREGISTERED);
  assert.equal(MONEY_SERVER_DENY.length, EXPECTED_MONEY_SERVER_DENY); assert.equal(MONEY_SERVER_ALLOW.length, EXPECTED_MONEY_SERVER_ALLOW);
  assert.equal(MONEY_SERVER_MULTISEG_DENY.length, EXPECTED_MONEY_SERVER_MULTISEG_DENY); assert.equal(MONEY_SERVER_MULTISEG_ALLOW.length, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW);
  // 期望的理由類別（2026-09-27 ⑧：只斷言擋會假綠——登記制之後有一批「照樣擋、理由換了」）
  /** @type {[string, (name: string) => string][]} */
  const mustDeny = [
    ...FORBIDDEN_TOOLS.map((n) => /** @type {[string, () => string]} */ ([n, () => 'denylist'])),
    ...[...FORBIDDEN_AFTER_RECONNECT, ...FORBIDDEN_FAMILY, ...LOOKALIKES_UNREGISTERED].map((n) => /** @type {[string, () => string]} */ ([n, () => 'registry'])),
    ...MONEY_SERVER_DENY.map((t) => /** @type {[string, (n: string) => string]} */ ([MONEY_SERVER + t, (n) => (copyForbidden.deny.includes(n) ? 'denylist' : 'whitelist')])),
    ...MONEY_SERVER_MULTISEG_DENY.map(([n]) => /** @type {[string, () => string]} */ ([n, () => 'whitelist'])),
  ];
  const mustAllow = [...LOOKALIKES_REGISTERED, ...MONEY_SERVER_ALLOW.map((t) => MONEY_SERVER + t), ...MONEY_SERVER_MULTISEG_ALLOW.map(([name]) => name)];
  // 主承重：真的餵印出來的指令（舊題「誰都不能代考」那一格）
  for (const [name, expected] of mustDeny) {
    const reason = denies(hook(command, asTool(name)), `全域層指令沒擋「${name}」`);
    assert.equal(reasonClass(reason), expected(name), `全域層指令擋「${name}」的理由類別不對：${reason.slice(0, 120)}`);
  }
  for (const name of mustAllow) allows(hook(command, asTool(name)), `全域層指令誤擋「${name}」`);
  // 對照：複本裡那份清單的行程內判斷要跟指令一致（指令包裝層不看名字；兩路不同＝包裝層或複本壞了）
  for (const [name, expected] of mustDeny) {
    const d = decide(name, copyForbidden);
    assert.equal(d.deny, true, `複本裡的清單沒擋「${name}」`);
    assert.equal(reasonClass(d.why), expected(name), `複本裡的清單擋「${name}」的理由類別不對：${String(d.why).slice(0, 120)}`);
  }
  for (const name of mustAllow) assert.equal(decide(name, copyForbidden).deny, false, `複本裡的清單誤擋「${name}」：${decide(name, copyForbidden).why}`);
}));

test('③家族網夾具那一輪：夾具清單真的抽成複本、用印出來的指令真跑家族矩陣——該擋的理由是家族網或額外樣式、兩組長得像的名字都不誤殺', () => withCopy(({ command, copyForbidden }) => {
  // Claude 側那一行釘了指紋、換不了清單，所以「整張家族矩陣經過鉤子指令、擋的理由是家族網」只在這一支量。夾具＝探針 helper 的 familyNetFixture()：
  // 每個名字的連接器登記成碰錢、工具名放上白名單、詞表照真清單不動（下面先斷言）。⚠️ 這一份不拿去跑白名單精確集合與雙保險
  const real = realForbidden();
  for (const key of ['verbs', 'nouns', 'readPrefixes', 'patterns', 'patternsReadSafe', 'deny']) {
    assert.deepEqual(copyForbidden[key], real[key], `前提：夾具複本的「${key}」要等於真清單（承重是真清單的詞表）`);
  }
  for (const name of [...FORBIDDEN_AFTER_RECONNECT, ...FORBIDDEN_FAMILY]) {
    const reason = denies(hook(command, asTool(name)), `夾具下全域層指令沒擋「${name}」：真清單的詞表少了承重的詞？`);
    assert.equal(reasonClass(reason), 'family', `夾具下擋「${name}」的要是家族網或額外樣式（不是登記制、白名單制、拒絕清單）：${reason.slice(0, 120)}`);
  }
  for (const name of [...LOOKALIKES_REGISTERED, ...LOOKALIKES_UNREGISTERED]) allows(hook(command, asTool(name)), `夾具下全域層指令誤殺「${name}」`);
}, (f) => familyNetFixture(f)));

test('③白名單是精確集合（JSON 逐字＝探針清單）', () => withCopy(({ copyForbidden }) => {
  // 白名單集合：JSON 陣列逐字比（比舊制的 python AST 抽值更緊——沒有綁定形式可以繞）
  assert.deepEqual([...copyForbidden.allowlist].sort(), [...MONEY_SERVER_ALLOW].sort(), 'forbidden.allowlist 與探針清單不是同一個集合——多列＝悄悄放行，少列＝誤攔');
  assert.ok(copyForbidden.allowlist.includes('get_watchlist'), '對照斷言：下面雙保險那題的對照組名字真的在白名單上');
}));

/** 雙保險用的壞清單：逐字拒絕清單清空（不然擋它的是那一層、量不到家族網）、servers 留著、白名單誤放建單工具。 */
const breakAllowlist = (/** @type {any} */ f) => ({ ...f, deny: [], allowlist: [...f.allowlist, 'create_order_instruction'] });

test('③雙保險：白名單誤放建單工具時**家族網**仍擋——壞清單寫進來源倉庫、抽複本、用印出來的指令真跑（不只行程內 decide()）', () => withCopy(({ command, copyForbidden }) => {
  assert.ok(copyForbidden.allowlist.includes('create_order_instruction') && copyForbidden.deny.length === 0, '對照斷言：這份複本裝的真的是壞清單');
  const reason = denies(hook(command, asTool(`${MONEY_SERVER}create_order_instruction`)), '白名單誤放建單工具時，家族網必須兜底（真跑指令）');
  assert.match(reason, /家族網/u, `擋它的要是家族網（不是別層）：${reason}`);
  const d = decide(`${MONEY_SERVER}create_order_instruction`, copyForbidden);
  assert.equal(d.deny, true); assert.match(String(d.why), /家族網/u, `行程內對照也要是家族網：${d.why}`);
  // 對照組：同一份壞清單裡，名單內、家族網接不到的仍放行（證明上面不是「什麼都擋」）
  allows(hook(command, asTool(`${MONEY_SERVER}get_watchlist`)), '對照組：名單內且家族網接不到的名字要放行（真跑指令）');
}, breakAllowlist));
