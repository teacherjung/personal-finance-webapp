// @ts-check
// 假子行程④：回一個**帶診斷代碼**的正常結果——驗父行程有沒有把封閉代碼記進日誌。
//
// 為什麼要有這支（Codex #538 r3 High）：取消失敗時「原本的 400 照樣回得去」，父行程因此走
// parsed 4xx 那條路、不看 stderr ⇒ 子行程的 console.error 在 HOSTED 完全靜默。
// 診斷代碼是它唯一的出聲管道，而這支釘住「父行程真的會把它記下來」。
import { readFileSync } from 'node:fs';
// 明確 import（test-doubles 不在 eslint 的 node globals 名單裡；不為了假替身去動共用設定）
import process from 'node:process';

try { readFileSync(0, 'utf8'); } catch { /* 父行程先關 stdin 也無所謂 */ }
process.stdout.write(JSON.stringify({
  ok: false,
  message: '這份 PDF 的文字內容太多，無法安全解析。',
  status: 400,
  code: 'pdf_too_many_text_items',
  diag: ['pdf_cancel_failed'],
}));
