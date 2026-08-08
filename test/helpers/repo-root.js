import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/**
 * repo 根目錄的**共用**算法：解過 URL 編碼、而且會驗自己算出來的是不是「載入本檔的那一棵樹」。
 * 新寫的考題請 `import { ROOT } from './helpers/repo-root.js'`。
 *
 * ⚠️ **誠實劃界**（本檔只保證這些，多寫一句就會過期）：
 *   - 這是**供採用者共用**的一份，**不是** repo 唯一在算 repo 根的地方——別的考題可能自己算。
 *   - 取 `.pathname` 當檔案路徑才有問題；**URL 物件直接交給 `fs`**（或先過 `fileURLToPath`）
 *     是安全的，Node 自己會解碼。
 *
 * ⚠️ 為什麼要有這一份（2026-08-08 事故）：
 * `new URL(<相對路徑>, import.meta.url).pathname` 留著 URL 編碼。專案落在含**空白與中文**的路徑下時
 * 算出 `.../07%20%E5%B0%88%E6%A1%88/...` ⇒ `readFileSync` 直接 ENOENT。
 * 而純 ASCII 的實作樹與審查樹完全看不出來——**在使用者自己的目錄跑才紅**。
 *
 * ⚠️ 為什麼「語法檢查」不能當這件事的門（與 `test/entry-guard.test.js` 同一個結論）：
 * 掃描器只認得寫法，而同一個錯有無數種自然寫法（解構、存成中間變數、把 base 抽成常數……
 * 每一種都是合法 JS、都真的 ENOENT）。⇒ 門是**這一份實作＋下面那顆載入時的斷言**；
 * `test/test-path-decoding.test.js` 的語法掃描是**早期警告**，射程寫在它自己的誠實劃界那一題裡。
 */export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ⚠️ 載入時就吵：這是這一族**不看寫法、只看結果**的檢查。
//    ⚠️ **只驗「有 package.json」不夠**（r3 阻擋①，複驗者實際重現）：ROOT 若指到**另一棵 checkout**
//    （同一支 repo 的別棵工作樹，它當然也有 package.json），斷言照樣通過，掃描器就靜靜掃了別棵樹
//    ——他實測：工作樹在中文路徑、helper 卻回 `/private/tmp/codex-review-pr433`，三檔 37/37 全綠。
//    ⇒ 必須驗**身分**：`realpathSync` 把兩邊都解成 canonical 路徑字串再比
//    （⚠️ 比的是**路徑字串**，不是 inode——同一顆 inode 的硬連結會有不同 canonical 路徑）。
const SELF_REL = join('test', 'helpers', 'repo-root.js');
const selfHere = fileURLToPath(import.meta.url);
if (!existsSync(join(ROOT, 'package.json'))) {
  throw new Error(
    `test/helpers/repo-root.js 算出的 ROOT 不是 repo 根：${ROOT}\n`
    + '（找不到 package.json。常見原因：路徑含空白／中文卻沒有解 URL 編碼——那正是本檔存在的理由。）',
  );
}
if (realpathSync(join(ROOT, SELF_REL)) !== realpathSync(selfHere)) {
  throw new Error(
    'test/helpers/repo-root.js 算出的 ROOT 指到**另一棵 checkout**：\n'
    + `  ROOT            = ${ROOT}\n`
    + `  ROOT 下的本檔    = ${realpathSync(join(ROOT, SELF_REL))}\n`
    + `  正在執行的本檔    = ${realpathSync(selfHere)}\n`
    + '⇒ 掃描器會靜靜掃別棵樹而回報「零違規」（r3 阻擋①，複驗者實際重現過）。',
  );
}
