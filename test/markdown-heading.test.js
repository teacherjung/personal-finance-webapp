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
    ['縮排式程式碼裡的 ATX', '前文：\n\n    # 這是範例', 2],
    ['縮排區塊中間空行後仍是程式碼', '前文：\n\n    # 第一段\n\n    # 第二段', 4],
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
    ['清單項裡的井號', '- # 不是標題', 0],
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
  assert.deepEqual(hiddenMap(['```', 'a', '```js', 'b']), [true, true, true, true], '帶資訊字串的那行不是關門');
  // 縮排程式碼：要前面有空行才開啟
  assert.deepEqual(hiddenMap(['前文', '    續行'], []).slice(0, 2), [false, false], '沒有空行隔開＝那是續行不是程式碼');
  assert.deepEqual(hiddenMap(['前文', '', '    程式碼', '', '    還在裡面', '結束']),
    [false, false, true, true, true, false]);
  // 跨行 HTML 註解
  assert.deepEqual(hiddenMap(['<!--', '# x', '-->', 'y']), [true, true, true, false]);
  // 沒有任何隱藏區時要全 false（不然上面那些斷言可能只是「全都標成 true」）
  assert.deepEqual(hiddenMap(['# 標題', '一般行文']), [false, false]);
});
