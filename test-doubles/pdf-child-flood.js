// @ts-check
// 假子行程⑥：**回傳量炸彈**——讀完 stdin 後，不停往 stdout 灌垃圾、永遠不結束。
//
// 模擬的是「壓縮炸彈解開後，抽取結果大到把父行程撐爆」那個形狀（2026-09-02 第二輪稽核第 2 條）：
// 父行程若沒有回傳量上限，會把上百 MB 收進記憶體再被容器 OOM 殺掉＝**所有人**的操作一起斷線。
// 兩個用途（test/pdf-isolate.test.js）：
//   ・「kill 半邊」臂：逾時放遠（20 秒），超標必須**當場 SIGKILL** 並回 400 pdf_result_too_large；kill 被拆掉就會拖到逾時而紅。
//   ・「逾時優先」臂：逾時縮到 0.8 秒（灌不到 64MB），已有半截輸出時必須回 400 pdf_timeout、不是 bad_output。
// ⚠️ 它靠父行程 SIGKILL 才會停；父行程若沒殺它，它會一直寫到逾時——這正是兩臂要分辨的兩種死法。
import { readFileSync } from 'node:fs';
import { setInterval } from 'node:timers';
import { stdout } from 'node:process';

try { readFileSync(0, 'utf8'); } catch { /* 父行程先關 stdin 也無所謂 */ }
const chunk = 'x'.repeat(64 * 1024);
setInterval(() => { try { stdout.write(chunk); } catch { /* 管線被關就等 SIGKILL */ } }, 2);
