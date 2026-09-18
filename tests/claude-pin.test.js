// 守 Claude 側釘指紋那一行「有沒有跟著這棵樹換」（規矩 B1）：等式題＋絆線題。判準＝tools/claude-pin.js（純函式）。
//
// 為什麼：釘指紋那一行的指紋是寫死的。改了那四個檔卻沒有重印那一行＝那一行照舊指紋找到舊複本、靜靜照舊清單判
// （收緊不生效、沒有任何訊號）；唯一會紅的就是這一題（使用專案要有、而且不能跳過）。
// 使用專案的 .claude/settings.json 有釘指紋那一組時，PreToolUse 與 ConfigChange 那兩組必須
// 逐字等於「這棵樹的範本＋這棵樹四個檔的指紋」（＝node tools/guard-copy.js --claude-line 印的那兩組）。
//
// 這支考題跟著 tests/ 搬進使用專案，所以「本倉庫」那兩題讀的就是那個專案自己的 .claude/。
// 守得到的：
//   ①本倉庫：有釘指紋那一組＝兩組逐字相符，否則紅；沒有 .claude/settings.json、或裝的是活讀那一份＝**跳過並寫明原因**（不是靜靜通過）；
//   ②夾具證明①真的會紅：相符＝ok；清單改一個字、那一行的指紋改一碼、那一行被改過字、少了或改了 ConfigChange 那一組、同一組放兩次、
//     多一條舊指紋的、清單沒填、設定檔不是合法 JSON＝mismatch；那一組或鉤子物件多一個鍵（async、if、args、timeout、組的別的鍵）＝mismatch、
//     而且說出是哪個鍵；活讀＝live；沒有 .claude＝absent；
//   ③絆線：本機設定檔有 hooks 鍵、有停用所有鉤子的開關（不論值）、有 env 鍵、不是合法 JSON，或專案設定檔有那個開關或 env 鍵＝紅；
//     檔案不在、只有別的鍵＝沒事。
// ⚠️ 守不到的：
//   這裡看不出「這個專案本來應該是釘的」——那一行被退回活讀，①是跳過、不是紅。**「一定要是釘指紋那一組」由使用專案自己的考題釘**
//   （require('../tools/claude-pin.js')，斷言 claudePinStatus(根目錄).state 是 'ok'）；
//   等式是同源比對（兩邊同一支函式算的），只證明那一行跟著這棵樹換了；算法本身與真的跑起來擋不擋＝tests/guard-copy-claude.test.js；
//   **絆線不是閘**：本機設定檔不進版控，雲端與跨變更的臨時樹裡永遠沒有它，只有在本機工作樹跑考卷的那一次看得到；
//   平台的設定鍵名若改了，絆線會靜靜失效；平台有沒有載入那兩組，只有按測試鈕量得到。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { claudeLine, CLAUDE_TEMPLATE_REL } = require('../tools/guard-copy.js');
const { claudePinStatus, localSettingsProblems, SETTINGS_REL, LOCAL_SETTINGS_REL, DISABLE_ALL_HOOKS, ENV_KEY } = require('../tools/claude-pin.js');
const { KIT, FAKE, LOOSE, withScratch } = require('./helpers/guard-rig.js');

const ROOT = path.join(__dirname, '..');
const LIVE = () => JSON.parse(fs.readFileSync(path.join(KIT, 'templates', 'hook-claude.json'), 'utf8')).hooks.PreToolUse[0];

/** 暫存的使用專案：套件的 tools/ 與 templates/＋假清單；settings＝要寫進 .claude/settings.json 的東西（函式＝拿這棵樹該有的那兩組去組）。 */
function project(scratch, { forbidden = FAKE, settings } = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'proj-'));
  fs.cpSync(path.join(KIT, 'tools'), path.join(dir, 'tools'), { recursive: true });
  fs.cpSync(path.join(KIT, 'templates'), path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mainBranch: 'main', forbidden }, null, 2));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'));
    const value = typeof settings === 'function' ? settings(claudeLine(dir).groups) : settings;
    fs.writeFileSync(path.join(dir, SETTINGS_REL), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  return dir;
}
/** 照 --claude-line 印的那兩組裝好的設定檔（專案原有的別的東西留著）。 */
const pinned = (g) => ({ permissions: { deny: ['mcp__fakebroker__place_widget'] }, hooks: { PreToolUse: [g.PreToolUse], ConfigChange: [g.ConfigChange] } });
const swapFp = (group, fn) => JSON.parse(JSON.stringify(group).replace(/[0-9a-f]{64}/u, fn));

test('①本倉庫：.claude/settings.json 有釘指紋那一組＝兩組逐字等於「範本＋這棵樹四個檔的指紋」（沒裝、或裝的是活讀那一份＝跳過並寫明）', (t) => {
  const s = claudePinStatus(ROOT);
  if (s.state === 'absent') { t.skip('本倉庫沒有 .claude/settings.json（沒裝 Claude 側接線）：沒有那一行可以比'); return; }
  if (s.state === 'live') { t.skip('本倉庫的 .claude/settings.json 沒有釘指紋那一組（活讀裝法、或沒裝攔截器）：沒有那一行可以比；「一定要釘」由使用專案自己的考題釘'); return; }
  assert.deepEqual(s, { state: 'ok', problems: [] }, s.problems.join('\n'));
});

test('③本倉庫的絆線：本機設定檔不可以有鉤子、停用所有鉤子的開關、env 鍵（絆線不是閘：那個檔不進版控，只有本機這一次看得到）', (t) => {
  if (!fs.existsSync(path.join(ROOT, LOCAL_SETTINGS_REL))) t.diagnostic(`${LOCAL_SETTINGS_REL} 不在：這一次沒有東西可以看`);
  assert.deepEqual(localSettingsProblems(ROOT), []);
});

test('②夾具：等式題真的會紅——相符、清單改一個字、指紋改一碼、那一行被改過字、ConfigChange 那一組少了或改了、放兩次、舊指紋殘留、活讀、沒裝', () => withScratch((scratch) => {
  const state = (dir) => claudePinStatus(dir).state;
  const ok = project(scratch, { settings: pinned });
  assert.deepEqual(claudePinStatus(ok), { state: 'ok', problems: [] }, '照 --claude-line 印的裝好＝相符');
  // 專案原有的別的鉤子、別的組並存不影響
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] };
  assert.equal(state(project(scratch, { settings: (g) => ({ hooks: { PreToolUse: [other, g.PreToolUse], ConfigChange: [g.ConfigChange], Stop: [other] } }) })), 'ok', '別的鉤子並存');

  // 清單改一個字（那一行沒跟著換）：同一份設定檔，樹裡的清單動了
  const drifted = project(scratch, { settings: pinned });
  const settingsFile = path.join(drifted, 'settings.json');
  const before = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...before, forbidden: { ...FAKE, verbs: ['create', 'placed'] } }, null, 2));
  const d = claudePinStatus(drifted);
  assert.equal(d.state, 'mismatch', '清單改一個字、那一行沒換');
  assert.match(d.problems.join('\n'), /--claude-line/u, '訊息要指到重印的做法');
  assert.doesNotMatch(d.problems.join('\n'), /[0-9a-f]{64}/u, '訊息不可以把算出來的新指紋遞出去（要重印就跑工具，不是手改那一行）');
  fs.writeFileSync(settingsFile, JSON.stringify({ ...before, mergeAuthorization: '清單以外的欄位' }));
  assert.equal(state(drifted), 'ok', '對照組：改的是清單以外的欄位＝不必換');
  fs.appendFileSync(path.join(drifted, 'tools', 'settings-data.js'), '\n');
  assert.equal(state(drifted), 'mismatch', '四個檔裡的程式檔多一個位元組');

  const flip = (fp) => (fp[0] === '0' ? '1' : '0') + fp.slice(1);
  assert.equal(state(project(scratch, { settings: (g) => ({ hooks: { PreToolUse: [swapFp(g.PreToolUse, flip)], ConfigChange: [g.ConfigChange] } }) })), 'mismatch', '那一行的指紋改一碼');
  assert.equal(state(project(scratch, { settings: (g) => {
    const p = pinned(g);
    const before = p.hooks.PreToolUse[0].hooks[0].command;
    p.hooks.PreToolUse[0].hooks[0].command = before.replace('exit 2;; esac;', 'exit 0;; esac;');
    assert.notEqual(p.hooks.PreToolUse[0].hooks[0].command, before, '前提：真的改到那一行');
    return p;
  } })), 'mismatch', '那一行被改過字（指紋對不上改成不擋）');
  assert.equal(state(project(scratch, { settings: (g) => ({ hooks: { PreToolUse: [{ ...g.PreToolUse, matcher: '^mcp__only_this__' }], ConfigChange: [g.ConfigChange] } }) })), 'mismatch', 'matcher 被改窄');
  assert.equal(state(project(scratch, { settings: (g) => ({ hooks: { PreToolUse: [g.PreToolUse] } }) })), 'mismatch', '少了 ConfigChange 那一組');
  assert.equal(state(project(scratch, { settings: (g) => ({ hooks: { PreToolUse: [g.PreToolUse], ConfigChange: [{ ...g.ConfigChange, matcher: 'local_settings' }] } }) })), 'mismatch', 'ConfigChange 的 matcher 被換');
  assert.equal(state(project(scratch, { settings: (g) => ({ hooks: { PreToolUse: [g.PreToolUse], ConfigChange: [{ ...g.ConfigChange, hooks: [{ type: 'command', command: 'exit 0' }] }] } }) })), 'mismatch', 'ConfigChange 那一條被改成不擋');
  assert.equal(state(project(scratch, { settings: (g) => ({ hooks: { PreToolUse: [g.PreToolUse, g.PreToolUse], ConfigChange: [g.ConfigChange] } }) })), 'mismatch', '同一組放兩次');
  assert.equal(state(project(scratch, { settings: (g) => ({ hooks: { PreToolUse: [swapFp(g.PreToolUse, flip), g.PreToolUse], ConfigChange: [g.ConfigChange] } }) })), 'mismatch', '多一條舊指紋的');
  assert.equal(state(project(scratch, { settings: (g) => ({ hooks: { PostToolUse: [g.PreToolUse], ConfigChange: [g.ConfigChange] } }) })), 'mismatch', '那一組掛錯事件');
  // 那一組多一個鍵（官方文件列的 async、if、args、timeout 任一個都可能讓它不擋）：mismatch，而且說出是哪個鍵
  const extraKey = (event, where, key, value) => claudePinStatus(project(scratch, { settings: (g) => {
    const p = pinned(g);
    if (where === 'hook') p.hooks[event][0].hooks[0][key] = value; else p.hooks[event][0][key] = value;
    return p;
  } }));
  for (const [event, where, key, value, named] of [
    ['PreToolUse', 'hook', 'async', true, 'hooks[0].async'], ['PreToolUse', 'hook', 'timeout', 1, 'hooks[0].timeout'],
    ['ConfigChange', 'hook', 'if', 'Bash(*)', 'hooks[0].if'], ['ConfigChange', 'hook', 'args', [], 'hooks[0].args'],
    ['PreToolUse', 'group', 'description', 'x', 'description']]) {
    const s = extraKey(event, where, key, value);
    assert.equal(s.state, 'mismatch', `${event} 多了 ${named}`);
    assert.ok(s.problems.some((p) => p.includes(`hooks.${event}[0] 多了鍵（${named}）`)), `${event} 多了 ${named}：要說出是哪個鍵（${s.problems.join(' / ')}）`);
  }
  assert.ok(!claudePinStatus(ok).problems.some((p) => p.includes('多了鍵')), '對照組：照印的放進去＝沒有多出來的鍵');

  // 算不出這棵樹該有的那兩組：清單沒填、範本不在——設定檔卻提到固定複本＝紅（不是跳過）
  const unfilled = project(scratch, { settings: pinned });
  fs.writeFileSync(path.join(unfilled, 'settings.json'), JSON.stringify({ forbidden: { name: '未設定' } }));
  assert.match(claudePinStatus(unfilled).problems.join('\n'), /還沒填/u);
  const noTemplate = project(scratch, { settings: pinned });
  fs.rmSync(path.join(noTemplate, CLAUDE_TEMPLATE_REL));
  assert.equal(state(noTemplate), 'mismatch', '範本不在');
  assert.equal(state(project(scratch, { settings: '{ 這不是 JSON' })), 'mismatch', '設定檔不是合法的 JSON：看不出裝了什麼＝紅');
  assert.equal(state(project(scratch, { settings: '[]' })), 'mismatch', '設定檔最外層不是物件');

  // 不是釘指紋裝法：活讀、沒有鉤子、根本沒有 .claude
  assert.equal(state(project(scratch, { settings: { hooks: { PreToolUse: [LIVE()] } } })), 'live', '活讀裝法');
  assert.equal(state(project(scratch, { settings: { permissions: { deny: [] } } })), 'live', '沒有任何鉤子');
  assert.equal(state(project(scratch)), 'absent', '沒有 .claude/settings.json');
  // 對照組：清單真的不同的兩棵樹，該有的那一行真的不同（不然上面「清單改一個字」證明不了什麼）
  assert.notEqual(claudeLine(project(scratch)).fp, claudeLine(project(scratch, { forbidden: LOOSE })).fp);
}));

test('③夾具：絆線真的會紅——本機設定檔有 hooks、有停用所有鉤子的開關、有 env、不是合法 JSON；專案設定檔有那個開關或 env', () => withScratch((scratch) => {
  const withLocal = (local, settings = pinned) => {
    const dir = project(scratch, { settings });
    if (local !== undefined) fs.writeFileSync(path.join(dir, LOCAL_SETTINGS_REL), typeof local === 'string' ? local : JSON.stringify(local));
    return localSettingsProblems(dir);
  };
  // 鍵名逐字：停用所有鉤子的開關＝官方鉤子文件寫的 "disableAllHooks"（出處見 tools/claude-pin.js 檔頭）；下面的夾具用常數，這一行釘常數本身
  assert.equal(DISABLE_ALL_HOOKS, 'disableAllHooks', '官方鉤子文件寫的鍵名');
  assert.deepEqual(withLocal(undefined), [], '本機設定檔不在＝沒事');
  assert.deepEqual(withLocal({ permissions: { allow: ['Bash(ls:*)'] } }), [], '只有別的鍵（平台自己寫的「以後不要再問」）＝沒事');
  assert.equal(withLocal({ hooks: { PreToolUse: [] } }).length, 1, 'hooks 鍵（空的也算：那個位置不准放鉤子）');
  assert.match(withLocal({ hooks: {} })[0], /hooks/u);
  for (const value of [true, false, 'true', null]) {
    const p = withLocal({ [DISABLE_ALL_HOOKS]: value });
    assert.equal(p.length, 1, `停用所有鉤子的開關設成 ${JSON.stringify(value)} 也算`);
    assert.match(p[0], new RegExp(DISABLE_ALL_HOOKS, 'u'));
  }
  assert.equal(withLocal({ hooks: {}, [DISABLE_ALL_HOOKS]: true }).length, 2, '兩樣都有＝兩條');
  assert.equal(withLocal('{ 壞掉').length, 1, '不是合法的 JSON：看不出裡面有沒有鉤子＝紅');
  assert.equal(withLocal('"字串"').length, 1, '最外層不是物件');
  assert.equal(withLocal(undefined, (g) => ({ ...pinned(g), [DISABLE_ALL_HOOKS]: true })).length, 1, '專案設定檔有那個開關');
  // env 鍵：平台設定的 env 會不會傳進鉤子的環境沒量，當成會（空的也算）
  assert.equal(ENV_KEY, 'env');
  for (const value of [{}, { SHELLOPTS: 'noexec' }]) {
    const p = withLocal({ [ENV_KEY]: value });
    assert.equal(p.length, 1, `本機設定檔的 env 鍵設成 ${JSON.stringify(value)} 也算`);
    assert.match(p[0], /settings\.local\.json 有 env 鍵/u);
  }
  const projEnv = withLocal(undefined, (g) => ({ ...pinned(g), [ENV_KEY]: { PATH: '/x' } }));
  assert.equal(projEnv.length, 1, '專案設定檔有 env 鍵');
  assert.match(projEnv[0], /settings\.json 有 env 鍵/u);
  assert.equal(withLocal({ hooks: {}, [DISABLE_ALL_HOOKS]: true, [ENV_KEY]: {} }).length, 3, '三樣都有＝三條');
  assert.deepEqual(localSettingsProblems(project(scratch)), [], '連 .claude 都沒有＝沒事');
}));
