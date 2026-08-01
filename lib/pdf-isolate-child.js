// @ts-check
// **PDF 抽取的子行程入口**（只有 HOSTED 會用到；LOCAL 直接在行程內跑）。
//
// 為什麼要有這個檔（不是 `-e` 字串）：這個 repo 的路徑含**空白與中文**，
// 把腳本塞進 `-e` 再拼模組路徑很容易在引號／百分號編碼上出錯。
// 獨立檔案讓 `import` 走相對路徑，完全不必處理路徑跳脫。
//
// 協定（刻意做到最笨、最好除錯）：
//   父 → 子：argv[2] ＝ 種類；stdin ＝ base64 的 PDF 位元組；argv[3] ＝ 密碼（可空）
//   子 → 父：stdout ＝ 一行 JSON。`{ok:true, lines}` 或 `{ok:false, message, status}`
//   子行程**被資源上限打死時不會有 stdout**——父行程據此判斷「這份檔案太貴」。
import { readFileSync } from 'node:fs';

const KIND = process.argv[2] || '';

/** 三種抽取器。**新增種類時這裡與 `lib/pdf-isolate.js` 的 KINDS 要一起改**（有考題盯著）。 */
const EXTRACTORS = {
  statement: async () => (await import('./statement.js')).extractLinesForIsolation,
  bank: async () => (await import('./bank-statement.js')).extractBankLines,
  securities: async () => (await import('./taishin-securities.js')).extractSecuritiesLines,
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
  const lines = await extract(data, PASSWORD);
  process.stdout.write(JSON.stringify({ ok: true, lines }));
}

main().catch((e) => {
  // ⚠️ 錯誤要**原味帶回父行程**：抽取器丟的是使用者看得懂的中文訊息＋status 400
  //    （「PDF 密碼錯誤」「頁數超過上限」…）。在這裡吞掉或改寫，使用者就會看到
  //    「伺服器錯誤」而不是「密碼錯了」——那是這一層最容易搞砸的地方。
  process.stdout.write(JSON.stringify({
    ok: false,
    message: String(e?.message || e),
    status: Number(e?.status) || 400,
    code: e?.code || null,
  }));
});
