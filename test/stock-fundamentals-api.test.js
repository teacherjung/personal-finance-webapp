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

// ============================================================================
// ⚠️ 全鏈路回歸（2026-07-29 補；Codex 定向複審 #351 指出的缺口）
// ============================================================================
//
// 上面那些題全都用 calendar fixture，而它**算不出「衍生指標再當輸入」**的組合
// （沒有資本支出→沒有自由現金流→沒有自由現金流率），所以整組 API 題對這個故障是盲的：
// 還原舊 bug 後 `node --test test/stock-fundamentals-api.test.js` 仍然 7 pass / 0 fail，
// 但真環境的 GOOGL／AAPL／MSFT 一律 502。
//
// 缺的不是「多一個斷言」，是**沒有任何一題走完整條路**：
//   route → service → repo mutate → 寫入櫃檯 → 落庫 → 再 GET 回來
// 純函式題證明得了解析結果的形狀，證明不了「它存得進去」。

const fiscalFixture = JSON.parse(await readFile(
  new URL('./fixtures/sec/fiscal-year-company.json', import.meta.url),
  'utf8'
));

/** @param {string} url */
function fiscalPayload(url) {
  if (url === 'https://www.sec.gov/files/company_tickers.json') return fiscalFixture.tickerIndex;
  if (url === 'https://data.sec.gov/submissions/CIK0000900001.json') return fiscalFixture.submissions;
  if (url === 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000900001.json') return fiscalFixture.companyFacts;
  throw new Error(`測試收到未核准的外部 URL：${url}`);
}

test('全鏈路：「衍生指標當輸入」的公司走完整 refresh → 落庫 → GET，不可以在寫入櫃檯被拒', async () => {
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    logger: silentLogger,
    fetchImpl: async (url) => jsonResponse(fiscalPayload(String(url)))
  });

  const refresh = await request('/api/stock-fundamentals/FRUIT/refresh', { method: 'POST' });
  const text = await refresh.clone().text();
  assert.equal(refresh.status, 200,
    `refresh 應該成功。舊 bug 會在這裡回 502「data 不是合法的 SEC 解析結果」——${text}`);
  const body = await refresh.json();
  assert.equal(body.refreshed, true);

  // ⚠️ 前置條件：這家公司真的算得出「衍生指標當輸入」，否則本題等於沒考
  //    （calendar fixture 就是這樣悄悄漏掉這個故障的）。
  const margin = body.data.metrics.freeCashFlowMargin;
  assert.equal(margin.status, 'available', 'fixture 必須算得出自由現金流率');
  const nested = margin.annual.find((/** @type {any} */ fact) => fact?.inputs?.freeCashFlow);
  assert.ok(nested, '必須有「輸入本身也是衍生指標」的那一筆');

  // 落庫之後再讀一次：證明真的寫進去了，不是只在回應裡好看
  const cached = await request('/api/stock-fundamentals/FRUIT');
  assert.equal(cached.status, 200);
  const stored = await cached.json();
  assert.equal(stored.freshness, 'fresh');
  assert.equal(stored.data.metrics.freeCashFlowMargin.status, 'available',
    '快取裡必須有這個指標——refresh 回 200 但沒落庫的話，下次開頁面又是空的');
});

test('currentDebt 全鏈路｜抓 filer label 排除父子重疊後再相加，衍生來源可落庫並從 GET 讀回', async () => {
  const accession = '0000900099-25-000001';
  const tickerIndex = {
    0: { cik_str: 900099, ticker: 'DEBT', title: 'Synthetic Current Debt Company' }
  };
  const submissions = {
    cik: '0000900099',
    name: 'Synthetic Current Debt Company',
    sic: '3571',
    fiscalYearEnd: '1231',
    filings: {
      recent: {
        accessionNumber: [accession],
        primaryDocument: ['debt-20250331.htm']
      }
    }
  };
  const baseRow = {
    end: '2025-03-31',
    form: '10-Q',
    filed: '2025-05-01',
    accn: accession,
    fy: 2025,
    fp: 'Q1'
  };
  const companyFacts = {
    cik: '0000900099',
    entityName: 'Synthetic Current Debt Company',
    facts: {
      'us-gaap': {
        ShortTermBorrowings: { units: { USD: [{ ...baseRow, val: 600 }] } },
        LongTermDebtCurrent: { units: { USD: [{ ...baseRow, val: 500 }] } }
      }
    }
  };
  const labelXml = [
    '<link:labelLink xmlns:link="http://www.xbrl.org/2003/linkbase"',
    ' xmlns:xlink="http://www.w3.org/1999/xlink">',
    '<link:label xlink:label="lab_us-gaap_ShortTermBorrowings"',
    ' xlink:role="http://www.xbrl.org/2003/role/terseLabel">Short-term debt</link:label>',
    '</link:labelLink>'
  ].join('');
  const calls = [];
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    minIntervalMs: 0,
    logger: silentLogger,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://www.sec.gov/files/company_tickers.json') return jsonResponse(tickerIndex);
      if (String(url) === 'https://data.sec.gov/submissions/CIK0000900099.json') {
        return jsonResponse(submissions);
      }
      if (String(url) === 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000900099.json') {
        return jsonResponse(companyFacts);
      }
      if (String(url) === 'https://www.sec.gov/Archives/edgar/data/900099/000090009925000001/debt-20250331_lab.xml') {
        return new Response(labelXml, { status: 200, headers: { 'Content-Type': 'application/xml' } });
      }
      throw new Error(`測試收到未核准的外部 URL：${url}`);
    }
  });

  const refresh = await request('/api/stock-fundamentals/DEBT/refresh', { method: 'POST' });
  assert.equal(refresh.status, 200, await refresh.clone().text());
  const body = await refresh.json();
  const currentDebt = body.data.metrics.currentDebt.latestQuarter;
  assert.equal(currentDebt.value, 1100, '600 > 500，沒有 filer label 時會 fail-closed 保留 600；本題必須證明 label 真的接上');
  assert.equal(currentDebt.taxonomy, 'derived');
  assert.equal(currentDebt.tag, 'ShortTermBorrowings + LongTermDebtCurrent');
  assert.equal(currentDebt.inputs.shortTerm.value, 600);
  assert.equal(currentDebt.inputs.currentMaturity.value, 500);
  assert.deepEqual(calls, [
    'https://www.sec.gov/files/company_tickers.json',
    'https://data.sec.gov/submissions/CIK0000900099.json',
    'https://data.sec.gov/api/xbrl/companyfacts/CIK0000900099.json',
    'https://www.sec.gov/Archives/edgar/data/900099/000090009925000001/debt-20250331_lab.xml'
  ]);

  const cached = await request('/api/stock-fundamentals/DEBT');
  assert.equal(cached.status, 200);
  const stored = await cached.json();
  assert.equal(stored.data.metrics.currentDebt.latestQuarter.value, 1100);
  assert.equal(stored.data.metrics.currentDebt.latestQuarter.formula, currentDebt.formula);
  assert.equal(calls.length, 4, 'GET 只能讀已通過寫入牆的快取，不可重抓 filer label');
});
