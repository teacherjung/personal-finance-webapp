import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as acorn from 'acorn';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
 * 真正的門是 `test/helpers/repo-root.js`——**唯一一份** ROOT 算法＋載入時的存在性斷言
 * （不看寫法、只看結果：算錯就當場吵）。本檔只掃「有沒有人又自己算一次而且算錯」。
 * 照 `test/entry-guard.test.js` 已下過的同一個結論：語法檢查在這件事上不可能收斂，所以它不是門。
 *
 * ⚠️ **判斷用 AST，不用正則、不自己寫 lexer**（r2 阻擋①）：
 * 前一版手寫的「剝註解」狀態機被複驗者用四種合法 JS 打穿——
 * `return /[//]/` 的字元類別被當成行註解（後面的真違規整段變空白＝靜靜放過）、
 * 巢狀樣板 `${`//…`}` 沒處理、純字串裡提到會被誤抓、`new URL(String('..'), …)` 的巢狀括號抓不到。
 * ⇒ 手寫 lexer 是錯的工具。改用 acorn 解析出真正的
 * `NewExpression(URL) → MemberExpression(.pathname)`，語法邊界交給 parser。
 */

/** 極簡 AST 走訪：走遍所有子節點（不裝 acorn-walk，這裡只需要「全部看過」）。 */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
  if (typeof node.type === 'string') visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    walk(node[k], visit);
  }
}

/**
 * 找出「把 file URL 的 `.pathname` 當檔案路徑用」的地方。
 * ⚠️ 刻意**不**攔 `new URL(req.url, 'http://x').pathname`——那是 HTTP URL 的路徑段，本來就該這樣取
 * （複驗者 r1 指出的合法用法）。分界線＝參數裡有沒有 `import.meta`。
 */
export function findBadPathnameUses(src, rel = '<inline>') {
  let ast;
  const tryParse = (sourceType) => acorn.parse(src, { ecmaVersion: 'latest', sourceType, locations: true });
  try { ast = tryParse('module'); } catch { /* 可能是 CommonJS 腳本，往下再試一次 */ }
  if (!ast) {
    // ⚠️ 兩種都解不了就**吵著紅**，不可以跳過：掃描器靜靜跳過一個檔案
    //    就是本專案認過最糟的那種護欄（什麼都沒做卻回報通過）。
    ast = tryParse('script');
  }

  // ── 區域資料流（只在同一個檔案內）─────────────────────────────────────
  // ⚠️ 為什麼需要這一層：攻擊實測證明**三種最自然的重構**都會讓純語法共現失效
  //    （解構／存成中間變數／把 base 抽成常數），而三種都真的 ENOENT。
  //    ⚠️ 誠實劃界：這是**區域**資料流，跨函式、跨檔、經由參數傳遞的一律追不到——
  //    那也是為什麼真正的門是 test/helpers/repo-root.js 那一份實作，本題只是早期警告。
  const fileUrlVars = new Set();   // 被指派過 import.meta.url 的變數名
  const urlObjVars = new Set();    // 被指派過 new URL(<含 file url>) 的變數名
  const nameOf = (n) => (n && n.type === 'Identifier' ? n.name : null);
  const isFileUrlExpr = (n) => {
    if (!n) return false;
    if (n.type === 'MetaProperty' && n.meta && n.meta.name === 'import') return true;
    if (n.type === 'MemberExpression') return isFileUrlExpr(n.object);
    if (n.type === 'Identifier') return fileUrlVars.has(n.name);
    return false;
  };
  const isFileUrlNew = (n) => n && n.type === 'NewExpression'
    && n.callee.type === 'Identifier' && n.callee.name === 'URL'
    && n.arguments.some((a) => { let f = false; walk(a, (x) => { if (isFileUrlExpr(x)) f = true; }); return f; });

  // 兩趟：先收變數（宣告順序可能在使用之前，兩趟就夠本專案的寫法）
  for (let pass = 0; pass < 2; pass++) {
    walk(ast, (n) => {
      if (n.type !== 'VariableDeclarator' && n.type !== 'AssignmentExpression') return;
      const target = n.type === 'VariableDeclarator' ? n.id : n.left;
      const value = n.type === 'VariableDeclarator' ? n.init : n.right;
      if (isFileUrlExpr(value) && nameOf(target)) fileUrlVars.add(nameOf(target));
      if (isFileUrlNew(value) && nameOf(target)) urlObjVars.add(nameOf(target));
    });
  }

  const hits = [];
  const flag = (node) => hits.push(`${rel}:${node.loc.start.line}`);

  walk(ast, (n) => {
    // (a) `<file url 的 URL>.pathname`／`["pathname"]`——直接寫或經由中間變數
    if (n.type === 'MemberExpression') {
      const prop = n.computed
        ? (n.property.type === 'Literal' ? n.property.value
          : (n.property.type === 'TemplateLiteral' && n.property.expressions.length === 0
            ? n.property.quasis[0].value.cooked : null))
        : (n.property.type === 'Identifier' ? n.property.name : null);
      if (prop !== 'pathname') return;
      if (isFileUrlNew(n.object) || (nameOf(n.object) && urlObjVars.has(nameOf(n.object)))) flag(n);
      return;
    }
    // (b) 解構：`const { pathname } = <file url 的 URL>`（含改名）——連 MemberExpression 都沒有
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern') {
      const src2 = n.init;
      if (!(isFileUrlNew(src2) || (nameOf(src2) && urlObjVars.has(nameOf(src2))))) return;
      for (const prop of n.id.properties) {
        if (prop.type === 'Property' && !prop.computed
          && ((prop.key.type === 'Identifier' && prop.key.name === 'pathname')
            || (prop.key.type === 'Literal' && prop.key.value === 'pathname'))) flag(n);
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
  const U = 'new URL';
  const IMU = 'import' + '.meta.url';
  const PN = '.' + 'pathname';
  const outOfRange = [
    ['跨函式傳遞（區域資料流追不到）',
      `function f(u){ return u${PN}; } const R = f(${U}("..", ${IMU}));`],
    ['跨檔（URL 物件從別的模組 import 進來）',
      `import { ROOT } from './other.js'; const R = ROOT${PN};`],
    ['先進容器再取出', `const box = { u: ${U}("..", ${IMU}) }; const R = box.u${PN};`],
  ];
  for (const [why, src] of outOfRange) {
    assert.deepEqual(findBadPathnameUses(src), [],
      `這一種本來在射程外、現在卻抓到了：${why}\n`
      + '——這是好消息，請把它從「誠實劃界」搬到 mustCatch，並更新檔頭的射程敘述。');
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
