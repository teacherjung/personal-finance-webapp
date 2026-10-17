// @ts-check
// 只換成固定且更窄的 profile，沿用標準控制；舊場次的收據不能代替本場探針。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { runCanary, runInSandbox, isBlocked } from './grok-sandbox-canary.js';
import { isMainModule } from '../lib/is-main.js';

export const BROWSER_PROFILE = join(dirname(fileURLToPath(import.meta.url)), 'gemini-browser-sandbox.sb');
export async function browserCanary(box, job, marker) {
  const base = await runCanary(box, { profile: BROWSER_PROFILE });
  if (base.code !== 0) return base;
  const probes = /** @type {[string, string[]][]} */ ([
    ['讀本掃盒外信箱假機密', ['/bin/cat', join(job, 'outside-canary.txt')]],
    ['列本掃盒外信箱', ['/bin/ls', job]],
    ['寫本掃盒外信箱', ['/usr/bin/touch', join(job, 'forbidden-write.txt')]],
  ]);
  const results = probes.map(([label, argv]) => {
    const result = runInSandbox(box, argv, { profile: BROWSER_PROFILE });
    return { label, blocked: isBlocked(result, marker) };
  });
  // 每個登記位置各自建立可讀寫的假值，避免「檔案不存在」被誤認成隔離成功。
  for (const parent of [homedir(), '/private/tmp', '/private/var/tmp', '/Users/Shared', join(homedir(), '.grok')]) {
    let dir;
    try {
      dir = mkdtempSync(join(parent, 'gemini-browser-canary-'));
      writeFileSync(join(dir, 'fake.txt'), marker, { mode: 0o600 });
      if (readFileSync(join(dir, 'fake.txt'), 'utf8') !== marker || !readdirSync(dir).includes('fake.txt')) throw Error('control');
      const checks = [['read', ['/bin/cat', join(dir, 'fake.txt')]], ['list', ['/bin/ls', dir]], ['write', ['/usr/bin/touch', join(dir, 'forbidden.txt')]]];
      for (const [kind, argv] of checks) {
        const r = runInSandbox(box, /** @type {string[]} */ (argv), { profile: BROWSER_PROFILE });
        results.push({ label: `登記位置 ${parent} ${kind}`, blocked: isBlocked(r, marker) });
      }
      if (readdirSync(dir).includes('forbidden.txt')) results.push({ label: '假值目錄被改動', blocked: false });
    } catch { return { code: 2, lines: [...base.lines, '登記位置的假值控制無法完成；不能當成擋住'] }; }
    finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
  }
  const bad = results.some(r => !r.blocked);
  return { code: bad ? 1 : 0, lines: [...base.lines, ...results.map(r => `${r.blocked ? '擋住' : '未擋住'}｜${r.label}`)] };
}

if (isMainModule(import.meta.url)) { process.stderr.write('GEMINI_BROWSER_LIBRARY_ONLY\n'); process.exitCode = 78; }
