// @ts-check
// 合併指令與堆疊閘的綁定（搬家第 5 步，2026-09-17）。
//
// 為什麼要有這一題：本專案的合併指令帶 `--delete-branch`（settings.json 的 mergeCommand）。刪掉底支的分支時，
// 疊在它上面的 PR 會被 GitHub 直接關成「已合併」且救不回來（2026-07-10 #3/#5 實際發生）。套件把這件事交給堆疊閘
// `tools/gates/check-stacked.js`（RULES H2：底必須是主幹、上面不能疊別支），但 `tools/merge.js` 只跑登記為「已啟用」的閘、
// **不看合併指令帶了什麼旗標**——堆疊閘若被登記回「已安裝未啟用」，合併指令照樣帶著 --delete-branch 按下去、只印一行 ⚠️。
// 舊制那條「堆疊 PR 合併時不要用 --delete-branch」的規則與釘它的考題隨切換日退役，這一題是唯一把兩者綁起來的東西。
//
// 誠實劃界：本題只釘登記（settings.json）的一致性；堆疊閘本身擋不擋得住由套件的 tests/check-stacked.test.js 守。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const settings = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8'));
const STACKED = 'tools/gates/check-stacked.js';

test('合併指令帶 --delete-branch 時，堆疊閘（tools/gates/check-stacked.js）必須登記為已啟用', () => {
  const args = settings.mergeCommand?.args ?? [];
  assert.ok(Array.isArray(args) && args.length > 0, 'settings.json 的 mergeCommand.args 要是非空陣列——合併指令沒登記，tools/merge.js 會退 2');
  const stacked = settings.gates.filter((g) => Array.isArray(g.args) && g.args.includes(STACKED));
  assert.equal(stacked.length, 1, `settings.json 的 gates 裡 ${STACKED} 要恰好登記一筆（現在 ${stacked.length} 筆）`);
  if (args.includes('--delete-branch')) {
    assert.equal(stacked[0].state, '已啟用',
      `合併指令帶 --delete-branch，但堆疊閘登記成「${stacked[0].state}」——tools/merge.js 不看旗標、只跑已啟用的閘，`
        + '刪底支的分支會把疊在上面的 PR 連帶關成已合併（2026-07-10 #3/#5）。要嘛翻成已啟用、要嘛把 --delete-branch 拿掉，兩者同支改');
  }
});

test('對照：把堆疊閘改回未啟用（其餘不動），上一題的判斷式要紅', () => {
  // 不改真檔、只對同一段判斷式餵改過的物件——證明綁的是「已啟用」這個值，不是任何長得像的東西（RULES E8）
  const fake = structuredClone(settings);
  const g = fake.gates.find((x) => x.args.includes(STACKED));
  g.state = '已安裝未啟用';
  assert.ok(fake.mergeCommand.args.includes('--delete-branch') && g.state !== '已啟用', '突變沒有改到判斷式看的那個值');
});
