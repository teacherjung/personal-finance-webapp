// @ts-check
// 假子行程⑧：**回報自己的命令列與環境變數裡有沒有出現「考題這一題用到的任何一個假密碼」**
//            ——給「PDF 密碼不可進 argv／env」那一題用。
//
// 為什麼要有這支（2026-09-25 全庫稽核實測）：那一題原本是**搜父行程的原始碼字面**，
// 只認 `password` 這個字。實測把密碼換個變數名塞進 spawn 的參數，**39 題全綠、exit 0**，
// 而 `ps -A -o args=` 真的讀到明碼。更根本的是：父行程的 spawn **沒有給 `env` 選項**，
// 子行程整份環境變數是**繼承**的——原本那條 `/env\s*:\s*\{[^}]*password/` 連
// 「先寫進 process.env 再 spawn」都搜不到。⇒ 改成**量真的**。
//
// ⚠️ **為什麼要搜「一整組」而不是只搜這一輪的密碼**（審查者 r1 #1，阻擋級）：
//    上一版只搜 `header.password`（本輪那一個）。他的突變＝父行程把**上一輪**的密碼
//    放進本輪的 argv（stdin 仍傳本輪的），**40 題全綠、exit 0**；放進 env 也一樣全綠。
//    那正是本題宣稱要守的同一個面，不是另一種外流管道。
//    ⇒ 需要搜的集合＝**考題這一題會用到的每一個假密碼**（本支每一輪都搜全部，
//      不只「已經送過的」——比 r1 要求的更嚴，連「還沒送就先洩」也會紅）。
//
// ⚠️ **那一組怎麼進來**（三條路都不行，只剩檔案）：
//    ・env ⇒ 密碼就真的在自己的 env 裡了，量測整個作廢。
//    ・argv ⇒ argv 正是被量的那一面。
//    ・stdin ⇒ 首行標頭的形狀由**正式程式**決定，不能為了考題改它。
//    ⇒ 考題把整組寫進一個暫存檔、**只把路徑**放進 `PDF_ECHO_NEEDLES`（路徑不是機密），
//      本支讀那個檔。那些字串是考題自己造的假密碼，考題跑完會刪掉那個檔。
//
// ⚠️ **刻意不回傳任何環境變數的值、也不回傳整條命令列**（審查者 r1 #2）：
//    失敗訊息會進 CI 的公開日誌。回傳的只有**索引、鍵名、布林**這種去內容的診斷。
//    密碼本身只回**完整** SHA-256（Codex r3 #2：這裡原本寫「前 16 碼」，跟程式不一樣了），
//    讓父端證明「原封不動到了」而不必看到它。
//
// ⚠️ **正對照都在這支裡面**：`canaryInEnvValues`（`PDF_ECHO_CANARY` 的值一定在 env 裡，
//    所以必須命中——否則代表搜尋根本沒在跑）、`searched`（實際走過幾個 needle）。
//    少了它們，一支永遠回空陣列的壞替身會讓那一題永遠綠。
import { readFileSync } from 'node:fs';
import { stdout, env, argv, execArgv, argv0 } from 'node:process';
import { createHash } from 'node:crypto';

// 首行＝JSON 標頭（含 password），換行之後＝base64 內容；照正式協定讀，不然父行程會 EPIPE。
let header = /** @type {{password?: string}} */ ({});
try {
  const raw = readFileSync(0, 'utf8');
  const nl = raw.indexOf('\n');
  if (nl > 0) header = JSON.parse(raw.slice(0, nl));
} catch { /* 父行程先關 stdin 也無所謂——下面照樣回報 */ }

/** 考題這一題用到的全部假密碼（一行一個，**每一輪都搜全部**，不只已經送過的）。讀不到就是空陣列——父端的數量斷言會紅。 @type {string[]} */
let needles = [];
try {
  needles = readFileSync(String(env.PDF_ECHO_NEEDLES || ''), 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch { /* 路徑沒給或讀不到 ⇒ needles 留空 ⇒ 父端 searched/needleCount 斷言會紅 */ }

// ⚠️ **`process.argv` 不含 node 自己的旗標**（`--max-old-space-size=…` 在 `execArgv`）：
//    只看 argv 的話，把密碼塞進旗標位置（`--title=<密碼>` 是合法 node 旗標）
//    會在 `ps` 裡看得見、而量測看不見。
// ⚠️ **`process.argv0` 也要**（Codex r3 #1，阻擋級）：Node 把**原始的 argv[0]** 另外存在
//    `process.argv0`；`process.argv[0]` 放的是執行檔路徑，**不是**父端指定的那個值。
//    父端只要在現有的 spawn 選項加 `argv0: 密碼`，`ps -p <pid> -o args=` 就讀得到它，
//    而 `argv` ∪ `execArgv` **兩個都不含**——他實測整檔連續兩次 40/40、exit 0（假綠）。
//    這是**父端 spawn 指定的 argv 交付面**上的一個沒被觀察到的位置，不是新的外流管道。
const 命令列 = [String(argv0), ...argv, ...execArgv];
// ⚠️ 再一層更接近真相的：**作業系統實際看到的那一行**。Linux（CI 跑的就是）讀得到
//    `/proc/self/cmdline`；macOS 沒有 /proc，讀不到就回 null 並說明原因——**不假裝讀到了**。
let osCmdline = null;
let osCmdlineWhy = '';
try {
  osCmdline = readFileSync('/proc/self/cmdline', 'utf8').split('\0').join(' ').trim();
  if (!osCmdline) { osCmdlineWhy = '/proc/self/cmdline 讀到空字串'; osCmdline = null; }
} catch (e) { osCmdlineWhy = `讀不到 /proc/self/cmdline（${String((e && /** @type {any} */ (e).code) || e)}）——非 Linux 平台是正常的`; }

/** 值裡含 s 的環境變數鍵名（s 是空字串就回空陣列——不然會命中全部）。 @param {string} s */
const keysWhoseValueHas = (s) => (s ? Object.keys(env).filter((k) => String(env[k]).includes(s)) : []);

// ⚠️ **鍵名本身就是密碼時不可以把鍵名回傳出去**（Grok 複審後掃 §2）：
//    `envValueHits` 原本一律回 `{i, key}`，而「把密碼當成環境變數鍵名、值裡也含它」
//    的形狀會讓那個鍵名（＝密碼本身）被父端 `JSON.stringify` 印進公開的測試日誌。
//    ⇒ 鍵名含任何一個 needle 就只回 `{i, keyRedacted: true}`。
/** 這個鍵名可以印嗎（不含任何一個 needle 才可以）。 @param {string} k */
const 鍵名可印 = (k) => !needles.some((n) => n && k.includes(n));
/** @type {{i: number, at: number}[]} */ const argvHits = [];
/** @type {{i: number, key?: string, keyRedacted?: boolean}[]} */ const envValueHits = [];
/** @type {{i: number}[]} */ const envKeyHits = [];
/** @type {{i: number}[]} */ const osHits = [];
let searched = 0;
needles.forEach((n, i) => {
  searched += 1;
  命令列.forEach((a, at) => { if (a.includes(n)) argvHits.push({ i, at }); });
  for (const key of keysWhoseValueHas(n)) {
    envValueHits.push(鍵名可印(key) ? { i, key } : { i, keyRedacted: true });
  }
  // 鍵名命中時**只回索引不回鍵名**——那個鍵名就是密碼本身。
  if (Object.keys(env).some((k) => k.includes(n))) envKeyHits.push({ i });
  if (osCmdline !== null && osCmdline.includes(n)) osHits.push({ i });
});

const canary = String(env.PDF_ECHO_CANARY || '');
stdout.write(JSON.stringify({
  ok: true,
  result: {
    argvLen: 命令列.length,
    envCount: Object.keys(env).length,
    needleCount: needles.length,
    searched,
    argvHits,
    envValueHits,
    envKeyHits,
    osHits,
    osAvailable: osCmdline !== null,
    osCmdlineWhy,
    // 正對照：`PDF_ECHO_CANARY` 的值一定在 env 裡 ⇒ 必須非空
    // 同一條規則：鍵名含 needle 的不回傳（`PDF_ECHO_CANARY` 這個固定鍵名不含，所以正對照不受影響）。
    canaryInEnvValues: keysWhoseValueHas(canary).filter(鍵名可印),
    // 這一輪 stdin 標頭真的收到什麼（只回雜湊，不回值）
    // ⚠️ **完整 SHA-256，不截斷**（Grok 複審後掃 §3）：前 16 個十六進位字＝只有 64 bit，
    //    前綴相同仍可以是兩條不同的字串，撐不起「原封不動」那句話。
    headerSha: header.password ? createHash('sha256').update(String(header.password)).digest('hex') : '',
    // 作業系統那一行**有沒有含本行程的任何一個參數**（父端用來確認讀到的是這個行程的）。
    // ⚠️ Codex r2 #1：上一版註解寫「含本輪的 kind」——**跟程式不一樣**，`some()` 是
    //    「**`命令列` 裡任一項**（＝`argv0` ∪ `argv` ∪ `execArgv`）出現在 OS 命令列裡」就算。
    //    ⚠️ Codex r4 #1：`argv0` 加進來之後這句只寫 argv／execArgv 就又變成假話了，已補。
    osHasArg: osCmdline !== null ? 命令列.some((a) => osCmdline !== null && osCmdline.includes(a)) : null,
  },
}));
