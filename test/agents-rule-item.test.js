// `test/helpers/agents-rule-item.js` 的正反例表。
// 為什麼要有：那支 helper 是「承重句在**它自己那一條**裡」這句話的全部依據。
// 它的第一版（一張「下一條長什麼樣」的正規式）在 #585 r2 被獨立審查者用**四種合法寫法**打穿：
// `13.` 前一格空白、點號後接 tab、三格縮排、`13)`——四種都認不得，於是隔壁那一條的文字
// 被借去充數。修完如果沒有固定夾具守著，退回去也不會有考題叫（#578 r11 Low⑤ 的病型）。
// 這張表就是那個缺口的補丁。⚠️ **不是每一列都曾經打穿過它**：包含 r2 那四種真的漏認的變體、
// **正常對照**（零縮排的 `13.` 第一版本來就認得），以及後來加的正常編修與內容欄夾具。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleItemRange } from './helpers/agents-rule-item.js';

/** 第 12 條 ＋ 一行「下一條」；回傳承重句有沒有被算進第 12 條裡。 @param {string} nextLine */
const bearingLeaksInto12 = (nextLine) => {
  const lines = [
    '## 鐵則（違反會壞事）',
    '11. **前一條**',
    '12. **必須懂的概念要在網頁上就地白話解釋**',
    '',
    '    機制與樣式可實驗，解釋本身不可省。',
    nextLine,
    '',
    '    歷史文字：文案 Claude 起草、William 審改。',
    '',
    '## UI 現行慣例',
  ];
  const r = ruleItemRange(lines, 12);
  assert.equal(r.hits, 1, '夾具自己壞了：第 12 條要剛好找到一次');
  return lines.slice(r.start, r.end).join('\n').includes('文案 Claude 起草、William 審改');
};

test('⭐ #585 r2 打穿第一版的四種寫法：都必須結束第 12 條（承重句不可以被借去充數）', () => {
  for (const [name, nextLine] of [
    ['零縮排 `13.`', '13. **文案沿革**'],
    ['前面一格空白（r2 實測那一刀）', ' 13. **文案沿革**'],
    ['前面三格空白', '   13. **文案沿革**'],
    ['點號後接 tab', '13.\t**文案沿革**'],
    ['右括號記號 `13)`', '13) **文案沿革**'],
    // 順帶：不是清單項的東西一樣要結束它（邊界判準只看縮排，不看記號長相）
    ['零縮排的標題', '## 另一節'],
    ['零縮排的散文', '以下第 12 條僅為歷史紀錄。'],
    ['項目符號清單', '- 另一串清單'],
  ]) {
    assert.equal(bearingLeaksInto12(/** @type {string} */ (nextLine)), false,
      `${name}：這一行必須結束第 12 條——認不得它，隔壁那一條的承重句就會被算進來（那正是 r2 的假綠）`);
  }
});

test('⭐ 正常編修不可以被切掉：縮排四格以上的內容仍屬於第 12 條', () => {
  const lines = [
    '12. **必須懂的概念要在網頁上就地白話解釋**',
    '',
    '    機制與樣式可實驗，解釋本身不可省；文案 Claude 起草、William 審改。',
    '',
    '    1. 四格縮排的子清單也還在條內',
    '        - 更深的縮排同上',
    '',
    '    最後一段續行。',
    '## 下一節',
  ];
  const r = ruleItemRange(lines, 12);
  const block = lines.slice(r.start, r.end).join('\n');
  assert.equal(r.col, 4, '`12. ` 的內容欄是第 4 欄');
  assert.ok(block.includes('文案 Claude 起草、William 審改'), '承重句被切掉了＝假紅');
  assert.ok(block.includes('四格縮排的子清單也還在條內'), '子清單被當成下一條＝假紅');
  assert.ok(block.includes('最後一段續行'), '空行不可以結束清單項');
  assert.ok(!block.includes('下一節'), '零縮排的標題必須結束清單項');
});

test('⭐ 內容欄跟著記號寬度走（不是寫死四格）——用**切界結果**證明，不是只看它自報的 col', () => {
  // ⚠️ 這一題原本只斷言 `.col` 的自報值。#585 r3 Low 實測：把 helper 的 `indent < col` 改成
  //    `indent < 4`（寫死四格），整張表照樣全綠——因為沒有任何一顆夾具的答案會因此改變。
  //    ⇒ 下面每一顆都讓「用 col 切」與「寫死 4 切」給出**不同**答案，並斷言邊界兩側的內容。
  /** @param {string[]} lines @param {number} n */
  const inside = (lines, n) => {
    const r = ruleItemRange(lines, n);
    assert.equal(r.hits, 1, '夾具自己壞了：目標項要剛好找到一次');
    return { r, text: lines.slice(r.start, r.end).join('\n') };
  };

  // 內容欄 5：縮排四格的行必須在**外**（寫死四格的話會被留在裡面）
  const col5 = [
    '123. **三位數編號**',
    '',
    '     這一行縮排五格＝在條內',
    '    這一行縮排四格＝已經在條外',
    '## 尾',
  ];
  const a = inside(col5, 123);
  assert.equal(a.r.col, 5, '`123. ` 的內容欄是第 5 欄');
  assert.ok(a.text.includes('縮排五格＝在條內'), '五格的續行被切掉了＝假紅');
  assert.ok(!a.text.includes('縮排四格＝已經在條外'),
    '縮排四格的行被留在條內＝切界其實寫死了四格、沒有用 col（#585 r3 Low）');
  assert.equal(a.r.end, 3, '邊界應該落在那一行「縮排四格」上');

  // 內容欄 3：縮排三格的行必須在**內**（寫死四格的話會被切掉）
  const col3 = [
    '7.      **記號後空白多於四格＝內容欄只算一格**',
    '',
    '   這一行縮排三格＝仍在條內',
    '  這一行縮排兩格＝已經在條外',
    '## 尾',
  ];
  const b = inside(col3, 7);
  assert.equal(b.r.col, 3);
  assert.ok(b.text.includes('縮排三格＝仍在條內'),
    '縮排三格的行被切掉＝切界寫死了四格、沒有用 col（#585 r3 Low）');
  assert.ok(!b.text.includes('縮排兩格＝已經在條外'), '縮排兩格的行留在條內＝邊界沒收好');

  // 目標項自己縮排 1〜3 格（CommonMark 允許）：內容欄跟著往右移
  const shifted = [
    '## 鐵則',
    ' 12. **整條多縮排一格（r2 列的假紅，現在要是正例）**',
    '',
    '     這一行縮排五格＝在條內',
    '    這一行縮排四格＝已經在條外',
    '## 尾',
  ];
  const c = inside(shifted, 12);
  assert.equal(c.r.start, 1, '縮排一格的 `12.` 要定位得到');
  assert.equal(c.r.col, 5, '記號前縮排一格＝內容欄跟著變成第 5 欄');
  assert.ok(c.text.includes('縮排五格＝在條內'));
  assert.ok(!c.text.includes('縮排四格＝已經在條外'), '記號前的縮排沒有被算進內容欄');
});

test('⭐ 空行的定義照 CommonMark：只有空格與 tab 算空行（全形空白／NBSP 是內容，會結束這一條）', () => {
  // ⚠️ #585 r3 Medium：原本用 `trim() === ''`，它把只含全形空白（U+3000）或 NBSP 的行也當空行。
  //    那種行在 CommonMark 眼裡**有內容**、縮排 0 ⇒ 它就是邊界；略過它就會把條外的字算進條內。
  //    獨立審查者實測：插一行全形空白，再把承重句放在它後面的四格縮排行，考題全綠，
  //    而 GitHub 渲染出來那句話根本不在第 12 條的 `<li>` 裡。
  /** @param {string} spacer */
  const stillInside = (spacer) => {
    const lines = ['12. **標題**', '', spacer, '', '    承重句在這裡。', '## 尾'];
    const r = ruleItemRange(lines, 12);
    return lines.slice(r.start, r.end).join('\n').includes('承重句在這裡');
  };
  assert.equal(stillInside(''), true, '真的空行不可以結束清單項');
  assert.equal(stillInside('   '), true, '只有空格的行是空行（CommonMark），不可以結束清單項');
  assert.equal(stillInside('\t'), true, '只有 tab 的行是空行（CommonMark），不可以結束清單項');
  assert.equal(stillInside(' \t '), true,
    '空格與 tab **混用**的行仍是空行——寫成 `/^(?: *|\\t*)$/` 這種「要嘛全空格要嘛全 tab」'
    + '就會漏掉它（#585 r4 Low）');
  assert.equal(stillInside('　'), false,
    '只含全形空白的行**不是**空行——它是縮排 0 的內容，必須結束這一條（#585 r3 Medium 那一刀）');
  assert.equal(stillInside('\u00a0'), false,
    '只含 NBSP 的行**不是**空行——同上（r3 實測與全形空白同樣落在清單外）');
  // ⚠️ 下面兩顆是「把字元集合往外放一格」的探針：`/^[ \\t\\f]*$/`、`/^[ \\t\\u2003]*$/`
  //    都能通過上面那幾顆，卻重開「其他空白被略過」的假綠方向（#585 r4 Low）。
  assert.equal(stillInside('\f'), false, '換頁字元不是 CommonMark 的空行字元——不可以被略過');
  assert.equal(stillInside('\u2003'), false, 'em space（U+2003）不是 CommonMark 的空行字元——不可以被略過');
});

test('⭐ 找不到、或找到不只一個，一律回報 hits（呼叫端要自己出訊息，不可以默默拿 -1 去切）', () => {
  assert.deepEqual(ruleItemRange(['## 沒有清單'], 12), { hits: 0, start: -1, end: -1, col: -1 });
  assert.deepEqual(ruleItemRange(['12. 第一個', '12. 第二個'], 12), { hits: 2, start: -1, end: -1, col: -1 });
  // 記號前四格空白＝縮排區塊，不是頂層清單項
  assert.equal(ruleItemRange(['    12. 這是縮排區塊'], 12).hits, 0);
  // 記號後沒有空白＝不是清單項（`12.5` 這種版本號不可以被當成第 12 條）
  assert.equal(ruleItemRange(['12.5 這是版本號'], 12).hits, 0);
});

test('⭐ 懶續行與 tab 縮排的行會被當成邊界（早切）——這是行為，不是「方向一定安全」的保證', () => {
  const lazy = ['12. **標題**', '這一行沒有縮排，GFM 會把它當成同一段的續行', '## 尾'];
  const r1 = ruleItemRange(lazy, 12);
  assert.ok(!lazy.slice(r1.start, r1.end).join('\n').includes('續行'),
    '懶續行算在外面。踩到時把那一行縮排四格即可（AGENTS.md 的鐵則內文一向縮排四格）。'
    + '⚠️ 這只是這支 helper 的行為：接到保存題之後，「改動既有被釘住的行」會紅，'
    + '但「在白名單之後追加」反而會綠——早切不等於方向安全，見檔頭那條劃界（#585 r8／r10）。');
  const tabbed = ['12. **標題**', '\t這一行用 tab 縮排', '## 尾'];
  const r2 = ruleItemRange(tabbed, 12);
  assert.ok(!tabbed.slice(r2.start, r2.end).join('\n').includes('tab 縮排'), '同上：這裡只數空白');
});
