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

test('label best-effort 也受總預算管：必要資料吃光預算後不得再對 SEC Archives 發出（漏傳 deadlineAt 就會紅）', async () => {
  // Codex #361 r4 blocking：冗餘收斂後佇列層不再自驗期限 ⇒ label 呼叫只要漏傳 deadlineAt
  // 就完全繞過唯一守門，而當時 23 題全綠。這一題就是它開的處方。
  let clock = Date.parse('2026-07-30T06:00:00.000Z');
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
    refreshBudgetMs: 1000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    logger: silentLogger,
    fetchImpl: async (url) => {
      calls.push(String(url));
      const u = String(url);
      if (u === 'https://www.sec.gov/files/company_tickers.json') return jsonResponse(tickerIndex);
      if (u === 'https://data.sec.gov/submissions/CIK0000900099.json') return jsonResponse(submissions);
      if (u === 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000900099.json') {
        clock += 2000;   // 必要資料就把 1000ms 預算吃光
        return jsonResponse(companyFacts);
      }
      if (u.includes('/Archives/edgar/')) return new Response(labelXml, { status: 200, headers: { 'Content-Type': 'application/xml' } });
      throw new Error(`測試收到未核准的外部 URL：${url}`);
    }
  });

  const refresh = await request('/api/stock-fundamentals/DEBT/refresh', { method: 'POST' });
  assert.equal(refresh.status, 200, await refresh.clone().text());
  assert.equal(
    calls.filter((url) => url.includes('/Archives/edgar/')).length, 0,
    'label 是 best-effort，但預算吃光後仍不得對 SEC 發出——漏傳 deadlineAt 就會繞過唯一守門'
  );
  // 沒有 label ⇒ 走保守判準（600 > 500 無法排除父子重疊）＝保留短借原值，不相加
  const body = await refresh.json();
  assert.equal(body.data.metrics.currentDebt.latestQuarter.value, 600, '無 label 必須 fail-closed 保留 600，不可硬加成 1100');
});

// ---- 錯誤歸因（2026-07-30，#335 複審 contract/security 兩條；r2 依 Codex 建議加硬）-----------
// 病：SEC 管線與寫入櫃檯的錯混在同一個 catch——內部錯被記成 SEC lastError 永久寫進租戶快取、
// 內部原文（[schema] …請修程式）吐給瀏覽器、伺服器日誌只印 stage=unknown。#351 花一天查根因就是這個機制。
// r2：SEC 身分改用模組私有 Symbol（不可偽造）——「帶 stage」不是證明，廣包 catch 會替內部例外補 stage。

/** 先種一筆成功資料，回傳 {fetchedAt, revenue}——三題共用「舊資料必須原封不動」的前置。 */
async function seedSuccessfulRefresh(logLines) {
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    logger: { warn: (line) => logLines.push(String(line)) },
    fetchImpl: async (url) => jsonResponse(fixturePayload(String(url)))
  });
  const seeded = await (await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).json();
  assert.equal(seeded.freshness, 'fresh', '前置：先種成功資料');
  return { fetchedAt: seeded.fetchedAt, revenue: seeded.data.metrics.revenue.annual.at(-1).value };
}

test('內部寫入失敗不得洗成 SEC 失敗：500 通用訊息、不寫 lastError、舊資料原封不動、根因進日誌', async () => {
  /** @type {string[]} */
  const logLines = [];
  const before = await seedSuccessfulRefresh(logLines);
  // 向量＝submissions.name 超長（>LEN_LONG）：SEC 抓取與解析全部成功，寫入被櫃檯拒收
  // ——正是 #351 那族「解析器自己好好的、櫃檯整包拒收」的第二個觸發點（#335 複審 minor 條）。
  const sub = structuredClone(fixture.submissions);
  sub.name = 'A'.repeat(30000);
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    logger: { warn: (line) => logLines.push(String(line)) },
    fetchImpl: async (url) => jsonResponse(
      String(url).includes('/submissions/') ? sub : fixturePayload(String(url))
    )
  });

  const refresh = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  const body = await refresh.json();
  assert.equal(refresh.status, 500, JSON.stringify(body));
  // 瀏覽器只准拿通用訊息（wrapRoute 錯誤形狀＝{ error: 訊息 }）：內部原文一個字都不可外洩
  assert.ok(!JSON.stringify(body).includes('[schema]'), `內部原文外洩到瀏覽器：${JSON.stringify(body)}`);
  assert.ok(!JSON.stringify(body).includes('請修程式'), '內部指示句外洩到瀏覽器');
  assert.match(String(body.error || ''), /不是 SEC 的問題/, '要明說不是 SEC 壞了，別讓使用者去冤枉上游');

  // 內部故障絕不寫進租戶快取；種過的成功資料一個位元組都不可動
  const view = await (await request('/api/stock-fundamentals/CAL')).json();
  assert.equal(view.lastError, null, `內部錯被永久記成 SEC 失敗：${JSON.stringify(view.lastError)}`);
  assert.equal(view.fetchedAt, before.fetchedAt, '內部失敗不可動到成功資料的 fetchedAt');
  assert.equal(view.data.metrics.revenue.annual.at(-1).value, before.revenue, '成功資料被改動');

  // 根因（含 [schema] 原文）必須在伺服器日誌——舊版連日誌都查不到，方向完全相反
  assert.ok(
    logLines.some((line) => line.includes('內部錯誤') && line.includes('[schema]')),
    `伺服器日誌找不到根因：${JSON.stringify(logLines)}`
  );
});

test('SEC 上游失敗：lastError 記對 stage/code/status、舊資料與 fetchedAt 原封不動、日誌含本服務的 message=', async () => {
  /** @type {string[]} */
  const logLines = [];
  const before = await seedSuccessfulRefresh(logLines);
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    sleep: async () => {},   // 讓 429/5xx 重試不等真實時間
    logger: { warn: (line) => logLines.push(String(line)) },
    fetchImpl: async (url) => (
      String(url).includes('/companyfacts/')
        ? jsonResponse({ error: 'synthetic outage' }, 500)
        : jsonResponse(fixturePayload(String(url)))
    )
  });

  const refresh = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  // 契約：已有成功資料時 SEC 失敗回 200＋refreshed:false＋refreshError（保留最後成功資料）
  assert.equal(refresh.status, 200);
  const refreshBody = await refresh.json();
  assert.equal(refreshBody.refreshed, false);
  assert.equal(refreshBody.refreshError?.code, 'sec_http_error');
  const view = await (await request('/api/stock-fundamentals/CAL')).json();
  // r1 版考題被 Codex 判太弱（stage 只驗非 unknown）——r2 鎖死整組欄位
  assert.ok(view.lastError, 'SEC 真的失敗＝lastError 照舊要記');
  assert.equal(view.lastError.stage, 'company-facts', '要記到真正失敗的階段');
  assert.equal(view.lastError.code, 'sec_http_error');
  assert.equal(view.lastError.status, 500, 'status 要是上游的 HTTP 500');
  assert.equal(view.fetchedAt, before.fetchedAt, 'SEC 失敗不可動到最後成功資料的 fetchedAt');
  assert.equal(view.data.metrics.revenue.annual.at(-1).value, before.revenue, '最後成功資料被改動');
  assert.ok(
    logLines.some((line) => /symbol=CAL .*code=sec_http_error .*message=/.test(line)),
    `日誌要有本服務的 message= 根因行：${JSON.stringify(logLines)}`
  );
});

test('內部例外就算發生在 SEC 管線深處也不得穿上 SEC 外衣（#358 r1 blocking 的專屬考題）', async () => {
  /** @type {string[]} */
  const logLines = [];
  const before = await seedSuccessfulRefresh(logLines);
  // 注入向量：fetch 連線失敗（合法的可重試 SEC 錯）→ 重試路徑呼叫 opts.sleep → sleep 炸出
  // 內部例外。舊版廣包 catch 會替它補 stage 包成 sec_network_error＝寫進租戶 lastError。
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    sleep: async () => { throw new Error('內部時鐘壞掉（合成注入）'); },
    logger: { warn: (line) => logLines.push(String(line)) },
    fetchImpl: async (url) => {
      if (String(url).includes('/companyfacts/')) throw new TypeError('fetch failed（合成網路故障）');
      return jsonResponse(fixturePayload(String(url)));
    }
  });

  const refresh = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  const body = await refresh.json();
  assert.equal(refresh.status, 500, JSON.stringify(body));
  assert.match(String(body.error || ''), /不是 SEC 的問題/);
  const view = await (await request('/api/stock-fundamentals/CAL')).json();
  assert.equal(view.lastError, null, `內部例外被穿上 SEC 外衣寫進快取：${JSON.stringify(view.lastError)}`);
  assert.equal(view.fetchedAt, before.fetchedAt);
  assert.ok(
    logLines.some((line) => line.includes('內部錯誤') && line.includes('內部時鐘壞掉')),
    `根因要進日誌：${JSON.stringify(logLines)}`
  );
});

test('body 串流在 headers 後中斷（terminated）＝可重試的 SEC 連線錯，第三次成功要正常 refresh', async () => {
  // #358 r2 blocking：undici 的 body 中斷丟 TypeError('terminated')——不是 abort、沒有鋼印，
  // 曾被誤判成內部錯（不重試、500、不記 lastError；r1 舊版反而會重試三次）。
  let factsCalls = 0;
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    sleep: async () => {},
    logger: silentLogger,
    fetchImpl: async (url) => {
      if (String(url).includes('/companyfacts/')) {
        factsCalls += 1;
        if (factsCalls <= 2) {
          return new Response(new ReadableStream({
            start(controller) { controller.error(new TypeError('terminated')); }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }
      return jsonResponse(fixturePayload(String(url)));
    }
  });
  const refresh = await (await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).json();
  assert.equal(factsCalls, 3, '前兩次中斷要重試，第三次成功');
  assert.equal(refresh.freshness, 'fresh', `中斷兩次後應成功 refresh：${JSON.stringify(refresh.lastError || refresh)}`);
  assert.equal(refresh.lastError, null);
});

test('SEC 資料契約失敗（合法 JSON、身分對不上）＝sec_parse_error 記入 lastError（鎖住 SecDataContractError 這條新分類）', async () => {
  const badFacts = structuredClone(fixture.companyFacts);
  badFacts.cik = 999999;   // 與 ticker/submissions 的 CIK 不一致 → 解析器丟 SecDataContractError
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    logger: silentLogger,
    fetchImpl: async (url) => jsonResponse(
      String(url).includes('/companyfacts/') ? badFacts : fixturePayload(String(url))
    )
  });
  const refresh = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  assert.equal(refresh.status, 502, await refresh.text());
  const view = await (await request('/api/stock-fundamentals/CAL')).json();
  assert.equal(view.lastError?.code, 'sec_parse_error', '資料契約錯是 SEC 端、要記 lastError');
  assert.equal(view.lastError?.stage, 'parse');
});

// ---- 佇列兩道護欄（2026-07-30，#335 複審 dos 條）------------------------------------------
// 病：全站佇列卡在每一次 fetch 上、無深度上限、無總期限——SEC 一慢，所有租戶的 refresh
// 一起被拖住十幾分鐘、連線與記憶體全被佔住（#357 的 label 抓取讓單次 refresh 最多 11 個請求，更易發作）。

test('佇列滿＝立即 503 請稍後再試（fail-fast），不無限排隊、不記 lastError、不算內部錯', async () => {
  /** @type {(() => void)[]} */
  const gates = [];   // 突變情境下 B 也會走到掛住的 fetch——resolver 要「全部」收集、finally 全放，
                      // 單一變數會被後來者蓋掉＝前者永遠懸掛、server.close 等不到（實際踩過）
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    maxQueueDepth: 1,
    timeoutMs: 60000,   // 讓掛住的 fetch 不被 per-fetch 逾時放走，深度保持佔滿
    logger: silentLogger,
    fetchImpl: (url) => {
      if (String(url).includes('company_tickers')) {
        return new Promise((resolve) => { gates.push(() => resolve(jsonResponse(fixturePayload(String(url))))); });
      }
      return Promise.resolve(jsonResponse(fixturePayload(String(url))));
    }
  });
  // A 先進佇列並掛住（深度=1）
  const pendingA = request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  await new Promise((resolve) => setTimeout(resolve, 50));   // 讓 A 真的進到佇列
  // B（不同代號＝不共享 in-flight）此刻進來：深度已滿 → 必須「立即」503，不是排到天荒地老
  try {
    const b = await request('/api/stock-fundamentals/FRUIT/refresh', {
      method: 'POST', signal: AbortSignal.timeout(1500)   // 突變拆掉深度檢查時 B 會掛住＝這裡 abort＝紅
    });
    const bBody = await b.json();
    assert.equal(b.status, 503, JSON.stringify(bBody));
    assert.match(String(bBody.error || ''), /稍後再試/, '要講真話：是排隊滿了，不是內部錯誤也不是 SEC 壞了');
    const viewB = await (await request('/api/stock-fundamentals/FRUIT')).json();
    assert.equal(viewB.lastError, null, 'back-pressure 不是 SEC 的錯，不得記 lastError');
  } finally {
    // 收尾必須在 finally：斷言失敗（含突變紅）時也要放行「全部」懸掛的 fetch，
    // 否則 server.close 永遠等不到（gates 可能不只 A 的——突變情境下 B 也掛在這）
    for (const release of gates) release();
    await pendingA.catch(() => undefined);
  }
});

test('單次 refresh 超過總時限＝branded sec_timeout 記入 lastError，最後成功資料原封不動', async () => {
  /** @type {string[]} */
  const logLines = [];
  const seeded = await seedSuccessfulRefresh(logLines);
  let clock = Date.parse('2026-07-30T01:00:00.000Z');
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    refreshBudgetMs: 1000,
    logger: { warn: (line) => logLines.push(String(line)) },
    fetchImpl: async (url) => {
      // submissions 這一步吃掉 2 秒（模擬 SEC 變慢）→ 下一個排隊請求（company-facts）
      // 輪到自己時預算已耗盡，必須不再發出、以 sec_timeout 收場
      if (String(url).includes('/submissions/')) clock += 2000;
      return jsonResponse(fixturePayload(String(url)));
    }
  });
  const refresh = await (await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).json();
  assert.equal(refresh.refreshed, false);
  assert.equal(refresh.refreshError?.code, 'sec_timeout', JSON.stringify(refresh.refreshError || refresh));
  const view = await (await request('/api/stock-fundamentals/CAL')).json();
  assert.equal(view.lastError?.code, 'sec_timeout', '總時限逾期可歸因 SEC 慢＝要記 lastError 讓使用者看得到原因');
  assert.equal(view.fetchedAt, seeded.fetchedAt, '最後成功資料原封不動');
});

// ---- 佇列考題電池（r3：依 Codex #361 r2 的四點弱點重寫）----------------------------------
// r2 版被指出的問題：守恆電池在各階段間呼叫 setStockFundamentalsOptionsForTest → **深度被重設為 0**，
// 最後的容量探針證明不了任何事；沒有「已開始讀 body 時被 deadline」與「retry sleep 跨線」；
// 等待者題沒直接斷言 504、也沒有下界；固定睡 50ms 在慢 CI 會偶發。全部改掉。

/** fetch 進場握手：回傳 {entered, release}，取代固定 sleep（慢 CI 不再偶發） */
function makeGate() {
  /** @type {(() => void)[]} */
  const releases = [];
  let signalEntered = () => {};
  const entered = new Promise((resolve) => { signalEntered = () => resolve(undefined); });
  return {
    entered,
    hold: (value) => new Promise((resolve) => { releases.push(() => resolve(value)); signalEntered(); }),
    releaseAll: () => { for (const r of releases) r(); }
  };
}

test('深度守恆：正常完成、SEC 失敗、總時限逾期三條路徑後名額都要還回來（全程同一組 options，深度不被重設）', async () => {
  // Codex r2 指出：r2 版在階段間換 options＝深度被 setStockFundamentalsOptionsForTest 歸零，
  // 探針形同虛設。這裡全程**只設定一次**，用 mode 切換 fetch 行為。
  let mode = 'ok';
  let clock = Date.parse('2026-07-30T04:00:00.000Z');
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT, maxQueueDepth: 1, logger: silentLogger,
    // 預算要放得下正常路徑（3 個請求 × 500ms pacing ＝ 1000ms），逾時用「大幅推進時鐘」製造
    now: () => clock, sleep: async (ms) => { clock += ms; }, refreshBudgetMs: 5000,
    fetchImpl: async (url) => {
      const u = String(url);
      if (mode === 'fail') return jsonResponse({ boom: 1 }, 500);
      if (mode === 'timeout' && u.includes('/submissions/')) clock += 6000;   // 吃光預算
      return jsonResponse(fixturePayload(u));
    }
  });
  assert.equal((await (await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).json()).freshness, 'fresh');
  mode = 'fail';
  assert.notEqual((await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' })).status, 503, 'SEC 失敗路徑漏還名額');
  mode = 'timeout';
  await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  mode = 'ok';
  const last = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  assert.equal(last.status, 200, `三條路徑任一漏還名額＝這裡 503：${await last.text()}`);
});

test('headers 到了但 body 還掛著＝名額仍被占用（第二個 refresh 503、不得發出第二個 fetch）', async () => {
  /** @type {ReadableStreamDefaultController|null} */
  let bodyCtrl = null;
  let tickerCalls = 0;
  let signalEntered = () => {};
  const entered = new Promise((resolve) => { signalEntered = () => resolve(undefined); });
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT, maxQueueDepth: 1, timeoutMs: 60000, logger: silentLogger,
    fetchImpl: async (url) => {
      if (String(url).includes('company_tickers')) {
        tickerCalls += 1;
        const body = new ReadableStream({ start(c) { bodyCtrl = c; signalEntered(); } });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return jsonResponse(fixturePayload(String(url)));
    }
  });
  const pendingA = request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  await entered;
  try {
    const b = await request('/api/stock-fundamentals/FRUIT/refresh', { method: 'POST', signal: AbortSignal.timeout(1500) });
    assert.equal(b.status, 503, await b.text());
    assert.equal(tickerCalls, 1, 'body 還掛著就發出第二個 fetch＝深度提早釋放');
  } finally {
    const c = /** @type {any} */ (bodyCtrl);
    if (c) { c.enqueue(new TextEncoder().encode(JSON.stringify(fixture.tickerIndex))); c.close(); }
    await pendingA.catch(() => undefined);
  }
});

test('排隊等待者在總時限到點就得到 504，不必等輪到隊頭', async () => {
  const gate = makeGate();
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT, timeoutMs: 60000, refreshBudgetMs: 400, logger: silentLogger,
    fetchImpl: (url) => String(url).includes('company_tickers')
      ? gate.hold(jsonResponse(fixturePayload(String(url))))
      : Promise.resolve(jsonResponse(fixturePayload(String(url))))
  });
  const pendingA = request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  await gate.entered;
  const startedAt = Date.now();
  try {
    const b = await request('/api/stock-fundamentals/FRUIT/refresh', {
      method: 'POST', signal: AbortSignal.timeout(2500)   // 拆掉 race＝B 掛住＝abort＝紅
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(b.status, 504, await b.text());          // r3：直接斷言狀態碼
    assert.ok(elapsed >= 300, `不可提早回應（下界）：實際 ${elapsed}ms`);
    assert.ok(elapsed < 2000, `要在總時限附近回應、不是等隊頭：實際 ${elapsed}ms`);
  } finally {
    gate.releaseAll();
    await pendingA.catch(() => undefined);
  }
  const viewB = await (await request('/api/stock-fundamentals/FRUIT')).json();
  assert.equal(viewB.lastError?.code, 'sec_timeout');
});

test('已開始讀 body 時到期：abort 必須真的發生，且名額要還回來（全程不重設 options）', () => {
  // Codex #361 r3 blocking：r3 版掛住的是「還沒回 headers」的 fetch＝根本沒進 body 階段；
  // 而且探針前又呼叫 setStockFundamentalsOptionsForTest＝深度被歸零、證明不了名額歸還
  // （與 r2 指出的同一個錯，我在新題裡又犯一次）。r4 兩點都改：
  //   ①真的先回 headers、body 掛住不給資料 ②全程同一組 options，用 mode 切換行為
  let abortSeen = false;
  let mode = 'hang-body';
  let signalEntered = () => {};
  const entered = new Promise((resolve) => { signalEntered = () => resolve(undefined); });
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT, maxQueueDepth: 1, refreshBudgetMs: 300, timeoutMs: 60000,
    logger: silentLogger,
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (mode === 'hang-body' && u.includes('company_tickers')) {
        // headers 立刻回、body 永遠不給資料 ⇒ 確實停在 readResponse（佇列內）
        const body = new ReadableStream({
          start(controller) {
            signalEntered();
            const signal = /** @type {any} */ (init)?.signal;
            signal?.addEventListener('abort', () => {
              abortSeen = true;
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
          }
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return jsonResponse(fixturePayload(u));
    }
  });
  const first = request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  return entered
    .then(() => first)
    .then(async (res) => {
      assert.equal(res.status, 504, await res.text());
      assert.ok(abortSeen, '到期卻沒有 abort＝取消機制被 race 拆掉，body 會永遠掛著、名額永不釋放');
      // ⚠️ 不重設 options：直接用同一組（maxQueueDepth=1）探測名額是否真的還回來了
      mode = 'ok';
      const next = await request('/api/stock-fundamentals/FRUIT/refresh', { method: 'POST' });
      assert.notEqual(next.status, 503,
        `abort 路徑沒有還回名額＝深度永久洩漏：${await next.text()}`);
    });
});

test('每次 retry 都要用「當下剩餘預算」重夾 abort timer（不得沿用第一次算的值）', async () => {
  // Codex #361 r3 突變②：沿用第一次的 effTimeoutMs → 800ms 預算被拖成約 1,304ms。
  let calls = 0;
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT, refreshBudgetMs: 800, timeoutMs: 60000, minIntervalMs: 0,
    logger: silentLogger,
    fetchImpl: async (url, init) => {
      calls += 1;
      if (calls === 1) return jsonResponse({ boom: 1 }, 500);   // 先失敗→進 backoff→第二輪
      return new Promise((_resolve, reject) => {                 // 第二輪掛住，只能靠 abort 收
        const signal = /** @type {AbortSignal} */ (/** @type {any} */ (init)?.signal);
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
  });
  const startedAt = Date.now();
  const response = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  const elapsed = Date.now() - startedAt;
  assert.equal(response.status, 504, await response.text());
  assert.ok(elapsed < 1100, `第二輪沿用初始 timer、總預算被拖長：${elapsed}ms（預算只有 800ms）`);
});

test('retry backoff 也在總預算內：剩 1ms 不得睡滿一輪 backoff', async () => {
  // Codex #361 r2 blocking 2 實測：budget 120ms、上游 90ms 回 500 → 竟然 618ms 才回 504。
  let clock = Date.parse('2026-07-30T05:00:00.000Z');
  let slept = 0;
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT, refreshBudgetMs: 120, logger: silentLogger,
    now: () => clock,
    sleep: async (ms) => { slept += ms; clock += ms; },
    fetchImpl: async (url) => {
      if (String(url).includes('company_tickers')) { clock += 90; return jsonResponse({ boom: 1 }, 500); }
      return jsonResponse(fixturePayload(String(url)));
    }
  });
  const res = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  assert.equal(res.status, 504, await res.text());
  assert.ok(slept <= 30, `backoff 沒有夾進剩餘預算：睡了 ${slept}ms（剩餘只有 30ms）`);
});

test('submissions 呼叫點也受總預算管：ticker 之後 pacing 過線就不得發出 submissions', async () => {
  // Codex #361 r5 blocking：四個 deadlineAt 呼叫點逐一突變，只有 submissions 這點漏傳仍 24/24 全綠
  //（傳 undefined 連 typecheck 都過）。收斂冗餘後每個呼叫點都是單點失效，必須各自有題。
  // 參數關係（實跑校準過，不是推算）：**ticker 耗時 < 預算 ≤ pacing 間隔**
  //   ticker @0 耗 650 → clock 650、nextAt = 0+800 = 800
  //   submissions 進場 @650（650 < 700 ⇒ 第一道放行）→ 睡 150 → @800（≥700）⇒ 只有 submissions
  //   這個呼叫點自己的守門擋得住它
  // ⚠️ 若 ticker 耗時 ≥ 間隔，pacing 等待會歸零、submissions 直接發出——這題就測不到東西（踩過）
  let clock = Date.parse('2026-07-30T07:00:00.000Z');
  let submissionsCalls = 0;
  setStockFundamentalsOptionsForTest({
    userAgent: SEC_USER_AGENT, refreshBudgetMs: 700, minIntervalMs: 800, logger: silentLogger,
    now: () => clock, sleep: async (ms) => { clock += ms; },
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('company_tickers')) { clock += 650; return jsonResponse(fixturePayload(u)); }
      if (u.includes('/submissions/')) submissionsCalls += 1;
      return jsonResponse(fixturePayload(u));
    }
  });
  const refresh = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  assert.equal(submissionsCalls, 0, 'submissions 呼叫點漏傳 deadlineAt＝預算耗盡仍發出（r5 的漏網點）');
  assert.equal(refresh.status, 504, await refresh.text());
  const view = await (await request('/api/stock-fundamentals/CAL')).json();
  assert.equal(view.lastError?.code, 'sec_timeout');
});

test('pacing sleep 把時間推過總時限之後，不得再發出下一個請求（sleep 後要再驗一次）', async () => {
  let clock = Date.parse('2026-07-30T03:00:00.000Z');
  let factsCalls = 0;
  setStockFundamentalsOptionsForTest({
    // ⚠️ 參數要讓「sleep 本身」成為唯一跨線者。實跑時序（budget 700、pacing 600、ticker body 吃 250）：
    //   ticker fetch @0 → clock 250、nextAt 600
    //   submissions 進場 @250（<700 放行）→ 睡 350 → @600（<700 仍放行）→ 發出、nextAt 1200
    //   company-facts 進場 @600（<700，**第一道守門放行**）→ 睡 600 → @1200（≥700）
    //   ⇒ 只有「sleep 後的第二道守門」擋得住 company-facts
    userAgent: SEC_USER_AGENT, refreshBudgetMs: 700, minIntervalMs: 600, logger: silentLogger,
    now: () => clock, sleep: async (ms) => { clock += ms; },
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('company_tickers')) { clock += 250; return jsonResponse(fixturePayload(u)); }
      if (u.includes('/companyfacts/')) factsCalls += 1;
      return jsonResponse(fixturePayload(u));
    }
  });
  const refresh = await request('/api/stock-fundamentals/CAL/refresh', { method: 'POST' });
  assert.equal(factsCalls, 0, 'pacing 睡完已過線還發出 company-facts＝sleep 後沒有再驗');
  assert.equal(refresh.status, 504, await refresh.text());
  const view = await (await request('/api/stock-fundamentals/CAL')).json();
  assert.equal(view.lastError?.code, 'sec_timeout');
});
