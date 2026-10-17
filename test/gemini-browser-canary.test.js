import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canApplySandbox, runInSandbox, isBlocked } from '../scripts/grok-sandbox-canary.js';
import { BROWSER_PROFILE } from '../scripts/gemini-browser-canary.js';

test('browser profile 只收緊網路；檔案、執行與 IPC 不能偷開許可', () => {
  const executable = text => text.split('\n').map(x => x.replace(/;.*$/, '').trim()).filter(Boolean);
  const base = executable(readFileSync(new URL('../scripts/grok-sandbox.sb', import.meta.url), 'utf8')).filter(x => !x.startsWith('(allow network-'));
  const actual = executable(readFileSync(BROWSER_PROFILE, 'utf8'));
  assert.deepEqual(actual, [...base, '(deny network*)']);
});
test('實際 browser profile：正控制可執行，盒內讀寫不到同掃外部信箱', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'browser-profile-test-')));
  const job = realpathSync(mkdtempSync(join(tmpdir(), 'browser-mail-test-')));
  try {
    const cap = canApplySandbox(root, { profile: BROWSER_PROFILE });
    if (!cap.ok) { t.skip('此環境不能套 OS 沙箱；不算正式隔離驗收'); return; }
    const marker = 'synthetic-browser-lease'; writeFileSync(join(job, 'lease.txt'), marker);
    const positive = runInSandbox(root, [process.execPath, '-e', 'process.stdout.write("ALIVE")'], { profile: BROWSER_PROFILE });
    assert.equal(positive.status, 0); assert.equal(positive.stdout, 'ALIVE');
    for (const argv of [['/bin/cat', join(job, 'lease.txt')], ['/bin/ls', job], ['/usr/bin/touch', join(job, 'changed.txt')]]) {
      assert.equal(isBlocked(runInSandbox(root, argv, { profile: BROWSER_PROFILE }), marker), true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(job, { recursive: true, force: true }); }
});
