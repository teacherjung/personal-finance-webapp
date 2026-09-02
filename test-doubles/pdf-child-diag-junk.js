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
  // ⚠️ **超量必須是「通過白名單之後」還超量**（Grok 掃描 #1，2026-09-02）：
  //    上一版超量的是 50 個不在白名單的 `pdf_flood_*`，過濾完只剩 3 筆 ⇒ 父行程的
  //    `.slice(0, 8)` 是 no-op，那道上限根本沒被量到（刪掉它考題照樣全綠）。
  //    所以這裡放 12 個**合法**代碼，讓上限真的咬得到。
  diag: [
    ...Array.from({ length: 12 }, () => 'pdf_cancel_failed'),   // 白名單內、且超過 8 筆
    '龘䶵鱻麤龗厵-帳號1234-金額9876',        // 未知代碼＋PII 哨兵：一個字都不可以進日誌
    { evil: 'object' }, 42, null,           // 非字串
    ...Array.from({ length: 50 }, (_, i) => `pdf_flood_${i}`),   // 未知代碼的洪水
  ],
}));
