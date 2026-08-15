// @ts-check
// **註解指到的題，必須真的存在**（#463 r2–r5 換來的閘）。
//
// ## 為什麼要做成閘，而不是「下次小心」
//
// #463 五輪審查，**有三輪抓到的是同一族**：我寫的註解指向一個不存在的題。
//   ・r3：用「上一題／下一題」這種會漂的序數，而且**其中一處已經指錯**
//        （那個位置的上一題其實是外連掃描題）。
//   ・r4：改成題名之後，兩個題名關鍵字**各自命中 0 題**（題名寫 `GIT_*`，實際是 `GIT_DIR`）。
//   ・r5：又有三個 JSDoc 仍用舊題名指路，其中一個甚至指到**別支檔案**的題名。
//
// 三次都是人工核對漏掉的。AGENTS.md 鐵則 10 早就寫著「不寫死會漂的序數——點名 `file:line`
// 或題名關鍵字」，但**規則寫著沒有用**：本專案已經有證據（#374／#375／#376 連三支漏填同一欄）。
// ⇒ 收成機械閘：規則不必多一條要記住的，只要多一個記號。
//
// ## 判準是**宣告**，不是推導
//
// 只檢查帶記號的引用（記號＝下面 `MARKER` 的字串）。不去猜「這個引號裡的字串是不是題名」
// ——那要列舉寫法，而列舉補不完（本專案認過的病型）。
//
// ⚠️ **誠實劃界**（別把本檔讀成比它更強的東西）：
//   ・**擋得住**：帶記號的引用指到 0 題或 ≥2 題。
//   ・**擋不住**：不帶記號的引用（例如直接寫「見本檔『某某題』」）——那一族本閘看不見。
//     記號是自願的，這是刻意的取捨：強制所有引號內字串都要對得上題名會誤殺一堆正常文字。
//   ・**擋不住**：跨檔引用（「見 `test/foo.test.js` 的某題」）——本閘只比對**同一支檔案**。
//   ・**擋不住**：註解說的內容對不對。它只驗「指路指得到東西」，不驗「指對地方」。
//   ・只掃 `test/` 底下第一層的 `*.test.js`（跟 `test/entry-guard.test.js` 掃 `scripts/` 同一個作法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 引用記號的**單一真相**。
 *
 * ⚠️ 刻意用變數組出正規式，不在本檔任何地方寫出「記號＋全形左引號」的完整字面——
 *    否則本檔自己的說明文字與 fixture 會被自己掃到、變成「指到 0 題」的假紅。
 */
const MARKER = '題名關鍵字';

/** 題名字面：`test('…')`／`test.skip("…")`…，允許跳脫字元。 */
const TITLE_RE = () => /\btest(?:\.\w+)?\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
/** 帶記號的引用：記號後面緊跟一對全形引號。 */
const REF_RE = () => new RegExp(`${MARKER}[「]([^」]+)[」]`, 'g');

/**
 * 找出「指到 0 題或 ≥2 題」的引用。
 * @param {string} source 一支考題檔的原始碼
 * @returns {{ keyword: string, hits: number }[]} 空陣列＝這一支沒有問題
 */
export function badTestRefs(source) {
  const titles = [...source.matchAll(TITLE_RE())].map((m) => m[2]);
  /** @type {{ keyword: string, hits: number }[]} */
  const bad = [];
  for (const m of source.matchAll(REF_RE())) {
    const keyword = m[1];
    const hits = titles.filter((t) => t.includes(keyword)).length;
    if (hits !== 1) bad.push({ keyword, hits });
  }
  return bad;
}

// ── 純函式的題（用考題自己控制的 fixture，不押正式程式的寫法細節）────────────
test('⭐ 指到 0 題要抓出來（r4 的病型：題名關鍵字寫錯字）', () => {
  const src = `test('真的題名 A', () => {});\n// ${MARKER}「不存在的題名」\n`;
  assert.deepEqual(badTestRefs(src), [{ keyword: '不存在的題名', hits: 0 }]);
});

test('⭐ 指到兩題也要抓出來（關鍵字不夠獨特＝下一個人找不到你指哪一題）', () => {
  const src = `test('清單 A 的題', () => {});\ntest('清單 B 的題', () => {});\n// ${MARKER}「清單」\n`;
  assert.deepEqual(badTestRefs(src), [{ keyword: '清單', hits: 2 }]);
});

test('恰好命中一題＝放行（否則整批誤殺）', () => {
  const src = `test('⭐ 很獨特的題名', () => {});\n// ${MARKER}「很獨特的題名」\n`;
  assert.deepEqual(badTestRefs(src), []);
});

test('沒有記號的引用不在射程內（誠實劃界，不是漏抓）', () => {
  const src = `test('題名 A', () => {});\n// 行為題見本檔「完全不存在的東西」\n`;
  assert.deepEqual(badTestRefs(src), [],
    '沒帶記號的引用被抓了 ⇒ 本檔宣告的射程與實作不一致，會誤殺一堆正常文字');
});

test('題名裡有跳脫的引號時仍要解析得出來（不然那一題等於消失）', () => {
  const src = `test('他說\\'好\\'的那一題', () => {});\n// ${MARKER}「他說」\n`;
  assert.deepEqual(badTestRefs(src), [],
    '帶跳脫引號的題名沒被解析出來 ⇒ 指向它的引用會被誤判成「指到 0 題」');
});

// ── 接線題：真的掃全樹（純函式對了不代表有人在用它）──────────────────────
test('⭐ 全部考題檔：帶記號的引用都要恰好命中一題', () => {
  // ⚠️ 用 readdirSync 而不是 git ls-files：`test/` 是固定目錄，掃不到 worktree 副本
  //    （`test/entry-guard.test.js` 掃 `scripts/` 是同一個作法），也就不必再開一個 git 呼叫點。
  const files = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort();
  assert.ok(files.length > 50, `只列到 ${files.length} 支考題檔，列舉大概壞了`);

  let refCount = 0;
  /** @type {string[]} */
  const problems = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, 'test', f), 'utf8');
    refCount += [...src.matchAll(REF_RE())].length;
    for (const { keyword, hits } of badTestRefs(src)) {
      problems.push(`  test/${f}：「${keyword}」在同檔命中 ${hits} 題（要恰好 1）`);
    }
  }
  // 反面自檢：正規式壞掉時 refCount 會是 0，而上面那圈當然「零問題」＝假綠。
  assert.ok(refCount >= 9,
    `全樹只解析到 ${refCount} 個帶記號的引用——正規式大概壞了（本閘會在什麼都沒掃的情況下通過）`);
  assert.deepEqual(problems, [],
    `有註解指到不存在（或不只一個）的題：\n${problems.join('\n')}\n`
    + '⇒ 下一個人照著指路會找不到東西。請把關鍵字改成同檔某一題題名的**獨特片段**。\n'
    + '（AGENTS.md 鐵則 10：不寫會漂的序數，點名 file:line 或題名關鍵字。）');
});
