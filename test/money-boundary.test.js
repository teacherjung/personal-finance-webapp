/**
 * 「錢的絕對邊界」考題（2026-08-03，William 拍板當日落地；r1／r2 修訂見下）
 *
 * 守什麼：AGENTS.md「🛑 錢的絕對邊界」節（William 原文）與 `.claude/settings.json`
 * 的兩層機械封鎖（permissions.deny 精確點名＋PreToolUse deny hook）不被靜靜退掉；hook 層不因改寫而漏擋或誤傷。
 * hook 那一組的沿革：早期是 hook 指令裡的正則、後來是 python（詞表寫死在指令本體）；2026-09-16〜09-18 起是呼叫套件
 * tools/forbidden-tools.js、每次重讀那棵樹的 settings.json（活讀那一行）；**2026-09-19（Claude 側釘指紋第 2 支）起＝釘指紋那一行**：
 * 指令裡只寫指紋，判斷讀倉庫外的固定複本 `$HOME/.local/share/ai-collab-kit/guard/<指紋>`（裡面是 tools/forbidden-tools.js 等三支
 * ＋只留 forbidden 那一塊的 settings.json；每台機器由人跑 `node tools/guard-copy.js --claude` 補）。
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
 *   - `.claude/settings.json` 只約束 Claude Code；**Codex CLI 不讀這個檔**。
 *     Codex 側 2026-09-01（PR #536）〜09-18 曾有 `.codex/hooks.json`＝同款封鎖的專案層副本；2026-09-17 起走家目錄
 *     全域層（讀 tools/guard-copy.js 抽的固定複本，考題＝test/codex-global-hook.test.js），專案層副本 2026-09-18
 *     搬家第 8 步刪除。那一層是**條件式**的：要 William 在 Codex 介面按過「信任」才會執行，信任狀態存在
 *     `~/.codex/config.toml`、**不在 repo**＝本考題看不到、也不假裝看得到（未信任時 Codex 會一聲不吭地跳過）。
 *     所以約束 Codex 仍以 AGENTS.md 條文（每次開工必讀）＋審查制度為主，那道 hook 是信任之後才加上的一層。
 *   - William 機器 user 層 `~/.claude/settings.json` 另有 v5 同款封鎖——不在 repo，
 *     本考題看不到、也不假裝看得到（第 8 步拆舊層時未重驗）。
 *   - 2026-09-16〜09-18 兩組並存（python v6＋套件那組），2026-09-18 第 8 步拆掉 python 那組：下面 r2〜v4 的沿革講的是
 *     python 那組的判準演進，判斷現在只有一份＝套件的 tools/forbidden-tools.js（清單＝根目錄 settings.json 的 forbidden），
 *     同款判準都在裡面。探針自第 8 步起是**三態**（deny／allow／起不來）：舊的兩態探針把非零退出一律算成 false，
 *     放行面「零組擋」會把起不來當放行（施工地圖 3c）。
 *   - **2026-09-19 起探針的 HOME 一律指到本檔自己開的暫存家**（`test/helpers/pinned-home.js`）：裡面用**這棵樹當下的四個檔**
 *     造一份複本、造完驗它的指紋等於 tools/guard-copy.js 對這棵樹算的指紋（不等＝叫到它的那一題紅）。所以本檔驗的是
 *     「這棵樹的清單裝進那一行之後」擋該擋、放該放；CI 上真的家目錄沒有複本，本檔也不讀寫真的家目錄。
 *     「探針真的把 HOME 帶進子行程」由一題對照守（同一個 probe 指到空的暫存家＝要起不來）：漏帶在任何機器上都紅；
 *     但紅之前那幾發已經用考卷自己的 HOME 跑過（在補過複本的機器上＝讀過真的那一份，只讀不寫）——這一題擋的是「漏帶還綠」，不是那一次讀。
 *     William 機器上那一份（`--claude` 從已合併版本抽的）有沒有、是不是同一個指紋，只有在真的對話按測試鈕量得到；
 *     `.claude/settings.json` 那兩組有沒有逐字等於「範本＋這棵樹的指紋」＝test/money-kit-hook.test.js ①。
 *   - deny 清單點名的是**當下連接器 UUID**的工具全名，連接器重連換 UUID 後 deny
 *     會漏接——第二層 hook（家族網那一層）只認工具名、不認 UUID，正是補這個洞；
 *     所以本考題對 hook 做**逐名行為驗證**（含假 UUID 情境），不只驗「字串有出現」。
 *   - 正則自 2026-08-04 起擴編為**家族攔截**（William 指示「所有轉帳相關詞都進攔截器」）：
 *     動詞×名詞鎖（place/submit/cancel…×order/trade/position…）＋出入金關鍵詞
 *     （transfer/withdraw/deposit…；唯讀動詞前綴 get_/list_/search_… 放行）＋換匯三動詞。
 *     即便如此**仍列舉不完所有未來名字**（起怪名的工具照樣漏網）——規則 1 的語意
 *     （「任何現在或未來…的工具」）＋規則 4 的通報義務仍是最後防線，這層不變。
 *   - r2 改造（Codex #404 r1）：判斷主體從 matcher 正則移進 hook 指令（grep -iE 兩段式），
 *     **大小寫與 _ / - / . 分隔符不敏感**（MCP 名字規格允許大寫、連字號、句點——小寫底線
 *     只是慣例；Place_Order／placeOrder／place-order 全都攔）；動詞前可帶前綴詞
 *     （broker_place_order 也攔）；補真實世界漏網動詞 exercise/liquidate/replace/redeem。
 *   - r2→v3 改造（Codex #404 r2，1H1H2M）：①hook 指令改 **python 結構化解析頂層
 *     tool_name**——巢狀 tool_input.tool_name 不可覆蓋、壞輸入／缺欄位一律 fail-closed
 *     deny（sed 貪婪抽取會被同名鍵繞過＝r2 H①實測）；②工具名先與伺服器名切離再判
 *     （唯讀豁免只看工具開頭；伺服器叫 payments 不牽連工具）；③駝峰正規化後才進家族
 *     網＝出入金／換匯分支也吃 transferFunds 型變體；④補現役名 create_locate（Alpaca
 *     借券 locate fee）／pay_order（PayPal）＝verb pay、noun locate/invoice/bill 入表。
 *   - r3→v4（Codex #404 r3，3H）：①server 名可含 __（CLI 實測收 broker__get）＝切分
 *     歧義——處置偏 deny：每個 __ 後綴都當候選工具查一次，任一候選命中＝攔（代價＝
 *     server 名帶 __ 且工具帶錢詞的唯讀工具會被誤攔，照舊寧可誤殺）；②縮寫駝峰
 *     TRANSFERFunds 型補 acronym→Word 邊界正規化；③考題的 matcher 判定改用 Claude
 *     混合語意（純文字＝全等、含特殊字元才是正規式）＋ '^mcp__' 字面釘＋非 MCP 反向探針。
 *   - 擴編的取捨方向＝**寧可誤殺、不可漏擋**（生存優先）。真實誤攔面（照實劃界，r1 抓過
 *     描述不準）：①唯讀豁免＝**前綴動詞封閉名單**（get/list/…/retrieve/export/download）——
 *     名單外的讀取動詞（如 obtain_）帶錢詞會被誤攔，處置＝報 William 加名單；
 *     ②跨域名詞撞名（delete_stock_photo 型）仍會誤攔（trademark／sharepoint 型已用
 *     名詞邊界修掉）；③名字說謊的工具（叫 get_ 卻會動錢）任何正則都免疫不了——
 *     那屬規則 1 語意＋規則 4 通報義務層。誤攔的代價是不便、漏攔的代價是錢。
 *   - SIGKILL 殺的是直接子行程（bash）；handler 若刻意生出「抓住 stdout 的孤兒孫行程」
 *     理論上仍能拖延考題（repo 內的 handler 是受審的 echo 一行，這條寫著防未來）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 承重字表與探針清單＝test/helpers/money-family-probes.js（唯一住所；Codex #536 r2 H 抽出，
// 讓 Codex 側的考題（現在＝codex-global-hook.test.js）把完整矩陣直接跑在同一份清單上——不准在別處複抄）。
import {
  FORBIDDEN_TOOLS, FORBIDDEN_AFTER_RECONNECT, READ_VERBS, FORBIDDEN_FAMILY,
  ALLOWED_LOOKALIKES, EXPECTED_READ_VERBS_COUNT, EXPECTED_ALLOWED_COUNT,
  IN_MATCHER_DENY, EXPECTED_IN_MATCHER_DENY, HANDLER_ONLY_DENY, EXPECTED_HANDLER_ONLY_DENY,
  OUT_OF_MATCHER, EXPECTED_OUT_OF_MATCHER,
  MONEY_SERVER, MONEY_SERVER_DENY, EXPECTED_MONEY_SERVER_DENY,
  MONEY_SERVER_ALLOW, EXPECTED_MONEY_SERVER_ALLOW,
  MONEY_SERVER_MULTISEG_DENY, EXPECTED_MONEY_SERVER_MULTISEG_DENY,
  MONEY_SERVER_MULTISEG_ALLOW, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW,
} from './helpers/money-family-probes.js';
import { makePinnedHome, makeEmptyHome, removeHome } from './helpers/pinned-home.js';
import claudePin from '../tools/claude-pin.js';

const { PINNED_MARK } = claudePin;
/** 釘指紋那一行在「複本不在／被改過」時印的那一句裡的字樣。 */
const MISMATCH = /指紋對不上/u;

// 字表 helper 的位元組絆線在**隔離行程**的 test/money-family-probes-integrity.test.js
// （Codex #536 r5：同行程內的釘可被 helper 自己改寫取樣器而假綠——ESM 靜態 import
// 一律先於本檔程式碼執行。換行程擋掉的是那一形，不是終點——r6 已證明還有別的形；
// 該檔頭有完整劃界。本檔因此不再自帶位元組釘）。

function loadSettings() {
  return JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
}

/**
 * 探針的 HOME（2026-09-19 起）：釘指紋那一行讀 $HOME/.local/share/ai-collab-kit/guard/<指紋>。第一次用到才造；
 * 造不出來（寫法漂了＝指紋對不上）＝丟 AssertionError、叫到它的那一題紅（下一題再試一次）。本檔跑完刪掉。
 * @type {{ home: string } | null}
 */
let pinned = null;
const pinnedHome = () => (pinned ??= makePinnedHome(ROOT)).home;
after(() => { if (pinned) removeHome(pinned.home); });

const probeCache = new Map();

/**
 * 三態行為探針（第 8 步起）：這個 handler 收到這份輸入時回什麼？
 *   'deny'＝退 0＋stdout 是合規 deny；'allow'＝退 0＋stdout 空；'other'＝退 0 但輸出不是合規 deny（平台會當沒說話）；
 *   退非零＝**起不來**（釘指紋那一行：複本不在或指紋對不上、找不到 node、載入就崩，都退 2 帶 stderr）——直接 assert.fail，不算成任一面：
 *   舊版把非零一律 catch 成 false，放行面「零組擋」會把起不來當放行。
 * 逐名探測（Codex #392 r2）：不可拿一個名字的結果代表整個 entry——「看輸入決定」的 handler 可以對 create 說 deny、對 delete 說 allow。
 * HOME 預設指到本檔的暫存家（pinnedHome）；只有「探針真的把 HOME 帶進去」那一題另外給一個空的暫存家。
 * cwd＝ROOT 照舊——釘指紋那一行先 cd 進複本、不看當下目錄（從子目錄、從樹外起照擋＝test/money-kit-hook.test.js ③）。
 * @param {{ type?: string, command?: string }} hook
 * @param {string} payload 標準輸入原樣（壞輸入那幾筆不是合法 JSON）
 * @param {string} [home] 子行程的 HOME；沒給＝本檔的暫存家
 */
function probe(hook, payload, home) {
  if (!hook || hook.type !== 'command' || !hook.command) return 'skip';
  const h = home ?? pinnedHome();
  const key = JSON.stringify([hook.command, payload, h]);
  if (probeCache.has(key)) return probeCache.get(key);
  const r = spawnSync('bash', ['-c', hook.command], {
    cwd: ROOT, env: { ...process.env, HOME: h }, input: payload, encoding: 'utf8', timeout: 8000,
    killSignal: 'SIGKILL', // Codex #392 r2 minor：SIGTERM 可被無視，SIGKILL 不行
  });
  if (r.status !== 0) {
    assert.fail(`鉤子起不來（退出碼 ${r.status}）：${String(r.stderr).slice(0, 200)}——這不是放行也不是擋，考題不可以把它算成任一面`);
  }
  let state = 'other';
  if (String(r.stdout).trim() === '') state = 'allow';
  else {
    try {
      const d = JSON.parse(r.stdout).hookSpecificOutput;
      if (d?.permissionDecision === 'deny' && d?.hookEventName === 'PreToolUse') state = 'deny';
    } catch { /* 不是 JSON＝other */ }
  }
  probeCache.set(key, state);
  return state;
}
const denyProbe = (hook, toolName) => probe(hook, JSON.stringify({ tool_name: toolName, tool_input: {} })) === 'deny';

/**
 * 對「這個工具名」而言的封鎖組：matcher 接得住這個名字，且至少一個 handler
 * 對**這個名字**實跑回 deny（matcher 與 handler 決策成對驗證，Codex #392 r2）。
 * @param {any} settings @param {string} toolName
 */
/**
 * Claude Code 的 matcher 混合語意（Codex #404 r3 H③——考題用錯語意會整層假綠）：
 * 只含字母數字底線＝**全等比對**；含任何其他字元才當正規表示式。
 * 突變證據：matcher 從 '^mcp__' 改 'mcp__' 時，new RegExp 照樣命中＝舊考題全綠，
 * 但真實 Claude 只會匹配「名字恰好是 mcp__」的工具＝家族 hook 對所有真工具失效。
 * @param {string} matcher @param {string} toolName
 */
function claudeMatcherHits(matcher, toolName) {
  if (typeof matcher !== 'string' || matcher === '') return false;
  if (/^[A-Za-z0-9_]+$/.test(matcher)) return matcher === toolName;
  return new RegExp(matcher).test(toolName);
}

function entriesBlocking(settings, toolName) {
  return (settings?.hooks?.PreToolUse ?? []).filter((e) =>
    claudeMatcherHits(e.matcher, toolName) && (e.hooks ?? []).some((h) => denyProbe(h, toolName)));
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
  for (const tool of [...FORBIDDEN_TOOLS, ...FORBIDDEN_AFTER_RECONNECT, ...FORBIDDEN_FAMILY]) {
    assert.ok(entriesBlocking(settings, tool).length >= 1,
      `沒有任何 hook 組對 ${tool} 是「matcher 接得住＋handler 實跑回 deny」——`
      + '空殼、改輸出、或「看輸入決定」的偏心 handler 都算沒擋（連接器換 UUID 也必須擋得住）。');
  }
  // 誤傷＝matcher 命中「且」對該名字實跑回 deny。純記錄的良性 hook（不 deny）不歸本考題管，
  // 不會被錯殺（Codex #392 r1 minor②）。
  assert.equal(READ_VERBS.length, EXPECTED_READ_VERBS_COUNT,
    `READ_VERBS 數量（${READ_VERBS.length}）與字面釘（${EXPECTED_READ_VERBS_COUNT}）不符——`
    + '唯讀豁免名單被增刪時兩邊一起改（#404 r2 M④：自我縮放的釘不是釘）。');
  assert.equal(ALLOWED_LOOKALIKES.length, EXPECTED_ALLOWED_COUNT,
    `ALLOWED_LOOKALIKES 數量（${ALLOWED_LOOKALIKES.length}）與宣告（${EXPECTED_ALLOWED_COUNT}）不符——`
    + '清單被增刪時兩邊要一起改（#404 r1：宣稱 19 實際 18 的現場教訓）。');
  for (const tool of ALLOWED_LOOKALIKES) {
    assert.equal(entriesBlocking(settings, tool).length, 0,
      `有 hook 組對規則 2 明文可用的 ${tool} 實跑回 deny——誤擋跟漏擋一樣是壞。`);
  }
});


function handlerDenies(settings, payload) {
  return (settings?.hooks?.PreToolUse ?? []).flatMap((e) => e.hooks ?? []).some((h) => probe(h, payload) === 'deny');
}

test('輸入衛生：Claude 側成對驗證（matcher 接得住 ∧ handler 擋得下）', () => {
  const settings = loadSettings();
  assert.equal(IN_MATCHER_DENY.length, EXPECTED_IN_MATCHER_DENY, '探針被縮短了');
  for (const [payload, why] of IN_MATCHER_DENY) {
    const name = JSON.parse(payload).tool_name;
    assert.equal(typeof name, 'string', `這批每一支都必須有字串工具名：${why}`);
    // r1 H1：只驗 handler 會假綠——matcher 不命中時整個 hook 不執行。
    const ok = (settings?.hooks?.PreToolUse ?? []).some((e) =>
      claudeMatcherHits(e.matcher, name) && (e.hooks ?? []).some((h) => probe(h, payload) === 'deny'));
    assert.ok(ok, `沒有「matcher 接得住＋handler 回合規 deny」的組：${why}`);
  }
});

test('壞輸入：Claude 側同樣只驗得到 handler 的 fail-closed（誠實標示層級）', () => {
  const settings = loadSettings();
  assert.equal(HANDLER_ONLY_DENY.length, EXPECTED_HANDLER_ONLY_DENY, '探針被縮短了');
  for (const [payload, why] of HANDLER_ONLY_DENY) {
    assert.ok(handlerDenies(settings, payload), `沒有 handler 對這種壞輸入回合規 deny：${why}`);
  }
});


test('姿態閘：Claude 側對多段前綴同樣要擋（UUID 不在第一段）', () => {
  const settings = loadSettings();
  assert.equal(MONEY_SERVER_MULTISEG_DENY.length, EXPECTED_MONEY_SERVER_MULTISEG_DENY, '探針被縮短了');
  for (const [name, why] of MONEY_SERVER_MULTISEG_DENY) {
    assert.ok(entriesBlocking(settings, name).length >= 1, `多段前綴沒被擋：${why}`);
  }
  // r4 M2 的反向對照：多段前綴下的名單內工具不可被誤攔。
  assert.equal(MONEY_SERVER_MULTISEG_ALLOW.length, EXPECTED_MONEY_SERVER_MULTISEG_ALLOW, '探針被縮短了');
  for (const [name, why] of MONEY_SERVER_MULTISEG_ALLOW) {
    assert.equal(entriesBlocking(settings, name).length, 0, `多段前綴＋名單內被誤攔：${why}`);
  }
});

test('射程劃界：Claude 側 matcher 同樣篩不到那些形狀（誠實記錄，不假裝擋了）', () => {
  const settings = loadSettings();
  assert.equal(OUT_OF_MATCHER.length, EXPECTED_OUT_OF_MATCHER, '探針被縮短了');
  const family = (settings?.hooks?.PreToolUse ?? []).filter((e) => e.matcher === '^mcp__');
  assert.ok(family.length >= 1, '找不到 matcher 恰為 ^mcp__ 的家族組');
  for (const [name, why] of OUT_OF_MATCHER) {
    assert.ok(family.every((e) => !claudeMatcherHits(e.matcher, name)),
      `${why}：現在 matcher 命中了——該移到 IN_MATCHER_DENY 並驗 handler 會擋`);
  }
});

test('姿態閘：Claude 側對已宣告的動錢連接器同樣白名單制', () => {
  const settings = loadSettings();
  assert.equal(MONEY_SERVER_DENY.length, EXPECTED_MONEY_SERVER_DENY, '名單外探針被縮短了');
  assert.equal(MONEY_SERVER_ALLOW.length, EXPECTED_MONEY_SERVER_ALLOW, '名單內探針被縮短了');
  for (const t of MONEY_SERVER_DENY) {
    assert.ok(entriesBlocking(settings, MONEY_SERVER + t).length >= 1,
      `動錢連接器上的名單外工具 ${t} 沒有被擋——白名單制失效`);
  }
  for (const t of MONEY_SERVER_ALLOW) {
    assert.equal(entriesBlocking(settings, MONEY_SERVER + t).length, 0,
      `名單內的 ${t} 被誤攔——白名單漏列或姿態閘寫壞`);
  }
});

test('.claude/settings.json：匹配下單工具的 hook 組不是空殼（r1 假綠路徑回歸考）', () => {
  const settings = loadSettings();
  const matching = (settings?.hooks?.PreToolUse ?? [])
    .filter((e) => claudeMatcherHits(e.matcher, FORBIDDEN_TOOLS[0]));
  assert.ok(matching.length > 0, '找不到 matcher 接得住 create_order_instruction 的 hook 組。');
  // ⚠️ Codex #392 r1 important：舊版逐個 hook 斷言，hooks:[] 時迴圈零次執行＝假綠。
  //    判準＝至少一組對 create 實跑回 deny（空殼、換型別、改輸出都轉紅）。
  assert.ok(entriesBlocking(settings, FORBIDDEN_TOOLS[0]).length >= 1,
    '匹配下單工具的 hook 組沒有任何 handler 實跑回 deny——攔截層是空殼（Codex #392 r1）。');
});

test('matcher 是 ^mcp__ 正規式且不誤傷非 MCP 工具（Codex #404 r3 H③配套）', () => {
  const settings = loadSettings();
  const entries = settings?.hooks?.PreToolUse ?? [];
  // 字面釘：家族 hook 的 matcher 必須是含特殊字元的 '^mcp__'（純文字 'mcp__' 在 Claude
  // 語意下是「全等比對」＝對所有真實工具永不觸發＝整層靜靜失效）。
  assert.ok(entries.some((e) => e.matcher === '^mcp__'),
    "找不到 matcher 恰為 '^mcp__' 的 hook 組——改成純文字（如 'mcp__'）在 Claude 的混合語意下是全等比對，家族層會整層靜靜失效。");
  for (const tool of ['Bash', 'Read', 'Write', 'Task', 'WebFetch']) {
    assert.equal(entriesBlocking(settings, tool).length, 0,
      `內建工具 ${tool} 被錢邊界 hook 攔下——matcher 涵蓋面寫壞了。`);
  }
});

test('hook 指令：頂層欄位結構化解析——巢狀同名鍵不可覆蓋、壞輸入 fail-closed（Codex #404 r2 H①）', () => {
  const settings = loadSettings();
  const hooks = (settings?.hooks?.PreToolUse ?? []).flatMap((e) => e.hooks ?? []);
  assert.ok(hooks.length > 0, '找不到任何 PreToolUse handler。');
  const rawProbe = (hook, raw) => probe(hook, raw) === 'deny';
  const cases = [
    // r2 H① 原樣重放：tool_input 夾同名鍵，貪婪文字抽取會抓到 noop 而放行真下單名
    [JSON.stringify({ tool_name: FORBIDDEN_FAMILY[0], tool_input: { tool_name: 'noop' } }),
      '巢狀 tool_input.tool_name 覆蓋了頂層工具名——家族網被同名鍵繞過（#404 r2 H①）。'],
    ['this is not json', '輸入不是 JSON 卻沒有 fail-closed deny——解析失敗必須擋下而不是放行。'],
    [JSON.stringify({ tool_input: {} }), '缺頂層 tool_name 卻沒有 fail-closed deny。'],
  ];
  for (const [raw, msg] of cases) {
    assert.ok(hooks.some((h) => rawProbe(h, raw)), msg);
  }
});

test('探針真的把 HOME 帶進子行程：同一個 probe 指到空的暫存家＝起不來、「指紋對不上」（對照：指回本檔的暫存家＝照清單判）', () => {
  // 漏帶 HOME＝子行程沿用考卷自己的 HOME：在補過複本的機器上照樣全綠（還會去讀真的家目錄），上面那幾題看不出來；
  // 這一題讓漏帶在任何機器上都紅——外層 HOME 有沒有複本，空的暫存家這一發都拿不到「起不來」以外的結果才對
  const settings = loadSettings();
  const pinnedHooks = (settings?.hooks?.PreToolUse ?? []).flatMap((e) => e.hooks ?? [])
    .filter((h) => h?.type === 'command' && typeof h.command === 'string' && h.command.includes(PINNED_MARK));
  assert.ok(pinnedHooks.length >= 1, '找不到釘指紋那一行（指令提到固定複本位置的那一組）：test/money-kit-hook.test.js ① 會說是哪裡不對');
  const payload = JSON.stringify({ tool_name: 'mcp__other__get_widget', tool_input: {} });
  const empty = makeEmptyHome();
  try {
    for (const hook of pinnedHooks) {
      let outcome;
      try { outcome = `沒有起不來：探針回「${probe(hook, payload, empty)}」`; } catch (e) { outcome = String(e instanceof Error ? e.message : e); }
      assert.match(outcome, /鉤子起不來（退出碼 2）/u,
        `HOME 指到空的暫存家，探針要走「起不來」那一條（${outcome.slice(0, 160)}）——沒走到＝探針沒把 HOME 帶進子行程（沿用了考卷自己的 HOME）`);
      assert.match(outcome, MISMATCH, '起不來的原因要是「指紋對不上」（空的家裡沒有複本）');
    }
  } finally {
    removeHome(empty);
  }
  // 對照：同一份輸入、HOME 指回本檔的暫存家＝照清單判（無害工具放行）——上面的起不來是家裡沒有複本，不是那一行壞了
  for (const hook of pinnedHooks) assert.equal(probe(hook, payload), 'allow', '對照組：HOME 指回有複本的暫存家，無害工具放行');
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
