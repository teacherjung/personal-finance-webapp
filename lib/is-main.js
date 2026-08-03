/**
 * 「這支檔案是被直接執行的嗎？」——**唯一實作**。
 *
 * 為什麼要有這支：本專案原本有六個地方各寫一份這個判斷，而且**六份寫法都不一樣**
 * （`resolve()`／裸字串比對／`|| ''`／`realpathSync`）。它們錯的時候**不會叫**：
 * 判斷成 false ⇒ `main()` 不跑 ⇒ 退出碼 0 ⇒ 對呼叫者來說就是**「這道閘通過了」**。
 * **一道靜靜回報通過的閘，比沒有閘更糟。**（2026-08-03 在 #388 實際踩到：
 * 把閘複製到 `/tmp/xgate.mjs` 執行，完全沒有輸出、exit 0。）
 *
 * 兩個坑，缺一不可：
 *
 * ① **symlink**：macOS 的 `/tmp` 其實是 `/private/tmp` 的 symlink。Node 給的
 *    `import.meta.url` 是**解析過** symlink 的真實路徑（`/private/tmp/…`），
 *    而 `process.argv[1]` 是**你打進去的樣子**（`/tmp/…`）——兩邊永遠比不相等。
 *    ⇒ 至少要 `realpathSync(argv[1])`。
 *    **兩邊都做**是因為 `--preserve-symlinks-main` 之下 Node 連 `import.meta.url`
 *    都不解析，只修一邊當場就錯（考題 `test/entry-guard.test.js` 有一條專門跑那個旗標——
 *    沒有那條的話，「兩邊都要」就只是我說說而已）。
 *
 * ② **百分號編碼**：本專案的路徑含中文與空格，`import.meta.url` 會編碼成
 *    `%E6%A6%AE…`，所以不能拿 `file://${argv[1]}` 這種裸字串去比。
 *    ⇒ 統一轉成**檔案系統路徑**再比（不是轉成 URL 再比）。
 *
 * ⚠️ **刻意不 try/catch**：萬一 `realpathSync` 丟例外（檔案不存在），
 *    吞掉它就會回 false ⇒ 又變成「靜靜不執行」，正是本檔要根治的病。
 *    讓它**大聲炸掉**：閘炸掉＝非零退出＝擋下來（fail-closed），
 *    server 炸掉＝看得到堆疊，而不是「啟動了但沒在聽」。
 *    （實務上這兩個路徑都是正在執行中的檔案，不可能不存在。）
 *
 * @param {string} importMetaUrl 呼叫端的 `import.meta.url`
 * @returns {boolean} 這支檔案就是本次執行的進入點
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;   // 例如 `node -e '…'`：沒有進入點檔案
  return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry);
}
