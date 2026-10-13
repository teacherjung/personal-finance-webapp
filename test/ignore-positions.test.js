// Git 沙盒從零只給 PATH 與本題 HOME；模板、外部 excludes 與 info/exclude 由本題控制。
// 大小寫匹配依 Git 設定；兩種試驗模式不改使用者的 Git 設定，也不代替 ESLint 糾察。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../lib/git-env.js';
import { createExclusiveTemp, readPins } from '../scripts/grok-bump.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODES = [false, true];
const DIRECTORIES = [
  { path: '.codex-reviews', pattern: '/.codex-reviews/', wrong: '.codex-reviews-other' },
  { path: 'tmp', pattern: '/tmp/', wrong: 'tmp-other' },
  { path: 'output', pattern: '/output/', wrong: 'output-other' },
  { path: 'test-doubles/_probe_fixture', tempPrefix: 'test-doubles/_probe_', pattern: '/test-doubles/_probe_*/', wrong: 'test-doubles/_probeX_fixture' },
  { path: 'test-doubles-evil-fixture', tempPrefix: 'test-doubles-evil-', pattern: '/test-doubles-evil-*/', wrong: 'test-doubles-evil_fixture' },
  { path: 'lib/_seam_probe_fixture', tempPrefix: 'lib/_seam_probe_', pattern: '/lib/_seam_probe_*/', wrong: 'lib/_seam_probeX_fixture' },
  { path: 'public/_seam_probe_fixture', tempPrefix: 'public/_seam_probe_', pattern: '/public/_seam_probe_*/', wrong: 'public/_seam_probeX_fixture' },
];
const TARGETS = [...new Set(Object.values(readPins(ROOT)).map((pin) => pin.file))].sort();
const HEX = '[0-9a-f]'.repeat(12);
const NONCE = 'abcdef123456';
const tempName = (target, nonce = NONCE) => `${target}.${nonce}.grok-bump-tmp`;
const tempPattern = (target) => `/${target}.${HEX}.grok-bump-tmp`;

function sandbox(t) {
  const scope = mkdtempSync(join(tmpdir(), 'ignore-positions-'));
  t.after(() => rmSync(scope, { recursive: true, force: true }));
  const root = join(scope, 'repo'), home = join(scope, 'home'), outside = join(scope, 'outside');
  mkdirSync(root); mkdirSync(home); mkdirSync(outside);
  const excludes = join(scope, 'excludes');
  writeFileSync(excludes, '');
  const git = (args, mode) => {
    const flags = ['-c', `core.excludesFile=${excludes}`];
    if (mode !== undefined) flags.push('-c', `core.ignoreCase=${mode}`);
    const result = spawnSync('git', [...flags, ...args], { cwd: root,
      env: gitEnv({ PATH: process.env.PATH, HOME: home }), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined, 'Git 必須實際啟動');
    assert.equal(result.signal, null, 'Git 查詢不可被終止');
    return result;
  };
  const init = git(['-c', 'init.templateDir=', 'init', '--quiet']);
  assert.equal(init.status, 0, init.stderr);
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
  writeFileSync(join(root, '.git', 'info', 'exclude'), '');
  const ignoreText = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  writeFileSync(join(root, '.gitignore'), ignoreText);
  const native = git(['config', '--bool', '--get', 'core.ignoreCase']);
  assert.ok(native.status === 0 || native.status === 1, `原生設定查詢失敗：${native.stderr}`);
  assert.match(native.stdout.trim(), native.status === 0 ? /^(true|false)$/ : /^$/);
  const nativeMode = native.status === 0 ? native.stdout.trim() === 'true' : false;
  const query = (path, mode) => {
    const result = git(['check-ignore', '--no-index', '--verbose', path], mode);
    assert.ok(result.status === 0 || result.status === 1, `Git 查詢失敗：${result.status} ${result.stderr}`);
    if (result.status === 1) {
      assert.equal(result.stdout.trim(), '', '未忽略的查詢不應有命中行');
      return { code: 1, pattern: null };
    }
    const match = result.stdout.trim().match(/^\.gitignore:(\d+):(.+)\t(.+)$/);
    assert.ok(match, `沒有真 .gitignore 命中行：${result.stdout}`);
    assert.equal(match[3], path, 'Git 回報的受測路徑必須對得上');
    assert.equal(match[2], ignoreText.split('\n')[Number(match[1]) - 1], '命中樣式必須來自實際忽略正本的該行');
    return { code: 0, pattern: match[2] };
  };
  const directory = (path) => mkdirSync(join(root, path), { recursive: true });
  const file = (path) => { directory(dirname(path)); writeFileSync(join(root, path), 'synthetic'); };
  return { root, home, scope, outside, git, query, directory, file, nativeMode };
}

function ignored(s, path, pattern, mode) {
  // 寬化要由錯位置／型別的反例抓，不能只因命中樣式換字就宣稱行為題有效。
  assert.equal(s.query(path, mode).code, 0, `合法位置應被忽略：${path}｜${pattern}｜${mode}`);
}
function visible(s, path, mode) {
  assert.deepEqual(s.query(path, mode), { code: 1, pattern: null }, `錯位置、深度、型別或格式必須可見：${path}｜${mode}`);
}

for (const row of DIRECTORIES) for (const mode of MODES) {
  test(`目錄位置｜${row.pattern}｜Git 大小寫=${mode}`, (t) => {
    const s = sandbox(t);
    let path = row.path;
    if (row.tempPrefix) {
      // 固定名正例認不出「萬用字元只剩固定名」；用探針的真正產名提供反例機會。
      s.directory(dirname(row.tempPrefix));
      path = relative(s.root, mkdtempSync(join(s.root, row.tempPrefix)));
    } else s.directory(path);
    s.file(`${path}/marker.js`);
    symlinkSync(s.outside, join(s.root, path, 'control-link'));
    for (const candidate of [path, `${path}/marker.js`, `${path}/control-link`]) ignored(s, candidate, row.pattern, mode);
    for (const wrong of [`nested/${path}`, row.wrong, `elsewhere/${basename(path)}`]) {
      s.directory(wrong); visible(s, wrong, mode);
    }
    if (dirname(path) !== '.') {
      const deeper = join(dirname(path), 'nested', basename(path));
      s.directory(deeper); visible(s, deeper, mode);
    }
    rmSync(join(s.root, path), { recursive: true, force: true });
    s.file(path); visible(s, path, mode);
    rmSync(join(s.root, path));
    symlinkSync(s.outside, join(s.root, path)); visible(s, path, mode);
  });
}

for (const target of TARGETS) for (const mode of MODES) {
  test(`升版產名｜${target}｜Git 大小寫=${mode}`, (t) => {
    assert.deepEqual(TARGETS, ['scripts/grok-scan.js', 'test/grok-scan-flow-preflight.test.js'], '正式升版目標變動時須核忽略位置');
    const s = sandbox(t);
    s.file(target);
    const temp = createExclusiveTemp(join(s.root, target));
    closeSync(temp.fd);
    const actual = relative(s.root, temp.path);
    assert.match(actual, /\.[0-9a-f]{12}\.grok-bump-tmp$/, '實際產名必須符合已核定格式');
    ignored(s, actual, tempPattern(target), mode);
    visible(s, target, mode);
    const singleInvalid = Array.from({ length: 12 }, (_, i) => tempName(target, `${NONCE.slice(0, i)}g${NONCE.slice(i + 1)}`));
    for (const wrong of [tempName(target, 'a'.repeat(11)), tempName(target, 'a'.repeat(13)), tempName(target, 'g'.repeat(12)), ...singleInvalid,
      `${target}.grok-bump-tmp`, `${tempName(target)}-other`, tempName(`${target}.other`),
      `nested/${tempName(target)}`, `elsewhere/${tempName(basename(target))}`]) {
      s.file(wrong); visible(s, wrong, mode);
    }
    // basename 樣式也匹配同名目錄與捷徑，不能把它宣稱為一般檔來源辨識。
    const directoryName = tempName(target, '111111111111');
    s.directory(directoryName); ignored(s, directoryName, tempPattern(target), mode);
    const linkName = tempName(target, '222222222222');
    symlinkSync(s.outside, join(s.root, linkName)); ignored(s, linkName, tempPattern(target), mode);
  });
}

test('大小寫劃界｜目錄、固定目標與尾碼按兩種模式及原生值核對', (t) => {
  const s = sandbox(t);
  const variants = [];
  for (const row of DIRECTORIES) { const path = row.path.toUpperCase(); s.directory(path); variants.push({ path, pattern: row.pattern }); }
  for (const target of TARGETS) for (const path of [tempName(target.toUpperCase()), tempName(target, 'ABCDEF123456'),
    tempName(target, 'AbCdEf123456'), tempName(target).replace('.grok-bump-tmp', '.GROK-BUMP-TMP')]) {
    s.file(path); variants.push({ path, pattern: tempPattern(target) });
  }
  for (const { path, pattern } of variants) {
    visible(s, path, false); ignored(s, path, pattern, true);
    if (s.nativeMode) ignored(s, path, pattern); else visible(s, path);
  }
});

test('既有保護｜node_modules 捷徑仍忽略，真實資料與憑證樣式保留', (t) => {
  const s = sandbox(t);
  symlinkSync(s.outside, join(s.root, 'node_modules'));
  for (const mode of MODES) {
    ignored(s, 'node_modules', 'node_modules', mode);
    for (const [path, pattern] of [['data/store.json', 'data/store.json'], ['data/store.db', 'data/*.db'],
      ['data/store.db-wal', 'data/*.db-wal'], ['data/store.db-shm', 'data/*.db-shm'],
      ['data/probe-backup.db', 'data/*backup*'], ['fixture.bak', '*.bak'], ['.env', '.env'], ['.env.local', '.env.local']]) {
      s.file(path); ignored(s, path, pattern, mode);
      assert.equal(s.query(path, mode).pattern, pattern, '既有機密樣式的命中不得被新規則替代');
    }
  }
});

test('查詢錯誤｜自有沙盒失去 Git 資料時，不能當作未忽略', (t) => {
  const s = sandbox(t);
  rmSync(join(s.root, '.git'), { recursive: true, force: true });
  assert.throws(() => s.query('ordinary.js', false), /Git 查詢失敗/);
});

test('Git 環境｜髒父環境仍量對位置，直接核父變數隔離', (t) => {
  const s = sandbox(t);
  s.directory('tmp'); s.directory('nested/tmp');
  const changes = { GIT_DIR: join(s.scope, 'wrong-repo'), GIT_FUTURE_PROBE: 'synthetic',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: join(s.scope, 'missing'),
    IGNORE_POS_ENV_SENTINEL: 'synthetic', PATH: process.env.PATH };
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, changes);
    ignored(s, 'tmp', '/tmp/', false); visible(s, 'nested/tmp', false);
    const bin = join(s.scope, 'bin'); mkdirSync(bin);
    const fake = join(bin, 'git');
    // 原生啟動可能產生系統變數；以獨立零環境對照辨識，不列名放寬父變數。
    // 只回報變數名與本題 HOME 的比對結果，不輸出父環境內任何值。
    writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ keys: Object.keys(process.env).sort(), homeMatches: process.env.HOME === ${JSON.stringify(s.home)} }));\n`);
    chmodSync(fake, 0o700);
    process.env.PATH = `${bin}:${saved.PATH}`;
    const control = spawnSync(process.execPath, [fake], { env: { PATH: process.env.PATH, HOME: s.home }, encoding: 'utf8' });
    assert.equal(control.status, 0, control.stderr);
    const received = s.git(['--spy'], false);
    assert.equal(received.status, 0, received.stderr);
    assert.deepEqual(JSON.parse(received.stdout), JSON.parse(control.stdout), 'Git 子行程須與獨立零環境對照一致');
    const seen = JSON.parse(received.stdout);
    assert.equal(seen.homeMatches, true, 'Git 子行程的 HOME 必須是本題沙盒');
    assert.deepEqual(seen.keys.filter((key) => key.startsWith('GIT_') || key === 'IGNORE_POS_ENV_SENTINEL'), [],
      'Git 子行程不可承襲本題種入的父變數');
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
