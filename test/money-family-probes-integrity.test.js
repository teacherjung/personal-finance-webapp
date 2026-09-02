/**
 * 承重字表的位元組完整性考題（2026-09-01，Codex #536 r5 之後；William 裁示「位元組釘」）
 *
 * 這支考題只做一件事：讀 `test/helpers/money-family-probes.js` 的**位元組**、比對雜湊。
 *
 * ⚠️ **本檔刻意不 import 那個 helper，一行都不要加**——這是它唯一的承重理由：
 * `node --test` 讓每個測試檔跑在自己的行程裡（本機實測：同一次執行的兩支考題 PID 不同），
 * 所以在這個行程裡 helper 的程式碼**從未執行**，改寫不了取樣器。
 *
 * ⚠️⚠️ **這是絆線，不是安全閘（照實劃界，別再往上加層）**。
 * 它擋得住的是**未伴隨取樣環境／考題變更的位元組漂移**——那是實務上唯一會不小心
 * 發生的事：改了字表卻沒意識到兩張考卷的題目跟著變了。
 * （r8 M②：這句原本寫成「只動 helper 檔案的一切形狀」＝全稱保證，與下面那段
 * 「擋不住能注入程式碼的人」互斥，已補回前提。）
 * 它擋不住「有辦法在這個行程裡執行任意程式碼」的人，因為 Node 裡那條路是開放的
 * （preload 注入、改 package.json 的 test 指令、改本檔、改環境變數…列不完）。
 * **不要為了堵那些再加機制**：Codex #536 r2–r6 連六輪換六形（刪詞／等量替換／
 * 實例 iterator／原型 iterator／改寫取樣器／preload 注入），每一輪都真的重現了退化，
 * 也每一輪都證明「同行程可注入」這條路補不完。那些形狀的共同點是
 * **都需要一份審查看得見的 diff**（或根本不在 repo 裡）——所以它們歸審查制度守備，
 * 不歸考題。同 repo 既有教訓：護欄不能自己證明自己有在跑，
 * 誇大的保證比缺口更糟。
 *
 * 改了 helper（含改註解）就要重算下面這行：
 *   node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('test/helpers/money-family-probes.js')).digest('hex'))"
 *
 * 一句話總結它證明什麼（機器真能證明的那句）：**在沒有人動取樣環境的前提下，
 * 磁碟上的 helper ＝本檔字面釘的那一版**——「那一版有沒有被審查過」機器證明不了，
 * 那是重算雜湊時人要負的責任。探針的**行為**正確性由
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
const HELPER_BYTES_SHA256 = '5c4d6a864d52d813643b8dbff1ab8227f7a57534bb43596ceb7c9aa9269d3dd4';

test('承重字表 helper 的位元組與釘相符（本行程不載入它＝它的程式碼在這裡沒有執行機會）', () => {
  const actual = createHash('sha256').update(readFileSync(HELPER)).digest('hex');
  assert.equal(actual, HELPER_BYTES_SHA256,
    'test/helpers/money-family-probes.js 的檔案位元組與本檔的字面釘不符——'
    + '改那個檔案（含註解）時要有意識地重算這顆雜湊（做法見本檔頂端註解）。');
});
