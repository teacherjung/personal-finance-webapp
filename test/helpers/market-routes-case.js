import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { request } from 'node:http';
import { once } from 'node:events';

// 只替換服務出口；Express 解析、正式路由及 server.js 的錯誤中介從真來源載入。
// real 案不替換服務，fetch 只回合成上游資料；不對真實 App 或外部服務送請求。
async function runCase(scenario) {
  const calls = [], outbound = [];
  let failure = null, upstreamFails = true, requests = 0, hook;
  const values = { getCape: { t: 1, value: 18, source: 'synthetic' }, getRealYield: { t: 2, value: 1.5, date: '2026-10-01', source: 'synthetic' } };
  const methods = ['getQuotes', 'getCape', 'getRealYield', 'refreshQuotesIfStale', 'getInsights'];
  globalThis.__marketRouteFixture = { async invoke(name, args) {
    calls.push({ name, args });
    if (failure?.name === name) throw Object.assign(new Error('synthetic market failure'), failure.status ? { status: failure.status } : {});
    return name === 'getQuotes' ? { received: args[0] } : structuredClone(values[name]);
  } };
  if (scenario !== 'real') {
    const marketUrl = new URL('../../lib/services/market-data.js', import.meta.url).href;
    const insightsUrl = new URL('../../lib/services/insights.js', import.meta.url).href;
    hook = registerHooks({ load(url, context, nextLoad) {
      if (url !== marketUrl && url !== insightsUrl) return nextLoad(url, context);
      const names = url === marketUrl ? methods.filter(name => name !== 'getInsights') : ['getInsights'];
      return { format: 'module', shortCircuit: true, source: names.map(name => `export async function ${name}(...args) { return globalThis.__marketRouteFixture.invoke('${name}', args); }`).join('\n') };
    } });
  }
  globalThis.fetch = async input => {
    const url = String(input); outbound.push(url);
    if (upstreamFails) throw new Error('synthetic upstream unavailable');
    if (url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/')) return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 123.5, currency: 'USD' } }] } }));
    if (url === 'https://www.multpl.com/shiller-pe') return new Response('<div id="current">12.34</div>');
    if (url === 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10') return new Response('observation_date,DFII10\n2026-10-01,1.25\n');
    throw new Error('unexpected synthetic upstream URL');
  };
  const { app } = await import('../../server.js');
  assert.equal(app.get('query parser'), 'extended');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const call = (path, method = 'GET') => new Promise((resolve, reject) => {
    requests++;
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, agent: false, signal: AbortSignal.timeout(5000) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          assert.match(res.headers['content-type'] ?? '', /application\/json/);
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end();
  });
  const healthy = async () => {
    const r = await call('/api/quotes');
    assert.deepEqual(r, { status: 200, body: { received: [] } });
    assert.deepEqual(calls.at(-1), { name: 'getQuotes', args: [[]] });
  };
  try {
    if (scenario === 'input') {
      const inputs = [
        ['', []], ['?symbols=', []], ['?symbols=%20%2C%2C%20', []],
        ['?symbols=AAPL%2C%20TWD%3DX%2C%2CQQQ', ['AAPL', 'TWD=X', 'QQQ']],
        ['?symbols=AAPL%2CMSFT&symbols=%20QQQ%20', ['AAPL', 'MSFT', 'QQQ']],
        ['?symbols[]=AAPL&symbols[]=QQQ%2CMSFT', ['AAPL', 'QQQ', 'MSFT']],
        ['?symbols[2]=AAPL', ['AAPL']],
        ['?symbols=__proto__%2Cconstructor%2CtoString%2Cbrk-b', ['__proto__', 'constructor', 'toString', 'brk-b']],
      ];
      for (const [query, expected] of inputs) {
        const before = calls.length, r = await call('/api/quotes' + query);
        assert.deepEqual(r, { status: 200, body: { received: expected } }, query);
        assert.equal(calls.length, before + 1);
        assert.deepEqual(calls.at(-1), { name: 'getQuotes', args: [expected] });
      }
      for (const [path, name] of [['cape', 'getCape'], ['realyield', 'getRealYield']]) {
        assert.deepEqual(await call('/api/' + path), { status: 200, body: values[name] });
        assert.deepEqual(calls.at(-1), { name, args: [] });
      }
    } else if (scenario === 'invalid') {
      for (const query of ['symbols[toString]=1', 'symbols[x]=AAPL', 'symbols[0][x]=AAPL', 'symbols[0][0]=AAPL', 'symbols=AAPL&symbols[x]=QQQ']) {
        const before = calls.length;
        assert.deepEqual(await call('/api/quotes?' + query), { status: 400, body: { error: '請求格式不正確' } }, query);
        assert.equal(calls.length, before, '異常形狀不得先呼叫市場服務；核對 lib/routes/market.js；重跑 node --test test/market-routes.test.js');
        await healthy();
      }
    } else if (scenario.startsWith('reject-')) {
      const path = scenario.slice('reject-'.length);
      const name = { quotes: 'getQuotes', cape: 'getCape', realyield: 'getRealYield' }[path];
      assert.ok(name);
      for (const status of [undefined, 400]) {
        failure = { name, status }; const before = calls.length;
        const r = await call('/api/' + path);
        assert.deepEqual(r, { status: status ?? 500, body: { error: status ? '請求格式不正確' : 'synthetic market failure' } });
        assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).name, name);
        failure = null;
        const recovered = await call('/api/' + path);
        assert.deepEqual(recovered, { status: 200, body: name === 'getQuotes' ? { received: [] } : values[name] });
        await healthy();
      }
    } else if (scenario === 'downgrade') {
      failure = { name: 'refreshQuotesIfStale' };
      assert.deepEqual(await call('/api/quotes/refresh-auto', 'POST'), { status: 200, body: { refreshed: false, updated: 0, reason: 'error', error: 'synthetic market failure' } });
      assert.deepEqual(calls.at(-1), { name: failure.name, args: [] });
      failure = { name: 'getInsights' };
      assert.deepEqual(await call('/api/insights'), { status: 200, body: { firstRun: true, calm: true, reminders: { new: [], cleared: [], ongoing: [], all: [] }, tierChanges: [], sinceLast: null, windows: { today: null, week: null }, error: 'synthetic market failure' } });
      assert.deepEqual(calls.at(-1), { name: failure.name, args: [] });
      failure = null; await healthy();
    } else {
      assert.equal(scenario, 'real');
      const { getDb, updateSettings } = await import('../../lib/repo.js');
      for (const [cape, realYield] of [[null, null], [17.25, -0.5]]) {
        await updateSettings({ capeManual: cape, signals: { realYieldManual: realYield } });
        const before = structuredClone(await getDb()), start = outbound.length;
        assert.deepEqual(await call('/api/quotes'), { status: 200, body: {} });
        assert.equal(outbound.length, start);
        assert.deepEqual(await call('/api/quotes?symbols=TEST'), { status: 200, body: { TEST: null } });
        for (const [path, value] of [['cape', cape], ['realyield', realYield]]) {
          const r = await call('/api/' + path);
          assert.equal(r.status, 200); assert.equal(r.body.value, value); assert.equal(r.body.source, 'manual'); assert.equal(typeof r.body.t, 'number');
        }
        assert.equal(outbound.length, start + 3);
        assert.deepEqual(await getDb(), before, '核對唯讀市場查詢不得回寫本題設定及持倉；重跑 node --test test/market-routes.test.js');
      }
      upstreamFails = false;
      const before = structuredClone(await getDb()), start = outbound.length;
      const quote = await call('/api/quotes?symbols=TEST');
      assert.equal(quote.status, 200); assert.equal(quote.body.TEST.price, 123.5); assert.equal(quote.body.TEST.currency, 'USD');
      const cape = await call('/api/cape'), realYield = await call('/api/realyield');
      assert.equal(cape.status, 200); assert.equal(cape.body.value, 12.34); assert.equal(cape.body.source, 'multpl.com');
      assert.equal(realYield.status, 200); assert.equal(realYield.body.value, 1.25); assert.equal(realYield.body.source, 'FRED DFII10'); assert.equal(realYield.body.date, '2026-10-01');
      assert.equal(outbound.length, start + 3); assert.deepEqual(await getDb(), before);
    }
    if (scenario !== 'real') assert.deepEqual(outbound, []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    hook?.deregister();
    delete globalThis.__marketRouteFixture;
  }
  console.log('MARKET_ROUTE_RESULT ' + JSON.stringify({ scenario, requests, closed: !server.listening }));
}
if (process.env.MARKET_ROUTE_CASE) await runCase(process.env.MARKET_ROUTE_CASE);
