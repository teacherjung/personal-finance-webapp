// 守註解裡的路標（規矩 K3）：帶記號、用全形引號指到某一題的路標，那段文字必須在同一支檔案的別處出現。
//
// 為什麼：路標指到不存在的題，下一個人看到警告卻找不到證據，就會以為警告過期而把它拿掉（原專案三次）。
// 判準刻意極簡、不解析程式碼（原專案用語法分析建索引，連續五輪各找到新洞——靜靜數錯然後說通過）。
// 守得到的：tests/ 第一層與 tests/helpers/ 第一層的每支檔，記號後緊接的「…」在挖掉路標之後的原文裡找得到；
//   記號後有左引號但右引號不在同一行＝壞路標，也紅。
// ⚠️ 守不到的：不帶記號的指路；跨檔引用；指得到但指錯地方；路標同時命中兩題；更深的子目錄。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
/** 記號的單一真相。刻意用變數組出正規式：本檔自己也在被掃。 */
const MARKER = ['題名', '關鍵字'].join('');
const REF = () => new RegExp(`${MARKER}[:：]?[ \\t\\u3000]*(?:\\n[ \\t]*(?://|[*])[ \\t]*)?[「]([^」\\n]+)[」]`, 'g');
const OPEN = () => new RegExp(`${MARKER}[:：]?[ \\t\\u3000]*(?:\\n[ \\t]*(?://|[*])[ \\t]*)?[「]`, 'g');

/** 回問題清單（空＝通過）。 */
function problemsIn(source, name) {
  const out = [];
  const rest = source.replace(REF(), '');
  const wellFormed = new Set([...source.matchAll(REF())].map((m) => m.index));
  for (const m of source.matchAll(REF())) {
    if (!rest.includes(m[1])) out.push(`${name}：路標「${m[1]}」在本檔別處找不到`);
  }
  for (const m of source.matchAll(OPEN())) {
    if (!wellFormed.has(m.index)) out.push(`${name}：有一個壞掉的路標（左引號後右引號不在同一行）`);
  }
  return out;
}

function scanFiles() {
  const first = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('tests', f));
  const helpers = fs.existsSync(path.join(ROOT, 'tests', 'helpers')) ? fs.readdirSync(path.join(ROOT, 'tests', 'helpers')).filter((f) => f.endsWith('.js')).map((f) => path.join('tests', 'helpers', f)) : [];
  return [...first, ...helpers];
}

test('tests/ 裡每一支檔的路標都指得到', () => {
  const problems = scanFiles().flatMap((f) => problemsIn(fs.readFileSync(path.join(ROOT, f), 'utf8'), f));
  assert.deepEqual(problems, []);
});

test('判準本身：指不到要抓、指得到放行、不可以自己滿足自己、壞路標要抓', () => {
  assert.equal(problemsIn(`test('真的題名 A', () => {});\n// ${MARKER}「不存在的題名」`, 'x').length, 1);
  assert.equal(problemsIn(`test('很獨特的題名', () => {});\n// ${MARKER}「很獨特的題名」`, 'x').length, 0);
  assert.equal(problemsIn(`test('毫不相干', () => {});\n// ${MARKER}「只出現在路標裡的字」\n// ${MARKER}「只出現在路標裡的字」`, 'x').length, 2, '兩個路標互相滿足也不算');
  assert.equal(problemsIn(`// ${MARKER}「沒有右引號\n的路標」`, 'x').length, 1);
  assert.equal(problemsIn(`test('折一次行', () => {});\n// ${MARKER}\n// 「折一次行」`, 'x').length, 0, '記號與引號之間允許折一次帶註解符號的行');
});
