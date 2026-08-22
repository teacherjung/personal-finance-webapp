#!/usr/bin/env node
// @ts-check
// **Grok 複審後掃：一支到底**（William 2026-08-22 裁示 B＋中間路）。
//
// 把整條流程串成一支，讓「忘了某一步」變成做不到：
//   ①建盒子（git archive 已 commit 的原始碼＋APFS clone 的 node_modules；沒有 data/store.db、沒有 .env）
//   ②金絲雀（沙箱的紅燈證明；任何一隻活著＝不掃，fail-closed）
//   ③起轉送器（localhost → xAI 那一個寫死的位址）
//   ④在沙箱裡跑 grok（HOME 指進盒子；grok 靠 GROK_HOME 找自己的家）
//   ⑤驗屍（記錄它跑了什麼；在盒子裡跑指令是准的——驗的是「有沒有讀到盒子外的東西」）
//
// 用法：
//   node scripts/grok-scan.js --base <sha> --head <sha> --prompt <指示檔> [--out <輸出檔>]
//   base/head 兩顆都要寫死（條款：不可用 origin/main 這類會移動的名稱）。
//   指示檔＝邊界前綴＋這次要它做什麼；diff 由本腳本從 base..head 產生並附在後面。
//
// 退出碼：0＝掃完且驗屍乾淨／1＝驗屍發現它讀到盒子外的東西（沙箱破了＝事故，不只是作廢）／
//        2＝跑不起來（金絲雀不過、非 macOS、grok 不在…）——fail-closed。
//
// ⚠️ 誠實劃界：
// ・盒子裡放的是**已 commit** 的內容。未 commit 的改動它看不到——那本來就是條款（材料限已 commit、將公開）。
// ・轉送器擋不住「把資料 POST 給 xAI」；真正的保護是它讀不到可以送的東西（見 grok-sandbox.sb）。
// ・本腳本**不**決定掃描時機——那是條款（Codex 通過之後、gh pr ready 之前）；它只負責「掃的時候有圍欄」。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCanary, PROFILE } from './grok-sandbox-canary.js';
import { auditSessionDir, allSessionDirs } from './audit-grok-scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RELAY_PORT = 18765;

const ARGS = process.argv.slice(2);   // 只准 slice(2)（專案 lint 規則：進入點判斷一律走 lib/is-main.js）
/** @param {string} flag */
function arg(flag) { const i = ARGS.indexOf(flag); return i >= 0 ? ARGS[i + 1] : undefined; }
/** @param {string} msg @param {0|1|2} code @returns {never} */
function die(msg, code) { console.error(msg); process.exit(code); }

const baseArg = arg('--base'), headArg = arg('--head'), promptArg = arg('--prompt');
const outFile = arg('--out');
if (!baseArg || !headArg || !promptArg) die('用法：node scripts/grok-scan.js --base <sha> --head <sha> --prompt <指示檔> [--out <輸出檔>]', 2);
const base = baseArg, head = headArg, promptFile = promptArg;
if (!/^[0-9a-f]{7,40}$/.test(base) || !/^[0-9a-f]{7,40}$/.test(head)) die('base／head 必須是寫死的 SHA（條款：不可用會移動的名稱）', 2);
if (!existsSync(promptFile)) die(`指示檔不存在：${promptFile}`, 2);
const grokBin = join(homedir(), '.grok', 'bin', 'grok');
if (!existsSync(grokBin)) die(`找不到 grok：${grokBin}`, 2);

// ── ① 建盒子 ─────────────────────────────────────────────────────
const box = mkdtempSync(`/private/tmp/grok-scan-${head.slice(0, 7)}-`);
const src = join(box, 'src');
console.log(`盒子：${box}`);
{
  const r = spawnSync('/bin/sh', ['-c', `mkdir -p "${src}" && git -C "${REPO}" archive ${head} | tar -x -C "${src}"`], { encoding: 'utf8' });
  if (r.status !== 0) die(`git archive 失敗：${r.stderr}`, 2);
  // APFS clone（copy-on-write）：1 秒、不占空間；不可用 symlink——Node 解析 symlink 會 lstat 到家目錄、被沙箱擋
  const c = spawnSync('/bin/cp', ['-Rc', join(REPO, 'node_modules'), join(src, 'node_modules')], { encoding: 'utf8' });
  if (c.status !== 0) die(`node_modules clone 失敗：${c.stderr}`, 2);
  for (const forbidden of ['data/store.db', 'data/store.json', '.env']) {
    if (existsSync(join(src, forbidden))) die(`盒子裡出現不該有的檔：${forbidden}——git archive 不該帶出它，先查 .gitignore`, 2);
  }
}

// ── ② 金絲雀（fail-closed）─────────────────────────────────────
{
  const { code, lines } = runCanary(box);
  for (const l of lines) console.log('  ' + l);
  if (code !== 0) die(code === 1 ? '金絲雀：有一隻活著＝沙箱是假的，不掃' : '金絲雀：這台機器跑不了沙箱，不掃', 2);
}

// ── 材料：指示＋diff ────────────────────────────────────────────
const diff = spawnSync('git', ['-C', REPO, 'diff', `${base}..${head}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (diff.status !== 0) die(`git diff 失敗：${diff.stderr}`, 2);
const materials = join(box, 'materials.txt');
writeFileSync(materials, readFileSync(promptFile, 'utf8')
  + `\n\n【受掃版本】base ${base} → head ${head}；你現在所在的目錄 ./src 是 head 的完整原始碼（已 commit 的部分），可以在裡面跑 node --test。\n\n【以下為 diff】\n`
  + diff.stdout);

// ── ③ 轉送器 ───────────────────────────────────────────────────
const relay = spawn(process.execPath, [join(HERE, 'grok-relay.js'), String(RELAY_PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, bad) => {
  const t = setTimeout(() => bad(new Error('轉送器 5 秒內沒有 READY')), 5000);
  if (!relay.stdout) { bad(new Error('轉送器沒有 stdout')); return; }
  relay.stdout.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(t); ok(undefined); } });
  relay.on('exit', (c) => { clearTimeout(t); bad(new Error(`轉送器提早退出（${c}）`)); });
}).catch((e) => die(String(e.message), 2));

// ── ④ 沙箱裡跑 grok ─────────────────────────────────────────────
const home = homedir();
const startedAt = new Date().toISOString();
console.log(`掃描開始：${startedAt}（在通過之後才掃＝條款；時序要自己記進 PR）`);
const grok = spawnSync('/usr/bin/sandbox-exec', [
  '-f', PROFILE, '-D', `HOME=${home}`, '-D', `GROK_HOME=${join(home, '.grok')}`, '-D', `SCAN_DIR=${box}`,
  grokBin, '--disable-web-search', '-p', readFileSync(materials, 'utf8'),
], {
  cwd: src, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HOME: box, GROK_HOME: join(home, '.grok'), GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${RELAY_PORT}/v1` },
});
relay.kill();
const reply = grok.stdout || '';
if (outFile) writeFileSync(outFile, reply);
console.log(`掃描結束：${new Date().toISOString()}；grok 退出碼 ${grok.status}；回覆 ${reply.length} 字${outFile ? `，已寫 ${outFile}` : ''}`);
if (grok.status !== 0) console.error(`grok stderr（尾）：${(grok.stderr || '').slice(-600)}`);

// ── ⑤ 驗屍：在盒子裡跑指令是准的；驗的是「有沒有讀到盒子外」──────
const { dirs } = allSessionDirs(src);
let worst = 0;
for (const d of dirs) {
  const a = auditSessionDir(d);
  const n = Object.values(a.calls).reduce((s, v) => s + v, 0);
  console.log(`驗屍 session ${d.split('/').pop()}：工具足跡 ${n} 筆（盒子裡准跑）${a.code === 2 ? '；⚠️ 日誌讀不清楚' : ''}`);
  // 沙箱破了的證據：它的輸出裡出現只在盒子外才有的東西
  const txt = spawnSync('/usr/bin/grep', ['-rlE', 'CANARY-[0-9a-z]+-|flexToken"\\s*:\\s*"[^"]{8,}', d], { encoding: 'utf8' });
  if (txt.status === 0) { console.error(`⚠️ 驗屍：session ${d} 的日誌出現盒子外才有的內容——沙箱破了，這是事故`); worst = 1; }
  if (a.code === 2) worst = Math.max(worst, 2);
}
console.log(`\n配方聲明可抄：base..head=${base}..${head}｜沙箱=scripts/grok-sandbox.sb｜轉送器=127.0.0.1:${RELAY_PORT}→cli-chat-proxy.grok.com｜盒子=${box}｜grok=${spawnSync(grokBin, ['--version'], { encoding: 'utf8' }).stdout.trim()}｜掃描起訖=${startedAt}→${new Date().toISOString()}`);
process.exit(/** @type {0|1|2} */ (worst));
