// @ts-check
// 型別檢查的射程要有考題釘著：AGENTS「型別檢查」節說 jsconfig 是逐檔 opt-in（`checkJs:false`＋檔頭 `// @ts-check`），
// 型別檢查那一關有沒有看某支檔，取決於它在 jsconfig 的 include 裡、且檔頭有 TypeScript 認得的指令——沒人數就會漂。
// 掃描集合直接從 jsconfig.json 的 include 推出來（多一條 include 這題自動跟上；#565 Grok 掃：原本寫死三個目錄、漏了 server.js）。判定用 TypeScript 自己的解析結果（`checkJsDirective`）：
// 為什麼不用字串比對——教學文字裡寫到 `// @ts-check` 的檔案會被字串比對當成已啟用，TypeScript 卻沒有在檢查它（#565 r1 實例）。
// 誠實劃界：這題只問「TypeScript 認不認這支檔要檢查」，不代表型別標得夠嚴；檔內 `// @ts-ignore`／`@ts-expect-error` 的洞不在此題。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import ts from 'typescript';

const ROOT = new URL('../', import.meta.url);
/** jsconfig 的 include 只有兩種形狀：`dir/**\/*.js`（遞迴）與單一檔；別的形狀直接紅，不要靜靜跳過 */
function includedJs() {
  const inc = /** @type {string[]} */ (JSON.parse(readFileSync(new URL('jsconfig.json', ROOT), 'utf8')).include);
  return inc.flatMap((pat) => {
    const m = /^([\w./-]+)\/\*\*\/\*\.js$/.exec(pat);
    if (m) return jsFiles(m[1] + '/');
    if (/^[\w./-]+\.js$/.test(pat)) { assert.ok(existsSync(new URL(pat, ROOT)), `jsconfig include 指到不存在的檔：${pat}`); return [pat]; }
    if (pat.endsWith('.d.ts')) return [];   // 型別宣告檔不是 JS，TS 本來就檢查
    assert.fail(`jsconfig include 出現本題不會展開的形狀：${pat}——請補展開規則，不要讓它靜靜漏掃`);
  });
}
/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(new URL(dir, ROOT))) {
    const rel = `${dir}${name}`;
    if (statSync(new URL(rel, ROOT)).isDirectory()) { if (name !== 'node_modules') out.push(...jsFiles(rel + '/')); }
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}
/** TypeScript 對這份原始碼的判定：有生效的 `// @ts-check` 指令才是 true（`@ts-nocheck`、註解裡提到、程式碼之後才出現都不算） @param {string} src */
function tsCheckEnabled(src) {
  const sf = /** @type {any} */ (ts.createSourceFile('probe.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  return sf.checkJsDirective?.enabled === true;
}

test('型別檢查射程：jsconfig include 到的每一支 .js（lib／public／scripts 遞迴＋server.js）都有 TypeScript 認得的 // @ts-check（逐檔 opt-in 的另一半：沒人數就會漂）', () => {
  const files = includedJs();
  // 掃描本身的對照：遞迴真的有走進子目錄、單一檔 include 真的有進來（只數總量擋不住「忘了遞迴」）
  for (const must of ['lib/routes/', 'lib/services/', 'public/modules/']) assert.ok(files.some((f) => f.startsWith(must)), `掃描沒走進 ${must}`);
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
