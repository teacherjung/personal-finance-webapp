/**
 * 「Codex 側錢鎖」考題（2026-09-01，.codex/hooks.json 入版控時配發；r1／r2 修訂見下）
 *
 * 承重結構（r2 之後）：**直接矩陣＋身分互鎖＋煙霧測＋結構封閉**四層——
 *   ① **全家族矩陣直接跑在 Codex 副本上**（r2 H 起的主承重）：完整
 *      FORBIDDEN／ALLOWED 清單（唯一住所＝test/helpers/money-family-probes.js，
 *      與 money-boundary.test.js 共用同一份）逐名餵 codexHook.command——
 *      Codex 真正會執行的那條指令自己考自己的試，誰都不能代考。
 *   ② **身分互鎖（同步紀律）**：matcher＋command 必須與 .claude/settings.json
 *      實際會擋錢的那組逐位相同——兩側不同步＝紅。⚠️ r2 突變實證它**不能獨自承重**：
 *      兩側同步弱化＋Claude 側另加一組原版 command，互鎖與 money-boundary 都綠、
 *      Codex 實際放行 submit_order——所以主承重是①，互鎖只守「不漂移」。
 *   ③ **行為煙霧測**：deny 斷言 Codex 0.145.0 真正的阻擋契約（hookSpecificOutput
 *      物件、hookEventName、permissionDecision、理由 trim 後非空），放行斷言
 *      stdout 全空＋跑完。只查 includes('"deny"') 的舊判準被 r1 突變打穿。
 *   ④ **結構封閉＋路徑絆線**：宣告式白名單（恰一事件／組／handler、欄位白名單）；
 *      全檔字串掃**常見**機器絕對路徑形狀——這是絆線不是安全閘（形狀列不完，
 *      完整保證靠互鎖＋兩側都過審查；r2 M 補 /private、/Volumes、正斜線磁碟機、UNC）。
 *
 * r1 修訂（Codex #536 r1，2H1M1L 全收）：deny 判準改真實阻擋契約；煙霧測補
 *   deposit／wire／cancel_order＋數量釘；結構從「只看 hooks[0]」改封閉遍歷；
 *   description 的「兩側一致」改機械維持、「回到未信任」修正為標 Modified 語意。
 * r2 修訂（Codex #536 r2，1H1M2L 全收）：H＝加①直接矩陣（互鎖代考洞，突變實證）；
 *   M＝路徑掃描擴形狀並照實降級為絆線；L＝理由判準加 trim；L＝PR 描述數字同步。
 * r3 修訂（Codex #536 r3，2H1L 全收）：H1＝helper 是兩張考卷的共同失效點——
 *   兩張考卷各釘一份 helper 外的字面身分雜湊（劃界：釘防單點改弱與小 diff 偷渡，
 *   防不了連釘一起改的人——那層靠審查制度）；H2＝結構封閉補 Array.isArray 與
 *   欄位型別（物件假扮陣列可載不進 Codex schema 卻全綠，突變實證）；
 *   L＝小節編號對齊檔頭、description 與 PR 欄位同步。
 *
 * ⚠️ 誠實劃界——這支考題證明不了的事：
 *   - **Codex 會不會真的執行這個檔案**。Codex 的 hook 要 William 在 Codex 介面
 *     （/hooks）按過「信任」才會跑；未信任＝codex exec 一聲不吭地跳過。
 *     那顆開關存在 ~/.codex/config.toml 的 [hooks.state]，不在 repo 裡，
 *     這裡管不到（2026-09-01 實測：未信任＝放行零訊息；bypass-trust＝同檔攔截成功）。
 *   - 家目錄 ~/.codex/hooks.json 那份（含個人 hook）與本檔有沒有漂移——
 *     那是機器上的檔案，repo 的考題只能對 repo 裡的東西作保證。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  FORBIDDEN_TOOLS as RAW_FORBIDDEN_TOOLS, FORBIDDEN_AFTER_RECONNECT as RAW_FORBIDDEN_AFTER_RECONNECT,
  FORBIDDEN_FAMILY as RAW_FORBIDDEN_FAMILY, ALLOWED_LOOKALIKES as RAW_ALLOWED_LOOKALIKES,
  FAMILY_VERBS as RAW_FAMILY_VERBS, FAMILY_NOUNS as RAW_FAMILY_NOUNS, FUND_KEYWORDS as RAW_FUND_KEYWORDS,
} from './helpers/money-family-probes.js';

// r4 H：身分釘與矩陣必須消費**同一份行為不可自訂的快照**——helper 匯出的陣列可以
// 自訂 Symbol.iterator 讓「序列化視圖」與「迭代視圖」分家（JSON.stringify 走索引、
// spread／for-of 走 iterator；Codex #536 r4 突變實證：釘綠、矩陣卻不再考 submit_order）。
// JSON round-trip 恰一次、之後釘與矩陣都只吃這份平凡快照＝視圖分家這一**類**等價寫法
// 整類關掉（快照是 JSON.parse 生的 plain array，沒有可自訂行為；單次讀取，Proxy 也
// 沒有第二次說謊的機會）。
const [
  FORBIDDEN_TOOLS, FORBIDDEN_AFTER_RECONNECT, FAMILY_VERBS, FAMILY_NOUNS, FUND_KEYWORDS,
  FORBIDDEN_FAMILY, ALLOWED_LOOKALIKES,
] = JSON.parse(JSON.stringify([
  RAW_FORBIDDEN_TOOLS, RAW_FORBIDDEN_AFTER_RECONNECT, RAW_FAMILY_VERBS, RAW_FAMILY_NOUNS,
  RAW_FUND_KEYWORDS, RAW_FORBIDDEN_FAMILY, RAW_ALLOWED_LOOKALIKES,
]));

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const codexFile = JSON.parse(readFileSync(path.join(ROOT, '.codex', 'hooks.json'), 'utf8'));
const claudeSettings = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));

const codexGroup = codexFile?.hooks?.PreToolUse?.[0];
const codexHook = codexGroup?.hooks?.[0];

/**
 * 跑 command、餵 stdin，回 {status, stdout}。SIGKILL 同 money-boundary r2 minor：
 * SIGTERM 可被 handler 無視、拖過 timeout，SIGKILL 不行。
 */
function runHook(command, stdinText) {
  const stdout = execFileSync('bash', ['-c', command], {
    input: stdinText, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
  });
  return stdout;
}

/** Codex 0.145.0 真正的阻擋契約：物件形狀對、欄位對、理由非空，缺一不擋。 */
function assertDenies(command, stdinText, why) {
  const stdout = runHook(command, stdinText);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    assert.fail(`${why}：stdout 不是 JSON＝不會被 Codex 當 deny（拿到：${stdout.slice(0, 80)}）`);
  }
  const d = parsed?.hookSpecificOutput;
  assert.equal(typeof d, 'object', `${why}：缺 hookSpecificOutput 物件＝不會擋（裸字串假綠是 r1 H① 的突變實證）`);
  assert.equal(d.hookEventName, 'PreToolUse', `${why}：hookEventName 不對＝不會擋`);
  assert.equal(d.permissionDecision, 'deny', `${why}：permissionDecision 不是 deny`);
  assert.ok(typeof d.permissionDecisionReason === 'string' && d.permissionDecisionReason.trim().length > 0,
    `${why}：deny 理由是空的（或全空白）——被擋的一方要看得懂為什麼`);
}

/** 放行契約：stdout 全空（任何輸出都可能被解讀）＋跑完（execFileSync 非零會 throw）。 */
function assertPasses(command, toolName, why) {
  const stdout = runHook(command, JSON.stringify({ tool_name: toolName }));
  assert.equal(stdout.trim(), '', `${why}（${toolName}）：放行時 stdout 必須全空，拿到：${stdout.slice(0, 80)}`);
}

// ---------- ① 全家族矩陣直接跑在 Codex 副本上（主承重） ----------
test('全家族矩陣直接跑在 Codex 副本的 command 上（r2 H：互鎖不可被代考）', () => {
  // r2 突變實證：兩側同步弱化＋Claude 側另加一組保留完整 command 的 hook ⇒
  // 互鎖 twins=1 照樣成立、money-boundary 由那組代考＝兩支考題全綠，但 Codex
  // 實際放行 submit_order。唯一關得死的判準＝完整矩陣**直接**餵 codexHook.command。
  for (const name of [...FORBIDDEN_TOOLS, ...FORBIDDEN_AFTER_RECONNECT, ...FORBIDDEN_FAMILY]) {
    assertDenies(codexHook.command, JSON.stringify({ tool_name: name, tool_input: {} }),
      `家族必擋名 ${name}`);
  }
  for (const name of ALLOWED_LOOKALIKES) {
    assertPasses(codexHook.command, name, '規則 2 可用名不得誤傷');
  }
});

// 禁止面字表的身分釘（r3 H1：helper 是兩張考卷的共同失效點——釘住題目本身，
// 改 helper 必須同時改本檔與 money-boundary.test.js 的同款字面雜湊；劃界見 helper 標頭）。
const FORBIDDEN_IDENTITY = 'da640bd852087ff3f171a3091238931f5932a34e5922db08c4a70978c6636373';

test('禁止面字表的身分釘：helper 的題目被改＝本考卷這裡轉紅', () => {
  const actual = createHash('sha256').update(JSON.stringify(
    [FORBIDDEN_TOOLS, FORBIDDEN_AFTER_RECONNECT, FAMILY_VERBS, FAMILY_NOUNS, FUND_KEYWORDS, FORBIDDEN_FAMILY],
  )).digest('hex');
  assert.equal(actual, FORBIDDEN_IDENTITY,
    '禁止面清單（helper）與本考卷的字面身分釘不符——增刪或改寫任何必擋探針時，'
    + '要有意識地同步更新本檔與 test/money-boundary.test.js 的兩顆釘（跑 node 重算 sha256）。');
});

// ---------- ② 身分互鎖（同步紀律；主承重在①） ----------

test('身分互鎖：Codex 副本的 matcher＋command 與 Claude 側「實際會擋錢」的那組逐位相同', () => {
  assert.ok(codexGroup && codexHook, '.codex/hooks.json 缺 PreToolUse 組或 handler');
  const twins = (claudeSettings?.hooks?.PreToolUse ?? []).filter((e) =>
    e.matcher === codexGroup.matcher &&
    (e.hooks ?? []).some((h) => h.type === 'command' && h.command === codexHook.command));
  assert.equal(twins.length, 1,
    '在 .claude/settings.json 找不到（或找到多組）matcher＋command 逐位相同的 PreToolUse hook——' +
    '兩側不同步了。改任一側都必須同步另一側（家族網的正本與全套考題在 test/money-boundary.test.js）。');
  // 互鎖對象必須是「真的會擋錢」的那組，不是恰好同 matcher 的旁觀 hook：
  assertDenies(codexHook.command,
    JSON.stringify({ tool_name: 'mcp__00000000-aaaa-bbbb-cccc-dddddddddddd__create_order_instruction' }),
    '互鎖到的 command 對典型建單名必須回合規 deny');
});

// ---------- ③ 行為煙霧測（真實 server 前綴的接地抽樣） ----------

const DENY_SMOKE = [
  // [工具名, 為什麼]
  ['mcp__ib__create_order_instruction', '建單（券商真實工具名）'],
  ['mcp__ib__delete_order_instruction', '刪單'],
  ['mcp__ib__place_order', '下單'],
  ['mcp__ib__cancel_order', '取消委託（r1 H② 點名的漏網探針）'],
  ['mcp__bank__transfer_funds', '轉帳'],
  ['mcp__bank__withdraw', '提款'],
  ['mcp__bank__deposit', '入金（r1 H② 點名）'],
  ['mcp__bank__wire', '電匯（r1 H② 點名）'],
  ['mcp__x__sell_stock', '賣股'],
  ['mcp__x__buyShares', '駝峰式買股——正規化要拆得開'],
  ['mcp__x__swap_crypto_coins', '換幣'],
];
const PASS_SMOKE = [
  ['mcp__ib__get_account_positions', '唯讀查持倉'],
  ['mcp__ib__get_account_orders', '唯讀查委託（get_ 開頭豁免）'],
  ['mcp__ib__search_contracts', '唯讀搜尋合約'],
  ['mcp__notion__create_pages', '建 Notion 頁（非錢）'],
  ['mcp__slack__slack_send_message', '發訊息（send 是家族動詞、名詞不像）'],
  ['mcp__ib__create_watchlist', '觀察清單＝明文允許'],
  ['mcp__ib__create_alert', '提醒＝明文允許'],
  ['mcp__ib__update_alert', '改提醒'],
];
// 數量釘（字面數字；同 money-boundary 的教訓：加法式的釘會跟著清單一起縮）：
const EXPECTED_DENY_SMOKE = 11;
const EXPECTED_PASS_SMOKE = 8;

test('煙霧測：錢的形狀回合規 deny、唯讀與非錢全空放行、壞輸入 fail-closed', () => {
  assert.equal(DENY_SMOKE.length, EXPECTED_DENY_SMOKE, '必擋探針清單被縮短了——數量釘要跟著有意識地改');
  assert.equal(PASS_SMOKE.length, EXPECTED_PASS_SMOKE, '放行探針清單被縮短了——數量釘要跟著有意識地改');
  for (const [name, why] of DENY_SMOKE) {
    assertDenies(codexHook.command, JSON.stringify({ tool_name: name }), `${name}（${why}）`);
  }
  for (const [name, why] of PASS_SMOKE) {
    assertPasses(codexHook.command, name, why);
  }
  // fail-closed：解析不了、缺欄位，都要當成錢擋下
  assertDenies(codexHook.command, 'not json at all', '非 JSON 要合規 deny（fail-closed）');
  assertDenies(codexHook.command, '{"no_tool_name":1}', '缺 tool_name 要合規 deny（fail-closed）');
});

// ---------- ④ 結構封閉＋路徑絆線：宣告式白名單，任何新增形狀一律紅 ----------

test('結構封閉：恰一事件、恰一組、恰一 handler、欄位白名單（第二個 handler 混不進來）', () => {
  assert.deepEqual(Object.keys(codexFile).sort(), ['description', 'hooks'],
    '檔案頂層只准 description＋hooks——多出來的鍵要先過這裡');
  assert.deepEqual(Object.keys(codexFile.hooks), ['PreToolUse'],
    'repo 副本只准有 PreToolUse——個人 hook（Stop 朗讀之類）不可跟著遷移進版控');
  assert.ok(Array.isArray(codexFile.hooks.PreToolUse),
    'PreToolUse 必須是真陣列——{"0":…,"length":1} 型的物件假扮陣列，Codex schema 載入不了，'
    + '整份鎖失去可執行形狀（r3 H2 突變實證）');
  assert.equal(codexFile.hooks.PreToolUse.length, 1, 'PreToolUse 只准一組');
  assert.deepEqual(Object.keys(codexGroup).sort(), ['hooks', 'matcher'], '組層只准 matcher＋hooks');
  assert.ok(Array.isArray(codexGroup.hooks), '內層 hooks 必須是真陣列（r3 H2 同款）');
  assert.equal(typeof codexGroup.matcher, 'string', 'matcher 必須是字串');
  assert.equal(codexGroup.matcher, '^mcp__');
  assert.equal(codexGroup.hooks.length, 1,
    'handler 恰一個——r1 突變實證：只掃 hooks[0] 時第二個 handler 可載個人內容混入');
  assert.deepEqual(Object.keys(codexHook).sort(), ['command', 'type'],
    'handler 只准 type＋command——commandWindows 等平台分流欄位一律先紅再談');
  assert.equal(codexHook.type, 'command');
  assert.equal(typeof codexHook.command, 'string', 'command 必須是字串');
});

test('絆線：全檔字串不含常見的機器絕對路徑形狀（列名式，列不完的形狀靠審查）', () => {
  // r2 M：這是**絆線不是安全閘**——絕對路徑的寫法列不完（相對路徑、變數拼接更列不完），
  // 完整保證靠「command 與 Claude 側互鎖＋兩側都過審查」，本絆線只抓常見拼法讓誤觸先紅。
  const MACHINE_PATH = /\/(Users|home|root|private|Volumes|var|tmp|opt|etc)\/|[A-Za-z]:[\\/]|\\\\/;
  const paths = [];
  (function walk(node, at) {
    if (typeof node === 'string') {
      if (MACHINE_PATH.test(node)) paths.push(at);
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${at}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
    }
  })(codexFile, '$');
  assert.deepEqual(paths, [],
    `這些位置出現機器路徑形狀（/Users、/home、/root、/private、/Volumes、/var、/tmp、/opt、/etc、`
    + `磁碟機代號、UNC）＝把單一機器的東西寫進 repo：${paths.join('、')}`);
});
