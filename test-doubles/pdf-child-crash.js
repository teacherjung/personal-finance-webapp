// @ts-check
// 假子行程②：**提早死**——沒有任何 stdout，非同步丟出未捕捉的例外，`code 1` 收場。
//
// 這正是 2026-08-28〜09-01 CI 那三次紅的形狀（`ERR_INVALID_STATE: Controller is already closed`
// 從 pdfjs 的訊息回呼丟出來、沒人接）。
// 用途：釘住「**子行程提早死＝500，不可以假裝成 400 使用者層錯誤**」。
// ⚠️ 這條界線是本層最容易被弄壞的地方（#350 r2 的原始教訓）：把「沒有 stdout」一律當成
//    「使用者的檔案太貴」，會**責怪使用者並藏起部署／程式故障**。
import { readFileSync } from 'node:fs';
// 明確 import（test-doubles 不在 eslint 的 node globals 名單裡；不為了一支假替身去動共用設定）
import { setTimeout } from 'node:timers';

try { readFileSync(0, 'utf8'); } catch { /* 同上 */ }
setTimeout(() => { throw new Error('假子行程：模擬非同步未捕捉例外'); }, 10);
