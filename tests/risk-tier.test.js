// 守合併前風險分級（規矩 D4）：依檔案先算高／中／低，只算不擋。
//
// 守得到的：①取最重的那一級、各級命中的路徑都列出；②沒列在風險表上的路徑一律算高並列出來（D4：判不出＝高）；
//   ③改名前的舊路徑也算（跟驗收分級共用 changedPaths）；④印出那一級在複審與掃描分級表上的那一列、沒有那一列要說；
//   ⑤升級條件照設定印出來，沒填要說；⑥風險表有一筆壞（樣式沒以 ^ 開頭、不是合法正規式、級別不在三種裡）就整張不算＝退 2；
//   ⑦平台問不到、沒有路徑、沒給編號＝退 2；空白設定的複本裡跑指令入口＝退 2。
//   ⑧第一行印出級別與清單有沒有跟平台自報總數對帳；
//   ⑨一個檔對上幾個家族取最重的、跟表的順序無關（#32 r2：取第一個對上的話，^docs/ 低排在 ^docs/contracts/ 高前面就把高算成低）。
//   ⑬快速通道（AI）（F12）：清單上的檔整檔都收、只改 // 開頭整行註解的收（CRLF 檔也一樣）；區塊註解一律不收（#96 掃描後收窄）；
//     用 /*、*/ 把程式包成註解、改程式、* 開頭的程式續行、帶 @ 的型別註解、空行、新增或刪掉的檔、只改權限、一律不收清單上的檔、
//     符號連結（指向路徑以 // 開頭也一樣）、本機找不到版本、清單沒登記或壞了——都判不走並印出原因；一個路徑不收整支就不走；結果帶回送審產生器；讀 git 前清掉 GIT_ 那一族（E4）；
//     問平台主幹那一顆時，分支名照平台回的這支 PR 的基底分支傳（假平台的基底刻意不叫 main、問別的名字就問不到；#96 r5 R6）。
// ⚠️ 守不到的：內容碰不碰到升級條件（要讀內容）；表本身分得對不對；有沒有照印出來的級別送審；只升不降（工具不記前幾輪）；
//    「只改註解」的盲點（多行字串或範本字串裡長得像 // 註解的一行）——寫在工具檔頭與機器表，這裡不假裝守得到；
//    快速通道假平台的基底分支名只有一個：工具若把那個名字寫死、不讀平台回的基底欄位，分不出來（#101 掃描 1-2）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');
const { run, riskTableOf, classifyRisk, fastLaneTableOf, changedLinesOf, gitIn, RULES_SHOWN } = require('../tools/risk-tier.js');
const { excerpt, read: readRules } = require('../tools/build-rules.js');
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

test('⑨算的是哪一個版本照實回（送審產生器拿去跟受審版本對；理財 #672 r3）；讀清單期間換版＝退 2', () => {
  const heads = (seq) => { let n = 0; return { ask: (op) => (op === 'change' ? { changedFileCount: '1', headSha: seq[Math.min(n++, seq.length - 1)] } : [{ path: 'docs/a.md', status: 'modified', previousPath: null }]) }; };
  const s = { risk: { families: [{ pattern: '^docs/', tier: '低' }], raise: [] }, reviewTiers: {} };
  const ok = run('7', { settings: s, platform: heads(['d'.repeat(40)]) });
  assert.equal(ok.code, 0, ok.lines.join('\n'));
  assert.equal(ok.result.head, 'd'.repeat(40));
  const moved = run('7', { settings: s, platform: heads(['d'.repeat(40), 'e'.repeat(40)]) });
  assert.equal(moved.code, 2);
  assert.match(moved.lines.join('\n'), /換了版本/u);
});

test('⑫指令列在輸出後面印 D4、F2、G1、F12 原文（送審前要用的幾條）；只多印、退出碼不變', () => {
  assert.deepEqual(RULES_SHOWN, ['D4', 'F2', 'G1', 'F12']);
  const copy = runInCopy('tools/risk-tier.js', ['7'], { files: ['rules.json'] });
  assert.equal(copy.status, 2, copy.stdout + copy.stderr);
  assert.match(copy.stdout, /^專案設定裡的風險表沒填好/u, '工具自己的輸出照舊在前面');
  assert.ok(copy.stdout.includes(`\n${excerpt(readRules(), RULES_SHOWN)}\n`), `沒印出 D4、F2、G1、F12 原文：\n${copy.stdout}`);
});

// ⑬ 快速通道（AI）：真的 git 倉庫裡，主幹一顆、受審版本一顆
const BASE_JS = `'use strict';
// 為什麼：第一行說明
/**
 * 區塊說明第一行
 * 區塊說明第二行
 */
function f(a) {
  return a
    * 2;
}
/* 整行區塊 */
module.exports = { f };
`;
// 字串裡有 /*、下面接一行 * 開頭的程式續行：#96 掃描前的區塊判法會被字串裡的 /* 誤判，所以留著這個反例；現在擋下它的是那一行不是 // 開頭（#96 掃描後收窄）。
// 守不到：判法若改回往上找區塊開頭、不收時又印同一句理由，這題照樣綠（斷言只比「不是判得出的整行註解」，沒比是被哪一條擋下）。
const FAKE_OPEN_JS = "'use strict';\nconst mark = '/*';\nconst y = 1\n  * 2;\nmodule.exports = { y, mark };\n";
// 行尾是 CRLF 的檔：每一行最後那一個 CR 是正常的行尾，不是夾在行中的換行字元
const CRLF_JS = "'use strict';\r\n// 說明\r\nmodule.exports = 1;\r\n";
const LANE = { files: ['^BACKLOG\\.md$', '^cases/'], commentOnly: ['^tools/.+\\.js$'], never: ['^tools/forbidden'] };
function laneRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-lane-'));
  const sh = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return r.stdout.trim();
  };
  sh('init', '-q', '-b', 'main');
  sh('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.mkdirSync(path.join(dir, 'cases'));
  fs.writeFileSync(path.join(dir, 'tools', 'crlf.js'), CRLF_JS);
  fs.writeFileSync(path.join(dir, 'tools', 'x.js'), BASE_JS);
  fs.writeFileSync(path.join(dir, 'tools', 'forbidden-tools.js'), BASE_JS);
  fs.writeFileSync(path.join(dir, 'tools', 'z.js'), FAKE_OPEN_JS);
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '- 一條\n');
  sh('add', '-A'); sh('commit', '-q', '-m', 'base');
  const base = sh('rev-parse', 'HEAD');
  /** 從主幹開一顆受審版本：edit(dir) 改磁碟上的檔，回受審版本碼。 */
  const head = (edit) => {
    sh('checkout', '-q', '--detach', base);
    edit(dir);
    sh('add', '-A'); sh('commit', '-q', '--allow-empty', '-m', 'head');
    return sh('rev-parse', 'HEAD');
  };
  return { dir, base, head, sh };
}
const editJs = (fn, file = 'x.js') => (dir) => fs.writeFileSync(path.join(dir, 'tools', file), fn(BASE_JS));
// 基底分支刻意不叫 main（專案設定的主幹名）：傳錯名字、傳空的，或拿設定的主幹名去問，都問不到主幹那一顆（#96 r5 R6）
const LANE_BASE_BRANCH = 'trunk';
/** 假平台：change 帶受審版本與基底分支，branchSha 只認那個基底分支名、回主幹那一顆。 */
const lanePlatform = (paths, head, base) => ({
  ask: (op, args) => {
    if (op === 'change') return { changedFileCount: String(paths.length), headSha: head, baseBranch: LANE_BASE_BRANCH };
    if (op === 'changedFiles') return paths.map((p) => f(p));
    if (op === 'branchSha') {
      if (!args || args.branch !== LANE_BASE_BRANCH) throw new PlatformError(`假平台只有基底分支 ${LANE_BASE_BRANCH}，問的是 ${args && args.branch}`);
      return { sha: base };
    }
    throw new PlatformError(`測試沒給 ${op}`);
  },
});
function lane(repo, paths, head, laneSettings = LANE) {
  const r = run('7', { settings: { ...settings, risk: { families: [{ pattern: '^tools/', tier: '高' }, { pattern: '^(BACKLOG\\.md|cases/)', tier: '低' }], raise: [] }, fastLane: { ai: laneSettings } }, platform: lanePlatform(paths, head, repo.base), git: gitIn(repo.dir) });
  assert.equal(r.code, 0, r.lines.join('\n'));
  const line = r.lines.find((l) => l.startsWith('  快速通道（AI）：'));
  assert.ok(line, `要印快速通道（AI）那一行：\n${r.lines.join('\n')}`);
  return { r, line };
}

test('⑬快速通道（AI）：清單上的檔、只改 // 整行註解的收；結果帶回送審產生器', () => {
  const repo = laneRepo();
  try {
    const docs = repo.head((dir) => { fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '- 改過\n'); fs.writeFileSync(path.join(dir, 'cases', 'a.md'), '# 新案例\n'); });
    let got = lane(repo, ['BACKLOG.md', 'cases/a.md'], docs);
    assert.equal(got.r.result.fastLaneAI, true);
    assert.match(got.line, /^ {2}快速通道（AI）：可以（清單上的檔 BACKLOG\.md、cases\/a\.md）/u);
    for (const [what, fn] of [
      ['改 // 註解', (t) => t.replace('第一行說明', '改過的說明')],
      ['加一行 // 註解', (t) => t.replace("'use strict';\n", "'use strict';\n// 新加的\n")],
    ]) {
      got = lane(repo, ['tools/x.js'], repo.head(editJs(fn)));
      assert.equal(got.r.result.fastLaneAI, true, `${what}：${got.line}`);
      assert.match(got.line, /只改註解的 tools\/x\.js/u, what);
    }
    // 行尾是 CRLF 的檔照樣判得出只改註解（行尾那一個 CR 不算夾在行中）
    got = lane(repo, ['tools/crlf.js'], repo.head((dir) => fs.writeFileSync(path.join(dir, 'tools', 'crlf.js'), CRLF_JS.replace('// 說明', '// 改過的說明'))));
    assert.equal(got.r.result.fastLaneAI, true, `CRLF 檔只改註解：${got.line}`);
  } finally { fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('⑬快速通道（AI）：改到程式或判不準的一律不走，並印出是哪一行', () => {
  const repo = laneRepo();
  try {
    for (const [what, fn, want] of [
      ['用 /* 與 */ 把一段程式包成註解', (t) => t.replace('function f(a) {', '/*\nfunction f(a) {').replace('    * 2;\n}\n', '    * 2;\n}\n*/\n'), /新版第 7 行不是判得出的整行註解/u],
      ['改程式', (t) => t.replace('return a', 'return a + 1'), /舊版第 8 行/u],
      ['* 開頭的程式續行', (t) => t.replace('    * 2;', '    * 3;'), /舊版第 9 行/u],
      ['帶 @ 的型別註解', (t) => t.replace('// 為什麼：第一行說明', '// @type {number}'), /新版第 2 行/u],
      ['工具指示註解', (t) => t.replace('// 為什麼：第一行說明', '// eslint-disable-next-line'), /新版第 2 行/u],
      ['加空行', (t) => t.replace('module.exports', '\nmodule.exports'), /新版第 12 行/u],
      ['// 註解裡寫了 */', (t) => t.replace('第一行說明', '說明 */ 這樣'), /新版第 2 行/u],
      ['// 註解行裡夾一個 CR，後面接程式', (t) => t.replace('// 為什麼：第一行說明', '// 為什麼：第一行說明\rglobalThis.probe = 2;'), /新版第 2 行/u],
      ['// 註解行裡夾一個 U+2028，後面接程式', (t) => t.replace('// 為什麼：第一行說明', '// 為什麼：第一行說明\u2028globalThis.probe = 2;'), /新版第 2 行/u],
      ['// 註解行裡夾一個 U+2029，後面接程式', (t) => t.replace('// 為什麼：第一行說明', '// 為什麼：第一行說明\u2029globalThis.probe = 2;'), /新版第 2 行/u],
      ['改區塊裡的 * 行（區塊註解一律不收）', (t) => t.replace('區塊說明第二行', '改過'), /舊版第 5 行/u],
      ['改整行一段 /* … */（區塊註解一律不收）', (t) => t.replace('/* 整行區塊 */', '/* 改過的整行區塊 */'), /舊版第 11 行/u],
      ['刪一行區塊裡的 * 行（區塊註解一律不收）', (t) => t.replace(' * 區塊說明第二行\n', ''), /舊版第 5 行/u],
      ['把整行區塊改成 /*/（JavaScript 讀成一段沒收尾的區塊開頭；#96 掃描 1-1）', (t) => t.replace('/* 整行區塊 */', '/*/'), /舊版第 11 行/u],
      ['區塊裡加一整行 /* … */（會提早關掉外面的區塊）', (t) => t.replace(' * 區塊說明第二行\n', ' * 區塊說明第二行\n /* 裡面 */\n'), /新版第 6 行/u],
    ]) {
      const got = lane(repo, ['tools/x.js'], repo.head(editJs(fn)));
      assert.equal(got.r.result.fastLaneAI, false, `${what} 不能走`);
      assert.match(got.line, /^ {2}快速通道（AI）：不走——tools\/x\.js：/u, what);
      assert.match(got.line, want, `${what}：${got.line}`);
    }
    // 字串裡的 /* 後面接 * 開頭的程式續行：那一行不是 // 開頭，照樣不收
    const fake = repo.head((dir) => fs.writeFileSync(path.join(dir, 'tools', 'z.js'), FAKE_OPEN_JS.replace('  * 2;', '  * 3;')));
    assert.match(lane(repo, ['tools/z.js'], fake).line, /tools\/z\.js：舊版第 4 行不是判得出的整行註解/u);
    // 一個路徑不收，整支就不走（另一個是清單上的檔也一樣）
    const mixed = repo.head((dir) => { fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '- 改過\n'); fs.writeFileSync(path.join(dir, 'tools', 'x.js'), BASE_JS.replace('return a', 'return a + 1')); });
    assert.equal(lane(repo, ['BACKLOG.md', 'tools/x.js'], mixed).r.result.fastLaneAI, false);
    // 一律不收的清單先比：只改註解也不收
    const guard = repo.head(editJs((t) => t.replace('第一行說明', '改過'), 'forbidden-tools.js'));
    assert.match(lane(repo, ['tools/forbidden-tools.js'], guard).line, /tools\/forbidden-tools\.js 在一律不收的清單上/u);
    // 新增的檔、不在清單上的檔
    const added = repo.head((dir) => fs.writeFileSync(path.join(dir, 'tools', 'new.js'), '// 只有註解\n'));
    assert.match(lane(repo, ['tools/new.js'], added).line, /tools\/new\.js：不是兩版都同樣是一般檔案/u);
    assert.match(lane(repo, ['README.md'], added).line, /README\.md 不在清單上/u);
    // 符號連結改指向另一支程式：連結的內容是它指去哪裡，用 // 開頭的絕對路徑寫，逐行看像註解（Codex #96 r3 R5）
    fs.writeFileSync(path.join(repo.dir, 'a-target.js'), 'module.exports = 11;\n');
    fs.writeFileSync(path.join(repo.dir, 'b-target.js'), 'module.exports = 29;\n');
    repo.sh('checkout', '-q', '--detach', repo.base);
    fs.symlinkSync(`/${path.join(repo.dir, 'a-target.js')}`, path.join(repo.dir, 'tools', 'link.js'));
    repo.sh('add', '-A'); repo.sh('commit', '-q', '-m', 'link base');
    const linkBase = repo.sh('rev-parse', 'HEAD');
    fs.unlinkSync(path.join(repo.dir, 'tools', 'link.js'));
    fs.symlinkSync(`/${path.join(repo.dir, 'b-target.js')}`, path.join(repo.dir, 'tools', 'link.js'));
    repo.sh('add', '-A'); repo.sh('commit', '-q', '-m', 'link head');
    const linkHead = repo.sh('rev-parse', 'HEAD');
    assert.match(repo.sh('ls-tree', linkHead, '--', 'tools/link.js'), /^120000 /u, '前提：受審版本裡它是符號連結');
    const linkLane = run('7', { settings: { ...settings, fastLane: { ai: LANE } }, platform: lanePlatform(['tools/link.js'], linkHead, linkBase), git: gitIn(repo.dir) });
    assert.equal(linkLane.result.fastLaneAI, false, linkLane.lines.join('\n'));
    assert.match(linkLane.lines.join('\n'), /tools\/link\.js：不是兩版都同樣是一般檔案/u);
    // 只改權限：一行都沒改
    const mode = repo.head((dir) => fs.chmodSync(path.join(dir, 'tools', 'x.js'), 0o755));
    assert.match(lane(repo, ['tools/x.js'], mode).line, /tools\/x\.js：不是兩版都同樣是一般檔案/u);
    // 內容變成二進位（夾了 NUL）：git 不給逐行的改動，標頭寫 Binary files
    const binary = repo.head(editJs((t) => t.replace('// 為什麼：第一行說明', '// 為什麼：第一行說明\u0000')));
    assert.match(lane(repo, ['tools/x.js'], binary).line, /tools\/x\.js：改的不只是內容/u);
  } finally { fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('⑬快速通道（AI）：清單沒登記或是「未設定」＝不走；清單壞了＝不走並說出來；本機沒有版本＝判不出', () => {
  const repo = laneRepo();
  try {
    const head = repo.head(editJs((t) => t.replace('第一行說明', '改過')));
    const none = run('7', { settings, platform: lanePlatform(['tools/x.js'], head, repo.base), git: gitIn(repo.dir) });
    assert.ok(none.lines.includes('  快速通道（AI）：專案設定沒登記清單（fastLane.ai），不走（F12）。'), none.lines.join('\n'));
    assert.equal(none.result.fastLaneAI, false);
    assert.match(lane(repo, ['tools/x.js'], head, { files: ['未設定'], commentOnly: ['未設定'], never: ['未設定'] }).line, /專案設定沒登記/u);
    assert.match(lane(repo, ['tools/x.js'], head, { ...LANE, never: ['tools/'] }).line, /fastLane\.ai 壞了：fastLane\.ai\.never 有一筆樣式沒以 \^ 開頭/u);
    assert.match(lane(repo, ['tools/x.js'], head, { ...LANE, never: '^tools/' }).line, /fastLane\.ai\.never 不是陣列/u);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-lane-empty-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: empty, env: gitEnv() });
      const r = run('7', { settings: { ...settings, fastLane: { ai: LANE } }, platform: lanePlatform(['tools/x.js'], head, repo.base), git: gitIn(empty) });
      assert.match(r.lines.join('\n'), /本機找不到主幹與受審版本的共同祖先（先 git fetch），判不出/u);
      assert.equal(r.result.fastLaneAI, false);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
    // 清單上沒有要只改註解的檔，就不去問平台主幹那一顆（沒登記 branchSha 的專案照樣算得出級別）
    const docsOnly = { ask: (op) => (op === 'change' ? { changedFileCount: '1', headSha: head, baseBranch: 'main' } : op === 'changedFiles' ? [f('BACKLOG.md')] : (() => { throw new PlatformError('不該問'); })()) };
    assert.equal(run('7', { settings: { ...settings, fastLane: { ai: LANE } }, platform: docsOnly, git: gitIn(repo.dir) }).code, 0);
  } finally { fs.rmSync(repo.dir, { recursive: true, force: true }); }
});

test('⑬快速通道（AI）讀 git 前先清掉 GIT_ 那一族（E4）：GIT_DIR 指到另一個倉庫，照樣讀這一個倉庫', () => {
  const repo = laneRepo();
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-lane-decoy-'));
  const saved = process.env.GIT_DIR;
  try {
    spawnSync('git', ['init', '-q'], { cwd: decoy, env: gitEnv() });
    const head = repo.head(editJs((t) => t.replace('第一行說明', '改過')));
    process.env.GIT_DIR = path.join(decoy, '.git');
    const got = lane(repo, ['tools/x.js'], head);
    assert.equal(got.r.result.fastLaneAI, true, `GIT_DIR 指到別處時讀錯了倉庫：${got.line}`);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    fs.rmSync(decoy, { recursive: true, force: true }); fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('⑬讀 git diff -U0：區塊的行號、沒有換行結尾的標記；標頭有權限或新增字樣、一個區塊都沒有＝讀不出', () => {
  const diff = ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', '@@ -2 +2 @@', '-舊', '+新', '@@ -5,0 +6,2 @@', '+加一', '+加二', '@@ -9,2 +11 @@ f', '-刪一', '-刪二', '+換', '\\ No newline at end of file', ''].join('\n');
  assert.deepEqual(changedLinesOf(diff), { removed: [1, 8, 9], added: [1, 5, 6, 10] });
  assert.match(changedLinesOf('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n').error, /權限/u);
  assert.match(changedLinesOf('diff --git a/x b/x\nindex 1..2\n').error, /沒有改到任何一行/u);
  assert.match(changedLinesOf('@@ -1 +1 @@\n-舊\n').error, /讀不懂/u, '區塊說有一行加上、卻沒有');
  assert.equal(fastLaneTableOf({}), null);
});
