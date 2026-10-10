// 守舊文字掃描（規矩 K5）：刪掉或改掉的字串還出現在倉庫哪裡，列出來、不擋。
//
// 守得到的：①三種字串都抓得到（引號框住的、剛好 4 個以上的漢字、看得出是程式名字的英數字），一般英文單字、3 個字的漢字、太短的名字不抓，
//   半形引號之間的程式碎片不抓；同一個字串只列一次；檔頭不算、內容以 -- 開頭的行照抓；
//   ②新增的行裡用同一種抓法抓出一模一樣的字串＝作者自己留著用，不列；只是包含它的照列（改名加長）；
//   ③在真的倉庫裡：刪掉的字還留在別的檔（例如契約）就列出那一處，有命中也退 0（只列不擋）；從子目錄跑也搜整個倉庫；
//     搜的是 HEAD 那一版（還沒提交的改動不算）；三點差異：基準之後主幹自己的改動不算成刪掉；刪掉或改名的檔，舊路徑照搜；
//   ④基準版本找不到、不在倉庫裡、主幹沒填又沒給 --base、--base 沒接值、不認得的參數＝退 2，訊息說是哪一種；
//     git diff 或 git grep 出錯＝退 2（不可以當成沒命中）；
//   ⑤git 那一族環境變數指向別的倉庫也照樣掃這一個（E4）；⑥字串太多、命中太多都照實印出沒搜／沒列的數量，命中只列前 10 處。
// ⚠️ 守不到的：意思變了但用字沒變、或換了說法的（只抓字面）；列出來的有沒有人去看。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');
const { run, parseDiff, phrasesOf, looksLikeName, MAX_HITS } = require('../tools/stale-text.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const SETTINGS = { mainBranch: 'main' };

/** 在暫存目錄建一個倉庫：base 一顆、改動一顆。回傳目錄與 base 的版本碼。 */
function repo(baseFiles, headFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-text-'));
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
  write(baseFiles);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD');
  write(headFiles);
  g('add', '-A');
  g('commit', '-q', '-m', 'head');
  return { dir, base, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('①三種字串都抓得到、一般英文單字不抓；②新增的行裡也有的不列', () => {
  const removed = ['說明寫「整理後說明」在這裡', 'const bankRef = row.note; // 核對請用日期', 'return result; done', '寫「PR說明」與 "npm run build"，還有 `a b c d`', '四個漢字'];
  const got = phrasesOf(removed, []);
  for (const p of ['整理後說明', 'bankRef', 'row.note', '核對請用日期', 'PR說明', 'npm run build', 'a b c d', '四個漢字']) assert.ok(got.includes(p), `要抓到「${p}」：${got.join('、')}`);
  assert.ok(!got.includes('result') && !got.includes('return'), '一般英文單字不抓');
  assert.ok(!got.includes('說明寫'), '不到 4 個字的漢字不單獨抓');
  assert.deepEqual(phrasesOf(['a.b 與 x_y'], []), [], '太短的名字不抓');
  assert.deepEqual(phrasesOf(["run('7', { settings, platform: fake([f('docs/a.md')]) })"], []), ['docs/a.md'], '半形引號之間的程式碎片不抓');
  assert.equal(phrasesOf(['「重複的字」', '又是「重複的字」'], []).filter((p) => p === '重複的字').length, 1, '同一個字串只列一次');
  assert.ok(!phrasesOf(removed, ['新的那一行還是寫「整理後說明」']).includes('整理後說明'), '新增的行裡也有＝作者自己留著用');
  assert.ok(phrasesOf(['loadUser(id)'], ['loadUserById(id)']).includes('loadUser'), '只是包含它（改名加長）照列');
  assert.equal(looksLikeName('ready_for_review'), true);
  assert.equal(looksLikeName('camelCase'), true);
  assert.equal(looksLikeName('simple'), false);
  const d = parseDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-舊的\n--- 核對請用日期欄位\n+新的\n+++ 加長\n');
  assert.deepEqual(d, { removed: ['舊的', '-- 核對請用日期欄位'], added: ['新的', '++ 加長'] }, '檔頭不算、內容以 -- 或 ++ 開頭的行照算');
});

test('③在真的倉庫裡：刪掉的字還留在契約就列出那一處；有命中也退 0（只列不擋）', () => {
  const r = repo(
    { 'src/a.js': '// 核對請用日期\nconst x = 1;\n', 'docs/contract.md': '合約：核對請用日期。\n' },
    { 'src/a.js': '// 改成用編號核對\nconst x = 1;\n' },
  );
  try {
    const out = run(['--base', r.base], { settings: SETTINGS, cwd: r.dir });
    assert.equal(out.code, 0, out.lines.join('\n'));
    const text = out.lines.join('\n');
    assert.match(text, /「核對請用日期」還出現在 1 處/u);
    assert.match(text, /docs\/contract\.md:1：合約：核對請用日期。/u);
    assert.match(text, /只列不擋/u);
    // 從子目錄跑也搜整個倉庫
    assert.match(run(['--base', r.base], { settings: SETTINGS, cwd: path.join(r.dir, 'src') }).lines.join('\n'), /docs\/contract\.md:1/u);
    // 搜的是 HEAD 那一版：工作樹裡還沒提交的修正不算
    fs.writeFileSync(path.join(r.dir, 'docs/contract.md'), '合約：改用編號。\n');
    assert.match(run(['--base', r.base], { settings: SETTINGS, cwd: r.dir }).lines.join('\n'), /「核對請用日期」還出現在 1 處/u);
    // 沒有命中也退 0，並且照實說 0 個
    const clean = repo({ 'a.md': '舊的整句說明文字\n' }, { 'a.md': '新的\n' });
    try {
      const c = run(['--base', clean.base], { settings: SETTINGS, cwd: clean.dir });
      assert.equal(c.code, 0);
      assert.match(c.lines[0], /其中 0 個還出現在倉庫裡/u);
    } finally { clean.cleanup(); }
  } finally { r.cleanup(); }
});

test('③b 三點差異：基準之後主幹自己的改動不算成刪掉；刪掉或改名的檔，舊路徑照搜', () => {
  // z.md 一開始就有那一句：要是把「主幹後來加的」誤算成這支刪掉的，就會在 z.md 命中、被列出來
  const r = repo({ 'a.md': '一\n', 'z.md': '主幹後來才加的一整句\n', 'tools/old-tool.js': 'x\n', 'README.md': '跑 node tools/old-tool.js\n' }, { 'c.md': 'c\n' });
  try {
    const g = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: r.dir, env: gitEnv(), encoding: 'utf8' });
    // 這支從 base 分出去、只改名一個檔；主幹之後自己在 a.md 加了一句
    g('checkout', '-q', '-b', 'side', r.base);
    g('mv', 'tools/old-tool.js', 'tools/new-tool.js');
    g('commit', '-q', '-m', 'rename');
    g('checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.dir, 'a.md'), '一\n主幹後來才加的一整句\n');
    g('commit', '-q', '-am', 'main adds');
    g('checkout', '-q', 'side');
    const out = run(['--base', 'main'], { settings: SETTINGS, cwd: r.dir });
    assert.equal(out.code, 0, out.lines.join('\n'));
    const text = out.lines.join('\n');
    assert.doesNotMatch(text, /主幹後來才加的一整句/u, '基準之後主幹自己的改動不算成這支刪掉的');
    assert.match(text, /「tools\/old-tool\.js」還出現在 1 處/u, '改名的檔，舊路徑照搜');
    assert.match(text, /README\.md:1：跑 node tools\/old-tool\.js/u);
  } finally { r.cleanup(); }
});

test('④基準版本找不到、不在倉庫裡、主幹沒填又沒給 --base、不認得的參數＝退 2；空白設定的複本裡跑指令入口＝退 2', () => {
  const r = repo({ 'a.md': '一\n' }, { 'a.md': '二\n' });
  try {
    assert.equal(run(['--base', 'no-such-ref'], { settings: SETTINGS, cwd: r.dir }).code, 2);
    assert.equal(run([], { settings: { mainBranch: '未設定' }, cwd: r.dir }).code, 2);
    const unknown = run(['--base', r.base, '--what'], { settings: SETTINGS, cwd: r.dir });
    assert.equal(unknown.code, 2);
    assert.match(unknown.lines[0], /不認得「--what」/u, '基準給對了，退 2 只能是因為不認得的參數');
    assert.match(run(['--base'], { settings: SETTINGS, cwd: r.dir }).lines[0], /--base 後面要接基準版本/u);
    // git 出錯不可以當成沒命中（要有字串可搜，grep 才會被叫到）
    const withPhrase = repo({ 'a.md': '核對請用日期\n', 'b.md': '核對請用日期\n' }, { 'a.md': '改用編號\n' });
    try {
      // 每一次 git 查詢各自注入失敗、其餘照常（#32 r1：兩次差異查詢共用一個注入時，刪掉其中一道保護考題照樣綠）
      const real = (args, opts) => spawnSync('git', args, { cwd: opts.cwd, env: gitEnv(), encoding: 'utf8', input: opts.input });
      const failWhen = (pick) => (args, opts) => (pick(args) ? { status: 128, stdout: '', stderr: `fatal: 假的 ${args[0]} 錯誤` } : real(args, opts));
      const cases = [
        ['git grep', (a) => a[0] === 'grep', /git grep 出錯（退出碼 128）/u],
        ['內容差異', (a) => a[0] === 'diff' && a.includes('--unified=0'), /git diff 出錯（退出碼 128）/u],
        ['改名與刪檔清單', (a) => a[0] === 'diff' && a.includes('--name-status'), /git diff 出錯（退出碼 128）/u],
      ];
      for (const [what, pick, msg] of cases) {
        const out = run(['--base', withPhrase.base], { settings: SETTINGS, cwd: withPhrase.dir, runGit: failWhen(pick) });
        assert.equal(out.code, 2, `${what}出錯：退 2，不可以當成沒命中`);
        assert.match(out.lines[0], msg, what);
      }
      const killed = run(['--base', withPhrase.base], { settings: SETTINGS, cwd: withPhrase.dir, runGit: (args, opts) => (args[0] === 'grep' ? { status: null, stdout: '', stderr: '' } : real(args, opts)) });
      assert.equal(killed.code, 2, '被殺掉或超過輸出上限（退出碼是 null）也是錯誤');
    } finally { withPhrase.cleanup(); }
    // 預設跟 origin/<主幹> 比：這個倉庫沒有 origin＝找不到基準＝退 2（不猜）
    assert.match(run([], { settings: SETTINGS, cwd: r.dir }).lines[0], /找不到基準版本「origin\/main」/u);
  } finally { r.cleanup(); }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-text-none-'));
  try {
    const o = run(['--base', 'HEAD'], { settings: SETTINGS, cwd: outside });
    assert.equal(o.code, 2);
    assert.match(o.lines[0], /不在版本控制的倉庫裡/u);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  const copy = runInCopy('tools/stale-text.js', []);
  assert.equal(copy.status, 2, copy.stdout + copy.stderr);
});

test('⑤git 那一族環境變數指向別的倉庫，也照樣掃這一個（E4）', () => {
  const here = repo({ 'src/a.js': '// 這一句只在這個倉庫\n', 'b.md': '這一句只在這個倉庫\n' }, { 'src/a.js': '// 改掉了\n' });
  const other = repo({ 'x.md': '別的\n' }, { 'x.md': '別的二\n' });
  const saved = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = path.join(other.dir, '.git');
    const out = run(['--base', here.base], { settings: SETTINGS, cwd: here.dir });
    assert.equal(out.code, 0, out.lines.join('\n'));
    assert.match(out.lines.join('\n'), /b\.md:1/u, '要掃到這個倉庫的檔');
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    here.cleanup(); other.cleanup();
  }
});

test('⑥命中太多照實印出沒列的處數、只列前 10 處；字串太多照實印出沒搜的個數', () => {
  const many = Object.fromEntries(Array.from({ length: MAX_HITS + 3 }, (_, i) => [`d/${i}.md`, '重複出現的舊說法\n']));
  const r = repo({ 'a.md': '重複出現的舊說法\n', ...many }, { 'a.md': '新說法\n' });
  try {
    const out = run(['--base', r.base], { settings: SETTINGS, cwd: r.dir });
    assert.match(out.lines.join('\n'), new RegExp(`還出現在 ${MAX_HITS + 3} 處`, 'u'));
    assert.match(out.lines.join('\n'), /…另有 3 處沒列/u);
    assert.equal(out.lines.filter((l) => /^ {2}d\/\d+\.md:1：/u.test(l)).length, MAX_HITS, `只列前 ${MAX_HITS} 處`);
  } finally { r.cleanup(); }
  const r2 = repo({ 'a.md': '第一個舊說法\n第二個舊說法\n第三個舊說法\n', 'b.md': '第一個舊說法\n第二個舊說法\n第三個舊說法\n' }, { 'a.md': '新\n' });
  try {
    const out = run(['--base', r2.base], { settings: SETTINGS, cwd: r2.dir, maxPhrases: 1 });
    const text = out.lines.join('\n');
    assert.match(text, /只搜了前 1 個；另有 2 個沒搜/u);
    assert.match(out.lines[0], /刪掉或改掉的字串 3 個，其中 1 個還出現/u, '只搜了 1 個，就只會有 1 個命中');
  } finally { r2.cleanup(); }
});
