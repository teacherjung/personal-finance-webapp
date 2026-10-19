// 原生 HTTP 保留傳入 path／headers 與 Buffer；服務及派生產物只在父題的私有暫存區。
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import express from 'express';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TARGET = '<div class="foot-note">資料存於本機<br><code>data/store.db</code></div>';
const project = source => source.replace(TARGET, TARGET.replace('data/store.db', 'SQLite 資料庫'));
const http = (server, path, method = 'GET', headers = {}) => new Promise((done, reject) => {
  const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers, agent: false }, res => {
    const parts = []; res.on('data', b => parts.push(b));
    res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    res.on('error', reject);
  }); req.on('error', reject); req.end();
});
// HTTP client 對 HEAD 會忽略 body；直接量 socket 才能證明線上沒有多送位元組。
const headOnWire = (server, path) => new Promise((done, reject) => {
  const socket = connect(server.address().port, '127.0.0.1'), parts = [];
  socket.setTimeout(5000, () => socket.destroy(new Error('HEAD socket timeout')));
  socket.on('connect', () => socket.write(`HEAD ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
  socket.on('data', b => parts.push(b)); socket.on('error', reject);
  socket.on('end', () => {
    const raw = Buffer.concat(parts), split = raw.indexOf('\r\n\r\n');
    assert.ok(split > 0); done({ headers: raw.subarray(0, split).toString(), body: raw.subarray(split + 4) });
  });
});
async function listen(app) { const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); return server; }
const close = server => new Promise(resolveClose => server.close(resolveClose));
async function runCase() {
  const phase = process.env.LOCAL_INDEX_CASE, created = [], cleaned = [], native = { mkdir: fs.mkdtempSync, write: fs.writeFileSync, rm: fs.rmSync };
  const beforeSignals = ['SIGINT', 'SIGTERM'].map(name => process.listeners(name));
  const beforeExit = process.listenerCount('exit');
  fs.mkdtempSync = (...args) => { const p = native.mkdir(...args); if (String(args[0]).startsWith(join(tmpdir(), 'finance-local-index-'))) created.push(p); return p; };
  fs.writeFileSync = (...args) => {
    if (phase.startsWith('write-failure') && created.some(dir => String(args[0]) === join(dir, 'index.html'))) throw new Error('synthetic projected write failure');
    return native.write(...args);
  };
  fs.rmSync = (...args) => {
    if (created.includes(String(args[0]))) {
      cleaned.push(String(args[0]));
      if (phase === 'write-failure-cleanup-failure') throw new Error('synthetic cleanup failure');
    }
    return native.rm(...args);
  };
  syncBuiltinESMExports();
  const report = { created, cleaned, error: null, steps: [] };
  const servers = [];
  try {
    if (phase !== 'http') {
      const { createLocalIndex } = await import('../../lib/local-index.js');
      try {
        const dir = createLocalIndex(process.env.LOCAL_INDEX_SOURCE);
        report.contents = fs.readFileSync(join(dir, 'index.html'), 'utf8');
        report.files = fs.readdirSync(dir); report.mode = fs.statSync(dir).mode & 0o777;
      } catch (error) { report.error = error.message; }
    } else {
      const source = fs.readFileSync(join(ROOT, 'public/index.html'));
      const projected = Buffer.from(project(source.toString('utf8')));
      assert.notDeepEqual(projected, source);
      const originalApp = express(); originalApp.use(express.static(join(ROOT, 'public')));
      const original = await listen(originalApp); servers.push(original);
      const { app } = await import('../../server.js');
      const actual = await listen(app); servers.push(actual);
      const reference = await http(original, '/'), current = await http(actual, '/');
      assert.equal(current.status, 200); assert.deepEqual(current.body, projected, 'LOCAL 完整表示只替換指定文字');
      assert.equal(current.headers['cache-control'], reference.headers['cache-control']);
      assert.notEqual(current.headers.etag, reference.headers.etag);
      for (const path of ['/', '/index.html', '/?v=test', '/index.html?v=test', '/%69ndex.html', '/index.%68tml', '//index.html', '//', '/INDEX.HTML', '/Index.html']) {
        const base = await http(original, path), got = await http(actual, path);
        assert.equal(got.status, base.status, path);
        if (base.status === 200) {
          assert.deepEqual(base.body, source); assert.deepEqual(got.body, projected, path);
          assert.equal(got.headers.etag, current.headers.etag, path);
        }
        report.steps.push({ path, status: got.status });
      }
      for (const path of ['/index.html/', '/missing-index', '/missing/index.html', '/index.html%00', '/%']) {
        const base = await http(original, path), got = await http(actual, path);
        assert.equal(got.status, base.status, path); assert.notEqual(got.status, 200);
        assert.notDeepEqual(got.body, projected); report.steps.push({ path, status: got.status });
      }
      for (const path of ['/', '/index.html']) {
        const wire = await headOnWire(actual, path); assert.match(wire.headers, /^HTTP\/1.1 200 /); assert.equal(wire.body.length, 0, 'HEAD 線上 body 必須為空');
        const got = await http(actual, path, 'HEAD'); assert.equal(got.status, 200); assert.equal(got.body.length, 0);
        for (const name of ['content-length', 'content-type', 'etag', 'last-modified']) assert.equal(got.headers[name], current.headers[name], name);
        assert.equal(Number(got.headers['content-length']), projected.length);
        const post = await http(actual, path, 'POST'), originalPost = await http(original, path, 'POST'); assert.equal(post.status, originalPost.status);
      }
      for (const headers of [{ 'If-None-Match': current.headers.etag }, { 'If-Modified-Since': current.headers['last-modified'] }]) {
        const got = await http(actual, '/', 'GET', headers); assert.equal(got.status, 304); assert.equal(got.body.length, 0);
      }
      for (const headers of [{ 'If-None-Match': reference.headers.etag }, { 'If-None-Match': '"different"' }, { 'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' }]) {
        const got = await http(actual, '/', 'GET', headers); assert.equal(got.status, 200); assert.deepEqual(got.body, projected);
      }
      const start = projected.indexOf(Buffer.from('資料存於本機')) - 8, end = start + 140;
      assert.ok(start > 0); const range = `bytes=${start}-${end}`;
      for (const path of ['/', '/index.html']) {
        const got = await http(actual, path, 'GET', { Range: range }); assert.equal(got.status, 206);
        assert.deepEqual(got.body, projected.subarray(start, end + 1)); assert.equal(Number(got.headers['content-length']), end - start + 1);
        assert.equal(got.headers['content-range'], `bytes ${start}-${end}/${projected.length}`);
      }
      const badRange = await http(actual, '/', 'GET', { Range: 'bytes=9999999-' });
      assert.equal(badRange.status, 416); assert.equal(badRange.headers['content-range'], 'bytes */' + projected.length);
      const fresh = await http(actual, '/', 'GET', { Range: range, 'If-Range': current.headers.etag });
      assert.equal(fresh.status, 206); assert.deepEqual(fresh.body, projected.subarray(start, end + 1));
      const stale = await http(actual, '/', 'GET', { Range: range, 'If-Range': '"old"' });
      assert.equal(stale.status, 200); assert.deepEqual(stale.body, projected);
      for (const path of ['/styles.css', '/app.js']) for (const headers of [{}, { Range: 'bytes=10-91' }]) {
        const base = await http(original, path, 'GET', headers), got = await http(actual, path, 'GET', headers);
        assert.equal(got.status, base.status); assert.ok(got.body.equals(base.body), path + ' 原資產位元組保持');
        for (const name of ['content-length', 'content-type', 'etag', 'last-modified', 'content-range']) assert.equal(got.headers[name], base.headers[name]);
      }
      const mode = await http(actual, '/api/mode'); assert.equal(mode.status, 200); assert.deepEqual(JSON.parse(mode.body.toString()), { hosted: false });
      const unknown = await http(actual, '/api/unknown-local-index'); assert.equal(unknown.status, 404);
      assert.deepEqual(JSON.parse(unknown.body.toString()), { error: '不存在的 API 路徑' });
      assert.equal(created.length, 1); assert.deepEqual(fs.readdirSync(created[0]), ['index.html']);
      assert.deepEqual(fs.readFileSync(join(created[0], 'index.html')), projected);
      const again = await listen(app); servers.push(again); assert.deepEqual((await http(again, '/')).body, projected); assert.equal(created.length, 1);
      assert.deepEqual(fs.readFileSync(join(ROOT, 'public/index.html')), source);
      report.bytes = projected.length; report.steps.push('HEAD', '304/current', '200/old', '206/shifted', '416', 'If-Range', 'assets', 'mode', 'repeat-listen');
    }
    report.exitListenersAdded = process.listenerCount('exit') - beforeExit;
    for (const [i, name] of ['SIGINT', 'SIGTERM'].entries()) assert.deepEqual(process.listeners(name), beforeSignals[i], name);
  } finally {
    for (const server of servers) await close(server);
    fs.mkdtempSync = native.mkdir; fs.writeFileSync = native.write; fs.rmSync = native.rm;
    syncBuiltinESMExports();
  }
  report.presentBeforeExit = created.map(dir => fs.existsSync(dir));
  console.log(JSON.stringify(report));
}
if (process.env.LOCAL_INDEX_CASE) await runCase();
