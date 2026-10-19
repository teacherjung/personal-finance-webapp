// 正式櫃檯配合隔離 SQLite，檔案內容只使用本題合成資料。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, statSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gitEnv } from '../lib/git-env.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX 權限不適用 Windows' : false };
function prepare(t, existing = false, name = 'store.db') {
  const root = mkdtempSync(join(tmpdir(), 'finance-private-main-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, 'one');
  const file = join(parent, 'two', name);
  let oldBytes;
  if (existing) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
    chmodSync(parent, 0o755); chmodSync(dirname(file), 0o755);
    const d = new DatabaseSync(file);
    d.exec("CREATE TABLE kv(key TEXT PRIMARY KEY, data TEXT NOT NULL); INSERT INTO kv VALUES('settings', '{}')");
    d.close(); chmodSync(file, 0o644);
    oldBytes = readFileSync(file);
  }
  const run = (phase, version = '') => {
    const r = spawnSync(process.execPath, ['test/helpers/store-permission-case.js'], {
      cwd: ROOT, env: { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: file, STORE_PERMISSION_CASE: phase, STORE_PERMISSION_VERSION: version }, encoding: 'utf8', maxBuffer: 2e6,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout);
  };
  return { root, parent, file, oldBytes, run };
}

for (const phase of ['readonly-file', 'readonly-directory']) {
  test(`健康庫唯讀｜${phase} 原生故障兩次保留主檔與備份，不給刪檔指引`, POSIX_ONLY, t => {
    const c = prepare(t, true), backup = c.file + '.bak';
    writeFileSync(backup, 'synthetic readonly backup ' + phase);
    chmodSync(c.file, phase === 'readonly-file' ? 0o444 : 0o600);
    if (phase === 'readonly-directory') chmodSync(dirname(c.file), 0o500);
    let r;
    try { r = c.run(phase); }
    finally { chmodSync(dirname(c.file), 0o700); chmodSync(c.file, 0o600); }
    assert.equal(r.errors.length, 2);
    for (const error of r.errors) {
      assert.ok(error);
      assert.equal(error.errcode & 0xff, 8, '原生 SQLite 必須真的回報唯讀錯誤');
      assert.match(error.message, /請保留現有資料檔與備份/);
      assert.doesNotMatch(error.message, /刪掉|改名|檔案可能損毀/);
    }
    assert.equal(r.firstSQL, 2, '每次呼叫都重開並重新遇到故障');
    assert.equal(r.closed, 2, '每條失敗連線都由正式程式關閉');
    assert.deepEqual(r.values, []);
    assert.deepEqual(readFileSync(c.file), c.oldBytes);
    assert.equal(readFileSync(backup, 'utf8'), 'synthetic readonly backup ' + phase);
  });
}

for (const [phase, corrupt] of [
  ['sql-11', true], ['sql-26', true], ['sql-267', true],
  ['sql-10', false], ['sql-999', false], ['sql-no-code', false], ['sql-text-code', false],
  ['sql--245', false], ['sql-11.5', false], ['sql-9007199254741018', false],
  ['quick-bad', true], ['quick-throws', false], ['quick-missing', false], ['quick-empty', false],
]) {
  test(`開庫錯誤分類｜${phase} ${corrupt ? '保留明確損毀還原指引' : '未證損毀只要求保留檔案'}`, t => {
    const c = prepare(t, true), backup = c.file + '.bak';
    writeFileSync(backup, 'synthetic classification backup ' + phase);
    const r = c.run(phase);
    assert.equal(r.hits, 2, '每次受測呼叫都命中指定故障');
    assert.equal(r.errors.length, 2);
    assert.equal(r.firstSQL, 2);
    assert.equal(r.closed, 2);
    assert.deepEqual(r.values, []);
    for (const [index, error] of r.errors.entries()) {
      assert.ok(error);
      const diagnostic = r.diagnostics[index].join('\n');
      for (const suffix of ['', '-wal', '-shm', '.bak']) assert.ok(diagnostic.includes(JSON.stringify(c.file + suffix)));
      assert.ok(!error.message.includes(c.file));
      assert.doesNotMatch(error.message, /synthetic|quick_check:/);
      if (corrupt) {
        assert.match(error.message, /檔案可能損毀.*本機終端.*不要先刪除資料/);
        assert.match(diagnostic, /①先停止.*所有使用同一資料檔.*\n②.*確認候選備份存在.*不存在或不確定.*停止.*\n③變更有效檔名之前.*原主檔.*WAL／SHM 成組另存.*候選備份也另存.*\n④從候選備份的副本恢復主檔，保留原候選備份.*WAL／SHM 移至保存位置.*\n⑤.*重啟並驗證.*仍失敗.*保留.*停止.*備份存在不代表有效或最新/);
        assert.doesNotMatch(diagnostic, /刪掉 store.db|改名為 store.db/);
      } else {
        assert.doesNotMatch(diagnostic, /④從候選備份/);
        assert.match(error.message, /請保留現有資料檔與備份/);
        assert.doesNotMatch(error.message, /刪掉|改名|檔案可能損毀/);
      }
    }
    assert.equal(readFileSync(backup, 'utf8'), 'synthetic classification backup ' + phase);
  });
}

// 注入版本只驗正式櫃檯的入口決策；SQLite 版本相容性仍靠實際 CI runtime。
for (const [version, supported] of [['22.23.0', false], ['23.0.0', false], ['24.0.0-nightly', false], ['unknown', false], ['22.23.1', true], ['24.0.0', true]]) {
  test(`櫃檯版本入口｜${version} ${supported ? '接受並讀寫' : '在建立檔案與SQL前拒絕'}`, t => {
    const c = prepare(t), r = c.run(supported ? 'version-allow' : 'version-reject', version);
    if (supported) {
      assert.deepEqual(r.errors, [null]);
      assert.equal(r.firstSQL, 1);
      assert.deepEqual(history(c.file), [{ id: 'main-permission-version-allow', month: '2026-10', amount: 479 }]);
    } else {
      assert.equal(r.errors.length, 2);
      for (const error of r.errors) {
        assert.ok(error);
        assert.ok(error.message.includes(version));
        assert.match(error.message, /不支援|支援範圍/);
      }
      assert.equal(existsSync(c.parent), false, '版本不合不可先建目錄或主檔');
      assert.deepEqual(r.events, []);
      assert.equal(r.firstSQL, 0);
      assert.deepEqual(r.values, []);
    }
  });
}
function history(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(d.prepare("SELECT data FROM kv WHERE key='history'").get().data); }
  finally { d.close(); }
}

for (const name of ['store.db', 'space 中文 #?%:.db']) {
  test(`新主檔｜${name} 真 fd 先排他空建 0600、目錄各層 0700 再接 SQLite`, POSIX_ONLY, t => {
    const c = prepare(t, false, name), r = c.run('new');
    assert.deepEqual(r.events, [{ event: 'open', flags: 'wx', mode: 0o600, size: 0 }, { event: 'close' }]);
    assert.equal(r.firstSQL, 1);
    assert.deepEqual(r.beforeSQL, [{ modes: [0o600, null, null], size: 0, reservationEvents: 2 }]);
    assert.deepEqual(r.errors, [null]);
    for (const dir of [c.parent, dirname(c.file)]) assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(history(c.file), [{ id: 'main-permission-new', month: '2026-10', amount: 479 }]);
  });
}

for (const existing of [false, true]) {
  test(`主檔生命週期｜${existing ? '既有0644' : '新0600'} 的 WAL／SHM 消失後重開重建並保存新值`, POSIX_ONLY, t => {
    const c = prepare(t, existing), mode = existing ? 0o644 : 0o600;
    const first = c.run(existing ? 'existing' : 'new');
    assert.deepEqual(first.errors, [null]); assert.equal(first.firstSQL, 1);
    assert.deepEqual(first.alive, [[mode, mode, mode]]);
    assert.deepEqual(first.afterClose, [mode, null, null]);
    for (const suffix of ['-wal', '-shm']) assert.equal(existsSync(c.file + suffix), false);
    const second = c.run('reopen');
    assert.equal(second.firstSQL, 1); assert.deepEqual(second.errors, [null]);
    assert.deepEqual(second.events, [], '重開已有主檔，不改其模式或重新排他建立');
    assert.deepEqual(second.alive, [[mode, mode, mode]]);
    assert.deepEqual(second.afterClose, [mode, null, null]);
    assert.deepEqual(history(c.file), [{ id: 'main-permission-reopen', month: '2026-10', amount: 863 }]);
    if (existing) {
      assert.deepEqual(first.events, []);
      for (const dir of [c.parent, dirname(c.file)]) assert.equal(statSync(dir).mode & 0o777, 0o755);
    }
  });
}

for (const phase of ['mkdir', 'create', 'close', 'race', 'new-removed', 'existing-removed', 'cantopen']) {
  test(`主檔故障｜${phase} 真入口兩次停下、不沿用壞快取或給刪檔還原指引`, POSIX_ONLY, t => {
    const c = prepare(t, phase === 'existing-removed');
    if (['create', 'close', 'race', 'new-removed', 'cantopen'].includes(phase)) mkdirSync(dirname(c.file), { recursive: true });
    if (phase === 'cantopen') mkdirSync(c.file);
    const backup = c.file + '.bak';
    // 舊備份的保存型前置是本題新值；受測開庫有覆寫它的機會。
    if (phase !== 'mkdir') writeFileSync(backup, 'synthetic previous backup');
    const r = c.run(phase);
    assert.equal(r.errors.length, 2);
    for (const error of r.errors) {
      assert.ok(error, '每次受測呼叫都要失敗');
      assert.match(error.message, /請保留現有資料檔與備份/);
      assert.doesNotMatch(error.message, /刪掉|改名|檔案可能損毀/);
    }
    assert.equal(r.firstSQL, 0, '故障在內容寫入之前擋下');
    assert.deepEqual(r.values, []);
    assert.equal(r.hits, phase === 'cantopen' ? 0 : 2, '注入必須真的命中兩次');
    if (phase === 'race') for (const error of r.errors) assert.equal(error.cause, 'EEXIST');
    if (phase !== 'mkdir') assert.equal(readFileSync(backup, 'utf8'), 'synthetic previous backup');
    if (phase === 'race') assert.equal(readFileSync(c.file, 'utf8'), 'synthetic competing file');
    if (phase === 'new-removed' || phase === 'existing-removed') {
      assert.equal(existsSync(c.file), false, 'mode=rw 不准自行補建');
      for (const index of [0, 1]) {
        const bytes = readFileSync(c.file + '.removed-' + index);
        assert.deepEqual(bytes, phase === 'existing-removed' ? c.oldBytes : Buffer.alloc(0));
      }
    }
  });
}
