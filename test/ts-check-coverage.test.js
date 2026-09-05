// @ts-check
// 型別檢查的射程要有考題釘著：AGENTS「型別檢查」節說 jsconfig 是逐檔 opt-in（`checkJs:false`＋檔頭 `// @ts-check`），
// 「三關有沒有檢查到某支檔」取決於那一行在不在——沒人數就會漂。判定用 TypeScript 自己的解析結果（`checkJsDirective`）：
// 為什麼不用字串比對——教學文字裡寫到 `// @ts-check` 的檔案會被字串比對當成已啟用，TypeScript 卻沒有在檢查它（#565 r1 實例）。
// 誠實劃界：這題只問「TypeScript 認不認這支檔要檢查」，不代表型別標得夠嚴；檔內 `// @ts-ignore`／`@ts-expect-error` 的洞不在此題。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import ts from 'typescript';

const ROOT = new URL('../', import.meta.url);
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

test('型別檢查射程：lib／public／scripts 底下每一支 .js 都有 TypeScript 認得的 // @ts-check（逐檔 opt-in 的另一半：沒人數就會漂）', () => {
  const files = ['lib/', 'public/', 'scripts/'].flatMap(jsFiles);
  assert.ok(files.length > 50, `檔案數異常少（${files.length}）：掃描本身壞了？`);
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
