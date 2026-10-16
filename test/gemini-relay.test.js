// 只有 localhost relay 與假 transport；不讀憑證、不呼叫 Google、不建立 Git 倉庫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request, createServer } from 'node:http';
import { connect } from 'node:net';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startGeminiRelay, normalizeCodeAssistResponse, UPSTREAM_URL, MAX_BODY_BYTES } from '../scripts/gemini-relay.js';
import { MAX_RESPONSE_BYTES, MAX_REPLY_BYTES } from '../scripts/gemini-client.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const text = '假材料提到 enabled_credit_types，並非能力欄位。';
const nonce = 'synthetic-nonce-1234567890';
const token = 'SYNTHETIC-OUTSIDE-ACCESS-TOKEN';
const project = 'synthetic-existing-project';
const config = () => ({ nonce, scanId: 'scan-test', materialSha256: sha(text), materialBytes: Buffer.byteLength(text), model: 'gemini-test-pro', thinking: 'HIGH', project, getAccessToken: async () => token });
const body = () => ({ scanId: 'scan-test', materialSha256: sha(text), model: 'gemini-test-pro', thinking: 'HIGH', text });
const upstream = () => ({ response: { modelVersion: 'gemini-test-pro', candidates: [{ content: { role: 'model', parts: [{ text: '不要保存的想法', thought: true }, { text: '靜態答案。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } } });

async function relay(t, opts = {}) {
  const seen = [];
  const r = await startGeminiRelay(config(), { transport: async (req) => { seen.push(req); return opts.respond ? opts.respond(req) : { statusCode: 200, body: Buffer.from(JSON.stringify(upstream())) }; } });
  t.after(() => r.close());
  return { r, seen };
}
function send(r, value = body(), options = {}) {
  return new Promise((ok, bad) => {
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    const q = request(r.url, { method: options.method ?? 'POST', path: options.path ?? '/generate', headers: { 'content-type': 'application/json', authorization: `Bearer ${options.nonce ?? nonce}`, ...options.headers } }, (res) => {
      const chunks = []; res.on('data', (x) => chunks.push(x)); res.on('end', () => ok({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })); res.on('error', bad);
    }); q.on('error', bad); q.end(payload);
  });
}

test('relay 正面：重建 CodeAssist 請求、只把假 token/project 送到假上游', async (t) => {
  const { r, seen } = await relay(t);
  const response = await send(r), result = JSON.parse(response.text);
  assert.equal(response.status, 200); assert.equal(seen.length, 1);
  assert.equal(UPSTREAM_URL, 'https://cloudcode-pa.googleapis.com/v1internal:generateContent');
  assert.equal(seen[0].url, UPSTREAM_URL); assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const sent = JSON.parse(seen[0].body);
  assert.deepEqual(sent, { model: 'gemini-test-pro', project, user_prompt_id: 'scan-test', request: { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } }, session_id: 'scan-test' } });
  assert.equal(result.reply, '靜態答案。'); assert.equal(result.replySha256, sha(result.reply));
  assert.doesNotMatch(response.text, /SYNTHETIC-OUTSIDE|synthetic-existing-project|不要保存的想法/);
  const snap = r.snapshot(); assert.equal(snap.failed, false); assert.equal(snap.requestCount, 1); assert.deepEqual(snap.response, result);
  snap.response.reply = 'fake'; assert.equal(r.snapshot().response.reply, '靜態答案。');
});

test('relay 未知／credits／tools 協定欄位拒絕，假上游零呼叫', async (t) => {
  for (const key of ['enabledCreditTypes', 'enabled_credit_types', 'billing', 'overage', 'tools', 'request', 'unknown', '__proto__']) {
    for (const value of [null, [], { enabledCreditTypes: [] }]) {
      await t.test(`${key}-${JSON.stringify(value)}`, async (t2) => {
        const { r, seen } = await relay(t2);
        const payload = JSON.parse(JSON.stringify(body())); Object.defineProperty(payload, key, { value, enumerable: true });
        const out = await send(r, payload); assert.notEqual(out.status, 200); assert.equal(seen.length, 0); assert.equal(r.snapshot().failed, true);
      });
    }
  }
});

test('relay 核 scanId、雜湊、實際 bytes、model 與 HIGH', async (t) => {
  for (const patch of [{ scanId: 'other' }, { model: 'gemini-cheap' }, { thinking: 'LOW' }, { materialSha256: '0'.repeat(64) }, { text: text + '!' }, { text: text.replace('假', '壞') }]) {
    await t.test(Object.keys(patch)[0], async (t2) => {
      const { r, seen } = await relay(t2); const out = await send(r, { ...body(), ...patch });
      assert.notEqual(out.status, 200); assert.equal(seen.length, 0); assert.equal(r.snapshot().failed, true);
    });
  }
  const cfg = { ...config(), materialBytes: Buffer.byteLength(text) + 1 }, seen = [];
  const r = await startGeminiRelay(cfg, { transport: async (q) => { seen.push(q); return { statusCode: 200, body: Buffer.from(JSON.stringify(upstream())) }; } }); t.after(() => r.close());
  assert.notEqual((await send(r)).status, 200); assert.equal(seen.length, 0);
});

test('relay 路由、method、nonce、內容格式與任意上游請求拒絕', async (t) => {
  for (const options of [{ nonce: 'wrong' }, { method: 'GET' }, { path: '/v1internal:onboardUser' }, { path: '/billing' }, { path: '/setCodeAssistGlobalUserSetting' }, { path: '/generate?x=1' }, { path: 'https://other.example/generate' }, { headers: { 'content-type': 'text/plain' } }, { headers: { 'content-encoding': 'gzip' } }]) {
    await t.test(JSON.stringify(options), async (t2) => {
      const { r, seen } = await relay(t2); assert.notEqual((await send(r, body(), options)).status, 200); assert.equal(seen.length, 0); assert.equal(r.snapshot().failed, true);
    });
  }
});

test('relay 壞 JSON、空 body 與超量請求都不進上游', async (t) => {
  for (const payload of ['{', '', JSON.stringify(body()) + ' '.repeat(MAX_BODY_BYTES)]) {
    await t.test(`length-${payload.length}`, async (t2) => {
      const { r, seen } = await relay(t2);
      await send(r, payload).catch(() => {}); assert.equal(seen.length, 0); assert.equal(r.snapshot().failed, true);
    });
  }
});

test('relay 一次生成與 sticky failure：成功後壞請求亦不得洗白', async (t) => {
  const { r, seen } = await relay(t);
  assert.equal((await send(r)).status, 200);
  assert.notEqual((await send(r)).status, 200);
  assert.notEqual((await send(r)).status, 200);
  assert.equal(seen.length, 1); assert.equal(r.snapshot().failed, true); assert.equal(r.snapshot().response, null);
  const second = await relay(t); await send(second.r, body(), { nonce: 'bad' });
  await send(second.r); assert.equal(second.seen.length, 0); assert.equal(second.r.snapshot().failed, true);
});

test('relay 並發在 await 前佔生成名額', async (t) => {
  let release;
  const wait = new Promise((ok) => { release = ok; });
  const { r, seen } = await relay(t, { respond: async () => { await wait; return { statusCode: 200, body: Buffer.from(JSON.stringify(upstream())) }; } });
  const first = send(r); while (!seen.length) await new Promise((ok) => setImmediate(ok));
  const second = await send(r); release(); const a = await first;
  assert.notEqual(second.status, 200); assert.notEqual(a.status, 200); assert.equal(seen.length, 1); assert.equal(r.snapshot().failed, true);
});

test('上游回覆只接受指定模型、STOP、非 thought 文字，不接受工具', () => {
  const normalized = normalizeCodeAssistResponse(upstream(), config()); assert.equal(normalized.reply, '靜態答案。');
  const bad = [];
  for (const edit of [
    (v) => { delete v.response.modelVersion; },
    (v) => { v.response.modelVersion = 'gemini-fallback'; },
    (v) => { v.response.candidates[0].finishReason = 'MAX_TOKENS'; },
    (v) => { v.response.candidates[0].content.parts = [{ text: '', thought: false }]; },
    (v) => { v.response.candidates[0].content.parts = [{ text: 'only hidden', thought: true }]; },
    (v) => { v.response.candidates[0].content.parts.push({ functionCall: { name: 'x' } }); },
    (v) => { v.response.candidates[0].content.parts.push({ fileData: { fileUri: 'x' } }); },
    (v) => { v.response.candidates[0].content.parts.push({ text: 'x', unknown: true }); },
    (v) => { v.response.candidates.push(v.response.candidates[0]); },
    (v) => { v.response.usageMetadata = { totalTokenCount: -1 }; },
    (v) => { v.consumedCredits = [{ creditAmount: '1' }]; },
  ]) { const v = upstream(); edit(v); bad.push(v); }
  for (const v of bad) assert.throws(() => normalizeCodeAssistResponse(v, config()), /UPSTREAM/);
});

test('relay 上游拒絕、redirect、壞回覆與例外不重試也不回顯', async (t) => {
  for (const statusCode of [301, 302, 401, 403, 429, 500]) {
    await t.test(String(statusCode), async (t2) => {
      const { r, seen } = await relay(t2, { respond: () => ({ statusCode, body: Buffer.from(JSON.stringify(upstream())) }) });
      const out = await send(r); assert.notEqual(out.status, 200); assert.equal(seen.length, 1); assert.doesNotMatch(out.text, /SYNTHETIC-OUTSIDE/); assert.equal(r.snapshot().failed, true);
    });
  }
  const s = await relay(t, { respond: () => { throw new Error(token); } });
  assert.doesNotMatch((await send(s.r)).text, /SYNTHETIC-OUTSIDE/); assert.equal(s.r.snapshot().failed, true);
});

test('relay 防上游回聲：token/project 不回盒，壞 UTF-8 不放行', async (t) => {
  for (const secret of [token, project]) {
    const v = upstream(); v.response.candidates[0].content.parts = [{ text: secret }];
    const s = await relay(t, { respond: () => ({ statusCode: 200, body: Buffer.from(JSON.stringify(v)) }) });
    const out = await send(s.r); assert.notEqual(out.status, 200); assert.equal(out.text.includes(secret), false); assert.equal(s.r.snapshot().response, null);
  }
  const s = await relay(t, { respond: () => ({ statusCode: 200, body: Buffer.from([0xc3, 0x28]) }) });
  assert.notEqual((await send(s.r)).status, 200); assert.equal(s.r.snapshot().failed, true);
});

test('relay close 關閉半包 socket，取消進行中上游且可重複關閉', async (t) => {
  const { r } = await relay(t);
  const socket = connect(r.port, '127.0.0.1'); await new Promise((ok) => socket.once('connect', ok));
  socket.on('error', () => {});
  socket.write(`POST /generate HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${nonce}\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{`);
  const closed = new Promise((ok) => socket.once('close', ok));
  while (r.snapshot().requestCount !== 1) await new Promise((ok) => setImmediate(ok));
  let timer;
  const timely = await Promise.race([r.close().then(() => true), new Promise((ok) => { timer = setTimeout(() => ok(false), 500); })]);
  clearTimeout(timer); socket.destroy(); assert.equal(timely, true);
  await closed; await r.close();
  assert.equal(r.snapshot().failed, true);
  let signal;
  const pending = await relay(t, { respond: (req) => { signal = req.signal; return new Promise((ok, bad) => {
    const timer = setTimeout(() => ok({ statusCode: 200, body: Buffer.from(JSON.stringify(upstream())) }), 150);
    req.signal.addEventListener('abort', () => { clearTimeout(timer); bad(new Error('aborted')); }, { once: true });
  }); } });
  const active = send(pending.r).catch(() => null); while (!signal) await new Promise((ok) => setImmediate(ok));
  await pending.r.close(); await active; assert.equal(signal.aborted, true); assert.equal(pending.r.snapshot().failed, true);
});

test('relay config、auth 與上游大小有獨立拒絕證據', async (t) => {
  for (const patch of [{ project: '' }, { nonce: 'short' }, { thinking: 'LOW' }, { enabledCreditTypes: [] }, { getAccessToken: null }]) {
    await assert.rejects(startGeminiRelay({ ...config(), ...patch }, { transport: async () => { throw new Error('must not run'); } }));
  }
  for (const getAccessToken of [async () => '', async () => 'bad\r\ntoken', async () => { throw new Error(token); }]) {
    let calls = 0;
    const r = await startGeminiRelay({ ...config(), getAccessToken }, { transport: async () => { calls += 1; return {}; } }); t.after(() => r.close());
    const out = await send(r); assert.notEqual(out.status, 200); assert.equal(calls, 0); assert.equal(out.text.includes(token), false); assert.equal(r.snapshot().failed, true);
  }
  const tooBig = await relay(t, { respond: () => ({ statusCode: 200, body: Buffer.from(JSON.stringify(upstream()) + ' '.repeat(MAX_RESPONSE_BYTES)) }) });
  assert.notEqual((await send(tooBig.r)).status, 200); assert.equal(tooBig.r.snapshot().reason, 'UPSTREAM_SIZE');
  const v = upstream(); v.response.candidates[0].content.parts = [{ text: 'a'.repeat(MAX_REPLY_BYTES + 1) }];
  assert.throws(() => normalizeCodeAssistResponse(v, config()), /UPSTREAM_RESULT/);
});

test('relay close 可終止尚未回覆的 auth，不等待承諾兌現', async (t) => {
  let called = false;
  const r = await startGeminiRelay({ ...config(), getAccessToken: () => { called = true; return new Promise(() => {}); } }, { transport: async () => { throw new Error('must not run'); } });
  t.after(() => r.close());
  const pending = send(r).catch(() => null); while (!called) await new Promise((ok) => setImmediate(ok));
  await r.close(); await pending; assert.equal(r.snapshot().failed, true);
});

test('relay 原生 https 正式接線：不注入 transport，狀態與完整請求可觀測', async (t) => {
  for (const status of [200, 302, 401, 403, 429]) {
    await t.test(String(status), async (t2) => {
      const captured = [];
      const stub = t2.mock.method(https, 'request', (url, options, callback) => {
        const req = new EventEmitter();
        req.end = (body) => {
          captured.push({ url, options, body });
          const res = new PassThrough(); res.statusCode = status; res.complete = true;
          callback(res);
          // 負例也餵合法成功格式，才不會被 JSON 解析失敗遮住 status 防線。
          res.end(JSON.stringify(upstream()));
        };
        return req;
      });
      syncBuiltinESMExports();
      t2.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
      const r = await startGeminiRelay(config()); t2.after(() => r.close());
      const out = await send(r);
      assert.equal(captured.length, 1);
      const actual = captured[0];
      assert.equal(actual.url, 'https://cloudcode-pa.googleapis.com/v1internal:generateContent');
      assert.equal(actual.options.method, 'POST'); assert.equal(actual.options.agent, false);
      assert.deepEqual(actual.options.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
      assert.deepEqual(JSON.parse(actual.body), { model: 'gemini-test-pro', project, user_prompt_id: 'scan-test', request: { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } }, session_id: 'scan-test' } });
      if (status === 200) { assert.equal(out.status, 200); assert.equal(r.snapshot().failed, false); }
      else { assert.notEqual(out.status, 200); assert.equal(r.snapshot().failed, true); assert.equal(r.snapshot().reason, 'UPSTREAM_STATUS'); }
    });
  }
});

test('relay 指定 canary 同 port，搶占或非法 port 不另挑也不生成', async (t) => {
  let calls = 0;
  const transport = async () => { calls += 1; return { statusCode: 200, body: Buffer.from(JSON.stringify(upstream())) }; };
  const occupied = createServer(); await new Promise((ok) => occupied.listen(0, '127.0.0.1', ok));
  const port = occupied.address().port;
  t.after(() => occupied.close());
  await assert.rejects(async () => { const unexpected = await startGeminiRelay({ ...config(), port }, { transport }); await unexpected.close(); }, /BIND/);
  assert.equal(calls, 0);
  await new Promise((ok) => occupied.close(ok));
  const r = await startGeminiRelay({ ...config(), port }, { transport }); t.after(() => r.close());
  assert.equal(r.port, port); assert.equal((await send(r)).status, 200); assert.equal(calls, 1);
  for (const bad of [0, -1, 65536, 3.5, '1234', undefined]) {
    await assert.rejects(async () => { const unexpected = await startGeminiRelay({ ...config(), port: bad }, { transport }); await unexpected.close(); }, /CONFIG/);
  }
  assert.equal(calls, 1);
});


test('relay 原生 https signal 確實傳入且 close 取消進行中請求', async (t) => {
  let nativeSignal, ended = false, aborted = false;
  const stub = t.mock.method(https, 'request', (_url, options) => {
    const req = new EventEmitter();
    nativeSignal = options.signal;
    nativeSignal?.addEventListener('abort', () => { aborted = true; req.emit('error', new Error('synthetic abort')); }, { once: true });
    req.end = () => { ended = true; };
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
  const r = await startGeminiRelay(config()); t.after(() => r.close());
  const pending = send(r).catch(() => null);
  while (!ended) await new Promise(ok => setImmediate(ok));
  assert.ok(nativeSignal instanceof AbortSignal);
  assert.equal(nativeSignal.aborted, false);
  await r.close(); await pending;
  assert.equal(nativeSignal.aborted, true); assert.equal(aborted, true);
  assert.equal(r.snapshot().failed, true);
});
