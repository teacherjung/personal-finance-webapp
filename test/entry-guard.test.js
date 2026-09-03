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
 * 修法不是「把六個地方各修一次」（那還會漂），是收成 `lib/is-main.js` 一支，再關門。
 *
 * ## 這份考題有兩層，而**只有第一層是門**
 *
 * ① **行為層（真正的門）**：每一支腳本，直接執行 vs 經過 symlink 執行，
 *    輸出與退出碼必須一模一樣。**它不問你怎麼寫的，只問跑起來對不對**，
 *    所以任何寫法的壞守衛都躲不掉，新增的腳本也自動被涵蓋（清單從磁碟列舉）。
 *
 * ② **語法層（早期警告，不是保證）**：`eslint.config.js` 的 `ENTRY_GUARD_SELECTORS`。
 *    它的價值是**在你寫壞的當下就用一句話告訴你哪裡錯**，而不是等到考題紅。
 *    ⚠️ **它追不上資料流**——Codex #388 r4／r5 連兩輪用 `process.argv.at(1)`、
 *    `const here = import.meta.url` 繞過去（都是正常的重構寫法，不是刻意規避）。
 *    我補了一層別名的選擇器，但**兩層、經過函式回傳、`globalThis.process` 一樣追不上**，
 *    而且**已驗證**：突變 MB 寫了一支 ESLint 放行的兩層別名守衛，①照樣抓到。
 *    **語法檢查在這件事上不可能收斂，所以它不是門。**
 *
 * ⚠️ **①抓不到什麼**：跑起來沒有可觀察輸出的腳本（見 `NO_OBSERVABLE_OUTPUT` 的宣告），
 *    以及不是「腳本」的檔案（`lib/`、`public/` 底下的模組不會被直接執行）。
 *    `server.js` 也不在①裡——跑它會真的開埠。它靠②盯著。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 產生子行程原始碼要用的 **ESM specifier**。
 *
 * ⚠️ **不可以把絕對路徑原樣塞進 `import … from`**（Codex #433 r2 阻擋②，在實體
 * 「07 專案#a/榮祥森（投資理財）100%」路徑上實測）：`import` 的字串是 **URL**，路徑裡的 `#`
 * 會被當成 fragment 起點 ⇒ Node 只拿 `#` 前面那一截去找檔案，報 `ERR_MODULE_NOT_FOUND`。
 * 本檔兩題在使用者自己的目錄下就是這樣紅的，而純 ASCII 的實作樹完全看不出來。
 * ⇒ 一律走 `pathToFileURL()`：它會把 `#`／`%`／空白／中文都編成安全的 file URL。
 */
const moduleUrl = (/** @type {string} */ rel) => pathToFileURL(join(ROOT, rel)).href;

/** 在 macOS 的 /tmp（本身就是 symlink）底下開一個暫存資料夾。 */
function withSymlinkedTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'entry-guard-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('lib/is-main.js：透過 symlink 執行時仍認得出自己是進入點', () => {
  withSymlinkedTemp((dir) => {
    const real = join(dir, 'real.mjs');
    writeFileSync(real,
      `import { isMainModule } from ${JSON.stringify(moduleUrl('lib/is-main.js'))};\n`
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
      `import { isMainModule } from ${JSON.stringify(moduleUrl('lib/is-main.js'))};\n`
      + `export const answer = isMainModule(import.meta.url);\n`);
    const entry = join(dir, 'entry.mjs');
    writeFileSync(entry, `import { answer } from './lib.mjs';\nconsole.log(answer ? 'MAIN' : 'NOT-MAIN');\n`);
    assert.equal(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim(), 'NOT-MAIN',
      '被 import 的模組不該以為自己是進入點——那會讓考題一 import 就啟動伺服器／跑閘。');
  });
});

/**
 * ★ **真正的門：不問「你怎麼寫的」，問「它跑起來對不對」。**
 *
 * 下面那層 ESLint 選擇器**追不上資料流**——Codex #388 r5 用
 * `const here = import.meta.url; const p = process;` 就繞過去了（那還是正常的重構寫法，
 * 不是刻意規避）。我補了一層別名的選擇器，但**兩層、經過函式回傳、算出來的存取一樣追不上**。
 * 語法檢查在這件事上不可能收斂，所以它只是**早期警告**，不是保證。
 *
 * 這一題不看語法：**每一支腳本，直接執行 vs 經過 symlink 執行，輸出與退出碼必須一模一樣。**
 * 守衛不管用什麼花招寫，只要它會被 symlink 騙，這裡就會看到「直接跑有輸出、
 * 經過 symlink 什麼都沒有」——那正是當初的病徵。
 *
 * ⚠️ **清單從磁碟列舉，不是手寫**：新增的腳本自動被涵蓋。手寫的名單會漂
 *    （這個專案已經因此吃過虧——#385 r9 的守門名單漂了、加了第四道閘卻照樣全綠）。
 */
const SCRIPTS_DIR = 'scripts';

/**
 * 宣告：**跑起來沒有可觀察輸出**的腳本——本題證不了它們，所以要逐一列出理由。
 * ⚠️ 這份宣告是**雙向**的：清單裡的腳本若哪天開始有輸出，下面也會轉紅，
 *    逼人把它移出清單、納入真正的比對。**過期的豁免比沒有豁免更危險。**
 */
const NO_OBSERVABLE_OUTPUT = [
  // 版本合格時完全不出聲（只有不合格才印），而考題造不出一顆不合格的 Node。
  // 它的進入點守衛由「只准 lib/is-main.js 判斷」那層 ESLint 規則盯著。
  'scripts/check-node-version.js',
];

/**
 * 跑三次：**直接兩次**＋經過 symlink 一次。
 *
 * ⚠️ **為什麼要直接跑兩次**：這題靠「兩次執行的輸出相同」判斷守衛有沒有壞，
 *    但如果某支腳本的輸出本身不穩定（含時間戳、隨機值、讀外部狀態），
 *    兩次本來就會不同 ⇒ 這題會變成**誤報**，而誤報會逼人把護欄整個關掉
 *    （**誤擋比漏抓更貴**）。先用「直接跑兩次」量一下它穩不穩，
 *    不穩的話就當場說清楚是「輸出不穩定」而不是「守衛壞了」——
 *    **兩種病要分開講，混在一起的訊息會把人帶去修錯的地方。**
 *
 * ⚠️ 受控 env（只給 `PATH`／`HOME`）：避免 `c6-adversarial.js` 這種吃環境變數的腳本
 *    在考題裡真的連線出去。
 */
function runThrice(rel) {
  return withSymlinkedTemp((dir) => {
    const link = join(dir, 'probe.js');
    symlinkSync(join(ROOT, rel), link);
    const env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '' };
    // timeout（2026-08-22 加）：一支無參數就開始聽的伺服器型腳本，會讓這裡**無聲卡死**（grok-relay.js 第一版實際卡了 10 分鐘）。
    // ⚠️ 光加 timeout 不夠（Codex #496 r1 實測）：被殺的腳本 status 是 null，而 shape() 原本把 null 照樣收進去、
    //    三次比對都是 {status:null,out:'READY'} → 相等 → **照樣綠**。所以 shape() 要把「被殺」變成紅：
    //    status 不是數字＝這支腳本無參數跑不完（伺服器？等 stdin？），那不是「輸出穩定」，是「本題證不了它」。
    const opts = { encoding: 'utf8', env, cwd: ROOT, timeout: 20_000 };
    const shape = (r) => {
      assert.equal(typeof r.status, 'number',
        `${rel} 無參數執行 20 秒內沒結束（${r.error?.code || r.signal || 'status null'}）⇒ 它在無參數時啟動了長駐程序或在等輸入。\n`
        + '專案慣例：scripts/*.js 無參數要印用法、立刻退出。（grok-relay.js 第一版就是這樣卡死整套考題。）');
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    return {
      direct: shape(spawnSync(process.execPath, [join(ROOT, rel)], opts)),
      again: shape(spawnSync(process.execPath, [join(ROOT, rel)], opts)),
      linked: shape(spawnSync(process.execPath, [link], opts)),
    };
  });
}

const ALL_SCRIPTS = readdirSync(join(ROOT, SCRIPTS_DIR))
  .filter((f) => f.endsWith('.js')).map((f) => `${SCRIPTS_DIR}/${f}`).sort();

test('腳本清單不是空的（列舉壞掉的話下面全部會靜靜通過）', () => {
  assert.ok(ALL_SCRIPTS.length >= 5, `scripts/ 只列到 ${ALL_SCRIPTS.length} 支，列舉大概壞了。`);
});

for (const rel of ALL_SCRIPTS.filter((f) => !NO_OBSERVABLE_OUTPUT.includes(f))) {
  test(`⭐ ${rel}：經過 symlink 執行的結果要跟直接執行一模一樣`, () => {
    const { direct, again, linked } = runThrice(rel);
    assert.deepEqual(again, direct,
      `${rel} 直接執行兩次的結果就不一樣了 ⇒ **它的輸出不穩定**（時間戳？隨機值？讀外部狀態？）。\n`
      + '⚠️ 這**不是**守衛壞掉——是本題沒辦法用「兩次比對」證明它。\n'
      + '   請讓它的無參數輸出變穩定，或把它加進 NO_OBSERVABLE_OUTPUT 並寫明理由。');
    assert.notEqual(direct.out.trim(), '',
      `${rel} 直接執行沒有任何輸出 ⇒ **本題證不了它**（跑不跑起來看起來一樣）。\n`
      + '請把它加進 NO_OBSERVABLE_OUTPUT 並寫明理由，不要讓它靜靜留在這裡。');
    assert.deepEqual(linked, direct,
      `${rel} 經過 symlink 執行的結果跟直接執行不同 ⇒ **進入點守衛被 symlink 騙了**。\n`
      + `直接：exit=${direct.status} 輸出=${JSON.stringify(direct.out)}\n`
      + `symlink：exit=${linked.status} 輸出=${JSON.stringify(linked.out)}\n`
      + '⛔ main() 靜靜不跑、退出碼 0＝對合併程序來說就是「這道閘通過了」。\n'
      + '   進入點判斷一律用 lib/is-main.js 的 isMainModule(import.meta.url)。');
  });
}

for (const rel of NO_OBSERVABLE_OUTPUT) {
  test(`${rel}：宣告「沒有可觀察輸出」還成立嗎`, () => {
    assert.ok(ALL_SCRIPTS.includes(rel), `NO_OBSERVABLE_OUTPUT 列了「${rel}」但它不存在，請移除。`);
    const { direct } = runThrice(rel);
    assert.equal(direct.out.trim(), '',
      `${rel} 現在有輸出了 ⇒ 它不該再留在 NO_OBSERVABLE_OUTPUT。\n`
      + '請把它移出清單，讓上面那條真正的比對涵蓋它。');
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
  { 名稱: '★ 一層別名 const here = import.meta.url（Codex r5 示範）',
    code: 'const here = import.meta.url; console.log(here);' },
  { 名稱: '★ 一層別名 const p = process（Codex r5 示範）',
    code: 'const p = process; console.log(p.argv[1]);' },
  { 名稱: '一層別名 const a = process.argv',
    code: 'const a = process.argv; console.log(a[1]);' },
  { 名稱: '★ 拿 import.meta 去比對（語法層的門）',
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

// 第二輪稽核第二批 2B：檔頭「刻意不 try/catch」那句的釘子（2026-09-02 稽核：包上 try/catch 回 false 沒有任何一題會紅）。
test('2B｜lib/is-main.js：進入點路徑解析不了（不存在）→ 大聲炸、非零退出，不可靜靜回 false', () => {
  withSymlinkedTemp((dir) => {
    const script = join(dir, 'probe.mjs');
    writeFileSync(script,
      `import { isMainModule } from ${JSON.stringify(moduleUrl('lib/is-main.js'))};\n`
      + `process.argv[1] = ${JSON.stringify(join(dir, 'ghost-does-not-exist.mjs'))};\n`
      + `console.log(isMainModule(import.meta.url) ? 'MAIN' : 'NOT-MAIN');\n`);
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, `解析不了進入點卻退出 0（stdout=${r.stdout.trim()}）＝靜靜不執行，正是本檔要根治的病`);
    assert.match(r.stderr, /ENOENT/, '要看得到原因（堆疊），不是吞掉');
    assert.ok(!/MAIN/.test(r.stdout), '不可以印出任何判斷結果（MAIN／NOT-MAIN 都不行）');
  });
});
