// 隔離子行程才改 umask 與內建函式，避免其他考題承受探針的副作用。
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Node 的整份考題搜尋也會載入 helpers；只有隔離子行程帶本探針的入口旗標。
async function runCase() {
  const kind = process.env.PERMISSION_CASE;
  const phase = process.env.PERMISSION_FAILURE || '';
  const target = process.env.PERMISSION_DEST;
  const file = process.env.STORE_FILE;
  if (!file || !target) throw new Error('缺隔離路徑');
  process.umask(0);

  const repo = await import('../../lib/repo.js');
  const fixture = repo.emptyDb();
  fixture.history = [{ id: 'private-backup-probe', month: '2026-10', amount: 471 }];
  fixture.transactions = [{ id: 'legacy-ledger-probe', date: '2026-10-12', type: 'expense', category: '其他', subcategory: '未分類', amount: 123, note: '合成搬家資料', account: '合成帳戶', source: 'bank' }];
  fixture.securityTrades = [{ id: 'legacy-sec-probe', symbol: 'DEMO', tradeDate: '2026-10-12' }];
  const seed = new DatabaseSync(file);
  seed.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const put = seed.prepare('INSERT INTO kv(key,data) VALUES(?,?)');
  for (const [key, value] of Object.entries(fixture)) put.run(key, JSON.stringify(value));
  seed.close();

  const tmp = target + '.tmp';
  const sqlTarget = `VACUUM INTO '${tmp.replace(/'/g, "''")}'`;
  const report = { beforeModes: [], hits: 0, warnings: [], threw: false, created: null, failStreak: null };
  const open = fs.openSync;
  const rename = fs.renameSync;
  const exec = DatabaseSync.prototype.exec;
  const warn = console.warn;
  const log = console.log;
  fs.openSync = function (path, flags, mode) {
    if (String(path) === tmp && flags === 'wx' && phase === 'create') {
      report.hits++;
      throw new Error('private-temp-create-probe');
    }
    return open(path, flags, mode);
  };
  fs.renameSync = function (from, to) {
    if (String(from) === tmp && String(to) === target && phase === 'rename') {
      report.hits++;
      throw new Error('private-temp-rename-probe');
    }
    return rename(from, to);
  };
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === sqlTarget) {
      report.beforeModes.push(fs.existsSync(tmp) ? fs.statSync(tmp).mode & 0o777 : null);
      if (phase === 'vacuum') {
        report.hits++;
        fs.writeFileSync(tmp, 'synthetic-partial-snapshot');
        throw new Error('private-temp-vacuum-probe');
      }
    }
    return exec.call(this, sql);
  };
  console.warn = (...args) => { report.warnings.push(String(args[0])); };
  console.log = () => {};
  // store.js 的具名 import 要看到本題的探針；只在這個隔離行程同步。
  syncBuiltinESMExports();
  try {
    await repo.getDb();
    if (kind === 'snapshot') repo.snapshotTo(target);
    if (kind === 'daily') {
      const { dailyBackupIfDue } = await import('../../lib/services/backup.js');
      const result = await dailyBackupIfDue('2026-10-12');
      report.created = result.created;
      report.failStreak = result.failStreak;
    }
  } catch {
    report.threw = true;
  } finally {
    fs.openSync = open;
    fs.renameSync = rename;
    DatabaseSync.prototype.exec = exec;
    console.warn = warn;
    console.log = log;
    syncBuiltinESMExports();
  }
  console.log(JSON.stringify(report));
}

if (process.env.PERMISSION_CASE) await runCase();
