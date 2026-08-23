#!/usr/bin/env node
// @ts-check
// **Grok 沙箱的金絲雀**——圍欄的紅燈證明（William 2026-08-22 裁示：金絲雀先證明沙箱有效才上線）。
//
// ## 它證明什麼、不證明什麼
//
// 證明：用 scripts/grok-sandbox.sb 啟動的探針程式，對下面列出的每一件事都**回報失敗且輸出裡沒有暗號**，
//       而且**做得到**盒子裡該做的事。有對照組的那幾隻（網路、剪貼簿、Keychain、本機 port）另證明了
//       「沙箱外做得到」——所以失敗是沙箱造成的；沒對照組的只證明「失敗」。
// 不證明：沒有別的洞；也不證明哪一條規則在擋（r3 #5：IPC 面其實由 system.sb 決定，不在我們的 deny 裡）。
// 這個專案的老教訓：護欄不能自己證明自己完整。
//
// 用的是 `cat`／`ls`／`sh`／`curl`／`pbpaste` 這種**確定會嘗試**的程式，不是 grok——grok 會「選擇」不做，那不是圍欄。
//
// ## r1 之後加的（Codex 抓到第一版的四個洞）
// ・**寫入**也要測——第一版只測讀，沙箱其實寫入全開。
// ・**盒外其他地方**：/private/tmp（其他審查樹）、使用者暫存區、/Users/Shared。
// ・**IPC**：剪貼簿、Keychain——而且要有**對照組**（沙箱外讀得到，沙箱內讀不到才算擋住；沙箱外本來就空＝測不出）。
// ・**環境變數**：盒內 env 不得含呼叫者的 token／key。
// ・**網路探針要先在沙箱外跑一次對照**：離線／DNS 壞時探針本來就失敗，金絲雀會假報「擋住」。
// ・**能力探測**：sandbox-exec 在巢狀沙箱裡（例如 Codex 的審查環境）apply 不了，會退 71——
//   那不是「禁區擋住」，是「沙箱根本沒套上」；第一版把 71 當成擋住（Codex r1 實測）。
//
// ## 用法
//
//   node scripts/grok-sandbox-canary.js <盒子路徑>
//
// 退出碼：0＝全部擋住且正面案例通過（可以掃）／1＝有一隻金絲雀活著（**沙箱是假的，不准掃**）／
//        2＝這台機器跑不了（非 macOS、沒有 sandbox-exec、沙箱 apply 不了、對照組不活、盒子不存在）——fail-closed，同樣不准掃。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE = join(HERE, 'grok-sandbox.sb');
/** 真 git（繞開 /usr/bin/git 的 xcrun shim——它堅持在使用者暫存區寫快取，沙箱裡會吐警告） */
const CLT_BIN = '/Library/Developer/CommandLineTools/usr/bin';

/**
 * 沙箱裡的環境變數＝**白名單重建**，不繼承呼叫者的（Codex r1：整包 process.env 交進去＝token 直接給它）。
 * HOME／TMPDIR／GROK_HOME **全部指進盒子**（r2：GROK_HOME 指真 ~/.grok 是升級鏈，見 grok-sandbox.sb 檔頭）。
 * 另外明確關掉跨 session 記憶、自動更新、子代理（Codex r2：不關＝靜靜保留那些能力，不是起不來）。
 * @param {string} box
 */
export function sandboxEnv(box) {
  return {
    HOME: box,
    TMPDIR: join(box, 'tmp'),
    PATH: `${CLT_BIN}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
    GROK_HOME: join(box, 'grok-home'),
    GROK_MEMORY: '0',
    GROK_DISABLE_AUTOUPDATER: '1',
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
  };
}

/** 金絲雀單獨跑時用的 port 參數（正式掃描每掃向 OS 要一個隨機 port、再把它傳給 runCanary——金絲雀與發射用同一組參數） */
export const RELAY_PORT = 18765;

/**
 * 在沙箱裡跑一條指令。cwd 預設＝盒子（考題從家目錄底下的工作樹跑時，沙箱裡的程式連「目前目錄」都讀不到）。
 * @param {string} box
 * @param {string[]} argv 指令與參數（絕對路徑）
 * @param {{ cwd?: string, env?: Record<string, string>, timeout?: number, relayPort?: number }} [opt]
 */
export function runInSandbox(box, argv, opt = {}) {
  // ⚠️ 傳給沙箱的路徑一律先 realpath：sandbox-exec 比對的是**解析後**路徑，
  //    /var/folders/… 其實是 /private/var/folders/…，沒解析就永遠比不中（考題用 tmpdir() 時實際踩到，exec 退 126）。
  const boxReal = realpathSync(box);
  mkdirSync(join(boxReal, 'tmp'), { recursive: true });
  mkdirSync(join(boxReal, 'grok-home'), { recursive: true });
  return spawnSync('/usr/bin/sandbox-exec', [
    '-f', PROFILE,
    '-D', `SCAN_DIR=${boxReal}`,
    '-D', `RELAY_PORT=${opt.relayPort ?? RELAY_PORT}`,
    ...argv,
  ], { encoding: 'utf8', cwd: opt.cwd ?? boxReal, env: opt.env ?? sandboxEnv(boxReal), timeout: opt.timeout ?? 20_000 });
}

/**
 * 「這隻反面金絲雀算不算擋住」——**唯一的判斷**，抽出來是為了讓考題直接考它。
 * 擋住＝status 是「非 0 的數字」**且**輸出裡沒有暗號。
 * ⚠️ status 為 null（被訊號殺掉／ENOBUFS／逾時）**不算擋住**——那是金絲雀自己壞了。
 * ⚠️ status 71（sandbox_apply 失敗）**也不算擋住**——那是沙箱根本沒套上（Codex r1 實測）。
 * @param {{ status: number | null, stdout?: string | null }} r
 * @param {string} secret
 */
export function isBlocked(r, secret) {
  const leaked = (r.stdout || '').includes(secret);
  return typeof r.status === 'number' && r.status !== 0 && r.status !== 71 && !leaked;
}

/**
 * 能力探測：這台機器、這個環境，沙箱**套得上**嗎？套不上＝退 2，不是「擋住」。
 * @param {string} box
 */
export function canApplySandbox(box) {
  if (process.platform !== 'darwin') return { ok: false, why: '非 macOS：沒有 sandbox-exec' };
  if (!existsSync('/usr/bin/sandbox-exec')) return { ok: false, why: '找不到 /usr/bin/sandbox-exec' };
  if (!existsSync(PROFILE)) return { ok: false, why: `找不到沙箱設定檔 ${PROFILE}` };
  if (!box || !existsSync(box)) return { ok: false, why: `盒子不存在：${box}` };
  const r = runInSandbox(box, ['/bin/echo', 'APPLY-OK']);
  if (r.status !== 0 || !(r.stdout || '').includes('APPLY-OK')) {
    return { ok: false, why: `沙箱 apply 不了（status ${r.status}：${(r.stderr || '').trim().slice(0, 100)}）——巢狀沙箱環境會這樣` };
  }
  return { ok: true, why: '' };
}

/**
 * 跑完整金絲雀。回傳 { code, lines }——lines 是逐條結果（給 PR 描述貼）。
 * @param {string} box
 * @param {{ relayPort?: number }} [opt] 正式掃描傳本掃的隨機 port——金絲雀跟發射用同一組沙箱參數
 */
export async function runCanary(box, opt = {}) {
  const relayPort = opt.relayPort ?? RELAY_PORT;
  /** @type {string[]} */
  const lines = [];
  const cap = canApplySandbox(box);
  if (!cap.ok) return { code: 2, lines: [`⛔ ${cap.why}（fail-closed，不掃）`] };

  const home = homedir();
  const secret = `CANARY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const outsideHome = mkdtempSync(join(home, '.grok-canary-'));       // 家目錄底下
  const outsideTmp = mkdtempSync(join('/private/tmp', 'grok-canary-')); // /private/tmp（其他審查樹住這）
  const outsideVarTmp = mkdtempSync('/private/var/tmp/grok-canary-');   // r2 點名漏掉的位置
  // /Users/Shared：**mkdtemp 建唯一目錄**、cleanup 只刪自己建的（r1 用固定檔名＋無條件刪＝會動到使用者既有檔）
  const outsideShared = existsSync('/Users/Shared') ? mkdtempSync('/Users/Shared/grok-canary-') : null;
  const secretFile = join(outsideHome, 'fake-store.db');
  writeFileSync(secretFile, secret + '\n');
  writeFileSync(join(outsideTmp, 'other-worktree.txt'), secret + '\n');
  writeFileSync(join(outsideVarTmp, 'x.txt'), secret + '\n');
  const inside = join(box, 'canary-inside.txt');
  writeFileSync(inside, 'INSIDE-OK\n');
  // 剪貼簿：**先存、後還原**（r1 直接覆寫再清空＝把使用者的剪貼簿弄丟；Codex r2 跑考題時實際觸發）。
  // r3：只在「現在剪貼簿還是我放的暗號」時才還原——使用者在金絲雀跑的那幾秒複製了新東西，不能被蓋掉。
  // r6：剪貼簿是**全機唯一**的共享狀態——npm test 平行跑多個考題檔、每個都跑金絲雀，兩個同時 pbcopy／pbpaste／還原會互踩
  //     （實測 ~2/7 次：對照組 pbpaste 退 1＝被另一個還原成空 → 整隻金絲雀退 2）。所以這一段用跨程序鎖序列化（mkdir 原子鎖，陳舊鎖 60 秒回收）。
  /** @type {import('node:child_process').SpawnSyncReturns<string> | null} */ let clipBefore = null;
  const restoreClipboard = () => {
    if (!clipBefore) return;   // 還沒拿過鎖＝沒動過剪貼簿
    const now = spawnSync('/usr/bin/pbpaste', { encoding: 'utf8', timeout: 5000 });
    if ((now.stdout || '').includes(secret)) spawnSync('/usr/bin/pbcopy', { input: clipBefore.status === 0 ? (clipBefore.stdout || '') : '', encoding: 'utf8', timeout: 5000 });
  };
  const CLIP_LOCK = '/private/tmp/grok-canary-clipboard.lock';
  const sleepSync = (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  /** 拿到鎖回 true；等超過 60 秒回 false（呼叫端當「對照組不活」處理，fail-closed） */
  const acquireClipLock = () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { mkdirSync(CLIP_LOCK); return true; }
      catch {
        try { if (Date.now() - lstatSync(CLIP_LOCK).mtimeMs > 60_000) rmSync(CLIP_LOCK, { recursive: true, force: true }); } catch { /* 別人剛釋放 */ }
        sleepSync(50);
      }
    }
    return false;
  };
  const releaseClipLock = () => { try { rmSync(CLIP_LOCK, { recursive: true, force: true }); } catch { /* 已釋放 */ } };
  // 盒內 grok-home 的探針目標（r3：不再碰真 ~/.grok——它不在沙箱裡，寫入探針對它沒有意義，反而 cleanup 會動到使用者檔）
  /** 唯一且確認原本不存在的路徑——cleanup 只刪自己建的（r3 #3：固定名＋無條件刪會把使用者同名檔刪掉） */
  const uniq = (/** @type {string} */ dir, /** @type {string} */ stem) => { const p = join(dir, `${stem}-${secret}`); if (existsSync(p)) throw new Error(`探針路徑已存在：${p}`); return p; };

  let dead = 0;
  const mustFail = (/** @type {string} */ label, /** @type {string[]} */ argv) => {
    const r = runInSandbox(box, argv, { relayPort });
    const blocked = isBlocked(r, secret);
    const why = r.status === null ? `（status null：${r.error?.message || r.signal || '?'}）` : r.status === 71 ? '（status 71＝沙箱沒套上）' : '';
    lines.push(`${blocked ? '🔴 擋住' : '🟢 活著（沙箱是假的）'}｜${label}${why}`);
    if (!blocked) dead++;
  };
  const mustPass = (/** @type {string} */ label, /** @type {string[]} */ argv, /** @type {string} */ expect) => {
    const r = runInSandbox(box, argv, { relayPort });
    const ok = r.status === 0 && (r.stdout || '').includes(expect);
    lines.push(`${ok ? '✅ 通過' : '❌ 誤殺'}｜${label}${ok ? '' : `（status ${r.status}：${(r.stderr || '').trim().slice(0, 80)}）`}`);
    if (!ok) dead++;
  };
  /** 反面但要先有對照：沙箱外做得到、沙箱內做不到，才算擋住；沙箱外就做不到＝測不出，退 2 */
  const mustFailWithControl = (/** @type {string} */ label, /** @type {string[]} */ argv, /** @type {(r: import('node:child_process').SpawnSyncReturns<string>) => boolean} */ controlAlive) => {
    const ctl = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 20_000 });
    if (!controlAlive(ctl)) { lines.push(`⛔ 對照組不活｜${label}（沙箱外就失敗：status ${ctl.status}）——這隻測不出，fail-closed`); dead += 1000; return; }
    mustFail(label, argv);
  };

  try {
    // 讀：家目錄、/private/tmp、使用者暫存區、Keychain
    mustFail('讀家目錄底下的假機密', ['/bin/cat', secretFile]);
    mustFail('讀 /private/tmp 裡的其他目錄（其他審查樹住這）', ['/bin/cat', join(outsideTmp, 'other-worktree.txt')]);
    mustFail('列家目錄（Desktop）', ['/bin/ls', join(home, 'Desktop')]);
    mustFail('讀 ~/.gitconfig', ['/bin/cat', join(home, '.gitconfig')]);
    mustFail('讀 ~/.ssh', ['/bin/ls', join(home, '.ssh')]);
    mustFail('列使用者暫存區', ['/bin/ls', tmpdir()]);
    mustFail('列 /Library/Keychains', ['/bin/ls', '/Library/Keychains']);
    // 寫：家目錄、/private/tmp、/Users/Shared（r1 抓到第一版沒擋寫）
    mustFail('讀 /private/var/tmp', ['/bin/cat', join(outsideVarTmp, 'x.txt')]);
    mustFail('寫家目錄', ['/bin/sh', '-c', `echo x > "${join(outsideHome, 'w.txt')}"`]);
    mustFail('寫 /private/tmp', ['/bin/sh', '-c', `echo x > "${join(outsideTmp, 'w.txt')}"`]);
    if (outsideShared) mustFail('寫 /Users/Shared', ['/bin/sh', '-c', `echo x > "${join(outsideShared, 'w.txt')}"`]);
    // r2 #2 升級鏈 → r3：真 ~/.grok 根本不在沙箱裡——讀它就該失敗（不只是寫）
    mustFail('讀真 ~/.grok（不在沙箱裡）', ['/bin/ls', join(home, '.grok')]);
    mustFail('讀真 ~/.grok 的執行檔', ['/bin/cat', join(home, '.grok', 'bin', 'grok')]);
    mustFail('寫真 ~/.grok', ['/bin/sh', '-c', `echo x > "${uniq(join(home, '.grok'), 'w')}"`]);
    // r4 #6：brew 裝的、非 node 依賴的工具在盒內必須**執行不了**——process-exec 是獨立權限，deny file-read 擋不住
    // （r4 實測 gh 讀不到卻跑得起來）。exec 被沙箱拒時 sandbox-exec 退 71＋stderr「execvp() … Operation not permitted」；
    // 71 在 isBlocked 裡不算擋住（那是「沙箱套不上」的碼），所以這隻自己判：71＋那句 stderr＝擋住。
    {
      const gh = existsSync('/opt/homebrew/bin/gh') ? realpathSync('/opt/homebrew/bin/gh') : null;
      if (gh) {
        const ctl = spawnSync(gh, ['--version'], { encoding: 'utf8', timeout: 10_000 });
        if (ctl.status !== 0) { lines.push('⛔ 對照組不活｜執行 brew 裝的非依賴工具（gh 在沙箱外跑不起來）——這隻測不出，fail-closed'); dead += 1000; }
        else {
          const r = runInSandbox(box, [gh, '--version'], { relayPort });
          const blocked = r.status === 71 && /execvp\(\).*Operation not permitted/.test(r.stderr || '') && !(r.stdout || '').includes('gh version');
          lines.push(`${blocked ? '🔴 擋住' : '🟢 活著（沙箱是假的）'}｜執行 brew 裝的非依賴工具（gh；process-exec 限路徑）`);
          if (!blocked) dead++;
        }
      } else lines.push('（略）執行 brew 裝的非依賴工具——這台沒裝 gh，沒探針可用');
    }
    // r6 #1：/usr/local 不是 SIP 樹（這台有 pkg 裝的第二顆 node）——放行整棵 /usr 會帶進來；profile 檔尾明確 deny。讀與執行都要擋。
    mustFailWithControl('列 /usr/local（非 SIP 的開發者樹）', ['/bin/ls', '/usr/local'], (r) => r.status === 0);
    if (existsSync('/usr/local/bin/node')) {
      const ctl = spawnSync('/usr/local/bin/node', ['--version'], { encoding: 'utf8', timeout: 10_000 });
      if (ctl.status !== 0) { lines.push('⛔ 對照組不活｜執行 /usr/local/bin/node（沙箱外跑不起來）——這隻測不出，fail-closed'); dead += 1000; }
      else {
        const r = runInSandbox(box, ['/usr/local/bin/node', '--version'], { relayPort });
        const blocked = r.status === 71 && /execvp\(\).*Operation not permitted/.test(r.stderr || '') && !/^v\d/.test(r.stdout || '');
        lines.push(`${blocked ? '🔴 擋住' : '🟢 活著（沙箱是假的）'}｜執行 /usr/local/bin/node（process-exec 拒 /usr/local）`);
        if (!blocked) dead++;
      }
    } else lines.push('（略）執行 /usr/local/bin/node——這台沒有，沒探針可用');
    // r6 #2：換程序群組（setpgid）要擋——父程序靠 kill(-pgid) 收束。setsid 實測擋不住（見 grok-scan.js 檔頭：靠隨機 port／假值／單趟讀讓逃逸無害），
    // 所以這裡只驗 setpgid；不對 setsid 做任何「已擋」的宣稱。
    mustFailWithControl('setpgid（換程序群組）', ['/usr/bin/perl', '-MPOSIX', '-e', `POSIX::setpgid(0,0) or exit 3; print "SETPGID-${secret}\n"`], (r) => r.status === 0 && (r.stdout || '').includes('SETPGID-'));
    // 網路：只准轉送器那一個 port。r3 #2：要**真的起一個 listener**，先證明沙箱外連得上、再證明盒內 EPERM——
    // 沒有 listener 時沙箱外也是 ECONNREFUSED，金絲雀必然假綠（Codex r3 實測 reportedBlocked:true）。
    {
      // 起一個活的 listener（背景），拿到 port
      const { spawn } = await import('node:child_process');
      const srv = spawn(process.execPath, ['-e', 'const s=require("node:net").createServer(c=>c.end("HI")).listen(0,"127.0.0.1",()=>process.stdout.write(String(s.address().port)+"\\n"));setTimeout(()=>process.exit(0),20000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const port = await new Promise((ok) => { srv.stdout.on('data', (d) => ok(Number(String(d).trim()))); setTimeout(() => ok(0), 5000); });
      try {
        if (!port) { lines.push('⛔ 對照組不活｜連本機非轉送器 port（listener 起不來）——這隻測不出，fail-closed'); dead += 1000; }
        else {
          const probe = `require("node:net").connect(${port},"127.0.0.1").on("data",(d)=>{console.log(String(d));process.exit(0)}).on("error",(e)=>{console.error(e.code);process.exit(1)})`;
          mustFailWithControl(`連本機非轉送器 port（:${port}，沙箱外連得上）`, [process.execPath, '-e', probe], (r) => r.status === 0 && (r.stdout || '').includes('HI'));
        }
      } finally { srv.kill(); }
    }
    // 網路（要對照：沙箱外取得到 1 byte 才算探針活的）
    mustFailWithControl('連外網（curl 取 1 byte）', ['/usr/bin/curl', '-s', '-m', '5', '-f', '-o', '/dev/null', '-r', '0-0', 'https://example.com/'], (r) => r.status === 0);
    // IPC：剪貼簿（要對照：先放暗號，沙箱外讀得到才算；結束一律還原使用者原本的內容）
    if (!acquireClipLock()) { lines.push('⛔ 對照組不活｜讀剪貼簿（pbpaste）（60 秒等不到剪貼簿鎖）——這隻測不出，fail-closed'); dead += 1000; }
    else {
      try {
        clipBefore = spawnSync('/usr/bin/pbpaste', { encoding: 'utf8', timeout: 5000 });
        spawnSync('/usr/bin/pbcopy', { input: secret, encoding: 'utf8' });
        mustFailWithControl('讀剪貼簿（pbpaste）', ['/bin/sh', '-c', `/usr/bin/pbpaste | /usr/bin/grep -q ${secret}`], (r) => r.status === 0);
        restoreClipboard();
      } finally { releaseClipLock(); }
    }
    // IPC：Keychain（對照：沙箱外 dump 有項目）
    mustFailWithControl('讀 Keychain（security dump-keychain）', ['/bin/sh', '-c', '/usr/bin/security dump-keychain 2>/dev/null | /usr/bin/grep -q "keychain:"'], (r) => r.status === 0);
    // 環境變數：**確定性注入**哨兵到呼叫者 env（r2：r1 只在父環境剛好有 token 時才測得到），盒內 env 不得出現
    {
      const sentinels = { GITHUB_TOKEN: 'SENTINEL-GH-' + secret, ANTHROPIC_API_KEY: 'SENTINEL-AN-' + secret, AWS_SECRET_ACCESS_KEY: 'SENTINEL-AWS-' + secret };
      const prev = { ...process.env };
      Object.assign(process.env, sentinels);
      let r;
      try { r = runInSandbox(box, ['/usr/bin/env'], { relayPort }); }   // 不傳 env＝走 sandboxEnv() 的白名單——哨兵必須被擋在外面
      finally { for (const k of Object.keys(sentinels)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
      const leak = Object.values(sentinels).some((v) => (r.stdout || '').includes(v));
      lines.push(`${!leak && r.status === 0 ? '🔴 擋住' : '🟢 活著（沙箱是假的）'}｜環境變數白名單（注入 ${Object.keys(sentinels).length} 個哨兵到呼叫者 env，盒內 env 不得出現）`);
      if (leak || r.status !== 0) dead++;
      // 明確關掉的能力要在 env 裡看得到（r2：不關＝靜靜保留跨 session 記憶／自動更新）
      for (const [k, v] of [['GROK_MEMORY', '0'], ['GROK_DISABLE_AUTOUPDATER', '1']]) {
        const ok = (r.stdout || '').includes(`${k}=${v}`);
        lines.push(`${ok ? '🔴 擋住' : '🟢 活著（沙箱是假的）'}｜盒內 env 明確 ${k}=${v}`);
        if (!ok) dead++;
      }
    }
    // 正面：不能誤殺
    mustPass('讀盒子裡的檔', ['/bin/cat', inside], 'INSIDE-OK');
    mustPass('寫盒子裡的檔', ['/bin/sh', '-c', `echo WRITE-OK > "${join(box, 'canary-w.txt')}" && cat "${join(box, 'canary-w.txt')}"`], 'WRITE-OK');
    mustPass('寫盒子裡的 grok-home', ['/bin/sh', '-c', `echo HOME-OK > "${join(box, 'grok-home', 'canary.txt')}" && cat "${join(box, 'grok-home', 'canary.txt')}"`], 'HOME-OK');
    mustPass('node 跑得起來', [process.execPath, '-e', 'console.log("NODE-OK")'], 'NODE-OK');
    mustPass('git 跑得起來（真 git，不走 xcrun shim）', [join(CLT_BIN, 'git'), '--version'], 'git version');
  } finally {
    restoreClipboard();   // 不管成功失敗都還原（mustFailWithControl 中途退出也會走到這裡）
    rmSync(outsideHome, { recursive: true, force: true });
    rmSync(outsideTmp, { recursive: true, force: true });
    rmSync(outsideVarTmp, { recursive: true, force: true });
    if (outsideShared) rmSync(outsideShared, { recursive: true, force: true });   // 只刪自己 mkdtemp 的
    rmSync(inside, { force: true });
    rmSync(join(box, 'canary-w.txt'), { force: true });
    rmSync(join(box, 'grok-home', 'canary.txt'), { force: true });
    // 真 ~/.grok 的寫入探針路徑帶 secret、確認過原本不存在——沙箱是假的時它會留下，也只刪這個唯一名
    rmSync(join(home, '.grok', `w-${secret}`), { force: true });
  }
  return { code: dead >= 1000 ? 2 : dead ? 1 : 0, lines };
}

if (isMainModule(import.meta.url)) {
  const { code, lines } = await runCanary(process.argv[2] ? resolve(process.argv[2]) : '');
  for (const l of lines) console.log(l);
  console.log(code === 0 ? '金絲雀：全部擋住、正面通過——沙箱有效，可以掃'
    : code === 1 ? '金絲雀：**有一隻活著＝沙箱是假的，不准掃**'
    : '金絲雀：這台機器跑不了沙箱或對照組不活（fail-closed，不准掃）');
  process.exit(code);
}
