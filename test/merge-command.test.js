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

/**
 * 兩題共用的判斷（Codex #611 r1 中②：對照題原本只斷言自己剛設的值、沒跑判斷式）。
 * 回 null＝一致；回字串＝哪裡不一致。
 * @param {{ mergeCommand?: { args?: string[] }, gates: { args?: string[], state?: string }[] }} s
 */
function problemOf(s) {
  const args = s.mergeCommand?.args ?? [];
  if (!Array.isArray(args) || args.length === 0) return 'settings.json 的 mergeCommand.args 要是非空陣列——合併指令沒登記，tools/merge.js 會退 2';
  const stacked = s.gates.filter((g) => Array.isArray(g.args) && g.args.includes(STACKED));
  if (stacked.length !== 1) return `settings.json 的 gates 裡 ${STACKED} 要恰好登記一筆（現在 ${stacked.length} 筆）`;
  if (args.includes('--delete-branch') && stacked[0].state !== '已啟用') {
    return `合併指令帶 --delete-branch，但堆疊閘登記成「${stacked[0].state}」——tools/merge.js 不看旗標、只跑已啟用的閘，`
      + '刪底支的分支會把疊在上面的 PR 連帶關成已合併（2026-07-10 #3/#5）。要嘛翻成已啟用、要嘛把 --delete-branch 拿掉，兩者同支改';
  }
  return null;
}

test('合併指令帶 --delete-branch 時，堆疊閘（tools/gates/check-stacked.js）必須登記為已啟用', () => {
  assert.equal(problemOf(settings), null);
});

test('對照：把堆疊閘改回未啟用（其餘不動），同一個判斷要報問題；拿掉 --delete-branch 就不報', () => {
  // 餵改過的物件給**同一個**判斷（不是自己斷言自己剛設的值）——證明綁的是「已啟用」這個值與那個旗標（RULES E8）
  const fake = structuredClone(settings);
  const g = fake.gates.find((x) => x.args.includes(STACKED));
  g.state = '已安裝未啟用';
  assert.match(String(problemOf(fake)), /已啟用/, '堆疊閘停用了，判斷卻沒報——判斷式被掏空');
  const noFlag = structuredClone(fake);
  noFlag.mergeCommand.args = noFlag.mergeCommand.args.filter((a) => a !== '--delete-branch');
  assert.equal(problemOf(noFlag), null, '沒有 --delete-branch 時堆疊閘停用不該被本題咬（那是別題的事）');
  const none = structuredClone(settings);
  none.gates = none.gates.filter((x) => !x.args.includes(STACKED));
  assert.match(String(problemOf(none)), /恰好登記一筆/, '堆疊閘沒登記要報');
});
