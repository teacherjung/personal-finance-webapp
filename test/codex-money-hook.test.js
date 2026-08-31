/**
 * 「Codex 側錢鎖」考題（2026-09-01，.codex/hooks.json 入版控時配發；r1 修訂見下）
 *
 * 承重結構（r1 之後）：**身分互鎖＋行為煙霧測＋結構封閉**三層——
 *   ① **身分互鎖**：`.codex/hooks.json` 的 matcher 與 command 必須與
 *      `.claude/settings.json` 裡「實際會 deny 錢類工具名」的那組 PreToolUse hook
 *      **逐位相同**。這一鎖讓 `test/money-boundary.test.js` 的整套家族攔截考題
 *      （60+ 支必擋探針＋36 支誤傷探針＋數量釘）**對 Codex 副本共同承重**：
 *      改弱 Claude 側＝那支紅；兩側不同步＝本支紅。家族網完整性的正本在那支，
 *      本檔刻意不複抄那四張字表（複本會漂）。
 *   ② **行為煙霧測**：把檔案裡的 command 原樣拿出來跑、餵 stdin JSON——
 *      deny 斷言的是 Codex 0.145.0 真正的阻擋契約（`hookSpecificOutput` 物件、
 *      `hookEventName: 'PreToolUse'`、`permissionDecision: 'deny'`、理由非空），
 *      放行斷言的是「stdout 全空＋exit 0」。只查 `includes('"deny"')` 的舊判準
 *      被 Codex r1 突變實證打穿（輸出裸字串 "deny" 可假綠但 Codex 不會擋）。
 *   ③ **結構封閉**：宣告式白名單——恰一個事件（PreToolUse）、恰一組、恰一個
 *      handler、handler 只准 {type:'command', command}（`commandWindows` 等平台
 *      分流欄位一律紅）；全檔任何字串出現機器絕對路徑（/Users、/home、/root、
 *      磁碟機代號）一律紅。r1 突變實證：只掃 hooks[0] 時，第二個 handler 可以
 *      載著個人朗讀路徑混進來。
 *
 * r1 修訂（Codex #536 r1，2H1M1L 全收）：
 *   - H①：deny 判準從「stdout 含 "deny" 字樣」改為解析完整阻擋契約（見②）。
 *   - H②：8 支 deny fixture 守不住家族網（只認名單的突變 command 可假綠）——
 *          改身分互鎖讓 money-boundary 全家族考題承重（見①），煙霧測補
 *          deposit／wire／cancel_order 三支 r1 點名的漏網探針＋字面數量釘。
 *   - M：結構不變量從「只看第一個 handler」改為封閉遍歷（見③）。
 *   - L：description 的「兩側一致」從口頭現況保證改為由①機械維持；
 *        「回到未信任」修正為 Codex 的實際狀態語意（標 Modified、停止執行）。
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
  assert.ok(typeof d.permissionDecisionReason === 'string' && d.permissionDecisionReason.length > 0,
    `${why}：deny 理由是空的——被擋的一方要看得懂為什麼`);
}

/** 放行契約：stdout 全空（任何輸出都可能被解讀）＋跑完（execFileSync 非零會 throw）。 */
function assertPasses(command, toolName, why) {
  const stdout = runHook(command, JSON.stringify({ tool_name: toolName }));
  assert.equal(stdout.trim(), '', `${why}（${toolName}）：放行時 stdout 必須全空，拿到：${stdout.slice(0, 80)}`);
}

// ---------- ① 身分互鎖：讓 money-boundary 的全家族考題對 Codex 副本承重 ----------

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

// ---------- ② 行為煙霧測（家族完整性由①承重；這裡是直接接地的抽樣） ----------

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

// ---------- ③ 結構封閉：宣告式白名單，任何新增形狀一律紅 ----------

test('結構封閉：恰一事件、恰一組、恰一 handler、欄位白名單（第二個 handler 混不進來）', () => {
  assert.deepEqual(Object.keys(codexFile).sort(), ['description', 'hooks'],
    '檔案頂層只准 description＋hooks——多出來的鍵要先過這裡');
  assert.deepEqual(Object.keys(codexFile.hooks), ['PreToolUse'],
    'repo 副本只准有 PreToolUse——個人 hook（Stop 朗讀之類）不可跟著遷移進版控');
  assert.equal(codexFile.hooks.PreToolUse.length, 1, 'PreToolUse 只准一組');
  assert.deepEqual(Object.keys(codexGroup).sort(), ['hooks', 'matcher'], '組層只准 matcher＋hooks');
  assert.equal(codexGroup.matcher, '^mcp__');
  assert.equal(codexGroup.hooks.length, 1,
    'handler 恰一個——r1 突變實證：只掃 hooks[0] 時第二個 handler 可載個人內容混入');
  assert.deepEqual(Object.keys(codexHook).sort(), ['command', 'type'],
    'handler 只准 type＋command——commandWindows 等平台分流欄位一律先紅再談');
  assert.equal(codexHook.type, 'command');
});

test('結構封閉：全檔任何字串不含機器絕對路徑', () => {
  const paths = [];
  (function walk(node, at) {
    if (typeof node === 'string') {
      if (/\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\/.test(node)) paths.push(at);
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${at}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
    }
  })(codexFile, '$');
  assert.deepEqual(paths, [],
    `這些位置出現機器絕對路徑（/Users、/home、/root、磁碟機代號）＝把單一機器的東西寫進 repo：${paths.join('、')}`);
});
