/**
 * 「錢的絕對邊界」考題（2026-08-03，William 拍板當日落地；r1／r2 修訂見下）
 *
 * 守什麼：AGENTS.md「🛑 錢的絕對邊界」節（William 原文）與 `.claude/settings.json`
 * 的兩層機械封鎖（permissions.deny 精確點名＋PreToolUse deny hook 正則）
 * 不被靜靜退掉；hook 層不因改寫而漏擋或誤傷。
 *
 * 病因（為什麼要機械層）：IBKR 連接器的 create_order_instruction 能把整張委託
 * （買/賣、代號、數量、價格、效期）填好、存成待送出的委託指示——差一鍵送出就是真單。
 * 「規則只寫在文件」在本專案已實證撐不住（#374/#375/#376 連三支漏填協作欄位），
 * 錢的規則不能只靠記憶與自律。
 *
 * r1 修訂（Codex #392 r1）：hooks 掏空成 [] 時舊版內層迴圈零次執行＝假綠 → 改行為分類；
 * 誤傷斷言只掃封鎖組，良性 PreToolUse hook（純記錄）不被錯殺。
 *
 * r2 修訂（Codex #392 r2）：
 *   - important：r1 版的 denyProbe 固定拿 create 探測、把整個 entry 靜態定性一次——
 *     「看輸入決定」的 handler（create→deny、delete→allow）可假綠，連接器換 UUID 後
 *     delete 實際上是放行的。改成 **per-tool 配對驗證**：每一個必擋名都要有
 *     「matcher 接得住 ∧ handler 對這個名字實跑回 deny」的組才算數；
 *     誤傷判準同樣配對（matcher 命中 ∧ 對該名字回 deny 才算誤傷）。
 *   - minor：execFileSync 預設 killSignal=SIGTERM 可被 handler 無視、拖過 timeout →
 *     killSignal 改 **SIGKILL**（不可忽略）。
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
 *     所以本考題對 hook 做**逐名行為驗證**（含假 UUID 情境），不只驗「字串有出現」。
 *   - 正則只涵蓋這兩個工具名：**place_order／submit_order／transfer_funds 之類
 *     未來同族錢類工具不在正則內**（Codex #392 r1 實測七個同族假想名全不匹配）。
 *     那一段靠規則 1 的語意（「任何現在或未來…的工具」）＋規則 4 的通報義務接手；
 *     這是設計不是疏漏——列舉未來工具名的清單永遠列不完（列舉繞法補不完的同型病）。
 *   - SIGKILL 殺的是直接子行程（bash）；handler 若刻意生出「抓住 stdout 的孤兒孫行程」
 *     理論上仍能拖延考題（repo 內的 handler 是受審的 echo 一行，這條寫著防未來）。
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

// 換了連接器（UUID 變了）之後兩支工具的新全名——deny 清單接不到、hook 層必須接到。
const FORBIDDEN_AFTER_RECONNECT = [
  'mcp__00000000-aaaa-bbbb-cccc-dddddddddddd__create_order_instruction',
  'mcp__00000000-aaaa-bbbb-cccc-dddddddddddd__delete_order_instruction',
];

// 名字長得像、但依規則 2 明文可用的工具——對這些名字「matcher 命中且回 deny」都算誤傷
// （誤擋跟漏擋一樣是病，#384 誤擋事故）。
const ALLOWED_LOOKALIKES = [
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__get_order_instructions', // 唯讀：查已存在的委託指示
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__get_account_orders',     // 唯讀：查歷史委託
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__create_alert',           // 到價提醒，不涉資金
  'mcp__deda1d5d-1ccc-4551-9617-156b9658d236__create_watchlist',       // 觀察清單，不涉資金
];

function loadSettings() {
  return JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
}

const probeCache = new Map();

/**
 * 行為探測：這個 handler 收到「這個工具名」時，是不是回合規的 deny？
 * 逐名探測（Codex #392 r2）：不可拿一個名字的結果代表整個 entry——
 * 「看輸入決定」的 handler 可以對 create 說 deny、對 delete 說 allow。
 * @param {{ type?: string, command?: string }} hook
 * @param {string} toolName
 */
function denyProbe(hook, toolName) {
  if (!hook || hook.type !== 'command' || !hook.command) return false;
  const key = JSON.stringify([hook.command, toolName]);
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const out = execFileSync('bash', ['-c', hook.command], {
      input: JSON.stringify({ tool_name: toolName, tool_input: {} }),
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL', // Codex #392 r2 minor：SIGTERM 可被無視，SIGKILL 不行
    });
    const d = JSON.parse(out).hookSpecificOutput;
    ok = d?.permissionDecision === 'deny' && d?.hookEventName === 'PreToolUse';
  } catch {
    // 跑不動、輸出不是 JSON——ok 維持 false（fail-closed：不計數）
  }
  probeCache.set(key, ok);
  return ok;
}

/**
 * 對「這個工具名」而言的封鎖組：matcher 接得住這個名字，且至少一個 handler
 * 對**這個名字**實跑回 deny（matcher 與 handler 決策成對驗證，Codex #392 r2）。
 * @param {any} settings @param {string} toolName
 */
function entriesBlocking(settings, toolName) {
  return (settings?.hooks?.PreToolUse ?? []).filter((e) =>
    new RegExp(e.matcher).test(toolName) && (e.hooks ?? []).some((h) => denyProbe(h, toolName)));
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

test('.claude/settings.json：hook 層逐名配對——每個必擋名都有實跑回 deny 的組、可用名一律不誤傷', () => {
  const settings = loadSettings();
  // ⚠️ 正反兩面都是「matcher ∧ handler 決策」成對驗證（Codex #392 r2 important）：
  //    只驗 matcher 會被「看輸入決定」的 handler 假綠（create 擋、delete 放）；
  //    只驗 handler 會漏掉 matcher 涵蓋不到的名字。兩者對同一個名字同時成立才算數。
  for (const tool of [...FORBIDDEN_TOOLS, ...FORBIDDEN_AFTER_RECONNECT]) {
    assert.ok(entriesBlocking(settings, tool).length >= 1,
      `沒有任何 hook 組對 ${tool} 是「matcher 接得住＋handler 實跑回 deny」——`
      + '空殼、改輸出、或「看輸入決定」的偏心 handler 都算沒擋（連接器換 UUID 也必須擋得住）。');
  }
  // 誤傷＝matcher 命中「且」對該名字實跑回 deny。純記錄的良性 hook（不 deny）不歸本考題管，
  // 不會被錯殺（Codex #392 r1 minor②）。
  for (const tool of ALLOWED_LOOKALIKES) {
    assert.equal(entriesBlocking(settings, tool).length, 0,
      `有 hook 組對規則 2 明文可用的 ${tool} 實跑回 deny——誤擋跟漏擋一樣是壞。`);
  }
});

test('.claude/settings.json：匹配下單工具的 hook 組不是空殼（r1 假綠路徑回歸考）', () => {
  const settings = loadSettings();
  const matching = (settings?.hooks?.PreToolUse ?? [])
    .filter((e) => new RegExp(e.matcher).test(FORBIDDEN_TOOLS[0]));
  assert.ok(matching.length > 0, '找不到 matcher 接得住 create_order_instruction 的 hook 組。');
  // ⚠️ Codex #392 r1 important：舊版逐個 hook 斷言，hooks:[] 時迴圈零次執行＝假綠。
  //    判準＝至少一組對 create 實跑回 deny（空殼、換型別、改輸出都轉紅）。
  assert.ok(entriesBlocking(settings, FORBIDDEN_TOOLS[0]).length >= 1,
    '匹配下單工具的 hook 組沒有任何 handler 實跑回 deny——攔截層是空殼（Codex #392 r1）。');
});

test('兩層互相涵蓋：deny 點名的每一支工具，hook 層對它也是實跑回 deny', () => {
  const settings = loadSettings();
  const denyOrderTools = (settings?.permissions?.deny ?? []).filter((r) => /_order_instruction$/.test(r));
  assert.ok(denyOrderTools.length >= 2, 'deny 清單裡的下單工具少於兩支——精確點名層被拆了。');
  for (const rule of denyOrderTools) {
    assert.ok(entriesBlocking(settings, rule).length >= 1,
      `deny 點名了 ${rule}，但 hook 層對它不是實跑回 deny——兩層各自為政，改一層忘一層就會裂縫。`);
  }
});
