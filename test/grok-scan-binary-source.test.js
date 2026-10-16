// @ts-check
// 假 HOME 中同時保留浮動入口，讓「缺固定檔便回退」有可執行的反證機會；不接真認證或模型。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv } from '../lib/git-env.js';
import { cleanupTempRoots, fakeGrok, keep, promptFile, ROOT, SANDBOX_OK, SKIP_AFTER_CANARY, tinyRepo } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);
const pinnedName = 'grok-1.0.46-macos-aarch64';

function fixture() {
  const home = keep(mkdtempSync(join(tmpdir(), 'grok-binary-home-')));
  const install = join(home, '.grok');
  cpSync(fakeGrok({ version: 'grok 9.9.9' }), install, { recursive: true });
  mkdirSync(join(install, 'downloads'));
  const fixed = join(install, 'downloads', pinnedName);
  const executionMarker = join(home, 'binary-executed');
  // 盒外直接執行也要留下證據；只數 sandbox-exec 會漏掉驗 hash 前直接 spawn 副本的突變。
  const markExecution = `(printf x >> '${executionMarker.replace(/'/g, "'\\''")}') 2>/dev/null\n`;
  const fixedBytes = Buffer.from(readFileSync(join(install, 'bin', 'grok'), 'utf8').replace('#!/bin/sh\n', '#!/bin/sh\n' + markExecution));
  writeFileSync(fixed, fixedBytes, { mode: 0o755 });
  writeFileSync(join(install, 'bin', 'grok'), '#!/bin/sh\n' + markExecution + 'printf "FLOATING-EXECUTED"\n', { mode: 0o755 });
  return { home, install, fixed, executionMarker, hash: createHash('sha256').update(fixedBytes).digest('hex') };
}

function probe(/** @type {ReturnType<typeof fixture>} */ f, expectedSha256 = '0'.repeat(64)) {
  const repo = tinyRepo();
  const args = { base: repo.base, head: repo.head, promptFile: promptFile() };
  const program = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { runScan } from './scripts/grok-scan.js';
    import { isolated, cleanupTempRoots } from './test/helpers/grok-scan-flow-fixtures.js';
    const original = childProcess.spawnSync; let sandboxCalls = 0; let fetchCalls = 0;
    childProcess.spawnSync = (...args) => { if (args[0] === '/usr/bin/sandbox-exec') sandboxCalls++; return original(...args); };
    syncBuiltinESMExports();
    try {
      const result = await runScan(${JSON.stringify(args)}, { ...isolated(), repo: ${JSON.stringify(repo.dir)}, expectedSha256: ${JSON.stringify(expectedSha256)}, log: () => {}, fetchImpl: async () => { fetchCalls++; throw Error('synthetic fetch forbidden'); } });
      console.log(JSON.stringify({ result, sandboxCalls, fetchCalls }));
    } catch { console.log(JSON.stringify({ threw: true, sandboxCalls, fetchCalls })); }
    finally { cleanupTempRoots(); }
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: ROOT, env: gitEnv({ ...process.env, HOME: f.home }), encoding: 'utf8', timeout: 60_000,
  }));
}

test('固定來源｜正式預設複製固定下載檔，錯 hash 在執行與外呼前停止', () => {
  const f = fixture(); const out = probe(f);
  assert.equal(out.result?.code, 2, '核對 scripts/grok-scan.js 的來源失敗處理，再跑本檔');
  assert.ok(out.result.summary.some((/** @type {string} */ line) => line.includes(`實際 ${f.hash.slice(0, 12)}`)), '核對 scripts/grok-scan.js 的固定來源與盒內副本 hash，再跑本檔');
  assert.equal(out.sandboxCalls, 0, '核對 scripts/grok-scan.js 的 hash 檢查順序，再跑本檔');
  assert.equal(existsSync(f.executionMarker), false, '核對 scripts/grok-scan.js：hash 核對前不得在盒外執行副本或浮動入口，再跑本檔');
  assert.equal(out.fetchCalls, 0, '核對 scripts/grok-scan.js 的認證啟動順序，再跑本檔');
});

for (const kind of ['missing', 'directory', 'symlink']) {
  test(`固定來源｜${kind} 不回退浮動入口，也不執行或外呼`, () => {
    const f = fixture(); rmSync(f.fixed);
    if (kind === 'directory') mkdirSync(f.fixed);
    if (kind === 'symlink') symlinkSync(join(f.install, 'bin', 'grok'), f.fixed);
    const out = probe(f);
    assert.equal(out.result?.code, 2, '核對 scripts/grok-scan.js 的固定來源拒絕路徑，再跑本檔');
    assert.match(out.result.summary.join('\n'), /固定執行檔來源無法使用/, '核對 scripts/grok-scan.js 的來源檢查，不得回退；再跑本檔');
    assert.equal(out.sandboxCalls, 0, '核對 scripts/grok-scan.js 的來源檢查順序，再跑本檔');
    assert.equal(existsSync(f.executionMarker), false, '核對 scripts/grok-scan.js：來源核對前不得在盒外執行副本或浮動入口，再跑本檔');
    assert.equal(out.fetchCalls, 0, '核對 scripts/grok-scan.js 的來源檢查順序，再跑本檔');
  });
}

test('固定來源｜副本 hash 相符仍須在沙箱內精確驗版本', (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const f = fixture(); const out = probe(f, f.hash);
  assert.equal(out.result?.code, 2, '核對 scripts/grok-scan.js 的版本檢查，再跑本檔');
  assert.match(out.result.summary.join('\n'), /版本不符/, '核對 scripts/grok-scan.js 的版本比較，再跑本檔');
  assert.ok(out.sandboxCalls > 0, '核對 scripts/grok-scan.js 的沙箱版本接線，再跑本檔');
  assert.equal(out.fetchCalls, 0, '核對 scripts/grok-scan.js 的假認證設定，再跑本檔');
});
