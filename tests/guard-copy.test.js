// 守禁區攔截器的固定複本與 Codex 全域層接線（規矩 B1；裁示 6a＋7b）。
//
// 為什麼：Codex 的「信任」只記鉤子那一行指令，不記它引用的檔。全域層讀一份固定複本，複本被改＝不必重按信任就生效、
// 沒有人看得到。所以指令裡寫死複本的指紋，對不上就退 2（所有 mcp__ 工具都擋）。
//
// 守得到的：
//   ①抽出來的複本剛好是那四個檔、唯讀、內容是那個版本提交的（工作樹沒提交的改動進不去），同一個版本抽兩次指紋一樣；
//     指紋跟 /usr/bin/shasum 自己算的一模一樣（兩套實作互證）；
//   ②印出來的指令真的跑一遍（sh -c 與 sh -lc、從別的目錄起）：該擋的擋、該放的放；
//   ③四個檔各改一個位元組、少一個檔、整個複本不在、三個佔位任一個沒換、複本裡任何一處換成連結（內容一模一樣也算）、查不了有沒有連結、找不到 find＝退 2、不印拒絕以外的東西；
//     連結那兩道（查連結、node 不順著連結找檔）各自單獨也擋得住；
//     每一種都有「改回來就恢復」的對照組（連結那幾種另有對照：不擋的話，內容相同的連結真的會讓攔截器讀到別份清單而放行）；
//   ④找不到 node、攔截器載入就崩（指紋是對的）＝退 2；
//   ⑤**攔截器讀到的檔＝指紋蓋到的檔**：程式層追蹤（每一支載入的模組、每一次讀檔）加上 Node 自己讀的 tools/package.json
//     （行為證明：拿掉就崩），剛好等於指紋清單；複本旁邊、上一層放會改變載入方式的檔，判斷不變；原始碼裡每一個 require 都是
//     內建模組或清單上的檔；攔截器只讀設定的 forbidden 那一塊（所以複本只放那一塊）；
//   ⑥環境變數夾帶的程式（NODE_OPTIONS）進不來（對照組：拿掉清空環境那一截，夾帶的程式真的會把該擋的放行）；
//   ⑦拒絕的情況什麼都不寫：相對路徑、路徑含單引號、目的地不空、在版本控制目錄裡、在家目錄的 .codex／.claude 底下
//     （大小寫不同也算，目錄還不存在也算）、在暫存區、版本不存在、那個版本的禁區清單沒填、範本那一組形狀不對、
//     清單只有樣式規則卻沒給 --deny-probe、--deny-probe 不是合法的假工具名；
//     自我試跑沒過、寫到一半出錯＝退 1、不印接線；
//   ⑧只抽**已經在 origin/<主幹> 裡**的版本（本機沒推的提交、沒 fetch、設定沒填主幹＝拒絕）；接線範本也從那個版本讀（工作樹改了範本不算數）；
//   ⑨自我試跑真的抓得到：攔截器被改成什麼都放、清單壞到什麼都擋、指紋檢查被拿掉、放行時往輸出印字——都退 1、不印接線；
//     試跑的無害假名剛好被專案清單擋到時換下一個，不誤判。
//     （登入設定印字那一段要這台機器的登入 shell 真的讀 ~/.profile 才跑得出來，考題先驗這件事；讀不到的機器上那一段不跑。）
//   拒絕在這一層是「退 2＋錯誤輸出印拒絕形狀」，不是「退 0＋標準輸出」：指令在登入 shell 裡跑，登入設定往標準輸出印字會弄壞拒絕形狀。
// ⚠️ 守不到的：真的 Codex session 有沒有照這樣起鉤子、信任有沒有真的只記指令（要在真 session 驗）；node 與 shasum 本身；
//   檢查與執行之間的極短空檔被換檔；追蹤只看得到這一次跑到的分支（靜態那一題補 require，補不到動態組出來的讀檔路徑）；
//   Windows（指令是 sh）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');
const { cli } = require('../tools/forbidden-tools.js');
const { COPY_FILES, PLACEHOLDERS, ALLOW_PROBES, fingerprintDir, build, Refusal } = require('../tools/guard-copy.js');

const KIT = path.join(__dirname, '..');
const SHASUM = '/usr/bin/shasum';
const CRASH = /require is not defined in ES module scope/u;
const MISMATCH = /指紋對不上/u;
const STARTUP = /起不來/u;
// 全是假名（連接器、工具名都是編的）
const FAKE = {
  name: '測試禁區', servers: ['fakebroker'], allowlist: ['get_quote'], deny: ['mcp__other__harmless_named_thing'],
  verbs: ['create', 'place'], nouns: ['widget'], readPrefixes: ['get'], patterns: [],
};
const DENIED = 'mcp__fakebroker__place_widget';
const ALLOWED = 'mcp__other__get_widget';
const templateCommand = () => JSON.parse(fs.readFileSync(path.join(KIT, 'templates', 'hook-codex-global.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;

const base = gitEnv();
delete base.NODE_TEST_CONTEXT;
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...base, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });

/** 暫存的來源專案：套件的 tools/ 與 templates/＋考題給的設定，提交成一個版本。 */
function sourceRepo(scratch, { forbidden = FAKE, edit, mainBranch = 'main', merged = true } = {}) {
  const src = fs.mkdtempSync(path.join(scratch, 'src-'));
  fs.cpSync(path.join(KIT, 'tools'), path.join(src, 'tools'), { recursive: true });
  fs.cpSync(path.join(KIT, 'templates'), path.join(src, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(src, 'settings.json'), JSON.stringify({ participants: [], mainBranch, forbidden, gates: [] }, null, 2));
  if (edit) edit(src);
  assert.equal(git(src, 'init', '-q').status, 0);
  assert.equal(git(src, 'add', '-A').status, 0);
  const c = git(src, 'commit', '-qm', 'src');
  assert.equal(c.status, 0, c.stderr);
  // 當成已經合併：本機的 origin/<主幹> 追蹤參照指到這一顆（不連網）
  if (merged) assert.equal(git(src, 'update-ref', `refs/remotes/origin/${mainBranch}`, 'HEAD').status, 0);
  return src;
}

/** 照鉤子的起法跑一次。回 spawnSync 結果。 */
const hook = (command, { tool = ALLOWED, flag = '-lc', cwd = os.tmpdir(), env = {} } = {}) =>
  spawnSync('/bin/sh', [flag, command], { cwd, env: { ...base, ...env }, input: JSON.stringify({ tool_name: tool }), encoding: 'utf8' });
/** 攔截器本身的拒絕：退 0、標準輸出是拒絕形狀。 */
const deniesJson = (r, why) => {
  assert.equal(r.status, 0, `${why}：退出碼 ${r.status}（${r.stderr}）`);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', why);
};
/** 全域層接線的拒絕：退 2、標準輸出空的、錯誤輸出是拒絕形狀。 */
const denies = (r, why) => {
  assert.equal(r.status, 2, `${why}：退出碼 ${r.status}（${r.stderr}）`);
  assert.equal(r.stdout, '', why);
  assert.equal(JSON.parse(r.stderr.trim()).hookSpecificOutput.permissionDecision, 'deny', why);
};
const allows = (r, why) => assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], why);
const blocks = (r, re, why) => {
  assert.equal(r.status, 2, `${why}：退出碼 ${r.status}（${r.stderr}）`);
  assert.equal(r.stdout, '', why);
  assert.match(r.stderr, re, why);
};

function withScratch(fn) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-guard-copy-')));
  try { return fn(scratch); } finally {
    for (const p of walk(scratch)) { try { fs.chmodSync(p, 0o755); } catch { /* 已經不在 */ } }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
function walk(dir) {
  const out = [dir];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name)));
    else out.push(path.join(dir, e.name));
  }
  return out;
}

test('前提：這台機器有 /usr/bin/shasum 與 /bin/sh（沒有的話全域層接線在這台機器上一律退 2）', () => {
  assert.ok(fs.existsSync(SHASUM), '沒有 /usr/bin/shasum');
  assert.ok(fs.existsSync('/bin/sh'), '沒有 /bin/sh');
});

test('①複本剛好四個檔、唯讀、內容來自提交的版本；指紋可重現、跟 shasum 自己算的一樣', () => withScratch((scratch) => {
  const src = sourceRepo(scratch);
  // 工作樹上沒提交的改動不可以進複本
  fs.appendFileSync(path.join(src, 'tools', 'forbidden-tools.js'), '\n// 沒提交的改動\n');
  const a = build({ from: 'HEAD', to: path.join(scratch, 'copy-a'), root: src, allowTemp: true });
  const b = build({ from: 'HEAD', to: path.join(scratch, 'copy-b'), root: src, allowTemp: true });
  assert.equal(a.failure, null, a.failure);
  assert.equal(a.fp, b.fp, '同一個版本抽兩次，指紋要一樣');
  const files = walk(a.copyDir).filter((p) => fs.statSync(p).isFile()).map((p) => path.relative(a.copyDir, p)).sort();
  assert.deepEqual(files, [...COPY_FILES].sort(), '複本裡只能有指紋蓋到的那幾個檔');
  for (const rel of COPY_FILES) assert.equal(fs.statSync(path.join(a.copyDir, rel)).mode & 0o222, 0, `${rel} 要唯讀`);
  const committed = git(src, 'show', 'HEAD:tools/forbidden-tools.js').stdout;
  assert.equal(fs.readFileSync(path.join(a.copyDir, 'tools', 'forbidden-tools.js'), 'utf8'), committed, '內容要是提交的版本');
  assert.doesNotMatch(committed, /沒提交的改動/u, '對照組：改動確實沒提交');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.copyDir, 'settings.json'), 'utf8')), { forbidden: FAKE }, '設定只放 forbidden 那一塊');
  const sh = spawnSync('/bin/sh', ['-c', `${SHASUM} -a 256 ${COPY_FILES.join(' ')} | ${SHASUM} -a 256`], { cwd: a.copyDir, encoding: 'utf8' });
  assert.equal(sh.stdout, `${a.fp}  -\n`, '指紋要跟 shasum 算的一模一樣');
  assert.equal(fingerprintDir(a.copyDir), a.fp);
  const cmd = a.group.hooks[0].command;
  assert.equal(a.group.matcher, '^mcp__');
  assert.ok(cmd.includes(`'${a.copyDir}'`) && cmd.includes(`'${a.fp}  -'`) && cmd.includes(COPY_FILES.join(' ')), '三個佔位都換成實際的值');
  for (const ph of PLACEHOLDERS) assert.ok(!cmd.includes(ph), `${ph} 沒換掉`);
}));

test('②③④印出來的指令真的跑一遍：擋、放、改一個位元組、少檔、複本不在、佔位沒換、沒有 node、載入就崩', () => withScratch((scratch) => {
  const src = sourceRepo(scratch);
  const { copyDir, fp, group, failure } = build({ from: 'HEAD', to: path.join(scratch, 'copy'), root: src, allowTemp: true });
  assert.equal(failure, null, failure);
  const cmd = group.hooks[0].command;
  const elsewhere = fs.mkdtempSync(path.join(scratch, 'elsewhere-'));
  for (const flag of ['-c', '-lc']) {
    denies(hook(cmd, { flag, tool: DENIED, cwd: elsewhere }), `${flag}：該擋的擋`);
    allows(hook(cmd, { flag, cwd: elsewhere }), `${flag}：該放的放（尾巴不可以把放行變成擋）`);
  }
  for (const rel of COPY_FILES) {
    const file = path.join(copyDir, rel);
    const original = fs.readFileSync(file);
    const flipped = Buffer.from(original);
    flipped[Math.floor(flipped.length / 2)] ^= 0x01;
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, flipped);
    blocks(hook(cmd, { tool: DENIED }), MISMATCH, `${rel} 改一個位元組`);
    blocks(hook(cmd), MISMATCH, `${rel} 改一個位元組：本來放行的也擋`);
    fs.writeFileSync(file, original);
    fs.chmodSync(file, 0o444);
    allows(hook(cmd), `對照組：${rel} 改回來就恢復`);
  }
  const moved = path.join(scratch, 'moved');
  fs.renameSync(path.join(copyDir, 'tools', 'settings-data.js'), moved);
  blocks(hook(cmd), MISMATCH, '少一個檔');
  fs.renameSync(moved, path.join(copyDir, 'tools', 'settings-data.js'));
  fs.renameSync(copyDir, `${copyDir}.away`);
  blocks(hook(cmd), MISMATCH, '整個複本不在');
  fs.renameSync(`${copyDir}.away`, copyDir);
  allows(hook(cmd), '對照組：放回來就恢復');

  // 連結（裁示批 r1 B1）：另一份內容相同、只有清單放寬的複本；把這一份的某一處換成指向它的連結，
  // shasum 跟著連結算出一樣的指紋，node 卻從連結真正的位置找旁邊的檔＝讀到放寬的清單。一律擋。
  const loose = path.join(scratch, 'loose-copy');
  fs.cpSync(copyDir, loose, { recursive: true });
  for (const p of walk(loose)) fs.chmodSync(p, 0o755);
  fs.writeFileSync(path.join(loose, 'settings.json'), `${JSON.stringify({ forbidden: { ...FAKE, servers: ['nothing_here'], verbs: ['nothing_here'] } }, null, 2)}\n`);
  const swapToLink = (rel, target) => {
    const at = path.join(copyDir, rel);
    const saved = `${at}.saved`;
    fs.chmodSync(path.dirname(at), 0o755);
    fs.renameSync(at, saved);
    fs.symlinkSync(target, at);
    return () => { fs.unlinkSync(at); fs.renameSync(saved, at); };
  };
  // 兩道各自擋得住（裁示批 r2 B1）：①查連結而且查不了也擋；②node 不順著連結找旁邊的檔。
  // 對照組＝兩道都拿掉，同一個連結真的讀到放寬的清單而放行（證明這個反例在這台機器上成立）
  const LINK_CHECK = ' && guard_links="$(/usr/bin/find . -type l 2>/dev/null)" && [ -z "$guard_links" ]';
  const PRESERVE = ' --preserve-symlinks --preserve-symlinks-main';
  assert.ok(cmd.includes(LINK_CHECK) && cmd.includes(PRESERVE), '前提：指令裡有兩道');
  const onlyPreserve = cmd.replace(LINK_CHECK, '');
  const neither = onlyPreserve.replace(PRESERVE, '');
  let restore = swapToLink(path.join('tools', 'forbidden-tools.js'), path.join(loose, 'tools', 'forbidden-tools.js'));
  assert.equal(fingerprintDir(copyDir), fp, '前提：換成內容相同的連結，指紋一樣');
  allows(hook(neither, { tool: DENIED }), '對照組：兩道都拿掉時，入口換成連結真的讀到放寬的清單而放行');
  blocks(hook(cmd, { tool: DENIED }), MISMATCH, '入口換成連結');
  denies(hook(onlyPreserve, { tool: DENIED }), '只剩第②道：照複本自己的清單擋');
  // 查不了有沒有連結（tools 設成進得去、列不出）：find 失敗也要擋，不可以把「沒印東西」當成「沒有連結」
  if (process.getuid && process.getuid() !== 0) {
    fs.chmodSync(path.join(copyDir, 'tools'), 0o111);
    const find = spawnSync('/usr/bin/find', ['.', '-type', 'l'], { cwd: copyDir, encoding: 'utf8' });
    try {
      assert.notEqual(find.status, 0, '前提：這樣設定之後 find 真的失敗');
      assert.equal(fingerprintDir(copyDir), fp, '前提：四個檔照樣讀得到、指紋一樣');
      blocks(hook(cmd, { tool: DENIED }), MISMATCH, '查不了有沒有連結');
      const swallowed = cmd.replace(LINK_CHECK, ' && [ -z "$(/usr/bin/find . -type l 2>/dev/null)" ]').replace(PRESERVE, '');
      allows(hook(swallowed, { tool: DENIED }), '對照組：只看輸出空不空、又不帶旗標的寫法，這個情況真的放行');
    } finally {
      fs.chmodSync(path.join(copyDir, 'tools'), 0o755);
    }
  }
  restore();
  blocks(hook(cmd.replace('/usr/bin/find', '/nonexistent/find')), MISMATCH, '找不到 find 也擋');
  restore = swapToLink('tools', path.join(loose, 'tools'));
  blocks(hook(cmd, { tool: DENIED }), MISMATCH, 'tools 目錄換成連結');
  restore();
  restore = swapToLink('settings.json', path.join(scratch, 'moved-settings-link-target'));
  fs.copyFileSync(`${path.join(copyDir, 'settings.json')}.saved`, path.join(scratch, 'moved-settings-link-target'));
  blocks(hook(cmd), MISMATCH, '設定檔換成內容相同的連結');
  restore();
  denies(hook(cmd, { tool: DENIED }), '對照組：連結都拿掉就恢復');

  const values = { '{copyDir}': copyDir, '{files}': COPY_FILES.join(' '), '{fingerprint}': fp };
  const fill = (skip) => PLACEHOLDERS.reduce((c, ph) => (ph === skip ? c : c.replace(ph, () => values[ph])), templateCommand());
  blocks(hook(templateCommand()), MISMATCH, '範本原樣（三個佔位都沒換）');
  for (const ph of PLACEHOLDERS) blocks(hook(fill(ph)), MISMATCH, `只有 ${ph} 沒換`);
  denies(hook(fill(null), { tool: DENIED }), '對照組：三個都換了就正常判');

  // 沒有 node：PATH 裡只有 env。用 -c（-lc 會照登入設定重建 PATH，模擬不出來）
  const envOnly = fs.mkdtempSync(path.join(scratch, 'envonly-'));
  fs.symlinkSync('/usr/bin/env', path.join(envOnly, 'env'));
  blocks(hook(cmd, { flag: '-c', env: { PATH: envOnly } }), STARTUP, '找不到 node');

  // 載入就崩、但指紋是對的（複本就是照崩掉的版本抽的）：要被尾巴轉成退 2，而且不是指紋那一句
  const crashSrc = sourceRepo(scratch, { edit: (dir) => fs.writeFileSync(path.join(dir, 'tools', 'settings-data.js'), "'use strict';\nthrow new Error('載入就崩');\n") });
  const crashed = build({ from: 'HEAD', to: path.join(scratch, 'copy-crash'), root: crashSrc, allowTemp: true });
  assert.ok(crashed.failure, '自我試跑要抓到崩掉的攔截器');
  const r = hook(crashed.group.hooks[0].command);
  blocks(r, STARTUP, '攔截器載入就崩');
  assert.doesNotMatch(r.stderr, MISMATCH, '崩掉那一份的指紋是對的：擋下它的是尾巴，不是指紋檢查');
}));

test('⑤攔截器讀到的檔＝指紋蓋到的檔（追蹤＋行為＋原始碼三路）', () => withScratch((scratch) => {
  const src = sourceRepo(scratch);
  const { copyDir, group, failure } = build({ from: 'HEAD', to: path.join(scratch, 'copy'), root: src, allowTemp: true });
  assert.equal(failure, null, failure);
  const cmd = group.hooks[0].command;

  // 程式層追蹤：每一支載入的模組、每一次讀檔（Node 自己讀 package.json 那一下看不到，下面另外證明）
  const tracer = path.join(scratch, 'tracer.js');
  const traceOut = path.join(scratch, 'trace.json');
  fs.writeFileSync(tracer, `'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const seen = new Set();
for (const ext of Object.keys(Module._extensions)) {
  const orig = Module._extensions[ext];
  Module._extensions[ext] = function (m, filename) { seen.add(filename); return orig.call(this, m, filename); };
}
for (const fn of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream', 'readSync']) {
  const orig = fs[fn];
  fs[fn] = function (p, ...rest) { if (typeof p === 'string') seen.add(p); return orig.call(this, p, ...rest); };
}
for (const fn of ['readFile', 'open']) {
  const orig = fs.promises[fn];
  fs.promises[fn] = function (p, ...rest) { if (typeof p === 'string') seen.add(p); return orig.call(this, p, ...rest); };
}
process.on('exit', () => { fs.writeFileSync(${JSON.stringify(traceOut)}, JSON.stringify([...seen])); });
`);
  const traced = new Set();
  for (const input of [JSON.stringify({ tool_name: DENIED }), JSON.stringify({ tool_name: ALLOWED }), 'not json', '{}']) {
    const r = spawnSync(process.execPath, ['--require', tracer, path.join(copyDir, 'tools', 'forbidden-tools.js')], { cwd: scratch, input, encoding: 'utf8', env: base });
    assert.equal(r.status, 0, r.stderr);
    for (const p of JSON.parse(fs.readFileSync(traceOut, 'utf8'))) {
      const rel = path.relative(copyDir, fs.existsSync(p) ? fs.realpathSync(p) : p);
      assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), `攔截器讀了複本以外的檔：${p}`);
      traced.add(rel.split(path.sep).join('/'));
    }
  }
  assert.ok(traced.has('tools/forbidden-tools.js'), '前提：追蹤器真的有在記');
  // Node 自己讀的：tools/package.json 決定照 CommonJS 載入。在宣告 type:module 的上層裡拿掉它就崩＝它確實被讀
  const esm = fs.mkdtempSync(path.join(scratch, 'esm-'));
  fs.writeFileSync(path.join(esm, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.cpSync(copyDir, path.join(esm, 'copy'), { recursive: true });
  const run = (dir) => spawnSync(process.execPath, [path.join(dir, 'tools', 'forbidden-tools.js')], { input: JSON.stringify({ tool_name: DENIED }), encoding: 'utf8', env: base });
  deniesJson(run(path.join(esm, 'copy')), '前提：宣告在的時候照常判');
  fs.chmodSync(path.join(esm, 'copy', 'tools', 'package.json'), 0o644);
  fs.rmSync(path.join(esm, 'copy', 'tools', 'package.json'));
  const broken = run(path.join(esm, 'copy'));
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, CRASH, 'tools/package.json 被 Node 讀、會改變載入方式');
  assert.deepEqual([...traced, 'tools/package.json'].sort(), [...COPY_FILES].sort(), '讀到的檔要剛好等於指紋清單（多讀一個＝沒蓋到；少讀一個＝清單過期）');

  // 複本旁邊、上一層放會改變載入方式的檔：不在清單上，指紋不變，判斷也不可以變
  fs.writeFileSync(path.join(copyDir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(path.dirname(copyDir), 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(copyDir, 'tools', 'node_modules'));
  denies(hook(cmd, { tool: DENIED }), '複本旁邊多了不在清單上的檔：判斷不變');
  allows(hook(cmd), '複本旁邊多了不在清單上的檔：放行也不變');

  // 原始碼：每一個 require 都是內建模組或清單上的檔（追蹤只看得到跑到的分支，這裡補沒跑到的 require）
  for (const rel of COPY_FILES.filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(copyDir, rel), 'utf8');
    const all = code.match(/\brequire\s*\(/gu) || [];
    const literal = [...code.matchAll(/\brequire\s*\(\s*'([^']+)'\s*\)/gu)].map((m) => m[1]);
    assert.equal(literal.length, all.length, `${rel} 有不是字面字串的 require：追蹤與這一題都保證不了它讀什麼`);
    for (const spec of literal) {
      if (spec.startsWith('node:')) continue;
      const target = path.posix.join(path.posix.dirname(rel), spec);
      assert.ok(COPY_FILES.includes(target), `${rel} require 了清單以外的 ${spec}`);
    }
  }
  const dataFile = spawnSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]).dataFile)', path.join(copyDir, 'tools', 'settings-data.js')], { encoding: 'utf8', env: base });
  assert.equal(dataFile.stdout, path.join(copyDir, 'settings.json'), `設定從複本自己的 settings.json 讀（${dataFile.stderr}）`);
  // 攔截器只讀設定的 forbidden 那一塊：複本只放那一塊才不會少東西
  const keys = new Set();
  const spy = new Proxy({ forbidden: FAKE, other: 1 }, { get: (t, k) => { keys.add(k); return t[k]; } });
  cli(JSON.stringify({ tool_name: DENIED }), spy);
  assert.deepEqual([...keys], ['forbidden'], '攔截器讀了 forbidden 以外的設定欄位：複本要跟著放那一欄');
}));

test('⑥環境變數夾帶的程式進不來（NODE_OPTIONS）', () => withScratch((scratch) => {
  const src = sourceRepo(scratch);
  const { group } = build({ from: 'HEAD', to: path.join(scratch, 'copy'), root: src, allowTemp: true });
  const cmd = group.hooks[0].command;
  const evil = path.join(scratch, 'evil.js');
  fs.writeFileSync(evil, 'process.exit(0);\n');
  const env = { NODE_OPTIONS: `--require=${evil}` };
  const withoutClear = cmd.replace('env -i PATH="$PATH" node ', 'node ');
  assert.notEqual(withoutClear, cmd, '前提：指令裡有清空環境那一截');
  allows(hook(withoutClear, { tool: DENIED, flag: '-c', env }), '對照組：不清環境時，夾帶的程式真的把該擋的放行');
  denies(hook(cmd, { tool: DENIED, flag: '-c', env }), '清空環境：夾帶的程式進不來');
}));

test('⑦拒絕的情況什麼都不寫；自我試跑沒過＝退 1、不印接線', () => withScratch((scratch) => {
  const src = sourceRepo(scratch);
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  const refuses = (args, re, why) => {
    assert.throws(() => build({ root: src, home, from: 'HEAD', allowTemp: true, ...args }), (e) => e instanceof Refusal && re.test(e.message), why);
    if (args.to && path.isAbsolute(args.to) && !args.to.endsWith('nonempty')) assert.ok(!fs.existsSync(args.to), `${why}：不可以留下目的地`);
  };
  refuses({ to: 'relative/copy' }, /絕對路徑/u, '相對路徑');
  refuses({ to: path.join(scratch, "it's") }, /單引號/u, '路徑含單引號');
  const nonempty = path.join(scratch, 'nonempty');
  fs.mkdirSync(nonempty);
  fs.writeFileSync(path.join(nonempty, 'x'), '');
  refuses({ to: nonempty }, /已經有東西/u, '目的地不空');
  refuses({ to: path.join(src, 'inside', 'copy') }, /目的地在版本控制目錄裡/u, '在版本控制目錄裡');
  refuses({ to: path.join(src, '.git', 'copy') }, /目的地在版本控制目錄裡/u, '在 .git 裡');
  refuses({ to: path.join(home, '.codex', 'guard') }, /\.codex/u, '家目錄的 .codex');
  refuses({ to: path.join(home, '.claude', 'guard') }, /\.claude/u, '家目錄的 .claude');
  refuses({ to: path.join(scratch, 'c1'), from: 'no-such-ref' }, /不是這個倉庫裡的一個版本/u, '版本不存在');
  refuses({ to: path.join(scratch, 'c2'), from: '--help' }, /要給一個版本/u, '版本以 - 開頭');
  const unset = sourceRepo(scratch, { forbidden: { name: '未設定' } });
  assert.throws(() => build({ root: unset, home, from: 'HEAD', to: path.join(scratch, 'c3'), allowTemp: true }), /還沒填/u, '禁區清單沒填');
  assert.ok(!fs.existsSync(path.join(scratch, 'c3')));

  // 指令入口：用法、成功、自我試跑沒過
  const cliEnv = { ...base, KIT_GUARD_COPY_ALLOW_TEMP: '1' };
  const tool = (root, args, env = cliEnv) => spawnSync(process.execPath, [path.join(root, 'tools', 'guard-copy.js'), ...args], { cwd: scratch, encoding: 'utf8', env });
  const usage = tool(src, []);
  assert.deepEqual([usage.status, usage.stdout], [2, '']);
  assert.match(usage.stderr, /用法/u);
  const ok = tool(src, ['--from', 'HEAD', '--to', path.join(scratch, 'cli-ok')]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).matcher, '^mcp__');
  assert.match(ok.stderr, /來源版本：[0-9a-f]{40}/u);
  // git 說的不是「不是倉庫」而是別的錯（這裡用只會失敗的假 git）：確認不了＝拒絕，不是當成倉庫以外
  const fakeGit = fs.mkdtempSync(path.join(scratch, 'fakegit-'));
  fs.writeFileSync(path.join(fakeGit, 'git'), '#!/bin/sh\necho "fatal: detected dubious ownership" >&2\nexit 128\n', { mode: 0o755 });
  const dubious = spawnSync(process.execPath, [path.join(src, 'tools', 'guard-copy.js'), '--from', 'HEAD', '--to', path.join(scratch, 'cli-dubious')], { cwd: scratch, encoding: 'utf8', env: { ...cliEnv, PATH: `${fakeGit}${path.delimiter}${base.PATH}` } });
  assert.equal(dubious.status, 2, dubious.stderr);
  assert.match(dubious.stderr, /無法確認目的地不在版本控制目錄裡/u);
  assert.ok(!fs.existsSync(path.join(scratch, 'cli-dubious')));
  const crashSrc = sourceRepo(scratch, { edit: (dir) => fs.writeFileSync(path.join(dir, 'tools', 'settings-data.js'), "throw new Error('x');\n") });
  const bad = tool(crashSrc, ['--from', 'HEAD', '--to', path.join(scratch, 'cli-bad')]);
  assert.deepEqual([bad.status, bad.stdout], [1, ''], '自我試跑沒過：退 1、標準輸出空的（沒有東西可以貼）');
  assert.match(bad.stderr, /自我試跑沒過/u);

  // 暫存區：作業系統會清，實際安裝一律拒絕（考題的放行是明寫的旗標；不給旗標就拒絕）
  const inTemp = path.join(scratch, 'no-allow-temp');
  assert.throws(() => build({ root: src, home, from: 'HEAD', to: inTemp }), (e) => e instanceof Refusal && /暫存區/u.test(e.message), '暫存區');
  assert.ok(!fs.existsSync(inTemp), '暫存區：不可以留下目的地');
  const noFlag = tool(src, ['--from', 'HEAD', '--to', path.join(scratch, 'cli-temp')], base);
  assert.equal(noFlag.status, 2, noFlag.stderr);
  assert.match(noFlag.stderr, /暫存區/u);

  // 大小寫不同也要擋：不分大小寫的磁碟上 .CODEX 就是 .codex；目錄還不存在時也一樣（裁示批 r1 B3：第一次建立就擋不住）
  const freshHome = fs.mkdtempSync(path.join(scratch, 'fresh-home-'));
  const refusesIn = (to, re, why) => {
    assert.throws(() => build({ root: src, home: freshHome, from: 'HEAD', allowTemp: true, to }), (e) => e instanceof Refusal && re.test(e.message), why);
    assert.ok(!fs.existsSync(to), `${why}：不可以留下目的地`);
  };
  refusesIn(path.join(freshHome, '.CODEX', 'guard'), /\.codex/u, '.CODEX 還不存在');
  refusesIn(path.join(freshHome, '.Claude', 'guard'), /\.claude/u, '.Claude 還不存在');
  assert.ok(!fs.existsSync(path.join(freshHome, '.codex')) && !fs.existsSync(path.join(freshHome, '.claude')), '前提：兩個目錄都真的還不存在');
  fs.mkdirSync(path.join(freshHome, '.codex'));
  refusesIn(path.join(freshHome, '.CODEX', 'guard2'), /\.codex/u, '.codex 已存在、寫成大寫');

  // 範本那一組的形狀不對（matcher 被改掉，提交進版本）：拒絕、不印（裁示批 r1 T2）
  const badShape = sourceRepo(scratch, { edit: (dir) => {
    const f = path.join(dir, 'templates', 'hook-codex-global.json');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"matcher": "^mcp__"', '"matcher": "^mcp__unrelated__"'));
  } });
  assert.throws(() => build({ root: badShape, home, from: 'HEAD', allowTemp: true, to: path.join(scratch, 'c-shape') }), (e) => e instanceof Refusal && /形狀不對/u.test(e.message), '範本 matcher 被改掉');
  assert.ok(!fs.existsSync(path.join(scratch, 'c-shape')));

  // 寫到一半出錯（目的地的上層不給寫）：退 1、不印接線、訊息說可能留有半份
  if (process.getuid && process.getuid() !== 0) {
    const ro = fs.mkdtempSync(path.join(scratch, 'ro-'));
    fs.chmodSync(ro, 0o555);
    const half = tool(src, ['--from', 'HEAD', '--to', path.join(ro, 'copy')]);
    fs.chmodSync(ro, 0o755);
    assert.deepEqual([half.status, half.stdout], [1, ''], `寫到一半出錯：退 1、標準輸出空的（${half.stderr}）`);
    assert.match(half.stderr, /寫入或試跑途中出錯/u);
  }
}));

test('⑧只抽已經合併進 origin/<主幹> 的版本；接線範本也從那個版本讀', () => withScratch((scratch) => {
  const src = sourceRepo(scratch);
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  const refuses = (root, args, re, why) => {
    assert.throws(() => build({ root, home, allowTemp: true, from: 'HEAD', ...args }), (e) => e instanceof Refusal && re.test(e.message), why);
    assert.ok(!fs.existsSync(args.to), `${why}：不可以留下目的地`);
  };
  // 本機多一顆沒推的提交
  fs.appendFileSync(path.join(src, 'tools', 'forbidden-tools.js'), '\n// 本機沒推的改動\n');
  assert.equal(git(src, 'commit', '-qam', 'local').status, 0);
  refuses(src, { to: path.join(scratch, 'm1') }, /還不在 origin\/main 裡/u, '本機沒推的提交');
  const ok = build({ root: src, home, allowTemp: true, from: 'HEAD~1', to: path.join(scratch, 'm-ok') });
  assert.equal(ok.failure, null, `對照組：已合併的那一顆照常抽（${ok.failure}）`);
  refuses(sourceRepo(scratch, { merged: false }), { to: path.join(scratch, 'm2') }, /先 git fetch/u, '本機沒有 origin/main');
  refuses(sourceRepo(scratch, { mainBranch: '未設定' }), { to: path.join(scratch, 'm3') }, /主幹分支名/u, '設定沒填主幹');

  // 工作樹把範本的指紋檢查改成放行：抽出來的指令要照提交的範本，不照工作樹
  const tpl = path.join(src, 'templates', 'hook-codex-global.json');
  const committed = fs.readFileSync(tpl, 'utf8');
  const loosened = committed.replace("指紋對不上）：一律當成拒絕' >&2; exit 2; }", "指紋對不上）：一律當成拒絕' >&2; exit 0; }");
  assert.notEqual(loosened, committed, '前提：真的改到範本');
  fs.writeFileSync(tpl, loosened);
  const fromCommit = build({ root: src, home, allowTemp: true, from: 'HEAD~1', to: path.join(scratch, 'm-tpl') });
  assert.equal(fromCommit.failure, null, fromCommit.failure);
  assert.ok(fromCommit.group.hooks[0].command.includes("指紋對不上）：一律當成拒絕' >&2; exit 2; }"), '指令照提交的範本');
}));

test('⑨自我試跑真的抓得到：什麼都放、什麼都擋、指紋檢查被拿掉、放行時印字；試跑名字被清單擋到就換一個', () => withScratch((scratch) => {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  const failsWith = (srcOpts, re, why) => {
    const src = sourceRepo(scratch, srcOpts);
    const r = build({ root: src, home, allowTemp: true, from: 'HEAD', to: fs.mkdtempSync(path.join(scratch, 'st-')) + '/copy' });
    assert.ok(r.failure, `${why}：自我試跑要沒過`);
    assert.match(r.failure, re, `${why}：${r.failure}`);
  };
  const editFile = (rel, fn) => ({ edit: (dir) => fs.writeFileSync(path.join(dir, rel), fn(fs.readFileSync(path.join(dir, rel), 'utf8'))) });
  failsWith(editFile('tools/forbidden-tools.js', (c) => c.replace("return { code: 0, output: d.deny ? hookOutput(d.why, name) : '' };", "return { code: 0, output: '' };")),
    /沒有一個被擋成退 2/u, '指令入口被改成什麼都放（判斷層照常）');
  failsWith(editFile('tools/forbidden-tools.js', (c) => c.replace('function decide(toolName, forbidden) {', 'function decide() { return { deny: false };\n}\nfunction decideOriginal(toolName, forbidden) {')),
    /沒有一個被擋成退 2/u, '判斷層被改成什麼都放');
  failsWith({ forbidden: { name: '測試禁區', servers: ['fake broker with space'] } }, /沒有被乾淨地放行[\s\S]*設定壞掉/u, '清單壞到什麼都擋');
  failsWith(editFile('templates/hook-codex-global.json', (c) => c.replace("指紋對不上）：一律當成拒絕' >&2; exit 2; }", "指紋對不上）：一律當成拒絕' >&2; exit 0; }")),
    /指紋檢查沒有作用/u, '範本的指紋檢查被拿掉（提交進版本）');
  failsWith(editFile('tools/forbidden-tools.js', (c) => c.replace("if (r.output) process.stdout.write(`${r.output}\\n`);", "process.stdout.write(r.output ? `${r.output}\\n` : 'hello\\n');")),
    /沒有被乾淨地放行/u, '放行時往標準輸出印字');

  // 登入設定往標準輸出印字（指令在登入 shell 裡跑）：放行那一次的標準輸出不乾淨＝不印接線。
  // 用假的家目錄放一份會印字的登入設定；先證明這台機器的登入 shell 真的會讀它（對照組），不然這一段證明不了什麼
  const chattyHome = fs.mkdtempSync(path.join(scratch, 'chatty-'));
  fs.writeFileSync(path.join(chattyHome, '.profile'), 'echo PROFILE-SAYS-HELLO\n');
  const probe = spawnSync('/bin/sh', ['-lc', 'true'], { env: { ...base, HOME: chattyHome }, encoding: 'utf8' });
  if (probe.stdout.includes('PROFILE-SAYS-HELLO')) {
    const clean = sourceRepo(scratch);
    const savedHome = process.env.HOME;
    process.env.HOME = chattyHome;
    let chatty;
    try { chatty = build({ root: clean, home, allowTemp: true, from: 'HEAD', to: path.join(scratch, 'st-chatty') }); } finally { process.env.HOME = savedHome; }
    assert.match(chatty.failure || '', /沒有被乾淨地放行[\s\S]*PROFILE-SAYS-HELLO/u, `登入設定印字：自我試跑要沒過（${chatty.failure}）`);
    const quiet = build({ root: clean, home, allowTemp: true, from: 'HEAD', to: path.join(scratch, 'st-quiet') });
    assert.equal(quiet.failure, null, `對照組：同一份來源、登入設定安靜時照常過（${quiet.failure}）`);
  }

  // 試跑的第一個無害名字剛好在專案的拒絕清單上：換下一個，照樣過
  const src = sourceRepo(scratch, { forbidden: { ...FAKE, deny: [ALLOW_PROBES[0], ...FAKE.deny] } });
  const r = build({ root: src, home, allowTemp: true, from: 'HEAD', to: path.join(scratch, 'st-collide') });
  assert.equal(r.failure, null, `試跑名字被清單擋到時要換一個（${r.failure}）`);
}));

test('⑩只靠樣式規則的清單：沒給 --deny-probe 就拒絕（什麼都不寫）；給了照清單該擋的假名就能裝，給的名字不擋或不合法就不過', () => withScratch((scratch) => {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  const patternsOnly = { name: '測試禁區', patterns: ['^create_widget$'] };
  const src = sourceRepo(scratch, { forbidden: patternsOnly });
  const to = path.join(scratch, 'p-none');
  assert.throws(() => build({ root: src, home, from: 'HEAD', allowTemp: true, to }), (e) => e instanceof Refusal && /--deny-probe/u.test(e.message), '沒給 --deny-probe');
  assert.ok(!fs.existsSync(to), '沒給 --deny-probe：不可以留下目的地');
  const ok = build({ root: src, home, from: 'HEAD', allowTemp: true, to: path.join(scratch, 'p-ok'), denyProbe: 'mcp__guard_copy_selftest__create_widget' });
  assert.equal(ok.failure, null, `給了照清單該擋的假名就能裝（${ok.failure}）`);
  denies(hook(ok.group.hooks[0].command, { tool: 'mcp__other__create_widget' }), '裝好的指令照樣式擋');
  allows(hook(ok.group.hooks[0].command, { tool: 'mcp__other__get_widget' }), '裝好的指令照常放行');
  const wrong = build({ root: src, home, from: 'HEAD', allowTemp: true, to: path.join(scratch, 'p-wrong'), denyProbe: 'mcp__guard_copy_selftest__get_widget' });
  assert.match(wrong.failure || '', /沒有一個被擋成退 2/u, '給的名字照清單不擋：不過（不改試別的）');
  assert.throws(() => build({ root: src, home, from: 'HEAD', allowTemp: true, to: path.join(scratch, 'p-illegal'), denyProbe: 'mcp__has space__x' }), (e) => e instanceof Refusal && /合法的假工具名/u.test(e.message), '--deny-probe 不合法');
  // 指令入口也收這個參數
  const cli = spawnSync(process.execPath, [path.join(src, 'tools', 'guard-copy.js'), '--from', 'HEAD', '--to', path.join(scratch, 'p-cli'), '--deny-probe', 'mcp__guard_copy_selftest__create_widget'], { cwd: scratch, encoding: 'utf8', env: { ...base, KIT_GUARD_COPY_ALLOW_TEMP: '1' } });
  assert.equal(cli.status, 0, cli.stderr);
}));
