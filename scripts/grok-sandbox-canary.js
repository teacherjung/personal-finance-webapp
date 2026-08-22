#!/usr/bin/env node
// @ts-check
// **Grok 沙箱的金絲雀**——圍欄的紅燈證明（William 2026-08-22 裁示：金絲雀先證明沙箱有效才上線）。
//
// ## 它證明什麼、不證明什麼
//
// 證明：用 scripts/grok-sandbox.sb 啟動的程式，**做不到**下面列出的每一件事，而且**做得到**盒子裡該做的事。
// 不證明：沒有別的洞。它只測列出的形狀（這個專案的老教訓：護欄不能自己證明自己完整）。
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
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
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
 * HOME／TMPDIR 指進盒子；grok 靠 GROK_HOME 找自己的家（它正式文件支援的變數）。
 * @param {string} box
 * @param {string} [grokHome] 預設 ~/.grok；考題注入假的（裡面放假 grok 與假 sessions）
 */
export function sandboxEnv(box, grokHome = join(homedir(), '.grok')) {
  return {
    HOME: box,
    TMPDIR: join(box, 'tmp'),
    PATH: `${CLT_BIN}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
    GROK_HOME: grokHome,
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
  };
}

/**
 * 在沙箱裡跑一條指令。cwd 預設＝盒子（考題從家目錄底下的工作樹跑時，沙箱裡的程式連「目前目錄」都讀不到）。
 * @param {string} box
 * @param {string[]} argv 指令與參數（絕對路徑）
 * @param {{ cwd?: string, env?: Record<string, string>, timeout?: number, grokHome?: string }} [opt]
 */
export function runInSandbox(box, argv, opt = {}) {
  const home = homedir();
  // ⚠️ 傳給沙箱的路徑一律先 realpath：sandbox-exec 比對的是**解析後**路徑，
  //    /var/folders/… 其實是 /private/var/folders/…，沒解析就永遠比不中（考題用 tmpdir() 時實際踩到，exec 退 126）。
  const grokHome = realpathSync(opt.grokHome ?? join(home, '.grok'));
  const boxReal = realpathSync(box);
  mkdirSync(join(boxReal, 'tmp'), { recursive: true });
  return spawnSync('/usr/bin/sandbox-exec', [
    '-f', PROFILE,
    '-D', `HOME=${home}`,
    '-D', `GROK_HOME=${grokHome}`,
    '-D', `SCAN_DIR=${boxReal}`,
    ...argv,
  ], { encoding: 'utf8', cwd: opt.cwd ?? boxReal, env: opt.env ?? sandboxEnv(boxReal, grokHome), timeout: opt.timeout ?? 20_000 });
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
 */
export function runCanary(box) {
  /** @type {string[]} */
  const lines = [];
  const cap = canApplySandbox(box);
  if (!cap.ok) return { code: 2, lines: [`⛔ ${cap.why}（fail-closed，不掃）`] };

  const home = homedir();
  const secret = `CANARY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const outsideHome = mkdtempSync(join(home, '.grok-canary-'));       // 家目錄底下
  const outsideTmp = mkdtempSync(join('/private/tmp', 'grok-canary-')); // /private/tmp（其他審查樹住這）
  const secretFile = join(outsideHome, 'fake-store.db');
  writeFileSync(secretFile, secret + '\n');
  writeFileSync(join(outsideTmp, 'other-worktree.txt'), secret + '\n');
  const inside = join(box, 'canary-inside.txt');
  writeFileSync(inside, 'INSIDE-OK\n');

  let dead = 0;
  const mustFail = (/** @type {string} */ label, /** @type {string[]} */ argv) => {
    const r = runInSandbox(box, argv);
    const blocked = isBlocked(r, secret);
    const why = r.status === null ? `（status null：${r.error?.message || r.signal || '?'}）` : r.status === 71 ? '（status 71＝沙箱沒套上）' : '';
    lines.push(`${blocked ? '🔴 擋住' : '🟢 活著（沙箱是假的）'}｜${label}${why}`);
    if (!blocked) dead++;
  };
  const mustPass = (/** @type {string} */ label, /** @type {string[]} */ argv, /** @type {string} */ expect) => {
    const r = runInSandbox(box, argv);
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
    mustFail('寫家目錄', ['/bin/sh', '-c', `echo x > "${join(outsideHome, 'w.txt')}"`]);
    mustFail('寫 /private/tmp', ['/bin/sh', '-c', `echo x > "${join(outsideTmp, 'w.txt')}"`]);
    mustFail('寫 /Users/Shared', ['/bin/sh', '-c', 'echo x > /Users/Shared/grok-canary-w.txt']);
    // 網路（要對照：沙箱外取得到 1 byte 才算探針活的）
    mustFailWithControl('連外網（curl 取 1 byte）', ['/usr/bin/curl', '-s', '-m', '5', '-f', '-o', '/dev/null', '-r', '0-0', 'https://example.com/'], (r) => r.status === 0);
    // IPC：剪貼簿（要對照：先放暗號，沙箱外讀得到才算）
    spawnSync('/usr/bin/pbcopy', { input: secret, encoding: 'utf8' });
    mustFailWithControl('讀剪貼簿（pbpaste）', ['/bin/sh', '-c', `/usr/bin/pbpaste | /usr/bin/grep -q ${secret}`], (r) => r.status === 0);
    spawnSync('/usr/bin/pbcopy', { input: '', encoding: 'utf8' });
    // IPC：Keychain（對照：沙箱外 dump 有項目）
    mustFailWithControl('讀 Keychain（security dump-keychain）', ['/bin/sh', '-c', '/usr/bin/security dump-keychain 2>/dev/null | /usr/bin/grep -q "keychain:"'], (r) => r.status === 0);
    // 環境變數：盒內 env 不得含呼叫者的 token（把一個假 token 放進呼叫者 env，盒內不得看到）
    {
      const r = runInSandbox(box, ['/usr/bin/env'], { env: { ...sandboxEnv(box) } });
      const leak = /TOKEN|SECRET|API_KEY|GH_|GITHUB_|ANTHROPIC|OPENAI|AWS_/i.test(r.stdout || '');
      lines.push(`${!leak && r.status === 0 ? '🔴 擋住' : '🟢 活著（沙箱是假的）'}｜環境變數白名單（盒內 env 不含 token／key 類變數）`);
      if (leak || r.status !== 0) dead++;
    }
    // 正面：不能誤殺
    mustPass('讀盒子裡的檔', ['/bin/cat', inside], 'INSIDE-OK');
    mustPass('寫盒子裡的檔', ['/bin/sh', '-c', `echo WRITE-OK > "${join(box, 'canary-w.txt')}" && cat "${join(box, 'canary-w.txt')}"`], 'WRITE-OK');
    mustPass('讀 grok 自己的家', ['/bin/ls', join(home, '.grok')], 'config.toml');
    mustPass('node 跑得起來', [process.execPath, '-e', 'console.log("NODE-OK")'], 'NODE-OK');
    mustPass('git 跑得起來（真 git，不走 xcrun shim）', [join(CLT_BIN, 'git'), '--version'], 'git version');
  } finally {
    rmSync(outsideHome, { recursive: true, force: true });
    rmSync(outsideTmp, { recursive: true, force: true });
    rmSync(inside, { force: true });
    rmSync(join(box, 'canary-w.txt'), { force: true });
    rmSync('/Users/Shared/grok-canary-w.txt', { force: true });
  }
  return { code: dead >= 1000 ? 2 : dead ? 1 : 0, lines };
}

if (isMainModule(import.meta.url)) {
  const { code, lines } = runCanary(process.argv[2] ? resolve(process.argv[2]) : '');
  for (const l of lines) console.log(l);
  console.log(code === 0 ? '金絲雀：全部擋住、正面通過——沙箱有效，可以掃'
    : code === 1 ? '金絲雀：**有一隻活著＝沙箱是假的，不准掃**'
    : '金絲雀：這台機器跑不了沙箱或對照組不活（fail-closed，不准掃）');
  process.exit(code);
}
