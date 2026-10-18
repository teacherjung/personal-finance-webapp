// A1 的指派登記與留痕路由；範圍語意、來源真偽及本人保留事項仍由人核對。
'use strict';
const { parseInstant } = require('./time-point.js');
const { leadingLines } = require('./markdown-effective.js');
const plain = (v) => typeof v === 'string' && v.trim() === v && v.length > 0 && Array.from(v).every((c) => c.charCodeAt(0) > 31 && ![127, 133, 8232, 8233].includes(c.charCodeAt(0)));
const fail = (why) => { throw new Error(`裁示指派設定：${why}；核對 settings.json 的 rulingAssignments 後重跑原指令`); };

/** 身分與舊設定相容入口；時間表存在時，角色說明不再決定預設路由。 */
function identitiesOf(settings) {
  const all = Array.isArray(settings.participants) ? settings.participants : [];
  const valid = (p) => p && plain(p.id) && p.id !== '未設定' && plain(p.account) && p.account !== '未設定';
  const defaults = all.filter((p) => p && typeof p.role === 'string' && p.role.startsWith('裁示者'));
  const scheduled = Array.isArray(settings.rulingAssignments) && settings.rulingAssignments.some((a) => a && a.id === 'default');
  if (!scheduled && defaults.length > 1) return null;
  const owners = all.filter((p) => p && p.id === settings.owner);
  const owner = owners.length === 1 && valid(owners[0]) ? owners[0] : null;
  if (Array.isArray(settings.rulingAssignments) && settings.rulingAssignments.length && !owner) return null;
  const fallback = scheduled ? owner : defaults[0] || owner;
  if (!valid(fallback)) return null;
  if ([owner, fallback].filter(Boolean).some((p) => all.filter((x) => x && x.id === p.id).length !== 1)) return null;
  return { id: fallback.id, account: fallback.account, ownerId: owner ? owner.id : null, ownerAccount: owner ? owner.account : null,
    ids: all.filter(valid).map((p) => p.id), accounts: all.filter(valid).map((p) => p.account) };
}

function assignmentsOf(settings) {
  if (!Object.hasOwn(settings, 'rulingAssignments')) return [];
  if (!Array.isArray(settings.rulingAssignments)) fail('必須是陣列');
  const result = settings.rulingAssignments.map((a) => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).sort().join(',') !== 'decider,from,id,scope,source,until') fail('欄位須為 id、decider、scope、source、from、until');
    if (!plain(a.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(a.id)) fail('識別值不合法');
    if (![a.decider, a.scope, a.source].every(plain)) fail('裁示者、範圍與來源須填非空單行');
    let url;
    try { url = new URL(a.source); } catch { fail('來源須為完整 HTTPS 網址'); }
    if (url.protocol !== 'https:' || url.username || url.password || /\s/u.test(a.source)) fail('來源須為完整 HTTPS 網址');
    const from = a.from === null && a.id === 'default' ? -Infinity : parseInstant(a.from);
    const until = a.until === null ? null : parseInstant(a.until);
    if (from === null || (a.until !== null && (until === null || until <= from))) fail('起訖時間須帶時區且結束晚於開始；未結束填 null，僅 default 的舊制起點可填 null');
    const persons = (settings.participants || []).filter((p) => p && p.id === a.decider);
    if (persons.length !== 1 || !plain(persons[0].account) || persons[0].account === '未設定' || a.decider === '未設定') fail('指定裁示者須唯一登記在參與者表，並有貼文帳號');
    return { ...a, account: persons[0].account, fromMs: from, untilMs: until };
  });
  for (const id of new Set(result.map((a) => a.id))) {
    const periods = result.filter((a) => a.id === id).sort((a, b) => a.fromMs - b.fromMs);
    for (let i = 1; i < periods.length; i++) {
      if (periods[i - 1].untilMs === null || periods[i].fromMs < periods[i - 1].untilMs) fail(`「${id}」的有效期間重疊；換人須保留舊期並結束於新期開始時`);
    }
  }
  if (result.length && !identitiesOf(settings)) fail('啟用指派須明確登記唯一擁有者、裁示者與貼文帳號');
  const legacy = (settings.participants || []).filter((p) => p && typeof p.role === 'string' && p.role.startsWith('裁示者'));
  if (result.some((a) => a.id === 'default') && legacy.length === 1 && legacy[0].id !== settings.owner
    && !result.some((a) => a.id === 'default' && a.decider === legacy[0].id)) fail(`時間表缺少仍登記的舊預設「${legacy[0].id}」歷史段；核對遷移前後待裁配對，不可刪掉角色掩蓋遺漏`);
  return result;
}

// 只辨認該拒收的欄位候選；原始整行另驗，剝下裝飾不能換得授權。
const decoration = /^[\p{White_Space}\p{P}\p{S}\p{N}\p{M}\p{Default_Ignorable_Code_Point}]+/u;
const chineseNumerals = /^[零〇一二三四五六七八九十百千萬兩壹貳參肆伍陸柒捌玖拾佰仟]+/u;
const listDelimiter = /^[.．、)）]/u;
function assignmentCandidate(line) {
  let rest = line;
  while (rest) {
    const chinese = chineseNumerals.exec(rest);
    if (chinese) {
      const tail = rest.slice(chinese[0].length);
      if (!listDelimiter.test(tail)) break;
      rest = tail.slice(1);
      continue;
    }
    const letter = /^[A-Za-z][.．、)）]/u.exec(rest);
    if (letter) { rest = rest.slice(letter[0].length); continue; }
    const prefix = decoration.exec(rest);
    if (!prefix) break;
    // 〇 屬 Unicode 數字，仍須按中文列號驗分隔符，不能由通用類別吃掉。
    const zero = prefix[0].indexOf('〇');
    const length = zero < 0 ? prefix[0].length : zero;
    if (!length) break;
    rest = rest.slice(length);
  }
  return /^裁示指派(?:[\p{White_Space}\p{P}\p{S}\p{N}\p{M}\p{Default_Ignorable_Code_Point}]|$)/u.test(rest);
}

/** 一行指向一條既有指派路由，不新增權限。 */
function assignmentOf(body) {
  const text = String(body || '').replace(/\r\n?/g, '\n');
  const { lines: effective, stopAt } = leadingLines(text);
  // 停止行只用來辨認壞指派，不讀它後面的引用內容或從中授權。
  const candidates = stopAt ? [...effective, text.split('\n')[stopAt - 1]] : effective;
  const lines = candidates.filter(assignmentCandidate);
  if (!lines.length) return { id: null, invalid: false };
  const match = /^裁示指派：([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/u.exec(lines[0]);
  return { id: match ? match[1] : null, invalid: lines.length !== 1 || !match };
}
function activeAt(assignment, createdAt) {
  const time = parseInstant(createdAt);
  return time !== null && time >= assignment.fromMs && (assignment.untilMs === null || time < assignment.untilMs);
}
function resolveAt(assignments, decider, body, createdAt) {
  const marker = assignmentOf(body);
  if (marker.invalid) return null;
  const routeId = marker.id || 'default';
  const assignment = assignments.find((a) => a.id === routeId && activeAt(a, createdAt));
  if (assignment) return { id: assignment.decider, account: assignment.account, routeId, assignment };
  if (routeId !== 'default') return null;
  return { id: decider.id, account: decider.account, routeId };
}
/** 開工直接顯示當刻路由；時間可注入，考題不依賴牆鐘。 */
function routingSummary(settings, time = new Date().toISOString()) {
  const decider = identitiesOf(settings);
  if (!decider) return ['裁示者設定查不清；核對 owner、participants 的識別值／帳號與重複裁示者角色，再重跑原指令。'];
  const assignments = assignmentsOf(settings);
  const scheduled = assignments.some((a) => a.id === 'default');
  const current = resolveAt(assignments, decider, '', time);
  const lines = [`裁示角色｜擁有者：${decider.ownerId || '未登記（僅舊設定相容）'}｜預設模式：${scheduled ? '明確時間表' : '舊設定相容模式'}｜目前預設：${current.id}${current.assignment ? `｜來源：${current.assignment.source}` : '（無當期 default 指派或沿用舊設定）'}`];
  for (const a of assignments.filter((a) => a.id !== 'default' && activeAt(a, time))) lines.push(`範圍裁示｜${a.id}：${a.decider}｜${a.scope}｜來源：${a.source}`);
  lines.push('新題先依既有指派選路由；格式與歷史銜接讀 templates/ruling-record.md，完整時間表見 settings.json／PROJECT-SETTINGS.md。');
  return lines;
}
module.exports = { assignmentsOf, assignmentOf, activeAt, identitiesOf, resolveAt, routingSummary };
