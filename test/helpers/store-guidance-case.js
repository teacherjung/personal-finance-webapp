// 子程序只使用父題給的合成來源／資料；對預設位置的考題也不載入正式樹的資料目錄。
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

async function runCase() {
  const root = process.env.STORE_GUIDANCE_SOURCE;
  const phase = process.env.STORE_GUIDANCE_CASE;
  const file = resolve(process.env.STORE_FILE || join(root, 'data/store.db'));
  const report = { diagnostic: '', errors: [], responses: [], localErrors: [], io: [], sql: 0 };
  const originals = {}, errorLog = console.error;
  const sql = DatabaseSync.prototype.exec;
  let server;
  console.error = (...parts) => report.localErrors.push(parts.map(String).join(' '));
  if (phase === 'location') {
    for (const name of ['existsSync', 'mkdirSync', 'openSync', 'readFileSync', 'statSync', 'renameSync', 'rmSync']) {
      originals[name] = fs[name];
      fs[name] = (...args) => {
        if (typeof args[0] === 'string' && (resolve(args[0]) === file || resolve(args[0]).startsWith(file + '.'))) report.io.push(name);
        return originals[name](...args);
      };
    }
    DatabaseSync.prototype.exec = function (...args) { report.sql++; return sql.apply(this, args); };
    syncBuiltinESMExports();
  }
  if (phase === 'cause-bound') {
    originals.openSync = fs.openSync;
    fs.openSync = (...args) => {
      if (String(args[0]) === file) throw new Error('private-cause\n\u001b\u0085\u202e' + '原因'.repeat(10000));
      return originals.openSync(...args);
    };
    syncBuiltinESMExports();
  }
  try {
    const repo = await import(pathToFileURL(join(root, 'lib/repo.js')).href);
    if (phase === 'location') {
      const result = repo.getLocalStoreDiagnostic();
      report.promise = result instanceof Promise;
      report.diagnostic = await result;
      process.env.STORE_FILE = file + '.changed-after-import';
      report.afterEnvChange = await repo.getLocalStoreDiagnostic();
    } else if (phase === 'cause-bound') {
      try { await repo.getDb(); }
      catch (error) { report.errors.push({ message: error.message, cause: error.cause?.message }); }
    } else {
      const http = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('unexpected external request'); };
      const { app } = await import(pathToFileURL(join(root, 'server.js')).href);
      server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
      const base = 'http://127.0.0.1:' + server.address().port;
      for (const stream of [null, false, true]) {
        const path = stream === null ? '/api/db' : '/api/bank-statement/preview';
        const response = await http(base + path, stream === null ? {} : {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'c3ludGhldGlj', stream, useAi: false }),
        });
        report.responses.push({ path, stream, status: response.status, raw: await response.text() });
      }
      for (let n = 0; n < 2; n++) {
        try { await repo.getDb(); report.errors.push(null); }
        catch (error) { report.errors.push({ message: error.message, code: error.cause?.code, errcode: error.cause?.errcode }); }
      }
    }
  } finally {
    if (server) await new Promise(resolveClose => server.close(resolveClose));
    for (const [name, fn] of Object.entries(originals)) fs[name] = fn;
    DatabaseSync.prototype.exec = sql;
    syncBuiltinESMExports(); console.error = errorLog;
  }
  console.log(JSON.stringify(report));
}
if (process.env.STORE_GUIDANCE_CASE) await runCase();
