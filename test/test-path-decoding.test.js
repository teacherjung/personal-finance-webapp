import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as espree from 'espree';
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

/** 字串字面（含無內插樣板）。⚠️ 只認**完整**字面：串接／有內插的樣板一律不認（見射程外那一題）。 */
function completeLiteral(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/**
 * 這一截完整字面單獨解析出來是不是 `file:`（⇒ base 會被忽略，結果就是 file URL）。
 * ⚠️ 用真正的 `URL` 解析器，不自己寫 scheme 正則（r5 阻擋①：WHATWG 會先剝開頭空白／控制字元）。
 */
function isAbsoluteFileLiteral(lit) {
  try { return new URL(lit).protocol === 'file:'; } catch { return false; }
}

/**
 * 這一截完整字面是不是**相對參照**（⇒ 結果由 base 決定）。
 * ⚠️ 解析失敗不可以當成相對（r6 阻擋②：`'http://[::1'` 會丟錯、根本產不出 file URL）。
 */
const SENTINEL_FILE_BASE = 'file:///sentinel-base/x.js';
function isRelativeLiteral(lit) {
  if (isAbsoluteFileLiteral(lit)) return false;
  try { return new URL(lit, SENTINEL_FILE_BASE).protocol === 'file:'; } catch { return false; }
}

/** 這個節點是不是**字面上的** `import.meta.url`。 */
function isImportMetaUrl(node) {
  return !!node && node.type === 'MemberExpression' && !node.computed
    && node.object && node.object.type === 'MetaProperty'
    && node.object.meta && node.object.meta.name === 'import'
    && node.property.type === 'Identifier' && node.property.name === 'url';
}

/** `new URL(…)` 這顆的結果**證明得出來**是 file URL 嗎（只看這一個運算式，不追變數）。 */
function isFileUrlNewExpr(node) {
  if (!node || node.type !== 'NewExpression') return false;
  if (!(node.callee.type === 'Identifier' && node.callee.name === 'URL')) return false;
  const lit = completeLiteral(node.arguments[0]);
  if (lit === null) return false;
  const base = node.arguments[1];
  // ⚠️ **base 不是「被忽略」，它仍會先被驗證**（r11 阻擋①）：
  //    `new URL('file:///x', 'http://[::1')` 執行時會丟 `ERR_INVALID_URL`，根本產不出任何 URL。
  //    ⇒ 有字面 base 時就**真的建一次**看結果；base 不是字面就證明不了、放過。
  if (base === undefined) return isAbsoluteFileLiteral(lit);
  if (isImportMetaUrl(base)) return isAbsoluteFileLiteral(lit) || isRelativeLiteral(lit);
  const baseLit = completeLiteral(base);
  if (baseLit === null) return false;
  try { return new URL(lit, baseLit).protocol === 'file:'; } catch { return false; }
}

/** 這個屬性名是不是 `pathname`（含 `["pathname"]` 與無內插樣板鍵）。 */
function isPathnameKey(prop, computed) {
  if (!computed) return prop.type === 'Identifier' && prop.name === 'pathname';
  if (prop.type === 'Literal') return prop.value === 'pathname';
  if (prop.type === 'TemplateLiteral' && prop.expressions.length === 0) {
    return prop.quasis[0].value.cooked === 'pathname';
  }
  return false;
}

/**
 * 從**綁定模式**收集所有被綁定的名字（`{a}`／`[a]`／`a = 1`／`...rest` 都要遞迴進去）。
 * ⚠️ 只認 Identifier 會漏掉合法寫法（r10 阻擋①，複驗者三顆探針）：
 *    `function g({ URL })`／`const [URL] = xs`／`import * as URL from …`。
 */
function boundNames(node, out) {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier': out.add(node.name); break;
    case 'ObjectPattern': for (const pr of node.properties) {
      boundNames(pr.type === 'RestElement' ? pr.argument : pr.value, out);
    } break;
    case 'ArrayPattern': for (const el of node.elements) boundNames(el, out); break;
    case 'AssignmentPattern': boundNames(node.left, out); break;
    case 'RestElement': boundNames(node.argument, out); break;
    default: break;
  }
  return out;
}

/**
 * 這個檔案裡有沒有自己宣告／匯入名叫 `URL` 的東西 ⇒ 整個檔案跳過。
 * ⚠️ 為什麼（r5 阻擋②）：函式參數或區域類別剛好叫 `URL` 時，本層會把它當成全域 WHATWG `URL` 而誤抓。
 * ⚠️ 這是**保守的整檔跳過**，不做作用域分析——本層 r9 起刻意不再走那條路（理由見下面那段）。
 *    代價：檔案裡只要有任何一個叫 `URL` 的綁定，真違規也一起放過（記在誠實劃界那一題）。
 */
function declaresOwnURL(ast) {
  const names = new Set();
  walk(ast, (n) => {
    switch (n.type) {
      case 'VariableDeclarator': boundNames(n.id, names); break;
      case 'ClassDeclaration': case 'ClassExpression':
      case 'FunctionDeclaration': case 'FunctionExpression':
        boundNames(n.id, names);
        for (const pm of n.params || []) boundNames(pm, names);
        break;
      case 'ArrowFunctionExpression':
        for (const pm of n.params || []) boundNames(pm, names);
        break;
      case 'CatchClause': boundNames(n.param, names); break;
      case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier':
        boundNames(n.local, names); break;
      default: break;
    }
  });
  return names.has('URL');
}

/**
 * 找出「取 file URL 的 `.pathname`」的地方——**只認直接寫出來的兩種形狀**。
 *
 * ⚠️ **這是 r9 依複驗者判斷（乙：大幅簡化）重寫的版本。** r2–r9 八輪都在擴充變數追蹤
 * （taint、固定點迭代、kill、作用域分析），而他每一輪都能用很小的自然反例同時打出假綠與假紅
 * （最後一輪：`u.href = 'https://…'` 之後那個物件已經不是 file URL，而 kill 只看 binding 寫入、
 * 看不到物件內部變更）。⇒ 結論是本專案早就寫過的那條：**列舉繞法補不完要關門**。
 * 所以整層變數追蹤刪除，只留「直接寫」這兩種。⚠️ 假紅**不只剩一種**（r11 阻擋①推翻過一次）：本層排除瀏覽器目錄、
 * 有字面 base 時真的建一次 URL、檔案自宣告 `URL` 就整檔跳過——三種取捨各有代價，逐一記在誠實劃界。
 *
 * ⚠️ 漏抓**沒有人補**：`test/helpers/repo-root.js` 只保護**採用它的檔案**（見它自己的誠實劃界），
 * 未 import 它的檔案寫出射程外的形狀時，本層與那道門都不會出聲。射程外的形狀明列在誠實劃界
 * 那一題並列為待辦，**不再逐案補洞**（依複驗者 r9 判斷「乙」）。
 */
export function findBadPathnameUses(src, rel = '<inline>') {
  const parse = (sourceType) => espree.parse(src, { ecmaVersion: 'latest', sourceType, loc: true });
  let ast;
  try { ast = parse('module'); } catch { /* 可能是 CommonJS 腳本，往下再試一次 */ }
  if (!ast) {
    // ⚠️ 兩種都解不了就**吵著紅**，不可以跳過：掃描器靜靜跳過一個檔案
    //    就是本專案認過最糟的那種護欄（什麼都沒做卻回報通過）。
    ast = parse('script');
  }
  if (declaresOwnURL(ast)) return [];

  const hits = [];
  walk(ast, (n) => {
    // (a) `new URL(…).pathname`／`["pathname"]`
    if (n.type === 'MemberExpression') {
      if (isPathnameKey(n.property, n.computed) && isFileUrlNewExpr(n.object)) {
        hits.push(`${rel}:${n.loc.start.line}`);
      }
      return;
    }
    // (b) `const { pathname } = new URL(…)`（含改名）——連 MemberExpression 都沒有
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && isFileUrlNewExpr(n.init)) {
      for (const prop of n.id.properties) {
        if (prop.type === 'Property' && isPathnameKey(prop.key, prop.computed)) {
          hits.push(`${rel}:${n.loc.start.line}`);
        }
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
export const BROWSER_ONLY_DIRS = ['public/'];

/**
 * 這支檔案是不是**瀏覽器側**（⇒ 它的 `import.meta.url` 是 HTTP(S) URL，取 `.pathname` 合法）。
 *
 * ⚠️ 兩部分規則，兩邊都踩過：
 *   ・`public/` 整個目錄都是瀏覽器模組（r11 阻擋①：那裡取 `.pathname` 合法，硬禁＝假紅）。
 *   ・`prototype/` **混住兩種**（r12 阻擋①）：`*.test.js` 是 Node 程式（`node:test`／`node:child_process`，
 *     用 `node --test` 跑），其餘是 `index.html` 載入的瀏覽器模組。
 *     整個目錄排除會讓那些 Node 考題落在射程外＝假綠。
 * ⚠️ 這是**按目錄慣例**判的，不是分析 import。將來若有瀏覽器檔取名 `*.test.js`、
 *    或 Node 程式落在 `public/`，這條就會判錯——已記在誠實劃界，並由 fixture 行為題釘住現行慣例。
 */
export function isBrowserSideFile(f) {
  if (BROWSER_ONLY_DIRS.some((d) => f.startsWith(d))) return true;
  if (f.startsWith('prototype/')) return !f.endsWith('.test.js');
  return false;
}

/**
 * 掃描清單＝**Node 側**受版控的 .js。
 *
 * ⚠️ **不限目錄，但要排除瀏覽器程式**——兩件事各有代價，兩邊都踩過：
 *   ・r9 阻擋①：舊版只掃 test／scripts／lib／public，卻宣稱「本專案禁止」，
 *     複驗者把違規放進根層 `server.js` 就全綠（根層還有 `eslint.config.js` 等受版控 .js）。
 *   ・r11 阻擋①：**`public/` 是瀏覽器模組**，那裡的 `import.meta.url` 是 HTTP(S) URL，
 *     `new URL('../api/export', import.meta.url).pathname` 是**完全合法**的取法，
 *     而錯誤訊息建議的 `fileURLToPath()` 在瀏覽器根本不能用 ⇒ 硬 CI 閘假紅。
 * ⇒ 這道閘只管 Node 側；瀏覽器目錄明確排除（清單有斷言釘住，見下方那一題）。
 *
 * ⚠️ `--others --exclude-standard`：**還沒 commit 的新檔也要掃到**——只用 `--cached` 的話，
 *    違規的新檔在 commit 之前完全掃不到，護欄會在最需要它的那一刻失效（有 fixture 行為題釘住）。
 * ⚠️ `core.quotepath=false`：不加的話含中文的檔名會被 git 轉成八進位轉義而開不了檔
 *    ——那正是本 PR 在修的同一族病。
 */
export const LS_FILES_ARGV = ['-c', 'core.quotepath=false', 'ls-files',
  '--cached', '--others', '--exclude-standard'];

/**
 * 跑 git 時**一律清掉所有 repo-local 的 Git 環境變數**。
 *
 * ⚠️⚠️ 這不是防禦性寫法，是 2026-08-09 真實事故的修法（r13 阻擋①，複驗者精確重現）：
 * `scripts/git-hooks/pre-push` 會執行 `npm test`，而 hook 執行時環境裡帶著 `GIT_DIR`。
 * 只給 `cwd` **隔離不了**它——git 會照 `GIT_DIR` 去操作**真的那個 repo**，`cwd` 形同無效。
 * 後果：本檔原本在暫存目錄跑的 `git init` fixture，實際上重新初始化了主 repo、把
 * `core.bare` 設成 `true`（主目錄與全部 worktree 同時失去工作樹身分），還把 fixture 的檔案
 * 塞進主 repo 的 index——而那顆考題當時顯示 1/1 通過。
 * ⇒ 兩個修法一起做：①**不再有任何 `git init`**（見下方清單題）②所有 git 呼叫都走這裡。
 * ⚠️ `trackedJsFiles()` 自己也吃這個坑：GIT_DIR 被繼承時它會去列**別的 repo** 的檔案
 * ——那會讓這道閘在 pre-push 期間掃錯對象而靜靜全綠。
 */
export function gitEnv() {
  // ⚠️ **清掉所有 `GIT_*`，不列舉**（r14 阻擋：列舉第二次補不完）。
  //    上一版只清了十來個精確名稱，複驗者用 `GIT_CONFIG_COUNT`／`GIT_CONFIG_KEY_0=core.excludesFile`
  //    注入一個 excludes 檔，讓 `--exclude-standard` **靜靜隱藏違規新檔**：正常環境 12/13（抓到），
  //    注入之後 13/13（全綠）。同族還有 `GIT_CONFIG_PARAMETERS`、`GIT_IMPLICIT_WORK_TREE`、
  //    `GIT_GRAFT_FILE`、`GIT_SHALLOW_FILE`…（`git rev-parse --local-env-vars` 會列一整批，且會隨版本增加）。
  //    ⇒ 依本專案教義（列舉繞法補不完要關門）：**前綴一律清掉**。
  //    ⚠️ 這不碰 `PATH`／`HOME`，所以 git 仍找得到執行檔與使用者設定目錄（有反面斷言）。
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

/**
 * 唯一一個跑 `git ls-files` 的入口。
 * ⚠️ 收成一個入口是為了**沒有第二處會忘記傳 `env`**（r14 複驗者的建議）——
 * 上一版有兩處各自呼叫，其中一處日後漏傳就是一個靜靜的假綠。
 */
function lsFiles(cwd) {
  return execFileSync('git', LS_FILES_ARGV, { cwd, encoding: 'utf8', env: gitEnv() })
    .split('\n').filter((f) => f.endsWith('.js'));
}

export function trackedJsFiles(cwd = ROOT) {
  return lsFiles(cwd).filter((f) => !isBrowserSideFile(f));
}

test('早期警告｜本專案不取 file URL 的 .pathname（不論用途——理由見錯誤訊息）', () => {
  const files = trackedJsFiles();
  // ⚠️ 反面自我驗證：先確認真的掃到東西。掃到 0 個檔案時「沒有違規者」當然成立＝最典型的假綠。
  assert.ok(files.length > 100, `git ls-files 只列出 ${files.length} 支 .js，掃描範圍不對＝這一題在空轉`);
  // ⚠️ **範圍要用精確比對釘住**（r10 阻擋②）：結構性斷言（根層＋各目錄各一支）**擋不住**——
  //    複驗者把清單改成「全部 test/ ＋每區留一支代表檔」，仍滿足全部結構斷言，卻漏掃 128 支，
  //    而該檔 10/10、全套 1739/1739 都還是綠的。⇒ 改成與**獨立算出來的完整清單**逐項比對。
  const allJs = lsFiles(ROOT);
  const expected = allJs.filter((f) => !isBrowserSideFile(f));
  // ⚠️ 瀏覽器目錄必須**不在**清單裡（r11 阻擋①：那裡取 .pathname 合法），
  //    而且必須真的有東西被排除，否則這條排除等於沒生效。
  // ⚠️ **排除清單要用獨立斷言釘住**（r13 阻擋②）：`files` 與 `expected` 都呼叫同一個
  //    `isBrowserSideFile`，所以那個 deepEqual **對排除範圍完全沒有判準**——
  //    複驗者把 `BROWSER_ONLY_DIRS` 突變成 `['public/', 'lib/']`，整支仍 12/12 全綠，
  //    也就是全部 `lib/` 的 Node 檔都可以被靜靜排除。
  assert.deepEqual(BROWSER_ONLY_DIRS, ['public/'],
    '整個目錄被排除的只准是 public/。要新增就必須同時交代「那個目錄裡沒有 Node 程式」'
    + '（prototype/ 的教訓：它混住兩種，整個排除會讓 Node 考題落在射程外）');
  // ⚠️ 反向：Node 側目錄與根層檔案**不得**被排除
  for (const f of ['lib/store.js', 'scripts/check-review-verdicts.js', 'test/server.test.js', 'server.js']) {
    assert.equal(isBrowserSideFile(f), false, `${f} 是 Node 程式，不可以被判成瀏覽器側`);
    assert.ok(files.includes(f), `${f} 不在掃描清單裡＝它落在射程外`);
  }
  assert.ok(allJs.length > expected.length, '沒有任何瀏覽器檔案被排除＝isBrowserSideFile 沒生效');
  assert.equal(files.filter(isBrowserSideFile).length, 0,
    '掃描清單含瀏覽器側檔案——那裡的 import.meta.url 是 HTTP URL，取 .pathname 合法（假紅）');
  // ⚠️ 反向（r12 阻擋①）：`prototype/` 裡的 Node 考題**必須留在清單裡**，
  //    整個目錄排除會讓它們落在射程外＝假綠。
  const protoNode = allJs.filter((f) => f.startsWith('prototype/') && f.endsWith('.test.js'));
  assert.ok(protoNode.length > 0, 'prototype/ 底下找不到 Node 考題＝這條反向斷言在空轉');
  for (const f of protoNode) {
    assert.ok(files.includes(f), `${f} 是 Node 程式（用 node --test 跑）卻不在掃描清單裡＝射程外`);
  }
  assert.deepEqual([...files].sort(), [...expected].sort(),
    `掃描清單與 git 列出的受版控 .js 不一致（掃 ${files.length} 支、應為 ${expected.length} 支）。`
    + '\n漏掃的檔案等於在射程外，而錯誤訊息卻宣稱「本專案禁止」。');
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
    // ↓ r2 複驗者打穿手寫 lexer 的形狀（改用真正的解析器之後全數抓到）
    ['正規式字元類別 [//] 之後接真違規', `function f(){ return /[//]/; } const R = ${U}("..", ${IMU})${PN};`],
    ['巢狀樣板內插裡的真違規', 'const s = `${`//${' + U + '("..", ' + IMU + ')' + PN + '}`}`;'],
    ['同一行前半是區塊註解', `/* 說明 */ const R = ${U}("..", ${IMU})${PN};`],
    ['跨行寫法', `const R = ${U}("..",\n  ${IMU})${PN};`],
    ['計算屬性（字串字面）', `const R = ${U}("..", ${IMU})["pathname"];`],
    ['計算屬性（無內插樣板）', 'const R = ' + U + '("..", ' + IMU + ')[`pathname`];'],
    ['直接解構（連 MemberExpression 都沒有）', `const { pathname } = ${U}("..", ${IMU});`],
    ['直接解構＋改名', `const { pathname: R } = ${U}("..", ${IMU});`],
    ['無內插樣板的相對路徑', 'const R = ' + U + '(`..`, ' + IMU + ')' + PN + ';'],
    ['file: 大小寫混寫', `const R = ${U}("FiLe:///x", ${IMU})${PN};`],
    ['protocol-relative（會繼承 file base）', `const R = ${U}("//example.com/x", ${IMU})${PN};`],
    // ↓ r9 阻擋②：input 已證明是絕對 file URL 時 base 被忽略，不可以還要求 base 也是 file URL
    ['絕對 file URL（單參數）', `const R = ${U}("file:///tmp/x")${PN};`],
    ['絕對 file URL＋https base（base 被忽略）', `const R = ${U}("file:///tmp/x", "https://example.com/")${PN};`],
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
    // ↓ r10 阻擋①：檔案自己宣告／匯入的 `URL` 不是全域那顆，這三種都是合法程式
    ['解構參數裡的 URL', `function g({ URL }) { return ${U}("..", ${IMU})${PN}; }`],
    ['陣列解構的 URL', `const [URL] = constructors; const p = ${U}("..", ${IMU})${PN};`],
    ['namespace import 叫 URL', `import * as URL from './custom-url.js'; const p = ${U}("..", ${IMU})${PN};`],
    ['catch 參數叫 URL', `try { f(); } catch (URL) { const p = ${U}("..", ${IMU})${PN}; }`],
    ['有預設值的參數叫 URL', `function g(URL = X) { return ${U}("..", ${IMU})${PN}; }`],
    // ↓ r11 阻擋③：這兩個宣告位置原本沒有探針，拿掉處理仍全綠
    ['函式運算式的參數叫 URL', `const g = function (URL) { return ${U}("..", ${IMU})${PN}; };`],
    ['rest 參數叫 URL', `function g(...URL) { return ${U}("..", ${IMU})${PN}; }`],
    ['解構裡的 rest 叫 URL', `function g({ ...URL }) { return ${U}("..", ${IMU})${PN}; }`],
    // ↓ r12 阻擋②：base 仍會先被驗證——非法 base 讓 new URL 直接丟 ERR_INVALID_URL，
    //    根本產不出任何 URL，不可以判成 file URL（原本沒有探針，突變成 `||` 仍 12/12 全綠）
    ['絕對 file input＋非法字面 base', `const p = ${U}("file:///x", "http://[::1")${PN};`],
    ['相對 input＋非法字面 base', `const p = ${U}("..", "http://[::1")${PN};`],
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
    // ⚠️ r9 起本層**只認直接寫出來的兩種形狀**（依複驗者判斷「乙：大幅簡化」）。
    //    以下全部是「經過變數／容器／函式」的形狀——每一種都真的會 ENOENT，但本層刻意不追。
    //    ⚠️ **這些漏抓沒有人補**：共用 ROOT 那道門只保護採用它的檔案（見 helper 自己的誠實劃界），
    //    未 import 它的檔案寫出這些形狀時，兩層都不會出聲。⇒ 這是**已知待辦**，不是已解決。
    ['存成中間變數再取', `const u = ${U}("..", ${IMU}); const R = u${PN};`],
    ['base 抽成常數', `const base = ${IMU}; const R = ${U}("..", base)${PN};`],
    ['值可由字面賦值證明的變數', `const rel = ".."; const R = ${U}(rel, ${IMU})${PN};`],
    ['以相對字面開頭的串接', `const R = ${U}("../fixtures/" + name, ${IMU})${PN};`],
    ['樣板有內插但開頭是相對', 'const R = ' + U + '(`../x/${name}`, ' + IMU + ')' + PN + ';'],
    ['跨函式傳遞', `function f(u){ return u${PN}; } const R = f(${U}("..", ${IMU}));`],
    ['跨檔（URL 物件從別的模組 import 進來）', `import { ROOT } from './other.js'; const R = ROOT${PN};`],
    ['先進容器再取出', `const box = { u: ${U}("..", ${IMU}) }; const R = box.u${PN};`],
    ['解構後再賦值（不是宣告式解構）', `let pathname; ({ pathname } = ${U}("..", ${IMU}));`],
    ['計算鍵的解構', `const key = "pathname"; const { [key]: R } = ${U}("..", ${IMU});`],
    ['URL 建構子本身被別名', `const V = URL; const R = new V("..", ${IMU})${PN};`],
    ['整個檔案自己宣告了 URL ⇒ 保守跳過', `class URL {} const R = new URL("..", ${IMU})${PN};`],
  ];
  for (const [why, src] of outOfRange) {
    assert.deepEqual(findBadPathnameUses(src), [],
      `這一種本來在射程外、現在卻抓到了：${why}\n`
      + '——r9 起本層刻意只認「直接寫」兩種形狀（複驗者判斷：列舉繞法補不完要關門）。'
      + '若你是**刻意**擴充射程，請連同檔頭與 mustCatch 一起更新；'
      + '若這是意外的誤抓，請修（本層寧可漏抓、不可誤抓）。');
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

test('⭐ 合法但會讓走訪爆掉的形狀（r7 阻擋③：parent 掛成屬性會無限遞迴）', () => {
  // 這幾段完全沒有 pathname，但曾讓 eslint-scope 沿 parent 循環無限遞迴 ⇒ 硬 CI 閘紅燈。
  for (const src of ['class C { static {} }', 'class C { static { let r = ".."; r += ".."; } }',
    'class C { static #x = 1; static { C.#x++; } }']) {
    assert.deepEqual(findBadPathnameUses(src), [], `合法程式讓掃描器爆掉或誤抓：${src}`);
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

test('⭐ 掃描清單的參數與過濾｜不建任何 repo（r13 阻擋①：舊 fixture 弄壞了主 repo）', () => {
  // ⚠️⚠️ **這一題原本會 `git init` 一個暫存 repo，而那顆 fixture 真的弄壞了主 repo。**
  //    複驗者精確重現：`scripts/git-hooks/pre-push` 會執行 `npm test`，hook 執行時環境帶著 `GIT_DIR`，
  //    只給 `cwd` 隔離不了它 ⇒ 那個 `git init` 實際上重新初始化了主 repo、把 `core.bare` 設成 `true`
  //    （主目錄與全部 worktree 同時失去工作樹身分），還把 fixture 的檔案塞進主 repo 的 index，
  //    而那顆考題當時顯示 1/1 通過。
  //    ⇒ 修法：**這一題不再建立任何 repo**。改成分兩半驗——參數（宣告）與過濾（純邏輯）。
  //    ⚠️ 誠實劃界：這樣就**沒有**「未 commit 的新檔真的會被列出」的端到端證明了。
  //    那個承諾現在只由下面的參數斷言撐著（宣告層），不是行為層。列為已知殘餘、不再自己建 repo 去證。

  // ⓐ 參數：三個承諾各自對應一個旗標，少一個就等於少一個承諾
  assert.ok(LS_FILES_ARGV.includes('--others'),
    '少了 --others：還沒 commit 的新檔就掃不到，護欄會在最需要它的那一刻失效');
  assert.ok(LS_FILES_ARGV.includes('--exclude-standard'),
    '少了 --exclude-standard：被 .gitignore 的工具產物會被算進來（假紅）');
  assert.ok(LS_FILES_ARGV.includes('--cached'), '少了 --cached：已追蹤的檔案掃不到');
  const quoteIdx = LS_FILES_ARGV.indexOf('core.quotepath=false');
  assert.ok(quoteIdx > 0 && LS_FILES_ARGV[quoteIdx - 1] === '-c',
    '少了 -c core.quotepath=false：含中文的檔名會被 git 轉成八進位轉義而開不了檔'
    + '——那正是本 PR 在修的同一族病');

  // ⓑ 過濾：只留 .js、排除瀏覽器側。用合成的 stdout，不碰任何 repo
  const filter = (lines) => lines.filter((f) => f.endsWith('.js')).filter((f) => !isBrowserSideFile(f));
  assert.deepEqual(
    filter(['server.js', 'lib/store.js', 'test/x.test.js', '中文 檔名.js',
      'public/app.js', 'prototype/lab/ui.js', 'prototype/lab/x.test.js', 'notjs.txt', 'a.mjs']),
    ['server.js', 'lib/store.js', 'test/x.test.js', '中文 檔名.js', 'prototype/lab/x.test.js'],
    '過濾結果不對。各項的意義：根層與 lib／test 留下；含空白中文的檔名留下；'
    + 'public/ 與 prototype 的瀏覽器模組排除；prototype 的 *.test.js **留下**（那是 Node 程式）；'
    + '非 .js 排除',
  );

  // ⓒ 清環境這件事本身要有斷言（它是事故的修法，不可以被靜靜拿掉）
  // ⚠️ 斷言「**沒有任何 GIT_ 開頭**」，不是抽查幾個名稱（r14 阻擋：抽查五個名稱擋不住
  //    `GIT_CONFIG_COUNT`／`GIT_CONFIG_KEY_*` 那一族，而它們能讓違規新檔靜靜消失）。
  const injected = { ...process.env, GIT_DIR: '/x', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/x', GIT_SHALLOW_FILE: '/x' };
  const realEnv = process.env;
  try {
    process.env = injected;
    const scrubbed = gitEnv();
    const leftover = Object.keys(scrubbed).filter((k) => k.startsWith('GIT_'));
    assert.deepEqual(leftover, [],
      `gitEnv() 沒清乾淨，還留著：${leftover.join(', ')}\n`
      + 'pre-push hook 會帶著這些進來：GIT_DIR 讓 git 去操作別的 repo（cwd 形同無效，'
      + '2026-08-09 就是這樣把主 repo 設成 bare 的）；GIT_CONFIG_* 可以注入 core.excludesFile，'
      + '讓 --exclude-standard 靜靜隱藏違規新檔。');
    // 反面自我驗證：非 Git 的環境變數要留著（清太多會讓 git 找不到 PATH／HOME 而整批紅）
    assert.equal(scrubbed.PATH, injected.PATH, 'gitEnv() 把 PATH 也清掉了');
    assert.equal(scrubbed.HOME, injected.HOME, 'gitEnv() 把 HOME 也清掉了');
  } finally {
    process.env = realEnv;
  }
});

test('⭐ 注入 GIT_CONFIG_* 的 excludesFile 不可以讓檔案從清單裡消失（r14 阻擋：行為題）', () => {
  // ⚠️ 複驗者的重現：`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.excludesFile GIT_CONFIG_VALUE_0=<檔>`
  //    會讓 `--exclude-standard` 隱藏那個檔案 ⇒ 違規新檔靜靜消失、護欄回報通過。
  //    這一題把 `server.js` 寫進一個 excludes 檔並注入，斷言它**仍在**清單裡。
  const dir = mkdtempSync(join(tmpdir(), 'excludes-'));
  const before = { ...process.env };
  try {
    const ex = join(dir, 'exclude-list');
    writeFileSync(ex, 'server.js\n');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.excludesFile';
    process.env.GIT_CONFIG_VALUE_0 = ex;
    const files = trackedJsFiles();
    assert.ok(files.includes('server.js'),
      '注入 core.excludesFile 之後 server.js 就從清單裡消失了＝gitEnv() 沒隔離 GIT_CONFIG_*，'
      + '任何違規新檔都能被這樣藏起來而護欄照樣全綠');
  } finally {
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⭐ 全樹掃描本身不可以被繼承的 GIT_DIR 帶去別的 repo（r13 阻擋①的另一半）', () => {
  // ⚠️ `trackedJsFiles()` 自己也吃這個坑：GIT_DIR 被繼承時它會去列**別的 repo** 的檔案，
  //    那會讓這道閘在 pre-push 期間掃錯對象而靜靜全綠。
  //    ⇒ 這一題把 GIT_DIR 指到一個**不存在**的路徑，然後確認清單照舊正確
  //      （若沒有清環境，git 會失敗或列出別的東西）。
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = join(tmpdir(), 'definitely-not-a-git-dir-xyz');
  try {
    const files = trackedJsFiles();
    assert.ok(files.includes('server.js'),
      '設了假的 GIT_DIR 之後清單就不對了＝gitEnv() 沒有真的隔離（cwd 隔離不了 GIT_DIR）');
    assert.ok(files.length > 100, `設了假的 GIT_DIR 之後只列出 ${files.length} 支＝隔離失效`);
  } finally {
    if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before;
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
