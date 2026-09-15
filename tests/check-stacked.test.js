// 守堆疊閘（規矩 H2）。原專案兩次真實事故各對一條判斷，兩次的畫面都是「已合併＋檢查全綠＋零錯誤訊息」。
//
// 守得到的：
//   ①底不是主幹＝擋（退 1）；②有別支以這一支的頭為底＝擋（退 1）；
//   ③來自別的倉庫＝查不清楚（退 2），不是放行；
//   ④平台問不到（沒登記、指令壞掉、形狀不合）＝退 2，**不是退 0**；
//   ⑤主幹分支名沒填、沒給變更編號＝退 2；
//   ⑥判斷用的是設定裡的主幹名，不是寫死的 main；
//   ⑦只有「以這一支的頭為底」的才算疊在上面（別支之間互疊不算）。
//
// ⚠️ 守不到的：平台回的答案是不是真的；開著的變更清單**有沒有少給**（分頁是那條指令自己的責任，
//    這裡驗不到——少給就會少看到上層那幾支，方向是漏擋，照實寫在這裡）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gateRun, evaluate } = require('../tools/gates/check-stacked.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const change = (over = {}) => ({ baseBranch: 'main', headBranch: 'topic', isCrossRepo: false, ...over });
const open = (id, baseBranch) => ({ id, baseBranch });

/** 假平台：照 answers 回答，並記下被問了什麼。 */
function fakePlatform(answers) {
  const asked = [];
  return {
    asked,
    ask(op, args) {
      asked.push([op, args]);
      const a = answers[op];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new PlatformError(`測試沒給 ${op} 的答案`);
      return a;
    },
  };
}
const settings = { mainBranch: 'main' };

test('底是主幹、沒有別支疊在上面＝放行', () => {
  const platform = fakePlatform({ change: change(), openChanges: [open('8', 'main')] });
  const r = gateRun('7', { settings, platform });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual(platform.asked.map((x) => x[0]), ['change', 'openChanges']);
  assert.deepEqual(platform.asked[0][1], { change: '7' }, '要問的是這一支');
});

test('底不是主幹＝擋（按下去會合進別支分支）', () => {
  const r = gateRun('7', { settings, platform: fakePlatform({ change: change({ baseBranch: 'other' }), openChanges: [] }) });
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /不是主幹/u);
});

test('有別支以這一支的頭為底＝擋（刪分支會把它們連帶關掉）', () => {
  const r = gateRun('7', {
    settings,
    platform: fakePlatform({ change: change(), openChanges: [open('8', 'topic'), open('9', 'main'), open('10', 'topic')] }),
  });
  assert.equal(r.code, 1);
  const text = r.lines.join('\n');
  assert.match(text, /有 2 支疊在這一支上面/u);
  assert.match(text, /8、10/u, '要點名是哪幾支');
  assert.doesNotMatch(text, /9/u, '別支之間互疊不算');
});

test('來自別的倉庫＝查不清楚，不是放行', () => {
  const r = gateRun('7', { settings, platform: fakePlatform({ change: change({ isCrossRepo: true }), openChanges: [] }) });
  assert.equal(r.code, 2);
  assert.notEqual(r.code, 0);
});

test('平台問不到＝退 2，絕不是退 0', () => {
  for (const answers of [
    { change: new PlatformError('沒登記') },
    { change: change(), openChanges: new PlatformError('形狀不合') },
  ]) {
    const r = gateRun('7', { settings, platform: fakePlatform(answers) });
    assert.equal(r.code, 2, JSON.stringify(Object.keys(answers)));
    assert.match(r.lines.join('\n'), /查不清楚一律當堆疊/u);
  }
});

test('平台丟的不是平台的錯，就讓它炸出去（不要吞掉自己看不懂的錯）', () => {
  const boom = new TypeError('程式寫錯了');
  assert.throws(() => gateRun('7', { settings, platform: fakePlatform({ change: boom }) }), TypeError);
});

test('主幹分支名沒填、沒給變更編號＝退 2（而且是因為設定沒填，不是因為問不到）', () => {
  // ⚠️ 假平台要**答得出來**：否則就算把主幹名那道檢查拿掉，也會因為「問不到」而退 2，
  //    這一題就永遠綠（突變驗過）。
  const answers = () => fakePlatform({ change: change(), openChanges: [] });
  for (const bad of [{ mainBranch: '未設定' }, {}, { mainBranch: '' }]) {
    const platform = answers();
    const r = gateRun('7', { settings: bad, platform });
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.lines.join('\n'), /主幹分支名/u, '理由要說是設定沒填');
    assert.equal(platform.asked.length, 0, '設定沒填就不該去問平台');
  }
  const platform = answers();
  assert.equal(gateRun(undefined, { settings, platform }).code, 2);
  assert.equal(platform.asked.length, 0, '沒給編號也不該去問平台');
});

test('判斷用的是設定裡的主幹名，不是寫死的 main', () => {
  const trunk = { mainBranch: '主線' };
  const platform = fakePlatform({ change: change({ baseBranch: '主線' }), openChanges: [] });
  assert.equal(gateRun('7', { settings: trunk, platform }).code, 0);
  const platform2 = fakePlatform({ change: change({ baseBranch: 'main' }), openChanges: [] });
  assert.equal(gateRun('7', { settings: trunk, platform: platform2 }).code, 1, 'main 在這個專案不是主幹，應該擋');
});

test('純判斷層可以直接考，不必碰平台', () => {
  assert.equal(evaluate(change(), [], 'main').code, 0);
  assert.equal(evaluate(change({ baseBranch: 'x' }), [], 'main').code, 1);
  assert.equal(evaluate(change(), [open('8', 'topic')], 'main').code, 1);
  assert.equal(evaluate(change({ isCrossRepo: true }), [], 'main').code, 2);
});

test('真的跑一遍指令（空白設定的複本，不讀本倉庫那份）：還沒填設定，退 2 不放行', () => {
  const r = runInCopy('tools/gates/check-stacked.js', ['7']);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /不放行|主幹分支名/u);
  const noArg = runInCopy('tools/gates/check-stacked.js');
  assert.equal(noArg.status, 2, '沒給編號也要退 2');
});
