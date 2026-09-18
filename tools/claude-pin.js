#!/usr/bin/env node
// Claude 側釘指紋裝法的兩個核對零件（規矩 B1）：等式與絆線。純函式、只讀，給考題用
//（套件自己的 tests/claude-pin.test.js；使用專案自己的考題也可以 require 這一支）。
//
// 為什麼：釘指紋那一行住在專案的 .claude/settings.json，指紋是寫死的。改了那四個檔（settings.json 的 forbidden 那一塊、
// tools/forbidden-tools.js、tools/package.json、tools/settings-data.js）卻沒有重印那一行＝那一行照舊指紋找到每台機器上的舊複本、
// **靜靜照舊清單判**（收緊不生效、沒有任何訊號）；唯一會紅的就是這裡的等式題——使用專案要有那一題，而且不能跳過。
// （「全擋、看得見」只在另一個前提下成立：那一行在同一支變更裡換了、而某台機器還沒補那一份複本。）
//
// ①等式 claudePinStatus(root)：專案 .claude/settings.json 有釘指紋那一組時，PreToolUse 與 ConfigChange 那兩組必須
//   **逐字等於**「這棵樹的範本＋這棵樹四個檔的指紋」（＝node tools/guard-copy.js --claude-line 印的那兩組），而且各剛好一組。
//   看起來就是那一組（指令提到固定複本的位置、或逐字是範本那一條）卻多了鍵＝mismatch，並說出是哪個鍵
//   （組只准有 matcher、hooks，鉤子物件只准有 type、command；官方鉤子文件列的 async、if、args、timeout 等欄位任一個都可能讓那一組不擋）。
//   回 { state, problems }：
//     absent＝沒有 .claude/settings.json（這個倉庫沒裝 Claude 側）；live＝有，但沒有任何一條鉤子指令提到固定複本的位置（活讀裝法、或沒裝）；
//     ok＝兩組都逐字相符；mismatch＝提到了固定複本的位置、卻不是剛好那兩組（problems 列出原因）。
//   ⚠️ 分工：這裡看不出「這個專案本來應該是釘的」——有人把那一行退回活讀，這裡回 live、不是 mismatch。
//     「一定要是釘指紋那一組」由使用專案自己的考題釘（斷言 state 是 ok）；套件自己的考題遇到 absent／live 是跳過並寫明原因。
//   ⚠️ 這是同源比對：兩邊都是同一支函式算的，只證明「那一行跟著這棵樹換了」。指紋算法本身對不對、那一行真的跑起來擋不擋，
//     在 tests/guard-copy-claude.test.js（跟 /usr/bin/shasum 互證、真的用 /bin/sh 跑）。平台有沒有載入那一行，只有測試鈕量得到。
//
// ②絆線 localSettingsProblems(root)：專案的 .claude/settings.local.json 若存在，不可以有 hooks 鍵、不可以有停用所有鉤子的開關、
//   不可以有 env 鍵；專案的 .claude/settings.json 也不可以有那個開關與 env 鍵。回問題清單（空＝沒事）；檔案不在＝沒事。
//   ⚠️ **這是絆線，不是閘**：本機設定檔不進版控，雲端與跨變更的臨時樹裡永遠沒有它——只有在本機那棵工作樹跑考卷的那一次看得到；
//     跑完考卷之後再放進去的，下一次跑考卷之前沒有人看。2026-09-18 量到的只有「對話中往本機設定檔加鉤子同回合生效」；
//     那個開關關不關得掉整組鉤子沒量（那是往鬆的方向試），一律當成關得掉。
//   env 鍵：平台設定裡的 env 會不會傳進鉤子的環境沒量，一律當成會——鉤子的環境被塞一個變數（SHELLOPTS、匯入的 shell 函式、PATH），
//     釘指紋那一行就可能整行放行、設定變更攔截那一條也一樣退 0（tests/guard-copy-claude.test.js ⑪），而那一行裡關不完；所以本機與專案設定檔都不准有 env 鍵。
//     平台的其他設定層（使用者層、受管設定層）與別的送貨管道這裡看不到。
//   鍵名的出處：停用所有鉤子的開關＝官方鉤子文件（https://code.claude.com/docs/en/hooks 的 disableAllHooks 段，2026-09-18 讀、2026-09-19 再核一次）
//     寫的 "disableAllHooks": true——是文件、不是量測；同一段也寫了啟動時帶 --settings 的另一條路，這裡看不到。env 是平台設定檔的鍵名，沒有另外量。
//   鍵名寫在下面的常數裡：平台改了鍵名，這條絆線會靜靜失效（沒有機器看著平台的設定格式）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { CLAUDE_BASE, CLAUDE_TEMPLATE_REL, treeFingerprint, claudeGroups, groupExtraKeys, Refusal } = require('./guard-copy.js');

const SETTINGS_REL = path.join('.claude', 'settings.json');
const LOCAL_SETTINGS_REL = path.join('.claude', 'settings.local.json');
/** 鉤子指令裡出現這一串＝它在找固定複本（範本的指令裡就是這一串；不合範本形狀卻提到它＝半套的釘法，要紅）。 */
const PINNED_MARK = CLAUDE_BASE.slice(-2).join('/');
const DISABLE_ALL_HOOKS = 'disableAllHooks';
const ENV_KEY = 'env';
const EVENTS = ['PreToolUse', 'ConfigChange'];

/** 讀一份 JSON 設定檔。回 { missing } ｜ { broken } ｜ { doc }。 */
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { missing: true } : { broken: `讀不到（${(e && e.code) || '不明'}）` };
  }
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? { doc } : { broken: '最外層不是一個物件' };
  } catch { return { broken: '不是合法的 JSON' }; }
}

/** 設定檔裡所有鉤子指令（不分事件），連同它住在哪一種事件底下。形狀怪的一律略過——形狀由等式那一步逐字比。 */
function hookCommands(doc) {
  const out = [];
  const hooks = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const h of group && Array.isArray(group.hooks) ? group.hooks : []) {
        if (h && typeof h.command === 'string') out.push({ event, group, command: h.command });
      }
    }
  }
  return out;
}

function claudePinStatus(root) {
  const file = path.join(root, SETTINGS_REL);
  const read = readJson(file);
  if (read.missing) return { state: 'absent', problems: [] };
  if (read.broken) return { state: 'mismatch', problems: [`${SETTINGS_REL} ${read.broken}`] };
  const pinnedLike = hookCommands(read.doc).filter((c) => c.command.includes(PINNED_MARK));
  if (!pinnedLike.length) return { state: 'live', problems: [] };

  let expected;
  try {
    expected = claudeGroups(treeFingerprint(root), fs.readFileSync(path.join(root, CLAUDE_TEMPLATE_REL), 'utf8'));
  } catch (e) {
    if (e instanceof Refusal || (e && e.code === 'ENOENT')) return { state: 'mismatch', problems: [`算不出這棵樹該有的那兩組（${e.message}）`] };
    throw e;
  }
  const problems = [];
  for (const event of EVENTS) {
    const groups = read.doc.hooks && Array.isArray(read.doc.hooks[event]) ? read.doc.hooks[event] : [];
    // 看起來就是那一組、卻多了鍵（async、if、args、timeout…任一個都可能讓它不擋）：說出是哪個鍵（下面逐字比也會紅，只是說不出原因）
    groups.forEach((g, i) => {
      const ours = g && Array.isArray(g.hooks) && g.hooks.some((h) => h && typeof h.command === 'string'
        && (h.command.includes(PINNED_MARK) || h.command === expected[event].hooks[0].command));
      const extra = ours ? groupExtraKeys(g) : [];
      if (extra.length) {
        problems.push(`${SETTINGS_REL} 的 hooks.${event}[${i}] 多了鍵（${extra.join('、')}）：組只准有 matcher、hooks，鉤子物件只准有 type、command`
          + '（官方鉤子文件列的 async、if、args、timeout 等欄位任一個都可能讓那一組不擋）；重跑 node tools/guard-copy.js --claude-line、把印出的那兩組原樣放進去');
      }
    });
    const same = groups.filter((g) => isDeepStrictEqual(g, expected[event]));
    if (same.length !== 1) {
      problems.push(`${SETTINGS_REL} 的 hooks.${event} 裡，逐字等於「這棵樹的範本＋這棵樹四個檔的指紋」的那一組有 ${same.length} 組（要剛好一組）：`
        + '在同一支變更裡重跑 node tools/guard-copy.js --claude-line、把印出的那兩組放進去，不要手改那一行');
    }
  }
  // 提到固定複本位置的指令，只能是剛好相符的那一條：多一條舊指紋的、改過字的，都是半套
  const strays = pinnedLike.filter((c) => !(c.event === 'PreToolUse' && isDeepStrictEqual(c.group, expected.PreToolUse)));
  if (strays.length) problems.push(`${SETTINGS_REL} 裡有 ${strays.length} 條鉤子指令提到固定複本的位置、卻不是這棵樹該有的那一條（舊指紋、或被改過字）`);
  return { state: problems.length ? 'mismatch' : 'ok', problems };
}

function localSettingsProblems(root) {
  const problems = [];
  const local = readJson(path.join(root, LOCAL_SETTINGS_REL));
  if (local.broken) problems.push(`${LOCAL_SETTINGS_REL} ${local.broken}：看不出裡面有沒有鉤子`);
  if (local.doc) {
    if ('hooks' in local.doc) problems.push(`${LOCAL_SETTINGS_REL} 有 hooks 鍵：鉤子只准住在進版控的 ${SETTINGS_REL}（本機那一份沒有人審）`);
    if (DISABLE_ALL_HOOKS in local.doc) problems.push(`${LOCAL_SETTINGS_REL} 有 ${DISABLE_ALL_HOOKS} 鍵：停用所有鉤子的開關不可以出現（不論設成什麼值）`);
    if (ENV_KEY in local.doc) problems.push(`${LOCAL_SETTINGS_REL} 有 ${ENV_KEY} 鍵：它會不會傳進鉤子的環境沒量，當成會（不論設成什麼值）`);
  }
  const project = readJson(path.join(root, SETTINGS_REL));
  if (project.doc && DISABLE_ALL_HOOKS in project.doc) problems.push(`${SETTINGS_REL} 有 ${DISABLE_ALL_HOOKS} 鍵：停用所有鉤子的開關不可以出現（不論設成什麼值）`);
  if (project.doc && ENV_KEY in project.doc) problems.push(`${SETTINGS_REL} 有 ${ENV_KEY} 鍵：它會不會傳進鉤子的環境沒量，當成會（不論設成什麼值）`);
  return problems;
}

module.exports = { claudePinStatus, localSettingsProblems, SETTINGS_REL, LOCAL_SETTINGS_REL, PINNED_MARK, DISABLE_ALL_HOOKS, ENV_KEY };
