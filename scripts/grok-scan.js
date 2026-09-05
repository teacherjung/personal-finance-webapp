#!/usr/bin/env node
// @ts-check
// **Grok 複審後掃：一支到底**（William 2026-08-22 裁示 B＋中間路；r1 重做：Codex 抓到四種假成功）。
//
// 把整條流程串成一支，讓「忘了某一步」變成做不到：
//   ①建盒子（git archive 已 commit 的原始碼＋APFS clone 的 node_modules；沒有 data/store.db、沒有 .env）
//   ②金絲雀（沙箱的紅燈證明；任何一隻活著＝不掃，fail-closed）
//   ③起轉送器（localhost 隨機 port → xAI 那一個寫死的位址；只轉白名單形狀、只認本掃的假值），**並持續監看它有沒有死**
//   ④在沙箱裡跑 grok（env 白名單、HOME／TMPDIR／GROK_HOME 全指進盒子；盒內 auth 的 key 是**每掃隨機的假值**，轉送器在沙箱外換真的；
//     ulimit 包著：單檔大小／程序數／CPU 秒；結束後 SIGKILL 整個程序群組、再 lsof 掃蕩離開群組的）
//   ⑤驗屍：sessions **單趟**讀進記憶體（no-follow＋檔數／深度／單檔／總量上限）→ 數足跡＋查破口線索＋比對 DLP 針
//     → 乾淨才寫進盒外的結果包。讀過的 bytes 就是存的 bytes（沒有第二次讀＝沒有 TOCTOU 窗）。
//
// ## fail-closed（r1 之後每一步都有）
//   grok 版本不符／金絲雀非 0／轉送器沒 READY 或中途死／grok 退出碼非 0 或 null／零 session／日誌讀不清楚／
//   node_modules 複製後不是真目錄／盒子裡出現不該有的檔／sessions 超過上限／DLP 真相來源讀不到 ⇒ 一律退 2，**不退 0**。
//   第一版在這些情況全部退 0（Codex r1 實測 `allSessionDirs('/no/such')` 直接走到 exit 0）。
//
// ## 用法
//   node scripts/grok-scan.js --base <sha> --head <sha> --prompt <指示檔> [--out <輸出檔>]
//
// 退出碼：0＝掃完、驗屍乾淨／1＝驗屍查到破口線索（**沙箱破了＝事故**，回報 William）／2＝沒掃成（fail-closed）。
//
// ## 誠實劃界
// ・盒子裡放的是**已 commit** 的內容；未 commit 的改動它看不到（條款本來就這樣）。
// ・轉送器擋不住「把資料 POST 給 xAI」；真正的保護是它讀不到可以送的東西（grok-sandbox.sb 的劃界）。
// ・第⑤步的破口線索是 **heuristic**：只證明「它沒讀到那一個暗號檔」與「日誌裡沒有那幾種明文」，
//   不證明沙箱完整。沙箱有效的證明在第②步的金絲雀，不在這裡。
// ・setsid 在 Seatbelt 擋不住（實測：deny syscall-unix 147 無效；82＝setpgid 擋得住但 grok 的工具靠它起子行程、擋了就跑不了指令，所以也不擋）。
//   「程序群組已全部收束」**不是**本腳本的保證；
//   保證的是離開群組的程序**無害**：它的沙箱只准連本掃的隨機 port（下一掃換 port＝連不到）、**沒有 DNS**（r15 拿掉 mDNSResponder socket；
//   之前查詢名本身就是外送通道——Grok 第一次正式掃描抓到、Codex 十四輪沒看到）、只認本掃的假值、
//   只能讀寫已被刪掉的盒子路徑；父程序讀 sessions 是單趟＋上限，它改檔只會讓本掃 fail-closed，改不了結果包。
//   另加 lsof 掃蕩（best-effort，找 cwd／txt 在盒內的程序殺掉並記數）。
// ・資源上限是 ulimit（單檔 64MB、程序數＝啟動時同 uid 程序數＋256、CPU 1800 秒）＋父程序讀 sessions 的上限；
//   **沒有總磁碟配額**（/private/tmp 沒有 quota）——盒內程式寫很多個 64MB 檔仍能塞滿磁碟，那會讓本掃退 2，不會讓它拿到什麼。
// ・本腳本不決定掃描時機（條款：Codex 通過之後、gh pr ready 之前）；它只負責「掃的時候有圍欄」。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync, chmodSync, openSync, fstatSync, readSync, closeSync, constants as fsConst } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCanary, sandboxEnv, PROFILE, RELAY_PORT, BOX_ROOT } from './grok-sandbox-canary.js';
import { auditSessionDir, allSessionDirs } from './audit-grok-scan.js';
import { gitEnv } from '../lib/git-env.js';
import { refreshSandboxAuth, authNeedles } from './grok-auth-refresh.js';
import { REFUSED_PREFIX, TOLERATED_REFUSALS } from './grok-relay.js';
import { isMainModule } from '../lib/is-main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
/** 轉送器的目的地是從這個版本的執行檔 strings 出來的；版本不同＝當未跑（條款）。**精確比對**，不用前綴（r2：前綴讓 wrapper 印一行就過） */
export const EXPECTED_GROK_VERSION = '1.0.13';
/**
 * 釘住執行檔本身（r4 #5：版本字串是被檢者自己印的，wrapper 印「grok 1.0.3」就過；而且 r3 版在**沙箱外**執行它）。
 * 流程：cp 真執行檔進盒子 → 對**盒內副本**算 sha256 → 不等於這個值＝不掃 → `--version` 在**沙箱內**對盒內副本跑。
 * 沒有任何未驗的 grok 在沙箱外執行過。升版＝改這行＋重驗轉送器目的地。
 * 1.0.13（2026-09-05，grok CLI 自動升版後 fail-closed 擋下 #563 的掃描）：重驗＝`strings` 新舊執行檔的主機／路徑——上游仍是
 * cli-chat-proxy.grok.com/v1、沒有新的 grok.com 主機、/v1/responses 仍在（逐項清單在 PR #564）；其餘新字串不逐一判讀——沙箱只准 localhost、
 * 轉送器只轉白名單形狀，執行檔多了什麼外連字串都到不了。釘值本身由 test/grok-scan-flow.test.js 的獨立 fixture 釘住（改常數要連考題一起改）。
 */
export const EXPECTED_GROK_SHA256 = '8669e0fdadceec25b8c159c355f427ffbd82583525d774b6ab1522197ea83b80';
export { RELAY_PORT };
/** macOS 的 cp -c＝APFS copy-on-write clone（node_modules 1.4 秒、不占空間）；GNU cp 沒有 -c——CI 的 Linux 只跑金絲雀之前的 fail-closed 路徑，普通 cp 就好 */
const CP_CLONE = process.platform === 'darwin' ? ['-c'] : [];

/** sessions 單趟讀取的上限（r6 #3）：超過任何一項＝退 2、不保存 */
export const SESSION_CAPS = Object.freeze({ files: 4000, depth: 12, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });

/**
 * 破口線索的**形狀**（活金絲雀的暗號不在裡面，刻意的）。
 * 為什麼跟暗號分開跑：下面「已在給盒子的東西裡就不算」那道排除只作用在形狀上。
 * 暗號每掃現生、不在任何材料也不在任何 commit 裡；併進同一條 alternative 就等於讓排除有機會碰到它——
 * 分成兩族是構造上的隔離，不是靠註解承諾。
 */
/**
 * 同一份內容在 grok 的日誌裡可能被 JSON 字串**包過幾層**（session 檔是 JSONL，內容裡還會再嵌 JSON），
 * 所以有三種寫法：原文、轉一層、轉兩層。樹側排除、材料側排除、破口正則的引號原子都用這一支
 * ——**用同一把尺是這支函式存在的理由**：偵測側與排除側若各自寫階梯，同一份內容會算出對不上的字串＝假事故。
 * ⚠️ 深度到 2 為止是**觀察值不是定理**：更深的包法兩側都認不得，方向是漏報。
 */
const jsonEscOnce = (/** @type {string} */ s) => JSON.stringify(s).slice(1, -1);
export const escapeForms = (/** @type {string} */ s) => { const out = [s]; while (out.length < 3) out.push(jsonEscOnce(out[out.length - 1])); return out; };

/** 正則字面轉義（把一段文字當字面塞進正則） */
const reLit = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 「任一轉義深度的雙引號」。**用 escapeForms 疊出來、不手打**——手打就會跟排除側的階梯各自漂。
 * ⚠️ 這裡**不排序**分支：三種寫法分別要求 0／1／3 個反斜線後接引號 ⇒ 在任一位置互斥
 *   （沒有誰是誰的前綴），所以 alternation 取哪一個成功分支結果都一樣。
 */
const Q = `(?:${escapeForms('"').map(reLit).join('|')})`;

/**
 * ⚠️ flexToken 那條腿為什麼長這樣（2026-08-31 修的一個**靜靜放過**）：
 *   舊寫法是 `flexToken"\s*:\s*"[^"]{8,}`，要求 `flexToken` 後面緊跟一個**字面**的 `"`。
 *   但它掃的日誌是 JSONL，那裡的 `"` 是 `\"` ⇒ **真的 flexToken 外洩到日誌裡，這條腿一條都認不得**
 *   （實測：深度 0 命中、深度 1／2 都是 0）。私鑰那條腿的字元類含 `\s` 與 `\\`，僥倖躲過同一個病。
 * ⚠️ 值那格 `(?:(?!Q|\\n)[^"\n]){8,}` 的兩個排除**各有理由，不是防禦性複製**：
 *   ・`(?!Q)`＝遇到任一深度的引號就停 ⇒ 命中**逐字結束在值本身**，不夾帶轉義殘渣。
 *   ・`[^"\n]` 與 `(?!\\n)`＝**不跨行**（連轉義形的兩字元 `\n` 也不跨）。這一格是防假事故的關鍵：
 *     值沒有收尾引號時（散文、表格、註解、grep 只列命中行——這個 repo 天天在寫的東西），
 *     沒有這一格的話命中會一路吃到「下一個引號」為止＝**長度由上下文決定、不由內容決定**，
 *     於是同一段無害文字在材料裡與在日誌裡算出不同字串、排除對不上 ⇒ 假事故。
 *     有了行界，同一段內容的命中就**不隨後文改變**。（量到的長度數字留在 PR／commit，不寫進這裡：
 *     它會隨夾具長度漂，而沒有任何考題會因為它過期而轉紅。）
 *   代價：跨行的值認不得（方向是漏報，照實寫在這裡）。
 * ⚠️ **這條腿只涵蓋「被 JSON 序列化過」的那一種呈現**，射程到此為止。以下**認不得**：
 *   ・`util.inspect`／`console.log` 印出來的 JS 物件（`flexToken: 'xxx'`——單引號、鍵沒引號）＝**靜靜放過**；
 *   ・ANSI 逸出序列插進鍵與引號之間（上色輸出會這樣）破壞「相鄰」＝**靜靜放過**；
 *   ・非 UTF-8 的 session 檔**不進比對**——這一條不是無聲：略過幾個檔會印出來，而且不會讓掃描失敗
 *     （＝紀錄看得到、但那幾個檔的內容沒有被查過）。
 *   `flexToken` 不在 DLP 針裡（針只取自沙箱 auth.json），所以前兩條沒有第二道網。要收得換成
 *   「比對真值」而不是「比對形狀」的判準——那是另一支的事，本支不宣稱修掉它們。
 */
export const BREACH_SHAPES = `flexToken${Q}\\s*:\\s*${Q}(?:(?!${Q}|\\\\n)[^"\\n]){8,}|BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----[\\s\\\\]*[A-Za-z0-9+/=\\s\\\\]{32,}`;

/**
 * 破口形狀的命中**含位置**。位置是給事故指紋用的（要從同一份文字上切出上下文視窗）。
 * @param {string} text
 * @returns {{ hit: string, index: number }[]}
 */
export const shapeMatchesIn = (text) => [...text.matchAll(new RegExp(BREACH_SHAPES, 'g'))].map((m) => ({ hit: m[0], index: m.index ?? 0 }));

/** @param {string} text */
export const shapeHitsIn = (text) => shapeMatchesIn(text).map((m) => m.hit);

/**
 * 命中的**字元組成**（不含內容）。事故時寫進指紋包。
 *
 * 承重的欄位是 `maxB64Run`＝最長一段連續的 base64 字元，用來分辨程式自己承認的那個誤報族：
 * 私鑰那條腿的字元類含 `\s` 與 `\\`，所以「標頭＋32 個空白」也算命中，而那種命中裡最長的
 * b64 片段只有標頭裡的單字長度（個位數），真鑰匙的 body 是幾十個字元一行。
 * ⚠️ 我第一版寫的是「`b64 === 0` 就證明不含鑰匙內容」——**那是錯的**：標頭本身的字母就是
 * b64 字元，總數永遠不會是 0。所以承重的是「最長連續片段」，不是總數。
 * ⚠️ 反向不成立：`maxB64Run` 大**不代表**是真外洩（真假鑰匙的 body 都是 base64）。
 * 這一格只否證一個方向，不肯定另一個方向。
 * @param {string} h
 */
export const hitProfile = (h) => {
  const p = { b64: 0, ws: 0, backslash: 0, other: 0, maxB64Run: 0 };
  let run = 0;
  for (const c of h) {
    if (/[A-Za-z0-9+/=]/.test(c)) { p.b64++; run++; if (run > p.maxB64Run) p.maxB64Run = run; continue; }
    run = 0;
    if (/\s/.test(c)) p.ws++;
    else if (c === '\\') p.backslash++;
    else p.other++;
  }
  return p;
};

/**
 * 這條命中**最像**排除集合裡的哪一條（只回數字與來源標籤，不回內容）。
 *
 * 為什麼有用：假事故的典型長相是「同一份內容換了呈現」（中段截斷、包裝、轉義），
 * 那種命中會跟排除集合裡某一條共用很長的前綴；真外洩則只共用標頭。
 * ⚠️ **排除集合是空的時候這一格什麼都答不出來**（`prefixLen` 0、`source` null）——
 * #534 就是這種情形（受掃樹裡一條字面假鑰都沒有）。這是它的射程，不是它壞了。
 * @param {string} h
 * @param {Iterable<string>} known
 * @param {string} materials
 */
export const nearestKnown = (h, known, materials) => {
  let best = { source: /** @type {string | null} */ (null), prefixLen: 0, suffixLen: 0 };
  for (const k of known) {
    let p = 0; while (p < h.length && p < k.length && h[p] === k[p]) p++;
    let q = 0; while (q < h.length && q < k.length && h[h.length - 1 - q] === k[k.length - 1 - q]) q++;
    if (p > best.prefixLen || (p === best.prefixLen && q > best.suffixLen)) best = { source: 'known', prefixLen: p, suffixLen: q };
  }
  // 材料那半：二分找「最長的、材料裡出現過的前綴」。材料是 MB 級，所以不做無界比對。
  let lo = 0, hi = h.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (materials.includes(h.slice(0, mid))) lo = mid; else hi = mid - 1; }
  return { ...best, inMaterialsPrefixLen: lo, hitLen: h.length };
};

/**
 * 命中周圍的一小段上下文，**命中本身換成佔位符**（William 2026-08-31 裁示：留，但只留一小段）。
 *
 * 為什麼要留：#534 那次四條命中有兩條在 grok 的**回覆**裡，而回覆沒有「哪一條指令產生的」可以追、
 * 重跑也補不回來（模型每次寫的字不一樣）。指紋（長度／雜湊／相似度）在那種情形下判不出真假；
 * 旁邊那句話（「例如…這是我編的示範」vs 真的檔案內容）才判得出來。
 * ⚠️ **誠實劃界——這一格會把盒外內容多留一份在磁碟上**：視窗裡若有我們**認得**的機密
 * （DLP 針、本輪暗號）會被遮掉，但**認不得的擋不住**（別的服務的 token、別種格式的鑰匙）。
 * 真破口時那一小段就是盒外讀到的東西。William 明示接受這個取捨；檔案是 0600、只在本機、不上 GitHub。
 * ⚠️ 遮的**不只是自己那一條**：視窗裡若還有別的形狀命中（兩條靠得近時一定會互相入鏡），
 *   那一條也要遮掉——否則 A 的視窗把 B 的原文完整帶出去，等於沒遮。
 * ⚠️ **在原文上算區間，不是先切窗再替換**（Codex #535 r1／r2 連兩輪打在同一處）：
 *   先切後替換的話，壓在視窗邊界上的機密／命中只會留下**半截**，字串比對就對不上了。
 *   把視窗往外加寬也只是**把邊界往外移**、沒有把它關掉——新邊界上照樣切得到半截。
 *   正解是：在**整份原文**上先把所有該遮的區間找出來，凡是**與視窗相交**的區間就整段換成佔位符
 *   （即使它伸出視窗外），這樣任何邊界上都不會留下半截。
 * @param {string} text 命中所在的那份文字（剝完行號記號的那一份——比對就是在它上面做的）
 * @param {number} index 命中起點
 * @param {number} len 命中長度
 * @param {string[]} secrets 要在視窗裡遮掉的已知機密
 * @param {number} [span] 前後各留幾個字
 */
export const redactWindow = (text, index, len, secrets, span = 200) => {
  /** 該遮的區間（原文座標）：自己那一條、別的形狀命中、每一段已知機密的每一次出現 */
  const marks = [{ start: index, end: index + len, label: `‹命中 ${len} 字，內容不留›` }];
  for (const m of shapeMatchesIn(text)) {
    if (m.index === index) continue;
    marks.push({ start: m.index, end: m.index + m.hit.length, label: `‹另一條命中 ${m.hit.length} 字，內容不留›` });
  }
  for (const v of secrets) {
    if (!v) continue;
    // ⚠️ 每次前進 1 個字：機密自我重疊時要收下**每一個**起點，下面走訪時才會把它們接成一整段
    //   （只收第一個的話，剩下的殘段本身不構成完整機密、永遠掃不到——Codex #535 r3）。
    for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) marks.push({ start: i, end: i + v.length, label: '‹已遮蔽›' });
  }
  marks.sort((a, b) => a.start - b.start);
  const lo = Math.max(0, index - span), hi = Math.min(text.length, index + len + span);
  let out = '', pos = lo;
  for (const mk of marks) {
    if (mk.end <= pos) continue;        // 已經走過
    if (mk.start >= hi) break;          // 整段在視窗之外
    if (mk.start > pos) out += text.slice(pos, mk.start);
    else if (out.endsWith(mk.label)) { pos = mk.end; continue; }   // 與前一段重疊＝同一段，別重複貼記號
    out += mk.label;                    // 相交就整段換掉——即使它伸出視窗外，也不留半截
    pos = mk.end;
  }
  if (pos < hi) out += text.slice(pos, hi);
  return out;
};

/**
 * 剝掉讀檔工具插進內容裡的行號記號（`1→`、`10→`…；日誌是 JSONL，換行可能是 `\n` 或 `\\n`，所以前綴要一起認）。
 *
 * 為什麼要剝（兩個方向都受害，後者更嚴重）：
 *   ①記號落進命中區間，把同一份內容切成跟樹裡對不上的字串 ⇒ 樹裡本來就有的 fixture 排不掉＝假事故；
 *   ②`→` 不在破口正則的字元類裡：記號若落在 `{32,}` **湊滿之前**，整條就不匹配 ⇒ 真鑰匙被讀進日誌卻靜靜放行
 *     （落在已經湊滿之後則仍然命中——條件是「湊滿之前」，不是「標頭之後」）。
 * ⚠️ 誠實劃界（三條，撐不住的話寧可寫出來）：
 *   ①這是照**觀察到的**日誌呈現寫的，不是 grok 的承諾。中段截斷、markdown 包裹、`檔:行:` 前綴
 *     都還原不了，那些呈現仍會對不上（方向＝誤報事故）。
 *   ②**正文裡字面的 `\n12→` 與真的工具記號在文字層面分不出來**，這條規則會把它也剝掉。
 *     方向是「排除語言變大」＝可能少報事故——所以只剝日誌側、**不剝樹側**（樹是沒有記號的真相），
 *     兩側不會一起被正規化到同一個更寬的語言裡。真外洩要踩到它得同時滿足「內容含字面 `\n<數字>→`」
 *     與「剝完之後落進任何一條排除路」——⚠️ 那條**不只是**「逐字等於樹裡某條 fixture」：
 *     材料那半走的是 `materials.includes(h)`＝**子字串**排除，所以「剝完之後是材料裡任何一段的子字串」
 *     也算落進去。條件比只看樹寬（Codex #530 r2 抓到我把它說窄了）。這是機率論證、不是保證。
 *     考題檔裡有一格照實釘著「會被剝掉」這個行為，改行為要連同這段劃界一起改。
 *   ③`(?<!\\)` 是為了不從**反斜線串的中段**開始比對（5 個以上反斜線時 `{1,4}` 會從第 2 個起算而誤剝——Codex #530 r1 抓到）。
 * @param {string} text
 */
export const stripLineMarkers = (text) => text.replace(/(^|\n|(?<!\\)\\{1,4}n)\d{1,7}→/g, '$1');

/**
 * 從 **git 物件庫**取 head 樹的 blob，收集它們含有的破口形狀命中（含 JSON 轉義階梯）。
 *
 * ⚠️ **不是「整棵樹」**：單檔超過 `SESSION_CAPS.fileBytes` 的 blob 會跳過（三形階梯要做兩次
 * `JSON.stringify`，大檔瞬間長成數倍）。跳過＝那個檔的形狀**不進**排除集合＝萬一 grok 引用到它就會
 * 誤報事故（方向是吵、不是靜靜放行）——⚠️ 只就**樹那半**而言：同一個形狀若剛好也在材料裡，材料那半仍會排除它。
 * 跳了**幾個、前三個是誰**由回傳值帶出去、呼叫端印出來，不讓缺口悄悄發生（不是逐個列完）。
 *
 * 為什麼來源是 git 而不是磁碟上的 `<box>/src`：**盒子對 grok 是可寫的**（profile 放行整個 SCAN_DIR）。
 * 拿盒內磁碟當已知來源，破出沙箱的 grok 只要把偷到的內容寫成一個檔丟進 src，就能讓驗屍把自己的外洩
 * 登記成「本來就給它的東西」。blob 是內容定址的，盒內寫什麼都改不了這顆 SHA 的樹——這是構造保證。
 * 選這條路的另外兩個理由（**是實作理由，不是本支保證的性質——沒有行為題釘著，不要當保證引用**）：
 *   ・讀 blob 不經檔案系統，所以沒有「跟隨 symlink 讀到盒外」這條路要防（mode 120000 的 blob 內容只是一串路徑字串）；
 *   ・node_modules 不在 commit 樹裡，所以不必特判就不在集合裡。
 *
 * 失敗一律 throw（呼叫端退 2）。**不回空集合**——空集合會安靜退化成修法之前的行為。
 * ⚠️ 訊息刻意只帶 status、不併 git 的 stderr（這條路上的字串是疑似外洩的內容本身，而失敗原因會被抄進 PR 描述）
 *   ——同樣是**寫法上的自我約束、沒有行為題釘著**，改動時要自己守。
 *
 * @param {string} repo
 * @param {string} head
 * @param {number} [maxBlobBytes] 單檔上限；預設 `SESSION_CAPS.fileBytes`。**只給考題注入小門檻**——
 *   考題若要驗「跳過並說出跳了誰」，用真的 16 MiB 檔會在 CI 上配置數十 MB，而 `node --test` 是**多檔並行**跑的，
 *   實測把隔壁一支計時型考題壓過門檻（對照組：同時段重跑 main 是綠的，本支 2/2 紅）。
 *   ⚠️ 預設值本身**沒有考題釘住**：它是記憶體護欄的門檻，改小只會多跳過檔案（＝誤報方向）、改大只會多吃記憶體。
 * @returns {{ hits: Set<string>, blobs: number, bytes: number, bySource: Map<string, number>, skippedBig: string[] }}
 */
export function knownShapeHitsFromTree(repo, head, maxBlobBytes = SESSION_CAPS.fileBytes) {
  // -z：git 預設會把非 ASCII 路徑輸出成八進位轉義並加引號，拿去查就 fatal 而掃描器**靜靜跳過**
  //     ——本專案踩過的「掃描器跳過中文檔名」同一個坑。
  const ls = spawnSync('git', ['-C', repo, 'ls-tree', '-r', '-z', head], { encoding: 'utf8', maxBuffer: 1 << 28, env: gitEnv() });
  if (ls.status !== 0) throw new Error(`git ls-tree 失敗（status ${ls.status}）`);
  /** @type {{ oid: string, path: string }[]} */ const blobs = [];
  for (const rec of (ls.stdout || '').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) throw new Error('git ls-tree 輸出不是預期的形狀');
    const [, type, oid] = rec.slice(0, tab).split(' ');
    if (type === 'blob') blobs.push({ oid, path: rec.slice(tab + 1) });   // 只收 blob：submodule（gitlink）與子樹跳過
  }
  const cat = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], { input: blobs.map((b) => b.oid).join('\n') + '\n', maxBuffer: 1 << 29, env: gitEnv() });
  if (cat.status !== 0) throw new Error(`git cat-file 失敗（status ${cat.status}）`);
  const out = /** @type {Buffer} */ (cat.stdout);
  /** @type {Set<string>} */ const hits = new Set();
  /** @type {Map<string, number>} */ const bySource = new Map();
  /** @type {string[]} */ const skippedBig = [];
  let off = 0, bytes = 0, i = 0;
  while (off < out.length) {
    const nl = out.indexOf(10, off);
    if (nl < 0) break;
    const size = Number(out.toString('utf8', off, nl).split(' ')[2]);
    if (!Number.isFinite(size)) throw new Error('git cat-file --batch 的標頭不是預期的形狀');
    const start = nl + 1;
    const path = blobs[i++]?.path ?? '?';
    bytes += size;
    // 大檔跳過：三形階梯會做兩次 JSON.stringify，大檔瞬間長成數倍。跳過＝那個檔的形狀不進排除集合＝誤報方向。
    // 跳了誰要說出來（呼叫端會印）：不然「涵蓋範圍其實有缺口」就悄悄發生了。
    if (size > maxBlobBytes) skippedBig.push(path);
    else {
      // 解碼用有損模式（跟日誌側 fatal 的語意刻意不同）：二進位檔解不乾淨頂多少收一條＝誤報方向，不會多排除。
      const raw = out.toString('utf8', start, start + size);
      if (raw.includes('PRIVATE KEY-----') || raw.includes('flexToken')) {   // 廉價前置過濾，結果不變
        for (const form of escapeForms(raw)) {
          // 只在「這條命中是新的」時記帳：同一條在三形階梯裡會各出現一次，逐次累加會讓數字虛胖三倍
          for (const h of shapeHitsIn(form)) { if (!hits.has(h)) { hits.add(h); bySource.set(path, (bySource.get(path) ?? 0) + 1); } }
        }
      }
    }
    off = start + size + 1;
  }
  return { hits, blobs: blobs.length, bytes, bySource, skippedBig };
}

export const GROK_HOME_MANIFEST = Object.freeze({
  topLevelEntries: Object.freeze(['auth.json', 'bin', 'sessions']),
  authEntryFields: Object.freeze(['auth_mode', 'create_time', 'expires_at', 'key', 'oidc_client_id', 'oidc_issuer', 'user_id']),
  reviewSmoke: Object.freeze({ minToolFootprints: 1 }),
});

/** @param {string} grokHome */
function validateGrokHomeManifest(grokHome) {
  const actual = readdirSync(grokHome).sort();
  assertStringListEqual(actual, GROK_HOME_MANIFEST.topLevelEntries, `盒內 grok-home 頂層檔案不是 manifest 宣告的最小家：${actual.join(', ')}`);
  const auth = JSON.parse(readFileSync(join(grokHome, 'auth.json'), 'utf8'));
  const entries = Object.values(auth);
  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== 'object' || Array.isArray(entries[0])) {
    throw new Error('盒內 auth.json 不是恰一個登入物件');
  }
  assertStringListEqual(Object.keys(/** @type {Record<string, unknown>} */ (entries[0])).sort(), GROK_HOME_MANIFEST.authEntryFields, '盒內 auth.json 欄位不是 manifest 宣告的白名單');
}

/** @param {string[]} actual @param {readonly string[]} expected @param {string} msg */
function assertStringListEqual(actual, expected, msg) {
  if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
    throw new Error(`${msg}；應為 ${expected.join(', ')}`);
  }
}

/**
 * SIGKILL 整個程序群組，並等到群裡沒有任何程序（kill(-pgid, 0) 回 ESRCH）。
 * 只有 ESRCH 算「群已空」；EPERM／EINVAL 等其他錯＝不知道群裡還有誰，**丟出去**（r6 #2：原本任何錯都當已空）。
 * @param {number | null} pgid
 */
async function killGroupAndWait(pgid) {
  if (!pgid) return;
  const gone = (/** @type {unknown} */ e) => /** @type {NodeJS.ErrnoException} */ (e).code === 'ESRCH';
  for (let i = 0; i < 200; i++) {   // 最多 ~10 秒
    try { process.kill(-pgid, 'SIGKILL'); } catch (e) { if (gone(e)) return; throw new Error(`kill(-${pgid}) 失敗：${/** @type {Error} */ (e).message}——不當作群已空`, { cause: e }); }
    try { process.kill(-pgid, 0); } catch (e) { if (gone(e)) return; throw new Error(`kill(-${pgid}, 0) 失敗：${/** @type {Error} */ (e).message}`, { cause: e }); }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`grok 的程序群組 ${pgid} 10 秒內殺不乾淨——不碰盒子`);
}

/**
 * 掃蕩離開程序群組的（setsid 擋不住，見檔頭）：同 uid、cwd 或執行檔在盒子裡的程序，SIGKILL。best-effort——
 * chdir 到別處、執行檔在盒外（/bin/sh）的離開群組的程序找不到；它們無害的理由在檔頭，不在這裡。
 * @param {string} box realpath
 * @param {(m: string) => void} log
 */
function sweepEscapees(box, log) {
  const r = spawnSync('/usr/sbin/lsof', ['-n', '-P', '-u', String(process.getuid?.() ?? ''), '-d', 'cwd,txt,rtd', '-F', 'pn'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) { log(`（lsof 掃蕩跑不了：status ${r.status}——略過，best-effort）`); return 0; }
  /** @type {Set<number>} */ const hits = new Set();
  let pid = 0;
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid && pid !== process.pid && (line.slice(1) === box || line.slice(1).startsWith(box + '/'))) hits.add(pid);
  }
  for (const p of hits) { try { process.kill(p, 'SIGKILL'); } catch { /* 已死 */ } }
  if (hits.size) log(`⚠️ 掃蕩：${hits.size} 個離開程序群組的程序（cwd／執行檔在盒內）已 SIGKILL`);
  return hits.size;
}

/** 向 OS 要一個目前沒人用的 127.0.0.1 port（每掃不同：上一掃離開來的程序，其沙箱只准連舊 port） */
function freePort() {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.on('error', bad);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => (a && typeof a === 'object') ? ok(a.port) : bad(new Error('拿不到 port'))); });
  });
}

/**
 * sessions **單趟**讀取（r6 #2／#3）：no-follow 開檔→fstat→regular 且在上限內→讀；回傳 { files: Map<相對路徑, Buffer> }。
 * 超過任何上限＝丟 Error（呼叫端退 2、不保存）。非 regular（symlink／裝置…）＝回 odd（呼叫端當事故）。
 * 目錄（含 sessions 根目錄本身）也 no-follow：lstat 必須是目錄、realpath 必須解析在盒內 grok-home 底下——
 * r7（Codex 被分類器切掉前的片段）：根目錄被換成指向盒外的捷徑時，原版 readdir 會跟過去、odd 是空的。
 * ⚠️ 誠實劃界：目錄沒有 O_NOFOLLOW 的 readdir（Node 沒有 fdopendir），lstat／realpath 與 readdir 之間仍有微小窗口；
 *    要利用它得有一個活在盒內、離開了程序群組、又躲過 lsof 清理的程序在那一瞬間換檔——那條鏈每一環都已各自收窄。
 * 讀過的 bytes 就是後面 DLP 與結果包用的 bytes——盒內背景 writer 在這之後改檔，改不到我們手上的副本。
 * @param {string} root
 * @param {typeof SESSION_CAPS} caps
 */
export function readSessionsOnce(root, caps = SESSION_CAPS) {
  /** @type {Map<string, Buffer>} */ const files = new Map();
  /** @type {string[]} */ const odd = [];
  let total = 0;
  const rootReal = realpathSync(dirname(root));   // 盒內 grok-home（由我們建、realpath 過）；底下每一層都要解析回這裡面
  /** 目錄也要 no-follow：lstat 說是目錄還不夠（lstat 與 readdir 之間可被換成捷徑），再用 realpath 確認它解析在盒內 */
  const dirIsInside = (/** @type {string} */ d) => { try { const r = realpathSync(d); return r === rootReal || r.startsWith(rootReal + '/'); } catch { return false; } };
  const walk = (/** @type {string} */ d, /** @type {string} */ rel, /** @type {number} */ depth) => {
    if (depth > caps.depth) throw new Error(`sessions 目錄深度超過 ${caps.depth}：${rel}`);
    if (!lstatSync(d).isDirectory() || !dirIsInside(d)) { odd.push(rel || '.'); return; }   // 根目錄或中介目錄是 symlink／解析到盒外＝捷徑
    for (const n of readdirSync(d)) {
      const fp = join(d, n); const rp = rel ? `${rel}/${n}` : n;
      const st = lstatSync(fp);
      if (st.isDirectory()) { walk(fp, rp, depth + 1); continue; }
      if (!st.isFile()) { odd.push(rp); continue; }
      if (files.size >= caps.files) throw new Error(`sessions 檔數超過 ${caps.files}`);
      const fd = openSync(fp, fsConst.O_RDONLY | fsConst.O_NOFOLLOW);
      try {
        const fst = fstatSync(fd);
        if (!fst.isFile()) { odd.push(rp); continue; }
        if (fst.size > caps.fileBytes) throw new Error(`sessions 單檔超過 ${caps.fileBytes} bytes：${rp}`);
        if (total + fst.size > caps.totalBytes) throw new Error(`sessions 總量超過 ${caps.totalBytes} bytes`);
        const buf = Buffer.alloc(fst.size);
        let off = 0;
        while (off < fst.size) { const n2 = readSync(fd, buf, off, fst.size - off, off); if (n2 <= 0) break; off += n2; }
        files.set(rp, off === fst.size ? buf : buf.subarray(0, off));
        total += off;
      } finally { closeSync(fd); }
    }
  };
  if (existsSync(root)) walk(root, '', 0);
  return { files, odd, total };
}

/**
 * @typedef {object} ScanDeps 可注入的依賴——考題用假的 grok／轉送器／session 根目錄跑主流程
 * @property {string} [repo]
 * @property {string} [grokInstall] 預設 ~/.grok＝安裝樹，**完全不進沙箱**。只從它拿 bin/grok（APFS clone＋盒內 hash）；
 *   考題給假的（bin/grok 是假 grok）。r2 放行整棵唯讀＋clone 整棵：歷史 sessions 仍可讀、憑證整包落在 /private/tmp——Codex r3 抓到。
 *   r6 #4：config.toml／agent_id **不再帶進盒子**（2026-08-23 實測 grok -p 不需要；先前未隔離的 Grok 可能已在那兩個檔裡埋東西）。
 * @property {string} [authDir] 預設 ~/.grok-sandbox-auth（0700，只含 auth.json）：沙箱跑的 grok 用這份登入狀態，
 *   第一次從真 ~/.grok/auth.json 種；**掃描前由父程序做 OIDC refresh**（沙箱裡連不到 auth.x.ai，grok 自己 refresh 不了——
 *   r4 端對端實際踩到：token 六小時過期後「auth_kind=none」）；盒內只放**白名單重建的 7 欄＋假 key**，
 *   所以**不再有掃後同步**（盒內沒有任何真憑證，沒東西要同步回來——r4 #3 的整族問題由構造消失）；真 auth.json 不動。
 * @property {typeof fetch} [fetchImpl] 考題給假 fetch 給 refresh 用
 * @property {string} [resultsRoot] 預設 ~/.grok-scan-results：掃完只留去機密的結果包（launch.json＋sessions），盒子整個清掉
 * @property {string} [expectedSha256] 預設 EXPECTED_GROK_SHA256；考題用假 grok 時傳它自己的 hash
 * @property {(msg: string) => void} [log]
 * @property {string} [relayScript]
 * @property {(code: number) => void} [exit] 收到 SIGTERM／SIGINT 時緊急收尾後呼叫；預設 process.exit（考題注入假的，免得殺掉考題自己）
 * @property {string} [liveSecret] 活金絲雀的暗號；預設隨機。只給考題（假 grok 要能把它寫進 stdout／session 來證明會被抓）
 * @property {string} [liveRoot] 活金絲雀目錄建在哪裡；**預設＝真的家目錄**。
 *   為什麼可注入：家目錄是**跨程序共用**的，考題在那裡數 `.grok-live-canary-*` 的前後差值，
 *   另一個 session／審查樹／合併閘同時在掃就會誤紅（2026-08-26 觀察到跨 PR 試合併閘兩次退 0、一次退 1；
 *   Codex 在 #514 r8 也中過。⚠️ 閘的退出碼不帶題名＝歸因是假說，不是實測）。所以給考題一個隔離根。
 *   ⚠️ **射程**：釘住預設值的那一題直接呼叫 `runScan`，**不涵蓋檔尾 CLI 入口那個接縫**——
 *   Codex #516 r1 在那個接縫注入 `BOX_ROOT`（非家目錄、且已存在）實測跑過全卷：餌搬家、全卷照樣綠。
 *   動那個接縫要另行複核。
 *   ⚠️ 考題注入的那種根（`tmpdir()` 底下）不會讓金絲雀落進沙箱讀得到的地方——profile 是 deny default，
 *   家目錄與使用者暫存區都不在放行清單裡。**但這不是對任意根成立的保證**：profile 放行讀的樹底下
 *   若有使用者寫得進去的位置（例如 Cellar 的版本目錄），把根指到那裡餌就變成盒內讀得到——所以這一格別亂傳。
 *   ⚠️ 但位置就是這個餌的全部意義：家目錄同時住著真 ~/.grok、~/.grok-sandbox-auth 與真的 store.db，
 *   是破出沙箱的人第一個會翻的地方。搬到別處餌照樣建得起來也照樣清得掉，只是不再演練「家目錄被擋住」——所以預設值不要順手改。
 *   ⚠️ 注入的目錄**必須已經存在**：`mkdtempSync(join(deps.liveRoot ?? homedir(), …))` 在它底下開子目錄，
 *   根目錄不存在時丟出的例外**沒有**被轉成退 2——與 `realpathSync(deps.grokInstall ?? …)` 是同一種既有形狀（裸 throw）。
 * @property {number} [maxBlobBytes] 破口已知來源的單檔上限；預設 SESSION_CAPS.fileBytes。只給考題注入小門檻（理由見 knownShapeHitsFromTree）。
 * @property {typeof runCanary} [runCanary] 第②步的沙箱金絲雀；不注入時走 `?? runCanary`（本檔上方那一支）。**只給考題注入。**
 *   為什麼可注入：真金絲雀是**全機共用資源的使用者**——它搶一把住在 BOX_ROOT 的剪貼簿鎖（系統剪貼簿只有一份，
 *   等不到 60 秒就整支退 2），期間還在家目錄／BOX_ROOT／/private/var/tmp／`/Users/Shared`（存在才建）
 *   各開一個誘餌目錄。目錄由它自己的 `finally` 清，但那個 `finally` **只蓋住探針那一段**——四個目錄在 `try`
 *   之前就建好，所以**建立段自己丟例外**（那幾個 `writeFileSync` 之一失敗）**或程序被砍，都會留下**（#516 清過一批）。
 *   **未注入**時，只要走到第②步就會跑它一次（實測單次 1.1 秒、30 個探針）——而走到第②步的題不只一道
 *   ⇒ `node --test` 多檔並行時互相搶那唯一一份系統剪貼簿。這就是這一格存在的理由。
 *   ⚠️ 沙箱**是不是真的有效**由金絲雀自己的考題檔證明，不是這裡；
 *   流程考題只需要「金絲雀回什麼、runScan 就怎麼反應」，那正是注入能給的。
 *   ⚠️ **這一格的守門只到「文字」為止**：把上面那個 `??` 的預設換成**不印探針行**的空殼，在**套得上沙箱的 macOS**
 *   上會有一題轉紅（考題檔裡題名關鍵字「不注入」那題）；換成**照樣印出同形文字**的替身，全綠。
 *   而那一題自己有 SANDBOX_OK guard ⇒ **CI 跑 ubuntu、整題 skip，兩種突變在 CI 都是綠的**。
 *   所以「CLI 入口不傳 deps ⇒ 正式掃描跑的是真的那一支」最終由複審讀那一行認定，不是機械保證。
 *   ⚠️ 三格的證據強度不一樣，別混為一談：`liveRoot` 的預設有**行為題**釘著（見那一格）；這一格有一道
 *   **只到文字層**的行為題（就是上面那題，而且只在 macOS）——真正沒有題的是「跑的是不是**那個函式本人**」
 *   與 CLI 入口那一行；`maxBlobBytes` 的預設則完全沒有題，只靠複審。
 * @property {(grokHome: string) => void} [afterGrokHomeAuthWrite] 考題用：在父程序寫完盒內 auth 後、manifest 驗證前插入異常形狀，證明接線真的會擋。
 */

/**
 * 主流程。回傳 { code, summary }；不自己 process.exit（考題要讀回傳值）。
 * @param {{ base: string, head: string, promptFile: string, outFile?: string }} args
 * @param {ScanDeps} [deps]
 * @returns {Promise<{ code: 0|1|2, summary: string[] }>}
 */
export async function runScan(args, deps = {}) {
  const repo = deps.repo ?? REPO;
  const grokInstall = realpathSync(deps.grokInstall ?? join(homedir(), '.grok'));
  const realGrokBin = realpathSync(join(grokInstall, 'bin', 'grok'));   // 只拿來 cp 進盒子；**不在沙箱外執行它**（hash 盒內副本、--version 在沙箱內跑）
  const authDir = deps.authDir ?? join(homedir(), '.grok-sandbox-auth');
  const resultsRoot = deps.resultsRoot ?? join(homedir(), '.grok-scan-results');
  const relayScript = deps.relayScript ?? join(HERE, 'grok-relay.js');
  const rawLog = deps.log ?? ((m) => console.log(m));
  /**
   * ⚠️ **關門，不是列舉出口**（William 2026-09-01 裁示）。
   *
   * 本支前三輪都在做同一件事：發現「又一個沒遮到的出口」就補一個遮蔽——視窗、事故訊息、路徑欄位…
   * Codex r1／r2／r3 每一輪都找得到下一個（自我重疊的機密、命中本身包住機密、深層路徑的錯誤訊息、
   * 提示檔的檔名）。那是「列舉繞法補不完」的形狀。
   *
   * 所以改成單一關卡：**任何文字要進公開摘要、或要寫進事故檔，都先過這裡**。
   * 之後再冒出什麼新出口（新的錯誤訊息、新的欄位）都不必各自記得遮——它們天生走不出去。
   * ⚠️ 這道門擋的仍然只有**我們認得的**東西（本輪暗號、DLP 針、本輪的破口形狀）；
   *   認不得的照樣出得去（別的服務的 token、別種格式的鑰匙）。門關的是「已知」那一半。
   * ⚠️ 兩條照實寫出來的劃界（Grok 複審後掃 2026-09-01）：
   *   ①**`launch.json` 不經這道門**——它是結構上的例外，欄位是白名單環境、佔位指令與雜湊；
   *     不是現在在漏，但「凡寫到磁碟都過門」這句話對它不成立，別那樣讀。
   *   ②表示清單只到**第二層**跳脫（`escapeForms` 的射程）。更深的包法兩邊都認不得，方向是漏報。
   *     ⚠️ 所以凡是「先切一段文字、之後還會再被序列化一次」的地方，都要餵**同一份表示清單**，
   *     不能只餵原文——否則進去時對不上、出來時又深一層，剛好從字典的兩端溜掉。
   * @type {string[]}
   */
  let scrubSecrets = [];
  /** DLP 針的**各種序列化表示**；偵測（`leaksIn`）與清洗共用這一份。組法見下面 needles 定稿處。 @type {string[]} */
  let needleForms = [];
  /**
   * ⚠️ **算區間再合併，不是逐個替換**。逐個替換擋不住自我重疊的機密：
   *   機密是 16 個 A、文字裡有 24 個 A 時，換掉第一個起點之後**剩下的 8 個 A 本身不構成完整機密**，
   *   再怎麼往下找都找不到，那 8 個字就留在輸出裡（Codex #535 r3 的反例；我第一版「每次前進 1 個字」
   *   同樣解決不了，因為問題不在起點漏掃，在**殘段**）。
   *   合併重疊區間之後，24 個 A 會被當成一整段拿掉。
   * @param {string} text
   */
  const scrubText = (text) => {
    /** @type {{ start: number, end: number, label: string }[]} */ const spans = [];
    for (const v of scrubSecrets) {
      if (!v) continue;
      for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) spans.push({ start: i, end: i + v.length, label: '‹已遮蔽›' });
    }
    for (const m of shapeMatchesIn(text)) spans.push({ start: m.index, end: m.index + m.hit.length, label: `‹命中 ${m.hit.length} 字，內容不留›` });
    if (!spans.length) return text;
    spans.sort((a, b) => a.start - b.start);
    let out = '', pos = 0;
    for (const sp of spans) {
      if (sp.end <= pos) continue;             // 已被前一段吃掉
      if (sp.start > pos) out += text.slice(pos, sp.start);
      else if (out.endsWith(sp.label)) { pos = sp.end; continue; }   // 與前一段重疊＝同一段，別重複貼記號
      out += sp.label;
      pos = sp.end;
    }
    return out + text.slice(pos);
  };
  /**
   * ⚠️ **先收起來、上膛後再放出去**（William 2026-09-01 裁示）。
   *
   * 前面幾輪一直在補「又一條在字典建好之前就把值送出去的路」：自己寫的訊息、Node 原生的
   * `JSON.parse` 例外（會帶輸入前綴）、`Date.parse` 失敗後印出的原文…每補一條就冒出下一條，
   * 那是「列舉繞法補不完」。改成用時間關門：**字典還沒建好之前，任何一句話都不送出去**，
   * 先存著；字典一建好就整批洗過再放。連 Node 自己產生的訊息也一併洗到。
   * ⚠️ 仍然關不住的一種（照實寫）：**在我們有能力讀出機密之前**就必須報的錯
   *   （auth.json 本身壞掉、伺服器回來的新值）——那種只能靠「訊息不回顯內容」，
   *   守它的是 `scripts/grok-auth-refresh.js` 那幾句固定訊息與對應的考題。
   * ⚠️ **這道緩衝目前沒有考題撐著**：今天上膛前的每一句話都不含針（逐條看過 auth-refresh 的
   *   每一個 throw 與 log），所以把緩衝拿掉全卷照樣綠。留著是為了讓**日後新增的訊息**
   *   （含 Node 自己產生的）天生被洗到，不是因為量得到——照實寫，不要讀成「已經擋住什麼」。
   * @type {{ text: string, toSummary: boolean }[]}
   */
  const pending = [];
  let armed = false;
  const emit = (/** @type {string} */ text, /** @type {boolean} */ toSummary) => {
    if (!armed) { pending.push({ text, toSummary }); return; }
    const t = scrubText(text);
    rawLog(t);
    if (toSummary) summary.push(t);
  };
  /** 盡力把字典建起來然後放行暫存的話；讀不出來也要放行（不能因為讀不到就把錯誤訊息吞掉）。 */
  const ensureArmed = () => {
    if (armed) return;
    try {
      const ns = authNeedles(JSON.parse(readFileSync(join(authDir, 'auth.json'), 'utf8')));
      scrubSecrets = [...scrubSecrets, ...ns.flatMap((n) => escapeForms(n))];
    } catch { /* 讀不出來＝這一刻不可能知道機密是什麼；上面的劃界就是講這種情形 */ }
    armed = true;
    for (const p of pending) { const t = scrubText(p.text); rawLog(t); if (p.toSummary) summary.push(t); }
    pending.length = 0;
  };
  const log = (/** @type {string} */ m) => emit(m, false);
  /** 進公開摘要的唯一入口（summary 會被抄進 PR 描述） */
  const say = (/** @type {string} */ m) => emit(m, true);
  /** @type {string[]} */
  const summary = [];
  /** @param {string} why @returns {{ code: 2, summary: string[] }} */
  const fail = (why) => { ensureArmed(); say(`⛔ ${why}`); return { code: 2, summary }; };   // 任何一條退場路徑都先上膛再說話

  const { base, head, promptFile, outFile } = args;
  if (!/^[0-9a-f]{7,40}$/.test(base) || !/^[0-9a-f]{7,40}$/.test(head)) return fail('base／head 必須是寫死的 SHA（條款：不可用會移動的名稱）');
  if (!existsSync(promptFile)) return fail(`指示檔不存在：${promptFile}`);
  if (!existsSync(realGrokBin)) return fail(`找不到 grok：${realGrokBin}`);
  const expectedSha = deps.expectedSha256 ?? EXPECTED_GROK_SHA256;

  // ── 破口判準的「已在給盒子的東西裡」之一：head 樹的已 commit 原始碼（**不含超過單檔上限的大檔**）──
  // 位置在**建盒子之前**：①建不出來就此刻退 2，還沒建任何暫存路徑、也還沒燒掃描時間
  //   ②不經沙箱 ⇒ 這條路的行為題在非 macOS 也跑得到（掛在盒子之後的話，CI 會先在版本檢查退場、
  //     行為題永遠驗不到這一步——Codex #530 r1 實測 CI 因此紅）。
  // ⚠️ 免疫「盒子可寫」靠的是**來源是 git 物件庫**，不是這個位置——搬到別處仍然正確，只是失敗變貴。
  /** @type {ReturnType<typeof knownShapeHitsFromTree>} */ let treeKnown;
  try { treeKnown = knownShapeHitsFromTree(repo, head, deps.maxBlobBytes); }
  catch (e) { return fail(`破口判準的已知來源（head 樹）建不出來：${/** @type {Error} */ (e).message}——建不出來就等於退回「只認材料」，那正是 #516 的假事故，不掃`); }
  // 這行是本條護欄的記帳（DLP 那條路本來就會印排除了幾根）：集合悄悄變 0（護欄沒在跑）
  // 或悄悄變大（豁免面擴張）都看得見。
  log(`（破口已知來源：head 樹 ${treeKnown.blobs} 個 blob／${(treeKnown.bytes / 1048576).toFixed(1)}MB → 形狀命中 ${treeKnown.hits.size} 條${treeKnown.hits.size ? `，來自 ${[...treeKnown.bySource].map(([f, n]) => `${f}×${n}`).join('、')}` : ''}${treeKnown.skippedBig.length ? `；⚠️ ${treeKnown.skippedBig.length} 個超過單檔上限沒讀（它們的形狀不在排除集合裡＝引用到會誤報事故）：${treeKnown.skippedBig.slice(0, 3).join('、')}${treeKnown.skippedBig.length > 3 ? ` 等 ${treeKnown.skippedBig.length} 個` : ''}` : ''}）`);

  // ── ① 建盒子 ──
  /** @type {string | undefined} */ let box;
  /** @type {string | undefined} */ let resultsDir;
  /** @type {string | undefined} */ let dummyFile;
  /** @type {import('node:child_process').ChildProcess | undefined} */ let relay;
  /** @type {string | undefined} */ let liveDir;
  /** @type {number | null} */ let grokPgid = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    try { if (dummyFile) rmSync(dummyFile, { force: true }); } catch { /* 沒建 */ }
    try { if (box) rmSync(box, { recursive: true, force: true }); } catch { /* 盡力 */ }
  };
  /** 沒掃成（退 2）＝結果包整個不留（Grok 掃描抓到：原本每次失敗都在 ~/.grok-scan-results 留一個空目錄或只有 launch.json）；事故（退 1）留 launch.json 當證據、不留 sessions */
  const dropResultsDir = () => { try { if (resultsDir) rmSync(resultsDir, { recursive: true, force: true }); } catch { /* 盡力 */ } };
  // Handler 在擁有暫存路徑之前就掛上：早於這裡的同步檢查還沒有可清的盒子；finally 清完後才卸載。
  const emergency = () => {
    try { if (grokPgid) { process.kill(-grokPgid, 'SIGKILL'); for (let i = 0; i < 60; i++) { try { process.kill(-grokPgid, 0); } catch { break; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } } } catch { /* 已空 */ }
    try { relay?.kill('SIGKILL'); } catch { /* 已死 */ }
    try { if (liveDir) rmSync(liveDir, { recursive: true, force: true }); } catch { /* 已清 */ }
    dropResultsDir();
    cleanup();
    (deps.exit ?? process.exit)(2);
  };
  process.on('SIGTERM', emergency); process.on('SIGINT', emergency);
  try {
  box = realpathSync(mkdtempSync(join(BOX_ROOT, `grok-scan-${head.slice(0, 7)}-`)));
  const src = join(box, 'src');
  mkdirSync(src); mkdirSync(join(box, 'tmp'));
  log(`盒子：${box}`);
  // 盒子在**所有出口**都要清（r3 #4：r2 沒清＝每掃在 /private/tmp 留一份憑證副本）；只留去機密的結果包。
  // r4 #1／#4：①結果檔（launch.json）由父程序**直接寫在盒外**的結果包——不經盒子，Grok 改不到；
  //   ②整段流程包在 try/finally，任何 throw 都走 cleanup（r3 版 --out 指到寫不進去的地方就 throw、盒子留著）。
  // r6：sessions 不再「cleanup 時從盒子複製」——成功路徑在 DLP 之後把**記憶體裡那份**寫進結果包（單趟讀），cleanup 只刪盒子。
  const grokHome = join(box, 'grok-home');
  const sessionsRoot = join(grokHome, 'sessions');
  resultsDir = join(resultsRoot, `${head.slice(0, 7)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  dummyFile = join(authDir, `dummy-bearer.${process.pid}`);
  /** @param {string} why @returns {{ code: 2, summary: string[] }} */
  const failAndClean = (why) => { cleanup(); dropResultsDir(); return fail(why); };
  // grok 的家＝**白名單複製**（r3：不 clone 整棵——那會把歷史 sessions 與憑證整包搬進來；r6：只剩 bin/grok＋重建的 auth.json＋空 sessions/）
  const grokBin = join(grokHome, 'bin', 'grok');   // 沙箱裡跑**盒內**的副本
  /** @type {string} */ let verText;
  const relayPort = await freePort();
  {
    mkdirSync(join(grokHome, 'bin'), { recursive: true }); mkdirSync(sessionsRoot);
    const c = spawnSync('/bin/cp', [...CP_CLONE, realGrokBin, grokBin], { encoding: 'utf8' });   // APFS clone，127MB 免費
    if (c.status !== 0) return failAndClean(`grok 執行檔 clone 失敗：${c.stderr}`);
    // r4 #5：對**盒內副本**算 hash（不是真檔——檢查與複製之間的路徑替換競態）；不符＝不掃；之後只執行這份副本
    const sha = createHash('sha256').update(readFileSync(grokBin)).digest('hex');
    if (sha !== expectedSha) return failAndClean(`grok 執行檔 sha256 不符：要 ${expectedSha.slice(0, 12)}…，實際 ${sha.slice(0, 12)}…——執行檔被換過或升版了；升版要改 EXPECTED_GROK_SHA256 並重驗轉送器目的地`);
    // 登入狀態：沙箱專用目錄（0700、只含 auth.json）；第一次從真的種；目錄已存在也把 mode 修成 0700（mkdir 的 mode 不會改既有目錄）
    mkdirSync(authDir, { recursive: true, mode: 0o700 }); chmodSync(authDir, 0o700);
    if (!existsSync(join(authDir, 'auth.json'))) {
      const seed = join(grokInstall, 'auth.json');
      if (!existsSync(seed)) return failAndClean(`找不到登入狀態：${seed} 也沒有——先在沙箱外登入一次`);
      const st = lstatSync(seed);
      if (!st.isFile() || st.size > 64 * 1024) return failAndClean(`安裝樹的 auth.json 不是 regular file 或超過 64KB——不種`);
      writeFileSync(join(authDir, 'auth.json'), readFileSync(seed), { mode: 0o600 });
    }
    ensureArmed();   // 這裡 auth.json 已經在了：先上膛再往下走，緩衝的話立刻放出去
    // ⚠️ **這一段仍可能跑在字典就緒之前**（auth.json 讀不出來時 ensureArmed 建不起字典）（字典要等後面那段讀 auth.json 才有內容），
    //   而這裡的錯誤會走 `fail → say` 進公開摘要＝抄進 PR 描述。所以這個階段的每一句訊息
    //   **都不可以回顯 auth 的實值**（Codex #535 r7 用合成 issuer 重現過一次）。
    //   ⚠️ 我一度想「把字典提前種起來」當第二層——**拿掉了**：逐條看過這個階段的所有訊息
    //   （`scripts/grok-auth-refresh.js` 的 throw），沒有一句會帶出針的值（只印欄位名、長度、HTTP 狀態），
    //   所以那層沒有任何可達情境、也沒有考題撐得住，只會多一個「字典有兩個地方在建」的漂移點。
    //   守這件事的是題名關鍵字「門要在第一句話出去之前上膛」那一題。
    // 父程序 refresh（沙箱外、可信程式、不是 grok）；盒內只放白名單重建的版本＋本掃隨機假值；假值走 0600 檔給轉送器（不走 argv／env）
    try {
      const a = await refreshSandboxAuth(authDir, { fetchImpl: deps.fetchImpl, log });
      writeFileSync(join(grokHome, 'auth.json'), JSON.stringify(a.forBox), { mode: 0o600 });
      writeFileSync(dummyFile, a.dummyBearer + '\n', { mode: 0o600 });
      deps.afterGrokHomeAuthWrite?.(grokHome);
    } catch (e) { return failAndClean(`憑證 refresh 失敗：${/** @type {Error} */ (e).message}`); }
    try { validateGrokHomeManifest(grokHome); }
    catch (e) { return failAndClean(`盒內最小家 manifest 不符：${/** @type {Error} */ (e).message}`); }
  }
  const sbArgv = ['-f', PROFILE, '-D', `SCAN_DIR=${box}`, '-D', `RELAY_PORT=${relayPort}`];
  // ── 版本釘：在**沙箱內**對盒內副本跑（r4 #5：r3 版在沙箱外執行真檔＝未驗身分的程式拿到完整檔案系統）──
  {
    const ver = spawnSync('/usr/bin/sandbox-exec', [...sbArgv, grokBin, '--version'],
      { encoding: 'utf8', timeout: 20_000, cwd: box, env: sandboxEnv(box) });
    verText = (ver.stdout || '').trim();
    const parsed = /^grok (\S+)/.exec(verText)?.[1];
    if (ver.status !== 0 || parsed !== EXPECTED_GROK_VERSION) return failAndClean(`grok 版本不符：要 ${EXPECTED_GROK_VERSION}，實際「${verText || ver.error?.message || ver.status}」（${(ver.stderr || '').slice(-200)}）`);
  }
  {
    // 不用 shell pipeline 組路徑；git 一律帶 gitEnv()（鐵則 11：GIT_DIR 等會讓 -C 失效、指去別棵 repo）
    const tarPath = join(box, 'src.tar');
    const ar = spawnSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tarPath, head], { encoding: 'utf8', env: gitEnv() });
    if (ar.status !== 0) return failAndClean(`git archive 失敗：${ar.stderr}`);
    const tx = spawnSync('/usr/bin/tar', ['-x', '-f', tarPath, '-C', src], { encoding: 'utf8' });
    if (tx.status !== 0) return failAndClean(`tar 解開失敗：${tx.stderr}`);
    rmSync(tarPath);
    // node_modules：先 realpath（工作樹裡它是 symlink；cp -Rc 對 operand 本身是 symlink 時會複製 symlink、不跟隨——Codex r1 實測）
    const nmReal = realpathSync(join(repo, 'node_modules'));
    const c = spawnSync('/bin/cp', ['-R', ...CP_CLONE, nmReal, join(src, 'node_modules')], { encoding: 'utf8' });
    if (c.status !== 0) return failAndClean(`node_modules clone 失敗：${c.stderr}`);
    const st = lstatSync(join(src, 'node_modules'));
    if (!st.isDirectory() || st.isSymbolicLink()) return failAndClean('盒子裡的 node_modules 不是真目錄（symlink 指回家目錄＝沙箱裡讀不到）');
    if (!existsSync(join(src, 'node_modules', 'eslint'))) return failAndClean('盒子裡的 node_modules 少了套件（clone 沒跟隨 symlink？）');
    for (const forbidden of ['data/store.db', 'data/store.json', '.env', '.env.local']) {
      if (existsSync(join(src, forbidden))) return failAndClean(`盒子裡出現不該有的檔：${forbidden}——git archive 不該帶出它，先查 .gitignore`);
    }
  }

  // ── ② 金絲雀（fail-closed；用本掃的 port 跑，跟正式發射同一組參數）──
  {
    const { code, lines } = await (deps.runCanary ?? runCanary)(box, { relayPort });
    for (const l of lines) say('  ' + l);   // 摘要與 log 同一份、同一道門
    if (code !== 0) return failAndClean(code === 1 ? '金絲雀：有一隻活著＝沙箱是假的，不掃' : '金絲雀：這台機器跑不了沙箱／對照組不活，不掃');
  }

  // ── 材料：指示＋diff ──
  const diff = spawnSync('git', ['-C', repo, 'diff', `${base}..${head}`], { encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  if (diff.status !== 0) return failAndClean(`git diff 失敗：${diff.stderr}`);
  const materials = readFileSync(promptFile, 'utf8')
    + `\n\n【受掃版本】base ${base} → head ${head}；你現在所在的目錄 ./src 是 head 的完整原始碼（已 commit 的部分），可以在裡面跑 node --test。`
    + `\n【沙箱提醒】你在 OS 沙箱裡：家目錄、/private/tmp 其他目錄、外網、本機其他 port 都連不到，那是正常的。會起本機 HTTP 伺服器再連自己的整合型考題（hosted-*、heavy-admission 等）在這裡會 EPERM 或卡住——不要跑整套 npm test，挑跟 diff 直接相關的單檔跑。少數考題寫死 /tmp 會因 EPERM 紅——那是沙箱擋寫盒外，不是 diff 的問題。`
    + `\n\n【以下為 diff】\n` + diff.stdout;

  // ── DLP 針：真 auth.json 裡沒給盒子的值（r6 #6：讀不到＝退 2，不是空集合放行；按欄位排除、不按內容形狀）──
  /** @type {string[]} */ let needles;
  try {
    const p = join(authDir, 'auth.json');
    if (!lstatSync(p).isFile()) throw new Error('不是 regular file');
    needles = authNeedles(JSON.parse(readFileSync(p, 'utf8')));
  // ⚠️ 這一格也在字典就緒**之前**（針就是這裡讀出來的）：不可以把 `e.message` 原樣往外送——
  //   JSON 解析失敗時它會帶出檔案內容的前綴。只回錯誤的**類別**（SyntaxError／檔案系統錯誤碼）。
  //   ⚠️ 這不是「走不到」（我一度那樣記，錯的）：`refreshSandboxAuth` 讀一次、這裡再讀一次，
  //   中間隔著 manifest／版本／盒子／金絲雀／diff，**檔案可能被換掉**（另一個掃描、外部程序）。
  //   守它的是題名關鍵字「兩次讀 auth 之間被換掉」那一題（用既有的 `afterGrokHomeAuthWrite` 鉤子
  //   在兩次讀取之間換檔，穩定走到這裡）。
    ensureArmed();   // 冪等；正常路徑早就上膛了，這裡是保險
  } catch (e) { const x = /** @type {Error & { code?: string }} */ (e); return failAndClean(`DLP 真相來源（${authDir}/auth.json）讀不出來：${x.code ?? x.name}（內容不回顯）——沒有針就不能證明沒外流，不掃`); }
  {
    // 已在**給盒子的東西**裡出現的針偵測不了外流——給盒子的東西＝材料（指示＋diff）**＋ head 整棵已 commit 原始碼**
    //   （第四次正式掃描後的煙霧測試：空 diff、名字不在材料裡，但 AGENTS.md 裡有幾百次，grok 讀檔的 tool_result 就帶出來＝假事故）。
    //   樹裡有沒有用 `git grep -F -f <0600 檔>` 查：針不走 argv（同 uid 的程序 ps 看得到）、不進盒子（authDir 在盒外）。剔掉並記錄。
    const inTree = (/** @type {string} */ needle) => {
      const pf = join(authDir, `needle.${process.pid}`);
      try {
        writeFileSync(pf, needle + '\n', { mode: 0o600 });
        const g = spawnSync('git', ['-C', repo, 'grep', '-q', '-F', '-f', pf, head, '--'], { encoding: 'utf8', env: gitEnv() });
        if (g.status !== 0 && g.status !== 1) throw new Error(`git grep 失敗（status ${g.status}）：${g.stderr}`);
        return g.status === 0;
      } finally { rmSync(pf, { force: true }); }
    };
    // ⚠️ **判準與排除都用同一份表示清單**（Codex #535 r5）：
    //   針裡有 `"`／反斜線／換行時，它在 JSONL 日誌與 JSON 回覆裡是**跳脫形**。
    //   r4 我只把跳脫形加進「清洗字典」（出口那道門），卻沒加進 `leaksIn`（警報器）
    //   ⇒ 跳脫形根本不算外洩、掃描直接退 0、`--out` 照寫、sessions 照存，那個表示還原得回原文。
    //   門關好了但警報器是聾的，等於沒關。所以偵測與清洗一起改成吃 `escapeForms()` 的全部表示。
    /** @type {string[]} */ const given = [];
    try { for (const n of needles) if (materials.includes(n) || inTree(n)) given.push(n); }
    catch (e) { return failAndClean(`DLP：查針是否已在公開材料裡時失敗：${/** @type {Error} */ (e).message}`); }
    if (given.length) log(`（DLP：${given.length} 根針已在給盒子的材料／原始碼裡出現、不採用——長度 ${given.map((n) => n.length).join('/')}）`);
    needles = needles.filter((n) => !given.includes(n));
    // ⚠️ 字典要含**各種序列化表示**，不是只有原文：事故檔是先 `JSON.stringify` 再過門的，
    //   針裡只要有 `"`／反斜線／換行，序列化之後就不再逐字含原文 ⇒ 門命不中（Codex #535 r4 用
    //   合成針 `SYNTHETIC-"QUOTE"-BACK\SLASH` 端到端重現）。escapeForms 就是 #534 那把同一階梯。
    // 每根針展開成各種表示；**表示本來就在給盒子的東西裡就不採用**——否則 Grok 引用公開材料
    // 會被誤判成外洩（與上面那道「針已在材料裡」同一個原則，只是套到表示層）。
    try {
      needleForms = needles.flatMap((n) => escapeForms(n)).filter((v) => !materials.includes(v) && !inTree(v));
    } catch (e) { return failAndClean(`DLP：查表示是否已在公開材料裡時失敗：${/** @type {Error} */ (e).message}`); }
    scrubSecrets = [...scrubSecrets, ...needleForms];
    if (!needles.length) return failAndClean('DLP：沒有任何可用的針——不掃');
  }

  // ── 掃描期間放著的金絲雀（第⑤步查它的暗號有沒有出現在日誌）──
  const liveSecret = deps.liveSecret ?? `LIVE-CANARY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  scrubSecrets = [...scrubSecrets, ...escapeForms(liveSecret)];   // 暗號這一半（它比 DLP 針晚生）；同樣含轉義形
  // 根目錄可注入（見 ScanDeps.liveRoot）：**預設仍是真家目錄**——金絲雀要放在「真機密真的住的地方」才有意義。
  // 預設值有考題釘著（test/grok-scan-flow.test.js 裡不注入 liveRoot 的那一題：不注入、用每輪隨機暗號
  // 在真家目錄認出自己那一個）；把這一行的 `?? homedir()` 改掉它會紅。
  // ⚠️ 誠實劃界——那一題**只**守 runScan 的預設值，守不到兩件事：
  //    ①它看的是「這次 runScan 在真家目錄留下幾個帶本輪暗號的目錄」＝**不涵蓋這次沒執行到的建立點**
  //      （同一次 runScan 若在「掃描開始」前多建一顆同暗號的，它反而會紅——那不是它守得住的範圍，是副作用）；
  //    ②它直接呼叫 runScan，**不涵蓋檔尾 CLI 入口那個接縫**（Codex #516 r1 在那裡注入 `BOX_ROOT`
  //      ——非家目錄、且已存在——實測跑過全卷：餌搬家、全卷照樣綠）——動那個接縫要另行複核。
  liveDir = mkdtempSync(join(deps.liveRoot ?? homedir(), '.grok-live-canary-'));
  writeFileSync(join(liveDir, 'store.db'), liveSecret + '\n');

  // ── ③ 轉送器（監看它的生死）──
  const relayProc = spawn(process.execPath, [relayScript, String(relayPort), '--auth-dir', authDir, '--dummy-file', dummyFile], { stdio: ['ignore', 'pipe', 'pipe'] });   // broker：真 token 只在轉送器手上
  relay = relayProc;
  let relayDead = /** @type {string | null} */ (null);
  let relayErr = '';
  relayProc.stderr?.on('data', (d) => { if (relayErr.length < 1024 * 1024) relayErr += String(d); });   // 有界：轉送器自己也有 MAX_REFUSALS
  relayProc.on('exit', (c, sig) => { relayDead = `轉送器退出（code ${c}, signal ${sig}）${relayErr.trim() ? `：${relayErr.trim().slice(-200)}` : ''}`; });
  const ready = await new Promise((ok) => {
    const t = setTimeout(() => ok(false), 5000);
    relayProc.stdout?.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(t); ok(true); } });
    relayProc.on('exit', () => { clearTimeout(t); ok(false); });
  });
  if (!ready) { return failAndClean(`轉送器沒有 READY（${relayDead ?? '5 秒逾時'}）`); }

  // ── ④ 沙箱裡跑 grok ──
  const startedAt = new Date().toISOString();
  log(`掃描開始：${startedAt}（在通過之後才掃＝條款；時序要自己記進 PR）`);
  // --always-approve：盒內跑指令不需人工確認（William 2026-08-20 裁示准跑指令；盒子裡沒有它不該碰的東西）。
  //   第四次正式掃描才發現：r6 拿掉 config.toml（裡面有 permission_mode = "always-approve"）後，grok 回到預設「跑指令要問」，
  //   -p 模式沒人能答 → permission_cancelled → 整輪取消、退 0、只印旁白——一個「成功但空的」掃描。用旗標，不重建 config 檔。
  const GROK_FLAGS = ['--disable-web-search', '--no-subagents', '--always-approve'];
  const grokArgv = [grokBin, ...GROK_FLAGS, '-p', '<materials>'];
  const env = { ...sandboxEnv(box), GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${relayPort}/v1` };
  // r6 #3：ulimit 包著整個沙箱（sh 設完 exec sandbox-exec；限制隨 fork 繼承）：
  //   -f 單檔 64MB（1024-byte 單位）／-u 程序數＝同 uid 現有數＋256（macOS 的 -u 是 per-uid 計數，設太低連 fork 都不行）／-t CPU 1800 秒。
  //   -v（虛擬記憶體）在 macOS 設不了（EINVAL），沒放。
  const procNow = (spawnSync('/bin/ps', ['-u', String(process.getuid?.() ?? 0), '-o', 'pid='], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).length;
  const ulimits = `ulimit -f ${64 * 1024} -u ${procNow + 256} -t 1800 || exit 97`;
  const shArgv = ['-c', `${ulimits}; exec /usr/bin/sandbox-exec "$@"`, 'grok-scan-sh', ...sbArgv, grokBin, ...GROK_FLAGS, '-p', materials];
  // 發射紀錄留檔（#495 那次事後分不出「旗標失效」還是「根本沒帶旗標」——claude-bd 2026-08-22 建議）：
  // 完整指令、env 白名單、版本、沙箱設定檔的雜湊。之後驗屍或重裁都有憑據，不靠回憶。
  writeFileSync(join(resultsDir, 'launch.json'), JSON.stringify({
    startedAt, base, head, sandboxExec: '/usr/bin/sandbox-exec', sbArgv, grokArgv, env, grokVersion: verText, relayPort, ulimits,
    profileSha256: createHash('sha256').update(readFileSync(PROFILE)).digest('hex'),
    materialsSha256: createHash('sha256').update(materials).digest('hex'),
  }, null, 2));
  // ⚠️ 不用 spawnSync：它卡住事件迴圈，轉送器的 exit 事件要等 grok 結束後才派發，
  //    「轉送器中途死」就永遠量不到（r2 的行為題抓到：假轉送器 READY 後 200ms 死、假 grok 回 0，結果退 0）。
  // r5 #3：grok 跑在**自己的程序群組**（detached＝setsid）。結束後先 SIGKILL 整群、等到群裡沒人，再 lsof 掃蕩，父程序才碰盒內任何東西。
  //   輸出設上限（r5：無界字串＝OOM 跳過 finally）。
  const OUT_CAP = 8 * 1024 * 1024;
  const grok = await new Promise((resolve) => {
    const child = spawn('/bin/sh', shArgv, { cwd: src, stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
    grokPgid = child.pid ?? null;
    let stdout = '', stderr = '', truncated = false;
    child.stdout.on('data', (d) => { if (stdout.length < OUT_CAP) stdout += d; else truncated = true; });
    child.stderr.on('data', (d) => { if (stderr.length < OUT_CAP) stderr += d; else truncated = true; });
    const t = setTimeout(() => { if (grokPgid) try { process.kill(-grokPgid, 'SIGKILL'); } catch { /* 已死 */ } }, 30 * 60_000);
    child.on('error', (e) => { clearTimeout(t); resolve({ status: null, signal: null, error: e, stdout, stderr, truncated }); });
    child.on('close', (status, signal) => { clearTimeout(t); resolve({ status, signal, error: undefined, stdout, stderr, truncated }); });
  });
  await killGroupAndWait(grokPgid);
  const swept = sweepEscapees(box, log);
  const endedAt = new Date().toISOString();
  const reply = grok.stdout || '';
  log(`掃描結束：${endedAt}；grok 退出碼 ${grok.status}；回覆 ${reply.length} 字；程序群組已收束${swept ? `、掃蕩 ${swept}` : ''}`);
  // 轉送器在 grok 結束前死了＝一律 2（r2 #3：r1 寫成 `relayDead && grok.status !== 0`，grok 自己回 0 就放過了）
  // r5 #1：失敗＝**全丟棄**。Grok 可控的 stdout／stderr／sessions 一律不進結果包、不進 log（stderr 尾巴也是它可控的）。
  if (grok.truncated) return failAndClean(`grok 輸出超過 ${OUT_CAP} bytes——丟棄`);
  if (relayDead) return failAndClean(`轉送器在掃描結束前死了：${relayDead}；grok 退出碼 ${grok.status}（輸出已丟棄）`);
  if (grok.status === 97) return failAndClean('ulimit 設不上去——不在沒有資源上限的情況下跑');
  // r7（Codex #2）：轉送器的每次拒絕都記在 stderr；除了刻意擋的那幾個形狀，任何拒絕＝白名單漏記或盒內程式打了不該打的＝退 2（吵），
  //   不靠 grok 的退出碼（它收到 403 照常退 0）。
  {
    const refused = relayErr.split('\n').filter((l) => l.startsWith(REFUSED_PREFIX)).map((l) => l.slice(REFUSED_PREFIX.length));
    const bad = refused.filter((l) => !TOLERATED_REFUSALS.some((t) => l.startsWith(t + ' ')));
    if (bad.length) return failAndClean(`轉送器拒絕了 ${bad.length} 個不在白名單的請求（白名單漏記＝靜默降級，不掃）：${bad.slice(0, 3).join('；')}`);
    if (refused.length) log(`（轉送器拒絕了 ${refused.length} 個刻意擋的形狀：${[...new Set(refused.map((l) => l.split(' (')[0]))].join('、')}）`);
  }
  if (grok.status !== 0) return failAndClean(`grok 沒有正常結束（status ${grok.status}${grok.signal ? `, signal ${grok.signal}` : ''}${grok.error ? `, ${grok.error.message}` : ''}）——輸出已丟棄，不印`);
  if (!reply.trim()) return failAndClean('grok 退 0 但回覆是空的');

  // ── ⑤ 驗屍：單趟讀 sessions → 足跡＋破口線索＋DLP → 乾淨才寫結果包 ──
  /** @type {ReturnType<typeof readSessionsOnce>} */ let snap;
  try { snap = readSessionsOnce(sessionsRoot); }
  catch (e) { return failAndClean(`驗屍：sessions 讀不完（${/** @type {Error} */ (e).message}）——超過上限＝不保存`); }
  const leaksIn = (/** @type {string} */ text) => needleForms.some((v) => text.includes(v));
  /**
   * Grok 可控的字串（session 相對路徑、odd 的項目名）要先過濾再放進 summary／指紋包：
   * 它可以用「檔名就是暗號」的方式，靠一個回聲把內容送進**公開的** PR 描述。
   * ⚠️ 只擋得到我們認得的那兩族（暗號、本輪的破口形狀）；認不得的擋不住——方向與 `redactWindow` 同。
   * ⚠️ 遮掉的路徑**連截斷雜湊都不留**：路徑短、熵低，12 碼 SHA 對一個已知候選清單就是可查表的
   *   （Codex #535 r1）。留長度就夠回答「有幾個、多長」，那是這一格唯一該回答的事。
   * ⚠️ 這兩個宣告刻意提到 odd 那道檢查**之前**：odd 也是一條事故路徑，它一樣要留指紋。
   * @param {string} rp
   */
  const redactPath = (rp) => (rp.includes(liveSecret) || leaksIn(rp) || shapeHitsIn(rp).length
    ? `‹路徑已遮蔽，長 ${rp.length}›` : rp);
  /**
   * 只在「這段內容裡沒有我們認得的機密」時才給雜湊。
   * ⚠️ 為什麼要這道：整份內容的雜湊平常不可逆，但**內容本身就是一個低熵的已知機密**時
   *   （例如回覆就只有一個 DLP 值），那個雜湊就是該值的完整 SHA-256＝可查表
   *   （Codex #535 r1）。所以「兩族不留雜湊」這條約束要套到**整個指紋包**，不是只套在 `hits[]` 那幾格。
   * @param {string} text
   */
  const safeSha = (text) => (text.includes(liveSecret) || leaksIn(text)
    ? null : createHash('sha256').update(text).digest('hex'));

  /**
   * 寫事故指紋包。**寫不出來不改變結論**（事故就是事故），但要說出來——
   * 「以為有證據」比明知沒有更糟。
   * @param {Record<string, unknown>} payload
   */
  const writeIncident = (payload) => {
    try {
      if (!resultsDir) throw new Error('這一次沒有結果包目錄');
      const to = join(resultsDir, 'incident.json');
      // ⚠️ **整份序列化之後再過一次那道門**：這樣「哪一個欄位可能夾帶已知機密」就不必逐格記得
      //   （提示檔路徑、錯誤訊息、之後新增的任何欄位都一樣）。佔位符不含引號與反斜線，JSON 仍然合法。
      writeFileSync(to, scrubText(JSON.stringify({ note: '事故指紋包：不含任何命中值本身。整份寫出前會再過一次清洗（已知機密與破口形狀都換成佔位符）；認不得的擋不住。', ...payload }, null, 2)), { mode: 0o600 });
      say(`事故指紋已寫入 ${to}（不含命中內容）`);
    } catch (e) {
      say(`⚠️ 事故指紋寫不出來（${/** @type {Error} */ (e).message}）——這一次沒有證據可查`);
    }
  };

  // r4 #1：任何非 regular file（symlink、裝置…）＝Grok 在自己的日誌區放了捷徑，父程序讀它就會替 Grok 跟到盒外。事故（code 1），不是「讀不清楚」。
  if (snap.odd.length) {
    const shown = snap.odd.slice(0, 3).map(redactPath);   // 項目名是 Grok 取的，會被回聲進公開的 PR 描述
    const m = `⚠️ 驗屍：sessions 裡有 ${snap.odd.length} 個非 regular file（symlink／特殊檔）——Grok 在日誌區放了捷徑，這是事故：${shown.join('、')}`;
    say(m);
    writeIncident({
      startedAt, endedAt, base, head, promptFile,
      hits: snap.odd.map((rp) => ({ family: 'odd', where: redactPath(rp), len: rp.length })),
      sessionFiles: [...snap.files].map(([rp, buf]) => ({ rp: redactPath(rp), bytes: buf.length, sha256: safeSha(buf.toString('utf8')) })),
    });
    return { code: 1, summary };
  }
  if (!snap.files.size) return failAndClean('驗屍：找不到這次的 session 日誌（零 session）——沒有日誌＝證明不了它做了什麼');
  // 結果包：先把記憶體那份寫到盒外（父程序之後只讀這份；DLP 驗不了的非 UTF-8 不寫）；中途任何失敗都把它刪掉
  const resultsSessions = join(resultsDir, 'sessions');
  const dropResults = () => { try { rmSync(resultsSessions, { recursive: true, force: true }); } catch { /* 沒建 */ } };
  /**
   * 事故命中清單（取代舊的 `let worst = 0`）。留著結構是為了在 `return` 之前寫出指紋包——
   * 舊寫法只留一個布林，於是「哪一族、在哪個檔、長什麼樣」全部隨函式返回一起蒸發。
   * @type {{ family: 'live'|'shape'|'dlp'|'odd', where: string, len: number, charOffset?: number,
   *          profile?: ReturnType<typeof hitProfile>, nearest?: ReturnType<typeof nearestKnown>,
   *          sha256?: string, context?: string }[]}
   */
  const incidentHits = [];
  const dec = new TextDecoder('utf-8', { fatal: true });
  /** @type {string[]} */ const binaries = [];
  // 破口線索的命中若**已在材料裡**就不算（在輸入裡的字串偵測不了外流——跟 DLP 針同一個原則）：
  // #500 第一次正式掃描就誤中自己——受掃 diff 含破口考題的私鑰字面與這條正則的原文，grok 把材料寫進 prompt_0.txt，
  // 驗屍把「材料裡本來就有的」當「盒子外才有的」。活金絲雀的暗號是隨機的、永遠不在材料裡，所以它不受這條影響。
  // r10（Codex）：私鑰的命中要含標頭後的一段內容——命中只有標頭時，材料裡一句標頭就會把真私鑰整把排掉；
  //   而光有標頭（題名、註解、這行）本來就不是鑰匙。flexToken 的命中本來就含值。
  // ⚠️ 誠實劃界（本支改口）：字元類含 `\s` 與 `\\`，所以「標頭＋32 個空白／換行／反斜線」也算命中——
  //   這條規矩擋不到「命中不含 base64 內容」的情況。方向是誤報；收緊字元類會同時放大誤報，另支處理。
  // 第三次正式掃描：日誌是 JSON 字串，材料裡的 `"`／`\n` 在 chat_history.jsonl 裡是 `\"`／`\\n`，命中跟材料原文對不上。
  //   所以「材料裡本來就有的命中」要對**材料原文、材料的 JSON 轉義版、雙重轉義版**各跑一次同一條正則收集；session 命中不在集合才算。
  //   跨行的鑰匙在 diff 裡每行多一個 `+`——再收一個「去掉 diff 行首記號」的版本（含它的轉義版）。
  // 破口線索分兩族，排除**只**作用在形狀那一族（分族的理由見 BREACH_SHAPES）：
  //   ・給盒子的東西＝材料（指示＋diff）**＋ head 樹的已 commit 原始碼**（大檔跳過，見 knownShapeHitsFromTree）。DLP 那條路（inTree）早就把樹算進去，
  //     破口這條沒跟上＝#516 的假事故（受掃檔自己含假鑰 fixture，grok 讀了它就被判成沙箱破了）。
  //   ⚠️ 沿用 DLP 的**來源**、不沿用它的**機制**：inTree 用 `git grep -F` 查樹原文，而日誌是 JSONL；
  //      拿日誌裡的轉義形去 `git grep -F` 找不到（實測 status 1），照抄會變成什麼都沒修的空修。
  //   ⚠️ 這是**擴大豁免**：受掃 head 的樹裡若真的存在一把真鑰匙，破口偵測就對它的外洩失明。
  //      射程從「本支 diff」擴到「head 這個快照的全部內容」——**不含已刪除的歷史 blob**（只讀 head 樹，不走 rev-list）。
  // 暗號用**字面**搜尋、不編譯成正則：暗號是可注入的（考題會傳），帶 `[` 會讓 new RegExp 當場丟、
  // 帶 `.` 會大量誤中、帶 `$` 反而找不到自己。正式路徑的暗號是 base36 所以碰不到，
  // 但這一格沒有理由留著那個 bug class（main 的舊寫法把它插進正則字串，同樣暴露）。
  const liveHitsIn = (/** @type {string} */ text) => {
    /** @type {number[]} */ const out = [];
    for (let i = text.indexOf(liveSecret); i >= 0; i = text.indexOf(liveSecret, i + liveSecret.length)) out.push(i);
    return out;
  };
  /** @type {Set<string>} */ const knownHits = new Set();
  const unprefixed = materials.replace(/^[+ -]/gm, '');   // diff 每行多一個 `+`；樹側**不套**，那會憑空造出樹裡沒有的排除項
  for (const base0 of [materials, unprefixed]) for (const form of escapeForms(base0)) for (const h of shapeHitsIn(form)) knownHits.add(h);
  for (const h of treeKnown.hits) knownHits.add(h);
  /**
   * 這段文字裡「證明不了是盒內來源」的命中，分兩族回傳。
   * ⚠️ 兩半的比對強度**不一樣**，別讀成一致（Codex #530 r1 抓到我原本一句話蓋兩半）：
   *   ・**樹那半是精確比對**（`knownHits.has`）——刻意不放寬成子字串包含，那等於允許
   *     「真外洩剛好是某條 fixture 的前綴」被排除；考題檔裡「被截成前綴」那一格釘著這件事。
   *     ⚠️ 這裡刻意**不用**「題名關鍵字」那個機械記號：那道閘只掃 `test/` 底下的 `*.test.js`，
   *        記號寫在 `scripts/` 完全不會被檢查——留著只會讓人以為有閘接著，題名一改就靜靜爛掉。
   *   ・**材料那半保留既有的 `materials.includes(h)`**＝子字串排除（main 就是這樣、非本支新增）：
   *     材料命中被截成前綴時仍會被排掉。要收它得另支評估，本支不動、照實寫出來。
   * ⚠️ 誠實劃界：日誌把內容切成跟樹不同邊界時（中段截斷、markdown 包裹…）樹那半對不上＝仍會誤報事故。
   */
  // ⚠️ 回傳**帶位置**與**剝完記號的那份文字**：事故指紋要在同一份文字上切出上下文視窗
  //    （比對就是在它上面做的，位置對得起來；原始位元組的位移對不上，不要拿它去切）。
  const breachHits = (/** @type {string} */ text) => {
    const t = stripLineMarkers(text);
    return {
      stripped: t,
      live: liveHitsIn(t).map((index) => ({ index })),   // liveHitsIn 回的就是字元位置；r1 這裡誤用了陣列序號
      shape: shapeMatchesIn(t).filter((m) => !knownHits.has(m.hit) && !materials.includes(m.hit)),
    };
  };
  // 事故訊息帶三個**不含內容**的欄位：哪一族、幾條、形狀命中的長度。
  // 為什麼要帶：退 1 不留 sessions ⇒ 事後沒有任何東西能分辨「真破口」與「又一次 #516 式假事故」，
  //   而重複的假警報會把人訓練成不信退 1。暗號那一族自證為真（每掃現生、不在任何 commit 裡），形狀那族才要人看。
  // ⚠️ 命中內容不回聲：這個 repo 是公開的，而失敗原因會被抄進 PR 描述。
  //   考題釘住的是「**完整**命中值不出現」——只洩前綴那種它抓不到，照這個射程寫、不要放大成「一個字元都不放」。
  // ⚠️ 尾句只能說**這個判準真的量過的事**：形狀那族量的是「剝完行號記號後不在本次的排除集合裡」，
  //   而排除集合＝材料＋head 樹裡**讀得到的** blob（大檔跳過的不算）。**不可以寫成「不在 head 樹裡」**——
  //   暗號那族根本不查樹（考題就把暗號 commit 進 head、仍要報事故），超過單檔上限的 blob 也是
  //   「在樹裡但不在集合裡」。兩種情形原句都在說不成立的話（Codex #530 r5 抓到）。
  const brief = (/** @type {{ live: unknown[], shape: { hit: string }[] }} */ b) =>
    `（暗號 ${b.live.length} 條、形狀 ${b.shape.length} 條；形狀長度 ${b.shape.map((m) => m.hit.length).join('/') || '—'}；形狀那族＝剝完行號記號後仍不在本次排除集合裡）`;
  /**
   * 把一次 `breachHits` 的結果收進事故清單。
   * 形狀族才留雜湊、字元組成、最近似排除項與上下文視窗（理由見 `redactWindow`／`nearestKnown`）；
   * 暗號族只留位置——它的值是本輪現生的、由構造已知。
   * @param {{ stripped: string, live: { index: number }[], shape: { hit: string, index: number }[] }} b
   * @param {string} where
   */
  const collectBreach = (b, where) => {
    for (const l of b.live) incidentHits.push({ family: 'live', where, len: liveSecret.length, charOffset: l.index });
    for (const m of b.shape) {
      // ⚠️ 形狀命中**本身包住已知機密**時（例如鍵值對的值就是一個 DLP 值），
      //   它的雜湊就是「固定前綴＋低熵值」的雜湊＝可查表。這種就退回跟另外兩族同一格：只留位置。
      if (m.hit.includes(liveSecret) || leaksIn(m.hit)) { incidentHits.push({ family: 'shape', where, len: m.hit.length, charOffset: m.index }); continue; }
      incidentHits.push({
        family: 'shape', where, len: m.hit.length, charOffset: m.index,
        sha256: createHash('sha256').update(m.hit).digest('hex'),
        profile: hitProfile(m.hit),
        nearest: nearestKnown(m.hit, knownHits, materials),
        // ⚠️ 這裡要餵**同一份表示清單**（`scrubSecrets`），不是原文（Grok 複審後掃 2026-09-01 抓到）：
        //   日誌裡的針常常已經是跳脫形，只比對原文的話視窗不會把它標成要遮的區間；
        //   接著整包再序列化一次，檔裡就變成更深一層，連最後那道門的字典也涵蓋不到。
        //   同一支程式裡不可以有兩把尺——這正是 r4／r5 那條病的第三次變形。
        context: redactWindow(b.stripped, m.index, m.hit.length, scrubSecrets),
      });
    }
  };

  /**
   * 事故收尾：**先把指紋包寫出來，再回傳**。
   *
   * ⚠️ 舊寫法是 `if (worst) return { code: 1, summary }`，位置在寫結果包之前 ⇒ sessions 沒留、
   *   `--out` 沒寫、盒子照清，事後只剩 summary 那幾個數字。#516／#530 兩次假事故是靠**重算**判掉的；
   *   #534 連重算的材料都沒有（四條命中裡兩條在 grok 的回覆裡，而回覆不可重現），只能照前例推定。
   *   這個函式要做的就是讓「下一次判得出來」。
   * ⚠️ **不寫 sessions、不寫 `--out`、不留盒子**——那三件維持原樣。指紋包裡沒有任何一族的命中值本身。
   */
  const writeIncidentAndStop = () => {
    const payload = {
      startedAt, endedAt, base, head,
      promptFile, materialsSha256: createHash('sha256').update(materials).digest('hex'),
      replyLen: reply.length, replySha256: safeSha(reply),   // null＝回覆裡有已知機密，連雜湊都不給
      treeKnown: { blobs: treeKnown.blobs, bytes: treeKnown.bytes, hits: treeKnown.hits.size, skippedBig: treeKnown.skippedBig },
      knownHitsSize: knownHits.size,
      needleCount: needles.length,
      binaries: binaries.map(redactPath),
      sessionFiles: [...snap.files].map(([rp, buf]) => ({ rp: redactPath(rp), bytes: buf.length, sha256: safeSha(buf.toString('utf8')) })),
      hits: incidentHits,
    };
    writeIncident(payload);
    return { code: /** @type {1} */ (1), summary };
  };

  // 去機密（r4 #2）：Grok 讀得到盒內 auth.json（假值＋user_id／時間戳）、可以把任何東西寫進回覆／日誌——回覆會進 PR 描述、日誌會進結果包。
  // 拿真 auth.json 裡**沒給盒子**的每個值去比對每一份輸出；有＝事故（code 1）、不寫 --out、不留 sessions。
  // ⚠️ 誠實劃界：這擋的是「明文出現在輸出裡」；編碼／拆段過的擋不住。broker 之後真 token 從未進盒子，這一段是 defense-in-depth。
  // ⚠️ DLP 與暗號兩族**只記族別與位置，不記雜湊、不記上下文**：它們的命中值由構造已知
  //    （就是 needles[i]／liveSecret），寫衍生物不增加任何判斷力，卻等於把它們的可查表表示留上磁碟。
  if (leaksIn(reply)) { const m = '⚠️ 去機密：grok 的回覆裡出現真 auth.json 裡沒給盒子的值——不寫 --out、不留日誌；這是事故'; say(m); incidentHits.push({ family: 'dlp', where: 'reply', len: 0 }); }
  // 回覆也跑破口線索（Grok 第一次正式掃描抓到：原本只掃 session 檔，盒外內容只寫進最終回覆就退 0 並寫 --out）
  {
    const b = breachHits(reply);
    if (b.live.length || b.shape.length) { const m = `⚠️ 驗屍：grok 的回覆裡出現盒子外才有的內容——沙箱破了，這是事故；不寫 --out${brief(b)}`; say(m); collectBreach(b, 'reply'); }
  }
  for (const [rp, buf] of snap.files) {
    // ⚠️ **檔名本身也是 Grok 寫的內容**：機密只出現在檔名、內容無害時，舊寫法一路走到成功路徑，
    //    把原始檔名接進結果包落盤（Codex #535 r4 端到端重現）。所以名字跟內容用同一套判準。
    {
      const nb = breachHits(rp);
      if (nb.live.length || nb.shape.length) { say(`⚠️ 驗屍：session 檔名 ${redactPath(rp)} 帶著盒子外才有的內容——沙箱破了，這是事故${brief(nb)}`); collectBreach(nb, redactPath(rp)); }
      if (leaksIn(rp)) { say(`⚠️ 去機密：session 檔名 ${redactPath(rp)} 裡出現真 auth.json 裡沒給盒子的值——不留日誌；這是事故`); incidentHits.push({ family: 'dlp', where: redactPath(rp), len: 0 }); }
    }
    let text; try { text = dec.decode(buf); } catch { binaries.push(rp); continue; }   // 非 UTF-8＝驗不了＝**不保存**，不是事故
    const b = breachHits(text);
    // ⚠️ 路徑是 Grok 取的，兩條訊息都會被抄進**公開的** PR 描述 ⇒ 回聲之前一律過同一把尺
    if (b.live.length || b.shape.length) { const m = `⚠️ 驗屍：session 檔 ${redactPath(rp)} 出現盒子外才有的內容——沙箱破了，這是事故${brief(b)}`; say(m); collectBreach(b, redactPath(rp)); }
    if (leaksIn(text)) { const m = `⚠️ 去機密：session 檔 ${redactPath(rp)} 裡出現真 auth.json 裡沒給盒子的值——不留日誌；這是事故`; say(m); incidentHits.push({ family: 'dlp', where: redactPath(rp), len: 0 }); }
  }
  if (binaries.length) log(`（結果包略過 ${binaries.length} 個非 UTF-8 檔——驗不了就不保存：${binaries.slice(0, 3).map((f) => redactPath(f.split('/').pop() ?? f)).join('、')}）`);
  if (incidentHits.length) return writeIncidentAndStop();
  for (const [rp, buf] of snap.files) {
    if (binaries.includes(rp)) continue;
    const to = join(resultsSessions, rp);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 }); writeFileSync(to, buf, { mode: 0o600 });
  }
  // 足跡：對**結果包那份**數（盒子已不再被讀）
  const { dirs, unreadable, why } = allSessionDirs(src, resultsSessions);
  if (!dirs.length) { dropResults(); return failAndClean(`驗屍：找不到這次的 session 日誌（${why || '零 session'}）`); }
  if (unreadable) { dropResults(); return failAndClean(`驗屍：有 session 讀不清楚（${why}）`); }
  let totalFootprints = 0;
  for (const d of dirs) {
    const a = auditSessionDir(d);
    if (a.code === 2) { dropResults(); return failAndClean(`驗屍：session ${d} 日誌讀不清楚：${a.why}`); }
    const n = Object.values(a.calls).reduce((s, v) => s + v, 0);
    totalFootprints += n;
    log(`驗屍 session ${d.split('/').pop()}：工具足跡 ${n} 筆（盒子裡准跑）`);
    say(`足跡 ${n} 筆`);
  }
  if (totalFootprints < GROK_HOME_MANIFEST.reviewSmoke.minToolFootprints) {
    dropResults();
    return failAndClean('驗屍：沒有任何工具足跡——這次掃描只證明 Grok 能回文字，不能證明審查能力沒有降級');
  }
  if (outFile) writeFileSync(outFile, reply);
  const recipe = `base..head=${base}..${head}｜結果包=${resultsDir}（launch.json＋sessions，已比對 ${needles.length} 根 DLP 針）｜沙箱=scripts/grok-sandbox.sb｜轉送器=127.0.0.1:${relayPort}→cli-chat-proxy.grok.com（白名單形狀＋本掃假值）｜${verText}｜掃描起訖=${startedAt}→${endedAt}`;
  log(`\n配方聲明可抄：${recipe}`);
  say(recipe);
  return { code: 0, summary };
  } finally {
    // r4 #4：任何出口（含 throw）都清盒子；轉送器與活金絲雀也在這裡收；r5 #3：grok 整個程序群組也在這裡確定死透
    try {
      await killGroupAndWait(grokPgid);
      try { relay?.kill(); } catch { /* 已死 */ }
      try { if (liveDir) rmSync(liveDir, { recursive: true, force: true }); } catch { /* 已清 */ }
      cleanup();
    } finally {
      // 卸掉本輪 handler；若前面的收尾步驟丟錯，暫存路徑是否仍存在由那個錯誤回報，不在這行保證。
      process.off('SIGTERM', emergency); process.off('SIGINT', emergency);
    }
  }
}

if (isMainModule(import.meta.url)) {
  const ARGS = process.argv.slice(2);
  /** @param {string} flag */
  const arg = (flag) => { const i = ARGS.indexOf(flag); return i >= 0 ? ARGS[i + 1] : undefined; };
  const base = arg('--base'), head = arg('--head'), promptFile = arg('--prompt'), outFile = arg('--out');
  if (!base || !head || !promptFile) { console.error('用法：node scripts/grok-scan.js --base <sha> --head <sha> --prompt <指示檔> [--out <輸出檔>]'); process.exit(2); }
  // ⚠️ 這裡**不要**傳 deps：`ScanDeps` 的每一格預設都是「正式掃描該用的那個值」，尤其 `liveRoot`——
  //    活金絲雀的餌要落在**真家目錄**才有意義（理由見 ScanDeps.liveRoot）。在這一行注入一個
  //    **不是家目錄、且已經存在**的根目錄，餌就搬家，而全套考題照樣綠（Codex #516 r1 對 BOX_ROOT 實測跑過全卷）
  //    ——釘住預設值的那一題直接呼叫 runScan、不經過這個接縫。
  const { code } = await runScan({ base, head, promptFile, outFile });
  process.exit(code);
}
