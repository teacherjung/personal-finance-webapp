#!/usr/bin/env node
// 堆疊閘（規矩 H2）：這一支的底必須是主幹，而且不可以有別支疊在它上面。
//
// 它防的是原專案兩次真實事故，兩次的畫面都是「已合併＋檢查全綠＋零錯誤訊息」：
//   ①底不是主幹 → 按下合併鍵會把這一支合進**另一支分支**，不是主幹。
//   ②有別支以這一支的頭為底 → 合併後刪分支會把上層那幾支連帶關成「已合併」，而且救不回來。
// 所以「查不到」不等於「安全」：查不清楚一律當堆疊、不放行（退 2）。
//
// 平台的事一律走 tools/platform.js；這一支不認識任何平台的語彙。
// 判斷本身（evaluate）是純函式，考題直接餵它，不必碰任何平台。
'use strict';
const { ask, PlatformError } = require('../platform.js');
const { read: readSettings } = require('../settings-data.js');

const UNSET = '未設定';

/**
 * 純判斷層。
 * @param {{ baseBranch: string, headBranch: string, isCrossRepo: boolean }} change
 * @param {Array<{ id: string, baseBranch: string }>} openChanges 目前開著的每一支（必須是全部）
 * @param {string} mainBranch
 */
function evaluate(change, openChanges, mainBranch) {
  if (change.isCrossRepo) {
    return { code: 2, reason: '這一支來自別的倉庫，堆疊判斷不可靠（兩邊的分支名會撞名）——請人工確認後再決定' };
  }
  if (change.baseBranch !== mainBranch) {
    return { code: 1, reason: `底是「${change.baseBranch}」不是主幹「${mainBranch}」——按下合併鍵會把它合進那一支分支，不是主幹。先把底改回主幹再重新接上去` };
  }
  const stacked = openChanges.filter((c) => c.baseBranch === change.headBranch);
  if (stacked.length) {
    return { code: 1, reason: `有 ${stacked.length} 支疊在這一支上面（${stacked.map((c) => c.id).join('、')}）——合併後刪分支會把它們連帶關成「已合併」且救不回來。先處理上層那幾支` };
  }
  return { code: 0, reason: `底是主幹「${mainBranch}」、沒有別支疊在上面` };
}

/** 跑這道閘。平台查不到、設定沒填，一律退 2。 */
function gateRun(changeId, { settings = readSettings(), platform = { ask } } = {}) {
  const lines = [];
  if (!changeId) return { code: 2, lines: ['用法：node tools/gates/check-stacked.js <變更編號>'] };
  const mainBranch = settings.mainBranch;
  if (!mainBranch || mainBranch === UNSET) {
    return { code: 2, lines: [`專案設定裡的主幹分支名還是「${UNSET}」：不知道底該是什麼，查不清楚就不放行。`] };
  }
  let change;
  let openChanges;
  try {
    change = platform.ask('change', { change: String(changeId) }, { settings });
    openChanges = platform.ask('openChanges', {}, { settings });
  } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) {
      lines.push(`堆疊閘：問不到平台（${e.message}）——查不清楚一律當堆疊，不放行。`);
      return { code: 2, lines };
    }
    throw e;
  }
  const r = evaluate(change, openChanges, mainBranch);
  lines.push(`堆疊閘｜變更 ${changeId}：${r.reason}`);
  return { code: r.code, lines };
}

if (require.main === module) {
  let result;
  try { result = gateRun(process.argv[2]); }
  catch (e) { result = { code: 2, lines: [`堆疊閘：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——查不清楚就不放行。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { gateRun, evaluate };
