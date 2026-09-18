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
 *     無害工具＝退 0 零輸出；煙霧探針 11 擋 8 放；壞輸入 fail-closed；複本改一個位元組＝退 2「指紋對不上」；
 *   ③整張家族矩陣（`test/helpers/money-family-probes.js`，位元組由另一支考題釘）**兩路都跑**：真的餵印出來的指令（每一個名字
 *     一次 sh＋node；舊題「完整矩陣直接餵 command、誰都不能代考」那一格照留），再餵複本裡那份清單的行程內 `decide()` 對照；
 *     白名單集合＝探針的 MONEY_SERVER_ALLOW（JSON 逐字集合，多列少列都紅）；白名單誤放建單工具時**家族網**仍擋（變因只留家族網：
 *     逐字拒絕清單清空、servers 留著），對照組＝名單內、家族網接不到的仍放行。
 *
 * 環境：印出來的指令用 `env -i PATH=… node` 起攔截器，環境本來就清空；那一截由套件 tests/guard-copy.test.js 的 envonly 題守，
 * 這裡不另出「髒 GIT_*」題（考題自己起 shell 時已走 gitEnv()，髒環境到不了指令＝那種題永遠綠，不留）。
 *
 * ⚠️ 誠實劃界——這支考題證明不了的事：
 *   - **Codex 會不會真的執行家目錄那一組**：要 William 在 Codex 介面（/hooks）按過「信任」才會跑，信任狀態在 ~/.codex/config.toml、
 *     不在 repo；家目錄那份實際長什麼樣、複本抽的是哪個版本，repo 的考題看不到（人做的驗收＝按測試鈕看到「在拒絕清單上」）。
 *   - 這裡抽的複本來自**這棵樹當下的檔**（造暫存倉庫、當成已合併），不是 William 機器上那份 de1cfb4 複本；
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
  FORBIDDEN_TOOLS, FORBIDDEN_AFTER_RECONNECT, FORBIDDEN_FAMILY, ALLOWED_LOOKALIKES, EXPECTED_ALLOWED_COUNT,
  IN_MATCHER_DENY, EXPECTED_IN_MATCHER_DENY, HANDLER_ONLY_DENY, EXPECTED_HANDLER_ONLY_DENY,
  MONEY_SERVER, MONEY_SERVER_DENY, EXPECTED_MONEY_SERVER_DENY, MONEY_SERVER_ALLOW, EXPECTED_MONEY_SERVER_ALLOW,
  MONEY_SERVER_MULTISEG_DENY, EXPECTED_MONEY_SERVER_MULTISEG_DENY, MONEY_SERVER_MULTISEG_ALLOW, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW,
} from './helpers/money-family-probes.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CANARY = 'mcp__guard_canary__ping';
const HARMLESS = 'mcp__other__get_widget';
const MISMATCH = /指紋對不上/u;

const base = gitEnv();
delete base.NODE_TEST_CONTEXT;
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => spawnSync('git', args, {
  cwd, encoding: 'utf8', env: { ...base, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
});

/**
 * 從這棵樹造暫存來源倉庫：攔截器會讀的四檔＋範本＋settings.json 只留 forbidden（跟 guard-copy 抽複本時一樣），提交一顆、當成已合併。
 * 讀的是**工作樹當下的檔**（含沒提交的改動），不是 origin/main。
 * @param {string} scratch
 */
function sourceRepo(scratch) {
  const src = mkdtempSync(join(scratch, 'src-'));
  mkdirSync(join(src, 'tools'));
  for (const rel of ['tools/forbidden-tools.js', 'tools/settings-data.js', 'tools/package.json', 'tools/git-env.js']) {
    cpSync(join(ROOT, rel), join(src, rel));
  }
  cpSync(join(ROOT, 'templates'), join(src, 'templates'), { recursive: true });
  const { forbidden, mainBranch } = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8'));
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
  ['mcp__ib__get_account_positions', '唯讀查持倉'], ['mcp__ib__get_account_orders', '唯讀查委託（get_ 開頭豁免）'],
  ['mcp__ib__search_contracts', '唯讀搜尋合約'], ['mcp__notion__create_pages', '建 Notion 頁（非錢）'],
  ['mcp__slack__slack_send_message', '發訊息（send 是家族動詞、名詞不像）'], ['mcp__ib__create_watchlist', '觀察清單＝明文允許'],
  ['mcp__ib__create_alert', '提醒＝明文允許'], ['mcp__ib__update_alert', '改提醒'],
];
const EXPECTED_DENY_SMOKE = 11;
const EXPECTED_PASS_SMOKE = 8;

/** @param {(ctx: { copyDir: string, command: string, forbidden: any, copyForbidden: any }) => void} fn */
function withCopy(fn) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pfw-codex-global-')));
  try {
    const { src, forbidden } = sourceRepo(scratch);
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
  for (const name of FORBIDDEN_AFTER_RECONNECT) denies(hook(command, asTool(name)), `換了 UUID 的下單工具 ${name}`);
  allows(hook(command, asTool(HARMLESS)), '對照組：無害工具');
  assert.ok(forbidden.deny.includes(CANARY), '對照斷言：測試鈕真的在 forbidden.deny 上（不然上面那題擋它的是別的規則）');
}));

test('②煙霧測：錢的形狀 11 擋、唯讀與非錢 8 放、壞輸入 fail-closed（全都真的跑那條指令）', () => withCopy(({ command }) => {
  assert.equal(DENY_SMOKE.length, EXPECTED_DENY_SMOKE); assert.equal(PASS_SMOKE.length, EXPECTED_PASS_SMOKE);
  for (const [name, why] of DENY_SMOKE) denies(hook(command, asTool(name)), `${name}（${why}）`);
  for (const [name, why] of PASS_SMOKE) allows(hook(command, asTool(name)), `${name}（${why}）`);
  assert.equal(IN_MATCHER_DENY.length, EXPECTED_IN_MATCHER_DENY); assert.equal(HANDLER_ONLY_DENY.length, EXPECTED_HANDLER_ONLY_DENY);
  for (const [payload, why] of IN_MATCHER_DENY) denies(hook(command, payload), `輸入衛生：${why}`);
  for (const [payload, why] of HANDLER_ONLY_DENY) denies(hook(command, payload), `壞輸入 fail-closed：${why}`);
}));

test('②複本改一個位元組＝退 2「指紋對不上」、放回去就恢復（指紋是寫死在指令裡的，不信任 node）', () => withCopy(({ copyDir, command }) => {
  const file = join(copyDir, 'settings.json');
  const original = readFileSync(file);
  const flipped = Buffer.from(original); flipped[Math.floor(flipped.length / 2)] ^= 0x01;
  chmodSync(file, 0o644); writeFileSync(file, flipped);
  const r = hook(command, asTool(HARMLESS));
  assert.equal(r.status, 2, `改過一個位元組要退 2（拿到 ${r.status}）`); assert.match(String(r.stderr), MISMATCH);
  writeFileSync(file, original); chmodSync(file, 0o444);
  allows(hook(command, asTool(HARMLESS)), '對照組：放回去就恢復');
}));

test('③整張家族矩陣直接餵印出來的指令（每個名字一次 sh＋node）：該擋的都擋、該放的都放；行程內 decide() 對複本清單再對照一次', () => withCopy(({ command, copyForbidden }) => {
  assert.equal(ALLOWED_LOOKALIKES.length, EXPECTED_ALLOWED_COUNT);
  assert.equal(MONEY_SERVER_DENY.length, EXPECTED_MONEY_SERVER_DENY); assert.equal(MONEY_SERVER_ALLOW.length, EXPECTED_MONEY_SERVER_ALLOW);
  assert.equal(MONEY_SERVER_MULTISEG_DENY.length, EXPECTED_MONEY_SERVER_MULTISEG_DENY); assert.equal(MONEY_SERVER_MULTISEG_ALLOW.length, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW);
  const mustDeny = [...FORBIDDEN_TOOLS, ...FORBIDDEN_AFTER_RECONNECT, ...FORBIDDEN_FAMILY,
    ...MONEY_SERVER_DENY.map((t) => MONEY_SERVER + t), ...MONEY_SERVER_MULTISEG_DENY.map(([name]) => name)];
  const mustAllow = [...ALLOWED_LOOKALIKES, ...MONEY_SERVER_ALLOW.map((t) => MONEY_SERVER + t), ...MONEY_SERVER_MULTISEG_ALLOW.map(([name]) => name)];
  // 主承重：真的餵印出來的指令（舊題「誰都不能代考」那一格）
  for (const name of mustDeny) denies(hook(command, asTool(name)), `全域層指令沒擋「${name}」`);
  for (const name of mustAllow) allows(hook(command, asTool(name)), `全域層指令誤擋「${name}」`);
  // 對照：複本裡那份清單的行程內判斷要跟指令一致（指令包裝層不看名字；兩路不同＝包裝層或複本壞了）
  for (const name of mustDeny) assert.equal(decide(name, copyForbidden).deny, true, `複本裡的清單沒擋「${name}」`);
  for (const name of mustAllow) assert.equal(decide(name, copyForbidden).deny, false, `複本裡的清單誤擋「${name}」：${decide(name, copyForbidden).why}`);
}));

test('③白名單是精確集合（JSON 逐字＝探針清單）；白名單誤放建單工具時**家族網**仍擋（變因只留家族網）', () => withCopy(({ copyForbidden }) => {
  // 白名單集合：JSON 陣列逐字比（比舊制的 python AST 抽值更緊——沒有綁定形式可以繞）
  assert.deepEqual([...copyForbidden.allowlist].sort(), [...MONEY_SERVER_ALLOW].sort(), 'forbidden.allowlist 與探針清單不是同一個集合——多列＝悄悄放行，少列＝誤攔');
  // 雙保險：逐字拒絕清單清空（不然擋它的是那一層、量不到家族網）、servers 留著、白名單誤放建單工具→家族網要兜底、理由要指名家族網
  const bad = { ...copyForbidden, deny: [], allowlist: [...copyForbidden.allowlist, 'create_order_instruction'] };
  const d = decide(`${MONEY_SERVER}create_order_instruction`, bad);
  assert.equal(d.deny, true, '白名單誤放建單工具時，家族網必須兜底');
  assert.match(String(d.why), /家族網/u, `擋它的要是家族網（不是別層）：${d.why}`);
  // 對照組：同一份壞清單裡，名單內、家族網接不到的仍放行（證明上面不是「什麼都擋」）
  assert.equal(decide(`${MONEY_SERVER}get_watchlist`, bad).deny, false, '對照組：名單內且家族網接不到的名字要放行');
  assert.ok(copyForbidden.allowlist.includes('get_watchlist'), '對照斷言：對照組用的名字真的在白名單上');
}));
