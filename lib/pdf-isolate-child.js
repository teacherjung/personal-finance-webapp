// @ts-check
// **PDF 抽取的子行程入口**（只有 HOSTED 會用到；LOCAL 直接在行程內跑）。
//
// 為什麼要有這個檔（不是 `-e` 字串）：這個 repo 的路徑含**空白與中文**，
// 把腳本塞進 `-e` 再拼模組路徑很容易在引號／百分號編碼上出錯。
// 獨立檔案讓 `import` 走相對路徑，完全不必處理路徑跳脫。
//
// 協定（刻意做到最笨、最好除錯）：
//   父 → 子：argv[2] ＝ 種類；stdin ＝ 首行 JSON 標頭（含 password）＋換行＋base64 的 PDF 位元組
//   ⚠️ **密碼絕不走 argv／env**（#350 r1 的 PII 洩漏）——`ps` 與 /proc/<pid>/environ 都讀得到
//   子 → 父：stdout ＝ 一行 JSON。`{ok:true, result}` 或 `{ok:false, message, status}`
//   （result 的形狀由種類決定：PDF 抽取＝列陣列、xlsx＝{rows, allText}）
//   ⚠️ 子行程**沒有 stdout 不等於「檔案太貴」**（#350 r2 修正的舊誤解）：child 入口打錯、
//   相依壞掉一樣沒有 stdout。父行程只在「確認逾時／OOM 訊號」時才回 400，其餘 500。
import { readFileSync } from 'node:fs';

const KIND = process.argv[2] || '';

/** 三種抽取器。**新增種類時這裡與 `lib/pdf-isolate.js` 的 KINDS 要一起改**（有考題盯著）。 */
const EXTRACTORS = {
  statement: async () => (await import('./statement.js')).extractLinesForIsolation,
  bank: async () => (await import('./bank-statement.js')).extractBankLines,
  securities: async () => (await import('./taishin-securities.js')).extractSecuritiesLines,
  // XLSX：一份 1.5KB 的合法 .xlsx 解壓後可以撐爆記憶體。**不自己掃 ZIP 判斷貴不貴**
  //（那條路被打穿四次），直接把解析關進這個子行程。
  xlsx: async () => (await import('./statement.js')).readXlsxForIsolation,
};

async function main() {
  const load = /** @type {any} */ (EXTRACTORS)[KIND];
  if (!load) throw Object.assign(new Error(`未知的解析種類：${KIND}`), { status: 500 });
  // stdin 協定（走 fd 0 一次讀完；大小已被 body parser 擋在 15MB 以內）：
  //   首行＝JSON 標頭（含 password）、換行之後＝base64 內容。
  // ⚠️ **密碼刻意不走 argv/env**（Codex #350 r1）：PDF 密碼＝身分證字號，argv 會出現在
  //    `ps` 的行程清單、env 會出現在 /proc/<pid>/environ，同機任何程式都讀得到。
  const raw = readFileSync(0, 'utf8');
  const nl = raw.indexOf('\n');
  if (nl < 0) throw Object.assign(new Error('子行程 stdin 協定錯誤：缺少標頭換行'), { status: 500 });
  const header = JSON.parse(raw.slice(0, nl));
  const PASSWORD = header.password || undefined;
  const b64 = raw.slice(nl + 1);
  const data = new Uint8Array(Buffer.from(b64, 'base64'));
  const extract = await load();
  const result = await extract(data, PASSWORD);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

// ⚠️ **不准安靜退出**（Codex #350 r1 追出來的真相，2026-08-01）：內容串流炸彈會讓 pdfjs 卡在
//    解壓——那個 promise **永不 settle**（不是 OOM）。沒有這個計時器的話事件迴圈會直接清空、
//    子行程 **code 0 什麼都不寫**就結束，父行程只看得到「沒有 stdout」，於是把「我們這邊卡住」
//    誤報成「你的檔案太貴」。留一個 ref 住的計時器讓行程活著，逾時判定收斂到父行程那一處
//   （它會 SIGKILL 並回 400 pdf_timeout）。工作一結束就清掉，正常路徑不受影響。
const keepAlive = setInterval(() => {}, 1_000);
const done = () => clearInterval(keepAlive);

// ⚠️ **抽取進行中的非同步例外不可以讓子行程自己死掉**（2026-09-02 追出來的 CI「時序 flaky」真相）：
//    pdfjs／webstreams 會非同步丟出 `ERR_INVALID_STATE: Controller is already closed`——那個錯**不屬於**
//    上面被 await 的那個 promise，於是變成未捕捉例外、行程 code 1 自己結束。父行程看到的是
//    「沒有 stdout、又不是資源上限」⇒ 回 500「伺服器暫時無法解析」。
//    後果：**同一份攻擊檔，使用者有時看到誠實的「解析太久」、有時看到「伺服器壞了」**，
//    而且會在伺服器日誌留下看起來像我們程式壞掉的紀錄。
//    ⇒ 這裡只做兩件事：**留痕**（stderr 會被父行程收進 detail、進伺服器日誌）、**不改變結論**。
//    逾時判定仍然收斂在父行程那一處，跟 keepAlive 是同一個設計。
// ⚠️ 誠實劃界：這等於**吞掉**非同步例外。代價是「真的當掉」也會變成等到逾時才回答（不是立刻 500）。
//    接受這個代價的理由：能從這條路冒出來的錯，我們本來就分不出是「卡住」還是「壞了」——
//    分不出的時候不可以猜；抽取器自己丟的錯走的是被 await 的那條路，不受影響。
const onAsyncFault = (/** @type {any} */ e) => {
  try { process.stderr.write(`[pdf-child] 非同步例外（不改變結論，交給父行程判定）：${String(e?.stack || e).slice(0, 1500)}\n`); }
  catch { /* 連 stderr 都寫不出去也不能因此死掉 */ }
};
process.on('uncaughtException', onAsyncFault);
process.on('unhandledRejection', onAsyncFault);

main().then(done).catch((e) => {
  // ⚠️ 錯誤要**原味帶回父行程**：抽取器丟的是使用者看得懂的中文訊息＋status 400
  //    （「PDF 密碼錯誤」「頁數超過上限」…）。在這裡吞掉或改寫，使用者就會看到
  //    「伺服器錯誤」而不是「密碼錯了」——那是這一層最容易搞砸的地方。
  // ⚠️ **沒有 status 的例外＝我們的程式問題，預設 500**（Codex #350 r2 Medium）：
  //    原本預設 400 會把「stdin 協定壞掉／相依載入失敗」這類內部錯誤說成使用者的檔案有問題。
  //    抽取器丟的使用者層錯誤本來就會自己帶 status 400（密碼錯、頁數超標…），不受影響。
  const status = Number(e?.status) || 500;
  process.stdout.write(JSON.stringify({
    ok: false,
    message: status >= 500 ? `伺服器暫時無法解析${KIND === 'xlsx' ? 'Excel 檔' : 'PDF'}，請稍後再試` : String(e?.message || e),
    status,
    code: e?.code || (status >= 500 ? 'pdf_child_internal_error' : null),
    ...(status >= 500 ? { detail: String(e?.message || e).slice(0, 300) } : {}),
  }));
  done();   // ⚠️ 先寫 stdout 再放掉 keepAlive：順序反過來的話，兩者之間冒出的例外會讓行程沒輸出就結束
});
