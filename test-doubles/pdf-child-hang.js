// @ts-check
// 假子行程①：**真的卡住**——收下 stdin 之後什麼都不寫，也永遠不結束。
//
// 用途：驗父行程的「等到逾時 → SIGKILL → 400 `pdf_timeout`」那條路。
// ⚠️ 為什麼不用真 PDF 製造卡住（2026-08-29）：那是時間競速。CI 上實測失敗耗時
//    2.91／2.98／3.02 秒、逾時 3.00 秒＝餘裕 3%，同一顆 commit 一次紅一次綠。
//    這支的行為是確定的：不管機器多快多慢，它都不會結束。
import { readFileSync } from 'node:fs';
// 明確 import（test-doubles 不在 eslint 的 node globals 名單裡；不為了一支假替身去動共用設定）
import { setInterval } from 'node:timers';

try { readFileSync(0, 'utf8'); } catch { /* 父行程先關 stdin 也無所謂 */ }
// ref 住事件迴圈＝行程不會自己退出（父行程必須真的 SIGKILL 才收得回）
setInterval(() => {}, 1_000);
