// @ts-check
// F4 SEC 服務／API 考題。全部使用合成 Company Facts 與暫存 SQLite，不連外、不碰真實財務資料。

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const TEST_STORE = join(tmpdir(), `stock-fundamentals-api-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/sec/calendar-year-company.json', import.meta.url),
  'utf8'
));
const { app } = await import('../server.js');
const { emptyDb, saveDb } = await import('../lib/repo.js');
const {
  SEC_MIN_INTERVAL_MS,
  STOCK_FUNDAMENTALS_TTL_MS,
  setStockFundamentalsOptionsForTest
} = await import('../lib/services/stock-fundamentals.js');
const { validateImportItem } = await import('../lib/schema.js');

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;
const SEC_USER_AGENT = 'NotEasy Test data@example.test';
const silentLogger = { warn() {} };

/** @param {string} url */
function fixturePayload(url) {
  if (url === 'https://www.sec.gov/files/company_tickers.json') return fixture.tickerIndex;
  if (url === 'https://data.sec.gov/submissions/CIK0000900002.json') return fixture.submissions;
  if (url === 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000900002.json') return fixture.companyFacts;
  throw new Error(`測試收到未核准的外部 URL：${url}`);
}

/** @param {any} payload @param {number} [status] */
const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

/** @param {string} path @param {RequestInit=} init */
const request = (path, init) => fetch(`${base}${path}`, init);

beforeEach(async () => {
  setStockFundamentalsOptionsForTest(null);
  await saveDb(emptyDb());
});

after(async () => {
  server.close();
  setStockFundamentalsOptionsForTest(null);
  for (const suffix of ['', '.bak', '-wal', '-shm']) {
    await rm(TEST_STORE + suffix, { force: true });
  }
});

test('refresh 成功：只打三個固定 SEC URL、帶聯絡 User-Agent、相鄰請求至少 500ms，GET 不連外', async () => {
  let clock = Date.parse('2026-07-28T01:00:00.000Z');
  /** @type {{url:string,at:number,headers:any}[]} */
  const calls = [];
  setStockFundamentalsOptionsForTest({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    userAgent: SEC_USER_AGENT,
    logger: silentLogger,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), at: clock, headers: init?.headers });
      return jsonResponse(fixturePayload(String(url)));
    }
  });

  const refresh = await request('/api/stock-fundamentals/cal/refresh', { method: 'POST' });
  assert.equal(refresh.status, 200);
  const body = await refresh.json();
  assert.equal(body.refreshed, true);
  assert.equal(body.freshness, 'fresh');
  assert.equal(body.data.symbol, 'CAL');
  assert.equal(body.data.company.cik, '0000900002');
  assert.equal(body.data.metrics.revenue.annual.at(-1).value, 2600);
  assert.deepEqual(calls.map(call => call.url), [
    'https://www.sec.gov/files/company_tickers.json',
    'https://data.sec.gov/submissions/CIK0000900002.json',
    'https://data.sec.gov/api/xbrl/companyfacts/CIK0000900002.json'
  ]);
  assert.ok(calls.every(call => call.headers['User-Agent'] === SEC_USER_AGENT));
  assert.ok(calls[1].at - calls[0].at >= SEC_MIN_INTERVAL_MS);
  assert.ok(calls[2].at - calls[1].at >= SEC_MIN_INTERVAL_MS);

  const count = calls.length;
  const cached = await request('/api/stock-fundamentals/CAL');
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).freshness, 'fresh');
  assert.equal(calls.length, count, 'GET 只能讀快取，不可偷偷連 SEC');
  assert.equal((await request('/api/stockFundamentals')).status, 404, '不可開放裸 readonly 集合端點');
});

test('輸入與 SSRF 防線：原型名、斜線、query 字元與超長代號全 400，外部請求為零', async () => {
  let calls = 0;
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    logger: silentLogger,
    fetchImpl: async () => { calls += 1; return jsonResponse({}); }
  });
  for (const symbol of ['__proto__', 'toString', 'AAPL%2Fx', 'AAPL%3Fx%3D1', 'AAAAAAAAAAAAA']) {
    const response = await request(`/api/stock-fundamentals/${symbol}/refresh`, { method: 'POST' });
    const body = await response.text();
    assert.equal(response.status, 400, `${symbol}: ${body}`);
  }
  assert.equal(calls, 0);
});

test('429／逾時／壞 JSON／過大回應：最後成功資料與 fetchedAt 原封不動，只更新錯誤狀態', async () => {
  let clock = Date.parse('2026-07-28T02:00:00.000Z');
  const common = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    userAgent: SEC_USER_AGENT,
    logger: silentLogger
  };
  setStockFundamentalsOptionsForTest({
    ...common,
    fetchImpl: async (url) => jsonResponse(fixturePayload(String(url)))
  });
  const seeded = await (await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).json();
  const originalData = structuredClone(seeded.data);
  const originalFetchedAt = seeded.fetchedAt;
  clock += STOCK_FUNDAMENTALS_TTL_MS + 1;

  let rateCalls = 0;
  setStockFundamentalsOptionsForTest({
    ...common,
    fetchImpl: async () => { rateCalls += 1; return jsonResponse({ error: 'synthetic' }, 429); }
  });
  const rateLimited = await (await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).json();
  assert.equal(rateCalls, 3, '429 只有限重試三次');
  assert.equal(rateLimited.refreshed, false);
  assert.equal(rateLimited.freshness, 'stale');
  assert.equal(rateLimited.lastError.code, 'sec_http_error');
  assert.equal(rateLimited.lastError.status, 429);
  assert.equal(rateLimited.fetchedAt, originalFetchedAt);
  assert.deepEqual(rateLimited.data, originalData);

  let timeoutCalls = 0;
  setStockFundamentalsOptionsForTest({
    ...common,
    fetchImpl: async () => {
      timeoutCalls += 1;
      throw Object.assign(new Error('synthetic timeout'), { name: 'AbortError' });
    }
  });
  const timedOut = await (await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).json();
  assert.equal(timeoutCalls, 3);
  assert.equal(timedOut.lastError.code, 'sec_timeout');
  assert.equal(timedOut.fetchedAt, originalFetchedAt);
  assert.deepEqual(timedOut.data, originalData);

  let jsonCalls = 0;
  setStockFundamentalsOptionsForTest({
    ...common,
    fetchImpl: async () => {
      jsonCalls += 1;
      return new Response('{bad json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  const invalidJson = await (await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).json();
  assert.equal(jsonCalls, 1, '解析失敗不盲目重打');
  assert.equal(invalidJson.lastError.code, 'sec_invalid_json');
  assert.equal(invalidJson.fetchedAt, originalFetchedAt);
  assert.deepEqual(invalidJson.data, originalData);

  let largeCalls = 0;
  setStockFundamentalsOptionsForTest({
    ...common,
    maxResponseBytes: 100,
    fetchImpl: async () => {
      largeCalls += 1;
      return new Response(`{"oversized":"${'x'.repeat(100)}"}`, {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  const oversized = await (await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).json();
  assert.equal(largeCalls, 1, '回應大小超標不可重試或繼續讀 body');
  assert.equal(oversized.lastError.code, 'sec_response_too_large');
  assert.equal(oversized.fetchedAt, originalFetchedAt);
  assert.deepEqual(oversized.data, originalData);
});

test('逾時涵蓋 response body：headers 已到但串流不結束也要有限重試後回 504', async () => {
  let calls = 0;
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    logger: silentLogger,
    timeoutMs: 5,
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      calls += 1;
      const signal = /** @type {AbortSignal} */ (init?.signal);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
          signal.addEventListener('abort', () => {
            controller.error(Object.assign(new Error('synthetic body timeout'), { name: 'AbortError' }));
          }, { once: true });
        }
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  });

  const response = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  assert.equal(response.status, 504);
  assert.equal(calls, 3, 'body 逾時同樣只重試三次');
  const cached = await (await request('/api/stock-fundamentals/CAL')).json();
  assert.equal(cached.freshness, 'missing');
  assert.equal(cached.lastError.code, 'sec_timeout');
});

test('有限重試：5xx 可恢復；一般 4xx 不重試，無快取時回錯但 GET 可看到 missing 狀態', async () => {
  let clock = Date.parse('2026-07-28T03:00:00.000Z');
  let tickerAttempts = 0;
  setStockFundamentalsOptionsForTest({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    userAgent: SEC_USER_AGENT,
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (String(url).endsWith('company_tickers.json') && tickerAttempts++ < 2) {
        return jsonResponse({}, 503);
      }
      return jsonResponse(fixturePayload(String(url)));
    }
  });
  const recovered = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  assert.equal(recovered.status, 200);
  assert.equal(tickerAttempts, 3);

  await saveDb(emptyDb());
  let missingAgentCalls = 0;
  setStockFundamentalsOptionsForTest({
    userAgent: '',
    logger: silentLogger,
    fetchImpl: async () => { missingAgentCalls += 1; return jsonResponse({}); }
  });
  const missingAgent = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  assert.equal(missingAgent.status, 503);
  assert.equal(missingAgentCalls, 0, '沒有可聯絡 User-Agent 時不可送出未分類 bot 請求');

  let forbiddenCalls = 0;
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    logger: silentLogger,
    fetchImpl: async () => { forbiddenCalls += 1; return jsonResponse({}, 403); }
  });
  const forbidden = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  assert.equal(forbidden.status, 502);
  assert.equal(forbiddenCalls, 1, '一般 4xx 不可重試');
  const missing = await (await request('/api/stock-fundamentals/CAL')).json();
  assert.equal(missing.freshness, 'missing');
  assert.equal(missing.data, null);
  assert.equal(missing.lastError.status, 403);
});

test('同代號同時 refresh：共用一輪三個公開請求，但每個呼叫都完成自己的快取寫入', async () => {
  let clock = Date.parse('2026-07-28T04:00:00.000Z');
  let calls = 0;
  setStockFundamentalsOptionsForTest({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    userAgent: SEC_USER_AGENT,
    logger: silentLogger,
    fetchImpl: async (url) => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return jsonResponse(fixturePayload(String(url)));
    }
  });
  const [left, right] = await Promise.all([
    request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' }),
    request('/api/stock-fundamentals/cal/refresh', { method: 'POST' })
  ]);
  assert.equal(left.status, 200);
  assert.equal(right.status, 200);
  assert.equal(calls, 3, '同一代號的公開資料只抓一輪');
  assert.equal((await left.json()).data.company.name, 'Synthetic Calendar Services');
  assert.equal((await right.json()).data.company.name, 'Synthetic Calendar Services');
});

test('快取匯入牆：公司身分走散、非標準時間與原型鍵都明確拒絕', () => {
  const at = '2026-07-28T05:00:00.000Z';
  const baseRecord = {
    symbol: 'CAL',
    lastAttemptAt: at,
    fetchedAt: at,
    data: {
      symbol: 'OTHER',
      market: 'US',
      company: { cik: '0000900002', name: 'Synthetic' },
      periods: { annual: [], latestQuarter: null },
      metrics: {},
      warnings: []
    }
  };
  assert.match(validateImportItem('stockFundamentals', baseRecord).errors.join('/'), /公司身分/);
  assert.ok(validateImportItem('stockFundamentals', { ...baseRecord, lastAttemptAt: '2026-07-28' }).errors.length);
  const { fetchedAt, ...withoutFetchedAt } = { ...baseRecord, data: { ...baseRecord.data, symbol: 'CAL' } };
  assert.ok(fetchedAt);
  assert.match(validateImportItem('stockFundamentals', withoutFetchedAt).errors.join('/'), /fetchedAt/);
  const polluted = structuredClone(baseRecord);
  polluted.data.symbol = 'CAL';
  polluted.data.metrics = JSON.parse('{"__proto__":{"value":1}}');
  assert.match(validateImportItem('stockFundamentals', polluted).errors.join('/'), /合法的 SEC/);
});
