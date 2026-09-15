// 守忽略清單（規矩 B4、E7）：真實資料不進版本控制，靠的是忽略清單；而忽略清單被改了沒有人會發現。
//
// 為什麼：原專案量過，忽略清單裡多一行就能讓「真實資料檔」靜靜被排除在檢查之外，或反過來讓它進倉庫。
// 守得到的：專案設定登記的每一份忽略檔，生效的樣式要跟登記的一字不差（多一行、少一行、改一行都紅）；
//   本倉庫自己的 .gitignore 也登記在內，所以這一題在套件裡就是真的。
// ⚠️ 守不到的：清單合不合理；沒登記的忽略機制（子目錄另設清單、其他豁免通道）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { read } = require('../tools/settings-data.js');

const ROOT = path.join(__dirname, '..');
const activePatterns = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('登記的每一份忽略檔，生效的樣式跟登記的一字不差', () => {
  const lists = read().ignoreLists;
  assert.ok(Array.isArray(lists) && lists.length >= 1, '設定裡至少要登記一份忽略清單（本倉庫自己的 .gitignore）');
  for (const { file, patterns } of lists) {
    assert.ok(typeof file === 'string' && Array.isArray(patterns), `登記的形狀不對：${JSON.stringify({ file, patterns })}`);
    const actual = activePatterns(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    assert.deepEqual(actual, patterns, `${file} 的生效樣式跟登記的不一樣——改忽略清單要連設定一起改，讓改動看得見`);
  }
});

test('活的樣式判法：註解與空行不算', () => {
  assert.deepEqual(activePatterns('# c\n\n a/ \nb\n'), ['a/', 'b']);
});
