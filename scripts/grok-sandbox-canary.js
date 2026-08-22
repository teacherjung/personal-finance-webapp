#!/usr/bin/env node
// @ts-check
// **Grok 沙箱的金絲雀**——圍欄的紅燈證明（William 2026-08-22 裁示：金絲雀先證明沙箱有效才上線）。
//
// ## 它證明什麼、不證明什麼
//
// 證明：用 scripts/grok-sandbox.sb 啟動的程式，**做不到**下面列出的每一件事，而且**做得到**盒子裡該做的事。
// 不證明：沒有別的洞。它只測列出的形狀（這個專案的老教訓：護欄不能自己證明自己完整）。
//
// 用的是 `cat`／`ls`／`curl` 這種確定會嘗試的程式，**不是 grok**——grok 會「選擇」不做，那不是圍欄。
//
// ## 用法
//
//   node scripts/grok-sandbox-canary.js <盒子路徑>
//
// 退出碼：0＝全部擋住且正面案例通過（可以掃）／1＝有一隻金絲雀活著（**沙箱是假的，不准掃**）／
//        2＝這台機器跑不了（非 macOS、沒有 sandbox-exec、盒子不存在）——fail-closed，同樣不准掃。
//
// scripts/grok-scan.js 在每次掃描前都會跑這支；CI（Linux）由 test/grok-sandbox.test.js 明確 skip。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE = join(HERE, 'grok-sandbox.sb');

/**
 * 在沙箱裡跑一條指令。
 * @param {string} box 盒子路徑
 * @param {string[]} argv 指令與參數（絕對路徑）
 * @param {{ home?: string }} [opt]
 */
export function runInSandbox(box, argv, opt = {}) {
  const home = homedir();
  return spawnSync('/usr/bin/sandbox-exec', [
    '-f', PROFILE,
    '-D', `HOME=${home}`,
    '-D', `GROK_HOME=${join(home, '.grok')}`,
    '-D', `SCAN_DIR=${box}`,
    ...argv,
  ], {
    encoding: 'utf8',
    env: { ...process.env, HOME: opt.home ?? box, GROK_HOME: join(home, '.grok') },
    timeout: 20_000,
  });
}

/**
 * 跑完整金絲雀。回傳 { code, lines }——lines 是逐條結果（給 PR 描述貼）。
 * @param {string} box
 */
export function runCanary(box) {
  /** @type {string[]} */
  const lines = [];
  if (process.platform !== 'darwin') return { code: 2, lines: ['非 macOS：沒有 sandbox-exec，這台機器跑不了沙箱（fail-closed）'] };
  if (!existsSync('/usr/bin/sandbox-exec')) return { code: 2, lines: ['找不到 /usr/bin/sandbox-exec（fail-closed）'] };
  if (!existsSync(PROFILE)) return { code: 2, lines: [`找不到沙箱設定檔 ${PROFILE}（fail-closed）`] };
  if (!box || !existsSync(box)) return { code: 2, lines: [`盒子不存在：${box}（fail-closed）`] };

  const home = homedir();
  const secret = `CANARY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const outside = mkdtempSync(join(home, '.grok-canary-'));   // 家目錄底下＝禁區
  const secretFile = join(outside, 'fake-store.db');
  writeFileSync(secretFile, secret + '\n');
  const inside = join(box, 'canary-inside.txt');
  writeFileSync(inside, 'INSIDE-OK\n');

  let dead = 0;
  /** 反面：必須失敗 */
  const mustFail = (/** @type {string} */ label, /** @type {string[]} */ argv) => {
    const r = runInSandbox(box, argv);
    const leaked = (r.stdout || '').includes(secret);
    // ⚠️ status 必須是「非 0 的數字」才算擋住。null（被訊號殺掉／ENOBUFS／逾時）＝金絲雀自己壞了，
    //    一律算「活著」——第一版把 null 當成擋住，拿掉 deny network 後 curl 吞整頁 Google 塞爆緩衝被殺，
    //    金絲雀竟報「全部擋住」（2026-08-22 突變實測的假紅）。
    const blocked = typeof r.status === 'number' && r.status !== 0 && !leaked;
    const why = r.status === null ? `（status null：${r.error?.message || r.signal || '?'}）` : '';
    lines.push(`${blocked ? '🔴 擋住' : '🟢 活著（沙箱是假的）'}｜${label}${why}`);
    if (!blocked) dead++;
  };
  /** 正面：必須成功（不能誤殺） */
  const mustPass = (/** @type {string} */ label, /** @type {string[]} */ argv, /** @type {string} */ expect) => {
    const r = runInSandbox(box, argv);
    const ok = r.status === 0 && (r.stdout || '').includes(expect);
    lines.push(`${ok ? '✅ 通過' : '❌ 誤殺'}｜${label}${ok ? '' : `（status ${r.status}：${(r.stderr || '').trim().slice(0, 80)}）`}`);
    if (!ok) dead++;
  };

  try {
    mustFail('讀家目錄底下的假機密', ['/bin/cat', secretFile]);
    mustFail('列家目錄（Desktop）', ['/bin/ls', join(home, 'Desktop')]);
    mustFail('讀 ~/.gitconfig', ['/bin/cat', join(home, '.gitconfig')]);
    mustFail('讀 ~/.ssh', ['/bin/ls', join(home, '.ssh')]);
    // 只取 1 byte（-r 0-0）、-o /dev/null：金絲雀只問「連上了沒」，不讓網頁大小影響判定。
    // ⚠️ 探針本身要先在沙箱外驗過是活的（第一版用 -I，Google 本來就拒 HEAD → 沙箱外也退 56，
    //    金絲雀在測自己的錯而不是沙箱；example.com 取 1 byte 在沙箱外退 0，2026-08-22 實測）。
    mustFail('連外網（curl 取 1 byte）', ['/usr/bin/curl', '-s', '-m', '5', '-f', '-o', '/dev/null', '-r', '0-0', 'https://example.com/']);
    mustPass('讀盒子裡的檔', ['/bin/cat', inside], 'INSIDE-OK');
    mustPass('讀 grok 自己的家', ['/bin/ls', join(home, '.grok')], 'config.toml');
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(inside, { force: true });
  }
  return { code: dead ? 1 : 0, lines };
}

if (isMainModule(import.meta.url)) {
  const { code, lines } = runCanary(process.argv[2] ? resolve(process.argv[2]) : '');
  for (const l of lines) console.log(l);
  console.log(code === 0 ? '金絲雀：全部擋住、正面通過——沙箱有效，可以掃'
    : code === 1 ? '金絲雀：**有一隻活著＝沙箱是假的，不准掃**'
    : '金絲雀：這台機器跑不了沙箱（fail-closed，不准掃）');
  process.exit(code);
}
