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
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * 關門：**「這支是不是被直接執行」的判斷只准有一份。**
 *
 * ⚠️ 上一版用 `.includes('argv[1]')` 掃字串，Codex #388 r4 一行 `process.argv.at(1)`
 *    就繞過去了（他實際建檔示範，考題照樣 7/7 全綠）。
 *    **又一次列舉：我列了一種拼法，而同一件事有很多種寫法**
 *    （`.at(1)`／`process["argv"][1]`／解構／`slice(1)[0]`／動態索引…）。
 *
 * 正解是**堵語法不是堵字串**，而且交給已經在跑的 ESLint（跟 xlsx 收斂點護欄同一個做法），
 * 選擇器寫在 `eslint.config.js` 的 `ENTRY_GUARD_SELECTORS`。
 * 其中**最後一條才是真正的門**：不管用什麼花招取到進入點路徑，
 * 手寫的守衛終究得拿它去跟 `import.meta.url` 比對——那是單一、封閉的形狀。
 *
 * ⚠️ 下面這一題**實際跑 ESLint**，不是檢查「設定檔裡有沒有寫那幾行」。
 *    差別是真的：我第一版把選擇器放成獨立一組，`npm run lint` 全綠，
 *    `--print-config` 一看才發現 **flat config 的同名規則是「後面整組覆蓋前面」不是合併**，
 *    我的選擇器被 xlsx 那組整個蓋掉、從來沒跑過。
 *    **「設定有寫」不等於「規則有跑」——所以這題要看它真的開火。**
 */
const BYPASSES = [
  { 名稱: '直球 process.argv[1]',            code: 'const a = process.argv[1]; console.log(a);' },
  { 名稱: '★ .at(1)（Codex r4 示範的繞法）',  code: 'const a = process.argv.at(1); console.log(a);' },
  { 名稱: '算出來的 process["argv"]',        code: 'const a = process["argv"][1]; console.log(a);' },
  { 名稱: '解構 const { argv } = process',    code: 'const { argv } = process; console.log(argv[1]);' },
  { 名稱: 'slice(1)[0]',                      code: 'const a = process.argv.slice(1)[0]; console.log(a);' },
  { 名稱: '動態索引 process.argv[i]',         code: 'const i = 1; console.log(process.argv[i]);' },
  { 名稱: '★ 拿 import.meta 去比對（真正的門）',
    code: 'import { pathToFileURL } from "node:url";\n'
      + 'if (import.meta.url === pathToFileURL("x").href) console.log(1);' },
];

// 合法寫法：不可以被誤擋（誤擋比漏抓更貴——它會逼人把護欄關掉）
const LEGIT = [
  { 名稱: '使用者參數 process.argv.slice(2)', code: 'console.log(process.argv.slice(2));' },
  { 名稱: '第一個使用者參數 process.argv[2]', code: 'console.log(process.argv[2]);' },
  { 名稱: '算路徑用的 import.meta.url',
    code: 'import { fileURLToPath } from "node:url";\nconsole.log(fileURLToPath(import.meta.url));' },
  { 名稱: '正確用法 isMainModule(import.meta.url)',
    code: 'import { isMainModule } from "../lib/is-main.js";\nif (isMainModule(import.meta.url)) console.log(1);' },
];

/**
 * 用真正的 ESLint 跑一段程式碼，回傳**進入點護欄**報的錯。
 * ⚠️ 「哪些錯算進入點護欄報的」是拿設定檔匯出的清單**逐字比對**，不是用關鍵字猜——
 *    上一版用 `/進入點|process\.argv|import\.meta/` 猜，**猜漏了兩條**
 *    （「不要用算出來的方式存取 process 的欄位」「不要把 process 解構」都不含那些字），
 *    於是規則明明開火了，考題卻判它沒開火。**又一次列舉。**
 */
async function entryGuardErrors(code) {
  const [{ ESLint }, cfg] = await Promise.all([
    import('eslint'), import(pathToFileURL(join(ROOT, 'eslint.config.js')).href)]);
  const ours = new Set(cfg.ENTRY_GUARD_SELECTORS.map((r) => r.message));
  assert.ok(ours.size === cfg.ENTRY_GUARD_SELECTORS.length,
    'ENTRY_GUARD_SELECTORS 有兩條訊息一字不差 ⇒ 比對會混在一起，請把訊息寫得可分辨。');
  const results = await new ESLint({ cwd: ROOT }).lintText(code,
    { filePath: join(ROOT, 'scripts', 'entry-guard-probe.js') });
  return (results[0]?.messages || [])
    .filter((m) => m.ruleId === 'no-restricted-syntax' && ours.has(m.message));
}

for (const { 名稱, code } of BYPASSES) {
  test(`ESLint 擋得住：${名稱}`, async () => {
    const errs = await entryGuardErrors(code);
    assert.ok(errs.length > 0,
      `這段程式碼沒有被進入點護欄擋下來：\n${code}\n\n`
      + '⛔ 「這支是不是被直接執行」的判斷只准有一份（lib/is-main.js）——\n'
      + '   本專案原本有六份、六種寫法，其中五份會被 symlink 騙，\n'
      + '   而騙到的後果是 main() 靜靜不跑、退出碼 0＝**閘回報通過**。\n'
      + '   選擇器在 eslint.config.js 的 ENTRY_GUARD_SELECTORS。\n'
      + '   ⚠️ 如果你剛加了一組新的 no-restricted-syntax：flat config 是**後面整組覆蓋前面**，\n'
      + '      不是合併——請接進同一個陣列，不要另開一組。');
  });
}

for (const { 名稱, code } of LEGIT) {
  test(`ESLint 不會誤擋：${名稱}`, async () => {
    const errs = await entryGuardErrors(code);
    assert.equal(errs.length, 0,
      `合法寫法被誤擋了：\n${code}\n實得：${errs.map((e) => e.message).join(' / ')}\n`
      + '⚠️ 誤擋比漏抓更貴——它會逼人把護欄整個關掉。');
  });
}
