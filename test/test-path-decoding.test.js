import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT, assertSameCheckout } from './helpers/repo-root.js';

/**
 * ⚠️ 為什麼要有這一檔（2026-08-08 事故）：
 * `new URL(<相對路徑>, import.meta.url).pathname` 留著 URL 編碼。本專案實際落在
 * 「07 專案/榮祥森（投資理財）」這種含**空白與中文**的路徑下，於是算出
 * `.../07%20%E5%B0%88%E6%A1%88/...` ⇒ 掃描原始碼的考題 `readFileSync` 直接 ENOENT。
 *
 * 這個病的形狀最惡：#417 的實作樹與十四棵審查樹都落在純 ASCII 的 `/private/tmp/…`
 * ＝四題全綠、十四輪審查也全綠；**合併進 main、在使用者自己的目錄跑才紅。**
 * ⇒ 「考題在開發者機器上綠」不代表「在使用者機器上綠」，路徑是這條分界線上最常見的那顆雷。
 *
 * ⚠️⚠️ **本檔只守「共用 ROOT 這道門」**（複驗者 r18 判斷「乙」，2026-08-09）：
 * 原本另有一層「掃全樹、禁止任何人取 file URL 的 `.pathname`」的早期警告，
 * r2–r18 十七輪都在修它本身（AST 判斷、作用域、git 列檔、環境隔離、UTF-8／BOM、大小寫碰撞…），
 * 每一輪都找得到新的假紅或假綠 ⇒ 判定維護成本已高於它在本支的收益，**整層移出另開一支**。
 * 那支要先釐清的四件事（複驗者 r18 實測出來的）：
 *   ①`TextDecoder(fatal)` 會**靜默剝掉 BOM** ⇒ `a.js` 與 BOM 開頭的同名檔仍折成同一字串
 *   ②兩條 fail-closed 各有 **adapter 層假綠**（`encoding:'utf8'` 加回去／resolver 不走 realpath 都仍全綠）
 *   ③碰撞規則會**誤殺合法的受版控 symlink alias**
 *   ④「staged 但工作樹已改」實測不會 fail-closed（射程是工作樹內容，不是 index blob）
 * ⇒ 現在的門就是 `test/helpers/repo-root.js`：**唯一一份會驗身分的 ROOT ＋載入時斷言**。
 *
 * ⚠️ **本檔守的是「路徑不是 URL」這個病根的兩種形狀**，兩種都是行為題：
 *   ①**URL → 路徑少解一次**：`.pathname` 留著 `%20`／`%E5%…` ⇒ `readFileSync` ENOENT（下面的⭐⭐核心）。
 *   ②**路徑 → URL 少編一次**：絕對路徑原樣塞進 `import … from` ⇒ `#` 之後整段被當 fragment 丟掉
 *     （下面的⭐⭐核心之二）。②是複驗者 r2 阻擋②在**實體**特殊路徑上量出來的，同一支 PR 一起修。
 */

test('⭐ 真的門｜餵一個「另一棵 checkout」的 root 進去必須被拒絕（r6 阻擋④＝行為題，不是掃字樣）', () => {
  // ⚠️ 上一版這一題只掃原始碼有沒有 `realpathSync` 字樣。複驗者把比較改成「拿自己比自己」
  //    （`realpathSync(join(ROOT, SELF_REL)) !== realpathSync(join(ROOT, SELF_REL))`）之後
  //    身分防線完全失效，而該檔 7/7、全套 1736/1736 仍綠。
  //    ⇒ 本專案的鐵則：**考題要斷言行為，不是文字**。改成真的餵 root 進去。

  // ⓐ 正確的 root（就是這一棵）要通過
  assert.doesNotThrow(() => assertSameCheckout(ROOT, join(ROOT, 'test', 'helpers', 'repo-root.js')),
    '這一棵樹自己的 root 被拒絕了＝門壞了，全部考題都會紅');

  // ⓑ **另一棵有效 checkout**（有 package.json、也有同名 helper）必須被拒絕
  const other = mkdtempSync(join(tmpdir(), 'other-checkout-'));
  try {
    writeFileSync(join(other, 'package.json'), '{"name":"fake"}');
    mkdirSync(join(other, 'test', 'helpers'), { recursive: true });
    writeFileSync(join(other, 'test', 'helpers', 'repo-root.js'), '// 假的\n');
    assert.throws(
      () => assertSameCheckout(other, join(ROOT, 'test', 'helpers', 'repo-root.js')),
      /另一棵 checkout/,
      '指到另一棵有效 checkout 卻沒被拒絕＝掃描器會靜靜掃別棵樹、回報「零違規」',
    );
  } finally {
    rmSync(other, { recursive: true, force: true });
  }

  // ⓒ 根本不是 repo 根（沒有 package.json）也要被拒絕，而且訊息要不一樣（診斷得出是哪一種）
  const empty = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
  try {
    assert.throws(() => assertSameCheckout(empty, join(ROOT, 'test', 'helpers', 'repo-root.js')),
      /找不到 package.json/, '不是 repo 根卻通過了');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('⭐ 真的門的**接線**｜載入時必須傳「正在執行的這一支」，不是 join(ROOT, …)（r7 阻擋①）', () => {
  // ⚠️ 上一題只驗匯出函式在「測試傳入可信 selfPath」時的行為。複驗者把正式呼叫改成
  //    `assertSameCheckout(ROOT, join(ROOT, SELF_REL))` ⇒ 又變成自己比自己，而考題仍 7/7 全綠。
  //    ⇒ 這一題驗**接線**：把 helper 複製到別的地方、只把它的 ROOT 改成指向真的 repo，
  //       然後在子行程 import 它。
  //       ・接線正確（傳執行中檔案）⇒ here=複本、there=真 repo 的那支 ⇒ 不相等 ⇒ **載入失敗**
  //       ・接線壞掉（傳 join(ROOT, SELF_REL)）⇒ 兩邊都是真 repo 的那支 ⇒ 相等 ⇒ 載入成功（假綠）
  const fake = mkdtempSync(join(tmpdir(), 'wiring-'));
  try {
    mkdirSync(join(fake, 'test', 'helpers'), { recursive: true });
    writeFileSync(join(fake, 'package.json'), '{"name":"fake"}');
    const src = readFileSync(join(ROOT, 'test', 'helpers', 'repo-root.js'), 'utf8');
    const patched = src.replace(
      /export const ROOT = .*/,
      `export const ROOT = ${JSON.stringify(ROOT)};`,
    );
    assert.notEqual(patched, src, '沒改到 ROOT 那一行＝這一題在空轉');
    const copy = join(fake, 'test', 'helpers', 'repo-root.js');
    writeFileSync(copy, patched);

    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import(${JSON.stringify(pathToFileURL(copy).href)}).then(() => process.exit(0), () => process.exit(3));`],
    { encoding: 'utf8' });
    assert.equal(r.status, 3,
      '把 helper 搬到別的樹、ROOT 卻指向真 repo，載入居然成功了——'
      + '⇒ 載入時傳的不是「正在執行的這一支」（很可能寫成 join(ROOT, SELF_REL) ＝自己比自己），'
      + '身分防線等於不存在，而掃描器會靜靜掃別棵樹。');
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test('⭐⭐ 核心｜共用 ROOT 在「含空白與中文的路徑」下必須算對（r11 阻擋②：本 PR 修的就是這件事）', () => {
  // ⚠️⚠️ **這是這支 PR 的核心行為題，也是它整個存在的理由。**
  //    複驗者 r11 把 helper 改壞成一種**射程外的自然寫法**：
  //        const selfUrl = new URL(import.meta.url);
  //        export const ROOT = join(dirname(selfUrl.pathname), '..', '..');
  //    ASCII 副本裡 42/42、全套 1739/1739 **全綠**；同一個突變放到中文＋空白路徑就全部在載入時炸掉。
  //    ⇒ 也就是說「這支 PR 修好的事」只有在審查者**手動換路徑**時才驗得到 ⇒ 假綠。
  //    ⇒ 本題自己把 helper 複製到含空白與中文的暫存目錄、真的 import 它、驗算出來的 ROOT。
  //    不論錯誤寫成哪一種 AST 形狀（`.pathname`、`fileURLToPath` 拿掉、層數算錯…）都會紅。
  const base = mkdtempSync(join(tmpdir(), 'core-'));
  try {
    // 目錄名同時含**空白**、**中文**、**全角括號**（與使用者真實的「07 專案/榮祥森（投資理財）」同型）
    // ⚠️ 再加 `#` 與 `%`（r12 註記）：只有這兩個字元能區分「真的解碼」與「用 decodeURI 混過去」——
    //    複驗者實測 `decodeURI(new URL(import.meta.url).pathname)` 在只有空白／中文的路徑下**也會過**，
    //    但遇到 `#` 會留下 `%23`、遇到字面 `%` 會解錯。⇒ 少了這兩個字元，本題的射程就沒有涵蓋那一類突變。
    const repo = join(base, '07 專案#a', '榮祥森（投資理財）100%');
    mkdirSync(join(repo, 'test', 'helpers'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"name":"fixture"}');
    const helperSrc = readFileSync(join(ROOT, 'test', 'helpers', 'repo-root.js'), 'utf8');
    writeFileSync(join(repo, 'test', 'helpers', 'repo-root.js'), helperSrc);

    const probe = join(repo, 'probe.mjs');
    writeFileSync(probe,
      `import { ROOT } from ${JSON.stringify(pathToFileURL(join(repo, 'test', 'helpers', 'repo-root.js')).href)};\n`
      + 'process.stdout.write(ROOT);\n');
    const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' });

    assert.equal(r.status, 0,
      '共用 ROOT 在含空白／中文的路徑下載入失敗——這正是本 PR 要修的病。\n'
      + `stderr：${String(r.stderr).slice(0, 600)}`);
    // ⚠️ 預期值要過 `realpathSync`：macOS 的 `/var` 是 `/private/var` 的 symlink，
    //    而 Node 載入模組時會解析成真實路徑（實測踩到——這不是編碼問題，別誤判成本 PR 的病）。
    const expectedRoot = realpathSync(repo);
    assert.equal(r.stdout, expectedRoot,
      `共用 ROOT 算出來的路徑不等於真實目錄。\n  算出＝${r.stdout}\n  應為＝${expectedRoot}\n`
      + '（若出現 %20／%E5%…／%23 就是沒有解 URL 編碼——那正是本 PR 修的那一顆。）');
    assert.doesNotMatch(r.stdout, /%[0-9A-Fa-f]{2}/, 'ROOT 裡仍含百分號編碼');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('⭐⭐ 核心之二｜絕對路徑不可以直接當 ESM specifier（`#` 會被當成 fragment）', () => {
  // ⚠️⚠️ 同一個病根的第二種形狀：**路徑不是 URL**。上面那題是「URL → 路徑」少解一次，
  //    這一題是「路徑 → URL」少編一次——`import … from '<字串>'` 的字串是 **URL**，
  //    所以路徑裡的 `#` 是 fragment 起點，Node 只拿 `#` 前面那一截去找檔案。
  //    複驗者（r2 阻擋②）用 `git archive` 建**實體**副本、路徑 `07 專案#a/榮祥森（投資理財）100%`
  //    跑全套：`entry-guard`／`robustness`／`securities-migration` 共 8 處把絕對路徑原樣塞進
  //    子行程原始碼的 `import`，結果 **7 題 `ERR_MODULE_NOT_FOUND`**（我實測同一份：1740 pass／7 fail）。
  //    ⚠️ 形狀與 #417 那四題一模一樣：**純 ASCII 的實作樹與審查樹完全看不出來**。
  //    ⇒ 本題兩邊都驗：原樣塞**必須失敗**（否則這一題在空轉、綠得沒有意義），
  //      `pathToFileURL(path).href` **必須成功**（那就是那 8 處改用的方法）。
  const base = mkdtempSync(join(tmpdir(), 'spec-'));
  try {
    const repo = join(base, '07 專案#a', '榮祥森（投資理財）100%');
    mkdirSync(join(repo, 'lib'), { recursive: true });
    const dep = join(repo, 'lib', 'dep.mjs');
    writeFileSync(dep, 'export const mark = "MARK-OK";\n');
    const run = (/** @type {string} */ spec) => spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { mark } from ${JSON.stringify(spec)};\nprocess.stdout.write(mark);\n`], { encoding: 'utf8' });

    // ⓐ 反面（證明這一題不是在空轉）：原樣塞絕對路徑一定失敗，而且是**被 `#` 切掉**那一種
    const raw = run(dep);
    assert.notEqual(raw.status, 0,
      '把絕對路徑原樣當 specifier 竟然載得進來——那表示這一題在這台機器上證不了東西，'
      + '下面那半的綠就沒有意義（先確認暫存目錄名真的含 `#`）。');
    assert.match(String(raw.stderr), /ERR_MODULE_NOT_FOUND/,
      `失敗原因不是「找不到模組」＝這一題量到的是別的東西。\nstderr：${String(raw.stderr).slice(0, 400)}`);
    assert.match(String(raw.stderr), /07 專案'/,
      'Node 應該只拿 `#` 前面那一截去找檔案（那正是病徵）——錯誤訊息裡沒看到被切斷的路徑，'
      + `表示這一題抓到的不是同一個病。\nstderr：${String(raw.stderr).slice(0, 400)}`);

    // ⓑ 正面：同一支模組，換成 file URL 就必須載得進來
    const viaUrl = run(pathToFileURL(dep).href);
    assert.equal(viaUrl.status, 0,
      '過了 pathToFileURL(...).href 仍載不進來——本 PR 那 8 處用的就是這個方法，'
      + `它壞掉的話那 8 處也是壞的。\nstderr：${String(viaUrl.stderr).slice(0, 600)}`);
    assert.equal(viaUrl.stdout, 'MARK-OK', '載進來了但拿到的不是那支模組的值');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * ⚠️ **誠實劃界（核心之二抓不到什麼）**：本題證明的是**方法**（原樣塞會壞、`pathToFileURL` 會對），
 * **不是**「repo 裡沒有人再那樣寫」。原本要接那一層的是被 c32906f 移出本支的全樹掃描，
 * 所以現在**沒有任何靜態層在守這 8 處會不會被改回去**——真正的驗收是
 * **在含 `#`／`%`／空白／中文的實體路徑上跑全套**（本支 PR 說明裡有數字）。
 * 這條缺口與掃描層一起記在接手那支的待辦，不假裝已經覆蓋。
 */

test('ROOT 這一顆真的指到 repo 根（否則上面幾題就是在空掃）', () => {
  assert.ok(existsSync(join(ROOT, 'package.json')), 'ROOT 沒指到 repo 根，上面那題等於什麼都沒掃');
});
