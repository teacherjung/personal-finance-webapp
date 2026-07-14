// 崩潰安全與健壯性考題（自審 3/3＋B3 SQLite）：交易寫入、統一錯誤處理、
// IB 同步幣別牆、舊資料自動搬家、櫃檯級驗證（驗證入櫃檯）。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const TEST_STORE = join(tmpdir(), `finance-robust-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const store = await import('../lib/store.js');
const { app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

test('SQLite 存讀：save→load 完整往返、交易式寫入（B3）', () => {
  const dbObj = { ...store.emptyDb(), history: [{ id: 'm1', month: '2026-07', amount: 42 }] };
  store.save(dbObj);
  const back = store.load();
  assert.equal(back.history?.[0]?.amount, 42, '寫進 SQLite 再讀回要一致');
  assert.ok(Array.isArray(back.transactions), '缺的集合讀回為空陣列');
});

test('驗證入櫃檯（B3）：任何路徑寫入非法枚舉 → save() 當場 throw（結構性堵死「繞過牆」）', () => {
  const bad = { ...store.emptyDb(), subscriptions: [{ id: 'x', name: 'bad', amount: 1200, cycle: 'yearlyy' }] };
  assert.throws(() => store.save(bad), /cycle/, '非法 cycle 必須在唯一寫入口被攔下');
  const bad2 = { ...store.emptyDb(), accounts: [{ id: 'y', name: 'z', type: 'mortgagex', balance: 100 }] };
  assert.throws(() => store.save(bad2), /type/, '非法 accounts.type 必須被攔下');
});

test('驗證入櫃檯：非物件元素在寫入口被濾除（不用等匯入端記得清）', () => {
  const dirty = { ...store.emptyDb(), holdings: [null, { id: 'h1', symbol: 'CSPX', currency: 'USD', quantity: 1, price: 10 }, 'junk'] };
  store.save(/** @type {any} */ (dirty));
  const back = store.load();
  assert.equal(back.holdings.length, 1, '非物件元素應被濾掉');
  assert.equal(back.holdings[0].symbol, 'CSPX');
});

test('舊資料自動搬家（B3）：store.json → SQLite，資料完整、原 json 保留', () => {
  // 用子行程跑（搬家只在開檔時檢查一次；本行程的資料庫已開啟）
  const dbPath = join(tmpdir(), `finance-migrate-${process.pid}.db`);
  const jsonPath = dbPath.slice(0, -3) + '.json';
  const legacy = { ...store.emptyDb(), history: [{ id: 'mig1', month: '2026-06', amount: 777 }] };
  writeFileSync(jsonPath, JSON.stringify(legacy));
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { load } from '${ROOT.replace(/'/g, "\\'")}/lib/store.js';
      const db = load();
      console.log(JSON.stringify({ amount: db.history?.[0]?.amount, count: db.history?.length }));
    `], { env: { ...process.env, STORE_FILE: dbPath }, encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop() || '{}');
    assert.equal(r.amount, 777, '舊 json 的資料要完整搬進 SQLite');
    assert.equal(readFileSync(jsonPath, 'utf8').includes('777'), true, '原 store.json 保留不動（備份）');
  } finally {
    for (const f of [dbPath, dbPath + '.bak', dbPath + '-wal', dbPath + '-shm', jsonPath]) { try { rmSync(f); } catch { /* 可能不存在 */ } }
  }
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
  const db = store.load();
  assert.ok(!(db.holdings || []).some((h) => h.symbol === 'VWCE'), 'EUR 持股不可寫入（會被錯誤匯率計價）');
  assert.ok((db.holdings || []).some((h) => h.symbol === 'CSPX' && h.currency === 'USD'), 'USD 持股照常同步');
  assert.ok(!(db.accounts || []).some((a) => a.ibCashCur === 'EUR'), 'EUR 現金帳戶不可建立');
  assert.ok((db.accounts || []).some((a) => a.ibCashCur === 'USD' && a.balance === 1000), 'USD 現金照常更新');
});

test('市場端點防崩：/api/cape 一律優雅回應（外部失敗走手動值退路）', async () => {
  const res = await fetch(base + '/api/cape');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok('value' in j);
});
