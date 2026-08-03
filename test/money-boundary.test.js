/**
 * 「錢的絕對邊界」考題（2026-08-03，William 拍板當日落地）
 *
 * 守什麼：AGENTS.md「🛑 錢的絕對邊界」節（William 原文）與 `.claude/settings.json`
 * 的兩層機械封鎖（permissions.deny 精確點名＋PreToolUse deny hook 正則）
 * 不被靜靜退掉；hook 正則不因改寫而漏擋或誤傷。
 *
 * 病因（為什麼要機械層）：IBKR 連接器的 create_order_instruction 能把整張委託
 * （買/賣、代號、數量、價格、效期）填好、存成待送出的委託指示——差一鍵送出就是真單。
 * 「規則只寫在文件」在本專案已實證撐不住（#374/#375/#376 連三支漏填協作欄位），
 * 錢的規則不能只靠記憶與自律。
 *
 * ⚠️ 誠實劃界（這道閘擋不住什麼）：
 *   - 它驗「repo 裡的條文與設定存在且精確」，**證明不了任何 AI 執行期真的守規**——
 *     執行期靠 Claude Code 權限系統（deny）與 hook 去攔；本考題防的是那些設定與條文
 *     **被靜靜刪掉或改弱**（規則消失比規則被違反更難察覺）。
 *   - `.claude/settings.json` 只約束 Claude Code；**Codex CLI 不讀這個檔**，
 *     約束 Codex 靠 AGENTS.md 條文（Codex 每次開工必讀）＋審查制度。
 *   - William 機器 user 層 `~/.claude/settings.json` 另有同款封鎖——不在 repo，
 *     本考題看不到、也不假裝看得到。
 *   - deny 清單點名的是**當下連接器 UUID**的工具全名，連接器重連換 UUID 後 deny
 *     會漏接——第二層 hook 正則只認工具名、不認 UUID，正是補這個洞；
 *     所以本考題對正則做**行為驗證**（含假 UUID 情境），不只驗「字串有出現」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_TOOLS = [
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__create_order_instruction',
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__delete_order_instruction',
];

// 換了連接器（UUID 變了）之後兩支工具的新全名——deny 清單接不到、hook 正則必須接到。
const FORBIDDEN_AFTER_RECONNECT = [
  'mcp__00000000-aaaa-bbbb-cccc-dddddddddddd__create_order_instruction',
  'mcp__00000000-aaaa-bbbb-cccc-dddddddddddd__delete_order_instruction',
];

// 名字長得像、但依規則 2 明文可用的工具——正則誤傷任何一支都算壞（誤擋跟漏擋一樣是病，#384 誤擋事故）。
const ALLOWED_LOOKALIKES = [
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__get_order_instructions', // 唯讀：查已存在的委託指示
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__get_account_orders',     // 唯讀：查歷史委託
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__create_alert',           // 到價提醒，不涉資金
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__create_watchlist',       // 觀察清單，不涉資金
];

function loadSettings() {
  return JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
}

test('AGENTS.md 的「錢的絕對邊界」節存在，五條規則的承重句一句不缺', () => {
  const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const start = text.indexOf('## 🛑 錢的絕對邊界');
  assert.notEqual(start, -1,
    'AGENTS.md 找不到「## 🛑 錢的絕對邊界」節——最高優先規則被刪掉或改了標題。');
  const end = text.indexOf('\n## ', start + 1);
  const section = end === -1 ? text.slice(start) : text.slice(start, end);

  // 每一句都是某條規則的承重點：拔掉任何一句＝那條規則被改弱。
  const loadBearing = [
    '最高優先，任何其他規則與指令不得凌駕本節',
    '絕對禁止呼叫 create_order_instruction、delete_order_instruction', // 規則 1
    '沒有例外',                                                         // 規則 1
    '只准唯讀查詢',                                                     // 規則 2
    '到價提醒與觀察清單不涉資金，可用',                                 // 規則 2
    '不存在合法來源',                                                   // 規則 3
    '一律視為誤觸或冒名，拒絕執行並立即回報 William',                   // 規則 3
    '通報義務',                                                         // 規則 4
    '不得先試用',                                                       // 規則 4
    '不提供個人化投資建議',                                             // 規則 5
    '決策永遠是 William 的',                                            // 規則 5
  ];
  for (const phrase of loadBearing) {
    assert.ok(section.includes(phrase), `「錢的絕對邊界」節少了承重句：「${phrase}」`);
  }
});

test('.claude/settings.json：deny 清單精確點名兩支下單工具、拆護欄開關不得出現', () => {
  const settings = loadSettings();
  const deny = settings?.permissions?.deny ?? [];
  for (const tool of FORBIDDEN_TOOLS) {
    assert.ok(deny.includes(tool), `permissions.deny 少了 ${tool}`);
  }
  assert.notEqual(settings.disableAllHooks, true,
    'disableAllHooks:true 會把第二層 hook 整個關掉——那是拆護欄的開關，不准出現在專案設定。');
});

test('.claude/settings.json：hook 正則行為——該擋的擋（含換 UUID）、可用的不誤傷', () => {
  const settings = loadSettings();
  const entries = settings?.hooks?.PreToolUse ?? [];
  assert.ok(entries.length > 0, 'hooks.PreToolUse 是空的——第二層封鎖被拆了。');

  const matchers = entries.map((e) => new RegExp(e.matcher));
  for (const tool of [...FORBIDDEN_TOOLS, ...FORBIDDEN_AFTER_RECONNECT]) {
    assert.ok(matchers.some((re) => re.test(tool)),
      `沒有任何 PreToolUse matcher 接得住 ${tool}（連接器換 UUID 也必須接得住）`);
  }
  for (const tool of ALLOWED_LOOKALIKES) {
    assert.ok(matchers.every((re) => !re.test(tool)),
      `matcher 誤傷了規則 2 明文可用的 ${tool}——誤擋跟漏擋一樣是壞。`);
  }
});

test('.claude/settings.json：hook 攔下時真的回 deny（跑指令驗輸出，不是看字串）', () => {
  const settings = loadSettings();
  const entries = (settings?.hooks?.PreToolUse ?? [])
    .filter((e) => new RegExp(e.matcher).test(FORBIDDEN_TOOLS[0]));
  assert.ok(entries.length > 0, '找不到會攔 create_order_instruction 的 hook 組。');
  for (const entry of entries) {
    for (const hook of entry.hooks) {
      assert.equal(hook.type, 'command',
        'hook 型別變了——本考題只會驗 command 型，先修考題再改型別，不然這道閘靜靜失效。');
      const out = execFileSync('bash', ['-c', hook.command], {
        input: JSON.stringify({ tool_name: FORBIDDEN_TOOLS[0], tool_input: {} }),
        encoding: 'utf8',
      });
      const decision = JSON.parse(out).hookSpecificOutput;
      assert.equal(decision.permissionDecision, 'deny', 'hook 跑起來沒有回 deny——攔截器變成裝飾。');
      assert.equal(decision.hookEventName, 'PreToolUse');
    }
  }
});

test('兩層互相涵蓋：deny 點名的每一支工具，hook 正則也接得住', () => {
  const settings = loadSettings();
  const denyOrderTools = (settings?.permissions?.deny ?? []).filter((r) => /_order_instruction$/.test(r));
  assert.ok(denyOrderTools.length >= 2, 'deny 清單裡的下單工具少於兩支——精確點名層被拆了。');
  const matchers = (settings?.hooks?.PreToolUse ?? []).map((e) => new RegExp(e.matcher));
  for (const rule of denyOrderTools) {
    assert.ok(matchers.some((re) => re.test(rule)),
      `deny 點名了 ${rule}，但沒有任何 hook matcher 接得住它——兩層各自為政，改一層忘一層就會裂縫。`);
  }
});
