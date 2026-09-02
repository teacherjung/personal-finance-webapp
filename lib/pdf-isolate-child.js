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
  process.stdout.write(JSON.stringify({ ok: true, result, diag: await takeDiag() }));
}

// ⚠️ **不准安靜退出**：沒有這個計時器的話，「工作停住但沒有任何 handle 撐著」會讓事件迴圈直接
//    清空、子行程 **code 0 什麼都不寫**就結束——父行程只看得到「沒有 stdout」。留一個 ref 住的
//    計時器讓行程活著，逾時判定收斂到父行程那一處（它會 SIGKILL 並回 400 `pdf_timeout`）。
//    工作一結束就清掉，正常路徑不受影響。
//
// ⚠️ **它防的是「未知」，已知的那一個已在源頭修掉（2026-08-29 更正）**：這段原本寫
//    「內容串流炸彈會讓 pdfjs 卡在解壓、promise 永不 settle」——2026-08-01 看到的那個
//    「1.4 秒 code 0 靜默退出」不是 pdfjs 的脾氣，是 `lib/parse-limits.js` 的 `cancelStream`
//    少帶一個 `Error` 理由（取消從沒生效、pdfjs 的生產端永遠等下去）。
//    ⚠️ 所以這個計時器**沒有考題能證明它現在還擋得住什麼**（已知的觸發條件不存在了）：
//    它是保險，不是保證。**真正有考題釘住的是父行程那一側**——安靜退出一律 500、
//    不可以猜成使用者的檔案太貴（`test/pdf-isolate.test.js` 的「歸類｜…安靜退出」）。
/** 取走解析過程的診斷代碼（封閉集合、不含任何內容）。載入失敗時回空陣列——診斷不可以蓋掉本體。 */
async function takeDiag() {
  try { return (await import('./parse-limits.js')).drainParseDiag(); } catch { return []; }
}

const keepAlive = setInterval(() => {}, 1_000);
const done = () => clearInterval(keepAlive);

main().then(done).catch(async (e) => {
  done();
  // ⚠️ 錯誤要**原味帶回父行程**：抽取器丟的是使用者看得懂的中文訊息＋status 400
  //    （「PDF 密碼錯誤」「頁數超過上限」…）。在這裡吞掉或改寫，使用者就會看到
  //    「伺服器錯誤」而不是「密碼錯了」——那是這一層最容易搞砸的地方。
  // ⚠️ **沒有 status 的例外＝我們的程式問題，預設 500**（Codex #350 r2 Medium）：
  //    原本預設 400 會把「stdin 協定壞掉／相依載入失敗」這類內部錯誤說成使用者的檔案有問題。
  //    抽取器丟的使用者層錯誤本來就會自己帶 status 400（密碼錯、頁數超標…），不受影響。
  const status = Number(e?.status) || 500;
  process.stdout.write(JSON.stringify({
    ok: false,
    // ⚠️ 診斷代碼＝**封閉集合、零內容**（見 lib/parse-limits.js 的 PARSE_DIAG）：
    //    子行程的 stderr 不會進父行程日誌，取消失敗這種「原錯照樣回得去」的狀況因此在
    //    HOSTED 完全靜默。這個欄位是它唯一的出聲管道，所以**成功與失敗兩條路都要帶**。
    diag: await takeDiag(),
    message: status >= 500 ? `伺服器暫時無法解析${KIND === 'xlsx' ? 'Excel 檔' : 'PDF'}，請稍後再試` : String(e?.message || e),
    status,
    code: e?.code || (status >= 500 ? 'pdf_child_internal_error' : null),
    ...(status >= 500 ? { detail: String(e?.message || e).slice(0, 300) } : {}),
  }));
});
