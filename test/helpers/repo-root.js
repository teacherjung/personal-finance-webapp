import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/**
 * repo 根目錄的**唯一一份**算法。掃原始碼的考題一律 `import { ROOT } from './helpers/repo-root.js'`，
 * 不要自己在檔案裡再算一次。
 *
 * ⚠️ 為什麼要收成一份（2026-08-08 事故＋攻擊實測）：
 * 原本各檔自己算，其中兩支用了 `new URL(…, import.meta.url).pathname`——那個值**留著 URL 編碼**。
 * 本專案實際落在「07 專案/榮祥森（投資理財）」這種含空白與中文的路徑下，於是算出
 * `.../07%20%E5%B0%88%E6%A1%88/...` ⇒ `readFileSync` 直接 ENOENT，四題接線全紅。
 * 而 #417 的實作樹與十四棵審查樹都落在純 ASCII 的 `/private/tmp/…` ⇒ 全綠、十四輪審查也全綠，
 * **合併進 main、在使用者自己的目錄跑才紅**。
 *
 * ⚠️ **為什麼「語法檢查」不能當成這件事的門**（照 test/entry-guard.test.js 已下過的同一個結論）：
 * 掃描器只認得寫法，而同一個錯有無數種自然寫法。實測（2026-08-08 四路攻擊，每一種都是合法 JS、
 * 都真的拿到未解碼路徑、都真的 ENOENT，而純語法掃描器**全部漏掉**）：
 *   - `const { pathname } = new URL('..', import.meta.url)`      ← 解構，連 MemberExpression 都沒有
 *   - `const u = new URL('..', import.meta.url); u.pathname`     ← 存成中間變數
 *   - `const base = import.meta.url; new URL('..', base).pathname` ← base 抽成常數
 * 而且**陷阱已經佈好**：`test/stock-research-forest-ui.test.js` 與 `test/workspace-tabs.test.js`
 * 已經有 `const ROOT = new URL('../', import.meta.url)`（URL **物件**）。維護那兩支的人只要需要一個
 * 字串路徑餵 `join()`／`existsSync()`，手上最短的取法就是 `ROOT.pathname` ⇒ 同一顆雷再炸一次。
 *
 * ⇒ 所以真正的門是**這一份實作**（沒有第二份可以算錯）＋下面那顆載入時的存在性斷言（算錯就當場吵）。
 *   `test/test-path-decoding.test.js` 的語法掃描只是**早期警告**，不是門——它自己的檔頭也這樣寫。
 */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ⚠️ 載入時就吵：這是這一族唯一**不看寫法、只看結果**的檢查。ROOT 只要算錯（URL 編碼沒解、
//    層數算錯、被搬檔案），import 它的那一題立刻紅 —— 不會靜靜拿著一個不存在的路徑去掃出「零違規」。
if (!existsSync(join(ROOT, 'package.json'))) {
  throw new Error(
    `test/helpers/repo-root.js 算出的 ROOT 不是 repo 根：${ROOT}\n`
    + '（找不到 package.json。常見原因：路徑含空白／中文卻沒有解 URL 編碼——那正是本檔存在的理由。）',
  );
}
