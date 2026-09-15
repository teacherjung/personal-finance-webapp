// 守合併後驗收分級（規矩 H6）：只算不擋；讓裁示者少做不必要的驗收、不漏必要的。
//
// 守得到的：①動作累積、級別寫最重的；②沒列到的路徑當指定那一級並列出來；③改名前的舊路徑也算；
//   ⑤改名或複製卻沒帶舊路徑＝退 2（r1 Medium⑦）；平台有自報總數就對帳，對不上＝退 2（清單可能被平台的筆數上限截掉）；
//   ④分級表沒填好（少欄、unknownTier 不在 tiers 裡、家族指到不存在的級）＝退 2；平台問不到＝退 2；沒有路徑＝退 2；
//   ⑥**有一筆壞就整張不算**（不濾掉）：家族缺欄、樣式沒以 ^ 開頭、樣式不是合法正規式、級別缺動作＝退 2（搬家前準備）。
// ⚠️ 守不到的：表本身對不對（新家族出現時它會落到指定那一級並被列出，由改表的人補）；有沒有照印出來的做。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, classify, tableOf } = require('../tools/acceptance-tier.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const ACC = {
  tiers: [{ id: '重啟走流程', action: '重啟並走一遍核心流程' }, { id: '重新整理', action: '重新整理頁面看一眼' }, { id: '不需驗收', action: '回報不需驗收' }],
  families: [{ pattern: '^lib/', tier: '重啟走流程' }, { pattern: '^public/', tier: '重新整理' }, { pattern: '^docs/', tier: '不需驗收' }, { pattern: '^[^/]+\\.md$', tier: '不需驗收' }],
  unknownTier: '重啟走流程',
};
const settings = { acceptance: ACC };
const table = tableOf(settings);

test('①動作累積、級別寫最重的；只命中最輕的就只有最輕的', () => {
  const r = classify(['docs/a.md', 'public/x.js', 'lib/y.js'], table);
  assert.equal(r.level, '重啟走流程');
  assert.deepEqual(r.actions.map((a) => a.tier), ['重啟走流程', '重新整理', '不需驗收']);
  assert.equal(classify(['README.md'], table).level, '不需驗收');
});

test('②沒列到的路徑當指定那一級並列出來（不確定就往重的算）', () => {
  const r = classify(['docs/a.md', 'weird/new.js'], table);
  assert.equal(r.level, '重啟走流程');
  assert.deepEqual(r.unknown, ['weird/new.js']);
});

/** 假平台：change 回自報總數，changedFiles 回清單。 */
const fake = (files, count = String(files.length)) => ({ ask: (op) => (op === 'change' ? { changedFileCount: count } : files) });

test('⑤改名沒帶舊路徑＝退 2；自報總數對不上＝退 2；沒自報就不對帳但要說', () => {
  const half = run('7', { settings, platform: fake([{ path: 'docs/old.md', status: 'renamed', previousPath: null }]) });
  assert.equal(half.code, 2); assert.match(half.lines.join('\n'), /沒帶舊路徑/u);
  const short = run('7', { settings, platform: fake([{ path: 'docs/a.md', status: 'modified', previousPath: null }], '5') });
  assert.equal(short.code, 2); assert.match(short.lines.join('\n'), /清單不完整/u);
  const bad = run('7', { settings, platform: fake([{ path: 'docs/a.md', status: 'modified', previousPath: null }], 'many') });
  assert.equal(bad.code, 2);
  const none = run('7', { settings, platform: fake([{ path: 'docs/a.md', status: 'modified', previousPath: null }], null) });
  assert.equal(none.code, 0); assert.match(none.lines.join('\n'), /沒對帳/u);
});

test('③改名前的舊路徑也算；④設定沒填好、平台問不到、沒有路徑＝退 2', () => {
  const platform = fake([{ path: 'docs/new.md', status: 'renamed', previousPath: 'lib/old.js' }]);
  const r = run('7', { settings, platform });
  assert.equal(r.code, 0);
  assert.equal(r.result.level, '重啟走流程', '舊路徑在 lib/ 底下，要算最重的');
  for (const bad of [{}, { acceptance: { ...ACC, unknownTier: '不存在' } }, { acceptance: { ...ACC, families: [{ pattern: '^x', tier: '不存在' }] } }, { acceptance: { ...ACC, tiers: [] } }]) {
    assert.equal(run('7', { settings: bad, platform }).code, 2, JSON.stringify(bad));
  }
  assert.equal(run('7', { settings, platform: { ask() { throw new PlatformError('x'); } } }).code, 2);
  assert.equal(run('7', { settings, platform: fake([]) }).code, 2, '沒有路徑不猜');
  assert.equal(run(undefined, { settings, platform }).code, 2);
  assert.throws(() => run('7', { settings, platform: { ask() { throw new TypeError('程式寫錯'); } } }), TypeError);
  assert.equal(runInCopy('tools/acceptance-tier.js', ['7']).status, 2, '空白設定的複本：設定未填');
});

test('⑥有一筆壞就整張不算：不可以濾掉那一筆、讓那一族的路徑靜靜落到別的級（搬家前準備）', () => {
  assert.ok(tableOf({ acceptance: ACC }), '對照組：好的表讀得出來');
  const broken = (patch) => ({ acceptance: { ...ACC, ...patch } });
  const cases = [
    ['家族少了樣式', broken({ families: [...ACC.families, { tier: '重新整理' }] })],
    ['家族樣式沒以 ^ 開頭（會命中路徑中段）', broken({ families: [...ACC.families, { pattern: 'lib/', tier: '重啟走流程' }] })],
    ['家族樣式不是合法正規式', broken({ families: [...ACC.families, { pattern: '^(', tier: '重啟走流程' }] })],
    ['家族樣式是未設定', broken({ families: [...ACC.families, { pattern: '未設定', tier: '重新整理' }] })],
    ['級別缺動作', broken({ tiers: [...ACC.tiers, { id: '多出來的' }] })],
    ['級別是空字串', broken({ tiers: [...ACC.tiers, { id: ' ', action: 'x' }] })],
  ];
  for (const [why, s] of cases) {
    assert.equal(tableOf(s), null, why);
    const r = run('7', { settings: s, platform: fake([{ path: 'lib/a.js', status: 'modified', previousPath: null }]) });
    assert.equal(r.code, 2, `${why}：退 2`);
  }
});
