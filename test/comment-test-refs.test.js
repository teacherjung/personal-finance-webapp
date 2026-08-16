// @ts-check
// **註解指到的題，必須真的存在**（#463 換來的閘；本支是它被抽出來重做的第二版）。
//
// ## 為什麼要做成閘，而不是「下次小心」
//
// #463 走了九輪審查，**其中三輪抓到的是同一族**：我寫的註解指向一個不存在的題。
//   ・會漂的序數（「上一題」），而且其中一處**已經指錯**（那個位置的上一題是另一支考題）。
//   ・改成題名之後，兩個關鍵字**各自命中 0 題**（引用寫 `GIT_*`，實際題名寫 `GIT_DIR`）。
//   ・還有三個 JSDoc 用舊題名指路，其中一個甚至指到**別支檔案**的題名。
//
// 三次都是人工核對漏掉的。AGENTS.md 鐵則 10 早就寫著「不寫會漂的序數——點名 `file:line`
// 或題名關鍵字」，但**規則寫著沒有用**：本專案已經有證據（#374／#375／#376 連三支漏填同一欄）。
//
// ## 第一版（在 #463 裡）為什麼被抽掉——三個教訓都寫在實作裡
//
// 1. **題名抽取用正規式**：註解裡寫一句 `test('假題名')` 就能讓任何引用「命中 1 題」而放行；
//    反引號題名抓不到而誤殺；fixture 字串裡的 `test()` 被算成真題。⇒ 改用 parser。
// 2. **引用端掃整份原始碼**：一般字串裡出現記號也被當成註解引用。⇒ 改成**只掃註解**。
// 3. **插值哨兵用了 `\0`**：git 把整支 `.js` 當成二進位，**GitHub 上完全看不到 diff**
//    ——那支「防止註解指錯」的閘自己有兩輪是不可審的。⇒ 哨兵改成可讀的 ASCII 字串，
//    並且加一題盯著「這一族檔案不可以含控制字元」。
//
// ## 判準是**宣告**，不是推導
//
// 只檢查帶記號的引用（記號＝下面 `MARKER`）。不去猜「這個引號裡的字串是不是題名」
// ——那要列舉寫法，而列舉補不完。
//
// ⚠️ **誠實劃界**（別把本檔讀成比它更強的東西）：
//   ・**擋得住**：註解裡帶記號的引用指到 0 題或 ≥2 題。
//   ・**擋不住**：不帶記號的引用（例如直接寫「見本檔『某某題』」）。記號是自願的——強制所有
//     引號內字串都要對得上題名會誤殺一堆正常文字，那個代價比這個缺口大。
//   ・**擋不住**：跨檔引用（「見 `test/foo.test.js` 的某題」）——本閘只比對**同一支檔案**。
//   ・**擋不住**：註解說的內容對不對。它只驗「指路指得到東西」，不驗「指對地方」。
//   ・**不做可達性分析**：語法上是 `test(…)` 就算一題，不管它在不在會執行的分支裡、
//     `test` 這個名字有沒有被區域變數遮蔽。要擋那一類得做作用域分析，**未做**。
//     ⚠️ 也**不看 `test` 這個名字是從哪裡來的**：`import { it as test }`、區域函式蓋掉它，
//     本閘都看不出來。（我上一版在這裡寫「由命名慣例那題盯著」——那題只看 `it`／`describe`，
//     根本不管 import 來源，是一句撐不住的保證。Grok 預審 2026-08-16 抓到。）
//   ・**動態題名只比對得到靜態片段**：`test(\`… ${x} …\`)` 的插值處會換成一個哨兵字串，
//     關鍵字**不可以跨過插值**（跨過就會被判 0 題——那是刻意的，不是漏抓）。
//   ・**子題（`await t.test('…')`）不進索引**：那種寫法的 callee 是 `t.test`，而「看到 `X.test(…)`
//     就當子題」這個判準會誤殺**全樹 76 處正規式的 `.test()`**（實測數字），代價遠大於收益。
//     ⇒ 刻意不做。後果是**吵著紅**（用記號指子題會被判 0 題），不是靜靜放行——這一族由
//     題名關鍵字「子題不進索引」那題釘住現況，改的人看得到這個決定。
//   ・只掃 `test/` 底下第一層的 `*.test.js`（跟 `test/entry-guard.test.js` 掃 `scripts/` 同一個作法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// `espree`＝ESLint 的 parser。本支把它**明確列進 devDependencies**：原本只是 eslint 的傳遞相依，
// 靠傳遞相依跑考題，哪天上游換 parser 就會以看不懂的錯誤炸掉。用 createRequire 是因為它是 CJS。
const espree = createRequire(join(ROOT, 'package.json'))('espree');

/**
 * 引用記號的**單一真相**。
 *
 * ⚠️ 刻意用變數組出正規式，本檔的 fixture 不寫死記號字面——雖然現在只掃註解、字串裡的
 *    記號本來就不算數，但把它留成變數，改記號時只有一處要動。
 */
const MARKER = '題名關鍵字';
/**
 * 帶記號的合法引用：記號**緊接**左引號、關鍵字非空白、右引號在**同一行**。
 * ⚠️ 三個限制都是踩出來的（Codex #470 r2）：關鍵字允許純空白時，一個空白剛好命中唯一題名而放行；
 *    允許跨行／跨註解時，兩則不相干的註解會被配成一個「合法」引用。
 */
const REF_RE = () => new RegExp(`${MARKER}[「]([^」\n]+)[」]`, 'g');
/**
 * **壞掉的記號**：記號**緊接著左引號**、卻沒有合法收尾（缺右引號、或空關鍵字）。
 *
 * ⚠️ 為什麼要單獨抓（Codex #470 r1）：只用上面那條正規式的話，`記號「沒有關引號`
 *    與 `記號「」` **完全比不到** ⇒ 靜靜忽略。寫的人以為自己留了一條會被檢查的指路，
 *    實際上那行對本閘不存在——**「什麼都沒做卻看起來有做」正是這道閘要防的病，它自己不能犯。**
 *
 * ⚠️⚠️ **判準必須是「（可含水平空白後）緊接著左引號」**，不可以是「後面不是合法引用」
 *    （我第一版是後者，當場誤殺三支檔案）：散文裡把這個詞當名詞提到（前後加引號）時，
 *    記號後面接的是**右**引號——那是正常敘述，不是壞掉的指路。
 * ⚠️ **水平空白也要算**（Codex #470 r2）：`記號 「唯一」` 只多一個空白，上一版就整條當作不存在。
 */
const MARKER_OPEN_RE = () => new RegExp(`${MARKER}[ \t\u3000]*[「]`, 'g');
/**
 * 動態插值的哨兵。
 * ⚠️ **絕對不可以用控制字元**（第一版用 `\0`，git 當場把整支 `.js` 判成二進位，
 *    GitHub 上看不到 diff＝那支檔案沒有人審得了）。用一串正常 ASCII，關鍵字裡不可能出現。
 */
const HOLE = '<<INTERPOLATION>>';

/**
 * 這個 CallExpression 是不是在「定義一題」，以及本閘看不看得懂它。
 *
 * ⚠️⚠️ **這裡刻意沒有「支援的子命令清單」**（William 2026-08-16 裁示「看不懂就報錯」）。
 *    上一版列了 skip／only／todo，Codex #470 r2 實測打臉：**Node 26 的 `test` 上還有
 *    `expectFailure`**（`Object.getOwnPropertyNames(test)` 實跑），而那正是 CI 用的版本
 *    ——清單當場就是瞎的，而漏掉的後果是**假綠**（歧義關鍵字少算一題而放行）。
 *    ⇒ 列舉在這裡永遠追不上外部 API。改成關門：**看不懂的就當場報錯，不從索引消失。**
 *
 * ⚠️ 今天不會擋到任何人：全樹實測 **2169 個直接 `test(…)`、0 個 `test.<member>(…)`**。
 *    它約束的是以後怎麼寫——要用別的寫法，改的人得回來一起改這道閘。
 *
 * @param {any} c CallExpression 的 callee
 * @returns {'direct' | 'unsupported' | null} null＝根本不是在定義題
 */
function classifyCallee(c) {
  if (c?.type === 'Identifier') return c.name === 'test' ? 'direct' : null;
  // `test.<任何東西>(…)`／`test[…](…)`：可能是 node:test 的子命令（會定義題），
  // 也可能是某個叫 test 的區域變數在呼叫方法。本閘分不出來 ⇒ 一律報錯，由人決定。
  if (c?.type === 'MemberExpression' && c.object?.type === 'Identifier' && c.object.name === 'test') {
    return 'unsupported';
  }
  return null;
}

/**
 * 從第一個參數取題名。**取不出來回 `null`＝本閘看不懂**（呼叫端要當成錯誤，不可以略過）。
 *
 * ⚠️ 字串相加要攤平（`test('前' + '後', …)`）：全樹有 5 處是跨行接續的正常排版。
 *    含變數的部分放哨兵，語意與模板插值一致——關鍵字不可以跨過它。
 * @param {any} node 第一個參數的 AST
 * @returns {string | null}
 */
function titleOf(node) {
  if (node?.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (node?.type === 'TemplateLiteral') {
    return node.quasis.map((/** @type {any} */ q) => q.value.cooked).join(HOLE);
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const l = titleOf(node.left);
    const r = titleOf(node.right);
    if (l === null && r === null) return null;   // 兩邊都看不懂＝整個看不懂
    return `${l ?? HOLE}${r ?? HOLE}`;
  }
  return null;
}

/**
 * 用 parser 取出這一支檔案裡**真正的** `test(…)` 題名與**所有註解文字**。
 *
 * ⚠️ **解析不了要吵著紅**，不可以回空的——回空的話那支檔案的所有引用都會「命中 0 題」，
 *    訊息會把人帶去改註解，而真正的病是檔案語法壞了（本專案認過：靜靜跳過比沒有護欄更糟）。
 *
 * @param {string} source
 * @returns {{ titles: string[], comments: string[], calleeNames: Set<string>, unsupported: string[] }}
 * ⚠️ `comments` 是**逐則**回傳、不串接：串成一條之後，第一則缺右引號、第二則有右引號時
 *    會被配成一個「合法」引用（Codex #470 r2 實測）。合法引用不可跨註解、也不可跨行。
 */
export function parseTestFile(source) {
  // ⚠️ 選項是 `comment: true`（結果掛在 `ast.comments`）。我第一版寫 `onComment: []`——
  //    espree 不認，註解陣列**永遠是空的**，於是每一個引用都「命中 0 題」⇒ 九題一起紅。
  //    幸好是紅的：這種寫錯若剛好讓結果變空又沒人斷言，就會變成靜靜放行。
  const ast = espree.parse(source, { ecmaVersion: 2024, sourceType: 'module', comment: true, loc: true });
  /** @type {any[]} */
  const comments = ast.comments ?? [];
  /** @type {string[]} */
  const titles = [];
  /** @type {Set<string>} 出現過的「像是在定義題目」的呼叫名，給命名慣例那題用 */
  const calleeNames = new Set();
  /** @type {string[]} 本閘看不懂的測試定義寫法——**報錯用，不可以只是略過** */
  const unsupported = [];
  /** @param {any} node */
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      const c = node.callee;
      // ⚠️ **命名慣例只認直接呼叫**（`it(…)`／`describe(…)`），不含 `it.foo()`：
      //    我第一版把 MemberExpression 也算進去，於是 `for (const it of items) it.startsWith('/')`
      //    被判成「用了 it()」＝**誤殺**（`test/hosted-auth.test.js` 實際踩到）。
      //    ⚠️ 劃界：`it.skip(…)` 這種寫法抓不到——射程換精確度，刻意的取捨。
      if (c?.type === 'Identifier' && (c.name === 'it' || c.name === 'describe')) calleeNames.add(c.name);
      const kind = classifyCallee(c);
      if (kind === 'unsupported') {
        unsupported.push(`第 ${node.loc?.start?.line ?? '?'} 行：test.${c.property?.name ?? '[computed]'}(…)`);
      } else if (kind === 'direct') {
        const title = titleOf(node.arguments[0]);
        // ⚠️ 看不懂的題名**不可以靜靜跳過**：那一題會從索引消失，歧義關鍵字就少算一題而放行。
        if (title === null) unsupported.push(`第 ${node.loc?.start?.line ?? '?'} 行：題名不是字串／模板／字面相加`);
        else titles.push(title);
      }
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  })(ast);
  return { titles, comments: comments.map((/** @type {any} */ x) => String(x.value)), calleeNames, unsupported };
}

/**
 * 找出「指到 0 題或 ≥2 題」的引用。
 *
 * ⚠️ **引用只從註解裡找**：掃整份原始碼的話，一般字串（尤其是考題自己的 fixture）裡出現記號
 *    也會被當成指路，於是本閘會對著不是註解的東西報錯。
 *
 * @param {string} source 一支考題檔的原始碼
 * @returns {{ keyword: string, hits: number }[]} 空陣列＝這一支沒有問題
 */
export function badTestRefs(source) {
  const { titles, comments } = parseTestFile(source);
  /** @type {{ keyword: string, hits: number }[]} */
  const bad = [];
  for (const comment of comments) {
    for (const m of comment.matchAll(REF_RE())) {
      const keyword = m[1];
      // ⚠️ 純空白的關鍵字要當壞掉，不可以當「獨特片段」：一個空白剛好命中唯一題名就放行了。
      if (keyword.trim() === '') { bad.push({ keyword: `${MARKER}「${keyword}」`, hits: -1 }); continue; }
      const hits = titles.filter((t) => t.includes(keyword)).length;
      if (hits !== 1) bad.push({ keyword, hits });
    }
    // ⚠️ 壞掉的記號用 `hits: -1` 回報（見 MARKER_OPEN_RE 的理由）：它跟「指到 0 題」不是同一件事
    //    ——那個是指路指錯，這個是**指路根本沒被檢查**，訊息要分得開。
    // ⚠️ 空白關鍵字上面已經報過一次，這裡要把它算進 wellFormed，否則同一處會報兩遍。
    const wellFormed = new Set([...comment.matchAll(REF_RE())].map((m) => m.index));
    for (const m of comment.matchAll(MARKER_OPEN_RE())) {
      if (wellFormed.has(m.index)) continue;   // 同一個位置有合法引用＝沒壞
      bad.push({ keyword: comment.slice(m.index, m.index + MARKER.length + 13).split('\n')[0], hits: -1 });
    }
  }
  return bad;
}

/** 正常文字檔本來就會有的三個控制字元：tab／換行／歸位。 */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

/**
 * 找出第一個不該出現的控制字元，回它的位置；沒有就回 -1。
 *
 * ⚠️ **刻意不用正規式**：直接寫跳脫序列很容易把真正的控制字元寫進檔案（我寫這一題的第一版
 *    就這樣，當場被自己這一題抓到）；改用字串組又會撞到 eslint 的 `no-control-regex`
 *    （它連 `new RegExp` 的字串參數一起管）。逐字檢查碼位最直白，也沒有這些坑。
 *
 * ⚠️ **抽成可匯出的函式**是為了讓它自己有誘餌題（Grok 預審 2026-08-16 抓到）：它原本包在
 *    掃描題裡，而修掉既有的那顆 NUL 之後全樹本來就乾淨 ⇒ **把它改成永遠回 -1，掃描題照樣綠**。
 *    那就是「護欄什麼都沒做卻回報通過」，本專案認過的病型。
 *
 * @param {string} text
 * @returns {number} 位置，或 -1
 */
export function firstControl(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // ⚠️ **C0 之外還有 DEL（U+007F）與 C1（U+0080–U+009F）**（Codex #470 r1）：
    //    上一版只查 `code < 0x20`，那兩族一樣是看不見的控制字元、一樣進得了原始碼。
    const isControl = (code < 0x20) || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (isControl && !ALLOWED_CONTROL.has(code)) return i;
  }
  return -1;
}

/**
 * 掃一組來源，回報「指路指不到東西」的問題。**純函式、可注入**。
 *
 * ⚠️ 為什麼要抽出來（Codex #470 r2 實測的三顆存活突變）：掃描邏輯原本寫在全樹那一題裡，
 *    於是把 `for (… of badTestRefs(src))` 改成 `for (… of [])`——**接線整個斷掉，20 題照樣綠**。
 *    純函式有誘餌不等於接線有人守。抽出來之後，fixture 餵一支「真的有壞引用」的合成檔，
 *    正式全樹題再走同一支函式，拔掉接線就會紅。
 *
 * @param {{ name: string, source: string }[]} sources
 * @returns {string[]} 每一項是一行可讀的問題描述；空陣列＝乾淨
 */
export function scanRefs(sources) {
  /** @type {string[]} */
  const problems = [];
  for (const { name, source } of sources) {
    for (const { keyword, hits } of badTestRefs(source)) {
      problems.push(hits === -1
        ? `  ${name}：「${keyword}」是壞掉的記號（沒有合法收尾／關鍵字是空白）⇒ 這條指路根本沒被檢查`
        : `  ${name}：「${keyword}」在同檔命中 ${hits} 題（要恰好 1）`);
    }
  }
  return problems;
}

/**
 * 掃一組來源，回報「本閘看不懂的測試定義寫法」。**純函式、可注入**（理由同 `scanRefs`）。
 * @param {{ name: string, source: string }[]} sources
 * @returns {string[]}
 */
export function scanUnsupported(sources) {
  /** @type {string[]} */
  const problems = [];
  for (const { name, source } of sources) {
    for (const u of parseTestFile(source).unsupported) problems.push(`  ${name} ${u}`);
  }
  return problems;
}

/**
 * 掃一組來源，回報控制字元。**純函式、可注入**（理由同 `scanRefs`）。
 * @param {{ name: string, source: string }[]} sources
 * @returns {string[]}
 */
export function scanControl(sources) {
  /** @type {string[]} */
  const problems = [];
  for (const { name, source } of sources) {
    const at = firstControl(source);
    if (at !== -1) {
      const line = source.slice(0, at).split('\n').length;
      problems.push(`  ${name}:${line} 有控制字元 U+${source.charCodeAt(at).toString(16).padStart(4, '0').toUpperCase()}`);
    }
  }
  return problems;
}

/** 本檔掃的考題檔清單（`test/` 第一層的 `*.test.js`）。 */
function testFiles() {
  return readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort();
}

// ── 純函式的題（fixture 由本題自己控制，不押正式程式的寫法細節）────────────
test('⭐ 指到 0 題要抓出來（關鍵字與題名對不上）', () => {
  const src = `test('真的題名 A', () => {});\n// ${MARKER}「不存在的題名」`;
  assert.deepEqual(badTestRefs(src), [{ keyword: '不存在的題名', hits: 0 }]);
});

test('⭐ 指到兩題也要抓出來（關鍵字不夠獨特＝下一個人找不到你指哪一題）', () => {
  const src = `test('清單 A 的題', () => {});\ntest('清單 B 的題', () => {});\n// ${MARKER}「清單」`;
  assert.deepEqual(badTestRefs(src), [{ keyword: '清單', hits: 2 }]);
});

test('恰好命中一題＝放行（否則整批誤殺）', () => {
  const src = `test('⭐ 很獨特的題名', () => {});\n// ${MARKER}「很獨特的題名」`;
  assert.deepEqual(badTestRefs(src), []);
});

test('⭐ 註解裡的假 test() 不算數（第一版的假綠入口）', () => {
  // ⚠️ 這一題就是「為什麼一定要 parser」。字串比對版在這裡會放行，因為它看不出註解與程式的差別。
  const src = `test('真的題名', () => {});\n// test('註解裡的假題名', () => {});\n// ${MARKER}「註解裡的假題名」`;
  assert.deepEqual(badTestRefs(src), [{ keyword: '註解裡的假題名', hits: 0 }],
    '註解裡的 test() 被當成真的題了 ⇒ 隨便寫一句註解就能讓任何引用「命中 1 題」而放行');
});

test('⭐ 字串裡的假 test() 也不算數（fixture 汙染）', () => {
  const src = `test('真的題名', () => {});\nconst fixture = \`test('字串裡的假題名', () => {});\`;\n// ${MARKER}「字串裡的假題名」`;
  assert.deepEqual(badTestRefs(src), [{ keyword: '字串裡的假題名', hits: 0 }],
    'fixture 字串裡的 test() 被當成真的題了——本檔自己就滿是這種字串');
});

test('⭐ 字串裡的記號不算引用（第一版掃整份原始碼，會對著 fixture 報錯）', () => {
  // ⚠️ 這是抽掉重做的第二個理由：引用端只能從**註解**裡找。
  const src = `test('真的題名', () => {});\nconst fixture = '${MARKER}「這只是資料，不是指路」';`;
  assert.deepEqual(badTestRefs(src), [],
    '一般字串裡的記號被當成註解引用了 ⇒ 本閘會對著考題自己的 fixture 報「指到 0 題」');
});

test('⭐ 縮排的 test() 是真的題（拿「行首」當判準會誤殺）', () => {
  // 本 repo 真的有這種寫法（迴圈裡動態產生題目）。
  const src = `for (const x of [1]) {\n  test('迴圈裡產生的題', () => {});\n}\n// ${MARKER}「迴圈裡產生的題」`;
  assert.deepEqual(badTestRefs(src), [],
    '縮排的 test() 沒被算成題 ⇒ 指向它的引用會被誤判成「指到 0 題」＝假紅');
});

test('⭐ 反引號題名要抓得到，插值處是斷點', () => {
  const src = 'test(`⭐ ${rel}：經過 symlink 執行的結果`, () => {});\n'
    + `// ${MARKER}「經過 symlink 執行的結果」`;
  assert.deepEqual(badTestRefs(src), [], '反引號題名沒被抓到 ⇒ 指向它的引用會假紅');

  const across = 'test(`前段 ${x} 後段`, () => {});\n' + `// ${MARKER}「前段 後段」`;
  assert.deepEqual(badTestRefs(across), [{ keyword: '前段 後段', hits: 0 }],
    '關鍵字跨過插值卻被判命中 ⇒ 那是碰運氣，不是指得到（本檔劃界明說跨插值算 0 題）');
});

test('⭐ 題名裡的特殊字元不可以被吃掉（防「部分失明」）', () => {
  // ⚠️⚠️ **兩個方向都要驗，只驗正面是假綠**（第一版就栽在這裡）：引用**解析不出來**時
  //    `badTestRefs` 回空陣列，而「解析得出來且沒問題」也是空陣列——兩種情況長得一模一樣。
  //    真正有鑑別力的是**反面**：拿一個對不上的題名去引用，它必須被回報成「命中 0 題」；
  //    引用若整個沒被解析到，這裡就會拿到空陣列而轉紅。
  for (const title of ['secret 掃描：帶全形冒號', '帶（全形括號）的題', '帶 * 星號與 `反引號` 的題', '帶 ASCII: colon']) {
    const ok = `test(${JSON.stringify(title)}, () => {});\n// ${MARKER}「${title}」`;
    assert.deepEqual(badTestRefs(ok), [], `題名「${title}」明明對得上卻被判違規＝誤殺`);

    const miss = `test('完全無關的題名', () => {});\n// ${MARKER}「${title}」`;
    assert.deepEqual(badTestRefs(miss), [{ keyword: title, hits: 0 }],
      `含「${title}」這種字元的引用**沒有被解析到**（拿到空陣列＝什麼都沒驗）\n`
      + '⇒ 引用正規式被收窄了，含這個字元的引用會全部變成本閘的盲區，而本閘照樣全綠。');
  }
});

test('解析不了的檔案要吵著紅，不可以靜靜跳過', () => {
  assert.throws(() => badTestRefs('const = = =;'), /.*/,
    '語法壞掉的檔案被吞掉了 ⇒ 那支檔案的引用會全部「命中 0 題」，訊息把人帶去改註解、而真病是語法');
});

// ── 接線題：真的掃全樹（純函式對了不代表有人在用它）──────────────────────
test('⭐ 三支掃描函式都要真的掃得到東西（餵合成檔，不靠全樹現況）', () => {
  // ⚠️ Codex #470 r2 實測：掃描邏輯原本寫在全樹那一題裡，把它換成空陣列、
  //    或把 firstControl 換成永遠 -1，**20 題照樣全綠**——接線斷了沒有人守。
  //    ⇒ 抽成純函式之後，這裡餵「真的有問題」的合成檔，拔掉接線就會紅。
  assert.deepEqual(
    scanRefs([{ name: 'fake.js', source: `test('真題', () => {});\n// ${MARKER}「不存在的題」` }]).length,
    1, 'scanRefs 掃不到壞引用 ⇒ 全樹那一題等於沒接線');
  assert.deepEqual(
    scanUnsupported([{ name: 'fake.js', source: "test.skip('x', () => {});" }]).length,
    1, 'scanUnsupported 掃不到看不懂的寫法 ⇒ 關門那一題等於沒接線');

  // ⚠️ 控制字元的誘餌**刻意放在 8 KiB 之後**：git 的二進位判定只取樣前段，而 #463 那顆真的 NUL
  //    位在第 86,342 個位元組。只掃前綴的實作在真實事故上會完全漏掉——這個誘餌就是為它造的。
  const far = `${'x'.repeat(9000)}${String.fromCharCode(0)}`;
  assert.equal(scanControl([{ name: 'fake.js', source: far }]).length, 1,
    'scanControl 漏掉 8 KiB 之後的控制字元 ⇒ 本支要防的那顆真 NUL 正好在那個位置之後');
  assert.deepEqual(scanControl([{ name: 'ok.js', source: 'const a = 1;\n' }]), [],
    '乾淨的來源被誤報＝整批誤殺');
});

test('⭐ 全部考題檔：註解裡帶記號的引用都要恰好命中一題', () => {
  const files = testFiles();
  assert.ok(files.length > 50, `只列到 ${files.length} 支考題檔，列舉大概壞了`);

  const sources = files.map((f) => ({ name: `test/${f}`, source: readFileSync(join(ROOT, 'test', f), 'utf8') }));
  const refCount = sources.reduce((n, { source }) =>
    n + parseTestFile(source).comments.reduce((m, c) => m + [...c.matchAll(REF_RE())].length, 0), 0);
  const problems = scanRefs(sources);
  // ⚠️ 這條反面自檢**只證明「掃到了東西」**，不證明沒有部分失明——後者由上面那條逐字元的
  //    fixture 守（數量下限擋不住「少解析到一則」）。這裡刻意不寫死期望數字，那個數字會漂。
  assert.ok(refCount > 0,
    '全樹一個帶記號的引用都沒解析到——正規式大概壞了（本閘會在什麼都沒掃的情況下通過）');
  assert.deepEqual(problems, [],
    `有註解指到不存在（或不只一個）的題：\n${problems.join('\n')}\n`
    + '⇒ 下一個人照著指路會找不到東西。請把關鍵字改成同檔某一題題名的**獨特片段**。\n'
    + '（AGENTS.md 鐵則 10：不寫會漂的序數，點名 file:line 或題名關鍵字。）');
});

test('⭐ 看不懂的測試定義寫法要當場報錯，不可以從索引消失（William 2026-08-16 裁示）', () => {
  // ⚠️ 這一題是本閘的**關門**。理由寫在 classifyCallee 上方：列舉永遠追不上外部 API
  //    ——Codex #470 r2 實測 Node 26 的 `test` 上多了 `expectFailure`，而那正是 CI 的版本。
  //    漏掉的後果不是吵紅，是**歧義關鍵字少算一題而放行**（假綠）。
  const un = (/** @type {string} */ src) => parseTestFile(src).unsupported.length;

  // ① 任何 `test.<成員>(…)` 都看不懂 ⇒ 報錯（不管它是 node:test 的子命令，還是區域變數的方法）
  for (const member of ['skip', 'only', 'todo', 'it', 'describe', 'suite', 'expectFailure', 'includes']) {
    assert.equal(un(`test.${member}('題', () => {});`), 1,
      `test.${member}(…) 沒被回報成「看不懂」⇒ 它會從索引消失，歧義關鍵字就少算一題而放行`);
  }
  assert.equal(un("test['sk' + 'ip']('題', () => {});"), 1, 'computed 的成員呼叫沒被回報');
  assert.equal(un('test[`skip`](\'題\', () => {});'), 1, '模板字串 computed 沒被回報');

  // ② 看不懂的**題名形狀**也要報錯
  assert.equal(un('test(someVariable, () => {});'), 1, '題名是變數卻沒被回報');
  assert.equal(un('test(String.raw`raw`, () => {});'), 1, 'String.raw 題名沒被回報');
  assert.equal(un('test(123, () => {});'), 1, '題名不是字串卻沒被回報');

  // ③ 反面：標準寫法一個都不可以被誤報（誤殺＝整批紅）
  assert.equal(un("test('一般字串', () => {});"), 0, '最標準的寫法被誤報了');
  assert.equal(un('test(`模板 ${x} 題名`, () => {});'), 0, '模板題名被誤報了');
  assert.equal(un("test('跨行' + '接續', () => {});"), 0, '字面相加被誤報了（全樹有 5 處是這種排版）');
  assert.equal(un("const r = a.filter((x) => x.includes('foo'));"), 0, '完全無關的程式被誤報了');
});

test('⭐ 全部考題檔：不可以有本閘看不懂的測試定義寫法', () => {
  const problems = scanUnsupported(testFiles().map((f) => ({ name: `test/${f}`, source: readFileSync(join(ROOT, 'test', f), 'utf8') })));
  assert.deepEqual(problems, [],
    `這些寫法本閘看不懂，它們的題不會進索引 ⇒ 指向它們的引用會被誤判、歧義關鍵字會少算：\n${problems.join('\n')}\n`
    + '⇒ 請改用標準寫法 `test(\'字串\'／模板／字面相加, fn)`；真要用別的寫法，'
    + '請連同 classifyCallee()／titleOf() 一起改，再更新本題。');
});

test('⭐ 壞掉的記號要吵，不可以靜靜忽略（Codex #470 r1）', () => {
  // ⚠️ 缺右引號／空關鍵字時，合法引用的正規式**完全比不到** ⇒ 上一版靜靜忽略。
  //    寫的人以為留了一條會被檢查的指路，實際上那行對本閘不存在
  //    ——「什麼都沒做卻看起來有做」正是這道閘要防的病，它自己不能犯。
  const broken = badTestRefs(`test('x', () => {});\n// ${MARKER}「沒有關引號`);
  assert.equal(broken.length, 1, '缺右引號的記號被靜靜忽略了');
  assert.equal(broken[0].hits, -1, '壞掉的記號要用 -1 跟「指到 0 題」分開（兩者的病因不同）');
  assert.equal(badTestRefs(`test('x', () => {});\n// ${MARKER}「」`).length, 1, '空關鍵字被靜靜忽略了');

  // ⚠️ 以下三種是 Codex #470 r2 實測仍會放行的形狀，逐一釘住。
  const one = (/** @type {string} */ src) => badTestRefs(src).filter((b) => b.hits === -1).length;
  assert.equal(one(`test('唯一', () => {});\n// ${MARKER} 「唯一」`), 1,
    '記號與左引號之間多一個空白，整條宣告就被當作不存在（靜靜忽略）');
  assert.equal(one(`test('a b', () => {});\n// ${MARKER}「 」`), 1,
    '純空白的關鍵字剛好命中唯一題名 ⇒ 被當成「合法的獨特片段」而放行');
  // ⚠️ 兩則**分開的**註解：第一則開了引號沒收、第二則才出現右引號。
  //    註解若被串成一條，這兩則會被配成一個「合法」引用而放行（Codex #470 r2 實測）。
  assert.equal(one(`test('x', () => {});\n// ${MARKER}「foo\n// bar」`), 1,
    '合法引用跨了註解 ⇒ 兩則不相干的註解會被配成一個「合法」引用');
  // ⚠️ **區塊註解**本身就含換行，是「跨行配對」唯一觀察得到的形狀：
  //    允許關鍵字含換行的話，下面這則會被配成一個橫跨兩行的「合法」引用而放行。
  assert.equal(one(`test('x', () => {});\n/* ${MARKER}「foo\n   bar」 */`), 1,
    '合法引用跨了行 ⇒ 區塊註解裡兩段不相干的文字會被配成一個「合法」引用');

  // ⚠️ 反面（誤殺防線）：把這個詞當**名詞**提到（前後加引號）是正常敘述，不是壞掉的指路。
  //    我第一版的判準是「後面不是合法引用就算壞」，當場誤殺三支檔案。
  assert.deepEqual(badTestRefs(`test('x', () => {});\n// 這個記號叫「${MARKER}」，用法見檔頭`), [],
    '把記號當名詞提到就被判成壞掉＝誤殺');
});

test('⭐ 子題不進索引（誠實劃界：刻意的，因為判準會誤殺全樹的正規式 .test()）', () => {
  // ⚠️ `await t.test('子題')` 的 callee 是 `t.test`。要抓它就得認「任何 X.test(…)」，
  //    而全樹有 76 處正規式的 `.test()`（實測）——那個判準會把它們全部誤判成題名。
  //    ⇒ 刻意不做。這一題釘住**現況**，讓改的人看得到這個決定，而不是以為它壞了。
  //    後果是吵著紅（用記號指子題會被判 0 題），不是靜靜放行。
  assert.deepEqual(parseTestFile("test('父', async (t) => { await t.test('子題', () => {}); });").titles, ['父'],
    '子題現在進索引了 ⇒ 上面那段劃界要改寫，並確認正規式的 .test() 沒有被誤殺');

  // ⚠️ **釘住宣稱的後果，不只釘 titles 的形狀**（Grok 預審第二輪抓到）：上一版只斷言
  //    titles === ['父']，於是「用記號指子題會吵著紅」這句沒有人守——把 `badTestRefs` 改成
  //    「hits===0 就不報」，titles 那條照樣綠，而劃界宣稱的保護已經死了。
  assert.deepEqual(
    badTestRefs(`test('父', async (t) => { await t.test('子題', () => {}); });\n// ${MARKER}「子題」`),
    [{ keyword: '子題', hits: 0 }],
    '用記號指子題卻沒有吵紅 ⇒ 檔頭「後果是吵著紅、不是靜靜放行」那句就不成立了');
});

test('⭐ 控制字元的偵測本身要有效（自己造誘餌，不然掃描題只證明「現況乾淨」）', () => {
  // ⚠️ Grok 預審抓到：`firstControl` 原本包在掃描題裡，而全樹本來就乾淨
  //    ⇒ 把它改成永遠回 -1，掃描題照樣綠。閘宣稱在守「不可以有控制字元」，
  //    考題卻只證明「現在沒掃到」，不證明「掃得到」。
  // ⚠️ 誘餌用 String.fromCharCode 組出來——直接打字面就會把控制字元寫進本檔（第一版的原罪）。
  assert.equal(firstControl('乾淨的文字'), -1, '正常文字被誤判成有控制字元＝整批誤殺');
  assert.equal(firstControl('a\tb\nc\r'), -1, 'tab／換行／歸位是正常文字檔就有的，不可以誤判');
  assert.equal(firstControl(`a${String.fromCharCode(0)}b`), 1, 'NUL 沒被抓到——那正是讓 git 判二進位的那一顆');
  assert.equal(firstControl(`x${String.fromCharCode(1)}`), 1, 'U+0001 沒被抓到');
  assert.equal(firstControl(`${String.fromCharCode(0x1f)}`), 0, 'U+001F 沒被抓到（C0 上界）');
  // ⚠️ C0 之外還有兩族（Codex #470 r1）：DEL 與 C1。它們一樣看不見、一樣進得了原始碼。
  assert.equal(firstControl(`a${String.fromCharCode(0x7f)}`), 1, 'U+007F（DEL）沒被抓到');
  assert.equal(firstControl(`a${String.fromCharCode(0x80)}`), 1, 'U+0080（C1 下界）沒被抓到');
  assert.equal(firstControl(`a${String.fromCharCode(0x9f)}`), 1, 'U+009F（C1 上界）沒被抓到');
  assert.equal(firstControl(`a${String.fromCharCode(0xa0)}`), -1, 'U+00A0 是不斷行空格、不是控制字元，不可誤殺');
});

test('⭐ it()／describe() 的偵測本身要有效（自己造誘餌，不然掃描題是空的）', () => {
  // ⚠️ 為什麼非有這一題不可：現在整個 repo 一個 `it()` 都沒有，所以**把偵測掏空，掃描那題照樣綠**
  //    （實測過）——那一題自己證明不了偵測還活著。本專案認過這個病型：護欄什麼都沒做卻回報通過。
  //    ⇒ 這裡自己餵誘餌。
  assert.equal(parseTestFile("it('x', () => {});").calleeNames.has('it'), true,
    'it() 的偵測失效了 ⇒ 有人改用 mocha 風格時，那些題會從本閘視野消失而沒人知道');
  assert.equal(parseTestFile("describe('g', () => {});").calleeNames.has('describe'), true,
    'describe() 的偵測失效了');
  // 反面（誤殺防線）：`it` 當成一般變數用不算——`test/hosted-auth.test.js` 真的有這種寫法
  assert.equal(parseTestFile("for (const it of a) if (it.startsWith('/')) b.push(it);").calleeNames.has('it'), false,
    '`it.foo()` 被當成測試定義了＝誤殺（迴圈變數叫 it 是完全正常的寫法）');
  assert.equal(parseTestFile("test('x', () => {});").calleeNames.has('it'), false, '單純的 test() 不該被記成 it');
});

test('⭐ 命名慣例沒有漂：考題一律用 test(…)，不用 it／describe', () => {
  // ⚠️ 這一題是**關門**，不是潔癖：上面的題名抽取只認 `test(…)`。有人開始用 `it()` 或
  //    `describe()` 包起來的話，那些題就從本閘的視野裡消失，而指向它們的引用會被誤判成
  //    「指到 0 題」＝假紅，逼下一個人把護欄關掉。
  //    ⇒ 與其列舉更多名字（列舉補不完），不如**把現行慣例釘住**：真要改用別的寫法，
  //      這一題會紅，改的人被迫回來把抽取邏輯一起改。
  /** @type {string[]} */
  const strays = [];
  for (const f of testFiles()) {
    const { calleeNames } = parseTestFile(readFileSync(join(ROOT, 'test', f), 'utf8'));
    for (const name of ['it', 'describe']) if (calleeNames.has(name)) strays.push(`  test/${f}：用了 ${name}()`);
  }
  assert.deepEqual(strays, [],
    `有考題檔改用 it()／describe()：\n${strays.join('\n')}\n`
    + '⇒ 本閘的題名抽取只認 test(…)，那些題會從視野消失、指向它們的引用被誤判成 0 題。\n'
    + '要改慣例的話，請連同 parseTestFile() 的抽取邏輯一起改，再更新這一題。');
});

test('⭐ 考題檔不可以含控制字元（含了 git 就當它是二進位，diff 在 GitHub 上看不見）', () => {
  // ⚠️ 這一題是**血的教訓**：本閘的第一版把插值哨兵寫成 `\0`，git 立刻把整支 `.js` 判成二進位
  //    （`git diff` 顯示 `Bin … bytes`、numstat 兩欄都是 `-`）⇒ **GitHub 上完全看不到 diff**，
  //    那支「防止註解指錯地方」的閘自己有兩輪是沒有人審得了的。
  //    ⇒ 一個看不見的位元組就能讓一份檔案退出審查制度，這值得一道閘。
  //    ⚠️ 射程：只管 `test/` 第一層的考題檔（本閘掃的那一族）。別處由別人管。
  const dirty = scanControl(testFiles().map((f) => ({ name: `test/${f}`, source: readFileSync(join(ROOT, 'test', f), 'utf8') })));
  assert.deepEqual(dirty, [],
    `這些考題檔含控制字元：\n${dirty.join('\n')}\n`
    + '⇒ git 會把它們當成二進位檔，GitHub 上看不到 diff、審查者等於審不到。\n'
    + '（要表示「這裡有個特殊位置」請用一串正常 ASCII 當哨兵，不要用控制字元。）');
});
