// @ts-check
// 假子行程⑤：回一堆**不該被信任**的診斷——白名單、未知代碼（帶 PII 哨兵）、非字串、重複、超量。
// 用途：釘住「父行程只記白名單內的代碼、而且有數量上限」——子行程回什麼都不能決定日誌長什麼樣。
import { readFileSync } from 'node:fs';
import process from 'node:process';

try { readFileSync(0, 'utf8'); } catch { /* 父行程先關 stdin 也無所謂 */ }
process.stdout.write(JSON.stringify({
  ok: false,
  message: '這份 PDF 的文字內容太多，無法安全解析。',
  status: 400,
  code: 'pdf_too_many_text_items',
  diag: [
    'pdf_cancel_failed',                    // 白名單內
    '龘䶵鱻麤龗厵-帳號1234-金額9876',        // 未知代碼＋PII 哨兵：一個字都不可以進日誌
    { evil: 'object' }, 42, null,           // 非字串
    'pdf_cancel_failed', 'pdf_cancel_failed',   // 重複
    ...Array.from({ length: 50 }, (_, i) => `pdf_flood_${i}`),   // 超量
  ],
}));
