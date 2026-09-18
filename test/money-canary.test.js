/**
 * 「測試鈕」考題（2026-09-16，搬家第 3 步 A 支；William 2026-09-15 裁示第 8 題 a）
 *
 * 為什麼有這一支：錢的攔截器沒裝好、沒按信任、或載入就崩的時候，畫面跟「它好好地在擋」
 * 一模一樣——什麼事都沒發生。要證明它活著，只能叫一個**照清單該擋**的工具、親眼看到拒絕理由；
 * 而任何會動到錢的真工具一律絕不可以叫來試（連唯讀的查詢也不行，AGENTS「錢的絕對邊界」）。
 * 所以清單上永久放一個刻意做出來、就算真的執行了也無害的名字：`mcp__guard_canary__ping`
 * （本體＝協作套件的 `tools/canary-server.js`，裝法＝`templates/canary-install.md`）。
 *
 * 這支考題守的是**本專案的真清單與真登記**（套件那邊的考題守的是那支小伺服器自己）：
 *   ①那個名字永久在 `settings.json` 的 `forbidden.deny` 上；
 *   ②拿本專案的真清單跑套件的判斷，它會被拒絕，理由含「在拒絕清單上」；
 *   ③**對照組**：把它從拒絕清單拿掉就放行——證明擋住它的是那一行登記，不是家族網剛好掃到，
 *     所以按下去看到拒絕＝那一組攔截器真的讀到了這份清單（這正是它當測試鈕的資格）；
 *   ④它不是禁區連接器上的工具（⓪的條件：連那台連接器上唯讀的查詢都不可以拿來當測試鈕）；
 *   ⑤`.mcp.json` 的登記跟套件安裝說明裡那一段**逐字相同**，而且只登記這一支；
 *   ⑥`.claude/settings.json` 的 `permissions.deny` 沒有任何一條**蓋到**它（完整名、整台伺服器、伺服器底下全部三種
 *     正式寫法都算）——平台那一層在鉤子之前就會擋，蓋到的話按下測試鈕量到的是平台、不是攔截器；
 *   ⑦兩支真的下單工具仍然逐字在拒絕清單上，期望值來自平台那一層的清單（不從待驗清單自己挑），
 *     清單沒有重複（改清單時不可以把它們順手弄掉或蓋掉）。
 *
 * ⚠️ 誠實劃界：這支考題證明的是**清單與登記寫對了**，不是「有任何一層真的在擋」。
 *   A 支（#607）合併時還沒有任何鉤子讀套件那份清單，William 叫它成功回 pong＝對照組成立；
 *   B 支把套件那一組鉤子接上 `.claude/settings.json`（09-16〜09-18 跟 python v6 並存，第 8 步拆掉 v6），同一個叫法要變成被擋——
 *   接線本身由 `test/money-kit-hook.test.js` 用 shell 模擬考，但**只有在真的 Claude／Codex session 裡按一次**
 *   才算數（那一步是人做的，機器證明不了）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import forbiddenTools from '../tools/forbidden-tools.js';

const { decide } = forbiddenTools;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const settings = JSON.parse(read('settings.json'));
const forbidden = settings.forbidden;

/** 測試鈕的完整工具名。改這個字面值＝換測試鈕，要連套件那邊的本體、四份說明與 `.mcp.json` 一起換。 */
const CANARY = 'mcp__guard_canary__ping';
/** 伺服器登記名（工具名中間那一段）：平台整台封鎖的規則寫的是它。 */
const CANARY_SERVER = CANARY.split('__')[1];

test('①測試鈕的名字永久在禁區的拒絕清單上（裁示第 8 題 a）', () => {
  assert.ok(forbidden.deny.includes(CANARY),
    `settings.json 的 forbidden.deny 少了 ${CANARY}：少了它就沒有合法的方式驗攔截器在不在擋`);
});

test('②拿本專案的真清單判它＝拒絕，理由指名「在拒絕清單上」', () => {
  const d = decide(CANARY, forbidden);
  assert.equal(d.deny, true);
  assert.match(d.why, /在拒絕清單上/u,
    '驗收要靠這句理由分辨「是這一組攔截器擋的」，理由變了安裝說明的第⑤步就對不上');
});

test('③對照組：把它從拒絕清單拿掉就放行＝擋住它的是那一行登記，不是別的規則剛好掃到', () => {
  const without = { ...forbidden, deny: forbidden.deny.filter((n) => n !== CANARY) };
  const d = decide(CANARY, without);
  assert.equal(d.deny, false, `名字不在清單上也被擋＝它不能當測試鈕（擋它的是別的規則：${d.why}）`);
  // 這份真清單不是全放行：真的會動到錢的名字照樣擋（證明對照組不是因為清單壞掉才放行）
  assert.equal(decide('mcp__canary_control__submit_order', forbidden).deny, true);
});

test('④它不是禁區連接器上的工具（那上面連唯讀的查詢都不可以拿來試）', () => {
  for (const server of forbidden.servers) {
    assert.ok(!CANARY.includes(server), `測試鈕 ${CANARY} 落在禁區連接器 ${server} 上`);
  }
});

test('⑤.mcp.json 的登記跟套件安裝說明裡那一段逐字相同，而且只登記這一支', () => {
  const doc = read('templates/canary-install.md');
  const block = doc.match(/```json\n([\s\S]*?)\n```/u);
  assert.ok(block, '安裝說明裡找不到那一段 JSON 登記');
  const documented = JSON.parse(block[1]);
  const actual = JSON.parse(read('.mcp.json'));
  assert.deepEqual(actual, documented, '.mcp.json 跟安裝說明寫的不一樣：照說明做的人會裝出另一種東西');
  assert.deepEqual(Object.keys(actual.mcpServers), ['guard_canary'],
    '.mcp.json 只准登記測試鈕這一支：這個檔會讓每個工作階段自動啟動它登記的每一支程式');
  const server = Object.keys(actual.mcpServers)[0];
  assert.equal(CANARY, `mcp__${server}__ping`, '登記鍵跟工具名對不起來＝叫不到那個名字');
});

/**
 * 平台拒絕規則會不會蓋到測試鈕。平台正式支援三種寫法：完整工具名、整台伺服器（`mcp__<伺服器>`）、
 * 伺服器底下全部（`mcp__<伺服器>__*`）；這裡把「以 * 結尾＝前綴」一起收進來（Codex #607 r1：只比完整字串，
 * 整台伺服器的寫法照樣全綠）。⚠️ 只認這三種形狀，不是平台規則的完整解析器。
 */
const coversCanary = (rule) => rule === CANARY || rule === `mcp__${CANARY_SERVER}` || (rule.endsWith('*') && CANARY.startsWith(rule.slice(0, -1)));

test('⑥平台自己的拒絕清單沒有任何一條蓋到測試鈕（蓋到就量不到攔截器）', () => {
  // 正對照：三種正式寫法都要被判成「蓋到」，不然下面那一圈掃了個寂寞
  for (const rule of [CANARY, `mcp__${CANARY_SERVER}`, `mcp__${CANARY_SERVER}__*`]) assert.ok(coversCanary(rule), `判準連「${rule}」都認不出來`);
  assert.ok(!coversCanary('mcp__other_server__*'), '判準把別台伺服器的規則也當成蓋到');
  const claude = JSON.parse(read('.claude/settings.json'));
  for (const rule of claude.permissions?.deny ?? []) {
    assert.ok(!coversCanary(rule),
      `permissions.deny 的「${rule}」會蓋到測試鈕：平台那一層在鉤子之前就擋掉，按下去量到的是平台、不是攔截器`);
  }
});

test('⑦兩支真的下單工具仍然逐字在拒絕清單上（期望值來自平台那一層的清單，不從待驗清單自己挑）', () => {
  // 期望值＝.claude/settings.json 的 permissions.deny（那份由 test/money-boundary 逐名釘住），
  // 不從 forbidden.deny 自己挑「像下單工具的」——自己挑的話，重複一支、拼錯一個字都照樣過（Codex #607 r1）
  const platformDeny = JSON.parse(read('.claude/settings.json')).permissions.deny;
  assert.equal(platformDeny.length, 2, '平台那一層的逐字清單不是剛好兩支：這題的期望值來源變了，要重看');
  for (const name of platformDeny) {
    assert.ok(name.includes('order_instruction'), `平台清單裡的「${name}」不像下單工具：這題的期望值來源變了`);
    assert.ok(forbidden.deny.includes(name), `真下單工具「${name}」不在 settings.json 的 forbidden.deny 上`);
    assert.equal(decide(name, forbidden).deny, true);
  }
  assert.equal(new Set(forbidden.deny).size, forbidden.deny.length, 'forbidden.deny 有重複的名字（通常是把某一支蓋掉了）');
});
