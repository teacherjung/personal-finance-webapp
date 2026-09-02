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
 *      stdout trim 後全空＋跑完。只查 includes('"deny"') 的舊判準被 r1 突變打穿。
 *   ④ **結構封閉＋路徑絆線**：宣告式白名單（恰一事件／組／handler、欄位白名單）；
 *      全檔字串掃**常見**機器絕對路徑形狀——這是絆線不是安全閘（形狀列不完；
 *      互鎖只涵蓋 matcher＋command 兩個欄位，其餘靠審查看 diff——那是殘餘守備、
 *      不是完整保證；r2 M 補 /private、/Volumes、正斜線磁碟機、UNC）。
 *
 * r1 修訂（Codex #536 r1，2H1M1L 全收）：deny 判準改真實阻擋契約；煙霧測補
 *   deposit／wire／cancel_order＋數量釘；結構從「只看 hooks[0]」改封閉遍歷；
 *   description 的「兩側一致」改機械維持、「回到未信任」修正為標 Modified 語意。
 * r2 修訂（Codex #536 r2，1H1M2L 全收）：H＝加①直接矩陣（互鎖代考洞，突變實證）；
 *   M＝路徑掃描擴形狀並照實降級為絆線；L＝理由判準加 trim；L＝PR 描述數字同步。
 * r5／r6 修訂（Codex #536 r5 1H＋r6 中間發現；William 2026-09-01 裁示「位元組釘」）：
 *   同族第五、六形＝**改寫取樣器**與**preload 注入**——同行程內「先執行的程式碼
 *   污染後面的檢查」補不完。位元組釘落地為隔離行程
 *   （test/money-family-probes-integrity.test.js，不 import helper），本檔與
 *   money-boundary 都不再自帶釘；r4 的 canonical 快照層一併拆除、其「類關閉」宣稱撤回。
 *   ⚠️ 該釘**照實定位為絆線**（擋「改了字表沒發現題目跟著變」，不擋能注入程式碼的人）
 *   ——連六輪換六形之後停止加層，理由完整寫在那支考題的檔頭。
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
import {
  FORBIDDEN_TOOLS, FORBIDDEN_AFTER_RECONNECT, FORBIDDEN_FAMILY, ALLOWED_LOOKALIKES,
  IN_MATCHER_DENY, EXPECTED_IN_MATCHER_DENY, HANDLER_ONLY_DENY, EXPECTED_HANDLER_ONLY_DENY,
  OUT_OF_MATCHER, EXPECTED_OUT_OF_MATCHER,
  MONEY_SERVER, MONEY_SERVER_DENY, EXPECTED_MONEY_SERVER_DENY,
  MONEY_SERVER_ALLOW, EXPECTED_MONEY_SERVER_ALLOW,
  MONEY_SERVER_MULTISEG_DENY, EXPECTED_MONEY_SERVER_MULTISEG_DENY,
} from './helpers/money-family-probes.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const codexFile = JSON.parse(readFileSync(path.join(ROOT, '.codex', 'hooks.json'), 'utf8'));
const claudeSettings = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));

const codexGroup = codexFile?.hooks?.PreToolUse?.[0];
const codexHook = codexGroup?.hooks?.[0];

/**
 * 跑 command、餵 stdin，**回 stdout 字串**；非零退出碼由 execFileSync 直接 throw
 * （r8 L：原註解寫「回 {status, stdout}」與實作不符）。SIGKILL 同 money-boundary r2 minor：
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

/**
 * 放行契約：stdout **trim 後**全空＋跑完（execFileSync 非零會 throw）。
 * 為什麼是 trim 而不是嚴格空字串（Grok 掃第 4 條）：純空白對 Codex 的解析等同無輸出，
 * 判準照實對齊實作，不寫比實作嚴的宣稱。
 */
function assertPasses(command, toolName, why) {
  const stdout = runHook(command, JSON.stringify({ tool_name: toolName }));
  assert.equal(stdout.trim(), '', `${why}（${toolName}）：放行時 stdout 必須 trim 後全空，拿到：${stdout.slice(0, 80)}`);
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

// 字表 helper 的位元組絆線在**隔離行程**的 test/money-family-probes-integrity.test.js
// （Codex #536 r5：同行程內的釘可被 helper 自己改寫取樣器而假綠——ESM 靜態 import
// 一律先於本檔程式碼執行。換行程擋掉的是那一形，不是終點——r6 已證明還有別的形；
// 該檔頭有完整劃界。本檔因此不再自帶位元組釘）。


test('v6 輸入衛生：matcher 命中的怪形狀，成對驗證（matcher 接得住 ∧ handler 擋得下）', () => {
  assert.equal(IN_MATCHER_DENY.length, EXPECTED_IN_MATCHER_DENY, '探針被縮短了——數量釘要有意識地改');
  for (const [payload, why] of IN_MATCHER_DENY) {
    const name = JSON.parse(payload).tool_name;
    assert.equal(typeof name, 'string', `這批每一支都必須有字串工具名，否則屬於 HANDLER_ONLY_DENY：${why}`);
    // r1 H1：只驗 handler 會假綠——matcher 不命中時整個 hook 不執行。兩者成對才算數。
    assert.ok(new RegExp(codexGroup.matcher).test(name), `matcher 不命中，不該放在這批：${why}`);
    assertDenies(codexHook.command, payload, `輸入衛生：${why}`);
  }
});

test('v6 壞輸入：沒有工具名可比 matcher，只驗 handler 自己的 fail-closed', () => {
  // r2 M1：這三支原本混在上一題裡、群組名宣稱「端到端」——超出實際證明力，已拆開誠實標示。
  assert.equal(HANDLER_ONLY_DENY.length, EXPECTED_HANDLER_ONLY_DENY, '探針被縮短了');
  for (const [payload, why] of HANDLER_ONLY_DENY) {
    assertDenies(codexHook.command, payload, `壞輸入 fail-closed（僅 handler 層）：${why}`);
  }
});

test('v6 射程劃界：matcher 篩不到的形狀＝hook 不會執行（不假裝它們被擋）', () => {
  assert.equal(OUT_OF_MATCHER.length, EXPECTED_OUT_OF_MATCHER, '探針被縮短了');
  for (const [name, why] of OUT_OF_MATCHER) {
    assert.equal(new RegExp(codexGroup.matcher).test(name), false,
      `${why}：這個形狀現在 matcher 命中了——它就落進 hook 射程，該移到 IN_MATCHER_DENY 並驗 handler 會擋`);
  }
});

test('v6 姿態閘：已宣告的動錢連接器採白名單制（名單外一律擋、名單內照常放行）', () => {
  assert.equal(MONEY_SERVER_DENY.length, EXPECTED_MONEY_SERVER_DENY, '名單外探針被縮短了');
  assert.equal(MONEY_SERVER_ALLOW.length, EXPECTED_MONEY_SERVER_ALLOW, '名單內探針被縮短了');
  for (const t of MONEY_SERVER_DENY) {
    assertDenies(codexHook.command, JSON.stringify({ tool_name: MONEY_SERVER + t }),
      `動錢連接器上的名單外工具 ${t}（不管它叫什麼名字）`);
  }
  for (const t of MONEY_SERVER_ALLOW) {
    assertPasses(codexHook.command, MONEY_SERVER + t, '名單內的唯讀／提醒／觀察清單工具');
  }
});


test('v6 姿態閘：白名單是精確集合（指令裡的 ALLOW 與探針逐項相等，多一個少一個都紅）', () => {
  // Grok #540 掃第 2 條：只驗「這些擋、那些放」時，指令裡的 ALLOW 可以是探針的**超集**——
  // 少了會紅、多了仍綠，於是「32 個精確身分」這句話機器並沒有在守。改成集合相等。
  const m = codexHook.command.match(/ALLOW = \(([\s\S]*?)\)\n/);
  assert.ok(m, '在 hook 指令裡找不到 ALLOW 清單——白名單的形狀變了，這題要跟著改');
  const inCommand = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual([...inCommand].sort(), [...MONEY_SERVER_ALLOW].sort(),
    '指令裡的白名單與探針清單不是同一個集合——多列＝悄悄放行，少列＝誤攔');
});

test('v6 姿態閘：雙保險真的存在（白名單誤放建單工具時，家族網仍擋得住）', () => {
  // Grok #540 掃第 2 條後半：對現行 32 個名字，「名單內再走家族網」是空轉的
  // （那些名字家族網本來就不擋），所以原本的題面證明不了雙保險。
  // 這裡直接構造「ALLOW 誤含建單工具」的變體指令來驗——這才是雙保險唯一會派上用場的情境。
  const bad = codexHook.command.replace('"provide_customer_feedback",',
    '"provide_customer_feedback", "create_order_instruction",');
  assert.notEqual(bad, codexHook.command, '變體沒有生效——錨點文字變了，這題要跟著改');
  assertDenies(bad, JSON.stringify({ tool_name: `${MONEY_SERVER}create_order_instruction` }),
    '白名單誤放建單工具時，家族網必須兜底');
});

test('v6 姿態閘：UUID 不在第一段時也要擋（多段前綴）', () => {
  assert.equal(MONEY_SERVER_MULTISEG_DENY.length, EXPECTED_MONEY_SERVER_MULTISEG_DENY, '探針被縮短了');
  for (const [name, why] of MONEY_SERVER_MULTISEG_DENY) {
    assertDenies(codexHook.command, JSON.stringify({ tool_name: name }), `多段前綴：${why}`);
  }
});

// ---------- ② 身分互鎖（同步紀律；主承重在①） ----------

test('身分互鎖：Codex 副本的 matcher＋command 與 Claude 側「實際會擋錢」的那組逐位相同', () => {
  assert.ok(codexGroup && codexHook, '.codex/hooks.json 缺 PreToolUse 組或 handler');
  const twins = (claudeSettings?.hooks?.PreToolUse ?? []).filter((e) =>
    e.matcher === codexGroup.matcher &&
    (e.hooks ?? []).some((h) => h.type === 'command' && h.command === codexHook.command));
  assert.equal(twins.length, 1,
    '在 .claude/settings.json 找不到（或找到多組）matcher＋command 逐位相同的 PreToolUse hook——' +
    '兩側不同步了。改任一側都必須同步另一側（生產詞表住在這兩份 command 裡，'
    + 'test/helpers/money-family-probes.js 是**探針**的唯一住所、不是詞表正本；'
    + 'Claude 側的同款全套考題在 test/money-boundary.test.js）。');
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

test('煙霧測：錢的形狀回合規 deny、唯讀與非錢 trim 後全空放行、壞輸入 fail-closed', () => {
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
  assert.equal(typeof codexFile.description, 'string',
    'description 必須是字串——Codex 的 HooksFile 把它定義成 Option<String>，'
    + '改成物件或陣列會讓 loader 拒收整份檔案（Codex #536 r7 H）');
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
  // r2 M：這是**絆線不是安全閘**——絕對路徑的寫法列不完（相對路徑、變數拼接更列不完）。
  // 互鎖只涵蓋 matcher＋command 兩個欄位，其餘漂移靠審查看 diff＝殘餘守備、不是完整保證
  // （r8 M①：這裡原本寫「完整保證靠互鎖＋審查」，與檔頭互斥，已刪）。
  // 本絆線只抓常見拼法讓誤觸先紅。
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
  // ⚠️ 列名式＝形狀列不完；互鎖只涵蓋 matcher＋command，其餘漂移靠審查看 diff（殘餘守備）。
  assert.deepEqual(paths, [],
    `這些位置出現機器路徑形狀（/Users、/home、/root、/private、/Volumes、/var、/tmp、/opt、/etc、`
    + `磁碟機代號、UNC）＝把單一機器的東西寫進 repo：${paths.join('、')}`);
});
