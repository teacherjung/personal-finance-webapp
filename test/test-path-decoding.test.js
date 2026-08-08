import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as espree from 'espree';
import { analyze } from 'eslint-scope';
// ⚠️ **本檔不自己算 ROOT**（r3 阻擋①）：自己算就等於又多一份算法，
//    而「唯一一份」是這一族真正的門。共用那一份自己會驗身分（不只驗有 package.json）。
import { ROOT } from './helpers/repo-root.js';

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
 * 真正的門是 `test/helpers/repo-root.js`——**會驗身分**的共用 ROOT ＋載入時斷言
 * （不看寫法、只看結果：算錯、或指到另一棵 checkout，都當場吵）。本檔只掃「有沒有人自己算而且算錯」。
 * ⚠️ 那一份**不是** repo 唯一在算 repo 根的地方（詳見它的檔頭劃界）——別把它讀成「已經全部統一」。
 * 照 `test/entry-guard.test.js` 已下過的同一個結論：語法檢查在這件事上不可能收斂，所以它不是門。
 *
 * ⚠️ **判斷用 AST，不用正則、不自己寫 lexer**（r2 阻擋①）：
 * 前一版手寫的「剝註解」狀態機被複驗者用四種合法 JS 打穿——
 * `return /[//]/` 的字元類別被當成行註解（後面的真違規整段變空白＝靜靜放過）、
 * 巢狀樣板 `${`//…`}` 沒處理、純字串裡提到會被誤抓、`new URL(String('..'), …)` 的巢狀括號抓不到。
 * ⇒ 手寫 lexer 是錯的工具。改用 acorn 解析出真正的
 * `NewExpression(URL) → MemberExpression(.pathname)`，語法邊界交給 parser。
 */

/**
 * 找出「把 file URL 的 `.pathname` 當檔案路徑用」的地方。
 * ⚠️ 刻意**不**攔 `new URL(req.url, 'http://x').pathname`——那是 HTTP URL 的路徑段，本來就該這樣取
 * （複驗者 r1 指出的合法用法）。分界線＝參數裡有沒有 `import.meta`。
 */
/** 走遍所有子節點（只需要「全部看過」，不裝 acorn-walk）。 */
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
 * `new URL(input, base)` 算出來的會不會是 **file URL**（＝取 `.pathname` 就會拿到未解碼路徑）。
 *
 * ⚠️ **要分 input 與 base，不可以「任一參數含 file URL 就算」**（r3 阻擋②，複驗者實測的假紅）：
 * `new URL('https://example.com/a', import.meta.url).pathname` 的結果明確是 HTTP URL——
 * input 是絕對 URL 時 base 整個被忽略，那一行完全沒問題。
 */
function isFileUrlNew(node, tainted) {
  if (!node || node.type !== 'NewExpression') return false;
  if (!(node.callee.type === 'Identifier' && node.callee.name === 'URL')) return false;
  const [input, base] = node.arguments;
  // input 是「帶非 file scheme 的絕對 URL 字面」⇒ base 被忽略 ⇒ 不是 file URL
  if (input && input.type === 'Literal' && typeof input.value === 'string') {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(input.value);
    if (m && m[1].toLowerCase() !== 'file') return false;
  }
  return isFileUrlExpr(input, tainted) || isFileUrlExpr(base, tainted);
}

/** 這個運算式是不是一個 file URL（`import.meta.url`、或被指派過它的變數）。 */
function isFileUrlExpr(node, tainted) {
  if (!node) return false;
  if (node.type === 'MetaProperty') return node.meta && node.meta.name === 'import';
  if (node.type === 'MemberExpression') return isFileUrlExpr(node.object, tainted);
  if (node.type === 'Identifier') return tainted.fileUrl.has(node);
  return false;
}

/**
 * 找出「把 file URL 的 `.pathname` 當檔案路徑用」的地方。
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

  // identifier 節點 → 它解析到的那個 binding（同名不同 scope 就是不同 binding）
  const bindingOf = new Map();
  const allVars = [];
  const visitScope = (scope) => {
    for (const v of scope.variables) allVars.push(v);
    for (const r of scope.references) if (r.resolved) bindingOf.set(r.identifier, r.resolved);
    for (const c of scope.childScopes) visitScope(c);
  };
  visitScope(scopeManager.globalScope);

  // 兩趟：先解出「被指派 import.meta.url 的 binding」，再解出「被指派 file-url 的 new URL 的 binding」
  const tainted = { fileUrl: new Set(), urlObj: new Set() };
  const markBinding = (v, bucket, isMatch) => {
    const writes = v.defs.map((d) => d.node).concat(
      v.references.filter((r) => r.isWrite() && r.writeExpr).map((r) => ({ init: r.writeExpr })),
    );
    const values = writes.map((n) => (n && (n.init || n.right || null))).filter(Boolean);
    // ⚠️ kill：一個寫入不符合就整個放過（寧可漏抓、不可誤抓）
    if (!values.length || !values.every((val) => isMatch(val))) return;
    for (const id of v.identifiers) bucket.add(id);
    for (const r of v.references) bucket.add(r.identifier);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const v of allVars) markBinding(v, tainted.fileUrl, (val) => isFileUrlExpr(val, tainted));
    for (const v of allVars) markBinding(v, tainted.urlObj, (val) => isFileUrlNew(val, tainted));
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
      if (isFileUrlNew(n.object, tainted) || isTaintedUrlObj(n.object)) flag(n);
      return;
    }
    // (b) 解構：`const { pathname } = <file url 的 URL>`（含改名）——連 MemberExpression 都沒有
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern') {
      if (!(isFileUrlNew(n.init, tainted) || isTaintedUrlObj(n.init))) return;
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

test('早期警告｜沒有人自己算 repo 根而把 file URL 的 .pathname 當路徑（含空白／中文會 ENOENT）', () => {
  const files = jsFilesUnderGit(['test', 'scripts', 'lib', 'public']);
  // ⚠️ 反面自我驗證：先確認真的掃到東西。掃到 0 個檔案時「沒有違規者」當然成立＝最典型的假綠。
  assert.ok(files.length > 100, `git ls-files 只列出 ${files.length} 支 .js，掃描範圍不對＝這一題在空轉`);
  const offenders = files.flatMap((rel) => findBadPathnameUses(readFileSync(join(ROOT, rel), 'utf8'), rel));
  assert.deepEqual(offenders, [],
    '這些地方把 file URL 的 `.pathname` 當檔案路徑：\n  ' + offenders.join('\n  ')
    + '\n\n它留著 URL 編碼，遇到含空白或中文的專案路徑（本專案就是）會 ENOENT。'
    + "\n改用：const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');"
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
    ['巢狀括號的參數', `const R = ${U}(String(".."), ${IMU})${PN};`],
    ['同一行前半是區塊註解', `/* 說明 */ const R = ${U}("..", ${IMU})${PN};`],
    ['跨行寫法', `const R = ${U}("..",\n  ${IMU})${PN};`],
    ['計算屬性（字串字面）', `const R = ${U}("..", ${IMU})["pathname"];`],
    ['計算屬性（無內插樣板）', 'const R = ' + U + '("..", ' + IMU + ')[`pathname`];'],
    // ↓ 2026-08-08 四路攻擊實測「純語法共現」全部漏掉、而且每一種都真的 ENOENT 的三種自然重構
    ['解構取值（連 MemberExpression 都沒有）', `const { pathname } = ${U}("..", ${IMU});`],
    ['解構＋改名', `const { pathname: R } = ${U}("..", ${IMU});`],
    ['存成中間變數再取', `const u = ${U}("..", ${IMU}); const R = u${PN};`],
    ['base 抽成常數', `const base = ${IMU}; const R = ${U}("..", base)${PN};`],
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
    // ↓ 這一種是**刻意**放過的合法用法（r3 複驗者確認）：URL 物件直接交給 fs，Node 自己會解碼
    ['URL 物件當 base、不取 pathname（合法，repo 現有兩支這樣用）',
      `const ROOT = ${U}("../", ${IMU}); readFileSync(new URL("a.js", ROOT), "utf8");`],
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

test('⭐ 真的門｜共用 ROOT 指到「另一棵有效 checkout」時必須吵（r3 阻擋①）', () => {
  // ⚠️ 這一題守的是 r3 複驗者**實際重現過**的假綠：helper 原本只驗「ROOT 底下有 package.json」，
  //    於是 ROOT 指到同一支 repo 的另一棵工作樹時（那棵當然也有 package.json）斷言照樣通過，
  //    掃描器就靜靜掃了別棵樹、回報「零違規」。他實測三檔 37/37、npm test 1734/1734 全綠。
  //    ⇒ 門必須驗**身分**：ROOT 底下的 helper 檔案要跟正在執行的這一支是同一個檔。
  const helper = readFileSync(join(ROOT, 'test', 'helpers', 'repo-root.js'), 'utf8');

  // ⓐ 身分檢查存在（用 realpath 比對，而不是只看 package.json 在不在）
  assert.match(helper, /realpathSync/,
    'test/helpers/repo-root.js 不再用 realpath 比對身分——只驗 package.json 存在的話，'
    + 'ROOT 指到另一棵 checkout 會靜靜通過（r3 複驗者已重現）');
  assert.match(helper, /另一棵/,
    'helper 少了「指到另一棵 checkout」那條錯誤訊息——訊息本身就是下一個人的診斷依據');

  // ⓑ 反面自我驗證：把身分檢查拿掉之後，那個情境確實不會被擋
  //    （不改檔案，只在字串上模擬——證明這道檢查是承重的，不是裝飾）
  const withoutIdentity = helper.replace(/if \(realpathSync[\s\S]*?\n\}\n/, '');
  assert.notEqual(withoutIdentity, helper, '模擬拆除失敗＝這個斷言在空轉');
  assert.doesNotMatch(withoutIdentity, /realpathSync\(join\(ROOT/,
    '拆掉之後還留著身分比對＝上面那條 match 不足以證明它承重');

  // ⓒ 這棵樹上的門本身是通的（ROOT 就是載入 helper 的這一棵）
  assert.ok(existsSync(join(ROOT, 'package.json')), 'ROOT 不是 repo 根');
  assert.equal(
    readFileSync(join(ROOT, 'test', 'helpers', 'repo-root.js'), 'utf8').length, helper.length,
    'ROOT 底下的 helper 與剛剛讀到的不是同一份＝ROOT 指向可疑',
  );
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
