// 守開工印待辦（規矩 F6 的「放在哪裡」）：列出待辦清單裡提到這一支改到的檔的那幾條；只列不擋。
//
// 守得到的：
//   ①待辦那一節怎麼切：從那一節的標題到下一個同級或更高的標題（兩種都單獨驗；標題前 0〜3 個空白也算標題、4 個就不是）；每個第一層「- 」一條，縮排的續行算同一條；行號從 1 起；找不到那一節＝null；
//   ②「提到」：整個路徑、或它的上層資料夾寫成帶結尾斜線的樣子；前後接路徑字元的不算（settings.json 不命中 unfilled-settings.json、
//     tools/x.js 不命中 tools/x.json、tools/ 不命中 mytools/、tools/.cache/…、tools/@scope/… 這類更深的路徑不算提到整個 tools/）；
//     寫在反引號或引號裡照算；
//   ③真的倉庫裡跑：這一支跟基準的三點差異、已暫存與沒暫存的改動、沒追蹤的檔都算改到（四個來源的檔名有引號、反斜線都照原名；
//     改了又暫存、再把工作檔改回去的照算）；這支自己剛寫進待辦的也照列、待辦檔是這支新建的也照列（擁有者 2026-10-07 裁 a：不去版本控制找舊版比）；
//     待辦檔只從磁碟讀：設定寫 ./BACKLOG.md 一樣，檔名冒號開頭、指到倉庫內的捷徑檔、大小寫別名（磁碟不分大小寫時）都照讀——
//     這幾種曾是四輪複審抓到的反例；寫到倉庫外＝退 2；基準之後主幹自己動的檔不算這一支改到的；沒有命中也退 0；
//   ④設定沒填、待辦檔讀不到、那一節找不到、基準找不到、主幹沒填又沒給 --base、參數不對＝退 2；列改到的檔那幾步 git 出錯＝退 2、不當成沒改到；
//   ⑤git 那一族環境變數指向別的倉庫，照樣看這一個（E4）；⑥空白設定的複本裡跑指令入口＝退 2。
// ⚠️ 守不到的：只寫檔名、或用說法（「說明書的換頁程式」）寫的待辦配不到；列出來之後有沒有人看、條件是不是真的到了。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');
const { run, itemsOf, match, mentions } = require('../tools/backlog-touch.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const SETTINGS = { mainBranch: 'main', backlog: { file: 'BACKLOG.md', section: '## 待辦' } };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-touch-'));
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (files) => {
    for (const [p, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), text);
    }
  };
  g('init', '-q', '-b', 'main');
  g('config', 'maintenance.auto', 'false');
  return { dir, g, write, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const BACKLOG = [
  '# 待辦',
  '',
  '## 待辦',
  '',
  '- 2026-10-01（甲）settings.json 那一格要改／`settings.json`／下一支動到它時。',
  '- 2026-10-01（乙）unfilled 那份要跟上／tests/helpers/unfilled-settings.json／下一支動到它時。',
  '- 2026-10-01（丙）整個工具資料夾的註解／tools/／整理時。',
  '  續行提到 docs/guide.md 也算同一條。',
  '- 2026-10-01（丁）只寫說法：說明書的換頁程式／那一支／有人抱怨時。',
  '',
  '### 這一節裡的小標',
  '',
  '- 2026-10-01（戊）小標底下還是待辦那一節／lib/a.js／下一支動到它時。',
  '',
  '## 排定',
  '',
  '- 排定那一節提到 lib/a.js 不算待辦。',
  '',
].join('\n');

test('①待辦那一節：標題到下一個同級標題；第一層「- 」一條、縮排續行算同一條；行號從 1 起；找不到＝null', () => {
  const items = itemsOf(BACKLOG, '## 待辦');
  assert.equal(items.length, 5);
  assert.equal(items[0].line, 5);
  assert.match(items[2].text, /續行提到 docs\/guide\.md/u, '續行算同一條');
  assert.ok(items.some((i) => i.text.includes('（戊）')), '更低一級的小標不會切斷那一節');
  assert.ok(!items.some((i) => i.text.includes('排定那一節')), '下一個同級標題之後不算');
  assert.equal(itemsOf(BACKLOG, '## 沒有這一節'), null);
  // 更高一層的標題也要停（#50 r3 R2：原本的樣本只有同級停、較低層不停）
  const higher = itemsOf('## 待辦\n\n- 甲／a.js／之後。\n\n# 另一份文件\n\n- 乙／b.js／之後。\n', '## 待辦');
  assert.deepEqual(higher.map((i) => i.text.slice(0, 1)), ['甲'], '更高一層的標題之後不算');
  // 標題前 0〜3 個空白仍是標題（#50 r5 R1：原本只認欄首的 #，「 ## 做完的」被接成續行、做完的那幾條全算進待辦）
  for (const pad of [' ', '  ', '   ']) {
    const same = itemsOf(`## 待辦\n\n- 甲／a.js／之後。\n\n${pad}## 做完的\n\n- 乙／a.js／已完成。\n`, '## 待辦');
    assert.deepEqual(same.map((i) => i.text.slice(0, 1)), ['甲'], `${pad.length} 個空白的同級標題也要結束那一節`);
    const up = itemsOf(`## 待辦\n\n- 甲／a.js／之後。\n\n${pad}# 另一份\n\n- 乙／a.js／之後。\n`, '## 待辦');
    assert.deepEqual(up.map((i) => i.text.slice(0, 1)), ['甲'], `${pad.length} 個空白的更高層標題也要結束那一節`);
  }
  const four = itemsOf('## 待辦\n\n- 甲／a.js／之後。\n    ## 這是續行不是標題\n- 乙／b.js／之後。\n', '## 待辦');
  assert.deepEqual(four.map((i) => i.text.slice(0, 1)), ['甲', '乙'], '4 個空白就不是標題（Markdown 當程式碼／續行）');
  assert.match(four[0].text, /這是續行不是標題/u);
  assert.deepEqual(itemsOf('## 待辦\n', '## 待辦'), []);
});

test('②「提到」：整個路徑或帶結尾斜線的上層資料夾；前後接路徑字元的不算；反引號裡照算', () => {
  assert.equal(mentions('改 `settings.json` 那一格', 'settings.json'), true, '反引號裡照算');
  assert.equal(mentions('tests/helpers/unfilled-settings.json', 'settings.json'), false, '是別的檔名的尾巴');
  assert.equal(mentions('tools/x.json', 'tools/x.js'), false, '後面還接路徑字元');
  assert.equal(mentions('看 mytools/ 那裡', 'tools/'), false, '前面還接路徑字元');
  assert.equal(mentions('整個 tools/ 資料夾', 'tools/'), true);
  assert.equal(mentions('tools/gates/ 底下', 'tools/'), false, '更深一層的資料夾不算提到上層（tools/ 根上的檔不在 tools/gates/ 底下）');
  assert.equal(mentions('tools/gates/ 底下', 'tools/gates/'), true);
  assert.equal(mentions('只改 tools/.cache/config.json 那份', 'tools/'), false, '隱藏子目錄底下的完整路徑不算提到整個 tools/（#50 r1 R4）');
  assert.deepEqual(match(itemsOf('## 待辦\n- 只改 tools/.cache/config.json 那份。\n', '## 待辦'), ['tools/a.js']), []);
  // 同一族一次處理：半形可見字元（扣掉反引號與兩種引號）都算路徑字元（#50 r2 R3）
  for (const deeper of ['tools/@scope/config.js', 'tools/[name]/config.js', 'tools/+internal/config.js', 'tools/~old/x.js']) {
    assert.equal(mentions(`只改 ${deeper} 那份`, 'tools/'), false, `${deeper} 不算提到整個 tools/`);
  }
  // 兩種引號各自單獨驗（#50 r3 R2：放在同一句只證明得了其中一種）
  assert.equal(mentions('寫成 "tools/" 也算', 'tools/'), true, '雙引號框起來的照算');
  assert.equal(mentions("寫成 'tools/' 也算", 'tools/'), true, '單引號框起來的照算');
  assert.equal(mentions('寫成 `tools/` 也算', 'tools/'), true, '反引號框起來的照算');
  const items = itemsOf(BACKLOG, '## 待辦');
  const got = match(items, ['settings.json', 'tools/review-launch.js', 'docs/guide.md', 'lib/a.js']);
  const by = Object.fromEntries(got.map((h) => [h.text.slice(10, 13), h.hit]));
  assert.deepEqual(by['（甲）'], ['settings.json']);
  assert.equal(by['（乙）'], undefined, 'settings.json 不命中 unfilled-settings.json');
  assert.deepEqual(by['（丙）'], ['tools/review-launch.js', 'docs/guide.md'], '上層資料夾與續行都算');
  assert.equal(by['（丁）'], undefined, '只寫說法的配不到（守不到）');
  assert.deepEqual(by['（戊）'], ['lib/a.js']);
});

test('③真的倉庫裡跑：三點差異＋沒提交＋沒追蹤都算；這支自己剛加或改寫的也照列；主幹自己動的不算；沒命中也退 0', () => {
  const r = repo();
  try {
    r.write({ 'BACKLOG.md': BACKLOG, 'settings.json': '{}\n', 'lib/a.js': 'a\n', 'docs/guide.md': 'g\n', 'tests/helpers/unfilled-settings.json': '{}\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base');
    r.g('branch', 'origin-main');
    r.g('switch', '-q', '-c', 'topic');
    r.write({ 'settings.json': '{"a":1}\n' });
    // 這支自己新加一條提到 settings.json 的待辦、改寫（戊）：都照列（裁 a）
    r.write({ 'BACKLOG.md': BACKLOG.replace('- 2026-10-01（丁）', '- 2026-10-07（新）這支自己記的／settings.json／之後。\n- 2026-10-01（丁）').replace('（戊）小標底下還是待辦那一節／lib/a.js', '（戊）改寫過、改提到／settings.json') });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'topic');
    r.write({ 'docs/guide.md': '還沒提交\n', 'tools/new.js': '沒追蹤\n' });
    let res = run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'origin-main'] });
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.deepEqual(res.changed, ['BACKLOG.md', 'docs/guide.md', 'settings.json', 'tools/new.js']);
    const text = res.lines.join('\n');
    assert.match(text, /第 5 行（settings\.json）：2026-10-01（甲）/u);
    assert.match(text, /第 7 行（tools\/new\.js、docs\/guide\.md）|第 7 行（docs\/guide\.md、tools\/new\.js）/u, '沒提交、沒追蹤的也算');
    assert.match(text, /（新）這支自己記的/u, '這支自己剛加的也照列（裁 a）');
    assert.match(text, /（戊）改寫過、改提到/u, '這支改寫過的也照列');
    assert.match(text, /提到這些檔的 4 條/u, '甲、丙、新、戊');
    assert.doesNotMatch(text, /另有/u, '不再分「這支自己新加的」');
    assert.match(text, /只列不擋/u);
    // 主幹在基準之後自己動了 lib/a.js：不算這一支改到的
    r.g('switch', '-q', 'origin-main');
    r.write({ 'lib/a.js': 'main moved\n' });
    r.g('add', 'lib/a.js'); r.g('commit', '-q', '-m', 'main moved');   // 只提交這一個：還沒提交的那兩個留在工作資料夾
    r.g('switch', '-q', 'topic');
    res = run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'origin-main'] });
    assert.ok(!res.changed.includes('lib/a.js'), '三點差異：主幹自己動的不算');
    fs.rmSync(path.join(r.dir, 'tools'), { recursive: true });
    r.g('checkout', '-q', '--', 'docs/guide.md');
    const quiet = run({ settings: { ...SETTINGS, backlog: { file: 'BACKLOG.md', section: '## 排定' } }, cwd: r.dir, argv: ['--base', 'origin-main'] });
    assert.equal(quiet.code, 0);
    assert.match(quiet.lines[0], /提到這些檔的 0 條/u, '沒有命中也退 0');
  } finally { r.cleanup(); }
});

test('④設定沒填、待辦檔讀不到、那一節找不到、基準找不到、主幹沒填又沒給 --base、參數不對＝退 2', () => {
  const r = repo();
  try {
    r.write({ 'BACKLOG.md': BACKLOG });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base');
    // 每一種都核理由：別的檢查常常也會退 2，只看退出碼的話，拿掉其中一道還是綠的（突變驗過四發）
    const cases = [
      ['設定沒填', { mainBranch: 'main', backlog: { file: '未設定', section: '未設定' } }, ['--base', 'HEAD'], /backlog（待辦檔在哪、哪一節）還沒填/u],
      ['沒有 backlog 那一塊', { mainBranch: 'main' }, ['--base', 'HEAD'], /backlog（待辦檔在哪、哪一節）還沒填/u],
      ['待辦檔讀不到', { ...SETTINGS, backlog: { file: 'NOPE.md', section: '## 待辦' } }, ['--base', 'HEAD'], /讀不到待辦檔 NOPE\.md/u],
      ['那一節找不到', { ...SETTINGS, backlog: { file: 'BACKLOG.md', section: '## 沒有' } }, ['--base', 'HEAD'], /找不到「## 沒有」那一節/u],
      ['基準找不到', SETTINGS, ['--base', 'no-such-ref'], /基準版本 no-such-ref 找不到/u],
      ['主幹沒填又沒給 --base', { ...SETTINGS, mainBranch: '未設定' }, [], /主幹分支名沒填/u],
      ['預設基準不在（沒有 origin）', SETTINGS, [], /基準版本 origin\/main 找不到/u],
      ['--base 沒接值', SETTINGS, ['--base'], /不認得的參數：--base/u],
      ['不認得的參數', SETTINGS, ['--oops', '--base', 'HEAD'], /不認得的參數：--oops/u],
    ];
    for (const [what, settings, argv, why] of cases) {
      const res = run({ settings, cwd: r.dir, argv });
      assert.equal(res.code, 2, `${what}：${res.lines.join('\n')}`);
      assert.match(res.lines.join('\n'), why, `${what}：理由要說對`);
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-touch-out-'));
    try { assert.equal(run({ settings: SETTINGS, cwd: outside, argv: ['--base', 'HEAD'] }).code, 2, '不在倉庫裡'); } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { r.cleanup(); }
});

test('④列改到的檔那幾步 git 出錯＝退 2、說是哪一步，不當成「沒改到」（#50 r5 R2）', () => {
  const r = repo();
  try {
    r.write({ 'BACKLOG.md': BACKLOG, 'settings.json': '{}\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base');
    r.g('branch', 'origin-main');
    r.write({ 'settings.json': '{"a":1}\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'topic');
    assert.equal(run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'origin-main'] }).hits.length, 1, '對照組：好好的時候（甲）照列');
    // 弄壞這一支最新那一版的樹物件：找根目錄、核基準都還行，列改到的檔那一步 git 會退 128
    const tree = r.g('rev-parse', 'HEAD^{tree}');
    fs.rmSync(path.join(r.dir, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
    const res = run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'origin-main'] });
    assert.equal(res.code, 2, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /git diff .*退 128/u, '說是列改到的檔那一步出錯');
  } finally { r.cleanup(); }
});

test('⑤git 那一族環境變數指向別的倉庫，照樣看這一個（E4）', () => {
  const r = repo();
  const decoy = repo();
  const saved = process.env.GIT_DIR;
  try {
    r.write({ 'BACKLOG.md': BACKLOG, 'settings.json': '{}\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base');
    r.g('branch', 'origin-main');
    r.write({ 'settings.json': '{"a":1}\n' });
    decoy.write({ 'x.txt': 'x\n' });
    decoy.g('add', '-A'); decoy.g('commit', '-q', '-m', 'decoy');
    process.env.GIT_DIR = path.join(decoy.dir, '.git');
    const res = run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'origin-main'] });
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.deepEqual(res.changed, ['settings.json'], '看的是這一個倉庫，不是誘餌');
    // 列出的也要是這一個倉庫的：讀到誘餌的話改到的檔是空的、一條都不會列
    assert.deepEqual(res.hits.map((h) => h.line), [5], `（甲）要照列：\n${res.lines.join('\n')}`);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    r.cleanup(); decoy.cleanup();
  }
});

test('⑥真的跑一遍指令（空白設定的複本，不讀本倉庫那份）：還沒填設定，退 2', () => {
  const r = runInCopy('tools/backlog-touch.js', ['--base', 'HEAD']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /列不了/u);
  assert.equal(runInCopy('tools/backlog-touch.js', ['--oops']).status, 2);
});

test('③主幹在分岔後改過某條待辦的字、這一支沒碰它：照列（曾是 #50 r1 R2 的反例；只從磁碟讀之後自然成立，留著當回歸）', () => {
  const r = repo();
  try {
    const one = '# 待辦\n\n## 待辦\n\n- 2026-10-01（甲）工具那一支要補考題／tools/a.js／下一支動到它時。\n';
    r.write({ 'BACKLOG.md': one, 'tools/a.js': 'a\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base');
    r.g('branch', 'origin-main');
    r.g('switch', '-q', '-c', 'topic');
    r.write({ 'tools/a.js': 'topic\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'topic');
    r.g('switch', '-q', 'origin-main');
    r.write({ 'BACKLOG.md': one.replace('要補考題', '要補考題（主幹後來補了一句）') });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'main edits the item');
    r.g('switch', '-q', 'topic');
    const res = run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'origin-main'] });
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.deepEqual(res.hits.map((h) => h.hit), [['tools/a.js']], `這一支沒碰那一條，要照列：\n${res.lines.join('\n')}`);
    assert.doesNotMatch(res.lines[0], /另有/u, '不可以說它是這支自己新加的');
  } finally { r.cleanup(); }
});

test('③改了又暫存、再把工作檔改回原樣：已暫存的改動照算（#50 r2 R1）', () => {
  const r = repo();
  try {
    r.write({ 'BACKLOG.md': '# 待辦\n\n## 待辦\n\n- 2026-10-01（甲）／tools/a.js／之後。\n', 'tools/a.js': 'original\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base');
    r.write({ 'tools/a.js': 'staged\n' });
    r.g('add', 'tools/a.js');
    r.write({ 'tools/a.js': 'original\n' });
    const res = run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'HEAD'] });
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.deepEqual(res.changed, ['tools/a.js'], '索引裡還有下一次提交會帶進去的改動');
    assert.equal(res.hits.length, 1);
  } finally { r.cleanup(); }
});

test('③待辦檔只從磁碟讀：設定寫 ./BACKLOG.md、檔名冒號開頭、指到倉庫內的捷徑檔、大小寫別名都照讀（曾是 #50 r2〜r4 的反例）；寫到倉庫外＝退 2', () => {
  const r = repo();
  try {
    r.write({ 'BACKLOG.md': BACKLOG, 'notes/tasks.md': BACKLOG, ':BACKLOG.md': BACKLOG, 'settings.json': '{}\n' });
    fs.symlinkSync('notes/tasks.md', path.join(r.dir, 'LINK.md'));
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base');
    r.g('branch', 'origin-main');
    r.write({ 'settings.json': '{"a":1}\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'topic');
    const names = ['./BACKLOG.md', 'docs/../BACKLOG.md', ':BACKLOG.md', './:BACKLOG.md', 'LINK.md'];
    // 大小寫別名只在不分大小寫的磁碟上存在（這台 Mac 是）；分大小寫的磁碟上讀不到＝退 2，不在這一題
    if (fs.existsSync(path.join(r.dir, 'backlog.md'))) names.push('backlog.md');
    for (const file of names) {
      const res = run({ settings: { ...SETTINGS, backlog: { file, section: '## 待辦' } }, cwd: r.dir, argv: ['--base', 'origin-main'] });
      assert.equal(res.code, 0, `${file}：${res.lines.join('\n')}`);
      assert.deepEqual(res.hits.map((h) => h.line), [5], `${file}：（甲）要照列：\n${res.lines.join('\n')}`);
      assert.doesNotMatch(res.lines[0], /另有/u, file);
    }
    for (const bad of ['../BACKLOG.md', '/etc/BACKLOG.md', 'dir/../../x.md']) {
      const res = run({ settings: { ...SETTINGS, backlog: { file: bad, section: '## 待辦' } }, cwd: r.dir, argv: ['--base', 'origin-main'] });
      assert.equal(res.code, 2, bad);
      assert.match(res.lines.join('\n'), /要寫成從倉庫根目錄算起、在倉庫裡面的路徑/u, bad);
    }
  } finally { r.cleanup(); }
});
test('③檔名有雙引號或反斜線也照樣配得到（git 的可讀輸出會加引號跳脫；#50 r1 R3）', () => {
  const r = repo();
  try {
    const items = '# 待辦\n\n## 待辦\n\n- 2026-10-01（甲）一般的／tools/a.js／之後。\n- 2026-10-01（乙）有引號的／quote".js／之後。\n- 2026-10-01（丙）有反斜線的／slash\\.js／之後。\n';
    r.write({ 'BACKLOG.md': items, 'tools/a.js': 'a\n', 'quote".js': 'q\n', 'slash\\.js': 's\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base');
    r.g('branch', 'origin-main');
    r.write({ 'tools/a.js': 'a2\n', 'quote".js': 'q2\n', 'slash\\.js': 's2\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'topic');
    const res = run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'origin-main'] });
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.deepEqual(res.changed, ['quote".js', 'slash\\.js', 'tools/a.js'], '改到的檔要是原本的檔名，不是 git 加過引號的寫法');
    assert.equal(res.hits.length, 3, res.lines.join('\n'));
    // 另外三個來源各自也要拿原名（#50 r2 R4）：已暫存、沒暫存、沒追蹤各放一個特殊檔名，其餘都回到基準
    r.g('reset', '-q', '--hard', 'origin-main');
    const more = `${items}- 2026-10-01（丁）暫存的／st"aged.js／之後。\n- 2026-10-01（戊）沒暫存的／un\\staged.js／之後。\n- 2026-10-01（己）沒追蹤的／new"\\file.js／之後。\n`;
    r.write({ 'BACKLOG.md': more, 'st"aged.js': 's\n', 'un\\staged.js': 'u\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base2');
    r.g('branch', '-f', 'origin-main');
    r.write({ 'st"aged.js': 's2\n' }); r.g('add', 'st"aged.js');
    r.write({ 'un\\staged.js': 'u2\n', 'new"\\file.js': 'n\n' });
    const res2 = run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'origin-main'] });
    assert.equal(res2.code, 0, res2.lines.join('\n'));
    assert.deepEqual(res2.changed, ['new"\\file.js', 'st"aged.js', 'un\\staged.js'], '三個來源都要是原名');
    assert.deepEqual(res2.hits.map((h) => h.hit[0]).sort(), ['new"\\file.js', 'st"aged.js', 'un\\staged.js']);
  } finally { r.cleanup(); }
});

test('③待辦檔是這一支才新建的：照列（裁 a：不再把它當成「這支自己新加的」藏起來）', () => {
  const r = repo();
  try {
    r.write({ 'settings.json': '{}\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'base');
    r.g('branch', 'origin-main');
    r.write({ 'BACKLOG.md': BACKLOG, 'settings.json': '{"a":1}\n' });
    r.g('add', '-A'); r.g('commit', '-q', '-m', 'topic adds backlog');
    const res = run({ settings: SETTINGS, cwd: r.dir, argv: ['--base', 'origin-main'] });
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.deepEqual(res.hits.map((h) => h.line), [5]);
    assert.doesNotMatch(res.lines[0], /另有/u);
  } finally { r.cleanup(); }
});
