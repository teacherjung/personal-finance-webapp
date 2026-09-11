// @ts-check
// 型別檢查的射程要有考題釘著：AGENTS「型別檢查」節說 jsconfig 是逐檔 opt-in（`checkJs:false`＋檔頭 `// @ts-check`），
// 型別檢查那一關有沒有看某支檔，取決於它**被設定直接選入**（TypeScript 對 jsconfig 算出來的集合）或被選入的檔 import 進來、且檔頭有 TypeScript 認得的指令——沒人數就會漂。
// 本題只守「直接選入」那一半：exclude 掉的目錄若仍被別的檔 import，`tsc` 照樣載入並檢查（Codex #598 r5 實測 lib/services）；本題會紅，因為守的是「這幾個目錄必須直接納入」這條政策，不是在證明 tsc 實跑集合。
// 檔案集合**問 TypeScript 自己**（`parseJsonConfigFileContent`＝include 減 exclude 的實際結果），不自己展開 glob：
//   ⚠️ 2026-09-11 Grok #598 掃：上一版自己讀 `include` 走目錄——留下 include 兩行、另加一條 `exclude`，或把遞迴 glob 換成
//   該目錄下的一支檔，舊版仍綠而 `npm run typecheck` 已經不看那些檔（兩刀實測都假綠）。改問編譯器之後那兩刀都紅。
//   （#565 Grok 掃：更早的版本寫死三個目錄、漏了 server.js——同一族病：自己列舉，不量事實。）
// 判定用 TypeScript 自己的解析結果（`checkJsDirective`）：
// 為什麼不用字串比對——教學文字裡寫到 `// @ts-check` 的檔案會被字串比對當成已啟用，TypeScript 卻沒有在檢查它（#565 r1 實例）。
// 誠實劃界：這題只問「TypeScript 認不認這支檔要檢查」，不代表型別標得夠嚴；檔內 `// @ts-ignore`／`@ts-expect-error` 的洞不在此題。
//   它也**不代表**這些檔真的被 `tsc` 跑過（那是 `npm run typecheck` 本身的事）；它只釘「設定算出來的集合」與「檔頭指令」兩件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { gitEnv } from '../lib/git-env.js';
import { injectDirtyGitEnv, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

const ROOT = new URL('../', import.meta.url);
const ROOT_DIR = fileURLToPath(ROOT);
/** TypeScript 對 jsconfig.json 算出來的檔案集合（include 減 exclude；含 .d.ts；**不含**被 import 拉進來的檔），相對路徑、正斜線 */
function programFiles() {
  const cfgPath = path.join(ROOT_DIR, 'jsconfig.json');
  const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
  assert.equal(read.error, undefined, `jsconfig.json 讀不出來：${read.error ? ts.flattenDiagnosticMessageText(read.error.messageText, '\n') : ''}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT_DIR);
  assert.deepEqual(parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n')), [], 'jsconfig.json 解析有錯——TypeScript 自己都算不出集合，這題不能假裝算得出來');
  return parsed.fileNames.map((f) => path.relative(ROOT_DIR, f).split(path.sep).join('/'));
}
/** git 追蹤中的每一支 .js（`--cached`＝index：不含還沒 `git add` 的新檔、也不含別的考題暫時寫進來的探針）——拿來對照「設定算出來的集合」有沒有靜靜縮水。
 *  ⚠️ **`env: gitEnv()` 不可省**（理由同 test/hosted-store-pg.test.js 的 libFiles：`GIT_DIR` 被繼承時清單會是別棵樹的）。
 *  為什麼只看已追蹤、不走磁碟：TypeScript 算集合時讀的是磁碟，整卷並行時別的考題**跑到一半寫進 lib/ 的暫存探針**
 *  （例：xlsx 護欄那題的 `lib/_xlsx_guard_probes/p*.js`、pdf 那題的 `lib/_seam_probe_<隨機>/`）也會被算進集合、又沒有 `// @ts-check` ⇒ 這題偶爾假紅
 *  （2026-09-11 實踩：pre-push 整卷紅、單獨跑綠）。**兩邊都只認追蹤中的檔**，探針來去都不影響。
 *  代價照實記：`--cached` 讀的是 **git index**——還沒 `git add` 的新 .js 少了標記，這題看不到；`git add` 之後就看得到（含已 add 未 commit）。
 *  起草到 `git add` 之前這題不說話。從乾淨工作樹、有跑 hook 的推送，已 commit 的新檔都在 index，pre-push 抓得到；`--no-verify`、
 *  GitHub 網頁上改檔＝只剩 CI 那一關（CI 的 checkout 裡 index＝那顆 commit，照樣抓）。⚠️ 這題讀的是 **index 的路徑集合＋工作樹的內容**，
 *  不是待推 commit 的內容：先 add 了沒標記的版本、再在工作樹補標記卻沒再 add，本機綠、CI 才紅（Codex #600 r1 收窄「等 commit 才看得到」；
 *  Grok #600 掃後補這幾條）。其他邊角照實記：磁碟上刪了、還沒 stage 的追蹤檔會讓縮水檢查紅（那是髒工作樹）；只活在目錄符號連結另一端、
 *  從沒 add 的 .js 看不到；大小寫只差一格的檔名會假紅（本專案新檔名只准 ASCII，未實測）。`tsc` 本身照樣會讀磁碟上的每一支，那不是這題的射程。
 *  ⚠️ 這個呼叫點走 `gitEnv()`——鐵則 11 要的兩種行為題在本檔下方（拿掉 `env:` 那一行、或退化成只刪 `GIT_DIR`，都要紅）。 */
function trackedJs() {
  const out = execFileSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8', cwd: ROOT_DIR, env: gitEnv() });
  return new Set(out.split('\0').filter((f) => f.endsWith('.js')));
}
/** TypeScript 對這份原始碼的判定：有生效的 `// @ts-check` 指令才是 true（`@ts-nocheck`、註解裡提到、程式碼之後才出現都不算） @param {string} src */
function tsCheckEnabled(src) {
  const sf = /** @type {any} */ (ts.createSourceFile('probe.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  return sf.checkJsDirective?.enabled === true;
}

test('型別檢查射程：TypeScript 對 jsconfig 算出來的每一支 .js（lib／public／scripts／test-doubles／prototype 遞迴＋server.js）都有 TypeScript 認得的 // @ts-check（逐檔 opt-in 的另一半：沒人數就會漂）', () => {
  const tracked = trackedJs();
  // 集合＝TypeScript 對 jsconfig 算出來的 .js ∩ git 追蹤中的 .js（見 trackedJs 的說明）
  const files = programFiles().filter((f) => f.endsWith('.js') && tracked.has(f));
  // 集合有沒有靜靜縮水：這幾個目錄底下追蹤中的每一支 .js 都要在 TypeScript 算出來的集合裡——
  // include 被拿掉、遞迴 glob 換成單一檔、另加 exclude，都會在這裡紅（Grok #598 掃：「換成單一檔」「另加 exclude」這兩種舊版假綠；「拿掉 include」舊版本來就紅——Codex r5 抓到上一版用序數指錯）。
  // test-doubles／prototype 2026-09-11 起納入（12 支、0 錯；William 裁「甲」；test/ 刻意不在，理由見 AGENTS「型別檢查」節）。
  for (const dir of ['lib/', 'public/', 'scripts/', 'test-doubles/', 'prototype/']) {
    const trackedUnder = [...tracked].filter((f) => f.startsWith(dir));
    assert.ok(trackedUnder.length > 0, `${dir} 底下 git 追蹤中找不到任何 .js——目錄搬了或路徑打錯，這題的對照組空了`);
    const dropped = trackedUnder.filter((f) => !files.includes(f));
    assert.deepEqual(dropped, [], `這些檔 git 追蹤中、卻不在 TypeScript 對 jsconfig 算出來的集合裡（include 被縮、或加了 exclude）——三關的型別檢查不會**直接**開它們（被別的檔 import 進來的另計；本題守的是「必須直接納入」這條政策）`);
  }
  assert.ok(files.includes('server.js'), 'jsconfig include 的單一檔 server.js 要在集合裡');
  const missing = files.filter((f) => !tsCheckEnabled(readFileSync(new URL(f, ROOT), 'utf8')));
  assert.deepEqual(missing, [], '這些檔 TypeScript 不會檢查（三關的型別檢查根本沒看它們）——請在第一行程式碼之前加獨立一行 // @ts-check');
});

test('判定器對照：真指令（第一行／shebang 後／區塊註解後／有前導空白）算數；教學文字提到、區塊註解內、程式碼之後、@ts-nocheck 都不算', () => {
  for (const src of ['// @ts-check\nconst a = 1;\n', '#!/usr/bin/env node\n// @ts-check\nconst a = 1;\n', '/** doc */\n// @ts-check\nconst a = 1;\n', '   // @ts-check\nconst a = 1;\n']) {
    assert.equal(tsCheckEnabled(src), true, `該算而沒算：${JSON.stringify(src)}`);
  }
  for (const src of ['// 請在別的檔案加 // @ts-check\nconst a = 1;\n', '/* // @ts-check */\nconst a = 1;\n', 'const a = 1; // @ts-check\n', 'const a = 1;\n// @ts-check\n', '// @ts-nocheck\nconst a = 1;\n']) {
    assert.equal(tsCheckEnabled(src), false, `不該算卻算了：${JSON.stringify(src)}`);
  }
});

test('⭐ trackedJs() 的清單不可被繼承的 GIT_* 帶去別棵樹（拿掉 env: gitEnv() 要紅）', () => {
  // ⚠️ 這一題是**代理指標**（射程對照表在 test/helpers/dirty-git-env.js 檔頭）：注入的 `GIT_DIR` 是實測唯一四種呼叫形狀通吃的變數，
  //    它證明真實情境（從連結工作樹 push 時 hook 環境帶著 GIT_DIR）下清單沒被帶偏；**擋不住**退化成只刪 GIT_DIR 的列名版——那由下一題守。
  const restore = injectDirtyGitEnv();
  try {
    const files = trackedJs();
    for (const must of ['server.js', 'test-doubles/fake-supabase.js', 'prototype/forest-ui-lab/forest-ui.js']) {
      assert.ok(files.has(must), `注入髒 GIT_* 之後清單裡沒有 ${must} 了＝環境沒被隔離，這題會拿別棵樹（或空清單）當對照組`);
    }
    assert.ok(files.size > 100, `注入髒 GIT_* 之後只剩 ${files.size} 支＝隔離失效`);
  } finally {
    restore();
  }
});

test('⭐ trackedJs() 交給 git 的環境裡不可以有任何 GIT_*（直接斷言，不靠代理指標）', () => {
  assertChildGitEnvClean(assert, 'ts-check-coverage 的 trackedJs()', () => trackedJs());
});
