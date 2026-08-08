import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as espree from 'espree';
import { analyze } from 'eslint-scope';
// ⚠️ **本檔不自己算 ROOT**：共用那一份會驗身分（不只驗「這裡有 package.json」），
//    自己再算一次就是又多一個會算錯的地方。
import { ROOT, assertSameCheckout } from './helpers/repo-root.js';

/**
 * ⚠️ 為什麼要有這一題（2026-08-08 實際事故）：
 * `new URL(<相對路徑>, import.meta.url).pathname` 留著 URL 編碼。本專案實際落在
 * 「07 專案/榮祥森（投資理財）」這種含**空白與中文**的路徑下，於是它算出
 * `.../07%20%E5%B0%88%E6%A1%88/...` ⇒ 掃描原始碼的考題 `readFileSync` 直接 ENOENT。
 *
 * 這個病的形狀最惡：#417 的實作樹與十四棵審查樹都落在純 ASCII 的 `/private/tmp/…`
 * ＝四題全綠、十四輪審查也全綠；**合併進 main、在使用者自己的目錄跑才紅。**
 * ⇒ 「考題在開發者機器上綠」不代表「在使用者機器上綠」，路徑是這條分界線上最常見的那顆雷。
 *
 * ⚠️⚠️ **本檔是「早期警告」，不是門**（2026-08-08 四路攻擊之後改口）：
 * 真正的門是 `test/helpers/repo-root.js`——會驗身分的共用 ROOT ＋載入時斷言
 * （不看寫法、只看結果：算錯、或指到另一棵 checkout，都當場吵）。
 * 本檔掃的是「有沒有人取了 file URL 的 `.pathname`」——⚠️ **不論那個值後來有沒有真的當檔案路徑用**
 * （r6 阻擋③：追 sink 要跨函式資料流、做不可靠；不追就不可以斷言它被當路徑用）。
 * ⇒ 所以口徑是**整條禁掉**：要路徑用 `fileURLToPath()`，要觀察編碼不要留在程式裡。
 * **射程**＝下方 mustCatch 那一題；
 * **射程外**＝誠實劃界那一題（那份清單也不完整——它只列已知的，不是窮舉）。
 * 照 `test/entry-guard.test.js` 已下過的同一個結論：語法檢查在這件事上不可能收斂，所以它不是門。
 *
 * ⚠️ **判斷用 AST／真正的解析器，不用正則、不自己寫 lexer**（r2 阻擋①、r5 阻擋①各踩一次）：
 * 前一版手寫的「剝註解」狀態機被複驗者用四種合法 JS 打穿——
 * `return /[//]/` 的字元類別被當成行註解（後面的真違規整段變空白＝靜靜放過）、
 * 巢狀樣板 `${`//…`}` 沒處理、純字串裡提到會被誤抓、`new URL(String('..'), …)` 的巢狀括號抓不到。
 * ⇒ 手寫 lexer 是錯的工具。改用真正的 JS 解析器（`espree`）解析出
 * `NewExpression(URL) → MemberExpression(.pathname)`，語法邊界交給 parser。
 */

/** 走遍所有子節點（只需要「全部看過」，不為此裝額外的走訪套件）。 */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
  if (typeof node.type === 'string') visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range' || k === 'parent') continue;
    walk(node[k], visit);
  }
}

/**
 * 字串字面（含無內插樣板）。⚠️ 也接**以字面開頭的串接**：`'../fixtures/' + name` 的最左邊那截
 * 就足以決定它是相對參照還是絕對 URL（r5 阻擋④：這種寫法很常見、必然是相對、而且真的會 ENOENT）。
 */
function literalParts(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return { text: node.value, complete: true };
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return { text: node.quasis[0].value.cooked, complete: true };
  }
  if (node.type === 'TemplateLiteral' && node.quasis.length) {
    return { text: node.quasis[0].value.cooked, complete: false };   // `../x/${name}` ⇒ 只知道開頭
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = literalParts(node.left);
    return left === null ? null : { text: left.text, complete: false };
  }
  return null;
}

/**
 * 這一截**完整**字面，在 base 是 file URL 的情況下，能不能證明結果是 file URL。
 *
 * ⚠️ **解析失敗不可以當成「相對參照」**（r6 阻擋②）：`'http://[::1'` 這種壞字串會讓 `new URL` 丟錯、
 * 根本不會產生 file URL，但上一版把「解不出來」等同「相對」⇒ 假紅。
 * ⚠️ 也**不可以自己寫 scheme 正則**（r5 阻擋①，我踩過三次）：WHATWG 會先剝掉開頭空白／控制字元。
 * ⇒ 直接拿一個 sentinel file base 去解析，看結果的 protocol。解不出來＝證明不了 ⇒ 放過。
 */
const SENTINEL_FILE_BASE = 'file:///sentinel-base/x.js';
function resolvesToFileUrl(lit) {
  try {
    return new URL(lit, SENTINEL_FILE_BASE).protocol === 'file:';
  } catch {
    return false;   // 壞字串／解不出來 ⇒ 證明不了 ⇒ 放過
  }
}

/**
 * `new URL(input, base)` 算出來的**能不能證明**是 file URL（＝取 `.pathname` 會拿到未解碼路徑）。
 *
 * ⚠️ 只有「證明得出來」才 taint（**寧可漏抓、不可誤抓**——這是會讓 `npm test` 失敗的硬閘）：
 *   ⓐ input 本身就是 `import.meta.url`（或被指派過它的 binding）⇒ 是
 *   ⓑ input 的**最左字面**存在：能單獨解析成絕對 URL 且不是 `file:` ⇒ 不是；否則（＝相對參照）看 base
 * input 完全沒有字面可依據（純變數、函式回傳值）⇒ 證明不了 ⇒ 放過。
 */
function isFileUrlNew(node, tainted, isGlobalURL) {
  if (!node || node.type !== 'NewExpression') return false;
  if (!(node.callee.type === 'Identifier' && node.callee.name === 'URL')) return false;
  // ⚠️ 必須確認 `URL` 是全域那顆（r5 阻擋②）：函式參數或區域類別剛好叫 URL 也會被誤抓。
  if (!isGlobalURL(node.callee)) return false;
  const [input, base] = node.arguments;
  if (isFileUrlExpr(input, tainted)) return true;                       // ⓐ
  const parts = literalParts(input) || literalOfBinding(input, tainted);   // ⓑ
  if (!parts) return false;
  if (parts.complete) {
    // 完整字面 ⇒ 用 sentinel file base 解析（照 WHATWG，含剝開頭空白／控制字元）
    if (!resolvesToFileUrl(parts.text)) return false;
  } else if (!/^[./\\?#]/.test(parts.text)) {
    // ⚠️ 只知道開頭時**不可以**拿它去解析（r5 實測：`'https:' + '//x'` 的 `'https:'` 解不出來，
    //    會被誤判成相對參照 ⇒ 假紅）。
    // ⇒ **目前只收斂**「以 `.` `/` `\\` `?` `#` 開頭」這幾種——它們必然是相對參照。
    //    其餘（例如 `'' + name`、變數開頭）證明不了，放過。⚠️ 這不是窮舉，是目前收斂到的範圍。
    return false;
  }
  return isFileUrlExpr(base, tainted);
}

/** 每次寫入都是同一個字串字面的變數，值可知（r5 阻擋④：`const rel = '..'` 很常見）。 */
function literalOfBinding(node, tainted) {
  if (!node || node.type !== 'Identifier') return null;
  return tainted.litVar.get(node) || null;
}

/** 這個運算式是不是一個 file URL（`import.meta.url`、或被指派過它的變數）。 */
function isFileUrlExpr(node, tainted) {
  if (!node) return false;
  // ⚠️ **只認 `import.meta.url` 這一個屬性**（r5 阻擋②）：舊版把任何掛在 `import.meta` 上的成員
  //    都當 file URL，於是 `new URL(import.meta.dirname, 'https://example.com').pathname`
  //    （結果是 HTTPS）被判違規。`import.meta.dirname`／`.filename` 是普通路徑字串，不是 URL。
  if (node.type === 'MemberExpression') {
    if (node.object && node.object.type === 'MetaProperty') {
      return node.object.meta && node.object.meta.name === 'import'
        && !node.computed && node.property.type === 'Identifier' && node.property.name === 'url';
    }
    return false;
  }
  if (node.type === 'Identifier') return tainted.fileUrl.has(node);
  return false;
}

/**
 * 找出「取 file URL 的 `.pathname`」的地方。
 * ⚠️ **不判斷那個值後來有沒有真的當檔案路徑用**（r6／r7 阻擋：追 sink 要跨函式資料流、做不可靠）
 * ⇒ 本專案的口徑是整條禁掉，理由與替代寫法都寫在上面那一題的錯誤訊息裡。
 * ⚠️ 刻意**不**攔 `new URL(req.url, 'http://x').pathname`——那是 HTTP URL 的路徑段，本來就該這樣取
 * （複驗者 r1 指出的合法用法）。分界線＝**能不能證明結果是 file URL**，不是「參數裡有沒有 `import.meta`」：
 * input 若是絕對 URL（含 HTTPS），base 整個被忽略，那一行是合法的。
 *
 * ⚠️ **作用域交給 eslint-scope，不自己維護變數名集合**（r3 阻擋②）：
 * 前一版用「檔案內所有同名變數」當 taint 鍵，複驗者實測出四種確定的**假紅**——
 * 不同 block 的同名變數／不同 function 的同名變數／變數重新指向 HTTP URL 之後才取／
 * 以及上面那個「input 是絕對 HTTP URL」。假紅在硬 CI 閘上不能只靠改名消化，會擋掉沒有錯的改動。
 *
 * 取捨方向＝**寧可漏抓、不可誤抓**（與錢邊界攔截器刻意相反）：
 * 這一層只是早期警告，真正的門是 `test/helpers/repo-root.js`；
 * 而假紅會讓人為了消紅去改壞正確程式。所以任何變數只要**有一次**被指派成別的東西，就整個放過（kill）。
 */
export function findBadPathnameUses(src, rel = '<inline>') {
  const parse = (sourceType) => espree.parse(src, {
    ecmaVersion: 'latest', sourceType, loc: true, range: true,
  });
  let ast;
  try { ast = parse('module'); } catch { /* 可能是 CommonJS 腳本，往下再試一次 */ }
  if (!ast) {
    // ⚠️ 兩種都解不了就**吵著紅**，不可以跳過：掃描器靜靜跳過一個檔案
    //    就是本專案認過最糟的那種護欄（什麼都沒做卻回報通過）。
    ast = parse('script');
  }

  const scopeManager = analyze(ast, { ecmaVersion: 2024, sourceType: 'module', ignoreEval: true });

  const bindingOf = new Map();
  const allVars = [];
  const visitScope = (scope) => {
    for (const v of scope.variables) allVars.push(v);
    for (const r of scope.references) if (r.resolved) bindingOf.set(r.identifier, r.resolved);
    for (const c of scope.childScopes) visitScope(c);
  };
  visitScope(scopeManager.globalScope);

  // ⚠️ `URL` 必須是全域那顆（r5 阻擋②）：解析得到 binding ⇒ 是使用者自己宣告的同名東西 ⇒ 放過。
  const isGlobalURL = (node) => !bindingOf.has(node);

  // 作用域感知的 taint（鍵是 identifier 節點，經由 binding 對齊——同名不同 scope 是不同 binding）
  const tainted = { fileUrl: new Set(), urlObj: new Set(), litVar: new Map() };
  // ⚠️ **只接受 initializer 與單純 `=`**（r6 阻擋①）：`rel += 'https:'` 的 RHS 是 `'https:'`，
  //    但實際值是 `'https:https:'`（protocol 仍是 https）⇒ 上一版把 RHS 當成「實際寫入值」而假紅。
  //    `+=`／logical assignment／`++`／`for…of` 的綁定一律回報 null＝這個 binding 不可知（kill）。
  const writeValues = (v) => {
    const out = [];
    for (const d of v.defs) {
      const n = d.node;
      if (!n) return null;
      if (n.type === 'VariableDeclarator') { if (n.init) out.push(n.init); else return null; }
      else return null;   // 函式參數／for…of／import 等：值不可知
    }
    for (const r of v.references) {
      if (!r.isWrite()) continue;
      const w = r.writeExpr;
      if (!w) return null;
      out.push(w);
    }
    return out;
  };
  const markBinding = (v, bucket, isMatch) => {
    const values = writeValues(v);
    // ⚠️ kill：值不可知（null）或任一寫入不符合 ⇒ 整個放過（寧可漏抓、不可誤抓）
    if (values === null || !values.length || !values.every((val) => isMatch(val))) return;
    for (const id of v.identifiers) bucket.add(id);
    for (const r of v.references) bucket.add(r.identifier);
  };
  // 每次寫入都是同一個字串字面的變數 ⇒ 值可知（r5 阻擋④：`const rel = '..'` 很常見）
  for (const v of allVars) {
    // ⚠️ **不可以要求「恰好一次寫入」**：`const rel = '..'` 的宣告在 eslint-scope 裡會同時出現在
    //    `defs`（declarator）與 `references`（init 的 write）＝兩筆，於是條件永遠不成立（實測踩到）。
    //    改成「每一次寫入都是同一個字串字面」——重新賦值成別的東西、或用 `+=` 之類算不出值的
//    寫法，就自動不算（r6 阻擋①）。⚠️ 所以檔內別處不可寫成「只寫入一次」。
    const values = writeValues(v);
    if (values === null) continue;
    const parts = values.map((val) => literalParts(val));
    if (!parts.length || parts.some((x) => x === null || !x.complete)) continue;
    if (new Set(parts.map((x) => x.text)).size !== 1) continue;
    const lit = parts[0];
    for (const id of v.identifiers) tainted.litVar.set(id, lit);
    for (const r of v.references) tainted.litVar.set(r.identifier, lit);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const v of allVars) markBinding(v, tainted.fileUrl, (val) => isFileUrlExpr(val, tainted));
    for (const v of allVars) markBinding(v, tainted.urlObj, (val) => isFileUrlNew(val, tainted, isGlobalURL));
  }
  const isTaintedUrlObj = (node) => node && node.type === 'Identifier'
    && (tainted.urlObj.has(node) || (bindingOf.has(node)
      && bindingOf.get(node).identifiers.some((id) => tainted.urlObj.has(id))));

  const hits = [];
  const flag = (node) => hits.push(`${rel}:${node.loc.start.line}`);
  const propName = (prop, computed) => {
    if (!computed) return prop.type === 'Identifier' ? prop.name : null;
    if (prop.type === 'Literal') return prop.value;
    if (prop.type === 'TemplateLiteral' && prop.expressions.length === 0) return prop.quasis[0].value.cooked;
    return null;
  };

  walk(ast, (n) => {
    // (a) `<file url 的 URL>.pathname`／`["pathname"]`——直接寫或經由中間變數
    if (n.type === 'MemberExpression') {
      if (propName(n.property, n.computed) !== 'pathname') return;
      if (isFileUrlNew(n.object, tainted, isGlobalURL) || isTaintedUrlObj(n.object)) flag(n);
      return;
    }
    // (b) 解構：`const { pathname } = <file url 的 URL>`（含改名）——連 MemberExpression 都沒有
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern') {
      if (!(isFileUrlNew(n.init, tainted, isGlobalURL) || isTaintedUrlObj(n.init))) return;
      for (const prop of n.id.properties) {
        if (prop.type !== 'Property') continue;
        if (propName(prop.key, prop.computed) === 'pathname') flag(n);
      }
    }
  });
  return hits;
}

/**
 * ⚠️ **一律走 `git ls-files`，不可自己走訪檔案樹**（r2 阻擋②，與 test/xlsx-isolate.test.js 同一條契約）：
 * 走實體目錄會把 ignored 的工具產物、備份副本一起算進來（假紅），也會漏掉 git 才知道的東西。
 * `--others --exclude-standard` 讓**還沒 commit 的新檔**也掃到——只用 `--cached` 的話，
 * 違規的新檔在 commit 之前完全掃不到，護欄會在最需要它的那一刻失效。
 * ⚠️ `core.quotepath=false`：不加的話含中文的檔名會被 git 轉成 `\344\270...` 八進位轉義而開不了檔
 *    ——那正是本 PR 在修的同一族病（本專案另有「掃描器跳過中文檔名」的前例）。
 */
function jsFilesUnderGit(dirs) {
  const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files',
    '--cached', '--others', '--exclude-standard', ...dirs], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter((f) => f.endsWith('.js'));
}

test('早期警告｜本專案不取 file URL 的 .pathname（不論用途——理由見錯誤訊息）', () => {
  const files = jsFilesUnderGit(['test', 'scripts', 'lib', 'public']);
  // ⚠️ 反面自我驗證：先確認真的掃到東西。掃到 0 個檔案時「沒有違規者」當然成立＝最典型的假綠。
  assert.ok(files.length > 100, `git ls-files 只列出 ${files.length} 支 .js，掃描範圍不對＝這一題在空轉`);
  const offenders = files.flatMap((rel) => findBadPathnameUses(readFileSync(join(ROOT, rel), 'utf8'), rel));
  assert.deepEqual(offenders, [],
    '這些地方取了 file URL 的 `.pathname`：\n  ' + offenders.join('\n  ')
    + '\n\n⚠️ **本專案禁止這個取法，不論你打算拿它做什麼。**'
    + '\n它留著 URL 編碼（`07 專案` → `07%20%E5%B0%88%E6%A1%88`），一旦被當檔案路徑就 ENOENT。'
    + '\n本題**不追蹤**那個值後來有沒有真的流進 `fs`（那要跨函式的資料流，做不可靠），'
    + '\n所以改成整條禁掉——要路徑請用 `fileURLToPath()`，要看編碼請在 REPL 看、不要留在程式裡。'
    + "\n改用：import { ROOT } from './helpers/repo-root.js';  // 或 fileURLToPath(...)"
    + '\n⚠️ 這種錯在純 ASCII 的實作樹裡完全看不出來——#417 十四輪審查全綠，合併後在主目錄才紅。');
});

test('⭐ 掃描器自己的探針：複驗者與四路攻擊打出來的形狀，逐一釘住', () => {
  // ⚠️ 探針字串**組裝**、不寫成字面：寫成字面的話上一題掃到本檔會把探針當違規者（前一版踩過）。
  const U = 'new URL';
  const IMU = 'import' + '.meta.url';
  const PN = '.' + 'pathname';

  const mustCatch = [
    // ↓ r2 複驗者打穿手寫 lexer 的形狀（改用 AST 之後應全數抓到）
    ['正規式字元類別 [//] 之後接真違規', `function f(){ return /[//]/; } const R = ${U}("..", ${IMU})${PN};`],
    ['巢狀樣板內插裡的真違規', 'const s = `${`//${' + U + '("..", ' + IMU + ')' + PN + '}`}`;'],
    ['同一行前半是區塊註解', `/* 說明 */ const R = ${U}("..", ${IMU})${PN};`],
    ['跨行寫法', `const R = ${U}("..",\n  ${IMU})${PN};`],
    ['計算屬性（字串字面）', `const R = ${U}("..", ${IMU})["pathname"];`],
    ['計算屬性（無內插樣板）', 'const R = ' + U + '("..", ' + IMU + ')[`pathname`];'],
    // ↓ 2026-08-08 四路攻擊實測「純語法共現」全部漏掉、而且每一種都真的 ENOENT 的三種自然重構
    ['解構取值（連 MemberExpression 都沒有）', `const { pathname } = ${U}("..", ${IMU});`],
    ['解構＋改名', `const { pathname: R } = ${U}("..", ${IMU});`],
    ['存成中間變數再取', `const u = ${U}("..", ${IMU}); const R = u${PN};`],
    ['base 抽成常數', `const base = ${IMU}; const R = ${U}("..", base)${PN};`],
    // ↓ r5 複驗者指名「很常見、值得成為 mustCatch」的，以及這輪一併收斂的形狀
    ['以相對字面開頭的串接', `const R = ${U}("../fixtures/" + name, ${IMU})${PN};`],
    ['樣板有內插但開頭是相對', 'const R = ' + U + '(`../x/${name}`, ' + IMU + ')' + PN + ';'],
    ['值可由字面賦值證明的變數', `const rel = ".."; const R = ${U}(rel, ${IMU})${PN};`],
    ['file: 大小寫混寫', `const R = ${U}("FiLe:///x", ${IMU})${PN};`],
    ['protocol-relative（會繼承 file base）', `const R = ${U}("//example.com/x", ${IMU})${PN};`],
    ['單參數就是 file URL', `const R = ${U}(${IMU})${PN};`],
    ['無內插樣板的相對路徑', 'const R = ' + U + '(`..`, ' + IMU + ')' + PN + ';'],
    ['宣告順序顛倒（先用後宣告的 base）', `function g(){ return ${U}("..", base)${PN}; } const base = ${IMU};`],
  ];
  for (const [why, src] of mustCatch) {
    assert.notDeepEqual(findBadPathnameUses(src), [], `這種形狀必須抓到卻漏了：${why}`);
  }

  const mustIgnore = [
    ['只是字串裡提到', `const explanation = "${U}('..', ${IMU})${PN}";`],
    ['純行註解裡提到', `// 不可以用 ${U}('..', ${IMU})${PN}`],
    ['區塊註解裡提到', `/*\n * ${U}('..', ${IMU})${PN} 是錯的\n */`],
    ['HTTP URL 的 pathname（合法用法，刻意不攔）', `const p = ${U}(req.url, 'http://x')${PN};`],
    // ↓ 攻擊實測抓到的誤抓：ESTree 的 MetaProperty 同時涵蓋 import.meta 與 new.target
    ['參數裡用 new.target 的 HTTP URL（不是 file URL）',
      `class R { constructor(u){ this.p = ${U}(u, new.target === R ? 'http://a' : 'http://b')${PN}; } }`],
    ['正確寫法本身', "import { ROOT } from './helpers/repo-root.js';"],
    // ⚠️ 這一種**永遠**不該被抓（r5 阻擋③）：它原本混在誠實劃界裡，而那一題寫著
    //    「將來抓到就是好事」——對這一項是錯的，它是合法用法，repo 現有兩支這樣寫。
    ['URL 物件當 base、不取 pathname（合法，repo 現有兩支這樣用）',
      `const ROOT = ${U}("../", ${IMU}); readFileSync(new URL("a.js", ROOT), "utf8");`],
    // ↓ r4 複驗者實測的五種假紅：input 是絕對 HTTPS ⇒ base 被忽略 ⇒ 結果不是 file URL
    ['HTTPS 字串放進 const', `const u = 'https://example.com/a'; const p = ${U}(u, ${IMU})${PN};`],
    ['String() 包起來的 HTTPS', `const p = ${U}(String('https://example.com/a'), ${IMU})${PN};`],
    ['無內插樣板的 HTTPS', 'const p = ' + U + '(`https://example.com/a`, ' + IMU + ')' + PN + ';'],
    ['靜態字串串接的 HTTPS', `const p = ${U}('https:' + '//example.com/a', ${IMU})${PN};`],
    ['HTTPS 的 URL 物件當 input', `const b = ${U}('https://example.com/'); const p = ${U}(b, ${IMU})${PN};`],
    // ↓ r5 複驗者實測的假紅：WHATWG 會先剝掉開頭空白／控制字元才看 scheme
    ['開頭有空白的 HTTPS', `const p = ${U}(' HTTPS://example.com/a', ${IMU})${PN};`],
    ['開頭有 tab 的 HTTPS', `const p = ${U}('\\tHTTPS://example.com/a', ${IMU})${PN};`],
    ['import.meta.dirname 不是 URL（是路徑字串）', `const p = ${U}(import.meta.dirname, 'https://example.com')${PN};`],
    ['區域宣告的 URL 不是全域那顆', `class URL { constructor(){} } const p = ${U}('..', ${IMU})${PN};`],
    ['函式參數剛好叫 URL', `function g(URL){ return ${U}('..', ${IMU})${PN}; }`],
    ['變數後來被改成 HTTPS（kill）', `let rel='..'; rel='https://x'; const R = ${U}(rel, ${IMU})${PN};`],
    ['URL 物件本身沒取 pathname（合法：直接交給 fs，Node 自己會解碼）',
      `const ROOT = ${U}("../", ${IMU}); readFileSync(new URL("a.js", ROOT), "utf8");`],
  ];
  for (const [why, src] of mustIgnore) {
    assert.deepEqual(findBadPathnameUses(src), [], `這種不該算違規卻被抓：${why}`);
  }
});

test('⚠️ 誠實劃界｜這幾種本題**抓不到**（所以它是早期警告、不是門）', () => {
  // ⚠️ 這一題把「射程外」也釘住，理由：下一個人若以為語法層是門，就不會去維護真正的門
  //    （test/helpers/repo-root.js）。抓不到就要**寫下來**，不可以讓沉默看起來像覆蓋。
  //    ⇒ 若哪天下面這些變成「抓得到」，本題會紅，那是好事：請把它從清單搬到 mustCatch。
  // ⚠️ 取捨方向：本層**寧可漏抓、不可誤抓**（與錢邊界攔截器刻意相反）——
  //    它是會讓 npm test 失敗的硬閘，假紅會讓人為了消紅去改壞正確程式。
  const U = 'new URL';
  const IMU = 'import' + '.meta.url';
  const PN = '.' + 'pathname';
  const outOfRange = [
    ['跨函式傳遞（作用域分析不做跨函式的值追蹤）',
      `function f(u){ return u${PN}; } const R = f(${U}("..", ${IMU}));`],
    ['跨檔（URL 物件從別的模組 import 進來）',
      `import { ROOT } from './other.js'; const R = ROOT${PN};`],
    ['先進容器再取出', `const box = { u: ${U}("..", ${IMU}) }; const R = box.u${PN};`],
    // ↓ 以下四種是 r3 複驗者實測出來的假綠，照實記在射程外（未實作收斂）
    ['解構後再賦值（不是宣告式解構）', `let pathname; ({ pathname } = ${U}("..", ${IMU}));`],
    ['計算鍵的解構', `const key = "pathname"; const { [key]: R } = ${U}("..", ${IMU});`],
    ['URL 建構子本身被別名', `const V = URL; const R = new V("..", ${IMU})${PN};`],
    ['URL 物件再別名一層', `const a = ${U}("..", ${IMU}); const b = a; const R = b${PN};`],
    // ↓ r4 之後**刻意**放過：input 不是字串字面 ⇒ 證明不了結果是 file URL。
    //    這是「寧可漏抓、不可誤抓」的代價，不是漏掉的——r2 曾把它列為 mustCatch，
    //    r4 收緊判準（只有證明得出來才 taint）之後它必然落到射程外。
    ['input 是函式回傳值（非字面）', `const R = ${U}(String(".."), ${IMU})${PN};`],
    // ↓ kill semantics 的代價（r4 複驗者實測並確認「掃描器仍有價值、不該刪，但要列進劃界」）：
    //    一個 binding 只要有一次寫入判不出是 file URL，就整個放過——自我賦值就足以脫身。
    ['自我賦值（kill 讓它脫身）', `let u = ${U}("..", ${IMU}); if (x) u = u; const R = u${PN};`],
    // ↓ r6 複驗者指出的其餘缺口，照實記（未收斂）
    ['for…of 綁定的值（不可知 ⇒ kill）', `for (const rel of ["..", ".."]) { const R = ${U}(rel, ${IMU})${PN}; }`],
    ['只知前綴且開頭是空字串（判不出 name 是否絕對）', `const R = ${U}("" + name, ${IMU})${PN};`],
  ];
  for (const [why, src] of outOfRange) {
    assert.deepEqual(findBadPathnameUses(src), [],
      `這一種本來在射程外、現在卻抓到了：${why}\n`
      + '——若是真的收斂了，請把它從「誠實劃界」搬到 mustCatch 並更新檔頭的射程敘述；'
      + '若是誤抓，請修（本層寧可漏抓、不可誤抓）。');
  }
});

test('⭐ 不可誤抓｜r3 實測的五種安全寫法（硬 CI 閘上的假紅會讓人改壞正確程式）', () => {
  const U = 'new URL';
  const IMU = 'import' + '.meta.url';
  const PN = '.' + 'pathname';
  const safe = [
    ['不同 block 的同名變數', `{ const u = ${U}("..", ${IMU}); } { const u = ${U}(req.url,"http://x"); const p = u${PN}; }`],
    ['不同 function 的同名變數',
      `function a(){ const u = ${U}("..", ${IMU}); } function b(){ const u = ${U}(req.url,"http://x"); return u${PN}; }`],
    ['變數重新指向 HTTP URL 之後才取', `let u = ${U}("..", ${IMU}); u = ${U}(req.url,"http://x"); const p = u${PN};`],
    ['安全取值發生在 file-URL 賦值之前',
      `const v = ${U}(req.url,"http://x"); const p = v${PN}; const v2 = ${U}("..", ${IMU});`],
    // ↓ input 是絕對 HTTP URL ⇒ base 整個被忽略，結果不是 file URL
    ['第一參數是絕對 HTTP URL（base 被忽略）', `const p = ${U}("https://example.com/a", ${IMU})${PN};`],
  ];
  for (const [why, src] of safe) {
    assert.deepEqual(findBadPathnameUses(src), [], `這是安全寫法卻被判違規（假紅）：${why}`);
  }
});

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

test('⭐ 壞掉的 URL 字面不可以被當成「證明是 file URL」（r7 阻擋②）', () => {
  // ⚠️ 複驗者把 resolvesToFileUrl 的 catch 從 return false 改成 return true，整檔仍 7/7 全綠
  //    ＝那條修法沒有任何考題撐著。這一題就是那顆探針。
  const IMU2 = 'import' + '.meta.url';
  const PN2 = '.' + 'pathname';
  for (const bad of ['http://[::1', 'https://%', 'http://a b c']) {
    assert.deepEqual(findBadPathnameUses(`const p = new URL(${JSON.stringify(bad)}, ${IMU2})${PN2};`), [],
      `壞字串 ${JSON.stringify(bad)} 會讓 new URL 丟錯、根本產不出 file URL，不可以判違規（假紅）`);
  }
  // 反面：解得出來而且是 file URL 的，仍要抓到（否則上面那三條可能是「整個判準壞了」而非正確放過）
  assert.notDeepEqual(findBadPathnameUses(`const p = new URL("..", ${IMU2})${PN2};`), [],
    '正常的相對路徑也放過了＝判準整個壞掉，上面三條的綠是假的');
});

test('⭐ 複合賦值：他報的假紅要放過，但真的是相對路徑的不可以漏抓（r7 實測校正）', () => {
  // ⚠️ 這一題的預期是**實測校正過**的：複驗者 r6 建議「`+=` 一律 kill」，但實測顯示
  //    ①他報的那個假紅是「壞字串被當相對」造成的，sentinel base 修好之後自己就放過
  //    ②kill 反而讓「真值仍是相對路徑」的情形漏抓。⇒ 不做 operator kill（理由寫在 writeValues 上）。
  const IMU2 = 'import' + '.meta.url';
  const PN2 = '.' + 'pathname';
  const cases = [
    // [說明, 程式, 應不應該抓到]
    ['他報的案例：+= 之後其實是 https', `let rel = 'https:'; rel += 'https:'; const p = new URL(rel, ${IMU2})${PN2};`, false],
    ['+= 的另一邊值不可知', `let rel = '..'; rel += x; const p = new URL(rel, ${IMU2})${PN2};`, false],
    ['URL 物件被 += 之後已不是原物件', `let u = new URL('..', ${IMU2}); u += ''; const p = u${PN2};`, false],
    ['logical assignment 之後值不可知', `let rel = '..'; rel ||= x; const p = new URL(rel, ${IMU2})${PN2};`, false],
    ['寫入的字面不一致 ⇒ kill', `let rel = '..'; rel = 'https://a'; const p = new URL(rel, ${IMU2})${PN2};`, false],
    // ↓ 這一條是刪掉 operator kill 換回來的：真值 '....' 仍是相對參照、仍會 ENOENT
    ['+= 兩次都是相對字面（真值仍相對）', `let rel = '..'; rel += '..'; const p = new URL(rel, ${IMU2})${PN2};`, true],
    ['static block 裡的複合賦值（值不可知）',
      `class C { static { let r = '..'; r += x; const p = new URL(r, ${IMU2})${PN2}; } }`, false],
  ];
  for (const [why, src, shouldCatch] of cases) {
    const hit = findBadPathnameUses(src).length > 0;
    assert.equal(hit, shouldCatch,
      shouldCatch ? `這是真的會 ENOENT 卻漏抓了：${why}` : `這是安全寫法卻被判違規（假紅）：${why}`);
  }
});

test('⭐ 合法但會讓走訪爆掉的形狀（r7 阻擋③：parent 掛成屬性會無限遞迴）', () => {
  // 這幾段完全沒有 pathname，但曾讓 eslint-scope 沿 parent 循環無限遞迴 ⇒ 硬 CI 閘紅燈。
  for (const src of ['class C { static {} }', 'class C { static { let r = ".."; r += ".."; } }',
    'class C { static #x = 1; static { C.#x++; } }']) {
    assert.deepEqual(findBadPathnameUses(src), [], `合法程式讓掃描器爆掉或誤抓：${src}`);
  }
});

test('解析不了的檔案要吵著紅，不可以靜靜跳過', () => {
  // ⚠️ 這一題守的是「掃描器最糟的失敗模式」：跳過一個檔案而回報通過。
  //    本專案已認過這個病型（護欄什麼都沒做卻回報通過，比沒有護欄更糟）。
  assert.throws(() => findBadPathnameUses('const = = =;', 'x.js'), /.*/,
    '語法壞掉的檔案必須丟例外（讓那一題紅），不可以被吞掉當成「沒有違規」');
});

test('ROOT 這一顆真的指到 repo 根（否則上面幾題就是在空掃）', () => {
  assert.ok(existsSync(join(ROOT, 'package.json')), 'ROOT 沒指到 repo 根，上面那題等於什麼都沒掃');
});
