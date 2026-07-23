// 證券交易 S2：IB 同步雙寫（ibTrades 鏡像整包取代 vs securityTrades upsert 永不刪）。
// 一致性語意＝「同步窗內 ibTrades ⊆ securityTrades」**而非相等**（S1 複審：期間縮短後筆數必不等）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_STORE = join(tmpdir(), `finance-sec-sync-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { syncIb } = await import('../lib/services/ib-sync.js');
const { getDb, saveDb, getSettings, updateSettings } = await import('../lib/repo.js');

after(() => { for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 不存在 */ } } });

updateSettings({ ib: { flexToken: 'test-token', flexQueryId: 'q1' } });
assert.ok(getSettings().ib);

/** 合成 Flex 原始 Trade 屬性（假帳號 U9990001）。 @param {object} extra */
const raw = (extra) => ({ accountId: 'U9990001', tradeDate: '2026-01-13', settleDateTarget: '2026-01-15',
  symbol: 'CSPX', description: 'ISHARES', buySell: 'BUY', quantity: 10, tradePrice: 800, tradeMoney: 8000,
  netCash: -8005, ibCommission: -5, taxes: 0, currency: 'USD', listingExchange: 'LSEETF', ...extra });

/** 合成 syncIb 注入資料（只餵 trades/rawTrades，其他區塊最小化）。 @param {any[]} rawTrades @param {any[]} trades */
const feed = (rawTrades, trades) => async () => ({
  positions: [], cashByCurrency: {}, hasCashReport: false, hasCashDetail: false, cashDetailIncomplete: false,
  baseCurrency: 'USD', baseSummaryCash: null, statementCount: 1, accountCount: 1,
  equity: null, income: null, trades, rawTrades, period: { from: '2026-01-01', to: '2026-01-31' },
});

const T1 = raw({ transactionID: 'TXN-1' });
const T2 = raw({ buySell: 'SELL', quantity: -5, netCash: 3990, transactionID: '', tradeID: '', ibExecID: 'EX-2', symbol: 'EIMI' });
const CANCEL = raw({ buySell: 'BUY (Ca.)', transactionID: 'TXN-9' });
const lean = (/** @type {any} */ t) => ({ symbol: t.symbol, date: t.tradeDate, buySell: t.buySell, quantity: t.quantity, price: t.tradePrice, netCash: t.netCash, pnl: 0, currency: t.currency, fxRateToBase: 1, pnlBase: 0 });

test('首次同步：正常列入庫、取消列跳過＋回報；ibTrades 鏡像照舊整包；同步窗 ⊆ 成立', async () => {
  const r = await syncIb(feed([T1, T2, CANCEL], [T1, T2, CANCEL].map(lean)));
  assert.equal(r.secTradesAdded, 2);
  assert.equal(r.secTradesSkipped, 1, 'BUY (Ca.) 取消列不入查帳集合');
  const db = getDb();
  assert.equal(db.securityTrades.length, 2);
  assert.equal(db.ibTrades.length, 3, '鏡像維持既有整包取代語意（含取消列，交易摘要/XIRR 口徑不動）');
  const sec = db.securityTrades.find((/** @type {any} */ x) => x.symbol === 'CSPX');
  assert.equal(sec.sourceRef, 'ib|txn|TXN-1', '官方識別碼 identifier-first');
  assert.equal(sec.side, 'buy');
  assert.equal(sec.cashDirection, 'out');
  assert.equal(sec.netSettlement, 8005, '絕對值＋方向分離');
  assert.equal(sec.settlementDate, '2026-01-15', 'Flex settleDateTarget 有值就帶入（藍圖以為只能留空）');
  const eimi = db.securityTrades.find((/** @type {any} */ x) => x.symbol === 'EIMI');
  assert.equal(eimi.sourceRef, 'ib|exe|EX-2');
  assert.equal(eimi.quantity, 5, '負數量取絕對值、方向看 side');
  assert.ok(!JSON.stringify(db.securityTrades).includes('U9990001'), '不落帳號原文（只有指紋＋遮罩 label）');
});

test('重同步同窗：0 新增、就地更新（冪等）；importBatch/importedAt 保留首次', async () => {
  const before = getDb().securityTrades.find((/** @type {any} */ x) => x.symbol === 'CSPX');
  const r = await syncIb(feed([{ ...T1, tradePrice: 810 }, T2], [T1, T2].map(lean)));
  assert.equal(r.secTradesAdded, 0);
  assert.equal(r.secTradesUpdated, 2);
  const after2 = getDb().securityTrades.find((/** @type {any} */ x) => x.symbol === 'CSPX');
  assert.equal(after2.price, 810, '重疊期間以來源最新值更新');
  assert.equal(after2.importBatch, before.importBatch, '批次歸屬保留首次');
});

test('期間縮短：securityTrades 永不刪（查帳歷史保留）；同步窗 ⊆ 而非相等', async () => {
  const r = await syncIb(feed([T1], [lean(T1)]));
  assert.equal(r.secTradesAdded, 0);
  const db = getDb();
  assert.equal(db.ibTrades.length, 1, '鏡像縮成本窗');
  assert.equal(db.securityTrades.length, 2, '共同集合保留歷史（EIMI 還在）');
  // ⊆：本窗鏡像的每一筆都能在共同集合找到對應
  for (const t of db.ibTrades) {
    assert.ok(db.securityTrades.some((/** @type {any} */ s) => s.symbol === String(t.symbol).toUpperCase() && s.tradeDate === t.date), `鏡像列 ${t.symbol} 必在共同集合`);
  }
});

test('退路指紋（無官方識別碼）：跨批 ref 穩定（|#1 恆在）、重同步不長幽靈', async () => {
  const NOID = raw({ symbol: 'VT', transactionID: '', tradeID: '', ibExecID: '', tradeDate: '2026-01-20' });
  await syncIb(feed([NOID], [lean(NOID)]));
  const ref1 = getDb().securityTrades.find((/** @type {any} */ x) => x.symbol === 'VT').sourceRef;
  assert.match(ref1, /^ib\|fp\|.*\|#1$/, '唯一退路指紋也帶 |#1（跨批穩定）');
  const r = await syncIb(feed([NOID], [lean(NOID)]));
  assert.equal(r.secTradesAdded, 0, '同一筆不因重同步變幽靈');
  assert.equal(getDb().securityTrades.filter((/** @type {any} */ x) => x.symbol === 'VT').length, 1);
});

test('缺帳戶識別的原始列：跳過＋回報，不用空指紋入庫（防跨帳戶互撞去重）', async () => {
  const NOACCT = raw({ accountId: '', symbol: 'QQQ', transactionID: 'TXN-7' });
  const r = await syncIb(feed([NOACCT], [lean(NOACCT)]));
  assert.equal(r.secTradesAdded, 0);
  assert.equal(r.secTradesSkipped, 1);
  assert.ok(!getDb().securityTrades.some((/** @type {any} */ x) => x.symbol === 'QQQ'));
});

test('櫃檯守門：同步寫入的列經 saveDb 往返仍完整（schema 型別/必填全過）', () => {
  const db = getDb();
  const count = db.securityTrades.length;
  saveDb(db);   // 再過一次寫入牆
  assert.equal(getDb().securityTrades.length, count, '合法列不被櫃檯濾除');
});

test('幣別牆：IB 不支援幣別（EUR）成交 → 跳過＋回報，不讓櫃檯枚舉驗證炸掉整次同步', async () => {
  const EUR = raw({ symbol: 'DAX1', currency: 'EUR', transactionID: 'TXN-EUR' });
  const r = await syncIb(feed([EUR], [lean(EUR)]));
  assert.equal(r.secTradesAdded, 0);
  assert.ok(r.secTradesSkipped >= 1);
  assert.ok(!getDb().securityTrades.some((/** @type {any} */ x) => x.symbol === 'DAX1'));
});
