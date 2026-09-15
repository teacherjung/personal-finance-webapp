// 守「機器讀說明與留言，讀哪一段」那一支（r2 Medium③ 起共用；r5 之後換成「只讀開頭那一段」）。
// 四個消費端（待裁清單、協作欄位閘、結論聯集閘的「像不像結論」提醒、範本小標）都用它。
// 守得到的：從第一行讀到第一個特殊行為止；特殊行九種各有正反兩面的題；停在哪一行回報得出來；
//   r3〜r6 審查者給的反例（交錯的註解與圍欄、圍欄開頭行帶註解記號、單行三反引號、引用後直接接標題、行內 HTML 標籤裡的反引號、
//   表格分隔列以下被丟掉的格子）都停在讀不到的地方之前。
// ⚠️ 守不到的：特殊行清單以外、平台將來新增的語法；行中開始的連結、參照、註腳的隱藏成分、表格標題列跨格的反引號（最後幾題照實釘成「目前讀得到」）。清單寬了＝早停（讀得比畫面少，消費端擋下並指出行號）；清單漏了一種開頭＝會讀到容器裡的字——所以清單逐項在這裡有題。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { leadingLines, leadingText, stopNote, isSpecial } = require('../tools/markdown-effective.js');

test('讀到第一個特殊行為止：之前的行照原文、停的行號回報得出來', () => {
  assert.deepEqual(leadingLines('a\n\nb\n> 引用\nc'), { lines: ['a', '', 'b'], stopAt: 4 });
  assert.deepEqual(leadingLines('a\nb'), { lines: ['a', 'b'], stopAt: 0 }, '沒有特殊行＝整份');
  assert.equal(leadingText('前\n```\n中\n```\n後'), '前', '圍欄開頭那一行就停，圍欄關掉之後的也不讀');
  assert.equal(leadingText(''), '');
  assert.equal(leadingText(null), '');
  assert.match(stopNote('a\n<!-- x -->'), /第 2 行/u);
  assert.equal(stopNote('a\nb'), '', '沒停就不說');
});

test('特殊行九種（含清單記號後面的開頭），各有對照組', () => {
  const special = [
    ['> 引用', '①引用'], ['   > 縮三格的引用', '①'],
    ['```', '②圍欄'], ['~~~md', '②波浪號'], ['```node --test```', '②同一行三反引號也先停（r5 反例：寧可早停）'],
    ['[x]: https://a', '③連結定義'], ['[^1]: 註腳', '③註腳定義'],
    ['$$', '④數學區塊'],
    ['    縮排四格', '⑤'], ['\t定位字元', '⑤'],
    ['文字 <!-- 註解 -->', '⑥註解'], ['<details>', '⑥標籤'], ['x </b>', '⑥收尾標籤'], ['<https://a>', '⑥自動連結'], ['<?x', '⑥'],
    ['看圖 ![a](b.png)', '⑦圖片'],
    ['用 ` 包住', '⑧配不完'], ['``a` 長度不同', '⑧'], ['\\`<b>`', '⑧反斜線緊貼的反引號'],
    ['審查備註 <!-- 用 ` 包住 -->：x `a`', '⑥⑧ r5 反例：註解裡的反引號'],
    // 清單記號後面的開頭也算（清單項目裡可以放圍欄、引用、定義、數學、縮排程式碼）
    ['- ```', '②清單裡的圍欄'], ['1. ~~~', '②有序清單裡的波浪號圍欄'], ['1) ```', '②'], ['* > 引用', '①清單裡的引用'], ['- - > 兩層', '①兩層清單'],
    ['| --- | --- |', '⑨表格分隔列'], ['--- | ---', '⑨沒有外側豎線'], [':-: | :--', '⑨對齊記號'], ['- |---|', '⑨清單記號後面長得像分隔列（平台上不一定成表格，寧可早停）'], ['1. | --- |', '⑨同上、有序清單（數字不在分隔列的字元裡，要先剝清單記號）'],
    [':---', '⑨r7 單欄表格的分隔列沒有豎線（靠左）'], ['---:', '⑨靠右'], [':-:', '⑨置中'], ['  :---  ', '⑨前後空白'], ['- :---', '⑨清單裡的單欄分隔列'],
    ['- [x]: /u', '③清單裡的連結定義'], ['[ ]: /u', '③核取框後面接冒號（平台上其實不是定義，寧可早停）'], ['+ $$', '④'], ['-     縮排程式碼', '⑤記號後五個空白'], ['-\t定位字元', '⑤記號後 tab'],
  ];
  for (const [line, why] of special) assert.equal(isSpecial(line), true, `${why}：${JSON.stringify(line)}`);
  const plain = [
    ['- **實作者**：Alpha', '清單'], ['## 標題', '標題'], ['| a | b |', '表格'], ['---', '分隔線'],
    ['   縮三格', '三格以內不是縮排程式碼'], ['a < b', '「<」後面是空白'], ['<識別值>', '「<」後面不是英文字母'],
    ['`<details>` 在行內程式碼裡', '⑥只看行內程式碼以外'], ['`![x]`', '⑦只看行內程式碼以外'],
    ['``a ` <b>`` 後', '長度不同的反引號在程式碼裡面'], ['`a``<b>`', '等長才配：中間兩個反引號屬於程式碼'],
    ['x `y` z', '成對的行內程式碼'], ['提到 `<!--` 這個記號', '行內程式碼裡提到註解記號'],
    ['- [ ] 待辦', '核取清單'], ['- [x] 完成', '核取清單'], ['* * *', '分隔線不是三層清單'], ['*強調*', '強調不是清單記號'], ['2026. 年', '有序清單，後面是普通字'],
    ['    ', '只有空白＝空行'], ['\t', '只有 tab＝空行'],
    ['a || b', '一般行裡的豎線（表格要有分隔列）'], ['`printf x | cat`', '行內程式碼裡的豎線'], ['| :x: |', '有豎線但有別的字＝不是分隔列'], ['| : |', '只有豎線與冒號、沒有連字號＝不是分隔列'], [':', '只有冒號'], ['- - -', '分隔線沒有豎線'],
  ];
  for (const [line, why] of plain) assert.equal(isSpecial(line), false, `${why}：${JSON.stringify(line)}`);
});

test('審查者給過的反例，都在第一行就停（兩種圍欄符號）', () => {
  for (const f of ['```', '~~~']) {
    assert.equal(leadingLines([`${f}md <!--`, 'code', f, `${f}md`, '-->', '欄位', f].join('\n')).stopAt, 1, `${f}：r4 範例被搬出來那型`);
    assert.equal(leadingLines([`${f}md <!--`, 'code', f, '🤖 壞標頭'].join('\n')).stopAt, 1, `${f}：r4 可見行被吞掉那型`);
    assert.equal(leadingLines([`${f}md`, '<!--', f, '-->', f, '欄位', f].join('\n')).stopAt, 1, `${f}：r3 交錯型`);
  }
  assert.equal(leadingLines('```node --test```\n\n🤖 壞標頭').stopAt, 1, 'r5：單行三反引號');
  assert.equal(leadingLines('> 上輪建議\n## 本輪結論\n🤖 x').stopAt, 1, 'r5：引用後直接接標題');
  assert.equal(leadingLines(['<span title="`"><!-- `</span>', '欄位', '-->'].join('\n')).stopAt, 1, 'r5 待辦：行內 HTML 標籤裡的反引號');
  assert.equal(leadingLines('<!--\n> 舊說明\n-->\n🤖 壞標頭').stopAt, 1, 'r5 待辦：HTML 區塊');
  assert.equal(leadingLines('a ` 多一個\n`<!-- x -->` b').stopAt, 1, '同一段前一行配不完：那一行就停，下一行不會被單行配對騙');
  // r6：分隔列以下的列，行內程式碼裡的豎線也照切、多出來的格子被丟掉（網址畫面上不存在）——停在分隔列
  const table = ['原話', '', '| 驗證命令 | 原題 |', '| --- | --- |', '| `printf x | cat` | https://x/pull/7#issuecomment-q1 |'].join('\n');
  assert.deepEqual(leadingLines(table), { lines: ['原話', '', '| 驗證命令 | 原題 |'], stopAt: 4 }, '標題列格數跟分隔列一樣、看得見；分隔列以下不讀');
  for (const sep of [':---', '---:', ':---:']) {
    const one = ['原話', '', '| 操作紀錄 |', sep, '| `printf x | cat`；原題：https://x/pull/7#issuecomment-q1 |'].join('\n');
    assert.equal(leadingLines(one).stopAt, 4, `r7：單欄表格、沒有豎線的分隔列 ${sep} 也要停`);
  }
  assert.equal(leadingLines(['原話', '| 標題 |', '---', '| x |'].join('\n')).stopAt, 0, '對照組：只有連字號的 --- 是標題底線，不成表格、不算分隔列');
});

test('射程外照實釘住：表格標題列裡跨格的反引號，標題列目前讀得到（r7 待辦；原專案 24 個候選沒有實例）', () => {
  const md = ['原話', '| `printf x | <!-- 網址 -->` | 備註 |', '| --- | --- | --- |'].join('\n');
  assert.equal(leadingLines(md).stopAt, 3, '讀到分隔列才停，標題列那一行讀得到——哪天處理這一型，這一題會紅，檔頭的誠實劃界要一起改');
});

test('射程外照實釘住：行中開始的連結標題或網址帶反引號、跨行參照標籤、跨行註腳標籤，目前讀得到（r8 待辦；語料沒有實例）', () => {
  const fields = ['實作者：Alpha', '獨立審查者：Beta'];
  assert.equal(leadingLines(['說明：[文件](https://example.com "版本 `") <!-- `', ...fields, '-->'].join('\n')).stopAt, 0, '連結標題裡的反引號跟註解裡的配成一對，註解開頭被遮掉');
  assert.equal(leadingLines(['說明：[文件](https://example.com/`) <!-- `', ...fields, '-->'].join('\n')).stopAt, 0, '網址裡的反引號同型');
  assert.equal(leadingLines(['說明：[文件][', ...fields, ']', '', '[實作者：Alpha 獨立審查者：Beta]: https://example.com'].join('\n')).stopAt, 6, '跨行參照標籤：讀到定義那一行才停，前面的標籤行讀得到');
  assert.equal(leadingLines(['說明[^', ...fields, ']'].join('\n')).stopAt, 0, 'GitHub 跨行註腳標籤');
  // 哪天補進特殊行清單，這一題會紅，檔頭的誠實劃界要一起改
});

test('射程外照實釘住：從行中間開始、跨行的連結標題目前讀得到（r6 待辦；語料沒有實例）', () => {
  const md = ['說明：[操作說明](https://example.com "操作說明', '- **實作者**：Alpha', '")'].join('\n');
  assert.equal(leadingLines(md).stopAt, 0, '這一型沒有進特殊行清單——哪天補進去，這一題會紅，檔頭的誠實劃界要一起改');
});
