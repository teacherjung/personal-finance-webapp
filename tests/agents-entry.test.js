// 守指示檔的長度（AGENTS.md：兩家 AI 每次開工都自動整份讀進去的那一份；規矩 K6 的「指示檔」）。
//
// 為什麼：Codex 只自動讀指示鏈合計前約 32 KiB（家目錄那一份＋倉庫根到工作目錄逐層串接），超過的部分它讀不到、也不會說；
// 常設指示一則一則往裡加，沒有東西在數。上限跟第一個使用專案同一個數字（它的 test/agents-entry.test.js：28,000 位元組），
// 留下的餘裕給家目錄與上層那幾份。
// ⚠️ 守不到的：只量倉庫內根目錄這一份；家目錄、工作目錄上層那幾份與整條鏈合計不在這裡量；
//   上層有沒有 CLAUDE.md（有它 Claude 就不讀這一份）這裡也看不到，靠指示檔第 5 行那句與開工時看 /memory。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 28000;

test('指示檔 AGENTS.md 在、而且不超過 28,000 位元組（只量倉庫內這一份；Codex 讀的是整條指示鏈合計）', () => {
  const file = path.join(__dirname, '..', 'AGENTS.md');
  assert.ok(fs.existsSync(file), '根目錄沒有 AGENTS.md：兩家 AI 開工都讀它（常設指示寫在這裡，規矩 K6）');
  const bytes = fs.readFileSync(file).byteLength;
  assert.ok(bytes > 0 && bytes <= LIMIT, `AGENTS.md 有 ${bytes} 位元組，要在 1〜${LIMIT} 之間：細節搬進 README 或對應的文件，指示檔只留指路`);
});
