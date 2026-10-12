// 權限與內容都走隔離 SQLite；不讀主目錄的財務資料。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gitEnv } from '../lib/git-env.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CASES = [
  ['startup', '啟動快照', '.bak'],
  ['ledger', 'ledger 搬家快照', '.pre-ledger-migration.bak'],
  ['sec', '證券合約搬家快照', '.pre-sec-contract.bak'],
  ['snapshot', '櫃檯指定快照', null],
];
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX 檔案權限不適用 Windows' : false };

function readKv(file, key) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT data FROM kv WHERE key=?').get(key).data); }
  finally { db.close(); }
}

function prepare(t, kind, suffix, oldBackup = true, existingDir = false) {
  const dir = mkdtempSync(join(tmpdir(), 'finance-private-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'store.db');
  const target = kind === 'daily' ? join(dir, 'backups', 'store-2026-10-12.db')
    : suffix ? file + suffix : join(dir, 'snapshot.bak');
  if (oldBackup || existingDir) mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  if (existingDir) chmodSync(dirname(target), 0o755);
  let oldBytes;
  if (oldBackup) {
    const previous = new DatabaseSync(target);
    previous.exec("CREATE TABLE previous_backup (value TEXT); INSERT INTO previous_backup VALUES ('previous-synthetic-content')");
    previous.close();
    chmodSync(target, 0o644);
    oldBytes = readFileSync(target);
  }
  const run = (phase = '') => JSON.parse(execFileSync(process.execPath, ['test/helpers/backup-permission-case.js'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: file, PERMISSION_CASE: kind, PERMISSION_FAILURE: phase, PERMISSION_DEST: target },
  }));
  return { dir, file, target, oldBytes, run };
}

for (const [kind, label, suffix] of CASES) {
  test(`私有備份｜${label} 在寫入前及完成後為 0600，且保存本題內容`, POSIX_ONLY, (t) => {
    const c = prepare(t, kind, suffix);
    const result = c.run();
    assert.equal(result.threw, false);
    assert.deepEqual(result.beforeModes, [0o600], '快照內容寫入前的權限');
    assert.equal(statSync(c.target).mode & 0o777, 0o600);
    assert.deepEqual(readKv(c.target, 'history'), [{ id: 'private-backup-probe', month: '2026-10', amount: 471 }]);
    const txs = readKv(c.target, 'transactions');
    assert.equal(txs[0].id, 'legacy-ledger-probe');
    assert.equal(txs[0].ledger, kind === 'startup' || kind === 'ledger' ? undefined : 'cashflow');
    assert.deepEqual(readKv(c.target, 'securityTrades'), kind === 'snapshot' ? []
      : [{ id: 'legacy-sec-probe', symbol: 'DEMO', tradeDate: '2026-10-12' }]);
    assert.equal(existsSync(c.target + '.tmp'), false);
  });

  for (const phase of ['create', 'vacuum', 'rename']) {
    test(`私有備份｜${label} 的 ${phase} 失敗保留舊備份、清理殘骸及沿用錯誤政策`, POSIX_ONLY, (t) => {
      const c = prepare(t, kind, suffix);
      const result = c.run(phase);
      assert.equal(result.hits, 1, '注入點須真正被執行');
      assert.deepEqual(readFileSync(c.target), c.oldBytes);
      assert.equal(existsSync(c.target + '.tmp'), false);
      assert.equal(result.threw, kind === 'snapshot');
      assert.deepEqual(readKv(c.file, 'history'), [{ id: 'private-backup-probe', month: '2026-10', amount: 471 }]);
      if (phase === 'create') assert.deepEqual(result.beforeModes, [], '安全建立失敗不得退回直接寫快照');
      else assert.deepEqual(result.beforeModes, [0o600]);
      if (kind !== 'snapshot') assert.ok(result.warnings.some(x => x.includes(
        kind === 'startup' ? '啟動備份' : kind === 'ledger' ? 'pre-ledger-migration' : 'pre-sec-contract')));
    });
  }
}

test('私有備份｜每日新目錄為 0700，新快照為 0600 且有合成內容', POSIX_ONLY, (t) => {
  const c = prepare(t, 'daily', null, false);
  const result = c.run();
  assert.equal(result.created, true);
  assert.equal(statSync(dirname(c.target)).mode & 0o777, 0o700);
  assert.deepEqual(result.beforeModes, [0o600]);
  assert.equal(statSync(c.target).mode & 0o777, 0o600);
  assert.deepEqual(readKv(c.target, 'history'), [{ id: 'private-backup-probe', month: '2026-10', amount: 471 }]);
});

test('私有備份｜每日服務沿用既有目錄，替換的備份仍為 0600', POSIX_ONLY, (t) => {
  const c = prepare(t, 'daily', null, true, true);
  const result = c.run();
  assert.equal(result.created, true);
  assert.equal(statSync(dirname(c.target)).mode & 0o777, 0o755);
  assert.equal(statSync(c.target).mode & 0o777, 0o600);
});

for (const phase of ['create', 'vacuum', 'rename']) {
  test(`私有備份｜每日服務的 ${phase} 失敗據實記狀態、保留舊備份並清殘骸`, POSIX_ONLY, (t) => {
    const c = prepare(t, 'daily', null);
    const result = c.run(phase);
    assert.equal(result.hits, 1);
    assert.equal(result.threw, false);
    assert.equal(result.created, false);
    assert.equal(result.failStreak, 1);
    assert.deepEqual(readFileSync(c.target), c.oldBytes);
    assert.equal(existsSync(c.target + '.tmp'), false);
    const settings = readKv(c.file, 'settings');
    assert.equal(settings.lastBackupDate, undefined);
    assert.equal(settings.backupFailStreak, 1);
  });
}
