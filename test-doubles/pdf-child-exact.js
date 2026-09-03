// @ts-check
// 假子行程⑦：**剛好在牆的兩側**——吐出 MAX_RESULT_BYTES 加一或減一個 byte 的垃圾，然後正常結束。
//
// 用途（Codex #551 r2 High）：用「灌到超標」的計時題只能把牆夾在「約 25MB 到 15 秒能灌多少」之間，
// 正式比較式被改成 300MB／32MB 照樣綠。這隻把酬載大小綁在**匯出的同一個常數**上：
//   ・多一 byte ⇒ 牆必須觸發（400 pdf_result_too_large）；牆若被調大（或不看常數）⇒ 子行程正常結束、
//     父行程拿到一坨非 JSON ⇒ 500 bad_output ⇒ 考題紅。
//   ・少一 byte ⇒ 牆不得觸發（非 JSON ⇒ 500 bad_output）；牆若被調小 ⇒ too_large ⇒ 考題紅。
// 差值由環境變數 PDF_EXACT_DELTA（'+1'／'-1'）決定——這是**測試替身**，正式子行程不讀任何 env。
import { readFileSync } from 'node:fs';
import { stdout, env, exit } from 'node:process';
import { Buffer } from 'node:buffer';
import { MAX_RESULT_BYTES } from '../lib/pdf-isolate.js';

try { readFileSync(0, 'utf8'); } catch { /* 父行程先關 stdin 也無所謂 */ }
const delta = env.PDF_EXACT_DELTA === '-1' ? -1 : 1;
let left = MAX_RESULT_BYTES + delta;
// 預設純 ASCII（1 byte＝1 code unit）；PDF_EXACT_MULTIBYTE=1 時改用 3-byte 的「中」重複填滿——
// 這時 bytes 是字串長度的三倍：父行程若用字串長度數（code units），MAX+1 bytes 只算到約 1/3、牆不會觸發 ⇒ 考題紅。
const chunk = env.PDF_EXACT_MULTIBYTE === '1'
  ? Buffer.from('中'.repeat(Math.ceil((1024 * 1024) / 3)), 'utf8').subarray(0, 1024 * 1024)
  : Buffer.alloc(1024 * 1024, 0x78);   // 'x'
function pump() {
  while (left > 0) {
    const n = Math.min(left, chunk.length);
    const ok = stdout.write(n === chunk.length ? chunk : chunk.subarray(0, n));
    left -= n;
    if (!ok) { stdout.once('drain', pump); return; }
  }
  stdout.end(() => exit(0));
}
pump();
