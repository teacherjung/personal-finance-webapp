// 守合併前風險分級（規矩 D4）：依檔案先算高／中／低，只算不擋。
//
// 守得到的：①取最重的那一級、各級命中的路徑都列出；②沒列在風險表上的路徑一律算高並列出來（D4：判不出＝高）；
//   ③改名前的舊路徑也算（跟驗收分級共用 changedPaths）；④印出那一級在複審與掃描分級表上的那一列、沒有那一列要說；
//   ⑤升級條件照設定印出來，沒填要說；⑥風險表有一筆壞（樣式沒以 ^ 開頭、不是合法正規式、級別不在三種裡）就整張不算＝退 2；
//   ⑦平台問不到、沒有路徑、沒給編號＝退 2；空白設定的複本裡跑指令入口＝退 2。
//   ⑧第一行印出級別與清單有沒有跟平台自報總數對帳；
//   ⑨一個檔對上幾個家族取最重的、跟表的順序無關（#32 r2：取第一個對上的話，^docs/ 低排在 ^docs/contracts/ 高前面就把高算成低）。
// ⚠️ 守不到的：內容碰不碰到升級條件（要讀內容）；表本身分得對不對；有沒有照印出來的級別送審；只升不降（工具不記前幾輪）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, riskTableOf, classifyRisk } = require('../tools/risk-tier.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const RISK = {
  families: [{ pattern: '^lib/', tier: '高' }, { pattern: '^public/', tier: '中' }, { pattern: '^docs/', tier: '低' }],
  raise: ['改到「金額」的做法'],
};
const TIERS = {
  高: { full: '每一輪', diffOnly: '不適用', afterPassFix: '全審', scan: '掃' },
  中: { full: '第 1〜7 輪', diffOnly: '第 8 輪起', afterPassFix: '只核差異', scan: '掃' },
  低: { full: '第 1〜3 輪', diffOnly: '第 4 輪起', afterPassFix: '只核差異', scan: '不掃' },
};
const settings = { risk: RISK, reviewTiers: TIERS };
/** 假平台：change 回自報總數，changedFiles 回清單。 */
const fake = (files, count = String(files.length)) => ({ ask: (op) => (op === 'change' ? { changedFileCount: count } : files) });
const f = (p, extra = {}) => ({ path: p, status: 'modified', previousPath: null, ...extra });

test('①取最重的那一級、各級命中的路徑都列出；④印出那一級在複審與掃描分級表上的那一列', () => {
  const r = run('7', { settings, platform: fake([f('docs/a.md'), f('public/x.js')]) });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.result.level, '中');
  assert.match(r.lines[0], /^風險分級｜變更 7：中（依檔案先算；動到 2 個路徑）（清單 2 筆與平台自報總數相符）$/u, '第一行要印出級別與對帳結果');
  const out = r.lines.join('\n');
  assert.match(out, /・中：public\/x\.js/u);
  assert.match(out, /・低：docs\/a\.md/u);
  assert.match(out, /照複審與掃描分級表（中）：全審 第 1〜7 輪；只核差異 第 8 輪起；通過後照 F6 回頭改的那一輪 只核差異；掃描 掃/u);
  assert.equal(run('7', { settings, platform: fake([f('docs/a.md')]) }).result.level, '低', '只命中最輕的就是最輕的');
  const noRow = run('7', { settings: { risk: RISK }, platform: fake([f('docs/a.md')]) });
  assert.equal(noRow.code, 0);
  assert.match(noRow.lines.join('\n'), /分級表沒有「低」那一列/u);
});

test('②沒列在風險表上的路徑一律算高並列出來；③改名前的舊路徑也算', () => {
  const r = run('7', { settings, platform: fake([f('docs/a.md'), f('weird/new.js')]) });
  assert.equal(r.result.level, '高');
  assert.match(r.lines[0], /^風險分級｜變更 7：高（/u);
  assert.deepEqual(r.result.unknown, ['weird/new.js']);
  assert.match(r.lines.join('\n'), /一律算高.*weird\/new\.js/u);
  assert.ok(!r.lines.some((l) => l.startsWith('  ・高：')), '沒列在表上的路徑不可以印成「高」那一族命中的');
  const noCount = run('7', { settings, platform: fake([f('docs/a.md')], null) });
  assert.match(noCount.lines[0], /（平台沒自報總數，清單完整性沒對帳）$/u, '沒自報總數要照實說');
  const renamed = run('7', { settings, platform: fake([f('docs/new.md', { status: 'renamed', previousPath: 'lib/old.js' })]) });
  assert.equal(renamed.result.level, '高', '舊路徑在 lib/ 底下');
});

test('⑤升級條件照設定印出來；沒填要說', () => {
  assert.match(run('7', { settings, platform: fake([f('docs/a.md')]) }).lines.join('\n'), /內容碰到任一條升級條件，整支就算高（改到「金額」的做法）/u);
  for (const raise of [undefined, [], ['未設定']]) {
    const r = run('7', { settings: { risk: { ...RISK, raise }, reviewTiers: TIERS }, platform: fake([f('docs/a.md')]) });
    assert.match(r.lines.join('\n'), /沒填升級條件/u, JSON.stringify(raise));
  }
});

test('⑥風險表有一筆壞就整張不算＝退 2（不濾掉）', () => {
  assert.ok(riskTableOf(settings), '對照組：好的表讀得出來');
  const broken = (families) => ({ risk: { ...RISK, families: [...RISK.families, ...families] }, reviewTiers: TIERS });
  const cases = [
    ['整張沒填', { reviewTiers: TIERS }],
    ['家族是空的', { risk: { families: [] } }],
    ['空白範本的樣子（未設定）', { risk: { families: [{ pattern: '未設定', tier: '未設定' }] } }],
    ['樣式沒以 ^ 開頭', broken([{ pattern: 'lib/', tier: '高' }])],
    ['樣式不是合法正規式', broken([{ pattern: '^(', tier: '高' }])],
    ['級別不在三種裡', broken([{ pattern: '^x/', tier: '極高' }])],
    ['少了樣式', broken([{ tier: '低' }])],
  ];
  for (const [why, s] of cases) {
    assert.equal(riskTableOf(s), null, why);
    assert.equal(run('7', { settings: s, platform: fake([f('lib/a.js')]) }).code, 2, `${why}：退 2`);
  }
});

test('⑦平台問不到、沒有路徑、沒給編號＝退 2；程式錯誤不吞；空白設定的複本裡跑指令入口＝退 2', () => {
  assert.equal(run('7', { settings, platform: { ask() { throw new PlatformError('x'); } } }).code, 2);
  assert.match(run('7', { settings, platform: { ask() { throw new PlatformError('x'); } } }).lines[0], /^風險分級：問不到平台/u);
  assert.equal(run('7', { settings, platform: fake([]) }).code, 2, '沒有路徑不猜');
  assert.equal(run('7', { settings, platform: fake([f('docs/a.md')], '5') }).code, 2, '清單不完整');
  assert.equal(run(undefined, { settings, platform: fake([f('docs/a.md')]) }).code, 2);
  assert.throws(() => run('7', { settings, platform: { ask() { throw new TypeError('程式寫錯'); } } }), TypeError);
  const copy = runInCopy('tools/risk-tier.js', ['7']);
  assert.equal(copy.status, 2, copy.stdout + copy.stderr);
  assert.match(copy.stdout, /風險表沒填好/u);
});

test('⑨一個檔對上幾個家族取最重的、跟表的順序無關', () => {
  const lowFirst = [{ pattern: '^docs/', tier: '低' }, { pattern: '^docs/contracts/', tier: '高' }];
  const highFirst = [lowFirst[1], lowFirst[0]];
  for (const families of [lowFirst, highFirst]) {
    const s = { risk: { families, raise: ['條件'] }, reviewTiers: TIERS };
    const r = run('7', { settings: s, platform: fake([f('docs/contracts/a.md')]) });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.equal(r.result.level, '高', `順序 ${families.map((x) => x.tier).join('→')}：表上寫明是高的檔要算高`);
    assert.match(r.lines.join('\n'), /照複審與掃描分級表（高）：全審 每一輪/u);
    assert.equal(run('7', { settings: s, platform: fake([f('docs/a.md')]) }).result.level, '低', '只對上低的就是低');
  }
  // 純判斷層：中、低重疊取中；沒對上的算高
  const t = riskTableOf({ risk: { families: [{ pattern: '^src/', tier: '低' }, { pattern: '^src/ui/', tier: '中' }] } });
  assert.deepEqual(classifyRisk(['src/ui/x.js'], t).hits.map((h) => h.tier), ['中']);
  assert.equal(classifyRisk(['other/y.js'], t).level, '高');
});
