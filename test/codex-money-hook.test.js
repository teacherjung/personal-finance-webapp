/**
 * 「Codex 側錢鎖的腦子」考題（2026-09-01，.codex/hooks.json 入版控時配發）
 *
 * 這支釘的是 `.codex/hooks.json` 裡那條 PreToolUse hook 的**判斷邏輯**：
 * 會動到錢的工具名（下單／轉帳／買賣／換匯…含駝峰式變形）一律 deny、
 * 唯讀與非錢工具一律放行、明文允許的觀察清單／提醒類放行、
 * 餵它壞資料（非 JSON、缺 tool_name）也要 deny（fail-closed）。
 *
 * 判準是**黑箱**：把檔案裡的 command 原樣拿出來跑、餵 stdin JSON、看輸出——
 * 不重抄它的正規式。這樣鎖裡的規則怎麼改寫都行，**行為**變了才轉紅。
 *
 * ⚠️ 誠實劃界——這支考題證明不了的事：
 *   - **Codex 會不會真的執行這個檔案**。Codex 的 hook 要 William 在 Codex 介面
 *     （/hooks）按過「信任」才會跑；未信任＝codex exec 一聲不吭地跳過。
 *     那顆開關存在 ~/.codex/config.toml 的 [hooks.state]，不在 repo 裡，
 *     這裡管不到（2026-09-01 實測：未信任＝放行零訊息；bypass-trust＝同檔攔截成功）。
 *   - 家目錄 ~/.codex/hooks.json 那份（含個人 hook）與本檔有沒有漂移——
 *     那是機器上的檔案，repo 的考題只能對 repo 裡的東西作保證。
 *   - Claude 側 .claude/settings.json 的同款 hook——兩邊獨立演化，不在此互鎖。
 *
 * 另釘兩條結構不變量：
 *   ① repo 副本只准有 PreToolUse——個人 hook（如朗讀腳本）絕不可跟著遷移進版控；
 *   ② command 裡不准出現絕對家目錄路徑——那是「這台機器」的東西，不是 repo 的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hooksFile = JSON.parse(readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8'));

/** 跑檔案裡的 command，回 'deny' 或 'pass'（放行＝無 deny 輸出） */
function runHook(command, stdinText) {
  const r = spawnSync('bash', ['-c', command], { input: stdinText, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.error, undefined, `hook 指令跑不起來：${r.error}`);
  return r.stdout.includes('"deny"') ? 'deny' : 'pass';
}

test('結構不變量：repo 副本只有 PreToolUse、恰一組、matcher 對準 mcp 工具', () => {
  assert.deepEqual(Object.keys(hooksFile.hooks), ['PreToolUse'],
    'repo 副本只准有 PreToolUse——個人 hook 不可跟著遷移進版控');
  assert.equal(hooksFile.hooks.PreToolUse.length, 1);
  assert.equal(hooksFile.hooks.PreToolUse[0].matcher, '^mcp__');
});

test('結構不變量：command 不含這台機器的家目錄路徑', () => {
  const cmd = hooksFile.hooks.PreToolUse[0].hooks[0].command;
  assert.ok(!/\/Users\/|\/home\//.test(cmd),
    'command 出現絕對家目錄路徑＝把單一機器的東西寫進 repo');
});

test('錢的形狀一律 deny、唯讀與非錢一律放行、壞輸入 fail-closed', () => {
  const cmd = hooksFile.hooks.PreToolUse[0].hooks[0].command;
  const cases = [
    // [工具名, 期望, 為什麼]
    ['mcp__ib__create_order_instruction', 'deny', '建單（券商真實工具名）'],
    ['mcp__ib__delete_order_instruction', 'deny', '刪單'],
    ['mcp__ib__place_order', 'deny', '下單'],
    ['mcp__bank__transfer_funds', 'deny', '轉帳'],
    ['mcp__bank__withdraw', 'deny', '提款'],
    ['mcp__x__sell_stock', 'deny', '賣股'],
    ['mcp__x__buyShares', 'deny', '駝峰式買股——正規化要拆得開'],
    ['mcp__x__swap_crypto_coins', 'deny', '換幣'],
    ['mcp__ib__get_account_positions', 'pass', '唯讀查持倉'],
    ['mcp__ib__get_account_orders', 'pass', '唯讀查委託（get_ 開頭豁免）'],
    ['mcp__ib__search_contracts', 'pass', '唯讀搜尋合約'],
    ['mcp__notion__create_pages', 'pass', '建 Notion 頁（非錢）'],
    ['mcp__slack__slack_send_message', 'pass', '發訊息（非錢）'],
    ['mcp__ib__create_watchlist', 'pass', '觀察清單＝明文允許'],
    ['mcp__ib__create_alert', 'pass', '提醒＝明文允許'],
    ['mcp__ib__update_alert', 'pass', '改提醒'],
  ];
  for (const [name, want, why] of cases) {
    assert.equal(runHook(cmd, JSON.stringify({ tool_name: name })), want, `${name}（${why}）`);
  }
  // fail-closed：解析不了、缺欄位，都要當成錢擋下
  assert.equal(runHook(cmd, 'not json at all'), 'deny', '非 JSON 要 deny（fail-closed）');
  assert.equal(runHook(cmd, '{"no_tool_name":1}'), 'deny', '缺 tool_name 要 deny（fail-closed）');
});
