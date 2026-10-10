// 守下游落後（擁有者 2026-10-07 第 11 題裁「現在就做。（建議）」；只列不擋、開工時手動跑）。
//
// 守得到的：
//   ①版本從哪來：使用專案主幹上有 kit-lock.json 就用它的 version（形狀照 kit-lock.js 驗、記的例外標在檔名後面），沒有才用設定裡人填的那一格；
//     兩樣都沒有、清單寫壞＝那一個算不出來（退 2），不猜；
//   ②落後幾支＝它記的版本到套件主幹的提交數，另數動到共用路徑的、逐支列出（沒動到共用路徑的不列）；
//   ③共用檔三類：不同（再分「套件後來改了」與「它改過」）、只在套件（「套件後來加的」與「它刪掉了」）、只在它那邊（「套件後來刪了」與「它自己加的」）；
//     共用路徑外的檔不比；
//   ④設定只比欄位名（陣列不往裡看）與機器列名：少的、多的各列出；
//   ⑤算不出來的情形一律退 2、說原因：版本碼本機沒有、不在套件主幹的歷史上、套件主幹那一顆本機沒有（沒 fetch）、平台問不到、主幹分支沒填、
//     設定的 downstream 寫壞；有好幾個使用專案時，算得出來的照印；沒登記任何使用專案＝退 0；
//   ⑥指令入口：給了參數＝退 2；在空白設定的複本裡跑＝退 0（沒有登記）；
//   ⑦一筆登記寫壞只讓那一筆退 2、其餘照算（不論壞的排前排後）；整塊 downstream 壞掉或全部寫壞才一個都不算、也不問平台（#60 r1 R1）；
//   ⑧讀回的每個檔跟這次檔案清單裡的雜湊對不上（下游分支在兩次讀取之間更新）＝那一個退 2 叫人重跑，不拼兩個時點（#60 r1 R2）；對得上的照算；
//   ⑨使用者的 git 設定開了 log.showSignature、範圍裡有簽過章的提交時，簽章診斷不算成支數、不混進逐支清單（#60 r3 R1；假 gpgsig 標頭＋假 gpg 程式，先驗裸的 git log 真的會被污染）；
//   ⑩使用者的 git 設定把 i18n.logOutputEncoding 設成 ISO-8859-1 時，逐支清單的題名照原字印、不成亂碼（#60 r4 R1；先驗裸的 git log 真的吐出別的編碼）。
// ⚠️ 守不到的：平台那條指令翻譯得對不對（GitHub 範本那兩條只在 tests/platform.test.js 看展開，沒有對真平台跑）；
//   使用專案記的版本是不是真的就是它取檔的那一版。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');
const { run, projectsOf, validateProject, keyPaths } = require('../tools/downstream-lag.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy } = require('./helpers/kit-copy.js');

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
  return r.stdout.trim();
}
function write(dir, files) {
  for (const [f, body] of Object.entries(files)) {
    const p = path.join(dir, f);
    if (body === null) { fs.rmSync(p); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}
const blobOf = (dir, body) => spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, env: gitEnv(), input: body, encoding: 'utf8' }).stdout.trim();

const TEMPLATE_V = JSON.stringify({ x: '未設定', y: { z: 1 }, machines: [{ name: '機器甲' }, { name: '機器乙' }] });

/**
 * 暫存的套件倉庫：
 *   V（它記的版本）→ 改共用檔 tools/a.js → 改共用路徑外的 README.md → 加 tools/new.js、刪 tools/gone.js ＝ H（套件主幹）；
 *   另有一顆不在主幹上的側枝。
 */
function kit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downstream-lag-kit-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'maintenance.auto', 'false');
  write(dir, { 'tools/a.js': 'a1\n', 'tools/b.js': 'b1\n', 'tools/c.js': 'c1\n', 'tools/gone.js': 'g\n', 'README.md': 'r1\n', 'tests/helpers/unfilled-settings.json': TEMPLATE_V });
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'V 那一版');
  const V = sh(dir, 'rev-parse', 'HEAD');
  write(dir, { 'tools/a.js': 'a2\n' }); sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', '改共用的 a');
  const S1 = sh(dir, 'rev-parse', 'HEAD');
  write(dir, { 'README.md': 'r2\n' }); sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', '只改說明');
  write(dir, { 'tools/new.js': 'n\n', 'tools/gone.js': null }); sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', '加 new 刪 gone');
  const H = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'checkout', '-q', '-b', 'side', V);
  write(dir, { 'tools/side.js': 's\n' }); sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', '側枝');
  const SIDE = sh(dir, 'rev-parse', 'HEAD');
  sh(dir, 'checkout', '-q', 'main');
  return { dir, V, S1, H, SIDE };
}

/** 使用專案那一邊（平台答的）：檔案清單與內容。 */
function theirs(k, { lock, settings } = {}) {
  const files = {
    'tools/a.js': 'a1\n',            // 還是 V 那一版＝套件後來改了
    'tools/b.js': 'b-local\n',       // 跟 V、H 都不同＝它改過
    'tools/gone.js': 'g\n',          // V 有、H 沒有＝套件後來刪了
    'tools/own.js': 'o\n',           // V、H 都沒有＝它自己加的
    'tests/helpers/unfilled-settings.json': TEMPLATE_V,   // 一樣＝不列
    'README.md': '它自己的說明\n',      // 共用路徑外＝不比
    'settings.json': settings === undefined ? JSON.stringify({ x: 'v', old: 1, machines: [{ name: '機器甲' }, { name: '舊機器' }] }) : settings,
  };
  // tools/c.js 不給＝V 有、它沒有＝它刪掉了；tools/new.js 不給＝套件後來加的
  if (lock !== undefined) files['kit-lock.json'] = typeof lock === 'string' ? lock : JSON.stringify(lock);
  return files;
}
function platformFor(k, files, { head = k.H, fail = {} } = {}) {
  const asked = [];
  return {
    asked,
    ask(op, args) {
      asked.push([op, args]);
      if (fail[op]) throw new PlatformError(fail[op]);
      if (op === 'branchSha') return { sha: head };
      if (op === 'repoTree') return Object.entries(files).map(([p, body]) => ({ path: p, sha: blobOf(k.dir, body) }));
      if (op === 'repoFile') { if (!(args.path in files)) throw new PlatformError('沒有這個檔'); return { content: files[args.path] }; }
      throw new Error(`不該問 ${op}`);
    },
  };
}
const project = (over = {}) => ({ name: '下游甲', repo: 'acme/app', branch: 'main', versionWithoutLockFrom: '它的說明文件第 3 行', ...over });
const settingsFor = (projects, over = {}) => ({ mainBranch: 'main', downstream: { projects }, ...over });
const clean = (k) => fs.rmSync(k.dir, { recursive: true, force: true });

test('①②③④沒裝清單：用設定裡人填的版本；落後幾支、共用檔三類、設定少多的欄位與機器列都列出來', () => {
  const k = kit();
  try {
    const p = platformFor(k, theirs(k));
    const r = run({ settings: settingsFor([project({ versionWithoutLock: k.V })]), platform: p, root: k.dir });
    assert.equal(r.code, 0, r.lines.join('\n'));
    const out = r.lines.join('\n');
    assert.match(out, new RegExp(`記的套件版本 ${k.V.slice(0, 7)}，來源＝設定裡人填的（它還沒裝 kit-lock.json）：它的說明文件第 3 行`, 'u'));
    assert.match(out, /^ {2}落後 3 支（其中動到共用路徑 2 支）：$/mu, out);
    assert.match(out, /^ {4}・[0-9a-f]{7,} 改共用的 a$/mu);
    assert.match(out, /^ {4}・[0-9a-f]{7,} 加 new 刪 gone$/mu);
    assert.doesNotMatch(out, /只改說明/u, '沒動到共用路徑的不列');
    for (const line of [
      '    ・不同：tools/a.js（套件後來改了）',
      '    ・不同：tools/b.js（它改過：跟它記的那一版也不同）',
      '    ・只在套件：tools/c.js（它那邊沒有，它記的版本有＝它刪掉了）',
      '    ・只在套件：tools/new.js（套件後來加的）',
      '    ・只在它那邊：tools/gone.js（套件後來刪了）',
      '    ・只在它那邊：tools/own.js（它自己加的）',
      '    ・少的欄位：y',
      '    ・少的欄位：y.z',
      '    ・多的欄位（套件已拿掉或它自己加的）：old',
      '    ・少的機器列：機器乙',
      '    ・多的機器列：舊機器',
    ]) assert.ok(r.lines.includes(line), `少了這一行：${line}\n${out}`);
    assert.match(out, /不同 2 個、只在套件 2 個、只在它那邊 2 個/u);
    assert.match(out, /少 2 個欄位、多 1 個；機器列少 1 列、多 1 列/u);
    assert.doesNotMatch(out, /README\.md|unfilled-settings\.json（/u, '共用路徑外的、內容一樣的都不列');
    assert.deepEqual(p.asked.filter(([op]) => op === 'repoFile').map(([, a]) => a.path), ['settings.json'], '沒有清單就不去讀它');
  } finally { clean(k); }
});

test('①裝了清單：用清單的版本、不用設定那一格；記的例外標在檔名後面；清單寫壞＝算不出來', () => {
  const k = kit();
  try {
    const lock = { repo: 'acme/kit', version: k.S1, syncedAt: '2026-10-01', entries: [], exceptions: [{ path: 'tools/b.js', why: '等不及套件', who: 'Alpha', since: '2026-10-02' }] };
    const r = run({ settings: settingsFor([project({ versionWithoutLock: k.V })]), platform: platformFor(k, theirs(k, { lock })), root: k.dir });
    assert.equal(r.code, 0, r.lines.join('\n'));
    const out = r.lines.join('\n');
    assert.match(out, new RegExp(`記的套件版本 ${k.S1.slice(0, 7)}，來源＝它的 kit-lock\\.json（同步日 2026-10-01）`, 'u'), out);
    assert.match(out, /落後 2 支（其中動到共用路徑 1 支）/u, out);
    assert.ok(r.lines.includes('    ・不同：tools/b.js（它改過：跟它記的那一版也不同；記了例外：Alpha，等不及套件）'), out);
    assert.ok(r.lines.includes('    ・不同：tools/a.js（它改過：跟它記的那一版也不同）'), '它記的是 S1（a2），它那邊是 a1＝它改過');

    for (const [what, bad] of [['不是 JSON', '{壞掉'], ['形狀不對', { ...lock, version: 'abc' }]]) {
      const b = run({ settings: settingsFor([project({ versionWithoutLock: k.V })]), platform: platformFor(k, theirs(k, { lock: bad })), root: k.dir });
      assert.equal(b.code, 2, `${what}：${b.lines.join('\n')}`);
      assert.match(b.lines.join('\n'), /下游甲（acme\/app 的 main）：算不出來——它的 kit-lock\.json/u, what);
    }
  } finally { clean(k); }
});

test('⑤算不出來一律退 2、說原因；好幾個使用專案時算得出來的照印', () => {
  const k = kit();
  try {
    const cases = [
      ['兩樣都沒有', project(), {}, /不知道它停在套件哪一版/u],
      ['版本碼本機沒有', project({ versionWithoutLock: 'f'.repeat(40) }), {}, /本機找不到/u],
      ['版本碼不在主幹上', project({ versionWithoutLock: k.SIDE }), {}, /不在套件主幹的歷史上/u],
      ['平台問不到它的檔案清單', project({ versionWithoutLock: k.V }), { fail: { repoTree: '連不上' } }, /算不出來——連不上/u],
    ];
    for (const [what, p, opts, why] of cases) {
      const r = run({ settings: settingsFor([p]), platform: platformFor(k, theirs(k), opts), root: k.dir });
      assert.equal(r.code, 2, `${what}：${r.lines.join('\n')}`);
      assert.match(r.lines.join('\n'), why, what);
    }
    const two = run({ settings: settingsFor([project(), project({ name: '下游乙', versionWithoutLock: k.V })]), platform: platformFor(k, theirs(k)), root: k.dir });
    assert.equal(two.code, 2, '有一個算不出來就退 2');
    assert.match(two.lines.join('\n'), /下游乙（acme\/app 的 main）：記的套件版本/u, '另一個照印');

    const noFetch = run({ settings: settingsFor([project({ versionWithoutLock: k.V })]), platform: platformFor(k, theirs(k), { head: 'e'.repeat(40) }), root: k.dir });
    assert.equal(noFetch.code, 2); assert.match(noFetch.lines.join('\n'), /本機沒有這一顆——先 git fetch/u);
    const noMain = run({ settings: settingsFor([project({ versionWithoutLock: k.V })], { mainBranch: '未設定' }), platform: platformFor(k, theirs(k)), root: k.dir });
    assert.equal(noMain.code, 2); assert.match(noMain.lines.join('\n'), /mainBranch 沒填/u);
    const headFail = run({ settings: settingsFor([project({ versionWithoutLock: k.V })]), platform: platformFor(k, theirs(k), { fail: { branchSha: '主幹問不到' } }), root: k.dir });
    assert.equal(headFail.code, 2); assert.match(headFail.lines.join('\n'), /主幹問不到/u);
  } finally { clean(k); }
});

test('⑤設定的 downstream：沒有這一塊或清單空的＝沒有登記、退 0；寫壞的＝退 2 不猜', () => {
  const none = { ask() { throw new Error('沒有登記就不該問平台'); } };
  for (const s of [{ mainBranch: 'main' }, settingsFor([])]) {
    const r = run({ settings: s, platform: none, root: os.tmpdir() });
    assert.equal(r.code, 0); assert.match(r.lines.join('\n'), /沒有登記任何使用專案/u);
  }
  for (const [what, d] of [
    ['不是物件', 'x'], ['projects 不是陣列', { projects: {} }], ['少 repo', { projects: [{ name: 'a', branch: 'main' }] }],
    ['repo 形狀不對', { projects: [{ name: 'a', repo: 'no-slash', branch: 'main' }] }], ['版本碼不是 40 碼', { projects: [{ name: 'a', repo: 'o/r', branch: 'main', versionWithoutLock: '0820c4d' }] }],
    ['repo 沒填', { projects: [{ name: 'a', repo: '未設定', branch: 'main' }] }],
  ]) {
    const r = run({ settings: { mainBranch: 'main', downstream: d }, platform: none, root: os.tmpdir() });
    assert.equal(r.code, 2, what);
  }
  assert.deepEqual(validateProject(projectsOf({ downstream: { projects: [{ name: 'a', repo: 'o/r', branch: 'main', versionWithoutLock: '未設定' }] } })[0], 0).fallback, undefined, '「未設定」當沒填');
  assert.deepEqual(keyPaths({ a: { b: [{ c: 1 }] }, d: 1 }), ['a', 'a.b', 'd'], '陣列不往裡看');
});

test('⑦一筆寫壞只那一筆退 2、其餘照算（壞的排前或排後都一樣）；全部寫壞＝不問平台', () => {
  const k = kit();
  try {
    const bad = project({ name: '壞的', repo: 'not-a-repo', versionWithoutLock: k.V });
    const good = project({ versionWithoutLock: k.V });
    for (const [what, list] of [['壞在前', [bad, good]], ['壞在後', [good, bad]]]) {
      const p = platformFor(k, theirs(k));
      const r = run({ settings: settingsFor(list), platform: p, root: k.dir });
      assert.equal(r.code, 2, what);
      const out = r.lines.join('\n');
      assert.match(out, /downstream\.projects\[\d\]：算不出來——downstream\.projects\[\d\]\.repo「not-a-repo」要是「帳號\/倉庫名」/u, what);
      assert.match(out, /下游甲（acme\/app 的 main）：記的套件版本 .{7}，來源＝設定裡人填的/u, `${what}：好的那一筆要照印`);
      assert.match(out, /落後 3 支（其中動到共用路徑 2 支）/u, what);
      assert.ok(p.asked.some(([op]) => op === 'repoTree'), `${what}：好的那一筆要真的去問平台`);
    }
    const none = { ask() { throw new Error('全部寫壞就不該問平台'); } };
    const allBad = run({ settings: settingsFor([bad, project({ name: 'x', branch: 'bad branch' })]), platform: none, root: k.dir });
    assert.equal(allBad.code, 2);
    assert.equal(allBad.lines.length, 2, allBad.lines.join('\n'));
  } finally { clean(k); }
});

test('⑧讀回的檔跟這次檔案清單裡的雜湊對不上＝那一個退 2 叫人重跑；對得上照算', () => {
  const k = kit();
  try {
    const files = theirs(k);
    const stale = platformFor(k, files);
    // 檔案清單照舊快照，但 settings.json 的內容已經是下游更新後的：兩個時點拼起來會誤報
    const inner = stale.ask;
    stale.ask = (op, args) => (op === 'repoFile' && args.path === 'settings.json' ? { content: JSON.stringify({ x: '改過了', machines: [] }) } : inner(op, args));
    const r = run({ settings: settingsFor([project({ versionWithoutLock: k.V })]), platform: stale, root: k.dir });
    assert.equal(r.code, 2, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /它的 settings\.json 讀到的內容跟這次檔案清單裡的雜湊對不上（清單 [0-9a-f]{7}、內容 [0-9a-f]{7}）：下游分支在兩次讀取之間更新了，重跑一次/u);
    assert.doesNotMatch(r.lines.join('\n'), /少的欄位/u, '對不上就不印拼出來的設定差異');
    const lock = { repo: 'acme/kit', version: k.S1, syncedAt: '2026-10-01', entries: [], exceptions: [] };
    const staleLock = platformFor(k, theirs(k, { lock }));
    const inner2 = staleLock.ask;
    staleLock.ask = (op, args) => (op === 'repoFile' && args.path === 'kit-lock.json' ? { content: JSON.stringify({ ...lock, syncedAt: '2026-10-02' }) } : inner2(op, args));
    const r2 = run({ settings: settingsFor([project()]), platform: staleLock, root: k.dir });
    assert.equal(r2.code, 2); assert.match(r2.lines.join('\n'), /它的 kit-lock\.json 讀到的內容跟這次檔案清單裡的雜湊對不上/u);
    const ok = run({ settings: settingsFor([project({ versionWithoutLock: k.V })]), platform: platformFor(k, files), root: k.dir });
    assert.equal(ok.code, 0, '對得上的對照組照算');
  } finally { clean(k); }
});

test('⑨使用者的 git 設定開了 log.showSignature、範圍裡有簽過章的提交：簽章診斷不算成支數、不混進逐支清單', () => {
  const k = kit();
  try {
    // 主幹頂端再加一顆帶 gpgsig 標頭的提交（假簽章；動到共用檔 tools/a.js），gpg 換成只會印診斷的假程式
    write(k.dir, { 'tools/a.js': 'a3\n' }); sh(k.dir, 'add', '-A');
    const tree = sh(k.dir, 'write-tree');
    const raw = `tree ${tree}\nparent ${k.H}\nauthor t <t@example.invalid> 1700000000 +0000\ncommitter t <t@example.invalid> 1700000000 +0000\n`
      + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n 假簽章\n -----END PGP SIGNATURE-----\n\n假簽過章的那一支\n';
    const signed = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: k.dir, env: gitEnv(), input: raw, encoding: 'utf8' }).stdout.trim();
    assert.match(signed, /^[0-9a-f]{40}$/u, '假簽章的提交要寫得進去');
    sh(k.dir, 'update-ref', 'refs/heads/main', signed);
    const fakeGpg = path.join(k.dir, 'fake-gpg');
    fs.writeFileSync(fakeGpg, '#!/bin/sh\necho "gpg: Signature made 假的" >&2\necho "gpg: Can\'t check signature: No public key" >&2\nexit 1\n', { mode: 0o755 });
    sh(k.dir, 'config', 'gpg.program', fakeGpg);
    sh(k.dir, 'config', 'log.showSignature', 'true');
    // 探針：這個設定下裸的 git log 真的會把診斷印進標準輸出（探針不對，這一題就量不到東西）
    const bare = spawnSync('git', ['log', '--format=%h %s', `${k.V}..main`], { cwd: k.dir, env: gitEnv(), encoding: 'utf8' }).stdout;
    assert.match(bare, /gpg: /u, '探針：裸的 git log 要被簽章診斷污染，不然這一題守不到東西');
    const r = run({ settings: settingsFor([project({ versionWithoutLock: k.V })]), platform: platformFor(k, theirs(k), { head: signed }), root: k.dir });
    assert.equal(r.code, 0, r.lines.join('\n'));
    const out = r.lines.join('\n');
    assert.match(out, /落後 4 支（其中動到共用路徑 3 支）/u, out);
    assert.match(out, /假簽過章的那一支/u, '簽過章的那一支本身要列');
    assert.doesNotMatch(out, /gpg/u, '簽章診斷不能混進支數或逐支清單');
  } finally { clean(k); }
});

test('⑩使用者的 git 設定把 i18n.logOutputEncoding 設成 ISO-8859-1：逐支清單的題名照原字印、不成亂碼', () => {
  const k = kit();
  try {
    // 題名用 ISO-8859-1 寫得出來的非 ASCII 字（é）：中文字那個編碼寫不出來，git 會原樣吐 UTF-8，驗不到東西
    write(k.dir, { 'tools/a.js': 'a3\n' }); sh(k.dir, 'add', '-A'); sh(k.dir, 'commit', '-q', '-m', 'café shared a');
    const head = sh(k.dir, 'rev-parse', 'HEAD');
    sh(k.dir, 'config', 'i18n.logOutputEncoding', 'ISO-8859-1');
    // 探針：這個設定下裸的 git log 真的把 é 吐成單一位元組（當 UTF-8 讀＝替代字元）
    const bare = spawnSync('git', ['log', '--format=%s', `${k.V}..main`], { cwd: k.dir, env: gitEnv(), encoding: 'utf8' }).stdout;
    assert.doesNotMatch(bare, /café/u, '探針：裸的 git log 要被輸出編碼設定改掉，不然這一題守不到東西');
    assert.match(bare, /caf\uFFFD/u, '探針：é 要變成替代字元');
    const r = run({ settings: settingsFor([project({ versionWithoutLock: k.V })]), platform: platformFor(k, theirs(k), { head }), root: k.dir });
    assert.equal(r.code, 0, r.lines.join('\n'));
    const out = r.lines.join('\n');
    assert.match(out, /落後 4 支（其中動到共用路徑 3 支）/u, out);
    assert.match(out, /café shared a/u, '題名要照原字印');
    assert.doesNotMatch(out, /\uFFFD/u, '不能有替代字元');
  } finally { clean(k); }
});

test('⑥指令入口：給了參數＝退 2；空白設定的複本裡跑＝退 0、沒有登記', () => {
  const withArg = runInCopy('tools/downstream-lag.js', ['--project', 'x']);
  assert.equal(withArg.status, 2, withArg.stdout);
  assert.match(withArg.stdout, /不收任何參數/u);
  const plain = runInCopy('tools/downstream-lag.js');
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /沒有登記任何使用專案/u);
});
