// @ts-check
// 假子行程③：**安靜退出**——沒有任何 stdout、沒有 stderr，事件迴圈一空就 `code 0` 結束。
//
// 這是 2026-08-01 看到、當時被誤診成「pdfjs 卡在解壓」的形狀（真正的原因見
// `lib/parse-limits.js` 的 `cancelStream`）。正式子行程掛 keep-alive 就是為了不長這樣。
// 用途：釘住「安靜退出也是 500」——父行程不可以把它猜成資源耗盡而回 400。
import { readFileSync } from 'node:fs';

try { readFileSync(0, 'utf8'); } catch { /* 同上 */ }
