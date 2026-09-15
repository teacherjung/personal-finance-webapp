#!/usr/bin/env node
// 真考卷閘（規矩 H3）：能合併的那一顆版本，必過檢查要**真的跑過而且成功**。
//
// 為什麼不能只信平台的綠燈（原專案量到的事）：
//   ・被「跳過」的場次，平台會當成滿足必過檢查——跳過就是沒跑考卷，但畫面是綠的。
//   ・重跑一個舊場次時，平台沿用當初的事件內容，於是又蓋一筆「跳過」上去。
//   ・自動合併只看平台的綠燈，會繞過整套合併程序的閘，綠一到就自己合下去。
// 平台的語意改不動，所以在合併程序這一端收口：逐一去看那顆版本上的場次，要求結論就是成功。
//
// 兩個容易寫錯、原專案付過代價的地方：
//   ①**身分**：必過檢查釘了產生者時，只認那個產生者貼的場次——否則任何人貼一個同名的成功就能冒名放行。
//   ②**同刻並列**：完成時間的精度有限，平台也沒承諾「同一刻誰比較晚」。所以取最晚那一刻的**全部**場次，
//     只要有一場不是成功就當結論不明、擋下來。寧可多跑一次考卷，也不去猜平台沒承諾的順序。
//
// 判斷本身（evaluate）是純函式，考題直接餵它。平台的事一律走 tools/platform.js。
'use strict';
const { ask, PlatformError } = require('../platform.js');
const { read: readSettings } = require('../settings-data.js');
const { parseInstant } = require('../time-point.js');

const UNSET = '未設定';

/**
 * 純判斷層。
 * @param {Array<{name:string,status:string,conclusion:string|null,completedAt:string|null,producer:string|null}>} runs 那顆版本上的**全部**場次
 * @param {boolean} autoMergeOn 平台的自動合併開著嗎
 * @param {Array<{name:string,producer:string|null}>} required 必過檢查名單
 */
function evaluate(runs, autoMergeOn, required) {
  if (autoMergeOn) {
    return { code: 1, reason: '平台的自動合併開著——它只看平台的綠燈（跳過也算滿足），而且會繞過整套合併程序的閘。先把它關掉' };
  }
  if (!Array.isArray(required) || required.length === 0) {
    return { code: 2, reason: '必過檢查的名單是空的——查不到就不是安全，是不知道（分支保護被關掉了嗎）' };
  }
  for (const { name, producer } of required) {
    const mine = runs.filter((r) => r.name === name && (producer === null || r.producer === producer));
    if (mine.length === 0) {
      return { code: 2, reason: `那顆版本上找不到必過檢查「${name}」的正牌場次（產生者 ${producer === null ? '不限' : producer}）——查不到就不放行` };
    }
    if (mine.some((r) => r.status !== 'completed')) {
      return { code: 1, reason: `「${name}」還有場次在跑——等它跑完再判` };
    }
    // ⚠️ 完成了的場次要有**合法的完成時間**與**非空的結論**，否則整個判斷是建在沙上（r1 High②：
    //    完成時間是 null 或亂字時，字典序會讓它排到日期後面，一場沒有時間的「成功」就蓋掉了真的失敗）。
    //    時間用**時間值**比、不用字串比：兩個合法但不同時區的寫法，字串序會排錯。
    // 時間走共用契約（r3 High①）：沒帶時區的時間在不同執行機器會判出不同先後，不收
    const broken = mine.find((r) => parseInstant(r.completedAt) === null || typeof r.conclusion !== 'string' || !r.conclusion);
    if (broken) {
      return { code: 2, reason: `「${name}」有一場標成完成、卻沒有合法（帶時區）的完成時間或結論（時間「${broken.completedAt}」、結論「${broken.conclusion}」）——場次資料不合契約，查不清楚就不放行` };
    }
    const at = (r) => parseInstant(r.completedAt);
    const maxAt = Math.max(...mine.map(at));
    const tied = mine.filter((r) => at(r) === maxAt);
    const bad = tied.find((r) => r.conclusion !== 'success');
    if (bad) {
      return { code: 1, reason: `「${name}」最新那一刻的場次結論是「${bad.conclusion}」——跳過就是沒真跑，其餘就是沒過；同一刻結論不一致也算不明。重跑到真的成功再合併` };
    }
  }
  return { code: 0, reason: `必過檢查（${required.map((r) => r.name).join('、')}）在那顆版本上都真的跑過且成功，自動合併也關著` };
}

/** 跑這道閘。平台查不到、設定沒填，一律退 2。 */
function gateRun(changeId, { settings = readSettings(), platform = { ask } } = {}) {
  const lines = [];
  if (!changeId) return { code: 2, lines: ['用法：node tools/gates/check-checks-really-ran.js <變更編號>'] };
  const mainBranch = settings.mainBranch;
  if (!mainBranch || mainBranch === UNSET) {
    return { code: 2, lines: [`專案設定裡的主幹分支名還是「${UNSET}」：不知道去哪裡讀必過檢查名單，不放行。`] };
  }
  let change;
  let required;
  let runs;
  try {
    change = platform.ask('change', { change: String(changeId) }, { settings });
    required = platform.ask('requiredChecks', { branch: mainBranch }, { settings });
    runs = platform.ask('checks', { sha: change.headSha }, { settings });
  } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) {
      lines.push(`真考卷閘：問不到平台（${e.message}）——查不到就不是安全，不放行。`);
      return { code: 2, lines };
    }
    throw e;
  }
  const r = evaluate(runs, change.autoMergeOn, required);
  lines.push(`真考卷閘｜變更 ${changeId}（版本 ${change.headSha}）：${r.reason}`);
  return { code: r.code, lines };
}

if (require.main === module) {
  let result;
  try { result = gateRun(process.argv[2]); }
  catch (e) { result = { code: 2, lines: [`真考卷閘：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——不放行。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { gateRun, evaluate };
