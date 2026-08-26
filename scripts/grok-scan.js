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
export const EXPECTED_GROK_VERSION = '1.0.3';
/**
 * 釘住執行檔本身（r4 #5：版本字串是被檢者自己印的，wrapper 印「grok 1.0.3」就過；而且 r3 版在**沙箱外**執行它）。
 * 流程：cp 真執行檔進盒子 → 對**盒內副本**算 sha256 → 不等於這個值＝不掃 → `--version` 在**沙箱內**對盒內副本跑。
 * 沒有任何未驗的 grok 在沙箱外執行過。升版＝改這行＋重驗轉送器目的地。
 */
export const EXPECTED_GROK_SHA256 = '09deaf06804955ff2d6ccef2042af4031c659c47fd16eb3c72664a8f533832da';
export { RELAY_PORT };
/** macOS 的 cp -c＝APFS copy-on-write clone（node_modules 1.4 秒、不占空間）；GNU cp 沒有 -c——CI 的 Linux 只跑金絲雀之前的 fail-closed 路徑，普通 cp 就好 */
const CP_CLONE = process.platform === 'darwin' ? ['-c'] : [];

/** sessions 單趟讀取的上限（r6 #3）：超過任何一項＝退 2、不保存 */
export const SESSION_CAPS = Object.freeze({ files: 4000, depth: 12, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });

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
 *   在那裡注入一個根目錄，餌就搬家而全套考題照樣綠（Codex #516 r1 實測）。動那個接縫要另行複核。
 *   ⚠️ 換根目錄不會讓金絲雀落進沙箱看得到的地方——profile 是 deny default，家目錄與使用者暫存區都不在放行清單裡。
 *   ⚠️ 但位置就是這個餌的全部意義：家目錄同時住著真 ~/.grok、~/.grok-sandbox-auth 與真的 store.db，
 *   是破出沙箱的人第一個會翻的地方。搬到別處餌照樣建得起來也照樣清得掉，只是不再演練「家目錄被擋住」——所以預設值不要順手改。
 *   ⚠️ 注入的目錄**必須已經存在**：底下用 mkdtempSync 開子目錄，根目錄不存在時丟出的例外**沒有**被轉成退 2（同 212 行的既有形狀）。
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
  const log = deps.log ?? ((m) => console.log(m));
  /** @type {string[]} */
  const summary = [];
  /** @param {string} why @returns {{ code: 2, summary: string[] }} */
  const fail = (why) => { log(`⛔ ${why}`); summary.push(`⛔ ${why}`); return { code: 2, summary }; };

  const { base, head, promptFile, outFile } = args;
  if (!/^[0-9a-f]{7,40}$/.test(base) || !/^[0-9a-f]{7,40}$/.test(head)) return fail('base／head 必須是寫死的 SHA（條款：不可用會移動的名稱）');
  if (!existsSync(promptFile)) return fail(`指示檔不存在：${promptFile}`);
  if (!existsSync(realGrokBin)) return fail(`找不到 grok：${realGrokBin}`);
  const expectedSha = deps.expectedSha256 ?? EXPECTED_GROK_SHA256;

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
    const { code, lines } = await runCanary(box, { relayPort });
    for (const l of lines) log('  ' + l);
    summary.push(...lines);
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
  } catch (e) { return failAndClean(`DLP 真相來源（${authDir}/auth.json）讀不出來：${/** @type {Error} */ (e).message}——沒有針就不能證明沒外流，不掃`); }
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
    /** @type {string[]} */ const given = [];
    try { for (const n of needles) if (materials.includes(n) || inTree(n)) given.push(n); }
    catch (e) { return failAndClean(`DLP：查針是否已在公開材料裡時失敗：${/** @type {Error} */ (e).message}`); }
    if (given.length) log(`（DLP：${given.length} 根針已在給盒子的材料／原始碼裡出現、不採用——長度 ${given.map((n) => n.length).join('/')}）`);
    needles = needles.filter((n) => !given.includes(n));
    if (!needles.length) return failAndClean('DLP：沒有任何可用的針——不掃');
  }

  // ── 掃描期間放著的金絲雀（第⑤步查它的暗號有沒有出現在日誌）──
  const liveSecret = deps.liveSecret ?? `LIVE-CANARY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // 根目錄可注入（見 ScanDeps.liveRoot）：**預設仍是真家目錄**——金絲雀要放在「真機密真的住的地方」才有意義。
  // 預設值有考題釘著（test/grok-scan-flow.test.js 裡不注入 liveRoot 的那一題：不注入、用每輪隨機暗號
  // 在真家目錄認出自己那一個）；把這一行的 `?? homedir()` 改掉它會紅。
  // ⚠️ 誠實劃界——那一題**只**守 runScan 的預設值，守不到兩件事：
  //    ①它只看得到這**一個**建立點，日後多長一個它看不到；
  //    ②它直接呼叫 runScan，**不涵蓋檔尾 CLI 入口那個接縫**（Codex #516 r1 實測：在那裡注入
  //      `{ liveRoot: … }`，餌搬家而全套考題照樣綠）——動那個接縫要另行複核。
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
  // r4 #1：任何非 regular file（symlink、裝置…）＝Grok 在自己的日誌區放了捷徑，父程序讀它就會替 Grok 跟到盒外。事故（code 1），不是「讀不清楚」。
  if (snap.odd.length) { const m = `⚠️ 驗屍：sessions 裡有 ${snap.odd.length} 個非 regular file（symlink／特殊檔）——Grok 在日誌區放了捷徑，這是事故：${snap.odd.slice(0, 3).join('、')}`; log(m); summary.push(m); return { code: 1, summary }; }
  if (!snap.files.size) return failAndClean('驗屍：找不到這次的 session 日誌（零 session）——沒有日誌＝證明不了它做了什麼');
  // 結果包：先把記憶體那份寫到盒外（父程序之後只讀這份；DLP 驗不了的非 UTF-8 不寫）；中途任何失敗都把它刪掉
  const resultsSessions = join(resultsDir, 'sessions');
  const dropResults = () => { try { rmSync(resultsSessions, { recursive: true, force: true }); } catch { /* 沒建 */ } };
  let worst = 0;
  const dec = new TextDecoder('utf-8', { fatal: true });
  /** @type {string[]} */ const binaries = [];
  const leaksIn = (/** @type {string} */ text) => needles.some((v) => text.includes(v));
  // 破口線索的命中若**已在材料裡**就不算（在輸入裡的字串偵測不了外流——跟 DLP 針同一個原則）：
  // #500 第一次正式掃描就誤中自己——受掃 diff 含破口考題的私鑰字面與這條正則的原文，grok 把材料寫進 prompt_0.txt，
  // 驗屍把「材料裡本來就有的」當「盒子外才有的」。活金絲雀的暗號是隨機的、永遠不在材料裡，所以它不受這條影響。
  // r10（Codex）：私鑰的命中必須**含內容**（標頭後 ≥32 字 base64）——命中只有標頭時，材料裡一句標頭就會把真私鑰整把排掉；
  //   而光有標頭（題名、註解、這行）本來就不是鑰匙。flexToken 的命中本來就含值。
  // 第三次正式掃描：日誌是 JSON 字串，材料裡的 `"`／`\n` 在 chat_history.jsonl 裡是 `\"`／`\\n`，命中跟材料原文對不上。
  //   所以「材料裡本來就有的命中」要對**材料原文、材料的 JSON 轉義版、雙重轉義版**各跑一次同一條正則收集；session 命中不在集合才算。
  //   跨行的鑰匙在 diff 裡每行多一個 `+`——再收一個「去掉 diff 行首記號」的版本（含它的轉義版）。
  const BREACH_SRC = `${liveSecret}|flexToken"\\s*:\\s*"[^"]{8,}|BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----[\\s\\\\]*[A-Za-z0-9+/=\\s\\\\]{32,}`;
  const hitsIn = (/** @type {string} */ text) => [...text.matchAll(new RegExp(BREACH_SRC, 'g'))].map((m) => m[0]);
  /** @type {Set<string>} */ const knownHits = new Set();
  const unprefixed = materials.replace(/^[+ -]/gm, '');
  for (const base0 of [materials, unprefixed]) for (const form of [base0, JSON.stringify(base0), JSON.stringify(JSON.stringify(base0))]) for (const h of hitsIn(form)) knownHits.add(h);
  const breachHits = (/** @type {string} */ text) => hitsIn(text).filter((h) => !knownHits.has(h) && !materials.includes(h));
  // 去機密（r4 #2）：Grok 讀得到盒內 auth.json（假值＋user_id／時間戳）、可以把任何東西寫進回覆／日誌——回覆會進 PR 描述、日誌會進結果包。
  // 拿真 auth.json 裡**沒給盒子**的每個值去比對每一份輸出；有＝事故（code 1）、不寫 --out、不留 sessions。
  // ⚠️ 誠實劃界：這擋的是「明文出現在輸出裡」；編碼／拆段過的擋不住。broker 之後真 token 從未進盒子，這一段是 defense-in-depth。
  if (leaksIn(reply)) { const m = '⚠️ 去機密：grok 的回覆裡出現真 auth.json 裡沒給盒子的值——不寫 --out、不留日誌；這是事故'; log(m); summary.push(m); worst = 1; }
  // 回覆也跑破口線索（Grok 第一次正式掃描抓到：原本只掃 session 檔，盒外內容只寫進最終回覆就退 0 並寫 --out）
  if (breachHits(reply).length) { const m = '⚠️ 驗屍：grok 的回覆裡出現盒子外才有的內容——沙箱破了，這是事故；不寫 --out'; log(m); summary.push(m); worst = 1; }
  for (const [rp, buf] of snap.files) {
    let text; try { text = dec.decode(buf); } catch { binaries.push(rp); continue; }   // 非 UTF-8＝驗不了＝**不保存**，不是事故
    if (breachHits(text).length) { const m = `⚠️ 驗屍：session 檔 ${rp} 出現盒子外才有的內容——沙箱破了，這是事故`; log(m); summary.push(m); worst = 1; }
    if (leaksIn(text)) { const m = `⚠️ 去機密：session 檔 ${rp} 裡出現真 auth.json 裡沒給盒子的值——不留日誌；這是事故`; log(m); summary.push(m); worst = 1; }
  }
  if (binaries.length) log(`（結果包略過 ${binaries.length} 個非 UTF-8 檔——驗不了就不保存：${binaries.slice(0, 3).map((f) => f.split('/').pop()).join('、')}）`);
  if (worst) return { code: 1, summary };
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
    summary.push(`足跡 ${n} 筆`);
  }
  if (totalFootprints < GROK_HOME_MANIFEST.reviewSmoke.minToolFootprints) {
    dropResults();
    return failAndClean('驗屍：沒有任何工具足跡——這次掃描只證明 Grok 能回文字，不能證明審查能力沒有降級');
  }
  if (outFile) writeFileSync(outFile, reply);
  const recipe = `base..head=${base}..${head}｜結果包=${resultsDir}（launch.json＋sessions，已比對 ${needles.length} 根 DLP 針）｜沙箱=scripts/grok-sandbox.sb｜轉送器=127.0.0.1:${relayPort}→cli-chat-proxy.grok.com（白名單形狀＋本掃假值）｜${verText}｜掃描起訖=${startedAt}→${endedAt}`;
  log(`\n配方聲明可抄：${recipe}`);
  summary.push(recipe);
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
