// @ts-check
// `scripts/grok-bump.js` 考題：升版助手。
// 它動的是**釘住第三方執行檔的那兩個常數**，所以這裡守的第一件事不是「方不方便」，
// 而是「它有沒有在任何情況下放行一支不該放行的執行檔」「它從不執行那支執行檔」，
// 以及（#636 r1 #1）「它有沒有把第三方給的字串寫成我們自己的程式」。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EXPECTED_GROK_SHA256, EXPECTED_GROK_VERSION } from '../scripts/grok-scan.js';
import { REQUIRED_TOKENS, SAFE_DATE, SAFE_FOR_SOURCE, bump, countBytes, createExclusiveTemp, jsSyntaxErrors, readPins } from '../scripts/grok-bump.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** @type {string[]} */ const roots = [];
after(() => { for (const d of roots) { try { chmodSync(d, 0o755); } catch { /* 沒事 */ } try { rmSync(d, { recursive: true, force: true }); } catch { /* 已清 */ } } });
const keep = (/** @type {string} */ d) => { roots.push(d); return d; };

const sha = (/** @type {Buffer|string} */ b) => createHash('sha256').update(b).digest('hex');

/**
 * ⚠️ 這份清單**刻意手抄一次**，不從受測程式 import（#636 r1 #3）：
 * 原本夾具與斷言都迭代 `REQUIRED_TOKENS`，於是「正式清單刪掉一項」時考題跟著少考一項、11 題照樣全綠。
 * 出題的人與作答的人要是同一份資料，那張考卷就問不出東西。
 */
const EXPECTED_TOKENS = Object.freeze([
  'GROK_CLI_CHAT_PROXY_BASE_URL',
  'cli-chat-proxy.grok.com',
  '--disable-web-search',
  '--no-subagents',
  '--always-approve',
]);

/** 假的 ~/.grok：version.json＋bin/grok（捷徑）＋downloads/<檔>。內容是我們自己組的位元組，不是真執行檔。 */
function fakeGrokHome(/** @type {{ version: string, body: string, binName?: string, binOutsideDownloads?: boolean, alsoKeep?: { name: string, body: string }[] }} */ o) {
  const d = keep(mkdtempSync(join(tmpdir(), 'fake-grok-home-')));
  mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'downloads'));
  writeFileSync(join(d, 'version.json'), JSON.stringify({ version: o.version }));
  const name = o.binName ?? `grok-${o.version}-macos-aarch64`;
  // 預設跟真機一樣放 downloads；binOutsideDownloads＝放到別處，這樣才做得出
  // 「執行檔讀得到、但 downloads 列不了」這個情形（否則 realpath 自己就先失敗，考題會因為別的理由變綠）。
  const dir = o.binOutsideDownloads ? join(d, 'bin') : join(d, 'downloads');
  const real = join(dir, name);
  writeFileSync(real, o.body); chmodSync(real, 0o755);
  symlinkSync(o.binOutsideDownloads ? name : join('..', 'downloads', name), join(d, 'bin', 'grok'));
  for (const k of o.alsoKeep ?? []) { const p = join(d, 'downloads', k.name); writeFileSync(p, k.body); chmodSync(p, 0o755); }
  return d;
}

/** 假的 repo：只放本檔會改到的那兩個檔，內容是真檔的那兩行形狀。 */
function fakeRepo(/** @type {{ version: string, sha256: string }} */ o) {
  const d = keep(mkdtempSync(join(tmpdir(), 'fake-bump-repo-')));
  mkdirSync(join(d, 'scripts')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ type: 'module' }));   // 讓假 fixture 真的跑得起來
  writeFileSync(join(d, 'scripts', 'grok-scan.js'),
    `// 前面還有別的\nexport const EXPECTED_GROK_VERSION = '${o.version}';\n/** 註解 */\nexport const EXPECTED_GROK_SHA256 = '${o.sha256}';\nexport {};\n`);
  writeFileSync(join(d, 'test', 'grok-scan-flow-preflight.test.js'),
    `  assert.equal(EXPECTED_GROK_VERSION, '${o.version}', 'grok CLI ${o.version}（舊的說明）');\n  assert.equal(EXPECTED_GROK_SHA256, '${o.sha256}', 'grok-${o.version}-macos-aarch64 的 sha256');\n`);
  return d;
}

const SCAN = ['scripts', 'grok-scan.js'], PRE = ['test', 'grok-scan-flow-preflight.test.js'];
/**
 * 兩個目標檔的完整內容。「不改檔」一律用它整份比對——
 * #636 r1 #4：原本只檢查「scan 裡還有舊版號」或「只比對 fixture」，另一個檔被寫成 CORRUPTED 也全綠。
 */
// ⚠️ **比位元組，不比字串**（#636 r5 #1）：`readFileSync(…,'utf8')` 會把不合法的 UTF-8 位元組
//    換成 U+FFFD，所以字串比對分不出 `FF` 與寫回去的 `EF BF BD`——保存型斷言會漏掉那種改寫。
const snapshot = (/** @type {string} */ repo) => ({
  scan: readFileSync(join(repo, ...SCAN)).toString('base64'),
  preflight: readFileSync(join(repo, ...PRE)).toString('base64'),
});
/** 需要讀內容時才解碼（那幾題的夾具本來就是合法 UTF-8）。 */
const 讀 = (/** @type {string} */ repo, /** @type {string[]} */ rel) => readFileSync(join(repo, ...rel), 'utf8');

/** 一段「像執行檔」的位元組：必要字串各出現指定次數。用**手抄的**清單組，不用受測程式的。 */
function body(/** @type {{ skip?: string, filler?: string, dup?: string }} */ o = {}) {
  let s = (o.filler ?? 'FILLER') + '\n';
  for (const token of EXPECTED_TOKENS) {
    if (token === o.skip) continue;
    s += `..${token}..\n`;
    if (token === o.dup) s += `..${token}..\n`;   // 同一個字串出現兩次＝次數變了
  }
  return s;
}

test('必要字串清單｜正式清單就是手抄的那五個，一個不多一個不少（清單縮水＝考題跟著縮水的解藥）', async () => {
  assert.deepEqual([...REQUIRED_TOKENS.map((t) => t.token)].sort(), [...EXPECTED_TOKENS].sort());
  for (const { why } of REQUIRED_TOKENS) assert.ok(why && why.length > 4, '每一項都要寫清楚為什麼非有不可');
});

test('bump｜磁碟上就是釘著的那一版 → 0、兩個檔一個字都不動', async () => {
  const b = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
  const before = snapshot(repo);
  const r = await bump({ grokHome: fakeGrokHome({ version: '1.2.3', body: b }), repo, write: true });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /已經釘在這一版/);
  assert.deepEqual(snapshot(repo), before, '不必升版時不可以動任何一個檔');
});

test('bump｜同一支執行檔被標成別的版本號 → 2（不猜、不改）', async () => {
  const b = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
  const before = snapshot(repo);
  const r = await bump({ grokHome: fakeGrokHome({ version: '9.9.9', body: b }), repo, write: true });
  assert.equal(r.code, 2, r.lines.join('\n'));
  assert.deepEqual(snapshot(repo), before, '退 2 時不可以動任何一個檔');
});

test('bump｜常數與考題 fixture 一開始就對不上 → 2、不動檔', async () => {
  const b = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
  const p = join(repo, ...PRE);
  writeFileSync(p, readFileSync(p, 'utf8').replace("'1.2.3', 'grok CLI", "'9.9.9', 'grok CLI"));
  const before = snapshot(repo);
  const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true });
  assert.equal(r.code, 2, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /先把它們弄一致再升版/);
  assert.deepEqual(snapshot(repo), before);
});

test('bump｜有新版、必要字串都在 → 1（只印報告，兩個檔一個字都不動）', async () => {
  const oldB = body(), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const before = snapshot(repo);
  const home = fakeGrokHome({ version: '1.3.0', body: newB, alsoKeep: [{ name: 'grok-1.2.3-macos-aarch64', body: oldB }] });
  const r = await bump({ grokHome: home, repo });
  assert.equal(r.code, 1, r.lines.join('\n'));
  const out = r.lines.join('\n');
  for (const token of EXPECTED_TOKENS) assert.ok(out.includes(token), `報告少了 ${token}`);
  assert.match(out, /用雜湊認出來的/, '舊版在磁碟上時要做新舊對照');
  assert.deepEqual(snapshot(repo), before, '沒帶 --write 不可以動任何一個檔');
});

// #636 r1 #5：原本「沒涵蓋的那一段每次都印」只考了 dry-run 那一條路，
// 於是「只有 !write 時才印」這發突變照樣全綠。三條**判定入口**各考一次。
for (const [名稱, 造] of /** @type {[string, (repo: string, home: string) => Promise<{ code: number, lines: string[] }>][]} */ ([
  ['dry-run（退 1）', (repo, home) => bump({ grokHome: home, repo })],
  ['--write（退 0）', (repo, home) => bump({ grokHome: home, repo, write: true })],
])) {
  test(`bump｜「ALLOWED_REQUESTS 沒被涵蓋」在 ${名稱} 這條路也要印`, async () => {
    const oldB = body(), newB = body({ filler: 'NEWER' });
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
    const r = await 造(repo, fakeGrokHome({ version: '1.3.0', body: newB }));
    assert.match(r.lines.join('\n'), /沒驗到的：grok-relay\.js 的 ALLOWED_REQUESTS/, `${名稱} 這條路沒印`);
    // r3 #4：這一行原本寫「打出表外＝403＋退 2」，漏了 #635 加的容許清單例外
    assert.match(r.lines.join('\n'), /除非那個形狀在 TOLERATED_REFUSALS 容許清單上/, '報告漏掉容許清單那個例外');
  });
}

// #636 r1 #3：逐項缺字串都要擋，不是只考一項。
for (const token of EXPECTED_TOKENS) {
  test(`bump｜少了「${token}」→ 2，而且兩個檔一個字都不寫`, async () => {
    const oldB = body();
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
    const before = snapshot(repo);
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ skip: token, filler: 'NEWER' }) }), repo, write: true });
    assert.equal(r.code, 2, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /不可升版/);
    assert.match(r.lines.join('\n'), /沒驗到的：grok-relay\.js 的 ALLOWED_REQUESTS/, '擋下來的那條路也要印沒涵蓋的那一塊');
    assert.deepEqual(snapshot(repo), before);
  });
}

test('bump --write｜兩個檔都改到，改完再跑一次就是 0（來回對得上）', async () => {
  const oldB = body(), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const home = fakeGrokHome({ version: '1.3.0', body: newB });
  const r = await bump({ grokHome: home, repo, write: true, today: '2026-01-02' });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /沒有新舊對照/, '磁碟上認不出舊版時，報告要明說只驗了一半');
  const scan = readFileSync(join(repo, ...SCAN), 'utf8');
  const tst = readFileSync(join(repo, ...PRE), 'utf8');
  assert.match(scan, new RegExp(`EXPECTED_GROK_VERSION = '1\\.3\\.0'`));
  assert.match(scan, new RegExp(`EXPECTED_GROK_SHA256 = '${sha(newB)}'`));
  assert.match(tst, /EXPECTED_GROK_VERSION, '1\.3\.0', 'grok CLI 1\.3\.0（2026-01-02 重驗轉送器目的地後升的）'/);
  assert.match(tst, /grok-1\.3\.0-macos-aarch64 的 sha256/);
  assert.ok(!scan.includes('1.2.3') && !tst.includes('1.2.3'), '舊版號不可以留在任何一個檔裡');
  assert.equal((await bump({ grokHome: home, repo })).code, 0, '改完再跑一次應該說「已經釘在這一版」');
});

test('bump --write｜認得出舊版時，「沒有新舊對照」那句**不可以**印（對照組：證明上一題不是恆真）', async () => {
  const oldB = body(), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const home = fakeGrokHome({ version: '1.3.0', body: newB, alsoKeep: [{ name: 'x-old', body: oldB }] });
  const r = await bump({ grokHome: home, repo, write: true });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.ok(!r.lines.join('\n').includes('沒有新舊對照'));
});

// #636 r1 #5：記號檔考題原本只走 write:true，「只有 !write 時才執行」那發突變全綠。兩條路各考一次。
for (const write of [false, true]) {
  test(`bump｜**從不執行那支執行檔**（${write ? '--write' : 'dry-run'}；行為證據：可執行、跑起來就留記號）`, async () => {
    const marker = join(keep(mkdtempSync(join(tmpdir(), 'fake-bump-marker-'))), 'RAN');
    // 這支若被執行，會在 marker 落一個檔。必要字串照樣寫在裡面，讓它走完整條重驗路徑。
    const evil = `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n` + body();
    const oldB = body({ filler: 'OLD' });
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: evil }), repo, write });
    assert.equal(r.code, write ? 0 : 1, r.lines.join('\n'));
    assert.ok(!existsSync(marker), '升版助手執行了那支還沒驗過的執行檔——這正是釘 sha256 要防的事');
  });
}

test('bump｜舊版執行檔用**雜湊**認出來，不是靠檔名（對照組：慣例檔名底下放的是別的位元組）', async () => {
  const oldB = body({ filler: 'OLD' }), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  // downloads 裡兩個檔：**慣例檔名**那個是誘餌（位元組不是釘著的那一版），真的那一版叫一個沒版本號的名字。
  // 靠檔名認＝挑到誘餌；靠雜湊認＝挑到 no-version-in-the-name。
  const home = fakeGrokHome({ version: '1.3.0', body: newB, alsoKeep: [
    { name: 'grok-1.2.3-macos-aarch64', body: body({ filler: 'DECOY' }) },
    { name: 'no-version-in-the-name', body: oldB },
  ] });
  const out = (await bump({ grokHome: home, repo })).lines.join('\n');
  assert.match(out, /舊版執行檔＝no-version-in-the-name/, '要靠雜湊認出沒版本號的那一個');
  assert.ok(!out.includes('舊版執行檔＝grok-1.2.3-macos-aarch64'), '靠檔名就會挑到誘餌');
});

test('bump｜必要字串的**次數**變了 → 標 ⚠️ 但不擋（判定是「在不在」，不是「幾次」）', async () => {
  const oldB = body({ filler: 'OLD' }), newB = body({ filler: 'NEWER', dup: '--always-approve' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const home = fakeGrokHome({ version: '1.3.0', body: newB, alsoKeep: [{ name: 'x-old', body: oldB }] });
  const r = await bump({ grokHome: home, repo });
  assert.equal(r.code, 1, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /⚠️ --always-approve：舊 1 → 新 2/, '次數差要印出來讓人看一眼');
});

// ——— #636 r1 #1：第三方給的字串不可以變成我們自己的程式 ———

test('SAFE_FOR_SOURCE｜字元集裡沒有任何能提早收掉字串或起一段程式的字', async () => {
  for (const c of ['\'', '"', '`', '\\', '(', ')', ';', ' ', '\n', '\r', '$', '{', '}', '/', '*']) {
    assert.ok(!SAFE_FOR_SOURCE.test('a' + c + 'b'), `「${JSON.stringify(c)}」不該被放行`);
  }
  for (const ok of ['grok-1.0.40-macos-aarch64', 'a', 'A.B_c-9']) assert.ok(SAFE_FOR_SOURCE.test(ok), ok);
  assert.ok(!SAFE_FOR_SOURCE.test(''), '空字串不算合法檔名');
  assert.ok(!SAFE_FOR_SOURCE.test('a'.repeat(121)), '長到離譜也擋');
});

for (const [名稱, 檔名] of [
  ['夾帶一段程式', `grok'); writeFileSync(process.env.PR636_MARKER, 'x'); ('tail`],
  ['只夾一個單引號', `grok'1.3.0`],
  ['夾換行', 'grok\n1.3.0'],
  ['夾反斜線', 'grok\\x27'],
]) {
  test(`bump --write｜執行檔名${名稱} → 2，而且兩個檔一個字都不寫（關門，不是去跳脫）`, async () => {
    const oldB = body(), newB = body({ filler: 'NEWER' });
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
    const before = snapshot(repo);
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB, binName: 檔名 }), repo, write: true });
    assert.equal(r.code, 2, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /不准寫進原始碼的字元/);
    assert.deepEqual(snapshot(repo), before);
  });
}

/** 真的用解析器驗語法（不是數危險字樣——審查者 r2 #4：在夾具尾巴加一個 `@`，舊版照樣全綠）。 */
function 語法錯誤數(/** @type {string} */ src) {
  const sf = ts.createSourceFile('x.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return (/** @type {{ parseDiagnostics?: unknown[] }} */ (/** @type {unknown} */ (sf)).parseDiagnostics ?? []).length;
}
/** 整份檔案裡的呼叫節點，用語法樹數（不是數字串）。 */
function 呼叫清單(/** @type {string} */ src) {
  const sf = ts.createSourceFile('x.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {ts.Node} */ n) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) out.push(n.expression.getText(sf));
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

test('語法檢查器｜它自己抓得到錯（對照組：不先證明這件事，下面那題就是空包彈）', async () => {
  assert.equal(語法錯誤數(`  assert.equal(A, 'x', 'y');\n`), 0);
  assert.ok(語法錯誤數(`  assert.equal(A, 'x', 'y')@;\n`) > 0, '尾巴加 @ 要抓得到——這正是 r2 #4 的反例');
  assert.ok(語法錯誤數(`  assert.equal(A, 'x', 'y'\n`) > 0, '括號沒收也要抓得到');
  assert.deepEqual(呼叫清單(`a.b(1); new C(); d();`), ['a.b', 'C', 'd']);
});

test('bump --write｜寫出來的考題檔**語法合法**，而且呼叫節點就只有原本那兩個', async () => {
  const oldB = body(), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  assert.equal((await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB }), repo, write: true, today: '2026-01-02' })).code, 0);
  const tst = readFileSync(join(repo, ...PRE), 'utf8');
  assert.equal(語法錯誤數(tst), 0, '寫出來的檔必須還是合法 JS');
  assert.deepEqual(呼叫清單(tst), ['assert.equal', 'assert.equal'], '不可以多出任何一個呼叫節點');
  assert.equal(tst.trim().split('\n').length, 2, '行數不該變');
  assert.equal(語法錯誤數(readFileSync(join(repo, ...SCAN), 'utf8')), 0, '另一個檔也要還是合法 JS');
});

test('格式｜拿**真的**那兩個檔跑一次 --write：只有那四處變，而且變成的形狀與現況同構', async () => {
  const d = keep(mkdtempSync(join(tmpdir(), 'fake-bump-realcopy-')));
  mkdirSync(join(d, 'scripts')); mkdirSync(join(d, 'test'));
  for (const rel of [SCAN, PRE]) copyFileSync(join(ROOT, ...rel), join(d, ...rel));
  const before = snapshot(d);
  const 讀2 = (/** @type {string} */ b64) => Buffer.from(b64, 'base64').toString('utf8');
  const newB = body({ filler: 'NEWER' });
  const r = await bump({ grokHome: fakeGrokHome({ version: '9.9.9', body: newB }), repo: d, write: true, today: '2026-01-02' });
  assert.equal(r.code, 0, r.lines.join('\n'));
  const after = snapshot(d);

  /** 兩份的行數要一樣，而且只有指定那幾行不同。 */
  const changed = (/** @type {string} */ a, /** @type {string} */ b) => {
    const A = a.split('\n'), B = b.split('\n');
    assert.equal(A.length, B.length, '行數不該變');
    return A.map((l, i) => [i, l, B[i]]).filter(([, x, y]) => x !== y);
  };
  const scanDiff = changed(讀2(before.scan), 讀2(after.scan));
  assert.equal(scanDiff.length, 2, `grok-scan.js 應該只有兩行變：${JSON.stringify(scanDiff)}`);
  assert.deepEqual(scanDiff.map(([, , y]) => y), [
    `export const EXPECTED_GROK_VERSION = '9.9.9';`,
    `export const EXPECTED_GROK_SHA256 = '${sha(newB)}';`,
  ]);
  const preDiff = changed(讀2(before.preflight), 讀2(after.preflight));
  assert.equal(preDiff.length, 2, `preflight 應該只有兩行變：${JSON.stringify(preDiff)}`);
  // 與 #634 手寫的現況同構：值換掉、說明句的模板一字不差
  assert.match(String(preDiff[0][2]), /^ {2}assert\.equal\(EXPECTED_GROK_VERSION, '9\.9\.9', 'grok CLI 9\.9\.9（2026-01-02 重驗轉送器目的地後升的）'\);$/);
  assert.match(String(preDiff[1][2]), new RegExp(`^ {2}assert\\.equal\\(EXPECTED_GROK_SHA256, '${sha(newB)}', 'grok-9\\.9\\.9-macos-aarch64 的 sha256'\\);$`));
});

// ——— #636 r1 #2：定位要找**有效程式碼**，不可以認到註解 ———

test('釘值定位｜註解掉的舊宣告不算數，真正生效的（即使換成雙引號）才算', async () => {
  const oldB = body(), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const p = join(repo, ...SCAN);
  // 審查者的重現：真常數改成雙引號，舊的單引號宣告留成 `//` 註解。
  writeFileSync(p, readFileSync(p, 'utf8')
    .replace(`export const EXPECTED_GROK_VERSION = '1.2.3';`,
      `// export const EXPECTED_GROK_VERSION = '0.0.0';\nexport const EXPECTED_GROK_VERSION = "1.2.3";`));
  assert.equal(readPins(repo).version.value, '1.2.3', '要讀到生效的那一個，不是註解裡的 0.0.0');
  assert.equal((await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB }), repo, write: true })).code, 0);
  const after = readFileSync(p, 'utf8');
  assert.match(after, /^export const EXPECTED_GROK_VERSION = '1\.3\.0';$/m, '要改到生效的那一行');
  assert.match(after, /\/\/ export const EXPECTED_GROK_VERSION = '0\.0\.0';/, '註解不該被動到');
});

test('釘值定位｜有效宣告不只一個 → 炸（不敢猜要改哪一個）', async () => {
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(body()) });
  const p = join(repo, ...SCAN);
  writeFileSync(p, readFileSync(p, 'utf8') + `export const EXPECTED_GROK_VERSION = '9.9.9';\n`);
  assert.throws(() => readPins(repo), /有 2 個/);
});

test('釘值定位｜形狀不是「直接指定一個字串字面值」→ 炸，不硬改', async () => {
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(body()) });
  const p = join(repo, ...SCAN);
  writeFileSync(p, readFileSync(p, 'utf8').replace(`= '1.2.3';`, `= '1.2' + '.3';`));
  assert.throws(() => readPins(repo), /不是直接指定一個字串字面值/);
});

test('釘值定位｜整個宣告不見了 → 炸、bump 退 2 且兩個檔都不動', async () => {
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(body()) });
  const p = join(repo, ...SCAN);
  writeFileSync(p, readFileSync(p, 'utf8').replace('EXPECTED_GROK_VERSION', 'EXPECTED_GROK_VER'));
  const before = snapshot(repo);
  assert.throws(() => readPins(repo), /有 0 個/);
  const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true });
  assert.equal(r.code, 2, r.lines.join('\n'));
  assert.deepEqual(snapshot(repo), before, '定位不到就什麼都不能寫');
});

// ——— r2 #1：找到同名節點還不夠，要確定改的是**生效**的那一個 ———

for (const [名稱, scan, pre] of /** @type {[string, string|null, string|null][]} */ ([
  ['export let ＋後面再賦值（改了會被蓋掉）',
    `export let EXPECTED_GROK_VERSION = '1.2.3';\nEXPECTED_GROK_VERSION = '1.2.3';\nexport const EXPECTED_GROK_SHA256 = '@@SHA@@';\n`, null],
  ['死分支裡的同名 const ＋改名匯出（改到的不是匯出的那個）',
    `if (false) { const EXPECTED_GROK_VERSION = '1.2.3'; }\nconst LIVE = '9.9.9';\nexport { LIVE as EXPECTED_GROK_VERSION };\nexport const EXPECTED_GROK_SHA256 = '@@SHA@@';\n`, null],
  ['沒有 export 的頂層 const（不是被釘住的那個）',
    `const EXPECTED_GROK_VERSION = '1.2.3';\nexport const EXPECTED_GROK_SHA256 = '@@SHA@@';\n`, null],
  // ⚠️ TypeScript 的解析器對這個寬容：`if (false) { export const … }` 解析出來**零語法錯誤**、
  //    而且 export 旗標還在。所以「必須在頂層」不是贅句，它有自己的落點。
  ['死分支裡的 export const（改了也不會生效）',
    `if (false) { export const EXPECTED_GROK_VERSION = '1.2.3'; }\nexport const EXPECTED_GROK_SHA256 = '@@SHA@@';\n`, null],
  ['export let（可以被重新賦值，釘不住）',
    `export let EXPECTED_GROK_VERSION = '1.2.3';\nexport const EXPECTED_GROK_SHA256 = '@@SHA@@';\n`, null],
  ['同一個名字又被改名匯出一次（改到的不一定是匯出的那個）',
    `export const EXPECTED_GROK_VERSION = '1.2.3';\nconst LIVE = '9.9.9';\nexport { LIVE as EXPECTED_GROK_VERSION };\nexport const EXPECTED_GROK_SHA256 = '@@SHA@@';\n`, null],


])) {
  test(`釘值定位｜${名稱} → 炸、bump 退 2、兩個檔都不動`, async () => {
    const b = body();
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
    if (scan) writeFileSync(join(repo, ...SCAN), scan.replace('@@SHA@@', sha(b)));
    if (pre) writeFileSync(join(repo, ...PRE), pre.replace('@@SHA@@', sha(b)));
    // ⚠️ 對照斷言：夾具本身必須還是「有那兩個識別字」的樣子。
    //    這一行是因為佔位字原本用 `SHA`、它也出現在 `EXPECTED_GROK_SHA256` 裡面，
    //    replace 把識別字改爛 → 四題全部因為「找不到 SHA256 斷言」而綠（r2 處置時自己抓到的假綠）。
    const before = snapshot(repo);
    const 夾具全文 = 讀(repo, SCAN) + 讀(repo, PRE);
    for (const 名字 of ['EXPECTED_GROK_VERSION', 'EXPECTED_GROK_SHA256']) {
      assert.ok(夾具全文.includes(名字), `夾具裡連 ${名字} 都不見了＝這題量錯了東西`);
    }
    assert.ok(!夾具全文.includes('@@SHA@@'), '佔位字沒被換掉');
    assert.throws(() => readPins(repo));
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true });
    assert.equal(r.code, 2, r.lines.join('\n'));
    assert.deepEqual(snapshot(repo), before);
  });
}

// ——— r2 #2：寫入失敗時，報告要與磁碟上的真實狀態對得上 ———

for (const [名稱, 鎖住, 預期已換] of /** @type {[string, string, string[]][]} */ ([
  ['第一個檔就寫不進去', 'scripts', []],
  ['第一個換好了、第二個寫不進去', 'test', ['scripts/grok-scan.js']],
])) {
  test(`bump --write｜${名稱}：失敗的那個檔一個字都沒被動到（暫存檔＋rename），報告只列真的換好的`, async () => {
    const oldB = body(), newB = body({ filler: 'NEWER' });
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
    const before = snapshot(repo);
    chmodSync(join(repo, 鎖住), 0o555);          // 讀得到、但建不了新檔（暫存檔就寫不出來）
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB }), repo, write: true });
    chmodSync(join(repo, 鎖住), 0o755);
    assert.equal(r.code, 2, r.lines.join('\n'));
    const out = r.lines.join('\n');
    assert.match(out, /本身\*\*沒有被動到\*\*/, '失敗的那個檔必須是完全沒動，不是被截短');
    const after = snapshot(repo);
    // 真的換好的那些，磁碟上要對得上；沒列的就必須一個字都沒變
    assert.equal(after.scan !== before.scan, 預期已換.includes('scripts/grok-scan.js'), 'scan 的實際狀態與報告對不上');
    assert.equal(after.preflight !== before.preflight, 預期已換.includes('test/grok-scan-flow-preflight.test.js'), 'preflight 的實際狀態與報告對不上');
    if (預期已換.length) assert.match(out, /但前面這些已經換好了：scripts\/grok-scan\.js/);
    else assert.match(out, /也沒有別的檔被改到/);
  });
}

// ——— r2 #3／r3 #3：寫入之前的返回點，**逐個數過** ———
// 審查者 r3 說上一版的「六個案例」不是全部（他數出 14 個語法位置，其中兩個做不出輸入＝沒人測得到）。
// 處置分兩步：①**把測不到的分支刪掉**——`existsSync(vPath)`、`existsSync(binLink)`、`statSync().isFile()`
// 這三個前哨只是把同一個錯誤分成兩個返回點，讓 catch 自己接就少三個分支；
// ②剩下的逐個列在這裡，每一個都指名哪一題在守：
//
//   1 最外層 catch（沒預期到的錯誤）      → 「候選檔讀得到、但 downloads 列不了」
//   2 readPins 炸                          → 「釘值定位｜…」那一族
//   3 常數與 fixture 一開始就不一致        → 「一開始就對不上」
//   4 version.json 讀不出／不是版本號形狀  → 下面這張表的前 3 列（共用同一個 catch）
//   5 realpath 解析不了                    → 下面第 4、5 列（bin 不見／斷掉的捷徑）
//   6 候選執行檔讀不了                     → 下面第 6 列（指到目錄）＋「候選執行檔讀不了」
//   7 sha 相同、版本號對得上 → 0           → 「磁碟上就是釘著的那一版」
//   8 sha 相同、版本號對不上 → 2           → 「同一支執行檔被標成別的版本號」
//   9 三個值的字元集形狀不合               → 4 種惡意檔名那 4 題（⚠️ **只覆蓋到檔名那一個**：
//                                             版本號要長過 120 字才撞得到同一道關、sha256 是 hex
//                                             在這支程式裡過不了關的分支走不到——Grok 掃描 #636 抓到）
//  9b 日期形狀不合                          → 「日期也要過關」那一題
//  10 缺必要字串                           → 逐項 5 題
//  11 dry-run（退 1）                       → 「有新版、必要字串都在」
//  12 替換區間重疊                         → ⚠️ **宣告不可達、沒有覆蓋**（見 grok-bump.js 該處註解）
//
// 12 個裡 11 個有考題，第 12 個照實記成沒覆蓋。這張表就是「每一條」的定義。

for (const [名稱, 弄壞] of /** @type {[string, (home: string) => void][]} */ ([
  ['version.json 不見了', (home) => rmSync(join(home, 'version.json'))],
  ['version.json 不是 JSON', (home) => writeFileSync(join(home, 'version.json'), 'not json')],
  ['version.json 裡不是版本號的形狀', (home) => writeFileSync(join(home, 'version.json'), JSON.stringify({ version: 'latest' }))],
  ['bin/grok 不見了', (home) => rmSync(join(home, 'bin', 'grok'))],
  ['bin/grok 是斷掉的捷徑', (home) => { rmSync(join(home, 'bin', 'grok')); symlinkSync(join('..', 'downloads', '不存在'), join(home, 'bin', 'grok')); }],
  ['bin/grok 指到一個目錄', (home) => { rmSync(join(home, 'bin', 'grok')); mkdirSync(join(home, 'downloads', 'adir')); symlinkSync(join('..', 'downloads', 'adir'), join(home, 'bin', 'grok')); }],
])) {
  test(`bump --write｜${名稱} → 2，而且兩個檔一個字都不寫`, async () => {
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(body()) });
    const before = snapshot(repo);
    const home = fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) });
    弄壞(home);
    const r = await bump({ grokHome: home, repo, write: true });
    assert.equal(r.code, 2, r.lines.join('\n'));
    assert.deepEqual(snapshot(repo), before, `${名稱} 這條路偷寫了檔`);
  });
}

// ——— r4 F10：保證從「不可能改錯」換成「**改錯了會大聲失敗**」，而且用跑的證明 ———
//
// 審查者 r3／r4 示範了一連串合法的 ESM 幌子：函式參數、解構、`assert['equal']`、
// `'1.\x32.3'`（跳脫）、`'1.2.' + '3'`（串接）。我不再宣稱「挑得到活的那一句」——
// 那等於在 bump 裡重做一遍 `npm test`。改成把**真正在管這件事的東西**搬出來當證據：
// 那份考題本身。下面每一題都**真的用 node 跑那個 fixture**：改之前過、改之後紅。

const 跑得過 = (/** @type {string} */ repo) => {
  try { execFileSync(process.execPath, [join(repo, ...PRE)], { stdio: 'pipe' }); return true; }
  catch { return false; }
};

for (const [名稱, 活的那一句] of /** @type {[string, string][]} */ ([
  ['活的那一句走 assert[\'equal\']（r3 #1 原文）', `assert['equal'](EXPECTED_GROK_VERSION, '1.2.3', 'live');`],
  ['活的那一句用跳脫寫舊值（r4 #1 原文）', `assert['equal'](EXPECTED_GROK_VERSION, '1.\\x32.3', 'live');`],
  ['活的那一句用串接寫舊值（r4 #1 第二發）', `assert['equal'](EXPECTED_GROK_VERSION, '1.2.' + '3', 'live');`],
])) {
  test(`改錯了會大聲失敗｜${名稱}`, async () => {
    const b = body();
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
    writeFileSync(join(repo, ...PRE),
      `import assert from 'node:assert/strict';\n`
      + `import { EXPECTED_GROK_VERSION, EXPECTED_GROK_SHA256 } from '../scripts/grok-scan.js';\n`
      + `function unused(EXPECTED_GROK_VERSION) {\n`
      + `  assert.equal(EXPECTED_GROK_VERSION, '1.2.3', 'decoy');\n`
      + `}\n`
      + `${活的那一句}\n`
      + `  assert.equal(EXPECTED_GROK_SHA256, '${sha(b)}', 'decoy sha');\n`);
    assert.ok(跑得過(repo), '改之前這個 fixture 要跑得過，否則這題量錯了東西');
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true });
    assert.equal(r.code, 0, r.lines.join('\n'));
    // ⚠️ 這就是新的保證：bump **不宣稱**自己挑到了活的那一句；它宣稱的是
    //    「我只動符合模板的那一行，而且我沒有驗證整份考卷」——然後考卷會紅。
    assert.match(r.lines.join('\n'), /沒有驗證整份考卷/, '報告必須講明它沒驗考卷');
    assert.ok(!跑得過(repo), '改錯了卻還跑得過＝靜靜通過，那才是最糟的');
  });
}

test('改對了就跑得過｜正常的兩行 fixture（對照組：證明上面那三題不是恆紅）', async () => {
  const b = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
  writeFileSync(join(repo, ...PRE),
    `import assert from 'node:assert/strict';\n`
    + `import { EXPECTED_GROK_VERSION, EXPECTED_GROK_SHA256 } from '../scripts/grok-scan.js';\n`
    + `  assert.equal(EXPECTED_GROK_VERSION, '1.2.3', 'grok CLI 1.2.3（舊的說明）');\n`
    + `  assert.equal(EXPECTED_GROK_SHA256, '${sha(b)}', 'grok-1.2.3-macos-aarch64 的 sha256');\n`);
  assert.ok(跑得過(repo));
  const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.ok(跑得過(repo), '改對了之後考卷要還是過的');
});

/** 目錄裡還留著的暫存檔（隨機檔名，所以只能用結尾認）。 */
const 殘留的暫存檔 = (/** @type {string} */ dir) => readdirSync(dir).filter((n) => n.endsWith('.grok-bump-tmp'));

// ——— Grok 複審後掃（#636）：三條行為面 ———

test('日期也要過關｜`today` 是第四個被寫進原始碼的東西（我原本宣稱「只有三個」）', async () => {
  for (const 壞的 of ['2026-01-02`+x+`', '2026-01-02 ; y', '2026-01-02\n', '`${x}`', 'latest', '2026-1-2']) {
    const b = body();
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
    const before = snapshot(repo);
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true, today: 壞的 });
    assert.equal(r.code, 2, `「${壞的}」應該被擋下來：${r.lines.join('\n')}`);
    assert.match(r.lines.join('\n'), /不是 YYYY-MM-DD 的形狀/);
    assert.deepEqual(snapshot(repo), before, `「${壞的}」那一發把檔改掉了`);
  }
  assert.ok(SAFE_DATE.test('2026-01-02'), '正常日期要放行');
  assert.ok(!SAFE_DATE.test('2026-01-02x'));
});

test('日期形狀｜CLI 那條路給的日期本來就合格（對照組：證明上一題不是恆紅）', async () => {
  const oldB = body(), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB }), repo, write: true });   // 不給 today＝走 ISO 日期
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(readFileSync(join(repo, ...PRE), 'utf8'), /重驗轉送器目的地後升的/);
});

test('別的匯出｜`export * as 名字 from` 也算（那是 NamespaceExport，不是 ExportSpecifier）', async () => {
  const b = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
  writeFileSync(join(repo, ...SCAN),
    `export const EXPECTED_GROK_VERSION = '1.2.3';\nexport * as EXPECTED_GROK_VERSION from './other.js';\nexport const EXPECTED_GROK_SHA256 = '${sha(b)}';\n`);
  const before = snapshot(repo);
  assert.throws(() => readPins(repo), /別的地方在匯出/);
  const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true });
  assert.equal(r.code, 2, r.lines.join('\n'));
  assert.deepEqual(snapshot(repo), before);
});

test('失敗報告｜暫存檔清不掉時，不可以還說「也沒有別的檔被改到」', { skip: process.platform !== 'darwin' && '只有 macOS 做得出這個情形' }, async () => {
  const oldB = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const target = join(repo, ...SCAN);
  // 目錄只能新增不能刪 → 暫存檔建得出來、rename 失敗、清理也失敗
  execFileSync('chflags', ['uchg', target]);
  execFileSync('chmod', ['+a', `${process.env.USER} deny delete_child`, join(repo, 'scripts')]);
  let r;
  try { r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true }); }
  finally {
    try { execFileSync('chmod', ['-a#', '0', join(repo, 'scripts')]); } catch { /* 沒加成功 */ }
    execFileSync('chflags', ['nouchg', target]);
  }
  assert.equal(r.code, 2, r.lines.join('\n'));
  const out = r.lines.join('\n');
  // ⚠️ 不寫成 if／else：那樣兩邊都會綠＝這題白寫。先斷言真的走到「清不掉」那一支。
  assert.match(out, /暫存檔清不掉/, '這題要的情形沒做出來（ACL 沒擋住刪除？）——不是通過，是量錯了');
  assert.ok(!out.includes('也沒有別的檔被改到'), '暫存檔還留著，就不可以說「也沒有別的檔被改到」');
  assert.match(out, /但上面那個暫存檔還在/);
});

// ——— r7 #1：短寫入——寫了一部分、不拋錯，被截掉尾巴的檔就被 rename 成正式來源檔 ———
//
// 審查者的故障模型：`writeSync()` 回傳「實際寫了幾個位元組」，底層寫了一部分後遇狀況會回正數而不拋錯。
// 這裡照他的方法注入：把 `fs.writeSync` 換成「只寫前 N 個位元組、回傳 N、不拋錯」，
// 再 `syncBuiltinESMExports()` 讓已經 import 過具名匯出的受測程式也看到新的那一個。
// ⚠️ 真正的寫入仍然由原生的 `writeSync` 寫進本次排他取得的 fd——沒有換路徑、沒有並行、沒有動系統設定。

for (const [名稱, 哪個檔] of /** @type {[string, string[]][]} */ ([['常數檔', SCAN], ['考題 fixture', PRE]])) {
  test(`短寫入｜${名稱}只寫了前段（不拋錯） → 尾端不相干的內容不准被截掉`, async () => {
    const oldB = body(), newB = body({ filler: 'NEWER' });
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
    // 在四處**之後**放一段不相干的東西：被截尾就看得出來（而且截掉之後語法還是合法的）
    const 尾巴 = `\n// PRESERVE_TAIL\nexport const TAIL_MARKER = 'keep-me';\n`;
    for (const rel of [SCAN, PRE]) writeFileSync(join(repo, ...rel), readFileSync(join(repo, ...rel), 'utf8') + 尾巴);
    // ESM 的 namespace 是唯讀的，所以拿 CJS 那一份來換（`syncBuiltinESMExports()` 會把它同步給具名匯出）
    const fsCjs = createRequire(import.meta.url)('node:fs');
    const 原 = fsCjs.writeSync;
    /** @type {number|null} */ let 砍到 = null;
    fsCjs.writeSync = (/** @type {number} */ fd, /** @type {Buffer|string} */ buf, /** @type {unknown[]} */ ...rest) => {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
      if (砍到 === null && b.length > 80) { 砍到 = b.length - 40; return 原(fd, b.subarray(0, 砍到)); }
      return 原(fd, buf, ...rest);
    };
    syncBuiltinESMExports();
    try {
      const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB }), repo, write: true, today: '2026-01-02' });
      assert.equal(r.code, 0, r.lines.join('\n'));
    } finally { fsCjs.writeSync = 原; syncBuiltinESMExports(); }
    const 寫完的 = readFileSync(join(repo, ...哪個檔), 'utf8');
    assert.match(寫完的, /PRESERVE_TAIL/, `${名稱}的尾巴被截掉了——短寫入沒有被補完`);
    assert.match(寫完的, /TAIL_MARKER = 'keep-me'/);
    assert.match(readFileSync(join(repo, ...SCAN), 'utf8'), /EXPECTED_GROK_VERSION = '1\.3\.0'/, '該改的還是要改到');
    // 兩個檔都要完整：拿獨立組出來的預期內容比整份
    for (const rel of [SCAN, PRE]) {
      const t = readFileSync(join(repo, ...rel), 'utf8');
      assert.ok(t.endsWith(尾巴), `${rel.join('/')} 的結尾不完整`);
    }
  });
}

// ——— r6 #1：暫存檔用固定檔名 → 既有的連結會把寫入導到別的檔 ———

for (const [名稱, 做連結] of /** @type {[string, (from: string, to: string) => void][]} */ ([
  ['符號連結', (from, to) => symlinkSync(to, from)],
  ['硬連結', (from, to) => linkSync(to, from)],
])) {
  test(`暫存檔｜舊的固定檔名上先放一條${名稱} → 不相干的檔一個位元組都不准被動到`, async () => {
    const oldB = body(), newB = body({ filler: 'NEWER' });
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
    const 不相干 = join(repo, 'unrelated.js');
    writeFileSync(不相干, '// 跟這次升版完全無關的檔\nexport const KEEP = 1;\n');
    const 原樣 = readFileSync(不相干);
    做連結(join(repo, 'scripts', 'grok-scan.js.grok-bump-tmp'), 不相干);
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB }), repo, write: true, today: '2026-01-02' });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.ok(readFileSync(不相干).equals(原樣), `寫入被那條${名稱}導到不相干的檔去了`);
    assert.match(readFileSync(join(repo, ...SCAN), 'utf8'), /EXPECTED_GROK_VERSION = '1\.3\.0'/, '該改的還是要改到');
  });
}

test('暫存檔｜舊的固定檔名上先放一條指向**目標自己**的連結 → 目標不可以變成自我循環', async () => {
  const oldB = body(), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  symlinkSync('grok-scan.js', join(repo, 'scripts', 'grok-scan.js.grok-bump-tmp'));
  const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB }), repo, write: true, today: '2026-01-02' });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.ok(statSync(join(repo, ...SCAN)).isFile(), '目標被做成連結了');
  assert.match(readFileSync(join(repo, ...SCAN), 'utf8'), /EXPECTED_GROK_VERSION = '1\.3\.0'/);
});

test('排他建檔｜撞到既有的檔就換一個名字，**絕不覆寫任何既有路徑**', () => {
  const d = keep(mkdtempSync(join(tmpdir(), 'excl-')));
  const 目標 = join(d, 'target.js'); writeFileSync(目標, 'x');
  const 佔位 = join(d, 'taken.grok-bump-tmp'); writeFileSync(佔位, '不可以被蓋掉');
  const 不相干 = join(d, 'unrelated.js'); writeFileSync(不相干, '也不可以被蓋掉');
  const 連結 = join(d, 'linked.grok-bump-tmp'); symlinkSync(不相干, 連結);
  // 前兩個名字刻意都已經被佔住（一個普通檔、一個連結），第三個才是乾淨的
  const 名字 = [佔位, 連結, join(d, 'fresh.grok-bump-tmp')];
  let i = 0;
  const t = createExclusiveTemp(目標, () => 名字[i++]);
  closeSync(t.fd);
  assert.equal(t.path, 名字[2], '應該跳過被佔住的那兩個');
  assert.equal(readFileSync(佔位, 'utf8'), '不可以被蓋掉');
  assert.equal(readFileSync(不相干, 'utf8'), '也不可以被蓋掉', '連結那一個被跟隨了');
  assert.ok(statSync(t.path).isFile());
});

test('排他建檔｜一直撞名字就放棄（不會無限試，也不會退而求其次去覆寫）', () => {
  const d = keep(mkdtempSync(join(tmpdir(), 'excl2-')));
  const 佔位 = join(d, 'always.grok-bump-tmp'); writeFileSync(佔位, '原樣');
  assert.throws(() => createExclusiveTemp(join(d, 'target.js'), () => 佔位), /都撞到既有路徑/);
  assert.equal(readFileSync(佔位, 'utf8'), '原樣');
});

test('排他建檔｜正常情況下每次都是新的名字，而且跑完不留東西', async () => {
  const oldB = body(), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  assert.equal((await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB }), repo, write: true })).code, 0);
  assert.deepEqual(殘留的暫存檔(join(repo, 'scripts')), []);
  assert.deepEqual(殘留的暫存檔(join(repo, 'test')), []);
});

// ——— r5 #1：整檔 UTF-8 讀回寫，會靜靜改掉模板以外的位元組 ———

for (const [名稱, 哪個檔] of /** @type {[string, string[]][]} */ ([
  ['考題 fixture', PRE],
  ['常數檔', SCAN],
])) {
  test(`不合法的 UTF-8｜${名稱}裡有一個 0xFF → 退 2，兩個檔的**位元組**一個都不變`, async () => {
    const b = body();
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
    const p = join(repo, ...哪個檔);
    // 審查者 r5 #1 的重現：`// ` + FF + 換行。升版之後那個 FF 會變成 EF BF BD，而前後 npm test 都綠。
    writeFileSync(p, Buffer.concat([Buffer.from('// '), Buffer.from([0xff]), Buffer.from('\n'), readFileSync(p)]));
    const before = snapshot(repo);
    assert.ok(readFileSync(p).includes(0xff), '夾具裡要真的有那個位元組，否則這題量錯了東西');
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true });
    assert.equal(r.code, 2, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /不是合法的 UTF-8/);
    assert.deepEqual(snapshot(repo), before, '位元組一個都不准變');
    assert.ok(readFileSync(p).includes(0xff), '那個 0xFF 要原封不動（不是被換成 U+FFFD）');
  });
}

test('合法的多位元組字｜中文、emoji 不受影響，而且模板以外的位元組逐一對得上（對照組）', async () => {
  const oldB = body(), newB = body({ filler: 'NEWER' });
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const p = join(repo, ...PRE);
  const 檔頭 = '// 中文註解 🐙 ＦＵＬＬＷＩＤＴＨ\n';
  writeFileSync(p, 檔頭 + readFileSync(p, 'utf8'));
  const 前 = readFileSync(p);
  const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: newB }), repo, write: true, today: '2026-01-02' });
  assert.equal(r.code, 0, r.lines.join('\n'));
  const 後 = readFileSync(p);
  // 檔頭那一行的位元組要逐一相同
  assert.ok(後.subarray(0, Buffer.byteLength(檔頭)).equals(前.subarray(0, Buffer.byteLength(檔頭))), '模板以外的位元組被動到了');
  assert.match(readFileSync(p, 'utf8'), /🐙/);
});

// ——— r4 #2：**我自己造的 bug**——新值含舊值當子字串時，正常升版被誤判成失敗 ———

for (const [舊, 新] of [['1.0.4', '1.0.40'], ['1.2.3', '1.2.30'], ['1.0.40', '1.0.40']]) {
  test(`正常升版｜${舊} → ${新}（新版號含舊版號當子字串，不可以被當成「沒改到」）`, async () => {
    const oldB = body(), newB = body({ filler: 'NEWER' });
    const repo = fakeRepo({ version: 舊, sha256: sha(oldB) });
    const r = await bump({ grokHome: fakeGrokHome({ version: 新, body: newB }), repo, write: true, today: '2026-01-02' });
    assert.equal(r.code, 0, r.lines.join('\n'));
    const scan = readFileSync(join(repo, ...SCAN), 'utf8');
    assert.match(scan, new RegExp(`EXPECTED_GROK_VERSION = '${新.replaceAll('.', '\\.')}'`));
    assert.match(scan, new RegExp(`EXPECTED_GROK_SHA256 = '${sha(newB)}'`));
  });
}

// ——— r4 F10：fixture 的**固定模板契約**（不合模板＝寫入前退 2，一個字都不寫） ———

for (const [名稱, 那一行] of [
  ['接收者不是 assert', `  dummy.equal(EXPECTED_GROK_VERSION, '1.2.3', 'x');`],
  ['同一行還有別的東西', `  assert.equal(EXPECTED_GROK_VERSION, '1.2.3', 'x'); const extra = 1;`],
  ['參數之間的空白不一樣', `  assert.equal( EXPECTED_GROK_VERSION, '1.2.3', 'x' );`],
  ['用雙引號', `  assert.equal(EXPECTED_GROK_VERSION, "1.2.3", "x");`],
  ['兩行都符合模板（不敢猜要改哪一個）', `  assert.equal(EXPECTED_GROK_VERSION, '1.2.3', 'x');\n  assert.equal(EXPECTED_GROK_VERSION, '1.2.3', 'y');`],
]) {
  test(`模板契約｜${名稱} → 寫入前退 2，兩個檔一個字都不寫`, async () => {
    const b = body();
    const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
    writeFileSync(join(repo, ...PRE), `${那一行}\n  assert.equal(EXPECTED_GROK_SHA256, '${sha(b)}', 'y');\n`);
    const before = snapshot(repo);
    const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true });
    assert.equal(r.code, 2, r.lines.join('\n'));
    assert.deepEqual(snapshot(repo), before);
  });
}

test('寫完之後量結果｜fixture 變成不是合法的 JS → 退 2（用完整的 JS 語法診斷，r3 #2）', async () => {
  const b = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(b) });
  const p = join(repo, ...PRE);
  // 審查者 r3 #2 的反例：TypeScript 型別註記。`parseDiagnostics` 對它是 0，完整的 JS 診斷才會回 8010。
  writeFileSync(p, readFileSync(p, 'utf8') + `const TS_ONLY: number = 1;\n`);
  const r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true });
  assert.equal(r.code, 2, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /不是合法的 JS 了/);
});

test('語法檢查器｜完整的 JS 診斷抓得到 TS 專屬語法（`parseDiagnostics` 那一半抓不到）', () => {
  const 有型別註記 = `  assert.equal(A, 'x', 'y');\n  const T: number = 1;\n`;
  assert.equal(語法錯誤數(有型別註記), 0, 'parseDiagnostics 對它就是 0——這正是 r3 #2 的反例');
  assert.deepEqual(jsSyntaxErrors('x.js', 有型別註記).map((d) => d.split('：')[0]), ['8010']);
  assert.deepEqual(jsSyntaxErrors('x.js', `  assert.equal(A, 'x', 'y');\n`), []);
  // ⚠️ 射程：tagged template 是**合法的 JS**，語法診斷不會擋；「沒有多出會做事的東西」那句
  //    只到「CallExpression／NewExpression 這兩種節點的清單沒變」，r3 #2 已指出這一點。
  assert.deepEqual(jsSyntaxErrors('x.js', 'tag`x`;'), []);
  assert.deepEqual(呼叫清單('tag`x`; globalThis.extra = 1;'), []);
});

// ⚠️ 這一題只在 macOS 跑：要讓「**讀得到、但 rename 會失敗**」同時成立，我只找到 `chflags uchg` 這條路
//    （Linux 的 `chattr +i` 要 root）。**所以 CI（Linux）不會跑它**——這一格的證據只到開發機。
//    ⚠️ 第一版我把目標換成**目錄**，結果 `readPins` 讀那個目錄時就先 EISDIR 退 2 了，
//    根本沒走到 rename——那是假綠（#636 r3 處置時自己抓到的第四個）。
test('bump --write｜rename 失敗 → 退 2，目標原封不動、暫存檔清掉', { skip: process.platform !== 'darwin' && '只有 macOS 做得出這個情形' }, async () => {
  const oldB = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const before = snapshot(repo);
  const target = join(repo, ...SCAN);
  // 旁邊先放一個**別人的**暫存檔：清理只准清自己建的那一個（#636 r6）
  const 別人的 = join(repo, 'scripts', 'someone-else.grok-bump-tmp');
  writeFileSync(別人的, '不是我建的，不准清');
  execFileSync('chflags', ['uchg', target]);                 // 讀得到、但換不掉
  let r;
  try { r = await bump({ grokHome: fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) }), repo, write: true }); }
  finally { execFileSync('chflags', ['nouchg', target]); }
  assert.equal(r.code, 2, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /本身\*\*沒有被動到\*\*/);
  assert.deepEqual(snapshot(repo), before, 'rename 失敗時兩個檔都該原封不動');
  assert.equal(readFileSync(別人的, 'utf8'), '不是我建的，不准清', '清理掃到別人的暫存檔了');
  assert.deepEqual(殘留的暫存檔(join(repo, 'scripts')), ['someone-else.grok-bump-tmp'],
    '除了別人那一個以外不該有殘留（掃整個目錄，不是只看某個固定檔名）');
});

test('釘值定位｜解析器在**真的**原始碼上找得到，讀出來的值等於 import 進來的常數', async () => {
  const p = readPins(ROOT);
  assert.equal(p.version.value, EXPECTED_GROK_VERSION);
  assert.equal(p.sha256.value, EXPECTED_GROK_SHA256);
  assert.equal(p.testVersion.value, EXPECTED_GROK_VERSION, '考題 fixture 與常數對不上');
  assert.equal(p.testSha.value, EXPECTED_GROK_SHA256, '考題 fixture 與常數對不上');
});

// ——— #636 r1 #6：錯誤路徑要守住退出碼契約 ———

test('bump｜候選執行檔讀不了 → 2＋報告（不是未捕捉例外）', async () => {
  const oldB = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const before = snapshot(repo);
  const home = fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }) });
  chmodSync(join(home, 'downloads', 'grok-1.3.0-macos-aarch64'), 0o000);
  const r = await bump({ grokHome: home, repo, write: true });
  assert.equal(r.code, 2, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /讀不了/);
  assert.deepEqual(snapshot(repo), before);
});

test('bump｜候選檔讀得到、但 downloads 列不了 → 還是 2（走的是最外層那道「沒預期到的錯誤」）', async () => {
  const oldB = body();
  const repo = fakeRepo({ version: '1.2.3', sha256: sha(oldB) });
  const before = snapshot(repo);
  // ⚠️ 執行檔刻意放在 downloads 以外：不然 realpathSync 自己就先 EACCES，
  //    考題會因為「候選檔解析不了」而綠，根本走不到 readdirSync——那是假綠（#636 r1 處置時自己抓到的）。
  const home = fakeGrokHome({ version: '1.3.0', body: body({ filler: 'NEWER' }), binOutsideDownloads: true });
  chmodSync(join(home, 'downloads'), 0o000);
  const r = await bump({ grokHome: home, repo, write: true });
  chmodSync(join(home, 'downloads'), 0o755);
  assert.equal(r.code, 2, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /沒預期到的錯誤/, '要走最外層那道收斂，不是別的分支');
  assert.deepEqual(snapshot(repo), before);
});

test('CLI｜查不清楚時**真的**退 2（不是未捕捉例外那個 1），而且有印東西', async () => {
  const home = keep(mkdtempSync(join(tmpdir(), 'fake-grok-empty-')));   // 沒有 .grok/version.json
  /** @type {{ status?: number, stdout?: string } | null} */ let err = null;
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'grok-bump.js')],
      { env: { ...process.env, HOME: home }, encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.fail('預期退 2，卻正常結束了');
  } catch (e) { err = /** @type {{ status?: number, stdout?: string }} */ (e); }
  assert.equal(err?.status, 2, `退出碼不是 2：${JSON.stringify(err?.status)}｜${err?.stdout}`);
  assert.match(String(err?.stdout), /✖/, '退 2 一定要印出為什麼');
});

test('載入清單｜本檔的 import／require／動態 import 就只有這幾個（⚠️ 這不等於證明它不開子行程）', async () => {
  // ⚠️ **射程**（審查者 r2 #5 實測）：這一題量的是「**取得模組的寫法**」，不是「有沒有開子行程」。
  //    `process.getBuiltinModule('node:child_process')` 一個 import 都不用就能開子行程，這一題**抓不到**。
  //    下面那組名字是**列舉**（補不完），所以本題只宣稱「這幾種寫法沒有出現」；
  //    「不 commit、不 push」那句更強的話，撐著它的是**原始碼審查**，不是這一題——PR 表裡照這個射程寫。
  const 允許 = new Set(['node:crypto', 'node:fs', 'node:os', 'node:path', 'node:url', 'typescript', '../lib/is-main.js']);
  const src = readFileSync(join(ROOT, 'scripts', 'grok-bump.js'), 'utf8');
  const sf = ts.createSourceFile('grok-bump.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  /** @type {string[]} */ const 進來的 = [];
  const walk = (/** @type {ts.Node} */ n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) 進來的.push(n.moduleSpecifier.text);
    // 動態 import() 也要算：它同樣能載進任何東西
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) 進來的.push('（動態 import）');
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require') 進來的.push('（require）');
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.ok(進來的.length > 0, '一個 import 都沒讀到＝這一題自己壞了');
  const 多的 = 進來的.filter((m) => !允許.has(m));
  assert.deepEqual(多的, [], `多了不該有的相依：${多的.join('、')}`);
  // 列舉（不是關門）：這幾種「不用 import 也拿得到模組」的寫法目前沒有出現。補不完，所以只宣稱這幾種。
  for (const 寫法 of ['getBuiltinModule', 'process.binding', 'createRequire', 'eval(', 'new Function(']) {
    assert.ok(!src.includes(寫法), `出現了 ${寫法}——那條路 import 清單看不到`);
  }
});

test('countBytes｜數的是出現次數，不是行數（同一行兩次要算兩次）', async () => {
  assert.equal(countBytes(Buffer.from('aXbXc\nX'), 'X'), 3);
  assert.equal(countBytes(Buffer.from('none'), 'X'), 0);
  assert.equal(countBytes(Buffer.from('XXX'), 'XX'), 2, '重疊也算（indexOf 逐格前進）');
});
