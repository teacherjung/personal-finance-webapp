// @ts-check
// 「綠燈證據要看對訊號」的考題（2026-08-05，PR #412 第三輪自審）。
//
// 病灶：夜班第四批A 的三則 commit 訊息都把「`grep '^not ok'` 命中 0 筆」列為綠燈證據之一。
// 但 `npm test` 跑出來的是 **spec reporter**，它根本不輸出 TAP 的 `not ok` 行——那條 grep
// **綠的時候是 0、紅的時候還是 0**＝一條永遠不會轉紅的死訊號。實測（2026-08-05，Node v26）：
// 把 `lib/secret-fields.js:183` 的 `slice(-4)` 改成 `slice(0, 4)`，npm test 退出碼 1、
// 摘要 `ℹ fail 1`、`✖ failing` 1 筆，而 `grep -c '^not ok'` 依然回 0。
// 那三則 commit 同時引了退出碼與 `ℹ fail 0` 兩個真訊號，所以結論本身沒被帶偏；
// 但只照那條 grep 判斷的人，會在紅的套件上回報綠——「什麼都沒做卻回報通過」比沒有護欄更糟。
//
// 這個檔案釘三件事（文件會漂，訊號不會）：
//   ① `npm test` 的 reporter **不可以是預設值**——`node --test` 的預設 reporter 隨 Node 版本／
//      stdout 是不是 TTY 而變，而本專案的 CI 有兩顆不同的 Node（`.node-version` 的上線那顆、
//      dev-machine 的最新那顆）。不明寫的話，AGENTS.md 教的 grep 註定有一邊是錯的。
//   ② 那個 reporter（現行＝spec）的真訊號＝`✖ failing` 的筆數（綠 0／紅 1）與摘要行 `ℹ fail N`
//      的 N；`^not ok` **綠紅都是 0**。⚠️ 這兩題的 reporter 是**從 package.json 讀出來的**，
//      不是寫死 spec——寫死的話，有人把腳本換成別的 reporter，這裡還是在驗一個沒人在跑的格式。
//   ③ tap 剛好相反：`^not ok` 才會出現，`✖ failing` 一筆都沒有——**換 reporter 就要換 grep**。
// 唯一與 reporter 無關的真訊號是**退出碼**（`mutate.sh` 判紅綠就是只看它，所以它沒踩到這個坑）。
//
// ⚠️ 誠實劃界（不要把本檔讀成比它更強的東西）：
//   ・本檔用的是**另外生一個小考題檔、開子行程跑**的探針，不是「跑一次真正的 npm test」——
//     那會遞迴。所以它證明的是「這個 Node runtime 的 reporter 會吐什麼」，
//     不是「本專案這一輪 1500 多題的輸出長什麼樣」。
//   ・第③題的 `tap` 是寫死的（它就是在驗「另一個 reporter 的訊號長得不一樣」）；
//     它只會在 Node 改掉 TAP 輸出格式時轉紅。
//   ・AGENTS.md 那一題只驗**關鍵字在不在**（整段被刪會轉紅），文字寫歪了它抓不到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 生一個「一題必過＋一題可紅可綠」的探針考題檔，用指定 reporter 跑，回傳退出碼與輸出。
 * ⚠️ 檔案一定要落在暫存目錄、**不可放在 `test/` 底下**——`node --test` 會把 `test/**` 全當考題載入。
 * ⚠️ 副檔名用 `.mjs`：暫存目錄沒有 `package.json`，`.js` 會被當 CommonJS，探針自己先語法錯。
 * @param {{ red: boolean, reporter: string }} opt
 * @returns {{ status: number|null, out: string }}
 */
function runProbe({ red, reporter }) {
  const dir = mkdtempSync(join(tmpdir(), 'test-signals-'));
  try {
    const file = join(dir, 'probe.test.mjs');
    writeFileSync(file, [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('一定會過的題', () => { assert.equal(1, 1); });",
      `test('成敗是本檔的自變數', () => { assert.equal(1, ${red ? 2 : 1}); });`,
      '',
    ].join('\n'));
    // ⚠️ 一定要把 `NODE_TEST_CONTEXT` 從子行程的環境拿掉：本檔自己是被 `node --test` 載入的，
    //    這個變數會被繼承下去，子行程就以為自己是「考題檔行程」而**印一行警告、一題都不跑**
    //    （實測：退出碼 0、輸出只有 recursively 的警告 ⇒ 上面每一條計數都會變成在數空字串）。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file], {
      encoding: 'utf8', cwd: dir, env,
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} out @param {RegExp} re */
const hits = (out, re) => (out.match(re) || []).length;

/**
 * `npm test` **實際**會用的 reporter——從 `package.json` 的腳本讀出來，**不寫死**。
 * 寫死的話，有人把腳本改成別的 reporter，下面兩題還是在驗 spec ＝ 驗一個沒人在跑的格式，
 * 而 AGENTS.md 教的 grep 早就失效了卻全綠。
 * @returns {string|null} 沒有明寫旗標就回 null（＝落回 Node 的預設值，那正是本檔在防的事）
 */
function npmTestReporter() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const m = String(pkg.scripts?.test ?? '').match(/--test-reporter=(\S+)/);
  return m ? m[1] : null;
}

const PINNED = 'package.json 的 test 腳本沒有明寫 --test-reporter=<reporter>。\n'
  + '沒釘的話輸出格式就由 Node 的預設值決定（會隨版本與 stdout 是不是 TTY 而變，'
  + '而 CI 有兩顆不同版本的 Node），AGENTS.md 教的 grep 就會有一邊是「紅了也不會命中」的死訊號。';

test('npm test 必須明寫 reporter——預設值隨 Node 版本／TTY 而變，文件教的 grep 就會有一邊是死的', () => {
  assert.equal(npmTestReporter(), 'spec',
    `${PINNED}\n（現行約定＝spec；真要換成別的，AGENTS.md 那張訊號對照表必須同一支 PR 一起改。）`);
});

// ⚠️ **下面三題的題名刻意不寫那些標記的字面字串**（TAP 的失敗行、叉號開頭的失敗區塊標題、
//    資訊符號開頭的摘要行）。第一版寫了，結果**全綠**那一輪 `grep -c '✖ failing'` 命中 **3 筆**
//    ——命中的正是這三行題名，等於我親手把剛寫進 AGENTS.md 的訊號污染成「綠燈也有命中」。
//    題名是 reporter **唯一**在成功時也會印出來的自訂字串（斷言訊息只在失敗時印），
//    所以只有它需要這道自律。另一半的解法在 AGENTS.md：那條 grep 一律**錨在行首**
//    （失敗區塊標題在第 0 欄，題名前面一定有 `✔ `／`✖ ` 加一個空格）。
test('npm test 的 reporter 跑紅燈：TAP 的失敗行一筆都沒有（那條 grep 是死訊號），真訊號是失敗區塊與摘要行', () => {
  const reporter = npmTestReporter();
  assert.ok(reporter, PINNED);
  const { status, out } = runProbe({ red: true, reporter });
  assert.notEqual(status, 0, '探針考題沒有真的紅——本題的前提不成立，後面的計數全部沒有意義');
  assert.match(out, /^ℹ fail 1$/m, `${reporter} 的摘要行應該是 \`ℹ fail 1\`（AGENTS.md 教的就是這條）`);
  assert.match(out, /^ℹ pass 1$/m, `${reporter} 的摘要行應該是 \`ℹ pass 1\`（探針是一過一敗）`);
  assert.equal(hits(out, /^✖ failing/gm), 1, `${reporter} 紅燈應該有一行 \`✖ failing tests:\``);
  assert.equal(hits(out, /^not ok/gm), 0,
    `${reporter} 竟然輸出了 TAP 的 \`not ok\` 行——reporter 的行為變了。\n`
    + '這代表 AGENTS.md 那張訊號對照表已經過期，請重跑一次實測再改文件（不要照抄舊結論）。');
});

test('npm test 的 reporter 跑綠燈：TAP 失敗行一樣是 0（＝那條 grep 分不出紅綠），失敗區塊才會歸零', () => {
  const reporter = npmTestReporter();
  assert.ok(reporter, PINNED);
  const { status, out } = runProbe({ red: false, reporter });
  assert.equal(status, 0, '綠燈探針的退出碼應該是 0');
  assert.match(out, /^ℹ fail 0$/m, `${reporter} 的摘要行應該是 \`ℹ fail 0\``);
  assert.equal(hits(out, /^✖ failing/gm), 0, `${reporter} 綠燈不該有 \`✖ failing\``);
  assert.equal(hits(out, /^not ok/gm), 0,
    '綠燈的 `^not ok` 命中數必須與紅燈那一題相同（都是 0）——這兩題合起來才是「死訊號」的證據');
});

test('tap 紅燈：換 reporter 就要換 grep——TAP 的失敗行才會出現，spec 的失敗區塊反而一筆都沒有', () => {
  const { status, out } = runProbe({ red: true, reporter: 'tap' });
  assert.notEqual(status, 0, '探針考題沒有真的紅——本題的前提不成立');
  assert.equal(hits(out, /^not ok/gm), 1, 'tap 紅燈應該有一行 `not ok`（一過一敗的探針）');
  assert.match(out, /^# fail 1$/m, 'tap 的摘要行叫 `# fail 1`，不是 `ℹ fail 1`');
  assert.equal(hits(out, /^✖ failing/gm), 0,
    'tap 不輸出 `✖ failing`——所以在 tap 底下 grep `✖ failing` 反過來變成死訊號');
});

test('這一課要寫在 AGENTS.md 裡（只留在 commit 訊息＝下一個人照樣踩）', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('^not ok'),
    'AGENTS.md 沒有點名 `^not ok` 這條死訊號。三份 commit 訊息把它當綠燈證據引用過，'
    + '規則不寫在讀者會讀的那份檔案裡＝等於不存在。');
  assert.ok(agents.includes('✖ failing') && agents.includes('ℹ fail'),
    'AGENTS.md 只說了「不要用哪條 grep」卻沒說「該用哪條」——那會逼下一個人自己發明一條');
  assert.ok(agents.includes('--test-reporter=tap'),
    'AGENTS.md 沒寫「要 TAP 就得明寫 --test-reporter=tap」——'
    + '不然讀者只知道 `^not ok` 是死的，不知道什麼情況下它才是活的');
});
