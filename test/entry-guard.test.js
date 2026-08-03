/**
 * 進入點判斷考題（2026-08-03，Codex #388 r3：「另外三支閘都應一起修」）
 *
 * 病因：六個地方各寫一份「這支檔案是被直接執行的嗎」，**六份寫法都不一樣**。
 * 錯的時候**不會叫**——判斷成 false ⇒ `main()` 不跑 ⇒ 退出碼 0 ⇒
 * 對呼叫者來說就是**「這道閘通過了」**。**一道靜靜回報通過的閘，比沒有閘更糟。**
 *
 * 實際怎麼踩到的：把閘複製到 `/tmp/xgate.mjs` 執行，**完全沒有輸出、exit 0**。
 * 因為 macOS 的 `/tmp` 是 `/private/tmp` 的 symlink，Node 給的 `import.meta.url`
 * 是解析過的真實路徑，`process.argv[1]` 是你打進去的樣子，兩邊永遠比不相等。
 *
 * 修法不是「把六個地方各修一次」（那還會漂），是收成 `lib/is-main.js` 一支，
 * 再用下面第三題**關門**：不准任何檔案自己再寫一份。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 在 macOS 的 /tmp（本身就是 symlink）底下開一個暫存資料夾。 */
function withSymlinkedTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'entry-guard-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('lib/is-main.js：透過 symlink 執行時仍認得出自己是進入點', () => {
  withSymlinkedTemp((dir) => {
    const real = join(dir, 'real.mjs');
    writeFileSync(real,
      `import { isMainModule } from ${JSON.stringify(join(ROOT, 'lib/is-main.js'))};\n`
      + `console.log(isMainModule(import.meta.url) ? 'MAIN' : 'NOT-MAIN');\n`);
    const link = join(dir, 'link.mjs');
    symlinkSync(real, link);

    // 直接跑真實路徑
    assert.equal(execFileSync(process.execPath, [real], { encoding: 'utf8' }).trim(), 'MAIN');
    // 透過 symlink 跑——**這條就是舊寫法會答錯的那條**
    assert.equal(execFileSync(process.execPath, [link], { encoding: 'utf8' }).trim(), 'MAIN',
      '透過 symlink 執行時判斷成「不是進入點」⇒ main() 不會跑、退出碼 0＝靜靜放行。');

    // ⚠️ **這條是用來讓「兩邊都要 realpath」這句話站得住的**：
    //    預設情況下 Node 會替你把 `import.meta.url` 解析成真實路徑，所以只 realpath
    //    `argv[1]` 一邊也會過——那會讓人以為只修一邊就夠。加上 `--preserve-symlinks-main`
    //    之後兩邊都不解析，**只修一邊當場就錯**。沒有這條，那句註解就是沒有根據的保證。
    assert.equal(
      execFileSync(process.execPath, ['--preserve-symlinks-main', link], { encoding: 'utf8' }).trim(),
      'MAIN', '--preserve-symlinks-main 下判斷錯誤＝只 realpath 了一邊。');
  });
});

test('lib/is-main.js：被別人 import 時不會誤認自己是進入點', () => {
  withSymlinkedTemp((dir) => {
    const lib = join(dir, 'lib.mjs');
    writeFileSync(lib,
      `import { isMainModule } from ${JSON.stringify(join(ROOT, 'lib/is-main.js'))};\n`
      + `export const answer = isMainModule(import.meta.url);\n`);
    const entry = join(dir, 'entry.mjs');
    writeFileSync(entry, `import { answer } from './lib.mjs';\nconsole.log(answer ? 'MAIN' : 'NOT-MAIN');\n`);
    assert.equal(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim(), 'NOT-MAIN',
      '被 import 的模組不該以為自己是進入點——那會讓考題一 import 就啟動伺服器／跑閘。');
  });
});

// ⚠️ 這四支沒帶參數時會印「用法：…」——**那正是當初壞掉時完全沒有的東西**，
//    拿它當「這支真的有跑起來」的證據。
const GATES_WITH_USAGE = [
  'scripts/check-pr-collab-fields.js',
  'scripts/check-pr-merge-gate.js',
  'scripts/check-review-verdicts.js',
  'scripts/check-cross-pr-merge.js',
];

for (const rel of GATES_WITH_USAGE) {
  test(`${rel}：透過 symlink 執行仍會真的跑起來（不是靜靜 exit 0）`, () => {
    withSymlinkedTemp((dir) => {
      const link = join(dir, 'gate.js');
      symlinkSync(join(ROOT, rel), link);
      // ⚠️ 用 spawnSync 不用 execFileSync：四支閘印用法的方式並不一致
      //    （有的走 stdout＋退出碼 0，有的走 stderr＋退出碼 2），
      //    execFileSync 會為了非零退出碼直接丟例外，那跟本題想驗的事無關。
      //    本題只問一件事：**它到底有沒有跑起來**。
      const r = spawnSync(process.execPath, [link], { encoding: 'utf8' });
      assert.match(`${r.stdout}${r.stderr}`, /用法：/,
        `${rel} 透過 symlink 執行時沒有任何輸出＝main() 沒跑。\n`
        + '對合併程序來說那等於「這道閘通過了」——**靜靜回報通過比沒有閘更糟**。\n'
        + '進入點判斷一律走 lib/is-main.js，不要自己寫一份。');
    });
  });
}

/**
 * 關門：**只有 `lib/is-main.js` 可以碰 `process.argv[1]`。**
 * 不列「哪些寫法是錯的」（`resolve()`／裸比對／`|| ''`／少一邊 realpath… 列不完），
 * 而是宣告誰有資格做這個判斷。
 */
const ALLOWED_ARGV1 = [
  'lib/is-main.js',            // 唯一實作
  'test/entry-guard.test.js',  // 本考題（上面的說明文字提到它）
  // ⚠️ 這支的 argv[1] 是**別的意思**：它組一段給子行程跑的 `node -e` 程式，
  //    在 `-e` 模式下 argv[1] 是使用者傳的第一個參數，不是進入點路徑。
  'test/xlsx-isolate.test.js',
];

test('只有 lib/is-main.js 可以做進入點判斷（不准任何人再寫第二份）', () => {
  const git = (...args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args],
    { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  // ⚠️ **要含未追蹤但沒被忽略的檔案**：只跑 `ls-files` 的話，新寫的檔案自己捏一份守衛，
  //    在 commit 之前這道門完全看不見它——**一道看不見新東西的門，等於沒關**。
  const files = [...new Set([...git('ls-files', '*.js'),
    ...git('ls-files', '--others', '--exclude-standard', '*.js')])];
  const hits = files.filter((f) => readFileSync(join(ROOT, f), 'utf8').includes('argv[1]')).sort();
  assert.deepEqual(hits, [...ALLOWED_ARGV1].sort(),
    '有檔案自己碰了 `process.argv[1]`。\n'
    + '⛔ 「這支是不是被直接執行」的判斷**只准有一份**（`lib/is-main.js`）——\n'
    + '   本專案原本有六份、六種寫法，其中五份會被 symlink 騙，\n'
    + '   而騙到的後果是 `main()` 靜靜不跑、退出碼 0＝**閘回報通過**。\n'
    + '   請改成 `import { isMainModule } from ".../lib/is-main.js"`。\n'
    + '   真的有別的用途（例如子行程的 `node -e` 參數），加進 ALLOWED_ARGV1 並註明理由。');
});
