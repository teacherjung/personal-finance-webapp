/**
 * 承重字表的位元組完整性考題（2026-09-01，Codex #536 r5 之後；William 裁示「位元組釘」）
 *
 * 這支考題只做一件事：讀 `test/helpers/money-family-probes.js` 的**位元組**、比對雜湊。
 *
 * ⚠️ **本檔刻意不 import 那個 helper，一行都不要加**——這是它唯一的承重理由：
 * `node --test` 讓每個測試檔跑在自己的行程裡（本機實測：同一次執行的兩支考題 PID 不同），
 * 所以在這個行程裡 helper 的程式碼**從未執行**，沒有任何機會改寫 `readFileSync`、
 * 污染 `Array.prototype` 的迭代行為、或動 `assert`。
 *
 * 為什麼需要這樣（Codex #536 r3–r5 五輪同族實證，每一形都真的重現過退化）：
 *   ① 刪掉一個動詞           → 值雜湊擋掉
 *   ② 等量替換（submit→zubmit）→ 值雜湊擋掉
 *   ③ 實例 Symbol.iterator    → 序列化視圖與迭代視圖分家，值雜湊假綠
 *   ④ 原型層 Symbol.iterator  → 同上，canonical 快照也假綠
 *   ⑤ 改寫 readFileSync＋syncBuiltinESMExports → **連位元組釘自己都假綠**
 * ⑤ 的教訓不是「再補一形」：ESM 的靜態 import 一律先於本檔程式碼執行，
 * 同行程內「先執行的程式碼污染後面的檢查」這條路補不完。換行程才有終點。
 *
 * 改了 helper（含改註解）就要重算下面這行：
 *   node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('test/helpers/money-family-probes.js')).digest('hex'))"
 *
 * ⚠️ 誠實劃界：本考題證明的是「磁碟上的 helper ＝ 被審查過的那一版」。
 * 改本檔自己、或連雜湊一起改的人它擋不住——那層靠審查制度（沒有任何 repo 內考題
 * 能防「把考題連題目一起改掉」的人）。探針的**行為**正確性由
 * `test/money-boundary.test.js` 與 `test/codex-money-hook.test.js` 的實跑斷言把守。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HELPER = path.join(ROOT, 'test', 'helpers', 'money-family-probes.js');

// helper 檔案位元組的 sha256（William 2026-09-01 裁示的那顆釘）。
const HELPER_BYTES_SHA256 = 'f7dde866515761a4d190769cd8825ea3b50a35ee745e34d484d9dc6eeb1804a2';

test('承重字表 helper 的位元組與釘相符（本行程不載入它，取樣不可能被它污染）', () => {
  const actual = createHash('sha256').update(readFileSync(HELPER)).digest('hex');
  assert.equal(actual, HELPER_BYTES_SHA256,
    'test/helpers/money-family-probes.js 的檔案位元組與本檔的字面釘不符——'
    + '改那個檔案（含註解）時要有意識地重算這顆雜湊（做法見本檔頂端註解）。');
});
