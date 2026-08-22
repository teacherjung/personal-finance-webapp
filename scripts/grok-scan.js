#!/usr/bin/env node
// @ts-check
// **Grok 複審後掃：一支到底**（William 2026-08-22 裁示 B＋中間路；r1 重做：Codex 抓到四種假成功）。
//
// 把整條流程串成一支，讓「忘了某一步」變成做不到：
//   ①建盒子（git archive 已 commit 的原始碼＋APFS clone 的 node_modules；沒有 data/store.db、沒有 .env）
//   ②金絲雀（沙箱的紅燈證明；任何一隻活著＝不掃，fail-closed）
//   ③起轉送器（localhost → xAI 那一個寫死的位址），**並持續監看它有沒有死**
//   ④在沙箱裡跑 grok（env 白名單、HOME／TMPDIR 指進盒子、GROK_HOME 指真家）
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
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCanary, sandboxEnv, PROFILE, RELAY_PORT } from './grok-sandbox-canary.js';
import { auditSessionDir, allSessionDirs } from './audit-grok-scan.js';
import { gitEnv } from '../lib/git-env.js';
import { isMainModule } from '../lib/is-main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
/** 轉送器的目的地是從這個版本的執行檔 strings 出來的；版本不同＝當未跑（條款）。**精確比對**，不用前綴（r2：前綴讓 wrapper 印一行就過） */
export const EXPECTED_GROK_VERSION = '1.0.3';
export { RELAY_PORT };

/**
 * @typedef {object} ScanDeps 可注入的依賴——考題用假的 grok／轉送器／session 根目錄跑主流程
 * @property {string} [repo]
 * @property {string} [grokInstall] 預設 ~/.grok＝安裝樹，**完全不進沙箱**。只從它白名單複製四個檔進盒子
 *   （bin/grok、config.toml、agent_id；auth.json 走沙箱專用目錄）；考題注入假的（bin/grok 是假 grok）。
 *   r2 放行整棵唯讀＋clone 整棵：歷史 sessions 仍可讀、憑證整包落在 /private/tmp——Codex r3 抓到。
 * @property {string} [authDir] 預設 ~/.grok-sandbox-auth（0700，只含 auth.json）：沙箱跑的 grok 用這份登入狀態，
 *   第一次從真 ~/.grok/auth.json 種、每掃同步回來（盒內 refresh 過的 token 才會保留到下一掃）；真 auth.json 不動。
 * @property {string} [resultsRoot] 預設 ~/.grok-scan-results：掃完只留去機密的結果包（launch.json＋sessions），盒子整個清掉
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

  // ── 版本釘（條款：版本不同＝當未跑）。在沙箱外跑，所以執行檔必須來自沙箱裡**唯讀**的安裝樹（r2 #2）。
  //    env 用白名單、不繼承（r2：沙箱外執行的東西也不該拿到呼叫者的 token）；解析後**精確等於**，不用前綴。
  const ver = spawnSync(realGrokBin, ['--version'], { encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: homedir() } });
  const verText = (ver.stdout || '').trim();
  const parsed = /^grok (\S+)/.exec(verText)?.[1];
  if (ver.status !== 0 || parsed !== EXPECTED_GROK_VERSION) return fail(`grok 版本不符：要 ${EXPECTED_GROK_VERSION}，實際「${verText || ver.error?.message || ver.status}」——轉送器目的地是從那個版本 strings 出來的，升版要重驗`);

  // ── ① 建盒子 ──
  const box = realpathSync(mkdtempSync(`/private/tmp/grok-scan-${head.slice(0, 7)}-`));
  const src = join(box, 'src');
  mkdirSync(src); mkdirSync(join(box, 'tmp'));
  log(`盒子：${box}`);
  // 盒子在**所有出口**都要清（r3 #4：r2 沒清＝每掃在 /private/tmp 留一份憑證副本）；只留去機密的結果包
  const grokHome = join(box, 'grok-home');
  const sessionsRoot = join(grokHome, 'sessions');
  const resultsDir = join(resultsRoot, `${head.slice(0, 7)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  /** @param {string} why @returns {{ code: 2, summary: string[] }} */
  const failAndClean = (why) => { cleanup(); return fail(why); };
  const cleanup = () => {
    try {
      mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
      for (const f of ['launch.json']) { if (existsSync(join(box, f))) spawnSync('/bin/cp', [join(box, f), resultsDir]); }
      if (existsSync(sessionsRoot)) spawnSync('/bin/cp', ['-R', sessionsRoot, join(resultsDir, 'sessions')]);
      // 盒內 auth.json 若被 grok refresh 過，同步回沙箱專用 auth 目錄（不碰真 ~/.grok）
      if (existsSync(join(grokHome, 'auth.json'))) spawnSync('/bin/cp', [join(grokHome, 'auth.json'), join(authDir, 'auth.json')]);
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  };
  // grok 的家＝**白名單複製**（r3：不 clone 整棵——那會把歷史 sessions 與憑證整包搬進來）
  {
    mkdirSync(join(grokHome, 'bin'), { recursive: true }); mkdirSync(sessionsRoot);
    const c = spawnSync('/bin/cp', ['-c', realGrokBin, join(grokHome, 'bin', 'grok')], { encoding: 'utf8' });   // APFS clone，127MB 免費
    if (c.status !== 0) return failAndClean(`grok 執行檔 clone 失敗：${c.stderr}`);
    for (const f of ['config.toml', 'agent_id']) {
      if (existsSync(join(grokInstall, f))) spawnSync('/bin/cp', [join(grokInstall, f), join(grokHome, f)]);
    }
    // 登入狀態：沙箱專用目錄（0700、只含 auth.json）；第一次從真的種
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    if (!existsSync(join(authDir, 'auth.json'))) {
      if (!existsSync(join(grokInstall, 'auth.json'))) return failAndClean(`找不到登入狀態：${join(grokInstall, 'auth.json')} 也沒有——先在沙箱外登入一次`);
      spawnSync('/bin/cp', [join(grokInstall, 'auth.json'), join(authDir, 'auth.json')]);
    }
    spawnSync('/bin/cp', [join(authDir, 'auth.json'), join(grokHome, 'auth.json')]);
  }
  const grokBin = join(grokHome, 'bin', 'grok');   // 沙箱裡跑**盒內**的副本
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
  const liveDir = mkdtempSync(join(homedir(), '.grok-live-canary-'));
  writeFileSync(join(liveDir, 'store.db'), liveSecret + '\n');

  // ── ③ 轉送器（監看它的生死）──
  const relay = spawn(process.execPath, [relayScript, String(RELAY_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let relayDead = /** @type {string | null} */ (null);
  let relayErr = '';
  relay.stderr?.on('data', (d) => { relayErr += String(d); });
  relay.on('exit', (c, sig) => { relayDead = `轉送器退出（code ${c}, signal ${sig}）${relayErr.trim() ? `：${relayErr.trim().slice(-200)}` : ''}`; });
  const ready = await new Promise((ok) => {
    const t = setTimeout(() => ok(false), 5000);
    relay.stdout?.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(t); ok(true); } });
    relay.on('exit', () => { clearTimeout(t); ok(false); });
  });
  if (!ready) { rmSync(liveDir, { recursive: true, force: true }); return failAndClean(`轉送器沒有 READY（${relayDead ?? '5 秒逾時'}）`); }

  // ── ④ 沙箱裡跑 grok ──
  const startedAt = new Date().toISOString();
  log(`掃描開始：${startedAt}（在通過之後才掃＝條款；時序要自己記進 PR）`);
  const sbArgv = ['-f', PROFILE, '-D', `SCAN_DIR=${box}`, '-D', `RELAY_PORT=${RELAY_PORT}`];
  const grokArgv = [grokBin, '--disable-web-search', '--no-subagents', '-p', '<materials>'];
  const env = { ...sandboxEnv(box), GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${RELAY_PORT}/v1` };
  // 發射紀錄留檔（#495 那次事後分不出「旗標失效」還是「根本沒帶旗標」——claude-bd 2026-08-22 建議）：
  // 完整指令、env 白名單、版本、沙箱設定檔的雜湊。之後驗屍或重裁都有憑據，不靠回憶。
  writeFileSync(join(box, 'launch.json'), JSON.stringify({
    startedAt, base, head, sandboxExec: '/usr/bin/sandbox-exec', sbArgv, grokArgv, env, grokVersion: verText,
    profileSha256: createHash('sha256').update(readFileSync(PROFILE)).digest('hex'),
    materialsSha256: createHash('sha256').update(materials).digest('hex'),
  }, null, 2));
  // ⚠️ 不用 spawnSync：它卡住事件迴圈，轉送器的 exit 事件要等 grok 結束後才派發，
  //    「轉送器中途死」就永遠量不到（r2 的行為題抓到：假轉送器 READY 後 200ms 死、假 grok 回 0，結果退 0）。
  const grok = await new Promise((resolve) => {
    const child = spawn('/usr/bin/sandbox-exec', [...sbArgv, grokBin, '--disable-web-search', '--no-subagents', '-p', materials], {
      cwd: src, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000);
    child.on('error', (e) => { clearTimeout(t); resolve({ status: null, signal: null, error: e, stdout, stderr }); });
    child.on('close', (status, signal) => { clearTimeout(t); resolve({ status, signal, error: undefined, stdout, stderr }); });
  });
  const endedAt = new Date().toISOString();
  relay.kill();
  rmSync(liveDir, { recursive: true, force: true });
  const reply = grok.stdout || '';
  if (outFile) writeFileSync(outFile, reply);
  log(`掃描結束：${endedAt}；grok 退出碼 ${grok.status}；回覆 ${reply.length} 字${outFile ? `，已寫 ${outFile}` : ''}`);
  // 轉送器在 grok 結束前死了＝一律 2（r2 #3：r1 寫成 `relayDead && grok.status !== 0`，grok 自己回 0 就放過了）
  if (relayDead) return failAndClean(`轉送器在掃描結束前死了：${relayDead}；grok 退出碼 ${grok.status}`);
  if (grok.status !== 0) return failAndClean(`grok 沒有正常結束（status ${grok.status}${grok.signal ? `, signal ${grok.signal}` : ''}${grok.error ? `, ${grok.error.message}` : ''}）：${(grok.stderr || '').slice(-400)}`);
  if (!reply.trim()) return failAndClean('grok 退 0 但回覆是空的');

  // ── ⑤ 驗屍：足跡＋破口線索 ──
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
    if (g.status === 0) { log(`⚠️ 驗屍：session ${d} 的日誌出現盒子外才有的內容——沙箱破了，這是事故`); worst = 1; }
    else if (g.status !== 1) return failAndClean(`驗屍：grep 自己失敗（status ${g.status}）：${g.stderr}`);
  }
  const recipe = `base..head=${base}..${head}｜結果包=${resultsDir}（launch.json＋sessions，去機密）｜沙箱=scripts/grok-sandbox.sb｜轉送器=127.0.0.1:${RELAY_PORT}→cli-chat-proxy.grok.com｜${verText}｜掃描起訖=${startedAt}→${endedAt}`;
  log(`\n配方聲明可抄：${recipe}`);
  summary.push(recipe);
  cleanup();   // 成功路徑也清：盒子（含憑證副本）不留在 /private/tmp
  return { code: /** @type {0|1} */ (worst), summary };
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
