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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

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
/** 磁碟上 `dir` 底下的每一支 .js（不進 node_modules）——拿來對照「設定算出來的集合」有沒有靜靜縮水 @param {string} dir @returns {string[]} */
function diskJs(dir) {
  const out = [];
  for (const name of readdirSync(new URL(dir, ROOT))) {
    const rel = `${dir}${name}`;
    if (statSync(new URL(rel, ROOT)).isDirectory()) { if (name !== 'node_modules') out.push(...diskJs(rel + '/')); }
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}
/** TypeScript 對這份原始碼的判定：有生效的 `// @ts-check` 指令才是 true（`@ts-nocheck`、註解裡提到、程式碼之後才出現都不算） @param {string} src */
function tsCheckEnabled(src) {
  const sf = /** @type {any} */ (ts.createSourceFile('probe.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  return sf.checkJsDirective?.enabled === true;
}

test('型別檢查射程：TypeScript 對 jsconfig 算出來的每一支 .js（lib／public／scripts／test-doubles／prototype 遞迴＋server.js）都有 TypeScript 認得的 // @ts-check（逐檔 opt-in 的另一半：沒人數就會漂）', () => {
  const files = programFiles().filter((f) => f.endsWith('.js'));
  // 集合有沒有靜靜縮水：這幾個目錄在磁碟上的每一支 .js 都要在 TypeScript 算出來的集合裡——
  // include 被拿掉、遞迴 glob 換成單一檔、另加 exclude，都會在這裡紅（Grok #598 掃：「換成單一檔」「另加 exclude」這兩種舊版假綠；「拿掉 include」舊版本來就紅——Codex r5 抓到上一版用序數指錯）。
  // test-doubles／prototype 2026-09-11 起納入（12 支、0 錯；William 裁「甲」；test/ 刻意不在，理由見 AGENTS「型別檢查」節）。
  for (const dir of ['lib/', 'public/', 'scripts/', 'test-doubles/', 'prototype/']) {
    const onDisk = diskJs(dir);
    assert.ok(onDisk.length > 0, `${dir} 底下在磁碟上找不到任何 .js——目錄搬了或路徑打錯，這題的對照組空了`);
    const dropped = onDisk.filter((f) => !files.includes(f));
    assert.deepEqual(dropped, [], `這些檔在磁碟上、卻不在 TypeScript 對 jsconfig 算出來的集合裡（include 被縮、或加了 exclude）——三關的型別檢查不會**直接**開它們（被別的檔 import 進來的另計；本題守的是「必須直接納入」這條政策）`);
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
