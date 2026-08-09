import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, dirname, basename } from 'node:path';
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
 * ⚠️⚠️ **本檔不含任何全樹靜態掃描**（複驗者 r18 判斷「乙」，2026-08-09）：
 * 原本另有一層「掃全樹、禁止任何人取 file URL 的 `.pathname`」的早期警告，
 * r2–r18 十七輪都在修它本身（AST 判斷、作用域、git 列檔、環境隔離、UTF-8／BOM、大小寫碰撞…），
 * 每一輪都找得到新的假紅或假綠 ⇒ 判定維護成本已高於它在本支的收益，**整層移出另開一支**。
 * 那支要先釐清的四件事（複驗者 r18 實測出來的）：
 *   ①`TextDecoder(fatal)` 會**靜默剝掉 BOM** ⇒ `a.js` 與 BOM 開頭的同名檔仍折成同一字串
 *   ②兩條 fail-closed 各有 **adapter 層假綠**（`encoding:'utf8'` 加回去／resolver 不走 realpath 都仍全綠）
 *   ③碰撞規則會**誤殺合法的受版控 symlink alias**
 *   ④「staged 但工作樹已改」實測不會 fail-closed（射程是工作樹內容，不是 index blob）
 * ⇒ 身分那道門改由 `test/helpers/repo-root.js` 一份實作＋它自己的載入時斷言承擔。
 *
 * ⚠️ **本檔守的是「路徑不是 URL」這個病根的兩種形狀，外加②的接線**，全部是行為題（沒有掃字樣的題）：
 *   ①**URL → 路徑少解一次**：`.pathname` 留著 `%20`／`%E5%…` ⇒ `readFileSync` ENOENT（下面的⭐⭐核心）。
 *   ②**路徑 → URL 少編一次**：絕對路徑原樣塞進 `import … from` ⇒ `#` 之後整段被當 fragment 丟掉
 *     （下面的⭐⭐核心之二）。②是複驗者 r2 阻擋②在**實體**特殊路徑上量出來的，同一支 PR 一起修。
 *   ③②的**接線**：核心之二證明的只是「方法」，所以另有一組題把 repo 裡**正式**在算 ESM specifier
 *     的三顆（`TOUCHPOINTS`）搬到含 `#` 的實體路徑上真的跑一次——少了它，把那三顆改回原樣塞絕對路徑
 *     時本檔仍會全綠（複驗者 r3 實測：正式接點全改壞 ⇒ 正式考題 7 題紅、本檔 5/5 綠）。
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
      '指到另一棵有效 checkout 卻沒被拒絕＝凡是 import 本 helper `ROOT` 的考題，'
      + '都會靜靜讀到**別棵樹**的檔案，量到的是那棵樹的狀態',
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
      + '身分防線等於不存在，import 本 helper `ROOT` 的考題會靜靜讀到別棵樹的檔案。');
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
 * ⚠️ **核心之二只證明「方法」，不證明「正式的那幾處真的用了它」**——下面這一組題接的就是這一段。
 *
 * 複驗者 r3 的實測（阻擋①）：把三支正式考題算 specifier 的那一顆全部改回原樣塞絕對路徑，
 * 在實體特殊路徑下**正式考題紅 7 題、本檔仍 5/5 全綠** ⇒ 核心之二綁的是它自己造的 `dep.mjs`。
 *
 * `TOUCHPOINTS` 就是那三顆。`dceae9a` 把「絕對路徑塞進子行程原始碼 `import`」的 8 個位置改掉時，
 * 是讓三支考題各自收斂到一顆共用的 specifier 來源（`moduleUrl`／`STORE_URL`／`REPO_URL`）——
 * 綁住這三顆，那一批使用點就都在同一條線上。⚠️ 使用點會不會**繞過**這三顆，見下面的誠實劃界。
 */
const TOUCHPOINTS = [
  { file: 'test/entry-guard.test.js', name: 'moduleUrl', expr: "moduleUrl('lib/is-main.js')", rel: 'lib/is-main.js' },
  { file: 'test/robustness.test.js', name: 'STORE_URL', expr: 'STORE_URL', rel: 'lib/store.js' },
  { file: 'test/securities-migration.test.js', name: 'REPO_URL', expr: 'REPO_URL', rel: 'lib/repo.js' },
];

/**
 * 切出「從檔頭到 `name` 這一句宣告結束」的前綴，好把**正式接點自己那一行**原樣搬進探針執行。
 *
 * ⚠️ 為什麼是切前綴、不是複製整份：三支正式考題的宣告之後就是會起伺服器、開資料庫、列舉
 * `scripts/` 的正題；整份搬過去要連 `lib/`、`node_modules` 一起搬。切在宣告結束處，前面只剩
 * `import`（全是 node 內建）＋`ROOT`＝乾淨、沒有副作用。
 *
 * ⚠️ **誠實劃界**：切點是靠「行首的宣告關鍵字」＋括號配對＋頂層分號找的，**認不出來就 fail-closed 轉紅**
 * （寧可誤紅也不要靜靜綠）。⚠️ 但它是**窄 harness、不是 lexer**：不解析註解／字串／ASI——
 * 那位審查者 r5 實測：行內註解裡的 `;` 會被當成頂層分號（`{…} // ;` 換行接 `.href ?? <絕對路徑>`
 * ＝真值不安全、本題仍全綠）；ASI 無分號宣告則會吃到下一句的分號。
 * ⇒ **不承諾「宣告被改壞就一定紅」**；同族新寫法仍可能假綠。它擋的是天然發生的形狀
 * （r4 的兩型已釘成回歸題），刻意繞它的寫法擋不住，最終驗收照舊＝實體特殊路徑跑全套。
 *
 * @param {string} src 正式考題的原始碼
 * @param {string} name 接點的識別字
 * @param {string} where 出錯訊息要指出的檔案
 * @returns {string} 含該宣告在內的前綴
 */
function prefixThroughDeclaration(src, name, where) {
  const head = new RegExp(String.raw`^(?:export\s+)?(const|let|var|function)\s+${name}\b`, 'm');
  const m = head.exec(src);
  assert.ok(m, `${where} 找不到行首的頂層宣告 \`${name}\`——`
    + '本題靠它把正式接點搬進探針，找不到就等於沒在綁任何東西（所以這裡直接紅）。\n'
    + '若接點真的改名或改結構了，請同步更新本檔的 TOUCHPOINTS。');
  // ⚠️ **結尾依宣告種類決定**（那位審查者 r4 的阻擋，兩顆突變實測）：
  //    舊版在深度回到 0 時遇到任何 `}` 就當結尾——但 `const x = {…}.href` 的物件 initializer
  //    之後**還可以合法接屬性或運算式**，切在 `}` 會拿到半句：
  //    ・假紅：`{ href: … }.href`（值安全）被切成 `[object Object]` ⇒ 探針錯紅
  //    ・假綠：`{ toString(){…} }.href ?? <原始絕對路徑>`（值已退回不安全）⇒ 切出的半句反而安全 ⇒ 全綠
  //    ⇒ `const/let/var` 只能在**頂層分號**結束；只有 `function` 才能在本體的配對 `}` 結束。
  const kind = m[1];
  let depth = 0;
  for (let i = m.index; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      assert.ok(depth >= 0, `${where} 的 \`${name}\` 宣告括號配對不起來 ⇒ 切點不可信，本題不敢當它是真的（fail-closed）`);
      if (depth === 0 && ch === '}' && kind === 'function') return src.slice(0, i + 1);
    } else if (ch === ';' && depth === 0) return src.slice(0, i + 1);
  }
  return assert.fail(`${where} 的 \`${name}\` 宣告找不到結尾（沒有頂層分號、function 也沒有配對的大括號）。`
    + '切點不可信 ⇒ fail-closed。');
}

/** 造一棵路徑含**空白／中文／全角括號／`#`／`%`** 的假 repo（與使用者真實目錄同型）。 */
function makeSpecialPathRepo() {
  const base = mkdtempSync(join(tmpdir(), 'touchpoint-'));
  const repo = join(base, '07 專案#a', '榮祥森（投資理財）100%');
  mkdirSync(join(repo, 'test'), { recursive: true });
  // `.js` 要被當 ESM 讀，靠的是這個 type:module（正式考題也是靠 repo 根的 package.json）
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture","type":"module"}');
  return { base, repo };
}

/**
 * 拿一個 specifier 真的去 `import`，回傳子行程結果。
 * ⚠️ 形狀與⭐⭐核心之二那題**刻意一致**（`--input-type=module` ＋ 靜態 `import … from`）：
 *    那是複驗者 r2 在實體特殊路徑上量過的同一條路，本組題只是把 specifier 的**來源**
 *    從「本檔自己造的」換成「正式接點算的」。
 */
function importViaSpecifier(/** @type {string} */ spec) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { mark } from ${JSON.stringify(spec)};\nprocess.stdout.write(mark);\n`], { encoding: 'utf8' });
}

for (const { file, name, expr, rel } of TOUCHPOINTS) {
  test(`⭐⭐ 正式接線｜${file} 的 \`${name}\` 算出來的 specifier，在含 \`#\` 的實體路徑下必須真的載得進來`, () => {
    // 拿的是**正式考題自己那一行**，不是本檔重寫一份等價的（重寫一份就又變成「只測自己的 helper」）
    const src = readFileSync(join(ROOT, file), 'utf8');
    const prefix = prefixThroughDeclaration(src, name, file);
    assert.ok(prefix.length < src.length,
      `${file}：切出來的前綴等於整份檔案 ⇒ 切點沒找對，探針會連正題一起跑。`);

    const { base, repo } = makeSpecialPathRepo();
    try {
      // 接點指向的那支模組換成**只回一個標記**的替身：載得進來、而且證明載到的是這棵樹的那一支
      const MARK = `MARK:${rel}`;
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), `export const mark = ${JSON.stringify(MARK)};\n`);

      // 第一步：把前綴放進 `<repo>/test/` 執行，印出**正式接點自己算出來的 specifier**。
      // ⚠️ 放這個位置，是為了讓前綴裡那句 `ROOT = join(dirname(…import.meta.url…), '..')`
      //    自己就算出 `<repo>`——本題因此不必去 replace 它（少一個會漂的替換）。
      const probeFile = join(repo, 'test', basename(file));
      writeFileSync(probeFile, `${prefix}\nprocess.stdout.write(String(${expr}));\n`);
      const emitted = spawnSync(process.execPath, [probeFile], { encoding: 'utf8' });
      assert.equal(emitted.status, 0,
        `把 ${file} 到 \`${name}\` 為止的前綴搬到 ${repo} 執行就失敗了 ⇒ 本題證不了東西。\n`
        + `stderr：${String(emitted.stderr).slice(0, 600)}`);
      const spec = emitted.stdout;
      assert.ok(spec.length > 0, `${file} 的 \`${name}\` 算出空字串。`);

      // ⓐ 反面（證明這一題不是在空轉）：原樣塞絕對路徑**必須**因為 `#` 被切斷而找不到模組。
      //    ⚠️ 只斷言「退出碼非 0」不夠——任何意外都會非 0，那會讓本題靜靜變成假綠；所以連失敗**原因**
      //       與**被 `#` 切斷的那一截**一起釘住（與核心之二 ⓐ 同一組斷言）。
      const raw = importViaSpecifier(join(repo, rel));
      assert.notEqual(raw.status, 0,
        `在 ${repo} 底下原樣塞絕對路徑竟然載得進來 ⇒ 這台機器重現不出這個病，`
        + '下面那半的綠就沒有意義（先確認暫存目錄名真的含 `#`）。');
      assert.match(String(raw.stderr), /ERR_MODULE_NOT_FOUND/,
        `失敗原因不是「找不到模組」＝本題量到的是別的東西。\nstderr：${String(raw.stderr).slice(0, 400)}`);
      assert.match(String(raw.stderr), /07 專案'/,
        `錯誤訊息裡沒看到被 \`#\` 切斷的路徑＝抓到的不是同一個病。\nstderr：${String(raw.stderr).slice(0, 400)}`);

      // ⓑ 正面：**正式接點自己**算出來的那個字串必須載得進來，而且載到的是同一支模組
      const real = importViaSpecifier(spec);
      assert.equal(real.status, 0,
        `${file} 的 \`${name}\` 算出來的字串在含 \`#\` 的實體路徑下載不進來。\n`
        + `  它算出的＝${spec}\n`
        + '⇒ 那一顆多半退回了「絕對路徑原樣當 ESM specifier」——`import` 的字串是 **URL**，'
        + '`#` 之後會被當 fragment 丟掉，而**純 ASCII 的實作樹與審查樹完全看不出來**。\n'
        + `修法＝pathToFileURL(絕對路徑).href。\nstderr：${String(real.stderr).slice(0, 600)}`);
      assert.equal(real.stdout, MARK,
        `載進來了，但拿到的不是 ${rel} 那一支（算出的＝${spec}）⇒ 接點算出來的位置本身就不對。`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test('⭐ 切宣告的兩型陷阱（那位審查者 r4 的兩顆突變，釘成回歸題）', () => {
  // 兩型都是「物件 initializer 的 `}` 之後還有東西」：舊切法在 `}` 就停 ⇒ 拿到半句。
  const mk = (init) => `import { pathToFileURL } from 'node:url';\nimport { join } from 'node:path';\nconst ROOT = '/tmp';\nconst STORE_URL = ${init};\n`;

  // 假紅型：值安全（最後取 .href），但切在 `}` 會拿到 [object Object]
  const safe = mk("{ href: pathToFileURL(join(ROOT, 'lib/store.js')).href }.href");
  const p1 = prefixThroughDeclaration(safe, 'STORE_URL', '<inline>');
  assert.ok(p1.trimEnd().endsWith('.href;'),
    '切點停在物件的 `}`、沒吃到後面的 `.href` ⇒ 值安全的宣告會被探針錯紅（假紅型回歸）');

  // 假綠型：值已退回不安全的絕對路徑（?? 右邊），切在 `}` 反而拿到「安全」的半句
  const bad = mk("{ toString() { return pathToFileURL(join(ROOT, 'lib/store.js')).href; } }.href ?? join(ROOT, 'lib/store.js')");
  const p2 = prefixThroughDeclaration(bad, 'STORE_URL', '<inline>');
  assert.ok(p2.includes('??'),
    '切點停在物件的 `}`、沒吃到 `?? <絕對路徑>` ⇒ 真值不安全、探針卻量到安全的半句（假綠型回歸）');

  // 反面：function 宣告仍要能在本體 `}` 結束（收緊不可以把 function 型切壞）
  const fn = "function moduleUrl(rel) { return 'x'; }\nconst other = 1;\n";
  assert.equal(prefixThroughDeclaration(fn, 'moduleUrl', '<inline>').trimEnd().slice(-1), '}',
    'function 宣告該在本體的配對 `}` 結束，收緊過頭了');
});

/**
 * ⚠️ **誠實劃界（上面這組題抓不到什麼）**：
 *   - 它驗的是 `TOUCHPOINTS` 點名的那三顆**宣告**算出什麼。**使用點有沒有真的走這三顆，本題不驗**——
 *     有人在某個 `import` 使用點直接寫絕對路徑、繞過接點，這裡照樣全綠（ASCII 路徑下也看不出來）。
 *   - `TOUCHPOINTS` 是**手寫清單**，不會自己長出新成員：別的考題將來新寫一處，本題不知道。
 *     `c32906f` 移出本支的全樹掃描原本要接的就是這一層，接手那支之前這個缺口是開著的。
 *   ⇒ 真正的驗收照舊是**在含 `#`／`%`／空白／中文的實體路徑上跑全套**（本支 PR 說明裡有數字）。
 */

test('ROOT 這一顆真的指到 repo 根（否則上面那幾題讀到的原始碼就不是這棵樹的）', () => {
  assert.ok(existsSync(join(ROOT, 'package.json')),
    'ROOT 沒指到 repo 根 ⇒ 上面那幾題 readFileSync 讀到的正式考題原始碼不是這棵樹的');
});
