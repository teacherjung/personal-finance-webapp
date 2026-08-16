// @ts-check
// **註解裡的路標，必須指得到東西**（#463 換來的閘；William 2026-08-16 裁示改成簡化版）。
//
// ## 這道閘在防什麼
//
// 程式裡有很多註解是**路標**，寫著「這件事為什麼危險，證據在本檔的『某某題』」。
// #463 三次踩到同一件事：**路標指到不存在的地方**——打錯字、題目改名沒跟著改、
// 甚至指到**別支檔案**的題名。三次都是人工核對漏掉的。
//
// 後果不是不好看：那些註解在解釋「這裡踩過什麼坑」，路標一斷，
// **下一個人看到警告卻找不到證據，就會以為警告過期而把它拿掉。**
//
// ## 判準（刻意極簡）
//
// 註解裡寫 `題名關鍵字` ＋ 全形引號夾住一段文字時，**那段文字必須在同一支檔案的別處出現**。
// 就這樣——**不解析程式碼**。
//
// ## 為什麼是這個判準，而不是「真的去數有哪些題」
//
// 前一版用語法分析器把每一題的標題抽出來建索引，**連續五輪審查都在同三個地方找到新洞**
// （標題抽取、壞記號、接線）：定義一題的寫法有很多種、測試工具還在長新的
// （Node 26 又多一種，正好是 CI 用的版本）、變數剛好叫 `test` 會被誤收…
// 而它出錯的方式是**靜靜數錯然後照樣說通過**——那正是它自己要防的病型。
//
// 回頭核對三次真實事故：**機械拓得到的兩次（打錯字、舊題名指到別支檔），這個判準都抓得到。**
//
// ⚠️ **誠實劃界——換掉的兩項能力**（刻意的取捨，不是漏掉）：
//   ・**抓不到「路標同時命中兩題」**：關鍵字太籠統時，讀的人仍不知道指哪一題。
//   ・**分不出「那段文字只出現在另一則註解裡」**：它只確認「找得到」，不確認「那是個題名」。
//   兩項在三次真實事故裡**一次都沒用上**；換來的是三個一直出問題的家族整個消失。
//   ⚠️ 哪天真的需要那兩項，請連同這段劃界一起改寫，並先想清楚「靜靜數錯」要怎麼防。
//
// ⚠️ 其餘劃界：
//   ・記號是**自願的**：不帶記號的指路（「見本檔某某題」）不在射程內——強制所有引號內文字
//     都要對得上會誤殺一堆正常敘述。
//   ・**只比對同一支檔案**：跨檔引用（「見 test/foo.test.js 的某題」）抓不到。
//   ・**不驗內容對不對**：只驗「指得到」，不驗「指對地方」。
//   ・只掃 `test/` 底下第一層的 `*.test.js`（跟 `test/entry-guard.test.js` 掃 `scripts/` 同作法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 路標記號的**單一真相**。
 * ⚠️ 刻意用變數組出正規式：本檔自己也在被掃，寫死字面就會自己命中自己。
 */
const MARKER = '題名關鍵字';
/**
 * 合法路標：記號**（可含冒號與水平空白）後緊接**左引號、關鍵字非空、右引號在**同一行**。
 * ⚠️ 三個細節都是踩出來的：允許純空白關鍵字時，一個空白剛好命中而放行；
 *    允許跨行時，兩段不相干的文字會被配成一個「合法」路標；
 *    而 `記號：「…」`（帶冒號）是很自然的寫法，不認它就等於整條路標靜靜消失。
 */
const REF_RE = () => new RegExp(`${MARKER}[:：]?[ \\t\\u3000]*[「]([^」\\n]+)[」]`, 'g');
/** 開了引號但沒有合法收尾＝**壞掉的路標**（見 `scanRefs` 的理由）。 */
const OPEN_RE = () => new RegExp(`${MARKER}[:：]?[ \\t\\u3000]*[「]`, 'g');

/**
 * 掃一組來源，回報「路標指不到東西」與「路標壞掉」。**純函式**。
 *
 * ⚠️ **壞掉的路標要單獨吵**：缺右引號、關鍵字是空白時，合法路標的正規式**完全比不到**
 *    ⇒ 那一行會被靜靜忽略。寫的人以為留了一條會被檢查的路標，實際上它對本閘不存在
 *    ——「什麼都沒做卻看起來有做」正是這道閘要防的病，它自己不能犯。
 *
 * ⚠️ **比對時要先把所有路標本身挖掉**：路標裡就含著關鍵字，不挖掉的話它永遠找得到自己，
 *    這道閘就等於什麼都沒檢查。
 *
 * ⚠️⚠️ **回傳 `scanned`（處理了幾份）不是裝飾**：這是「接線」這個洞的第三種變形
 *    （#470 r2／r3／r4 各一次）。前一版在真實來源裡摻誘餌，但**把真實來源整個拿掉、
 *    只留誘餌，兩條全樹題照樣 10/10 全綠**——誘餌只證明「掃描有在跑」，
 *    證明不了「掃的是那 55 支真的檔案」。⇒ 讓函式自己報數，呼叫端就斷言得到。
 *
 * @param {{ name: string, source: string }[]} sources
 * @returns {{ problems: string[], scanned: number }} `problems` 空陣列＝乾淨
 */
export function scanRefs(sources) {
  /** @type {string[]} */
  const problems = [];
  for (const { name, source } of sources) {
    const rest = source.replace(REF_RE(), '');   // 挖掉所有路標，剩下的才是「別處」
    const wellFormed = new Set([...source.matchAll(REF_RE())].map((m) => m.index));
    for (const m of source.matchAll(REF_RE())) {
      const keyword = m[1];
      // ⚠️ **純空白的關鍵字要當壞掉，不可以交給「找不找得到」判**（#470 r4）：真實檔案裡
      //    到處都是縮排，`rest` 幾乎一定含得到兩個空白 ⇒ 那條路標會**靜靜放行**。
      if (keyword.trim() === '') {
        problems.push(`  ${name}：路標的關鍵字是空白 ⇒ 這條指路等於沒寫`);
        continue;
      }
      if (!rest.includes(keyword)) problems.push(`  ${name}：路標「${keyword}」在同檔的別處找不到`);
    }
    for (const m of source.matchAll(OPEN_RE())) {
      if (wellFormed.has(m.index)) continue;
      problems.push(`  ${name}：「${source.slice(m.index, m.index + MARKER.length + 12).split('\n')[0]}」`
        + ' 是壞掉的路標（沒有合法收尾）⇒ 這條指路根本沒被檢查');
    }
  }
  return { problems, scanned: sources.length };
}

/** 正常文字檔本來就會有的三個控制字元：tab／換行／歸位。 */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

/**
 * 找出第一個不該出現的控制字元的位置；沒有就回 -1。
 *
 * ⚠️ 為什麼要管：一個看不見的位元組（把哨兵寫成真的 NUL）就能讓 git 把整支檔案判成二進位，
 *    **GitHub 上看不到 diff、審查者等於審不到**。#463 的護欄自己踩過，
 *    `test/reminder-thresholds.test.js` 也帶著一顆進了 main（`grep` 因此拒絕搜尋那支檔）。
 * ⚠️ 涵蓋 C0 ＋ DEL（U+007F）＋ C1（U+0080–U+009F）。U+00A0 是不斷行空格，**不算**。
 * ⚠️ **刻意不用正規式**：直接寫跳脫序列很容易把真的控制字元寫進檔案（我寫這一題時就犯過），
 *    改用字串組又會撞到 eslint 的 `no-control-regex`。逐字檢查碼位最直白。
 *
 * @param {string} text @returns {number}
 */
export function firstControl(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isControl = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (isControl && !ALLOWED_CONTROL.has(code)) return i;
  }
  return -1;
}

/**
 * 掃一組來源，回報控制字元。**純函式**。
 * ⚠️ 同樣回傳 `scanned`，理由見 `scanRefs`（接線那個洞的第三種變形）。
 * @param {{ name: string, source: string }[]} sources
 * @returns {{ problems: string[], scanned: number }}
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
  return { problems, scanned: sources.length };
}

/** 本檔掃的考題檔清單（`test/` 第一層的 `*.test.js`）。 */
const testFiles = () => readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort();
/** 讀成 `scanRefs`／`scanControl` 吃的形狀。 */
const realSources = () => testFiles().map((f) => ({ name: `test/${f}`, source: readFileSync(join(ROOT, 'test', f), 'utf8') }));

// ── 純函式的題（fixture 由本題自己控制）──────────────────────────────
test('⭐ 路標指不到東西要抓出來', () => {
  const src = `test('真的題名 A', () => {});\n// ${MARKER}「不存在的題名」`;
  assert.equal(scanRefs([{ name: 'f', source: src }]).problems.length, 1);
});

test('⭐ 指得到就放行（否則整批誤殺）', () => {
  const src = `test('很獨特的題名', () => {});\n// ${MARKER}「很獨特的題名」`;
  assert.deepEqual(scanRefs([{ name: 'f', source: src }]).problems, []);
});

test('⭐ 路標不可以自己滿足自己（比對前要先把路標挖掉）', () => {
  // ⚠️ 路標裡就含著關鍵字。不先挖掉的話，**任何**路標都會找到自己而永遠放行——
  //    那就是「什麼都沒檢查卻回報通過」。
  const src = `test('毫不相干', () => {});\n// ${MARKER}「只出現在路標裡的字」`;
  assert.equal(scanRefs([{ name: 'f', source: src }]).problems.length, 1,
    '路標找到的是它自己 ⇒ 這道閘等於沒有在檢查任何東西');
});

test('⭐ 壞掉的路標要吵，不可以靜靜忽略', () => {
  const one = (/** @type {string} */ s) => scanRefs([{ name: 'f', source: s }]).problems.length;
  assert.equal(one(`test('x', () => {});\n// ${MARKER}「沒有關引號`), 1, '缺右引號被靜靜忽略');
  assert.equal(one(`test('x', () => {});\n// ${MARKER}「」`), 1, '空關鍵字被靜靜忽略');
  // ⚠️ 來源刻意帶縮排（真實檔案到處都是）：靠「找不找得到」判的話，`rest` 一定含得到兩個空白
  //    ⇒ 那條路標會靜靜放行。這個 fixture 就是為那個假綠造的（#470 r4）。
  assert.equal(one(`function f() {\n  const a = 1;\n}\n// ${MARKER}「  」`), 1, '純空白關鍵字被靜靜忽略');
  // 反面（誤殺防線）：把記號當名詞提到是正常敘述，不是壞掉的路標。
  assert.deepEqual(scanRefs([{ name: 'f', source: `test('x', () => {});\n// 這個記號叫「${MARKER}」` }]).problems, [],
    '把記號當名詞提到就被判成壞掉＝誤殺');
});

test('⭐ 自然寫法要認得：記號後接冒號或空白', () => {
  // ⚠️ `記號：「…」` 是很自然的中文寫法。不認它的話那條路標會**整條消失**（靜靜不檢查）。
  for (const sep of ['', '：', ':', ' ', '： ']) {
    const ok = `test('獨特題名', () => {});\n// ${MARKER}${sep}「獨特題名」`;
    assert.deepEqual(scanRefs([{ name: 'f', source: ok }]).problems, [], `「記號${sep}「…」」被誤判`);
    const bad = `test('毫不相干', () => {});\n// ${MARKER}${sep}「找不到的字」`;
    assert.equal(scanRefs([{ name: 'f', source: bad }]).problems.length, 1,
      `「記號${sep}「…」」沒被解析到 ⇒ 這種寫法的路標全部是本閘的盲區`);
  }
});

test('⭐ 合法路標不可以跨行（否則兩段不相干的文字會被配成一條）', () => {
  // ⚠️ 斷言要看**問題的種類**，不能只看「有幾個問題」：允許跨行時它會變成「找不到」，
  //    不允許時是「壞掉的路標」——兩種都是 1 個問題，只數數量分不出來（我第一版就這樣，
  //    突變當場沒轉紅）。
  const src = `test('x', () => {});\n/* ${MARKER}「foo\n   bar」 */`;
  const got = scanRefs([{ name: 'f', source: src }]).problems;
  assert.equal(got.length, 1, '跨行的路標完全沒被回報');
  assert.match(got[0], /壞掉的路標/,
    '路標跨了行卻被當成合法（只是找不到）⇒ 區塊註解裡兩段不相干的文字會被配成一條');
});

test('⭐ 控制字元的偵測本身要有效（自己造誘餌）', () => {
  // ⚠️ 誘餌用 String.fromCharCode 組——直接打字面就會把控制字元寫進本檔（踩過）。
  assert.equal(firstControl('乾淨的文字'), -1, '正常文字被誤判＝整批誤殺');
  assert.equal(firstControl('a\tb\nc\r'), -1, 'tab／換行／歸位是正常文字檔就有的');
  assert.equal(firstControl(`a${String.fromCharCode(0)}`), 1, 'NUL 沒被抓到——那正是讓 git 判二進位的那一顆');
  assert.equal(firstControl(`a${String.fromCharCode(0x7f)}`), 1, 'U+007F（DEL）沒被抓到');
  assert.equal(firstControl(`a${String.fromCharCode(0x80)}`), 1, 'U+0080（C1 下界）沒被抓到');
  assert.equal(firstControl(`a${String.fromCharCode(0x9f)}`), 1, 'U+009F（C1 上界）沒被抓到');
  assert.equal(firstControl(`a${String.fromCharCode(0xa0)}`), -1, 'U+00A0 是不斷行空格，不可誤殺');
});

// ── 接線題：**真的讀檔案，而且證明得出來自己讀到了** ────────────────────
//
// ⚠️⚠️ 這一節的寫法是 #470 r2／r3 換來的：上一版把掃描抽成純函式、fixture 也齊全，
//    但**把全樹那一題裡的正式呼叫換成空陣列，20 題照樣全綠**——純函式有誘餌，
//    不等於接線有人守。⇒ 現在每一題都在真實來源裡**摻一顆自己造的壞蘋果**：
//    掃不到那顆＝接線斷了；除了那顆還掃到別的＝真的有問題。兩個方向同時釘住。

test('⭐ 全部考題檔：路標都要指得到（含接線誘餌）', () => {
  const sources = realSources();
  assert.ok(sources.length > 50, `只列到 ${sources.length} 支考題檔，列舉大概壞了`);

  const decoy = { name: '（接線誘餌）', source: `// ${MARKER}「這段字在這支合成檔裡絕對找不到」` };
  const { problems: withDecoy, scanned } = scanRefs([...sources, decoy]);
  // ⚠️ **兩道斷言缺一不可**（#470 r4）：誘餌只證明「掃描有在跑」，
  //    把真實來源整個拿掉、只留誘餌時它照樣通過。`scanned` 才證明「掃的是那些真的檔案」。
  assert.equal(scanned, sources.length + 1,
    `⛔ 掃描只處理了 ${scanned} 份，應該是 ${sources.length} 支真的考題檔＋1 顆誘餌 ⇒ **真實來源沒被送進去**。`);
  assert.equal(withDecoy.filter((p) => p.includes('（接線誘餌）')).length, 1,
    '⛔ 掃描沒抓到本題自己摻進去的壞蘋果 ⇒ **接線斷了**（正式的全樹檢查其實沒在跑）。');

  const real = withDecoy.filter((p) => !p.includes('（接線誘餌）'));
  assert.deepEqual(real, [],
    `有註解的路標指不到東西：\n${real.join('\n')}\n`
    + '⇒ 下一個人照著指路會找不到。請把關鍵字改成同檔真的存在的一段文字。\n'
    + '（AGENTS.md 鐵則 10：不寫會漂的序數，點名 file:line 或題名關鍵字。）');
});

test('⭐ 全部考題檔：不可以有控制字元（含接線誘餌）', () => {
  const sources = realSources();
  // ⚠️ 誘餌的控制字元**刻意放在 8 KiB 之後**：#463 那顆真的 NUL 在第 86,342 個位元組，
  //    「只掃前綴」的實作在真實事故上會完全漏掉。這顆誘餌就是為那個位置造的。
  const decoy = { name: '（接線誘餌）', source: `${'x'.repeat(9000)}${String.fromCharCode(0)}` };
  const { problems: withDecoy, scanned } = scanControl([...sources, decoy]);
  assert.equal(scanned, sources.length + 1,
    `⛔ 掃描只處理了 ${scanned} 份，應該是 ${sources.length} 支真的考題檔＋1 顆誘餌 ⇒ **真實來源沒被送進去**。`);
  assert.equal(withDecoy.filter((p) => p.includes('（接線誘餌）')).length, 1,
    '⛔ 掃描沒抓到 8 KiB 之後的控制字元 ⇒ 接線斷了，或實作只掃前綴。');

  const real = withDecoy.filter((p) => !p.includes('（接線誘餌）'));
  assert.deepEqual(real, [],
    `這些考題檔含控制字元：\n${real.join('\n')}\n`
    + '⇒ git 會把它們當二進位，GitHub 上看不到 diff、審查者等於審不到。\n'
    + '（要表示「這裡有個特殊位置」請用一串正常 ASCII，不要用控制字元。）');
});

test('全樹真的有路標可掃（否則上面那題是在空轉）', () => {
  const total = realSources().reduce((n, { source }) => n + [...source.matchAll(REF_RE())].length, 0);
  assert.ok(total > 0, '全樹一個路標都沒解析到——正規式大概壞了');
});
