// 合成材料與 localhost 假服務；不讀登入檔、不呼叫模型、不建立 Git 倉庫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMaterialRequest, validateManifest, validateResult, validateEndpoint, parseClientArgs, runGeminiClient, MAX_MATERIAL_BYTES, MAX_RESPONSE_BYTES } from '../scripts/gemini-client.js';
import { startGeminiRelay } from '../scripts/gemini-relay.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const text = '靜態材料含 enabledCreditTypes 字樣，不是協定欄位。';
const nonce = 'synthetic-nonce-1234567890';
const manifest = () => ({ schema: 'gemini-scan-material/v1', scanId: 'scan-test', base: 'a'.repeat(40), head: 'b'.repeat(40), model: 'gemini-test-pro', thinking: 'HIGH', materialSha256: sha(text), materialBytes: Buffer.byteLength(text) });
const result = () => ({ scanId: 'scan-test', materialSha256: sha(text), model: 'gemini-test-pro', thinking: 'HIGH', reply: '合成結果。', replySha256: sha('合成結果。'), finishReason: 'STOP', usage: { totalTokenCount: 12 } });

function files(t, m = manifest(), material = text) {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-client-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifestFile = join(dir, 'manifest.json'), materialsFile = join(dir, 'material.txt'), outFile = join(dir, 'result.json');
  writeFileSync(manifestFile, JSON.stringify(m)); writeFileSync(materialsFile, material);
  return { manifestFile, materialsFile, outFile, nonce };
}

async function service(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    respond(req, res);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/generate`, requests };
}

test('client 正面：材料雜湊及位元組數綁實際 text', () => {
  assert.deepEqual(buildMaterialRequest(manifest(), text), { scanId: 'scan-test', model: 'gemini-test-pro', thinking: 'HIGH', materialSha256: sha(text), text });
});

test('manifest 的必填、未知與危險欄位在建請求前拒絕', () => {
  for (const key of Object.keys(manifest())) {
    const m = manifest(); delete m[key]; assert.throws(() => validateManifest(m), /MANIFEST/);
  }
  for (const key of ['enabledCreditTypes', 'enabled_credit_types', 'billing', 'tools', 'unexpected']) {
    assert.throws(() => validateManifest({ ...manifest(), [key]: null }), /MANIFEST/);
  }
  for (const patch of [{ schema: 'other' }, { scanId: '' }, { base: 'main' }, { head: 'HEAD' }, { model: 'auto' }, { thinking: 'LOW' }, { materialSha256: 'no' }, { materialBytes: 0 }, { materialBytes: MAX_MATERIAL_BYTES + 1 }]) {
    assert.throws(() => validateManifest({ ...manifest(), ...patch }), /MANIFEST/);
  }
});

test('材料被改、宣告大小不合與空材料拒絕', () => {
  assert.throws(() => buildMaterialRequest(manifest(), text + '!'), /MATERIAL/);
  assert.throws(() => buildMaterialRequest({ ...manifest(), materialSha256: '0'.repeat(64) }, text), /MATERIAL/);
  assert.throws(() => buildMaterialRequest({ ...manifest(), materialBytes: text.length }, text), /MATERIAL/);
  assert.throws(() => buildMaterialRequest(manifest(), ''), /MATERIAL/);
  const replacement = '\uFFFD';
  assert.throws(() => buildMaterialRequest({ ...manifest(), materialSha256: sha(replacement), materialBytes: Buffer.byteLength(replacement) }, '\uD800'), /MATERIAL/);
});

test('結果完整性：綁 scan、material、model、HIGH、reply hash、STOP 及 usage', () => {
  assert.deepEqual(validateResult(result(), manifest()), result());
  for (const patch of [{ scanId: 'another' }, { materialSha256: '0'.repeat(64) }, { model: 'gemini-other' }, { thinking: 'LOW' }, { reply: '' }, { reply: 'changed' }, { replySha256: '0'.repeat(64) }, { finishReason: 'MAX_TOKENS' }, { tools: [] }, { usage: { totalTokenCount: -1 } }, { usage: { hidden: 1 } }]) {
    assert.throws(() => validateResult({ ...result(), ...patch }, manifest()), /RESULT/);
  }
});

test('CLI 參數不接受重複、缺值、未知或改寫語法', () => {
  const args = ['--manifest', 'm', '--materials', 't', '--out', 'o', '--endpoint', 'http://127.0.0.1:1234/generate', '--nonce', nonce];
  assert.equal(parseClientArgs(args).manifestFile, 'm');
  for (const bad of [args.slice(0, -1), [...args, '--nonce', nonce], [...args, '--credits', 'true'], ['--manifest=m', ...args.slice(2)], args.filter((x) => x !== '--out' && x !== 'o')]) assert.throws(() => parseClientArgs(bad), /ARGS/);
});

test('client 實際 HTTP 正面：只送固定封閉欄位，保存相同結果', async (t) => {
  const s = await service(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result())); });
  const f = files(t);
  assert.deepEqual(await runGeminiClient({ ...f, endpoint: s.endpoint }), result());
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].headers.authorization, `Bearer ${nonce}`);
  assert.deepEqual(JSON.parse(s.requests[0].body), buildMaterialRequest(manifest(), text));
  assert.deepEqual(JSON.parse(readFileSync(f.outFile, 'utf8')), result());
});

test('client endpoint 只收精確 localhost generate，不跟 redirect', async (t) => {
  const f = files(t);
  for (const endpoint of ['https://127.0.0.1:1234/generate', 'http://localhost:1234/generate', 'http://127.0.0.1:1234/generate?x=1', 'http://u:p@127.0.0.1:1234/generate', 'http://127.0.0.1:1234/other', 'http://127.1:1234/generate', 'http://127.0.0.1:1234/generate#x']) {
    assert.throws(() => validateEndpoint(endpoint), /ENDPOINT/);
    await assert.rejects(runGeminiClient({ ...f, endpoint }), /ENDPOINT/);
  }
  const target = await service(t, (_req, res) => res.end(JSON.stringify(result())));
  const s = await service(t, (_req, res) => { res.writeHead(302, { location: target.endpoint }); res.end(JSON.stringify(result())); });
  await assert.rejects(runGeminiClient({ ...f, endpoint: s.endpoint }), /HTTP_STATUS/);
  assert.equal(target.requests.length, 0); assert.equal(s.requests.length, 1); assert.equal(existsSync(f.outFile), false);
});

test('client 回覆 body 上限獨立於 JSON 與 reply 上限', async (t) => {
  const f = files(t), s = await service(t, (_req, res) => res.end(JSON.stringify(result()) + ' '.repeat(MAX_RESPONSE_BYTES)));
  await assert.rejects(runGeminiClient({ ...f, endpoint: s.endpoint }), /RESPONSE_SIZE/);
  assert.equal(s.requests.length, 1); assert.equal(existsSync(f.outFile), false);
});

test('client 到真 localhost relay 的完整合成流程與關閉後收據', async (t) => {
  let calls = 0;
  const m = manifest(), f = files(t);
  const r = await startGeminiRelay({ nonce, scanId: m.scanId, materialSha256: m.materialSha256, materialBytes: m.materialBytes, model: m.model, thinking: m.thinking, project: 'fake-project', getAccessToken: async () => 'FAKE-TOKEN' }, { transport: async () => {
    calls += 1;
    return { statusCode: 200, body: Buffer.from(JSON.stringify({ response: { modelVersion: m.model, candidates: [{ content: { role: 'model', parts: [{ text: '完整假流程' }] }, finishReason: 'STOP' }] } })) };
  } });
  t.after(() => r.close());
  const value = await runGeminiClient({ ...f, endpoint: r.url });
  assert.equal(calls, 1); assert.equal(value.reply, '完整假流程');
  assert.deepEqual(value, r.snapshot().response);
  await r.close(); assert.equal(r.snapshot().failed, false);
});

test('client 非成功、無效／截斷回覆不重試、不寫成功檔', async (t) => {
  for (const [status, body] of [[401, 'secret diagnostic'], [403, '{}'], [429, '{}'], [200, ''], [200, '{'], [200, JSON.stringify({ ...result(), model: 'gemini-fallback' })]]) {
    await t.test(`${status}-${body.length}`, async (t2) => {
      const f = files(t2), s = await service(t2, (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); });
      await assert.rejects(runGeminiClient({ ...f, endpoint: s.endpoint }), (e) => !e.message.includes('secret diagnostic'));
      assert.equal(s.requests.length, 1); assert.equal(existsSync(f.outFile), false);
    });
  }
});

test('client timeout 與斷線不算成功', async (t) => {
  const f = files(t), s = await service(t, (_req, res) => { setTimeout(() => res.end(JSON.stringify(result())), 100); });
  await assert.rejects(runGeminiClient({ ...f, endpoint: s.endpoint }, { timeoutMs: 25 }), /TIMEOUT/);
  assert.equal(existsSync(f.outFile), false); assert.equal(s.requests.length, 1);
  const broken = await service(t, (_req, res) => { res.writeHead(200, { 'content-length': 9999 }); res.write('{'); res.destroy(); });
  await assert.rejects(runGeminiClient({ ...f, endpoint: broken.endpoint }));
});

test('client no-follow 材料、壞 UTF-8 與既有輸出檔保護', async (t) => {
  const f = files(t), s = await service(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result())); });
  const link = join(f.materialsFile + '-link'); symlinkSync(f.materialsFile, link);
  await assert.rejects(runGeminiClient({ ...f, materialsFile: link, endpoint: s.endpoint }), /INPUT/);
  writeFileSync(f.materialsFile, Buffer.from([0xc3, 0x28]));
  await assert.rejects(runGeminiClient({ ...f, endpoint: s.endpoint }), /INPUT/);
  assert.equal(s.requests.length, 0);
  writeFileSync(f.materialsFile, text); writeFileSync(f.outFile, 'keep-existing');
  await assert.rejects(runGeminiClient({ ...f, endpoint: s.endpoint }), /OUTPUT/);
  assert.equal(readFileSync(f.outFile, 'utf8'), 'keep-existing');
});

test('client CLI 真入口與壞參數的安全錯誤', async (t) => {
  const f = files(t), s = await service(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result())); });
  const script = fileURLToPath(new URL('../scripts/gemini-client.js', import.meta.url));
  const run = (args) => new Promise((ok) => {
    const p = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, HOME: tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; p.stdout.on('data', (x) => { stdout += x; }); p.stderr.on('data', (x) => { stderr += x; }); p.on('close', (status) => ok({ status, stdout, stderr }));
  });
  const good = await run(['--manifest', f.manifestFile, '--materials', f.materialsFile, '--out', f.outFile, '--endpoint', s.endpoint, '--nonce', nonce]);
  assert.equal(good.status, 0); assert.equal(good.stderr, '');
  const bad = await run(['--unknown', 'SYNTHETIC-PRIVATE-VALUE']);
  assert.equal(bad.status, 2); assert.match(bad.stderr, /ARGS/); assert.doesNotMatch(bad.stderr, /SYNTHETIC-PRIVATE-VALUE/);
});
