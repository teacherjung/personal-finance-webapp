#!/usr/bin/env node
// 待裁閘（規矩 A5 第二款）：本支PR上貼了 ❓、還沒有配對到 ⚖️ 或合規 🚫 的，不能按合併鍵。
//
// 為什麼另立一支、不把待裁清單本身改成閘：擁有者 2026-09-06 裁的是「開工時印出來的小工具」
// （案例 pending-rulings-list-tool），清單腳本只列不擋；2026-10-07 他裁第 2 批機器提前做，擋合併的是這一支。
// 判斷只有一份：形狀、配對、時間契約全用 tools/pending-rulings.js 的 evaluate，這裡只挑出掛在本支的那幾題。
// 掃整個專案的留言（allComments）、不是只掃本支：裁示可能貼在別支（清單工具同一個理由），只掃本支會把答過的題當成沒回。
// 疑似（長得像留痕但不採計）只印不擋：第一行帶到「待裁」「裁示」這類字的正常留言（更正、落點補充）也會落在疑似，擋它們就是假紅。
//
// ⚠️ 守不到的：
//   ①沒照範本形狀貼的 ❓ 不算問（落在疑似、照印不擋）；對話裡問了、還沒貼 ❓ 的完全看不見（I3 不貼就沒有東西可數）；
//   ②已裁是推導：⚖️ 引到 ❓ 的編號就算配上，引了不等於真的在回答它；原話只驗形狀，驗不出是不是裁示者說的；
//   ③整個專案的留言有沒有給齊（分頁是登記指令的責任）：少給的若是 ⚖️＝誤擋，少給的若是 ❓＝漏擋；
//   ④A5 另外兩款（裁示者叫停、改到禁區清單的PR要擁有者點頭）它一概不看；
//   ⑤整個專案任何一則留言的時間讀不出，就連本支也判不了（退 2）——判斷是整份一起算的。
'use strict';
const { ask, PlatformError } = require('../platform.js');
const { read: readSettings } = require('../settings-data.js');
const { evaluate, render, deciderOf } = require('../pending-rulings.js');

/** 只留掛在這一支的：問在本支的題（不管答在哪一支），以及第一行在本支的疑似。編號整個相等，7 不可以命中 17。 */
function onlyThisChange(result, changeId) {
  const mine = (c) => String(c.change) === String(changeId);
  return {
    open: result.open.filter(mine),
    ruled: result.ruled.filter((x) => mine(x.ask)),
    withdrawn: result.withdrawn.filter((x) => mine(x.ask)),
    near: result.near.filter(mine),
    accepted: (result.accepted || []).filter(mine),
  };
}

function gateRun(changeId, { settings = readSettings(), platform = { ask } } = {}) {
  if (!changeId) return { code: 2, lines: ['用法：node tools/gates/check-pending-rulings.js <變更編號>'] };
  const decider = deciderOf(settings);
  if (!decider) return { code: 2, lines: ['待裁閘：專案設定裡的裁示者識別值或貼文帳號還沒填——分不出誰的裁示算數，查不清楚就不放行。'] };
  // 先問平台這一支的正式編號再比對：平台認得「#48」、分支名這類寫法，其他閘照跑，這裡若拿原字去比就一題都對不上、放行
  let id;
  let comments;
  try {
    id = platform.ask('change', { change: String(changeId) }, { settings }).id;
    comments = platform.ask('allComments', {}, { settings });
  } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) {
      return { code: 2, lines: [`待裁閘：問不到平台（${e.message}）——查不清楚就不放行。`] };
    }
    throw e;
  }
  const result = evaluate(comments, decider);
  if (result.unsure) return { code: 2, lines: [`待裁閘：${result.unsure}——先後判不了，查不清楚就不放行。`] };
  const mine = onlyThisChange(result, id);
  const lines = [`待裁閘｜變更 ${id}（掃了整個專案 ${comments.length} 則留言，只看問在這一支的題）`, ...render(mine)];
  if (mine.near.length) lines.push('疑似那幾則只印不擋：真的是在問裁示者的，照 templates/ruling-record.md 的形狀另貼一則 ❓（不編輯舊的）。');
  if (mine.open.length) {
    lines.push(`這一支還有 ${mine.open.length} 題沒回：照規矩 A5 不能按合併鍵。等裁示者回、照範本貼 ⚖️（或合規撤回 🚫）之後，合併指令從頭再跑。`);
    return { code: 1, lines };
  }
  lines.push('這一支沒有還沒回的待裁。');
  return { code: 0, lines };
}

if (require.main === module) {
  let result;
  try { result = gateRun(process.argv[2]); }
  catch (e) { result = { code: 2, lines: [`待裁閘：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——查不清楚就不放行。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { gateRun, onlyThisChange };
