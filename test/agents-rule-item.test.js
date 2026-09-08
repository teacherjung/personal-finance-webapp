// `test/helpers/agents-rule-item.js` 的正反例表。
// 為什麼要有：那支 helper 是「承重句在**它自己那一條**裡」這句話的全部依據。
// 它的第一版（一張「下一條長什麼樣」的正規式）在 #585 r2 被獨立審查者用**四種合法寫法**打穿：
// `13.` 前一格空白、點號後接 tab、三格縮排、`13)`——四種都認不得，於是隔壁那一條的文字
// 被借去充數。修完如果沒有固定夾具守著，退回去也不會有考題叫（#578 r11 Low⑤ 的病型）。
// 這張表就是那個缺口的補丁：**下面每一種寫法都是當初打穿它的那一刀**。
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

test('⭐ 內容欄跟著記號寬度走（不是寫死四格）', () => {
  const wide = ['9.  **記號後兩格空白**', '', '   這一行縮排三格＝小於內容欄，結束它', '    這一行不算'];
  assert.equal(ruleItemRange(wide, 9).col, 4, '`9.` ＋兩格空白＝內容欄第 4 欄');
  const long = ['123. **三位數編號**', '', '     內容欄是第 5 欄', '## 尾'];
  const r = ruleItemRange(long, 123);
  assert.equal(r.col, 5, '`123. ` 的內容欄是第 5 欄');
  assert.ok(long.slice(r.start, r.end).join('\n').includes('內容欄是第 5 欄'));
  // 記號後空白多於四格：CommonMark 只算一格
  const loose = ['7.      **空白很多**', '', '   縮排三格仍在條內（內容欄第 3 欄）', '## 尾'];
  assert.equal(ruleItemRange(loose, 7).col, 3);
});

test('⭐ 找不到、或找到不只一個，一律回報 hits（呼叫端要自己出訊息，不可以默默拿 -1 去切）', () => {
  assert.deepEqual(ruleItemRange(['## 沒有清單'], 12), { hits: 0, start: -1, end: -1, col: -1 });
  assert.deepEqual(ruleItemRange(['12. 第一個', '12. 第二個'], 12), { hits: 2, start: -1, end: -1, col: -1 });
  // 記號前四格空白＝縮排區塊，不是頂層清單項
  assert.equal(ruleItemRange(['    12. 這是縮排區塊'], 12).hits, 0);
  // 記號後沒有空白＝不是清單項（`12.5` 這種版本號不可以被當成第 12 條）
  assert.equal(ruleItemRange(['12.5 這是版本號'], 12).hits, 0);
});

test('⭐ 已知的假紅（刻意留著，方向安全）：懶續行與 tab 縮排會被當成邊界', () => {
  const lazy = ['12. **標題**', '這一行沒有縮排，GFM 會把它當成同一段的續行', '## 尾'];
  const r1 = ruleItemRange(lazy, 12);
  assert.ok(!lazy.slice(r1.start, r1.end).join('\n').includes('續行'),
    '懶續行算在外面＝可能假紅。這是刻意的：反過來做（把不縮排的行都收進來）換到的是靜靜放過。'
    + '踩到時把那一行縮排四格即可（AGENTS.md 的鐵則內文一向縮排四格）。');
  const tabbed = ['12. **標題**', '\t這一行用 tab 縮排', '## 尾'];
  const r2 = ruleItemRange(tabbed, 12);
  assert.ok(!tabbed.slice(r2.start, r2.end).join('\n').includes('tab 縮排'), '同上：這裡只數空白');
});
