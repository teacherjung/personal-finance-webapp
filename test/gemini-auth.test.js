// @ts-check
// 每題建立自己的合成 OAuth 檔；傳輸只用假函式，不讀使用者設定或認證。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as geminiAuth from '../scripts/gemini-auth.js';
const { loadGeminiAuth } = geminiAuth;

const roots = [];
const sourceHashes = new Map();
const originalCreateHash = crypto.createHash;
// 合成 bytes 對應固定測試 digest；未登記 bytes 仍用真正 hash，考到來源 hash 比對分支。
crypto.createHash = (...args) => {
  const hash = originalCreateHash(...args); const chunks = [];
  const update = hash.update.bind(hash); const digest = hash.digest.bind(hash);
  hash.update = (value, encoding) => { chunks.push(Buffer.from(value, encoding)); update(value, encoding); return hash; };
  hash.digest = encoding => {
    const actual = digest(encoding); const fake = sourceHashes.get(Buffer.concat(chunks).toString('hex'));
    return fake ? encoding === 'hex' ? fake : Buffer.from(fake, 'hex') : actual;
  };
  return hash;
};
syncBuiltinESMExports();
after(() => { roots.forEach(p => rmSync(p, { recursive: true, force: true })); crypto.createHash = originalCreateHash; syncBuiltinESMExports(); });
const sourceBundle = 'bundle/chunk-NR7L3FXV.js';
const sourceBundleHash = 'd566e81b1df8d4d44a91bf7aeea96a58ec0e6c8934fa424315ef060507dcbb8c';
const sourceMetadataHash = 'a2d8e6d35c11a6934a12bfe2ed76ae6913c7c4dfd590c60aa420e8cb7e387508';
const syntheticClientId = 'synthetic-public-client.apps.googleusercontent.com';
const syntheticClientSecret = 'synthetic-public-client-secret';
const sourceCode = `var userAccountManager2 = new UserAccountManager();\nvar OAUTH_CLIENT_ID = "${syntheticClientId}";\nvar OAUTH_CLIENT_SECRET = "${syntheticClientSecret}";\nvar OAUTH_SCOPE = ["synthetic-scope"];\nthrow Error("synthetic-source-must-not-execute");\n`;
function putSource(file, content, hash) {
  const bytes = Buffer.from(content); writeFileSync(file, bytes); sourceHashes.set(bytes.toString('hex'), hash);
}
const now = 1_800_000_000_000;
const access = 'synthetic-existing-access-value';
const refresh = 'synthetic-existing-refresh-value';
const project = 'synthetic-existing-project';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const loadUrl = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const quotaUrl = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
function fixture(overrides = {}) {
  const dir = fs.realpathSync(mkdtempSync(join(tmpdir(), 'gemini-auth-test-'))); roots.push(dir);
  const clientSourceRoot = join(dir, 'official-cli'); mkdirSync(join(clientSourceRoot, 'bundle'), { recursive: true });
  putSource(join(clientSourceRoot, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', version: '0.64.0' }), sourceMetadataHash);
  putSource(join(clientSourceRoot, sourceBundle), sourceCode, sourceBundleHash);
  const path = join(dir, 'oauth_creds.json');
  writeFileSync(path, JSON.stringify({ access_token: access, refresh_token: refresh, expiry_date: now + 3600_000, token_type: 'Bearer', ...overrides }), { mode: 0o600 });
  const calls = [];
  const request = async (url, headers, body) => {
    calls.push({ url, headers, body });
    if (url === loadUrl) return { status: 200, body: Buffer.from(JSON.stringify({ currentTier: { id: 'existing-tier' }, cloudaicompanionProject: project })) };
    if (url === quotaUrl) return { status: 200, body: Buffer.from(JSON.stringify({ buckets: [{ modelId: 'gemini-test-pro', remainingFraction: 1 }] })) };
    if (url === tokenUrl) return { status: 200, body: Buffer.from(JSON.stringify({ access_token: 'synthetic-refreshed-access-value', token_type: 'Bearer', expires_in: 3600, refresh_token: 'synthetic-rotated-refresh-value' })) };
    throw new Error('unexpected synthetic endpoint');
  };
  return { path, clientSourceRoot, calls, request, deps: { clientSourceRoot, credentialsPath: path, now: () => now, request } };
}

test('Gemini auth｜既有有效 token 只讀資格與額度，不 refresh、不寫檔或序列化秘密', async () => {
  const f = fixture(); const before = readFileSync(f.path);
  const ctx = await loadGeminiAuth(f.deps);
  assert.equal(await ctx.getAccessToken(), access);
  assert.equal(ctx.project, project);
  assert.deepEqual(f.calls.map(x => x.url), [loadUrl, quotaUrl]);
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${access}`);
  assert.deepEqual(JSON.parse(f.calls[0].body), { metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }, mode: 'HEALTH_CHECK' });
  assert.deepEqual(JSON.parse(f.calls[1].body), { project });
  assert.deepEqual(ctx.quota(), [{ modelId: 'gemini-test-pro', remainingFraction: 1 }]);
  assert.throws(() => JSON.stringify(ctx), /GEMINI_AUTH_OPAQUE/);
  assert.equal(Object.values(ctx).some(v => v === project || v === access), false);
  assert.ok([access, refresh, project].every(v => ctx.dlpNeedles().includes(v)));
  assert.deepEqual(readFileSync(f.path), before);
});

test('Gemini auth｜過期 grant 僅 refresh 同通道，前後秘密均成為比對針且不落地', async () => {
  const f = fixture({ expiry_date: now - 1 }); const before = readFileSync(f.path);
  const ctx = await loadGeminiAuth(f.deps);
  assert.deepEqual(f.calls.map(x => x.url), [tokenUrl, loadUrl, quotaUrl]);
  const form = new URLSearchParams(f.calls[0].body);
  assert.deepEqual([...form.keys()].sort(), ['client_id', 'client_secret', 'grant_type', 'refresh_token']);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), refresh);
  assert.equal(form.get('client_id') === syntheticClientId, true, '核對 scripts/gemini-auth.js 只從固定來源取 client，再跑本檔');
  assert.equal(form.get('client_secret') === syntheticClientSecret, true, '核對 scripts/gemini-auth.js 固定角色配對，再跑本檔');
  assert.equal(await ctx.getAccessToken(), 'synthetic-refreshed-access-value');
  assert.ok([access, refresh, 'synthetic-refreshed-access-value', 'synthetic-rotated-refresh-value', project].every(v => ctx.dlpNeedles().includes(v)));
  assert.deepEqual(readFileSync(f.path), before);
});

for (const kind of ['missing', 'symlink', 'hardlink', 'directory', 'public-mode', 'oversize', 'bad-json', 'other-auth', 'wrong-token-type', 'missing-refresh']) {
  test(`Gemini auth｜${kind} 在外呼前失敗，不採替代認證`, async () => {
    const f = fixture();
    if (kind === 'missing') rmSync(f.path);
    if (kind === 'symlink') { const target = join(f.path, '..', 'target'); writeFileSync(target, readFileSync(f.path), { mode: 0o600 }); rmSync(f.path); symlinkSync(target, f.path); }
    if (kind === 'hardlink') linkSync(f.path, join(f.path, '..', 'alias'));
    if (kind === 'directory') { rmSync(f.path); mkdirSync(f.path); }
    if (kind === 'public-mode') chmodSync(f.path, 0o644);
    if (kind === 'oversize') writeFileSync(f.path, 'x'.repeat(65537));
    if (kind === 'bad-json') writeFileSync(f.path, '{ synthetic-private-parse-fragment');
    if (kind === 'other-auth') writeFileSync(f.path, JSON.stringify({ type: 'service_account', access_token: access, refresh_token: refresh, expiry_date: now + 3600_000, token_type: 'Bearer' }));
    if (kind === 'wrong-token-type') writeFileSync(f.path, JSON.stringify({ access_token: access, refresh_token: refresh, expiry_date: now + 3600_000, token_type: 'Basic' }));
    if (kind === 'missing-refresh') writeFileSync(f.path, JSON.stringify({ access_token: access, expiry_date: now - 1, token_type: 'Bearer' }));
    await assert.rejects(loadGeminiAuth(f.deps), e => /^GEMINI_AUTH_[A-Z_]+$/.test(e.message) && !e.message.includes('synthetic-private'));
    assert.equal(f.calls.length, 0);
  });
}

for (const response of [{}, { currentTier: {}, cloudaicompanionProject: project }, { currentTier: { id: 'old', hasOnboardedPreviously: false }, cloudaicompanionProject: project }, { currentTier: { id: 'old' } }, { allowedTiers: [{ id: 'free', isDefault: true }] }]) {
  test('Gemini auth｜缺既有資格或專案即停，不 onboarding 或挑替代方案', async () => {
    const f = fixture(); const calls = [];
    await assert.rejects(loadGeminiAuth({ ...f.deps, request: async (url) => { calls.push(url); return { status: 200, body: Buffer.from(JSON.stringify(response)) }; } }), /GEMINI_AUTH_EXISTING_ACCOUNT_REQUIRED/);
    assert.deepEqual(calls, [loadUrl]);
  });
}

for (const kind of ['redirect', 'http-error', 'bad-json', 'oversize', 'throw', 'wrong-token-type', 'no-expiry']) {
  test(`Gemini auth｜refresh ${kind} 只回安全錯誤且不進資格查詢`, async () => {
    const f = fixture({ expiry_date: now - 1 }); const calls = [];
    const request = async url => {
      calls.push(url);
      if (kind === 'throw') throw Error('synthetic-private-transport-message');
      const body = kind === 'bad-json' ? '{synthetic-private-parse-fragment' : kind === 'oversize' ? 'x'.repeat(524289) : JSON.stringify({ access_token: 'synthetic-private-refreshed', token_type: kind === 'wrong-token-type' ? 'Basic' : 'Bearer', expires_in: kind === 'no-expiry' ? undefined : 3600 });
      return { status: kind === 'redirect' ? 302 : kind === 'http-error' ? 401 : 200, body: Buffer.from(body) };
    };
    const code = { redirect: 'TOKEN_HTTP_OTHER', 'http-error': 'TOKEN_HTTP_401', 'bad-json': 'TOKEN_JSON', oversize: 'TOKEN_SHAPE', throw: 'TOKEN_TRANSPORT', 'wrong-token-type': 'REFRESH', 'no-expiry': 'REFRESH' }[kind];
    await assert.rejects(loadGeminiAuth({ ...f.deps, request }), new RegExp(`^Error: GEMINI_AUTH_${code}$`));
    assert.deepEqual(calls, [tokenUrl]);
  });
}

test('Gemini auth｜getter 到期後只更新同一 grant，額度投影不帶額外身分', async () => {
  const f = fixture(); let time = now;
  const ctx = await loadGeminiAuth({ ...f.deps, now: () => time });
  const quota = ctx.quota(); quota[0].modelId = 'mutated';
  assert.equal(ctx.quota()[0].modelId, 'gemini-test-pro');
  time += 3600_000;
  assert.equal(await ctx.getAccessToken(), 'synthetic-refreshed-access-value');
  assert.deepEqual(f.calls.map(x => x.url), [loadUrl, quotaUrl, tokenUrl]);
});

test('Gemini auth｜並行 getter 共用同一次 grant refresh', async () => {
  const f = fixture(); let time = now;
  const ctx = await loadGeminiAuth({ ...f.deps, now: () => time });
  time += 3600_000;
  const result = await Promise.all([ctx.getAccessToken(), ctx.getAccessToken()]);
  assert.deepEqual(result, ['synthetic-refreshed-access-value', 'synthetic-refreshed-access-value']);
  assert.equal(f.calls.filter(x => x.url === tokenUrl).length, 1);
});

// 改的是 Node 原生出口，loadGeminiAuth 沒有注入 request，才能考到正式傳輸接線。
async function nativeProbe(f, reply, task) {
  const original = https.request; const calls = [];
  https.request = (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => { req.emit('close'); return req; };
    req.end = body => {
      calls.push({ url, options, body });
      const response = reply(calls.length - 1);
      queueMicrotask(() => {
        if (response.hang) return;
        if (response.requestError) { req.emit('error', response.requestError); return; }
        const res = new PassThrough(); res.statusCode = response.status; res.complete = response.complete !== false;
        res.headers = { location: 'https://example.invalid/synthetic-private-header' }; res.statusMessage = 'synthetic-private-status-text';
        callback(res);
        if (response.event) { res.emit(response.event, Error('synthetic-private-response-event')); return; }
        res.end(response.body);
      });
      return req;
    };
    return req;
  };
  syncBuiltinESMExports();
  try { await task(() => loadGeminiAuth({ clientSourceRoot: f.clientSourceRoot, credentialsPath: f.path, now: () => now }), calls); }
  finally { https.request = original; syncBuiltinESMExports(); }
}

test('Gemini auth｜正式 HTTPS 出口固定 URL、POST 與表單，不繼承 proxy 或外送帳號欄', async () => {
  const f = fixture({ expiry_date: now - 1 });
  const responses = [
    { access_token: 'synthetic-native-refreshed-access', token_type: 'Bearer', expires_in: 3600 },
    { currentTier: { id: 'existing-tier' }, cloudaicompanionProject: project },
    { buckets: [{ modelId: 'gemini-test-pro', remainingFraction: 1 }] },
  ];
  await nativeProbe(f, i => ({ status: 200, body: JSON.stringify(responses[i]) }), async (load, calls) => {
    const ctx = await load();
    assert.equal(await ctx.getAccessToken(), 'synthetic-native-refreshed-access');
    assert.deepEqual(calls.map(x => x.url), [tokenUrl, loadUrl, quotaUrl], '核對 scripts/gemini-auth.js 正式 HTTPS 固定目的地，再跑本檔');
    for (const call of calls) {
      assert.equal(call.options.method, 'POST');
      assert.equal(call.options.agent, false);
      assert.equal(call.options.headers['Content-Length'], String(Buffer.byteLength(call.body)));
    }
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('refresh_token'), refresh);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(calls[0].options.headers.Authorization, undefined);
    assert.equal(calls[1].options.headers.Authorization, 'Bearer synthetic-native-refreshed-access');
    assert.deepEqual(JSON.parse(calls[2].body), { project });
    assert.equal(JSON.stringify(calls).includes('enabled_credit_types'), false);
  });
});

for (const status of [301, 302, 307, 401, 429, 500]) {
  test(`Gemini auth｜正式 HTTPS ${status} 不跟轉址、不重試、不續其他 API`, async () => {
    const f = fixture();
    // body 故意合法，否則 JSON 解析錯誤會遮住「把 HTTP 錯誤當 200」的突變。
    await nativeProbe(f, i => ({ status, body: JSON.stringify(i === 0
      ? { currentTier: { id: 'existing-tier' }, cloudaicompanionProject: project }
      : { buckets: [{ modelId: 'gemini-test-pro', remainingFraction: 1 }] }) }), async (load, calls) => {
      await assert.rejects(load(), new RegExp(`^Error: GEMINI_AUTH_LOAD_${status === 401 ? 'HTTP_401' : status === 429 ? 'HTTP_429' : 'HTTP_OTHER'}$`));
      assert.deepEqual(calls.map(x => x.url), [loadUrl]);
    });
  });
}

test('Gemini auth｜DLP 收未知 cache 私值，排除公開協定常數與模型名稱', async () => {
  const f = fixture({ unknown_cache: { identity: 'synthetic-unknown-private-value' }, scope: 'public-scope-name' });
  const ctx = await loadGeminiAuth(f.deps);
  assert.ok(ctx.dlpNeedles().includes('synthetic-unknown-private-value'));
  for (const publicValue of ['Bearer', 'public-scope-name', 'gemini-test-pro', 'existing-tier', 'access_token']) assert.equal(ctx.dlpNeedles().includes(publicValue), false);
});

for (const kind of ['same-inode-symlink', 'changed-inode']) {
  test(`Gemini auth｜lstat 後變成 ${kind}，不沿用先前的來源判定`, async () => {
    const f = fixture(); const original = fs.lstatSync; let switched = false;
    fs.lstatSync = (path, ...args) => {
      const stat = original(path, ...args);
      if (path === f.path && !switched) {
        switched = true; renameSync(f.path, f.path + '.before');
        if (kind === 'same-inode-symlink') symlinkSync(f.path + '.before', f.path);
        else writeFileSync(f.path, readFileSync(f.path + '.before'), { mode: 0o600 });
      }
      return stat;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(loadGeminiAuth(f.deps), /^Error: GEMINI_AUTH_SOURCE$/);
      assert.equal(switched, true);
      assert.equal(f.calls.length, 0);
    } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
  });
}

test('Gemini auth｜開檔後讀到的長度改變，合法 JSON 也不能通過', async () => {
  const f = fixture(); const original = fs.readFileSync; let changed = false;
  fs.readFileSync = (path, ...args) => {
    const bytes = original(path, ...args);
    if (typeof path !== 'number') return bytes;
    changed = true; return Buffer.concat([bytes, Buffer.from(' ')]);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(loadGeminiAuth(f.deps), /^Error: GEMINI_AUTH_SOURCE$/);
    assert.equal(changed, true);
    assert.equal(f.calls.length, 0);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

for (const expires of [0, 60, 86401]) {
  test(`Gemini auth｜refresh 有效期 ${expires} 不合理，不能續資格查詢`, async () => {
    const f = fixture({ expiry_date: now - 1 }); const calls = [];
    await assert.rejects(loadGeminiAuth({ ...f.deps, request: async url => {
      calls.push(url);
      return { status: 200, body: Buffer.from(JSON.stringify({ access_token: 'synthetic-new-access', token_type: 'Bearer', expires_in: expires })) };
    } }), /^Error: GEMINI_AUTH_REFRESH$/);
    assert.deepEqual(calls, [tokenUrl]);
  });
}

const stages = ['TOKEN', 'LOAD', 'QUOTA'];
const stageUrls = [tokenUrl, loadUrl, quotaUrl];
const successReplies = [
  { access_token: 'synthetic-native-refreshed-access', token_type: 'Bearer', expires_in: 3600 },
  { currentTier: { id: 'existing-tier' }, cloudaicompanionProject: project },
  { buckets: [{ modelId: 'gemini-test-pro', remainingFraction: 1 }] },
];
const diagnosticCases = [
  { name: 'request error', reason: 'TRANSPORT', requestError: Error('synthetic-private-request-error') },
  { name: '401', reason: 'HTTP_401', status: 401 },
  { name: '403', reason: 'HTTP_403', status: 403 },
  { name: '429', reason: 'HTTP_429', status: 429 },
  { name: 'unknown status', reason: 'HTTP_OTHER', status: 59999 },
  { name: 'bad JSON', reason: 'JSON', body: '{synthetic-private-json' },
  { name: 'non-object JSON', reason: 'SHAPE', body: '["synthetic-private-json"]' },
  { name: 'invalid UTF-8', reason: 'JSON', body: Buffer.from([0xff]) },
  { name: 'oversize', reason: 'SHAPE', body: 'x'.repeat(524289) },
  { name: 'response error', reason: 'TRANSPORT', event: 'error' },
  { name: 'aborted', reason: 'TRANSPORT', event: 'aborted' },
  { name: 'incomplete', reason: 'TRANSPORT', complete: false },
];
for (const [stageIndex, stage] of stages.entries()) {
  for (const bad of diagnosticCases) {
    test(`Gemini auth｜固定診斷 ${stage} ${bad.name} 不洩漏回覆且停止後段`, async () => {
      const f = fixture({ expiry_date: now - 1 });
      await nativeProbe(f, i => ({ status: 200, body: JSON.stringify(successReplies[i]), ...(i === stageIndex ? bad : {}) }), async (load, calls) => {
        await assert.rejects(load(), error => {
          assert.equal(error.message, `GEMINI_AUTH_${stage}_${bad.reason}`, '核對 scripts/gemini-auth.js 固定階段與原因，再跑本檔');
          assert.deepEqual(Object.keys(error), [], '核對 scripts/gemini-auth.js 錯誤投影不附外來欄位，再跑本檔');
          return true;
        });
        assert.deepEqual(calls.map(call => call.url), stageUrls.slice(0, stageIndex + 1), '核對 scripts/gemini-auth.js 失敗後未重試或續呼叫，再跑本檔');
      });
    });
  }
  for (const kind of ['null-reply', 'non-buffer', 'oversize-buffer', 'spoofed-error', 'revoked-error']) {
    test(`Gemini auth｜固定診斷 ${stage} ${kind} 不信任外來例外代碼`, async () => {
      const f = fixture({ expiry_date: now - 1 }); const calls = []; let messageRead = false;
      await assert.rejects(loadGeminiAuth({ ...f.deps, request: async (url, headers, body) => {
        calls.push(url);
        if (url !== stageUrls[stageIndex]) return f.request(url, headers, body);
        if (kind === 'null-reply') return null;
        if (kind === 'non-buffer') return { status: 200, body: 'synthetic-private-non-buffer' };
        if (kind === 'oversize-buffer') return { status: 200, body: Buffer.from(JSON.stringify({ synthetic_private: 'x'.repeat(524289) })) };
        if (kind === 'revoked-error') { const proxy = Proxy.revocable({}, {}); proxy.revoke(); throw proxy.proxy; }
        const foreign = { reason: 'SHAPE', code: 'JSON' };
        Object.defineProperty(foreign, 'message', { get() { messageRead = true; throw Error('synthetic-private-message-getter'); } });
        throw foreign;
      } }), error => {
        assert.equal(error.message, `GEMINI_AUTH_${stage}_${['spoofed-error', 'revoked-error'].includes(kind) ? 'TRANSPORT' : 'SHAPE'}`, '核對 scripts/gemini-auth.js 內部原因型別，再跑本檔');
        assert.deepEqual(Object.keys(error), []);
        return true;
      });
      assert.equal(messageRead, false);
      assert.deepEqual(calls, stageUrls.slice(0, stageIndex + 1));
    });
  }
}

for (const [stageIndex, stage] of stages.entries()) {
  test(`Gemini auth｜固定診斷 ${stage} timeout 保留原時限且不繼續`, async t => {
    const f = fixture({ expiry_date: now - 1 });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await nativeProbe(f, i => ({ status: 200, body: JSON.stringify(successReplies[i]), hang: i === stageIndex }), async (load, calls) => {
        let settled = false;
        const rejected = assert.rejects(load(), new RegExp(`^Error: GEMINI_AUTH_${stage}_TRANSPORT$`)).finally(() => { settled = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls.map(call => call.url), stageUrls.slice(0, stageIndex + 1));
        t.mock.timers.tick(29_999);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls.map(call => call.url), stageUrls.slice(0, stageIndex + 1));
        assert.equal(settled, false, '核對 scripts/gemini-auth.js 超時界線，再跑本檔');
        t.mock.timers.tick(1);
        await rejected;
        assert.equal(settled, true);
        assert.deepEqual(calls.map(call => call.url), stageUrls.slice(0, stageIndex + 1));
      });
    } finally { t.mock.timers.reset(); }
  });
}

const quotaReasonKeys = ['SERVICE_DISABLED', 'USER_PROJECT_DENIED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'SECURITY_POLICY_VIOLATED', 'USER_BLOCKED_BY_ADMIN', 'RESOURCE_PROJECT_INVALID'];
const quotaFlagKeys = ['UNKNOWN', 'MALFORMED', 'INCOMPLETE', 'PARSE_FAILED', 'NO_ERROR_INFO'];
const quotaDiagnosticKeys = [...quotaReasonKeys, ...quotaFlagKeys];
const quotaExpected = (active = []) => Object.fromEntries(quotaDiagnosticKeys.map(key => [key, active.includes(key)]));
const errorInfo = (reason, overrides = {}) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: 'googleapis.com', reason, ...overrides });
const quotaRaw = details => Buffer.from(JSON.stringify({ error: { details } }));
function takeQuotaDiagnostic(error) {
  assert.equal(typeof geminiAuth.takeGeminiQuotaDiagnostic, 'function', '核對 scripts/gemini-auth.js 的一次性固定投影介面，再跑本檔');
  const projection = geminiAuth.takeGeminiQuotaDiagnostic(error);
  assert.equal(geminiAuth.takeGeminiQuotaDiagnostic(error), undefined, '核對 scripts/gemini-auth.js 同一例外只取一次，再跑本檔');
  if (projection) {
    assert.deepEqual(Object.keys(projection), quotaDiagnosticKeys, '核對 scripts/gemini-auth.js 固定欄位及順序，再跑本檔');
    assert.ok(Object.values(projection).every(value => typeof value === 'boolean'));
    assert.equal(Object.isFrozen(projection), true);
  }
  return projection;
}
async function quotaFailure(raw, { stage = 'QUOTA', status = 403, code = `${stage}_HTTP_${status}` } = {}) {
  const f = fixture({ expiry_date: now - 1 }); const calls = []; let caught;
  await assert.rejects(loadGeminiAuth({ ...f.deps, request: async (url, headers, body) => {
    calls.push(url);
    if (url !== stageUrls[stages.indexOf(stage)]) return f.request(url, headers, body);
    const reply = { status, body: raw };
    for (const key of ['headers', 'statusText']) Object.defineProperty(reply, key, { get() { throw Error(`synthetic-private-${key}`); } });
    return reply;
  } }), error => {
    assert.equal(error.message, `GEMINI_AUTH_${code}`, '核對 scripts/gemini-auth.js 原拒絕碼不變，再跑本檔');
    assert.deepEqual(Object.keys(error), []);
    assert.equal(JSON.stringify(error), '{}');
    caught = error;
    return true;
  });
  assert.deepEqual(calls, stageUrls.slice(0, stages.indexOf(stage) + 1), '核對 scripts/gemini-auth.js 拒絕後不重試或續外呼，再跑本檔');
  return takeQuotaDiagnostic(caught);
}

for (const reason of quotaReasonKeys) {
  test(`Gemini auth｜QUOTA 403 ErrorInfo 精確分類 ${reason} 且仍失敗`, async () => {
    assert.deepEqual(await quotaFailure(quotaRaw([errorInfo(reason)])), quotaExpected([reason]));
  });
}

test('Gemini auth｜ErrorInfo 多原因、重複及次序只留下固定集合', async () => {
  const forward = quotaReasonKeys.map(reason => errorInfo(reason));
  const expected = quotaExpected(quotaReasonKeys);
  assert.deepEqual(await quotaFailure(quotaRaw(forward)), expected);
  assert.deepEqual(await quotaFailure(quotaRaw([...forward].reverse().concat(forward[0], forward[0]))), expected);
});

const quotaShapeCases = [
  ['missing details', { error: {} }, ['NO_ERROR_INFO']],
  ['empty details', { error: { details: [] } }, ['NO_ERROR_INFO']],
  ['root scalar', 7, ['MALFORMED', 'NO_ERROR_INFO']],
  ['root array', [], ['MALFORMED', 'NO_ERROR_INFO']],
  ['missing error', {}, ['MALFORMED', 'NO_ERROR_INFO']],
  ['bad error', { error: 'synthetic-private-error' }, ['MALFORMED', 'NO_ERROR_INFO']],
  ['bad details', { error: { details: {} } }, ['MALFORMED', 'NO_ERROR_INFO']],
  ['bad detail', { error: { details: [null] } }, ['MALFORMED', 'NO_ERROR_INFO']],
  ['missing type', { error: { details: [{ domain: 'googleapis.com', reason: 'SERVICE_DISABLED' }] } }, ['MALFORMED', 'NO_ERROR_INFO']],
  ['non-string type', { error: { details: [errorInfo('SERVICE_DISABLED', { '@type': 7 })] } }, ['MALFORMED', 'NO_ERROR_INFO']],
  ['unknown type', { error: { details: [errorInfo('SERVICE_DISABLED', { '@type': 'synthetic-private-type' })] } }, ['UNKNOWN', 'NO_ERROR_INFO']],
  ['short type', { error: { details: [errorInfo('SERVICE_DISABLED', { '@type': 'google.rpc.ErrorInfo' })] } }, ['UNKNOWN', 'NO_ERROR_INFO']],
  ['unknown domain', { error: { details: [errorInfo('SERVICE_DISABLED', { domain: 'synthetic-private-domain' })] } }, ['UNKNOWN']],
  ['non-string domain', { error: { details: [errorInfo('SERVICE_DISABLED', { domain: null })] } }, ['MALFORMED']],
  ['unknown reason', { error: { details: [errorInfo('synthetic-private-reason')] } }, ['UNKNOWN']],
  ['non-string reason', { error: { details: [errorInfo({ private: 'synthetic-private-reason' })] } }, ['MALFORMED']],
  ['missing domain', { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } }, ['MALFORMED']],
  ['missing reason', { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: 'googleapis.com' }] } }, ['MALFORMED']],
];
for (const [name, body, active] of quotaShapeCases) {
  test(`Gemini auth｜ErrorInfo ${name} 不把壞欄位當原因`, async () => {
    assert.deepEqual(await quotaFailure(Buffer.from(JSON.stringify(body))), quotaExpected(active));
  });
}

test('Gemini auth｜ErrorInfo 合法與壞項並存仍保留警示', async () => {
  assert.deepEqual(await quotaFailure(quotaRaw([errorInfo('SERVICE_DISABLED'), null, errorInfo('UNKNOWN_PRIVATE_VALUE')])), quotaExpected(['SERVICE_DISABLED', 'MALFORMED', 'UNKNOWN']));
});

test('Gemini auth｜ErrorInfo 非固定位置、內嵌字串及機密欄位不參與分類', async () => {
  const nested = errorInfo('USER_PROJECT_DENIED');
  const body = { synthetic_private_key: 'synthetic-private-key-value', message: nested, metadata: { reason: 'SECURITY_POLICY_VIOLATED' }, error: {
    message: 'synthetic-private-message', metadata: nested, reason: 'USER_BLOCKED_BY_ADMIN',
    details: [errorInfo('SERVICE_DISABLED', { metadata: { user: 'synthetic-private-account', project: 'synthetic-private-project', reason: 'RESOURCE_PROJECT_INVALID' }, message: JSON.stringify(nested) })],
  } };
  const projection = await quotaFailure(Buffer.from(JSON.stringify(body)));
  assert.deepEqual(projection, quotaExpected(['SERVICE_DISABLED']));
  assert.equal(JSON.stringify(projection).includes('synthetic-private'), false);
  assert.deepEqual(await quotaFailure(quotaRaw([JSON.stringify(nested)])), quotaExpected(['MALFORMED', 'NO_ERROR_INFO']));
});

for (const reason of ['__proto__', 'constructor', 'toString']) {
  test(`Gemini auth｜ErrorInfo 保留字 ${reason} 不能成為輸出鍵`, async () => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    assert.deepEqual(await quotaFailure(quotaRaw([errorInfo(reason)])), quotaExpected(['UNKNOWN']));
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
  });
}

test('Gemini auth｜ErrorInfo 上限接受邊界，超界不留前段原因', async () => {
  const details = Array.from({ length: 32 }, () => errorInfo('SERVICE_DISABLED'));
  assert.deepEqual(await quotaFailure(quotaRaw(details)), quotaExpected(['SERVICE_DISABLED']));
  details.push(errorInfo('synthetic-private-unknown'));
  assert.deepEqual(await quotaFailure(quotaRaw(details)), quotaExpected(['INCOMPLETE']));
});

for (const [name, raw] of [
  ['bad UTF-8', Buffer.concat([quotaRaw([errorInfo('SERVICE_DISABLED')]), Buffer.from([0xff])])],
  ['bad UTF-8 within ignored field', Buffer.concat([Buffer.from('{"error":{"details":[' + JSON.stringify(errorInfo('SERVICE_DISABLED')) + ']},"message":"'), Buffer.from([0xff]), Buffer.from('"}')])],
  ['bad JSON', Buffer.from(quotaRaw([errorInfo('SERVICE_DISABLED')]).toString() + 'synthetic-private-tail')],
  ['empty', Buffer.alloc(0)],
]) {
  test(`Gemini auth｜ErrorInfo ${name} 原子拒絕，不保存部分原因`, async () => {
    assert.deepEqual(await quotaFailure(raw), quotaExpected(['PARSE_FAILED']));
  });
}

for (const [name, raw] of [
  ['non-buffer', 'synthetic-private-not-buffer'],
  ['over-cap', Buffer.from(JSON.stringify({ error: { details: [errorInfo('SERVICE_DISABLED')] }, private: 'x'.repeat(524289) }))],
]) {
  test(`Gemini auth｜ErrorInfo ${name} 沿既有 SHAPE 拒絕，不產生投影`, async () => {
    assert.equal(await quotaFailure(raw, { code: 'QUOTA_SHAPE' }), undefined);
  });
}

for (const [stage, status, code] of [['TOKEN', 403, 'TOKEN_HTTP_403'], ['LOAD', 403, 'LOAD_HTTP_403'], ['QUOTA', 401, 'QUOTA_HTTP_401'], ['QUOTA', 429, 'QUOTA_HTTP_429'], ['QUOTA', 500, 'QUOTA_HTTP_OTHER']]) {
  test(`Gemini auth｜ErrorInfo 不解析 ${stage} ${status} 的回覆`, async () => {
    const raw = quotaRaw([errorInfo('SERVICE_DISABLED')]); const original = TextDecoder.prototype.decode; let reads = 0;
    TextDecoder.prototype.decode = function (input, ...args) { if (input === raw) reads++; return original.call(this, input, ...args); };
    try { assert.equal(await quotaFailure(raw, { stage, status, code }), undefined); assert.equal(reads, 0); }
    finally { TextDecoder.prototype.decode = original; }
  });
}

test('Gemini auth｜ErrorInfo 使用原傳輸 Buffer 一次，不另讀其他欄位', async () => {
  const raw = quotaRaw([errorInfo('SERVICE_DISABLED')]); const original = TextDecoder.prototype.decode; const parse = JSON.parse; let reads = 0; let parses = 0;
  TextDecoder.prototype.decode = function (input, ...args) { if (input === raw) reads++; return original.call(this, input, ...args); };
  JSON.parse = function (value, ...args) { if (value === raw.toString()) parses++; return parse(value, ...args); };
  try { assert.deepEqual(await quotaFailure(raw), quotaExpected(['SERVICE_DISABLED'])); assert.equal(reads, 1); assert.equal(parses, 1); }
  finally { TextDecoder.prototype.decode = original; JSON.parse = parse; }
});

test('Gemini auth｜ErrorInfo 解析器非預期例外也不洩漏，清掉前段結果', async () => {
  const raw = quotaRaw([errorInfo('SERVICE_DISABLED'), errorInfo('USER_PROJECT_DENIED')]); const original = JSON.parse;
  JSON.parse = function (value, ...args) {
    const parsed = original(value, ...args);
    if (value === raw.toString()) Object.defineProperty(parsed.error.details[1], '@type', { get() { throw Error('synthetic-private-parser-exception'); } });
    return parsed;
  };
  try { assert.deepEqual(await quotaFailure(raw), quotaExpected(['PARSE_FAILED'])); }
  finally { JSON.parse = original; }
});

test('Gemini auth｜ErrorInfo 不讀 message metadata 或其他欄位的 getter', async () => {
  const raw = quotaRaw([errorInfo('SERVICE_DISABLED')]); const original = JSON.parse;
  JSON.parse = function (value, ...args) {
    const parsed = original(value, ...args);
    if (value === raw.toString()) for (const key of ['message', 'metadata', 'synthetic_private_key']) Object.defineProperty(parsed.error.details[0], key, { enumerable: true, get() { throw Error('synthetic-private-getter'); } });
    return parsed;
  };
  try { assert.deepEqual(await quotaFailure(raw), quotaExpected(['SERVICE_DISABLED'])); }
  finally { JSON.parse = original; }
});

for (const [level, key, expected] of [
  ['root', 'error', ['MALFORMED', 'NO_ERROR_INFO']],
  ['error', 'details', ['NO_ERROR_INFO']],
  ['detail', '@type', ['MALFORMED', 'NO_ERROR_INFO']],
  ['detail', 'domain', ['MALFORMED']],
  ['detail', 'reason', ['MALFORMED']],
]) {
  test(`Gemini auth｜ErrorInfo 不接受繼承的 ${level}.${key}`, async () => {
    const raw = quotaRaw([errorInfo('SERVICE_DISABLED')]); const original = JSON.parse;
    JSON.parse = function (value, ...args) {
      const parsed = original(value, ...args);
      if (value === raw.toString()) {
        const target = level === 'root' ? parsed : level === 'error' ? parsed.error : parsed.error.details[0];
        const inherited = { [key]: target[key] };
        delete target[key]; Object.setPrototypeOf(target, inherited);
      }
      return parsed;
    };
    try { assert.deepEqual(await quotaFailure(raw), quotaExpected(expected)); }
    finally { JSON.parse = original; }
  });
}

test('Gemini auth｜ErrorInfo 窄介面拒絕偽造 Error 屬性、原型及 message', () => {
  const foreign = new Error('GEMINI_AUTH_QUOTA_HTTP_403');
  for (const key of ['quotaDiagnostic', 'diagnostic', 'message']) Object.defineProperty(foreign, key, { get() { throw Error('synthetic-private-forged-property'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [foreign, revoked.proxy, null, undefined, 'synthetic-private-error', 403]) assert.doesNotThrow(() => { assert.equal(takeQuotaDiagnostic(value), undefined); });
});

async function rejectsClientSource(f, deps = f.deps) {
  let credentialReads = 0;
  const guarded = { ...deps };
  Object.defineProperty(guarded, 'credentialsPath', { get() { credentialReads++; return f.path; } });
  await assert.rejects(loadGeminiAuth(guarded), error => {
    assert.equal(error.message, 'GEMINI_AUTH_CLIENT_SOURCE'); assert.deepEqual(Object.keys(error), []);
    assert.equal(JSON.stringify(error), '{}'); return true;
  });
  assert.equal(credentialReads, 0, '核對 scripts/gemini-auth.js 來源核對在讀認證之前，再跑本檔');
  assert.deepEqual(f.calls, [], '核對 scripts/gemini-auth.js 來源失敗沒有任何上游呼叫，再跑本檔');
}

for (const kind of ['missing-root', 'wrong-type', 'relative-root', 'missing-file', 'missing-metadata', 'root-file', 'root-link', 'bundle-link', 'directory-link', 'bundle-directory', 'metadata-link', 'bundle-hash', 'metadata-hash', 'bundle-oversize', 'metadata-oversize', 'wrong-version', 'wrong-name', 'metadata-array', 'invalid-metadata-json', 'invalid-bundle-utf8']) {
  test(`Gemini auth｜公開 client 來源 ${kind} 早於認證與外呼拒收`, async () => {
    const f = fixture({ expiry_date: now - 1 }); const bundle = join(f.clientSourceRoot, sourceBundle); const metadata = join(f.clientSourceRoot, 'package.json');
    const deps = { ...f.deps };
    if (kind === 'missing-root') delete deps.clientSourceRoot;
    if (kind === 'wrong-type') deps.clientSourceRoot = {};
    if (kind === 'relative-root') deps.clientSourceRoot = 'official-cli';
    if (kind === 'missing-file') rmSync(bundle);
    if (kind === 'missing-metadata') rmSync(metadata);
    if (kind === 'root-file') deps.clientSourceRoot = metadata;
    if (kind === 'root-link') { const link = join(f.clientSourceRoot, '..', 'root-alias'); symlinkSync(f.clientSourceRoot, link); deps.clientSourceRoot = link; }
    if (kind === 'bundle-link' || kind === 'metadata-link') { const file = kind === 'bundle-link' ? bundle : metadata; renameSync(file, file + '.original'); symlinkSync(file + '.original', file); }
    if (kind === 'directory-link') { renameSync(join(f.clientSourceRoot, 'bundle'), join(f.clientSourceRoot, 'bundle-other')); symlinkSync('bundle-other', join(f.clientSourceRoot, 'bundle')); }
    if (kind === 'bundle-directory') { rmSync(bundle); mkdirSync(bundle); }
    if (kind === 'bundle-hash') writeFileSync(bundle, sourceCode + '// synthetic-unregistered-tamper');
    if (kind === 'metadata-hash') writeFileSync(metadata, '{"synthetic_unregistered":"metadata"}');
    if (kind === 'bundle-oversize') writeFileSync(bundle, 'x'.repeat(16 * 1024 * 1024 + 1));
    if (kind === 'metadata-oversize') writeFileSync(metadata, 'x'.repeat(64 * 1024 + 1));
    if (kind === 'wrong-version') putSource(metadata, JSON.stringify({ name: '@google/gemini-cli', version: '0.65.0' }), sourceMetadataHash);
    if (kind === 'wrong-name') putSource(metadata, JSON.stringify({ name: 'synthetic-package', version: '0.64.0' }), sourceMetadataHash);
    if (kind === 'metadata-array') putSource(metadata, '[]', sourceMetadataHash);
    if (kind === 'invalid-metadata-json') putSource(metadata, '{synthetic-private-invalid-metadata', sourceMetadataHash);
    if (kind === 'invalid-bundle-utf8') putSource(bundle, Buffer.concat([Buffer.from(sourceCode), Buffer.from([0xff])]), sourceBundleHash);
    await rejectsClientSource(f, deps);
  });
}

const clientGrammarCases = [
  ['missing client id', sourceCode.replace(/^var OAUTH_CLIENT_ID = .*\n/m, '')],
  ['missing client secret', sourceCode.replace(/^var OAUTH_CLIENT_SECRET = .*\n/m, '')],
  ['duplicate pair', sourceCode + sourceCode],
  ['extra id', sourceCode + '\nconst OAUTH_CLIENT_ID = "synthetic-other.apps.googleusercontent.com";\n'],
  ['extra secret', sourceCode + '\nlet OAUTH_CLIENT_SECRET = "synthetic-other-secret";\n'],
  ['roles swapped', sourceCode.replace(syntheticClientId, 'SWAP').replace(syntheticClientSecret, syntheticClientId).replace('SWAP', syntheticClientSecret)],
  ['expression', sourceCode.replace(`"${syntheticClientSecret}"`, 'getClientSecret()')],
  ['single quote', sourceCode.replace(`"${syntheticClientSecret}"`, `'${syntheticClientSecret}'`)],
  ['escaped string', sourceCode.replace(syntheticClientSecret, 'synthetic\\x41secret')],
  ['control character', sourceCode.replace(syntheticClientSecret, 'synthetic\nsecret')],
  ['long value', sourceCode.replace(syntheticClientSecret, 'x'.repeat(129))],
  ['wrong anchor', sourceCode.replace('var userAccountManager2 = new UserAccountManager();', 'var syntheticOther = new UserAccountManager();')],
  ['wrong next declaration', sourceCode.replace('var OAUTH_SCOPE = [', 'var syntheticOtherScope = [')],
];
for (const [kind, raw] of clientGrammarCases) {
  test(`Gemini auth｜公開 client 固定 grammar ${kind} 不猜第一組`, async () => {
    const f = fixture({ expiry_date: now - 1 }); putSource(join(f.clientSourceRoot, sourceBundle), raw, sourceBundleHash);
    await rejectsClientSource(f);
  });
}

test('Gemini auth｜公開 client 只進 TOKEN，不執行 source 或混入回傳與其他請求', async () => {
  const f = fixture({ expiry_date: now - 1 }); const ctx = await loadGeminiAuth(f.deps);
  const form = new URLSearchParams(f.calls[0].body);
  assert.equal(form.get('client_id') === syntheticClientId, true); assert.equal(form.get('client_secret') === syntheticClientSecret, true);
  assert.deepEqual(f.calls.map(call => call.url), [tokenUrl, loadUrl, quotaUrl]);
  assert.equal(JSON.stringify(f.calls.slice(1)).includes(syntheticClientId), false); assert.equal(JSON.stringify(f.calls.slice(1)).includes(syntheticClientSecret), false);
  assert.equal(ctx.dlpNeedles().includes(syntheticClientId), false); assert.equal(ctx.dlpNeedles().includes(syntheticClientSecret), false);
  assert.deepEqual(Object.keys(ctx), []); assert.throws(() => JSON.stringify(ctx), /^Error: GEMINI_AUTH_OPAQUE$/);
});

test('Gemini auth｜cwd PATH NODE_PATH 與 env 誘餌不能補缺少的可信定位', async () => {
  const f = fixture(); const savedCwd = process.cwd(); const names = ['PATH', 'NODE_PATH', 'GEMINI_CLIENT_SOURCE_ROOT', 'GEMINI_CLIENT_ID', 'GEMINI_CLIENT_SECRET'];
  const saved = names.map(name => process.env[name]);
  try {
    process.chdir(f.clientSourceRoot); names.forEach(name => { process.env[name] = f.clientSourceRoot; });
    const deps = { ...f.deps }; delete deps.clientSourceRoot;
    await rejectsClientSource(f, deps);
  } finally { process.chdir(savedCwd); names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }); }
});

for (const kind of ['short-read', 'read-error', 'opened-inode', 'after-size', 'after-time', 'after-inode', 'after-nonregular', 'path-replaced', 'close-error']) {
  test(`Gemini auth｜公開來源穩定讀 ${kind} 不回聲來源例外`, async () => {
    const f = fixture({ expiry_date: now - 1 }); const bundle = join(f.clientSourceRoot, sourceBundle);
    const original = { open: fs.openSync, read: fs.readSync, stat: fs.fstatSync, close: fs.closeSync };
    let target; let statCalls = 0; let replaced = false;
    fs.openSync = function (file, ...args) { const fd = original.open.call(this, file, ...args); if (file === bundle) target = fd; return fd; };
    fs.fstatSync = function (fd, ...args) {
      const observed = original.stat.call(this, fd, ...args);
      if (fd !== target) return observed;
      statCalls++;
      const changed = Object.assign(Object.create(Object.getPrototypeOf(observed)), observed);
      if (kind === 'opened-inode' && statCalls === 1) changed.ino++;
      if (kind === 'after-size' && statCalls === 2) changed.size++;
      if (kind === 'after-time' && statCalls === 2) changed.mtimeMs++;
      if (kind === 'after-inode' && statCalls === 2) changed.ino++;
      if (kind === 'after-nonregular' && statCalls === 2) changed.isFile = () => false;
      return changed;
    };
    fs.readSync = function (fd, ...args) {
      if (fd === target && kind === 'short-read') return 0;
      if (fd === target && kind === 'read-error') throw Error('synthetic-private-source-read');
      const count = original.read.call(this, fd, ...args);
      if (fd === target && kind === 'path-replaced' && !replaced) {
        replaced = true; renameSync(bundle, bundle + '.saved'); symlinkSync(bundle + '.saved', bundle);
      }
      return count;
    };
    fs.closeSync = function (fd) { original.close.call(this, fd); if (fd === target && kind === 'close-error') throw Error('synthetic-private-source-close'); };
    syncBuiltinESMExports();
    try { await rejectsClientSource(f); }
    finally { fs.openSync = original.open; fs.readSync = original.read; fs.fstatSync = original.stat; fs.closeSync = original.close; syncBuiltinESMExports(); }
  });
}

test('Gemini auth｜同一份來源只開一次，先核有限 bytes 的 hash 再用原 bytes 抽值', async () => {
  const f = fixture({ expiry_date: now - 1 }); const bundle = join(f.clientSourceRoot, sourceBundle); const metadata = join(f.clientSourceRoot, 'package.json');
  const original = fs.openSync; const opened = [];
  fs.openSync = function (file, ...args) {
    if ([bundle, metadata].includes(file)) { opened.push(file); assert.notEqual(args[0] & fs.constants.O_NOFOLLOW, 0); }
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.doesNotReject(loadGeminiAuth(f.deps));
    assert.deepEqual(opened, [metadata, bundle]);
    assert.equal(new URLSearchParams(f.calls[0].body).get('client_secret') === syntheticClientSecret, true);
  } finally { fs.openSync = original; syncBuiltinESMExports(); }
});

test('Gemini auth｜來源變更不沿用前一場已核設定', async () => {
  const f = fixture(); await loadGeminiAuth(f.deps); f.calls.length = 0;
  writeFileSync(join(f.clientSourceRoot, sourceBundle), sourceCode + '// synthetic-not-the-pinned-bytes');
  await rejectsClientSource(f);
});

test('Gemini auth｜來源參數 getter 的任意例外早於認證固定失敗', async () => {
  const f = fixture(); const deps = { ...f.deps }; let credentialRead = false;
  Object.defineProperty(deps, 'clientSourceRoot', { get() { throw Error('synthetic-private-source-root'); } });
  Object.defineProperty(deps, 'credentialsPath', { get() { credentialRead = true; return f.path; } });
  await assert.rejects(loadGeminiAuth(deps), /^Error: GEMINI_AUTH_CLIENT_SOURCE$/);
  assert.equal(credentialRead, false); assert.deepEqual(f.calls, []);
});

for (const [relative, cap] of [[sourceBundle, 16 * 1024 * 1024], ['package.json', 64 * 1024]]) {
  test(`Gemini auth｜公開來源 ${relative} 超界在開檔前停止`, async () => {
    const f = fixture(); const file = join(f.clientSourceRoot, relative); writeFileSync(file, 'x'.repeat(cap + 1));
    const original = fs.openSync; let opened = false;
    fs.openSync = function (name, ...args) { if (name === file) opened = true; return original.call(this, name, ...args); };
    syncBuiltinESMExports();
    try { await rejectsClientSource(f); assert.equal(opened, false); }
    finally { fs.openSync = original; syncBuiltinESMExports(); }
  });
}

test('Gemini auth｜核 hash 後只抽同份 bytes，不重開已改變的來源檔', async () => {
  const f = fixture({ expiry_date: now - 1 }); const bundle = join(f.clientSourceRoot, sourceBundle);
  const original = crypto.createHash; let replaced = false;
  crypto.createHash = (...args) => {
    const hash = original(...args); const update = hash.update.bind(hash); const digest = hash.digest.bind(hash); let bundleInput = false;
    hash.update = (value, ...rest) => { if (Buffer.from(value).equals(Buffer.from(sourceCode))) bundleInput = true; update(value, ...rest); return hash; };
    hash.digest = (...rest) => { const result = digest(...rest); if (bundleInput) { replaced = true; writeFileSync(bundle, 'synthetic-unverified-replacement'); } return result; };
    return hash;
  };
  syncBuiltinESMExports();
  try {
    await assert.doesNotReject(loadGeminiAuth(f.deps)); assert.equal(replaced, true);
    assert.equal(new URLSearchParams(f.calls[0].body).get('client_secret') === syntheticClientSecret, true);
  } finally { crypto.createHash = original; syncBuiltinESMExports(); }
});
