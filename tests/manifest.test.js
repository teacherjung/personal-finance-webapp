// 考題清單（r1 Medium⑫）：tests/ 裡的考題檔集合要跟 tests/manifest.json 一字不差。
//
// 為什麼要另立一支：原本的金絲雀住在 settings.test.js 裡，它自己被刪掉就沒有人數考題；而沒有同名工具的
// 結構性考題（忽略清單、檔名、路標、資料契約）也不在它的對照表上。這一支跟 settings.test.js 互相盯著：
// 刪掉任何一支考題檔（含這兩支之一）都會紅，除非連清單一起改——那是看得見的改動。
//
// 守得到的：考題檔的集合不漂（多一支、少一支、改名都紅）。
// ⚠️ 守不到的：兩支同時被刪；清單被一起改掉（那是看得見的，由審查的人看）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('tests/ 裡的考題檔集合跟 manifest.json 一字不差', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  const onDisk = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  assert.deepEqual(onDisk, [...manifest].sort(), '考題檔集合跟清單不一樣：加一支或刪一支都要連 manifest.json 一起改，讓改動看得見');
  assert.ok(manifest.includes('settings.test.js') && manifest.includes('manifest.test.js'), '互相盯著的兩支都要在清單上');
  assert.ok(manifest.length >= 20, `清單只剩 ${manifest.length} 支：這一題自己的前提變了`);
});
