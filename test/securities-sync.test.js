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
const { accountFingerprint } = await import('../lib/services/security-trades.js');
const { parseStatement } = await import('../lib/ib.js');
const FP = accountFingerprint('U9990001');

after(() => { for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 不存在 */ } } });

await updateSettings({ ib: { flexToken: 'test-token', flexQueryId: 'q1' } });
assert.ok((await getSettings()).ib);

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
  const db = await getDb();
  assert.equal(db.securityTrades.length, 2);
  assert.equal(db.ibTrades.length, 3, '鏡像維持既有整包取代語意（含取消列，交易摘要/XIRR 口徑不動）');
  const sec = db.securityTrades.find((/** @type {any} */ x) => x.symbol === 'CSPX');
  assert.equal(sec.sourceRef, `ib|txn|${FP}|TXN-1`, '官方識別碼 identifier-first（含帳戶指紋段）');
  assert.equal(sec.side, 'buy');
  assert.equal(sec.cashDirection, 'out');
  assert.equal(sec.netSettlement, 8005, '絕對值＋方向分離');
  assert.equal(sec.settlementDate, '2026-01-15', 'Flex settleDateTarget 有值就帶入（藍圖以為只能留空）');
  const eimi = db.securityTrades.find((/** @type {any} */ x) => x.symbol === 'EIMI');
  assert.equal(eimi.sourceRef, `ib|exe|${FP}|EX-2`);
  assert.equal(eimi.quantity, 5, '負數量取絕對值、方向看 side');
  assert.ok(!JSON.stringify(db.securityTrades).includes('U9990001'), '不落帳號原文（只有指紋＋遮罩 label）');
});

test('重同步同窗：0 新增、就地更新（冪等）；importBatch/importedAt 保留首次', async () => {
  const before = (await getDb()).securityTrades.find((/** @type {any} */ x) => x.symbol === 'CSPX');
  const r = await syncIb(feed([{ ...T1, tradePrice: 810 }, T2], [T1, T2].map(lean)));
  assert.equal(r.secTradesAdded, 0);
  assert.equal(r.secTradesUpdated, 2);
  const after2 = (await getDb()).securityTrades.find((/** @type {any} */ x) => x.symbol === 'CSPX');
  assert.equal(after2.price, 810, '重疊期間以來源最新值更新');
  assert.equal(after2.importBatch, before.importBatch, '批次歸屬保留首次');
});

test('期間縮短：securityTrades 永不刪（查帳歷史保留）；同步窗 ⊆ 而非相等', async () => {
  const r = await syncIb(feed([T1], [lean(T1)]));
  assert.equal(r.secTradesAdded, 0);
  const db = await getDb();
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
  const ref1 = (await getDb()).securityTrades.find((/** @type {any} */ x) => x.symbol === 'VT').sourceRef;
  assert.match(ref1, /^ib\|fp\|.*\|#1$/, '唯一退路指紋也帶 |#1（跨批穩定）');
  const r = await syncIb(feed([NOID], [lean(NOID)]));
  assert.equal(r.secTradesAdded, 0, '同一筆不因重同步變幽靈');
  assert.equal((await getDb()).securityTrades.filter((/** @type {any} */ x) => x.symbol === 'VT').length, 1);
});

test('缺帳戶識別的原始列：跳過＋回報，不用空指紋入庫（防跨帳戶互撞去重）', async () => {
  const NOACCT = raw({ accountId: '', symbol: 'QQQ', transactionID: 'TXN-7' });
  const r = await syncIb(feed([NOACCT], [lean(NOACCT)]));
  assert.equal(r.secTradesAdded, 0);
  assert.equal(r.secTradesSkipped, 1);
  assert.ok(!(await getDb()).securityTrades.some((/** @type {any} */ x) => x.symbol === 'QQQ'));
});

test('櫃檯守門：同步寫入的列經 saveDb 往返仍完整（schema 型別/必填全過）', async () => {
  const db = await getDb();
  const count = db.securityTrades.length;
  await saveDb(db);   // 再過一次寫入牆
  assert.equal((await getDb()).securityTrades.length, count, '合法列不被櫃檯濾除');
});

test('幣別牆：IB 不支援幣別（EUR）成交 → 跳過＋回報，不讓櫃檯枚舉驗證炸掉整次同步', async () => {
  const EUR = raw({ symbol: 'DAX1', currency: 'EUR', transactionID: 'TXN-EUR' });
  const r = await syncIb(feed([EUR], [lean(EUR)]));
  assert.equal(r.secTradesAdded, 0);
  assert.ok(r.secTradesSkipped >= 1);
  assert.ok(!(await getDb()).securityTrades.some((/** @type {any} */ x) => x.symbol === 'DAX1'));
});

test('自審根治｜IB 視窗位移：同指紋兩筆（僅手續費異）→ 位移後只剩一筆時不覆寫另一筆、不長孤兒', async () => {
  const A = raw({ symbol: 'GLDW', transactionID: '', tradeID: '', ibExecID: '', tradeDate: '2026-02-10', ibCommission: -5 });
  const B = raw({ symbol: 'GLDW', transactionID: '', tradeID: '', ibExecID: '', tradeDate: '2026-02-10', ibCommission: -7 });
  await syncIb(feed([A, B], [lean(A), lean(B)]));
  const twoRows = (await getDb()).securityTrades.filter((/** @type {any} */ x) => x.symbol === 'GLDW');
  assert.equal(twoRows.length, 2);
  const r = await syncIb(feed([B], [lean(B)]));   // 視窗位移：A 滾出
  assert.equal(r.secTradesAdded, 0, '不新增');
  const after = (await getDb()).securityTrades.filter((/** @type {any} */ x) => x.symbol === 'GLDW');
  assert.equal(after.length, 2, '歷史保留');
  assert.deepEqual(after.map((/** @type {any} */ x) => x.commission).sort(), [5, 7], 'A(5) 未被 B(7) 覆寫（原 HIGH：#1 重配蓋掉 A）');
});

test('自審 #4｜官方識別碼列就地更新＝整列取代：來源欄位消失時舊值不殘留', async () => {
  const T = raw({ symbol: 'AAPL', transactionID: 'TXN-STALE', settleDateTarget: '2026-01-15' });
  await syncIb(feed([T], [lean(T)]));
  assert.equal((await getDb()).securityTrades.find((/** @type {any} */ x) => x.symbol === 'AAPL').settlementDate, '2026-01-15');
  const T2 = { ...T }; delete /** @type {any} */ (T2).settleDateTarget;
  await syncIb(feed([T2], [lean(T2)]));
  const row = (await getDb()).securityTrades.find((/** @type {any} */ x) => x.symbol === 'AAPL');
  assert.equal(row.settlementDate, undefined, '來源已無交割日 → 舊值清除、不殘留');
  assert.ok(row.id && row.importBatch, 'id/批次仍保留首次');
});

test('Codex S2r1#1/#2｜缺幣別/缺核心金額/壞列 → 分原因跳過（以原始列數計）、不猜 USD 不入庫', async () => {
  const NOCUR = raw({ symbol: 'NC1', transactionID: 'TXN-NC', currency: '' });
  const NOCORE = { accountId: 'U9990001', tradeDate: '2026-01-13', symbol: 'NC2', buySell: 'BUY', quantity: 10, transactionID: 'TXN-NB', currency: 'USD' };
  const BADROW = raw({ symbol: '', transactionID: 'TXN-BAD' });   // 缺代號＝normalize null
  const r = await syncIb(feed([NOCUR, NOCORE, BADROW], []));
  assert.equal(r.secTradesAdded, 0);
  assert.equal(r.secTradesSkipped, 3, '總數以原始列數為基準（壞列也算）');
  assert.equal(r.secSkippedReasons.missingCurrency, 1);
  assert.equal(r.secSkippedReasons.missingCore, 1);
  assert.equal(r.secSkippedReasons.badRow, 1);
  assert.ok(!(await getDb()).securityTrades.some((/** @type {any} */ x) => ['NC1', 'NC2'].includes(x.symbol)), '缺幣別/核心金額不入庫');
});

test('Codex S2r1#2｜Trade 缺 Account ID → 繼承外層 statement 帳戶（parseStatement 層）', () => {
  const j = { FlexQueryResponse: { FlexStatements: { FlexStatement: {
    accountId: 'U9990001', fromDate: '2026-01-01', toDate: '2026-01-31',
    Trades: { Trade: { tradeDate: '2026-01-13', symbol: 'VT', buySell: 'BUY', quantity: 10, tradePrice: 100, tradeMoney: 1000, netCash: -1001, currency: 'USD', transactionID: 'T-IN' } },
  } } } };
  const parsed = parseStatement(j);
  assert.equal(parsed.rawTrades.length, 1);
  assert.equal(parsed.rawTrades[0].accountId, 'U9990001', '外層帳戶補給缺 Account ID 的 Trade 節點');
});

test('Codex S2r1#4｜跨帳戶同 transactionID：兩帳戶各自一筆、不互相覆蓋；舊格式鍵一次性遷移', async () => {
  const A = raw({ symbol: 'XACC', transactionID: 'TXN-42', accountId: 'U1111111' });
  await syncIb(feed([A], [lean(A)]));
  const B = raw({ symbol: 'XACC', transactionID: 'TXN-42', accountId: 'U2222222', tradePrice: 999 });
  await syncIb(feed([B], [lean(B)]));
  const rows = (await getDb()).securityTrades.filter((/** @type {any} */ x) => x.symbol === 'XACC');
  assert.equal(rows.length, 2, 'A 不被 B 覆蓋（原 Codex 重現：只剩一筆）');
  // 遷移：種一筆舊格式官方鍵 → 同步後升級成含指紋段
  const db = await getDb();
  db.securityTrades.push({ id: 'legacy1', source: 'ibkr', sourceRef: 'ib|txn|LEGACY-9', tradeDate: '2026-01-05', side: 'buy',
    cashDirection: 'out', quantity: 1, currency: 'USD', symbol: 'LGC', sourceAccountId: 'abcdefabcdef',
    price: 100, grossAmount: 100, netSettlement: 101,   // 核心金額必填（Codex S3r2#4）——種子列也要滿足合約
    sourceAccountLabel: 'IBKR …0000', importBatch: 'ib-sync-old', importedAt: '2026-01-05T00:00:00Z' });
  await saveDb(db);
  await syncIb(feed([], []));
  const legacy = (await getDb()).securityTrades.find((/** @type {any} */ x) => x.id === 'legacy1');
  assert.equal(legacy.sourceRef, 'ib|txn|abcdefabcdef|LEGACY-9', '舊鍵補上自帶指紋段（冪等）');
  await syncIb(feed([], []));
  assert.equal((await getDb()).securityTrades.find((/** @type {any} */ x) => x.id === 'legacy1').sourceRef, 'ib|txn|abcdefabcdef|LEGACY-9', '再跑不重複升級');
});

test('Codex S2r1#3｜commissionCurrency 進庫且過櫃檯（GBP 手續費、USD 交易）', async () => {
  const GF = raw({ symbol: 'GFEE', transactionID: 'TXN-GF', ibCommissionCurrency: 'GBP' });
  await syncIb(feed([GF], [lean(GF)]));
  const row = (await getDb()).securityTrades.find((/** @type {any} */ x) => x.symbol === 'GFEE');
  assert.equal(row.commissionCurrency, 'GBP');
  assert.equal(row.currency, 'USD');
});

test('Codex S3r2#1（高）｜不支援的手續費幣別（EUR）→ 跳過該筆＋分原因回報，整次同步不炸', async () => {
  const before = (await getDb()).securityTrades.length;
  const EF = raw({ symbol: 'EFEE', transactionID: 'TXN-EF', ibCommissionCurrency: 'EUR' });   // 交易 USD、手續費 EUR
  const OK = raw({ symbol: 'OKAY', transactionID: 'TXN-OK2' });
  const r = await syncIb(feed([EF, OK], [lean(EF), lean(OK)]));   // 原重現：EF 走到櫃檯被枚舉拒絕 → 路由 500、OK 也一起陪葬
  assert.equal(r.secSkippedReasons.unsupportedFeeCurrency, 1, '分原因回報（使用者才知道是手續費幣別）');
  assert.ok(!(await getDb()).securityTrades.some((/** @type {any} */ x) => x.symbol === 'EFEE'), 'EUR 手續費列不入庫');
  assert.ok((await getDb()).securityTrades.some((/** @type {any} */ x) => x.symbol === 'OKAY'), '同批其他合法列照常入庫（同步沒有整次失敗）');
  assert.equal((await getDb()).securityTrades.length, before + 1);
});

// ---- 新持股缺幣別＝不建、回報（2026-07-28 修；Codex gpt-5.6-sol 重審發現）----
// 原本 `currency: p.currency || 'USD'` 會把一檔 GBP 標的存成美元，之後市值、淨資產、
// 單一國家／個股上限全部靜默算錯。猜錯幣別的代價遠大於「少建一檔、畫面出聲」。
test('IB 同步｜新持股沒有幣別＝不建立、列進 skippedNoCurrency（不可以猜 USD）', async () => {
  const feedPos = (positions) => async () => ({
    positions, cashByCurrency: {}, hasCashReport: false, hasCashDetail: false, cashDetailIncomplete: false,
    baseCurrency: 'USD', baseSummaryCash: null, statementCount: 1, accountCount: 1,
    equity: null, income: null, trades: [], rawTrades: [], period: { from: '2026-01-01', to: '2026-01-31' },
  });
  const before = (await getDb()).holdings.length;
  const r = await syncIb(feedPos([
    { symbol: 'NOCUR', description: '沒有幣別的標的', currency: '', quantity: 10, avgCost: 80, marketPrice: 100 },
    { symbol: 'HASCUR', description: '有幣別', currency: 'USD', quantity: 5, avgCost: 10, marketPrice: 12 },
  ]));
  assert.deepEqual(r.skippedNoCurrency, ['NOCUR'], '缺幣別的新持股要被點名回報，不可以靜默建成 USD');
  const db = await getDb();
  assert.equal(db.holdings.length, before + 1, '只建了有幣別的那一檔');
  assert.ok(!db.holdings.find(h => h.symbol === 'NOCUR'), '幣別不明的持股絕不入庫');
  assert.equal(db.holdings.find(h => h.symbol === 'HASCUR')?.currency, 'USD');
});

test('IB 同步｜既有持股的幣別不會被「報表這次沒給幣別」洗掉（原本就對，補考題釘住）', async () => {
  const db0 = await getDb();
  db0.holdings.push({ id: 'keep-gbp', symbol: 'KEEPGBP', name: 'GBP 標的', layer: 'satellite',
    currency: 'GBP', quantity: 1, price: 10, avgCost: 10, source: 'ib' });
  await saveDb(db0);
  const feedPos = (positions) => async () => ({
    positions, cashByCurrency: {}, hasCashReport: false, hasCashDetail: false, cashDetailIncomplete: false,
    baseCurrency: 'USD', baseSummaryCash: null, statementCount: 1, accountCount: 1,
    equity: null, income: null, trades: [], rawTrades: [], period: { from: '2026-01-01', to: '2026-01-31' },
  });
  await syncIb(feedPos([{ symbol: 'KEEPGBP', currency: '', quantity: 3, avgCost: 11, marketPrice: 13 }]));
  const h = (await getDb()).holdings.find(x => x.symbol === 'KEEPGBP');
  assert.equal(h.currency, 'GBP', '既有持股保住原幣別');
  assert.equal(h.quantity, 3, '數量照常更新（既有持股不因缺幣別被整筆跳過）');
});

test('IB 同步｜skippedNoCurrency 要**存進 db** 而不只是同步當下的回傳（Codex 複審阻擋#1）', async () => {
  // 病根：settings.ib.income 是逐欄白名單，漏了新欄位＝同步當下看得到、重新整理就消失，
  // 而金額總額已經排除了那些筆——「數字少了卻沒有任何註記」正是本專案禁止的默默算錯。
  const feedIncome = async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: false, hasCashDetail: false, cashDetailIncomplete: false,
    baseCurrency: 'USD', baseSummaryCash: null, statementCount: 1, accountCount: 1, equity: null,
    income: { dividends: 100, paymentInLieu: 0, withholdingTax: 0, interestPaid: 0, interestReceived: 0, other: 0,
      count: 1, skippedNoFx: 0, skippedNoCurrency: 3, estimatedNoFx: 0, estimatedCurrencies: [] },
    trades: [], rawTrades: [], period: { from: '2026-01-01', to: '2026-01-31' },
  });
  const r = await syncIb(feedIncome);
  assert.equal(r.incomeNoCurrency, 3, '同步回傳要有');
  const fresh = await getDb();   // ← 重讀資料庫：這一步才是 Codex 抓到的破口
  assert.equal(fresh.settings.ib.income.skippedNoCurrency, 3,
    '重讀之後不見了＝活動卡與 A4 報表會顯示「已排除部分收入的總額」卻不再註明缺漏');
  assert.equal(fresh.settings.ib.income.dividends, 100, '既有欄位不受影響');
});
