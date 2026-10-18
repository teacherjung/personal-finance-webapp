// 只在隔離子行程覆寫內建函式及 umask；合成檔案由呼叫題各自清場。
import fs from 'node:fs';
import { dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

async function runCase() {
  const phase = process.env.STORE_PERMISSION_CASE;
  const file = process.env.STORE_FILE;
  if (!file) throw new Error('缺少隔離主檔路徑');
  if (process.env.STORE_PERMISSION_VERSION) Object.defineProperty(process.versions, 'node', { value: process.env.STORE_PERMISSION_VERSION });
  process.umask(0);
  const native = { open: fs.openSync, close: fs.closeSync, exists: fs.existsSync, mkdir: fs.mkdirSync };
  const exec = DatabaseSync.prototype.exec;
  const prepare = DatabaseSync.prototype.prepare;
  const close = DatabaseSync.prototype.close;
  const log = console.log, errorLog = console.error;
  const mainDescriptors = new Set();
  const report = { diagnostics: [], hits: 0, events: [], beforeSQL: [], errors: [], values: [], alive: [], afterClose: [], firstSQL: 0, closed: 0 };
  const connections = new Set();
  let attempt = 0;
  const modes = () => ['', '-wal', '-shm'].map(suffix => {
    const name = file + suffix;
    return native.exists(name) ? fs.statSync(name).mode & 0o777 : null;
  });
  fs.mkdirSync = (path, options) => {
    if (String(path) === dirname(file) && phase === 'mkdir') {
      report.hits++;
      throw Object.assign(new Error('synthetic mkdir denied'), { code: 'EACCES' });
    }
    return native.mkdir(path, options);
  };
  fs.openSync = (path, flags, mode) => {
    if (String(path) === file) {
      if (phase === 'create') {
        report.hits++;
        throw Object.assign(new Error('synthetic create denied'), { code: 'EACCES' });
      }
      if (phase === 'race') {
        report.hits++;
        // writeFileSync 會回到本探針的 openSync；競爭者用原生 fd 才是真正搶先建立。
        const rival = native.open(file, 'wx', 0o644);
        try { fs.writeSync(rival, 'synthetic competing file'); }
        finally { native.close(rival); }
      }
      const fd = native.open(path, flags, mode);
      mainDescriptors.add(fd);
      const s = fs.fstatSync(fd);
      report.events.push({ event: 'open', flags, mode: s.mode & 0o777, size: s.size });
      return fd;
    }
    return native.open(path, flags, mode);
  };
  fs.closeSync = fd => {
    const main = mainDescriptors.has(fd);
    native.close(fd);
    if (main) {
      mainDescriptors.delete(fd);
      report.events.push({ event: 'close' });
      if (phase === 'close') {
        // 控制只驗關閉呼叫回報錯誤；不是作業系統實際未關閉 fd 的證明。
        report.hits++;
        throw Object.assign(new Error('synthetic close error after physical close'), { code: 'EIO' });
      }
      if (phase === 'new-removed') {
        report.hits++;
        fs.renameSync(file, file + '.removed-' + attempt);
      }
    }
  };
  fs.existsSync = path => {
    const present = native.exists(path);
    if (String(path) === file && present && phase === 'existing-removed') {
      report.hits++;
      fs.renameSync(file, file + '.removed-' + attempt);
    }
    return present;
  };
  DatabaseSync.prototype.exec = function (sql) {
    if (!connections.has(this)) {
      connections.add(this);
      report.firstSQL++;
      report.beforeSQL.push({ modes: modes(), size: fs.statSync(file).size, reservationEvents: report.events.length });
    }
    if (phase.startsWith('sql-')) {
      report.hits++;
      const errcode = phase === 'sql-no-code' ? undefined : phase === 'sql-text-code' ? '11' : Number(phase.slice(4));
      throw Object.assign(new Error('synthetic quick_check exception'), { errcode });
    }
    return exec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql === 'PRAGMA quick_check' && phase.startsWith('quick-')) {
      return { get() {
        report.hits++;
        if (phase === 'quick-throws') throw new Error('quick_check: synthetic exception, not a result');
        if (phase === 'quick-missing') return undefined;
        if (phase === 'quick-empty') return {};
        return { quick_check: 'synthetic broken page' };
      } };
    }
    return prepare.call(this, sql);
  };
  DatabaseSync.prototype.close = function () {
    const result = close.call(this);
    if (connections.has(this)) report.closed++;
    return result;
  };
  console.log = () => {};
  console.error = (...parts) => report.diagnostics[attempt].push(parts.map(String).join(' '));
  syncBuiltinESMExports();
  try {
    const repo = await import('../../lib/repo.js');
    const failing = ['mkdir', 'create', 'close', 'race', 'new-removed', 'existing-removed', 'cantopen', 'readonly-file', 'readonly-directory', 'version-reject'].includes(phase)
      || phase.startsWith('sql-') || phase.startsWith('quick-');
    for (attempt = 0; attempt < (failing ? 2 : 1); attempt++) {
      // 持續故障每輪重建機會；不借前次的主檔或連線當本輪前置。
      if (attempt && ['close', 'race'].includes(phase)) fs.rmSync(file, { force: true });
      if (attempt && phase === 'existing-removed') fs.copyFileSync(file + '.removed-0', file);
      report.diagnostics.push([]);
      try {
        const db = await repo.getDb();
        db.history = [{ id: 'main-permission-' + phase, month: '2026-10', amount: phase === 'reopen' ? 863 : 479 }];
        await repo.saveDb(db);
        report.values.push((await repo.getDb()).history);
        report.alive.push(modes());
        report.errors.push(null);
      } catch (error) { report.errors.push({ message: error.message, cause: error.cause?.code, errcode: error.cause?.errcode }); }
    }
  } finally {
    fs.openSync = native.open; fs.closeSync = native.close;
    fs.existsSync = native.exists; fs.mkdirSync = native.mkdir;
    DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.close = close; console.log = log; console.error = errorLog;
    syncBuiltinESMExports();
    for (const connection of connections) {
      try { close.call(connection); } catch { /* 受測開庫故障可能已關閉；這裡只清理探針持有的連線。 */ }
    }
    for (const fd of mainDescriptors) native.close(fd);
  }
  report.afterClose = modes();
  console.log(JSON.stringify(report));
}

if (process.env.STORE_PERMISSION_CASE) await runCase();
