// 守檔名與文字檔內容控制字元（規矩 E6）：
// 1. 版本控制追蹤的每一個路徑，只用英文字母、數字、半形符號（例外名單只出不進，本倉庫是空的）。
// 2. 已追蹤的每一個文字檔（照副檔名判，不靠 git 自動判二進位，以免含空字元的原始碼被跳過），整檔逐字不放控制字元（C0/C1，\t、\n、\r 除外）。
//
// 為什麼：原專案的中文檔名讓掃描者跳過過整個檔（套件倉庫的案例簿 scanner-skipped-non-ascii-paths）；
// 路徑一有非 ASCII 或文字檔混入控制字元，工具鏈裡每一環都可能各自出錯。
// ⚠️ 守不到的：未追蹤的檔；名字對不對得起內容。列檔走清過 GIT_ 的環境（規矩 E4）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');
const settingsData = require('../tools/settings-data.js');
const { customBinaryExtensions } = require('../tools/build-settings.js');

const ROOT = path.join(__dirname, '..');
const BINEXT_DEPTH = Number(process.env.KIT_BINARY_EXT_DEPTH || '0');
/** 既有的路徑例外，只出不進（本倉庫沒有）。 */
const FROZEN_EXCEPTIONS = [];
/** 預設二進位副檔名允許清單（規矩 E6、E7；若 settings.json 另設 binaryExtensions 陣列則聯集併入）。 */
const DEFAULT_BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.zip', '.gz'];
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;

function binaryExtensions(readFn = settingsData.read) {
  const s = readFn();
  const custom = customBinaryExtensions(s);
  return [...new Set([...DEFAULT_BINARY_EXTENSIONS, ...custom])];
}

function trackedFiles() {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', env: gitEnv() });
  assert.equal(r.status, 0, `列不出追蹤的檔：${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

/** 整檔逐字找第一個控制字元（C0 0x00–0x1F 除 \t \n \r 外，及 C1 0x7F–0x9F）；不用控制字元正規式以免自身觸發 no-control-regex。 */
function findControlChar(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      return { index: i, code };
    }
  }
  return null;
}

function scanControlChars({ files, extraFiles = [], readFn = settingsData.read, binaryExts = binaryExtensions(readFn), transform = (_f, text) => text } = {}) {
  const baseFiles = Array.isArray(files)
    ? files.map((item) => ({ name: item.name, read: item.read || (() => item.content) }))
    : trackedFiles().map((f) => ({ name: f, read: () => fs.readFileSync(path.join(ROOT, f), 'utf8') }));
  const all = [
    ...baseFiles,
    ...extraFiles.map((item) => ({ name: item.name, read: () => item.content })),
  ];
  const textFiles = all.filter((item) => !binaryExts.some((ext) => item.name.toLowerCase().endsWith(ext)));
  const bad = [];
  for (const item of textFiles) {
    const text = transform(item.name, item.read());
    const hit = findControlChar(text);
    if (hit) bad.push(`${item.name}（位置 ${hit.index}，U+${hit.code.toString(16).toUpperCase().padStart(4, '0')}）`);
  }
  return { count: textFiles.length, bad };
}

test('已追蹤的每一個路徑只用英文字母、數字、半形符號（例外名單只出不進）', () => {
  const files = trackedFiles();
  assert.ok(files.length > 20, `只列到 ${files.length} 個檔：這一題自己的前提變了`);
  const bad = files.filter((f) => !VISIBLE_ASCII.test(f) && !FROZEN_EXCEPTIONS.includes(f));
  assert.deepEqual(bad, [], `這些路徑含非 ASCII 或空白：\n${bad.join('\n')}`);
  for (const f of FROZEN_EXCEPTIONS) assert.ok(files.includes(f), `例外名單裡的 ${f} 已經不在了：把它從名單拿掉（只出不進）`);
});

test('已追蹤的每一個文字檔整檔不放控制字元（規矩 E6；含二進位副檔名排除與長檔尾端誘餌核對）', () => {
  const clean = scanControlChars();
  assert.ok(clean.count >= 40, `只掃到 ${clean.count} 個文字檔：前提變了`);
  assert.deepEqual(clean.bad, [], `這些文字檔含控制字元：\n${clean.bad.join('\n')}`);

  // 隔離檔案集合核對二進位副檔名允許清單：預設排除 .png、未設定時擋 .bmp、設定 binaryExtensions: ['.bmp'] 時同時排除 .png 與 .bmp（#121 r1〜r3 R1）
  const isolatedBoth = [
    { name: 'assets/review-probe.png', content: '\x89PNG\r\n\x1a\n' },
    { name: 'assets/custom.bmp', content: 'BM\u0000\u0000' },
    { name: 'docs/clean.txt', content: 'clean text\n' },
  ];
  const defaultOnly = scanControlChars({
    files: isolatedBoth,
    readFn: () => ({}),
  });
  assert.deepEqual(defaultOnly.bad, ['assets/custom.bmp（位置 2，U+0000）'], '預設清單排除 .png，但未登記的 .bmp 應被攔截');

  const withCustomReadFn = scanControlChars({
    files: isolatedBoth,
    readFn: () => ({ binaryExtensions: ['.bmp'] }),
  });
  assert.deepEqual(withCustomReadFn.bad, [], '自訂 binaryExtensions（.bmp）與預設 .png 聯集後兩者皆應排除');
  assert.throws(
    () => scanControlChars({ files: isolatedBoth, readFn: () => ({ binaryExtensions: ['bmp'] }) }),
    /二進位副檔名設定（binaryExtensions\[0\]）/u,
  );

  // 接線與長檔尾端誘餌：將已追蹤文字檔在超過 16 KiB 後附加空字元，掃描迴圈必須抓出檔名、精確位置與字碼
  const realSelf = fs.readFileSync(__filename, 'utf8');
  const decoy = scanControlChars({
    transform: (f, raw) => (f === 'tests/file-names.test.js' ? `${raw}${'x'.repeat(16384)}\u0000` : raw),
  });
  assert.deepEqual(decoy.bad, [`tests/file-names.test.js（位置 ${realSelf.length + 16384}，U+0000）`]);

  // 判準本身：整檔逐字看（超過 16 KiB 之後才出現的空字元與控制字元也要抓到），\t \n \r 放行
  const prefix = `${'正常文字\t\n\r'.repeat(4000)}`;
  assert.equal(findControlChar(prefix), null);
  for (const [ch, code] of [['\u0000', 0x00], ['\u0007', 0x07], ['\u001b', 0x1b], ['\u007f', 0x7f], ['\u0085', 0x85]]) {
    const hit = findControlChar(prefix + ch);
    assert.deepEqual(hit, { index: prefix.length, code });
  }
});

test('在副本實際寫入 settings.json 的 binaryExtensions，同時執行檔名與設定考題皆通過（含預設 PNG、自訂 BMP、文字 NUL 拒絕與壞形狀攔截對照）', () => {
  if (BINEXT_DEPTH >= 2) return;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-binext-'));
  try {
    const copy = path.join(scratch, 'repo');
    fs.mkdirSync(copy, { recursive: true });
    for (const rel of trackedFiles()) {
      if (rel === 'assets/probe.png' || rel === 'assets/custom.bmp' || rel.toLowerCase().endsWith('.bmp')) continue;
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(copy, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    const baseEnv = gitEnv();
    delete baseEnv.NODE_TEST_CONTEXT;
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: copy, encoding: 'utf8', env: baseEnv });
      assert.equal(r.status, 0, `git ${args.join(' ')} 失敗：${r.stderr}`);
    };
    git('init', '-q');
    fs.mkdirSync(path.join(copy, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'assets', 'probe.png'), '\x89PNG\r\n\x1a\n\u0000', 'utf8');
    fs.writeFileSync(path.join(copy, 'assets', 'custom.bmp'), 'BM\u0000\u0000', 'utf8');
    git('add', '-A');

    const settingsPath = path.join(copy, 'settings.json');
    const origSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const existingExts = customBinaryExtensions(origSettings).filter((ext) => ext !== '.bmp');
    const settingsWithoutBmp = { ...origSettings };
    if (existingExts.length > 0) settingsWithoutBmp.binaryExtensions = existingExts;
    else delete settingsWithoutBmp.binaryExtensions;

    const runInCopy = (depth, ...testFiles) => spawnSync(
      process.execPath,
      ['--test', ...testFiles],
      { cwd: copy, encoding: 'utf8', env: { ...baseEnv, KIT_BINARY_EXT_DEPTH: String(depth) } },
    );

    // 1. 明確建立未設定 .bmp 的狀態：預設排除 .png，但 .bmp 被當文字檔抓出 NUL
    fs.writeFileSync(settingsPath, `${JSON.stringify(settingsWithoutBmp, null, 2)}\n`, 'utf8');
    const withoutSetting = runInCopy(2, 'tests/file-names.test.js');
    assert.notEqual(withoutSetting.status, 0, '未設定 .bmp 時，含 NUL 的 .bmp 必須被攔截');
    assert.match(`${withoutSetting.stdout}\n${withoutSetting.stderr}`, /assets\/custom\.bmp（位置 2，U\+0000）/u);
    assert.doesNotMatch(`${withoutSetting.stdout}\n${withoutSetting.stderr}`, /assets\/probe\.png/u);

    // 2. 實際寫入 settings.json 加入 ".bmp"：以 depth=1 同時跑掃檔與設定考題（含在外層已登記 .bmp 下實跑本整合題本身）皆全過
    const settingsWithBmp = { ...origSettings, binaryExtensions: [...existingExts, '.bmp'] };
    fs.writeFileSync(settingsPath, `${JSON.stringify(settingsWithBmp, null, 2)}\n`, 'utf8');
    const withCustom = runInCopy(BINEXT_DEPTH + 1, 'tests/file-names.test.js', 'tests/settings.test.js');
    assert.equal(withCustom.status, 0, `設定 binaryExtensions 含 .bmp 後兩支考題（含本整合題自身）應同時通過：\n${withCustom.stdout}\n${withCustom.stderr}`);

    // 3. 文字檔含 NUL 對照：即使設定了 binaryExtensions 含 .bmp，一般文字檔含 NUL 仍被攔截
    fs.mkdirSync(path.join(copy, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'docs', 'bad.txt'), 'clean\u0000bad\n', 'utf8');
    git('add', 'docs/bad.txt');
    const withBadText = runInCopy(2, 'tests/file-names.test.js');
    assert.notEqual(withBadText.status, 0, '文字檔含 NUL 必須被攔截');
    assert.match(`${withBadText.stdout}\n${withBadText.stderr}`, /docs\/bad\.txt（位置 5，U\+0000）/u);
    assert.doesNotMatch(`${withBadText.stdout}\n${withBadText.stderr}`, /assets\/(?:probe\.png|custom\.bmp)/u);
    git('rm', '-f', '-q', 'docs/bad.txt');

    // 4. 壞形狀對照：未以 . 開頭的 binaryExtensions 在掃檔與設定考題皆被拒絕
    fs.writeFileSync(settingsPath, `${JSON.stringify({ ...origSettings, binaryExtensions: ['bmp'] }, null, 2)}\n`, 'utf8');
    for (const tf of ['tests/file-names.test.js', 'tests/settings.test.js']) {
      const badShape = runInCopy(2, tf);
      assert.notEqual(badShape.status, 0, `${tf} 應拒絕壞形狀的 binaryExtensions`);
      assert.match(`${badShape.stdout}\n${badShape.stderr}`, /二進位副檔名設定（binaryExtensions\[0\]）/u);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
