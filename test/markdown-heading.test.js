// `test/helpers/markdown-heading.js` 的正反例表。
// 為什麼要有：那支 helper 守的是「有人整理文件時，把安全契約那一節收進一個新的小節」。
// 它在 #578 被獨立審查者反覆打穿，而每一輪修完都**沒有固定夾具守著**——把修正退回去，
// 依賴它的那道文件考題照樣全綠（#578 r11 Low⑤ 實測）。這張表就是那個缺口的補丁：
// 每一條判準都在這裡留下會紅的例子，**兩個方向都留**（該判成標題的、與不該判成標題的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingAt, hiddenMap } from './helpers/markdown-heading.js';

/** @param {string} md @param {number} i */
const level = (md, i) => {
  const lines = md.split('\n');
  return headingAt(lines, i, hiddenMap(lines));
};

test('⭐ 該判成標題的：ATX（這是 William 2026-09-07 裁示留下的唯一一種）', () => {
  const cases = [
    ['H1', '# 標題', 0, 1],
    ['H3', '### 標題', 0, 3],
    ['帶三格縮排', '   ## 標題', 0, 2],
    ['井號後直接行尾', '##', 0, 2],
    ['H6', '###### 標題', 0, 6],
    ['井號後接 tab', '##\t標題', 0, 2],
  ];
  for (const [name, md, i, want] of cases) {
    assert.equal(level(/** @type {string} */ (md), /** @type {number} */ (i)), want, `${name}：應該判成 H${want}`);
  }
});

test('⭐ 不該判成標題的：正常編修會用到的形狀（誤擋會卡住寫文件的人）', () => {
  const cases = [
    ['圍欄裡的 ATX', '```\n# 這是範例\n```', 1],
    ['圍欄裡的 ATX（波浪號）', '~~~\n# 這是範例\n~~~', 1],
    // #578 r12：外層四反引號包內層三反引號，是「展示一段 fence」的正常寫法
    ['巢狀圍欄裡的 ATX', '````\n```md\n# 這是範例\n```\n````', 2],
    // #578 r12：四格縮排的程式碼區塊
    ['四格縮排的井號（ATX 最多三格，本來就不是標題）', '前文：\n\n    # 這是範例', 2],
    // AGENTS.md:356 的真實內文，就坐在鏈最嚴格的那一段裡；`(?:[ \t]|$)` 是唯一擋著它的東西
    ['井號緊接數字（AGENTS.md 的真內文）', '  #348（2026-08-02 合併）裁決「規則收下、工具不收」', 0],
    // #578 r12：HTML 註解裡的內容不顯示
    ['跨行 HTML 註解裡的 ATX', '<!--\n# 這是註解裡的範例\n-->', 1],
    // 以下三種是 William 2026-09-07 裁示**明講擋不到**的（不是漏掉）
    ['Setext H2（裁示：擋不到）', '一段話\n---', 1],
    ['Setext H1（裁示：擋不到）', '一段話\n===', 1],
    ['raw HTML 標題（裁示：擋不到）', '前文 <h4>以下整節已作廢</h4>', 0],
    // 一般行文
    ['井號不在行首', '前文 # 不是標題', 0],
    ['井號後面沒有空白', '#標題', 0],
    ['縮排四格以上的井號（是程式碼）', '\n    # 縮排', 1],
    // ⚠️ 這一條**不是**「GitHub 不當它是標題」——`- # x` 其實會渲染成 `<li><h1>x</h1></li>`（#578 r13 High②）。
    //    它之所以在這張表裡，是因為**容器裡的標題只能重新分配那個容器內部的內容**，而受保護的那一節
    //    不在任何容器裡，所以它換不走本節的爸爸。這是結構上的射程，已列進「擋不到」清單。
    ['清單項裡的井號（容器內的標題，換不走本節的爸爸）', '- # 這其實會渲染成標題', 0],
    ['七個井號', '####### 太多了', 0],
  ];
  for (const [name, md, i] of cases) {
    assert.equal(level(/** @type {string} */ (md), /** @type {number} */ (i)), 0, `${name}：不可以判成標題`);
  }
});

test('⭐ 護欄本身：hiddenMap 真的在標記，不是全 false 的空包彈', () => {
  assert.deepEqual(hiddenMap(['a', '```', 'b', '```', 'c']), [false, true, true, true, false]);
  // 內層較短的圍欄不能關掉外層較長的（#578 r12）
  assert.deepEqual(hiddenMap(['````', '```', '````', 'x']), [true, true, true, false]);
  // 關門行後面不可以有東西（資訊字串只准在開門行）
  // 帶資訊字串的那行不是關門（資訊字串只准出現在開門行）——所以要往後找到真正的關門
  assert.deepEqual(hiddenMap(['```', 'a', '```js', 'b', '```']), [true, true, true, true, true]);
  // 縮排式程式碼**刻意不處理**：ATX 最多三格前導空白，四格以上本來就不是 ATX（處理它是 no-op）
  assert.deepEqual(hiddenMap(['前文', '', '    程式碼', '結束']), [false, false, false, false]);
  assert.equal(headingAt(['前文', '', '    #### 縮排'], 2, hiddenMap(['前文', '', '    #### 縮排'])), 0,
    '四格縮排的井號不是 ATX——不靠隱藏區，靠 ATX 自己的三格上限');
  // 跨行 HTML 註解：開門那一行不標（`<!--` 前面的內容照樣渲染）
  assert.deepEqual(hiddenMap(['<!--', '# x', '-->', 'y']), [false, true, true, false]);
  // ⚠️ **落單的開門記號不吃掉後面的內容**：舊寫法一遇到 ``` 就翻轉狀態，
  //    於是多一個落單的圍欄記號就讓後面所有標題偵測整片靜音＝「靜靜通過」型的失敗。
  assert.deepEqual(hiddenMap(['```', '前文', '# 標題']), [false, false, false], '落單圍欄不算隱藏區');
  assert.deepEqual(hiddenMap(['<!--', '前文', '# 標題']), [false, false, false], '沒關門的註解不算隱藏區');
  // 行內程式碼裡的 `<!--` 只是文字，不可以開門（#578 r13 High③）
  assert.deepEqual(hiddenMap(['維護語法：`<!--`', '# 標題', '-->']), [false, false, false],
    '行內程式碼裡的 `<!--` 不算開門，後面的真標題不可以被藏起來');
  // 反引號圍欄的資訊字串不得含反引號（GFM），那不是開門
  assert.deepEqual(hiddenMap(['```lang`bad', '# 標題', '```']), [false, false, false],
    '資訊字串含反引號＝不是圍欄開門，後面的真標題不可以被藏起來');
  // 相鄰的兩段跨行註解要各自配對
  assert.deepEqual(hiddenMap(['<!--', 'a', '-->', '<!--', '# x', '-->', 'y']),
    [false, true, true, false, true, true, false], '相鄰註解各自配對，不可以串成一大塊');
  // 沒有任何隱藏區時要全 false（不然上面那些斷言可能只是「全都標成 true」）
  assert.deepEqual(hiddenMap(['# 標題', '一般行文']), [false, false]);
});
