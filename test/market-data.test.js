// 市場資料服務＋開 app 自動刷新報價（D1）考題。fetch 注入（不打真外部）；refreshQuotesIfStale 用 STORE_FILE 隔離。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-market-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { getQuotes, refreshQuotesIfStale } = await import('../lib/services/market-data.js');
const { getDb, saveDb } = await import('../lib/repo.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

/** 假 fetch：url 帶 chart/<sym> → 回該 sym 的 meta；值＝'throw' 丟例外、undefined 回空（→null）。 @param {Record<string,any>} quotes */
const makeFetch = (quotes) => async (/** @type {string} */ url) => {
  const m = String(url).match(/chart\/([^?]+)/);
  const sym = m ? decodeURIComponent(m[1]) : '';
  const entry = quotes[sym];
  if (entry === 'throw') throw new Error('network down');
  if (entry === undefined) return /** @type {any} */ ({ json: async () => ({}) });
  return /** @type {any} */ ({ json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: entry.price, currency: entry.currency } }] } }) });
};

/** 種入隔離庫。共用 STORE_FILE，故未指定 quotesLastAt 時**清掉**（否則上一題寫的會外洩讓下一題誤判 fresh）。
 * @param {any[]} holdings @param {any} settings */
const seedDb = (holdings, settings = {}) => {
  const db = getDb();
  db.holdings = holdings;
  db.settings = { ...db.settings, ...settings };
  if (!('quotesLastAt' in settings)) delete db.settings.quotesLastAt;
  saveDb(db);
};

// ---------- getQuotes ----------
test('getQuotes：解析 regularMarketPrice＋幣別；GBp→英鎊÷100；缺 meta／抓失敗→null', async () => {
  const fetchImpl = makeFetch({ AAPL: { price: 150, currency: 'USD' }, LON: { price: 500, currency: 'GBp' }, BAD: 'throw' });
  const q = await getQuotes(['AAPL', 'LON', 'BAD', 'MISSING'], { fetchImpl, ttlMs: 0 });
  assert.equal(q.AAPL.price, 150); assert.equal(q.AAPL.currency, 'USD');
  assert.equal(q.LON.price, 5); assert.equal(q.LON.currency, 'GBP');   // 便士→英鎊
  assert.equal(q.BAD, null);
  assert.equal(q.MISSING, null);
});

// ---------- refreshQuotesIfStale ----------
test('refreshQuotesIfStale：報價舊 → 更新持股報價＋匯率＋寫 quotesLastAt', async () => {
  seedDb([{ id: 'h1', symbol: 'VOO', quoteSymbol: 'VOO', currency: 'USD', price: 400, quantity: 10 }], { usdTwd: 30 });
  const fetchImpl = makeFetch({
    VOO: { price: 500, currency: 'USD' }, 'TWD=X': { price: 32.5, currency: '' },
    'GBPTWD=X': { price: 41, currency: '' }, 'JPYTWD=X': { price: 0.22, currency: '' },
  });
  const r = await refreshQuotesIfStale({ fetchImpl, now: Date.parse('2026-07-21T10:00:00Z'), quoteTtlMs: 0 });
  assert.equal(r.refreshed, true); assert.equal(r.updated, 1);
  const db = getDb();
  assert.equal(db.holdings[0].price, 500);
  assert.equal(db.settings.usdTwd, 32.5);
  assert.equal(db.settings.fxTwd.GBP, 41);
  assert.equal(db.settings.quotesLastAt, '2026-07-21T10:00:00.000Z');
});

test('refreshQuotesIfStale：報價 <1 小時新 → 跳過、不動價（fresh）', async () => {
  seedDb([{ id: 'h1', symbol: 'VOO', quoteSymbol: 'VOO', currency: 'USD', price: 400, quantity: 10 }],
    { quotesLastAt: '2026-07-21T09:30:00.000Z' });
  const fetchImpl = makeFetch({ VOO: { price: 999, currency: 'USD' } });
  const r = await refreshQuotesIfStale({ fetchImpl, now: Date.parse('2026-07-21T10:00:00Z'), quoteTtlMs: 0 });
  assert.equal(r.refreshed, false); assert.equal(r.reason, 'fresh');
  assert.equal(getDb().holdings[0].price, 400);
});

test('refreshQuotesIfStale：報價幣別與持股不符 → 略過該筆（不亂改台股價）', async () => {
  seedDb([{ id: 'h1', symbol: '2330', quoteSymbol: '2330.TW', currency: 'TWD', price: 600, quantity: 1000 }], {});
  const fetchImpl = makeFetch({
    '2330.TW': { price: 5, currency: 'GBp' }, 'TWD=X': { price: 32, currency: '' },
    'GBPTWD=X': { price: 41, currency: '' }, 'JPYTWD=X': { price: 0.22, currency: '' },
  });
  const r = await refreshQuotesIfStale({ fetchImpl, now: Date.parse('2026-07-21T10:00:00Z'), quoteTtlMs: 0 });
  assert.equal(getDb().holdings[0].price, 600);   // 幣別不符 → 不動
  assert.ok((r.skipped || 0) >= 1);
});

test('refreshQuotesIfStale：全抓不到 → 保留舊價、不寫 quotesLastAt（下次開再試，失敗靜默）', async () => {
  seedDb([{ id: 'h1', symbol: 'ZZZ', quoteSymbol: 'ZZZ', currency: 'USD', price: 400, quantity: 10 }], {});
  const fetchImpl = makeFetch({});   // 全部回空 → null
  const r = await refreshQuotesIfStale({ fetchImpl, now: Date.parse('2026-07-21T10:00:00Z'), quoteTtlMs: 0 });
  assert.equal(r.refreshed, false); assert.equal(r.reason, 'no-data');
  const db = getDb();
  assert.equal(db.holdings[0].price, 400);
  assert.equal(db.settings.quotesLastAt, undefined);
});

test('refreshQuotesIfStale：持股都沒 quoteSymbol → 只更新匯率，updated:0 但 refreshed:true（前端據此重繪外幣估值）', async () => {
  seedDb([{ id: 'h1', symbol: 'CASHUSD', currency: 'USD', price: 0, quantity: 0 }], {});   // 無 quoteSymbol
  const fetchImpl = makeFetch({ 'TWD=X': { price: 31, currency: '' }, 'GBPTWD=X': { price: 40, currency: '' }, 'JPYTWD=X': { price: 0.2, currency: '' } });
  const r = await refreshQuotesIfStale({ fetchImpl, now: Date.parse('2026-07-21T10:00:00Z'), quoteTtlMs: 0 });
  assert.equal(r.refreshed, true); assert.equal(r.updated, 0);
  assert.equal(getDb().settings.usdTwd, 31);
});

test('refreshQuotesIfStale：持股超過 40 檔也不會把匯率擠掉（FX 放最前、優先抓；對抗審查 D1）', async () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ id: 'h' + i, symbol: 'S' + i, quoteSymbol: 'SYM' + i, currency: 'USD', price: 1, quantity: 1 }));
  seedDb(many, {});
  /** @type {Record<string,any>} */
  const quotesMap = { 'TWD=X': { price: 33, currency: '' }, 'GBPTWD=X': { price: 40, currency: '' }, 'JPYTWD=X': { price: 0.2, currency: '' } };
  for (let i = 0; i < 45; i++) quotesMap['SYM' + i] = { price: 2, currency: 'USD' };
  const fetchImpl = makeFetch(quotesMap);
  const r = await refreshQuotesIfStale({ fetchImpl, now: Date.parse('2026-07-21T10:00:00Z'), quoteTtlMs: 0 });
  assert.equal(getDb().settings.usdTwd, 33);   // 匯率有被抓到（沒被 40 檔上限砍掉）
  assert.equal(r.updated, 37);   // 40 檔上限＝3 FX＋37 持股
});

test('refreshQuotesIfStale：抓取整個丟例外 → 不擋、回 fetch-failed、保留舊價', async () => {
  seedDb([{ id: 'h1', symbol: 'VOO', quoteSymbol: 'VOO', currency: 'USD', price: 400, quantity: 10 }], {});
  const fetchImpl = async () => { throw new Error('offline'); };
  const r = await refreshQuotesIfStale({ fetchImpl, now: Date.parse('2026-07-21T10:00:00Z'), quoteTtlMs: 0 });
  // getQuotes 內部每檔各自 try/catch → 回全 null → no-data（不會拋到 refreshQuotesIfStale 的 catch）
  assert.equal(r.refreshed, false);
  assert.equal(getDb().holdings[0].price, 400);
});

test('refreshQuotesIfStale：報價期間的並發寫入不被 await 前的舊快照覆蓋（Codex r13#1，高）', async () => {
  seedDb([{ id: 'h1', symbol: 'VOO', quoteSymbol: 'VOO', currency: 'USD', price: 400, quantity: 10 }], { quotesLastAt: '' });
  // 假 fetch：在「網路等待期間」模擬另一條路徑（開 app 同時跑的店名整理/記帳）寫入一筆交易。
  // 舊碼在 await 前 getDb()、await 後拿那份舊快照整包寫回 → 這筆會消失；新碼 await 後重讀才寫 → 存活。
  let injected = false;
  const q = { 'TWD=X': { price: 32, currency: 'TWD' }, 'VOO': { price: 680, currency: 'USD' } };
  const fetchImpl = async (/** @type {string} */ url) => {
    if (!injected) {
      injected = true;
      const d = getDb();
      d.transactions = [...(d.transactions || []), { id: 'concurrent', type: 'expense', category: '生活', subcategory: '外食', amount: 50, date: '2026-06-01', ledger: 'cashflow' }];
      saveDb(d);
    }
    return makeFetch(q)(url);
  };
  const r = await refreshQuotesIfStale({ fetchImpl, quoteTtlMs: 0 });
  assert.equal(r.refreshed, true);
  const after = getDb();
  assert.ok(after.transactions?.find(t => t.id === 'concurrent'), '報價期間新增的交易必須存活（不被 await 前的舊 db 覆蓋）');
  assert.equal(after.holdings.find(h => h.symbol === 'VOO').price, 680, '報價仍有更新');
  assert.equal(after.settings.usdTwd, 32);
});
