// 崩潰安全與健壯性考題（自審 3/3）：原子存檔、統一錯誤處理、報價端點在 store 壞時不拖垮程式。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/store.json。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { once } from 'node:events';

const TEST_STORE = join(tmpdir(), `finance-robust-${process.pid}.json`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
  for (const f of [TEST_STORE, TEST_STORE + '.bak', TEST_STORE + '.tmp']) { try { rmSync(f); } catch { /* 可能不存在 */ } }
});

test('原子存檔：save() 後檔案是完整合法 JSON，且不留 .tmp', () => {
  store.save({ ...store.emptyDb(), marker: 'atomic-test' });
  const raw = readFileSync(TEST_STORE, 'utf8');
  const parsed = JSON.parse(raw);   // 不可為半截壞檔
  assert.equal(parsed.marker, 'atomic-test');
  assert.ok(!existsSync(TEST_STORE + '.tmp'), 'rename 後不該殘留暫存檔');
});

test('統一錯誤處理：壞的 JSON body → 乾淨 JSON 400，不洩漏伺服器路徑', async () => {
  const res = await fetch(base + '/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
  });
  assert.equal(res.status, 400);
  const ct = res.headers.get('content-type') || '';
  assert.ok(ct.includes('application/json'), '應回 JSON 而非 HTML 堆疊');
  const body = await res.text();
  assert.ok(!/node_modules|server\.js|\/Users\//.test(body), '不可洩漏伺服器檔案路徑');
});

test('IB 同步幣別牆（Codex#7）：未支援幣別跳過並回報，不寫進資料', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  const fake = async () => ({
    positions: [
      { symbol: 'CSPX', currency: 'USD', quantity: 10, marketPrice: 500, avgCost: 480 },
      { symbol: 'VWCE', currency: 'EUR', quantity: 5, marketPrice: 100, avgCost: 90 },   // 未支援 → 跳過
    ],
    cashByCurrency: { USD: 1000, EUR: 200 },   // EUR 現金 → 跳過
    equity: { stock: 5000, cash: 1000 }, income: null, trades: [], account: 'TEST', period: {},
  });
  const r = await syncIb(/** @type {any} */ (fake));
  assert.deepEqual(r.skippedCurrencies, ['VWCE(EUR)', '現金(EUR)'], '未支援幣別要明確回報');
  const db = JSON.parse(readFileSync(TEST_STORE, 'utf8'));
  assert.ok(!db.holdings.some((h) => h.symbol === 'VWCE'), 'EUR 持股不可寫入（會被錯誤匯率計價）');
  assert.ok(db.holdings.some((h) => h.symbol === 'CSPX' && h.currency === 'USD'), 'USD 持股照常同步');
  assert.ok(!db.accounts.some((a) => a.ibCashCur === 'EUR'), 'EUR 現金帳戶不可建立');
  assert.ok(db.accounts.some((a) => a.ibCashCur === 'USD' && a.balance === 1000), 'USD 現金照常更新');
});

test('報價端點在 store 損毀時不拖垮程式（回退而非未處理例外）', async () => {
  writeFileSync(TEST_STORE, '{ 這不是合法 JSON');   // 故意弄壞 store
  const res = await fetch(base + '/api/cape');       // 離線→外部抓取失敗→走 fallback（會讀 settings）
  assert.equal(res.status, 200, '即使 store 壞掉也要優雅回應、而非 crash/hang');
  const j = await res.json();
  assert.ok('value' in j);
  store.save(store.emptyDb());   // 修復 store 給後續（本檔）用
});
