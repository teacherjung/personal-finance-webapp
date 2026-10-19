// 子行程分開載入兩種啟動模式；STORE_FILE 與派生首頁限本題私有暫存區，不開帳本 API。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const ico = join(root, 'lib/assets/local-favicon.ico');
const http = (server, path, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers, agent: false }, res => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); req.end();
});
const headWire = server => new Promise((resolve, reject) => {
  const socket = connect(server.address().port, '127.0.0.1'), chunks = [];
  socket.setTimeout(5000, () => socket.destroy(new Error('favicon HEAD timeout')));
  socket.on('connect', () => socket.write('HEAD /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
  socket.on('data', c => chunks.push(c)); socket.on('error', reject);
  socket.on('end', () => {
    const bytes = Buffer.concat(chunks), split = bytes.indexOf('\r\n\r\n');
    assert(split > 0); resolve({ headers: bytes.subarray(0, split).toString(), body: bytes.subarray(split + 4) });
  });
});

async function probe(mode) {
  assert(['local', 'hosted'].includes(mode));
  // 任何意外外連都使本題失敗；HOSTED 只測不需登入的根路徑。
  globalThis.fetch = async () => { throw new Error('favicon test forbids external fetch'); };
  const { app } = await import('../server.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const expected = fs.readFileSync(ico), steps = [];
  try {
    if (mode === 'hosted') {
      for (const path of ['/favicon.ico', '/favicon.ico?probe=1']) {
        const r = await http(server, path); assert.equal(r.status, 404);
        assert.notDeepEqual(r.body, expected); steps.push(path);
      }
    } else {
      const got = await http(server, '/favicon.ico');
      assert.equal(got.status, 200); assert.deepEqual(got.body, expected);
      assert.equal(got.headers['content-type'], 'image/x-icon');
      assert.equal(Number(got.headers['content-length']), expected.length);
      assert.equal(got.headers['cache-control'], 'public, max-age=0');
      assert.equal(typeof got.headers.etag, 'string');
      assert(Number.isFinite(Date.parse(got.headers['last-modified'])));
      steps.push('GET exact bytes and MIME');
      const query = await http(server, '/favicon.ico?probe=1');
      assert.equal(query.status, 200); assert.deepEqual(query.body, expected); steps.push('query');
      const head = await http(server, '/favicon.ico', 'HEAD');
      assert.equal(head.status, 200); assert.equal(head.body.length, 0);
      for (const h of ['content-length', 'content-type', 'etag', 'last-modified', 'cache-control']) assert.equal(head.headers[h], got.headers[h]);
      const wire = await headWire(server); assert.match(wire.headers, /^HTTP\/1.1 200 /); assert.equal(wire.body.length, 0);
      steps.push('HEAD headers and wire body');
      for (const h of [{ 'If-None-Match': got.headers.etag }, { 'If-Modified-Since': got.headers['last-modified'] }]) {
        const r = await http(server, '/favicon.ico', 'GET', h); assert.equal(r.status, 304); assert.equal(r.body.length, 0);
      }
      steps.push('conditional GET');
      for (const path of ['/favicon.ico/', '/favicon.ico/extra', '/FAVICON.ICO', '/missing-favicon-probe']) {
        const r = await http(server, path); assert.equal(r.status, 404); assert.notDeepEqual(r.body, expected);
      }
      const post = await http(server, '/favicon.ico', 'POST'); assert.equal(post.status, 404); assert.notDeepEqual(post.body, expected);
      const unknown = await http(server, '/api/missing-favicon-probe'); assert.equal(unknown.status, 404);
      assert.deepEqual(JSON.parse(unknown.body.toString()), { error: '不存在的 API 路徑' }); steps.push('404 boundaries');
      const brand = await http(server, '/assets/brand.png'); assert.equal(brand.status, 200);
      assert.deepEqual(brand.body, fs.readFileSync(join(root, 'public/assets/brand.png')));
      const home = await http(server, '/'); assert.equal(home.status, 200);
      const source = fs.readFileSync(join(root, 'public/index.html'), 'utf8');
      const target = '<div class="foot-note">資料存於本機<br><code>data/store.db</code></div>';
      assert.equal(source.split(target).length - 1, 1);
      assert.deepEqual(home.body, Buffer.from(source.replace(target, target.replace('data/store.db', 'SQLite 資料庫'))));
      steps.push('brand and home');
    }
    assert.equal(fs.existsSync(process.env.STORE_FILE), false);
    console.log(JSON.stringify({ mode, steps, storeAbsent: true }));
  } finally { await new Promise(resolve => server.close(resolve)); }
}


// 只把正式 sendFile 的固定資產換成本題私有副本；路由、回呼與真實讀檔仍由 app 執行。
async function probeError(mode) {
  assert(['missing', 'unreadable', 'range', 'no-status'].includes(mode));
  globalThis.fetch = async () => { throw new Error('favicon error test forbids external fetch'); };
  const privateIco = join(process.env.TMPDIR, 'private-favicon.ico');
  const expected = fs.readFileSync(ico);
  fs.writeFileSync(privateIco, expected, { mode: 0o600 });
  const originalMode = fs.statSync(privateIco).mode & 0o777, held = privateIco + '.held';
  const { app } = await import('../server.js');
  const nativeSendFile = app.response.sendFile;
  let hits = 0, inject = false, injections = 0;
  app.response.sendFile = function (path, ...args) {
    assert.equal(path, ico); hits++;
    if (inject) {
      const callback = args.at(-1); assert.equal(typeof callback, 'function'); injections++;
      callback(new Error('synthetic no-status file failure: ' + privateIco)); return this;
    }
    return nativeSendFile.call(this, privateIco, ...args);
  };
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const responses = [];
  const capture = async (method = 'GET', headers = {}) => {
    const r = await http(server, '/favicon.ico', method, headers);
    responses.push({ method, status: r.status, headers: r.headers, body: r.body.toString() });
    return r;
  };
  let success, changed = false;
  try {
    success = await http(server, '/favicon.ico'); assert.equal(success.status, 200); assert.deepEqual(success.body, expected);
    if (mode === 'missing') { fs.renameSync(privateIco, held); changed = true; assert.equal(fs.existsSync(privateIco), false); }
    if (mode === 'unreadable') {
      fs.chmodSync(privateIco, 0); changed = true; assert.equal(fs.statSync(privateIco).mode & 0o777, 0);
      assert.throws(() => fs.readFileSync(privateIco), { code: 'EACCES' });
    }
    if (mode === 'no-status') inject = true;
    const status = mode === 'missing' ? 404 : mode === 'range' ? 416 : 500;
    const bad = await capture('GET', mode === 'range' ? { Range: 'bytes=' + (expected.length + 10) + '-' } : {});
    assert.equal(bad.status, status);
    assert.match(bad.headers['content-type'], /^application\/json(?:;|$)/);
    assert.deepEqual(JSON.parse(bad.body.toString()), { error: '圖示暫時無法載入' });
    assert(!bad.body.toString().includes(privateIco)); assert.doesNotMatch(bad.body.toString(), /EACCES|Error:|at probe/);
    assert.equal(bad.headers['cache-control'], 'no-store');
    assert.equal(bad.headers['last-modified'], undefined); assert.equal(bad.headers['accept-ranges'], undefined);
    assert.notEqual(bad.headers.etag, success.headers.etag);
    assert.equal(Number(bad.headers['content-length']), bad.body.length);
    if (mode === 'range') assert.equal(bad.headers['content-range'], 'bytes */' + expected.length);
    else assert.equal(bad.headers['content-range'], undefined);
    if (mode === 'missing') {
      const head = await capture('HEAD'); assert.equal(head.status, 404); assert.equal(head.body.length, 0);
      for (const name of ['content-type', 'content-length', 'etag', 'cache-control']) assert.equal(head.headers[name], bad.headers[name]);
      assert.equal(head.headers['last-modified'], undefined); assert.equal(head.headers['accept-ranges'], undefined);
    }
    assert.equal(hits, mode === 'missing' ? 3 : 2);
    assert.equal(injections, mode === 'no-status' ? 1 : 0);
    assert.equal(fs.existsSync(process.env.STORE_FILE), false);
  } finally {
    if (changed && mode === 'missing') fs.renameSync(held, privateIco);
    fs.chmodSync(privateIco, originalMode);
    assert.equal(fs.statSync(privateIco).mode & 0o777, originalMode); assert.deepEqual(fs.readFileSync(privateIco), expected);
    await new Promise(resolve => server.close(resolve)); app.response.sendFile = nativeSendFile;
    console.log(JSON.stringify({ mode, hits, injections, responses, storeAbsent: !fs.existsSync(process.env.STORE_FILE) }));
  }
}

if (process.env.FINANCE_FAVICON_ERROR) {
  await probeError(process.env.FINANCE_FAVICON_ERROR);
} else if (process.env.FINANCE_FAVICON_CASE) {
  await probe(process.env.FINANCE_FAVICON_CASE);
} else {
  for (const mode of ['local', 'hosted']) test('favicon 正式接線｜' + mode, () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'finance-favicon-'));
    try {
      const env = { ...gitEnv(), STORE_FILE: join(dir, 'store.db'), TMPDIR: dir, FINANCE_FAVICON_CASE: mode,
        NOTEASY_HOSTED: mode === 'hosted' ? '1' : '0', SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_ANON_KEY: 'test-anon-key', SITE_ORIGIN: 'http://localhost:4321',
        NOTEASY_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') };
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2e6 });
      assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 0, r.stdout + r.stderr);
      const report = JSON.parse(r.stdout.trim()); assert.equal(report.mode, mode); assert.equal(report.storeAbsent, true);
      assert.deepEqual(report.steps, mode === 'hosted' ? ['/favicon.ico', '/favicon.ico?probe=1'] :
        ['GET exact bytes and MIME', 'query', 'HEAD headers and wire body', 'conditional GET', '404 boundaries', 'brand and home']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  for (const mode of ['missing', 'unreadable', 'range', 'no-status']) {
    const skip = mode === 'unreadable' && (process.platform === 'win32' || process.getuid?.() === 0) ? '需要 POSIX 非 root 的真實讀取拒絕' : false;
    test('favicon 錯誤表徵｜' + mode, { skip }, () => {
      const dir = fs.mkdtempSync(join(tmpdir(), 'finance-favicon-error-'));
      try {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
          cwd: root, env: { ...gitEnv(), STORE_FILE: join(dir, 'store.db'), TMPDIR: dir, NOTEASY_HOSTED: '0',
            FINANCE_FAVICON_CASE: '', FINANCE_FAVICON_ERROR: mode }, encoding: 'utf8', timeout: 30000, maxBuffer: 2e6,
        });
        assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.status, 0, r.stdout + r.stderr);
        const report = JSON.parse(r.stdout.trim()); assert.equal(report.mode, mode); assert.equal(report.storeAbsent, true);
        assert.equal(report.responses.length, mode === 'missing' ? 2 : 1);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
