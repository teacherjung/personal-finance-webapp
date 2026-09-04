// @ts-check
// 型別檢查的射程要有考題釘著：AGENTS「型別檢查」節說 jsconfig 是逐檔 opt-in（`checkJs:false`＋檔頭 `// @ts-check`），
// 這表示「三關有沒有檢查到某支檔」取決於那一行在不在——沒人數就會漂（Codex 2026-09-05 體檢：四支算錢／判準的檔一直沒開，
// lib/ib.js 一開就冒五個可能為 null 的診斷）。這題釘住：lib／public／scripts 底下的 .js 全數帶 `// @ts-check`（新檔忘了加＝紅）。
// 誠實劃界：它只看那一行在不在，不代表型別標得夠嚴；`// @ts-nocheck` 或檔內 `// @ts-ignore` 的洞不在此題。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';

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

test('型別檢查射程：lib／public／scripts 底下的每一支 .js 都帶 // @ts-check（逐檔 opt-in 的另一半：沒人數就會漂）', () => {
  const files = ['lib/', 'public/', 'scripts/'].flatMap(jsFiles);
  assert.ok(files.length > 50, `檔案數異常少（${files.length}）：掃描本身壞了？`);
  // TS 只認「第一行程式碼之前」的 // @ts-check：允許它在檔頭註解區裡的任何一行（shebang、說明註解之後都算）
  const leading = (/** @type {string} */ src) => {
    const out = []; let inBlock = false;
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (inBlock) { out.push(line); if (t.includes('*/')) inBlock = false; continue; }
      if (t === '' || t.startsWith('//') || t.startsWith('#!')) { out.push(line); continue; }
      if (t.startsWith('/*')) { out.push(line); inBlock = !t.includes('*/'); continue; }
      break;
    }
    return out.join('\n');
  };
  const missing = files.filter((f) => !/\/\/ *@ts-check\b/.test(leading(readFileSync(new URL(f, ROOT), 'utf8'))));
  assert.deepEqual(missing, [], '這些檔沒有 // @ts-check（三關的型別檢查根本沒看它們）——請加在檔頭第一行（shebang 之後）');
});
