// 考題清單（r1 Medium⑫）：tests/ 裡的考題檔集合要跟 tests/manifest.json 一字不差。
//
// 為什麼要另立一支：原本的金絲雀住在 settings.test.js 裡，它自己被刪掉就沒有人數考題；而沒有同名工具的
// 結構性考題（忽略清單、檔名、路標、資料契約）也不在它的對照表上。這一支跟 settings.test.js 互相盯著：
// 刪掉任何一支考題檔（含這兩支之一）都會紅，除非連清單一起改——那是看得見的改動。
//
// 守得到的：考題檔的集合不漂（多一支、少一支、改名都紅）。
// 另一題守日常考卷不跑說明書（擁有者 2026-10-05：說明書網頁只在他明確要求時更新）：manual/ 底下沒有 node --test 會自動撿到的檔，
//   產生器與專屬考題留著；檔名寫法跟這台機器的 node 實際撿不撿對過一次。
//   只在套件倉庫跑，套件身分只認根目錄 package.json 的名字、不拿 manual/ 或裡面哪個檔在不在來猜：tests/ 會整批搬進使用專案，
//   使用專案可能有自己的 manual/，連檔名都可能跟套件的一樣（#39 r1、r2）。
// ⚠️ 守不到的：兩支同時被刪；清單被一起改掉（那是看得見的，由複審者看）；套件倉庫的 package.json 改了名字、
//   或這支裡的套件名字寫錯（說明書那題就在套件倉庫也跳過——看得見的改動，靠複審）；名字也叫 ai-collab-kit 的使用專案
//   會被當成套件倉庫照查；搭使用專案那一題在子行程裡自己跳過（不然會一直搭下去），它自己裡面寫的檢查不在那次回歸裡。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('tests/ 裡的考題檔集合跟 manifest.json 一字不差', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  const onDisk = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  assert.deepEqual(onDisk, [...manifest].sort(), '考題檔集合跟清單不一樣：加一支或刪一支都要連 manifest.json 一起改，讓改動看得見');
  assert.ok(manifest.includes('settings.test.js') && manifest.includes('manifest.test.js'), '互相盯著的兩支都要在清單上');
  assert.ok(manifest.length >= 20, `清單只剩 ${manifest.length} 支：這一題自己的前提變了`);
});

// manual/ 只在套件倉庫（不在共用路徑、不會搬進使用專案）；使用專案可能有自己的 manual/，所以套件認名字（#39 r1）。
const ROOT = path.join(__dirname, '..');
const MANUAL = path.join(ROOT, 'manual');
const KIT_NAME = 'ai-collab-kit';
/** 根目錄 package.json 的 name；沒有這個檔或讀不懂＝null。 */
function packageName(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name ?? null; } catch { return null; }
}
const IN_KIT = packageName(ROOT) === KIT_NAME;
const GUARD = '日常考卷不跑說明書：manual/ 底下沒有 node --test 會自動撿到的檔；產生器與專屬考題留著';
/** node --test 不給檔名時撿的檔名寫法（Node 文件列的那幾種；Node 26 也撿 .ts 那幾種）。 */
const AUTO_PICKED = /(?:^|\/)(?:test|test-[^/]*|[^/]*[.\-_]test)\.[cm]?[jt]s$|(?:^|\/)test\/.+\.[cm]?[jt]s$/u;

test(GUARD, { skip: IN_KIT ? false : `不是套件倉庫（根目錄 package.json 的名字不是 ${KIT_NAME}）：manual/ 是套件自己的，使用專案的 manual/ 不歸這一題管` }, () => {
  assert.ok(fs.existsSync(MANUAL), 'manual/ 要留著：產生器與專屬考題在裡面，要更新網頁時才跑');
  const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
  const files = walk(MANUAL);
  assert.deepEqual(files.filter((p) => AUTO_PICKED.test(p)), [], 'manual/ 底下有 node --test 會自動撿到的檔：推送前、雲端三關、合併閘就會跑說明書——擁有者定說明書網頁只在他要求時更新');
  for (const p of ['build.js', 'build.verify.js']) assert.ok(files.includes(p), `manual/${p} 要留著：要更新網頁時才跑，不是刪掉`);
  // 對照組：檔名寫法跟這台機器的 node 對一次——*.test.js 真的會被撿、*.verify.js 真的不會
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-auto-picked-'));
  try {
    for (const name of ['a.test.js', 'build.verify.js']) fs.writeFileSync(path.join(dir, name), `require('node:fs').writeFileSync(require('node:path').join(__dirname, '${name}.ran'), '');\nrequire('node:test')('x', () => {});\n`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;   // 不拿掉的話子行程的 node --test 不管紅不紅都退 0
    const r = spawnSync(process.execPath, ['--test'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual([fs.existsSync(path.join(dir, 'a.test.js.ran')), fs.existsSync(path.join(dir, 'build.verify.js.ran'))], [true, false], '對照組：node --test 要撿 a.test.js、不撿 build.verify.js');
    assert.deepEqual([AUTO_PICKED.test('a.test.js'), AUTO_PICKED.test('build.verify.js')], [true, false], '對照組：上面那串檔名寫法跟 node 實際撿的一樣');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('使用專案有自己的 manual/（文件、自己的考題，連套件的檔名都有）：整支共用考題照綠、守門那題跳過；同一個目錄換成套件的名字就照查（#39 r1、r2）', { skip: process.env.KIT_MANIFEST_CHILD === '1' ? '子行程裡不再搭一次' : false }, () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-own-manual-'));
  try {
    // 照使用專案的樣子搭：tests/ 整份搬過去（這支會跟著共用檔搬），manual/ 是專案自己的、連檔名都跟套件的撞
    fs.cpSync(__dirname, path.join(proj, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'manual'));
    fs.writeFileSync(path.join(proj, 'manual', 'README.md'), '# 專案自己的手冊\n');
    fs.writeFileSync(path.join(proj, 'manual', 'build.js'), '// 專案自己的產生器\n');
    for (const name of ['own.test.js', 'build.verify.js']) fs.writeFileSync(path.join(proj, 'manual', name), "require('node:test')('專案自己的考題', () => {});\n");
    const run = (pkg) => {
      const at = path.join(proj, 'package.json');
      if (pkg) fs.writeFileSync(at, JSON.stringify(pkg)); else fs.rmSync(at, { force: true });
      const env = { ...process.env, KIT_MANIFEST_CHILD: '1' };
      delete env.NODE_TEST_CONTEXT;   // 不拿掉的話子行程的 node --test 不管紅不紅都退 0
      return spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join('tests', path.basename(__filename))], { cwd: proj, env, encoding: 'utf8' });
    };
    for (const pkg of [{ name: 'some-project' }, null]) {
      const r = run(pkg);
      const who = pkg ? `名字是 ${pkg.name}` : '沒有 package.json';
      assert.equal(r.status, 0, `使用專案（${who}）有自己的 manual/，整支共用考題就紅：\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /^ok \d+ - 日常考卷不跑說明書[^\n]*# SKIP/mu, `使用專案（${who}）裡守門那題要跳過`);
    }
    const asKit = run({ name: KIT_NAME });   // 對照組：只換名字＝當成套件倉庫，守門那題真的跑；這個 manual/ 有會被自動撿到的考題所以紅
    assert.equal(asKit.status, 1, `對照組：換成套件的名字，守門那題要照查而且紅：\n${asKit.stdout}${asKit.stderr}`);
    assert.match(asKit.stdout, /^not ok \d+ - 日常考卷不跑說明書/mu, '對照組：紅的是守門那題');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
