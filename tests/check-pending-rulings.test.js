// 守待裁閘（規矩 A5 第二款）：本支貼了 ❓、還沒配對到 ⚖️ 或合規 🚫，就不放行。
//
// 守得到的：
//   ①本支有沒回的 ❓＝擋（退 1）、點名是哪一題；本支沒有 ❓、或每題都配上了＝放行；
//   ②只看問在本支的題：別支沒回的不擋這一支、別支已裁或已撤回的不列進本支（看題問在哪，不看答或撤回貼在哪）；
//     編號整個相等（7 不會被 17 的題擋到）；比的是平台給的正式編號（用 #7、分支名問也擋得到）；
//   ③答在別支的 ⚖️ 照樣配得上（掃整個專案的留言，不是只掃本支）；合規撤回也算收口；
//   ④疑似只印不擋；
//   ⑤判斷跟清單工具是同一份：同一批留言，閘擋下的題＝清單工具列在「還沒回」裡、掛在本支的那幾題；
//   ⑥平台問不到、裁示者沒填、沒給編號、有留言時間讀不出＝退 2，**不是退 0**；平台以外的錯照樣炸出去；
//   ⑦真的跑一遍指令（空白設定的複本）：退 2 不放行。
// ⚠️ 守不到的：形狀寫壞的 ❓ 不算問；對話裡問了、沒貼 ❓ 的看不見；已裁是推導；留言有沒有給齊（分頁是登記指令的責任）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gateRun, onlyThisChange } = require('../tools/gates/check-pending-rulings.js');
const { run: listRun } = require('../tools/pending-rulings.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const settings = {
  participants: [
    { role: '裁示者（擁有者）', id: 'Boss', account: 'boss-acct' },
    { role: 'AI 甲', id: 'Alpha', account: 'ai-acct' },
  ],
};
let n = 0;
const c = (body, over = {}) => ({ id: `c${++n}`, author: 'ai-acct', createdAt: new Date(Date.UTC(2026, 9, 7, 0, 0, n)).toISOString(), change: '7', body, ...over });
const ask = (title = '要不要做', over = {}) => c(`## ❓ 待裁（2026-10-07）：${title}\n選項：a／b\n建議的預設：a`, over);
const ruling = (askId, over = {}) => c(`## ⚖️ Boss 裁示（2026-10-07）：選 a\n原話（對話中，Alpha 轉述）：**「a」**\n落點：https://x/pull/7#issuecomment-${askId}`, { author: 'boss-acct', ...over });
const withdraw = (askId, over = {}) => c(`## 🚫 撤回（2026-10-07）：不用問了\n撤回理由：題目依附的東西沒了（那支變更已關）\nAlpha 撤回、Boss 未回；他隨時可以要我重問\nhttps://x/pull/7#issuecomment-${askId}`, over);

/** 假平台：allComments 回 answer；change 回那一支的正式編號（ids：問的寫法 → 正式編號，沒列的照原字），並記下被問了什麼。 */
function fakePlatform(answer, ids = {}) {
  const asked = [];
  return {
    asked,
    ask(op, args) {
      asked.push([op, args]);
      if (answer instanceof Error) throw answer;
      if (op === 'change') {
        const id = Object.hasOwn(ids, args.change) ? ids[args.change] : args.change;
        if (id instanceof Error) throw id;
        return { id, headSha: 'abc' };
      }
      if (op !== 'allComments') throw new PlatformError(`測試沒給 ${op} 的答案`);
      return answer;
    },
  };
}
const gate = (comments, id = '7') => gateRun(id, { settings, platform: fakePlatform(comments) });

test('①本支有沒回的 ❓＝擋（退 1），點名是哪一題', () => {
  const q = ask('第 2 批要不要提前');
  const platform = fakePlatform([q, c('一般留言')]);
  const r = gateRun('7', { settings, platform });
  assert.equal(r.code, 1, r.lines.join('\n'));
  const text = r.lines.join('\n');
  assert.match(text, /第 2 批要不要提前/u, '要點名是哪一題');
  assert.match(text, new RegExp(`留言 ${q.id}(?![0-9A-Za-z])`, 'u'), '要附那則 ❓ 的編號');
  assert.match(text, /不能按合併鍵/u);
  assert.deepEqual(platform.asked, [['change', { change: '7' }], ['allComments', {}]], '先問這一支的正式編號，再掃整個專案的留言');
});

test('①本支沒有 ❓、或每題都配上了＝放行（退 0）', () => {
  assert.equal(gate([c('一般留言')]).code, 0);
  assert.equal(gate([]).code, 0, '一則留言都沒有也是放行（沒有題就沒有沒回的題）');
  const q1 = ask('甲');
  const q2 = ask('乙');
  const r = gate([q1, q2, ruling(q1.id), withdraw(q2.id)]);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /已裁：1 則/u);
  assert.match(r.lines.join('\n'), /已撤回：1 則/u);
});

test('①兩題只回了一題＝照擋', () => {
  const q1 = ask('甲');
  const q2 = ask('乙');
  const r = gate([q1, q2, ruling(q1.id)]);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /還有 1 題沒回/u);
});

test('②只看問在本支的題：別支沒回的不擋；編號整個相等（7 不會被 17 擋到）', () => {
  const other = ask('別支的題', { change: '17' });
  const r = gate([other]);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(gate([other], '17').code, 1, '對照組：換成問 17 那一支就該擋');
  assert.equal(gate([ask('一位數', { change: '1' })], '17').code, 0, '1 的題不擋 17');
});

test('②比的是平台給的正式編號：用「#7」或分支名問，照樣擋到問在 7 的題；問不到這一支＝退 2', () => {
  const q = ask();
  for (const how of ['#7', 'topic-branch']) {
    const r = gateRun(how, { settings, platform: fakePlatform([q], { [how]: '7' }) });
    assert.equal(r.code, 1, `${how}：${r.lines.join('\n')}`);
    assert.match(r.lines.join('\n'), /待裁閘｜變更 7（/u, '印的是正式編號');
  }
  const missing = gateRun('9999', { settings, platform: fakePlatform([q], { 9999: new PlatformError('找不到這一支') }) });
  assert.equal(missing.code, 2, '不存在的編號不可以當成「沒有題」放行');
});

test('②別支已裁、已撤回的題不列進本支；本支的題答在別支、撤回貼在別支照樣列', () => {
  const otherRuled = ask('別支已裁', { change: '17' });
  const otherWithdrawn = ask('別支已撤回', { change: '17' });
  const mineRuled = ask('本支答在別支');
  const mineWithdrawn = ask('本支撤回貼在別支');
  const r = gate([
    otherRuled, otherWithdrawn, mineRuled, mineWithdrawn,
    ruling(otherRuled.id, { change: '17' }), withdraw(otherWithdrawn.id, { change: '17' }),
    ruling(mineRuled.id, { change: '9' }), withdraw(mineWithdrawn.id, { change: '9' }),
  ]);
  assert.equal(r.code, 0, r.lines.join('\n'));
  const text = r.lines.join('\n');
  assert.match(text, /已裁：1 則/u, text);
  assert.match(text, /已撤回：1 則/u, text);
  assert.match(text, new RegExp(`留言 ${mineRuled.id}(?![0-9A-Za-z])`, 'u'), '本支的題答在別支要列');
  assert.match(text, new RegExp(`留言 ${mineWithdrawn.id}(?![0-9A-Za-z])`, 'u'), '本支的題撤回貼在別支要列');
  for (const q of [otherRuled, otherWithdrawn]) assert.doesNotMatch(text, new RegExp(`留言 ${q.id}(?![0-9A-Za-z])`, 'u'), `別支的題 ${q.title} 不可以列進本支`);
});

test('③答在別支的 ⚖️ 照樣配得上；⚖️ 不是裁示者帳號貼的不算答', () => {
  const q = ask();
  const elsewhere = gate([q, ruling(q.id, { change: '9' })]);
  assert.equal(elsewhere.code, 0, '答在別支也算收口');
  assert.match(elsewhere.lines.join('\n'), /已裁：1 則/u, '答在別支的那一題要列在已裁（看的是題問在哪，不是答在哪）');
  assert.equal(gate([q, ruling(q.id, { author: 'ai-acct' })]).code, 1, '別人的帳號貼的裁示不關題（判斷照清單工具）');
});

test('④疑似只印不擋', () => {
  const near = c('更正（2026-10-07）：上面那則裁示的落點寫錯了');
  const r = gate([near]);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /疑似/u, '疑似要印出來讓人看見');
  assert.match(r.lines.join('\n'), /只印不擋/u);
  const elsewhere = c('更正（2026-10-07）：別支那則裁示的落點寫錯了', { change: '9' });
  assert.ok(listRun({ settings, platform: fakePlatform([elsewhere]) }).lines.some((l) => l.includes(elsewhere.id)), '對照組：清單工具要把它列成疑似');
  assert.equal(gate([elsewhere]).lines.some((l) => l.includes(elsewhere.id)), false, '別支的疑似不印');
});

test('⑤判斷跟清單工具同一份：閘擋下的題＝清單工具還沒回裡掛在本支的那幾題', () => {
  const q1 = ask('本支沒回');
  const q2 = ask('本支已回');
  const q3 = ask('別支沒回', { change: '8' });
  const comments = [q1, q2, q3, ruling(q2.id), c('## ❓ 待裁：少了日期')];
  const listed = listRun({ settings, platform: fakePlatform(comments) });
  assert.equal(listed.code, 0);
  // 清單工具「還沒回」那一段＝從「還沒回：」那一行到「已裁：」那一行之間
  const from = listed.lines.findIndex((l) => l.startsWith('還沒回：'));
  const to = listed.lines.findIndex((l) => l.startsWith('已裁：'));
  const listedHere = listed.lines.slice(from + 1, to).filter((l) => l.includes('｜變更 7｜'));
  const r = gate(comments);
  assert.equal(r.code, 1);
  assert.equal(listedHere.length, 1, listed.lines.join('\n'));
  assert.ok(r.lines.includes(listedHere[0]), `閘點名的題要跟清單工具印的那一行一字不差：\n${r.lines.join('\n')}`);
  const picked = onlyThisChange({ open: [q1, q3], ruled: [], withdrawn: [], near: [], accepted: [{ ...q1, id: 'a7' }, { ...q3, id: 'a8' }] }, '7');
  assert.deepEqual(picked.open.map((x) => x.id), [q1.id]);
  assert.deepEqual(picked.accepted.map((x) => x.id), ['a7'], '驗收留痕也只留本支的');
});

test('⑥平台問不到＝退 2，絕不是退 0；平台以外的錯照樣炸出去', () => {
  const r = gateRun('7', { settings, platform: fakePlatform(new PlatformError('形狀不合')) });
  assert.equal(r.code, 2);
  assert.match(r.lines.join('\n'), /問不到平台/u);
  assert.throws(() => gateRun('7', { settings, platform: fakePlatform(new TypeError('程式寫錯了')) }), TypeError);
});

test('⑥裁示者沒填、沒給編號＝退 2，而且不去問平台', () => {
  for (const bad of [{}, { participants: [{ role: '裁示者', id: '未設定', account: '未設定' }] }, { participants: [{ role: '裁示者', id: 'Boss', account: '未設定' }] }]) {
    const platform = fakePlatform([ask()]);
    const r = gateRun('7', { settings: bad, platform });
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.lines.join('\n'), /裁示者識別值或貼文帳號/u, '理由要說是設定沒填');
    assert.equal(platform.asked.length, 0, '設定沒填就不該去問平台');
  }
  const platform = fakePlatform([]);
  assert.equal(gateRun(undefined, { settings, platform }).code, 2);
  assert.equal(platform.asked.length, 0, '沒給編號也不該去問平台');
});

test('⑥有留言的時間讀不出（別支的也算）＝退 2，不是放行', () => {
  const q = ask();
  const r = gate([q, ruling(q.id), c('一般留言', { change: '9', createdAt: '2026-10-07 00:00:00' })]);
  assert.equal(r.code, 2, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /先後判不了/u);
});

test('⑦真的跑一遍指令（空白設定的複本，不讀本倉庫那份）：還沒填設定，退 2 不放行', () => {
  const r = runInCopy('tools/gates/check-pending-rulings.js', ['7']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /裁示者識別值或貼文帳號/u);
  const noArg = runInCopy('tools/gates/check-pending-rulings.js');
  assert.equal(noArg.status, 2, '沒給編號也要退 2');
});
