#!/usr/bin/env node
// @ts-check
// **Grok 複審後掃：一支到底**（William 2026-08-22 裁示 B＋中間路；r1 重做：Codex 抓到四種假成功）。
//
// 把整條流程串成一支，讓「忘了某一步」變成做不到：
//   ①建盒子（git archive 已 commit 的原始碼＋APFS clone 的 node_modules；沒有 data/store.db、沒有 .env）
//   ②金絲雀（沙箱的紅燈證明；任何一隻活著＝不掃，fail-closed）
//   ③起轉送器（localhost → xAI 那一個寫死的位址），**並持續監看它有沒有死**
//   ④在沙箱裡跑 grok（env 白名單、HOME／TMPDIR／GROK_HOME 全指進盒子；盒內 auth 的 token 是**假的**，轉送器在沙箱外換真的）
//   ⑤驗屍：數足跡（在盒子裡跑指令是准的）＋查破口線索（掃描期間**一直放著**的金絲雀暗號有沒有出現在日誌裡）
//
// ## fail-closed（r1 之後每一步都有）
//   grok 版本不符／金絲雀非 0／轉送器沒 READY 或中途死／grok 退出碼非 0 或 null／零 session／日誌讀不清楚／
//   grep 自己失敗／node_modules 複製後不是真目錄／盒子裡出現不該有的檔 ⇒ 一律退 2，**不退 0**。
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
// ・本腳本不決定掃描時機（條款：Codex 通過之後、gh pr ready 之前）；它只負責「掃的時候有圍欄」。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCanary, sandboxEnv, PROFILE, RELAY_PORT } from './grok-sandbox-canary.js';
import { auditSessionDir, allSessionDirs } from './audit-grok-scan.js';
import { gitEnv } from '../lib/git-env.js';
import { refreshSandboxAuth } from './grok-auth-refresh.js';
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

/**
 * SIGKILL 整個程序群組，並等到群裡沒有任何程序（kill(-pgid, 0) 回 ESRCH）。
 * @param {number | null} pgid
 */
async function killGroupAndWait(pgid) {
  if (!pgid) return;
  for (let i = 0; i < 200; i++) {   // 最多 ~10 秒
    try { process.kill(-pgid, 'SIGKILL'); } catch { return; }   // ESRCH＝群已空
    try { process.kill(-pgid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`grok 的程序群組 ${pgid} 10 秒內殺不乾淨——不碰盒子`);
}

/**
 * @typedef {object} ScanDeps 可注入的依賴——考題用假的 grok／轉送器／session 根目錄跑主流程
 * @property {string} [repo]
 * @property {string} [grokInstall] 預設 ~/.grok＝安裝樹，**完全不進沙箱**。只從它白名單複製四個檔進盒子
 *   （bin/grok、config.toml、agent_id；auth.json 走沙箱專用目錄）；考題注入假的（bin/grok 是假 grok）。
 *   r2 放行整棵唯讀＋clone 整棵：歷史 sessions 仍可讀、憑證整包落在 /private/tmp——Codex r3 抓到。
 * @property {string} [authDir] 預設 ~/.grok-sandbox-auth（0700，只含 auth.json）：沙箱跑的 grok 用這份登入狀態，
 *   第一次從真 ~/.grok/auth.json 種；**掃描前由父程序做 OIDC refresh**（沙箱裡連不到 auth.x.ai，grok 自己 refresh 不了——
 *   r4 端對端實際踩到：token 六小時過期後「auth_kind=none」）；盒內只放**去掉 refresh_token 的短效版本**，
 *   所以**不再有掃後同步**（盒內沒有長效憑證，沒東西要同步回來——r4 #3 的整族問題由構造消失）；真 auth.json 不動。
 * @property {typeof fetch} [fetchImpl] 考題注入假 fetch 給 refresh 用
 * @property {string} [resultsRoot] 預設 ~/.grok-scan-results：掃完只留去機密的結果包（launch.json＋sessions），盒子整個清掉
 * @property {string} [expectedSha256] 預設 EXPECTED_GROK_SHA256；考題用假 grok 時傳它自己的 hash
 * @property {(msg: string) => void} [log]
 * @property {string} [relayScript]
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
  const realGrokBin = realpathSync(join(grokInstall, 'bin', 'grok'));   // 沙箱外跑 --version 用**真**執行檔（Grok 碰不到它）
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
  const box = realpathSync(mkdtempSync(`/private/tmp/grok-scan-${head.slice(0, 7)}-`));
  const src = join(box, 'src');
  mkdirSync(src); mkdirSync(join(box, 'tmp'));
  log(`盒子：${box}`);
  // 盒子在**所有出口**都要清（r3 #4：r2 沒清＝每掃在 /private/tmp 留一份憑證副本）；只留去機密的結果包。
  // r4 #1／#4：①結果檔（launch.json）由父程序**直接寫在盒外**的結果包——不經盒子，Grok 改不到；
  //   ②sessions 的複製逐層 lstat、只收 regular file，拒 symlink／特殊檔（父程序在沙箱外，會替 Grok 跟隨捷徑＝confused deputy）；
  //   ③整段流程包在 try/finally，任何 throw 都走 cleanup（r3 版 --out 指到寫不進去的地方就 throw、盒子留著）。
  const grokHome = join(box, 'grok-home');
  const sessionsRoot = join(grokHome, 'sessions');
  const resultsDir = join(resultsRoot, `${head.slice(0, 7)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  /** 盒內 → 結果包：只收 regular file，不跟 symlink（lstat）；任何非 regular 一律跳過並記 */
  const copyRegularTree = (/** @type {string} */ from, /** @type {string} */ to) => {
    const skipped = [];
    const walk = (/** @type {string} */ f, /** @type {string} */ t) => {
      const st = lstatSync(f);
      if (st.isDirectory()) { mkdirSync(t, { recursive: true }); for (const n of readdirSync(f)) walk(join(f, n), join(t, n)); }
      else if (st.isFile()) writeFileSync(t, readFileSync(f));
      else skipped.push(f);
    };
    if (existsSync(from)) walk(from, to);
    return skipped;
  };
  let cleaned = false;
  let keepSessions = false;   // r5 #1：只有走完 DLP 的成功路徑才設 true——其餘出口一律丟棄盒內輸出
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    try {
      if (keepSessions) {
        const skipped = copyRegularTree(sessionsRoot, join(resultsDir, 'sessions'));
        if (skipped.length) log(`⚠️ 結果包略過 ${skipped.length} 個非 regular file（symlink／特殊檔）：${skipped.slice(0, 3).join('、')}`);
      }
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  };
  /** @param {string} why @returns {{ code: 2, summary: string[] }} */
  const failAndClean = (why) => { cleanup(); return fail(why); };
  // grok 的家＝**白名單複製**（r3：不 clone 整棵——那會把歷史 sessions 與憑證整包搬進來）
  const grokBin = join(grokHome, 'bin', 'grok');   // 沙箱裡跑**盒內**的副本
  /** @type {string} */ let verText;
  /** @type {Record<string, unknown>} */ let authBefore;
  /** @type {import('node:child_process').ChildProcess | undefined} */ let relay;
  /** @type {string | undefined} */ let liveDir;
  /** @type {number | null} */ let grokPgid = null;
  try {
  {
    mkdirSync(join(grokHome, 'bin'), { recursive: true }); mkdirSync(sessionsRoot);
    const c = spawnSync('/bin/cp', ['-c', realGrokBin, grokBin], { encoding: 'utf8' });   // APFS clone，127MB 免費
    if (c.status !== 0) return failAndClean(`grok 執行檔 clone 失敗：${c.stderr}`);
    // r4 #5：對**盒內副本**算 hash（不是真檔——檢查與複製之間的路徑替換競態）；不符＝不掃；之後只執行這份副本
    const sha = createHash('sha256').update(readFileSync(grokBin)).digest('hex');
    if (sha !== expectedSha) return failAndClean(`grok 執行檔 sha256 不符：要 ${expectedSha.slice(0, 12)}…，實際 ${sha.slice(0, 12)}…——執行檔被換過或升版了；升版要改 EXPECTED_GROK_SHA256 並重驗轉送器目的地`);
    // r5 #2a：從真 ~/.grok 搬進盒子的檔，逐檔 lstat（no-follow）＋大小上限——白名單檔名不是白名單內容；
    //   先前未隔離的 Grok 可能把 config.toml 做成指向盒外私密檔的 symlink，父程序盲 cp 就替它帶進盒子
    const copyRegularSmall = (/** @type {string} */ name, /** @type {number} */ maxBytes) => {
      const from = join(grokInstall, name);
      if (!existsSync(from)) { log(`（${name} 不在安裝樹，略過——grok 會用預設）`); return null; }
      const st = lstatSync(from);
      if (!st.isFile()) return `安裝樹的 ${name} 不是 regular file（symlink／特殊檔）——不搬`;
      if (st.size > maxBytes) return `安裝樹的 ${name} 超過 ${maxBytes} bytes——不搬`;
      writeFileSync(join(grokHome, name), readFileSync(from), { mode: 0o600 });
      return null;
    };
    for (const [name, max] of /** @type {[string, number][]} */ ([['config.toml', 64 * 1024], ['agent_id', 1024]])) {
      const why = copyRegularSmall(name, max);
      if (why) return failAndClean(why);
    }
    // 登入狀態：沙箱專用目錄（0700、只含 auth.json）；第一次從真的種；目錄已存在也把 mode 修成 0700（mkdir 的 mode 不會改既有目錄）
    mkdirSync(authDir, { recursive: true, mode: 0o700 }); chmodSync(authDir, 0o700);
    if (!existsSync(join(authDir, 'auth.json'))) {
      const seed = join(grokInstall, 'auth.json');
      if (!existsSync(seed)) return failAndClean(`找不到登入狀態：${seed} 也沒有——先在沙箱外登入一次`);
      const st = lstatSync(seed);
      if (!st.isFile() || st.size > 64 * 1024) return failAndClean(`安裝樹的 auth.json 不是 regular file 或超過 64KB——不種`);
      writeFileSync(join(authDir, 'auth.json'), readFileSync(seed), { mode: 0o600 });
    }
    // 父程序 refresh（沙箱外、可信程式、不是 grok）；盒內只放短效版本
    try {
      const a = await refreshSandboxAuth(authDir, { fetchImpl: deps.fetchImpl, log });
      authBefore = a.forBox;
      writeFileSync(join(grokHome, 'auth.json'), JSON.stringify(a.forBox), { mode: 0o600 });
    } catch (e) { return failAndClean(`憑證 refresh 失敗：${/** @type {Error} */ (e).message}`); }
  }
  // ── 版本釘：在**沙箱內**對盒內副本跑（r4 #5：r3 版在沙箱外執行真檔＝未驗身分的程式拿到完整檔案系統）──
  {
    const ver = spawnSync('/usr/bin/sandbox-exec', ['-f', PROFILE, '-D', `SCAN_DIR=${box}`, '-D', `RELAY_PORT=${RELAY_PORT}`, grokBin, '--version'],
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
    const c = spawnSync('/bin/cp', ['-Rc', nmReal, join(src, 'node_modules')], { encoding: 'utf8' });
    if (c.status !== 0) return failAndClean(`node_modules clone 失敗：${c.stderr}`);
    const st = lstatSync(join(src, 'node_modules'));
    if (!st.isDirectory() || st.isSymbolicLink()) return failAndClean('盒子裡的 node_modules 不是真目錄（symlink 指回家目錄＝沙箱裡讀不到）');
    if (!existsSync(join(src, 'node_modules', 'eslint'))) return failAndClean('盒子裡的 node_modules 少了套件（clone 沒跟隨 symlink？）');
    for (const forbidden of ['data/store.db', 'data/store.json', '.env', '.env.local']) {
      if (existsSync(join(src, forbidden))) return failAndClean(`盒子裡出現不該有的檔：${forbidden}——git archive 不該帶出它，先查 .gitignore`);
    }
  }

  // ── ② 金絲雀（fail-closed）──
  {
    const { code, lines } = await runCanary(box);
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

  // ── 掃描期間放著的金絲雀（第⑤步查它的暗號有沒有出現在日誌）──
  const liveSecret = `LIVE-CANARY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  liveDir = mkdtempSync(join(homedir(), '.grok-live-canary-'));
  writeFileSync(join(liveDir, 'store.db'), liveSecret + '\n');

  // ── ③ 轉送器（監看它的生死）──
  const relayProc = spawn(process.execPath, [relayScript, String(RELAY_PORT), '--auth-dir', authDir], { stdio: ['ignore', 'pipe', 'pipe'] });   // broker：真 token 只在轉送器手上
  relay = relayProc;
  let relayDead = /** @type {string | null} */ (null);
  let relayErr = '';
  relayProc.stderr?.on('data', (d) => { relayErr += String(d); });
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
  const sbArgv = ['-f', PROFILE, '-D', `SCAN_DIR=${box}`, '-D', `RELAY_PORT=${RELAY_PORT}`];
  const grokArgv = [grokBin, '--disable-web-search', '--no-subagents', '-p', '<materials>'];
  const env = { ...sandboxEnv(box), GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${RELAY_PORT}/v1` };
  // 發射紀錄留檔（#495 那次事後分不出「旗標失效」還是「根本沒帶旗標」——claude-bd 2026-08-22 建議）：
  // 完整指令、env 白名單、版本、沙箱設定檔的雜湊。之後驗屍或重裁都有憑據，不靠回憶。
  writeFileSync(join(resultsDir, 'launch.json'), JSON.stringify({
    startedAt, base, head, sandboxExec: '/usr/bin/sandbox-exec', sbArgv, grokArgv, env, grokVersion: verText,
    profileSha256: createHash('sha256').update(readFileSync(PROFILE)).digest('hex'),
    materialsSha256: createHash('sha256').update(materials).digest('hex'),
  }, null, 2));
  // ⚠️ 不用 spawnSync：它卡住事件迴圈，轉送器的 exit 事件要等 grok 結束後才派發，
  //    「轉送器中途死」就永遠量不到（r2 的行為題抓到：假轉送器 READY 後 200ms 死、假 grok 回 0，結果退 0）。
  // r5 #3：grok 跑在**自己的程序群組**（detached＝setsid）。結束後先 SIGKILL 整群、等到群裡沒人，父程序才碰盒內任何東西
  //   ——否則盒內留一個背景 writer，等我們 lstat 完再換檔（TOCTOU），或持有 token FD 繼續活。
  //   輸出設上限（r5：無界字串＝OOM 繞過 finally）。
  const OUT_CAP = 8 * 1024 * 1024;
  const grok = await new Promise((resolve) => {
    const child = spawn('/usr/bin/sandbox-exec', [...sbArgv, grokBin, '--disable-web-search', '--no-subagents', '-p', materials], {
      cwd: src, stdio: ['ignore', 'pipe', 'pipe'], env, detached: true,
    });
    grokPgid = child.pid ?? null;
    let stdout = '', stderr = '', truncated = false;
    child.stdout.on('data', (d) => { if (stdout.length < OUT_CAP) stdout += d; else truncated = true; });
    child.stderr.on('data', (d) => { if (stderr.length < OUT_CAP) stderr += d; else truncated = true; });
    const t = setTimeout(() => { if (grokPgid) try { process.kill(-grokPgid, 'SIGKILL'); } catch { /* 已死 */ } }, 30 * 60_000);
    child.on('error', (e) => { clearTimeout(t); resolve({ status: null, signal: null, error: e, stdout, stderr, truncated }); });
    child.on('close', (status, signal) => { clearTimeout(t); resolve({ status, signal, error: undefined, stdout, stderr, truncated }); });
  });
  await killGroupAndWait(grokPgid);
  const endedAt = new Date().toISOString();
  const reply = grok.stdout || '';
  log(`掃描結束：${endedAt}；grok 退出碼 ${grok.status}；回覆 ${reply.length} 字；程序群組已收束`);
  // 轉送器在 grok 結束前死了＝一律 2（r2 #3：r1 寫成 `relayDead && grok.status !== 0`，grok 自己回 0 就放過了）
  // r5 #1：失敗＝**全丟棄**。Grok 可控的 stdout／stderr／sessions 一律不進結果包、不進 log（stderr 尾巴也是它可控的）。
  //   「可保存」是成功路徑最後才出現的顯式狀態（見下方 DLP 之後的 keepSessions）。
  if (grok.truncated) return failAndClean(`grok 輸出超過 ${OUT_CAP} bytes——丟棄`);
  if (relayDead) return failAndClean(`轉送器在掃描結束前死了：${relayDead}；grok 退出碼 ${grok.status}（輸出已丟棄）`);
  if (grok.status !== 0) return failAndClean(`grok 沒有正常結束（status ${grok.status}${grok.signal ? `, signal ${grok.signal}` : ''}${grok.error ? `, ${grok.error.message}` : ''}）——輸出已丟棄，不印`);
  if (!reply.trim()) return failAndClean('grok 退 0 但回覆是空的');

  // ── ⑤ 驗屍：足跡＋破口線索 ──
  // r4 #1：先掃 sessions 樹——任何非 regular file／目錄（symlink、裝置…）＝Grok 在自己的日誌區放了捷徑，
  //        父程序（驗屍、複製）讀它就會替 Grok 跟到盒外。這本身就是事故（code 1），不是「讀不清楚」。
  {
    const odd = [];
    const walk = (/** @type {string} */ d) => { for (const n of readdirSync(d)) { const f = join(d, n); const st = lstatSync(f); if (st.isDirectory()) walk(f); else if (!st.isFile()) odd.push(f); } };
    if (existsSync(sessionsRoot)) walk(sessionsRoot);
    if (odd.length) { const m = `⚠️ 驗屍：sessions 裡有 ${odd.length} 個非 regular file（symlink／特殊檔）——Grok 在日誌區放了捷徑，這是事故：${odd.slice(0, 3).join('、')}`; log(m); summary.push(m); rmSync(sessionsRoot, { recursive: true, force: true }); return { code: 1, summary }; }
  }
  const { dirs, unreadable, why } = allSessionDirs(src, sessionsRoot);
  if (!dirs.length) return failAndClean(`驗屍：找不到這次的 session 日誌（${why || '零 session'}）——沒有日誌＝證明不了它做了什麼`);
  if (unreadable) return failAndClean(`驗屍：有 session 讀不清楚（${why}）`);
  let worst = 0;
  for (const d of dirs) {
    const a = auditSessionDir(d);
    if (a.code === 2) return failAndClean(`驗屍：session ${d} 日誌讀不清楚：${a.why}`);
    const n = Object.values(a.calls).reduce((s, v) => s + v, 0);
    log(`驗屍 session ${d.split('/').pop()}：工具足跡 ${n} 筆（盒子裡准跑）`);
    summary.push(`足跡 ${n} 筆`);
    // 破口線索：掃描期間放在家目錄的暗號、以及幾種明文機密形狀（heuristic，見檔頭劃界）
    const g = spawnSync('/usr/bin/grep', ['-rlE', `${liveSecret}|flexToken"\\s*:\\s*"[^"]{8,}|BEGIN (RSA|OPENSSH) PRIVATE KEY`, d], { encoding: 'utf8' });
    if (g.status === 0) { const m = `⚠️ 驗屍：session ${d.split('/').pop()} 的日誌出現盒子外才有的內容——沙箱破了，這是事故`; log(m); summary.push(m); worst = 1; }
    else if (g.status !== 1) return failAndClean(`驗屍：grep 自己失敗（status ${g.status}）：${g.stderr}`);
  }
  // ── 去機密（r4 #2）：Grok 讀得到自己的 auth.json，可以把 token 寫進回覆／日誌——回覆會進 PR 描述、日誌會進結果包。
  //    拿**本次已知的憑證值**去比對每一份輸出；有＝事故（code 1）、不寫 --out、不留 sessions。
  //    ⚠️ 誠實劃界：這擋的是「明文出現在輸出裡」；編碼／拆段過的擋不住。而且 token 在走轉送器時就已到 xAI
  //    ——那是它自己發的 token，不算外流；真正要防的是它被帶出盒子進到 GitHub／磁碟。
  // 本次已知的憑證值＝盒內 auth.json 裡 ≥16 字的字串（access token、id 等）；refresh_token 不在盒內，但也一併比對 authDir 那份
  const authDirVals = (() => { try { return Object.values(JSON.parse(readFileSync(join(authDir, 'auth.json'), 'utf8'))); } catch { return []; } })();
  const secretValues = [...Object.values(authBefore), ...authDirVals].flatMap((v) => (typeof v === 'string' && v.length >= 16 ? [v] : typeof v === 'object' && v ? Object.values(v).filter((x) => typeof x === 'string' && x.length >= 16) : []));
  const leaksIn = (/** @type {string} */ text) => secretValues.some((v) => text.includes(v));
  if (leaksIn(reply)) { const m = '⚠️ 去機密：grok 的回覆裡出現登入憑證的值——不寫 --out、不留日誌；這是事故'; log(m); summary.push(m); worst = 1; }
  // 遞迴整棵 sessions（r5 #1：原本只掃根層，terminal/call-*.log 這種巢狀日誌漏掉）；no-follow；fatal decode（解不開＝不保存）
  {
    const dec = new TextDecoder('utf-8', { fatal: true });
    const walk = (/** @type {string} */ d) => {
      for (const n of readdirSync(d)) {
        const fp = join(d, n); const st = lstatSync(fp);
        if (st.isDirectory()) { if (walk(fp)) return true; continue; }
        if (!st.isFile()) continue;   // 非 regular 已在驗屍前擋成事故；這裡防禦性跳過
        let text; try { text = dec.decode(readFileSync(fp)); } catch { const m = `⚠️ 去機密：session 檔 ${fp.split('/').slice(-2).join('/')} 不是合法 UTF-8——不保存`; log(m); summary.push(m); worst = 1; return true; }
        if (leaksIn(text)) { const m = `⚠️ 去機密：session 檔 ${fp.split('/').slice(-2).join('/')} 裡出現登入憑證的值——不留日誌；這是事故`; log(m); summary.push(m); worst = 1; return true; }
      }
      return false;
    };
    if (existsSync(sessionsRoot)) walk(sessionsRoot);
  }
  if (worst === 0 && outFile) writeFileSync(outFile, reply);
  // （r4 之後沒有「掃後同步 auth」：盒內是去掉 refresh_token 的短效版本，長效的只住在 authDir、由掃描前的 refresh 維護）
  keepSessions = worst === 0;   // 事故：日誌不進結果包；成功：這是唯一把「可保存」設成 true 的地方
  const recipe = `base..head=${base}..${head}｜結果包=${resultsDir}（launch.json＋sessions，已比對憑證值）｜沙箱=scripts/grok-sandbox.sb｜轉送器=127.0.0.1:${RELAY_PORT}→cli-chat-proxy.grok.com｜${verText}｜掃描起訖=${startedAt}→${endedAt}`;
  log(`\n配方聲明可抄：${recipe}`);
  summary.push(recipe);
  return { code: /** @type {0|1} */ (worst), summary };
  } finally {
    // r4 #4：任何出口（含 throw）都清盒子；轉送器與活金絲雀也在這裡收；r5 #3：grok 整個程序群組也在這裡確定死透
    await killGroupAndWait(grokPgid);
    try { relay?.kill(); } catch { /* 已死 */ }
    try { if (liveDir) rmSync(liveDir, { recursive: true, force: true }); } catch { /* 已清 */ }
    cleanup();
  }
}

if (isMainModule(import.meta.url)) {
  const ARGS = process.argv.slice(2);
  /** @param {string} flag */
  const arg = (flag) => { const i = ARGS.indexOf(flag); return i >= 0 ? ARGS[i + 1] : undefined; };
  const base = arg('--base'), head = arg('--head'), promptFile = arg('--prompt'), outFile = arg('--out');
  if (!base || !head || !promptFile) { console.error('用法：node scripts/grok-scan.js --base <sha> --head <sha> --prompt <指示檔> [--out <輸出檔>]'); process.exit(2); }
  const { code } = await runScan({ base, head, promptFile, outFile });
  process.exit(code);
}
