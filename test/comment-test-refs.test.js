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
//     （本 repo 的 `test` 一律直接 import 自 `node:test`，由下面「命名慣例」那題盯著。）
//   ・**動態題名只比對得到靜態片段**：`test(\`… ${x} …\`)` 的插值處會換成一個哨兵字串，
//     關鍵字**不可以跨過插值**（跨過就會被判 0 題——那是刻意的，不是漏抓）。
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
/** 帶記號的引用：記號後面緊跟一對全形引號。 */
const REF_RE = () => new RegExp(`${MARKER}[「]([^」]+)[」]`, 'g');
/**
 * 動態插值的哨兵。
 * ⚠️ **絕對不可以用控制字元**（第一版用 `\0`，git 當場把整支 `.js` 判成二進位，
 *    GitHub 上看不到 diff＝那支檔案沒有人審得了）。用一串正常 ASCII，關鍵字裡不可能出現。
 */
const HOLE = '<<INTERPOLATION>>';

/**
 * 用 parser 取出這一支檔案裡**真正的** `test(…)` 題名與**所有註解文字**。
 *
 * ⚠️ **解析不了要吵著紅**，不可以回空的——回空的話那支檔案的所有引用都會「命中 0 題」，
 *    訊息會把人帶去改註解，而真正的病是檔案語法壞了（本專案認過：靜靜跳過比沒有護欄更糟）。
 *
 * @param {string} source
 * @returns {{ titles: string[], comments: string, calleeNames: Set<string> }}
 */
export function parseTestFile(source) {
  // ⚠️ 選項是 `comment: true`（結果掛在 `ast.comments`）。我第一版寫 `onComment: []`——
  //    espree 不認，註解陣列**永遠是空的**，於是每一個引用都「命中 0 題」⇒ 九題一起紅。
  //    幸好是紅的：這種寫錯若剛好讓結果變空又沒人斷言，就會變成靜靜放行。
  const ast = espree.parse(source, { ecmaVersion: 2024, sourceType: 'module', comment: true });
  /** @type {any[]} */
  const comments = ast.comments ?? [];
  /** @type {string[]} */
  const titles = [];
  /** @type {Set<string>} 出現過的「像是在定義題目」的呼叫名，給命名慣例那題用 */
  const calleeNames = new Set();
  /** @param {any} node */
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      const c = node.callee;
      const name = c?.type === 'Identifier' ? c.name
        : (c?.type === 'MemberExpression' && c.object?.type === 'Identifier' ? c.object.name : null);
      // ⚠️ **命名慣例只認直接呼叫**（`it(…)`／`describe(…)`），不含 `it.foo()`：
      //    我第一版把 MemberExpression 也算進去，於是 `for (const it of items) it.startsWith('/')`
      //    被判成「用了 it()」＝**誤殺**（`test/hosted-auth.test.js` 實際踩到）。
      //    ⚠️ 劃界：`it.skip(…)` 這種寫法抓不到——射程換精確度，刻意的取捨。
      if (c?.type === 'Identifier' && (c.name === 'it' || c.name === 'describe')) calleeNames.add(c.name);
      if (name === 'test') {
        const a = node.arguments[0];
        if (a?.type === 'Literal' && typeof a.value === 'string') titles.push(a.value);
        else if (a?.type === 'TemplateLiteral') {
          titles.push(a.quasis.map((/** @type {any} */ q) => q.value.cooked).join(HOLE));
        }
      }
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  })(ast);
  return { titles, comments: comments.map((/** @type {any} */ x) => x.value).join('\n'), calleeNames };
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
  for (const m of comments.matchAll(REF_RE())) {
    const keyword = m[1];
    const hits = titles.filter((t) => t.includes(keyword)).length;
    if (hits !== 1) bad.push({ keyword, hits });
  }
  return bad;
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
test('⭐ 全部考題檔：註解裡帶記號的引用都要恰好命中一題', () => {
  const files = testFiles();
  assert.ok(files.length > 50, `只列到 ${files.length} 支考題檔，列舉大概壞了`);

  let refCount = 0;
  /** @type {string[]} */
  const problems = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, 'test', f), 'utf8');
    refCount += [...parseTestFile(src).comments.matchAll(REF_RE())].length;
    for (const { keyword, hits } of badTestRefs(src)) {
      problems.push(`  test/${f}：「${keyword}」在同檔命中 ${hits} 題（要恰好 1）`);
    }
  }
  // ⚠️ 這條反面自檢**只證明「掃到了東西」**，不證明沒有部分失明——後者由上面那條逐字元的
  //    fixture 守（數量下限擋不住「少解析到一則」）。這裡刻意不寫死期望數字，那個數字會漂。
  assert.ok(refCount > 0,
    '全樹一個帶記號的引用都沒解析到——正規式大概壞了（本閘會在什麼都沒掃的情況下通過）');
  assert.deepEqual(problems, [],
    `有註解指到不存在（或不只一個）的題：\n${problems.join('\n')}\n`
    + '⇒ 下一個人照著指路會找不到東西。請把關鍵字改成同檔某一題題名的**獨特片段**。\n'
    + '（AGENTS.md 鐵則 10：不寫會漂的序數，點名 file:line 或題名關鍵字。）');
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
  // ⚠️ **刻意不用正規式**：直接寫跳脫序列很容易把真正的控制字元寫進檔案
  //    （我寫這一題的第一版就這樣，當場被自己這一題抓到）；改用字串組又會撞到 eslint 的
  //    `no-control-regex`（它連 `new RegExp` 的字串參數一起管）。逐字檢查碼位最直白，也沒有這些坑。
  //    允許的控制字元只有 tab／換行／歸位——那三個是正常文字檔本來就會有的。
  const ALLOWED = new Set([0x09, 0x0a, 0x0d]);
  const firstControl = (/** @type {string} */ text) => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x20 && !ALLOWED.has(code)) return i;
    }
    return -1;
  };
  /** @type {string[]} */
  const dirty = [];
  for (const f of testFiles()) {
    const buf = readFileSync(join(ROOT, 'test', f), 'utf8');
    const at = firstControl(buf);
    if (at !== -1) {
      const line = buf.slice(0, at).split('\n').length;
      dirty.push(`  test/${f}:${line} 有控制字元 U+${buf.charCodeAt(at).toString(16).padStart(4, '0').toUpperCase()}`);
    }
  }
  assert.deepEqual(dirty, [],
    `這些考題檔含控制字元：\n${dirty.join('\n')}\n`
    + '⇒ git 會把它們當成二進位檔，GitHub 上看不到 diff、審查者等於審不到。\n'
    + '（要表示「這裡有個特殊位置」請用一串正常 ASCII 當哨兵，不要用控制字元。）');
});
