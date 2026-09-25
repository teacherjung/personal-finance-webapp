// @ts-check
// 假子行程⑧：**把自己的 argv 與環境變數「有沒有含密碼」回報回去**——給「PDF 密碼不可進 argv／env」那一題用。
//
// 為什麼要有這支（2026-09-25 全庫稽核實測）：那一題原本是**搜父行程的原始碼字面**，
// 只認 `password` 這個字。實測把密碼換個變數名塞進 spawn 的參數，**39 題全綠、exit 0**，
// 而 `ps -A -o args=` 真的讀到明碼（PDF 密碼＝身分證字號）。字面絆線只擋「照原樣寫」的人。
// 更根本的是：父行程的 spawn **沒有給 `env` 選項**，子行程整份環境變數是**繼承**的
// ——原本那條 `/env\s*:\s*\{[^}]*password/` 連「先寫進 process.env 再 spawn」都搜不到。
//
// 這支改成**量真的**：由子行程自己看它實際拿到的 `argv` 與 `env`。
//
// ⚠️ **刻意不把密碼或任何環境變數的值吐回來**（吐回來本身就是這一題在防的那種洩漏）：
//   ・`argv` 逐字回傳——它的內容是 `[node, --max-old-space-size=N, <腳本>, <種類>]`，本來就不含祕密。
//   ・環境變數只回傳**命中的鍵名**與**總筆數**，不回傳任何值。
//   ・密碼本身只回傳 SHA-256 前 16 碼與長度，讓父端證明「它真的原封不動到了」而不必看到它。
//
// ⚠️ **正對照在這支裡面**：它同時搜 `PDF_ECHO_CANARY` 這個變數的值。那個值一定在 env 裡，
//    所以 `canaryInEnvValues` 必須至少命中一筆——否則代表這支的搜尋根本沒在跑（空包彈），
//    而不是「乾淨」。少了它，一支永遠回空陣列的壞替身會讓那一題永遠綠。
import { readFileSync } from 'node:fs';
import { stdout, env, argv, execArgv, pid } from 'node:process';
import { createHash } from 'node:crypto';

// 首行＝JSON 標頭（含 password），換行之後＝base64 內容；照正式協定讀，不然父行程會 EPIPE。
let header = /** @type {{password?: string}} */ ({});
try {
  const raw = readFileSync(0, 'utf8');
  const nl = raw.indexOf('\n');
  if (nl > 0) header = JSON.parse(raw.slice(0, nl));
} catch { /* 父行程先關 stdin 也無所謂——下面照樣回報 argv／env */ }

const needle = String(header.password || '');
const canary = String(env.PDF_ECHO_CANARY || '');
/** 回傳「值裡含 s」的環境變數鍵名（s 是空字串就回空陣列——不然會命中全部）。 @param {string} s */
const keysWhoseValueHas = (s) => (s ? Object.keys(env).filter((k) => String(env[k]).includes(s)) : []);

// ⚠️ **`process.argv` 不含 node 自己的旗標**（`--max-old-space-size=…` 在 `execArgv`）：
//    只看 argv 的話，把密碼塞進旗標位置（例如 `--title=<密碼>`，那是合法的 node 旗標）
//    會在 `ps` 裡看得見、而量測看不見。⇒ 兩個都回報。
// ⚠️ 還有一層更接近真相的：**作業系統實際看到的那一行**。Linux（CI 跑的就是）讀得到
//    `/proc/self/cmdline`；macOS 沒有 /proc，讀不到就回 null 並說明原因——
//    **不假裝讀到了**（讀不到時父端只會少掉這一層對照，不會靜靜當成乾淨）。
let osCmdline = null;
let osCmdlineWhy = '';
try {
  osCmdline = readFileSync('/proc/self/cmdline', 'utf8').split('\0').join(' ').trim();
  if (!osCmdline) { osCmdlineWhy = '/proc/self/cmdline 讀到空字串'; osCmdline = null; }
} catch (e) { osCmdlineWhy = `讀不到 /proc/self/cmdline（${String(e && e.code || e)}）——非 Linux 平台是正常的`; }

stdout.write(JSON.stringify({
  ok: true,
  result: {
    argv: [...argv],
    execArgv: [...execArgv],
    osCmdline,
    osCmdlineWhy,
    pid,
    envCount: Object.keys(env).length,
    needleInEnvValues: keysWhoseValueHas(needle),
    needleInEnvKeys: needle ? Object.keys(env).filter((k) => k.includes(needle)) : [],
    canaryInEnvValues: keysWhoseValueHas(canary),   // 正對照：必須非空
    needleLen: needle.length,
    needleSha: needle ? createHash('sha256').update(needle).digest('hex').slice(0, 16) : '',
  },
}));
