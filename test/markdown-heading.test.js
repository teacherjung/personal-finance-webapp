// `test/helpers/markdown-heading.js` 的正反例表。
// 為什麼要有：那支 helper 守的是「有人整理文件時，把安全契約那一節收進一個新的小節」。
// 它在 #578 被獨立審查者連打十一輪，每一輪修完都**沒有固定夾具守著**——退回去，
// 依賴它的那道文件考題照樣全綠（r11 Low⑤ 實測）。這張表就是那個缺口的補丁：
// 每一條修正都在這裡留下一個會紅的例子，**兩個方向都留**（該判成標題的、與不該判成標題的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingAt, fenceMap, codeSpanMap, inPipeTable, isThematicBreak, isDelimRow } from './helpers/markdown-heading.js';

/** @param {string} md @param {number} i */
const level = (md, i) => {
  const lines = md.split('\n');
  const fenced = fenceMap(lines);
  return headingAt(lines, i, fenced, codeSpanMap(lines, fenced));
};

test('⭐ 該判成標題的：ATX、Setext、行內 raw HTML', () => {
  const cases = [
    ['ATX H1', '# 標題', 0, 1],
    ['ATX H3', '### 標題', 0, 3],
    ['ATX 帶三格縮排', '   ## 標題', 0, 2],
    ['ATX 井號後行尾', '##', 0, 2],
    ['Setext H1', '一段話\n===', 1, 1],
    ['Setext H2', '一段話\n---', 1, 2],
    ['行內 raw HTML', '前文 <h4>以下整節已作廢</h4>', 0, 4],
    ['raw HTML 大寫帶屬性', '<H2 id="x">以下作廢</H2>', 0, 2],
    ['raw HTML 自閉合', '前文 <h3/>', 0, 3],
  ];
  for (const [name, md, i, want] of cases) {
    assert.equal(level(/** @type {string} */ (md), /** @type {number} */ (i)), want, `${name}：應該判成 H${want}`);
  }
});

test('⭐ 不該判成標題的：正常編修會用到的形狀（誤擋會卡住寫文件的人）', () => {
  const cases = [
    // #578 r9／r10：行內程式碼要認反引號長度
    ['雙反引號裡的標籤', '前文 ``<h4>只是程式碼</h4>``', 0],
    ['單反引號裡的標籤', '前文 `<h4>只是程式碼</h4>`', 0],
    // #578 r11 High②：跳脫的角括號
    ['反斜線跳脫的角括號', '前文 \\<h4>只是程式碼\\</h4>', 0],
    // #578 r11 High②：跨行的行內程式碼——含反引號的行一律不看 raw HTML
    ['跨行程式碼的中間那行', '`\n內文 <h4>只是程式碼</h4>\n`', 1],
    // #578 r9／r10：email 自動連結
    ['email 自動連結', '聯絡 <h4@example.com>', 0],
    // #578 r9／r10：相鄰兩條水平線
    ['相鄰水平線的第二條', '***\n---', 1],
    ['水平線（前面是空行）', '\n---', 1],
    // #578 r7／r8：表格與清單
    ['表格後面的水平線', '| a | b |\n|---|---|\n| x | y |\n---', 3],
    ['無前導 | 的表格後面的水平線', 'a | b\n--- | ---\nx | y\n---', 3],
    ['清單項後面的水平線', '- 一條規則\n---', 1],
    ['引用後面的水平線', '> 引言\n---', 1],
    ['標題後面的水平線', '## 小節\n---', 1],
    ['圍欄裡的 ATX', '```\n# 這是範例\n```', 1],
    ['圍欄裡的 raw HTML', '```html\n<h4>範例</h4>\n```', 1],
  ];
  for (const [name, md, i] of cases) {
    assert.equal(level(/** @type {string} */ (md), /** @type {number} */ (i)), 0, `${name}：不可以判成標題（誤擋正常編修）`);
  }
});

test('⭐ 分隔列上面要有表頭列，否則那不是表格（#578 r11 High③：少了這條會靜默放過一個真的 H2）', () => {
  // GitHub 官方 API 對這三行的輸出是 `<h2>--- | ---<br>以下整節停用 | x</h2>`——第三行是 Setext H2，不是水平線。
  const md = '--- | ---\n以下整節停用 | x\n---';
  assert.equal(level(md, 2), 2, '沒有表頭列的「分隔列」不算表格，後面那條 `---` 是 Setext H2');
  // 對照組：有表頭列時就是表格，後面那條是水平線
  assert.equal(level('詞 | 說明\n--- | ---\n以下整節停用 | x\n---', 3), 0, '有表頭列＝真的表格，後面那條是水平線');
});

test('⭐ 護欄本身：這張表真的在考 helper，不是空包彈', () => {
  // 每一個小工具都各自留一個正反例，避免整張表因為某個函式沒被走到而變成擺設。
  assert.equal(isThematicBreak('***'), true);
  assert.equal(isThematicBreak('**'), false, '只有兩個星號不是水平線');
  assert.equal(isThematicBreak('** *'), true, '三個星號中間夾空白仍是水平線（CommonMark）');
  assert.equal(isDelimRow('--- | ---'), true);
  assert.equal(isDelimRow('---'), false, '沒有 `|` 的 `---` 是水平線，不是分隔列');
  assert.equal(inPipeTable(['詞 | 說明', '--- | ---', 'x | y'], 2), true);
  assert.equal(inPipeTable(['--- | ---', 'x | y'], 1), false, '分隔列上面沒有表頭列＝不是表格');
  assert.deepEqual(fenceMap(['a', '```', 'b', '```', 'c']), [false, true, true, true, false]);
  assert.deepEqual(codeSpanMap(['`', 'x <h4>', '`'], [false, false, false]), [true, true, true],
    '跨行的行內程式碼要把中間那行也算進去');
  assert.deepEqual(codeSpanMap(['沒有反引號', '也沒有'], [false, false]), [false, false]);
});
